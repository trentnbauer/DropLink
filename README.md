# DropLink

Static page for sending text and files between devices in a room. Nothing is uploaded or stored.
Devices find each other through the public PeerJS broker (`0.peerjs.com`), then talk directly over WebRTC.

- Start a room and read the 6-character code (it also shows a phonetic spelling) to the other people, or join by typing a code.
- The host approves each person. Rooms hold up to 8 people and everyone is linked to everyone.
- Text and files go straight between devices. Names are shown on everything people send.
- A `?c=CODE` link pre-fills the join form.

## Host on GitHub Pages
One-time: Settings > Pages > Source: **GitHub Actions**. After that every push to `main` redeploys
via `.github/workflows/pages.yml` (also runnable by hand from the Actions tab).

## Notes
- No build step. The theme is "4b Redacted, dark": colours are the CSS variables at the top of `style.css`.
- Everything is self-hosted for the strict CSP: PeerJS in `vendor/`, IBM Plex Mono and Courier Prime (headings) in `fonts/`, Phosphor icons inlined in `index.html`.
- Strict networks may need a TURN relay: add it to `ICE` at the top of `app.js`.
- To use your own broker, pass `{ host, port, path, secure }` to `new Peer(...)` in `app.js`.
