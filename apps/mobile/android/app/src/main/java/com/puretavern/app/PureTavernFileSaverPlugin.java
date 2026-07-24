package com.puretavern.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "PureTavernFileSaver")
public class PureTavernFileSaverPlugin extends Plugin {

    private static final int MAX_CHUNK_BYTES = 1024 * 1024;
    private final Map<String, SaveSession> sessions = new ConcurrentHashMap<>();

    @PluginMethod
    public void beginSave(PluginCall call) {
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType");
        if (
            fileName == null || fileName.trim().isEmpty() || fileName.contains("/") || fileName.contains("\\")
        ) {
            call.reject("A safe file name is required.");
            return;
        }
        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = "application/octet-stream";
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, fileName);
        startActivityForResult(call, intent, "saveDocumentResult");
    }

    @ActivityCallback
    private void saveDocumentResult(PluginCall call, ActivityResult result) {
        JSObject response = new JSObject();
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            response.put("cancelled", true);
            call.resolve(response);
            return;
        }

        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("The system file picker did not return a destination.");
            return;
        }

        try {
            OutputStream stream = getContext().getContentResolver().openOutputStream(uri, "w");
            if (stream == null) {
                call.reject("The selected destination could not be opened.");
                return;
            }
            String sessionId = UUID.randomUUID().toString();
            sessions.put(sessionId, new SaveSession(uri, stream));
            response.put("cancelled", false);
            response.put("sessionId", sessionId);
            response.put("uri", uri.toString());
            response.put("fileName", call.getString("fileName"));
            call.resolve(response);
        } catch (IOException | SecurityException error) {
            call.reject("Unable to open the selected destination: " + error.getMessage());
        }
    }

    @PluginMethod
    public void writeChunk(PluginCall call) {
        String sessionId = call.getString("sessionId");
        String encoded = call.getString("data");
        SaveSession session = sessionId == null ? null : sessions.get(sessionId);
        if (session == null || encoded == null) {
            call.reject("The file save session or chunk is missing.");
            return;
        }

        try {
            byte[] chunk = Base64.decode(encoded, Base64.NO_WRAP);
            if (chunk.length > MAX_CHUNK_BYTES) {
                discardSession(sessionId, true);
                call.reject("The file chunk is too large.");
                return;
            }
            synchronized (session) {
                session.stream.write(chunk);
            }
            call.resolve();
        } catch (IllegalArgumentException | IOException error) {
            discardSession(sessionId, true);
            call.reject("Unable to write the selected file: " + error.getMessage());
        }
    }

    @PluginMethod
    public void finishSave(PluginCall call) {
        String sessionId = call.getString("sessionId");
        SaveSession session = sessionId == null ? null : sessions.remove(sessionId);
        if (session == null) {
            call.reject("The file save session was not found.");
            return;
        }

        try {
            synchronized (session) {
                session.stream.flush();
                session.stream.close();
            }
            call.resolve();
        } catch (IOException error) {
            deleteUri(session.uri);
            call.reject("Unable to finish the selected file: " + error.getMessage());
        }
    }

    @PluginMethod
    public void abortSave(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId != null) {
            discardSession(sessionId, true);
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (String sessionId : sessions.keySet()) {
            discardSession(sessionId, true);
        }
    }

    private void discardSession(String sessionId, boolean deleteFile) {
        SaveSession session = sessions.remove(sessionId);
        if (session == null) return;
        try {
            session.stream.close();
        } catch (IOException ignored) {}
        if (deleteFile) deleteUri(session.uri);
    }

    private void deleteUri(Uri uri) {
        try {
            getContext().getContentResolver().delete(uri, null, null);
        } catch (RuntimeException ignored) {}
    }

    private static final class SaveSession {

        final Uri uri;
        final OutputStream stream;

        SaveSession(Uri uri, OutputStream stream) {
            this.uri = uri;
            this.stream = stream;
        }
    }
}
