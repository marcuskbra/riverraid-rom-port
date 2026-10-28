// River Raid frame logic, following the ROM routine by routine (Jentzsch
// disassembly): MainLoop up to the kernel, the end of the status display and
// the main loop from .noCrash2 ($F489) to .mainLoopJmp, including Reset,
// GameInit, LooseJet, SwapPlayers and the sound routine. The kernel's
// collision checks are modelled in river-raid.js. Upstream
// (Plicerin/riverraid-rom-port) verified its 6502-style port against the ROM
// on a 6502 core; this plain JS version was checked frame for frame against
// upstream's port.
//
// io: { swcha, swchb, inpt4, inpt5 } inputs; the port writes io.colubk,
// io.colup0 and io.audio = { c0, f0, v0, c1, f1, v1 } (TIA values).

import {
  ZP as RIVER_ZP, MEMORY_SIZE, NUM_BLOCKS, KERNEL_LINES, saveSection, newBlock, runSetBlockVars,
  kernelPlayfieldLines, kernelObjectLines, kernelLineMasks, collisionTimes, applyKernelCollisions,
} from './river-raid.js';
import { INIT_TAB, COLOR_TAB, ANIMATE_ID_TAB, SCORE_TAB, VOLUME_TAB, JET_PAGE_TAIL, PF_PAGE_FC } from './data/playfield.js';
import { KERNEL_SHAPE_BYTES } from './data/kernel-sprites.js';
import { statusLines } from './status.js';

export { MEMORY_SIZE };

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
  DIGIT_H: 8, INTRO_SCROLL: 48, NUM_LINES: KERNEL_LINES, MAX_LEVEL: 48, MIN_MISSILE: 13, MAX_MISSILE: KERNEL_LINES + 1, MISSILE_SPEED: 6,
  MISSILE_OFF: KERNEL_LINES + 20, // past the river's top ($B4 on the cartridge)
  ID_PLANE: 4, ID_SHIP: 7, ID_BRIDGE: 8, ID_EXPLOSION1: 1, ID_EXPLOSION2: 2, DARK_RED: 0x42,
  ENEMY_MOVE: 0x40, PF_COLLIDE: 0x20, PATROL: 0x10, PF_ROAD: 0x80, PF_COLOR: 0x04, DIRECTION: 0x08,
});
const END = (list) => list + NUM_BLOCKS - 1;

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

// GameInit ($FA8F): count = number of InitTab bytes (23 for a new jet, 39 at
// reset). InitTab starts with 6 PF1Lst and 6 PF2Lst bytes, all the straight
// river; the rest goes from missileY on. InitTab's missileY ($B4) would put a
// missile in the taller river, so it becomes MISSILE_OFF.
function gameInit(mem, count) {
  mem.fill(INIT_TAB[0], Z.PF1Lst, Z.PF1Lst + NUM_BLOCKS);
  mem.fill(INIT_TAB[6], Z.PF2Lst, Z.PF2Lst + NUM_BLOCKS);
  mem.set(INIT_TAB.slice(12, count), Z.missileY);
  mem[Z.missileY] = GAME.MISSILE_OFF;
  mem.fill(0, Z.dXSpeed, Z.bridgeExplode + 1);
  for (const list of [Z.XPos1Lst, Z.State1Lst, Z.Shape1IdLst]) mem.fill(0, list, list + NUM_BLOCKS);
  mem.fill(mem[Z.level] & 1 ? 1 | GAME.PF_COLOR : 1, Z.blockLst, Z.blockLst + NUM_BLOCKS); // PF1_PAGE_FLAG
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
  mem[Z.missileY] = GAME.MISSILE_OFF;
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
  mem.fill(0, Math.max(x, 0x80), MEMORY_SIZE);
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
    if (fine >= 15) { fine -= 15; coarse += 1; }
    if (coarse >= 10 && fine >= 10) { coarse = 0; fine = 0; } // wrap to the left edge
  }
  mem[Z.XPos1Lst + i] = coarse;
  mem[Z.State1Lst + i] = ((fine ^ 7) << 4) | (state & 0x0f);
}

// Animates the enemies and moves them (from level 2 on, while the game runs).
function moveEnemies(mem) {
  const frame = mem[Z.frameCnt];
  // every 16 frames the enemy of one of the bottom 5 blocks starts moving
  if ((frame & 0x0f) === 0) {
    const i = mem[Z.random] & 0x07;
    mem[Z.blockLst + (i >= 5 ? i - 5 : i)] |= GAME.ENEMY_MOVE;
  }
  const moving = mem[Z.gameMode] === 0 && mem[Z.level] >= 2;
  for (let i = NUM_BLOCKS - 1; i >= 0; i -= 1) {
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

// A new jet: the river restarts at the last saved section. The blocks above
// the cartridge's 6 come in at once, so the intro scrolls the road to block 1
// with the cartridge's river behind it.
function initPlayer(mem) {
  gameInit(mem, 23); // PF1Lst..shapePtr0+1
  mem[END(Z.blockLst)] |= GAME.PF_ROAD;
  mem[Z.randomLo] = mem[Z.randomLoSave];
  mem[Z.randomHi] = mem[Z.randomHiSave];
  for (let i = 6; i < NUM_BLOCKS; i += 1) newBlock(mem);
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
  } else if ((down || speed > 0x80) && speed > 0x40) mem[Z.speedY] = speed - 2;
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
  if (addScore(mem, id)) mem[Z.missileY] = GAME.MISSILE_OFF;
  else looseJet(mem, 1, 0x1f);
}

// Moves the missile, or fires a new one. The jet's difficulty switch set to
// B makes the missile follow the jet.
function moveMissile(mem, io) {
  const player = mem[Z.player];
  let y = GAME.MISSILE_OFF, aim = false;
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

// Channel 0: the crash and refuel sounds, the low fuel alarm or the engine.
function sound0(mem, audio) {
  const id = mem[Z.sound0Id], count = mem[Z.sound0Cnt];
  if (id) {
    if (id <= 2) { // explosion (1) or out of fuel (2): fading white noise
      audio.c0 = 0x08; audio.f0 = id === 1 ? 0x1c : 0x08; audio.v0 = count >> 1;
    } else { // full tank (3) or refuelling (4): high pure tone
      audio.c0 = 0x04; audio.f0 = id === 3 ? 0x0f : 0x1f; audio.v0 = count;
    }
    mem[Z.sound0Cnt] = count - 1;
    if (count === 1) mem[Z.sound0Id] = 0;
    return;
  }
  if (mem[Z.gameMode]) { audio.v0 = 0; return; }
  const fuel = mem[Z.fuelHi];
  if (fuel < 0x40) {
    // low fuel alarm: a beep every 63 frames, continuous when the tank is nearly empty
    const cycle = (count || 0x3f) - 1;
    mem[Z.sound0Cnt] = cycle;
    if (fuel < 0x04 || cycle >= 0x1c) {
      audio.c0 = 0x0c;
      audio.f0 = fuel < 0x04 ? 0x1f - ((fuel << 2) | (mem[Z.fuelLo] >> 6)) : cycle >> 1;
      audio.v0 = 0x0f;
      return;
    }
  }
  // the engine: higher with speed, louder while speeding up
  audio.c0 = 0x08;
  audio.f0 = 0x1f - (mem[Z.speedY] >> 4);
  audio.v0 = VOLUME_TAB[mem[Z.joystick] & 0x03];
}

// Channel 1: an explosion (bridgeSound counts down for any enemy) or the missile.
function sound1(mem, audio) {
  const missile = mem[Z.missileSound], explosion = mem[Z.bridgeSound];
  if (missile) mem[Z.missileSound] = missile - 1;
  if (explosion) {
    mem[Z.bridgeSound] = explosion - 1;
    audio.f1 = mem[Z.random] | 0x18; audio.c1 = 0x08; audio.v1 = (explosion >> 1) + 4;
  } else if (missile) {
    audio.f1 = (0x1c - missile) & 0xff; audio.c1 = 0x0c; audio.v1 = 0x08;
  } else audio.v1 = 0;
}

// RESET and SELECT, then the river scrolls on. The switches are read after
// VSYNC: io.swchbNext when they changed at the frame edge.
function checkSwitches(mem, io) {
  const switches = io.swchbNext ?? io.swchb;
  if (!(switches & 0x01)) { // RESET
    mem[Z.player] = mem[Z.gameVariation];
    romReset(mem, 0xf7);
    return { reset: true };
  }
  if (switches & 0x02) mem[Z.gameDelay] = 0x82; // VSYNC leaves y = $82
  else {
    // SELECT steps the variation at once, then every 31 frames while held
    mem[Z.gameDelay] -= 1;
    if (mem[Z.gameDelay] & 0x80) {
      const variation = mem[Z.gameVariation] ^ 0x01;
      mem[Z.gameVariation] = variation;
      mem[Z.SS_Delay] = variation;
      mem[Z.player] = variation;
      setScorePtrs(mem, (variation << 3) + GAME.DIGIT_H);
      finishGame(mem);
      mem[Z.gameDelay] = 0x1e;
    }
  }
  const mode = mem[Z.gameMode];
  if (mode === GAME.INTRO_SCROLL) mem[Z.shapePtr0] = LOW.JetStraight - 1;
  else if (!(mode & 0x80)) runSetBlockVars(mem);
  return {};
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
  if (updateGameMode(mem)) play(mem, io);
  const audio = {};
  io.audio = audio;
  sound0(mem, audio);
  sound1(mem, audio);
  return checkSwitches(mem, io);
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
