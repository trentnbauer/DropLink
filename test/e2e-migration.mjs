// Browser test: host, Bob, Carol; host's tab dies; Bob takes over; Dave joins via the same code.
// Needs playwright (npm i playwright) and internet (public PeerJS broker). Run: node test/e2e-migration.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const PORT = 3999, URL = `http://localhost:${PORT}/`;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT } });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const page = async () => { const p = await (await browser.newContext({ reducedMotion: 'reduce', bypassCSP: true })).newPage(); await p.goto(URL); return p; };
const until = (p, fn, arg = null) => p.waitForFunction(fn, arg, { timeout: 40000 });
const approveAll = (p) => p.evaluate(() => [...pending.keys()].forEach((id) => approve(id, true)));
const join = async (code) => { const p = await page(); await p.evaluate((c) => { openJoin(c); connect(); }, code); return p; };
try {
  const host = await page();
  await host.evaluate(() => openRoom());
  await until(host, () => $('app').dataset.view === 'room');
  const code = await host.evaluate(() => roomCode);
  const bob = await join(code);
  await until(host, () => pending.size === 1); await approveAll(host);
  await until(bob, () => $('app').dataset.view === 'room');
  const carol = await join(code);
  await until(host, () => pending.size === 1); await approveAll(host);
  await until(carol, () => members.size === 2);
  await until(bob, () => members.size === 2);

  const bobId = await bob.evaluate(() => peer.id);
  await host.close({ runBeforeUnload: true }); // tab vanishes without handing over
  await until(bob, () => isHost === true);
  await until(carol, (id) => hostId === id && !isHost, bobId);

  const dave = await join(code); // same code reaches the new host
  await until(bob, () => pending.size === 1); await approveAll(bob);
  await until(dave, () => members.size === 2);

  await bob.close({ runBeforeUnload: true }); // earliest joiner gone: Carol next, then Dave
  await until(carol, () => isHost === true);
  console.log('ok');
} finally { await browser.close(); srv.kill(); }
