// Starblast Event Kit by Zyrvaen
// A mod for running community events: timed rounds, a kills/deaths scoreboard,
// spectating (free or following a player), kick/ban with a reason, announcements.
//
// Paste this into the mod editor (starblast.io/modding.html), then in the console:
//   region Europe      (or America / Asia)
//   start
// Share the link the console prints. Console commands while it runs:
//   round 300          start a round of 300 seconds (10 s countdown first)
//   endround           stop the round now and show the results
//   say Hello!         message on everyone's screen
//   list               players with their id
//   admin 3            player 3 may spectate, kick, ban and run rounds (a name works too: admin test)
//   spectator 3        player 3 may spectate
//   player 3           take those rights away again
//   kick 3 reason      remove player 3 (reason is optional)
//   ban 3 reason       remove player 3 and keep that name out
//   unban NAME         let a banned name back in
//   bans               show all bans
// Keep the editor tab open and in front, or the mod slows down.

// Normal players only play. These names get more when they join:
var ADMINS = ['ZYRVAEN'];       // spectate, kick, ban, run rounds
var SPECTATORS = [];            // spectate only
var ROUND_SECONDS = 300;
var COUNTDOWN_SECONDS = 10;
var REASONS = ['Cheating', 'Toxic / spam', 'Teaming', 'AFK', 'No reason given'];

// two invisible spectator ships: zoomed out for the free camera, normal view for following
// (a lower zoom value shows more of the map)
function spectatorShip(model, zoom) {
  var specs = { shield: { capacity: [1e-30, 1e-30], reload: [1000, 1000] }, generator: { capacity: [1e-30, 1e-30], reload: [1, 1] },
    ship: { mass: 1, speed: [200, 200], rotation: [1000, 1000], acceleration: [1000, 1000] } };
  var shape = [];
  for (var i = 0; i < 50; i++) shape.push(0.001);
  return JSON.stringify({
    name: 'Spectator', level: 1, model: model, size: 0.025, zoom: zoom, specs: specs,
    bodies: { face: { section_segments: 100, angle: 0, offset: { x: 0, y: 0, z: 0 }, position: { x: [0, 0, 0, 0], y: [-2, -2, 2, 2], z: [0, 0, 0, 0] },
      width: [0, 1, 1, 0], height: [0, 1, 1, 0], vertical: true, texture: [6] } },
    typespec: { name: 'Spectator', level: 1, model: model, code: 100 + model, specs: specs, shape: shape, lasers: [], radius: 0.001 },
  });
}
var FREE_CAM = 191, FOLLOW_CAM = 192;

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

var ev = { state: 'lobby', ends: 0, banner: null, bannerEnds: 0, results: 0 };
var bans = {}; // NAME -> { reason, by }
var COLOR = { text: '#dde8f0', dim: '#8aa0b0', box: 'rgba(10,20,30,0.85)', line: '#2f5a6d', gold: '#ffd060', red: '#ff8080', green: '#80ffa0' };
var ROWS = 8;

function stats(ship) {
  var c = ship.custom;
  if (c.kills == null) {
    Object.assign(c, { kills: 0, deaths: 0, spec: false, follow: null, panel: null, page: 0, rows: [], pending: null,
      role: roleByName(ship.name) });
  }
  return c;
}

function roleByName(name) {
  name = String(name).toUpperCase();
  var has = function (list) { return list.some(function (n) { return n.toUpperCase() === name; }); };
  return has(ADMINS) ? 'admin' : has(SPECTATORS) ? 'spectator' : 'player';
}

function isAdmin(ship) { return stats(ship).role === 'admin'; }
function canSpectate(ship) { return stats(ship).role !== 'player'; }

function setRole(ship, role) {
  var c = stats(ship);
  c.role = role;
  if (role === 'player' && c.spec) setSpectate(ship, false);
  if (role !== 'admin' && c.panel) { c.panel = null; c.pending = null; drawPanel(ship); }
  drawButtons(ship);
}

function players(game) {
  return game.ships.filter(function (s) { return !stats(s).spec; });
}

function ranked(game) {
  return players(game).sort(function (a, b) {
    var x = stats(a), y = stats(b);
    return y.kills - x.kills || x.deaths - y.deaths || b.score - a.score;
  });
}

function clock(ticks) {
  var s = Math.max(0, Math.ceil(ticks / 60));
  return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
}

function randomSpot(game) {
  var half = game.options.map_size * 5 - 20;
  return { x: (Math.random() * 2 - 1) * half, y: (Math.random() * 2 - 1) * half };
}

// ---- spectating

function setSpectate(ship, on) {
  var c = stats(ship);
  if (on === c.spec) return;
  c.spec = on;
  c.follow = null;
  if (on) {
    if (ship.type !== FREE_CAM && ship.type !== FOLLOW_CAM) c.prevType = ship.type;
    ship.set({ type: FREE_CAM, collider: false, crystals: 0 });
  } else {
    ship.set({ type: c.prevType || game.options.starting_ship || 101, collider: true, invulnerable: 180, stats: 0, shield: 1000 });
  }
  drawButtons(ship);
}

// < and > walk through: free camera, player 1, player 2, ... and around again
function cycleFollow(ship, step) {
  var c = stats(ship), list = players(game);
  var ids = [null].concat(list.map(function (s) { return s.id; }));
  var i = ids.indexOf(c.follow);
  c.follow = ids[((i < 0 ? 0 : i) + step + ids.length) % ids.length];
  ship.set({ type: c.follow == null ? FREE_CAM : FOLLOW_CAM, collider: false });
  drawButtons(ship);
}

function followTick(game) {
  game.ships.forEach(function (ship) {
    var c = stats(ship);
    if (!c.spec || c.follow == null) return;
    var t = game.findShip(c.follow);
    if (!t || stats(t).spec) { c.follow = null; ship.set({ type: FREE_CAM }); drawButtons(ship); return; }
    ship.set({ x: t.x, y: t.y, vx: t.vx, vy: t.vy });
  });
}

// ---- rounds

function round(seconds) {
  if (ev.state === 'countdown' || ev.state === 'live') return echo('A round is already running, type endround first');
  ROUND_SECONDS = seconds || ROUND_SECONDS;
  ev.state = 'countdown';
  ev.ends = game.step + COUNTDOWN_SECONDS * 60;
  hideResults();
  players(game).forEach(function (ship) {
    var c = stats(ship), p = randomSpot(game);
    c.kills = c.deaths = 0;
    ship.set({ x: p.x, y: p.y, vx: 0, vy: 0, type: game.options.starting_ship || 101, stats: 0, crystals: 0, score: 0,
      shield: 1000, idle: true, invulnerable: COUNTDOWN_SECONDS * 60 + 120 });
  });
  announce('Round starts in ' + COUNTDOWN_SECONDS + ' seconds', COUNTDOWN_SECONDS);
  echo('Round of ' + ROUND_SECONDS + ' s is starting');
}

function goLive() {
  ev.state = 'live';
  ev.ends = game.step + ROUND_SECONDS * 60;
  players(game).forEach(function (ship) { ship.set({ idle: false }); });
  announce('GO!', 3);
}

function endRound() {
  if (ev.state !== 'countdown' && ev.state !== 'live') return echo('No round is running');
  ev.state = 'lobby';
  game.ships.forEach(function (ship) { ship.set({ idle: false }); });
  var top = ranked(game).slice(0, 3);
  announce('Round over', 4); // also replaces a countdown message that may still be up
  showResults(top);
  echo('Round over. ' + (top.length ? 'Winner: ' + top[0].name + ' (' + stats(top[0]).kills + ' kills)' : 'Nobody played'));
}

// ---- kick and ban

function removePlayer(target, ban, reason, by) {
  reason = reason || 'No reason given';
  var name = String(target.name).toUpperCase();
  if (ban) bans[name] = { reason: reason, by: by || 'the host' };
  target.gameover(endScreen(ban, reason, by));
  echo(target.name + (ban ? ' was banned: ' : ' was kicked: ') + reason);
  announce(target.name + (ban ? ' was banned' : ' was kicked'), 4);
}

// the game over screen hides rows with an empty value, so every row gets one
function endScreen(ban, reason, by) {
  var screen = {};
  screen[ban ? 'Banned by' : 'Kicked by'] = by || 'the host';
  screen.Reason = reason;
  if (ban) screen.Rejoin = 'Not allowed';
  return screen;
}

// a banned name is sent away 1.5 s after joining: earlier, the game hasn't
// finished loading on their side and they'd only see a grey screen
function checkBan(ship) {
  var c = stats(ship);
  if (c.banChecked) return;
  c.banChecked = true;
  if (bans[String(ship.name).toUpperCase()]) c.banAt = game.step + 90;
}

function banTick(game) {
  game.ships.forEach(function (ship) {
    var c = stats(ship), b = bans[String(ship.name).toUpperCase()];
    if (!c.banAt || game.step < c.banAt) return;
    c.banAt = 0;
    if (b) ship.gameover(endScreen(true, b.reason, b.by));
  });
}

// ---- console commands (the console only sees `game`, so they're added to its command list)

// a player by id ("3") or by name ("test", any case)
function findPlayer(arg) {
  arg = String(arg || '').trim();
  var s = /^\d+$/.test(arg) ? game.findShip(Number(arg)) : null;
  if (!s) {
    var name = arg.toUpperCase();
    var found = game.ships.filter(function (x) { return String(x.name).toUpperCase() === name; });
    if (found.length > 1) { echo('More players are called ' + arg + ', use their id (type list)'); return null; }
    s = found[0] || null;
  }
  if (!s) echo('No player "' + arg + '", type list to see names and ids');
  return s;
}

function giveRole(arg, role, msg) {
  var s = findPlayer(arg);
  if (!s) return;
  setRole(s, role);
  echo(s.name + ' ' + msg);
}

function idAndReason(arg) {
  var m = /^(\S+)\s*(.*)$/.exec(arg || '');
  return m ? { id: m[1], reason: m[2] } : { id: '', reason: '' };
}

var COMMANDS = {
  round: function (arg) { round(Number(arg) || 0); },
  endround: function () { endRound(); },
  say: function (arg) { if (arg) announce(arg, 8); },
  list: function () {
    if (!game.ships.length) return echo('Nobody is here yet');
    game.ships.forEach(function (s) {
      var c = stats(s);
      echo(s.id + '  ' + s.name + '  ' + c.kills + '/' + c.deaths + (c.role !== 'player' ? '  (' + c.role + ')' : '') + (c.spec ? '  spectating' : ''));
    });
  },
  admin: function (arg) { giveRole(arg, 'admin', 'is now an admin (spectate, kick, ban, rounds)'); },
  spectator: function (arg) { giveRole(arg, 'spectator', 'can now spectate'); },
  player: function (arg) { giveRole(arg, 'player', 'is a normal player again'); },
  kick: function (arg) { var a = idAndReason(arg), s = findPlayer(a.id); if (s) removePlayer(s, false, a.reason, 'the host'); },
  ban: function (arg) { var a = idAndReason(arg), s = findPlayer(a.id); if (s) removePlayer(s, true, a.reason, 'the host'); },
  unban: function (arg) {
    var name = String(arg || '').toUpperCase();
    if (!(name in bans)) return echo('No ban for "' + arg + '", type bans to see them');
    delete bans[name];
    echo(name + ' is no longer banned');
  },
  bans: function () {
    var names = Object.keys(bans);
    if (!names.length) return echo('Nobody is banned');
    names.forEach(function (n) { echo(n + ': ' + bans[n].reason + '  (by ' + bans[n].by + ')'); });
  },
};

function addCommands() {
  Object.keys(COMMANDS).forEach(function (name) {
    game.modding.commands[name] = function (line) { COMMANDS[name](line.slice(name.length).trim()); };
  });
  echo('Event Kit ready. Commands: round [s], endround, say [text], list, admin [id], spectator [id], player [id], kick [id] [reason], ban [id] [reason], unban [name], bans');
}

// ---- UI

function text(value, pos, color, align) {
  return { type: 'text', position: pos, value: value, color: color || COLOR.text, align: align || 'center' };
}

function box(stroke) {
  return { type: 'box', position: [0, 0, 100, 100], fill: COLOR.box, stroke: stroke || COLOR.line, width: 2 };
}

function button(ship, id, pos, label, visible, color) {
  ship.setUIComponent({ id: id, position: pos, clickable: true, visible: !!visible, components: [box(color), text(label, [0, 22, 100, 56], color)] });
}

function hide(ship, id) {
  ship.setUIComponent({ id: id, visible: false });
}

// left column: Spectate, < >, Start round, Players
function drawButtons(ship) {
  var c = stats(ship), live = ev.state === 'countdown' || ev.state === 'live';
  button(ship, 'ek_spec', [1, 44, 9, 5], c.spec ? 'Play' : 'Spectate', canSpectate(ship));
  button(ship, 'ek_prev', [1, 50, 4.4, 5], '<', c.spec);
  button(ship, 'ek_next', [5.6, 50, 4.4, 5], '>', c.spec);
  var f = c.follow != null && game.findShip(c.follow);
  ship.setUIComponent({ id: 'ek_watch', position: [30, 9, 40, 4], visible: c.spec,
    components: [text(f ? 'Watching ' + f.name : 'Free camera   ( < > to follow a player )', [0, 0, 100, 100], COLOR.gold)] });
  button(ship, 'ek_round', [1, 56, 9, 5], live ? 'End round' : 'Start round', isAdmin(ship), live ? COLOR.red : COLOR.green);
  button(ship, 'ek_players', [1, 62, 9, 5], c.panel ? 'Close' : 'Players', isAdmin(ship));
}

// admin panel: tabs "Players" (kick / ban, then pick a reason) and "Banned" (unban)
var PANEL_IDS = ['ek_tabp', 'ek_tabb', 'ek_list', 'ek_page', 'ek_cancel'];

function hidePanel(ship, keep) {
  var ids = PANEL_IDS.slice(), i;
  for (i = 0; i < ROWS; i++) ids.push('ek_n' + i, 'ek_k' + i, 'ek_b' + i, 'ek_bn' + i, 'ek_u' + i);
  for (i = 0; i < REASONS.length; i++) ids.push('ek_r' + i);
  ids.forEach(function (id) { if (!keep || keep.indexOf(id) < 0) hide(ship, id); });
}

function tabs(ship, view) {
  var n = Object.keys(bans).length;
  button(ship, 'ek_tabp', [30, 18, 19.5, 5.5], 'Players', true, view === 'players' ? COLOR.gold : null);
  button(ship, 'ek_tabb', [50.5, 18, 19.5, 5.5], 'Banned (' + n + ')', true, view === 'bans' ? COLOR.gold : null);
}

function pageOf(ship, total) {
  var c = stats(ship), pages = Math.max(1, Math.ceil(total / ROWS));
  if (c.page >= pages) c.page = 0;
  button(ship, 'ek_page', [56.5, 70, 13.5, 4.6], 'Next page (' + (c.page + 1) + '/' + pages + ')', pages > 1);
  return c.page * ROWS;
}

function drawPanel(ship) {
  var c = stats(ship), i, y, keep = [];
  if (!c.panel) return hidePanel(ship);

  if (c.panel === 'players') {
    tabs(ship, 'players');
    var others = game.ships.filter(function (s) { return s !== ship; });
    var from = pageOf(ship, others.length);
    c.rows = others.slice(from, from + ROWS).map(function (s) { return s.id; });
    if (!others.length) {
      ship.setUIComponent({ id: 'ek_list', position: [30, 25, 40, 5], visible: true, components: [text('No other players yet', [0, 0, 100, 100], COLOR.dim)] });
      keep.push('ek_list');
    }
    c.rows.forEach(function (id, i) {
      y = 25 + i * 5.6;
      // every row has its own background: a big panel box would end up on top of the buttons
      ship.setUIComponent({ id: 'ek_n' + i, position: [30, y, 26, 4.6], visible: true,
        components: [box(), { type: 'player', id: id, position: [5, 15, 90, 70], color: COLOR.text, align: 'left' }] });
      button(ship, 'ek_k' + i, [56.5, y, 6, 4.6], 'Kick', true);
      button(ship, 'ek_b' + i, [63, y, 7, 4.6], 'Ban', true, COLOR.red);
      keep.push('ek_n' + i, 'ek_k' + i, 'ek_b' + i);
    });
    return hidePanel(ship, keep.concat('ek_tabp', 'ek_tabb', 'ek_page'));
  }

  if (c.panel === 'bans') {
    tabs(ship, 'bans');
    var names = Object.keys(bans).sort();
    var start = pageOf(ship, names.length);
    c.banRows = names.slice(start, start + ROWS);
    if (!names.length) {
      ship.setUIComponent({ id: 'ek_list', position: [30, 25, 40, 5], visible: true, components: [text('Nobody is banned', [0, 0, 100, 100], COLOR.dim)] });
      keep.push('ek_list');
    }
    c.banRows.forEach(function (name, i) {
      var b = bans[name];
      y = 25 + i * 5.6;
      ship.setUIComponent({ id: 'ek_bn' + i, position: [30, y, 32.5, 4.6], visible: true,
        components: [box(), text(name, [3, 4, 94, 46], COLOR.text, 'left'), text(b.reason + '   by ' + b.by, [3, 52, 94, 40], COLOR.dim, 'left')] });
      button(ship, 'ek_u' + i, [63, y, 7, 4.6], 'Unban', true, COLOR.green);
      keep.push('ek_bn' + i, 'ek_u' + i);
    });
    return hidePanel(ship, keep.concat('ek_tabp', 'ek_tabb', 'ek_page'));
  }

  // reason picker
  var p = c.pending, t = game.findShip(p.id);
  ship.setUIComponent({ id: 'ek_list', position: [30, 18, 40, 10], visible: true,
    components: [box(p.ban ? COLOR.red : COLOR.line), text((p.ban ? 'Ban ' : 'Kick ') + (t ? t.name : '?'), [0, 8, 100, 45], p.ban ? COLOR.red : COLOR.gold),
      text('Pick a reason, or type  ' + (p.ban ? 'ban ' : 'kick ') + p.id + ' your reason  in the console', [0, 58, 100, 30], COLOR.dim)] });
  for (i = 0; i < REASONS.length; i++) { button(ship, 'ek_r' + i, [35, 30 + i * 6.5, 30, 5.2], REASONS[i], true, p.ban ? COLOR.red : null); keep.push('ek_r' + i); }
  button(ship, 'ek_cancel', [35, 30 + REASONS.length * 6.5 + 1, 30, 5.2], 'Cancel', true);
  hidePanel(ship, keep.concat('ek_list', 'ek_cancel'));
}

function panelClick(ship, id) {
  var c = stats(ship), m;
  if (id === 'ek_players') { c.panel = c.panel ? null : 'players'; c.pending = null; c.page = 0; drawButtons(ship); }
  else if (id === 'ek_tabp' || id === 'ek_tabb') { c.panel = id === 'ek_tabp' ? 'players' : 'bans'; c.pending = null; c.page = 0; }
  else if (id === 'ek_page') c.page++; // drawPanel wraps it back to page 1 after the last page
  else if (id === 'ek_cancel') { c.panel = 'players'; c.pending = null; }
  else if ((m = /^ek_([kb])(\d+)$/.exec(id))) {
    var target = game.findShip(c.rows[Number(m[2])]);
    if (target) { c.panel = 'reason'; c.pending = { id: target.id, ban: m[1] === 'b' }; }
  } else if ((m = /^ek_r(\d+)$/.exec(id)) && c.pending) {
    var t = game.findShip(c.pending.id);
    if (t) removePlayer(t, c.pending.ban, REASONS[Number(m[1])], ship.name);
    c.panel = 'players';
    c.pending = null;
  } else if ((m = /^ek_u(\d+)$/.exec(id))) {
    var name = (c.banRows || [])[Number(m[1])];
    if (name && bans[name]) { delete bans[name]; echo(name + ' was unbanned by ' + ship.name); }
  } else return;
  drawPanel(ship);
}

function announce(msg, seconds) {
  ev.banner = msg;
  ev.bannerEnds = game.step + seconds * 60;
  game.setUIComponent({ id: 'ek_banner', position: [25, 18, 50, 8], visible: true, components: [text(msg, [0, 0, 100, 100], COLOR.gold)] });
}

function showResults(top) {
  var rows = [text('ROUND OVER', [0, 4, 100, 18], COLOR.gold)];
  var medals = ['1st', '2nd', '3rd'];
  top.forEach(function (s, i) {
    var c = stats(s), y = 28 + i * 22;
    rows.push(text(medals[i], [4, y, 12, 12], COLOR.gold, 'left'));
    rows.push({ type: 'player', id: s.id, position: [16, y, 80, 12], color: COLOR.text, align: 'left' });
    rows.push(text(c.kills + ' kills, ' + c.deaths + ' deaths', [16, y + 12, 80, 8], COLOR.dim, 'left'));
  });
  if (!top.length) rows.push(text('Nobody played', [0, 40, 100, 16], COLOR.dim));
  game.setUIComponent({ id: 'ek_results', position: [30, 28, 40, 26], visible: true, components: [box()].concat(rows) });
  ev.results = game.step + 12 * 60;
}

function hideResults() {
  ev.results = 0;
  game.setUIComponent({ id: 'ek_results', visible: false });
}

function drawScoreboard(game) {
  var head = ev.state === 'live' ? 'LIVE  ' + clock(ev.ends - game.step)
    : ev.state === 'countdown' ? 'STARTING  ' + clock(ev.ends - game.step) : 'LOBBY';
  var rows = [
    text(head, [0, 0, 100, 8], ev.state === 'live' ? COLOR.gold : COLOR.text),
    text('K / D', [70, 9, 28, 6], COLOR.dim, 'right'),
  ];
  ranked(game).slice(0, 10).forEach(function (s, i) {
    var c = stats(s), y = 16 + i * 8;
    rows.push({ type: 'player', id: s.id, position: [2, y, 70, 7], color: COLOR.text, align: 'left' });
    rows.push(text(c.kills + ' / ' + c.deaths, [70, y, 28, 7], COLOR.text, 'right'));
  });
  var watching = game.ships.length - players(game).length;
  if (watching) rows.push(text(watching + ' spectating', [0, 96, 100, 4], COLOR.dim));
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
    game.ships.forEach(function (ship) {
      var c = stats(ship);
      checkBan(ship);
      if (c.drawnState !== ev.state) { c.drawnState = ev.state; drawButtons(ship); }
      if ((c.panel === 'players' || c.panel === 'bans') && game.step % 120 === 0) drawPanel(ship); // players come and go
    });
    drawScoreboard(game);
  }
};

this.event = function (event, game) {
  var ship = event.ship;
  switch (event.name) {
    case 'ship_spawned':
      if (!ship) break;
      checkBan(ship);
      if (stats(ship).spec) ship.set({ type: stats(ship).follow == null ? FREE_CAM : FOLLOW_CAM, collider: false });
      else if (ev.state === 'countdown') ship.set({ idle: true });
      break;
    case 'ship_destroyed':
      if (!ship || ev.state !== 'live') break;
      stats(ship).deaths++;
      var k = event.killer;
      if (k && k !== ship && game.findShip(k.id) === k) stats(k).kills++;
      break;
    case 'ui_component_clicked':
      var c = stats(ship), id = event.id;
      if (id === 'ek_spec') { if (canSpectate(ship) || c.spec) setSpectate(ship, !c.spec); }
      else if (id === 'ek_prev' || id === 'ek_next') { if (c.spec) cycleFollow(ship, id === 'ek_next' ? 1 : -1); }
      else if (!isAdmin(ship)) break;
      else if (id === 'ek_round') { if (ev.state === 'countdown' || ev.state === 'live') endRound(); else round(); }
      else panelClick(ship, id);
      break;
  }
};
