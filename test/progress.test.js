// The match's distance and score readers (src/match/progress.js). Distance is
// what puts other players' jets on your river, so the same distance has to
// mean the same river in every game, whatever happened before: other
// take-off times and speeds, crashes, and the restart point LooseJet moves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { romReset, runFrame, Z, MEMORY_SIZE } from '../src/game/frame.js';
import { NUM_BLOCKS, BLOCK_SIZE } from '../src/game/river-raid.js';
import { createProgress, score } from '../src/match/progress.js';

const SECTION_BLOCKS = 32, SECTION_LINES = SECTION_BLOCKS * BLOCK_SIZE; // 16 patterns of 2 blocks
const GAME_OVER = 0xff, PF1_PAGE = 0x01, PF2_PAGE = 0x02, PF_COLOR = 0x04, PF_ROAD = 0x80, TOP = NUM_BLOCKS - 1;
const STRAIGHT_PF1 = 0x07, STRAIGHT_PF2 = 0x58; // InitTab's river
const RIGHT = 0x7f, LEFT = 0xbf, UP = 0xef, NONE = 0xff;

// power on and press RESET: a one-player game at its first jet
function newGame() {
  const mem = new Uint8Array(MEMORY_SIZE);
  const io = { swcha: NONE, swchb: 0x0a, inpt4: 0x80, inpt5: 0x80 };
  romReset(mem, 0);
  for (let i = 0; i < 3; i += 1) runFrame(mem, io);
  io.swchb = 0x0b;
  return { mem, io, display: runFrame(mem, io).display };
}

// seeded xorshift, so every run plays the same games
function random(seed) {
  let s = seed * 0x9e3779b9 + 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 2 ** 32; };
}

// Flies up the middle of the river and fires. To get through a few sections
// it cheats: fuel stays full, the planes, helicopters and ships near the jet
// are cleared and the two blocks around the jet, unless they are a road, get
// the straight river's banks. Those are the bottom blocks, so the river ahead
// stays as generated. Bridges stay: the jet crashes into the ones it misses. crashAt(frame)
// steers it into the left bank.
function pilot(game, frame, rand, crashAt) {
  const { mem, io } = game;
  mem[Z.fuelHi] = 0xff;
  for (let i = 0; i < 4; i += 1) if (mem[Z.Shape1IdLst + i] >= 4 && mem[Z.Shape1IdLst + i] <= 7) mem[Z.Shape1IdLst + i] = 0;
  for (let i = 0; i < 2; i += 1) {
    if (mem[Z.blockLst + i] & PF_ROAD) continue;
    mem[Z.PF1Lst + i] = STRAIGHT_PF1;
    mem[Z.PF2Lst + i] = STRAIGHT_PF2;
    mem[Z.blockLst + i] = (mem[Z.blockLst + i] & ~PF2_PAGE) | PF1_PAGE;
  }
  const x = mem[Z.playerX];
  let stick = Math.abs(x - 76) < 3 ? NONE : x < 76 ? RIGHT : LEFT;
  if (crashAt(frame)) stick = LEFT;
  else if (rand() < 0.3) stick &= UP | 0x0f; // full speed now and then
  io.swcha = stick;
  io.inpt4 = frame % 4 < 2 ? 0x00 : 0x80;
}

// what the river looks like at the top block, for comparing blocks by index
const topBlock = (mem) => [mem[Z.PF1Lst + TOP], mem[Z.PF2Lst + TOP], mem[Z.blockLst + TOP] & PF_COLOR].join(',');

// Plays a game to the end, checking the distance every frame; `blocks` maps a
// top block's index to its look, shared between games.
function play(seed, blocks) {
  const game = newGame();
  const { mem, io } = game;
  const rand = random(seed);
  const progress = createProgress();
  const crashes = [];
  // crash after 15 to 40 seconds, every other time with a section boundary on screen
  const nextCrash = (frame) => ({ frame: frame + 900 + Math.floor(rand() * 1500), boundary: rand() < 0.5 });
  let crash = nextCrash(0), last = null, mode = mem[Z.gameMode];
  for (let frame = 0; frame < 60000 && mem[Z.gameMode] !== GAME_OVER; frame += 1) {
    const boundary = !!((mem[Z.blockLst] ^ mem[Z.blockLst + TOP]) & PF_COLOR);
    pilot(game, frame, rand, (f) => f >= crash.frame && boundary === crash.boundary);
    game.display = runFrame(mem, io).display;
    const distance = progress(mem);
    if (mem[Z.gameMode] === GAME_OVER) break;
    assert.notEqual(distance, null, `seed ${seed} frame ${frame}: no distance`);
    if (mem[Z.gameMode] >= 0x80 && mode < 0x80) {
      crashes.push({ boundary, before: last });
      crash = nextCrash(frame);
    }
    if (mode >= 0x80 && mem[Z.gameMode] < 0x80) crashes.at(-1).after = distance;
    if (last !== null && mode < 0x80 && mem[Z.gameMode] < 0x80) {
      assert.ok(distance - last >= 0 && distance - last <= 2, `seed ${seed} frame ${frame}: flew ${distance - last} lines`);
    }
    const index = (distance - mem[Z.blockOffset]) / BLOCK_SIZE + TOP;
    const look = topBlock(mem);
    if (!blocks.has(index)) blocks.set(index, look);
    else assert.equal(look, blocks.get(index), `seed ${seed} frame ${frame}: block ${index} differs`);
    last = distance;
    mode = mem[Z.gameMode];
  }
  return crashes;
}

test('the same distance is the same river in every game, across crashes', () => {
  const blocks = new Map();
  const runs = Array.from({ length: 6 }, (_, seed) => play(seed, blocks));
  const crashes = runs.flat();
  assert.ok(crashes.length >= 20, `only ${crashes.length} crashes`);
  assert.ok(Math.max(...blocks.keys()) > 5 * SECTION_BLOCKS, 'the games did not get past five sections');
  // a new jet starts at a section's start; with a section boundary on screen
  // LooseJet can make that the section before or after the crash's
  const section = (distance) => Math.floor(distance / SECTION_LINES);
  const moved = crashes.filter((c) => c.after !== undefined).map((c) => section(c.after) - section(c.before));
  assert.ok(moved.includes(0) && moved.includes(-1) && moved.includes(1), `restart sections ${moved}`);
});

// with a section boundary on screen LooseJet can restart in the next section
// instead (see above), so this pilot only crashes with none on screen
test('a crash away from a section boundary takes the jet back', () => {
  const game = newGame();
  const { mem, io } = game;
  const progress = createProgress();
  let before = null, mode = mem[Z.gameMode], checked = 0;
  for (let frame = 0; frame < 6000 && mem[Z.gameMode] !== GAME_OVER; frame += 1) {
    const boundary = !!((mem[Z.blockLst] ^ mem[Z.blockLst + TOP]) & PF_COLOR);
    pilot(game, frame, () => 1, (f) => f % 700 > 500 && !boundary);
    game.display = runFrame(mem, io).display;
    const distance = progress(mem);
    if (mode >= 0x80 && mem[Z.gameMode] < 0x80 && before !== null) {
      assert.ok(distance < before, `respawned at ${distance}, crashed at ${before}`);
      checked += 1;
    }
    if (mem[Z.gameMode] < 0x80) before = distance;
    mode = mem[Z.gameMode];
  }
  assert.ok(checked >= 3, `only ${checked} respawns`);
});

test('two games that take off at other times read the same distance at the same river', () => {
  const runAt = (takeoff, fast) => {
    const { mem, io } = newGame();
    const progress = createProgress();
    const seen = new Map();
    for (let frame = 0; frame < 900; frame += 1) {
      io.swcha = frame >= takeoff && fast(frame) ? UP : NONE;
      io.inpt4 = frame === takeoff ? 0x00 : 0x80;
      runFrame(mem, io);
      if (mem[Z.gameMode] & 0x80) break;
      const distance = progress(mem);
      if (!seen.has(distance)) seen.set(distance, [mem[Z.PF1Lst], mem[Z.PF2Lst], mem[Z.PF1Lst + TOP], mem[Z.PF2Lst + TOP]].join(','));
    }
    return seen;
  };
  const a = runAt(100, () => false), b = runAt(157, (f) => f % 90 < 45);
  const shared = [...a.keys()].filter((d) => b.has(d) && d > 200);
  assert.ok(shared.length > 100, `only ${shared.length} shared distances`);
  for (const d of shared) assert.equal(b.get(d), a.get(d), `distance ${d}`);
});

test('score reads the six digits, blank before the first point', () => {
  const { mem } = newGame();
  assert.equal(score(mem), 0);
  [0x00, 0x08, 0x38, 0x48, 0x10, 0x00].forEach((low, i) => { mem[Z.scorePtr1 + 2 * i] = low; });
  assert.equal(score(mem), 17920);
});

test('score counts the points a game scores', () => {
  const game = newGame();
  const { mem, io } = game;
  let last = 0, rises = 0;
  for (let frame = 0; frame < 3000 && mem[Z.gameMode] !== GAME_OVER; frame += 1) {
    pilot(game, frame, () => 1, () => false);
    game.display = runFrame(mem, io).display;
    const points = score(mem);
    assert.ok(points >= last && points % 10 === 0, `${last} then ${points}`);
    if (points > last) rises += 1;
    last = points;
  }
  assert.ok(rises >= 5, `only ${rises} hits`);
});
