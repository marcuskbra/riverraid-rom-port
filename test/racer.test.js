// One player's game in a race (src/race/racer.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRacer, TAKEOFF_FRAMES } from '../src/race/racer.js';

const NONE = {};

test('nothing runs before the round starts', () => {
  const racer = createRacer();
  for (let i = 0; i < 100; i += 1) racer.step({ fire: true });
  assert.equal(racer.display, null);
  assert.equal(racer.position(), null);
  assert.equal(racer.over, false);
});

test('a jet left at READY takes off by itself', () => {
  const racer = createRacer();
  racer.start();
  let ready = null, frame = 0;
  for (; frame < 1000 && racer.mode !== 0; frame += 1) {
    racer.step(NONE);
    if (racer.mode === 48) ready ??= frame;
  }
  assert.notEqual(ready, null, 'never at READY');
  assert.equal(racer.mode, 0, 'never took off');
  assert.equal(frame - 1 - ready, TAKEOFF_FRAMES);
});

test('fire takes off at once', () => {
  const racer = createRacer();
  racer.start();
  let frame = 0;
  for (; frame < 1000 && racer.mode !== 0; frame += 1) racer.step({ fire: racer.mode === 48 });
  assert.ok(frame < 100, `took off at frame ${frame}`);
});

test('the position is the jet on screen, and it flies on', () => {
  const racer = createRacer();
  racer.start();
  for (let i = 0; i < 200; i += 1) racer.step({ fire: true });
  const { d, x, mode, score } = racer.position();
  assert.equal(mode, 0);
  assert.equal(score, racer.score);
  for (let i = 0; i < 60; i += 1) racer.step({ up: true });
  assert.ok(racer.position().d > d + 60, 'full speed is at least a line a frame');
  assert.equal(typeof x, 'number');
});

test('the game ends at its game over, and stays over', () => {
  const racer = createRacer();
  racer.start();
  let frame = 0;
  // no hands: every jet flies straight into a bank, the next takes off by itself
  for (; frame < 20000 && !racer.over; frame += 1) racer.step(NONE);
  assert.ok(racer.over, 'no game over');
  const { display } = racer;
  for (let i = 0; i < 100; i += 1) racer.step({ fire: true, up: true });
  assert.equal(racer.display, display, 'no frames after game over');
  assert.equal(racer.mode, 0xff);
  racer.start();
  assert.equal(racer.over, false, 'the next round starts a new game');
  racer.step(NONE);
  assert.notEqual(racer.display, display);
});
