// *** ROM port: power on, RESET, start screen, play ***
import assert from 'node:assert/strict';
import test from 'node:test';
import { romReset, runFrame, Z } from '../src/game/frame.js';

// checksum of the start screen, which matches the Stella snapshot pixel for pixel
const START_SCREEN_HASH = 0x3a599da4;

test('power on, RESET, start screen and play', () => {
  const rom = new Uint8Array(0x100);
  const io = { swcha: 0xff, swchb: 0x0b, inpt4: 0x80, inpt5: 0x80 };
  const frameOf = () => runFrame(rom, io).display;
  romReset(rom, 0);
  for (let i = 0; i < 5; i += 1) frameOf();
  io.swchb = 0x0a;
  for (let i = 0; i < 4; i += 1) frameOf();
  io.swchb = 0x0b;
  let start;
  for (let i = 0; i < 200; i += 1) start = frameOf();
  assert.equal(rom[Z.gameMode], 48, 'expected the ready state after RESET');
  assert.equal(rom[Z.livesPtr], 0x18, 'expected three lives after RESET');
  let hash = 0x811c9dc5;
  start.masks.forEach((m, s) => {
    for (let x = 0; x < 160; x += 1) {
      const v = (m.p0[x] || m.m0[x]) ? 1 : m.p1[x] ? 2 + start.objs[s].colup1 : m.pf[x] ? 3 + start.pf[s].colupf : 0;
      hash = Math.imul(hash ^ v, 0x01000193) >>> 0;
    }
  });
  assert.equal(hash.toString(16), START_SCREEN_HASH.toString(16), 'start screen changed');
  io.swcha = 0xef; // push up: start and accelerate
  const shapesBefore = [...rom.subarray(Z.Shape1IdLst, Z.Shape1IdLst + 6)].join(',');
  let ran = false;
  for (let i = 0; i < 60; i += 1) { frameOf(); ran ||= rom[Z.gameMode] === 0; }
  assert.ok(ran, 'game did not start running');
  assert.notEqual([...rom.subarray(Z.Shape1IdLst, Z.Shape1IdLst + 6)].join(','), shapesBefore, 'no new river blocks were generated');
});
