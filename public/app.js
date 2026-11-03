const $ = (id) => document.getElementById(id);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const CHUNK = 16 * 1024; // safe size for every browser's data channel
const BUFFER_HIGH = 4 * 1024 * 1024;
const MAX_MEMBERS = 8; // everyone links to everyone, so keep rooms small (and there are 8 callsigns)
const PREFIX = 'droplink-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L: 31 characters
const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;
const PALETTE = [['Ember', '#ff5b1f'], ['Volt', '#c6ff1a'], ['Saffron', '#ffc21a'], ['Rose', '#ff6fae'], ['Mint', '#3ff0a8'], ['Tangerine', '#ff9a3c'], ['Citrine', '#f2f05a'], ['Aqua', '#33e6e0']];
const CALLSIGNS = PALETTE.map((p) => p[0]);
const colorOf = (name) => (PALETTE.find((p) => p[0] === name) || [, '#a3a39c'])[1];
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const wide = matchMedia('(min-width: 760px)');
const rand = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rand(a.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const time = () => new Date().toTimeString().slice(0, 5);
const dotted = (c) => c.slice(0, 3) + '·' + c.slice(3);

// Connection settings come from config.json (STUN finds a direct path; a TURN relay is the fallback for networks that block direct links).
let ICE = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };
const iceReady = fetch('config.json').then((r) => (r.ok ? r.json() : {})).then((c) => { ICE = { ...ICE, ...c }; }).catch(() => {});
let version = '';
fetch('version').then((r) => r.json()).then((v) => { version = v.version.replace(/^v/, ''); $('ver').textContent = 'v' + version; }).catch(() => {});
const CONNECT_TIMEOUT_MS = 20000;
let connectTimer;

let peer, door, doorConn, myName, hostId, isHost, roomCode, knocked, welcomed;
let maxSlots = MAX_MEMBERS, locked = false, autoAdmit = false;
const members = new Map(); // peer id -> { conn, name }: approved people we can talk to
const pending = new Map(); // host only: peer id -> { conn, name } knocking at the door
const allowed = new Set(); // ids the host announced as approved newcomers
const incoming = new Map(); // peer id -> { item, parts } file being received
const typers = new Map(); // peer id -> timeout clearing their "is typing"
let sending = 0; // transfers currently running
const outbox = []; // everything this device has sent: handed to anyone who joins later
let queue = Promise.resolve(); // one transfer at a time per device keeps each stream unambiguous

// --- small DOM helpers ---

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', ('i ' + cls).trim());
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}
const restart = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

function fmt(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`;
}

// --- theme: follows the OS until the user taps the toggle, then their choice sticks ---

const root = document.documentElement;
const osLight = matchMedia('(prefers-color-scheme: light)');
try { const t = localStorage.getItem('droplink-theme'); if (t === 'dark' || t === 'light') root.dataset.theme = t; } catch {}
const syncThemeColor = () => document.querySelector('meta[name=theme-color]').setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
osLight.addEventListener('change', syncThemeColor);
syncThemeColor();
for (const b of $$('.theme-btn')) {
  b.onclick = () => {
    const next = (root.dataset.theme || (osLight.matches ? 'light' : 'dark')) === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('droplink-theme', next); } catch {}
    syncThemeColor();
  };
}

function setMe(name) {
  myName = name;
  root.style.setProperty('--me', colorOf(name));
  for (const e of $$('.me-name')) e.textContent = name;
}

// --- redaction: a random word now and then is blacked out, starred, hashed or set in the wrong font ---

const SKIP = /^(to|a|an|the|of|for|and|or|in|on|is|it|you|·|—|-|~|\+|\/\/)$/i;
function redact(el, text, offset = 0) {
  clearTimeout(el._t1); clearTimeout(el._t2);
  el.textContent = '';
  el.setAttribute('aria-label', text);
  const words = text.split(' ');
  const spans = words.map((w, i) => {
    const s = h('span', 'rd', w);
    s.setAttribute('aria-hidden', 'true');
    el.append(s, i < words.length - 1 ? ' ' : '');
    return s;
  });
  const ok = words.map((w, i) => i).filter((i) => !SKIP.test(words[i]));
  if (calm.matches || !ok.length) return;
  const cycle = () => {
    if (!el.isConnected) return; // gone for good, stop the timers
    const first = pick(ok);
    const hit = [first];
    if (Math.random() < 0.35 && ok.includes(first + 1)) hit.push(first + 1);
    const r = Math.random();
    const mode = r < 0.32 ? 'bar' : r < 0.52 ? '*' : r < 0.7 ? '#' : 'font';
    for (const i of hit) {
      if (mode === 'bar' || mode === 'font') spans[i].classList.add(mode);
      else { spans[i].textContent = mode.repeat(Math.max(3, words[i].length)); spans[i].classList.add('star'); }
    }
    el._t2 = setTimeout(() => {
      for (const i of hit) { spans[i].textContent = words[i]; spans[i].className = 'rd'; }
      el._t1 = setTimeout(cycle, 1600 + Math.random() * 2600);
    }, 900 + Math.random() * 900);
  };
  el._t1 = setTimeout(cycle, 600 + offset + Math.random() * 1500);
}
const unredact = (el, text) => { clearTimeout(el._t1); clearTimeout(el._t2); el.removeAttribute('aria-label'); el.textContent = text; };
for (const el of $$('.redact')) redact(el, el.dataset.redact, Number(el.dataset.offset || 0));
redact($('hero'), 'Send anything.', 200);

// --- ambient motion: mirrored pixel rows, drifting blocks, tickers ---

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function pixRow(el) {
  const cols = 22, rows = 2, r = rng(Number(el.dataset.seed));
  const half = cols / 2;
  const cb = Array.from({ length: half }, () => r() < 0.42), rb = Array.from({ length: rows }, () => r() < 0.4);
  const cells = [];
  for (let y = 0; y < rows; y++) {
    const row = cb.map((c) => (r() < 0.07 ? c === rb[y] : c !== rb[y]));
    for (const on of row.concat([...row].reverse())) { const i = h('i', on ? 'on' : ''); el.append(i); cells.push(i); }
  }
  const go = () => {
    if (!calm.matches && el.offsetParent) {
      const y = rand(rows), len = 2 + rand(5), x0 = rand(cols), flip = [];
      for (let k = 0; k < len; k++) flip.push(y * cols + ((x0 + k) % cols));
      if (Math.random() < 0.4) for (let k = 0; k < len; k++) flip.push(((y + 1) % rows) * cols + ((x0 + k + 1) % cols));
      const toggle = () => flip.forEach((i) => cells[i].classList.toggle('on'));
      toggle();
      setTimeout(toggle, 90 + Math.random() * 160);
    }
    setTimeout(go, 500 + Math.random() * 1500);
  };
  setTimeout(go, 600 + Math.random() * 900);
}
$$('.pix').forEach(pixRow);

let driftTimer;
function background(view) {
  clearInterval(driftTimer);
  const bg = $('bg');
  bg.textContent = '';
  if (calm.matches || view === 'room') return;
  const W = innerWidth, H = innerHeight, cell = wide.matches ? 26 : 22, n = wide.matches ? 22 : 11;
  const cols = Math.floor(W / cell), rows = Math.floor(H / cell);
  const start = view === 'start';
  const shades = start ? ['--drift01', '--drift02', '--drift03'] : ['--drift1', '--drift2', '--drift3'];
  const place = (b) => { b.el.style.transform = `translate(${b.x * cell}px,${b.y * cell}px)`; };
  const blocks = Array.from({ length: n }, (_, i) => {
    const acc = i === 0 && !start;
    const b = { el: h('div', 'blk' + (acc ? ' acc' : '')), wc: 1 + rand(6), hc: 1 + rand(4) };
    b.x = clamp(rand(cols), 0, cols - b.wc);
    b.y = clamp(rand(rows), 0, rows - b.hc);
    Object.assign(b.el.style, { width: b.wc * cell + 'px', height: b.hc * cell + 'px' });
    if (!acc) b.el.style.background = `var(${shades[i % 3]})`;
    place(b);
    bg.append(b.el);
    return b;
  });
  driftTimer = setInterval(() => blocks.forEach((b) => {
    if (Math.random() < 0.55) return;
    const d = (Math.random() < 0.5 ? -1 : 1) * (1 + rand(4));
    if (Math.random() < 0.5) b.x = clamp(b.x + d, 0, cols - b.wc); else b.y = clamp(b.y + d, 0, rows - b.hc);
    place(b);
  }), 1300);
  if (start) return;
  const code = roomCode ? roomCode.slice(0, 3) + '-' + roomCode.slice(3) : '';
  const lines = [
    `DropLink v${version} // ghcr.io/trentnbauer/droplink:${version} // peer link established // ${code} // nothing stored // ICE ok // DTLS ok // `,
    '0x3F9A 0x77C2 0x1B04 // chunk 0412/1180 // 64 KiB // ack // chunk 0413/1180 // ack // ',
    `Build ${version} // image droplink:${version} // signal // relay standby // direct path // latency 14 ms // jitter 2 ms // loss 0.0% // `,
    `Node 01 ${myName} // slots ${maxSlots - 1} // `,
    'Do not trust the network // trust the person // device to device // no cloud // ',
  ];
  const tickRows = view === 'open' ? 6 : 4;
  for (let i = 0; i < tickRows; i++) {
    const row = h('div', 'tick' + (Math.random() < 0.5 ? ' rev' : ''));
    // the first row sits at the same height on the opening and waiting screens
    row.style.top = Math.round(i === 0 ? H / 8 : (i + 0.3 + Math.random() * 0.4) * (H / tickRows)) + 'px';
    if (view === 'open') { row.style.setProperty('--tk', 'var(--tick2)'); row.style.setProperty('--tks', 'var(--tick2-sep)'); }
    const run = h('div');
    const text = pick(lines).repeat(2);
    for (let k = 0; k < 2; k++) {
      const s = h('span');
      text.split('//').forEach((p, j, all) => { s.append(p); if (j < all.length - 1) s.append(h('span', 'sep', '//')); });
      run.append(s);
    }
    run.style.animationDuration = 90 + Math.random() * 60 + 's';
    row.append(run);
    bg.append(row);
  }
}

// marquee on the start screen
for (const k of [0, 1]) {
  for (const t of ['P2P', 'No upload', 'Encrypted in transit', 'Nothing stored', 'No account', 'No file size limit', 'Up to 8 devices', 'Room closes when you leave']) $('mq').append(h('span', '', t));
}
requestAnimationFrame(() => { $('mq').style.animationDuration = $('mq').scrollWidth / 2 / 40 + 's'; });

// --- views ---

function setView(v) {
  const prev = $('app').dataset.view;
  $('app').dataset.view = v;
  for (const id of ['start', 'open', 'wait', 'room']) $('v-' + id).hidden = id !== v;
  closePops();
  if (prev !== v) { restart($('v-' + v), 'enter'); background(v); }
}
wide.addEventListener('change', () => { background($('app').dataset.view); placeBand(); renderRoom(); });
calm.addEventListener('change', () => background($('app').dataset.view));

function status(msg, cls = '') {
  $('status').textContent = msg;
  $('status').className = 'status lb ' + cls;
}

function reset(msg = '', cls = '') {
  clearTimeout(connectTimer);
  const p = peer, d = door;
  peer = door = doorConn = null; // cleared first: destroying fires close events that must not act
  p?.destroy(); d?.destroy();
  hostId = isHost = roomCode = knocked = welcomed = null;
  maxSlots = MAX_MEMBERS; locked = autoAdmit = false;
  members.clear(); pending.clear(); allowed.clear(); incoming.clear();
  for (const t of typers.values()) clearTimeout(t);
  typers.clear();
  paintTyping();
  sending = 0;
  outbox.length = 0;
  queue = Promise.resolve();
  for (const it of thread) if (it.blobUrl) URL.revokeObjectURL(it.blobUrl);
  thread.length = 0;
  for (const e of $$('#thread > .msg, #thread > .sys')) e.remove();
  if (ct) stopCountdown();
  opening = false;
  setView('start');
  redact($('hero'), 'Send anything.', 200);
  if (!$('join').hidden && msg) { connecting = false; syncCode(msg); shakeCode(); return; }
  $('join').hidden = true;
  status(msg, cls);
}

// --- join modal: on-screen code keyboard, hardware typing still works through a hidden input ---

let code = '', connecting = false;
const codeIn = $('code-in');
function syncCode(msg) {
  const full = code.length === 6;
  $('typed').textContent = code.length > 3 ? code.slice(0, 3) + '-' + code.slice(3) : code;
  $('code-n').textContent = `${code.length} / 6`;
  codeIn.value = code;
  $('connect').classList.toggle('ready', full && !msg);
  $('connect').classList.toggle('bad', !!msg);
  $('connect-t').textContent = msg || (connecting ? 'Knocking…' : full ? 'Connect' : 'Enter the 6-character code');
}
const shakeCode = () => restart($('prompt'), 'shake');
for (const row of ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM<']) {
  const r = h('div', 'kb-row');
  for (const ch of row) {
    const del = ch === '<', off = /[01IOL]/.test(ch);
    const k = h('button', 'key' + (del ? ' del' : off ? ' off' : ''), del ? '⌫' : ch);
    k.type = 'button';
    k.setAttribute('aria-label', del ? 'Delete' : off ? `${ch} (not used in codes)` : ch);
    if (off) k.setAttribute('aria-disabled', 'true');
    else k.onclick = () => pressKey(ch, k);
    r.append(k);
  }
  $('kb').append(r);
}
function pressKey(ch, k) {
  codeIn.focus({ preventScroll: true });
  if (connecting) return;
  if (ch === '<') code = code.slice(0, -1);
  else if (code.length >= 6) return shakeCode();
  else code += ch;
  k.classList.add('hit');
  setTimeout(() => k.classList.remove('hit'), 120);
  syncCode();
}
codeIn.addEventListener('input', () => {
  if (connecting) return syncCode();
  const raw = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const clean = raw.replace(/[01IOL]/g, '').slice(0, 6);
  if (clean !== raw.slice(0, 6) && raw.length > code.length) shakeCode();
  code = clean;
  syncCode();
});
codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connect(); } });
$('prompt').onclick = () => codeIn.focus({ preventScroll: true });
$('connect').onclick = connect;
for (const id of ['join-x', 'join-scrim']) $(id).onclick = closeJoin;

function openJoin(preset = '') {
  if (peer || opening) return;
  status('');
  code = preset;
  connecting = false;
  $('join').hidden = false;
  syncCode();
  setTimeout(() => codeIn.focus({ preventScroll: true }), 60);
}
function closeJoin() {
  if (connecting) return reset(); // cancel the knock
  $('join').hidden = true;
}
async function connect() {
  if (connecting) return;
  if (!CODE_RE.test(code)) { shakeCode(); codeIn.focus({ preventScroll: true }); return; }
  connecting = true;
  syncCode();
  await iceReady;
  startJoin(code);
}

function newCode() {
  let out = '';
  while (out.length < 6) {
    const b = crypto.getRandomValues(new Uint8Array(1))[0];
    if (b < 248) out += ALPHABET[b % 31]; // 248 = 31 * 8: reject the rest to avoid modulo bias
  }
  return out;
}

const NATO = { A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', J: 'Juliett', K: 'Kilo', M: 'Mike', N: 'November', P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine' };
const say = (s) => [...s].map((c) => NATO[c]).join(' · ');
const phonetic = (c) => say(c.slice(0, 3)) + ' — ' + say(c.slice(3));

// --- start screen buttons and the 1 / 2 hotkeys ---

for (const b of $$('.open-btn')) b.onclick = openRoom;
for (const b of $$('.join-btn')) b.onclick = () => openJoin();
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (ct && ct.n > 0) stopCountdown();
    else if (!$('join').hidden) closeJoin();
    else closePops();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== '1' && e.key !== '2')) return;
  if ($('app').dataset.view !== 'start' || !$('join').hidden || ct || opening) return;
  if (e.target.closest?.('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  const b = $(e.key === '1' ? 'd-open' : 'd-join');
  restart(b, 'pressed');
  setTimeout(() => (e.key === '1' ? openRoom() : openJoin()), 160);
});

// --- opening a room (host) ---

let opening = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "SEND ANYTHING." is blacked out word by word before the screen changes
async function wipeHero() {
  if (calm.matches) return;
  const hero = $('hero');
  unredact(hero, '');
  const words = ['Send', 'anything.'].map((w) => h('span', '', w));
  hero.append(words[0], ' ', words[1]);
  await sleep(290); words[0].className = 'wipe';
  await sleep(150); words[1].className = 'wipe';
  await sleep(210);
}

// ***·*** resolves into the code: characters lock in left to right while the rest flicker
function revealCode(el, onProgress) {
  return new Promise((res) => {
    el.classList.remove('solved');
    if (calm.matches) { el.textContent = dotted(roomCode); el.classList.add('solved'); onProgress(1); return setTimeout(res, 400); }
    el.textContent = '';
    el.append(h('span', 'wipe', '***·***'));
    const t0 = performance.now() + 400, HOLD = 250, SOLVE = 2700;
    const id = setInterval(() => {
      const t = performance.now() - t0;
      if (t < HOLD) { if (t >= 0) el.textContent = '***·***'; return; }
      const text = dotted(roomCode), solve = Math.min(1, (t - HOLD) / SOLVE);
      const n = Math.floor(solve ** 1.6 * text.length), star = (1 - solve) ** 0.7;
      el.textContent = [...text].map((c, i) => (c === '·' || i < n ? c : Math.random() < star ? '*' : ALPHABET[rand(31)])).join('');
      onProgress(solve);
      if (solve < 1) return;
      clearInterval(id);
      el.classList.add('solved');
      setTimeout(res, 1200);
    }, 55);
  });
}

function strip() {
  const el = $('strip');
  el.textContent = '';
  const order = [...Array(30).keys()].sort(() => Math.random() - 0.5);
  const cells = order.map((_, i) => { const d = h('i'); d.style.background = i % 2 ? 'var(--cell-a)' : 'var(--cell-b)'; el.append(d); return d; });
  return (p) => order.forEach((k, i) => { if (k < Math.floor(p * 30)) cells[i].style.background = 'var(--me)'; });
}

async function openRoom() {
  if (opening || peer) return;
  opening = true;
  status('');
  await Promise.all([wipeHero(), iceReady]);
  if (!opening) return;
  setMe(pick(CALLSIGNS));
  isHost = true;
  roomCode = newCode();
  for (const id of ['ck1', 'ck2']) $(id).textContent = '…';
  $('ck3').textContent = '0%';
  $('open-foot').textContent = `${myName} · host · ${maxSlots} slots`;
  const fillStrip = strip();
  setView('open');
  const shown = revealCode($('open-code'), (p) => { $('ck3').textContent = Math.round(p * 100) + '%'; fillStrip(p); });
  const ready = new Promise((res) => {
    peer = newPeer();
    peer.on('open', () => {
      $('ck1').textContent = 'OK';
      hostId = peer.id;
      openDoor(roomCode, false, (c) => { roomCode = c; $('ck2').textContent = 'OK'; res(); });
    });
  });
  await Promise.all([shown, ready]);
  if (!opening) return; // reset while we waited
  opening = false;
  setView('room');
  sysLine(`${time()} · room opened`, true);
  renderRoom();
}

// --- connections (the public PeerJS broker only introduces peers; data never goes through it) ---
// Every device has its own random id. The host also holds the "door": a second id made from the room code that
// newcomers knock on. After approval they link to everyone's own id, so the door can change (new code, new host).

const peerOpts = () => ({ config: { iceServers: ICE.iceServers, iceTransportPolicy: ICE.iceTransportPolicy || 'all' } });

function newPeer() {
  const p = new Peer(peerOpts());
  p.on('connection', (conn) => wire(conn, false));
  p.on('error', (e) => {
    if (p !== peer) return;
    if (e.type === 'peer-unavailable') { if (!members.size && !welcomed) reset('No room with that code.', 'bad'); return; } // else: a member left while we were linking up
    reset(`Connection problem (${e.type}).`, 'bad');
  });
  return p;
}

// sameCode: keep trying this code (a new host waits for the old one to let go); otherwise pick another if it is taken
function openDoor(c, sameCode, onOpen, tries = 0) {
  const d = new Peer(PREFIX + c, peerOpts());
  d.on('connection', (conn) => wire(conn, false, true));
  d.on('open', () => {
    if (!isHost || !peer) return d.destroy();
    const old = door;
    door = d;
    old?.destroy();
    onOpen(c);
  });
  d.on('error', (e) => {
    if (e.type === 'unavailable-id') {
      d.destroy();
      if (!sameCode) return openDoor(newCode(), false, onOpen);
      if (tries < 15) setTimeout(() => isHost && peer && openDoor(c, true, onOpen, tries + 1), 1000);
      return;
    }
    if (!door && opening) reset(`Connection problem (${e.type}).`, 'bad'); // the room never opened
  });
  d.on('disconnected', () => { if (d === door) setTimeout(() => d === door && !d.destroyed && d.reconnect(), 2000); }); // broker dropped: knocks need it back
}

function startJoin(c) {
  setMe(pick(CALLSIGNS)); // the host may swap it if someone in the room already has it
  roomCode = c;
  peer = newPeer();
  peer.on('open', () => {
    doorConn = peer.connect(PREFIX + c, { serialization: 'raw', reliable: true });
    wire(doorConn, true, true);
  });
  connectTimer = setTimeout(failConnect, CONNECT_TIMEOUT_MS);
}

// The broker found the room but the two devices never linked up: almost always a network that needs a TURN relay.
function failConnect() {
  if (members.size || (knocked && !welcomed) || !peer) return; // already in, or waiting for the host to answer
  reset("Couldn't connect to the host. One of the networks may block direct connections and need a TURN relay (see README).", 'bad');
}

function connectTo(id) {
  wire(peer.connect(id, { serialization: 'raw', reliable: true }), true);
}

const sendJson = (conn, m) => conn.open && conn.send(JSON.stringify(m));
const toAll = (m) => { for (const { conn } of members.values()) sendJson(conn, m); };

function wire(conn, outbound, viaDoor = false) {
  conn.outbound = outbound;
  conn.viaDoor = viaDoor;
  // Only the side that dialled greets first; the other side answers once it has decided to accept.
  conn.on('open', () => outbound && sendJson(conn, { t: 'hi', name: myName }));
  conn.on('iceStateChanged', (st) => { if (st === 'failed' && (conn === doorConn || (conn.peer === hostId && outbound))) failConnect(); });
  conn.on('data', (d) => (typeof d === 'string' ? onControl(conn, JSON.parse(d)) : onChunk(conn, d)));
  conn.on('close', () => {
    if (!peer) return;
    if (pending.get(conn.peer)?.conn === conn) pending.delete(conn.peer);
    if (conn === doorConn) {
      doorConn = null;
      if (!welcomed) reset(knocked ? 'The host left.' : "Couldn't reach that room.", 'bad');
      return;
    }
    const m = members.get(conn.peer);
    if (m?.conn === conn) {
      members.delete(conn.peer);
      incoming.delete(conn.peer);
      clearTyping(conn.peer);
      sysLine(`${m.name} left`);
      if (!isHost && !members.size) return reset('The room is closed.');
    }
    renderRoom();
  });
}

function addMember(conn, name) {
  const nm = CALLSIGNS.includes(name) ? name : 'Guest';
  clearTimeout(connectTimer);
  members.set(conn.peer, { conn, name: nm });
  if ($('app').dataset.view !== 'room') { $('join').hidden = true; setView('room'); sysLine(`${time()} · you joined`, true); } // a guest leaves the waiting screen
  sysLine(`${nm} joined`);
  renderRoom();
  // hand the newcomer everything this device has sent so far (queued behind any transfer already running)
  for (const entry of outbox) queueDeliver(entry, [members.get(conn.peer)]);
}

function onControl(conn, m) {
  if (conn.viaDoor) return isHost && !conn.outbound ? atDoor(conn, m) : fromDoor(conn, m);
  const id = conn.peer;
  if (m.t === 'hi') {
    if (members.has(id)) return;
    if (conn.outbound) return addMember(conn, m.name); // we chose this target
    if (allowed.has(id)) { allowed.delete(id); addMember(conn, m.name); sendJson(conn, { t: 'hi', name: myName }); } else conn.close();
    return;
  }
  const from = members.get(id);
  if (!from) return;
  const byHost = id === hostId;
  if (m.t === 'joining' && byHost) allowed.add(m.id);
  else if (m.t === 'text') { clearTyping(id); addItem({ kind: 'text', dir: 'in', from: from.name, text: m.v }); }
  else if (m.t === 'typing') showTyping(id);
  else if (m.t === 'file') {
    clearTyping(id);
    const item = addItem({ kind: 'file', dir: 'in', from: from.name, name: String(m.name), size: m.size, type: String(m.type || ''), bytes: 0, state: 'active' });
    incoming.set(id, { item, parts: [] });
  } else if (m.t === 'end' && incoming.has(id)) {
    const { item, parts } = incoming.get(id);
    incoming.delete(id);
    item.blobUrl = URL.createObjectURL(new Blob(parts, { type: item.type }));
    item.state = 'done';
    update(item, true);
  } else if (m.t === 'room' && byHost) {
    roomSettings(m);
    if (m.code !== roomCode && CODE_RE.test(m.code)) { roomCode = m.code; sysLine(`new code ${dotted(roomCode)}`); }
    renderRoom();
  } else if (m.t === 'host' && byHost) {
    hostId = m.id;
    roomSettings(m);
    const heir = m.id === peer.id ? myName : members.get(m.id)?.name;
    if (heir) sysLine(`${heir} is host now`);
    if (m.id === peer.id) {
      isHost = true;
      autoAdmit = !!m.auto;
      openDoor(roomCode, true, () => renderRoom());
    }
    renderRoom();
  } else if (m.t === 'closed' && byHost) reset('The host closed the room.');
}
function roomSettings(m) {
  maxSlots = clamp(Number(m.max) || MAX_MEMBERS, 2, MAX_MEMBERS);
  locked = !!m.locked;
}

// host: someone knocked on the door
function atDoor(conn, m) {
  const id = conn.peer;
  if (m.t !== 'hi' || members.has(id) || pending.has(id)) return;
  if (locked || members.size + pending.size + 1 >= maxSlots) {
    sendJson(conn, { t: 'denied', why: locked ? 'locked' : 'full' });
    return setTimeout(() => conn.close(), 300);
  }
  const taken = new Set([myName, ...[...members.values(), ...pending.values()].map((x) => x.name)]);
  const name = CALLSIGNS.includes(m.name) && !taken.has(m.name) ? m.name : pick(CALLSIGNS.filter((n) => !taken.has(n)));
  pending.set(id, { conn, name });
  if (autoAdmit) return approve(id, true);
  sendJson(conn, { t: 'knock', name });
  renderRoom();
}

// guest: the host answered our knock
function fromDoor(conn, m) {
  if (m.t === 'knock') {
    clearTimeout(connectTimer);
    knocked = true;
    setMe(m.name);
    $('wait-code').textContent = '';
    redact($('wait-code'), dotted(roomCode), 1100);
    $('wait-phon').textContent = phonetic(roomCode);
    $('join').hidden = true;
    connecting = false;
    setView('wait');
  } else if (m.t === 'denied') {
    reset(m.why === 'locked' ? 'That room is locked.' : m.why === 'full' ? 'That room is full.' : 'The host declined your request.', 'bad');
  } else if (m.t === 'welcome') {
    welcomed = true;
    setMe(m.name);
    hostId = m.host;
    roomSettings(m);
    conn.close();
    clearTimeout(connectTimer);
    connectTimer = setTimeout(failConnect, CONNECT_TIMEOUT_MS);
    for (const pid of m.peers) connectTo(pid);
  }
}

function approve(id, ok) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (!ok) { sendJson(p.conn, { t: 'denied' }); setTimeout(() => p.conn.close(), 300); return renderRoom(); }
  allowed.add(id);
  toAll({ t: 'joining', id });
  sendJson(p.conn, { t: 'welcome', name: p.name, host: peer.id, peers: [peer.id, ...members.keys()], max: maxSlots, locked });
  renderRoom();
}

function onChunk(conn, buf) {
  const f = incoming.get(conn.peer);
  if (!f) return;
  f.parts.push(buf);
  f.item.bytes += buf.byteLength;
  update(f.item);
}

const everyone = () => [...members.values()].filter((m) => m.conn.open);

const queueDeliver = (entry, to) => { queue = queue.then(() => deliver(entry, to)); };

// Send one outbox entry to whoever in `to` (array, or function giving the list when its turn comes) has not got it yet.
async function deliver(entry, to) {
  const targets = (typeof to === 'function' ? to() : to).filter((m) => m?.conn.open && !entry.sentTo.has(m.conn.peer));
  if (!targets.length) return;
  for (const m of targets) entry.sentTo.add(m.conn.peer);
  const names = targets.map((m) => m.name);
  const it = entry.item;
  if (entry.kind === 'text') {
    for (const { conn } of targets) sendJson(conn, { t: 'text', v: entry.text });
    it.names.push(...names);
    return update(it, true);
  }
  const { file } = entry;
  sending++;
  Object.assign(it, { state: 'active', delivering: names, bytes: 0 });
  update(it, true);
  for (const { conn } of targets) sendJson(conn, { t: 'file', name: file.name, size: file.size, type: file.type });
  for (let off = 0; off < file.size; off += CHUNK) {
    const chunk = await file.slice(off, off + CHUNK).arrayBuffer();
    for (const { conn } of targets) {
      while (conn.open && conn.dataChannel.bufferedAmount > BUFFER_HIGH) await new Promise((r) => setTimeout(r, 25));
      if (conn.open) conn.send(chunk);
    }
    it.bytes = Math.min(file.size, off + CHUNK);
    update(it);
  }
  for (const { conn } of targets) sendJson(conn, { t: 'end' });
  it.names.push(...names);
  Object.assign(it, { state: 'done', delivering: [] });
  sending--;
  update(it, true);
}

function shareText(text) {
  const entry = { kind: 'text', text, sentTo: new Set(), item: addItem({ kind: 'text', dir: 'out', text, names: [] }) };
  outbox.push(entry);
  queueDeliver(entry, everyone);
}

function shareFile(file) {
  const item = { kind: 'file', dir: 'out', name: file.name, size: file.size, type: file.type, bytes: 0, state: 'done', names: [], delivering: [] };
  if (file.type.startsWith('image/')) item.blobUrl = URL.createObjectURL(file);
  addItem(item);
  const entry = { kind: 'file', file, sentTo: new Set(), item };
  outbox.push(entry);
  queueDeliver(entry, everyone);
}

const enqueue = (files) => files.forEach(shareFile);
// a host can share while alone (it is held for whoever joins); a guest needs someone to share with
const canShare = () => isHost || everyone().length > 0;

// --- typing indicator ---

let typingSent = 0;
function showTyping(id) {
  clearTimeout(typers.get(id));
  typers.set(id, setTimeout(() => clearTyping(id), 3500));
  paintTyping();
}
function clearTyping(id) {
  if (!typers.has(id)) return;
  clearTimeout(typers.get(id));
  typers.delete(id);
  paintTyping();
}
function paintTyping() {
  const slot = $('typing');
  const ids = [...typers.keys()].filter((id) => members.has(id));
  const id = ids[ids.length - 1];
  if (slot.dataset.who === (id || '') && slot.dataset.n === String(ids.length)) return; // keep the running animation
  slot.dataset.who = id || '';
  slot.dataset.n = ids.length;
  slot.textContent = '';
  if (!id) return;
  const name = members.get(id).name;
  const d = h('div', 'typing lb');
  d.style.setProperty('--c', colorOf(name));
  const dots = h('span', 'dots');
  dots.append(h('i'), h('i'), h('i'));
  d.append(h('i', 'sq s8'), h('span', 'nm', name), h('span', '', ids.length > 1 ? `+ ${ids.length - 1} typing` : 'is typing'), dots);
  slot.append(d);
}

// --- thread ---

const thread = []; // { kind: 'text'|'file', dir, from, name, size, type, bytes, state, blobUrl, text, ui }

function sysLine(text, first = false) {
  const el = h('div', 'sys lb' + (first ? ' first' : ''));
  $('thread').append(el);
  redact(el, `— ${text} —`, Math.random() * 1500);
  stick();
}

function stick() {
  const t = $('thread');
  t.scrollTop = t.scrollHeight;
}

function copyBtn(getText) {
  const b = h('button', 'cp lb');
  b.type = 'button';
  b.append(icon('copy'), 'Copy');
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(getText()); } catch { return; }
    b.firstChild.replaceWith(icon('check'));
    setTimeout(() => b.firstChild.replaceWith(icon('copy')), 1200);
  };
  return b;
}

function fileIcon(it) {
  const ext = (it.name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'file-pdf';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'file-zip';
  if (it.type.startsWith('video/')) return 'file-video';
  if (it.type.startsWith('image/')) return 'file-image';
  if (it.type.startsWith('audio/')) return 'file-audio';
  return 'file';
}
const isImage = (it) => it.type.startsWith('image/');

// incoming files build up block by block in a random order
function fillGrid(cols, rows, height) {
  const el = h('div', 'fill');
  Object.assign(el.style, { gridTemplateColumns: `repeat(${cols},1fr)`, gridTemplateRows: `repeat(${rows},1fr)`, height: height + 'px' });
  const n = cols * rows;
  const rank = [...Array(n).keys()].sort(() => Math.random() - 0.5);
  const cells = rank.map((_, i) => { const d = h('i'); d.style.background = (i % cols + Math.floor(i / cols)) % 2 ? 'var(--cell-a)' : 'var(--cell-b)'; el.append(d); return d; });
  let shown = 0;
  el.set = (pct) => {
    const count = Math.floor((pct / 100) * n);
    if (count > shown) rank.forEach((k, i) => { if (k >= shown && k < count) cells[i].style.background = 'var(--c)'; });
    shown = Math.max(shown, count);
  };
  return el;
}

// a received image flickers in through a grid of the sender's colour
function revealImage(host) {
  if (calm.matches) return;
  const ov = h('div', 'reveal');
  const pal = ['var(--c)', 'var(--c)', 'var(--cell-off)', 'var(--cell-on)', 'var(--bg)'];
  const cells = Array.from({ length: 75 }, () => { const d = h('i'); ov.append(d); return d; });
  host.append(ov);
  let k = 0;
  const id = setInterval(() => {
    cells.forEach((d) => { d.style.background = pick(pal); });
    if (++k <= 7) return;
    clearInterval(id);
    cells.forEach((d) => { d.style.background = 'var(--c)'; d.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 160, delay: Math.random() * 420, fill: 'forwards' }); });
    setTimeout(() => ov.remove(), 640);
  }, 70);
}

function addItem(it) {
  const out = it.dir === 'out';
  it.at = time();
  const row = h('div', 'msg' + (out ? ' out' : '') + (it.kind === 'file' ? ' file' : ''));
  row.style.setProperty('--c', colorOf(out ? myName : it.from));
  const meta = h('div', 'meta lb');
  it.ui = { meta, rest: h('span') };
  if (out) meta.append(it.ui.rest);
  else meta.append(h('i', 'sq s8'), h('span', 'nm', it.from), it.ui.rest);
  row.append(meta);
  if (it.kind === 'text') {
    const b = h('div', 'bub');
    b.append(h('pre', '', it.text));
    if (!out) b.append(copyBtn(() => it.text));
    row.append(b);
  } else if (out) {
    const b = h('div', 'bub');
    if (it.blobUrl) b.append(Object.assign(h('img', 'thumb'), { src: it.blobUrl, alt: '' }));
    const fr = h('div', 'frow');
    const info = h('div', 'finfo');
    info.append(h('div', 'fname', it.name), h('div', 'fsize lb sm', fmt(it.size)));
    it.ui.tick = icon('checks-b');
    fr.append(icon(fileIcon(it)), info, it.ui.tick);
    b.append(fr);
    row.append(b);
  } else {
    const card = h('div', 'fcard');
    const pv = h('div', 'fpv');
    it.ui.fill = isImage(it) ? fillGrid(15, 5, 97) : fillGrid(14, 4, 56);
    it.ui.chip = h('div', 'lb sm', '0%');
    pv.append(it.ui.fill, it.ui.chip);
    const body = h('div', 'fbody');
    const info = h('div', 'finfo');
    it.ui.name = h('div', 'fname');
    it.ui.size = h('div', 'fsize lb sm');
    redact(it.ui.name, it.name, 300); // name and size stay redacted until the file has arrived
    redact(it.ui.size, `Receiving · ${fmt(it.size)}`, 1300);
    info.append(it.ui.name, it.ui.size);
    it.ui.badge = h('div', 'recv lb');
    it.ui.badge.append(icon('spinner-gap'), 'Receiving');
    if (!isImage(it)) body.append(icon(fileIcon(it)));
    body.append(info, it.ui.badge);
    card.append(pv, body);
    Object.assign(it.ui, { pv, body });
    row.append(card);
  }
  thread.push(it);
  $('thread').append(row);
  update(it, true);
  stick();
  return it;
}

function paintMeta(it, pct) {
  const kind = it.kind === 'text' ? 'text' : isImage(it) ? 'image' : 'file';
  const active = it.state === 'active';
  let s;
  if (it.dir === 'in') s = active ? `· receiving · ${pct}%` : `· ${kind} · ${it.at}`;
  else if (active) s = `You → ${it.delivering.length} · sending ${pct}%`;
  else if (!it.names.length) s = `You · ${kind} · held`;
  else s = it.kind === 'text' ? `You · text · ${it.at}` : `You → ${it.names.length} · delivered`;
  it.ui.rest.textContent = s;
}

function update(it, force) {
  if (it.kind === 'text') return paintMeta(it);
  const now = performance.now();
  if (!force && now - (it.paint || 0) < 100) return; // chunks arrive far faster than the screen needs
  it.paint = now;
  const active = it.state === 'active';
  const pct = it.size ? Math.min(100, Math.floor((it.bytes / it.size) * 100)) : 100;
  paintMeta(it, pct);
  if (it.dir === 'out') { it.ui.tick.style.visibility = !active && it.names.length ? 'visible' : 'hidden'; return; }
  if (active) { it.ui.fill.set(pct); it.ui.chip.textContent = pct + '%'; return; }
  if (it.ui.done) return;
  it.ui.done = true;
  const { pv, body, name, size, badge } = it.ui;
  unredact(name, it.name);
  unredact(size, fmt(it.size));
  if (isImage(it)) {
    pv.textContent = '';
    pv.append(Object.assign(h('img'), { src: it.blobUrl, alt: it.name }), h('div', 'lb sm', 'Preview'));
    revealImage(pv);
  } else pv.remove();
  const save = Object.assign(h('a', 'save lb'), { href: it.blobUrl, download: it.name });
  save.append(icon('download-simple'), 'Save');
  badge.replaceWith(save);
  stick();
}

// --- rendering the room (code, people, requests, settings) ---

function person(name, host, me) {
  const r = h('div', 'person');
  r.style.setProperty('--c', colorOf(name));
  const nm = h('div', 'dsp pn', name);
  if (me) nm.append(h('span', 'sr', ' (you)'));
  r.append(h('div', 'av dsp', name[0]), nm);
  if (host) r.append(h('span', 'host-tag lb sm', 'Host'));
  return r;
}

function renderRoom() {
  if (!roomCode || !peer) return;
  for (const e of $$('.room-code')) e.textContent = dotted(roomCode);
  for (const e of $$('.room-phon')) e.textContent = phonetic(roomCode);
  const total = members.size + 1;
  $('mem-count').textContent = wide.matches ? `${total} / ${maxSlots}` : total;
  for (const e of $$('.mem-n')) e.textContent = `${total} / ${maxSlots}`;
  $('mem-ico').setAttribute('href', locked ? '#i-lock-simple-b' : '#i-users-b');
  const people = [[peer.id, myName], ...[...members].map(([id, m]) => [id, m.name])];
  for (const list of $$('.mem-list')) {
    list.textContent = '';
    for (const [id, name] of people) list.append(person(name, id === hostId, id === peer.id));
  }
  for (const w of $$('.waiting')) {
    w.textContent = '';
    w.hidden = !(isHost && pending.size);
    if (w.hidden) continue;
    const head = h('div', 'lb sm');
    head.append(h('i', 'sq s6'), `Waiting · ${pending.size}`);
    w.append(head);
    for (const [id, p] of pending) {
      const r = person(p.name);
      r.style.setProperty('--c', 'var(--wait)');
      const no = h('button', 'yn');
      no.setAttribute('aria-label', `Deny ${p.name}`);
      no.append(icon('x-b'));
      const yes = h('button', 'yn yes');
      yes.setAttribute('aria-label', `Let ${p.name} in`);
      yes.append(icon('check-b'));
      no.onclick = () => approve(id, false);
      yes.onclick = () => approve(id, true);
      r.append(no, yes);
      w.append(r);
    }
  }
  $('mem-badge').hidden = !(isHost && pending.size);
  $('gear').hidden = !isHost;
  if (!isHost) $('set-pop').hidden = true;
  $('slots').textContent = maxSlots;
  $('slot-down').disabled = maxSlots <= Math.max(2, total + pending.size);
  $('slot-up').disabled = maxSlots >= MAX_MEMBERS;
  $('lock').setAttribute('aria-checked', locked);
  $('auto').setAttribute('aria-checked', autoAdmit);
  const names = [...members.values()].map((m) => m.name);
  $('drop-to').textContent = names.length ? 'To ' + names.join(' + ') : 'Held for anyone who joins';
  for (const id of ['text', 'send', 'attach']) $(id).disabled = !canShare();
}

// the code band sits at the top of the thread on phones, in the left rail on desktop
const placeBand = () => (wide.matches ? $('rail') : $('thread')).prepend($('code-band'));
placeBand();

function closePops() {
  for (const id of ['mem-pop', 'set-pop']) $(id).hidden = true;
  $('pop-scrim').hidden = true;
  $('gear').classList.remove('on');
  for (const id of ['gear', 'mem-btn']) $(id).setAttribute('aria-expanded', 'false');
}
function togglePop(pop, btn) {
  const open = $(pop).hidden;
  closePops();
  if (!open) return;
  $(pop).hidden = false;
  $('pop-scrim').hidden = false;
  $(btn).setAttribute('aria-expanded', 'true');
  if (btn === 'gear') $('gear').classList.add('on');
}
$('gear').onclick = () => togglePop('set-pop', 'gear');
$('mem-btn').onclick = () => togglePop('mem-pop', 'mem-btn');
$('pop-scrim').onclick = closePops;
$('set-x').onclick = closePops;

const shareSettings = () => { toAll({ t: 'room', max: maxSlots, locked, code: roomCode }); renderRoom(); };
$('slot-down').onclick = () => { maxSlots--; shareSettings(); };
$('slot-up').onclick = () => { maxSlots++; shareSettings(); };
$('lock').onclick = () => { locked = !locked; shareSettings(); };
$('auto').onclick = () => {
  autoAdmit = !autoAdmit;
  if (autoAdmit) for (const id of [...pending.keys()]) approve(id, true);
  renderRoom();
};
$('new-code').onclick = () => {
  closePops();
  openDoor(newCode(), false, (c) => { roomCode = c; sysLine(`new code ${dotted(c)}`); shareSettings(); });
};
$('close-room').onclick = () => startCountdown('close');
$('leave').onclick = () => startCountdown('leave');
$('knock-cancel').onclick = () => reset();
$('copy-code').onclick = async () => {
  try { await navigator.clipboard.writeText(roomCode); } catch { return; }
  const b = $('copy-code');
  b.querySelector('svg').replaceWith(icon('check'));
  setTimeout(() => b.querySelector('svg').replaceWith(icon('copy')), 1200);
};

// --- leave / close countdown: one tap starts it, the countdown itself is the confirmation ---

let ct = null; // { mode: 'leave'|'close', n, half, heir, timer }
for (let i = 0; i < 10; i++) $('ct-bar').append(h('i'));
function startCountdown(mode) {
  if (ct) return;
  closePops();
  const leave = mode === 'leave';
  ct = { mode, n: 10, half: 0, heir: leave && isHost && members.size ? pick([...members.keys()]) : null };
  $('ct-alert').textContent = leave ? (isHost ? 'Alert · host exit' : 'Alert · exit') : 'Alert · shutdown';
  $('ct-msg').textContent = leave
    ? (isHost && !members.size ? "You'll be disconnected. Nobody else is here, so the room closes." : "You'll be disconnected. The room stays open for everyone else.")
    : 'Everyone will be disconnected. Anything still sending is lost.';
  $('ct-stay-t').textContent = leave ? 'Stay' : 'Keep room open';
  $('ct-go-t').textContent = leave ? 'Leave now' : 'Close now';
  $('heir').hidden = !ct.heir;
  $('ct').hidden = false;
  $('ct-stay').focus();
  renderCt();
  ct.timer = setInterval(() => {
    ct.half++;
    if (ct.half % 2 === 0) ct.n--;
    if (ct.n <= 0) finishCountdown(); else renderCt();
  }, 500);
}
function renderCt() {
  const leave = ct.mode === 'leave', done = ct.n <= 0;
  $('ct-n').textContent = String(Math.max(0, ct.n)).padStart(2, '0');
  $('ct-title').textContent = leave ? (done ? 'Left room' : 'Leaving room') : (done ? 'Room closed' : 'Room closing');
  $('ct-title').classList.toggle('flash', done || ct.half % 2 === 0);
  [...$('ct-bar').children].forEach((c, i) => c.classList.toggle('on', i < ct.n));
  if (ct.heir && !members.has(ct.heir)) ct.heir = members.size ? pick([...members.keys()]) : null; // they left meanwhile
  $('heir').hidden = !ct.heir;
  if (!ct.heir) return;
  const name = members.get(ct.heir).name;
  $('heir-lead').textContent = done ? 'New host' : 'Host passes to';
  $('heir-name').textContent = name;
  $('heir').style.setProperty('--c', colorOf(name));
}
function stopCountdown() {
  clearInterval(ct.timer);
  ct = null;
  $('ct').hidden = true;
}
function finishCountdown() {
  if (!ct || ct.done) return;
  clearInterval(ct.timer);
  ct.n = 0;
  ct.done = true;
  renderCt();
  if (ct.mode === 'close') {
    toAll({ t: 'closed' });
    return setTimeout(() => reset('Room closed.'), 2500);
  }
  if (isHost && ct.heir) toAll({ t: 'host', id: ct.heir, max: maxSlots, locked, auto: autoAdmit });
  setTimeout(() => exitScramble(() => reset()), 1100);
}
$('ct-stay').onclick = () => ct && !ct.done && stopCountdown();
$('ct-go').onclick = finishCountdown;

// leaving: every bit of text garbles while blocks cover the screen, then the start screen decodes out of the noise
function exitScramble(onCovered) {
  if (calm.matches) return onCovered();
  const app = $('app'), cols = Math.round(app.offsetWidth / 26), rows = Math.round(app.offsetHeight / 26);
  const grid = h('div', 'cover');
  Object.assign(grid.style, { gridTemplateColumns: `repeat(${cols},1fr)`, gridTemplateRows: `repeat(${rows},1fr)` });
  const cells = Array.from({ length: cols * rows }, (_, i) => { const d = h('i'); grid.append(d); return [d, (Math.floor(i / cols) / rows) * 0.5 + Math.random() * 0.5]; });
  app.append(grid);
  const NOISE = 'ABCDEFGHJKMNPQRSTUVWXYZ0123456789#*/\\<>[]_';
  const texts = () => {
    const w = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
    const out = [];
    for (let n; (n = w.nextNode());) if (n.nodeValue.trim() && !n.parentElement.closest('[hidden]')) out.push([n, n.nodeValue]);
    return out;
  };
  const garble = (list, p) => list.forEach(([n, o]) => { n.nodeValue = o.replace(/\S/g, (c) => (Math.random() < p ? pick(NOISE) : c)); });
  const restore = (list) => list.forEach(([n, o]) => { n.nodeValue = o; });
  const paint = (p, flash) => cells.forEach(([d, k]) => { d.style.background = k < p ? (Math.random() < flash ? 'var(--alert)' : 'var(--bg)') : ''; });
  let list = texts(), swapped = false;
  const t0 = performance.now();
  const step = () => {
    const t = performance.now() - t0;
    if (t < 750) { garble(list, t / 750); paint(t / 750, 0.12); return setTimeout(step, 40); }
    if (!swapped) { swapped = true; restore(list); onCovered(); list = texts(); }
    if (t < 1500) { garble(list, 1 - (t - 750) / 750); paint(1 - (t - 750) / 750, 0.08); return setTimeout(step, 40); }
    restore(list);
    grid.remove();
  };
  step();
}

// --- composer ---

const text = $('text');
text.addEventListener('input', () => {
  text.style.height = 'auto';
  text.style.height = Math.min(text.scrollHeight, 120) + 'px';
  if (text.value && Date.now() - typingSent > 2000) { typingSent = Date.now(); toAll({ t: 'typing' }); }
});
text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('composer').requestSubmit(); } });
text.addEventListener('paste', (e) => {
  if (e.clipboardData.files.length && canShare()) { e.preventDefault(); enqueue([...e.clipboardData.files]); }
});
$('composer').onsubmit = (e) => {
  e.preventDefault();
  if (!text.value.trim() || !canShare()) return;
  shareText(text.value);
  typingSent = 0;
  text.value = '';
  text.style.height = 'auto';
};
$('attach').onclick = () => $('files').click();
$('files').onchange = () => { if (canShare()) enqueue([...$('files').files]); $('files').value = ''; };

// drag and drop anywhere on the page while in a room
let drags = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const canDrop = () => $('app').dataset.view === 'room' && canShare() && !ct;
addEventListener('dragenter', (e) => { if (hasFiles(e) && canDrop()) { drags++; $('drop').hidden = false; } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --drags <= 0) { drags = 0; $('drop').hidden = true; } });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  drags = 0;
  $('drop').hidden = true;
  if (canDrop()) enqueue([...e.dataTransfer.files]);
});

background('start');

// a ?c= link opens the join panel with the code filled in and knocks straight away
const preset = (new URLSearchParams(location.search).get('c') || '').toUpperCase();
if (CODE_RE.test(preset)) {
  history.replaceState(null, '', location.pathname); // keep the code out of history
  openJoin(preset);
  connect();
}
