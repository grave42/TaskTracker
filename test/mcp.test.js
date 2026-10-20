import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

async function setup() {
  const store = new Store(':memory:');
  const http = createApp(store).listen(0, '127.0.0.1');
  await new Promise(r => http.once('listening', r));
  const url = `http://127.0.0.1:${http.address().port}`;
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp')));
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  return { store, http, url, client, call };
}

test('agent asks, human answers through REST, blocked status is restored', async () => {
  const { http, url, client, call } = await setup();
  try {
    const tools = (await client.listTools()).tools.map(t => t.name);
    for (const n of ['ask_human', 'wait_for_answer', 'check_answer', 'claim_task']) assert.ok(tools.includes(n), n);

    const t = await call('create_task', { title: 'Do thing', agent: 'bot' });
    await call('claim_task', { id: t.id, agent: 'bot' });
    assert.equal((await call('get_task', { id: t.id })).status, 'in_progress');

    const q = await call('ask_human', { task_id: t.id, question: 'A or B?', options: ['A', 'B'], urgency: 'blocking', agent: 'bot' });
    assert.equal((await call('get_task', { id: t.id })).status, 'blocked');
    assert.equal((await call('check_answer', { question_id: q.question_id })).status, 'open');

    const waiting = call('wait_for_answer', { question_id: q.question_id, timeout_seconds: 10 });
    setTimeout(() => fetch(`${url}/api/questions/${q.question_id}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'A' }),
    }), 200);
    const got = await waiting;
    assert.equal(got.status, 'answered');
    assert.equal(got.answer, 'A');
    assert.equal((await call('get_task', { id: t.id })).status, 'in_progress');
  } finally { await client.close(); http.close(); }
});

test('errors are returned as tool errors', async () => {
  const { http, client, call } = await setup();
  try {
    assert.match((await call('get_task', { id: 999 })).error, /not found/);
    const t = await call('create_task', { title: 'x' });
    await call('claim_task', { id: t.id, agent: 'a' });
    assert.match((await call('claim_task', { id: t.id, agent: 'b' })).error, /already assigned/);
  } finally { await client.close(); http.close(); }
});
