package fun.lampac.harness;

import android.content.Context;
import android.os.Environment;
import android.util.Log;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.FileOutputStream;

/**
 * Bridge exposed to the page as window.Harness.
 * Every report is appended as one JSON line to a file that can be pulled with adb,
 * and mirrored to logcat with the LAMPAJS tag.
 */
public class HarnessBridge {
    public static final String TAG = "LAMPAJS";

    private final Context ctx;
    private final Object lock = new Object();
    private final File primary;

    public HarnessBridge(Context ctx) {
        this.ctx = ctx;
        this.primary = chooseFile();
    }

    private File chooseFile() {
        try {
            File dir = ctx.getExternalFilesDir(null);
            if (dir != null) {
                if (!dir.exists()) dir.mkdirs();
                return new File(dir, "harness-report.jsonl");
            }
        } catch (Throwable t) {
            Log.w(TAG, "external files dir unavailable: " + t);
        }
        return new File(ctx.getFilesDir(), "harness-report.jsonl");
    }

    public String path() {
        return primary.getAbsolutePath();
    }

    public File file() {
        return primary;
    }

    public static String esc(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.toString();
    }

    public void writeLine(String line) {
        synchronized (lock) {
            write(primary, line);
            try {
                File dl = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (dl != null) write(new File(dl, "harness-report.jsonl"), line);
            } catch (Throwable ignored) {
            }
            try {
                write(new File(ctx.getFilesDir(), "harness-report.jsonl"), line);
            } catch (Throwable ignored) {
            }
        }
    }

    private void write(File f, String line) {
        FileOutputStream out = null;
        try {
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            out = new FileOutputStream(f, true);
            out.write((line + "\n").getBytes("UTF-8"));
        } catch (Throwable t) {
            Log.w(TAG, "write failed " + f + ": " + t);
        } finally {
            if (out != null) try { out.close(); } catch (Throwable ignored) {}
        }
    }

    public void reportJson(String event, String message) {
        writeLine("{\"ts\":" + System.currentTimeMillis()
                + ",\"event\":\"" + esc(event)
                + "\",\"msg\":\"" + esc(message) + "\"}");
    }

    public void note(String message) {
        Log.i(TAG, "[Harness] " + message);
        reportJson("note", message);
    }

    @JavascriptInterface
    public void log(String text) {
        Log.i(TAG, "[JSHarness] " + text);
        reportJson("log", text);
    }

    @JavascriptInterface
    public void report(String json) {
        Log.i(TAG, "[JSReport] " + json);
        writeLine(json);
    }

    @JavascriptInterface
    public void mark(String name) {
        Log.i(TAG, "[JSMark] " + name);
        reportJson("mark", name);
    }

    @JavascriptInterface
    public String reportPath() {
        return path();
    }
}
