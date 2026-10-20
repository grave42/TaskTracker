// Installs the git pre-commit hook that runs the secret scan. Runs on `npm install` (prepare); silent outside a git checkout.
import { existsSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';

if (existsSync('.git')) {
  mkdirSync('.git/hooks', { recursive: true });
  writeFileSync('.git/hooks/pre-commit', '#!/bin/sh\nnode scripts/check-secrets.js || exit 1\n');
  try { chmodSync('.git/hooks/pre-commit', 0o755); } catch { /* not supported on this platform */ }
  console.log('git pre-commit secret scan installed');
}
