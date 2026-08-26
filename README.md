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
- **`/api/earnings`** — earnings for the xyz equity universe: upcoming (next 14 days, ET) plus a
  reported window (`recent`, the two prior ET days, derived from the persisted print history) so
  a print keeps its beat/miss and reaction move on the tab for 48h instead of vanishing at the
  ET midnight rollover. The schedule is Finnhub-fed in small chunked date windows (the free-tier calendar
  truncates long windows far-end-first), refreshed server-side every ~6h and warm-cached on the
  volume; stale placeholder-date prints are purged when the feed still schedules the same fiscal
  print ahead or retracts a print from the refetched back window, and the operator can void a
  feed-garbage print permanently from the tab (tombstoned via POST /api/earnings/void). Powers the
  Earnings tab and the E badge on the markets table (solid = reports today, hollow = tomorrow).
  Reported rows carry EPS actual vs estimate (beat/miss + surprise); past print dates persist
  to the volume (one-time ~1y backfill, then self-accruing) and feed a per-ticker earnings
  reaction study — avg |next-session move|, up/down split, gap behavior, expansion vs the
  name's usual range — shown on the tab and in the drawer. Session-spanning ledger claims in
  force within 1 day of a print are tagged (E in claim history) so the earnings-conditioned
  base-rate split accrues out of sample.
- **Housing tab** (`/api/housing`) — macro housing / MBS board: 30y mortgage rate, single-family vs
  multifamily starts, months' supply, new-home sales, median price and a BBB OAS proxy for non-QM
  spreads. Seven FRED series pulled in full history (needs `FRED_KEY`), refreshed every 6h,
  warm-cached on the volume (`housing.json`). Each card names its series; a *Proxy* chip says what
  differs from the paid original (jumbo rates, NAR existing-home data, DB non-QM spreads). A series
  whose newest print is older than its own cadence can explain is dropped with its reason rather
  than served — FRED retires series silently (SLOOS lending standards, `DRTSPM`, stopped at 2014Q4
  and was removed for that reason), and a retired panel is stale data wearing a live label. SIFMA
  issuance and FINRA TRACE volume are not on the board: both are form-gated or file-fed xlsx with no
  API, and a placeholder card showing nothing is a roadmap item, not a panel. Ships admin-only.
- **Liquidity tab** (`/api/liquidity`) — Fed net liquidity board: total assets − TGA − ON RRP on the
  weekly H.4.1 dates, as dollars and % of nominal GDP, year-to-date change by component (signed by
  liquidity effect), balance-sheet composition, the TGA/ON RRP drains, plus bank reserves and SOFR−IORB
  as plumbing-stress reads. Ten FRED series; everything normalised to billions before any arithmetic
  (H.4.1 lines publish in millions, ON RRP/GDP in billions). Refires after the Thursday ~4:30pm ET
  release and every 6h otherwise; warm-cached (`liquidity.json`). Ships admin-only.
- **Sessions tab** (`/api/analytics`) — the session/positioning studies. Among them the **funding
  heatmap**: a row per market, a column per time bucket, readable at **1h, 8h or 24h**. A cell is
  the funding a 1× long *paid* over that bucket (the hourly funding spine summed over the bucket
  and scaled to full width), so the timeframe buttons change the quantity rather than the zoom and
  each timeframe carries its own colour cap. Red = longs pay, green = longs receive; a bucket with
  under half its hours observed is hatched rather than drawn as zero. Ranked by open interest.
- **Sectors tab** — sector classification, a rotation flow map, a Relative Rotation Graph (RS-Ratio / RS-Momentum vs the S&P), per-sector detail, and a sector×sector correlation matrix.
- **Persistence** — OI *and* funding history are written to the `/data` volume and survive restarts; the computed feature cache is persisted too, so redeploys serve a warm table instantly.
- **Staleness** — the snapshot carries the last successful poll time; the status dot turns amber if the server's data goes stale (poller stalled).
- **Deep links** — the URL reflects the current tab and open ticker (`#sectors`, `#t=<coin>`), so links are shareable.
- **Notes tab** (`/api/notes`) — your own written notes, per ticker. Written in the ticker drawer, where
  the panel sits above the charts: everything else there is the server's read of the name, the note is
  yours. Each note is stamped with **the mark it was written at**, so every later read carries the move
  since ("wrote it at 113.90 · +4.0% since") instead of a bare date — that one field is what separates
  this from a text box, and it costs one number because the snapshot already holds the mark. `#tags` in
  the body are derived at read time (never stored alongside it) and filter the tab; search runs over
  bodies and tickers. A name rotated out of the universe **keeps** its note, greyed and labelled — notes
  are keyed by `coin` and displayed by ticker, so a rename moves the note with the market. Editing
  rewrites the body and nothing else: the original timestamp and price stamp stand, because the claim
  was made then, and the rewrite is disclosed. Stored server-side on the volume (`notes.json`, atomic
  tmp-then-rename, warm-loaded on boot) rather than in `localStorage` next to the watchlist: a layout is
  a *view* and losing it costs a re-click, but a note is prose somebody sat and typed. Ships admin-only,
  with the write verb behind its own key so opening the tab to the group never hands the group the pen.
- **Note markers on Markets** — a post-it in the ticker cell of any name you have written on. No new
  column (same reasoning as the E badge: that cell is the only one always on screen), and *absent*
  entirely when there is no note, so it never competes with the ☆ beside it. The glyph encodes three
  things at 11px: that a note exists, how many (a count past one), and **how fresh** — solid accent
  within 7 days, dimmed to 30, a hollow outline after. Age is **calendar time only**; a vol-scaled fade
  was considered and rejected because it would move the marker when the *market* changed rather than
  when the note did. Hovering gives the newest note's first line and the move since it was written;
  clicking opens the drawer. `◢ noted` in the filter menu narrows the table to noted names, the way
  ★-only already does. The markers cost the 15s poll nothing: every snapshot row carries a three-field
  digest (`nt:{n, ts, px}`) and the bodies load once with the drawer.
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

## Optional: macro calendar (FRED)

The Calendar tab interleaves universe-wide macro events with earnings: FOMC decisions come
from the Fed's published schedule (a static table in `src/compute.js` — no key needed, extend
it when the Fed publishes the next year), and CPI / nonfarm payrolls / PPI / retail sales /
GDP / PCE come from FRED's release schedule. For the FRED side, get a free API key at
fred.stlouisfed.org (API Keys) and set `FRED_KEY` as a Railway variable. Without it the FOMC
rows still serve and the tab explains what's missing. ~12 paced GETs per refresh (~4/day)
against FRED's 120/min budget; Hyperliquid untouched. Prior values are the previous print —
FRED carries no street consensus, so macro rows read prior → actual + the tape's reaction,
never beat/miss vs estimates. A macro event ≤1 ET day out flags session-spanning signals on
both universes with the same evidence cap as the earnings guard, shows a global banner on
every tab, and is flagged on the Actionable board and in AI reports.

## Optional: shared-password access

By default the site is public to anyone with the link. To require a shared password, set
`SITE_PASSWORD` (and optionally `SITE_USER`, default `friend`) as Railway variables. The
server then shows a dark-themed login page to anyone without a session; the correct
password sets a signed 30-day cookie (`SESSION_DAYS` to change), and a `⎋` button appears
in the nav to sign out (`/logout`). Changing `SITE_PASSWORD` invalidates every outstanding
session; plain redeploys don't. Eight wrong passwords from one IP lock that IP out for
15 minutes. Scripts and `curl` can skip the cookie and use HTTP Basic
(`curl -u friend:PASSWORD .../api/snapshot`), which is still accepted. `/api/health` stays
open for Railway's healthcheck. Leave `SITE_PASSWORD` unset to stay open.

## Tuning (optional)

In `src/poller.js`:
- `UNIVERSE_MS` — how often price/funding/OI + new-market detection runs (default 30s).
- `OI_MIN_GAP` — minimum spacing between stored OI samples (default ~5 min).
- `OI_RETENTION` — how much OI history to keep (default 31 days).
- `HOURLY_STALE` / `DAILY_STALE` — how often candle features / daily history refresh.

## Not investment advice.
