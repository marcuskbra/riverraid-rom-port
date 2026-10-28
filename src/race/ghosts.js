// The other players' jets on your river, see-through in their colors. They
// are painted into the picture after drawScreen, so they never reach the
// kernel's collision checks: nothing in your game knows they are there.
//
// A ghost is where its player's jet is relative to yours: the same distance
// (src/race/progress.js) puts it on your jet's lines, further on puts it
// higher up. The jet sits at the bottom, so only players ahead show; the
// others get a marker on the edge they are past.

import { KERNEL_LINES, playerPixels } from '../game/river-raid.js';
import { jetTable } from '../game/frame.js';

// the room's colors (src/race/room.js) as RGB
export const COLOR_RGB = Object.freeze({
  red: 0xe23b3b, orange: 0xf28a1c, pink: 0xf06cc8, white: 0xf2f4fa, cyan: 0x4ff2dc,
  lime: 0x7cf24a, purple: 0x9d5cf0, brown: 0xa0703c, black: 0x20202a, gray: 0x9a9aa8,
});
const JET_ROWS = 18; // jetTable rows; row i is on kernel line KERNEL_LINES - i (row 0 is off screen)
const ALPHA = 0.6;

// Does gameMode show the river the generator built? Not while it scrolls in
// after a new jet (49-127): those bottom blocks are InitTab's straight river.
const onRiver = (mode) => mode === 0 || mode === 48 || mode >= 0x80;

// Paints ghosts into image (drawScreen's ImageData) and returns what is left
// to label: [{ ghost, x, line }] for ghosts on screen and [{ ghost, edge:
// 'top' | 'bottom', x }] for the rest.
//   me: { d, mode } for your jet; ghosts: [{ d, x, shape, reflect, mode, color }]
export function drawGhosts(image, me, ghosts) {
  const labels = [];
  if (me.d === null || !onRiver(me.mode)) return labels;
  const pixels = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.length >> 2);
  for (const ghost of ghosts) {
    if (ghost.d === null || ghost.d === undefined || !onRiver(ghost.mode)) continue;
    const ahead = Math.round(ghost.d - me.d); // whole lines: a moved-on ghost's distance has fractions
    const top = KERNEL_LINES - (JET_ROWS - 1) - ahead; // the ghost's top line
    if (top + JET_ROWS <= 0) { labels.push({ ghost, edge: 'top', x: ghost.x }); continue; }
    if (top >= KERNEL_LINES) { labels.push({ ghost, edge: 'bottom', x: ghost.x }); continue; }
    const rgb = COLOR_RGB[ghost.color] ?? 0xffffff;
    const rows = jetTable(ghost.shape);
    for (let i = 1; i < JET_ROWS; i += 1) {
      const line = KERNEL_LINES - i - ahead;
      if (line < 0 || line >= KERNEL_LINES) continue;
      for (const x of playerPixels(rows[i], ghost.x + (ghost.reflect ? 1 : 0), 0, !!ghost.reflect)) {
        const o = line * 160 + x;
        pixels[o] = blend(pixels[o], rgb);
      }
    }
    labels.push({ ghost, x: ghost.x, line: Math.max(0, top) });
  }
  return labels;
}

// ALPHA of rgb over an RGBA pixel word (R in the low byte, as ImageData reads)
function blend(word, rgb) {
  const mix = (under, over) => Math.round(under + (over - under) * ALPHA);
  const r = mix(word & 0xff, rgb >> 16), g = mix((word >> 8) & 0xff, (rgb >> 8) & 0xff), b = mix((word >> 16) & 0xff, rgb & 0xff);
  return (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
}
