// One pilot's game in a match (src/match/pilot.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPilot, TAKEOFF_FRAMES } from '../src/match/pilot.js';

const NONE = {};

test('nothing runs before the round starts', () => {
  const pilot = createPilot();
  for (let i = 0; i < 100; i += 1) pilot.step({ fire: true });
  assert.equal(pilot.display, null);
  assert.equal(pilot.position(), null);
  assert.equal(pilot.over, false);
});

test('a jet left at READY takes off by itself', () => {
  const pilot = createPilot();
  pilot.start();
  let ready = null, frame = 0;
  for (; frame < 1000 && pilot.mode !== 0; frame += 1) {
    pilot.step(NONE);
    if (pilot.mode === 48) ready ??= frame;
  }
  assert.notEqual(ready, null, 'never at READY');
  assert.equal(pilot.mode, 0, 'never took off');
  assert.equal(frame - 1 - ready, TAKEOFF_FRAMES);
});

test('fire takes off at once', () => {
  const pilot = createPilot();
  pilot.start();
  let frame = 0;
  for (; frame < 1000 && pilot.mode !== 0; frame += 1) pilot.step({ fire: pilot.mode === 48 });
  assert.ok(frame < 100, `took off at frame ${frame}`);
});

test('the position is the jet on screen, and it flies on', () => {
  const pilot = createPilot();
  pilot.start();
  for (let i = 0; i < 200; i += 1) pilot.step({ fire: true });
  const { d, x, mode, score } = pilot.position();
  assert.equal(mode, 0);
  assert.equal(score, pilot.score);
  for (let i = 0; i < 60; i += 1) pilot.step({ up: true });
  assert.ok(pilot.position().d > d + 60, 'full speed is at least a line a frame');
  assert.equal(typeof x, 'number');
});

test('the game ends at its game over, and stays over', () => {
  const pilot = createPilot();
  pilot.start();
  let frame = 0;
  // no hands: every jet flies straight into a bank, the next takes off by itself
  for (; frame < 20000 && !pilot.over; frame += 1) pilot.step(NONE);
  assert.ok(pilot.over, 'no game over');
  const { display } = pilot;
  for (let i = 0; i < 100; i += 1) pilot.step({ fire: true, up: true });
  assert.equal(pilot.display, display, 'no frames after game over');
  assert.equal(pilot.mode, 0xff);
  pilot.start();
  assert.equal(pilot.over, false, 'the next round starts a new game');
  pilot.step(NONE);
  assert.notEqual(pilot.display, display);
});
