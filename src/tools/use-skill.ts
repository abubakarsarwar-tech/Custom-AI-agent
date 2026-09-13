import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkPath, truncate } from '../safety/paths.js';
import { fail, ok, str, type Tool, type ToolContext, type ToolResult } from './types.js';

export const useSkillTool: Tool = {
  name: 'use_skill',
  description:
    'Load a specialised skill and follow its instructions for the current task. ' +
    'Call this ONCE at the start of a task when one of the listed skills clearly matches — ' +
    'for example use_skill("design") before any UI/layout/colour work, or use_skill("debug") for a bug. ' +
    'Do not load more than one skill at a time and never reload one already in context. ' +
    'If no skill matches, just do the work normally. ' +
    'You can also pass resource="references/x.md" to read one file bundled with the skill.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name exactly as listed in the <skills> block.' },
      resource: {
        type: 'string',
        description: 'Optional: a file inside the skill folder to read instead of the whole skill.',
      },
    },
    required: ['name'],
  },
  risk: 'low',

  summarize: (args) => {
    const res = str(args, 'resource');
    return `${str(args, 'name')}${res ? ` → ${res}` : ''}`;
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const lib = ctx.skills;
    if (!lib || !lib.enabled || lib.count === 0) {
      return fail(
        'Skills are not available in this session. Ignore the <skills> block and complete the task with the other tools.',
      );
    }

    const name = str(args, 'name').trim();
    if (!name) return fail('use_skill requires a "name".');

    const skill = lib.get(name);
    if (!skill) {
      return fail(
        `No skill called "${name}". Available: ${lib.all().map((s) => s.name).join(', ')}.`,
      );
    }

    /* ---- optional: read one bundled resource instead of the whole skill ---- */
    const resource = str(args, 'resource').trim();
    if (resource) {
      // Jailed to the skill's own folder — a resource path must never escape it.
      const jail = skill.dir;
      const checked = checkPath(jail, resource);
      if (!checked.ok) {
        return fail(`Resource "${resource}" is outside the ${skill.name} skill folder.`);
      }
      if (!skill.resources.includes(checked.rel.replace(/\\/g, '/'))) {
        return fail(
          `No resource "${checked.rel}" in the ${skill.name} skill. Available: ${
            skill.resources.join(', ') || '(none)'
          }`,
        );
      }
      try {
        const body = await readFile(path.join(jail, checked.rel), 'utf8');
        return ok(
          `# ${skill.name} — resource: ${checked.rel}\n\n${truncate(
            body,
            ctx.config.maxOutputChars,
            'resource',
          )}`,
          { data: { skill: skill.name, resource: checked.rel } },
        );
      } catch {
        return fail(`Could not read resource ${checked.rel}.`);
      }
    }

    /* ---- already loaded? do not pay for it twice ---- */
    if (lib.isLoaded(skill.name)) {
      return ok(
        `The "${skill.name}" skill is already in your context from earlier in this conversation. ` +
          'Follow the instructions you were given then — do not reload it.',
        { data: { skill: skill.name, cached: true } },
      );
    }

    const loaded = lib.load(skill.name);
    if (!loaded) return fail(`Could not load skill "${name}".`);

    const header = [
      `# Skill loaded: ${loaded.skill.name}`,
      loaded.skill.resources.length > 0
        ? `Bundled resources you can read with use_skill(name="${loaded.skill.name}", resource="<path>"): ${loaded.skill.resources.join(', ')}`
        : '',
      'Follow these instructions for the rest of this task.',
    ]
      .filter(Boolean)
      .join('\n');

    ctx.ui.toolDetail(`loaded ${loaded.skill.bodyTokens} tokens of instructions`);

    return ok(`${header}\n\n${loaded.text}`, {
      data: { skill: loaded.skill.name, tokens: loaded.skill.bodyTokens, truncated: loaded.truncated },
    });
  },
};
