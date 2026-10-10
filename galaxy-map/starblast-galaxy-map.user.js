// ==UserScript==
// @name         Starblast Galaxy Map
// @namespace    zyrvaen-starblast-galaxy-map
// @version      1.4.0
// @description  Galaxy map on the Starblast home screen, like the Steam version: pick a region and mode, click a server to join it.
// @author       Zyrvaen
// @license      MIT
// @match        https://starblast.io/*
// @run-at       document-idle
// @grant        none
// @inject-into  page
// @sandbox      raw
// ==/UserScript==

// Starblast Galaxy Map by Zyrvaen
// Globe button next to settings. Galaxy = the game's own Galaxy class, servers
// from simstatus.json, joining goes through the game's "#<id>" link handling.
(function () {
  'use strict';

  const REGIONS = ['Europe', 'America', 'Asia'];
  const MODES = [
    [null, 'All Modes'], ['team', 'Team Mode'], ['survival', 'Survival Mode'],
    ['invasion', 'Invasion'], ['deathmatch', 'Pro Deathmatch'], ['modding', 'Modding Space'],
  ];
  // [card, ring] colours taken from the Steam map
  const COLORS = {
    team: ['#9393bc', '#8c8db1'], survival: ['#bbbb94', '#b4b48c'], invasion: ['#94bc93', '#8db48c'],
    deathmatch: ['#bb9292', '#b68d8f'], modding: ['#93bcbe', '#8db4b6'],
  };
  const MOD_IMG = 'https://starblast.data.neuronality.com/modding/img/';

  const M = {
    open: false, busy: false, region: 0, mode: 0, servers: [], mods: {},
    f: 0, anim: null, drag: null, spin: null,
    rot: 0, tilt: -1.05, rotT: 0, tiltT: -1.05, dist: 1.8, dotSize: 11,
  };
  window.GalaxyMapDebug = M;

  const CUT = (c) => `polygon(${c}px 0, 100% 0, 100% calc(100% - ${c}px), calc(100% - ${c}px) 100%, 0 100%, 0 ${c}px)`;
  const CSS = `
    #gm-root { position: fixed; inset: 0; z-index: 50; pointer-events: none; font-family: Play, Arial, sans-serif; }
    #gm-root canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: auto; cursor: grab; }
    #gm-root canvas.drag { cursor: grabbing; }
    #gm-labels { position: absolute; inset: 0; }
    .gm-title { position: absolute; top: 92px; left: 0; right: 0; text-align: center; color: #fff; font-size: 34px; opacity: 0; transition: opacity .6s; }
    .gm-bar { position: absolute; top: 0; left: 50%; transform: translateX(-50%); display: flex; gap: 6px; pointer-events: auto; opacity: 0; transition: opacity .4s; }
    .gm-btn { position: relative; width: 330px; height: 54px; display: flex; align-items: center; justify-content: center; gap: 14px;
      cursor: pointer; user-select: none; color: #e3eef4; font-size: 27px; background: linear-gradient(#11222eb8, #1d3a49b8);
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 14px 100%, 0 calc(100% - 14px)); }
    .gm-btn:hover { background: linear-gradient(#173040d0, #27506ad0); color: #fff; }
    .gm-btn .sbg { font-size: 26px; }
    .gm-btn::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: #2f5a6d;
      clip-path: polygon(evenodd, 0 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 14px 100%, 0 calc(100% - 14px),
        2px 0, 2px calc(100% - 14.8px), 14.8px calc(100% - 2px), calc(100% - 14.8px) calc(100% - 2px), calc(100% - 2px) calc(100% - 14.8px), calc(100% - 2px) 0, 2px 0); }
    .gm-sys { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 8px; white-space: nowrap;
      cursor: pointer; opacity: 0; pointer-events: none; transition: opacity .3s; }
    .gm-sys.on { opacity: 1; pointer-events: auto; }
    .gm-sys.on.hid { opacity: 0; pointer-events: none; }
    .gm-sys:hover { z-index: 9999 !important; }
    .gm-sys:hover .gm-card { filter: brightness(1.18); }
    .gm-ring { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--c); display: grid; place-items: center; box-shadow: 0 0 8px #fff4; }
    .gm-ring i { width: 6px; height: 6px; border-radius: 50%; background: var(--c); }
    .gm-card { position: relative; min-width: 168px; clip-path: ${CUT(9)}; }
    .gm-card::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: var(--h);
      clip-path: polygon(evenodd, 9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%, 0 9px,
        2px 9.8px, 2px calc(100% - 2px), calc(100% - 9.8px) calc(100% - 2px), calc(100% - 2px) calc(100% - 9.8px), calc(100% - 2px) 2px, 9.8px 2px, 2px 9.8px); }
    .gm-card .h { height: 18px; padding: 3px 10px 3px 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px;
      font-size: 14px; color: #20202a; background: var(--h); }
    .gm-card .h img { height: 20px; margin-right: -6px; border: 1px solid #0006; }
    .gm-card .b { padding: 3px 10px 4px 12px; display: flex; justify-content: space-between; gap: 18px; font-size: 14px; color: var(--h); background: #0e0e14c8; }
    .gm-card .sbg, .gm-card .fa { font-size: 13px; }
    .gm-card .b .sbg { margin-right: 6px; }
    .gm-card .b .fa { margin-left: 5px; }
    .gm-fade { transition: opacity .25s !important; opacity: 0 !important; pointer-events: none !important; }
    #overlay.gm-front { z-index: 60 !important; pointer-events: none !important; }
    #overlay.gm-front :is(.social, .mobile-tools, .mobile-social) { pointer-events: auto !important; }
  `;

  const el = (tag, props, parent) => {
    const e = Object.assign(document.createElement(tag), props);
    if (parent) parent.appendChild(e);
    return e;
  };
  const hash = (n) => { let x = Math.imul(n, 2654435761) >>> 0; x ^= x >>> 16; x = Math.imul(x, 2246822507) >>> 0; return (x ^ (x >>> 13)) >>> 0; };
  const ease = (k) => 1 - (1 - k) ** 3;
  const clampTilt = (t) => Math.max(-1.5, Math.min(-0.35, t));
  const clamp = (v, max) => Math.max(-max, Math.min(max, v));

  // ---- menu button + hiding the menu

  function addButtons() {
    if (!document.getElementById('gm-css')) el('style', { id: 'gm-css', textContent: CSS }, document.head);
    for (const box of document.querySelectorAll('.social, .mobile-tools')) {
      const gears = box.querySelector('.sbg-gears');
      if (!gears || box.querySelector('.gm-open')) continue;
      const b = el('i', { className: 'sbg sbg-world gm-open', title: 'Galaxy Map' });
      b.onclick = (e) => { e.stopPropagation(); if (!M.busy) M.open ? close() : open(); };
      gears.after(b);
      if (box.classList.contains('mobile-tools')) gears.after(el('br'));
    }
  }

  // everything fades out except the bottom button row
  function hideMenu(hide) {
    const overlay = document.getElementById('overlay');
    if (!overlay) return;
    overlay.classList.toggle('gm-front', hide);
    for (const e of [...overlay.children, ...document.querySelectorAll('.pub_300x250, [id^="cdm-zone"]')]) {
      if (e.tagName !== 'SCRIPT' && !e.matches('.social, .mobile-tools, .mobile-social')) e.classList.toggle('gm-fade', hide);
    }
  }

  // ---- background sun and demo ships shrink away while the galaxy forms

  let bgFactor = 1, demo = null;

  function hookBackground() {
    const BG = window.BackgroundScene;
    if (typeof BG !== 'function' || BG.__gm) return;
    const key = Object.getOwnPropertyNames(BG.prototype).find((k) => /this\.suns/.test(BG.prototype[k]) && /\.phase/.test(BG.prototype[k]));
    if (!key) return;
    BG.__gm = true;
    const orig = BG.prototype[key];
    BG.prototype[key] = function () {
      for (const sun of this.suns || []) {
        const mesh = Object.values(sun).find((v) => v && v.isObject3D);
        if (!mesh) continue;
        mesh.__gm = mesh.__gm || mesh.scale.clone();
        mesh.scale.copy(mesh.__gm).multiplyScalar(Math.max(0.001, bgFactor));
        mesh.visible = bgFactor > 0.01;
      }
      return orig.apply(this, arguments);
    };
  }

  function hookDemo() {
    const D = window.Demo;
    if (typeof D !== 'function' || D.__gm) return;
    D.__gm = true;
    for (const k of Object.getOwnPropertyNames(D.prototype)) {
      const f = D.prototype[k];
      if (k !== 'constructor' && typeof f === 'function') D.prototype[k] = function () { demo = this; return f.apply(this, arguments); };
    }
  }

  function shrinkBackground(factor) {
    bgFactor = factor;
    const scene = demo && Object.values(demo).find((v) => v && v.welcome === true);
    if (!scene) return;
    const world = Object.values(scene).find((v) => v && Array.isArray(v.ships));
    for (const { model: m } of (world && world.ships) || []) {
      if (!m || !m.scale) continue;
      if (m.__gm == null) m.__gm = m.scale.x;
      m.scale.setScalar(Math.max(0.0001, m.__gm * factor));
    }
    const three = Object.values(scene).find((v) => v instanceof THREE.Scene);
    if (three) three.visible = factor > 0.03; // lasers and explosions
  }

  // ---- servers

  async function loadServers() {
    try {
      const st = await (await fetch('/simstatus.json', { cache: 'no-store' })).json();
      // the game only refuses servers whose survival phase has started
      M.servers = st.flatMap((r) => (r.systems || []).filter((s) => !s.unlisted && !s.survival).map((s) => ({ ...s, location: r.location })));
    } catch (e) { /* keep the old list */ }
    if (M.open && !M.anim) placeServers();
  }

  async function loadMods() {
    if (Object.keys(M.mods).length) return;
    try {
      for (const m of (await (await fetch('/modsinfo.json')).json())[0] || []) M.mods[m.mod_id] = m;
    } catch (e) { /* only used for the tooltip */ }
  }

  // ---- galaxy

  const G = {};

  function initRenderer(root) {
    G.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    G.renderer.setPixelRatio(devicePixelRatio || 1);
    G.renderer.setClearColor(0, 0);
    G.scene = new THREE.Scene();
    G.camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
    const c = G.renderer.domElement;
    root.prepend(c);

    // drag to turn; let go while moving and it keeps turning for a bit
    c.addEventListener('mousedown', (e) => {
      if (e.button) return;
      M.drag = { x: e.clientX, y: e.clientY, rot: M.rotT, tilt: M.tiltT, lx: e.clientX, ly: e.clientY, lt: performance.now(), vr: 0, vt: 0 };
      M.spin = null;
      c.classList.add('drag');
    });
    addEventListener('mousemove', (e) => {
      const d = M.drag;
      if (!d) return;
      M.rotT = d.rot + (e.clientX - d.x) * 0.005;
      M.tiltT = clampTilt(d.tilt + (e.clientY - d.y) * 0.004);
      const now = performance.now(), per = 8.35 / Math.max(8, now - d.lt); // half of a 60 fps frame
      d.vr = clamp(d.vr / 2 + (e.clientX - d.lx) * 0.005 * per, 0.08);
      d.vt = clamp(d.vt / 2 + (e.clientY - d.ly) * 0.004 * per, 0.04);
      Object.assign(d, { lx: e.clientX, ly: e.clientY, lt: now });
    });
    addEventListener('mouseup', () => {
      const d = M.drag;
      if (!d) return;
      if (performance.now() - d.lt < 80) M.spin = { r: d.vr, t: d.vt };
      M.drag = null;
      c.classList.remove('drag');
    });
  }

  function buildGalaxy() {
    if (G.points) G.scene.remove(G.points);
    const gal = new window.Galaxy(1000);
    const points = Object.values(gal).find((v) => v instanceof THREE.Points);
    if (!points) return false;
    const pos = points.geometry.attributes.position.array;
    Object.assign(G, {
      points, width: gal.width, sizeKey: Object.keys(points.material.uniforms)[0],
      target: Float32Array.from(pos), scatter: pos.map(() => (Math.random() - 0.5) * 3),
    });
    G.scene.add(points);
    makeSlots();
    return true;
  }

  // Servers sit on fixed spots: 5 rings in the disc with points around them.
  // The spots turn with the galaxy, so labels never jump around.
  function makeSlots() {
    const t = G.target, r = [];
    for (let i = 0; i < t.length; i += 3) r.push(Math.hypot(t[i], t[i + 1]));
    r.sort((a, b) => a - b);
    const R = r[Math.floor(r.length * 0.9)] || 1;
    G.slots = [];
    for (let k = 0; k < 5; k++) {
      const radius = R * (0.25 + 0.175 * k), n = 6 + 5 * k;
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2 + k * 0.7;
        G.slots.push([Math.cos(a) * radius, Math.sin(a) * radius, 0]);
      }
    }
    G.slotGap = R * 0.3;
  }

  // same server = same spot, and not right next to another server if possible
  function pickSlot(id, used) {
    const S = G.slots, start = hash(id) % S.length;
    let best = start, bestD = -1;
    for (let i = 0; i < S.length; i++) {
      const j = (start + i) % S.length;
      if (used.has(j)) continue;
      let d = Infinity;
      for (const u of used) d = Math.min(d, Math.hypot(S[j][0] - S[u][0], S[j][1] - S[u][1]));
      if (d >= G.slotGap) return j;
      if (d > bestD) [best, bestD] = [j, d];
    }
    return best;
  }

  // f = 0: dots far outside the screen, f = 1: galaxy formed
  function setFormation(f) {
    M.f = f;
    const attr = G.points.geometry.attributes.position, a = attr.array, t = G.target, s = G.scatter;
    const spread = 1 + 24 * (1 - f) ** 2, noise = 2 * (1 - f);
    for (let i = 0; i < a.length; i++) a[i] = t[i] * spread + s[i] * noise;
    attr.needsUpdate = true;
    G.boost = 1 + 1.2 * (1 - f);
    G.renderer.domElement.style.opacity = Math.min(1, f * 1.6);
    shrinkBackground(1 - f);
  }

  // animate the formation from where it is now, so closing halfway doesn't jump
  function animate(to, ms, done) {
    M.anim = { from: M.f, to, start: performance.now(), ms: ms * Math.abs(to - M.f), done };
  }

  function frame() {
    const now = performance.now(), dt = Math.min(100, now - (G.lastT || now)) / 16.7;
    G.lastT = now;
    if (M.anim) {
      const a = M.anim, k = a.ms ? Math.min(1, (now - a.start) / a.ms) : 1;
      setFormation(a.from + (a.to - a.from) * ease(k));
      if (k === 1) { M.anim = null; if (a.done) a.done(); }
    }
    if (!M.open && !M.anim) { G.lastT = 0; return; }

    const w = innerWidth, h = innerHeight;
    if (G.w !== w || G.h !== h) {
      G.renderer.setSize(w, h, false);
      G.camera.aspect = w / h;
      G.camera.updateProjectionMatrix();
      [G.w, G.h] = [w, h];
    }
    if (!M.drag) M.rotT += 0.0004 * dt; // slow drift
    if (M.spin) {
      M.rotT += M.spin.r * dt;
      M.tiltT = clampTilt(M.tiltT + M.spin.t * dt);
      M.spin.r *= 0.92 ** dt;
      M.spin.t *= 0.92 ** dt;
      if (Math.abs(M.spin.r) + Math.abs(M.spin.t) < 0.0002) M.spin = null;
    }
    const k = 1 - 0.86 ** dt; // glide towards the dragged angle
    M.rot += (M.rotT - M.rot) * k;
    M.tilt += (M.tiltT - M.tilt) * k;

    G.points.rotation.set(M.tilt, 0, M.rot);
    G.points.scale.setScalar(G.width);
    G.camera.position.set(0, 0, G.width * M.dist);
    G.camera.lookAt(G.scene.position);
    G.points.material.uniforms[G.sizeKey].value = (Math.min(w, h) / 1000) * M.dotSize * G.boost * (devicePixelRatio || 1);
    G.renderer.render(G.scene, G.camera);
    moveLabels();
    requestAnimationFrame(frame);
  }

  // ---- server labels

  const cards = new Map(); // server id -> { el, slot, w, h }
  const UI = {};

  function fadeOut(list) {
    for (const c of list) {
      c.gone = true;
      c.el.classList.remove('on');
      setTimeout(() => c.el.remove(), 350);
    }
  }

  function placeServers() {
    const mode = MODES[M.mode][0];
    const list = M.servers.filter((s) => s.location === REGIONS[M.region] && (!mode || s.mode === mode));
    const ids = new Set(list.map((s) => s.id));
    for (const [id, c] of cards) if (!ids.has(id)) { cards.delete(id); fadeOut([c]); }
    const used = new Set([...cards.values()].map((c) => c.slot));
    let n = 0;
    for (const s of list) {
      let c = cards.get(s.id);
      if (!c) {
        const e = el('div', { className: 'gm-sys', onclick: () => join(s.id) }, UI.labels);
        e.innerHTML = '<div class="gm-ring"><i></i></div><div class="gm-card"><div class="h"><span class="n"></span><span class="x"></span></div>' +
          '<div class="b"><span><i class="sbg sbg-user"></i><span class="p"></span></span><span><span class="m"></span><i class="fa fa-clock-o"></i></span></div></div>';
        c = { el: e, slot: pickSlot(s.id, used), w: 0, h: 0 };
        used.add(c.slot);
        cards.set(s.id, c);
        setTimeout(() => { if (!c.gone) e.classList.add('on'); }, 120 + n++ * 90); // one by one
      }
      const e = c.el, [head, ring] = COLORS[s.mode] || COLORS.modding;
      e.style.setProperty('--h', head);
      e.style.setProperty('--c', ring);
      const mod = s.mode === 'modding' && M.mods[s.mod_id];
      e.title = 'Join ' + s.name + (mod ? ` (${mod.title} by ${mod.author})` : '');
      e.querySelector('.n').textContent = s.name;
      e.querySelector('.p').textContent = s.players;
      e.querySelector('.m').textContent = Math.floor((s.time || 0) / 60) + ' min';
      const x = e.querySelector('.x');
      if (s.mode === 'modding' && x.dataset.mod !== s.mod_id) {
        x.dataset.mod = s.mod_id;
        x.textContent = '';
        el('img', {
          src: MOD_IMG + encodeURIComponent(s.mod_id) + '.jpg', alt: '',
          onload: () => { c.w = 0; }, // wider now, measure again
          onerror: () => { x.innerHTML = '<i class="sbg sbg-modding"></i>'; c.w = 0; },
        }, x);
      }
    }
  }

  // labels stay on their spot; when two overlap the front one wins and the one
  // behind fades out until they're apart again
  function moveLabels() {
    if (!cards.size) return;
    G.points.updateMatrixWorld();
    const w = innerWidth, h = innerHeight, p = new THREE.Vector3(), boxes = [];
    for (const c of cards.values()) {
      if (!c.w) [c.w, c.h] = [c.el.offsetWidth, c.el.offsetHeight];
      p.set(...G.slots[c.slot]).applyMatrix4(G.points.matrixWorld).project(G.camera);
      boxes.push({ c, x: (p.x + 1) / 2 * w - 9, y: (1 - p.y) / 2 * h - c.h / 2, z: p.z });
    }
    boxes.sort((a, b) => a.z - b.z);
    const shown = [];
    boxes.forEach((b, i) => {
      const { c } = b, gap = c.el.classList.contains('hid') ? 6 : 0; // a little room before it comes back, no flicker
      const hit = shown.some((a) => b.x < a.x + a.c.w + gap && a.x < b.x + c.w + gap && b.y < a.y + a.c.h + gap && a.y < b.y + c.h + gap);
      if (!hit) shown.push(b);
      c.el.classList.toggle('hid', hit);
      c.el.style.zIndex = boxes.length - i;
      c.el.style.transform = `translate(${b.x.toFixed(1)}px,${b.y.toFixed(1)}px)`;
    });
  }

  // ---- open / close

  function buildUI() {
    UI.root = el('div', { id: 'gm-root' }, document.body);
    initRenderer(UI.root);
    UI.labels = el('div', { id: 'gm-labels' }, UI.root);
    UI.title = el('div', { className: 'gm-title', textContent: 'GALAXY MAP' }, UI.root);
    UI.bar = el('div', { className: 'gm-bar' }, UI.root);
    UI.region = el('div', { className: 'gm-btn', onclick: () => { M.region = (M.region + 1) % REGIONS.length; swap(); } }, UI.bar);
    UI.mode = el('div', { className: 'gm-btn', onclick: () => { M.mode = (M.mode + 1) % MODES.length; swap(); } }, UI.bar);
  }

  function updateButtons() {
    UI.region.innerHTML = `<i class="sbg sbg-world"></i><span>${REGIONS[M.region]}</span>`;
    UI.mode.innerHTML = `<i class="sbg sbg-ship-agility"></i><span>${MODES[M.mode][1]}</span>`;
  }

  // other region or mode: the galaxy stays, old servers fade out, new ones fade in
  function swap() {
    updateButtons();
    fadeOut(cards.values());
    cards.clear();
    clearTimeout(M.swapTimer);
    M.swapTimer = setTimeout(() => { if (M.open && !M.anim) placeServers(); }, 350);
  }

  function setChrome(on) {
    UI.bar.style.opacity = UI.title.style.opacity = on ? 1 : 0;
  }

  function open() {
    if (typeof window.Galaxy !== 'function' || !window.THREE) return;
    if (!UI.root) buildUI();
    if (!buildGalaxy()) return;
    Object.assign(M, { open: true, mode: 0, spin: null });
    UI.root.style.display = '';
    hideMenu(true);
    updateButtons();
    requestAnimationFrame(() => setChrome(true));
    setFormation(0);
    animate(1, 1600, placeServers);
    loadMods().then(loadServers);
    M.timer = setInterval(loadServers, 15000);
    requestAnimationFrame(frame);
  }

  function close(then) {
    clearInterval(M.timer);
    clearTimeout(M.swapTimer);
    Object.assign(M, { open: false, busy: true, drag: null, spin: null });
    setChrome(false);
    fadeOut(cards.values());
    cards.clear();
    animate(0, 700, () => {
      UI.root.style.display = 'none';
      hideMenu(false);
      M.busy = false;
      if (then) then();
    });
  }

  function join(id) {
    const s = M.servers.find((x) => x.id === id);
    if (!s || M.busy || !M.open) return;
    close(() => {
      history.replaceState(null, '', '#' + id);
      const play = document.getElementById('play');
      if (play) play.click();
    });
  }

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && M.open && !M.busy) { e.stopPropagation(); close(); }
  }, true);

  const setup = () => { addButtons(); hookBackground(); hookDemo(); };
  setup();
  new MutationObserver(setup).observe(document.body, { childList: true, subtree: true });
})();
