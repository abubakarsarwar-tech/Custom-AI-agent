---
name: explain
description: Explain unfamiliar code, a codebase, an error message, or a concept to a human. Use for "what does this do", "how does X work", "walk me through", "help me understand".
triggers: [explain, what does, how does, walk me through, help me understand, overview, summarise, summarize, tell me about, teach, onboarding, what is this, meaning of]
---

# Explain skill

## First, calibrate

Answer at the level asked for. If the request is ambiguous, start one level above
the code and offer to go deeper — do not guess wrong and dump 200 lines of
line-by-line narration, and do not give a two-word answer to a real question.

| Asked for                  | Give                                                        |
| -------------------------- | ----------------------------------------------------------- |
| "what does this repo do"   | purpose, entry point, main flow, key folders — 10 lines max |
| "what does this function do" | contract, then behaviour, then edge cases                  |
| "how does X work"          | the mechanism, with the 2-3 files that matter               |
| "why is this like this"    | the constraint it solves; check `git log`/`blame` for proof |
| "explain this error"       | what it means, the likely cause, the concrete next step     |

## Ground everything in the actual code

Read before you explain. Never describe code from the filename, a guess, or a
general pattern you have seen elsewhere. Cite `file:line` so the reader can check
you. If you are inferring intent rather than reading it, **say so** — "this looks
like it exists to…", not a confident invention.

When explaining why something is written oddly, check the history:

```bash
git log -p -- path/to/file      # how it evolved
git blame -L 30,50 path/to/file # who wrote it and in which commit
git show <sha>                  # the full context of that change
```

A weird line is usually a scar from a real bug. Say which.

## Structure of a good explanation

1. **One-sentence answer first.** The reader should get the point immediately,
   before any detail. Do not build up to a conclusion.
2. **The flow.** What happens in order. Name the actual functions and files.
3. **The details that matter.** Inputs, outputs, side effects, invariants,
   failure modes. Skip the obvious.
4. **The surprises.** Anything a reader would get wrong if they assumed the
   normal behaviour: hidden caching, mutation, async ordering, global state,
   platform differences, an off-by-one that is deliberate.
5. **Where to go next.** The file to read for more depth.

## How to write it

- **Short sentences.** One idea each.
- **Concrete nouns.** "The `PermissionGate` checks the command against `HARD_DENY`"
  beats "the security layer validates input".
- **An analogy only if it is accurate**, and always mark where it breaks down.
- **A small snippet beats a paragraph** when showing a shape, a signature, or the
  key three lines. Keep it under ~10 lines and mark what to notice.
- **A diagram for flow.** ASCII is fine and renders everywhere:

      request → parse → validate → handler → db
                                 ↘ error → 400

- Define an acronym the first time you use it.
- No filler: "In this file we can see that…" → just say the thing.
- No emoji.

## Honesty

- If you do not know, say so and say what would answer it (a file to read, a
  command to run, a question for the author).
- Distinguish **what the code does** (verifiable, cite it) from **why** (often
  inference — label it).
- If the code is genuinely confusing or looks wrong, say that plainly instead of
  inventing a justification. "This appears to be a bug: X is never awaited" is a
  more useful explanation than a rationalisation.

## Finish

Ask whether they want more depth on one part. Do not pad the answer to look thorough.
