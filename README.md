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
npm run typecheck    # strict TS, no emit
npm test             # 83 tests, no model required
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
```

See [`.env.example`](./.env.example).

---

## Honest limitations

This is a real, working agent — but a local 7B model is not Claude. Expect:

- **Weaker long-horizon reasoning.** It will lose the plot on big refactors. Keep tasks small.
- **Dropped or malformed tool calls.** The repair layer catches most, not all.
- **Slow first token.** The model loads into RAM once per session (`keepAlive` is 20m by default).
- **Small context.** 8k tokens is ~2,500 lines. Compaction helps but cannot replace RAM.

The roadmap in [`GUIDE.md`](./GUIDE.md#8-roadmap-closing-the-gap-with-claude-code) covers what to
build next.

## License

MIT.
