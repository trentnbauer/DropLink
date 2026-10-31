const $ = (id) => document.getElementById(id);
const CHUNK = 16 * 1024; // safe size for every browser's data channel
const BUFFER_HIGH = 4 * 1024 * 1024;
const MAX_MEMBERS = 8; // everyone links to everyone, so keep rooms small
const PREFIX = 'droplink-';
// STUN finds a direct path across the internet. Add a TURN entry here for networks that block direct links.
const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];

let peer, myName, hostId, isHost, scanStream;
const members = new Map(); // peer id -> { conn, name }: approved people we can talk to
const pending = new Map(); // host only: peer id -> { conn, name } waiting for approval
const allowed = new Set(); // ids the host announced as approved newcomers
const incoming = new Map(); // peer id -> file being received

function show(...ids) {
  for (const id of ['start', 'scanner', 'waiting', 'connected']) $(id).hidden = !ids.includes(id);
}
function status(msg, cls = '') {
  $('status').textContent = msg;
  $('status').className = 'status ' + cls;
}

function reset(msg, cls) {
  stopScan();
  peer?.destroy();
  peer = hostId = isHost = null;
  members.clear(); pending.clear(); allowed.clear(); incoming.clear();
  $('log').textContent = '';
  $('log').hidden = true;
  renderPending();
  show('start');
  status(msg || '', cls);
}

// --- name ---

function loadName() {
  try { $('name').value = localStorage.getItem('droplink-name') || ''; } catch {}
}
function takeName() {
  myName = $('name').value.trim().slice(0, 24);
  if (!myName) { status('Enter your name first.', 'bad'); $('name').focus(); return false; }
  try { localStorage.setItem('droplink-name', myName); } catch {}
  return true;
}

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
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  peer = newPeer(PREFIX + code);
  peer.on('open', () => {
    const q = qrcode(0, 'M');
    q.addData(`${location.origin}${location.pathname}?c=${code}`);
    q.make();
    $('code').textContent = code;
    $('qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    show('waiting', 'connected');
    $('connected').hidden = false;
    renderMembers();
    status('Room open. Waiting for people…');
  });
}

function startJoin(code) {
  if (!takeName()) return;
  status('Connecting…');
  hostId = PREFIX + code;
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
  conn.on('open', () => sendJson(conn, { t: 'hi', name: myName }));
  conn.on('data', (d) => (typeof d === 'string' ? onControl(conn, JSON.parse(d)) : onChunk(conn, d)));
  conn.on('close', () => {
    pending.delete(conn.peer);
    if (members.get(conn.peer)?.conn === conn) {
      const name = members.get(conn.peer).name;
      members.delete(conn.peer);
      incoming.delete(conn.peer);
      renderMembers();
      status(`${name} left.`);
      if (!isHost && !members.size) reset('The room is closed.');
    }
    renderPending();
  });
}

function addMember(conn, name) {
  members.set(conn.peer, { conn, name: String(name).trim().slice(0, 24) || 'Guest' });
  show('connected');
  $('waiting').hidden = !isHost;
  renderMembers();
  status('Connected directly.', 'ok');
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
      return renderPending();
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
      addItem(`${who} sent text`, null).querySelector('div').append(Object.assign(document.createElement('pre'), { textContent: m.v }));
    } else if (m.t === 'file') {
      incoming.set(id, { meta: m, parts: [], got: 0, item: addItem(`Receiving ${m.name} from ${who}`, m.size) });
    } else if (m.t === 'end' && incoming.has(id)) {
      const { meta, parts, item } = incoming.get(id);
      incoming.delete(id);
      item.querySelector('progress')?.remove();
      item.querySelector('small').textContent = `${who} sent ${meta.name} (${fmt(meta.size)})`;
      item.querySelector('div').append(Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob(parts, { type: meta.type })),
        download: meta.name,
        textContent: `Save ${meta.name}`,
      }));
    }
  }
}

function onChunk(conn, buf) {
  const f = incoming.get(conn.peer);
  if (!f) return;
  f.parts.push(buf);
  f.got += buf.byteLength;
  f.item.querySelector('progress').value = f.got;
}

function approve(id, ok) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (!ok) { sendJson(p.conn, { t: 'denied' }); setTimeout(() => p.conn.close(), 300); return renderPending(); }
  for (const { conn } of members.values()) sendJson(conn, { t: 'joining', id });
  addMember(p.conn, p.name);
  sendJson(p.conn, { t: 'welcome', hostName: myName, peers: [...members.keys()].filter((k) => k !== id) });
  renderPending();
}

const everyone = () => [...members.values()].filter((m) => m.conn.open);

async function sendFile(file) {
  const targets = everyone();
  const item = addItem(`Sending ${file.name} to ${targets.length} ${targets.length === 1 ? 'person' : 'people'}`, file.size);
  for (const { conn } of targets) sendJson(conn, { t: 'file', name: file.name, size: file.size, type: file.type });
  for (let off = 0; off < file.size; off += CHUNK) {
    const chunk = await file.slice(off, off + CHUNK).arrayBuffer();
    for (const { conn } of targets) {
      while (conn.open && conn.dataChannel.bufferedAmount > BUFFER_HIGH) await new Promise((r) => setTimeout(r, 25));
      if (conn.open) conn.send(chunk);
    }
    item.querySelector('progress').value = off + CHUNK;
  }
  for (const { conn } of targets) sendJson(conn, { t: 'end' });
  item.querySelector('progress').remove();
  item.querySelector('small').textContent = `Sent ${file.name} (${fmt(file.size)})`;
}

let queue = Promise.resolve(); // one file at a time keeps each stream unambiguous
const enqueue = (files) => { for (const f of files) queue = queue.then(() => sendFile(f)); };

// --- UI helpers ---

function fmt(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

function addItem(title, size) {
  $('log').hidden = false;
  const el = document.createElement('div');
  el.className = 'item';
  const small = document.createElement('small');
  small.textContent = title;
  el.append(small, document.createElement('div'));
  if (size) el.append(Object.assign(document.createElement('progress'), { max: size, value: 0 }));
  $('log').prepend(el);
  return el;
}

function renderMembers() {
  const names = [myName + ' (you)', ...[...members.values()].map((m) => m.name)];
  $('members').textContent = `In this room: ${names.join(', ')}`;
}

function renderPending() {
  const box = $('pending');
  box.textContent = '';
  box.hidden = !pending.size;
  for (const [id, p] of pending) {
    const row = document.createElement('div');
    row.className = 'pend';
    row.append(Object.assign(document.createElement('span'), { textContent: `${p.name} wants to join` }));
    const yes = Object.assign(document.createElement('button'), { textContent: 'Allow', onclick: () => approve(id, true) });
    const no = Object.assign(document.createElement('button'), { textContent: 'Deny', className: 'alt', onclick: () => approve(id, false) });
    row.append(yes, no);
    box.append(row);
  }
}

// --- QR scanning ---

async function startScan() {
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    return status('Camera unavailable. Type the code instead.', 'bad');
  }
  show('scanner');
  const v = $('video');
  v.srcObject = scanStream;
  await v.play();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tick = () => {
    if (!scanStream) return;
    if (v.videoWidth) {
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      ctx.drawImage(v, 0, 0);
      const r = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      const code = r && /(?:[?&]c=|^)(\d{6})$/.exec(r.data)?.[1];
      if (code) { stopScan(); show('start'); $('join-code').value = code; return startJoin(code); }
    }
    requestAnimationFrame(tick);
  };
  tick();
}

function stopScan() {
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = null;
}

// --- wiring ---

loadName();
$('host').onclick = startHost;
$('join').onclick = () => /^\d{6}$/.test($('join-code').value) ? startJoin($('join-code').value) : status('Enter all 6 digits.', 'bad');
$('join-code').onkeydown = (e) => e.key === 'Enter' && $('join').click();
$('scan').onclick = () => takeName() && startScan();
$('scan-cancel').onclick = () => { stopScan(); show('start'); };
$('leave').onclick = () => reset('You left the room.');
$('send-text').onclick = () => {
  const v = $('text').value;
  const to = everyone();
  if (!v || !to.length) return;
  for (const { conn } of to) sendJson(conn, { t: 'text', v });
  addItem('You sent text', null).querySelector('div').append(Object.assign(document.createElement('pre'), { textContent: v }));
  $('text').value = '';
};
$('send-files').onclick = () => { if (everyone().length) enqueue([...$('files').files]); $('files').value = ''; };
$('drop').ondragover = (e) => { e.preventDefault(); $('drop').classList.add('over'); };
$('drop').ondragleave = () => $('drop').classList.remove('over');
$('drop').ondrop = (e) => { e.preventDefault(); $('drop').classList.remove('over'); if (everyone().length) enqueue([...e.dataTransfer.files]); };

const preset = new URLSearchParams(location.search).get('c');
if (/^\d{6}$/.test(preset || '')) {
  history.replaceState(null, '', location.pathname); // keep the code out of history
  $('join-code').value = preset;
  if ($('name').value) $('join').click();
  else status('Enter your name, then press Connect.');
}
