# Reads receipts only. Does not execute the project or assign a defect verdict.
from pathlib import Path
import hashlib, json, re, sys
r = Path(sys.argv[1]).resolve()
phase, scope, browser = sys.argv[2:]
wanted = {
 '260': ['selected44px targets retain narrow and large layouts'],
 '132': ['peer connection and disconnect IDs cannot add log lines'],
 '188': ['failed ID request shows honest nonempty error detail', 'nonempty peer error detail is preserved exactly'],
 '168': ['pending config disables Mute until its handler is installed', 'HTTP error config is rejected even when its JSON looks valid', 'aborted and unreadable config retains existing visible failure reporting'],
}
required = ['identity.txt','fixture-overlay.diff','fixture-inventory.json','node.txt','npm.txt','install.log','testfile.txt','test.tap','test.stderr','native-status.txt','executed-inputs.sha256','resources.jsonl']
def manifest():
 files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(r.iterdir()) if p.is_file() and p.name!='artifact-inventory.json'}
 (r/'artifact-inventory.json').write_text(json.dumps(files,sort_keys=True,indent=2)+'\n')
def stop(why):
 (r/'capture-status.txt').write_text('INCOMPLETE: '+why+'\n')
 manifest()
 raise SystemExit(1)
if scope=='132': required.append('peer-sinks.jsonl')
for name in required:
 if not (r/name).is_file(): stop('missing '+name)
for name in ['identity.txt','fixture-inventory.json','node.txt','npm.txt','testfile.txt','test.tap','native-status.txt','executed-inputs.sha256','resources.jsonl']:
 if not (r/name).stat().st_size: stop('empty '+name)
rc = (r/'native-status.txt').read_text().strip()
if rc not in {'0','1'}: stop('abnormal runner exit '+rc)
tap = (r/'test.tap').read_text()
# Exact top-level names, strict positive counters. Nested/unknown format stops.
seen = re.findall(r'^# Subtest: (.+)$',tap,re.M)
if seen != wanted[scope]: stop('test inventory mismatch')
counts = {}
for key in ['tests','pass','fail','cancelled','skipped','todo']:
 values = re.findall(r'^# '+key+r' (\d+)$',tap,re.M)
 if len(values)!=1: stop('missing/duplicate counter '+key)
 counts[key]=int(values[0])
if counts['tests'] != len(seen) or counts['pass']+counts['fail'] != len(seen): stop('counter disagreement')
if any(counts[k] for k in ['cancelled','skipped','todo']): stop('cancel/skip/todo')
if (rc=='0') != (counts['fail']==0): stop('status/counter disagreement')
events = {}
for line in (r/'resources.jsonl').read_text().splitlines():
 try: row=json.loads(line)
 except ValueError: stop('invalid resource receipt')
 if not isinstance(row,dict) or set(row)!= {'pid','id','event'}: stop('unknown resource receipt shape')
 if type(row['pid']) is not int or row['pid']<=0: stop('invalid resource pid')
 if not isinstance(row['id'],str) or not re.fullmatch(r'(server|browser)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',row['id']): stop('invalid resource id')
 if type(row['event']) is not str or row['event'] not in {'acquire-start','acquired','closed'}: stop('invalid resource event')
 prior=events.setdefault(row['id'],{'pid':row['pid'],'events':[]})
 if prior['pid']!=row['pid']: stop('resource ownership pid changed')
 prior['events'].append(row['event'])
if not events: stop('no owned resources recorded')
if any(v['events'] != ['acquire-start','acquired','closed'] for v in events.values()): stop('resource acquisition/close incomplete')
expected_resources={'260':{'server':1,'browser':1},'132':{'server':1,'browser':0},'188':{'server':2,'browser':2},'168':{'server':3,'browser':3}}
actual_resources={kind:sum(k.startswith(kind+'-') for k in events) for kind in ['server','browser']}
if actual_resources!=expected_resources[scope]: stop('scope lifecycle inventory mismatch')
if scope=='132':
 try: sinks=[json.loads(line) for line in (r/'peer-sinks.jsonl').read_text().splitlines()]
 except ValueError: stop('invalid peer sink transcript')
 if not sinks or any(not isinstance(x,dict) or set(x)!= {'id','expected','raw'} or not all(isinstance(x[k],str) for k in ['id','expected','raw']) for x in sinks): stop('missing/invalid emitted sink bytes')
 if phase=='candidate' and len(sinks)!=2: stop('incomplete peer ID transcript inventory')
if phase=='candidate' and (rc!='0' or counts['pass']!=len(seen)): stop('candidate not fully passing')
if scope=='260' and phase=='candidate':
 images=[f'target-{w}-{state}.png' for w in [320,390,414,568,768,1280] for state in ['join-no-photo','leave-with-photo','lobby']]
 for name in images:
  if not (r/name).is_file() or (r/name).stat().st_size==0: stop('missing image '+name)
(r/'capture-status.txt').write_text('CAPTURE_COMPLETE_NOT_QUALIFIED\nBaseline defect attribution, graceful cleanup limits and260pixel review remain human review.\n')
manifest()
