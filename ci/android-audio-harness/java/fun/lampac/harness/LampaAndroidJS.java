package fun.lampac.harness;

import android.util.Log;
import android.webkit.JavascriptInterface;

/**
 * Fake Lampa Android client, exposed to the page as window.AndroidJS.
 *
 * Lampa decides between the inner HTML5 player and the native/external player by
 * looking at AndroidJS (see src/core/android.js checkVersion + src/interaction/player.js).
 * Every call is logged with the LAMPAJS tag and appended to the report file, so the
 * emulator run shows which of the two built-in players was chosen.
 *
 * appVersion() format: Lampa does appVersion().split('-').pop() and parseInt()s it,
 * so the last hyphen-separated part must be a number. 9999 satisfies every
 * checkVersion() in the source (max is 484).
 */
public class LampaAndroidJS {
    public static final String TAG = "LAMPAJS";
    public static final String VERSION = "1.13.0-native.2-9999";

    private final HarnessBridge bridge;

    public LampaAndroidJS(HarnessBridge bridge) {
        this.bridge = bridge;
    }

    private void call(String name, String args) {
        Log.i(TAG, "[AndroidJS] " + name + "(" + args + ")");
        bridge.reportJson("AndroidJS." + name, args);
    }

    @JavascriptInterface
    public String appVersion() {
        call("appVersion", "");
        return VERSION;
    }

    @JavascriptInterface
    public void openPlayer(String url, String json) {
        call("openPlayer", "url=" + url + " | json=" + json);
    }

    @JavascriptInterface
    public void openTorrentLink(String link, String json) {
        call("openTorrentLink", "link=" + link + " | json=" + json);
    }

    @JavascriptInterface
    public void openYoutube(String link) {
        call("openYoutube", "link=" + link);
    }

    @JavascriptInterface
    public void openBrowser(String link) {
        call("openBrowser", "link=" + link);
    }

    @JavascriptInterface
    public void clearDefaultPlayer() {
        call("clearDefaultPlayer", "");
    }

    @JavascriptInterface
    public void httpReq(String json, int index) {
        call("httpReq", "index=" + index + " | json=" + json);
    }

    @JavascriptInterface
    public String getResp(int index) {
        call("getResp", "index=" + index);
        return "{\"harness\":true}";
    }

    @JavascriptInterface
    public void voiceStart() {
        call("voiceStart", "");
    }

    @JavascriptInterface
    public void updateChannel(String where) {
        call("updateChannel", "where=" + where);
    }

    @JavascriptInterface
    public void saveBookmarks(String json) {
        call("saveBookmarks", "json=" + json);
    }

    @JavascriptInterface
    public void timeCall(String json) {
        call("timeCall", "json=" + json);
    }

    @JavascriptInterface
    public void exit() {
        call("exit", "");
    }
}
