# River Raid Port

A browser port of Carol Shaw's River Raid (Activision, Atari 2600, 1982), rebuilt from the ROM's own game logic and checked against the real cartridge. Play it at **https://plicerin.github.io/riverraid-rom-port/**.

## Run

```powershell
npm run serve
```

Open:

- Site with the game (the GitHub Pages front page): http://127.0.0.1:8080/
- Harness, the game with live RAM readouts: http://127.0.0.1:8080/harness.html
- Tribute page (source of the claude.ai artifact): http://127.0.0.1:8080/tribute.html

## Phones

Touch controls (D-pad and Fire) appear on touch screens. Full screen keeps the game and its controls on screen: it uses the browser's fullscreen where it is allowed (desktop, Android, iPad) and the same layout without it on iPhone, where Safari only lets video go fullscreen. On iPhone, Share → Add to Home Screen installs it as a web app (`manifest.webmanifest`, `img/icon-*.png`) that opens without the browser bar.

## How the port works

Game state is the ROM's zero page: a 256-byte array where every variable lives at its ROM address.

- `riverraidRiver.mjs`: the block generator (`.setBlockVars`) ported instruction for instruction, plus models of what the kernel draws on each of its 160 lines (playfield, enemy sprites, jet, missile) and of its per-block hardware collision checks.
- `riverraidStatus.mjs`: the score, fuel gauge, lives and copyright display, modelled on the ROM's status kernel.
- `riverraidFrame.mjs`: the rest of the frame (MainLoop setup, enemy movement, joystick, fuel, crashes, scoring, missile, sound registers, switches, Reset/GameInit/LooseJet/SwapPlayers), ported instruction for instruction.
- `riverraidPlayfieldData.mjs`, `riverraidKernelSprites.mjs`: ROM tables and shapes, extracted upstream from the ROM.
- `riverraidPlayer.mjs`: the player used by the site and the tribute page (canvas, keyboard while focused, gamepad, touch buttons, console switches, sound).
- `game.mjs`: the harness page's loop, with input (joystick bits, fire, RESET switch) and HUD readouts.
- `riverraidScreen.mjs`, `riverraidAudio.mjs`, `riverraidGamepad.mjs`, `riverraidPalette.mjs`: drawing, sound, gamepad input and palette shared by `game.mjs` and `riverraidPlayer.mjs`. Gamepads use the standard mapping: stick or D-pad to fly, A/B/X/Y to fire, Start for Game Reset, Back to pause.
- `tiaSound.worklet.js`: a TIA sound generator (after Ron Fries' TIASound) that plays the AUDC/AUDF/AUDV values the ROM's sound routine writes each frame. Sound starts on the first key press (browser autoplay rules); M mutes.

## Check

```powershell
npm run check
```

Syntax-checks the modules and runs `smoke-check.mjs`: a power-on/RESET run of the port that compares a checksum of the start screen (a Stella snapshot match upstream) and checks that the game starts.

## Verification

Upstream ([Plicerin/riverraid-rom-port](https://github.com/Plicerin/riverraid-rom-port#verify-against-the-rom)) checks the port frame by frame against the real ROM on a 6502 core. That tooling needs the ROM, which is not distributed, so this fork removed it along with the disassemblies in `reference/`.

## Known gaps

- The sound generator's polynomial noise follows TIASound's structure, but the exact LFSR phases have not been compared with Stella's audio.
