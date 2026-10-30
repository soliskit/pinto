# Pull Request

A checklist for change class, behavior, safeguards, and decision records.

## What this changes

<!-- Complete this description: replace the five question prompts with answers after their bold labels. Start Decision record with Yes or No. For Yes, name a P-number and include docs/decisions.md in this PR; for No, explain why no record is needed. Select all applicable classes; do not combine No Class Needed with another class. The structural checker does not accept code fences, indented code, HTML elements or nested headings in this description. -->


## Class

* [ ] **Refactor:** app code changes, behavior does not. Requirement entries are unchanged and the tests pass; tests change only to follow renamed or moved code.
* [ ] **Bug Fix:** app code is brought back in line with an existing requirement. Which requirement, and which test failed before the fix?
* [ ] **Intentional Change:** behavior is added, changed or removed. Which requirement entries changed in the same commit, and which tests now check them?
* [ ] **Clarification:** requirement entries now describe behavior the app already has. Which entries, and which tests check them?
* [ ] **No Class Needed:** no app code (`src/` and `public/`) and no requirement entries change. The review questions still apply.

## Review questions

* **Behavior:** does this change what callers see, do, share or control, or how the server handles a call? If so, which requirement entries changed in the same commit?
* **Protection:** does this loosen, remove or move a runtime check, or a test that proves one works? If so, which requirement change allows it and what replaces it, or which test proves the same input still gets the same outcome at the same boundary? Types don't count.
* **Gates:** does this lower or remove the existing test, review, privacy or zero-cost gates? That is not allowed.
* **Description:** is any new behavior described by a requirement entry and a test? Behavior that isn't has no guarantee.
* **Decision record:** does this confirm, fix or reject a finding, or make a verification decision? If so, record it in docs/decisions.md in the same pull request.
