// Other players' jets on your river (src/race/ghosts.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { romReset, runFrame, Z, MEMORY_SIZE } from '../src/game/frame.js';
import { KERNEL_LINES } from '../src/game/river-raid.js';
import { drawScreen, SCREEN_WIDTH, SCREEN_LINES } from '../src/game/screen.js';
import { createProgress } from '../src/race/progress.js';
import { drawGhosts } from '../src/race/ghosts.js';

// a game a few seconds after take-off, drawn; stick banks the jet at the end
function flying(stick = 0x7f) {
  const mem = new Uint8Array(MEMORY_SIZE);
  const io = { swcha: 0xff, swchb: 0x0a, inpt4: 0x80, inpt5: 0x80 };
  romReset(mem, 0);
  for (let i = 0; i < 3; i += 1) runFrame(mem, io);
  io.swchb = 0x0b;
  const progress = createProgress();
  let display, jet, me;
  for (let frame = 0; frame < 260; frame += 1) {
    io.inpt4 = frame === 100 ? 0x00 : 0x80;
    io.swcha = frame >= 252 ? stick : 0xff;
    // the kernel draws before the frame's logic moves the jet: the picture
    // shows the jet as the frame found it
    me = { d: progress(mem), mode: mem[Z.gameMode] };
    jet = { d: me.d, x: mem[Z.playerX], shape: mem[Z.shapePtr0], reflect: mem[Z.reflect0], mode: 0, color: 'red' };
    display = runFrame(mem, io).display;
  }
  assert.equal(mem[Z.gameMode], 0, 'flying');
  const image = { data: new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_LINES * 4) };
  drawScreen(display, io, image);
  return { display, image, me, jet };
}

// the pixels a draw changed, as "line,x"
function changed(before, after) {
  const out = [];
  for (let i = 0; i < before.length; i += 4) {
    if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) out.push(`${(i >> 2) / SCREEN_WIDTH | 0},${(i >> 2) % SCREEN_WIDTH}`);
  }
  return out.sort();
}

test('a ghost at your distance covers your own jet, banking either way', () => {
  for (const stick of [0x7f, 0xbf]) { // right; left is the reflected shape
    const { display, image, me, jet } = flying(stick);
    const before = image.data.slice();
    const labels = drawGhosts(image, me, [jet]);
    const ownJet = [];
    display.masks.forEach((m, line) => { m.p0.forEach((on, x) => { if (on) ownJet.push(`${line},${x}`); }); });
    assert.ok(ownJet.length > 20);
    assert.deepEqual(changed(before, image.data), ownJet.sort());
    assert.equal(labels.length, 1);
    assert.equal(labels[0].edge, undefined);
  }
});

test('a ghost further on is higher up by the lines it is ahead', () => {
  const { image, me, jet } = flying();
  const reference = image.data.slice(), atMe = image.data.slice();
  drawGhosts({ data: atMe }, me, [jet]);
  const before = image.data.slice();
  drawGhosts(image, me, [{ ...jet, d: me.d + 150 }]);
  const shifted = changed(reference, atMe).map((p) => { const [l, x] = p.split(','); return `${l - 150},${x}`; });
  assert.deepEqual(changed(before, image.data), shifted.sort());
});

test('a distance between lines paints the nearest whole line', () => {
  const at = (d) => {
    const { image, me, jet } = flying();
    const before = image.data.slice();
    drawGhosts(image, me, [{ ...jet, d: me.d + d }]);
    return changed(before, image.data);
  };
  const painted = at(150.4);
  assert.ok(painted.length > 20, 'the ghost was not painted');
  assert.deepEqual(painted, at(150));
  assert.deepEqual(at(150.6), at(151));
});

test('ghosts off screen get an edge marker and no pixels', () => {
  const { image, me, jet } = flying();
  const before = image.data.slice();
  const labels = drawGhosts(image, me, [{ ...jet, d: me.d + KERNEL_LINES + 40 }, { ...jet, d: me.d - 30, color: 'cyan' }]);
  assert.deepEqual(labels.map((l) => l.edge), ['top', 'bottom']);
  assert.deepEqual(changed(before, image.data), []);
});

test('no ghosts while your river or theirs scrolls in after a new jet', () => {
  const { image, me, jet } = flying();
  const before = image.data.slice();
  assert.deepEqual(drawGhosts(image, { ...me, mode: 60 }, [jet]), []);
  assert.deepEqual(drawGhosts(image, me, [{ ...jet, mode: 60 }, { ...jet, d: null }]), []);
  assert.deepEqual(changed(before, image.data), []);
});
