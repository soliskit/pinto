"""Export only bounded known evidence files into standard GitHub job logs.
No artifact/cache upload. A partial export is INCOMPLETE, never a qualification.
"""
import base64
import hashlib
import json
from pathlib import Path
import sys

root = Path('receipts').resolve()
roots = {'identity.txt', 'tracked-only.diff', 'node.txt', 'npm.txt', 'install.log',
         'input-inventory.json', 'qualification.txt', 'attempted-cases.txt',
         'executed-inputs.sha256'}
cases = {'188-500', '188-abort', '168-pending', '168-abort', '168-invalid-json', '168-500-text'}
case_files = {'test.tap', 'test.stderr', 'resources.jsonl', 'capture.json'}
files = []
try:
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise RuntimeError('symlink in receipt directory')
        if path.is_dir():
            if path.parent != root or path.name not in cases:
                raise RuntimeError('unexpected receipt directory')
            continue
        rel = path.relative_to(root)
        parts = rel.parts
        allowed = ((len(parts) == 1 and (path.name in roots or path.name in {c + '-supervisor.json' for c in cases}))
                   or (len(parts) == 2 and parts[0] in cases and parts[1] in case_files))
        if not allowed or not path.is_file():
            raise RuntimeError('unexpected receipt file')
        size = path.stat().st_size
        if size > 256 * 1024:
            raise RuntimeError('receipt exceeds 256KiB per-file export bound')
        files.append((path, rel.as_posix(), size))
    if sum(size for _, _, size in files) > 2 * 1024 * 1024:
        raise RuntimeError('receipts exceed 2MiB total export bound')
    inventory = []
    print('PINTO_EVIDENCE_EXPORT_BEGIN ' + json.dumps({'files': len(files)}), flush=True)
    for path, rel, expected_size in files:
        data = path.read_bytes()
        if len(data) != expected_size:
            raise RuntimeError('receipt changed during export')
        encoded = base64.b64encode(data).decode('ascii')
        chunks = [encoded[i:i + 3000] for i in range(0, len(encoded), 3000)]
        entry = {'path': rel, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'chunks': len(chunks)}
        inventory.append(entry)
        print('PINTO_EVIDENCE_FILE ' + json.dumps(entry), flush=True)
        for index, chunk in enumerate(chunks):
            print('PINTO_EVIDENCE_CHUNK ' + json.dumps({'path': rel, 'index': index, 'data': chunk}), flush=True)
        print('PINTO_EVIDENCE_FILE_END ' + json.dumps({'path': rel}), flush=True)
    print('PINTO_EVIDENCE_EXPORT_END ' + json.dumps({'inventory': inventory}), flush=True)
except BaseException as error:
    print('PINTO_EVIDENCE_EXPORT_INCOMPLETE ' + json.dumps({'errorType': type(error).__name__, 'message': str(error)}), flush=True)
    sys.exit(1)
