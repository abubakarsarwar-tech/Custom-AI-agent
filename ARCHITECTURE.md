# Architecture

Every file, what it does, and why it exists. ~4,400 lines of TypeScript, **zero runtime
dependencies** (dev-only: `typescript`, `tsx`, `vitest`, `@types/node`).

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
| `src/index.ts`          | 210   | Shebang entry. Dispatches `repl`/`run`/`demo`/`doctor`/`models`. Handles EPIPE, SIGINT, pre-flight Ollama check. |
| `src/cli/args.ts`       | 158   | Hand-rolled flag parser (no `commander` dependency) + help text.           |
| `src/cli/repl.ts`       | 275   | Interactive REPL: readline, slash commands, `@file` mentions, `!shell`, Ctrl+C abort. |
| `src/cli/prompt.ts`     | 40    | The y/n/always approval prompt, shared by REPL and one-shot mode.          |
| `src/cli/mentions.ts`   | 67    | Expands `@path/to/file` into attached `<file>` blocks.                     |
| `src/config.ts`         | 172   | Layered config: defaults → `.agent/config.json` → env → CLI. Loads `AGENTS.md`. |
| `src/doctor.ts`         | 210   | Environment health check + RAM-aware model recommendation table.           |

### Agent core

| File                         | Lines | Responsibility                                                       |
| ---------------------------- | ----- | -------------------------------------------------------------------- |
| `src/agent/loop.ts`          | 271   | **The agent loop.** Read this first. Compaction, plan injection, streaming, tool dispatch, loop breakers, step limit. |
| `src/agent/runtime.ts`       | 147   | Stateful container across turns. `send()`, `setModel()`, `clearHistory()`, `undoLast()`, `compactNow()`, `statsLine()`. |
| `src/agent/context.ts`       | 159   | Builds the environment block (OS, git, stack, tree, scripts) and the system prompt. |
| `src/agent/compact.ts`       | 125   | Replaces old turns with a deterministic action log when near the context budget. |
| `src/agent/stream-filter.ts` | 81    | Hides prose-JSON tool calls from the display while streaming.         |
| `src/agent/plan.ts`          | 50    | `PlanStore` — the agent's todo list, rendered back into context.      |
| `src/agent/tokens.ts`        | 37    | `chars / 3.5` estimation. No tokenizer dependency.                    |

### Model layer

| File                | Lines | Responsibility                                                                |
| ------------------- | ----- | ----------------------------------------------------------------------------- |
| `src/llm/types.ts`  | 71    | `Message`, `ToolCall`, `ToolSpec`, `StreamEvent`, `LLMProvider`. OpenAI-shaped because that is what Ollama implements. |
| `src/llm/ollama.ts` | 239   | Streaming `/api/chat` client. NDJSON parsing, tool-call extraction, usage stats, `pingOllama`, `listModels`. |
| `src/llm/mock.ts`   | 128   | Scripted provider for tests and `npm run demo`. Includes a "sloppy" mode that emits prose JSON. |
| `src/llm/repair.ts` | 202   | Recovers tool calls printed as text: brace-depth JSON scanner, alias keys, lenient JSON parsing. |

### Tools

| File                      | Lines | Responsibility                                                          |
| ------------------------- | ----- | ----------------------------------------------------------------------- |
| `src/tools/types.ts`      | 78    | `Tool` / `ToolResult` / `ToolContext` interfaces + arg coercion helpers that tolerate sloppy model output. |
| `src/tools/registry.ts`   | 82    | Name → tool map, schema export, and `invoke()` which converts every throw into an error result. |
| `src/tools/read-file.ts`  | 85    | `cat -n` output, offset/limit, binary detection, size cap.              |
| `src/tools/edit-file.ts`  | 236   | Exact → whitespace-tolerant match, ambiguity detection, indent restoration, closest-region hint on failure. |
| `src/tools/write-file.ts` | 77    | Create/overwrite with `mkdir -p`, diff for the UI.                      |
| `src/tools/list-dir.ts`   | 109   | Tree with sizes, depth cap, skips `node_modules`/`.git`/`dist`.         |
| `src/tools/search.ts`     | 160   | Regex/literal grep in pure TS with glob filtering and result caps.      |
| `src/tools/bash.ts`       | 139   | `spawn` with shell, timeout kill, output caps, exit code reporting.     |
| `src/tools/todo.ts`       | 86    | Plan tool; tolerates status words like `done`/`DOING`.                  |
| `src/tools/arg-aliases.ts`| 139   | `file_path`→`path`, `cmd`→`command`, stringy booleans → real booleans.  |

### Safety & UI

| File                       | Lines | Responsibility                                                      |
| -------------------------- | ----- | ------------------------------------------------------------------- |
| `src/safety/paths.ts`      | 90    | Workspace jail, sensitive-path detection, ignore lists, truncation, binary sniffing. |
| `src/safety/permissions.ts`| 132   | `ask`/`auto`/`readonly` policy, hard-deny regex list, session-scoped "always" approvals. |
| `src/ui/ui.ts`             | 186   | All output: streaming text, spinner, tool trace, diffs, approval hook. Injectable sink for tests. |
| `src/util/ansi.ts`         | 36    | ANSI colour helpers. No `chalk`.                                     |
| `src/util/diff.ts`         | 89    | LCS line diff with context collapsing.                               |
| `src/util/session.ts`      | 29    | Per-session state: approvals, counters, plan, token totals.          |

### Tests (83, no model required)

| File                        | Tests | Covers                                                              |
| --------------------------- | ----- | ------------------------------------------------------------------- |
| `tests/loop.test.ts`        | 11    | End-to-end agent runs: happy path, prose-JSON recovery, arg aliases, error feedback, loop breaker, readonly denial, catastrophic command block, real bash execution, step limit, plan injection. |
| `tests/tools.test.ts`       | 26    | Every tool: read/write/edit/list/search/todo, including fuzzy indentation, ambiguity, deletion, globbing, workspace escape. |
| `tests/agent-core.test.ts`  | 15    | Compaction, token estimation, diff, arg normalisation, system prompt content. |
| `tests/safety.test.ts`      | 12    | Path jail and all permission modes including the hard-deny list.    |
| `tests/repair.test.ts`      | 11    | Tool-call recovery from fenced/bare/stringified JSON, and false-positive rejection. |
| `tests/stream-filter.test.ts`    | 8     | Prose JSON hidden from display, ordinary code fences untouched, reveal-on-false-positive. |
| `tests/helpers.ts`          | —     | Temp-dir sandbox, silent UI, config/runtime factories.              |

---

## Design decisions

**Zero runtime dependencies.** Only Node built-ins (`fetch`, `fs/promises`, `child_process`,
`readline/promises`, `path`, `os`). Installs in seconds, works offline, and nothing breaks when a
maintainer unpublishes a package. Cost: we hand-roll ANSI colours, arg parsing, grep and diff — about
400 lines that would otherwise be four dependencies.

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

**Small-model robustness is a first-class layer, not an afterthought.** `repair.ts`,
`arg-aliases.ts`, the fuzzy matcher in `edit-file.ts` and `stream-filter.ts` exist purely because
local models are sloppier than frontier ones. If you only read four files to understand what makes a
*local* agent different from a cloud one, read those.

---

## Message protocol

What actually goes to Ollama, in order:

```jsonc
[
  { "role": "system",    "content": "<environment + rules + AGENTS.md>" },
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

The turn ends when the assistant message has no `tool_calls`.
