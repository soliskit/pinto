"""Bounded manual-only diagnostic. All subprocess output stays runner-local."""

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

TARGETS = {
    "dependency": "5bce64236564b992ad66574afeb3b0033f3d286b",
    "base": "663d115427e47444a316b588a6ba9014d82d2e95",
}
FILES = [
    "test/room.test.ts",
    "test/room-join-edges.test.ts",
    "test/video-width.test.ts",
    "test/pinch-zoom.test.ts",
    "test/contrast.test.ts",
    "test/config-timings-edges.test.ts",
]
PROTECTED = [
    *FILES,
    "public/room.js",
    "package.json",
    "package-lock.json",
    ".github/mutation-ranges.json",
    ".github/scripts/run-tests-first-fail.mjs",
    ".github/scripts/reporter-v2.mjs",
    ".github/scripts/write-shard-config.mjs",
]


def api(path):
    token = os.environ.pop("DIAGNOSTIC_API_TOKEN")
    try:
        req = urllib.request.Request(
            "https://api.github.com/repos/soliskit/pinto/" + path,
            headers={
                "Authorization": "Bearer " + token,
                "Accept": "application/vnd.github+json",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    finally:
        os.environ["DIAGNOSTIC_API_TOKEN"] = token


def check_remote():
    repo = api("")
    if repo.get("private") is not False or repo.get("visibility") != "public":
        raise RuntimeError("zero-cost-refused")
    if api("git/ref/heads/main")["object"]["sha"] != TARGETS["base"]:
        raise RuntimeError("drift-refused")
    pr = api("pulls/346")
    if (
        pr["state"] != "open"
        or pr["head"]["sha"] != TARGETS["dependency"]
        or pr["base"]["sha"] != TARGETS["base"]
    ):
        raise RuntimeError("drift-refused")


def run_owned(args, source, env, log, timeout, deadline=None):
    remaining = (
        timeout if deadline is None else min(timeout, deadline - time.monotonic())
    )
    if remaining <= 0:
        raise subprocess.TimeoutExpired(args, 0)
    process = subprocess.Popen(
        args, cwd=source, env=env, stdout=log, stderr=log, start_new_session=True
    )
    try:
        return process.wait(timeout=remaining)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        raise
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def finish(root, source, helper, env, log, outcome, code, cleanup):
    # This reserve is independent of the exhausted work deadline.
    out = root / "export" / "summary.json"
    result = run_owned(
        [
            "node",
            str(helper / "pinto-diagnostic-export.mjs"),
            str(root / "capture"),
            str(out),
            outcome,
            str(code if 0 <= code <= 255 else 2),
            str(cleanup).lower(),
        ],
        source,
        env,
        log,
        30,
    )
    if result != 0:
        print("diagnostic-capture-refused", flush=True)
        return 2
    print("diagnostic-" + outcome, flush=True)
    return code if 0 <= code <= 255 else 2


def main():
    role = os.environ["DIAGNOSTIC_ROLE"]
    target = TARGETS[role]
    if os.environ["DIAGNOSTIC_TARGET"] != target:
        return 2
    source = Path(os.environ["GITHUB_WORKSPACE"]) / "target"
    helper = Path(__file__).resolve().parent
    root = Path(os.environ["RUNNER_TEMP"]) / ("pinto-diagnostic-" + role)
    root.mkdir(mode=0o700)
    capture = root / "capture"
    capture.mkdir(mode=0o700)
    ledger = root / "ledger"
    ledger.mkdir(mode=0o700)
    env = os.environ.copy()
    env.update(
        {
            "DIAGNOSTIC_CAPTURE_DIR": str(capture),
            "FIRST_FAIL_LEDGER_DIR": str(ledger),
            "GITHUB_SHA": target,
            "FIRST_FAIL_SHARD": "room-1-107-b",
            "FIRST_FAIL_RUN_ID": f"diagnostic-{env['GITHUB_RUN_ID']}-{role}",
        }
    )
    for key in [
        "DIAGNOSTIC_API_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "ACTIONS_RUNTIME_TOKEN",
    ]:
        env.pop(key, None)
    outcome, code, cleanup = "setup-failed", 2, False
    deadline = time.monotonic() + 2580
    with (root / "private.log").open("wb") as log:

        def run(args, timeout=600, extra=None):
            return run_owned(args, source, env | (extra or {}), log, timeout, deadline)

        try:
            check_remote()

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=source, stderr=log)

            assert git("rev-parse", "HEAD").decode().strip() == target
            assert not git("status", "--porcelain")
            for file in PROTECTED:
                assert (source / file).read_bytes() == git("show", target + ":" + file)
            matrix = json.loads((source / ".github/mutation-ranges.json").read_text())[
                "include"
            ]
            shard = next(x for x in matrix if x["shard"] == "room-1-107-b")
            assert (
                shard["tests"].split() == FILES
                and shard["mutate"] == "public/room.js:29-110"
                and shard["mutators"] == ["StringLiteral"]
                and shard["browser"] == "chromium"
                and shard["timeout"] == 45
            )
            assert (
                json.loads((source / "package.json").read_text())["engines"]["node"]
                == "26.13.0"
            )
            for command in [
                ["npm", "ci"],
                [
                    "sudo",
                    "sed",
                    "-i",
                    "/azure\\.archive\\.ubuntu\\.com/d",
                    "/etc/apt/apt-mirrors.txt",
                ],
                ["npx", "playwright", "install", "--with-deps", "chromium"],
                [
                    "node",
                    "-e",
                    "process.exit(require('playwright/package.json').version==='1.65.1'?0:1)",
                ],
                [
                    "npm",
                    "install",
                    "--prefix",
                    str(root / "mutation-tools"),
                    "--no-save",
                    "--no-audit",
                    "--no-fund",
                    "@stryker-mutator/instrumenter@10.1.1",
                ],
            ]:
                if run(command) != 0:
                    raise RuntimeError("setup-failed")
            for file in PROTECTED:
                assert (source / file).read_bytes() == git("show", target + ":" + file)
            (source / ".github/scripts/pinto-diagnostic-reporter.mjs").write_bytes(
                (helper / "pinto-diagnostic-reporter.mjs").read_bytes()
            )
            env["INSTRUMENTER_PREFIX"] = str(root / "mutation-tools")
            config = root / "stryker.shard.json"
            if (
                run(
                    [
                        "node",
                        ".github/scripts/write-shard-config.mjs",
                        "room-1-107-b",
                        str(config),
                    ]
                )
                != 0
            ):
                raise RuntimeError("setup-failed")
            check_remote()
            command = (
                'exec env FIRST_FAIL_REPORTER_OVERRIDE="$PWD/.github/scripts/pinto-diagnostic-reporter.mjs" node .github/scripts/run-tests-first-fail.mjs -- --test-timeout=120000 '
                + " ".join(FILES)
            )
            code = run(
                [
                    "npx",
                    "--yes",
                    "@stryker-mutator/core@10.1.1",
                    "run",
                    str(config),
                    "--ignorePatterns",
                    "tsconfig.json,tsconfig.client.json",
                    "--testRunner",
                    "command",
                    "--commandRunner.command",
                    command,
                    "--mutate",
                    "public/room.js:29-110",
                    "--reporters",
                    "clear-text,json",
                    "--coverageAnalysis",
                    "off",
                    "--concurrency",
                    "1",
                    "--timeoutMS",
                    "120000",
                    "--dryRunOnly",
                ],
                timeout=2400,
            )
            terminals = list(ledger.glob("*.terminal.json"))
            starts = list(ledger.glob("*.start.json"))
            assert len(terminals) == len(starts) == 1
            terminal = json.loads(terminals[0].read_text())
            start = json.loads(starts[0].read_text())
            for record in [terminal, start]:
                assert (
                    record["head"] == target
                    and record["runId"] == env["FIRST_FAIL_RUN_ID"]
                    and record["shard"] == "room-1-107-b"
                    and record["mutantId"] == "__dry_run__"
                )
            assert terminal["invocationId"] == start["invocationId"]
            assert terminal.get("mode") == (
                "all-passed" if code == 0 else "stopped-at-first-failure"
            )
            cleanup = (
                terminal.get("clean") is True
                and terminal.get("handshake") is True
                and terminal.get("error") is None
            )
            assert cleanup
            outcome = (
                "all-passed"
                if code == 0
                else "failure"
                if (capture / "failure.json").is_file()
                else "capture-refused"
            )
        except subprocess.TimeoutExpired:
            outcome, code = "interrupted", 2
        except BaseException as error:
            outcome, code = (
                str(error)
                if str(error) in ["drift-refused", "zero-cost-refused"]
                else "setup-failed",
                2,
            )
        return finish(root, source, helper, env, log, outcome, code, cleanup)


if __name__ == "__main__":
    try:
        result = main()
    except BaseException:
        print("diagnostic-refused", flush=True)
        result = 2
    sys.exit(result)
