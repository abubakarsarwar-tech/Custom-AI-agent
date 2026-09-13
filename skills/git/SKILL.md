---
name: git
description: Git work — commits, branches, merges, rebases, resolving conflicts, reading history, undoing mistakes, tags and releases.
triggers: [git, commit, branch, merge, rebase, conflict, cherry-pick, stash, revert, reset, tag, release, blame, bisect, push, pull request, worktree]
---

# Git skill

## Look before acting

```bash
git status --short          # what is dirty
git diff                    # unstaged changes
git diff --staged           # what you are about to commit
git log --oneline -15       # recent shape of history
git branch -vv              # where branches point and what they track
```

Never run a destructive command (`reset --hard`, `clean -fd`, `checkout --`,
`rebase`, `push --force`) without reading these first, and never without telling
the user what will be lost.

## Commits

- **Stage deliberately.** `git add -p` or add named files. Never `git add .`
  without inspecting — that is how secrets, build output and stray debug files
  get committed.
- **One logical change per commit.** If the message needs "and", split it.
- **Never commit:** `node_modules/`, `dist/`, `.env`, credentials, large binaries,
  editor state, or files a `.gitignore` should already cover. Check first.
- **Match the repo's existing message style** — read `git log` before writing yours.

Conventional style unless the repo does something else:

```
<type>(<scope>): <imperative summary, <=72 chars, no trailing period>

What changed and WHY. The diff shows what; the message explains why,
what was rejected, and any trade-off the next reader needs to know.

Refs #123
```

Types: `feat` `fix` `docs` `style` `refactor` `test` `chore` `perf` `ci` `build`.
Imperative mood: "add", not "added" or "adds".

## Branches

- Name: `type/short-description` — `fix/login-redirect`, `feat/csv-export`.
- Branch from an up-to-date base: `git fetch && git switch -c feat/x origin/main`.
- Keep branches short-lived. A branch that lives for weeks accumulates conflicts.

## Conflicts

1. `git status` to list the conflicted files.
2. Open each one. Understand **both** sides before editing — read the surrounding
   code, not just the markers.
3. Resolve by intent, not by picking a side blindly. Often the answer is both
   changes, merged. Deleting one side's work is a real decision — say so.
4. Remove every `<<<<<<<`, `=======`, `>>>>>>>` marker. Search for them to be sure.
5. **Run the tests.** A conflict resolution that compiles but fails tests is not resolved.
6. Then `git add <file>` and continue.

## Undoing mistakes

| Situation                          | Command                                        |
| ---------------------------------- | ---------------------------------------------- |
| Unstage a file                     | `git restore --staged <file>`                   |
| Discard local edits to a file      | `git restore <file>` — **destroys work**        |
| Amend the last commit              | `git commit --amend` (only if not pushed)       |
| Undo a commit, keep changes        | `git reset --soft HEAD~1`                       |
| Undo a commit and its changes      | `git reset --hard HEAD~1` — **destroys work**   |
| Undo a pushed commit safely        | `git revert <sha>` (creates a new commit)       |
| Rescue anything you lost           | `git reflog` then reset/checkout the sha        |

Prefer `revert` over `reset`/`force-push` on any shared branch. `git reflog`
recovers almost everything for ~90 days — check it before declaring data lost.

## Reading history

```bash
git log --oneline --graph --all -20      # shape of the repo
git log -p -- path/to/file               # how one file evolved
git blame -L 40,60 path/to/file          # who and why for a line range
git show <sha>                           # one commit in full
git log -S "someFunction"                # commits that added/removed a string
git bisect start; git bisect bad; git bisect good <sha>   # find the breaking commit
```

## Safety rules

- **Never force-push a shared branch.** If unavoidable, use `--force-with-lease`
  and tell the user first.
- **Never rewrite published history** without explicit approval.
- Before any destructive operation, offer a backup: `git branch backup/pre-reset`.
- Never commit on a detached HEAD without creating a branch first.
- If a command fails with an auth error, report it — never ask for or store credentials.

## Report

State exactly what you ran, what changed, and anything now unrecoverable.
