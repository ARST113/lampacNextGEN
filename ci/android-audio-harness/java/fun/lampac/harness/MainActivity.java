package fun.lampac.harness;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Minimal WebView harness for checking the Lampa Audio WASM bridge on Android.
 *
 * Intent extras:
 *   url           - page to open (required)
 *   inject_asset  - asset JS file injected ~1.5 s after onPageFinished
 *   scenario      - only used for logging
 *
 * Runtime control (from the host, so bash drives the scenario):
 *   am broadcast -a fun.lampac.harness.EVAL --es b64 <base64 js> -p fun.lampac.harness
 *   am broadcast -a fun.lampac.harness.URL  --es url <url>        -p fun.lampac.harness
 */
public class MainActivity extends Activity {
    public static final String TAG = "LAMPAJS";
    public static final String ACTION_EVAL = "fun.lampac.harness.EVAL";
    public static final String ACTION_URL = "fun.lampac.harness.URL";

    private WebView web;
    private HarnessBridge bridge;
    private BroadcastReceiver receiver;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);

        bridge = new HarnessBridge(this);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setLoadsImagesAutomatically(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " lampa_client");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        WebView.setWebContentsDebuggingEnabled(true);

        web.addJavascriptInterface(bridge, "Harness");
        web.addJavascriptInterface(new LampaAndroidJS(bridge), "AndroidJS");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "[Harness] page-finished " + url);
                bridge.reportJson("page-finished", url);
                final String asset = getIntent().getStringExtra("inject_asset");
                if (asset != null && asset.length() > 0) {
                    final String js = readAsset(asset);
                    ui.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            Log.i(TAG, "[Harness] injecting asset " + asset + " (" + js.length() + " chars)");
                            bridge.reportJson("inject", asset);
                            evalJs(js);
                        }
                    }, 1500);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                String line = "[" + m.messageLevel() + "] " + m.message()
                        + " @" + m.sourceId() + ":" + m.lineNumber();
                Log.i(TAG, line);
                bridge.reportJson("console", line);
                return true;
            }
        });

        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        IntentFilter filter = new IntentFilter(ACTION_EVAL);
        filter.addAction(ACTION_URL);
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (ACTION_EVAL.equals(action)) {
                    String b64 = intent.getStringExtra("b64");
                    if (b64 != null) {
                        String js = "";
                        try {
                            js = new String(Base64.decode(b64, Base64.DEFAULT), "UTF-8");
                        } catch (Throwable t) {
                            Log.e(TAG, "[Harness] bad b64: " + t);
                        }
                        Log.i(TAG, "[Harness] eval broadcast " + js.length() + " chars");
                        bridge.reportJson("broadcast-eval", js.substring(0, Math.min(120, js.length())));
                        evalJs(js);
                    }
                } else if (ACTION_URL.equals(action)) {
                    String url = intent.getStringExtra("url");
                    if (url != null) {
                        Log.i(TAG, "[Harness] load broadcast " + url);
                        bridge.reportJson("broadcast-url", url);
                        web.loadUrl(url);
                    }
                }
            }
        };
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(receiver, filter);
        }

        String url = getIntent().getStringExtra("url");
        if (url == null || url.length() == 0) url = "about:blank";
        bridge.note("activity-start url=" + url
                + " report=" + bridge.path()
                + " ua=" + s.getUserAgentString()
                + " webview=" + (Build.VERSION.SDK_INT));

        web.loadUrl(url);
    }

    private void evalJs(String js) {
        if (js == null || js.length() == 0) return;
        web.evaluateJavascript(js, null);
    }

    private String readAsset(String name) {
        InputStream in = null;
        try {
            in = getAssets().open(name);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            Log.e(TAG, "asset " + name + " failed: " + t);
            return "";
        } finally {
            if (in != null) try { in.close(); } catch (Throwable ignored) {}
        }
    }

    @Override
    protected void onDestroy() {
        try {
            if (receiver != null) unregisterReceiver(receiver);
        } catch (Throwable ignored) {
        }
        if (web != null) {
            try {
                web.loadUrl("about:blank");
                web.destroy();
            } catch (Throwable ignored) {
            }
        }
        super.onDestroy();
    }
}
