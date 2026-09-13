# Architecture

Every file, what it does, and why it exists. ~5,300 lines of TypeScript + 10 skill documents,
**zero runtime dependencies** (dev-only: `typescript`, `tsx`, `vitest`, `@types/node`).

---

## Data flow

```
                        ┌──────────────────────────────────────────────┐
                        │                 src/index.ts                 │
                        │  arg parsing → command dispatch → exit code  │
                        └───────┬───────────────┬──────────────┬───────┘
                                │               │              │
                            repl.ts        run (one-shot)   doctor.ts
                                │               │
                                └───────┬───────┘
                                        ▼
                     ┌──────────────────────────────────────┐
                     │        src/agent/runtime.ts          │
                     │  owns: history, provider, registry,  │
                     │  permission gate, plan, system prompt│
                     └──────────────────┬───────────────────┘
                                        ▼
        ┌───────────────────────────────────────────────────────────────┐
        │                     src/agent/loop.ts                         │
        │                                                               │
        │   compact? → inject plan? → stream from provider              │
        │        ▲                            │                         │
        │        │                    ┌───────┴────────┐                │
        │        │               tool calls?        no tool calls       │
        │        │                    │                 │               │
        │        │                    ▼                 ▼               │
        │        │            permissions.check      return answer      │
        │        │                    │                                 │
        │        │                    ▼                                 │
        │        │            registry.invoke(tool)                     │
        │        │                    │                                 │
        │        └────────────────────┘  append role:"tool" message     │
        └───────────────────────────────────────────────────────────────┘
                    │                                    │
                    ▼                                    ▼
        ┌───────────────────────┐            ┌──────────────────────────┐
        │     src/llm/*         │            │       src/tools/*        │
        │ ollama.ts  (real)     │            │ read write edit list     │
        │ mock.ts    (tests)    │            │ search bash todo         │
        │ repair.ts  (fallback) │            │        │                 │
        └───────────────────────┘            └────────┼─────────────────┘
                                                      ▼
                                          ┌───────────────────────────┐
                                          │      src/safety/*         │
                                          │ paths.ts   (the jail)     │
                                          │ permissions.ts (policy)   │
                                          └───────────────────────────┘
```

---

## File map

### Entry & CLI

| File                    | Lines | Responsibility                                                            |
| ----------------------- | ----- | ------------------------------------------------------------------------- |
| `src/index.ts`          | 334   | Shebang entry. Dispatches `repl`/`run`/`demo`/`doctor`/`models`/`skills`/`serve`. Handles EPIPE, SIGINT, pre-flight Ollama check. |
| `src/cli/args.ts`       | 203   | Hand-rolled flag parser (no `commander` dependency) + help text.           |
| `src/cli/repl.ts`       | 420   | Interactive REPL: readline, slash commands (skills, memory, checkpoints), `@file` mentions, `!shell`, Ctrl+C abort. |
| `src/cli/prompt.ts`     | 40    | The y/n/always approval prompt, shared by REPL and one-shot mode.          |
| `src/cli/mentions.ts`   | 67    | Expands `@path/to/file` into attached `<file>` blocks.                     |
| `src/config.ts`         | 253   | Layered config: defaults → `.agent/config.json` → env → CLI. Loads `AGENTS.md`. |
| `src/doctor.ts`         | 210   | Environment health check + RAM-aware model recommendation table.           |

### Agent core

| File                         | Lines | Responsibility                                                       |
| ---------------------------- | ----- | -------------------------------------------------------------------- |
| `src/agent/loop.ts`          | 284   | **The agent loop.** Read this first. Compaction, plan injection, streaming, tool dispatch, loop breakers, step limit. |
| `src/agent/runtime.ts`       | 348   | Stateful container across turns. `send()`, `setModel()`, `clearHistory()`, `undoLast()`, `compactNow()`, `statsLine()`. Owns the memory store, per-turn lesson recall, and the checkpoint lifecycle (`begin` before the loop, `finish` in a `finally`). |
| `src/agent/context.ts`       | 244   | Builds the environment block (OS, git, stack, tree, scripts) and the system prompt. |
| `src/agent/compact.ts`       | 125   | Replaces old turns with a deterministic action log when near the context budget. |
| `src/agent/stream-filter.ts` | 81    | Hides prose-JSON tool calls from the display while streaming.         |
| `src/agent/plan.ts`          | 50    | `PlanStore` — the agent's todo list, rendered back into context.      |
| `src/agent/tokens.ts`        | 37    | `chars / 3.5` estimation. No tokenizer dependency.                    |

### Model layer

| File                | Lines | Responsibility                                                                |
| ------------------- | ----- | ----------------------------------------------------------------------------- |
| `src/llm/types.ts`  | 71    | `Message`, `ToolCall`, `ToolSpec`, `StreamEvent`, `LLMProvider`. OpenAI-shaped because that is what Ollama implements. |
| `src/llm/ollama.ts` | 239   | Streaming `/api/chat` client. NDJSON parsing, tool-call extraction, usage stats, `pingOllama`, `listModels`. |
| `src/llm/mock.ts`   | 227   | Scripted provider for tests, `npm run demo` and `lca serve --provider mock`. A "sloppy" mode emits prose JSON; `webScript()` tours the browser UI and can loop. |
| `src/llm/repair.ts` | 202   | Recovers tool calls printed as text: brace-depth JSON scanner, alias keys, lenient JSON parsing. |

### Tools

| File                      | Lines | Responsibility                                                          |
| ------------------------- | ----- | ----------------------------------------------------------------------- |
| `src/tools/types.ts`      | 84    | `Tool` / `ToolResult` / `ToolContext` interfaces + arg coercion helpers that tolerate sloppy model output. |
| `src/tools/registry.ts`   | 82    | Name → tool map, schema export, and `invoke()` which converts every throw into an error result. |
| `src/tools/read-file.ts`  | 85    | `cat -n` output, offset/limit, binary detection, size cap.              |
| `src/tools/edit-file.ts`  | 239   | Exact → whitespace-tolerant match, ambiguity detection, indent restoration, closest-region hint on failure. Captures a checkpoint only once the edit is known to apply. |
| `src/tools/write-file.ts` | 81    | Create/overwrite with `mkdir -p`, diff for the UI, checkpoint capture before mutating.                      |
| `src/tools/list-dir.ts`   | 109   | Tree with sizes, depth cap, skips `node_modules`/`.git`/`dist`.         |
| `src/tools/search.ts`     | 160   | Regex/literal grep in pure TS with glob filtering and result caps.      |
| `src/tools/bash.ts`       | 139   | `spawn` with shell, timeout kill, output caps, exit code reporting.     |
| `src/tools/todo.ts`       | 86    | Plan tool; tolerates status words like `done`/`DOING`.                  |
| `src/tools/use-skill.ts`  | 110   | Loads one skill body on demand; cheap no-op if already loaded; reads bundled resources jailed to the skill folder. |
| `src/tools/arg-aliases.ts`| 139   | `file_path`→`path`, `cmd`→`command`, stringy booleans → real booleans.  |

### Skills (modular expertise)

| File                        | Lines | Responsibility                                                     |
| --------------------------- | ----- | ------------------------------------------------------------------ |
| `src/skills/types.ts`       | 39    | `Skill` / `SkillMeta` / `SkillLoadResult` shapes.                   |
| `src/skills/frontmatter.ts` | 109   | Hand-rolled YAML-subset parser (scalars, inline arrays, block lists). No `yaml` dependency. |
| `src/skills/loader.ts`      | 179   | Discovers `SKILL.md` across bundled → user → project dirs, de-duplicates identical paths, derives name/description when frontmatter is missing, lists bundled resources. |
| `src/skills/router.ts`      | 140   | Deterministic trigger scoring. Multi-word triggers outweigh single words; explicit cues ("use the X skill") are decisive; a bare skill name never hijacks a sentence. |
| `src/skills/library.ts`     | 147   | Owns discovered skills + progressive disclosure: compact index for the prompt, capped on-demand bodies, loaded-set so nothing is paid for twice. `spawn()` hands a sub-agent the same discovered skills with a *fresh* loaded-set, so the parent is never told a body is loaded when it only exists in the child's context. |
| `skills/*/SKILL.md`         | 806   | The 10 built-in skills: `code`, `design`, `debug`, `refactor`, `test`, `review`, `security`, `docs`, `git`, `explain`. |

### Checkpoints (rollback for the agent's own edits)

| File                        | Lines | Responsibility                                                     |
| --------------------------- | ----- | ------------------------------------------------------------------ |
| `src/agent/subagent.ts`     | 317   | **Context isolation.** `runSubagent()` builds a whole second agent — fresh message list, fresh `SessionState`, its own `SkillLibrary.spawn()`, a `readonly` gate for `explore` and the parent's gate for `work` — runs one `runTurn()` inside it, then folds its token spend back into the parent's totals and returns a capped report. Shares the parent's `CheckpointStore` and approval sets so there is exactly one rollback boundary and one approval story. The child registry drops `task` (no nesting) and `remember` (memory belongs to the conversation), and the child runs with `subagent: null`. Its UI is quiet but relays every event to the parent's listener, so the terminal prints dim nested lines and the browser draws a nested card. |
| `src/tools/task.ts`         | 92    | The delegation tool: validates the brief (rejecting one too vague to delegate), calls `ctx.subagent`, and formats the report with a header of steps / tool calls / tokens / seconds. Deliberately dumb — all construction lives in the runtime, so disabling sub-agents means not registering this tool at all. |
| `src/agent/checkpoint.ts`   | 375   | `CheckpointStore`: captures a file's bytes before a tool mutates it (first capture per turn wins), writes one manifest + a mirrored file tree per turn under `.agent/checkpoints/<id>/`, and restores a turn — deleting files the agent created — while checkpointing the state it leaves, so a rollback is itself reversible. Atomic `.tmp` + `rename` writes, path-escape checks on both the backup slot and the restore target, prune-to-`keep`, `clear()`, `sizeBytes()`. |

### Memory (cross-session learning)

| File                        | Lines | Responsibility                                                     |
| --------------------------- | ----- | ------------------------------------------------------------------ |
| `src/memory/lessons.ts`     | 220   | `LessonStore`: append-only JSONL at `.agent/memory/lessons.jsonl`, dedup by normalised text, keyword-overlap ranking (tags and path-like tokens weigh more), score-based trust, `vote`/`remove`, and `renderBlockWithIds()` which returns the injected block *plus* the ids behind it so feedback has a target. |
| `src/tools/remember.ts`     | 79    | One tool, three modes: `{text, tags?}` saves, `{query}` searches, `{forget}` deletes. Registered only when memory is enabled. |

### Web server & browser UI (`lca serve`)

| File                        | Lines | Responsibility                                                     |
| --------------------------- | ----- | ------------------------------------------------------------------ |
| `src/server/http.ts`        | 505   | `node:http` server — no framework. Static files jailed inside `web/`, optional token auth on `/api/*`, CORS for local tools, and every endpoint: `events` (SSE), `state`, `health`, `chat`, `interrupt`, `permission`, `permissions`, `model`, `skill`, `clear`, `undo`, `compact`, `memory` (+`vote`, DELETE), `feedback`, `checkpoints`, `restore`. Reports the port it actually bound, and `closeAllConnections()` so Ctrl+C does not hang on keep-alive sockets. |
| `src/server/session.ts`     | 240   | `WebSession`: one `AgentRuntime`, many tabs. Subscribes to `UIEvent`s and fans them out over SSE, heartbeats every 25s, sends a full `snapshot()` to late joiners, serialises turns (`send`/`interrupt`), and reports `isBusy`. |
| `src/server/web-prompter.ts`| 110   | Bridges the blocking `await ui.ask()` inside the loop to an asynchronous browser answer: each request becomes a promise parked in a `Map` keyed by UUID; `POST /api/permission` resolves it. Timeout and `cancelAll` both resolve to **deny**. |
| `web/index.html`            | 145   | App shell: topbar, sidebar (plan / skills / memory), transcript, composer, permission dialog, token dialog. Semantic, no framework. |
| `web/styles.css`            | 829   | Design tokens (8px scale, one accent, AA-contrast text), dark theme, responsive at 900px, `prefers-reduced-motion`, visible focus rings, reserved heights so streaming cannot shift the layout. |
| `web/app.js`                | 1194  | The whole client: one `EventSource` drives rendering (streaming markdown, tool cards, plan/skills/memory panels, permission + token dialogs, 👍/👎 feedback, model and mode switching). Escapes every untrusted string before it reaches the DOM; no `alert`/`confirm`/`prompt`, so it works inside sandboxed iframes. |

### Safety & UI

| File                       | Lines | Responsibility                                                      |
| -------------------------- | ----- | ------------------------------------------------------------------- |
| `src/safety/paths.ts`      | 90    | Workspace jail, sensitive-path detection, ignore lists, truncation, binary sniffing. |
| `src/safety/permissions.ts`| 132   | `ask`/`auto`/`readonly` policy, hard-deny regex list, session-scoped "always" approvals. |
| `src/ui/ui.ts`             | 317   | All output: streaming text, spinner, tool trace, diffs, approval hook. Injectable sink for tests. Every method also emits a typed `UIEvent` to an optional `listener` — that is how the web UI mirrors the agent without the core knowing about it. |
| `src/util/ansi.ts`         | 36    | ANSI colour helpers. No `chalk`.                                     |
| `src/util/diff.ts`         | 89    | LCS line diff with context collapsing.                               |
| `src/util/session.ts`      | 29    | Per-session state: approvals, counters, plan, token totals.          |

### Tests (248, no model required)

| File                        | Tests | Covers                                                              |
| --------------------------- | ----- | ------------------------------------------------------------------- |
| `tests/loop.test.ts`        | 11    | End-to-end agent runs: happy path, prose-JSON recovery, arg aliases, error feedback, loop breaker, readonly denial, catastrophic command block, real bash execution, step limit, plan injection. |
| `tests/server.test.ts`      | 34    | `WebPrompter` (round-trip, timeout→deny, no-client default, `cancelAll`), static serving + path-traversal jail, 405/404s, `/api/state`, token auth, `/api/health`, a full turn over real SSE, late-joiner snapshots, the permission gate answered over HTTP (yes / no / expiry), mode + model switching, clear/undo/interrupt, memory CRUD and feedback, and the checkpoint endpoints (snapshot, the `checkpoint` event over SSE, restore by id and by prefix, restore-of-a-restore, the 404/400 paths, clear). |
| `tests/subagent.test.ts`    | 16    | The context-isolation measurement itself (two 4,000-char reads cost the parent <800 tokens and their bytes never appear in its transcript), token totals folding, `explore` refusing a write, `work` writing inside the *parent's* checkpoint and rolling back with it, no-nesting proved by recording the tool schema each generation was offered, `[sub-agent]` permission labelling, abort propagation, the step cap, report truncation, event relay order, `SkillLibrary.spawn()` isolation, the task tool's vague-brief refusal and disabled path, registration following `LCA_SUBAGENTS`, and the child prompt's read-only wording. |
| `tests/checkpoint.test.ts`  | 25    | Capture/restore for modified and newly-created files, first-capture-wins across three writes to one file, capture with and without preloaded content, no-op turns leaving nothing on disk, `discard()`, manifest persistence and reload, newest-first listing, pruning, a crash-corrupted manifest, `clear()`, size accounting, restore-of-a-restore, the `restoredAt` marker surviving a reload, a missing backup leaving the file untouched, a `../` capture attempt that is dropped rather than written, dotted filenames, and six runtime integrations (write, edit, create-then-delete, read-only turn, an aborted turn still reversible, the config switch). |
| `tests/memory.test.ts`      | 21    | Saving, dedup, empty-text refusal, JSONL persistence, truncated-line recovery, voting, forgetting, recall ranking (tags, limits, sunk memories), the injection block, the `remember` tool, and runtime integration (injection, `remember` registration, system prompt). |
| `tests/skills.test.ts`      | 69    | Frontmatter parsing, discovery + override precedence, index compactness, body capping, the 23-case routing table, `use_skill` (load, no-double-pay, resource jail), auto-injection, `/clear` forgetting. |
| `tests/tools.test.ts`       | 26    | Every tool: read/write/edit/list/search/todo, including fuzzy indentation, ambiguity, deletion, globbing, workspace escape. |
| `tests/agent-core.test.ts`  | 15    | Compaction, token estimation, diff, arg normalisation, system prompt content. |
| `tests/safety.test.ts`      | 12    | Path jail and all permission modes including the hard-deny list.    |
| `tests/repair.test.ts`      | 11    | Tool-call recovery from fenced/bare/stringified JSON, and false-positive rejection. |
| `tests/stream-filter.test.ts`    | 8     | Prose JSON hidden from display, ordinary code fences untouched, reveal-on-false-positive. |
| `tests/helpers.ts`          | —     | Temp-dir sandbox, silent UI, config/runtime/tool-context factories (opens a real `LessonStore` when memory is enabled). |

---

## Design decisions

**Zero runtime dependencies.** Only Node built-ins (`fetch`, `fs/promises`, `child_process`,
`readline/promises`, `path`, `os`, `http`). Installs in seconds, works offline, and nothing breaks
when a maintainer unpublishes a package. Cost: we hand-roll ANSI colours, arg parsing, grep, diff, a
YAML-subset parser and an HTTP+SSE server — about 1,200 lines that would otherwise be nine
dependencies. The browser side stays framework-free for the same reason: three files you can
`view-source:` and edit.

**`LLMProvider` is an interface, not Ollama.** The loop, tools, safety and UI have no idea Ollama
exists. That is why the mock provider can drive the entire test suite, and why adding a cloud
provider later is a 50-line file.

**Tools return errors, never throw.** `registry.invoke()` wraps everything in try/catch. A failure
becomes an observation the model can read and react to. This is the mechanism behind self-correction:
model reads a missing file → gets "No such file, use search" → calls search → finds it → proceeds.

**Compaction is deterministic.** No LLM summarisation pass. On a 7B model that costs seconds and can
invent facts. A log of files touched and commands run is free and cannot lie.

**The path jail is a single choke point.** Every file tool calls `checkPath()` before touching disk.
One function to audit, one function to test, no way to forget it in a new tool.

**Hard-deny applies even in `auto` mode.** `--yolo` should mean "do not bother me about normal
commands", not "let the model format my disk". `rm -rf /`, `sudo`, `mkfs`, fork bombs, `curl | sh`
and force-push are refused unconditionally.

**Skills use progressive disclosure because the context window is the budget.** Ten skill bodies
total ~10,000 tokens; a 7B model has 8,192. So the system prompt carries only names and one-line
purposes (~450 tokens), bodies load on demand and only once per conversation, and deep detail sits in
`references/*.md` fetched only if needed. Three levels, and the model never pays for expertise it is
not using.

**Skill routing is deterministic, not model-driven.** Asking a 7B model to pick one of ten skills
costs a full round-trip (5-30s locally) and it often picks badly. A keyword score decides the clear
cases in microseconds and injects the skill *before the first model call*; genuinely ambiguous
requests fall through and the model chooses with `use_skill`. The routing table is a test
(`tests/skills.test.ts`), so editing a trigger list cannot silently break routing.

**Small-model robustness is a first-class layer, not an afterthought.** `repair.ts`,
`arg-aliases.ts`, the fuzzy matcher in `edit-file.ts` and `stream-filter.ts` exist purely because
local models are sloppier than frontier ones. If you only read four files to understand what makes a
*local* agent different from a cloud one, read those.

**Memory is recall, not training.** Nothing fine-tunes anything — a 7B model on a laptop cannot be
usefully fine-tuned, and the user-visible benefit people want from "training" is *the agent
remembering corrections*. So memories are plain text in a JSONL file, ranked by keyword overlap
rather than embeddings (free, instant, offline, explainable, and enough for a few hundred entries),
and injected as a bracketed note. Being able to read and edit the file is the feature: "why did it do
that?" has an answer.

**Checkpoints capture at the moment of mutation, and the first capture wins.** Snapshotting the whole
workspace before a turn would be expensive and mostly wasted; snapshotting inside the two tools that
mutate files costs nothing extra, because both had already read the file for their diff. Keeping only
the first backup per file per turn is the single rule that makes a restore land on the *pre-turn*
state instead of an intermediate one. And because `restore()` checkpoints the state it is about to
leave, rolling back is reversible — which is why neither UI needs a confirmation dialog for it. Scope
is stated rather than implied: `write_file` and `edit_file` are covered, `bash` is not, and the system
prompt says so instead of letting the model promise a universal undo.

**One event bus, two frontends.** `UI` emits typed `UIEvent`s to an optional `listener` *and* writes
to the terminal. The REPL and the browser are consumers of the same stream, so no rendering logic is
duplicated and the core never learns that a browser exists. The corollary is a rule worth keeping:
presentation flags (`quiet`, `verbose`, TTY-ness) may change what is *printed*, never what is
*emitted* — two real bugs came from exactly that.

**SSE, not WebSockets.** Server→browser traffic is a stream; browser→server traffic is ordinary
`POST`s. SSE is a content type, survives proxies, reconnects by itself, and needs no upgrade
handshake. The permission bridge is what makes it sufficient: the blocking `await ui.ask()` inside
the loop parks a promise in a map, and an HTTP call resolves it seconds later. **Timeouts deny** — an
unattended web agent must never fall open.

**Sub-agents are context isolation, not parallelism.** A laptop runs one local model at a time, so
delegation never buys concurrency — it buys *capacity*. The valuable property is that twenty file reads
happen in the child's window and only a capped report enters the parent's, which is why the isolation is
asserted with a measurement (two 4,000-char reads must cost the parent under 800 tokens and their bytes
must not appear in its transcript) rather than a structural claim. Three invariants keep the feature
from becoming a hazard: **no nesting** (the child is never offered `task`, and runs with
`subagent: null` — enforced twice so recursion is structurally impossible), **read-only by default**
(`explore` gets a `readonly` gate whatever the parent's mode, so delegation can never escalate
privilege), and **one rollback boundary** (the child shares the parent's `CheckpointStore`, because two
interleaved undo histories is a thing no user can reason about). The tool itself is deliberately dumb:
all construction lives in the runtime, so `LCA_SUBAGENTS=false` removes the tool from the model's schema
entirely and the prompt stops mentioning it — you pay zero tokens for a feature you switched off.

---

## Message protocol

What actually goes to Ollama, in order:

```jsonc
[
  { "role": "system",    "content": "<environment + rules + skills index + memory count + AGENTS.md>" },
  { "role": "user",      "content": "[remembered from earlier sessions]\n- Use pnpm, never npm\n- Named exports only" },
  { "role": "user",      "content": "add validation to signup.ts" },
  { "role": "assistant", "content": "Let me look first.",
                         "tool_calls": [{ "function": { "name": "read_file",
                                                        "arguments": { "path": "src/signup.ts" } } }] },
  { "role": "tool",      "tool_name": "read_file", "content": "src/signup.ts · 42 lines\n  1\t..." },
  { "role": "assistant", "content": "Found it. Fixing now.",
                         "tool_calls": [{ "function": { "name": "edit_file", "arguments": { ... } } }] },
  { "role": "tool",      "tool_name": "edit_file", "content": "Edited src/signup.ts." },
  { "role": "assistant", "content": "Done — validation added and tests pass." }
]
```

The invariant: **every assistant message containing `tool_calls` must be followed by one
`role: "tool"` message per call.** Compaction is careful never to break that pairing.

The recalled-memory message is injected *before* your text and always starts with `[`, which is how
`undoLast()` and the compactor know it is machinery rather than something you typed. An auto-loaded
skill and the periodic plan re-injection use the same convention.

The turn ends when the assistant message has no `tool_calls`.
