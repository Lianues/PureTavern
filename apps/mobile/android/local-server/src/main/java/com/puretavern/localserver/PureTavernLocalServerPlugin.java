package com.puretavern.localserver;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "PureTavernLocalServer")
public class PureTavernLocalServerPlugin extends Plugin {

    private static final String RESPONSE_EVENT = "pureTavernLocalServerResponse";
    private static final Pattern REQUEST_ID_PATTERN = Pattern.compile("[A-Za-z0-9._-]{1,128}");
    private static final int WORKER_COUNT = 4;

    private final Map<String, LocalProxySession> sessions = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newFixedThreadPool(WORKER_COUNT, runnable -> {
        Thread thread = new Thread(runnable, "PureTavernLocalProxy");
        thread.setDaemon(true);
        return thread;
    });
    private final LocalProxyEngine engine = new LocalProxyEngine();
    private final LocalProxyEventSink eventSink = new PluginEventSink();

    @PluginMethod
    public void startRequest(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId == null || !REQUEST_ID_PATTERN.matcher(requestId).matches()) {
            call.reject("A valid local backend request ID is required.", "INVALID_REQUEST");
            return;
        }

        final LocalProxyRequest request;
        try {
            request = LocalProxyRequest.create(
                    call.getString("url"),
                    call.getString("method", "GET"),
                    readHeaders(call.getObject("headers")),
                    call.getString("body"));
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage(), "INVALID_REQUEST");
            return;
        }

        LocalProxySession session = new LocalProxySession();
        if (sessions.putIfAbsent(requestId, session) != null) {
            call.reject("The local backend request ID is already active.", "DUPLICATE_REQUEST");
            return;
        }

        try {
            executor.execute(() -> {
                try {
                    engine.execute(requestId, request, session, eventSink);
                } finally {
                    sessions.remove(requestId, session);
                }
            });
        } catch (RejectedExecutionException error) {
            sessions.remove(requestId, session);
            session.cancel();
            call.reject("The Android local backend is shutting down.", "UNAVAILABLE");
            return;
        }

        call.resolve(new JSObject().put("requestId", requestId));
    }

    @PluginMethod
    public void cancelRequest(PluginCall call) {
        String requestId = call.getString("requestId");
        LocalProxySession session = requestId == null ? null : sessions.get(requestId);
        if (session != null) session.cancel();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (LocalProxySession session : sessions.values()) session.cancel();
        sessions.clear();
        executor.shutdownNow();
    }

    private static Map<String, String> readHeaders(JSObject input) {
        Map<String, String> headers = new LinkedHashMap<>();
        if (input == null) return headers;
        Iterator<String> keys = input.keys();
        while (keys.hasNext()) {
            String name = keys.next();
            Object value = input.opt(name);
            if (!(value instanceof String)) {
                throw new IllegalArgumentException("Provider request headers must contain string values.");
            }
            headers.put(name, (String) value);
        }
        return headers;
    }

    private void emit(JSObject event) {
        notifyListeners(RESPONSE_EVENT, event);
    }

    private final class PluginEventSink implements LocalProxyEventSink {

        @Override
        public void onHeaders(
                String requestId,
                int status,
                String statusText,
                Map<String, String> headers) {
            JSObject serializedHeaders = new JSObject();
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                serializedHeaders.put(entry.getKey(), entry.getValue());
            }
            emit(new JSObject()
                    .put("requestId", requestId)
                    .put("type", "headers")
                    .put("status", status)
                    .put("statusText", statusText)
                    .put("headers", serializedHeaders));
        }

        @Override
        public void onChunk(String requestId, int sequence, byte[] data) {
            emit(new JSObject()
                    .put("requestId", requestId)
                    .put("type", "chunk")
                    .put("sequence", sequence)
                    .put("data", Base64.encodeToString(data, Base64.NO_WRAP)));
        }

        @Override
        public void onComplete(String requestId) {
            emit(new JSObject()
                    .put("requestId", requestId)
                    .put("type", "complete"));
        }

        @Override
        public void onError(String requestId, String code, String message) {
            emit(new JSObject()
                    .put("requestId", requestId)
                    .put("type", "error")
                    .put("code", code)
                    .put("message", message));
        }
    }
}
