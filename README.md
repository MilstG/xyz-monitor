# Trade[XYZ] — Hyperliquid HIP-3 Markets Monitor

A monitor for the HIP-3 perp markets on the `xyz` dex on Hyperliquid.

The heavy work (fetching candles, computing momentum / volatility / reference prices,
sampling open interest) happens **once** on a small Node server, which caches the result
and serves it to browsers as a single pre-computed snapshot. Clients no longer hammer the
Hyperliquid API themselves, so cold-start goes from ~a minute of throttled loading to
instant, and the per-IP rate limit stops being a per-user problem.

## What it does

- **`/api/snapshot`** — the market table: price, funding, %-changes, reference prices,
  momentum/vol features, and open-interest deltas for every market. Rebuilt every ~15s.
- **`/api/daily`** — daily closes per market, used client-side for correlation, beta and
  trend sparklines. Rebuilt every ~60s.
- **`/api/health`** — liveness + basic stats (used as the Railway healthcheck).
- **`/api/series?coin=<coin>`** — per-market OI and funding history (powers the ticker drawer sparklines).
- **`/api/candles?coin=<coin>&days=N`** — per-market hourly OHLCV (1–60d, default 14; powers the drawer candle chart).
- **`/api/earnings`** — upcoming earnings (next 14 days, ET) for the xyz equity universe,
  Finnhub-fed, refreshed server-side every ~6h and warm-cached on the volume. Powers the
  Earnings tab and the E badge on the markets table (solid = reports today, hollow = tomorrow).
- **Sectors tab** — sector classification, a rotation flow map, a Relative Rotation Graph (RS-Ratio / RS-Momentum vs the S&P), per-sector detail, and a sector×sector correlation matrix.
- **Persistence** — OI *and* funding history are written to the `/data` volume and survive restarts; the computed feature cache is persisted too, so redeploys serve a warm table instantly.
- **Staleness** — the snapshot carries the last successful poll time; the status dot turns amber if the server's data goes stale (poller stalled).
- **Deep links** — the URL reflects the current tab and open ticker (`#sectors`, `#t=<coin>`), so links are shareable.
- **Saved layouts** — named views of the markets table (column order + visibility, sort,
  analysis window, vol/OI filters, ★-only), saved and switched from the Layouts menu. Stored
  per browser in localStorage; the active layout shows a • when the live view has unsaved changes.
- **Persistent OI** — open interest accrues over time and can't be re-fetched, so every
  sample is written to an append-only log on a mounted volume (`$DATA_DIR/oi.log`) and
  reloaded on boot. It survives restarts and redeploys. Pruned to 31 days daily.
- **WebSocket universe feed** — subscribes to `allDexsAssetCtxs` for real-time price /
  funding / OI pushes at zero rate-limit cost; REST drops to a slow reconciliation poll
  while the socket is healthy and instantly resumes 30s polling if it goes quiet.
- **Build stamp** — a version constant is shipped in `/api/health`, the snapshot payload and
  the UI status line, so a stale deploy is visible at a glance.
- **Auto-detect new HIP-3 listings** — the universe is re-polled every 30s. Any market that
  wasn't there before is logged (`NEW market detected: …`) and its candle history is
  backfilled immediately (new listings jump the queue). A daily audit line logs the active
  count and anything still awaiting backfill.

## Project layout

```
server.js            Fastify server: serves /public + the JSON API, owns the poller
src/hyperliquid.js   REST client + weight-based rate limiter
src/compute.js       stats + feature extraction (ported from the original client)
src/poller.js        universe poll, candle backfill, OI sampling, snapshot build
src/store.js         append-only persistent OI log (no native deps)
public/index.html    frontend shell
public/styles.css    styles
public/app.js         frontend logic (renders the cached snapshot)
railway.json         Railway build/deploy config
```

## Run locally

Requires Node 22+ (the WebSocket universe feed uses the built-in WebSocket client; on
older runtimes the app runs identically on pure REST).

```bash
npm install
DATA_DIR=./data npm start
# open http://localhost:3000
```

On first boot the server backfills candle history for every market (this is the slow part,
but it happens once, server-side). The table fills in progressively; the `syncing X/Y`
indicator shows progress.

## Deploy to Railway

You need a GitHub account and a Railway account.

1. **Push this folder to a GitHub repo.**
   ```bash
   git init
   git add .
   git commit -m "xyz monitor"
   git branch -M main
   git remote add origin https://github.com/<you>/xyz-monitor.git
   git push -u origin main
   ```
   (`node_modules/` and `data/` are gitignored — don't commit them.)

2. **Create the Railway project.** In the Railway dashboard: **New Project → Deploy from
   GitHub repo →** pick the repo. Railway auto-detects Node via Nixpacks, runs
   `npm install`, and starts it with `node server.js` (from `railway.json`). No Dockerfile
   needed.

3. **Add a persistent volume for the OI history.** Open the service → **Settings → Volumes
   (or the "+ Volume" button) → New Volume**, and set the **mount path to `/data`**.
   Without this, OI history would reset on every redeploy.

4. **Set the env var so the app writes to the volume.** Service → **Variables → New
   Variable**: `DATA_DIR = /data`. (You can also set `DEX` here if you ever monitor a
   different dex; it defaults to `xyz`. Don't set `PORT` — Railway injects it.)

5. **Generate a public URL.** Service → **Settings → Networking → Generate Domain.** That's
   the link you share with friends. First load after a fresh deploy may show a partly-empty
   table for a minute while the server backfills history; after that it's instant for
   everyone.

### Notes

- Keep the service **always-on** (Railway's default). The whole benefit is the warm cache —
  if it slept, a visitor would trigger a cold resync.
- Cost at this scale is typically just the Railway Hobby base (~\$5/mo).
- Redeploys keep OI history (it's on the volume) but re-backfill candle history (~1–2 min),
  which is cheap and expected.
- The refresh selector in the UI controls how often *your browser* re-fetches the cached
  snapshot (30s–15m). The server updates independently every ~30s regardless.

## Tests

```bash
npm test
```

Runs the classifier + compute regression tests (Node's built-in runner, no deps).

## Optional: earnings calendar (Finnhub)

The Earnings tab and the markets-table E badges need a free Finnhub API key: sign up at
finnhub.io and set `FINNHUB_TOKEN` as a Railway variable. Without it the app runs exactly as
before — the tab explains what's missing and no badges render. One HTTP GET per refresh
(~4/day) covers the whole window; the Hyperliquid rate budget is untouched. Session-spanning
signals (breakout, breakdown, gap, overnight drift) on names reporting ≤1 day out are flagged
and have their evidence contribution capped — a stated prior, labeled as such on the card.

## Optional: shared-password access

By default the site is public to anyone with the link. To require a shared password,
set `SITE_PASSWORD` (and optionally `SITE_USER`, default `friend`) as Railway variables —
the server then gates every request with HTTP Basic auth. Leave it unset to stay open.

## Tuning (optional)

In `src/poller.js`:
- `UNIVERSE_MS` — how often price/funding/OI + new-market detection runs (default 30s).
- `OI_MIN_GAP` — minimum spacing between stored OI samples (default ~5 min).
- `OI_RETENTION` — how much OI history to keep (default 31 days).
- `HOURLY_STALE` / `DAILY_STALE` — how often candle features / daily history refresh.

## Not investment advice.
