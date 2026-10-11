// Space Soccer by Zyrvaen
// Two teams, one ball (an asteroid), 15 minute matches. Shooting is allowed, T6 ships only.
// How to use it and all commands: https://github.com/Zyrvaen/Starblast-Scripts
// Keep the editor tab open and in front while the mod runs.

const ADMINS = ['ZYRVAEN'];      // these names can start matches, kick and ban
let MATCH_MINUTES = 15;          // 0 = no time limit
let GOAL_LIMIT = 0;              // first team to this many goals wins, 0 = no goal limit
const TIME_CHOICES = [0, 5, 10, 15, 20, 30], GOAL_CHOICES = [0, 3, 5, 7, 10];
const T6_SHIPS = [601, 602, 603, 604, 605, 606, 607, 608];
const REASONS = ['Cheating', 'Toxic / spam', 'Griefing', 'AFK', 'No reason given'];
const SHIP_NAMES = { 601: 'Advanced-Fighter', 602: 'Scorpion', 603: 'Marauder', 604: 'Condor',
  605: 'A-Speedster', 606: 'Rock-Tower', 607: 'H-Mercury', 608: 'Barracuda' };
const MAXED = 66666666;          // all 8 stats fully upgraded for a T6 ship
const isT6 = type => T6_SHIPS.includes(type);

// ball tuning: change these if the ball feels too slow, too fast or too floaty
let BALL_SIZE = 30;              // asteroid size, 1 to 100 (admins can change it in the Match tab)
const BALL_CHOICES = [[10, 'Tiny'], [20, 'Small'], [30, 'Normal'], [60, 'Big'], [100, 'Huge']];
const BALL_FRICTION = 0.985;     // speed kept per 1/10 s, lower = stops sooner
const TOUCH_RANGE = 30;          // how close a ship must be to the edge of the ball to count as touching it
const KNOCKOUT_SHIELD = 0.15;    // below this part of your shield you're sent back to your goal

// ---- field: walls of asteroids with a goal pocket on each side

// The map is 40 x 40 cells of 10 x 10 (400 x 400). Everything is rock except the field
// (320 x 260) and the two goal pockets (60 wide).
const N = 40;
const WALL = { top: 6, bottom: 33, left: 3, right: 36, goalTop: 17, goalBottom: 22 };
const FIELD = { x: 160, y: 130, goal: 30 }; // half width, half height, half goal mouth

function fieldMap() {
  const w = WALL, rows = [];
  for (let r = 0; r < N; r++) {
    let line = '';
    for (let c = 0; c < N; c++) {
      const field = r > w.top && r < w.bottom && c > w.left && c < w.right;
      const pocket = r >= w.goalTop && r <= w.goalBottom && c > 0 && c < N - 1 && (c <= w.left || c >= w.right);
      line += field || pocket ? ' ' : '9';
    }
    rows.push(line);
  }
  return rows.join('\n');
}

// invisible ships: a wide view for spectators, a normal view for the goal camera.
// A small shield and energy so the game doesn't warn about them; they never collide anyway.
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
const SPEC_TYPE = 191, GOAL_CAM = 192;

this.options = {
  root_mode: '',
  map_size: N,
  custom_map: fieldMap(),
  asteroids_strength: 1000000,  // walls and ball can't be destroyed
  friendly_colors: 2,
  choose_ship: T6_SHIPS,        // the game's own ship picker, every time you (re)spawn
  max_level: 6,
  starting_ship: 601,
  starting_ship_maxed: true,
  crystal_value: 0,
  weapons_store: false,
  lives: 5,
  maxtierlives: 5,
  max_players: 30,
  ships: [spectatorShip(91, 0.04), spectatorShip(92, 0.03)],
};

// ---- field lines: thin flat blocks lying just under the ships, and the same field on the radar

const CUBE = 'https://raw.githubusercontent.com/pmgl/starblast-modding/master/objects/cube/cube.obj';
const CUBE_SIZE = 5.3536;  // the model is 5.3536 wide on every axis (measured from its vertices)
const paint = (id, color) => ({ id, obj: CUBE, emissiveColor: color, diffuseColor: color });
const PAINT = {
  white: paint('ss_white', 0xdde8f0),
  red: paint('ss_redline', 0xff5050),
  blue: paint('ss_blueline', 0x5090ff),
  gold: paint('ss_gold', 0xffd060),
  green: paint('ss_green', 0x80ffa0),
};
const LINE_WIDTH = 2, LINE_DEPTH = -3; // depth below 0 keeps the lines under the ships
const CIRCLE = 35, BOX = { depth: 40, half: 60 }; // centre circle radius, penalty area size

// ext: how much longer than the segment a piece is. 0 for lines that end inside another line,
// LINE_WIDTH to fill a corner, a little for circle pieces so they join without gaps.
function fieldLines() {
  const lines = [];
  const add = (x1, y1, x2, y2, ext, color = 'white') => lines.push({ x1, y1, x2, y2, ext, color });
  const ring = (r, pieces, ext) => {
    for (let i = 0; i < pieces; i++) {
      const a = i / pieces * Math.PI * 2, b = (i + 1) / pieces * Math.PI * 2;
      add(r * Math.cos(a), r * Math.sin(a), r * Math.cos(b), r * Math.sin(b), ext);
    }
  };
  add(0, -FIELD.y, 0, FIELD.y, 0);      // half-way line, wall to wall
  ring(CIRCLE, 48, 0.6);                 // centre circle
  ring(2, 8, 1.6);                       // centre spot: a tiny ring thick enough to look like a dot
  for (const side of [-1, 1]) {          // penalty areas and goal mouths
    const gx = side * FIELD.x, bx = side * (FIELD.x - BOX.depth);
    add(gx, BOX.half, bx, BOX.half, 0);
    add(gx, -BOX.half, bx, -BOX.half, 0);
    add(bx, -BOX.half, bx, BOX.half, LINE_WIDTH); // reaches over the ends of the two lines above: clean corners
    add(gx, -FIELD.goal, gx, FIELD.goal, 0, side < 0 ? 'red' : 'blue');
  }
  return lines;
}

function paintField() {
  fieldLines().forEach((l, i) => {
    const dx = l.x2 - l.x1, dy = l.y2 - l.y1, len = Math.hypot(dx, dy) + l.ext;
    game.setObject({ id: `ss_line${i}`, type: PAINT[l.color],
      position: { x: (l.x1 + l.x2) / 2, y: (l.y1 + l.y2) / 2, z: LINE_DEPTH },
      rotation: { x: 0, y: 0, z: Math.atan2(dy, dx) },
      scale: { x: len / CUBE_SIZE, y: LINE_WIDTH / CUBE_SIZE, z: 0.02 } });
  });
}

// the radar shows the whole map; positions are in percent of it
function radarField() {
  const px = x => (x + N * 5) / (N * 10) * 100, py = y => (N * 5 - y) / (N * 10) * 100;
  const line = 'rgba(220,232,240,0.5)';
  const rect = (x1, y1, x2, y2, stroke, fill = 'rgba(0,0,0,0)') =>
    ({ type: 'box', position: [px(x1), py(y2), px(x2) - px(x1), py(y1) - py(y2)], stroke, width: 2, fill });
  return { id: 'radar_background', visible: true, components: [
    rect(-FIELD.x, -FIELD.y, FIELD.x, FIELD.y, line, 'rgba(40,90,60,0.25)'),
    rect(-0.5, -FIELD.y, 0.5, FIELD.y, line),
    { type: 'round', position: [px(-CIRCLE), py(CIRCLE), px(CIRCLE) - px(-CIRCLE), py(-CIRCLE) - py(CIRCLE)], stroke: line, width: 2 },
    rect(-FIELD.x, -BOX.half, -FIELD.x + BOX.depth, BOX.half, line),
    rect(FIELD.x - BOX.depth, -BOX.half, FIELD.x, BOX.half, line),
    rect(-FIELD.x - 30, -FIELD.goal, -FIELD.x, FIELD.goal, '#ff7070', 'rgba(255,80,80,0.25)'),
    rect(FIELD.x, -FIELD.goal, FIELD.x + 30, FIELD.goal, '#70a8ff', 'rgba(80,140,255,0.25)'),
  ] };
}

// ---- state

const TEAMS = [{ name: 'RED', hue: 0, color: '#ff7070', side: -1 }, { name: 'BLUE', hue: 210, color: '#70a8ff', side: 1 }];
const COLOR = { text: '#dde8f0', dim: '#8aa0b0', box: 'rgba(10,20,30,0.85)', line: '#2f5a6d', gold: '#ffd060', red: '#ff8080', green: '#80ffa0' };
const ROWS = 8;

// state: warmup (free play), kickoff (frozen countdown), live, goal (short pause), ended
const m = { state: 'warmup', score: [0, 0], left: 0, until: 0, banner: null, bannerEnds: 0, results: 0 };
const ball = { ref: null, last: null, asking: 0 };
const bans = {}; // NAME -> { reason, by }

function stats(ship) {
  const c = ship.custom;
  if (c.goals == null) {
    const name = String(ship.name).toUpperCase();
    Object.assign(c, { goals: 0, owngoals: 0, knockouts: 0, kills: 0, deaths: 0, maxShield: 0, team: null, spec: false,
      panel: null, page: 0, rows: [], pending: null, role: ADMINS.some(n => n.toUpperCase() === name) ? 'admin' : 'player' });
  }
  return c;
}

const isAdmin = ship => stats(ship).role === 'admin';
const teamOf = t => game.ships.filter(s => !stats(s).spec && stats(s).team === t);
const running = () => m.state !== 'warmup' && m.state !== 'ended';
const scoreText = () => `RED ${m.score[0]} - ${m.score[1]} BLUE`;

function clock(ticks) {
  const s = Math.max(0, Math.ceil(ticks / 60));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---- teams and positions

function setTeam(ship, t) {
  stats(ship).team = t;
  ship.set({ team: t, hue: TEAMS[t].hue });
}

// the team with fewer players; if equal the one with fewer goals; if that's equal too, a coin flip
function pickTeam() {
  const a = teamOf(0).length, b = teamOf(1).length;
  if (a !== b) return a < b ? 0 : 1;
  if (m.score[0] !== m.score[1]) return m.score[0] < m.score[1] ? 0 : 1;
  return Math.random() < 0.5 ? 0 : 1;
}

function joinTeam(ship) {
  const c = stats(ship);
  if (c.team == null && !c.spec) setTeam(ship, pickTeam());
}

// somewhere in your own half, outside the centre circle
function homeSpot(t) {
  const side = TEAMS[t].side;
  return { x: side * (CIRCLE + 20 + Math.random() * (FIELD.x - CIRCLE - 50)), y: (Math.random() * 2 - 1) * (FIELD.y - 30) };
}

function sendHome(ship, extra = {}) {
  const p = homeSpot(stats(ship).team);
  ship.set({ x: p.x, y: p.y, vx: 0, vy: 0, shield: 1000, invulnerable: 180, collider: true, ...extra });
}

// ---- spectating and changing ship

// Spectating is the only way to switch teams: when you come back you join the team that needs you.
function setSpectate(ship, on) {
  const c = stats(ship);
  if (on === c.spec) return;
  if (on) {
    if (isT6(ship.type)) c.prevType = ship.type;
    c.goalCam = false;
    c.spec = true;
    c.team = null;
    ship.set({ type: SPEC_TYPE, collider: false, idle: false });
  } else {
    c.spec = false;
    setTeam(ship, pickTeam());
    ship.set({ type: c.prevType ?? T6_SHIPS[0], collider: true, stats: MAXED });
    sendHome(ship, m.state === 'kickoff' ? { idle: true } : {});
    echo(`${ship.name} joined ${TEAMS[c.team].name}`);
  }
  drawButtons(ship);
}

// Change ship: a row of ship cards like the game's own picker. You stay in your team, in its
// colour, and go back to your own half. (The game's intermission screen doesn't show up in
// this mode, so the mod draws the picker itself.) A spectator picks the ship for later.
function changeShip(ship, code) {
  const c = stats(ship);
  c.prevType = code;
  c.picking = false;
  drawShipPicker(ship);
  if (c.spec) return;
  ship.set({ type: code, stats: MAXED });
  setTeam(ship, c.team); // a new ship type can drop the team colour, so set it again
  sendHome(ship, m.state === 'kickoff' ? { idle: true } : {});
}

function drawShipPicker(ship) {
  const c = stats(ship);
  const ids = ['ss_pick', 'ss_shipx', ...T6_SHIPS.map((t, i) => `ss_ship${i}`)];
  if (!c.picking) { for (const id of ids) hide(ship, id); return; }
  const now = c.spec ? c.prevType : ship.type;
  ship.setUIComponent({ id: 'ss_pick', position: [30, 14, 40, 7], visible: true,
    components: [text(c.spec ? 'Choose your ship for when you play again' : 'Choose your ship', [0, 0, 100, 100], COLOR.gold)] });
  T6_SHIPS.forEach((code, i) => {
    const picked = code === now, color = picked ? COLOR.gold : '#7fe0d0';
    ship.setUIComponent({ id: `ss_ship${i}`, position: [4 + i * 11.6, 23, 10.6, 40], clickable: true, visible: true, components: [
      { type: 'box', position: [0, 0, 100, 100], fill: 'rgba(20,60,60,0.55)', stroke: color, width: picked ? 3 : 2 },
      text(SHIP_NAMES[code], [4, 4, 92, 9], color),
      text('T6', [0, 44, 100, 12], 'rgba(127,224,208,0.5)'),
      text(picked ? 'Current ship' : 'Click to fly', [4, 86, 92, 7], picked ? COLOR.gold : COLOR.dim)] });
  });
  button(ship, 'ss_shipx', [44, 66, 12, 5], 'Cancel', true);
}

// ---- ball

function findBall() {
  if (ball.ref && game.asteroids.includes(ball.ref)) return ball.ref;
  ball.ref = null;
  return null;
}

function resetBall() {
  const b = findBall();
  if (b && b.id != null) b.set({ x: 0, y: 0, vx: 0, vy: 0 });
  else if (!b && game.step >= ball.asking) {
    ball.ref = game.addAsteroid({ x: 0, y: 0, vx: 0, vy: 0, size: BALL_SIZE });
    ball.asking = game.step + 120; // don't add a second one while the server is still answering
  }
  ball.last = null;
}

function ballTick() {
  const b = findBall();
  if (!b) return resetBall();
  if (b.id == null) return;
  if (m.state === 'kickoff' || m.state === 'goal' || m.state === 'ended') {
    if (Math.abs(b.x) > 1 || Math.abs(b.y) > 1 || b.vx || b.vy) b.set({ x: 0, y: 0, vx: 0, vy: 0 });
    return;
  }
  // who touched it last
  let best = null, bestD = TOUCH_RANGE + BALL_SIZE * 0.5;
  for (const s of game.ships) {
    const d = Math.hypot(s.x - b.x, s.y - b.y);
    if (d < bestD && s.alive !== false && !stats(s).spec) { best = s; bestD = d; }
  }
  if (best) ball.last = best.id;
  // a little friction so it doesn't drift forever
  if (game.step % 6 === 0 && (b.vx || b.vy)) b.set({ vx: b.vx * BALL_FRICTION, vy: b.vy * BALL_FRICTION });
  // escaped the field somehow: back to the middle
  if (Math.abs(b.y) > FIELD.y + 20 || Math.abs(b.x) > FIELD.x + 35) return resetBall();
  // goal? only counts during a match, in warm-up the ball just goes back to the middle
  if (Math.abs(b.y) < FIELD.goal && Math.abs(b.x) > FIELD.x + 5) {
    if (m.state === 'live') goal(b.x < 0 ? 1 : 0); else resetBall();
  }
}

function setBallSize(n) {
  BALL_SIZE = Math.max(1, Math.min(100, Math.round(n)));
  const b = findBall();
  if (b && b.id != null) b.set({ size: BALL_SIZE });
  echo(`Ball size: ${BALL_SIZE}`);
}

// only the ball: any other moving rock the game adds is removed
function clearRocks() {
  for (const a of game.asteroids) if (a !== ball.ref && a.id != null) a.set({ kill: true });
}

// ---- match flow

function rulesText() {
  const parts = [];
  if (MATCH_MINUTES) parts.push(`${MATCH_MINUTES} min`);
  if (GOAL_LIMIT) parts.push(`first to ${GOAL_LIMIT}`);
  return parts.length ? parts.join(', ') : 'no limit';
}

function startMatch() {
  if (running()) return echo('A match is already running, type endmatch first');
  m.score = [0, 0];
  m.left = MATCH_MINUTES ? MATCH_MINUTES * 3600 : Infinity;
  m.decided = false;
  for (const s of game.ships) Object.assign(stats(s), { goals: 0, owngoals: 0, knockouts: 0, kills: 0, deaths: 0 });
  hideResults();
  kickoff('Match starts');
  echo(`Match started (${rulesText()})`);
}

function kickoff(msg) {
  Object.assign(m, { state: 'kickoff', until: game.step + 180, count: 0, kickMsg: msg });
  resetBall();
  hideGoal();
  for (const s of game.ships) {
    if (stats(s).spec) continue;
    leaveGoalCam(s);
    joinTeam(s);
    sendHome(s, { idle: true });
  }
  countdown();
}

// 3, 2, 1 in big letters, updated every second
function countdown() {
  const n = Math.ceil((m.until - game.step) / 60);
  if (n === m.count || n < 1) return;
  m.count = n;
  game.setUIComponent({ id: 'ss_count', position: [35, 26, 30, 22], visible: true,
    components: [text(m.kickMsg, [0, 0, 100, 22]), text(String(n), [0, 25, 100, 75], COLOR.gold)] });
}

function goal(t) {
  m.score[t]++;
  const s = ball.last != null && game.findShip(ball.last);
  let who = '';
  if (s) {
    const c = stats(s);
    if (c.team === t) { c.goals++; who = s.name; } else { c.owngoals++; who = `${s.name} (own goal)`; }
  }
  m.state = 'goal';
  m.until = game.step + 240;
  if (GOAL_LIMIT && m.score[t] >= GOAL_LIMIT) m.decided = true; // match ends after the celebration
  celebrate(t, who);
  echo(`${TEAMS[t].name} scores${who ? ` (${who})` : ''}. ${scoreText()}`);
}

// every ship becomes an invisible camera in front of the goal that was scored in, so all
// you see is the goal, the confetti and a big GOAL text (a mod can't move cameras on its own)
function celebrate(t, who) {
  const side = -TEAMS[t].side, gx = side * FIELD.x; // red scores in the right goal, blue in the left
  for (const s of game.ships) {
    const c = stats(s);
    if (!c.spec) { if (isT6(s.type)) c.prevType = s.type; c.goalCam = true; }
    s.set({ x: gx - side * 45, y: 0, vx: 0, vy: 0, idle: true, collider: false, ...(c.spec ? {} : { type: GOAL_CAM }) });
  }
  game.setUIComponent({ id: 'ss_goal', position: [20, 18, 60, 16], visible: true, components: [
    text('GOAL!', [0, 0, 100, 65], TEAMS[t].color),
    text(`${TEAMS[t].name}${who ? `  -  ${who}` : ''}`, [0, 66, 100, 34])] });
  confetti(gx, side);
}

// back in your own ship after the celebration
function leaveGoalCam(s) {
  const c = stats(s);
  if (!c.goalCam) return;
  c.goalCam = false;
  s.set({ type: c.prevType ?? T6_SHIPS[0], stats: MAXED });
}

const hideGoal = () => game.setUIComponent({ id: 'ss_goal', visible: false });

// confetti: three bursts out of the goal, small pieces that stay low over the field
const FETTI = 24, BURSTS = 3;   // pieces per burst, number of bursts
const FETTI_COLORS = ['gold', 'red', 'blue', 'green', 'white'];

function confetti(gx, side) {
  m.fetti = { gx, side, next: 0, age: 0, pieces: [] };
}

function burst(f, n) {
  for (let i = 0; i < FETTI; i++) {
    const a = (Math.random() - 0.5) * 2.6, sp = 0.6 + Math.random() * 1.2;
    f.pieces.push({ id: `ss_fetti${n * FETTI + i}`, x: f.gx, y: (Math.random() - 0.5) * 50, z: 0.5,
      vx: -f.side * Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: 0.5 + Math.random() * 0.4,
      spin: Math.random() * 6, life: 90 + Math.random() * 30, color: FETTI_COLORS[i % FETTI_COLORS.length] });
  }
}

// a new burst every 0.8 s; pieces move 10 times a second and disappear after 1.5 to 2 s
function fettiTick() {
  const f = m.fetti;
  if (!f || game.step % 6) return;
  if (f.next < BURSTS && f.next * 48 <= f.age) burst(f, f.next++);
  f.age += 6;
  f.pieces = f.pieces.filter(p => {
    p.life -= 6;
    if (p.life <= 0) { game.removeObject(p.id); return false; }
    p.x += p.vx * 6; p.y += p.vy * 6; p.z = Math.max(0, p.z + p.vz); p.vz -= 0.12; // a small hop: never more than a few units up
    p.vx *= 0.95; p.vy *= 0.95; p.spin += 0.6;
    game.setObject({ id: p.id, type: PAINT[p.color], position: { x: p.x, y: p.y, z: p.z },
      rotation: { x: p.spin, y: p.spin * 0.7, z: p.spin * 0.3 }, scale: { x: 0.3, y: 0.18, z: 0.05 } });
    return true;
  });
  if (f.next >= BURSTS && !f.pieces.length) m.fetti = null;
}

function endMatch() {
  if (!running()) return echo('No match is running');
  m.state = 'ended';
  hideGoal();
  game.setUIComponent({ id: 'ss_count', visible: false });
  for (const s of game.ships) {
    if (!stats(s).spec) { leaveGoalCam(s); s.set({ collider: true }); }
    s.set({ idle: false });
  }
  const w = m.score[0] === m.score[1] ? -1 : m.score[0] > m.score[1] ? 0 : 1;
  announce(w < 0 ? 'DRAW' : `${TEAMS[w].name} WINS`, 6);
  showResults(w);
  echo(`Match over. ${scoreText()}`);
}

function matchTick() {
  if (m.state === 'kickoff' && game.step < m.until) countdown();
  if (m.state === 'kickoff' && game.step >= m.until) {
    m.state = 'live';
    for (const s of game.ships) s.set({ idle: false });
    game.setUIComponent({ id: 'ss_count', visible: false });
    announce('GO!', 2);
  } else if (m.state === 'goal' && game.step >= m.until) {
    if (m.left <= 0 || m.decided) endMatch(); else kickoff('Kick-off');
  } else if (m.state === 'live') {
    if (m.left !== Infinity) m.left--;
    if (m.left <= 0) endMatch();
  }
}

// the shooter isn't known to the mod, so a knockout goes to the closest opponent
function nearestEnemy(ship, range) {
  const c = stats(ship);
  let best = null, bestD = range;
  for (const o of game.ships) {
    const oc = stats(o);
    if (o === ship || oc.spec || oc.team == null || oc.team === c.team) continue;
    const d = Math.hypot(o.x - ship.x, o.y - ship.y);
    if (d < bestD) { best = o; bestD = d; }
  }
  return best;
}

// low shield: sent back to your own half instead of dying
function knockoutTick() {
  for (const s of game.ships) {
    const c = stats(s);
    if (s.alive === false || c.team == null || c.spec) continue;
    c.maxShield = Math.max(c.maxShield, s.shield || 0);
    if (m.state !== 'live' || !c.maxShield || s.shield > c.maxShield * KNOCKOUT_SHIELD) continue;
    c.knockouts++;
    c.deaths++;
    const by = nearestEnemy(s, 300);
    if (by) stats(by).kills++;
    sendHome(s);
  }
}

// ---- kick and ban

function removePlayer(target, ban, reason, by = 'the host') {
  reason = reason || 'No reason given'; // an empty reason typed in the console counts as none
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

// banned names are sent away 1.5 s after joining, once their game has loaded
function banTick() {
  for (const s of game.ships) {
    const c = stats(s), b = bans[String(s.name).toUpperCase()];
    if (!c.banChecked) { c.banChecked = true; if (b) c.banAt = game.step + 90; }
    if (c.banAt && game.step >= c.banAt) { c.banAt = 0; if (b) s.gameover(endScreen(true, b.reason, b.by)); }
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

function idAndRest(arg = '') {
  const r = /^(\S+)\s*(.*)$/.exec(arg);
  return r ? { id: r[1], rest: r[2] } : { id: '', rest: '' };
}

function swapTeam(s) {
  if (stats(s).spec) return echo(`${s.name} is spectating`);
  setTeam(s, 1 - stats(s).team);
  if (running()) sendHome(s);
  echo(`${s.name} is now ${TEAMS[stats(s).team].name}`);
}

// time 10 / time none, goals 5 / goals none (for the next match)
function setRule(which, arg) {
  const n = /^(none|off|0)$/i.test(String(arg).trim()) ? 0 : Math.round(Number(arg));
  if (!(n >= 0) || n > 120) return echo(`Use a number or none, like: ${which} 10`);
  if (which === 'time') MATCH_MINUTES = n; else GOAL_LIMIT = n;
  echo(`Next match: ${rulesText()}`);
  refreshAdmins();
}

const COMMANDS = {
  match: () => startMatch(),
  time: arg => setRule('time', arg),
  goals: arg => setRule('goals', arg),
  endmatch: () => endMatch(),
  ball: () => { resetBall(); echo('Ball is back in the middle'); },
  ballsize: arg => {
    const n = Number(arg);
    if (!(n >= 1 && n <= 100)) return echo('Use a size from 1 to 100, normal is 30');
    setBallSize(n);
    refreshAdmins();
  },
  say: arg => { if (arg) announce(arg, 8); },
  list: () => {
    if (!game.ships.length) return echo('Nobody is here yet');
    for (const s of game.ships) {
      const c = stats(s);
      echo(`${s.id}  ${s.name}  ${c.team == null ? '-' : TEAMS[c.team].name}  goals ${c.goals}${c.role === 'admin' ? '  (admin)' : ''}`);
    }
  },
  team: arg => {
    const a = idAndRest(arg), s = findPlayer(a.id);
    if (!s) return;
    const want = { RED: 0, BLUE: 1 }[a.rest.toUpperCase()] ?? 1 - stats(s).team;
    if (want !== stats(s).team) swapTeam(s); else echo(`${s.name} is already ${TEAMS[want].name}`);
  },
  admin: arg => {
    const s = findPlayer(arg);
    if (s) { stats(s).role = 'admin'; drawButtons(s); echo(`${s.name} is now an admin`); }
  },
  player: arg => {
    const s = findPlayer(arg);
    if (!s) return;
    Object.assign(stats(s), { role: 'player', panel: null });
    drawPanel(s);
    drawButtons(s);
    echo(`${s.name} is a normal player again`);
  },
  kick: arg => { const a = idAndRest(arg), s = findPlayer(a.id); if (s) removePlayer(s, false, a.rest); },
  ban: arg => { const a = idAndRest(arg), s = findPlayer(a.id); if (s) removePlayer(s, true, a.rest); },
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
  echo('Space Soccer ready. Commands: match, endmatch, time [min/none], goals [n/none], ball, ballsize [1-100], say [text], list, team [id] [red/blue], admin [id], player [id], kick [id] [reason], ban [id] [reason], unban [name], bans');
}

// ---- UI

const text = (value, position, color = COLOR.text, align = 'center') => ({ type: 'text', position, value, color, align });
const box = (stroke = COLOR.line) => ({ type: 'box', position: [0, 0, 100, 100], fill: COLOR.box, stroke, width: 2 });

function button(ship, id, position, label, visible, color) {
  ship.setUIComponent({ id, position, clickable: true, visible: !!visible, components: [box(color), text(label, [0, 22, 100, 56], color)] });
}

const hide = (ship, id) => ship.setUIComponent({ id, visible: false });

function label(ship, id, position, value, color = COLOR.dim) {
  ship.setUIComponent({ id, position, visible: true, components: [text(value, [0, 0, 100, 100], color, 'left')] });
}

// top row, next to the scoreboard: Admin (admins only), Spectate / Play, Change ship
function drawButtons(ship) {
  const c = stats(ship);
  button(ship, 'ss_admin', [44, 1, 11, 4.5], c.panel ? 'Close' : 'Admin', isAdmin(ship), COLOR.gold);
  button(ship, 'ss_spec', [56, 1, 9, 4.5], c.spec ? 'Play' : 'Spectate', true, c.spec ? COLOR.green : undefined);
  button(ship, 'ss_change', [66, 1, 10, 4.5], 'Change ship', true);
}

// admin panel with three tabs: Match (start/stop, time and goal limit, ball size),
// Players (team / kick / ban), Banned (unban)
function hidePanel(ship, keep = []) {
  const ids = ['ss_tabm', 'ss_tabp', 'ss_tabb', 'ss_list', 'ss_page', 'ss_cancel', 'ss_mstat', 'ss_tlab', 'ss_glab', 'ss_blab', 'ss_go', 'ss_mnote'];
  BALL_CHOICES.forEach((b, i) => ids.push(`ss_bs${i}`));
  for (let i = 0; i < ROWS; i++) ids.push(`ss_n${i}`, `ss_t${i}`, `ss_k${i}`, `ss_b${i}`, `ss_bn${i}`, `ss_u${i}`);
  REASONS.forEach((r, i) => ids.push(`ss_r${i}`));
  TIME_CHOICES.forEach((t, i) => ids.push(`ss_tm${i}`));
  GOAL_CHOICES.forEach((g, i) => ids.push(`ss_gl${i}`));
  for (const id of ids) if (!keep.includes(id)) hide(ship, id);
}

function pageOf(ship, total) {
  const c = stats(ship), pages = Math.max(1, Math.ceil(total / ROWS));
  if (c.page >= pages) c.page = 0;
  button(ship, 'ss_page', [56.5, 70, 13.5, 4.6], `Next page (${c.page + 1}/${pages})`, pages > 1);
  return c.page * ROWS;
}

function emptyNote(ship, value) {
  ship.setUIComponent({ id: 'ss_list', position: [30, 25, 40, 5], visible: true, components: [text(value, [0, 0, 100, 100], COLOR.dim)] });
}

function drawPanel(ship) {
  const c = stats(ship), keep = ['ss_tabm', 'ss_tabp', 'ss_tabb'];
  if (!c.panel) return hidePanel(ship);
  if (c.panel !== 'reason') {
    const tab = (id, x, name, view) => button(ship, id, [x, 18, 13, 5.5], name, true, c.panel === view ? COLOR.gold : undefined);
    tab('ss_tabm', 30, 'Match', 'match');
    tab('ss_tabp', 43.5, 'Players', 'players');
    tab('ss_tabb', 57, `Banned (${Object.keys(bans).length})`, 'bans');
  }

  if (c.panel === 'match') {
    const status = m.state === 'warmup' ? 'Warm-up' : m.state === 'ended' ? `Full time: ${scoreText()}`
      : scoreText() + (m.left === Infinity ? '' : `   ${clock(m.left)} left`);
    ship.setUIComponent({ id: 'ss_mstat', position: [30, 25, 40, 5], visible: true,
      components: [box(), text(status, [0, 15, 100, 70], running() ? COLOR.gold : COLOR.text)] });
    const choices = (prefix, list, y, width, step, current, name) => list.forEach((v, i) => {
      const value = Array.isArray(v) ? v[0] : v;
      button(ship, `${prefix}${i}`, [30 + i * step, y, width, 4.6], name(v), true, value === current ? COLOR.gold : undefined);
      keep.push(`${prefix}${i}`);
    });
    label(ship, 'ss_tlab', [30.5, 31, 39, 3.5], 'Time limit (minutes)');
    choices('ss_tm', TIME_CHOICES, 35, 6.2, 6.7, MATCH_MINUTES, n => n ? String(n) : 'None');
    label(ship, 'ss_glab', [30.5, 41, 39, 3.5], 'Goal limit (first team to)');
    choices('ss_gl', GOAL_CHOICES, 45, 7.55, 8.05, GOAL_LIMIT, n => n ? String(n) : 'None');
    label(ship, 'ss_blab', [30.5, 51, 39, 3.5], 'Ball size (changes right away)');
    choices('ss_bs', BALL_CHOICES, 55, 7.55, 8.05, BALL_SIZE, ([, name]) => name);
    button(ship, 'ss_go', [30, 62, 40, 6], running() ? 'End match' : `Start match  (${rulesText()})`, true, running() ? COLOR.red : COLOR.green);
    keep.push('ss_mstat', 'ss_tlab', 'ss_glab', 'ss_blab', 'ss_go');
    if (running()) { label(ship, 'ss_mnote', [30.5, 69, 39, 3.5], 'Time and goal limit changes count for the next match'); keep.push('ss_mnote'); }
    return hidePanel(ship, keep);
  }

  if (c.panel === 'players') {
    const others = game.ships.filter(s => s !== ship);
    const from = pageOf(ship, others.length);
    c.rows = others.slice(from, from + ROWS).map(s => s.id);
    keep.push('ss_page');
    if (!others.length) { emptyNote(ship, 'No other players yet'); keep.push('ss_list'); }
    c.rows.forEach((id, i) => {
      const sc = stats(game.findShip(id)), t = sc.team, y = 25 + i * 5.6;
      // every row has its own background: a big panel box would end up on top of the buttons
      ship.setUIComponent({ id: `ss_n${i}`, position: [30, y, 21, 4.6], visible: true,
        components: [box(TEAMS[t]?.color), { type: 'player', id, position: [5, 15, 90, 70], color: COLOR.text, align: 'left' }] });
      button(ship, `ss_t${i}`, [51.5, y, 5.5, 4.6], sc.spec ? 'Spec' : 'Team', true, t == null ? undefined : TEAMS[1 - t].color);
      button(ship, `ss_k${i}`, [57.5, y, 5.5, 4.6], 'Kick', true);
      button(ship, `ss_b${i}`, [63.5, y, 6.5, 4.6], 'Ban', true, COLOR.red);
      keep.push(`ss_n${i}`, `ss_t${i}`, `ss_k${i}`, `ss_b${i}`);
    });
    return hidePanel(ship, keep);
  }

  if (c.panel === 'bans') {
    const names = Object.keys(bans).sort();
    const start = pageOf(ship, names.length);
    c.banRows = names.slice(start, start + ROWS);
    keep.push('ss_page');
    if (!names.length) { emptyNote(ship, 'Nobody is banned'); keep.push('ss_list'); }
    c.banRows.forEach((name, i) => {
      const { reason, by } = bans[name], y = 25 + i * 5.6;
      ship.setUIComponent({ id: `ss_bn${i}`, position: [30, y, 32.5, 4.6], visible: true,
        components: [box(), text(name, [3, 4, 94, 46], COLOR.text, 'left'), text(`${reason}   by ${by}`, [3, 52, 94, 40], COLOR.dim, 'left')] });
      button(ship, `ss_u${i}`, [63, y, 7, 4.6], 'Unban', true, COLOR.green);
      keep.push(`ss_bn${i}`, `ss_u${i}`);
    });
    return hidePanel(ship, keep);
  }

  // reason picker
  const p = c.pending, t = game.findShip(p.id);
  ship.setUIComponent({ id: 'ss_list', position: [30, 18, 40, 10], visible: true,
    components: [box(p.ban ? COLOR.red : COLOR.line), text(`${p.ban ? 'Ban' : 'Kick'} ${t ? t.name : '?'}`, [0, 8, 100, 45], p.ban ? COLOR.red : COLOR.gold),
      text(`Pick a reason, or type  ${p.ban ? 'ban' : 'kick'} ${p.id} your reason  in the console`, [0, 58, 100, 30], COLOR.dim)] });
  const reasonKeep = ['ss_list', 'ss_cancel'];
  REASONS.forEach((reason, i) => {
    button(ship, `ss_r${i}`, [35, 30 + i * 6.5, 30, 5.2], reason, true, p.ban ? COLOR.red : undefined);
    reasonKeep.push(`ss_r${i}`);
  });
  button(ship, 'ss_cancel', [35, 30 + REASONS.length * 6.5 + 1, 30, 5.2], 'Cancel', true);
  hidePanel(ship, reasonKeep);
}

// redraw the Match tab for every admin who has it open (score, clock, settings)
function refreshAdmins() {
  for (const s of game.ships) if (isAdmin(s) && stats(s).panel === 'match') drawPanel(s);
}

function panelClick(ship, id) {
  const c = stats(ship);
  let r, s;
  if (id === 'ss_admin') { Object.assign(c, { panel: c.panel ? null : 'match', pending: null, page: 0 }); drawButtons(ship); }
  else if (['ss_tabm', 'ss_tabp', 'ss_tabb'].includes(id)) { c.panel = { ss_tabm: 'match', ss_tabp: 'players', ss_tabb: 'bans' }[id]; c.page = 0; }
  else if (id === 'ss_page') c.page++; // drawPanel wraps it back to page 1 after the last page
  else if (id === 'ss_cancel') { c.panel = 'players'; c.pending = null; }
  else if (id === 'ss_go') { if (running()) endMatch(); else startMatch(); return refreshAdmins(); }
  else if ((r = /^ss_tm(\d+)$/.exec(id))) { MATCH_MINUTES = TIME_CHOICES[Number(r[1])]; echo(`Next match: ${rulesText()}`); return refreshAdmins(); }
  else if ((r = /^ss_bs(\d+)$/.exec(id))) { setBallSize(BALL_CHOICES[Number(r[1])][0]); return refreshAdmins(); }
  else if ((r = /^ss_gl(\d+)$/.exec(id))) { GOAL_LIMIT = GOAL_CHOICES[Number(r[1])]; echo(`Next match: ${rulesText()}`); return refreshAdmins(); }
  else if ((r = /^ss_t(\d+)$/.exec(id))) { s = game.findShip(c.rows[Number(r[1])]); if (s && stats(s).team != null) swapTeam(s); }
  else if ((r = /^ss_([kb])(\d+)$/.exec(id))) {
    s = game.findShip(c.rows[Number(r[2])]);
    if (s) { c.panel = 'reason'; c.pending = { id: s.id, ban: r[1] === 'b' }; }
  } else if ((r = /^ss_r(\d+)$/.exec(id)) && c.pending) {
    s = game.findShip(c.pending.id);
    if (s) removePlayer(s, c.pending.ban, REASONS[Number(r[1])], ship.name);
    c.panel = 'players';
    c.pending = null;
  } else if ((r = /^ss_u(\d+)$/.exec(id))) {
    const name = (c.banRows ?? [])[Number(r[1])];
    if (name && bans[name]) { delete bans[name]; echo(`${name} was unbanned by ${ship.name}`); }
  } else return;
  drawPanel(ship);
}

function announce(msg, seconds) {
  m.banner = msg;
  m.bannerEnds = game.step + seconds * 60;
  game.setUIComponent({ id: 'ss_banner', position: [25, 18, 50, 8], visible: true, components: [text(msg, [0, 0, 100, 100], COLOR.gold)] });
}

// winner, score, then the best players with their goals and kills
function showResults(w) {
  const rows = [box(w < 0 ? COLOR.line : TEAMS[w].color),
    text(w < 0 ? 'DRAW' : `${TEAMS[w].name} WINS`, [0, 3, 100, 12], w < 0 ? COLOR.gold : TEAMS[w].color),
    text(scoreText(), [0, 15, 100, 8]),
    text('Goals', [60, 26, 18, 6], COLOR.dim, 'right'), text('Kills', [80, 26, 16, 6], COLOR.dim, 'right')];
  const list = game.ships.filter(s => !stats(s).spec && stats(s).team != null).sort((a, b) => {
    const x = stats(a), y = stats(b);
    return y.goals - x.goals || y.kills - x.kills || x.deaths - y.deaths;
  }).slice(0, 8);
  list.forEach((s, i) => {
    const c = stats(s), y = 33 + i * 8;
    rows.push({ type: 'player', id: s.id, position: [5, y, 55, 7], color: TEAMS[c.team].color, align: 'left' });
    rows.push(text(String(c.goals), [60, y, 18, 7], COLOR.text, 'right'));
    rows.push(text(String(c.kills), [80, y, 16, 7], COLOR.text, 'right'));
  });
  if (!list.length) rows.push(text('Nobody played', [0, 45, 100, 8], COLOR.dim));
  game.setUIComponent({ id: 'ss_results', position: [32, 22, 36, 40], visible: true, components: rows });
  m.results = game.step + 15 * 60;
}

function hideResults() {
  m.results = 0;
  game.setUIComponent({ id: 'ss_results', visible: false });
}

function drawScoreboard() {
  let time = m.state === 'warmup' ? 'WARM-UP' : m.state === 'ended' ? 'FULL TIME' : m.left === Infinity ? '' : clock(m.left);
  if (running() && GOAL_LIMIT) time += `${time ? '   ' : ''}first to ${GOAL_LIMIT}`;
  else if (running() && !time) time = 'no time limit';
  const rows = [
    text('RED', [2, 0, 30, 9], TEAMS[0].color, 'left'),
    text(`${m.score[0]} - ${m.score[1]}`, [32, 0, 36, 9]),
    text('BLUE', [68, 0, 30, 9], TEAMS[1].color, 'right'),
    text(time, [0, 9, 100, 6], m.state === 'live' ? COLOR.gold : COLOR.dim),
  ];
  let y = 17;
  for (const t of [0, 1]) {
    for (const s of teamOf(t).sort((a, b) => stats(b).goals - stats(a).goals).slice(0, 6)) {
      rows.push({ type: 'player', id: s.id, position: [2, y, 76, 6.5], color: TEAMS[t].color, align: 'left' });
      rows.push(text(String(stats(s).goals), [78, y, 20, 6.5], COLOR.text, 'right'));
      y += 7;
    }
    y += 2;
  }
  game.setUIComponent({ id: 'scoreboard', visible: true, components: rows });
}

// ---- game loop

this.tick = function (game) {
  if (!m.commands) { m.commands = true; addCommands(); resetBall(); paintField(); }
  matchTick();
  ballTick();
  fettiTick();
  if (game.step % 5 === 0) knockoutTick();
  if (game.step % 10 === 0) banTick();
  if (game.step % 60 === 0) clearRocks();
  if (m.banner && game.step >= m.bannerEnds) { m.banner = null; game.setUIComponent({ id: 'ss_banner', visible: false }); }
  if (m.results && game.step >= m.results) hideResults();

  if (game.step % 30 === 0) {
    for (const s of game.ships) {
      const c = stats(s);
      joinTeam(s);
      if (!c.radar) { c.radar = true; s.setUIComponent(radarField()); drawButtons(s); }
      if (c.drawnState !== m.state) { c.drawnState = m.state; drawButtons(s); if (c.panel === 'match') drawPanel(s); }
      if (c.panel && c.panel !== 'reason' && game.step % 120 === 0) drawPanel(s); // players come and go, the clock runs
    }
    drawScoreboard();
  }
};

this.event = function (event, game) {
  const ship = event.ship;
  switch (event.name) {
    case 'ship_spawned': {
      if (!ship) break;
      const c = stats(ship);
      // the ship picked in the game's ship picker is the one to (re)play with
      if (isT6(ship.type)) c.prevType = ship.type;
      if (c.spec) { ship.set({ type: SPEC_TYPE, collider: false }); break; }
      // same team as before (with its colour), only a new player gets one picked
      if (c.team != null) setTeam(ship, c.team); else joinTeam(ship);
      sendHome(ship, m.state === 'kickoff' ? { idle: true } : {});
      break;
    }
    case 'ship_destroyed': {
      if (!ship || m.state !== 'live') break;
      stats(ship).deaths++;
      const k = event.killer;
      if (k && k !== ship && game.findShip(k.id) === k && stats(k).team !== stats(ship).team) stats(k).kills++;
      break;
    }
    case 'ui_component_clicked': {
      if (!ship) break;
      const c = stats(ship);
      if (event.id === 'ss_spec') setSpectate(ship, !c.spec);
      else if (event.id === 'ss_change' || event.id === 'ss_shipx') { c.picking = event.id === 'ss_change' && !c.picking; drawShipPicker(ship); }
      else if (/^ss_ship\d+$/.test(event.id)) { const code = T6_SHIPS[Number(event.id.slice(7))]; if (code) changeShip(ship, code); }
      else if (isAdmin(ship)) panelClick(ship, event.id);
      break;
    }
  }
};
