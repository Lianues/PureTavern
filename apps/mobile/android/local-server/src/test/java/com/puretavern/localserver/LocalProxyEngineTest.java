package com.puretavern.localserver;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.Test;

public class LocalProxyEngineTest {

    @Test
    public void streamsOrderedChunksAndFiltersTransportHeaders() throws Exception {
        byte[] responseBody = new byte[LocalProxyEngine.CHUNK_SIZE + 5];
        Arrays.fill(responseBody, (byte) 'x');
        FakeConnection connection = new FakeConnection(
                URI.create("https://provider.example/v1/chat").toURL(),
                200,
                "OK",
                headers(
                        "Content-Type", "text/event-stream",
                        "Access-Control-Allow-Origin", "*",
                        "Set-Cookie", "secret=value",
                        "Connection", "X-Upstream-Hop",
                        "X-Upstream-Hop", "remove-me",
                        "X-Provider", "kept"),
                responseBody);
        RecordingSink sink = new RecordingSink();
        LocalProxyRequest request = LocalProxyRequest.create(
                connection.getURL().toString(),
                "POST",
                Map.of(
                        "Authorization", "Bearer provider-key",
                        "Connection", "X-Client-Hop",
                        "X-Client-Hop", "remove-me",
                        "Content-Length", "999",
                        "Host", "attacker.example",
                        "Content-Type", "application/json"),
                "{\"stream\":true}");

        new LocalProxyEngine(url -> connection).execute(
                "request-1",
                request,
                new LocalProxySession(),
                sink);

        assertNull(sink.errorCode);
        assertEquals(200, sink.status);
        assertEquals("text/event-stream", sink.headers.get("Content-Type"));
        assertEquals("kept", sink.headers.get("X-Provider"));
        assertFalse(sink.headers.containsKey("Set-Cookie"));
        assertFalse(sink.headers.containsKey("Access-Control-Allow-Origin"));
        assertFalse(sink.headers.containsKey("X-Upstream-Hop"));
        assertEquals(List.of(0, 1), sink.sequences);
        assertEquals(LocalProxyEngine.CHUNK_SIZE, sink.chunks.get(0).length);
        assertEquals(5, sink.chunks.get(1).length);
        assertTrue(sink.completed);
        assertEquals("Bearer provider-key", connection.getRequestProperty("Authorization"));
        assertEquals("identity", connection.getRequestProperty("Accept-Encoding"));
        assertNull(connection.getRequestProperty("Host"));
        assertNull(connection.getRequestProperty("Content-Length"));
        assertNull(connection.getRequestProperty("X-Client-Hop"));
        assertArrayEquals(
                "{\"stream\":true}".getBytes(StandardCharsets.UTF_8),
                connection.requestBody.toByteArray());
    }

    @Test
    public void followsRedirectsAndStripsSensitiveCrossOriginHeaders() throws Exception {
        FakeConnection redirect = new FakeConnection(
                URI.create("https://first.example/start").toURL(),
                302,
                "Found",
                headers("Location", "https://second.example/final"),
                new byte[0]);
        FakeConnection target = new FakeConnection(
                URI.create("https://second.example/final").toURL(),
                200,
                "OK",
                headers("Content-Type", "application/json"),
                "{}".getBytes(StandardCharsets.UTF_8));
        Map<String, FakeConnection> connections = Map.of(
                redirect.getURL().toString(), redirect,
                target.getURL().toString(), target);
        LocalProxyRequest request = LocalProxyRequest.create(
                redirect.getURL().toString(),
                "POST",
                Map.of(
                        "Authorization", "Bearer provider-key",
                        "Cookie", "private=value",
                        "Content-Type", "application/json",
                        "X-Provider", "kept"),
                "{}");
        RecordingSink sink = new RecordingSink();

        new LocalProxyEngine(url -> connections.get(url.toString())).execute(
                "request-2",
                request,
                new LocalProxySession(),
                sink);

        assertNull(sink.errorCode);
        assertEquals("POST", redirect.getRequestMethod());
        assertEquals("GET", target.getRequestMethod());
        assertNull(target.getRequestProperty("Authorization"));
        assertNull(target.getRequestProperty("Cookie"));
        assertNull(target.getRequestProperty("Content-Type"));
        assertEquals("kept", target.getRequestProperty("X-Provider"));
        assertEquals(0, target.requestBody.size());
        assertTrue(redirect.disconnected);
        assertTrue(target.disconnected);
    }

    @Test
    public void reportsCancellationWithoutOpeningAConnection() {
        LocalProxySession session = new LocalProxySession();
        session.cancel();
        RecordingSink sink = new RecordingSink();
        LocalProxyRequest request = LocalProxyRequest.create(
                "https://provider.example/models",
                "GET",
                Map.of(),
                null);

        new LocalProxyEngine(url -> {
            throw new AssertionError("A canceled request must not open a connection.");
        }).execute("request-3", request, session, sink);

        assertEquals("aborted", sink.errorCode);
        assertFalse(sink.completed);
    }

    @Test
    public void validatesRequestBoundaries() {
        assertThrows(
                IllegalArgumentException.class,
                () -> LocalProxyRequest.create("file:///tmp/provider", "GET", Map.of(), null));
        assertThrows(
                IllegalArgumentException.class,
                () -> LocalProxyRequest.create("https://user:pass@example.com", "GET", Map.of(), null));
        assertThrows(
                IllegalArgumentException.class,
                () -> LocalProxyRequest.create("https://example.com/#fragment", "GET", Map.of(), null));
        assertThrows(
                IllegalArgumentException.class,
                () -> LocalProxyRequest.create("https://example.com", "DELETE", Map.of(), null));
        assertThrows(
                IllegalArgumentException.class,
                () -> LocalProxyRequest.create("https://example.com", "GET", Map.of(), "body"));
        assertThrows(
                IllegalArgumentException.class,
                () -> LocalProxyRequest.create(
                        "https://example.com",
                        "GET",
                        Map.of("X-Unsafe", "value\r\ninjected"),
                        null));
    }

    private static Map<String, List<String>> headers(String... entries) {
        Map<String, List<String>> result = new LinkedHashMap<>();
        for (int index = 0; index < entries.length; index += 2) {
            result.put(entries[index], List.of(entries[index + 1]));
        }
        return result;
    }

    private static final class RecordingSink implements LocalProxyEventSink {

        int status;
        Map<String, String> headers = Map.of();
        final List<Integer> sequences = new ArrayList<>();
        final List<byte[]> chunks = new ArrayList<>();
        boolean completed;
        String errorCode;

        @Override
        public void onHeaders(
                String requestId,
                int status,
                String statusText,
                Map<String, String> headers) {
            this.status = status;
            this.headers = headers;
        }

        @Override
        public void onChunk(String requestId, int sequence, byte[] data) {
            sequences.add(sequence);
            chunks.add(data);
        }

        @Override
        public void onComplete(String requestId) {
            completed = true;
        }

        @Override
        public void onError(String requestId, String code, String message) {
            errorCode = code;
        }
    }

    private static final class FakeConnection extends HttpURLConnection {

        private final int responseCode;
        private final String responseMessage;
        private final Map<String, List<String>> responseHeaders;
        private final byte[] responseBody;
        final ByteArrayOutputStream requestBody = new ByteArrayOutputStream();
        boolean disconnected;

        FakeConnection(
                URL url,
                int responseCode,
                String responseMessage,
                Map<String, List<String>> responseHeaders,
                byte[] responseBody) {
            super(url);
            this.responseCode = responseCode;
            this.responseMessage = responseMessage;
            this.responseHeaders = responseHeaders;
            this.responseBody = responseBody;
        }

        @Override
        public void disconnect() {
            disconnected = true;
        }

        @Override
        public boolean usingProxy() {
            return false;
        }

        @Override
        public void connect() {}

        @Override
        public int getResponseCode() {
            return responseCode;
        }

        @Override
        public String getResponseMessage() {
            return responseMessage;
        }

        @Override
        public Map<String, List<String>> getHeaderFields() {
            return responseHeaders;
        }

        @Override
        public String getHeaderField(String name) {
            for (Map.Entry<String, List<String>> entry : responseHeaders.entrySet()) {
                if (entry.getKey().toLowerCase(Locale.ROOT).equals(name.toLowerCase(Locale.ROOT))) {
                    return entry.getValue().isEmpty() ? null : entry.getValue().get(0);
                }
            }
            return null;
        }

        @Override
        public InputStream getInputStream() {
            return new ByteArrayInputStream(responseBody);
        }

        @Override
        public InputStream getErrorStream() {
            return responseCode >= 400 ? new ByteArrayInputStream(responseBody) : null;
        }

        @Override
        public OutputStream getOutputStream() throws IOException {
            return requestBody;
        }
    }
}
