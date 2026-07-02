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
  let prev = null, hi = -Infinity, lo = Infinity;
  for (const k of c) {
    const cl = parseFloat(k.c), h = parseFloat(k.h), l = parseFloat(k.l), v = parseFloat(k.v);
    if (isFinite(h) && h > hi) hi = h;
    if (isFinite(l) && l < lo) lo = l;
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
function cashAnchors(startMs, endMs) {
  const out = [];
  for (const et of etDays(startMs, endMs)) {
    if (et.wd < 1 || et.wd > 5) continue;
    const enter = etWallToUtc(et.y, et.mo, et.d, 9, 30), exit = etWallToUtc(et.y, et.mo, et.d, 16, 0);
    if (enter >= startMs && exit <= endMs) out.push({ enter, exit, tag: "cash" });
  }
  return out;
}
// Overnight: Mon-Thu 16:00 ET -> next day 09:30 ET (single-night holds; Fri handled by weekend).
function overnightAnchors(startMs, endMs) {
  const out = [];
  for (const et of etDays(startMs, endMs)) {
    if (et.wd < 1 || et.wd > 4) continue;            // Mon..Thu
    const nx = nextEtDate(et, 1);
    const enter = etWallToUtc(et.y, et.mo, et.d, 16, 0), exit = etWallToUtc(nx.y, nx.mo, nx.d, 9, 30);
    if (enter >= startMs && exit <= endMs) out.push({ enter, exit, tag: "overnight" });
  }
  return out;
}
// Weekend: Fri 16:00 ET -> Mon 09:30 ET (the longest unanchored stretch).
function weekendAnchors(startMs, endMs) {
  const out = [];
  for (const et of etDays(startMs, endMs)) {
    if (et.wd !== 5) continue;                        // Fri
    const mon = nextEtDate(et, 3);
    const enter = etWallToUtc(et.y, et.mo, et.d, 16, 0), exit = etWallToUtc(mon.y, mon.mo, mon.d, 9, 30);
    if (enter >= startMs && exit <= endMs) out.push({ enter, exit, tag: "weekend" });
  }
  return out;
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

module.exports = { stdev, median, linregR2, priceAt, featuresFromHourly, oiDeltaPct, fundingAvg, dailyLogReturns, pearson, meanPairwiseCorr,
  // boundary-backtest engine (ET session calendar, anchor generators, net-of-funding hold math)
  etParts, etOffsetAt, etWallToUtc, etDays, nextEtDate, cashAnchors, overnightAnchors, weekendAnchors,
  priceAsOf, fundingOver, holdReturn, runHolds, summarize, poolSummary, sessionComposite };
