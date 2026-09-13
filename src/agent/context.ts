import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isIgnoredName } from '../safety/paths.js';

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 5000, maxBuffer: 1024 * 256 }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

const STACK_MARKERS: Array<[string, string]> = [
  ['package.json', 'Node.js / TypeScript or JavaScript'],
  ['tsconfig.json', 'TypeScript'],
  ['pyproject.toml', 'Python (pyproject)'],
  ['requirements.txt', 'Python (requirements.txt)'],
  ['go.mod', 'Go'],
  ['Cargo.toml', 'Rust'],
  ['pom.xml', 'Java (Maven)'],
  ['build.gradle', 'Java/Kotlin (Gradle)'],
  ['composer.json', 'PHP (Composer)'],
  ['Gemfile', 'Ruby'],
  ['CMakeLists.txt', 'C/C++ (CMake)'],
];

function readScripts(pkgPath: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return Object.entries(pkg.scripts ?? {})
      .slice(0, 14)
      .map(([k, v]) => `${k}: ${v}`);
  } catch {
    return [];
  }
}

/**
 * Everything the model needs to orient itself, gathered ONCE per session.
 * This is the cheapest way to make a small local model behave like it
 * understands your repo: hand it the map up front instead of making it
 * burn five tool calls discovering it.
 */
export async function buildRepoContext(workspace: string): Promise<{
  text: string;
  isGit: boolean;
  gitBranch: string;
}> {
  const lines: string[] = [];

  lines.push(`Workspace: ${workspace}`);
  lines.push(`OS: ${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`);
  lines.push(`Shell: ${process.env.SHELL ?? (os.platform() === 'win32' ? 'cmd.exe' : 'sh')}`);
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`User: ${os.userInfo().username}`);

  // git state
  const isGit = existsSync(path.join(workspace, '.git'));
  let gitBranch = '';
  if (isGit) {
    gitBranch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], workspace);
    const status = await run('git', ['status', '--porcelain=v1', '-b'], workspace);
    lines.push(`Git branch: ${gitBranch || '(unknown)'}`);
    if (status) {
      const short = status.split('\n').slice(0, 15).join('\n');
      lines.push(`Git status:\n${short}`);
    } else {
      lines.push('Git status: clean');
    }
  } else {
    lines.push('Git: not a git repository');
  }

  // stack detection
  const detected = STACK_MARKERS.filter(([file]) => existsSync(path.join(workspace, file)));
  if (detected.length > 0) {
    lines.push(`Detected stack: ${detected.map(([, label]) => label).join(', ')}`);
  }

  // top-level layout
  try {
    const entries = (await import('node:fs/promises')).readdir(workspace, { withFileTypes: true });
    const dirs: string[] = [];
    const files: string[] = [];
    for (const e of await entries) {
      if (isIgnoredName(e.name)) continue;
      if (e.isDirectory()) dirs.push(`${e.name}/`);
      else files.push(e.name);
    }
    lines.push(`Top level: ${[...dirs.sort(), ...files.sort()].slice(0, 40).join('  ')}`);
  } catch {
    /* ignore */
  }

  // npm scripts are the fastest route to "how do I build/test this thing"
  const pkgPath = path.join(workspace, 'package.json');
  if (existsSync(pkgPath)) {
    const scripts = readScripts(pkgPath);
    if (scripts.length > 0) lines.push(`package.json scripts:\n  ${scripts.join('\n  ')}`);
  }

  return { text: lines.join('\n'), isGit, gitBranch };
}

/**
 * The <skills> block is built separately so the system-prompt template stays
 * readable — and so the index can never leak a full skill body into the prompt.
 */
function renderSkillsBlock(input: {
  skillsIndex?: string;
  skillsAutoRoute?: boolean;
}): string {
  if (!input.skillsIndex) return '';

  const lines: string[] = [
    '<skills>',
    'You have specialised skills. To save context, only their names and purposes are listed here — full instructions are loaded on demand.',
    '',
    input.skillsIndex,
    '',
    'How to use them:',
    '- If one clearly matches the request and is NOT already loaded, call use_skill(name) ONCE before doing any work, then follow its instructions.',
  ];
  if (input.skillsAutoRoute) {
    lines.push(
      '- Some turns arrive with a "[skill auto-loaded: ...]" block already injected for you. When that happens do NOT call use_skill again — just follow the instructions in it.',
    );
  }
  lines.push(
    '- Load at most one skill per task. Never reload a skill already in context.',
    '- If nothing matches, ignore this block and work normally. Do not force a skill.',
    '- A skill is guidance, not a cage: if it conflicts with what the code actually needs, do the right thing and say why in one line.',
    '</skills>',
    '',
    '',
  );
  return lines.join('\n');
}

/** One line, only when rollback exists — keeps the prompt honest about safety. */
function renderCheckpointLine(enabled?: boolean): string {
  if (!enabled) return '';
  return (
    'Rollback: every file you change with write_file or edit_file is snapshotted before the change, ' +
    'so the user can revert the whole turn. Mention that once after a risky change. It is not a reason ' +
    'to skip asking permission, and it does not cover shell commands.'
  );
}

/**
 * Delegation guidance, built as plain lines rather than a nested template so the
 * system-prompt template stays readable.
 */
function renderSubagentBlock(enabled?: boolean): string {
  if (!enabled) return '';
  return [
    '<subagents>',
    'task(prompt, kind) delegates a job to a sub-agent with its OWN fresh context window. Only its short report comes back to you — the files it read stay in its window, not yours.',
    'Delegate when: answering needs many searches or many file reads ("find every place X is used"), or the question is self-contained and you do not need its workings.',
    'Do NOT delegate when: the job needs this conversation, it is one file you could read yourself, or the user should watch you make the edit — do those yourself.',
    'Rules: one job per call, they run one at a time, and the sub-agent cannot see this conversation or ask you anything. Write a complete brief: what to find, where to look, what the report must contain.',
    'kind="explore" (default) is read-only. kind="work" may edit files, and each edit still asks the user for permission.',
    'Never delegate to avoid doing the work, and never invent a report you did not receive.',
    '</subagents>',
    '',
    '',
  ].join('\n');
}

export function buildSystemPrompt(input: {
  modelName: string;
  repoContext: string;
  customInstructions: string;
  toolNames: string[];
  permissionMode: string;
  /** Compact skill index: name + one-line purpose + token cost. Never full bodies. */
  skillsIndex?: string;
  skillsAutoRoute?: boolean;
  memoryEnabled?: boolean;
  memoryCount?: number;
  checkpointsEnabled?: boolean;
  subagentsEnabled?: boolean;
}): string {
  return `You are LCA (Local Code Agent), an interactive CLI coding agent built for software engineering.
You run 100% on the user's own laptop through Ollama — model "${input.modelName}". Nothing is sent to the cloud.

<environment>
${input.repoContext}
</environment>

<capabilities>
You can read, search, create and edit files, and run shell commands inside the workspace via tools.
Available tools: ${input.toolNames.join(', ')}.
Permission mode: "${input.permissionMode}" — in "ask" mode the user approves risky actions; a tool may come back with "Not allowed". If that happens, do NOT retry the same call; explain what you need and move on.
${renderCheckpointLine(input.checkpointsEnabled)}
</capabilities>

<operating_rules>
1. Act, don't narrate. Never describe an edit you could make — make it with a tool call. Never paste a full file into chat when you can write_file it.
2. Read before you edit. Always read_file (or search) a file before changing it. Editing from memory produces broken patches.
3. Prefer search over reading. To find where something is used, call search — do not read every file in the tree.
4. Make it actually work. Write complete, runnable code. No placeholders, no "...", no "rest of code here", no stubbed TODOs unless the user explicitly asked for a skeleton.
5. Verify your work. After changing code, run the project's typecheck/build/tests with bash when they exist. Read the errors and fix them. Repeat until green.
6. Small, surgical edits. Use edit_file for targeted changes with 2-4 lines of surrounding context so the match is unique. Use write_file only for new files or genuine full rewrites.
7. Stay in the workspace. Never reference absolute paths outside it; file tools are jailed and will reject escapes.
8. Multi-step work needs a plan. If a task takes more than ~3 tool calls, call todo_write first, keep exactly one item in_progress, and update it as you go.
9. One tool call per turn when the next step depends on the result. Parallel-style batching only when calls are independent.
10. Stop when you're done. When the task is complete, reply with a short plain-text summary and make NO tool call — that ends the turn.
11. Never invent results. If a command failed or a file is missing, say so plainly and fix it.
</operating_rules>

<output_style>
- Be brief. A few sentences, not an essay. The user is a developer watching a terminal.
- No preamble ("Sure, I'll..."), no restating the question, no emoji.
- Use markdown only for short code snippets and file paths in backticks.
- When you finish, summarise: what changed, which files, how it was verified, and anything left for the user.
- If you are blocked or need a decision, ask one specific question instead of guessing.
</output_style>

${renderSkillsBlock(input)}${renderSubagentBlock(input.subagentsEnabled)}${
  input.memoryEnabled
    ? `<memory>
You have a persistent memory of this project (${input.memoryCount ?? 0} fact${(input.memoryCount ?? 0) === 1 ? '' : 's'} stored), kept in .agent/memory/lessons.jsonl.
- Earlier turns may include a "[remembered from earlier sessions]" block. Treat those as project rules unless the code proves one wrong.
- When the user corrects you, states a convention, or you discover something non-obvious that will matter again, save it with remember(text, tags).
- Phrase a memory as a short rule ("Use pnpm, never npm install"), one fact per call.
- Never store secrets, tokens, passwords, or one-off task details.
</memory>

`
    : ''
}<local_model_discipline>
You are a small model with a limited context window, so be economical:
- Emit tool calls in the exact JSON schema given. Arguments must be valid JSON strings.
- Do not wrap tool calls in prose or markdown fences — the harness reads them directly.
- Do not repeat an identical failing call. Change the approach after one failure.
- When quoting existing code in old_text, copy it verbatim from read_file output and drop the line-number prefix.
</local_model_discipline>
${input.customInstructions ? `\n${input.customInstructions}\n` : ''}`;
}
