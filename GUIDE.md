# How to build your own local coding agent

A complete guide. It explains what this project does, how to run it on your laptop, and how to
build one yourself from an empty folder.

**Contents**

1. [What a coding agent actually is](#1-what-a-coding-agent-actually-is)
2. [Set up your laptop](#2-set-up-your-laptop)
3. [Run this project](#3-run-this-project)
4. [How each layer works](#4-how-each-layer-works)
5. [Build your own from scratch](#5-build-your-own-from-scratch)
6. [The hard part: making a small model behave](#6-the-hard-part-making-a-small-model-behave)
7. [Extending it](#7-extending-it)
8. [Roadmap: closing the gap with Claude Code](#8-roadmap-closing-the-gap-with-claude-code)
9. [Troubleshooting](#9-troubleshooting)
10. [Where to learn more](#10-where-to-learn-more)

---

## 1. What a coding agent actually is

Forget the marketing. A coding agent is **one loop**:

```
1. send the conversation + a list of tools to the model
2. the model replies with EITHER
     a) an answer               -> print it, stop
     b) a request to use a tool -> run the tool, append the result, go to 1
```

That is it. ChatGPT is step 1 without step 2b. An agent is step 2b repeated until the model stops
asking.

Three things make it *useful* rather than a toy:

| Piece             | Why it matters                                                        |
| ----------------- | --------------------------------------------------------------------- |
| **Tools**         | The model's hands. Read, write, edit, search, run commands.           |
| **A system prompt** | The model's job description and rules. This is 50% of the quality.  |
| **Context control** | Local models fit ~8k tokens. Manage it or the agent goes stupid.    |

Everything else in this repo — permissions, diffs, spinners, compaction, repair parsers — is
engineering around those three.

The loop lives in [`src/agent/loop.ts`](./src/agent/loop.ts). Read that file first; it is the whole
project in 270 lines.

---

## 2. Set up your laptop

### 2.1 Install Ollama

Ollama runs local models and exposes them over HTTP on `127.0.0.1:11434`. That is the only server
you need.

| OS          | Install                                                              |
| ----------- | -------------------------------------------------------------------- |
| macOS       | Download the `.dmg` from <https://ollama.com/download>                |
| Windows     | Download `OllamaSetup.exe` from the same page (needs WSL2 for GPU on some setups) |
| Linux       | `curl -fsSL https://ollama.com/install.sh \| sh`                      |

Then start it:

```bash
ollama serve          # macOS/Windows apps start it automatically
```

Check it is alive:

```bash
curl http://127.0.0.1:11434/api/tags
```

### 2.2 Check what your machine can handle

Model size is decided by **RAM** (or VRAM if you have a GPU). A quantised model needs roughly
`params × 0.6 GB` for weights, plus the KV cache which grows with context length.

```bash
# macOS
sysctl hw.memsize | awk '{print $2/1024/1024/1024 " GB"}'
# Linux
free -h | head -2
# Windows (PowerShell)
Get-CimInstance Win32_ComputerSystem | Select-Object @{n='GB';e={$_.TotalPhysicalMemory/1GB}}
```

Or just run `npm run doctor` — it does this for you and recommends a model.

### 2.3 Pull a model

```bash
ollama pull qwen2.5-coder:7b      # 4.7 GB, the sensible default on 16 GB RAM
```

Current picks by hardware (verified against 2026 roundups
[[1]](https://localaimaster.com/models/best-local-ai-coding-models)
[[2]](https://www.claudemarket.ai/blog/best-ollama-models-2026)
[[3]](https://localaimaster.com/blog/best-ollama-models-for-agents)):

| RAM / VRAM | Model                        | Tool calls | Why                                                |
| ---------- | ---------------------------- | ---------- | -------------------------------------------------- |
| 8 GB       | `qwen2.5-coder:3b`           | no         | fits anywhere, light edits only                     |
| 8–16 GB    | `qwen2.5-coder:7b`           | no         | the dependable budget coder (88% HumanEval)         |
| 12–16 GB   | `qwen3:8b`                   | **yes**    | ~5 GB, native tools — best 8 GB-class agent model   |
| 16–24 GB   | `gpt-oss:20b`                | **yes**    | MoE (~3.6B active), fast, strong reasoning          |
| 24 GB      | `devstral-small:24b`         | **yes**    | Mistral's agent-first model, reliable multi-file edits |
| 24–32 GB   | `qwen3-coder:30b`            | **yes**    | 30B MoE with only ~3B active, 256k native context — the strongest local coding agent model |
| 48 GB+     | `qwen2.5-coder:32b`          | no         | 92.7% HumanEval, dense, slow without a big GPU      |

> **The single most important column is "Tool calls".** With native support the model emits
> structured JSON that Ollama hands you as `message.tool_calls`. Without it, the model *prints* the
> JSON inside its answer and you have to parse it out yourself. Section 6 shows how we handle both.
> If you are choosing between a slightly bigger model without tools and a slightly smaller one with
> them — **take the tools**.

Model names move fast. Check what is current with `ollama search` or the
[Ollama library](https://ollama.com/search?c=tool).

### 2.4 Raise the context window

This trips up almost everyone. **Ollama defaults to 2048–4096 tokens**, no matter how big the model
is. An agent that reads two files blows straight through that and starts producing nonsense.

```bash
LCA_NUM_CTX=8192 npm run dev      # or 16384 / 32768 if you have the RAM
```

Cost: roughly 1 GB of RAM per 8k tokens on a 7B model. Set it as high as your machine tolerates.

---

## 3. Run this project

```bash
git clone <your-fork>
cd Custom-AI-agent
npm install

npm run doctor    # 1. health check: Node, RAM, Ollama, model, tool support
npm run demo      # 2. full agent run with NO model (scripted mock provider)
npm test          # 3. 83 tests, also no model needed
npm run dev       # 4. the real thing
```

Try these first tasks, easiest to hardest:

```
> what does this project do? read the README and summarise it
> @src/config.ts explain what each option does
> add a /version slash command to the REPL
> write a test for the truncate() function in src/safety/paths.ts and make it pass
```

Watch what happens in the terminal:

```
● I'll look at the project structure first.          <- model text, streamed
⚒ list_dir . (depth 2)                               <- tool call
  ✔ list_dir · 12ms
⚒ read_file README.md                                <- another tool call
  ✔ read_file · 3ms
● This is a TypeScript CLI that...                   <- final answer
  model qwen2.5-coder:7b · context ~4.2k/8192 tok · steps 3
```

---

## 4. How each layer works

### Layer 1 — The provider (`src/llm/`)

One interface, two implementations:

```ts
export interface LLMProvider {
  readonly name: string;
  stream(messages: Message[], tools: ToolSpec[], opts?): AsyncGenerator<StreamEvent>;
}
```

- **`ollama.ts`** — POSTs to `/api/chat` with `stream: true` and parses the NDJSON response line by
  line. Emits `delta` events as tokens arrive, then `tool_calls`, then `done` with usage.
- **`mock.ts`** — replays a scripted conversation. This is why the test suite needs no model, and
  why `npm run demo` works on a machine with nothing installed.
- **`repair.ts`** — recovers tool calls the model printed as prose instead of calling properly.
- **`types.ts`** — the `Message` / `ToolCall` / `ToolSpec` shapes. They follow the OpenAI tool format
  because that is what Ollama implements.

Because everything depends on the interface and not on Ollama, you can add a cloud provider later
without touching the agent.

### Layer 2 — The tools (`src/tools/`)

Each tool is an object with a JSON schema (what the model sees) and a `run` function (what happens):

```ts
export interface Tool {
  readonly name: string;
  readonly description: string;      // <- this is a prompt. Write it well.
  readonly parameters: JsonSchema;
  readonly risk: 'low' | 'medium' | 'high';
  run(args, ctx): Promise<ToolResult>;
  summarize(args): string;           // one line for the UI + approval prompt
}
```

| Tool          | Risk | Purpose                                                  |
| ------------- | ---- | -------------------------------------------------------- |
| `read_file`   | low  | `cat -n` style output with offset/limit                   |
| `search`      | low  | regex across the repo, `path:line: text` results          |
| `list_dir`    | low  | project tree with sizes, skips `node_modules`/`.git`      |
| `edit_file`   | med  | surgical search-and-replace, whitespace-tolerant          |
| `write_file`  | med  | create or fully rewrite a file                            |
| `bash`        | high | run any command, with timeout and output caps             |
| `todo_write`  | low  | the agent's own task list                                 |

Two rules I followed, and you should too:

**Tool descriptions are prompts.** The model only knows what a tool does from `description`. "Read a
file" is bad. "Read a text file and return it with line numbers. The line numbers are NOT part of
the file — never include them in old_text. ALWAYS read a file before editing it" is good. Every
sentence in there exists because a model got it wrong.

**Never throw out of a tool.** Return `{ content: "...error...", isError: true }`. A thrown error
kills the loop; a returned error becomes an observation the model can react to. Watch a run where
the model reads a missing file: it reads the error, then calls `search` to find the right path. That
self-correction only works because failures are data, not exceptions.

### Layer 3 — The loop (`src/agent/loop.ts`)

Per turn:

1. Compact history if it is near the context limit
2. Re-inject the plan if the run is getting long
3. Stream from the model, filtering prose JSON out of the display
4. If tool calls came back → execute each, append results as `role: "tool"` messages, loop
5. Otherwise → the model answered, the turn is over

Four guards keep it from running away:

| Guard                        | What it stops                                              |
| ---------------------------- | ---------------------------------------------------------- |
| `maxSteps` (25)              | infinite loops                                             |
| identical-call detector (3×) | a model re-issuing one failing call forever                |
| consecutive-error cap (4)    | thrashing; it forces the model to explain itself instead   |
| `AbortSignal` on Ctrl+C      | a turn you want to stop now                                |

### Layer 4 — Safety (`src/safety/`)

- **`paths.ts`** — the jail. Every file tool resolves its path and refuses anything outside the
  workspace, including `../../etc/passwd`. Credential files are flagged.
- **`permissions.ts`** — the policy. Three modes (`ask`/`auto`/`readonly`) plus a hard-deny list that
  applies even in `auto` mode: `rm -rf /`, `rm -rf ~`, `sudo`, `mkfs`, `dd of=/dev/…`, fork bombs,
  `curl | sh`, `git push --force`, `chmod 777 /`.

Run the agent on a real repo in `ask` mode until you trust it. `--readonly` is genuinely useful for
"explain this codebase" tasks — it *cannot* break anything.

### Layer 5 — Context (`src/agent/`)

- **`context.ts`** — builds the environment block once per session: OS, shell, date, git branch and
  status, detected stack, top-level tree, `package.json` scripts, plus your `AGENTS.md`. Handing the
  model this map up front saves five tool calls of flailing.
- **`compact.ts`** — when history exceeds the budget, the oldest turns are replaced by a **factual
  action log**: files read, files changed, commands run, searches, conclusions. Deliberately *not*
  an LLM-generated summary: on a 7B model that costs seconds and can hallucinate. A log of what
  actually happened is cheaper and cannot lie.
- **`tokens.ts`** — `chars / 3.5`. No tokenizer dependency. Over-estimating is the right bias: we
  compact slightly early instead of overflowing.
- **`plan.ts`** — the todo list, re-injected every few steps so the model does not drift.

---

## 5. Build your own from scratch

Do this even if you just want to use this repo. Writing the 90-line version is what makes the rest
click.

Create `mini-agent.mjs`:

```js
import { readFile, writeFile } from "node:fs/promises";

const OLLAMA = "http://127.0.0.1:11434";
const MODEL = "qwen2.5-coder:7b";

// 1. Tell the model what it can do. This schema IS the API contract.
const tools = [
  { type: "function", function: {
      name: "read_file",
      description: "Read a file and return its exact contents.",
      parameters: { type: "object",
        properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: {
      name: "write_file",
      description: "Write a complete file, creating it if needed.",
      parameters: { type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"] } } },
];

// 2. Actually do the thing.
async function runTool(name, args) {
  if (name === "read_file") return await readFile(args.path, "utf8");
  if (name === "write_file") {
    if (!confirm(`Write ${args.path}? `)) return "DENIED by user";
    await writeFile(args.path, args.content, "utf8");
    return `Wrote ${args.path}`;
  }
  return `Unknown tool: ${name}`;
}

// 3. The system prompt is half the quality. Be specific.
const messages = [
  { role: "system", content:
`You are a coding agent running on the user's laptop.
Use your tools instead of describing changes. Read a file before editing it.
Write complete, working code — never placeholders.
When the task is done, reply with a short summary and call no tools.` },
  { role: "user", content: process.argv[2] ?? "what files are here?" },
];

// 4. THE LOOP. This is the entire concept of an agent.
for (let step = 0; step < 10; step++) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, messages: messages, tools,
      stream: false, options: { temperature: 0.1, num_ctx: 8192 },
    }),
  });
  const data = await res.json();
  const msg = data.message;
  messages.push(msg);                                  // keep history intact

  if (!msg.tool_calls?.length) {                       // <-- no tools = done
    console.log("\n" + msg.content);
    break;
  }

  for (const call of msg.tool_calls) {
    const name = call.function.name;
    const args = call.function.arguments;
    console.log(`  [tool] ${name} ${JSON.stringify(args).slice(0, 80)}`);
    const out = await runTool(name, args);
    messages.push({ role: "tool", content: out, tool_name: name });
  }
}
```

Run it:

```bash
node mini-agent.mjs "create a file greet.js that prints hello, then run it"
```

**You now have a working coding agent.** Then grow it, one step at a time, in this order — each step
fixes a problem you will hit within minutes of using it:

| # | Add this              | Problem it solves                                            |
|---|-----------------------|--------------------------------------------------------------|
| 1 | `edit_file` tool      | rewriting a 400-line file to change one line is slow and lossy |
| 2 | `bash` tool           | the agent cannot run tests or git, so it cannot verify anything |
| 3 | `search` + `list_dir` | reading every file to find one function wastes your whole context |
| 4 | Streaming             | waiting 40s staring at nothing feels broken                  |
| 5 | Permission prompts    | you will not dare run it on a real repo without them         |
| 6 | Path jail             | the first time it writes to `../` you will understand        |
| 7 | Tool-call repair      | your model prints JSON instead of calling tools              |
| 8 | Arg aliases           | your model sends `file_path` when the schema says `path`     |
| 9 | Fuzzy `edit_file`     | your model's indentation is off by two spaces, edit fails    |
| 10| Compaction            | after ~15 tool calls the model forgets the task              |
| 11| Loop breaker          | it calls the same failing tool forever                       |
| 12| Plan re-injection     | it drifts off-task on long runs                              |

Steps 7–12 are section 6. They are the difference between a demo and something you use daily.

---

## 6. The hard part: making a small model behave

Claude and GPT-4 were trained for agentic tool use on frontier hardware. A 7B model on your laptop
was not. These six tricks close most of the gap. All are implemented here — copy them.

### 6.1 Recover tool calls printed as prose

Half the local models "call a tool" like this:

    Sure! Let me create that file.
    ```json
    {"name": "write_file", "arguments": {"path": "a.txt", "content": "hi"}}
    ```

Native function calling never fired. If you only read `message.tool_calls`, your agent silently does
nothing.

**Fix:** scan the assistant's text for balanced JSON objects whose `name`/`tool`/`function` field
matches a real tool, parse the args, and execute them. See
[`src/llm/repair.ts`](./src/llm/repair.ts). Details that matter:

- Match against the known tool list, or you will "execute" example JSON from the model's prose.
- Parse with a brace-depth scanner that understands strings, so `{` inside a string literal does not
  confuse it.
- Handle `arguments` arriving as a JSON *string* instead of an object.
- Strip the recovered JSON from the displayed text ([`stream-filter.ts`](./src/agent/stream-filter.ts))
  so the user does not watch a wall of JSON scroll past.

### 6.2 Translate invented argument names

Models send `file_path`, `filepath`, `target`, `filename` when your schema says `path`. They send
`cmd` for `command`, `old_str` for `old_text`.

**Fix:** an alias table applied before execution
([`src/tools/arg-aliases.ts`](./src/tools/arg-aliases.ts)). Also coerce `"true"` → `true` and
`"12"` → `12`. One lookup table removes a huge class of failures. Never let a call fail just because
of a naming preference.

### 6.3 Tolerate wrong whitespace in edits

The single most common failure in a home-built agent: the model sends `old_text` with the wrong
indentation, exact string matching fails, and the whole task dies.

**Fix:** try exact first; on failure retry with each line trimmed and trailing whitespace stripped.
Then re-indent the replacement to match the file. See
[`src/tools/edit-file.ts`](./src/tools/edit-file.ts). Also:

- Refuse ambiguous matches and tell the model *which lines* matched, so it can add context.
- When nothing matches, print the closest region so it can self-correct.
- Treat `new_text: ""` as "delete these lines", not "insert a blank line".

### 6.4 Raise `num_ctx` and manage it

Ollama's default context is tiny. Set `num_ctx` to 8k–32k, then compact when you approach it. Keep
the system prompt and the last ~8 messages verbatim; replace older turns with a factual log of files
touched and commands run.

Never cut between an assistant `tool_calls` message and its `role: "tool"` results — some models
break on that dangling pair. [`compact.ts`](./src/agent/compact.ts) skips forward past orphan tool
results.

### 6.5 Re-inject the plan

Small models forget what they were doing. Have a `todo_write` tool, and every few steps push the
current plan back into the conversation as a reminder. Measurably improves completion on tasks over
~10 tool calls.

### 6.6 Write the prompt like a job description

Vague prompts waste your context budget. The system prompt in
[`src/agent/context.ts`](./src/agent/context.ts) works because it is specific and ordered:

- State what it is and where it runs (workspace, OS, git branch, date)
- Name the tools and the permission mode, including what a denial means
- Give numbered operating rules: *read before edit*, *search before reading everything*, *no
  placeholders*, *verify by running the tests*, *stop when done*
- Tell it how to format output (short, no preamble)
- Add a section for small-model discipline: exact JSON, no prose-wrapped calls, do not repeat a
  failing call

Then let the user override per-project with `AGENTS.md`.

---

## 7. Extending it

### Add a tool

1. Create `src/tools/my-tool.ts` exporting a `Tool` object (copy `read-file.ts`).
2. Add it to `ALL_TOOLS` in [`src/tools/registry.ts`](./src/tools/registry.ts).
3. If it mutates anything, add its name to `MUTATING_TOOLS` in
   [`src/safety/permissions.ts`](./src/safety/permissions.ts) and call
   `ctx.permissions.check(...)` inside `run`.
4. Write a test in `tests/tools.test.ts`.

Useful tools to add next: `delete_file`, `apply_patch` (unified diffs), `web_fetch` via a local
proxy, `git_commit`, `run_tests`, `find_symbol` via tree-sitter or LSP.

### Add a cloud provider

Implement `LLMProvider` for the Anthropic or OpenAI API and return it from `defaultProviderFactory`
in [`src/agent/runtime.ts`](./src/agent/runtime.ts). Nothing else changes — the loop, tools, safety
and UI are all provider-agnostic. (Keep it opt-in: the point of this project is that nothing leaves
your laptop.)

### Add an embedding / RAG layer

For big repos, `search` stops being enough. Pull `nomic-embed-text` (~270 MB), embed your files into
a local store (sqlite-vec or LanceDB), and add a `semantic_search` tool. Ollama exposes
`/api/embeddings`.

### Add MCP support

The [Model Context Protocol](https://modelcontextprotocol.io) is the standard for pluggable tools.
Adding an MCP client would let you use hundreds of community tools without writing them.

---

## 8. Roadmap: closing the gap with Claude Code

What this repo has today, and what to build next:

**Done**

- [x] Streaming agent loop with tool calling
- [x] 7 tools: read, write, edit, list, search, bash, plan
- [x] Permission modes + hard-deny list + workspace jail
- [x] Context compaction with a factual action log
- [x] Tool-call repair, argument aliases, fuzzy edits (small-model robustness)
- [x] Loop breakers and step limits
- [x] `@file` mentions, `!shell` passthrough, slash commands
- [x] `AGENTS.md` project rules
- [x] `doctor` with hardware-aware model recommendations
- [x] Mock provider + 83 tests that need no model

**Next, in the order I would build them**

- [ ] **Checkpointing** — snapshot changed files before each turn, `/undo` to roll back. The highest
      value safety feature you can add.
- [ ] **Sub-agents** — spawn a second agent with a fresh context for "explore this and report back".
      Beats compaction for large repos.
- [ ] **Smarter retrieval** — tree-sitter or LSP symbol lookup instead of regex grep.
- [ ] **Prompt caching** — Ollama re-evaluates the whole prefix each turn. Keeping the model warm
      (`keep_alive`) helps; a persistent KV cache would help much more.
- [ ] **Parallel tool calls** — run independent calls concurrently.
- [ ] **Session persistence** — save history to `.agent/history.jsonl`, resume with `--continue`.
- [ ] **Diff review mode** — show a patch and require approval before writing, like `git add -p`.
- [ ] **TUI** — a full-screen interface with panels instead of a scrolling log.
- [ ] **Editor integration** — an LSP server or a VS Code extension wrapping the same core.

---

## 9. Troubleshooting

| Symptom                                     | Cause & fix                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `Could not reach Ollama`                    | `ollama serve` is not running. Then `curl http://127.0.0.1:11434/api/tags`.  |
| `model "X" not found`                       | `ollama pull X`. Check spelling and the tag: `qwen2.5-coder:7b`, not `qwen-2.5-coder`. |
| Model rambles and never calls a tool        | It lacks native tool support and repair did not fire. Switch to `qwen3:8b`, or lower temperature to `0.0`. |
| Agent forgets the task after many steps     | Context overflow. Raise `LCA_NUM_CTX`, run `/compact`, or give it a smaller task. |
| Extremely slow first response               | The model is loading into RAM. Subsequent calls are fast. Raise `LCA_KEEP_ALIVE`. |
| Fast then suddenly slow, machine swaps      | The model does not fit. Drop to a smaller quantisation or a smaller model.    |
| `edit_file` says "not found" repeatedly     | The model is guessing instead of reading. Tell it: "read the file first, then edit". Fuzzy matching already handles indentation. |
| Writes are refused in one-shot mode         | `ask` mode with no terminal to answer. Use `--yolo` (or `--readonly` for analysis). |
| Answers cut off mid-sentence                | Output token cap or context exhaustion. Raise `num_ctx`; check `/stats`.      |
| Garbled output on Windows                   | Run inside Windows Terminal, not the legacy console.                          |
| Nothing happens, no error                   | Run with `-v` to see the tool trace and raw errors.                           |

Debug tools:

```bash
lca doctor                 # environment health
lca run -v "..."           # verbose: full tool output and diffs
curl http://127.0.0.1:11434/api/chat -d '{"model":"qwen2.5-coder:7b","messages":[{"role":"user","content":"hi"}],"stream":false}'
ollama ps                  # what is loaded in memory right now
```

---

## 10. Where to learn more

- [Ollama API docs](https://github.com/ollama/ollama/blob/main/docs/api.md) — `/api/chat`, tools, streaming
- [Ollama model library](https://ollama.com/search) — filter by the `tool` capability
- [Model Context Protocol](https://modelcontextprotocol.io) — the standard for pluggable agent tools
- [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents) —
  the best short read on agent design; the "augmented LLM" + loop pattern is exactly what this repo implements
- [OpenAI function calling guide](https://platform.openai.com/docs/guides/function-calling) — the tool
  schema format Ollama copied
- Local model roundups for current picks:
  [[1]](https://localaimaster.com/models/best-local-ai-coding-models)
  [[2]](https://www.claudemarket.ai/blog/best-ollama-models-2026)
  [[3]](https://localaimaster.com/blog/best-ollama-models-for-agents)
  [[4]](https://localaimaster.com/blog/best-ollama-models)

**The fastest way to learn this:** run `npm run demo`, then read
[`src/agent/loop.ts`](./src/agent/loop.ts) top to bottom, then
[`tests/loop.test.ts`](./tests/loop.test.ts) — the tests are executable documentation of every
behaviour described above.
