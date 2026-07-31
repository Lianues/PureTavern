package com.puretavern.localserver;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

final class LocalProxyRequest {

    private static final int MAX_HEADERS = 128;
    private static final int MAX_HEADER_NAME_LENGTH = 256;
    private static final int MAX_HEADER_VALUE_LENGTH = 32 * 1024;
    private static final String HEADER_TOKEN_PUNCTUATION = "!#$%&'*+-.^_`|~";

    final URI url;
    final String method;
    final Map<String, String> headers;
    final byte[] body;

    private LocalProxyRequest(URI url, String method, Map<String, String> headers, byte[] body) {
        this.url = url;
        this.method = method;
        this.headers = Collections.unmodifiableMap(headers);
        this.body = body;
    }

    static LocalProxyRequest create(
            String rawUrl,
            String rawMethod,
            Map<String, String> rawHeaders,
            String rawBody) {
        URI url = parseUrl(rawUrl);
        String method = rawMethod == null ? "" : rawMethod.toUpperCase(Locale.ROOT);
        if (!method.equals("GET") && !method.equals("POST")) {
            throw new IllegalArgumentException("Only GET and POST provider requests are supported.");
        }
        if (method.equals("GET") && rawBody != null) {
            throw new IllegalArgumentException("GET provider requests must not contain a body.");
        }

        Map<String, String> headers = new LinkedHashMap<>();
        if (rawHeaders != null) {
            if (rawHeaders.size() > MAX_HEADERS) {
                throw new IllegalArgumentException("The provider request contains too many headers.");
            }
            for (Map.Entry<String, String> entry : rawHeaders.entrySet()) {
                String name = entry.getKey();
                String value = entry.getValue();
                if (!isValidHeaderName(name) || !isValidHeaderValue(value)) {
                    throw new IllegalArgumentException("The provider request contains an invalid header.");
                }
                headers.put(name, value);
            }
        }

        return new LocalProxyRequest(
                url,
                method,
                headers,
                rawBody == null ? null : rawBody.getBytes(StandardCharsets.UTF_8));
    }

    static URI parseUrl(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("A provider URL is required.");
        }
        final URI url;
        try {
            url = new URI(value);
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("The provider URL is invalid.", error);
        }
        String scheme = url.getScheme();
        if (scheme == null
                || (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https"))
                || url.getHost() == null
                || url.getHost().isBlank()
                || url.getUserInfo() != null
                || url.getFragment() != null) {
            throw new IllegalArgumentException(
                    "The provider URL must be absolute HTTP or HTTPS without credentials or a fragment.");
        }
        return url;
    }

    private static boolean isValidHeaderName(String value) {
        if (value == null
                || value.isEmpty()
                || value.length() > MAX_HEADER_NAME_LENGTH) {
            return false;
        }
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (Character.isLetterOrDigit(character)
                    || HEADER_TOKEN_PUNCTUATION.indexOf(character) >= 0) {
                continue;
            }
            return false;
        }
        return true;
    }

    private static boolean isValidHeaderValue(String value) {
        if (value == null || value.length() > MAX_HEADER_VALUE_LENGTH) {
            return false;
        }
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if ((character < 0x20 && character != '\t') || character == 0x7f) {
                return false;
            }
        }
        return true;
    }
}
