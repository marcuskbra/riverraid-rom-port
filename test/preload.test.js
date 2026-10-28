// Each page preloads exactly the modules its scripts import, so the browser
// fetches them in one round of requests instead of one per import level. A
// module left off the list only loads later; a stale entry is a wasted request.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const imports = (source) => [...source.matchAll(/\bimport\s[^'"]*?from\s*'([^']+)'/g)].map((m) => m[1]);

// every module reachable from the entries through static imports
function moduleGraph(entries) {
  const seen = new Set();
  const visit = (url) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    for (const specifier of imports(readFileSync(url, 'utf8'))) visit(new URL(specifier, url));
  };
  entries.forEach(visit);
  return seen;
}

for (const page of ['index.html', 'tribute.html', 'harness.html', 'race.html']) {
  test(page, () => {
    const url = new URL(page, root);
    const html = readFileSync(url, 'utf8');
    const entries = [
      ...[...html.matchAll(/<script type="module" src="([^"]+)">/g)].map((m) => new URL(m[1], url)),
      ...[...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].flatMap((m) => imports(m[1]).map((s) => new URL(s, url))),
    ];
    const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => new URL(m[1], url).href);
    assert.ok(entries.length > 0, 'no module scripts found');
    assert.deepEqual(preloaded.toSorted(), [...moduleGraph(entries)].toSorted());
  });
}
