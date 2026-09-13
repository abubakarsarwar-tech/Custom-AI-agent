/* ============================================================
   LCA web UI — plain ES module. No framework, no build step.

   One EventSource stream drives everything: the server pushes
   typed events (assistant_delta, tool_start, permission_request,
   …) and this file renders them. Actions go back over fetch().

   Security note: every string that comes from the model, a tool,
   or a file passes through escapeHtml() before it touches the
   DOM. The markdown renderer below escapes first, then formats.
   ============================================================ */

/* ---------------- state ---------------- */

const state = {
  token: null,
  busy: false,
  connected: false,
  snapshot: null,
  streamText: '',
  streamEl: null,
  streamScheduled: false,
  toolsEl: null,
  lastAssistantEl: null,
  runningTools: [],
  permissionQueue: [],
  activePermission: null,
  subagentEl: null,
  subagentBody: null,
  stickToBottom: true,
  models: [],
  injectedLessons: [],
};

/* ---------------- dom ---------------- */

const $ = (id) => document.getElementById(id);

const el = {
  transcript: $('transcript'),
  welcome: $('welcome'),
  welcomeWs: $('welcome-ws'),
  composer: $('composer'),
  input: $('input'),
  send: $('btn-send'),
  stop: $('btn-stop'),
  clear: $('btn-clear'),
  undo: $('btn-undo'),
  panelBtn: $('btn-panel'),
  sidebar: $('sidebar'),
  stats: $('meta-stats'),
  mode: $('sel-mode'),
  model: $('sel-model'),
  modelName: $('model-name'),
  pillState: $('pill-state'),
  stateText: $('state-text'),
  planList: $('plan-list'),
  planCount: $('plan-count'),
  planEmpty: $('plan-empty'),
  skillList: $('skill-list'),
  skillsCount: $('skills-count'),
  memoryList: $('memory-list'),
  memoryCount: $('memory-count'),
  memoryEmpty: $('memory-empty'),
  cpList: $('cp-list'),
  cpCount: $('cp-count'),
  cpEmpty: $('cp-empty'),
  cpRestoreLast: $('cp-restore-last'),
  memoryForm: $('memory-form'),
  memoryInput: $('memory-input'),
  overlay: $('overlay'),
  permRisk: $('perm-risk'),
  permDetail: $('perm-detail'),
  permCommand: $('perm-command'),
  permYes: $('perm-yes'),
  permNo: $('perm-no'),
  permAlways: $('perm-always'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  tokenOverlay: $('token-overlay'),
  tokenInput: $('token-input'),
  tokenSave: $('token-save'),
};

/* ---------------- helpers ---------------- */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** The single gate between untrusted text and the DOM. */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent: never parses HTML
  return node;
}

function shortMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function scrollIfSticky() {
  if (state.stickToBottom) {
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }
}

el.transcript.addEventListener('scroll', () => {
  const distance = el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight;
  state.stickToBottom = distance < 80;
});

/* ---------------- markdown-lite ----------------
   Escapes the whole source first, then applies formatting to the
   escaped text. Code content is parked behind NUL placeholders so
   inline rules cannot corrupt it, then restored verbatim.        */

function renderMarkdown(src) {
  const fences = [];
  const inlines = [];

  let text = escapeHtml(src);

  // fenced code blocks
  text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    fences.push({ lang: lang || '', code: code.replace(/\n$/, '') });
    return `\u0000F${fences.length - 1}\u0000`;
  });

  // inline code
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    inlines.push(code);
    return `\u0000I${inlines.length - 1}\u0000`;
  });

  // links — only http(s), so javascript: URIs stay inert
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    if (!/^https?:\/\//i.test(href)) return m;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^###### (.*)$/gm, '<strong>$1</strong>')
    .replace(/^[ \t]*[-*] (.*)$/gm, '<span class="md-li">• $1</span>');

  // restore
  text = text.replace(/\u0000I(\d+)\u0000/g, (_m, i) => `<code>${inlines[Number(i)]}</code>`);
  text = text.replace(/\u0000F(\d+)\u0000/g, (_m, i) => {
    const f = fences[Number(i)];
    const label = f.lang ? `<span class="code-lang">${escapeHtml(f.lang)}</span>` : '';
    return `<pre>${label}<code>${f.code}</code></pre>`;
  });

  return text;
}

/** Colour added/removed lines in tool output, the way a diff reads. */
function renderDiffish(text) {
  return escapeHtml(text)
    .split('\n')
    .map((line) => {
      if (/^\+\+\+|^\+/.test(line)) return `<span class="add">${line}</span>`;
      if (/^---|^-/.test(line)) return `<span class="del">${line}</span>`;
      return line;
    })
    .join('\n');
}

/* ---------------- transcript ---------------- */

/** Where new transcript content belongs: inside a sub-agent, or at top level. */
function flowRoot() {
  return state.subagentBody ?? el.transcript;
}

function hideWelcome() {
  if (el.welcome && el.welcome.parentNode) el.welcome.remove();
}

function addUserMessage(text) {
  hideWelcome();
  const wrap = make('div', 'msg msg-user');
  wrap.appendChild(make('div', 'msg-head', 'You'));
  wrap.appendChild(make('div', 'bubble', text));
  el.transcript.appendChild(wrap);
  scrollIfSticky();
  return wrap;
}

function addAssistantMessage() {
  hideWelcome();
  const wrap = make('div', 'msg msg-assistant');
  const label = state.subagentBody ? 'sub-agent' : 'LCA';
  wrap.appendChild(make('div', 'msg-head', label));
  const bubble = make('div', 'bubble');
  wrap.appendChild(bubble);
  flowRoot().appendChild(wrap);
  state.streamEl = bubble;
  state.lastAssistantEl = wrap;
  state.streamText = '';
  scrollIfSticky();
  return wrap;
}

function paintStream() {
  state.streamScheduled = false;
  if (!state.streamEl) return;
  state.streamEl.innerHTML = renderMarkdown(state.streamText);
  scrollIfSticky();
}

function onDelta(text) {
  if (!state.streamEl) addAssistantMessage();
  state.streamText += text;
  // Coalesce bursts: one repaint per frame, not one per token.
  if (!state.streamScheduled) {
    state.streamScheduled = true;
    requestAnimationFrame(paintStream);
  }
}

function closeAssistantStream() {
  if (state.streamScheduled) {
    state.streamScheduled = false;
    paintStream();
  }
  if (state.streamEl && !state.streamText.trim()) {
    // Empty bubble (the model only called tools) — drop the whole message.
    state.streamEl.closest('.msg-assistant')?.remove();
  }
  state.streamEl = null;
}

function toolsContainer() {
  if (!state.toolsEl || !state.toolsEl.isConnected) {
    hideWelcome();
    state.toolsEl = make('div', 'tools');
    if (!state.subagentBody) {
      state.toolsEl.style.maxWidth = '900px';
      state.toolsEl.style.width = '100%';
      state.toolsEl.style.margin = '0 auto';
    }
    flowRoot().appendChild(state.toolsEl);
  }
  return state.toolsEl;
}

function addToolCard(name, summary) {
  closeAssistantStream();
  const card = make('div', 'tool');
  card.dataset.state = 'running';
  card.dataset.open = 'false';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'tool-head';
  head.setAttribute('aria-expanded', 'false');
  head.appendChild(make('span', 'tool-status', '●'));
  head.appendChild(make('span', 'tool-name', name));
  head.appendChild(make('span', 'tool-summary', summary));
  head.appendChild(make('span', 'tool-ms', ''));

  const body = make('div', 'tool-body');

  head.addEventListener('click', () => {
    const open = card.dataset.open !== 'true';
    card.dataset.open = String(open);
    head.setAttribute('aria-expanded', String(open));
  });

  card.appendChild(head);
  card.appendChild(body);
  toolsContainer().appendChild(card);

  const record = { name, card, body };
  state.runningTools.push(record);
  scrollIfSticky();
  return record;
}

function endToolCard(name, ok, ms, preview) {
  // Newest matching card wins: the same tool may run several times in a turn.
  let idx = -1;
  for (let i = state.runningTools.length - 1; i >= 0; i -= 1) {
    if (state.runningTools[i].name === name) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return;
  const { card, body } = state.runningTools[idx];
  state.runningTools.splice(idx, 1);

  card.dataset.state = ok ? 'ok' : 'error';
  card.dataset.open = ok ? 'false' : 'true'; // failures show themselves
  const head = card.querySelector('.tool-head');
  if (head) {
    head.querySelector('.tool-status').textContent = ok ? '✔' : '✖';
    head.querySelector('.tool-ms').textContent = shortMs(ms);
    head.setAttribute('aria-expanded', String(!ok));
  }
  if (preview) body.innerHTML = renderDiffish(preview);
  if (!ok && card.isConnected) scrollIfSticky();
}

function addNoteLine(text, kind) {
  hideWelcome();
  const line = make('div', 'note-line', text);
  line.dataset.kind = kind;
  flowRoot().appendChild(line);
  scrollIfSticky();
}

let thinkingEl = null;

function showThinking(label) {
  hideWelcome();
  if (!thinkingEl) {
    thinkingEl = make('div', 'thinking');
    const dots = make('span', 'dots');
    dots.appendChild(make('span'));
    dots.appendChild(make('span'));
    dots.appendChild(make('span'));
    thinkingEl.appendChild(dots);
    thinkingEl.appendChild(make('span', 'thinking-label', label));
    flowRoot().appendChild(thinkingEl);
  } else {
    thinkingEl.querySelector('.thinking-label').textContent = label;
    flowRoot().appendChild(thinkingEl); // keep it last
  }
  scrollIfSticky();
}

function hideThinking() {
  if (thinkingEl && thinkingEl.parentNode) thinkingEl.remove();
}

function addFeedbackRow() {
  if (!state.lastAssistantEl || !state.lastAssistantEl.isConnected) return;
  if (state.lastAssistantEl.querySelector('.feedback')) return;

  const row = make('div', 'feedback');
  const up = make('button', null, '👍 Helpful');
  up.type = 'button';
  const down = make('button', null, '👎 Not right');
  down.type = 'button';
  const hint = make('span', 'hint', 'feedback trains the memory, not the model');

  up.addEventListener('click', () => choose('up', ''));
  down.addEventListener('click', () => openCorrection());

  // 👎 reveals an inline box: the note becomes a remembered correction.
  function openCorrection() {
    if (row.querySelector('.correction')) return;
    const box = make('div', 'correction');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.placeholder = 'What should it do instead? (saved to memory — optional)';
    input.maxLength = 500;
    const save = make('button', null, 'Save');
    save.type = 'button';
    const skip = make('button', null, 'Skip');
    skip.type = 'button';
    save.addEventListener('click', () => choose('down', input.value.trim()));
    skip.addEventListener('click', () => choose('down', ''));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        choose('down', input.value.trim());
      }
    });
    box.appendChild(input);
    box.appendChild(save);
    box.appendChild(skip);
    row.appendChild(box);
    input.focus();
  }

  async function choose(verdict, note) {
    up.disabled = down.disabled = true;
    row.querySelector('.correction')?.remove();
    const res = await api('/api/feedback', { method: 'POST', body: { verdict, note } });
    if (res.ok) {
      up.dataset.chosen = verdict === 'up' ? 'up' : '';
      down.dataset.chosen = verdict === 'down' ? 'down' : '';
      const voted = Number(res.data?.voted ?? 0);
      if (verdict === 'up') {
        hint.textContent = voted > 0 ? `boosted ${voted} remembered fact(s)` : 'nothing was recalled that turn';
      } else {
        hint.textContent = note ? 'correction remembered' : voted > 0 ? `lowered ${voted} fact(s)` : 'noted';
      }
      refreshMemory();
    } else {
      hint.textContent = res.error ?? 'could not save feedback';
      up.disabled = down.disabled = false;
    }
  }

  row.appendChild(up);
  row.appendChild(down);
  row.appendChild(hint);
  state.lastAssistantEl.appendChild(row);
  scrollIfSticky();
}

function setBusy(busy, label) {
  state.busy = busy;
  el.send.disabled = busy;
  el.stop.disabled = !busy;
  el.input.disabled = false;
  el.pillState.dataset.state = busy ? 'busy' : state.connected ? 'ok' : 'down';
  if (!busy) {
    el.stateText.textContent = state.connected ? 'connected' : 'disconnected';
    hideThinking();
  } else {
    el.stateText.textContent = label || 'working…';
  }
}

/* ---------------- api ---------------- */

function readToken() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('token');
  if (fromUrl) {
    try {
      localStorage.setItem('lca.token', fromUrl);
    } catch {
      /* private mode */
    }
    // Keep the secret out of the address bar and browser history.
    params.delete('token');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
    return fromUrl;
  }
  try {
    return localStorage.getItem('lca.token');
  } catch {
    return null;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (state.token) headers['X-LCA-Token'] = state.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 300) };
    }
    if (res.status === 401) {
      promptForToken();
      return { ok: false, status: 401, error: 'token required' };
    }
    if (!res.ok) return { ok: false, status: res.status, error: (data && data.error) || `HTTP ${res.status}` };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ---------------- panels ---------------- */

function renderPlan(items) {
  el.planList.replaceChildren();
  const marks = { pending: '○', in_progress: '◐', completed: '●', blocked: '✖' };
  let done = 0;
  for (const item of items ?? []) {
    if (item.status === 'completed') done += 1;
    const li = make('li');
    li.dataset.status = item.status;
    li.appendChild(make('span', 'plan-mark', marks[item.status] ?? '○'));
    li.appendChild(make('span', null, item.content));
    el.planList.appendChild(li);
  }
  const total = (items ?? []).length;
  el.planEmpty.style.display = total ? 'none' : '';
  el.planCount.textContent = total ? `${done}/${total}` : '';
}

function renderSkills(skills) {
  el.skillList.replaceChildren();
  for (const s of skills ?? []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'skill';
    btn.setAttribute('aria-pressed', String(Boolean(s.loaded)));
    btn.title = s.loaded ? `${s.name} is in context` : `Load ${s.name} into context`;

    btn.appendChild(make('span', 'skill-name', s.name));
    btn.appendChild(make('span', 'skill-tok', `${s.tokens} tok`));
    btn.appendChild(make('span', 'skill-desc', s.description));

    btn.addEventListener('click', async () => {
      if (s.loaded) {
        addNoteLine(`${s.name} is already loaded`, 'note');
        return;
      }
      btn.disabled = true;
      const res = await api('/api/skill', { method: 'POST', body: { name: s.name } });
      btn.disabled = false;
      if (res.ok) {
        s.loaded = true;
        btn.setAttribute('aria-pressed', 'true');
        addNoteLine(`loaded skill: ${s.name}`, 'note');
      } else {
        addNoteLine(res.error ?? 'could not load skill', 'error');
      }
    });

    el.skillList.appendChild(btn);
  }
  el.skillsCount.textContent = String((skills ?? []).length);
}

function markSkillLoaded(name) {
  for (const btn of el.skillList.querySelectorAll('.skill')) {
    if (btn.querySelector('.skill-name')?.textContent === name) btn.setAttribute('aria-pressed', 'true');
  }
  const snap = state.snapshot;
  if (snap) for (const s of snap.skills) if (s.name === name) s.loaded = true;
}

/* ---------------- checkpoints ---------------- */

function renderCheckpoints(items, count) {
  el.cpList.replaceChildren();
  const list = items ?? [];

  for (const cp of list) {
    const item = make('div', 'cp-item');
    item.dataset.restored = String(Boolean(cp.restoredAt));

    const top = make('div', 'cp-top');
    top.appendChild(make('span', 'cp-label', cp.label || '(no label)'));
    top.appendChild(make('span', 'cp-time', String(cp.createdAt ?? '').slice(11, 19)));
    item.appendChild(top);

    const files = make('div', 'cp-files');
    for (const f of (cp.files ?? []).slice(0, 6)) {
      const chip = make('span', 'cp-file', `${f.existed ? '' : '+'}${f.rel}`);
      chip.dataset.created = String(!f.existed);
      chip.title = f.existed
        ? `${f.rel} — restore its previous content`
        : `${f.rel} — created by the agent, so restoring deletes it`;
      files.appendChild(chip);
    }
    if ((cp.files ?? []).length > 6) {
      files.appendChild(make('span', 'cp-file', `+${cp.files.length - 6} more`));
    }
    item.appendChild(files);

    const bottom = make('div', 'cp-bottom');
    const btn = make('button', 'cp-restore', '↩ Restore');
    btn.type = 'button';
    btn.title = `Put the workspace back the way it was before: ${cp.label || cp.id}`;
    btn.addEventListener('click', () => restoreCheckpoint(cp.id, btn));
    bottom.appendChild(btn);
    bottom.appendChild(make('span', 'cp-note', cp.restoredAt ? 'restored once' : `${cp.files.length} file(s)`));
    item.appendChild(bottom);

    el.cpList.appendChild(item);
  }

  el.cpEmpty.style.display = list.length ? 'none' : '';
  el.cpCount.textContent = count !== undefined ? String(count) : String(list.length);
  el.cpRestoreLast.disabled = list.length === 0;
  el.cpRestoreLast.title = list.length
    ? `Roll back "${list[0].label || list[0].id}"`
    : 'No file changes yet';
}

async function restoreCheckpoint(id, btn) {
  if (btn) btn.disabled = true;
  el.cpRestoreLast.disabled = true;
  const res = await api('/api/restore', { method: 'POST', body: id ? { id } : {} });
  if (!res.ok) {
    addNoteLine(res.error ?? 'restore failed', 'error');
    refreshCheckpoints();
    return;
  }
  const d = res.data;
  const parts = [
    (d.reverted ?? []).length ? `${d.reverted.length} file(s) reverted` : '',
    (d.deleted ?? []).length ? `${d.deleted.length} created file(s) removed` : '',
  ].filter(Boolean);
  addNoteLine(`restored ${d.id}${parts.length ? ` — ${parts.join(', ')}` : ''}`, 'note');
  addNoteLine('that rollback is itself checkpointed — restore again to put it back', 'note');
  await refreshCheckpoints();
}

async function refreshCheckpoints() {
  const res = await api('/api/checkpoints');
  if (res.ok) renderCheckpoints(res.data.checkpoints, res.data.count);
}

el.cpRestoreLast.addEventListener('click', () => restoreCheckpoint(null, null));

function renderMemory(lessons, count) {
  el.memoryList.replaceChildren();
  const list = lessons ?? [];
  for (const l of list) {
    const li = make('li', 'memory-item');

    li.appendChild(make('div', 'm-text', l.text));

    const tags = make('div', 'm-tags');
    for (const t of l.tags ?? []) tags.appendChild(make('span', 'tag', t));
    if (typeof l.score === 'number' && l.score !== 0) {
      const chip = make('span', 'tag', `score ${l.score > 0 ? '+' : ''}${l.score}`);
      tags.appendChild(chip);
    }
    li.appendChild(tags);

    const actions = make('div', 'memory-actions');
    actions.appendChild(memBtn('▲', 'Useful — recall it more often', () => vote(l.id, 1)));
    actions.appendChild(memBtn('▼', 'Wrong — recall it less often', () => vote(l.id, -1)));
    actions.appendChild(memBtn('✕', 'Forget this', () => forget(l.id), true));
    li.appendChild(actions);

    el.memoryList.appendChild(li);
  }
  el.memoryEmpty.style.display = list.length ? 'none' : '';
  el.memoryCount.textContent = count !== undefined ? String(count) : String(list.length);
}

function memBtn(label, title, onClick, danger) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `icon-btn${danger ? ' danger' : ''}`;
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

async function vote(id, delta) {
  const res = await api('/api/memory/vote', { method: 'POST', body: { id, delta } });
  if (!res.ok) addNoteLine(res.error ?? 'vote failed', 'error');
  else refreshMemory();
}

async function forget(id) {
  const res = await api(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) addNoteLine(res.error ?? 'could not forget', 'error');
  else {
    addNoteLine('forgotten', 'note');
    refreshMemory();
  }
}

async function refreshMemory() {
  const res = await api('/api/memory');
  if (res.ok) renderMemory(res.data.lessons, res.data.count);
}

async function refreshModels() {
  const res = await api('/api/health');
  if (!res.ok) return;
  const h = res.data;
  state.models = h.models ?? [];
  el.model.replaceChildren();

  const names = new Set(state.models);
  if (h.model) names.add(h.model);
  if (!names.size) names.add('qwen3:8b');
  for (const m of names) {
    const opt = make('option', null, m);
    opt.value = m;
    if (m === h.model) opt.selected = true;
    el.model.appendChild(opt);
  }

  if (!h.ok) {
    showBanner(
      h.provider === 'mock'
        ? 'running the MOCK provider — scripted demo, not a real model. Install Ollama for real work.'
        : `cannot reach Ollama at ${h.ollamaUrl}: ${h.error ?? 'unknown error'}. Run lca doctor.`,
    );
  } else if (h.provider === 'mock') {
    showBanner('provider is mock — set LCA_PROVIDER=ollama to talk to a real local model.');
  } else {
    hideBanner('health');
  }
}

/* Two sources want the banner (health checks and the permission mode). Rather
   than fight over one element, keep both and show the more urgent one. */
const banners = { health: '', mode: '' };

function showBanner(text, kind = 'health') {
  banners[kind] = text;
  renderBanner();
}

function hideBanner(kind = 'health') {
  banners[kind] = '';
  renderBanner();
}

function renderBanner() {
  const text = banners.mode || banners.health;
  el.bannerText.textContent = text;
  el.banner.dataset.open = text ? 'true' : 'false';
  el.banner.style.color = banners.mode ? 'var(--danger)' : '';
  el.banner.style.background = banners.mode ? 'rgba(248,113,113,.12)' : '';
  el.banner.style.borderColor = banners.mode ? 'rgba(248,113,113,.32)' : '';
}

/* ---------------- sub-agents ---------------- */

function openSubagent(data) {
  closeAssistantStream();
  hideThinking();

  const card = make('div', 'subagent');
  card.dataset.state = 'running';
  card.dataset.open = 'true';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'subagent-head';
  head.setAttribute('aria-expanded', 'true');
  head.appendChild(make('span', 'subagent-mark', '⧗'));
  head.appendChild(make('span', 'subagent-kind', String(data.kind || 'explore')));
  head.appendChild(make('span', 'subagent-prompt', String(data.prompt || '')));
  head.appendChild(make('span', 'subagent-meta', `≤${data.maxSteps ?? '?'} steps`));
  head.title = 'A sub-agent with its own context window. Only its report returns to the conversation.';
  head.addEventListener('click', () => {
    const open = card.dataset.open !== 'true';
    card.dataset.open = String(open);
    head.setAttribute('aria-expanded', String(open));
  });

  const body = make('div', 'subagent-body');
  card.appendChild(head);
  card.appendChild(body);

  // Append at top level: the card is a peer of the parent's messages.
  const root = state.subagentBody ? state.subagentBody : el.transcript;
  root.appendChild(card);

  state.subagentEl = card;
  state.subagentBody = body;
  state.toolsEl = null;
  setBusy(true, `sub-agent (${data.kind || 'explore'})…`);
  scrollIfSticky();
}

function closeSubagent(data) {
  const card = state.subagentEl;
  if (!card) return;

  card.dataset.state = data.ok === false ? 'error' : 'done';
  const meta = card.querySelector('.subagent-meta');
  const bits = [];
  if (data.steps !== undefined) bits.push(`${data.steps} steps`);
  if (data.toolCalls !== undefined) bits.push(`${data.toolCalls} tools`);
  if (data.tokens !== undefined) bits.push(`~${data.tokens} tok back`);
  if (data.error) bits.push('failed');
  if (meta) meta.textContent = bits.join(' · ') || 'done';

  // Collapse by default once finished: the report is in the parent's message,
  // and the workings are one click away.
  card.dataset.open = 'false';
  const head = card.querySelector('.subagent-head');
  if (head) head.setAttribute('aria-expanded', 'false');

  state.subagentEl = null;
  state.subagentBody = null;
  state.toolsEl = null;
  hideThinking();
  setBusy(true, 'working…');
  scrollIfSticky();
}

/* ---------------- permission dialog ---------------- */

function enqueuePermission(req) {
  if (state.permissionQueue.some((p) => p.id === req.id)) return;
  if (state.activePermission?.id === req.id) return;
  state.permissionQueue.push(req);
  if (!state.activePermission) nextPermission();
}

function nextPermission() {
  const req = state.permissionQueue.shift();
  if (!req) {
    state.activePermission = null;
    closeDialog();
    return;
  }
  state.activePermission = req;
  openDialog(req);
}

function openDialog(req) {
  el.permRisk.textContent = String(req.risk ?? 'medium').toUpperCase();
  el.permRisk.dataset.risk = String(req.risk ?? 'medium');
  el.permDetail.textContent = `${req.tool} — ${req.summary}`;
  const detail = [req.command, req.path].filter(Boolean).join('\n');
  el.permCommand.textContent = detail || req.summary;
  el.permCommand.style.display = detail ? '' : 'none';
  el.overlay.dataset.open = 'true';
  document.body.style.overflow = 'hidden';
  // Default focus on the safe option, not the permissive one.
  el.permYes.focus();
  setBusy(true, `waiting for you: ${req.tool}`);
}

function closeDialog() {
  el.overlay.dataset.open = 'false';
  document.body.style.overflow = '';
  el.input.focus();
}

async function answerPermission(answer) {
  const req = state.activePermission;
  if (!req) return;
  el.permYes.disabled = el.permNo.disabled = el.permAlways.disabled = true;
  await api('/api/permission', { method: 'POST', body: { id: req.id, answer } });
  el.permYes.disabled = el.permNo.disabled = el.permAlways.disabled = false;
  state.activePermission = null;
  addNoteLine(`${req.tool}: ${answer}`, answer === 'no' ? 'warn' : 'note');
  if (state.permissionQueue.length) nextPermission();
  else {
    closeDialog();
    setBusy(true, 'working…');
  }
}

el.permYes.addEventListener('click', () => answerPermission('yes'));
el.permNo.addEventListener('click', () => answerPermission('no'));
el.permAlways.addEventListener('click', () => answerPermission('always'));

document.addEventListener('keydown', (e) => {
  if (el.overlay.dataset.open !== 'true') return;
  if (e.key === 'Escape') {
    e.preventDefault();
    answerPermission('no');
  }
  if (e.key === 'Tab') {
    // Focus trap: keep Tab cycling inside the dialog.
    const focusables = [el.permNo, el.permAlways, el.permYes].filter((b) => !b.disabled);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

/* ---------------- sending ---------------- */

async function sendMessage() {
  const text = el.input.value.trim();
  if (!text || !state.connected) return;

  addUserMessage(text);
  el.input.value = '';
  autosize();

  if (state.busy) {
    // Queue behind the current turn instead of failing the click.
    addNoteLine('queued — the agent is finishing its current turn', 'note');
  }
  setBusy(true, 'sending…');
  state.toolsEl = null;

  const res = await api('/api/chat', { method: 'POST', body: { text, queue: true } });
  if (!res.ok) {
    addNoteLine(res.error ?? 'send failed', 'error');
    setBusy(false);
  }
}

el.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  void sendMessage();
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});

function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
}

el.input.addEventListener('input', autosize);

el.stop.addEventListener('click', async () => {
  el.stop.disabled = true;
  const res = await api('/api/interrupt', { method: 'POST' });
  if (!res.ok) addNoteLine(res.error ?? 'could not interrupt', 'error');
  else addNoteLine('interrupt requested…', 'warn');
});

/* window.confirm/prompt are blocked inside sandboxed iframes, so nothing here
   may depend on a native modal. Clear arms in place instead. */
let clearArmed = false;
let clearTimer = 0;

el.clear.addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true;
    el.clear.textContent = 'Sure?';
    el.clear.classList.add('btn-danger');
    clearTimer = window.setTimeout(() => {
      clearArmed = false;
      el.clear.textContent = 'Clear';
      el.clear.classList.remove('btn-danger');
    }, 4000);
    return;
  }
  window.clearTimeout(clearTimer);
  clearArmed = false;
  el.clear.textContent = 'Clear';
  el.clear.classList.remove('btn-danger');
  await api('/api/clear', { method: 'POST' });
  el.transcript.replaceChildren();
  el.transcript.appendChild(el.welcome);
  renderPlan([]);
  void refreshCheckpoints();
  state.lastAssistantEl = null;
  state.toolsEl = null;
  addNoteLine('history cleared', 'note');
});

el.undo.addEventListener('click', async () => {
  const res = await api('/api/undo', { method: 'POST' });
  if (res.ok && res.data && res.data.ok === false) addNoteLine('nothing to undo', 'note');
  else addNoteLine('removed your last message', 'note');
});

el.mode.addEventListener('change', async () => {
  const res = await api('/api/permissions', { method: 'POST', body: { mode: el.mode.value } });
  if (!res.ok) addNoteLine(res.error ?? 'could not change mode', 'error');
  if (el.mode.value === 'auto') {
    showBanner('AUTO mode: the agent writes files and runs shell commands without asking.', 'mode');
  } else {
    hideBanner('mode');
    if (el.mode.value === 'readonly') addNoteLine('readonly: the agent can look but not touch', 'note');
  }
});

el.model.addEventListener('change', async () => {
  const res = await api('/api/model', { method: 'POST', body: { model: el.model.value } });
  if (res.ok) el.modelName.textContent = el.model.value;
  else addNoteLine(res.error ?? 'could not switch model', 'error');
});

el.memoryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = el.memoryInput.value.trim();
  if (!text) return;
  const res = await api('/api/memory', { method: 'POST', body: { text, tags: ['user'] } });
  if (res.ok) {
    el.memoryInput.value = '';
    refreshMemory();
  } else {
    addNoteLine(res.error ?? 'could not remember', 'error');
  }
});

/* mobile panel toggle */
const narrow = window.matchMedia('(max-width: 900px)');
function syncPanelButton() {
  el.panelBtn.hidden = !narrow.matches;
  if (!narrow.matches) el.sidebar.dataset.open = 'false';
}
narrow.addEventListener('change', syncPanelButton);
el.panelBtn.addEventListener('click', () => {
  const open = el.sidebar.dataset.open !== 'true';
  el.sidebar.dataset.open = String(open);
  el.panelBtn.setAttribute('aria-expanded', String(open));
});

/* ---------------- token dialog ---------------- */

let tokenPromptOpen = false;

function extractToken(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).searchParams.get('token') ?? '';
    } catch {
      return '';
    }
  }
  return value;
}

function promptForToken() {
  if (tokenPromptOpen) return;
  tokenPromptOpen = true;
  if (source) {
    source.close();
    source = null;
  }
  state.connected = false;
  el.pillState.dataset.state = 'down';
  el.stateText.textContent = 'needs token';
  el.tokenOverlay.dataset.open = 'true';
  el.tokenInput.value = state.token ?? '';
  el.tokenInput.focus();
}

async function saveToken() {
  const token = extractToken(el.tokenInput.value);
  if (!token) {
    el.tokenInput.focus();
    return;
  }
  state.token = token;
  try {
    localStorage.setItem('lca.token', token);
  } catch {
    /* private mode: works for this tab only */
  }
  tokenPromptOpen = false;
  el.tokenOverlay.dataset.open = 'false';
  el.stateText.textContent = 'connecting…';
  connect();
  void refreshModels();
}

el.tokenSave.addEventListener('click', () => void saveToken());
el.tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void saveToken();
  }
});

/* ---------------- event stream ---------------- */

function applySnapshot(snap) {
  state.snapshot = snap;

  el.modelName.textContent = snap.model;
  el.welcomeWs.textContent = snap.workspace;
  el.stats.textContent = snap.stats || 'idle';
  el.mode.value = snap.permissionMode;

  if (!el.model.querySelector(`option[value="${CSS.escape(snap.model)}"]`)) {
    const opt = make('option', null, snap.model);
    opt.value = snap.model;
    el.model.appendChild(opt);
  }
  el.model.value = snap.model;

  renderPlan(snap.plan);
  renderCheckpoints(snap.checkpoints?.items, snap.checkpoints?.count);
  renderSkills(snap.skills);
  renderMemory(snap.memory?.lessons, snap.memory?.count);

  // Rebuild the transcript (a refresh must not lose the conversation).
  el.transcript.replaceChildren();
  state.toolsEl = null;
  state.lastAssistantEl = null;
  state.runningTools = [];
  state.subagentEl = null;
  state.subagentBody = null;
  hideThinking();

  if (!snap.history?.length) {
    el.transcript.appendChild(el.welcome);
  } else {
    for (const m of snap.history) {
      if (m.role === 'user') addUserMessage(m.text);
      else {
        const wrap = addAssistantMessage();
        state.streamText = m.text;
        paintStream();
        state.streamEl = null;
        state.lastAssistantEl = wrap;
      }
    }
  }

  state.connected = true;
  setBusy(Boolean(snap.busy), snap.busy ? 'working…' : undefined);
  state.stickToBottom = true;
  scrollIfSticky();
}

function handleEvent(type, data) {
  switch (type) {
    case 'snapshot':
      applySnapshot(data);
      break;

    case 'assistant_delta':
      hideThinking();
      onDelta(data.text ?? '');
      break;

    case 'assistant_end':
      closeAssistantStream();
      break;

    case 'tool_start':
      hideThinking();
      addToolCard(data.name, data.summary ?? '');
      setBusy(true, `${data.name}…`);
      break;

    case 'tool_end':
      endToolCard(data.name, Boolean(data.ok), Number(data.ms ?? 0), data.preview);
      break;

    case 'spinner':
      showThinking(data.label || 'thinking');
      break;

    case 'spinner_stop':
      hideThinking();
      break;

    case 'note':
      addNoteLine(data.text ?? '', 'note');
      break;

    case 'warn':
      addNoteLine(data.text ?? '', 'warn');
      break;

    case 'error':
      addNoteLine(data.text ?? '', 'error');
      break;

    case 'plan':
      renderPlan(data.items);
      break;

    case 'skill_loaded':
      markSkillLoaded(data.name);
      break;

    case 'checkpoint':
      // A turn just changed files — pull the authoritative list.
      void refreshCheckpoints();
      break;

    case 'subagent_start':
      openSubagent(data);
      break;

    case 'subagent_end':
      closeSubagent(data);
      break;

    case 'permission_request':
      enqueuePermission(data);
      break;

    case 'permission_response':
      // Another tab (or the timeout) answered first.
      if (state.activePermission?.id === data.id) {
        state.activePermission = null;
        if (state.permissionQueue.length) nextPermission();
        else closeDialog();
      }
      state.permissionQueue = state.permissionQueue.filter((p) => p.id !== data.id);
      break;

    case 'turn_end':
      closeAssistantStream();
      hideThinking();
      state.runningTools = [];
      state.toolsEl = null;
      if (state.subagentEl) closeSubagent({ ok: false, error: 'turn ended' });
      el.stats.textContent = data.stats ?? '';
      setBusy(false);
      addFeedbackRow();
      refreshMemory();
      break;

    case 'log':
      // Verbose server log — ignored in the transcript to keep it readable.
      break;

    default:
      break;
  }
}

let source = null;
let reconnectDelay = 1000;

function connect() {
  if (source) source.close();
  const qs = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
  source = new EventSource(`/api/events${qs}`);

  source.onopen = () => {
    reconnectDelay = 1000;
    state.connected = true;
    if (!state.busy) setBusy(false);
    el.pillState.dataset.state = 'ok';
    el.stateText.textContent = 'connected';
  };

  source.onerror = async () => {
    state.connected = false;
    el.pillState.dataset.state = 'down';
    el.stateText.textContent = 'reconnecting…';
    if (!source || source.readyState !== EventSource.CLOSED) return;

    // EventSource cannot send headers, so a 401 looks exactly like a dead
    // server here. Probe once to tell the two apart before retrying.
    const probe = await fetch(`/api/state${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}`);
    if (probe.status === 401) {
      promptForToken();
      return;
    }
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
  };

  const types = [
    'snapshot', 'assistant_delta', 'assistant_end', 'tool_start', 'tool_end',
    'spinner', 'spinner_stop', 'note', 'warn', 'error', 'plan', 'skill_loaded',
    'permission_request', 'permission_response', 'turn_end', 'checkpoint',
    'subagent_start', 'subagent_end', 'log',
  ];
  for (const t of types) {
    source.addEventListener(t, (e) => {
      let data = {};
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      handleEvent(t, data);
    });
  }
}

/* ---------------- boot ---------------- */

function boot() {
  state.token = readToken();
  syncPanelButton();
  autosize();
  el.input.focus();
  connect();
  void refreshModels();

  // Re-check health periodically so a crashed Ollama shows up in the banner.
  setInterval(() => void refreshModels(), 30_000);
}

boot();
