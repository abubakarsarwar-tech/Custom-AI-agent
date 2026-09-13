---
name: debug
description: Diagnose and fix a bug, crash, test failure, or unexpected behaviour. Use when something is broken and the cause is unknown.
triggers: [debug, bug, error, crash, failing, fails, failed, broken, not working, doesn't work, exception, stack trace, traceback, undefined is not, null pointer, segfault, panic, wrong output, unexpected, regression, why is, why does, returns undefined, investigate, fix the bug, fix the error, is failing, are failing, is broken, keeps failing, test fails, tests fail, tests are failing, test is failing, build fails, build is broken, suite is failing, throws, blew up]
---

# Debug skill

## The rule

**Reproduce it before you change anything.** A fix you cannot demonstrate against
a reproduction is a guess. If you cannot reproduce it, say so and ask for the
exact command, input, and output.

## The loop

1. **Read the whole error.** Not the first line — the whole thing, including the
   stack trace. The actual cause is often three frames down. Note the file, line,
   and the exact wording.
2. **Reproduce with the smallest possible command.** Get a one-liner that fails
   reliably. If it fails 30% of the time, that changes everything (say so).
3. **Form ONE hypothesis.** Write it down as a falsifiable sentence:
   "The config loader returns undefined because the env var is read before dotenv runs."
4. **Test the hypothesis cheaply.** Read the code, add one log line, run one
   command. Do not start changing things to see what happens.
5. **Confirm or discard.** If confirmed, fix the root cause. If discarded, go to
   3 with a new hypothesis. Do not stack three speculative fixes.
6. **Verify the fix** by re-running the reproduction, then the wider test suite.
7. **Check for siblings.** The same mistake is rarely alone. Search for the
   pattern you just fixed.

## Reading the evidence

- Use `search` to find every caller and every definition. Do not assume.
- Read the actual file, not your memory of it.
- Check the boring things first: is the file saved, is the build stale, is the
  right branch checked out, is the dependency actually installed, is the env var
  set in *this* shell?
- Compare against the last known-good state: `git log`, `git diff`, `git blame`
  on the line that broke.
- A test that passes alone but fails in the suite is a **shared state** problem:
  order dependence, a global, a temp file, a port, the clock, an env var.

## Fixing

- **Fix the cause, not the symptom.** A `try/catch` that hides the error, an `if
  (x == null) return` that papers over why it was null, a `sleep(500)` that masks
  a race — these are not fixes. They delay the real one.
- **Smallest correct diff.** Resist refactoring unrelated code while debugging.
- **Add a regression test** that fails before the fix and passes after. Without
  it, the bug comes back.
- If the root cause is in a dependency or generated code, fix it at your boundary
  and say clearly what the upstream problem is.

## When you are stuck

- Say so plainly. Do not invent an explanation or claim a fix you did not verify.
- Bisect: comment out half the path, or `git bisect` between good and bad commits.
- Print the actual values at the boundary. Assumptions about types, shapes,
  encodings and timezones are where most bugs live.
- Ask the user for one specific thing: the exact command, the full output, the
  versions, or the input that triggers it.

## Report

State: the symptom, the root cause, the fix, the test that now guards it, and
anything you noticed but deliberately did not change.
