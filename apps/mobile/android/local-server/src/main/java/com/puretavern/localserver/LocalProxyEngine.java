package com.puretavern.localserver;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ProtocolException;
import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

final class LocalProxyEngine {

    interface ConnectionFactory {
        HttpURLConnection open(URI url) throws IOException;
    }

    static final int CHUNK_SIZE = 32 * 1024;
    static final int MAX_REDIRECTS = 10;
    private static final int CONNECT_TIMEOUT_MILLIS = 15_000;
    private static final Set<String> BLOCKED_REQUEST_HEADERS = Set.of(
            "accept-encoding",
            "connection",
            "content-length",
            "host",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade");
    private static final Set<String> BLOCKED_RESPONSE_HEADERS = Set.of(
            "connection",
            "content-length",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "set-cookie",
            "set-cookie2",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade");
    private static final Set<String> CROSS_ORIGIN_SENSITIVE_HEADERS = Set.of(
            "authorization",
            "cookie",
            "proxy-authorization");
    private static final Set<String> ENTITY_HEADERS = Set.of(
            "content-encoding",
            "content-language",
            "content-length",
            "content-location",
            "content-type",
            "transfer-encoding");

    private final ConnectionFactory connectionFactory;

    LocalProxyEngine() {
        this(url -> (HttpURLConnection) url.toURL().openConnection());
    }

    LocalProxyEngine(ConnectionFactory connectionFactory) {
        this.connectionFactory = connectionFactory;
    }

    void execute(
            String requestId,
            LocalProxyRequest request,
            LocalProxySession session,
            LocalProxyEventSink sink) {
        try {
            executeRequest(requestId, request, session, sink);
        } catch (RequestCanceledException error) {
            sink.onError(requestId, "aborted", "The local backend request was aborted.");
        } catch (ProtocolException | IllegalArgumentException error) {
            sink.onError(
                    requestId,
                    "protocol",
                    "The provider returned an invalid redirect or response.");
        } catch (IOException error) {
            if (session.isCanceled()) {
                sink.onError(requestId, "aborted", "The local backend request was aborted.");
            } else {
                sink.onError(
                        requestId,
                        "network",
                        "The Android local backend could not reach the provider.");
            }
        } catch (RuntimeException error) {
            if (session.isCanceled()) {
                sink.onError(requestId, "aborted", "The local backend request was aborted.");
            } else {
                sink.onError(
                        requestId,
                        "protocol",
                        "The Android local backend could not process the provider response.");
            }
        } finally {
            session.closeResources();
        }
    }

    private void executeRequest(
            String requestId,
            LocalProxyRequest request,
            LocalProxySession session,
            LocalProxyEventSink sink) throws IOException, RequestCanceledException {
        RedirectState state = new RedirectState(
                request.url,
                request.method,
                new LinkedHashMap<>(request.headers),
                request.body);

        for (int redirectCount = 0; ; redirectCount += 1) {
            ensureActive(session);
            HttpURLConnection connection = connectionFactory.open(state.url);
            if (!session.attachConnection(connection)) throw new RequestCanceledException();
            configureConnection(connection, state);

            int status;
            try {
                writeRequestBody(connection, state, session);
                ensureActive(session);
                status = connection.getResponseCode();
                ensureActive(session);
            } catch (IOException | RuntimeException error) {
                session.releaseConnection(connection);
                connection.disconnect();
                throw error;
            }

            String location = connection.getHeaderField("Location");
            if (isRedirect(status) && location != null && !location.isBlank()) {
                if (redirectCount >= MAX_REDIRECTS) {
                    session.releaseConnection(connection);
                    connection.disconnect();
                    throw new ProtocolException("Too many redirects.");
                }
                URI target = LocalProxyRequest.parseUrl(state.url.resolve(location).toString());
                closeRedirectConnection(connection, session);
                state = state.redirected(target, status);
                continue;
            }

            streamResponse(requestId, status, connection, session, sink);
            return;
        }
    }

    private static void configureConnection(HttpURLConnection connection, RedirectState state)
            throws ProtocolException {
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MILLIS);
        connection.setReadTimeout(0);
        connection.setUseCaches(false);
        connection.setDoInput(true);
        connection.setRequestMethod(state.method);

        Set<String> blocked = new HashSet<>(BLOCKED_REQUEST_HEADERS);
        blocked.addAll(connectionHeaderTokens(state.headers));
        for (Map.Entry<String, String> entry : state.headers.entrySet()) {
            if (blocked.contains(entry.getKey().toLowerCase(Locale.ROOT))) continue;
            connection.setRequestProperty(entry.getKey(), entry.getValue());
        }
        connection.setRequestProperty("Accept-Encoding", "identity");
    }

    private static void writeRequestBody(
            HttpURLConnection connection,
            RedirectState state,
            LocalProxySession session) throws IOException, RequestCanceledException {
        if (state.body == null) return;
        ensureActive(session);
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(state.body.length);
        try (OutputStream output = connection.getOutputStream()) {
            ensureActive(session);
            output.write(state.body);
            output.flush();
        }
    }

    private static void streamResponse(
            String requestId,
            int status,
            HttpURLConnection connection,
            LocalProxySession session,
            LocalProxyEventSink sink) throws IOException, RequestCanceledException {
        Map<String, String> responseHeaders = filteredResponseHeaders(connection.getHeaderFields());
        sink.onHeaders(
                requestId,
                status,
                safeStatusText(connection.getResponseMessage()),
                responseHeaders);

        if (!responseHasBody(status)) {
            ensureActive(session);
            sink.onComplete(requestId);
            session.releaseConnection(connection);
            connection.disconnect();
            return;
        }

        InputStream input = responseStream(connection, status);
        if (input == null) input = new ByteArrayInputStream(new byte[0]);
        if (!session.attachInput(input)) throw new RequestCanceledException();

        int sequence = 0;
        byte[] buffer = new byte[CHUNK_SIZE];
        try {
            while (true) {
                ensureActive(session);
                int count = input.read(buffer);
                if (count < 0) break;
                if (count == 0) continue;
                ensureActive(session);
                sink.onChunk(requestId, sequence, Arrays.copyOf(buffer, count));
                sequence += 1;
            }
            ensureActive(session);
            sink.onComplete(requestId);
        } finally {
            session.releaseInput(input);
            try {
                input.close();
            } finally {
                session.releaseConnection(connection);
                connection.disconnect();
            }
        }
    }

    private static InputStream responseStream(HttpURLConnection connection, int status)
            throws IOException {
        if (status >= 400) return connection.getErrorStream();
        return connection.getInputStream();
    }

    private static void closeRedirectConnection(
            HttpURLConnection connection,
            LocalProxySession session) {
        InputStream error = connection.getErrorStream();
        if (error != null) {
            try {
                error.close();
            } catch (IOException ignored) {}
        }
        session.releaseConnection(connection);
        connection.disconnect();
    }

    private static Map<String, String> filteredResponseHeaders(
            Map<String, List<String>> rawHeaders) {
        Set<String> blocked = new HashSet<>(BLOCKED_RESPONSE_HEADERS);
        blocked.addAll(responseConnectionHeaderTokens(rawHeaders));
        Map<String, String> filtered = new LinkedHashMap<>();
        if (rawHeaders == null) return filtered;

        for (Map.Entry<String, List<String>> entry : rawHeaders.entrySet()) {
            String name = entry.getKey();
            if (name == null) continue;
            String lowerName = name.toLowerCase(Locale.ROOT);
            if (blocked.contains(lowerName) || lowerName.startsWith("access-control-")) continue;
            List<String> values = entry.getValue();
            if (values == null || values.isEmpty()) continue;
            List<String> safeValues = new ArrayList<>();
            for (String value : values) {
                if (value != null && isSafeHeaderValue(value)) safeValues.add(value);
            }
            if (!safeValues.isEmpty()) filtered.put(name, String.join(", ", safeValues));
        }
        return filtered;
    }

    private static Set<String> connectionHeaderTokens(Map<String, String> headers) {
        if (headers == null || headers.isEmpty()) return Collections.emptySet();
        Set<String> tokens = new HashSet<>();
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey().equalsIgnoreCase("Connection")) {
                addHeaderTokens(tokens, entry.getValue());
            }
        }
        return tokens;
    }

    private static Set<String> responseConnectionHeaderTokens(Map<String, List<String>> headers) {
        if (headers == null || headers.isEmpty()) return Collections.emptySet();
        Set<String> tokens = new HashSet<>();
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
            if (entry.getKey() == null || !entry.getKey().equalsIgnoreCase("Connection")) continue;
            if (entry.getValue() == null) continue;
            for (String value : entry.getValue()) addHeaderTokens(tokens, value);
        }
        return tokens;
    }

    private static void addHeaderTokens(Set<String> target, String value) {
        if (value == null) return;
        for (String token : value.split(",")) {
            String normalized = token.trim().toLowerCase(Locale.ROOT);
            if (!normalized.isEmpty()) target.add(normalized);
        }
    }

    private static boolean isSafeHeaderValue(String value) {
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (character == '\r' || character == '\n' || character == 0) return false;
        }
        return true;
    }

    private static String safeStatusText(String value) {
        if (value == null) return "";
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (character < 0x20 || character > 0x7e) return "";
        }
        return value;
    }

    private static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    private static boolean responseHasBody(int status) {
        return status != 204 && status != 205 && status != 304;
    }

    private static void ensureActive(LocalProxySession session) throws RequestCanceledException {
        if (session.isCanceled()) throw new RequestCanceledException();
    }

    private static boolean sameOrigin(URI left, URI right) {
        return left.getScheme().equalsIgnoreCase(right.getScheme())
                && left.getHost().equalsIgnoreCase(right.getHost())
                && effectivePort(left) == effectivePort(right);
    }

    private static int effectivePort(URI value) {
        if (value.getPort() >= 0) return value.getPort();
        return value.getScheme().equalsIgnoreCase("https") ? 443 : 80;
    }

    private static Map<String, String> withoutHeaders(
            Map<String, String> source,
            Set<String> removedNames) {
        Map<String, String> result = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : source.entrySet()) {
            if (!removedNames.contains(entry.getKey().toLowerCase(Locale.ROOT))) {
                result.put(entry.getKey(), entry.getValue());
            }
        }
        return result;
    }

    private static final class RedirectState {

        final URI url;
        final String method;
        final Map<String, String> headers;
        final byte[] body;

        RedirectState(URI url, String method, Map<String, String> headers, byte[] body) {
            this.url = url;
            this.method = method;
            this.headers = headers;
            this.body = body;
        }

        RedirectState redirected(URI target, int status) {
            Map<String, String> nextHeaders = headers;
            if (!sameOrigin(url, target)) {
                nextHeaders = withoutHeaders(nextHeaders, CROSS_ORIGIN_SENSITIVE_HEADERS);
            }
            if (method.equals("POST") && (status == 301 || status == 302 || status == 303)) {
                nextHeaders = withoutHeaders(nextHeaders, ENTITY_HEADERS);
                return new RedirectState(target, "GET", nextHeaders, null);
            }
            return new RedirectState(target, method, nextHeaders, body);
        }
    }

    private static final class RequestCanceledException extends Exception {}
}
