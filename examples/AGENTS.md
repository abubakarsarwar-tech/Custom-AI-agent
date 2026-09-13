# AGENTS.md

This file is read automatically when LCA starts in this folder and injected into
the model's system prompt. It is the local equivalent of `CLAUDE.md`.

Keep it short. Every line costs context tokens, and a 7B model with an 8k window
does not have many to spare. Rules beat explanations.

---

## Project rules

- Package manager is **pnpm**. Never run `npm install` or `yarn`.
- TypeScript is `strict`. Do not add `any` or `@ts-ignore` to make errors go away.
- Named exports only. Never use `export default`.
- Every new function needs a test in `tests/` with the same base name.

## Commands

- Install: `pnpm install`
- Typecheck: `pnpm typecheck`
- Test: `pnpm test`
- Test one file: `pnpm vitest run tests/foo.test.ts`
- Lint + fix: `pnpm lint --fix`

## Definition of done

Before you say a task is complete, all of these must pass:

1. `pnpm typecheck` — zero errors
2. `pnpm test` — all green
3. You have read the diff of every file you changed

## Style

- Match the existing code in the file you are editing. Do not impose new conventions.
- Prefer small functions with early returns over nested `if` blocks.
- Comments explain **why**, never **what**. The code already says what.
- No emoji in code, comments, or commit messages.

## Never touch

- `migrations/` — schema changes are reviewed by a human first
- `.env`, `.env.*` — secrets stay out of the model's context
- `dist/`, `node_modules/` — build output
