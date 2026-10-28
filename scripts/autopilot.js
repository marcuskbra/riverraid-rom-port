// A bot's stick for one frame of a pilot's game (src/match/pilot.js), for
// scripts/bots.js. It looks at what the kernel drew (banks per line, and the
// objects: enemies, bridges and fuel depots) and tries stick plans: straight,
// or left or right for some frames, each while slowing down, cruising or
// speeding up, with the game's own sideways acceleration and speed steps. It
// keeps the plan that flies longest without touching a bank or an enemy.
// Enemies move on at the sideways speed of their last frame, and an enemy
// that crosses the missile's column far enough ahead counts as shot. When
// fuel runs low it heads for fuel depots and stops shooting them.
//
// Each bot gets its own taste (`state.style`): how often it speeds up when
// nothing is in the way, and which side it takes when two are as good, so
// bots on the same river don't fly as one.

import { Z } from '../src/game/frame.js';
import { KERNEL_LINES } from '../src/game/river-raid.js';

const PLAYING = 0, READY = 48;
const HORIZON = 100; // frames looked ahead
const TURNS = [[0, 0], ...[4, 8, 16, 32, 64, HORIZON].flatMap((n) => [[-1, n], [1, n]])]; // [direction, frames held]
const SLOW = -1, CRUISE = 0, FAST = 1;
const ID_PLANE = 4, ID_FUEL = 10; // 4..8 (planes to bridges) kill the jet; 9 and 10 refuel it
const ENEMY_MARGIN = 3, BANK_MARGIN = 1; // pixels kept clear on each side
const FUEL_LOW = 0xc0; // fuelHi below this: go for fuel
const FUEL_CRITICAL = 0x60; // and below this, shoot nothing while a depot is on screen
const TRAIL = 8; // frames an object's sideways speed is averaged over
const ACCELERATION = 8 / 256, TOP_SPEED = 0xf8 / 256; // pixels a frame, as moveJetX
const SPEED_MIN = 0x40, SPEED_CRUISE = 0x80, SPEED_MAX = 0xfe, LINE_SPEED = 0x80; // speedY, as changeSpeed; 0x80 is a line a frame
const CLEARANCE = 20; // pixels looked at on each side for the middle of the water
const SHOT_LINES = 24; // an enemy at least this far ahead in the missile's column is shot

// state: kept by the caller between frames ({} to start)
export function autopilot(pilot, state) {
  const mem = pilot.memory, display = pilot.display;
  state.style ??= { fast: Math.random() * 0.6, side: Math.random() < 0.5 ? -1 : 1 };
  // the picture is from before the last frame's logic, which may have moved the jet
  const moved = state.x === undefined ? 0 : mem[Z.playerX] - state.x;
  state.x = mem[Z.playerX];
  const mode = mem[Z.gameMode];
  if (mode === READY) return { fire: true };
  if (!display || mode !== PLAYING) { state.direction = 0; state.objects = []; return {}; }

  const jet = findJet(display);
  if (!jet) return { fire: true };
  // the river moves on by the last frame's speed before the next picture
  const lag = Math.round(state.speedY === undefined ? 0 : state.speedY / LINE_SPEED);
  state.speedY = mem[Z.speedY];
  const topLine = Math.max(0, jet.top - Math.ceil((SPEED_MAX / LINE_SPEED) * HORIZON) - lag - 1);
  const banks = bankMap(display, topLine, jet.bottom);
  const objects = trackObjects(findObjects(mem, display), state.objects ?? []);
  state.objects = objects;
  const fuelLow = mem[Z.fuelHi] < FUEL_LOW;
  // in clear water, now and then the bot speeds up
  if (state.dash === undefined || state.dashFor-- <= 0) {
    state.dash = Math.random() < state.style.fast;
    state.dashFor = 60 + Math.floor(Math.random() * 120);
  }

  let best = null;
  for (const speed of [CRUISE, FAST, SLOW]) {
    for (const [direction, frames] of TURNS) {
      const startSpeed = state.direction === direction ? mem[Z.dXSpeed] / 256 : 0;
      const plan = fly({ direction, frames, startSpeed, speed }, jet, moved, lag, mem[Z.speedY], banks, objects);
      if (!best || better(plan, best, fuelLow, state)) best = plan;
    }
  }
  state.direction = best.direction;
  const center = (jet.left + jet.right) >> 1;
  const depots = objects.filter((o) => o.id === ID_FUEL && o.bottom < jet.top);
  const fuelAhead = mem[Z.fuelHi] < FUEL_CRITICAL ? depots.length > 0
    : fuelLow && depots.some((o) => o.left - 4 <= center && o.right + 4 >= center);
  return { left: best.direction < 0, right: best.direction > 0, up: best.speed === FAST, down: best.speed === SLOW, fire: !fuelAhead };
}

// the jet's box on screen, from its pixels in the bottom lines
function findJet(display) {
  let top = -1, bottom = -1, left = 160, right = -1;
  for (let s = KERNEL_LINES - 24; s < KERNEL_LINES; s += 1) {
    const p0 = display.masks[s].p0;
    for (let x = 0; x < 160; x += 1) {
      if (!p0[x]) continue;
      if (top < 0) top = s;
      bottom = s;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  return top < 0 ? null : { top, bottom, left, right };
}

// per line from `from` to `to`: prefix counts of bank pixels, widened by BANK_MARGIN
function bankMap(display, from, to) {
  const banks = [];
  for (let s = from; s <= to; s += 1) {
    const pf = display.masks[s].pf, wall = new Uint8Array(160);
    for (let x = 0; x < 160; x += 1) {
      if (pf[x]) for (let m = Math.max(0, x - BANK_MARGIN); m <= Math.min(159, x + BANK_MARGIN); m += 1) wall[m] = 1;
    }
    const sums = new Int16Array(161);
    for (let x = 0; x < 160; x += 1) sums[x + 1] = sums[x] + wall[x];
    banks[s] = sums;
  }
  return banks;
}

const count = (sums, x0, x1) => sums[Math.min(160, Math.max(0, x1 + 1))] - sums[Math.min(160, Math.max(0, x0))];

// the enemies, bridges and fuel depots on screen: { id, top, bottom, left, right }
function findObjects(mem, display) {
  const byBlock = new Map();
  for (let s = 0; s < KERNEL_LINES; s += 1) {
    const block = display.objs[s].block;
    if (block < 0) continue;
    const id = mem[Z.Shape1IdLst + block];
    if (id < ID_PLANE || id === ID_FUEL - 1) continue; // nothing, explosions, houses
    const p1 = display.masks[s].p1;
    for (let x = 0; x < 160; x += 1) {
      if (!p1[x]) continue;
      if (!byBlock.has(block)) byBlock.set(block, { id, top: s, bottom: s, left: x, right: x });
      const o = byBlock.get(block);
      o.bottom = s;
      if (x < o.left) o.left = x;
      if (x > o.right) o.right = x;
    }
  }
  return [...byBlock.values()];
}

// each object's sideways speed, over its last TRAIL frames: the same object
// a frame ago has the same id, sits a few lines higher up and near the same x
function trackObjects(objects, before) {
  for (const o of objects) {
    const was = before.find((b) => b.id === o.id && o.top - b.top >= -1 && o.top - b.top <= 4 && Math.abs(b.left - o.left) <= 4);
    o.trail = [...(was?.trail ?? []), o.left].slice(-TRAIL);
    o.dx = o.trail.length > 1 ? Math.max(-3, Math.min(3, (o.left - o.trail[0]) / (o.trail.length - 1))) : 0;
  }
  return objects;
}

// Flies a plan against the picture: frame k draws the river as far down as
// the speeds of frames 0 to k - 1 took it, the enemies `dx * k` pixels on,
// and the jet where the stick took it in frames 1 to k - 1. Returns how many
// frames it survives, the fuel depots it flies over, the enemies it shoots
// and the water beside it at the end.
function fly(plan, jet, moved, lag, speedY, banks, objects) {
  const { direction, frames, speed } = plan;
  let x = moved, sideways = direction ? plan.startSpeed : 0, k = 1, scrolled = lag, s = speedY;
  const fuelTouched = new Set(), shot = new Set();
  for (; k <= HORIZON; k += 1) {
    if (k > 1) {
      if (direction && k - 1 <= frames) {
        sideways = Math.min(TOP_SPEED, sideways + ACCELERATION);
        x += direction * sideways;
      }
      if (speed === FAST || (speed === CRUISE && s < SPEED_CRUISE)) s = Math.min(SPEED_MAX, s + 2);
      else if ((speed === SLOW || s > SPEED_CRUISE) && s > SPEED_MIN) s -= 2;
    }
    scrolled += s / LINE_SPEED;
    const shift = Math.round(scrolled), dx = Math.round(x);
    const left = jet.left + dx, right = jet.right + dx;
    if (left < 8 || right > 159) break;
    if (jet.top - shift < 0) { k = HORIZON + 1; break; } // past the top of the screen
    let hit = false;
    for (let line = Math.max(0, jet.top - shift); line <= jet.bottom - shift && !hit; line += 1) {
      if (banks[line] && count(banks[line], left, right)) hit = true;
    }
    const center = (left + right) >> 1;
    for (const o of objects) {
      if (hit || shot.has(o)) continue;
      const moveX = o.id === ID_FUEL ? 0 : Math.round(o.dx * k);
      if (o.id !== ID_FUEL && o.bottom + shift < jet.top - SHOT_LINES) {
        if (o.left + moveX <= center && o.right + moveX >= center) shot.add(o); // the missile gets it
        continue;
      }
      if (o.bottom + shift < jet.top || o.top + shift > jet.bottom) continue;
      if (o.id === ID_FUEL) {
        if (o.left <= right && o.right >= left) fuelTouched.add(o);
        continue;
      }
      if (o.left + moveX - ENEMY_MARGIN <= right && o.right + moveX + ENEMY_MARGIN >= left) hit = true;
    }
    if (hit) break;
  }
  const survived = Math.min(HORIZON, k - 1);
  const line = Math.max(0, jet.top - Math.round(scrolled));
  const dx = Math.round(x);
  return {
    direction, speed, frames: survived, fuel: fuelTouched.size, shots: shot.size,
    clearance: banks[line] ? clearance(banks[line], jet.left + dx, jet.right + dx) : 0,
  };
}

// free pixels on the narrower side of the jet, up to CLEARANCE
function clearance(sums, left, right) {
  let l = 0, r = 0;
  while (l < CLEARANCE && left - l - 1 >= 0 && !count(sums, left - l - 1, left - l - 1)) l += 1;
  while (r < CLEARANCE && right + r + 1 <= 159 && !count(sums, right + r + 1, right + r + 1)) r += 1;
  return Math.min(l, r);
}

// survive longest; then fuel when low, shots, the speed it wants, the middle
// of the water, the stick it holds and its side
function better(a, b, fuelLow, state) {
  if (a.frames !== b.frames) return a.frames > b.frames;
  if (fuelLow && a.fuel !== b.fuel) return a.fuel > b.fuel;
  if (a.shots !== b.shots) return a.shots > b.shots;
  const wanted = state.dash ? FAST : CRUISE;
  if ((a.speed === wanted) !== (b.speed === wanted)) return a.speed === wanted;
  if (a.clearance !== b.clearance) return a.clearance > b.clearance;
  if ((a.direction === state.direction) !== (b.direction === state.direction)) return a.direction === state.direction;
  return a.direction === state.style.side;
}
