"""Proposed structural checker. Pure data only; no network or repository effects."""
import re

QUESTIONS = ('Behavior', 'Protection', 'Gates', 'Description', 'Audit')
CLASSES = ('Refactor', 'Bug Fix', 'Intentional Change', 'Clarification', 'No Class Needed')


def check(body, changed_paths, template, decision_prefix):
    errors = []
    # Proposed restricted grammar: do not certify Markdown whose presentation
    # can turn apparent fields into code or hidden HTML. Comments are ignored.
    visible = re.sub(r'<!--.*?-->', '', body, flags=re.S)
    if '<!--' in visible or '-->' in visible:
        errors.append('Close every HTML comment before the required description.')
    body = visible
    template = re.sub(r'<!--.*?-->', '', template, flags=re.S)
    if re.search(r'^ {0,3}(?:`{3,}|~{3,})', body, re.M):
        errors.append('Code fences are not supported in the required description.')
    if any(line.strip() and len(line.expandtabs(4)) - len(line.expandtabs(4).lstrip(' ')) >= 4 for line in body.splitlines()):
        errors.append('Indented code is not supported in the required description.')
    if re.search(r'</?[A-Za-z][^>]*>', body):
        errors.append('HTML elements are not supported in the required description.')
    if re.search(r'^#{3,}\s', body, re.M):
        errors.append('Nested headings are not supported in the required description.')
    def section(text, title):
        found = re.findall(r'^## ' + re.escape(title) + r'\s*\n(.*?)(?=^## |\Z)', text, re.M | re.S)
        return found
    for name in ('What this changes', 'Class', 'Review questions'):
        if len(section(body, name)) != 1:
            errors.append('Keep exactly one ' + name + ' section.')
    what = section(body, 'What this changes')
    if what and not what[0].strip():
        errors.append('Answer What this changes.')
    classes = section(body, 'Class')
    if classes:
        selected = re.findall(r'^\s*[*-] \[[xX]\] \*\*([^*]+):\*\*', classes[0], re.M)
        if not selected or any(c not in CLASSES for c in selected):
            errors.append('Select one or more recognized classes.')
        if len(set(selected)) != len(selected):
            errors.append('Do not repeat a selected class.')
        if 'No Class Needed' in selected and len(selected) != 1:
            errors.append('No Class Needed cannot be combined with another class.')
    review = section(body, 'Review questions')
    original = section(template, 'Review questions')
    def answers(text):
        return re.findall(r'^\s*[*-] \*\*([^*]+):\*\*\s*(.*?)(?=^\s*[*-] \*\*|\Z)', text, re.M | re.S)
    original_answers = dict(answers(original[0])) if original else {}
    if review:
        fields = answers(review[0])
        for label in QUESTIONS:
            found = [a.strip() for k, a in fields if k == label]
            if len(found) != 1:
                errors.append('Keep exactly one ' + label + ' answer.')
            elif not found[0] or found[0] == original_answers.get(label, '').strip():
                errors.append('Replace the ' + label + ' prompt with an answer.')
        audit = [a.strip() for k, a in fields if k == 'Audit']
        if len(audit) == 1:
            answer = audit[0]
            if not re.match(r'^(Yes|No)\b', answer, re.I):
                errors.append('Start Audit with Yes or No.')
            elif re.match(r'^No\s*[.,:;!?-]?\s*$', answer, re.I):
                errors.append('Explain the No answer for Audit.')
            elif re.match(r'^Yes\b', answer, re.I):
                if not re.search(r'\b' + re.escape(decision_prefix) + r'[1-9][0-9]*\b', answer):
                    errors.append('Name a ' + decision_prefix + '-number in the Audit Yes answer.')
                if 'docs/decisions.md' not in changed_paths:
                    errors.append('Audit Yes needs docs/decisions.md in this PR.')
    return errors
