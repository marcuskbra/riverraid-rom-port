// The taller river: 15 blocks instead of the cartridge's 6, so the screen
// shows 288 river lines above the cartridge's 160. The bottom 160 lines keep
// the ROM's geometry (smoke.test.js checks them against Stella); the new
// lines behave like the rest of the river.
import assert from 'node:assert/strict';
import test from 'node:test';
import { romReset, runFrame, Z, MEMORY_SIZE } from '../src/game/frame.js';
import { NUM_BLOCKS, KERNEL_LINES, missileHeight, setMissileHeight } from '../src/game/river-raid.js';
import { SCREEN_LINES } from '../src/game/screen.js';

const READY = 48;
const PF1_PAGE = 0x01, PF_COLOR = 0x04, ENEMY_MOVE = 0x40, PF_ROAD = 0x80, DIRECTION = 0x08;
const ID_PLANE = 4, ID_SHIP = 7, ID_EXPLOSION1 = 1, DOUBLE_SIZE = 0b101;
const STRAIGHT_PF1 = 0x07, STRAIGHT_PF2 = 0x58; // InitTab's river
const idle = () => ({ swcha: 0xff, swchb: 0x0b, inpt4: 0x80, inpt5: 0x80 });
const missileOn = (display) => display.objs.some((o) => o.enam0);
// the kernel's height (Y) of each line that shows the missile
const missileLines = (display) => display.objs.flatMap((o, s) => (o.enam0 ? [KERNEL_LINES + 1 - s] : []));

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

test('the river is 448 lines and the picture 487, with 15 blocks at $100', () => {
  const { display } = ready();
  assert.equal(NUM_BLOCKS, 15);
  assert.equal(KERNEL_LINES, 448);
  assert.equal(display.pf.length, 448);
  assert.equal(display.masks.length, 448);
  assert.equal(SCREEN_LINES, 487);
  assert.equal(MEMORY_SIZE, 0x15a);
  const lists = [Z.blockLst, Z.XPos1Lst, Z.State1Lst, Z.Shape1IdLst, Z.PF1Lst, Z.PF2Lst];
  assert.deepEqual(lists, [0x100, 0x10f, 0x11e, 0x12d, 0x13c, 0x14b]);
  assert.equal(Z.missileYHi, 0x8e);
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
  const display = untilReady(mem, io);
  check(mem, 'after a crash');
  assert.ok(!missileOn(display), 'a missile shows when the next jet is ready');
});

test('no missile is drawn while it is off', () => {
  const { display } = ready();
  assert.ok(!missileOn(display), 'a missile shows on the ready screen');
});

test('the missile flies to the new top edge', () => {
  const { mem, io } = straightRiver(16);
  mem[Z.missileX] = mem[Z.playerX] + 5;
  setMissileHeight(mem, 430);
  const heights = [];
  for (let i = 0; i < 5; i += 1) {
    runFrame(mem, io);
    heights.push(missileHeight(mem));
  }
  assert.deepEqual(heights, [436, 442, 448, 454, KERNEL_LINES + 20], 'climbs 6 lines a frame up to KERNEL_LINES + 1, then switches off');
  assert.deepEqual([mem[Z.missileY], mem[Z.missileYHi]], [(KERNEL_LINES + 20) & 0xff, 1], 'both bytes of the height');
  const { display } = runFrame(mem, io);
  assert.ok(!missileOn(display), 'no missile after it switched off');
});

// The missile's height takes 2 bytes once the river is past 255 lines; the
// ROM's 8-bit test would also show it again 256 lines away.
test('a missile past the top edge is not drawn', () => {
  const { mem, io } = straightRiver(16);
  mem[Z.missileX] = mem[Z.playerX] + 5;
  const past = 0x100 * Math.ceil((KERNEL_LINES + 8) / 0x100) + 100; // its low byte is a river line
  for (const y of [KERNEL_LINES + 8, KERNEL_LINES + 20, past]) {
    setMissileHeight(mem, y);
    assert.equal(missileHeight(mem), y);
    const { display } = runFrame(mem, io);
    assert.deepEqual(missileLines(display), [], `missile height ${y}`);
  }
});

test('the missile shows only at its height', () => {
  for (const y of [20, 100, KERNEL_LINES - 20]) {
    const { mem, io } = straightRiver(16);
    mem[Z.missileX] = mem[Z.playerX] + 5;
    setMissileHeight(mem, y);
    const lines = missileLines(runFrame(mem, io).display);
    assert.ok(lines.length, `missile height ${y} shows`);
    // ENAM0 is rewritten on odd block lines and held for the next line
    for (const line of lines) assert.ok(line >= y - 1 && line <= y + 8, `missile height ${y} shows at line ${line}`);
  }
});

test('a crash switches the flying missile off', () => {
  const { mem, io } = straightRiver(16);
  mem[Z.missileX] = mem[Z.playerX] + 5;
  setMissileHeight(mem, 100);
  mem[Z.playerX] = 10; // on the left bank
  runFrame(mem, io);
  assert.ok(mem[Z.gameMode] & 0x80, 'the jet crashed');
  assert.ok(!missileOn(runFrame(mem, io).display), 'a missile shows after the crash');
});

for (const [block, blockOffset] of [[NUM_BLOCKS - 2, 16], [NUM_BLOCKS - 1, 28]]) {
  test(`a ship in block ${block} can be shot`, () => {
    const { mem, io } = straightRiver(blockOffset);
    place(mem, block, ID_SHIP, DOUBLE_SIZE, 70);
    const { display } = runFrame(mem, io);
    const pixel = objectPixel(display, block);
    assert.ok(pixel && pixel.line < KERNEL_LINES - 160, `the ship shows above the cartridge's lines (${JSON.stringify(pixel)})`);
    // the missile covers 8 lines from missileY up; aim its middle at the ship
    mem[Z.missileX] = pixel.x + 1;
    setMissileHeight(mem, KERNEL_LINES + 1 - pixel.line - 4);
    runFrame(mem, io);
    assert.equal(mem[Z.Shape1IdLst + block], ID_EXPLOSION1);
    assert.ok(!missileOn(runFrame(mem, io).display), 'the missile is off after the hit');
  });
}

test('planes fly in the new area', () => {
  const { mem, io } = straightRiver(16);
  mem[Z.level] = 3;
  place(mem, NUM_BLOCKS - 1, ID_PLANE, 0, 70);
  const at = () => [mem[Z.XPos1Lst + NUM_BLOCKS - 1], mem[Z.State1Lst + NUM_BLOCKS - 1]].join();
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

// The cartridge raises the level when the next section's first block comes
// in at its block 5; the port makes that block at its top. While the newest
// road is in blocks 5 to NUM_BLOCKS - 2, the cartridge is still a level behind.
for (const [level, road, moves] of [
  [1, null, false], [2, null, true], [2, NUM_BLOCKS - 1, true], [2, NUM_BLOCKS - 2, false], [2, 5, false], [2, 4, true], [3, NUM_BLOCKS - 2, true],
]) {
  test(`at level ${level} with ${road === null ? 'no road' : `the road in block ${road}`}, ships ${moves ? 'move' : 'stay'}`, () => {
    const { mem, io } = straightRiver(16);
    mem[Z.level] = level;
    if (road !== null) {
      // the road and the blocks above it have the next section's colour
      for (let i = road; i < NUM_BLOCKS; i += 1) mem[Z.blockLst + i] |= PF_COLOR;
      mem[Z.blockLst + road] |= PF_ROAD;
    }
    place(mem, 2, ID_SHIP, DOUBLE_SIZE, 70);
    mem[Z.blockLst + 2] |= ENEMY_MOVE;
    const at = () => [mem[Z.XPos1Lst + 2], mem[Z.State1Lst + 2]].join();
    const before = at();
    runFrame(mem, io);
    runFrame(mem, io); // ships move every other frame
    assert.equal(at() !== before, moves);
  });
}

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
