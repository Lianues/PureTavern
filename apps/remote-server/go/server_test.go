package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testAccessKey = "test-remote-backend-key"

var testAuthorization = "Bearer " + testAccessKey

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func testEnvelope(overrides map[string]any) map[string]any {
	target := map[string]any{
		"url":    "https://provider.example/v1/chat/completions?api-version=1",
		"method": http.MethodPost,
		"headers": map[string]string{
			"Authorization": "Bearer provider-secret",
			"Content-Type":  "application/json",
		},
		"body": `{"model":"test-model","stream":true}`,
	}
	for key, value := range overrides {
		target[key] = value
	}
	return map[string]any{
		"protocol":        remoteBackendProtocol,
		"protocolVersion": remoteBackendProtocolVersion,
		"request":         target,
	}
}

func testHandler(t *testing.T, client *http.Client) *proxyServer {
	t.Helper()
	handler, err := newProxyServer(settings{
		AccessKey:      testAccessKey,
		AllowedOrigins: []string{"http://127.0.0.1:8899"},
	}, client)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func performProxy(t *testing.T, handler http.Handler, payload any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/proxy", bytes.NewReader(encoded))
	request.Header.Set("Authorization", testAuthorization)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestHealthRequiresConfiguredAccessKey(t *testing.T) {
	if _, err := newProxyServer(settings{}, nil); err == nil {
		t.Fatal("expected an empty access key to be rejected")
	}
	if _, err := loadSettings(func(string) string { return "" }); err == nil {
		t.Fatal("expected missing environment key to be rejected")
	}

	environment := map[string]string{
		"PURE_TAVERN_PROXY_KEY":       " key ",
		"PURE_TAVERN_PROXY_HOST":      "127.0.0.1",
		"PURE_TAVERN_PROXY_PORT":      "9000",
		"PURE_TAVERN_ALLOWED_ORIGINS": "http://a.example,http://b.example,http://a.example",
	}
	configuration, err := loadSettings(func(key string) string { return environment[key] })
	if err != nil {
		t.Fatal(err)
	}
	if configuration.AccessKey != "key" || configuration.Host != "127.0.0.1" || configuration.Port != 9000 {
		t.Fatalf("unexpected settings: %#v", configuration)
	}
	if strings.Join(configuration.AllowedOrigins, ",") != "http://a.example,http://b.example" {
		t.Fatalf("unexpected origins: %#v", configuration.AllowedOrigins)
	}

	handler := testHandler(t, &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("health must not call upstream")
	})})
	for _, authorization := range []string{"", "Bearer wrong"} {
		request := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
		if authorization != "" {
			request.Header.Set("Authorization", authorization)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized || response.Header().Get(proxyErrorHeader) != "authentication" {
			t.Fatalf("unexpected unauthorized response: %d %#v", response.Code, response.Header())
		}
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	request.Header.Set("Authorization", testAuthorization)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get(proxyHeader) != "1" {
		t.Fatalf("unexpected health response: %d %#v", response.Code, response.Header())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["protocol"] != remoteBackendProtocol || body["protocolVersion"] != float64(1) {
		t.Fatalf("unexpected health body: %#v", body)
	}
}

func TestProxyForwardsHeadersAndStreamsResponse(t *testing.T) {
	var captured *http.Request
	var capturedBody string
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		captured = request.Clone(request.Context())
		body, err := io.ReadAll(request.Body)
		if err != nil {
			return nil, err
		}
		capturedBody = string(body)
		return &http.Response{
			StatusCode: 207,
			Header: http.Header{
				"Content-Type":                []string{"text/event-stream; charset=utf-8"},
				"Set-Cookie":                  []string{"must-not-reach-browser=true"},
				"Connection":                  []string{"keep-alive"},
				"Access-Control-Allow-Origin": []string{"https://provider.example"},
			},
			Body: io.NopCloser(strings.NewReader("data: {\"delta\":\"one\"}\n\ndata: {\"delta\":\"two\"}\n\n")),
		}, nil
	})}
	handler := testHandler(t, client)
	response := performProxy(t, handler, testEnvelope(map[string]any{
		"headers": map[string]string{
			"Authorization":     "Bearer provider-secret",
			"Content-Type":      "application/json",
			"HTTP-Referer":      "https://sillytavern.app",
			"X-Title":           "SillyTavern",
			"api-key":           "azure-provider-key",
			"x-api-key":         "anthropic-provider-key",
			"anthropic-version": "2023-06-01",
			"anthropic-beta":    "tools-2024-05-16",
			"Accept-Language":   "en-US,en",
			"X-Provider":        "preferred-provider",
			"X-Billing-Mode":    "paygo",
			"Host":              "attacker.example",
			"Connection":        "upgrade",
			"Content-Length":    "999999",
		},
	}))

	if response.Code != 207 || response.Header().Get(proxyHeader) != "1" || !response.Flushed {
		t.Fatalf("unexpected streamed response: %d flushed=%v", response.Code, response.Flushed)
	}
	if response.Header().Get("Set-Cookie") != "" || response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("unsafe upstream response headers were forwarded: %#v", response.Header())
	}
	if response.Body.String() != "data: {\"delta\":\"one\"}\n\ndata: {\"delta\":\"two\"}\n\n" {
		t.Fatalf("unexpected response body: %q", response.Body.String())
	}
	if captured == nil {
		t.Fatal("upstream request was not captured")
	}
	if captured.URL.String() != "https://provider.example/v1/chat/completions?api-version=1" {
		t.Fatalf("unexpected URL: %s", captured.URL)
	}
	for name, expected := range map[string]string{
		"Authorization":     "Bearer provider-secret",
		"HTTP-Referer":      "https://sillytavern.app",
		"X-Title":           "SillyTavern",
		"Api-Key":           "azure-provider-key",
		"X-Api-Key":         "anthropic-provider-key",
		"Anthropic-Version": "2023-06-01",
		"Anthropic-Beta":    "tools-2024-05-16",
		"Accept-Language":   "en-US,en",
		"X-Provider":        "preferred-provider",
		"X-Billing-Mode":    "paygo",
		"Accept-Encoding":   "identity",
	} {
		if actual := captured.Header.Get(name); actual != expected {
			t.Errorf("header %s: got %q, want %q", name, actual, expected)
		}
	}
	if captured.Header.Get("Host") != "" || captured.Header.Get("Content-Length") != "" {
		t.Fatalf("blocked request headers leaked: %#v", captured.Header)
	}
	if capturedBody != `{"model":"test-model","stream":true}` {
		t.Fatalf("unexpected body: %s", capturedBody)
	}
}

func TestProxyReturnsNonStreamingJSON(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
		}, nil
	})}
	response := performProxy(t, testHandler(t, client), testEnvelope(map[string]any{"body": `{"stream":false}`}))
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"ok":true}` {
		t.Fatalf("unexpected JSON response: %d %q", response.Code, response.Body.String())
	}
}

func TestCrossOriginRedirectStripsAuthorization(t *testing.T) {
	var firstAuthorization string
	var redirectedAuthorization string
	finalServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		redirectedAuthorization = request.Header.Get("Authorization")
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"ok":true}`))
	}))
	defer finalServer.Close()
	firstServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		firstAuthorization = request.Header.Get("Authorization")
		http.Redirect(response, request, finalServer.URL+"/final", http.StatusTemporaryRedirect)
	}))
	defer firstServer.Close()

	handler := testHandler(t, newUpstreamClient())
	response := performProxy(t, handler, testEnvelope(map[string]any{"url": firstServer.URL + "/start"}))
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected proxy status: %d %s", response.Code, response.Body.String())
	}
	if firstAuthorization != "Bearer provider-secret" {
		t.Fatalf("initial authorization missing: %q", firstAuthorization)
	}
	if redirectedAuthorization != "" {
		t.Fatalf("authorization leaked across origin: %q", redirectedAuthorization)
	}
}

func TestInvalidProxyRequestsAreBounded(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("invalid input must not call upstream")
	})}
	handler := testHandler(t, client)
	payloads := []map[string]any{
		testEnvelope(map[string]any{"method": "DELETE"}),
		testEnvelope(map[string]any{"url": "ftp://provider.example/model"}),
		testEnvelope(map[string]any{"url": "https://user:password@provider.example/model"}),
		testEnvelope(map[string]any{"method": http.MethodGet, "body": "must-not-have-a-body"}),
		testEnvelope(map[string]any{"headers": map[string]string{"Bad Header": "value"}}),
		testEnvelope(map[string]any{"headers": map[string]string{"X-Test": "value\r\ninjected"}}),
	}
	extra := testEnvelope(nil)
	extra["protocolVersion"] = 999
	extra["providerSecret"] = "must-not-be-echoed"
	payloads = append(payloads, extra)

	for _, payload := range payloads {
		response := performProxy(t, handler, payload)
		text := response.Body.String()
		if response.Code != http.StatusUnprocessableEntity || response.Header().Get(proxyErrorHeader) != "request" {
			t.Fatalf("unexpected invalid response: %d %#v", response.Code, response.Header())
		}
		if strings.Contains(text, "must-not-be-echoed") || strings.Contains(text, "provider-secret") {
			t.Fatalf("secret echoed in response: %s", text)
		}
		var body proxyErrorBody
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Error.Code != "invalid-proxy-request" {
			t.Fatalf("unexpected error body: %s", text)
		}
	}
}

func TestUpstreamErrorsAreSafe(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("private network detail")
	})}
	response := performProxy(t, testHandler(t, client), testEnvelope(nil))
	text := response.Body.String()
	if response.Code != http.StatusBadGateway || response.Header().Get(proxyErrorHeader) != "upstream" {
		t.Fatalf("unexpected upstream error: %d %#v", response.Code, response.Header())
	}
	if strings.Contains(text, "private network detail") || strings.Contains(text, "provider-secret") {
		t.Fatalf("upstream detail leaked: %s", text)
	}
}

func TestCORSAndPrivateNetworkPreflight(t *testing.T) {
	handler := testHandler(t, &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("preflight must not call upstream")
	})})
	request := httptest.NewRequest(http.MethodOptions, "/v1/proxy", nil)
	request.Header.Set("Origin", "http://127.0.0.1:8899")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	request.Header.Set("Access-Control-Request-Headers", "Authorization,Content-Type")
	request.Header.Set("Access-Control-Request-Private-Network", "true")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected preflight status: %d", response.Code)
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "http://127.0.0.1:8899" {
		t.Fatalf("configured origin missing: %#v", response.Header())
	}
	if response.Header().Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("private network header missing: %#v", response.Header())
	}
}

func TestVersionDescription(t *testing.T) {
	if actual := describeVersion("1.2.3", "abcdef"); actual != "pure-tavern-remote-server 1.2.3 (abcdef)" {
		t.Fatalf("unexpected version: %s", actual)
	}
}
