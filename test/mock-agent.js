// Fake agent CLI used by dispatch.test.js: reads the prompt from stdin and talks to the tracker over MCP.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const id = Number(prompt.match(/задачей #(\d+)/)[1]);
const resume = prompt.includes('возобновлён');
const agent = process.env.TT_AGENT;

const client = new Client({ name: agent, version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.TT_MCP_URL), { requestInit: { headers: { 'x-agent-name': agent } } }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

if (!resume) {
  await call('claim_task', { id, agent });
  console.log('claimed, asking a question');
  await call('ask_human', { task_id: id, agent, urgency: 'blocking', question: 'A or B?', options: ['A', 'B'] });
  // exits without waiting: the dispatcher must restart us once the human answers
} else {
  const t = await call('get_task', { id });
  const answered = t.questions.find(q => q.status === 'answered');
  const remark = t.comments.at(-1)?.body ?? '';
  console.log('resumed; answer =', answered?.answer);
  await call('finish_task', { id, agent, summary: `done with ${answered?.answer}; last comment: ${remark.slice(0, 40)}` });
}
await client.close();
