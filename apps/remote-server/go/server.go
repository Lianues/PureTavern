package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	remoteBackendProtocol        = "pure-tavern-generation-proxy"
	remoteBackendProtocolVersion = 1
	proxyHeader                  = "X-Pure-Tavern-Proxy"
	proxyErrorHeader             = "X-Pure-Tavern-Proxy-Error"
	maxEnvelopeBytes             = 64 * 1024 * 1024
	maxRedirects                 = 10
)

var hopByHopHeaders = stringSet(
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
)

var requestBlockedHeaders = mergeSets(hopByHopHeaders, stringSet(
	"accept-encoding",
	"content-length",
	"host",
))

var responseBlockedHeaders = mergeSets(hopByHopHeaders, stringSet(
	"content-length",
	"set-cookie",
	"set-cookie2",
))

var crossOriginSensitiveHeaders = []string{
	"Authorization",
	"Cookie",
	"Cookie2",
	"Proxy-Authorization",
}

type settings struct {
	AccessKey      string
	Host           string
	Port           int
	AllowedOrigins []string
}

type proxyEnvelope struct {
	Protocol        string             `json:"protocol"`
	ProtocolVersion int                `json:"protocolVersion"`
	Request         proxyTargetRequest `json:"request"`
}

type proxyTargetRequest struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body"`
}

type proxyServer struct {
	settings settings
	client   *http.Client
}

type proxyErrorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func loadSettings(getenv func(string) string) (settings, error) {
	accessKey := strings.TrimSpace(getenv("PURE_TAVERN_PROXY_KEY"))
	if accessKey == "" {
		return settings{}, errors.New("PURE_TAVERN_PROXY_KEY is required before the remote backend can start")
	}

	host := strings.TrimSpace(getenv("PURE_TAVERN_PROXY_HOST"))
	if host == "" {
		host = "0.0.0.0"
	}
	portText := strings.TrimSpace(getenv("PURE_TAVERN_PROXY_PORT"))
	if portText == "" {
		portText = "8000"
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 0 || port > 65535 {
		return settings{}, errors.New("PURE_TAVERN_PROXY_PORT must be an integer between 0 and 65535")
	}

	return settings{
		AccessKey:      accessKey,
		Host:           host,
		Port:           port,
		AllowedOrigins: parseAllowedOrigins(getenv("PURE_TAVERN_ALLOWED_ORIGINS")),
	}, nil
}

func parseAllowedOrigins(value string) []string {
	if strings.TrimSpace(value) == "" {
		return []string{"*"}
	}
	seen := make(map[string]struct{})
	origins := make([]string, 0)
	for _, item := range strings.Split(value, ",") {
		origin := strings.TrimSpace(item)
		if origin == "*" {
			return []string{"*"}
		}
		if origin == "" {
			continue
		}
		if _, exists := seen[origin]; exists {
			continue
		}
		seen[origin] = struct{}{}
		origins = append(origins, origin)
	}
	if len(origins) == 0 {
		return []string{"*"}
	}
	return origins
}

func newProxyServer(configuration settings, client *http.Client) (*proxyServer, error) {
	configuration.AccessKey = strings.TrimSpace(configuration.AccessKey)
	if configuration.AccessKey == "" {
		return nil, errors.New("PURE_TAVERN_PROXY_KEY is required before the remote backend can start")
	}
	if len(configuration.AllowedOrigins) == 0 {
		configuration.AllowedOrigins = []string{"*"}
	}
	if client == nil {
		client = newUpstreamClient()
	}
	return &proxyServer{settings: configuration, client: client}, nil
}

func newUpstreamClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &http.Client{
		Transport:     transport,
		CheckRedirect: checkSafeRedirect,
	}
}

func checkSafeRedirect(request *http.Request, via []*http.Request) error {
	if len(via) >= maxRedirects {
		return errors.New("the upstream provider returned too many redirects")
	}
	if err := validateTargetURL(request.URL); err != nil {
		return err
	}
	if len(via) > 0 && !sameOrigin(via[len(via)-1].URL, request.URL) {
		for _, name := range crossOriginSensitiveHeaders {
			request.Header.Del(name)
		}
	}
	return nil
}

func (server *proxyServer) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	server.applyCORS(response, request)

	if request.Method == http.MethodOptions {
		response.WriteHeader(http.StatusOK)
		return
	}

	if request.Method == http.MethodGet && request.URL.Path == "/v1/health" {
		if !isAuthorized(request.Header.Get("Authorization"), server.settings.AccessKey) {
			writeAuthenticationError(response)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"status":          "ok",
			"service":         "pure-tavern-remote-backend",
			"protocol":        remoteBackendProtocol,
			"protocolVersion": remoteBackendProtocolVersion,
		}, "")
		return
	}

	if request.Method == http.MethodPost && request.URL.Path == "/v1/proxy" {
		if !isAuthorized(request.Header.Get("Authorization"), server.settings.AccessKey) {
			writeAuthenticationError(response)
			return
		}
		server.handleProxy(response, request)
		return
	}

	writeProxyError(response, http.StatusNotFound, "not-found", "The requested remote backend route does not exist.", "request")
}

func (server *proxyServer) handleProxy(response http.ResponseWriter, request *http.Request) {
	target, err := decodeProxyEnvelope(response, request)
	if err != nil {
		writeProxyError(response, http.StatusUnprocessableEntity, "invalid-proxy-request", "The proxy request does not match protocol version 1.", "request")
		return
	}

	upstreamRequest, err := buildUpstreamRequest(request.Context(), target)
	if err != nil {
		writeProxyError(response, http.StatusUnprocessableEntity, "invalid-proxy-request", "The proxy request does not match protocol version 1.", "request")
		return
	}

	upstreamResponse, err := server.client.Do(upstreamRequest)
	if err != nil {
		if upstreamResponse != nil && upstreamResponse.Body != nil {
			_ = upstreamResponse.Body.Close()
		}
		writeProxyError(response, http.StatusBadGateway, "upstream-unreachable", "The remote backend could not reach the upstream provider.", "upstream")
		return
	}
	defer upstreamResponse.Body.Close()

	copyResponseHeaders(response.Header(), upstreamResponse.Header)
	response.Header().Set(proxyHeader, "1")
	response.WriteHeader(upstreamResponse.StatusCode)
	streamResponse(response, upstreamResponse.Body)
}

func decodeProxyEnvelope(response http.ResponseWriter, request *http.Request) (proxyTargetRequest, error) {
	request.Body = http.MaxBytesReader(response, request.Body, maxEnvelopeBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var envelope proxyEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return proxyTargetRequest{}, err
	}
	if err := requireJSONEOF(decoder); err != nil {
		return proxyTargetRequest{}, err
	}
	if envelope.Protocol != remoteBackendProtocol || envelope.ProtocolVersion != remoteBackendProtocolVersion {
		return proxyTargetRequest{}, errors.New("invalid proxy protocol")
	}
	if envelope.Request.Method != http.MethodGet && envelope.Request.Method != http.MethodPost {
		return proxyTargetRequest{}, errors.New("invalid proxy method")
	}
	parsed, err := url.Parse(envelope.Request.URL)
	if err != nil || validateTargetURL(parsed) != nil {
		return proxyTargetRequest{}, errors.New("invalid target URL")
	}
	if envelope.Request.Method == http.MethodGet && envelope.Request.Body != nil {
		return proxyTargetRequest{}, errors.New("GET proxy requests must not contain a body")
	}
	if envelope.Request.Headers == nil {
		envelope.Request.Headers = map[string]string{}
	}
	return envelope.Request, nil
}

func requireJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values are not allowed")
		}
		return err
	}
	return nil
}

func buildUpstreamRequest(ctx context.Context, target proxyTargetRequest) (*http.Request, error) {
	var body io.Reader
	if target.Body != nil {
		body = strings.NewReader(*target.Body)
	}
	request, err := http.NewRequestWithContext(ctx, target.Method, target.URL, body)
	if err != nil {
		return nil, err
	}
	for name, value := range target.Headers {
		if !validHeaderName(name) || !validHeaderValue(value) {
			return nil, errors.New("invalid upstream header")
		}
		if _, blocked := requestBlockedHeaders[strings.ToLower(name)]; blocked {
			continue
		}
		request.Header.Set(name, value)
	}
	request.Header.Set("Accept-Encoding", "identity")
	return request, nil
}

func validateTargetURL(target *url.URL) error {
	if target == nil || (target.Scheme != "http" && target.Scheme != "https") || target.Hostname() == "" {
		return errors.New("target URL must be absolute HTTP or HTTPS")
	}
	if target.User != nil {
		return errors.New("target URL must not contain embedded credentials")
	}
	if target.Fragment != "" {
		return errors.New("target URL must not contain a fragment")
	}
	return nil
}

func sameOrigin(left, right *url.URL) bool {
	return left.Scheme == right.Scheme && strings.EqualFold(left.Host, right.Host)
}

func validHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for index := 0; index < len(name); index++ {
		character := name[index]
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			strings.ContainsRune("!#$%&'*+-.^_`|~", rune(character)) {
			continue
		}
		return false
	}
	return true
}

func validHeaderValue(value string) bool {
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character < 0x20 && character != '\t') || character == 0x7f {
			return false
		}
	}
	return true
}

func copyResponseHeaders(destination, source http.Header) {
	for name, values := range source {
		lower := strings.ToLower(name)
		if _, blocked := responseBlockedHeaders[lower]; blocked || strings.HasPrefix(lower, "access-control-") {
			continue
		}
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func streamResponse(response http.ResponseWriter, body io.Reader) {
	buffer := make([]byte, 32*1024)
	flusher, canFlush := response.(http.Flusher)
	for {
		count, readErr := body.Read(buffer)
		if count > 0 {
			if _, writeErr := response.Write(buffer[:count]); writeErr != nil {
				return
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if errors.Is(readErr, io.EOF) {
			return
		}
		if readErr != nil {
			return
		}
	}
}

func (server *proxyServer) applyCORS(response http.ResponseWriter, request *http.Request) {
	origin := request.Header.Get("Origin")
	if origin != "" && contains(server.settings.AllowedOrigins, "*") {
		response.Header().Set("Access-Control-Allow-Origin", "*")
	} else if origin != "" && contains(server.settings.AllowedOrigins, origin) {
		response.Header().Set("Access-Control-Allow-Origin", origin)
		response.Header().Add("Vary", "Origin")
	}
	response.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	response.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	response.Header().Set("Access-Control-Expose-Headers", proxyHeader+", "+proxyErrorHeader+", Content-Type")
	response.Header().Set("Access-Control-Max-Age", "600")
	if request.Header.Get("Access-Control-Request-Private-Network") == "true" {
		response.Header().Set("Access-Control-Allow-Private-Network", "true")
	}
}

func isAuthorized(authorization, expectedKey string) bool {
	parts := strings.SplitN(authorization, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return false
	}
	expected := sha256.Sum256([]byte(expectedKey))
	supplied := sha256.Sum256([]byte(parts[1]))
	return subtle.ConstantTimeCompare(expected[:], supplied[:]) == 1
}

func writeAuthenticationError(response http.ResponseWriter) {
	response.Header().Set("WWW-Authenticate", "Bearer")
	writeJSON(response, http.StatusUnauthorized, map[string]string{
		"detail": "Invalid remote backend access key.",
	}, "authentication")
}

func writeProxyError(response http.ResponseWriter, status int, code, message, errorType string) {
	body := proxyErrorBody{}
	body.Error.Code = code
	body.Error.Message = message
	writeJSON(response, status, body, errorType)
}

func writeJSON(response http.ResponseWriter, status int, value any, errorType string) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set(proxyHeader, "1")
	if errorType != "" {
		response.Header().Set(proxyErrorHeader, errorType)
	}
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func stringSet(values ...string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		result[value] = struct{}{}
	}
	return result
}

func mergeSets(sets ...map[string]struct{}) map[string]struct{} {
	result := make(map[string]struct{})
	for _, set := range sets {
		for value := range set {
			result[value] = struct{}{}
		}
	}
	return result
}

func address(configuration settings) string {
	return configuration.Host + ":" + strconv.Itoa(configuration.Port)
}

func describeVersion(binaryVersion, binaryCommit string) string {
	return fmt.Sprintf("pure-tavern-remote-server %s (%s)", binaryVersion, binaryCommit)
}
