from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class WakeRequest(BaseModel):
    target: Optional[str] = Field(default=None)


class WakeResponse(BaseModel):
    accepted: bool
    request_id: Optional[str] = None
    state: str
    message: str


class EngineStatusResponse(BaseModel):
    state: str
    ui_state: str
    request_id: Optional[str] = None


class EngineHealthResponse(BaseModel):
    service_healthy: bool
    engine_state: str
    ui_state: str
    host_reachable: bool
    ollama_reachable: bool
    last_wake_attempt_at: Optional[str] = None
    last_host_online_at: Optional[str] = None
    last_successful_wake_at: Optional[str] = None
    last_failed_wake_at: Optional[str] = None
    last_failure_reason: Optional[str] = None
    last_reachable_at: Optional[str] = None
    last_latency_ms: Optional[float] = None
    current_request_id: Optional[str] = None
    wake_timeout_seconds: int
    feature_flags: Dict[str, bool]
    versions: Dict[str, str]


class DiagnosticsResponse(BaseModel):
    service_name: str
    engine: Dict[str, Any]
    feature_flags: Dict[str, bool]
    versions: Dict[str, str]
