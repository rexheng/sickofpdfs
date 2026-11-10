package com.sickofpdfs.reader;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SopPlatformPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
