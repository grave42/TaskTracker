// Simulated agent: connects over MCP, takes a task, asks the human a question, waits for the answer, hands the work over.
// Usage: npm run demo:agent [-- http://127.0.0.1:3000]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] || 'http://127.0.0.1:3000';
const AGENT = 'demo-agent';
const client = new Client({ name: AGENT, version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: { ...args } });
  const text = r.content[0].text;
  if (r.isError) throw new Error(text);
  return JSON.parse(text);
};
const log = (m) => console.log(`[${AGENT}] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const task = await call('create_task', { title: 'Добавить экспорт задач в CSV', description: 'Кнопка «Экспорт» на доске.', priority: 'high', labels: ['feature'], agent: AGENT });
log(`создал задачу #${task.id}`);
await call('claim_task', { id: task.id, agent: AGENT });
await call('add_comment', { task_id: task.id, body: 'Начинаю. Сначала определюсь с форматом.', agent: AGENT });
await sleep(1500);

const q = await call('ask_human', {
  task_id: task.id, agent: AGENT, urgency: 'blocking',
  question: 'Какой разделитель использовать в CSV?',
  context: 'Excel в русской локали ожидает «;», остальные инструменты — «,». Рекомендую «;» и BOM для корректной кириллицы.',
  options: ['Точка с запятой (;)', 'Запятая (,)'],
});
log(`задал вопрос #${q.question_id}, жду ответа…`);

let ans;
do { ans = await call('wait_for_answer', { question_id: q.question_id, timeout_seconds: 60 }); } while (ans.status === 'open');
log(`ответ человека: «${ans.answer}»`);

await sleep(1500);
await call('finish_task', { id: task.id, agent: AGENT, summary: `Экспорт в CSV готов, разделитель: ${ans.answer}. Проверка: нажмите «Экспорт» на доске.` });
log('сдал работу на проверку (review)');

// ждём решения человека
let t;
do { await sleep(1500); t = await call('get_task', { id: task.id }); } while (t.status === 'review');
if (t.status === 'done') log('принято ✓');
else log(`возвращено на доработку: ${t.comments.at(-1).body}`);
await client.close();
