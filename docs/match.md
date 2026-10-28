# River Raid Match

A multiplayer mode for playing with remote teammates. Everyone flies their own game of River Raid at the same time, on the same river, and sees the other players' jets drawn see-through on it. The last jet flying ends the round, and the top score wins.

```sh
pnpm run match     # then open http://127.0.0.1:8080/match.html
```

## The idea

The team is remote, so modes that need one machine (shared keyboard, split screen) are out. Co-op, where players share one river and its enemies, was dropped too. A ghost match is also much simpler to build: co-op needs one game state kept in sync over the network, with every crash and shot agreed on.

The players compete only through their scores. Nobody can shoot, block or help another player, so each game would play the same way if the others were absent. "Match" names that: a contest with a ranking, which promises no interaction.

A match takes its shape from two things:

- **The lobby works like Among Us.** Someone makes a match and shares a four-letter code or a link. Everyone joins, picks a color, and the host starts the round.
- **There is one river with every jet on it.** Each player's own game is a normal one-player River Raid. The other jets are see-through ghosts in their players' colors. Helicopters, ships, planes, fuel depots and bridges belong to your game only. You can't hit another player, shoot their enemies or take their fuel.

The ghosts don't need a shared game state, because the river is already shared. River Raid's river is the same in every game (see "Why every player sees the same river"). So a position along the river means the same place for everyone, and a jet's position is all the network carries.

In the code, a match is a room (`src/match/room.js`), and the page and the docs say "match" to players.

## Rules

- **One round, one game each.** A round starts every player's game at once (give or take network latency: each browser counts down 3 seconds from when it receives the start). Each game has the cartridge's usual jets: the first one plus 3 in reserve, and one more for every 10,000 points.
- **Last jet flying ends the round.** A player is out at their game's own game over. When everyone is out, the room ranks the round by score.
- **Top score wins.** Distance doesn't count toward the result. It is shown on the distance bar and decides where ghosts appear.
- **Nobody can hold a round up.**
  - There is no Game Reset and no pause in a match (Enter, P and the gamepad's Start and Back do nothing).
  - A jet left waiting at READY takes off by itself after 5 seconds.
  - The host can end the round at any time; jets still flying keep the score they have.
- **Leaving counts as out.** A player who closes the tab or loses the connection mid-round is ranked with the last score they sent.
- **Late players watch.** Someone who joins during a round sees the match and flies from the next round.
- **Up to 10 players per match**, one per color. The colors are Among Us colors, without blue (it disappears on the river) and yellow (the color of your own jet).

## How it fits together

```
 browser (match.html)                     relay (server/relay.js)
 ┌──────────────────────────────┐         ┌────────────────────────────┐
 │ src/web/match.js             │  ws     │ static files (the site)    │
 │  lobby, countdown, input,    │◄───────►│ /room/ABCD  WebSocket      │
 │  drawing, sound              │  JSON   │   one room per code:       │
 │                              │         │   src/match/room.js        │
 │ src/match/pilot.js           │         └────────────────────────────┘
 │  your game (src/game/)       │                ▲          ▲
 │ src/match/progress.js        │                │          │
 │  distance and score from RAM │          other players' browsers
 │ src/match/ghosts.js          │
 │  other jets on your picture  │
 └──────────────────────────────┘
```

- Every game runs in its own player's browser. The relay never runs a game. It keeps who is in the room, passes positions along and decides when the round is over.
- Each client is the authority on its own game. Nothing a client receives changes its game: ghosts are painted on the picture after the game draws it, so they never reach the collision checks.
- `src/match/` has no DOM, so all of it runs in Node: the tests drive the room, the pilot and the ghosts directly. `src/web/match.js` is the only browser code.

| File | What it does |
| --- | --- |
| `match.html` | The page: canvas, lobby panel, scoreboard, distance bar, touch controls. |
| `src/web/match.js` | The page's loop: joins a match, shows the lobby and results, runs the countdown, feeds input to the pilot, sends positions, draws ghosts and their labels. |
| `src/match/pilot.js` | One pilot's game in a match: RESET at the start, no pause, auto take-off, out at game over, and the position of the jet on screen. |
| `src/match/progress.js` | Reads how far along the river a game is, and its score, from the game's RAM. |
| `src/match/ghosts.js` | Paints the other jets into the picture and returns the labels to draw. |
| `src/match/room.js` | A match's lobby, colors, host, rounds and results. No I/O. |
| `server/relay.js` | The Node server: serves the site and gives each match a WebSocket per player. |

## Why every player sees the same river

The river is built one block at a time (a block is 32 lines; a section, from one bridge to the next, is 32 blocks or 1024 lines). Each new block's shape and enemies come from a 16-bit random number generator (an LFSR, at `$E9`/`$EA`) that steps exactly once per new block. It starts from the same seed in every game. So block number *n* is the same in every game, however fast or slow the jet flew to get there and whenever it took off.

Enemy movement is different: it uses a per-frame random number and the frame counter, so it depends on timing. A helicopter at block *n* is in the same spot when the block appears, but it moves in its own way in each game. That is fine, because enemies are local anyway.

`test/progress.test.js` checks the first claim. It plays 6 games with crashes on purpose and checks that the same block index always has the same look. Two games that take off at different times and fly at different speeds also read the same distance at the same river.

## Distance: where a jet is on the river

`createProgress()` in `src/match/progress.js` returns a function that reads a game's distance in lines from its RAM:

```
distance = (index of the top block - 14) * 32 + blockOffset
```

The top block's index is the hard part, because RAM doesn't hold it. It is recovered from the random number generator:

- The generator's current value is the state right after it built the top block. Stepping it backward until it reaches a known value counts the blocks in between. The seed is known to be the state at block 5, because the start screen's river fills blocks 0 to 5.
- Every value seen is remembered with its index, so each frame steps back only a block or two. It gives up (returns `null`) after 30 steps without a known value, which hasn't happened in the tests.

Reading the generator, rather than counting new blocks as they appear, handles the cases where blocks don't arrive one at a time:

- When a new jet starts, the game builds 9 blocks at once.
- After a crash the jet restarts at the start of a section. That is usually the section of the crash, which takes the jet back. When a section boundary is on screen, the game's LooseJet routine makes it the section before or after, so a crash can also move a jet forward to the next section. Distance follows it in every case (`test/progress.test.js` sees all three).

Score is read from the six score digits the status display uses (`score()` in the same file).

## A round, message by message

All messages are JSON over one WebSocket per player, at `/room/CODE`. The full list is at the top of `src/match/room.js`.

```
 Ana (host)              relay / room                 Bo
    │ hello {name}  ───────►│                           │
    │◄─────── welcome {id}  │                           │
    │◄─────── room {...}    │◄──────────  hello {name}  │
    │◄─────── room {...}    │──────────► welcome, room  │
    │                       │◄──────────  color {lime}  │
    │◄─────── room {...}    │──────────►  room          │
    │ start  ──────────────►│                           │
    │◄── start {delay 3000} │──────────►  start         │
    │      ... 3 s countdown, then both games start ...  │
    │ pos {d,x,...} ───────►│──────────►  pos {id,...}  │  15 a second each way
    │◄──────── pos {id,...} │◄──────────  pos {d,x,...} │
    │                       │◄──────────  out {score}   │  Bo's game over
    │◄─────── room {...}    │──────────►  room          │
    │ out {score} ─────────►│                           │  last jet out
    │◄── room {results}     │──────────►  room {results}│  back to the lobby
```

- **`room`** is the whole room state (`phase`, `host`, `round`, `players`, `results`). `phase` is `lobby` or `playing`. The room sends it to everyone whenever any of it changes, so a client never patches state. It just redraws from the latest one.
- **`pos`** is `{ d, x, shape, reflect, mode, score }`. That is the jet's distance, its x position, which jet shape it shows (straight or banking) and whether it is mirrored, the game mode and the score. It is about 80 bytes. The room forwards it to the other players without re-sending the room state, and keeps the score so that a player who leaves is ranked with it.
- The room ignores messages that don't fit the moment: a `start` from someone who isn't the host, a color that is taken, a `pos` outside a round, and so on.
- The host is the first player to join. When the host leaves, the next player in join order becomes host.

## Drawing the ghosts

`drawGhosts(image, me, ghosts)` paints into the frame's pixels after `drawScreen` and before the frame goes on the canvas.

- **Height.** A ghost is drawn `ghost.d - me.d` lines above your jet, rounded to whole lines. At the same distance it covers your own jet exactly (`test/ghosts.test.js` checks this pixel for pixel, banking either way). Your jet sits at the bottom of the screen, so you see players up to about 430 lines ahead.
- **Shape.** It is drawn with the game's own jet shapes and its own sprite code (`playerPixels`), from the shape and mirror flag in the ghost's `pos`. A banking ghost banks.
- **Look.** It is the player's color, blended 60% over the picture.
- **Labels.**
  - Players on screen get their name above their jet.
  - Players further ahead than the screen shows get a ▲ and their name at the top, over their x position.
  - Players behind you are stacked in the bottom-left corner with a ▼, clear of your jet.
- **When ghosts are hidden.** They are not drawn while the river scrolls in for a new jet (game modes 49 to 127), either yours or theirs, because the jet isn't on its river yet. Out players' ghosts are removed.

### Smoothing

Positions arrive 15 times a second, while the river scrolls up to 2 lines a frame. A ghost drawn only where its last position said would jump up to 8 lines at a time. Between positions, `match.js` moves each ghost on at the speed its last two positions give. The speed is capped at 2 lines a frame and the ghost is moved on for at most 8 frames, so a lost or late packet doesn't send it away. While the ghost's own jet is exploding, it isn't moved on.

### The jet on screen, not the jet in RAM

The game draws the screen at the start of each frame and moves the jet after. So the picture always shows the jet as the frame found it. `pilot.js` reads the jet's position before each frame runs, and sends that one, so a ghost lines up with the picture its player sees.

## Running it

- `pnpm run match` starts the relay on `127.0.0.1:8080`. `PORT` and `HOST` change that (`HOST=0.0.0.0` to reach it from other machines on the network).
- The relay serves the site too, so the page and its WebSocket share one origin. The page uses `wss://` when it was loaded over HTTPS.
- `match.html?relay=wss://host` points the page at another relay. This is how a copy of the page on GitHub Pages, which only serves files, would reach one.
- `match.html?match=ABCD` fills in the match code. The share link is that URL.
- Rooms live in the relay's memory. A room is made on the first join and dropped when its last player leaves. Messages over 1 KB close the connection.

### Playing with people elsewhere

GitHub Pages can't run the relay, so a game with remote teammates needs it somewhere they can reach. None of these are set up yet:

1. **A tunnel to your machine** (for example `cloudflared tunnel --url http://127.0.0.1:8080`). The quickest way, with no code change, as long as the tunnel passes WebSocket upgrades. It is up only while your machine runs it.
2. **`server/relay.js` on a Node host.** It is a single process with no database.
3. **A port of the room to Cloudflare Durable Objects or PartyKit.** One room per object fits that model; `room.js` has no I/O, so it would move as is. This is the most work, for an always-on relay.

## Tests

`pnpm run check` runs them with the rest of the suite.

| Test | What it checks |
| --- | --- |
| `test/progress.test.js` | The same distance is the same river in every game, across crashes and restarts in the section before, the same or the next. A crash away from a section boundary takes the jet back. Different take-off times read the same distance at the same river. The score decoder. |
| `test/room.test.js` | Joining, names, colors, host hand-over, start, positions to the others only, ending when the last jet is out, the host ending a round, leaving mid-round, late players watching, ignored messages. |
| `test/relay.test.js` | Two players play a match through a real relay over WebSockets; a leave counts as out; rooms with different codes stay apart; the static server hides dotfiles, `node_modules` and paths outside the site. |
| `test/ghosts.test.js` | A ghost at your distance covers your own jet pixel for pixel; one further ahead is that many lines higher; distances between lines paint the nearest line; off-screen ghosts get edge markers; no ghosts during the scroll-in. |
| `test/pilot.test.js` | Nothing runs before the round; auto take-off after exactly 5 seconds at READY; fire takes off at once; the position is the jet on screen; game over ends the game and the next round starts a new one. |

The page itself was checked by driving headless Chrome tabs through the relay: a round with two players (lobby, color pick, countdown, ghosts and labels on both screens, live scores, the host ending the round, results), a rematch, a third player joining mid-round, and a round that ended by itself when both games ran out of jets. That script isn't part of the repo.

## Known gaps

- **A hidden tab freezes its game.** Browsers stop animation frames in background tabs, so a player who switches tabs stops flying and stops sending positions. The round waits for them until they come back or the host ends it.
- **No reconnect.** A dropped player is out for the round. Joining again makes them a new player who watches until the next round.
- **Scores are trusted.** Each client reports its own score, so a modified client could send any number. Fine among teammates; a public game would need the relay to check or replay games.
- **Ties** rank players still in the match in join order, then players who left.
- **The bottom of the river after a respawn is partly unchecked.** A one-off check (not in the repo) compared about 28,000 blocks on screen with other games' blocks at the same distance, with no differences. Two cases had nothing reliable to compare:
  - Blocks 0 and 1 in the games that reached later sections, because the test pilot rewrites them to stay alive.
  - Blocks 0 to 9 after a respawn in the first section, because no other game recorded that stretch.

  Ghosts are hidden during the scroll-in (about 80 frames), but they are drawn at READY, which can last up to 5 seconds. If those bottom blocks did differ between games, a ghost near the bottom at READY could look like it sits on a bank. It can't hit anything either way.
- **The relay has no limits** beyond the 1 KB message size and 10 players per match: no rate limits, no auth, and any match code can be joined by anyone who knows it.
