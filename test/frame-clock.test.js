// Frame pacing: rAF timestamps of displays at several refresh rates, from a few
// starting phases, rounded the way browsers round them (Chrome to 0.1 ms,
// Safari and Firefox to 1 ms).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrameClock } from '../src/web/frame-clock.js';

const PHASES = [0, 0.03, 0.05, 0.07, 0.3, 0.5, 0.7, 3.21];
const ROUNDING = [0.1, 1]; // ms

// game frames run on each refresh of a hz display over the given seconds
function run(hz, seconds, phase, step) {
  const tick = createFrameClock();
  const frames = [];
  for (let i = 0; i <= hz * seconds; i += 1) frames.push(tick(Math.round((1000 + phase + (i * 1000) / hz) / step) * step, true));
  return frames.slice(1);
}

test('60 Hz runs one game frame on every refresh', () => {
  for (const step of ROUNDING) {
    for (const phase of PHASES) assert.ok(run(60, 60, phase, step).every((n) => n === 1), `${step} ms rounding, phase ${phase}`);
  }
});

test('120 Hz runs one game frame on every other refresh', () => {
  for (const step of ROUNDING) {
    for (const phase of PHASES) {
      const frames = run(120, 60, phase, step).slice(1);
      const uneven = frames.findIndex((n, i) => n > 1 || (i > 0 && n === frames[i - 1]));
      assert.equal(uneven, -1, `${step} ms rounding, phase ${phase}`);
    }
  }
});

test('game speed follows the wall clock', () => {
  for (const hz of [50, 58, 59.94, 62, 75, 90, 110, 130, 144]) {
    for (const step of ROUNDING) {
      for (const phase of PHASES) {
        const total = run(hz, 60, phase, step).reduce((sum, n) => sum + n, 0);
        assert.ok(Math.abs(total - 3600) <= 1, `${hz} Hz, ${step} ms rounding, phase ${phase}: ${total} game frames in 60 s`);
      }
    }
  }
});

test('no game frames while not running, and no catch-up after', () => {
  const tick = createFrameClock();
  const at = (i) => 1000 + (i * 1000) / 60;
  tick(at(0), true);
  for (let i = 1; i <= 60; i += 1) assert.equal(tick(at(i), false), 0);
  assert.equal(tick(at(61), true), 1);
});
