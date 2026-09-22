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
  same `notifiedMsgId` the digest uses, so the two can never deliver a line twice. Edits,
  deletions and reactions are not mirrored; attachments arrive as their name. Bare text is only
  accepted from a **private** chat with the bot — a group chat linked with `/start` would post
  everyone's lines under the one account that linked it. `/r` and `/r @handle` keep working as
  before.
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
  arithmetic as the markets column), so "above the 200-day" and "crosses the 200-day" are rules,
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
  Not in this cut: charts, drawer sections and the other boards (the mock in `docs/` shows where
  the same glyph goes next), and a screen card does not re-run its filters live.
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
- **The calls record** (`/api/dm/calls`) — every price-stamped message in one place, with the move
  since it was sent and a per-person summary. This is what the stamp was FOR: without somewhere to
  read them together, each call died in the conversation it was made in. Calls carry a
  **direction** (write `short $HOOD` — or `$HOOD puts` — and it scores as a short; everything else
  is a long), the board and summary score the **direction-adjusted** move (positive = the call is
  right), and each call is also scored at **fixed 1d/7d horizons** (the first daily close past the
  mark) so the record isn't a function of when you look. Click a person in the summary to filter
  to their record. The record is **delete-proof**: deleting a call removes its body, never its
  stamp or score. A stamp card also carries a one-tap **⚑ alert** that arms a price alert at the
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
reference — plus the design mocks that preceded the funding heatmap, notes, insiders and
backtest-target work, the share-to-chat mock (`xyz-monitor-share-to-chat-mock.html`, now built — see **Share to chat** above) and the call-targets mock (`xyz-monitor-call-targets-mock.html`: "$INTC to 32 by Oct 15" as a tracked target that resolves on hit, miss or an invalidation level — a proposal, not yet built). The six reference pages are served at `/docs/ref/explainer`, `/docs/ref/howto`,
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
npm run bench     # event-loop cost of the poller's synchronous builds on a synthetic 150-market book
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
