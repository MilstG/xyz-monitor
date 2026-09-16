// focus.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { el, esc, fmtUsd, liveMark, store } from "./core.js";
import { fetchJSON } from "./data.js";


// ===== FOCUS tab (build 2026.08.15-01) ==========================================================
// Six seats, frozen at the cash open, one +1h fill at 10:30 ET, immutable for the rest of the day.
// Everything rendered here is the server's stamped payload RESTATED — the client re-derives
// nothing: gap/σ/RVOL/ΔOI/level distances and the +1h record all arrive frozen from /api/focus,
// and the chart's reference lines are those exact numbers. The only chart-local series is the
// plotted VWAP line, which is necessarily computed from the exact candles on screen (a continuous
// line cannot be shipped as one frozen scalar) and is labeled as the chart series; the frozen
// board sVWAP is restated verbatim in the modal header so any divergence is visible, not hidden.
const FOC={ data:null, timer:0, pollMs:0, sortK:null, sortDir:-1, showPrev:false, showBelow:false, order:null, vis:null };
const FOC_LS='xyz-focus-cols';
function focPrefsLoad(){ try{ const p=JSON.parse(store.get(FOC_LS)||'null');
  if(p&&Array.isArray(p.order)&&p.vis&&typeof p.vis==='object'){ FOC.order=p.order; FOC.vis=p.vis; } }catch(_){} }
function focPrefsSave(){ try{ store.set(FOC_LS, JSON.stringify({order:FOC.order, vis:FOC.vis})); }catch(_){} }
function focPx(v){ if(v==null||!isFinite(v)) return '—'; return v>=500?v.toFixed(1):v>=100?v.toFixed(2):v>=1?v.toFixed(3):v.toPrecision(4); }
function focSgn(v,d){ if(v==null||!isFinite(v)) return null; const n=v.toFixed(d==null?1:d); return (v>0?'+':'')+n; }
function focCls(v){ return v>0?'pos':v<0?'neg':''; }
// Why a frozen first-hour cell is empty. The record carries per-seat coverage since -04, so the
// dash can name its own cause: nothing captured, versus captured-but-nothing-printed. Older
// records carry no coverage and say exactly that rather than guessing at a reason.
function focDry(p){
  const cv=p&&p.h1cov;
  if(!cv) return 'no first-hour record for this name — this stamp predates per-seat coverage, so the cause is not recorded';
  if(cv.bars===0) return 'no 1m bars were captured for this name in the first hour — the seat lane landed nothing, or the feed served no print. Recorded as zero rather than filled from the mark.';
  return 'first-hour bars exist but carried no usable geometry';
}
function focNa(tip){ return `<span class="na" data-tip="${esc(tip||'not available — honest null, never a guess')}">—</span>`; }
// Chips: pure display assembly of the row's own stamped numbers — the WHY strip.
function focChips(p){
  const c=[];
  if(p.ern) c.push(['ern','ERN '+(p.ern==='bmo'?'BMO':'AMC'), p.ern==='bmo'?'Reported this morning before the open (Finnhub calendar)':'Reported yesterday after the close (Finnhub calendar)']);
  if(p.gapSigma!=null&&isFinite(p.gapSigma)&&Math.abs(p.gapSigma)>=0.7)
    c.push(['gap','GAP '+focSgn(p.gapPct)+'%', `${focSgn(p.gapSigma)}σ of this name's own overnight gaps (σ=${p.gapSd!=null?p.gapSd.toFixed(2)+'%':'—'})`]);
  if(p.rvol!=null&&p.rvol>=1.3) c.push(['rvol','RVOL '+p.rvol.toFixed(1)+'×','Clock-matched: this hour vs the same clock hour\u2019s prior-month median notional']);
  if(p.oiDelta!=null&&Math.abs(p.oiDelta)>=5) c.push(['oi','OI '+focSgn(p.oiDelta)+'%','Overnight change in open interest on the HIP-3 perp']);
  if(p.news24!=null&&p.news24>0){
    const age=(pub)=>{ const m=Math.max(1,Math.round((Date.now()-pub)/60000)); return m<60?m+'m':m<1440?Math.round(m/60)+'h':Math.round(m/1440)+'d'; };
    const lines=(p.newsTop||[]).map(n=>'['+(n[0]?'TG':'WIRE')+' '+age(n[2])+'] '+String(n[1]).replace(/ \u00b7 /g,' \u2022 '));
    if(p.tg4h) lines.push('\u26a1 your Telegram channel(s) named this ticker in the last 4h \u2014 TG items carry extra loudness weight (+0.5 each, cap 1.0, disclosed in compute)');
    lines.push('count + recency + source only \u2014 no sentiment scoring, direction is your read; full stories live on the News tab');
    c.push(['news'+(p.tg4h?' hot':''),'NEWS '+p.news24+(p.tg4h?' \u26a1':''), p.news24+' headline(s) in 24h \u2014 verbatim from the feed \u00b7 '+lines.join(' \u00b7 ')]);
  }
  if(p.lvlDistSd!=null) c.push([p.lvlDistSd>=1.5?'void':'lvl', (p.lvlDistSd>=1.5?'ROOM ':'LVL ')+p.lvlDistSd.toFixed(1)+'σ '+(p.lvlSide==='above'?'↑':'↓'),
    p.lvlDistSd>=1.5?`Nearest 30d extreme is ${p.lvlDistSd.toFixed(1)}σ ${p.lvlSide} — room to move`:`30d ${p.lvlSide==='above'?'high':'low'} only ${p.lvlDistSd.toFixed(1)}σ away — structure ${p.lvlSide==='above'?'overhead':'underfoot'}`]);
  if(p.cluster) c.push(['clu',esc(p.cluster),'Cluster (curated industry / sector): max 2 seats per cluster — names sharing it are likely the same trade today. Informational, never a gate on your picks.']);
  return `<span class="focchips">${c.map(x=>`<span class="focchip ${x[0]}" data-tip="${esc(x[2])}">${x[1]}</span>`).join('')}</span>`;
}
const FOC_COLS=[
  {k:'ticker', label:'TICKER', left:1, lock:1, tip:'The six seats, loudest first by default (the disclosed loudness score is the tiebreak ordering, not a signal). ▦ opens today\u2019s session chart. Drag any header to rearrange (press and hold on touch); ⚙ to show/hide. Foreign-home names (KRX/TSE/HKEX) never appear here — their gap anchors to the wrong exchange for a 09:30 ET stamp.',
   td:(p)=>`<td class="l focticker">${esc(p.ticker)}<button type="button" class="focchbtn" data-foct="${esc(p.ticker)}" data-tip="Session chart — 72h of 5m/15m/1h/4h candles from the local archive, off-session time dimmed, chart-series VWAP, and the frozen 1H HI/LO drawn verbatim">▦</button></td>`, sv:p=>p.ticker},
  {k:'why', label:'WHY', left:1, nosort:1, tip:'Why this name earned a seat — every chip restates a stamped number (hover for it). Chips appear only past their own noise floor; a quiet field is simply absent.',
   td:(p)=>`<td class="l">${focChips(p)}</td>`},
  {k:'px', label:'PX', tip:'LIVE price from the board\u2019s own streaming snapshot \u2014 the same number the Markets tab shows, by construction (one accessor, no second feed). Colored by the move vs the previous close, so the color carries the whole day including the gap. Refreshes with the tab (~1/min). Everything else on this row is frozen or forming reference \u2014 this column is where you are sitting against it; hover for \u0394 vs prev close, open, sVWAP and the 1H range position.',
   td:(p)=>{
     const lv=liveMark(p.coin);
     const h=p.h1;
     const px=lv!=null?lv:(h&&h.lastPx!=null?h.lastPx:null);
     if(px==null) return `<td>${focNa('no live mark and no archive print for this name')}</td>`;
     const dPc=p.prevClose>0?((px/p.prevClose-1)*100):null;
     const parts=[];
     if(dPc!=null) parts.push(`\u0394 prev close ${focSgn(dPc)}%`);
     const oAnchor=h&&h.openPx!=null?h.openPx:p.px;
     if(oAnchor>0) parts.push(`\u0394 ${h&&h.openPx!=null?'open':'stamp'} ${focSgn((px/oAnchor-1)*100)}%`);
     if(h&&h.vwap!=null) parts.push(`\u0394 sVWAP ${focSgn((px/h.vwap-1)*100)}%`);
     if(h&&h.hi>h.lo){
       parts.push(px>h.hi?`${focSgn((px/h.hi-1)*100)}% above the 1H HI`
         :px<h.lo?`${focSgn((px/h.lo-1)*100)}% below the 1H LO`
         :`inside the 1H range \u00b7 ${Math.round((px-h.lo)/(h.hi-h.lo)*100)}th pctile`);
     }
     if(lv==null) parts.push('live mark unavailable \u2014 showing the last archive print (stale)');
     return `<td class="${focCls(dPc)}${lv==null?' dim':''}" data-tip="${esc(parts.join(' \u00b7 ')||'live price')}">${focPx(px)}</td>`;
   }, sv:(p)=>{ const lv=liveMark(p.coin); return lv!=null?lv:(p.h1&&p.h1.lastPx!=null?p.h1.lastPx:null); }},
  {k:'open', label:'OPEN', h1:1, tip:'The session\u2019s OPENING print \u2014 the first 1m bar’s open at 09:30 ET, from the archive, not the stamp. Hover for the move off the previous close (the gap, realised) and where the day went from there. Frozen with the row at +1h.',
   td:(p)=>{ const h=p.h1; if(!h) return `<td>${focNa(focDry(p))}</td>`;
     if(h.openPx==null) return `<td>${focNa('the first-hour window carried no opening print')}</td>`;
     const g=p.prevClose>0?((h.openPx/p.prevClose-1)*100):null;
     const parts=[`09:30 print ${focPx(h.openPx)}`];
     if(g!=null) parts.push(`${focSgn(g)}% from the ${focPx(p.prevClose)} prev close`);
     if(p.closePx!=null) parts.push(`closed ${focSgn((p.closePx/h.openPx-1)*100)}% off it`);
     return `<td data-tip="${esc(parts.join(' \u00b7 '))}">${focPx(h.openPx)}</td>`; }, sv:p=>p.h1?p.h1.openPx:null},
  {k:'close', label:'CLOSE', tip:'The session\u2019s CLOSING print \u2014 the last 1m bar inside the cash window, read once at 16:00 ET and frozen. Dashes all day because it does not exist yet: a close is a measurement of a finished session, never the live price standing in for one (that lives in PX). The inline % is the move from THIS session’s open.',
   td:(p)=>{ const day=FOC._day;
     if(p.closePx==null){
       if(day&&day.closedAt){ const cv=p.closeCov;
         return `<td class="dry">${focNa(cv&&cv.bars===0?`no 1m bars were captured for ${p.ticker} inside the cash window \u2014 the seat lane landed nothing, so no close is claimed`:'session bars exist but carried no usable closing print')}</td>`; }
       // The session is OVER and no fill ever landed. "at close…" would be a promise the record
       // cannot keep, so it becomes a dash that says which silence this is. The fill is attempted
       // on every tick while the record sits in the prior slot, so this state normally lasts one
       // poll after a cold boot — it persists only once the record has aged out of that slot.
       if(day&&day.close&&Date.now()>=day.close)
         return `<td class="dry">${focNa('this session closed without its close ever being measured \u2014 no process was reading the archive while the record was reachable, and it is not reconstructed from a later or coarser print')}</td>`;
       return `<td class="focpend" data-tip="Fills once at the 16:00 ET close from the 1m archive, then frozen with the row. The live price is the PX column \u2014 it is not a close and is never shown as one.">at close\u2026</td>`; }
     const h=p.h1, d=h&&h.openPx>0?((p.closePx/h.openPx-1)*100):null;
     const cv=p.closeCov, slop=cv&&cv.slopMin!=null?cv.slopMin:null;
     const parts=[`16:00 print ${focPx(p.closePx)}`];
     if(d!=null) parts.push(`${focSgn(d)}% from the ${focPx(h.openPx)} open`);
     if(p.prevClose>0) parts.push(`${focSgn((p.closePx/p.prevClose-1)*100)}% from the prev close`);
     if(slop!=null&&slop>2) parts.push(`the archive\u2019s last bar sits ${slop}m before 16:00 \u2014 the lane did not reach the close`);
     if(day&&day.closeLate) parts.push(`read ${day.closeLate}m after the close \u2014 the same bounded window, taken late`);
     return `<td class="${slop!=null&&slop>2?'dim':''}" data-tip="${esc(parts.join(' \u00b7 '))}">${focPx(p.closePx)}${d!=null?` <span class="${focCls(d)}">(${focSgn(d)}%)</span>`:''}</td>`; },
   sv:p=>p.closePx!=null&&p.h1&&p.h1.openPx>0?((p.closePx/p.h1.openPx-1)*100):null},
  {k:'gap', label:'GAP', tip:'Overnight gap, raw % — previous session\u2019s TRUE close (half days close 13:00 ET; the calendar engine carries that) to the price at the stamp. The dim σ alongside is the same move in units of this name\u2019s OWN overnight-gap distribution: ±0.7σ is noise, ±2σ is an event regardless of the raw %.',
   td:(p)=>{ if(p.gapPct==null) return `<td>${focNa('no prior-close anchor in the spine')}</td>`;
     return `<td class="${focCls(p.gapPct)}" data-tip="${esc(`prev close ${focPx(p.prevClose)} → ${focPx(p.px)} at the stamp${p.gapSigma!=null?` · ${focSgn(p.gapSigma)}σ of its own gaps`:' · σ unavailable (fewer than 10 overnight samples)'}`)}">${focSgn(p.gapPct)}%${p.gapSigma!=null?`<span class="focsig">${focSgn(p.gapSigma)}σ</span>`:''}</td>`; }, sv:p=>p.gapPct},
  {k:'gapS', label:'GAP σ', vis0:0, tip:'The gap in σ units alone, sortable — hidden by default (GAP already carries it inline). Enable to sort by relative surprise instead of raw size.',
   td:(p)=>p.gapSigma==null?`<td>${focNa('fewer than 10 overnight-gap samples — no σ is claimed')}</td>`:`<td class="${focCls(p.gapSigma)}">${focSgn(p.gapSigma)}σ</td>`, sv:p=>p.gapSigma},
  {k:'rvol', label:'RVOL', tip:'Clock-matched relative volume at the stamp: the last clock hour vs the same clock hour\u2019s prior-month median notional — the pre-open read. 1.0× = normal for this time of day.',
   td:(p)=>p.rvol==null?`<td>${focNa('spine too short for a clock-matched norm')}</td>`:`<td>${p.rvol.toFixed(1)}×</td>`, sv:p=>p.rvol},
  {k:'oid', label:'OI Δ', tip:'Change in open interest over the overnight window (prev close → stamp) on the HIP-3 perp. Dash = the OI series is too sparse on this name to be honest, never a guessed zero.',
   td:(p)=>p.oiDelta==null?`<td>${focNa('OI history too sparse over the overnight window')}</td>`:`<td class="${focCls(p.oiDelta)}">${focSgn(p.oiDelta)}%</td>`, sv:p=>p.oiDelta},
  {k:'lvl', label:'→LVL', tip:'Distance to the nearer 30d extreme (high overhead or low underfoot, completed UTC days off the hourly spine) in σ of this name\u2019s own daily moves. Small = stamped into structure; ≥1.5σ = room. The finer level-map read lives on the ticker\u2019s drawer — this column is deliberately the cheap honest subset.',
   td:(p)=>p.lvlDistSd==null?`<td>${focNa('spine or σ too short for a level read')}</td>`:`<td class="dim" data-tip="${esc(`30d ${p.lvlSide==='above'?'high':'low'} is ${p.lvlDistSd.toFixed(1)}σ ${p.lvlSide}`)}">${p.lvlDistSd.toFixed(1)}σ</td>`, sv:p=>p.lvlDistSd},
  {k:'vwap', label:'sVWAP', h1:1, tip:'Session VWAP over the first hour (1m archive: Σ typical·vol ÷ Σ vol — the live mark is never folded in, a mark carries no volume), and where the 10:30 price sat vs it. Fills once at +1h, then frozen with the row.',
   td:(p)=>{ const h=p.h1; if(!h) return `<td>${focNa(focDry(p))}</td>`;
     if(h.vwap==null) return `<td>${focNa('archive bars carried no volume — VWAP not claimed (extremes still real)')}</td>`;
     const d=h.lastPx>0?((h.lastPx/h.vwap-1)*100):null;
     return `<td data-tip="${esc(`first-hour VWAP ${focPx(h.vwap)} · 10:30 print ${focPx(h.lastPx)}${d!=null?` (${focSgn(d)}% ${d>=0?'above':'below'})`:''}`)}">${focPx(h.vwap)}${d!=null?` <span class="${focCls(d)}">(${focSgn(d)}%)</span>`:''}</td>`; }, sv:p=>p.h1&&p.h1.vwap!=null&&p.h1.lastPx>0?((p.h1.lastPx/p.h1.vwap-1)*100):null},
  {k:'hi1', label:'1H HI', h1:1, tip:'Highest PRICE printed in the first hour after the open (1m archive, true bar extremes). Hover for the % from the archive open. Frozen at 10:30 ET.',
   td:(p)=>{ const h=p.h1; if(!h) return `<td>${focNa(focDry(p))}</td>`;
     const pc=h.openPx>0?((h.hi/h.openPx-1)*100):null;
     return `<td class="pos" data-tip="${esc(`${focPx(h.hi)}${pc!=null?` · ${focSgn(pc)}% from the ${focPx(h.openPx)} open`:''} · ${h.bars}/12 bars`)}">${focPx(h.hi)}</td>`; }, sv:p=>p.h1?p.h1.hi:null},
  {k:'lo1', label:'1H LO', h1:1, tip:'Lowest PRICE printed in the first hour after the open (1m archive, true bar extremes). Hover for the % from the archive open. Frozen at 10:30 ET.',
   td:(p)=>{ const h=p.h1; if(!h) return `<td>${focNa(focDry(p))}</td>`;
     const pc=h.openPx>0?((h.lo/h.openPx-1)*100):null;
     return `<td class="neg" data-tip="${esc(`${focPx(h.lo)}${pc!=null?` · ${focSgn(pc)}% from the ${focPx(h.openPx)} open`:''} · ${h.bars}/12 bars`)}">${focPx(h.lo)}</td>`; }, sv:p=>p.h1?p.h1.lo:null},
  {k:'rng', label:'1H RANGE', h1:1, nosort:1, tip:'The first hour as a bar: low→high span, grey tick = where the open sat in the hour\u2019s eventual range, amber tick = the 10:30 print (FROZEN \u2014 the live price lives in the PX column, never here). An open pinned to one end that closed at the other is the \u201cwho won the first hour\u201d read.',
   td:(p)=>{ const h=p.h1; if(!h) return `<td>${focNa(focDry(p))}</td>`;
     const rng=h.hi-h.lo; if(!(rng>0)) return `<td>${focNa('zero first-hour range')}</td>`;
     const op=h.openPx!=null?Math.min(100,Math.max(0,(h.openPx-h.lo)/rng*100)):null;
     const nw=h.lastPx!=null?Math.min(100,Math.max(0,(h.lastPx-h.lo)/rng*100)):null;
     return `<td data-tip="${esc(`${focPx(h.lo)} → ${focPx(h.hi)} · grey = open ${focPx(h.openPx)} · amber = 10:30 print ${focPx(h.lastPx)}, frozen (live price → PX column)`)}"><span class="focrbar"><span class="focrfill"></span>${op!=null?`<span class="focropen" style="left:${op.toFixed(0)}%"></span>`:''}${nw!=null?`<span class="focrnow" style="left:${nw.toFixed(0)}%"></span>`:''}</span></td>`; }},
];
function focCol(k){ return FOC_COLS.find(c=>c.k===k); }
function focActiveCols(){
  if(!FOC.order){ FOC.order=FOC_COLS.map(c=>c.k); }
  if(!FOC.vis){ FOC.vis={}; for(const c of FOC_COLS) FOC.vis[c.k]=c.vis0!==0; }
  for(const c of FOC_COLS){ if(FOC.order.indexOf(c.k)<0) FOC.order.push(c.k); if(!(c.k in FOC.vis)) FOC.vis[c.k]=c.vis0!==0; }   // a new build's column self-heals into saved prefs
  return FOC.order.map(focCol).filter(c=>c&&FOC.vis[c.k]);
}
function focStateLine(d){
  const day=FOC.showPrev?d.prev:d.today;
  if(FOC.showPrev&&d.prev) return `<span class="focstamp"><span class="focdot prev"></span>PRIOR LIST · ${esc(d.prev.day)}${d.prev.filledAt?' · +1H FILLED':''}</span>`;
  if(d.state==='preview'&&d.preview) return `<span class="focstamp pv"><span class="focdot pv"></span>PREVIEW · 09:00\u201309:30 ET · LIVE, NOT A RECORD · pool refreshed ${new Date(d.preview.at).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',second:'2-digit'})} ET</span>`;
  if(d.state==='pre') return `<span class="focstamp"><span class="focdot pre"></span>PRE-OPEN · stamps at the 09:30 ET open${d.open?` (${Math.max(0,Math.round((d.open-Date.now())/60000))}m)`:''}</span>`;
  if(d.state==='pending') return `<span class="focstamp"><span class="focdot pre"></span>OPEN PASSED · stamping on the next tick…</span>`;
  if(d.state==='cleared') return `<span class="focstamp"><span class="focdot prev"></span>CLEARED \u00b7 the day\u2019s list retired at 00:00 UTC${d.prev?` \u00b7 <span data-tip="the stamped record is kept, not deleted \u2014 it is one click away and unchanged">${esc(d.prev.day)} still readable via \u25c2</span>`:''}</span>`;
  if(d.state==='offday') return `<span class="focstamp"><span class="focdot prev"></span>NO SESSION TODAY${d.prev?` \u00b7 <span data-tip="no stamp happens on a non-session day; the last one is one click away via \u25c2">last list ${esc(d.prev.day)}</span>`:''}</span>`;
  if(day) return `<span class="focstamp"><span class="focdot"></span>FROZEN @ OPEN${day.late?' <span class="foclate" data-tip="Stamped after a boot that landed past 09:30 — the snapshot is later than the open and says so, same disclosure as boot-stamped episodes">LATE</span>':''} · stamped ${new Date(day.frozenAt).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'})} ET${day.filledAt?' · 1H CONFIRMED':' · sVWAP / 1H HI / 1H LO <span data-tip="forming — the hour so far from closed 5m bars with the live mark folded into hi/lo/last (never into VWAP: a mark has no volume); republished ~1/min and replaced wholesale by the frozen record at 10:30 ET">forming, freeze at +1h</span>'}</span>`;
  return '';
}
// ---- below-floor roster (build 2026.08.18-03) -------------------------------------------------
// The names that cleared the tape but failed the operator's size walls. NOT folded into the cut
// line: cuts are names that entered the ranking and lost on rank or the cluster cap, while these
// never entered it at all — calling both "cuts" would be a category error and would hide which
// mechanism did the refusing. Ordered loudest-first (server-side, on the record) so the top row is
// the loudest thing the wall is refusing; `need` is the multiple the floor must fall by to admit
// it, which is what turns the disclosure into a calibration instrument.
// Everything here is restated from the payload: the record carries its OWN limits, so yesterday's
// roster reads against yesterday's wall even after today's panel edit.
function focBelowHtml(src,lim){
  const rows=(src&&src.below)||[]; const total=(src&&src.belowN)||0;
  if(!total) return '';
  const L=lim||{vol:0,oi:0};
  const open=!!FOC.showBelow;
  const why=(w)=>w==='both'?['both','VOL+OI']:w==='vol'?['vol','VOL']:['oi','OI'];
  let h='<div class="focbf'+(open?' open':'')+'"><div class="focbf-h" id="focbfh" role="button" tabindex="0" aria-expanded="'+(open?'true':'false')+'" data-tip="'+esc('Cleared the tape, failed your size. Floors on this record: $'+Math.round(L.vol).toLocaleString('en-US')+' 24h volume / $'+Math.round(L.oi).toLocaleString('en-US')+' OI. Set them in the admin panel.')+'">'
    +'<span class="focbf-c">'+(open?'\u25be':'\u25b8')+'</span>BELOW FLOOR <b>'+total+'</b> \u2014 cleared the tape, failed your size</div>';
  if(open){
    h+='<table class="foctbl bf"><thead><tr><th class="l">Ticker</th><th class="l">Cluster</th>'
      +'<th data-tip="the same disclosed loudness formula the seats are ranked by">Loudness</th>'
      +'<th>Gap</th><th>RVOL</th>'
      +'<th data-tip="24h notional volume at the stamp">24h vol</th>'
      +'<th data-tip="open interest notional on the HIP-3 perp \u00b7 \u25cc = no honest read, which clears the OI floor by construction">OI</th>'
      +'<th class="l">Fails</th>'
      +'<th data-tip="how far the floor would have to fall to admit this name \u2014 1.2\u00d7 is a calibration question, 40\u00d7 is not">Needs</th></tr></thead><tbody>';
    for(const p of rows){ const w2=why(p.why);
      h+='<tr><td class="l">'+esc(p.ticker)+'</td><td class="l dim">'+esc(p.cluster||'\u2014')+'</td>'
        +'<td>'+(p.score!=null?p.score.toFixed(2):'\u2014')+'</td>'
        +'<td class="'+focCls(p.gapPct)+'">'+(p.gapPct!=null?focSgn(p.gapPct)+'%':'\u2014')+'</td>'
        +'<td>'+(p.rvol!=null?p.rvol.toFixed(1)+'\u00d7':'\u2014')+'</td>'
        +'<td data-tip="'+esc('floor $'+Math.round(L.vol).toLocaleString('en-US')+' \u00b7 this name '+fmtUsd(p.vol))+'">'+fmtUsd(p.vol)+'</td>'
        +'<td data-tip="'+esc(p.oi==null?'no honest OI read on this name \u2014 never cut on a number we do not have':'floor $'+Math.round(L.oi).toLocaleString('en-US')+' \u00b7 this name '+fmtUsd(p.oi))+'">'+(p.oi==null?'<span class="dim">\u25cc</span>':fmtUsd(p.oi))+'</td>'
        +'<td class="l"><span class="focbf-w '+w2[0]+'">'+w2[1]+'</span></td>'
        +'<td>'+(p.need!=null?p.need.toFixed(1)+'\u00d7':'\u2014')+'</td></tr>';
    }
    h+='</tbody></table>';
    if(total>rows.length) h+='<div class="focbf-n">+'+(total-rows.length)+' quieter name'+(total-rows.length===1?'':'s')+' below the floor \u2014 the roster discloses the loudest '+rows.length+' by design.</div>';
    h+='<div class="focbf-n">Refused on size, not on rank: these never entered the loudness ordering. Change the walls in the admin panel \u2014 it re-gates the preview immediately and the next stamp, never this record.</div>';
  }
  return h+'</div>';
}
function renderFocus(){
  const w=el('focuswrap'); if(!w||!FOC.data) return;
  const d=FOC.data;
  // The prior list renders ONLY when explicitly asked for. The old expression fell back to d.prev
  // in the pre/offday states, so overnight and all weekend the tab showed a stale list under
  // today's framing — and because focusPrev only rolled forward at the next stamp, in a
  // long-running process that stale list was the one from TWO sessions ago. An empty list is a
  // true statement about the day; a silently substituted one is not.
  const day=FOC.showPrev?(d.prev||null):(d.today||null);
  // PREVIEW (build 2026.08.15-02): the 09:00 prep pool — its own render path. Rank column, ten
  // rows, a dashed rule after the likely six, dimmed below it. No sorting, no drag, no h1
  // columns: a live pool re-ranks itself; user reordering of a list that reshuffles under the
  // cursor is churn, not control. The stamp table keeps all of that as before.
  if(!FOC.showPrev&&d.state==='preview'&&d.preview&&Array.isArray(d.preview.rows)){
    const pcols=focActiveCols().filter(c=>!c.h1);
    let html=`<div class="focbar preview">${focStateLine(d)}<span class="focnote">Top ${d.previewN||10} by loudness, re-ranked as the pre-market tape moves. Cluster cap NOT applied \u2014 this is the prep pool; the dashed rule marks the likely six. Nothing here persists; only the 09:30 stamp is a record.</span><span class="focsp"></span><button type="button" class="btn xtiny" id="focgear" data-tip="Show/hide columns \u2014 shared with the stamped table\u2019s layout">\u2699 columns</button></div>`;
    html+=`<table class="foctbl pv"><thead><tr><th class="l" data-tip="preview rank by loudness \u2014 the same disclosed formula the stamp uses">#</th>`
      +pcols.map(c=>`<th class="${c.left?'l':''}" data-tip="${esc(c.tip)}">${c.label}</th>`).join('')+`</tr></thead><tbody>`;
    d.preview.rows.forEach((p,i)=>{
      html+=`<tr class="${i>=(d.cap||6)?'focbelow':''}"><td class="l focrank">${i+1}</td>`+pcols.map(c=>c.td(p)).join('')+`</tr>`;
      if(i===(d.cap||6)-1) html+=`<tr class="foccutrule"><td colspan="${pcols.length+1}" data-tip="the stamp cut zone: at 09:30 the ${d.perCluster||2}-per-cluster cap applies and the list freezes at ${d.cap||6}"></td></tr>`;
    });
    html+=`</tbody></table>`+focBelowHtml(d.preview,(d.preview&&d.preview.limits)||d.limits)+`<div class="focfoot">Gap is the LIVE in-progress read vs the last cash close \u2014 still moving until the bell. If the stamp differs from this preview, the open banner will say exactly how.</div>`;
    w.innerHTML=html; focWireBar();
    w.querySelectorAll('.focchbtn').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation(); focChartOpen(b.dataset.foct); }));
    return;
  }
  let html=`<div class="focbar">${focStateLine(d)}`
    // SHORT STAMP (build 2026.08.18-03): fewer than the cap because the floors refused the rest,
    // stated on the bar rather than left to be read as a bug. Only when the record actually
    // carries the scan counts — an older stamp predates them and claims nothing.
    +(day&&day.rows&&day.cleared!=null&&day.rows.length<(d.cap||6)
      ? `<span class="focnote short" data-tip="${esc(`only ${day.cleared} of ${day.scanned} eligible names cleared the liquidity floors in force at the stamp ($${Math.round((day.limits&&day.limits.vol)||0).toLocaleString('en-US')} 24h volume / $${Math.round((day.limits&&day.limits.oi)||0).toLocaleString('en-US')} OI). The list seats what cleared — it is never padded, and the booting-universe check reads the pre-floor count so this is not a cold start.`)}"><b>${day.rows.length} of ${d.cap||6} seats</b> — ${day.cleared} name${day.cleared===1?'':'s'} cleared your floors</span>`:'')
    +(day&&day.fillNote?`<span class="focnote err" data-tip="the +1h columns need the on-disk 5m archive">${esc(day.fillNote)}</span>`:'')
    +(day&&day.pvDiff&&((day.pvDiff.added||[]).length||(day.pvDiff.dropped||[]).length)?`<span class="focdiff" data-tip="${esc(`the tape moved between the ${new Date(day.pvDiff.pvAt).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'})} ET preview and the bell \u2014 disclosed so your prep never silently drifts from the record`)}"><b>\u0394 vs preview:</b> ${(day.pvDiff.added||[]).map(t=>'+'+esc(t)).concat((day.pvDiff.dropped||[]).map(t=>'\u2212'+esc(t))).join(' ')}</span>`:'')
    +(day&&day.pvDiff&&!(day.pvDiff.added||[]).length&&!(day.pvDiff.dropped||[]).length?`<span class="focnote" data-tip="the frozen six match the last preview\u2019s likely six exactly">stamp = preview</span>`:'')
    +`<span class="focsp"></span>`
    +(d.prev?`<button type="button" class="btn xtiny" id="focprev" data-tip="Toggle the last stamped list — what you were watching, exactly as stamped. Gated on d.prev alone: once the 00:00 UTC clear retires today\u2019s list there IS no d.today, and gating on it would take the toggle away at exactly the moment it is the only way back to the record.">${FOC.showPrev?(d.today?'◂ today':'◂ close'):'◂ '+esc(d.prev.day)}</button>`:'')
    +`<button type="button" class="btn xtiny" id="focgear" data-tip="Show/hide columns — same model as the Markets column menu. Drag headers directly to rearrange; the layout persists per browser.">⚙ columns</button>`
    +`</div>`;
  if(!day){ html+=`<div class="msg">${
    d.state==='cleared'?`Today\u2019s list retired at the 00:00 UTC boundary. The next one stamps at the 09:30 ET open${d.prev?` \u2014 ${esc(d.prev.day)} is still readable via \u25c2 above`:''}.`
    :d.state==='offday'?`No cash session today, so no list stamps${d.prev?` \u2014 ${esc(d.prev.day)} is still readable via \u25c2 above`:''}.`
    :d.state==='pre'?`The list stamps at the open \u2014 nothing to show yet today${d.prev?`; ${esc(d.prev.day)} is readable via \u25c2 above`:', and no prior list is stored'}.`
    :'No focus list stored yet. The first stamp lands at the next cash open.'}</div>`;
    w.innerHTML=html; focWireBar(); return; }
  const filled=!!day.filledAt;
  // The record being rendered, reachable from the column builders. The CLOSE column's dash has two
  // different meanings — "the session has not closed yet" and "it closed and this seat had no bars"
  // — and only the day-level record can tell them apart. A column that cannot distinguish those is
  // the same category error the h1 coverage work removed.
  FOC._day=day;
  const cols=focActiveCols();
  let rows=[...day.rows];
  const sc=FOC.sortK&&focCol(FOC.sortK);
  if(sc&&sc.sv){ rows.sort((a,b)=>{ const x=sc.sv(a),y=sc.sv(b);
    if(x==null&&y==null)return 0; if(x==null)return 1; if(y==null)return -1;
    return (typeof x==='string'?String(x).localeCompare(String(y)):x-y)*FOC.sortDir; }); }
  // default order = the stamped order (loudest first, already sorted server-side by focusSelect)
  html+=`<table class="foctbl"><thead><tr>`+cols.map(c=>
    `<th class="${c.left?'l':''}" draggable="${c.lock?'false':'true'}" data-fock="${c.k}" data-tip="${esc(c.tip)}">${c.label}${FOC.sortK===c.k?`<span class="focarr">${FOC.sortDir<0?'▼':'▲'}</span>`:''}</th>`).join('')
    +`</tr></thead><tbody>`;
  for(const p of rows){
    html+=`<tr>`+cols.map(c=>{
      if(c.h1&&!filled){
        // forming edition (build 2026.08.17-03): the hour so far — closed 5m bars + the live
        // mark — restyled as forming and replaced wholesale by the frozen record at 10:30.
        const f=(!FOC.showPrev&&d.forming&&d.forming.map&&d.forming.map[p.ticker])||null;
        if(f) return c.td({...p,h1:f}).replace('<td','<td data-forming="1"');
        // NO BARS is a statement, not a blank (build 2026.08.18-04). Before this, a seat with an
        // empty window still rendered numbers: foldLiveMark synthesised hi = lo = last from the
        // mark, so the row printed a flat line at the current price that was indistinguishable
        // from a real first-hour read. The mark can widen a measurement; it cannot be one.
        const cv=(!FOC.showPrev&&d.forming&&d.forming.cov&&d.forming.cov[p.ticker])||null;
        if(cv&&cv.bars===0&&cv.mins>=2)
          return `<td class="focpend dry" data-tip="${esc(`no 1m bars captured for ${p.ticker} in the ${cv.mins} minute(s) since the open — the dedicated seat lane has landed nothing for this name, or the feed served no print. Deliberately NOT the mark: a flat high = low = price reads exactly like a real measurement and is not one.`)}">no bars</td>`;
        return `<td class="focpend" data-tip="Fills once at +1h from the 1m opening-hour archive, then the row is frozen for the day — forming reads appear once the first 1m bar closes">+1h…</td>`;
      }
      return c.td(p);
    }).join('')+`</tr>`;
  }
  html+=`</tbody></table>`;
  if(Array.isArray(day.cuts)&&day.cuts.length){
    html+=`<div class="foccut"><b>CAPPED AT ${d.cap||6}</b> — a great selection, not a big one. Just missed: `
      +day.cuts.map(c=>`<span class="foccutn" data-tip="${esc(`score ${c.score!=null?c.score.toFixed(2):'—'}${c.gapPct!=null?` · gap ${focSgn(c.gapPct)}%`:''}${c.rvol!=null?` · RVOL ${c.rvol.toFixed(1)}×`:''}${c.why==='cluster'?` · cut on the ${d.perCluster||2}-per-cluster cap (${c.cluster||'?'} already seated)`:' · below the cap by rank'}`)}">${esc(c.ticker)}</span>`).join(' · ')
      +`</div>`;
  }
  html+=focBelowHtml(day,day.limits||d.limits);
  // The floors quoted here are the RECORD'S OWN (day.limits), not the live ones: this list was cut
  // against the wall that stood at its stamp, and restating today's panel value under yesterday's
  // list would misdescribe how it was made. Records predating -03 carry none and say so.
  const fl=day.limits||null;
  html+=`<div class="focfoot">Frozen list — stamped once at the cash open, one fill at +1h, never reshuffled intraday. Equities on the ET clock only; max ${d.perCluster||2} seats per cluster; `
    +(fl?`liquidity floors ${fmtUsd(fl.vol)} 24h volume / ${fmtUsd(fl.oi)} OI${day.cleared!=null?` (${day.cleared} of ${day.scanned} eligible names cleared)`:''}`
        :`liquidity floors not recorded on this stamp — it predates the floor panel`)
    +`. First-hour geometry (sVWAP · 1H HI · 1H LO) is measured on <b>1m</b> bars from a capture lane reserved for the seated names, republished every ${Math.round((d.formingMs||25000)/1000)}s while forming and frozen at +1h. Every σ is the name\u2019s own distribution. Dashes are honest nulls — a seat with no bars says so rather than showing the mark.</div>`;
  w.innerHTML=html;
  focWireBar(); focWireTable();
}
function focWireBar(){
  const g=el('focgear'); if(g) g.onclick=(e)=>{ e.stopPropagation(); focMenuToggle(g); };
  const pv=el('focprev'); if(pv) pv.onclick=()=>{ FOC.showPrev=!FOC.showPrev; renderFocus(); };
  // Roster fold. Collapsed by default: the refused set is a calibration instrument you reach for
  // deliberately, not a permanent second table competing with the six seats for attention.
  const bf=el('focbfh');
  if(bf){ const t=()=>{ FOC.showBelow=!FOC.showBelow; renderFocus(); };
    bf.onclick=t; bf.onkeydown=(e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); t(); } }; }
}
let _focDragK=null;
// ONE mutation for both input paths (2026.08.19-05). The mouse path and the touch path differ only
// in how they decide "this column, dropped on that side"; the reorder itself must not be written
// twice, or the two ways of moving a column drift apart and only one of them gets tested.
function focMoveCol(dragK,targetK,before){
  if(!dragK||!targetK||dragK===targetK) return false;
  const t=focCol(targetK);
  if(t&&t.lock) return false;               // a locked column is not a drop target either
  // Validate FIRST, mutate second. Removing the dragged key and only then discovering the target
  // is unknown drops a column off the board entirely — the order is the user's saved preference,
  // and a refused gesture must leave it exactly as it was.
  const next=FOC.order.filter(x=>x!==dragK);
  if(next.length===FOC.order.length) return false;        // the dragged column is not in the order
  const i=next.indexOf(targetK);
  if(i<0) return false;
  next.splice(before?i:i+1,0,dragK);
  FOC.order=next; focPrefsSave(); return true;
}
// TOUCH REORDER (2026.08.19-05). HTML5 drag events never fire on touch, so on a phone the headers
// were simply immovable — the ⚙ menu could hide a column but nothing could move one. This is the
// same gesture expressed in pointer events: press and hold, then drag. The hold matters — a short
// press is a SORT, and stealing every tap for a drag would break the primary interaction to add a
// secondary one. Once held, the scroll is suppressed for that pointer only, and releasing outside
// any header cancels rather than dropping somewhere arbitrary.
const FOC_HOLD_MS=380, FOC_SLOP=10;
function focWireTouchDrag(th,k,c){
  if(c&&c.lock) return;
  let hold=null,armed=false,x0=0,y0=0,pid=null;
  const hdrAt=(x,y)=>{ const e=document.elementFromPoint(x,y); return e?e.closest('th[data-fock]'):null; };
  const clear=()=>{ if(hold) clearTimeout(hold); hold=null;
    th.closest('table')?.querySelectorAll('th[data-fock]').forEach(o=>o.classList.remove('focdrop-l','focdrop-r'));
    th.classList.remove('focdrag'); };
  const end=(drop,x)=>{
    const was=armed; armed=false; _focDragK=null;
    if(drop&&was){ const tgt=hdrAt(x,th.getBoundingClientRect().top+2);
      if(tgt&&tgt!==th){ const r=tgt.getBoundingClientRect();
        if(focMoveCol(k,tgt.dataset.fock,x<r.left+r.width/2)){ clear(); renderFocus(); return; } } }
    clear(); if(was) renderFocus(); };
  th.addEventListener('pointerdown',e=>{ if(e.pointerType==='mouse') return;   // the mouse keeps the native path
    pid=e.pointerId; x0=e.clientX; y0=e.clientY; armed=false;
    hold=setTimeout(()=>{ armed=true; _focDragK=k; th.classList.add('focdrag');
      try{ th.setPointerCapture(pid); }catch(_){}
      if(navigator.vibrate) try{ navigator.vibrate(8); }catch(_){}
    },FOC_HOLD_MS); });
  th.addEventListener('pointermove',e=>{
    if(!armed){ if(hold&&(Math.abs(e.clientX-x0)>FOC_SLOP||Math.abs(e.clientY-y0)>FOC_SLOP)){ clearTimeout(hold); hold=null; } return; }
    e.preventDefault();                       // held: this pointer drags the column, it does not scroll
    const tgt=hdrAt(e.clientX,th.getBoundingClientRect().top+2);
    th.closest('table')?.querySelectorAll('th[data-fock]').forEach(o=>o.classList.remove('focdrop-l','focdrop-r'));
    if(tgt&&tgt!==th){ const r=tgt.getBoundingClientRect(), left=e.clientX<r.left+r.width/2;
      tgt.classList.toggle('focdrop-l',left); tgt.classList.toggle('focdrop-r',!left); } });
  th.addEventListener('pointerup',e=>{ if(e.pointerType==='mouse') return; end(true,e.clientX); });
  th.addEventListener('pointercancel',e=>{ if(e.pointerType==='mouse') return; end(false,0); });
}
function focWireTable(){
  const w=el('focuswrap'); if(!w) return;
  w.querySelectorAll('th[data-fock]').forEach(th=>{
    const k=th.dataset.fock, c=focCol(k);
    th.addEventListener('click',()=>{ if(!c||c.nosort||_focDragK) return;   // a drag is not a sort
      if(FOC.sortK===k) FOC.sortDir*=-1; else { FOC.sortK=k; FOC.sortDir=-1; } renderFocus(); });
    th.addEventListener('dragstart',e=>{ _focDragK=k; th.classList.add('focdrag'); e.dataTransfer.effectAllowed='move'; });
    th.addEventListener('dragend',()=>{ _focDragK=null; renderFocus(); });
    th.addEventListener('dragover',e=>{ if(!_focDragK||_focDragK===k) return; e.preventDefault();
      const r=th.getBoundingClientRect(), left=e.clientX<r.left+r.width/2;
      th.classList.toggle('focdrop-l',left); th.classList.toggle('focdrop-r',!left); });
    th.addEventListener('dragleave',()=>th.classList.remove('focdrop-l','focdrop-r'));
    th.addEventListener('drop',e=>{ e.preventDefault(); if(!_focDragK||_focDragK===k) return;
      const r=th.getBoundingClientRect();
      focMoveCol(_focDragK,k,e.clientX<r.left+r.width/2);
      _focDragK=null; renderFocus(); });
    focWireTouchDrag(th,k,c);
  });
  w.querySelectorAll('.focchbtn').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation(); focChartOpen(b.dataset.foct); }));
}
function focMenuToggle(anchor){
  let m=el('focmenu');
  if(m&&!m.hidden){ m.hidden=true; return; }
  if(!m){ m=document.createElement('div'); m.id='focmenu'; document.body.appendChild(m);
    document.addEventListener('click',e=>{ const mm=el('focmenu'); if(mm&&!mm.hidden&&!mm.contains(e.target)) mm.hidden=true; }); }
  focActiveCols();   // ensure order/vis exist
  m.innerHTML=`<div class="focm-h">COLUMNS</div>`+FOC_COLS.map(c=>
    `<label class="${c.lock?'lock':''}"><input type="checkbox" ${FOC.vis[c.k]?'checked':''} ${c.lock?'disabled':''} data-fock="${c.k}">${c.label}${c.h1?' <span class="focsig">+1h</span>':''}</label>`).join('')
    +`<div class="focm-note">GAP σ is hidden by default — the GAP column carries it inline. Drag headers on the table to reorder; both persist per browser.</div>`;
  m.querySelectorAll('input').forEach(i=>i.addEventListener('change',()=>{ FOC.vis[i.dataset.fock]=i.checked; focPrefsSave(); renderFocus(); }));
  const r=anchor.getBoundingClientRect();
  m.style.left=Math.min(r.left, window.innerWidth-230)+'px'; m.style.top=(r.bottom+6)+'px';
  m.hidden=false;
}
function openFocus(){
  focPrefsLoad();
  focFetch();
  focArmPoll();
}
// Poll cadence follows the SERVER's republish rhythm (payload formingMs), not a constant here: a
// board polling at 60s against a 25s republish is not live, it just looks it. Fast only while the
// hour is forming — the frozen record cannot change, so paying 30s for it would be pure noise.
function focArmPoll(){
  const want=(FOC.data&&FOC.data.state==='frozen'&&FOC.data.today&&!FOC.data.today.filledAt)
    ? Math.max(10000,(FOC.data.formingMs||25000)+5000) : 60000;
  if(FOC.timer&&FOC.pollMs===want) return;
  if(FOC.timer) clearInterval(FOC.timer);
  FOC.pollMs=want;
  FOC.timer=setInterval(()=>{ const v=el('view-focus'); if(v&&!v.hidden) focFetch(); },want);
}
async function focFetch(){
  try{ const d=await fetchJSON('/api/focus'); FOC.data=d; renderFocus(); focArmPoll(); }
  catch(e){ const w=el('focuswrap'); if(w&&!FOC.data) w.innerHTML=`<div class="msg err"><span class="big">Couldn't load the focus list</span>${esc((e&&e.message)||'network error')}. Will retry on the next interval.</div>`; }
}
// ---- FOCUS chart modal ------------------------------------------------------------------------
// (superseded note, kept for history: the -02 chart pulled 1m live; see the -01 block below)
// aggregate from that ONE base client-side — one source, three views. Reference lines (open,
// frozen 1H HI/LO) are the payload's numbers verbatim; the VWAP LINE is the chart series
// (cumulative from the candles on screen, session-anchored at the open, labeled as such), with
// the frozen board sVWAP restated in the header so the two are side by side, never conflated.
// Re-sourced 2026.08.17-01: 72h lookback from the local 5m ARCHIVE (the same series the +1h
// fill reads — board and chart share one source, no live pull). 3m retired; 5m/15m/1h/4h all
// aggregate from the 5m base with buckets anchored at today's open. Off-session time is dimmed
// from the server's calendar windows, never a guessed fixed rhythm. Default 15m: 288 bars over
// 72h reads; 864 five-minute bars are one click away for the microstructure look.
const FOCCH_HOURS=72;
const FOCCH={ p:null, day:null, tf:15, base:null, baseFrom:0, baseTo:0, agg:null, view:{from:0,to:0}, hover:null };
function focChartEnsureDom(){
  if(el('focmodal')) return;
  const d=document.createElement('div'); d.id='focmodal'; d.hidden=true;
  d.innerHTML=`<div id="focwin">
    <div class="focch-head"><span class="focch-t" id="focch-t"></span><span class="focch-sub" id="focch-sub"></span><span class="focch-view" id="focch-view"></span>
      <span class="focch-tf"><button type="button" data-foctf="5">5M</button><button type="button" data-foctf="15" class="on">15M</button><button type="button" data-foctf="60">1H</button><button type="button" data-foctf="240">4H</button></span>
      <button type="button" class="focch-x" id="focch-x" data-tip="close (Esc)">✕</button></div>
    <div class="focch-leg"><span><i class="fk" style="border-color:var(--acc2,#4da3d8)"></i>VWAP (chart series, per session)</span><span><i class="fk d" style="border-color:var(--up)"></i>1H HI (frozen)</span><span><i class="fk d" style="border-color:var(--down)"></i>1H LO (frozen)</span><span><i class="fk d" style="border-color:var(--muted)"></i>open</span><span class="dim">dark bands = off-session (from the calendar engine) · frozen lines live inside their own session · wheel/pinch = zoom at cursor · drag = pan · double-click = reset</span></div>
    <div id="focch-read">hover for OHLC · chart VWAP · Δ from open</div>
    <div id="focch-wrap"><canvas id="focch-cc"></canvas></div>
    <div id="focch-vbar" data-tip="the 72h base — the highlighted span is your viewport; drag it to pan"><div id="focch-vwin"></div></div></div>`;
  document.body.appendChild(d);
  d.addEventListener('click',e=>{ if(e.target.id==='focmodal') focChartClose(); });
  el('focch-x').onclick=focChartClose;
  d.querySelectorAll('[data-foctf]').forEach(b=>b.onclick=()=>{ FOCCH.tf=+b.dataset.foctf; FOCCH.agg=null;
    d.querySelectorAll('[data-foctf]').forEach(x=>x.classList.toggle('on',x===b));
    focChartResetView(); focChartDraw(); });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&el('focmodal')&&!el('focmodal').hidden) focChartClose(); });
  // ---- viewport interactions (build 2026.08.17-02) --------------------------------------------
  // One fetch, everything else is viewport math over the cached 72h base: wheel (or pinch) zooms
  // about the cursor time, dragging pans, double-click resets to the timeframe's default window.
  // Pointer events carry mouse AND touch through one code path — a single touch drags to pan (a
  // sub-6px tap sets the crosshair instead), two touches pinch about their midpoint.
  const cc=el('focch-cc');
  const timeAt=(clientX)=>{ const g=FOCCH._geom, r=cc.getBoundingClientRect();
    if(!g) return FOCCH.view.from;
    const frac=Math.min(1,Math.max(0,(clientX-r.left-g.padL)/(g.W-g.padL-g.padR)));
    return FOCCH.view.from+frac*(FOCCH.view.to-FOCCH.view.from); };
  cc.addEventListener('wheel',e=>{ e.preventDefault();
    const z=e.deltaY>0?1.18:1/1.18, c=timeAt(e.clientX);
    FOCCH.view={ from:c-(c-FOCCH.view.from)*z, to:c+(FOCCH.view.to-c)*z };
    focChartClampView(); focChartDraw(); },{passive:false});
  cc.addEventListener('dblclick',()=>{ focChartResetView(); focChartDraw(); });
  const ptrs=new Map(); let panRef=null, pinchRef=null;
  cc.addEventListener('pointerdown',e=>{ cc.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY,x0:e.clientX,y0:e.clientY});
    if(ptrs.size===1) panRef={x:e.clientX, from:FOCCH.view.from, to:FOCCH.view.to};
    if(ptrs.size===2){ const [a,b]=[...ptrs.values()];
      pinchRef={ d:Math.max(20,Math.abs(a.x-b.x)), from:FOCCH.view.from, to:FOCCH.view.to, mid:timeAt((a.x+b.x)/2) };
      panRef=null; } });
  cc.addEventListener('pointermove',e=>{
    const pt=ptrs.get(e.pointerId);
    if(pt){ pt.x=e.clientX; pt.y=e.clientY; }
    if(ptrs.size===2&&pinchRef){ const [a,b]=[...ptrs.values()];
      const scale=pinchRef.d/Math.max(20,Math.abs(a.x-b.x));   // fingers apart -> smaller span
      const m=pinchRef.mid;
      FOCCH.view={ from:m-(m-pinchRef.from)*scale, to:m+(pinchRef.to-m)*scale };
      focChartClampView(); FOCCH.hover=null; focChartDraw(); return; }
    if(ptrs.size===1&&panRef&&FOCCH._geom){
      const g=FOCCH._geom, msPerPx=(panRef.to-panRef.from)/(g.W-g.padL-g.padR);
      const dx=(e.clientX-panRef.x)*msPerPx;
      if(Math.abs(e.clientX-pt.x0)>5){
        FOCCH.view={ from:panRef.from-dx, to:panRef.to-dx };
        focChartClampView(true); FOCCH.hover=null; focChartDraw(); return; } }
    if(ptrs.size===0&&FOCCH._geom){   // plain mouse move: crosshair
      const g=FOCCH._geom, r=cc.getBoundingClientRect();
      const i=Math.floor((e.clientX-r.left-g.padL)/((g.W-g.padL-g.padR)/g.n));
      FOCCH.hover=Math.max(0,Math.min(g.n-1,i)); focChartDraw(); } });
  const ptrEnd=(e)=>{ const pt=ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
    if(ptrs.size<2) pinchRef=null;
    if(ptrs.size===0){ panRef=null;
      if(pt&&Math.abs(pt.x-pt.x0)<6&&Math.abs(pt.y-pt.y0)<6&&e.pointerType!=='mouse'&&FOCCH._geom){
        const g=FOCCH._geom, r=cc.getBoundingClientRect();   // touch tap = crosshair
        const i=Math.floor((pt.x-r.left-g.padL)/((g.W-g.padL-g.padR)/g.n));
        FOCCH.hover=Math.max(0,Math.min(g.n-1,i)); focChartDraw(); } } };
  cc.addEventListener('pointerup',ptrEnd); cc.addEventListener('pointercancel',ptrEnd);
  cc.addEventListener('mouseleave',()=>{ if(!ptrs.size){ FOCCH.hover=null; focChartDraw(); } });
  // minimap: the 72h base with the viewport highlighted — drag the window to pan
  (function(){ const vb=el('focch-vwin'), bar=el('focch-vbar'); let d0=null;
    vb.addEventListener('pointerdown',e=>{ vb.setPointerCapture(e.pointerId);
      d0={x:e.clientX, from:FOCCH.view.from, to:FOCCH.view.to}; e.preventDefault(); });
    vb.addEventListener('pointermove',e=>{ if(!d0) return;
      const span=FOCCH.baseTo-FOCCH.baseFrom, w=bar.getBoundingClientRect().width||1;
      const dx=(e.clientX-d0.x)*span/w;
      FOCCH.view={ from:d0.from+dx, to:d0.to+dx };
      focChartClampView(true); focChartDraw(); });
    const end=()=>{ d0=null; };
    vb.addEventListener('pointerup',end); vb.addEventListener('pointercancel',end);
  })();
  window.addEventListener('resize',()=>{ const m=el('focmodal'); if(m&&!m.hidden) focChartDraw(); });
}
async function focChartOpen(ticker){
  const d=FOC.data; if(!d) return;
  let day=FOC.showPrev?(d.prev||null):(d.today||d.prev), p=day&&day.rows.find(x=>x.ticker===ticker);
  if(!p&&d.state==='preview'&&d.preview){ p=d.preview.rows.find(x=>x.ticker===ticker);
    if(p) day={ open:d.open, close:d.close, rows:d.preview.rows }; }   // preview chart: live pre-open candles, no frozen lines yet
  if(!day||!p) return;
  focChartEnsureDom();
  FOCCH.p=p; FOCCH.day=day; FOCCH.base=null; FOCCH.agg=null; FOCCH.hover=null; FOCCH.tf=15;
  const mySeq=(FOCCH.seq=(FOCCH.seq||0)+1);   // a slower earlier fetch must not paint over a newer name's chart
  const m=el('focmodal'); m.hidden=false;
  m.querySelectorAll('[data-foctf]').forEach(x=>x.classList.toggle('on',x.dataset.foctf==='15'));
  el('focch-t').textContent=ticker;
  el('focch-sub').textContent='loading 72h from the 5m archive…';
  el('focch-read').textContent='hover for OHLC · chart VWAP · Δ from open';
  const to=Date.now(), from=to-FOCCH_HOURS*3600000;
  try{
    // max=2000 keeps the archive route from coarsening (72h of 5m is 864 bars) — the client's
    // open-anchored aggregation needs true 5m, not server-side absolute-time buckets.
    const res=await fetchJSON('/api/candles?coin='+encodeURIComponent(p.coin)+'&res=5m&from='+from+'&to='+to+'&max=2000');
    if(mySeq!==FOCCH.seq) return;   // superseded while in flight
    FOCCH.base=Array.isArray(res.candles)?res.candles:[];
    if(res.enabled===false){ el('focch-sub').textContent='5m archive disabled on this deploy — no chart source'; return; }
    FOCCH.baseFrom=from; FOCCH.baseTo=to;
    focChartResetView();
    const h=p.h1;
    el('focch-sub').textContent=`last ${FOCCH_HOURS}h · prev close ${focPx(p.prevClose)} · stamp ${focPx(p.px)}`
      +(h?` · frozen: 1H ${focPx(h.lo)}–${focPx(h.hi)}${h.vwap!=null?` · board sVWAP ${focPx(h.vwap)}`:''}`:' · +1h not filled yet — HI/LO lines pending');
    focChartDraw();
  }catch(e){ el('focch-sub').textContent='archive fetch failed — '+((e&&e.message)||'network error'); }
}
function focChartClose(){ const m=el('focmodal'); if(m) m.hidden=true; FOCCH.p=null; FOCCH.base=null; FOCCH.agg=null; FOCCH._geom=null; }
// ---- viewport state (build 2026.08.17-02) ------------------------------------------------------
// Per-timeframe default windows: dropping to 5m IS the detail view (last 12h), 15m opens on 36h,
// 1h/4h show the whole base. Zoom clamps at FOCCH_MIN_SPAN so detail can never become mush; pan
// clamps at the base edges. All of it is math over the one archive fetch — no refetch, ever.
const FOCCH_DEF={5:12*3600000,15:36*3600000,60:72*3600000,240:72*3600000};
const FOCCH_MIN_SPAN=2*3600000;
function focChartResetView(){
  const span=Math.min(FOCCH_DEF[FOCCH.tf]||FOCCH_HOURS*3600000, FOCCH.baseTo-FOCCH.baseFrom);
  FOCCH.view={ from:FOCCH.baseTo-span, to:FOCCH.baseTo };
}
function focChartClampView(panOnly){
  const v=FOCCH.view, lo=FOCCH.baseFrom, hi=FOCCH.baseTo;
  let span=v.to-v.from;
  if(!panOnly) span=Math.max(FOCCH_MIN_SPAN, Math.min(span, hi-lo));
  if(v.from<lo){ v.from=lo; v.to=lo+span; }
  if(v.to>hi){ v.to=hi; v.from=hi-span; }
  if(v.from<lo) v.from=lo;
  if(!panOnly&&v.to-v.from!==span){ if(v.to===hi) v.from=hi-span; else v.to=Math.min(hi,v.from+span); }
}
function focAgg(base,k,openMs){
  // k-minute buckets anchored at TODAY'S OPEN, extending backwards through the 72h lookback, so
  // a bucket boundary always lands exactly on 09:30 — off-session and session never share a bar
  // (k in {5,15,60,240}; the base is the 5m archive, and all four divide cleanly).
  const by=new Map();
  for(const b of base){ const t=+b[0]; if(!isFinite(t)) continue;
    const off=Math.floor((t-openMs)/(k*60000)), t0=openMs+off*k*60000;
    let g=by.get(t0); if(!g) by.set(t0,g=[]); g.push(b); }
  const out=[];
  for(const [t0,g] of [...by.entries()].sort((a,b)=>a[0]-b[0])){
    g.sort((a,b)=>a[0]-b[0]);
    out.push([t0, +g[0][1], Math.max(...g.map(x=>+x[2])), Math.min(...g.map(x=>+x[3])), +g[g.length-1][4], g.reduce((s,x)=>s+(+x[5]||0),0)]);
  }
  return out;
}
// ---- session windows: ONE list, read by the shading, the VWAP and the frozen lines alike -------
// The cash windows come from the server's calendar engine (half days and holidays included), never
// from a guessed 09:30-to-16:00 rhythm. If the payload ever ships without them, fall back to the
// ONE window the charted record itself carries — degraded to a single session, never to "no
// sessions at all", which would silently erase the VWAP.
function focChartSessions(){
  const s=(FOC.data&&Array.isArray(FOC.data.sessions)&&FOC.data.sessions.length)?FOC.data.sessions:null;
  if(s) return s;
  const d=FOCCH.day;
  return (d&&d.open!=null)?[{ open:d.open, close:(d.close!=null?d.close:Infinity) }]:[];
}
// Index of the session containing t, or -1. Windows are [open, close) — a bar stamped exactly at
// the close belongs to the NEXT window, which is the same convention the shading already used.
function focSessIdx(sess,t){
  for(let i=0;i<sess.length;i++){ if(t>=sess[i].open&&t<sess[i].close) return i; }
  return -1;
}
// Visible index span of one window inside an aggregated bar array — pure index math, extracted so
// the clip is testable without a canvas. [-1,-1] means the window has no bar on screen, and its
// geometry must therefore not be drawn AT ALL rather than pinned to the view edges.
function focSessSpan(bars,open,close){
  let a=-1,b=-1;
  for(let i=0;i<bars.length;i++){ const t=bars[i][0];
    if(t>=open&&t<close){ if(a<0) a=i; b=i; } }
  return [a,b];
}
// Contiguous non-null runs of a series. The VWAP is stroked as RUNS, never as one path that skips
// the nulls — skipping bridges Tuesday's close to Wednesday's open with a straight line that no
// session ever traded.
function focRuns(vals,off,n){
  const runs=[]; let cur=null;
  for(let i=0;i<n;i++){ const v=vals[off+i];
    if(v==null){ cur=null; continue; }
    if(!cur){ cur=[]; runs.push(cur); } cur.push([i,v]); }
  return runs;
}
function focAggCached(){
  // Aggregate the FULL base once per timeframe and compute the VWAP over the WHOLE series — the
  // viewport then slices by index. This is the invariant that keeps zoom honest: panning half-out
  // of a session can never restart the cumulative VWAP at the view edge.
  // 2026.08.19-04: the series is PER SESSION. One anchored run used to accumulate straight through
  // the close, so a dead session's VWAP kept drawing across the overnight and into the next
  // pre-market — a level that had stopped existing hours earlier, rendered as if it were live.
  // Each cash window now anchors its own run at its own open and dies at its own close; off-session
  // bars are null, and a null is a BREAK in the line, not a bridge across it.
  const sess=focChartSessions();
  const sn=sess.map(s=>s.open+':'+s.close).join('|');
  if(FOCCH.agg&&FOCCH.agg.tf===FOCCH.tf&&FOCCH.agg.sn===sn) return FOCCH.agg;
  const bars=focAgg(FOCCH.base, FOCCH.tf, FOCCH.day.open);
  let pv=0,vv=0,cur=-1;
  const vwapS=bars.map(b=>{
    const si=focSessIdx(sess,b[0]);
    if(si<0) return null;                        // off-session: no VWAP exists, and the line breaks
    if(si!==cur){ cur=si; pv=0; vv=0; }          // a new session anchors its own run at its own open
    const v=+b[5]; if(v>0){ pv+=((+b[2])+(+b[3])+(+b[4]))/3*v; vv+=v; }
    return vv>0?pv/vv:null; });
  FOCCH.agg={ tf:FOCCH.tf, sn, bars, vwapS };
  return FOCCH.agg;
}
function focChartDraw(){
  const p=FOCCH.p, day=FOCCH.day; if(!p||!day||!FOCCH.base) return;
  const cc=el('focch-cc'); if(!cc) return;
  const A=focAggCached(), all=A.bars;
  const dpr=window.devicePixelRatio||1, W=cc.clientWidth||800, H=440;
  cc.width=W*dpr; cc.height=H*dpr;
  const g=cc.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,W,H);
  const cs=getComputedStyle(document.body);
  const C={ up:(cs.getPropertyValue('--up')||'#35c06f').trim(), down:(cs.getPropertyValue('--down')||'#e05252').trim(),
    acc:(cs.getPropertyValue('--accent')||'#e8a33d').trim(), sec:(cs.getPropertyValue('--muted')||'#7E8794').trim(),
    line:(cs.getPropertyValue('--border')||'#1e2530').trim(), blu:'#4da3d8' };
  if(!all.length){ g.fillStyle=C.sec; g.font='12px monospace'; g.fillText('no archive candles in this window',20,40);
    FOCCH._geom=null; return; }
  // visible slice
  const tfMs=FOCCH.tf*60000;
  let i0=all.findIndex(b=>b[0]+tfMs>FOCCH.view.from); if(i0<0) i0=0;
  let i1=all.length-1; while(i1>0&&all[i1][0]>FOCCH.view.to) i1--;
  const off=i0, bars=all.slice(i0,i1+1), n=bars.length;
  if(!n){ g.fillStyle=C.sec; g.font='12px monospace'; g.fillText('nothing in view — double-click to reset',20,40);
    FOCCH._geom=null; return; }
  const padL=8,padR=70,padT=10,volH=50,padB=26, pH=H-padT-padB-volH-8;
  const h1=p.h1;
  // y-scale from the VISIBLE bars — zooming into a quiet overnight stretch actually resolves it.
  // The frozen 1H HI/LO only stretch the scale when the first hour is in (or near) view.
  let hi=Math.max(...bars.map(b=>b[2])), lo=Math.min(...bars.map(b=>b[3]));
  const fhInView=FOCCH.view.from<=day.open+3600000&&FOCCH.view.to>=day.open;
  if(h1&&fhInView){ hi=Math.max(hi,h1.hi); lo=Math.min(lo,h1.lo); }
  const span=(hi-lo)||1; hi+=span*.05; lo-=span*.05;
  const X=i=>padL+(i+.5)*(W-padL-padR)/n, Y=v=>padT+(hi-v)/(hi-lo)*pH;
  const bw=Math.max(1.5,(W-padL-padR)/n*.62);
  const vwapS=A.vwapS;
  // off-session shading — windows from the same calendar engine as the stamp
  const sess=focChartSessions();
  const inSess=(t)=>focSessIdx(sess,t)>=0;
  g.fillStyle='rgba(0,0,0,0.28)';
  let runA=-1;
  for(let i=0;i<=n;i++){
    const o=i<n&&!inSess(bars[i][0]);
    if(o&&runA<0) runA=i;
    if((!o||i===n)&&runA>=0){ const x0=X(runA)-bw/2, x1=X(i-1)+bw/2; g.fillRect(x0,padT,x1-x0,pH+volH+8); runA=-1; }
  }
  let openI=-1; for(let i=0;i<n;i++){ if(bars[i][0]>=day.open){ openI=i; break; } }
  if(openI>=0&&all[off+openI]&&all[off+openI][0]>=day.open&&(off+openI===0||all[off+openI-1][0]<day.open)){
    const x=X(openI)-bw/2;
    g.strokeStyle='rgba(232,163,61,0.35)'; g.lineWidth=1;
    g.beginPath(); g.moveTo(x,padT); g.lineTo(x,H-padB); g.stroke();
    g.font='10px monospace'; g.fillStyle=C.sec; g.textAlign='center'; g.fillText('open',x,H-padB+18);
  }
  // grid + y labels
  g.font='10px monospace'; g.textAlign='left';
  for(let i=0;i<=4;i++){ const v=lo+(hi-lo)*i/4, y=Y(v);
    g.strokeStyle=C.line; g.lineWidth=1; g.beginPath(); g.moveTo(padL,y); g.lineTo(W-padR,y); g.stroke();
    g.fillStyle=C.sec; g.fillText(focPx(v),W-padR+6,y+3); }
  // reference lines — only drawn when inside the visible scale (a zoomed view far from the first
  // hour should not pin phantom lines to its edges)
  // 2026.08.19-04: the frozen trio is clipped to the charted record's OWN cash window. Drawn edge
  // to edge they read as live levels hours after the session that produced them had closed — and
  // to the LEFT of an open they did not yet exist at. The span is the first and last visible bars
  // inside that window; if none are on screen the line is not drawn at all.
  const daySi=focSessIdx(sess,day.open);
  const daySw=daySi>=0?sess[daySi]:{ open:day.open, close:(day.close!=null?day.close:Infinity) };
  const [sI0,sI1]=focSessSpan(bars,daySw.open,daySw.close);
  const segX0=sI0>=0?Math.max(padL,X(sI0)-bw/2):null, segX1=sI1>=0?Math.min(W-padR,X(sI1)+bw/2):null;
  const refLine=(v,col,lab,clip)=>{ if(v==null||!isFinite(v)||v<lo||v>hi) return;
    const x0=clip?segX0:padL, x1=clip?segX1:(W-padR);
    if(x0==null||x1==null||x1-x0<1) return;
    const y=Y(v);
    g.strokeStyle=col; g.setLineDash([5,4]); g.beginPath(); g.moveTo(x0,y); g.lineTo(x1,y); g.stroke(); g.setLineDash([]);
    // The price label follows the line's END: in the right gutter while the session still runs to
    // the edge, otherwise beside the stub — never marooned in a gutter the line never reaches.
    const txt=lab+' '+focPx(v), tw=g.measureText(txt).width;
    g.fillStyle=col;
    if(!clip||x1>=(W-padR)-1){ g.textAlign='left'; g.fillText(txt,W-padR+6,y-4); }
    else if((W-padR)-x1>=tw+10){ g.textAlign='left'; g.fillText(txt,x1+6,y-4); }
    else { g.textAlign='right'; g.fillText(txt,x1-6,y-4); }
    g.textAlign='left'; };
  // The stamp fallback is a LIVE price reference, not session geometry (preview state, or +1h not
  // filled yet) — it keeps the full width. The frozen trio belongs to the record's session alone.
  if(h1&&h1.openPx!=null) refLine(h1.openPx,C.sec,'O',true); else refLine(p.px,C.sec,'stamp',false);
  if(h1){ refLine(h1.hi,C.up,'1H HI',true); refLine(h1.lo,C.down,'1H LO',true); }
  // volume
  const vMax=Math.max(...bars.map(b=>+b[5]||0),1e-9);
  for(let i=0;i<n;i++){ const b=bars[i], up=b[4]>=b[1];
    g.fillStyle=!inSess(b[0])?'rgba(107,118,134,0.3)':(up?'rgba(53,192,111,0.35)':'rgba(224,82,82,0.35)');
    const vh=(+b[5]||0)/vMax*volH; g.fillRect(X(i)-bw/2,H-padB-vh,bw,vh); }
  // candles (off-session dimmer)
  for(let i=0;i<n;i++){ const b=bars[i], up=b[4]>=b[1], a=inSess(b[0])?0.9:0.45;
    const col=up?`rgba(53,192,111,${a})`:`rgba(224,82,82,${a})`;
    g.strokeStyle=col; g.beginPath(); g.moveTo(X(i),Y(b[2])); g.lineTo(X(i),Y(b[3])); g.stroke();
    g.fillStyle=col; const yO=Y(b[1]), yC=Y(b[4]);
    g.fillRect(X(i)-bw/2,Math.min(yO,yC),bw,Math.max(1,Math.abs(yC-yO))); }
  // VWAP — the per-session series sliced by the same offsets, never restarted at the view edge,
  // and stroked as separate runs so the overnight gap is a gap and not a straight line through it
  g.strokeStyle=C.blu; g.lineWidth=1.6;
  for(const run of focRuns(vwapS,off,n)){ g.beginPath();
    for(let k=0;k<run.length;k++){ const x=X(run[k][0]), y=Y(run[k][1]); k?g.lineTo(x,y):g.moveTo(x,y); }
    g.stroke(); }
  g.lineWidth=1;
  // x labels: weekday + ET time when the view spans a night, plain time when zoomed tight
  g.fillStyle=C.sec; g.textAlign='center';
  const long=(FOCCH.view.to-FOCCH.view.from)>20*3600000;
  const step=Math.max(1,Math.round(n/9));
  const xfmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',...(long?{weekday:'short'}:{}),hour:'numeric',minute:'2-digit',hour12:false});
  for(let i=0;i<n;i+=step) g.fillText(xfmt.format(new Date(bars[i][0])).replace(',',''),X(i),H-8);
  // crosshair
  const hv=FOCCH.hover;
  if(hv!=null&&bars[hv]){
    const b=bars[hv], x=X(hv);
    g.strokeStyle='rgba(200,209,220,0.35)'; g.setLineDash([3,3]);
    g.beginPath(); g.moveTo(x,padT); g.lineTo(x,H-padB); g.stroke();
    const yC=Y(b[4]); g.beginPath(); g.moveTo(padL,yC); g.lineTo(W-padR,yC); g.stroke(); g.setLineDash([]);
    const anchor=h1&&h1.openPx!=null?h1.openPx:p.px;
    const dpc=anchor>0?((b[4]/anchor-1)*100):null;
    const et=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',hour:'numeric',minute:'2-digit',hour12:false}).format(new Date(b[0]));
    const vtxt=vwapS[off+hv]==null?' · VWAP <span class="na">—</span>':(()=>{ const vd=(b[4]/vwapS[off+hv]-1)*100;
      return ` · VWAP <b>${focPx(vwapS[off+hv])}</b> <span class="${focCls(vd)}">(${focSgn(vd)}%)</span>`; })();
    const offSess=!inSess(b[0]);
    el('focch-read').innerHTML=(offSess?'<span class="focpre">OFF-SESSION</span>':'')
      +`<b>${et.replace(',','')} ET</b> · O <b>${focPx(b[1])}</b> H <b>${focPx(b[2])}</b> L <b>${focPx(b[3])}</b> C <b>${focPx(b[4])}</b>`
      +vtxt+(dpc!=null?` · Δ${h1&&h1.openPx!=null?'open':'stamp'} <span class="${focCls(dpc)}">${focSgn(dpc)}%</span>`:'');
  } else if(el('focch-read')) el('focch-read').textContent='hover for OHLC · chart VWAP · Δ from open';
  FOCCH._geom={W,padL,padR,n,off};
  // minimap + viewing state
  const vw=el('focch-vwin');
  if(vw){ const bspan=Math.max(1,FOCCH.baseTo-FOCCH.baseFrom);
    vw.style.left=(((FOCCH.view.from-FOCCH.baseFrom)/bspan)*100)+'%';
    vw.style.width=(Math.max(0.5,((FOCCH.view.to-FOCCH.view.from)/bspan)*100))+'%'; }
  const vv=el('focch-view');
  if(vv) vv.textContent=`viewing ${((FOCCH.view.to-FOCCH.view.from)/3600000).toFixed(0)}h of ${FOCCH_HOURS}h · ${n} bars @ ${FOCCH.tf<60?FOCCH.tf+'m':(FOCCH.tf/60)+'h'}`;
}
export { FOC, focFetch, openFocus };
