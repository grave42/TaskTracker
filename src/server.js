import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store } from './store.js';
import { createMcpServer } from './mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

export function createApp(store = new Store()) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // ---- MCP (Streamable HTTP, stateless) ----
  app.post('/mcp', async (req, res) => {
    const server = createMcpServer(store, req.get('x-agent-name') || 'agent');
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null });
    }
  });
  const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server, use POST)' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  // ---- REST API for the web UI ----
  const api = express.Router();
  const h = (fn) => (req, res) => {
    try { res.json(fn(req) ?? { ok: true }); }
    catch (e) { res.status(/not found/.test(e.message) ? 404 : 400).json({ error: e.message }); }
  };
  const actor = (req) => req.body?.actor || 'human';

  api.get('/state', h(() => ({
    tasks: store.listTasks(), questions: store.listQuestions(), events: store.recentEvents(), stats: store.stats(),
  })));
  api.get('/tasks/:id', h(r => store.getTask(+r.params.id)));
  api.post('/tasks', h(r => store.createTask(r.body, actor(r))));
  api.patch('/tasks/:id', h(r => store.updateTask(+r.params.id, r.body, actor(r))));
  api.delete('/tasks/:id', h(r => store.deleteTask(+r.params.id)));
  api.post('/tasks/:id/comments', h(r => store.addComment(+r.params.id, r.body.body, actor(r))));
  api.post('/tasks/:id/questions', h(r => store.askQuestion({ ...r.body, task_id: +r.params.id }, r.body.actor || 'human')));
  api.post('/questions/:id/answer', h(r => store.answerQuestion(+r.params.id, r.body.answer, actor(r))));
  api.post('/questions/:id/dismiss', h(r => store.dismissQuestion(+r.params.id, r.body.reason, actor(r))));

  api.get('/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    const on = (c) => res.write(`data: ${JSON.stringify(c)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    store.on('change', on);
    req.on('close', () => { clearInterval(ping); store.off('change', on); });
  });
  app.use('/api', api);

  app.use(express.static(join(__dirname, '..', 'public')));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = new Store();
  if (process.argv.includes('--seed') || (!store.listTasks().length && !process.argv.includes('--empty'))) {
    const { seed } = await import('./seed.js');
    seed(store);
  }
  createApp(store).listen(PORT, HOST, () => {
    console.log(`\n  TaskTracker  →  http://${HOST}:${PORT}`);
    console.log(`  MCP endpoint →  http://${HOST}:${PORT}/mcp  (Streamable HTTP)\n`);
  });
}
