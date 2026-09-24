// markets.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { featureOn } from "./admin.js";
import { evaluateAlerts } from "./alerts.js";
import { showView } from "./backtest.js";
import { COLS } from "./base.js";
import { COL_BY_KEY, G, RG_COLOR, RG_STORY, TF_MAP, activeRows, clamp, el, esc, fmtPct, fmtPrice, fmtUsd, mktGrp, momColor, pctTxt, regimeMeter, regimeTip, scopeBench, state, stdev } from "./core.js";
import { BASKETS, buildCorr, computeDvb, dvbBasketDef, dvbPickOpts, loadBaskets } from "./corr.js";
import { computeDerived } from "./data.js";
import { openDetail } from "./drawer.js";
import { applyKsel } from "./nav.js";
import { _notesLoading, loadNotes, notesStale, renderDrawerNotes, renderNotes } from "./notes.js";
import { posDecorate, savePrefs } from "./prefs.js";
import { sectorShort } from "./sectors.js";


// ===== rendering =====
let renderQueued=false;
function scheduleRender(){ if(renderQueued)return; renderQueued=true; requestAnimationFrame(()=>{renderQueued=false; render(); if(mktPaintable()) updateMovers();}); }
function scCls(r){ return (r.candleTs && (Date.now()-r.candleTs>2*state.refreshMs+60000)) ? 'stale':''; }
const XYZ_ONLY_COLS=new Set(['gap','vcc','rscc']);   // session-anchored concepts — a 24/7 market has none (vcc/rscc: build 2026.09.24-104)
const MAIN_ONLY_COLS=new Set(['cascT','liq24']);   // aggregated-CEX derivs context — exists only for the crypto universe
// Migration adjacency: when a stored order predates a column that belongs beside another
// (momp beside mom), move it there instead of leaving it appended at the table's far edge.
function colAdjacent(v,key,anchor){ const i=v.indexOf(key),a=v.indexOf(anchor);
  if(i>=0&&a>=0&&i!==a+1){ v.splice(i,1); v.splice(v.indexOf(anchor)+1,0,key); } }
function visibleCols(){ return state.colOrder.map(k=>COL_BY_KEY[k]).filter(c=>c && !state.colHidden.has(c.key) && !(c.key==='dvb'&&!featureOn('baskets')) && !(state.scope==='crypto'&&XYZ_ONLY_COLS.has(c.key)) && !(state.scope!=='crypto'&&MAIN_ONLY_COLS.has(c.key))); }
let dragKey=null;
function clearDropMarks(){ document.querySelectorAll('#head th').forEach(t=>t.classList.remove('drop-before','drop-after')); }
function moveColumn(src, dst, after){
  if(src===dst) return;
  const ord=state.colOrder.filter(k=>k!==src);
  let i=ord.indexOf(dst); if(i<0) i=ord.length-1;
  ord.splice(after?i+1:i, 0, src);
  state.colOrder=ord; clearDropMarks(); buildHead(); render(); savePrefs();
}
function buildHead(){
  if(mktGrp()!=='names'){ buildGroupHead(); return; }   // the lens owns the header: fixed columns, own sort, no drag/reorder
  const tr=el('head'); tr.innerHTML='';
  visibleCols().forEach(c=>{ const th=document.createElement('th'); th.tabIndex=0; th.dataset.key=c.key; th.setAttribute('role','columnheader'); th.draggable=true;
    let label=c.label; if(c.key==='rs')label=`vs ${state.scope==='crypto'?'BTC':'S&amp;P'} (${state.tf})`; if(c.key==='doi')label=`ΔOI (${state.tf})`;
    if(c.key==='vstape')label=`vs tape (${state.tf})`; if(c.key==='rvol')label=`RVOL (${['1h','4h','1d'].includes(state.tf)?state.tf:'—'})`;
    if(c.key==='adr')label=`Avg Range (${state.tf==='30d'?'30d':'7d'})`;
    if(c.key==='dvb'){ const b=dvbBasketDef(); if(featureOn('baskets')&&!BASKETS.list.length) loadBaskets();
      // The basket name IS the control — a bordered caret pill wrapping a real (visible) select, so
      // the "which basket" affordance can't be mistaken for static header text (the -09 bug).
      label=`\u0394 vs <span class="dvb-ctl" data-name="${b?esc(b.label||b.name):'\u2014'}"><span class="bkg">\u2b12</span><select id="dvb-pick" class="dvb-pick" title="pick the basket this \u0394 column measures against \u2014 window follows the board timeframe">${dvbPickOpts()}</select><span class="dvb-car">\u25be</span></span> <span class="sec" style="font-weight:400">(${state.tf})</span>`; }
    const active=state.sortKey===c.key; th.setAttribute('aria-sort', active?(state.sortDir==='asc'?'ascending':'descending'):'none');
    if(c.tip) th.title=c.tip;
    th.innerHTML=`<span class="grip" aria-hidden="true">⠿</span>${label}`+(active?`<span class="arw">${state.sortDir==='asc'?'▲':'▼'}</span>`:'');
    th.addEventListener('click',()=>sortBy(c.key));
    if(c.key==='dvb'){ const dp=th.querySelector&&th.querySelector('#dvb-pick'); if(dp){
      dp.addEventListener('click',e=>e.stopPropagation());
      dp.addEventListener('change',e=>{ e.stopPropagation(); state.dvbBasket=dp.value||null; savePrefs(); buildHead(); render(); }); } }
    th.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();sortBy(c.key);}});
    th.addEventListener('dragstart',e=>{ dragKey=c.key; th.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; try{e.dataTransfer.setData('text/plain',c.key);}catch(_){} });
    th.addEventListener('dragend',()=>{ th.classList.remove('dragging'); dragKey=null; clearDropMarks(); });
    th.addEventListener('dragover',e=>{ if(!dragKey||dragKey===c.key)return; e.preventDefault(); e.dataTransfer.dropEffect='move';
      const rc=th.getBoundingClientRect(), after=(e.clientX-rc.left)>rc.width/2; th.classList.toggle('drop-after',after); th.classList.toggle('drop-before',!after); });
    th.addEventListener('dragleave',()=>th.classList.remove('drop-before','drop-after'));
    th.addEventListener('drop',e=>{ e.preventDefault(); if(!dragKey||dragKey===c.key){clearDropMarks();return;}
      const rc=th.getBoundingClientRect(), after=(e.clientX-rc.left)>rc.width/2; moveColumn(dragKey, c.key, after); });
    tr.appendChild(th); }); }
function sortBy(key){ if(state.sortKey===key) state.sortDir=state.sortDir==='asc'?'desc':'asc';
  else { state.sortKey=key; state.sortDir=(COLS.find(c=>c.key===key).def)||'desc'; } buildHead(); render(); savePrefs(); }
// Vol/OI thresholds, factored so the names table and the group lens filter MEMBERS by the exact
// same rule — a group aggregate is always computed over precisely the rows the names view would
// show under the same Filters popover.
function thresholdRows(rows){ const fl=state.filters;
  if(fl.volMin==null&&fl.volMax==null&&fl.oiMin==null&&fl.oiMax==null) return rows;
  return rows.filter(r=>{
    if(fl.volMin!=null && !(r.vol!=null&&r.vol>=fl.volMin)) return false;
    if(fl.volMax!=null && !(r.vol!=null&&r.vol<=fl.volMax)) return false;
    if(fl.oiMin!=null  && !(r.oi!=null &&r.oi >=fl.oiMin )) return false;
    if(fl.oiMax!=null  && !(r.oi!=null &&r.oi <=fl.oiMax )) return false;
    return true; }); }
function sortedRows(){ let rows=activeRows(); const f=state.filter.trim().toUpperCase();
  if(featureOn('baskets') && (!state.colHidden.has('dvb')||state.sortKey==='dvb')) computeDvb(rows);
  if(state.grpDrill&&state.grpDrill.set) rows=rows.filter(r=>state.grpDrill.set.has(r.coin));   // group drill-down: visible chip, one × to clear
  if(f) rows=rows.filter(r=>r.ticker.toUpperCase().includes(f)||r.coin.toUpperCase().includes(f));
  if(state.watchOnly) rows=rows.filter(r=>state.watch.has(r.coin));
  if(state.noteOnly) rows=rows.filter(r=>r.nt&&r.nt.n);
  if(state.posOnly) rows=rows.filter(r=>state.pos.has(r.coin));
  rows=thresholdRows(rows);
  const k=state.sortKey, dir=state.sortDir==='asc'?1:-1, col=COLS.find(c=>c.key===k);
  rows.sort((a,b)=>{ let av=a[k],bv=b[k]; if(col.type==='str')return dir*String(av).localeCompare(String(bv));
    const an=(av==null||!isFinite(av)),bn=(bv==null||!isFinite(bv)); if(an&&bn)return 0; if(an)return 1; if(bn)return -1; return dir*(av-bv); });
  for(const r of rows) r._wlsep=false;
  if(state.watch.size&&!state.watchOnly){ const star=rows.filter(r=>state.watch.has(r.coin)), rest=rows.filter(r=>!state.watch.has(r.coin));
    if(star.length&&rest.length) rest[0]._wlsep=true;   // the boundary between the pinned block and the sorted tape is drawn, not implied
    rows=[...star,...rest]; }
  return rows; }
function pctInner(v){ if(v===undefined)return '<span class="ph">·</span>'; const p=fmtPct(v); return `<span class="${p.c}">${p.t}</span>`; }
// ===== home sessions (build 2026.08.14-01) ==================================================
// Everything here RENDERS server truth: state.homeMkts (static wall-clock defs + fixed offsets
// + curated-calendar horizon) and state.homeState (live open/closed + next flip, holiday-aware,
// approx-flagged past the horizon) both ride the snapshot. The client converts wall clocks to
// ET for DRAWING only — it never decides whether a market is open.
function rowSessState(r){ return (r&&r.hm&&state.homeState&&state.homeState[r.hm])?state.homeState[r.hm]:state.offHours; }
function sessEx(mk){ const d=state.homeMkts&&state.homeMkts[mk]; return d?d.ex:mk; }
function sessOpenNow(mk){ const st=state.homeState&&state.homeState[mk]; return st?!st.closed:false; }
function sessDur(ms){ if(!(ms>0)) return '0m'; const h=Math.floor(ms/3600000), m=Math.round(ms%3600000/60000);
  if(h>=48) return Math.floor(h/24)+'d '+(h%24)+'h';   // -03: '80h 26m' is a math quiz; '3d 8h' is a read
  return (h?h+'h ':'')+m+'m'; }
function _p2(n){ return String(n).padStart(2,'0'); }
function _etOffMin(){ const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());
  const g=t=>+p.find(x=>x.type===t).value; let h=g('hour'); if(h===24)h=0;
  return Math.round((Date.UTC(g('year'),g('month')-1,g('day'),h,g('minute'))-Date.now())/60000); }   // -240 EDT / -300 EST, DST-correct via Intl
function _etNowMin(){ const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());
  const g=t=>+p.find(x=>x.type===t).value; let h=g('hour'); if(h===24)h=0; return h*60+g('minute'); }
// Home wall-clock minutes -> ET wall-clock minutes (fixed home offset from the wire; ET via Intl).
function homeWallToEtMin(d, mins){ return ((mins - d.off*60 + _etOffMin())%1440+1440)%1440; }
function sessCell(r){
  if(r.uni==='main') return '<td></td>';   // 24/7 book — the column renders empty in crypto scope
  if(!r.hm){
    const lbl='US'+(r.hadr?'\u00b7'+r.hadr:'');
    const t=r.hadr
      ? 'US-listed ADR \u2014 the listed line trades US hours, so every ET anchor applies as-is. The '+r.hadr+' home line leads it overnight: context, never anchoring.'
      : 'US listing \u2014 the ET session machinery applies as-is.';
    return `<td><span class="sesschip us" title="${esc(t)}"><i class="sdot"></i>${lbl}</span></td>`;
  }
  const d=state.homeMkts&&state.homeMkts[r.hm], st=state.homeState&&state.homeState[r.hm], open=sessOpenNow(r.hm);
  const hrs=d?`${_p2(d.o[0])}:${_p2(d.o[1])}\u2013${_p2(d.c[0])}:${_p2(d.c[1])} local${d.lunch?' (lunch halt)':''}`:'';
  const apx=st&&st.approx?' \u00b7 past the curated calendar horizon \u2014 weekend-only approximation until the next year\u2019s table ships':'';
  const t=`home line trades on ${sessEx(r.hm)}${hrs?' \u00b7 '+hrs:''} \u2014 the mirror image of the ET day. Exchange is ${open?'OPEN':'closed'} right now${st&&st.nextT?' \u00b7 '+(open?'closes':'opens')+' in '+sessDur(st.nextT-Date.now()):''}${apx}. Gap/overnight machinery for this name is anchored HERE, never to ET.`;
  return `<td><span class="sesschip${open?' on':''}${st&&st.approx?' apx':''}" title="${esc(t)}"><i class="sdot"></i>${r.hm}</span></td>`;
}
// Variant C — the status rail on the row's left edge: amber = home exchange open, dark = closed.
function railHtml(r){
  if(!r.hm) return '';
  const open=sessOpenNow(r.hm);
  return `<i class="hrail${open?' on':''}" title="${esc(sessEx(r.hm)+(open?' open \u2014 home price discovery is live':' closed \u2014 the reference book under this perp is asleep'))}"></i>`;
}
// Variant E — the countdown microline under the ticker: the only indicator that answers WHEN.
function cdsHtml(r){
  if(!r.hm||!state.homeState||!state.homeState[r.hm]) return '';
  const st=state.homeState[r.hm]; if(!st.nextT) return '';
  const ms=st.nextT-Date.now(); if(!(ms>0)) return '';
  return `<div class="cds${st.closed?'':' on'}" title="${esc('server-computed against the '+sessEx(r.hm)+' calendar'+(st.approx?' \u2014 approximate (past the curated horizon)':''))}">${sessEx(r.hm)} ${st.closed?'opens':'closes'} ${sessDur(ms)}</div>`;
}
// Drawer session ribbon: home lane vs US cash lane on a 24h ET axis, live needle, wrap-safe.
function sessDrawerHtml(r){
  if(!r.hm||!state.homeMkts||!state.homeMkts[r.hm]) return '';
  const d=state.homeMkts[r.hm], st=(state.homeState&&state.homeState[r.hm])||{};
  const W=460,H=70, x=f=>(f*W);
  const rects=(a,b)=>b>a?[[a,b]]:[[a,1],[0,b]];   // ET day-fraction bands, midnight-wrap safe
  const band=(f0,f1,y,cls,tt)=>rects(f0,f1).map(bb=>`<rect x="${x(bb[0]).toFixed(1)}" y="${y}" width="${(x(bb[1])-x(bb[0])).toFixed(1)}" height="12" class="${cls}"><title>${esc(tt)}</title></rect>`).join('');
  const segs=d.lunch?[[d.o,d.lunch[0]],[d.lunch[1],d.c]]:[[d.o,d.c]];
  let home='';
  for(const sg of segs){
    const f0=homeWallToEtMin(d,sg[0][0]*60+sg[0][1])/1440, f1=homeWallToEtMin(d,sg[1][0]*60+sg[1][1])/1440;
    home+=band(f0,f1,8,'srb-home',`${sessEx(r.hm)} session \u00b7 ${_p2(sg[0][0])}:${_p2(sg[0][1])}\u2013${_p2(sg[1][0])}:${_p2(sg[1][1])} local`);
  }
  const us=band(9.5/24,16/24,32,'srb-us','US cash session \u00b7 09:30\u201316:00 ET');
  let ticks='';
  for(let h=0;h<=24;h+=6){ const X=x(h/24).toFixed(1);
    ticks+=`<line x1="${X}" y1="50" x2="${X}" y2="54" class="srb-tick"/><text x="${X}" y="64" text-anchor="${h===0?'start':(h===24?'end':'middle')}" class="srb-lbl">${_p2(h%24)}</text>`; }
  const nf=_etNowMin()/1440;
  const needle=`<line x1="${x(nf).toFixed(1)}" y1="4" x2="${x(nf).toFixed(1)}" y2="48" class="srb-now"><title>now</title></line>`;
  const stateLine=`${sessEx(r.hm)} ${st.closed?'closed':'open'} now${st.nextT?` \u00b7 ${st.closed?'opens':'closes'} in ${sessDur(st.nextT-Date.now())}`:''}${st.approx?' \u00b7 approx \u2014 past the curated calendar horizon':''}`;
  return `<div class="dsec" data-tip="when this name\u2019s reference actually discovers price \u2014 the ${esc(sessEx(r.hm))} session (amber) vs the US cash session (blue) on a 24h ET axis. During US hours the oracle under this perp is coasting on a closed home book; gap/overnight machinery for this name is anchored to the amber band.">Home session \u00b7 ${esc(sessEx(r.hm))}</div>`+
    `<div class="dsessrib"><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">`+
    `<text x="0" y="6" class="srb-lane">HOME</text><text x="0" y="30" class="srb-lane">US</text>`+
    home+us+`<line x1="0" y1="50" x2="${W}" y2="50" class="srb-axis"/>`+ticks+needle+`</svg>`+
    `<div class="srb-state">${esc(stateLine)}</div></div>`;
}
function gapCell(r){ const g=r.gap;
  const oh=rowSessState(r);
  const live = !!(oh && oh.closed && r.closePx>0 && isFinite(r.px));
  const t = (g!=null&&isFinite(g))
    ? (live ? `Live \u2014 move since the last cash close (${r.hm?sessEx(r.hm):'market'} closed now)` : `Last close\u2192open gap${r.hm?' \u00b7 anchored to '+sessEx(r.hm)+' sessions':''}`)
        + ((r.gap30!=null&&isFinite(r.gap30))?' \u00b7 30d off-hours drift '+(r.gap30>0?'+':'')+r.gap30.toFixed(1)+'%':'')
    : 'Off-hours (overnight + weekend) gap \u2014 fills in with the hourly spine';
  const dot = live ? `<span class="live-dot" title="live \u2014 ${r.hm?sessEx(r.hm):'market'} closed">\u25cf</span>` : '';
  return `<td${shade(g,4)} title="${esc(t)}">${pctInner(g)}${dot}</td>`; }
function momCell(r){ if(r.mom===undefined)return '<span class="ph">·</span>'; if(r.mom===null)return '<span class="na">—</span>';
  const sign=r.mom>0?'+':'';
  return `<span style="color:${momColor(r.mom)};font-weight:600">${sign}${Math.round(r.mom)}</span>`+(r.hot?'<span class="hotdot" title="volume / activity well above this market\u2019s own norm">●</span>':''); }
function mompCell(r){
  if(r.momp===undefined)return '<td><span class="ph">·</span></td>';
  if(r.momp===null)return '<td><span class="na">—</span></td>';
  const sign=r.momp>0?'+':'', dv=(r.mom!=null&&isFinite(r.mom))?r.momp-r.mom:null;
  const mark=(dv!=null&&Math.abs(dv)>=10&&r.momWhy)?`<i class="mompw" title="diverges ${dv>0?'+':''}${Math.round(dv)} from the incumbent — ${esc(r.momWhy)}">\u0394</i>`:'';
  const t=r.momWhy?` title="${esc(r.momWhy)}"`:'';
  // Same hot dot as the incumbent column: the flag marks the NAME (volume/premium vs its own
  // norm), not the score — it must survive on the board even when only one of the two momentum
  // columns is visible.
  const hot=r.hot?'<span class="hotdot" title="volume / activity well above this market\u2019s own norm">\u25cf</span>':'';
  return `<td${shade(r.momp,60)}${t}><span style="color:${momColor(r.momp)};font-weight:600">${sign}${Math.round(r.momp)}</span>${hot}${mark}</td>`; }
function rsCell(r){ const bC=r.uni==='main'?state.benchMain:state.benchCoin;
  if(!bC)return '<span class="na" title="no benchmark detected">—</span>';
  if(r.coin===bC)return `<span class="sec" title="this is the benchmark">${r.uni==='main'?'BTC':'S&amp;P'}</span>`;
  const p=fmtPct(r.rs); return `<span class="${p.c}">${p.t}</span>`; }
function vsTapeCell(r){ if(r.vstape==null)return '<span class="na" title="needs the window return and at least 5 reporting names in the scope">—</span>';
  const p=fmtPct(r.vstape), tm=state._tapeMed?state._tapeMed[r.uni==='main'?'main':'xyz']:null;
  return `<span class="${p.c}" title="return ${pctTxt(r[TF_MAP[state.tf]||'d1'])} \u2212 universe median ${pctTxt(tm)} over ${state.tf}">${p.t}</span>`; }
function redTitle(r,extra){ const n=r.red?r.red.n:0, tot=state.redBars?(state.redBars[r.uni==='main'?'main':'xyz']||0):0;
  return `${extra} \u00b7 ${n} matched red-tape 4h bars (scope had ${tot} in 31d) \u00b7 red = \u226570% of names down with a negative median \u00b7 reference = universe median, winsorized`; }
function dcapCell(r){ if(r.dcap==null||!isFinite(r.dcap)){ const n=r.red?r.red.n:0;
    return `<td><span class="na" title="${n?`only ${n} matched red-tape bars \u2014 below the 20-bar gate`:'needs ~a day of hourly history and enough red-tape bars in the scope'}">\u2014</span></td>`; }
  const c=r.dcap<0?'pos':(r.dcap<85?'pos':(r.dcap>120?'neg':'sec'));
  const story=r.dcap<0?'net GREEN on red-tape bars':(r.dcap<100?`eats ${r.dcap}% of the tape\u2019s red move \u2014 dumps less than the typical name`:(r.dcap>100?`amplifies red tape (${r.dcap}% of the typical move)`:'moves with the tape'));
  return `<td class="${c}" title="${redTitle(r,story)}">${r.dcap}%</td>`; }
function hitCell(r){ if(r.hitr==null||!isFinite(r.hitr)) return '<td><span class="na" title="below the 20 matched-bar gate">\u2014</span></td>';
  const c=r.hitr>=60?'pos':(r.hitr<=40?'neg':'sec');
  return `<td class="${c}" title="${redTitle(r,`beat the universe median on ${r.hitr}% of matched red-tape bars`)}">${r.hitr}%</td>`; }
function rvolCell(r){ const tfKey=TF_MAP[state.tf]||'d1';
  if(!(tfKey==='h1'||tfKey==='h4'||tfKey==='d1')) return '<td><span class="na" title="RVOL is defined up to the 1d window \u2014 clock-hour matching has no meaning beyond a day">\u2014</span></td>';
  if(r.rvol==null||!isFinite(r.rvol)) return '<td><span class="na" title="needs enough hourly history for a same-clock-hours baseline (\u22657 prior days with coverage)">\u2014</span></td>';
  const c=r.rvol>=2?'accent':(r.rvol<0.5?'sec':''), t=Math.min(Math.max(r.rvol-1,0)/4,1)*0.20;
  return `<td${c?` class="${c}"`:''} style="background:rgba(251,139,30,${t.toFixed(3)})" title="notional over the last ${state.tf} \u00f7 median of the same clock hours across the prior month \u2014 ${r.rvol>=2?'genuinely elevated for this time of day':(r.rvol<0.5?'well below its norm for this time of day':'in line with its norm for this time of day')}${(x=>x&&x.closed)(rowSessState(r))&&r.uni!=='main'?' \u00b7 '+(r.hm?sessEx(r.hm):'cash market')+' closed: judged against prior off-hours, real but thinner':''}">\u00d7${r.rvol>=10?r.rvol.toFixed(0):r.rvol.toFixed(1)}</td>`; }
function oiCell(r){ if(r.doi==null)return '<span class="na" title="collecting OI history (server-side, accrues over time)">—</span>';
  const oc=r.doi>0?'pos':(r.doi<0?'neg':'sec'), sign=r.doi>0?'+':'';
  let s=`<span class="${oc}">${sign}${r.doi.toFixed(2)}%</span>`;
  const rg=r.regime;
  if(rg){ const pPct=r[TF_MAP[state.tf]];
    if(rg.side===0){
      s+=`<span class="rg" style="color:var(--faint);margin-left:5px" title="${regimeTip(rg,pPct,r.doi)}">${rg.l}</span>`;
    } else {
      const op=(0.5+0.5*clamp(rg.conv,0,1)).toFixed(2);
      s+=`<span class="rg ${rg.c}" style="opacity:${op}" title="${regimeTip(rg,pPct,r.doi)}">${rg.l}</span>${regimeMeter(rg)}`;
    }
  }
  return s; }
function shade(v, cap){ if(v==null||!isFinite(v)) return ''; const t=Math.min(Math.abs(v)/cap,1)*0.20; const rgb=v>=0?'70,185,126':'229,96,77'; return ` style="background:rgba(${rgb},${t.toFixed(3)})"`; }
function miniSpark(vals, color){ const w=62,h=18,pad=2; if(vals.length<2) return ''; const mn=Math.min(...vals),mx=Math.max(...vals),rng=(mx-mn)||1;
  const X=i=>pad+(i/(vals.length-1))*(w-2*pad), Y=v=>h-pad-((v-mn)/rng)*(h-2*pad);
  let d=''; vals.forEach((v,i)=>d+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)+' ');
  return `<svg class="tspark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.3" vector-effect="non-scaling-stroke"/></svg>`; }
function trendCell(r){
  let cl = (r.feat && Array.isArray(r.feat.px30)) ? r.feat.px30.slice(-31)
         : (r.daily ? r.daily.slice(-31).map(k=>parseFloat(k.c)).filter(isFinite) : null);
  if(!cl || cl.length<3) return '<td><span class="na">·</span></td>';
  const up=cl[cl.length-1]>=cl[0]; return `<td title="30d path">${miniSpark(cl, up?'var(--up)':'var(--down)')}</td>`; }
function volCell(r){ if(r.vol30==null||!isFinite(r.vol30)) return '<td><span class="na" title="loading hourly history…">·</span></td>';
  const est={YZ:'Yang-Zhang, last 20 closed sessions \u00d7\u221a252',c2c:'close-to-close \u03c3, last 20 session returns \u00d7\u221a252 (a bar without a true low in the window)',hourly:'hourly log returns \u00d7\u221a(24\u00b7365), forming hour excluded'}[r.vol30Est]||'annualized realized vol';
  return `<td class="sec" title="annualized realized vol \u00b7 ${est}">${r.vol30.toFixed(0)}%</td>`; }
function adrCell(r){ if(r.adr==null||!isFinite(r.adr)) return '<td><span class="na" title="loading hourly history…">·</span></td>';
  const t=Math.min(r.adr/8,1)*0.18;
  return `<td class="sec" style="background:rgba(227,165,60,${t.toFixed(3)})" title="avg daily high−low as % of close, over ${r.uni!=='main'?(state.tf==='30d'?'21 sessions':'5 sessions'):(state.tf==='30d'?'30d':'7d')}">${r.adr.toFixed(2)}%</td>`; }
function ddCell(r){ if(r.dd==null||!isFinite(r.dd)) return '<td><span class="na">·</span></td>';
  const c=r.dd>=-0.5?'pos':(r.dd<=-15?'neg':'sec'); return `<td class="${c}" title="distance below the 30-day high">${r.dd.toFixed(1)}%</td>`; }
function ddyCell(r){ if(r.ddy==null||!isFinite(r.ddy)) return '<td><span class="na" title="needs daily history reaching Jan 1 \u2014 crypto retention is 31d, so outside January this is out of reach by design; equities fill in as the daily backfill loads">\u2014</span></td>';
  const c=r.ddy>=-0.5?'pos':(r.ddy<=-25?'neg':'sec');
  return `<td class="${c}" title="distance below the year\u2019s highest daily close (0% = making the YTD high now)">${r.ddy.toFixed(1)}%</td>`; }
function openCell(r,key,lbl){ const v=r[key];
  if(v==null||!isFinite(v)) return `<td><span class="na" title="needs daily history reaching the ${key==='yopen'?'start of the year \u2014 crypto retention is 31d, so outside January this is out of reach by design; equities fill in as the daily backfill loads':'start of the month \u2014 fills in as daily history loads'}">\u2014</span></td>`;
  const above=r.px!=null&&isFinite(r.px)?r.px>=v:null, d=above!=null&&v>0?((r.px/v-1)*100):null;
  return `<td class="${above==null?'sec':(above?'pos':'neg')}" title="${lbl} ${fmtPrice(v)}${d!=null?` \u00b7 price ${d>=0?'+':''}${d.toFixed(1)}% ${d>=0?'above':'below'}`:''}">${fmtPrice(v)}</td>`; }
// D open: pure % since the current UTC day's open, shaded like the sibling change columns.
// ~3% full shade — tighter than 24h's 5% band because a partial day prints smaller moves.
// The exact open level rides the hover only; the cell and the sort value are the same number.
function dopenCell(r){ const v=r.dopen;
  if(v==null||!isFinite(v)) return '<td><span class="na" title="needs daily history \u2014 fills in as the daily backfill loads">\u2014</span></td>';
  return `<td${shade(v,3)} title="since today\u2019s UTC open ${fmtPrice(r.dopenPx)} \u00b7 the prior day\u2019s close on a continuously-traded perp">${pctInner(v)}</td>`; }
// One renderer for the H/4h/12h anchored-open family — dopenCell's contract (the % in the cell,
// the anchor level in the hover, shade cap scaled to the bucket width) parameterized per rung.
function anchOpenCell(r,key,pxKey,what,cap){ const v=r[key];
  if(v==null||!isFinite(v)) return '<td><span class="na" title="hourly spine hasn\u2019t reached this bucket\u2019s boundary yet (deploy warm-up or a fetch gap) \u2014 dash, never a stale anchor">\u2014</span></td>';
  return `<td${shade(v,cap)} title="since the ${what} opened at ${fmtPrice(r[pxKey])} \u00b7 anchored on the UTC bucket boundary \u2014 contrast with the rolling window columns">${pctInner(v)}</td>`; }
function premCell(r){ if(r.prem==null||!isFinite(r.prem)) return '<td><span class="na" title="needs both mark and oracle prices">·</span></td>';
  const v=r.prem, c=v>0.5?'pos':(v<-0.5?'neg':'sec');
  const t=`mark ${fmtPrice(r.px)} vs oracle ${fmtPrice(r.oracle)} \u2014 perp ${v>=0?'rich (premium)':'cheap (discount)'} ${Math.abs(v).toFixed(1)}bp`+
    ((x=>x&&x.closed)(rowSessState(r))?' \u00b7 '+(r.hm?sessEx(r.hm):'cash market')+' closed: this dislocation is the live off-hours price discovery':'');
  return `<td${shade(v,25)} title="${esc(t)}"><span class="${c}">${v>=0?'+':''}${v.toFixed(1)}bp</span></td>`; }
// Squeeze susceptibility 0-100. Necessary condition: crowded shorts, i.e. the window-average
// funding is NEGATIVE (shorts pay longs to stay short — conviction crowding). That crowding
// term is then amplified by fuel (OI building = fresh shorts pressing) and trigger (price
// position in the 30d range — shorts near the highs are already underwater).
function computeSqueeze(r, fundWin){
  if(fundWin==null||!isFinite(fundWin)) return undefined;   // no window funding yet — accrues server-side
  const fAPR=fundWin*24*365*100;
  const crowd=fAPR<0?Math.tanh(-fAPR/35):0;
  const fuel=(r.doi!=null&&isFinite(r.doi))?Math.tanh(Math.max(0,r.doi)/8):0;
  let trig=0.5; const f=r.feat;
  if(r.px!=null&&f&&f.hi30!=null&&f.lo30!=null&&f.hi30>f.lo30) trig=clamp((r.px-f.lo30)/(f.hi30-f.lo30),0,1);
  r._sqzq={fAPR,crowd,fuel,trig};
  if(crowd<=0) return 0;
  return Math.round(100*crowd*(0.45+0.30*fuel+0.25*trig));
}
function sqzCell(r){ const v=r.sqz;
  if(v===undefined) return '<td><span class="na" title="needs window-average funding \u2014 accrues server-side">·</span></td>';
  const q=r._sqzq||{};
  const t=v>0
    ? `crowding ${Math.round((q.crowd||0)*100)}/100 (shorts paying ${Math.abs(q.fAPR||0).toFixed(0)}% APR over ${state.tf}) \u00b7 fuel ${Math.round((q.fuel||0)*100)}/100 (\u0394OI ${r.doi!=null?(r.doi>=0?'+':'')+r.doi.toFixed(1)+'%':'n/a'}) \u00b7 trigger ${Math.round((q.trig||0)*100)}/100 (position in the 30d range)`
    : `no squeeze fuel \u2014 window funding ${q.fAPR!=null?(q.fAPR>=0?'+':'')+q.fAPR.toFixed(0)+'% APR':'n/a'} (${q.fAPR>=0?'longs are the crowded side':'shorts barely paying'})`;
  if(v===0) return `<td title="${esc(t)}"><span class="na">0</span></td>`;
  const col=v>=60?'var(--accent)':(v>=30?'var(--text)':'var(--muted)');
  return `<td title="${esc(t)}"><span style="color:${col};font-weight:${v>=30?600:400}">${v}</span></td>`; }
function carryCell(r){ const v=r.carry;
  if(v==null||!isFinite(v)) return '<td><span class="na" title="needs window funding + annualized vol">·</span></td>';
  const c=v>0.05?'pos':(v<-0.05?'neg':'sec'), fAPR=(r._carryF!=null)?r._carryF:null;
  const t=`funding ${fAPR!=null?(fAPR>=0?'+':'')+fAPR.toFixed(0)+'% APR':'n/a'} \u00f7 vol ${r.vol30!=null?r.vol30.toFixed(0)+'%':'n/a'} \u2014 ${v>=0?'shorts are paid':'longs are paid'} ${Math.abs(v).toFixed(2)} vol-units/yr to hold`;
  return `<td${shade(v,1)} title="${esc(t)}"><span class="${c}">${v>=0?'+':''}${v.toFixed(2)}</span></td>`; }
// ===== row-level table patching (build 2026.07.29-09) ==========================================
// The content short-circuit skips UNCHANGED snapshots; this handles the other 99%: one tick moved,
// and the old path re-parsed a 140-row table's innerHTML and re-laid-out everything. Now the row
// STRINGS are still all built every render — string concat was never the cost; parse + layout was
// — and the DOM is only touched where a row's string actually differs from what that row already
// is. One code path is preserved at the level that matters: rowHtml() is the ONLY producer of row
// markup, full rebuild and patch both consume its exact output, so the patched table is byte-
// identical to a rebuild BY CONSTRUCTION (and the harness proves it, not just asserts it).
//
// The patch path only runs when the table SHAPE is provably unchanged: same coins in the same
// order, same visible column set, same bench row, and the live DOM has exactly the row count we
// think it has. Any mismatch — sort flips, filter edits, scope/column changes, or an external
// write like errRow() replacing the tbody — fails the gate and takes the full rebuild, which also
// re-primes the cache. Self-healing beats clever: the cache can never wedge the board, because
// disagreement with reality always resolves to "rebuild everything", never to "trust the cache".
let _rowCache=null, _rowStruct='';
function rowHtml(r, vc, bScope){
  const dim = state.dimOff && r.hm && !sessOpenNow(r.hm);   // variant A: only foreign-home rows, only while their exchange sleeps
  const cc = (r.coin===bScope?'benchrow':'')+(dim?(r.coin===bScope?' ':'')+'dimoff':'');
  const cls = cc?` class="${cc}"`:'';
  let row=`<tr data-coin="${esc(r.coin)}"${cls} tabindex="0"${r._wlsep?' data-wlsep="1"':''}>`; for(const c of vc) row+=c.td(r); row+='</tr>';   // Tab reaches every row; Enter opens it (see the [role=button] dispatcher)
  r.flash=null;   // consumed into this string exactly as the rebuild path always did — the NEXT
                  // render produces a flash-free string, so the patcher clears the class then
  return row;
}
// Split out for the execution-smoke harness: given aligned old/new row strings and a children-like
// list, rewrite ONLY the slots whose strings differ. Returns the write count — the perf claim is
// "unchanged rows cost zero DOM writes", and the test asserts the number, not the vibe.
// Keyboard focus lives on a row (Tab / j-k-Enter) or on a control inside it (the note marker, the
// star). Both write paths rebuild that element, and a rebuilt element is not the one the browser
// was focused on: focus fell to <body> on every tick that moved a price. Remember what held it
// before the write and put it back on the replacement afterwards — same coin, same inner control.
function rowFocus(body){ const ae=document.activeElement; if(!ae||!ae.closest||!body.contains(ae)) return null;
  const tr=ae.closest('tr[data-coin]'); if(!tr) return null;
  const inner=ae!==tr?(ae.dataset&&ae.dataset.pit!=null?`.pit[data-pit="${CSS.escape(ae.dataset.pit)}"]`:(ae.dataset&&ae.dataset.star!=null?`.star[data-star="${CSS.escape(ae.dataset.star)}"]`:null)):null;
  return {el:ae, coin:tr.dataset.coin, inner}; }
function rowRefocus(body, had){ if(!had||had.el.isConnected) return;   // untouched rows keep their focus by themselves
  const tr=body.querySelector(`tr[data-coin="${CSS.escape(had.coin)}"]`); if(!tr) return;
  const t=(had.inner&&tr.querySelector(had.inner))||tr; try{ t.focus({preventScroll:true}); }catch(_){} }
function patchRowsInto(children, oldHtml, newHtml){
  let writes=0;
  for(let i=0;i<newHtml.length;i++){ if(oldHtml[i]!==newHtml[i]){ children[i].outerHTML=newHtml[i]; writes++; } }
  return writes;
}
// ===== markets group lens (build 2026.08.07-01) ================================================
// The Markets tab's other two views: the same board, one row per SECTOR or INDUSTRY instead of
// per name — every window column at once, in numbers. Pure client-side aggregation over the exact
// rows the names view renders: computeDerived has already stamped every windowed field on the
// member rows, so a group cell is BY CONSTRUCTION the weighted average of what the names view
// shows (one code path, no second source of truth, no server work). Grouping keys reuse the
// classification contract verbatim: sectors -> r.sector, industries -> r.ind||r.sector (the
// server only ships `ind` when it differs from the sector — the fallback IS the contract, the
// same rule the Sectors tab renders, marked visibly here too). Every aggregate is computed ONLY
// over members that have the value, with per-key weight renormalization, and each cell's hover
// discloses that coverage — a group average never silently absorbs missing history as zero.
function computeMktGroups(rows, mode, wt){
  const groups=new Map();
  for(const r of rows){
    const g=(mode==='industries'?(r.ind||r.sector):r.sector)||'Unclassified';
    let o=groups.get(g); if(!o){ o={name:g, assetClass:r.assetClass||'\u2014', members:[]}; groups.set(g,o); }
    if((r.assetClass||'\u2014')!==o.assetClass) o.assetClass='Mixed';
    o.members.push(r);
  }
  const KEYS=['dopen','h1','h4','d1','d7','d30','doi','rvol'];
  const list=[];
  for(const o of groups.values()){
    const ms=o.members, byVol=wt!=='eq';
    // Monthly / yearly distance per member: px vs the stored open LEVEL — the same math openCell
    // renders per name, restated once here so the group column has a number to average and sort.
    const mv=ms.map(r=>({ r,
      mopenPct:(r.mopen>0&&r.px>0&&isFinite(r.px))?(r.px/r.mopen-1)*100:null,
      yopenPct:(r.yopen>0&&r.px>0&&isFinite(r.px))?(r.px/r.yopen-1)*100:null }));
    // Weighted average over members that HAVE the value. Vol weights renormalize per key: a
    // member missing one window drops out of that column's weights only — it never drags the
    // average toward zero, and it stays fully weighted in every column it does have.
    const wavg=(sel)=>{ const vals=[]; let wsum=0;
      for(const m of mv){ const v=sel(m); if(v==null||!isFinite(v))continue; vals.push([m,v]); if(byVol&&m.r.vol>0)wsum+=m.r.vol; }
      let s=0,ww=0;
      for(const [m,v] of vals){ const wi=byVol?(wsum>0?((m.r.vol>0?m.r.vol:0)/wsum):1/vals.length):1/vals.length; s+=wi*v; ww+=wi; }
      return { v: ww>0?s/ww:null, n:vals.length }; };
    const agg={};
    for(const k of KEYS) agg[k]=wavg(m=>(m.r[k]!=null&&isFinite(m.r[k]))?m.r[k]:null);
    agg.mopen=wavg(m=>m.mopenPct); agg.yopen=wavg(m=>m.yopenPct);
    const withD1=ms.filter(r=>r.d1!=null&&isFinite(r.d1));
    let best=null,worst=null;
    for(const r of withD1){ if(!best||r.d1>best.d1)best=r; if(!worst||r.d1<worst.d1)worst=r; }
    let totVol=0,totOI=0; for(const r of ms){ if(r.vol)totVol+=r.vol; if(r.oi)totOI+=r.oi; }
    list.push({ name:o.name, assetClass:o.assetClass, n:ms.length, members:ms,
      fall: mode==='industries' && ms.every(m=>!m.ind),   // no member carries a curated industry -> the group IS its sector, shown as such
      agg, brUp:withD1.filter(r=>r.d1>0).length, brN:withD1.length,
      best: best?{t:best.ticker,v:best.d1}:null, worst: worst?{t:worst.ticker,v:worst.d1}:null,
      totVol, totOI });
  }
  return list;
}
function mktGroupCohesion(list){
  // 90d average pairwise daily-return correlation INSIDE each group — the "does the label trade
  // as one block" column, same definition as the Sectors board (high = own the theme, any name;
  // low = a stock-picker's bucket where Best/Worst matters more than the average). The
  // correlation build is the one non-trivial compute on this board, so it is memoized on
  // (scope, membership) with a 5-minute staleness cap: membership changes rebuild immediately,
  // ordinary ticks reuse.
  const withDaily=[], idxSeen=new Set();
  for(const g of list) for(const r of g.members) if(r.daily&&!idxSeen.has(r.coin)){ idxSeen.add(r.coin); withDaily.push(r); }
  const sig=state.scope+'|'+withDaily.map(r=>r.coin).sort().join(',');
  if(!(MKTGRP.coh && MKTGRP.cohSig===sig && Date.now()-MKTGRP.cohAt<300000)){
    if(withDaily.length>1){ const {C}=buildCorr(withDaily,90);
      MKTGRP.coh={C, idx:new Map(withDaily.map((r,i)=>[r.coin,i]))}; }
    else MKTGRP.coh=null;
    MKTGRP.cohSig=sig; MKTGRP.cohAt=Date.now();
  }
  for(const g of list){ g.cohesion=null; const c=MKTGRP.coh; if(!c) continue;
    const idx=g.members.map(r=>c.idx.get(r.coin)).filter(i=>i!=null);
    let s=0,n=0;
    for(let a=0;a<idx.length;a++)for(let b=a+1;b<idx.length;b++){ const v=c.C[idx[a]][idx[b]]; if(v!=null&&isFinite(v)){s+=v;n++;} }
    g.cohesion=n?s/n:null; }
}
const MKTGRP={ cohSig:'', coh:null, cohAt:0 };
function gAggTd(g,k,cap,lbl){ const a=g.agg[k];
  if(!a||a.v==null) return `<td><span class="na" title="${esc(lbl)} \u2014 no member in this group has the value yet (disclosed gap, never zero-filled)">\u2014</span></td>`;
  const p=fmtPct(a.v);
  const cov=`${state.grpWt==='eq'?'equal':'vol'}-weighted \u00b7 ${a.n}/${g.n} members${a.n<g.n?' \u2014 the rest lack this window (excluded, weights renormalized)':''}`;
  return `<td${shade(a.v,cap)} title="${esc(lbl)} \u00b7 ${esc(cov)}"><span class="${p.c}">${p.t}</span></td>`; }
const GCOLS=[
  {key:'name', label:'Group', tip:'Sector (GICS + asset classes) or industry group \u2014 same curated classification the Sectors tab uses. Click a row to drill in: the table flips to the names view filtered to this group\u2019s members, with a chip to clear. Industry rows marked "= sector" have no curated split \u2014 the group is the sector itself, shown honestly rather than hidden.',
    val:g=>g.name,
    td:g=>`<td style="color:var(--text);font-weight:600" title="click \u2192 ${state.scope==='crypto'?'coins':'stocks'} view filtered to its ${g.n} member${g.n===1?'':'s'}">${esc(sectorShort(g.name))}${g.fall?' <span class="sec" style="font-style:italic;font-size:var(--fs-2xs)" title="no curated industry split for these names \u2014 the group is the GICS sector itself">= sector</span>':''}</td>`},
  {key:'n', label:'#', tip:'Members in the group \u2014 after the Filters popover (vol/OI thresholds and \u2605-only apply to MEMBERS before aggregation, so this board always aggregates exactly what the names view would show).',
    val:g=>g.n, td:g=>`<td class="sec">${g.n}</td>`},
  {key:'dopen', label:'D open', tip:'Weighted average of members\u2019 % change since the current UTC day\u2019s open \u2014 the day-boundary read, vs the rolling 24h column. Hover any cell for weighting + coverage.',
    val:g=>g.agg.dopen.v, td:g=>gAggTd(g,'dopen',4,'since the UTC day open')},
  {key:'h1', label:'1h', tip:'Weighted average 1h return of the members.', val:g=>g.agg.h1.v, td:g=>gAggTd(g,'h1',2.5,'1h return')},
  {key:'h4', label:'4h', tip:'Weighted average 4h return of the members.', val:g=>g.agg.h4.v, td:g=>gAggTd(g,'h4',4,'4h return')},
  {key:'d1', label:'24h', tip:'Weighted average rolling-24h return of the members \u2014 the default sort.', val:g=>g.agg.d1.v, td:g=>gAggTd(g,'d1',5,'rolling 24h return')},
  {key:'d7', label:'7d', tip:'Weighted average 7d return of the members.', val:g=>g.agg.d7.v, td:g=>gAggTd(g,'d7',12,'7d return')},
  {key:'d30', label:'30d', tip:'Weighted average 30d return of the members.', val:g=>g.agg.d30.v, td:g=>gAggTd(g,'d30',25,'30d return')},
  {key:'mopen', label:'M open', tip:'Weighted average of members\u2019 distance from the month\u2019s opening level \u2014 (price \u00f7 monthly open \u2212 1), the same math the names view\u2019s M open column shows per ticker.',
    val:g=>g.agg.mopen.v, td:g=>gAggTd(g,'mopen',10,'vs the month open')},
  {key:'yopen', label:'Y open', tip:'Weighted average of members\u2019 distance from the yearly opening level (Jan 1 UTC). Crypto\u2019s 31d retention only reaches the anchor in January \u2014 honest dashes otherwise, same as the names view.',
    val:g=>g.agg.yopen.v, td:g=>gAggTd(g,'yopen',25,'vs the yearly open')},
  {key:'br', label:'Breadth', tip:'Share of members up over the rolling 24h \u2014 the "is the average everyone, or one name" check. Hover for the raw count.',
    val:g=>g.brN?g.brUp/g.brN:null,
    td:g=>g.brN?`<td class="sec" title="${g.brUp}/${g.brN} members up (24h)">${Math.round(100*g.brUp/g.brN)}%</td>`:'<td><span class="na">\u2014</span></td>'},
  {key:'doi', label:'\u0394OI', tip:'Weighted average open-interest change over the selected window \u2014 is money entering or leaving the whole group. Follows the window selector like the names view.',
    val:g=>g.agg.doi.v, td:g=>gAggTd(g,'doi',10,'\u0394OI over the window')},
  {key:'rvol', label:'RVOL', tip:'Weighted average relative volume (clock-hour matched, per member) over the selected window \u2014 defined up to 1d, dashes on 7d/30d, same as the names view.',
    val:g=>g.agg.rvol.v,
    td:g=>{ const a=g.agg.rvol; if(!a||a.v==null) return '<td><span class="na" title="RVOL is defined up to the 1d window \u2014 or member baselines are still building">\u2014</span></td>';
      const hi=a.v>=1.5;
      return `<td class="${hi?'':'sec'}"${hi?' style="color:var(--accent)"':''} title="${state.grpWt==='eq'?'equal':'vol'}-weighted \u00b7 ${a.n}/${g.n} members">\u00d7${a.v.toFixed(1)}</td>`; }},
  {key:'vol', label:'24h Vol', tip:'Sum of members\u2019 24h notional volume \u2014 a straight sum regardless of the weighting toggle.', val:g=>g.totVol, td:g=>`<td class="sec">${fmtUsd(g.totVol)}</td>`},
  {key:'oi', label:'OI', tip:'Sum of members\u2019 open interest.', val:g=>g.totOI, td:g=>`<td class="sec">${fmtUsd(g.totOI)}</td>`},
  {key:'coh', label:'Coh', tip:'Cohesion: average pairwise daily-return correlation between the group\u2019s members (90d) \u2014 the Sectors-board definition. High (\u22650.6): the group trades as one block, the label is the trade. Low: a stock-picker\u2019s bucket \u2014 the average hides dispersion, read Best \u00b7 Worst instead. Dot while daily history builds or with a single member.',
    val:g=>g.cohesion,
    td:g=>`<td class="sec" title="${g.cohesion==null?(g.n<2?'single member \u2014 cohesion needs a pair':'daily history still loading for these members'):'avg internal daily-return correlation (90d)'}">${g.cohesion==null?'\u00b7':g.cohesion.toFixed(2)}</td>`},
  {key:'bw', label:'Best \u00b7 Worst', tip:'Top and bottom member by rolling-24h return \u2014 the aggregate-liar detector: it tells you whether the group average is everyone, or one name dragging the rest. Pinned to 24h regardless of sort.',
    val:null,
    td:g=>{ if(!g.best) return '<td><span class="na">\u2014</span></td>';
      const pb=fmtPct(g.best.v), pw=fmtPct(g.worst.v);
      return `<td title="top / bottom member by 24h return"><span class="${pb.c}">${pb.t}</span> <span class="sec">${esc(g.best.t)}</span>${g.worst.t!==g.best.t?` \u00b7 <span class="${pw.c}">${pw.t}</span> <span class="sec">${esc(g.worst.t)}</span>`:''}</td>`; }},
];
function groupRowsSorted(){
  let rows=activeRows();
  if(state.watchOnly) rows=rows.filter(r=>state.watch.has(r.coin));
  if(state.noteOnly) rows=rows.filter(r=>r.nt&&r.nt.n);
  if(state.posOnly) rows=rows.filter(r=>state.pos.has(r.coin));
  rows=thresholdRows(rows);
  const list=computeMktGroups(rows, mktGrp(), state.grpWt);
  mktGroupCohesion(list);
  const f=state.filter.trim().toUpperCase();
  const out=f?list.filter(g=>g.name.toUpperCase().includes(f)||g.members.some(r=>r.ticker.toUpperCase().includes(f))):list;
  const gs=state.grpSort, col=GCOLS.find(c=>c.key===gs.key&&c.val)||GCOLS.find(c=>c.key==='d1');
  const d=gs.dir==='asc'?1:-1;
  out.sort((a,b)=>{ const av=col.val(a), bv=col.val(b);
    if(typeof av==='string'||typeof bv==='string') return d*String(av).localeCompare(String(bv));
    const an=(av==null||!isFinite(av)), bn=(bv==null||!isFinite(bv)); if(an&&bn)return 0; if(an)return 1; if(bn)return -1; return d*(av-bv); });
  return out;
}
function buildGroupHead(){ const tr=el('head'); tr.innerHTML='';
  for(const c of GCOLS){ const th=document.createElement('th'); th.tabIndex=0; th.dataset.key=c.key; th.setAttribute('role','columnheader');
    let label=c.label; if(c.key==='doi')label=`\u0394OI (${state.tf})`; if(c.key==='rvol')label=`RVOL (${['1h','4h','1d'].includes(state.tf)?state.tf:'\u2014'})`;
    const active=state.grpSort.key===c.key;
    th.setAttribute('aria-sort', active?(state.grpSort.dir==='asc'?'ascending':'descending'):'none');
    if(c.tip) th.title=c.tip;
    th.innerHTML=label+(active?`<span class="arw">${state.grpSort.dir==='asc'?'\u25b2':'\u25bc'}</span>`:'');
    if(c.val){ th.addEventListener('click',()=>grpSortBy(c.key));
      th.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();grpSortBy(c.key);}}); }
    tr.appendChild(th); } }
function grpSortBy(key){ const c=GCOLS.find(x=>x.key===key); if(!c||!c.val) return;
  if(state.grpSort.key===key) state.grpSort.dir=state.grpSort.dir==='asc'?'desc':'asc';
  else state.grpSort={key, dir:key==='name'?'asc':'desc'};
  buildHead(); render(); }
function renderGroupBoard(){
  const body=el('body'), list=groupRowsSorted();
  renderActionLists();   // -05: group heating/cooling + name-level bid render under the lens too
  _rowCache=null; _rowStruct='';   // the names-mode row patcher must never diff against group markup — returning to names always full-rebuilds
  const fc=el('fcount'); if(fc) fc.textContent='';
  if(!list.length){ body.innerHTML=`<tr><td colspan="${GCOLS.length}"><div class="msg"><span class="big">No matches</span>Clear the filter to see every group.</div></td></tr>`; return; }
  body.innerHTML=list.map(g=>{ let row=`<tr data-grp="${esc(g.name)}" style="cursor:pointer">`; for(const c of GCOLS) row+=c.td(g); return row+'</tr>'; }).join('');
  body.querySelectorAll('tr[data-grp]').forEach(tr=>tr.addEventListener('click',()=>drillInto(tr.dataset.grp)));
}
// One entry point for every member drill — the lens row click AND the sector-detail → Markets
// button route through here, so the chip, the filter clear and the persistence rules can never fork.
function drillMembers(label, coins){
  state.grpDrill={label, set:new Set(coins)};
  state.grp='names';
  state.filter=''; const fi=el('filter'); if(fi) fi.value='';   // the text filter's job was finding the group; carried along it would filter the very members just selected
  syncGrpSeg(); updateDrillChip(); savePrefs();
  if(state.view==='markets'){ buildHead(); render(); }
  else { showView('markets'); buildHead(); render(); }   // cross-tab entry: land on Markets already drilled
}
function drillInto(name){
  const g=groupRowsSorted().find(x=>x.name===name); if(!g) return;
  drillMembers(name, g.members.map(r=>r.coin));
}
function clearDrill(){ state.grpDrill=null; updateDrillChip(); buildHead(); render(); }
function updateDrillChip(){ const c=el('drillchip'); if(!c) return;
  if(!state.grpDrill){ c.hidden=true; c.innerHTML=''; return; }
  c.hidden=false;
  c.innerHTML=`<span class="t">${esc(sectorShort(state.grpDrill.label))}</span><span class="n">${state.grpDrill.set.size} names</span><button type="button" class="x" title="clear \u2014 back to the full universe">\u00d7</button>`;
  c.querySelector('.x').addEventListener('click',clearDrill); }
function setGrp(v){
  if(v!=='sectors'&&v!=='industries') v='names';
  state.grp=v;
  state.grpDrill=null; updateDrillChip();   // entering a lens always clears a previous drill — no invisible member filter under a fresh grouping
  syncGrpSeg(); buildHead(); render(); savePrefs(); }
function syncGrpSeg(){
  const eff=mktGrp(), cr=state.scope==='crypto', seg=el('grpseg'); if(!seg) return;
  seg.querySelectorAll('button').forEach(b=>{ b.classList.toggle('active', b.dataset.grp===eff);
    if(b.dataset.grp==='names') b.textContent=cr?'coins':'stocks';
    if(b.dataset.grp==='industries') b.hidden=cr; });
  const wt=el('grpwtseg'); if(wt){ wt.hidden=eff==='names';
    wt.querySelectorAll('button').forEach(b=>b.classList.toggle('active', b.dataset.gwt===state.grpWt)); }
  // The column & layout menus configure the NAMES table — parked, not repurposed, while a group
  // lens is up; the lens's fixed column set never touches a saved layout.
  const cm=document.querySelector('.colmenu'), lm=document.querySelector('.laymenu');
  if(cm) cm.style.display=eff==='names'?'':'none';
  if(lm) lm.style.display=eff==='names'?'':'none'; }
// ===== action lists: heating / cooling / strongest bid (build 2026.08.07-02) ===================
// The rate-of-change companion to the momentum LEVEL. Per window, each name gets a pace
// acceleration — how much its fast leg outran the window's own pace, both measured relative to
// the tape — and a heat score in which flow (ΔOI, clock-matched RVOL) only CONFIRMS that
// acceleration, never replaces it. HEATING is what is starting; COOLING is what had a trend vs
// the tape and is stalling (a different animal from "never went anywhere", which is the ignore
// pile and gets no list); STRONGEST BID ranks the server's dip-reclaim claims — demand response,
// not momentum. MOM is printed on every chip so level and derivative read together: high/high =
// ride, high/negative = exit, low/positive = new rotation. Recipes verbatim in every hover.
// ACT_LEGS: window -> [fast field, fast hours, window field, window hours].
const ACT_LEGS={ '1h':['m15',0.25,'h1',1], '4h':['h1',1,'h4',4], '1d':['h4',4,'d1',24], '7d':['d1',24,'d7',168], '30d':['d7',168,'d30',720] };
function accelPace(fastRel, winRel, fastH, winH){
  if(fastRel==null||winRel==null||!isFinite(fastRel)||!isFinite(winRel)||!(fastH>0)||!(winH>0)) return null;
  return fastRel - winRel*(fastH/winH);   // 0 = tracking its own window pace; + = outrunning it; − = stalling
}
function heatOf(accel, doi, rvol, winH){
  if(accel==null) return null;
  const oiTerm = 0.6*Math.tanh(((doi!=null&&isFinite(doi))?doi:0)/8);
  const rvTerm = (winH<=24 && rvol!=null && isFinite(rvol)) ? 0.4*Math.min(2,Math.max(-1,rvol-1)) : 0;   // RVOL is clock-matched and only exists ≤1d — dropped, not faked, at 7d/30d
  return accel + oiTerm + rvTerm;
}
function pickAction(scored){
  const heat = scored.filter(s=>s.accel!=null&&s.accel>0&&s.heat>0).sort((a,b)=>b.heat-a.heat).slice(0,5);
  const cool = scored.filter(s=>s.winRel!=null&&s.winRel>0&&s.accel!=null&&s.accel<0).sort((a,b)=>a.heat-b.heat).slice(0,5);
  const bid  = scored.filter(s=>s.bid&&s.bid.r>=0.5&&s.bid.d>0&&s.bid.m>0)
    .map(s=>({...s, bidScore:s.bid.d*s.bid.r/Math.sqrt(s.bid.m)}))
    .sort((a,b)=>b.bidScore-a.bidScore).slice(0,5);
  return { heat, cool, bid };
}
// Group flavor (-05): at group level the volume confirm is Δ SHARE OF TAPE, not aggregated RVOL —
// rotation between groups is zero-sum by definition (one group's +4pp of the tape is someone
// else's −4pp), and share delta only moves when the MIX moves; on a hot day every group can print
// RVOL ×1.5 at once and learn nothing. Names keep RVOL (their own clock-matched baseline).
function shareDeltaPp(volNow, volAllNow, volBase, volAllBase){
  if(!(volNow>=0)||!(volAllNow>0)||!(volBase>=0)||!(volAllBase>0)) return null;
  return (volNow/volAllNow - volBase/volAllBase)*100;   // percentage points of the tape, today vs the group's own baseline mix
}
function groupHeatOf(accel, doi, dSharePp){
  if(accel==null) return null;
  const oiTerm = 0.6*Math.tanh(((doi!=null&&isFinite(doi))?doi:0)/8);
  const shTerm = (dSharePp!=null&&isFinite(dSharePp)) ? 0.4*Math.tanh(dSharePp/3) : 0;   // ±4pp of tape ≈ saturating — a huge mix shift
  return accel + oiTerm + shTerm;
}
function bidPhrase(b){
  // rec is clamped at 1.5; past 1.0 the honest read is "fully reclaimed and through the old high"
  // — (rec−1)·dip is exactly how far past it, in % of the peak. "150% reclaimed" reads as a bug.
  if(!(b&&b.d>0)) return '';
  const t = b.m<90 ? '~'+b.m+'m' : '~'+(b.m/60).toFixed(1)+'h';
  return b.r>=1
    ? `−${b.d.toFixed(2)}% dip fully reclaimed, +${((b.r-1)*b.d).toFixed(2)}% past the old high · ${t} since the low`
    : `${Math.round(b.r*100)}% of −${b.d.toFixed(2)}% reclaimed · ${t} since the low`;
}
// Chip stories (-05): the plain-English read of why a chip is on its list — the derivative-vs-level
// tension is the POINT of the strip (red names heat when someone buys the hole; green names cool
// when money leaves while the day still looks great), but it reads as a bug unless said out loud.
// Pure classifier: {tag, text} from the same numbers the chip shows. grouped flavors the wording.
function chipStory(kind, winRet, doi, rec, grouped){
  const u=grouped?'group':'name', U=grouped?'The group':'It';
  if(kind==='bid'){
    return rec!=null&&rec>=1
      ? {tag:'through the high', text:'The whole dip was bought back and price pushed PAST where it broke down from — the most aggressive demand print a tape gives. Not momentum: this is supply being absorbed faster than it appears.'}
      : {tag:'absorbing', text:'A real dip is being bought back quickly. Demand response, not momentum — a '+u+' can sit flat on the day while soaking up every dip, and that is the strongest bid on the board.'};
  }
  if(kind==='heat'){
    return (winRet!=null&&winRet<0)
      ? {tag:'turn attempt', text:U+' is still DOWN over the window — that is why the color is red — but the fast leg is outrunning the window\u2019s own pace: someone is buying this hole right now. Early by construction and unproven; by the time it is green, it has already moved. Judge it against '+(grouped?'breadth':'M')+'.'}
      : {tag:'extending', text:'Already up AND still outrunning its own pace — trend acceleration, not a bounce. The flow terms say whether new money agrees.'};
  }
  // cooling
  return (doi!=null&&doi<-2)
    ? {tag:'distribution', text:U+' is GREEN over the window — that is exactly the trap. The pace is dead and open interest is leaving: money walking out while the day still looks fine. The level will keep looking fine for days after the pace dies; this is the take-profit print no returns table can show.'}
    : {tag:'pause', text:'Pace has stalled but money has NOT left (\u0394OI flat or building) — digestion is as likely as exit. Watch the OI term: distribution starts when it turns.'};
}
// end action math (extraction marker — the tests slice from ACT_LEGS to this line and execute it)
function actTapeRet(rows, key){ let s=0,w=0,se=0,n=0;
  for(const r of rows){ const v=r[key]; if(v==null||!isFinite(v)) continue; se+=v; n++; const wt=r.vol>0?r.vol:0; if(wt>0){ s+=wt*v; w+=wt; } }
  return w>0?s/w:(n?se/n:null); }   // vol-weighted tape return per leg; equal-weight fallback when nothing carries volume
function actionScores(){
  const legs=ACT_LEGS[state.tf]||ACT_LEGS['1d'], fk=legs[0], fH=legs[1], wk=legs[2], wH=legs[3];
  let rows=thresholdRows(activeRows());
  if(state.grpDrill&&state.grpDrill.set) rows=rows.filter(r=>state.grpDrill.set.has(r.coin));   // the lists always describe exactly the rows the table shows
  const tf=actTapeRet(rows,fk), tw=actTapeRet(rows,wk);
  const scored=[];
  for(const r of rows){
    const fv=r[fk], wv=r[wk];
    const fastRel=(fv!=null&&isFinite(fv)&&tf!=null)?fv-tf:null;
    const winRel =(wv!=null&&isFinite(wv)&&tw!=null)?wv-tw:null;
    const accel=accelPace(fastRel,winRel,fH,wH);
    if(accel==null&&!r.bid) continue;
    const rv=(r.rvolByWin&&r.rvolByWin[wk]!=null)?r.rvolByWin[wk]:null;
    scored.push({ r, winRet:wv, winRel, accel, heat:heatOf(accel,r.doi,rv,wH), bid:r.bid||null });
  }
  return { scored, fk, fH, wk, wH, n:rows.length };
}
function actChip(s, kind){
  const r=s.r, mom=(r.mom!=null&&isFinite(r.mom))?(r.mom>0?'+':'')+Math.round(r.mom):'·';
  const ret=s.winRet==null?'·':(s.winRet>=0?'+':'')+s.winRet.toFixed(2)+'%';
  let why, tip, story=chipStory(kind, s.winRet, r.doi, s.bid?s.bid.r:null, false);
  if(kind==='bid'){
    why=bidPhrase(s.bid);
    tip=`${story.tag.toUpperCase()} — ${story.text}\n\ndip-reclaim off the 5m archive (last 4h): the deepest peak→trough dip and how much of it price clawed back.\nrank = dip × reclaimed ÷ √minutes — deep dips bought back fast outrank shallow slow ones.\nMOM ${mom} — level next to the derivative.`;
  } else {
    const parts=[`accel ${s.accel>=0?'+':''}${s.accel.toFixed(2)}`];
    if(r.doi!=null&&isFinite(r.doi)) parts.push(`ΔOI ${r.doi>=0?'+':''}${r.doi.toFixed(1)}%`);
    const rv=(r.rvolByWin&&r.rvolByWin[s._wk]!=null)?r.rvolByWin[s._wk]:null;
    if(rv!=null) parts.push(`RVOL ×${rv.toFixed(1)}`);
    why=parts.join(' · ');
    tip=`${story.tag.toUpperCase()} — ${story.text}\n\nheat ${s.heat>=0?'+':''}${s.heat.toFixed(2)} = accel + 0.6·tanh(ΔOI/8)${s._wH<=24?' + 0.4·clamp(RVOL−1,−1,2)':' (RVOL dropped — clock-matched, ≤1d only)'}\naccel = fast leg − window pace, both vs the tape (${s._fk} vs ${s._wk}).\nMOM ${mom} — the LEVEL: high MOM + this ${kind==='cool'?'stall is the take-profit read':'acceleration is confirmation'}.`;
  }
  return `<div class="achip" data-coin="${esc(r.coin)}" title="${esc(tip)}">
    <span class="tk">${esc(r.ticker)}</span><span class="${(s.winRet||0)>=0?'pos':'neg'} rt">${ret}</span>
    <span class="mm" title="momentum LEVEL (the board column) — printed so level and rate-of-change read together">M ${mom}</span>
    <span class="tag t-${kind==='bid'?(s.bid&&s.bid.r>=1?'thru':'abs'):(kind==='heat'?((s.winRet!=null&&s.winRet<0)?'turn':'ext'):((r.doi!=null&&r.doi<-2)?'dist':'pause'))}" title="${esc(story.text)}">${story.tag}</span>
    <span class="why">${why}</span></div>`;
}
// Group baseline share: each member's trailing ~30d volume summed per group, over the covered
// universe total — client-side from the daily tuples' v column, coverage disclosed in the hover.
function groupShareInputs(rows, mode, wt){
  const groups=computeMktGroups(rows, mode, wt);
  let allNow=0, allBase=0;
  const per=new Map();
  for(const g of groups){
    let base=0, cov=0;
    for(const r of g.members){ if(!r.daily) continue;
      let b=0,n=0; for(const k of r.daily){ const v=parseFloat(k.v); if(isFinite(v)&&v>0){ b+=v; n++; } }
      if(n>=5){ base+=b; cov++; } }
    per.set(g.name,{base,cov});
    allNow+=g.totVol||0; allBase+=base;
  }
  return {groups, per, allNow, allBase};
}
function groupActionScores(){
  const legs=ACT_LEGS[state.tf]||ACT_LEGS['1d'], fk=legs[0], fH=legs[1], wk=legs[2], wH=legs[3];
  const rows=thresholdRows(activeRows());
  const {groups, per, allNow, allBase}=groupShareInputs(rows, mktGrp(), state.grpWt);
  const tf=actTapeRet(rows,fk), tw=actTapeRet(rows,wk);   // the tape is still the NAMES — groups are measured against the same tape the names are
  const scored=[];
  for(const g of groups){
    if(g.name==='Unclassified'&&g.n<2) continue;
    // group fast leg: m15 isn't a lens column, so aggregate it here with the SAME weights
    let fv=null;
    if(fk==='m15'){ let sm=0,wm=0,eq=0,en=0; for(const r of g.members){ const v=r.m15; if(v==null||!isFinite(v)) continue; en++; eq+=v; const wt2=(state.grpWt!=='eq'&&r.vol>0)?r.vol:0; if(wt2>0){ sm+=wt2*v; wm+=wt2; } } fv=wm>0?sm/wm:(en?eq/en:null); }
    else fv=(g.agg[fk]&&g.agg[fk].v!=null)?g.agg[fk].v:null;
    const wv=(g.agg[wk]&&g.agg[wk].v!=null)?g.agg[wk].v:null;
    const fastRel=(fv!=null&&tf!=null)?fv-tf:null, winRel=(wv!=null&&tw!=null)?wv-tw:null;
    const accel=accelPace(fastRel,winRel,fH,wH);
    if(accel==null) continue;
    const sh=per.get(g.name)||{base:0,cov:0};
    const dSh=shareDeltaPp(g.totVol||0, allNow, sh.base, allBase);
    const shNow=allNow>0?100*(g.totVol||0)/allNow:null, shBase=allBase>0?100*sh.base/allBase:null;
    scored.push({ g, winRet:wv, winRel, accel, heat:groupHeatOf(accel, g.agg.doi?g.agg.doi.v:null, dSh),
      dSh, shNow, shBase, shCov:sh.cov, bid:null });
  }
  return { scored, fk, fH, wk, wH, n:groups.length };
}
function groupChip(s, kind){
  const g=s.g, ret=s.winRet==null?'·':(s.winRet>=0?'+':'')+s.winRet.toFixed(2)+'%';
  const br=(g.brN>0)?Math.round(100*g.brUp/g.brN)+'%':'·';
  const shTxt=(s.shNow!=null&&s.shBase!=null)?`share ${s.shNow.toFixed(1)}% vs ${s.shBase.toFixed(1)}% base (${s.dSh>=0?'+':''}${s.dSh.toFixed(1)}pp)`:'share n/a';
  const parts=[`accel ${s.accel>=0?'+':''}${s.accel.toFixed(2)}`];
  if(g.agg.doi&&g.agg.doi.v!=null) parts.push(`ΔOI ${g.agg.doi.v>=0?'+':''}${g.agg.doi.v.toFixed(1)}%`);
  parts.push(shTxt);
  const story=chipStory(kind, s.winRet, g.agg.doi?g.agg.doi.v:null, null, true);
  const tip=`${story.tag.toUpperCase()} — ${story.text}\n\ngroup heat ${s.heat>=0?'+':''}${s.heat.toFixed(2)} = accel + 0.6·tanh(ΔOI/8) + 0.4·tanh(Δshare/3)\naccel = group fast leg − group window pace, both vs the names tape.\nΔshare = today's slice of total volume vs this group's own ~30d baseline mix — zero-sum by construction: a group only gains tape someone else lost (baseline covers ${s.shCov}/${g.n} members with volume history).\nbreadth ${br} of members up over the window. Click = drill into the members.`;
  return `<div class="achip" data-grp="${esc(g.name)}" title="${esc(tip)}">
    <span class="tk">${esc(sectorShort(g.name))}</span><span class="${(s.winRet||0)>=0?'pos':'neg'} rt">${ret}</span>
    <span class="mm" title="breadth — members up over the window (groups have no MOM; breadth is the level check here)">B ${br}</span>
    <span class="tag t-${kind==='heat'?((s.winRet!=null&&s.winRet<0)?'turn':'ext'):((g.agg.doi&&g.agg.doi.v!=null&&g.agg.doi.v<-2)?'dist':'pause')}" title="${esc(story.text)}">${story.tag}</span>
    <span class="why">${parts.join(' · ')}</span></div>`;
}
function renderActionLists(){
  const aw=el('actwrap'); if(!aw) return;
  if(state.view!=='markets'){ aw.hidden=true; return; }
  aw.hidden=false;
  const hd=el('acthead'), bd=el('actbody'), meta=el('actmeta'), caret=el('actcaret');
  if(caret) caret.textContent=state.actOpen?'▾':'▸';
  if(hd) hd.setAttribute('aria-expanded', state.actOpen?'true':'false');
  if(bd) bd.hidden=!state.actOpen;
  const grouped=mktGrp()!=='names';
  const A=grouped?null:actionScores();
  const GA=grouped?groupActionScores():null;
  const picks=grouped?pickAction(GA.scored):pickAction(A.scored);
  // The bid column NEVER aggregates — a dip is an event in time; averaging member dips of
  // different depths at different moments describes nothing. In a lens it stays name-level,
  // computed over the same member universe the lens is aggregating, and says so.
  const NB=grouped?pickAction(actionScores().scored):null;
  const bidPicks=grouped?NB.bid:picks.bid;
  if(!grouped) for(const arr of [picks.heat,picks.cool,picks.bid]) for(const s of arr){ s._wk=A.wk; s._fk=A.fk; s._wH=A.wH; }
  else for(const s of bidPicks){ s._wk='d1'; s._fk='h4'; s._wH=24; }
  if(meta) meta.textContent=`${state.tf} window · ${grouped?GA.n+' '+(mktGrp()==='industries'?'industries':'sectors'):(A.n+' names')}${state.grpDrill?' · '+sectorShort(state.grpDrill.label):''}`;
  if(!state.actOpen||!bd) return;
  const empty=m=>`<div class="sec" style="padding:6px 2px">${m}</div>`;
  const render1=(arr,kind)=>arr.map(s=>grouped&&kind!=='bid'?groupChip(s,kind):actChip(s,kind)).join('');
  const col=(title,cls,tip,arr,kind,note)=>`<div class="acol"><div class="ah ${cls}" title="${esc(tip)}">${title}</div>`+
    (note?empty(note):(arr.length?render1(arr,kind):empty('nothing qualifies right now — an honest empty list, not a hidden one')))+`</div>`;
  const bidNote=state.scope==='crypto'
    ? 'equities only for now — the reclaim read rides the 5m archive tail the sweep lane already pulls per xyz name; spending sixty more archive reads per pass on the perp universe has not been earned yet'
    : null;
  const unit=grouped?(mktGrp()==='industries'?'industries':'sectors'):'names';
  bd.innerHTML =
    col(`HEATING — ${unit} starting to move`,'hup',grouped
      ?'group pace acceleration confirmed by flow: the group\u2019s fast leg outrunning its window pace (both vs the names tape), ΔOI building and its SHARE OF THE TAPE growing vs its own baseline mix — rotation is zero-sum, share only moves when the mix moves.'
      :'pace acceleration confirmed by flow: fast leg outrunning the window pace (both vs the tape), ΔOI and RVOL agreeing. What deserves attention it is not yet getting.',picks.heat,'heat',null)+
    col(`COOLING — had a trend, stalling`,'hcool',grouped
      ?'groups still AHEAD of the names tape over the window whose pace has died — the rotation exit: the group label keeps looking fine for days after the pace goes.'
      :'names still AHEAD of the tape over the window whose fast leg has stopped keeping pace. High MOM here is the take-profit read — the level looks fine for days after the pace dies.',picks.cool,'cool',null)+
    col(`STRONGEST BID — names, bought back fastest`,'hbid','the server\u2019s dip-reclaim claims: deepest recent dip, how much of it got reclaimed, how fast. Demand response, not momentum. Always name-level — a dip is an event in time, so it does not aggregate; in a lens this column ranks the same members the lens is averaging.',bidPicks,'bid',bidNote);
  bd.querySelectorAll('.achip').forEach(c=>{
    if(c.dataset.grp) c.addEventListener('click',()=>drillInto(c.dataset.grp));
    else c.addEventListener('click',()=>openDetail(c.dataset.coin));
  });
}
// True when the markets section is actually on screen: the Markets tab is the active view and the
// page itself is visible. The table, movers, regime strip and action lists all live in
// #view-markets, so this one predicate gates all four (build 2026.09.24-103).
function mktPaintable(){ return state.view==='markets'&&!(typeof document!=='undefined'&&document.hidden); }
// The full markets repaint a deferred (dirty) state owes: table/lens + action lists via render(),
// then the movers row and the regime strip. Called by showView('markets') and the foregrounding
// catch-up when G.mktDirty is set.
function paintMarkets(){ render(); updateMovers(); renderRegimeStrip(); }
function render(){
  if(!state.rows.size) return; computeDerived(); evaluateAlerts(); posDecorate();
  // Reconcile the note book against the digest riding the snapshot. The digest is authoritative:
  // if the counts disagree, somebody wrote from another browser and our bodies are behind. One
  // comparison per render, one fetch only when they actually diverge.
  // Bounded to ONE refetch per snapshot version. Without that bound a book that is legitimately
  // ahead of a cached snapshot (we just wrote; the next poll hasn't landed) would refetch forever
  // on a timer, because the mismatch it is reacting to cannot clear until a new snapshot arrives.
  if(G._notesSeenSnap!==state.dataTs&&notesStale()&&!_notesLoading){
    G._notesSeenSnap=state.dataTs;
    loadNotes().then(()=>{ render(); if(state.detail) renderDrawerNotes(state.detail);
      if(el('view-notes')&&!el('view-notes').hidden) renderNotes(); });
  }
  // Paint gate (build 2026.09.24-103). Everything above — derive, the in-browser alert evaluator,
  // position decoration, the notes reconcile — is state other tabs and the bell read, so it runs on
  // every call. Everything below is DOM that lives inside #view-markets: rebuilding a 140-row table
  // for a hidden section (another tab on top) or a hidden page (background tab on its 60s alert
  // pull) was pure waste. Mark it dirty instead; showView('markets') and the visibilitychange
  // catch-up call paintMarkets() once, which re-enters here and paints exactly what the latest
  // state says — the lens included.
  if(!mktPaintable()){ G.mktDirty=true; return; }
  G.mktDirty=false;
  if(mktGrp()!=='names'){ renderGroupBoard(); return; }   // the markets #body always mirrors the active lens, on every paint
  const body=el('body'), rows=sortedRows(), vc=visibleCols();
  const fc=el('fcount'); if(fc){ const tot=activeRows().length; fc.textContent=(rows.length!==tot)?`showing ${rows.length} of ${tot}`:''; }
  { const c2=el('fcount2'); if(c2){ const tot=activeRows().length; const on=[state.watchOnly&&'\u2605 only',state.noteOnly&&'\u25e2 noted'].filter(Boolean).join(' \u00b7 ');
      c2.hidden=rows.length===tot&&!on; c2.textContent=(rows.length!==tot?`${rows.length} of ${tot}`:'')+(on?(rows.length!==tot?' \u00b7 ':'')+on:''); } }
  if(!rows.length){ body.innerHTML=`<tr><td colspan="${vc.length}"><div class="msg"><span class="big">No matches</span>Clear the filters to see all markets.</div></td></tr>`; _rowCache=null; return; }
  const bScope=scopeBench();
  const out=[], coins=[];
  for(const r of rows){ out.push(rowHtml(r, vc, bScope)); coins.push(r.coin); }
  // Structural signature: row identity+order, visible columns, bench. \u0001/\u0002 separators can
  // never appear in a coin or column key, so the signature is collision-free by construction.
  const struct=coins.join('\u0001')+'\u0002'+vc.map(c=>c.key).join('\u0001')+'\u0002'+(bScope||'');
  const had=rowFocus(body);   // a row (or a control in it) holding keyboard focus is about to be replaced
  if(_rowCache && struct===_rowStruct && body.children.length===out.length){
    const oldHtml=coins.map(c=>_rowCache.get(c));
    patchRowsInto(body.children, oldHtml, out);
    for(let i=0;i<coins.length;i++) if(oldHtml[i]!==out[i]) _rowCache.set(coins[i], out[i]);
  } else {
    body.innerHTML=out.join('');
    _rowCache=new Map(); for(let i=0;i<coins.length;i++) _rowCache.set(coins[i], out[i]);
    _rowStruct=struct;
  }
  rowRefocus(body, had);
  applyKsel();   // rebuild wipes the j/k highlight; a patch may have replaced the selected row — re-pin either way
  renderActionLists();   // the rate-of-change lists under the table describe exactly what it just rendered
}
function updateMovers(){ const rows=activeRows().filter(r=>r.d1!=null&&isFinite(r.d1));
  if(rows.length<3){ el('movers').hidden=true; return; } el('movers').hidden=false;
  const byChg=[...rows].sort((a,b)=>b.d1-a.d1);
  const chip=r=>`<span class="chip ${r.d1>=0?'up':'down'}"><span class="t">${esc(r.ticker)}</span><span class="p">${fmtPct(r.d1).t}</span></span>`;
  el('movers-list').innerHTML=byChg.slice(0,3).map(chip).join('')+`<span style="width:1px;background:var(--border);margin:0 2px"></span>`+byChg.slice(-3).reverse().map(chip).join(''); }

// ===== market regime strip =====
// A tape-level readout above every tab. Breadth (share of names up) and dispersion (spread of
// returns) are computed live client-side and follow the window selector. Correlation is computed
// AND baselined server-side: the server samples mean pairwise 30d correlation across the top
// markets every 30 min, keeps ~90 days, and ships the current value plus its percentile in that
// history. So "0.55 · 88th pct" reads as "unusually correlated for this market" rather than a bare
// number whose absolute level means little.
function ordinal(n){ const v=n%100, s=(v>=11&&v<=13)?'th':(['th','st','nd','rd'][n%10]||'th'); return n+s; }
function computeRegime(){
  const tfKey=TF_MAP[state.tf]||'d1', rows=activeRows();
  const rets=rows.map(r=>r[tfKey]).filter(v=>v!=null&&isFinite(v));
  const breadth=rets.length?rets.filter(v=>v>0).length/rets.length:null;
  const dispersion=rets.length>=2?stdev(rets):null;
  // OI-weighted regime mix: where the open interest says positioning is going this window.
  // Aggregates the per-row regime tags nobody reads one-by-one into a single tape-level bar.
  const mix={}; let mixOI=0;
  for(const r of rows){ const rg=r.regime; if(!rg||!(r.oi>0)) continue;
    const m=mix[rg.l]||(mix[rg.l]={oi:0,n:0}); m.oi+=r.oi; m.n++; mixOI+=r.oi; }
  const sr=state.regimeSrv||{};
  return { breadth, dispersion, n:rets.length, mix, mixOI,
    corr:(sr.corr!=null?sr.corr:null), corrPct:(sr.corrPct!=null?sr.corrPct:null),
    corrN:sr.corrN||0, corrSamples:sr.corrSamples||0 };
}
function regimeLabel(g){
  if(g.breadth==null) return {t:'\u2014',cls:'sec',tip:'not enough data yet'};
  const p=g.corrPct, up=g.breadth, hi=p!=null&&p>=75, lo=p!=null&&p<=25;
  if(hi){
    if(up>=0.65) return {t:'risk-on block',cls:'pos',tip:`correlation unusually high (${ordinal(p)} pct of 90d) + broad gains \u2014 one factor lifting everything`};
    if(up<=0.35) return {t:'risk-off block',cls:'neg',tip:`correlation unusually high (${ordinal(p)} pct of 90d) + broad losses \u2014 one factor pressing everything`};
    return {t:'correlated',cls:'sec',tip:`correlation unusually high (${ordinal(p)} pct of 90d); direction is split`};
  }
  if(lo) return {t:'dispersed',cls:'blue',tip:`correlation unusually low (${ordinal(p)} pct of 90d) \u2014 names moving on their own stories (a stock-picker\u2019s tape)`};
  if(p==null) return (up>=0.65||up<=0.35)
    ? {t:up>=0.65?'broad bid':'broad offer',cls:up>=0.65?'pos':'neg',tip:'directional breadth; correlation baseline still building (needs a few hours of samples)'}
    : {t:'mixed',cls:'sec',tip:'no dominant direction; correlation baseline still building'};
  return {t:'mixed',cls:'sec',tip:`correlation mid-range (${ordinal(p)} pct of 90d)`};
}
// Crypto regime strip: the five numbers that describe a crypto tape, all from row data.
function renderCryptoStrip(box){
  const rows=activeRows().filter(r=>!r.delisted);
  if(rows.length<5){ box.hidden=true; return; }
  const btc=state.benchMain?state.rows.get(state.benchMain):null;
  let oiSum=0,fW=0,up=0,n=0,doiW=0,doiOi=0;
  for(const r of rows){
    if(r.d1!=null&&isFinite(r.d1)){ n++; if(r.d1>0)up++; }
    if(r.oi>0){ oiSum+=r.oi;
      if(r.funding!=null&&isFinite(r.funding)) fW+=r.funding*r.oi;
      const d=r.doiByWin?r.doiByWin.d1:null;
      if(d!=null&&isFinite(d)){ doiW+=d*r.oi; doiOi+=r.oi; } }
  }
  const fAPR=oiSum>0?(fW/oiSum)*24*365*100:null;
  const breadth=n?up/n:null;
  const doi1=doiOi>0?doiW/doiOi:null;
  let altUp=0,altN=0;
  if(btc&&btc.d7!=null&&isFinite(btc.d7)) for(const r of rows){ if(r.coin===btc.coin||r.d7==null||!isFinite(r.d7))continue; altN++; if(r.d7>btc.d7)altUp++; }
  const alt=altN>=10?altUp/altN:null;
  const fCls=fAPR==null?'sec':(fAPR>=15?'pos':(fAPR<=-5?'blue':'sec'));
  box.hidden=false;
  box.innerHTML=
    `<span class="rs-lab" data-tip="crypto tape \u00b7 aggregate state of the selected main-dex perps \u00b7 computed live from the table rows">CRYPTO TAPE</span>`
    +`<span class="rs-m" data-tip="crowd pays \u00b7 OI-weighted average funding APR across the universe \u00b7 strongly positive: longs pay to hold (euphoria tax) \u00b7 negative: shorts pay \u2014 squeeze fuel builds"><span class="rs-k">crowd pays</span><b class="${fCls}">${fAPR!=null?(fAPR>=0?'+':'')+fAPR.toFixed(1)+'% APR':'\u2014'}</b><span class="sec">${fAPR!=null?(fAPR>=0?'to be long':'to be short'):''}</span></span>`
    +`<span class="rs-m" data-tip="breadth \u00b7 share of the crypto universe up on the day"><span class="rs-k">breadth</span><b class="${breadth!=null&&breadth>=0.5?'pos':'neg'}">${breadth!=null?Math.round(breadth*100)+'%':'\u2014'}</b><span class="sec">up${n?` of ${n}`:''}</span></span>`
    +`<span class="rs-m" data-tip="total OI \u00b7 open interest summed across the universe \u00b7 with the OI-weighted 1d change: positioning building or leaving"><span class="rs-k">total OI</span><b>${fmtUsd(oiSum)}</b>${doi1!=null?`<span class="${doi1>=0?'pos':'neg'}">${doi1>=0?'+':''}${doi1.toFixed(1)}% 1d</span>`:''}</span>`
    +(btc&&btc.d1!=null?`<span class="rs-m" data-tip="BTC \u00b7 the benchmark\u2019s own day \u00b7 everything in this scope is measured against it"><span class="rs-k">BTC</span><b class="${btc.d1>=0?'pos':'neg'}">${btc.d1>=0?'+':''}${btc.d1.toFixed(1)}%</b></span>`:'')
    +`<span class="rs-m" data-tip="alt-season gauge \u00b7 share of non-BTC markets beating BTC over 7d \u00b7 \u226565% broad alt outperformance (alt season) \u00b7 \u226435% BTC dominance \u2014 alts bleeding against it \u00b7 needs \u226510 markets with 7d history"><span class="rs-k">alts &gt; BTC 7d</span><b class="${alt==null?'sec':(alt>=0.65?'pos':(alt<=0.35?'blue':'sec'))}">${alt!=null?Math.round(alt*100)+'%':'\u2014'}</b>${alt!=null?`<span class="sec">${alt>=0.65?'alt season':(alt<=0.35?'BTC regime':'mixed')}</span>`:''}</span>`;
}
function renderRegimeStrip(){
  if(state.scope==='crypto'){ const rg=el('regime'); if(rg) renderCryptoStrip(rg); return; }
  const box=el('regime'); if(!box) return;
  if(!state.rows.size){ box.hidden=true; return; }
  const g=computeRegime();
  if(g.breadth==null){ box.hidden=true; return; }
  box.hidden=false;
  const lab=regimeLabel(g), upN=Math.round(g.breadth*g.n), bw=Math.round(clamp(g.breadth,0,1)*100);
  const pctTxt=g.corrPct!=null?` <span class="sec">\u00b7 ${ordinal(g.corrPct)} pct</span>`:'';
  const corrCls=g.corrPct==null?'sec':(g.corrPct>=75?'pos':(g.corrPct<=25?'blue':'sec'));
  const corrTxt=g.corr==null?'<span class="na">loading\u2026</span>':`<b class="${corrCls}">${g.corr.toFixed(2)}</b>${pctTxt}`;
  const corrTip=g.corr==null?'mean 30d correlation \u00b7 pairwise across the top markets by volume (loading)'
    :`mean 30d correlation \u00b7 pairwise across the top ${g.corrN} by volume`+(g.corrPct!=null?` \u00b7 ranked against the last 90 days (${g.corrSamples} samples)`:` \u00b7 baseline still building (${g.corrSamples} samples)`);
  // OI-weighted positioning mix: stacked bar of regime shares + the dominant directional read
  const RG_CLS={'longs+':'rg-long','squeeze':'rg-sqz','shorts+':'rg-short','unwind':'rg-unw','flat':'rg-flat'};
  const RG_ORDER=['longs+','squeeze','shorts+','unwind','flat'];
  let mixHtml='';
  if(g.mixOI>0){ let segs='',domL=null,domV=0;
    for(const l of RG_ORDER){ const m=g.mix[l]; if(!m||!(m.oi>0)) continue;
      const sh=m.oi/g.mixOI;
      if(l!=='flat'&&sh>domV){domV=sh;domL=l;}
      segs+=`<span class="rs-mix-seg" data-tip="${esc(`${l} \u00b7 ${Math.round(sh*100)}% of open interest \u00b7 ${m.n} market${m.n===1?'':'s'}, ${fmtUsd(m.oi)} \u00b7 ${RG_STORY[l]||''}`)}" style="width:${(sh*100).toFixed(1)}%;background:${RG_COLOR[RG_CLS[l]]||'var(--faint)'}"></span>`; }
    mixHtml=`<span class="rs-m"><span class="rs-k" data-tip="positioning mix \u00b7 share of total OI in each price\u00d7OI regime over ${state.tf} \u00b7 is new money entering the complex (longs+/shorts+) or is positioning unwinding (squeeze/unwind)? \u00b7 hover each segment for detail">positioning</span>`+
      `<span class="rs-mix">${segs}</span>`+
      (domL?`<b class="${RG_CLS[domL]}" style="font-size:var(--fs-xs)" data-tip="largest non-flat regime by OI share">${Math.round(domV*100)}% ${esc(domL)}</b>`:'')+`</span>`; }
  box.innerHTML=
     `<span class="rs-lab ${lab.cls}" data-tip="${esc(lab.tip)}">${esc(lab.t)}</span>`
    +`<span class="rs-m" data-tip="share of markets up over ${state.tf} (${upN}/${g.n})"><span class="rs-k">breadth</span>`
      +`<span class="rs-bar"><span class="rs-bar-fill" style="width:${bw}%"></span></span>`
      +`<b class="${g.breadth>=0.5?'pos':'neg'}">${bw}%</b></span>`
    +`<span class="rs-m" data-tip="cross-sectional stdev of ${state.tf} returns \u2014 how spread out the moves are"><span class="rs-k">dispersion</span> <b>\u00b1${g.dispersion!=null?g.dispersion.toFixed(2):'\u2014'}%</b></span>`
    +mixHtml
    +`<span class="rs-m" data-tip="${esc(corrTip)}"><span class="rs-k">30d corr</span> ${corrTxt}</span>`;
}
export { adrCell, anchOpenCell, buildHead, carryCell, cdsHtml, clearDrill, colAdjacent, computeSqueeze, dcapCell, ddCell, ddyCell, dopenCell, drillMembers, gapCell, groupRowsSorted, hitCell, homeWallToEtMin, mktPaintable, momCell, mompCell, oiCell, openCell, paintMarkets, pctInner, premCell, railHtml, render, renderActionLists, renderRegimeStrip, rowSessState, rsCell, rvolCell, scCls, scheduleRender, sessCell, sessDrawerHtml, sessEx, setGrp, shade, sortedRows, sqzCell, syncGrpSeg, trendCell, updateDrillChip, updateMovers, visibleCols, volCell, vsTapeCell };
