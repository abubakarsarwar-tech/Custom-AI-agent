# LCA — Local Code Agent

A coding agent like Claude Code, but it runs **100% on your laptop**. No API key, no cloud, no
subscription. Your code never leaves your machine.

Built in TypeScript with **zero runtime dependencies**. The model runs locally through
[Ollama](https://ollama.com).

```
you type a task
      │
      ▼
 ┌─────────┐   tool call    ┌──────────────────────────┐
 │  model  │ ─────────────▶ │ read/write/edit/search/  │
 │ (local) │ ◀───────────── │ bash/todo  (your laptop) │
 └─────────┘   observation  └──────────────────────────┘
      │  ▲
      └──┘  repeats until the model stops asking for tools
      │
      ▼
  final answer
```

That loop is the whole idea. Everything else is making it survive real projects and small models.

---

## Start here

**1. Read the guide.** [`GUIDE.md`](./GUIDE.md) explains how this works and how to build your own
from scratch. [`ARCHITECTURE.md`](./ARCHITECTURE.md) maps every file.

**2. Install Ollama and a model.**

```bash
# macOS / Windows: download the app from https://ollama.com/download
# Linux:
curl -fsSL https://ollama.com/install.sh | sh

# then pull a model (pick by your RAM — see the table below)
ollama pull qwen2.5-coder:7b
```

**3. Run this project.**

```bash
npm install
npm run doctor     # checks Node, RAM, Ollama, model — tells you what to fix
npm run demo       # full end-to-end run with NO model installed (proves it works)
npm run dev        # start the real agent in this folder
```

---

## Which model should you pull?

Run `npm run doctor` — it reads your RAM and recommends one. Rough guide:

| Your RAM      | Pull this                       | Native tool calls | Notes                                    |
| ------------- | ------------------------------- | ----------------- | ---------------------------------------- |
| 8 GB          | `qwen2.5-coder:3b`              | no                | slow but works for small edits           |
| 16 GB         | `qwen2.5-coder:7b` ⭐ default    | no                | best value; uses the JSON-repair path    |
| 16 GB         | `qwen3:8b`                      | **yes**           | more reliable tool calls                 |
| 24–32 GB      | `gpt-oss:20b` / `devstral-small:24b` | **yes**      | MoE, fast; devstral is trained for agents |
| 32 GB+ / GPU  | `qwen3-coder:30b`               | **yes**           | best local coding agent model            |
| 48 GB+ / GPU  | `qwen2.5-coder:32b`             | no                | strongest dense coder                    |

"Native tool calls" matters: with it, the model emits structured JSON the API hands us directly.
Without it, LCA recovers the call out of the model's prose
([`src/llm/repair.ts`](./src/llm/repair.ts)). It works, but expect an occasional dropped call.

Switch models any time: `lca -m qwen3:8b` or `/model qwen3:8b` inside the REPL.

---

## Using it

```bash
lca                                  # interactive REPL in the current folder
lca run "add input validation to src/signup.ts"   # one-shot task
lca run --readonly "explain what this repo does"  # analysis only, cannot change anything
lca serve                            # the same agent in your browser + an HTTP API
lca doctor                           # environment health check
lca models                           # what's pulled locally
```

Inside the REPL:

| Type                | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `@src/index.ts fix the bug` | attach a file to your message               |
| `!git status`       | run a shell command directly, no model involved      |
| `/plan`             | show the agent's task list                           |
| `/model qwen3:8b`   | switch model mid-session                             |
| `/permissions auto` | stop asking for approval (`ask` \| `auto` \| `readonly`) |
| `/stats`            | tokens, steps, timings                               |
| `/memory`           | list what the agent remembers about this project     |
| `/remember <text>`  | save a fact for future sessions                      |
| `/forget <id>`      | delete one remembered fact                           |
| `/compact`          | shrink history to free up context                    |
| `/undo` `/clear`    | roll back / reset the conversation                   |
| `Ctrl+C`            | interrupt the current turn                           |

### Permission modes

| Mode       | Behaviour                                                        |
| ---------- | ---------------------------------------------------------------- |
| `ask`      | **default.** Confirms before every write and every shell command |
| `auto`     | Never asks — but still hard-blocks `rm -rf /`, `sudo`, `mkfs`, fork bombs, `curl \| sh`, force-push |
| `readonly` | Analysis only. No writes, no shell. Safe to leave running        |

Every file tool is jailed to the workspace: `../` escapes and absolute paths outside it are refused.
`.env`, `.git/config` and SSH keys always need an explicit yes.

---

## Skills

The agent has **modular expertise**. Each skill is a folder with a `SKILL.md` describing how to do
one kind of job well. When you ask for something, the relevant skill is loaded and its instructions
go into the model's context.

10 skills ship built in:

| Skill      | Loaded when you ask about…                                       |
| ---------- | ---------------------------------------------------------------- |
| `code`     | implementing a feature, writing a module, making something work   |
| `design`   | UI/UX, layout, colour, typography, spacing, responsive, a11y      |
| `debug`    | a bug, crash, failing test, or anything that is broken            |
| `refactor` | restructuring code without changing behaviour                     |
| `test`     | writing or fixing tests, coverage                                 |
| `review`   | reviewing a diff or PR, finding problems                          |
| `security` | injection, auth, secrets, hardening, audits                       |
| `docs`     | README, docstrings, guides, changelogs                            |
| `git`      | commits, branches, rebases, conflicts, history                    |
| `explain`  | "what does this do", "how does X work"                            |

```bash
lca skills              # list them, with token cost and where each came from
lca --skill design      # force one before starting
```

In the REPL: `/skills` to list, `/skill design` to load one now.

**How it stays cheap.** Only the *name and one-line purpose* of each skill go into the system
prompt — about **450 tokens for all ten**. The full instructions (~600–1,400 tokens each) are loaded
only when that skill is actually used, and never twice in one conversation. Inlining all ten bodies
would cost ~10,000 tokens, which is more than an entire 8k context window.

**Routing.** A request is matched against each skill's `triggers` by a deterministic keyword score.
When one skill wins clearly, LCA loads it *itself* — no wasted round-trip asking a 7B model to
choose. When it is ambiguous, LCA stays out of the way and the model calls `use_skill` on its own.
Turn it off with `--no-auto-skill`, or disable skills entirely with `--no-skills`.

### Write your own

```
.agent/skills/deploy/SKILL.md
```

```markdown
---
name: deploy
description: Ship this app — build, push the image, run migrations, verify. Use for any release or deploy request.
triggers: [deploy, release, ship it, rollout, production, staging, kubernetes, docker push, migrate]
---

# Deploy skill

1. Run `pnpm build` and confirm it is clean.
2. ...
```

Search order, later wins: bundled `skills/` → `~/.config/local-code-agent/skills/` →
`<project>/.agent/skills/` → `<project>/skills/`. So a project can override any built-in skill just
by shipping its own.

You can also bundle reference files next to `SKILL.md` and have the model read one on demand:

```
.agent/skills/deploy/
  SKILL.md
  references/runbook.md      <- use_skill(name="deploy", resource="references/runbook.md")
```

That is a second level of progressive disclosure: the skill body stays short, and deep detail is
fetched only if it is actually needed.

---

## Web UI

Prefer a browser to a terminal? `lca serve` puts the *same* agent behind a local web page.

```bash
lca serve                     # opens http://127.0.0.1:8787
lca serve --port 3000         # different port
lca serve --host 0.0.0.0      # reachable from other devices — a token is minted automatically
lca serve --provider mock     # no Ollama? a scripted tour of the whole UI
```

What you get in the browser:

- streaming answers with lightweight markdown rendering
- collapsible **tool cards** — name, summary, duration, and the raw output/diff behind a click
- the **permission dialog** (Allow once / Always allow / Deny) — an unanswered prompt *denies* itself
- live **plan**, **skills** and **memory** panels; click a skill to load it, edit memory in place
- 👍 / 👎 feedback on each answer, which votes on the memories that were recalled for that turn
- model switcher, permission-mode switcher, stats line, Stop, Undo, Clear

Several tabs share **one** agent. Refresh the page and the conversation is restored from a snapshot.

It is plain HTML + CSS + JS — no React, no bundler, no build step. The server is `node:http` and the
stream is Server-Sent Events. Zero dependencies, like the rest of this repo.

### Is it safe to expose?

The web UI can do everything the terminal agent can, so it inherits the same gates — plus one more:

| Situation | What happens |
| --------- | ------------ |
| `lca serve` (default) | Binds `127.0.0.1`. Only your machine can reach it. No token needed. |
| `--host 0.0.0.0`, no `--token` | A random token is **generated** and printed. Every `/api/*` call needs it; the URL carries it once and the UI stores it in `localStorage`. |
| `--host 0.0.0.0 --public` | No token. Only do this on a network you trust — anyone on it can run your shell commands. |
| Nobody answers a permission prompt | After 5 minutes it is **denied**. An unattended web agent never falls open. |
| Permission mode | Still `ask` by default. `readonly` makes the browser agent harmless. |

Static files are jailed inside the web folder, and every string the model or a tool produces is HTML
-escaped before it reaches the DOM.

### The HTTP API

Anything the browser does, a script can do. Same port, JSON in, JSON out, SSE for the stream.

| Endpoint | What it does |
| -------- | ------------ |
| `GET /api/events` | SSE stream of every event (`assistant_delta`, `tool_start`, `permission_request`, `turn_end`, …) |
| `GET /api/state` | Full snapshot: model, workspace, plan, skills, memory, history, tools |
| `POST /api/chat` `{text, skill?, queue?}` | Send a message. Returns `202` immediately; the work streams over SSE |
| `POST /api/permission` `{id, answer}` | Answer a prompt: `yes` \| `no` \| `always` |
| `POST /api/interrupt` | Abort the current turn |
| `POST /api/model` `{model}` · `POST /api/permissions` `{mode}` | Switch model / permission mode |
| `POST /api/skill` `{name}` | Load a skill into context |
| `GET/POST/DELETE /api/memory` · `POST /api/memory/vote` | Read, add, forget and vote on memories |
| `POST /api/feedback` `{verdict, note?}` | 👍 boosts recalled memories; 👎 sinks them and can save a correction |
| `POST /api/clear` · `POST /api/undo` · `POST /api/compact` | Conversation controls |
| `GET /api/health` | Provider, model, reachable Ollama models, busy state |

```bash
# drive the agent from a shell script
curl -s localhost:8787/api/chat -H 'Content-Type: application/json' \
     -d '{"text":"summarise what this repo does"}'
curl -N -s localhost:8787/api/events      # watch it work
```

---

## Memory — how it gets better with use

This is **not** training. Nothing fine-tunes the model; its weights never change, and a 7B model on
your laptop cannot be fine-tuned in any useful way. What actually makes a local agent improve with
use is simpler and it works today: **write down what you correct it on, and read it back later.**

Memories live in `.agent/memory/lessons.jsonl` — plain JSON Lines you can read, grep or edit:

```json
{"id":"l_mu0b5p6v_kjwc","text":"Use pnpm in this repo, never npm","tags":["tooling"],"score":2,"source":"user"}
```

How it behaves:

- **Recall is keyword-based, not embeddings.** On each turn the store ranks memories by token overlap
  with your message (tags and file paths weigh more), and injects the top few as a bracketed note.
  It is free, instant and offline — the right trade for a few hundred memories.
- **The agent can save its own memories** with the `remember` tool: a convention it discovered, a
  command that works, a gotcha it hit.
- **You can save them from the UI** (Memory panel) or from the REPL.
- **Votes make memories float or sink.** 👍 raises the score so a memory is recalled more often; 👎
  lowers it, and at −2 it stops being recalled at all (but stays in the file until you delete it).
- **Duplicates collapse.** Saving the same fact twice bumps the score instead of repeating itself —
  which is also how a memory earns trust.

Turn off with `LCA_MEMORY=false`; cap how many are injected with `LCA_MEMORY_MAX_INJECT` (default 5).

```bash
lca run "remember: this repo uses vitest, not jest"
cat .agent/memory/lessons.jsonl
```

The honest version of "one day it will be as good as Claude" is this: the model will not get smarter,
but *your setup* will. Memory plus `AGENTS.md` plus skills is where the compounding comes from.

---

## Project rules

Drop an `AGENTS.md` in your repo root and it is injected into the system prompt — same trick as
`CLAUDE.md`. See [`examples/AGENTS.md`](./examples/AGENTS.md).

```markdown
# AGENTS.md
- Package manager: pnpm. Never run npm install.
- Run `pnpm typecheck && pnpm test` before saying a task is done.
- We use named exports only, never default exports.
```

---

## Development

```bash
npm run dev          # run from source with tsx
npm run serve        # the web UI + HTTP API on 127.0.0.1:8787
npm run serve:demo   # the web UI against the scripted mock provider (no Ollama needed)
npm run typecheck    # strict TS, no emit — src AND tests
npm test             # 200 tests, no model required
npm run build        # compile to dist/
npm link             # install the `lca` command globally
```

The whole test suite runs against a **mock model provider**, so you can develop the agent without
Ollama installed. That is also what `npm run demo` uses.

---

## Configuration

`.agent/config.json` in your project, `~/.config/local-code-agent/config.json` globally, or env vars.
Precedence: defaults → config file → env → CLI flags.

```bash
LCA_MODEL=qwen3:8b
LCA_OLLAMA_URL=http://127.0.0.1:11434
LCA_NUM_CTX=16384        # important: Ollama defaults to 2048-4096, too small for an agent
LCA_TEMPERATURE=0.1
LCA_MAX_STEPS=25
LCA_PERMISSION_MODE=ask
LCA_WORKSPACE=/path/to/repo

# memory
LCA_MEMORY=true
LCA_MEMORY_MAX_INJECT=5

# web UI (`lca serve`)
LCA_WEB_HOST=127.0.0.1
LCA_WEB_PORT=8787
LCA_WEB_TOKEN=             # set one to require it on every /api call
```

See [`.env.example`](./.env.example).

---

## Honest limitations

This is a real, working agent — but a local 7B model is not Claude. Expect:

- **Weaker long-horizon reasoning.** It will lose the plot on big refactors. Keep tasks small.
- **Dropped or malformed tool calls.** The repair layer catches most, not all.
- **Slow first token.** The model loads into RAM once per session (`keepAlive` is 20m by default).
- **Small context.** 8k tokens is ~2,500 lines. Compaction helps but cannot replace RAM.
- **Memory is recall, not learning.** It retrieves what you told it; it does not change how the model
      reasons. Wrong memories produce confidently wrong behaviour — review the file now and then.

The roadmap in [`GUIDE.md`](./GUIDE.md#8-roadmap-closing-the-gap-with-claude-code) covers what to
build next.

## License

MIT.
