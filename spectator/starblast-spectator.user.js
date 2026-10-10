// ==UserScript==
// @name         Starblast Spectator
// @namespace    zyrvaen-starblast-spectator
// @version      1.0.0
// @description  Watch the whole map in Starblast: every player, free camera, smooth movement.
// @author       Zyrvaen
// @license      MIT
// @match        https://starblast.io/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @sandbox      raw
// ==/UserScript==

/*
 * Starblast Spectator by Zyrvaen
 *
 *   ] or F8   spectate          [ or F9   overview map
 *   L         live / smooth     F7        share room
 *   Scroll to zoom, right-drag to move, click a ship or name to follow, Esc to stop.
 *
 * Game internals are found by readable names or code patterns, never by the
 * obfuscated names, because those change with every Starblast update.
 */
(function () {
  'use strict';

  const TAN = Math.tan((22.5 * Math.PI) / 180); // half fov of the game camera (45°)
  const BASE_Z = 70;                             // camera height used by the game
  const now = () => performance.now();

  // ================================================================== state
  const S = {
    ws: null, welcome: null, seed: null, modeId: null, teams: [],
    mapSize: 0, world: 0,  // cells per axis / units per axis (= mapSize · 10)
    myId: null,
    players: new Map(),    // id → player
    rocks: new Map(),      // "cx,cy" → respawn time (server seconds)
    field: null,           // generated rocks [{cx, cy, x, y, size}]
    tickBase: null, tickAt: 0, tickGuess: false,
    effects: [],           // test-map rings
    survival: false,
    live: true,            // LIVE (predicted) or SMOOTH (1.25 s behind)
  };
  try { if (localStorage.getItem('sbspec-live2') === '0') S.live = false; } catch (e) { /* ignore */ }
  window.SBSpec = S;

  const serverTick = () => (S.tickBase == null ? null : S.tickBase + (Date.now() - S.tickAt) * 0.06);

  function player(id) {
    if (!S.players.has(id)) {
      S.players.set(id, { id, name: '', hue: 0, team: null, code: 101, score: 0, rank: 0, alive: false,
        samples: [], exact: null, known: null, heading: 0, blend: null, wasExact: false, askedName: 0 });
    }
    return S.players.get(id);
  }

  // The map is a torus.
  function wrapDelta(d) { const W = S.world || 1; d = ((d % W) + W) % W; return d > W / 2 ? d - W : d; }
  function wrapPos(v) { const W = S.world || 1, h = W / 2; return ((((v + h) % W) + W) % W) - h; }
  function angleLerp(a, b, k) {
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return a + d * k;
  }
  const first = (a) => (Array.isArray(a) ? a[0] : a);

  // ======================================================== websocket hook
  const NativeWS = window.WebSocket;
  window.WebSocket = class extends NativeWS {
    constructor(url, protocols) {
      super(url, protocols);
      if (/starblast\.io:\d+/.test(String(url))) attach(this);
    }
  };

  function attach(ws) {
    if (SP.active) exitSpectator();
    Object.assign(S, { ws, myId: null, tickBase: null, effects: [] });
    S.players.clear();
    S.rocks.clear();
    SP.loaded = false;
    ws.addEventListener('message', (ev) => {
      if (ws !== S.ws) return;
      const d = ev.data;
      const bin = (b) => { onBinary(new DataView(b)); shareFromServer(b); };
      if (typeof d === 'string') onText(d);
      else if (d instanceof ArrayBuffer) bin(d);
      else if (d && d.arrayBuffer) d.arrayBuffer().then(bin);
    });
  }

  // Hand a message to the game as if the server sent it (the client accepts
  // anything with an arrayBuffer() method).
  function inject(buf) {
    if (!S.ws || typeof S.ws.onmessage !== 'function') return false;
    S.ws.onmessage({ data: { arrayBuffer: () => Promise.resolve(buf) } });
    return true;
  }

  function sendJSON(obj) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); }

  function onText(txt) {
    if (txt[0] !== '{') return;
    let m;
    try { m = JSON.parse(txt); } catch (e) { return; }
    const d = m.data;
    if (m.name === 'welcome') {
      const mode = d.mode || {};
      Object.assign(S, {
        welcome: d, seed: d.seed, modeId: mode.id || null, teams: mode.teams || [],
        world: d.size || mode.map_size * 10 || 0, survival: false, field: null,
      });
      S.mapSize = mode.map_size || S.world / 10;
      // rough guess until the first ship packet arrives (off by up to a minute)
      if (d.servertime != null) Object.assign(S, { tickBase: d.servertime * 0.06, tickAt: Date.now(), tickGuess: true });
    } else if (m.name === 'entered') {
      S.myId = d.shipid;
      if (!S.hinted) { S.hinted = true; setTimeout(() => toast('Spectator ready. Press ] or F8'), 1500); }
    } else if (m.name === 'player_name') {
      Object.assign(player(d.id), { name: d.player_name, hue: d.hue, team: d.friendly });
    }
  }

  function onBinary(v) {
    const op = v.getUint8(0);
    if (op === 255) { // bundle: [length][message] repeated (same as the game's own handler)
      for (let o = 1; o < v.byteLength;) {
        const len = v.getUint8(o++);
        if (len) onBinary(new DataView(v.buffer, v.byteOffset + o, Math.min(len, v.byteLength - o)));
        o += len;
      }
      return;
    }
    if (op === 0) onShipStatus(v);
    else if (op === 200 || op === 201) { S.survival = op === 201; onScoreboard(v); }
    else if (op === 110) { // rock destroyed (whole map)
      const r = rockAt(v.getInt8(2), v.getInt8(3));
      S.rocks.set(v.getInt8(2) + ',' + v.getInt8(3), v.getUint32(4, true));
      if (r) { S.effects.push({ kind: 'rock', x: r.x, y: r.y, t: now() }); fxRockDestroyed(r, v.getUint8(8)); }
    } else if (op === 210) { // destroyed rocks on join
      const base = v.getUint32(1, true);
      for (let o = 5; o + 2 < v.byteLength; o += 3) S.rocks.set(v.getInt8(o) + ',' + v.getInt8(o + 1), base + v.getUint8(o + 2));
    } else if (op === 240) { // emoji/chat: the game itself draws the bubble on the ship (also on our far ships)
      let text = '';
      for (let i = 2; i < v.byteLength; i++) text += String.fromCharCode(v.getUint8(i));
      const p = player(v.getUint8(1));
      p.say = { text, at: now() };
      S.says = (S.says || 0) + 1;
      if (!exactFresh(p, now()) && p.id !== S.myId) S.farSays = (S.farSays || 0) + 1;
    } else if (op === 150) { // kill (whole map)
      const victim = player(v.getUint8(1));
      const pos = renderPos(victim);
      if (pos) {
        fxKill(victim, pos, v.getUint8(2)); // before alive=false: needs the old data
        S.effects.push({ kind: 'kill', x: pos.x, y: pos.y, t: now() });
      }
      victim.alive = false;
      victim.known = null;
    }
  }

  function onShipStatus(v, remote) {
    const tick = v.getUint32(8, true);
    const est = serverTick();
    if (est == null || S.tickGuess || tick > est - 2) Object.assign(S, { tickBase: tick, tickAt: Date.now(), tickGuess: false });
    const p = player(v.getUint8(1));
    const flags = v.getUint8(2);
    const e = p.exact = {
      at: now(), tick,
      x: v.getFloat32(16, true), y: v.getFloat32(20, true),
      vx: v.getFloat32(24, true), vy: v.getFloat32(28, true), r: v.getFloat32(32, true),
      alive: (flags & 1) > 0, lives: (flags >> 2) & 7, type: v.getUint16(14, true) & 1023,
      shield: v.getUint16(42, true), generator: v.getUint16(44, true), gems: v.getUint16(46, true),
      score: v.getUint32(48, true), levels: v.getUint32(52, true),
    };
    Object.assign(p, { code: e.type, alive: e.alive, score: e.score, heading: e.r, wasExact: true, blend: null });
    if (!remote) p.localAt = e.at; // our own server stream has this ship (the game draws it itself)
    // "last seen" values survive when the ship leaves our bubble
    p.known = { shield: e.shield, gems: e.gems, generator: e.generator, levels: e.levels, lives: e.lives, code: e.type, at: Date.now() };
  }

  function onScoreboard(v) {
    const half = S.world / 2, t = now(), seen = new Set();
    for (let i = 0, n = v.getUint8(1); i < n; i++) {
      const o = 2 + 8 * i, id = v.getUint8(o), p = player(id);
      const flags = v.getUint8(o + 3), w = v.getUint32(o + 4, true), alive = (flags & 1) > 0;
      seen.add(id);
      if (alive && !p.alive) p.samples = []; // respawned: don't draw a line from the old spot
      Object.assign(p, { alive, rank: i, score: w & 0xffffff, code: 100 * (1 + ((flags >> 5) & 7)) + 1 + (w >>> 24) });
      // the server rounds DOWN (measured): +0.5 = centre of the cell
      p.samples.push({ t, x: ((v.getInt8(o + 1) + 0.5) / 128) * half, y: ((v.getInt8(o + 2) + 0.5) / 128) * half });
      if (p.samples.length > 8) p.samples.shift();
      if (!p.name && Date.now() - p.askedName > 5000) { p.askedName = Date.now(); sendJSON({ name: 'get_name', data: { id } }); }
    }
    for (const id of S.players.keys()) if (!seen.has(id) && id !== S.myId) S.players.delete(id);
  }

  // ============================================================ positions
  // Far players only come from the radar: 1×/s, ±1.25 units. Two ways to fill the gaps:
  //   SMOOTH: Catmull-Rom curve, BOARD_DELAY behind (fluid, ~22 units behind)
  //   LIVE:   predict from the last 2 points + critically damped spring (~7 units off, no delay)
  const BOARD_DELAY = 1250;
  const SMOOTH_MS = 90;
  const EXACT_MS = 1000;      // exact packets can pause ~1 s; let the game extrapolate meanwhile
  const LIVE_MAX_AHEAD = 1.5; // s
  const LIVE_SPRING_HZ = 0.8;

  const exactFresh = (p, t) => !!p.exact && t - p.exact.at < EXACT_MS;

  function exactState(p, t) {
    const e = p.exact, dt = (t - e.at) * 0.06;
    return { x: wrapPos(e.x + e.vx * dt), y: wrapPos(e.y + e.vy * dt), vx: e.vx, vy: e.vy, exact: true };
  }

  function boardState(p, t) {
    const s = p.samples;
    if (!s.length) return null;
    const rt = t - BOARD_DELAY;
    let i = s.length - 2;
    while (i >= 0 && s[i].t > rt) i--;
    if (i < 0) return { x: s[0].x, y: s[0].y, vx: 0, vy: 0 };
    const P1 = s[i], P2 = s[i + 1];
    // Missing neighbours continue in the same direction (P3 = P2 would brake every segment).
    const P0 = s[i - 1] || { x: P1.x - wrapDelta(P2.x - P1.x), y: P1.y - wrapDelta(P2.y - P1.y) };
    const P3 = s[i + 2] || { x: P2.x + wrapDelta(P2.x - P1.x), y: P2.y + wrapDelta(P2.y - P1.y) };
    const X = [P0, P1, P2, P3].map((q) => P1.x + wrapDelta(q.x - P1.x)); // unwrap around P1
    const Y = [P0, P1, P2, P3].map((q) => P1.y + wrapDelta(q.y - P1.y));
    const dt = Math.max(1, P2.t - P1.t);
    let u = (rt - P1.t) / dt, extra = 0;
    if (u > 1) { extra = Math.min(u - 1, 0.5); u = 1; } // late packet: extrapolate briefly
    const cr = ([a, b, c, d]) => 0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (3 * b - a - 3 * c + d) * u * u * u);
    const dcr = ([a, b, c, d]) => 0.5 * ((c - a) + 2 * (2 * a - 5 * b + 4 * c - d) * u + 3 * (3 * b - a - 3 * c + d) * u * u);
    const vx = dcr(X), vy = dcr(Y), k = 1000 / 60 / dt;
    return { x: wrapPos(cr(X) + vx * extra), y: wrapPos(cr(Y) + vy * extra), vx: vx * k, vy: vy * k };
  }

  // time-based low-pass (repeat calls with the same t give the same result)
  function smooth(p, b, t) {
    const sm = p.sm;
    if (!sm || t - sm.t > 2000 || Math.abs(wrapDelta(b.x - sm.x)) + Math.abs(wrapDelta(b.y - sm.y)) > 60) {
      p.sm = { x: b.x, y: b.y, t };
      return;
    }
    if (t > sm.t) {
      const k = 1 - Math.exp(-(t - sm.t) / SMOOTH_MS);
      sm.x = wrapPos(sm.x + wrapDelta(b.x - sm.x) * k);
      sm.y = wrapPos(sm.y + wrapDelta(b.y - sm.y) * k);
      sm.t = t;
    }
    b.x = sm.x;
    b.y = sm.y;
  }

  // straight line through the last 2 radar points (units/s), anchored at the last one
  function liveModel(p) {
    const s = p.samples, L = s[s.length - 1], A = s[s.length - 2];
    const dt = A ? (L.t - A.t) / 1000 : 0;
    const vx = dt > 0 ? wrapDelta(L.x - A.x) / dt : 0, vy = dt > 0 ? wrapDelta(L.y - A.y) / dt : 0;
    return { t: L.t, x: L.x, y: L.y, vx, vy };
  }

  function liveState(p, t) {
    if (!p.samples.length) return null;
    const lastT = p.samples[p.samples.length - 1].t;
    if (!p.lv || p.lv.lastT !== lastT) p.lv = { lastT, m: liveModel(p) };
    const m = p.lv.m, age = Math.max(0, Math.min((t - m.t) / 1000, LIVE_MAX_AHEAD));
    const tgt = { x: wrapPos(m.x + m.vx * age), y: wrapPos(m.y + m.vy * age) };
    let z = p.spr;
    if (!z || t - z.t > 500) {
      z = p.spr = { x: tgt.x, y: tgt.y, vx: m.vx, vy: m.vy, t, px: tgt.x, py: tgt.y };
    } else if (t > z.t) {
      const dt = (t - z.t) / 1000;
      // velocity of the target itself (a jump from a new radar point doesn't count)
      let tvx = wrapDelta(tgt.x - z.px) / dt, tvy = wrapDelta(tgt.y - z.py) / dt;
      if (Math.hypot(tvx, tvy) > 300) { tvx = m.vx; tvy = m.vy; }
      z.px = tgt.x; z.py = tgt.y;
      if (Math.abs(wrapDelta(tgt.x - z.x)) + Math.abs(wrapDelta(tgt.y - z.y)) > 80) { // respawn/teleport
        Object.assign(z, { x: tgt.x, y: tgt.y, vx: tvx, vy: tvy });
      } else {
        const w = 2 * Math.PI * LIVE_SPRING_HZ, steps = Math.max(1, Math.ceil(dt / 0.02)), h = dt / steps;
        for (let i = 0; i < steps; i++) {
          z.vx += (w * w * wrapDelta(tgt.x - z.x) + 2 * w * (tvx - z.vx)) * h;
          z.vy += (w * w * wrapDelta(tgt.y - z.y) + 2 * w * (tvy - z.vy)) * h;
          z.x = wrapPos(z.x + z.vx * h);
          z.y = wrapPos(z.y + z.vy * h);
        }
      }
      z.t = t;
    }
    return { x: z.x, y: z.y, vx: z.vx / 60, vy: z.vy / 60 }; // velocity per tick
  }

  // Best estimate of where a player is NOW.
  function renderPos(p, t) {
    t = t || now();
    if (exactFresh(p, t)) {
      const e = exactState(p, t);
      p.sm = { x: e.x, y: e.y, t };
      return e;
    }
    let b;
    if (S.live) b = liveState(p, t);
    else if ((b = boardState(p, t))) smooth(p, b, t);
    if (!b) return null;
    // just left our bubble: blend from the last exact position
    if (p.wasExact && p.exact) {
      const e = exactState(p, Math.min(t, p.exact.at + EXACT_MS));
      p.blend = { dx: wrapDelta(e.x - b.x), dy: wrapDelta(e.y - b.y), at: t };
      p.wasExact = false;
    }
    if (p.blend) {
      const k = 1 - (t - p.blend.at) / 1200;
      if (k <= 0) p.blend = null;
      else { b.x = wrapPos(b.x + p.blend.dx * k); b.y = wrapPos(b.y + p.blend.dy * k); }
    }
    return b;
  }

  // ============================================================== sharing
  // Scripts pass on what the server sends exactly around their OWN ship (raw game
  // messages) to each other: your own tabs via BroadcastChannel (automatic),
  // friends via an encrypted MQTT relay room (F7). The receiver hands a message
  // to the game only for ships/events the game doesn't already have, so the game
  // draws them natively (own physics, lasers, gems). See 30-DATA-DELEN.md.
  const SHARE_OPS = new Set([0, 100, 101, 102, 103, 120, 121, 190, 240]);
  const RELAYS = ['wss://test.mosquitto.org:8081', 'wss://broker.emqx.io:8084/mqtt'];
  const BUBBLE = 115;        // units around our own ship that our server stream covers
  const SHARE_EVERY = 80;    // ms between batches
  const Share = {
    me: (Math.random() * 0xffffffff) >>> 0,
    ships: new Map(), events: [], peers: new Map(), remoteGems: new Set(),
    stats: { sent: 0, received: 0, injected: 0, rejected: 0 },
    room: null, bc: null,
  };
  const Relay = { ws: null, idx: 0, ready: false, key: null, topicBase: null, sub: null, timer: null, backoff: 1000 };

  const localFresh = (p, t) => !!p.localAt && t - p.localAt < EXACT_MS;

  function farFromMe(x, y) {
    const me = S.players.get(S.myId);
    if (!me || !me.exact || !localFresh(me, now())) return true;
    return Math.hypot(wrapDelta(x - me.exact.x), wrapDelta(y - me.exact.y)) > BUBBLE;
  }

  // queue a message from our own server stream for the others
  function shareFromServer(buf) {
    const v = new DataView(buf), op = v.getUint8(0);
    if (op === 255) {
      for (let o = 1; o < v.byteLength;) { const len = v.getUint8(o++); if (len) shareFromServer(buf.slice(o, o + len)); o += len; }
      return;
    }
    if (!SHARE_OPS.has(op)) return;
    if (op === 0) Share.ships.set(v.getUint8(1), buf); // only the latest status per ship
    else if (Share.events.length < 300) Share.events.push(buf);
  }

  // batch: [version 2][systemId u32][sender u32][seq u32][count u16] then [len u16][message]…
  // (seq: the same batch can arrive twice, via tab AND relay → skip duplicates)
  function shareFlush() {
    const sys = S.welcome && S.welcome.systemid;
    const list = [...Share.ships.values(), ...Share.events];
    Share.ships.clear();
    Share.events = [];
    if (sys == null || !list.length) return;
    const out = new Uint8Array(15 + list.reduce((a, b) => a + 2 + b.byteLength, 0)), v = new DataView(out.buffer);
    v.setUint8(0, 2);
    v.setUint32(1, sys >>> 0, true);
    v.setUint32(5, Share.me, true);
    v.setUint32(9, (Share.seq = (Share.seq || 0) + 1), true);
    v.setUint16(13, list.length, true);
    let o = 15;
    for (const b of list) { v.setUint16(o, b.byteLength, true); out.set(new Uint8Array(b), o + 2); o += 2 + b.byteLength; }
    Share.stats.sent++;
    if (Share.bc) Share.bc.postMessage(out.buffer);
    if (Relay.ready) relayPublish(out);
  }

  function shareReceive(buf, via) {
    const v = new DataView(buf);
    if (v.byteLength < 15 || v.getUint8(0) !== 2) return;
    const from = v.getUint32(5, true), seq = v.getUint32(9, true);
    if (from === Share.me || !S.welcome || v.getUint32(1, true) !== S.welcome.systemid >>> 0) return;
    const peer = Share.peers.get(from);
    if (peer && seq <= peer.seq && peer.seq - seq < 1e6) return; // already got this batch (other route)
    if (!peer) toast(via === 'tab' ? 'Sharing with another tab' : 'Sharing with a friend');
    Share.peers.set(from, { at: now(), via: peer && peer.via === 'tab' ? 'tab' : via, seq });
    for (let i = 0, o = 15, n = v.getUint16(13, true); i < n && o + 2 <= v.byteLength; i++) {
      const len = v.getUint16(o, true);
      shareOne(buf.slice(o + 2, o + 2 + len));
      o += 2 + len;
    }
  }

  function shareOne(b) {
    const v = new DataView(b), op = v.getUint8(0), t = now();
    const far = (p) => p.id !== S.myId && !localFresh(p, t);
    let ok = false;
    if (op === 0) {
      const p = player(v.getUint8(1));
      if (!far(p)) return;
      // sanity check against the radar: the ship must be on it, and close to where it says
      const s = p.samples[p.samples.length - 1];
      if (!s || t - s.t > 3000 || Math.hypot(wrapDelta(v.getFloat32(16, true) - s.x), wrapDelta(v.getFloat32(20, true) - s.y)) > 40) { Share.stats.rejected++; return; }
      onShipStatus(v, true);
      ok = true;
    } else if (op === 100) ok = far(player(v.getUint8(1)));
    else if (op === 101) ok = far(player(v.getUint8(12))) && farFromMe(v.getFloat32(4, true), v.getFloat32(8, true));
    else if (op === 103) ok = farFromMe(v.getFloat32(4, true), v.getFloat32(8, true));
    else if (op === 102) ok = farFromMe(v.getFloat32(2, true), v.getFloat32(6, true));
    else if (op === 190) ok = farFromMe(v.getFloat32(3, true), v.getFloat32(7, true));
    else if (op === 120) {
      ok = v.byteLength >= 24 && farFromMe(v.getFloat32(8, true), v.getFloat32(12, true));
      if (ok) {
        if (Share.remoteGems.size > 2000) Share.remoteGems.clear();
        for (let o = 5; o + 19 <= v.byteLength; o += 19) Share.remoteGems.add(v.getUint16(o + 1, true));
      }
    } else if (op === 121) ok = Share.remoteGems.delete(v.getUint16(2, true));
    else if (op === 240) { ok = far(player(v.getUint8(1))); if (ok) onBinary(v); }
    Share.stats.received++;
    if (ok && SP.active) { inject(b); Share.stats.injected++; } // only spectator mode gets the extra view
  }

  // ---- MQTT relay (tiny client: CONNECT, SUBSCRIBE, PUBLISH, PINGREQ; QoS 0)
  const te = typeof TextEncoder === 'function' ? new TextEncoder() : null; // relay is optional
  const mqStr = (str) => { const b = te.encode(str); return [b.length >> 8, b.length & 255, ...b]; };
  function mqPacket(head, body) {
    const len = [];
    let n = body.length;
    do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 128; len.push(d); } while (n);
    const out = new Uint8Array(1 + len.length + body.length);
    out[0] = head;
    out.set(len, 1);
    out.set(body, 1 + len.length);
    return out;
  }
  const sha256 = (str) => crypto.subtle.digest('SHA-256', te.encode(str));
  const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

  async function setShareRoom(room, quiet) {
    room = (room || '').trim();
    Share.room = room || null;
    try { localStorage.setItem('sbspec-room', room); } catch (e) { /* ignore */ }
    relayClose();
    if (!room) { if (!quiet) toast('Share room off'); return; }
    if (!te || !window.crypto || !crypto.subtle) return toast('Share rooms are not supported in this browser');
    Relay.topicBase = 'sbspec/' + hex(await sha256('sbspec-topic:' + room)).slice(0, 24);
    Relay.key = await crypto.subtle.importKey('raw', await sha256('sbspec-key:' + room), 'AES-GCM', false, ['encrypt', 'decrypt']);
    relayConnect();
    if (!quiet) toast('Share room: ' + room);
  }

  function relayConnect() {
    if (!Relay.key) return;
    let ws;
    try { ws = new NativeWS(RELAYS[Relay.idx % RELAYS.length], 'mqtt'); } catch (e) { return relayRetry(); }
    Relay.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(mqPacket(0x10, Uint8Array.from([...mqStr('MQTT'), 4, 2, 0, 30, ...mqStr('sbspec' + Share.me.toString(36))])));
    ws.onmessage = (ev) => relayData(new Uint8Array(ev.data));
    ws.onclose = () => { if (Relay.ws === ws) { Object.assign(Relay, { ws: null, ready: false }); relayRetry(); } };
  }

  function relayRetry() {
    if (!Relay.key) return;
    Relay.idx++;
    clearTimeout(Relay.timer);
    Relay.timer = setTimeout(relayConnect, Relay.backoff);
    Relay.backoff = Math.min(30000, Relay.backoff * 2);
  }

  function relayClose() {
    Object.assign(Relay, { key: null, ready: false, sub: null });
    clearTimeout(Relay.timer);
    const ws = Relay.ws;
    Relay.ws = null;
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
  }

  const relayTopic = () => (S.welcome && Relay.topicBase ? Relay.topicBase + '/' + S.welcome.systemid : null);

  function relaySubscribe() {
    const topic = relayTopic();
    if (!topic || !Relay.ready || Relay.sub === topic) return;
    Relay.sub = topic;
    Relay.ws.send(mqPacket(0x82, Uint8Array.from([0, 1, ...mqStr(topic), 0])));
  }

  async function relayPublish(batch) {
    relaySubscribe();
    const topic = relayTopic(), ws = Relay.ws, key = Relay.key;
    if (!topic || !ws || !key) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, batch));
    const t = mqStr(topic), body = new Uint8Array(t.length + 12 + ct.length);
    body.set(t, 0);
    body.set(iv, t.length);
    body.set(ct, t.length + 12);
    if (ws.readyState === 1) ws.send(mqPacket(0x30, body));
  }

  function relayData(b) {
    for (let o = 0; o < b.length;) {
      const type = b[o] >> 4;
      let i = o + 1, len = 0, mult = 1, d;
      do { d = b[i++]; len += (d & 127) * mult; mult *= 128; } while (d & 128 && i < b.length);
      const body = b.subarray(i, i + len);
      o = i + len;
      if (type === 2) { Object.assign(Relay, { ready: true, backoff: 1000, sub: null }); relaySubscribe(); }
      else if (type === 3 && Relay.key) {
        const p = body.subarray(2 + ((body[0] << 8) | body[1]));
        crypto.subtle.decrypt({ name: 'AES-GCM', iv: p.slice(0, 12) }, Relay.key, p.slice(12))
          .then((buf) => shareReceive(buf, 'relay'), () => { Share.stats.rejected++; });
      }
    }
  }

  function shareSummary() {
    const t = now();
    let tabs = 0, friends = 0;
    for (const [id, p] of Share.peers) {
      if (t - p.at > 3000) Share.peers.delete(id);
      else if (p.via === 'tab') tabs++; else friends++;
    }
    const parts = [];
    if (tabs) parts.push(tabs + (tabs > 1 ? ' tabs' : ' tab'));
    if (Share.room) parts.push(friends + (friends === 1 ? ' friend' : ' friends') + (Relay.ready ? '' : ' (connecting)'));
    return parts.length ? 'sharing with ' + parts.join(', ') : '';
  }

  try {
    Share.bc = new BroadcastChannel('sbspec-share');
    Share.bc.onmessage = (e) => { if (e.data instanceof ArrayBuffer) shareReceive(e.data, 'tab'); };
  } catch (e) { /* no BroadcastChannel */ }
  setInterval(() => { try { shareFlush(); } catch (e) { console.error('[SBSpec] share', e); } }, SHARE_EVERY);
  setInterval(() => { if (Relay.ready && Relay.ws) Relay.ws.send(Uint8Array.from([0xc0, 0])); }, 20000); // keep-alive
  try { const room = localStorage.getItem('sbspec-room'); if (room) setShareRoom(room, true); } catch (e) { /* ignore */ }


  // ======================================================= game internals
  function findClass(test) {
    for (const k of Object.getOwnPropertyNames(window)) {
      try { const v = window[k]; if (typeof v === 'function' && v.prototype && test(v)) return v; } catch (e) { /* skip */ }
    }
    return null;
  }

  function protoFnBySource(cls, needle) {
    for (const k of Object.getOwnPropertyNames(cls.prototype)) {
      const d = Object.getOwnPropertyDescriptor(cls.prototype, k);
      if (d && typeof d.value === 'function' && d.value.toString().includes(needle)) return k;
    }
    return null;
  }

  // wrap a prototype method; fn(orig, self, args)
  function wrapProto(cls, name, fn) {
    const orig = cls.prototype[name];
    cls.prototype[name] = function () { return fn(orig, this, arguments); };
  }

  const G = {
    hooked: false, world: null, camFn: null, camKey: null, tickKey: null,
    Scene: null, scene: null, renderFn: null, sceneCamKey: null, cursor: null,
    game() {
      if (!this.world) return null;
      if (this._gameOf !== this.world) {
        this._game = Object.values(this.world).find((v) => v && v.mode && v.mode.options && v.names) || null;
        this._gameOf = this._game ? this.world : null;
      }
      return this._game;
    },
    cam() { return this.world && this.camKey ? this.world[this.camKey] : null; },
    // the client's tick counter (same clock as the server); found by value
    tick() {
      const w = this.world, est = serverTick();
      if (!w || est == null) return est;
      if (this.tickKey && typeof w[this.tickKey] === 'number' && Math.abs(w[this.tickKey] - est) < 600) return w[this.tickKey];
      let best = null, bd = 600;
      for (const k of Object.keys(w)) {
        const v = w[k];
        if (typeof v === 'number' && Number.isInteger(v) && v > 1000 && Math.abs(v - est) < bd) { bd = Math.abs(v - est); best = k; }
      }
      this.tickKey = best;
      return best ? w[best] : est;
    },
    // { t: ship type (specs, lasers, level, name), m: ship model (radius, zoom) }
    shipType(code) {
      const g = this.game();
      if (!g || !g.mode) return null;
      if (this._typesOf !== g.mode) {
        const vals = Object.values(g.mode);
        this._types = vals.find((v) => v && v.types_by_code);
        this._models = vals.find((v) => v && v.ships_by_code);
        this._typesOf = g.mode;
      }
      const t = this._types && this._types.types_by_code[code], m = this._models && this._models.ships_by_code[code];
      return t || m ? { t, m } : null;
    },
  };

  function installHooks() {
    if (G.hooked) return true;
    if (!window.THREE || !THREE.PerspectiveCamera) return false;
    const World = findClass((c) => typeof c.prototype.initCamera === 'function' && typeof c.prototype.asteroidStatus === 'function');
    G.camFn = World && protoFnBySource(World, '.zoom=.995*'); // runs every tick, after ship physics
    if (!G.camFn) return false;
    G.camKey = (World.prototype[G.camFn].toString().match(/this\.(\w+)\.zoom=\.995\*/) || [])[1];
    wrapProto(World, G.camFn, (orig, self, args) => {
      G.world = self;
      return SP.active ? spectatorTick(self) : orig.apply(self, args);
    });
    // camera height (zoom without distortion), applied right before each projection update
    wrapProto(THREE.PerspectiveCamera, 'updateProjectionMatrix', (orig, cam, args) => {
      if (G.scene && G.sceneCamKey && cam === G.scene[G.sceneCamKey]) {
        const z = SP.active ? SP.z : BASE_Z;
        cam.position.z = z;
        cam.far = Math.max(1000, z + 200);
      }
      return orig.apply(cam, args);
    });
    if (typeof window.Cursor === 'function' && window.Cursor.prototype.set) {
      wrapProto(window.Cursor, 'set', (orig, self, args) => { G.cursor = self; return orig.apply(self, args); });
    }
    G.hooked = true;
    return true;
  }

  // "Scene" is a local variable in the game code, so we reach the instance via
  // the game object (the object holding the rock renderer) and hook its class.
  function installSceneHooks() {
    if (G.Scene) return true;
    const g = G.game();
    const scene = g && Object.values(g).find((v) => v && typeof v === 'object' && Object.values(v).some(isRockRenderer));
    const fn = scene && protoFnBySource(scene.constructor, '.fov=45*this.');
    if (!fn) return false;
    Object.assign(G, {
      Scene: scene.constructor, scene, renderFn: fn,
      sceneCamKey: (scene.constructor.prototype[fn].toString().match(/this\.(\w+)\.fov=45\*this\./) || [])[1],
    });
    wrapProto(G.Scene, fn, (orig, self, args) => { G.scene = self; return orig.apply(self, args); });
    return true;
  }

  // ================================================================ rocks
  const MODE_CLASS = { team: 'TeamMode', survival: 'SurvivalMode', invasion: 'InvasionMode',
    deathmatch: 'DeathMatchMode', battleroyale: 'BattleRoyaleMode', modding: 'ModdingMode' };

  function buildField() {
    if (S.seed == null || !S.mapSize) return null;
    G.FieldClass = G.FieldClass || findClass((c) => typeof c.prototype.getCustomMap === 'function');
    if (!G.FieldClass) return null;
    const options = (S.welcome && S.welcome.mode) || {};
    const cls = window[MODE_CLASS[S.modeId]] || window.Mode;
    const density = cls && cls.prototype && cls.prototype.asteroidsDensityModifier;
    const mode = { options, asteroidsDensityModifier: (x, y) => (density ? density.call({ options }, x, y) : 1) };
    const half = S.mapSize / 2, gen = new G.FieldClass(S.seed, half, mode), out = {};
    const list = [];
    list.index = new Map();
    for (let cx = -half; cx < half; cx++) {
      for (let cy = -half; cy < half; cy++) {
        gen.get(cx, cy, out);
        if (!out.on) continue;
        const r = { cx, cy, x: out.x * 10, y: out.y * 10, size: out.size * 10 };
        list.push(r);
        list.index.set(cx + ',' + cy, r);
      }
    }
    return list;
  }

  const rockAt = (cx, cy) => (S.field && S.field.index.get(cx + ',' + cy)) || null;

  // 0 = gone, 0..1 = regrowing (last second), 1 = whole; same formula as the game
  function rockScale(r, tick) {
    const key = r.cx + ',' + r.cy, resp = S.rocks.get(key);
    if (resp == null || tick == null) return 1;
    if (tick <= 60 * resp - 60) return 0;
    if (tick < 60 * resp) return Math.sqrt((tick - (60 * resp - 60)) / 60);
    S.rocks.delete(key);
    return 1;
  }

  const isRockRenderer = (v) => v && typeof v === 'object' && typeof v.rebuild === 'function' && typeof v.number === 'number' && Array.isArray(v.models);

  function rockRenderer() {
    const g = G.game();
    for (const c of [G.scene, ...(g ? Object.values(g) : [])]) {
      if (!c || typeof c !== 'object') continue;
      const r = Object.values(c).find(isRockRenderer);
      if (r) { G.scene = G.scene || c; return r; }
    }
    return null;
  }

  // Enlarge the game's own rock renderer from a 20×20 to an N×N cell window.
  // Model + rotation are copied from the original 10×10 pattern so every rock
  // looks exactly like normal. Runs in chunks (loading bar); stays loaded.
  function* growRocksJob(inst, N) {
    const group = Object.values(inst).find((v) => v instanceof THREE.Group);
    if (!group) throw new Error('rock renderer has no group');
    const n0 = inst.number, old = group.children.slice(), fresh = [];
    for (let h = 0; h < N; h++) {
      for (let r = 0; r < N; r++) {
        const ref = old[(h % 10) * n0 + (r % 10)];
        const mi = ref && ref.model != null ? ref.model : (h * 7 + r * 3) % inst.models.length;
        const m = inst.models[mi].getInstance();
        m.model = mi;
        if (ref) { m.rotation.x = ref.rotation.x; m.rotation.y = ref.rotation.y; }
        m.visible = false;
        fresh.push(m);
      }
      yield fresh.length / (N * N);
    }
    group.children.length = 0; // swap in one go (the game draws children[a*number+o])
    for (const m of fresh) group.add(m);
    inst.number = N;
    Object.assign(SP, { rocksInst: inst, rocksN: N });
  }

  // ===================================================== ship stats/specs
  // Same formulas as the game: value = min·(1−i) + max·i with i = upgrade/level.
  function specValue(v, upg, level) {
    if (!Array.isArray(v)) return typeof v === 'number' ? v : 0;
    const i = Math.max(0, Math.min(1, upg / Math.max(1, level)));
    return v[0] * (1 - i) + v[1] * i;
  }

  const shieldSpec = (st) => st && st.t && st.t.specs && st.t.specs.shield;
  const knownFor = (p) => (p.known && p.known.code === p.code ? p.known : null);

  function shieldCapacity(st, levels, fallback) {
    const spec = shieldSpec(st);
    return Math.max(1, spec ? specValue(spec.capacity, (levels >>> 0) & 15, st.t.level || 1) : fallback || 1);
  }

  const gemsCapacity = (st, code) => { const l = (st && st.t && st.t.level) || Math.floor(code / 100) || 1; return l * l * 20; };

  // last known shield + regeneration since then (reload per second, like the game)
  function estimateShield(p) {
    const st = G.shipType(p.code), spec = shieldSpec(st), k = knownFor(p);
    const cap = Math.max(spec ? shieldCapacity(st, k ? k.levels : 0) : 100, k ? k.shield : 0);
    if (!k) return cap;
    const reload = spec ? specValue(spec.reload, (k.levels >>> 4) & 15, st.t.level || 1) : 3;
    const factor = (S.welcome && S.welcome.mode && S.welcome.mode.shield_regen_factor) || 1;
    return Math.min(cap, k.shield + factor * reload * ((Date.now() - k.at) / 1000));
  }

  // ============================================================ spectator
  const SP = {
    active: false, loaded: false, loading: false,
    x: 0, y: 0, z: BASE_Z, zTarget: BASE_Z,
    follow: null, userZoomed: false, drag: null, mouseX: 0, mouseY: 0,
    rocksInst: null, rocksN: 0, lastSynth: 0, keysDown: new Set(),
  };
  window.SBSpecSP = SP;

  const maxZ = () => Math.max(BASE_Z, Math.min(S.world / 2, (SP.rocksN || 20) * 5) / TAN); // whole map height
  const unitsPerPixel = () => (2 * SP.z * TAN) / innerHeight;

  // POV of a ship: zoom = (radius/3)^0.3 / type.zoom and fov = 45°·zoom → camera height
  function povZ(code) {
    const st = G.shipType(code);
    const radius = (st && ((st.t && st.t.radius) || (st.m && st.m.radius))) || 3;
    const zoom = Math.pow(radius / 3, 0.3) / ((st && ((st.m && st.m.zoom) || (st.t && st.t.zoom))) || 1);
    return (BASE_Z * Math.tan((22.5 * zoom * Math.PI) / 180)) / TAN;
  }

  // Replaces the game's camera function every tick.
  function spectatorTick(world) {
    const cam = world[G.camKey];
    if (cam) {
      for (const k of Object.keys(cam)) if (typeof cam[k] === 'number') cam[k] = 0; // camera velocity
      Object.assign(cam, { x: SP.x, y: SP.y, zoom: 1 });
    }
    synthShips();
    driveShips(world);
  }

  // Far ships, 5×/s: create/keep alive with ship packets (opcode 0) built from
  // the radar (the game hides a ship after 90 ticks without an update).
  function synthShips() {
    const t = now();
    if (t - SP.lastSynth < 200) return;
    SP.lastSynth = t;
    const tick = G.tick();
    if (tick == null) return;
    for (const p of S.players.values()) {
      if (p.id === S.myId || !p.alive || !p.samples.length || exactFresh(p, t)) continue;
      const st = renderPos(p, t);
      if (st) inject(buildShipPacket(p, st, Math.round(tick)));
    }
  }

  // Every tick, AFTER the game's physics: overwrite far ships' position with our
  // curve (the game would slow them down; it doesn't know their upgrades).
  function driveShips(world) {
    if (!Array.isArray(world.ships)) return;
    const statusById = new Map();
    for (const e of world.ships) {
      const v = Object.values(e).find((o) => o && o.status && typeof o.status.x === 'number' && o.status.id != null);
      if (v) statusById.set(v.status.id, v.status);
    }
    const t = now();
    for (const p of S.players.values()) {
      const s = p.id !== S.myId && p.alive && !exactFresh(p, t) && statusById.get(p.id);
      const st = s && renderPos(p, t);
      if (!st) continue;
      const sp = Math.hypot(st.vx, st.vy);
      if (p.aim && t < p.aim.until) p.heading = angleLerp(p.heading, p.aim.a, 0.25); // face the target while shooting
      else if (sp > 0.03) p.heading = angleLerp(p.heading, Math.atan2(st.vy, st.vx), 0.08);
      if (sp > 0.32) p.up = true; else if (sp < 0.18) p.up = false; // engine flame with hysteresis
      Object.assign(s, { x: st.x, y: st.y, r: p.heading, up: !!p.up,
        angle: ((Math.round((p.heading * 180) / Math.PI) % 360) + 360) % 360 });
    }
  }

  function buildShipPacket(p, st, tick) {
    const v = new DataView(new ArrayBuffer(56)), k = knownFor(p);
    const deg = Math.round((p.heading * 180) / Math.PI);
    v.setUint8(0, 0);
    v.setUint8(1, p.id);
    v.setUint8(2, (p.alive ? 1 : 0) | (p.up ? 2 : 0) | ((((k && k.lives) || 0) & 7) << 2));
    v.setUint8(3, Math.round(((p.hue || 0) * 256) / 360) & 255);
    v.setUint32(4, 0, true); // server time 0 = "old": the client's clock sync ignores it
    v.setUint32(8, tick, true);
    v.setUint16(12, ((deg % 360) + 360) % 360, true);
    v.setUint16(14, p.code & 1023, true);
    [st.x, st.y, st.vx, st.vy, p.heading].forEach((f, i) => v.setFloat32(16 + 4 * i, f, true));
    v.setUint8(41, Math.min(255, p.rank || 0));
    v.setUint16(42, Math.round(estimateShield(p)), true);
    v.setUint16(44, k ? k.generator : 0, true);
    v.setUint16(46, k ? k.gems : 0, true);
    v.setUint32(48, p.score >>> 0, true);
    v.setUint32(52, k ? k.levels >>> 0 : 0, true);
    return v.buffer;
  }

  // ---- reconstructed lasers + gems outside our bubble
  // The server only sends lasers/gems near our own ship, but for the whole map we
  // know WHO destroyed a rock (110) and WHO killed whom (150). We recreate the
  // shots and gems with the game's own packets (100/120/121), so the game draws
  // them itself. This is a reconstruction, not real data.
  const FX = { laserId: 61000, gemId: 61000 };
  const fxId = (key) => { const v = FX[key]; FX[key] = v >= 65000 ? 61000 : v + 1; return v; };

  function inMyBubble(x, y) {
    const me = S.players.get(S.myId);
    return !!(me && me.exact) && Math.hypot(wrapDelta(x - me.exact.x), wrapDelta(y - me.exact.y)) < 110;
  }

  function laserSpecs(code) {
    const st = G.shipType(code), L = st && st.t && st.t.lasers;
    return Array.isArray(L) && L.length ? L : [{ x: 0, y: -2, speed: 150, damage: 5, type: 1, number: 1, spread: 0 }];
  }

  function fireAt(p, tx, ty, volleys, gapMs) {
    const t = now(), pos = renderPos(p, t);
    if (!pos) return;
    const dx = wrapDelta(tx - pos.x), dy = wrapDelta(ty - pos.y);
    if (Math.hypot(dx, dy) > 95) return; // too far: our position estimate can't be right
    const ang = Math.atan2(dy, dx);
    p.aim = { a: ang, until: t + volleys * gapMs + 400 };
    for (let i = 0; i < volleys; i++) setTimeout(() => fireVolley(p, ang), 60 + i * gapMs);
  }

  function fireVolley(p, ang) {
    const pos = SP.active && p.alive && renderPos(p, now()), tick = G.tick();
    if (!pos || tick == null) return;
    const fx = Math.cos(ang), fy = Math.sin(ang), recs = [];
    for (const L of laserSpecs(p.code)) {
      const n = Math.max(1, Math.min(8, L.number || 1)), spread = ((L.spread || 0) * Math.PI) / 180;
      const ox = +L.x || 0, oy = +L.y || 0; // y negative = nose
      for (let k = 0; k < n; k++) {
        recs.push([pos.x - fx * oy + fy * ox, pos.y - fy * oy - fx * ox, pos.vx || 0, pos.vy || 0,
          first(L.speed) || 150, ang + (n > 1 ? (k / (n - 1) - 0.5) * spread : 0), L.type || 1, Math.min(255, first(L.damage) || 5)]);
      }
    }
    const v = new DataView(new ArrayBuffer(8 + 32 * recs.length));
    v.setUint8(0, 100);
    v.setUint8(1, p.id);
    v.setUint32(4, Math.round(tick), true);
    recs.forEach(([x, y, vx, vy, speed, angle, type, damage], i) => {
      const o = 8 + 32 * i;
      [x, y, 0, vx, vy, speed].forEach((f, j) => v.setFloat32(o + 4 * j, f, true));
      v.setUint16(o + 24, fxId('laserId'), true);
      v.setFloat32(o + 26, angle, true);
      v.setUint8(o + 30, type);
      v.setUint8(o + 31, damage);
    });
    inject(v.buffer);
  }

  // drop gems; after eatAfterMs the ship eaterId "collects" them (they fly to it)
  function dropGems(x, y, count, points, eaterId, eatAfterMs) {
    const tick = G.tick();
    if (tick == null) return;
    const n = Math.max(1, Math.min(8, count)), v = new DataView(new ArrayBuffer(5 + 19 * n)), ids = [];
    v.setUint8(0, 120);
    v.setUint32(1, Math.round(tick), true);
    for (let i = 0; i < n; i++) {
      const o = 5 + 19 * i, a = Math.random() * 2 * Math.PI, r = 2 + Math.random() * 4, id = fxId('gemId');
      ids.push(id);
      v.setUint8(o, Math.max(1, Math.min(255, Math.round(points))));
      v.setUint16(o + 1, id, true);
      [x, y, Math.cos(a) * r, Math.sin(a) * r].forEach((f, j) => v.setFloat32(o + 3 + 4 * j, f, true));
    }
    inject(v.buffer);
    if (eaterId == null) return; // no eater: the game removes them after 10 s
    ids.forEach((id, i) => setTimeout(() => {
      if (!SP.active) return;
      const w = new DataView(new ArrayBuffer(4));
      w.setUint8(0, 121);
      w.setUint8(1, eaterId);
      w.setUint16(2, id, true);
      inject(w.buffer);
    }, eatAfterMs + i * 110));
  }

  function fxRockDestroyed(r, shooterId) {
    if (!SP.active || inMyBubble(r.x, r.y)) return; // in our bubble the server sends the real thing
    const sh = S.players.get(shooterId);
    const ok = sh && sh.alive && !exactFresh(sh, now());
    if (ok) fireAt(sh, r.x, r.y, 2, 170);
    dropGems(r.x, r.y, 2 + Math.round(r.size / 3), Math.max(1, Math.round(r.size)), ok ? sh.id : null, 900);
  }

  function fxKill(victim, pos, killerId) {
    if (!SP.active || inMyBubble(pos.x, pos.y)) return;
    const k = S.players.get(killerId);
    const ok = k && k.alive && k.id !== victim.id && !exactFresh(k, now());
    if (ok) fireAt(k, pos.x, pos.y, 3, 160);
    const level = Math.floor(victim.code / 100) || 1;
    const gems = (victim.known && victim.known.gems) || level * level * 6; // last known, else estimate
    const n = Math.max(2, Math.min(8, Math.round(gems / 15)));
    dropGems(pos.x, pos.y, n, Math.max(1, gems / n), ok ? k.id : null, 1300);
  }

  // ---- on / off
  function toggleSpectator() {
    if (SP.loading) return;
    if (SP.active) exitSpectator(); else enterSpectator();
  }

  function enterSpectator() {
    if (!S.welcome) return toast('Join a game first');
    if (!installHooks() || !G.world) return notReady('world');
    if (!installSceneHooks()) return notReady('scene');
    releaseHeldInput();
    const cam = G.cam();
    Object.assign(SP, { x: cam ? cam.x : 0, y: cam ? cam.y : 0, z: BASE_Z, zTarget: BASE_Z, follow: null, active: true });
    if (G.cursor) G.cursor.visible = false;
    document.body.classList.add('sbspec-on');
    if (SP.loaded && SP.rocksInst === rockRenderer()) ui.show();
    else runLoading();
  }

  function notReady(what) {
    toast('Still loading, try again in a second');
    console.warn('[SBSpec]', window.SBSpecDbg.status());
  }

  function exitSpectator() {
    Object.assign(SP, { active: false, drag: null, follow: null });
    document.body.classList.remove('sbspec-on');
    if (G.cursor) G.cursor.visible = true;
    try { if (G.world && G.world.initCamera) G.world.initCamera(1); } catch (e) { /* camera back on our ship */ }
    ui.hide();
  }

  // ---- loading screen: find map · generate map · find players · place players
  function runLoading() {
    SP.loading = true;
    const L = ui.loading;
    L.start();
    const steps = [
      function* () {
        yield 0.5;
        L.detail(0, (S.welcome.name || '') + ', ' + (S.modeId || 'unknown mode'));
      },
      function* () {
        S.field = S.field || buildField();
        const inst = rockRenderer();
        if (!inst) throw new Error('Could not load the asteroids');
        const N = Math.max(20, Math.min(100, Math.ceil(S.mapSize / 10) * 10));
        if (SP.rocksInst !== inst || SP.rocksN < N) yield* growRocksJob(inst, N);
        const dead = S.field ? S.field.filter((r) => rockScale(r, serverTick()) === 0).length : 0;
        L.detail(1, S.field ? S.field.length - dead + ' asteroids' : '');
      },
      function* () {
        const t0 = now();
        while (now() - t0 < 3000) {
          const all = [...S.players.values()];
          const named = all.filter((p) => p.name).length, ready = all.filter((p) => p.samples.length >= 2).length;
          L.detail(2, all.length + (all.length === 1 ? ' player' : ' players'));
          if (all.length && named === all.length && ready >= all.filter((p) => p.alive).length) break;
          yield Math.min(0.99, (now() - t0) / 3000);
        }
      },
      function* () {
        SP.lastSynth = 0;
        synthShips();
        for (const t0 = now(); now() - t0 < 400;) yield (now() - t0) / 400;

      },
    ];
    let si = 0, it = null;
    (function frame() {
      if (!SP.active) { SP.loading = false; L.hide(); return; }
      try {
        for (const t0 = now(); now() - t0 < 12;) { // max ~12 ms per frame so the game keeps running
          if (!it) { L.step(si); it = steps[si](); }
          const r = it.next();
          if (!r.done) { L.progress(si, r.value); continue; }
          L.done(si);
          it = null;
          if (++si >= steps.length) {
            Object.assign(SP, { loaded: true, loading: false });
            setTimeout(() => { L.hide(); if (SP.active) ui.show(); }, 350);
            return;
          }
        }
      } catch (e) {
        console.error('[SBSpec] loading failed', e);
        L.error(si, String(e.message || e));
        SP.loading = false;
        setTimeout(() => { L.hide(); exitSpectator(); }, 2500);
        return;
      }
      requestAnimationFrame(frame);
    })();
  }

  // ---- input: block everything for our own ship, use it ourselves
  const BLOCK = ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu',
    'wheel', 'mousewheel', 'DOMMouseScroll', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointerup', 'pointermove'];

  function onAnyInput(e) {
    if (e.__sbspec) return; // our own "release" events
    if (e.type === 'keydown') SP.keysDown.add(e.keyCode);
    if (e.type === 'keyup') SP.keysDown.delete(e.keyCode);
    const a = document.activeElement;
    const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
    // ] and [ need AltGr on AZERTY/QWERTZ keyboards (Windows reports that as Ctrl+Alt),
    // so AltGr is allowed. F8/F9 work on every keyboard.
    const altGr = e.getModifierState && e.getModifierState('AltGraph');
    const plain = altGr || (!e.ctrlKey && !e.altKey && !e.metaKey);
    const spec = e.key === ']' || e.key === 'F8', test = e.key === '[' || e.key === 'F9';
    if (e.type === 'keydown' && !typing && plain && e.key === 'F7') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const room = prompt('Share room\n\nFriends who use the same room name in the same server share what they see.\nLeave empty to turn it off.', Share.room || '');
      if (room !== null) setShareRoom(room);
      return;
    }
    if (e.type === 'keydown' && !typing && plain && (spec || test)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (spec) toggleSpectator(); else testOn = !testOn;
      return;
    }
    if (!SP.active || (e.target && e.target.closest && e.target.closest('.sbspec-ui'))) return;
    e.stopImmediatePropagation();

    if (e.type.startsWith('key')) {
      if (e.type === 'keydown' && e.key === 'Escape') SP.follow = null;
      if (e.type === 'keydown' && e.key.toLowerCase() === 'l') toggleLive();
      if (!/^F\d+$/.test(e.key)) e.preventDefault(); // F5/F11/F12 keep working
      return;
    }
    if (e.type === 'mousemove') {
      Object.assign(SP, { mouseX: e.clientX, mouseY: e.clientY });
      if (SP.drag) {
        const upp = unitsPerPixel();
        SP.x = wrapPos(SP.drag.x - (e.clientX - SP.drag.mx) * upp);
        SP.y = wrapPos(SP.drag.y + (e.clientY - SP.drag.my) * upp);
      }
    } else if (e.type === 'mousedown') {
      e.preventDefault();
      if (e.button === 2) Object.assign(SP, { follow: null, drag: { mx: e.clientX, my: e.clientY, x: SP.x, y: SP.y } });
      else if (e.button === 0) { const id = shipUnderMouse(e.clientX, e.clientY); if (id != null) followPlayer(id); }
    } else if (e.type === 'mouseup') {
      if (e.button === 2) SP.drag = null;
    } else if (e.type === 'wheel') {
      e.preventDefault();
      if (SP.follow != null) SP.userZoomed = true;
      SP.zTarget = Math.max(25, Math.min(maxZ(), SP.zTarget * Math.pow(1.0015, e.deltaY)));
    } else if (e.type === 'contextmenu' || e.type === 'mousewheel' || e.type === 'DOMMouseScroll') {
      e.preventDefault();
    }
  }
  for (const type of BLOCK) window.addEventListener(type, onAnyInput, { capture: true, passive: false });

  function toggleLive() {
    S.live = !S.live;
    try { localStorage.setItem('sbspec-live2', S.live ? '1' : '0'); } catch (e) { /* ignore */ }
    for (const p of S.players.values()) p.lv = p.sm = p.spr = null;
    toast(S.live ? 'Live movement' : 'Smooth movement (1 s delay)');
  }

  // On enter: release every held key/button so our ship doesn't keep flying/shooting.
  function releaseHeldInput() {
    for (const code of SP.keysDown) {
      const ev = new KeyboardEvent('keyup', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: () => code });
      Object.defineProperty(ev, 'which', { get: () => code });
      ev.__sbspec = true;
      document.dispatchEvent(ev);
    }
    SP.keysDown.clear();
    for (const button of [0, 2]) {
      const ev = new MouseEvent('mouseup', { bubbles: true, cancelable: true, button, clientX: SP.mouseX, clientY: SP.mouseY });
      ev.__sbspec = true;
      document.dispatchEvent(ev);
    }
  }

  function worldToScreen(x, y) {
    const upp = unitsPerPixel();
    return { sx: innerWidth / 2 + wrapDelta(x - SP.x) / upp, sy: innerHeight / 2 - wrapDelta(y - SP.y) / upp };
  }

  function shipUnderMouse(mx, my) {
    let best = null, bd = 40;
    const t = now();
    for (const p of S.players.values()) {
      const pos = p.alive && renderPos(p, t);
      if (!pos) continue;
      const s = worldToScreen(pos.x, pos.y), d = Math.hypot(s.sx - mx, s.sy - my);
      if (d < bd) { bd = d; best = p.id; }
    }
    return best;
  }

  function followPlayer(id) {
    const p = S.players.get(id);
    if (p) Object.assign(SP, { follow: id, userZoomed: false, zTarget: Math.min(maxZ(), povZ(p.code)) });
  }

  // Camera per frame, time-based (equally calm at 60/144/240 FPS).
  function cameraFrame() {
    if (!SP.active) return;
    const t = now(), dt = Math.min(0.1, Math.max(0, (t - (SP.lastFrame || t)) / 1000));
    SP.lastFrame = t;
    const ease = (tau) => 1 - Math.exp(-dt / tau);
    const p = SP.follow != null && S.players.get(SP.follow);
    const pos = p && p.alive && renderPos(p, t);
    if (pos) {
      // look ahead like the game (30 × velocity), with a calm averaged velocity
      if (SP.lookId !== p.id) Object.assign(SP, { lookId: p.id, lvx: pos.vx || 0, lvy: pos.vy || 0 });
      SP.lvx += ((pos.vx || 0) - SP.lvx) * ease(0.4);
      SP.lvy += ((pos.vy || 0) - SP.lvy) * ease(0.4);
      SP.x = wrapPos(SP.x + wrapDelta(pos.x + 30 * SP.lvx - SP.x) * ease(0.13));
      SP.y = wrapPos(SP.y + wrapDelta(pos.y + 30 * SP.lvy - SP.y) * ease(0.13));
      if (!SP.userZoomed) SP.zTarget = Math.min(maxZ(), povZ(p.code));
    }
    SP.z += (SP.zTarget - SP.z) * ease(0.1);
  }

  // =================================================================== UI
  const CSS = `
    .sbspec-ui { font-family: Play, 'Segoe UI', Arial, sans-serif; color: #fff; user-select: none; }
    body.sbspec-on canvas { cursor: none !important; }
    #sbspec-list { position: fixed; left: 0; top: 50%; transform: translateY(-50%); z-index: 100000; width: 270px;
      max-height: 82vh; overflow-y: auto; scrollbar-width: none; padding: 6px 0; display: none;
      background: rgba(6,10,24,.78); border: 1px solid rgba(255,255,255,.15); border-left: none; border-radius: 0 8px 8px 0; }
    #sbspec-list::-webkit-scrollbar { display: none; } /* still scrollable with the mouse wheel */
    #sbspec-list .hdr { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; padding: 6px 10px 3px; opacity: .9; }
    #sbspec-list .row { display: grid; grid-template-columns: 26px 1fr auto; gap: 6px; align-items: center;
      padding: 3px 10px; cursor: pointer; font-size: 13px; line-height: 1.15; }
    #sbspec-list .row:hover { background: rgba(255,255,255,.08); }
    #sbspec-list .row.sel { background: rgba(255,255,255,.18); }
    #sbspec-list .row.dead { opacity: .4; }
    #sbspec-list img { width: 24px; height: 24px; object-fit: contain; }
    #sbspec-list .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #sbspec-list .say { font-family: Glyphs, Play, sans-serif; margin-left: 6px; padding: 0 4px; border-radius: 4px;
      background: rgba(255,255,255,.14); animation: sbspec-pop .25s ease-out; }
    #sbspec-list .say b { font-family: Play, sans-serif; }
    @keyframes sbspec-pop { from { transform: scale(1.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    #sbspec-list .sc { font-size: 12px; text-align: right; }
    #sbspec-list .pg { font-size: 10px; opacity: .7; }
    #sbspec-list .bars { display: grid; gap: 2px; margin-top: 3px; }
    #sbspec-list .bar { height: 4px; background: rgba(255,255,255,.13); border-radius: 2px; overflow: hidden; }
    #sbspec-list .bar i { display: block; height: 100%; border-radius: 2px; transition: width .25s linear; }
    #sbspec-list .bar.sh i { background: linear-gradient(90deg, #39c, #7df); }
    #sbspec-list .bar.gm i { background: linear-gradient(90deg, #c36, #f7a); }
    #sbspec-list .bar.unk { background: repeating-linear-gradient(90deg, rgba(255,120,170,.25) 0 4px, transparent 4px 8px); }
    #sbspec-list .row.est .bar i { opacity: .6; }
    #sbspec-bar { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 100000; display: none;
      background: rgba(6,10,24,.7); border: 1px solid rgba(255,255,255,.15); border-radius: 6px; white-space: nowrap;
      padding: 5px 12px; font-size: 12px; color: rgba(255,255,255,.75); pointer-events: none; }
    #sbspec-bar b { color: #bdf; font-weight: 400; letter-spacing: .2em; margin-right: 6px; }
    #sbspec-bar .kc { display: inline-block; margin: 0 4px 0 12px; padding: 0 5px; border: 1px solid rgba(255,255,255,.3);
      border-radius: 3px; font-size: 11px; line-height: 16px; color: #fff; }
    #sbspec-bar .st { margin-left: 16px; padding-left: 12px; border-left: 1px solid rgba(255,255,255,.2); }
    #sbspec-bar .st i { display: inline-block; width: 1px; height: 10px; margin: 0 8px; background: rgba(255,255,255,.25); }
    #sbspec-load { position: fixed; inset: 0; z-index: 100001; display: none; align-items: center; justify-content: center;
      background: radial-gradient(ellipse at center, rgba(10,20,45,.92), rgba(0,0,0,.96)); }
    #sbspec-load .box { width: min(460px, 90vw); }
    #sbspec-load h1 { font-size: 26px; letter-spacing: .25em; text-align: center; margin: 0 0 22px; font-weight: 400; color: #bdf; }
    #sbspec-load .st { margin: 10px 0; }
    #sbspec-load .st.wait { opacity: .35; }
    #sbspec-load .st.err .t { color: #f88; }
    #sbspec-load .by { margin-top: 26px; text-align: center; font-size: 11px; letter-spacing: .2em; opacity: .35; text-transform: uppercase; }
    #sbspec-load .t { display: flex; justify-content: space-between; font-size: 14px; }
    #sbspec-load .d { font-size: 11px; opacity: .65; min-height: 14px; margin-top: 2px; }
    #sbspec-load .p { height: 4px; background: rgba(255,255,255,.12); border-radius: 2px; margin-top: 4px; }
    #sbspec-load .p i { display: block; height: 100%; width: 0; background: linear-gradient(90deg,#39f,#8ff); border-radius: 2px; }
    #sbspec-toast { position: fixed; top: 40%; left: 50%; transform: translate(-50%,-50%); z-index: 100002; display: none;
      background: rgba(0,0,0,.8); padding: 10px 18px; border-radius: 6px; pointer-events: none; }`;

  function el(tag, attrs, parent) {
    if (!document.getElementById('sbspec-css')) document.head.appendChild(Object.assign(document.createElement('style'), { id: 'sbspec-css', textContent: CSS }));
    const e = Object.assign(document.createElement(tag), attrs || {});
    if (parent) parent.appendChild(e);
    return e;
  }

  // emoji codes → icons via the game's own vocabulary (drawn in the "Glyphs" font)
  const SAY_MS = 4000;
  function sayIcons(p) {
    if (!p.say || now() - p.say.at > SAY_MS) return null;
    const g = G.game(), vocab = g && g.vocabulary;
    return [...p.say.text].map((c) => { const v = vocab && vocab[c]; return v ? v.icon : c; });
  }
  const sayHTML = (icons) => '<span class="say">' + icons.map((i) => (i.length > 1 ? '<b>' + esc(i) + '</b>' : esc(i))).join('') + '</span>';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const myPing = () => { const g = G.game(); return g && g.ping != null ? g.ping + ' ms' : ''; };
  const hsl = (h, l) => 'hsl(' + (h || 0) + ',80%,' + l + '%)';

  function toast(msg) {
    const t = document.getElementById('sbspec-toast') || el('div', { id: 'sbspec-toast', className: 'sbspec-ui' }, document.body);
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.style.display = 'none'; }, 1800);
  }

  // ship icons, the same ones team mode shows (canvas + data URL, cached)
  const icons = new Map();
  function shipIcon(code) {
    if (!icons.has(code)) {
      G.IconClass = G.IconClass || findClass((c) => typeof c.getShipIcon === 'function');
      let canvas = null;
      try { canvas = G.IconClass && G.IconClass.getShipIcon(code); } catch (e) { /* not ready yet */ }
      if (!canvas) return null;
      icons.set(code, { canvas, url: canvas.toDataURL ? canvas.toDataURL() : '' });
    }
    return icons.get(code);
  }

  const ui = {
    list: null, bar: null, lastBuild: 0,
    show() {
      if (!this.list) {
        this.list = el('div', { id: 'sbspec-list', className: 'sbspec-ui' }, document.body);
        this.bar = el('div', { id: 'sbspec-bar', className: 'sbspec-ui' }, document.body);
        for (const type of ['mousedown', 'mouseup', 'click', 'wheel', 'contextmenu']) this.list.addEventListener(type, (e) => e.stopPropagation());
        // mousedown, not click: the list is rebuilt 4×/s and a click gets lost when its row is replaced
        this.list.addEventListener('mousedown', (e) => {
          const row = e.button === 0 && e.target.closest('.row');
          if (row) { followPlayer(+row.dataset.id); this.lastBuild = 0; }
        });
      }
      this.list.style.display = this.bar.style.display = 'block';
    },
    hide() { if (this.list) this.list.style.display = this.bar.style.display = 'none'; },
    update() {
      const t = now();
      if (!SP.active || !this.list || this.list.style.display === 'none' || t - this.lastBuild < 250) return;
      this.lastBuild = t;
      const key = (k, what) => '<span class="kc">' + k + '</span>' + what;
      this.bar.innerHTML = '<b>SPECTATOR</b>' +
        key(']', 'exit') + key('Scroll', 'zoom') + key('Right drag', 'move') + key('Click', 'follow') + key('Esc', 'stop') +
        key('L', S.live ? 'live' : 'smooth') + key('F7', 'share') +
        (myPing() || shareSummary() ? '<span class="st">' + [myPing(), esc(shareSummary())].filter(Boolean).join('<i></i>') + '</span>' : '');
      // grouped per team (team mode), sorted by score
      const groups = new Map();
      for (const p of S.players.values()) {
        const key = S.teams.length && p.team != null ? p.team : -1;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      const html = [];
      for (const key of [...groups.keys()].sort((a, b) => a - b)) {
        const list = groups.get(key).sort((a, b) => b.score - a.score), team = S.teams[key];
        const title = team ? team.faction : S.survival || S.modeId === 'survival' ? 'Survival' : 'Players';
        html.push('<div class="hdr" style="color:' + (team ? hsl(team.hue, 70) : '#bdf') + '">' + esc(title + ' · ' + list.length) + '</div>');
        for (const p of list) html.push(this.row(p, t));
      }
      this.list.innerHTML = html.join('');
    },
    row(p, t) {
      const exact = exactFresh(p, t), k = knownFor(p), st = G.shipType(p.code), me = p.id === S.myId;
      const shield = exact ? p.exact.shield : Math.round(estimateShield(p));
      const shieldMax = shieldCapacity(st, exact ? p.exact.levels : k ? k.levels : 0, shield);
      const gems = exact ? p.exact.gems : k ? k.gems : null, gemsMax = gemsCapacity(st, p.code);
      const age = k && !exact ? Math.round((Date.now() - k.at) / 1000) : 0;
      const pct = (a, b) => Math.max(0, Math.min(100, (100 * a) / Math.max(1, b))).toFixed(0);
      const tip = (st && st.t ? st.t.name : p.code) + ' · shield ' + shield + '/' + Math.round(shieldMax) + ' · gems ' + (gems == null ? '?' : gems) + '/' + gemsMax +
        (exact ? ' · live' : age ? ' · last seen ' + age + 's ago' : ' · estimated');
      const icon = shipIcon(p.code), icons = sayIcons(p);
      return '<div class="row' + (p.alive ? '' : ' dead') + (SP.follow === p.id ? ' sel' : '') + (exact ? '' : ' est') + '" data-id="' + p.id + '" title="' + esc(tip) + '">' +
        '<img src="' + (icon ? icon.url : '') + '">' +
        '<div><div class="nm" style="color:' + hsl(p.hue, 72) + '">' + esc(p.name || '#' + p.id) + (me ? ' (you)' : '') + (icons ? sayHTML(icons) : '') + '</div>' +
          '<div class="bars"><div class="bar sh"><i style="width:' + pct(shield, shieldMax) + '%"></i></div>' +
          '<div class="bar gm' + (gems == null ? ' unk' : '') + '"><i style="width:' + (gems == null ? 0 : pct(gems, gemsMax)) + '%"></i></div></div></div>' +
        '<div class="sc">' + p.score + (me && myPing() ? '<div class="pg">' + myPing() + '</div>' : '') + '</div></div>';
    },
    loading: {
      root: null, rows: [],
      start() {
        if (!this.root) {
          this.root = el('div', { id: 'sbspec-load', className: 'sbspec-ui' }, document.body);
          const box = el('div', { className: 'box' }, this.root);
          el('h1', { textContent: 'SPECTATOR' }, box);
          this.rows = ['Map', 'Asteroids', 'Players', 'Ready'].map((name) => {
            const r = el('div', {}, box), t = el('div', { className: 't' }, r);
            el('span', { textContent: name }, t);
            return { r, s: el('span', {}, t), d: el('div', { className: 'd' }, r), i: el('i', null, el('div', { className: 'p' }, r)) };
          });
          el('div', { className: 'by', textContent: 'by Zyrvaen' }, box);
        }
        for (const row of this.rows) { row.r.className = 'st wait'; row.s.textContent = row.d.textContent = ''; row.i.style.width = '0'; }
        this.root.style.display = 'flex';
      },
      step(i) { this.rows[i].r.className = 'st'; this.rows[i].s.textContent = ''; },
      progress(i, k) { this.rows[i].i.style.width = Math.round(100 * Math.max(0, Math.min(1, k))) + '%'; },
      detail(i, txt) { this.rows[i].d.textContent = txt; },
      done(i) { this.rows[i].i.style.width = '100%'; this.rows[i].s.textContent = '✓'; },
      error(i, msg) { Object.assign(this.rows[i].r, { className: 'st err' }); this.rows[i].s.textContent = '✗'; this.rows[i].d.textContent = msg; },
      hide() { if (this.root) this.root.style.display = 'none'; },
    },
  };

  // ---- canvas overlay: crosshair, labels when zoomed far out, test map
  let testOn = false, canvas = null, ctx = null;

  function label(txt, x, y, color, size, align) {
    Object.assign(ctx, { font: (size || 12) + 'px Play, Arial, sans-serif', textAlign: align || 'left', lineWidth: 3, strokeStyle: 'rgba(0,0,0,.8)', fillStyle: color });
    ctx.strokeText(txt, x, y);
    ctx.fillText(txt, x, y);
    Object.assign(ctx, { lineWidth: 1, textAlign: 'left' });
  }

  function dot(x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawOverlay() {
    if (!testOn && !SP.active) { if (canvas) canvas.style.display = 'none'; return; }
    if (!canvas) {
      canvas = el('canvas', { id: 'sbspec-overlay' }, document.body);
      Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: 99999, pointerEvents: 'none' });
      ctx = canvas.getContext('2d');
    }
    canvas.style.display = 'block';
    const dpr = window.devicePixelRatio || 1, W = innerWidth, H = innerHeight;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (SP.active && !SP.loading) drawSpectatorOverlay(W, H);
    if (testOn) drawTestMap(W, H);
  }

  function drawSpectatorOverlay(W, H) {
    const t = now();
    if (SP.z > 180) { // far out: the game's 3D name tags get too small → our own labels
      ctx.globalAlpha = Math.min(1, (SP.z - 180) / 120);
      for (const p of S.players.values()) {
        const pos = p.alive && renderPos(p, t);
        if (!pos) continue;
        const { sx, sy } = worldToScreen(pos.x, pos.y);
        if (sx < -50 || sy < -50 || sx > W + 50 || sy > H + 50) continue;
        dot(sx, sy, 3, hsl(p.hue, 65));
        label((p.name || '#' + p.id) + '  ' + p.score, sx, sy - 8, hsl(p.hue, 80), 11, 'center');
        const icons = sayIcons(p);
        if (icons) {
          Object.assign(ctx, { font: '16px Glyphs, Play', textAlign: 'center', fillStyle: '#fff' });
          ctx.fillText(icons.join(''), sx, sy - 24);
          ctx.textAlign = 'left';
        }
      }
      ctx.globalAlpha = 1;
    }
    const f = SP.follow != null && S.players.get(SP.follow);
    if (f) label('Following ' + (f.name || '#' + f.id), W / 2, H - 70, hsl(f.hue, 80), 14, 'center');
    // crosshair like Starblast (FontAwesome "crosshairs" \uf05b)
    Object.assign(ctx, { font: '26px FontAwesome', textAlign: 'center', textBaseline: 'middle', shadowBlur: 5, shadowColor: '#000', fillStyle: '#EEE' });
    ctx.fillText('\uf05b', SP.mouseX, SP.mouseY);
    Object.assign(ctx, { shadowBlur: 0, textAlign: 'left', textBaseline: 'alphabetic' });
  }

  function drawTestMap(W, H) {
    if (!S.world) return label('Join a game to see the map', 20, 30, '#fff', 16);
    S.field = S.field || buildField();
    const size = Math.min(W - 380, H) - 40, ox = 20, oy = (H - size) / 2, sc = size / S.world;
    const px = (x) => ox + (x / S.world + 0.5) * size, py = (y) => oy + (0.5 - y / S.world) * size;
    ctx.fillStyle = 'rgba(5,8,20,.88)';
    ctx.fillRect(ox, oy, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.strokeRect(ox, oy, size, size);

    const tick = serverTick();
    let dead = 0;
    if (!S.field) label('Asteroids unavailable', ox + 10, oy + 20, '#f88', 13);
    for (const r of S.field || []) {
      const k = rockScale(r, tick);
      if (k <= 0) dead++;
      else dot(px(r.x), py(r.y), Math.max(0.8, r.size * sc * k), k < 1 ? 'rgba(120,255,140,.9)' : 'rgba(170,160,140,.75)');
    }

    const t = now();
    S.effects = S.effects.filter((e) => t - e.t < 1500);
    ctx.lineWidth = 2;
    for (const e of S.effects) {
      const a = 1 - (t - e.t) / 1500;
      ctx.strokeStyle = (e.kind === 'kill' ? 'rgba(255,60,60,' : 'rgba(255,170,60,') + a + ')';
      ctx.beginPath();
      ctx.arc(px(e.x), py(e.y), (e.kind === 'kill' ? 18 : 8) * (1.2 - a), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    if (SP.active) { // spectator camera as a frame
      const hw = (SP.z * TAN * W) / H, hh = SP.z * TAN;
      ctx.strokeStyle = 'rgba(120,200,255,.8)';
      ctx.strokeRect(px(SP.x - hw), py(SP.y + hh), 2 * hw * sc, 2 * hh * sc);
    }

    const list = [...S.players.values()].sort((a, b) => b.score - a.score);
    for (const p of list) {
      const pos = p.alive && renderPos(p, t);
      if (!pos) continue;
      const x = px(pos.x), y = py(pos.y);
      dot(x, y, p.id === S.myId ? 6 : 4, hsl(p.hue, 65));
      if (pos.exact) { ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke(); }
      label(p.name || '#' + p.id, x + 7, y - 6, hsl(p.hue, 80), 11);
    }

    const lx = ox + size + 16;
    let ly = oy + 18;
    label(S.welcome.name + ', ' + S.modeId, lx, ly, '#fff', 13);
    label(S.players.size + ' players, ' + (S.field ? S.field.length - dead + ' asteroids' : ''), lx, (ly += 16), '#aaa', 12);
    ly += 10;
    for (const p of list) {
      if (ly > oy + size - 10) break;
      const icon = shipIcon(p.code);
      if (icon) try { ctx.drawImage(icon.canvas, lx, ly + 2, 18, 18); } catch (e) { /* not ready yet */ }
      let txt = (p.name || '#' + p.id) + '  ' + p.score;
      if (p.known) txt += '   shield ' + p.known.shield + '  gems ' + p.known.gems + (exactFresh(p, t) ? '' : '  (' + Math.round((Date.now() - p.known.at) / 1000) + 's ago)');
      label(txt, lx + 24, ly + 15, p.alive ? hsl(p.hue, 75) : '#777', 12);
      ly += 21;
    }
  }

  // debugging in the console: SBSpecDbg.status()
  window.SBSpecDbg = {
    toggle: toggleSpectator,
    status: () => ({
      hooked: G.hooked, world: !!G.world, camFn: G.camFn, camKey: G.camKey,
      scene: !!G.scene, renderFn: G.renderFn, sceneCamKey: G.sceneCamKey,
      rocksRenderer: !!rockRenderer(), rocksN: SP.rocksN, tickKey: G.tickKey, tick: G.tick(), serverTick: serverTick(),
      onmessage: !!(S.ws && typeof S.ws.onmessage === 'function'), players: S.players.size, active: SP.active, z: SP.z,
      emojis: S.says || 0, emojisFromFarPlayers: S.farSays || 0,
      share: { summary: shareSummary(), room: Share.room, relay: Relay.ready, ...Share.stats },
    }),
  };

  // ============================================================ main loop
  (function loop() {
    try {
      if (document.body) {
        if (installHooks() && G.world) installSceneHooks();
        cameraFrame();
        ui.update();
        drawOverlay();
      }
    } catch (e) { console.error('[SBSpec]', e); }
    requestAnimationFrame(loop);
  })();
})();
