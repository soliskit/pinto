# Writing commits and pull requests

Use a clean subject starting with an action verb. Put Why, How and Tags in the commit body, with short useful answers. The standard applies to new commits; it does not rewrite history or change previously approved exact messages.

## Commit editor setup

From this repository's root, opt in for this clone:

```sh
git config --local commit.template .github/commit-template.txt
```

This changes only this clone's `.git/config`. It is not automatic on clone and does not set a global preference. Run `git commit` without `-m` to open the editor with the template. Replace Subject and answer each field. Remove prompts and comments from the finished message. A command-line message, GitHub web commit or squash-merge editor can bypass the template; the writing standard still applies. No hook or commit-message gate is installed.

To see the saved setting:

```sh
git config --local --get commit.template
```

To undo this setting, first note any earlier value you want to restore. If this setup created it, remove it:

```sh
git config --local --unset commit.template
```

## Pull request descriptions

Use the repository's Tetris-format description: explain the change, select all applicable classes, and answer Behavior, Protection, Gates, Description and Decision record. No Class Needed cannot be combined with another class. Start Decision record with Yes or No. A Yes needs the native decision number and a change to `docs/decisions.md` in the same PR. A No needs a reason. The description checker verifies this shape, not whether the answers are true or the decision exists.

The checker accepts main-target PRs only. It rejects fenced code, indented code, HTML elements and nested headings in the description. Use plain paragraphs and the provided section/question labels. Multiple open PRs with the same head SHA are refused. It reads trusted main files and PR metadata, never runs code from a PR head, and writes the `PR description` commit status.

A status is attached to a commit, not atomically to one version of a PR body. A body edit leaves the commit unchanged. API errors, status-write failures or another PR opening during the final check can leave an old green result. Before every merge, re-read the current body and head, confirm the record and paths, all required checks, and that no other open PR shares the head. Stop on drift or uncertainty. This is a structural helper plus live review, not race-free automatic enforcement and not a truth checker.
