---
name: docs
description: Write or improve documentation — README, API reference, inline comments, docstrings, guides, CHANGELOG, or commit/PR descriptions.
triggers: [docs, documentation, readme, document this, docstring, jsdoc, tsdoc, guide, tutorial, changelog, api reference, write up, inline comments]
---

# Docs skill

## The one rule

**Documentation exists so the reader can do something they could not do before.**
Every sentence should survive the question "does this help them act?" If not, cut it.

## Match the audience

| Reader              | Needs                                                            |
| ------------------- | ---------------------------------------------------------------- |
| New user            | what it is, install, one working example, where to get help       |
| Integrator          | API surface, types, error cases, versioning, auth                 |
| Contributor         | how to set up, run, test, and what the conventions are            |
| Future you          | *why* this decision was made and what was rejected                |

Say who you are writing for, and do not mix the four in one document.

## README

The first screen answers, in this order:

1. **What it is** — one sentence, no adjectives, no "revolutionary".
2. **Why use it** — the problem, concretely.
3. **Install** — copy-pasteable, with prerequisites stated.
4. **Quick start** — one command that produces a visible result in under a minute.
5. **Where to go next** — links, not a wall of text.

Then: configuration, examples, troubleshooting, contributing, licence.

**Every command block must actually work.** Run them. A README whose quick start
fails is worse than no README, because it also lies.

## Inline comments and docstrings

- Comment **why**, never **what**. `// retry 3x: the upstream API rate-limits bursts`
  is a comment. `// loop 3 times` is noise — delete it.
- Document **contracts**: what goes in, what comes out, what it throws, what it
  assumes, what it does NOT do, and any side effect a caller would not expect.
- Public API gets a docstring. Private helpers get one only if the logic is subtle.
- Delete comments that restate the code, and comments that are now wrong. A stale
  comment is worse than none because it is believed.
- `TODO(name): what and why` — an owner and a plan, not just `// TODO fix`.

## API reference

For each function/endpoint: signature with types, one-line purpose, every
parameter (type, whether optional, default, valid range), the return value, every
error it can raise and when, and one realistic example. State thread-safety,
idempotency, and rate limits if they matter.

## Style

- **Short sentences.** One idea each.
- **Active voice.** "The loader validates the config" not "The config is validated by the loader".
- **Second person for instructions.** "Run `npm test`" not "One may run the tests".
- **Concrete over abstract.** Numbers, file names, real commands, real output.
- **Show the output**, not just the command. Readers need to know what success looks like.
- **No emoji in prose.** They date badly and read as noise.
- **Admit limits.** A "Known limitations" section builds more trust than a page of claims.

## Structure

- Headings form an outline that makes sense on their own — a reader skimming only
  headings should understand the document.
- Put the answer first, then the explanation. Do not build up to a conclusion.
- Tables for anything with two or more parallel attributes.
- Code fences always carry a language tag.
- Check every internal link resolves.

## Before you finish

Re-read as the target reader. Try the quick start on a clean machine (or imagine
one). Verify versions, flags and file paths against the current code — docs drift
because nobody re-runs them.
