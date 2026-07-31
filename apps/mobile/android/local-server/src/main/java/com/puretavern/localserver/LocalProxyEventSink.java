package com.puretavern.localserver;

import java.util.Map;

interface LocalProxyEventSink {

    void onHeaders(
            String requestId,
            int status,
            String statusText,
            Map<String, String> headers);

    void onChunk(String requestId, int sequence, byte[] data);

    void onComplete(String requestId);

    void onError(String requestId, String code, String message);
}
