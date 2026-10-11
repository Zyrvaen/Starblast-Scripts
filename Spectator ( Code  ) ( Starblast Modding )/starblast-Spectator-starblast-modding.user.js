// Starblast Event Kit by Zyrvaen
// A mod for community events: rounds, a kills/deaths scoreboard, spectating, roles and kick/ban.
// How to use it and all commands: https://github.com/Zyrvaen/Starblast-Scripts/tree/main/Spectator%20Starblast%20Modding
// Keep the editor tab open and in front while the mod runs.

// Normal players only play. These names get more when they join:
const ADMINS = ['ZYRVAEN'];     // spectate, kick, ban, run rounds
const SPECTATORS = [];          // spectate only
let ROUND_SECONDS = 300;
const COUNTDOWN_SECONDS = 10;
const REASONS = ['Cheating', 'Toxic / spam', 'Teaming', 'AFK', 'No reason given'];

// two invisible spectator ships: zoomed out for the free camera, normal view for following
// (a lower zoom value shows more of the map). They get a small shield and energy so the game
// doesn't show "Shield disabled" over the screen; they can't collide with anything anyway.
function spectatorShip(model, zoom) {
  const specs = { shield: { capacity: [100, 100], reload: [10, 10] }, generator: { capacity: [100, 100], reload: [10, 10] },
    ship: { mass: 1, speed: [200, 200], rotation: [1000, 1000], acceleration: [1000, 1000] } };
  return JSON.stringify({
    name: 'Spectator', level: 1, model, size: 0.025, zoom, specs,
    bodies: { face: { section_segments: 100, angle: 0, offset: { x: 0, y: 0, z: 0 }, position: { x: [0, 0, 0, 0], y: [-2, -2, 2, 2], z: [0, 0, 0, 0] },
      width: [0, 1, 1, 0], height: [0, 1, 1, 0], vertical: true, texture: [6] } },
    typespec: { name: 'Spectator', level: 1, model, code: 100 + model, specs, shape: Array(50).fill(0.001), lasers: [], radius: 0.001 },
  });
}
const FREE_CAM = 191, FOLLOW_CAM = 192;

this.options = {
  root_mode: '',
  map_size: 60,
  max_players: 40,
  starting_ship: 101,
  crystal_value: 2,
  lives: 5,
  weapons_store: true,
  ships: [spectatorShip(91, 0.035), spectatorShip(92, 0.075)],
};

// ---- state

const ev = { state: 'lobby', ends: 0, banner: null, bannerEnds: 0, results: 0 };
const bans = {}; // NAME -> { reason, by }
const COLOR = { text: '#dde8f0', dim: '#8aa0b0', box: 'rgba(10,20,30,0.85)', line: '#2f5a6d', gold: '#ffd060', red: '#ff8080', green: '#80ffa0' };
const ROWS = 8;

function stats(ship) {
  const c = ship.custom;
  if (c.kills == null) {
    Object.assign(c, { kills: 0, deaths: 0, spec: false, follow: null, panel: null, page: 0, rows: [], pending: null,
      role: roleByName(ship.name) });
  }
  return c;
}

function roleByName(name) {
  name = String(name).toUpperCase();
  const has = list => list.some(n => n.toUpperCase() === name);
  return has(ADMINS) ? 'admin' : has(SPECTATORS) ? 'spectator' : 'player';
}

const isAdmin = ship => stats(ship).role === 'admin';
const canSpectate = ship => stats(ship).role !== 'player';
const roundRunning = () => ev.state === 'countdown' || ev.state === 'live';

function setRole(ship, role) {
  const c = stats(ship);
  c.role = role;
  if (role === 'player' && c.spec) setSpectate(ship, false);
  if (role !== 'admin' && c.panel) { c.panel = null; c.pending = null; drawPanel(ship); }
  drawButtons(ship);
}

const players = game => game.ships.filter(s => !stats(s).spec);

function ranked(game) {
  return players(game).sort((a, b) => {
    const x = stats(a), y = stats(b);
    return y.kills - x.kills || x.deaths - y.deaths || b.score - a.score;
  });
}

function clock(ticks) {
  const s = Math.max(0, Math.ceil(ticks / 60));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function randomSpot(game) {
  const half = game.options.map_size * 5 - 20;
  return { x: (Math.random() * 2 - 1) * half, y: (Math.random() * 2 - 1) * half };
}

// ---- spectating

function setSpectate(ship, on) {
  const c = stats(ship);
  if (on === c.spec) return;
  c.spec = on;
  c.follow = null;
  if (on) {
    if (ship.type !== FREE_CAM && ship.type !== FOLLOW_CAM) c.prevType = ship.type;
    ship.set({ type: FREE_CAM, collider: false, crystals: 0 });
  } else {
    ship.set({ type: c.prevType ?? game.options.starting_ship ?? 101, collider: true, invulnerable: 180, stats: 0, shield: 1000 });
  }
  drawButtons(ship);
}

// < and > walk through: free camera, player 1, player 2, ... and around again
function cycleFollow(ship, step) {
  const c = stats(ship);
  const ids = [null, ...players(game).map(s => s.id)];
  const i = Math.max(0, ids.indexOf(c.follow));
  c.follow = ids[(i + step + ids.length) % ids.length];
  ship.set({ type: c.follow == null ? FREE_CAM : FOLLOW_CAM, collider: false });
  drawButtons(ship);
}

function followTick(game) {
  for (const ship of game.ships) {
    const c = stats(ship);
    if (!c.spec || c.follow == null) continue;
    const t = game.findShip(c.follow);
    if (!t || stats(t).spec) { c.follow = null; ship.set({ type: FREE_CAM }); drawButtons(ship); continue; }
    ship.set({ x: t.x, y: t.y, vx: t.vx, vy: t.vy });
  }
}

// ---- rounds

function round(seconds) {
  if (roundRunning()) return echo('A round is already running, type endround first');
  ROUND_SECONDS = seconds || ROUND_SECONDS;
  ev.state = 'countdown';
  ev.ends = game.step + COUNTDOWN_SECONDS * 60;
  hideResults();
  for (const ship of players(game)) {
    const c = stats(ship), p = randomSpot(game);
    c.kills = c.deaths = 0;
    ship.set({ x: p.x, y: p.y, vx: 0, vy: 0, type: game.options.starting_ship ?? 101, stats: 0, crystals: 0, score: 0,
      shield: 1000, idle: true, invulnerable: COUNTDOWN_SECONDS * 60 + 120 });
  }
  announce(`Round starts in ${COUNTDOWN_SECONDS} seconds`, COUNTDOWN_SECONDS);
  echo(`Round of ${ROUND_SECONDS} s is starting`);
}

function goLive() {
  ev.state = 'live';
  ev.ends = game.step + ROUND_SECONDS * 60;
  for (const ship of players(game)) ship.set({ idle: false });
  announce('GO!', 3);
}

function endRound() {
  if (!roundRunning()) return echo('No round is running');
  ev.state = 'lobby';
  for (const ship of game.ships) ship.set({ idle: false });
  const top = ranked(game).slice(0, 3);
  announce('Round over', 4); // also replaces a countdown message that may still be up
  showResults(top);
  echo(top.length ? `Round over. Winner: ${top[0].name} (${stats(top[0]).kills} kills)` : 'Round over. Nobody played');
}

// ---- kick and ban

function removePlayer(target, ban, reason = 'No reason given', by = 'the host') {
  reason = reason || 'No reason given'; // an empty reason typed in the console
  if (ban) bans[String(target.name).toUpperCase()] = { reason, by };
  target.gameover(endScreen(ban, reason, by));
  echo(`${target.name} was ${ban ? 'banned' : 'kicked'}: ${reason}`);
  announce(`${target.name} was ${ban ? 'banned' : 'kicked'}`, 4);
}

// the game over screen hides rows with an empty value, so every row gets one
function endScreen(ban, reason, by = 'the host') {
  const screen = { [ban ? 'Banned by' : 'Kicked by']: by, Reason: reason };
  if (ban) screen.Rejoin = 'Not allowed';
  return screen;
}

// a banned name is sent away 1.5 s after joining: earlier, the game hasn't
// finished loading on their side and they'd only see a grey screen
function checkBan(ship) {
  const c = stats(ship);
  if (c.banChecked) return;
  c.banChecked = true;
  if (bans[String(ship.name).toUpperCase()]) c.banAt = game.step + 90;
}

function banTick(game) {
  for (const ship of game.ships) {
    const c = stats(ship), b = bans[String(ship.name).toUpperCase()];
    if (!c.banAt || game.step < c.banAt) continue;
    c.banAt = 0;
    if (b) ship.gameover(endScreen(true, b.reason, b.by));
  }
}

// ---- console commands (the console only sees `game`, so they're added to its command list)

// a player by id ("3") or by name ("test", any case)
function findPlayer(arg = '') {
  arg = String(arg).trim();
  let s = /^\d+$/.test(arg) ? game.findShip(Number(arg)) : null;
  if (!s) {
    const found = game.ships.filter(x => String(x.name).toUpperCase() === arg.toUpperCase());
    if (found.length > 1) { echo(`More players are called ${arg}, use their id (type list)`); return null; }
    s = found[0] ?? null;
  }
  if (!s) echo(`No player "${arg}", type list to see names and ids`);
  return s;
}

function giveRole(arg, role, msg) {
  const s = findPlayer(arg);
  if (!s) return;
  setRole(s, role);
  echo(`${s.name} ${msg}`);
}

function idAndReason(arg = '') {
  const m = /^(\S+)\s*(.*)$/.exec(arg);
  return m ? { id: m[1], reason: m[2] } : { id: '', reason: '' };
}

const COMMANDS = {
  round: arg => round(Number(arg) || 0),
  endround: () => endRound(),
  say: arg => { if (arg) announce(arg, 8); },
  list: () => {
    if (!game.ships.length) return echo('Nobody is here yet');
    for (const s of game.ships) {
      const c = stats(s);
      echo(`${s.id}  ${s.name}  ${c.kills}/${c.deaths}${c.role !== 'player' ? `  (${c.role})` : ''}${c.spec ? '  spectating' : ''}`);
    }
  },
  admin: arg => giveRole(arg, 'admin', 'is now an admin (spectate, kick, ban, rounds)'),
  spectator: arg => giveRole(arg, 'spectator', 'can now spectate'),
  player: arg => giveRole(arg, 'player', 'is a normal player again'),
  kick: arg => { const a = idAndReason(arg), s = findPlayer(a.id); if (s) removePlayer(s, false, a.reason); },
  ban: arg => { const a = idAndReason(arg), s = findPlayer(a.id); if (s) removePlayer(s, true, a.reason); },
  unban: (arg = '') => {
    const name = String(arg).toUpperCase();
    if (!(name in bans)) return echo(`No ban for "${arg}", type bans to see them`);
    delete bans[name];
    echo(`${name} is no longer banned`);
  },
  bans: () => {
    const names = Object.keys(bans);
    if (!names.length) return echo('Nobody is banned');
    for (const n of names) echo(`${n}: ${bans[n].reason}  (by ${bans[n].by})`);
  },
};

function addCommands() {
  for (const name of Object.keys(COMMANDS)) {
    game.modding.commands[name] = line => COMMANDS[name](line.slice(name.length).trim());
  }
  echo('Event Kit ready. Commands: round [s], endround, say [text], list, admin [id], spectator [id], player [id], kick [id] [reason], ban [id] [reason], unban [name], bans');
}

// ---- UI

const text = (value, position, color = COLOR.text, align = 'center') => ({ type: 'text', position, value, color, align });
const box = (stroke = COLOR.line) => ({ type: 'box', position: [0, 0, 100, 100], fill: COLOR.box, stroke, width: 2 });

function button(ship, id, position, label, visible, color) {
  ship.setUIComponent({ id, position, clickable: true, visible: !!visible, components: [box(color), text(label, [0, 22, 100, 56], color)] });
}

const hide = (ship, id) => ship.setUIComponent({ id, visible: false });

// one row at the top, left of the scoreboard, so nothing covers the game's own buttons:
// Start round, Players (admins), Spectate / Play, < > (while spectating)
function drawButtons(ship) {
  const c = stats(ship);
  button(ship, 'ek_round', [32, 1, 11, 4.5], roundRunning() ? 'End round' : 'Start round', isAdmin(ship), roundRunning() ? COLOR.red : COLOR.green);
  button(ship, 'ek_players', [44, 1, 10, 4.5], c.panel ? 'Close' : 'Players', isAdmin(ship));
  button(ship, 'ek_spec', [55, 1, 9, 4.5], c.spec ? 'Play' : 'Spectate', canSpectate(ship), c.spec ? COLOR.green : undefined);
  button(ship, 'ek_prev', [65, 1, 5, 4.5], '<', c.spec);
  button(ship, 'ek_next', [70.5, 1, 5, 4.5], '>', c.spec);
  const f = c.follow != null && game.findShip(c.follow);
  ship.setUIComponent({ id: 'ek_watch', position: [30, 7, 40, 4], visible: c.spec,
    components: [text(f ? `Watching ${f.name}` : 'Free camera   ( < > to follow a player )', [0, 0, 100, 100], COLOR.gold)] });
}

// admin panel: tabs "Players" (kick / ban, then pick a reason) and "Banned" (unban)
const PANEL_IDS = ['ek_tabp', 'ek_tabb', 'ek_list', 'ek_page', 'ek_cancel'];

function hidePanel(ship, keep = []) {
  const ids = [...PANEL_IDS];
  for (let i = 0; i < ROWS; i++) ids.push(`ek_n${i}`, `ek_k${i}`, `ek_b${i}`, `ek_bn${i}`, `ek_u${i}`);
  REASONS.forEach((r, i) => ids.push(`ek_r${i}`));
  for (const id of ids) if (!keep.includes(id)) hide(ship, id);
}

function tabs(ship, view) {
  button(ship, 'ek_tabp', [30, 18, 19.5, 5.5], 'Players', true, view === 'players' ? COLOR.gold : undefined);
  button(ship, 'ek_tabb', [50.5, 18, 19.5, 5.5], `Banned (${Object.keys(bans).length})`, true, view === 'bans' ? COLOR.gold : undefined);
}

function pageOf(ship, total) {
  const c = stats(ship), pages = Math.max(1, Math.ceil(total / ROWS));
  if (c.page >= pages) c.page = 0;
  button(ship, 'ek_page', [56.5, 70, 13.5, 4.6], `Next page (${c.page + 1}/${pages})`, pages > 1);
  return c.page * ROWS;
}

function emptyNote(ship, value) {
  ship.setUIComponent({ id: 'ek_list', position: [30, 25, 40, 5], visible: true, components: [text(value, [0, 0, 100, 100], COLOR.dim)] });
}

function drawPanel(ship) {
  const c = stats(ship), keep = ['ek_tabp', 'ek_tabb', 'ek_page'];
  if (!c.panel) return hidePanel(ship);

  if (c.panel === 'players') {
    tabs(ship, 'players');
    const others = game.ships.filter(s => s !== ship);
    const from = pageOf(ship, others.length);
    c.rows = others.slice(from, from + ROWS).map(s => s.id);
    if (!others.length) { emptyNote(ship, 'No other players yet'); keep.push('ek_list'); }
    c.rows.forEach((id, i) => {
      const y = 25 + i * 5.6;
      // every row has its own background: a big panel box would end up on top of the buttons
      ship.setUIComponent({ id: `ek_n${i}`, position: [30, y, 26, 4.6], visible: true,
        components: [box(), { type: 'player', id, position: [5, 15, 90, 70], color: COLOR.text, align: 'left' }] });
      button(ship, `ek_k${i}`, [56.5, y, 6, 4.6], 'Kick', true);
      button(ship, `ek_b${i}`, [63, y, 7, 4.6], 'Ban', true, COLOR.red);
      keep.push(`ek_n${i}`, `ek_k${i}`, `ek_b${i}`);
    });
    return hidePanel(ship, keep);
  }

  if (c.panel === 'bans') {
    tabs(ship, 'bans');
    const names = Object.keys(bans).sort();
    const start = pageOf(ship, names.length);
    c.banRows = names.slice(start, start + ROWS);
    if (!names.length) { emptyNote(ship, 'Nobody is banned'); keep.push('ek_list'); }
    c.banRows.forEach((name, i) => {
      const { reason, by } = bans[name], y = 25 + i * 5.6;
      ship.setUIComponent({ id: `ek_bn${i}`, position: [30, y, 32.5, 4.6], visible: true,
        components: [box(), text(name, [3, 4, 94, 46], COLOR.text, 'left'), text(`${reason}   by ${by}`, [3, 52, 94, 40], COLOR.dim, 'left')] });
      button(ship, `ek_u${i}`, [63, y, 7, 4.6], 'Unban', true, COLOR.green);
      keep.push(`ek_bn${i}`, `ek_u${i}`);
    });
    return hidePanel(ship, keep);
  }

  // reason picker
  const p = c.pending, t = game.findShip(p.id), action = p.ban ? 'ban' : 'kick';
  ship.setUIComponent({ id: 'ek_list', position: [30, 18, 40, 10], visible: true,
    components: [box(p.ban ? COLOR.red : COLOR.line), text(`${p.ban ? 'Ban' : 'Kick'} ${t ? t.name : '?'}`, [0, 8, 100, 45], p.ban ? COLOR.red : COLOR.gold),
      text(`Pick a reason, or type  ${action} ${p.id} your reason  in the console`, [0, 58, 100, 30], COLOR.dim)] });
  const reasonKeep = ['ek_list', 'ek_cancel'];
  REASONS.forEach((reason, i) => {
    button(ship, `ek_r${i}`, [35, 30 + i * 6.5, 30, 5.2], reason, true, p.ban ? COLOR.red : undefined);
    reasonKeep.push(`ek_r${i}`);
  });
  button(ship, 'ek_cancel', [35, 30 + REASONS.length * 6.5 + 1, 30, 5.2], 'Cancel', true);
  hidePanel(ship, reasonKeep);
}

function panelClick(ship, id) {
  const c = stats(ship);
  let m;
  if (id === 'ek_players') { c.panel = c.panel ? null : 'players'; c.pending = null; c.page = 0; drawButtons(ship); }
  else if (id === 'ek_tabp' || id === 'ek_tabb') { c.panel = id === 'ek_tabp' ? 'players' : 'bans'; c.pending = null; c.page = 0; }
  else if (id === 'ek_page') c.page++; // drawPanel wraps it back to page 1 after the last page
  else if (id === 'ek_cancel') { c.panel = 'players'; c.pending = null; }
  else if ((m = /^ek_([kb])(\d+)$/.exec(id))) {
    const target = game.findShip(c.rows[Number(m[2])]);
    if (target) { c.panel = 'reason'; c.pending = { id: target.id, ban: m[1] === 'b' }; }
  } else if ((m = /^ek_r(\d+)$/.exec(id)) && c.pending) {
    const t = game.findShip(c.pending.id);
    if (t) removePlayer(t, c.pending.ban, REASONS[Number(m[1])], ship.name);
    c.panel = 'players';
    c.pending = null;
  } else if ((m = /^ek_u(\d+)$/.exec(id))) {
    const name = (c.banRows ?? [])[Number(m[1])];
    if (name && bans[name]) { delete bans[name]; echo(`${name} was unbanned by ${ship.name}`); }
  } else return;
  drawPanel(ship);
}

function announce(msg, seconds) {
  ev.banner = msg;
  ev.bannerEnds = game.step + seconds * 60;
  game.setUIComponent({ id: 'ek_banner', position: [25, 18, 50, 8], visible: true, components: [text(msg, [0, 0, 100, 100], COLOR.gold)] });
}

function showResults(top) {
  const rows = [text('ROUND OVER', [0, 4, 100, 18], COLOR.gold)];
  const medals = ['1st', '2nd', '3rd'];
  top.forEach((s, i) => {
    const c = stats(s), y = 28 + i * 22;
    rows.push(text(medals[i], [4, y, 12, 12], COLOR.gold, 'left'));
    rows.push({ type: 'player', id: s.id, position: [16, y, 80, 12], color: COLOR.text, align: 'left' });
    rows.push(text(`${c.kills} kills, ${c.deaths} deaths`, [16, y + 12, 80, 8], COLOR.dim, 'left'));
  });
  if (!top.length) rows.push(text('Nobody played', [0, 40, 100, 16], COLOR.dim));
  game.setUIComponent({ id: 'ek_results', position: [30, 28, 40, 26], visible: true, components: [box(), ...rows] });
  ev.results = game.step + 12 * 60;
}

function hideResults() {
  ev.results = 0;
  game.setUIComponent({ id: 'ek_results', visible: false });
}

function drawScoreboard(game) {
  const head = ev.state === 'live' ? `LIVE  ${clock(ev.ends - game.step)}`
    : ev.state === 'countdown' ? `STARTING  ${clock(ev.ends - game.step)}` : 'LOBBY';
  const rows = [
    text(head, [0, 0, 100, 8], ev.state === 'live' ? COLOR.gold : COLOR.text),
    text('K / D', [70, 9, 28, 6], COLOR.dim, 'right'),
  ];
  ranked(game).slice(0, 10).forEach((s, i) => {
    const c = stats(s), y = 16 + i * 8;
    rows.push({ type: 'player', id: s.id, position: [2, y, 70, 7], color: COLOR.text, align: 'left' });
    rows.push(text(`${c.kills} / ${c.deaths}`, [70, y, 28, 7], COLOR.text, 'right'));
  });
  const watching = game.ships.length - players(game).length;
  if (watching) rows.push(text(`${watching} spectating`, [0, 96, 100, 4], COLOR.dim));
  game.setUIComponent({ id: 'scoreboard', visible: true, components: rows });
}

// ---- game loop

this.tick = function (game) {
  if (!ev.commands) { ev.commands = true; addCommands(); }
  if (ev.state === 'countdown' && game.step >= ev.ends) goLive();
  if (ev.state === 'live' && game.step >= ev.ends) endRound();
  if (ev.banner && game.step >= ev.bannerEnds) {
    ev.banner = null;
    game.setUIComponent({ id: 'ek_banner', visible: false });
  }
  if (ev.results && game.step >= ev.results) hideResults();
  if (game.step % 2 === 0) followTick(game);
  if (game.step % 10 === 0) banTick(game);

  if (game.step % 30 === 0) {
    for (const ship of game.ships) {
      const c = stats(ship);
      checkBan(ship);
      if (c.drawnState !== ev.state) { c.drawnState = ev.state; drawButtons(ship); }
      if ((c.panel === 'players' || c.panel === 'bans') && game.step % 120 === 0) drawPanel(ship); // players come and go
    }
    drawScoreboard(game);
  }
};

this.event = function (event, game) {
  const ship = event.ship;
  switch (event.name) {
    case 'ship_spawned': {
      if (!ship) break;
      checkBan(ship);
      const c = stats(ship);
      if (c.spec) ship.set({ type: c.follow == null ? FREE_CAM : FOLLOW_CAM, collider: false });
      else if (ev.state === 'countdown') ship.set({ idle: true });
      break;
    }
    case 'ship_destroyed': {
      if (!ship || ev.state !== 'live') break;
      stats(ship).deaths++;
      const k = event.killer;
      if (k && k !== ship && game.findShip(k.id) === k) stats(k).kills++;
      break;
    }
    case 'ui_component_clicked': {
      const c = stats(ship), id = event.id;
      if (id === 'ek_spec') { if (canSpectate(ship) || c.spec) setSpectate(ship, !c.spec); }
      else if (id === 'ek_prev' || id === 'ek_next') { if (c.spec) cycleFollow(ship, id === 'ek_next' ? 1 : -1); }
      else if (!isAdmin(ship)) break;
      else if (id === 'ek_round') { if (roundRunning()) endRound(); else round(); }
      else panelClick(ship, id);
      break;
    }
  }
};
