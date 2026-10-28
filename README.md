# River Raid Port

A browser port of Carol Shaw's River Raid (Activision, Atari 2600, 1982), rebuilt from the ROM's own game logic and checked against the real cartridge. Play it at **https://plicerin.github.io/riverraid-rom-port/**.

## Run

```sh
pnpm install
pnpm run serve
```

`pnpm install` installs the static server and Biome, and turns on the pre-push hook (see Check). Open:

- Site with the game (the GitHub Pages front page): http://127.0.0.1:8080/
- Harness, the game with live RAM readouts: http://127.0.0.1:8080/harness.html
- Tribute page (source of the claude.ai artifact): http://127.0.0.1:8080/tribute.html

## Phones

Touch controls (D-pad and Fire) appear on touch screens. Full screen keeps the game and its controls on screen: it uses the browser's fullscreen where it is allowed (desktop, Android, iPad) and the same layout without it on iPhone, where Safari only lets video go fullscreen. On iPhone, Share → Add to Home Screen installs it as a web app (`manifest.webmanifest`, `img/icon-*.png`) that opens without the browser bar.

## How the port works

Game state is a byte array that holds the ROM's zero page, every variable at its ROM address, plus the river's block lists past it at $100-$12F. The river has 8 blocks where the cartridge has 6, so it shows 224 lines, 64 more of upcoming river than the cartridge; the bottom 160 keep the cartridge's geometry.

```
index.html, harness.html, tribute.html   pages (served as-is, no build step)
src/game/   pure game logic and drawing, no DOM: runs in Node and the browser
src/web/    browser code: canvas, keyboard, gamepad, touch and Web Audio
test/       smoke, snapshot, taller river, frame pacing and preload tests
```

`src/game/` never imports from `src/web/`, which is what lets the tests run the whole game in Node.

- `src/game/river-raid.js`: the block generator (`.setBlockVars`), plus models of what the kernel draws on each of its 224 lines (playfield, enemy sprites, jet, missile) and of its per-block hardware collision checks.
- `src/game/status.js`: the score, fuel gauge, lives and copyright display, modelled on the ROM's status kernel.
- `src/game/frame.js`: the rest of the frame (MainLoop setup, enemy movement, joystick, fuel, crashes, scoring, missile, sound registers, switches, Reset/GameInit/LooseJet/SwapPlayers).
- `src/game/screen.js`, `src/game/palette.js`: paint a frame into a pixel buffer with Stella's NTSC palette.
- `src/game/data/`: ROM tables and shapes, extracted upstream from the ROM.
- `src/web/player.js`: the player used by the site and the tribute page (canvas, keyboard while focused, gamepad, touch buttons, console switches, sound).
- `src/web/harness.js`: the harness page's loop, with input (joystick bits, fire, RESET switch) and HUD readouts.
- `src/web/audio.js`, `src/web/gamepad.js`: sound and gamepad input shared by the player and the harness. Gamepads use the standard mapping: stick or D-pad to fly, A/B/X/Y to fire, Start for Game Reset, Back to pause.
- `src/web/frame-clock.js`: turns requestAnimationFrame timestamps into 60 Hz game frames, evenly paced on 60 and 120 Hz displays, for the player and the harness.
- `src/web/tia-sound.worklet.js`: a TIA sound generator (after Ron Fries' TIASound) that plays the AUDC/AUDF/AUDV values the ROM's sound routine writes each frame. Sound starts on the first key press (browser autoplay rules); M mutes.

## Check

```sh
pnpm run check
```

Lints the code with [Biome](https://biomejs.dev) (its recommended rules; the formatter is off, so the compact style and the ROM tables' rows stay as they are), then runs every `test/*.test.js` with Node's test runner. `test/syntax.test.js` syntax-checks every module under `src/`, including the browser code the other tests don't load. `test/smoke.test.js` is a power-on/RESET run of the port that compares a checksum of the start screen's bottom 160 river lines (a Stella snapshot match upstream) and checks that the game starts. `test/taller.test.js` checks the 64 lines above them: river up to the top at every life start, the missile reaching the top, enemies there that move and can be shot, and the restart after a crash while a new section shows only at the top. `test/snapshot.test.js` plays five scripted runs (attract mode with the screensaver, one and two players, low fuel and a maxed-out score) and compares every frame with `test/snapshot.json`: the RAM apart from scratch bytes, the sound registers and the screen as `drawScreen` paints it. Without the ROM, that recording is the reference, so a refactor must leave every frame unchanged. `test/frame-clock.test.js` checks the frame pacing on simulated displays from 50 to 144 Hz. `test/preload.test.js` checks that each page's `modulepreload` list matches the modules its scripts import, so a new module needs a line in each page that loads it.

The pre-push hook in `.githooks/` runs the same check before every push. `git push --no-verify` skips it once.

After an intended change to the game's behavior, re-record it and commit the new `test/snapshot.json`:

```sh
pnpm run snapshot:update
```

## Verification

Upstream ([Plicerin/riverraid-rom-port](https://github.com/Plicerin/riverraid-rom-port#verify-against-the-rom)) checks the port frame by frame against the real ROM on a 6502 core. That tooling needs the ROM, which is not distributed, so this fork removed it along with the disassemblies in `reference/`.

Upstream's port mirrors the 6502 code: a register model, labels and carry flags. This fork rewrote it as plain JS that follows the ROM routine by routine, with each variable still at its zero-page address. Each step passed the snapshot test and a differential test that plays upstream's port and this one side by side, comparing RAM, sound and the screen after every frame. The finished code passed the differential test's full run: 200 games of 4,000 frames each (about 800,000 frames, reaching every line of upstream's `frame.js` and `river-raid.js` apart from two error branches). Unit diffs of the block generator and the frame logic compared 2 million random states each. Those tests import upstream's code, so they are not part of this repo; the snapshot test guards the result from here on. The 8-block river came after that. A one-off check ran it against the 6-block version for 100 games without firing, half of them with a pilot that cleared enemies near the jet and kept it in the river so it reached the section's end. Status, sound, the jet, the missile, the playfield on the cartridge's 160 lines and the bottom 6 blocks' lists matched on every frame (the pilot games left out enemy positions; enemy sprite pixels were not compared).

## Known gaps

- The taller river changes a few things on purpose. Planes that come in at the top fly 64 lines longer, so they cross the river at other places. Helicopter rotors can be in a different phase. The missile flies on to the new top, so it can hit enemies the cartridge doesn't show yet.
- The sound generator's polynomial noise follows TIASound's structure, but the exact LFSR phases have not been compared with Stella's audio.
