// A race room: the lobby, the round and its results. Every player's game runs
// in their own browser; the room only keeps who is in it, relays where each
// jet is, and decides when the round is over. No I/O: the relay feeds it
// messages and delivers what it sends, and the tests drive it directly.
//
// Client to room:
//   { t: 'hello', name }            first message: join the room
//   { t: 'color', color }           pick a free color
//   { t: 'start' }                  host, in the lobby: start a round
//   { t: 'pos', d, x, shape, reflect, mode, score }   the jet, many times a second
//   { t: 'out', score }             my game is over
//   { t: 'end' }                    host: end the round now
// Room to client:
//   { t: 'welcome', id }            your player id
//   { t: 'room', phase, host, round, players, results }   whenever any of it changes
//   { t: 'start', round, delay }    a round starts in `delay` ms
//   { t: 'pos', id, ... }           another player's jet
//   { t: 'error', reason }

// Among Us colors that stay readable over the river's blue and green
export const COLORS = Object.freeze(['red', 'blue', 'green', 'pink', 'orange', 'yellow', 'white', 'purple', 'cyan', 'lime']);
export const COUNTDOWN_MS = 3000;
const NAME_LENGTH = 12;

// send(id, message) delivers to one player
export function createRoom(send) {
  const players = new Map(); // id -> { id, name, color, state, score }, in join order
  let phase = 'lobby', host = null, round = 0, results = null;
  let left = []; // this round's racers who disconnected, ranked with their last score

  const others = (id) => [...players.values()].filter((p) => p.id !== id);
  const broadcast = (message, except) => { for (const p of others(except)) send(p.id, message); };
  const racers = () => [...[...players.values()].filter((p) => p.state === 'flying' || p.state === 'out'), ...left];
  const freeColor = () => COLORS.find((c) => ![...players.values()].some((p) => p.color === c));

  function announce() {
    const list = [...players.values()].map(({ id, name, color, state, score }) => ({ id, name, color, state, score }));
    broadcast({ t: 'room', phase, host, round, players: list, results });
  }

  function finishIfDone() {
    if (phase !== 'race' || racers().some((p) => p.state === 'flying')) return;
    results = racers()
      .map(({ id, name, color, score }) => ({ id, name, color, score }))
      .sort((a, b) => b.score - a.score);
    phase = 'lobby';
    for (const p of players.values()) p.state = 'lobby';
  }

  const handlers = {
    color(p, { color }) {
      if (phase !== 'lobby' || !COLORS.includes(color)) return;
      if ([...players.values()].some((o) => o.color === color)) return;
      p.color = color;
    },
    start(p) {
      if (p.id !== host || phase !== 'lobby') return;
      phase = 'race';
      round += 1;
      results = null;
      left = [];
      for (const o of players.values()) { o.state = 'flying'; o.score = 0; }
      broadcast({ t: 'start', round, delay: COUNTDOWN_MS });
    },
    pos(p, message) {
      if (phase !== 'race' || p.state !== 'flying') return;
      const { d, x, shape, reflect, mode } = message;
      p.score = Number(message.score) || 0;
      broadcast({ t: 'pos', id: p.id, d, x, shape, reflect, mode, score: p.score }, p.id);
      return 'quiet'; // too frequent to re-announce the room
    },
    out(p, { score }) {
      if (phase !== 'race' || p.state !== 'flying') return;
      p.state = 'out';
      p.score = Number(score) || p.score;
      finishIfDone();
    },
    end(p) {
      if (p.id !== host || phase !== 'race') return;
      for (const o of players.values()) if (o.state === 'flying') o.state = 'out';
      finishIfDone();
    },
  };

  return {
    // a new connection with a new id; returns false when the room is full
    join(id, hello) {
      const color = freeColor();
      if (!color || players.has(id)) return false;
      const name = String(hello?.name ?? '').trim().slice(0, NAME_LENGTH) || `Pilot ${id}`;
      // joining mid-round: watch, and fly from the next round
      players.set(id, { id, name, color, state: phase === 'race' ? 'watching' : 'lobby', score: 0 });
      host ??= id;
      send(id, { t: 'welcome', id });
      announce();
      return true;
    },
    // a closed connection: the player is out with the last score they sent
    leave(id) {
      const p = players.get(id);
      if (!p) return;
      players.delete(id);
      if (phase === 'race' && p.state !== 'watching') left.push({ ...p, state: 'out' });
      if (host === id) host = players.keys().next().value ?? null;
      finishIfDone();
      announce();
    },
    message(id, message) {
      const p = players.get(id);
      const handler = p && handlers[message?.t];
      if (!handler) return;
      if (handler(p, message) !== 'quiet') announce();
    },
    get size() { return players.size; },
  };
}
