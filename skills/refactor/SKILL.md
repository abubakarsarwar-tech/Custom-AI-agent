---
name: refactor
description: Restructure existing code without changing its behaviour — extract, rename, simplify, split modules, remove duplication, pay down tech debt.
triggers: [refactor, restructure, clean up, cleanup, simplify, tidy, reorganise, reorganize, extract, rename, deduplicate, dry, tech debt, messy, spaghetti, coupling, better structure, no behaviour change]
---

# Refactor skill

## The definition

**Refactoring changes structure, not behaviour.** If the output changes, it is not
a refactor — it is a feature or a fix, and it needs a different kind of care.

## Before you touch anything

1. **Establish a safety net.** Are there tests? Run them and record the result.
   If there are none, say so — refactoring untested code is the highest-risk work
   in software, and the user should decide whether to accept that.
2. **Understand the current design before judging it.** Code that looks wrong is
   often compensating for something real. Read the callers. `git log` the file;
   a weird branch is usually a scar from a past bug.
3. **Define the target in one sentence.** "Move all HTTP concerns out of
   `service.ts` into `routes/`." If you cannot, you are not ready.
4. **Scope it.** A refactor that touches 40 files cannot be reviewed. Prefer
   several small ones. Say which you are doing.

## How to work

- **Small, reversible steps.** Each step leaves the code working. Never do a
  two-hour rewrite and then try to compile.
- **One kind of change per commit.** Renames separate from moves, moves separate
  from logic changes. Mixed diffs are unreviewable and impossible to bisect.
- **Lean on the tools.** Use the compiler and the type system to find every
  call site instead of grepping and hoping. Rename via search-and-verify, then
  re-run the typecheck.
- **Verify after every step**, not just at the end. `typecheck` → `test` → next step.
- **Do not sneak in behaviour changes.** No "while I was here, I also fixed…".
  If you spot a bug, note it and report it separately.

## What good looks like

- **Extract** when a block has a name you can give it and that name means
  something at a higher level of abstraction.
- **Inline** when a wrapper adds a layer but no meaning.
- **Split** a module when its parts change for different reasons.
- **Merge** two modules that always change together.
- **Remove duplication** only when the two things are genuinely the same concept.
  Two blocks that look alike today but will evolve separately should stay apart —
  wrong abstraction is more expensive than duplication.
- **Reduce nesting** with early returns and guard clauses, not more indentation.
- **Delete dead code.** The compiler and the tests are your proof it is dead.

## What to avoid

- Renaming things to your personal taste when the existing names are consistent
  and understood by the team.
- Adding an abstraction "for flexibility" with only one implementation.
- Chasing a pattern from another language/framework that this codebase does not use.
- Reformatting whole files (destroys `git blame` for zero behaviour gain).
- Refactoring code you were not asked to touch.

## Report

List: what moved, what was renamed, what was deleted, the before/after test
result, and any behaviour you deliberately preserved even though it looked wrong.
