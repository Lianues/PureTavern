from __future__ import annotations

import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

REMOTE_BACKEND_PROTOCOL = "pure-tavern-generation-proxy"
REMOTE_BACKEND_PROTOCOL_VERSION = 1
PROXY_HEADER = "X-Pure-Tavern-Proxy"
PROXY_ERROR_HEADER = "X-Pure-Tavern-Proxy-Error"

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
REQUEST_BLOCKED_HEADERS = HOP_BY_HOP_HEADERS | {"content-length", "host"}
RESPONSE_BLOCKED_HEADERS = HOP_BY_HOP_HEADERS | {
    "content-length",
    "set-cookie",
    "set-cookie2",
}


@dataclass(frozen=True, slots=True)
class Settings:
    access_key: str
    allowed_origins: tuple[str, ...] = ("*",)

    @classmethod
    def from_environment(cls) -> Settings:
        return cls(
            access_key=os.getenv("PURE_TAVERN_PROXY_KEY", "").strip(),
            allowed_origins=parse_allowed_origins(
                os.getenv("PURE_TAVERN_ALLOWED_ORIGINS", "*")
            ),
        )


class ProxyTargetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str
    method: Literal["GET", "POST"]
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | None = None

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("Target URL must be an absolute HTTP or HTTPS URL.")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("Target URL must not contain embedded credentials.")
        if parsed.fragment:
            raise ValueError("Target URL must not contain a fragment.")
        return value

    @model_validator(mode="after")
    def validate_body(self) -> ProxyTargetRequest:
        if self.method == "GET" and self.body is not None:
            raise ValueError("GET proxy requests must not contain a body.")
        return self


class ProxyEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocol: Literal[REMOTE_BACKEND_PROTOCOL]
    protocolVersion: Literal[REMOTE_BACKEND_PROTOCOL_VERSION]
    request: ProxyTargetRequest


def parse_allowed_origins(value: str) -> tuple[str, ...]:
    origins = tuple(part.strip() for part in value.split(",") if part.strip())
    if not origins or "*" in origins:
        return ("*",)
    return origins


def create_app(
    settings: Settings | None = None,
    *,
    upstream_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings.from_environment()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        if not resolved_settings.access_key:
            raise RuntimeError(
                "PURE_TAVERN_PROXY_KEY is required before the remote backend can start."
            )
        timeout = httpx.Timeout(connect=15.0, read=None, write=60.0, pool=15.0)
        async with httpx.AsyncClient(
            transport=upstream_transport,
            timeout=timeout,
            follow_redirects=True,
            trust_env=False,
        ) as upstream_client:
            application.state.upstream_client = upstream_client
            yield

    application = FastAPI(
        title="PureTavern Remote Backend",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved_settings.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=[PROXY_HEADER, PROXY_ERROR_HEADER, "Content-Type"],
        max_age=600,
    )

    @application.middleware("http")
    async def allow_private_network_preflight(request: Request, call_next):
        response = await call_next(request)
        if request.headers.get("access-control-request-private-network") == "true":
            response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response

    def require_access_key(
        authorization: Annotated[str | None, Header()] = None,
    ) -> None:
        scheme, separator, supplied_key = (authorization or "").partition(" ")
        valid = (
            separator == " "
            and scheme.lower() == "bearer"
            and bool(supplied_key)
            and secrets.compare_digest(supplied_key, resolved_settings.access_key)
        )
        if not valid:
            raise HTTPException(
                status_code=401,
                detail="Invalid remote backend access key.",
                headers={
                    **proxy_headers("authentication"),
                    "WWW-Authenticate": "Bearer",
                },
            )

    @application.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _request: Request, _error: RequestValidationError
    ) -> JSONResponse:
        # Pydantic's default error body can repeat rejected input. Keep provider keys and
        # request bodies out of validation responses and server logs.
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "invalid-proxy-request",
                    "message": "The proxy request does not match protocol version 1.",
                }
            },
            headers=proxy_headers("request"),
        )

    @application.get("/v1/health")
    async def health(_authorized: None = Depends(require_access_key)) -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "service": "pure-tavern-remote-backend",
                "protocol": REMOTE_BACKEND_PROTOCOL,
                "protocolVersion": REMOTE_BACKEND_PROTOCOL_VERSION,
            },
            headers=proxy_headers(),
        )

    @application.post("/v1/proxy")
    async def proxy(
        envelope: ProxyEnvelope,
        request: Request,
        _authorized: None = Depends(require_access_key),
    ) -> StreamingResponse:
        target = envelope.request
        headers = filter_request_headers(target.headers)
        content = target.body.encode("utf-8") if target.body is not None else None
        upstream_client: httpx.AsyncClient = request.app.state.upstream_client
        try:
            upstream_request = upstream_client.build_request(
                target.method,
                target.url,
                headers=headers,
                content=content,
            )
            upstream_response = await upstream_client.send(
                upstream_request,
                stream=True,
            )
        except (httpx.InvalidURL, ValueError) as error:
            raise HTTPException(
                status_code=422,
                detail="The upstream target URL is invalid.",
                headers=proxy_headers("request"),
            ) from error
        except httpx.RequestError as error:
            raise HTTPException(
                status_code=502,
                detail="The remote backend could not reach the upstream provider.",
                headers=proxy_headers("upstream"),
            ) from error

        response_headers = filter_response_headers(upstream_response.headers)
        response_headers.update(proxy_headers())
        return StreamingResponse(
            stream_upstream(upstream_response),
            status_code=upstream_response.status_code,
            headers=response_headers,
        )

    return application


def proxy_headers(error: str | None = None) -> dict[str, str]:
    headers = {PROXY_HEADER: "1"}
    if error is not None:
        headers[PROXY_ERROR_HEADER] = error
    return headers


def filter_request_headers(headers: dict[str, str]) -> dict[str, str]:
    return {
        name: value
        for name, value in headers.items()
        if name.lower() not in REQUEST_BLOCKED_HEADERS
    }


def filter_response_headers(headers: httpx.Headers) -> dict[str, str]:
    return {
        name: value
        for name, value in headers.items()
        if name.lower() not in RESPONSE_BLOCKED_HEADERS
        and not name.lower().startswith("access-control-")
    }


async def stream_upstream(response: httpx.Response) -> AsyncIterator[bytes]:
    try:
        async for chunk in response.aiter_raw():
            yield chunk
    finally:
        await response.aclose()


app = create_app()
