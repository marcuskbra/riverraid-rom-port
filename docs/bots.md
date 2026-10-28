# Bot Pilots

Bot pilots fill a match on the relay, so one person can test a full match: 10 jets on the river, 10 names in the lobby and the relay's busiest traffic. They fly real games of River Raid on an autopilot, and they report the relay's traffic and latency every 5 seconds.

This is a test tool, not part of the game. It has no tests of its own (see "Limits").

| File | What it does |
| --- | --- |
| `scripts/bots.js` | Connects the bots to a match on the relay, runs their games at 60 frames a second, and prints the report. |
| `scripts/autopilot.js` | Picks a bot's stick, speed and fire button for each frame, from what its game drew. |
| `src/match/pilot.js` | The same one-player game the page runs. Its `memory` getter gives the autopilot read-only access to the game's RAM. |

## Running It

Start the relay first, in its own terminal:

```sh
pnpm run match
```

Then choose who hosts.

### You Host

1. Open http://127.0.0.1:8080/match.html, type a name and press **Make a match**.
2. Note the four-letter code in the panel, for example `ABCD`.
3. In a second terminal, send the bots in:

   ```sh
   pnpm run bots -- --code ABCD
   ```

4. Pick a color, then press **Start the round** when the 9 bots are in the list.

The bots fly every round you start, and each round is a new game for them. If you leave, the relay makes the next player in join order the host. That is a bot, and in this mode the bots never start a round, so the match stops at the lobby.

### The Bots Host

```sh
pnpm run bots
```

1. The script makes a code and prints the match link, for example `http://127.0.0.1:8080/match.html?match=QWER`.
2. Bot 1 joins first and hosts.
3. Open the link to join as the 10th player.
4. Bot 1 starts a round after the match sits 10 seconds in the lobby, and again 10 seconds after each round ends.

A player who joins during a round watches it and flies from the next one, as in any match.

### Options

| Option | Default | What it sets |
| --- | --- | --- |
| `--code ABCD` | none: the bots make a match | The match to join. With it, you host. |
| `--bots 9` | `9` | How many bots join. A match holds 10 players, so a 10th bot gets "The room is full." when you are in it. |
| `--relay ws://127.0.0.1:8080` | `ws://127.0.0.1:8080` | The relay. Use it when the relay runs on another port or machine, for example `--relay ws://127.0.0.1:8090` with `PORT=8090 pnpm run match`. |
| `--start 10` | `10` | When the bots host: seconds in the lobby before bot 1 starts a round. |

Press Ctrl+C to stop. The bots close their connections, and the relay counts them as out.

## The Report

Every 5 seconds the script prints one block. This one is from 9 bots flying, with no person in the match:

```
11:13:51
  9 bots (9 flying) · 9 players, playing, round 1
  out 135 pos/s, 9.4 KB/s
  in 1080 msg/s, 82.6 KB/s (pos 1080/s, from people 0/s, room 0/s)
  latency p50 8.3 ms p95 9.6 ms max 12.5 ms
  loop lag max 12.6 ms · a frame of every bot's game: 7.93 ms of 16.7
```

| Line | What it means |
| --- | --- |
| `9 bots (9 flying)` | Bots still connected, and how many of them are flying now. The rest are out or wait for a round. |
| `9 players, playing, round 1` | The match as bot 1 sees it: players in it, its phase (`lobby` or `playing`) and the round number. |
| `out ... pos/s, KB/s` | What all bots send together. Each flying bot sends 15 positions a second, as the page does. |
| `in ... msg/s, KB/s` | What all bots receive together, every message type. In brackets: positions, positions from people (every player who is not a bot), and room updates. |
| `latency p50 p95 max` | How long a bot's position takes to reach the other bots: bot to relay to bot, in the same process. |
| `loop lag max` | The longest gap between two ticks of the bots' 4 ms timer. Far above 16.7 ms means the script falls behind and its bots fly in jerks. |
| `a frame of every bot's game` | The time one frame of all bots' games and autopilots takes, against the 16.7 ms a frame lasts at 60 Hz. |

### Reading the Numbers

- **Traffic grows with the square of the players.** The relay sends every position to every other player. With n players flying, it receives 15 × n positions a second and sends 15 × n × (n − 1). At 9 bots that is 135 in and 1,080 out. At 10 players it is 150 in and 1,350 out.
- **The latency is mostly the bots' own wait.** All bots run in one Node thread. A position that arrives while the thread runs the bots' frames waits until the frames are done. So the latency includes up to one frame of every bot's game: about 7.5 ms with the autopilot, against about 5 ms with random controls. The relay's own share is the small rest. To measure the relay alone, run fewer bots in each of several processes, for example 3 processes with `--bots 3`.
- **Positions are matched, not tagged.** The relay forwards only the position fields, so the script can't add a timestamp. It remembers when each bot sent each position (by the bot's id, distance, x and score) and looks the position up when another bot receives it. Two identical positions from one bot within 5 seconds count once, with the later time.
- **People's positions have no latency.** The script didn't send them, so it can't time them. They show only as `from people`.

## The Autopilot

`autopilot(pilot, state)` returns the controls for the next frame: `{ left, right, up, down, fire }`. `state` is an object the caller keeps for each bot; `scripts/bots.js` makes a new one for each game.

### What It Sees

- **The picture.** `pilot.display` holds the kernel's pixel masks for each of the 448 lines: the banks (`pf`), the jet (`p0`) and the objects (`p1`), and which block each line's object belongs to.
- **The RAM.** `pilot.memory` gives the jet's x position, speed, sideways speed and fuel, and the shape id of each block's object. The id says what an object is: ids 4 to 8 (planes, helicopters, ships and bridges) kill the jet, id 10 is a fuel depot, and the autopilot ignores houses and explosions.
- **One frame late.** The game draws a frame before it moves anything, so the picture shows the jet and the river as they were before the last frame's logic. The autopilot adds back how far the jet moved and how far the river scrolled in that frame.

### How It Picks a Plan

Every frame it flies 39 plans 100 frames ahead, against the picture as it is now:

- **Steering:** straight, or left or right for 4, 8, 16, 32, 64 or 100 frames, then straight. Each uses the game's sideways acceleration: a held stick speeds the jet up by 8/256 of a pixel a frame, up to almost a pixel a frame, and a released stick stops it at once.
- **Speed:** each steering plan three times, while it slows down, cruises or speeds up, with the game's own steps of 2 in `speedY` between 0x40 and 0xfe. At 0x80 the river moves one line a frame.
- **The river:** for frame k, banks and objects are moved down by the distance the plan's speeds scroll in k frames. Banks are widened by 1 pixel on each side.
- **Enemies** move sideways at their speed over their last 8 frames, and are widened by 3 pixels on each side. An enemy counts as shot when it crosses the jet's center column at least 24 lines ahead, because the missile flies up that column.

It keeps the best plan, compared in this order:

1. The most frames without touching a bank or an enemy.
2. When fuel is low (`fuelHi` below 0xc0): the most fuel depots flown over.
3. The most enemies shot.
4. The speed the bot wants now: cruising, or now and then flying fast (see "Each Bot's Style").
5. The most water on the narrower side of the jet, up to 20 pixels, at the end of the plan.
6. The stick it already holds, so it doesn't twitch.
7. The bot's side, left or right.

Then it holds the plan's stick and speed for one frame, and plans again on the next.

### Fire

- It fires all the time. A jet left at READY takes off at once.
- When fuel is low, it holds fire while a fuel depot is ahead within 4 pixels of the jet's center column, so it doesn't shoot the fuel it needs.
- When fuel is very low (`fuelHi` below 0x60), it holds fire while any fuel depot is ahead on screen.

### Each Bot's Style

Every bot on one river would fly the same way, because the river and the plans are the same. So each bot draws a style at random on its first frame and keeps it for every game:

- `fast`: a chance between 0 and 60%. Every 1 to 3 seconds, the bot draws again whether it wants to fly fast while the water is clear.
- `side`: left or right, for ties between two equal plans.

Enemies move with the frame counter, so games soon differ anyway.

### How Well It Flies

Measured offline, playing the game alone in Node with no relay:

| Controls | A game lasts | Points |
| --- | --- | --- |
| The autopilot, 8 games | 18 to 111 s | 600 to 6,650 |

On the relay, with random controls (before the autopilot), 6 of 9 bots were out about 20 seconds into a round. With the autopilot, all 9 were still flying after 40 seconds.

It still crashes, most often in these cases:

- A helicopter or ship turns around next to the jet. The autopilot expects it to keep its sideways speed.
- A plane crosses faster than the 3 pixels a frame the tracking allows.
- A missile already in flight hits a fuel depot that the autopilot wants.
- A narrow channel needs a turn that starts more than 100 frames ahead.

Good enough for a test, with no need to be perfect: a round with bots lasts about a minute, and the host can end it at any time.

### What It Costs

About 0.4 ms of CPU per bot per frame, for a plan of 39 × 100 frames. Nine bots add up to about 7.5 ms per 16.7 ms frame, with the games themselves. Far more bots in one process would fall behind (watch `loop lag`). Run several processes instead.

## Limits

- **One match at a time.** All bots join one code. To load the relay with several matches, run the script several times with different codes.
- **Bots don't host matches you make.** With `--code`, you are the host. If you leave, a bot hosts and never starts a round.
- **The bots trust the relay.** They ignore errors other than "The room is full." and don't reconnect.
- **No tests.** `pnpm run check` lints both scripts but doesn't run them.
