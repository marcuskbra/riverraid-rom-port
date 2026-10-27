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

// .noCrash2 ($F489) .. .mainLoopJmp: everything between two kernels.
// Returns { reset: true } when the RESET switch restarted the game.
function frameLogic(mem, io) {
  const r = new Regs(mem);
  const audio = (io.audio = {});
  const stack = [];
  const ror = () => { const c = r.c; r.c = r.a & 1; r.a = r.nz((r.a >> 1) | (c << 7)); };
  let L = 'start';
  for (;;) {
    switch (L) {
      case 'start':
        // *** update framecounter, check for screensaver ***
        r.dec(Z.frameCnt);
        if (!r.z) { L = 'skipSS_Delay'; continue; }
        r.ldx(r.rd(Z.gameMode)); r.inx();
        if (r.z) swapPlayers(mem);
        r.inc(Z.SS_Delay); // .skipInit
        if (!r.z) { L = 'skipSS_Delay'; continue; }
        { const v = r.rd(Z.SS_Delay); r.wr(Z.SS_Delay, r.nz((v >> 1) | 0x80)); r.c = v & 1; } // SEC / ROR
      // falls through
      case 'skipSS_Delay':
        r.ldy(0xff);
        r.lda(io.swchb); r.and(0x08);
        if (r.z) r.ldy(0x0f);
        r.tya(); // .colorMode
        r.ldy(0);
        r.bit(r.rd(Z.SS_Delay));
        if (r.n) { r.and(0xf7); r.ldy(r.rd(Z.SS_Delay)); }
        r.wr(Z.SS_XOR, r.y); // .noScreenSaver
        { const v = r.rd(Z.SS_XOR); r.c = v >> 7; r.wr(Z.SS_XOR, r.nz(v << 1)); }
        r.wr(Z.SS_Mask, r.a);
        // *** randomly start movement of enemies ***
        r.lda(r.rd(Z.random)); r.asl(); r.asl(); r.asl(); r.eor(r.rd(Z.random)); r.asl();
        r.rolMem(Z.random);
        r.lda(r.rd(Z.frameCnt)); r.and(0x0f);
        if (r.z) {
          r.lda(r.rd(Z.random)); r.and(0x07);
          r.cmp(r.a, 5);
          if (r.c) r.sbc(5);
          r.tax(); // .inBound
          r.lda(r.rd(Z.blockLst + r.x)); r.ora(GAME.ENEMY_MOVE); r.wr(Z.blockLst + r.x, r.a);
        }
        // *** animate and move the enemy objects ***
        r.ldx(5);
      // falls through
      case 'loopEnemies':
        r.ldy(r.rd(Z.Shape1IdLst + r.x));
        r.cmp(r.y, GAME.ID_SHIP);
        if (r.c) { L = 'skipAnimate'; continue; }
        r.lda(0x01);
        r.cmp(r.y, GAME.ID_PLANE);
        if (!r.c) r.lda(0x0f);
        r.and(r.rd(Z.frameCnt)); // .fastAnimation
        if (!r.z) { L = 'skipAnimate'; continue; }
        r.lda(ANIMATE_ID_TAB[r.y]); r.wr(Z.Shape1IdLst + r.x, r.a); r.tay();
      // falls through
      case 'skipAnimate':
        r.lda(r.rd(Z.gameMode));
        if (!r.z) { L = 'skipMoveEnemy'; continue; }
        r.lda(r.rd(Z.level)); r.lsr();
        if (r.z) { L = 'skipMoveEnemy'; continue; }
        r.cmp(r.y, GAME.ID_PLANE);
        if (r.z) { L = 'xMoveEnemy'; continue; }
        if (!r.c) { L = 'skipMoveEnemy'; continue; }
        r.cmp(r.y, GAME.ID_BRIDGE);
        if (r.c) { L = 'skipMoveEnemy'; continue; }
        r.lda(r.rd(Z.frameCnt)); ror();
        if (r.c) { L = 'skipMoveEnemy'; continue; }
        r.lda(r.rd(Z.blockLst + r.x)); r.asl();
        if (!r.n) { L = 'skipMoveEnemy'; continue; }
        r.asl();
        if (!r.n) { L = 'noPFCollision'; continue; }
        r.asl();
        if (r.n) { L = 'xMoveEnemy'; continue; }
        r.lda(r.rd(Z.State1Lst + r.x)); r.eor(GAME.DIRECTION); r.wr(Z.State1Lst + r.x, r.a);
        r.lda(r.rd(Z.blockLst + r.x)); r.ora(GAME.PATROL);
        L = 'endChangeDir'; continue;
      case 'noPFCollision':
        r.lda(r.rd(Z.blockLst + r.x)); r.and(~GAME.PATROL & 0xff);
      // falls through
      case 'endChangeDir':
        r.wr(Z.blockLst + r.x, r.a);
      // falls through
      case 'xMoveEnemy':
        // move enemy one pixel, working directly on the positioning values
        r.ldy(r.rd(Z.XPos1Lst + r.x));
        r.lda(r.rd(Z.State1Lst + r.x)); r.lsr(); r.lsr(); r.lsr(); r.lsr();
        r.eor(0x07);
        if (r.c) { L = 'xMoveLeft'; continue; }
        r.adc(1);
        r.cmp(r.a, 15);
        if (r.c) { r.sbc(15); r.iny(); }
        r.cmp(r.y, 10); // .skipRightIny
        if (!r.c) { L = 'contMoveX'; continue; }
        r.cmp(r.a, 10);
        if (!r.c) { L = 'contMoveX'; continue; }
        r.ldy(0); r.tya();
        L = 'contMoveX'; continue;
      case 'xMoveLeft':
        r.sbc(1);
        if (r.c) { L = 'contMoveX2'; continue; }
        r.adc(15);
        r.dey();
        if (!r.n) { L = 'contMoveX'; continue; }
        r.ldy(10); r.lda(9);
      // falls through
      case 'contMoveX':
        r.wr(Z.XPos1Lst + r.x, r.y);
      // falls through
      case 'contMoveX2':
        r.eor(0x07);
        mult16(r);
        r.eor(r.rd(Z.State1Lst + r.x)); r.and(0xf0); r.eor(r.rd(Z.State1Lst + r.x));
        r.wr(Z.State1Lst + r.x, r.a);
      // falls through
      case 'skipMoveEnemy':
        r.lda(r.rd(Z.blockLst + r.x)); r.and(~GAME.PF_COLLIDE & 0xff); r.wr(Z.blockLst + r.x, r.a);
        r.dex();
        if (!r.n) { L = 'loopEnemies'; continue; }
        // *** read joystick ***
        r.lda(io.swcha);
        r.ldx(r.rd(Z.player));
        if (!r.z) mult16(r);
        r.and(0xf0); // .player1
        r.tax();
        r.ldy(4);
        do { r.rol(); r.rolMem(Z.joystick); r.dey(); } while (!r.z);
        r.cmp(r.x, 0xf0);
        if (!r.z) { L = 'joystickMoved'; continue; }
        r.ldx(r.rd(Z.player));
        r.lda(r.x ? io.inpt5 : io.inpt4);
        if (r.n) { L = 'noFire'; continue; }
      // falls through
      case 'joystickMoved':
        r.lda(r.rd(Z.gameMode));
        r.cmp(r.a, GAME.INTRO_SCROLL);
        if (r.z) { r.lda(64); r.wr(Z.speedY, r.a); r.wr(Z.gameMode, r.y); }
        r.wr(Z.SS_Delay, r.y); // .skipRestart
      // falls through
      case 'noFire':
        r.ldx(r.rd(Z.gameMode));
        if (r.z) { L = 'checkCollisions'; continue; }
        if (r.n) { L = 'gameOver'; continue; }
        r.cmp(r.x, GAME.INTRO_SCROLL + 1);
        if (!r.c) { L = 'doSound'; continue; }
        if (!r.z) { L = 'startGame'; continue; }
        // decrease lives
        r.lda(r.rd(Z.livesPtr));
        if (r.z) { L = 'finishGame'; continue; }
        r.sbc(GAME.DIGIT_H);
        if (r.z) r.lda(LOW.Space + 1);
        r.cmp(r.a, LOW.MaxOut); // LF5B5
        if (r.z) r.lda(LOW.Three);
        r.wr(Z.livesPtr, r.a); // LF5BB
      // falls through
      case 'startGame':
        r.dec(Z.gameMode);
        if (!r.z) { L = 'doSound'; continue; }
      // falls through
      case 'gameOver':
        r.inx();
        if (r.z) { L = 'doSound'; continue; }
        r.dec(Z.gameMode);
        if (r.n) { L = 'doSound'; continue; }
        r.wr(Z.shapePtr0, r.y);
        r.lda(r.rd(Z.livesPtr2));
        r.cmp(r.a, LOW.Copyright0);
        if (!r.z) swapPlayers(mem);
        r.lda(r.rd(Z.livesPtr)); // .skipSwap
        r.cmp(r.a, LOW.Copyright0);
        if (!r.z) { L = 'initPlayer'; continue; }
      // falls through
      case 'finishGame':
        finishGame(mem);
        L = 'doSound'; continue;
      case 'initPlayer':
        gameInit(mem, 23); // PF1Lst..shapePtr0+1
        mem[END(Z.blockLst)] |= GAME.PF_ROAD;
        r.lda(r.rd(Z.randomLoSave)); r.wr(Z.randomLo, r.a);
        r.lda(r.rd(Z.randomHiSave)); r.wr(Z.randomHi, r.a);
        L = 'doSound'; continue;

      case 'checkCollisions':
        r.ldx(r.rd(Z.collidedEnemy));
        if (r.n) { L = 'endCollisions'; continue; }
        r.lda(r.rd(Z.Shape1IdLst + r.x));
        r.cmp(r.a, GAME.ID_PLANE);
        if (!r.c) { L = 'endCollisions'; continue; }
        r.cmp(r.a, GAME.ID_BRIDGE);
        if (!r.c) { L = 'noBridge'; continue; }
        if (!r.z) { L = 'refuel'; continue; }
        r.inc(Z.sectionEnd);
      // falls through
      case 'noBridge':
        looseJet(mem, 1, 0x1f);
        r.ldx(r.rd(Z.collidedEnemy));
        r.lda(GAME.ID_EXPLOSION2);
        L = 'contJetExplosion'; continue;
      case 'refuel':
        r.lda(r.rd(Z.fuelHi));
        r.adc(0x01);
        r.ldx(4);
        if (r.c) { r.lda(0xff); r.wr(Z.fuelLo, r.a); r.ldx(3); }
        r.wr(Z.fuelHi, r.a); // .notFull
        r.cmp(r.x, r.rd(Z.sound0Id));
        if (r.z) { L = 'endCollisions'; continue; }
        r.wr(Z.sound0Id, r.x);
        r.lda(0x08); r.wr(Z.sound0Cnt, r.a);
      // falls through
      case 'endCollisions':
        r.ldx(r.rd(Z.PFCrashFlag));
        if (r.n) { L = 'skipCrash'; continue; }
      // falls through
      case 'maxedOut':
        looseJet(mem, 1, 0x1f);
        L = 'doSound'; continue;
      case 'skipCrash':
        // decrease fuel
        r.lda(r.rd(Z.fuelLo)); r.c = 1; r.sbc(0x20);
        if (r.c) { L = 'skipDecHi'; continue; }
        r.ldy(r.rd(Z.fuelHi));
        if (r.z) { looseJet(mem, 2, 0x23); L = 'doSound'; continue; } // out of fuel
        r.dec(Z.fuelHi); // .fuelOk
      // falls through
      case 'skipDecHi':
        r.wr(Z.fuelLo, r.a);
        // *** move jet left or right ***
        r.lda(r.rd(Z.joystick)); r.tay();
        r.and(0x0c); r.eor(0x0c);
        if (!r.z) { L = 'leftRight'; continue; }
        r.wr(Z.dXSpeed, r.a); r.wr(Z.speedX, r.a);
        r.ldx(LOW.JetStraight - 1);
        L = 'setPtr0'; continue;
      case 'leftRight':
        r.lda(r.rd(Z.dXSpeed)); r.c = 0; r.adc(8);
        if (!r.c) r.wr(Z.dXSpeed, r.a);
        r.ldx(LOW.JetMove - 1); // .maxChange
        r.tya(); r.and(0x08);
        r.wr(Z.reflect0, r.a);
        if (r.z) { L = 'moveRight'; continue; }
        if (r.c) { L = 'maxChange2'; continue; }
        r.lda(r.rd(Z.speedX)); r.c = 1; r.sbc(r.rd(Z.dXSpeed));
        if (r.c) { L = 'setXSpeed'; continue; }
      // falls through
      case 'maxChange2':
        r.dec(Z.playerX);
        if (!r.z) { L = 'setXSpeed'; continue; }
      // falls through
      case 'moveRight':
        if (r.c) { L = 'maxChange3'; continue; }
        r.lda(r.rd(Z.speedX));
        r.bit(r.rd(Z.joystick));
        if (r.n) r.lda(0xff);
        r.adc(r.rd(Z.dXSpeed)); // .wasRight
        if (!r.c) { L = 'setXSpeed'; continue; }
      // falls through
      case 'maxChange3':
        r.inc(Z.playerX);
      // falls through
      case 'setXSpeed':
        r.wr(Z.speedX, r.a);
      // falls through
      case 'setPtr0':
        r.wr(Z.shapePtr0, r.x);
        // change jet speed
        r.ldx(r.rd(Z.speedY));
        r.tya(); r.lsr();
        if (r.c) { L = 'noMoveUp'; continue; }
      // falls through
      case 'incSpeed':
        r.txa(); r.adc(2);
        if (!r.c) { L = 'changeSpeed'; continue; }
        L = 'skipChange'; continue;
      case 'noMoveUp':
        r.lsr();
        if (!r.c) { L = 'noMoveDown'; continue; }
        r.txa(); r.asl();
        if (!r.c) { L = 'incSpeed'; continue; }
        if (r.z) { L = 'skipChange'; continue; }
      // falls through
      case 'noMoveDown':
        r.txa();
        r.cmp(r.a, 0x41);
        if (!r.c) { L = 'skipChange'; continue; }
        r.sbc(2);
      // falls through
      case 'changeSpeed':
        r.wr(Z.speedY, r.a);
      // falls through
      case 'skipChange':
        r.ldx(r.rd(Z.hitEnemyIdx));
        if (r.n) { L = 'skipCollisions'; continue; }
        r.ldy(r.rd(Z.Shape1IdLst + r.x));
        r.cmp(r.y, GAME.ID_PLANE);
        if (!r.c) { L = 'skipCollisions'; continue; }
        r.lda(GAME.ID_EXPLOSION1);
      // falls through
      case 'contJetExplosion':
        r.ldy(r.rd(Z.Shape1IdLst + r.x));
        r.wr(Z.Shape1IdLst + r.x, r.a);
        r.lda(23); r.wr(Z.bridgeSound, r.a);
        r.cmp(r.y, GAME.ID_BRIDGE);
        if (r.z) {
          r.wr(Z.bridgeExplode, r.a);
          r.lda(0xe0 | 0b001); r.wr(Z.State1Lst + r.x, r.a); // fixed position, two copies close
          r.lda(4); r.wr(Z.XPos1Lst + r.x, r.a);
          r.inc(Z.sectionEnd);
        }
        // increase score
        r.ldx(8);
        r.lda(SCORE_TAB[r.y]);
        if (!r.n) { L = 'loopSetPtr1'; continue; }
        r.and(0x7f);
        r.ldx(r.rd(Z.scorePtr1 + 8));
        r.cmp(r.x, LOW.Space);
        if (r.z) { r.ldx(LOW.Zero); r.wr(Z.scorePtr1 + 8, r.x); }
        r.ldx(6); // .noSpace
      // falls through
      case 'loopSetPtr1':
        stack.push(r.a);
        r.cmp(r.x, 2);
        if (!r.z) { L = 'notLivePtr'; continue; }
        // bonus life
        r.lda(r.rd(Z.livesPtr));
        r.cmp(r.a, LOW.Nine);
        if (r.z) { L = 'notLivePtr'; continue; }
        if (r.c) r.lda(0xff);
        r.adc(GAME.DIGIT_H); // .notMax
        r.wr(Z.livesPtr, r.a);
      // falls through
      case 'notLivePtr':
        r.lda(r.rd(Z.scorePtr1 + r.x)); r.c = 1; r.sbc(LOW.Space);
        if (r.z) r.wr(Z.scorePtr1 + r.x, r.a);
        r.lda(stack.pop()); // .noSpace2
        r.c = 0; r.adc(r.rd(Z.scorePtr1 + r.x));
        r.cmp(r.a, LOW.MaxOut);
        if (!r.c) { L = 'noMaxOut'; continue; }
        r.sbc(LOW.MaxOut);
        r.wr(Z.scorePtr1 + r.x, r.a);
        r.lda(GAME.DIGIT_H);
        r.dex(); r.dex();
        if (!r.n) { L = 'loopSetPtr1'; continue; }
        // more than 999990 points: !!!!!!, game over
        setScorePtr1(mem, LOW.MaxOut, 10);
        r.lda(LOW.Copyright0); r.wr(Z.livesPtr, r.a);
        L = 'maxedOut'; continue;
      case 'noMaxOut':
        r.wr(Z.scorePtr1 + r.x, r.a);
      // falls through
      case 'noMissile':
        r.ldx(0xb4); // disable missile
        L = 'directMissile'; continue;
      case 'skipCollisions':
        // *** move or fire missiles ***
        r.lda(r.rd(Z.missileFlag));
        if (!r.n) { L = 'noMissile'; continue; }
        r.lda(r.rd(Z.missileY));
        r.cmp(r.a, GAME.MAX_MISSILE + 1);
        if (r.c) { L = 'checkFire'; continue; }
        r.adc(GAME.MISSILE_SPEED);
        r.tax();
        r.lda(io.swchb);
        r.ldy(r.rd(Z.player));
        if (r.z) r.asl();
        r.tay(); // .player1a
        if (!r.n) { L = 'guidedMissile'; continue; }
        L = 'directMissile'; continue;
      case 'checkFire':
        r.ldx(r.rd(Z.player));
        r.lda(r.x ? io.inpt5 : io.inpt4);
        if (r.n) { L = 'noMissile'; continue; }
        r.ldx(0x0f); r.wr(Z.missileSound, r.x);
        r.ldx(GAME.MIN_MISSILE);
      // falls through
      case 'guidedMissile':
        r.lda(r.rd(Z.playerX)); r.c = 0; r.adc(5);
        r.wr(Z.missileX, r.a);
      // falls through
      case 'directMissile':
        r.wr(Z.missileY, r.x);
      // falls through
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
