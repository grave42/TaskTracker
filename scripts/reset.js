// Deletes the local database (all tasks, comments, questions, run logs and agent settings).
import { rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const db = process.env.TT_DB || 'data/tasktracker.db';
const dir = dirname(db);
try {
  if (dir === '.' || dir === '') for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true });
  else rmSync(dir, { recursive: true, force: true });
  console.log(`Database removed (${db}). The next start will be empty.`);
} catch (e) {
  console.error(`Cannot remove the database: ${e.message}\nStop the running server first (Ctrl+C).`);
  process.exit(1);
}
if (existsSync(db)) process.exit(1);
