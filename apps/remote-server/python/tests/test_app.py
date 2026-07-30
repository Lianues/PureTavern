from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi.testclient import TestClient

from app import (
    PROXY_ERROR_HEADER,
    PROXY_HEADER,
    REMOTE_BACKEND_PROTOCOL,
    REMOTE_BACKEND_PROTOCOL_VERSION,
    Settings,
    create_app,
)

ACCESS_KEY = "test-remote-backend-key"
AUTHORIZATION = {"Authorization": f"Bearer {ACCESS_KEY}"}


class ChunkedStream(httpx.AsyncByteStream):
    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield b'data: {"delta":"one"}\n\n'
        yield b'data: {"delta":"two"}\n\n'


class JsonStream(httpx.AsyncByteStream):
    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield b'{"ok":true}'


@pytest.fixture
def settings() -> Settings:
    return Settings(
        access_key=ACCESS_KEY,
        allowed_origins=("http://127.0.0.1:8899",),
    )


def envelope(**request_overrides: object) -> dict[str, object]:
    target: dict[str, object] = {
        "url": "https://provider.example/v1/chat/completions?api-version=1",
        "method": "POST",
        "headers": {
            "Authorization": "Bearer provider-secret",
            "Content-Type": "application/json",
        },
        "body": '{"model":"test-model","stream":true}',
    }
    target.update(request_overrides)
    return {
        "protocol": REMOTE_BACKEND_PROTOCOL,
        "protocolVersion": REMOTE_BACKEND_PROTOCOL_VERSION,
        "request": target,
    }


def test_health_requires_the_configured_access_key(settings: Settings) -> None:
    application = create_app(settings, upstream_transport=httpx.MockTransport(lambda _: None))
    with TestClient(application) as client:
        missing = client.get("/v1/health")
        wrong = client.get("/v1/health", headers={"Authorization": "Bearer wrong"})
        healthy = client.get("/v1/health", headers=AUTHORIZATION)

    assert missing.status_code == 401
    assert missing.headers[PROXY_ERROR_HEADER] == "authentication"
    assert wrong.status_code == 401
    assert healthy.status_code == 200
    assert healthy.headers[PROXY_HEADER] == "1"
    assert healthy.json() == {
        "status": "ok",
        "service": "pure-tavern-remote-backend",
        "protocol": REMOTE_BACKEND_PROTOCOL,
        "protocolVersion": REMOTE_BACKEND_PROTOCOL_VERSION,
    }


def test_proxy_forwards_provider_request_and_streams_response(settings: Settings) -> None:
    captured: list[httpx.Request] = []

    async def upstream_handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            207,
            headers={
                "Content-Type": "text/event-stream; charset=utf-8",
                "Set-Cookie": "must-not-reach-browser=true",
                "Connection": "keep-alive",
            },
            stream=ChunkedStream(),
        )

    application = create_app(
        settings,
        upstream_transport=httpx.MockTransport(upstream_handler),
    )
    body = envelope(
        headers={
            "Authorization": "Bearer provider-secret",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://sillytavern.app",
            "X-Title": "SillyTavern",
            "api-key": "azure-provider-key",
            "x-api-key": "anthropic-provider-key",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "tools-2024-05-16",
            "Accept-Language": "en-US,en",
            "X-Provider": "preferred-provider",
            "X-Billing-Mode": "paygo",

            "Host": "attacker.example",
            "Connection": "upgrade",
            "Content-Length": "999999",
        }
    )
    with TestClient(application) as client:
        response = client.post("/v1/proxy", headers=AUTHORIZATION, json=body)

    assert response.status_code == 207
    assert response.headers[PROXY_HEADER] == "1"
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "set-cookie" not in response.headers
    assert response.text == 'data: {"delta":"one"}\n\ndata: {"delta":"two"}\n\n'
    assert len(captured) == 1
    upstream = captured[0]
    assert str(upstream.url) == (
        "https://provider.example/v1/chat/completions?api-version=1"
    )
    assert upstream.method == "POST"
    assert upstream.headers["authorization"] == "Bearer provider-secret"
    assert upstream.headers["http-referer"] == "https://sillytavern.app"
    assert upstream.headers["x-title"] == "SillyTavern"
    assert upstream.headers["api-key"] == "azure-provider-key"
    assert upstream.headers["x-api-key"] == "anthropic-provider-key"
    assert upstream.headers["anthropic-version"] == "2023-06-01"
    assert upstream.headers["anthropic-beta"] == "tools-2024-05-16"
    assert upstream.headers["accept-language"] == "en-US,en"
    assert upstream.headers["x-provider"] == "preferred-provider"
    assert upstream.headers["x-billing-mode"] == "paygo"

    assert upstream.headers["host"] == "provider.example"
    assert upstream.headers["content-length"] == str(
        len(b'{"model":"test-model","stream":true}')
    )
    assert upstream.content == b'{"model":"test-model","stream":true}'


def test_proxy_follows_upstream_redirects_without_forwarding_cross_origin_auth(
    settings: Settings,
) -> None:
    captured: list[httpx.Request] = []

    async def upstream_handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.host == "provider.example":
            return httpx.Response(
                307,
                headers={"Location": "https://redirected.example/final"},
            )
        return httpx.Response(
            200,
            headers={"Content-Type": "application/json"},
            stream=JsonStream(),
        )

    application = create_app(
        settings,
        upstream_transport=httpx.MockTransport(upstream_handler),
    )
    with TestClient(application) as client:
        response = client.post("/v1/proxy", headers=AUTHORIZATION, json=envelope())

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert [request.url.host for request in captured] == [
        "provider.example",
        "redirected.example",
    ]
    assert captured[0].headers["authorization"] == "Bearer provider-secret"
    assert "authorization" not in captured[1].headers


@pytest.mark.parametrize(
    "payload",
    [
        envelope(method="DELETE"),
        envelope(url="ftp://provider.example/model"),
        envelope(url="https://user:password@provider.example/model"),
        envelope(method="GET", body="must-not-have-a-body"),
        {
            **envelope(),
            "protocolVersion": 999,
            "providerSecret": "must-not-be-echoed",
        },
    ],
)
def test_invalid_proxy_requests_are_bounded_and_do_not_echo_input(
    settings: Settings,
    payload: dict[str, object],
) -> None:
    application = create_app(settings, upstream_transport=httpx.MockTransport(lambda _: None))
    with TestClient(application) as client:
        response = client.post("/v1/proxy", headers=AUTHORIZATION, json=payload)

    assert response.status_code == 422
    assert response.headers[PROXY_ERROR_HEADER] == "request"
    assert response.json()["error"]["code"] == "invalid-proxy-request"
    assert "must-not-be-echoed" not in response.text
    assert "provider-secret" not in response.text


def test_upstream_network_failures_return_a_safe_502(settings: Settings) -> None:
    async def failing_upstream(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("private network detail", request=request)

    application = create_app(
        settings,
        upstream_transport=httpx.MockTransport(failing_upstream),
    )
    with TestClient(application) as client:
        response = client.post("/v1/proxy", headers=AUTHORIZATION, json=envelope())

    assert response.status_code == 502
    assert response.headers[PROXY_ERROR_HEADER] == "upstream"
    assert "private network detail" not in response.text
    assert "provider-secret" not in response.text


def test_cors_and_private_network_preflight_for_configured_origin(
    settings: Settings,
) -> None:
    application = create_app(settings, upstream_transport=httpx.MockTransport(lambda _: None))
    with TestClient(application) as client:
        response = client.options(
            "/v1/proxy",
            headers={
                "Origin": "http://127.0.0.1:8899",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Authorization,Content-Type",
                "Access-Control-Request-Private-Network": "true",
            },
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:8899"
    assert response.headers["access-control-allow-private-network"] == "true"
    assert "authorization" in response.headers["access-control-allow-headers"].lower()


def test_missing_server_key_stops_application_startup() -> None:
    application = create_app(Settings(access_key=""))
    with pytest.raises(RuntimeError, match="PURE_TAVERN_PROXY_KEY"):
        with TestClient(application):
            pass
