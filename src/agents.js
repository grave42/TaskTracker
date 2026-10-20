import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';

const IS_WIN = process.platform === 'win32';

function which(name) {
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const f = join(dir, name + ext);
      try { if (statSync(f).isFile()) return f; } catch { /* not here */ }
    }
  }
  return null;
}

const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 140 ? s.slice(0, 140) + '…' : s; };

// Each kind knows how to launch a CLI agent headlessly and connect it to our MCP server.
export const KINDS = {
  claude: {
    label: 'Claude Code', bins: ['claude'],
    build({ mcpUrl, name, mode, model }) {
      mkdirSync(join(tmpdir(), 'tasktracker'), { recursive: true });
      const cfg = join(tmpdir(), 'tasktracker', `mcp-${name.replace(/\W+/g, '_')}.json`);
      writeFileSync(cfg, JSON.stringify({ mcpServers: { tasktracker: { type: 'http', url: mcpUrl, headers: { 'x-agent-name': name } } } }));
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--mcp-config', cfg, '--strict-mcp-config'];
      if (model) args.push('--model', model);
      if (mode === 'full') args.push('--dangerously-skip-permissions');
      else args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__tasktracker');
      return { args, env: {} };
    },
    // stream-json -> human readable log lines
    format(line) {
      let j; try { j = JSON.parse(line); } catch { return line; }
      if (j.type === 'assistant') {
        return (j.message?.content || []).map(c =>
          c.type === 'text' ? c.text :
          c.type === 'tool_use' ? `▸ ${c.name.replace(/^mcp__tasktracker__/, 'tt:')} ${short(c.input)}` : '').filter(Boolean).join('\n') || null;
      }
      if (j.type === 'result') return `\n■ ${j.is_error ? 'ОШИБКА' : 'Готово'}${j.result ? ': ' + j.result : ''}`;
      return null;
    },
  },
  opencode: {
    label: 'OpenCode', bins: ['opencode'], experimental: true,
    build({ mcpUrl, name, mode }) {
      const cfg = { mcp: { tasktracker: { type: 'remote', url: mcpUrl, headers: { 'x-agent-name': name }, enabled: true } } };
      if (mode === 'full') cfg.permission = { edit: 'allow', bash: 'allow', webfetch: 'allow' };
      return { args: ['run'], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg) } };
    },
    format: (line) => line,
  },
};

// Test-only agent: a script that plays the role of an agent (see test/dispatch.test.js)
if (process.env.TT_MOCK_AGENT) {
  KINDS.mock = {
    label: 'Mock', bins: [], experimental: true,
    build: ({ mcpUrl, name }) => ({ args: [process.env.TT_MOCK_AGENT], env: { TT_MCP_URL: mcpUrl, TT_AGENT: name } }),
    format: (line) => line,
  };
}

function startPrompt({ name, task, cwd, resume }) {
  const head = `Ты — агент «${name}». Ты работаешь над задачей #${task.id} «${task.title}» в трекере задач TaskTracker через MCP-сервер "tasktracker". Рабочая папка проекта: ${cwd}.`;
  const rules = `Правила:
- Всегда передавай agent="${name}" в инструментах TaskTracker.
- Не гадай. Если требования неясны, решение спорное или рискованное, или ты застрял — вызови ask_human (task_id=${task.id}; urgency="blocking", если без ответа не продолжить; давай варианты ответа в options и свою рекомендацию в context). После этого вызывай wait_for_answer, пока статус "open". Если приходится завершить сеанс раньше, это допустимо: тебя перезапустят, когда человек ответит.
- Периодически оставляй короткие комментарии о прогрессе (add_comment).
- Статус "done" ставить нельзя. Закончив, вызови finish_task с итогом: что сделано, как проверить, оговорки.
- Пиши комментарии и вопросы на языке задачи.`;
  const steps = resume
    ? `Сеанс возобновлён: человек ответил на твой вопрос или вернул задачу на доработку.
1. get_task(${task.id}) — прочитай ответы на вопросы и последние комментарии (замечания ревью).
2. Продолжи работу с учётом ответов и сдай результат через finish_task.`
    : `Шаги:
1. get_task(${task.id}) — прочитай описание и комментарии.
2. claim_task(${task.id}).
3. Выполни задачу в рабочей папке.
4. Сдай результат через finish_task.`;
  return `${head}\n\n${steps}\n\n${rules}\n`;
}

export class Dispatcher {
  constructor(store, { mcpUrl, workdir = process.env.TT_WORKDIR || process.cwd() } = {}) {
    this.store = store;
    this.mcpUrl = mcpUrl || (() => `http://127.0.0.1:${process.env.PORT || 3000}/mcp`);
    this.defaultWorkdir = workdir;
    this.procs = new Map(); // run id -> { child, stopped }
    this.wakeLater = new Set();
    store.recoverRuns();
    store.on('change', (c) => this._onChange(c));
  }

  _url() { return typeof this.mcpUrl === 'function' ? this.mcpUrl() : this.mcpUrl; }

  // Detect installed agent CLIs and register a profile for each new one.
  sync() {
    const have = new Set(this.store.listAgents().map(a => a.kind));
    for (const [kind, k] of Object.entries(KINDS)) {
      if (have.has(kind)) continue;
      const bin = k.bins.map(which).find(Boolean) || (kind === 'mock' ? process.execPath : null);
      if (bin) this.store.createAgent({ name: kind === 'mock' ? 'mock-agent' : kind, kind, bin, workdir: this.defaultWorkdir });
    }
  }

  list() {
    this.sync();
    return this.store.listAgents().map(a => {
      const busy = this.store.runningForAgent(a.name);
      return {
        ...a, label: KINDS[a.kind]?.label || a.kind, experimental: !!KINDS[a.kind]?.experimental,
        available: existsSync(a.bin), workdir_ok: existsSync(a.workdir) && statSync(a.workdir).isDirectory(),
        busy_task: busy?.task_id ?? null,
      };
    });
  }

  dispatch(taskId, agentName, kind = 'start') {
    const agent = this.store.getAgent(agentName);
    if (!agent) throw new Error(`Agent "${agentName}" not found`);
    if (!agent.enabled) throw new Error(`Agent "${agentName}" is disabled`);
    if (!existsSync(agent.bin)) throw new Error(`Executable not found: ${agent.bin}`);
    if (!existsSync(agent.workdir)) throw new Error(`Working directory does not exist: ${agent.workdir}`);
    const task = this.store.getTask(taskId);
    if (this.store.activeRun(taskId)) throw new Error(`Task #${taskId} already has an active agent run`);
    if (task.status === 'done') throw new Error(`Task #${taskId} is done`);
    if (task.assignee !== agentName) this.store.updateTask(taskId, { assignee: agentName }, 'human');
    const run = this.store.createRun({ task_id: taskId, agent: agentName, kind });
    this.store.logEvent(taskId, 'tasktracker', 'run_queued', `${agentName} ${kind === 'resume' ? 'resumes' : 'is sent to'} #${taskId}`);
    setImmediate(() => this.pump());
    return run;
  }

  pump() {
    for (const run of this.store.queuedRuns()) {
      if (this.store.runningForAgent(run.agent)) continue;
      this._launch(run);
    }
  }

  _launch(run) {
    const { store } = this;
    const agent = store.getAgent(run.agent);
    let task;
    try { task = store.getTask(run.task_id); } catch { store.updateRun(run.id, { status: 'failed', finished_at: new Date().toISOString() }); return; }
    const kind = KINDS[agent.kind];
    const prompt = startPrompt({ name: agent.name, task, cwd: agent.workdir, resume: run.kind === 'resume' });
    let child;
    try {
      const { args, env } = kind.build({ mcpUrl: this._url(), name: agent.name, mode: agent.mode, model: agent.model });
      child = spawn(agent.bin, args, {
        cwd: agent.workdir, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, shell: IS_WIN && /\.(cmd|bat)$/i.test(agent.bin),
      });
    } catch (e) { return this._finish(run, { code: -1, error: e.message }); }

    const state = { child, stopped: false, buf: '', pending: '', timer: null };
    this.procs.set(run.id, state);
    store.updateRun(run.id, { status: 'running', pid: child.pid ?? null, started_at: new Date().toISOString() });
    store.logEvent(run.task_id, agent.name, 'run_started', `${agent.name} started working on #${run.task_id}`);

    const flush = () => {
      state.timer = null;
      if (!state.pending) return;
      store.appendRunLog(run.id, state.pending); state.pending = '';
      store.emit('change', { type: 'run_log', task_id: run.task_id });
    };
    const push = (text) => { state.pending += text; state.timer ??= setTimeout(flush, 600); };
    const onLines = (prefix) => (chunk) => {
      state.buf += chunk.toString('utf8');
      let i;
      while ((i = state.buf.indexOf('\n')) >= 0) {
        const line = state.buf.slice(0, i).replace(/\r$/, ''); state.buf = state.buf.slice(i + 1);
        if (!line.trim()) continue;
        const out = prefix ? prefix + line : kind.format(line);
        if (out) push(out + '\n');
      }
    };
    child.stdout.on('data', onLines(''));
    child.stderr.on('data', onLines('! '));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.on('error', (e) => { clearTimeout(state.timer); flush(); this._finish(run, { code: -1, error: e.message }); });
    child.on('close', (code) => { clearTimeout(state.timer); flush(); this._finish(run, { code }); });
  }

  _finish(run, { code, error }) {
    const { store } = this;
    const state = this.procs.get(run.id); this.procs.delete(run.id);
    const current = store.getRun(run.id);
    if (!current || ['finished', 'failed', 'stopped'].includes(current.status)) return;
    const status = state?.stopped ? 'stopped' : code === 0 ? 'finished' : 'failed';
    if (error) store.appendRunLog(run.id, `! ${error}\n`);
    store.updateRun(run.id, { status, exit_code: code, finished_at: new Date().toISOString() });
    try {
      const t = store.getTask(run.task_id);
      const tail = store.getRun(run.id).log.trim().split('\n').slice(-12).join('\n');
      if (status === 'failed') {
        const auth = /\b401\b|authenticat|log ?in|expired|unauthori[sz]ed/i.test(tail)
          ? '\n\n→ Похоже, агент не авторизован. Откройте терминал, запустите команду агента (для Claude Code: `claude`, затем `/login`), войдите и нажмите «▶ Отправить агента» снова.' : '';
        store.addComment(t.id, `⚠ Запуск агента «${run.agent}» завершился с ошибкой (код ${code}).\n\n${tail}${auth}`, 'tasktracker');
        store.logEvent(t.id, 'tasktracker', 'run_failed', `${run.agent} crashed on #${t.id} (exit ${code})`);
      } else if (status === 'stopped') {
        store.logEvent(t.id, 'tasktracker', 'run_stopped', `run of ${run.agent} on #${t.id} stopped`);
      } else {
        const waiting = store.listQuestions({ status: 'open', task_id: t.id }).length > 0;
        if (['todo', 'in_progress'].includes(t.status) && !waiting && !this.wakeLater.has(t.id)) {
          store.addComment(t.id, `Агент «${run.agent}» завершил сеанс, но не сдал задачу (finish_task не вызван). Посмотрите лог запуска.`, 'tasktracker');
          store.logEvent(t.id, 'tasktracker', 'run_stalled', `${run.agent} ended its session on #${t.id} without finishing`);
        } else {
          store.logEvent(t.id, run.agent, 'run_finished', `${run.agent} ended session on #${t.id}`);
        }
      }
    } catch { /* task deleted meanwhile */ }
    if (this.wakeLater.delete(run.task_id) && status !== 'stopped') this._wake(run.task_id);
    this.pump();
  }

  stop(runId) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run #${runId} not found`);
    const st = this.procs.get(runId);
    if (!st) {
      if (run.status === 'queued') this.store.updateRun(runId, { status: 'stopped', finished_at: new Date().toISOString() });
      return this.store.getRun(runId);
    }
    st.stopped = true;
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(st.child.pid), '/T', '/F'], { windowsHide: true });
    else st.child.kill('SIGTERM');
    return this.store.getRun(runId);
  }

  stopAll() { for (const id of [...this.procs.keys()]) try { this.stop(id); } catch { /* ignore */ } }

  // Wake the assigned agent up when a human reacts to it.
  _onChange(c) {
    if (!['question_answered', 'question_dismissed', 'task_rejected'].includes(c.type) || !c.task_id) return;
    this._wake(c.task_id);
  }

  // If the previous process is still shutting down, remember the wake-up and retry when it exits.
  _wake(taskId) {
    try {
      const t = this.store.getTask(taskId);
      if (!t.assignee || ['review', 'done'].includes(t.status)) return;
      const last = this.store.lastRun(t.id);
      if (!last || last.status === 'stopped') return;
      if (this.store.activeRun(t.id)) { this.wakeLater.add(t.id); return; }
      const agent = this.store.getAgent(t.assignee);
      if (!agent?.enabled) return;
      this.dispatch(t.id, agent.name, 'resume');
    } catch { /* agent unavailable: human sees the task unchanged */ }
  }
}
