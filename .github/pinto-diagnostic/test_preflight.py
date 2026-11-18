import importlib.util
import io
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("diagnostic", ROOT / "run-diagnostic.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RequestPreflightTests(unittest.TestCase):
    def test_actual_requests_use_fixed_canonical_public_urls_without_authentication(
        self,
    ):
        for path in ["", "git/ref/heads/main", "pulls/346"]:
            with (
                self.subTest(path=path),
                patch.object(module.urllib.request, "urlopen") as open_mock,
            ):
                open_mock.return_value.__enter__.return_value = io.BytesIO(
                    b'{"public":true}'
                )
                self.assertEqual(module.api(path), {"public": True})
                request = open_mock.call_args.args[0]
                self.assertEqual(
                    request.full_url,
                    "https://api.github.com/repos/soliskit/pinto"
                    + ("/" + path if path else ""),
                )
                self.assertFalse(request.has_header("Authorization"))
                self.assertEqual(open_mock.call_args.kwargs["timeout"], 30)

    def test_unlisted_request_paths_never_reach_network(self):
        with patch.object(module.urllib.request, "urlopen") as open_mock:
            for path in ["/", "../secrets", "pulls/347", "https://example.invalid"]:
                with self.assertRaises(ValueError):
                    module.api(path)
            open_mock.assert_not_called()

    def test_actual_http_error_mapping_is_closed_and_has_no_body_or_url(self):
        for status, expected in [
            (401, "http-401"),
            (403, "http-403"),
            (404, "http-404"),
            (429, "http-429"),
            (500, "http-5xx"),
            (503, "http-5xx"),
            (418, "http-other"),
        ]:
            error = urllib.error.HTTPError(
                "https://SYNTHETIC_SECRET.invalid",
                status,
                "SYNTHETIC_SECRET",
                {},
                io.BytesIO(b"SYNTHETIC_SECRET"),
            )
            with (
                self.subTest(status=status),
                patch.object(module.urllib.request, "urlopen", side_effect=error),
                self.assertRaises(urllib.error.HTTPError) as raised,
            ):
                module.api("")
            value = module.classify(raised.exception)
            self.assertEqual(value, expected)
            self.assertNotIn("SYNTHETIC_SECRET", value)

    def test_network_timeout_assertion_io_unknown_are_fixed(self):
        for error, expected in [
            (urllib.error.URLError("SYNTHETIC_SECRET"), "network"),
            (TimeoutError("SYNTHETIC_SECRET"), "timeout"),
            (AssertionError("SYNTHETIC_SECRET"), "assertion"),
            (OSError("SYNTHETIC_SECRET"), "local-io"),
            (ValueError("SYNTHETIC_SECRET"), "unknown"),
        ]:
            self.assertEqual(module.classify(error), expected)

    def test_actual_remote_progression_identifies_each_request_stage(self):
        responses = [
            {"visibility": "public", "private": False},
            {"object": {"sha": module.TARGETS["base"]}},
            {
                "state": "open",
                "head": {"sha": module.TARGETS["dependency"]},
                "base": {"sha": module.TARGETS["base"]},
            },
        ]
        for index, stage in enumerate(["remote-repo", "remote-main", "remote-pr"]):
            error = urllib.error.HTTPError(
                "private-url", 404, "private-message", {}, None
            )
            values = [io.BytesIO(json.dumps(x).encode()) for x in responses[:index]]

            def response(*args, values=values, error=error, **kwargs):
                if values:
                    context = unittest.mock.MagicMock()
                    context.__enter__.return_value = values.pop(0)
                    return context
                raise error

            with (
                patch.object(module.urllib.request, "urlopen", side_effect=response),
                self.assertRaises(urllib.error.HTTPError),
            ):
                module.check_remote()
            self.assertEqual(module.STAGE, stage)

    def test_real_exporter_cli_preserves_safe_stage_and_refuses_forged_stage(self):
        for stage, expected, malformed in [
            ("remote-repo", "remote-repo", False),
            ("remote-pr", "remote-pr", True),
            ("SYNTHETIC_SECRET", "unknown", False),
        ]:
            with tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp)
                capture = root / "capture"
                capture.mkdir()
                if malformed:
                    (capture / "failure.json").write_bytes(b"\xffSYNTHETIC_SECRET")
                env = os.environ | {
                    "DIAGNOSTIC_TARGET": module.TARGETS["dependency"],
                    "DIAGNOSTIC_ROLE": "dependency",
                    "GITHUB_RUN_ID": "123",
                    "GITHUB_RUN_ATTEMPT": "1",
                }
                out = root / "export/summary.json"
                result = subprocess.run(
                    [
                        "node",
                        str(ROOT / "pinto-diagnostic-export.mjs"),
                        str(capture),
                        str(out),
                        "setup-failed",
                        "2",
                        "false",
                        stage,
                        "http-404",
                    ],
                    env=env,
                    capture_output=True,
                    text=True,
                )
                summary = json.loads(out.read_text())
                self.assertEqual(summary["setupStage"], expected)
                self.assertEqual(summary["setupError"], "http-404")
                self.assertIsNone(summary["failure"])
                self.assertFalse(summary["cleanupConfirmed"])
                self.assertNotIn(
                    "SYNTHETIC_SECRET",
                    json.dumps(summary) + result.stdout + result.stderr,
                )
                self.assertEqual(
                    result.returncode,
                    2 if malformed or stage == "SYNTHETIC_SECRET" else 0,
                )


if __name__ == "__main__":
    unittest.main()
