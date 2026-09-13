import type { AgentConfig, PermissionMode, ProviderName } from '../config.js';

export interface ParsedArgs {
  command: 'repl' | 'run' | 'doctor' | 'models' | 'help' | 'demo';
  prompt: string;
  overrides: Partial<AgentConfig>;
  quiet: boolean;
  verbose: boolean;
  interactive: boolean;
  help: boolean;
  mockScript?: 'demo' | 'sloppy';
}

const HELP = `
lca — a local coding agent that runs entirely on your laptop

USAGE
  lca                          start the interactive REPL in the current folder
  lca run "fix the failing test"   one-shot task, then exit
  lca doctor                   check Ollama, RAM and recommend a model
  lca models                   list models already pulled locally
  lca demo                     run a scripted end-to-end demo with NO model

FLAGS
  -m, --model <tag>        Ollama model tag        (default qwen2.5-coder:7b)
      --provider <name>    ollama | mock
      --url <url>          Ollama base URL         (default http://127.0.0.1:11434)
      --ctx <n>            context window tokens   (default 8192)
  -t, --temperature <n>    sampling temperature    (default 0.1)
  -w, --workspace <dir>    project root the agent is jailed to (default cwd)
      --max-steps <n>      max tool rounds per turn (default 25)
      --yolo               permission mode "auto": never ask, just do it
      --readonly           permission mode "readonly": no writes, no shell
      --ask                permission mode "ask" (default)
  -q, --quiet              print only the final answer (for pipes)
  -v, --verbose            show tool output and diffs
  -h, --help               this text

ENVIRONMENT (same knobs, useful in .env or your shell profile)
  LCA_MODEL LCA_OLLAMA_URL LCA_NUM_CTX LCA_TEMPERATURE LCA_MAX_STEPS
  LCA_PERMISSION_MODE LCA_PROVIDER LCA_WORKSPACE LCA_BASH_TIMEOUT_MS

IN THE REPL
  /help /model <tag> /models /plan /tools /permissions <mode> /stats
  /compact /clear /undo-last /exit
  @path/to/file   attach a file to your message
  !git status     run a shell command without the model
  Ctrl+C          interrupt the current turn
`;

function toNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: 'repl',
    prompt: '',
    overrides: {},
    quiet: false,
    verbose: false,
    interactive: false,
    help: false,
  };

  const positional: string[] = [];
  let i = 0;
  const next = (): string | undefined => argv[++i];

  while (i < argv.length) {
    const a = argv[i] as string;
    switch (a) {
      case 'run':
      case 'doctor':
      case 'models':
      case 'demo':
      case 'help':
        if (positional.length === 0 && out.command === 'repl') out.command = a as ParsedArgs['command'];
        else positional.push(a);
        break;
      case '-m':
      case '--model':
        out.overrides.model = next() ?? '';
        break;
      case '--provider':
        out.overrides.provider = (next() ?? 'ollama') as ProviderName;
        break;
      case '--url':
        out.overrides.ollamaUrl = next() ?? '';
        break;
      case '--ctx':
        out.overrides.numCtx = toNumber(next(), 8192);
        break;
      case '-t':
      case '--temperature':
        out.overrides.temperature = toNumber(next(), 0.1);
        break;
      case '-w':
      case '--workspace':
        out.overrides.workspace = next() ?? process.cwd();
        break;
      case '--max-steps':
        out.overrides.maxSteps = toNumber(next(), 25);
        break;
      case '--yolo':
      case '--auto':
        out.overrides.permissionMode = 'auto' as PermissionMode;
        break;
      case '--readonly':
      case '--read-only':
        out.overrides.permissionMode = 'readonly' as PermissionMode;
        break;
      case '--ask':
        out.overrides.permissionMode = 'ask' as PermissionMode;
        break;
      case '-q':
      case '--quiet':
        out.quiet = true;
        break;
      case '-v':
      case '--verbose':
        out.verbose = true;
        break;
      case '--yes':
      case '-y':
        out.overrides.permissionMode = 'auto' as PermissionMode;
        break;
      case '--sloppy':
        out.mockScript = 'sloppy';
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        if (a.startsWith('-')) {
          process.stderr.write(`unknown flag: ${a}\n`);
        } else {
          positional.push(a);
        }
        break;
    }
    i += 1;
  }

  out.prompt = positional.join(' ').trim();
  if (out.command === 'run' && !out.prompt) {
    process.stderr.write('lca run needs a prompt. Example: lca run "add input validation to signup.ts"\n');
    out.help = true;
  }
  return out;
}

export function helpText(): string {
  return HELP;
}
