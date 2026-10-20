import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const STATUSES = ['todo', 'in_progress', 'blocked', 'review', 'done'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const URGENCIES = ['low', 'normal', 'blocking'];

const now = () => new Date().toISOString();
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export class Store extends EventEmitter {
  constructor(file = process.env.TT_DB || 'data/tasktracker.db') {
    super();
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'normal',
        assignee TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL DEFAULT 'human',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        asker TEXT NOT NULL,
        question TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        options TEXT NOT NULL DEFAULT '[]',
        urgency TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'open',
        answer TEXT,
        answered_by TEXT,
        prev_status TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        bin TEXT NOT NULL,
        workdir TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'safe',
        model TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'start',
        status TEXT NOT NULL DEFAULT 'queued',
        pid INTEGER,
        exit_code INTEGER,
        log TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        actor TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.setMaxListeners(100);
  }

  // ---------- helpers ----------
  _task(row) {
    if (!row) return null;
    return { ...row, labels: parse(row.labels, []) };
  }
  _question(row) {
    if (!row) return null;
    return { ...row, options: parse(row.options, []) };
  }
  _log(taskId, actor, type, message) {
    const ev = { task_id: taskId ?? null, actor, type, message, created_at: now() };
    const r = this.db.prepare('INSERT INTO events (task_id, actor, type, message, created_at) VALUES (?,?,?,?,?)')
      .run(ev.task_id, actor, type, message, ev.created_at);
    this.emit('change', { type, task_id: ev.task_id, event: { id: Number(r.lastInsertRowid), ...ev } });
  }
  _requireTask(id) {
    const t = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!t) throw new Error(`Task #${id} not found`);
    return t;
  }

  // ---------- tasks ----------
  listTasks({ status, assignee, label, q, limit = 200 } = {}) {
    const where = [], args = [];
    if (status) { where.push('status=?'); args.push(status); }
    if (assignee) { where.push('assignee=?'); args.push(assignee); }
    if (q) { where.push('(title LIKE ? OR description LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    const sql = `SELECT t.*,
        (SELECT COUNT(*) FROM questions WHERE task_id=t.id AND status='open') AS open_questions,
        (SELECT COUNT(*) FROM comments WHERE task_id=t.id) AS comment_count,
        (SELECT status FROM runs WHERE task_id=t.id AND status IN ('queued','running') ORDER BY id DESC LIMIT 1) AS run_status
      FROM tasks t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.updated_at DESC LIMIT ?`;
    let rows = this.db.prepare(sql).all(...args, limit).map(r => this._task(r));
    if (label) rows = rows.filter(t => t.labels.includes(label));
    return rows;
  }

  getTask(id) {
    const t = this._task(this._requireTask(id));
    t.comments = this.db.prepare('SELECT * FROM comments WHERE task_id=? ORDER BY id').all(id);
    t.questions = this.db.prepare('SELECT * FROM questions WHERE task_id=? ORDER BY id').all(id).map(r => this._question(r));
    t.events = this.db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY id DESC LIMIT 50').all(id);
    t.runs = this.runsForTask(id);
    const last = this.lastRun(id);
    t.last_run = last ? { ...last, log: last.log.slice(-12_000) } : null;
    return t;
  }

  createTask({ title, description = '', status = 'todo', priority = 'normal', assignee = null, labels = [] }, actor = 'human') {
    if (!title?.trim()) throw new Error('title is required');
    this._check(status, STATUSES, 'status');
    this._check(priority, PRIORITIES, 'priority');
    const ts = now();
    const r = this.db.prepare(`INSERT INTO tasks (title, description, status, priority, assignee, labels, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(title.trim(), description, status, priority, assignee, JSON.stringify(labels), actor, ts, ts);
    const id = Number(r.lastInsertRowid);
    this._log(id, actor, 'task_created', `created #${id} «${title.trim()}»`);
    return this.getTask(id);
  }

  updateTask(id, patch, actor = 'human') {
    const t = this._requireTask(id);
    const fields = {};
    for (const k of ['title', 'description', 'status', 'priority', 'assignee']) {
      if (patch[k] !== undefined) fields[k] = patch[k];
    }
    if (patch.labels !== undefined) fields.labels = JSON.stringify(patch.labels);
    if (fields.status) this._check(fields.status, STATUSES, 'status');
    if (fields.priority) this._check(fields.priority, PRIORITIES, 'priority');
    if (fields.title !== undefined && !String(fields.title).trim()) throw new Error('title cannot be empty');
    const keys = Object.keys(fields);
    if (!keys.length) return this.getTask(id);
    this.db.prepare(`UPDATE tasks SET ${keys.map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`)
      .run(...keys.map(k => fields[k]), now(), id);
    const notes = [];
    if (fields.status && fields.status !== t.status) notes.push(`status ${t.status} → ${fields.status}`);
    if (fields.assignee !== undefined && fields.assignee !== t.assignee) notes.push(`assignee → ${fields.assignee ?? 'nobody'}`);
    if (fields.priority && fields.priority !== t.priority) notes.push(`priority → ${fields.priority}`);
    const ready = fields.status === 'review' && t.status !== 'review';
    this._log(id, actor, ready ? 'task_ready' : 'task_updated',
      ready ? `finished #${id} «${t.title}» — ready for review` : `#${id}: ${notes.join(', ') || 'edited'}`);
    return this.getTask(id);
  }

  reviewTask(id, decision, comment = '', actor = 'human') {
    const t = this._requireTask(id);
    if (t.status !== 'review') throw new Error(`Task #${id} is not in review (status: ${t.status})`);
    if (decision === 'accept') {
      this.updateTask(id, { status: 'done' }, actor);
      if (comment.trim()) this.addComment(id, comment, actor);
    } else if (decision === 'reject') {
      if (!comment.trim()) throw new Error('Explain what needs to be fixed (comment is required)');
      this.addComment(id, `↩ Returned for rework: ${comment.trim()}`, actor);
      this.updateTask(id, { status: 'in_progress' }, actor);
      this._log(id, actor, 'task_rejected', `returned #${id} for rework`);
    } else throw new Error('decision must be "accept" or "reject"');
    return this.getTask(id);
  }

  deleteTask(id, actor = 'human') {
    const t = this._requireTask(id);
    this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
    this._log(null, actor, 'task_deleted', `deleted #${id} «${t.title}»`);
    return { deleted: id };
  }

  addComment(taskId, body, actor = 'human') {
    this._requireTask(taskId);
    if (!body?.trim()) throw new Error('body is required');
    const ts = now();
    const r = this.db.prepare('INSERT INTO comments (task_id, author, body, created_at) VALUES (?,?,?,?)').run(taskId, actor, body.trim(), ts);
    this.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(ts, taskId);
    this._log(taskId, actor, 'comment', `commented on #${taskId}`);
    return { id: Number(r.lastInsertRowid), task_id: taskId, author: actor, body: body.trim(), created_at: ts };
  }

  // ---------- questions (agent -> human) ----------
  askQuestion({ task_id = null, question, context = '', options = [], urgency = 'normal' }, actor = 'agent') {
    if (!question?.trim()) throw new Error('question is required');
    this._check(urgency, URGENCIES, 'urgency');
    let prev = null;
    if (task_id != null) {
      const t = this._requireTask(task_id);
      if (urgency === 'blocking' && t.status !== 'blocked') {
        prev = t.status;
        this.db.prepare("UPDATE tasks SET status='blocked', updated_at=? WHERE id=?").run(now(), task_id);
      }
    }
    const r = this.db.prepare(`INSERT INTO questions (task_id, asker, question, context, options, urgency, prev_status, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(task_id, actor, question.trim(), context, JSON.stringify(options), urgency, prev, now());
    const id = Number(r.lastInsertRowid);
    this._log(task_id, actor, 'question_asked', `asks (${urgency}): ${question.trim()}`);
    return this.getQuestion(id);
  }

  getQuestion(id) {
    const q = this._question(this.db.prepare('SELECT * FROM questions WHERE id=?').get(id));
    if (!q) throw new Error(`Question #${id} not found`);
    const t = q.task_id ? this.db.prepare('SELECT title FROM tasks WHERE id=?').get(q.task_id) : null;
    q.task_title = t?.title ?? null;
    return q;
  }

  listQuestions({ status, task_id, asker } = {}) {
    const where = [], args = [];
    if (status) { where.push('q.status=?'); args.push(status); }
    if (task_id) { where.push('q.task_id=?'); args.push(task_id); }
    if (asker) { where.push('q.asker=?'); args.push(asker); }
    return this.db.prepare(`SELECT q.*, t.title AS task_title FROM questions q LEFT JOIN tasks t ON t.id=q.task_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE q.urgency WHEN 'blocking' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, q.id DESC LIMIT 200`)
      .all(...args).map(r => this._question(r));
  }

  answerQuestion(id, answer, actor = 'human') {
    const q = this.getQuestion(id);
    if (q.status !== 'open') throw new Error(`Question #${id} is already ${q.status}`);
    if (!answer?.trim()) throw new Error('answer is required');
    this._resolve(q, 'answered', answer.trim(), actor);
    this._log(q.task_id, actor, 'question_answered', `answered Q#${id}: ${answer.trim()}`);
    return this.getQuestion(id);
  }

  dismissQuestion(id, reason = '', actor = 'human') {
    const q = this.getQuestion(id);
    if (q.status !== 'open') throw new Error(`Question #${id} is already ${q.status}`);
    this._resolve(q, 'dismissed', reason.trim() || 'Dismissed — decide on your own judgement.', actor);
    this._log(q.task_id, actor, 'question_dismissed', `dismissed Q#${id}`);
    return this.getQuestion(id);
  }

  _resolve(q, status, answer, actor) {
    this.db.prepare('UPDATE questions SET status=?, answer=?, answered_by=?, answered_at=? WHERE id=?').run(status, answer, actor, now(), q.id);
    if (q.task_id && q.prev_status) {
      const still = this.db.prepare("SELECT COUNT(*) c FROM questions WHERE task_id=? AND status='open' AND id<>? AND urgency='blocking'").get(q.task_id, q.id).c;
      const t = this.db.prepare('SELECT status FROM tasks WHERE id=?').get(q.task_id);
      if (!still && t?.status === 'blocked') {
        this.db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?').run(q.prev_status, now(), q.task_id);
      }
    }
  }

  // ---------- agents & runs ----------
  logEvent(taskId, actor, type, message) { this._log(taskId, actor, type, message); }

  listAgents() { return this.db.prepare('SELECT * FROM agents ORDER BY created_at, name').all().map(a => ({ ...a, enabled: !!a.enabled })); }
  getAgent(name) {
    const a = this.db.prepare('SELECT * FROM agents WHERE name=?').get(name);
    return a ? { ...a, enabled: !!a.enabled } : null;
  }
  createAgent({ name, kind, bin, workdir, mode = 'safe', model = null }) {
    this.db.prepare('INSERT INTO agents (name, kind, bin, workdir, mode, model, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(name, kind, bin, workdir, mode, model, now());
    this.emit('change', { type: 'agents_changed', task_id: null });
    return this.getAgent(name);
  }
  updateAgent(name, patch) {
    if (!this.getAgent(name)) throw new Error(`Agent "${name}" not found`);
    const f = {};
    for (const k of ['bin', 'workdir', 'mode', 'model']) if (patch[k] !== undefined) f[k] = patch[k] || null;
    if (patch.enabled !== undefined) f.enabled = patch.enabled ? 1 : 0;
    if (f.mode) this._check(f.mode, ['safe', 'full'], 'mode');
    const keys = Object.keys(f);
    if (keys.length) this.db.prepare(`UPDATE agents SET ${keys.map(k => k + '=?').join(',')} WHERE name=?`).run(...keys.map(k => f[k]), name);
    this.emit('change', { type: 'agents_changed', task_id: null });
    return this.getAgent(name);
  }

  createRun({ task_id, agent, kind = 'start' }) {
    const r = this.db.prepare('INSERT INTO runs (task_id, agent, kind, created_at) VALUES (?,?,?,?)').run(task_id, agent, kind, now());
    return this.getRun(Number(r.lastInsertRowid));
  }
  getRun(id) { return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) ?? null; }
  updateRun(id, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE runs SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => fields[k]), id);
    return this.getRun(id);
  }
  appendRunLog(id, text) {
    const MAX = 120_000;
    const cur = this.db.prepare('SELECT log FROM runs WHERE id=?').get(id)?.log ?? '';
    let next = cur + text;
    if (next.length > MAX) next = '…\n' + next.slice(next.length - MAX);
    this.db.prepare('UPDATE runs SET log=? WHERE id=?').run(next, id);
  }
  runsForTask(taskId) {
    return this.db.prepare('SELECT id, task_id, agent, kind, status, exit_code, created_at, started_at, finished_at FROM runs WHERE task_id=? ORDER BY id DESC LIMIT 20').all(taskId);
  }
  activeRun(taskId) { return this.db.prepare("SELECT * FROM runs WHERE task_id=? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1").get(taskId) ?? null; }
  lastRun(taskId) { return this.db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY id DESC LIMIT 1').get(taskId) ?? null; }
  runningForAgent(name) { return this.db.prepare("SELECT * FROM runs WHERE agent=? AND status='running' LIMIT 1").get(name) ?? null; }
  queuedRuns() { return this.db.prepare("SELECT * FROM runs WHERE status='queued' ORDER BY id").all(); }
  recoverRuns() {
    this.db.prepare("UPDATE runs SET status='lost', finished_at=? WHERE status IN ('running','queued')").run(now());
  }

  // ---------- misc ----------
  recentEvents(limit = 40) {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
  }

  stats() {
    const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const r of this.db.prepare('SELECT status, COUNT(*) c FROM tasks GROUP BY status').all()) byStatus[r.status] = r.c;
    const openQuestions = this.db.prepare("SELECT COUNT(*) c FROM questions WHERE status='open'").get().c;
    const blockingQuestions = this.db.prepare("SELECT COUNT(*) c FROM questions WHERE status='open' AND urgency='blocking'").get().c;
    return { byStatus, openQuestions, blockingQuestions };
  }

  _check(v, allowed, name) {
    if (!allowed.includes(v)) throw new Error(`Invalid ${name} "${v}". Allowed: ${allowed.join(', ')}`);
  }
}
