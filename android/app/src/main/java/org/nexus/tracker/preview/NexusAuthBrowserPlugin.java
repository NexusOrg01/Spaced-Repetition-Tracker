package org.nexus.tracker.preview;

import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NexusAuthBrowser")
public class NexusAuthBrowserPlugin extends Plugin {
    private static final long AUTH_TIMEOUT_MS = 600_000L;
    private static final long RETURN_GRACE_MS = 350L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private PluginCall pendingCall;
    private String expectedScheme;
    private String expectedHost;
    private String expectedPath;
    private boolean browserWasOpened;

    private final Runnable timeoutRunnable = () ->
        rejectPending("Authentication timed out. Return to Nexus and try again.", "AUTH_TIMEOUT");

    private final Runnable cancellationRunnable = () -> {
        if (pendingCall != null && browserWasOpened) {
            rejectPending("Sign-in was cancelled.", "USER_CANCELLED");
        }
    };

    @PluginMethod
    public void openAuthSession(PluginCall call) {
        String url = call.getString("url");
        String redirectUrl = call.getString("redirectUrl");
        if (url == null || redirectUrl == null) {
            call.reject("The authorization URL and redirect URL are required.");
            return;
        }

        Uri authorizationUri = Uri.parse(url);
        Uri redirectUri = Uri.parse(redirectUrl);
        String requestedRedirect = authorizationUri.getQueryParameter("redirect_to");
        if (!"https".equalsIgnoreCase(authorizationUri.getScheme()) ||
            authorizationUri.getHost() == null ||
            redirectUri.getScheme() == null ||
            redirectUri.getHost() == null ||
            redirectUri.getUserInfo() != null ||
            redirectUri.getPort() != -1 ||
            redirectUri.getQuery() != null ||
            redirectUri.getFragment() != null ||
            requestedRedirect == null ||
            !redirectUrl.equals(requestedRedirect)) {
            call.reject("The authorization request does not match the configured Nexus callback.");
            return;
        }

        if (pendingCall != null) {
            call.reject("Another Nexus sign-in session is already in progress.");
            return;
        }

        getActivity().runOnUiThread(() -> launchAuthSession(call, authorizationUri, redirectUri));
    }

    private void launchAuthSession(PluginCall call, Uri authorizationUri, Uri redirectUri) {
        if (pendingCall != null) {
            call.reject("Another Nexus sign-in session is already in progress.");
            return;
        }

        pendingCall = call;
        call.setKeepAlive(true);
        getBridge().saveCall(call);
        expectedScheme = redirectUri.getScheme();
        expectedHost = redirectUri.getHost();
        expectedPath = redirectUri.getPath();
        browserWasOpened = false;

        try {
            CustomTabsIntent customTabsIntent = new CustomTabsIntent.Builder().build();
            customTabsIntent.intent.addFlags(Intent.FLAG_ACTIVITY_NO_HISTORY | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            customTabsIntent.launchUrl(getActivity(), authorizationUri);
            browserWasOpened = true;
            handler.removeCallbacks(timeoutRunnable);
            handler.postDelayed(timeoutRunnable, AUTH_TIMEOUT_MS);
        } catch (Exception error) {
            rejectPending("Nexus could not open the secure sign-in browser.", "BROWSER_LAUNCH_FAILED");
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (pendingCall == null || intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return;
        }

        Uri callbackUri = intent.getData();
        if (callbackUri == null ||
            !expectedScheme.equalsIgnoreCase(callbackUri.getScheme()) ||
            !expectedHost.equalsIgnoreCase(callbackUri.getHost()) ||
            !expectedPath.equals(callbackUri.getPath()) ||
            callbackUri.getPort() != -1 ||
            callbackUri.getUserInfo() != null) {
            return;
        }

        PluginCall call = pendingCall;
        clearPendingState();
        JSObject result = new JSObject();
        result.put("callbackURL", callbackUri.toString());
        call.resolve(result);
        getBridge().releaseCall(call);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (pendingCall != null && browserWasOpened) {
            // A successful deep link is handled by handleOnNewIntent before this grace period.
            handler.removeCallbacks(cancellationRunnable);
            handler.postDelayed(cancellationRunnable, RETURN_GRACE_MS);
        }
    }

    @Override
    protected void handleOnDestroy() {
        handler.removeCallbacks(timeoutRunnable);
        handler.removeCallbacks(cancellationRunnable);
        super.handleOnDestroy();
    }

    private void rejectPending(String message, String code) {
        PluginCall call = pendingCall;
        if (call == null) return;
        clearPendingState();
        call.reject(message, code, null, null);
        getBridge().releaseCall(call);
    }

    private void clearPendingState() {
        handler.removeCallbacks(timeoutRunnable);
        handler.removeCallbacks(cancellationRunnable);
        pendingCall = null;
        expectedScheme = null;
        expectedHost = null;
        expectedPath = null;
        browserWasOpened = false;
    }
}
