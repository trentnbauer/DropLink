# DropLink

Static page for sending text and files between devices in a room. Nothing is uploaded or stored.
Devices find each other through the public PeerJS broker (`0.peerjs.com`), then talk directly over WebRTC.

- Start a room and you are in the app straight away. Read the 6-character code (it also shows a phonetic spelling) to other people, or join by typing a code.
- Anything you send is held on your device and handed to everyone who joins later, so you can share first and have people join afterwards. People who joined earlier get it live.
- The host approves each person (one tap) while the guest sees a "Knocking" screen, or ticks "Let people in without asking" and guests go straight in. Rooms hold up to 8 people and everyone is linked to everyone.
- Text and files go straight between devices. Names are shown on everything people send.
- Held items live in the sender's open tab. If a sender closes the page, what only they had is gone.
- A `?c=CODE` link pre-fills the join form.

## Host on GitHub Pages
One-time: Settings > Pages > Source: **GitHub Actions**. After that every push to `main` redeploys
via `.github/workflows/pages.yml` (also runnable by hand from the Actions tab).

## Connecting across networks (TURN)
Devices connect directly when they can. Many networks cannot (mobile carriers, strict routers, offices, two devices behind the same NAT), and then a **TURN relay** is needed. Without one, joining fails after 20 seconds with "Couldn't connect to the host".

The relay only passes encrypted traffic, and GitHub Pages cannot be one (it only serves static files). Add one to `config.json`:

```json
{
  "iceServers": [
    { "urls": "stun:stun.cloudflare.com:3478" },
    { "urls": "turn:turn.example.com:3478", "username": "user", "credential": "password" }
  ]
}
```

Either a TURN provider that gives you static credentials, or your own `coturn`:

```
docker run -d --network host coturn/coturn -n --realm=droplink --lt-cred-mech --user=user:password --no-tls --listening-port=3478 --min-port=49160 --max-port=49300
```

Open UDP and TCP 3478 plus UDP 49160-49300 to the internet (a Cloudflare Tunnel does not carry these). The credentials are visible to anyone who opens the site, so use a throwaway user.

To check a setup, add `"iceTransportPolicy": "relay"` to `config.json`: everything is then forced through the relay, and if it still connects, TURN works.

## Notes
- No build step. The theme is "4b Redacted, dark": colours are the CSS variables at the top of `style.css`.
- Everything is self-hosted for the strict CSP: PeerJS in `vendor/`, IBM Plex Mono and Courier Prime (headings) in `fonts/`, Phosphor icons inlined in `index.html`.
- To use your own signaling broker instead of `0.peerjs.com`, pass `{ host, port, path, secure }` to `new Peer(...)` in `app.js` and add it to the CSP in `index.html`.
