---
name: code
description: Implement a feature, write a new module, or fix a bug in application code. Use for any "build X", "add X", "make X work" request.
triggers: [implement, feature, add, build, create, write, new function, new module, new endpoint, new file, scaffold, make it work, code this]
---

# Code skill

## Order of work

1. **Understand before writing.** Read the files you will touch and one or two
   files next to them. You are matching an existing codebase, not starting one.
2. **Find the seam.** Where does this change belong? Prefer extending an
   existing module over creating a new one.
3. **Write the smallest thing that fully works.** No scaffolding for future
   needs you do not have yet.
4. **Verify.** Typecheck, build, run the tests. Read the errors. Fix them.
   Repeat until clean.
5. **Report** what changed, which files, and how you verified it.

## Non-negotiables

- **Never write placeholders.** No `// TODO: implement`, no `...`, no
  "rest of code here", no stub that returns a hardcoded value. If you cannot
  finish, say so explicitly instead of faking it.
- **Match the surrounding style.** Naming, error handling, import order,
  comment density, indentation. The diff should look like the same author wrote it.
- **Read before you edit.** Always. Editing from memory produces broken patches.
- **One responsibility per function.** If you need the word "and" to describe
  what a function does, split it.

## Decisions

- **Errors:** handle them where they can be handled, propagate them where they
  cannot. Never swallow an exception silently. Never `catch {}` with an empty body.
- **Inputs:** validate at the boundary (HTTP handler, CLI arg, file read), trust
  internally. Do not re-validate the same value at four layers.
- **Naming:** a name says what it *is* or *returns*, not how. `userCount` not
  `getUserCountFromDbViaQuery`. Booleans read as assertions: `isValid`, `hasChildren`.
- **Comments:** explain *why*, never *what*. If a comment restates the code,
  delete the comment or rename the thing.
- **Types:** no `any`. If a type is genuinely unknown, use `unknown` and narrow it.

## Before you finish

- Did you introduce a new dependency? If yes, is it worth it, or is it 30 lines
  you could write yourself?
- Did you duplicate logic that already exists elsewhere? Search for it first.
- Would this break any existing caller? Search for callers before changing a signature.
- Is there an obvious edge case you skipped: empty input, null, zero, one, huge,
  concurrent, already-exists, permission-denied?
