use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use futures_util::{
    future::{AbortHandle, Abortable},
    StreamExt,
};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, CONNECTION, LOCATION},
    Client, Method, StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tauri::{Emitter, State, WebviewWindow};

const RESPONSE_EVENT: &str = "pureTavernLocalServerResponse";
const MAX_ACTIVE_REQUESTS: usize = 4;
const MAX_REDIRECTS: usize = 10;
const MAX_HEADERS: usize = 128;
const MAX_HEADER_NAME_LENGTH: usize = 256;
const MAX_HEADER_VALUE_LENGTH: usize = 32 * 1024;
const CHUNK_SIZE: usize = 32 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

const BLOCKED_REQUEST_HEADERS: &[&str] = &[
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
    "upgrade",
];
const BLOCKED_RESPONSE_HEADERS: &[&str] = &[
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
    "upgrade",
];
const SENSITIVE_REDIRECT_HEADERS: &[&str] = &["authorization", "cookie", "proxy-authorization"];
const ENTITY_HEADERS: &[&str] = &[
    "content-encoding",
    "content-language",
    "content-length",
    "content-location",
    "content-type",
    "transfer-encoding",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProxyRequest {
    request_id: String,
    url: String,
    method: String,
    headers: BTreeMap<String, String>,
    body: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProxyStartResponse {
    request_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum LocalProxyEvent {
    Headers {
        request_id: String,
        status: u16,
        status_text: String,
        headers: BTreeMap<String, String>,
    },
    Chunk {
        request_id: String,
        sequence: u64,
        data: String,
    },
    Complete {
        request_id: String,
    },
    Error {
        request_id: String,
        code: String,
        message: String,
    },
}

#[derive(Clone)]
pub struct LocalServerState {
    runtime: Arc<LocalServerRuntime>,
}

struct LocalServerRuntime {
    client: Client,
    requests: Mutex<HashMap<String, AbortHandle>>,
}

#[derive(Debug)]
struct PreparedRequest {
    request_id: String,
    url: Url,
    method: Method,
    headers: HeaderMap,
    body: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProxyFailure {
    Network,
    Protocol,
    Event,
}

impl ProxyFailure {
    fn code(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Protocol | Self::Event => "protocol",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::Network => "The desktop local backend could not reach the provider.",
            Self::Protocol => "The desktop local backend received an invalid provider response.",
            Self::Event => "The desktop local backend response channel was closed.",
        }
    }
}

pub fn bridge_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("pure-tavern-local-backend")
        .js_init_script(include_str!("../generated/local-backend-bridge.js"))
        .build()
}

impl LocalServerState {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "The desktop HTTP client could not be initialized.".to_owned())?;
        Ok(Self {
            runtime: Arc::new(LocalServerRuntime {
                client,
                requests: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub fn cancel_all(&self) {
        self.runtime.cancel_all();
    }
}

impl LocalServerRuntime {
    fn requests(&self) -> MutexGuard<'_, HashMap<String, AbortHandle>> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn register(&self, request_id: &str, handle: AbortHandle) -> Result<(), &'static str> {
        let mut requests = self.requests();
        if requests.contains_key(request_id) {
            return Err("The desktop local backend request ID is already active.");
        }
        if requests.len() >= MAX_ACTIVE_REQUESTS {
            return Err("The desktop local backend has too many active requests.");
        }
        requests.insert(request_id.to_owned(), handle);
        Ok(())
    }

    fn remove(&self, request_id: &str) {
        self.requests().remove(request_id);
    }

    fn cancel(&self, request_id: &str) {
        if let Some(handle) = self.requests().remove(request_id) {
            handle.abort();
        }
    }

    fn cancel_all(&self) {
        let handles = self
            .requests()
            .drain()
            .map(|(_, handle)| handle)
            .collect::<Vec<_>>();
        for handle in handles {
            handle.abort();
        }
    }
}

#[tauri::command]
pub fn pure_tavern_local_start_request(
    window: WebviewWindow,
    state: State<'_, LocalServerState>,
    request: LocalProxyRequest,
) -> Result<LocalProxyStartResponse, String> {
    let request = prepare_request(request).map_err(str::to_owned)?;
    let request_id = request.request_id.clone();
    let runtime = Arc::clone(&state.runtime);
    let client = runtime.client.clone();
    let cleanup_runtime = Arc::clone(&runtime);
    let response_window = window.clone();
    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    runtime
        .register(&request_id, abort_handle)
        .map_err(str::to_owned)?;

    let cleanup_request_id = request_id.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = Abortable::new(
            run_proxy_request(client, response_window.clone(), request),
            abort_registration,
        )
        .await;
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(ProxyFailure::Event)) => {}
            Ok(Err(error)) => {
                let _ = emit_event(
                    &response_window,
                    LocalProxyEvent::Error {
                        request_id: cleanup_request_id.clone(),
                        code: error.code().to_owned(),
                        message: error.message().to_owned(),
                    },
                );
            }
            Err(_) => {
                let _ = emit_event(
                    &response_window,
                    LocalProxyEvent::Error {
                        request_id: cleanup_request_id.clone(),
                        code: "aborted".to_owned(),
                        message: "The desktop local backend request was aborted.".to_owned(),
                    },
                );
            }
        }
        cleanup_runtime.remove(&cleanup_request_id);
    });

    Ok(LocalProxyStartResponse { request_id })
}

#[tauri::command]
pub fn pure_tavern_local_cancel_request(
    state: State<'_, LocalServerState>,
    request_id: String,
) -> Result<(), String> {
    if !is_valid_request_id(&request_id) {
        return Err("A valid desktop local backend request ID is required.".to_owned());
    }
    state.runtime.cancel(&request_id);
    Ok(())
}

async fn run_proxy_request(
    client: Client,
    window: WebviewWindow,
    mut request: PreparedRequest,
) -> Result<(), ProxyFailure> {
    let mut redirect_count = 0usize;
    loop {
        let mut builder = client
            .request(request.method.clone(), request.url.clone())
            .headers(request.headers.clone())
            .header(ACCEPT_ENCODING, "identity");
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        let response = builder.send().await.map_err(|_| ProxyFailure::Network)?;
        let status = response.status();

        if is_redirect(status) {
            if let Some(location) = response.headers().get(LOCATION) {
                if redirect_count >= MAX_REDIRECTS {
                    return Err(ProxyFailure::Protocol);
                }
                let location = location.to_str().map_err(|_| ProxyFailure::Protocol)?;
                let target = request
                    .url
                    .join(location)
                    .map_err(|_| ProxyFailure::Protocol)?;
                if !is_safe_url(&target) {
                    return Err(ProxyFailure::Protocol);
                }
                apply_redirect(&mut request, target, status);
                redirect_count += 1;
                continue;
            }
        }

        if status.as_u16() < 200 {
            return Err(ProxyFailure::Protocol);
        }
        let status_text = status.canonical_reason().unwrap_or_default().to_owned();
        let response_headers = filtered_response_headers(response.headers());
        emit_event(
            &window,
            LocalProxyEvent::Headers {
                request_id: request.request_id.clone(),
                status: status.as_u16(),
                status_text,
                headers: response_headers,
            },
        )?;

        if response_has_no_body(status) {
            emit_event(
                &window,
                LocalProxyEvent::Complete {
                    request_id: request.request_id,
                },
            )?;
            return Ok(());
        }

        let mut sequence = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(item) = stream.next().await {
            let bytes = item.map_err(|_| ProxyFailure::Network)?;
            for chunk in bytes.chunks(CHUNK_SIZE) {
                emit_event(
                    &window,
                    LocalProxyEvent::Chunk {
                        request_id: request.request_id.clone(),
                        sequence,
                        data: BASE64_STANDARD.encode(chunk),
                    },
                )?;
                sequence = sequence.checked_add(1).ok_or(ProxyFailure::Protocol)?;
            }
        }
        emit_event(
            &window,
            LocalProxyEvent::Complete {
                request_id: request.request_id,
            },
        )?;
        return Ok(());
    }
}

fn prepare_request(request: LocalProxyRequest) -> Result<PreparedRequest, &'static str> {
    if !is_valid_request_id(&request.request_id) {
        return Err("A valid desktop local backend request ID is required.");
    }
    let url = Url::parse(&request.url).map_err(|_| "The provider URL is invalid.")?;
    if !is_safe_url(&url) {
        return Err(
            "The provider URL must be absolute HTTP or HTTPS without credentials or a fragment.",
        );
    }
    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        _ => return Err("Only GET and POST provider requests are supported."),
    };
    if method == Method::GET && request.body.is_some() {
        return Err("GET provider requests must not contain a body.");
    }
    let headers = prepare_request_headers(request.headers)?;
    Ok(PreparedRequest {
        request_id: request.request_id,
        url,
        method,
        headers,
        body: request.body.map(String::into_bytes),
    })
}

fn prepare_request_headers(headers: BTreeMap<String, String>) -> Result<HeaderMap, &'static str> {
    if headers.len() > MAX_HEADERS {
        return Err("The provider request contains too many headers.");
    }
    let connection_tokens = raw_connection_tokens(&headers);
    let mut prepared = HeaderMap::new();
    for (name, value) in headers {
        if name.is_empty() || name.len() > MAX_HEADER_NAME_LENGTH {
            return Err("The provider request contains an invalid header.");
        }
        if value.len() > MAX_HEADER_VALUE_LENGTH {
            return Err("The provider request contains an invalid header.");
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "The provider request contains an invalid header.")?;
        let header_value = HeaderValue::from_str(&value)
            .map_err(|_| "The provider request contains an invalid header.")?;
        let normalized = header_name.as_str();
        if is_blocked_request_header(normalized) || connection_tokens.contains(normalized) {
            continue;
        }
        prepared.insert(header_name, header_value);
    }
    Ok(prepared)
}

fn raw_connection_tokens(headers: &BTreeMap<String, String>) -> HashSet<String> {
    let mut result = HashSet::new();
    for (name, value) in headers {
        if name.eq_ignore_ascii_case(CONNECTION.as_str()) && value.len() <= MAX_HEADER_VALUE_LENGTH
        {
            add_connection_tokens(&mut result, value);
        }
    }
    result
}

fn response_connection_tokens(headers: &HeaderMap) -> HashSet<String> {
    let mut result = HashSet::new();
    for value in headers.get_all(CONNECTION) {
        if let Ok(value) = value.to_str() {
            add_connection_tokens(&mut result, value);
        }
    }
    result
}

fn add_connection_tokens(target: &mut HashSet<String>, value: &str) {
    for token in value.split(',') {
        let token = token.trim().to_ascii_lowercase();
        if !token.is_empty() {
            target.insert(token);
        }
    }
}

fn filtered_response_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    let connection_tokens = response_connection_tokens(headers);
    let mut result = BTreeMap::new();
    for name in headers.keys() {
        if result.len() >= MAX_HEADERS {
            break;
        }
        let normalized = name.as_str();
        if is_blocked_response_header(normalized)
            || connection_tokens.contains(normalized)
            || normalized.starts_with("access-control-")
        {
            continue;
        }
        let values = headers
            .get_all(name)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect::<Vec<_>>();
        if values.is_empty() {
            continue;
        }
        let joined = values.join(", ");
        if joined.len() <= MAX_HEADER_VALUE_LENGTH {
            result.insert(normalized.to_owned(), joined);
        }
    }
    result
}

fn apply_redirect(request: &mut PreparedRequest, target: Url, status: StatusCode) {
    if !same_origin(&request.url, &target) {
        remove_headers(&mut request.headers, SENSITIVE_REDIRECT_HEADERS);
    }
    if request.method == Method::POST
        && matches!(
            status,
            StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND | StatusCode::SEE_OTHER
        )
    {
        request.method = Method::GET;
        request.body = None;
        remove_headers(&mut request.headers, ENTITY_HEADERS);
    }
    request.url = target;
}

fn remove_headers(headers: &mut HeaderMap, names: &[&str]) {
    for name in names {
        headers.remove(*name);
    }
}

fn is_safe_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| !host.is_empty())
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn is_valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_blocked_request_header(name: &str) -> bool {
    BLOCKED_REQUEST_HEADERS.contains(&name)
}

fn is_blocked_response_header(name: &str) -> bool {
    BLOCKED_RESPONSE_HEADERS.contains(&name)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme().eq_ignore_ascii_case(right.scheme())
        && left.host_str().map(str::to_ascii_lowercase)
            == right.host_str().map(str::to_ascii_lowercase)
        && left.port_or_known_default() == right.port_or_known_default()
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

fn response_has_no_body(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::NO_CONTENT | StatusCode::RESET_CONTENT | StatusCode::NOT_MODIFIED
    )
}

fn emit_event(window: &WebviewWindow, event: LocalProxyEvent) -> Result<(), ProxyFailure> {
    window
        .emit(RESPONSE_EVENT, event)
        .map_err(|_| ProxyFailure::Event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, COOKIE};

    fn raw_request(
        url: &str,
        method: &str,
        headers: BTreeMap<String, String>,
        body: Option<&str>,
    ) -> LocalProxyRequest {
        LocalProxyRequest {
            request_id: "request-1".to_owned(),
            url: url.to_owned(),
            method: method.to_owned(),
            headers,
            body: body.map(str::to_owned),
        }
    }

    #[test]
    fn serializes_bridge_events_with_the_shared_camel_case_contract() {
        let event = LocalProxyEvent::Headers {
            request_id: "request-1".to_owned(),
            status: 200,
            status_text: "OK".to_owned(),
            headers: BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
        };

        let value = serde_json::to_value(event).expect("serializable event");

        assert_eq!(value["type"], "headers");
        assert_eq!(value["requestId"], "request-1");
        assert_eq!(value["statusText"], "OK");
        assert!(value.get("request_id").is_none());
        assert!(value.get("status_text").is_none());
    }

    #[test]
    fn bounds_active_requests_and_clears_abort_handles() {
        let state = LocalServerState::new().expect("HTTP client");
        for index in 0..MAX_ACTIVE_REQUESTS {
            let (handle, _) = AbortHandle::new_pair();
            state
                .runtime
                .register(&format!("request-{index}"), handle)
                .expect("request slot");
        }
        let (overflow_handle, _) = AbortHandle::new_pair();
        assert!(state
            .runtime
            .register("request-overflow", overflow_handle)
            .is_err());

        state.cancel_all();

        assert!(state.runtime.requests().is_empty());
    }

    #[test]
    fn validates_request_boundaries_and_filters_transport_headers() {
        let request = prepare_request(raw_request(
            "https://provider.example/v1/chat",
            "POST",
            BTreeMap::from([
                ("Authorization".to_owned(), "Bearer secret".to_owned()),
                ("Connection".to_owned(), "X-Client-Hop".to_owned()),
                ("X-Client-Hop".to_owned(), "remove".to_owned()),
                ("Content-Length".to_owned(), "999".to_owned()),
                ("Host".to_owned(), "attacker.example".to_owned()),
                ("Content-Type".to_owned(), "application/json".to_owned()),
            ]),
            Some("{}"),
        ))
        .expect("valid request");

        assert_eq!(
            request
                .headers
                .get(AUTHORIZATION)
                .and_then(|v| v.to_str().ok()),
            Some("Bearer secret")
        );
        assert_eq!(
            request
                .headers
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/json")
        );
        assert!(!request.headers.contains_key("host"));
        assert!(!request.headers.contains_key("content-length"));
        assert!(!request.headers.contains_key("x-client-hop"));

        assert!(prepare_request(raw_request(
            "file:///tmp/provider",
            "GET",
            BTreeMap::new(),
            None,
        ))
        .is_err());
        assert!(prepare_request(raw_request(
            "https://user:pass@example.com",
            "GET",
            BTreeMap::new(),
            None,
        ))
        .is_err());
        assert!(prepare_request(raw_request(
            "https://example.com/#fragment",
            "GET",
            BTreeMap::new(),
            None,
        ))
        .is_err());
        assert!(prepare_request(raw_request(
            "https://example.com/",
            "DELETE",
            BTreeMap::new(),
            None,
        ))
        .is_err());
        assert!(prepare_request(raw_request(
            "https://example.com/",
            "GET",
            BTreeMap::new(),
            Some("body"),
        ))
        .is_err());
    }

    #[test]
    fn strips_sensitive_and_entity_headers_on_cross_origin_post_redirect() {
        let mut request = prepare_request(raw_request(
            "https://first.example/start",
            "POST",
            BTreeMap::from([
                ("Authorization".to_owned(), "Bearer secret".to_owned()),
                ("Cookie".to_owned(), "private=value".to_owned()),
                ("Content-Type".to_owned(), "application/json".to_owned()),
                ("X-Provider".to_owned(), "kept".to_owned()),
            ]),
            Some("{}"),
        ))
        .expect("valid request");

        apply_redirect(
            &mut request,
            Url::parse("https://second.example/final").expect("target URL"),
            StatusCode::FOUND,
        );

        assert_eq!(request.method, Method::GET);
        assert!(request.body.is_none());
        assert!(!request.headers.contains_key(AUTHORIZATION));
        assert!(!request.headers.contains_key(COOKIE));
        assert!(!request.headers.contains_key(CONTENT_TYPE));
        assert_eq!(
            request
                .headers
                .get("x-provider")
                .and_then(|v| v.to_str().ok()),
            Some("kept")
        );
    }

    #[test]
    fn preserves_post_body_and_authorization_on_same_origin_307() {
        let mut request = prepare_request(raw_request(
            "https://provider.example/start",
            "POST",
            BTreeMap::from([
                ("Authorization".to_owned(), "Bearer secret".to_owned()),
                ("Content-Type".to_owned(), "application/json".to_owned()),
            ]),
            Some("{}"),
        ))
        .expect("valid request");

        apply_redirect(
            &mut request,
            Url::parse("https://provider.example/final").expect("target URL"),
            StatusCode::TEMPORARY_REDIRECT,
        );

        assert_eq!(request.method, Method::POST);
        assert_eq!(request.body.as_deref(), Some(b"{}".as_slice()));
        assert!(request.headers.contains_key(AUTHORIZATION));
        assert!(request.headers.contains_key(CONTENT_TYPE));
    }

    #[test]
    fn filters_response_cookie_cors_and_connection_named_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
        headers.insert("set-cookie", HeaderValue::from_static("private=value"));
        headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
        headers.insert(CONNECTION, HeaderValue::from_static("X-Upstream-Hop"));
        headers.insert("x-upstream-hop", HeaderValue::from_static("remove"));
        headers.insert("x-provider", HeaderValue::from_static("kept"));

        let filtered = filtered_response_headers(&headers);

        assert_eq!(
            filtered.get("content-type").map(String::as_str),
            Some("text/event-stream")
        );
        assert_eq!(filtered.get("x-provider").map(String::as_str), Some("kept"));
        assert!(!filtered.contains_key("set-cookie"));
        assert!(!filtered.contains_key("access-control-allow-origin"));
        assert!(!filtered.contains_key("x-upstream-hop"));
    }
}
