"""Pure ASGI middleware."""

from __future__ import annotations

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class BodyLimitMiddleware:
    """Reject request bodies larger than ``max_bytes`` with 413 ``payload_too_large``.

    A declared ``Content-Length`` is checked up front. Without one (chunked uploads) the
    body is counted while the application reads it, so a client cannot make us buffer an
    unbounded amount of data by simply omitting the header."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared: int | None = None
        for name, value in scope["headers"]:
            if name == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    declared = None
                break
        if declared is not None:
            if declared > self.max_bytes:
                response = JSONResponse(
                    {"detail": "payload_too_large", "message": "Request body too large"},
                    status_code=413,
                )
                await response(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise HTTPException(413, "Request body too large")
            return message

        await self.app(scope, limited_receive, send)
