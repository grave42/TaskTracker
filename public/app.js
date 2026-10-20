const STATUSES = [
  ['todo', 'К выполнению'], ['in_progress', 'В работе'], ['blocked', 'Ждёт человека'], ['review', 'На проверке'], ['done', 'Готово'],
];
const STATUS_NAME = Object.fromEntries(STATUSES);
const PRIOS = ['low', 'normal', 'high', 'urgent'];
const PRIO_NAME = { low: 'низкий', normal: 'обычный', high: 'высокий', urgent: 'срочно' };
const URG_NAME = { blocking: 'блокирует', normal: 'обычный', low: 'не срочно' };

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dt = (iso) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

let state = { tasks: [], questions: [], events: [], stats: { byStatus: {}, openQuestions: 0, blockingQuestions: 0 } };
let openTaskId = null;
let search = '';
let agentFilter = '';

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.error || 'Ошибка', true); throw new Error(j.error); }
  return j;
}

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

// agent identity: deterministic colour + shape
const COLORS = ['#ff4b1f', '#6b4cff', '#5ec8ff', '#c9f23a', '#ff8fc7', '#ffb21f', '#2fbf71'];
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function avatar(name) {
  if (!name) return '<span class="chip">никто</span>';
  const h = hash(name);
  const shape = ['0', '50%', '0 50% 50% 50%', '50% 0 50% 50%'][h % 4];
  return `<span class="avatar"><i style="background:${COLORS[h % COLORS.length]};border-radius:${shape}"></i>${esc(name)}</span>`;
}

// keep what the user is typing across re-renders
function keepInputs(root, fn) {
  const saved = [...root.querySelectorAll('[data-keep]')].map(i => [i.dataset.keep, i.value, i === document.activeElement]);
  fn();
  for (const [k, v, focus] of saved) {
    const i = root.querySelector(`[data-keep="${k}"]`);
    if (i) { i.value = v; if (focus) { i.focus(); i.setSelectionRange(v.length, v.length); } }
  }
}

// ---------- render ----------
function render() {
  const s = state.stats;
  $('#stats').innerHTML =
    `<span class="stat"><b>${state.tasks.length}</b>задач</span>` +
    `<span class="stat"><b>${s.byStatus.in_progress || 0}</b>в работе</span>` +
    `<span class="stat ${s.openQuestions ? 'hot' : ''}"><b>${s.openQuestions}</b>вопросов к вам</span>`;
  $('#beacon').classList.toggle('on', s.openQuestions > 0);
  document.title = (s.openQuestions ? `(${s.openQuestions}) ` : '') + 'TaskTracker';

  const sel = $('#agent-filter');
  const names = [...new Set(state.tasks.map(t => t.assignee).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Все исполнители</option>' + names.map(n => `<option ${n === agentFilter ? 'selected' : ''}>${esc(n)}</option>`).join('');

  renderBoard();
  keepInputs($('#line'), renderLine);
  renderFeed();
}

function renderBoard() {
  const q = search.toLowerCase();
  const tasks = state.tasks.filter(t =>
    (!agentFilter || t.assignee === agentFilter) &&
    (!q || (t.title + ' ' + t.description + ' ' + t.labels.join(' ')).toLowerCase().includes(q)));
  $('#board').innerHTML = STATUSES.map(([st, name]) => {
    const list = tasks.filter(t => t.status === st).sort((a, b) => PRIOS.indexOf(b.priority) - PRIOS.indexOf(a.priority));
    return `<div class="col" data-status="${st}">
      <div class="col-head"><h3>${name}</h3><span class="n">${list.length}</span></div>
      <div class="cards">${list.map(card).join('') || '<div class="empty">пусто</div>'}</div></div>`;
  }).join('');
}

function card(t) {
  return `<article class="card pr-${t.priority} ${t.open_questions ? 'has-q' : ''}" draggable="true" data-id="${t.id}">
    ${t.open_questions ? `<span class="ask-flag">? ${t.open_questions}</span>` : ''}
    <div class="id">#${t.id}</div><h4>${esc(t.title)}</h4>
    <div class="meta">${avatar(t.assignee)}
      ${t.labels.map(l => `<span class="chip">${esc(l)}</span>`).join('')}
      ${t.comment_count ? `<span>💬${t.comment_count}</span>` : ''}</div></article>`;
}

function renderLine() {
  const open = state.questions.filter(q => q.status === 'open');
  const recent = state.questions.filter(q => q.status !== 'open').sort((a, b) => (b.answered_at || '').localeCompare(a.answered_at || '')).slice(0, 3);
  $('#line').innerHTML = `<h2 class="sec-title">Линия связи <small>${open.length} ждут ответа</small></h2>
    <div class="line-body">${open.length ? open.map(tele).join('') :
      '<div class="quiet"><b>тишина</b>Агенты работают самостоятельно. Если им понадобится решение, вопрос появится здесь.</div>'}
      ${recent.map(q => `<div class="tele"><div class="tele-head">${avatar(q.asker)}<span>${q.status === 'answered' ? '✓ отвечено' : '⊘ отклонено'}</span></div>
        <div class="tele-body"><p class="q" style="font-size:14px">${esc(q.question)}</p><div class="ctx" style="margin:0">→ ${esc(q.answer)}</div></div></div>`).join('')}
    </div>`;
}

function tele(q) {
  return `<div class="tele ${q.urgency}" data-q="${q.id}">
    <div class="tele-head">${avatar(q.asker)}<span>${time(q.created_at)}</span><span class="urg ${q.urgency}">${URG_NAME[q.urgency]}</span></div>
    <div class="tele-body">
      ${q.task_id ? `<span class="task-ref" data-open="${q.task_id}">#${q.task_id} ${esc(q.task_title || '')}</span>` : ''}
      <p class="q">${esc(q.question)}</p>
      ${q.context ? `<div class="ctx">${esc(q.context)}</div>` : ''}
      ${q.options.length ? `<div class="opts">${q.options.map(o => `<button class="btn sm" data-answer="${q.id}" data-value="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
      <div class="reply"><input data-keep="reply-${q.id}" data-reply="${q.id}" placeholder="${q.options.length ? 'или свой ответ…' : 'Ваш ответ…'}">
        <button class="btn sm primary" data-send="${q.id}">Ответить</button>
        <button class="btn sm ghost" data-dismiss="${q.id}" title="Решай сам">⊘</button></div>
    </div></div>`;
}

function renderFeed() {
  $('#feed').innerHTML = state.events.map(e => `<li><time>${time(e.created_at)}</time><span><b>${esc(e.actor)}</b> ${esc(e.message)}</span></li>`).join('');
}

// ---------- task modal ----------
async function openTask(id) {
  openTaskId = id;
  const t = await api('/tasks/' + id);
  const m = $('#modal');
  keepInputs(m, () => {
    m.hidden = false;
    m.innerHTML = `<div class="sheet">
      <div class="sheet-head"><h2>#${t.id} ${esc(t.title)}</h2><button class="btn sm" data-close>✕</button></div>
      <div class="sheet-body">
        <div class="fields">
          <label class="field full">Название<input id="f-title" value="${esc(t.title)}"></label>
          <label class="field">Статус<select id="f-status">${STATUSES.map(([s, n]) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="field">Приоритет<select id="f-prio">${PRIOS.map(p => `<option value="${p}" ${p === t.priority ? 'selected' : ''}>${PRIO_NAME[p]}</option>`).join('')}</select></label>
          <label class="field">Исполнитель<input id="f-assignee" value="${esc(t.assignee || '')}" placeholder="имя агента"></label>
          <label class="field">Метки<input id="f-labels" value="${esc(t.labels.join(', '))}"></label>
          <label class="field full">Описание<textarea id="f-desc">${esc(t.description)}</textarea></label>
        </div>
        <div class="row"><button class="btn primary" id="save">Сохранить</button><button class="btn danger" id="del">Удалить</button></div>
        ${t.questions.length ? `<div class="block"><h3>Вопросы</h3>${t.questions.map(q => q.status === 'open' ? tele({ ...q, task_title: t.title }) :
          `<div class="comment"><div class="who"><span>${esc(q.asker)} спрашивал</span><span>${q.status === 'answered' ? '✓' : '⊘'}</span></div>${esc(q.question)}\n<b>→ ${esc(q.answer)}</b></div>`).join('')}</div>` : ''}
        <div class="block"><h3>Комментарии</h3>
          ${t.comments.map(c => `<div class="comment"><div class="who"><span>${avatar(c.author)}</span><span>${dt(c.created_at)}</span></div>${esc(c.body)}</div>`).join('') || '<p class="hint">Пока нет</p>'}
          <div class="row"><input data-keep="comment" id="f-comment" placeholder="Написать агенту или команде…"><button class="btn" id="send-comment">Отправить</button></div></div>
      </div></div>`;
  });
}
function closeModal() { openTaskId = null; $('#modal').hidden = true; $('#modal').innerHTML = ''; }

function newTaskModal() {
  const m = $('#modal'); m.hidden = false;
  m.innerHTML = `<div class="sheet center"><div class="sheet-head"><h2>Новая задача</h2><button class="btn sm" data-close>✕</button></div>
    <div class="sheet-body"><div class="fields">
      <label class="field full">Название<input id="n-title" autofocus></label>
      <label class="field full">Описание<textarea id="n-desc" placeholder="Цель, критерии приёмки…"></textarea></label>
      <label class="field">Приоритет<select id="n-prio">${PRIOS.map(p => `<option value="${p}" ${p === 'normal' ? 'selected' : ''}>${PRIO_NAME[p]}</option>`).join('')}</select></label>
      <label class="field">Метки<input id="n-labels" placeholder="через запятую"></label>
    </div><button class="btn primary" id="create">Создать</button></div></div>`;
  setTimeout(() => $('#n-title').focus(), 0);
}

function mcpModal() {
  const url = location.origin + '/mcp';
  const m = $('#modal'); m.hidden = false;
  m.innerHTML = `<div class="sheet center" style="width:min(720px,100%)"><div class="sheet-head"><h2>Подключить агента по MCP</h2><button class="btn sm" data-close>✕</button></div>
    <div class="sheet-body">
      <p class="hint">Встроенный MCP-сервер (Streamable HTTP): <b>${esc(url)}</b>. Агент управляет задачами и через <b>ask_human</b> задаёт вам вопросы — они появляются в «Линии связи».</p>
      <div class="block"><h3>Claude Code</h3><pre class="pre">claude mcp add --transport http tasktracker ${esc(url)}</pre></div>
      <div class="block"><h3>OpenCode · opencode.json</h3><pre class="pre">{ "mcp": { "tasktracker": { "type": "remote", "url": "${esc(url)}" } } }</pre></div>
      <div class="block"><h3>Cursor / Claude Desktop · mcp.json</h3><pre class="pre">{ "mcpServers": { "tasktracker": {
  "url": "${esc(url)}",
  "headers": { "x-agent-name": "my-agent" } } } }</pre></div>
      <div class="block"><h3>Инструменты</h3><pre class="pre">list_tasks  get_task  create_task  update_task  claim_task  add_comment
ask_human   check_answer   wait_for_answer   get_inbox</pre></div>
    </div></div>`;
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('[data-close]') || t === $('#modal')) return closeModal();
  const cardEl = t.closest('.card'); if (cardEl) return openTask(+cardEl.dataset.id);
  const ref = t.closest('[data-open]'); if (ref) return openTask(+ref.dataset.open);
  const ans = t.closest('[data-answer]'); if (ans) return answer(+ans.dataset.answer, ans.dataset.value);
  const send = t.closest('[data-send]'); if (send) {
    const inp = send.closest('.reply').querySelector('input');
    return inp.value.trim() ? answer(+send.dataset.send, inp.value.trim()) : inp.focus();
  }
  const dis = t.closest('[data-dismiss]');
  if (dis) { await api(`/questions/${dis.dataset.dismiss}/dismiss`, 'POST', {}); toast('Вопрос отклонён: агент решит сам'); return refresh(); }
  switch (t.id) {
    case 'new-btn': return newTaskModal();
    case 'mcp-btn': return mcpModal();
    case 'create': {
      const title = $('#n-title').value.trim(); if (!title) return $('#n-title').focus();
      await api('/tasks', 'POST', { title, description: $('#n-desc').value, priority: $('#n-prio').value, labels: labels($('#n-labels').value) });
      closeModal(); return refresh();
    }
    case 'save':
      await api('/tasks/' + openTaskId, 'PATCH', {
        title: $('#f-title').value, description: $('#f-desc').value, status: $('#f-status').value,
        priority: $('#f-prio').value, assignee: $('#f-assignee').value.trim() || null, labels: labels($('#f-labels').value),
      });
      toast('Сохранено'); await refresh(); return openTask(openTaskId);
    case 'del':
      if (!confirm('Удалить задачу?')) return;
      await api('/tasks/' + openTaskId, 'DELETE'); closeModal(); return refresh();
    case 'send-comment': {
      const v = $('#f-comment').value.trim(); if (!v) return;
      $('#f-comment').value = '';
      await api(`/tasks/${openTaskId}/comments`, 'POST', { body: v }); return refresh();
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && e.target.dataset?.reply) $(`[data-send="${e.target.dataset.reply}"]`, e.target.closest('.reply')).click();
  if (e.key === 'Enter' && e.target.id === 'f-comment') $('#send-comment').click();
  if (e.key === 'Enter' && e.target.id === 'n-title') $('#create').click();
});
$('#search').addEventListener('input', (e) => { search = e.target.value; renderBoard(); });
$('#agent-filter').addEventListener('change', (e) => { agentFilter = e.target.value; renderBoard(); });

const labels = (s) => s.split(',').map(x => x.trim()).filter(Boolean);
async function answer(id, value) {
  await api(`/questions/${id}/answer`, 'POST', { answer: value });
  toast('Ответ отправлен агенту'); refresh();
}

// drag & drop
let dragId = null;
document.addEventListener('dragstart', (e) => { const c = e.target.closest?.('.card'); if (c) { dragId = +c.dataset.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; } });
document.addEventListener('dragend', () => { document.querySelectorAll('.dragging,.over').forEach(x => x.classList.remove('dragging', 'over')); });
document.addEventListener('dragover', (e) => { const c = e.target.closest?.('.col'); if (c && dragId) { e.preventDefault(); document.querySelectorAll('.over').forEach(x => x !== c && x.classList.remove('over')); c.classList.add('over'); } });
document.addEventListener('drop', async (e) => {
  const c = e.target.closest?.('.col'); if (!c || !dragId) return;
  e.preventDefault();
  const id = dragId; dragId = null;
  await api('/tasks/' + id, 'PATCH', { status: c.dataset.status }); refresh();
});

// ---------- data ----------
let lastOpen = new Set();
async function refresh() {
  state = await api('/state');
  const open = new Set(state.questions.filter(q => q.status === 'open').map(q => q.id));
  for (const q of state.questions) if (open.has(q.id) && !lastOpen.has(q.id) && lastOpen.size + 1 > 0 && started) toast(`${q.asker} спрашивает: ${q.question}`);
  lastOpen = open; started = true;
  render();
  if (openTaskId && !$('#modal').hidden && !document.activeElement?.closest('.fields')) openTask(openTaskId);
}
let started = false;
let timer;
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = () => { clearTimeout(timer); timer = setTimeout(refresh, 120); };
}
refresh().then(connect);
