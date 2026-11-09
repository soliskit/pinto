"""Capture one frozen baseline case. A capture is not a qualification verdict."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import time

case, engine, output = sys.argv[1:]
expected_ids = {
    '188-500': '188.fallback-detail',
    '188-abort': '188.fallback-detail',
    '168-pending': '168.pending-mute-disabled',
    '168-abort': '168.preservation-mute-disabled',
    '168-invalid-json': '168.preservation-mute-disabled',
    '168-500-text': '168.preservation-mute-disabled',
}
if case not in expected_ids or engine not in ('chromium', 'webkit'):
    raise RuntimeError('explicit bounded case/engine required')
out = Path(output).resolve()
out.mkdir(exist_ok=False)
receipt = {'case': case, 'engine': engine, 'classification': 'INCOMPLETE',
           'nativeExit': None, 'signals': [], 'errors': [],
           'directChildReaped': False, 'processGroupAbsent': False,
           'qualification': 'NOT_QUALIFIED: manual oracle/resource attribution required'}
child = None
old_handlers = {}
started = time.monotonic()


def interrupt(sig, frame):
    receipt['signals'].append(sig)


def exists():
    if child is None:
        return False
    try:
        os.killpg(child.pid, 0)
        return True
    except ProcessLookupError:
        return False


def send(sig):
    try:
        os.killpg(child.pid, sig)
    except ProcessLookupError:
        pass


def settle():
    if child is None:
        return
    if child.poll() is None or exists():
        send(signal.SIGTERM)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and (child.poll() is None or exists()):
            time.sleep(0.05)
        if child.poll() is None or exists():
            send(signal.SIGKILL)
    try:
        receipt['nativeExit'] = child.wait(timeout=5)
        receipt['directChildReaped'] = True
    except subprocess.TimeoutExpired:
        receipt['errors'].append('direct child not reaped within 5s KILL bound')
    receipt['processGroupAbsent'] = not exists()
    if not receipt['processGroupAbsent']:
        receipt['errors'].append('owned process group remains observed')


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


try:
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        old_handlers[sig] = signal.signal(sig, interrupt)
    require(not receipt['signals'], 'interrupted before launch')
    env = {k: v for k, v in os.environ.items() if not k.startswith('NODE_')}
    env.update(PINTO_ATTRIBUTION_CASE=case, PINTO_BROWSER=engine,
               TWILIO_ACCOUNT_SID='', TWILIO_AUTH_TOKEN='', KEY='',
               PINTO_RESOURCE_RECEIPT=str(out / 'resources.jsonl'))
    node = shutil.which('node')
    require(node is not None, 'node unavailable')
    node_digest = hashlib.sha256(Path(node).read_bytes()).hexdigest()
    receipt['nodePath'] = node
    receipt['nodeSha256'] = node_digest
    require(node_digest == '0adde40d1b7dfa57c8bc83cbc319758c3ec6ebba21363bb2fa752ea6b267ad1b', 'runtime hash mismatch')
    with (out / 'test.tap').open('xb') as stdout, (out / 'test.stderr').open('xb') as stderr:
        child = subprocess.Popen([
            node, '--test', '--test-reporter=tap', '--test-timeout=90000',
            'test/focused-evidence/baseline-attribution.test.ts'
        ], env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
           start_new_session=True)
        receipt['pid'] = child.pid
        deadline = time.monotonic() + 100
        try:
            while child.poll() is None:
                require(not receipt['signals'], 'interrupted while active')
                if time.monotonic() >= deadline:
                    raise TimeoutError('100s outer bound reached')
                time.sleep(0.05)
            require(not exists(), 'owned group persists after direct-child exit')
        finally:
            settle()
    require(hashlib.sha256(Path(node).read_bytes()).hexdigest() == node_digest, 'postflight runtime drift')
    raw = (out / 'test.tap').read_bytes()
    stderr = (out / 'test.stderr').read_bytes()
    receipt['tapSha256'] = hashlib.sha256(raw).hexdigest()
    receipt['stderrSha256'] = hashlib.sha256(stderr).hexdigest()
    tap = raw.decode('utf8')
    require(not stderr, 'stderr nonempty')
    require(re.findall(r'^1\.\.1$', tap, re.MULTILINE) == ['1..1'], 'missing single-case TAP plan')
    summary = {}
    for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'):
        values = re.findall(r'^# ' + key + r' (\d+)$', tap, re.MULTILINE)
        require(len(values) == 1, 'missing or duplicated TAP summary: ' + key)
        summary[key] = int(values[0])
    receipt['tapSummary'] = summary
    require(summary['tests'] == 1 and summary['pass'] + summary['fail'] == 1
            and all(summary[k] == 0 for k in ('cancelled', 'skipped', 'todo')),
            'incomplete TAP summary')
    require(receipt['nativeExit'] in (0, 1), 'abnormal native exit')
    require((receipt['nativeExit'] == 0) == (summary['fail'] == 0), 'native/TAP disagreement')
    rows = []
    for line in tap.splitlines():
        if line.startswith('# {"phaseEvidence":'):
            rows.append(json.loads(line[2:])['phaseEvidence'])
    require(len(rows) == 1, 'missing or duplicate phase receipt')
    phase = rows[0]
    receipt['phaseEvidence'] = phase
    require(phase['schema'] == 1 and phase['case'] == case and phase['mode'] == case
            and phase['engine'] == engine and phase['arm'] == 'baseline', 'phase identity mismatch')
    for cleanup in ('contextClose', 'browserClose', 'serverStop'):
        require(phase['phases'][cleanup]['state'] == 'completed'
                and phase['phases'][cleanup]['error'] is None, 'cleanup not complete: ' + cleanup)
    require(receipt['directChildReaped'] and receipt['processGroupAbsent'], 'process settlement incomplete')
    if receipt['nativeExit'] == 0:
        require(phase['phases']['operation']['state'] == 'completed', 'success/phase disagreement')
        receipt['classification'] = 'UNEXPECTED_PASS_NONREPRODUCTION'
    else:
        operation = phase['phases']['operation']
        require(phase['assertionReached'] and phase['assertionId'] == expected_ids[case],
                'wrong or unreached selected assertion')
        require(operation['state'] == 'failed', 'failure/phase disagreement')
        error = operation['error']
        require(error.get('name') == 'AssertionError' and error.get('code') == 'ERR_ASSERTION',
                'selected failure is not a direct AssertionError')
        if case.startswith('188-'):
            require(error.get('actual') == 'server-error: '
                    and error.get('expected') == 'server-error: No further error details are available.',
                    'detail expected/actual mismatch differs from selected oracle')
        else:
            require(error.get('actual') is False and error.get('expected') is True,
                    'disabled-state mismatch differs from selected oracle')
        receipt['classification'] = 'SELECTED_NEGATIVE_CAPTURED_NOT_QUALIFIED'
except BaseException as error:
    receipt['errors'].append(type(error).__name__ + ': ' + str(error))
finally:
    if child is not None and not receipt['directChildReaped']:
        try:
            settle()
        except BaseException as error:
            receipt['errors'].append('settlement: ' + type(error).__name__)
    if receipt['signals'] or receipt['errors']:
        receipt['classification'] = 'INCOMPLETE'
    receipt['elapsedSeconds'] = round(time.monotonic() - started, 3)
    try:
        with (out / 'capture.json').open('x') as stream:
            json.dump(receipt, stream, indent=2)
            stream.write('\n')
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
print(json.dumps(receipt))
sys.exit(0 if receipt['classification'] == 'SELECTED_NEGATIVE_CAPTURED_NOT_QUALIFIED' else 1)
