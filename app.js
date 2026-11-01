const $ = (id) => document.getElementById(id);
const CHUNK = 16 * 1024; // safe size for every browser's data channel
const BUFFER_HIGH = 4 * 1024 * 1024;
const MAX_MEMBERS = 8; // everyone links to everyone, so keep rooms small
const PREFIX = 'droplink-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L: 31 characters
const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;
// STUN finds a direct path across the internet. Add a TURN entry here for networks that block direct links.
const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];

let peer, myName, hostId, isHost, roomCode;
const members = new Map(); // peer id -> { conn, name }: approved people we can talk to
const pending = new Map(); // host only: peer id -> { conn, name } waiting for approval
const allowed = new Set(); // ids the host announced as approved newcomers
const incoming = new Map(); // peer id -> { item, parts } file being received
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
const avatar = (name, cls = '') => h('span', 'av ' + cls, (name[0] || '?').toUpperCase());

function fmt(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`;
}

// --- redaction: only words that carry meaning for a privacy tool are ever blacked out or turned to *** ---

const SENSITIVE = new Set(['device', 'devices', 'peer', 'peer-to-peer', 'someone', 'anyone', 'everyone', 'people', 'person', 'room', 'code', 'name', 'host', 'guest', 'file', 'files', 'text', 'message', 'messages', 'data', 'private', 'nothing', 'uploaded', 'stored', 'things']);
const core = (w) => w.toLowerCase().replace(/[^a-z-]/g, '');
const calm = matchMedia('(prefers-reduced-motion: reduce)');
// extra: more words to target, e.g. the person's name in "Bob joined"
function redact(el, text, offset = 0, extra = []) {
  clearTimeout(el._t1); clearTimeout(el._t2);
  el.textContent = '';
  el.setAttribute('aria-label', text);
  const targets = new Set(extra.map(core));
  const words = text.split(' ');
  const spans = words.map((w, i) => {
    const s = h('span', 'rd', w);
    s.setAttribute('aria-hidden', 'true');
    el.append(s, i < words.length - 1 ? ' ' : '');
    return s;
  });
  const hits = words.map((w, i) => i).filter((i) => SENSITIVE.has(core(words[i])) || targets.has(core(words[i])));
  if (calm.matches || !hits.length) return; // nothing worth hiding in this line
  const cycle = () => {
    if (!el.isConnected) return; // gone for good, stop the timers
    const first = hits[Math.floor(Math.random() * hits.length)];
    const pick = [first];
    if (Math.random() < 0.35 && hits.includes(first + 1)) pick.push(first + 1); // two meaningful words side by side
    const stars = Math.random() >= 0.6;
    for (const i of pick) {
      if (stars) {
        const [, lead, body, tail] = /^(\W*)(.*?)(\W*)$/.exec(words[i]);
        spans[i].textContent = lead + '*'.repeat(Math.max(3, body.length)) + tail;
        spans[i].classList.add('star');
      } else spans[i].classList.add('bar');
    }
    el._t2 = setTimeout(() => {
      for (const i of pick) { spans[i].textContent = words[i]; spans[i].className = 'rd'; }
      el._t1 = setTimeout(cycle, 1600 + Math.random() * 2600);
    }, 900 + Math.random() * 900);
  };
  el._t1 = setTimeout(cycle, 600 + offset + Math.random() * 3000);
}
document.querySelectorAll('.redact').forEach((el) => redact(el, el.dataset.redact, Number(el.dataset.offset || 0)));

// --- views ---

let pane = 'thread'; // phones show the thread or the room details (code, people, requests), never both
function setView(v) {
  $('app').dataset.view = v;
  for (const id of ['start', 'room']) $('v-' + id).hidden = id !== v;
}
function setPane(p) {
  pane = p;
  $('app').dataset.pane = p;
  if (p === 'thread') $('thread').scrollTop = $('thread').scrollHeight;
}
function status(msg, cls = '') {
  $('status').textContent = msg;
  $('status').className = 'status ' + cls;
}

const busy = () => sending > 0 || incoming.size > 0;
function leave() {
  if (busy() && !confirm('A transfer is in progress. Leave anyway?')) return;
  reset(isHost ? 'Room closed.' : 'You left the room.');
}

function reset(msg, cls) {
  peer?.destroy();
  peer = hostId = isHost = roomCode = null;
  members.clear(); pending.clear(); allowed.clear(); incoming.clear();
  sending = 0;
  outbox.length = 0;
  queue = Promise.resolve();
  for (const it of thread) if (it.blobUrl) URL.revokeObjectURL(it.blobUrl);
  thread.length = 0;
  $('thread').textContent = '';
  setView('start');
  setPane('thread');
  status(msg || '', cls);
}

// --- name and code entry ---

try { $('name').value = localStorage.getItem('droplink-name') || ''; } catch {}
function takeName() {
  myName = $('name').value.trim().slice(0, 24);
  if (!myName) { status('Enter your name first.', 'bad'); $('name').focus(); return false; }
  try { localStorage.setItem('droplink-name', myName); } catch {}
  return true;
}

const cells = [...document.querySelectorAll('.cell')];
const clean = (s) => [...s.toUpperCase()].filter((c) => ALPHABET.includes(c));
const readCode = () => cells.map((c) => c.value).join('');
const syncJoin = () => { $('join').disabled = readCode().length !== 6; };
function fill(i, chars) {
  chars.forEach((ch, k) => { if (cells[i + k]) cells[i + k].value = ch; });
  cells[Math.min(i + chars.length, 5)].focus();
  syncJoin();
}
cells.forEach((c, i) => {
  c.addEventListener('focus', () => c.select());
  c.addEventListener('input', () => {
    const v = clean(c.value);
    c.value = '';
    if (v.length) fill(i, v); else syncJoin();
  });
  c.addEventListener('paste', (e) => {
    e.preventDefault();
    const v = clean(e.clipboardData.getData('text'));
    fill(v.length >= 6 ? 0 : i, v);
  });
  c.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !c.value && i > 0) { e.preventDefault(); cells[i - 1].value = ''; cells[i - 1].focus(); syncJoin(); }
    else if (e.key === 'ArrowLeft' && i > 0) cells[i - 1].focus();
    else if (e.key === 'ArrowRight' && i < 5) cells[i + 1].focus();
    else if (e.key === 'Enter' && !$('join').disabled) $('join').click();
  });
});

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

// --- room setup (the public PeerJS broker only introduces peers; data never goes through it) ---

function newPeer(id) {
  const p = new Peer(id, { config: { iceServers: ICE } });
  p.on('connection', (conn) => wire(conn, false));
  p.on('error', (e) => {
    if (e.type === 'unavailable-id' && isHost) { p.destroy(); return startHost(); }
    if (e.type === 'peer-unavailable' && !members.size) return reset('No room with that code.', 'bad');
    if (e.type === 'peer-unavailable') return; // a member left while we were linking up
    reset(`Connection problem (${e.type}).`, 'bad');
  });
  return p;
}

function startHost() {
  if (!takeName()) return;
  isHost = true;
  roomCode = newCode();
  peer = newPeer(PREFIX + roomCode);
  peer.on('open', () => {
    setView('room');
    setPane('thread');
    sysLine('Room open. Files and text you send now go to everyone who joins.');
    renderRoom();
  });
}

function startJoin(code) {
  if (!takeName()) return;
  roomCode = code;
  hostId = PREFIX + code;
  setView('room');
  setPane('thread');
  sysLine('Waiting for the host to let you in…');
  renderRoom();
  peer = newPeer();
  peer.on('open', () => connectTo(hostId));
}

function connectTo(id) {
  wire(peer.connect(id, { serialization: 'raw', reliable: true }), true);
}

// --- messaging ---

const sendJson = (conn, m) => conn.open && conn.send(JSON.stringify(m));

function wire(conn, outbound) {
  conn.outbound = outbound;
  // Only the side that dialled greets first; the other side answers once it has decided to accept (host: after approval).
  conn.on('open', () => outbound && sendJson(conn, { t: 'hi', name: myName }));
  conn.on('data', (d) => (typeof d === 'string' ? onControl(conn, JSON.parse(d)) : onChunk(conn, d)));
  conn.on('close', () => {
    pending.delete(conn.peer);
    const m = members.get(conn.peer);
    if (m?.conn === conn) {
      members.delete(conn.peer);
      incoming.delete(conn.peer);
      sysLine(`${m.name} left`, m.name);
      if (!isHost && !members.size) return reset('The room is closed.');
    }
    renderRoom();
  });
}

function addMember(conn, name) {
  const nm = String(name).trim().slice(0, 24) || 'Guest';
  members.set(conn.peer, { conn, name: nm });
  sysLine(`${nm} joined`, nm);
  renderRoom();
  // hand the newcomer everything this device has sent so far (queued behind any transfer already running)
  for (const entry of outbox) queueDeliver(entry, [members.get(conn.peer)]);
}

function onControl(conn, m) {
  const id = conn.peer;
  const fromHost = id === hostId;
  if (m.t === 'hi') {
    if (members.has(id)) return;
    if (conn.outbound) return addMember(conn, m.name); // we chose this target
    if (isHost) {
      if (members.size + pending.size >= MAX_MEMBERS - 1) return conn.close();
      pending.set(id, { conn, name: String(m.name).trim().slice(0, 24) || 'Guest' });
      if ($('auto').checked) return approve(id, true);
      return renderRoom();
    }
    if (allowed.has(id)) { addMember(conn, m.name); sendJson(conn, { t: 'hi', name: myName }); } else conn.close();
  } else if (m.t === 'welcome' && fromHost && conn.outbound) {
    addMember(conn, m.hostName);
    for (const pid of m.peers) if (pid !== peer.id) connectTo(pid);
  } else if (m.t === 'denied' && fromHost) {
    reset('The host declined your request.', 'bad');
  } else if (m.t === 'joining' && fromHost) {
    allowed.add(m.id);
  } else if (members.has(id)) {
    const who = members.get(id).name;
    if (m.t === 'text') {
      addItem({ kind: 'text', dir: 'in', from: who, text: m.v });
    } else if (m.t === 'file') {
      const item = addItem({ kind: 'file', dir: 'in', from: who, name: m.name, size: m.size, type: m.type, bytes: 0, state: 'active' });
      incoming.set(id, { item, parts: [] });
    } else if (m.t === 'end' && incoming.has(id)) {
      const { item, parts } = incoming.get(id);
      incoming.delete(id);
      item.blobUrl = URL.createObjectURL(new Blob(parts, { type: item.type }));
      item.state = 'done';
      update(item, true);
    }
  }
}

function onChunk(conn, buf) {
  const f = incoming.get(conn.peer);
  if (!f) return;
  f.parts.push(buf);
  f.item.bytes += buf.byteLength;
  tick(f.item);
  update(f.item);
}

function approve(id, ok) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (!ok) { sendJson(p.conn, { t: 'denied' }); setTimeout(() => p.conn.close(), 300); return renderRoom(); }
  for (const { conn } of members.values()) sendJson(conn, { t: 'joining', id });
  addMember(p.conn, p.name);
  sendJson(p.conn, { t: 'welcome', hostName: myName, peers: [...members.keys()].filter((k) => k !== id) });
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
  Object.assign(it, { state: 'active', delivering: names, bytes: 0, samples: [], speed: 0 });
  update(it, true);
  for (const { conn } of targets) sendJson(conn, { t: 'file', name: file.name, size: file.size, type: file.type });
  for (let off = 0; off < file.size; off += CHUNK) {
    const chunk = await file.slice(off, off + CHUNK).arrayBuffer();
    for (const { conn } of targets) {
      while (conn.open && conn.dataChannel.bufferedAmount > BUFFER_HIGH) await new Promise((r) => setTimeout(r, 25));
      if (conn.open) conn.send(chunk);
    }
    it.bytes = Math.min(file.size, off + CHUNK);
    tick(it);
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
  const item = addItem({ kind: 'file', dir: 'out', name: file.name, size: file.size, type: file.type, bytes: 0, state: 'done', names: [], delivering: [] });
  if (file.type.startsWith('image/')) { item.blobUrl = URL.createObjectURL(file); update(item, true); }
  const entry = { kind: 'file', file, sentTo: new Set(), item };
  outbox.push(entry);
  queueDeliver(entry, everyone);
}

const enqueue = (files) => files.forEach(shareFile);
// a host can share while alone (it is held for whoever joins); a guest needs someone to share with
const canShare = () => isHost || everyone().length > 0;

// --- thread ---

const thread = []; // { kind: 'text'|'file'|'system', dir, from, name, size, type, bytes, state, blobUrl, text, el, ui }

function sysLine(text, who = '') {
  const el = h('div', 'sys');
  $('thread').append(el);
  redact(el, text, Math.random() * 1500, who.split(' ').filter(Boolean));
  thread.push({ kind: 'system', el });
  stick();
}

function stick() {
  const t = $('thread');
  t.scrollTop = t.scrollHeight;
}

function copyBtn(label, getText) {
  const b = h('button', 'link');
  b.type = 'button';
  b.append(icon('copy'), label);
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

function addItem(it) {
  const out = it.dir === 'out';
  const row = h('div', 'row' + (out ? ' out' : ''));
  if (!out) row.append(avatar(it.from));
  const bubble = h('div', 'bubble' + (it.kind === 'file' ? ' file' : ''));
  if (it.kind === 'text') {
    bubble.append(h('pre', '', it.text), copyBtn('Copy', () => it.text));
    if (out) { it.ui = { meta: h('div', 'fmeta') }; bubble.append(it.ui.meta); }
  } else {
    it.ui = { pv: h('div', 'pv'), meta: h('div', 'fmeta'), track: h('div', 'track'), fill: h('i'), save: null };
    it.ui.pv.hidden = true;
    it.ui.track.append(it.ui.fill);
    const info = h('div', 'finfo');
    info.append(h('div', 'fname', it.name), it.ui.meta);
    const frow = h('div', 'frow');
    frow.append(icon(fileIcon(it), 'fico'), info);
    it.ui.frow = frow;
    bubble.append(it.ui.pv, frow, it.ui.track);
    it.samples = [];
    it.paint = 0;
  }
  row.append(bubble);
  it.el = row;
  thread.push(it);
  $('thread').append(row);
  if (it.ui) update(it, true);
  stick();
  return it;
}

// rolling transfer speed over roughly the last second
function tick(it) {
  const now = performance.now();
  it.samples.push({ t: now, b: it.bytes });
  while (it.samples.length > 2 && now - it.samples[0].t > 1000) it.samples.shift();
  const a = it.samples[0];
  it.speed = now - a.t > 200 ? ((it.bytes - a.b) / (now - a.t)) * 1000 : it.speed || 0;
}

function update(it, force) {
  if (it.kind === 'text') {
    it.ui.meta.textContent = '';
    if (it.names.length) it.ui.meta.append(icon('checks'), `Sent to ${it.names.join(', ')}`);
    else it.ui.meta.textContent = 'Held · goes to anyone who joins';
    return;
  }
  const now = performance.now();
  if (!force && now - it.paint < 100) return; // chunks arrive far faster than the screen needs
  it.paint = now;
  const { meta, fill, track, pv, frow } = it.ui;
  const active = it.state === 'active';
  const pct = it.size ? Math.min(100, Math.floor((it.bytes / it.size) * 100)) : 100;
  fill.style.width = (active ? pct : 100) + '%';
  track.hidden = !active;
  meta.textContent = '';
  if (active) {
    const speed = it.speed ? ` · ${fmt(it.speed)}/s` : '';
    meta.textContent = `${it.dir === 'out' ? `To ${it.delivering.join(', ')} · ` : ''}${pct}% of ${fmt(it.size)}${speed}`;
  } else if (it.dir === 'out') {
    if (it.names.length) meta.append(icon('checks'), `Delivered to ${it.names.length} · ${fmt(it.size)}`);
    else meta.textContent = `Ready · goes to anyone who joins · ${fmt(it.size)}`;
  } else {
    meta.textContent = fmt(it.size);
  }
  if (it.blobUrl && !pv.firstChild && it.type.startsWith('image/')) {
    pv.append(Object.assign(h('img'), { src: it.blobUrl, alt: '' }));
    pv.hidden = false;
  }
  if (!active && it.dir === 'in' && !it.ui.save) {
    it.ui.save = Object.assign(h('a', 'save'), { href: it.blobUrl, download: it.name });
    it.ui.save.append(icon('download-simple'), 'Save');
    frow.append(it.ui.save);
  }
}

// --- rendering the room (side panel, chips, requests, controls) ---

function renderRoom() {
  if (!roomCode) return;
  const code = roomCode;
  $('room-code').textContent = '';
  $('room-code').append(code.slice(0, 3), Object.assign(h('span', 'dim', '·')), code.slice(3));
  $('head-code').textContent = code.slice(0, 3) + '·' + code.slice(3);
  const ph = $('phonetic');
  ph.textContent = '';
  ph.append(h('span', 'ph1', say(code.slice(0, 3))), h('span', 'sep', ' — '), h('span', 'ph2', say(code.slice(3))));

  const total = members.size + 1;
  $('mem-n').textContent = `${total} of ${MAX_MEMBERS}`;
  const list = $('mem-list');
  list.textContent = '';
  const mine = h('li', 'person');
  mine.append(avatar(myName, 'lg me'), Object.assign(h('span', 'who'), { textContent: myName }));
  mine.lastChild.append(h('small', '', isHost ? ' · you, host' : ' · you'));
  list.append(mine);
  const chips = $('chips');
  chips.textContent = '';
  const me = h('span', 'chip me');
  me.append(avatar(myName, 'me'), 'You');
  chips.append(me);
  for (const [id, m] of members) {
    const li = h('li', 'person');
    li.append(avatar(m.name, 'lg'), h('span', 'who', m.name));
    if (id === hostId) li.lastChild.append(h('small', '', ' · host'));
    list.append(li);
    const c = h('span', 'chip');
    c.append(avatar(m.name), m.name);
    chips.append(c);
  }

  const reqs = $('req-list');
  reqs.textContent = '';
  $('req-wrap').hidden = !pending.size;
  $('req-n').textContent = pending.size;
  for (const [id, p] of pending) {
    const row = h('div', 'person req');
    row.append(avatar(p.name, 'lg'), h('span', 'who', p.name));
    const no = h('button', 'icon-btn');
    no.type = 'button';
    no.setAttribute('aria-label', `Deny ${p.name}`);
    no.append(icon('x'));
    const yes = h('button', 'btn allow');
    yes.type = 'button';
    yes.setAttribute('aria-label', `Allow ${p.name}`);
    yes.append(icon('check'), h('span', '', 'Allow'));
    const decide = (ok) => { row.classList.add('fade'); setTimeout(() => approve(id, ok), 150); };
    no.onclick = () => decide(false);
    yes.onclick = () => decide(true);
    row.append(no, yes);
    reqs.append(row);
  }
  const badge = $('badge');
  badge.hidden = !(isHost && pending.size);
  badge.textContent = `${pending.size} waiting`;

  $('auto-wrap').hidden = !isHost;
  $('leave-m-t').textContent = isHost ? 'Close' : 'Leave';
  $('leave-d-t').textContent = isHost ? 'Close room' : 'Leave room';
  for (const id of ['text', 'send', 'attach']) $(id).disabled = !canShare();
}

// --- wiring ---

$('host').onclick = startHost;
$('join').onclick = () => (CODE_RE.test(readCode()) ? startJoin(readCode()) : status('Enter all 6 characters.', 'bad'));
for (const id of ['leave-m', 'leave-d', 'leave-t']) $(id).onclick = leave;
$('to-thread').onclick = () => setPane('thread');
$('badge').onclick = () => setPane('side');
$('head-code').onclick = () => setPane('side');
$('auto').onchange = () => { if ($('auto').checked) for (const id of [...pending.keys()]) approve(id, true); };
for (const id of ['copy-code-m', 'copy-code-d']) {
  $(id).onclick = async () => {
    try { await navigator.clipboard.writeText(roomCode); } catch { return; }
    const b = $(id);
    const old = b.querySelector('svg');
    old.replaceWith(icon('check'));
    setTimeout(() => b.querySelector('svg').replaceWith(icon('copy')), 1200);
  };
}

const text = $('text');
const wide = matchMedia('(min-width: 760px)');
const setPlaceholder = () => { text.placeholder = wide.matches ? 'Message, paste, or drop files — ⌘↵ to send' : 'Message or paste…'; };
setPlaceholder();
wide.addEventListener('change', setPlaceholder);
text.addEventListener('input', () => { text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight, 120) + 'px'; });
text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('composer').requestSubmit(); } });
text.addEventListener('paste', (e) => {
  if (e.clipboardData.files.length) { e.preventDefault(); enqueue([...e.clipboardData.files]); }
});
$('composer').onsubmit = (e) => {
  e.preventDefault();
  if (!text.value.trim() || !canShare()) return;
  shareText(text.value);
  text.value = '';
  text.style.height = 'auto';
};
$('attach').onclick = () => $('files').click();
$('files').onchange = () => { if (canShare()) enqueue([...$('files').files]); $('files').value = ''; };

// drag and drop anywhere on the page while in a room
let drags = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const canDrop = () => $('app').dataset.view === 'room' && canShare();
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

// ?c= deep link still works; the code just pre-fills the entry cells
const preset = (new URLSearchParams(location.search).get('c') || '').toUpperCase();
if (CODE_RE.test(preset)) {
  history.replaceState(null, '', location.pathname); // keep the code out of history
  fill(0, [...preset]);
  if ($('name').value) $('join').click();
  else { status('Enter your name, then press Connect.'); $('name').focus(); }
}
syncJoin();
