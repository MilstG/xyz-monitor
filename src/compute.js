"use strict";
// Math ported verbatim from the original client so server-computed features match exactly.

function stdev(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((p, q) => p + q, 0) / a.length;
  let v = 0;
  for (const x of a) v += (x - m) * (x - m);
  return Math.sqrt(v / (a.length - 1));
}
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function linregR2(ys) {
  const n = ys.length;
  if (n < 3) return { slope: 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const d = n * sxx - sx * sx;
  if (d === 0) return { slope: 0, r2: 0 };
  const slope = (n * sxy - sx * sy) / d, b = (sy - slope * sx) / n, my = sy / n;
  let sr = 0, st = 0;
  for (let i = 0; i < n; i++) { const yh = slope * i + b; sr += (ys[i] - yh) ** 2; st += (ys[i] - my) ** 2; }
  return { slope, r2: st > 0 ? 1 - sr / st : 0 };
}
function priceAt(c, target, tol) {
  if (!c || !c.length) return null;
  let best = null, bd = Infinity;
  for (const k of c) { const d = Math.abs(k.t - target); if (d < bd) { bd = d; best = k; } }
  if (!best || bd > tol) return null;
  const v = parseFloat(best.c);
  return isFinite(v) ? v : null;
}

// Reference prices (1h/4h/7d/30d) + momentum/vol features from ~30d of hourly candles.
function featuresFromHourly(c, now, HOUR, DAY) {
  const ref = {
    p1h: priceAt(c, now - 1 * HOUR, 95 * 60 * 1000),
    p4h: priceAt(c, now - 4 * HOUR, 3 * HOUR),
    p7d: priceAt(c, now - 7 * DAY, 4 * HOUR),
    p30d: priceAt(c, now - 30 * DAY, 6 * HOUR),
  };
  const rets = [], dayMap = new Map(), dayHLC = new Map();
  let prev = null, hi = -Infinity, lo = Infinity, vwNum = 0, vwDen = 0;
  for (const k of c) {
    const cl = parseFloat(k.c), h = parseFloat(k.h), l = parseFloat(k.l), v = parseFloat(k.v);
    if (isFinite(h) && h > hi) hi = h;
    if (isFinite(l) && l < lo) lo = l;
    // rolling VWAP over the full window: per-candle typical price (H+L+C)/3 weighted by
    // base volume. An approximation of tick VWAP (no per-fill data in candles), but the
    // volume weighting is real. Zero-volume candles contribute nothing by construction.
    if (isFinite(v) && v > 0) {
      const typ = (isFinite(h) && isFinite(l) && isFinite(cl)) ? (h + l + cl) / 3 : (isFinite(cl) ? cl : null);
      if (typ != null && typ > 0) { vwNum += typ * v; vwDen += v; }
    }
    if (isFinite(cl)) { if (prev != null && prev > 0) rets.push(Math.log(cl / prev)); prev = cl; }
    const day = Math.floor(k.t / DAY), ntl = (isFinite(v) && isFinite(cl)) ? v * cl : 0;
    dayMap.set(day, (dayMap.get(day) || 0) + ntl);
    // per-day high / low / last-close for the average daily range series
    let d = dayHLC.get(day);
    if (!d) { d = { hi: -Infinity, lo: Infinity, c: null, lastT: -Infinity }; dayHLC.set(day, d); }
    if (isFinite(h) && h > d.hi) d.hi = h;
    if (isFinite(l) && l < d.lo) d.lo = l;
    if (isFinite(cl) && k.t >= d.lastT) { d.c = cl; d.lastT = k.t; }
  }
  const seg = c.slice(-Math.min(168, c.length)).map((k) => Math.log(parseFloat(k.c))).filter(Number.isFinite);
  const { r2 } = linregR2(seg);
  // average-daily-range series: (high − low) / close per COMPLETED day, oldest→newest
  const today = Math.floor(now / DAY);
  const dayEntries = [...dayHLC.entries()].sort((a, b) => a[0] - b[0]);
  const dr = dayEntries
    .filter(([day, d]) => day < today && d.hi > -Infinity && d.lo < Infinity && d.c > 0)
    .map(([, d]) => (d.hi - d.lo) / d.c * 100);
  // daily-close path (last ~31 days) so the 30d-trend sparkline needs no daily candles
  const px30 = dayEntries.map(([, d]) => d.c).filter((v) => v != null && isFinite(v)).slice(-31);
  // Daily-return volatility from completed-day closes. Momentum uses this to risk-adjust its
  // day-plus horizons rather than extrapolating hourly vol by sqrt(t): the sqrt(t) rule assumes
  // iid returns, which fits poorly for perps on closed-hours underlyings (session structure,
  // overnight gaps), so a directly measured daily vol is the more trustworthy yardstick over 1d+.
  const dCloses = dayEntries.filter(([day, d]) => day < today && d.c > 0).map(([, d]) => d.c);
  const dRets = [];
  for (let i = 1; i < dCloses.length; i++) if (dCloses[i - 1] > 0) dRets.push(Math.log(dCloses[i] / dCloses[i - 1]));
  const volD = dRets.length >= 5 ? stdev(dRets) : null;
  const feat = {
    volH: stdev(rets),
    volD,
    r2,
    hi30: hi > -Infinity ? hi : null,
    lo30: lo < Infinity ? lo : null,
    volBase: median([...dayMap.values()].filter((x) => x > 0)),
    dr,
    px30,
    // volume-weighted average price over the whole hourly window (~31d); null when the
    // window traded no volume — an honest dash beats a fabricated level.
    vwap30: vwDen > 0 ? vwNum / vwDen : null,
  };
  return { ref, feat };
}

// Open-interest change over a window from a [[ts, oi], ...] history buffer.
// Anchors by linear interpolation between the two samples that straddle `now - window`,
// so the reference lands on the exact window boundary rather than on whichever stored
// sample happens to be nearest. Tolerance is derived from the window and hard-capped at
// 12h, so a long-window ΔOI can never be silently anchored days off-target; if no sample
// lands within tolerance it returns null instead of a misleading number. A straddle wider
// than 3× tolerance (i.e. a poller outage) uses the nearer sample instead of interpolating
// across the void. The 4th argument (old per-call tolerance) is accepted and ignored for
// backward compatibility with existing callers.
// Binary-search helpers over a [[ts, ...], ...] array kept ASCENDING by ts (which every
// caller here guarantees: store.loadAll sorts, live appends are monotonic). firstIndexGT
// returns the first index whose ts is strictly greater than t; firstIndexGE the first index
// whose ts is >= t. Both return a value in [0, arr.length]. These turn the OI/funding window
// scans below from O(n) (a full walk of the ~9k-sample 31d spine, per timeframe, per market,
// every 15s tick) into O(log n) — the single biggest per-tick cost in buildSnapshot.
function firstIndexGT(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][0] > t) hi = m; else lo = m + 1; }
  return lo;
}
function firstIndexGE(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][0] >= t) hi = m; else lo = m + 1; }
  return lo;
}
function oiDeltaPct(hist, oiNow, windowMs) {
  if (!hist || hist.length < 2 || !(oiNow > 0)) return null;
  const MIN = 60 * 1000, HOUR = 60 * MIN, OI_MIN_GAP = 4.5 * MIN;
  const tol = Math.min(Math.max(2 * OI_MIN_GAP, windowMs * 0.05), 12 * HOUR);
  const target = Date.now() - windowMs;

  // `before` = latest positive-OI sample at or before target; `after` = earliest positive-OI
  // sample after target. Binary-search the split, then walk outward past any non-positive-OI
  // samples (rare) — identical result to the old full linear scan, a couple of steps instead
  // of thousands.
  const split = firstIndexGT(hist, target);          // first index with ts > target
  let before = null, after = null;
  for (let i = split - 1; i >= 0; i--) if (hist[i][1] > 0) { before = hist[i]; break; }
  for (let i = split; i < hist.length; i++) if (hist[i][1] > 0) { after = hist[i]; break; }
  const dBefore = before ? target - before[0] : Infinity;
  const dAfter  = after  ? after[0] - target  : Infinity;
  if (Math.min(dBefore, dAfter) > tol) return null;

  let base;
  if (before && after && (after[0] - before[0]) <= 3 * tol) {
    const span = after[0] - before[0];
    base = before[1] + (after[1] - before[1]) * ((target - before[0]) / span);
  } else {
    base = (dBefore <= dAfter ? before : after)[1];  // one-sided, or straddle too wide
  }
  if (!(base > 0)) return null;
  return (oiNow - base) / base * 100;
}

// Time-weighted average funding rate over the trailing window, from the OI/funding history
// buffer ([[ts, oi, funding], ...], ascending). Trapezoidal integration, so it measures the
// funding rate over the *same* interval as the price and OI legs of the regime and is robust
// to uneven sampling and short gaps. Segments with missing funding break the integration
// (so restored pre-funding history is simply skipped); falls back to a simple mean when the
// span can't be integrated. Returns null when there is no funding data inside the window.
function fundingAvg(hist, windowMs) {
  if (!hist || hist.length < 1) return null;
  const now = Date.now(), start = now - windowMs;
  // Only samples from the one immediately before `start` onward can contribute: any earlier
  // segment clips to zero width against `start` in the integration below, and simSum/simN only
  // count t >= start. Binary-search to that sample and skip the (potentially thousands-long)
  // dead prefix. The pT=null seed reproduces the old loop's state exactly at the boundary.
  let pT = null, pF = null, area = 0, span = 0, simSum = 0, simN = 0;
  const i0 = firstIndexGE(hist, start);              // first index with ts >= start
  for (let i = Math.max(0, i0 - 1); i < hist.length; i++) {
    const s = hist[i], t = s[0], f = s[2];
    if (f == null || !isFinite(f)) { pT = null; pF = null; continue; }
    if (t >= start) { simSum += f; simN++; }
    if (pT != null && t > pT) {
      const a = Math.max(pT, start);
      if (t > a) {
        const fa = a === pT ? pF : pF + (f - pF) * ((a - pT) / (t - pT)); // interp left edge if it crosses start
        area += (fa + f) / 2 * (t - a);
        span += (t - a);
      }
    }
    pT = t; pF = f;
  }
  if (span > 0) return area / span;
  return simN ? simSum / simN : null;
}

// Daily log-returns keyed by day-index, from a [[t, close], ...] or [{t, c}, ...] series.
function dailyLogReturns(daily) {
  const m = new Map(); let prev = null;
  if (!daily) return m;
  for (const k of daily) {
    const t = Array.isArray(k) ? k[0] : k.t;
    const c = parseFloat(Array.isArray(k) ? k[1] : k.c);
    if (!Number.isFinite(c)) continue;
    const day = Math.floor(t / 86400000);
    if (prev != null && prev > 0) m.set(day, Math.log(c / prev));
    prev = c;
  }
  return m;
}
function pearson(a, b) {
  const n = a.length; if (n < 3) return null;
  let sa = 0, sb = 0; for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n; let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  if (va <= 0 || vb <= 0) return null;
  return cov / Math.sqrt(va * vb);
}
// Mean pairwise daily-return correlation across a set of series over the trailing `Ldays`.
// Same overlap rule as the client correlation tab (>= max(15, half the window)), so the strip's
// number and the matrix agree. Returns { corr, pairs } — corr is null until enough pairs qualify.
function meanPairwiseCorr(seriesList, Ldays) {
  const cutoff = Math.floor(Date.now() / 86400000) - Ldays;
  const minOv = Math.max(15, Math.floor(Ldays * 0.5));
  const maps = seriesList.map((s) => {
    const m = dailyLogReturns(s), f = new Map();
    for (const [d, v] of m) if (d >= cutoff) f.set(d, v);
    return f;
  });
  let sum = 0, n = 0;
  for (let i = 0; i < maps.length; i++)
    for (let j = i + 1; j < maps.length; j++) {
      const A = maps[i], B = maps[j], small = A.size < B.size ? A : B, other = small === A ? B : A, xa = [], xb = [];
      for (const [d, v] of small) { const w = other.get(d); if (w !== undefined) { xa.push(v); xb.push(w); } }
      if (xa.length < minOv) continue;
      const c = pearson(xa, xb);
      if (c != null && Number.isFinite(c)) { sum += c; n++; }
    }
  return { corr: n ? sum / n : null, pairs: n };
}
// Pairwise correlation matrix over PRE-ALIGNED return series — every series is the same length on
// a shared time grid, null marking a gap. A cell is null below `minOv` overlapping non-null pairs,
// the same honest-overlap discipline as the daily matrix, applied to intraday bars. Returns
// { C, N }: C the correlation matrix (1 on the diagonal, symmetric), N the overlap count behind
// each cell so the hover can show how much history stands behind a number.
function corrMatrix(retList, minOv) {
  const K = retList.length;
  const C = Array.from({ length: K }, () => new Array(K).fill(null));
  const N = Array.from({ length: K }, () => new Array(K).fill(0));
  for (let i = 0; i < K; i++) {
    C[i][i] = 1;
    const ri = retList[i]; if (!ri) continue;
    for (let j = i + 1; j < K; j++) {
      const rj = retList[j]; if (!rj) continue;
      const L = Math.min(ri.length, rj.length), a = [], b = [];
      for (let t = 0; t < L; t++) {
        const x = ri[t], y = rj[t];
        if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y)) { a.push(x); b.push(y); }
      }
      const c = a.length >= minOv ? pearson(a, b) : null;
      C[i][j] = c; C[j][i] = c; N[i][j] = a.length; N[j][i] = a.length;
    }
  }
  return { C, N };
}



// =====================================================================================
// Boundary-backtest engine — evaluate "hold between two calendar-defined timestamps, net of
// funding" over the hourly price + funding spines. Anchor presets (overnight / weekend / cash)
// sit on a general primitive: give it enter/exit timestamps and it tabulates the long-side hold.
// =====================================================================================
// Boundary-backtest engine (pure, no I/O). Evaluates "hold between two calendar-defined timestamps,
// net of funding" over the hourly price + funding spines. The named anchor generators (overnight /
// weekend / cash) are just presets over a general primitive: give it enter/exit timestamps and it
// tabulates the hold. Long-perspective P&L: buy at `enter`, sell at `exit`.
//
// Funding sign: Hyperliquid funding rate > 0 means longs pay shorts, so a long's net return over a
// hold is grossReturn - sum(hourlyFundingRate) across the held hours.

const HOUR = 3600 * 1000, DAY = 86400 * 1000;
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// ---- ET (America/New_York) wall-clock, DST-correct via Intl (no hardcoded DST rules) ----
const _etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
});
function etParts(ms) {
  const p = _etFmt.formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  let h = +g("hour"); if (h === 24) h = 0;
  return { y: +g("year"), mo: +g("month"), d: +g("day"), h, mi: +g("minute"), wd: WD[g("weekday")] };
}
// Offset (hours) of ET from UTC at instant ms: -4 during EDT, -5 during EST.
function etOffsetAt(ms) {
  const et = etParts(ms);
  const asUtc = Date.UTC(et.y, et.mo - 1, et.d, et.h, et.mi);
  return Math.round((asUtc - ms) / HOUR);
}
// UTC ms whose ET wall-clock is (y,mo,d,h,mi). Guess EST, then correct by the real offset in effect.
function etWallToUtc(y, mo, d, h, mi) {
  const base = Date.UTC(y, mo - 1, d, h, mi);
  const off = etOffsetAt(base + 5 * HOUR);   // probe near the EST guess
  return base - off * HOUR;
}

// Enumerate ET calendar days in [startMs, endMs] (12h steps + dedupe so DST never skips a day).
function etDays(startMs, endMs) {
  const out = [], seen = new Set();
  for (let ms = startMs; ms <= endMs + DAY; ms += 12 * HOUR) {
    const et = etParts(ms), key = et.y + "-" + et.mo + "-" + et.d;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(et);
  }
  return out;
}
function nextEtDate(et, days) {
  const noon = etWallToUtc(et.y, et.mo, et.d, 12, 0) + days * DAY;
  return etParts(noon);
}

// ---- anchor generators: [{enter, exit, tag}] ----
// Cash session: 09:30 -> 16:00 ET, weekdays.
// ---- US equity market calendar ----------------------------------------------------------
// Full-day closures and 13:00 ET early closes, computed algorithmically (no yearly table):
// New Year's, MLK, Presidents, Good Friday, Memorial, Juneteenth, Independence, Labor,
// Thanksgiving, Christmas, with Sat->Fri / Sun->Mon observance. Early closes: Jul 3 (when
// Jul 4 falls Tue-Fri), the Friday after Thanksgiving, and Christmas Eve on a weekday.
// This is what makes the gap/off-hours engine correct on weeks like Jul 4 2026 (Saturday,
// observed Friday Jul 3): without it the boundary engine thinks Friday had a cash session.
function wallWd(y, mo, d) { return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); }
function shiftWall(y, mo, d, days) { const x = new Date(Date.UTC(y, mo - 1, d) + days * DAY); return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate() }; }
function nthWd(y, mo, wd, n) { const first = wallWd(y, mo, 1); return { y, mo, d: 1 + ((wd - first + 7) % 7) + (n - 1) * 7 }; }
function lastWd(y, mo, wd) { const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return { y, mo, d: dim - ((wallWd(y, mo, dim) - wd + 7) % 7) }; }
function easterSunday(y) {   // Anonymous Gregorian computus
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, dd = Math.floor(b / 4), e = b % 4,
    f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - dd - g + 15) % 30,
    i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31),
    d = ((h + l - 7 * m + 114) % 31) + 1;
  return { y, mo, d };
}
function observedHol(y, mo, d) { const wd = wallWd(y, mo, d); if (wd === 6) return shiftWall(y, mo, d, -1); if (wd === 0) return shiftWall(y, mo, d, 1); return { y, mo, d }; }
const _calCache = new Map();
function usMarketCalendar(y) {
  let m = _calCache.get(y); if (m) return m;
  m = new Map(); const K = (w) => w.y + "-" + w.mo + "-" + w.d;
  const es = easterSunday(y);
  const closed = [
    observedHol(y, 1, 1), nthWd(y, 1, 1, 3), nthWd(y, 2, 1, 3), shiftWall(es.y, es.mo, es.d, -2),
    lastWd(y, 5, 1), observedHol(y, 6, 19), observedHol(y, 7, 4), nthWd(y, 9, 1, 1),
    nthWd(y, 11, 4, 4), observedHol(y, 12, 25),
  ];
  for (const w of closed) if (w.y === y) m.set(K(w), 2);
  const ny = observedHol(y + 1, 1, 1); if (ny.y === y) m.set(K(ny), 2);   // next New Year observed Fri Dec 31
  const early = [];
  const j4wd = wallWd(y, 7, 4);
  if (j4wd >= 2 && j4wd <= 5) early.push({ y, mo: 7, d: 3 });             // Jul 3 early when Jul 4 is Tue..Fri
  early.push(shiftWall(y, 11, nthWd(y, 11, 4, 4).d, 1));                  // Friday after Thanksgiving
  if (wallWd(y, 12, 24) >= 1 && wallWd(y, 12, 24) <= 5) early.push({ y, mo: 12, d: 24 });
  for (const w of early) { const k = K(w), wd = wallWd(w.y, w.mo, w.d); if (!m.has(k) && wd >= 1 && wd <= 5) m.set(k, 1); }
  _calCache.set(y, m); return m;
}
// 0 = regular trading day, 1 = early close (13:00 ET), 2 = closed (weekend or holiday)
function usDayStatus(y, mo, d) {
  const wd = wallWd(y, mo, d);
  if (wd === 0 || wd === 6) return 2;
  return usMarketCalendar(y).get(y + "-" + mo + "-" + d) || 0;
}
// All cash sessions overlapping [startMs, endMs] (padded so callers can derive edge windows):
// { open: 09:30 ET, close: 16:00 or 13:00 ET }.
function marketSessions(startMs, endMs) {
  const out = [];
  for (const et of etDays(startMs - DAY, endMs + DAY)) {
    const st = usDayStatus(et.y, et.mo, et.d);
    if (st === 2) continue;
    out.push({ open: etWallToUtc(et.y, et.mo, et.d, 9, 30), close: etWallToUtc(et.y, et.mo, et.d, st === 1 ? 13 : 16, 0) });
  }
  return out;
}
// Cash sessions as hold anchors (respects holidays and early closes).
function cashAnchors(startMs, endMs) {
  const out = [];
  for (const s of marketSessions(startMs, endMs))
    if (s.open >= startMs && s.close <= endMs) out.push({ enter: s.open, exit: s.close, tag: "cash" });
  return out;
}
// Every closed window between consecutive sessions. Tagging keeps the two historical buckets:
// < 40h = "overnight" (single nights, incl. early-close afternoons), >= 40h = "weekend"
// (true weekends, holiday weekends, and midweek-holiday spans — they behave like one hold).
function closedWindows(startMs, endMs) {
  const ses = marketSessions(startMs - 6 * DAY, endMs + 6 * DAY), out = [];
  for (let i = 0; i + 1 < ses.length; i++) {
    const enter = ses[i].close, exit = ses[i + 1].open;
    if (enter >= startMs && exit <= endMs)
      out.push({ enter, exit, tag: exit - enter < 40 * HOUR ? "overnight" : "weekend" });
  }
  return out;
}
function overnightAnchors(startMs, endMs) { return closedWindows(startMs, endMs).filter((a) => a.tag === "overnight"); }
function weekendAnchors(startMs, endMs) { return closedWindows(startMs, endMs).filter((a) => a.tag === "weekend"); }

// ---- 24/7 (crypto) anchor generators -------------------------------------------------------
// A perp book never closes, so cash/overnight/weekend are meaningless. The two holds that DO carry
// meaning on a continuous book:
//   utcDay  — each complete UTC calendar day, 00:00 -> next 00:00. The "did holding a day pay"
//             analogue of the equity cash session, on the market's own clock.
//   cryptoWeekend — Fri 00:00 UTC -> Mon 00:00 UTC. Weekend crypto is a real regime (thin books,
//             gap risk into Monday); this measures the Fri->Mon hold as one bet.
function utcDayAnchors(startMs, endMs) {
  const out = [];
  let d = Math.ceil(startMs / DAY) * DAY;
  for (; d + DAY <= endMs; d += DAY) out.push({ enter: d, exit: d + DAY, tag: "utcday" });
  return out;
}
function cryptoWeekendAnchors(startMs, endMs) {
  const out = [];
  // Walk UTC day-starts; a Friday 00:00 UTC opens a hold that exits the following Monday 00:00 UTC.
  let d = Math.ceil(startMs / DAY) * DAY;
  for (; d + 3 * DAY <= endMs; d += DAY) {
    if (new Date(d).getUTCDay() === 5) {   // 5 = Friday
      const exit = d + 3 * DAY;            // Mon 00:00 UTC
      if (exit <= endMs) out.push({ enter: d, exit, tag: "cryptoweekend" });
    }
  }
  return out;
}

// ---- event studies -----------------------------------------------------------------------
// For each defined event, scan a market's OWN history, find every occurrence, and measure what
// happened next. The output is an honest conditional base rate — median forward return, hit
// rate, and (crucially) sample size — not a prediction. n < 8 is reported, never hidden.
function summarizeEvents(rets) {
  const v = rets.filter(Number.isFinite);
  if (!v.length) return { n: 0 };
  const s = [...v].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  return {
    n: v.length,
    med: +med.toFixed(2),
    hit: +(v.filter((x) => x > 0).length / v.length).toFixed(2),
    avg: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2),
  };
}
function retStd(rets, min) {
  const v = rets.filter(Number.isFinite);
  if (v.length < (min || 15)) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1));
}
function dailyRets(closes) {   // closes: [[t, c], ...] ascending
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1][1], b = closes[i][1];
    out.push(a > 0 && b > 0 ? (b / a - 1) * 100 : NaN);
  }
  return out;
}
// trailing-30 daily sigma ending just before index i (unit for R-normalized outcomes)
function sdAt(rets, i) { return retStd(rets.slice(Math.max(0, i - 30), i), 15); }
function fwdRet(closes, i, k) {
  if (i + k >= closes.length) return null;
  const a = closes[i][1], b = closes[i + k][1];
  return a > 0 && b > 0 ? (b / a - 1) * 100 : null;
}
// Big-move continuation: |1d return| >= 2 sigma of the trailing 30 daily returns. Forward
// returns are SIGNED IN THE DIRECTION of the move: positive = continuation, negative = fade.
function studyBigMove(closes) {
  const rets = dailyRets(closes), d1 = [], d3 = [];
  for (let i = 30; i < rets.length; i++) {
    const sd = sdAt(rets, i);
    if (sd == null || sd <= 0 || !Number.isFinite(rets[i]) || Math.abs(rets[i]) < 2 * sd) continue;
    const dir = rets[i] > 0 ? 1 : -1, ci = i + 1;   // rets[i] is the move into closes[ci]
    const f1 = fwdRet(closes, ci, 1), f3 = fwdRet(closes, ci, 3);
    if (f1 != null) d1.push(+(dir * f1 / sd).toFixed(3));   // R units: outcome / own sigma at event time
    if (f3 != null) d3.push(+(dir * f3 / sd).toFixed(3));
  }
  return { d1: summarizeEvents(d1), d3: summarizeEvents(d3), raw: { d1, d3 }, unit: "R" };
}
// 30d-high breakout: close crosses above the max of the prior 30 closes. Forward 1d / 5d.
function studyBreakout(closes) {
  const rets = dailyRets(closes), d1 = [], d5 = [];
  for (let i = 31; i < closes.length; i++) {
    let hi = -Infinity;
    for (let j = i - 30; j < i; j++) if (closes[j][1] > hi) hi = closes[j][1];
    if (!(closes[i][1] > hi) || closes[i - 1][1] > hi) continue;   // first cross only
    const sd = sdAt(rets, i - 1);
    if (sd == null || sd <= 0) continue;
    const f1 = fwdRet(closes, i, 1), f5 = fwdRet(closes, i, 5);
    if (f1 != null) d1.push(+(f1 / sd).toFixed(3));
    if (f5 != null) d5.push(+(f5 / sd).toFixed(3));
  }
  return { d1: summarizeEvents(d1), d5: summarizeEvents(d5), raw: { d1, d5 }, unit: "R" };
}
// 30d-low breakdown: close crosses below the min of the prior 30 closes — the bearish mirror
// of the breakout study. Outcomes are signed WITH the breakdown (positive = continued lower),
// matching the ledger's dir=-1 convention, so "hit" means the breakdown followed through.
function studyBreakdown(closes) {
  const rets = dailyRets(closes), d1 = [], d5 = [];
  for (let i = 31; i < closes.length; i++) {
    let lo = Infinity;
    for (let j = i - 30; j < i; j++) if (closes[j][1] < lo) lo = closes[j][1];
    if (!(closes[i][1] < lo) || closes[i - 1][1] < lo) continue;   // first cross only
    const sd = sdAt(rets, i - 1);
    if (sd == null || sd <= 0) continue;
    const f1 = fwdRet(closes, i, 1), f5 = fwdRet(closes, i, 5);
    if (f1 != null) d1.push(+(-f1 / sd).toFixed(3));
    if (f5 != null) d5.push(+(-f5 / sd).toFixed(3));
  }
  return { d1: summarizeEvents(d1), d5: summarizeEvents(d5), raw: { d1, d5 }, unit: "R" };
}
// Vol-regime shift: 10d realized vol crossing above the 90th percentile of its trailing 120
// observations. Forward 5d return (does an expansion resolve up or down for this market?).
function studyVolShift(closes) {
  const rets = dailyRets(closes), vols = [];
  for (let i = 10; i <= rets.length; i++) vols.push(retStd(rets.slice(i - 10, i), 8));
  const d5 = [];
  for (let i = 120; i < vols.length; i++) {
    const hist = vols.slice(i - 120, i).filter((x) => x != null);
    if (hist.length < 60 || vols[i] == null || vols[i - 1] == null) continue;
    const p90 = [...hist].sort((a, b) => a - b)[Math.floor(hist.length * 0.9)];
    if (!(vols[i] > p90) || vols[i - 1] > p90) continue;           // first cross only
    const ci = i + 10;                                              // vols[i] ends at closes[ci]
    const sd = sdAt(rets, ci - 1);
    if (sd == null || sd <= 0) continue;
    const f5 = fwdRet(closes, ci, 5);
    if (f5 != null) d5.push(+(f5 / sd).toFixed(3));
  }
  return { d5: summarizeEvents(d5), raw: { d5 }, unit: "R" };
}
// Gap fade/continuation: for each closed-window hold with |gap| >= 0.75 sigma of this market's
// own gap distribution, measure the NEXT cash session (open -> close), signed by gap direction:
// positive = the session continued the gap, negative = it faded it.
function studyGapFade(hourly, windows, tol) {
  const gaps = [];
  for (const a of windows) {
    const pIn = priceAsOf(hourly, a.enter, tol), pOut = priceAsOf(hourly, a.exit, tol);
    if (pIn > 0 && pOut > 0) gaps.push({ exit: a.exit, g: (pOut / pIn - 1) * 100 });
  }
  const sd = retStd(gaps.map((x) => x.g), 10);
  if (sd == null || sd <= 0) return { session: { n: 0 }, nGaps: gaps.length, sd: null };
  const dirRets = [];
  for (const gp of gaps) {
    if (Math.abs(gp.g) < 0.75 * sd) continue;
    const open = priceAsOf(hourly, gp.exit, tol);
    const close = priceAsOf(hourly, gp.exit + 6.5 * HOUR, tol);
    if (!(open > 0) || !(close > 0)) continue;
    dirRets.push((gp.g > 0 ? 1 : -1) * (close / open - 1) * 100);
  }
  return { session: summarizeEvents(dirRets), nGaps: gaps.length, sd: +sd.toFixed(3), raw: { session: dirRets } };
}
// Funding flip: the day-summed funding changes sign after >= 3 consecutive same-sign days.
// Forward 3d return signed TOWARD the new funding side (funding flips positive = longs now
// crowding in; positive result = price followed the new crowd).
function studyFundFlip(dayFunding, closes) {
  const byDay = new Map(closes.map((k, i) => [Math.floor(k[0] / DAY) * DAY, i]));
  const d3 = [];
  let run = 0, prevSign = 0;
  for (let i = 0; i < dayFunding.length; i++) {
    const s = Math.sign(dayFunding[i][1]);
    if (s !== 0 && prevSign !== 0 && s !== prevSign && run >= 3) {
      const ci = byDay.get(Math.floor(dayFunding[i][0] / DAY) * DAY);
      if (ci != null) {
        const sd = sdAt(dailyRets(closes), Math.max(0, ci - 1));
        const f3 = fwdRet(closes, ci, 3);
        if (f3 != null && sd > 0) d3.push(+(s * f3 / sd).toFixed(3));
      }
    }
    if (s === prevSign) run++; else { run = s === 0 ? run : 1; if (s !== 0) prevSign = s; }
  }
  return { d3: summarizeEvents(d3), raw: { d3 }, unit: "R" };
}

// ---- signal metadata + playbooks ----------------------------------------------------------
// Per-event resolution conventions for the live ledger: which horizon the claim covers and how
// the realized outcome is signed (identical to the study's sign convention, so claimed vs live
// records are directly comparable).
const EV_META = {
  bigmove:  { horizonMs: DAY,      horizon: "next 1d, signed with the move", studyKey: "d1" },
  breakout: { horizonMs: 5 * DAY,  horizon: "next 5d",                        studyKey: "d5" },
  volshift: { horizonMs: 5 * DAY,  horizon: "next 5d",                        studyKey: "d5" },
  gap:      { horizonMs: null,     horizon: "next cash session, signed with the gap", studyKey: "session" },  // resolveAt = next session close
  fundflip: { horizonMs: 3 * DAY,  horizon: "next 3d, toward the new crowd",  studyKey: "d3" },
  squeeze:  { horizonMs: 3 * DAY,  horizon: "next 3d",                        studyKey: null },
  breakdown:{ horizonMs: 5 * DAY,  horizon: "next 5d, signed with the breakdown", studyKey: "d5" },
  unwind:   { horizonMs: 3 * DAY,  horizon: "next 3d",                        studyKey: null },
  oiflush:  { horizonMs: 5 * DAY,  horizon: "next 5d (bottoming thesis)",     studyKey: "d5" },
  fpdiv:    { horizonMs: 3 * DAY,  horizon: "next 3d, with the divergence",   studyKey: "d3" },
  tretest:  { horizonMs: 5 * DAY,  horizon: "next 5d, with the stacked trend", studyKey: null },
  tretestdn:{ horizonMs: 5 * DAY,  horizon: "next 5d, with the stacked downtrend", studyKey: null },
  coil:     { horizonMs: null,     horizon: "context flag \u2014 expansion pending, direction unknown", studyKey: null },
  ondrift:  { horizonMs: null,     horizon: "next 5 overnight windows, held close\u2192open", studyKey: null },
  prem:     { horizonMs: 12 * HOUR, horizon: "reversion toward oracle",       studyKey: null },
  volume:   { horizonMs: null,     horizon: "context flag",                   studyKey: null },
  gapfade:  { horizonMs: null,     horizon: "next cash session, faded",       studyKey: null },  // shadow strategy — resolveAt = next session close, same calendar as gap
  reclaim:  { horizonMs: 5 * DAY,  horizon: "next 5d, off the failed breakdown", studyKey: null },  // shadow swing setup
  mapull:   { horizonMs: 10 * DAY, horizon: "next 10d, off the rising MA50",  studyKey: null },     // shadow swing setup
  failbrk:  { horizonMs: 5 * DAY,  horizon: "next 5d, fading the failed breakout", studyKey: null }, // shadow swing setup
  pead:     { horizonMs: 10 * DAY, horizon: "next 10d, drifting with the earnings reaction", studyKey: null },  // shadow swing setup (xyz)
  sweep:    { horizonMs: DAY,      horizon: "next 1d, off the swept prior-session level", studyKey: null },     // shadow 5m microstructure setup (xyz)
  wickfill: { horizonMs: 3 * DAY,  horizon: "next 3d, filling the outsized wick", studyKey: null },            // shadow swing setup (xyz)
  roundfr:  { horizonMs: 2 * DAY,  horizon: "next 2d, fading into the round figure", studyKey: null },         // shadow swing setup (xyz)
  airead:   { horizonMs: 5 * DAY,  horizon: "next 5d, the analyst report's own read", studyKey: null },  // AI analyst accountability claim
  casc:     { horizonMs: 12 * HOUR, horizon: "next 12h, off the exhausted cascade", studyKey: null },   // crypto-native ledger event
  fundext:  { horizonMs: 2 * DAY,  horizon: "next 2d, fading the crowded side",     studyKey: null },   // crypto-native ledger event
};
// ---- crypto horizon overrides ------------------------------------------------------------------
// A 5d horizon on a name printing 12%/day is a +/-27% window: the claim resolves on tape noise
// rather than on the setup, and the record measures BTC's week instead of the signal. Crypto runs
// the same events on a compressed clock. Only horizonMs/horizon differ — sign conventions, study
// keys and units are shared with EV_META by construction, so claimed-vs-live stays comparable
// within a universe (never ACROSS one: a 2d crypto breakout record and a 5d equity breakout
// record are different claims and the panels keep them apart).
const EV_META_MAIN = {
  bigmove:  { horizonMs: 12 * HOUR, horizon: "next 12h, signed with the move" },
  breakout: { horizonMs: 2 * DAY,   horizon: "next 2d" },
  breakdown:{ horizonMs: 2 * DAY,   horizon: "next 2d, signed with the breakdown" },
  volshift: { horizonMs: 2 * DAY,   horizon: "next 2d" },
  fundflip: { horizonMs: 2 * DAY,   horizon: "next 2d, toward the new crowd" },
  oiflush:  { horizonMs: 2 * DAY,   horizon: "next 2d (bottoming thesis)" },
  fpdiv:    { horizonMs: 2 * DAY,   horizon: "next 2d, with the divergence" },
  tretest:  { horizonMs: 3 * DAY,   horizon: "next 3d, with the stacked trend" },
  tretestdn:{ horizonMs: 3 * DAY,   horizon: "next 3d, with the stacked downtrend" },
  reclaim:  { horizonMs: 2 * DAY,   horizon: "next 2d, off the failed breakdown" },
  failbrk:  { horizonMs: 2 * DAY,   horizon: "next 2d, fading the failed breakout" },
  mapull:   { horizonMs: 4 * DAY,   horizon: "next 4d, off the rising MA50" },
  wickfill: { horizonMs: DAY,       horizon: "next 1d, filling the outsized wick" },
};
// Resolution meta for one (event, universe) pair. Crypto reads the override when one exists and
// falls back to the shared entry otherwise, so a new event is automatically defined for both.
function evMeta(ev, uni) {
  const base = EV_META[ev];
  if (!base) return null;
  if (uni !== "main") return base;
  const o = EV_META_MAIN[ev];
  return o ? Object.assign({}, base, o) : base;
}
// Mechanical playbook per signal: implied bias, computed target/invalidation levels from the
// market's own stats, and the one corroborating thing to watch. A description of the setup —
// explicitly NOT advice; the ledger decides which event types have earned any trust.
function playbook(ev, ctx) {
  const f2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toPrecision(6));
  // ctx.logGeo: multiplicative level geometry, set by the caller for crypto rows. When false
  // (every xyz call site) these helpers reduce to the EXACT additive arithmetic shipped before,
  // so the equity record stays byte-comparable across this build. See claimGeometryOk.
  const LG = ctx.logGeo === true;
  // signed k-sigma offset from a base level
  const offSd = (base, kSd) => {
    if (base == null || !(base > 0) || !Number.isFinite(kSd)) return null;
    const s = ctx.sd30 > 0 ? ctx.sd30 : 1;
    return LG ? logLevel(base, kSd, s) : f2(base * (1 + (kSd * s) / 100));
  };
  // signed percentage offset from a base level (study medians arrive already in %)
  const offPct = (base, kPct) => {
    if (base == null || !(base > 0) || kPct == null || !Number.isFinite(kPct)) return null;
    return LG ? f2(base * Math.exp(kPct / 100)) : f2(base * (1 + kPct / 100));
  };
  // extend `from` by k spans of the lo..hi range — log-space when LG, so a 0.382-span extension
  // below the range low lands at lo*exp(-0.382*ln(hi/lo)) instead of a negative price
  const ext = (from, k, lo, hi) => {
    if (from == null || !(from > 0) || !(lo > 0) || !(hi > lo) || !Number.isFinite(k)) return null;
    return LG ? logExtend(from, k, lo, hi) : f2(from + k * (hi - lo));
  };
  switch (ev) {
    case "bigmove": {
      const up = ctx.dir >= 0, sgn = up ? 1 : -1;
      return { side: up ? "long" : "short", bias: "continuation " + (up ? "up" : "down"),
        target: offPct(ctx.px, sgn * Math.abs(ctx.med != null ? ctx.med : 0.5)),
        stop: offSd(ctx.px, -sgn),
        watch: "volume staying elevated \u2014 a thrust on fading volume is the fade setup instead" };
    }
    case "breakout":
      return { side: "long", bias: "continuation while above the breakout level",
        target: offPct(ctx.px, Math.abs(ctx.med != null ? ctx.med : 1)),
        stop: f2(ctx.level),
        watch: "a close back below the prior 30d high = failed breakout, the signal is void" };
    case "gap": {
      const proven = ctx.n >= 8, fade = proven && ctx.med != null && ctx.med < 0;
      if (fade)
        return { side: ctx.gapDir >= 0 ? "short" : "long",
          bias: "this market historically FADES its gaps \u2014 " + (ctx.gapDir >= 0 ? "short the up-gap" : "long the down-gap") + " into the session, reversion toward the prior close",
          target: f2(ctx.closePx),
          stop: f2(ctx.px * (1 + (ctx.gapDir >= 0 ? 1 : -1) * (ctx.gapSd || 0.5) / 100)),
          watch: "whether the S&P confirms \u2014 an excess gap (beyond beta) carries the information" };
      if (proven)
        return { side: ctx.gapDir >= 0 ? "long" : "short",
          bias: "this market historically continues its gaps \u2014 ride the direction into the session",
          target: f2(ctx.px * (1 + (ctx.gapDir >= 0 ? 1 : -1) * Math.abs(ctx.med != null ? ctx.med : 0.3) / 100)),
          stop: f2(ctx.closePx),
          watch: "whether the S&P confirms \u2014 an excess gap (beyond beta) carries the information" };
      return { side: "watch", bias: "gap behavior unproven on this market \u2014 watch the open",
        target: null, stop: null,
        watch: "which way the first cash hour resolves; the pooled asset-class record is the prior until this market has its own" };
    }
    case "breakdown":
      return { side: "short", bias: "continuation while below the breakdown level",
        target: offPct(ctx.px, -Math.abs(ctx.med != null ? ctx.med : 1)),
        stop: f2(ctx.level),
        watch: "a close back above the prior 30d low = failed breakdown, the signal is void" };
    case "unwind": {
      // Bearish mirror of the squeeze: crowded LONGS paying funding + OI building + price near
      // range LOWS. Target extends BELOW the range for the same reason squeeze extends above it.
      // In log space (crypto) the extension is a ratio of the range, so it can never cross zero —
      // the additive form produced negative price targets on any name whose 30d range spans >2.6x.
      return { side: "short", bias: "unwind-biased while longs keep paying AND \u0394OI holds",
        target: ext(ctx.lo30, -0.382, ctx.lo30, ctx.hi30),
        stop: ext(ctx.hi30, -0.25, ctx.lo30, ctx.hi30),
        watch: "\u0394OI(7d) rolling negative = longs already liquidating; funding flipping negative = the crowd has left \u2014 the setup is spent" };
    }
    case "oiflush": {
      return { side: "long", bias: "capitulation \u2014 forced deleveraging exhausting into a decline",
        target: offPct(ctx.px, Math.abs(ctx.med != null ? ctx.med : 1)),
        stop: offSd(ctx.px, -1),
        watch: "\u0394OI stabilizing or turning up = the flush is complete; continued OI bleed = the knife is still falling" };
    }
    case "fpdiv": {
      const up = ctx.dir >= 0, sg = up ? 1 : -1;
      return { side: up ? "long" : "short",
        bias: up ? "price strength while funding falls \u2014 shorts pressing into a rising tape (stubborn crowd, squeeze-adjacent)"
                 : "price weakness while funding rises \u2014 longs averaging down into a falling tape (fragile crowd)",
        target: offPct(ctx.px, sg * Math.abs(ctx.med != null ? ctx.med : 0.8)),
        stop: offSd(ctx.px, -sg),
        watch: "funding re-converging with price = the divergence resolved \u2014 the setup is spent" };
    }
    case "ondrift":
      return { side: ctx.dir >= 0 ? "long" : "short",
        bias: (ctx.dir >= 0 ? "persistent positive" : "persistent negative") + " off-hours drift \u2014 the claim covers ONLY the overnight windows, held close\u2192open, not a continuous position",
        target: null, stop: null,
        watch: "the drift sign flipping in the live windows = the regime is gone; cash-session performance is irrelevant to this claim" };
    case "fundflip":
      return { side: ctx.dir >= 0 ? "long" : "short",
        bias: ctx.dir >= 0 ? "crowd flipped long \u2014 drift with them short-term" : "crowd flipped short \u2014 drift with them short-term",
        target: null,
        // 1σ against the flip direction: gives the event a stop-aware track for the first time
        // (findings ops item 3 — every prior fundflip claim resolved at-horizon only). Null when
        // the caller can't supply px/σ, preserving the legacy no-stop shape.
        stop: ctx.px != null && ctx.px > 0 && ctx.sd30 > 0
          ? offSd(ctx.px, -(ctx.dir >= 0 ? 1 : -1)) : null,
        watch: "funding flipping straight back voids it; funding STAYING flipped for 2+ days is the confirmation" };
    case "squeeze": {
      // Target is a measured-move EXTENSION above the range (hi30 + 0.382 x range), not the
      // range top: the trigger rewards price already near the high, so targeting hi30 itself
      // produced structurally inverted R/R at exactly the moments the signal fired. Squeezes
      // resolve through the range, not to it.
      return { side: "long", bias: "squeeze-biased while shorts keep paying AND \u0394OI holds",
        target: ext(ctx.hi30, 0.382, ctx.lo30, ctx.hi30),
        stop: ext(ctx.lo30, 0.25, ctx.lo30, ctx.hi30),
        watch: "\u0394OI(7d) turning negative = shorts covering, spring released \u2014 the setup is spent" };
    }
    case "prem":
      return { side: ctx.prem >= 0 ? "short" : "long",
        bias: ctx.prem >= 0 ? "perp rich \u2014 reversion toward oracle (short the perp side)" : "perp cheap \u2014 reversion toward oracle (long the perp side)",
        target: f2(ctx.oracle), stop: null,
        watch: ctx.closed ? "whether the cash open confirms the perp's level or snaps it back to the oracle" : "persistence \u2014 a dislocation that survives arb for hours is information, not noise" };
    case "casc": {
      // Cascade exhaustion (crypto). Geometry is entirely OBSERVED — the flush wick and the
      // pre-cascade level are prices the tape printed — which is precisely why this is the
      // flagship crypto event rather than a sigma construction that has to be clamped.
      const L = ctx.side === "long";
      return { side: L ? "long" : "short",
        bias: `forced ${L ? "long" : "short"} liquidation cleared positioning (OI ${ctx.doiPct != null ? ctx.doiPct.toFixed(1) + "%" : "down"} in the bucket) and the flush ${L ? "low" : "high"} has held \u2014 ${L ? "exhaustion bounce" : "squeeze exhaustion"} back toward the pre-cascade level`,
        target: f2(ctx.target), stop: f2(ctx.stop),
        watch: `a ${L ? "break of the flush low" : "push through the squeeze high"} = the cascade was continuation, not exhaustion \u2014 the claim is void` };
    }
    case "fundext": {
      // Persistent funding extreme: the crowd is maximally one-sided against its OWN 31d
      // distribution. Fade the crowd. Target is the range midpoint (an observed structure),
      // void a sigma multiple beyond the extreme the crowd is defending.
      const L = ctx.dir >= 0;   // dir = the FADE direction (crowded long -> short it, so dir<0)
      const mid = ctx.hi30 > ctx.lo30 ? Math.sqrt(ctx.hi30 * ctx.lo30) : null;   // geometric mid — scale-free
      return { side: L ? "long" : "short",
        bias: `funding at its ${ctx.pct != null ? ctx.pct + "th" : "own"} percentile of 31d \u2014 crowded ${L ? "short" : "long"}, faded toward the range middle`,
        target: mid != null && ((L && mid > ctx.px) || (!L && mid < ctx.px)) ? f2(mid) : null,
        stop: offSd(ctx.px, L ? -1.5 : 1.5),
        watch: "funding decaying back toward its median = the crowd is unwinding on its own; a percentile extreme that persists for days is the setup, one print is not" };
    }
    case "tretest": case "tretestdn": {
      // The trend board's retest, frozen into ledger geometry at fire time: entry = the mark,
      // void = the retesting rung's EMA21 (the ladder's own level — a close beyond it is the
      // board's own definition of the trend being damaged), target = the prior swing extreme of
      // that rung's series. Everything is stamped from the SAME ladder build the board rendered;
      // nothing is re-derived for the signal.
      const L = ev === "tretest";
      return { side: L ? "long" : "short",
        bias: `continuation ${L ? "up" : "down"} off the ${ctx.tf} 13/21 zone (${ctx.score}/4 stack)`,
        target: f2(ctx.swing), stop: f2(ctx.e21),
        watch: `a ${ctx.tf} close ${L ? "below" : "above"} EMA21 = trend damaged, the claim is void` };
    }
    default:
      return { side: "watch", bias: "context only", target: null, stop: null,
        watch: "pairs with whatever else is firing on this name" };
  }
}

// OI flush / capitulation: 7d ΔOI collapsing below −2σ of this market's OWN trailing ΔOI7d
// distribution while price is down over the window — forced deleveraging exhausting itself.
// Trailing stats only (no lookahead): each event's σ comes from the ≤60 samples before it,
// minimum 30. Outcomes are LONG-signed forward 5d returns in R (the bottoming thesis).
function studyOIFlush(closes, oiDaily) {
  if (!closes || !oiDaily || oiDaily.length < 45 || closes.length < 45) return null;
  const rets = dailyRets(closes);
  const oiByDay = new Map(oiDaily.map((k) => [k[0], k[1]]));
  const doi7 = [];   // [dayTs, ΔOI7d%]
  for (const [d, v] of oiDaily) {
    const prev = oiByDay.get(d - 7 * 86400000);
    if (prev > 0 && v > 0) doi7.push([d, (v / prev - 1) * 100]);
  }
  if (doi7.length < 35) return null;
  const closeByDay = new Map(closes.map((k, i) => [Math.floor(k[0] / 86400000), i]));
  const d5 = [];
  let mu = null, sd = null;
  for (let i = 30; i < doi7.length; i++) {
    const win = doi7.slice(Math.max(0, i - 60), i).map((k) => k[1]);
    mu = win.reduce((a, b) => a + b, 0) / win.length;
    sd = stdev(win);
    if (!(sd > 0)) continue;
    const z = (doi7[i][1] - mu) / sd;
    if (z > -2) continue;
    const ci = closeByDay.get(Math.floor(doi7[i][0] / 86400000));
    if (ci == null || ci < 8 || ci >= closes.length) continue;
    const px7 = (closes[ci][1] / closes[ci - 7][1] - 1) * 100;
    if (!(px7 < 0)) continue;   // flush INTO a decline — the capitulation configuration
    const s = sdAt(rets, ci - 1);
    if (s == null || s <= 0) continue;
    const f5 = fwdRet(closes, ci, 5);
    if (f5 != null) d5.push(+(f5 / s).toFixed(3));
  }
  return { d5: summarizeEvents(d5), raw: { d5 }, cur: { mu, sd }, unit: "R" };
}
// Funding–price divergence: trajectory against tape. Price pressing 7d strength while funding
// FALLS (shorts pressing into a rising tape) claims LONG; price at 7d weakness while funding
// RISES (longs averaging down into a falling tape) claims SHORT. Outcomes are claim-signed
// forward 3d returns in R. EPS is on day-summed funding (≈4% APR equivalent).
function studyFPDiv(closes, dayFunding) {
  if (!closes || closes.length < 20 || !dayFunding || dayFunding.length < 12) return null;
  const rets = dailyRets(closes), EPS = 1.2e-4;
  const fByDay = new Map(dayFunding.map((k) => [Math.floor(k[0] / 86400000), k[1]]));
  const d3 = [];
  for (let i = 10; i < closes.length; i++) {
    const day = Math.floor(closes[i][0] / 86400000);
    let f7 = 0, n7 = 0, f2 = 0, n2 = 0;
    for (let b = 1; b <= 7; b++) { const v = fByDay.get(day - b); if (v != null) { f7 += v; n7++; if (b <= 2) { f2 += v; n2++; } } }
    if (n7 < 5 || n2 < 2) continue;
    f7 /= n7; f2 /= n2;
    const s = sdAt(rets, i - 1);
    if (s == null || s <= 0) continue;
    const z7 = ((closes[i][1] / closes[i - 7][1] - 1) * 100) / (s * Math.sqrt(7));
    let dir = 0;
    if (z7 >= 0.8 && f2 < f7 - EPS) dir = 1;
    else if (z7 <= -0.8 && f2 > f7 + EPS) dir = -1;
    if (!dir) continue;
    const f3 = fwdRet(closes, i, 3);
    if (f3 != null) d3.push(+((dir * f3) / s).toFixed(3));
  }
  return { d3: summarizeEvents(d3), raw: { d3 }, unit: "R" };
}
// Range compression: 10d realized vol in its own bottom decile of the trailing 120
// observations. Direction is deliberately NOT claimed — expansion is coming, which way is not
// knowable from compression alone. Returns the live reading for the context flag.
function compressionNow(closes) {
  if (!closes || closes.length < 140) return null;
  const rets = dailyRets(closes), vols = [];
  for (let i = 10; i <= rets.length; i++) vols.push(retStd(rets.slice(i - 10, i), 8));
  const i = vols.length - 1;
  if (i < 120 || vols[i] == null) return null;
  const histW = vols.slice(i - 120, i).filter((x) => x != null);
  if (histW.length < 60) return null;
  const sorted = [...histW].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const rank = sorted.filter((x) => x <= vols[i]).length / sorted.length;
  return { vol10: vols[i], p10, pct: Math.round(rank * 100), coiled: vols[i] <= p10 };
}
// Off-hours drift stats: per-window close→open returns from the hourly spine over the given
// closed windows (overnight + weekend, each counted as ONE holdable window). The venue's
// structural quirk: these cash-hours assets trade 24/7 here, so the overnight session — where
// the equity literature puts most of the drift — is directly holdable.
function offDriftStats(hs, wins, tol) {
  if (!hs || !hs.length || !wins || !wins.length) return null;
  const rets = [];
  const sorted = [...wins].sort((a, b) => a.enter - b.enter);
  for (const w of sorted) {
    const pc = priceAsOf(hs, w.enter, tol), po = priceAsOf(hs, w.exit, tol);
    if (pc > 0 && po > 0) rets.push([w.exit, +((po / pc - 1) * 100).toFixed(4)]);
  }
  if (rets.length < 15) return null;
  const last21 = rets.slice(-21);
  const drift30 = +last21.reduce((a, k) => a + k[1], 0).toFixed(3);   // ~1 month of windows, summed
  return { drift30, nWin: last21.length, total: rets.length };
}
// Direction-aware confluence split: context events (no playbook side, or "watch") count as
// company for EITHER direction; directional events only agree with their own side. If both
// long and short directional signals fire on one coin, that is CONFLICT, not confluence —
// nobody gets an agreement bonus for being contradicted.
function confSplit(sigs) {
  let nL = 0, nS = 0, nCtx = 0;
  for (const g of sigs) {
    const sd = g.play && (g.play.side === "long" || g.play.side === "short") ? g.play.side : null;
    if (sd === "long") nL++; else if (sd === "short") nS++; else nCtx++;
  }
  const conflict = nL > 0 && nS > 0;
  const companyFor = (g) => {
    if (conflict) return 1;   // contradiction: everyone stands alone
    const sd = g.play && (g.play.side === "long" || g.play.side === "short") ? g.play.side : null;
    if (sd === "long") return nL + nCtx;
    if (sd === "short") return nS + nCtx;
    return Math.max(nL, nS) + nCtx;   // context signal: company = the directional camp it corroborates
  };
  return { conflict, companyFor };
}
// ---- stop-touch detection --------------------------------------------------------------------
// Walks hourly candles in (t0, tEnd] and reports whether the void/stop level was touched:
// a long claim (dir >= 0) is stopped when any candle LOW <= stp; a short claim when any
// candle HIGH >= stp. Hourly granularity means intra-candle ordering is unknowable, so a
// candle that touches the stop counts as stopped even if it also recovered — conservative
// by construction. Candles are [t, o, h, l, c, v].
function stopTouched(candles, t0, tEnd, dir, stp) {
  if (!Array.isArray(candles) || stp == null || !(stp > 0)) return null;
  let seen = false;
  for (const k of candles) {
    const t = k[0];
    if (t <= t0) continue;
    if (t > tEnd) break;
    seen = true;
    if (dir >= 0 ? k[3] <= stp : k[2] >= stp) return true;
  }
  return seen ? false : null;   // null = no candles in window, touch state unknowable
}

// Live level-touch test for an OPEN claim, in the same sign convention stopTouched uses at
// resolution. `bar` is an optional packed 5m candle [t,o,h,l,c,v]: the live mark alone misses a
// wick that took the level and came back between two scans, which is exactly the touch that
// matters. Returns false rather than null for missing inputs — an unknowable touch must not
// announce, and the resolver's candle-based determination remains the record either way.
//
// The geometry, not the side, decides the comparison: a stop sits on the loss side of entry and a
// target on the profit side, so for a long the stop is BELOW and the target ABOVE, and for a short
// the mirror. Keying off `side` alone is what produced the stop-aware win fabricator this codebase
// already had to repair once.
function levelHit(side, kind, level, px, bar) {
  if (!(level > 0)) return false;
  if (side !== "long" && side !== "short") return false;
  if (kind !== "stop" && kind !== "target") return false;
  const below = (side === "long") === (kind === "stop");   // long+stop and short+target sit below entry
  const lo = bar && bar.length > 3 && bar[3] > 0 ? bar[3] : null;
  const hi = bar && bar.length > 2 && bar[2] > 0 ? bar[2] : null;
  if (below) {
    if (px > 0 && px <= level) return true;
    return lo != null && lo <= level;
  }
  if (px > 0 && px >= level) return true;
  return hi != null && hi >= level;
}

// ---- swing setups (higher-timeframe, human-tradeable) --------------------------------------
// Pure detectors over the daily close series [[t, close], ...]; the poller shadow-ledgers
// fires with frozen geometry (vi=0 — invisible everywhere until the record earns promotion).
// Both are LONG structures; short mirrors can earn shadow slots later if these prove out.
//
// 50d-MA pullback: the classic swing entry. MA50 rising (vs 5 sessions ago), price pulled
// back from >=4% above the MA within the last 10 closes to now sit AT it (+1%/-0.5% band —
// touching, not breaking), stop 1σ(30d) below the MA, target the prior 30d closing high.
// Null unless every leg holds and the geometry is tradeable (stop < px < target).
function detectMAPull(closes, px, sd30) {
  if (!Array.isArray(closes) || closes.length < 60 || !(px > 0) || !(sd30 > 0)) return null;
  const c = closes.map((k) => +k[1]);   // COERCE: string closes reach here on some feed paths; NaN math fails closed (null), never throws
  const ma = (end, n) => { let s = 0; for (let i = end - n; i < end; i++) s += c[i]; return s / n; };
  const m0 = ma(c.length, 50), m5 = ma(c.length - 5, 50);
  if (!(m0 > 0) || !(m0 > m5)) return null;                            // trend filter: MA50 rising
  let hi10 = -Infinity;
  for (let i = c.length - 10; i < c.length; i++) if (c[i] > hi10) hi10 = c[i];
  if (!(hi10 >= m0 * 1.04)) return null;                               // there was something to pull back FROM
  if (!(px <= m0 * 1.01 && px >= m0 * 0.995)) return null;             // at the MA, not through it
  let hi30 = -Infinity;
  for (let i = c.length - 30; i < c.length; i++) if (c[i] > hi30) hi30 = c[i];
  const stop = m0 * (1 - sd30 / 100), target = hi30;
  if (!(stop > 0 && stop < px && target > px)) return null;
  return { ma: +m0.toPrecision(6), stop: +stop.toPrecision(6), target: +target.toPrecision(6) };
}
// Failed-breakdown reclaim: the direct out-of-sample test of the findings' failed-break
// structure. The prior 30d closing low (measured EXCLUDING the last 3 sessions) was broken
// by at least one of those 3 closes, the break is fresh (one of the last TWO closes still
// below), and the mark is back above the level — the trap sprung and reversed. Stop = the
// flush low, target = level + 1x(level - flush): the measured move of the trap.
function detectReclaim(closes, px) {
  if (!Array.isArray(closes) || closes.length < 40 || !(px > 0)) return null;
  const c = closes.map((k) => +k[1]);   // COERCE — see detectMAPull
  let lo = Infinity;
  for (let i = c.length - 33; i < c.length - 3; i++) if (c[i] < lo) lo = c[i];
  if (!Number.isFinite(lo) || !(lo > 0)) return null;
  const flush = Math.min(c[c.length - 3], c[c.length - 2], c[c.length - 1]);
  if (!(flush < lo)) return null;                                      // the break actually happened
  if (!(c[c.length - 1] < lo || c[c.length - 2] < lo)) return null;    // and it is fresh, not an old wound
  if (!(px > lo)) return null;                                         // and the mark has reclaimed the level
  const stop = flush, target = lo + (lo - flush);
  if (!(stop < px && target > px)) return null;
  return { level: +lo.toPrecision(6), stop: +stop.toPrecision(6), target: +target.toPrecision(6) };
}
// Failed-breakout fade: the short mirror of the reclaim, and the direct test of finding F2
// (breakout continuation ran -0.73R / 39% hit — breaks in this tape fail). Prior 30d closing
// HIGH (excluding the last 3 sessions) was broken by at least one of those closes, the break
// is fresh (one of the last two still above), and the mark is back BELOW the level. Stop =
// the flush high, target = level - 1x(flush - level): the same measured-move trap, inverted.
function detectFailBrk(closes, px) {
  if (!Array.isArray(closes) || closes.length < 40 || !(px > 0)) return null;
  const c = closes.map((k) => +k[1]);   // COERCE — see detectMAPull (the -79 production outage: hi.toPrecision on a string close)
  let hi = -Infinity;
  for (let i = c.length - 33; i < c.length - 3; i++) if (c[i] > hi) hi = c[i];
  if (!Number.isFinite(hi) || !(hi > 0)) return null;
  const flush = Math.max(c[c.length - 3], c[c.length - 2], c[c.length - 1]);
  if (!(flush > hi)) return null;                                      // the break actually happened
  if (!(c[c.length - 1] > hi || c[c.length - 2] > hi)) return null;    // and it is fresh
  if (!(px < hi)) return null;                                         // and the mark has lost the level
  const stop = flush, target = hi - (flush - hi);
  if (!(stop > px && target < px) || !(target > 0)) return null;
  return { level: +hi.toPrecision(6), stop: +stop.toPrecision(6), target: +target.toPrecision(6) };
}
// Post-earnings drift (xyz only): a reaction bigger than 1.5x the name's own daily σ tends to
// keep drifting its own way for weeks — entered AFTER the reaction session is complete (there
// is at least one bar past the reaction index), within 3 sessions of it, drifting WITH the
// move. Same print->reaction-index convention as earnReactionsFor (AMC books the next bar).
// Stop = 1σ back through the reaction close against the drift; target = half the reaction
// magnitude further, from the mark — drift scales with the surprise, mechanically.
function detectPead(prints, daily, px, sd30) {
  if (!Array.isArray(prints) || !prints.length || !Array.isArray(daily) || daily.length < 25) return null;
  if (!(px > 0) || !(sd30 > 0)) return null;
  const dayOf = (t) => { const x = new Date(t); return x.getUTCFullYear() + "-" + String(x.getUTCMonth() + 1).padStart(2, "0") + "-" + String(x.getUTCDate()).padStart(2, "0"); };
  const idxByDay = new Map();
  for (let i = 0; i < daily.length; i++) if (daily[i] && Number.isFinite(daily[i].c)) idxByDay.set(dayOf(daily[i].t), i);
  let best = null;
  for (const pr of prints) {
    const pi = idxByDay.get(pr.d);
    if (pi == null) continue;
    const ri = pr.s === "AMC" ? pi + 1 : pi;
    if (ri <= 0 || ri >= daily.length - 1) continue;      // reaction session must be COMPLETE
    if (ri < daily.length - 4) continue;                   // and fresh: within 3 sessions of now
    if (!best || ri > best.ri) best = { pr, ri };
  }
  if (!best) return null;
  const c1 = best.ri < daily.length ? daily[best.ri].c : null, c0 = daily[best.ri - 1].c;
  if (!Number.isFinite(c1) || !Number.isFinite(c0) || !(c0 > 0)) return null;
  const mv = (c1 - c0) / c0 * 100;
  if (!(Math.abs(mv) >= 1.5 * sd30)) return null;          // the reaction has to be a REACTION
  const up = mv > 0, sgn = up ? 1 : -1;
  const stop = c1 * (1 - sgn * sd30 / 100), target = px * (1 + sgn * Math.abs(mv) / 200);
  if (up ? !(stop < px && target > px) : !(stop > px && target < px && target > 0)) return null;
  return { side: up ? "long" : "short", mv: +mv.toFixed(2), d: best.pr.d,
    stop: +stop.toPrecision(6), target: +target.toPrecision(6) };
}

// ---- intraday liquidity sweep (5m microstructure) ------------------------------------------
// The failed-break reclaim, fired one timeframe down: a 5m wick pierces the prior completed
// session's high or low and is REJECTED inside the same bar (close back on the origin side),
// no later bar has closed through (the reclaim still holds), and the mark sits back on the
// origin side — a stop-run that trapped the breakout and reversed. Frozen geometry mirrors
// detectReclaim / detectFailBrk EXACTLY (void = the sweep extreme, target = level + 1x the
// trap depth), so it plugs into the same stop-aware resolver with no new outcome path. Pure
// over 5m candles [t, o, h, l, c, v] ascending. Both sides are checked; only the more recent
// sweep fires when both qualify. This is a shadow (vi=0 at the fire site) — it earns its record
// out of sample before any promotion, like every setup here.
//   m5   : recent CLOSED 5m bars, oldest -> newest (the tail — a few hours)
//   dayHi/dayLo : the prior completed session's high / low (the swept levels)
//   px   : current mark
//   frac : min pierce past the level, as a multiple of the window's median 5m range (default 0.25)
function detectSweep(m5, dayHi, dayLo, px, frac) {
  if (!Array.isArray(m5) || m5.length < 12 || !(px > 0)) return null;
  const f = frac > 0 ? frac : 0.25;
  const H = m5.map((k) => +k[2]), L = m5.map((k) => +k[3]), C = m5.map((k) => +k[4]);   // COERCE — sqlite can hand back strings; NaN math fails closed (null), never throws
  const ranges = [];
  for (let i = 0; i < m5.length; i++) { const d = H[i] - L[i]; if (Number.isFinite(d) && d >= 0) ranges.push(d); }
  if (ranges.length < 12) return null;
  const med = median(ranges);
  if (!(med > 0)) return null;
  const minDepth = f * med, n = m5.length;
  // newest -> oldest scan for the most recent qualifying sweep. low=true: a swept LOW (long side).
  const findSweep = (level, low) => {
    if (!(level > 0)) return null;
    for (let i = n - 1; i >= 0; i--) {
      if (!Number.isFinite(H[i]) || !Number.isFinite(L[i]) || !Number.isFinite(C[i])) continue;
      if (low) {
        if (!(L[i] < level) || !((level - L[i]) >= minDepth) || !(C[i] >= level)) continue;   // pierced, genuinely, and rejected within the bar
        let held = true; for (let j = i + 1; j < n; j++) if (C[j] < level) { held = false; break; }   // reclaim never broke again
        if (held) return { extreme: L[i], idx: i };
      } else {
        if (!(H[i] > level) || !((H[i] - level) >= minDepth) || !(C[i] <= level)) continue;
        let held = true; for (let j = i + 1; j < n; j++) if (C[j] > level) { held = false; break; }
        if (held) return { extreme: H[i], idx: i };
      }
    }
    return null;
  };
  const loS = px > dayLo ? findSweep(dayLo, true) : null;    // mark currently back above the swept low
  const hiS = px < dayHi ? findSweep(dayHi, false) : null;   // or back below the swept high
  let side = null, level = null, ex = null;
  if (loS && (!hiS || loS.idx >= hiS.idx)) { side = "long"; level = dayLo; ex = loS.extreme; }
  else if (hiS) { side = "short"; level = dayHi; ex = hiS.extreme; }
  if (!side) return null;
  const stop = ex, target = side === "long" ? level + (level - ex) : level - (ex - level);
  if (side === "long" ? !(stop < px && target > px) : !(stop > px && target < px && target > 0)) return null;
  return { side, level: +level.toPrecision(6), stop: +stop.toPrecision(6), target: +target.toPrecision(6) };
}

// ---- large-wick fill (daily) ------------------------------------------------------------------
// Yesterday printed an outsized bar dominated by one wick: a violent probe that was rejected back
// inside. The fill thesis: price returns INTO that wick (to its midpoint) within a few sessions —
// the classic magnet left by a rejected extreme. Frozen geometry: entry = current mark, target =
// the wick's midpoint, void = the wick bar's opposite extreme (a close through it means the
// rejection side won outright and the fill thesis is dead). Ships as a SHADOW earning its record
// out of sample; parameters fixed at launch. Pure over CLOSED daily bars {t,o,h,l,c} ascending
// (the spine-derived buckets — always full OHLC, never the warm-cache closes-only shape).
//   frac    : min wick share of the bar's range (default 0.55)
//   sizeMult: min bar range vs the trailing-30 median range (default 1.1 — a real bar, not noise)
function detectWickFill(daily, px, opts) {
  const o = opts || {};
  const frac = o.frac > 0 ? o.frac : 0.55, sizeMult = o.sizeMult > 0 ? o.sizeMult : 1.1;
  if (!Array.isArray(daily) || daily.length < 31 || !(px > 0)) return null;
  const B = daily[daily.length - 1];
  const bo = +B.o, bh = +B.h, bl = +B.l, bc = +B.c;   // COERCE — string fields fail closed
  if (![bo, bh, bl, bc].every((x) => Number.isFinite(x) && x > 0) || !(bh > bl)) return null;
  const ranges = [];
  for (let i = daily.length - 31; i < daily.length - 1; i++) {
    const d = +daily[i].h - +daily[i].l;
    if (Number.isFinite(d) && d > 0) ranges.push(d);
  }
  if (ranges.length < 20) return null;
  const range = bh - bl;
  if (!(range >= sizeMult * median(ranges))) return null;
  const bodyHi = Math.max(bo, bc), bodyLo = Math.min(bo, bc);
  const upW = bh - bodyHi, dnW = bodyLo - bl;
  let side = null, target = null, stop = null, wickPct = null;
  if (upW / range >= frac && upW > 1.5 * dnW) {          // dominant UPPER wick -> fill = long back into it
    target = (bodyHi + bh) / 2; stop = bl; side = "long"; wickPct = upW / range;
    if (!(px < target) || !(px > stop)) return null;     // fill already done, or thesis already dead
  } else if (dnW / range >= frac && dnW > 1.5 * upW) {   // dominant LOWER wick -> fill = short back into it
    target = (bodyLo + bl) / 2; stop = bh; side = "short"; wickPct = dnW / range;
    if (!(px > target) || !(px < stop)) return null;
  } else return null;
  return { side, stop: +stop.toPrecision(6), target: +target.toPrecision(6),
    wickPct: +wickPct.toFixed(3), barT: +B.t || 0 };
}

// ---- round-number front-run -------------------------------------------------------------------
// Price grinding toward a round number tends to stall just before it: resting orders cluster AT
// the figure, so the front-run fades the approach with invalidation just THROUGH the figure.
// roundStep picks the psychologically dominant grid for a price's magnitude — the largest of
// {10^k, 10^k/2, 10^k/10} whose step is <= 12% of price — deterministic and testable.
function roundStep(px) {
  if (!(px > 0)) return null;
  const p10 = Math.pow(10, Math.floor(Math.log10(px)));
  for (const g of [p10, p10 / 2, p10 / 10]) if (g / px <= 0.12) return g;
  return p10 / 10;
}
// Both sides checked: an advance into the round ABOVE fades short; a decline into the round BELOW
// fades long. When both somehow qualify, the nearer level wins. Freshness is closes-only by
// construction (the input is [t, c] tuples): a level is "fresh" when no close in the trailing 20
// bars sat beyond it — a wick-touch does not consume freshness here, and that limitation is
// accepted rather than papered over with data the tuples don't carry. Frozen geometry: void just
// through the figure (0.25σ past, floored at 0.1%), target = a 0.75σ retrace of the approach.
//   closes: [[t, c], ...] ascending (the same input the other swing shadows consume)
function detectRoundFront(closes, px, sd30, opts) {
  const o = opts || {};
  const loB = o.loBand > 0 ? o.loBand : 0.05, hiB = o.hiBand > 0 ? o.hiBand : 0.6;   // approach band, x sd30
  if (!Array.isArray(closes) || closes.length < 26 || !(px > 0) || !(sd30 > 0)) return null;
  const g = roundStep(px);
  if (!(g > 0)) return null;
  const c = closes.map((k) => +k[1]);
  const n = c.length;
  if (!Number.isFinite(c[n - 1]) || !Number.isFinite(c[n - 6])) return null;
  const thruPct = Math.max(0.25 * sd30, 0.1);            // invalidation depth past the figure, in %
  const cand = [];
  const RU = Math.ceil(px / g - 1e-9) * g;               // nearest round above
  if (RU > px) {
    const dist = (RU / px - 1) * 100;
    if (dist >= loB * sd30 && dist <= hiB * sd30 && c[n - 1] > c[n - 6]) {   // advancing INTO it
      let fresh = true;
      for (let i = Math.max(0, n - 21); i < n; i++) if (c[i] >= RU) { fresh = false; break; }
      if (fresh) cand.push({ side: "short", lvl: RU, dist,
        stop: RU * (1 + thruPct / 100), target: px * (1 - 0.75 * sd30 / 100) });
    }
  }
  const RD = Math.floor(px / g + 1e-9) * g;              // nearest round below
  if (RD > 0 && RD < px) {
    const dist = (1 - RD / px) * 100;
    if (dist >= loB * sd30 && dist <= hiB * sd30 && c[n - 1] < c[n - 6]) {   // declining INTO it
      let fresh = true;
      for (let i = Math.max(0, n - 21); i < n; i++) if (c[i] <= RD) { fresh = false; break; }
      if (fresh) cand.push({ side: "long", lvl: RD, dist,
        stop: RD * (1 - thruPct / 100), target: px * (1 + 0.75 * sd30 / 100) });
    }
  }
  if (!cand.length) return null;
  cand.sort((a, b) => a.dist - b.dist);
  const w = cand[0];
  return { side: w.side, lvl: +w.lvl.toPrecision(9), stop: +w.stop.toPrecision(6),
    target: +w.target.toPrecision(6), distPct: +w.dist.toFixed(3) };
}

// ---- structural levels: confirmed pivots, clustered by the name's own volatility ------------
// The AI analyst's void level has to sit on a price the tape actually respected. Until this
// existed the prompt asked for "prior swings implied by the data" while the context shipped no
// swing data at all — an unfulfillable instruction whose only real constraint was a +-40/60%
// sanity band, so a plausible round number passed and every figure computed off it (risk unit,
// per-scenario R, EV) inherited a soft input dressed as a hard one.
//
// Three legs, all pure:
//   1. CONFIRMED fractal pivots. Bar i is a pivot high when its high strictly exceeds every high
//      in [i-k, i+k]; pivot low mirrors on lows. k bars are required on EACH side, so the last k
//      bars produce nothing — an unconfirmed pivot is a guess, and removing guesses is the whole
//      point of the function. Strict comparison means a flat double-top yields no pivot:
//      conservative by construction, same posture as stopTouched.
//   2. Cluster at tau = max(tauMult * sd30, 0.5%), scaled to the name's own daily volatility. A
//      fixed percent over-merges a quiet name and shatters a volatile one.
//   3. Classify from cluster membership: all highs = "res", all lows = "sup", both = "flip" — a
//      level that capped price and later floored it (or the reverse). The flip falls out for
//      free and carries the most information of the three.
// A cluster ships only at minN members: one untested pivot is a data point, not a level.
// Warm-cache daily rows can arrive closes-only; h/l fall back to the close rather than throwing,
// degrading the detector to close-based pivots instead of taking it offline. Honest null when
// the history is too short to confirm anything — callers stand their rules down, never fabricate.
//   daily : ascending daily rows {t, o, h, l, c} (r.dailyRaw shape)
//   px    : current mark
//   sd30  : stdev of the last 30 daily % returns (0/absent -> the 0.5% tau floor applies)
function detectLevels(daily, px, sd30, opts) {
  const o = opts || {};
  const k = Number.isFinite(o.k) && o.k >= 1 ? Math.round(o.k) : 3;
  const tauMult = Number.isFinite(o.tauMult) && o.tauMult > 0 ? o.tauMult : 0.4;
  const minN = Number.isFinite(o.minN) && o.minN >= 1 ? Math.round(o.minN) : 2;
  const maxOut = Number.isFinite(o.max) && o.max >= 1 ? Math.round(o.max) : 8;
  const minBars = Number.isFinite(o.minBars) ? o.minBars : 60;
  if (!Array.isArray(daily) || !(px > 0)) return null;
  const b = [];
  for (const d of daily) {
    if (!d) continue;
    const c = +d.c;                                        // COERCE: string closes reach here on some feed paths
    if (!Number.isFinite(c) || !(c > 0)) continue;
    const hr = +d.h, lr = +d.l;
    const h = Number.isFinite(hr) && hr > 0 ? hr : c, l = Number.isFinite(lr) && lr > 0 ? lr : c;
    b.push({ h: Math.max(h, c), l: Math.min(l, c) });      // a bar whose close sits outside its own range is bad data, not a pivot
  }
  if (b.length < minBars || b.length < 2 * k + 1) return null;
  const piv = [];
  for (let i = k; i < b.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k && (isH || isL); j++) {
      if (j === i) continue;
      if (b[j].h >= b[i].h) isH = false;
      if (b[j].l <= b[i].l) isL = false;
    }
    if (isH) piv.push({ i, v: b[i].h, t: "h" });
    if (isL) piv.push({ i, v: b[i].l, t: "l" });
  }
  if (!piv.length) return null;
  const tauPct = Math.max(sd30 > 0 ? tauMult * sd30 : 0, 0.5), tau = tauPct / 100;
  piv.sort((a, z) => a.v - z.v);
  const cl = [];
  for (const p of piv) {
    const last = cl.length ? cl[cl.length - 1] : null;
    // Chain against the RUNNING mean, not the seed member: a level's price is the average of the
    // touches that define it, and comparing to the seed lets a long chain drift past tau.
    if (last && last.ref > 0 && Math.abs(p.v / last.ref - 1) <= tau) {
      last.mem.push(p);
      last.ref = last.mem.reduce((s, x) => s + x.v, 0) / last.mem.length;
    } else cl.push({ ref: p.v, mem: [p] });
  }
  const lastI = b.length - 1, out = [];
  for (const c of cl) {
    if (c.mem.length < minN) continue;
    const hs = c.mem.filter((m) => m.t === "h").length;
    let li = -1; for (const m of c.mem) if (m.i > li) li = m.i;
    out.push({ v: +c.ref.toPrecision(9), n: c.mem.length,
      side: hs > 0 && hs < c.mem.length ? "flip" : (hs > 0 ? "res" : "sup"),
      ageD: lastI - li, distPct: +((c.ref / px - 1) * 100).toFixed(2) });
  }
  if (!out.length) return null;
  // Keep the NEAREST maxOut (the levels a void could plausibly sit on), then present high -> low.
  out.sort((a, z) => Math.abs(a.distPct) - Math.abs(z.distPct));
  const keep = out.slice(0, maxOut).sort((a, z) => z.v - a.v);
  return { k, tauPct: +tauPct.toFixed(3), minN, n: keep.length, items: keep };
}

// ---- structural-level outcome study (pure) ---------------------------------------------------
// detectLevels ALREADY decides which levels this app draws and which levels an AI void is allowed
// to snap to (AI_SNAP_TOL). Nothing has ever measured whether those levels do anything. This walks
// the daily tape, re-detects levels from the PREFIX ONLY at a fixed stride, and watches each level
// forward over a fixed horizon — so every observation is out of sample with respect to the bars
// that produced it. Two questions, both of which the snap rule silently bets on:
//   1. does a detected level get TOUCHED more often than distance alone implies?
//   2. once touched, does it HOLD (close rejected back to the origin side) or break?
// The second is the one that matters for a void: a void on a level that breaks 70% of the time is
// not an invalidation point, it is a stop-loss donation.
//
// Standard normal CDF (Abramowitz & Stegun 7.1.26). Needed for the random-walk touch baseline;
// hand-rolled because the zero-dependency rule applies here as everywhere else.
function normCdf(z) {
  if (!Number.isFinite(z)) return null;
  const s = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + s * erf);
}
// P(a driftless walk of per-bar sd 1 touches a level d sd away within h bars) = 2(1 - phi(d/sqrt(h))).
// This is the null the study is measured against: a level 0.2 sd out gets touched constantly and
// that is geometry, not structure.
function touchBaseline(distSd, horizon) {
  if (!(distSd >= 0) || !(horizon > 0)) return null;
  const p = 2 * (1 - normCdf(distSd / Math.sqrt(horizon)));
  return +Math.max(0, Math.min(1, p)).toFixed(4);
}
// Normalize daily bars to {h,l,c} exactly the way detectLevels does, so the study can never see a
// bar shape the detector wouldn't. Closes-only bars degrade to h=l=c (no intrabar reach) rather
// than being dropped — the same honest-null posture as the OHLC upgrade path.
function studyBars(daily) {
  const b = [];
  if (!Array.isArray(daily)) return b;
  for (const d of daily) {
    if (!d) continue;
    const c = +d.c;
    if (!Number.isFinite(c) || !(c > 0)) continue;
    const hr = +d.h, lr = +d.l;
    const h = Number.isFinite(hr) && hr > 0 ? hr : c, l = Number.isFinite(lr) && lr > 0 ? lr : c;
    b.push({ t: +d.t || 0, h: Math.max(h, c), l: Math.min(l, c), c });
  }
  return b;
}
// One ticker's event list. Every event is frozen at DETECTION time (distance, touch count, side,
// age) and resolved only from bars strictly after it — the same discipline the ledger uses, which
// is what makes the aggregate quotable rather than a curve fit.
//   daily : [{t,h,l,c}, ...] ascending
//   sd30  : this name's own 30d daily-return sd, in percent (the detector's tolerance scale)
//   opts  : { k, tauMult, minN, max, minBars, stride, horizon } — detector opts pass through
//           UNCHANGED so the study measures the shipping configuration, not a tuned variant
function levelOutcomes(daily, sd30, opts) {
  const o = opts || {};
  const stride = Number.isFinite(o.stride) && o.stride >= 1 ? Math.round(o.stride) : 5;
  const horizon = Number.isFinite(o.horizon) && o.horizon >= 1 ? Math.round(o.horizon) : 10;
  const minBars = Number.isFinite(o.minBars) ? o.minBars : 60;
  const b = studyBars(daily);
  if (b.length < minBars + horizon + 1 || !(sd30 > 0)) return { n: 0, events: [], horizon, stride };
  const dOpts = { k: o.k, tauMult: o.tauMult, minN: o.minN, max: o.max, minBars };
  const events = [];
  for (let i = minBars; i < b.length - horizon; i += stride) {
    const px = b[i].c;
    if (!(px > 0)) continue;
    // Detector sees the prefix ONLY. Rebuilding the slice each stride is the honest cost of not
    // letting a single future bar leak into the levels being scored.
    const lv = detectLevels(b.slice(0, i + 1), px, sd30, dOpts);
    if (!lv || !lv.items.length) continue;
    const tau = Math.max(lv.tauPct, 0.1) / 100;
    for (const it of lv.items) {
      const L = it.v;
      if (!(L > 0)) continue;
      const rel = L / px - 1;
      if (Math.abs(rel) <= tau) continue;                 // already at the level: no distance to travel, nothing to measure
      const above = rel > 0;
      const distSd = +(Math.abs(rel) * 100 / sd30).toFixed(3);
      const ev = { t: b[i].t, v: L, side: it.side, nTouch: it.n, ageD: it.ageD,
        above, distSd, touched: false, bars: null, held: null, beyondSd: null,
        plTouch: null, plHeld: null };
      for (let j = i + 1; j <= i + horizon; j++) {
        if (!(b[j].l <= L && L <= b[j].h)) continue;      // bracketing bar = the touch; closes-only bars touch only by closing exactly through
        ev.touched = true;
        ev.bars = j - i;
        // Held = the touch bar closed back on the side price came FROM. Broke = closed through.
        ev.held = above ? b[j].c < L : b[j].c > L;
        // How far past the level price reached before the horizon ran out — a void placed here
        // would have been run by exactly this much.
        let beyond = 0;
        for (let m = j; m <= i + horizon; m++) {
          const past = above ? b[m].h - L : L - b[m].l;
          if (past > beyond) beyond = past;
        }
        ev.beyondSd = +(beyond / L * 100 / sd30).toFixed(3);
        break;
      }
      // ---- permutation control -------------------------------------------------------------
      // A level's touch rate cannot be compared to the continuous first-passage formula
      // 2(1-phi(d/sqrt(h))): that assumes price is monitored continuously, while a touch here
      // requires a BAR to bracket the level. A gappy tape jumps over levels without bracketing
      // them, so the analytic null is biased high and would report "levels repel price" on pure
      // noise. The control instead carries the SAME relative distance to OTHER detection points'
      // marks and resolves it in THEIR forward windows through this identical loop — so the
      // discreteness, the intrabar range and the return distribution all cancel, and what is
      // left is the only thing we wanted to measure: does being a detected level add anything?
      // Offsets are deterministic (no PRNG) so the payload is reproducible and testable.
      let plN = 0, plHit = 0, plHeld = 0;
      for (let m = 1; m <= PLACEBO_K; m++) {
        const j = i + m * PLACEBO_STEP * stride;
        const jj = minBars + ((j - minBars) % Math.max(1, b.length - horizon - minBars));
        if (jj === i || !(b[jj].c > 0)) continue;
        const Lp = b[jj].c * (1 + rel);                  // same signed distance, different anchor
        if (!(Lp > 0)) continue;
        plN++;
        for (let q = jj + 1; q <= jj + horizon && q < b.length; q++) {
          if (!(b[q].l <= Lp && Lp <= b[q].h)) continue;
          plHit++;
          if (above ? b[q].c < Lp : b[q].c > Lp) plHeld++;
          break;
        }
      }
      if (plN) {
        ev.plTouch = +(plHit / plN).toFixed(4);
        ev.plHeld = plHit ? +(plHeld / plHit).toFixed(4) : null;
      }
      events.push(ev);
    }
  }
  return { n: events.length, events, horizon, stride };
}
// Aggregate one or many tickers' event lists into the served payload. Distance buckets are fixed
// so the x-axis means the same thing on every scope, and every cell carries its own n — a bucket
// under the floor reports null rather than a rate computed on four observations.
// Distance edges in units of the name's own DAILY sd. Calibrated to where detectLevels output
// actually lands: the nearest-8 structural levels on a name with sd30 ~2% commonly sit 2-8 sd
// out, so the intraday 0.25-2 sd scale used for open-relative studies would leave every
// bucket empty. Anything past the last edge falls into `far`.
const LVL_EDGES = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];
// Permutation control: K placebo anchors per real level, walked STEP*stride bars apart so the
// control windows do not overlap the real one. Deterministic by construction.
const PLACEBO_K = 24, PLACEBO_STEP = 3;
function levelStudy(events, opts) {
  const o = opts || {};
  const horizon = Number.isFinite(o.horizon) && o.horizon >= 1 ? Math.round(o.horizon) : 10;
  const floor = Number.isFinite(o.cellFloor) ? o.cellFloor : 20;
  const ev = (Array.isArray(events) ? events : []).filter((e) => e && Number.isFinite(e.distSd));
  const rate = (a) => (a.length >= floor ? +(a.filter(Boolean).length / a.length).toFixed(4) : null);
  // The null for a SET of levels is the mean of each level's own touch probability, not the
  // probability at the set's mean distance. Jensen makes those differ badly whenever the set mixes
  // distances (every bySide / byTouches group does), which would show excess where there is none.
  const cell = (rows) => {
    const touched = rows.filter((e) => e.touched);
    const bs = rows.map((e) => e.plTouch).filter(Number.isFinite);
    const base = bs.length ? +(bs.reduce((a, x) => a + x, 0) / bs.length).toFixed(4) : null;
    const tr = rate(rows.map((e) => e.touched));
    const broke = touched.filter((e) => e.held === false).map((e) => e.beyondSd).filter(Number.isFinite);
    const mb = broke.length >= floor ? median(broke) : null;
    return { n: rows.length, nTouched: touched.length,
      touchRate: tr, baseline: base,
      excess: tr != null && base != null ? +(tr - base).toFixed(4) : null,
      holdRate: rate(touched.map((e) => e.held)),
      holdBaseline: (() => { const a = touched.map((e) => e.plHeld).filter(Number.isFinite);
        return a.length >= floor ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(4) : null; })(),
      medBeyondSd: mb == null ? null : +mb.toFixed(3) };
  };
  const buckets = [];
  for (let i = 0; i < LVL_EDGES.length; i++) {
    const lo = i ? LVL_EDGES[i - 1] : 0, hi = LVL_EDGES[i];
    const rows = ev.filter((e) => e.distSd > lo && e.distSd <= hi);
    buckets.push(Object.assign({ lo, hi, mid: +((lo + hi) / 2).toFixed(3) }, cell(rows)));
  }
  const far = ev.filter((e) => e.distSd > LVL_EDGES[LVL_EDGES.length - 1]);
  const bySide = {};
  for (const s of ["res", "sup", "flip"]) {
    const rows = ev.filter((e) => e.side === s);
    if (rows.length) bySide[s] = cell(rows);
  }
  // The knob that matters: detectLevels ships AI_LEVEL_MINN = 2. If a 2-touch level holds no
  // better than chance and a 4-touch level does, that constant is wrong and this is the evidence.
  const byTouches = {};
  for (const [key, pred] of [["2", (e) => e.nTouch === 2], ["3", (e) => e.nTouch === 3], ["4+", (e) => e.nTouch >= 4]]) {
    const rows = ev.filter(pred);
    if (rows.length) byTouches[key] = cell(rows);
  }
  const allTouched = ev.filter((e) => e.touched);
  return { n: ev.length, horizon, cellFloor: floor,
    buckets, far: far.length ? Object.assign({ lo: LVL_EDGES[LVL_EDGES.length - 1] }, cell(far)) : null,
    bySide, byTouches,
    overall: (() => {   // the summary row carries its own controls, same construction as any cell
      const bs = ev.map((e) => e.plTouch).filter(Number.isFinite);
      const hb = allTouched.map((e) => e.plHeld).filter(Number.isFinite);
      const tr = rate(ev.map((e) => e.touched));
      const base = bs.length ? +(bs.reduce((a, x) => a + x, 0) / bs.length).toFixed(4) : null;
      return { nTouched: allTouched.length, touchRate: tr, baseline: base,
        excess: tr != null && base != null ? +(tr - base).toFixed(4) : null,
        holdRate: rate(allTouched.map((e) => e.held)),
        holdBaseline: hb.length >= floor ? +(hb.reduce((a, x) => a + x, 0) / hb.length).toFixed(4) : null };
    })() };
}

// ---- session anatomy (pure) ------------------------------------------------------------------
// Per-UTC-day session records off the hourly spine, powering four descriptive studies in one pass:
// excursion from the open (the denominator that makes any level's touch rate readable), where the
// open sat in the day's eventual range, Monday's range as a weekly container, and open revisits
// ("naked opens"). DESCRIPTIVE base rates, not signals: openQ in particular conditions on the
// realized range, so its splits are readable only after the fact — the UI says so. Nothing here
// fires a ledger event.
const DAY_MS = 86400 * 1000;
//
// sessionRecords: packed hourly [t,o,h,l,c,v] ascending -> one record per COMPLETE UTC day.
//   minBars (default 20) filters spine-gap days; the current (forming) UTC day is always excluded.
//   Raw fields only — sd-normalization happens in anatomyEnrich so the freeze is testable alone.
function sessionRecords(hourly, opts) {
  const o = opts || {};
  const minBars = Number.isFinite(o.minBars) ? o.minBars : 20;
  const nowDay = Math.floor((Number.isFinite(o.now) ? o.now : Date.now()) / DAY_MS) * DAY_MS;
  if (!Array.isArray(hourly) || hourly.length < minBars) return [];
  const byDay = new Map();
  for (const k of hourly) {
    const t = +k[0];
    if (!Number.isFinite(t)) continue;
    const d = Math.floor(t / DAY_MS) * DAY_MS;
    if (d >= nowDay) continue;                               // forming day: partial extremes, non-final close
    let a = byDay.get(d); if (!a) byDay.set(d, a = []);
    a.push(k);
  }
  const out = [];
  for (const [d, bars] of [...byDay.entries()].sort((x, y) => x[0] - y[0])) {
    if (bars.length < minBars) continue;                     // spine-gap day — a partial session is not a session
    bars.sort((x, y) => x[0] - y[0]);
    const op = +bars[0][1], cl = +bars[bars.length - 1][4];
    if (!(op > 0) || !(cl > 0)) continue;
    let hi = -Infinity, lo = Infinity, hiI = 0, loI = 0;
    for (let i = 0; i < bars.length; i++) {
      const h = +bars[i][2], l = +bars[i][3];
      if (Number.isFinite(h) && h > hi) { hi = h; hiI = i; }
      if (Number.isFinite(l) && l < lo) { lo = l; loI = i; }
    }
    if (!(hi > 0) || !(lo > 0) || !(hi >= lo)) continue;
    const rng = hi - lo;
    // openQ: which quarter of the day's EVENTUAL range the open landed in (1 = lowest). A
    // zero-range day has no quarters — openQ null, excluded from the split downstream.
    const openQ = rng > 0 ? Math.min(4, 1 + Math.floor((op - lo) / rng * 4)) : null;
    out.push({ t: d, o: op, h: hi, l: lo, c: cl, bars: bars.length,
      mfeUpPct: +((hi - op) / op * 100).toFixed(4),
      mfeDnPct: +((op - lo) / op * 100).toFixed(4),
      rangePct: +(rng / op * 100).toFixed(4),
      openQ, closedAbove: cl > op,
      firstHrExt: hiI === 0 || loI === 0,                    // an extreme printed in the session's first spine hour
      hiHr: new Date(+bars[hiI][0]).getUTCHours(),           // UTC hour that printed the high / low — the
      loHr: new Date(+bars[loI][0]).getUTCHours() });        // time-based-pivots study reads these
  }
  return out;
}
// anatomyEnrich: stamp each record with the trailing daily-return sd FROZEN before its own session
// (returns up to the PRIOR close only — the same no-lookahead discipline as sdAt), then express the
// excursions in that unit. Records before the sd warms up carry sdPrev null and are excluded from
// every sd-denominated stat — never silently rescaled.
function anatomyEnrich(records) {
  const rets = [];
  for (let i = 1; i < records.length; i++) {
    const a = records[i - 1].c, b = records[i].c;
    rets.push(a > 0 && b > 0 ? (b / a - 1) * 100 : NaN);
  }
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const sd = retStd(rets.slice(Math.max(0, i - 31), Math.max(0, i - 1)), 15);   // window ends at r[i-1]'s return: strictly pre-session
    r.sdPrev = sd != null ? +sd.toFixed(4) : null;
    r.mfeUpSd = sd > 0 ? +(r.mfeUpPct / sd).toFixed(3) : null;
    r.mfeDnSd = sd > 0 ? +(r.mfeDnPct / sd).toFixed(3) : null;
    r.rangeSd = sd > 0 ? +(r.rangePct / sd).toFixed(3) : null;
  }
  return records;
}
// mondayStats: ISO-week events for one ticker. Monday's [low, high] as the container; the rest of
// the week (Tue..Sun on a 24/7 book) either stays inside or breaks. With daily granularity a
// session that pierces BOTH sides cannot be ordered intraday — that is a "both" event, counted
// separately rather than guessed.
function mondayStats(records) {
  const byWeek = new Map();
  for (const r of records) {
    const dow = new Date(r.t).getUTCDay();                   // 0 Sun .. 6 Sat
    const wk = r.t - (dow === 0 ? 6 : dow - 1) * DAY_MS;     // Monday-anchored week key
    let w = byWeek.get(wk); if (!w) byWeek.set(wk, w = {});
    w[dow] = r;
  }
  const events = [];
  for (const [wk, w] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
    const mon = w[1];
    if (!mon) continue;
    const rest = [2, 3, 4, 5, 6, 0].map((d) => w[d]).filter(Boolean);
    if (rest.length < 3) continue;                           // a week the spine barely covers proves nothing
    let brokeDir = null, daysTo = null;
    for (let i = 0; i < rest.length; i++) {
      const up = rest[i].h > mon.h, dn = rest[i].l < mon.l;
      if (!up && !dn) continue;
      brokeDir = up && dn ? "both" : (up ? "up" : "down");
      daysTo = i + 1;
      break;
    }
    events.push({ wk, contained: brokeDir == null, dir: brokeDir, daysTo, rest: rest.length });
  }
  return events;
}
// nakedStats: for each session's OPEN, was it traded back through within the next H sessions?
// Anchors without full forward coverage at a horizon are excluded from that horizon (honest
// truncation, never a survivorship-flavored partial count).
const NAKED_HORIZONS = [1, 3, 5, 10];
function nakedStats(records) {
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const O = records[i].o;
    if (!(O > 0)) continue;
    const ev = { t: records[i].t, rev: {} };
    for (const H of NAKED_HORIZONS) {
      if (i + H >= records.length) { ev.rev[H] = null; continue; }
      let hit = false;
      for (let j = i + 1; j <= i + H; j++) if (records[j].l <= O && O <= records[j].h) { hit = true; break; }
      ev.rev[H] = hit;
    }
    out.push(ev);
  }
  return out;
}
// anatomyPool: the served aggregate. One tape day moves every name at once, so ticker-sessions are
// not independent — every rate is a cross-sectional mean per day (>= minCross names) averaged
// across days, and the published n is the DAY count. The MFE histogram is pooled ticker-sessions
// (a shape, not a rate) with both counts disclosed.
const MFE_EDGES = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5];
function anatomyPool(perTicker, opts) {
  const o = opts || {};
  const minCross = Number.isFinite(o.minCross) ? o.minCross : 3;
  const q4 = (x) => +x.toFixed(4);
  const dayMean = (cells) => {   // cells: Map day -> number[] ; -> { rate, nDays }
    let s = 0, n = 0;
    for (const a of cells.values()) if (a.length >= minCross) { s += a.reduce((p, v) => p + v, 0) / a.length; n++; }
    return n ? { rate: q4(s / n), nDays: n } : { rate: null, nDays: n };
  };
  const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, a = []); a.push(v); };
  const upShare = new Array(MFE_EDGES.length + 1).fill(0), dnShare = new Array(MFE_EDGES.length + 1).fill(0);
  const upAll = [], dnAll = [];
  const qCells = [1, 2, 3, 4].map(() => ({ ca: new Map(), fh: new Map(), rg: new Map(), nTS: 0 }));
  const mondayByWk = new Map(), nakedByDay = NAKED_HORIZONS.map(() => new Map());
  let tickerSessions = 0; const daySet = new Set(); let sdSessions = 0;
  for (const tk of perTicker) {
    for (const r of tk.records) {
      tickerSessions++; daySet.add(r.t);
      if (r.mfeUpSd != null) {
        sdSessions++;
        upAll.push(r.mfeUpSd); dnAll.push(r.mfeDnSd);
        const bi = (v) => { let i = 0; while (i < MFE_EDGES.length && v > MFE_EDGES[i]) i++; return i; };
        upShare[bi(r.mfeUpSd)]++; dnShare[bi(r.mfeDnSd)]++;
      }
      if (r.openQ != null) {
        const c = qCells[r.openQ - 1]; c.nTS++;
        push(c.ca, r.t, r.closedAbove ? 1 : 0);
        push(c.fh, r.t, r.firstHrExt ? 1 : 0);
        if (r.rangeSd != null) push(c.rg, r.t, r.rangeSd);
      }
    }
    for (const e of tk.monday) push(mondayByWk, e.wk, e);
    for (const e of tk.naked) NAKED_HORIZONS.forEach((H, i) => { if (e.rev[H] != null) push(nakedByDay[i], e.t, e.rev[H] ? 1 : 0); });
  }
  const quartiles = qCells.map((c, i) => {
    const ca = dayMean(c.ca), fh = dayMean(c.fh);
    const dm = []; for (const a of c.rg.values()) if (a.length >= minCross) dm.push(a.reduce((p, v) => p + v, 0) / a.length);
    return { q: i + 1, closedAbove: ca.rate, firstHr: fh.rate, nDays: ca.nDays, nTS: c.nTS,
      medRangeSd: dm.length ? +median(dm).toFixed(3) : null };
  });
  let wContained = 0, wN = 0; const dirTot = { up: 0, down: 0, both: 0 }; const daysToAll = [];
  for (const evs of mondayByWk.values()) {
    if (evs.length < minCross) continue;
    wN++;
    wContained += evs.filter((e) => e.contained).length / evs.length;
    for (const e of evs) { if (e.dir) dirTot[e.dir]++; if (e.daysTo != null) daysToAll.push(e.daysTo); }
  }
  const dirN = dirTot.up + dirTot.down + dirTot.both;
  const naked = { horizons: NAKED_HORIZONS,
    revisit: nakedByDay.map((m) => dayMean(m).rate),
    nDays: nakedByDay.map((m) => dayMean(m).nDays) };
  const shareOf = (a, tot) => a.map((x) => (tot ? q4(x / tot) : 0));
  return {
    tickers: perTicker.length, tickerSessions, days: daySet.size, sdSessions,
    mfe: { edges: MFE_EDGES, upShare: shareOf(upShare, sdSessions), dnShare: shareOf(dnShare, sdSessions),
      medUpSd: upAll.length ? +median(upAll).toFixed(3) : null,
      medDnSd: dnAll.length ? +median(dnAll).toFixed(3) : null, n: sdSessions },
    quartiles,
    monday: { weeks: wN, contained: wN ? q4(wContained / wN) : null,
      breakUp: dirN ? q4(dirTot.up / dirN) : null, breakDown: dirN ? q4(dirTot.down / dirN) : null,
      breakBoth: dirN ? q4(dirTot.both / dirN) : null,
      medDaysToBreak: daysToAll.length ? median(daysToAll) : null, nBreaks: dirN },
    naked };
}

// ---- candle behaviour (pure) -----------------------------------------------------------------
// Daily-bar conditionals: classify each closed session's candle, then measure the NEXT session.
// Mutually exclusive priority (outside > inside > doji > strong close > plain) so every bar lands
// in exactly one bucket and the frequencies mean something. Follow-through is SIGNED with the
// type's own thesis (a strong bear close followed by more downside scores positive), in the next
// session's own pre-frozen sd — descriptive base rates, not signals.
const CANDLE_TYPES = ["outside", "inside", "doji", "strongBull", "strongBear", "plain"];
function candleType(r, prev) {
  const rng = r.h - r.l;
  if (!(rng > 0)) return null;
  if (prev && r.h > prev.h && r.l < prev.l) return "outside";
  if (prev && r.h < prev.h && r.l > prev.l) return "inside";
  const body = Math.abs(r.c - r.o);
  if (body <= 0.2 * rng) return "doji";
  if (r.c > r.o && (r.c - r.l) / rng >= 0.8) return "strongBull";
  if (r.c < r.o && (r.h - r.c) / rng >= 0.8) return "strongBear";
  return "plain";
}
// One ticker's typed events: [{t, type, follow, rngSd}] where follow = next-session close-to-close
// in next-session sd, signed with the type (bull types +up, bear types +down, neutral types raw).
function candleEvents(records) {
  const out = [];
  for (let i = 0; i < records.length - 1; i++) {
    const r = records[i], nx = records[i + 1];
    const ty = candleType(r, i ? records[i - 1] : null);
    if (!ty || !(r.c > 0) || !(nx.c > 0) || nx.sdPrev == null || !(nx.sdPrev > 0)) continue;
    const retR = (nx.c / r.c - 1) * 100 / nx.sdPrev;
    const follow = ty === "strongBear" ? -retR : retR;     // signed with the thesis; neutral types stay raw
    out.push({ t: r.t, type: ty, follow: +follow.toFixed(3),
      rngSd: nx.rangeSd != null ? nx.rangeSd : null });
  }
  return out;
}
// Day-pooled aggregate across tickers: per type, frequency share, mean signed follow-through, and
// next-session range vs the unconditional median (expansion factor). Same minCross day-cell floor
// as every anatomy rate; n published as days.
function candlePool(perTicker, opts) {
  const o = opts || {};
  const minCross = Number.isFinite(o.minCross) ? o.minCross : 3;
  const byType = {}; for (const t of CANDLE_TYPES) byType[t] = { fol: new Map(), rng: new Map(), nTS: 0 };
  const allRng = [];
  const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, a = []); a.push(v); };
  let total = 0;
  for (const tk of perTicker) for (const e of tk.candles) {
    total++;
    const c = byType[e.type]; c.nTS++;
    push(c.fol, e.t, e.follow);
    if (e.rngSd != null) { push(c.rng, e.t, e.rngSd); allRng.push(e.rngSd); }
  }
  const baseRng = allRng.length ? median(allRng) : null;
  const dayMean = (cells) => {
    let sm = 0, n = 0;
    for (const a of cells.values()) if (a.length >= minCross) { sm += a.reduce((p, v) => p + v, 0) / a.length; n++; }
    return n ? { v: +(sm / n).toFixed(3), nDays: n } : { v: null, nDays: 0 };
  };
  const types = CANDLE_TYPES.map((t) => {
    const c = byType[t], f = dayMean(c.fol);
    const dm = []; for (const a of c.rng.values()) if (a.length >= minCross) dm.push(a.reduce((p, v) => p + v, 0) / a.length);
    const mr = dm.length ? median(dm) : null;
    return { type: t, share: total ? +(c.nTS / total).toFixed(4) : null, nTS: c.nTS,
      follow: f.v, nDays: f.nDays,
      rngX: mr != null && baseRng > 0 ? +(mr / baseRng).toFixed(3) : null };
  });
  return { n: total, types, baseRngSd: baseRng != null ? +baseRng.toFixed(3) : null };
}

// ---- time-based pivots (pure) ----------------------------------------------------------------
// WHEN does the day's extreme print? Per day, the cross-section of names yields a distribution
// over 24 UTC hours for the high and for the low; pooled = the mean of those daily distributions
// (each day one observation, so one violent tape day cannot own the histogram). Conditionals:
// an extreme printed in the first 4 UTC hours and the close's side of the open — the "early low,
// trend day up" folklore, measured instead of assumed.
const PIVOT_EARLY_H = 4;
function pivotPool(perTicker, opts) {
  const o = opts || {};
  const minCross = Number.isFinite(o.minCross) ? o.minCross : 3;
  const hiByDay = new Map(), loByDay = new Map();
  const elCells = new Map(), ehCells = new Map();            // early-low -> closedAbove, early-high -> closed BELOW
  const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, a = []); a.push(v); };
  for (const tk of perTicker) for (const r of tk.records) {
    if (r.hiHr == null || r.loHr == null) continue;
    push(hiByDay, r.t, r.hiHr); push(loByDay, r.t, r.loHr);
    if (r.loHr < PIVOT_EARLY_H) push(elCells, r.t, r.closedAbove ? 1 : 0);
    if (r.hiHr < PIVOT_EARLY_H) push(ehCells, r.t, r.closedAbove ? 0 : 1);
  }
  const hist = (m) => {
    const acc = new Array(24).fill(0); let n = 0;
    for (const hrs of m.values()) {
      if (hrs.length < minCross) continue;
      const d = new Array(24).fill(0);
      for (const h of hrs) d[h] += 1 / hrs.length;
      for (let i = 0; i < 24; i++) acc[i] += d[i];
      n++;
    }
    return { share: acc.map((x) => n ? +(x / n).toFixed(4) : 0), nDays: n };
  };
  const rate = (m) => {
    let sm = 0, n = 0;
    for (const a of m.values()) if (a.length >= minCross) { sm += a.reduce((p, v) => p + v, 0) / a.length; n++; }
    return { rate: n ? +(sm / n).toFixed(4) : null, nDays: n };
  };
  return { hi: hist(hiByDay), lo: hist(loByDay), earlyH: PIVOT_EARLY_H,
    earlyLowUp: rate(elCells), earlyHighDown: rate(ehCells) };
}

// ---- per-ticker summaries (pure) -------------------------------------------------------------
// The scope-selector payloads. Per-name rates are WITHIN-NAME TIME SERIES (each session one
// observation — no cross-day pooling exists for one name); the client labels them as such. The
// same floors apply: a cell under minN publishes null, never a rate on a handful of sessions.
function anatomyTickerSummary(records, monday, naked, candles, opts) {
  const o = opts || {};
  const minN = Number.isFinite(o.minN) ? o.minN : 20;
  const q3 = (x) => x == null ? null : +(+x).toFixed(3);
  const rate = (arr) => arr.length >= minN ? +(arr.filter(Boolean).length / arr.length).toFixed(4) : null;
  const up = records.map((r) => r.mfeUpSd).filter((x) => x != null);
  const dn = records.map((r) => r.mfeDnSd).filter((x) => x != null);
  const upP = records.map((r) => r.mfeUpPct).filter(Number.isFinite);
  const dnP = records.map((r) => r.mfeDnPct).filter(Number.isFinite);
  const quart = [1, 2, 3, 4].map((q) => {
    const rows = records.filter((r) => r.openQ === q);
    return { q, n: rows.length,
      closedAbove: rate(rows.map((r) => r.closedAbove)),
      firstHr: rate(rows.map((r) => r.firstHrExt)) };
  });
  const mw = monday.filter((e) => e.dir !== undefined);
  const contained = mw.length >= 8 ? +(mw.filter((e) => e.contained).length / mw.length).toFixed(4) : null;
  const rev = {}; for (const H of NAKED_HORIZONS) {
    const a = naked.map((e) => e.rev[H]).filter((x) => x != null);
    rev[H] = rate(a.map(Boolean).map((_, i) => a[i]));
  }
  // Per-name candle table cells: share of the name's own typed bars, next-range vs the name's
  // OWN unconditional median (same construction as candlePool, one name's basis) — follow already
  // floors at minN, rngX inherits the same floor so a thin type publishes — not a guess.
  const allRng = candles.map((e) => e.rngSd).filter((x) => x != null);
  const baseRng = allRng.length >= minN ? median(allRng) : null;
  const types = {}; for (const t of CANDLE_TYPES) {
    const evs = candles.filter((e) => e.type === t);
    const fol = evs.map((e) => e.follow);
    const rg = evs.map((e) => e.rngSd).filter((x) => x != null);
    types[t] = { n: evs.length,
      share: candles.length ? +(evs.length / candles.length).toFixed(4) : null,
      follow: fol.length >= minN ? +(fol.reduce((a, b) => a + b, 0) / fol.length).toFixed(3) : null,
      rngX: (rg.length >= minN && baseRng > 0) ? +(median(rg) / baseRng).toFixed(3) : null };
  }
  // Per-name MFE histogram: SAME edges and binning as anatomyPool so the client chart renders
  // either payload unchanged. Published only at >= minN sd-scored sessions — under the floor the
  // client keeps the pooled histogram and says so, never a thin per-name chart passed off as one.
  let mfeHist = null;
  if (up.length >= minN) {
    const us = new Array(MFE_EDGES.length + 1).fill(0), ds = new Array(MFE_EDGES.length + 1).fill(0);
    const bi = (v) => { let i = 0; while (i < MFE_EDGES.length && v > MFE_EDGES[i]) i++; return i; };
    for (const v of up) us[bi(v)]++;
    for (const v of dn) ds[bi(v)]++;
    mfeHist = { edges: MFE_EDGES, n: up.length,
      upShare: us.map((x) => +(x / up.length).toFixed(4)),
      dnShare: ds.map((x) => +(x / dn.length).toFixed(4)) };
  }
  // Per-name time pivots: WITHIN-NAME time series — each session one observation, so nDays here
  // is the session count and the client labels the basis switch. Same field names as pivotPool so
  // the histogram renderer takes either. Conditional rates floor at minN qualifying sessions.
  const pvRec = records.filter((r) => r.hiHr != null && r.loHr != null);
  let pivots = null;
  if (pvRec.length >= minN) {
    const hs = new Array(24).fill(0), ls = new Array(24).fill(0);
    for (const r of pvRec) { hs[r.hiHr]++; ls[r.loHr]++; }
    const el2 = pvRec.filter((r) => r.loHr < PIVOT_EARLY_H).map((r) => (r.closedAbove ? 1 : 0));
    const eh = pvRec.filter((r) => r.hiHr < PIVOT_EARLY_H).map((r) => (r.closedAbove ? 0 : 1));
    const rt = (a) => ({ rate: a.length >= minN ? +(a.reduce((p, v) => p + v, 0) / a.length).toFixed(4) : null, nDays: a.length });
    pivots = { hi: { share: hs.map((x) => +(x / pvRec.length).toFixed(4)), nDays: pvRec.length },
      lo: { share: ls.map((x) => +(x / pvRec.length).toFixed(4)), nDays: pvRec.length },
      earlyH: PIVOT_EARLY_H, earlyLowUp: rt(el2), earlyHighDown: rt(eh) };
  }
  return { sessions: records.length, sdSessions: up.length,
    mfe: { medUpSd: up.length >= minN ? q3(median(up)) : null, medDnSd: dn.length >= minN ? q3(median(dn)) : null,
      medUpPct: upP.length >= minN ? q3(median(upP)) : null, medDnPct: dnP.length >= minN ? q3(median(dnP)) : null },
    mfeHist, pivots,
    quartiles: quart, monday: { weeks: mw.length, contained }, naked: { horizons: NAKED_HORIZONS, revisit: rev },
    candles: types };
}

// ---- served-index cache busting (pure) -----------------------------------------------------
// Stamps ?v=<build> on the two client asset tags so browsers refetch exactly when the build
// changes and never otherwise. The -84 lesson: with bare asset tags, a deploy updates the
// server while browsers silently keep running last week's client — the API served 281
// headlines into a page that had no News tab to render them. Two versions of the truth.
function bustAssetTags(html, v) {
  const q = "?v=" + encodeURIComponent(String(v == null ? "" : v));
  return String(html)
    .replace('href="/styles.css"', 'href="/styles.css' + q + '"')
    .replace('src="/app.js"', 'src="/app.js' + q + '"');
}

// ---- ticker-in-text matchers (pure) --------------------------------------------------------
// Two signals, ranked by intent. A cashtag ($AAPL) is an explicit "I mean the ticker" — trusted
// anywhere, for any symbol. A bare word-boundaried symbol (AAPL) is weaker: in ALL-CAPS wire copy
// every word is capitalised, so the case carries no signal and a symbol that is also an ordinary
// word ("Iran war has COST…", "WILL BE HITTING…") collides. The confirmation gate (newsRelevant,
// where the intended T is already known) trusts the bare word; the discovery gate (newsAttributes,
// which scans arbitrary text against all 84 names to FIND one) does not — see decision B below.
function symEsc(T) { return T.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function hasCashtag(txtUp, T) { return new RegExp("\\$" + symEsc(T) + "($|[^A-Za-z0-9])").test(txtUp); }
function symbolWord(txtUp, T) { return new RegExp("(^|[^A-Za-z0-9])" + symEsc(T) + "($|[^A-Za-z0-9])").test(txtUp); }
function aliasHit(txtLo, aliases) {
  if (!Array.isArray(aliases)) return false;
  for (const a of aliases) if (a && txtLo.includes(String(a).toLowerCase())) return true;
  return false;
}

// Tickers that are also ordinary English words: a bare all-caps occurrence is far more likely
// prose than a ticker, so the discovery gate refuses to ATTRIBUTE on it — the cashtag or the
// company name is required instead. Curated high-frequency words plus every current word-collision
// in the xyz roster (BE, COST, ON, ALL, ARE, SO, NOW, LOW, KEY, CAT, FAST, WELL, DOW, IT, …).
// Distinctive symbols that merely happen to be uncommon words (ARM, SNAP, META) are deliberately
// LEFT OUT so they keep bare-matching. 2-letter symbols are gated wholesale by length, below.
const COMMON_WORD = new Set([
  "THE","AND","FOR","ARE","BUT","NOT","YOU","ALL","ANY","CAN","HAD","HER","WAS","ONE","OUR","OUT",
  "DAY","GET","HAS","HIM","HIS","HOW","MAN","NEW","NOW","OLD","SEE","TWO","WAY","WHO","BOY","DID",
  "ITS","LET","PUT","SAY","SHE","TOO","USE","WILL","WITH","THIS","THAT","THEY","THEM","THEN","THAN",
  "WHEN","WHAT","WHOM","WERE","BEEN","HAVE","FROM","INTO","OVER","UPON","SOON","JUST","ONLY","LAST",
  "NEXT","MOST","MORE","MANY","MUCH","LESS","VERY","GOOD","BEST","HIGH","DOWN","BOTH","EACH","SUCH",
  "SOME","LIKE","LOOK","COME","CAME","MAKE","MADE","GOES","GONE","TAKE","TOOK","KNOW","WANT","NEED",
  "GIVE","KEEP","HELP","CALL","TELL","TOLD","YEAR","WEEK","TIME","LIFE","HAND","PART","SIDE","CASE",
  "FACT","AREA","AREAS","PLAN","DEAL","RATE","RISK","GAIN","LOSS","JOBS","DATA","CASH","DEBT","BOND",
  "FUND","BANK","RATES","WARS","WAR","COST","COSTS","LOW","LOWS","HIGHS","WELL","FAST","SLOW","KEY",
  "CAT","DOG","BIG","TOP","WIN","WON","BUY","PAY","CUT","RAW","HOT","RED","BULL","BEAR","DOW","OFF",
  "ONTO","EVIL","VERY","AREA","LEAD","LEADS","SOON","MOVE","RISE","FALL","DROP","JUMP","EDGE","PACE",
  "EACH","ELSE","EVEN","EVER","GROW","HOPE","OPEN","REAL","SAME","SEEN","STOP","SURE","TRUE","WIDE",
]);

// ---- news relevance gate (pure) — CONFIRMATION lane ----------------------------------------
// Finnhub's company-news returns articles that merely MENTION or are loosely "related to" the
// queried symbol — a Meta story arrives under AMZN's query, market listicles arrive under
// whoever's rotation fetched them. The intended ticker T is KNOWN here (the article was fetched
// under it), so this only confirms the text plausibly concerns T: a cashtag, the symbol as a
// standalone word (2+ chars — a 1-char symbol like F matches everything), or any alias substring.
// Everything else is NOT dropped — it goes to the AI relevance verdict, and until verified it
// lives in the unfiltered tape lane, never the universe feed.
function newsRelevant(headline, summary, ticker, aliases) {
  const T = String(ticker || "").toUpperCase();
  const txt = String(headline || "") + " " + String(summary || "");
  const up = txt.toUpperCase();
  if (T.length >= 2 && (hasCashtag(up, T) || symbolWord(up, T))) return true;
  return aliasHit(txt.toLowerCase(), aliases);
}

// ---- news attribution gate (pure) — DISCOVERY lane ----------------------------------------
// Inverted from newsRelevant: T is NOT known — arbitrary text is scanned against the whole roster
// to find the name it's about. A bare word-boundaried symbol is too weak to attribute on here,
// because it's exactly how "war has COST…" wears Costco and "WILL BE HITTING…" wears Bloom Energy.
// Decision B: a bare symbol attributes ONLY when it can't be read as prose — 3+ chars AND not a
// common word. Everything shorter, and every word-collision, needs the explicit signal instead: a
// $CASHTAG or the company name. Nothing is lost — a miss stays in the tape lane, never a wrong badge.
function newsAttributes(headline, ticker, aliases) {
  const T = String(ticker || "").toUpperCase();
  if (!T) return false;
  const txt = String(headline || "");
  const up = txt.toUpperCase();
  if (T.length >= 2 && hasCashtag(up, T)) return true;              // $BE / $COST — explicit intent, always
  if (aliasHit(txt.toLowerCase(), aliases)) return true;           // the company name in the text — unambiguous
  if (T.length >= 3 && !COMMON_WORD.has(T) && symbolWord(up, T)) return true;   // distinctive bare symbol only
  return false;
}

// ---- news feed merge (pure) ----------------------------------------------------------------
// Dedupe by article id (incoming wins — sources correct headlines), evict on PUBLISH time,
// never fetch time (a late fetch earns no bonus lifetime), reject future-dated garbage, cap
// per ticker and in total, newest first. `tk` = the company ticker a headline belongs to,
// null = the general macro tape, which gets a wider lane than any single name.
const NEWS_TTL_MS = 72 * HOUR, NEWS_PER_TK = 10, NEWS_CAP = 1200;
const FILINGS_TTL_MS = 7 * 24 * HOUR, FILINGS_PER_TK = 10;   // a Tuesday 10-Q is still worth seeing Friday
function mergeNews(existing, incoming, nowMs) {
  const cutOf = (a) => nowMs - (a && a.fl ? FILINGS_TTL_MS : NEWS_TTL_MS);   // filings: 7d; everything else: 72h
  const byId = new Map();
  for (const a of (existing || [])) if (a && a.id != null && a.pub > cutOf(a)) byId.set(String(a.id), a);
  for (const a of (incoming || [])) {
    if (!a || a.id == null || !a.h || !Number.isFinite(a.pub)) continue;
    if (a.pub > nowMs + HOUR || a.pub <= cutOf(a)) continue;
    byId.set(String(a.id), a);
  }
  const all = [...byId.values()].sort((x, y) => y.pub - x.pub);
  const perTk = new Map(), out = [];
  for (const a of all) {
    // filings ride their own per-ticker lane: a filing burst can't evict the name's headlines,
    // headlines can't evict its filings
    const k = a.fl ? "fl:" + (a.tk || "?") : (a.tk || (a.tg ? "~tg" : "~tape"));
    const n = perTk.get(k) || 0;
    const cap = a.fl ? FILINGS_PER_TK : (a.tk ? NEWS_PER_TK : (a.tg ? NEWS_PER_TK * 8 : NEWS_PER_TK * 6));
    if (n >= cap) continue;
    perTk.set(k, n + 1);
    out.push(a);
    if (out.length >= NEWS_CAP) break;
  }
  return out;
}

// ---- SEC EDGAR per-company Atom parser (pure) ----------------------------------------------
// browse-edgar's getcompany feed: <entry> with <title>FORM - description</title>, <updated>,
// a link to the filing index, an accession number in the id/summary, and (for 8-Ks) the item
// list in the summary. Zero dependencies, same posture as the telegram parser. Materiality
// and ownership classes are stamped here so every consumer agrees on what "material" means.
const SEC_MATERIAL = new Set(["8-K", "8-K/A", "10-K", "10-K/A", "10-Q", "10-Q/A", "S-1", "S-1/A", "S-3", "S-3/A", "SC 13D", "SC 13D/A", "6-K", "20-F", "DEF 14A", "425"]);
const SEC_OWNERSHIP = new Set(["3", "3/A", "4", "4/A", "5", "5/A", "144", "SC 13G", "SC 13G/A"]);
function parseEdgarAtom(xml, ticker, nowMs) {
  const items = [];
  if (typeof xml !== "string" || !xml) return { items, entries: 0 };
  const entries = xml.split("<entry>").slice(1);
  const deent = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
  for (const e of entries) {
    const title = e.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const upd = e.match(/<updated>([^<]+)<\/updated>/);
    const link = e.match(/<link[^>]*href="([^"]+)"/);
    const acc = e.match(/accession[^:>]*[:>][^0-9]*([0-9]{10}-[0-9]{2}-[0-9]{6})/i) || e.match(/([0-9]{10}-[0-9]{2}-[0-9]{6})/);
    if (!title || !upd || !acc) continue;
    const pub = Date.parse(upd[1]);
    if (!Number.isFinite(pub)) continue;
    const tRaw = deent(title[1]).trim();
    const dash = tRaw.indexOf(" - ");
    const form = (dash > 0 ? tRaw.slice(0, dash) : tRaw).trim();
    let desc = dash > 0 ? tRaw.slice(dash + 3).trim() : "";
    const sum = e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
    if (sum) {
      const its = [...deent(sum[1]).matchAll(/Item\s+[0-9]+\.[0-9]+[^<\n.]*(?:\.[^<\n]*)?/g)].map((m) => m[0].replace(/\s+/g, " ").trim());
      if (its.length) desc = its.slice(0, 4).join(" \u00b7 ");
    }
    items.push({ id: "sec:" + acc[1], tk: String(ticker).toUpperCase(), fl: 1, form,
      h: (desc || form).slice(0, 220), src: "EDGAR", url: link ? link[1] : null, pub,
      mat: SEC_MATERIAL.has(form) ? 1 : undefined, own: SEC_OWNERSHIP.has(form) ? 1 : undefined });
  }
  return { items, entries: entries.length };
}

// ---- telegram public-channel preview parser (pure) -----------------------------------------
// t.me/s/<channel> is plain HTML: message blocks carry data-post="channel/<id>", a
// tgme_widget_message_text div, and a <time datetime="...">. Zero dependencies — regex over
// the block markup, tags stripped, basic entities decoded. Returns {items, blocks} so the
// caller can tell "page fetched but nothing parsed" (markup drift — warn) apart from an
// empty channel. Sticker/media-only posts have no text div and are skipped by construction.
function parseTgPreview(html, channel, nowMs) {
  const items = [];
  if (typeof html !== "string" || !html) return { items, blocks: 0 };
  const blocks = html.split('class="tgme_widget_message_wrap').slice(1);
  const deent = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#0?36;/g, "$").replace(/&nbsp;/g, " ");
  const want = String(channel || "").toLowerCase();
  for (const b of blocks) {
    const post = b.match(/data-post="([A-Za-z0-9_]+)\/(\d+)"/);
    if (!post) continue;
    // Channel-identity gate: only accept posts belonging to the channel we ASKED for. A typo'd
    // username can land on a redirect, a suggestion page, or a different real channel — and
    // without this check its posts flood the feed under a name nobody configured.
    if (post[1].toLowerCase() !== want) continue;
    const tm = b.match(/<time[^>]*datetime="([^"]+)"/);
    const pub = tm ? Date.parse(tm[1]) : NaN;
    if (!Number.isFinite(pub)) continue;
    const tx = b.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    if (!tx) continue;   // media-only post — nothing to feed
    const h = deent(tx[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim().slice(0, 220);
    if (!h) continue;
    items.push({ id: "tg:" + post[1] + ":" + post[2], tk: null, h,
      src: "t.me/" + post[1], url: "https://t.me/" + post[1] + "/" + post[2], pub, tg: 1 });
  }
  return { items, blocks: blocks.length };
}

// ---- telegram ticker attribution (pure) ----------------------------------------------------
// Posts aren't fetched "under" a ticker, so attribution runs inverted: scan the text against the
// whole universe roster through the DISCOVERY gate (newsAttributes — a bare common-word symbol is
// not enough; needs a cashtag or the company name). EXACTLY ONE name matching -> attributed; zero
// or several -> tape. Conservative by construction: a post naming five tickers pollutes none, and
// "Iran war has cost…" / "WILL BE HITTING…" no longer wear Costco / Bloom Energy.
function attributeTg(h, rosterMap) {
  let hit = null, count = 0;
  for (const [T, aliases] of rosterMap) {
    if (newsAttributes(h, T, aliases)) { count++; if (count > 1) return null; hit = T; }
  }
  return count === 1 ? hit : null;
}

// ---- earnings <-> filings join (pure) ------------------------------------------------------
// Once a company reports, the actual release exists in the filings store: the 8-K carrying
// Item 2.02 IS the earnings release, the 10-Q/10-K is the report. Each earnings entry gets
// its best filing within a window around the report date — preference: 8-K with Item 2.02,
// then the quarterly/annual report, then any 8-K; latest wins inside a tier. Upcoming entries
// naturally get nothing until the filing lands: the link APPEARS when it's live.
function linkEarningsFilings(entries, filings, nowMs) {
  if (!Array.isArray(entries) || !entries.length || !Array.isArray(filings) || !filings.length) return entries || [];
  const fl = filings.filter((a) => a && a.fl && a.tk && Number.isFinite(a.pub) && a.url);
  if (!fl.length) return entries;
  const byTk = new Map();
  for (const a of fl) { const T = String(a.tk).toUpperCase(); if (!byTk.has(T)) byTk.set(T, []); byTk.get(T).push(a); }
  const tier = (a) => /^8-K/.test(a.form || "") && /Item\s+2\.02/i.test(a.h || "") ? 3
    : /^10-[QK]/.test(a.form || "") ? 2 : (/^8-K/.test(a.form || "") ? 1 : 0);
  const DAY_ = 86400000;
  return entries.map((e) => {
    if (!e || !e.t || !e.d) return e;
    const D = Date.parse(e.d + "T12:00:00Z");
    if (!Number.isFinite(D)) return e;
    const cands = (byTk.get(String(e.t).toUpperCase()) || []).filter((a) => a.pub >= D - 2 * DAY_ && a.pub <= D + 6 * DAY_);
    let best = null, bestT = 0;
    for (const a of cands) { const t = tier(a); if (t > bestT || (t === bestT && best && a.pub > best.pub)) { best = a; bestT = t; } }
    return best ? Object.assign({}, e, { filing: { form: best.form, url: best.url, pub: best.pub } }) : e;
  });
}

// ---- shadow-variant promotion rule ---------------------------------------------------------
// A challenger threshold replaces the incumbent ONLY when, on out-of-sample shadow claims the
// engine gathered itself: both sides have >= 30 resolutions; the challenger's live expectancy
// beats the incumbent's by a real margin (0.08 native units) AND is positive; and its hit rate
// hasn't collapsed (>= incumbent - 0.02, i.e. it isn't a pure tail-rider). Strict on purpose:
// with samples this small, promotion churn IS the failure mode. Reversible by the same rule.
function shouldPromote(inc, ch) {
  if (!inc || !ch || !(inc.n >= 30) || !(ch.n >= 30)) return false;
  if (ch.avg == null || inc.avg == null || ch.hit == null || inc.hit == null) return false;
  if (!(ch.avg > 0)) return false;
  if (!(ch.avg >= inc.avg + 0.08)) return false;
  if (!(ch.hit >= inc.hit - 0.02)) return false;
  return true;
}

// ---- hold math over the hourly spines ----
// Price "as of" t: close of the latest candle at or before t, within tol (hourly resolution snaps to
// the hour, so a 09:30 boundary uses the ~09:00 candle — an acknowledged approximation).
function priceAsOf(prices, t, tol) {
  tol = tol || 3 * HOUR;
  let lo = 0, hi = prices.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (prices[m][0] <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx < 0) return null;
  const row = prices[idx];
  if (t - row[0] > tol) return null;
  const c = row[4];
  return Number.isFinite(c) && c > 0 ? c : null;
}
// Sum of hourly funding rates over [enter, exit) — the fraction a 1x long pays (or receives, if <0).
function fundingOver(funding, enter, exit) {
  let s = 0, any = false;
  for (const [t, r] of funding) { if (t >= enter && t < exit && Number.isFinite(r)) { s += r; any = true; } }
  return { sum: s, any };
}
function holdReturn(prices, funding, enter, exit, tol) {
  const pe = priceAsOf(prices, enter, tol), px = priceAsOf(prices, exit, tol);
  if (pe == null || px == null) return { ok: false };
  const gross = px / pe - 1;
  const f = fundingOver(funding || [], enter, exit);
  return { ok: true, enter, exit, hours: Math.round((exit - enter) / HOUR), pxEnter: pe, pxExit: px, gross, funding: f.sum, fundingKnown: f.any, net: gross - f.sum };
}
function runHolds(prices, funding, anchors, tol) {
  const out = [];
  for (const a of anchors) { const h = holdReturn(prices, funding, a.enter, a.exit, tol); if (h.ok) { h.tag = a.tag; out.push(h); } }
  return out;
}

// ---- aggregation (fat-tailed: report median + IQR + distribution, not just the mean) ----
function _stats(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y), n = a.length;
  if (!n) return { n: 0 };
  const q = (p) => { const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
  const mean = a.reduce((s, x) => s + x, 0) / n;
  let v = 0; for (const x of a) v += (x - mean) * (x - mean);
  return { n, mean, median: q(0.5), p25: q(0.25), p75: q(0.75), min: a[0], max: a[n - 1], stdev: n > 1 ? Math.sqrt(v / (n - 1)) : 0 };
}
function summarize(holds) {
  const net = holds.map((h) => h.net), gross = holds.map((h) => h.gross), fund = holds.map((h) => h.funding);
  const sn = _stats(net);
  if (!sn.n) return { n: 0 };
  let eqNet = 1, eqGross = 1;
  for (const h of holds) { eqNet *= 1 + h.net; eqGross *= 1 + h.gross; }
  const wins = net.filter((x) => x > 0).length;
  return {
    n: sn.n,
    net: sn, gross: _stats(gross), funding: _stats(fund),
    winRate: wins / sn.n,
    equityNet: eqNet - 1, equityGross: eqGross - 1,   // compounded total return over all holds
  };
}
// Hour-of-day (ET) activity profile for one ticker: bins each hourly candle by its ET wall-clock hour
// and returns raw per-hour aggregates — Parkinson-style range volatility ln(high/low), mean candle
// volume, mean funding rate, and sample counts. ET so the 09:30 open / 16:00 close humps line up with
// the session decomposition. Pure; the poller normalizes and pools these.
function activityClock(prices, funding, tz) {
  const vSum = new Array(24).fill(0), vCnt = new Array(24).fill(0);
  const qSum = new Array(24).fill(0), qCnt = new Array(24).fill(0);
  const fSum = new Array(24).fill(0), fCnt = new Array(24).fill(0);
  // Candles are on the hour, so ET hour = (UTC hour + offset) mod 24, and the ET/UTC offset only
  // changes at DST boundaries. Cache the offset per UTC day (one formatToParts each) instead of
  // calling etParts on every candle — ~48x fewer Intl calls. A handful of candles on the two DST
  // transition days may bin 1h off; immaterial for an activity clock (the session math uses the exact
  // path). offset is -4 (EDT) or -5 (EST): ET hour = ((utcHour + offset) % 24 + 24) % 24.
  // tz==="UTC" (the 24/7 crypto book) short-circuits the offset to 0 — hours are UTC as-is.
  const utc = tz === "UTC";
  const offCache = new Map();
  const etHour = (t) => {
    if (utc) return Math.floor((t % DAY) / HOUR);
    const day = Math.floor(t / DAY);
    let off = offCache.get(day);
    if (off === undefined) { off = etOffsetAt(t); offCache.set(day, off); }
    return ((Math.floor((t % DAY) / HOUR) + off) % 24 + 24) % 24;
  };
  for (const k of (prices || [])) {
    const t = k[0], hi = k[2], lo = k[3], v = k[5];
    if (!Number.isFinite(t)) continue;
    const hr = etHour(t);
    if (Number.isFinite(hi) && Number.isFinite(lo) && hi > 0 && lo > 0 && hi >= lo) { vSum[hr] += Math.log(hi / lo); vCnt[hr]++; }
    if (Number.isFinite(v)) { qSum[hr] += v; qCnt[hr]++; }
  }
  for (const p of (funding || [])) {
    const t = p[0], r = p[1];
    if (!Number.isFinite(t) || !Number.isFinite(r)) continue;
    const hr = etHour(t); fSum[hr] += r; fCnt[hr]++;
  }
  const vol = new Array(24), volume = new Array(24), fund = new Array(24), n = new Array(24);
  for (let i = 0; i < 24; i++) {
    n[i] = vCnt[i];
    vol[i] = vCnt[i] ? vSum[i] / vCnt[i] : null;
    volume[i] = qCnt[i] ? qSum[i] / qCnt[i] : null;
    fund[i] = fCnt[i] ? fSum[i] / fCnt[i] : null;
  }
  return { vol, volume, fund, n };
}

// Day-of-week x hour-of-day (7 x 24, ET) range-volatility + volume grid for one ticker. ET weekday and
// hour both come from a per-UTC-day offset cache: shifting the timestamp by the ET offset yields an
// instant whose UTC calendar equals the ET wall calendar, so getUTCDay()/getUTCHours() give ET
// weekday (0=Sun) and hour with no per-candle formatToParts. Pure; the poller normalizes and pools.
function dowClock(prices, tz) {
  const mk = () => Array.from({ length: 7 }, () => new Array(24).fill(0));
  const vSum = mk(), vCnt = mk(), qSum = mk(), qCnt = mk();
  const utc = tz === "UTC";
  const offCache = new Map();
  for (const k of (prices || [])) {
    const t = k[0], hi = k[2], lo = k[3], v = k[5];
    if (!Number.isFinite(t)) continue;
    let off = 0;
    if (!utc) { const day = Math.floor(t / DAY); off = offCache.get(day); if (off === undefined) { off = etOffsetAt(t); offCache.set(day, off); } }
    const et = new Date(t + off * HOUR), wd = et.getUTCDay(), hr = et.getUTCHours();
    if (Number.isFinite(hi) && Number.isFinite(lo) && hi > 0 && lo > 0 && hi >= lo) { vSum[wd][hr] += Math.log(hi / lo); vCnt[wd][hr]++; }
    if (Number.isFinite(v)) { qSum[wd][hr] += v; qCnt[wd][hr]++; }
  }
  const vol = [], volume = [], n = [];
  for (let d = 0; d < 7; d++) {
    vol[d] = []; volume[d] = []; n[d] = [];
    for (let h = 0; h < 24; h++) {
      n[d][h] = vCnt[d][h];
      vol[d][h] = vCnt[d][h] ? vSum[d][h] / vCnt[d][h] : null;
      volume[d][h] = qCnt[d][h] ? qSum[d][h] / qCnt[d][h] : null;
    }
  }
  return { vol, volume, n };
}

// Mean intra-hour return ln(close/open) by ET hour for one ticker (for the quarantined return-
// seasonality study). Same per-UTC-day offset cache as activityClock. Pure.
function hourReturnMeans(prices) {
  const sum = new Array(24).fill(0), cnt = new Array(24).fill(0), offCache = new Map();
  for (const k of (prices || [])) {
    const t = k[0], o = k[1], c = k[4];
    if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(c) || o <= 0 || c <= 0) continue;
    const day = Math.floor(t / DAY);
    let off = offCache.get(day); if (off === undefined) { off = etOffsetAt(t); offCache.set(day, off); }
    const hr = ((Math.floor((t % DAY) / HOUR) + off) % 24 + 24) % 24;
    sum[hr] += Math.log(c / o); cnt[hr]++;
  }
  const ret = new Array(24);
  for (let i = 0; i < 24; i++) ret[i] = cnt[i] ? sum[i] / cnt[i] : null;
  return { ret, n: cnt };
}

// Per-ET-hour return stats for ONE ticker as a time series: each day's ln(close/open) in that hour is
// one observation, so this is a within-name t-test (mean/se/t/n) — distinct from the cross-sectional
// build in the poller (which uses one mean per ticker). Noisier and does not model autocorrelation, so
// the client labels single-name views with extra caution. Pure; shape matches the cross-sectional hours.
function hourReturnStats(prices) {
  const sum = new Array(24).fill(0), sq = new Array(24).fill(0), cnt = new Array(24).fill(0), offCache = new Map();
  for (const k of (prices || [])) {
    const t = k[0], o = k[1], c = k[4];
    if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(c) || o <= 0 || c <= 0) continue;
    const day = Math.floor(t / DAY);
    let off = offCache.get(day); if (off === undefined) { off = etOffsetAt(t); offCache.set(day, off); }
    const hr = ((Math.floor((t % DAY) / HOUR) + off) % 24 + 24) % 24;
    const x = Math.log(c / o); sum[hr] += x; sq[hr] += x * x; cnt[hr]++;
  }
  const hours = [];
  for (let h = 0; h < 24; h++) {
    const n = cnt[h];
    if (n < 3) { hours.push({ h, mean: null, se: null, t: null, n }); continue; }
    const mean = sum[h] / n, varr = (sq[h] - n * mean * mean) / (n - 1);
    const sd = Math.sqrt(Math.max(0, varr)), se = sd / Math.sqrt(n);
    hours.push({ h, mean: +mean.toFixed(6), se: +se.toFixed(6), t: se > 0 ? +(mean / se).toFixed(2) : 0, n });
  }
  return { hours, sigCount: hours.filter((x) => x.t != null && Math.abs(x.t) >= 2).length };
}

// Top-2 principal components of a set of row vectors, via power iteration + deflation (no deps).
// Returns { coords:[[x,y],...] } (one 2D point per row, mean-centred) and varExplained:[f1,f2]
// (fraction of total variance each axis captures — so the 2D scatter can honestly show how much
// structure it's actually displaying). Rows with non-finite entries are treated as 0 after centring.
function pca2(rows) {
  const n = rows.length, d = n ? rows[0].length : 0;
  if (n < 2 || d < 2) return { coords: rows.map(() => [0, 0]), varExplained: [0, 0] };
  const mean = new Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += (Number.isFinite(r[j]) ? r[j] : 0);
  for (let j = 0; j < d; j++) mean[j] /= n;
  const X = rows.map((r) => r.map((x, j) => (Number.isFinite(x) ? x : 0) - mean[j]));
  // covariance d x d
  const C = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const x of X) for (let a = 0; a < d; a++) { const xa = x[a]; if (!xa) continue; for (let b = 0; b < d; b++) C[a][b] += xa * x[b]; }
  const denom = n - 1; for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) C[a][b] /= denom;
  let trace = 0; for (let a = 0; a < d; a++) trace += C[a][a];
  const matVec = (M, v) => { const o = new Array(d).fill(0); for (let a = 0; a < d; a++) { let s = 0; for (let b = 0; b < d; b++) s += M[a][b] * v[b]; o[a] = s; } return o; };
  const norm = (v) => { let s = 0; for (const x of v) s += x * x; return Math.sqrt(s) || 1; };
  function topEig(M) {
    let v = new Array(d).fill(0).map((_, i) => Math.sin(i + 1) + 0.1);   // deterministic seed
    let nv = norm(v); v = v.map((x) => x / nv);
    for (let it = 0; it < 120; it++) { const w = matVec(M, v); const wn = norm(w); v = w.map((x) => x / wn); }
    const Mv = matVec(M, v); let lam = 0; for (let a = 0; a < d; a++) lam += v[a] * Mv[a];
    return { vec: v, val: lam };
  }
  const e1 = topEig(C);
  const C2 = C.map((row, a) => row.map((x, b) => x - e1.val * e1.vec[a] * e1.vec[b]));
  const e2 = topEig(C2);
  const coords = X.map((x) => {
    let p = 0, q = 0; for (let a = 0; a < d; a++) { p += x[a] * e1.vec[a]; q += x[a] * e2.vec[a]; }
    return [p, q];
  });
  return { coords, varExplained: [trace ? e1.val / trace : 0, trace ? e2.val / trace : 0] };
}

// Pool holds across many tickers (the statistically sound "composite" — averages out single-name noise).
function poolSummary(byTicker) {
  const all = [];
  for (const k in byTicker) for (const h of byTicker[k]) all.push(h);
  return summarize(all);
}

// Cross-sectional composite for ONE session: each calendar boundary (a given night / weekend / cash
// day) becomes a single equal-weight bet across every ticker that had a valid hold on it; the per-
// boundary mean return is then compounded into an equity curve. This is the "one clean bet per
// boundary across the class" framing — single-name noise averages out, and because anchors are
// calendar-derived the enter timestamps line up across tickers, so grouping by `enter` is exact.
// Input: array of per-ticker hold arrays (each already produced by runHolds for the same anchor set).
// Output: { n, tickers, breadth, curve:[[t, eqGross, eqNet, fundingKnownFrac, breadth], ...],
//           mean/median/win (gross & net), totGross, totNet, fundingHorizonTs }.
function _mean(a) { let s = 0, n = 0; for (const x of a) if (Number.isFinite(x)) { s += x; n++; } return n ? s / n : 0; }
function _round6(x) { return Math.round(x * 1e6) / 1e6; }
function sessionComposite(perTickerHolds) {
  const byB = new Map();
  let tickers = 0;
  for (const hs of perTickerHolds) {
    if (!hs || !hs.length) continue;
    tickers++;
    for (const h of hs) {
      let b = byB.get(h.enter);
      if (!b) { b = { enter: h.enter, exit: h.exit, g: [], n: [], fk: 0 }; byB.set(h.enter, b); }
      b.g.push(h.gross); b.n.push(h.net); if (h.fundingKnown) b.fk++;
    }
  }
  const bounds = [...byB.values()].sort((a, b) => a.enter - b.enter);
  let eqG = 1, eqN = 1, fundingHorizonTs = null;
  const curve = [], perG = [], perN = [];
  for (const b of bounds) {
    const mg = _mean(b.g), mn = _mean(b.n), fk = b.g.length ? b.fk / b.g.length : 0;
    eqG *= 1 + mg; eqN *= 1 + mn;
    curve.push([b.enter, _round6(eqG - 1), _round6(eqN - 1), Math.round(fk * 1000) / 1000, b.g.length]);
    perG.push(mg); perN.push(mn);
    if (fundingHorizonTs === null && fk >= 0.5) fundingHorizonTs = b.enter;
  }
  const winFrac = (a) => (a.length ? a.filter((x) => x > 0).length / a.length : 0);
  return {
    n: bounds.length, tickers,
    breadth: bounds.length ? _mean(bounds.map((b) => b.g.length)) : 0,
    curve,
    meanGross: _mean(perG), meanNet: _mean(perN),
    medianGross: median(perG), medianNet: median(perN),
    winGross: winFrac(perG), winNet: winFrac(perN),
    totGross: eqG - 1, totNet: eqN - 1,
    fundingHorizonTs,
  };
}

// ---- Red-tape resilience (DownCap / Hit%) + relative volume --------------------------------
// The setup these serve: on a red tape, the names that dump least tend to keep leading once the
// market stabilizes. "Red" is BREADTH-defined, not benchmark-defined — BTC green while alts bleed
// is a red tape; BTC red while the tape shrugs is not. Reference is the UNIVERSE MEDIAN return
// per bar, never a benchmark, so the stat is self-normalizing and the benchmark is just a row.

// 4h close-to-close returns from an hourly spine, keyed by 4h bucket index (floor(t/4h)).
// Completed buckets only (a partial bucket's "close" is a moving target); a return exists only
// between CONSECUTIVE buckets — gaps in the spine produce no synthetic multi-bucket return.
function fourHourReturns(hs, now, cutMs) {
  const B = 4 * 3600 * 1000, curB = Math.floor(now / B);
  const close = new Map();
  for (const k of hs) {
    const t = k[0], c = k[4];
    if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) continue;
    if (cutMs != null && t < cutMs) continue;
    const b = Math.floor(t / B);
    if (b >= curB) continue;                       // in-progress bucket: skip
    const cur = close.get(b);
    if (!cur || t >= cur[0]) close.set(b, [t, c]);
  }
  const rets = new Map();
  for (const [b, [, c]] of close) {
    const prev = close.get(b - 1);
    if (prev && prev[1] > 0) rets.set(b, c / prev[1] - 1);
  }
  return rets;
}

// Red-tape stats for one universe. seriesByCoin: Map(coin -> Map(bucket -> ret)).
// A bar is red when the cross-sectional MEDIAN return is negative AND >= `breadth` of reporting
// names are red — pure breadth, no benchmark. One liquidation-cascade bar must not dominate the
// Σ ratio, so bars are winsorized by WEIGHT: m* = median(|median-ret|) over red bars, and a bar
// whose |median-ret| exceeds 2·m* is scaled down to count as exactly 2·m* of tape move (the
// ticker's return on that bar scales by the same factor — ratio semantics preserved).
// Per coin: DownCap = 100·Σ(w·ret)/Σ(w·med) on matched red bars (<100 dumps less than the tape,
// negative = net green on red bars), Hit = share of matched red bars where the coin beat the
// median. Below `minBars` matched bars: null — a dash, never a fabricated character read.
function tapeRedStats(seriesByCoin, opts) {
  const { breadth = 0.7, minBars = 20, minCross = 10 } = opts || {};
  const byBar = new Map();
  for (const [, rets] of seriesByCoin)
    for (const [b, ret] of rets) {
      let a = byBar.get(b);
      if (!a) { a = []; byBar.set(b, a); }
      a.push(ret);
    }
  const red = [];                                  // [bucket, medianRet]
  for (const [b, a] of byBar) {
    if (a.length < minCross) continue;
    const med = median(a);
    if (!(med < 0)) continue;
    let neg = 0; for (const x of a) if (x < 0) neg++;
    if (neg / a.length >= breadth) red.push([b, med]);
  }
  red.sort((x, y) => x[0] - y[0]);
  const mstar = median(red.map(([, m]) => Math.abs(m)));
  const wOf = (m) => (mstar > 0 && Math.abs(m) > 2 * mstar) ? (2 * mstar) / Math.abs(m) : 1;
  const stats = new Map();
  for (const [coin, rets] of seriesByCoin) {
    let sr = 0, sm = 0, n = 0, hit = 0;
    for (const [b, med] of red) {
      const ret = rets.get(b);
      if (ret == null) continue;
      const w = wOf(med);
      sr += w * ret; sm += w * med; n++;
      if (ret > med) hit++;
    }
    if (n < minBars || !(sm < 0)) { stats.set(coin, null); continue; }
    stats.set(coin, { dcap: Math.round((100 * sr) / sm), hit: Math.round((100 * hit) / n), n });
  }
  return { redBars: red.length, stats };
}

// Relative volume, clock-hour matched. For each requested window W (ms, a whole number of
// hours): notional traded over the last W COMPLETED hourly candles ÷ the median notional of the
// SAME clock-hour span on prior days. Clock matching is what makes the number honest across the
// session shape — 3am is judged against prior 3ams, the US open against prior opens — and it is
// why an off-hours reading is a real signal rather than a guaranteed ~0x. Coverage guards: the
// current span needs >=75% of its candles present; each baseline sample the same; and at least
// `minSamples` baseline days must qualify, else null.
function rvolMulti(hs, windowsMs, now, minSamples) {
  const HOUR = 3600 * 1000, minS = minSamples == null ? 7 : minSamples;
  const ntl = new Map();                           // hour bucket -> notional
  for (const k of hs) {
    const t = k[0], c = k[4], v = k[5];
    if (!Number.isFinite(t) || !Number.isFinite(c) || !Number.isFinite(v) || v < 0) continue;
    ntl.set(Math.floor(t / HOUR), c * v);
  }
  const endH = Math.floor(now / HOUR);             // exclusive: candles endH-1 and older are complete
  const span = (lastH, W) => {                     // sum of W hourly notionals ending AT lastH (inclusive)
    let s = 0, have = 0;
    for (let h = lastH - W + 1; h <= lastH; h++) { const x = ntl.get(h); if (x != null) { s += x; have++; } }
    return have >= Math.ceil(0.75 * W) ? s : null;
  };
  const out = {};
  for (const key in windowsMs) {
    const W = Math.max(1, Math.round(windowsMs[key] / HOUR));
    const cur = span(endH - 1, W);
    if (cur == null) { out[key] = null; continue; }
    const base = [];
    for (let d = 1; d <= 31; d++) {
      const s = span(endH - 1 - 24 * d, W);
      if (s != null && s > 0) base.push(s);
    }
    if (base.length < minS) { out[key] = null; continue; }
    const m = median(base);
    out[key] = m > 0 ? +(cur / m).toFixed(2) : null;
  }
  return out;
}

// ===== EMA trend ladder (Trend tab) ==========================================================
// Reverse-engineered from the Metrik-style "Trend Leaderboard": an EMA 13/21 ribbon evaluated on
// four timeframes (D1 · H12 · H4 · H1). Per timeframe, three honest states from two comparisons:
//   up      — px > EMA13 > EMA21 (stacked ribbon, established uptrend)
//   down    — px < EMA13 < EMA21 (stacked below, established downtrend)
//   reclaim — above EMA21 but the ribbon isn't stacked up (repairing)
//   roll    — below EMA21 but the ribbon isn't stacked down (rolling over)
// Long score = count of 'up' TFs; short score = count of 'down'. A RETEST fires when a trending
// timeframe's recent bars (last TREND_RETEST_BARS, forming bar included) probed into the 13/21
// ribbon zone while the close held the EMA21 side of the trend — the classic continuation-entry
// pullback (long) / rally (short). All approximations are stated, none hidden: the zone test uses
// the CURRENT EMAs against recent extremes (not bar-by-bar historical EMAs), and the forming
// bar's close is replaced by the live mark so the ladder tracks price, not a stale hourly close.

const TREND_TFS = ["D1", "H12", "H4", "H1"];   // high -> low; the first retest found is the one reported
const TREND_RETEST_BARS = 3;                    // recent-extreme window for the zone probe
const TREND_MIN_BARS = 26;                      // EMA21 needs 21 seed bars + a few recursion steps to be honest

// Last EMA value over `closes` (oldest -> newest). Seeded with the SMA of the first `span` bars —
// the textbook construction — then recursed. Returns null when there isn't enough history for the
// seed plus a handful of convergence steps; a dash is honest, a half-converged EMA is not.
function emaLast(closes, span) {
  if (!Array.isArray(closes) || closes.length < Math.max(span + 5, TREND_MIN_BARS)) return null;
  let e = 0;
  for (let i = 0; i < span; i++) { const v = +closes[i]; if (!isFinite(v)) return null; e += v; }
  e /= span;
  const a = 2 / (span + 1);
  for (let i = span; i < closes.length; i++) { const v = +closes[i]; if (!isFinite(v)) return null; e = a * v + (1 - a) * e; }
  return e;
}

// Aggregate the hourly spine into UTC-aligned N-hour buckets (forming bucket included). Only the
// fields the ladder needs survive: t/o/h/l/c. Missing highs/lows (warm-cache closes-only candles)
// degrade to the close so the zone test stays defined instead of poisoning Math.min with NaN.
// Aggregate the packed hourly spine ([[t,o,h,l,c,v], ...]) into wider UTC-aligned buckets.
// INPUT is the packed numeric spine (r.hourlyRaw); OUTPUT stays {t,o,h,l,c} objects — that's the
// shape trendLadder, the chart serializer and the daily-OHLC upgrade all read, so only the input
// convention changed when the spine went packed. o/h/l fall back to the close when absent.
function bucketCandles(hourly, hours, HOUR) {
  const W = hours * HOUR, out = [];
  let cur = null;
  for (const k of hourly || []) {
    const t = +k[0]; if (!isFinite(t)) continue;
    const c = +k[4]; if (!isFinite(c)) continue;
    const h = k[2] != null && isFinite(+k[2]) ? +k[2] : c;
    const l = k[3] != null && isFinite(+k[3]) ? +k[3] : c;
    const b = Math.floor(t / W) * W;
    if (!cur || cur.t !== b) { if (cur) out.push(cur); cur = { t: b, o: k[1] != null && isFinite(+k[1]) ? +k[1] : c, h, l, c }; }
    else { cur.c = c; if (h > cur.h) cur.h = h; if (l < cur.l) cur.l = l; }
  }
  if (cur) out.push(cur);
  return out;
}

function trendState(px, e13, e21) {
  if (px == null || e13 == null || e21 == null || !isFinite(px)) return null;
  if (px > e13 && e13 > e21) return "up";
  if (px < e13 && e13 < e21) return "down";
  return px > e21 ? "reclaim" : "roll";
}

// Build the four-timeframe ladder for one market. `tfCandles` = { D1, H12, H4, H1 }, each an
// array of {t,h?,l?,c} oldest -> newest with the FORMING bar last. Returns null when any
// timeframe lacks enough history — a market missing one rung is excluded, not guessed at.
// `fast`/`slow` are the two ribbon spans (default 13/21 — the canonical board). A rung with fewer
// than TREND_MIN_BARS bars still excludes the whole name (a market with no honest trend on some
// timeframe isn't board material). But a rung that clears that floor yet can't seed the CHOSEN
// slow MA (e.g. a 200 EMA over crypto's ~92 daily bars) is neither excluded nor guessed: it's a
// `nodata` rung — an honest grey dot that fills in on its own as history deepens. Score, strength
// and retest are counted over the rungs that DID compute; `avail` reports how many that was, so a
// board built on a longer MA can score out-of-available instead of penalising a pending rung.
function trendLadder(px, tfCandles, fast, slow) {
  if (px == null || !isFinite(+px)) return null;
  px = +px;
  fast = fast || 13; slow = slow || 21;
  const out = { tf: {}, fast, slow, avail: 0, long: { score: 0, retest: null, strength: 0 }, short: { score: 0, retest: null, strength: 0 } };
  for (const tf of TREND_TFS) {
    const c = tfCandles[tf];
    if (!Array.isArray(c) || c.length < TREND_MIN_BARS) return null;
    const closes = c.map((k) => +k.c);
    closes[closes.length - 1] = px;                    // live mark drives the forming bar
    const eF = emaLast(closes, fast), eS = emaLast(closes, slow);
    if (eF == null || eS == null || eS === 0) {        // clears the floor, can't seed the slow MA → grey, not excluded
      out.tf[tf] = { st: "nodata", e13: null, e21: null, d21: null };
      continue;
    }
    out.avail++;
    const st = trendState(px, eF, eS);
    const lastK = c.slice(-TREND_RETEST_BARS);
    let lowK = Infinity, highK = -Infinity;
    for (const k of lastK) {
      const lo = k.l != null && isFinite(+k.l) ? +k.l : +k.c;
      const hi = k.h != null && isFinite(+k.h) ? +k.h : +k.c;
      if (lo < lowK) lowK = lo;
      if (hi > highK) highK = hi;
    }
    // include the live mark itself in the probe window (it may sit past the last stored candle)
    if (px < lowK) lowK = px; if (px > highK) highK = px;
    const d21 = ((px - eS) / eS) * 100;
    out.tf[tf] = { st, e13: eF, e21: eS, d21: +d21.toFixed(2) };   // e13/e21 keys keep the wire shape; they hold the active fast/slow EMAs
    if (st === "up") {
      out.long.score++; out.long.strength += (eF - eS) / eS;
      if (!out.long.retest && lowK <= eF && px > eS) out.long.retest = tf;
    } else if (st === "down") {
      out.short.score++; out.short.strength += (eS - eF) / eS;
      if (!out.short.retest && highK >= eF && px < eS) out.short.retest = tf;
    }
  }
  return out;
}

// Read line for one side of the ladder. Mirrors the source board's language:
//   retest (score>=3)  ->  "Pullback/Rally to {TF} EMA21 — continuation entry/short"
//   4/4                ->  "Full up/downtrend — ... · x.x% over/under H1 EMA21"
//   3/4                ->  "Strong (down) — {laggingTF} lagging"
//   2/4                ->  "Mixed — {alignedTFs} up/down, wait for alignment"
// Scores below 2 return null: the board only ranks names with at least higher-TF agreement.
function trendRead(side, lad) {
  const L = side === "long", s = L ? lad.long : lad.short;
  if (s.score < 2) return null;
  const want = L ? "up" : "down";
  const avail = lad.avail != null ? lad.avail : 4;     // rungs that actually seeded the chosen MA
  const pending = TREND_TFS.filter((t) => lad.tf[t] && lad.tf[t].st === "nodata");
  const pnote = pending.length ? ` · ${pending.join("/")} pending history` : "";
  if (s.retest && s.score >= 3)
    return { text: L ? `Pullback to ${s.retest} EMA${lad.slow} — continuation entry` : `Rally to ${s.retest} EMA${lad.slow} — continuation short`, retest: s.retest };
  const d = lad.tf.H1 && lad.tf.H1.d21 != null ? Math.abs(lad.tf.H1.d21) : null;
  const pct = d != null ? `${d.toFixed(1)}%` : "—";
  if (s.score === avail && avail >= 2) {               // every AVAILABLE rung aligned
    if (avail === 4)
      return { text: L ? `Full uptrend — long pullbacks · +${pct} over H1 EMA${lad.slow}` : `Full downtrend — short rallies · ${pct} under H1 EMA${lad.slow}`, retest: null };
    return { text: L ? `Aligned ${s.score}/${avail} — long pullbacks${pnote}` : `Aligned ${s.score}/${avail} — short rallies${pnote}`, retest: null };
  }
  // lag search skips nodata rungs — a pending rung is unknown, not lagging
  const lag = TREND_TFS.find((t) => lad.tf[t] && lad.tf[t].st !== want && lad.tf[t].st !== "nodata");
  if (lag && (s.score === avail - 1 || s.score === 3))
    return { text: L ? `Strong — ${lag} lagging${pnote}` : `Strong down — ${lag} lagging${pnote}`, retest: null };
  const aligned = TREND_TFS.filter((t) => lad.tf[t] && lad.tf[t].st === want).join("/");
  return { text: `Mixed — ${aligned} ${L ? "up" : "down"}, wait for alignment${pnote}`, retest: null };
}

// Trend age: consecutive most-recent bars where the ribbon was stacked on `side`, computed from
// an exact per-bar EMA walk (same SMA-seed construction as emaLast, so the final bar agrees with
// the ladder to the last bit). The forming bar's close is replaced by the live mark, matching the
// ladder. Bars are only checkable once BOTH EMAs exist (index >= 20), so on short histories the
// run can hit the edge of what's measurable — `capped` says "at least this old", never "exactly".
function stackedRun(candles, px, side, fast, slow) {
  fast = fast || 13; slow = slow || 21;
  if (!Array.isArray(candles) || candles.length < Math.max(slow + 5, TREND_MIN_BARS)) return null;
  const closes = candles.map((k) => +k.c);
  if (px != null && isFinite(+px)) closes[closes.length - 1] = +px;
  const n = closes.length, aF = 2 / (fast + 1), aS = 2 / (slow + 1);
  let eF = 0, eS = 0, sF = 0, sS = 0, run = 0, checked = 0;
  for (let i = 0; i < n; i++) {
    const c = closes[i];
    if (!isFinite(c)) return null;
    if (i < fast) { sF += c; if (i === fast - 1) eF = sF / fast; } else eF = aF * c + (1 - aF) * eF;
    if (i < slow) { sS += c; if (i === slow - 1) eS = sS / slow; } else eS = aS * c + (1 - aS) * eS;
    if (i < slow - 1) continue;
    checked++;
    const stacked = side === "long" ? (c > eF && eF > eS) : (c < eF && eF < eS);
    run = stacked ? run + 1 : 0;
  }
  return { run, capped: run > 0 && run === checked };
}

// Guard against the D1 staleness window: daily candles refresh every ~6h, so a fetch that
// predates UTC midnight leaves the series ending at YESTERDAY'S completed candle. Overwriting
// that close with the live mark would smear today's price into yesterday's bar and drop a bar
// from the EMA. If the last bar belongs to a prior UTC day, append a synthetic forming bar at
// today's day-start carrying the live mark instead; if the forming day is already present (the
// normal case), return the series untouched and let the ladder's live-mark replacement handle it.
function withFormingDaily(daily, px, now, DAY) {
  if (!Array.isArray(daily) || !daily.length || px == null || !isFinite(+px)) return daily;
  const dayStart = Math.floor(now / DAY) * DAY;
  const lastT = +daily[daily.length - 1].t;
  if (!isFinite(lastT) || lastT >= dayStart) return daily;
  return daily.concat([{ t: dayStart, c: +px }]);
}

// Ribbon width for one side of the ladder: the AVERAGE EMA13–EMA21 spread across the rungs
// aligned with that side, as a percent of EMA21. This is the `strength` the ladder already
// accumulates, normalized per rung — which is what makes it comparable across scores and lets it
// disambiguate two rows at the same score: a 4/4 over a 0.1% ribbon is a stack one bad bar
// unwinds; over 2% it's established separation. Null when the side has no aligned rungs — the
// width of nothing is not zero, it's meaningless.
function ribbonWidth(s) {
  if (!s || !(s.score > 0) || !isFinite(s.strength)) return null;
  return +((100 * s.strength) / s.score).toFixed(2);
}

// One bar of each ladder timeframe, in ms — the window for the retest-volume read (rrv).
const TREND_TF_MS = { D1: 24 * 3600e3, H12: 12 * 3600e3, H4: 4 * 3600e3, H1: 3600e3 };

// Tape-wide positioning regime (pure). From an array of per-name [ts, oi, funding] spines
// (ascending), reconstruct the daily aggregate the whole book traded: total notional OI and the
// OI-weighted mean funding as an APR %. Each name is forward-filled across days from its first
// sample, so a name with a stale spine still carries its last known positioning instead of
// dropping out and jerking the aggregate. Funding is annualized rate*24*365*100; a name with a
// null funding sample still contributes its OI but not the funding weight for that day. The last
// series point is where the tiles read their current values, so tile and chart-end can never
// disagree. Returns the series plus z-score-vs-window and 7d/30d OI change.
function regimeAggregate(spines, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const DAY = 86400 * 1000;
  const days = opts.days || 60;
  const APR = 24 * 365 * 100;             // hourly funding rate -> APR percent
  const endDay = Math.floor(now / DAY);
  const startDay = endDay - (days - 1);
  const list = Array.isArray(spines) ? spines.filter((s) => Array.isArray(s) && s.length) : [];
  const empty = { series: [], totalOi: null, netFundApr: null, oiZ: null, oi7dPct: null, oi30dPct: null, names: list.length };
  if (!list.length) return empty;
  const oiSum = new Array(days).fill(0), fwSum = new Array(days).fill(0), fwDen = new Array(days).fill(0), seen = new Array(days).fill(0);
  for (const sp of list) {
    const dayOi = new Array(days).fill(null), dayF = new Array(days).fill(null);
    let preOi = null, preF = null;        // last known strictly before the window: the fill seed
    for (const s of sp) {
      if (!(s[1] > 0)) continue;
      const d = Math.floor(s[0] / DAY);
      const f = (s[2] != null && isFinite(s[2])) ? s[2] : null;
      if (d < startDay) { preOi = s[1]; if (f != null) preF = f; continue; }
      if (d > endDay) break;
      const idx = d - startDay;
      dayOi[idx] = s[1]; if (f != null) dayF[idx] = f;   // last sample of the day wins
    }
    let curOi = preOi, curF = preF;
    for (let i = 0; i < days; i++) {
      if (dayOi[i] != null) curOi = dayOi[i];
      if (dayF[i] != null) curF = dayF[i];
      if (curOi != null && curOi > 0) {
        oiSum[i] += curOi; seen[i] += 1;
        if (curF != null && isFinite(curF)) { fwSum[i] += curOi * curF; fwDen[i] += curOi; }
      }
    }
  }
  const series = [];
  for (let i = 0; i < days; i++) {
    if (!seen[i]) continue;               // no name has started this early in the window
    const nf = fwDen[i] > 0 ? (fwSum[i] / fwDen[i]) * APR : null;
    series.push([(startDay + i) * DAY, oiSum[i], nf != null ? +nf.toFixed(2) : null]);
  }
  if (!series.length) return empty;
  const last = series[series.length - 1], totalOi = last[1], netFundApr = last[2];
  const ois = series.map((p) => p[1]);
  let z = null;
  if (ois.length >= 5) {
    const m = ois.reduce((a, b) => a + b, 0) / ois.length;
    let v = 0; for (const x of ois) v += (x - m) * (x - m);
    const sd = Math.sqrt(v / ois.length);
    z = sd > 0 ? (totalOi - m) / sd : 0;
  }
  const pctChg = (back) => { if (series.length <= back) return null; const prev = series[series.length - 1 - back][1]; return prev > 0 ? (totalOi / prev - 1) * 100 : null; };
  const p7 = pctChg(7), p30 = pctChg(30);
  return {
    series, totalOi, netFundApr,
    oiZ: z != null ? +z.toFixed(2) : null,
    oi7dPct: p7 != null ? +p7.toFixed(1) : null,
    oi30dPct: p30 != null ? +p30.toFixed(1) : null,
    names: list.length,
  };
}

// ===== Markets-tab momentum pair (build 2026.07.24-07) ==========================================
// mom  — the incumbent board score, math byte-identical to the client's original computeMomentum:
//        risk-adjusted 5-horizon blend × cross-horizon coherence + range tilt, then a
//        direction-agnostic OI conviction multiplier clamp(1+0.4·tanh(ΔOI/8), 0.6, 1.4).
// momp — the MOM+ candidate: SAME shared core, but the OI term is regime-qualified (bench V2:
//        OI building amplifies only scaled by funding corroboration with the score's side;
//        OI falling is covering — mechanically different flow — and dampens at half band) and
//        a funding-crowding haircut is applied (bench V3: the crowd paying an own-31d funding
//        extreme to be on the score's side → ×0.8, the exhaustion tax the ▴/▾ flag points at).
// Both ship as board columns; the score duel adjudicates them on daily forward rank IC before
// any promotion touches the incumbent. Pure numbers in, {mom, momp, why} out. The client
// mirrors this math for the live per-timeframe columns; the poller calls THIS for the
// canonical 00:00 UTC duel snapshot; a constant-fragment test pins the two implementations
// to identical coefficients so they cannot silently drift apart.
function momPair(inp) {
  const clampN = (v, a, b) => Math.min(b, Math.max(a, v));
  const volH = inp.volH, volD = (inp.volD > 0) ? inp.volD : null;
  if (!(volH > 0)) return { mom: undefined, momp: undefined, why: null };
  const H = [[inp.h1, 1, 0.10], [inp.h4, 4, 0.15], [inp.d1, 24, 0.30], [inp.d7, 168, 0.30], [inp.d30, 720, 0.15]];
  let s = 0, w = 0, sa = 0;
  for (const [ret, hrs, wt] of H) {
    if (ret == null || !isFinite(ret)) continue;
    const sigma = (hrs >= 24 && volD) ? volD * Math.sqrt(hrs / 24) : volH * Math.sqrt(hrs);
    if (!(sigma > 0)) continue;
    const z = (ret / 100) / sigma; s += wt * z; sa += wt * Math.abs(z); w += wt;
  }
  if (w === 0) return { mom: null, momp: null, why: null };
  const kappa = sa > 0 ? Math.abs(s) / sa : 0;
  let core = (s / w) * (0.5 + 0.5 * kappa);
  if (inp.px != null && inp.hi30 != null && inp.lo30 != null && inp.hi30 > inp.lo30)
    core += 0.4 * (clampN((inp.px - inp.lo30) / (inp.hi30 - inp.lo30), 0, 1) - 0.5) * 2;
  const doi = inp.doi;
  // incumbent branch — the shipped score, untouched
  let coreA = core;
  if (doi != null && isFinite(doi)) coreA *= clampN(1 + 0.4 * Math.tanh(doi / 8), 0.6, 1.4);
  // MOM+ branch — V2 regime-qualified OI + V3 crowding haircut
  let coreB = core; const why = [];
  if (doi != null && isFinite(doi) && core !== 0 && doi !== 0) {
    if (doi > 0) {
      let c = 0.5;                                          // corroboration: 1 with the score, 0 against, 0.5 flat/unknown
      const fAPR = inp.fundAPR;
      if (fAPR != null && isFinite(fAPR) && Math.abs(Math.tanh(fAPR / 25)) >= 0.15)
        c = ((core > 0) === (fAPR > 0)) ? 1 : 0;
      coreB *= clampN(1 + 0.4 * Math.tanh(doi / 8) * (0.5 + 0.5 * c), 0.6, 1.4);
      why.push(c === 1 ? "OI+ corroborated" : c === 0 ? "OI+ conflicted" : "OI+ fund flat");
    } else {
      coreB *= clampN(1 - 0.2 * Math.tanh(-doi / 8), 0.6, 1.4);
      why.push(core > 0 ? "squeeze-side OI" : "unwind-side OI");
    }
  }
  const fp = inp.fundPct, fAPR2 = inp.fundAPR;
  if (core !== 0 && fp != null && fAPR2 != null && isFinite(fAPR2)) {
    if (core > 0 && fAPR2 > 0 && fp >= 90) { coreB *= 0.8; why.push("crowded long −20%"); }
    else if (core < 0 && fAPR2 < 0 && fp <= 10) { coreB *= 0.8; why.push("crowded short −20%"); }
  }
  return { mom: 100 * Math.tanh(coreA / 1.5), momp: 100 * Math.tanh(coreB / 1.5), why: why.length ? why.join(" · ") : null };
}

// Spearman rank IC: pearson of average ranks (ties → mean rank). Returns null when either
// side is degenerate (constant), rather than a fabricated 0 — an honest dash beats fake signal.
function rankAvg(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const rk = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rk[idx[k][1]] = r;
    i = j + 1;
  }
  return rk;
}
function spearmanIC(scores, rets) {
  if (!scores || !rets || scores.length !== rets.length || scores.length < 3) return null;
  const r = pearson(rankAvg(scores), rankAvg(rets));
  return (r != null && isFinite(r)) ? r : null;
}

// Duel verdict stats over daily IC pairs [{a, b}]: means, share of days B led, and the paired
// t-stat on the DIFFERENCE (b − a) — the anti-eyeball number. verdict unlocks at minN days or
// |t| ≥ 2, whichever first; until then the panel refuses to call a winner.
function duelStats(rows, minN) {
  const n = rows.length;
  if (!n) return { n: 0, meanA: null, meanB: null, winB: null, t: null, verdict: false };
  let sa2 = 0, sb2 = 0, wb = 0; const d = [];
  for (const r of rows) { sa2 += r.a; sb2 += r.b; if (r.b > r.a) wb++; d.push(r.b - r.a); }
  const meanA = sa2 / n, meanB = sb2 / n, winB = wb / n;
  let t = null;
  if (n >= 3) {
    const md = d.reduce((p, q) => p + q, 0) / n;
    const sd = stdev(d);
    t = sd > 0 ? md / (sd / Math.sqrt(n)) : null;
  }
  const verdict = n >= (minN || 60) || (t != null && Math.abs(t) >= 2);
  return { n, meanA, meanB, winB, t, verdict };
}

module.exports = { stdev, median, linregR2, priceAt, featuresFromHourly, oiDeltaPct, fundingAvg, firstIndexGT, firstIndexGE, dailyLogReturns, pearson, meanPairwiseCorr, corrMatrix, stopGeometryOk, fadeStats, regimeAggregate, momPair, spearmanIC, duelStats,
  fourHourReturns, tapeRedStats, rvolMulti,
  // boundary-backtest engine (ET session calendar, anchor generators, net-of-funding hold math)
  etParts, etOffsetAt, etWallToUtc, etDays, nextEtDate, cashAnchors, overnightAnchors, weekendAnchors,
  utcDayAnchors, cryptoWeekendAnchors,
  usDayStatus, marketSessions, closedWindows,
  summarizeEvents, retStd, dailyRets, studyBigMove, studyBreakout, studyVolShift, studyGapFade, studyFundFlip,
  EV_META, playbook, shouldPromote, stopTouched, detectMAPull, detectReclaim, detectFailBrk, detectPead, detectSweep, detectLevels, studyBreakdown, confSplit, studyOIFlush, studyFPDiv, compressionNow, offDriftStats,
  // EMA trend ladder (Trend tab)
  emaLast, bucketCandles, trendState, trendLadder, trendRead, withFormingDaily, stackedRun, TREND_TFS, ribbonWidth, TREND_TF_MS,
  priceAsOf, fundingOver, holdReturn, runHolds, summarize, poolSummary, sessionComposite, activityClock, dowClock, pca2, hourReturnMeans, hourReturnStats,
  // structural-level outcome study (build 2026.07.24-10): does detectLevels output actually hold?
  normCdf, touchBaseline, studyBars, levelOutcomes, levelStudy, LVL_EDGES, PLACEBO_K,
  // session anatomy (build 2026.07.24-11): excursion / open-quartile / Monday range / naked opens
  sessionRecords, anatomyEnrich, mondayStats, nakedStats, anatomyPool, MFE_EDGES, NAKED_HORIZONS,
  // ledger shadow pair (build 2026.07.24-12): outsized-wick fill + round-number front-run
  detectWickFill, detectRoundFront, roundStep,
  // candle behaviour + time pivots + per-ticker scopes (build 2026.07.24-13)
  candleType, candleEvents, candlePool, pivotPool, anatomyTickerSummary, CANDLE_TYPES, PIVOT_EARLY_H,
  // crypto signal engine (build 2026.07.26-08): log-space claim geometry + crypto horizons
  logLevel, logExtend, claimGeometryOk, clusterDays, evMeta, capPerUniverse, tradeableNow, EV_META_MAIN };

// ---- stop geometry validation ----------------------------------------------------------------
// An invalidation level must sit on the LOSS side of entry: below the mark for a long, above it
// for a short. A composite signal can legitimately fire away from the range edge its playbook
// levels assume (e.g. a squeeze firing on crowding + fuel with the trigger term ~0, price near
// the range BOTTOM) — mechanically computed levels then land on the wrong side of entry, and a
// stop above a long's entry turns the stop-aware track into a win fabricator: the first candle
// "touches" it and a crash gets capped at +X%. Every stop must pass this gate before it is
// stamped, resolved against, or kept.
function stopGeometryOk(side, mark0, stp) {
  if (stp == null || !(mark0 > 0)) return false;
  if (side === "long") return stp < mark0;
  if (side === "short") return stp > mark0;
  return false;
}

// ---- log-space claim geometry (the crypto gate) -----------------------------------------------
// stopGeometryOk above answers one question — is the void on the loss side — and that was enough
// for a universe whose daily sigma is ~1-2%. It is NOT enough at 12-40%/day: additive level
// arithmetic (`lo30 - 0.382 * (hi30 - lo30)`, `px * (1 - k*sd/100)`) produces negative prices,
// voids multiples of price away, and targets that are pure artifact. That is the exact failure
// that retired the crypto engine at -101; it was an arithmetic bug, not a statistical verdict.
//
// Two primitives replace the arithmetic:
//   logLevel(px, k, sd) — a k-sigma offset as a RATIO, px*exp(k*sd/100). First-order identical to
//                         px*(1 + k*sd/100) at equity sigma, and provably positive at any sigma.
//   logExtend(from, k, lo, hi) — extend a level by k spans of the lo..hi range, measured in log
//                         space, so "0.382 of the range below the low" can never cross zero.
// And one gate, claimGeometryOk, which every crypto claim must clear before its levels are
// stamped: the void strictly on the loss side, the target strictly on the profit side, both
// inside a 3x band of the mark, and the void between 0.1 and 5 sigma out. Closer than 0.1σ is
// noise wearing a stop's clothing (the first candle takes it); further than 5σ is a different
// thesis. A claim that fails the gate still LEDGERS — it just carries no stop-aware leg and no
// target, resolving at-horizon only. Refusing the level is the honest degradation; inventing one
// is what fabricated wins last time.
//
// Deliberately scoped to crypto. The xyz record was earned under the additive geometry, and
// silently changing the formula mid-record would make every future claim incomparable to the
// hundreds already resolved. One universe, one geometry, forever comparable.
const GEO_MIN_SD = 0.1;             // void floor in daily-sigma units
const GEO_MAX_SD = 5;               // void ceiling in daily-sigma units
const GEO_MAX_LN = Math.log(3);     // no level further than a 3x band from the mark
function logLevel(px, kSigma, sdPct) {
  if (!(px > 0) || !Number.isFinite(kSigma)) return null;
  const s = sdPct > 0 ? sdPct : 1;
  const v = px * Math.exp((kSigma * s) / 100);
  return Number.isFinite(v) && v > 0 ? +v.toPrecision(6) : null;
}
function logExtend(from, k, lo, hi) {
  if (!(from > 0) || !Number.isFinite(k) || !(lo > 0) || !(hi > lo)) return null;
  const v = from * Math.exp(k * Math.log(hi / lo));
  return Number.isFinite(v) && v > 0 ? +v.toPrecision(6) : null;
}
function claimGeometryOk(side, px, stop, target, sdPct, opts) {
  const o = opts || {};
  if (!(px > 0) || (side !== "long" && side !== "short")) return false;
  const sgn = side === "long" ? 1 : -1;
  const minSd = o.minSd > 0 ? o.minSd : GEO_MIN_SD;
  const maxSd = o.maxSd > 0 ? o.maxSd : GEO_MAX_SD;
  const maxLn = o.maxLn > 0 ? o.maxLn : GEO_MAX_LN;
  if (stop != null) {
    if (!Number.isFinite(+stop) || !(+stop > 0)) return false;
    const d = Math.log(+stop / px);
    if (sgn * d >= 0) return false;                     // must be strictly on the loss side
    if (Math.abs(d) > maxLn) return false;              // outside the 3x band: artifact, not a level
    if (sdPct > 0) {
      const sd = (Math.abs(d) * 100) / sdPct;
      if (sd < minSd || sd > maxSd) return false;
    }
  }
  if (target != null) {
    if (!Number.isFinite(+target) || !(+target > 0)) return false;
    const d = Math.log(+target / px);
    if (sgn * d <= 0) return false;                     // must be strictly on the profit side
    if (Math.abs(d) > maxLn) return false;
  }
  return true;
}
// Per-universe transport lanes. A single global top-N cap is not universe-neutral once both
// universes are enrolled: crypto's daily sigma is 5-20x the equity side's, so its intensity terms
// (which are sigma multiples) are structurally larger and a plain sort would hand the whole payload
// to perps on any volatile day — the equity board would disappear from its own tab without a single
// error. Each universe fills its own budget by score, and the merged list is re-sorted so the
// client's ordering is still globally meaningful. Retired at -101 when only one universe existed;
// back at 2026.07.26-08 for exactly the reason it was written.
function capPerUniverse(sigs, xyzMax, mainMax) {
  if (!Array.isArray(sigs)) return [];
  const nx = xyzMax > 0 ? xyzMax : 40, nm = mainMax > 0 ? mainMax : 40;
  const x = [], m = [];
  for (const g of sigs) {
    if (!g) continue;
    if (g.uni === "main") { if (m.length < nm) m.push(g); }
    else if (x.length < nx) x.push(g);
  }
  return x.concat(m).sort((a, b) => (b.score || 0) - (a.score || 0));
}
// Distinct UTC calendar days spanned by a set of claims. Sixty perps at ~0.8 correlation to BTC
// do not produce sixty independent observations when they all fire on the same red day — this is
// what lets the accuracy panel say "n=112 across 9 tape days" instead of implying 112 draws.
function clusterDays(entries) {
  if (!Array.isArray(entries) || !entries.length) return 0;
  const d = new Set();
  for (const e of entries) { const t = e && +e.t0; if (Number.isFinite(t) && t > 0) d.add(Math.floor(t / 86400000)); }
  return d.size;
}
// Declared with const, so they cannot ride the hoisted function list in the main exports object.
module.exports.GEO_MIN_SD = GEO_MIN_SD;
module.exports.GEO_MAX_SD = GEO_MAX_SD;
module.exports.GEO_MAX_LN = GEO_MAX_LN;

// ---- play-signed stats for fade playbooks ------------------------------------------------------
// The gap study is EVENT-signed: positive = the gap continued. For a market whose record says
// gaps FADE (proven, median < 0), the playbook trades the OTHER side — so every consumer of the
// stats must flip into play units or three things break at once: the evidence scorer tags the
// engine's best fade setups `neg exp` and suppresses them, prime can never fire on them, and the
// ledgered claim/outcome audit runs inverted (a successful fade recorded as a loss). Returns a
// shallow play-signed copy: med/avg negated, hit complemented, `fade: true` stamped. Never
// mutates the study object (it is shared with feature/display state).
function fadeStats(st) {
  if (!st) return st;
  const c = Object.assign({}, st, { fade: true });
  if (Number.isFinite(st.med)) c.med = +(-st.med).toFixed(2);
  if (Number.isFinite(st.avg)) c.avg = +(-st.avg).toFixed(2);
  if (Number.isFinite(st.hit)) c.hit = +(1 - st.hit).toFixed(2);
  return c;
}

// ---- earnings calendar helpers -----------------------------------------------------------------
// BMO/AMC are ET concepts, so "today"/"tomorrow" for earnings proximity are ET CALENDAR DAYS —
// never the browser's or server's local day. Reuses the same Intl-backed ET clock as the session
// calendar above, so a report never flips days at the wrong hour for a non-US viewer.
function etDayStr(ms) {
  const p = etParts(ms != null ? ms : Date.now());
  return p.y + "-" + String(p.mo).padStart(2, "0") + "-" + String(p.d).padStart(2, "0");
}
// Whole-day distance of a YYYY-MM-DD report date from the CURRENT ET day: 0 = today, 1 = tomorrow,
// negative = already passed. Both sides anchored to UTC midnight of their calendar date, so DST
// transitions can never produce a fractional day.
function earnDayDiff(dateStr, nowMs) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const a = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
  const t = etDayStr(nowMs);
  const b = Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10));
  return Math.round((a - b) / DAY);
}
// State of ONE calendar entry relative to now: "reported" once the print is out, "upcoming" while
// it is still ahead. The report window reaches days BACK, so a same-day AMC row lingers in the
// feed with diff 0 long after the company has printed — handing it to the analyst as an upcoming
// binary was the "earnings after close today" bug (the report braced for an event that already
// happened). "Out" = the actual has landed (epsA present, unambiguous) OR the ET session clock has
// passed: AMC/DMH after the 16:00 close, BMO after the 09:30 open, ANY prior ET day unconditionally.
// A same-day TBD (session unknown) has no clock to trust, so it stays "upcoming" until its actual
// lands or the ET day rolls over — the honest choice, never a guessed timestamp. Pure and
// ET-anchored (reuses the Intl clock), so it never flips at the wrong hour for a non-US server.
function earnEntryState(entry, nowMs) {
  if (!entry || typeof entry.d !== "string") return "upcoming";
  if (entry.epsA != null) return "reported";
  const diff = earnDayDiff(entry.d, nowMs);
  if (diff == null) return "upcoming";
  if (diff < 0) return "reported";
  if (diff > 0) return "upcoming";
  const et = etParts(nowMs != null ? nowMs : Date.now());
  const past = (h, mi) => et.h > h || (et.h === h && et.mi >= mi);
  const s = entry.s || "TBD";
  if (s === "BMO") return past(9, 30) ? "reported" : "upcoming";          // out by the open
  if (s === "AMC" || s === "DMH") return past(16, 0) ? "reported" : "upcoming";   // out by the close
  return "upcoming";                                                      // TBD same-day: actual-present only
}
// Finnhub /calendar/earnings -> compact entries for OUR universe only. symMap: UPPERCASED api
// symbol -> { coin, ticker } (the alias map is applied by the caller when building symMap, so a
// BRK.B report lands back on the BRKB row). Everything outside the map is discarded — the payload
// never claims coverage it doesn't have. Sessions normalize to BMO / DMH / AMC / TBD and entries
// sort by (date, session order within the day, ticker) so "first per ticker" = nearest report.
const EARN_SESS = { bmo: "BMO", amc: "AMC", dmh: "DMH" };
const EARN_SESS_ORD = { BMO: 0, DMH: 1, AMC: 2, TBD: 3 };
function parseEarningsCalendar(json, symMap) {
  const arr = json && Array.isArray(json.earningsCalendar) ? json.earningsCalendar : [];
  const out = [];
  for (const e of arr) {
    if (!e || typeof e.symbol !== "string" || typeof e.date !== "string") continue;
    const m = symMap.get(e.symbol.toUpperCase());
    if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
    // 4 decimal places, NOT 2: the feed's estimates carry real information in the 3rd/4th
    // decimal for low-EPS names. 2dp collapsed the live NFLX print (actual 0.8000 vs est 0.8042,
    // a genuine -0.5% miss) into "0.8 vs 0.8 miss +0.0%" — a display contradicting its own
    // verdict. Verdict and surprise must be computed from values that preserve the difference.
    const q2 = (x) => typeof x === "number" && isFinite(x) ? +x.toFixed(4) : null;
    const eps = q2(e.epsEstimate), epsA = q2(e.epsActual);
    // Revenue ships in raw units (feed reports dollars); quantize to 3 significant figures —
    // the display only ever shows "$41.2B", full doubles are payload weight for nothing.
    const q3 = (x) => typeof x === "number" && isFinite(x) && x !== 0 ? +x.toPrecision(3) : null;
    const rev = q3(e.revenueEstimate), revA = q3(e.revenueActual);
    // Fiscal print identity (quarter/year) rides along: it is the ONLY safe way to tell "this
    // ticker's report moved to a later date" (drop the stale placeholder) from "this ticker
    // reports twice in the window" (keep both). Absent from old persisted prints — consumers
    // must treat missing q/y as unknown, never as a match.
    const q = Number.isInteger(e.quarter) ? e.quarter : null, y = Number.isInteger(e.year) ? e.year : null;
    out.push({ coin: m.coin, t: m.ticker, d: e.date, s: EARN_SESS[String(e.hour || "").toLowerCase()] || "TBD", eps, epsA, rev, revA, q, y });
  }
  out.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : (EARN_SESS_ORD[a.s] - EARN_SESS_ORD[b.s]) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out;
}
// Recently-reported window for the Earnings tab: prints whose ET calendar day is in the past
// `backDays` days (default 2 — "yesterday" and "2 days ago"; today's reported rows already live
// in the upcoming entries with diff 0). Sorted most-recent day FIRST, chronological session
// order within a day, ticker as tiebreak. Pure — the poller derives this from the persisted
// print history at cache-build time, so a report keeps its beat/miss on the tab for two full
// days after the print instead of vanishing at the ET midnight rollover.
function recentEarnPrints(prints, nowMs, backDays) {
  const bd = backDays != null ? backDays : 2;
  const out = [];
  if (Array.isArray(prints)) for (const p of prints) {
    if (!p || typeof p.d !== "string") continue;
    const df = earnDayDiff(p.d, nowMs);
    if (df != null && df < 0 && df >= -bd) out.push(p);
  }
  out.sort((a, b) => a.d > b.d ? -1 : a.d < b.d ? 1
    : ((EARN_SESS_ORD[a.s] != null ? EARN_SESS_ORD[a.s] : 3) - (EARN_SESS_ORD[b.s] != null ? EARN_SESS_ORD[b.s] : 3))
    || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out;
}
// Disjoint inclusive [from, to] ET-day chunks covering [fromMs, toMs]. The free-tier calendar
// TRUNCATES long windows served far-end-first (observed live 2026-07-16: a 19-day earnings-season
// window returned only Jul 22–30 and silently dropped a same-day NFLX report carrying actuals),
// so every calendar pull must walk small date slices. Chunks may overlap by one day across a DST
// boundary — callers dedupe by ticker+date, so overlap is harmless and coverage gaps are not.
function earnChunks(fromMs, toMs, chunkDays) {
  const cd = Math.max(1, chunkDays || 3), out = [];
  for (let a = fromMs; a <= toMs; a += cd * DAY) out.push([etDayStr(a), etDayStr(Math.min(a + (cd - 1) * DAY, toMs))]);
  return out;
}
// A past print is STALE-SCHEDULE GARBAGE when the fresh feed still shows the same ticker
// scheduled at a FUTURE date for the same fiscal print: the feed dated the row from an estimate,
// the company picked a later real date, and the placeholder scrolled behind today wearing numbers
// it never earned (observed live: IBM persisted at 2026-07-14 "with actuals" while IBM's real Q2
// date is 2026-07-22 per IBM IR — and the phantom fed the reaction study). Drop rule: past print
// + future schedule for the same ticker + (same quarter/year, or, for legacy prints stored before
// quarter capture, future date within 10 days of the print date — no quarterly reporter prints
// twice in 10 days). ABSENCE is never evidence: a symbol missing from one fetch (the truncation
// failure mode that motivated chunking) must not delete history.
function purgeStalePrints(prints, parsed, nowMs) {
  if (!Array.isArray(prints) || !prints.length || !Array.isArray(parsed) || !parsed.length) return prints || [];
  const fut = new Map();
  for (const e of parsed) {
    const df = earnDayDiff(e.d, nowMs);
    if (df != null && df > 0) { let a = fut.get(e.t); if (!a) { a = []; fut.set(e.t, a); } a.push(e); }
  }
  if (!fut.size) return prints;
  const dUtc = (ds) => Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10));
  return prints.filter((p) => {
    const df = earnDayDiff(p.d, nowMs);
    if (df == null || df >= 0) return true;
    const a = fut.get(p.t);
    if (!a) return true;
    for (const e of a) {
      if (p.q != null && p.y != null && e.q != null && e.y != null) {
        if (e.q === p.q && e.y === p.y) return false;
      } else {
        const gap = Math.round((dUtc(e.d) - dUtc(p.d)) / DAY);
        if (gap > 0 && gap <= 10) return false;
      }
    }
    return true;
  });
}
// Back-window existence reconciliation. With chunked pulls the fetched window is complete by
// construction, so within the REFETCHED back range [now-backDays, now-1] the feed's current
// claim is authoritative for which prints EXIST: a persisted print the feed no longer lists
// there was retracted or corrected upstream — dropped. This catches the phantom class where the
// feed carries NO corrected future row for the reschedule rule to fire on (the live IBM case:
// phantom at Jul 14, and Finnhub lists nothing for IBM at its real Jul 22 date either).
// Self-healing both ways — a print the feed re-asserts on a later pull is simply re-merged.
// Prints OLDER than the back window are NEVER touched: history that can no longer be re-fetched
// is never deleted on absence. An empty parse purges nothing (a zero-row 19-day window is a
// broken fetch, not evidence).
function reconcileEarnPrints(prints, parsed, nowMs, backDays) {
  const bd = backDays != null ? backDays : 5;
  if (!Array.isArray(prints) || !prints.length || !Array.isArray(parsed) || !parsed.length) return prints || [];
  const have = new Set();
  for (const e of parsed) have.add(e.t + "|" + e.d);
  return prints.filter((p) => {
    const df = earnDayDiff(p.d, nowMs);
    if (df == null || df >= 0 || df < -bd) return true;
    return have.has(p.t + "|" + p.d);
  });
}
module.exports.etDayStr = etDayStr;
module.exports.mergeNews = mergeNews;
module.exports.newsRelevant = newsRelevant;
module.exports.newsAttributes = newsAttributes;
module.exports.COMMON_WORD = COMMON_WORD;
module.exports.parseTgPreview = parseTgPreview;
module.exports.attributeTg = attributeTg;
module.exports.parseEdgarAtom = parseEdgarAtom;
module.exports.FILINGS_TTL_MS = FILINGS_TTL_MS;
module.exports.linkEarningsFilings = linkEarningsFilings;
module.exports.bustAssetTags = bustAssetTags;
module.exports.NEWS_TTL_MS = NEWS_TTL_MS;
module.exports.earnDayDiff = earnDayDiff;
module.exports.earnEntryState = earnEntryState;
module.exports.parseEarningsCalendar = parseEarningsCalendar;
module.exports.recentEarnPrints = recentEarnPrints;
module.exports.earnChunks = earnChunks;
module.exports.purgeStalePrints = purgeStalePrints;
module.exports.reconcileEarnPrints = reconcileEarnPrints;

// ---- earnings print history + reaction study ---------------------------------------------------
// Past prints are the raw material for the per-ticker reaction study. Like the OI log, they
// accrue and can't be re-fetched reliably (the feed's historical depth is not guaranteed), so
// every print that passes is persisted. Merge prefers the record that carries ACTUALS — a print
// first seen as a schedule entry gets upgraded in place when the actual lands on a later fetch.
function mergeEarnPrints(prev, incoming, nowMs, maxAgeDays) {
  const cut = (nowMs != null ? nowMs : Date.now()) - (maxAgeDays || 1100) * DAY;
  const m = new Map();
  const fill = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const p of arr) {
      if (!p || typeof p.t !== "string" || typeof p.d !== "string") continue;
      if (Date.UTC(+p.d.slice(0, 4), +p.d.slice(5, 7) - 1, +p.d.slice(8, 10)) < cut) continue;
      const k = p.t + "|" + p.d;
      const old = m.get(k);
      // newer wins field-by-field ONLY where it actually has data — an actual, once stored,
      // can never be blanked by a later fetch that dropped it.
      m.set(k, old ? { t: p.t, coin: p.coin || old.coin, d: p.d, s: p.s !== "TBD" ? p.s : old.s,
        eps: p.eps != null ? p.eps : old.eps, epsA: p.epsA != null ? p.epsA : old.epsA,
        rev: p.rev != null ? p.rev : old.rev, revA: p.revA != null ? p.revA : old.revA,
        q: p.q != null ? p.q : old.q, y: p.y != null ? p.y : old.y } : p);
    }
  };
  fill(prev); fill(incoming);
  const out = [...m.values()];
  out.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : (a.t < b.t ? -1 : 1));
  return out;
}
// Per-ticker earnings reaction study, computed on the perp's OWN daily closes (UTC days — the
// perp trades through weekends, so an AMC Friday print's reaction is honestly captured by the
// Saturday candle). Reaction day: BMO/DMH/TBD = the print's own candle vs the prior close;
// AMC = the NEXT candle. Candles may be warm-cache [{t,c}] without opens — the gap metrics
// (open vs prior close, held-to-close) compute only where opens exist and report their own n.
// Expansion = |reaction| / mean |daily move| over the 20 candles before the print (>=8 required).
function earnReactionsFor(prints, daily) {
  if (!Array.isArray(prints) || !prints.length || !Array.isArray(daily) || daily.length < 3) return null;
  const dayOf = (t) => { const x = new Date(t); return x.getUTCFullYear() + "-" + String(x.getUTCMonth() + 1).padStart(2, "0") + "-" + String(x.getUTCDate()).padStart(2, "0"); };
  const idxByDay = new Map();
  for (let i = 0; i < daily.length; i++) if (daily[i] && Number.isFinite(daily[i].c)) idxByDay.set(dayOf(daily[i].t), i);
  const moves = [], exps = [], gaps = [];
  for (const p of prints) {
    const pi = idxByDay.get(p.d);
    if (pi == null) continue;                                    // print predates the retained daily window
    const ri = p.s === "AMC" ? pi + 1 : pi;
    if (ri <= 0 || ri >= daily.length) continue;
    const c1 = daily[ri].c, c0 = daily[ri - 1].c;
    if (!Number.isFinite(c1) || !Number.isFinite(c0) || c0 <= 0) continue;
    const mv = (c1 - c0) / c0 * 100;
    moves.push(mv);
    let base = 0, bn = 0;
    for (let k = Math.max(1, ri - 20); k < ri; k++) {
      const a = daily[k].c, b = daily[k - 1].c;
      if (Number.isFinite(a) && Number.isFinite(b) && b > 0) { base += Math.abs((a - b) / b * 100); bn++; }
    }
    if (bn >= 8 && base > 0) exps.push(Math.abs(mv) / (base / bn));
    const o = daily[ri].o;
    if (Number.isFinite(o) && o > 0) {
      const g = (o - c0) / c0 * 100;
      if (Math.abs(g) > 0.05) gaps.push({ up: g > 0, held: (c1 - o) * g > 0 });
    }
  }
  if (!moves.length) return null;
  const abs = moves.map(Math.abs);
  return {
    n: moves.length,
    avgAbs: +(abs.reduce((a, b) => a + b, 0) / abs.length).toFixed(2),
    medAbs: +median(abs).toFixed(2),
    up: moves.filter((m) => m > 0).length,
    xMed: exps.length ? +median(exps).toFixed(1) : null, xN: exps.length,
    gapN: gaps.length, gapUp: gaps.filter((g) => g.up).length, gapHeld: gaps.filter((g) => g.held).length,
  };
}
module.exports.mergeEarnPrints = mergeEarnPrints;
module.exports.earnReactionsFor = earnReactionsFor;

// ===== Coinalyze derivatives context (crypto universe) ==========================================
// Pure math over the packed deriv rows [ts, longLiqUsd, shortLiqUsd, oiUsd]. Fetch/assembly lives
// in poller.js; nothing here touches I/O. USD values arrive source-converted (Coinalyze
// convert_to_usd) and are aggregated CEX data — labeling stays honest downstream.

// Merge freshly fetched rows into an existing sorted series, deduping by timestamp (last write
// wins — a re-fetched overlapping bucket may have grown). Returns a NEW sorted array and whether
// anything changed, so callers can gate content-clock bumps on real change.
function czMergeHistory(existing, incoming) {
  const base = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  if (!inc.length) return { rows: base, changed: false };
  const m = new Map();
  for (const r of base) if (Array.isArray(r) && Number.isFinite(r[0])) m.set(r[0], r);
  let changed = false;
  for (const r of inc) {
    if (!Array.isArray(r) || !Number.isFinite(r[0])) continue;
    const prev = m.get(r[0]);
    if (!prev || prev[1] !== r[1] || prev[2] !== r[2] || prev[3] !== r[3]) { m.set(r[0], r); changed = true; }
  }
  if (!changed) return { rows: base, changed: false };
  const rows = [...m.values()].sort((a, b) => a[0] - b[0]);
  return { rows, changed: true };
}

// Cascade flag: a liquidation bucket is a cascade when the side's liquidation notional spikes
// vs its OWN trailing distribution AND open interest drops in the same bucket — forced flow
// that actually cleared positioning, not just a busy bar. Honest-null: below minSamples of
// trailing history the bucket can't be judged and is silently skipped (never guessed).
function cascadeFlags(rows, opts) {
  const o = opts || {};
  const look = o.look || 96;                 // trailing buckets in the baseline (96 x 15min = 24h)
  const minSamples = o.minSamples || 24;     // don't judge against a thinner baseline than this
  const z = o.z || 3;                        // spike threshold in trailing std devs
  const minUsd = o.minUsd || 250000;         // absolute floor — a z-spike on dust is not a cascade
  const oiDropPct = o.oiDropPct || 1.0;      // OI must fall at least this % bucket-over-bucket
  const out = [];
  if (!Array.isArray(rows) || rows.length < minSamples + 1) return out;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r)) continue;
    const oiPrev = rows[i - 1][3], oiNow = r[3];
    if (!Number.isFinite(oiPrev) || !Number.isFinite(oiNow) || oiPrev <= 0) continue;
    const doiPct = (oiNow / oiPrev - 1) * 100;
    if (doiPct > -oiDropPct) continue;       // no positioning cleared — whatever the liq bar was, not a cascade
    for (const side of [1, 2]) {             // 1 = longs liquidated (down-cascade), 2 = shorts (up-cascade)
      const v = r[side];
      if (!Number.isFinite(v) || v < minUsd) continue;
      let s = 0, s2 = 0, n = 0;
      for (let k = Math.max(1, i - look); k < i; k++) {
        const w = rows[k] && rows[k][side];
        if (Number.isFinite(w)) { s += w; s2 += w * w; n++; }
      }
      if (n < minSamples) continue;
      const mean = s / n, va = Math.max(0, s2 / n - mean * mean), sd = Math.sqrt(va);
      if (v >= mean + z * Math.max(sd, mean * 0.25) ) {
        out.push({ t: r[0], side: side === 1 ? "long" : "short",
          liq: Math.round(v), doiPct: +doiPct.toFixed(2) });
      }
    }
  }
  return out;
}

// 24h rollup for the drawer chips: liq totals per side, latest OI, and OI change vs ~24h ago
// (nearest stored bucket at or before the cutoff — an honest null when coverage is thinner).
function derivRollup(rows, now) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const cut = (Number.isFinite(now) ? now : Date.now()) - 24 * 3600 * 1000;
  let ll = 0, sl = 0, oiRef = null;
  for (const r of rows) {
    if (!Array.isArray(r) || !Number.isFinite(r[0])) continue;
    if (r[0] <= cut) { if (Number.isFinite(r[3])) oiRef = r[3]; continue; }
    if (Number.isFinite(r[1])) ll += r[1];
    if (Number.isFinite(r[2])) sl += r[2];
  }
  const last = rows[rows.length - 1];
  const oi = last && Number.isFinite(last[3]) ? last[3] : null;
  const doi24 = oi != null && oiRef != null && oiRef > 0 ? +((oi / oiRef - 1) * 100).toFixed(2) : null;
  return { ll24: Math.round(ll), sl24: Math.round(sl), oi: oi != null ? Math.round(oi) : null, doi24 };
}

// Display aggregation: 15-min rows -> hourly buckets (liqs summed, OI = last sample in the
// bucket). Raw 15-min stays in the store for the cascade math; the drawer chart reads this.
function aggDerivHourly(rows) {
  const out = [];
  if (!Array.isArray(rows)) return out;
  let cur = null;
  for (const r of rows) {
    if (!Array.isArray(r) || !Number.isFinite(r[0])) continue;
    const hb = Math.floor(r[0] / 3600000) * 3600000;
    if (!cur || cur[0] !== hb) { cur = [hb, 0, 0, null]; out.push(cur); }
    if (Number.isFinite(r[1])) cur[1] += r[1];
    if (Number.isFinite(r[2])) cur[2] += r[2];
    if (Number.isFinite(r[3])) cur[3] = r[3];
  }
  for (const b of out) { b[1] = Math.round(b[1]); b[2] = Math.round(b[2]); if (b[3] != null) b[3] = Math.round(b[3]); }
  return out;
}
// ---- cascade exhaustion (the crypto-native ledger event) --------------------------------------
// cascadeFlags above answers "did forced flow clear positioning". This turns the most recent such
// bucket into a tradeable claim with geometry the tape actually printed, no sigma construction and
// therefore nothing for claimGeometryOk to clamp:
//   long-side cascade  (longs force-sold, price down) -> LONG the exhaustion
//     void   = the flush LOW across the cascade window (a new low says it was continuation)
//     target = the pre-cascade level (the close of the last bar before the cascade bucket)
//   short-side cascade (shorts force-bought, price up) -> SHORT the exhaustion, mirrored
// Gates: the cascade must be aged enough that the dust settled (minAgeMs) and fresh enough to
// still be the operative structure (maxAgeMs), and the mark must sit strictly BETWEEN the flush
// extreme and the pre-cascade level — beyond the extreme the thesis is already dead, past the
// level the move is already made. Both checks are what stop this from firing on stale history.
//   casc  : one flag from cascadeFlags — { t, side, liq, doiPct }
//   hours : hourly candles [t,o,h,l,c,v] ascending (the price spine)
function detectCascExhaust(casc, hours, px, opts) {
  const o = opts || {};
  const minAge = o.minAgeMs > 0 ? o.minAgeMs : 3600000;            // 1h
  const maxAge = o.maxAgeMs > 0 ? o.maxAgeMs : 24 * 3600000;       // 24h
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  if (!casc || !Array.isArray(hours) || hours.length < 4 || !(px > 0)) return null;
  const t = +casc.t;
  if (!Number.isFinite(t)) return null;
  const age = now - t;
  if (!(age >= minAge && age <= maxAge)) return null;
  const long = casc.side === "long";                               // longs were liquidated
  if (!long && casc.side !== "short") return null;
  // the flush window: the hour containing the cascade bucket plus the two that follow
  const wFrom = Math.floor(t / 3600000) * 3600000, wTo = wFrom + 3 * 3600000;
  let ext = null, pre = null;
  for (const k of hours) {
    const kt = +k[0];
    if (!Number.isFinite(kt)) continue;
    if (kt < wFrom) { const c = +k[4]; if (Number.isFinite(c) && c > 0) pre = c; continue; }
    if (kt > wTo) break;
    const hi = +k[2], lo = +k[3], c = +k[4];
    const h = Number.isFinite(hi) && hi > 0 ? hi : c, l = Number.isFinite(lo) && lo > 0 ? lo : c;
    if (long) { if (Number.isFinite(l) && l > 0 && (ext == null || l < ext)) ext = l; }
    else { if (Number.isFinite(h) && h > 0 && (ext == null || h > ext)) ext = h; }
  }
  if (!(ext > 0) || !(pre > 0)) return null;                       // no flush wick, or no pre-cascade level
  if (long ? !(pre > ext) : !(pre < ext)) return null;             // the cascade did not move price the way its side implies
  if (long ? !(px > ext && px < pre) : !(px < ext && px > pre)) return null;
  return { side: long ? "long" : "short", stop: +ext.toPrecision(6), target: +pre.toPrecision(6),
    level: +pre.toPrecision(6), ageMs: age, liq: casc.liq != null ? casc.liq : null,
    doiPct: casc.doiPct != null ? casc.doiPct : null };
}
// Most recent flag within `withinMs`, or null. Small helper so the fire site never has to reason
// about ordering (cascadeFlags emits ascending, and both sides can flag the same bucket).
function latestCascade(flags, now, withinMs) {
  if (!Array.isArray(flags) || !flags.length) return null;
  const cut = (Number.isFinite(now) ? now : Date.now()) - (withinMs > 0 ? withinMs : 24 * 3600000);
  let best = null;
  for (const f of flags) { if (!f || !Number.isFinite(+f.t) || +f.t < cut) continue; if (!best || +f.t > +best.t) best = f; }
  return best;
}
module.exports.czMergeHistory = czMergeHistory;
module.exports.cascadeFlags = cascadeFlags;
module.exports.derivRollup = derivRollup;
module.exports.aggDerivHourly = aggDerivHourly;
module.exports.detectCascExhaust = detectCascExhaust;
module.exports.latestCascade = latestCascade;

// ---- actionable board: carry-netting, expectancy, merge/rank (build 2026.07.26-01) ----------
// Swing scope is days-to-weeks off D1/H12/H4, and at that horizon perpetual funding stops being
// noise and becomes a P&L line item: a 3-week hold on a crowded long at 45% APR donates ~2.6% of
// notional to carry before the trade does anything, which against a 5% stop is half an R. So the
// board's headline reward:risk is NET of expected carry, and the gross figure rides along for
// disclosure. Every function here is pure — the poller does assembly only, and the board reads
// the OPEN LEDGER's already-frozen side/void/target rather than re-deriving any geometry.
const CARRY_YEAR_MS = 365 * 24 * 3600 * 1000;
const ACT_TF_RANK = { D1: 3, H12: 2, H4: 1, H1: 0 };
const ACT_TF_MS = { D1: 86400000, H12: 12 * 3600000, H4: 4 * 3600000, H1: 3600000 };

// Funding carried over one hold, expressed in R — the trade's own risk unit, so it is directly
// comparable across a 2%-stop name and a 12%-stop one. Sign convention is the venue's: positive
// funding means LONGS PAY shorts, so a long bleeds carry and a short is paid to wait. Honest null
// when any leg is missing — a zero here would read as "no carry", which is a different claim.
function carryR(o) {
  if (!o) return null;
  const side = o.side, entry = +o.entry, stop = +o.stop, hz = +o.horizonMs, fh = o.fundingHourly;
  if (side !== "long" && side !== "short") return null;
  if (!(entry > 0) || !(stop > 0) || !(hz > 0)) return null;
  if (fh == null || !Number.isFinite(+fh)) return null;
  const riskPct = (Math.abs(entry - stop) / entry) * 100;
  if (!(riskPct > 0)) return null;
  const aprPct = +fh * 24 * 365 * 100;
  const costPct = aprPct * (hz / CARRY_YEAR_MS);          // what a LONG pays across the hold
  const effectPct = side === "long" ? -costPct : costPct;  // a short receives the same amount
  return { aprPct: +aprPct.toFixed(2), costPct: +costPct.toFixed(3), r: +(effectPct / riskPct).toFixed(3) };
}

// Gross and funding-net reward:risk for one frozen geometry. Carry folds into the REWARD leg
// only — the risk leg is the distance to the void, which funding does not move. Returns null on
// any geometry that isn't tradeable from here (void on the wrong side, target already through),
// which is what silently expires a setup the market has walked away from.
function netRR(o) {
  if (!o) return null;
  const side = o.side, entry = +o.entry, stop = +o.stop, target = +o.target;
  if (side !== "long" && side !== "short") return null;
  if (!(entry > 0) || !(stop > 0) || !(target > 0)) return null;
  if (!stopGeometryOk(side, entry, stop)) return null;
  if (side === "long" ? !(target > entry) : !(target < entry)) return null;
  const riskPct = (Math.abs(entry - stop) / entry) * 100;
  const rewardPct = (Math.abs(target - entry) / entry) * 100;
  if (!(riskPct > 0) || !(rewardPct > 0)) return null;
  return { riskPct: +riskPct.toFixed(3), rewardPct: +rewardPct.toFixed(3), gross: +(rewardPct / riskPct).toFixed(2) };
}
// Is this claim still takeable at the live mark? A separate question from what the geometry
// claimed at fire, and it keeps its own answer: the void can be tagged or the target already
// through while the frozen ratio remains exactly what it always was. Folding these two together
// is what let a dead-or-drifted setup keep scoring against fire-time numbers.
function tradeableNow(side, px, stop, target) {
  if (!(px > 0) || !(stop > 0) || !(target > 0)) return false;
  if (!stopGeometryOk(side, px, stop)) return false;                 // void already on the wrong side
  return side === "long" ? target > px : target < px;                // target already through
}

// Expectancy in R for ONE instance: the event's out-of-sample hit rate applied to THIS instance's
// net geometry — a win takes the net reward, a loss takes the void for -1R. Deliberately not the
// historical average realized R, which answers a different question (how past fires went) than
// the one the board asks (what entering this one here is worth). Null below the record floor.
function setupEV(hit, rr, n, minN) {
  if (hit == null || !Number.isFinite(+hit)) return null;
  if (rr == null || !Number.isFinite(+rr)) return null;
  if (minN != null && (n == null || n < minN)) return null;
  return +(+hit * +rr - (1 - +hit)).toFixed(3);
}

// Bars in trigger, in the bars of the setup's OWN timeframe. A daily retest on its ninth bar is
// not the same animal as one on its first, and at swing horizon that difference is the whole
// question of whether you are early or late.
function barsInTrigger(t0, now, tf) {
  const w = ACT_TF_MS[tf] || ACT_TF_MS.D1;
  if (!(t0 > 0) || !(now > 0) || now < t0) return null;
  return Math.floor((now - t0) / w);
}

// Precedence when one name fires several confirmed setups at once. Every candidate reaching this
// point has already cleared the confirmed gate, so there is no proven/unproven tier left to break:
// it is expectancy, then the higher timeframe, then the earlier fire.
function actionableBetter(a, b) {
  if (!a) return false;
  if (!b) return true;
  const ae = a.evR == null ? -Infinity : a.evR, be = b.evR == null ? -Infinity : b.evR;
  if (ae !== be) return ae > be;
  const at = ACT_TF_RANK[a.tf] == null ? -1 : ACT_TF_RANK[a.tf];
  const bt = ACT_TF_RANK[b.tf] == null ? -1 : ACT_TF_RANK[b.tf];
  if (at !== bt) return at > bt;
  return (a.t0 || 0) < (b.t0 || 0);
}

// Collapse simultaneous fires on one name+side into ONE row: you take one position per name per
// side, and two detectors agreeing is corroboration, not two trades. The losers ride along in
// `also` as labels only — never their levels, so the row's geometry has exactly one author.
function mergeActionable(cands) {
  if (!Array.isArray(cands)) return [];
  const win = new Map();
  for (const c of cands) {
    if (!c || !c.coin || (c.side !== "long" && c.side !== "short")) continue;
    const k = c.coin + "|" + c.side;
    if (actionableBetter(c, win.get(k))) win.set(k, c);
  }
  const out = [];
  for (const [k, w] of win) {
    const also = [];
    for (const c of cands) {
      if (!c || c === w || !c.coin) continue;
      if (c.coin + "|" + c.side !== k) continue;
      also.push({ ev: c.ev, label: c.label || c.ev, unproven: !!c.unproven });
    }
    out.push(also.length ? Object.assign({}, w, { also }) : w);
  }
  return out;
}

// How far price has travelled from the fire mark, measured in the setup's OWN risk unit rather
// than percent. This is the number that says whether you are taking the trade the record was
// scored on: the record's entry was mark0, and every unit of R spent getting to the live mark is
// edge you no longer have. Positive = late (price moved the setup's way without you). Negative =
// the market came back and you can enter better than the fire. Risk is measured at the FIRE, not
// from the live mark, because that is the denominator the record itself used.
function lateR(side, mark0, now, stop) {
  if (side !== "long" && side !== "short") return null;
  if (!(mark0 > 0) || !(now > 0) || !(stop > 0)) return null;
  const risk0 = Math.abs(mark0 - stop);
  if (!(risk0 > 0)) return null;
  const moved = side === "long" ? now - mark0 : mark0 - now;
  return +(moved / risk0).toFixed(3);
}

// One trigger key per claim, stable across builds and restarts. Keyed on the fire TIME as well as
// the name/side/event, so a re-arm after an episode lapses is a genuinely new trigger rather than
// a silent duplicate of the old one.
function trigKey(row) {
  if (!row || !row.coin || !row.ev) return null;
  return row.coin + "|" + row.side + "|" + row.ev + "|" + (row.t0 || 0);
}

// Per-transport eligibility. The event stream is canonical and carries every new CONFIRMED
// trigger; each channel decides what it is willing to interrupt someone for. Kept pure and shared
// so the browser toast and a future Telegram push cannot drift into announcing different things.
function trigEligible(row, cfg) {
  if (!row) return false;
  const c = cfg || {};
  if (c.minEV != null) { if (row.evR == null || row.evR < c.minEV) return false; }
  if (c.minRR != null) { if (!row.rr || !(row.rr.gross >= c.minRR)) return false; }   // gross since -10: net retired with the carry-in-ratio contract
  if (c.maxLate != null) { if (row.late != null && row.late > c.maxLate) return false; }
  if (c.sides && c.sides.length && !c.sides.includes(row.side)) return false;
  // Setup FAMILY, using the board's own `cls` stamp so the two surfaces cannot disagree about which
  // family a row belongs to. "rr" = frozen ratio clears the 2:1 line (level-triggered: breakouts,
  // retests — win big, less often). "ev" = below it with positive expectancy anyway (sigma-built:
  // big moves, funding divergences — win small, more often). Both clear the same record and EV
  // gates; they are different TRADES, not different quality, which is why this is a filter and not
  // a score. An empty or absent list means both.
  if (Array.isArray(c.cls) && c.cls.length && !c.cls.includes(row.cls)) return false;
  if (Array.isArray(c.muted) && c.muted.includes(row.coin)) return false;
  if (c.noEarnings && row.earn) return false;
  return true;
}

// ===== telegram push transport (pure layer) ====================================================
// Second consumer of the SAME sequenced trigger stream the browser toast reads. Everything that
// decides what a message says or who gets it lives here as pure functions, so the wire transport
// in poller.js is nothing but "fetch this URL with this body" and the whole decision surface is
// testable without a network. Deliberately NOT a re-implementation of eligibility: the setup class
// delegates to trigEligible, so a rule change can never make Telegram and the browser announce
// different things — the drift this stream was built to prevent.

// Canonical push classes. `setup` is the existing trigger stream; `ops` is the server telling on
// itself (deploys, stalls, degraded feeds). Every later slice adds its class HERE and nowhere else.
// NB: the field is `kind`, not `cls` — actionable rows already carry a `cls` (the R:R class) and
// a collision would silently mis-route every message on the board.
// `ledger` is the DEATH side of a claim the `setup` class already announced: its void level taken,
// its target reached, or its horizon resolved. Deliberately one class rather than three — nobody
// wants to subscribe to target-hits but not stop-hits, and the message says which it is.
const PUSH_CLASSES = ["setup", "ledger", "rule", "filing", "earnings", "ai", "regime", "coverage", "ops"];
// Which classes a recipient gets when they have NOT chosen. The deploy-notice mistake in miniature:
// a class that seems informative in isolation becomes noise at its real frequency, and "all classes
// by default" means every new class I add silently starts spamming everyone already linked. So the
// default set is frozen to the four whose rates are known, and every class added after is OPT-IN —
// visible in the panel with its measured fires-per-day next to it, subscribed only on purpose.
const PUSH_DEFAULT_CLASSES = ["setup", "ledger", "rule", "ops"];

// Telegram parse_mode=HTML understands exactly five entities; everything else must be escaped or
// the API rejects the whole message with a 400 and the alert is lost. Ampersand first — escaping it
// after the angle brackets would double-escape the entities we just introduced.
function tgEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Link codes: 6 chars from an unambiguous alphabet (no O/0, I/1 — these get read off a screen and
// typed into a phone). Validation is pure and case-insensitive; minting lives in the poller because
// it needs randomness and TTL state.
const PUSH_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function pushCodeOk(s) {
  return typeof s === "string" && /^[A-HJ-NP-Z2-9]{6}$/.test(s.trim().toUpperCase());
}
function pushCodeNorm(s) { return typeof s === "string" ? s.trim().toUpperCase() : ""; }

// Per-recipient delivery filter. Two gates, in order: does this person want this CLASS at all, and
// (for setups) does the event clear the thresholds they set? The class gate is the one that makes
// per-person DMs worth having over a group chat — same rules for everyone, different phones.
// An absent `classes` means all classes: a freshly linked recipient gets everything until they
// narrow it, because silence on a new link reads as a broken wire.
function pushEligible(ev, sub) {
  if (!ev) return false;
  // Recorded, not delivered. Some events are worth having in the log — they explain later
  // artifacts — while being worth nothing as an interruption. A deploy notice is the case that
  // taught this: the app redeploys on every individual file push, so a single build fired four or
  // five identical DMs. That is not a health check, it is a spam generator. The flag lives on the
  // EVENT rather than in the transport so the in-app log and the bot can't disagree about what
  // happened, only about what was worth a notification.
  if (ev.quiet) return false;
  const s = sub || {};
  if (s.muted) return false;
  const kind = ev.kind || "setup";
  if (!PUSH_CLASSES.includes(kind)) return false;
  // An explicit selection is honoured exactly; an absent one falls back to the DEFAULT set rather
  // than to everything, so adding a class cannot retroactively subscribe anyone.
  if (Array.isArray(s.classes) && s.classes.length) { if (!s.classes.includes(kind)) return false; }
  else if (!PUSH_DEFAULT_CLASSES.includes(kind)) return false;
  if (kind === "ops") return true;                 // ops has no thresholds — it is already rare by construction
  // The ledger class is bounded by construction too: it can only speak about a claim whose birth
  // was already announced, so re-applying the setup thresholds here would mean being told a trade
  // opened and never told it died — the worst possible asymmetry in an alert channel.
  if (kind === "ledger") return true;
  // A rule event has already passed the only filter that could apply to it: the rule its author
  // wrote. Layering the setup thresholds on top would silently veto somebody's own alert.
  if (kind === "rule") return true;
  if (kind === "filing" || kind === "earnings" || kind === "ai") return true;
  if (kind === "regime" || kind === "coverage") return true;
  return trigEligible(ev, s.trig || {});           // setup: the SHARED gate, never a private copy
}

// One message per event, in the fixed four-line grammar the signal cards use: what fired, the
// geometry, the evidence, the link. Fixed order matters more here than on screen — this arrives at
// 3am on a phone and the eye needs to land on the void level in the same place every time.
// Returns null for an unformattable event rather than shipping a half-message.
function pushFmt(ev, opts) {
  if (!ev) return null;
  const o = opts || {};
  const kind = ev.kind || "setup";
  if (kind === "ops") {
    const tag = ev.level === "warn" ? "\u26a0 " : "";
    return tag + "<b>" + tgEsc(ev.title || "ops") + "</b>\n" + tgEsc(ev.text || "");
  }
  if (!ev.coin) return null;
  const name = tgEsc(ev.t || ev.coin);
  if (kind === "filing") {
    const l1 = "<b>" + name + "</b> \u00b7 " + tgEsc(ev.form || "filing");
    const l2 = tgEsc(ev.h || "");
    const l3 = ev.url ? '<a href="' + tgEsc(ev.url) + '">read the filing</a>' : "";
    return [l1, l2, l3].filter(Boolean).join("\n");
  }
  if (kind === "earnings") {
    const l1 = "<b>" + name + "</b> \u00b7 reports " + tgEsc(ev.when || "soon")
      + (ev.session ? " (" + tgEsc(ev.session) + ")" : "");
    const l2 = ev.claim ? "you have an open " + tgEsc(ev.claim) + " claim on it" : "";
    const base2 = opts && opts.baseUrl ? String(opts.baseUrl).replace(/\/+$/, "") : "";
    const l3 = base2 ? '<a href="' + tgEsc(base2 + "/#t=" + encodeURIComponent(ev.coin)) + '">open ' + name + "</a>" : "";
    return [l1, l2, l3].filter(Boolean).join("\n");
  }
  if (kind === "ai") {
    const l1 = "<b>" + name + "</b> \u00b7 analyst read flipped: " + tgEsc(ev.from || "?") + " \u2192 " + tgEsc(ev.to || "?");
    const l2 = tgEsc(ev.note || "");
    const base3 = opts && opts.baseUrl ? String(opts.baseUrl).replace(/\/+$/, "") : "";
    const l3 = base3 ? '<a href="' + tgEsc(base3 + "/#t=" + encodeURIComponent(ev.coin)) + '">open the report</a>' : "";
    return [l1, l2, l3].filter(Boolean).join("\n");
  }
  if (kind === "regime") {
    const l1 = "<b>" + tgEsc(ev.scope === "main" ? "crypto" : "stocks") + " positioning</b> \u00b7 " + tgEsc(ev.title || "");
    const l2 = tgEsc(ev.text || "");
    return [l1, l2].filter(Boolean).join("\n");
  }
  if (kind === "coverage") {
    const l1 = "\u26a0 <b>" + tgEsc(ev.t || ev.coin || "?") + "</b> \u00b7 data gap";
    const l2 = tgEsc(ev.text || "");
    return [l1, l2].filter(Boolean).join("\n");
  }
  if (kind === "rule") {
    const l1 = "<b>" + name + "</b> \u00b7 " + tgEsc(ev.rule || (ev.label + " " + ev.op + " " + ev.value));
    const l2 = "now " + tgEsc(ev.now == null ? "\u2014" : String(ev.now)) + (ev.note ? " \u00b7 " + tgEsc(ev.note) : "");
    const base1 = opts && opts.baseUrl ? String(opts.baseUrl).replace(/\/+$/, "") : "";
    const l3 = base1 ? '<a href="' + tgEsc(base1 + "/#t=" + encodeURIComponent(ev.coin)) + '">open ' + name + "</a>" : "";
    return [l1, l2, l3].filter(Boolean).join("\n");
  }
  if (kind === "ledger") {
    const sideL = ev.side === "long" ? "LONG" : ev.side === "short" ? "SHORT" : tgEsc(ev.side || "");
    const head = ev.sub === "stop" ? "\u26d4 void taken" : ev.sub === "target" ? "\u2713 target reached" : "resolved";
    const l1 = "<b>" + name + "</b> \u00b7 " + sideL + " \u00b7 " + tgEsc(ev.label || ev.ev || "") + " \u2014 " + head;
    let l2;
    if (ev.sub === "resolved") {
      const r = ev.realized;
      l2 = (r == null || !isFinite(r) ? "outcome \u2014" : (r >= 0 ? "+" : "") + (+r).toFixed(2) + (ev.unit || "R"))
        + " at horizon" + (ev.stopped ? " \u00b7 stopped out en route" : "")
        + (ev.held != null ? " \u00b7 held " + ev.held : "");
    } else {
      l2 = "level " + (ev.level == null ? "\u2014" : String(ev.level))
        + " \u00b7 entry " + (ev.entry == null ? "\u2014" : String(ev.entry))
        + (ev.held != null ? " \u00b7 open " + ev.held : "");
    }
    const base0 = opts && opts.baseUrl ? String(opts.baseUrl).replace(/\/+$/, "") : "";
    const l3 = base0 ? '<a href="' + tgEsc(base0 + "/#t=" + encodeURIComponent(ev.coin)) + '">open ' + name + "</a>" : "";
    return [l1, l2, l3].filter(Boolean).join("\n");
  }
  const side = ev.side === "long" ? "LONG" : ev.side === "short" ? "SHORT" : tgEsc(ev.side || "");
  const num = (v, d) => (v == null || !isFinite(v) ? "\u2014" : (+v).toFixed(d == null ? 2 : d));
  const px = (v) => (v == null || !isFinite(v) ? "\u2014" : String(v));
  const l1 = "<b>" + name + "</b> \u00b7 " + side + " \u00b7 " + tgEsc(ev.label || ev.ev || "")
    + (ev.tf ? " \u00b7 " + tgEsc(ev.tf) : "") + (ev.cls === "ev" ? " \u00b7 grinder" : "")
    + (ev.prime === true ? " \u2605" : "");
  const l2 = "entry " + px(ev.entry) + " \u00b7 void " + px(ev.void) + " \u00b7 target " + px(ev.target)
    + (ev.rr && ev.rr.gross != null ? " \u00b7 R:R " + num(ev.rr.gross, 1) : "");
  const rec = ev.rec || {};
  const l3 = "EV " + num(ev.evR, 2) + "R \u00b7 n=" + (rec.n == null ? "\u2014" : rec.n)
    + " \u00b7 hit " + (rec.hit == null ? "\u2014" : Math.round(rec.hit * 100) + "%")
    + " \u00b7 avg " + num(rec.avgR, 2) + "R"
    + (ev.late != null ? " \u00b7 late " + num(ev.late, 2) + "R" : "")
    + (ev.earn ? " \u00b7 \u26a0 earnings" : "");
  const base = o.baseUrl ? String(o.baseUrl).replace(/\/+$/, "") : "";
  const l4 = base ? '<a href="' + tgEsc(base + "/#t=" + encodeURIComponent(ev.coin)) + '">open ' + name + "</a>" : "";
  return [l1, l2, l3, l4].filter(Boolean).join("\n");
}

// Telegram caps a sendMessage body at 4096 chars, so a burst is batched into as few messages as
// possible rather than one per event — and the batch is CAPPED, with the overflow disclosed as a
// count instead of silently dropped. Same honest-null rule the UI uses for suppressed signals.
const PUSH_MSG_MAX = 3800, PUSH_BATCH_MAX = 8;
function pushBatch(msgs, opts) {
  const o = opts || {};
  const cap = o.max || PUSH_BATCH_MAX, lim = o.limit || PUSH_MSG_MAX;
  const list = (msgs || []).filter((m) => typeof m === "string" && m);
  if (!list.length) return [];
  const take = list.slice(0, cap), extra = list.length - take.length;
  const out = [];
  let cur = "";
  for (const m of take) {
    const next = cur ? cur + "\n\n" + m : m;
    if (next.length > lim && cur) { out.push(cur); cur = m; }
    else cur = next;
  }
  if (cur) out.push(cur);
  if (extra > 0 && out.length) out[out.length - 1] += "\n\n<i>+" + extra + " more held \u2014 batch cap</i>";
  return out;
}


// ===== user-authored metric rules (pure layer) ==================================================
// The threshold alerts, moved off the browser. Two things forced this: rules in localStorage only
// evaluate while a tab is open (so they cannot reach a phone), and each browser held its own list
// (so the group could not share one).
//
// The catalog is deliberately RESTRICTED to metrics the server itself owns on the mapped snapshot
// row. Squeeze, momentum and beta are derived in the browser from raw features against the user's
// selected analysis window; porting them here would mean either the same math in two files, or
// shipping a value per window on every row. Both are worse than the honest boundary: those three
// stay in-tab, labelled as such, and everything below survives a closed laptop.
//
// Every getter reads the SAME mapped row the client renders, so an alert and the board can never
// disagree about a number.
const pctFrom = (px, ref) => (px > 0 && ref > 0 ? (px / ref - 1) * 100 : null);
const RULE_METRICS = [
  { k: "px", label: "price", unit: "$", live: 1, get: (r) => r.px },
  { k: "h1", label: "1h %", unit: "%", live: 1, get: (r) => (r.ref ? pctFrom(r.px, r.ref.p1h) : null) },
  { k: "h4", label: "4h %", unit: "%", live: 1, get: (r) => (r.ref ? pctFrom(r.px, r.ref.p4h) : null) },
  { k: "d1", label: "1d %", unit: "%", live: 1, get: (r) => (r.d1 != null && isFinite(r.d1) ? r.d1 : null) },
  { k: "d7", label: "7d %", unit: "%", live: 1, get: (r) => (r.ref ? pctFrom(r.px, r.ref.p7d) : null) },
  { k: "d30", label: "30d %", unit: "%", live: 1, get: (r) => (r.ref ? pctFrom(r.px, r.ref.p30d) : null) },
  { k: "fundAPR", label: "funding APR %", unit: "%", get: (r) => (r.funding != null && isFinite(r.funding) ? r.funding * 24 * 365 * 100 : null) },
  { k: "fundPct", label: "funding percentile", unit: "", get: (r) => (r.fundPct != null && isFinite(r.fundPct) ? r.fundPct : null) },
  // Mark vs oracle in basis points. Both legs are on the row, so this is server-owned despite the
  // client having derived it for itself until now.
  { k: "prem", label: "premium (bp)", unit: "bp", live: 1, get: (r) => (r.px > 0 && r.oracle > 0 ? (r.px / r.oracle - 1) * 10000 : null) },
  { k: "vol", label: "24h volume", unit: "M", scale: 1e6, get: (r) => (r.vol != null && isFinite(r.vol) ? r.vol : null) },
  { k: "oi", label: "open interest", unit: "M", scale: 1e6, get: (r) => (r.oi != null && isFinite(r.oi) ? r.oi : null) },
  { k: "rvol", label: "relative volume", unit: "\u00d7", get: (r) => (r.rvol != null && isFinite(r.rvol) ? r.rvol : null) },
  { k: "doiD1", label: "\u0394OI 1d %", unit: "%", get: (r) => (r.doi && r.doi.d1 != null && isFinite(r.doi.d1) ? r.doi.d1 : null) },
  { k: "doiD7", label: "\u0394OI 7d %", unit: "%", get: (r) => (r.doi && r.doi.d7 != null && isFinite(r.doi.d7) ? r.doi.d7 : null) },
  { k: "liq24", label: "24h liquidations", unit: "M", scale: 1e6, get: (r) => (r.liq24 != null && isFinite(r.liq24) ? r.liq24 : null) },
];
const RULE_BY_K = {};
for (const m of RULE_METRICS) RULE_BY_K[m.k] = m;
const RULE_OPS = [">", "<", "abs>", "cross_up", "cross_dn"];

// Hysteresis. A value parked exactly on a threshold crosses it dozens of times an hour on noise
// alone; edge-triggering without a band turns that into dozens of identical alerts and then a muted
// channel. The rule re-arms only once the value has retreated by `band` (default 2% of the
// threshold's own magnitude, floored so a threshold of 0 still has a band).
function ruleBand(rule) {
  if (rule && Number.isFinite(rule.band) && rule.band >= 0) return rule.band;
  const v = Math.abs(rule && Number.isFinite(rule.value) ? rule.value : 0);
  return Math.max(v * 0.02, 1e-9);
}

// Returns "fire" | "arm" | "hold" | null.
//   fire = the condition just became true and the rule was armed
//   arm  = the value retreated past the hysteresis band; the rule may fire again
//   hold = nothing to do
//   null = unevaluable (missing data) — NEVER a fire, and never silently treated as false either
function ruleEval(rule, row, armed, prevValue) {
  if (!rule || !row) return null;
  const m = RULE_BY_K[rule.metric];
  if (!m) return null;
  if (!RULE_OPS.includes(rule.op)) return null;
  const raw = m.get(row);
  if (raw == null || !isFinite(raw)) return null;
  const target = m.scale ? rule.value * m.scale : rule.value;
  const band = ruleBand(rule) * (m.scale || 1);
  if (rule.op === "cross_up" || rule.op === "cross_dn") {
    // A cross needs two observations by definition; the first sighting of a market can only
    // establish the baseline, never fire. Treating a missing previous value as "was on the other
    // side" would fire every rule on every restart.
    if (prevValue == null || !isFinite(prevValue)) return "hold";
    if (rule.op === "cross_up") return prevValue <= target && raw > target ? "fire" : "hold";
    return prevValue >= target && raw < target ? "fire" : "hold";
  }
  const hit = rule.op === ">" ? raw > target : rule.op === "<" ? raw < target : Math.abs(raw) > Math.abs(target);
  if (hit) return armed ? "fire" : "hold";
  // Re-arm only past the band, not at the bare threshold.
  const clear = rule.op === ">" ? raw < target - band
    : rule.op === "<" ? raw > target + band
    : Math.abs(raw) < Math.abs(target) - band;
  return !armed && clear ? "arm" : "hold";
}

function ruleFmtValue(m, v) {
  if (v == null || !isFinite(v)) return "\u2014";
  if (m.scale) return (v / m.scale).toFixed(1) + m.unit;
  if (m.unit === "%") return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  if (m.unit === "bp") return (v >= 0 ? "+" : "") + v.toFixed(1) + "bp";
  if (m.unit === "$") return String(+(+v).toPrecision(6));
  if (m.unit === "\u00d7") return v.toFixed(2) + "\u00d7";
  return String(Math.round(v * 100) / 100);
}
const RULE_OP_LABEL = { ">": "above", "<": "below", "abs>": "|x| above", cross_up: "crosses up through", cross_dn: "crosses down through" };
function ruleLabel(rule) {
  const m = RULE_BY_K[rule && rule.metric];
  if (!m) return "";
  const scope = rule.coin ? rule.coin : rule.uni === "main" ? "any crypto" : rule.uni === "xyz" ? "any stock" : "any market";
  return scope + " \u00b7 " + m.label + " " + (RULE_OP_LABEL[rule.op] || rule.op) + " " + rule.value + (m.unit === "%" ? "%" : m.unit === "M" ? "M" : "");
}

// Validation is strict and returns a REASON, because a rule silently coerced into something the
// author didn't mean is worse than a rejected one — it fires forever and nobody knows why.
function validateRule(rule) {
  if (!rule || typeof rule !== "object") return { ok: false, error: "not-an-object" };
  if (!RULE_BY_K[rule.metric]) return { ok: false, error: "unknown-metric" };
  if (!RULE_OPS.includes(rule.op)) return { ok: false, error: "unknown-op" };
  if (!Number.isFinite(+rule.value)) return { ok: false, error: "bad-value" };
  if (rule.coin != null && typeof rule.coin !== "string") return { ok: false, error: "bad-coin" };
  if (rule.uni != null && rule.uni !== "xyz" && rule.uni !== "main") return { ok: false, error: "bad-universe" };
  if (rule.band != null && (!Number.isFinite(+rule.band) || +rule.band < 0)) return { ok: false, error: "bad-band" };
  if (rule.cooldownMs != null && (!Number.isFinite(+rule.cooldownMs) || +rule.cooldownMs < 0)) return { ok: false, error: "bad-cooldown" };
  return { ok: true, rule: {
    id: rule.id || null, metric: rule.metric, op: rule.op, value: +rule.value,
    coin: rule.coin || "", uni: rule.uni || "", band: rule.band != null ? +rule.band : null,
    cooldownMs: rule.cooldownMs != null ? +rule.cooldownMs : null,
    note: typeof rule.note === "string" ? rule.note.slice(0, 80) : "",
  } };
}

module.exports.RULE_METRICS = RULE_METRICS;
module.exports.RULE_BY_K = RULE_BY_K;
module.exports.RULE_OPS = RULE_OPS;
module.exports.RULE_OP_LABEL = RULE_OP_LABEL;
module.exports.ruleBand = ruleBand;
module.exports.ruleEval = ruleEval;
module.exports.ruleLabel = ruleLabel;
module.exports.ruleFmtValue = ruleFmtValue;
module.exports.validateRule = validateRule;

// ---- quiet hours ------------------------------------------------------------------------------
// Per-recipient because these are DMs: two people in the group can be in different timezones and
// want different windows. Stored as local hours plus that person's UTC offset in minutes, so the
// server never has to guess a zone and a DST change is the recipient's own to re-set.
//
// A quiet window DELAYS; it never drops. An alert suppressed and forgotten is strictly worse than
// one that arrives late, because the log and the phone would then disagree about what happened.
function inQuietWindow(nowMs, q) {
  if (!q || !Number.isFinite(q.from) || !Number.isFinite(q.to)) return false;
  if (q.from === q.to) return false;   // a zero-width window is "off", not "always"
  const tz = Number.isFinite(q.tz) ? q.tz : 0;
  const d = new Date(nowMs + tz * 60000);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return q.from < q.to ? (h >= q.from && h < q.to) : (h >= q.from || h < q.to);   // the second branch wraps midnight
}
// When the current window ends, in ms. Used to schedule a held message rather than re-checking it
// on every drain tick.
function quietEndsAt(nowMs, q) {
  if (!inQuietWindow(nowMs, q)) return nowMs;
  const tz = Number.isFinite(q.tz) ? q.tz : 0;
  const d = new Date(nowMs + tz * 60000);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  let ahead = q.to - h;
  if (ahead <= 0) ahead += 24;
  return nowMs + Math.ceil(ahead * 3600e3);
}
// What quiet hours cannot silence. A void being taken is a position going wrong right now, and a
// stalled poller means every other alert has stopped being trustworthy — delaying either until
// morning would defeat the point of having them.
function piercesQuiet(ev) {
  if (!ev) return false;
  if (ev.kind === "ops") return true;
  return ev.kind === "ledger" && ev.sub === "stop";
}
function validateQuiet(q) {
  if (q == null) return { ok: true, quiet: null };
  if (typeof q !== "object") return { ok: false, error: "bad-quiet" };
  const from = +q.from, to = +q.to, tz = q.tz == null ? 0 : +q.tz;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from >= 24 || to < 0 || to >= 24) return { ok: false, error: "bad-hours" };
  if (!Number.isFinite(tz) || tz < -840 || tz > 840) return { ok: false, error: "bad-tz" };
  return { ok: true, quiet: { from, to, tz } };
}

module.exports.inQuietWindow = inQuietWindow;
module.exports.quietEndsAt = quietEndsAt;
module.exports.piercesQuiet = piercesQuiet;
module.exports.validateQuiet = validateQuiet;
module.exports.PUSH_CLASSES = PUSH_CLASSES;
module.exports.PUSH_DEFAULT_CLASSES = PUSH_DEFAULT_CLASSES;
module.exports.PUSH_CODE_ALPHABET = PUSH_CODE_ALPHABET;
module.exports.tgEsc = tgEsc;
module.exports.pushCodeOk = pushCodeOk;
module.exports.pushCodeNorm = pushCodeNorm;
module.exports.pushEligible = pushEligible;
module.exports.pushFmt = pushFmt;
module.exports.levelHit = levelHit;
module.exports.pushBatch = pushBatch;

module.exports.lateR = lateR;
module.exports.trigKey = trigKey;
module.exports.trigEligible = trigEligible;
module.exports.carryR = carryR;
module.exports.netRR = netRR;
module.exports.setupEV = setupEV;
module.exports.barsInTrigger = barsInTrigger;
module.exports.actionableBetter = actionableBetter;
module.exports.mergeActionable = mergeActionable;
module.exports.ACT_TF_MS = ACT_TF_MS;
module.exports.ACT_TF_RANK = ACT_TF_RANK;

// ===== feature visibility manifest (admin panel, phase 0) ======================================
// ONE canonical list of every gateable surface. Before this, visibility lived in four places that
// could disagree: the data-view buttons in index.html, showView's setHidden list, applyScope's
// crypto hide loop, and HIDDEN_TABS. The admin panel is a VIEW ONTO THIS ARRAY, never a second list
// beside it — which is why the suite pins every data-view tab in index.html to an entry here. A new
// tab with no entry is a suite failure, not a discovery three weeks later.
//
// state: 'public' | 'admin' | 'off'. 'off' means nobody, including admin — it parks something broken
// without implying it is secret. Unlisted keys resolve to FEATURE_DEFAULT ('admin'): fail closed, so
// a feature shipped without a manifest entry is invisible to the group rather than silently exposed.
//
// ASYMMETRY, deliberate: KEYS fail closed, ROUTES do not. A route that no entry claims stays
// ungated, because the alternative is every unlisted route 403ing and the whole app going dark on
// the first deploy. The tab half of that gap is closed mechanically (manifest test); the route half
// is closed by review. Do not "fix" this by defaulting routes closed — read the test comment first.
const FEATURE_DEFAULT = "admin";
const FEATURE_STATES = ["public", "admin", "off"];

// Routes that can NEVER be gated, whatever the manifest or flags say. Gating the unlock route is a
// one-way door: no admin cookie, no way to mint one, no way back in without a redeploy. /api/health
// must stay open or Railway's healthcheck 401s and the deploy restart-loops (same reason the site
// gate exempts it). Enforced in code, not by convention — featureGateFor consults this first.
const FEATURE_NEVER_GATE = new Set(["/api/health", "/login", "/logout",
  "/api/ai-unlock", "/api/ai-lock", "/api/ai-status", "/api/features"]);

// pin:true — always public, never gateable. Markets is the fallback every gated view falls through
// to; if it could be hidden, a public user would land on a blank app with no way out.
// lock:true — the mirror image: always admin, never openable. The panel is the control surface for
// every other flag, so a write that made it public would hand the whole switchboard to the group, and
// a write that turned it off would lock the operator out with no way back except a redeploy. Both
// locks exist for the same reason: the two states that must not be reachable through the thing they
// control. featureState honours them ahead of any stored value, setFlag refuses them, and the
// sanitizer drops them so a hand-edited flags.json cannot smuggle one in either.
// runtime:true — the tab is injected by JS at load (Treemap self-installs) rather than living in
// index.html, so the markup-scanning half of the manifest test must not demand a data-view for it.
const FEATURES = [
  { key: "admin",      kind: "tab", label: "Admin",       def: "admin",  lock: true, routes: [] },
  { key: "markets",    kind: "tab", label: "Markets",     def: "public", pin: true, routes: ["/api/snapshot", "/api/daily", "/api/series", "/api/candles"] },
  { key: "trend",      kind: "tab", label: "Trend",       def: "public", routes: ["/api/trend"] },
  { key: "sectors",    kind: "tab", label: "Sectors",     def: "public", routes: [] },
  { key: "corr",       kind: "tab", label: "Correlation", def: "public", routes: ["/api/corr-crypto"] },
  { key: "sessions",   kind: "tab", label: "Sessions",    def: "public", routes: ["/api/analytics"] },
  { key: "signals",    kind: "tab", label: "Signals",     def: "public", routes: ["/api/signals", "/api/ledger", "/api/triggers"] },
  { key: "earnings",   kind: "tab", label: "Earnings",    def: "public", routes: ["/api/earnings"] },
  { key: "news",       kind: "tab", label: "News",        def: "public", routes: ["/api/news", "/api/news/channels"] },
  { key: "report",     kind: "tab", label: "AI Report",   def: "public", routes: ["/api/ai-report", "/api/ai-reports"] },
  { key: "actionable", kind: "tab", label: "Actionable",  def: "admin",  routes: ["/api/actionable"] },
  { key: "backtest",   kind: "tab", label: "Backtest",    def: "admin",  routes: ["/api/duel"] },
  { key: "treemap",    kind: "tab", label: "Treemap",     def: "public", runtime: true, routes: [] },
  { key: "ai.generate",   kind: "act", label: "AI report generation", def: "admin",  routes: ["POST /api/ai-report"] },
  { key: "ai.ask",        kind: "act", label: "Terminal AI fallback", def: "admin",  routes: ["POST /api/ask"] },
  { key: "ai.reset",      kind: "act", label: "AI budget reset",      def: "admin",  routes: ["POST /api/ai-reset"] },
  { key: "export.ledger", kind: "act", label: "Ledger CSV export",    def: "public", routes: ["/api/export/ledger"] },
  { key: "news.write",    kind: "act", label: "Edit news channels",   def: "admin",  routes: ["POST /api/news/channels"] },
  { key: "earnings.void", kind: "act", label: "Void an earnings row", def: "admin",  routes: ["POST /api/earnings/void"] },
  { key: "derivs.refresh", kind: "act", label: "Force derivs refresh", def: "admin", routes: ["POST /api/derivs/refresh"] },
];

const FEATURE_BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

// Stored flags arrive from a JSON file on the volume and from an admin POST — both untrusted enough
// to sanitize. Unknown keys and non-states are DROPPED rather than coerced: a typo'd key silently
// resolving to a real feature's state is exactly the class of bug the manifest exists to prevent.
function featureFlagsSanitize(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k in raw) {
    const f = FEATURE_BY_KEY.get(k);
    if (!f) continue;
    // A stored state for a PINNED key is dropped, not kept-and-ignored. Keeping it would be inert
    // today (featureState checks the pin first) and live the moment anyone removed the pin — a
    // change in one file silently activating a value written in another. Never persist it at all.
    if (f.pin || f.lock) continue;
    const v = raw[k];
    if (FEATURE_STATES.indexOf(v) < 0) continue;
    out[k] = v;
  }
  return out;
}

// Resolution order: pinned manifest entry > stored override > manifest default > FEATURE_DEFAULT.
// A pin beats a stored flag on purpose — it is the guard that a bad write can't lock everyone out.
function featureState(flags, key) {
  const f = FEATURE_BY_KEY.get(key);
  if (!f) return FEATURE_DEFAULT;
  if (f.pin) return "public";
  if (f.lock) return "admin";
  const s = flags && flags[key];
  if (FEATURE_STATES.indexOf(s) >= 0) return s;
  return FEATURE_STATES.indexOf(f.def) >= 0 ? f.def : FEATURE_DEFAULT;
}

function featureVisible(flags, key, isAdmin) {
  const s = featureState(flags, key);
  if (s === "off") return false;          // off means nobody — admin included
  return s === "public" || !!isAdmin;
}

// The whole resolved set for one audience. This is what gets injected into the shell and what the
// client reads; the client never re-derives a state from a raw flag, same one-code-path rule the
// chart annotations follow.
function resolveFeatures(flags, isAdmin) {
  const out = {};
  for (const f of FEATURES) out[f.key] = featureVisible(flags, f.key, isAdmin);
  return out;
}

// route -> owning feature key. Built from the manifest so a route can never be gated by a key that
// isn't in it. Methodless entries match any method; "POST /x" matches that method only, which is how
// a public GET and an admin POST can share one path (/api/ai-report is exactly that).
function featureRouteIndex() {
  const exact = new Map(), any = new Map();
  for (const f of FEATURES) {
    for (const r of f.routes || []) {
      const sp = r.indexOf(" ");
      if (sp > 0) exact.set(r.slice(0, sp).toUpperCase() + " " + r.slice(sp + 1), f.key);
      else any.set(r, f.key);
    }
  }
  return { exact, any };
}
const FEATURE_ROUTES = featureRouteIndex();

// Returns the feature key BLOCKING this request, or null when it may proceed. Method-specific
// mapping wins over the path-wide one: POST /api/ai-report is gated by ai.generate even though the
// GET on the same path belongs to the (possibly public) report tab.
function featureGateFor(method, url, flags, isAdmin) {
  const p = String(url || "").split("?")[0];
  if (FEATURE_NEVER_GATE.has(p)) return null;
  const m = String(method || "GET").toUpperCase();
  const key = FEATURE_ROUTES.exact.get(m + " " + p) || FEATURE_ROUTES.any.get(p);
  if (!key) return null;                                  // unclaimed route — see the ASYMMETRY note
  return featureVisible(flags, key, isAdmin) ? null : key;
}

// Panel readout: how much of the app a public user currently sees.
// Settable = neither locked open nor locked shut. The panel renders the rest as read-only rather than
// offering a control whose write would be refused.
function featureSettable(key) {
  const f = FEATURE_BY_KEY.get(key);
  return !!f && !f.pin && !f.lock;
}
function featureCounts(flags) {
  let pub = 0, adm = 0, off = 0;
  for (const f of FEATURES) {
    const s = featureState(flags, f.key);
    if (s === "public") pub++; else if (s === "off") off++; else adm++;
  }
  return { total: FEATURES.length, public: pub, admin: adm, off: off };
}

module.exports.FEATURES = FEATURES;
module.exports.FEATURE_STATES = FEATURE_STATES;
module.exports.FEATURE_DEFAULT = FEATURE_DEFAULT;
module.exports.FEATURE_NEVER_GATE = FEATURE_NEVER_GATE;
module.exports.featureFlagsSanitize = featureFlagsSanitize;
module.exports.featureState = featureState;
module.exports.featureVisible = featureVisible;
module.exports.resolveFeatures = resolveFeatures;
module.exports.featureGateFor = featureGateFor;
module.exports.featureCounts = featureCounts;
module.exports.featureSettable = featureSettable;
