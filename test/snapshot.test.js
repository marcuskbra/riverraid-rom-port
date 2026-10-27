// Snapshot test: plays the port with fixed, seeded inputs and compares every
// frame (the zero page apart from scratch bytes, the sound registers and the
// screen as drawScreen paints it) with the run recorded in snapshot.json.
// Upstream compared the port with the real ROM; without the ROM, the port's
// recorded output is the reference, so a refactor must not change any frame.
//
//   node test/snapshot.test.js           compare with the recording
//   node test/snapshot.test.js --update  re-record after an intended change
import { readFileSync, writeFileSync } from 'node:fs';
import { romReset, runFrame, Z } from '../src/game/frame.js';
import { drawScreen, SCREEN_WIDTH, SCREEN_LINES } from '../src/game/screen.js';

const SNAPSHOT = new URL('./snapshot.json', import.meta.url);
const CHECKPOINT = 50; // frames per recorded hash
const SCENARIOS = [
  { name: 'attract', seed: 0, frames: 1500, idle: true }, // power on, no input, screensaver
  { name: 'one-player', seed: 1, frames: 4000 },
  { name: 'two-players', seed: 2, frames: 4000, players: 2 },
  // low fuel alarm and running out of fuel
  { name: 'low-fuel', seed: 3, frames: 3000, atReady: (mem) => { mem[Z.fuelHi] = 0x30; } },
  // 999,990 points: the first hit gives a bonus life and maxes out the score
  { name: 'high-score', seed: 4, frames: 2000, atReady: (mem, n) => { if (n === 0) [NINE, NINE, NINE, NINE, NINE, ZERO].forEach((d, i) => { mem[Z.scorePtr1 + 2 * i] = d; }); } },
];
const STICKS = [0xef, 0xef, 0xdf, 0xbf, 0x7f, 0xaf, 0x6f, 0xff]; // up (twice as likely), down, left, right, up+left, up+right, none
// zero-page bytes the frame code only uses as temporaries: a refactor may move
// them into locals, so they are left out of the hash. Scrambling all of them
// before every frame leaves every recorded checkpoint unchanged.
const SCRATCH = [0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xd9, 0xda, 0xdb, 0xdc, 0xde, 0xed, 0xee, 0xef, 0xf0, 0xf1, 0xf2, 0xf3, 0xfc, 0xfd, 0xfe, 0xff];
const GAME_OVER = 0xff, READY = 48, NINE = 0x48, ZERO = 0x00; // score digits: low bytes of pointers to 8-line shapes

// FNV-1a over everything a frame produces
let hash;
const mix = (v) => { hash = Math.imul(hash ^ v, 0x01000193) >>> 0; };
function feed(v) {
  if (typeof v === 'number') mix(v);
  else if (typeof v === 'boolean') mix(v ? 1 : 0);
  else if (v === undefined || v === null) mix(-1);
  else if (ArrayBuffer.isView(v)) {
    mix(v.length);
    // the screen image is most of the data: hash it 4 bytes at a time
    const words = v.byteOffset % 4 === 0 && v.byteLength % 4 === 0 ? new Uint32Array(v.buffer, v.byteOffset, v.byteLength / 4) : v;
    for (let i = 0; i < words.length; i += 1) mix(words[i]);
  }
  else if (Array.isArray(v)) { mix(v.length); v.forEach(feed); }
  else {
    for (const key of Object.keys(v).sort()) {
      for (let i = 0; i < key.length; i += 1) mix(key.charCodeAt(i));
      feed(v[key]);
    }
  }
}

function play({ seed, frames, idle = false, players = 1, atReady }) {
  const mem = new Uint8Array(0x100);
  const io = { swcha: 0xff, swchb: 0x0b, inpt4: 0x80, inpt5: 0x80 };
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const stats = { framesPlaying: 0, crashes: 0, gameOvers: 0, bridgesHit: 0, refuels: 0, lowFuelFrames: 0, scoreChanges: 0, bonusLives: 0, playerSwaps: 0, maxLevel: 0, screensaverFrames: 0 };
  const checkpoints = [];
  const image = { data: new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_LINES * 4) };
  let started = false, overAt = -1, stick = 0xff, readyCount = 0;
  hash = 0x811c9dc5;
  romReset(mem, 0);
  // the screensaver starts when SS_Delay wraps, about 18 minutes after power on;
  // 0xfe has bit 7 set, so it is on from the first frame, and SS_Delay wraps
  // (the ROM's switch-on path) after about 500 frames
  if (idle) mem[Z.SS_Delay] = 0xfe;
  for (let f = 0; f < frames; f += 1) {
    io.swcha = 0xff; io.swchb = 0x0b; io.inpt4 = 0x80; io.inpt5 = 0x80;
    const over = mem[Z.gameMode] === GAME_OVER;
    overAt = over ? (overAt < 0 ? f : overAt) : -1;
    if (!idle && f >= 5 && (!started || (over && f - overAt > 60))) {
      // start a game: SELECT until the variation matches the player count, then RESET
      const wantVariation = players === 2 ? 1 : 0;
      io.swchb = (mem[Z.gameVariation] & 1) === wantVariation ? 0x0a : 0x09;
    } else if (!idle && started) {
      if (f % 24 === 0) stick = STICKS[Math.floor(rand() * STICKS.length)];
      io.swcha = (stick & 0xf0) | (stick >> 4); // player 2 mirrors player 1
      io.inpt4 = io.inpt5 = rand() < 0.3 ? 0x00 : 0x80;
    }
    const before = mem.slice();
    const out = runFrame(mem, io);
    const state = mem.slice();
    for (const a of SCRATCH) state[a] = 0;
    feed(state);
    feed({ audio: io.audio, reset: Boolean(out.reset) });
    drawScreen(out.display, io, image);
    feed(image.data);
    if ((f + 1) % CHECKPOINT === 0 || f === frames - 1) checkpoints.push(hash.toString(16).padStart(8, '0'));

    if (out.reset) { started = true; continue; }
    const mode = mem[Z.gameMode], wasPlaying = before[Z.gameMode] === 0;
    if (mode === READY && before[Z.gameMode] !== READY && atReady) atReady(mem, readyCount++);
    if (mode === 0) stats.framesPlaying += 1;
    if (wasPlaying && mode > READY && mode !== GAME_OVER) stats.crashes += 1;
    if (mode === GAME_OVER && before[Z.gameMode] !== GAME_OVER) stats.gameOvers += 1;
    if (mem[Z.bridgeExplode] && !before[Z.bridgeExplode]) stats.bridgesHit += 1;
    if (wasPlaying && mode === 0 && mem[Z.fuelHi] > before[Z.fuelHi]) stats.refuels += 1;
    if (mode === 0 && mem[Z.fuelHi] < 0x40) stats.lowFuelFrames += 1;
    if (wasPlaying && mem.subarray(Z.scorePtr1, Z.scorePtr1 + 12).some((b, i) => b !== before[Z.scorePtr1 + i])) stats.scoreChanges += 1;
    if (wasPlaying && mem[Z.livesPtr] > before[Z.livesPtr] && before[Z.player] === mem[Z.player]) stats.bonusLives += 1;
    if (mem[Z.player] !== before[Z.player]) stats.playerSwaps += 1;
    if (mem[Z.SS_Mask] !== 0xff) stats.screensaverFrames += 1;
    stats.maxLevel = Math.max(stats.maxLevel, mem[Z.level]);
  }
  return { frames, checkpoints, stats };
}

const update = process.argv.includes('--update');
const recorded = update ? {} : JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
const results = {};
let failures = 0;
for (const scenario of SCENARIOS) {
  const run = play(scenario);
  results[scenario.name] = { ...run, checkpoints: run.checkpoints.join(' ') };
  if (update) { console.log(scenario.name, run.stats); continue; }
  const want = recorded[scenario.name];
  if (!want) { failures += 1; console.log(`${scenario.name}: not recorded; run with --update`); continue; }
  const wantCheckpoints = want.checkpoints.split(' ');
  const i = run.checkpoints.findIndex((c, k) => c !== wantCheckpoints[k]);
  if (i < 0 && run.checkpoints.length === wantCheckpoints.length) continue;
  failures += 1;
  const at = i < 0 ? Math.min(run.checkpoints.length, wantCheckpoints.length) : i;
  console.log(`${scenario.name}: first change in frames ${at * CHECKPOINT} to ${Math.min((at + 1) * CHECKPOINT, scenario.frames) - 1}`);
  for (const [key, value] of Object.entries(run.stats)) {
    if (value !== want.stats[key]) console.log(`  ${key}: recorded ${want.stats[key]}, now ${value}`);
  }
}
if (update) {
  writeFileSync(SNAPSHOT, JSON.stringify(results, null, 2) + '\n');
  console.log('snapshot-check recorded');
} else if (failures) {
  console.log(`snapshot-check failed: ${failures} of ${SCENARIOS.length} scenarios changed`);
  process.exit(1);
} else {
  console.log(`snapshot-check ok (${SCENARIOS.length} scenarios, ${SCENARIOS.reduce((n, s) => n + s.frames, 0)} frames)`);
}
