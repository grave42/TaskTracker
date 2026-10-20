// Blocks commits that contain secrets or personal data. Runs from the git pre-commit hook and via `npm run check:secrets`.
// Usage: node scripts/check-secrets.js          (staged changes)
//        node scripts/check-secrets.js --all    (every tracked file)
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
const all = process.argv.includes('--all');

const FORBIDDEN_NAMES = [
  /(^|\/)\.env(\.|$)/, /\.(pem|key|p12|pfx|sqlite3?|db|db-wal|db-shm)$/i, /(^|\/)id_(rsa|ed25519|ecdsa)/,
  /(^|\/)(auth|credentials[^/]*|service)\.json$/i, /(^|\/)\.(claude|opencode|cursor)\//, /(^|\/)data\//,
];
const EXAMPLE = /\.env\.example$/;

const PATTERNS = [
  ['OpenRouter / OpenAI-style key', /\bsk-(or-|proj-|ant-)?[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/],
  ['Hard-coded credential', /\b(api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s${}]{8,}["']/i],
  ['Credentials inside a URL', /https?:\/\/[^\s/:@]+:[^\s/@]{3,}@/],
  ['Personal Windows path', /\b[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|<|%|\$|\.\.\.|user\b|name\b|you\b)[A-Za-z0-9._-]+[\\/]/i],
  ['Personal home path', /(?:^|[^A-Za-z0-9_])\/(?:home|Users)\/(?!user\b|name\b|you\b|runner\b|\.\.\.|<)[A-Za-z0-9._-]+\//],
  ['Personal e-mail', /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b|example\.(com|org)\b)[A-Za-z0-9.-]+\.(com|ru|net|org|io|me|dev|ua|by|kz)\b/i],
];

const files = (all ? git('ls-files', '-z') : git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'))
  .toString('utf8').split('\0').filter(Boolean);

const problems = [];
for (const f of files) {
  if (f === 'scripts/check-secrets.js') continue;
  if (!EXAMPLE.test(f) && FORBIDDEN_NAMES.some(r => r.test(f))) { problems.push(`${f}: file type must never be committed`); continue; }
  let buf;
  try { buf = all ? git('show', `HEAD:${f}`) : git('show', `:${f}`); } catch { continue; }
  if (buf.includes(0)) { if (/\.(png|jpe?g|gif|webp|ico)$/i.test(f)) continue; problems.push(`${f}: unknown binary file, review manually`); continue; }
  buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
    for (const [name, re] of PATTERNS) {
      const m = line.match(re);
      if (m) problems.push(`${f}:${i + 1}: ${name}: ${m[0].slice(0, 6)}…`);
    }
  });
}

if (problems.length) {
  console.error('\n✖ Commit blocked: possible secrets / private data found:\n');
  for (const p of problems) console.error('  ' + p);
  console.error('\nRemove them (or add the file to .gitignore) and try again.\n');
  process.exit(1);
}
console.log(`✔ Secret scan passed (${files.length} files).`);
