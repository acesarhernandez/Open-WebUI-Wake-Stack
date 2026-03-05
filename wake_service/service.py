from __future__ import annotations

import json
import logging
import socket
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

from .config import WakeConfig

LOGGER = logging.getLogger("wake_service.service")


class UiState(str, Enum):
    IDLE = "idle"
    WAKING = "waking"
    HOST_ONLINE = "host_online"
    ONLINE = "online"
    TIMEOUT = "timeout"
    ERROR = "error"


@dataclass
class WakeSnapshot:
    ui_state: str = UiState.IDLE.value
    engine_state: str = "offline"
    current_request_id: Optional[str] = None
    last_wake_attempt_at: Optional[datetime] = None
    last_host_online_at: Optional[datetime] = None
    last_successful_wake_at: Optional[datetime] = None
    last_failed_wake_at: Optional[datetime] = None
    last_failure_reason: Optional[str] = None
    last_reachable_at: Optional[datetime] = None
    last_latency_ms: Optional[float] = None
    wake_started_at: Optional[datetime] = None


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat_or_none(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def generate_request_id(now: Optional[datetime] = None) -> str:
    current = now or utc_now()
    return "wake_{stamp}_{suffix}".format(
        stamp=current.strftime("%Y%m%dT%H%M%SZ"),
        suffix=uuid4().hex[:6],
    )


def _normalize_mac_address(mac_address: str) -> str:
    normalized = (
        mac_address.replace(":", "")
        .replace("-", "")
        .replace(".", "")
        .strip()
        .lower()
    )
    if len(normalized) != 12:
        raise ValueError("MAC address must contain 12 hexadecimal characters")

    int(normalized, 16)
    return normalized


def build_magic_packet(mac_address: str) -> bytes:
    normalized = _normalize_mac_address(mac_address)
    mac_bytes = bytes.fromhex(normalized)
    return (b"\xff" * 6) + (mac_bytes * 16)


class EngineControlConfigError(RuntimeError):
    pass


class EngineControlRequestError(RuntimeError):
    pass


class WakeService:
    def __init__(self, config: WakeConfig) -> None:
        self.config = config
        self._lock = threading.RLock()
        self._snapshot = WakeSnapshot()
        self._poll_thread: Optional[threading.Thread] = None
        self._log_startup()

    def _log_startup(self) -> None:
        self._log(
            logging.INFO,
            "startup",
            state=self._snapshot.ui_state,
            details={
                "bind": "{host}:{port}".format(
                    host=self.config.bind_host,
                    port=self.config.bind_port,
                ),
                "engine": "{host}:{port}".format(
                    host=self.config.engine_host,
                    port=self.config.engine_ollama_port,
                ),
                "wake_timeout_seconds": self.config.engine_wake_timeout_seconds,
                "poll_interval_seconds": self.config.engine_status_poll_interval_seconds,
                "engine_control_url": self.config.engine_control_url or None,
                "engine_control_proxy_configured": self.config.engine_control_is_configured,
                "feature_flags": self.config.feature_flags_payload(),
                "versions": self.config.version_payload(),
            },
        )

    def _log(
        self,
        level: int,
        event: str,
        request_id: Optional[str] = None,
        state: Optional[str] = None,
        error: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        message = event.replace("_", " ")
        LOGGER.log(
            level,
            message,
            extra={
                "component": "wake-service",
                "event": event,
                "target": self.config.engine_name,
                "request_id": request_id,
                "state": state,
                "error": error,
                "details": details,
            },
        )

    @staticmethod
    def _map_engine_state(ui_state: str) -> str:
        if ui_state == UiState.WAKING.value:
            return "waking"
        if ui_state == UiState.HOST_ONLINE.value:
            return "host_online"
        if ui_state == UiState.ONLINE.value:
            return "online"
        return "offline"

    def _transition_locked(
        self,
        new_ui_state: str,
        request_id: Optional[str],
        error: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        previous_ui_state = self._snapshot.ui_state
        previous_engine_state = self._snapshot.engine_state
        next_engine_state = self._map_engine_state(new_ui_state)

        self._snapshot.ui_state = new_ui_state
        self._snapshot.engine_state = next_engine_state

        if previous_ui_state != new_ui_state or previous_engine_state != next_engine_state:
            self._log(
                logging.INFO,
                "status_changed",
                request_id=request_id,
                state="{old_ui}/{old_engine}->{new_ui}/{new_engine}".format(
                    old_ui=previous_ui_state,
                    old_engine=previous_engine_state,
                    new_ui=new_ui_state,
                    new_engine=next_engine_state,
                ),
                error=error,
                details=details,
            )

    @staticmethod
    def _extract_engine_control_error(raw_body: bytes) -> str:
        text = raw_body.decode("utf-8", "replace").strip()
        if not text:
            return ""

        try:
            payload = json.loads(text)
        except (TypeError, ValueError):
            return text

        for key in ("detail", "message", "error"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        return text

    def _engine_control_wake_endpoint(self) -> str:
        if not self.config.engine_control_is_configured:
            raise EngineControlConfigError(
                "Engine control proxy is not configured. "
                "Set ENGINE_CONTROL_URL and ENGINE_CONTROL_API_KEY."
            )

        return self.config.engine_control_url.rstrip("/") + "/v1/engine/wake"

    def _send_engine_control_wake(self) -> str:
        endpoint = self._engine_control_wake_endpoint()
        request = Request(endpoint, method="POST")
        request.add_header(
            "Authorization",
            "Bearer {token}".format(token=self.config.engine_control_api_key),
        )
        request.add_header("Accept", "application/json")

        try:
            with urlopen(
                request,
                timeout=self.config.engine_connect_timeout_seconds,
            ) as response:
                response.read()
        except HTTPError as exc:
            detail = self._extract_engine_control_error(exc.read())
            if detail:
                raise EngineControlRequestError(
                    "Engine control server returned HTTP {code}: {detail}".format(
                        code=exc.code,
                        detail=detail,
                    )
                ) from exc
            raise EngineControlRequestError(
                "Engine control server returned HTTP {code}".format(code=exc.code)
            ) from exc
        except (URLError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise EngineControlRequestError(
                "Engine control server request failed: {error}".format(error=reason)
            ) from exc

        return endpoint

    def _probe_engine(self) -> Tuple[bool, bool, Optional[float], Optional[str]]:
        start = time.perf_counter()
        try:
            with socket.create_connection(
                (self.config.engine_host, self.config.engine_ollama_port),
                timeout=self.config.engine_connect_timeout_seconds,
            ):
                latency_ms = round((time.perf_counter() - start) * 1000, 2)
                return True, True, latency_ms, None
        except ConnectionRefusedError as exc:
            latency_ms = round((time.perf_counter() - start) * 1000, 2)
            return True, False, latency_ms, str(exc)
        except OSError as exc:
            return False, False, None, str(exc)

    def _refresh_state(self) -> Tuple[bool, bool, Optional[float], Optional[str]]:
        host_reachable, ollama_reachable, latency_ms, probe_error = self._probe_engine()
        now = utc_now()

        with self._lock:
            request_id = self._snapshot.current_request_id

            if ollama_reachable:
                transitioned_to_online = self._snapshot.ui_state != UiState.ONLINE.value
                self._snapshot.last_host_online_at = now
                self._snapshot.last_reachable_at = now
                self._snapshot.last_latency_ms = latency_ms
                self._snapshot.last_failure_reason = None
                if self._snapshot.ui_state != UiState.ONLINE.value:
                    self._transition_locked(
                        UiState.ONLINE.value,
                        request_id=request_id,
                        details={"latency_ms": latency_ms},
                    )
                if transitioned_to_online and self._snapshot.last_wake_attempt_at:
                    self._snapshot.last_successful_wake_at = now
                return True, True, latency_ms, None

            if host_reachable:
                self._snapshot.last_host_online_at = now
                if latency_ms is not None:
                    self._snapshot.last_latency_ms = latency_ms
                self._snapshot.last_failure_reason = "Host is online, waiting for Ollama"
                if self._snapshot.ui_state != UiState.HOST_ONLINE.value:
                    self._transition_locked(
                        UiState.HOST_ONLINE.value,
                        request_id=request_id,
                        details={"latency_ms": latency_ms},
                    )
                return True, False, latency_ms, probe_error

            if (
                self._snapshot.ui_state in {UiState.WAKING.value, UiState.HOST_ONLINE.value}
                and self._snapshot.wake_started_at is not None
            ):
                elapsed = (now - self._snapshot.wake_started_at).total_seconds()
                if elapsed >= self.config.engine_wake_timeout_seconds:
                    if self._snapshot.ui_state == UiState.HOST_ONLINE.value:
                        reason = (
                            "Host woke up, but Ollama did not respond within "
                            "{seconds} seconds".format(
                                seconds=self.config.engine_wake_timeout_seconds
                            )
                        )
                    else:
                        reason = (
                            "Wake packet sent, but the host did not respond within "
                            "{seconds} seconds".format(
                                seconds=self.config.engine_wake_timeout_seconds
                            )
                        )
                    self._snapshot.last_failed_wake_at = now
                    self._snapshot.last_failure_reason = reason
                    self._transition_locked(
                        UiState.TIMEOUT.value,
                        request_id=request_id,
                        error=reason,
                    )
                    self._log(
                        logging.WARNING,
                        "wake_timeout",
                        request_id=request_id,
                        state=self._snapshot.ui_state,
                        error=reason,
                    )
            elif self._snapshot.ui_state in {
                UiState.ONLINE.value,
                UiState.HOST_ONLINE.value,
            }:
                self._transition_locked(
                    UiState.IDLE.value,
                    request_id=request_id,
                    error=probe_error,
                )

            if probe_error and self._snapshot.ui_state != UiState.IDLE.value:
                self._log(
                    logging.INFO,
                    "engine_probe_failed",
                    request_id=request_id,
                    state=self._snapshot.ui_state,
                    error=probe_error,
                )

        return False, False, None, probe_error

    def _poll_until_ready(self, request_id: str) -> None:
        self._log(
            logging.INFO,
            "status_poll_started",
            request_id=request_id,
            state=UiState.WAKING.value,
        )

        while True:
            with self._lock:
                if self._snapshot.current_request_id != request_id:
                    return
                if self._snapshot.ui_state in {
                    UiState.ONLINE.value,
                    UiState.TIMEOUT.value,
                    UiState.ERROR.value,
                }:
                    return

            self._refresh_state()

            with self._lock:
                if self._snapshot.ui_state in {
                    UiState.ONLINE.value,
                    UiState.TIMEOUT.value,
                    UiState.ERROR.value,
                }:
                    return

            time.sleep(self.config.engine_status_poll_interval_seconds)

    def _start_poll_thread(self, request_id: str) -> None:
        self._poll_thread = threading.Thread(
            target=self._poll_until_ready,
            args=(request_id,),
            daemon=True,
            name="wake-engine-poll",
        )
        self._poll_thread.start()

    def trigger_wake(self, target: str) -> Dict[str, Any]:
        if target != self.config.engine_name:
            raise ValueError(
                "Unsupported target '{target}'. Expected '{expected}'.".format(
                    target=target,
                    expected=self.config.engine_name,
                )
            )

        self._engine_control_wake_endpoint()

        with self._lock:
            if self._snapshot.ui_state in {
                UiState.WAKING.value,
                UiState.HOST_ONLINE.value,
            }:
                self._log(
                    logging.WARNING,
                    "wake_request_rejected",
                    request_id=self._snapshot.current_request_id,
                    state=self._snapshot.ui_state,
                    error="wake already in progress",
                )
                return {
                    "accepted": False,
                    "request_id": self._snapshot.current_request_id,
                    "state": self._snapshot.ui_state,
                    "message": "Wake request already in progress",
                }

            request_id = generate_request_id()
            now = utc_now()
            self._snapshot.current_request_id = request_id
            self._snapshot.last_wake_attempt_at = now
            self._snapshot.wake_started_at = now
            self._snapshot.last_failure_reason = None
            self._transition_locked(UiState.WAKING.value, request_id=request_id)

        self._log(
            logging.INFO,
            "wake_request_received",
            request_id=request_id,
            state=UiState.WAKING.value,
        )

        try:
            endpoint = self._send_engine_control_wake()
            self._log(
                logging.INFO,
                "wake_request_sent",
                request_id=request_id,
                state=UiState.WAKING.value,
                details={"engine_control_url": endpoint},
            )
        except EngineControlRequestError as exc:
            reason = str(exc)
            with self._lock:
                self._snapshot.last_failed_wake_at = utc_now()
                self._snapshot.last_failure_reason = reason
                self._transition_locked(
                    UiState.ERROR.value,
                    request_id=request_id,
                    error=reason,
                )
            self._log(
                logging.ERROR,
                "wake_request_error",
                request_id=request_id,
                state=UiState.ERROR.value,
                error=reason,
            )
            raise

        self._start_poll_thread(request_id)
        return {
            "accepted": True,
            "request_id": request_id,
            "state": UiState.WAKING.value,
            "message": "Wake request sent to engine control server",
        }

    def get_status(self) -> Dict[str, Any]:
        self._refresh_state()
        with self._lock:
            return {
                "state": self._snapshot.engine_state,
                "ui_state": self._snapshot.ui_state,
                "request_id": self._snapshot.current_request_id,
            }

    def get_health(self) -> Dict[str, Any]:
        host_reachable, ollama_reachable, latency_ms, probe_error = self._refresh_state()
        with self._lock:
            return {
                "service_healthy": True,
                "engine_state": self._snapshot.engine_state,
                "ui_state": self._snapshot.ui_state,
                "host_reachable": host_reachable,
                "ollama_reachable": ollama_reachable,
                "last_wake_attempt_at": isoformat_or_none(
                    self._snapshot.last_wake_attempt_at
                ),
                "last_host_online_at": isoformat_or_none(
                    self._snapshot.last_host_online_at
                ),
                "last_successful_wake_at": isoformat_or_none(
                    self._snapshot.last_successful_wake_at
                ),
                "last_failed_wake_at": isoformat_or_none(
                    self._snapshot.last_failed_wake_at
                ),
                "last_failure_reason": self._snapshot.last_failure_reason or probe_error,
                "last_reachable_at": isoformat_or_none(self._snapshot.last_reachable_at),
                "last_latency_ms": latency_ms or self._snapshot.last_latency_ms,
                "current_request_id": self._snapshot.current_request_id,
                "wake_timeout_seconds": self.config.engine_wake_timeout_seconds,
                "feature_flags": self.config.feature_flags_payload(),
                "versions": self.config.version_payload(),
            }

    def get_diagnostics(self) -> Dict[str, Any]:
        return {
            "service_name": "wake-service",
            "engine": {
                "name": self.config.engine_name,
                "host": self.config.engine_host,
                "port": self.config.engine_ollama_port,
                "broadcast_ip": self.config.engine_broadcast_ip,
                "control_url": self.config.engine_control_url or None,
                "control_proxy_configured": self.config.engine_control_is_configured,
            },
            "feature_flags": self.config.feature_flags_payload(),
            "versions": self.config.version_payload(),
        }
