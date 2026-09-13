import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { getList, getString, parseFrontmatter } from '../src/skills/frontmatter.js';
import { discoverSkills, BUNDLED_SKILLS_DIR } from '../src/skills/loader.js';
import { SkillLibrary } from '../src/skills/library.js';
import { route } from '../src/skills/router.js';
import { useSkillTool } from '../src/tools/use-skill.js';
import { buildSystemPrompt } from '../src/agent/context.js';
import { makeContext, makeRuntime, makeSandbox, testConfig, type Sandbox } from './helpers.js';
import { MockProvider } from '../src/llm/mock.js';
import type { ToolContext } from '../src/tools/types.js';
import type { Skill } from '../src/skills/types.js';

let box: Sandbox;
let ctx: ToolContext;

beforeEach(async () => {
  box = await makeSandbox();
  ctx = (await makeContext(box.dir)).ctx;
});
afterEach(async () => {
  await box.cleanup();
});

/* ------------------------------------------------------------------ */

describe('frontmatter parser', () => {
  it('reads scalars and inline arrays', () => {
    const { data, body } = parseFrontmatter('---\nname: code\ndescription: Does things\ntriggers: [a, b, c]\n---\n# Body here\n');
    expect(getString(data, 'name')).toBe('code');
    expect(getString(data, 'description')).toBe('Does things');
    expect(getList(data, 'triggers')).toEqual(['a', 'b', 'c']);
    expect(body).toBe('# Body here');
  });

  it('reads block lists', () => {
    const { data } = parseFrontmatter('---\nname: x\ntriggers:\n  - one\n  - two words\n---\nbody');
    expect(getList(data, 'triggers')).toEqual(['one', 'two words']);
  });

  it('strips quotes and tolerates CRLF', () => {
    const { data } = parseFrontmatter('---\r\nname: "quoted"\r\n---\r\nbody\r\n');
    expect(getString(data, 'name')).toBe('quoted');
  });

  it('treats a file with no frontmatter as pure body', () => {
    const { data, body } = parseFrontmatter('# Just markdown\n\nNo frontmatter here.');
    expect(data).toEqual({});
    expect(body).toContain('Just markdown');
  });

  it('ignores unterminated frontmatter instead of eating the file', () => {
    const { data, body } = parseFrontmatter('---\nname: broken\nbody still here');
    expect(getString(data, 'name')).toBe('');
    expect(body).toContain('broken');
  });

  it('skips comments and blank lines', () => {
    const { data } = parseFrontmatter('---\n# a comment\n\nname: ok\n---\nb');
    expect(getString(data, 'name')).toBe('ok');
  });
});

/* ------------------------------------------------------------------ */

describe('skill discovery', () => {
  it('finds the bundled skills that ship with the package', async () => {
    const { skills } = await discoverSkills(box.dir);
    const names = skills.map((s) => s.name);
    for (const expected of ['code', 'design', 'debug', 'test', 'git', 'docs', 'review', 'refactor', 'explain', 'security']) {
      expect(names).toContain(expected);
    }
    for (const s of skills) {
      expect(s.body.length).toBeGreaterThan(200);
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.triggers.length).toBeGreaterThan(3);
      expect(path.resolve(s.dir)).toBe(path.resolve(s.dir)); // sanity
    }
  });

  it('never loads the same directory twice', async () => {
    // Running inside this repo makes <workspace>/skills identical to the bundled dir.
    const { skills, problems } = await discoverSkills(BUNDLED_SKILLS_DIR);
    const names = skills.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(problems.filter((p) => p.includes('overrides'))).toHaveLength(0);
  });

  it('lets a project skill override a bundled one', async () => {
    await box.write(
      '.agent/skills/code/SKILL.md',
      '---\nname: code\ndescription: Project-specific coding rules\ntriggers: [implement]\n---\n# Our way\nDo it the house style.\n',
    );
    const { skills } = await discoverSkills(box.dir);
    const code = skills.find((s) => s.name === 'code');
    expect(code?.source).toBe('project');
    expect(code?.body).toContain('house style');
  });

  it('skips a skill folder with no SKILL.md and reports it', async () => {
    await box.write('.agent/skills/broken/notes.txt', 'not a skill');
    const { problems } = await discoverSkills(box.dir);
    expect(problems.some((p) => p.includes('broken') && p.includes('no SKILL.md'))).toBe(true);
  });

  it('skips an empty SKILL.md', async () => {
    await box.write('.agent/skills/empty/SKILL.md', '---\nname: empty\n---\n\n');
    const { skills } = await discoverSkills(box.dir);
    expect(skills.map((s) => s.name)).not.toContain('empty');
  });

  it('derives a name and description when frontmatter is missing', async () => {
    await box.write('.agent/skills/bare.md', '# Bare skill\n\nThis one has no frontmatter at all.\n');
    const { skills } = await discoverSkills(box.dir);
    const bare = skills.find((s) => s.name === 'bare');
    expect(bare).toBeTruthy();
    expect(bare?.description).toContain('no frontmatter');
  });

  it('lists bundled resources but not SKILL.md itself', async () => {
    await box.write('.agent/skills/withres/SKILL.md', '---\nname: withres\ndescription: has a resource\n---\nbody');
    await box.write('.agent/skills/withres/references/deep.md', '# deep\n');
    const { skills } = await discoverSkills(box.dir);
    const s = skills.find((x) => x.name === 'withres');
    expect(s?.resources).toContain('references/deep.md');
    expect(s?.resources).not.toContain('SKILL.md');
  });
});

/* ------------------------------------------------------------------ */

describe('SkillLibrary', () => {
  it('renders a compact index that never leaks a skill body', async () => {
    const lib = await SkillLibrary.create(box.dir);
    const index = lib.renderIndex();
    expect(index).toContain('- code:');
    expect(index).toContain('- design:');
    expect(index).toContain('tok]');
    // The whole point of progressive disclosure: bodies stay out of the prompt.
    expect(index).not.toContain('Non-negotiables');
    expect(index).not.toContain('60-30-10');
    expect(index.length).toBeLessThan(2600);
  });

  it('is far cheaper than inlining every skill', async () => {
    const lib = await SkillLibrary.create(box.dir);
    const indexChars = lib.renderIndex().length;
    const allBodies = lib.all().reduce((n, s) => n + s.body.length, 0);
    expect(allBodies / indexChars).toBeGreaterThan(10);
  });

  it('returns an empty index when disabled', async () => {
    const lib = await SkillLibrary.create(box.dir, { enabled: false });
    expect(lib.enabled).toBe(false);
    expect(lib.count).toBe(0);
    expect(lib.renderIndex()).toBe('');
  });

  it('loads a body and marks it loaded', async () => {
    const lib = await SkillLibrary.create(box.dir);
    expect(lib.isLoaded('design')).toBe(false);
    const loaded = lib.load('design');
    expect(loaded?.skill.name).toBe('design');
    expect(loaded?.text).toContain('Contrast is not optional');
    expect(lib.isLoaded('design')).toBe(true);
    expect(lib.loadedNames()).toContain('design');
  });

  it('caps an oversized body and says so', async () => {
    const lib = await SkillLibrary.create(box.dir, { maxBodyChars: 400 });
    const loaded = lib.load('security');
    expect(loaded?.truncated).toBe(true);
    expect((loaded?.text.length ?? 0)).toBeLessThanOrEqual(600);
    expect(loaded?.text).toContain('truncated');
  });

  it('returns null for an unknown skill', async () => {
    const lib = await SkillLibrary.create(box.dir);
    expect(lib.load('nope')).toBeNull();
    expect(lib.get('nope')).toBeUndefined();
  });

  it('normalises skill names with spaces or capitals', async () => {
    const lib = await SkillLibrary.create(box.dir);
    expect(lib.get('Design')?.name).toBe('design');
    expect(lib.get(' design ')?.name).toBe('design');
  });

  it('forgetAll resets loaded state after /clear', async () => {
    const lib = await SkillLibrary.create(box.dir);
    lib.load('code');
    expect(lib.loadedNames()).toHaveLength(1);
    lib.forgetAll();
    expect(lib.loadedNames()).toHaveLength(0);
  });

  it('honours extra skill dirs', async () => {
    await box.write('custom/extra/SKILL.md', '---\nname: extra\ndescription: from an extra dir\n---\nbody');
    const lib = await SkillLibrary.create(box.dir, { extraDirs: [path.join(box.dir, 'custom')] });
    expect(lib.get('extra')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */

describe('router', () => {
  let lib: SkillLibrary;
  let skills: Skill[];

  beforeEach(async () => {
    lib = await SkillLibrary.create(box.dir);
    skills = lib.all();
  });

  const ROUTES: Array<[string, string | null]> = [
    ['make the signup button look nicer, the layout breaks on mobile', 'design'],
    ['the test suite is failing with "Cannot read properties of undefined"', 'debug'],
    ['add a function that parses a CSV file into rows', 'code'],
    ['review this PR before I merge it', 'review'],
    ['explain what this repository does', 'explain'],
    ['write a good commit message and rebase onto main', 'git'],
    ['check the search endpoint for SQL injection vulnerabilities', 'security'],
    ['refactor this giant function into smaller ones', 'refactor'],
    ['write unit tests for the parser', 'test'],
    ['update the README install instructions', 'docs'],
    ['fix the bug where login fails for new users', 'debug'],
    ['the build is broken after the merge', 'debug'],
    ['add tests for the new csv parser', 'test'],
    ['make this component accessible on mobile', 'design'],
    ['write a docstring for the parseConfig function', 'docs'],
    ['harden the auth flow against token leakage', 'security'],
    ['rename this helper and extract the duplicated logic', 'refactor'],
    ['create a git tag for the v1.2 release', 'git'],
    ['use the design skill and rebuild the navbar', 'design'],
  ];

  it.each(ROUTES)('routes "%s" to %s', (message, expected) => {
    const decision = route(message, skills);
    expect(decision.pick?.name ?? null).toBe(expected);
  });

  it('defers to the model on an off-topic request', () => {
    expect(route('what is the weather in Lahore', skills).pick).toBeNull();
    expect(route('what is the weather in Lahore', skills).confidence).toBe('none');
  });

  it('defers to the model on a genuinely ambiguous request', () => {
    const d = route('is this diff safe to merge?', skills);
    expect(d.pick).toBeNull();
    expect(d.confidence).toBe('weak');
  });

  it('treats an explicit skill request as decisive', () => {
    expect(route('use the design skill please', skills).pick?.name).toBe('design');
    expect(route('load the security skill', skills).pick?.name).toBe('security');
  });

  it('does not let a bare skill name hijack a sentence', () => {
    // "test" is the skill name, but this is a debugging request.
    expect(route('the test keeps crashing on startup', skills).pick?.name).toBe('debug');
  });

  it('prefers a specific multi-word trigger over an incidental single word', () => {
    expect(route('please add unit tests for this', skills).pick?.name).toBe('test');
  });

  it('supports regex triggers', () => {
    const fake: Skill[] = [
      {
        name: 'sql',
        description: 'database work',
        triggers: ['/\\b(postgres|mysql|sqlite)\\b/i'],
        source: 'project',
        path: '/x/SKILL.md',
        dir: '/x',
        resources: [],
        bodyTokens: 10,
        body: 'body',
      },
    ];
    expect(route('tune this postgres query', fake).pick?.name).toBe('sql');
    expect(route('nothing relevant here', fake).pick).toBeNull();
  });

  it('returns nothing when there are no skills', () => {
    expect(route('anything', []).pick).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe('use_skill tool', () => {
  async function ctxWithSkills(maxBodyChars = 12000): Promise<ToolContext> {
    const lib = await SkillLibrary.create(box.dir, { maxBodyChars });
    return { ...ctx, skills: lib };
  }

  it('loads a skill body with usage instructions', async () => {
    const c = await ctxWithSkills();
    const res = await useSkillTool.run({ name: 'design' }, c);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('Skill loaded: design');
    expect(res.content).toContain('Contrast is not optional');
    expect(res.data?.skill).toBe('design');
  });

  it('refuses to pay for the same skill twice', async () => {
    const c = await ctxWithSkills();
    await useSkillTool.run({ name: 'code' }, c);
    const second = await useSkillTool.run({ name: 'code' }, c);
    expect(second.content).toMatch(/already in your context/);
    expect(second.content.length).toBeLessThan(300);
  });

  it('lists what exists when the name is wrong', async () => {
    const c = await ctxWithSkills();
    const res = await useSkillTool.run({ name: 'designn' }, c);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('design');
  });

  it('reads a bundled resource', async () => {
    await box.write('.agent/skills/res/SKILL.md', '---\nname: res\ndescription: has resources\n---\nbody');
    await box.write('.agent/skills/res/references/palette.md', '# Palette\nUse #0ea5e9 for primary.\n');
    const c = await ctxWithSkills();
    const res = await useSkillTool.run({ name: 'res', resource: 'references/palette.md' }, c);
    expect(res.content).toContain('#0ea5e9');
  });

  it('refuses a resource path that escapes the skill folder', async () => {
    await box.write('.agent/skills/res2/SKILL.md', '---\nname: res2\ndescription: x\n---\nbody');
    await box.write('secret.txt', 'do not read');
    const c = await ctxWithSkills();
    const res = await useSkillTool.run({ name: 'res2', resource: '../../secret.txt' }, c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/outside/i);
  });

  it('refuses a resource that is not part of the skill', async () => {
    const c = await ctxWithSkills();
    const res = await useSkillTool.run({ name: 'code', resource: 'nope.md' }, c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/No resource/);
  });

  it('degrades gracefully when skills are disabled', async () => {
    const res = await useSkillTool.run({ name: 'code' }, { ...ctx, skills: null });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not available/);
  });

  it('requires a name', async () => {
    const c = await ctxWithSkills();
    expect((await useSkillTool.run({}, c)).isError).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('system prompt integration', () => {
  it('includes the skill index and the rules for using it', () => {
    const p = buildSystemPrompt({
      modelName: 'm',
      repoContext: 'x',
      customInstructions: '',
      toolNames: ['use_skill'],
      permissionMode: 'ask',
      skillsIndex: '- code: write code [~600 tok]\n- design: ui work [~900 tok]',
      skillsAutoRoute: true,
    });
    expect(p).toContain('<skills>');
    expect(p).toContain('- code: write code');
    expect(p).toContain('use_skill(name) ONCE');
    expect(p).toContain('auto-loaded');
    expect(p).toContain('Load at most one skill per task');
  });

  it('omits the whole block when there are no skills', () => {
    const p = buildSystemPrompt({
      modelName: 'm',
      repoContext: 'x',
      customInstructions: '',
      toolNames: [],
      permissionMode: 'ask',
    });
    expect(p).not.toContain('<skills>');
    expect(p).not.toContain('use_skill');
  });
});

/* ------------------------------------------------------------------ */

describe('runtime auto-routing', () => {
  it('injects the matching skill before the model ever runs', async () => {
    const { rt } = await makeRuntime(box.dir, [{ text: 'Done — used the design guidance.' }]);
    const result = await rt.send('make the button look nicer on mobile', new AbortController().signal);

    const injected = rt.messages.find((m) => m.role === 'user' && m.content.startsWith('[skill auto-loaded:'));
    expect(injected).toBeTruthy();
    expect(injected?.content).toContain('design');
    expect(injected?.content).toContain('Contrast is not optional');
    expect(rt.skills.loadedNames()).toContain('design');
    expect(result.answer).toContain('Done');
  });

  it('does not inject a skill for an unrelated request', async () => {
    const { rt } = await makeRuntime(box.dir, [{ text: 'ok' }]);
    await rt.send('what is 2 + 2', new AbortController().signal);
    expect(rt.messages.some((m) => m.content.startsWith('[skill auto-loaded:'))).toBe(false);
    expect(rt.skills.loadedNames()).toHaveLength(0);
  });

  it('never injects the same skill twice across turns', async () => {
    const { rt } = await makeRuntime(box.dir, [{ text: 'a' }, { text: 'b' }]);
    await rt.send('make the layout responsive on mobile', new AbortController().signal);
    await rt.send('now fix the button colour and spacing', new AbortController().signal);
    const injected = rt.messages.filter((m) => m.content.startsWith('[skill auto-loaded: design'));
    expect(injected).toHaveLength(1);
  });

  it('can be switched off', async () => {
    const { rt } = await makeRuntime(box.dir, [{ text: 'ok' }], { skillsAutoRoute: false });
    await rt.send('make the button look nicer on mobile', new AbortController().signal);
    expect(rt.messages.some((m) => m.content.startsWith('[skill auto-loaded:'))).toBe(false);
  });

  it('preloadSkill forces a skill into context', async () => {
    const { rt } = await makeRuntime(box.dir, [{ text: 'ok' }]);
    expect(rt.preloadSkill('security')).toBe(true);
    expect(rt.messages.some((m) => m.content.startsWith('[skill loaded: security]'))).toBe(true);
    expect(rt.preloadSkill('does-not-exist')).toBe(false);
    expect(rt.preloadSkill('security')).toBe(true); // idempotent, no second injection
    expect(rt.messages.filter((m) => m.content.startsWith('[skill loaded: security]'))).toHaveLength(1);
  });

  it('registers use_skill only when skills exist', async () => {
    const { rt } = await makeRuntime(box.dir, [{ text: 'ok' }]);
    expect(rt.registry.has('use_skill')).toBe(true);
    expect(rt.systemPrompt).toContain('<skills>');
  });

  it('omits use_skill from the tool list when skills are disabled', async () => {
    const { rt } = await makeRuntime(box.dir, [{ text: 'ok' }], { skillsEnabled: false });
    expect(rt.registry.has('use_skill')).toBe(false);
    expect(rt.systemPrompt).not.toContain('<skills>');
  });

  it('the model can load a skill itself via the tool', async () => {
    const { rt } = await makeRuntime(box.dir, [
      { toolCalls: [{ name: 'use_skill', arguments: { name: 'refactor' } }] },
      { text: 'Refactored following the skill.' },
    ], { skillsAutoRoute: false });

    const result = await rt.send('tidy up this module', new AbortController().signal);
    const toolMsg = rt.messages.find((m) => m.role === 'tool' && m.tool_name === 'use_skill');
    expect(toolMsg?.content).toContain('Skill loaded: refactor');
    expect(rt.skills.loadedNames()).toContain('refactor');
    expect(result.answer).toContain('Refactored');
  });

  it('clearHistory forgets which skills were loaded', async () => {
    const { rt } = await makeRuntime(box.dir, [{ text: 'ok' }]);
    rt.preloadSkill('code');
    expect(rt.skills.loadedNames()).toContain('code');
    rt.clearHistory();
    expect(rt.skills.loadedNames()).toHaveLength(0);
  });

  it('reports loaded skills in the stats line', async () => {
    const { rt } = await makeRuntime(box.dir, [{ text: 'ok' }]);
    rt.preloadSkill('git');
    expect(rt.statsLine()).toContain('skills git');
  });

  it('keeps the skill index out of the way of a tiny context', async () => {
    const cfg = testConfig(box.dir, { numCtx: 4096 });
    const rt = await (await import('../src/agent/runtime.js')).AgentRuntime.create({
      ui: (await import('./helpers.js')).silentUI(),
      config: cfg,
      provider: new MockProvider([{ text: 'ok' }]),
      factory: () => new MockProvider([{ text: 'ok' }]),
    });
    // Index must stay small enough that a 4k window is still usable.
    expect(rt.skills.renderIndex().length).toBeLessThan(2600);
  });
});
