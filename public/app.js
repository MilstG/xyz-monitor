"use strict";
// Data now comes from this app's own backend (/api/snapshot + /api/daily), which fetches
// Hyperliquid once and serves a pre-computed, cached payload. All rendering, correlation,
// alerts, drawer and column logic is unchanged from the original client.
const DEX = "xyz";
const HOUR = 3600 * 1000, DAY = 86400 * 1000;
const TF_MAP = { '1h': 'h1', '4h': 'h4', '1d': 'd1', '7d': 'd7', '30d': 'd30' };
const TF_MS = { '1h': HOUR, '4h': 4 * HOUR, '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const SP_ALIASES = ['SPX', 'SPX500', 'SP500', 'US500', 'USSPX500', 'SP500USD', 'SPXUSD', 'GSPC', 'SP', 'US500USD'];
// safe localStorage (UI prefs / alerts / watchlist only; OI persistence now lives server-side)
const store = { get(k){ try{ return localStorage.getItem(k); }catch(_){ return null; } },
                set(k,v){ try{ localStorage.setItem(k,v); }catch(_){} } };
const PKEY = 'xyzmon.prefs.v1';

const COLS=[
  {key:'ticker', label:'Ticker', type:'str', def:'asc', hideable:false,
    td:r=>`<td><span class="star${state.watch.has(r.coin)?' on':''}" data-star="${esc(r.coin)}" title="add to watchlist">${state.watch.has(r.coin)?'★':'☆'}</span><span class="tk" title="${esc(r.coin)}">${esc(r.ticker)}</span></td>`},
  {key:'px', label:'Price', type:'num',
    td:r=>`<td class="px${r.flash?' flash-'+r.flash:''}">${fmtPrice(r.px)}</td>`},
  {key:'funding', label:'Funding (APR)', type:'num',
    td:r=>{ const f=fmtFunding(r.funding); return `<td class="${f.c}" title="${f.title}">${f.t}</td>`; }},
  {key:'h1', label:'1h', type:'num', td:r=>`<td class="${scCls(r)}"${shade(r.h1,2.5)}>${pctInner(r.h1)}</td>`},
  {key:'h4', label:'4h', type:'num', td:r=>`<td class="${scCls(r)}"${shade(r.h4,4)}>${pctInner(r.h4)}</td>`},
  {key:'d1', label:'1d', type:'num', td:r=>`<td${shade(r.d1,5)}>${pctInner(r.d1)}</td>`},
  {key:'d7', label:'7d', type:'num', td:r=>`<td class="${scCls(r)}"${shade(r.d7,12)}>${pctInner(r.d7)}</td>`},
  {key:'d30', label:'30d', type:'num', td:r=>`<td class="${scCls(r)}"${shade(r.d30,25)}>${pctInner(r.d30)}</td>`},
  {key:'trend', label:'30d trend', type:'num', tip:'30-day price path (sparkline). Sorts by 30-day % change.', td:r=>trendCell(r)},
  {key:'rs', label:'vs S&P', type:'num', tip:'Excess return vs the S&P 500 perp over the window (this market % − S&P %).',
    td:r=>`<td${shade(r.rs,8)}>${rsCell(r)}</td>`},
  {key:'beta', label:'β', type:'num', tip:'Beta to the S&P perp (90d daily returns): sensitivity to the benchmark. >1 amplifies it, 0–1 dampens, <0 moves inverse. Fills in once daily history loads in the background.',
    td:r=>betaCell(r)},
  {key:'mom', label:'Momentum', type:'num', def:'desc', tip:'Self-normalizing momentum −100…+100: risk-adjusted multi-horizon return × 7d trend quality + range position, modulated by OI conviction.',
    td:r=>`<td${shade(r.mom,60)}>${momCell(r)}</td>`},
  {key:'vol30', label:'Vol (ann)', type:'num', tip:'Annualized realized volatility from hourly returns over ~30 days.', td:r=>volCell(r)},
  {key:'dd', label:'vs 30d hi', type:'num', tip:'Distance below the 30-day high (0% = sitting at the high).', td:r=>ddCell(r)},
  {key:'doi', label:'ΔOI', type:'num', tip:'Open-interest change over the window, with a price-vs-OI regime tag. Stored server-side and persistent.',
    td:r=>`<td>${oiCell(r)}</td>`},
  {key:'vol', label:'24h Vol', type:'num', td:r=>`<td class="sec">${fmtUsd(r.vol)}</td>`},
  {key:'oi', label:'OI', type:'num', td:r=>`<td class="sec">${fmtUsd(r.oi)}</td>`},
];
const COL_BY_KEY={}; COLS.forEach(c=>COL_BY_KEY[c.key]=c);

const state={ rows:new Map(), order:[], sortKey:'vol', sortDir:'desc', filter:'', tf:'1d', refreshMs:60000, benchCoin:null,
  filters:{volMin:null,volMax:null,oiMin:null,oiMax:null}, corr:{tf:'90', topN:40, selected:null, search:'', topPairs:10, pair:null},
  colOrder:COLS.map(c=>c.key), colHidden:new Set(), pollMs:60000,
  watch:new Set(), watchOnly:false, detail:null,
  alerts:{ rules:[], log:[], unseen:0, notify:false } };

function el(id){ return document.getElementById(id); }
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function num(s){ if(s==null)return null; const v=typeof s==='number'?s:parseFloat(s); return isFinite(v)?v:null; }
function clamp(x,a,b){ return Math.min(Math.max(x,a),b); }
function parseAmount(str){ if(str==null) return null; const s=String(str).trim().replace(/[$,\s]/g,'');
  if(!s) return null; const m=s.match(/^([0-9]*\.?[0-9]+)([kmbt])?$/i); if(!m) return NaN;
  const v=parseFloat(m[1]); if(!isFinite(v)) return NaN;
  const suf=(m[2]||'').toLowerCase();
  const mult=suf?({k:1e3,m:1e6,b:1e9,t:1e12}[suf]):1e6;
  return v*mult; }
function stdev(a){ if(a.length<2)return 0; const m=a.reduce((p,q)=>p+q,0)/a.length; let v=0; for(const x of a)v+=(x-m)*(x-m); return Math.sqrt(v/(a.length-1)); }
function median(a){ if(!a.length)return 0; const s=[...a].sort((x,y)=>x-y),n=s.length; return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2; }
function linregR2(ys){ const n=ys.length; if(n<3)return {slope:0,r2:0};
  let sx=0,sy=0,sxx=0,sxy=0; for(let i=0;i<n;i++){sx+=i;sy+=ys[i];sxx+=i*i;sxy+=i*ys[i];}
  const d=n*sxx-sx*sx; if(d===0)return {slope:0,r2:0};
  const slope=(n*sxy-sx*sy)/d, b=(sy-slope*sx)/n, my=sy/n; let sr=0,st=0;
  for(let i=0;i<n;i++){ const yh=slope*i+b; sr+=(ys[i]-yh)**2; st+=(ys[i]-my)**2; }
  return {slope, r2: st>0?1-sr/st:0}; }

// ===== formatting =====
const nf=(x,d)=>x.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
function fmtPrice(x){ if(x==null||!isFinite(x))return '—'; const a=Math.abs(x); let d;
  if(a>=100)d=2; else if(a>=10)d=3; else if(a>=1)d=4; else if(a>=0.1)d=4; else if(a>=0.01)d=5; else d=6; return nf(x,d); }
function fmtPct(x){ if(x==null||!isFinite(x))return {t:'—',c:'na'}; return {t:(x>0?'+':'')+x.toFixed(2)+'%', c:x>0?'pos':(x<0?'neg':'sec')}; }
function fmtFunding(f){ if(f==null||!isFinite(f))return {t:'—',c:'na',title:''}; const apr=f*24*365*100;
  return {t:(apr>0?'+':'')+apr.toFixed(2)+'%', c:f>0?'pos':(f<0?'neg':'sec'), title:`${(f*100).toFixed(4)}% / hour · annualized ×24×365. Positive = longs pay shorts.`}; }
function fmtUsd(x){ if(x==null||!isFinite(x))return '—'; const a=Math.abs(x);
  if(a>=1e9)return '$'+nf(x/1e9,2)+'B'; if(a>=1e6)return '$'+nf(x/1e6,2)+'M'; if(a>=1e3)return '$'+nf(x/1e3,1)+'K'; return '$'+nf(x,0); }
function lerp(a,b,t){ return Math.round(a+(b-a)*t); }
function momColor(m){ if(m==null||!isFinite(m))return 'var(--faint)';
  const t=clamp(Math.abs(m)/100,0,1), mut=[126,135,148], tg=m>=0?[70,185,126]:[229,96,77];
  return `rgb(${lerp(mut[0],tg[0],t)},${lerp(mut[1],tg[1],t)},${lerp(mut[2],tg[2],t)})`; }

// ===== row helpers =====
function recomputeChanges(r){ const cur=r.px, ref=r.ref; if(cur==null||!ref)return;
  r.h1=ref.p1h?(cur-ref.p1h)/ref.p1h*100:null; r.h4=ref.p4h?(cur-ref.p4h)/ref.p4h*100:null;
  r.d7=ref.p7d?(cur-ref.p7d)/ref.p7d*100:null;  r.d30=ref.p30d?(cur-ref.p30d)/ref.p30d*100:null; }
function setPrice(r,px){ if(px==null)return; if(r.px!=null&&px!==r.px) r.flash=px>r.px?'up':'down'; r.px=px; }
function activeRows(){ const a=[]; for(const r of state.rows.values()) if(!r.delisted)a.push(r); return a; }
function regimeOf(p,o){ if(p==null||o==null||!isFinite(p)||!isFinite(o)) return null;
  if(p>=0&&o>=0) return {l:'longs+',c:'rg-long'};
  if(p>=0&&o<0)  return {l:'squeeze',c:'rg-sqz'};
  if(p<0&&o>=0)  return {l:'shorts+',c:'rg-short'};
  return {l:'unwind',c:'rg-unw'}; }
function detectBenchmark(){
  for(const a of SP_ALIASES){ for(const r of state.rows.values()) if(!r.delisted&&r.ticker.toUpperCase()===a) return r.coin; }
  for(const r of state.rows.values()){ if(!r.delisted&&/(?:^|[^A-Z])(SPX|SP500|S&P)/i.test(r.ticker)) return r.coin; }
  return null; }

// ===== data ingestion (server snapshots) =====
async function fetchJSON(url){ const r=await fetch(url,{headers:{accept:'application/json'}}); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
async function loadSnapshot(){
  try{ const s=await fetchJSON('/api/snapshot'); applySnapshot(s); setStatus(true); }
  catch(e){ setStatus(false); if(!activeRows().some(r=>r.px!=null)) el('body').innerHTML=errRow(e.message); }
}
async function loadDaily(){ try{ applyDaily(await fetchJSON('/api/daily')); }catch(_){} }
function applySnapshot(s){
  if(!s||!Array.isArray(s.markets)) return;
  state.order=s.markets.map(m=>m.coin);
  const seen=new Set();
  for(const m of s.markets){
    let r=state.rows.get(m.coin);
    if(!r){ r={coin:m.coin, ticker:m.ticker||(m.coin.includes(':')?m.coin.split(':')[1]:m.coin),
      ref:null, feat:null, daily:null, candleTs:0,
      h1:undefined,h4:undefined,d7:undefined,d30:undefined}; state.rows.set(m.coin,r); }
    r.ticker=m.ticker||r.ticker; r.delisted=!!m.delisted;
    if(m.px!=null) setPrice(r,m.px);
    if(m.prevDay!=null) r.prevDay=m.prevDay;
    if(m.funding!=null) r.funding=m.funding;
    if(m.vol!=null) r.vol=m.vol;
    if(m.oi!=null) r.oi=m.oi;
    if(m.oiBase!=null) r.oiBase=m.oiBase;
    if(m.oracle!=null) r.oracle=m.oracle;
    if(m.ref) r.ref=m.ref;
    if(m.feat) r.feat=m.feat;
    if(m.doi) r.doiByWin=m.doi;
    r.d1=(r.px!=null&&r.prevDay)?(r.px-r.prevDay)/r.prevDay*100:r.d1;
    recomputeChanges(r);
    r.candleTs=r.feat?Date.now():(r.candleTs||0);
    seen.add(m.coin);
  }
  for(const k of [...state.rows.keys()]) if(!seen.has(k)) state.rows.delete(k);
  state.benchCoin=s.benchCoin||detectBenchmark();
  const bn=el('benchnote'); if(bn) bn.textContent=(state.benchCoin&&state.rows.get(state.benchCoin))?state.rows.get(state.benchCoin).ticker:'not found';
  updateAggregates(); render(); updateMovers(); updateSyncProgress();
}
function applyDaily(d){ if(!d||!d.daily) return;
  for(const coin in d.daily){ const r=state.rows.get(coin); if(!r) continue;
    const arr=d.daily[coin];
    r.daily=Array.isArray(arr)?arr.map(p=>({t:p[0], c:p[1]})):r.daily;
    r._dret=null; r._wrL=null; }
  scheduleRender();
  if(!el('view-corr').hidden) renderCorr();
}
function updateAggregates(){ const rows=activeRows(); let v=0,o=0;
  for(const r of rows){ if(r.vol)v+=r.vol; if(r.oi)o+=r.oi; }
  el('s-mkts').textContent=rows.length; el('s-vol').textContent=fmtUsd(v); el('s-oi').textContent=fmtUsd(o);
  el('s-upd').textContent=new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function errRow(m){ return `<tr><td colspan="${COLS.length}"><div class="msg err"><span class="big">Couldn't reach the server</span>${esc(m||'Network error')}. Will retry on the next interval.</div></td></tr>`; }
function setStatus(ok){ const d=el('live'); if(d){ d.style.background=ok?'var(--up)':'var(--down)'; d.title=ok?'live':'connection error'; } }
function updateSyncProgress(){ const rows=activeRows(); let done=0; for(const r of rows) if(r.feat) done++;
  const s=el('sync'); if(!s) return;
  if(rows.length>0&&done>=rows.length){ s.classList.add('done'); el('sync-t').textContent='synced'; }
  else { s.classList.remove('done'); el('sync-t').textContent=`syncing ${done}/${rows.length}`; } }

// ===== derived metrics =====
function computeMomentum(r){
  const f=r.feat; if(!f||!(f.volH>0)) return undefined;
  const H=[[r.h1,1,0.10],[r.h4,4,0.15],[r.d1,24,0.30],[r.d7,168,0.30],[r.d30,720,0.15]];
  let s=0,w=0; for(const [ret,hrs,wt] of H){ if(ret==null||!isFinite(ret))continue; s+=wt*((ret/100)/(f.volH*Math.sqrt(hrs))); w+=wt; }
  if(w===0) return null;
  let core=(s/w)*(0.5+0.5*(f.r2||0));
  if(r.px!=null&&f.hi30!=null&&f.lo30!=null&&f.hi30>f.lo30) core+=0.4*(clamp((r.px-f.lo30)/(f.hi30-f.lo30),0,1)-0.5)*2;
  if(r.doi!=null&&isFinite(r.doi)) core*=clamp(1+0.4*Math.tanh(r.doi/8),0.6,1.4);
  return 100*Math.tanh(core/1.5);
}
function computeDerived(){
  const tfKey=TF_MAP[state.tf]||'d1';
  const bench=state.benchCoin?state.rows.get(state.benchCoin):null, benchRet=bench?bench[tfKey]:null;
  for(const r of state.rows.values()){ if(r.delisted)continue;
    r.doi=r.doiByWin?(r.doiByWin[tfKey]??null):null;
    r.regime=regimeOf(r[tfKey], r.doi);
    r.mom=computeMomentum(r);
    const prem=(r.px!=null&&r.oracle)?Math.abs((r.px-r.oracle)/r.oracle):0;
    const vs=(r.vol!=null&&r.feat&&r.feat.volBase>0)?r.vol/r.feat.volBase:null;
    r.hot=(vs!=null&&vs>=1.8)||prem>=0.004;
    if(!state.benchCoin) r.rs=undefined;
    else if(r.coin===state.benchCoin) r.rs=0;
    else if(benchRet==null) r.rs=null;
    else { const a=r[tfKey]; r.rs=(a!=null&&isFinite(a))?a-benchRet:null; }
    r.vol30=(r.feat&&r.feat.volH>0)?r.feat.volH*Math.sqrt(24*365)*100:undefined;
    r.dd=(r.px!=null&&r.feat&&r.feat.hi30>0)?(r.px-r.feat.hi30)/r.feat.hi30*100:undefined;
    r.trend=(r.d30!=null&&isFinite(r.d30))?r.d30:undefined;
    if(!state.benchCoin) r.beta=undefined;
    else if(r.coin===state.benchCoin){ r.beta=1; r.betaR2=1; }
    else if(bench&&bench.daily&&r.daily){ const bt=computeBeta(r,bench,90); if(bt){ r.beta=bt.beta; r.betaR2=bt.r2; } else r.beta=undefined; }
    else r.beta=undefined;
  }
}
function computeBeta(r, bench, Ldays){
  const mr=dailyReturns(r), mb=dailyReturns(bench); if(!mr||!mb) return null;
  const cutoff=Math.floor(Date.now()/DAY)-Ldays, xs=[],ys=[];
  for(const [d,vb] of mb){ if(d<cutoff)continue; const va=mr.get(d); if(va!==undefined){ xs.push(vb); ys.push(va); } }
  const n=xs.length; if(n<20) return null;
  let sx=0,sy=0; for(let i=0;i<n;i++){sx+=xs[i];sy+=ys[i];}
  const mx=sx/n,my=sy/n; let cov=0,vx=0,vy=0;
  for(let i=0;i<n;i++){ const dx=xs[i]-mx,dy=ys[i]-my; cov+=dx*dy; vx+=dx*dx; vy+=dy*dy; }
  if(vx<=0) return null;
  return {beta:cov/vx, r2: vy>0?(cov*cov)/(vx*vy):0};
}
function betaCell(r){
  if(!state.benchCoin) return '<td><span class="na" title="no S&amp;P benchmark detected">—</span></td>';
  if(r.coin===state.benchCoin) return '<td><span class="sec" title="the benchmark itself">1.00</span></td>';
  if(r.beta==null||!isFinite(r.beta)) return '<td><span class="na" title="loading daily history…">·</span></td>';
  const c=r.beta<0?'neg':(r.beta>1.15?'pos':'sec');
  return `<td><span class="${c}" title="R²=${(r.betaR2||0).toFixed(2)} — fit quality vs the S&amp;P">${r.beta.toFixed(2)}</span></td>`;
}

// ===== rendering =====
let renderQueued=false;
function scheduleRender(){ if(renderQueued)return; renderQueued=true; requestAnimationFrame(()=>{renderQueued=false; render(); updateMovers();}); }
function scCls(r){ return (r.candleTs && (Date.now()-r.candleTs>2*state.refreshMs+60000)) ? 'stale':''; }
function visibleCols(){ return state.colOrder.map(k=>COL_BY_KEY[k]).filter(c=>c && !state.colHidden.has(c.key)); }
let dragKey=null;
function clearDropMarks(){ document.querySelectorAll('#head th').forEach(t=>t.classList.remove('drop-before','drop-after')); }
function moveColumn(src, dst, after){
  if(src===dst) return;
  const ord=state.colOrder.filter(k=>k!==src);
  let i=ord.indexOf(dst); if(i<0) i=ord.length-1;
  ord.splice(after?i+1:i, 0, src);
  state.colOrder=ord; clearDropMarks(); buildHead(); render(); savePrefs();
}
function buildHead(){ const tr=el('head'); tr.innerHTML='';
  visibleCols().forEach(c=>{ const th=document.createElement('th'); th.tabIndex=0; th.dataset.key=c.key; th.setAttribute('role','columnheader'); th.draggable=true;
    let label=c.label; if(c.key==='rs')label=`vs S&amp;P (${state.tf})`; if(c.key==='doi')label=`ΔOI (${state.tf})`;
    const active=state.sortKey===c.key; th.setAttribute('aria-sort', active?(state.sortDir==='asc'?'ascending':'descending'):'none');
    if(c.tip) th.title=c.tip;
    th.innerHTML=`<span class="grip" aria-hidden="true">⠿</span>${label}`+(active?`<span class="arw">${state.sortDir==='asc'?'▲':'▼'}</span>`:'');
    th.addEventListener('click',()=>sortBy(c.key));
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
function sortedRows(){ let rows=activeRows(); const f=state.filter.trim().toUpperCase();
  if(f) rows=rows.filter(r=>r.ticker.toUpperCase().includes(f)||r.coin.toUpperCase().includes(f));
  if(state.watchOnly) rows=rows.filter(r=>state.watch.has(r.coin));
  const fl=state.filters;
  if(fl.volMin!=null||fl.volMax!=null||fl.oiMin!=null||fl.oiMax!=null){
    rows=rows.filter(r=>{
      if(fl.volMin!=null && !(r.vol!=null&&r.vol>=fl.volMin)) return false;
      if(fl.volMax!=null && !(r.vol!=null&&r.vol<=fl.volMax)) return false;
      if(fl.oiMin!=null  && !(r.oi!=null &&r.oi >=fl.oiMin )) return false;
      if(fl.oiMax!=null  && !(r.oi!=null &&r.oi <=fl.oiMax )) return false;
      return true; });
  }
  const k=state.sortKey, dir=state.sortDir==='asc'?1:-1, col=COLS.find(c=>c.key===k);
  rows.sort((a,b)=>{ let av=a[k],bv=b[k]; if(col.type==='str')return dir*String(av).localeCompare(String(bv));
    const an=(av==null||!isFinite(av)),bn=(bv==null||!isFinite(bv)); if(an&&bn)return 0; if(an)return 1; if(bn)return -1; return dir*(av-bv); });
  if(state.watch.size){ const star=rows.filter(r=>state.watch.has(r.coin)), rest=rows.filter(r=>!state.watch.has(r.coin)); rows=[...star,...rest]; }
  return rows; }
function pctInner(v){ if(v===undefined)return '<span class="ph">·</span>'; const p=fmtPct(v); return `<span class="${p.c}">${p.t}</span>`; }
function momCell(r){ if(r.mom===undefined)return '<span class="ph">·</span>'; if(r.mom===null)return '<span class="na">—</span>';
  const sign=r.mom>0?'+':'';
  return `<span style="color:${momColor(r.mom)};font-weight:600">${sign}${Math.round(r.mom)}</span>`+(r.hot?'<span class="hotdot" title="volume / activity well above this market\u2019s own norm">●</span>':''); }
function rsCell(r){ if(!state.benchCoin)return '<span class="na" title="no S&amp;P market detected">—</span>';
  if(r.coin===state.benchCoin)return '<span class="sec" title="this is the S&amp;P benchmark">S&amp;P</span>';
  const p=fmtPct(r.rs); return `<span class="${p.c}">${p.t}</span>`; }
function oiCell(r){ if(r.doi==null)return '<span class="na" title="collecting OI history (server-side, accrues over time)">—</span>';
  const oc=r.doi>0?'pos':(r.doi<0?'neg':'sec'), sign=r.doi>0?'+':'';
  let s=`<span class="${oc}">${sign}${r.doi.toFixed(2)}%</span>`;
  if(r.regime) s+=`<span class="rg ${r.regime.c}" title="price ${r[TF_MAP[state.tf]]>=0?'up':'down'} + OI ${r.doi>=0?'up':'down'} over ${state.tf}">${r.regime.l}</span>`;
  return s; }
function shade(v, cap){ if(v==null||!isFinite(v)) return ''; const t=Math.min(Math.abs(v)/cap,1)*0.20; const rgb=v>=0?'70,185,126':'229,96,77'; return ` style="background:rgba(${rgb},${t.toFixed(3)})"`; }
function miniSpark(vals, color){ const w=62,h=18,pad=2; if(vals.length<2) return ''; const mn=Math.min(...vals),mx=Math.max(...vals),rng=(mx-mn)||1;
  const X=i=>pad+(i/(vals.length-1))*(w-2*pad), Y=v=>h-pad-((v-mn)/rng)*(h-2*pad);
  let d=''; vals.forEach((v,i)=>d+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)+' ');
  return `<svg class="tspark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.3" vector-effect="non-scaling-stroke"/></svg>`; }
function trendCell(r){ const c=r.daily; if(!c||c.length<3) return '<td><span class="na">·</span></td>';
  const cl=c.slice(-31).map(k=>parseFloat(k.c)).filter(isFinite); if(cl.length<3) return '<td><span class="na">·</span></td>';
  const up=cl[cl.length-1]>=cl[0]; return `<td title="30d path">${miniSpark(cl, up?'var(--up)':'var(--down)')}</td>`; }
function volCell(r){ if(r.vol30==null||!isFinite(r.vol30)) return '<td><span class="na" title="loading hourly history…">·</span></td>';
  return `<td class="sec" title="annualized realized vol">${r.vol30.toFixed(0)}%</td>`; }
function ddCell(r){ if(r.dd==null||!isFinite(r.dd)) return '<td><span class="na">·</span></td>';
  const c=r.dd>=-0.5?'pos':(r.dd<=-15?'neg':'sec'); return `<td class="${c}" title="distance below the 30-day high">${r.dd.toFixed(1)}%</td>`; }
function render(){
  if(!state.rows.size) return; computeDerived(); evaluateAlerts();
  const body=el('body'), rows=sortedRows(), vc=visibleCols();
  const fc=el('fcount'); if(fc){ const tot=activeRows().length; fc.textContent=(rows.length!==tot)?`showing ${rows.length} of ${tot}`:''; }
  if(!rows.length){ body.innerHTML=`<tr><td colspan="${vc.length}"><div class="msg"><span class="big">No matches</span>Clear the filters to see all markets.</div></td></tr>`; return; }
  const out=[];
  for(const r of rows){ const cls=(r.coin===state.benchCoin)?' class="benchrow"':'';
    let row=`<tr data-coin="${esc(r.coin)}"${cls}>`; for(const c of vc) row+=c.td(r); row+='</tr>'; r.flash=null; out.push(row); }
  body.innerHTML=out.join('');
}
function updateMovers(){ const rows=activeRows().filter(r=>r.d1!=null&&isFinite(r.d1));
  if(rows.length<3){ el('movers').hidden=true; return; } el('movers').hidden=false;
  const byChg=[...rows].sort((a,b)=>b.d1-a.d1);
  const chip=r=>`<span class="chip ${r.d1>=0?'up':'down'}"><span class="t">${esc(r.ticker)}</span><span class="p">${fmtPct(r.d1).t}</span></span>`;
  el('movers-list').innerHTML=byChg.slice(0,3).map(chip).join('')+`<span style="width:1px;background:var(--border);margin:0 2px"></span>`+byChg.slice(-3).reverse().map(chip).join(''); }

// ===== correlation tab =====
const CORR={ _rows:null, _C:null, _N:null, _ord:null, _readout:'Hover a cell to read a pair · click a ticker for its co-movers &amp; hedges' };
function corrScope(){
  let rows=activeRows().filter(r=>r.vol!=null);
  const s=state.corr.search.trim();
  if(s){ const terms=s.toUpperCase().split(/[,\s]+/).filter(Boolean);
    rows=rows.filter(r=>terms.some(t=>r.ticker.toUpperCase().includes(t)||r.coin.toUpperCase().includes(t)));
    rows.sort((a,b)=>(b.vol||0)-(a.vol||0)); return rows.slice(0,60); }
  rows.sort((a,b)=>(b.vol||0)-(a.vol||0)); return rows.slice(0, state.corr.topN);
}
function dailyReturns(r){ if(r._dret) return r._dret; const c=r.daily; if(!c||c.length<2){ r._dret=null; return null; }
  const m=new Map(); let prev=null;
  for(const k of c){ const cl=parseFloat(k.c), day=Math.floor(k.t/DAY); if(isFinite(cl)){ if(prev!=null&&prev>0) m.set(day, Math.log(cl/prev)); prev=cl; } }
  r._dret=m; return m; }
function pearson(a,b){ const n=a.length; if(n<3) return null; let sa=0,sb=0; for(let i=0;i<n;i++){sa+=a[i];sb+=b[i];}
  const ma=sa/n, mb=sb/n; let cov=0,va=0,vb=0; for(let i=0;i<n;i++){ const da=a[i]-ma, db=b[i]-mb; cov+=da*db; va+=da*da; vb+=db*db; }
  if(va<=0||vb<=0) return null; return cov/Math.sqrt(va*vb); }
function buildCorr(rows, Ldays){
  const cutoff=Math.floor(Date.now()/DAY)-Ldays, minOv=Math.max(15, Math.floor(Ldays*0.5));
  const series=rows.map(r=>{ const m=dailyReturns(r); if(!m) return null; const f=new Map(); for(const [d,v] of m) if(d>=cutoff) f.set(d,v); return f; });
  const N=rows.length, C=Array.from({length:N},()=>new Array(N).fill(null)), OV=Array.from({length:N},()=>new Array(N).fill(0));
  for(let i=0;i<N;i++){ C[i][i]=1; const si=series[i]; if(!si) continue;
    for(let j=i+1;j<N;j++){ const sj=series[j]; if(!sj) continue;
      const small=si.size<sj.size?si:sj, other=small===si?sj:si, a=[],b=[];
      for(const [d,v] of small){ const w=other.get(d); if(w!==undefined){ a.push(v); b.push(w); } }
      const c=a.length>=minOv?pearson(a,b):null; C[i][j]=c; C[j][i]=c; OV[i][j]=a.length; OV[j][i]=a.length; } }
  return {C, N:OV};
}
function clusterOrder(D){ const n=D.length; if(n<=2) return D.map((_,i)=>i);
  const key=(a,b)=>a<b?a+','+b:b+','+a, dmap=new Map();
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) dmap.set(key(i,j), D[i][j]);
  let clusters=[]; for(let i=0;i<n;i++) clusters.push({id:i,size:1,order:[i]}); let nid=n;
  while(clusters.length>1){ let bi=0,bj=1,bd=Infinity;
    for(let i=0;i<clusters.length;i++) for(let j=i+1;j<clusters.length;j++){ const d=dmap.get(key(clusters[i].id,clusters[j].id)); if(d<bd){bd=d;bi=i;bj=j;} }
    const A=clusters[bi], B=clusters[bj], id=nid++;
    for(const C of clusters){ if(C===A||C===B) continue; const dA=dmap.get(key(A.id,C.id)), dB=dmap.get(key(B.id,C.id));
      dmap.set(key(id,C.id), (A.size*dA+B.size*dB)/(A.size+B.size)); }
    clusters=clusters.filter(c=>c!==A&&c!==B); clusters.push({id, size:A.size+B.size, order:A.order.concat(B.order)}); }
  return clusters[0].order; }
function corrColor(c){ if(c==null||!isFinite(c)) return 'var(--panel2)';
  const t=clamp(Math.abs(c),0,1), mid=[20,26,33], tg=c>=0?[70,185,126]:[229,96,77];
  return `rgb(${lerp(mid[0],tg[0],t)},${lerp(mid[1],tg[1],t)},${lerp(mid[2],tg[2],t)})`; }
function windowRetPct(r, Ldays){ if(!r) return null; if(r._wrL===Ldays) return r._wrV;
  const c=r.daily; let val=null;
  if(c&&c.length>=2){ const cutoff=Date.now()-Ldays*DAY; let first=null,last=null;
    for(const k of c){ const cl=parseFloat(k.c); if(!isFinite(cl))continue; if(k.t>=cutoff&&first==null)first=cl; last=cl; }
    if(first!=null&&last!=null&&first>0) val=(last-first)/first*100; }
  r._wrL=Ldays; r._wrV=val; return val; }
function tfLabel(){ return state.corr.tf==='365'?'1y':state.corr.tf+'d'; }
function sret(x){ return x==null?'<span class="na">·</span>':`<span class="${x>=0?'pos':'neg'}">${x>=0?'+':''}${x.toFixed(1)}%</span>`; }
function spp(d){ return d==null?'<span class="na">·</span>':`<span class="${d>=0?'pos':'neg'}">${d>=0?'+':''}${d.toFixed(0)}pp</span>`; }
function corrTipHtml(ri,ci){ const rows=CORR._rows; if(!rows||!CORR._C) return '';
  const a=rows[ri], b=rows[ci], L=+state.corr.tf, ra=windowRetPct(a,L);
  if(ri===ci) return `<div class="hd"><span class="tk">${esc(a.ticker)}</span></div><div class="mut">${tfLabel()} return ${ra==null?'n/a':(ra>=0?'+':'')+ra.toFixed(1)+'%'}</div>`;
  const v=CORR._C[ri][ci], n=CORR._N[ri][ci]||0, rb=windowRetPct(b,L);
  let s=`<div class="hd"><span class="tk">${esc(a.ticker)}</span> <span class="mut">×</span> <span class="tk">${esc(b.ticker)}</span></div>`;
  s+=`<div>r = ${v==null?'<span class="na">n/a</span>':`<span class="${v>=0?'pos':'neg'}">${v>=0?'+':''}${v.toFixed(2)}</span>`} <span class="mut">· ${n}d overlap</span></div>`;
  if(ra!=null&&rb!=null){ const d=ra-rb;
    s+=`<div class="mut" style="margin-top:3px">${tfLabel()} performance</div>`;
    s+=`<div>${esc(a.ticker)} ${sret(ra)} · ${esc(b.ticker)} ${sret(rb)}</div>`;
    s+=`<div>spread ${spp(d)} <span class="mut">(${esc(d>=0?a.ticker:b.ticker)} ahead)</span></div>`;
  } else s+=`<div class="mut">performance: not enough history</div>`;
  return s; }
function positionTip(tip,e){ const pad=14, w=tip.offsetWidth, h=tip.offsetHeight;
  let x=e.clientX+pad, y=e.clientY+pad; if(x+w>innerWidth-6) x=e.clientX-w-pad; if(y+h>innerHeight-6) y=e.clientY-h-pad;
  tip.style.left=Math.max(6,x)+'px'; tip.style.top=Math.max(6,y)+'px'; }
function setCorrSync(t,done){ const s=el('corrsync'); if(!s)return; s.classList.toggle('done',!!done); el('corrsync-t').textContent=t; }

function openCorr(){
  if(!state.rows.size){ el('corrwrap').innerHTML='<div class="msg">Markets still loading — switch back in a moment.</div>'; return; }
  const rows=corrScope(), have=rows.filter(r=>r.daily).length;
  setCorrSync(have>=rows.length?'ready':`loading ${have}/${rows.length}`, have>=rows.length);
  renderCorr();
}
function readoutHtml(rt,ct,v,n){
  if(v==null||v==='na'||v==='') return `<b>${esc(rt)}</b> × <b>${esc(ct)}</b> · <span class="na">not enough overlapping history</span>`;
  const f=parseFloat(v), cls=f>0?'pos':(f<0?'neg':'sec');
  return `<b>${esc(rt)}</b> × <b>${esc(ct)}</b> · <span class="${cls}">${f>=0?'+':''}${f.toFixed(2)}</span> · ${n}d overlap`;
}
function renderCorr(){
  const rows=corrScope();
  if(rows.length<2){ el('corrwrap').innerHTML='<div class="msg"><span class="big">Not enough markets</span>Widen the focus search or pick a larger set.</div>'; el('corrpairs').innerHTML=''; el('corrpanel').hidden=true; return; }
  const L=+state.corr.tf, res=buildCorr(rows,L), C=res.C, OV=res.N;
  const D=C.map(row=>row.map(v=>v==null?1:1-v));
  const ord=clusterOrder(D);
  const cell=rows.length<=20?30:rows.length<=40?20:15, showVal=rows.length<=20;
  let h=`<table class="cmx" style="--cell:${cell}px"><thead><tr><th class="corner"></th>`;
  ord.forEach(i=>{ h+=`<th class="cl" data-i="${i}" title="${esc(rows[i].ticker)}"><span>${esc(rows[i].ticker)}</span></th>`; });
  h+='</tr></thead><tbody>';
  ord.forEach((ri,dr)=>{ h+=`<tr data-dr="${dr}"><th class="rl" data-i="${ri}" title="${esc(rows[ri].coin)}">${esc(rows[ri].ticker)}</th>`;
    ord.forEach((ci,dc)=>{ const v=C[ri][ci], self=ri===ci;
      const cls=self?'diag':(v==null?'nodata':'');
      const vs=(v==null)?'na':String(v);
      const txt=(showVal&&v!=null&&!self)?`${v<0?'−':''}${Math.abs(v).toFixed(1).replace(/^0/,'')}`:'';
      h+=`<td class="${cls}" data-ri="${ri}" data-ci="${ci}" data-dc="${dc}" data-rt="${esc(rows[ri].ticker)}" data-ct="${esc(rows[ci].ticker)}" data-v="${vs}" data-n="${OV[ri][ci]||0}" style="${self||v==null?'':'background:'+corrColor(v)}">${txt}</td>`; });
    h+='</tr>'; });
  h+='</tbody></table>';
  el('corrwrap').innerHTML=h;
  CORR._rows=rows; CORR._C=C; CORR._N=OV; CORR._ord=ord;
  const tbl=el('corrwrap').querySelector('table.cmx');
  const cols=[...tbl.querySelectorAll('thead th.cl')], rls=[...tbl.querySelectorAll('tbody th.rl')];
  tbl.addEventListener('mouseover', e=>{ const td=e.target.closest('td'); if(!td) return;
    const dc=+td.dataset.dc, dr=+td.closest('tr').dataset.dr;
    cols.forEach((t,i)=>t.classList.toggle('hl',i===dc)); rls.forEach((t,i)=>t.classList.toggle('hl',i===dr));
    el('corr-readout').innerHTML=readoutHtml(td.dataset.rt, td.dataset.ct, td.dataset.v, td.dataset.n); });
  tbl.addEventListener('mousemove', e=>{ const td=e.target.closest('td'); const tip=el('corrtip');
    if(!td){ tip.hidden=true; return; }
    tip.innerHTML=corrTipHtml(+td.dataset.ri, +td.dataset.ci); tip.hidden=false; positionTip(tip,e); });
  tbl.addEventListener('mouseleave', ()=>{ cols.forEach(t=>t.classList.remove('hl')); rls.forEach(t=>t.classList.remove('hl')); el('corr-readout').innerHTML=CORR._readout; el('corrtip').hidden=true; });
  tbl.querySelectorAll('.cl,.rl').forEach(n=>n.addEventListener('click',()=>{ state.corr.selected=+n.dataset.i; state.corr.pair=null; renderPairPanel(); renderCorrPanel(); }));
  tbl.addEventListener('click', e=>{ const td=e.target.closest('td'); if(!td||td.dataset.ri==null) return;
    const ri=+td.dataset.ri, ci=+td.dataset.ci; if(ri!==ci && CORR._C[ri][ci]!=null) openPair(ri,ci); });
  renderCorrPanel(); renderPairPanel(); renderCorrPairs();
}
function renderCorrPanel(){
  const p=el('corrpanel'), rows=CORR._rows, C=CORR._C, sel=state.corr.selected;
  if(sel==null||!rows||!C||sel>=rows.length){ p.hidden=true; return; }
  const me=rows[sel], pairs=[];
  for(let j=0;j<rows.length;j++){ if(j===sel) continue; const v=C[sel][j]; if(v!=null&&isFinite(v)) pairs.push([rows[j].ticker,v,j]); }
  pairs.sort((a,b)=>b[1]-a[1]);
  const pos=pairs.slice(0,8), neg=pairs.slice(-8).reverse().filter(x=>x[1]<0);
  const L=+state.corr.tf, rMe=windowRetPct(me,L);
  const bar=v=>`<span class="cbar" style="width:${Math.round(Math.abs(v)*64)}px;background:${corrColor(v)}"></span>`;
  const li=(t,v,j)=>{ const rb=windowRetPct(rows[j],L), d=(rMe!=null&&rb!=null)?rMe-rb:null;
    const tip=(rMe!=null&&rb!=null)?`${esc(me.ticker)} ${rMe>=0?'+':''}${rMe.toFixed(1)}% vs ${esc(t)} ${rb>=0?'+':''}${rb.toFixed(1)}% over ${tfLabel()}`:'not enough history';
    return `<div class="crow"><span class="ct">${esc(t)}</span>${bar(v)}<span class="cv ${v>=0?'pos':'neg'}">${v>=0?'+':''}${v.toFixed(2)}</span><span class="cv2" title="${esc(tip)}">${spp(d)}</span></div>`; };
  const tfl=tfLabel();
  p.hidden=false;
  p.innerHTML=`<div class="cp-head">${esc(me.ticker)} <span class="sec" style="font-weight:400">— ${tfl} daily-return correlation · Δ = ${esc(me.ticker)} return − other</span></div>
    <div class="cp-cols">
      <div><div class="cp-sub">Strongest co-movers</div>${pos.map(x=>li(x[0],x[1],x[2])).join('')||'<div class="sec">—</div>'}</div>
      <div><div class="cp-sub">Strongest hedges (inverse)</div>${neg.length?neg.map(x=>li(x[0],x[1],x[2])).join(''):'<div class="sec">no negative correlations in this window</div>'}</div>
    </div>`;
}
function renderCorrPairs(){
  const rows=CORR._rows, C=CORR._C, OV=CORR._N, box=el('corrpairs');
  if(!rows||!C){ box.innerHTML=''; return; }
  const L=+state.corr.tf, pairs=[];
  for(let i=0;i<rows.length;i++) for(let j=i+1;j<rows.length;j++){ const v=C[i][j]; if(v!=null&&isFinite(v)) pairs.push({a:rows[i].ticker,b:rows[j].ticker,v,n:OV[i][j],i,j}); }
  if(!pairs.length){ box.innerHTML='<div class="sec" style="padding:8px 2px">Not enough overlapping history for pairs yet.</div>'; return; }
  pairs.sort((x,y)=>y.v-x.v);
  const k=state.corr.topPairs, top=pairs.slice(0,k), bot=pairs.slice(-k).reverse().filter(p=>p.v<0);
  const tfl=tfLabel();
  const row=p=>{ const ra=windowRetPct(rows[p.i],L), rb=windowRetPct(rows[p.j],L), d=(ra!=null&&rb!=null)?ra-rb:null;
    const dt=(ra!=null&&rb!=null)?`${tfl}: ${p.a} ${ra>=0?'+':''}${ra.toFixed(1)}% vs ${p.b} ${rb>=0?'+':''}${rb.toFixed(1)}%`:'not enough history';
    return `<tr data-i="${p.i}" data-j="${p.j}"><td class="pp">${esc(p.a)} <span class="sec">×</span> ${esc(p.b)}</td>`+
      `<td class="${p.v>=0?'pos':'neg'}" style="text-align:right">${p.v>=0?'+':''}${p.v.toFixed(2)}</td>`+
      `<td style="text-align:right" title="${esc(dt)}">${spp(d)}</td>`+
      `<td class="sec" style="text-align:right">${p.n}d</td></tr>`; };
  const head='<thead><tr><th>Pair</th><th>r</th><th title="window-return spread: left ticker − right ticker">Δ</th><th>n</th></tr></thead>';
  box.innerHTML=`<div class="cp-cols">
    <div><div class="cp-sub">Strongest correlations (${tfl})</div><table class="ptbl">${head}<tbody>${top.map(row).join('')}</tbody></table></div>
    <div><div class="cp-sub">Strongest inverse correlations (${tfl})</div><table class="ptbl">${head}<tbody>${bot.length?bot.map(row).join(''):'<tr><td class="sec" colspan="4">no negative correlations in this window</td></tr>'}</tbody></table></div>
  </div>`;
  box.querySelectorAll('tbody tr[data-i]').forEach(tr=>tr.addEventListener('click',()=>{ openPair(+tr.dataset.i, +tr.dataset.j); }));
}
function alignedDaily(a,b,Ldays){ const ca=a.daily, cb=b.daily; if(!ca||!cb) return null;
  const cutoff=Math.floor(Date.now()/DAY)-Ldays, ma=new Map(), mb=new Map();
  for(const k of ca){ const cl=parseFloat(k.c), d=Math.floor(k.t/DAY); if(isFinite(cl)&&d>=cutoff) ma.set(d,cl); }
  for(const k of cb){ const cl=parseFloat(k.c), d=Math.floor(k.t/DAY); if(isFinite(cl)&&d>=cutoff) mb.set(d,cl); }
  const days=[...ma.keys()].filter(d=>mb.has(d)).sort((x,y)=>x-y);
  return {days, pa:days.map(d=>ma.get(d)), pb:days.map(d=>mb.get(d))}; }
function sparkline(vals, opts){ opts=opts||{}; const w=260, h=46, pad=4;
  const fin=vals.filter(v=>v!=null&&isFinite(v)); if(fin.length<2) return '<div class="sec" style="font-size:11px">not enough data</div>';
  let mn=Math.min(...fin), mx=Math.max(...fin);
  if(opts.lo!=null)mn=Math.min(mn,opts.lo); if(opts.hi!=null)mx=Math.max(mx,opts.hi); if(mn===mx){mn-=1;mx+=1;}
  const X=i=>pad+(i/(vals.length-1))*(w-2*pad), Y=v=>h-pad-((v-mn)/(mx-mn))*(h-2*pad);
  let d='',started=false; vals.forEach((v,i)=>{ if(v==null||!isFinite(v)){return;} d+=(started?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)+' '; started=true; });
  let pre='';
  if(opts.band!=null&&opts.mean!=null){ const y1=Y(opts.mean+opts.band), y2=Y(opts.mean-opts.band); pre+=`<rect x="${pad}" y="${Math.min(y1,y2).toFixed(1)}" width="${w-2*pad}" height="${Math.abs(y2-y1).toFixed(1)}" fill="var(--accent)" opacity="0.08"/>`; }
  if(opts.mean!=null){ const ym=Y(opts.mean).toFixed(1); pre+=`<line x1="${pad}" y1="${ym}" x2="${w-pad}" y2="${ym}" stroke="var(--faint)" stroke-dasharray="3 3"/>`; }
  if(opts.zero){ const yz=Y(0).toFixed(1); pre+=`<line x1="${pad}" y1="${yz}" x2="${w-pad}" y2="${yz}" stroke="var(--grid)"/>`; }
  const li=vals.length-1, lv=vals[li], col=opts.color||'var(--accent)';
  const dot=(lv!=null&&isFinite(lv))?`<circle cx="${X(li).toFixed(1)}" cy="${Y(lv).toFixed(1)}" r="2.5" fill="${col}"/>`:'';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${pre}<path d="${d.trim()}" fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>${dot}</svg>`; }
function rollStability(roll){ const v=roll.filter(x=>x!=null&&isFinite(x)); if(v.length<3)return '';
  const s=stdev(v), mn=Math.min(...v), mx=Math.max(...v);
  if(s<0.15) return 'stable relationship across the window';
  if(mx-mn>0.8) return 'unstable — the relationship flips within the window';
  return 'moderately variable over the window'; }
function openPair(i,j){ const rows=CORR._rows; if(!rows||i==null||j==null||i===j||i>=rows.length||j>=rows.length) return;
  state.corr.pair=[i,j]; state.corr.selected=null; renderCorrPanel(); renderPairPanel();
  el('pairpanel').scrollIntoView({behavior:'smooth',block:'nearest'}); }
function renderPairPanel(){
  const p=el('pairpanel'), rows=CORR._rows, pr=state.corr.pair;
  if(!rows||!pr){ p.hidden=true; return; }
  const [i,j]=pr, A=rows[i], B=rows[j]; if(!A||!B){ p.hidden=true; return; }
  const L=+state.corr.tf, al=alignedDaily(A,B,L);
  const close='<button class="btn xtiny" id="pairclose" title="close" style="float:right">✕</button>';
  if(!al||al.days.length<8){ p.hidden=false;
    p.innerHTML=`<div class="cp-head">${esc(A.ticker)} ÷ ${esc(B.ticker)} ${close}</div><div class="sec" style="margin-top:6px">Not enough overlapping daily history yet — still loading in the background, or one of these listed recently.</div>`;
    el('pairclose').onclick=()=>{ state.corr.pair=null; p.hidden=true; }; return; }
  const retA=[],retB=[]; for(let k=1;k<al.pa.length;k++){ retA.push(Math.log(al.pa[k]/al.pa[k-1])); retB.push(Math.log(al.pb[k]/al.pb[k-1])); }
  let saA=0,saB=0; const nR=retA.length; for(let k=0;k<nR;k++){saA+=retA[k];saB+=retB[k];}
  const mA=saA/nR, mB=saB/nR; let cov=0,vB=0; for(let k=0;k<nR;k++){const da=retA[k]-mA,db=retB[k]-mB;cov+=da*db;vB+=db*db;}
  const hedge=vB>0?cov/vB:1;
  const resid=al.pa.map((x,k)=>Math.log(x)-hedge*Math.log(al.pb[k]));
  const m=resid.reduce((s,x)=>s+x,0)/resid.length, sd=stdev(resid), last=resid[resid.length-1], z=sd>0?(last-m)/sd:0;
  const W=Math.min(30, Math.max(10, Math.floor(retA.length/3))), roll=[];
  for(let k=0;k<retA.length;k++){ if(k<W-1){ roll.push(null); continue; } roll.push(pearson(retA.slice(k-W+1,k+1), retB.slice(k-W+1,k+1))); }
  const cNow=CORR._C[i][j], ra=windowRetPct(A,L), rb=windowRetPct(B,L), spread=(ra!=null&&rb!=null)?ra-rb:null;
  const zc=Math.abs(z)>=2?'neg':(Math.abs(z)>=1?'pos':'sec');
  const rcap=z>1.5?`spread stretched high — ${esc(A.ticker)} rich vs ${esc(B.ticker)}`:(z<-1.5?`spread stretched low — ${esc(A.ticker)} cheap vs ${esc(B.ticker)}`:'spread near its mean (fair value)');
  p.hidden=false;
  p.innerHTML=`
    <div class="cp-head">${esc(A.ticker)} ÷ ${esc(B.ticker)} <span class="sec" style="font-weight:400">— ${tfLabel()} pair view</span> ${close}</div>
    <div class="pairstats">
      <span>r<b class="${cNow>=0?'pos':'neg'}">${cNow==null?'—':(cNow>=0?'+':'')+cNow.toFixed(2)}</b></span>
      <span>${esc(A.ticker)}<b>${sret(ra)}</b></span>
      <span>${esc(B.ticker)}<b>${sret(rb)}</b></span>
      <span>spread<b>${spp(spread)}</b></span>
      <span>hedge β<b>${hedge.toFixed(2)}</b></span>
      <span>z-score<b class="${zc}">${z>=0?'+':''}${z.toFixed(2)}</b></span>
    </div>
    <div class="pairgrid">
      <div><div class="cp-sub">Beta-adjusted spread <span class="sec">· ln(${esc(A.ticker)}) − β·ln(${esc(B.ticker)}) · mean ±1σ</span></div>
        ${sparkline(resid,{mean:m,band:sd,color:'var(--accent)'})}
        <div class="sec spk-cap">${rcap}</div></div>
      <div><div class="cp-sub">Rolling ${W}d correlation <span class="sec">· now ${cNow==null?'—':cNow.toFixed(2)}</span></div>
        ${sparkline(roll,{zero:true,lo:-1,hi:1,color:'var(--blue)'})}
        <div class="sec spk-cap">${rollStability(roll)}</div></div>
    </div>`;
  el('pairclose').onclick=()=>{ state.corr.pair=null; p.hidden=true; };
}

// ===== CSV export =====
function downloadCSV(name, matrix){
  const csv=matrix.map(row=>row.map(c=>{ const s=(c==null)?'':String(c); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }).join(',')).join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}), url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function csvCell(k,r){ switch(k){
  case 'ticker': return r.ticker; case 'px': return r.px;
  case 'funding': return r.funding!=null?(r.funding*24*365*100).toFixed(4):'';
  case 'h1':return r.h1; case 'h4':return r.h4; case 'd1':return r.d1; case 'd7':return r.d7; case 'd30':return r.d30;
  case 'rs': return r.rs; case 'mom': return r.mom!=null?Math.round(r.mom):'';
  case 'beta': return r.beta!=null&&isFinite(r.beta)?r.beta.toFixed(3):'';
  case 'doi': return r.doi!=null?r.doi.toFixed(2):'';
  case 'vol': return r.vol; case 'oi': return r.oi; default: return ''; } }
function exportMarkets(){ const cols=visibleCols(); const head=cols.map(c=>c.label.replace(/&amp;/g,'&'));
  const body=sortedRows().map(r=>cols.map(c=>csvCell(c.key,r))); downloadCSV('xyz-markets.csv',[head,...body]); }
function exportCorr(){ const rows=CORR._rows, C=CORR._C, ord=CORR._ord; if(!rows||!C||!ord){ return; }
  const head=['',...ord.map(i=>rows[i].ticker)];
  const body=ord.map(ri=>[rows[ri].ticker, ...ord.map(ci=>{ const v=C[ri][ci]; return v==null?'':v.toFixed(4); })]);
  downloadCSV(`xyz-correlation-${tfLabel()}.csv`,[head,...body]); }

// ===== per-ticker detail drawer =====
function comoversFor(coin, L){ const me=state.rows.get(coin); if(!me||!me.daily) return null;
  const mr=dailyReturns(me); if(!mr) return null; const cutoff=Math.floor(Date.now()/DAY)-L, res=[];
  for(const r of activeRows()){ if(r.coin===coin||!r.daily) continue; const or=dailyReturns(r); if(!or) continue;
    const a=[],b=[]; for(const [d,v] of mr){ if(d<cutoff)continue; const w=or.get(d); if(w!==undefined){a.push(v);b.push(w);} }
    if(a.length<20) continue; const c=pearson(a,b); if(c!=null&&isFinite(c)) res.push([r.ticker,c]); }
  res.sort((x,y)=>y[1]-x[1]); return res; }
function openDetail(coin){ const r=state.rows.get(coin); if(!r) return; state.detail=coin;
  const co=comoversFor(coin,90), pos=co?co.slice(0,6):[], neg=co?co.slice(-6).reverse().filter(x=>x[1]<0):[];
  const closes=r.daily?r.daily.slice(-90).map(k=>parseFloat(k.c)).filter(isFinite):[];
  const fu=fmtFunding(r.funding), pct=v=>{const p=fmtPct(v);return `<span class="${p.c}">${p.t}</span>`;};
  const st=(k,v)=>`<div class="dstat"><span class="dk">${k}</span><span class="dv">${v}</span></div>`;
  const betaTxt=(r.beta!=null&&isFinite(r.beta))?r.beta.toFixed(2):'·';
  const momTxt=(r.mom==null)?'·':`<span style="color:${momColor(r.mom)}">${r.mom>0?'+':''}${Math.round(r.mom)}</span>`;
  const bar=v=>`<span class="cbar" style="width:${Math.round(Math.abs(v)*64)}px;background:${corrColor(v)}"></span>`;
  const li=(t,v)=>`<div class="crow"><span class="ct">${esc(t)}</span>${bar(v)}<span class="cv ${v>=0?'pos':'neg'}">${v>=0?'+':''}${v.toFixed(2)}</span></div>`;
  const starred=state.watch.has(coin);
  el('drawer').innerHTML=`
    <div class="dhead">${esc(r.ticker)}
      <span class="star${starred?' on':''}" id="dstar" style="font-size:16px;cursor:pointer">${starred?'★':'☆'}</span>
      <button class="dclose" id="dclose" title="close">✕</button></div>
    <div class="dsub">${esc(r.coin)} · ${fmtPrice(r.px)}${r.coin===state.benchCoin?' · S&amp;P benchmark':''}</div>
    ${closes.length>2?`<div class="dsec">90-day price</div>${sparkline(closes,{color: closes[closes.length-1]>=closes[0]?'var(--up)':'var(--down)'})}`:''}
    <div class="dsec">Metrics</div>
    <div class="dgrid">
      ${st('Funding (APR)',`<span class="${fu.c}">${fu.t}</span>`)}
      ${st('Momentum',momTxt)}
      ${st('1h',pct(r.h1))} ${st('4h',pct(r.h4))}
      ${st('1d',pct(r.d1))} ${st('7d',pct(r.d7))}
      ${st('30d',pct(r.d30))} ${st('vs S&amp;P ('+state.tf+')', r.rs==null?'<span class="na">—</span>':pct(r.rs))}
      ${st('β vs S&amp;P',betaTxt)} ${st('Vol (ann)', r.vol30!=null?r.vol30.toFixed(0)+'%':'·')}
      ${st('vs 30d high', r.dd!=null?`<span class="${r.dd>=-0.5?'pos':'sec'}">${r.dd.toFixed(1)}%</span>`:'·')}
      ${st('ΔOI ('+state.tf+')', r.doi!=null?`<span class="${r.doi>=0?'pos':'neg'}">${r.doi>=0?'+':''}${r.doi.toFixed(2)}%</span>`:'<span class="na">—</span>')}
      ${st('24h Vol',fmtUsd(r.vol))} ${st('Open Interest',fmtUsd(r.oi))}
    </div>
    <div class="dsec">Top co-movers (90d)</div>${pos.length?pos.map(x=>li(x[0],x[1])).join(''):'<div class="sec" style="font-size:12px">daily history still loading…</div>'}
    <div class="dsec">Top hedges — inverse (90d)</div>${neg.length?neg.map(x=>li(x[0],x[1])).join(''):'<div class="sec" style="font-size:12px">no negative correlations</div>'}`;
  el('drawer').classList.add('show'); el('drawerbg').classList.add('show'); el('drawer').setAttribute('aria-hidden','false');
  el('dclose').onclick=closeDetail;
  el('dstar').onclick=()=>{ toggleWatch(coin); openDetail(coin); };
}
function closeDetail(){ state.detail=null; el('drawer').classList.remove('show'); el('drawerbg').classList.remove('show'); el('drawer').setAttribute('aria-hidden','true'); }
function toggleWatch(coin){ if(state.watch.has(coin)) state.watch.delete(coin); else state.watch.add(coin); savePrefs(); render(); }

// ===== persistence (localStorage; UI prefs only) =====
let prefsT=null;
function savePrefs(){ clearTimeout(prefsT); prefsT=setTimeout(()=>{ store.set(PKEY, JSON.stringify({
  colOrder:state.colOrder, colHidden:[...state.colHidden], tf:state.tf, refreshMs:state.pollMs,
  sortKey:state.sortKey, sortDir:state.sortDir, filterText:state.filter, watch:[...state.watch], watchOnly:!!state.watchOnly,
  filters:{vMin:el('volMin').value,vMax:el('volMax').value,oMin:el('oiMin').value,oMax:el('oiMax').value} })); }, 250); }
function loadPrefs(){ let p; try{ p=JSON.parse(store.get(PKEY)||'null'); }catch(_){ p=null; } if(!p) return;
  if(Array.isArray(p.colOrder)){ const v=p.colOrder.filter(k=>COL_BY_KEY[k]); for(const c of COLS) if(!v.includes(c.key)) v.push(c.key); state.colOrder=v; }
  if(Array.isArray(p.colHidden)) state.colHidden=new Set(p.colHidden.filter(k=>COL_BY_KEY[k]));
  if(p.tf&&TF_MAP[p.tf]) state.tf=p.tf;
  if(typeof p.refreshMs==='number'&&p.refreshMs>0){ state.refreshMs=p.refreshMs; state.pollMs=p.refreshMs; }
  if(p.sortKey&&COL_BY_KEY[p.sortKey]){ state.sortKey=p.sortKey; state.sortDir=p.sortDir==='asc'?'asc':'desc'; }
  if(typeof p.filterText==='string') state.filter=p.filterText;
  if(Array.isArray(p.watch)) state.watch=new Set(p.watch);
  state.watchOnly=!!p.watchOnly; state._savedFilters=p.filters||null; }

// ===== alerts (in-tab, edge-triggered) =====
const ALERT_METRICS=[
  {k:'px',label:'Price',unit:'$',get:r=>r.px},
  {k:'h1',label:'1h %',unit:'%',get:r=>r.h1},
  {k:'h4',label:'4h %',unit:'%',get:r=>r.h4},
  {k:'d1',label:'1d %',unit:'%',get:r=>r.d1},
  {k:'d7',label:'7d %',unit:'%',get:r=>r.d7},
  {k:'d30',label:'30d %',unit:'%',get:r=>r.d30},
  {k:'funding',label:'Funding APR %',unit:'%',get:r=>r.funding!=null?r.funding*24*365*100:null},
  {k:'mom',label:'Momentum',unit:'',get:r=>r.mom},
  {k:'doi',label:'ΔOI %',unit:'%',get:r=>r.doi},
  {k:'beta',label:'Beta',unit:'',get:r=>r.beta},
  {k:'vol',label:'24h Vol (M)',unit:'M',get:r=>r.vol,scale:1e6},
  {k:'oi',label:'OI (M)',unit:'M',get:r=>r.oi,scale:1e6},
];
const AM_BY={}; ALERT_METRICS.forEach(m=>AM_BY[m.k]=m);
const AKEY='xyzmon.alerts.v1';
const alertFired=new Set();
function tickerOf(coin){ const r=state.rows.get(coin); return r?r.ticker:coin; }
function evaluateAlerts(){ const A=state.alerts; if(!A.rules.length) return;
  for(const rule of A.rules){ const m=AM_BY[rule.metric]; if(!m) continue;
    const rows = rule.coin ? (state.rows.has(rule.coin)?[state.rows.get(rule.coin)]:[]) : activeRows();
    for(const r of rows){ if(r.delisted) continue; const key=rule.id+':'+r.coin;
      let v=m.get(r); if(v==null||!isFinite(v)){ alertFired.delete(key); continue; }
      const cmp = m.scale? rule.value*m.scale : rule.value;
      const hit = rule.op==='>' ? v>cmp : v<cmp;
      if(hit){ if(!alertFired.has(key)){ alertFired.add(key); fireAlert(rule,r,v,m); } }
      else alertFired.delete(key);
    } } }
function fireAlert(rule,r,v,m){ const A=state.alerts;
  const vs = m.unit==='%' ? (v>=0?'+':'')+v.toFixed(2)+'%' : m.unit==='$' ? fmtPrice(v) : m.unit==='M' ? fmtUsd(v) : (Math.round(v*100)/100);
  const text=`${r.ticker} · ${m.label} ${rule.op} ${rule.value} · now ${vs}`;
  A.log.unshift({t:Date.now(), text}); if(A.log.length>60) A.log.pop();
  A.unseen++; updateBell(); pushToast(text);
  if(A.notify && typeof Notification!=='undefined' && Notification.permission==='granted'){ try{ new Notification('Trade[XYZ] alert',{body:text}); }catch(_){} }
  if(!el('alertpop').hidden) buildAlertsPanel(); }
function pushToast(text){ const w=el('toastwrap'); const t=document.createElement('div'); t.className='toast'; t.textContent=text; w.appendChild(t);
  setTimeout(()=>{ t.style.transition='opacity .3s'; t.style.opacity='0'; setTimeout(()=>t.remove(),300); }, 6500); }
function updateBell(){ const b=el('bellBadge'), n=state.alerts.unseen; b.textContent=n>99?'99+':String(n); b.classList.toggle('show', n>0); }
function buildAlertsPanel(){ const pop=el('alertpop'), A=state.alerts;
  const metricOpts=ALERT_METRICS.map(m=>`<option value="${m.k}">${esc(m.label)}</option>`).join('');
  const rulesHtml=A.rules.length? A.rules.map(rl=>{ const m=AM_BY[rl.metric];
    return `<div class="arule"><span>${rl.coin?esc(tickerOf(rl.coin)):'<span class="sec">any</span>'} · ${esc(m?m.label:rl.metric)} ${rl.op} ${rl.value}</span><span class="ax" data-del="${rl.id}" title="delete">✕</span></div>`; }).join('')
    : '<div class="sec" style="font-size:12px;padding:4px">No rules yet.</div>';
  const logHtml=A.log.length? A.log.slice(0,12).map(e=>`<div class="alog"><span class="at">${new Date(e.t).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</span> ${esc(e.text)}</div>`).join('')
    : '<div class="sec" style="font-size:12px;padding:4px">Nothing triggered yet.</div>';
  const navail=(typeof Notification!=='undefined');
  pop.innerHTML=`<div class="cphead">New alert</div>
    <div class="arule-form">
      <input id="ar-ticker" class="full" placeholder="Ticker (blank = any market)" autocomplete="off" spellcheck="false"/>
      <select id="ar-metric">${metricOpts}</select>
      <select id="ar-op"><option value="&gt;">above &gt;</option><option value="&lt;">below &lt;</option></select>
      <input id="ar-val" class="full" placeholder="Threshold (e.g. 5 for 5%, 50 for 50M)" autocomplete="off" spellcheck="false"/>
      <button class="btn full" id="ar-add" style="justify-content:center">Add alert</button>
    </div>
    <div class="cphead">Rules (${A.rules.length})</div>${rulesHtml}
    <div class="cphead">Recent <span class="sec" style="text-transform:none;letter-spacing:0">· fires only while this tab is open</span></div>${logHtml}
    <label class="copt" style="margin-top:8px"><input type="checkbox" id="ar-notify" ${A.notify?'checked':''} ${navail?'':'disabled'}/> Browser notifications${navail?'':' (unavailable here)'}</label>
    <button class="btn" id="ar-clear" style="width:100%;justify-content:center;margin-top:6px">Clear log</button>`;
  el('ar-add').onclick=addAlertRule;
  el('ar-val').addEventListener('keydown',e=>{ if(e.key==='Enter') addAlertRule(); });
  pop.querySelectorAll('[data-del]').forEach(x=>x.addEventListener('click',()=>deleteAlertRule(+x.dataset.del)));
  el('ar-notify').addEventListener('change',e=>toggleNotify(e.target.checked));
  el('ar-clear').onclick=()=>{ A.log=[]; A.unseen=0; updateBell(); buildAlertsPanel(); }; }
function addAlertRule(){ const A=state.alerts, tIn=el('ar-ticker').value.trim().toUpperCase(); let coin='';
  if(tIn){ for(const r of state.rows.values()){ if(r.ticker.toUpperCase()===tIn||r.coin.toUpperCase()===tIn){ coin=r.coin; break; } }
    if(!coin){ el('ar-ticker').classList.add('bad'); return; } }
  el('ar-ticker').classList.remove('bad');
  const metric=el('ar-metric').value, op=el('ar-op').value, val=parseFloat(el('ar-val').value);
  if(!isFinite(val)){ el('ar-val').classList.add('bad'); return; } el('ar-val').classList.remove('bad');
  A.rules.push({id:Date.now()+Math.floor(Math.random()*1000), coin, metric, op, value:val});
  el('ar-ticker').value=''; el('ar-val').value='';
  saveAlerts(); buildAlertsPanel(); render(); }
function deleteAlertRule(id){ const A=state.alerts; A.rules=A.rules.filter(r=>r.id!==id);
  for(const k of [...alertFired]) if(k.startsWith(id+':')) alertFired.delete(k);
  saveAlerts(); buildAlertsPanel(); }
function toggleNotify(on){ const A=state.alerts;
  if(on && typeof Notification!=='undefined'){ if(Notification.permission==='granted'){ A.notify=true; }
    else { Notification.requestPermission().then(p=>{ A.notify=(p==='granted'); saveAlerts(); if(!el('alertpop').hidden) buildAlertsPanel(); }); return; } }
  else A.notify=false; saveAlerts(); }
function saveAlerts(){ store.set(AKEY, JSON.stringify({rules:state.alerts.rules, notify:state.alerts.notify})); }
function loadAlerts(){ let d; try{ d=JSON.parse(store.get(AKEY)||'null'); }catch(_){ d=null; } if(!d) return;
  if(Array.isArray(d.rules)) state.alerts.rules=d.rules.filter(r=>r&&AM_BY[r.metric]); state.alerts.notify=!!d.notify; }

function showView(v){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.view===v));
  el('view-markets').hidden = v!=='markets';
  el('view-corr').hidden = v!=='corr';
  if(v==='corr') openCorr();
}

// ===== polling cycle + countdown =====
let cycleTimer=null, nextCycle=0, dailyTimer=null;
function startCycle(){ clearInterval(cycleTimer); cycleTimer=setInterval(()=>{ loadSnapshot(); nextCycle=Date.now()+state.refreshMs; }, state.refreshMs); nextCycle=Date.now()+state.refreshMs; }
function setRefresh(ms){ state.refreshMs=ms; state.pollMs=ms; startCycle(); }
function forceRefresh(){ loadSnapshot(); nextCycle=Date.now()+state.refreshMs; }
setInterval(()=>{ const left=Math.max(0,nextCycle-Date.now()), m=Math.floor(left/60000), s=Math.floor((left%60000)/1000);
  el('cd').textContent=m+':'+String(s).padStart(2,'0'); },500);

// ===== init =====
loadPrefs();
loadAlerts();
buildHead();
updateBell();
el('filter').value=state.filter;
if(state._savedFilters){ const sf=state._savedFilters; el('volMin').value=sf.vMin||''; el('volMax').value=sf.vMax||''; el('oiMin').value=sf.oMin||''; el('oiMax').value=sf.oMax||''; }
el('watchOnly').classList.toggle('on', state.watchOnly);
el('refresh').addEventListener('click', forceRefresh);
el('filter').addEventListener('input', e=>{ state.filter=e.target.value; render(); savePrefs(); });
el('body').addEventListener('click', e=>{ const star=e.target.closest('.star');
  if(star){ e.stopPropagation(); toggleWatch(star.dataset.star); return; }
  const tr=e.target.closest('tr[data-coin]'); if(tr) openDetail(tr.dataset.coin); });
el('watchOnly').addEventListener('click',()=>{ state.watchOnly=!state.watchOnly; el('watchOnly').classList.toggle('on', state.watchOnly); render(); savePrefs(); });
el('drawerbg').addEventListener('click', closeDetail);
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && state.detail) closeDetail(); });
el('bellBtn').addEventListener('click',e=>{ e.stopPropagation(); const pop=el('alertpop');
  if(pop.hidden){ buildAlertsPanel(); pop.hidden=false; el('bellBtn').setAttribute('aria-expanded','true'); state.alerts.unseen=0; updateBell(); }
  else { pop.hidden=true; el('bellBtn').setAttribute('aria-expanded','false'); } });
document.addEventListener('click',e=>{ const pop=el('alertpop');
  if(pop && !pop.hidden && !pop.contains(e.target) && !el('bellBtn').contains(e.target)){ pop.hidden=true; el('bellBtn').setAttribute('aria-expanded','false'); } });
function applyNumFilters(){
  for(const id of ['volMin','volMax','oiMin','oiMax']){ const inp=el(id), v=parseAmount(inp.value);
    if(Number.isNaN(v)) inp.classList.add('bad'); else { inp.classList.remove('bad'); state.filters[id]=v; } }
  render(); savePrefs();
}
['volMin','volMax','oiMin','oiMax'].forEach(id=>el(id).addEventListener('input', applyNumFilters));
applyNumFilters();
el('clearFilters').addEventListener('click', ()=>{ ['volMin','volMax','oiMin','oiMax'].forEach(id=>{ el(id).value=''; el(id).classList.remove('bad'); });
  state.filters={volMin:null,volMax:null,oiMin:null,oiMax:null}; render(); savePrefs(); });
function buildColMenu(){ const pop=el('colpop'); let h='<div class="cphead">Show columns · drag headers to reorder</div>';
  for(const key of state.colOrder){ const c=COL_BY_KEY[key]; if(!c) continue;
    const dis=c.hideable===false, checked=!state.colHidden.has(key);
    h+=`<label class="copt${dis?' dis':''}"><input type="checkbox" data-col="${key}" ${checked?'checked':''} ${dis?'disabled':''}/> ${esc(c.label)}</label>`; }
  h+='<button class="btn" id="colReset" style="margin-top:8px;width:100%;justify-content:center">Reset layout</button>';
  pop.innerHTML=h;
  pop.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.addEventListener('change',()=>{
    const k=cb.dataset.col; if(cb.checked) state.colHidden.delete(k); else state.colHidden.add(k); buildHead(); render(); savePrefs(); }));
  el('colReset').addEventListener('click',()=>{ state.colOrder=COLS.map(c=>c.key); state.colHidden=new Set(); buildColMenu(); buildHead(); render(); savePrefs(); });
}
el('colsBtn').addEventListener('click',e=>{ e.stopPropagation(); const pop=el('colpop');
  if(pop.hidden){ buildColMenu(); pop.hidden=false; el('colsBtn').setAttribute('aria-expanded','true'); }
  else { pop.hidden=true; el('colsBtn').setAttribute('aria-expanded','false'); } });
document.addEventListener('click',e=>{ const pop=el('colpop');
  if(pop && !pop.hidden && !pop.contains(e.target) && !el('colsBtn').contains(e.target)){ pop.hidden=true; el('colsBtn').setAttribute('aria-expanded','false'); } });
document.querySelectorAll('#tfseg button').forEach(b=>{ if(b.dataset.tf===state.tf)b.classList.add('active');
  b.addEventListener('click',()=>{ state.tf=b.dataset.tf;
    document.querySelectorAll('#tfseg button').forEach(x=>x.classList.toggle('active',x===b)); buildHead(); render(); savePrefs(); }); });
document.querySelectorAll('#rfseg button').forEach(b=>{ if(+b.dataset.ms===state.refreshMs)b.classList.add('active');
  b.addEventListener('click',()=>{ document.querySelectorAll('#rfseg button').forEach(x=>x.classList.toggle('active',x===b));
    setRefresh(+b.dataset.ms); savePrefs(); }); });
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>showView(t.dataset.view)));
document.querySelectorAll('#corrtf button').forEach(b=>{ if(b.dataset.d===state.corr.tf)b.classList.add('active');
  b.addEventListener('click',()=>{ state.corr.tf=b.dataset.d; document.querySelectorAll('#corrtf button').forEach(x=>x.classList.toggle('active',x===b));
    if(!el('view-corr').hidden) renderCorr(); }); });
document.querySelectorAll('#corrn button').forEach(b=>{ if(+b.dataset.n===state.corr.topN)b.classList.add('active');
  b.addEventListener('click',()=>{ state.corr.topN=+b.dataset.n; state.corr.selected=null; state.corr.pair=null; document.querySelectorAll('#corrn button').forEach(x=>x.classList.toggle('active',x===b));
    if(!el('view-corr').hidden) openCorr(); }); });
document.querySelectorAll('#corrtop button').forEach(b=>{ if(+b.dataset.k===state.corr.topPairs)b.classList.add('active');
  b.addEventListener('click',()=>{ state.corr.topPairs=+b.dataset.k; document.querySelectorAll('#corrtop button').forEach(x=>x.classList.toggle('active',x===b)); renderCorrPairs(); }); });
let corrSearchT=null;
el('corrsearch').addEventListener('input',e=>{ state.corr.search=e.target.value; state.corr.selected=null; state.corr.pair=null;
  clearTimeout(corrSearchT); corrSearchT=setTimeout(()=>{ if(!el('view-corr').hidden) openCorr(); },300); });
el('mktExport').addEventListener('click', exportMarkets);
el('corrExport').addEventListener('click', exportCorr);

(async ()=>{
  await Promise.all([loadSnapshot(), loadDaily()]);
  startCycle();
  dailyTimer=setInterval(loadDaily, 15*60*1000);
})();
