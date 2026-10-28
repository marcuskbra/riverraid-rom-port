// The match relay: one WebSocket per player at /room/CODE, a room per match
// code (src/match/room.js), made on the first join and dropped when the last
// player leaves. It also serves the site's files, so one command runs the
// whole match locally:
//
//   pnpm run match    then open http://127.0.0.1:8080/match.html
//
// Every player's game runs in their browser; the relay only passes messages.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRoom } from '../src/match/room.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.css': 'text/css',
};
const ROOM_PATH = /^\/room\/([A-Z]{4})$/;
const MAX_MESSAGE = 1024; // bytes; a position is about 80

async function serveFile(request, response, root) {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname));
  const file = join(root, path.endsWith('/') ? `${path}index.html` : path);
  // only the site: nothing outside it, no dotfiles, no node_modules
  const hidden = path.split('/').some((part) => part.startsWith('.') || part === 'node_modules');
  if (!file.startsWith(root) || hidden) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    response.writeHead(404).end();
  }
}

// Starts the relay; port 0 picks a free one. Resolves to { port, close }.
export function startRelay({ port = 8080, host = '127.0.0.1', root = ROOT } = {}) {
  const rooms = new Map(); // code -> { room, sockets: Map id -> socket }
  let nextId = 1;
  const server = createServer((request, response) => serveFile(request, response, root));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });

  server.on('upgrade', (request, socket, head) => {
    const code = ROOM_PATH.exec(new URL(request.url, 'http://x').pathname)?.[1];
    if (!code) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => connect(ws, code));
  });

  function openRoom(code) {
    let entry = rooms.get(code);
    if (!entry) {
      const sockets = new Map();
      const send = (id, message) => {
        const ws = sockets.get(id);
        if (ws?.readyState === ws?.OPEN) ws.send(JSON.stringify(message));
      };
      entry = { room: createRoom(send), sockets };
      rooms.set(code, entry);
    }
    return entry;
  }

  function connect(ws, code) {
    let id = null;
    ws.on('message', (data) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      const entry = openRoom(code);
      if (id !== null) { entry.room.message(id, message); return; }
      if (message?.t !== 'hello') return;
      // the room greets the player while joining, so the socket goes in first
      const newId = nextId;
      nextId += 1;
      entry.sockets.set(newId, ws);
      if (entry.room.join(newId, message)) { id = newId; return; }
      entry.sockets.delete(newId);
      if (entry.room.size === 0) rooms.delete(code);
      ws.send(JSON.stringify({ t: 'error', reason: 'The room is full.' }));
      ws.close();
    });
    ws.on('close', () => {
      const entry = rooms.get(code);
      if (!entry || id === null) return;
      entry.sockets.delete(id);
      entry.room.leave(id);
      if (entry.room.size === 0) rooms.delete(code);
    });
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => { for (const ws of wss.clients) ws.terminate(); server.close(done); }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startRelay({ port: Number(process.env.PORT) || 8080, host: process.env.HOST || '127.0.0.1' });
  console.log(`River Raid match: http://127.0.0.1:${port}/match.html`);
}
