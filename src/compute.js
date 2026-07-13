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
function oiDeltaPct(hist, oiNow, windowMs) {
  if (!hist || hist.length < 2 || !(oiNow > 0)) return null;
  const MIN = 60 * 1000, HOUR = 60 * MIN, OI_MIN_GAP = 4.5 * MIN;
  const tol = Math.min(Math.max(2 * OI_MIN_GAP, windowMs * 0.05), 12 * HOUR);
  const target = Date.now() - windowMs;

  let before = null, after = null;
  for (const s of hist) {
    if (!(s[1] > 0)) continue;                       // skip non-positive OI samples
    if (s[0] <= target) { if (!before || s[0] > before[0]) before = s; }
    else if (!after || s[0] < after[0]) after = s;
  }
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
  let pT = null, pF = null, area = 0, span = 0, simSum = 0, simN = 0;
  for (const s of hist) {
    const t = s[0], f = s[2];
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
  coil:     { horizonMs: null,     horizon: "context flag \u2014 expansion pending, direction unknown", studyKey: null },
  ondrift:  { horizonMs: null,     horizon: "next 5 overnight windows, held close\u2192open", studyKey: null },
  prem:     { horizonMs: 12 * HOUR, horizon: "reversion toward oracle",       studyKey: null },
  volume:   { horizonMs: null,     horizon: "context flag",                   studyKey: null },
};
// Mechanical playbook per signal: implied bias, computed target/invalidation levels from the
// market's own stats, and the one corroborating thing to watch. A description of the setup —
// explicitly NOT advice; the ledger decides which event types have earned any trust.
function playbook(ev, ctx) {
  const f2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toPrecision(6));
  switch (ev) {
    case "bigmove": {
      const up = ctx.dir >= 0, sgn = up ? 1 : -1;
      return { side: up ? "long" : "short", bias: "continuation " + (up ? "up" : "down"),
        target: f2(ctx.px * (1 + sgn * Math.abs(ctx.med != null ? ctx.med : 0.5) / 100)),
        stop: f2(ctx.px * (1 - sgn * (ctx.sd30 || 1) / 100)),
        watch: "volume staying elevated \u2014 a thrust on fading volume is the fade setup instead" };
    }
    case "breakout":
      return { side: "long", bias: "continuation while above the breakout level",
        target: f2(ctx.px * (1 + Math.abs(ctx.med != null ? ctx.med : 1) / 100)),
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
        target: f2(ctx.px * (1 - Math.abs(ctx.med != null ? ctx.med : 1) / 100)),
        stop: f2(ctx.level),
        watch: "a close back above the prior 30d low = failed breakdown, the signal is void" };
    case "unwind": {
      // Bearish mirror of the squeeze: crowded LONGS paying funding + OI building + price near
      // range LOWS. Target extends BELOW the range for the same reason squeeze extends above it.
      const rngU = ctx.hi30 != null && ctx.lo30 != null ? ctx.hi30 - ctx.lo30 : null;
      return { side: "short", bias: "unwind-biased while longs keep paying AND \u0394OI holds",
        target: f2(rngU != null ? ctx.lo30 - 0.382 * rngU : null),
        stop: f2(rngU != null ? ctx.hi30 - 0.25 * rngU : null),
        watch: "\u0394OI(7d) rolling negative = longs already liquidating; funding flipping negative = the crowd has left \u2014 the setup is spent" };
    }
    case "oiflush": {
      const sgn = 1;
      return { side: "long", bias: "capitulation \u2014 forced deleveraging exhausting into a decline",
        target: f2(ctx.px * (1 + Math.abs(ctx.med != null ? ctx.med : 1) / 100)),
        stop: f2(ctx.px * (1 - (ctx.sd30 || 1) / 100)),
        watch: "\u0394OI stabilizing or turning up = the flush is complete; continued OI bleed = the knife is still falling" };
    }
    case "fpdiv": {
      const up = ctx.dir >= 0, sg = up ? 1 : -1;
      return { side: up ? "long" : "short",
        bias: up ? "price strength while funding falls \u2014 shorts pressing into a rising tape (stubborn crowd, squeeze-adjacent)"
                 : "price weakness while funding rises \u2014 longs averaging down into a falling tape (fragile crowd)",
        target: f2(ctx.px * (1 + sg * Math.abs(ctx.med != null ? ctx.med : 0.8) / 100)),
        stop: f2(ctx.px * (1 - sg * (ctx.sd30 || 1) / 100)),
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
        target: null, stop: null,
        watch: "funding flipping straight back voids it; funding STAYING flipped for 2+ days is the confirmation" };
    case "squeeze": {
      // Target is a measured-move EXTENSION above the range (hi30 + 0.382 x range), not the
      // range top: the trigger rewards price already near the high, so targeting hi30 itself
      // produced structurally inverted R/R at exactly the moments the signal fired. Squeezes
      // resolve through the range, not to it.
      const rng = ctx.hi30 != null && ctx.lo30 != null ? ctx.hi30 - ctx.lo30 : null;
      return { side: "long", bias: "squeeze-biased while shorts keep paying AND \u0394OI holds",
        target: f2(rng != null ? ctx.hi30 + 0.382 * rng : null),
        stop: f2(rng != null ? ctx.lo30 + 0.25 * rng : null),
        watch: "\u0394OI(7d) turning negative = shorts covering, spring released \u2014 the setup is spent" };
    }
    case "prem":
      return { side: ctx.prem >= 0 ? "short" : "long",
        bias: ctx.prem >= 0 ? "perp rich \u2014 reversion toward oracle (short the perp side)" : "perp cheap \u2014 reversion toward oracle (long the perp side)",
        target: f2(ctx.oracle), stop: null,
        watch: ctx.closed ? "whether the cash open confirms the perp's level or snaps it back to the oracle" : "persistence \u2014 a dislocation that survives arb for hours is information, not noise" };
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
function activityClock(prices, funding) {
  const vSum = new Array(24).fill(0), vCnt = new Array(24).fill(0);
  const qSum = new Array(24).fill(0), qCnt = new Array(24).fill(0);
  const fSum = new Array(24).fill(0), fCnt = new Array(24).fill(0);
  // Candles are on the hour, so ET hour = (UTC hour + offset) mod 24, and the ET/UTC offset only
  // changes at DST boundaries. Cache the offset per UTC day (one formatToParts each) instead of
  // calling etParts on every candle — ~48x fewer Intl calls. A handful of candles on the two DST
  // transition days may bin 1h off; immaterial for an activity clock (the session math uses the exact
  // path). offset is -4 (EDT) or -5 (EST): ET hour = ((utcHour + offset) % 24 + 24) % 24.
  const offCache = new Map();
  const etHour = (t) => {
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
function dowClock(prices) {
  const mk = () => Array.from({ length: 7 }, () => new Array(24).fill(0));
  const vSum = mk(), vCnt = mk(), qSum = mk(), qCnt = mk();
  const offCache = new Map();
  for (const k of (prices || [])) {
    const t = k[0], hi = k[2], lo = k[3], v = k[5];
    if (!Number.isFinite(t)) continue;
    const day = Math.floor(t / DAY);
    let off = offCache.get(day); if (off === undefined) { off = etOffsetAt(t); offCache.set(day, off); }
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

module.exports = { stdev, median, linregR2, priceAt, featuresFromHourly, oiDeltaPct, fundingAvg, dailyLogReturns, pearson, meanPairwiseCorr, stopGeometryOk, fadeStats,
  fourHourReturns, tapeRedStats, rvolMulti,
  // boundary-backtest engine (ET session calendar, anchor generators, net-of-funding hold math)
  etParts, etOffsetAt, etWallToUtc, etDays, nextEtDate, cashAnchors, overnightAnchors, weekendAnchors,
  usDayStatus, marketSessions, closedWindows,
  summarizeEvents, retStd, dailyRets, studyBigMove, studyBreakout, studyVolShift, studyGapFade, studyFundFlip,
  EV_META, playbook, shouldPromote, stopTouched, studyBreakdown, confSplit, studyOIFlush, studyFPDiv, compressionNow, offDriftStats,
  priceAsOf, fundingOver, holdReturn, runHolds, summarize, poolSummary, sessionComposite, activityClock, dowClock, pca2, hourReturnMeans, hourReturnStats };

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
    const eps = typeof e.epsEstimate === "number" && isFinite(e.epsEstimate) ? +e.epsEstimate.toFixed(2) : null;
    out.push({ coin: m.coin, t: m.ticker, d: e.date, s: EARN_SESS[String(e.hour || "").toLowerCase()] || "TBD", eps });
  }
  out.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : (EARN_SESS_ORD[a.s] - EARN_SESS_ORD[b.s]) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out;
}
module.exports.etDayStr = etDayStr;
module.exports.earnDayDiff = earnDayDiff;
module.exports.parseEarningsCalendar = parseEarningsCalendar;
