// The match page (match.html): join a match (a room on the relay,
// server/relay.js), pick a color, and when the host starts a round everyone
// flies their own game of River Raid at once. Your river, enemies and
// collisions are yours alone; the other players are see-through jets drawn on
// top (src/match/ghosts.js). The round lasts until the last jet is out, and
// the top score wins.
//
// The relay is the page's own server, or ?relay=wss://host for another one.

import { SCREEN_WIDTH, SCREEN_LINES, drawScreen } from '../game/screen.js';
import { KERNEL_LINES } from '../game/river-raid.js';
import { createPilot } from '../match/pilot.js';
import { drawGhosts, COLOR_RGB } from '../match/ghosts.js';
import { COLORS } from '../match/room.js';
import { createTiaAudio } from './audio.js';
import { readGamepad } from './gamepad.js';
import { createFrameClock } from './frame-clock.js';

const KEYS = {
  ArrowRight: 'right', KeyD: 'right', ArrowLeft: 'left', KeyA: 'left',
  ArrowDown: 'down', KeyS: 'down', ArrowUp: 'up', KeyW: 'up', Space: 'fire', KeyZ: 'fire',
};
const POS_EVERY = 4; // frames between positions sent: 15 a second
const AHEAD_FRAMES = 8; // a ghost is moved on at its last speed for at most this long
const NAME_KEY = 'riverraid-match-name';
const CODE = /^[A-Z]{4}$/;

const hex = (rgb) => `#${rgb.toString(16).padStart(6, '0')}`;
const colorOf = (name) => hex(COLOR_RGB[name] ?? 0xffffff);

function remembered() {
  try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
}
function remember(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* private window: the name is asked again */ }
}

function relayUrl(code) {
  const relay = new URLSearchParams(location.search).get('relay');
  const base = relay || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  return `${base.replace(/\/$/, '')}/room/${code}`;
}

const newCode = () => Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

export function mountMatch(root) {
  const $ = (selector) => root.querySelector(selector);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const joinForm = $('[data-join]');
  const nameInput = $('[data-name]');
  const codeInput = $('[data-code]');
  const roomPanel = $('[data-room]');
  const playerList = $('[data-players]');
  const colorPicker = $('[data-colors]');
  const startButton = $('[data-start]');
  const endButton = $('[data-end]');
  const results = $('[data-results]');
  const resultsList = $('[data-results-list]');
  const lobbyHint = $('[data-lobby-hint]');
  const hint = $('[data-hint]');
  const countdown = $('[data-countdown]');
  const poster = $('[data-poster]');
  const muteButton = $('[data-mute]');
  const track = $('[data-track]');

  const pilot = createPilot();
  const audio = createTiaAudio(new URL('./tia-sound.worklet.js', import.meta.url).href);
  const screen = document.createElement('canvas');
  screen.width = SCREEN_WIDTH;
  screen.height = SCREEN_LINES;
  const screenCtx = screen.getContext('2d');
  const image = screenCtx.createImageData(SCREEN_WIDTH, SCREEN_LINES);
  const tick = createFrameClock();
  const held = new Set();

  let socket = null, me = null, room = null;
  let playing = false, sentOut = false, startAt = 0, frameNo = 0, muted = false, dirty = false;
  const ghosts = new Map(); // id -> { d, x, shape, reflect, mode, score, at, speed }

  nameInput.value = remembered();
  const linked = new URLSearchParams(location.search).get('match')?.toUpperCase();
  if (linked && CODE.test(linked)) codeInput.value = linked;

  const setHint = (text) => { hint.textContent = text; };
  const send = (message) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const player = (id) => room?.players.find((p) => p.id === id);
  const silence = () => audio.setSilent(muted || !playing);

  // *** the room ***

  function connect(code) {
    const name = nameInput.value.trim();
    remember(name);
    audio.start(); // the click is the gesture browsers want before sound
    socket?.close();
    const ws = new WebSocket(relayUrl(code));
    socket = ws;
    setHint('Connecting…');
    ws.addEventListener('open', () => send({ t: 'hello', name }));
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      receive(message, code);
    });
    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      socket = null;
      stopPlaying();
      roomPanel.hidden = true;
      joinForm.hidden = false;
      lobbyHint.textContent = '';
      setHint(me === null ? 'Could not reach the match relay.' : 'Connection lost. Join again to fly the next round.');
      me = null;
    });
  }

  function receive(message, code) {
    if (message.t === 'welcome') {
      me = message.id;
      joinForm.hidden = true;
      roomPanel.hidden = false;
      $('[data-room-code]').textContent = code;
      const url = new URL(location.href);
      url.searchParams.set('match', code);
      history.replaceState(null, '', url);
      $('[data-share]').value = url.href;
      setHint('You are in. The host starts the round.');
    } else if (message.t === 'room') {
      const wasPlaying = room?.phase === 'playing';
      room = message;
      if (wasPlaying && room.phase === 'lobby') stopPlaying();
      for (const id of ghosts.keys()) if (player(id)?.state !== 'flying') ghosts.delete(id);
      showRoom();
    } else if (message.t === 'start') {
      ghosts.clear();
      startAt = performance.now() + message.delay;
      playing = false;
      poster.hidden = true;
      countdown.hidden = false;
      canvas.focus({ preventScroll: true });
    } else if (message.t === 'pos') {
      follow(message);
    } else if (message.t === 'error') {
      setHint(message.reason);
    }
  }

  // a ghost moves on at its last speed until the next position comes
  function follow({ id, d, x, shape, reflect, mode, score }) {
    const last = ghosts.get(id);
    let speed = 0;
    if (last && d !== null && last.d !== null && mode < 0x80 && last.mode < 0x80 && frameNo > last.at) {
      speed = Math.min(2, Math.max(0, (d - last.d) / (frameNo - last.at)));
    }
    ghosts.set(id, { d, x, shape, reflect, mode, score, at: frameNo, speed });
  }

  function showRoom() {
    const host = room.host === me;
    const mine = player(me);
    playerList.replaceChildren(...room.players.map((p) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="swatch"></span><span class="who"></span><span class="what"></span>';
      li.querySelector('.swatch').style.background = colorOf(p.color);
      li.querySelector('.who').textContent = `${p.name}${p.id === me ? ' (you)' : ''}${p.id === room.host ? ' ★' : ''}`;
      li.querySelector('.what').dataset.id = p.id;
      li.querySelector('.what').textContent = { lobby: '', flying: 'flying', out: 'out', watching: 'next round' }[p.state];
      return li;
    }));
    const taken = new Set(room.players.map((p) => p.color));
    colorPicker.replaceChildren(...COLORS.map((color) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.style.background = colorOf(color);
      button.title = color;
      button.setAttribute('aria-label', color);
      button.setAttribute('aria-pressed', String(mine?.color === color));
      button.disabled = room.phase !== 'lobby' || (taken.has(color) && mine?.color !== color);
      button.addEventListener('click', () => send({ t: 'color', color }));
      return button;
    }));
    startButton.hidden = !host || room.phase !== 'lobby';
    startButton.textContent = room.results ? 'Fly again' : 'Start the round';
    endButton.hidden = !host || room.phase !== 'playing';
    if (room.phase === 'playing') {
      lobbyHint.textContent = mine?.state === 'watching' ? 'A round is on. You fly the next one.' : 'Last jet flying ends the round. Top score wins.';
    } else {
      lobbyHint.textContent = host ? 'Start when everyone is in. Share the link to invite.' : 'Waiting for the host to start.';
    }
    results.hidden = !room.results;
    if (room.results) {
      resultsList.replaceChildren(...room.results.map((r) => {
        const li = document.createElement('li');
        li.innerHTML = '<span class="swatch"></span><span class="who"></span><span class="what"></span>';
        li.querySelector('.swatch').style.background = colorOf(r.color);
        li.querySelector('.who').textContent = `${r.name}${r.id === me ? ' (you)' : ''}`;
        li.querySelector('.what').textContent = r.score.toLocaleString('en-US');
        return li;
      }));
    }
  }

  // *** the round ***

  function stopPlaying() {
    playing = false;
    countdown.hidden = true;
    startAt = 0;
    held.clear();
    silence();
    if (room?.results) setHint('Round over. The host can start the next one.');
  }

  function beginFlying() {
    startAt = 0;
    countdown.hidden = true;
    playing = true;
    sentOut = false;
    frameNo = 0;
    pilot.start();
    silence();
    setHint('Arrows or WASD fly, Space or Z fires, M mutes. A jet left at READY takes off by itself.');
  }

  function step() {
    const pad = readGamepad();
    const on = (control) => held.has(control) || !!pad?.[control];
    pilot.step({ up: on('up'), down: on('down'), left: on('left'), right: on('right'), fire: on('fire') });
    frameNo += 1;
    dirty = true;
    audio.update(pilot.io.audio);
    if (pilot.over) {
      if (!sentOut) {
        sentOut = true;
        send({ t: 'out', score: pilot.score });
        setHint(`Game over: ${pilot.score.toLocaleString('en-US')} points. Waiting for the last jet.`);
      }
      audio.setSilent(true);
      return;
    }
    if (frameNo % POS_EVERY === 0) send({ t: 'pos', ...pilot.position() });
  }

  // the other players where they are now, by their last position and speed
  function ghostsNow() {
    return [...ghosts].map(([id, g]) => ({
      ...g, id, color: player(id)?.color, d: g.d === null ? null : g.d + g.speed * Math.min(AHEAD_FRAMES, frameNo - g.at),
    }));
  }

  function draw() {
    const display = pilot.display;
    if (!display) return;
    drawScreen(display, pilot.io, image);
    const position = pilot.position();
    const labels = pilot.over ? [] : drawGhosts(image, { d: position.d, mode: position.mode }, ghostsNow());
    screenCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(screen, 0, 0, canvas.width, canvas.height);
    drawLabels(labels);
    drawTrack(position);
  }

  // Names over the ghosts, and arrows on the edge for the ones off screen:
  // over their x at the top, stacked in the corner at the bottom, clear of
  // your jet.
  function drawLabels(labels) {
    const sx = canvas.width / SCREEN_WIDTH, sy = canvas.height / SCREEN_LINES;
    ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    let behind = 0;
    for (const label of labels) {
      const p = player(label.ghost.id);
      if (!p) continue;
      let text = p.name, x = Math.min(canvas.width - 60, Math.max(60, (label.x + 4) * sx)), y;
      ctx.textAlign = 'center';
      if (label.edge === 'top') { text = `▲ ${p.name}`; y = 28; }
      else if (label.edge === 'bottom') {
        text = `▼ ${p.name}`;
        x = 8 * sx + 10;
        y = KERNEL_LINES * sy - 12 - 26 * behind;
        behind += 1;
        ctx.textAlign = 'left';
      } else y = Math.max(24, label.line * sy - 8);
      ctx.strokeStyle = p.color === 'black' ? '#fff' : '#000';
      ctx.fillStyle = colorOf(p.color);
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
  }

  // how far everyone is, as dots on a line from the start to the leader
  function drawTrack(position) {
    if (!room) return;
    const flying = room.players.filter((p) => p.state === 'flying' || p.state === 'out');
    const at = (p) => (p.id === me ? position.d : ghostsNow().find((g) => g.id === p.id)?.d) ?? 0;
    const far = Math.max(1, ...flying.map(at));
    track.replaceChildren(...flying.map((p) => {
      const dot = document.createElement('span');
      dot.className = p.id === me ? 'dot me' : 'dot';
      dot.style.left = `${(100 * at(p)) / far}%`;
      dot.style.background = p.id === me ? 'var(--lp-accent)' : colorOf(p.color);
      dot.title = p.name;
      return dot;
    }));
    for (const what of playerList.querySelectorAll('.what')) {
      const p = player(Number(what.dataset.id));
      if (p?.state !== 'flying') continue;
      const points = p.id === me ? pilot.score : ghosts.get(p.id)?.score ?? 0;
      what.textContent = points.toLocaleString('en-US');
    }
  }

  function frame(t) {
    if (startAt) {
      const left = startAt - t;
      if (left <= 0) beginFlying();
      else countdown.textContent = String(Math.ceil(left / 1000));
    }
    const frames = tick(t, playing && !document.hidden);
    for (let i = 0; i < frames; i += 1) step();
    if (dirty) { draw(); dirty = false; }
    requestAnimationFrame(frame);
  }

  function toggleMute() {
    muted = !muted;
    muteButton.textContent = muted ? 'Sound on' : 'Mute';
    muteButton.setAttribute('aria-pressed', String(muted));
    silence();
  }

  // *** input ***

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = event.submitter?.dataset.create !== undefined ? newCode() : codeInput.value.trim().toUpperCase();
    if (!CODE.test(code)) { setHint('A match code is four letters.'); codeInput.focus(); return; }
    codeInput.value = code;
    connect(code);
  });
  startButton.addEventListener('click', () => send({ t: 'start' }));
  endButton.addEventListener('click', () => send({ t: 'end' }));
  muteButton.addEventListener('click', toggleMute);
  $('[data-copy]').addEventListener('click', () => navigator.clipboard?.writeText($('[data-share]').value));

  // no Enter (Game Reset) and no P (pause) in a match
  canvas.addEventListener('keydown', (event) => {
    const control = KEYS[event.code];
    if (control) { event.preventDefault(); held.add(control); }
    if (event.code === 'KeyM') toggleMute();
  });
  canvas.addEventListener('keyup', (event) => { const control = KEYS[event.code]; if (control) held.delete(control); });
  canvas.addEventListener('blur', () => held.clear());
  canvas.addEventListener('contextrestored', () => { dirty = true; });

  root.querySelectorAll('[data-hold]').forEach((button) => {
    const control = button.dataset.hold;
    const down = (event) => {
      event.preventDefault();
      held.add(control);
      try { button.setPointerCapture(event.pointerId); } catch { /* finger already lifted: the press still counts */ }
    };
    const up = () => held.delete(control);
    button.addEventListener('pointerdown', down);
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
    button.addEventListener('lostpointercapture', up);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.suspend();
    else audio.resume();
  });

  requestAnimationFrame(frame);
}
