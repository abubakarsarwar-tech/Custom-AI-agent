---
name: review
description: Review a diff, pull request, or file and report problems by severity. Use when asked to review, check, or critique code someone wrote.
triggers: [review, code review, pr, pull request, critique, feedback, approve, looks good, any issues, check this code, audit quality]
---

# Review skill

## Setup

Get the actual diff, not a summary of it:

```bash
git diff main...HEAD          # or: git diff HEAD~1, git show <sha>
git diff --stat main...HEAD   # the shape of the change first
git log --oneline main..HEAD  # what the author said they were doing
```

Read the description/intent first, then the diff, then the surrounding code the
diff does not show. A change that is correct in isolation can still be wrong in
context — read the callers.

## What to check, in priority order

**1. Correctness.** Does it do what it claims? Off-by-one, wrong operator,
inverted condition, null/undefined, wrong variable, missing `await`, mutation of
a shared object, resource never closed, wrong comparison (`==` vs `===`).

**2. Edge cases.** Empty, single, huge, duplicate, concurrent, already-exists,
not-found, partial failure, network timeout, non-ASCII, timezone, very large numbers.

**3. Error handling.** Are failures handled where they can be? Anything swallowed
silently? Error messages that would actually help someone at 3am? Does a failure
in one item kill the whole batch?

**4. Security.** Unvalidated input reaching SQL/shell/HTML/path. Path traversal.
Secrets in code or logs. Auth checks that trust the client. Deserialising
untrusted data. Overly permissive CORS or file permissions.

**5. Contracts.** Public signatures, return shapes, event payloads, API responses,
DB schemas, config keys. Breaking one silently breaks every caller — list them.

**6. Tests.** Are the new paths tested? Do the tests assert behaviour or just
"it didn't throw"? Was a test weakened, skipped, or deleted to get green?

**7. Design.** Right place for this logic? Duplication that should be shared, or
an abstraction that should not exist yet? Complexity that could be removed?

**8. Readability.** Names that mean something, functions with one job, nesting
depth, dead code, comments that explain *why*.

## How to report

Group by severity. Never a wall of undifferentiated comments.

```
BLOCKER   Data loss: the migration drops the column before copying it (line 42).
SHOULD    No test for the empty-input path; the loop silently returns null.
NIT       `getUserData` -> `fetchUser`; it does not "get" from a cache.
PRAISE    The retry-with-backoff helper is clean — worth extracting for reuse.
```

Every finding needs: **file:line**, **what is wrong**, **why it matters**, and a
**concrete fix**. "This could be better" is not a review comment.

## Rules of engagement

- **Review the code, not the person.** "This function does not handle X" not
  "You forgot X".
- **Distinguish fact from preference, and label it.** A blocker is a defect;
  a nit is taste. Do not present taste as correctness.
- **Ask before assuming.** If something looks wrong but might have a reason,
  ask: "Is this order deliberate? It looks like the write happens before the flush."
- **Say what is good.** Specifically. It is true, and it tells the author what to
  keep doing.
- **Do not rewrite the author's design** because you would have done it
  differently. Only flag it if it causes a real problem.
- **Check yourself:** if you cannot point to the line and the failure mode, it is
  not a finding.

## Finish with a verdict

`approve` / `approve with nits` / `request changes`, plus the one-sentence reason.
