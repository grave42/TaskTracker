import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.TT_MOCK_AGENT = fileURLToPath(new URL('./mock-agent.js', import.meta.url));
const { Store } = await import('../src/store.js');
const { Dispatcher } = await import('../src/agents.js');
const { createApp } = await import('../src/server.js');

async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await new Promise(r => setTimeout(r, 100));
  }
}

test('selected agent is launched, asks, is resumed after the answer and after a rejected review', async () => {
  const store = new Store(':memory:');
  let url = '';
  const dispatcher = new Dispatcher(store, { mcpUrl: () => url + '/mcp', workdir: process.cwd() });
  const http = createApp(store, dispatcher).listen(0, '127.0.0.1');
  await new Promise(r => http.once('listening', r));
  url = `http://127.0.0.1:${http.address().port}`;
  const api = async (p, method = 'GET', body) => {
    const r = await fetch(url + '/api' + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return r.json();
  };
  try {
    const agents = await api('/agents');
    const mock = agents.find(a => a.name === 'mock-agent');
    assert.ok(mock?.available && mock.workdir_ok, 'mock agent is auto-detected');

    const t = store.createTask({ title: 'Do it' });
    assert.ok((await api(`/tasks/${t.id}/dispatch`, 'POST', { agent: 'mock-agent' })).id);
    assert.match((await api(`/tasks/${t.id}/dispatch`, 'POST', { agent: 'mock-agent' })).error ?? '', /already has an active/);

    const q = await until(() => store.listQuestions({ status: 'open', task_id: t.id })[0], 'question');
    assert.equal(store.getTask(t.id).assignee, 'mock-agent');
    await until(() => store.lastRun(t.id).status === 'finished', 'first run end');
    assert.equal(store.getTask(t.id).status, 'blocked');
    assert.match(store.lastRun(t.id).log, /asking a question/);

    await api(`/questions/${q.id}/answer`, 'POST', { answer: 'B' });
    await until(() => store.getTask(t.id).status === 'review', 'resume -> review');
    assert.match(store.getTask(t.id).comments.at(-1).body, /done with B/);

    await api(`/tasks/${t.id}/review`, 'POST', { decision: 'reject', comment: 'add tests please' });
    await until(() => store.getTask(t.id).status === 'review' && store.runsForTask(t.id).length === 3, 'resume after reject');
    assert.match(store.getTask(t.id).comments.at(-1).body, /add tests/);
    assert.equal((await api(`/tasks/${t.id}/review`, 'POST', { decision: 'accept' })).status, 'done');
  } finally { dispatcher.stopAll(); http.close(); }
});
