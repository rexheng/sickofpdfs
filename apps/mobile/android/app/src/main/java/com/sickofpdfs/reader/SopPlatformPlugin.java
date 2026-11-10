package com.sickofpdfs.reader;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.Window;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The app's own bridge (apps/mobile/src/platform/native.ts): the PDFs Android hands the app ("Open with", Share, the file
 * picker), the Back button, the system bars and links that leave the app.
 *
 * A PDF arrives as a content:// link that may stop working once the sending app is gone, so it is copied into the app's cache
 * (cache/incoming/<id>/<name>.pdf). The viewer reads it, then calls release(), which deletes the copy. Copies left by a run that
 * ended early are deleted the next time the app starts. Nothing here touches the network.
 */
@CapacitorPlugin(name = "SopPlatform")
public class SopPlatformPlugin extends Plugin {

    private static final String HANDLED = "com.sickofpdfs.reader.HANDLED";
    private final Map<String, JSObject> incoming = new HashMap<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private String waiting = null;

    /** R112: the ElevenReader app's package id on Google Play (play.google.com/store/apps/details?id=io.elevenlabs.readerapp). */
    private static final String ELEVENREADER = "io.elevenlabs.readerapp";

    @Override
    public void load() {
        deleteTree(incomingDir());
        deleteTree(sharedDir());
        androidx.appcompat.app.AppCompatActivity activity = getActivity();
        activity
            .getOnBackPressedDispatcher()
            .addCallback(
                activity,
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        if (hasListeners("back")) notifyListeners("back", new JSObject());
                        else goBackOrLeave();
                    }
                }
            );
        accept(activity.getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        accept(intent);
    }

    /** Takes the PDF an "Open with" or Share intent carries, once. */
    private void accept(Intent intent) {
        if (intent == null || intent.getBooleanExtra(HANDLED, false)) return;
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(intent.getAction())) {
            uri = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class) : intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri == null) return;
        intent.putExtra(HANDLED, true);
        final Uri from = uri;
        io.execute(() -> {
            JSObject pdf = copyIn(from);
            if (pdf == null) return;
            synchronized (this) {
                waiting = pdf.getString("id");
            }
            JSObject event = new JSObject();
            event.put("pdf", pdf);
            notifyListeners("incoming", event);
        });
    }

    private File incomingDir() {
        return new File(getContext().getCacheDir(), "incoming");
    }

    /** The file's own name, as the sending app gives it, made safe as a file name. */
    private String displayName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {}
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null) name = "Document.pdf";
        name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (name.length() > 120) name = name.substring(0, 120);
        if (name.isEmpty()) name = "Document";
        if (!name.toLowerCase().endsWith(".pdf")) name = name + ".pdf";
        return name;
    }

    /** Copies the PDF into the cache. Null when it cannot be read. */
    private JSObject copyIn(Uri uri) {
        String id = UUID.randomUUID().toString();
        File dir = new File(incomingDir(), id);
        if (!dir.mkdirs()) return null;
        String name = displayName(uri);
        File file = new File(dir, name);
        long size = 0;
        try (InputStream in = getContext().getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(file)) {
            if (in == null) throw new java.io.IOException("no stream");
            byte[] buffer = new byte[1 << 16];
            for (int n; (n = in.read(buffer)) > 0; ) {
                out.write(buffer, 0, n);
                size += n;
            }
        } catch (Exception e) {
            deleteTree(dir);
            return null;
        }
        JSObject pdf = new JSObject();
        pdf.put("id", id);
        pdf.put("name", name);
        pdf.put("size", size);
        pdf.put("path", file.getAbsolutePath());
        synchronized (this) {
            incoming.put(id, pdf);
        }
        return pdf;
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private JSObject result(JSObject pdf) {
        JSObject r = new JSObject();
        r.put("pdf", pdf == null ? JSObject.NULL : pdf);
        return r;
    }

    @PluginMethod
    public void takeIncoming(PluginCall call) {
        JSObject pdf = null;
        synchronized (this) {
            if (waiting != null) pdf = incoming.get(waiting);
            waiting = null;
        }
        call.resolve(result(pdf));
    }

    @PluginMethod
    public void incoming(PluginCall call) {
        String id = call.getString("id", "");
        JSObject pdf;
        synchronized (this) {
            pdf = incoming.get(id);
        }
        call.resolve(result(pdf));
    }

    @PluginMethod
    public void release(PluginCall call) {
        String id = call.getString("id", "");
        synchronized (this) {
            incoming.remove(id);
        }
        if (id.matches("[0-9a-f-]{36}")) io.execute(() -> deleteTree(new File(incomingDir(), id)));
        call.resolve();
    }

    @PluginMethod
    public void pickPdf(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/pdf");
        startActivityForResult(call, intent, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(result(null));
            return;
        }
        Uri uri = data.getData();
        io.execute(() -> {
            JSObject pdf = copyIn(uri);
            if (pdf == null) call.reject("The file could not be read");
            else call.resolve(result(pdf));
        });
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            call.reject("Only web links open outside the app");
            return;
        }
        try {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app opens web links");
        }
    }

    private void goBackOrLeave() {
        WebView web = getBridge().getWebView();
        if (web != null && web.canGoBack()) web.goBack();
        else getActivity().moveTaskToBack(true);
    }

    @PluginMethod
    public void goBack(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            goBackOrLeave();
            call.resolve();
        });
    }

    @PluginMethod
    public void setBars(PluginCall call) {
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            int color = ContextCompat.getColor(getContext(), dark ? R.color.sop_viewer_bar : R.color.sop_window);
            window.getDecorView().setBackgroundColor(color);
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
            bars.setAppearanceLightStatusBars(!dark);
            bars.setAppearanceLightNavigationBars(!dark);
            call.resolve();
        });
    }

    @PluginMethod
    public void webViewInfo(PluginCall call) {
        PackageInfo info = WebViewCompat.getCurrentWebViewPackage(getContext());
        JSObject r = new JSObject();
        r.put("version", info == null ? "" : info.versionName);
        r.put("packageName", info == null ? "" : info.packageName);
        call.resolve(r);
    }

    // ---- R112: "Listen with ElevenReader"

    private File sharedDir() {
        return new File(getContext().getCacheDir(), "shared");
    }

    /** A share to ElevenReader of the open PDF: SEND, application/pdf, to its package only. */
    private Intent elevenReaderIntent() {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("application/pdf");
        send.setPackage(ELEVENREADER);
        return send;
    }

    @PluginMethod
    public void elevenReader(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        boolean installed;
        try {
            pm.getPackageInfo(ELEVENREADER, 0);
            installed = true;
        } catch (PackageManager.NameNotFoundException e) {
            installed = false;
        }
        boolean canShare = installed && !pm.queryIntentActivities(elevenReaderIntent(), 0).isEmpty();
        JSObject r = new JSObject();
        r.put("installed", installed);
        r.put("canShare", canShare);
        call.resolve(r);
    }

    private final Map<String, File> sharing = new HashMap<>();

    @PluginMethod
    public void shareBegin(PluginCall call) {
        String name = call.getString("name", "Document.pdf");
        io.execute(() -> {
            synchronized (sharing) {
                sharing.clear();
            }
            deleteTree(sharedDir()); // one shared PDF at a time
            String id = UUID.randomUUID().toString();
            File dir = new File(sharedDir(), id);
            if (!dir.mkdirs()) {
                call.reject("The PDF could not be written");
                return;
            }
            String safe = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
            if (safe.length() > 120) safe = safe.substring(0, 120);
            if (safe.isEmpty()) safe = "Document";
            if (!safe.toLowerCase().endsWith(".pdf")) safe = safe + ".pdf";
            synchronized (sharing) {
                sharing.put(id, new File(dir, safe));
            }
            JSObject r = new JSObject();
            r.put("id", id);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void shareChunk(PluginCall call) {
        String id = call.getString("id", "");
        String data = call.getString("data", "");
        io.execute(() -> {
            File file;
            synchronized (sharing) {
                file = sharing.get(id);
            }
            if (file == null) {
                call.reject("No share is open");
                return;
            }
            try (OutputStream out = new FileOutputStream(file, true)) {
                out.write(Base64.decode(data, Base64.DEFAULT));
                call.resolve();
            } catch (Exception e) {
                call.reject("The PDF could not be written");
            }
        });
    }

    @PluginMethod
    public void shareEnd(PluginCall call) {
        String id = call.getString("id", "");
        File file;
        synchronized (sharing) {
            file = sharing.remove(id);
        }
        if (file == null || !file.exists()) {
            call.reject("No share is open");
            return;
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent send = elevenReaderIntent();
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.putExtra(Intent.EXTRA_TITLE, file.getName());
        send.setClipData(ClipData.newRawUri(file.getName(), uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(send);
                call.resolve();
            } catch (ActivityNotFoundException e) {
                call.reject("ElevenReader did not take the PDF");
            }
        });
    }

    /** The pages hold a text selection (true) or not: Android's own text bar stays closed over it (MainActivity). */
    @PluginMethod
    public void setPageSelection(PluginCall call) {
        MainActivity.pageSelection = Boolean.TRUE.equals(call.getBoolean("on", false));
        call.resolve();
    }
}
