import os
import unittest
from datetime import datetime, timezone

from wake_service.config import WakeConfig, parse_bool
from wake_service.service import build_magic_packet, generate_request_id


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
            os.environ["WAKE_API_ALLOWED_ORIGINS"] = "http://localhost:3000,http://localhost:8080"
            config = WakeConfig.from_env()
            self.assertFalse(config.enable_wake_header)
            self.assertEqual(config.engine_name, "custom-box")
            self.assertEqual(
                config.allowed_origins,
                ["http://localhost:3000", "http://localhost:8080"],
            )
        finally:
            os.environ.clear()
            os.environ.update(previous)


if __name__ == "__main__":
    unittest.main()
