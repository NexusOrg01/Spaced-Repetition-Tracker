package org.nexus.tracker.preview;

import android.content.Context;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintJob;
import android.print.PrintManager;
import android.view.View;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NexusPrint")
public class NexusPrintPlugin extends Plugin {
    private static final int MAX_HTML_LENGTH = 3 * 1024 * 1024;
    private static final long PAGE_LOAD_TIMEOUT_MS = 30_000L;
    private static final long PRINT_JOB_POLL_INTERVAL_MS = 1_000L;
    private static final long PRINT_JOB_MAX_LIFETIME_MS = 30L * 60L * 1_000L;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private WebView printWebView;
    private PrintJob activePrintJob;
    private PluginCall pendingCall;
    private long printJobStartedAt;
    private boolean printStarted;

    private final Runnable pageLoadTimeout = () -> {
        PluginCall call = pendingCall;
        if (call != null) {
            failPrint(call, "Nexus could not prepare the report for printing. Please try again.");
        }
    };

    private final Runnable printJobMonitor = new Runnable() {
        @Override
        public void run() {
            PrintJob job = activePrintJob;
            if (job == null) return;

            if (isPrintJobFinished(job) ||
                System.currentTimeMillis() - printJobStartedAt >= PRINT_JOB_MAX_LIFETIME_MS) {
                activePrintJob = null;
                destroyPrintWebView();
                return;
            }

            mainHandler.postDelayed(this, PRINT_JOB_POLL_INTERVAL_MS);
        }
    };

    @PluginMethod
    public void printHtml(PluginCall call) {
        String html = call.getString("html");
        String requestedTitle = call.getString("title");

        if (html == null || html.trim().isEmpty()) {
            call.reject("The Nexus report is empty and cannot be printed.");
            return;
        }
        if (html.length() > MAX_HTML_LENGTH) {
            call.reject("The Nexus report is too large to send to Android's print service.");
            return;
        }

        String jobName = requestedTitle == null ? "Nexus report" : requestedTitle;
        jobName = jobName.replaceAll("[\\r\\n\\t]+", " ").trim();
        if (jobName.isEmpty()) jobName = "Nexus report";
        if (jobName.length() > 80) jobName = jobName.substring(0, 80);

        final String safeJobName = jobName;
        final String reportHtml = html;
        if (getActivity() == null) {
            call.reject("Nexus is not ready to open Android printing.");
            return;
        }
        getActivity().runOnUiThread(() -> beginPrint(call, reportHtml, safeJobName));
    }

    private void beginPrint(PluginCall call, String html, String jobName) {
        if (printWebView != null || (activePrintJob != null && !isPrintJobFinished(activePrintJob))) {
            call.reject("A Nexus print job is already active. Finish or cancel it before starting another.");
            return;
        }

        if (activePrintJob != null) {
            activePrintJob = null;
        }

        PrintManager printManager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
        if (printManager == null) {
            call.reject("Android's print service is unavailable on this device.");
            return;
        }

        WebView webView = new WebView(getActivity());
        printWebView = webView;
        pendingCall = call;
        printStarted = false;
        webView.setBackgroundColor(Color.WHITE);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBlockNetworkLoads(true);
        settings.setSupportZoom(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                if (printStarted || view != printWebView) return;
                printStarted = true;
                mainHandler.removeCallbacks(pageLoadTimeout);
                openSystemPrintDialog(call, view, printManager, jobName);
            }

            @Override
            public void onReceivedError(
                WebView view,
                WebResourceRequest request,
                WebResourceError error
            ) {
                if (request != null && request.isForMainFrame() && pendingCall == call) {
                    String detail = error == null || error.getDescription() == null
                        ? "The report could not be rendered."
                        : error.getDescription().toString();
                    failPrint(call, detail);
                }
            }
        });

        mainHandler.removeCallbacks(pageLoadTimeout);
        mainHandler.postDelayed(pageLoadTimeout, PAGE_LOAD_TIMEOUT_MS);
        webView.loadDataWithBaseURL("https://localhost/", html, "text/html", "UTF-8", null);
    }

    private void openSystemPrintDialog(
        PluginCall call,
        WebView webView,
        PrintManager printManager,
        String jobName
    ) {
        try {
            int width = getContext().getResources().getDisplayMetrics().widthPixels;
            int height = getContext().getResources().getDisplayMetrics().heightPixels;
            webView.measure(
                View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.AT_MOST)
            );
            webView.layout(0, 0, width, Math.max(1, webView.getMeasuredHeight()));

            PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(jobName);
            PrintAttributes attributes = new PrintAttributes.Builder()
                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                .setResolution(new PrintAttributes.Resolution(
                    "nexus_report_300dpi",
                    "Nexus report",
                    300,
                    300
                ))
                .setMinMargins(new PrintAttributes.Margins(0, 0, 0, 0))
                .build();

            activePrintJob = printManager.print(jobName, adapter, attributes);
            if (activePrintJob == null) {
                throw new IllegalStateException("Android did not create a print job.");
            }

            printJobStartedAt = System.currentTimeMillis();
            mainHandler.removeCallbacks(pageLoadTimeout);

            JSObject result = new JSObject();
            result.put("jobName", jobName);
            result.put("status", "started");
            pendingCall = null;
            call.resolve(result);

            mainHandler.removeCallbacks(printJobMonitor);
            mainHandler.postDelayed(printJobMonitor, PRINT_JOB_POLL_INTERVAL_MS);
        } catch (Exception error) {
            failPrint(call, "Android could not open the print dialog: " +
                (error.getMessage() == null ? "unknown print error" : error.getMessage()));
        }
    }

    private boolean isPrintJobFinished(PrintJob job) {
        return job.isCompleted() || job.isCancelled() || job.isFailed();
    }

    private void failPrint(PluginCall call, String message) {
        mainHandler.removeCallbacks(pageLoadTimeout);
        if (pendingCall == call) pendingCall = null;
        activePrintJob = null;
        mainHandler.removeCallbacks(printJobMonitor);
        destroyPrintWebView();
        call.reject(message);
    }

    private void destroyPrintWebView() {
        WebView webView = printWebView;
        printWebView = null;
        if (webView != null) {
            webView.stopLoading();
            webView.setWebViewClient(null);
            webView.destroy();
        }
    }

    @Override
    protected void handleOnDestroy() {
        mainHandler.removeCallbacks(pageLoadTimeout);
        mainHandler.removeCallbacks(printJobMonitor);
        if (pendingCall != null) {
            pendingCall.reject("Nexus closed before the report could be prepared for printing.");
            pendingCall = null;
        }
        activePrintJob = null;
        destroyPrintWebView();
        super.handleOnDestroy();
    }
}
