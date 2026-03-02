from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, List

from . import DEFAULT_WAKE_SERVICE_VERSION


def parse_bool(value: str, default: bool) -> bool:
    if value is None:
        return default

    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _parse_csv(value: str) -> List[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass(frozen=True)
class WakeConfig:
    bind_host: str = "0.0.0.0"
    bind_port: int = 8787
    engine_name: str = "gaming-pc"
    engine_mac: str = "00:00:00:00:00:00"
    engine_broadcast_ip: str = "255.255.255.255"
    engine_host: str = "127.0.0.1"
    engine_ollama_port: int = 11434
    engine_connect_timeout_seconds: float = 2.0
    engine_wake_timeout_seconds: int = 180
    engine_status_poll_interval_seconds: float = 5.0
    enable_wake_header: bool = True
    wake_api_token: str = ""
    allowed_origins: List[str] = field(default_factory=list)
    wake_service_version: str = DEFAULT_WAKE_SERVICE_VERSION
    openwebui_upstream_version: str = "unknown"
    custom_patch_version: str = "wake1"
    build_sha: str = "dev"
    build_date: str = "unknown"

    @classmethod
    def from_env(cls) -> "WakeConfig":
        return cls(
            bind_host=os.getenv("WAKE_BIND_HOST", "0.0.0.0"),
            bind_port=int(os.getenv("WAKE_BIND_PORT", "8787")),
            engine_name=os.getenv("ENGINE_NAME", "gaming-pc"),
            engine_mac=os.getenv("ENGINE_MAC", "00:00:00:00:00:00"),
            engine_broadcast_ip=os.getenv("ENGINE_BROADCAST_IP", "255.255.255.255"),
            engine_host=os.getenv("ENGINE_HOST", "127.0.0.1"),
            engine_ollama_port=int(os.getenv("ENGINE_OLLAMA_PORT", "11434")),
            engine_connect_timeout_seconds=float(
                os.getenv("ENGINE_CONNECT_TIMEOUT_SECONDS", "2")
            ),
            engine_wake_timeout_seconds=int(
                os.getenv("ENGINE_WAKE_TIMEOUT_SECONDS", "180")
            ),
            engine_status_poll_interval_seconds=float(
                os.getenv("ENGINE_STATUS_POLL_INTERVAL_SECONDS", "5")
            ),
            enable_wake_header=parse_bool(
                os.getenv("ENABLE_WAKE_HEADER", "true"),
                default=True,
            ),
            wake_api_token=os.getenv("WAKE_API_TOKEN", ""),
            allowed_origins=_parse_csv(os.getenv("WAKE_API_ALLOWED_ORIGINS", "")),
            wake_service_version=os.getenv(
                "WAKE_SERVICE_VERSION",
                DEFAULT_WAKE_SERVICE_VERSION,
            ),
            openwebui_upstream_version=os.getenv(
                "OPENWEBUI_UPSTREAM_VERSION",
                "unknown",
            ),
            custom_patch_version=os.getenv("CUSTOM_PATCH_VERSION", "wake1"),
            build_sha=os.getenv("BUILD_SHA", "dev"),
            build_date=os.getenv("BUILD_DATE", "unknown"),
        )

    def version_payload(self) -> Dict[str, str]:
        return {
            "wake_service": self.wake_service_version,
            "openwebui_upstream": self.openwebui_upstream_version,
            "custom_patch": self.custom_patch_version,
            "build_sha": self.build_sha,
            "build_date": self.build_date,
        }

    def feature_flags_payload(self) -> Dict[str, bool]:
        return {"enable_wake_header": self.enable_wake_header}
