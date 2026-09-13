/**
 * Tiny ANSI helpers. No chalk dependency: this project has ZERO runtime deps
 * on purpose, so it installs fast and never breaks on a laptop offline.
 */
const enabled =
  !process.env.NO_COLOR &&
  (process.env.FORCE_COLOR === '1' || (process.stdout.isTTY ?? false) || process.env.LCA_FORCE_COLOR === '1');

function wrap(code: number, reset = 39) {
  return (s: string): string => (enabled ? `\u001b[${code}m${s}\u001b[${reset}m` : s);
}

export const c = {
  reset: wrap(0, 0),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  white: wrap(37),
  gray: wrap(90),
  bgYellow: wrap(43, 49),
  bgRed: wrap(41, 49),
};

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
