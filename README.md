# Signal — Real-time Transmission

Private real-time chat rooms. Create a session, share the ID (or invite link), chat live.

- **Repo:** https://github.com/R1T1KKUMAR/real-time-chat
- **Live (Render):** https://github.com/R1T1KKUMAR/real-time-chat *(replace with your `*.onrender.com` app URL after deploy)*

## Features

- **Private rooms** — 6-char session IDs, shareable invite links (`?session=XXXXXX`)
- **End-to-end encryption** — AES-GCM room key travels in the URL hash (`#k=…`), never touches the server; key fingerprint to verify with your partner
- **Live everything** — presence, typing indicators, read receipts (✓ / ✓✓), reactions, replies
- **Rich messages** — images (≤1.5MB), voice notes (Opus, ≤2min), files (≤3MB), polls with live tallies
- **Disappearing messages** — sender-side TTL: 10s / 1m / 1h, shredded server- and client-side
- **Screenshot deterrents (best-effort)** — tracing watermark, blur-on-background privacy shield, PrintScreen flash-blank, print/save blocked. Note: no website can truly block OS-level capture
- **Installable PWA** — reliable Android install button + manual fallback, offline app shell, no-cache service worker updates
- **Mobile-first** — collapsible ＋ composer menu on phones, safe-area support, adaptive 320px → ultrawide
- **Themes** — Signal dark / Midnight / Sunset (+ sounds toggle)

## Quick start

```bash
npm install
npm run dev      # development — http://localhost:3000
npm start        # production (NODE_ENV=production)
```

Docker:

```bash
docker compose up --build   # http://localhost:3000
```

Health check: `GET /health` → `{ status, version, uptime, sessions, totalUsers }`.

## Deploy on Render

`render.yaml` is included (free web service, `npm install` → `npm start`, health check `/health`).

1. Push to GitHub, **New → Web Service → select this repo**
2. Build: `npm install` · Start: `npm start` · Health check path: `/health`
3. HTTPS is automatic (required for PWA install + WebCrypto E2EE)
4. After deploy, update the **Live** link at the top of this README with your `https://<service>.onrender.com` URL

## Project structure

```
index.js                 Express + Socket.IO server, session store, validation
public/index.html        App shell (sidebar, chat, composer, modals)
public/main.js           Client: E2EE, rendering, receipts, PWA install, shields
public/style.css         Design system + responsive rules
public/sw.js             Service worker (app-shell cache only, never chat traffic)
public/qr.js             Local invite-QR encoder (link+key never leave the browser)
public/manifest.webmanifest  PWA manifest + icons in public/icons/
render.yaml / Dockerfile / docker-compose.yml
```

## Versioning note

Bump these three together on every shell (html/css/js) change, or installed apps go stale:

1. `APP_VERSION` in `index.js`
2. `?v=` query in `public/index.html` script tags
3. `CACHE` in `public/sw.js`

## Security notes

- Server validates usernames, session IDs, message sizes, image/file types, reaction allowlist, and rate-limits messages, votes, and session creation
- Security headers via `helmet`; E2EE envelopes are opaque to the server
- Screenshot protection is a deterrent, not a guarantee — true blocking needs a native wrapper (`FLAG_SECURE` / `preventScreenCapture` / Electron `setContentProtection`)

## License

ISC
