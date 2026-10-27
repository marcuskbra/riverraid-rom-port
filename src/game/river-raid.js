// River Raid river: block generation and playfield, ported from the ROM.
//
// The block generator follows the ROM routine by routine: the main loop from
// .setBlockVars to .mainLoopJmp (Jentzsch lines 1846-2244, $F85D-$F85A) and
// the subroutines it calls. It runs on the 256-byte zero page image, where
// each variable lives at its ROM address. Upstream checked its 6502-style
// port against the real routine on a 6502 core; this plain JS version was
// checked frame for frame against upstream's port.

import {
  PF_PAGE_FC, PF_PAGE_FD, BANK_PTR_TAB, PAGE_FLAG_TAB, SHAPE_POS_TAB, ENEMY_ID_TAB, ROAD_COLOR_TAB, INIT_TAB,
} from './data/playfield.js';

// zero page addresses (Jentzsch lines 168-275)
export const ZP = Object.freeze({
  dXSpeed: 0x87, prevPF1PatId: 0x88, PF_State: 0x89, sectionEnd: 0x8a, blockOffset: 0x8b, posYLo: 0x8c,
  bridgeExplode: 0x8d, blockLst: 0x8e, XPos1Lst: 0x94, State1Lst: 0x9a, Shape1IdLst: 0xa0, PF1Lst: 0xa6,
  PF2Lst: 0xac, missileY: 0xb2, playerX: 0xb3, speedX: 0xb4, speedY: 0xb5, blockPart: 0xb6, fuelHi: 0xb7,
  fuelLo: 0xb8, sectionBlock: 0xb9, PF1PatId: 0xbc, level: 0xbd, randomLoSave: 0xbe, randomHiSave: 0xbf,
  randomLo: 0xe9, randomHi: 0xea, randomLoSave2: 0xeb, randomHiSave2: 0xec,
  reflect0: 0xe0, hitEnemyIdx: 0xe2, PFCrashFlag: 0xe4, missileFlag: 0xe6, collidedEnemy: 0xe8, missileX: 0xf5,
});

const NUM_BLOCKS = 6;
const BLOCK_SIZE = 32;
const SECTION_BLOCKS = 16;

const BLOCK_FLAGS = Object.freeze({
  PF1_PAGE: 0x01, PF2_PAGE: 0x02, PF_COLOR: 0x04, PATROL: 0x10, PF_COLLIDE: 0x20, ENEMY_MOVE: 0x40, PF_ROAD: 0x80,
});
const ISLAND_FLAG = 0x80, ISLAND_NEXT = 0x40;
const SWITCH_PAGE_ID = 9;
const ID_HOUSE = 9, ID_FUEL = 10, ID_SHIP = 7, ID_BRIDGE = 8;
const DOUBLE_SIZE = 0b101, QUAD_SIZE = 0b111, DIRECTION_FLAG = 0x08;

const END = (list) => list + NUM_BLOCKS - 1;

// NextRandom16 ($FAC6): 16-bit LFSR, shifting in bit 4 XOR bit 7 of randomHi
function nextRandom16(mem) {
  const hi = mem[ZP.randomHi], lo = mem[ZP.randomLo];
  mem[ZP.randomLo] = (lo << 1) | (((hi >> 4) ^ (hi >> 7)) & 1);
  mem[ZP.randomHi] = (hi << 1) | (lo >> 7);
}

// SaveSection ($FAD3): next level (after 48 it alternates between 47 and 48),
// and save the random state for restarting the section
export function saveSection(mem) {
  mem[ZP.level] = mem[ZP.level] >= 48 ? 47 : mem[ZP.level] + 1;
  mem[ZP.randomLoSave2] = mem[ZP.randomLoSave];
  mem[ZP.randomHiSave2] = mem[ZP.randomHiSave];
  mem[ZP.randomLoSave] = mem[ZP.randomLo];
  mem[ZP.randomHiSave] = mem[ZP.randomHi];
}

// CalcPosX ($FDD8): x-position -> coarse (15-pixel steps) and fine (HMxy) values
function calcPosX(x) {
  const p = (x + 1) & 0xff;
  let coarse = p >> 4, fine = coarse + (p & 0x0f);
  if (fine >= 15) { fine -= 15; coarse += 1; }
  return { coarse, fine: ((fine ^ 7) << 4) & 0xff };
}

// .setBlockVars .. .mainLoopJmp ($F85D-$F85A): scroll by speedY in two steps
// (every step at speedY >= $FE) and create a new block whenever the river has
// scrolled one block.
export function runSetBlockVars(mem) {
  for (let step = 0; step < 2; step += 1) {
    const speed = mem[ZP.speedY];
    if (speed < 0xfe) {
      const sum = mem[ZP.posYLo] + speed;
      mem[ZP.posYLo] = sum;
      if (sum <= 0xff) continue;
    }
    mem[ZP.blockOffset] += 1;
    if (mem[ZP.blockOffset] >= BLOCK_SIZE) newBlock(mem);
  }
}

// Shifts the block lists down by one and fills in the new top block (END).
// Each PF1 pattern id lasts two blocks (blockPart 2, 1).
function newBlock(mem) {
  mem[ZP.blockOffset] = 0;
  const valleyWidth = mem[ZP.level] < 5 ? 6 : 0;
  for (let list = ZP.blockLst; list <= ZP.PF2Lst; list += NUM_BLOCKS) mem.copyWithin(list, list + 1, list + NUM_BLOCKS);
  mem[END(ZP.State1Lst)] = 0;
  mem[END(ZP.blockLst)] &= BLOCK_FLAGS.PF_COLOR;
  mem[ZP.prevPF1PatId] = mem[ZP.PF1PatId];
  mem[ZP.blockPart] -= 1;
  if (mem[ZP.blockPart] === 0) {
    mem[ZP.PF1PatId] = nextPatternId(mem, valleyWidth);
    mem[ZP.blockPart] = 2;
  } else {
    if (mem[ZP.sectionBlock] === 1) {
      // the last block of a section is a road with bridge
      mem[ZP.sectionEnd] = 0;
      mem[END(ZP.blockLst)] = BLOCK_FLAGS.PF_ROAD | (mem[ZP.level] & 1 ? 0 : BLOCK_FLAGS.PF_COLOR);
    }
    nextRandom16(mem);
  }
  setPlayfield(mem);
  newObject(mem, valleyWidth);
}

// .nextBlock: counts down the section and picks the next PF1 pattern id.
// PF_State bit 7: the blocks have an island, bit 6: the next ones have one too.
// An island starts and ends with pattern 0 (PF_State 0 -> $40 -> $C0 -> $80 -> 0).
function nextPatternId(mem, valleyWidth) {
  mem[ZP.sectionBlock] -= 1;
  if (mem[ZP.sectionBlock] === 0) {
    saveSection(mem);
    mem[ZP.sectionBlock] = SECTION_BLOCKS;
  }
  nextRandom16(mem);
  const blocksLeft = mem[ZP.sectionBlock];
  if (blocksLeft === 1) { mem[ZP.PF_State] = 0; return 12; } // the banks before the bridge
  if (mem[ZP.level] & 1) return 7; // straight river
  const state = mem[ZP.PF_State];
  const islandEdge = () => { mem[ZP.PF_State] = state & ISLAND_FLAG ? ISLAND_FLAG : ISLAND_NEXT; return 0; };
  if (blocksLeft === 2) {
    // finish an island before the end of the section
    if (state === (ISLAND_FLAG | ISLAND_NEXT)) return islandEdge();
    mem[ZP.PF_State] = 0;
  } else if (Boolean(state & ISLAND_FLAG) !== Boolean(state & ISLAND_NEXT)) {
    mem[ZP.PF_State] = state & ISLAND_NEXT ? ISLAND_FLAG | ISLAND_NEXT : 0;
  } else if ((mem[ZP.randomLo] & 0b00110000) === 0) {
    return islandEdge();
  }
  // random id 2..15, at most 14 (13 with an island, 8 in the first levels)
  let id = mem[ZP.randomLo] & 0x0f;
  if (id < 2) id += 2;
  return Math.min(id, valleyWidth ? 8 : mem[ZP.PF_State] & ISLAND_FLAG ? 13 : 14);
}

// .nextBlockPart .. .skipSwapPF: PF1/PF2 pattern pointers and page flags. The
// larger of the previous and the current id picks the pattern, offset by
// their difference. With an island, PF1 and PF2 swap.
function setPlayfield(mem) {
  const prev = mem[ZP.prevPF1PatId], cur = mem[ZP.PF1PatId];
  const high = Math.max(prev, cur), low = Math.min(prev, cur);
  const diff = prev === cur ? 0 : prev > cur ? prev - cur - 1 : prev - cur + 1;
  const pattern = (BANK_PTR_TAB[high] + diff) & 0xff;
  let pf1 = pattern, pf2 = 0;
  if (high >= SWITCH_PAGE_ID) {
    pf1 = low >= SWITCH_PAGE_ID - 1 ? 0x07 : cur > prev ? prev : 14 - cur;
    pf2 = pattern;
  }
  const page = high === 0 ? 0 : BLOCK_FLAGS.PF1_PAGE;
  const island = mem[ZP.PF_State] & ISLAND_FLAG;
  mem[END(ZP.blockLst)] |= island ? PAGE_FLAG_TAB[page] : page;
  mem[END(ZP.PF1Lst)] = island ? pf2 : pf1;
  mem[END(ZP.PF2Lst)] = island ? pf1 : pf2;
}

// .skipSwapPF .. .endNewShape: the new block's object. Objects sit against a
// bank (the island's edges count as banks); against a right-hand bank they
// are mirrored, except fuel depots.
function newObject(mem, valleyWidth) {
  const prev = mem[ZP.prevPF1PatId], cur = mem[ZP.PF1PatId], level = mem[ZP.level];
  const randomLo = mem[ZP.randomLo], randomHi = mem[ZP.randomHi];
  const island = (mem[ZP.PF_State] & ISLAND_FLAG) !== 0;
  const flip = (randomLo & 0x80) !== 0;
  if (mem[END(ZP.blockLst)] & BLOCK_FLAGS.PF_ROAD) {
    placeObject(mem, ID_BRIDGE, QUAD_SIZE, 63);
    return;
  }
  const enemy = ((63 - level) * 2 & 0xff) < randomHi;
  if (mem[ZP.sectionBlock] + mem[ZP.blockPart] >= SECTION_BLOCKS + 2 || (!enemy && randomLo & 0x40)) {
    // a house, always on the first block of a section
    const low = Math.min(prev, cur);
    let x;
    if (level & 1) {
      x = (randomLo & 0x1f) + 9; // straight river: either bank
      if (x >= 25) x += 93;
    } else x = island && low !== 0 ? 71 : SHAPE_POS_TAB[low];
    placeObject(mem, ID_HOUSE, DOUBLE_SIZE | (flip ? DIRECTION_FLAG : 0), x);
    return;
  }
  let id = enemy ? ENEMY_ID_TAB[randomHi & (level < 3 ? 0b001 : 0b111)] : ID_FUEL; // planes from level 3
  let size = id === ID_SHIP ? DOUBLE_SIZE : 0;
  let x, mirror = flip;
  if (cur === prev && level & 1) {
    // straight river: anywhere between the banks
    x = Math.min((randomLo & 0x3f) + 46 + valleyWidth, (size ? 97 : 106) - valleyWidth);
  } else {
    const maxId = Math.max(prev, cur);
    if (id === ID_SHIP && maxId > (island ? 10 : 13)) { id = ID_SHIP - 1; size = 0; } // too narrow: a helicopter
    const m = maxId * 4;
    const width = (id === ID_FUEL ? 9 : 10) + valleyWidth + (size ? 10 : 0);
    if (island && m !== 0) {
      x = flip ? 82 + m + valleyWidth : 80 - m - width; // right or left of the island
      mirror = !flip;
    } else {
      x = flip ? 144 - m - width : m + 18 + valleyWidth; // right or left bank
    }
  }
  placeObject(mem, id, size | (mirror && id !== ID_FUEL ? DIRECTION_FLAG : 0), x);
}

// .endNewShape
function placeObject(mem, id, state, x) {
  const { coarse, fine } = calcPosX(x);
  mem[END(ZP.Shape1IdLst)] = id;
  mem[END(ZP.XPos1Lst)] = coarse;
  mem[END(ZP.State1Lst)] = state | fine;
}

// *** kernel playfield ***
// The kernel draws each block as 8 setup lines plus a 2-line loop (Jentzsch
// lines 520-960). Playfield row r (15..0) of block i ends up on the two screen
// lines starting at top + (5 - i) * 32 + 33 - 2 * r, where top = blockOffset - 34
// is the screen line of the top block's first line; rows 15..13 and 0 come from
// the setup lines, rows 12..1 from the loop. COLUPF is the block's green, or for
// a road block RoadColorTab[row] on loop rows; it changes together with the
// playfield. Upstream's tools/verify-kernel-pf.mjs checked this per pixel against the ROM.
export const KERNEL_LINES = 160;
const PF_COLORS = Object.freeze({ GREEN: 0xd2, BLUE: 0x84, DARK_RED: 0x42 });

function pfPatternByte(pageFlag, low) {
  const page = pageFlag ? PF_PAGE_FD : PF_PAGE_FC;
  const value = page[low & 0xff];
  if (value === undefined) throw new Error(`PF read outside extracted pattern data: $F${pageFlag ? 'D' : 'C'}${(low & 0xff).toString(16)}`);
  return value;
}

function blockPlayfieldRow(mem, block, row) {
  const flags = mem[ZP.blockLst + block];
  const pf1 = pfPatternByte(flags & BLOCK_FLAGS.PF1_PAGE, mem[ZP.PF1Lst + block] + row);
  const pf2 = pfPatternByte(flags & BLOCK_FLAGS.PF2_PAGE, mem[ZP.PF2Lst + block] + row);
  const green = (flags & BLOCK_FLAGS.PF_COLOR) | PF_COLORS.GREEN;
  const colorRow = row === 0 ? 1 : row;
  const road = (flags & BLOCK_FLAGS.PF_ROAD) && colorRow <= 12;
  return { pf1, pf2, colupf: road ? ROAD_COLOR_TAB[colorRow] : green };
}

// 160 kernel lines, top to bottom: { block, row, pf1, pf2, colupf }
export function kernelPlayfieldLines(mem) {
  const top = mem[ZP.blockOffset] - 34;
  const lines = new Array(KERNEL_LINES);
  for (let block = NUM_BLOCKS - 1; block >= 0; block -= 1) {
    const blockTop = top + (NUM_BLOCKS - 1 - block) * BLOCK_SIZE;
    for (let row = 15; row >= 0; row -= 1) {
      const first = blockTop + 33 - 2 * row;
      for (const line of [first, first + 1]) {
        if (line < 0 || line >= KERNEL_LINES) continue;
        lines[line] = { block, row, ...blockPlayfieldRow(mem, block, row) };
      }
    }
  }
  return lines;
}

// Playfield bits for one line, 160 pixels: PF0 is always set, CTRLPF reflects.
function playfieldPixels(line) {
  const bits = new Uint8Array(160);
  for (let x = 0; x < 80; x += 1) {
    const pf = x >> 2;
    let on;
    if (pf < 4) on = 1;
    else if (pf < 12) on = (line.pf1 >> (7 - (pf - 4))) & 1;
    else on = (line.pf2 >> (pf - 12)) & 1;
    bits[x] = on;
    bits[159 - x] = on;
  }
  return bits;
}

// *** kernel objects ***
// Per kernel line: jet (GRP0) byte, enemy (GRP1, vertically delayed) byte and
// color, and the missile enable, following the kernel's line schedule:
// - jet: line s shows the jet table byte at index 160 - s (shapePtr0 = table-1, Y = 161 - s)
// - enemy: block line b = 32 - 2y shows B[y], b = 33 - 2y shows A[y] (y = 11..0),
//   colored colors[y]; position, NUSIZ1 and REFP1 switch at block line 5..7
// - missile: ENAM0 is only rewritten on odd block lines, from Y = 161 - s
// - kernel entry: line 0 gets no enemy graphics when blockOffset < 3 or >= 26
//   (.noShape), and ENAM0 stays off until its first rewrite below line 0
// Upstream's tools/verify-kernel-objects.mjs checked this against the ROM kernel.
const JET_Y = 19;

export function kernelObjectLines(mem, shapes, jetTable) {
  const top = mem[ZP.blockOffset] - 34;
  const missileY = mem[ZP.missileY];
  const lines = Array.from({ length: KERNEL_LINES }, () => ({ grp0: 0, grp1: 0, colup1: 0, block: -1, enam0: 0 }));
  for (let s = 0; s < KERNEL_LINES; s += 1) {
    const y = 161 - s;
    if (y < JET_Y && y >= 1) lines[s].grp0 = jetTable[y - 1] ?? 0;
  }
  for (let block = NUM_BLOCKS - 1; block >= 0; block -= 1) {
    const blockTop = top + (NUM_BLOCKS - 1 - block) * BLOCK_SIZE; // screen line of block line 1
    const shape = shapes[mem[ZP.Shape1IdLst + block]];
    for (let y = 11; y >= 0; y -= 1) {
      for (const [b, byte] of [[32 - 2 * y, shape.b[y]], [33 - 2 * y, shape.a[y]]]) {
        const s = blockTop + b - 1;
        if (s < 0 || s >= KERNEL_LINES) continue;
        lines[s].grp1 = byte;
        lines[s].colup1 = shape.colors[y];
        lines[s].block = block;
      }
    }
    // missile: odd block lines rewrite ENAM0, held for the following line
    for (let b = 1; b <= 32; b += 2) {
      const s = blockTop + b - 1;
      const yLine = 161 - s;
      const inJetZone = yLine < JET_Y && b !== 7 && b !== 9;
      const on = !inJetZone && ((yLine - missileY) & 0xf8) === 0 ? 1 : 0;
      if (s < 1) continue;
      for (const t of [s, s + 1]) if (t < KERNEL_LINES) lines[t].enam0 = on;
    }
  }
  const blockOffset = mem[ZP.blockOffset];
  if (blockOffset < 3 || blockOffset >= 26) lines[0].grp1 = 0;
  return lines;
}

// *** TIA object geometry ***
// x-position from the coarse/fine values CalcPosX produced (its exact inverse).
function objectX(coarse, state) {
  return 15 * coarse + ((((state >> 4) & 0x0f) ^ 7) & 0x0f) - 1;
}

// NUSIZ player copies (color-clock offsets) and pixel width per bit.
const NUSIZ_COPIES = [[0], [0, 16], [0, 32], [0, 16, 32], [0, 64], [0], [0, 32, 64], [0]];
const NUSIZ_SCALE = [1, 1, 1, 1, 1, 2, 1, 4];

// Pixels (0..159) covered by a player byte. Stretched players start one clock
// later (Stella shows the double-size ship/house one pixel right of x).
function playerPixels(byte, x, nusiz = 0, reflect = false) {
  const out = [];
  if (!byte) return out;
  const scale = NUSIZ_SCALE[nusiz & 7];
  const start = x + (scale > 1 ? 1 : 0);
  for (const copy of NUSIZ_COPIES[nusiz & 7]) {
    for (let bit = 0; bit < 8; bit += 1) {
      if (!((byte >> (reflect ? bit : 7 - bit)) & 1)) continue;
      for (let k = 0; k < scale; k += 1) out.push((((start + copy + bit * scale + k) % 160) + 160) % 160);
    }
  }
  return out;
}

// *** kernel collisions ***
// The kernel only uses the hardware collision latches, cleared once per block.
// Block i is checked on its block line 7 (BIT CXM0P/CXP0FB/CXM0FB/CXPPMM, the
// first read at cycle 31, then every 6 cycles, 2 more after each hit because
// STX replaces the taken BPL) and line 8 (CXP1FB at 33, then CXCLR 6 cycles
// later, or 15 after a hit that sets PF_COLLIDE_FLAG). Lines >= 143, where the
// jet is drawn, start 7 cycles later. The check stores X = i + 1 (or i when the
// kernel was entered past line 7). The last segment is checked after the
// status display with X = blockOffset >= 26 ? 1 : 0. A read at cycle c sees
// pixels left of 3c - 68; CXCLR at cycle c clears pixels left of 3c + 3 - 68.
// Upstream's tools/atari/collisions.mjs latched the ROM's own TIA writes the same way.
const COLLISION = Object.freeze({ M0P: 0, P0FB: 2, P1FB: 3, M0FB: 4, PPMM: 7 });

// Collision pixel times (line * 160 + x) per latch, from per-line pixel masks.
export function collisionTimes(lineMasks) {
  const times = { [COLLISION.M0P]: [], [COLLISION.P0FB]: [], [COLLISION.P1FB]: [], [COLLISION.M0FB]: [], [COLLISION.PPMM]: [] };
  lineMasks.forEach((m, s) => {
    for (let x = 0; x < 160; x += 1) {
      const t = s * 160 + x;
      if (m.m0[x] && m.p1[x]) times[COLLISION.M0P].push(t);
      if (m.p0[x] && m.pf[x]) times[COLLISION.P0FB].push(t);
      if (m.p1[x] && m.pf[x]) times[COLLISION.P1FB].push(t);
      if (m.m0[x] && m.pf[x]) times[COLLISION.M0FB].push(t);
      if (m.p0[x] && m.p1[x]) times[COLLISION.PPMM].push(t);
    }
  });
  return times;
}

// Latched value (bit 7) of a collision register at time t since the last clear.
function latched(times, reg, from, to) {
  return times[reg].some((t) => t >= from && t < to) ? 0x80 : 0;
}

// Per-line pixel masks for the kernel from the playfield and object line models.
export function kernelLineMasks(mem, pfLines, objLines) {
  const playerX = mem[ZP.playerX], reflect0 = mem[ZP.reflect0];
  const jetX = playerX + (reflect0 ? 1 : 0);
  const missileX = mem[ZP.missileX] - 1;
  return pfLines.map((pfLine, s) => {
    const o = objLines[s];
    const pf = playfieldPixels(pfLine);
    const p0 = new Uint8Array(160), p1 = new Uint8Array(160), m0 = new Uint8Array(160);
    for (const x of playerPixels(o.grp0, jetX, 0, !!reflect0)) p0[x] = 1;
    if (o.block >= 0 && o.grp1) {
      const state = mem[ZP.State1Lst + o.block];
      for (const x of playerPixels(o.grp1, objectX(mem[ZP.XPos1Lst + o.block], state), state & 7, !!(state & 0x08))) p1[x] = 1;
    }
    if (o.enam0) m0[((missileX % 160) + 160) % 160] = 1;
    return { pf, p0, p1, m0 };
  });
}

// Runs the kernel's collision checks, writing hitEnemyIdx, PFCrashFlag,
// missileFlag, collidedEnemy and PF_COLLIDE_FLAG like the ROM does.
export function applyKernelCollisions(mem, times) {
  const store = { [COLLISION.M0P]: ZP.hitEnemyIdx, [COLLISION.P0FB]: ZP.PFCrashFlag, [COLLISION.M0FB]: ZP.missileFlag, [COLLISION.PPMM]: ZP.collidedEnemy };
  const blockOffset = mem[ZP.blockOffset];
  const top = blockOffset - 34;
  const at = (line, cycle) => line * 160 + 3 * cycle - 68;
  const jetZone = (line) => (line >= 143 ? 7 : 0);
  let from = 0;
  for (let block = NUM_BLOCKS - 1; block >= 0; block -= 1) {
    const s7 = top + (NUM_BLOCKS - 1 - block) * BLOCK_SIZE + 6;
    const s8 = s7 + 1;
    const checked7 = s7 >= 1 && s7 <= 159;
    if (checked7) {
      let cycle = 31 + jetZone(s7);
      for (const reg of [COLLISION.M0P, COLLISION.P0FB, COLLISION.M0FB, COLLISION.PPMM]) {
        if (latched(times, reg, from, at(s7, cycle))) { mem[store[reg]] = block + 1; cycle += 2; }
        cycle += 6;
      }
    }
    if (s8 >= 1 && s8 <= 159) {
      const x = checked7 ? block + 1 : block;
      let cycle = 33 + jetZone(s8);
      if (latched(times, COLLISION.P1FB, from, at(s8, cycle))) {
        mem[(ZP.blockLst + x) & 0xff] |= BLOCK_FLAGS.PF_COLLIDE;
        cycle += 9;
      }
      from = at(s8, cycle + 6) + 3;
    }
  }
  const end = KERNEL_LINES * 160;
  const last = blockOffset >= BLOCK_SIZE - 6 ? 1 : 0;
  for (const reg of [COLLISION.M0P, COLLISION.P0FB, COLLISION.M0FB]) if (latched(times, reg, from, end)) mem[store[reg]] = last;
  if (latched(times, COLLISION.P1FB, from, end)) mem[(ZP.blockLst + last) & 0xff] |= BLOCK_FLAGS.PF_COLLIDE;
  if (latched(times, COLLISION.PPMM, from, end)) mem[store[COLLISION.PPMM]] = last;
}

export { INIT_TAB };
