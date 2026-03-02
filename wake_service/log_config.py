from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: Dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "message": record.getMessage(),
        }

        for field_name in (
            "component",
            "event",
            "target",
            "request_id",
            "state",
            "error",
            "details",
        ):
            value = getattr(record, field_name, None)
            if value not in (None, ""):
                payload[field_name] = value

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, separators=(",", ":"))


def configure_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.setLevel(level)
    root_logger.addHandler(handler)
