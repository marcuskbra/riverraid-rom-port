// The taller river: 8 blocks instead of the cartridge's 6, so the screen
// shows 64 river lines above the cartridge's 160. The bottom 160 lines keep
// the ROM's geometry (smoke.test.js checks them against Stella); the new
// lines behave like the rest of the river.
import assert from 'node:assert/strict';
import test from 'node:test';
import { romReset, runFrame, Z, MEMORY_SIZE } from '../src/game/frame.js';
import { NUM_BLOCKS, KERNEL_LINES } from '../src/game/river-raid.js';
import { SCREEN_LINES } from '../src/game/screen.js';

const READY = 48;
const PF1_PAGE = 0x01, PF_COLOR = 0x04, ENEMY_MOVE = 0x40, PF_ROAD = 0x80, DIRECTION = 0x08;
const ID_PLANE = 4, ID_SHIP = 7, ID_EXPLOSION1 = 1, DOUBLE_SIZE = 0b101;
const STRAIGHT_PF1 = 0x07, STRAIGHT_PF2 = 0x58; // InitTab's river
const idle = () => ({ swcha: 0xff, swchb: 0x0b, inpt4: 0x80, inpt5: 0x80 });
const missileOn = (display) => display.objs.some((o) => o.enam0);

// power on, press RESET and run to the ready screen
function ready() {
  const mem = new Uint8Array(MEMORY_SIZE);
  const io = idle();
  romReset(mem, 0);
  for (let i = 0; i < 5; i += 1) runFrame(mem, io);
  io.swchb = 0x0a;
  for (let i = 0; i < 4; i += 1) runFrame(mem, io);
  io.swchb = 0x0b;
  return { mem, io, display: untilReady(mem, io) };
}

function untilReady(mem, io) {
  for (let i = 0; i < 400; i += 1) {
    const { display } = runFrame(mem, io);
    if (mem[Z.gameMode] === READY) return display;
  }
  throw new Error('the ready screen did not come');
}

// The ready screen turned into a running game on a straight river with no
// objects, at the take-off speed (64: half a line a frame).
function straightRiver(blockOffset) {
  const { mem, io } = ready();
  for (let i = 0; i < NUM_BLOCKS; i += 1) {
    mem[Z.blockLst + i] = PF1_PAGE;
    mem[Z.PF1Lst + i] = STRAIGHT_PF1;
    mem[Z.PF2Lst + i] = STRAIGHT_PF2;
    mem[Z.Shape1IdLst + i] = 0;
    mem[Z.XPos1Lst + i] = 0;
    mem[Z.State1Lst + i] = 0;
  }
  mem[Z.gameMode] = 0;
  mem[Z.speedY] = 64;
  mem[Z.blockOffset] = blockOffset;
  return { mem, io };
}

// CalcPosX: puts object id with NUSIZ/REFP bits `state` at pixel x of a block
function place(mem, block, id, state, x) {
  const p = x + 1;
  let coarse = p >> 4, fine = coarse + (p & 0x0f);
  if (fine >= 15) { fine -= 15; coarse += 1; }
  mem[Z.Shape1IdLst + block] = id;
  mem[Z.XPos1Lst + block] = coarse;
  mem[Z.State1Lst + block] = state | ((fine ^ 7) << 4);
}

// the leftmost pixel of a block's object on the screen: { line, x }
function objectPixel(display, block) {
  for (let line = 0; line < display.masks.length; line += 1) {
    if (display.objs[line].block !== block) continue;
    const x = display.masks[line].p1.indexOf(1);
    if (x >= 0) return { line, x };
  }
  return null;
}

test('the river is 224 lines and the picture 263, with 8 blocks at $100', () => {
  const { display } = ready();
  assert.equal(NUM_BLOCKS, 8);
  assert.equal(KERNEL_LINES, 224);
  assert.equal(display.pf.length, 224);
  assert.equal(display.masks.length, 224);
  assert.equal(SCREEN_LINES, 263);
  assert.equal(MEMORY_SIZE, 0x130);
  const lists = [Z.blockLst, Z.XPos1Lst, Z.State1Lst, Z.Shape1IdLst, Z.PF1Lst, Z.PF2Lst];
  assert.deepEqual(lists, [0x100, 0x108, 0x110, 0x118, 0x120, 0x128]);
});

test('every life starts with river up to the new top edge', () => {
  const check = (mem, when) => {
    assert.ok(mem[Z.blockLst + 1] & PF_ROAD, `${when}: the road is in block 1, as on the cartridge`);
    for (let i = 2; i < NUM_BLOCKS; i += 1) assert.ok(mem[Z.Shape1IdLst + i], `${when}: block ${i} has a generated object`);
  };
  const { mem, io } = ready();
  check(mem, 'after RESET');
  // take off and steer into the left bank
  io.swcha = 0xbf;
  for (let i = 0; i < 400 && !(mem[Z.gameMode] & 0x80); i += 1) runFrame(mem, io);
  assert.ok(mem[Z.gameMode] & 0x80, 'the jet crashed');
  io.swcha = 0xff;
  untilReady(mem, io);
  check(mem, 'after a crash');
});

test('no missile is drawn while it is off', () => {
  const { display } = ready();
  assert.ok(!missileOn(display), 'a missile shows on the ready screen');
});

test('the missile flies to the new top edge', () => {
  const { mem, io } = straightRiver(16);
  mem[Z.missileX] = mem[Z.playerX] + 5;
  mem[Z.missileY] = 200;
  const heights = [];
  for (let i = 0; i < 6; i += 1) {
    runFrame(mem, io);
    heights.push(mem[Z.missileY]);
  }
  assert.deepEqual(heights.slice(0, 5), [206, 212, 218, 224, 230], 'climbs 6 lines a frame up to KERNEL_LINES + 1');
  assert.ok(heights[5] > 230, `switched off after the top edge (missileY ${heights[5]})`);
  const { display } = runFrame(mem, io);
  assert.ok(!missileOn(display), 'no missile after it switched off');
});

for (const [block, blockOffset] of [[6, 16], [7, 28]]) {
  test(`a ship in block ${block} can be shot`, () => {
    const { mem, io } = straightRiver(blockOffset);
    place(mem, block, ID_SHIP, DOUBLE_SIZE, 70);
    const { display } = runFrame(mem, io);
    const pixel = objectPixel(display, block);
    assert.ok(pixel && pixel.line < KERNEL_LINES - 160, `the ship shows above the cartridge's lines (${JSON.stringify(pixel)})`);
    // the missile covers 8 lines from missileY up; aim its middle at the ship
    mem[Z.missileX] = pixel.x + 1;
    mem[Z.missileY] = KERNEL_LINES + 1 - pixel.line - 4;
    runFrame(mem, io);
    assert.equal(mem[Z.Shape1IdLst + block], ID_EXPLOSION1);
  });
}

test('planes fly in the new area', () => {
  const { mem, io } = straightRiver(16);
  mem[Z.level] = 3;
  place(mem, 7, ID_PLANE, 0, 70);
  const at = () => [mem[Z.XPos1Lst + 7], mem[Z.State1Lst + 7]].join();
  const before = at();
  runFrame(mem, io);
  assert.notEqual(at(), before);
});

test('enemies start moving only in the bottom 5 blocks, as on the cartridge', () => {
  const mem = new Uint8Array(MEMORY_SIZE);
  const io = idle();
  let s = 7;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  romReset(mem, 0);
  let stick = 0xff, started = false;
  for (let f = 0; f < 3000; f += 1) {
    io.swcha = 0xff; io.swchb = 0x0b; io.inpt4 = 0x80;
    if (f >= 5 && (!started || mem[Z.gameMode] === 0xff)) io.swchb = 0x0a; // RESET
    else if (started) {
      if (f % 24 === 0) stick = [0xef, 0xef, 0xdf, 0xbf, 0x7f, 0xff][Math.floor(rand() * 6)];
      io.swcha = stick;
      io.inpt4 = rand() < 0.3 ? 0x00 : 0x80;
    }
    if (runFrame(mem, io).reset) started = true;
    for (let i = 5; i < NUM_BLOCKS; i += 1) assert.ok(!(mem[Z.blockLst + i] & ENEMY_MOVE), `frame ${f}: block ${i} moves`);
  }
});

test('ships turn around at the banks', () => {
  const { mem, io } = straightRiver(16);
  mem[Z.level] = 2;
  place(mem, 2, ID_SHIP, DOUBLE_SIZE | DIRECTION, 60);
  // put the ship 2 pixels from the left bank, heading for it
  const { display } = runFrame(mem, io);
  const pixel = objectPixel(display, 2);
  const bank = display.masks[pixel.line].pf.indexOf(0);
  place(mem, 2, ID_SHIP, DOUBLE_SIZE | DIRECTION, 60 - (pixel.x - bank) + 2);
  mem[Z.blockLst + 2] |= ENEMY_MOVE;
  let turned = false;
  for (let i = 0; i < 20 && !turned; i += 1) {
    runFrame(mem, io);
    turned = !(mem[Z.State1Lst + 2] & DIRECTION);
  }
  assert.ok(turned, 'the ship did not turn at the bank');
});

test('a crash with a section boundary in the new area restarts the section', () => {
  const { mem, io } = straightRiver(16);
  // a new section starts in the top block and the bridge has not been hit:
  // the restart point goes back to the previous section
  mem[Z.blockLst + NUM_BLOCKS - 1] |= PF_COLOR;
  mem[Z.sectionEnd] = 0;
  mem[Z.level] = 2;
  mem[Z.randomLoSave] = 0x33; mem[Z.randomHiSave] = 0x44;
  mem[Z.randomLoSave2] = 0x11; mem[Z.randomHiSave2] = 0x22;
  mem[Z.playerX] = 10; // on the left bank
  runFrame(mem, io);
  assert.ok(mem[Z.gameMode] & 0x80, 'the jet crashed');
  assert.equal(mem[Z.level], 1);
  assert.deepEqual([mem[Z.randomLoSave], mem[Z.randomHiSave]], [0x11, 0x22]);
});
