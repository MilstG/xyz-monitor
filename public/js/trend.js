// trend.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { attachLineHover, hoverChart, lcTicks } from "./admin.js";
import { showView } from "./backtest.js";
import { nowChip } from "./base.js";
import { earnBadge, loadTgChannels, saveTgChannels, scopeGuard, secShort, tgChans } from "./calendar.js";
import { G, el, esc, fmtPrice, lazyCall, overlayPop, overlayPush, safeHref, state } from "./core.js";
import { fetchJSON } from "./data.js";
import { openDetail } from "./drawer.js";
import { warmCount } from "./nav.js";

// News tab state — declared here because every reader and writer lives in this module (the split
// moved it out of the signals-tab section, where nothing used it).
let newsFilter='', newsMode='universe', newsSec='', newsView='latest', newsTgOpen=false, newsFl='mat', newsFlForm='';


// ===== trend leaderboard tab =====
// Server-built EMA 13/21 ribbon ladder (D1 · H12 · H4 · H1), ranked long/short boards. The tab
// FOLLOWS THE SCOPE SWITCHER: stocks scope shows the xyz board, crypto scope shows the main-dex
// board — one universe at a time, same as the Markets table. Dots: green = stacked up
// (px>EMA13>EMA21), yellow = repairing (above EMA21, not stacked / rolling over on the shorts
// lens), red = stacked down. RETEST = recent bars probed the 13/21 zone on a trending TF while
// the close held EMA21 — the continuation-entry pullback. Rows click through to market detail.
let _trend=null,_trendLast=0,_trendSide='long',_trendWired=false,_trendInflight=false;
// Active MA pair for the board. [fast,slow] insertion-ordered so a "click a third to swap" replaces
// the OLDER of the two. Default 13/21 fetches the canonical board (no query); any other pair hits
// the parametric endpoint. Server enforces the allowed set — this is just the picker's mirror.
const _trendMAOpts=[13,21,50,200];
let _trendMA=[13,21];
function _trendPairQ(){ const a=Math.min(..._trendMA),b=Math.max(..._trendMA); return (a===13&&b===21)?'':`?fast=${a}&slow=${b}`; }
async function loadTrend(){
  if(_trendInflight) return; _trendInflight=true;
  try{ const d=await fetchJSON('/api/trend'+_trendPairQ()); _trend=d; _trendLast=Date.now(); }
  catch(_){ }
  finally{ _trendInflight=false; }
  if(state.view==='trend') renderTrend();
}
function openTrend(){
  if(!_trendWired){ _trendWired=true;
    const seg=el('trendside');
    if(seg) seg.addEventListener('click',(e)=>{ const b=e.target.closest('button[data-side]'); if(!b) return;
      _trendSide=b.dataset.side;
      seg.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));
      renderTrend(); });
  }
  renderTrend();
  if(Date.now()-_trendLast>60*1000) loadTrend();
}
// The picker: four pickable MAs, two active. Clicking an inactive chip swaps out the OLDER active
// one (insertion order). Default 13/21 is the canonical board; anything else refetches parametric.
function trendMAChips(){
  const act=new Set(_trendMA), has200=_trendMA.includes(200);
  const chips=_trendMAOpts.map(p=>`<button type="button" class="tma-chip${act.has(p)?' on':''}" data-ma="${p}" data-tip="${act.has(p)?'active MA \u2014 click another to swap this pair':'set this as one of the two MAs (replaces the older active one)'}">${p}</button>`).join('');
  const note=has200
    ? 'EMA200 needs ~205 bars on a rung \u2014 rungs without it show grey until history deepens'
    : 'pick 2 \u00b7 click a third to swap the older';
  return `<div class="tma" id="tma-pick"><span class="tma-lbl">MAs</span>${chips}<span class="tma-note sec">${note}</span></div>`;
}
function trendDotHtml(tf,cell,side,ema){
  const F=(ema&&ema[0])||13, S=(ema&&ema[1])||21;
  const st=cell&&cell.st, d=cell&&cell.d21!=null?cell.d21:null;
  if(st==='nodata'){
    return `<span class="tdot nd" data-tip="${tf} \u00b7 not enough history to seed EMA${S} on this rung yet \u2014 an honest grey, not a miss; fills in on its own as daily history deepens"></span>`;
  }
  // long lens: up=green, reclaim=yellow, else red · short lens: down=red(aligned), roll=yellow, else green
  const cls = st==='up'?'g' : st==='down'?'r' : st==='reclaim'?(side==='long'?'y':'g') : (side==='long'?'r':'y');
  const stLbl = st==='up'?`trending — px > EMA${F} > EMA${S}` : st==='down'?`downtrending — px < EMA${F} < EMA${S}`
    : st==='reclaim'?`reclaiming — above EMA${S}, ribbon not yet stacked` : `rolling over — below EMA${S}, ribbon not yet stacked`;
  const tip=`${tf} \u00b7 ${stLbl}${d!=null?` \u00b7 px ${d>=0?'+':''}${d.toFixed(2)}% vs EMA${S}`:''}`;
  return `<span class="tdot ${cls}" data-tip="${tip}"></span>`;
}
function trendSectionHtml(list,side,label,sub,ema){
  const F=(ema&&ema[0])||13, S=(ema&&ema[1])||21;
  let rows='';
  if(!list||!list.length) rows=`<tr><td colspan="12"><div class="msg" style="padding:14px 0">No ${side==='long'?'long':'short'} candidates with \u22652/4 alignment right now \u2014 honest emptiness, not a bug.</div></td></tr>`;
  else rows=list.map((e,i)=>{
    const dots=['D1','H12','H4','H1'].map(t=>`<td class="tdc">${trendDotHtml(t,e.tf&&e.tf[t],side,ema)}</td>`).join('');
    const denom=e.avail!=null?e.avail:4, full=e.score===denom;
    const scCls=side==='long'?(full?'pos':e.score>=denom-1?'':'sec'):(full?'neg':e.score>=denom-1?'':'sec');
    // rrv: volume through the retest, one bar of the retesting TF, clock-matched (server-built)
    const rrv=e.retest&&e.rrv!=null?e.rrv:null;
    const badge=e.retest?`<span class="tretest" data-tip="price has pulled back to the EMA${S} zone on a trending timeframe (${e.retest}) \u2014 prime continuation-entry zone${rrv!=null?` \u00b7 volume through the zone: ${rrv.toFixed(1)}\u00d7 the clock-matched norm for one ${e.retest} bar \u2014 ~1\u00d7 or less = quiet pullback (healthy continuation character), \u22652\u00d7 = the level is being fought, not respected`:''}">RETEST${rrv!=null?` \u00b7 ${rrv.toFixed(1)}\u00d7`:''}</span>`:'';
    // per-scope context badge next to the ticker, reusing the markets-table machinery:
    // crypto = funding-percentile extreme flag, stocks = imminent-earnings badge
    let ctx='';
    const rw=state.rows.get(e.coin);
    if(rw){
      if(state.scope==='crypto'){ const p=rw.fundPct;
        if(p!=null&&(p>=90||p<=10)) ctx=` <i class="fpx ${p>=90?'hi':'lo'}" data-tip="${p}th percentile of this market's OWN 31d funding distribution \u2014 the crowd's payment is at a monthly extreme (${p>=90?'crowded long: a 4/4 uptrend here is a consensus trade, classic mean-reversion zone':'crowded short: squeeze fuel under any long thesis'})">${p>=90?'\u25b4':'\u25be'}${p}</i>`; }
      else if(typeof earnBadge==='function') ctx=earnBadge(rw)||'';
    }
    // age: consecutive D1 bars stacked this side (days) · dash when D1 itself isn't aligned
    const ageTxt=e.age==null?'\u2014':`${e.age}d${e.ageCap?'+':''}`;
    const ageTip=e.age==null?'D1 rung not aligned with this side \u2014 no D1 trend to age'
      :`ribbon stacked ${side==='long'?'up':'down'} on D1 for ${e.age} consecutive day${e.age===1?'':'s'}${e.ageCap?' \u2014 AT LEAST: the stack extends past available history':''} \u00b7 fresh trends rank first within a score`;
    // Δslow: live H1 distance from the slow EMA — proximity to the pullback entry zone
    const d=e.tf&&e.tf.H1?e.tf.H1.d21:null;
    const dTxt=d==null?'\u2014':`${d>=0?'+':''}${d.toFixed(1)}%`;
    const dCls=d==null?'sec':(d>=0?'pos':'neg');
    // width: avg fast–slow EMA spread across this side's aligned rungs — the ribbon's thickness
    const wTxt=e.width==null?'\u2014':`${e.width.toFixed(2)}%`;
    return `<tr data-coin="${esc(e.coin)}" class="${e.retest?'trow-hl':''}" data-tip="open ${esc(e.t)} in the market detail panel">`
      +`<td class="sec" style="width:26px">${i+1}</td><td class="ttick">${esc(e.t)}${ctx}</td>${dots}`
      +`<td class="tscore ${scCls}${denom<4?' tpend':''}"${denom<4?` data-tip="scored out of ${denom} available rungs \u2014 one or more rungs can't seed the chosen MA yet (grey)"`:''}>${e.score}/${denom}${denom<4?'<span class="tpend-star">*</span>':''}</td>`
      +`<td class="twidth" data-tip="ribbon width \u2014 average EMA${F}\u2013EMA${S} spread across the rungs aligned with this side, % of EMA${S} \u00b7 disambiguates equal scores: thin (\u22720.15%) = fragile stack one bad bar flips, wide = established separation">${wTxt}</td>`
      +`<td class="tage" data-tip="${ageTip}">${ageTxt}</td>`
      +`<td class="td21 ${dCls}" data-tip="live distance from the H1 EMA${S} \u2014 proximity to the entry zone \u00b7 small = at the zone, large = extended (chasing)">${dTxt}</td>`
      +`<td class="tread">${esc(e.read||'')}${badge}</td>`
      +`<td class="tcbtn-td"><button type="button" class="tchart-btn" data-coin="${esc(e.coin)}" aria-label="open candlestick chart for ${esc(e.t)}" data-tip="candlestick chart \u2014 1H / 4H / 12H / 1D with the EMA ${F}/${S} ribbon, retest zone and the board's read">${TC_ICON}</button></td></tr>`;
  }).join('');
  return `<div class="tsec-h">${label} <span class="sec" style="text-transform:none;letter-spacing:0;font-weight:400">${sub}</span></div>`
    +`<table class="trend-t"><thead><tr><th>#</th><th style="text-align:left">asset</th><th>D1</th><th>H12</th><th>H4</th><th>H1</th>`
    +`<th data-tip="timeframes aligned with this side \u00b7 4/4 = established trend on every rung">score</th>`
    +`<th data-tip="ribbon width \u2014 avg EMA${F}\u2013EMA${S} spread across aligned rungs \u00b7 thin = fragile stack, wide = established separation \u00b7 comparable across scores">width</th>`
    +`<th data-tip="days the D1 ribbon has been stacked this side \u00b7 N+ = at least (history cap) \u00b7 fresh trends rank first within a score">age</th>`
    +`<th data-tip="live distance from the H1 EMA${S} \u2014 how far from the pullback entry zone">\u0394${S}</th>`
    +`<th style="text-align:left">read</th><th class="tcbtn-td"></th></tr></thead><tbody>${rows}</tbody></table>`;
}
function renderTrend(){
  const box=el('trend-body'); if(!box) return;
  const d=_trend;
  const asof=el('trend-asof');
  if(!d||(!d.long&&!d.short)){ box.innerHTML='<div class="msg"><span class="big">Loading\u2026</span>Building the trend ladder.</div>'; if(asof) asof.textContent=''; return; }
  const side=_trendSide==='short'?'short':'long', b=d[side]||{};
  const cov=d.coverage||{};
  if(asof) asof.textContent=`EMA ${Math.min(..._trendMA)}/${Math.max(..._trendMA)} \u00b7 D1 \u00b7 H12 \u00b7 H4 \u00b7 H1 \u00b7 ${cov.included||0} markets laddered${cov.excluded?` \u00b7 ${cov.excluded} excluded (insufficient history)`:''}`;
  const L=side==='long';
  const cr=state.scope==='crypto';
  const ema=(d.params&&d.params.ema)||[Math.min(..._trendMA),Math.max(..._trendMA)];
  const F=ema[0], S=ema[1];
  let html=trendMAChips();
  html+=cr?trendSectionHtml(b.crypto,side,'CRYPTO','Hyperliquid main dex \u00b7 top-60 by volume',ema)
          :trendSectionHtml(b.stocks,side,'STOCKS \u00b7 MACRO','Hyperliquid xyz dex',ema);
  html+=`<div class="corrpanel tlegend"><div class="cp-sub" style="margin:0 0 8px">How to read it</div>`
    +(L?`<div><span class="tdot g"></span> <b>Trending</b> <span class="sec">\u2014 price &gt; EMA${F} &gt; EMA${S}</span> &nbsp; <span class="tdot y"></span> <b>Reclaiming</b> <span class="sec">\u2014 above EMA${S}, not yet stacked</span> &nbsp; <span class="tdot r"></span> <b>Below trend</b></div>`
       :`<div><span class="tdot r"></span> <b>Downtrending</b> <span class="sec">\u2014 price &lt; EMA${F} &lt; EMA${S}</span> &nbsp; <span class="tdot y"></span> <b>Rolling over</b> <span class="sec">\u2014 below EMA${S}, not yet stacked</span> &nbsp; <span class="tdot g"></span> <b>Above trend</b></div>`)
    +`<div style="margin-top:6px"><span class="tdot nd"></span> <b>No history yet</b> <span class="sec">\u2014 the rung can't seed the chosen MA; scored out of available and fills in as data deepens</span></div>`
    +`<div class="sec" style="margin-top:8px;line-height:1.6"><b style="color:var(--text)">4/4 \u2014 all ${L?'green':'red'}:</b> established ${L?'up':'down'}trend; look for ${L?'longs on pullbacks':'shorts on rallies'} into the EMA${S} zone. <b style="color:var(--text)">2\u20133/4 \u2014 mixed:</b> higher timeframes lead \u2014 wait for lower-TF alignment before entries; manage size. <b style="color:var(--blue)">RETEST</b> \u2014 price has pulled back to the EMA${S} zone on a trending timeframe: prime continuation-entry zone. Click a row for the market's detail panel. Ranked by score, then <b style="color:var(--text)">fresh-first</b> \u2014 within a score the youngest D1 stack ranks highest (the young trend is the entry, the old one is the chase); <b style="color:var(--text)">age</b> counts consecutive D1 days stacked (N+ = at least, history-capped), <b style="color:var(--text)">\u0394${S}</b> is the live distance from the H1 EMA${S} (small = at the entry zone, large = extended). Only names with \u22652/4 alignment appear \u2014 top ${(d.params&&d.params.top)||10}. Flip the scope switcher for the other universe.</div></div>`;
  box.innerHTML=html;
  const pick=el('tma-pick');
  if(pick) pick.addEventListener('click',(ev)=>{ const c=ev.target.closest('button[data-ma]'); if(!c) return;
    const p=+c.dataset.ma; if(_trendMA.includes(p)) return;   // already active
    _trendMA=[_trendMA[1],p];   // drop the older, keep the newer, add the pick
    renderTrend();              // instant chip feedback; the board swaps in when the fetch lands
    loadTrend(); });
  box.querySelectorAll('tr[data-coin]').forEach(tr=>tr.addEventListener('click',()=>{ const c=tr.dataset.coin; if(state.rows.has(c)) openDetail(c); }));   // drawer opens in place — the trend board stays underneath (no tab bounce)
  // chart button: opens the ladder chart modal; stopPropagation so the row's drawer click is untouched
  box.querySelectorAll('.tchart-btn').forEach(b=>b.addEventListener('click',(ev)=>{ ev.stopPropagation(); openTrendChart(b.dataset.coin,side); }));
}

// ===== trend chart modal =====
// Candlestick chart for one board row, launched from the per-row chart button. One-code-path
// contract, learned the hard way from a mockup that lied: EVERY annotation (state badge, retest
// flag, zone band levels, \u039421, read line, rrv) comes from the /api/trend payload the board
// itself rendered \u2014 the modal NEVER re-derives trend state client-side. The candles come from
// /api/candles?tf=, which serves the EXACT series the ladder consumed for that rung, so the
// plotted EMA walk (same SMA-seed construction, same live-mark-drives-the-forming-bar rule)
// reproduces the ladder's EMAs bit-for-bit. If the plotted ribbon's right edge ever detached
// from the payload's zone band, that gap would be a visible bug, not a hidden one.
// Crypto D1 depth (option A): all retained candles are shown; bars inside the EMA seed window
// (index < 20, before EMA21 exists) render dimmed with no ribbon over them \u2014 candles are real,
// the ribbon there would not be, and a dash is honest where a half-converged EMA is not.
const TC_ICON='<svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><line x1="3" y1="1" x2="3" y2="11"/><rect x="1.5" y="3" width="3" height="5" fill="currentColor" stroke="none"/><line x1="8" y1="0.5" x2="8" y2="9"/><rect x="6.5" y="2" width="3" height="4" fill="currentColor" stroke="none"/><line x1="12.5" y1="3" x2="12.5" y2="11.5"/><rect x="11" y="5" width="3" height="4" fill="currentColor" stroke="none"/></svg>';
const TC_TFS=[{api:'1h',lad:'H1',lbl:'1H'},{api:'4h',lad:'H4',lbl:'4H'},{api:'12h',lad:'H12',lbl:'12H'},{api:'1d',lad:'D1',lbl:'1D'}];
let _tc={coin:null,side:'long',tf:'4h',entry:null,inflight:false,seq:0};
// Per-bar EMA over `closes` (oldest -> newest): SMA of the first `span` bars seeds, then the
// textbook recursion \u2014 the SAME construction as the server's emaLast/stackedRun, so the final
// bar agrees with the ladder to the last bit. null before the seed completes: no honest value
// exists there, and the renderer draws nothing rather than a half-converged line.
function tcEmaSeries(closes,span){
  const n=closes.length,out=new Array(n).fill(null);
  if(n<span) return out;
  let s=0;
  for(let i=0;i<span;i++){ const v=+closes[i]; if(!isFinite(v)) return out; s+=v; }
  let e=s/span; out[span-1]=e;
  const a=2/(span+1);
  for(let i=span;i<n;i++){ const v=+closes[i]; if(!isFinite(v)) return out.fill(null,i); e=a*v+(1-a)*e; out[i]=e; }
  return out;
}
function tcStateMeta(st,side,ema){
  const F=(ema&&ema[0])||13, S=(ema&&ema[1])||21;
  // same color lens as the board dots \u2014 the modal restates the board, never re-decides it
  const cls = st==='up'?'g' : st==='down'?'r' : st==='reclaim'?(side==='long'?'y':'g') : (side==='long'?'r':'y');
  const lbl = st==='up'?`trending \u2014 px > EMA${F} > EMA${S}` : st==='down'?`downtrending \u2014 px < EMA${F} < EMA${S}`
    : st==='reclaim'?`reclaiming \u2014 above EMA${S}, ribbon not stacked` : st==='roll'?`rolling over \u2014 below EMA${S}, ribbon not stacked`:'\u2014';
  return {cls,lbl};
}
function tcCandleSvg(cd,px,tfc,retesting,side,swing,ema){
  const F=(ema&&ema[0])||13, S=(ema&&ema[1])||21;
  const W=640,H=330, pl=6,pr=56,pt=10,pb=22, SHOW=64, SEED=S-1;   // seed window = bars before the SLOW EMA exists
  if(!cd||cd.length<2) return '<div class="msg" style="padding:18px 0">Not enough candles for this timeframe yet \u2014 the series is still filling server-side.</div>';
  const closes=cd.map(k=>+k[4]);
  if(px!=null&&isFinite(+px)) closes[closes.length-1]=+px;   // live mark drives the forming bar, matching trendLadder
  const e13=tcEmaSeries(closes,F), e21=tcEmaSeries(closes,S);
  const i0=Math.max(0,cd.length-SHOW), view=cd.slice(i0), n=view.length;
  let lo=Infinity,hi=-Infinity;
  for(let i=0;i<n;i++){ const k=view[i];
    const l=k[3]!=null&&isFinite(+k[3])?+k[3]:+k[4], h=k[2]!=null&&isFinite(+k[2])?+k[2]:+k[4];
    if(l<lo)lo=l; if(h>hi)hi=h; }
  if(px!=null&&isFinite(+px)){ if(px<lo)lo=px; if(px>hi)hi=px; }
  if(tfc&&tfc.e21!=null&&tfc.e21<lo)lo=tfc.e21; if(tfc&&tfc.e13!=null&&tfc.e13>hi)hi=tfc.e13;
  if(retesting&&swing!=null&&isFinite(+swing)){ if(+swing<lo)lo=+swing; if(+swing>hi)hi=+swing; }
  if(!(hi>lo)) return '';
  const pad=(hi-lo)*0.05; hi+=pad; lo-=pad;
  const X=i=>pl+(i+0.5)/n*(W-pl-pr), Y=v=>pt+(1-(v-lo)/(hi-lo))*(H-pt-pb);
  const bw=Math.max(1.4,Math.min(7,(W-pl-pr)/n*0.66));
  let s='';
  for(const v of lcTicks(lo,hi,4)){ const y=Y(v).toFixed(1);
    s+=`<line x1="${pl}" y1="${y}" x2="${W-pr}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`+
       `<text x="${W-pr+5}" y="${(+y+3).toFixed(1)}" class="lc-tick">${fmtPrice(v)}</text>`; }
  // EMA seed window (option A): candles are real, the ribbon over them would not be
  const seedVis=SEED-i0;   // displayed bars before this index have no EMA21
  if(seedVis>0){
    const sw=pl+(Math.min(seedVis,n))/n*(W-pl-pr);
    s+=`<rect x="${pl}" y="${pt}" width="${(sw-pl).toFixed(1)}" height="${H-pt-pb}" fill="var(--panel2)" fill-opacity="0.55"/>`+
       `<line x1="${sw.toFixed(1)}" y1="${pt}" x2="${sw.toFixed(1)}" y2="${H-pb}" stroke="var(--border)" stroke-dasharray="3 3"/>`+
       `<text x="${pl+5}" y="${pt+13}" class="lc-tick" style="paint-order:stroke;stroke:var(--panel);stroke-width:3px">EMA seed window \u2014 no honest ribbon</text>`; }
  // retest zone band: the LADDER'S e13/e21 for this rung, shipped in /api/trend \u2014 never recomputed here
  if(tfc&&tfc.e13!=null&&tfc.e21!=null){
    let zt=Y(tfc.e13), zb=Y(tfc.e21); if(zb<zt){const t=zt;zt=zb;zb=t;}
    const zx=seedVis>0?pl+(Math.min(seedVis,n))/n*(W-pl-pr):pl;
    s+=`<rect x="${zx.toFixed(1)}" y="${zt.toFixed(1)}" width="${(W-pr-zx).toFixed(1)}" height="${Math.max(2,zb-zt).toFixed(1)}" fill="var(--blue)" fill-opacity="0.09" stroke="var(--blue)" stroke-opacity="0.4" stroke-dasharray="3 3"/>`;
    // label stays two words — the guidance sentence lives in the read strip, not smeared across candles
    if(retesting) s+=`<text x="${(zx+5).toFixed(1)}" y="${(zb+14).toFixed(1)}" class="lc-tick" fill="var(--blue)" style="paint-order:stroke;stroke:var(--panel);stroke-width:3px">retest zone</text>`;
  }
  // prior-swing target: the level the read (and the tretest ledger claim) targets — shipped on
  // the trend payload, computed server-side from the same rung series; never derived here
  if(retesting&&swing!=null&&isFinite(+swing)&&+swing>lo&&+swing<hi){
    const sy=Y(+swing), sc=side==='long'?'var(--up)':'var(--down)';
    s+=`<line x1="${pl}" y1="${sy.toFixed(1)}" x2="${W-pr}" y2="${sy.toFixed(1)}" stroke="${sc}" stroke-width="1" stroke-dasharray="5 3" opacity="0.75"/>`+
       `<text x="${pl+5}" y="${(sy-4).toFixed(1)}" class="lc-tick" fill="${sc}" style="paint-order:stroke;stroke:var(--panel);stroke-width:3px">prior swing \u2014 target</text>`+
       `<rect x="${W-pr}" y="${(sy-9).toFixed(1)}" width="${pr-2}" height="18" fill="var(--panel2)" stroke="${sc}" opacity="0.9"/>`+
       `<text x="${W-pr+5}" y="${(sy+3.5).toFixed(1)}" class="lc-tick" fill="var(--text)">${fmtPrice(+swing)}</text>`;
  }
  // ribbon fill between the walks, only where BOTH EMAs exist
  let up='',dn='';
  for(let i=0;i<n;i++){ const a=i0+i; if(e13[a]!=null&&e21[a]!=null) up+=(up?'L':'M')+X(i).toFixed(1)+' '+Y(e13[a]).toFixed(1); }
  for(let i=n-1;i>=0;i--){ const a=i0+i; if(e13[a]!=null&&e21[a]!=null) dn+='L'+X(i).toFixed(1)+' '+Y(e21[a]).toFixed(1); }
  if(up&&dn) s+=`<path d="${up}${dn}Z" fill="var(--blue)" fill-opacity="0.07"/>`;
  for(let i=0;i<n;i++){ const k=view[i], a=i0+i, x=X(i);
    const o=k[1],h=k[2],l=k[3],c=k[4], dim=a<SEED;
    const prev=i>0?+view[i-1][4]:c;
    if(o==null||!isFinite(+o)){
      // closes-only bar (warm-cache daily / synthetic forming bar): an honest close tick
      const colT=c>=prev?'var(--up)':'var(--down)';
      s+=`<line x1="${(x-bw/2).toFixed(1)}" y1="${Y(c).toFixed(1)}" x2="${(x+bw/2).toFixed(1)}" y2="${Y(c).toFixed(1)}" stroke="${colT}" stroke-width="1.5"${dim?' opacity="0.35"':''}/>`;
      continue; }
    const upB=c>=o, col=upB?'var(--up)':'var(--down)';
    if(h!=null&&l!=null&&isFinite(+h)&&isFinite(+l))
      s+=`<line x1="${x.toFixed(1)}" y1="${Y(h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${Y(l).toFixed(1)}" stroke="${col}" stroke-width="1"${dim?' opacity="0.35"':''}/>`;
    const y0=Y(Math.max(o,c)), hgt=Math.max(1,Math.abs(Y(o)-Y(c)));
    s+=`<rect x="${(x-bw/2).toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}"${dim?' opacity="0.35"':upB?' fill-opacity="0.85"':''}/>`; }
  let p13='',p21='';
  for(let i=0;i<n;i++){ const a=i0+i;
    if(e21[a]!=null) p21+=(p21?'L':'M')+X(i).toFixed(1)+' '+Y(e21[a]).toFixed(1);
    if(e13[a]!=null) p13+=(p13?'L':'M')+X(i).toFixed(1)+' '+Y(e13[a]).toFixed(1); }
  if(p21) s+=`<path d="${p21}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>`;
  if(p13) s+=`<path d="${p13}" fill="none" stroke="var(--blue)" stroke-width="1.6"/>`;
  if(px!=null&&isFinite(+px)){ const py=Y(+px);
    s+=`<line x1="${pl}" y1="${py.toFixed(1)}" x2="${W-pr}" y2="${py.toFixed(1)}" stroke="var(--blue)" stroke-width="1" stroke-dasharray="2 3"/>`+
       `<rect x="${W-pr}" y="${(py-9).toFixed(1)}" width="${pr-2}" height="18" fill="var(--panel2)" stroke="var(--blue)"/>`+
       `<text x="${W-pr+5}" y="${(py+3.5).toFixed(1)}" class="lc-tick" fill="var(--text)">${fmtPrice(+px)}</text>`; }
  const isD=_tc.tf==='1d';
  const dfmt=t=>{ const d=new Date(t); return isD?((d.getUTCMonth()+1)+'/'+d.getUTCDate()):((d.getMonth()+1)+'/'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':00'); };
  s+=`<text x="${pl}" y="${H-6}" class="lc-tick">${dfmt(view[0][0])}</text>`;
  s+=`<text x="${W-pr}" y="${H-6}" text-anchor="end" class="lc-tick">${dfmt(view[n-1][0])}</text>`;
  const xs=view.map((_,i)=>X(i));
  const rows=view.map((k,i)=>{ const a=i0+i, c=+k[4];
    const f=v=>v==null||!isFinite(+v)?'\u2014':fmtPrice(+v);
    const dd=e21[a]!=null?((c-e21[a])/e21[a]*100):null;
    return `<b style="color:var(--text)">${dfmt(k[0])}${a<SEED?' \u00b7 seed':''}</b><br>O ${f(k[1])} \u00b7 H ${f(k[2])}<br>L ${f(k[3])} \u00b7 C ${f(c)}`+
      `<br><span style="color:var(--blue)">EMA13</span> ${a>=SEED&&e13[a]!=null?fmtPrice(e13[a]):'\u2014'} \u00b7 <span style="color:var(--accent)">EMA21</span> ${a>=SEED&&e21[a]!=null?fmtPrice(e21[a]):'\u2014'}`+
      (a>=SEED&&dd!=null?`<br>\u039421 <span style="color:${dd>=0?'var(--up)':'var(--down)'}">${dd>=0?'+':''}${dd.toFixed(2)}%</span>`:''); });
  return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});
}
function tcDepthNote(cd,tfName,closesOnly){
  if(!cd||!cd.length) return '';
  const honest=Math.max(0,cd.length-20);
  let t=`${cd.length} bars \u00b7 ribbon honest from bar 21 (${honest} ribbon bar${honest===1?'':'s'})`;
  if(tfName==='D1'&&state.scope==='crypto') t+=' \u00b7 crypto retention is 31d \u2014 the D1 ribbon is young; converged enough to classify, thin enough to respect';
  if(closesOnly) t+=' \u00b7 daily bars are closes-only right now (warm-cache restore) \u2014 drawn as close ticks, never fabricated bodies; full candles land as the daily refetch queue drains';
  return t;
}
function renderTrendChart(res){
  const m=el('tchartmodal'); if(!m||m.hidden) return;
  const e=_tc.entry||{}, tfDef=TC_TFS.find(t=>t.api===_tc.tf)||TC_TFS[1];
  const ema=_tc.ema||[13,21], F=ema[0], S=ema[1];
  const tfc=e.tf&&e.tf[tfDef.lad]?e.tf[tfDef.lad]:null;
  const st=tfc?tcStateMeta(tfc.st,_tc.side,ema):null;
  const retesting=!!(e.retest&&e.retest===tfDef.lad);
  const seg=TC_TFS.map(t=>{ const cell=e.tf&&e.tf[t.lad];
    const dot=cell?`<span class="tdot ${tcStateMeta(cell.st,_tc.side,ema).cls}" style="width:7px;height:7px;margin-right:5px;box-shadow:none"></span>`:'';
    return `<button type="button" class="cdtf${t.api===_tc.tf?' on':''}" data-tf="${t.api}">${dot}${t.lbl}</button>`; }).join('');
  const rrv=retesting&&e.rrv!=null?` \u00b7 zone volume ${e.rrv.toFixed(1)}\u00d7`:'';
  const d21=tfc&&tfc.d21!=null?`\u039421 ${tfc.d21>=0?'+':''}${tfc.d21.toFixed(1)}%`:'';
  const cd=(res&&Array.isArray(res.candles))?res.candles:[];
  // closes-only detection excludes the last bar: the synthetic forming daily bar is ALWAYS
  // closes-only by construction and must not tag a healthy series
  const closesOnly=_tc.tf==='1d'&&cd.length>1&&cd.slice(0,-1).every(b=>b[1]==null);
  m.innerHTML=
    `<div class="tcm-head"><span class="ttick" style="font-size:var(--fs-lg)">${esc(e.t||_tc.coin)}</span>`+
    (res&&res.px!=null?`<span class="tcm-px">${fmtPrice(res.px)}</span>`:'')+
    (st?`<span class="tcm-badge ${st.cls}" data-tip="${tfDef.lad} \u00b7 ${st.lbl} \u2014 the board's own classification for this rung, restated">${tfDef.lad} ${tfc.st}</span>`:'')+
    `<span class="tcm-badge sc" data-tip="timeframes aligned with the ${_tc.side} side, from the board">${e.score!=null?e.score+'/'+(e.avail||4):''}</span>`+
    (e.retest?`<span class="tretest" data-tip="the board's retest flag \u2014 recent bars probed the ${F}/${S} zone on ${e.retest} while the close held EMA${S}${e.rrv!=null?` \u00b7 volume through the zone ${e.rrv.toFixed(1)}\u00d7 the clock-matched norm`:''}">RETEST ${e.retest}</span>`:'')+
    `<span class="cdtf-seg" style="margin-left:auto">${seg}</span>`+
    `<button type="button" class="btn tcm-x" id="tchartx" aria-label="close">\u2715</button></div>`+
    `<div class="tcm-chart">${tcCandleSvg(cd,res?res.px:null,tfc,retesting,_tc.side,(_tc.entry&&_tc.entry.swing!=null)?_tc.entry.swing:null,ema)}</div>`+
    `<div class="tcm-leg"><span><i style="color:var(--blue)">\u2501</i> EMA${F}</span><span><i style="color:var(--accent)">\u2501</i> EMA${S}</span>`+
    `<span><i class="tcm-zsw"></i> ${F}/${S} retest zone (ladder levels)</span>`+
    (d21?`<span class="tcm-d21" data-tip="live distance from this rung's EMA${S} at the last board build \u2014 small = at the entry zone, large = extended">${d21}</span>`:'')+`</div>`+
    `<div class="tcm-note">${tcDepthNote(cd,tfDef.lad,closesOnly)}</div>`+
    `<div class="tcm-read">${st?`<span class="tdot ${st.cls}" style="margin-right:7px"></span>`:''}${esc(e.read||'')}${rrv?`<span class="sec">${rrv}</span>`:''}`+
    `<div class="sec" style="margin-top:5px;font-size:var(--fs-xs);line-height:1.55">Badges, zone levels and the read are the Trend board's own values (\u22643 min old); candles are the exact series that board's ladder consumed for this rung, so the plotted ribbon reproduces its EMAs. Nothing here is re-derived client-side.</div></div>`;
  m.querySelectorAll('.cdtf').forEach(b=>b.addEventListener('click',()=>{ if(b.dataset.tf!==_tc.tf){ _tc.tf=b.dataset.tf; loadTrendChart(); } }));
  const x=el('tchartx'); if(x) x.onclick=closeTrendChart;
  attachLineHover();
}
async function loadTrendChart(){
  const m=el('tchartmodal'); if(!m||m.hidden||!_tc.coin) return;
  const seq=++_tc.seq;
  renderTrendChart(null);   // header + seg paint immediately; the chart body says it's loading
  const body=m.querySelector('.tcm-chart'); if(body) body.innerHTML='<div class="msg" style="padding:18px 0">Loading\u2026</div>';
  try{
    const pq=(_tc.ema&&!(_tc.ema[0]===13&&_tc.ema[1]===21))?`&fast=${_tc.ema[0]}&slow=${_tc.ema[1]}`:'';
    const res=await fetchJSON('/api/candles?coin='+encodeURIComponent(_tc.coin)+'&tf='+encodeURIComponent(_tc.tf)+pq);
    if(seq!==_tc.seq||m.hidden) return;   // a newer click or a close superseded this fetch
    renderTrendChart(res);
  }catch(_){ if(seq===_tc.seq&&!m.hidden&&body) body.innerHTML='<div class="msg" style="padding:18px 0">Chart unavailable \u2014 the candles endpoint did not answer. The board above is unaffected.</div>'; }
}
function openTrendChart(coin,side){
  const bg=el('tchartbg'), m=el('tchartmodal'); if(!bg||!m) return;
  const uni=state.scope==='crypto'?'crypto':'stocks';
  const board=(_trend&&_trend[side]&&_trend[side][uni])||[];
  const e=board.find(x=>x.coin===coin);
  if(!e) return;   // board re-ranked under the click \u2014 nothing honest to show
  _tc={coin,side,entry:e,ema:(_trend&&_trend.params&&_trend.params.ema)||[13,21],inflight:false,seq:_tc.seq,
    tf:(e.retest&&(TC_TFS.find(t=>t.lad===e.retest)||{}).api)||'4h'};   // open on the retesting rung when one fires
  bg.hidden=false; m.hidden=false; overlayPush('tchart', closeTrendChart);
  loadTrendChart();
}
function closeTrendChart(){ overlayPop('tchart'); const bg=el('tchartbg'), m=el('tchartmodal'); if(bg)bg.hidden=true; if(m){m.hidden=true;m.innerHTML='';} _tc.coin=null; _tc.entry=null; }

export function __boot_trend_8880() {
{ const bg=el('tchartbg'); if(bg) bg.addEventListener('click',closeTrendChart); }   // Escape: overlay stack (core.js)
}


const EV_LABELS={bigmove:'Big move',breakout:'30d-high breakout',breakdown:'30d-low breakdown',volshift:'Vol expansion',gap:'Outsized gap',fundflip:'Funding flip',squeeze:'Squeeze setup',unwind:'Long unwind',oiflush:'OI flush',fpdiv:'Funding\u2013price divergence',coil:'Range compression',ondrift:'Overnight drift',prem:'Premium dislocation',volume:'Volume surge',tretest:'Trend retest (long)',tretestdn:'Trend retest (short)',casc:'Cascade exhaustion',fundext:'Funding extreme'};
const EV_TIP={
  bigmove:'Today\u2019s move is \u22652\u03c3 of this market\u2019s own trailing 30d daily returns. History measures whether such moves continued (positive) or faded (negative) the next day, signed with the move.',
  breakout:'First close/mark above the prior 30-day high. History: forward 5d return after past first-crosses on this market.',
  volshift:'10d realized vol crossed above the 90th percentile of its own trailing ~6 months. History: forward 5d return after past expansions.',
  breakdown:'Close crossed below the prior 30d low. Forward 5d study, signed with the breakdown \u2014 the bearish mirror of the breakout.',gap:'The live move since the last cash close is outsized vs this market\u2019s own gap distribution. History: did the next cash session continue (positive) or fade (negative) such gaps? For markets whose own record says gaps FADE, the study numbers shown (and the ledgered claim) are flipped into the units of the FADE play \u2014 positive = the fade paid.',
  fundflip:'Day-summed funding changed sign after \u22653 days pinned the other way \u2014 the crowd switched sides. History: 3d move toward the new crowd.',
  squeeze:'Crowded shorts (negative 7d funding) \u00d7 OI building \u00d7 price pressing the range \u2014 the squeeze spring is loaded. No historical study yet: needs longer OI history.',
  unwind:'Crowded longs paying funding while OI builds and price sits near range lows \u2014 the bearish mirror of the squeeze. Their liquidation is the seller of last resort.',oiflush:'7d \u0394OI collapsed below \u22122\u03c3 of this market\u2019s own distribution while price fell \u2014 forced deleveraging exhausting itself. Flushes measure positions destroyed, not price traveled; the claim is a 5d bottoming thesis.',fpdiv:'Funding trajectory diverging from the tape: strength while funding falls = shorts pressing into a rising market (squeeze-adjacent, long); weakness while funding rises = longs averaging down into a falling one (fragile, short). 3d horizon, with the divergence.',coil:'10d realized vol in the bottom decile of its own trailing 120 observations \u2014 the spring is loaded, direction unknown. Context only: it never claims a side; it exists to corroborate a breakout or breakdown firing OUT of the compression.',ondrift:'This market\u2019s summed off-hours drift over ~21 closed windows sits \u22652\u03c3 from the universe. The claim covers ONLY the next 5 overnight windows held close\u2192open \u2014 the structural edge of a venue where cash-hours assets trade 24/7. Ships without a backtest study by design: it earns trust purely out of sample.',prem:'Perp price dislocated from oracle vs its own 7-day premium baseline. During closed cash sessions this IS the live price discovery for the synthetic.',
  volume:'24h volume is a multiple of this market\u2019s own 30d norm \u2014 a context flag that amplifies whatever else is firing.',
  tretest:'The Trend board\u2019s RETEST badge, promoted to a ledgered claim: a \u22653/4 stacked uptrend whose retesting rung probed the 13/21 EMA zone while the close held EMA21. Frozen at fire \u2014 entry = mark, void = that rung\u2019s EMA21, target = the rung\u2019s prior swing high. 5d horizon. Ships without a backtest study by design: the record is earned purely out of sample.',
  casc:'Crypto only. A 15-minute bucket where one side\u2019s forced-liquidation notional spiked \u22653\u03c3 above its own trailing 24h WHILE open interest fell in the same bucket \u2014 flow that actually cleared positioning \u2014 and whose flush extreme has held since. Longs carried out \u2192 long the exhaustion; shorts \u2192 short it. Void = the flush wick, target = the pre-cascade level: both prices the tape printed, so this claim needs no \u03c3 construction at all. Trigger reads aggregated CEX data (Coinalyze) while the claim resolves on the Hyperliquid mark \u2014 that venue mismatch is real and deliberate, not an oversight. 12h horizon, record earned purely out of sample.',
  fundext:'Crypto only. Funding sitting at the \u226590th or \u226410th percentile of this name\u2019s OWN 31-day distribution, with the same side holding across the trailing window \u2014 the persistence floor is what makes it one episode rather than one print. Faded: crowded longs \u2192 short, crowded shorts \u2192 long. Target = the geometric middle of the 30d range, void = 1.5\u03c3 beyond where the crowd is defending. 2d horizon, no in-sample study \u2014 it earns its record live.',
  tretestdn:'The short mirror of the trend retest: a \u22653/4 stacked downtrend whose rung rallied into the 13/21 zone while the close held below EMA21. Void = that rung\u2019s EMA21, target = prior swing low, 5d horizon, record earned out of sample.',
};
// Structured playbook row: side pill (LONG/SHORT/FADE/WATCH), levels with live distance from
// the current mark, and the corroborating watch condition. Mechanical setup description — the
// track record strip is what decides whether the event type deserves any trust.
const SP_SIDE={long:{t:'LONG',c:'sp-long',tip:'the setup implies upside on this perp over the stated horizon'},
  short:{t:'SHORT',c:'sp-short',tip:'the setup implies downside on this perp over the stated horizon'},
  watch:{t:'WATCH',c:'sp-watch-pill',tip:'no directional edge claimed \u2014 a condition to monitor, not to trade'}};
function playDist(g, lvl){
  const r=state.rows.get(g.coin);
  if(!r||r.px==null||!(r.px>0)||lvl==null) return '';
  if(g.ev==='prem'){ const bp=(lvl/r.px-1)*1e4; return ` <i class="${bp>=0?'pos':'neg'}">(${bp>=0?'+':''}${bp.toFixed(0)}bp away)</i>`; }
  const pc=(lvl/r.px-1)*100;
  return ` <i class="${pc>=0?'pos':'neg'}">(${pc>=0?'+':''}${pc.toFixed(1)}%)</i>`;
}
function rrChip(g){
  const c=g.claim0, frozen=!!c;   // claim present => claim geometry exclusively; its nulls mean "no such level" (e.g. geometry-voided stop)
  const p=g.play, r=state.rows.get(g.coin);
  // Frozen claim: R/R measured from the CLAIMED mark against the frozen levels — the geometry
  // the ledger scores. Live-only signals keep the live-mark geometry.
  const px=frozen?(c.px>0?c.px:null):(r&&r.px>0?r.px:null);
  const tgt=frozen?c.tgt:(p&&p.target), stp=frozen?c.stop:(p&&p.stop);
  if(px==null||tgt==null||stp==null) return '';
  const up=Math.abs(tgt-px), dn=Math.abs(stp-px);
  if(!(dn>0)) return '';
  const rr=up/dn, cl=rr>=1.5?'pos':(rr<0.8?'neg':'sec');
  return `<span class="sp-lvl" data-tip="median-target distance \u00f7 invalidation distance${frozen?' from the CLAIMED mark \u2014 the frozen geometry the ledger scores':' from the live mark'}. CAVEAT: the target is the MEDIAN outcome (50th percentile drift) and the void level is premise-invalidation, not a risk-sized stop \u2014 so this ratio screens structure, it does not measure trade expectancy. A low ratio only works with a high hit rate; the expectancy figure and the live track record are the real arbiters.">R/R <b class="${cl}">${rr.toFixed(1)}</b></span>`;
}
function playRow(g){
  const p=g.play, c=g.claim0, frozen=!!(c&&(c.side||c.stop!=null||c.tgt!=null));
  // When an open claim exists, the side and levels are the CLAIM'S — stamped at fire, the exact
  // things the ledger resolves against. They do not drift with the market; only the shown
  // distance-from-here moves, because the live mark does. Without a claim (context flags),
  // the live-computed playbook renders as before.
  const side=frozen&&c.side?c.side:p.side, sd=SP_SIDE[side]||SP_SIDE.watch;
  // A claim's nulls are meaningful: a geometry-voided stop means this claim HAS no stop-aware
  // leg — falling back to the live level would re-display the exact inverted number the gate
  // just refused to stamp. Claim present => claim values, exclusively.
  const tgt=frozen?c.tgt:p.target, stp=frozen?c.stop:p.stop;
  const wrapTip=frozen
    ? `Mechanical description of the setup \u2014 NOT advice. Side and levels are FROZEN from the claim opened ${new Date(c.t).toLocaleString()}${c.px!=null?` at ${fmtPrice(c.px)}`:''}: the ledger resolves against exactly these, so they never move while the claim is open. Distances are measured from the live mark, so they change as price does. The track record strip above decides which event types deserve any trust.`
    : `Mechanical description of the setup with levels computed from this market's own stats \u2014 NOT advice. Distances are measured from the live mark. The track record strip above decides which event types deserve any trust.`;
  return `<span class="sig-play" data-tip="${esc(wrapTip)}">`
    +`<span class="sp-k">play</span>`
    +`<b class="sp-side ${sd.c}" data-tip="${esc(sd.tip+(frozen&&c.side?' \u2014 side stamped on the claim at fire; it cannot flip while the claim is open':''))}">${sd.t}</b>`
    +`<span class="sp-bias">${esc(p.bias||'')}</span>`
    +(tgt!=null?`<span class="sp-lvl" data-tip="${esc(frozen?'target implied by the historical median AT FIRE \u2014 frozen on the claim; where the base rate said the move resolves, measured from the claimed mark':'level implied by this market\u2019s own historical median for the event \u2014 where the base rate says the move resolves')}">target <b>${fmtPrice(tgt)}</b>${playDist(g,tgt)}</span>`:'')
    +(stp!=null?`<span class="sp-lvl" data-tip="${esc(frozen?'invalidation FROZEN at fire \u2014 the stop-aware track resolves against exactly this level; beyond it the setup\u2019s premise is broken':'invalidation \u2014 beyond this level the setup\u2019s premise is broken and the signal should be treated as void')}">void <b>${fmtPrice(stp)}</b>${playDist(g,stp)}</span>`:'')
    +rrChip(g)
    +`</span>`
    +(p.watch?`<span class="sp-watchline" data-tip="${esc('the one corroborating condition that confirms or kills this setup \u2014 '+p.watch)}">watch \u2014 ${esc(p.watch)}</span>`:'');
}
function fmtTrig(t0){ if(t0==null) return ''; const d=new Date(t0), n=new Date();
  const hm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  return (d.getDate()===n.getDate()&&d.getMonth()===n.getMonth())?hm:(d.getMonth()+1)+'/'+d.getDate()+' '+hm; }
function newsRow(a,now,inDrawer){
  const age=fmtAge(now-a.pub), old=now-a.pub>86400000;
  if(a.fl){
    // Whale rows (a.wh): a watched FUND's 13F landing on the tape. The badge deep-links to the
    // fund's book on the FUNDS tab — a fund key is not a ticker and must never hit openDetail.
    const badge=a.wh
      ?`<span class="nbadge whl" data-whale="${esc(a.tk)}" data-tip="${esc('a watched 13F filer \u2014 click for the fund\u2019s book on the FUNDS tab')}">${esc(a.tk)}</span>`
      :`<span class="nbadge${a.sig?' sig':(a.ed!=null?' earn':'')}" data-coin="${esc(a.coin||'')}" data-tip="${esc('click for the '+a.tk+' drawer')}">${esc(a.tk)}</span>`;
    return `<div class="nrow${old?' old':''}">`
      +`<span class="nage" data-tip="${esc(new Date(a.pub).toLocaleString())}">${age}</span>`
      +`<span class="nform${a.mat?' mat':''}" data-form="${esc(a.form)}" data-tip="${esc((a.mat?'material form':'routine form')+' \u00b7 click to filter to '+a.form+' filings')}">${esc(a.form)}</span>`
      +badge
      +`<span class="nhl">${a.url?`<a href="${esc(safeHref(a.url))}" target="_blank" rel="noopener noreferrer" data-tip="${esc(a.h)}">${esc(a.h)}</a>`:esc(a.h)}</span>`
      +`<span class="nsrc">EDGAR \u2197</span>`
      +`</div>`;
  }
  const badge=inDrawer?'':(a.tk
    ?`<span class="nbadge${a.sig?' sig':(a.ed!=null?' earn':'')}" data-coin="${esc(a.coin||'')}" data-tip="${esc(a.sig?'a live signal is currently firing on '+a.tk+' — refreshed each signals build, may lag a few minutes; click for the drawer':(a.ed!=null?a.tk+' reports earnings in '+a.ed+' day'+(a.ed===1?'':'s')+'; click for the drawer':'click for the '+a.tk+' drawer'))+(a.relAi?' \u00b7 attribution AI-verified (headline did not name the company directly)':'')}">${esc(a.tk)}</span>`
    :(a.pend
      ?`<span class="nbadge tape" data-tip="fetched under a universe name but the headline does not verifiably concern it \u2014 relevance verdict pending; until verified it lives here, never in the universe feed">tape \u2026</span>`
      :`<span class="nbadge tape" data-tip="unfiltered feed \u2014 not attributed to a universe name">tape</span>`));
  const sec=(!inDrawer&&a.sec)?`<span class="nsec-badge${a.secAi?' ai':''}" data-sec="${esc(a.sec)}" data-tip="${esc(a.secAi?(a.tk?'not in the static sector map \u2014 AI-classified once, persisted, reused forever \u00b7 click to filter':'AI-classified from the headline text, not a ticker mapping \u00b7 click to filter'):'GICS sector from the static map \u00b7 click to filter')}">${esc(secShort(a.sec))}${a.secAi?' ~':''}</span>`:'';
  return `<div class="nrow${old?' old':''}${a.sec==='off-topic'?' off':''}">`
    +`<span class="nage" data-tip="${esc(new Date(a.pub).toLocaleString())}">${age}</span>`
    +badge
    +sec
    +`<span class="nhl">${a.url?`<a href="${esc(safeHref(a.url))}" target="_blank" rel="noopener noreferrer" data-tip="${esc(a.h)}">${esc(a.h)}</a>`:esc(a.h)}</span>`
    +(a.src?`<span class="nsrc">${esc(a.src)} \u2197</span>`:'')
    +`</div>`;
}
function renderNews(){
  const box=el('news-body'); if(!box) return;
  const d=state.news, now=Date.now();
  const inLane=(a)=>newsMode==='filings'?!!a.fl:(a.fl?false:(newsMode==='universe'?!!a.tk:(newsMode==='telegram'?!!a.tg:true)));   // filings are exclusive BOTH ways: only in their lane, never in universe/tape/telegram
  const secCounts=new Map();
  if(d&&d.items) for(const a of d.items){ if(a.sec&&!a.fl&&inLane(a)) secCounts.set(a.sec,(secCounts.get(a.sec)||0)+1); }
  const secOpts=[...secCounts.entries()].sort((x,y)=>y[1]-x[1]);
  const head=`<div class="nhead">`
    +`<span class="sec" style="font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.6px" data-tip="per-name headlines (Finnhub company news) for the equity universe + the general macro tape \u00b7 72h rolling window, evicted on publish time \u00b7 this is a digest, not a live wire — the freshness stamp on the right is the coverage clock \u00b7 sectors: solid badge = static GICS map, ~ = AI-classified (write-once, fallback model)">news \u2014 xyz universe</span>`
    +`<span style="flex:1"></span>`
    +`<input id="nfilter" placeholder="filter: ticker or text" value="${esc(newsFilter)}" style="width:150px">`
    +`<select id="nsec" data-tip="filter by sector — counts are live over the current 72h window">`
    +`<option value="">all sectors</option>`
    +secOpts.map(([s,n])=>`<option value="${esc(s)}"${newsSec===s?' selected':''}>${esc(secShort(s))} (${n})</option>`).join('')
    +`</select>`
    +['latest','sector'].map(m=>`<button type="button" class="cdtf${newsView===m?' on':''}" data-nv="${m}" data-tip="${m==='latest'?'one reverse-chronological stream':'grouped by sector, sections ordered by newest headline'}">${m==='latest'?'latest':'by sector'}</button>`).join('')
    +['universe','tape','telegram','filings'].map(m=>`<button type="button" class="cdtf${newsMode===m?' on':''}" data-nm="${m}" data-tip="${m==='universe'?'ONLY headlines verified to concern a universe name \u2014 the relevance gate (name match, AI verdict, or a single-name telegram match) has confirmed the attribution; nothing leaks in':m==='tape'?'the consolidated unfiltered feed: Finnhub wire, macro tape, telegram posts, unverified/pending items, off-topic (dimmed) \u2014 all sources interleaved by publish time':m==='telegram'?'telegram posts only \u2014 the channels configured in \u2699, attributed and unattributed alike':'SEC EDGAR filings for the equity universe \u2014 a completely separate lane: regulatory events, not headlines. 7-day window, per-company Atom feeds from sec.gov'}">${m}</button>`).join('')
    +`<span class="cdtf" id="ntg-gear" data-tip="manage telegram channels \u2014 shared for the whole group, saved server-side">\u2699</span>`
    +(d&&d.fetchedAt?`<span class="sec" style="font-size:var(--fs-xs)" data-tip="when the news worker last landed a fetch — per-name refresh rotates every few minutes">fetched ${fmtAge(now-d.fetchedAt)} ago</span>`:'')
    +`</div>`;
  if(!d||!d.items||!d.items.length){
    box.innerHTML=head+`<div class="msg">${d&&d.error?'News feed error: '+esc(d.error)+' \u2014 the server retries on its own cadence.':'No headlines yet \u2014 the rotation is warming up.'}</div>`;
    bindNews(box); return;
  }
  const f=newsFilter.trim().toLowerCase();
  const items=d.items.filter(a=>{
    if(!inLane(a)) return false;
    if(newsMode==='filings'){
      if(newsFl==='mat'&&!a.mat) return false;
      if(newsFl==='own'&&!a.own) return false;
      if(newsFlForm&&a.form!==newsFlForm) return false;
    }
    if(newsSec&&a.sec!==newsSec) return false;
    if(!f) return true;
    return (a.tk&&a.tk.toLowerCase().includes(f))||(a.h&&a.h.toLowerCase().includes(f))||(a.form&&a.form.toLowerCase().includes(f));
  });
  const flChips=newsMode==='filings'?`<div style="display:flex;gap:6px;margin-bottom:8px">${[['mat','material','8-K, 10-K/Q, S-1/S-3, 13D, proxies \u2014 the forms that move marks'],['own','ownership','insider forms: 3/4/5, 144, 13G \u2014 the flow, not the events'],['all','all forms','every filing in the 7d window']].map(([k,l,tip])=>`<button type="button" class="cdtf${newsFl===k?' on':''}" data-nfl="${k}" data-tip="${tip}">${l}</button>`).join('')}${newsFlForm?`<button type="button" class="cdtf on" data-nflform="" data-tip="click to clear the form filter">${esc(newsFlForm)} \u2715</button>`:''}</div>`:'';
  let tgPanel='';
  if(newsTgOpen){
    const chans=tgChans&&tgChans.channels?tgChans.channels:null;
    tgPanel=`<div class="ntg-panel">`
      +`<div class="sec" style="font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.6px;margin-bottom:7px">telegram channels \u2014 shared, saved server-side</div>`
      +(chans===null?`<div class="sec" style="font-size:var(--fs-xs)">loading\u2026</div>`
        :(chans.length?`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">${chans.map(ch=>
          `<span class="ntg-chip">${esc(ch.c)} <b class="${ch.error?'neg':'pos'}" data-tip="${esc(ch.error?ch.error+' \u2014 kept in the list, retried every 10 min':(ch.lastOk?'last fetch '+fmtAge(Date.now()-ch.lastOk)+' ago \u00b7 '+ch.posts+' post(s) parsed':'not fetched yet'))}">\u25cf</b> <i data-rmch="${esc(ch.c)}" style="font-style:normal;cursor:pointer;color:var(--muted)" data-tip="remove this channel for the whole group">\u2715</i></span>`).join('')}</div>`
        :`<div class="sec" style="font-size:var(--fs-xs);margin-bottom:8px">no channels yet \u2014 add a public channel below (its t.me/s/&lt;name&gt; page must load)</div>`))
      +`<div style="display:flex;gap:6px"><input id="ntg-add" placeholder="channel username (t.me/\u2026)" style="flex:1"><button type="button" class="cdtf" id="ntg-addbtn">add</button></div>`
      +`<div class="sec" style="font-size:var(--fs-xs);margin-top:6px">public channels only (reads the t.me preview \u2014 no bot, no credentials) \u00b7 max ${tgChans&&tgChans.max||12} \u00b7 changes apply for the whole group within seconds</div>`
      +`</div>`;
  }
  let body;
  if(!items.length){
    let msg;
    if(newsMode==='telegram') msg=(tgChans&&tgChans.channels&&tgChans.channels.length?'no telegram posts in the last 72h \u2014 the channels are fetched every 10 minutes':'no channels configured \u2014 open \u2699 to add public channels');
    else if(newsMode==='filings'){
      const st=d&&d.flStat;
      if(st&&st.lastErr&&!st.lastOk) msg='EDGAR fetches are failing: '+esc(st.lastErr)+' \u2014 the server retries every minute; if this persists the User-Agent or egress IP is being rejected';
      else if(st&&!st.names) msg='the EDGAR rotation is warming up \u2014 2 names per minute, full roster in ~40 minutes';
      else if(newsFl!=='all') msg='no '+(newsFl==='mat'?'material':'ownership')+' filings in the 7-day window for the covered names \u2014 try \u201call forms\u201d, or note the coverage stamp below';
      else msg='no filings in the 7-day window for the covered names'+(st&&st.names<((st.roster||0))?' \u2014 rotation has covered '+st.names+' of '+st.roster+' names so far':'');
    }
    else msg='nothing matches the filter in the last 72h';
    body=`<div class="msg">${msg}</div>`;
  }
  else if(newsView==='sector'&&newsMode!=='filings'){
    // grouped view: sections keyed by sector (unclassified bucketed), ordered by newest item;
    // reverse-chron inside each — the "what's moving in energy today" reading mode
    const groups=new Map();
    for(const a of items){ const k=a.sec||'unclassified'; if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(a); }
    const ordered=[...groups.entries()].sort((x,y)=>y[1][0].pub-x[1][0].pub);
    body=ordered.map(([s,list])=>
      `<div class="sec nsec-head" style="font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.6px;padding:8px 0 3px" data-tip="${esc(s==='unclassified'?'no sector yet — classification is write-once and catches up on its own cadence':'sections ordered by newest headline; newest first within')}">${esc(secShort(s))} \u00b7 ${list.length} headline${list.length===1?'':'s'} \u00b7 newest ${fmtAge(now-list[0].pub)}</div>`
      +`<div class="nlist">${list.map(a=>newsRow(a,now,false)).join('')}</div>`).join('');
  } else body=`<div class="nlist">${items.map(a=>newsRow(a,now,false)).join('')}</div>`;
  box.innerHTML=head+tgPanel+flChips+body
    +(newsMode==='filings'
      ?`<div class="sec" style="font-size:var(--fs-xs);margin-top:8px">filings live only in this lane \u2014 never mixed into universe/tape/telegram \u00b7 amber form = material \u00b7 ticker click \u2192 drawer \u00b7 form click \u2192 filter \u00b7 source: sec.gov EDGAR \u00b7 7d window${(()=>{const st=d&&d.flStat;if(!st)return'';return st.lastOk?` \u00b7 last EDGAR fetch ${fmtAge(Date.now()-st.lastOk)} ago \u00b7 ${st.names}${st.roster?'/'+st.roster:''} names covered`:(st.lastErr?` \u00b7 <b class=\"neg\">EDGAR: ${esc(st.lastErr)}</b>`:'');})()}</div>`
      :`<div class="sec" style="font-size:var(--fs-xs);margin-top:8px">universe = verified attribution only \u00b7 amber = earnings within 7d \u00b7 red = live signal firing \u00b7 sector: solid = static map, ~ = AI-classified \u00b7 off-topic dimmed in tape \u00b7 72h window</div>`);
  bindNews(box);
}
function bindNews(box){
  const nf=box.querySelector('#nfilter');
  if(nf){ let nfT=null; nf.oninput=()=>{ newsFilter=nf.value; clearTimeout(nfT); nfT=setTimeout(()=>{ renderNews(); const el2=document.getElementById('nfilter'); if(el2){ el2.focus(); el2.setSelectionRange(el2.value.length,el2.value.length); } },120); }; }
  box.querySelectorAll('[data-nm]').forEach(b=>b.onclick=()=>{ newsMode=b.dataset.nm; renderNews(); });
  box.querySelectorAll('[data-nv]').forEach(b=>b.onclick=()=>{ newsView=b.dataset.nv; renderNews(); });
  { const g=box.querySelector('#ntg-gear'); if(g) g.onclick=()=>{ newsTgOpen=!newsTgOpen; if(newsTgOpen) loadTgChannels(); renderNews(); }; }
  { const ab=box.querySelector('#ntg-addbtn'), ai=box.querySelector('#ntg-add');
    const doAdd=()=>{ const v=ai&&ai.value.trim(); if(!v) return; const cur=(tgChans&&tgChans.channels?tgChans.channels.map(c=>c.c):[]); saveTgChannels(cur.concat(v)); };
    if(ab) ab.onclick=doAdd;
    if(ai) ai.onkeydown=(e)=>{ if(e.key==='Enter') doAdd(); }; }
  box.querySelectorAll('[data-rmch]').forEach(b=>b.onclick=()=>{ const cur=(tgChans&&tgChans.channels?tgChans.channels.map(c=>c.c):[]); saveTgChannels(cur.filter(c=>c!==b.dataset.rmch)); });
  { const sel=box.querySelector('#nsec'); if(sel) sel.onchange=()=>{ newsSec=sel.value; renderNews(); }; }
  box.querySelectorAll('.nsec-badge[data-sec]').forEach(b=>b.onclick=()=>{ newsSec=b.dataset.sec; renderNews(); });
  box.querySelectorAll('[data-nfl]').forEach(b=>b.onclick=()=>{ newsFl=b.dataset.nfl; newsFlForm=''; renderNews(); });
  box.querySelectorAll('[data-nflform]').forEach(b=>b.onclick=()=>{ newsFlForm=''; renderNews(); });
  box.querySelectorAll('.nform[data-form]').forEach(b=>b.onclick=()=>{ newsFlForm=b.dataset.form; renderNews(); });
  box.querySelectorAll('.nbadge[data-coin]').forEach(b=>b.onclick=()=>{ const c=b.dataset.coin; if(c) openDetail(c); });
  box.querySelectorAll('.nbadge[data-whale]').forEach(b=>b.onclick=()=>{ const k=b.dataset.whale; showView('funds'); if(k) lazyCall('funds','whlOpenFund',k); });
}
function fillDrawerNews(){
  const box=el('dnews'); if(!box||!state.detail) return;
  const r=state.rows.get(state.detail); if(!r) return;
  if(r.uni==='main'){ box.innerHTML=''; return; }   // news is an xyz-universe feature
  const d=state.news, now=Date.now();
  const T=String(r.ticker||'').toUpperCase();
  const isEq=(a)=>a.tk&&r.ticker&&a.tk.toUpperCase()===T;
  const mine=d&&d.items?d.items.filter(isEq):[];
  // The macro-tape lane (build 2026.07.28-03). It used to be "any name that isn't an Equity gets
  // the raw general tape", which put the same five headlines — a Seagate print, a Medicare item —
  // in the Brazil ETF drawer AND the yen drawer. Honestly labelled and still filler: the one lane
  // in the news pipeline with no relevance gate at all. Now the server declares the lane (r.mlane)
  // and stamps each tape headline with the macro names it is actually news for (a.mtk); the
  // client only reads those decisions. Broad-lane names (the S&P, the VIX, the dollar index) are
  // stamped onto everything because the general tape genuinely IS their news. A name with no lane
  // — every equity, and any macro instrument whose topics aren't seeded — gets no tape at all and
  // says "no headlines", which is the truth.
  const lane=r.mlane||null;
  const pool=(lane&&d&&d.items)?d.items.filter(a=>!a.tk&&!a.pend&&Array.isArray(a.mtk)&&a.mtk.indexOf(T)>=0):[];
  const useTape=!mine.length&&!!lane;
  const list=(mine.length?mine:pool).slice(0,5);
  const scope=lane?(lane.broad?'broad':(lane.label||'scoped')):null;
  const head=mine.length?`News \u2014 last 72h \u00b7 ${Math.min(5,mine.length)} of ${mine.length}`
    :(useTape?`News \u2014 macro tape${lane.broad?'':' \u00b7 '+esc(scope)}`:'News \u2014 last 72h');
  const tip=mine.length?'per-name headlines from the 72h store \u00b7 evicted on publish time'
    :(useTape?(lane.broad
        ?'this instrument tracks the whole tape \u2014 the general macro feed IS its news, ungated by design'
        :'this is a macro instrument with no company feed \u2014 the general tape, gated to headlines that actually name '+scope+'; anything else is not this name\u2019s news and is not shown')
      :'no verified headlines for this name in the last 72h \u2014 coverage refreshes every few minutes');
  let s=`<div class="dsec" data-tip="${esc(tip)}">${head}</div>`;
  if(!d||!d.items){ s+=`<div class="sec" style="font-size:var(--fs-xs)">news feed loading\u2026</div>`; box.innerHTML=s; return; }
  if(!list.length){ s+=`<div class="nrow" style="border-style:dashed;border-width:1px 0"><span class="sec" style="font-size:var(--fs-xs)">no ${useTape?'matching ':''}headlines in the last 72h</span></div>`; }
  else s+=`<div class="nlist">${list.map(a=>newsRow(a,now,true)).join('')}</div>`;
  // Provenance line for the gated lane: how much of the tape survived the gate, and on what. A
  // reader who sees two rows where a neighbouring drawer shows five is entitled to know why.
  if(useTape&&!lane.broad){
    const tot=d.items.filter(a=>!a.tk&&!a.pend).length;
    s+=`<div class="sec" style="font-size:var(--fs-2xs);margin-top:4px" data-tip="${esc('word-boundary matched against: '+(lane.topics||[]).join(', '))}">${pool.length} of ${tot} tape item${tot===1?'':'s'} matched \u00b7 gated on ${esc((lane.topics||[]).slice(0,5).join(', '))}${(lane.topics||[]).length>5?'\u2026':''}</div>`;
  }
  s+=`<div style="display:flex;gap:10px;align-items:center;margin-top:5px"><span id="dnews-all" class="sec" style="cursor:pointer;font-size:var(--fs-xs);text-decoration:underline;text-underline-offset:2px" data-tip="jump to the News tab filtered to this name">all ${esc(r.ticker)} news \u2192</span><span style="flex:1"></span>${d.fetchedAt?`<span class="sec" style="font-size:var(--fs-xs)">fetched ${fmtAge(now-d.fetchedAt)} ago</span>`:''}</div>`;
  box.innerHTML=s;
  const fb=el('dnews-all'); if(fb) fb.onclick=()=>{ newsFilter=String(r.ticker); newsMode='all'; showView('news'); };
}
function fmtAge(ms){ if(ms==null) return ''; const h=ms/3600000; if(h<1) return Math.max(1,Math.round(ms/60000))+'m'; if(h<48) return h.toFixed(h<10?1:0)+'h'; return (h/24).toFixed(1)+'d'; }
function sigRecFullPref(){ try{ return localStorage.getItem('xyz-sigrecfull')==='1'; }catch(_){ return false; } }
function setSigRecFull(v){ try{ localStorage.setItem('xyz-sigrecfull',v?'1':'0'); }catch(_){} renderSignals(); }
// Per-section collapse for the signals stats area (build 2026.07.24-16): every audit subsection
// and the Record-by-event strip render as a collapsed header by default — click to open, state
// persisted per browser. The master audit toggle is unchanged; opening it now reveals a table
// of contents instead of the whole wall. Section content is NOT in the DOM while collapsed —
// nothing is curated away, the headers name everything and one click opens any of it.
const SIGSEC_KEY='xyz-sigsecs';
function sigSecOpen(){ try{ const v=JSON.parse(localStorage.getItem(SIGSEC_KEY)||'null'); return new Set(Array.isArray(v)?v:[]); }catch(_){ return new Set(); } }
function sigSecToggle(id){ const s=sigSecOpen(); if(s.has(id)) s.delete(id); else s.add(id);
  try{ localStorage.setItem(SIGSEC_KEY,JSON.stringify([...s])); }catch(_){} renderSignals(); }
function sigSec(id,cls,label,tip,body){ const open=sigSecOpen().has(id);
  return `<div class="${cls} sigsec-h" data-sigsec="${id}" role="button" tabindex="0" aria-expanded="${open?'true':'false'}" data-tip="${tip} \u00b7 click to ${open?'collapse':'open'}">${open?'\u25be':'\u25b8'} ${label}</div>`+(open?body:''); }
function sigViewPref(){ try{ return localStorage.getItem('xyz-sigview')||'detail'; }catch(_){ return 'detail'; } }
function sigPrimePref(){ try{ return localStorage.getItem('xyz-sigprime')==='1'; }catch(_){ return false; } }
function setSigPrime(v){ try{ localStorage.setItem('xyz-sigprime',v?'1':'0'); }catch(_){} renderSignals(); }
function sigMovePref(){ try{ return +localStorage.getItem('xyz-sigmove')||0; }catch(_){ return 0; } }
function setSigMove(v){ try{ localStorage.setItem('xyz-sigmove',String(v)); }catch(_){} renderSignals(); }
// Actionable magnitude of a signal: distance from the live mark to its playbook target, in %.
// Signals with no computable target (context flags, funding drift) have no magnitude — a
// statistically fine setup with nothing to reach for is not hand-tradeable by this definition.
function sigMove(g){
  const p=g.play, r=state.rows.get(g.coin);
  if(!p||p.target==null||!r||!(r.px>0)) return null;
  return Math.abs(p.target/r.px-1)*100;
}
function setSigView(v){ try{ localStorage.setItem('xyz-sigview',v); }catch(_){} renderSignals(); }
const sigExpanded=new Set();   // coins expanded inline while in compact mode (session-only)
function trigChip(g){
  if(g.t0==null) return '';
  const c=g.claim0, merged=c&&c.t!=null&&Math.abs(c.t-g.t0)<=90000;   // presence stamp == claim stamp (fired fresh): one chip carrying the price
  const baseTip=`condition present since ${new Date(g.t0).toLocaleString()} (your local time) \u2014 this stamp tracks the CURRENT episode and resets whenever the condition lapses for a build`
    +(g.sinceBoot?' \u00b7 \u27f2 stamped on the first build after a restart/deploy without a saved presence timeline, so the condition may predate it':'')
    +(g.decayed?' \u00b7 the open CLAIM has outlived its horizon: score decayed (\u00d70.6), drops entirely at 2\u00d7':'');
  if(merged){
    const left=c.resolveAt!=null?c.resolveAt-Date.now():null;
    const tip=baseTip+` \u00b7 claim opened at ${c.px!=null?fmtPrice(c.px):'\u2014'}${c.boot?' on the first build after a restart/deploy (\u27f2)':''} \u2014 the outcome is measured from this mark${left!=null&&left>0?` \u00b7 resolves in ${fmtAge(left)}`:' \u00b7 resolution due'}`;
    return `<span class="sig-age${g.decayed?' dk':''}" data-tip="${esc(tip)}">${g.decayed?'\u29d6 ':''}${fmtTrig(g.t0)}${g.age!=null?' \u00b7 '+fmtAge(g.age)+' ago':''}${c.px!=null?' @ '+fmtPrice(c.px):''}${(g.sinceBoot||c.boot)?' \u27f2':''}${g.decayed?' \u00b7 decaying':''}</span>`
      +nowChip(g.coin,c,{scored:g.scored});
  }
  // -29: the claim's fire mark rides the presence chip UNCONDITIONALLY. It used to appear only
  // on the merged branch (presence stamp == claim stamp), so the moment an episode aged and the
  // two diverged, the one price every outcome is measured from silently vanished from the card.
  const atPx=c&&c.px!=null?` <span class="sec">@ ${fmtPrice(c.px)}</span>`:(c?' <span class="na">@ \u2014</span>':'');
  let s=`<span class="sig-age${g.decayed?' dk':''}" data-tip="${esc(baseTip+(c&&c.px!=null?` \u00b7 the LEDGER CLAIM behind it opened ${new Date(c.t).toLocaleString()} at ${fmtPrice(c.px)}; the outcome is measured from that mark, never from the live price`:''))}">${g.decayed?'\u29d6 ':''}${fmtTrig(g.t0)}${g.age!=null?' \u00b7 '+fmtAge(g.age)+' ago':''}${atPx}${g.sinceBoot?' \u27f2':''}${g.decayed?' \u00b7 decaying':''}</span>`
    +nowChip(g.coin,c,{scored:g.scored});
  if(c&&c.t!=null){
    const left=c.resolveAt!=null?c.resolveAt-Date.now():null;
    const tip=`the LEDGER CLAIM this signal is scored against: opened ${new Date(c.t).toLocaleString()} at ${c.px!=null?fmtPrice(c.px):'\u2014'}${c.boot?' \u2014 \u27f2 on the first build after a restart/deploy (the condition may predate the stamp)':''}. One episode carries ONE claim even if the condition lapses and returns, so the claim can be older than the condition you are looking at \u2014 the outcome is measured from the claim's own mark and time.${left!=null?(left>0?` Resolves in ${fmtAge(left)}.`:' Resolution due.'):''}`;
    s+=`<span class="sig-age" data-tip="${esc(tip)}">claim ${fmtTrig(c.t)} @ ${c.px!=null?fmtPrice(c.px):'\u2014'}${c.boot?' \u27f2':''}</span>`;
  }
  return s;
}
function sigCardHtml(gr, rank, collapsible){
  // Card anatomy, one visual grammar per line (build -67): header = rank/ticker/side/score;
  // per condition: [event chip | reading ......... age/claim meta], then the evidence line in
  // one fixed grammar (scope \u00b7 n \u00b7 med \u00b7 hit \u00b7 exp \u00b7 horizon, flags as uniform pills),
  // then the play line (side \u00b7 target \u00b7 void \u00b7 R/R), then watch on its own truncated line.
  // The ticker never repeats inside its own card; timestamps live at the line's right edge.
  const top=gr.sigs[0], hsd=SP_SIDE[(top.claim0&&top.claim0.side)||(top.play&&top.play.side)||'watch']||SP_SIDE.watch;
  let s=`<div class="sigcard${gr.sigs.length>1?' conf':''}${gr.sigs.some(x=>x.prime)?' prime':''}"${collapsible?` data-coll="${esc(gr.coin)}"`:''}>`;
  s+=`<div class="sigcard-h"${collapsible?' style="cursor:pointer" data-tip="click to collapse back to the compact row"':''}><span class="sig-rank">${rank}</span>`
    +(collapsible?`<span class="sig-caret">\u25be</span>`:'')
    +`<b class="sig-tick" data-coin="${esc(gr.coin)}">${esc(gr.ticker)}</b>`
    +`<b class="sp-side ${hsd.c}" data-tip="${esc('top condition: '+((top.play&&top.play.bias)||hsd.tip))}">${hsd.t}</b>`
    +(gr.sigs.length>1?`<span class="sig-conf" data-tip="confluence: ${gr.sigs.length} independent conditions firing on the same name \u2014 each condition's score gets a confluence bonus because agreement is itself the signal">${gr.sigs.length} conditions</span>`:'')
    +`<span class="sig-score" data-tip="best condition's score: unusualness + historical edge + confluence bonus, 0\u2013100"><span class="sig-bar"><span style="width:${Math.min(100,gr.score)}%"></span></span>${gr.score}</span></div>`;
  for(const g of gr.sigs){
    const ownOk = g.study && g.study.n>=8;
    const U = (st)=>st&&st.unit==='R'?'R':'%';   // R = sigma units (outcome / the market's own vol at event time) \u2014 apples-to-apples across names
    const exp = (st)=>st&&st.avg!=null?` \u00b7 <span data-tip="expectancy: the MEAN direction-signed outcome per event \u2014 hit rate and payoff sizes folded into one number. ${st.unit==='R'?'Measured in R (sigma units \u2014 the outcome divided by the market\u2019s own volatility at event time), so it compares fairly across quiet and wild names and pools cleanly. ':''}This, not the R/R screen, is what decides whether the setup pays over many occurrences.">exp <b class="${st.avg>=0?'pos':'neg'}">${st.avg>=0?'+':''}${st.avg}${U(st)}</b>/ev</span>`:'';
    // medNet: the same median after the funding a 1x position paid over the horizon (only where the
    // hourly funding history covered the events) — the number a perp holder actually keeps.
    const net = (st)=>st&&st.medNet!=null&&st.medNet!==st.med?` <span class="sec" data-tip="median outcome net of the funding a 1x position paid (or received) over the horizon, signed with the event direction — the gross median beside it ignores the carry">net <b class="${st.medNet>=0?'pos':'neg'}">${st.medNet>=0?'+':''}${st.medNet}${U(st)}</b></span>`:'';
    const stLine=(st,scope)=>`<i class="sig-scope">${scope}</i> n=${st.n} \u00b7 med <b class="${st.med>=0?'pos':'neg'}">${st.med>=0?'+':''}${st.med}${U(st)}</b>${net(st)} \u00b7 ${Math.round(st.hit*100)}% hit${exp(st)} \u00b7 ${esc(g.horizon||'')}`;
    // Overnight split (ondrift only): how much of this name's overnight move is priced in the
    // after-hours leg (close → 08:30 ET) versus the pre-open half hour (08:30 → 09:30 ET).
    const split = g.ev==='ondrift'&&g.split&&g.split.n>=5
      ? ` \u00b7 <span class="sec" data-tip="overnight split over ${g.split.n} closed windows: median after-hours leg (cash close \u2192 08:30 ET) ${g.split.medAh>=0?'+':''}${g.split.medAh}%, median pre-open leg (08:30 \u2192 09:30 ET) ${g.split.medPre>=0?'+':''}${g.split.medPre}%; ${Math.round((g.split.shareAh||0)*100)}% of the absolute overnight move lands before 08:30.${g.split.approx?' Some anchors resolved on hourly closes (5m archive incomplete) \u2014 the 09:30 leg then reads the 09:00 close.':''}">split AH ${g.split.medAh>=0?'+':''}${g.split.medAh}% / pre ${g.split.medPre>=0?'+':''}${g.split.medPre}% \u00b7 ${Math.round((g.split.shareAh||0)*100)}% before 08:30${g.split.approx?' \u2248':''}</span>`
      : '';
    const hist = ownOk
      ? stLine(g.study,'own base rate')
      : (g.pooled
        ? `${g.study?`own n=${g.study.n} \u00b7 `:''}${stLine(g.pooled,'class-pooled')}`
        : (g.study
          ? stLine(g.study,'own \u00b7 thin')
          : `${esc(g.horizon||'no historical study yet')}`))+split;
    const flags=(g.unproven&&!g.pooled?' <i class="sig-unp" data-tip="fewer than 8 historical occurrences and no usable pooled sample \u2014 a flag, not an edge">unproven</i>':'')
      +(g.negexp?' <i class="sig-unp bad" data-tip="this base rate has NEGATIVE expectancy \u2014 past occurrences of this event lost money on average under its own sign convention. Evidence score zeroed; shown for awareness, ranked as noise.">neg exp</i>':'')
      +(g.noedge?' <i class="sig-unp bad" data-tip="the LIVE out-of-sample record for this event type shows no edge (\u226510 resolved, <50% hit) \u2014 evidence score capped">no live edge</i>':'')
      +(g.earn?` <i class="sig-unp warn" data-tip="earnings ${g.earn.prox===0?'TODAY':'tomorrow'} (${esc(g.earn.s)} ${esc(g.earn.d)}, ET) \u2014 a known binary catalyst inside this claim's horizon. The base rate wasn't sampled around scheduled prints, so this is a stated PRIOR, not measured expectancy: evidence contribution capped at 8 (same mechanism as the no-live-edge guard), prime disabled. Condition intensity untouched.">earnings ${g.earn.prox===0?'today':'\u22641d'}</i>`:'')
      +(g.mac?` <i class="sig-unp" style="color:var(--blue)" data-tip="${esc(g.mac.label)} ${g.mac.prox===0?'TODAY':'tomorrow'} (${esc(g.mac.d)}, ${esc(g.mac.tEt)} ET) \u2014 a universe-wide scheduled binary inside this claim's horizon, on crypto exactly as on equities. ${g.macguard?'Evidence contribution capped at 8 (same mechanism and cap as the earnings guard).':'Evidence already capped by the earnings guard \u2014 one binary ahead or two, the borrowed confidence is trimmed once.'} Condition intensity untouched.">\u25c6 ${esc(g.mac.k.toLowerCase())} ${g.mac.prox===0?'today':'\u22641d'}</i>`:'');
    s+=`<div class="sig${g.prime?' prime':''}">`
      +`<span class="sig-chip" data-tip="${esc(EV_TIP[g.ev]||g.label)}">${esc(g.label)}</span>`
      +`<span class="sig-line1">${g.prime?'<i class="sig-prime" data-tip="prime setup: \u226560% hit, positive expectancy, sound structure (R/R \u22651.2 where levels exist), not unproven/decayed/no-edge \u2014 the bars this signal clears to earn emphasis">\u2605 prime</i>':''}<span class="sig-read">${esc(g.reading)}</span>`
      +`<span class="sig-meta">${g.confl?`<span class="sig-chip bad" data-tip="${esc(`conflicting signals \u00b7 a long-side and a short-side event are BOTH live on this name${(g.conflWith&&g.conflWith.length)?` \u00b7 opposing: ${g.conflWith.map(o=>`${o.label} (${(o.side||'').toUpperCase()}, score ${o.score})`).join('; ')} \u2014 the counterpart may rank below the visible list or be hidden by your filters; the conflict stands because both are live and both claims are on the books`:''} \u00b7 no confluence bonus is granted amid contradiction \u00b7 each claim resolves independently on its own record \u2014 the ledger, not the dashboard, decides which side was right`)}">\u21c4 conflict</span>`:''}${trigChip(g)}</span></span>`
      +`<span class="sig-hist" data-tip="${esc((ownOk?'own base rate \u00b7 this market\u2019s median forward outcome and hit share across past occurrences, over the stated horizon':(g.pooled?'pooled base rate \u00b7 fewer than 8 occurrences on this market, so evidence pools across every market in its asset class \u00b7 broader sample, applied at a 30% score discount':EV_TIP[g.ev]||''))+(g.liveW?` \u00b7 evidence is Bayesian-blended with the live out-of-sample record at ${g.liveW}% weight \u2014 the weight grows with the number of independent tape-days those resolutions fell on (not the raw claim count \u2014 forty firings into one green day are one draw), and the live record it blends toward weights recent resolutions most (a decayed edge fades from the score over a quarter), so trust migrates from backtest to reality at the pace real independent evidence accrues`:''))}">${hist}${flags}</span>`
      +(g.play?playRow(g):'')
      +`</div>`;
  }
  return s+'</div>';
}
function sigRowHtml(gr, rank){
  const top=gr.sigs[0], sd=SP_SIDE[(top.claim0&&top.claim0.side)||(top.play&&top.play.side)||'watch']||SP_SIDE.watch;
  const chips=gr.sigs.map(g=>{
    const cu=(st)=>st&&st.unit==='R'?'R':'%';
    const hist=g.study&&g.study.n>=8?` \u00b7 on ${g.ticker} (n=${g.study.n}): med ${g.study.med>=0?'+':''}${g.study.med}${cu(g.study)}, ${Math.round(g.study.hit*100)}% hit`
      :(g.pooled?` \u00b7 pooled (n=${g.pooled.n}): med ${g.pooled.med>=0?'+':''}${g.pooled.med}${cu(g.pooled)}, ${Math.round(g.pooled.hit*100)}% hit`:'');
    return `<span class="sig-chip" data-tip="${esc(g.reading+hist+(g.play&&g.play.bias?` \u00b7 play: ${g.play.bias}`:'')+(g.earn?` \u00b7 earnings ${g.earn.prox===0?'TODAY':'tomorrow'} (${g.earn.s})`:'')+(g.mac?` \u00b7 ${g.mac.label} ${g.mac.prox===0?'TODAY':'tomorrow'} (${g.mac.tEt} ET)`:''))}">${esc(g.label)}${g.noedge||g.earn?' \u26a0':''}${g.mac?' \u25c6':''}</span>`;
  }).join('');
  const anyPrime=gr.sigs.some(x=>x.prime);
  return `<div class="sigc${anyPrime?' prime':''}" data-exp="${esc(gr.coin)}" data-tip="click to expand the full card \u2014 readings, base rates, playbook">`
    +`<span class="sig-rank">${rank}</span><span class="sig-caret">\u25b8</span>`
    +`<b class="sig-tick" data-coin="${esc(gr.coin)}">${esc(gr.ticker)}</b>`
    +`<b class="sp-side ${sd.c}" data-tip="${esc('top condition: '+((top.play&&top.play.bias)||sd.tip))}">${sd.t}</b>`
    +chips+trigChip(top)
    +`<span class="sig-score" data-tip="best condition's score + confluence bonus, 0\u2013100"><span class="sig-bar"><span style="width:${Math.min(100,gr.score)}%"></span></span>${gr.score}</span>`
    +`</div>`;
}
// Accuracy panel below the list: overall record + per-event claimed-vs-live table + last resolutions.
// Cumulative-R claim curve with the shared crosshair/readout (standing rule: every chart hovers).
// Hidden for now — flip SHOW_CLAIM_CURVE to true to bring the section back; all code stays intact.
const SHOW_CLAIM_CURVE=false;
function recCurveSvg(curve){
  const W=430,H=120, pl=4,pr=44,pt=8,pb=16;
  let lo=0,hi=0; for(const p of curve){ if(p[1]<lo)lo=p[1]; if(p[1]>hi)hi=p[1]; if(p[5]!=null){ if(p[5]<lo)lo=p[5]; if(p[5]>hi)hi=p[5]; } }
  if(hi===lo) hi=lo+1;
  const pad=(hi-lo)*0.08; hi+=pad; lo-=pad;
  const n=curve.length, X=i=>pl+(n<2?0.5:i/(n-1))*(W-pl-pr), Y=v=>pt+(1-(v-lo)/(hi-lo))*(H-pt-pb);
  let s='';
  for(const v of lcTicks(lo,hi,3)){ const y=Y(v).toFixed(1);
    s+=`<line x1="${pl}" y1="${y}" x2="${W-pr}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`+
       `<text x="${W-pr+5}" y="${(+y+3).toFixed(1)}" class="lc-tick">${v.toFixed(1)}R</text>`; }
  if(lo<0&&hi>0) s+=`<line x1="${pl}" y1="${Y(0).toFixed(1)}" x2="${W-pr}" y2="${Y(0).toFixed(1)}" stroke="var(--faint)" stroke-width="1" stroke-dasharray="3 3"/>`;
  let dpath=''; curve.forEach((p,i)=>dpath+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(p[1]).toFixed(1)+' ');
  const last=curve[curve.length-1][1];
  const hasS=curve.some(p=>p[5]!=null);
  if(hasS){ let sp=''; curve.forEach((p,i)=>sp+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(p[5]!=null?p[5]:p[1]).toFixed(1)+' ');
    s+=`<path d="${sp}" fill="none" stroke="var(--blue)" stroke-width="1.3" stroke-dasharray="4 3" opacity="0.9"/>`; }
  s+=`<path d="${dpath}" fill="none" stroke="${last>=0?'var(--up)':'var(--down)'}" stroke-width="1.6"/>`;
  const dfmt=t=>{ const x=new Date(t); return (x.getMonth()+1)+'/'+x.getDate(); };
  s+=`<text x="${pl}" y="${H-4}" class="lc-tick">${dfmt(curve[0][0])}</text>`;
  s+=`<text x="${W-pr}" y="${H-4}" text-anchor="end" class="lc-tick">${dfmt(curve[n-1][0])}</text>`;
  const xs=curve.map((_,i)=>X(i));
  const rows=curve.map(p=>`<b style="color:var(--text)">${esc(p[2])}</b> \u00b7 ${esc(EV_LABELS[p[3]]||p[3])}${p[7]?' \u00b7 <span style="color:var(--accent)">\u26d4 stopped</span>':''}<br>${dfmt(p[0])}: at-horizon <span style="color:${p[4]>=0?'var(--up)':'var(--down)'}">${p[4]>=0?'+':''}${p[4]}R</span> \u2192 cum ${p[1]>=0?'+':''}${p[1]}R${p[5]!=null?`<br>stop-aware ${p[6]>=0?'+':''}${p[6]}R \u2192 cum ${p[5]>=0?'+':''}${p[5]}R`:''}`);
  return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});
}
function ledgerRosterScoped(){
  // The roster of events that CAN ledger a claim in the active scope — it drives the "awaiting
  // first claim" entries, so a wrong answer here reads as either a lie ("awaiting" for an event
  // this universe never runs) or a silent omission (a live event missing from its own record
  // strip). Mirrors the server's MAIN_EVS / XYZ_ONLY_EVS split exactly; the suite pins both
  // lists against each other so they cannot drift apart.
  if(state.scope==='crypto')
    return ['bigmove','breakout','breakdown','fundflip','oiflush','fpdiv','tretest','tretestdn','casc','fundext'];
  return ['bigmove','breakout','breakdown','gap','fundflip','squeeze','unwind','oiflush','fpdiv','prem','ondrift','tretest','tretestdn'];
}
// Record sets ship keyed by universe ('m' = crypto/main, 'x' = xyz). One helper so every consumer
// reads the same set for the active scope — the -101 client hardcoded 'x' in two places, which
// would now silently show the equity record under a crypto board.
const MAIN_ONLY_EV=new Set(['casc','fundext']);   // mirrors the server's MAIN_ONLY_EVS
function sigRecKey(thr,pr){ return String(thr)+(pr?'p':'')+(state.scope==='crypto'?'m':'x'); }
function sigRecordHtml(d){
  const thr=sigMovePref(), pr=sigPrimePref();
  const rs=(d&&d.records&&(d.records[sigRecKey(thr,pr)]||d.records[String(thr)+(pr?'p':'')]))||d||{};
  const rc=rs.record||{};
  const evs=Object.keys(rc);
  let fired=0,resolved=0,wins=0,open=0,nS=0,winsS=0;
  for(const ev of evs){ const r=rc[ev]; resolved+=r.resolved||0; open+=r.open||0; wins+=Math.round((r.hit||0)*(r.resolved||0));
    nS+=r.nS||0; winsS+=Math.round((r.hitS||0)*(r.nS||0)); }
  fired=resolved+open;
  const recOpen=sigRecFullPref();
  // The audit block (per-event table, calibration, self-tuning, recent resolutions) is
  // retrospective \u2014 collapsed by default behind this header, which carries the headline
  // numbers either way. Opened, it reveals per-section collapsed headers (build -16), not the
  // whole wall; the "Record by event" strip below is likewise a collapsed header by default.
  let s=`<div class="dsec sigrec-tgl" data-recx style="margin-top:22px;cursor:pointer" data-tip="out-of-sample accuracy \u00b7 every fired signal is ledgered at its mark and resolved at its stated horizon under the study\u2019s own sign convention \u00b7 this section is what actually happened after the engine spoke \u2014 the record it must answer to \u00b7 click to ${recOpen?'collapse':'expand the full audit: per-event table, calibration, self-tuning, recent resolutions'}">${recOpen?'\u25be':'\u25b8'} Signal accuracy \u2014 live track record${thr>0||pr?` <span class="sec" style="text-transform:none;letter-spacing:0">\u00b7 ${pr?'\u2605 prime':''}${pr&&thr>0?' \u00b7 ':''}${thr>0?'move \u2265'+thr+'%':''} claims only</span>`:''}</div>`;
  if(!fired){
    // no early return: the awaiting roster, strategy shadows and self-tuning variants must
    // render even on a zero record — "never fired" is a fact the panel states, not a blank
    // screen. This exact blank shipped the day the crypto universe joined the engine with an
    // honestly-empty record and the whole audit vanished below this line.
    s+=`<div class="sec" style="font-size:var(--fs-xs);padding:4px 2px">No claims resolved yet \u2014 the record accrues from the signals this universe fires. First resolutions land at their horizons (12h\u20135d).</div>`;
  }
  const hitAll=resolved?Math.round(100*wins/resolved):null;
  if(fired) s+=`<div class="sigrec-top">`
    +`<span data-tip="every distinct (market, event) claim ledgered since launch">fired <b>${fired}</b></span>`
    +`<span data-tip="claims that reached their horizon and were scored">resolved <b>${resolved}</b></span>`
    +`<span data-tip="claims still inside their horizon, awaiting resolution">open <b>${open}</b></span>`
    +(hitAll!=null&&resolved?`<span data-tip="AT-HORIZON track: share of resolved claims that moved the way the signal implied, held to the stated horizon with NO stop \u2014 this is what the studies claim and what the engine learns from"><b class="${hitAll>=50?'pos':'neg'}">${hitAll}%</b> at-horizon hit</span>`:'')
    +(nS?`<span data-tip="stop-aware record \u00b7 same claims, but the outcome is capped at the void level when it was touched before horizon \u00b7 what trading the playbook with its void as a hard stop would have done \u00b7 covers claims resolved since stop-tracking began \u2014 older claims carry no frozen void, so n trails the resolved total"><b class="${Math.round(100*winsS/nS)>=50?'pos':'neg'}">${Math.round(100*winsS/nS)}%</b> stop-aware <i style="font-style:normal;color:var(--faint)">(n=${nS})</i></span>`:'')
    +`</div>`;
  if(!recOpen) return s;   // collapsed: header + headline totals only; the strip above is the summary
  {   // always render the by-event section when expanded: with zero resolved it is the roster
      // itself — open-only rows plus explicit awaits ("never fired" vs "not wired", stated)
    let evt='<table class="sigrec-t"><thead><tr><th>event</th><th data-tip="resolved / still open">n</th><th data-tip="share of resolved claims that resolved positive under the event\u2019s sign convention">live hit</th><th data-tip="median realized outcome across resolved claims">live med</th><th data-tip="profit factor: gross wins \u00f7 gross losses across resolved claims. >1 = the winners outweigh the losers in size, not just count \u2014 hover for the average win vs average loss">pf</th><th data-tip="average of the in-sample medians claimed at fire time \u2014 compare against live med: this is the honesty gap">claimed</th><th class="ss" data-tip="stop-aware hit \u00b7 outcomes capped at the void when touched before horizon \u00b7 covers claims resolved since stop-tracking began (build -22) \u2014 n can trail the live column\u2019s">stop hit</th><th class="ss" data-tip="stop-aware median realized">stop med</th><th class="ss" data-tip="stop-aware profit factor \u2014 hover the row\u2019s stop hit for how many claims were stopped out">stop pf</th><th class="ss" data-tip="bracket track \u2014 outcomes capped at whichever frozen level (target OR void) was touched FIRST; the symmetric fix to the stop-only cap, which let a target touch evaporate by horizon and biased records downward on slow setups. Covers claims resolved since build -20 carrying both levels \u2014 n trails. Hover for the touch split.">tch hit</th><th class="ss" data-tip="bracket-track median realized">tch med</th><th class="ss" data-tip="bracket-track profit factor">tch pf</th><th></th></tr></thead><tbody>';
    for(const ev of [...evs].sort((a,b)=>((rc[b].resolved||0)-(rc[a].resolved||0))||((rc[b].open||0)-(rc[a].open||0)))){ const r=rc[ev]; if(!r.resolved&&!r.open) continue;
      const bad=r.resolved>=10&&r.hit<0.5&&r.med<=0, good=r.resolved>=10&&r.hit>=0.55&&r.med>0;
      evt+=`<tr><td>${esc(EV_LABELS[ev]||ev)}</td><td>${r.resolved}${r.open?` <span class="sec">/${r.open}</span>`:''}</td>`
        +`<td>${r.hit!=null?`<span class="${r.hit>=0.5?'pos':'neg'}">${Math.round(r.hit*100)}%</span>`:'\u2014'}</td>`
        +`<td>${r.med!=null?`<span class="${r.med>=0?'pos':'neg'}">${r.med>=0?'+':''}${r.med}${r.unit}</span>`:'\u2014'}</td>`
        +`<td>${r.pf!=null?`<span class="${r.pf>=1?'pos':'neg'}" data-tip="${esc(`avg win ${r.avgWin!=null?'+'+r.avgWin+r.unit:'\u2014'} vs avg loss ${r.avgLoss!=null?r.avgLoss+r.unit:'\u2014'}`)}">${r.pf}</span>`:'\u2014'}</td>`
        +`<td>${r.claimMed!=null?`${r.claimMed>=0?'+':''}${r.claimMed}${r.unit}`:'\u2014'}</td>`
        +`<td class="ss">${r.nS?`<span class="${r.hitS>=0.5?'pos':'neg'}" data-tip="${esc(`${EV_LABELS[ev]||ev} \u2014 stop-aware hit (n=${r.nS}) \u00b7 share of stop-disciplined outcomes that resolved positive \u00b7 stopped en route: ${r.stopped||0} of ${r.nS} (${Math.round(100*(r.stopped||0)/r.nS)}%) \u2014 separate fact: a claim can lose at horizon without ever touching its void \u00b7 n trails the live column when claims predate stop-tracking (no frozen void on older claims)`)}">${Math.round(r.hitS*100)}% <i style="font-style:normal;color:var(--faint);font-size:var(--fs-2xs)">(n=${r.nS})</i></span>`:'\u2014'}</td>`
        +`<td class="ss">${r.medS!=null?`<span class="${r.medS>=0?'pos':'neg'}">${r.medS>=0?'+':''}${r.medS}${r.unit}</span>`:'\u2014'}</td>`
        +`<td class="ss">${r.pfS!=null?`<span class="${r.pfS>=1?'pos':'neg'}">${r.pfS}</span>`:'\u2014'}</td>`
        +`<td class="ss">${r.nB?`<span class="${r.hitB>=0.5?'pos':'neg'}" data-tip="${esc(`${EV_LABELS[ev]||ev} \u2014 bracket hit (n=${r.nB}) \u00b7 first-touch resolution across BOTH frozen levels \u00b7 target touched first: ${r.tchT||0} \u00b7 void touched first: ${r.tchS||0} \u00b7 neither (at-horizon): ${r.tchM||0}`)}">${Math.round(r.hitB*100)}% <i style="font-style:normal;color:var(--faint);font-size:var(--fs-2xs)">(n=${r.nB})</i></span>`:'\u2014'}</td>`
        +`<td class="ss">${r.medB!=null?`<span class="${r.medB>=0?'pos':'neg'}">${r.medB>=0?'+':''}${r.medB}${r.unit}</span>`:'\u2014'}</td>`
        +`<td class="ss">${r.pfB!=null?`<span class="${r.pfB>=1?'pos':'neg'}">${r.pfB}</span>`:'\u2014'}</td>`
        +`<td>${bad?'<i class="sig-unp" style="color:var(--down);border-color:var(--down)">no live edge</i>':(good?'<i class="sig-unp" style="color:var(--up);border-color:var(--up)">confirmed</i>':'')}</td></tr>`;
    }
    // roster members with zero claims: an explicit greyed row, so the roster is always the
    // full roster — "never fired" reads as a fact, not an omission
    for(const ev of ledgerRosterScoped()){ if(rc[ev]) continue;
      evt+=`<tr class="await" data-tip="${esc(`in the ledger roster \u2014 no claim has fired yet under the current gates${ev==='tretest'||ev==='tretestdn'?' \u00b7 stocks/macro universe only: crypto retests never ledger; the next RETEST badge on the stocks Trend board opens the first claim':''}`)}"><td>${esc(EV_LABELS[ev]||ev)}</td><td>0</td><td colspan="10">awaiting first claim</td><td></td></tr>`;
    }
    evt+='</tbody></table>';
    s+=sigSec('evtable','sigrec-sub','by event','claimed-vs-live per event type \u2014 the honesty gap, with the stop-aware parallel track',evt);
  }
  const rx=rs.recordX;
  let sl='', cv='';
  if(rx){
    if(rx.buckets&&rx.buckets.some(b=>b.n>0)){
      sl+=`<div class="sigrec-xr"><span class="sigrec-k" data-tip="calibration: does the score at fire time actually rank outcomes? If higher buckets don't hit more often, the scoring \u2014 not the events \u2014 needs work.">calibration</span>`;
      for(const b of rx.buckets) sl+=`<span class="sigrec-chip" data-tip="claims fired with score ${esc(b.k)}: ${b.n} resolved">score ${esc(b.k)}: ${b.hit!=null?`<b class="${b.hit>=0.5?'pos':'neg'}">${Math.round(b.hit*100)}%</b>`:'\u2014'} <i>(n=${b.n})</i></span>`;
      s+='</div>';
    }
    if(rx.side&&(rx.side.long.n||rx.side.short.n)){
      sl+=`<div class="sigrec-xr"><span class="sigrec-k" data-tip="resolved claims split by implied direction \u2014 a persistent gap here means the engine reads one side of the tape better than the other">by side</span>`
        +`<span class="sigrec-chip">longs ${rx.side.long.hit!=null?`<b class="${rx.side.long.hit>=0.5?'pos':'neg'}">${Math.round(rx.side.long.hit*100)}%</b>`:'\u2014'} <i>(n=${rx.side.long.n})</i></span>`
        +`<span class="sigrec-chip">shorts ${rx.side.short.hit!=null?`<b class="${rx.side.short.hit>=0.5?'pos':'neg'}">${Math.round(rx.side.short.hit*100)}%</b>`:'\u2014'} <i>(n=${rx.side.short.n})</i></span></div>`;
    }
    if(rx.form&&rx.form.recentN>=10){
      const f=rx.form, up=f.recentHit>=f.allHit;
      sl+=`<div class="sigrec-xr"><span class="sigrec-k" data-tip="recent form vs all-time \u2014 is the engine improving as the blend and caps kick in, or degrading with the regime?">form</span>`
        +`<span class="sigrec-chip">last ${f.recentN}: <b class="${f.recentHit>=0.5?'pos':'neg'}">${Math.round(f.recentHit*100)}%</b> ${up?'\u2197':'\u2198'} vs all-time ${Math.round(f.allHit*100)}% <i>(n=${f.allN})</i></span></div>`;
    }
    if(rx.tickers){
      const chip=(x)=>`<span class="sigrec-chip" data-tip="${x.n} resolved claims on ${esc(x.t)}">${esc(x.t)} <b class="${x.hit>=0.5?'pos':'neg'}">${Math.round(x.hit*100)}%</b> <i>(n=${x.n})</i></span>`;
      sl+=`<div class="sigrec-xr"><span class="sigrec-k" data-tip="which markets this engine actually reads well (\u22655 resolutions each) \u2014 signal quality is not uniform across the universe">reads best</span>${rx.tickers.best.map(chip).join('')}`
        +`<span class="sigrec-k" style="margin-left:14px">worst</span>${rx.tickers.worst.map(chip).join('')}</div>`;
    }
    if(SHOW_CLAIM_CURVE&&rx.curve&&rx.curve.length>=5) cv=recCurveSvg(rx.curve);
  }
  if(rs.confluence&&(rs.confluence.confN||rs.confluence.soloN)){
    const c=rs.confluence;
    sl+=`<div class="sigrec-xr"><span class="sigrec-k" data-tip="Does agreement actually help? Resolved claims split by whether they fired WITH other conditions on the same name or alone. Once both sides have 15+ resolutions, the confluence score bonus scales to this measured lift \u2014 and drops to zero if agreement doesn't prove out.">confluence</span>`
      +`<span class="sigrec-chip">with company ${c.confN&&c.confHit!=null?`<b class="${c.confHit>=(c.soloHit||0)?'pos':'neg'}">${Math.round(c.confHit*100)}%</b>`:'\u2014'} <i>(n=${c.confN||0})</i></span>`
      +`<span class="sigrec-chip">solo ${c.soloN&&c.soloHit!=null?`<b>${Math.round(c.soloHit*100)}%</b>`:'\u2014'} <i>(n=${c.soloN||0})</i></span>`
      +`<span class="sigrec-chip" data-tip="${c.confN>=15&&c.soloN>=15?'earned from the measured lift':'default until 15+ resolutions per side'}">bonus <b>${c.confN>=15&&c.soloN>=15?c.bonus:8}</b>/condition</span></div>`;
  }
  if(sl) s+=sigSec('slices','sigrec-sub','slices','the record cut along the axes that matter \u2014 calibration, by side, form, reads best, confluence \u00b7 does the score rank outcomes, does the engine read one side better, is form improving',sl);
  if(cv) s+=sigSec('curve','sigrec-sub','claim equity curve (R) \u2014 solid: at-horizon \u00b7 dashed: stop-aware','cumulative R curve \u00b7 equal-weight running sum of every resolved R-united claim in fired order \u00b7 hover for the claim behind each step',cv);
  if(d&&d.variants&&d.variants.length){
    let tun='';
    for(const v of d.variants){
      tun+=`<div class="sigrec-xr"><span class="sigrec-k" data-tip="${esc('trigger parameter: '+v.param+' \u2014 live signals currently fire at '+v.param+v.cur)}">${esc(EV_LABELS[v.ev]||v.ev)}</span>`;
      for(const x of v.vals){
        tun+=`<span class="sigrec-chip${x.inc?' inc':''}" data-tip="${esc(`${v.param}${x.v} \u2014 ${x.inc?'INCUMBENT: the threshold live signals use':'shadow challenger: ledgered silently, never shown as a signal'}. ${x.n} resolved shadow claim${x.n===1?'':'s'}${x.n<30?' (promotion needs 30 on both sides)':''}.`)}">${x.inc?'\u2605 ':''}${esc(v.param)}${x.v}${x.hit!=null?` <b class="${x.hit>=0.5?'pos':'neg'}">${Math.round(x.hit*100)}%</b>`:''}${x.avg!=null?` <span class="${x.avg>=0?'pos':'neg'}">${x.avg>=0?'+':''}${x.avg}${v.unit}</span>`:''} <i>(n=${x.n})</i></span>`;
      }
      if(v.hist&&v.hist.length){ const h=v.hist[v.hist.length-1];
        tun+=`<span class="sec" style="font-size:var(--fs-2xs)" data-tip="${esc(`most recent promotion: incumbent ${h.incAvg}${v.unit} on n=${h.incN} vs challenger ${h.chAvg}${v.unit} on n=${h.chN} \u2014 out-of-sample shadow claims only`)}">promoted ${h.from}\u2192${h.to} on n=${h.chN} out-of-sample</span>`; }
      tun+='</div>';
    }
    s+=sigSec('tuning','sigrec-sub','self-tuning (shadow variants)',`Bounded self-improvement: each gated event runs 2\u20133 candidate thresholds. Only the incumbent emits visible signals \u2014 but ALL variants (incumbent included) silently ledger shadow claims on identical bookkeeping, so the comparison is out-of-sample and apples-to-apples. A challenger is promoted only with \u226530 resolutions on BOTH sides, expectancy beating the incumbent by \u22650.08 native units and positive, and no hit-rate collapse. Promotions are logged, persisted, and reversible by the same rule. This searches a small fixed hypothesis space under out-of-sample discipline \u2014 it cannot re-fit freely.`,tun);
  }
  const shPanel=d&&d.shadows&&(state.scope==='crypto'?d.shadows.main:d.shadows.xyz);
  if(shPanel&&shPanel.length){
    let shd='';
    for(const g of shPanel){
      shd+=`<div class="sigrec-xr"><span class="sigrec-k" data-tip="${esc(g.tip)}">${esc(g.label)}</span>`;
      for(const r of g.rows){
        const pre=r.tag?esc(r.tag)+' ':'';
        if(r.n){
          shd+=`<span class="sigrec-chip" data-tip="${esc(`${r.n} resolved out-of-sample claim${r.n===1?'':'s'}, outcomes in ${g.unit}${r.avgS!=null?' \u00b7 stop = disciplined leg, resolved against the frozen void':''}${r.open?` \u00b7 ${r.open} still open`:''}`)}">${pre}<b class="${r.hit>=0.5?'pos':'neg'}">${Math.round(r.hit*100)}%</b> <span class="${r.avg>=0?'pos':'neg'}">${r.avg>=0?'+':''}${r.avg}${g.unit}</span>${r.avgS!=null?` \u00b7 stop <span class="${r.avgS>=0?'pos':'neg'}">${r.avgS>=0?'+':''}${r.avgS}${g.unit}</span>`:''} <i>(n=${r.n}${r.open?` \u00b7 ${r.open} open`:''})</i></span>`;
        } else if(r.open){
          shd+=`<span class="sigrec-chip" data-tip="claims are open and resolving \u2014 the first outcomes land at their horizons">${pre}<b>${r.open} open</b> <i>\u00b7 none resolved yet</i></span>`;
        } else {
          shd+=`<span class="sigrec-chip" style="border-style:dashed" data-tip="wired and watching \u2014 no market has met the fire conditions yet">${pre}awaiting first fire</span>`;
        }
      }
      shd+='</div>';
    }
    shd+=`<div class="sec" style="font-size:var(--fs-xs);margin-top:4px">shadow claims only \u2014 never shown as live signals \u00b7 promotion requires an earned record</div>`;
    s+=sigSec('shadows','sigrec-sub','strategy shadows (earning their record)',`Strategy shadows: whole candidate STRATEGIES (not threshold tweaks) earning an out-of-sample record before any promotion. Every claim carries frozen side/void/target at fire, resolves stop-aware, and is episode-deduped like everything else \u2014 and NONE of it touches the live board. This panel is the entire record; nothing is curated away. A strategy that never earns anything simply never surfaces.`,shd);
  }
  if(rs.recent&&rs.recent.length){
    let res=`<div class="sigrec-recent">`;
    for(const e of rs.recent){
      res+=`<span class="recr ${e.win?'w':'l'}" data-tip="${esc(`${e.ticker} \u00b7 ${EV_LABELS[e.ev]||e.ev} \u00b7 fired ${new Date(e.t0).toLocaleString()}, resolved ${new Date(e.tR).toLocaleString()} \u2014 at-horizon ${e.realized>=0?'+':''}${e.realized}${e.unit}${e.realizedS!=null?`; stop-aware ${e.realizedS>=0?'+':''}${e.realizedS}${e.unit}${e.stopped?' (void level touched before horizon)':''}`:''}`)}">${e.stopped?'\u26d4 ':''}${esc(e.ticker)} <b class="${e.win?'pos':'neg'}">${e.realized>=0?'+':''}${e.realized}${e.unit}</b></span>`;
    }
    res+='</div>';
    s+=sigSec('resolutions','sigrec-sub','recent resolutions','the most recent claims to reach their horizon and get scored',res);
  }
  return s;
}
function renderSignals(){
  const box=el('signals-body'); if(!box) return;
  if(state.view==='signals' && scopeGuard('signals')) return;   // flipped scope re-enters this renderer
  const d=state.signals, view=sigViewPref(), mvThr=sigMovePref(), prOn=sigPrimePref();
  const mvBtn=(v,lbl)=>`<button type="button" class="cdtf${mvThr===v?' on':''}" data-mv="${v}" data-tip="${v===0?'show every signal regardless of target distance':`hide setups whose playbook target sits closer than ${lbl} from the live mark \u2014 statistically fine, but a few bp of expected move is not hand-tradeable. Signals with no computable target are hidden too while a threshold is active.`}">${v===0?'any':'\u2265'+lbl}</button>`;
  const seg=`<span class="sig-segs"><span class="cdtf-seg"><button type="button" class="cdtf${prOn?' on':''}" data-pr="1" data-tip="show only \u2605 prime setups \u2014 \u226560% hit, positive expectancy, sound structure at fire time \u2014 and switch the stats below to the record of prime claims only">\u2605 prime</button></span>`
    +`<span class="cdtf-seg" data-tip="minimum actionable move: distance from live mark to the playbook target">${mvBtn(0,'')}${mvBtn(0.5,'0.5%')}${mvBtn(1,'1%')}${mvBtn(2,'2%')}</span>`
    +`<span class="cdtf-seg"><button type="button" class="cdtf${view==='detail'?' on':''}" data-sv="detail" data-tip="full cards: readings, base rates, playbooks">detailed</button><button type="button" class="cdtf${view==='compact'?' on':''}" data-sv="compact" data-tip="one row per market \u2014 hover the chips for the full reading and base rate, click a row to expand it">compact</button></span></span>`;
  // One control row (build -69): the static history search/dropdown, the intro text, and the
  // prime/move/view segments all share the line — rendered into static slots so the inputs
  // keep their state across re-renders.
  { const it=el('sig-introtxt'); if(it) it.innerHTML=`<span data-tip="Scoring: how unusual the condition is right now (0\u201350) + historical edge \u2014 this market's own base rate when it has \u22658 occurrences, else the asset-class pooled base rate at a 30% discount, else a token score. Event types whose LIVE track record shows no edge get their evidence capped automatically. Signals decay past their horizon and drop at 2\u00d7. Nothing here is a prediction \u2014 the full scoring model is in the tab help (?).">Live conditions \u00b7 <b>unusualness \u00d7 historical edge</b> \u00b7 self-audited${(()=>{const u=state.scope==='crypto'?'m':'x';const cu=d&&d.countU&&d.countU[u]!=null?d.countU[u]:(d&&d.count);const sh=(d&&d.signals?d.signals.filter(g=>g.uni===(state.scope==='crypto'?'main':'xyz')).length:0);return cu>sh?` \u00b7 top <b>${sh}</b> of <b>${cu}</b>`:'';})()}</span>`;
    const sl=el('sig-segslot'); if(sl&&sl.innerHTML!==seg){ sl.innerHTML=seg; bindSigControls(sl); } }
  const intro='';
  let rec='';
  const rsTop=(d&&d.records&&(d.records[sigRecKey(mvThr,prOn)]||d.records[String(mvThr)+(prOn?'p':'')]))||d||{};
  const recSrc=rsTop.record||{};
  // Every event capable of ledgering a claim renders via ledgerRosterScoped(): zero-claim
  // roster members appear as explicit "awaiting first claim" entries — without this,
  // "never fired" and "not wired" are indistinguishable — and xyz-only events (gap, prem,
  // ondrift, trend retests) are excluded in crypto scope, where "awaiting" would be a lie.
  {   // always render the strip: on an empty scoped record it IS the roster — every applicable
      // event as an explicit "awaiting first claim" chip, never a vanished section
    let recBody='<div class="recstrip">';
    // record-first ordering: proven/measured entries (by sample size) up top, open-but-unresolved
    // next, roster members awaiting their first claim at the bottom — informational rows never
    // outrank rows with actual outcomes
    const evOrder=Object.keys(recSrc).sort((a,b)=>((recSrc[b].resolved||0)-(recSrc[a].resolved||0))||((recSrc[b].open||0)-(recSrc[a].open||0)));
    for(const ev of evOrder){ const r=recSrc[ev]; if(!r) continue;
      // n vs tape-days: only worth the pixels once they actually diverge (cl < n means the
      // claims clustered, which is the whole point of showing it)
      const clTxt = r.cl>0 && r.cl<r.resolved ? ` across ${r.cl}d` : '';
      const xTxt = r.avgX!=null ? ` \u00b7 vs BTC ${r.avgX>=0?'+':''}${r.avgX}${r.unit}` : '';
      const live = r.resolved>0
        ? `${Math.round((r.hit||0)*100)}% hit \u00b7 med ${r.med>=0?'+':''}${r.med}${r.unit} (n=${r.resolved}${clTxt})${xTxt}`
        : `${r.open||0} open, none resolved yet`;
      const bad = r.resolved>=10 && r.hit<0.5 && r.med<=0;
      const good = r.resolved>=10 && r.hit>=0.55 && r.med>0;
      recBody+=`<span class="rec${bad?' bad':(good?' good':'')}" data-tip="${esc(`${(EV_TIP[ev]||ev).split('.')[0]} \u00b7 out-of-sample record: every firing ledgered at its mark, resolved at the stated horizon under the study\u2019s own sign convention \u00b7 what actually happened after the engine spoke${r.cl>0&&r.cl<r.resolved?` \u00b7 those ${r.resolved} claims fired across only ${r.cl} distinct UTC day(s) \u2014 they are NOT ${r.resolved} independent observations, and on a universe this correlated the effective sample is closer to the day count`:''}${r.avgX!=null?` \u00b7 vs BTC = the same claims resolved net of the benchmark's move over each claim's own window (n=${r.nX}): raw tells you what the trade returned, this tells you whether the event added anything beyond being long crypto`:''}`)}"><b>${esc(EV_LABELS[ev]||ev)}</b> ${live}${bad?' \u00b7 <i>capped</i>':''}</span>`;
    }
    for(const ev of ledgerRosterScoped()){ if(recSrc[ev]) continue;
      recBody+=`<span class="rec await" data-tip="${esc(`${(EV_TIP[ev]||ev).split('.')[0]} \u00b7 in the ledger roster \u2014 no claim has fired yet under the current gates${MAIN_ONLY_EV.has(ev)?' (crypto universe only \u2014 no equity analogue exists in this data)':''}`)}"><b>${esc(EV_LABELS[ev]||ev)}</b> awaiting first claim</span>`;
    }
    recBody+='</div>';
    // Earnings-conditioned split: shown only past n>=5 resolved earnings-window claims per
    // event — below that it's accounting, not evidence. Both halves shown so the comparison
    // is honest; units are the event's own (gap %, others R).
    const es=d&&d.earnSplit;
    if(es){
      let chips='';
      for(const ev in es){ const sp=es[ev]; if(!sp||!sp.eg||sp.eg.n<5) continue;
        const f=(x)=>x?`${Math.round((x.hit||0)*100)}% hit · avg ${x.avg>=0?'+':''}${x.avg} (n=${x.n})`:'no ordinary sample yet';
        chips+=`<span class="rec" data-tip="resolved claims split by the earnings tag: claims in force within 1 ET day of a scheduled print vs all other claims of the same event. Same sign convention and units as the main record. Thin samples — a sizing prior in the making, not yet a proven split.">· <b>${esc(EV_LABELS[ev]||ev)}</b> thru earnings: ${f(sp.eg)} vs ordinary ${f(sp.reg)}</span>`;
      }
      if(chips) recBody+=`<div class="recstrip" style="margin-top:4px">${chips}</div>`;
    }
    rec='<div style="margin-top:22px"></div>'+sigSec('recstrip','dsec','Record by event','compact per-event record \u2014 the same ledger the accuracy table details, one chip per event type \u00b7 includes the earnings-conditioned split where n allows',recBody);
  }
  const _wantUni = state.scope === 'crypto' ? 'main' : 'xyz';
  if(!d||!d.signals||!d.signals.filter(g=>g.uni===_wantUni).length){
    box.innerHTML=intro+`<div class="msg">No unusual ${state.scope==='crypto'?'crypto':'stocks/macro'} conditions firing right now \u2014 this tape is quiet.${warmCount()}<br><span class="sec" style="font-size:var(--fs-xs)">Premium baselines, event studies and the live track record all accrue server-side; early after a cold start this list is naturally sparse.</span></div>`+sigRecordHtml(d)+rec;
    bindSigControls(box); return;
  }
  let hiddenN=0;
  // Scope filter. The payload carries BOTH universes (one build, one ETag, per-universe transport
  // lanes), and every other surface on this tab is already scoped: the record sets via sigRecKey,
  // the awaiting roster via ledgerRosterScoped, the shadow panel via d.shadows[scope]. Leaving the
  // CARDS unscoped put crypto cards directly above an equity track record — the two describing
  // different universes while sitting in one column, which is the board/ledger disagreement this
  // codebase forbids rather than a cosmetic wrinkle. It also breaks the app's founding promise that
  // the two universes never share a view.
  const wantUni = state.scope === 'crypto' ? 'main' : 'xyz';
  const scoped = d.signals.filter(g => g.uni === wantUni);
  const sigs = (mvThr>0||prOn) ? scoped.filter(g=>{
    const m=sigMove(g);
    const ok=(mvThr===0||(m!=null&&m>=mvThr))&&(!prOn||g.prime);
    if(!ok)hiddenN++; return ok; }) : scoped;
  const groups=[], byCoin={};
  for(const g of sigs){ if(byCoin[g.coin]){ byCoin[g.coin].sigs.push(g); byCoin[g.coin].score=Math.max(byCoin[g.coin].score,g.score); }
    else { byCoin[g.coin]={coin:g.coin,ticker:g.ticker,score:g.score,sigs:[g]}; groups.push(byCoin[g.coin]); } }
  if((mvThr>0||prOn)&&!groups.length){
    box.innerHTML=intro+`<div class="msg">All ${hiddenN} live signal${hiddenN===1?'':'s'} hidden by the active filter${prOn?' (no prime setups firing'+(mvThr>0?' at this size':'')+')':''}.</div>`+sigRecordHtml(d)+rec;
    bindSigControls(box); attachLineHover(); return;
  }
  const main=groups.filter(g=>g.score>=35), low=groups.filter(g=>g.score<35);
  const rowOf=(gr,rank)=> view==='compact' ? (sigExpanded.has(gr.coin) ? sigCardHtml(gr, rank, true) : sigRowHtml(gr, rank)) : sigCardHtml(gr, rank, false);
  let s=intro+'<div class="siglist">';
  let rank=0;
  for(const gr of main){ rank++; s+=rowOf(gr,rank); }
  if(low.length){
    s+=`<div class="sig-lowx" data-lowx data-tip="markets whose best condition scores below 35 \u2014 weak evidence, poor structure, decayed, or negative-expectancy base rates. Collapsed by default to keep the list high signal; nothing is deleted.">${state._sigLow?'\u25be':'\u25b8'} ${low.length} low-conviction market${low.length===1?'':'s'} (score &lt; 35)</div>`;
    if(state._sigLow) for(const gr of low){ rank++; s+=rowOf(gr,rank); }
  }
  s+='</div>';
  if(hiddenN>0) s+=`<div class="sec" style="font-size:var(--fs-xs);padding:6px 2px" data-tip="signals whose playbook target is closer than the active threshold, or which have no computable target">${hiddenN} signal${hiddenN===1?'':'s'} hidden by the active filter${prOn?' (prime-only)':''}</div>`;
  s+=sigRecordHtml(d)+rec;
  box.innerHTML=s;
  bindSigControls(box);
  attachLineHover();
}
function bindSigControls(box){
  box.querySelectorAll('.sig-tick').forEach(t=>t.addEventListener('click',(ev)=>{ ev.stopPropagation(); openDetail(t.dataset.coin); }));
  box.querySelectorAll('[data-sv]').forEach(b=>b.addEventListener('click',()=>setSigView(b.dataset.sv)));
  box.querySelectorAll('[data-mv]').forEach(b=>b.addEventListener('click',()=>setSigMove(+b.dataset.mv)));
  box.querySelectorAll('[data-pr]').forEach(b=>b.addEventListener('click',()=>setSigPrime(!sigPrimePref())));
  box.querySelectorAll('.sigc[data-exp]').forEach(r=>r.addEventListener('click',()=>{ sigExpanded.add(r.dataset.exp); renderSignals(); }));
  box.querySelectorAll('.sigcard[data-coll] .sigcard-h').forEach(h=>h.addEventListener('click',(ev)=>{ if(ev.target.closest('.sig-tick'))return; sigExpanded.delete(h.parentNode.dataset.coll); renderSignals(); }));
  box.querySelectorAll('[data-lowx]').forEach(b=>b.addEventListener('click',()=>{ state._sigLow=!state._sigLow; renderSignals(); }));
  box.querySelectorAll('[data-recx]').forEach(b=>b.addEventListener('click',()=>{ setSigRecFull(!sigRecFullPref()); }));
  box.querySelectorAll('[data-sigsec]').forEach(b=>{ const go=()=>sigSecToggle(b.dataset.sigsec);
    b.addEventListener('click',go);
    b.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); go(); } }); });
}
export { EV_LABELS, fillDrawerNews, fmtAge, openTrend, renderNews, renderSignals, renderTrend };
