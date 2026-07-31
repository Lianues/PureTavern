package com.puretavern.localserver;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.util.concurrent.atomic.AtomicBoolean;

final class LocalProxySession {

    private final AtomicBoolean canceled = new AtomicBoolean(false);
    private HttpURLConnection connection;
    private InputStream input;

    boolean isCanceled() {
        return canceled.get();
    }

    synchronized boolean attachConnection(HttpURLConnection value) {
        if (canceled.get()) {
            value.disconnect();
            return false;
        }
        connection = value;
        return true;
    }

    synchronized boolean attachInput(InputStream value) {
        if (canceled.get()) {
            closeQuietly(value);
            return false;
        }
        input = value;
        return true;
    }

    synchronized void releaseConnection(HttpURLConnection value) {
        if (connection == value) {
            connection = null;
        }
    }

    synchronized void releaseInput(InputStream value) {
        if (input == value) {
            input = null;
        }
    }

    void cancel() {
        canceled.set(true);
        closeResources();
    }

    synchronized void closeResources() {
        InputStream currentInput = input;
        HttpURLConnection currentConnection = connection;
        input = null;
        connection = null;
        closeQuietly(currentInput);
        if (currentConnection != null) {
            currentConnection.disconnect();
        }
    }

    private static void closeQuietly(InputStream stream) {
        if (stream == null) return;
        try {
            stream.close();
        } catch (IOException ignored) {}
    }
}
