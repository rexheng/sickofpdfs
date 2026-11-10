package com.sickofpdfs.reader;

import android.os.Bundle;
import android.view.ActionMode;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Set while the pages hold a text selection (the page says so through SopPlatform.setPageSelection). The pages have their
     * own handles and action bar then (src/phone/touch-select.ts, SelectionBar.tsx).
     */
    static volatile boolean pageSelection = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SopPlatformPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * Android's floating text bar (Copy, Share, Select all) over a selection in the pages is closed at once: the page's own bar
     * has Copy and the marks. A text box (a note being typed) keeps Android's bar, for Paste.
     */
    @Override
    public void onActionModeStarted(ActionMode mode) {
        super.onActionModeStarted(mode);
        if (pageSelection && mode.getType() == ActionMode.TYPE_FLOATING) mode.finish();
    }
}
