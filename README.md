# DropLink

Send text and files between devices in a room. Nothing is uploaded or stored: devices connect to each other directly,
and a small TURN relay carries the (encrypted) traffic for networks that cannot connect directly.

- Start a room and you are in the app straight away. Read the 6-character code (it also shows a phonetic spelling) to other people, or join by typing a code.
- Anything you send is held on your device and handed to everyone who joins later, so you can share first and have people join afterwards. People who joined earlier get it live.
- The host approves each person (one tap) while the guest sees a "Knocking" screen, or ticks "Let people in without asking" and guests go straight in. Rooms hold up to 8 people and everyone is linked to everyone.
- Names are shown on everything people send. A `?c=CODE` link pre-fills the join form.
- Held items live in the sender's open tab. If a sender closes the page, what only they had is gone.

## Run it
```
cp .env.example .env     # set TURN_HOST and TURN_SECRET (openssl rand -hex 24)
docker compose up -d --build
```
The web app is on port `WEBPORT` (default 3000). Put it behind a Cloudflare Tunnel or any reverse proxy. It must be served over
HTTPS for browsers to allow everything it needs.

- **Dockflare:** use the complete `docker-compose.dockflare.yml` instead of `docker-compose.yml` (web app, relay and Dockflare labels in one file):
  `docker compose -f docker-compose.dockflare.yml up -d --build`. Set `DOMAIN`, `SUBDOMAIN` (with its trailing dot) and `HOSTNAME` in `.env`. Dockflare then creates the hostname and tunnel route.
- **Plain Cloudflare Tunnel:** `docker compose --profile tunnel up -d` with `TUNNEL_TOKEN` set, hostname pointing at `http://app:3000`.

Two containers:
- **app**: serves the page and hands each device short-lived relay credentials at `/config.json` (valid 24 hours, derived from `TURN_SECRET`). Read-only filesystem, nothing written to disk.
- **turn**: a [coturn](https://github.com/coturn/coturn) relay on the host network.

## The relay needs open ports
A Cloudflare Tunnel only carries web traffic, so the relay has to be reachable directly:
- Forward **UDP and TCP 3478** and **UDP 49160-49300** from your router to this machine.
- `TURN_HOST` is the name or IP devices use from outside. If it is a DNS name, make it **DNS only** (grey cloud in Cloudflare).
- If the machine is behind NAT, set `TURN_EXTERNAL_IP=PUBLIC_IP/LAN_IP` (for example `203.0.113.5/10.0.0.246`).

Without a relay, joining fails after 20 seconds with "Couldn't connect to the host" on networks that block direct links (mobile data, strict routers, offices, two devices behind one router).

To test the relay, set `ICE_POLICY=relay` in `.env` and restart: every connection is then forced through it, so if people still connect, the relay works. Remove it afterwards.

## Notes
- The relay refuses to forward to private address ranges (10/8, 172.16/12, 192.168/16, 127/8, link-local), so the public credentials cannot be used to reach into your home network. Set `TURN_ALLOW_PRIVATE=1` only for testing on a private network.
- Devices find each other through the public PeerJS broker (`0.peerjs.com`), which sees connection setup (IP addresses) but never files or text. To use your own broker, pass `{ host, port, path, secure }` to `new Peer(...)` in `public/app.js` and add it to the CSP in `public/index.html`.
- No build step. The theme is "4b Redacted, dark": colours are the CSS variables at the top of `public/style.css`. Fonts and icons are self-hosted for the strict CSP.
- Tests: `npm test` (server only; no dependencies to install).
