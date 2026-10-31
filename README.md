# DropLink

Static page for sending text and files between devices in a room. Nothing is uploaded or stored.
Devices find each other through the public PeerJS broker (`0.peerjs.com`), then talk directly over WebRTC.

## Host on GitHub Pages
Push this folder to a repo, then Settings > Pages > Deploy from branch > `main` / root.

## Notes
- Libraries are vendored in `vendor/` (peerjs 1.5.4, qrcode-generator 1.4.4, jsQR 1.4.0).
- Strict networks may need a TURN relay: add it to `ICE` at the top of `app.js`.
- To use your own broker, pass `{ host, port, path, secure }` to `new Peer(...)` in `app.js`.
