import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("diagnostic", ROOT / "run-diagnostic.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DiagnosticPreparationTests(unittest.TestCase):
    def state(self, private=False, main=None, head=None, base=None, state="open"):
        return {
            "": {"private": private, "visibility": "private" if private else "public"},
            "git/ref/heads/main": {"object": {"sha": main or module.TARGETS["base"]}},
            "pulls/346": {
                "state": state,
                "head": {"sha": head or module.TARGETS["dependency"]},
                "base": {"sha": base or module.TARGETS["base"]},
            },
        }

    def check(self, **kw):
        responses = self.state(**kw)
        with patch.object(module, "api", side_effect=lambda path: responses[path]):
            module.check_remote()

    def test_exact_public_fixed_pair_accepted(self):
        self.check()

    def test_private_refused_before_compute(self):
        with self.assertRaisesRegex(RuntimeError, "zero-cost-refused"):
            self.check(private=True)

    def test_both_targets_and_current_base_drift_refused(self):
        for field in ["main", "head", "base"]:
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(RuntimeError, "drift-refused"),
            ):
                self.check(**{field: "0" * 40})

    def test_closed_pr_refused(self):
        with self.assertRaisesRegex(RuntimeError, "drift-refused"):
            self.check(state="closed")

    def test_no_file_concurrency_override(self):
        source = (ROOT / "run-diagnostic.py").read_text().replace(chr(34), chr(39))
        self.assertNotIn("--test-concurrency", source)
        self.assertIn("'--dryRunOnly'", source)
        self.assertIn("'--concurrency','1'", "".join(source.split()))
        self.assertIn("'--timeoutMS','120000'", "".join(source.split()))
        self.assertEqual(len(module.FILES), 6)

    def test_workflow_fixed_allowlist_not_raw_tree(self):
        source = (ROOT.parent / "workflows/test.yml").read_text()
        self.assertIn("fail-fast: false", source)
        self.assertIn("max-parallel: 1", source)
        self.assertIn("timeout-minutes: 45", source)
        self.assertIn("retention-days: 3", source)
        self.assertIn("/export/summary.json", source)
        self.assertNotIn("path: reports", source)
        self.assertNotIn("pull_request:", source)
        self.assertNotIn("push:", source)
        self.assertEqual(source.count("persist-credentials: false"), 2)

    def test_source_verification_and_private_subprocess_streams(self):
        source = (ROOT / "run-diagnostic.py").read_text().replace(chr(34), chr(39))
        self.assertIn("git('show', target + ':' + file)", source)
        self.assertIn("env.pop(key, None)", source)
        self.assertIn(
            "stdout=log,stderr=log,start_new_session=True", "".join(source.split())
        )
        self.assertIn("os.killpg(process.pid, signal.SIGKILL)", source)
        self.assertIn("'GITHUB_SHA': target", source)
        for key in [
            "DIAGNOSTIC_API_TOKEN",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "ACTIONS_RUNTIME_TOKEN",
        ]:
            self.assertIn(repr(key), source)

    def exercise_finish(self, malformed=False, expired=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "capture").mkdir()
            env = os.environ.copy()
            env.update(
                {
                    "DIAGNOSTIC_TARGET": module.TARGETS["dependency"],
                    "DIAGNOSTIC_ROLE": "dependency",
                    "GITHUB_RUN_ID": "123",
                    "GITHUB_RUN_ATTEMPT": "1",
                }
            )
            if malformed:
                (root / "capture/failure.json").write_bytes(
                    b"\xffINVALID_SYNTHETIC_SECRET"
                )
            with (root / "private.log").open("wb") as log:
                if expired:
                    with self.assertRaises(subprocess.TimeoutExpired):
                        module.run_owned(
                            [
                                sys.executable,
                                "-c",
                                'raise RuntimeError("must not spawn")',
                            ],
                            root,
                            env,
                            log,
                            1,
                            time.monotonic() - 1,
                        )
                outcome = "interrupted" if expired else "failure"
                result = module.finish(root, root, ROOT, env, log, outcome, 2, False)
            self.assertEqual(result, 2)
            summary = json.loads((root / "export/summary.json").read_text())
            self.assertEqual(
                summary["outcome"], "capture-refused" if malformed else "interrupted"
            )
            self.assertFalse(summary["cleanupConfirmed"])
            self.assertIsNone(summary["failure"])
            self.assertNotIn("SYNTHETIC_SECRET", json.dumps(summary))

    def test_actual_exhausted_work_deadline_still_exports_typed_interruption(self):
        self.exercise_finish(expired=True)

    def test_actual_malformed_capture_exports_fixed_refusal_not_bad_bytes(self):
        self.exercise_finish(malformed=True)

    def test_actual_timeout_terminates_owned_command_and_reaps_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            pid = root / "pid"
            code = (
                "import os,time,pathlib;pathlib.Path("
                + repr(str(pid))
                + ").write_text(str(os.getpid()));time.sleep(10)"
            )
            with (
                (root / "log").open("wb") as log,
                self.assertRaises(subprocess.TimeoutExpired),
            ):
                module.run_owned(
                    [sys.executable, "-c", code], root, os.environ.copy(), log, 0.2
                )
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid.read_text()), 0)


if __name__ == "__main__":
    unittest.main()
