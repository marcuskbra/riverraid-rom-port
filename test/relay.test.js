// The match relay (server/relay.js) end to end: real WebSockets, two players.
import assert from 'node:assert/strict';
import test from 'node:test';
import { startRelay } from '../server/relay.js';

// a player connected to room `code`, with a way to wait for a message
async function connect(port, code, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/room/${code}`);
  const inbox = [], waiting = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    inbox.push(message);
    for (const w of [...waiting]) if (w.match(message)) { waiting.splice(waiting.indexOf(w), 1); w.resolve(message); }
  });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const next = (match) => {
    const seen = inbox.find(match);
    if (seen) { inbox.splice(inbox.indexOf(seen), 1); return Promise.resolve(seen); }
    return new Promise((resolve) => waiting.push({ match, resolve }));
  };
  const send = (message) => ws.send(JSON.stringify(message));
  send({ t: 'hello', name });
  const { id } = await next((m) => m.t === 'welcome');
  return { ws, id, send, next, inbox };
}

test('two players play a match through the relay', async () => {
  const relay = await startRelay({ port: 0 });
  try {
    const ana = await connect(relay.port, 'ABCD', 'Ana');
    const ben = await connect(relay.port, 'ABCD', 'Ben');
    const lobby = await ana.next((m) => m.t === 'room' && m.players.length === 2);
    assert.equal(lobby.host, ana.id);

    ana.send({ t: 'start' });
    await Promise.all([ana.next((m) => m.t === 'start'), ben.next((m) => m.t === 'start')]);

    ben.send({ t: 'pos', d: 321, x: 70, shape: 0xbb, reflect: 0, mode: 0, score: 60 });
    const pos = await ana.next((m) => m.t === 'pos');
    assert.deepEqual(pos, { t: 'pos', id: ben.id, d: 321, x: 70, shape: 0xbb, reflect: 0, mode: 0, score: 60 });

    ana.send({ t: 'out', score: 150 });
    ben.ws.close(); // leaving counts as out with the last score
    const end = await ana.next((m) => m.t === 'room' && m.results);
    assert.deepEqual(end.results.map((r) => [r.name, r.score]), [['Ana', 150], ['Ben', 60]]);
    ana.ws.close();
  } finally {
    await relay.close();
  }
});

test('rooms with other codes do not see each other', async () => {
  const relay = await startRelay({ port: 0 });
  try {
    const a = await connect(relay.port, 'AAAA', 'a');
    const b = await connect(relay.port, 'BBBB', 'b');
    const roomA = await a.next((m) => m.t === 'room');
    const roomB = await b.next((m) => m.t === 'room');
    assert.deepEqual([roomA.players.length, roomB.players.length], [1, 1]);
    assert.equal(roomB.host, b.id);
  } finally {
    await relay.close();
  }
});

test('the relay serves the site but not what is around it', async () => {
  const relay = await startRelay({ port: 0 });
  try {
    const get = (path) => fetch(`http://127.0.0.1:${relay.port}${path}`);
    const page = await get('/index.html');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const module = await get('/src/match/room.js');
    assert.match(module.headers.get('content-type'), /javascript/);
    for (const path of ['/.git/config', '/node_modules/ws/package.json', '/%2e%2e/%2e%2e/etc/passwd', '/nope.js']) {
      assert.equal((await get(path)).status, 404, path);
    }
  } finally {
    await relay.close();
  }
});
