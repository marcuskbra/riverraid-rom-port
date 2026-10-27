// River Raid frame logic, ported instruction for instruction from the ROM
// (Jentzsch disassembly): MainLoop up to the kernel, the end of the status
// display, and the main loop from .noCrash2 ($F489) to .mainLoopJmp,
// including Reset, GameInit, LooseJet, SwapPlayers and the sound routine.
// The kernel's collision checks are modelled in river-raid.js.
// Upstream (Plicerin/riverraid-rom-port) verified this against the ROM on a 6502 core.
//
// io: { swcha, swchb, inpt4, inpt5 } inputs; the port writes io.colubk,
// io.colup0 and io.audio = { c0, f0, v0, c1, f1, v1 } (TIA values).

import {
  ZP as RIVER_ZP, saveSection, runSetBlockVars, INIT_TAB,
  kernelPlayfieldLines, kernelObjectLines, kernelLineMasks, collisionTimes, applyKernelCollisions,
} from './river-raid.js';
import { COLOR_TAB, ANIMATE_ID_TAB, SCORE_TAB, VOLUME_TAB, JET_PAGE_TAIL, PF_PAGE_FC } from './data/playfield.js';
import { KERNEL_SHAPE_BYTES } from './data/kernel-sprites.js';
import { statusLines } from './status.js';

export const Z = Object.freeze({
  ...RIVER_ZP,
  gameVariation: 0x80, gameDelay: 0x81, frameCnt: 0x82, random: 0x83, joystick: 0x84, SS_XOR: 0x85, SS_Mask: 0x86,
  shapePtr0: 0xba, livesPtr: 0xc0, player1State: 0xbd, player2State: 0xc2, livesPtr2: 0xc5, gameMode: 0xc6,
  scorePtr1: 0xcd, scorePtr2: 0xdd, PFcolor: 0xee, playerColor: 0xef, player: 0xf4, SS_Delay: 0xf7,
  sound0Id: 0xf8, sound0Cnt: 0xf9, bridgeSound: 0xfa, missileSound: 0xfb,
});

export const LOW = Object.freeze({
  Zero: 0x00, One: 0x08, Two: 0x10, Three: 0x18, Nine: 0x48, MaxOut: 0x50, Space: 0x58, Copyright0: 0x59,
  JetStraight: 0xbc, JetMove: 0xce, JetExplode: 0xe0,
});
const GAME = Object.freeze({
  DIGIT_H: 8, INTRO_SCROLL: 48, NUM_LINES: 160, MAX_LEVEL: 48, MIN_MISSILE: 13, MAX_MISSILE: 161, MISSILE_SPEED: 6,
  ID_PLANE: 4, ID_SHIP: 7, ID_BRIDGE: 8, ID_EXPLOSION1: 1, ID_EXPLOSION2: 2, DARK_RED: 0x42,
  ENEMY_MOVE: 0x40, PF_COLLIDE: 0x20, PATROL: 0x10, PF_ROAD: 0x80, PF_COLOR: 0x04, DIRECTION: 0x08,
});
const END = (list) => list + 5;

// 6502 register/flag model operating on the zero page image.
class Regs {
  constructor(mem) { this.m = mem; this.a = 0; this.x = 0; this.y = 0; this.c = 0; this.n = 0; this.z = 0; this.v = 0; }
  nz(v) { v &= 0xff; this.n = v >> 7; this.z = v === 0 ? 1 : 0; return v; }
  rd(addr) { return this.m[addr & 0xff]; }
  wr(addr, v) { this.m[addr & 0xff] = v & 0xff; }
  lda(v) { this.a = this.nz(v); }
  ldx(v) { this.x = this.nz(v); }
  ldy(v) { this.y = this.nz(v); }
  adc(v) {
    const r = this.a + v + this.c;
    this.c = r > 0xff ? 1 : 0;
    this.v = ((~(this.a ^ v) & (this.a ^ r)) & 0x80) ? 1 : 0;
    this.a = this.nz(r);
  }
  sbc(v) { this.adc(v ^ 0xff); }
  cmp(reg, v) { this.c = reg >= v ? 1 : 0; this.nz(reg - v); }
  and(v) { this.a = this.nz(this.a & v); }
  ora(v) { this.a = this.nz(this.a | v); }
  eor(v) { this.a = this.nz(this.a ^ v); }
  bit(v) { this.z = (this.a & v) === 0 ? 1 : 0; this.n = (v >> 7) & 1; this.v = (v >> 6) & 1; }
  asl() { this.c = this.a >> 7; this.a = this.nz(this.a << 1); }
  lsr() { this.c = this.a & 1; this.a = this.nz(this.a >> 1); }
  rol() { const c = this.c; this.c = this.a >> 7; this.a = this.nz((this.a << 1) | c); }
  rolMem(addr) { const v = this.rd(addr); const c = this.c; this.c = v >> 7; this.wr(addr, this.nz((v << 1) | c)); }
  inc(addr) { this.wr(addr, this.nz(this.rd(addr) + 1)); }
  dec(addr) { this.wr(addr, this.nz(this.rd(addr) - 1)); }
  inx() { this.x = this.nz(this.x + 1); }
  dex() { this.x = this.nz(this.x - 1); }
  iny() { this.y = this.nz(this.y + 1); }
  dey() { this.y = this.nz(this.y - 1); }
  tax() { this.x = this.nz(this.a); }
  txa() { this.a = this.nz(this.x); }
  tay() { this.y = this.nz(this.a); }
  tya() { this.a = this.nz(this.y); }
}

const mult16 = (r) => { r.asl(); r.asl(); r.asl(); r.asl(); };

// SetScorePtr1 ($FF1C): scorePtr1 bytes from offset `from` down to 0, every other byte
function setScorePtr1(mem, value, from) {
  for (let i = from; i >= 0; i -= 2) mem[Z.scorePtr1 + i] = value;
}

// SetScorePtrs ($FF0C): variation digit (scorePtr1/2 + 10), blank scores
function setScorePtrs(mem, digit) {
  mem[Z.scorePtr1 + 10] = digit;
  mem[Z.scorePtr2 + 10] = digit;
  for (let i = 0; i <= 8; i += 2) mem[Z.scorePtr2 + i] = LOW.Space;
  setScorePtr1(mem, LOW.Space, 8);
}

// GameInit ($FA8F): count = number of InitTab bytes (23 for a new jet, 39 at reset)
function gameInit(mem, count) {
  mem.set(INIT_TAB.slice(0, count), Z.PF1Lst);
  mem.fill(0, Z.dXSpeed, Z.dXSpeed + 31);
  mem.fill(mem[Z.level] & 1 ? 1 | GAME.PF_COLOR : 1, Z.blockLst, Z.blockLst + 6); // PF1_PAGE_FLAG
}

// SwapPlayers ($FFC8 area): two-player games swap state, lives and score
function swapPlayers(mem) {
  const variation = mem[Z.gameVariation];
  if (!variation) return;
  mem[Z.player] ^= variation;
  const swap = (a, b) => { const t = mem[a]; mem[a] = mem[b]; mem[b] = t; };
  for (let i = 0; i < 4; i += 1) swap(Z.player1State + i, Z.player2State + i);
  for (let i = 0; i <= 10; i += 2) swap(Z.scorePtr1 + i, Z.scorePtr2 + i);
}

function contFinish(mem, mode) {
  mem[Z.gameMode] = mode;
  mem[Z.missileY] = GAME.NUM_LINES + 20;
}

// LooseJet ($FF5C): start the explosion sound, fix the restart point when a
// section boundary is on screen, and start the jet explosion
function looseJet(mem, soundId, soundCnt) {
  mem[Z.sound0Cnt] = soundCnt;
  mem[Z.sound0Id] = soundId;
  if ((mem[Z.blockLst] ^ mem[END(Z.blockLst)]) & GAME.PF_COLOR) {
    const road = mem[END(Z.blockLst)] & GAME.PF_ROAD;
    if (mem[Z.sectionEnd]) {
      if (road) saveSection(mem);
    } else if (!road) {
      // .isEnd
      const level = mem[Z.level] - 1;
      mem[Z.level] = level === GAME.MAX_LEVEL - 2 ? GAME.MAX_LEVEL : level;
      mem[Z.randomLoSave] = mem[Z.randomLoSave2];
      mem[Z.randomHiSave] = mem[Z.randomHiSave2];
    }
  }
  mem[Z.shapePtr0] = LOW.JetExplode - 1;
  contFinish(mem, LOW.JetExplode - 1);
}

// FinishGame
function finishGame(mem) {
  mem[Z.frameCnt] = 0xff;
  contFinish(mem, 0xff);
}

// Reset ($F004) with x = first address to clear (0 at power-on, $F7 for the RESET switch)
export function romReset(mem, x = 0) {
  mem.fill(0, Math.max(x, 0x80), 0x100);
  setScorePtrs(mem, 0);
  for (let i = 1; i < 12; i += 2) mem[Z.scorePtr1 + i] = 0xfb; // >Zero
  gameInit(mem, 39);
  if (mem[Z.random]) return;
  mem[Z.random] = 1;
  mem[Z.livesPtr] = 0;
  mem[Z.scorePtr1 + 10] = LOW.One;
}

// MainLoop ($F027) up to the kernel: colors, bridge flicker, collision variables.
function preKernel(mem, io) {
  const ssXor = mem[Z.SS_XOR], ssMask = mem[Z.SS_Mask];
  COLOR_TAB.forEach((color, i) => { mem[Z.PFcolor + i] = (color ^ ssXor) & ssMask; });
  io.colubk = mem[Z.PFcolor + 4];
  io.colup0 = mem[Z.playerColor];
  // player 2's jet takes the PFcolor value, unless the variation digit is 2 or RESET is pressed
  if (mem[Z.scorePtr1 + 10] !== LOW.Two && io.swchb & 1 && mem[Z.player]) {
    mem[Z.playerColor] = mem[Z.PFcolor];
    io.colup0 = mem[Z.PFcolor];
  }
  // flicker background when a bridge explodes
  const bridge = mem[Z.bridgeExplode];
  if (bridge) {
    mem[Z.bridgeExplode] = bridge - 1;
    if (bridge & 1) io.colubk = GAME.DARK_RED & ssMask;
  }
  for (const a of [Z.hitEnemyIdx, Z.PFCrashFlag, Z.missileFlag, Z.collidedEnemy]) mem[a] = 0xff;
}

// shapePtr0 points into page $FC (jet shapes, or pattern bytes after game over)
const pageFC = (low) => (low < 0xbc ? PF_PAGE_FC[low] : JET_PAGE_TAIL[low - 0xbc]) ?? 0;
const jetTable = (low) => Array.from({ length: 18 }, (_, i) => pageFC((low + 1 + i) & 0xff));

// The kernel's effect on RAM: collision results per block.
// Also returns what the kernel displays: per-line playfield/object data, pixel
// masks and the screensaver color transform (EOR SS_XOR, AND SS_Mask).
function kernel(mem) {
  const pf = kernelPlayfieldLines(mem);
  const objs = kernelObjectLines(mem, KERNEL_SHAPE_BYTES, jetTable(mem[Z.shapePtr0]));
  const masks = kernelLineMasks(mem, pf, objs);
  applyKernelCollisions(mem, collisionTimes(masks));
  return { pf, objs, masks, ssXor: mem[Z.SS_XOR], ssMask: mem[Z.SS_Mask] };
}

// End of DisplayState that affects RAM (collision checks are part of kernel()).
function statusTail(mem) {
  mem[Z.reflect0] = 0;
  if (mem[Z.gameMode] === 0xff) mem[Z.livesPtr] = LOW.Space;
}

// Frame counter, screensaver colors and the random byte.
function screensaver(mem, io) {
  mem[Z.frameCnt] -= 1;
  if (mem[Z.frameCnt] === 0) {
    if (mem[Z.gameMode] === 0xff) swapPlayers(mem); // game over: show the other player's score
    mem[Z.SS_Delay] += 1;
    if (mem[Z.SS_Delay] === 0) mem[Z.SS_Delay] = 0x80; // the screensaver stays on
  }
  // the B/W switch keeps the luminance bits only; the screensaver also clears
  // a luminance bit and shifts the colors by SS_Delay
  let mask = io.swchb & 0x08 ? 0xff : 0x0f, xor = 0;
  if (mem[Z.SS_Delay] & 0x80) { mask &= 0xf7; xor = mem[Z.SS_Delay]; }
  mem[Z.SS_XOR] = xor << 1;
  mem[Z.SS_Mask] = mask;
  const random = mem[Z.random];
  mem[Z.random] = (random << 1) | (((random >> 4) ^ (random >> 7)) & 1);
}

// Moves enemy i one pixel, working directly on its positioning values:
// XPos1Lst holds the coarse position and the top nibble of State1Lst the fine one.
function moveEnemyX(mem, i) {
  const state = mem[Z.State1Lst + i];
  let coarse = mem[Z.XPos1Lst + i], fine = (state >> 4) ^ 7;
  if (state & GAME.DIRECTION) {
    fine -= 1;
    if (fine < 0) {
      fine = 14;
      coarse = (coarse - 1) & 0xff;
      if (coarse & 0x80) { coarse = 10; fine = 9; } // wrap to the right edge
    }
  } else {
    fine += 1;
    if (fine >= 15) { fine -= 15; coarse = (coarse + 1) & 0xff; }
    if (coarse >= 10 && fine >= 10) { coarse = 0; fine = 0; } // wrap to the left edge
  }
  mem[Z.XPos1Lst + i] = coarse;
  mem[Z.State1Lst + i] = ((fine ^ 7) << 4) | (state & 0x0f);
}

// Animates the enemies and moves them (from level 2 on, while the game runs).
function moveEnemies(mem) {
  const frame = mem[Z.frameCnt];
  // every 16 frames a random block's enemy starts moving
  if ((frame & 0x0f) === 0) {
    const i = mem[Z.random] & 0x07;
    mem[Z.blockLst + (i >= 5 ? i - 5 : i)] |= GAME.ENEMY_MOVE;
  }
  const moving = mem[Z.gameMode] === 0 && mem[Z.level] >= 2;
  for (let i = 5; i >= 0; i -= 1) {
    let id = mem[Z.Shape1IdLst + i];
    // explosions advance every 16 frames, the other animations every other frame
    if (id < GAME.ID_SHIP && (frame & (id < GAME.ID_PLANE ? 0x0f : 0x01)) === 0) {
      id = ANIMATE_ID_TAB[id];
      mem[Z.Shape1IdLst + i] = id;
    }
    if (moving && id === GAME.ID_PLANE) moveEnemyX(mem, i);
    else if (moving && id > GAME.ID_PLANE && id < GAME.ID_BRIDGE && !(frame & 1)) {
      const block = mem[Z.blockLst + i];
      if (block & GAME.ENEMY_MOVE) {
        // turn around on touching the bank; PATROL stops another turn until it is clear
        if (!(block & GAME.PF_COLLIDE)) mem[Z.blockLst + i] = block & ~GAME.PATROL;
        else if (!(block & GAME.PATROL)) {
          mem[Z.State1Lst + i] ^= GAME.DIRECTION;
          mem[Z.blockLst + i] = block | GAME.PATROL;
        }
        moveEnemyX(mem, i);
      }
    }
    mem[Z.blockLst + i] &= ~GAME.PF_COLLIDE;
  }
}

// Shifts this frame's stick into joystick (low nibble: right, left, down and
// up, 0 = pressed; high nibble: the last frame's) and returns whether the
// stick or the fire button is in use.
function readJoystick(mem, io) {
  const player = mem[Z.player];
  const stick = player ? io.swcha & 0x0f : io.swcha >> 4;
  mem[Z.joystick] = (mem[Z.joystick] << 4) | stick;
  return stick !== 0x0f || !((player ? io.inpt5 : io.inpt4) & 0x80);
}

// A new jet: the river restarts at the last saved section.
function initPlayer(mem) {
  gameInit(mem, 23); // PF1Lst..shapePtr0+1
  mem[END(Z.blockLst)] |= GAME.PF_ROAD;
  mem[Z.randomLo] = mem[Z.randomLoSave];
  mem[Z.randomHi] = mem[Z.randomHiSave];
}

// gameMode is 0 while playing and 0xff after the game. From 0x80 up it counts
// down while the jet explodes, from 49 up while the river scrolls in, and 48
// waits for the stick. Returns true while playing.
function updateGameMode(mem) {
  const mode = mem[Z.gameMode];
  if (mode === 0) return true;
  if (mode === 0xff) return false;
  if (mode & 0x80) {
    mem[Z.gameMode] = mode - 1;
    if (mode === 0x80) {
      // the explosion is over: the other player's turn, a new jet or the end
      mem[Z.shapePtr0] = 0;
      if (mem[Z.livesPtr2] !== LOW.Copyright0) swapPlayers(mem);
      if (mem[Z.livesPtr] !== LOW.Copyright0) initPlayer(mem);
      else finishGame(mem);
    }
  } else if (mode === GAME.INTRO_SCROLL + 1) {
    // the river has scrolled in: the jet uses up a life
    const lives = mem[Z.livesPtr];
    if (!lives) { finishGame(mem); return false; }
    let left = (lives - GAME.DIGIT_H) & 0xff;
    if (left === 0) left = LOW.Copyright0; // the last jet
    if (left === LOW.MaxOut) left = LOW.Three; // a new game (lives blank)
    mem[Z.livesPtr] = left;
    mem[Z.gameMode] = mode - 1;
  } else if (mode > GAME.INTRO_SCROLL + 1) mem[Z.gameMode] = mode - 1;
  return false;
}

// Flying over a fuel depot fills the tank 2 units a frame (with a sound).
function refuel(mem) {
  let fuel = mem[Z.fuelHi] + 2, sound = 4;
  if (fuel > 0xff) { fuel = 0xff; mem[Z.fuelLo] = 0xff; sound = 3; } // full
  mem[Z.fuelHi] = fuel;
  if (mem[Z.sound0Id] !== sound) {
    mem[Z.sound0Id] = sound;
    mem[Z.sound0Cnt] = 0x08;
  }
}

// Returns false when the tank is empty.
function burnFuel(mem) {
  const lo = mem[Z.fuelLo] - 0x20;
  if (lo < 0) {
    if (!mem[Z.fuelHi]) return false;
    mem[Z.fuelHi] -= 1;
  }
  mem[Z.fuelLo] = lo;
  return true;
}

// Steers the jet and returns its shape. speedX accumulates dXSpeed, which
// grows by 8 a frame while the stick is held; each carry moves one pixel.
function moveJetX(mem, stick) {
  if ((stick & 0x0c) === 0x0c) {
    mem[Z.dXSpeed] = 0;
    mem[Z.speedX] = 0;
    return LOW.JetStraight - 1;
  }
  const maxed = mem[Z.dXSpeed] >= 0xf8;
  if (!maxed) mem[Z.dXSpeed] += 8;
  const dx = mem[Z.dXSpeed], left = stick & 0x08; // right not pressed
  mem[Z.reflect0] = left;
  let speed = left;
  if (left) {
    if (!maxed) {
      speed = mem[Z.speedX] - dx;
      if (speed >= 0) { mem[Z.speedX] = speed; return LOW.JetMove - 1; }
    }
    mem[Z.playerX] -= 1;
    if (mem[Z.playerX]) { mem[Z.speedX] = speed; return LOW.JetMove - 1; }
    // playerX reached 0: the ROM falls through into the right turn
  }
  if (!maxed) {
    // the first frame of a right turn moves at once
    speed = (mem[Z.joystick] & 0x80 ? 0xff : mem[Z.speedX]) + dx;
    if (speed <= 0xff) { mem[Z.speedX] = speed; return LOW.JetMove - 1; }
  }
  mem[Z.playerX] += 1;
  mem[Z.speedX] = speed;
  return LOW.JetMove - 1;
}

// Up speeds the jet up, down slows it down and neither brings it back to 0x80.
function changeSpeed(mem, stick) {
  const speed = mem[Z.speedY], up = !(stick & 0x01), down = !(stick & 0x02);
  if (up || (!down && speed < 0x80)) {
    if (speed < 0xfe) mem[Z.speedY] = speed + 2;
  } else if ((down || speed !== 0x80) && speed > 0x40) mem[Z.speedY] = speed - 2;
}

// Adds the points for shape id to the score. A carry into the ten thousands
// digit gives a bonus life. Returns false when the score maxed out.
function addScore(mem, id) {
  let points = SCORE_TAB[id], i = 8;
  if (points & 0x80) { // hundreds
    points &= 0x7f;
    if (mem[Z.scorePtr1 + 8] === LOW.Space) mem[Z.scorePtr1 + 8] = LOW.Zero;
    i = 6;
  }
  for (; i >= 0; i -= 2) {
    if (i === 2) {
      const lives = mem[Z.livesPtr];
      if (lives !== LOW.Nine) mem[Z.livesPtr] = lives > LOW.Nine ? LOW.One : lives + GAME.DIGIT_H;
    }
    const digit = mem[Z.scorePtr1 + i] === LOW.Space ? LOW.Zero : mem[Z.scorePtr1 + i];
    const sum = (points + digit) & 0xff;
    if (sum < LOW.MaxOut) { mem[Z.scorePtr1 + i] = sum; return true; }
    mem[Z.scorePtr1 + i] = sum - LOW.MaxOut;
    points = GAME.DIGIT_H; // carry 1
  }
  // more than 999990 points: !!!!!!, game over
  setScorePtr1(mem, LOW.MaxOut, 10);
  mem[Z.livesPtr] = LOW.Copyright0;
  return false;
}

// Enemy i was hit by the jet or the missile.
function explode(mem, i, explosionId) {
  const id = mem[Z.Shape1IdLst + i];
  mem[Z.Shape1IdLst + i] = explosionId;
  mem[Z.bridgeSound] = 23;
  if (id === GAME.ID_BRIDGE) {
    mem[Z.bridgeExplode] = 23;
    mem[Z.State1Lst + i] = 0xe0 | 0b001; // fixed position, two copies close
    mem[Z.XPos1Lst + i] = 4;
    mem[Z.sectionEnd] += 1;
  }
  if (addScore(mem, id)) mem[Z.missileY] = 0xb4; // disable missile
  else looseJet(mem, 1, 0x1f);
}

// Moves the missile, or fires a new one. The jet's difficulty switch set to
// B makes the missile follow the jet.
function moveMissile(mem, io) {
  const player = mem[Z.player];
  let y = 0xb4, aim = false; // 0xb4: disabled
  if (mem[Z.missileFlag] & 0x80) { // no collision
    if (mem[Z.missileY] <= GAME.MAX_MISSILE) {
      y = mem[Z.missileY] + GAME.MISSILE_SPEED;
      aim = !((player ? io.swchb : io.swchb << 1) & 0x80);
    } else if (!((player ? io.inpt5 : io.inpt4) & 0x80)) {
      mem[Z.missileSound] = 0x0f;
      y = GAME.MIN_MISSILE;
      aim = true;
    }
  }
  if (aim) mem[Z.missileX] = mem[Z.playerX] + 5;
  mem[Z.missileY] = y;
}

// One frame of the running game: collisions, fuel, the jet, the missile.
function play(mem, io) {
  const enemy = mem[Z.collidedEnemy];
  if (enemy < 0x80) {
    const id = mem[Z.Shape1IdLst + enemy];
    if (id > GAME.ID_BRIDGE) refuel(mem);
    else if (id >= GAME.ID_PLANE) {
      if (id === GAME.ID_BRIDGE) mem[Z.sectionEnd] += 1;
      looseJet(mem, 1, 0x1f);
      explode(mem, enemy, GAME.ID_EXPLOSION2);
      return;
    }
  }
  if (!(mem[Z.PFCrashFlag] & 0x80)) { looseJet(mem, 1, 0x1f); return; }
  if (!burnFuel(mem)) { looseJet(mem, 2, 0x23); return; }
  const stick = mem[Z.joystick];
  mem[Z.shapePtr0] = moveJetX(mem, stick);
  changeSpeed(mem, stick);
  const hit = mem[Z.hitEnemyIdx];
  if (hit < 0x80 && mem[Z.Shape1IdLst + hit] >= GAME.ID_PLANE) explode(mem, hit, GAME.ID_EXPLOSION1);
  else moveMissile(mem, io);
}

// .noCrash2 ($F489) .. .mainLoopJmp: everything between two kernels.
// Returns { reset: true } when the RESET switch restarted the game.
function frameLogic(mem, io) {
  screensaver(mem, io);
  moveEnemies(mem);
  if (readJoystick(mem, io)) {
    // the stick or fire starts the jet and stops the screensaver
    if (mem[Z.gameMode] === GAME.INTRO_SCROLL) { mem[Z.speedY] = 64; mem[Z.gameMode] = 0; }
    mem[Z.SS_Delay] = 0;
  }
  const r = new Regs(mem);
  const audio = (io.audio = {});
  if (updateGameMode(mem)) play(mem, io);
  let L = 'doSound';
  for (;;) {
    switch (L) {
      case 'doSound':
        // *** sound routines (channel 0) ***
        r.ldy(0x1c);
        r.lda(r.rd(Z.sound0Cnt));
        r.ldx(r.rd(Z.sound0Id));
        if (r.z) { L = 'LF789'; continue; }
        r.dex();
        if (r.z) { L = 'LF770'; continue; }
        r.ldy(0x0f);
        r.cmp(r.x, 2);
        if (r.c) { L = 'LF776'; continue; }
        r.ldy(0x08);
      // falls through
      case 'LF770':
        r.lsr(); r.tax(); r.lda(0x08); // white noise
        L = 'LF77D'; continue;
      case 'LF776':
        if (!r.z) r.ldy(0x1f);
        r.tax(); r.lda(0x04); // LF77A: high pure tone
      // falls through
      case 'LF77D':
        r.dec(Z.sound0Cnt);
        if (!r.z) { L = 'setAud0'; continue; }
        { const a = r.a; r.lda(0); r.wr(Z.sound0Id, r.a); r.lda(a); }
        L = 'setAud0'; continue;
      case 'LF789':
        // low fuel sound
        r.lda(r.rd(Z.gameMode));
        if (!r.z) { L = 'mute0'; continue; }
        r.lda(r.rd(Z.fuelHi));
        r.cmp(r.a, 0x40);
        if (r.c) { L = 'jetSound'; continue; }
        r.ldy(r.rd(Z.sound0Cnt));
        if (r.z) r.ldy(0x3f);
        r.dey(); // .contSound0
        r.wr(Z.sound0Cnt, r.y);
        r.ldx(r.rd(Z.fuelLo)); r.wr(Z.temp, r.x);
        r.cmp(r.a, 0x04);
        if (r.c) { L = 'LF7B0'; continue; }
        r.rolMem(Z.temp); r.rol(); r.rolMem(Z.temp); r.rol();
        r.eor(0xff); r.adc(0x20);
        if (!r.z) { L = 'loadAud0'; continue; }
      // falls through
      case 'LF7B0':
        r.cmp(r.y, 0x1c);
        if (!r.c) { L = 'jetSound'; continue; }
        r.tya(); r.lsr();
      // falls through
      case 'loadAud0':
        r.tay(); r.lda(0x0c); r.ldx(0x0f);
        L = 'setAud0'; continue;
      case 'jetSound':
        r.lda(r.rd(Z.speedY)); r.lsr(); r.lsr(); r.lsr(); r.lsr();
        r.eor(0xff); r.c = 1; r.adc(0x1f);
        r.tay();
        r.lda(r.rd(Z.joystick)); r.and(0x03); r.tax();
        r.lda(VOLUME_TAB[r.x]); r.tax();
        r.lda(0x08); // white noise
      // falls through
      case 'setAud0':
        audio.c0 = r.a; audio.f0 = r.y;
      // falls through
      case 'mute0':
        audio.v0 = r.x;
        // channel 1: missile fire or bridge explosion
        r.lda(r.rd(Z.missileSound));
        if (r.z) { L = 'noMissileSound'; continue; }
        r.dec(Z.missileSound);
        r.ldx(r.rd(Z.bridgeSound));
        if (!r.z) { L = 'doBridge'; continue; }
        r.eor(0xff); r.c = 1; r.adc(0x1c);
        r.ldy(0x0c); r.ldx(0x08);
        L = 'setAud1'; continue;
      case 'noMissileSound':
        r.ldx(r.rd(Z.bridgeSound));
        if (r.z) { L = 'skipSound1'; continue; }
      // falls through
      case 'doBridge':
        r.dec(Z.bridgeSound);
        r.txa(); r.lsr(); r.c = 0; r.adc(0x04); r.tax();
        r.lda(r.rd(Z.random)); r.ora(0x18);
        r.ldy(0x08);
      // falls through
      case 'setAud1':
        audio.f1 = r.a; audio.c1 = r.y;
      // falls through
      case 'skipSound1':
        audio.v1 = r.x;
        // start next frame (VSYNC) leaves y = $82
        r.ldy(0x82);
        // *** check switches *** (read after VSYNC: io.swchbNext when the switches changed at the frame edge)
        r.lda(io.swchbNext ?? io.swchb); r.lsr();
        if (!r.c) {
          r.lda(r.rd(Z.gameVariation)); r.wr(Z.player, r.a);
          romReset(mem, 0xf7);
          return { reset: true };
        }
        r.lsr(); // .noReset
        if (r.c) { L = 'noSelect'; continue; }
        r.dec(Z.gameDelay);
        if (!r.n) { L = 'skipSelect'; continue; }
        r.lda(r.rd(Z.gameVariation)); r.eor(0x01); r.wr(Z.gameVariation, r.a);
        r.wr(Z.SS_Delay, r.a);
        r.wr(Z.player, r.a);
        r.asl(); r.asl(); r.asl(); r.adc(GAME.DIGIT_H);
        setScorePtrs(mem, r.a);
        finishGame(mem);
        r.ldy(0x1e);
      // falls through
      case 'noSelect':
        r.wr(Z.gameDelay, r.y);
      // falls through
      case 'skipSelect':
        r.lda(r.rd(Z.gameMode));
        if (r.n) return {};
        r.cmp(r.a, GAME.INTRO_SCROLL);
        if (!r.z) { runSetBlockVars(mem); return {}; }
        r.lda(LOW.JetStraight - 1); r.wr(Z.shapePtr0, r.a);
        return {};
      default:
        throw new Error(`frameLogic: unknown label ${L}`);
    }
  }
}

// One full frame: MainLoop setup, kernel collisions, status tail, game logic.
export function runFrame(mem, io) {
  preKernel(mem, io);
  const display = kernel(mem);
  statusTail(mem);
  display.status = statusLines(mem); // drawn by DisplayState before the frame logic runs
  const result = frameLogic(mem, io);
  return { ...result, display };
}
