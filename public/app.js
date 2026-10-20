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

let state = { tasks: [], agents: [], questions: [], events: [], stats: { byStatus: {}, openQuestions: 0, blockingQuestions: 0 } };
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
    `<span class="stat ${s.byStatus.review ? 'review' : ''}"><b>${s.byStatus.review || 0}</b>на проверке</span>` +
    `<span class="stat ${s.openQuestions ? 'hot' : ''}"><b>${s.openQuestions}</b>вопросов к вам</span>`;
  $('#beacon').classList.toggle('on', s.openQuestions > 0);
  const attention = s.openQuestions + (s.byStatus.review || 0);
  document.title = (attention ? `(${attention}) ` : '') + 'TaskTracker';

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
      ${t.comment_count ? `<span>💬${t.comment_count}</span>` : ''}${stale(t)}${t.run_status ? `<span class="chip running">${t.run_status === 'running' ? '⚙ агент работает' : '⏳ в очереди'}</span>` : ''}</div>
    ${t.status === 'review' ? `<div class="review-bar"><button class="btn sm ok" data-accept="${t.id}">✓ Принять</button><button class="btn sm" data-rework="${t.id}">↩ Вернуть</button></div>` : ''}</article>`;
}

function stale(t) {
  if (t.status !== 'in_progress') return '';
  const m = Math.floor((Date.now() - new Date(t.updated_at)) / 60000);
  return m >= 30 ? `<span class="chip stale" title="Нет активности">⏳ тихо ${m >= 120 ? Math.floor(m / 60) + 'ч' : m + 'м'}</span>` : '';
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
          <label class="field">Исполнитель${agentSelect(t.assignee)}</label>
          <label class="field">Метки<input id="f-labels" value="${esc(t.labels.join(', '))}"></label>
          <label class="field full">Описание<textarea id="f-desc">${esc(t.description)}</textarea></label>
        </div>
        <div class="row"><button class="btn primary" id="save">Сохранить</button>
          <button class="btn ok" id="dispatch" ${t.last_run && ['queued', 'running'].includes(t.last_run.status) || t.status === 'done' ? 'disabled' : ''}>▶ Отправить агента</button>
          <button class="btn danger" id="del">Удалить</button></div>
        ${!state.agents.some(a => a.available) ? '<p class="hint">Агенты не найдены. Установите Claude Code или OpenCode: после перезапуска сервера они появятся в списке.</p>' : ''}
        ${runBlock(t)}
        ${t.status === 'review' ? `<div class="block review-block"><h3>Ревью: агент сдал работу</h3>
          <textarea data-keep="review" id="f-review" placeholder="Замечания (обязательны, если возвращаете на доработку)"></textarea>
          <div class="row" style="margin-top:8px"><button class="btn ok" id="accept">✓ Принять — готово</button><button class="btn danger" id="reject">↩ Вернуть на доработку</button></div></div>` : ''}
        ${t.questions.length ? `<div class="block"><h3>Вопросы</h3>${t.questions.map(q => q.status === 'open' ? tele({ ...q, task_title: t.title }) :
          `<div class="comment"><div class="who"><span>${esc(q.asker)} спрашивал</span><span>${q.status === 'answered' ? '✓' : '⊘'}</span></div>${esc(q.question)}\n<b>→ ${esc(q.answer)}</b></div>`).join('')}</div>` : ''}
        <div class="block"><h3>Комментарии</h3>
          ${t.comments.map(c => `<div class="comment"><div class="who"><span>${avatar(c.author)}</span><span>${dt(c.created_at)}</span></div>${esc(c.body)}</div>`).join('') || '<p class="hint">Пока нет</p>'}
          <div class="row"><input data-keep="comment" id="f-comment" placeholder="Написать агенту или команде…"><button class="btn" id="send-comment">Отправить</button></div></div>
      </div></div>`;
    const lg = $('#runlog'); if (lg) lg.scrollTop = lg.scrollHeight;
  });
}
const RUN_NAME = { queued: 'в очереди', running: 'работает', finished: 'сеанс завершён', failed: 'ошибка', stopped: 'остановлен', lost: 'прерван' };

function agentSelect(current) {
  const list = state.agents.filter(a => a.enabled && a.available);
  const known = list.some(a => a.name === current);
  return `<select id="f-assignee"><option value="">— не назначен —</option>
    ${list.map(a => `<option value="${esc(a.name)}" ${a.name === current ? 'selected' : ''}>🤖 ${esc(a.name)}${a.experimental ? ' (бета)' : ''}</option>`).join('')}
    ${current && !known ? `<option value="${esc(current)}" selected>${esc(current)}</option>` : ''}</select>`;
}

function runBlock(t) {
  const r = t.last_run;
  if (!r) return '';
  const active = ['queued', 'running'].includes(r.status);
  return `<div class="block run-block"><h3>Запуск агента <span class="run-st ${r.status}">${esc(r.agent)} · ${RUN_NAME[r.status] || r.status}</span>
    ${active ? `<button class="btn sm danger" data-stop="${r.id}">■ Остановить</button>` : ''}</h3>
    <pre class="pre runlog" id="runlog">${esc(r.log || (active ? 'Запускаю…' : '(лог пуст)'))}</pre></div>`;
}

function agentsModal() {
  const m = $('#modal'); m.hidden = false;
  const list = state.agents;
  m.innerHTML = `<div class="sheet center" style="width:min(760px,100%)"><div class="sheet-head"><h2>Агенты</h2><button class="btn sm" data-close>✕</button></div>
    <div class="sheet-body"><p class="hint">Здесь агенты, найденные на этом компьютере. Выберите любого в карточке задачи и нажмите «▶ Отправить агента»: он запустится в фоне, подключится к трекеру и будет задавать вам вопросы в «Линии связи».</p>
    ${list.map(a => `<div class="agent-card" data-agent="${esc(a.name)}">
      <div class="agent-top"><b>🤖 ${esc(a.name)}</b><span class="chip">${esc(a.label)}</span>
        <span class="chip ${a.available ? 'okc' : 'badc'}">${a.available ? 'найден' : 'не найден'}</span>${a.experimental ? '<span class="chip">бета, не проверено</span>' : ''}
        ${a.busy_task ? `<span class="chip stale">занят: #${a.busy_task}</span>` : ''}</div>
      <div class="agent-path">${esc(a.bin)}</div>
      <div class="fields">
        <label class="field full">Папка проекта${a.workdir_ok ? '' : ' — не существует!'}<input data-f="workdir" value="${esc(a.workdir)}"></label>
        <label class="field">Права<select data-f="mode"><option value="safe" ${a.mode === 'safe' ? 'selected' : ''}>Безопасно: правка файлов, без команд</option><option value="full" ${a.mode === 'full' ? 'selected' : ''}>Полный доступ (команды, сеть)</option></select></label>
        <label class="field">Включён<select data-f="enabled"><option value="1" ${a.enabled ? 'selected' : ''}>да</option><option value="0" ${a.enabled ? '' : 'selected'}>нет</option></select></label>
      </div><div class="row"><button class="btn sm primary" data-save-agent="${esc(a.name)}">Сохранить</button></div></div>`).join('')
      || '<div class="quiet"><b>агентов нет</b>Установите Claude Code (<code>claude</code>) или OpenCode (<code>opencode</code>) и перезапустите сервер.</div>'}
    </div></div>`;
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
  const stop = t.closest('[data-stop]');
  if (stop) { await api(`/runs/${stop.dataset.stop}/stop`, 'POST', {}); toast('Агент остановлен'); await refresh(); return openTask(openTaskId); }
  const sa = t.closest('[data-save-agent]');
  if (sa) {
    const box = sa.closest('.agent-card');
    await api('/agents/' + encodeURIComponent(sa.dataset.saveAgent), 'PATCH', {
      workdir: box.querySelector('[data-f=workdir]').value.trim(), mode: box.querySelector('[data-f=mode]').value,
      enabled: box.querySelector('[data-f=enabled]').value === '1',
    });
    toast('Сохранено'); await refresh(); return agentsModal();
  }
  const acc = t.closest('[data-accept]'); if (acc) return review(+acc.dataset.accept, 'accept');
  const rw = t.closest('[data-rework]'); if (rw) { await openTask(+rw.dataset.rework); return $('#f-review')?.focus(); }
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
    case 'accept': return review(openTaskId, 'accept', $('#f-review').value);
    case 'reject': {
      const c = $('#f-review').value.trim();
      if (!c) { toast('Опишите, что нужно исправить', true); return $('#f-review').focus(); }
      return review(openTaskId, 'reject', c);
    }
    case 'new-btn': return newTaskModal();
    case 'mcp-btn': return mcpModal();
    case 'agents-btn': return agentsModal();
    case 'dispatch': {
      const agent = $('#f-assignee').value;
      if (!agent) { toast('Сначала выберите агента в поле «Исполнитель»', true); return $('#f-assignee').focus(); }
      await api('/tasks/' + openTaskId, 'PATCH', taskFields());
      await api(`/tasks/${openTaskId}/dispatch`, 'POST', { agent });
      toast(`${agent} отправлен на задачу #${openTaskId}`); await refresh(); return openTask(openTaskId);
    }
    case 'create': {
      const title = $('#n-title').value.trim(); if (!title) return $('#n-title').focus();
      await api('/tasks', 'POST', { title, description: $('#n-desc').value, priority: $('#n-prio').value, labels: labels($('#n-labels').value) });
      closeModal(); return refresh();
    }
    case 'save':
      await api('/tasks/' + openTaskId, 'PATCH', taskFields());
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

const taskFields = () => ({
  title: $('#f-title').value, description: $('#f-desc').value, status: $('#f-status').value,
  priority: $('#f-prio').value, assignee: $('#f-assignee').value || null, labels: labels($('#f-labels').value),
});
async function review(id, decision, comment = '') {
  await api(`/tasks/${id}/review`, 'POST', { decision, comment });
  toast(decision === 'accept' ? 'Задача принята ✓' : 'Возвращено агенту на доработку');
  closeModal(); refresh();
}
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
  for (const q of state.questions) if (open.has(q.id) && !lastOpen.has(q.id) && lastOpen.size + 1 > 0 && started) { toast(`${q.asker} спрашивает: ${q.question}`); notify(`${q.asker} спрашивает`, q.question); }
  lastOpen = open; started = true;
  render();
  if (openTaskId && !$('#modal').hidden && !document.activeElement?.closest('#modal input, #modal textarea, #modal select')) openTask(openTaskId);
}
let started = false;
let timer;
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (m) => {
    try {
      const c = JSON.parse(m.data);
      if (['run_failed', 'run_stalled'].includes(c.type)) { toast(`⚠ ${c.event.message}`, true); notify('Агент остановился', c.event.message); }
      if (c.type === 'task_ready') {
        toast(`✓ ${c.event.actor}: ${c.event.message}`);
        notify('Задача готова к проверке', c.event.message);
      }
    } catch { /* ignore malformed event */ }
    clearTimeout(timer); timer = setTimeout(refresh, 120);
  };
}
function notify(title, body) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body });
}
if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', () => Notification.requestPermission(), { once: true });
}
setInterval(renderBoard, 60000);
refresh().then(connect);
