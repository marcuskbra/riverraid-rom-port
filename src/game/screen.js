// Draws one frame of the port into a 160 x SCREEN_LINES ImageData: the
// KERNEL_LINES kernel lines, the kernel's last playfield line once more, then
// the ROM's status display. Colors are TIA bytes looked up in Stella's NTSC
// palette; HMOVE on every line blanks the first 8 pixels; priority P0/M0 > P1 >
// PF > BK.

import { KERNEL_LINES } from './river-raid.js';
import { statusLinePixels } from './status.js';
import { NTSC_PALETTE_RGB } from './palette.js';

export const SCREEN_WIDTH = 160;
export const SCREEN_LINES = KERNEL_LINES + 1 + 38;

// the palette as RGBA pixels, one 32-bit word each, in the same byte order as
// a Uint32Array view of the image; entry 0 is black
const RGBA = new Uint32Array(Uint8Array.from(NTSC_PALETTE_RGB.flatMap((rgb) => [rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff, 255])).buffer);

// display: runFrame(...).display; io: the io object after runFrame (colubk, colup0)
export function drawScreen(display, io, image) {
  const { pf, objs, masks, ssXor, ssMask, status } = display;
  const tint = (c) => RGBA[((c ^ ssXor) & ssMask) >> 1];
  const bg = RGBA[(io.colubk ?? 0x84) >> 1];
  const p0 = RGBA[(io.colup0 ?? 0x1c) >> 1];
  const data = image.data;
  const pixels = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
  for (let s = 0; s < KERNEL_LINES; s += 1) {
    const pfColor = tint(pf[s].colupf);
    const p1Color = tint(objs[s].colup1);
    const { p0: p0Mask, m0: m0Mask, p1: p1Mask, pf: pfMask } = masks[s];
    const o = s * SCREEN_WIDTH;
    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      let color = bg;
      if (p0Mask[x] || m0Mask[x]) color = p0;
      else if (p1Mask[x]) color = p1Color;
      else if (pfMask[x]) color = pfColor;
      pixels[o + x] = color;
    }
  }
  const lastPf = masks[KERNEL_LINES - 1].pf, lastColor = tint(pf[KERNEL_LINES - 1].colupf);
  for (let x = 0; x < SCREEN_WIDTH; x += 1) pixels[KERNEL_LINES * SCREEN_WIDTH + x] = lastPf[x] ? lastColor : bg;
  status.forEach((line, i) => {
    const row = statusLinePixels(line), o = (KERNEL_LINES + 1 + i) * SCREEN_WIDTH;
    for (let x = 0; x < SCREEN_WIDTH; x += 1) pixels[o + x] = RGBA[row[x] >> 1];
  });
  for (let s = 0; s < KERNEL_LINES + 1 + status.length; s += 1) pixels.fill(RGBA[0], s * SCREEN_WIDTH, s * SCREEN_WIDTH + 8);
}
