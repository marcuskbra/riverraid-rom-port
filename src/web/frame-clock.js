// Turns requestAnimationFrame timestamps into 60 Hz game frames. Browsers round
// the timestamps (Chrome to 0.1 ms, Safari and Firefox to 1 ms), and on a
// 120 Hz display that rounding decides on which refresh a frame lands, so
// frames would stay on screen for 1 or 3 refreshes instead of 2. Each interval
// within 1 ms of a whole number of half frames is snapped to it; what snapping
// removes goes into a carry that comes back half a frame at a time, so game
// speed still follows the wall clock.

const FRAME_MS = 1000 / 60;
const HALF_MS = FRAME_MS / 2;

// tick(t, running) returns how many game frames to run at rAF timestamp t.
// While not running, time passes without frames and is not caught up later.
export function createFrameClock() {
  let last = 0, acc = 0, carry = 0;
  return (t, running) => {
    if (!last) last = t;
    let dt = Math.min(100, t - last);
    last = t;
    const k = Math.round(dt / HALF_MS);
    if (k >= 1 && Math.abs(dt - k * HALF_MS) < 1) { carry += dt - k * HALF_MS; dt = k * HALF_MS; }
    if (carry >= HALF_MS) { dt += HALF_MS; carry -= HALF_MS; }
    else if (carry <= -HALF_MS) { dt -= HALF_MS; carry += HALF_MS; }
    if (!running) return 0;
    acc += dt;
    let frames = 0;
    while (acc >= FRAME_MS) { acc -= FRAME_MS; frames += 1; }
    return frames;
  };
}
