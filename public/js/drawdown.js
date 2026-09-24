// drawdown.js — the Return / Drawdown tab (build 2026.09.23-92). One dot per market: its return
// since an anchor date, up, against the MAX DRAWDOWN it took in the same window (the deepest
// peak-to-trough on closes), right — zero drawdown at the right edge, so up-and-right is better:
// more return for less pain. The return axis reads NOW (the live mark over the anchor close, the
// default) or BEST (the highest close over the anchor close). Two numbers every other tab shows
// one of — the table's %-change is "now", the drawer sparkline is the path — but never side by
// side, and side by side is the question: what did this name pay in pain for what it paid out?
// The benchmarks (BTC and ETH in crypto scope, the index rows in stocks scope) are dashed
// horizontal lines, so "beat the market" and "beat it without the hole" read at once. The chart
// shows the top N by the return axis (the references always stay); the table has everyone, paged.
//
// Runs entirely in-browser off state.rows[*].daily (shipped via /api/daily under the pinned
// markets key) plus the live mark as the final point, so a name that is making its high right now
// reads that way between daily-bar refreshes. (build 2026.09.24-105) Session names read their
// SESSION bars (core.js sessionFold: weekends/holidays folded into the next session); the base is the
// PRIOR session's close, so the anchor day's own move is in the return; and the drawdown is INTRADAY
// by default — the running peak of highs down to each bar's true low (the daily tuple carries the
// candle's low since -105) — with a close-to-close toggle. A bar without a true low (an older warm
// file) is read on its close and counted in the caption.
// Follows the Stocks|Crypto switcher; crypto's wire history is ~90 days, so anchors older than that
// start every coin at its own first close and the header says how many did.
import { DAY, activeRows, el, esc, isoUtc, scopeBench, sessDaily, state, store } from "./core.js";
import { loadDaily } from "./data.js";
import { openDetail } from "./drawer.js";
import { downloadCSV } from "./corr.js";
import { layoutMapLabels, mapLabelSvg } from "./sectors.js";

const RVD_KEY='xyzmon.rvd.v1';
// Presets are days back from today's UTC midnight; 'ytd' is Jan 1 of the current UTC year.
const RVD_PRESETS=[['30','30d'],['60','60d'],['90','90d'],['180','180d'],['ytd','YTD'],['365','1y']];
const RVD_LATE_GAP=4*DAY;   // a first bar this far past the anchor is a listing that came after it, not a weekend
const RVD_LABEL_ALL_MAX=45; // at most this many dots before 'auto' labels only the standouts
const RVD_TOPS=[['10','10'],['20','20'],['30','30'],['50','50'],['all','all']];   // the chart's cut, by the return axis; the references always stay
const RVD_PAGE=25;          // table rows per page
const RVD=Object.assign({ preset:'90', date:null, y:'now', dd:'intraday', top:'30', labels:'auto', sort:'now', dir:'desc' }, (()=>{ try{ return JSON.parse(store.get(RVD_KEY)||'{}')||{}; }catch(_){ return {}; } })(), { page:1 });
function rvdSave(){ try{ store.set(RVD_KEY, JSON.stringify({ preset:RVD.preset, date:RVD.date, y:RVD.y, dd:RVD.dd, top:RVD.top, labels:RVD.labels, sort:RVD.sort, dir:RVD.dir })); }catch(_){} }
function rvdToday(){ return Math.floor(Date.now()/DAY)*DAY; }
// The anchor is a UTC midnight: bars are keyed by UTC day, so "since March 3" means the first bar
// on or after 2026-03-03T00:00Z.
function rvdAnchorTs(){
  if(RVD.date){ const t=new Date(RVD.date+'T00:00:00Z').getTime(); if(isFinite(t)&&t<rvdToday()) return t; }
  if(RVD.preset==='ytd') return Date.UTC(new Date().getUTCFullYear(),0,1);
  const d=+RVD.preset; return rvdToday()-(isFinite(d)&&d>0?d:90)*DAY;
}
// The study itself — pure, so the suite can drive it. bars: daily bars [{t,c,h?,l?,tl?}] ascending
// (a session name's SESSION view); anchorTs: UTC midnight; px: the live mark, folded in as the last
// point when finite; mode: 'intraday' (default) | 'close'.
// Returns null when fewer than two points (base + one) exist (a listing from yesterday is a dot with
// no path). Every ratio is a FRACTION; the renderer scales to %.
//   base  — (build -105) the PRIOR close: the last bar BEFORE the anchor, so the anchor day's own
//           move is in the return ("since the Mar 3 open" = since the Mar 2 close). A series that
//           starts on/after the anchor (a later listing, or a feed that does not reach back) starts
//           at its own first close; late:true when that bar is well past the anchor.
//   best  — the highest close over base, and when (≥ 0: the base itself is a candidate)
//   dd    — the deepest fall from any running peak, with peak and trough dates (≤ 0). 'close':
//           close-to-close. 'intraday': running peak of HIGHS (the base close seeds it) down to each
//           bar's true LOW; a bar's own high never counts against its own low (their order inside
//           the bar is unknown); a bar with no true low (tl false) falls back to its close (lowN
//           counts the bars that did read a true low).
//   now   — the last point over base
function rvdStudy(bars, anchorTs, px, mode){
  if(!Array.isArray(bars)) return null;
  const intra=mode!=='close', pts=[]; let prior=null;
  for(const p of bars){ if(!(p&&isFinite(p.t)&&isFinite(p.c)&&p.c>0)) continue;
    if(p.t<anchorTs){ prior={t:p.t,c:+p.c}; continue; }
    const h=+p.h, l=+p.l, tl=!!p.tl&&l>0;
    pts.push({t:p.t,c:+p.c,h:h>0?Math.max(h,+p.c):+p.c,l:tl?Math.min(l,+p.c):+p.c,tl}); }
  if(isFinite(px)&&px>0){ const last=pts[pts.length-1];
    if(!last||last.t<rvdToday()) pts.push({t:Date.now(),c:px,h:px,l:px,tl:false,nl:true,live:true});   // the mark alone: a point, not a bar with a low to miss
    else { last.c=px; last.h=Math.max(last.h,px); last.l=Math.min(last.l,px); last.live=true; } }
  let base, baseT, late, path;
  if(prior){ base=prior.c; baseT=prior.t; late=false; path=pts; }
  else { if(pts.length<2) return null; base=pts[0].c; baseT=pts[0].t; late=pts[0].t-anchorTs>RVD_LATE_GAP; path=pts.slice(1); }
  if(!path.length) return null;
  let best={ret:0,t:baseT,c:base}, peak=base, peakT=baseT, dd={ret:0,peakT:baseT,peakC:base,troughT:baseT,troughC:base}, lowN=0;
  for(const p of path){
    const r=p.c/base-1;
    if(r>best.ret) best={ret:r,t:p.t,c:p.c};
    const lo=intra?p.l:p.c; if(intra&&(p.tl||p.nl)) lowN++;
    const d=lo/peak-1;
    if(d<dd.ret) dd={ret:d,peakT,peakC:peak,troughT:p.t,troughC:lo};
    const hi=intra?p.h:p.c; if(hi>peak){ peak=hi; peakT=p.t; }
  }
  const last=path[path.length-1];
  return { base, baseT, late, n:path.length+1, best, dd, mode:intra?'intraday':'close', lowN, now:{ret:last.c/base-1,c:last.c,live:!!last.live} };
}
// The reference names: the benchmark (BTC / the S&P) in gold and a second reference (ETH / the
// XYZ100 index) in violet — dashed horizontal lines at their return, and their dots wear the colour.
function rvdBenchCoins(){
  const cr=state.scope==='crypto', out=[]; const bench=scopeBench();
  if(bench) out.push(bench);
  for(const r of activeRows()){ if(out.length>=2) break;
    if(cr ? r.ticker.toUpperCase()==='ETH' : (r.sector==='Index'&&r.coin!==bench)) if(!out.includes(r.coin)) out.push(r.coin); }
  return out;
}
function rvdRows(anchorTs){
  const out=[], bench=rvdBenchCoins();
  for(const r of activeRows()){ if(!r.daily||!r.daily.length) continue;
    const s=rvdStudy(sessDaily(r), anchorTs, r.px, RVD.dd); if(!s) continue;   // session bars on a session name (-105)
    out.push({ coin:r.coin, ticker:r.ticker, sector:r.sector||null, s, bench:bench.indexOf(r.coin),
      best:s.best.ret*100, dd:s.dd.ret*100, now:s.now.ret*100, gave:(s.best.ret-s.now.ret)*100,
      ratio:s.dd.ret<0?s.best.ret/-s.dd.ret:(s.best.ret>0?Infinity:0) }); }
  return out;
}
const RVD_COL=['var(--blue)','var(--accent)','#a48cf0'];   // names, the benchmark, the second reference
// The chart's cut: the top N names by the return axis, plus every reference whatever its rank. The
// table underneath always carries the whole universe — the cut is what the eye can read, not the study.
function rvdChartRows(rows){ const n=+RVD.top; if(!isFinite(n)||n<=0) return rows;
  const names=rows.filter(x=>x.bench<0).sort((a,b)=>yOf(b)-yOf(a)).slice(0,n);
  return rows.filter(x=>x.bench>=0).concat(names); }
const pct=(x,d=1)=>(x==null||!isFinite(x))?'—':(x>0?'+':'')+x.toFixed(d)+'%';
const dOnly=t=>isoUtc(t,0,10);
const yOf=x=>RVD.y==='best'?x.best:x.now;
function rvdNiceStep(span, want){ const raw=span/Math.max(1,want), p=Math.pow(10,Math.floor(Math.log10(raw))), m=raw/p; return (m<=1?1:m<=2?2:m<=5?5:10)*p; }
function rvdTicks(lo, hi, want){ const st=rvdNiceStep(hi-lo,want), out=[]; for(let v=Math.ceil(lo/st)*st; v<=hi+1e-9; v+=st) out.push(+v.toFixed(6)); return out; }
function rvdLabelSet(rows){
  if(RVD.labels==='none') return new Set(rows.filter(x=>x.bench>=0).map(x=>x.coin));   // the references are always named
  if(RVD.labels==='all'||rows.length<=RVD_LABEL_ALL_MAX) return new Set(rows.map(x=>x.coin));
  // auto on a crowded board: the standouts on either axis, the best ratios, and the references
  const keep=new Set(rows.filter(x=>x.bench>=0).map(x=>x.coin));
  [...rows].sort((a,b)=>yOf(b)-yOf(a)).slice(0,14).forEach(x=>keep.add(x.coin));
  [...rows].sort((a,b)=>yOf(a)-yOf(b)).slice(0,6).forEach(x=>keep.add(x.coin));
  [...rows].sort((a,b)=>a.dd-b.dd).slice(0,8).forEach(x=>keep.add(x.coin));
  [...rows].filter(x=>isFinite(x.ratio)).sort((a,b)=>b.ratio-a.ratio).slice(0,8).forEach(x=>keep.add(x.coin));
  return keep;
}
function rvdSvg(rows, anchorTs){
  const W=880,H=500, px0=64,px1=W-22, py0=H-46, py1=22;
  const ys=rows.map(yOf);
  const maxX=Math.max(5, ...rows.map(x=>-x.dd))*1.06;
  const maxY=Math.max(5, ...ys)*1.08, minY=Math.min(0, ...ys)*1.08;
  const xM=v=>px1-Math.min(-v,maxX)/maxX*(px1-px0);          // v is the drawdown (≤ 0): zero at the right edge, deeper to the left
  const yM=v=>py0-(Math.min(Math.max(v,minY),maxY)-minY)/(maxY-minY)*(py0-py1);
  const ql='font-family:var(--mono);font-size:var(--fs-2xs);fill:var(--faint)';
  const since=dOnly(anchorTs), yl=RVD.y==='best'?'best return':'return';
  let s=`<svg class="smapsvg rvdsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block" role="img" aria-label="${yl} since ${since} against max drawdown, one dot per market">`;
  s+=`<rect x="${px0}" y="${py1}" width="${px1-px0}" height="${py0-py1}" fill="var(--panel2)" opacity="0.3"/>`;
  for(const t of rvdTicks(-maxX,0,7)){ const x=xM(t); s+=`<line x1="${x.toFixed(1)}" y1="${py1}" x2="${x.toFixed(1)}" y2="${py0}" stroke="var(--grid)"/><text x="${x.toFixed(1)}" y="${py0+15}" text-anchor="middle" style="${ql}">${t?'−':''}${Math.abs(+t.toFixed(2))}%</text>`; }
  for(const t of rvdTicks(minY,maxY,6)){ const y=yM(t); s+=`<line x1="${px0}" y1="${y.toFixed(1)}" x2="${px1}" y2="${y.toFixed(1)}" stroke="${t?'var(--grid)':'var(--faint)'}"/><text x="${px0-6}" y="${(y+3.5).toFixed(1)}" text-anchor="end" style="${ql}">${t>0?'+':''}${+t.toFixed(2)}%</text>`; }
  // the references: a dashed line at each benchmark's return, named at the left edge
  { let lastY=-1e9;   // two references within a label's height of each other: the lower one names itself under its line
    for(const b of rows.filter(x=>x.bench>=0).sort((a,c)=>yOf(c)-yOf(a))){ const y=yM(yOf(b)), col=RVD_COL[b.bench+1]||RVD_COL[1];
      s+=`<line x1="${px0}" y1="${y.toFixed(1)}" x2="${px1}" y2="${y.toFixed(1)}" stroke="${col}" stroke-dasharray="5 4" opacity="0.7"/>`;
      const ty=(y-lastY<14)?y+12:y-4; lastY=y;
      s+=`<text x="${px0+6}" y="${ty.toFixed(1)}" style="font-family:var(--mono);font-size:var(--fs-xs);fill:${col};font-weight:600;paint-order:stroke;stroke:var(--bg);stroke-width:3px">${esc(b.ticker)} ${pct(yOf(b))}</text>`; } }
  s+=`<text x="${(px0+px1)/2}" y="${H-6}" text-anchor="middle" style="${ql}">max drawdown since ${since}, ${RVD.dd==='close'?'close to close':'intraday (peak high → low)'}  ·  shallower →</text>`;
  s+=`<text x="14" y="${(py0+py1)/2}" text-anchor="middle" transform="rotate(-90 14 ${(py0+py1)/2})" style="${ql}">${yl} since ${since} (from the prior close) ↑</text>`;
  const lbl=rvdLabelSet(rows);
  const nodes=rows.map(x=>({cx:xM(x.dd),cy:yM(yOf(x)),r:x.bench>=0?6:5,label:lbl.has(x.coin)?x.ticker:'',x}));
  layoutMapLabels(nodes.filter(n=>n.label),{px0,px1,py1,py0:py0-22});   // py0 pulled in: a label may never drop into the tick row under the baseline
  for(const n of [...nodes].sort((a,b)=>a.x.bench-b.x.bench)){ const x=n.x, col=RVD_COL[x.bench+1]||RVD_COL[0];   // references paint last, on top
    const lp=n.label?mapLabelSvg(n,10):{leader:'',txt:''};
    s+=`<g class="rvd-dot" data-coin="${esc(x.coin)}" style="cursor:pointer"><title>${esc(rvdTitle(x))}</title>${lp.leader}`;
    // a hit target wider than the mark; the visible dot stays 10px (12px for a reference)
    s+=`<circle cx="${n.cx.toFixed(1)}" cy="${n.cy.toFixed(1)}" r="11" fill="transparent"/>`;
    s+=`<circle cx="${n.cx.toFixed(1)}" cy="${n.cy.toFixed(1)}" r="${n.r}" fill="${col}" fill-opacity="${x.s.late?'0.1':(x.bench>=0?'0.95':'0.6')}" stroke="${col}" stroke-width="1.4"${x.s.late?' stroke-dasharray="2.5 2"':''}/>`;
    s+=lp.txt+'</g>'; }
  s+='</svg>';
  return s;
}
function rvdTitle(x){ const s=x.s;
  return `${x.ticker}: now ${pct(x.now)} · best ${pct(x.best)} on ${dOnly(s.best.t)} · max drawdown ${pct(x.dd)} (${dOnly(s.dd.peakT)} → ${dOnly(s.dd.troughT)})${s.late?' · listed after the anchor, from '+dOnly(s.baseT):''}`; }
function rvdReadHtml(x){ const s=x.s, r=v=>v>0?'pos':(v<0?'neg':'sec');
  return `<div class="cg-rdate"><b>${esc(x.ticker)}</b>${x.sector?` <span class="sec">· ${esc(x.sector)}</span>`:''}${x.bench>=0?` <span class="sec">· reference</span>`:''}${s.late?` <span class="rvd-late">listed after the anchor</span>`:''}</div>`
    +`<div class="cg-rd"><span class="sec">base</span><span>${dOnly(s.baseT)} close · ${fmtC(s.base)}</span></div>`
    +`<div class="cg-rd"><span class="sec">now</span><span class="${r(x.now)}">${pct(x.now,2)}</span><span class="sec">${s.now.live?'live mark':'last close'}</span></div>`
    +`<div class="cg-rd"><span class="sec">best</span><span class="${r(x.best)}">${pct(x.best,2)}</span><span class="sec">${dOnly(s.best.t)}</span></div>`
    +`<div class="cg-rd"><span class="sec">max drawdown</span><span class="${r(x.dd)}">${pct(x.dd,2)}</span><span class="sec">${dOnly(s.dd.peakT)} → ${dOnly(s.dd.troughT)}</span></div>`
    +`<div class="cg-rd"><span class="sec">gave back</span><span class="${x.gave>0?'neg':'sec'}">${x.gave>0?'−':''}${Math.abs(x.gave).toFixed(2)}pp</span><span class="sec">best − now</span></div>`
    +`<div class="cg-rd"><span class="sec">best / drawdown</span><span>${isFinite(x.ratio)?x.ratio.toFixed(2)+'×':'∞'}</span><span class="sec">${x.s.n} points</span></div>`
    +`<div class="sec" style="margin-top:4px">click = open in the drawer</div>`; }
function fmtC(c){ return c>=1000?c.toFixed(0):c>=10?c.toFixed(2):c.toFixed(4); }
const RVD_COLS=[
  {k:'ticker',l:'Ticker',num:false},
  {k:'now',l:'Now',num:true,tip:'the live mark over the base — the last close BEFORE the anchor (the prior session\u2019s on a US name), so the anchor day\u2019s own move counts'},
  {k:'best',l:'Best',num:true,tip:'highest close since the anchor, over the base close'},
  {k:'bestT',l:'on',num:true,tip:'the day of that high'},
  {k:'dd',l:'Max DD',num:true,tip:'deepest drawdown from any running peak since the anchor — intraday (running peak of highs down to each bar\u2019s true low) or close to close, per the drawdown toggle'},
  {k:'ddT',l:'peak → trough',num:true},
  {k:'gave',l:'Gave back',num:true,tip:'best minus now, in percentage points'},
  {k:'ratio',l:'Best / DD',num:true,tip:'best return divided by the drawdown magnitude — above 1 the name made more than it ever gave back'},
];
function rvdSortVal(x,k){ if(k==='ticker') return x.ticker; if(k==='bestT') return x.s.best.t; if(k==='ddT') return x.s.dd.troughT; return x[k]; }
function rvdTableHtml(rows){
  const sorted=[...rows].sort((a,b)=>{ const va=rvdSortVal(a,RVD.sort), vb=rvdSortVal(b,RVD.sort);
    const c=(typeof va==='string')?va.localeCompare(vb):((va===vb)?0:(va>vb?1:-1)); return (RVD.dir==='desc'?-c:c)||a.ticker.localeCompare(b.ticker); });
  const pages=Math.max(1,Math.ceil(sorted.length/RVD_PAGE)); RVD.page=Math.min(Math.max(1,RVD.page|0||1),pages);
  const from=(RVD.page-1)*RVD_PAGE, page=sorted.slice(from,from+RVD_PAGE);
  const pager=sorted.length>RVD_PAGE?`<div class="rvd-pager"><button type="button" class="btn xtiny" data-rvdpg="${RVD.page-1}"${RVD.page<=1?' disabled':''} aria-label="previous page">‹</button><span>${from+1}–${from+page.length} of ${sorted.length}</span><button type="button" class="btn xtiny" data-rvdpg="${RVD.page+1}"${RVD.page>=pages?' disabled':''} aria-label="next page">›</button></div>`:'';
  let h='<table class="rvd-tbl"><thead><tr>'+RVD_COLS.map(c=>`<th class="${c.num?'num':''}${RVD.sort===c.k?' on':''}" data-k="${c.k}"${c.tip?` data-tip="${esc(c.tip)}"`:''}>${esc(c.l)}${RVD.sort===c.k?(RVD.dir==='desc'?' ▾':' ▴'):''}</th>`).join('')+'</tr></thead><tbody>';
  for(const x of page){ const s=x.s, cl=v=>v>0?'pos':(v<0?'neg':'sec');
    h+=`<tr data-coin="${esc(x.coin)}"><td><b${x.bench>=0?` style="color:${RVD_COL[x.bench+1]}"`:''}>${esc(x.ticker)}</b>${s.late?` <span class="rvd-late" data-tip="listed after the anchor — starts at its own first close, ${dOnly(s.baseT)}">late</span>`:''}</td>`
      +`<td class="num ${cl(x.now)}">${pct(x.now)}</td>`
      +`<td class="num ${cl(x.best)}">${pct(x.best)}</td><td class="num sec">${dOnly(s.best.t)}</td>`
      +`<td class="num ${cl(x.dd)}">${pct(x.dd)}</td><td class="num sec">${dOnly(s.dd.peakT)} → ${dOnly(s.dd.troughT)}</td>`
      +`<td class="num ${x.gave>0?'neg':'sec'}">${x.gave>0?'−':''}${Math.abs(x.gave).toFixed(1)}pp</td>`
      +`<td class="num">${isFinite(x.ratio)?x.ratio.toFixed(2)+'×':'∞'}</td></tr>`; }
  return h+'</tbody></table>'+pager;
}
function rvdControlsHtml(anchorTs){
  const today=rvdToday();
  const minISO=isoUtc(today-370*DAY,0,10), maxISO=isoUtc(today-DAY,0,10);
  const seg=(id,lbl,attr,opts,cur,tail='')=>`<div class="seg" id="${id}" role="group" aria-label="${lbl}"><span class="seglbl">${lbl}</span>${opts.map(([k,l])=>`<button type="button"${cur===k?' class="active"':''} data-${attr}="${k}">${l}</button>`).join('')}${tail}</div>`;
  // what · cut · actions — the site's controls-row grammar
  return `<div class="zone">`
    +seg('rvd-since','since','rvdp',RVD_PRESETS,RVD.date?null:RVD.preset,`<input type="date" id="rvd-date" value="${isoUtc(anchorTs,0,10)}" min="${minISO}" max="${maxISO}" aria-label="anchor date"/>`)
    +seg('rvd-y','return','rvdy',[['now','now'],['best','best']],RVD.y)
    +seg('rvd-dd','drawdown','rvdd',[['intraday','intraday'],['close','close']],RVD.dd==='close'?'close':'intraday')
    +`</div><div class="zone cut">`
    +seg('rvd-top','top','rvdt',RVD_TOPS,RVD.top)
    +seg('rvd-labels','labels','rvdl',[['auto','auto'],['all','all'],['none','none']],RVD.labels)
    +`</div><div class="zone act"><button class="btn" id="rvd-csv" title="Download the table as CSV">↓ CSV</button></div>`;
}
let _rvdLoading=false;
function renderDrawdown(){
  const wrap=el('rvd-wrap'); if(!wrap) return;
  const anchorTs=rvdAnchorTs();
  const ctrl=el('rvd-ctrls'); if(ctrl) ctrl.innerHTML=rvdControlsHtml(anchorTs);
  const rowsAll=activeRows(), withDaily=rowsAll.filter(r=>r.daily&&r.daily.length);
  if(!rowsAll.length){ wrap.innerHTML='<div class="msg">Markets still loading — switch back in a moment.</div>'; wireControls(); return; }
  if(!withDaily.length){ wrap.innerHTML='<div class="msg">Loading daily history — the chart draws itself the moment it lands.</div>'; wireControls();
    if(!_rvdLoading){ _rvdLoading=true; loadDaily().finally(()=>{ _rvdLoading=false; if(state.view==='drawdown') renderDrawdown(); }); }
    return; }
  const rows=rvdRows(anchorTs), shown=rvdChartRows(rows), lowMiss=RVD.dd==='close'?0:rows.filter(x=>x.s.lowN<x.s.n-1).length;
  const days=Math.round((rvdToday()-anchorTs)/DAY), late=rows.filter(x=>x.s.late).length, cr=state.scope==='crypto';
  const refs=rows.filter(x=>x.bench>=0).sort((a,b)=>a.bench-b.bench);
  const since=dOnly(anchorTs), yl=RVD.y==='best'?'Best return':'Return';
  const head=`<div class="rvd-title">${yl} since ${since} vs max drawdown (${RVD.dd==='close'?'close to close':'intraday'})</div>`
    +`<div class="rvd-sub">Up and to the right is better: more return for less pain.${refs.length?` Dashed lines mark ${refs.map(x=>`<b style="color:${RVD_COL[x.bench+1]}">${esc(x.ticker)}</b>'s`).join(' and ')} return.`:''} Hover any point; click it, or a row, for the drawer.</div>`
    +`<div class="rvd-head"><b>${rows.length}</b> ${cr?'coins':'names'} · ${days}d`
    +(shown.length<rows.length?` · chart: top <b>${shown.length-refs.length}</b> by ${yl.toLowerCase()}`:'')
    +(withDaily.length-rows.length>0?` · <span class="sec">${withDaily.length-rows.length} without two closes in the window</span>`:'')
    +(late?` · <span class="rvd-late">${late} listed after the anchor</span>`:'')
    +`<span class="rvd-legend"><i></i> ${cr?'coins':'names'}${refs.map(x=>` <i style="border-color:${RVD_COL[x.bench+1]};background:${RVD_COL[x.bench+1]}"></i> ${esc(x.ticker)}`).join('')} <i class="late"></i> listed after the anchor</span></div>`;
  if(!rows.length){ wrap.innerHTML=head+'<div class="msg">No name has two closes on or after this anchor'+(cr?' — the crypto feed carries about 90 days; pick a nearer date.':'.')+'</div>'; wireControls(); return; }
  wrap.innerHTML=head
    +`<div class="cg-chartwrap rvd-chart">${rvdSvg(shown,anchorTs)}<div class="cg-read rvd-read" id="rvd-read"></div></div>`
    +`<p class="rvd-cap">${RVD.y==='best'?'Best return = the highest daily close since the anchor over the base (the live mark counts as today\'s point).':'Return = the live mark over the base.'} The base is the last close BEFORE the anchor, so the anchor day\'s own move counts; ${cr?'crypto reads calendar days':'a US name reads US sessions — weekends and exchange holidays fold into the next session\'s bar'}. ${RVD.dd==='close'?'Max drawdown = the deepest close-to-close fall from any running peak inside the window — a wick below the close is not counted.':`Max drawdown = the deepest fall from the running peak of daily HIGHS to a later daily LOW (a bar\'s own high never counts against its own low)${lowMiss?` — ${lowMiss} name${lowMiss===1?'':'s'} carr${lowMiss===1?'ies':'y'} bars without a true low (older history), read on the close there`:''}.`} ${shown.length<rows.length?'The chart shows the top '+(shown.length-refs.length)+' by '+yl.toLowerCase()+' plus the references; the table underneath has everyone.':'The table underneath carries the same names.'} Best / DD above 1 means the name made more than it ever gave back.${cr?' Crypto history on the wire is ~90 days: an older anchor starts every coin at its first close.':''}</p>`
    +`<div class="corrpanel rvd-tblwrap">${rvdTableHtml(rows)}</div>`;
  wireControls();
  const byCoin=new Map(rows.map(x=>[x.coin,x]));
  const svg=wrap.querySelector('svg.rvdsvg'), read=el('rvd-read');
  if(svg){
    svg.querySelectorAll('.rvd-dot').forEach(g=>{
      g.addEventListener('mouseenter',()=>{ svg.classList.add('hv'); g.classList.add('hot'); const x=byCoin.get(g.dataset.coin); if(x&&read){ read.innerHTML=rvdReadHtml(x); read.style.display='block';
        // the readout sits on whichever side the dot is not
        const c=g.querySelector('circle'), vb=svg.viewBox.baseVal, left=(+c.getAttribute('cx'))<vb.width/2; read.style.left=left?'auto':'8px'; read.style.right=left?'8px':'auto'; } });
      g.addEventListener('mouseleave',()=>{ svg.classList.remove('hv'); g.classList.remove('hot'); if(read) read.style.display='none'; });
      g.addEventListener('click',()=>openDetail(g.dataset.coin));
    });
  }
  wrap.querySelectorAll('.rvd-tbl th[data-k]').forEach(th=>th.addEventListener('click',()=>{ const k=th.dataset.k;
    if(RVD.sort===k) RVD.dir=RVD.dir==='desc'?'asc':'desc'; else { RVD.sort=k; RVD.dir=(k==='ticker'||k==='dd')?'asc':'desc'; } RVD.page=1; rvdSave(); renderDrawdown(); }));
  wrap.querySelectorAll('.rvd-tbl tbody tr').forEach(tr=>tr.addEventListener('click',()=>openDetail(tr.dataset.coin)));
  wrap.querySelectorAll('[data-rvdpg]').forEach(b=>b.addEventListener('click',()=>{ RVD.page=+b.dataset.rvdpg; renderDrawdown(); el('rvd-wrap').querySelector('.rvd-tblwrap').scrollIntoView({block:'nearest'}); }));
  const csv=el('rvd-csv'); if(csv) csv.onclick=()=>{
    const m=[['ticker','sector','reference','anchor','anchor_close','now_pct','best_pct','best_date','max_dd_pct','dd_peak','dd_trough','gave_back_pp','best_over_dd','listed_after_anchor']];
    for(const x of rows) m.push([x.ticker,x.sector||'',x.bench>=0?1:0,dOnly(x.s.baseT),x.s.base,x.now.toFixed(3),x.best.toFixed(3),dOnly(x.s.best.t),x.dd.toFixed(3),dOnly(x.s.dd.peakT),dOnly(x.s.dd.troughT),x.gave.toFixed(3),isFinite(x.ratio)?x.ratio.toFixed(3):'',x.s.late?1:0]);
    downloadCSV(`return-drawdown-${state.scope}-${since}.csv`, m); };
  function wireControls(){
    const c=el('rvd-ctrls'); if(!c) return;
    c.querySelectorAll('[data-rvdp]').forEach(b=>b.onclick=()=>{ RVD.preset=b.dataset.rvdp; RVD.date=null; RVD.page=1; rvdSave(); renderDrawdown(); });
    c.querySelectorAll('[data-rvdy]').forEach(b=>b.onclick=()=>{ RVD.y=b.dataset.rvdy; rvdSave(); renderDrawdown(); });
    c.querySelectorAll('[data-rvdd]').forEach(b=>b.onclick=()=>{ RVD.dd=b.dataset.rvdd; rvdSave(); renderDrawdown(); });
    c.querySelectorAll('[data-rvdt]').forEach(b=>b.onclick=()=>{ RVD.top=b.dataset.rvdt; rvdSave(); renderDrawdown(); });
    c.querySelectorAll('[data-rvdl]').forEach(b=>b.onclick=()=>{ RVD.labels=b.dataset.rvdl; rvdSave(); renderDrawdown(); });
    const dt=el('rvd-date'); if(dt) dt.onchange=()=>{ const t=new Date(dt.value+'T00:00:00Z').getTime(); if(isFinite(t)&&t<rvdToday()){ RVD.date=dt.value; RVD.page=1; rvdSave(); renderDrawdown(); } };
  }
}
function openDrawdown(){ renderDrawdown(); }

export { RVD, RVD_PRESETS, RVD_TOPS, openDrawdown, renderDrawdown, rvdAnchorTs, rvdBenchCoins, rvdChartRows, rvdStudy, rvdRows };
