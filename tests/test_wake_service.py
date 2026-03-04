import os
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from wake_service.config import WakeConfig, parse_bool
from wake_service.service import (
    EngineControlConfigError,
    WakeService,
    build_magic_packet,
    generate_request_id,
)


class _FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return b'{"ok":true}'


class WakeServiceHelpersTest(unittest.TestCase):
    def test_parse_bool_understands_common_truthy_and_falsy_values(self) -> None:
        self.assertTrue(parse_bool("true", False))
        self.assertTrue(parse_bool("1", False))
        self.assertFalse(parse_bool("false", True))
        self.assertFalse(parse_bool("0", True))

    def test_build_magic_packet_has_expected_size(self) -> None:
        packet = build_magic_packet("AA:BB:CC:DD:EE:FF")
        self.assertEqual(len(packet), 102)
        self.assertEqual(packet[:6], b"\xff" * 6)

    def test_generate_request_id_uses_expected_prefix(self) -> None:
        fixed = datetime(2026, 3, 1, 12, 0, 0, tzinfo=timezone.utc)
        request_id = generate_request_id(now=fixed)
        self.assertTrue(request_id.startswith("wake_20260301T120000Z_"))

    def test_config_reads_env_overrides(self) -> None:
        previous = os.environ.copy()
        try:
            os.environ["ENABLE_WAKE_HEADER"] = "false"
            os.environ["ENGINE_NAME"] = "custom-box"
            os.environ["ENGINE_CONTROL_URL"] = "http://engine.local/"
            os.environ["ENGINE_CONTROL_API_KEY"] = "secret"
            os.environ["WAKE_API_ALLOWED_ORIGINS"] = "http://localhost:3000,http://localhost:8080"
            config = WakeConfig.from_env()
            self.assertFalse(config.enable_wake_header)
            self.assertEqual(config.engine_name, "custom-box")
            self.assertEqual(config.engine_control_url, "http://engine.local")
            self.assertEqual(config.engine_control_api_key, "secret")
            self.assertTrue(config.engine_control_is_configured)
            self.assertEqual(
                config.allowed_origins,
                ["http://localhost:3000", "http://localhost:8080"],
            )
        finally:
            os.environ.clear()
            os.environ.update(previous)

    def test_trigger_wake_requires_engine_control_config(self) -> None:
        service = WakeService(WakeConfig(engine_name="gaming-pc"))

        with self.assertRaises(EngineControlConfigError):
            service.trigger_wake("gaming-pc")

    def test_trigger_wake_calls_engine_control_server(self) -> None:
        service = WakeService(
            WakeConfig(
                engine_name="gaming-pc",
                engine_control_url="http://engine.local/",
                engine_control_api_key="secret",
            )
        )

        with patch("wake_service.service.urlopen", return_value=_FakeResponse()) as mock_urlopen:
            with patch.object(service, "_start_poll_thread") as mock_poll_thread:
                response = service.trigger_wake("gaming-pc")

        request = mock_urlopen.call_args.args[0]
        headers = dict(request.header_items())

        self.assertEqual(request.full_url, "http://engine.local/v1/engine/wake")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(headers["Authorization"], "Bearer secret")
        self.assertEqual(headers["Accept"], "application/json")
        self.assertTrue(response["accepted"])
        self.assertEqual(response["state"], "waking")
        mock_poll_thread.assert_called_once_with(response["request_id"])


if __name__ == "__main__":
    unittest.main()
