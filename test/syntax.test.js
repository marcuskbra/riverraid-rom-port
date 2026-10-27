// Syntax-checks every module under src/, including the browser code that the
// other tests don't import.
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

for (const file of globSync('src/**/*.js', { cwd: root })) {
  test(file, () => {
    execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'pipe' });
  });
}
