package org.nexus.tracker.preview;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NexusAuthBrowserPlugin.class);
        registerPlugin(NexusPrintPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
