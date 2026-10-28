// A one-off load test: bot pilots join a match on the relay and fly real
// games (src/match/pilot.js) with random controls, so you can see a full
// match and how the relay copes. Every 5 seconds it prints the traffic, the
// position latency (bot to relay to bot) and how far the bots' loop lags.
// All bots share one thread, so the latency includes the time they wait for
// it: about the cost of a frame of every bot's game, which it prints too.
//
//   pnpm run match                              the relay, in one terminal
//   pnpm run bots -- --code ABCD                9 bots join your match ABCD;
//                                               you host and start the rounds
//   pnpm run bots                               the bots make a match and
//                                               start a round every 10 s in
//                                               the lobby; join with the link
//
// Options: --bots 9 (a match holds 10 players), --relay ws://127.0.0.1:8080,
// --start 10 (seconds in the lobby before the bots' host starts a round).

import { createPilot } from '../src/match/pilot.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const newCode = () => Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

const RELAY = option('relay', 'ws://127.0.0.1:8080').replace(/\/$/, '');
const COUNT = Number(option('bots', 9));
const CODE = (option('code') ?? newCode()).toUpperCase();
const HOSTING = option('code') === undefined;
const START_AFTER_MS = Number(option('start', 10)) * 1000;
const FRAME_MS = 1000 / 60;
const POS_EVERY = 4; // frames between positions, as the page: 15 a second
const REPORT_MS = 5000;

const bots = [];
const botIds = new Set();
const sentAt = new Map(); // a position's `${id}|${d}|${x}|${score}` -> when a bot sent it
let stats = freshStats();

function freshStats() {
  return { sentPos: 0, bytesOut: 0, received: 0, bytesIn: 0, pos: 0, humanPos: 0, rooms: 0, latencies: [], lag: 0, stepMs: 0, frames: 0 };
}

const positionKey = (id, p) => `${id}|${p.d}|${p.x}|${p.score}`;

function send(bot, message) {
  if (bot.ws.readyState !== WebSocket.OPEN) return;
  const text = JSON.stringify(message);
  stats.bytesOut += text.length;
  bot.ws.send(text);
}

function makeBot(n) {
  const bot = {
    n, id: null, room: null, pilot: createPilot(), flying: false, startAt: 0, frame: 0,
    steer: 0, steerFor: 0, up: false, lobbySince: null, closed: false,
    ws: new WebSocket(`${RELAY}/room/${CODE}`),
  };
  bot.ws.addEventListener('open', () => send(bot, { t: 'hello', name: `Bot ${n}` }));
  bot.ws.addEventListener('message', (event) => {
    stats.received += 1;
    stats.bytesIn += event.data.length;
    receive(bot, JSON.parse(event.data));
  });
  bot.ws.addEventListener('close', () => { bot.closed = true; bot.flying = false; });
  bot.ws.addEventListener('error', () => {});
  return bot;
}

function receive(bot, message) {
  const now = performance.now();
  if (message.t === 'welcome') {
    bot.id = message.id;
    botIds.add(message.id);
  } else if (message.t === 'room') {
    stats.rooms += 1;
    if (bot.flying && message.phase === 'lobby') bot.flying = false; // the host ended the round
    bot.room = message;
  } else if (message.t === 'start') {
    bot.startAt = now + message.delay;
    bot.flying = false;
  } else if (message.t === 'pos') {
    stats.pos += 1;
    if (!botIds.has(message.id)) { stats.humanPos += 1; return; }
    const at = sentAt.get(positionKey(message.id, message));
    if (at !== undefined) stats.latencies.push(now - at);
  } else if (message.t === 'error') {
    console.log(`Bot ${bot.n}: ${message.reason}`);
  }
}

function step(bot, now) {
  if (bot.startAt && now >= bot.startAt) {
    bot.startAt = 0;
    bot.pilot.start();
    bot.flying = true;
    bot.frame = 0;
  }
  if (bot.flying) fly(bot, now);
  else if (HOSTING && bot.room?.host === bot.id) hostLobby(bot, now);
}

// random flying: a new stick direction and speed every 10 to 50 frames, always firing
function fly(bot, now) {
  bot.steerFor -= 1;
  if (bot.steerFor <= 0) {
    bot.steer = [-1, 0, 0, 1][Math.floor(Math.random() * 4)];
    bot.steerFor = 10 + Math.floor(Math.random() * 40);
    bot.up = Math.random() < 0.5;
  }
  bot.pilot.step({ left: bot.steer < 0, right: bot.steer > 0, up: bot.up, fire: true });
  bot.frame += 1;
  if (bot.pilot.over) {
    bot.flying = false;
    send(bot, { t: 'out', score: bot.pilot.score });
    return;
  }
  if (bot.frame % POS_EVERY === 0) {
    const position = bot.pilot.position();
    sentAt.set(positionKey(bot.id, position), now);
    stats.sentPos += 1;
    send(bot, { t: 'pos', ...position });
  }
}

// the bots' host starts a round once the match has sat in the lobby a while
function hostLobby(bot, now) {
  if (bot.room.phase !== 'lobby' || bot.startAt) { bot.lobbySince = null; return; }
  bot.lobbySince ??= now;
  if (now - bot.lobbySince >= START_AFTER_MS) {
    bot.lobbySince = null;
    send(bot, { t: 'start' });
  }
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN);
const ms = (value) => (Number.isNaN(value) ? '-' : `${value.toFixed(1)} ms`);

function report() {
  const seconds = REPORT_MS / 1000;
  const per = (n) => Math.round(n / seconds);
  const live = bots.filter((b) => !b.closed);
  const flying = live.filter((b) => b.flying).length;
  const sorted = stats.latencies.sort((a, b) => a - b);
  const room = live[0]?.room;
  const players = room ? `${room.players.length} players, ${room.phase}, round ${room.round}` : 'no match';
  console.log([
    new Date().toLocaleTimeString('en-GB'),
    `${live.length} bots (${flying} flying) · ${players}`,
    `out ${per(stats.sentPos)} pos/s, ${(per(stats.bytesOut) / 1024).toFixed(1)} KB/s`,
    `in ${per(stats.received)} msg/s, ${(per(stats.bytesIn) / 1024).toFixed(1)} KB/s (pos ${per(stats.pos)}/s, from people ${per(stats.humanPos)}/s, room ${per(stats.rooms)}/s)`,
    `latency p50 ${ms(percentile(sorted, 0.5))} p95 ${ms(percentile(sorted, 0.95))} max ${ms(sorted.at(-1) ?? NaN)}`,
    `loop lag max ${ms(stats.lag)} · a frame of every bot's game: ${stats.frames ? (stats.stepMs / stats.frames).toFixed(2) : '-'} ms of ${FRAME_MS.toFixed(1)}`,
  ].join('\n  '));
  const old = performance.now() - REPORT_MS;
  for (const [key, at] of sentAt) if (at < old) sentAt.delete(key);
  stats = freshStats();
}

// *** start ***

const page = `${RELAY.replace(/^ws/, 'http')}/match.html?match=${CODE}`;
console.log(`${COUNT} bots for match ${CODE}: ${page}`);
console.log(HOSTING ? `Bot 1 hosts and starts a round after ${START_AFTER_MS / 1000} s in the lobby.` : 'You host: start the round in the page.');

for (let n = 1; n <= COUNT; n += 1) {
  bots.push(makeBot(n));
  await new Promise((resolve) => setTimeout(resolve, 100)); // join in order: bot 1 first
}

const startedAt = performance.now();
let frames = 0, lastTick = startedAt;
setInterval(() => {
  const now = performance.now();
  stats.lag = Math.max(stats.lag, now - lastTick);
  lastTick = now;
  for (const due = Math.floor((now - startedAt) / FRAME_MS); frames < due; frames += 1) {
    const before = performance.now();
    for (const bot of bots) step(bot, now);
    stats.stepMs += performance.now() - before;
    stats.frames += 1;
  }
}, 4);
setInterval(report, REPORT_MS);

process.on('SIGINT', () => {
  for (const bot of bots) bot.ws.close();
  console.log('\nBots left the match.');
  process.exit(0);
});
