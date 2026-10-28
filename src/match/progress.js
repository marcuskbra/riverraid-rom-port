// What a match needs to know about one player's game, read from its RAM: how
// far the jet has flown, its score, and what its jet looks like. No DOM: the
// browser, the relay and the tests all use it.
//
// Distance: the river is one fixed sequence of blocks. Every new block steps
// the 16-bit LFSR (randomLo/Hi) once, and the block is built from the stepped
// value, so the LFSR identifies the top block: a block's index is the number
// of steps from the seed. A new jet restores the saved section's LFSR and
// builds the blocks above the cartridge's 6 in one frame, and LooseJet can
// move that restart point a section either way; counting the scroll would
// miss all of that, looking the LFSR up does not.

import { NUM_BLOCKS, BLOCK_SIZE, ZP } from '../game/river-raid.js';
import { INIT_TAB } from '../game/data/playfield.js';

// the LFSR at the start of every game: InitTab's randomLoSave/randomHiSave
const SEED = INIT_TAB[12 + ZP.randomLoSave - ZP.missileY] | (INIT_TAB[12 + ZP.randomHiSave - ZP.missileY] << 8);
// the seed's own block: InitTab's river fills blocks 0-5, the first new block is 6
const SEED_INDEX = 5;
// a new jet builds NUM_BLOCKS - 6 blocks at once, past the river seen so far at most
const MAX_STEPS = 2 * NUM_BLOCKS;

const lfsr = (mem) => mem[ZP.randomLo] | (mem[ZP.randomHi] << 8);

// NextRandom16 backwards: the forward step shifts left and shifts in bit 12 XOR
// bit 15, so the old bit 15 is the new bit 0 XOR the new bit 13
function previous(value) {
  const bit15 = (value ^ (value >> 13)) & 1;
  return (value >> 1) | (bit15 << 15);
}

// Returns progress(mem): the distance the jet has flown in river lines, or
// null when the LFSR is not one of this game's (before the game starts).
// Make one per game, after RESET.
export function createProgress() {
  const known = new Map([[SEED, SEED_INDEX]]);
  return (mem) => {
    const value = lfsr(mem);
    let back = value, steps = 0;
    while (!known.has(back)) {
      if (steps === MAX_STEPS) return null;
      back = previous(back);
      steps += 1;
    }
    const top = known.get(back) + steps;
    for (let v = value, i = top; v !== back; v = previous(v), i -= 1) known.set(v, i);
    return (top - (NUM_BLOCKS - 1)) * BLOCK_SIZE + mem[ZP.blockOffset];
  };
}

// The score: six digits at scorePtr1 ($CD) + 0, 2, .. 10, each the low byte of a
// pointer to an 8-line digit shape (blank before the first point)
export function score(mem) {
  let points = 0;
  for (let i = 0; i <= 10; i += 2) {
    const low = mem[0xcd + i];
    points = points * 10 + (low <= 0x48 ? low >> 3 : 0);
  }
  return points;
}
