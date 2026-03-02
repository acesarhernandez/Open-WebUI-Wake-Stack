from __future__ import annotations

from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware

from .config import WakeConfig
from .log_config import configure_logging
from .models import (
    DiagnosticsResponse,
    EngineHealthResponse,
    EngineStatusResponse,
    WakeRequest,
    WakeResponse,
)
from .service import WakeService

configure_logging()
CONFIG = WakeConfig.from_env()
SERVICE = WakeService(CONFIG)

app = FastAPI(
    title="Open WebUI Wake Service",
    version=CONFIG.wake_service_version,
)

if CONFIG.allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CONFIG.allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


def verify_api_token(
    authorization: Optional[str] = Header(default=None),
    x_api_token: Optional[str] = Header(default=None),
) -> None:
    if not CONFIG.wake_api_token:
        return

    bearer_prefix = "Bearer "
    token = x_api_token or ""
    if authorization and authorization.startswith(bearer_prefix):
        token = authorization[len(bearer_prefix) :]

    if token != CONFIG.wake_api_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Wake API token is invalid",
        )


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.post("/api/wake-engine", response_model=WakeResponse)
def wake_engine(
    payload: WakeRequest,
    _: None = Depends(verify_api_token),
) -> WakeResponse:
    try:
        response = SERVICE.trigger_wake(payload.target or CONFIG.engine_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return WakeResponse(**response)


@app.get("/api/engine-status", response_model=EngineStatusResponse)
def engine_status(_: None = Depends(verify_api_token)) -> EngineStatusResponse:
    return EngineStatusResponse(**SERVICE.get_status())


@app.get("/api/engine-health", response_model=EngineHealthResponse)
def engine_health(_: None = Depends(verify_api_token)) -> EngineHealthResponse:
    return EngineHealthResponse(**SERVICE.get_health())


@app.get("/api/custom/diag", response_model=DiagnosticsResponse)
def custom_diag(_: None = Depends(verify_api_token)) -> DiagnosticsResponse:
    return DiagnosticsResponse(**SERVICE.get_diagnostics())
