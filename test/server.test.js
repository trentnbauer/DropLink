import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

Object.assign(process.env, { PORT: '0', TURN_HOST: 'turn.example.com', TURN_SECRET: 'sekret', TURN_TTL: '3600' });
const { server } = await import('../server.js');
let base;
before(async () => {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('config.json hands out STUN plus short-lived TURN credentials coturn will accept', async () => {
  const { iceServers } = await fetch(`${base}/config.json`).then((r) => r.json());
  assert.ok(iceServers.some((s) => String(s.urls).startsWith('stun:')));
  const turn = iceServers.find((s) => s.username);
  assert.deepEqual(turn.urls, ['turn:turn.example.com:3478?transport=udp', 'turn:turn.example.com:3478?transport=tcp']);
  const [expiry, who] = turn.username.split(':');
  assert.equal(who, 'droplink');
  const left = Number(expiry) - Date.now() / 1000;
  assert.ok(left > 3500 && left <= 3600, 'expires in about an hour');
  assert.equal(turn.credential, createHmac('sha1', 'sekret').update(turn.username).digest('base64'));
});

test('serves the app and refuses anything outside public/', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<title>DropLink<\/title>/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  for (const bad of ['/server.js', '/package.json', '/%2e%2e/server.js', '/..%2fserver.js', '/test/server.test.js', '/%E0%A4%A']) {
    const r = await fetch(`${base}${bad}`);
    assert.ok(r.status === 404 || r.status === 400, `${bad} -> ${r.status}`);
  }
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});
