"""Proposed trusted-base adapter. Loads no PR-head files or executable input."""
import json
import os
import sys
import urllib.request
from check_pr_description import check


def run(api, repo, number, template):
    prefix = '/repos/' + repo
    def unique_open_pr(head):
        matches = []
        page = 1
        while True:
            pulls = api('GET', prefix + '/pulls?state=open&per_page=100&page=' + str(page))
            matches.extend(p['number'] for p in pulls if p['head']['sha'] == head)
            if len(pulls) < 100:
                break
            page += 1
            if page > 100:
                raise ValueError('Open-PR list exceeds supported safety bound.')
        if matches != [number]:
            raise ValueError('Head SHA is shared by another open PR or this PR is absent.')
    def snapshot():
        pr = api('GET', prefix + '/pulls/' + str(number))
        if pr['state'] != 'open':
            raise ValueError('PR is not open.')
        if pr['base']['ref'] != 'main' or pr['base']['repo']['full_name'] != repo:
            raise ValueError('Only this repository main branch is in scope.')
        head = pr['head']['sha']
        unique_open_pr(head)
        paths = []
        page = 1
        while True:
            files = api('GET', prefix + '/pulls/' + str(number) + '/files?per_page=100&page=' + str(page))
            paths.extend(f['filename'] for f in files)
            if len(files) < 100:
                break
            page += 1
            if page > 30:
                raise ValueError('Changed-file list exceeds supported 3000-file limit.')
        # The API limits this list to 3000 files; do not silently certify a partial list.
        if len(paths) != pr['changed_files']:
            raise ValueError('Incomplete or drifting changed-file list.')
        again = api('GET', prefix + '/pulls/' + str(number))
        fields = lambda p: (p['head']['sha'], p.get('body') or '', p['changed_files'], p['state'])
        if fields(pr) != fields(again):
            raise ValueError('PR changed during read.')
        return head, pr.get('body') or '', tuple(sorted(paths))
    head, body, paths = snapshot()
    target = prefix + '/statuses/' + head
    api('POST', target, {'state': 'pending', 'context': 'PR description', 'description': 'Checking the current description.'})
    try:
        errors = check(body, paths, template)
        if snapshot() != (head, body, paths):
            raise ValueError('PR changed before status publication.')
        api('POST', target, {'state': 'failure' if errors else 'success', 'context': 'PR description', 'description': 'Description needs changes.' if errors else 'Required description fields are complete.'})
        return errors
    except Exception:
        api('POST', target, {'state': 'error', 'context': 'PR description', 'description': 'Description could not be verified.'})
        raise


def main():
    repo = os.environ['GITHUB_REPOSITORY']
    with open(os.environ['GITHUB_EVENT_PATH']) as f:
        event = json.load(f)
    number = event['pull_request']['number']
    token = os.environ['GH_TOKEN']
    def api(method, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request('https://api.github.com' + path, data=data, method=method, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    with open('pull_request_template.md') as f:
        template = f.read()
    with open('description_config.json') as f:
        config = json.load(f)
    if config['repository'] != repo:
        raise ValueError('Configuration repository mismatch.')
    errors = run(api, repo, number, template)
    for error in errors:
        print(error)
    return bool(errors)

if __name__ == '__main__':
    sys.exit(main())
