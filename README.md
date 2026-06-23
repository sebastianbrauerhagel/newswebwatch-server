# NewsWeb Monitor — Server

A standalone Node.js/Express service that polls Oslo Børs NewsWeb **24/7, independent of
any browser tab**, matches each message against per-desk ticker lists, and pushes Teams
Adaptive Card notifications directly to each desk's own webhook. It also stores message
history in SQLite and exposes a read-only API for the dashboard.

This replaces the old Vercel architecture where notifications only fired while a user had
the tab open. The Vercel `index.html` stays as a **read-only dashboard** that reads from
this server's API.

## Architecture

```
NewsWeb API ──poll 15s──▶ poller ──match (exact issuerSign)──▶ Teams webhook per desk
                            │
                            └─▶ SQLite (messages + notifications)
                                      │
Vercel index.html ──HTTPS/CORS──▶ Express read API (/api/hits, /api/tickers, /api/stats)
```

### Key behaviours

- **Exact ticker match only.** A keyword matches *only* when it equals the message's
  `issuerSign`. Titles are never substring-matched — this is the old `RING` vs
  `plasse`**`RING`** bug, fixed in [server/matcher.js](server/matcher.js).
- **One webhook per desk**, configured once in `desks-config.json` — not per user.
- **Multi-desk fan-out.** A message can match several desks; each matching desk's webhook
  is notified independently.
- **At-most-once delivery.** The `notifications` table is the persistent dedupe ledger
  (survives restarts). Transient webhook failures retry up to 5 times across ticks, then
  give up and log loudly. A delivered message is never re-sent.
- **Crash recovery + first-run, per desk** ([decideAction in poller.js](server/poller.js)).
  The notify decision is made per `(message, desk)` against the dedupe ledger, not a blanket
  process-start cutoff:
  - *Established desk* (has prior notification history at boot): on restart it **catches up**
    any un-notified matching messages published within `CATCHUP_WINDOW_MS` (default 6h). This
    is what closes the gap when the process is down for a few minutes during market hours.
    Items older than the window are recorded silently (`seeded`) so a long outage can't dump
    a stale burst.
  - *First-ever boot / newly-activated desk* (no history at boot): its current backlog is
    **seeded silently** (recorded, not sent) and it notifies only messages published after
    start — so enabling a desk never replays the day into its channel.
  - The first poll after each (re)start fetches `CATCHUP_FETCH_LIMIT` messages (default 200)
    instead of `NEWSWEB_LIMIT`, so the catch-up window has data to work with.

## Project layout

```
newswebwatch-server/
├── server/
│   ├── index.js        ← Express app + starts poller, signal handling
│   ├── poller.js       ← 15s loop: fetch, store, match, notify
│   ├── matcher.js      ← exact issuerSign match + ignoreWords
│   ├── teams.js        ← Adaptive Card builder + webhook sender
│   ├── newsweb.js      ← Oslo Børs NewsWeb client
│   ├── db.js           ← better-sqlite3 schema + queries
│   ├── config.js       ← env + desks-config loader
│   ├── time.js         ← Oslo-timezone day boundaries
│   ├── log.js          ← timestamped logger
│   └── routes/api.js   ← read-only dashboard endpoints
├── desks-config.example.json   ← template (committed)
├── desks-config.json           ← REAL config w/ webhooks (git-ignored)
├── ecosystem.config.cjs        ← PM2
├── deploy/nginx-newsweb.conf   ← reverse-proxy template
├── data/                       ← SQLite DB (git-ignored, created at runtime)
└── .env.example
```

## Local run

```bash
npm install
cp desks-config.example.json desks-config.json   # then paste in webhook URLs
cp .env.example .env                              # optional; adjust as needed
npm start
```

Requires **Node 20+** (`better-sqlite3` v12 needs it; the server uses the built-in `fetch`).
`better-sqlite3` ships prebuilt binaries for common Node/Linux combos; if it has to compile,
install build tools first: `sudo apt install -y build-essential python3`.

## Configuration

### Desk config — `desks-config.json`

One entry per desk. `teamsWebhookUrl` is a secret, so this file is git-ignored; commit only
`desks-config.example.json`.

```jsonc
{
  "desks": {
    "finanswatch": {
      "label": "FinansWatch",
      "teamsWebhookUrl": "https://...powerautomate.../invoke?...sig=...",
      "keywords": ["DNB", "RING", "SBNK"],   // matched EXACTLY against issuerSign
      "ignoreWords": ["rentefastsettelse"]    // substring match on title → suppress
    }
  }
}
```

Currently **FinansWatch** has a live webhook; the other six desks have empty
`teamsWebhookUrl` placeholders — they store/match normally but don't notify until you add a
URL. After editing the file, restart (`pm2 restart newsweb-monitor`) to load changes.

### Environment — see [.env.example](.env.example)

`PORT`, `HOST`, `POLL_INTERVAL_MS`, `NEWSWEB_LIMIT`, `DB_PATH`, `TZ_NAME`, and
**`ALLOWED_ORIGINS`** (set this to your Vercel origin, e.g.
`https://your-dashboard.vercel.app`). PM2 also sets these in `ecosystem.config.cjs`.

## Dashboard API

All read-only, JSON, CORS-restricted to `ALLOWED_ORIGINS`. "Day" is computed in `TZ_NAME`
(Europe/Oslo), so `date` defaults to *today in Oslo*.

| Endpoint | Description |
|---|---|
| `GET /api/health` | Liveness probe |
| `GET /api/desks` | Desk keys + labels (no webhook URLs) |
| `GET /api/hits?date=YYYY-MM-DD&desk=finanswatch` | Matched messages for a day; `desk` optional |
| `GET /api/tickers?date=YYYY-MM-DD&onlyHits=1` | Per-ticker counts / overview |
| `GET /api/stats?date=YYYY-MM-DD` | Totals + notifications sent per desk |

The Vercel `index.html` calls these (e.g. `https://NEWSWEB_DOMAIN/api/hits`) — see
"Dashboard (Vercel)" below.

> **Issuer names — permanent limitation.** The upstream `/newsreader/issuers` endpoint
> returns HTTP 405 to *server-side* requests. This is NewsWeb blocking non-browser callers,
> not a transient/network issue — it will not work from the Ubuntu box either, and there is
> no "try again later". The browser-side dashboard could call it directly before; a 24/7
> server cannot. **The built-in `ISSUER_MAP` in `index.html` is the permanent source of
> company names for the dashboard** (the server's issuer cache will simply stay empty and
> `/api/tickers` will return blank `name` fields). This does not affect anything that
> matters operationally: message storage, matching, and Teams notifications all use the
> `issuerName` embedded in each message by the list endpoint, which works server-side.

## Deployment (Ubuntu/Debian + PM2 + Nginx)

```bash
# 1. Node 20 LTS (if not present)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3

# 2. App
cd /opt && sudo git clone <your-repo> newsweb && cd newsweb/newswebwatch-server
npm install --omit=dev
cp desks-config.example.json desks-config.json   # paste webhooks
# edit ecosystem.config.cjs → set ALLOWED_ORIGINS to your Vercel origin

# 3. PM2 + boot persistence
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd        # run the command it prints (sets up systemd unit)

# 4. Nginx reverse proxy (edit NEWSWEB_DOMAIN first)
sudo cp deploy/nginx-newsweb.conf /etc/nginx/sites-available/newsweb
sudo ln -s /etc/nginx/sites-available/newsweb /etc/nginx/sites-enabled/newsweb
sudo nginx -t && sudo systemctl reload nginx

# 5. HTTPS
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d NEWSWEB_DOMAIN
```

### Operations

```bash
pm2 logs newsweb-monitor        # live logs
pm2 status                      # process state / restarts / memory
pm2 restart newsweb-monitor     # after editing desks-config.json or env
```

The SQLite DB lives at `data/newsweb.db` (WAL mode). Back it up with a simple cron copy if
you want history retained across server rebuilds.

## Dashboard (Vercel)

`index.html` is now a **read-only dashboard**. It no longer matches, edits keywords, or
sends Teams notifications — it just shows the selected desk's hits from this server. All
keyword editing, ignore-word editing, and the Teams webhook input have been removed.

To point it at this server, set the API base (the placeholder is `https://NEWSWEB_DOMAIN`):

- Easiest: edit the `API_BASE` constant near the top of the `<script>` in `index.html`.
- Or inject `window.NWM_API_BASE = 'https://NEWSWEB_DOMAIN'` before the script loads.
- Or append `?api=https://NEWSWEB_DOMAIN` to the dashboard URL (handy for testing).

Make sure `ALLOWED_ORIGINS` on the server includes the dashboard's Vercel origin.

What the dashboard does now:
- **Desk picker** (sidebar + onboarding modal) chooses *which desk's feed to view* — it no
  longer loads/edits keywords. Choice persists in `localStorage` (`nwm_desk`).
- **Feed** polls `GET /api/hits?desk=…` on the interval slider's cadence and shows new hits.
- **Ticker overview** pulls `GET /api/tickers` (watchlists + names + today's activity),
  replacing the old static `ISSUER_MAP`-driven page.
- **Sound + tab-blink** are optional niceties when the tab is open; the UI states clearly
  that Teams notifications work without it.

The old `/api/notify`, `/api/config`, `/api/messages`, `/api/issuers` Vercel functions are
no longer used by the dashboard.

## Known limitations

- **Issuer names are server-blocked (permanent).** See the issuer-names note above —
  `/newsreader/issuers` returns 405 to server-side callers; the dashboard's `ISSUER_MAP` is
  the permanent name source. Does not affect matching or notifications.
- **Crash-recovery gap is bounded by the catch-up fetch.** The recoverable gap is limited to
  `CATCHUP_FETCH_LIMIT` messages (default 200) — that's how many the first poll after a
  restart pulls from NewsWeb. If an outage produced **more than that many** market messages
  before the process came back, the oldest ones beyond the limit fall outside the fetched
  window and are stored-but-not-notified. 200 comfortably covers minutes-to-hours of Oslo
  Børs traffic; for a planned long outage, raise `CATCHUP_FETCH_LIMIT` (and likely
  `CATCHUP_WINDOW_MS`) before restarting. It's a single request per start, so a higher limit
  doesn't affect steady-state polling or risk rate limits.
- **Catch-up is also time-bounded.** Even within the fetched batch, only messages published
  within `CATCHUP_WINDOW_MS` (default 6h) of the restart are re-notified; older un-notified
  matches are recorded silently to avoid a stale burst after a long outage.

## Remaining work

- **Webhooks for the other 6 desks:** paste into `desks-config.json` and `pm2 restart`.
