import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const { TURN_HOST, TURN_SECRET, ICE_POLICY } = process.env;
// Released images get APP_VERSION from the release tag; anything else reports the package version as a dev build.
const VERSION = process.env.APP_VERSION || `${JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version}-dev`;
const TURN_PORT = process.env.TURN_PORT || '3478';
const TURN_TTL_S = Number(process.env.TURN_TTL || 86400); // a relay session ends when its credentials expire
const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2' };

// The relay is open to anyone holding credentials, so hand out ones that expire (coturn's use-auth-secret scheme).
export function iceConfig(now = Date.now()) {
  const iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
  if (TURN_HOST && TURN_SECRET) {
    const username = `${Math.floor(now / 1000) + TURN_TTL_S}:droplink`;
    iceServers.push({
      urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`],
      username,
      credential: createHmac('sha1', TURN_SECRET).update(username).digest('base64'),
    });
  }
  return { iceServers, ...(ICE_POLICY && { iceTransportPolicy: ICE_POLICY }) };
}

const HEADERS = { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

export const server = createServer(async (req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return res.writeHead(400).end(); }
  if (path === '/healthz') return res.writeHead(200).end('ok');
  if (path === '/version') return res.writeHead(200, { ...HEADERS, 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }).end(JSON.stringify({ version: VERSION }));
  if (path === '/config.json') {
    return res.writeHead(200, { ...HEADERS, 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }).end(JSON.stringify(iceConfig()));
  }
  const file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
  const type = TYPES[extname(file)];
  if (!file.startsWith(ROOT) || !type) return res.writeHead(404, HEADERS).end('not found');
  let body;
  try { body = await readFile(file); } catch { return res.writeHead(404, HEADERS).end('not found'); }
  res.writeHead(200, { ...HEADERS, 'Content-Type': type }).end(body);
});

if (!TURN_HOST || !TURN_SECRET) console.warn('TURN_HOST / TURN_SECRET not set: serving STUN only, devices on strict networks will not connect.');
server.listen(PORT, () => console.log(`droplink ${VERSION} listening on :${PORT}`));
