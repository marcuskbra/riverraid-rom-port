// The race room (src/race/room.js): lobby, colors, host, rounds and results.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoom, COLORS, COUNTDOWN_MS } from '../src/race/room.js';

// a room with an inbox per player
function setup() {
  const inbox = new Map();
  const room = createRoom((id, message) => { if (!inbox.has(id)) inbox.set(id, []); inbox.get(id).push(message); });
  let next = 1;
  const join = (hello) => { const id = next; next += 1; return room.join(id, hello) ? id : null; };
  const last = (id, t) => inbox.get(id).filter((m) => m.t === t).at(-1);
  return { room, join, inbox, last, state: (id) => last(id, 'room') };
}

test('players join with a name and their own color; the first is host', () => {
  const { join, last, state } = setup();
  const a = join({ name: '  Ana  ' }), b = join({ name: '' }), c = join({ name: 'A very long pilot name' });
  assert.deepEqual(last(a, 'welcome'), { t: 'welcome', id: a });
  const { players, host, phase } = state(a);
  assert.equal(phase, 'lobby');
  assert.equal(host, a);
  assert.deepEqual(players.map((p) => p.name), ['Ana', `Pilot ${b}`, 'A very long ']);
  assert.equal(new Set(players.map((p) => p.color)).size, 3);
  assert.deepEqual(state(c), state(a), 'everyone sees the same room');
});

test('a color can only be picked when it is free', () => {
  const { room, join, state } = setup();
  const a = join({ name: 'a' }), b = join({ name: 'b' });
  const colorOf = (id) => state(a).players.find((p) => p.id === id).color;
  room.message(b, { t: 'color', color: colorOf(a) });
  assert.notEqual(colorOf(b), colorOf(a));
  room.message(b, { t: 'color', color: 'purple' });
  assert.equal(colorOf(b), 'purple');
  room.message(b, { t: 'color', color: 'gold' });
  assert.equal(colorOf(b), 'purple');
});

test('the room is full when every color is taken', () => {
  const { join } = setup();
  for (const _ of COLORS) assert.notEqual(join({ name: 'x' }), null);
  assert.equal(join({ name: 'one too many' }), null);
});

test('only the host starts, and everyone gets the countdown', () => {
  const { room, join, last, state } = setup();
  const a = join({ name: 'a' }), b = join({ name: 'b' });
  room.message(b, { t: 'start' });
  assert.equal(state(a).phase, 'lobby');
  room.message(a, { t: 'start' });
  for (const id of [a, b]) assert.deepEqual(last(id, 'start'), { t: 'start', round: 1, delay: COUNTDOWN_MS });
  assert.equal(state(a).phase, 'race');
  assert.ok(state(a).players.every((p) => p.state === 'flying'));
});

test('positions go to the other players only', () => {
  const { room, join, inbox, last } = setup();
  const a = join({ name: 'a' }), b = join({ name: 'b' });
  room.message(a, { t: 'start' });
  const before = inbox.get(a).length;
  room.message(a, { t: 'pos', d: 500, x: 76, shape: 0xbb, reflect: 0, mode: 0, score: 30 });
  assert.deepEqual(last(b, 'pos'), { t: 'pos', id: a, d: 500, x: 76, shape: 0xbb, reflect: 0, mode: 0, score: 30 });
  assert.equal(inbox.get(a).length, before, 'no echo and no room update');
});

test('the round ends when the last jet is out, ranked by score', () => {
  const { room, join, state } = setup();
  const a = join({ name: 'a' }), b = join({ name: 'b' }), c = join({ name: 'c' });
  room.message(a, { t: 'start' });
  room.message(b, { t: 'out', score: 900 });
  room.message(a, { t: 'out', score: 2500 });
  assert.equal(state(a).phase, 'race', 'c is still flying');
  room.message(c, { t: 'pos', d: 9000, x: 70, shape: 0xbb, reflect: 0, mode: 0, score: 1200 });
  room.message(c, { t: 'out', score: 1200 });
  const { phase, results, round } = state(a);
  assert.equal(phase, 'lobby');
  assert.equal(round, 1);
  assert.deepEqual(results.map((r) => [r.id, r.score]), [[a, 2500], [c, 1200], [b, 900]]);
});

test('the host can end the round: jets still flying keep their score', () => {
  const { room, join, state } = setup();
  const a = join({ name: 'a' }), b = join({ name: 'b' });
  room.message(a, { t: 'start' });
  room.message(b, { t: 'pos', d: 100, x: 70, shape: 0xbb, reflect: 0, mode: 48, score: 450 });
  room.message(b, { t: 'end' });
  assert.equal(state(a).phase, 'race', 'only the host ends a round');
  room.message(a, { t: 'end' });
  assert.deepEqual(state(a).results.map((r) => [r.id, r.score]), [[b, 450], [a, 0]]);
});

test('a player who leaves mid-round is out with their last score', () => {
  const { room, join, state } = setup();
  const a = join({ name: 'a' }), b = join({ name: 'b' });
  room.message(a, { t: 'start' });
  room.message(b, { t: 'pos', d: 100, x: 70, shape: 0xbb, reflect: 0, mode: 0, score: 700 });
  room.leave(b);
  room.message(a, { t: 'out', score: 300 });
  assert.deepEqual(state(a).results.map((r) => [r.id, r.score]), [[b, 700], [a, 300]]);
});

test('the next player becomes host when the host leaves', () => {
  const { room, join, state } = setup();
  const a = join({ name: 'a' }), b = join({ name: 'b' }), c = join({ name: 'c' });
  room.leave(a);
  assert.equal(state(c).host, b);
  room.message(b, { t: 'start' });
  assert.equal(state(c).phase, 'race');
});

test('joining mid-round watches, then flies the next round', () => {
  const { room, join, state } = setup();
  const a = join({ name: 'a' });
  room.message(a, { t: 'start' });
  const b = join({ name: 'b' });
  assert.equal(state(b).players.find((p) => p.id === b).state, 'watching');
  room.message(a, { t: 'out', score: 100 });
  assert.deepEqual(state(b).results.map((r) => r.id), [a], 'a watcher is not ranked');
  room.message(a, { t: 'start' });
  assert.equal(state(b).players.find((p) => p.id === b).state, 'flying');
});

test('messages that do not fit are ignored', () => {
  const { room, join, state } = setup();
  const a = join({ name: 'a' });
  room.message(a, { t: 'out', score: 5 }); // not racing
  room.message(a, { t: 'nope' });
  room.message(a, null);
  room.message(99, { t: 'start' }); // no such player
  assert.equal(state(a).phase, 'lobby');
  assert.equal(state(a).results, null);
});
