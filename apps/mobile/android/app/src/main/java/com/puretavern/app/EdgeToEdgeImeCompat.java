package com.puretavern.app;

import android.app.Activity;
import android.graphics.Rect;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * Complements Capacitor's SystemBars IME handling when an edge-to-edge compatibility runtime
 * reports the keyboard through legacy visible-window bounds instead of usable IME insets.
 */
final class EdgeToEdgeImeCompat {

    private static final int LEGACY_KEYBOARD_MIN_DP = 100;
    private static final float LEGACY_KEYBOARD_MIN_WINDOW_RATIO = 0.15f;

    private final View rootView;
    private final View webViewContainer;
    private final int originalContainerHeight;
    private final int minimumKeyboardOcclusionPx;
    private final Rect visibleWindowFrame = new Rect();
    private final int[] rootLocationOnScreen = new int[2];
    private final ViewTreeObserver.OnGlobalLayoutListener globalLayoutListener;

    static EdgeToEdgeImeCompat install(Activity activity, View webView) {
        if (!(webView.getParent() instanceof View webViewContainer)) {
            return null;
        }
        if (webViewContainer.getLayoutParams() == null) {
            return null;
        }
        return new EdgeToEdgeImeCompat(activity, webViewContainer);
    }

    private EdgeToEdgeImeCompat(Activity activity, View webViewContainer) {
        this.rootView = activity.getWindow().getDecorView();
        this.webViewContainer = webViewContainer;
        this.originalContainerHeight = webViewContainer.getLayoutParams().height;
        this.minimumKeyboardOcclusionPx = Math.round(
            LEGACY_KEYBOARD_MIN_DP * activity.getResources().getDisplayMetrics().density
        );
        this.globalLayoutListener = this::updateContainerHeight;

        rootView.getViewTreeObserver().addOnGlobalLayoutListener(globalLayoutListener);
        ViewCompat.requestApplyInsets(rootView);
    }

    void dispose() {
        ViewTreeObserver observer = rootView.getViewTreeObserver();
        if (observer.isAlive()) {
            observer.removeOnGlobalLayoutListener(globalLayoutListener);
        }
        setContainerHeight(originalContainerHeight);
    }

    private void updateContainerHeight() {
        int rootHeight = rootView.getHeight();
        if (rootHeight <= 0) {
            return;
        }

        rootView.getWindowVisibleDisplayFrame(visibleWindowFrame);
        rootView.getLocationOnScreen(rootLocationOnScreen);
        int localVisibleBottom = visibleWindowFrame.bottom - rootLocationOnScreen[1];
        localVisibleBottom = Math.max(0, Math.min(rootHeight, localVisibleBottom));

        int legacyOcclusion = rootHeight - localVisibleBottom;
        int legacyThreshold = Math.max(
            minimumKeyboardOcclusionPx,
            Math.round(rootHeight * LEGACY_KEYBOARD_MIN_WINDOW_RATIO)
        );
        boolean legacyKeyboardVisible = legacyOcclusion > legacyThreshold;

        int standardImeOcclusion = 0;
        WindowInsetsCompat rootInsets = ViewCompat.getRootWindowInsets(rootView);
        if (rootInsets != null && rootInsets.isVisible(WindowInsetsCompat.Type.ime())) {
            standardImeOcclusion = rootInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
        }

        int keyboardOcclusion = Math.max(
            standardImeOcclusion,
            legacyKeyboardVisible ? legacyOcclusion : 0
        );
        int capacitorHandledBottom = Math.max(0, webViewContainer.getPaddingBottom());
        int unhandledOcclusion = Math.max(0, keyboardOcclusion - capacitorHandledBottom);

        if (unhandledOcclusion == 0) {
            setContainerHeight(originalContainerHeight);
            return;
        }

        int targetHeight = Math.max(0, rootHeight - unhandledOcclusion);
        if (originalContainerHeight >= 0) {
            targetHeight = Math.min(originalContainerHeight, targetHeight);
        }
        setContainerHeight(targetHeight);
    }

    private void setContainerHeight(int height) {
        ViewGroup.LayoutParams layoutParams = webViewContainer.getLayoutParams();
        if (layoutParams == null || layoutParams.height == height) {
            return;
        }
        layoutParams.height = height;
        webViewContainer.setLayoutParams(layoutParams);
    }
}
