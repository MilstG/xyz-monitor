# Milst Screener — Hyperliquid HIP-3 Markets Monitor

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
  reaction study — avg / median |cash-close → cash-close move| (90% bootstrap CI from n ≥ 4), up/down
  split, cash-session gap behavior (intraday-only, coverage shown), expansion vs the
  name's usual range — shown on the tab and in the drawer. Session-spanning ledger claims in
  force within 1 day of a print are tagged (E in claim history) so the earnings-conditioned
  base-rate split accrues out of sample.
- **`/api/earnings/setups`** — pre-earnings setup cards for names reporting within 5 sessions:
  reaction study + positioning into the print + run-up + implied vs typical, with a rule-composed
  verdict line (build 2026.09.24-100; see the entry below).
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
- **Funding tab** (`/api/funding`) — the funding heatmap: a row per market, a column per time
  bucket, readable at **1h, 8h or 24h**, in one of two units. **Annualized** (the default): a cell
  is the bucket's mean hourly rate ×24×365 — the convention every other funding readout on the site
  uses — so the timeframe is a *resolution* (one market reads one number on every grid) and all
  three share one colour cap (the 8h grid's percentile, annualized) so a zoom never repaints a cell.
  **Per bucket**: a cell is the funding a 1× long *paid* over that bucket (the hourly funding spine
  summed across it and scaled to full width), so the timeframe buttons change the quantity rather
  than the zoom — the same market reads ~8× larger per 8h than per 1h — and each timeframe carries
  its own colour cap. The unit is a client-side multiplier over the same payload, remembered per
  browser; every tooltip carries both. Red = longs pay (crowded long, carry is a cost),
  green = longs receive; a bucket whose spine covers under half its hours is hatched rather than
  drawn as zero, and the newest column is always the last *complete* bucket. Beside each row's
  window mean sits its *current* funding (this hour's rate off the live snapshot, in the same
  unit), so carry building or fading reads as now vs mean. Rows rank by open interest; every
  market with a spine ships, and the client trims to top 25 / 50 / all. Built per universe, lazily, off the funding history already on the
  volume — no new fetch and no new persistence. Ships in the market-data menu (the `tape` group);
  an admin can rename that menu or move the tab out of it without a deploy.
- **Sectors tab** — sector classification, a rotation flow map, a Relative Rotation Graph (RS-Ratio / RS-Momentum vs the S&P), per-sector detail, and a sector×sector correlation matrix.
- **Drawdown tab** — return since an anchor date against the max drawdown taken in the same
  window, one dot per market, zero drawdown at the right edge so up-and-right is better (more
  return for less pain). The return axis reads *now* (the live mark over the prior close — the last close before
  the anchor, so the anchor day's own move counts) or *best* (the highest close since it);
  drawdown is by default *intraday* — the deepest fall from the running peak of daily highs to a
  later daily low (the daily feed carries the candle's low since build 2026.09.24-105) — with a
  *close-to-close* toggle. US names read US session bars (see Accuracy -105). The benchmarks are dashed horizontal lines at their own return — BTC and ETH in crypto
  scope, the S&P and the XYZ100 index in stocks scope. The chart draws the top 10/20/30/50 by the
  return axis or everyone (references always stay); the table underneath has the whole universe,
  25 rows a page. Presets or any date in the last year; a name listed after the anchor is drawn
  with a dashed ring and marked *late*. The same study as a sortable table with CSV. A client-side study over `/api/daily`, no route of its own. Ships
  admin-only. The design mock is `docs/xyz-monitor-return-drawdown-mock.html`.
- **Backtest target mode** (built 2026.08.22, completed in build 2026.09.24-97) — the Backtest tab
  tests a cross-sectional rule; the **target** box asks the smaller question, "does this signal
  work on NVDA?". A typeahead over the live scope (free text never resolves; a scope flip clears
  the picks) plus a **★ watchlist** pill that replaces the picks with your starred names in this
  scope that carry the 25d of daily history a test needs. **One** name collapses the cross-section
  into a timing rule: the score's own sign against an **entry** band (sign / ±0.5σ / ±1σ of that
  name's trailing score scale, RMS about zero, measured on past scores only) is the
  position; weighting re-reads as sizing (flat 1×, by |score|, 20% vol target, capped 0.25–2×); the
  book quantile, the rank gate and the universe select dim with the reason on hover. Buy & hold of
  the name is the dashed benchmark, a position ribbon runs under the curve, the book panel becomes
  the current position plus the trade log, and the trades box reads round trips, avg trade, win
  rate, funding and fees — under 10 round trips the count flags the Sharpe as an anecdote (shown,
  not hidden). **Several** names stay cross-sectional over exactly those, floor 4, with the
  thin-book arithmetic in the banner. Same cost, funding, hold-window and IS/OOS accounting as the
  universe path; client-side, no route. The design mock is `docs/xyz-monitor-backtest-target-mock.html`.
- **D1 retest study** (`/api/retest-study`, build 2026.09.24-96) — the Trend board's D1 **RETEST**
  replayed over every closed day the server holds, on the Backtest tab under the score duel: does
  the pullback into a stacked daily ribbon beat the trend it rides? An event is the ladder's own D1
  test on closed bars — EMA13/21 walked bar by bar with `emaLast`'s construction, the ribbon stacked
  (`trendState` up/down), a probe of the 13/21 zone while the close holds the EMA21 side; the short
  mirror for rallies. The design's two open decisions ship as controls rather than being settled by
  fiat: the **definition** (*board* = ladder-verbatim, the last 3 bars' extreme reached EMA13, which
  keeps the badge lit for up to three closes; *first touch* = this bar probed and the one before
  did not) and the **cooldown** (0 / 3 / 5 / 10 / 20 closed bars per name and side, default 5;
  suppressed events are counted). The **control** is every stacked bar of the same side whose probe
  did not hold, from the same names over the same days, so the excess column is the retest's edge
  over simply being in the trend, not over zero. Per horizon (+1/3/5/10/20d): n, hit, mean, median
  and σ-mean (the name's trailing 60-bar daily σ, walk-forward), the void rate (the event bar's own
  EMA21 — the tretest void — touched inside the horizon), the control's n/hit/mean and the excess;
  cells under 30 events publish n only. Bars are `mergedDailyBars` (370d both universes, forming
  day trimmed) in their **session view** since build -105 (a US name's weekends/holidays fold into
  the next session's bar, so EMA13/21 and the horizons count sessions; crypto calendar days) —
  true lows are the daily candle's own since -105, or the hourly spine's where it overlays
  (flagged `tl`); only a bar restored from an older warm file lacks one, a close stands in for the
  low there, which can only under-count probes and voids, and the panel prints the true-extreme share (*first touch* needs true lows to fire at
  all). D1 rung only — the board's other three rungs are not replayed. Walked once per name per
  (daily history, spine buckets, UTC day), pooled per (scope, definition, cooldown) and served
  through `sendCachedBody` under a walk-signature ETag; gated with the Backtest tab. The panel lists
  the most active names and the latest events (click for the drawer) and exports the newest 500
  events as CSV. Study tier: the live claim is still `tretest` / `tretestdn` in the ledger.
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
- **Positions overlay** (`/api/positions`) — one Hyperliquid wallet per account, linked under Filters ›
  Positions (public address only: the app reads the public clearinghouse state and can never sign).
  A poller lane reads the xyz book and, when the crypto lane runs, the main-dex book — weight 2
  each, every 30s, but **only for wallets somebody is looking at** (a read marks the account wanted
  for ten minutes). The server ships the *structure* of each position (side, size, entry, leverage,
  liquidation, margin, funding paid since open); notional, unrealized P&L, ROE and the move since
  entry are derived client-side off the live mark the row already shows, so they move with the tape
  and the lane only pokes the member's tabs (`{pos}` on the SSE stream) on a structural change. On
  the table: a ⬡ beside the ticker in the side's colour, a sortable **Position** column (hidden until
  a wallet is linked, migrated in next to OI in saved layouts), a ⬡ held filter; in the drawer, a
  panel with the trend board's read next to the side you are on.
- **Account-synced watchlist and layouts** (`/api/prefs`) — the ★ watchlist and the saved layouts
  list follow the account: a `user_pref` row per (member, key), last-writer-wins on the client's own
  stamp, and a `{prefs}` poke to the member's other tabs so a phone and a desktop converge on
  whichever change was made later. localStorage stays the working copy (signed out, nothing
  changes); the *active* layout is deliberately per browser — the phone runs its own.
- **Content-Security-Policy, report-only** — every HTML page carries a per-request nonce on its inline
  scripts and a `Content-Security-Policy-Report-Only` header naming it. Violations post to
  `/api/csp-report`, are counted and summarized on the signed-in `/api/health`, and logged at most
  once a minute. Report-only on purpose: the client renders through innerHTML in hundreds of places
  and members type prose into notes and messages; the operator flips to enforcing once the report
  stays quiet — `CSP_ENFORCE=1` sends the same policy as `Content-Security-Policy` (the health
  ledger then reads `mode: "enforce"`). The Playwright sweep passes under enforcement with zero
  violations, which is the necessary condition, not the sufficient one.
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
- **Accounts and invites** (`/join/<code>`, `/api/access`) — the terminal has per-person accounts
  instead of one shared password. An operator mints a **single-use invite link** from Admin ›
  Access; opening it validates the code, moves it into a 15-minute HttpOnly cookie and redirects to
  a bare `/join`, so the code leaves the address bar before anything renders and never reaches a
  `Referer` header or the browser history. The invite is burned inside one SQLite transaction
  (`BEGIN IMMEDIATE` + `WHERE usedBy IS NULL`), so two people opening the same link race safely: the
  loser sees "already used", not a second account. Sessions are still stateless HMAC tokens, now
  carrying `uid` and a per-user `epoch` — bumping that epoch is what makes "sign out everywhere",
  password reset and disabling an account work **without touching anybody else**. Under the shared
  password, removing one person meant rotating `SITE_PASSWORD`, which re-derived `OWNER_SECRET` and
  orphaned *every* member's Telegram links and alert rules; that is the failure this replaces.
  Migration is free by construction: an account reuses the browser's existing signed `xyzown`
  handle as its `uid`, so every recipient and rule already keyed to it belongs to the account with
  nothing rewritten. Existing shared-password sessions land on `/claim` to pick a handle; set
  `LEGACY_SHARED_PASSWORD=0` once everyone has, and the shared door is closed for good. Account #1
  is bootstrapped with `ADMIN_PASSWORD`, which stays as break-glass. **Password reset is self-serve** over the wire that already
  exists: `/reset` takes a handle and sends a six-digit code to that member's linked Telegram, with
  the hourly cap and the quiet window bypassed (a reset that waits until 8am is not a reset). The
  code is good for 10 minutes, works once, dies after five wrong guesses, and is capped at three
  sends an hour per account; requesting a new one kills the old one. The handle travels between the
  two steps in a short-lived HttpOnly cookie rather than a form field, so step two stays bound to
  step one. Every outcome — unknown handle, no Telegram linked, throttled — returns the same answer,
  so the endpoint is not a directory of who has an account. A member with no Telegram linked falls
  back to an operator-minted reset link, which is the same invite table with `kind='reset'`.
- **Messages tab** (`/api/dm`) — 1-to-1 direct messages between account holders. The reason it
  exists rather than a Telegram group: **a message carries the mark it was sent at**. Type
  `$TICKER` and the server stamps the price straight off the snapshot it already rebuilt seconds
  ago (no fetch, no new polling), so a call made at 113.90 and read at 118.50 says `sent at 113.90
  · +4.0%` on its face — the same discipline Notes applies, for the same reason. The stamp is
  written once and an edit never relocates it; the move since is derived at read and never stored.
  Delivery rides the **existing SSE stream** on its existing contract — versions, never payloads: a
  send pushes `{dm:{seq}}` to the two participants' connections only, and they answer with an
  ordinary `/api/dm/sync` pull keyed by their own cursor, so a dropped frame costs nothing and no
  WebSocket is needed. Storage is SQLite (`accounts.db`), because the whole-file tmp+rename
  discipline the JSON caches use is O(history) per message on an append-only log. Threads are
  canonical pairs, message ids are the global sync cursor, deletes are tombstones (the id is the
  other side's cursor position), and every route resolves the uid from the session and filters by
  participation. Unread messages escalate to a member's linked Telegram after 5 minutes as one
  digest per sender, reusing the outbox's quiet hours and caps — muted threads never do, and being
  online cancels it. Deliberately out of scope for v1: group threads, attachments, reactions,
  typing indicators, search, and replying from Telegram.
- **Group threads, attachments, reactions and search** (messages v2) — a 1-to-1 is not a special
  case here: both shapes are one `dm_thread` row, and what makes a DM a DM is `pairKey` (the two
  uids sorted, UNIQUE), so "open a DM with X" stays one index hit and stays idempotent while a
  group carries NULL there. Membership is its own table with `leftAt` rather than a delete, so a
  departed member's messages stay attributed and their name still resolves in the backscroll.
  Adding, removing, renaming and leaving are recorded as ordinary message rows with `sys` set —
  they ride the same cursor a message does, so the membership story can never drift from the
  history. Joining marks what was already said as read: the backscroll is fully readable, but being
  added to a busy group should not open on "500 unread". Only the creator manages a group, and the
  last owner leaving hands ownership to the longest-standing member so a group is never
  unmanageable. **Attachments** are typed by the server's own magic-byte sniff, never the
  uploader's claim: only png/jpeg/gif/webp render inline, and everything else — SVG above all,
  which is a document that can carry script — is served `Content-Disposition: attachment` with
  `nosniff` and a sandboxed CSP. Reading a file is a membership check, not a knows-the-id check, so
  a forwarded link is not an access grant. **Reactions** are a fixed vocabulary of eight and name
  who reacted, because a bare count is a vote rather than a conversation. **Search** is scoped by a
  JOIN on membership — the scope IS the authorization, so there is no thread id to tamper with —
  and uses LIKE with escaped wildcards rather than FTS5, which costs nothing at a desk's volume and
  avoids an extension dependency. **Typing indicators** live in memory only and expire on their
  own; they ride the same targeted SSE fan-out a send does. **Replying from Telegram** is
  command-only on purpose (`/r your message`, or `/r @handle your message`): people already send
  stray text to that chat, and turning any of it into a message posted under their name is a
  surprise you cannot take back.
- **Chat terminal** (build 2026.09.11-69) — the ask terminal's verbs run from any conversation's
  composer: `/top funding 5`, `/nvda`, `/screen rvol>2`, `/earnings today`, and the result posts
  into the thread under your name as a monospace block badged **computed**, so a group reads one
  table instead of six people opening the panel. One code path: the same handlers the `~` panel
  runs, against the same rows, with the panel's output redirected into the message. `/help` is a
  private card (only you see it) listing what runs here; `//text` sends a message that really
  starts with a slash. Two operator switches in Admin › Features: `dm.terminal` (the local grammar,
  **public** by default — it costs nothing) and `dm.ask` (the AI fallback, **admin-only** by
  default — it spends the shared budget and the answer lands where everyone reads it). The server
  enforces both on the post and on the ask, and `dm.ask` only ever narrows `ai.ask`. Verbs that open
  a view or change state (`comp`, `report`, `basket`, `whale add`, `admin …`) are refused with a
  pointer to the panel; a command result carries no price stamp (a screen dump that spells `$NVDA`
  is nobody's call) and can't be edited — delete it and run it again. **BTC is the one name allowed
  across the stocks/crypto wall** for `comp` and `ratio` (`ratio NVDA/BTC`, `comp NVDA AMD BTC`):
  the ratio aligns on the hours both legs traded, so a stock leg keeps it to session hours; baskets
  still never mix and no other coin crosses. `/ratio A/B [tf]` is the one
  verb that posts a **picture**: the same SVG the Correlation tab draws is rasterised offscreen and
  rides the ordinary attachment path as a PNG. **Tab** completes verbs, fields and tickers in the
  composer, and the `?` beside it opens the full guide.
- **Telegram sync** (build 2026.09.21-83) — a `⇄ telegram` box in any conversation's header
  mirrors THAT conversation to your linked Telegram, both ways: every message posts to your chat
  as it happens (no five-minute wait, no unread test, being at the terminal changes nothing), and
  plain text you type at the bot posts into the conversation under your name, marked `tg`. One
  conversation per member, by construction — a bot chat is a single stream with no way to say
  which of several threads a bare line was meant for, so ticking the box here unticks it anywhere
  else, and the bot tells you what it is now syncing. Sync starts from **now**: the backscroll is
  never replayed into the chat. Your own phone lines are not echoed back; the offline digest
  stands down for a synced conversation while a phone is reachable (unlinked or blocked, it is the
  fallback again); while any of your chats is inside its quiet hours the mirror holds, then catches up with the last ten lines
  and a count of the rest. The mirror rides the alert outbox (`force`: a conversation you asked
  for live is not an alert, and the hourly alert cap must not park it), and the cursor is the
  same `notifiedMsgId` the digest uses, so the two can never deliver a line twice. Bare text is
  only accepted from a **private** chat with the bot — a group chat linked with `/start` would
  post everyone's lines under the one account that linked it. `/r` and `/r @handle` keep working
  as before.
- **Telegram sync: edits, deletions, reactions and attachments** (build 2026.09.24-99) — the
  sync now carries more than new lines. A map (`dm_tg`: chat, Telegram `message_id`, row, and
  which way it went) is written from Telegram's own answer to each send, so either side can find
  the other. **Edits**: an edit here (the author's, or an operator's moderation edit, which reads
  "edited by …") repaints every mirrored copy with `editMessageText` (`editMessageCaption` for a
  file); editing a line you typed at the bot, in Telegram, rewrites the row through the same edit
  rules as the composer (not a command result, not a card) and repaints the other members' chats.
  **Deletions**: a delete here removes the bot's copy with `deleteMessage`, and your own typed
  line from your private chat too; a delete inside a packed catch-up message shrinks it with an
  edit instead. **Reactions**: a reaction here sets the bot's reaction on the mirrored message
  with `setMessageReaction`; a reaction in Telegram becomes yours here. The vocabularies differ,
  so each site reaction has one Telegram stand-in (👍 👎 👀 🔥 🤔 as themselves, ✅ → 👌, 📈 → 🏆,
  📉 → 💔) and a few near-synonyms map back (💯/🤝 → ✅, 🤨 → 🤔, ⚡ → 🔥, ❤/👏 → 👍); anything else
  is ignored. **Attachments**: a file here goes to the chat as a photo (png/jpeg/webp) or a
  document (gif, .txt, voice notes) with its line as the caption, falling back to the line and
  the file's name if Telegram refuses the upload; a photo, document, voice note or audio file sent
  at the bot is fetched with `getFile` and stored through the composer's own upload door — the
  same magic-byte sniff, type allowlist and 8 MB / 3 MB caps, with the size checked from
  Telegram's metadata before anything is downloaded. Every call rides the alert outbox (its 3 s
  pacing and 429 backoff), and a refusal (`message is not modified`, too old to delete) is logged
  and skipped without touching the chat's delivery status. What Telegram does not allow, stays
  out: the **Bot API sends no update when a message is deleted in Telegram**, so a delete made
  there is never mirrored here; a bot cannot edit a line *you* typed, so an edit here to a
  phone-typed line reaches the other members' chats but not your own; deleting a message older
  than 48 hours is refused; a bot holds **one** reaction per message, so the chat shows the
  conversation's most-used reaction (latest on a tie), and none at all on a packed catch-up
  message, which would claim every line in it; reaction updates need `message_reaction` in
  `allowed_updates` (the poll asks for it) and are read from private chats only — in a group
  Telegram would also require the bot to be an admin, and the reacting person could not be
  attributed; files over the Bot API's 20 MB download limit cannot be fetched at all.
- **Pre-earnings setup card** (build 2026.09.24-100) — `/api/earnings/setups`: one card per
  name reporting within the next **5 US sessions** (weekends and US exchange holidays skipped —
  the same calendar the gap engine uses). Each card combines (1) the reaction study
  — typical (median) |move|, avg, up/down split, gap-and-hold vs gap-and-fade, sample size, the
  +24h anchor median; (2) positioning into the print — live funding (APR) and its percentile vs
  the name's own 31d hourly history, OI change over the run-up (the last 7 calendar days ≈ 5
  sessions, off the sampled OI history), mark-vs-oracle premium with its robust z vs the 7d baseline for the current session state;
  (3) the run-up — the live mark vs the close 7 days back, against this name's median drift over
  the same window before its past prints (≥ 3 prints with a hole-free 7-day spine); (4) implied
  vs typical — the typical print move over the CURRENT usual daily move (mean |close-to-close|,
  last 20 completed SESSION bars since build -105 — the same baseline the study's expansion ratio uses), beside that ratio
  at past prints: ≥ 1.3× the historical ratio reads "vol compressed", ≤ 1/1.3 "vol already
  elevated". A verdict line is composed from fixed rules, no AI: *crowded long* = funding ≥ p90
  with OI up ≥ 5% over the run-up (*crowded short* = ≤ p10 with the same build), the funding
  extreme alone reads *longs paying up* / *shorts paying*, |OI| ≥ 10% with funding in between
  reads *OI building* / *positions coming off*; a direction skew is named at ≥ 70% of prints one
  way, a gap read at ≥ 3 gaps with ≥ 60% held or faded, a run-up at ≥ 3%; n < 4 is flagged thin.
  e.g. *crowded long into print (funding p92, OI +18% in 5 sessions); typical move ±6.1%, gaps
  and fades 7/10; …*. Every block the server cannot fill ships its reason and renders as
  "n/a — why" (no study yet, < 4 days of funding for a percentile, OI history short of 7 days,
  < ~17h of premium samples for a z, a calendar name with no live market). Its own route, not
  more fields on `/api/earnings`: positioning moves every poll and would bust the calendar's 304;
  the poller rebuilds at most once a minute (at once when the calendar is replaced) and keeps the
  payload object — and so the ETag — while the content signature holds. Shown as a collapsible
  **Setups** strip at the top of the Earnings tab (expanded cards survive re-renders) and as a
  **Pre-earnings setup** section in the ticker drawer for a carded name (filled in place if the
  pull lands after the drawer opened). Gated with the Earnings tab. A read of the setup, never a
  call: the study is a base rate, and funding/OI describe who is positioned, not who is right.
- **Chat alerts: `/alert`** (build 2026.09.21-83) — a threshold rule written where it will fire.
  `/alert NVDA > 200`, `/alert NVDA crosses down 180`, `/alert NVDA above 200ma`, `/alert HOOD d1
  > 5 big day`, `/alert any rvol > 3`; `/alert list` and `/alert off <id>` manage them; `/alert
  help` prints the grammar. The rule is the existing owner-scoped engine (same hysteresis,
  cooldown, per-person cap and persistence as one written in the alerts panel) with one new field:
  the **conversation it was typed in**. When it fires, the fire posts **there**, under the author's
  name as a command result — so the whole room sees it, a synced phone mirrors it, and the offline
  digest nudges the rest — and the event is marked quiet on the alert wire so nobody is told twice.
  A scan that trips a roster-wide rule on twenty names posts one list, not twenty lines. The
  same line works at the Telegram bot: bound to the conversation the chat syncs, or a plain
  personal rule when none is. New metric for the question people actually ask: `vsma200`, the
  mark's distance to the **200-day SMA** (the snapshot row now carries `ma200`, the same
  arithmetic as the markets column — 200 US sessions on an equity since build -105), so "above the 200-day" and "crosses the 200-day" are rules,
  with half a percent of hysteresis so a mark sitting on the line does not fire on every wobble.
  Also fixed here: a persisted rule stored its universe as `""`, and the validator rejected that on
  the way back in — every coin-scoped and roster-wide rule was silently dropped on every restart.
- **Chat paints incrementally** (build 2026.09.21-87) — the panel used to be rebuilt wholesale for
  every arriving message, every send (after three round trips: the post, a reload of the thread
  list, a refetch of the history the client already held) and every 45-second tick, whether or
  not anything had changed: a full DOM teardown, relayout and image re-decode per line of chat.
  Now an arrival on the open conversation is appended before the receipt (ids only grow, so the
  common case is an append by construction), a message in another conversation redraws the rail
  only, a send merges the server's reply and moves the thread row locally, and the tick runs the
  incremental sync and redraws only when presence or the rail actually moved. Anything that is not
  a plain append — an out-of-order id, a pinned arrival, search results showing — takes the full
  render it always did.
- **Share to chat** (build 2026.09.21-84) — any cell, any row, any screen of the markets table into
  a conversation as a **data card**. Nothing is drawn at rest: hover a data cell and a `⤴` floats
  at its corner (that field), hover the ticker cell and it means the row, right-click for a menu
  naming all three grains with the exact thing under the cursor (cell · row · this screen), or
  press `s` on a focused row. The sheet opens at the side like the drawer: the preview IS the card
  the room will see, a picker of your conversations (or a person, which opens the pair thread),
  an optional line of text, and one switch — *quote as a call*, which stamps the card's own ticker
  into the calls record. `/share HOOD funding`, `/share NVDA`, `/share screen` do the same from the
  composer. **The serializer is the column table**: a capture runs each column's own renderer
  over the row and keeps the text it drew and the class it drew it in, so every column is
  shareable the day it lands with no second list of getters; "now" in the card's footer is the
  same renderer over the live row, beside the mark's drift since capture. The server validates
  the card's shape (≤ 25 rows × 12 columns, strings clipped, ≤ 12 KB) and renders the monospace
  body that search, export, the digest and the Telegram mirror all read — the client never
  supplies the text. A card is immutable like a command result (re-capture posts a fresh one of
  the same address), never a reply, and its note travels as an ordinary message right behind it.
  Charts, drawer sections, the other boards and live screens followed in 2026.09.24-98 (next entry).
- **Share to chat everywhere** (build 2026.09.24-98) — the mock's "everywhere else", on the same
  glyph, sheet and card format. Two new card kinds: a **panel** is any other surface captured from
  what it *drew* (the column-table rule again: each cell's text and the colour class it wore, no
  second list of getters), as label/value lines (one row, one section) or a table (a whole board,
  first 25 rows); a sparkline travels as its **numbers** (≤ 120, gaps kept as gaps) and the card
  redraws it, and the text body renders it as block heights for the phone. A **chart** takes the
  `/ratio` road: rasterised offscreen to a PNG, uploaded into the thread, and posted with the card
  as its caption (the route refuses a chart card without its own upload, and `send()` holds the
  file to the same thread-and-owner rule as any attachment), so a picture goes to an existing
  conversation. Where the glyph sits: **Trend, Actionable, Sectors, Drawdown** rows float it at the
  row's end, with *the row* / *this board* on right-click; the **Funding heatmap** is an SVG, so
  its row label carries the market and the card is built from the payload that drew it (mean,
  now, window, the row's cells as a zero-lined spark, in the unit on screen); every **drawer**
  section header floats it (metrics, the earnings reaction — now its own fields: next print,
  session, EPS est, prints, avg/median |move|, up/down, ×usual day, gaps, +24h — notes, OI and
  funding sparklines, the 30d split, co-movers); each **Charts** pane header has one, and the
  drawer's hourly candles share as a raster of the same drawing (`candleGeom`, theme variables
  resolved, since an `<img>` reads no CSS). `/ratio` now uses the same rasteriser (`shSvgPng`).
  A **screen** carries its filters as data (`q`: text filter, vol/OI bounds, drill set ≤ 150,
  sort, scope — validated field by field) and can be shared **live**: every viewer's copy re-runs
  the screener's own rules over the snapshot they hold, drawn by the columns' own renderers,
  with newcomers marked, and the capture stays underneath *as shared* with the names that no
  longer pass struck through; a frozen screen that carried `q` still says "k of N still pass". A
  screen leaning on ★ only / noted / held cannot go live (those lists are the sharer's), and the
  sheet says why. Panels and charts are shared again from where they live — *re-capture* stays a
  screener verb, and the button only shows where it works. Not here: `/share` in the composer
  still speaks only for the screener, and a live screen re-runs on the viewer's snapshot (no ★
  pinning), not the sharer's.
- **Reading a call** (build 2026.09.22-89) — the words around a `$TICKER` decide the direction and
  the horizon, from a fixed vocabulary on purpose: a call posts under your name and enters your
  record, so a wrong guess costs more than no guess. Short words before the ticker: `short`,
  `shorting`, `sell`, `selling`, `fade`, `fading`, `bearish`, `bear`, `dump`, `dumping`, `puts`,
  `lower`, `downside`; after it: `short`, `puts`, `lower`, `down`, `bearish`, `dump`. Options
  read as a trader would: `buy $X puts` is a short, `sell $X puts` is a long, `$X calls` is a long
  unless sold. Horizons after the ticker: `30d`, `3 days`, `2w`, `2 weeks`, `1mo`, `2 months`,
  `next week`, `a month`, `eow` / `by friday`, `eom`, `eoy` / `year end`, `by Oct 15`, `by 10/15`
  (default 7d, cap 365d). The composer's preview names the word it read ("short because of
  “fade” · horizon from “by Oct 15”"), and the server and the client run a byte-identical reader
  (a test keeps them in step). **The backup is a proposal, never a post**: when the words decide
  nothing and the message is more than a few words, the preview offers *ask AI what I mean*
  (gated by `dm.ask`, admin-only by default; spends one ask, cached per text). The model returns
  `{side, days, why}` in a strict shape, the chip shows it, and only the sender tapping *apply*
  makes it ride the send as an explicit override — dropped the moment the text changes.
- **The call lifecycle** (build 2026.09.22-88) — a call is **open** from the moment it is stamped
  until its **horizon**: seven days by default, or the days written after the ticker (`$HOOD 30d`
  — right after the ticker only, so "$HOOD ran 3d in a row" stays prose; 1 to 365). At the
  horizon, the first daily close at or past it becomes the call's **final** result and the call
  stops moving with the mark. The author can **close early** at the live mark (the hover bar on
  their own stamp, or the calls board) and **extend** an open call by a week at a time, never to a
  horizon whose close has already printed (never shorter: shortening is what close-early is for).
  The horizon is part of the stamp: editing the words later does not move it. Before this, a call
  was scored live forever and the
  record read as a lifetime of moving numbers. **The record is the closed calls**: a call counts
  once, at its final; open calls are counted, not scored ("running" is the honest word for a number
  still moving); the fixed 1d/7d yardsticks stay beside it. The stamp says "closes Sep 24 (7d)" or
  "closed Sep 24 at 118.50 · +4.1%"; the board gained a status column and reads the close price in
  place of the live mark once closed; the wire carries `call: {h, closed, early, closeTs, closePx,
  final}` on every stamped message, delete-proof like the stamp. **The desk digest** was rewritten
  around it: open calls with age, levels and close date; the calls closed in the last week with
  their final (⊘ marks an early close); the record over the last 30 days of closed calls per
  person with their best; the newest signals with side; earnings today; the day's movers split
  stocks / crypto. A section with nothing to say is absent.
- **Call targets** (build 2026.09.24-95) — "$INTC to 32 by Oct 15": a call with more said, built
  from the `xyz-monitor-call-targets-mock.html` proposal on the call machinery rather than beside
  it. Same row, same stamp, same record: the target level and an optional stop are two more columns
  on the stamped `dm_msg` row, and the **deadline is the lifecycle's horizon** (no second clock —
  `+7d` moves it, *close call* resolves it `early`, which is neither a hit nor a miss). The grammar
  is fixed and reads only what follows the ticker: a price (`32`, `$32.50`, `120k`, behind `to` /
  `→` / `target` / `goes to`), then a deadline — `by Oct 15`, `by 10/15`, `by 2026-10-15`, `by
  friday`, `eom`, `year end` (callRead's own date words) or `in 3w` / `in 10d` / `in 2 months` —
  and an optional `unless 27` / `wrong under 27` / `stop 27`. `at` names an entry, a number with a
  unit is a horizon and a number before `puts`/`calls` is a strike, so none of them is a target.
  The side follows the target's side of the mark unless a short word (or an applied AI reading)
  already decided it, and then the target must agree. Anything refused (no deadline, behind the
  mark, a stop on the wrong side) sends as a **plain call** and the composer's preview says why —
  never a wrong target. Server and client run a byte-identical reader (`compute.callTarget` /
  `dmCallTarget`, held in step by a test). **Resolution** runs once a minute (`targetSweep`):
  hits are intraday and misses are at the close — a hit or a stop is the first 5-minute bar
  (from the archive the level scanner reads) that opened after the send and reached the level,
  then the live mark for the bar still forming; a bar that reaches both is `wrong`, the reading
  that does not flatter the author. For **US session names** (the ET-anchored xyz roster —
  equities, indices; not crypto, not a foreign-home listing) a bar reaches a level by a touch
  during the 09:30–16:00 ET cash session, and off-hours only by a 5-minute **close through** it
  (a thin overnight/weekend wick is neither a hit nor a stop; the live mark counts in session
  only), and a date deadline ("by Oct 15", friday, eom) ends at that date's **16:00 ET cash
  close** (13:00 on an early-close day; a weekend or holiday date ends at the last close before
  it), with the miss priced at the last 5-minute close at the bell. Crypto keeps any touch,
  around the clock, and a date ends 24:00 UTC; a relative horizon ("in 3w") runs from the send.
  Otherwise a miss is the first daily close at or past the deadline, exactly the close a plain
  call's horizon reads. The composer preview and the open pill state the rule for the name. The result is written once (`tgRes`, `tgAt`,
  `closePx` = the target, the stop or that close) and posts into the conversation the call was
  made in, under its author's name, as a command result — the road a bound `/alert` fire takes, so
  a synced phone mirrors it and nothing new rides the wire. A bar cursor makes a sweep O(new bars)
  and a restart loses nothing. The stamp grows a **progress row** (price progress from the sent
  mark to the target, a triangle for time used, a red tick at the stop, a status pill); the calls
  board gains a target column and a **second, binary record** — hit / missed / wrong per person
  and the median days to a hit — beside the % record, never instead of it; the desk digest names
  each open target's level and progress and the binary record. `GET /api/dm/targets` reads the
  record narrowed to targets; `POST /api/dm/targets` is the operator's resolve-now. Not in this
  cut: per-member time zones.
- **The calls record** (`/api/dm/calls`) — every price-stamped message in one place, with the move
  since it was sent and a per-person summary. This is what the stamp was FOR: without somewhere to
  read them together, each call died in the conversation it was made in. Calls carry a
  **direction** (write `short $HOOD` — or `$HOOD puts` — and it scores as a short; everything else
  is a long), the board and summary score the **direction-adjusted** move (positive = the call is
  right), and each call is also scored at **fixed 1d/7d horizons** (the first daily close past the
  mark) so the record isn't a function of when you look. Click a person in the summary to filter
  to their record. The record is **delete-proof** against its author: deleting a call removes its
  body, never its stamp or score. A stamp card also carries a one-tap **⚑ alert** that arms a price alert at the
  called level (retest from above, reclaim from below). An operator can promote any stamped
  message into the Notes book, and the note keeps the message's own timestamp and price —
  re-stamping it at "now" would turn last Tuesday's call at 113.90 into a different, false claim
  about today.
- **Browser push + PWA** — the offline escalation's second leg: enable browser notifications in
  the Messages rail and unread messages reach the device as system notifications (same 5-minute
  grace, mute and mention-piercing rules as Telegram), tab closed included. VAPID keys are minted
  once and persist on the volume. The app installs as a PWA; the service worker deliberately
  caches nothing.
- **Desk digest** — a third scheduled Telegram send next to the brief and the Landscape:
  deterministic (no model call) and per member — your own calls and their scores, today's
  earnings, live signals and the tape's 24h extremes. Opt-in by construction: it has no default
  hour, so nothing sends until a member picks one in the alerts panel.
- **Watched tickers in messages** — a per-person list, separate from the markets watchlist (which
  lives in localStorage and the server has never seen). A message whose `$TICKER` is on your list
  escalates to Telegram **immediately** and **pierces a muted conversation**: muting a busy group
  should not be the same as asking not to be told when somebody mentions the name you are watching.
- **Read receipts, pins, drafts, export, keyboard** — "seen by" under the last message you sent
  (the read cursor was already stored for unread counts); pinned messages in a strip at the top of
  a conversation; drafts that survive a reload, not just a re-render; a JSON export per conversation
  (a record you cannot get out of the system is one you do not really have); and `/` to focus the
  conversation search, `j`/`k` to walk the rail, Escape to back out — folded into the app's own
  global key handler rather than competing with it, so Ctrl+K still belongs to the command palette.
- **Moderation** (build 2026.09.23-94) — the operator can **edit or delete anybody's message**,
  and **strike a call from the record altogether**. Same verbs, same `/api/dm` route as the author's
  own edit and delete; the authorization is the admin flag decided at the route and passed down, so
  the store never reads a cookie and a member's own path is untouched. A moderated row is honest
  about it: the bubble reads "edited by gus", "message removed by gus" or "call removed by gus" —
  the operator's name, never a bare "the operator" — and every act lands in the same audit log the
  read-through writes to, with the words that were changed or removed. The strike is the one door
  the record's delete-proofing does not close, because it is not the author's: the words stay
  (deleted or not), the stamp, its side, its horizon and any early close go, so the row leaves the
  board, the summary and the digest at once, and retention then ages it like any other prose. The
  controls sit in the hover bar over any bubble (in the down color, so "delete" on your own message
  and "delete" on theirs never read as the same button), on each row of the calls board, and in the
  Admin panel's read-through — where the operator can act on a conversation they are not in.
- **Operator read-through** (`/api/access/dm`) — on this deployment the operator can read every
  message, including conversations they are not in. It is a **separate, admin-gated surface** from
  `/api/dm` on purpose: folding a bypass into the membership filter would mean one bug in that
  filter hands an ordinary member the same reach, so the read-through code never consults membership
  at all. Every read and every search is written to an audit log shown in the Admin panel, and the
  Messages tab tells members plainly that the operator can read what they write — people write
  differently when they believe a message is private, and on this deployment it is not.
- **Admin panel folds** — the panel had grown to eight full-height boxes, so reaching the one you
  wanted meant scrolling past the seven you did not. Every segment is now a collapsed row naming
  what is inside it, with an expand-all/collapse-all control. Each fold wraps its box from
  *outside*: every renderer replaces its own box's `innerHTML` and never touches the wrapper, so
  open/closed state survives a re-render without a single renderer knowing the folds exist. Open
  folds are remembered per browser — collapsed is the state a fresh browser gets, not one to
  re-clear every visit. A test fails if a future box is added to the panel without a fold.
- **Messages v4** (builds 2026.09.10-51…-57) — the tab became a chat app. Chat-style grouping (one
  name/time header per run, day dividers, hover action bar, bottom-anchored log), per-member
  colors in groups, live read receipts (arrivals mark read while the conversation is open and
  visible — before this, "sent · not read yet" stuck forever and read as failed delivery), and a
  bottom-left **chat dock** with a red unread count on every tab. **Replies** quote one line and
  click back to the original; a cross-thread `replyTo` never binds. **@mentions** behave like
  watched tickers: immediate Telegram escalation, through a mute. **Topic boards** are groups
  whose door is open — anyone may join themselves, so reads and writes still ride the membership
  check — with the first pin rendered in full as the topic's standing post. **Tweet cards**: an
  x.com status link unfurls via X's public oEmbed (no key, cached per id, fetched in the
  background with an SSE refresh poke); only parsed fields are stored — X's embed HTML can carry
  script and never reaches a client. **Close / clear / delete** are three different verbs: close
  is per-viewer and reversible from a folded "Closed" rail section; clear forgets the backscroll
  for you alone (history, sync, search and export all honor it); delete — owner or operator, on
  groups only — shreds the thread for everyone and lands in the audit log. **Attachments** are an
  allowlist now: the four sniffed raster formats plus `.txt` that validates as text, everything
  else refused at upload. **Retention**: 30d in a 1-to-1, 7d in groups/topics, pinned messages
  exempt, rows and bytes actually deleted. Members with no Telegram can adopt a chat the bot
  already serves — a 6-digit code sent to that chat is the proof — and signed-out visitors get a
  rate-limited "request an invite" that pings the operator's ops channel.
- **Saved layouts** — named views of the markets table (column order + visibility, sort,
  analysis window, vol/OI filters, ★-only), saved and switched from the Layouts menu. Stored
  per browser in localStorage; the active layout shows a • when the live view has unsaved changes.
- **Persistent OI** — open interest accrues over time and can't be re-fetched, so every
  sample is written to an append-only log on a mounted volume (`$DATA_DIR/oi.log`) and
  reloaded on boot. It survives restarts and redeploys. Retained 365 days: full resolution for 31, thinned to hourly beyond (the main-dex roster keeps a flat 31); pruned daily.
- **WebSocket universe feed** — subscribes to `allDexsAssetCtxs` for real-time price /
  funding / OI pushes at zero rate-limit cost; REST drops to a slow reconciliation poll
  while the socket is healthy and instantly resumes 30s polling if it goes quiet.
- **Build stamp** — a version constant is shipped in `/api/health`, the snapshot payload and
  the UI status line, so a stale deploy is visible at a glance.
- **Auto-detect new HIP-3 listings** — the universe is re-polled every 30s. Any market that
  wasn't there before is logged (`NEW market detected: …`) and its candle history is
  backfilled immediately (new listings jump the queue). A daily audit line logs the active
  count and anything still awaiting backfill.

## Documentation

Three pages, two audiences. For the people using the terminal: the **explainer** at
`/docs/ref/explainer` (the ideas behind the screens) and **how to use this site** at
`/docs/ref/howto` (every feature: what it is worth, how to use it properly, a daily routine). For the
people running it: the **manual** at `/docs`, the exact reference. The manual's opening points
newcomers at the two member pages; they point back for definitions.

The complete manual ships with the app at **`/docs`** (`public/docs.html`): every tab, every
column, the drawer, the terminal and chat grammars, alerts and Telegram, the signal engine, data
sources and retention, the HTTP API, every environment variable, deployment, the security model, a
glossary and troubleshooting. The `?` help on every tab links to its section. The page is served
the way the shell is: the caller's resolved feature set is injected so a section about a tab that
member cannot see is not in the markup they receive, every inline script carries the CSP nonce, and
the build stamp is at the top. Signed-out visitors get the login page, like everything else.

The **explainer** (`docs/xyz-monitor-explainer.html`, served at **`/docs/ref/explainer`**) is the
same app told to the people who use it rather than to the people who run it: what the terminal is,
a first-ten-minutes walkthrough, the six ideas that explain every screen, one card per tab saying
*when you would open it*, the plain-English reading of the columns you meet most (funding, ΔOI,
RVOL, squeeze, carry, OI/Vol…), what is yours and whether it syncs, the ask/chat grammars by
example, alerts, the keyboard card, an honest **what it will not do** (no orders, no predictions,
31-day crypto retention, 45-day 13F and PTR lag, OI attribution as inference, operator read-through
on messages) and a short *when it looks wrong*. It carries no operator content — no environment
variables, no API, no deployment — so it can be handed to a new member whole. Linked from the
manual's opening, the app footer and every tab's `?` card.

**How to use this site** (`docs/xyz-monitor-how-to-use.html`, served at **`/docs/ref/howto`**) is the
companion how-to: one block per feature — Markets, the drawer, watchlist and layouts, Trend, Charts
and Treemap, Sectors, Correlation, Funding, Sessions, Signals, Calendar, News, AI Report, Notes,
Messages, positions, Ask, alerts and Telegram, the phone — each opening with *the value* (what it is
worth to you, in one sentence), then numbered *how to use it* steps, the tips people miss, and a
worked example where one helps. It opens with three daily routines (the five-minute open, the
positioning read, the weekly review) and closes with ten habits. Both guides carry inline figures
(pure SVG/CSS, no scripts, the app's own colours — a data-flow map, the two-universe wall, the ΔOI
quadrant, a trend ladder with its retest, the sector flow map, a pair spread, a funding heatmap
slice, the session curves, a signal-card anatomy, the rule edge-trigger, the alert fan-out, and
mocks of the table, drawer, notes, chat and ask console) and an **In real life** story per feature:
a concrete situation, what you do, what you decide. On top of the drawings, both guides carry
**real screenshots** of the app (`docs/img/*.jpg`, served at `/docs/ref/img/<file>` behind the same
gate, strict name pattern, 404 otherwise), cropped to the control they explain and annotated with
numbered callouts whose positions were measured off the live DOM at capture time; each feature in
the how-to opens with a **Do this** box of one-action steps. Screenshots are taken from a sandbox
boot of the app with live Hyperliquid data and throwaway accounts, so nothing in them is a real
member's. Same wiring as the explainer: DOC_REFS, the manual's opening and further reading, the
app footer, the `?` card.

`docs/` also holds the longer reference pages — the feature map, system map, mechanics and signal
reference — plus the design mocks that preceded the funding heatmap, notes, insiders,
backtest-target (built — see **Backtest target mode** above) and return/drawdown work, the site-shell redesign mock
(`xyz-monitor-shell-redesign-mock.html`: one shell, one type scale, three controls — built in 2026.09.23-93: the shell, the tokens, every control family on one base, every controls row in zones, and no literal size or radius left in the stylesheet or the client; `test/client-shell.test.js` keeps it that way), the share-to-chat mock (`xyz-monitor-share-to-chat-mock.html`, now built — see **Share to chat** above) and the call-targets mock (`xyz-monitor-call-targets-mock.html`: "$INTC to 32 by Oct 15" as a tracked target that resolves on hit, miss or an invalidation level — built in 2026.09.24-95, see **Call targets** above). The six reference pages are served at `/docs/ref/explainer`, `/docs/ref/howto`,
`/docs/ref/features`, `/docs/ref/map`,
`/docs/ref/mechanics` and `/docs/ref/signals` (nonce-stamped, same gate); the mocks are not served.

## Project layout

```
server.js            Fastify server: serves /public + the JSON API, owns the poller, auth, SSE, CSP, /docs
src/hyperliquid.js   REST client + weight-based rate limiter, WebSocket universe feed, Coinalyze
src/compute.js       stats + feature extraction, event studies, calendars, brief/landscape prose
src/poller.js        universe poll, candle backfill, OI sampling, snapshot build, every data lane
src/store.js         persistence on the volume: OI log, candle archive, feature cache, notes
src/accounts.js      SQLite (accounts.db): members, invites, messages, prefs, wallets
src/sectors.js       curated sector / industry / display-name tables
public/index.html    frontend shell
public/docs.html     the manual, served at /docs
public/styles.css    styles
public/app.js        client entry: imports the modules below and runs their boot steps in order
public/js/*.js       the client, one ES module per area (core, markets, drawer, notes, messages, …)
public/sw.js         install-only service worker (caches nothing)
scripts/             bench-builds.js — event-loop cost of the poller's synchronous builds
test/                node:test suites, one file per module and area (see Tests)
docs/                reference pages (served at /docs/ref/*) and design mocks (not served)
railway.json         Railway build/deploy config
```

The client is native ES modules with no bundler: `app.js` imports every module under `public/js`
and then calls their `__boot_*` functions in the original single-file order, so a module can
import any other (cycles included) without a top-level statement ever reading a binding that has
not been initialised. The server stamps `?v=BUILD` onto every import specifier at boot and serves
the modules precompressed and immutable at the current stamp, the same contract the entry has.

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
- Redeploys keep OI history and the candle archive (both on the volume: `oi.log`, `candles.db`);
  only spines that went stale while the server was down are re-fetched, so a warm table is back
  within a poll or two.
- While the live push stream (SSE) is healthy the status line reads **push live** and your
  browser pulls the moment the server's data changes (~15s snapshot cadence). The refresh
  selector (15s–15m, default 30s) only paces the fallback poll used when the stream is down.
  The server updates independently every ~15–30s regardless.

## Tests, lint, bench

```bash
npm test          # node:test, one file per module/area under test/, run in parallel (~20s)
npm run test:cov  # the same with Node's built-in coverage table (what CI runs)
npm run lint      # ESLint 10, flat config: server (CommonJS), client (ES modules), service worker
npm run bench     # event-loop cost of the poller's synchronous builds, persistence and VACUUM paths on a synthetic 150-market book
```

Test files are named for what they exercise (`compute-signals`, `poller-lanes`, `client-core`,
`accounts`, `server` for the HTTP suite through `fastify.inject()`, `server-pins` for source pins).
Shared fixtures live in `test/_shared.js`; tests that read "the client source" get it from
`test/_client.js`, which concatenates the modules with the module syntax removed — exactly the old
single-file scope, so a grabbed function body runs the same way it always did.

On the worker-thread question the codebase keeps asking: `npm run bench` is the measurement. On a
150-market synthetic book the warm snapshot build holds the loop for 12–35 ms and the loop's p99
under a build every 200 ms is 16 ms — under the 50 ms gate the histogram on `/api/health` was
armed for — and shipping one market's daily bars to a worker costs more than the level-map work on
them. The build stays on the loop until those numbers, or the production histogram, say otherwise.

**Performance (build 2026.09.24-101).** The first worker thread went where the numbers pointed:
the daily `VACUUM INTO` off-copies of `candles.db` and `accounts.db` now run in a
`worker_threads` Worker on their own connection (WAL permits the concurrent reader; `src/vacuum.js`),
with the in-process copy as a fallback if a worker cannot start — on a 28 MB synthetic archive the
loop's max delay during the copy drops from ~110 ms to ~7 ms (`npm run bench` prints both). The
same .tmp → rename → previous-copy-survives contract holds. The 120 s `features.json` write skips
when a cheap signature of its inputs is unchanged and otherwise writes through `fs.promises` on one
serialized chain; the ledger's periodic persist uses an async FileHandle twin of the durable
write/fsync/rename/dir-fsync sequence. Shutdown and the crash export stay synchronous and supersede
any async write still in flight. Also: `/api/analytics` goes through the memoized serialize + gzip
path, an anonymous `/api/health` (the Railway healthcheck) no longer builds the full stats, SSE
streams more than 64 KB behind are dropped (EventSource reconnects and resyncs), the Hyperliquid
limiter keeps a running sum instead of filter+reduce per grant, the zip ingests await `drain`, and
the sync-heavy timers (snapshot, store flush, signals + ledger, daily, features) sit on distinct
phases instead of firing in the same tick. Cadences are unchanged.

**Performance (build 2026.09.24-102).** The timers that mostly find nothing new now find that out
first. `buildDaily` (60 s) computes its signature from per-row memos — daily tuples, the daily-step
OI series, funding by day, each keyed on its own inputs — and returns the previous object before
assembling anything (~100 ms → ~1.3 ms on the 150-market bench with a full year of OI history).
The forward-fill funding write keeps `getFunding`'s sorted copy incrementally instead of re-sorting
~1,440 hours per market per 30 s poll. In `buildSnapshot` (15 s) the funding percentile is
memoized exactly (it holds until the funding map, the rate, or the 31-day cut past its oldest
counted hour moves), the 7d/30d window-average funding legs are memoized per sample and clock
minute (the short legs stay fresh), and the change signature reuses cached per-object strings
(~40 ms → ~11–19 ms unchanged on the same bench). The in-memory OI history thins samples that
age past the 31-day full-resolution window about hourly on push (the same first-sample-per-hour
rule the daily pass applies), trims its front with one splice, and `getSeries` is memoized per
sample. The keyed
response cache is a byte-bounded LRU (64 MB, 800 entries) that holds only the serialized string and
its gzip, and a new version of a chart or series replaces its previous one — the tf-candle key keeps
its ~0.1 % price bucket (the forming bar's live close) without piling up an entry per bucket.
Shutdown awaits in-flight async writes before its final synchronous saves, and a synchronous save
that overlaps an async rename of the same file is re-landed after it, so the older copy never wins.
The history stays as `[ts, oi, funding]` arrays (~210 MB of heap for 150 markets × 365 days on the
bench): moving it to columnar typed arrays would touch every reader that indexes `s[0]`/`s[1]`/`s[2]`
(the ΔOI and funding windows, the studies, the drawer series, the sector spines), so it is deferred.

**Performance, client (build 2026.09.24-103).** The browser side of the same idea: do nothing for a
page nobody is looking at, and never recompute what has not changed. A hidden tab no longer pulls
`/api/snapshot` on pokes or polls (nor `/api/daily` on its timer): it remembers that something
moved and pulls once when it becomes visible again. The exception is this browser's own alert
rules (squeeze / momentum / beta, evaluated client-side and delivered as desktop notifications —
Telegram and web push are server-side and never needed the tab): while at least one exists, a
hidden tab keeps one background pull per minute so those rules still fire. `render()` always
derives and evaluates alerts, but the markets DOM (table or lens, action lists, movers, regime
strip) paints only while Markets is the visible view; otherwise it is marked dirty and painted once
on the way back. `/api/daily` bodies whose version is already applied (a 304 comes back from
`fetch()` as the cached body) are skipped outright instead of invalidating every per-row memo and
repainting the matrix and sectors map. Correlation aligns returns once into a dense `Float64Array`
and runs Pearson over it with the old arithmetic in the old order — identical to 1e-12, pinned
against the previous builder — memoized on (lookback, day, rows, each row's daily-array identity)
and shared by the Corr tab, the sectors board (which needs the full N×N for its sector×sector
panel) and the markets lens; clustering uses numeric indices instead of string-keyed Maps. On a
synthetic 140 × 365-day fixture in Node: `buildCorr` 144 → 31 ms (90d: 54 → 15 ms; memo hit
≈0.02 ms), `clusterOrder` ~40–55 → ~2 ms. The matrix cells carry no data attributes (position +
the cached matrix say everything), and hover rebuilds the tooltip, readout and header highlight
only when the hovered cell changes. The document-wide tooltip mousemove is coalesced to one
dispatch per animation frame; the report countdown and voice-note ticks sleep when nobody can see
them. Five tab-only modules (charts, drawdown, funds, insiders, positioning — 264 KB of 1.72 MB)
load on first use through `lazyCall` in `core.js` (literal `import()` specifiers, which the server
now stamps with `?v=<build>` like static imports, so a lazy module is the same immutable-cached
instance its neighbours would import); the eager graph drops to 1.47 MB raw, and the shell
`modulepreload`s core/data/markets. The service worker answers exactly this build's stamped
`/app.js`, `/js/*.js` and `/styles.css` cache-first from an `xyz-static-<build>` cache (the server
stamps the build into `sw.js`, and activate purges other builds' caches); `/api/*`, HTML and
unversioned URLs are never intercepted. Not done here, and the next step on first-load bytes: a
minify/bundle build step (no new dependencies were in scope for this pass).

**Accuracy (build 2026.09.24-104).** Seven measurements corrected to agree with their own
definitions:
- **AMC reaction, client = server.** The Earnings tab scored an AMC print's reaction on the bar
  AFTER the print day (a +20% pop read as the next day's +0.8%); it now runs a port of the
  server's `earnPrintReaction` rule — the print day's own UTC bar (it closes 00:00Z, hours after a
  16:05 ET print) vs the last close before it, "so far" against the mark while that bar is open —
  held to the server by a parity test (BMO, AMC, Friday AMC, forming, missing bar). *Superseded in
  -106*: the print-day UTC bar was itself a 20:00 ET → 20:00 ET window pooled with other windows;
  every reader now shares one cash-close → cash-close definition (below).
- **Backtest annualization.** Sharpe and the vol target annualized equities at √252 while the
  return series has one entry per UTC day, weekends included (~365/yr): Sharpe was understated
  ~1.2× and the vol target oversized the book. Both now use the series' own observed periods per
  year (bars ÷ span); crypto stays 365. The caption states the number.
- **AI-context β.** The brief's `vsBenchmark` β paired closes by array index (one missing bar
  shifted every pair a day) over ≤ 60 simple returns; it now uses `compute.dailyBeta`, the
  board's own definition (90d log returns keyed by UTC day, ≥ 20 pairs) with the forming bar
  dropped, pinned to the client's `computeBeta` by a parity test.
- **Holiday-aware earnings sessions.** `earnSessionsAhead` skips US exchange holidays (the gap
  engine's calendar), not only weekends, and an AMC print on a 13:00 ET early-close day (Jul 3,
  the Friday after Thanksgiving, Christmas Eve) anchors at 13:00, not 16:00.
- **Session-true call targets.** A date deadline on a US session name ends at that date's cash
  close; a hit or a stop needs an in-session touch or an off-hours 5m close through the level
  (details under Messages above). Crypto is unchanged.
- **Premium z per session.** The mark-vs-oracle premium's z-score (the `prem` signal, the
  pre-earnings card) pooled cash-open and cash-closed samples into one 7-day mean/sd. The two
  regimes now keep separate baselines — median and MAD×1.4826, robust to the dislocations being
  scored — and z uses the one for the current session state (pooled when that bucket has < 60
  samples; crypto and foreign-home names pool).
- **vs cash close.** A new (hidden by default) **vs close** column: the mark vs the last US cash
  close (16:00 ET, 13:00 on a half day, holidays skipped), shipped on `/api/daily` as
  `cashClose`, and a **vs S&P (close)** twin — the row's vs-close move minus the S&P's. The 24h
  column keeps its meaning (Hyperliquid's rolling `prevDayPx`, which on a Monday is Sunday's).

**Accuracy (build 2026.09.24-105): the US-session daily series, with true lows.** Nearly every
daily metric ran on Hyperliquid's UTC-day candles — Saturdays, Sundays and exchange holidays
included — for names whose underlying only trades US (or home-exchange) sessions: "200-day" was
~140 sessions, near-flat weekend bars deflated every σ, a Monday return was measured against
Sunday. One shared definition now, `compute.sessionFold` (client twin `core.js sessionFold`, held
to it by a parity test):
- **The session bar.** The UTC bar for date D runs 00:00Z D → 00:00Z D+1 = 20:00 ET D−1 → 20:00 ET
  D (19:00 in winter), so it *contains* D's whole 09:30–16:00 cash session (and a KRX/TSE/HKEX/SSE
  name's whole local session). So the session bar for trading day D **is** UTC bar D; a weekend or
  full-day holiday bar is **folded into the next session bar** — high = max, low = min, open = the
  first folded bar's, close = the session's, volume summed — so no move is lost, it lands in the
  next session's return. A fold still waiting for its session (it is Saturday) is that session's
  *forming* bar, keyed at its date and trimmed by every closed-bar rule. Calendars: crypto none
  (calendar days, unchanged); a foreign-home listing its home exchange's (`homeDayStatus`); every
  other xyz name — US equities, ADRs, indices, commodities, FX — the US exchange calendar
  (`usDayStatus`), exactly the anchoring the gap engine already applies. `/api/daily` ships the
  calendars as `sessOff` (per calendar, the non-trading UTC day indexes) so the client folds on
  the server's holidays.
- **True lows (and opens).** `refreshDaily` parses the candle once (candleSnapshot answers strings;
  every `Number.isFinite(k.h)` downstream had been reading them as absent — the live payload
  shipped no highs) and keeps o/h/l/c/v; the warm cache persists `[t,c,h,v,l,o]` (trailing nulls
  trimmed; an older 2/4-tuple file hydrates with no low, which every reader falls back to the
  close on and flags `tl: false`); `/api/daily` tuples gain the low as column 4 (`[t,c,h,v,l]` —
  the open is not shipped: a 24/7 perp's bar opens at the prior close). `mergedDailyBars` marks a
  candle's own low `tl` like a spine overlay.
- **Session consumers.** MA20/50/100/200 on the board and the snapshot's `ma200` (so the rules'
  "200-day" is 200 sessions); the Trend board's D1 rung (board, pair board, closed alert lane, AI
  context, chart modal), the D1 retest study, the EMA200 study and the `emarts` shadow; the
  signal loop's closes — so the 30-bar σ unit (`sd30`/`sdAt`), the studies' horizons, the 30-bar
  breakout range and every detector count sessions; `volD` and the average-range series
  (`featuresFromHourly`, per-session (h−l)/c off the spine's true extremes: 5 / 21 sessions on
  the board, crypto 7 / 30 days); the earnings expansion baseline and the setup card's usual daily
  move (20 sessions); the regime strip's mean correlation, the AI context's β, the board's β
  (parity-tested), co-movers and the correlation matrix.
- **Correlation.** Session returns with the still-open bar dropped (as the server already did); a
  cell under **10** overlapping returns stays empty and reads *n<10* (a 7d window, ~5 sessions,
  greys by design); a cell whose Fisher-z 95% CI spans 0 is faded, with the CI in the hover; the
  heatmap's ORDER clusters a matrix shrunk toward the average correlation (Ledoit-Wolf-style
  intensity from each r's sampling variance) while every displayed value stays raw. A crypto row
  beside session rows is folded onto the US calendar so both returns span the same interval.
- **Drawdown tab.** Base = the prior close (the anchor day's own move now counts); drawdown
  *intraday* by default (running peak of highs → a later low; a bar's own high never counts
  against its own low), *close-to-close* on the toggle; US names on session bars. **vs YTD hi**
  measures from the year's highest daily high.
- **Vol (ann).** Session names: Yang-Zhang over the last 20 closed session bars ×√252 (the open
  is the prior close on a 24/7 perp, so the overnight term is zero and YZ is k·σ²(close-to-close)
  + (1−k)·Rogers-Satchell); a window with a bar lacking a true low falls back to the
  close-to-close σ of the 20 session returns, labelled; crypto keeps the hourly read ×√(24·365)
  with the still-forming hour excluded (`volH`). Carry divides by whichever the column shows.
Not moved: the backtest keeps its calendar-day return series (its annualization already observes
periods/yr), and the level map's structure and volume profile keep every UTC bar's prints (its
σ and EMA50/200 are session-based).

**Accuracy (build 2026.09.24-106): earnings windows, backtest fills, error bars.**
- **One earnings reaction.** The study pooled four windows under one "next-session move": AMC
  16:00 ET → +24h, BMO 06:00 → 06:00, the daily fallback 20:00 → 20:00 ET, and a Friday AMC's +24h
  landing on Saturday. Now every reader (`earnReactionsFor`, the brief's `earnPrintReaction`, the
  Earnings tab's `earnReactPct`, parity-tested) uses `compute.earnReactWindow`: the **last cash
  close before the print → the first cash close after it** on the exchange calendar — BMO/DMH the
  prior close → the print day's close, AMC the print day's close → the next session's (Friday →
  Monday; the Wednesday before Thanksgiving → Friday's 13:00 half-day close). The hourly spine
  (~180d) and the 5m archive (~370d, read only around each print's anchors) resolve the exact
  16:00/13:00 closes; beyond them the session daily bar's close (20:00 ET) is a labelled fallback,
  counted (`dailyN`, "3 of 12 from daily closes"). Untimed (TBD) prints are excluded (`tbdN`), not
  booked on a guessed side. The median |move| carries a **bootstrap 90% CI** (1000 resamples,
  fixed-seed mulberry32 so the range is stable across rebuilds) from n ≥ 4 on the tab, the drawer,
  the setup card and its verdict; under 4 the thin warning stands. The browser, having no intraday
  spine, runs the daily tier and says so.
- **Cash-session earnings gap.** The gap compared a 24/7 perp's 00:00Z open with the 00:00Z close
  a moment before it (the same price) and a |g| > 0.05% filter dropped most prints. Gap is now the
  reaction session's 09:30 ET price vs the reference cash close; *held* = that session's cash close
  beyond the gap-open in the gap's direction. Intraday only: a timed print without all three
  anchors is excluded and counted (`gapOf`, shown "gap n=7 of 12"; the setup verdict appends it).
  A 09:30 anchor read off the 09:00 hourly close (no 5m bar) is counted in `gapApprox`.
- **Backtest fills, slippage, survivorship, Sharpe SE.** The signal read bar *d*'s close and the
  book filled at that same close. A **fill** control now defaults to *next bar* (the decision fills
  at the next bar's close and earns from the bar after; the trade log's in/out dates are fill
  bars) with *same close (as before)* kept, labelled; **slip bps** (default 5, per side) is
  charged on turnover beside the taker fee (twice a night on the overnight hold) and shown as its
  own friction row. Delisted names' history is not available (`/api/daily` ships live listings;
  a delisted market's history is freed after 7d), so every caption states **survivorship: current
  listings only**. Each Sharpe shows **± its standard error** (Lo 2002: √((1 + ½SR²)/T) per
  period, annualized) and a ⚠ when the ±1.96·SE band includes 0.
- **D1 retest study: clustered errors.** Events on the same day across names share one tape, so
  the pooled n overstated the sample. Each cell now ships `dates` (distinct event days, shown as
  "n · Ndt") and the mean's **standard error clustered by event date** (CR1), shown as ±1.96·SE.
  Horizons on stock scope are session bars since -105 and are labelled "+5 sess" (crypto "+5d").

**Fixes (build 2026.09.24-107).**
- **Call targets.** A miss waits until the 5m archive holds the bar ending at the deadline (or 20
  min past it) and prices at that bell bar; the sweep pages through every open target. A date
  whose close already passed at send ("eom" after the last close) is refused, not a silent one-day
  horizon; a relative deadline ("in 3w") and an extension on a session name end at a cash close.
  The composer preview runs the same calendar.
- **Telegram sync.** `getUpdates` ticks are single-flight (a slow download no longer lets the
  next tick replay updates); a disabled account cannot edit or react from a linked chat; an edit or
  delete made before Telegram confirms a send is carried into the send (a deleted line or file is
  never sent); deleting a group removes its sync-map rows; a chart card needs its real picture.
- **Numbers.** An earnings reaction is final only off an exact close (not an hourly close up to 3h
  early); a daily-tier AMC reaction spans two sessions, so it is labelled and kept out of the
  pooled study. "vs cash close" re-reads once the bell bar lands. The retest SE is two-way
  clustered (name × date). The backtest panel shows the pending next-close fill apart from the
  position held.
- **Plumbing.** Downloads stream through `stream/promises` pipeline (no hang on a write error);
  signals then actionable run chained each cycle; the retest ETag carries the build and a boot
  nonce; stale backup/`.atmp` temps are swept; a crash save cannot be overwritten by an in-flight
  async rename.

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
15 minutes — HTTP Basic attempts count against the same lock. Scripts and `curl` can skip
the cookie and use HTTP Basic (`curl -u friend:PASSWORD .../api/snapshot`), which is still
accepted. `/api/health` stays open for Railway's healthcheck. Leave `SITE_PASSWORD` unset
to stay open. `TRUST_PROXY=1` (the default) keys that lock on the **last** `X-Forwarded-For`
element, which assumes exactly one trusted proxy (Railway's edge) appends it — set
`TRUST_PROXY=0` when the service is exposed directly or sits behind a proxy that does not,
or every caller can pick its own key.

## Tuning (optional)

In `src/poller.js`:
- `UNIVERSE_MS` — how often price/funding/OI + new-market detection runs (default 30s).
- `OI_MIN_GAP` — minimum spacing between stored OI samples (default ~5 min).
- `OI_RETENTION` — how much OI history to keep (default 31 days).
- `HOURLY_STALE` / `DAILY_STALE` — how often candle features / daily history refresh.

## Not investment advice.
