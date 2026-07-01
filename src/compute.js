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
  const feat = {
    volH: stdev(rets),
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

module.exports = { stdev, median, linregR2, priceAt, featuresFromHourly, oiDeltaPct };
