// One player's game in a race: a one-player River Raid that starts when the
// round does and ends at the game's own game over. There is no RESET and no
// pause, and a jet left waiting at READY takes off by itself, so nobody can
// hold the round up. No DOM: src/web/race.js gives it the controls and draws
// what it returns, and the tests drive it directly.

import { romReset, runFrame, Z, MEMORY_SIZE } from '../game/frame.js';
import { createProgress, score } from './progress.js';

const READY = 48, GAME_OVER = 0xff;
export const TAKEOFF_FRAMES = 300; // 5 seconds at READY, then the jet takes off
const RESET_FRAMES = 3; // the RESET switch is held this long to start the game

export function createRacer() {
  const mem = new Uint8Array(MEMORY_SIZE);
  const io = { swcha: 0xff, swchb: 0x0b, inpt4: 0x80, inpt5: 0x80 };
  let progress = null, resetHold = 0, waiting = 0, playing = false, over = false;
  let display = null, shown = null;
  romReset(mem, 0);

  return {
    // power on and press RESET: the round's game, at its first jet
    start() {
      romReset(mem, 0);
      progress = createProgress();
      resetHold = RESET_FRAMES;
      waiting = 0;
      playing = false;
      over = false;
    },
    // One frame with controls { up, down, left, right, fire }. Does nothing
    // before start() and after game over.
    step(controls) {
      if (!progress || over) return;
      let swcha = 0xff;
      if (controls.right) swcha &= ~0x80;
      if (controls.left) swcha &= ~0x40;
      if (controls.down) swcha &= ~0x20;
      if (controls.up) swcha &= ~0x10;
      waiting = mem[Z.gameMode] === READY ? waiting + 1 : 0;
      io.swcha = swcha;
      io.inpt4 = controls.fire || waiting >= TAKEOFF_FRAMES ? 0x00 : 0x80;
      io.swchb = resetHold > 0 ? 0x0a : 0x0b; // bit 0 low: the RESET switch
      io.swchbNext = undefined;
      // the kernel draws before the frame's logic moves the jet: the picture
      // shows the jet as the frame found it, and so do the ghosts
      shown = {
        d: progress(mem), x: mem[Z.playerX], shape: mem[Z.shapePtr0], reflect: mem[Z.reflect0], mode: mem[Z.gameMode],
      };
      display = runFrame(mem, io).display;
      if (resetHold > 0) resetHold -= 1;
      if (mem[Z.gameMode] !== GAME_OVER) playing = true;
      else if (playing) over = true;
    },
    get display() { return display; },
    get io() { return io; }, // the last frame's TIA writes: colors and sound
    get mode() { return mem[Z.gameMode]; },
    get over() { return over; },
    get score() { return score(mem); },
    // where the jet on screen is, for the other players: { d, x, shape, reflect, mode, score }
    position() { return shown && { ...shown, score: score(mem) }; },
  };
}
