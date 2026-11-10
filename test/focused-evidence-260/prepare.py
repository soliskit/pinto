# Private authoring draft. No project file reads or writes have been executed by this script.
from pathlib import Path
import hashlib, json, sys
app, source = map(lambda x: Path(x).resolve(), sys.argv[1:])
bundle = source / 'test/focused-evidence-260'
EXPECTED = {'proposal-resources.ts': '4a5376e98f0bb98ed88ffb5b6b87b7c4d59be7ab39f3c6f8c972355b7339eeca', 'resource-receipt.ts': '1025239889050c084f583e30ce415688e3843e8de698171c54d953db87ff238b', 'control-targets.test.ts': '105c0afdc5f5cf0f2df64bb8969180cbeaf29a0bbf537e543469132bb1c25ce1', 'peer-log-lines.test.ts': '60d44afd38b311e61c16784c86932cb84d91c23f804c9641cea53fe3f4ec77b3', 'peer-error-detail.test.ts': 'a40a451497b4d71e3ce176d1b4f604fd7913ceec75d3053f9fcb6fb13bf2449a', 'config-readiness.test.ts': '9a04d16b352876d9b2a62ce068c659f11091c30853a26312e8cc791d2b201a5d', 'helpers.ts': 'd4c5e3d496cb3cc56f115fcae6d7dc01fd19a5d1bdedbcc2be0df86634b338fa'}
# Scope is a publication parameter, not selected by untrusted message content.
# Only one is supplied per independent candidate; whitespace is rejected.
scope = (bundle / 'scope.txt').read_text()
choices = {'260': 'control-targets.test.ts', '132': 'peer-log-lines.test.ts', '188': 'peer-error-detail.test.ts', '168': 'config-readiness.test.ts'}
if scope != __import__('os').environ['SCOPE']: raise SystemExit('Workflow scope mismatch')
if scope not in choices: raise SystemExit('Invalid scope bytes')
for name, expected in EXPECTED.items():
    data = (bundle / name).read_bytes()
    if hashlib.sha256(data).hexdigest() != expected: raise SystemExit('Fixture hash mismatch: ' + name)
# Verify the dependency inputs have not changed relative to the pinned base.
# App-source diff must be reviewed separately; this is not implementation-authority proof.
import subprocess
for name in ['package.json', 'package-lock.json']:
    pinned = subprocess.check_output(['git', '-C', str(source), 'show', '0987484ca6d620bf463897a44cab264ecfd75b46:' + name])
    if (app / name).read_bytes() != pinned: raise SystemExit('Dependency drift: ' + name)
for name in [choices[scope], 'proposal-resources.ts', 'resource-receipt.ts', 'helpers.ts']:
    target = app / 'test' / name
    target.write_bytes((bundle / name).read_bytes())
receipts = app.parent / 'receipts'
(receipts / 'testfile.txt').write_text('test/' + choices[scope] + '\n')
(receipts / 'fixture-inventory.json').write_text(json.dumps(EXPECTED, sort_keys=True) + '\n')
