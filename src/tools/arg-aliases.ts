/**
 * Local models routinely invent argument names ("file_path" instead of "path",
 * "cmd" instead of "command"). Instead of failing the call and burning a whole
 * extra round-trip, translate the common aliases into the canonical schema.
 */
const ALIASES: Record<string, Record<string, string>> = {
  read_file: {
    file_path: 'path',
    file: 'path',
    filename: 'path',
    filepath: 'path',
    target: 'path',
    start_line: 'offset',
    line_offset: 'offset',
    max_lines: 'limit',
    lines: 'limit',
    num_lines: 'limit',
  },
  write_file: {
    file_path: 'path',
    file: 'path',
    filename: 'path',
    filepath: 'path',
    target: 'path',
    text: 'content',
    data: 'content',
    contents: 'content',
    file_content: 'content',
    body: 'content',
    code: 'content',
  },
  edit_file: {
    file_path: 'path',
    file: 'path',
    filename: 'path',
    filepath: 'path',
    target: 'path',
    old_str: 'old_text',
    old: 'old_text',
    search: 'old_text',
    find: 'old_text',
    original_text: 'old_text',
    before: 'old_text',
    new_str: 'new_text',
    new: 'new_text',
    replace: 'new_text',
    replacement: 'new_text',
    after: 'new_text',
    replaceall: 'replace_all',
    replaceAll: 'replace_all',
    all: 'replace_all',
  },
  list_dir: {
    dir: 'path',
    directory: 'path',
    folder: 'path',
    target: 'path',
    file_path: 'path',
    max_depth: 'depth',
    levels: 'depth',
  },
  search: {
    query: 'pattern',
    regex: 'pattern',
    q: 'pattern',
    grep: 'pattern',
    search: 'pattern',
    text: 'pattern',
    include: 'glob',
    include_glob: 'glob',
    file_glob: 'glob',
    files: 'glob',
    glob_pattern: 'glob',
    dir: 'path',
    directory: 'path',
    path_glob: 'glob',
    literal_search: 'literal',
    is_regex: 'regex_mode',
    max_results_count: 'max_results',
    limit: 'max_results',
  },
  bash: {
    cmd: 'command',
    shell: 'command',
    script: 'command',
    run: 'command',
    exec: 'command',
    command_line: 'command',
    working_dir: 'cwd',
    dir: 'cwd',
    folder: 'cwd',
    timeout: 'timeout_ms',
    timeoutMs: 'timeout_ms',
  },
  todo_write: {
    items: 'todos',
    list: 'todos',
    tasks: 'todos',
    todo: 'todos',
    plan: 'todos',
    entries: 'todos',
  },
};

export function normalizeArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const map = ALIASES[tool];
  if (!map) return args;

  const out: Record<string, unknown> = { ...args };
  for (const [alias, canonical] of Object.entries(map)) {
    if (out[canonical] === undefined && out[alias] !== undefined) {
      out[canonical] = out[alias];
      delete out[alias];
    }
  }

  // "search" uses regex_mode only as a signal; translate to literal=false.
  if (tool === 'search' && out.regex_mode !== undefined) {
    out.literal = false;
    delete out.regex_mode;
  }

  // Booleans/numbers arriving as strings.
  for (const key of ['replace_all', 'literal', 'case_sensitive', 'clear']) {
    if (typeof out[key] === 'string') {
      const s = String(out[key]).toLowerCase();
      if (['true', 'yes', '1'].includes(s)) out[key] = true;
      else if (['false', 'no', '0'].includes(s)) out[key] = false;
    }
  }
  for (const key of ['offset', 'limit', 'depth', 'max_results', 'timeout_ms']) {
    if (typeof out[key] === 'string') {
      const n = Number(out[key]);
      if (Number.isFinite(n)) out[key] = n;
    }
  }

  return out;
}
