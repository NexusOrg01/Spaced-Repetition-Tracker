package io.github.nexusorg01.nexus;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.annotation.Nullable;
import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
    private static final String TAG = "NexusAndroid";
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START_URL =
            "https://appassets.androidplatform.net/assets/www/index.html";
    private static final int FILE_CHOOSER_REQUEST = 4101;
    private static final int MAX_EXPORT_CHARS = 25 * 1024 * 1024;

    private WebView webView;
    private ValueCallback<Uri[]> fileChooserCallback;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSafeBrowsingEnabled(true);

        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        // Service-worker requests do not pass through WebViewClient; route them through the same
        // local asset loader so the offline app shell and IndexedDB-backed workspace work offline.
        ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(
                new ServiceWorkerClientCompat() {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                        return assetLoader.shouldInterceptRequest(request.getUrl());
                    }
                }
        );

        webView.addJavascriptInterface(new NexusNativeBridge(), "NexusNativeBridge");
        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view,
                    WebResourceRequest request
            ) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(
                    WebView view,
                    WebResourceRequest request
            ) {
                return routeNavigation(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return routeNavigation(Uri.parse(url));
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params
            ) {
                return showBackupPicker(callback);
            }
        });

        webView.loadUrl(START_URL);
    }

    private boolean routeNavigation(Uri uri) {
        if (uri == null) return true;

        if ("https".equalsIgnoreCase(uri.getScheme())
                && APP_HOST.equalsIgnoreCase(uri.getHost())) {
            return false;
        }

        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (!"https".equals(scheme) && !"http".equals(scheme) && !"mailto".equals(scheme)) {
            return true;
        }

        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException error) {
            Log.w(TAG, "No external application can open " + scheme + " links.", error);
        }
        return true;
    }

    private boolean showBackupPicker(ValueCallback<Uri[]> callback) {
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
        }
        fileChooserCallback = callback;

        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        picker.addCategory(Intent.CATEGORY_OPENABLE);
        picker.setType("*/*");
        picker.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
                "application/json",
                "text/csv",
                "text/plain"
        });
        picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);

        try {
            startActivityForResult(
                    Intent.createChooser(picker, "Choose a Nexus backup or CSV file"),
                    FILE_CHOOSER_REQUEST
            );
            return true;
        } catch (ActivityNotFoundException error) {
            fileChooserCallback = null;
            callback.onReceiveValue(null);
            Log.e(TAG, "Android file picker is unavailable.", error);
            return false;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileChooserCallback == null) return;

        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            result = new Uri[] { data.getData() };
        }
        fileChooserCallback.onReceiveValue(result);
        fileChooserCallback = null;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
        if (webView != null) {
            webView.removeJavascriptInterface("NexusNativeBridge");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    public final class NexusNativeBridge {
        @JavascriptInterface
        public boolean saveTextFile(String rawFilename, String content, String rawMimeType) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                    || content == null
                    || content.length() > MAX_EXPORT_CHARS) {
                return false;
            }

            String filename = sanitizeFilename(rawFilename);
            String mimeType = sanitizeMimeType(rawMimeType);
            if (filename.isEmpty() || mimeType.isEmpty()) return false;

            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            values.put(
                    MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + "/Nexus"
            );
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);

            Uri outputUri = null;
            try {
                outputUri = getContentResolver().insert(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        values
                );
                if (outputUri == null) return false;

                try (OutputStream stream = getContentResolver().openOutputStream(outputUri, "w")) {
                    if (stream == null) throw new IllegalStateException("Could not open export destination.");
                    stream.write(content.getBytes(StandardCharsets.UTF_8));
                    stream.flush();
                }

                ContentValues completed = new ContentValues();
                completed.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(outputUri, completed, null, null);
                return true;
            } catch (Exception error) {
                if (outputUri != null) {
                    try {
                        getContentResolver().delete(outputUri, null, null);
                    } catch (Exception ignored) {
                        Log.w(TAG, "Could not remove an incomplete export.", ignored);
                    }
                }
                Log.e(TAG, "Could not save an export to Downloads/Nexus.", error);
                return false;
            }
        }
    }

    private static String sanitizeFilename(String value) {
        if (value == null) return "";
        String safe = value.replaceAll("[^A-Za-z0-9._-]", "_")
                .replaceAll("\\.{2,}", "_")
                .replaceAll("^\\.+", "");
        if (safe.length() > 120) safe = safe.substring(0, 120);
        return safe;
    }

    private static String sanitizeMimeType(String value) {
        if (value == null) return "";
        String type = value.split(";", 2)[0].trim().toLowerCase();
        if ("application/json".equals(type)
                || "application/pdf".equals(type)
                || "text/csv".equals(type)
                || "text/plain".equals(type)) {
            return type;
        }
        return "";
    }
}
