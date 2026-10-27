# River Raid Port

A browser port of Carol Shaw's River Raid (Activision, Atari 2600, 1982), rebuilt from the ROM's own game logic and checked against the real cartridge. Play it at **https://plicerin.github.io/riverraid-rom-port/**.

## Run

```sh
pnpm run serve
```

Open:

- Site with the game (the GitHub Pages front page): http://127.0.0.1:8080/
- Harness, the game with live RAM readouts: http://127.0.0.1:8080/harness.html
- Tribute page (source of the claude.ai artifact): http://127.0.0.1:8080/tribute.html

## Phones

Touch controls (D-pad and Fire) appear on touch screens. Full screen keeps the game and its controls on screen: it uses the browser's fullscreen where it is allowed (desktop, Android, iPad) and the same layout without it on iPhone, where Safari only lets video go fullscreen. On iPhone, Share → Add to Home Screen installs it as a web app (`manifest.webmanifest`, `img/icon-*.png`) that opens without the browser bar.

## How the port works

Game state is the ROM's zero page: a 256-byte array where every variable lives at its ROM address.

```
index.html, harness.html, tribute.html   pages (served as-is, no build step)
src/game/   pure game logic and drawing, no DOM: runs in Node and the browser
src/web/    browser code: canvas, keyboard, gamepad, touch and Web Audio
test/       smoke and snapshot tests
```

`src/game/` never imports from `src/web/`, which is what lets the tests run the whole game in Node.

- `src/game/river-raid.js`: the block generator (`.setBlockVars`) ported instruction for instruction, plus models of what the kernel draws on each of its 160 lines (playfield, enemy sprites, jet, missile) and of its per-block hardware collision checks.
- `src/game/status.js`: the score, fuel gauge, lives and copyright display, modelled on the ROM's status kernel.
- `src/game/frame.js`: the rest of the frame (MainLoop setup, enemy movement, joystick, fuel, crashes, scoring, missile, sound registers, switches, Reset/GameInit/LooseJet/SwapPlayers), ported instruction for instruction.
- `src/game/screen.js`, `src/game/palette.js`: paint a frame into a pixel buffer with Stella's NTSC palette.
- `src/game/data/`: ROM tables and shapes, extracted upstream from the ROM.
- `src/web/player.js`: the player used by the site and the tribute page (canvas, keyboard while focused, gamepad, touch buttons, console switches, sound).
- `src/web/harness.js`: the harness page's loop, with input (joystick bits, fire, RESET switch) and HUD readouts.
- `src/web/audio.js`, `src/web/gamepad.js`: sound and gamepad input shared by the player and the harness. Gamepads use the standard mapping: stick or D-pad to fly, A/B/X/Y to fire, Start for Game Reset, Back to pause.
- `src/web/tia-sound.worklet.js`: a TIA sound generator (after Ron Fries' TIASound) that plays the AUDC/AUDF/AUDV values the ROM's sound routine writes each frame. Sound starts on the first key press (browser autoplay rules); M mutes.

## Check

```sh
pnpm run check
```

Syntax-checks the modules and runs `test/smoke.test.js`: a power-on/RESET run of the port that compares a checksum of the start screen (a Stella snapshot match upstream) and checks that the game starts. Then `test/snapshot.test.js` plays five scripted runs (attract mode with the screensaver, one and two players, low fuel and a maxed-out score) and compares every frame with `test/snapshot.json`: the zero page apart from scratch bytes, the sound registers and the screen as `drawScreen` paints it. Without the ROM, that recording is the reference, so a refactor must leave every frame unchanged.

After an intended change to the game's behavior, re-record it and commit the new `test/snapshot.json`:

```sh
pnpm run snapshot:update
```

## Verification

Upstream ([Plicerin/riverraid-rom-port](https://github.com/Plicerin/riverraid-rom-port#verify-against-the-rom)) checks the port frame by frame against the real ROM on a 6502 core. That tooling needs the ROM, which is not distributed, so this fork removed it along with the disassemblies in `reference/`.

## Known gaps

- The sound generator's polynomial noise follows TIASound's structure, but the exact LFSR phases have not been compared with Stella's audio.
