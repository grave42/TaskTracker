import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { STATUSES, PRIORITIES, URGENCIES } from './store.js';

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] });
const noDone = (st) => {
  if (st === 'done') throw new Error('Agents cannot set status "done". Use finish_task (status "review"): the human accepts the result.');
};
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

const INSTRUCTIONS = `You are connected to TaskTracker, a task board shared with a human.
- Work on tasks via list_tasks / claim_task / update_task / add_comment. When finished call finish_task with a summary (status "review"). You cannot set "done": the human accepts the task or returns it with remarks (status goes back to in_progress and a comment appears), so re-read get_task for tasks you hand over.
- NEVER guess when requirements are ambiguous, a decision is risky, or you are stuck: call ask_human.
  Use urgency "blocking" if you cannot continue without the answer (the task is auto-marked blocked), "normal" if you can proceed on another part, "low" for FYI-style questions.
  Offer "options" for choices (the human gets one-click buttons); omit them for open questions.
- After ask_human, either continue other work and poll check_answer / get_inbox later, or call wait_for_answer to block up to ~2 minutes.
- Always pass a stable "agent" name so the human knows who is talking.`;

export function createMcpServer(store, defaultAgent = 'agent') {
  const server = new McpServer({ name: 'tasktracker', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const agent = z.string().max(60).optional().describe('Your agent name (stable, e.g. "claude-backend"). Shown to the human.');
  const who = (a) => a?.trim() || defaultAgent;

  server.registerTool('list_tasks', {
    description: 'List tasks, newest-updated first. Filter by status, assignee, label or text.',
    inputSchema: {
      status: z.enum(STATUSES).optional(),
      assignee: z.string().optional(),
      label: z.string().optional(),
      query: z.string().optional().describe('Substring match on title/description'),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, wrap(({ status, assignee, label, query, limit }) =>
    store.listTasks({ status, assignee, label, q: query, limit }).map(t => ({
      id: t.id, title: t.title, status: t.status, priority: t.priority, assignee: t.assignee,
      labels: t.labels, open_questions: t.open_questions, updated_at: t.updated_at,
    }))));

  server.registerTool('get_task', {
    description: 'Get full task details: description, comments, questions and answers, recent activity.',
    inputSchema: { id: z.number().int() },
  }, wrap(({ id }) => { const { runs, last_run, ...t } = store.getTask(id); return t; }));

  server.registerTool('create_task', {
    description: 'Create a new task (e.g. to split work into subtasks or to record a follow-up).',
    inputSchema: {
      title: z.string().min(1).max(200),
      description: z.string().optional().describe('Markdown-ish text: goal, acceptance criteria'),
      status: z.enum(STATUSES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      assignee: z.string().optional(),
      labels: z.array(z.string()).optional(),
      agent,
    },
  }, wrap(({ agent: a, ...rest }) => { noDone(rest.status); return store.createTask(rest, who(a)); }));

  server.registerTool('update_task', {
    description: 'Update fields of a task. Move to "in_progress" when starting, "review" when finished, "blocked" if stuck.',
    inputSchema: {
      id: z.number().int(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(STATUSES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      assignee: z.string().nullable().optional(),
      labels: z.array(z.string()).optional(),
      agent,
    },
  }, wrap(({ id, agent: a, ...patch }) => { noDone(patch.status); return store.updateTask(id, patch, who(a)); }));

  server.registerTool('finish_task', {
    description: 'Hand the task over for human review: posts your summary as a comment and moves the task to "review". The human then accepts it (done) or returns it to in_progress with remarks: re-read get_task for returned tasks.',
    inputSchema: { id: z.number().int(), summary: z.string().min(1).describe('What was done, how to verify, caveats'), agent },
  }, wrap(({ id, summary, agent: a }) => {
    const me = who(a);
    store.addComment(id, summary, me);
    return store.updateTask(id, { status: 'review' }, me);
  }));

  server.registerTool('claim_task', {
    description: 'Assign the task to yourself and move it to in_progress. Fails if someone else already holds it.',
    inputSchema: { id: z.number().int(), agent },
  }, wrap(({ id, agent: a }) => {
    const me = who(a);
    const t = store.getTask(id);
    if (t.assignee && t.assignee !== me) throw new Error(`Task #${id} is already assigned to ${t.assignee}`);
    return store.updateTask(id, { assignee: me, status: t.status === 'todo' ? 'in_progress' : t.status }, me);
  }));

  server.registerTool('add_comment', {
    description: 'Post a progress note, finding or result on a task. Keep the human informed.',
    inputSchema: { task_id: z.number().int(), body: z.string().min(1), agent },
  }, wrap(({ task_id, body, agent: a }) => store.addComment(task_id, body, who(a))));

  server.registerTool('ask_human', {
    description: 'Ask the human a question: ambiguous requirements, a risky or disputed decision, a problem you cannot resolve, or approval before something irreversible. Returns a question id. The human sees it in their Inbox.',
    inputSchema: {
      question: z.string().min(1).describe('Short, self-contained, specific question'),
      task_id: z.number().int().optional().describe('Related task (strongly recommended)'),
      context: z.string().optional().describe('What you tried, what you know, trade-offs, your recommendation'),
      options: z.array(z.string()).max(8).optional().describe('Predefined answers shown as buttons, e.g. ["Yes","No"]'),
      urgency: z.enum(URGENCIES).optional().describe('"blocking" = cannot continue without it; task is marked blocked until answered'),
      agent,
    },
  }, wrap(({ agent: a, ...q }) => {
    const r = store.askQuestion(q, who(a));
    return { question_id: r.id, status: r.status, hint: 'Use check_answer or wait_for_answer with this question_id.' };
  }));

  const view = (q) => ({
    question_id: q.id, status: q.status, question: q.question, answer: q.answer,
    answered_by: q.answered_by, answered_at: q.answered_at, task_id: q.task_id,
    ...(q.status === 'dismissed' ? { note: 'Human dismissed the question: proceed on your best judgement.' } : {}),
  });

  server.registerTool('check_answer', {
    description: 'Non-blocking: get the current state of a question you asked (open / answered / dismissed).',
    inputSchema: { question_id: z.number().int() },
  }, wrap(({ question_id }) => view(store.getQuestion(question_id))));

  server.registerTool('wait_for_answer', {
    description: 'Block until the human answers the question or the timeout expires (then status stays "open" — you may call it again or continue other work).',
    inputSchema: { question_id: z.number().int(), timeout_seconds: z.number().int().min(1).max(120).optional() },
  }, async ({ question_id, timeout_seconds = 60 }, extra) => {
    try {
      const end = Date.now() + timeout_seconds * 1000;
      let q = store.getQuestion(question_id);
      while (q.status === 'open' && Date.now() < end && !extra?.signal?.aborted) {
        await new Promise(res => {
          const done = () => { clearTimeout(t); store.off('change', onChange); res(); };
          const onChange = (c) => { if (c.type.startsWith('question_')) done(); };
          const t = setTimeout(done, Math.min(2000, end - Date.now()));
          store.on('change', onChange);
        });
        q = store.getQuestion(question_id);
      }
      return ok(view(q));
    } catch (e) { return fail(e); }
  });

  server.registerTool('get_inbox', {
    description: 'List questions you (or any agent) asked, filtered by status. Use status "answered" to collect answers you have not processed yet.',
    inputSchema: { status: z.enum(['open', 'answered', 'dismissed']).optional(), task_id: z.number().int().optional(), agent },
  }, wrap(({ status, task_id, agent: a }) =>
    store.listQuestions({ status, task_id, asker: a?.trim() || undefined }).map(view)));

  return server;
}
