// backtest.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { openActionable, renderActionable } from "./actionable.js";
import { IS_ADMIN, attachLineHover, featureOn, hoverChart, lcGrid, lcTicks, loadAnalytics, loadFunding, openAdmin, openFunding, renderFunding, renderSessions, sCap, sCard, sHead, sLeg, sessDate, syncAnalyticsSlot, syncFundingSlot, tabVisible } from "./admin.js";
import { pushToast, setHash } from "./alerts.js";
import { openEarnings, openNews, openSignals, setSigTabBadge } from "./calendar.js";
import { openCharts } from "./charts.js";
import { DAY, activeRows, clamp, el, esc, inScope, momColor, overlayCloseAll, scopeBench, state } from "./core.js";
import { BASKETS, basketScopeList, basketVirtualRow, compgAuto, dailyFunding, dailyLevels, dailyOI, dailyReturns, loadBaskets, openCorr, overnightReturns, renderCorr, syncCorrLookback } from "./corr.js";
import { fetchJSON, loadDaily, updateAggregates } from "./data.js";
import { openFocus } from "./focus.js";
import { openFunds } from "./funds.js";
import { openCongress, openInsiders } from "./insiders.js";
import { buildHead, render, renderRegimeStrip, syncGrpSeg, updateDrillChip, updateMovers } from "./markets.js";
import { openDM } from "./messages.js";
import { applyTabVisibility, closeHelp, closeTabMenus, syncTabGroups } from "./nav.js";
import { openHousing, openLiquidity, openNotes } from "./notes.js";
import { drawSessions } from "./positioning.js";
import { openReportView } from "./report.js";
import { renderSectors } from "./sectors.js";
import { openTrend, renderSignals, renderTrend } from "./trend.js";

// ===== Strategy backtest — client-side, cross-sectional long/short on the daily returns already loaded =====
// Everything runs in-browser off state.rows[*].daily (shipped via /api/daily) + the SP500 benchmark, so
// parameter tweaks are instant and add no server load. Non-fitted ranking rules: the honest overfitting
// risk is the user picking params by eye, which the in-sample/out-of-sample split is there to expose.
const BT_MIN_DAYS=25, BT_ANN=252;
const BT_SIGNALS={ mom:'Momentum', smom:'Sector-relative momentum', rev:'Short-term reversion', res:'Residual momentum (β-neutral)',
  lowvol:'Low volatility', ivol:'Low idiosyncratic vol', beta:'Low beta (BAB)', max:'Anti-lottery (low MAX)',
  carry:'Funding carry', hprox:'High proximity', volt:'Volume trend', oid:'OI change',
  m0:'Blend M0 — live-score analogue', mres:'Blend V1 — β-residual slow horizons', moi:'Blend V2 — regime-qualified OI',
  mfund:'Blend V3 — funding-crowding haircut', mpart:'Blend V4 — volume participation' };
// the live-score variant family: the promotion bench for the Markets-tab momentum column. Fixed
// 1/7/30d horizons mirroring computeMomentum — the lookback control is ignored for these five.
const BT_MVAR={ m0:1, mres:1, moi:1, mfund:1, mpart:1 };
// signals that need payload columns beyond closes — btRun reports an honest "not shipped" instead of an empty rank
const BT_NEEDS={ carry:'fundCov', hprox:'hiCov', volt:'voCov', oid:'oiCov', moi:'oiCov', mfund:'fundCov', mpart:'voCov' };
function btAnn(){ return state.scope==='crypto'?365:BT_ANN; }   // crypto trades every day; equities ~252 sessions
// ===== Target picks — the cross-section is a choice, not a given =====================
// picks[] holds coins the user typed into the target box. Zero picks is the tab's original
// behaviour (rank the whole universe). ONE pick collapses the cross-section entirely: a rank of
// one name is not a rank, so the run becomes a time-series timing rule (see btRunOne) and the
// controls that only exist to slice a cross-section are disabled rather than silently ignored.
// Several picks stay cross-sectional over exactly those names — a custom universe, thin book and
// all, which the render says out loud.
const BT_SET_MIN=4;        // floor for a picked set: below 4 names the tails aren't a cross-section, they're a coin flip
const BT_VOLTGT=0.20;      // inverse-vol sizing on one name targets 20% annualized — the cross-sectional path has no equivalent to inherit
const BT_TRADE_MIN=10;     // fewer round trips than this and the Sharpe is an anecdote; the stat is flagged, never hidden
function btPickRows(){     // picked rows that exist, carry daily history and belong to the live scope
  const out=[], seen=new Set();
  for(const c of state.backtest.picks){ if(seen.has(c)) continue; seen.add(c);
    const r=state.rows.get(c); if(!r||r.delisted||!inScope(r)||!r.daily) continue;
    const m=dailyReturns(r); if(!m||m.size<BT_MIN_DAYS) continue;
    out.push(r); }
  return out;
}
function btMode(){ const n=btPickRows().length; return n===0?'universe':(n===1?'single':'set'); }
function btUniverse(){
  const u=state.backtest.universe, cr=state.scope==='crypto';
  // An explicit target supersedes the universe select — never both at once. Keyed on the RESOLVED
  // rows, not the raw pick list, so a pick that stops resolving (delisted mid-session, history
  // aged out) can't hand the run an empty universe while btMode still reads "universe": the two
  // must agree about what is being tested, and the chip's own dimmed state says the pick sat out.
  const pr=btPickRows(); if(pr.length) return pr;
  return [...state.rows.values()].filter(r=>{
    if((r.uni==='main')!==cr) return false;                       // scope picks the universe: xyz vs Hyperliquid main — never merged
    if(r.delisted || !r.daily || r.coin===scopeBench()) return false;
    const m=dailyReturns(r); if(!m || m.size<BT_MIN_DAYS) return false;
    if(cr) return true;                                           // crypto: whole roster; sector/equity filters are xyz concepts
    if(u==='eq') return r.assetClass==='Equity';
    if(u && u.indexOf('sec:')===0) return r.sector===u.slice(4);
    return true;
  });
}
function btMatrix(rowsIn){
  const rows=rowsIn||btUniverse(), dayset=new Set(), rmap=new Map();   // rowsIn: single-asset mode builds the matrix over the target (plus its sector peers, when the rule needs them)
  for(const r of rows){ const m=dailyReturns(r); rmap.set(r.coin,m); for(const d of m.keys()) dayset.add(d); }
  const days=[...dayset].sort((a,b)=>a-b), idx=new Map(days.map((d,i)=>[d,i]));
  const series=new Map();                                   // dense per-name log-return series over the common day axis (NaN where missing)
  for(const r of rows){ const m=rmap.get(r.coin), a=new Float64Array(days.length).fill(NaN);
    for(const [d,v] of m) a[idx.get(d)]=v; series.set(r.coin,a); }
  let benchSeries=null; const bC=scopeBench(), bench=bC?state.rows.get(bC):null;   // SP500 anchors stocks, BTC anchors crypto
  if(bench){ const bm=dailyReturns(bench); if(bm){ benchSeries=new Float64Array(days.length).fill(NaN); for(const [d,v] of bm) if(idx.has(d)) benchSeries[idx.get(d)]=v; } }
  const fund=new Map();                                     // per-name daily funding a 1x long pays (0 where unknown), aligned to the day axis
  let fundCov=0;
  for(const r of rows){ const fm=dailyFunding(r); if(fm && fm.size){ const a=new Float64Array(days.length).fill(0); for(const [d,v] of fm) if(idx.has(d)) a[idx.get(d)]=v; fund.set(r.coin,a); fundCov++; } }
  const ovG=new Map(), ovF=new Map(); let ovCov=0;          // overnight+weekend hold: gross return (NaN where no hold that morning) and the funding paid during the hold
  for(const r of rows){ const ov=overnightReturns(r); if(ov && ov.g.size){ const g=new Float64Array(days.length).fill(NaN), f=new Float64Array(days.length).fill(0);
      for(const [d,v] of ov.g) if(idx.has(d)){ g[idx.get(d)]=v; f[idx.get(d)]=ov.f.get(d)||0; } ovG.set(r.coin,g); ovF.set(r.coin,f); ovCov++; } }
  const pxm=new Map(), him=new Map(), vom=new Map(), oim=new Map(); let hiCov=0, voCov=0, oiCov=0;   // level columns for the level-based signals
  for(const r of rows){ const lv=dailyLevels(r); if(lv){
      const px=new Float64Array(days.length).fill(NaN); let hi=null, vo=null;
      for(const [d,o] of lv){ if(!idx.has(d)) continue; const i=idx.get(d); px[i]=o.c;
        if(o.h!=null){ if(!hi) hi=new Float64Array(days.length).fill(NaN); hi[i]=o.h; }
        if(o.v!=null){ if(!vo) vo=new Float64Array(days.length).fill(NaN); vo[i]=o.v; } }
      pxm.set(r.coin,px); if(hi){ him.set(r.coin,hi); hiCov++; } if(vo){ vom.set(r.coin,vo); voCov++; } }
    const om=dailyOI(r); if(om && om.size){ const a=new Float64Array(days.length).fill(NaN); let n=0;
      for(const [d,v] of om) if(idx.has(d)){ a[idx.get(d)]=v; n++; } if(n>=5){ oim.set(r.coin,a); oiCov++; } } }
  return { rows, days, series, benchSeries, fund, fundCov, ovG, ovF, ovCov, pxm, him, vom, oim, hiCov, voCov, oiCov };
}
// ===== Live-score variant family (2026.07.24-05): the daily-granularity mirror of computeMomentum =====
// Purpose: validate candidate upgrades to the Markets-tab momentum score OUT OF SAMPLE before any of
// them touches the live column. M0 is the control — the closest daily-computable analogue of the
// shipped blend (risk-adjusted 1/7/30d returns at .40/.40/.20, cross-horizon coherence, range tilt;
// the intraday h1/h4 terms are untestable at daily granularity and carry over unchanged regardless).
// V1–V4 are M0 plus exactly ONE candidate term each, so an OOS delta vs M0 measures that term and
// nothing else. Honest limits, stated not hidden: the range tilt runs on closes for BOTH rails (the
// daily tuple ships no low, and one high-only rail would skew the tilt); names missing a modulation
// column (OI / funding / volume) fall back to the unmodulated core so the ranked universe stays
// identical to the control and the comparison measures the term, not universe drift.
function btMomVariant(sig, a, bench, di, ex){
  if(di<30) return NaN;
  // trailing 30d daily vol through di — the risk yardstick for every horizon (live: measured volD)
  let vs=0,vq=0,vn=0; for(let i=di-29;i<=di;i++){ const x=a[i]; if(Number.isFinite(x)){ vs+=x; vq+=x*x; vn++; } }
  if(vn<15) return NaN;
  const vm=vs/vn, volD=Math.sqrt(Math.max(0,(vq-vn*vm*vm)/(vn-1)));
  if(!(volD>0)) return NaN;
  // β for V1: trailing ≤90d regression through di (no lookahead), min 40 overlapping days; below
  // that the residualization falls back to raw — a β fit on a stub window is worse than none
  let beta=null;
  if(sig==='mres'&&bench){ const lo=Math.max(0,di-89); let mn=0,mb=0,cn=0;
    for(let i=lo;i<=di;i++){ const x=a[i],y=bench[i]; if(Number.isFinite(x)&&Number.isFinite(y)){ mn+=x; mb+=y; cn++; } }
    if(cn>=40){ mn/=cn; mb/=cn; let c=0,vb=0;
      for(let i=lo;i<=di;i++){ const x=a[i],y=bench[i]; if(Number.isFinite(x)&&Number.isFinite(y)){ c+=(x-mn)*(y-mb); vb+=(y-mb)*(y-mb); } }
      if(vb>0) beta=c/vb; } }
  // risk-adjusted horizon blend: z_h = Σ log-returns / (volD·√h); weights .40/.40/.20 renormalized
  // over the horizons present (mirrors the live score skipping missing windows). The 7d horizon is
  // mandatory — without it the score is just yesterday's bar wearing a blend's name.
  let ws=0,wzs=0,wza=0,has7=false;
  for(const [h,wt] of [[1,0.40],[7,0.40],[30,0.20]]){
    let rs=0,rn=0,bs=0;
    for(let i=di-h+1;i<=di;i++){ const x=a[i]; if(Number.isFinite(x)){ rs+=x; rn++; }
      if(beta!=null&&h>=7){ const y=bench[i]; if(Number.isFinite(y)) bs+=y; } }
    if(rn<Math.max(1,Math.ceil(h*0.6))) continue;
    const z=((beta!=null&&h>=7)?rs-beta*bs:rs)/(volD*Math.sqrt(h));   // V1: slow horizons keep only the idiosyncratic move; 1d stays raw
    ws+=wt; wzs+=wt*z; wza+=wt*Math.abs(z); if(h===7) has7=true;
  }
  if(!(ws>0)||!has7) return NaN;
  const kappa=wza>0?Math.abs(wzs)/wza:0;   // cross-horizon coherence — same read as the live score
  let core=(wzs/ws)*(0.5+0.5*kappa);
  // range-position tilt over 30d of closes (symmetric by construction — see the header note)
  const px=ex&&ex.px;
  if(px){ let hi=-Infinity,lo=Infinity,pn=0;
    for(let i=di-29;i<=di;i++){ const p=px[i]; if(Number.isFinite(p)&&p>0){ if(p>hi)hi=p; if(p<lo)lo=p; pn++; } }
    if(pn>=15&&hi>lo&&Number.isFinite(px[di])) core+=0.4*(clamp((px[di]-lo)/(hi-lo),0,1)-0.5)*2; }
  // V2 — regime-qualified OI: OI building WITH the score's side (longs+ / shorts+) amplifies,
  // scaled by funding corroboration (the crowd paying to be on that side = new conviction, not
  // noise); OI FALLING (squeeze / unwind) dampens — covering is mechanically different flow from
  // new money and must not amplify like it. Clamped to the live score's [0.6, 1.4] band.
  if(sig==='moi'){ const o=ex&&ex.oi;
    if(o){ let f0=NaN,l0=NaN,on=0;
      for(let i=di-7;i<=di;i++){ const x=o[i]; if(Number.isFinite(x)&&x>0){ if(!Number.isFinite(f0)) f0=x; l0=x; on++; } }
      if(on>=3&&f0>0&&core!==0){
        const doi=(l0/f0-1)*100;
        let mult=1;
        if(doi>0){ let c=0.5; const f=ex&&ex.f;   // corroboration: 1 = funding moved with the flow story, 0 = against, 0.5 = flat/unknown
          if(f){ let f7=0,fn=0; for(let i=di-6;i<=di;i++){ const x=f[i]; if(Number.isFinite(x)){ f7+=x; fn++; } }
            if(fn>=4){ const agree=core>0?f7:-f7; c=agree>1e-6?1:(agree<-1e-6?0:0.5); } }
          mult=1+0.4*Math.tanh(doi/8)*(0.5+0.5*c); }
        else if(doi<0) mult=1-0.2*Math.tanh(-doi/8);
        core*=clamp(mult,0.6,1.4);
      } } }
  // V3 — funding-crowding haircut: today's funding at its own 31d extreme with the crowd on the
  // SAME side as the score -> ×0.8. The exhaustion tax the board's ▴/▾ percentile flag points at.
  if(sig==='mfund'){ const f=ex&&ex.f;
    if(f&&core!==0&&Number.isFinite(f[di])){ const vals=[];
      for(let i=di-30;i<=di;i++){ const x=f[i]; if(Number.isFinite(x)) vals.push(x); }
      if(vals.length>=20&&Math.max.apply(null,vals)>Math.min.apply(null,vals)){   // a flat distribution has no extremes — rank(≤) on constants would read 1.0 and tax every flat-funding name
        let le=0; for(const x of vals) if(x<=f[di]) le++;
        const rank=le/vals.length;
        if(core>0&&f[di]>0&&rank>=0.9) core*=0.8;
        else if(core<0&&f[di]<0&&rank<=0.1) core*=0.8; } } }
  // V4 — volume participation: recent 5d vs 30d average volume, small symmetric multiplier — a
  // move on volume outranks the same move on air, capped at ±15% so participation only nudges.
  if(sig==='mpart'){ const vo=ex&&ex.vo;
    if(vo){ let rs=0,rn=0,bs=0,bn=0;
      for(let i=di-29;i<=di;i++){ const v=vo[i]; if(Number.isFinite(v)&&v>=0){ bs+=v; bn++; if(i>di-5){ rs+=v; rn++; } } }
      if(bn>=15&&rn>=3&&bs>0) core*=clamp(1+0.15*Math.tanh(Math.log((rs/rn+1e-12)/(bs/bn+1e-12))/0.4),0.85,1.15); } }
  return 100*Math.tanh(core/1.5);   // the live squash — ranks unchanged, magnitudes match the board's −100…+100 semantics
}
// signal score for one name at day-index di over a trailing L-day window (uses data through di only — no
// lookahead). `ex` carries the extra aligned columns { f:funding, px:closes, hi:highs, vo:volume, oi:openInterest }
// (each null when not shipped). Every score is oriented so HIGHER = the quantity we long under direction=high.
function btScore(sig, a, bench, di, L, ex){
  if(BT_MVAR[sig]) return btMomVariant(sig, a, bench, di, ex);   // the variant family runs fixed horizons — L does not apply
  const lo=di-L+1; if(lo<0) return NaN;
  if(sig==='rev'){ const v=a[di]; return Number.isFinite(v)? -v : NaN; }            // fade the most recent day
  if(sig==='carry'){ const f=ex&&ex.f; if(!f) return NaN;                            // long the names shorts pay to hold: score = −(window funding a 1x long pays)
    let s=0; for(let i=lo;i<=di;i++){ const x=f[i]; if(Number.isFinite(x)) s+=x; } return -s; }
  if(sig==='hprox'){ const px=ex&&ex.px, hi=ex&&ex.hi; if(!px||!hi) return NaN;      // closeness to the window high: log(close / max high), ≤0, 0 = printing the high now
    const p0=px[di]; if(!Number.isFinite(p0)||p0<=0) return NaN;
    let mx=-Infinity,n=0; for(let i=lo;i<=di;i++){ const h=Number.isFinite(hi[i])?hi[i]:px[i]; if(Number.isFinite(h)&&h>0){ if(h>mx)mx=h; n++; } }
    return n>=Math.max(5,L*0.6)&&mx>0? Math.log(p0/mx) : NaN; }
  if(sig==='volt'){ const vo=ex&&ex.vo; if(!vo) return NaN;                          // recent-vs-window volume, log ratio (ambiguous sign by nature — the direction toggle decides which tail you own)
    const k=Math.min(5,Math.max(2,Math.round(L/4)));
    let rs=0,rn=0,bs=0,bn=0; for(let i=lo;i<=di;i++){ const v=vo[i]; if(Number.isFinite(v)&&v>=0){ bs+=v; bn++; if(i>di-k){ rs+=v; rn++; } } }
    if(bn<Math.max(5,L*0.6)||rn<1||!(bs>0)) return NaN; return Math.log((rs/rn+1e-12)/(bs/bn+1e-12)); }
  if(sig==='oid'){ const o=ex&&ex.oi; if(!o) return NaN;                             // OI change across the window: log(last/first finite)
    let f0=NaN,l0=NaN,n=0; for(let i=lo;i<=di;i++){ const x=o[i]; if(Number.isFinite(x)&&x>0){ if(!Number.isFinite(f0)) f0=x; l0=x; n++; } }
    return n>=Math.max(4,Math.round(L*0.4))&&f0>0? Math.log(l0/f0) : NaN; }
  if(sig==='res'||sig==='beta'||sig==='ivol'){                                       // one β regression, three reads: residual return, −β (BAB), −residual vol
    let mn=0,mb=0,cn=0; for(let i=lo;i<=di;i++){ const x=a[i], y=bench?bench[i]:NaN; if(Number.isFinite(x)&&Number.isFinite(y)){ mn+=x; mb+=y; cn++; } }
    if(cn<Math.max(5,L*0.6)) return NaN; mn/=cn; mb/=cn;
    let c=0,vb=0,vx=0,sx=0,sy=0; for(let i=lo;i<=di;i++){ const x=a[i], y=bench?bench[i]:NaN; if(Number.isFinite(x)&&Number.isFinite(y)){ c+=(x-mn)*(y-mb); vb+=(y-mb)*(y-mb); vx+=(x-mn)*(x-mn); sx+=x; sy+=y; } }
    const b=vb>0?c/vb:0;
    if(sig==='beta') return -b;
    if(sig==='ivol') return -Math.sqrt(Math.max(0,(vx-b*b*vb)/Math.max(1,cn-1)));
    return sx-b*sy;
  }
  let sum=0,sq=0,mx=-Infinity,n=0; for(let i=lo;i<=di;i++){ const x=a[i]; if(Number.isFinite(x)){ sum+=x; sq+=x*x; if(x>mx)mx=x; n++; } }
  if(n<Math.max(5,L*0.6)) return NaN;
  if(sig==='lowvol'){ const mean=sum/n, varr=(sq-n*mean*mean)/Math.max(1,n-1); return -Math.sqrt(Math.max(0,varr)); }  // low vol ranks high
  if(sig==='max') return -mx;                                                        // anti-lottery: the boring names rank high, the biggest single-day pop ranks low
  // momentum (also the base score smom demeans by sector): skip the most recent day so 1-day reversion doesn't contaminate the trend
  let s2=0,n2=0; for(let i=lo;i<=di-1;i++){ const x=a[i]; if(Number.isFinite(x)){ s2+=x; n2++; } }
  return n2>=Math.max(4,L*0.5)? s2 : NaN;
}
function btRun(){
  const p=state.backtest, mode=btMode();
  if(mode==='single') return btRunOne(p);
  const mx=btMatrix();
  const warmN=BT_MVAR[p.signal]?Math.max(p.lookback,31):p.lookback;   // variants need their fixed 30d horizon + 1 regardless of the lookback setting
  const minRows=mode==='set'?BT_SET_MIN:8;                            // a picked set is allowed to be small; the whole universe is not
  if(mx.rows.length<minRows || mx.days.length<warmN+p.cadence+6) return { ok:false, have:mx.rows.length, days:mx.days.length, need:minRows };
  const { rows, days, series, benchSeries, fund, fundCov, ovG, ovF, ovCov, pxm, him, vom, oim, hiCov, voCov, oiCov }=mx, coins=rows.map(r=>r.coin);
  const covOf={ fundCov, hiCov, voCov, oiCov };
  if(BT_NEEDS[p.signal] && !(covOf[BT_NEEDS[p.signal]]>0)) return { ok:false, nodata:BT_SIGNALS[p.signal] };   // the column this rule ranks on isn't in the payload yet — say so instead of ranking nothing
  const L=p.lookback, cad=Math.max(1,p.cadence), q=p.quantile, costR=p.cost/1e4, start=warmN, on=p.holdWindow==='on' && state.scope!=='crypto';   // 24/7 markets have no overnight boundary
  let weights=new Map(), lastBook=null, feeCum=0, fundCum=0;
  const tkOf=new Map(rows.map(r=>[r.coin, r.ticker]));
  const secOf=new Map(rows.map(r=>[r.coin, r.sector||r.assetClass||'—']));           // smom demean groups; unsectored names pool together
  const exOf=(c)=>({ f:fund.get(c)||null, px:pxm.get(c)||null, hi:him.get(c)||null, vo:vom.get(c)||null, oi:oim.get(c)||null });
  const base=p.signal==='smom'?'mom':p.signal;
  const portR=[], eq=[1], eqg=[1], eqb=[1], eqew=[1], curveDays=[days[start]];
  let turnoverSum=0, rebalances=0, posSum=0, posCount=0;
  for(let di=start; di<days.length-1; di++){
    if((di-start)%cad===0){                                          // rebalance
      const scored=[];
      for(const c of coins){ const raw=btScore(base, series.get(c), benchSeries, di, L, exOf(c));
        if(Number.isFinite(raw)) scored.push({ c, raw }); }
      if(p.signal==='smom'){                                         // sector-relative: demean the raw momentum within each sector so no rank is just a sector bet
        const gs=new Map(); for(const z of scored){ const g=secOf.get(z.c); const b=gs.get(g)||[0,0]; b[0]+=z.raw; b[1]++; gs.set(g,b); }
        for(const z of scored){ const b=gs.get(secOf.get(z.c)); z.raw=z.raw-(b[1]?b[0]/b[1]:0); }
      }
      for(const z of scored) z.s=(p.direction==='low'? -z.raw : z.raw);              // s = the quantity we go long on
      scored.sort((a,b)=>b.s-a.s);
      const N=scored.length, k=Math.max(1,Math.min(N,Math.floor(N*q))), nw=new Map();
      let longs=scored.slice(0,k), shorts=scored.slice(N-k);
      if(p.reqSign){ longs=longs.filter(x=>x.s>0); shorts=shorts.filter(x=>x.s<0); }   // only take names whose signal actually points the right way
      const wt=(x)=> p.weighting==='sig' ? Math.max(1e-9,Math.abs(x.s))
                   : p.weighting==='vol' ? (function(){ const v=btVol(series.get(x.c),di,L); return v>0?1/v:0; })()
                   : 1;                                                                 // equal
      const place=(arr,budget)=>{ if(!arr.length) return; const w=arr.map(wt); let sum=0; for(const z of w) sum+=z;
        if(!(sum>0)){ arr.forEach(x=>nw.set(x.c,(nw.get(x.c)||0)+budget/arr.length)); return; }
        arr.forEach((x,i)=> nw.set(x.c,(nw.get(x.c)||0)+budget*w[i]/sum)); };
      if(p.structure==='long'){ if(longs.length) place(longs,+1); }   // long-only: full capital long the top (or all, if book=all)
      else if(p.structure==='short'){ if(shorts.length) place(shorts,-1); }
      else if(N>=2*k){ place(longs,+0.5); place(shorts,-0.5); }       // long/short dollar-neutral needs disjoint tails
      posSum+=nw.size; if(nw.size) posCount++;
      const bk={ longs:[], shorts:[] };                              // snapshot the book for the "what it holds now" panel
      for(const [c,w] of nw){ const s=scored.find(z=>z.c===c); (w>=0?bk.longs:bk.shorts).push({ coin:c, ticker:tkOf.get(c)||c, w, score:s?s.raw:null }); }
      bk.longs.sort((a,b)=>b.w-a.w); bk.shorts.sort((a,b)=>a.w-b.w); lastBook=bk;
      let to=0; const keys=new Set([...weights.keys(),...nw.keys()]);
      for(const c of keys) to+=Math.abs((nw.get(c)||0)-(weights.get(c)||0));
      turnoverSum+=to; rebalances++;
      if(!on){ feeCum+=to*costR; eq[eq.length-1]*=(1-to*costR); }      // close-to-close: taker fee on turnover; overnight charges a nightly round-trip instead
      weights=nw;
    }
    const fd=di+1; let pr=0, fpay=0, ok=false, gb=0;
    if(on){                                                            // overnight: capture the close->open (+weekend) hold, flat during the cash session
      for(const [c,w] of weights){ const ga=ovG.get(c), g=ga?ga[fd]:NaN;
        if(Number.isFinite(g)){ pr+=w*g; ok=true; gb+=Math.abs(w); }   // overnight gross is already a simple return
        const fa=ovF.get(c); if(fa) fpay+=w*fa[fd]; }
    } else {
      for(const [c,w] of weights){ const x=series.get(c)[fd]; if(Number.isFinite(x)){ pr+=w*(Math.exp(x)-1); ok=true; } const fa=fund.get(c); if(fa) fpay+=w*fa[fd]; }
    }
    pr=ok?pr:0; const fRet=-fpay;                                    // a position pays w*rate: a long pays when funding>0, a short receives
    const feeDay=on? gb*2*costR : 0;                                 // overnight round-trips the whole book every night (exit at open + enter at close)
    if(on) feeCum+=feeDay;
    fundCum+=fRet; portR.push(pr+fRet-feeDay);                        // net return incl. funding and (overnight) the nightly fee
    eq.push(eq[eq.length-1]*(1+pr+fRet-feeDay)); eqg.push(eqg[eqg.length-1]*(1+pr));   // gross = price only; net = price + funding − fees
    const bx=benchSeries?benchSeries[fd]:NaN; eqb.push(eqb[eqb.length-1]*(1+(Number.isFinite(bx)?Math.exp(bx)-1:0)));
    let ew=0,ewn=0; for(const c of coins){ const x=series.get(c)[fd]; if(Number.isFinite(x)){ ew+=Math.exp(x)-1; ewn++; } }
    eqew.push(eqew[eqew.length-1]*(1+(ewn?ew/ewn:0))); curveDays.push(days[fd]);
  }
  return { ok:true, days:curveDays, eq, eqg, eqb, eqew, portR,
    turnover:rebalances?turnoverSum/rebalances:0, avgPos:posCount?posSum/posCount:0, universeN:rows.length, book:lastBook,
    fundCov, fundCum, feeCum, ovCov, on };
}
// ===== Single-asset mode — the same signal, run as a timing rule on one name ==================
// What changes: the score stops being a RANK and becomes a LEVEL, so the position comes from the
// score's own sign measured against an entry threshold in that name's own units. What deliberately
// does NOT change: the cost model, the funding accrual, the hold window, the IS/OOS split and the
// stats — a real position's drag doesn't care how the position was chosen, and reusing the exact
// accounting is what keeps the two modes comparable.
// Threshold units: σ here is the RMS of that name's own PAST scores measured about zero (not about
// their mean), computed through the current day only — no lookahead, and "score > 0" and "±1σ" sit
// on the same axis, which they wouldn't if the scale were demeaned.
function btRunOne(p){
  const tgt=btPickRows()[0]; if(!tgt) return { ok:false, have:0, days:0, need:1 };
  const cr=state.scope==='crypto', L=p.lookback, cad=Math.max(1,p.cadence), costR=p.cost/1e4;
  const warmN=BT_MVAR[p.signal]?Math.max(L,31):L;
  // Sector-relative momentum is a demean against peers, so on one name the peers have to come
  // along — otherwise the rule silently degrades to plain momentum under a label that promises
  // otherwise. They join the matrix (shared day axis) but never take a position.
  const peers=p.signal==='smom'
    ? [...state.rows.values()].filter(r=>r.coin!==tgt.coin && !r.delisted && inScope(r) && r.daily
        && (r.sector||r.assetClass||'—')===(tgt.sector||tgt.assetClass||'—')
        && (dailyReturns(r)||{size:0}).size>=BT_MIN_DAYS)
    : [];
  if(p.signal==='smom' && peers.length<3) return { ok:false, nopeers:(tgt.sector||tgt.assetClass||'its sector'), have:peers.length };   // a "sector-relative" score with no sector to be relative to would be plain momentum wearing the wrong label
  const mx=btMatrix([tgt,...peers]);
  const { days, series, benchSeries, fund, fundCov, ovG, ovF, ovCov, pxm, him, vom, oim, hiCov, voCov, oiCov }=mx;
  const N=days.length;
  if(N<warmN+cad+6) return { ok:false, have:1, days:N, need:1 };
  const covOf={ fundCov, hiCov, voCov, oiCov };
  if(BT_NEEDS[p.signal] && !(covOf[BT_NEEDS[p.signal]]>0)) return { ok:false, nodata:BT_SIGNALS[p.signal] };   // this name doesn't carry the column the rule ranks on
  const c=tgt.coin, a=series.get(c);
  const ex={ f:fund.get(c)||null, px:pxm.get(c)||null, hi:him.get(c)||null, vo:vom.get(c)||null, oi:oim.get(c)||null };
  const base=p.signal==='smom'?'mom':p.signal;
  const peerC=peers.map(r=>r.coin);
  const raw=new Array(N).fill(NaN);                       // the score on each day, using data through that day only
  for(let di=warmN; di<N; di++){
    let s=btScore(base, a, benchSeries, di, L, ex);
    if(!Number.isFinite(s)) continue;
    if(p.signal==='smom'){ let ps=0,pn=0;
      for(const pc of peerC){ const v=btScore('mom', series.get(pc), benchSeries, di, L, null); if(Number.isFinite(v)){ ps+=v; pn++; } }
      if(pn<3) continue;                                  // under three peers there is no sector mean worth subtracting
      s-=ps/pn; }
    raw[di]=s;
  }
  const scale=new Array(N).fill(NaN);                     // trailing RMS about zero — the σ the entry threshold is quoted in
  { let q=0,n=0; for(let di=warmN; di<N; di++){ if(n>=8) scale[di]=Math.sqrt(q/n);   // ≥8 past scores before a scale means anything
      const x=raw[di]; if(Number.isFinite(x)){ q+=x*x; n++; } } }
  const on=p.holdWindow==='on' && !cr;
  const start=warmN;
  const eq=[1], eqg=[1], eqb=[1], eqbh=[1], curveDays=[days[start]], portR=[], pos=[], trades=[];
  let w=0, feeCum=0, fundCum=0, inMkt=0, open=null, flips=0;
  for(let di=start; di<N-1; di++){
    if((di-start)%cad===0){                               // re-decide the position
      let nw=0; const s=raw[di], sig=(p.direction==='low'? -s : s);   // sig = the quantity we go long on
      if(Number.isFinite(sig) && sig!==0){
        const sc=scale[di];
        const clears = p.entry<=0 ? true : (Number.isFinite(sc) && sc>0 && Math.abs(sig)>=p.entry*sc);
        if(clears) nw=sig>0?1:-1;
        if(p.structure==='long'&&nw<0) nw=0;              // long-only: long or flat, never short
        if(p.structure==='short'&&nw>0) nw=0;
        if(nw!==0){
          if(p.weighting==='sig'){ nw*=(Number.isFinite(sc)&&sc>0)? clamp(Math.abs(sig)/sc,0.25,2) : 1; }        // size with conviction
          else if(p.weighting==='vol'){ const v=btVol(a,di,Math.max(20,L)); nw*= v>0? clamp(BT_VOLTGT/(v*Math.sqrt(btAnn())),0.25,2) : 1; }   // size to a 20% annualized vol target
        }
      }
      if(nw!==w){
        const to=Math.abs(nw-w);
        if(!on){ feeCum+=to*costR; eq[eq.length-1]*=(1-to*costR); }   // overnight charges its nightly round-trip below instead
        flips++;
        if(open){ open.exit=days[di]; open.ret=eq[eq.length-1]/open.eq0-1; trades.push(open); open=null; }
        if(nw!==0) open={ side:nw>0?'LONG':'SHORT', size:Math.abs(nw), entry:days[di], eq0:eq[eq.length-1], score:raw[di], z:(Number.isFinite(scale[di])&&scale[di]>0)?raw[di]/scale[di]:null };
        w=nw;
      }
    }
    const fd=di+1; let pr=0, fpay=0;
    if(on){ const ga=ovG.get(c), g=ga?ga[fd]:NaN;         // overnight: hold the close→open gap, flat through the cash session
      if(Number.isFinite(g)) pr=w*g;
      const fa=ovF.get(c); if(fa) fpay=w*fa[fd];
    } else {
      const x=a[fd]; if(Number.isFinite(x)) pr=w*(Math.exp(x)-1);
      const fa=fund.get(c); if(fa) fpay=w*fa[fd];
    }
    const fRet=-fpay, feeDay=on? Math.abs(w)*2*costR : 0;  // a long pays funding, a short receives it
    if(on) feeCum+=feeDay;
    fundCum+=fRet; if(w!==0) inMkt++;
    portR.push(pr+fRet-feeDay);
    eq.push(eq[eq.length-1]*(1+pr+fRet-feeDay));
    eqg.push(eqg[eqg.length-1]*(1+pr));                    // gross = price only; the gross↔net gap is funding + fees
    const bx=benchSeries?benchSeries[fd]:NaN;
    eqb.push(eqb[eqb.length-1]*(1+(Number.isFinite(bx)?Math.exp(bx)-1:0)));
    const ax=a[fd];
    eqbh.push(eqbh[eqbh.length-1]*(1+(Number.isFinite(ax)?Math.exp(ax)-1:0)));   // buy & hold the name itself — the only benchmark a one-name rule has to beat
    pos.push(w); curveDays.push(days[fd]);
  }
  if(open){ open.exit=days[N-1]; open.ret=eq[eq.length-1]/open.eq0-1; open.live=true; trades.push(open); }
  return { ok:true, single:true, row:tgt, days:curveDays, eq, eqg, eqb, eqew:eqbh, eqbh, portR, pos, trades,
    turnover:0, avgPos:inMkt?1:0, universeN:1, book:null, peers:peers.length,
    fundCov, fundCum, feeCum, ovCov, on, flips, exposure:pos.length?inMkt/pos.length:0,
    curW:w, curScore:raw[N-2], curZ:(Number.isFinite(scale[N-2])&&scale[N-2]>0)?raw[N-2]/scale[N-2]:null };
}
function btVol(a, di, L){ const lo=di-L+1; if(lo<0) return 0; let s=0,sq=0,n=0;
  for(let i=lo;i<=di;i++){ const x=a[i]; if(Number.isFinite(x)){ s+=x; sq+=x*x; n++; } }
  if(n<3) return 0; const m=s/n; return Math.sqrt(Math.max(0,(sq-n*m*m)/(n-1))); }
function btStats(portR, eqSeg, ann){
  const n=portR.length; if(!n||eqSeg.length<2) return null;
  let mean=0; for(const x of portR) mean+=x; mean/=n;
  let v=0; for(const x of portR) v+=(x-mean)*(x-mean); const sd=Math.sqrt(v/Math.max(1,n-1));
  let hit=0; for(const x of portR) if(x>0) hit++;
  const total=eqSeg[eqSeg.length-1]/eqSeg[0]-1;
  let peak=eqSeg[0], mdd=0; for(const e of eqSeg){ if(e>peak) peak=e; const dd=e/peak-1; if(dd<mdd) mdd=dd; }
  return { total, sharpe: sd>0? mean/sd*Math.sqrt(ann||BT_ANN):0, hit:hit/n, mdd, n };
}
// equity curve: net (accent) / gross (blue) / benchmark (muted) / equal-weight (faint); IS|OOS split shaded; crosshair hover
function btCurveSvg(res, splitIdx){
  const W=680,H=res.single?232:210, pl=48,pr=54,pt=14,pb=res.single?48:26, days=res.days, m=days.length;   // single-asset mode reserves a strip under the axis for the position ribbon
  const pct=arr=>arr.map(e=>(e/arr[0]-1)*100);
  const net=pct(res.eq), gross=pct(res.eqg), bench=pct(res.eqb), ew=pct(res.eqew);
  const vb=res.eqvb?pct(res.eqvb):null;
  let lo=Infinity,hi=-Infinity; for(const arr of (vb?[net,gross,bench,ew,vb]:[net,gross,bench,ew])) for(const y of arr){ if(y<lo)lo=y; if(y>hi)hi=y; }
  if(!(hi>lo)){ hi=1; lo=-1; } const padv=(hi-lo)*0.08||1; lo-=padv; hi+=padv;
  const X=i=>pl+(m<2?0:i/(m-1))*(W-pl-pr), Y=y=>pt+(1-(y-lo)/(hi-lo))*(H-pt-pb);
  const path=arr=>arr.map((y,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(y).toFixed(1)).join(' ');
  const ticks=lcTicks(lo,hi,4);
  let s='';
  if(splitIdx>0 && splitIdx<m-1){                                   // shade the out-of-sample region
    s+=`<rect x="${X(splitIdx).toFixed(1)}" y="${pt}" width="${(X(m-1)-X(splitIdx)).toFixed(1)}" height="${H-pt-pb}" fill="var(--accent)" opacity="0.05"/>`;
    s+=`<line x1="${X(splitIdx).toFixed(1)}" y1="${pt}" x2="${X(splitIdx).toFixed(1)}" y2="${H-pb}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>`;
    s+=`<text x="${(X(splitIdx)+4).toFixed(1)}" y="${pt+9}" class="lc-tick" style="fill:var(--muted)">out-of-sample →</text>`;
  }
  s+=lcGrid(pl,W-pr,ticks,Y,v=>(v>0?'+':'')+v.toFixed(1)+'%');
  s+=`<line x1="${pl}" y1="${Y(0).toFixed(1)}" x2="${W-pr}" y2="${Y(0).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`;
  // the fourth line is the naive alternative to the whole exercise: equal-weight the universe, or —
  // on one name — just hold it. Drawn heavier in single mode because there it IS the bar to clear.
  s+=res.single
    ? `<path d="${path(ew)}" fill="none" stroke="var(--text)" stroke-width="1.3" stroke-dasharray="4 3" opacity="0.55"/>`
    : `<path d="${path(ew)}" fill="none" stroke="var(--faint)" stroke-width="1"/>`;
  if(vb) s+=`<path class="bt-vb" d="${path(vb)}" fill="none" stroke="var(--accent-dim)" stroke-width="1.2" stroke-dasharray="4 3"/>`;
  s+=`<path d="${path(bench)}" fill="none" stroke="var(--muted)" stroke-width="1.2"/>`;
  s+=`<path d="${path(gross)}" fill="none" stroke="var(--blue)" stroke-width="1.2" opacity="0.85"/>`;
  s+=`<path d="${path(net)}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
  const endLab=(arr,col)=>`<text x="${(W-pr+4)}" y="${(Y(arr[m-1])+3).toFixed(1)}" style="font-size:9px;fill:${col}">${(arr[m-1]>0?'+':'')+arr[m-1].toFixed(1)}%</text>`;
  s+=endLab(net,'var(--accent)');
  if(res.single){                                                   // position ribbon: WHEN the rule was on, and on which side
    s+=endLab(ew,'var(--text)');
    const y0=H-26, hgt=9, wd=Math.max(1.2,(X(1)-X(0))+0.7);
    for(let i=0;i<res.pos.length&&i<m-1;i++){ const w=res.pos[i];
      s+=`<rect x="${X(i+1).toFixed(1)}" y="${y0}" width="${wd.toFixed(2)}" height="${hgt}" fill="${w>0?'var(--up)':w<0?'var(--down)':'var(--faint)'}" opacity="${w===0?0.3:0.8}"/>`; }
    s+=`<text x="${pl-6}" y="${y0+7}" text-anchor="end" class="lc-tick">pos</text>`;
  }
  // x date labels (start / split / end)
  const dfmt=d=>{ const dt=new Date(d*DAY); return (dt.getUTCMonth()+1)+'/'+dt.getUTCDate(); };
  s+=`<text x="${pl}" y="${H-8}" class="lc-tick">${dfmt(days[0])}</text>`;
  s+=`<text x="${(W-pr).toFixed(1)}" y="${H-8}" text-anchor="end" class="lc-tick">${dfmt(days[m-1])}</text>`;
  const xs=days.map((_,i)=>X(i)), rows=days.map((d,i)=>{
    const tag=(splitIdx>0&&i>=splitIdx)?'<span style="color:var(--muted)">OOS</span>':'<span style="color:var(--muted)">IS</span>';
    return `<b>${dfmt(d)}</b> ${tag}<br>`+
      `<span style="color:var(--accent)">net ${(net[i]>0?'+':'')+net[i].toFixed(2)}%</span> · `+
      `<span style="color:var(--blue)">gross ${(gross[i]>0?'+':'')+gross[i].toFixed(2)}%</span><br>`+
      `<span style="color:var(--muted)">bench ${(bench[i]>0?'+':'')+bench[i].toFixed(2)}%</span> · `+
      (res.single
        ? `<span style="color:var(--text)">hold ${(ew[i]>0?'+':'')+ew[i].toFixed(2)}%</span>`
          +`<br><span class="sec">position </span>`+(()=>{ const w=i>0?res.pos[i-1]:0;
              return w>0?`<span class="pos">LONG ${w.toFixed(2)}\u00d7</span>`:w<0?`<span class="neg">SHORT ${Math.abs(w).toFixed(2)}\u00d7</span>`:`<span class="sec">flat</span>`; })()
        : `<span style="color:var(--faint)">EW ${(ew[i]>0?'+':'')+ew[i].toFixed(2)}%</span>`)+
      (vb?`<br><span style="color:var(--accent-dim)">\u2b12${esc(res.vbName||'')} ${(vb[i]>0?'+':'')+vb[i].toFixed(2)}%</span>`:'');
  });
  return hoverChart(s, { w:W, h:H, pt, pb, xs, rows });
}
function btStatBox(label, st, accent){
  if(!st) return `<div class="s-stat"><div class="s-k">${label}</div><div class="sec">—</div></div>`;
  const f=(x,d,pct)=>(x>0?'+':'')+(x*(pct?100:1)).toFixed(d)+(pct?'%':'');
  return `<div class="s-stat"><div class="s-k">${label} · ${st.n}d</div>`+
    `<div class="s-row"><span>return</span><b class="${st.total>=0?'pos':'neg'}">${f(st.total,1,true)}</b></div>`+
    `<div class="s-row"><span>Sharpe</span><b style="color:${accent}">${st.sharpe.toFixed(2)}</b></div>`+
    `<div class="s-row"><span>hit</span><b>${(st.hit*100).toFixed(0)}%</b></div>`+
    `<div class="s-row"><span>max DD</span><b class="neg">${(st.mdd*100).toFixed(1)}%</b></div></div>`;
}
function btBookPanel(book){
  const b=book||{longs:[],shorts:[]}, MAX=12;
  const col=(title,items,cls,sign)=>{
    const shown=items.slice(0,MAX);
    const list=items.length? shown.map(x=>
        `<div class="bt-pos"><span class="bt-tk">${esc(x.ticker)}</span>`+
        `<span class="bt-sc">${x.score!=null?(x.score>0?'+':'')+(x.score*100).toFixed(1)+'%':'—'}</span>`+
        `<span class="bt-w ${cls}">${sign}${(Math.abs(x.w)*100).toFixed(1)}%</span></div>`).join('')
        +(items.length>MAX?`<div class="sec" style="padding:6px 2px">+${items.length-MAX} more</div>`:'')
      : `<div class="sec" style="padding:8px 2px">— none —</div>`;
    return `<div class="bt-col"><div class="bt-col-h"><span class="${cls}">${title}</span> <span class="sec">${items.length} names</span></div>${list}</div>`;
  };
  return sCard(`<div class="s-cap" style="margin:0 0 9px">Latest rebalance — the actual positions the rule holds now (ticker · signal · weight)</div>`+
    `<div class="bt-book-grid">`+col('LONG',b.longs,'pos','+')+col('SHORT',b.shorts,'neg','−')+`</div>`);
}
// The single-asset stand-in for the long/short book: a book of one row says nothing, but WHEN the
// rule was on, on which side, and what each round trip actually made is the whole story.
function btPositionPanel(res){
  const tk=res.row?(res.row.ticker||res.row.coin):'', w=res.curW||0, MAX=8;
  const tag = w>0 ? `<span class="bt-now pos">LONG ${w.toFixed(2)}×</span>`
            : w<0 ? `<span class="bt-now neg">SHORT ${Math.abs(w).toFixed(2)}×</span>`
                  : `<span class="bt-now flat">FLAT</span>`;
  const d=(x)=>sessDate(x*DAY);
  const list=res.trades.slice(-MAX).reverse();
  const rows=list.length? list.map(t=>
      `<div class="bt-trow"><span class="${t.side==='LONG'?'pos':'neg'}">${t.side}</span>`+
      `<span class="sec">${d(t.entry)}</span><span class="sec">${t.live?'open':d(t.exit)}</span>`+
      `<span class="r sec">${t.size.toFixed(2)}×</span>`+
      `<span class="r ${t.ret>=0?'pos':'neg'}">${(t.ret>0?'+':'')+(t.ret*100).toFixed(2)}%</span></div>`).join('')
    : `<div class="bt-trow"><span class="sec" style="grid-column:1/-1">No position ever cleared the entry threshold — loosen it, shorten the lookback, or pick a longer history.</span></div>`;
  const wins=res.trades.filter(t=>t.ret>0).length;
  return sCard(`<div class="s-cap" style="margin:0 0 9px">Where the rule stands on ${esc(tk)} right now, and every round trip that got it here</div>`+
    `<div class="bt-nowrow">${tag}<span class="sec">score ${res.curScore!=null&&isFinite(res.curScore)?(res.curScore>0?'+':'')+res.curScore.toFixed(3):'—'}`+
      `${res.curZ!=null&&isFinite(res.curZ)?` · ${(res.curZ>0?'+':'')+res.curZ.toFixed(2)}σ`:''} · entry ${state.backtest.entry>0?'±'+state.backtest.entry+'σ':'sign only'}`+
      ` · ${res.trades.length} round trip${res.trades.length===1?'':'s'}${res.trades.length?`, ${Math.round(wins/res.trades.length*100)}% green`:''}</span></div>`+
    `<div class="bt-ttbl"><div class="bt-trow bt-thd"><span>side</span><span>in</span><span>out</span><span class="r">size</span><span class="r">return</span></div>${rows}</div>`+
    (res.trades.length>MAX?`<div class="sec" style="font-size:10.5px;padding:6px 2px 0">+${res.trades.length-MAX} earlier</div>`:''));
}
// ===== target picker — typeahead over the live scope, never a dropdown =========================
// The roster is a few hundred names across two universes; a <select> is unusable at that size. Same
// contract as the COMP/G picker: only names in the live universe resolve, free text never does.
function btPickerHtml(){
  const picks=state.backtest.picks, cr=state.scope==='crypto';
  const chips=picks.map(c=>{ const r=state.rows.get(c), tk=r?(r.ticker||c):c, off=!r||r.delisted||!inScope(r)||!r.daily;
    return `<span class="cg-chip bt-tgt${off?' off':''}" title="${esc(off?tk+' — no daily history in this scope, so it sits out of the run':(tk+' · '+((r&&(r.sector||r.assetClass))||'—')))}">${esc(tk)}<span class="cg-x" data-btx="${esc(c)}" title="remove">×</span></span>`; }).join('');
  return `<span class="lbl">target</span>`+
    `<span class="bt-pick"><input id="btFind" autocomplete="off" spellcheck="false" placeholder="${cr?'search a coin — e.g. BTC, HYPE':'search a name — e.g. NVDA, OPENAI'}" title="type a name from the live ${cr?'crypto':'xyz'} universe to test the rule on it alone; pick several to rank only those"><div id="btSugg" class="cg-sugg" hidden></div></span>`+
    (picks.length?`<span class="bt-chips">${chips}<button class="cg-pill" id="btClearPick" title="back to the whole universe">clear</button></span>`:'');
}
function btSuggest(){
  const inp=el('btFind'), sg=el('btSugg'); if(!inp||!sg) return;
  const q=inp.value.trim().toUpperCase();
  if(!q){ sg.hidden=true; return; }
  const picked=new Set(state.backtest.picks);
  const pool=[...state.rows.values()].filter(r=>!r.delisted&&inScope(r)&&r.daily&&!picked.has(r.coin));
  const key=r=>String(r.ticker||r.coin).toUpperCase();
  const hit=r=>key(r).startsWith(q), soft=r=>key(r).includes(q)||String(r.coin).toUpperCase().includes(q);
  const m=[...pool.filter(hit), ...pool.filter(r=>!hit(r)&&soft(r))].slice(0,7);
  if(!m.length){ sg.innerHTML=`<div class="cg-sg-none">no match in the live ${state.scope==='crypto'?'crypto':'xyz'} universe</div>`; sg.hidden=false; return; }
  sg.innerHTML=m.map((r,i)=>{ const dm=dailyReturns(r), n=dm?dm.size:0, thin=n<BT_MIN_DAYS;
    return `<div class="cg-sg${i===0?' on':''}${thin?' thin':''}" data-btc="${esc(r.coin)}" title="${thin?`only ${n}d of daily history — under the ${BT_MIN_DAYS}d floor this tab needs`:`${n}d of daily history`}">${esc(r.ticker||r.coin)}`+
      `<span class="cg-sg-r">${esc(thin?n+'d · too short':(r.sector||r.assetClass||'—'))}</span></div>`; }).join('');
  sg.hidden=false;
  sg.querySelectorAll('.cg-sg').forEach(x=>x.onclick=()=>btAddPick(x.dataset.btc));
}
function btAddPick(coin){
  const r=coin?state.rows.get(coin):null;
  if(!r||!inScope(r)) return;
  const dm=dailyReturns(r);
  if(!dm||dm.size<BT_MIN_DAYS) return pushToast(`${r.ticker||coin} has under ${BT_MIN_DAYS} days of daily history — not enough to test anything on`);
  if(state.backtest.picks.includes(coin)) return;
  state.backtest.picks.push(coin);
  drawBacktest();
  const ni=el('btFind'); if(ni) ni.focus();
}
function renderBacktest(){
  const p=state.backtest;
  if(featureOn('baskets')&&!BASKETS.list.length) loadBaskets();   // -09: the vs-⬒ select must populate even when Backtest is the first tab visited; loadBaskets redraws this view when the registry lands
  const mode=btMode(), single=mode==='single', picked=btPickRows();
  const res=btRun();
  const head=sHead('Strategy backtest', single
    ? 'test one name on its own — the same signal, run as a timing rule, net of costs'
    : 'define a cross-sectional rule and test it net of costs — in-sample vs out-of-sample');
  // controls
  const opt=(v,l,cur)=>`<option value="${esc(v)}"${cur===v?' selected':''}>${esc(l)}</option>`;
  const seg=(id,cur,opts)=>`<div class="seg" id="${id}">`+opts.map(([v,l])=>`<button data-v="${v}"${String(cur)===String(v)?' class="active"':''}>${l}</button>`).join('')+`</div>`;
  const cr=state.scope==='crypto';
  const sectors=cr?[]:[...new Set([...state.rows.values()].filter(r=>r.assetClass==='Equity'&&r.sector).map(r=>r.sector))].sort();
  let uniSel=`<select id="btUni" class="clocksel">`+opt('all',cr?'All crypto (top-60 by vol)':'All markets',cr?'all':p.universe);
  if(!cr) uniSel+=opt('eq','Equities only',p.universe);
  if(sectors.length) uniSel+=`<optgroup label="By sector">`+sectors.map(sc=>opt('sec:'+sc, sc, p.universe)).join('')+`</optgroup>`;
  uniSel+=`</select>`;
  // -09: optional price-only basket yardstick on the curve. A comparison line, never a component:
  // it enters no stat box, no Sharpe, no verdict — the strategy's numbers are untouched by it.
  const vbSel=featureOn('baskets')
    ? `<span class="lbl">vs <span class="bkg">\u2b12</span></span><select id="btVsB" class="clocksel" title="overlay a basket's price-only EW daily index on the curve \u2014 a yardstick, not a strategy: no costs, no funding, and it never enters the stats">`
      +opt('','off',p.vsBasket)+basketScopeList().map(b=>opt(b.name,'\u2b12 '+b.name,p.vsBasket)).join('')+`</select>`
    : '';
  let sigSel=`<select id="btSig" class="clocksel">`+Object.keys(BT_SIGNALS).map(k=>opt(k,BT_SIGNALS[k],p.signal)).join('')+`</select>`;
  // A control that has nothing left to act on is DIMMED with the reason on hover, never hidden and
  // never silently ignored: the point of the picker is that you can see what your choice cost you.
  const grp=(off,why)=>` class="bt-grp${off?' bt-na':''}"${off?` title="${esc(why)}"`:''}`;
  const uniWrap=grp(picked.length, single
      ? 'superseded by the picked name — on one name, the name IS the universe'
      : `superseded by the ${picked.length} picked names`);
  const modeBar = single
    ? `<div class="bt-mode"><b>Single-asset mode</b> · <span class="bt-mname">${esc(res.row?(res.row.ticker||res.row.coin):(picked[0].ticker||picked[0].coin))}</span> `+
      `<span class="sec">${esc((picked[0].sector||picked[0].assetClass||'—'))}</span> — the rank collapses into a timing rule on one name: the score's own sign, `+
      `measured against the <b>entry</b> threshold, is the position. Dimmed controls have no cross-section left to act on.</div>`
    : mode==='set'
      ? `<div class="bt-mode"><b>Custom universe</b> · ${picked.length} names — cross-sectional as usual, ranked only among what you picked. `+
        `<span class="sec">Thin book: at ${(p.quantile*100).toFixed(0)}% that's ${Math.max(1,Math.floor(picked.length*p.quantile))} name per side, so treat the stats as a sketch. Remove all but one to run a single-asset timing test instead.</span></div>`
      : '';
  const controls=
    `<div class="s-ctrls">${btPickerHtml()}</div>`+
    `<div class="s-ctrls"><span class="lbl">signal</span>${sigSel}<span${uniWrap}><span class="lbl">universe</span>${uniSel}</span>${vbSel}`+
    (cr?'':`<span class="lbl">hold</span>${seg('btHold',p.holdWindow,[['cc','close→close'],['on','overnight']])}`)+`</div>`+   // crypto is 24/7 — no overnight boundary to hold across
    modeBar+
    `<div class="s-ctrls"><span class="lbl">lookback</span>${seg('btLb',p.lookback,[[5,'5d'],[10,'10d'],[20,'20d'],[40,'40d'],[60,'60d'],[120,'120d']])}`+
    (BT_MVAR[p.signal]?`<span class="sec" style="align-self:center">n/a — this rule runs fixed 1/7/30d horizons</span>`:'')+
    `<span class="lbl">rebalance</span>${seg('btCad',p.cadence,[[1,'1d'],[5,'5d'],[10,'10d']])}`+
    (single
      ? `<span class="lbl" title="how far from zero the score must sit before a position is taken — the single-name replacement for the book quantile. σ is that name's own trailing score scale (RMS about zero), measured through that day only.">entry</span>${seg('btEntry',p.entry,[[0,'sign only'],[0.5,'±0.5σ'],[1,'±1σ']])}`
      : `<span class="lbl">book</span>${seg('btQ',p.quantile,[[0.1,'10%'],[0.2,'20%'],[0.33,'33%'],[1,'all']])}`)+
    `<span class="lbl">taker bps</span>${seg('btCost',p.cost,[[0,'0'],[5,'5'],[10,'10'],[20,'20']])}`+
    `<span class="lbl">in-sample</span>${seg('btSplit',p.split,[[0.5,'50%'],[0.6,'60%'],[0.7,'70%']])}</div>`+
    `<div class="s-ctrls"><span class="lbl">direction</span>${seg('btDir',p.direction,[['high','long strong'],['low','long weak']])}`+
    `<span class="lbl">structure</span>${single
      ? seg('btStruct',p.structure,[['ls','long / short'],['long','long or flat'],['short','short or flat']])
      : seg('btStruct',p.structure,[['ls','long / short'],['long','long-only'],['short','short-only']])}`+
    (single
      ? `<span class="lbl" title="one position, so weighting is position sizing: flat 1×, scaled by the score's own conviction, or sized to a ${(BT_VOLTGT*100).toFixed(0)}% annualized vol target">sizing</span>${seg('btWt',p.weighting,[['eq','flat 1×'],['sig','by |score|'],['vol','vol-target']])}`
      : `<span class="lbl">weighting</span>${seg('btWt',p.weighting,[['eq','equal'],['sig','by signal'],['vol','inverse-vol']])}`)+
    (single
      ? `<span${grp(true,'there is no rank left to disagree with — on one name the sign of the score IS the position, and the entry threshold is what gates it')}><span class="lbl">gate</span>${seg('btReq',p.reqSign?'sign':'any',[['any','any rank'],['sign','signal must agree']])}</span>`
      : `<span class="lbl">gate</span>${seg('btReq',p.reqSign?'sign':'any',[['any','any rank'],['sign','signal must agree']])}`)+
    `</div>`;
  if(!res.ok){
    const msg=res.nodata
      ? `${esc(res.nodata)} ranks on a data column this server isn't shipping yet (daily highs/volume, OI, or funding). Redeploy the backend, then it fills in on the next /api/daily load.`
      : res.nopeers
      ? `Sector-relative momentum is a demean against peers, and ${esc(res.nopeers)} has only ${res.have} other name${res.have===1?'':'s'} with daily history in this scope — under three there is no sector mean worth subtracting, and running it anyway would be plain momentum wearing the wrong label. Pick plain <b>Momentum</b>, or a name from a fuller sector.`
      : single
        ? `Not enough daily history on ${esc(picked.length?(picked[0].ticker||picked[0].coin):'this name')} yet — ${res.days||0} aligned days, need more than the ${p.lookback}d lookback plus a few rebalances. Pick a shorter lookback, or a name with a longer history.`
        : `Not enough daily history yet — ${res.have||0} names, need ${res.need||8} with ≥${BT_MIN_DAYS}d (and more days than the lookback). ${mode==='set'?'Pick more names, or remove all but one to run a single-asset timing test instead.':'Fills in as /api/daily loads, or pick a shorter lookback.'}`;
    return head+controls+sCard(`<div class="msg" style="height:150px;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 30px">${msg}</div>`)+renderDuelSection();
  }
  // -09 basket yardstick: the picked basket's EW daily index compounded over the SAME curve days,
  // rebased with the strategy. dailyReturns on the shared virtual row — the exact series COMP/G
  // and the matrix consume, so all four surfaces agree about what the basket did. Days the basket
  // gapped (sub-floor coverage) compound flat, same convention as the benchmark's missing days.
  if(featureOn('baskets')&&p.vsBasket){
    const vbDef=basketScopeList().find(x=>x.name===p.vsBasket);
    const vbRow=vbDef?basketVirtualRow(vbDef):null, vbm=vbRow?dailyReturns(vbRow):null;
    if(vbm){ const eqvb=[1];
      for(let i=1;i<res.days.length;i++){ const v=vbm.get(res.days[i]); eqvb.push(eqvb[eqvb.length-1]*((v!=null&&isFinite(v))?Math.exp(v):1)); }
      res.eqvb=eqvb; res.vbName=vbRow.ticker; } }
  const m=res.days.length, splitIdx=Math.max(1,Math.min(m-2,Math.floor(m*p.split)));
  const isR=res.portR.slice(0,splitIdx), oosR=res.portR.slice(splitIdx);
  const isE=res.eq.slice(0,splitIdx+1), oosE=res.eq.slice(splitIdx);
  const ann=btAnn();
  const full=btStats(res.portR,res.eq,ann), is=btStats(isR,isE,ann), oos=btStats(oosR,oosE,ann);
  const fundRow=`<div class="s-row"><span>funding</span>${res.fundCov>0?`<b class="${res.fundCum>=0?'pos':'neg'}">${(res.fundCum>0?'+':'')+(res.fundCum*100).toFixed(1)}%</b>`:`<b class="sec" title="funding not loaded — update the server">—</b>`}</div>`;
  const feeRow=`<div class="s-row"><span>fees</span><b class="neg">−${(res.feeCum*100).toFixed(1)}%</b></div>`;
  // Single-asset mode replaces the universe/turnover box with the two numbers that actually decide
  // whether a one-name rule was worth running: what it made against simply holding the thing, and
  // how many independent decisions that verdict rests on.
  const thin=res.single&&res.trades.length<BT_TRADE_MIN;
  const holdTot=res.single? res.eqbh[res.eqbh.length-1]/res.eqbh[0]-1 : 0;
  const stratTot=res.single? res.eq[res.eq.length-1]/res.eq[0]-1 : 0;
  const wins=res.single? res.trades.filter(t=>t.ret>0).length : 0;
  const pn=(x,d)=>(x>0?'+':'')+(x*100).toFixed(d==null?1:d)+'%';
  const extraBox=res.single
    ? `<div class="s-stat"><div class="s-k">vs buy &amp; hold ${esc(res.row.ticker||res.row.coin)}</div>`+
        `<div class="s-row"><span>strategy</span><b class="${stratTot>=0?'pos':'neg'}">${pn(stratTot)}</b></div>`+
        `<div class="s-row"><span>buy &amp; hold</span><b class="${holdTot>=0?'pos':'neg'}">${pn(holdTot)}</b></div>`+
        `<div class="s-row"><span>excess</span><b class="${stratTot-holdTot>=0?'pos':'neg'}">${pn(stratTot-holdTot)}</b></div>`+
        `<div class="s-row"><span title="share of days the rule held any position at all">exposure</span><b>${(res.exposure*100).toFixed(0)}%</b></div></div>`+
      `<div class="s-stat"><div class="s-k">Trades &amp; frictions</div>`+
        `<div class="s-row"><span>round trips</span><b class="${thin?'neg':''}"${thin?` title="under ${BT_TRADE_MIN} round trips the Sharpe above is an anecdote with a decimal point — it is shown, not trusted"`:''}>${res.trades.length}${thin?' ⚠':''}</b></div>`+
        `<div class="s-row"><span>win rate</span><b>${res.trades.length?Math.round(wins/res.trades.length*100)+'%':'—'}</b></div>`+
        fundRow+feeRow+`</div>`
    : `<div class="s-stat"><div class="s-k">Frictions</div>`+
        `<div class="s-row"><span>universe</span><b>${res.universeN}</b></div>`+
        `<div class="s-row"><span>turnover</span><b>${(res.turnover*100).toFixed(0)}%</b></div>`+
        fundRow+feeRow+`</div>`;
  const stats=`<div class="s-grid" style="margin:12px 0 4px">`+
    btStatBox('In-sample',is,'var(--blue)')+btStatBox('Out-of-sample',oos,'var(--accent)')+
    (res.single?'':btStatBox('Full period',full,'var(--text)'))+extraBox+`</div>`;
  const legItems=[{color:'var(--accent)',label:'net'},{color:'var(--blue)',label:'gross'},{color:'var(--muted)',label:cr?'benchmark (BTC)':'benchmark (SP500)'},
    res.single?{color:'var(--text)',label:'buy &amp; hold '+esc(res.row.ticker||res.row.coin)+' (dashed)'}:{color:'var(--faint)',label:'equal-weight'}];
  if(res.single) legItems.push({color:'var(--up)',label:'position: long'},{color:'var(--faint)',label:'flat'},{color:'var(--down)',label:'short'});
  if(res.eqvb) legItems.push({color:'var(--accent-dim)',label:'\u2b12 '+res.vbName+' (price-only EW)'});
  const leg=sLeg(legItems);
  const pctq=(p.quantile*100).toFixed(0), dirTop=p.direction==='high'?'top':'bottom';
  const structTxt = p.structure==='long' ? `<b>long-only</b>, holding the ${dirTop} ${pctq}%`
    : p.structure==='short' ? `<b>short-only</b>, shorting the ${p.direction==='high'?'bottom':'top'} ${pctq}%`
    : `<b>long/short</b> — long the ${dirTop} ${pctq}%, short the other tail, dollar-neutral`;
  const wtTxt = p.weighting==='sig'?'signal-weighted':p.weighting==='vol'?'inverse-vol weighted':'equal-weight';
  const mvarCol={moi:'OI',mfund:'funding',mpart:'volume'}[p.signal];
  const mvarNote = BT_MVAR[p.signal]
    ? ` <b>Live-score variant:</b> fixed 1/7/30d risk-adjusted horizons mirroring the Markets-tab momentum blend — the lookback control does not apply. Judge it against <i>Blend M0 — live-score analogue</i> on out-of-sample net: only a term that beats the control there earns promotion into the live column. Daily granularity can only mirror the ≥1d structure of the live score (weights renormalized to .40/.40/.20; the intraday terms carry over untested either way), and the range tilt runs on closes — the daily tuple ships no low${mvarCol?`. Names missing the ${mvarCol} column fall back to the unmodulated core, so the ranked universe matches the control and the OOS gap measures the term itself`:''}.`
    : '';
  // ---- single-asset caption: what the rule did, and the two things that make a one-name result
  // easier to fool yourself with than a cross-sectional one (no diversification, few decisions).
  const oneTk=res.single?esc(res.row.ticker||res.row.coin):'';
  const entryTxt=p.entry>0?`whenever it clears ±${p.entry}σ of that name's own trailing score scale`:`whenever it is non-zero`;
  const sizeTxt=p.weighting==='sig'?`sized by the score's own conviction (|score| ÷ σ, capped at 0.25–2×)`
    :p.weighting==='vol'?`sized to a ${(BT_VOLTGT*100).toFixed(0)}% annualized vol target (capped at 0.25–2×)`:`at a flat 1×`;
  const sideTxt=p.structure==='long'?`<b>long or flat</b> — long when the score points ${p.direction==='high'?'up':'down'}, flat otherwise`
    :p.structure==='short'?`<b>short or flat</b>`
    :`<b>long/short</b> — the position flips with the score's sign`;
  const capOne=!res.single?'':`Every ${p.cadence}d, score <b>${oneTk}</b> by ${BT_SIGNALS[p.signal].toLowerCase()} over the trailing ${p.lookback}d and take the position ${entryTxt}: ${sideTxt}, ${sizeTxt}. `+
    `Net of the ${p.cost}bp taker fee on every flip and the funding the position pays or earns while held${res.fundCov>0?'':' — funding not loaded for this name yet, so this is price-only until the server ships it'}. `+
    `The dashed line is <b>buy &amp; hold ${oneTk}</b>, the only benchmark a one-name rule has to beat; the ribbon under the curve is when it was actually on (green long, red short, grey flat). `+
    (p.signal==='smom'?`Sector-relative momentum is demeaned against ${res.peers} live peers in the same sector, so the rule keeps its meaning on one name${res.peers<3?' — under three peers there is no sector mean and the run stays flat':''}. `:'')+
    `<b>One name is one bet:</b> there is no cross-sectional diversification here, and this run rests on ${res.trades.length} round trip${res.trades.length===1?'':'s'}`+
    `${res.trades.length<BT_TRADE_MIN?` — under ${BT_TRADE_MIN}, so read the Sharpe as an anecdote and the out-of-sample half as the only honest part`:''}. `+
    `Shaded region is out-of-sample. Slippage not modeled.${mvarNote} <b>Hover</b> the curve. Not a live trade signal.`;
  const cap = res.single ? capOne : res.on
    ? `<b>Overnight hold.</b> Each night buy the book at the 16:00 ET close and sell at the next 09:30 ET open (Fri→Mon over the weekend), flat during the cash session — ${structTxt}${mode==='set'?` of the ${picked.length} picked names`:''}, ${wtTxt}. The book round-trips every night, so it pays the ${p.cost}bp taker fee twice a night (that's the big drag here), plus the funding accrued over each hold. Gross is price-only; the gross↔net gap is fees + funding. Uses the close→open boundary holds from the hourly spine${res.ovCov>0?'':' — not loaded yet, so this is empty until the server ships them'}. Shaded = out-of-sample. Slippage not modeled.${mvarNote} <b>Hover</b> the curve. Not a live trade signal.`
    : `Each rebalance, rank ${mode==='set'?`the ${picked.length} picked names`:'the universe'} by ${BT_SIGNALS[p.signal].toLowerCase()} and go ${structTxt}, ${wtTxt}, held to the next rebalance. Net of a ${p.cost}bp market-order taker fee on turnover and the actual funding each position pays or earns while held${res.fundCov>0?'':' — funding not loaded yet, so this is price-only until the server ships it'}. Gross line is price-only; the gross↔net gap is your funding + fee drag. Shaded region is out-of-sample. In-sample-selected, slippage not yet modeled — the test runs on exactly the daily history this server ships${cr?' (crypto: ~90d, BTC benchmark, 365d annualization)':''}.${mvarNote}${mode==='set'?` <b>Custom universe:</b> ranks run only among the ${picked.length} names you picked, so the tails are ${Math.max(1,Math.floor(picked.length*p.quantile))} name per side — a sketch, not a cross-section.`:''} <b>Hover</b> the curve. Not a live trade signal.`;
  const vbCap=res.eqvb?` The dashed <b>\u2b12 ${esc(res.vbName)}</b> line is that basket's price-only EW daily index over the same days \u2014 no costs, no funding, a comparison yardstick that never enters the stats; basket gap days (sub-floor coverage) compound flat.`:'';
  return head+controls+stats+(res.single?btPositionPanel(res):btBookPanel(res.book))+leg+sCard(btCurveSvg(res,splitIdx))+sCap(cap+vbCap)+renderDuelSection();
}
// ===== Score duel — MOM vs MOM+ on daily forward rank IC (build 2026.07.24-07) =====
// The adjudicator for the candidate column. Server-computed record (/api/duel): once per UTC
// day the poller snapshots both scores per name and, when the next day's prices land, computes
// per-scope Spearman rank IC of each score against the realized next-day return. This panel
// renders that record — it never recomputes it — plus a LIVE divergence list built from the
// same rows the board renders (one code path: the Δ names here are exactly the Δ cells there).
const DUEL_ROLL=7, DUEL_REFRESH_MS=60000;
function duelRoll(a){ const o=[]; for(let i=0;i<a.length;i++){ let s2=0,n2=0;
  for(let j=Math.max(0,i-(DUEL_ROLL-1));j<=i;j++){ s2+=a[j]; n2++; } o.push(s2/n2); } return o; }
async function loadDuelData(){
  const d=state.duel;
  if(d.pending||(d.at&&Date.now()-d.at<DUEL_REFRESH_MS)) return;
  d.pending=true;
  // The attempt is stamped whatever happened: drawBacktest calls back in here, so a failed pull
  // with no stamp was an immediate refetch and a full re-render, in a loop, for as long as the
  // server kept failing. Redraw only when something new arrived.
  let got=false;
  try{ d.data=await fetchJSON('/api/duel'); got=true; }
  catch(_){ }
  d.at=Date.now(); d.pending=false;
  if(got&&state.view==='backtest') drawBacktest();
}
function duelSvg(ic){
  const W=520,H=150, pl=54,pr=16,pt=12,pb=22;
  if(!ic||ic.length<2) return `<div class="msg" style="height:110px;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 30px">Accruing — the record starts at the first full UTC day after deploy and needs 2 resolved days before a line can draw. ${ic&&ic.length?ic.length+' day so far.':'Day 0.'}</div>`;
  const n=ic.length, ra=duelRoll(ic.map(r2=>r2[1])), rb=duelRoll(ic.map(r2=>r2[2]));
  let lo=Math.min(0,...ra,...rb), hi=Math.max(0,...ra,...rb);
  if(hi===lo){ hi+=0.01; lo-=0.01; } const padd=(hi-lo)*0.1; hi+=padd; lo-=padd;
  const X=i=> pl+(n<=1?0:i/(n-1))*(W-pl-pr);
  const Y=v=> pt+(1-(v-lo)/(hi-lo))*(H-pt-pb);
  let s2=lcGrid(pl,W-pr,lcTicks(lo,hi,4),Y,v=>v.toFixed(2));
  s2+=`<line x1="${pl}" y1="${Y(0).toFixed(1)}" x2="${W-pr}" y2="${Y(0).toFixed(1)}" stroke="var(--faint)" stroke-width="1"/>`;
  const path=a=>a.map((v,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)).join(' ');
  s2+=`<path d="${path(ra)}" fill="none" stroke="var(--muted)" stroke-width="1.7"/>`;
  s2+=`<path d="${path(rb)}" fill="none" stroke="var(--accent)" stroke-width="1.7" stroke-dasharray="5 3"/>`;
  s2+=`<circle cx="${X(n-1).toFixed(1)}" cy="${Y(ra[n-1]).toFixed(1)}" r="2.6" fill="var(--muted)"/>`;
  s2+=`<circle cx="${X(n-1).toFixed(1)}" cy="${Y(rb[n-1]).toFixed(1)}" r="2.6" fill="var(--accent)"/>`;
  s2+=`<text x="${pl}" y="${H-6}" class="lc-tick">${sessDate(ic[0][0]*DAY)}</text>`;
  s2+=`<text x="${(W-pr).toFixed(1)}" y="${H-6}" text-anchor="end" class="lc-tick">${sessDate(ic[n-1][0]*DAY)}</text>`;
  const xs=ic.map((_,i)=>X(i));
  const rows=ic.map((r2,i)=>`<b style="color:var(--text)">${sessDate(r2[0]*DAY)}</b> <span class="sec">· ${r2[3]} names</span><br>`+
    `<span style="color:var(--muted)">MOM ${ra[i].toFixed(3)}</span> · <span style="color:var(--accent)">MOM+ ${rb[i].toFixed(3)}</span>`+
    ` · Δ <span class="${rb[i]-ra[i]>=0?'pos':'neg'}">${(rb[i]-ra[i]>=0?'+':'')+(rb[i]-ra[i]).toFixed(3)}</span>`+
    `<br><span class="sec" style="font-size:10px">raw day: MOM ${r2[1].toFixed(3)} · MOM+ ${r2[2].toFixed(3)}</span>`);
  return hoverChart(s2,{w:W,h:H,pt,pb,xs,rows});
}
function duelDivergence(){
  const rows2=activeRows().filter(r2=>!r2.delisted&&r2.mom!=null&&r2.momp!=null&&isFinite(r2.mom)&&isFinite(r2.momp)&&Math.abs(r2.momp-r2.mom)>=1)
    .sort((a,b)=>Math.abs(b.momp-b.mom)-Math.abs(a.momp-a.mom)).slice(0,5);
  if(!rows2.length) return `<div class="s-cap" style="margin-top:6px">No live disagreements ≥1pt right now — on names without an OI build, a covering flow, or a funding extreme, the two scores are identical by construction.</div>`;
  const tr=rows2.map(r2=>{ const dv=r2.momp-r2.mom;
    return `<div class="duel-row"><span class="duel-tk">${esc(r2.ticker)}</span>`+
      `<span style="color:${momColor(r2.mom)}">${r2.mom>0?'+':''}${Math.round(r2.mom)}</span>`+
      `<span style="color:${momColor(r2.momp)}">${r2.momp>0?'+':''}${Math.round(r2.momp)}</span>`+
      `<span class="${dv>=0?'pos':'neg'}">${dv>=0?'+':''}${Math.round(dv)}</span>`+
      `<span class="sec duel-why">${esc(r2.momWhy||'')}</span></div>`; }).join('');
  return `<div class="s-cap" style="margin:10px 0 4px">Live disagreements — the spot-check that MOM+ diverges for the right reasons (${state.tf} window, same rows as the board):</div>`+
    `<div class="duel-tbl"><div class="duel-row duel-hd"><span>name</span><span>MOM</span><span>MOM+</span><span>Δ</span><span>why</span></div>${tr}</div>`;
}
function renderDuelSection(){
  const head=sHead('Score duel — MOM vs MOM+','the candidate momentum column, adjudicated on daily forward rank IC — not by eye');
  const d=state.duel.data;
  const uKey=state.scope==='crypto'?'main':'xyz';
  if(!d||!d.scopes||!d.scopes[uKey]) return head+sCard(`<div class="msg" style="height:110px;display:flex;align-items:center;justify-content:center">${state.duel.pending?'Loading the duel record…':'Duel record not served yet — redeploy the backend, the panel fills in on the next load.'}</div>`)+duelDivergence();
  const sc=d.scopes[uKey], st=sc.stats||{}, ic=sc.ic||[];
  const fmtIC=v=>(v==null||!isFinite(v))?'—':(v>=0?'+':'')+v.toFixed(3);
  const stats=`<div class="s-grid" style="margin:12px 0 4px">`+
    `<div class="s-stat"><div class="s-k" style="color:var(--muted)">MOM (incumbent)</div><div class="s-row"><span>mean IC</span><b>${fmtIC(st.meanA)}</b></div><div class="s-row"><span>days</span><b>${st.n||0}</b></div></div>`+
    `<div class="s-stat"><div class="s-k" style="color:var(--accent)">MOM+ (candidate)</div><div class="s-row"><span>mean IC</span><b>${fmtIC(st.meanB)}</b></div><div class="s-row"><span>better days</span><b>${st.winB!=null?Math.round(st.winB*100)+'%':'—'}</b></div></div>`+
    `<div class="s-stat"><div class="s-k">Verdict gate</div><div class="s-row"><span>t on ΔIC</span><b>${st.t!=null&&isFinite(st.t)?st.t.toFixed(2):'—'}</b></div><div class="s-row"><span>unlocks</span><b>${d.minN}d or |t|≥2</b></div></div></div>`;
  let verdict;
  if(!st.n) verdict=`<div class="duel-verdict">Day 0 — the record starts accruing at the first full UTC day after deploy. Both columns are live on the board now; this panel is what decides between them.</div>`;
  else if(!st.verdict) verdict=`<div class="duel-verdict">${st.meanB>st.meanA?'MOM+ leads':st.meanB<st.meanA?'The incumbent leads':'Dead even'} on mean rank IC after ${st.n} day${st.n===1?'':'s'} — <b>no verdict yet</b>. The gate refuses to call a winner before ${d.minN} days or |t| ≥ 2 on the daily IC difference; anything earlier is eyeball-fitting with extra steps.</div>`;
  else verdict=`<div class="duel-verdict on"><b>Verdict unlocked</b> after ${st.n} days (t ${st.t!=null?st.t.toFixed(2):'—'}): ${st.meanB>st.meanA?'<b>MOM+ wins</b> — say the word and it gets promoted into the incumbent (and the loser deleted, per the bench rule).':st.meanB<st.meanA?'<b>the incumbent holds</b> — MOM+ gets deleted, not left as clutter.':'a statistical tie — the incumbent holds by default.'}</div>`;
  const leg=sLeg([{color:'var(--muted)',label:'MOM (incumbent, 7d roll)'},{color:'var(--accent)',label:'MOM+ (candidate, 7d roll)'}]);
  const cap=`Each point: Spearman rank correlation between that day's 00:00 UTC score snapshot and the realized next-day return across the ${state.scope==='crypto'?'crypto':'xyz'} universe — "did this column's ordering predict tomorrow." Lines are ${DUEL_ROLL}d rolling means (raw daily IC is noise to the eye; the stats and the t-test run on the raw days). Canonical d1 basis, window-independent — the board columns follow the timeframe selector, this record does not. Snapshots persist to the volume, so the record survives redeploys. <b>Hover</b> the curve.`;
  return head+stats+verdict+leg+sCard(duelSvg(ic))+sCap(cap)+duelDivergence();
}
function attachBtControls(){
  const sig=el('btSig'); if(sig) sig.addEventListener('change',()=>{ state.backtest.signal=sig.value; drawBacktest(); });
  const uni=el('btUni'); if(uni) uni.addEventListener('change',()=>{ state.backtest.universe=uni.value; drawBacktest(); });
  const vbs=el('btVsB'); if(vbs) vbs.addEventListener('change',()=>{ state.backtest.vsBasket=vbs.value; drawBacktest(); });
  const segWire=(id,key,num)=>{ const g=el(id); if(!g) return; g.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{ state.backtest[key]=num?parseFloat(b.dataset.v):b.dataset.v; drawBacktest(); })); };
  segWire('btLb','lookback',true); segWire('btCad','cadence',true); segWire('btQ','quantile',true); segWire('btCost','cost',true); segWire('btSplit','split',true);
  segWire('btDir','direction',false); segWire('btStruct','structure',false); segWire('btWt','weighting',false); segWire('btHold','holdWindow',false);
  const rq=el('btReq'); if(rq) rq.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{ state.backtest.reqSign=(b.dataset.v==='sign'); drawBacktest(); }));
  segWire('btEntry','entry',true);
  // target picker: type to search the live scope, ⏎ takes the first match, ⌫ on an empty box pops
  // the last chip. Same keyboard contract as the COMP/G picker so the two never behave differently.
  const fi=el('btFind');
  if(fi){
    fi.addEventListener('input',btSuggest);
    fi.addEventListener('keydown',e=>{
      const sg=el('btSugg');
      if(e.key==='Escape'){ if(sg) sg.hidden=true; return; }
      if(e.key==='Backspace'&&!fi.value&&state.backtest.picks.length){ state.backtest.picks.pop(); drawBacktest(); const n=el('btFind'); if(n) n.focus(); return; }
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){
        if(!sg||sg.hidden) return; e.preventDefault();
        const opts=[...sg.querySelectorAll('.cg-sg')]; if(!opts.length) return;
        let i=opts.findIndex(x=>x.classList.contains('on')); i=(i+(e.key==='ArrowDown'?1:opts.length-1)+opts.length)%opts.length;
        opts.forEach((x,k)=>x.classList.toggle('on',k===i)); return; }
      if(e.key==='Enter'){ e.preventDefault();
        const on=sg&&!sg.hidden?sg.querySelector('.cg-sg.on'):null;
        if(on) btAddPick(on.dataset.btc); }
    });
    fi.addEventListener('blur',()=>setTimeout(()=>{ const sg=el('btSugg'); if(sg) sg.hidden=true; },140));   // let a click on a suggestion land first
  }
  document.querySelectorAll('#backtest-body [data-btx]').forEach(x=>x.addEventListener('click',()=>{
    state.backtest.picks=state.backtest.picks.filter(c=>c!==x.dataset.btx); drawBacktest(); }));
  const cp=el('btClearPick'); if(cp) cp.addEventListener('click',()=>{ state.backtest.picks=[]; drawBacktest(); });
}
function drawBacktest(){ const host=el('backtest-body'); if(!host) return; host.innerHTML=renderBacktest(); attachBtControls(); attachLineHover(); loadDuelData(); }
async function renderBacktest_load(){ drawBacktest(); if(![...state.rows.values()].some(r=>r.daily)){ await loadDaily(); if(state.view==='backtest') drawBacktest(); } }

function updateBenchNote(){ const bn=el('benchnote'); if(!bn) return;
  const bc=scopeBench(); bn.textContent=(bc&&state.rows.get(bc))?state.rows.get(bc).ticker:(state.rows.size?'not found':'\u2014'); }
function setScope(v){
  if(v!=='stocks'&&v!=='crypto') return;
  if(state.scope===v) return;
  state.scope=v;
  try{ localStorage.setItem('xyz-scope',v); }catch(_){}
  applyScope();
}
function applyScope(){
  const cr=state.scope==='crypto';
  // Trend and Report stay visible in crypto scope (the only tabs besides Markets that do) —
  // Trend follows the scope switcher like the Markets table; Report is universe-tagged per
  // ticker, so the same tab serves both universes regardless of scope. Signals left this
  // list at -101: the crypto side of the signal engine was removed, so the tab has nothing
  // true to show in crypto scope.
  applyTabVisibility();   // scope AND flags, composed in one place — this loop used to duplicate the scope half and drift from showView's copy
  document.querySelectorAll('[data-scope]').forEach(b=>b.classList.toggle('on', b.dataset.scope===state.scope));

  if(!tabVisible(state.view)) { showView('markets'); }   // a scope flip OR a flag change can strand the active view
  // -06: flipping the pill to a universe the ACTIVE scoped tab cannot show is a navigation, not a
  // dead click — honour the chosen universe and land on Markets there. The -04 pill-hiding is gone:
  // both pills stay mounted everywhere; entry into a scoped tab from the hidden side still
  // auto-flips (scopeGuard in the renderers), only the mid-tab flip routes away.
  else if((state.view==='signals'||state.view==='actionable') && !featureOn(state.view+'.'+(state.scope==='crypto'?'cx':'eq'))) showView('markets');
  if(typeof syncCorrLookback==='function') syncCorrLookback();   // swap the lookback segment for the active universe
  // The industry layer is equities-only (crypto's sectors ARE its fine grouping) — the toggle
  // hides in crypto scope rather than sitting there as a no-op. sectGrpActive() already treats
  // crypto scope as 'sector', so the grouping key and the visible control can never disagree.
  const gseg=el('sectgrp'); if(gseg) gseg.hidden=cr;
  if(state.grpDrill){ state.grpDrill=null; updateDrillChip(); }   // a drill pins ONE universe's coins — carried across the flip it would filter the new universe to an empty board under a stale chip
  syncGrpSeg();   // markets group lens: hide the industries button on crypto (coerced to sectors), relabel names 'stocks'/'coins'
  if(state.view==='corr' && !el('view-corr').hidden){ state.corr.pair=null; state.corr.selected=null; renderCorr(); setTimeout(compgAuto,60); }   // repaint the matrix for the new universe/data source, then auto-open COMP/G for it
  if(state.view==='trend') renderTrend();   // scope flip repaints the board for the new universe
  state.backtest.picks=[];   // a backtest target belongs to one universe: xyz names don't exist in the crypto scope and vice versa
  if(state.view==='backtest') drawBacktest();   // scope flip re-runs the test on the new universe + benchmark
  if(state.view==='sessions'){ syncAnalyticsSlot(); drawSessions(); loadAnalytics(); }   // -17: repaint sessions for the new universe (its own analytics payload)
  if(state.view==='funding'){ syncFundingSlot(); renderFunding(); loadFunding(); }   // same contract: repaint from this universe's slot, then refresh it
  if(state.view==='signals') renderSignals();       // scope flip re-filters the cards to the new universe
  if(state.view==='actionable') renderActionable();  // ...and the actionable board with them
  setSigTabBadge();   // the badge is scoped too — a flip must restamp it immediately
  buildHead(); render(); updateAggregates(); updateMovers(); updateBenchNote();
  renderRegimeStrip();   // stocks: correlation regime; crypto: the crypto tape strip
}
// The strip scrolls on phones with its scrollbar hidden: a right-edge fade says so, and the active
// tab is kept in view. Re-checked whenever the ribbon or the viewport changes shape.
function syncTabScroll(){ const nav=document.querySelector('nav.tabs'); if(!nav) return;
  nav.classList.toggle('can-scroll', nav.scrollWidth>nav.clientWidth+4);
  const at=nav.querySelector('.tab.active'); if(at&&at.scrollIntoView) try{ at.scrollIntoView({block:'nearest',inline:'nearest'}); }catch(_){} }

export function __boot_backtest_6465() {
window.addEventListener('resize',()=>syncTabScroll());
window.addEventListener('load',()=>setTimeout(syncTabScroll,50));
}

// ← goes back to the last tab you were on, ⌂ to Markets — the same home every fallback lands on.
// Both read live state: Back is dead until there is somewhere to go back to (and while that tab
// is hidden by scope or a flag), Home is dead while you are already there.
function syncTabNav(){
  const p=state.prevView, ok=!!p&&p!==state.view&&tabVisible(p)&&!!el('view-'+p);
  const b=el('backBtn'); if(b){ b.disabled=!ok;
    const tb=ok?document.querySelector('.tab[data-view="'+p+'"]'):null;
    const lbl=tb?tb.textContent.trim().replace(/\s*\d+\s*$/,''):(p||'');
    b.title=ok?('Back to '+lbl+' — the tab you were on before this one (b)'):'Back — return to the tab you were on before this one (b)'; }
  const h=el('homeBtn'); if(h) h.disabled=state.view==='markets';
}
function showView(v){
  try{ document.body.dataset.view=v; }catch(_){}
  // Falls through to Markets when the target is out of scope OR gated. markets is PINNED public in
  // the manifest precisely so this fallback can never itself be gated — otherwise a public user
  // could be bounced into a view they cannot see and end up with no rendered tab at all.
  if(!tabVisible(v)){
    // Say so instead of silently substituting the home tab: a hidden view reached from a link or
    // the dock used to just... show Markets.
    const tb=document.querySelector('.tab[data-view="'+v+'"]'); const lbl=tb?tb.textContent.trim().replace(/\s*\d+\s*$/,''):v;
    if(v!=='markets'&&tb) pushToast(lbl+' is not available in '+(state.scope==='crypto'?'Crypto':'this')+' scope');
    v='markets'; }
  { const hm=el('helpmodal'); if(hm&&!hm.hidden) closeHelp(); }   // help is per-tab — never leave a stale explainer open across a switch
  // The drawer (and anything stacked over it) belongs to the tab it was opened on: it used to
  // survive a switch and sit over the Report tab. openDetail never calls showView, so a
  // "switch then open" sequence (palette, focus chip) still lands with the drawer open.
  const from=state.view;
  const switching=v!==state.view;
  state.view=v;
  if(switching) overlayCloseAll();
  // Where the ← button returns to: the tab you were actually on. A fallback bounce (a view whose
  // section is missing from this build) sets state.view before landing here again, so a view
  // with no section was never a place you were and must not become the Back target.
  if(switching&&el('view-'+from)) state.prevView=from;
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.view===v));
  syncTabScroll(); syncTabNav();
  if(typeof syncTabGroups==='function') syncTabGroups(v);            // underline the group that owns it
  if(typeof closeTabMenus==='function') closeTabMenus();             // navigating always dismisses the menu
  const setHidden=(id,hidden)=>{ const e=el(id); if(e) e.hidden=hidden; };   // null-safe: a stale index.html missing a section can't break navigation
  setHidden('view-markets', v!=='markets');
  setHidden('view-focus', v!=='focus');
  setHidden('view-funds', v!=='funds');
  setHidden('view-trend', v!=='trend');
  setHidden('view-charts', v!=='charts');
  setHidden('view-sectors', v!=='sectors');
  setHidden('view-corr', v!=='corr');
  setHidden('view-funding', v!=='funding');
  setHidden('view-sessions', v!=='sessions');
  setHidden('view-signals', v!=='signals');
  setHidden('view-actionable', v!=='actionable');
  setHidden('view-earnings', v!=='earnings');
  setHidden('view-news', v!=='news');
  setHidden('view-notes', v!=='notes');
  setHidden('view-dm', v!=='dm');
  setHidden('view-congress', v!=='congress');
  setHidden('view-insiders', v!=='insiders');
  setHidden('view-backtest', v!=='backtest');
  setHidden('view-report', v!=='report');
  setHidden('view-admin', v!=='admin');
  setHidden('view-housing', v!=='housing');
  setHidden('view-liquidity', v!=='liquidity');
  { const tm=el('view-treemap'); if(tm) tm.hidden=v!=='treemap'; }   // the runtime-injected treemap (no static section): ← / ⌂ and the palette leave it the same way a tab click does
  try{ document.dispatchEvent(new CustomEvent('xyz:view',{detail:v})); }catch(_){}   // self-installing views (the treemap) render on this, whatever route landed here
  if(v==='focus'){ if(el('view-focus')) openFocus(); else { showView('markets'); return; } }
  if(v==='funds'){ if(el('view-funds')) openFunds(); else { showView('markets'); return; } }
  if(v==='trend'){ if(el('view-trend')) openTrend(); else { showView('markets'); return; } }
  if(v==='charts'){ if(el('view-charts')) openCharts(); else { showView('markets'); return; } }
  if(v==='corr'){ openCorr(); setTimeout(compgAuto,60); }   // COMP/G auto-opens with the tab — no launcher button
  if(v==='funding'){ if(el('view-funding')) openFunding(); else { showView('markets'); return; } }
  if(v==='sessions') renderSessions();
  if(v==='signals'){ if(el('view-signals')) openSignals(); else { showView('markets'); return; } }
  if(v==='actionable'){ if(el('view-actionable')) openActionable(); else { showView('markets'); return; } }
  if(v==='earnings'){ if(el('view-earnings')) openEarnings(); else { showView('markets'); return; } }
  if(v==='news'){ if(el('view-news')) openNews(); else { showView('markets'); return; } }
  if(v==='notes'){ if(el('view-notes')) openNotes(); else { showView('markets'); return; } }
  if(v==='dm'){ if(el('view-dm')) openDM(); else { showView('markets'); return; } }
  if(v==='congress'){ if(el('view-congress')) openCongress(); else { showView('markets'); return; } }
  if(v==='insiders'){ if(el('view-insiders')) openInsiders(); else { showView('markets'); return; } }
  if(v==='backtest'){ if(el('view-backtest')) renderBacktest_load(); else { showView('markets'); return; } }
  if(v==='report'){ if(el('view-report')) openReportView(); else { showView('markets'); return; } }
  if(v==='admin'){ if(el('view-admin')&&IS_ADMIN) openAdmin(); else { showView('markets'); return; } }
  if(v==='sectors') renderSectors();
  if(v==='housing'){ if(el('view-housing')) openHousing(); else { showView('markets'); return; } }
  if(v==='liquidity'){ if(el('view-liquidity')) openLiquidity(); else { showView('markets'); return; } }
  if(!state.detail) setHash(v==='markets'?'':v);
}
export { applyScope, drawBacktest, setScope, showView, syncTabNav, syncTabScroll, updateBenchNote };
