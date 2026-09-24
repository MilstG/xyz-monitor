// corr.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { IS_ADMIN, featureOn } from "./admin.js";
import { pushToast } from "./alerts.js";
import { drawBacktest } from "./backtest.js";
import { DAY, SCROLL_B, TF_MAP, activeRows, clamp, closedDaily, el, esc, lerp, mktGrp, sessCalOf, sessDaily, sessOffFor, sessionFold, state, stdev } from "./core.js";
import { fetchJSON } from "./data.js";
import { buildHead, groupRowsSorted, pctInner, render, shade, sortedRows, visibleCols } from "./markets.js";
import { openAiReport } from "./report.js";
import { usageAct, usageCtl } from "./usage.js";


// ===== correlation tab =====
const CORR={ _rows:null, _C:null, _N:null, _NS:null, _ord:null, _intraday:false, _bars:null, _times:null, _win:null, _minOv:0, _readout:'Hover a cell to read a pair · click a ticker for its co-movers &amp; hedges' };
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
// Session-day log returns (build 2026.09.24-105): the row's daily bars in their SESSION view
// (core.js sessionFold — a US name's weekend/holiday folded into the next session; crypto calendar
// days), the forming bar dropped (t + DAY > now — the server's meanPairwiseCorr / dailyBeta rule:
// a partial day's return is not a return), keyed by the UTC day of the later bar. `cal` overrides the
// row's own calendar: a crypto row paired with sessions is folded onto the US calendar so both
// returns span the same interval (Fri close -> Mon close), then the pair aligns on those days.
// Memoized per row on (daily identity, calendar version, UTC day, cal). The correlation matrix, the
// board's β, co-movers and the pair view read this; the backtest keeps its calendar dailyReturns.
function sessReturns(r, cal){ const src=r&&r.daily; if(!src||src.length<2) return null;
  const today=Math.floor(Date.now()/DAY), ck=cal===undefined?'':String(cal), m0=r._sret;
  if(m0&&m0.src===src&&m0.v===state.sessOffV&&m0.day===today&&m0.cal===ck) return m0.m;
  const bars=closedDaily(sessBarsFor(r, cal));
  const m=new Map(); let prev=null;
  for(const k of bars){ const cl=parseFloat(k.c), day=Math.floor(k.t/DAY); if(isFinite(cl)){ if(prev!=null&&prev>0) m.set(day, Math.log(cl/prev)); prev=cl; } }
  r._sret={src, v:state.sessOffV, day:today, cal:ck, m}; return m; }
// The row's bars on calendar `cal` (undefined = its own: the memoized sessDaily view).
function sessBarsFor(r, cal){ if(cal===undefined) return sessDaily(r); const off=sessOffFor(r, cal); return off?sessionFold(r.daily, off):r.daily; }
// A matrix mixing session rows with calendar (crypto) rows folds the crypto rows onto the US calendar.
function corrCalFor(r, mixed){ return mixed&&!sessCalOf(r)?'US':undefined; }
function dailyFunding(r){ if(r._dfund!==undefined && r._dfund!==null) return r._dfund; const c=r.dailyFund; if(!c||!c.length){ r._dfund=null; return null; }
  const m=new Map(); for(const k of c){ const f=parseFloat(k.f); if(isFinite(f)) m.set(Math.floor(k.t/DAY), f); } r._dfund=m; return m; }
function overnightReturns(r){ if(r._dov!==undefined && r._dov!==null) return r._dov; const c=r.overnight; if(!c||!c.length){ r._dov=null; return null; }
  const g=new Map(), f=new Map(); for(const k of c){ const gr=parseFloat(k.g), fn=parseFloat(k.f); const d=Math.floor(k.t/DAY); if(isFinite(gr)){ g.set(d,gr); f.set(d, isFinite(fn)?fn:0); } } r._dov={g,f}; return r._dov; }
function dailyLevels(r){ if(r._dlvl) return r._dlvl; const c=r.daily; if(!c||!c.length){ r._dlvl=null; return null; }   // day -> {c, h, v} price/high/volume levels (h/v null on an older server payload)
  const m=new Map(); for(const k of c){ const cl=parseFloat(k.c); if(!isFinite(cl)) continue;
    const h=parseFloat(k.h), v=parseFloat(k.v); m.set(Math.floor(k.t/DAY), { c:cl, h:isFinite(h)&&h>0?h:null, v:isFinite(v)&&v>0?v:null }); }
  r._dlvl=m; return m; }
function dailyOI(r){ if(r._doi!==undefined && r._doi!==null) return r._doi; const c=r.dailyOI; if(!c||!c.length){ r._doi=null; return null; }   // day -> daily-step open interest from the sampled history
  const m=new Map(); for(const k of c){ const x=parseFloat(k[1]); if(isFinite(x)&&x>0) m.set(Math.floor(k[0]/DAY), x); } r._doi=m; return m; }
function pearson(a,b){ const n=a.length; if(n<3) return null; let sa=0,sb=0; for(let i=0;i<n;i++){sa+=a[i];sb+=b[i];}
  const ma=sa/n, mb=sb/n; let cov=0,va=0,vb=0; for(let i=0;i<n;i++){ const da=a[i]-ma, db=b[i]-mb; cov+=da*db; va+=da*da; vb+=db*db; }
  if(va<=0||vb<=0) return null; return cov/Math.sqrt(va*vb); }
// ===== correlation engine: memoized, dense typed arrays (build 2026.09.24-103) =================
// buildCorr used to be O(N²·days) of Map lookups with two fresh JS arrays per pair, re-run from
// scratch on every renderCorr, every applyDaily and every renderSectors (which needs the full N×N
// for its sector×sector panel, not just intra-sector pairs), and clusterOrder was O(N³) over
// string-keyed Maps. Now:
//  - the returns are aligned ONCE per build into a dense N×W Float64Array (W = the window's days,
//    NaN where a name has no return that day), and Pearson runs over that matrix with exactly the
//    old pearson()'s arithmetic in exactly the old order (ascending day, same two-pass sums), so the
//    numbers are identical, not just close (test: client-perf corr equivalence, 1e-12);
//  - the result is memoized on (lookback, UTC day, the row list, and each row's daily-array
//    IDENTITY). applyDaily replaces r.daily arrays only when a new daily version lands (and now
//    skips unchanged bodies outright), basket virtual rows are rev-cached — so identity is the
//    honest "these closes changed" signal and no version counter can drift from it;
//  - clusterOrder is the same average-linkage merge over a numeric-indexed Float64Array distance
//    table, memoized per C.
// Consumers read C[i][j] / N[i][j] as before — the result shape did not change.
let _corrSerSeq=0;
const _corrSerIds=new WeakMap(), _corrMemo=new Map(), CORR_MEMO_MAX=6;
function corrSerId(arr){ if(!arr||typeof arr!=='object') return 0; let id=_corrSerIds.get(arr); if(!id){ id=++_corrSerSeq; _corrSerIds.set(arr,id); } return id; }
function buildCorr(rows, Ldays){
  // Overlap floor scales with the window: a 7d lookback only has ~5 trading days of returns, so a
  // flat 15-day minimum greyed the entire 7d matrix (every cell fell under the floor). Require
  // roughly half the window's expected return-days, hard-floored at 4 so a correlation still rests
  // on enough points to mean something. (Was max(15, Ldays*0.5) — the 15 was the bug.)
  const today=Math.floor(Date.now()/DAY), cutoff=today-Ldays;
  let key=Ldays+'|'+today+'|'+state.sessOffV; for(const r of rows) key+='|'+r.coin+':'+corrSerId(r.daily);
  const hit=_corrMemo.get(key);
  if(hit){ _corrMemo.delete(key); _corrMemo.set(key,hit); return hit; }   // LRU touch
  const res=buildCorrDense(rows, Ldays, cutoff);
  _corrMemo.set(key,res); if(_corrMemo.size>CORR_MEMO_MAX) _corrMemo.delete(_corrMemo.keys().next().value);
  return res;
}
// (build 2026.09.24-105) Session returns (sessReturns: weekends/holidays folded, forming bar
// dropped), and a HARD overlap floor of CORR_MIN_OV returns: a correlation on fewer points is
// noise wearing two decimals, so the cell stays empty and reads "n<10" (the old floor of 4 was a
// fix for calendar-day 7d windows; in sessions a 7d window holds ~5 returns and honestly greys).
const CORR_MIN_OV=10;
function buildCorrDense(rows, Ldays, cutoff){
  const minOv=Math.max(CORR_MIN_OV, Math.floor(Math.min(Ldays,90)*0.4));
  const N=rows.length, C=Array.from({length:N},()=>new Array(N).fill(null)), OV=Array.from({length:N},()=>new Array(N).fill(0));
  // Align: one pass per row over its (memoized) day->log-return map, days >= cutoff only.
  let dmax=cutoff; const maps=new Array(N);
  let anyS=false, anyC=false; for(const r of rows){ if(sessCalOf(r)) anyS=true; else anyC=true; }
  const mixed=anyS&&anyC;
  for(let i=0;i<N;i++){ const m=sessReturns(rows[i], corrCalFor(rows[i], mixed)); maps[i]=m; if(m) for(const d of m.keys()) if(d>dmax) dmax=d; }
  // X holds the values, P marks presence (a separate mask, not a NaN sentinel: a non-finite return
  // is data to the old path — it poisoned the pair's r — so it must stay data here too).
  const W=dmax-cutoff+1, X=new Float64Array(N*W), P=new Uint8Array(N*W), has=new Uint8Array(N);
  for(let i=0;i<N;i++){ const m=maps[i]; if(!m) continue; has[i]=1; const o=i*W;
    for(const [d,v] of m) if(d>=cutoff){ X[o+d-cutoff]=v; P[o+d-cutoff]=1; } }
  for(let i=0;i<N;i++){ C[i][i]=1; if(!has[i]) continue; const oi=i*W;
    for(let j=i+1;j<N;j++){ if(!has[j]) continue; const oj=j*W;
      // pass 1: overlap count + sums (the old a/b push loop + pearson's first loop, same order)
      let n=0, sa=0, sb=0;
      for(let k=0;k<W;k++){ if(P[oi+k]&P[oj+k]){ n++; sa+=X[oi+k]; sb+=X[oj+k]; } }
      let c=null;
      if(n>=minOv&&n>=3){ const ma=sa/n, mb=sb/n; let cov=0,va=0,vb=0;
        for(let k=0;k<W;k++){ if(P[oi+k]&P[oj+k]){ const da=X[oi+k]-ma, db=X[oj+k]-mb; cov+=da*db; va+=da*da; vb+=db*db; } }
        c=(va<=0||vb<=0)?null:cov/Math.sqrt(va*vb); }
      C[i][j]=c; C[j][i]=c; OV[i][j]=n; OV[j][i]=n; } }
  return Object.assign({C, N:OV, minOv}, corrSig(C, OV));
}
// Significance + the clustering matrix (build 2026.09.24-105), from the raw C and its overlaps:
//  NS[i][j] = 1 when the Fisher-z 95% CI of r contains 0 — |atanh r|·√(n−3) < 1.96 — the cell is
//    painted faded: a real number, but not distinguishable from no correlation at this n.
//  Cs = C shrunk toward the average off-diagonal correlation r̄ with a Ledoit-Wolf-style intensity
//    δ = Σ var(r_ij) / (Σ var(r_ij) + Σ (r_ij − r̄)²), var(r) ≈ (1 − r²)² / (n − 1), clamped [0, 1]:
//    thin, noisy pairs pull toward the tape instead of dragging a name into a spurious cluster.
//    Cs ONLY orders the heatmap (corrOrder); every displayed value, hover and pair list is raw C.
function corrSig(C, OV){ const N=C.length, NS=Array.from({length:N},()=>new Array(N).fill(0));
  let sr=0, nr=0;
  for(let i=0;i<N;i++) for(let j=i+1;j<N;j++){ const c=C[i][j], n=OV[i][j]; if(c==null||!isFinite(c)) continue;
    sr+=c; nr++;
    const z=Math.atanh(Math.max(-0.999999,Math.min(0.999999,c)));
    if(!(n>3)||Math.abs(z)*Math.sqrt(n-3)<1.959964){ NS[i][j]=1; NS[j][i]=1; } }
  if(!nr) return {NS, Cs:C, delta:0};
  const rb=sr/nr; let sv=0, sd=0;
  for(let i=0;i<N;i++) for(let j=i+1;j<N;j++){ const c=C[i][j], n=OV[i][j]; if(c==null||!isFinite(c)) continue;
    sv+=(1-c*c)*(1-c*c)/Math.max(1,n-1); sd+=(c-rb)*(c-rb); }
  const delta=sv+sd>0?Math.min(1,Math.max(0,sv/(sv+sd))):0;
  const Cs=C.map((row,i)=>row.map((c,j)=>i===j?1:(c==null||!isFinite(c)?c:(1-delta)*c+delta*rb)));
  return {NS, Cs, delta}; }
// Fisher-z 95% CI of r at n pairs: [lo, hi], null under 4 pairs.
function corrCI(r, n){ if(r==null||!isFinite(r)||!(n>3)) return null; const z=Math.atanh(Math.max(-0.999999,Math.min(0.999999,r))), h=1.959964/Math.sqrt(n-3);
  return [Math.tanh(z-h), Math.tanh(z+h)]; }
// Average-linkage agglomerative order over a distance matrix D (n×n). Same merge rule, same scan
// order and the same strict-< tie-break as the string-keyed version it replaces — only the storage
// changed: cluster ids (0..2n-2) index a Float64Array instead of "a,b" Map keys.
const _clusterMemo=new WeakMap();
function clusterOrder(D){ const n=D.length; if(n<=2) return D.map((_,i)=>i);
  const cap=2*n-1, dm=new Float64Array(cap*cap);
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){ const v=D[i][j]; dm[i*cap+j]=v; dm[j*cap+i]=v; }
  let clusters=[]; for(let i=0;i<n;i++) clusters.push({id:i,size:1,order:[i]}); let nid=n;
  while(clusters.length>1){ let bi=0,bj=1,bd=Infinity;
    for(let i=0;i<clusters.length;i++){ const ro=clusters[i].id*cap;
      for(let j=i+1;j<clusters.length;j++){ const d=dm[ro+clusters[j].id]; if(d<bd){bd=d;bi=i;bj=j;} } }
    const A=clusters[bi], B=clusters[bj], id=nid++;
    for(const C of clusters){ if(C===A||C===B) continue; const dA=dm[A.id*cap+C.id], dB=dm[B.id*cap+C.id];
      const v=(A.size*dA+B.size*dB)/(A.size+B.size); dm[id*cap+C.id]=v; dm[C.id*cap+id]=v; }
    clusters=clusters.filter(c=>c!==A&&c!==B); clusters.push({id, size:A.size+B.size, order:A.order.concat(B.order)}); }
  return clusters[0].order; }
// paintCorr's entry: the distance transform + clustering, memoized on the (memoized) C object.
// `Cs` (optional, build -105): the shrunk matrix to cluster on; the memo stays keyed on C (Cs is a
// pure function of C and its overlaps, built alongside it).
function corrOrder(C, Cs){ let o=_clusterMemo.get(C); if(o) return o;
  o=clusterOrder((Cs||C).map(row=>row.map(v=>v==null?1:1-v))); _clusterMemo.set(C,o); return o; }
function corrColor(c){ if(c==null||!isFinite(c)) return 'var(--panel2)';
  const t=clamp(Math.abs(c),0,1), mid=[20,26,33], tg=c>=0?[70,185,126]:[229,96,77];
  return `rgb(${lerp(mid[0],tg[0],t)},${lerp(mid[1],tg[1],t)},${lerp(mid[2],tg[2],t)})`; }
function windowRetPct(r, Ldays){ if(!r) return null; if(r._wrL===Ldays) return r._wrV;
  const c=r.daily; let val=null;
  if(c&&c.length>=2){ const cutoff=Date.now()-Ldays*DAY; let first=null,last=null;
    for(const k of c){ const cl=parseFloat(k.c); if(!isFinite(cl))continue; if(k.t>=cutoff&&first==null)first=cl; last=cl; }
    if(first!=null&&last!=null&&first>0) val=(last-first)/first*100; }
  r._wrL=Ldays; r._wrV=val; return val; }
function tfLabel(){ if(state.scope==='crypto') return state.corr.ctf||'1d'; return state.corr.tf==='365'?'1y':state.corr.tf+'d'; }
// Window return for a correlation-tab row. Crypto reads the intraday close series the matrix was
// built from (first→last non-null on the shared grid); equities use the daily-close window return.
// One accessor so co-movers, strongest-pairs, the hover and the pair view all agree per universe.
function corrRet(row){ if(!row) return null;
  if(CORR._intraday && CORR._bars){ const s=CORR._bars.get(row.ticker); if(!s) return null;
    let first=null,last=null; for(const c of s){ if(c!=null){ if(first==null)first=c; last=c; } }
    return (first!=null&&last!=null&&first>0)?(last-first)/first*100:null; }
  return windowRetPct(row, +state.corr.tf); }
function corrOvUnit(){ return CORR._intraday?' bars':'d'; }
function sret(x){ return x==null?'<span class="na">·</span>':`<span class="${x>=0?'pos':'neg'}">${x>=0?'+':''}${x.toFixed(1)}%</span>`; }
function spp(d){ return d==null?'<span class="na">·</span>':`<span class="${d>=0?'pos':'neg'}">${d>=0?'+':''}${d.toFixed(0)}pp</span>`; }
function corrTipHtml(ri,ci){ const rows=CORR._rows; if(!rows||!CORR._C) return '';
  const a=rows[ri], b=rows[ci], ra=corrRet(a);
  if(ri===ci) return `<div class="hd"><span class="tk">${esc(a.ticker)}</span></div><div class="mut">${tfLabel()} return ${ra==null?'n/a':(ra>=0?'+':'')+ra.toFixed(1)+'%'}</div>`;
  const v=CORR._C[ri][ci], n=CORR._N[ri][ci]||0, rb=corrRet(b);
  let s=`<div class="hd"><span class="tk">${esc(a.ticker)}</span> <span class="mut">×</span> <span class="tk">${esc(b.ticker)}</span></div>`;
  s+=`<div>r = ${v==null?'<span class="na">n/a</span>':`<span class="${v>=0?'pos':'neg'}">${v>=0?'+':''}${v.toFixed(2)}</span>`} <span class="mut">· ${n}${corrOvUnit()} overlap</span></div>`;
  // (-105) the daily matrix: the 95% CI (Fisher z) and why a cell is empty or faded
  if(!CORR._intraday){ const ci=v!=null?corrCI(v,n):null;
    if(ci) s+=`<div class="mut">95% CI ${ci[0]>=0?'+':''}${ci[0].toFixed(2)} … ${ci[1]>=0?'+':''}${ci[1].toFixed(2)}${ci[0]<=0&&ci[1]>=0?' · spans 0: not significant at this n (faded)':''}</div>`;
    else if(v==null&&n>0&&CORR._minOv&&n<CORR._minOv) s+=`<div class="mut">n&lt;${CORR._minOv}: too few overlapping session returns to report a correlation</div>`; }
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

function syncCorrLookback(){ const seg=el('corrtf'); if(!seg) return;
  const cr=state.scope==='crypto';
  const opts = cr ? [['4h','4h'],['1d','1d'],['7d','7d']] : [['7','7d'],['30','30d'],['90','90d']];
  let cur = cr ? (state.corr.ctf||'1d') : state.corr.tf;
  if(!cr && !['7','30','90'].includes(cur)) cur=state.corr.tf='30';
  const ttl = cr ? 'intraday corr on the 5m archive' : 'session-day return correlation: US sessions (weekends and holidays fold into the next session), the still-open day dropped · a cell under 10 overlapping returns reads n<10 · faded = its 95% CI spans 0 · the order clusters a matrix shrunk toward the average correlation, the values shown are raw';
  seg.innerHTML='<span class="seglbl" title="'+ttl+'">lookback</span>'
    + opts.map(([d,l])=>`<button type="button" data-d="${d}"${d===cur?' class="active"':''}>${l}</button>`).join('');
  seg.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    if(state.scope==='crypto') state.corr.ctf=b.dataset.d; else state.corr.tf=b.dataset.d;
    seg.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));
    const v=el('view-corr'); if(typeof renderCorr==='function' && v && !v.hidden) renderCorr(); }));
}
function openCorr(){
  syncCorrLookback();
  loadBaskets(); renderBasketPanel(); renderRatio(); syncCorrBk();   // baskets ride the Corr tab — gated inside each
  if(!state.rows.size){ el('corrwrap').innerHTML='<div class="msg">Markets still loading — switch back in a moment.</div>'; return; }
  if(state.scope==='crypto'){ renderCorr(); return; }
  const rows=corrScope(), have=rows.filter(r=>r.daily).length;
  setCorrSync(have>=rows.length?'ready':`loading ${have}/${rows.length}`, have>=rows.length);
  renderCorr();
}
function readoutHtml(rt,ct,v,n){
  if(v==null||v==='na'||v==='') return `<b>${esc(rt)}</b> × <b>${esc(ct)}</b> · <span class="na">not enough overlapping history</span>`;
  const f=parseFloat(v), cls=f>0?'pos':(f<0?'neg':'sec');
  return `<b>${esc(rt)}</b> × <b>${esc(ct)}</b> · <span class="${cls}">${f>=0?'+':''}${f.toFixed(2)}</span> · ${n}${corrOvUnit()} overlap`;
}
function renderCorr(){
  if(state.scope==='crypto') return renderCorrCrypto();
  const rows=corrScope().concat(corrBasketRows());   // -09: baskets ride the same daily-return pearson path as every ticker
  if(rows.length<2){ el('corrwrap').innerHTML='<div class="msg"><span class="big">Not enough markets</span>Widen the focus search or pick a larger set.</div>'; el('corrpairs').innerHTML=''; el('corrpanel').hidden=true; return; }
  const L=+state.corr.tf, res=buildCorr(rows,L);
  paintCorr(rows, res.C, res.N, { ns:res.NS, shr:res.Cs, minOv:res.minOv });
}
// Crypto scope: the matrix is built server-side over the 5m archive (equities keep ~31d of daily,
// crypto keeps 370d of 5m), so we fetch the window's matrix + per-name close series and paint the
// SAME table. The series ride along so the pair view reproduces the exact numbers — one payload,
// one source of truth. Honest degradation: archive off → a clear message, never fabricated cells.
async function renderCorrCrypto(){
  const win=state.corr.ctf||'1d';
  setCorrSync('building '+win+'…', false);
  if(!CORR._intraday||CORR._win!==win) el('corrwrap').innerHTML='<div class="msg">Building '+esc(win)+' intraday correlation…</div>';
  let d; try{ d=await fetchJSON('/api/corr-crypto?w='+encodeURIComponent(win)); }
  catch(e){ el('corrwrap').innerHTML='<div class="msg">Couldn\'t load crypto correlation — '+esc(e.message||'network error')+'</div>'; setCorrSync('error', false); return; }
  if(state.scope!=='crypto'||state.view!=='corr') return;   // scope/view flipped mid-fetch
  if(!d||!d.enabled){ el('corrwrap').innerHTML='<div class="msg"><span class="big">Intraday archive unavailable</span>'+esc((d&&d.reason)||'the 5-minute archive is disabled on the server')+'</div>';
    el('corrpairs').innerHTML=''; el('corrpanel').hidden=true; el('pairpanel').hidden=true; setCorrSync('no archive', false); return; }
  const topN=state.corr.topN||40, coins=d.coins.slice(0, topN), K=coins.length;
  if(K<2){ el('corrwrap').innerHTML='<div class="msg">Not enough crypto markets with intraday coverage yet.</div>'; el('corrpairs').innerHTML=''; return; }
  const rows=coins.map(c=>({ticker:c.tk, coin:c.coin, uni:'main', _cov:c.cov}));
  const C=Array.from({length:K},(_,i)=>coins.map((_,j)=>d.C[i][j]));   // front-sliced ⇒ index-aligned submatrix
  const OV=Array.from({length:K},(_,i)=>coins.map((_,j)=>d.N[i][j]));
  const bars=new Map(); coins.forEach(c=>bars.set(c.tk, c.closes));
  paintCorr(rows, C, OV, { intraday:true, bars, times:d.times, win, minOv:d.minOv, gridLen:d.gridLen });
  setCorrSync('ready · '+win, true);
}
// A matrix cell's coordinates from any node inside it: display row/col (dr/dc) and the matrix
// indices they stand for (ri/ci via CORR._ord). Null for headers and anything outside a body cell.
function corrCellAt(t){ const td=t&&t.closest?t.closest('td'):null; if(!td) return null;
  const tr=td.parentNode, ord=CORR._ord; if(!tr||!ord||tr.dataset.dr==null) return null;
  const dr=+tr.dataset.dr, dc=td.cellIndex-1; if(!(dc>=0&&dc<ord.length&&dr>=0&&dr<ord.length)) return null;
  return {dr, dc, ri:ord[dr], ci:ord[dc]}; }
// The readout line for a cell, read straight from the cached matrix (it used to parse the value back
// out of data-v / data-n strings the painter had just written into every cell).
function corrReadoutAt(ri,ci){ const rows=CORR._rows, v=CORR._C[ri][ci];
  return readoutHtml(rows[ri].ticker, rows[ci].ticker, v==null?'na':String(v), CORR._N[ri][ci]||0); }
function paintCorr(rows, C, OV, opts){
  opts=opts||{};
  const ord=corrOrder(C, opts.shr), NS=opts.ns||null, minOv=opts.minOv||0;
  const cell=rows.length<=20?30:rows.length<=40?20:15, showVal=rows.length<=20;
  let h=`<table class="cmx" style="--cell:${cell}px"><thead><tr><th class="corner"></th>`;
  ord.forEach(i=>{ const r0=rows[i];
    h+=`<th class="cl${r0._basket?' bk':''}" data-i="${i}" ${r0._basket?`data-tip="${esc(basketTip(r0._basket))}"`:`title="${esc(r0.ticker)}"`}><span>${r0._basket?'<span class="bkg">⬒</span>':''}${esc(r0.ticker)}</span></th>`; });
  h+='</tr></thead><tbody>';
  // Cells carry NO per-cell data attributes (build 2026.09.24-103): at 140 names that was ~20k
  // cells × 8 attributes of markup to build, parse and hold. A cell's identity is its position —
  // row dr (the <tr>'s data-dr) and column dc (cellIndex-1, the row header being cell 0) — and
  // ord[] maps those display positions back to matrix indices; value and overlap are read from the
  // cached C / OV (CORR._C / CORR._N) on demand.
  ord.forEach((ri,dr)=>{ const rr=rows[ri];
    h+=`<tr data-dr="${dr}"><th class="rl${rr._basket?' bk':''}" data-i="${ri}" ${rr._basket?`data-tip="${esc(basketTip(rr._basket))}"`:`title="${esc(rr.coin)}"`}>${rr._basket?'<span class="bkg">⬒</span>':''}${esc(rr.ticker)}</th>`;
    ord.forEach((ci)=>{ const v=C[ri][ci], self=ri===ci;
      // (-105) under the overlap floor: empty with "n<10"; CI spans 0: faded (the value still shows)
      const low=!self&&v==null&&minOv>0&&(OV[ri][ci]||0)>0&&OV[ri][ci]<minOv, ns=!self&&v!=null&&NS&&NS[ri][ci];
      const cls=self?'diag':(v==null?(low?'nodata lown':'nodata'):(ns?'ns':''));
      const txt=(showVal&&v!=null&&!self)?`${v<0?'−':''}${Math.abs(v).toFixed(1).replace(/^0/,'')}`:(showVal&&low?`n&lt;${minOv}`:'');
      h+=`<td${cls?` class="${cls}"`:''}${self||v==null?'':` style="background:${corrColor(v)}"`}>${txt}</td>`; });
    h+='</tr>'; });
  h+='</tbody></table>';
  el('corrwrap').innerHTML=h;
  CORR._rows=rows; CORR._C=C; CORR._N=OV; CORR._ord=ord;
  CORR._intraday=!!opts.intraday; CORR._bars=opts.bars||null; CORR._times=opts.times||null; CORR._win=opts.win||null; CORR._minOv=opts.minOv||0; CORR._NS=NS;
  const tbl=el('corrwrap').querySelector('table.cmx');
  const cols=[...tbl.querySelectorAll('thead th.cl')], rls=[...tbl.querySelectorAll('tbody th.rl')];
  // Hover state: the cell under the pointer as display coords. Header highlight, the readout and
  // the tooltip body are rebuilt only when THAT changes; a mousemove inside the same cell only
  // repositions the tooltip. (Each used to run per event: two N-long classList sweeps per
  // mouseover, a full tooltip innerHTML per mousemove.)
  const hov={dr:-1, dc:-1, hc:-1, hr:-1};
  const setHl=(dc,dr)=>{ if(hov.hc>=0&&cols[hov.hc]) cols[hov.hc].classList.remove('hl'); if(hov.hr>=0&&rls[hov.hr]) rls[hov.hr].classList.remove('hl');
    hov.hc=dc; hov.hr=dr; if(dc>=0&&cols[dc]) cols[dc].classList.add('hl'); if(dr>=0&&rls[dr]) rls[dr].classList.add('hl'); };
  tbl.addEventListener('mouseover', e=>{ const p=corrCellAt(e.target); if(!p) return;
    if(p.dr===hov.dr&&p.dc===hov.dc) return;
    hov.dr=p.dr; hov.dc=p.dc; hov.tip=false; setHl(p.dc,p.dr);
    el('corr-readout').innerHTML=corrReadoutAt(p.ri,p.ci); });
  tbl.addEventListener('mousemove', e=>{ const p=corrCellAt(e.target); const tip=el('corrtip');
    if(!p){ tip.hidden=true; hov.tip=false; return; }
    if(!hov.tip||p.dr!==hov.tdr||p.dc!==hov.tdc){ hov.tdr=p.dr; hov.tdc=p.dc; hov.tip=true; tip.innerHTML=corrTipHtml(p.ri, p.ci); }
    tip.hidden=false; positionTip(tip,e); });
  tbl.addEventListener('mouseleave', ()=>{ setHl(-1,-1); hov.dr=hov.dc=-1; hov.tip=false; el('corr-readout').innerHTML=CORR._readout; el('corrtip').hidden=true; });
  tbl.querySelectorAll('.cl,.rl').forEach(n=>n.addEventListener('click',()=>{ state.corr.selected=+n.dataset.i; state.corr.pair=null; renderPairPanel(); renderCorrPanel(); }));
  tbl.addEventListener('click', e=>{ const p=corrCellAt(e.target); if(!p) return;
    const ri=p.ri, ci=p.ci; if(ri!==ci && CORR._C[ri][ci]!=null) openPair(ri,ci); });
  renderCorrPanel(); renderPairPanel(); renderCorrPairs();
}
function renderCorrPanel(){
  const p=el('corrpanel'), rows=CORR._rows, C=CORR._C, sel=state.corr.selected;
  if(sel==null||!rows||!C||sel>=rows.length){ p.hidden=true; return; }
  const me=rows[sel], pairs=[];
  for(let j=0;j<rows.length;j++){ if(j===sel) continue; const v=C[sel][j]; if(v!=null&&isFinite(v)) pairs.push([rows[j].ticker,v,j]); }
  pairs.sort((a,b)=>b[1]-a[1]);
  const pos=pairs.slice(0,8), neg=pairs.slice(-8).reverse().filter(x=>x[1]<0);
  const rMe=corrRet(me);
  const bar=v=>`<span class="cbar" style="width:${Math.round(Math.abs(v)*64)}px;background:${corrColor(v)}"></span>`;
  const li=(t,v,j)=>{ const rb=corrRet(rows[j]), d=(rMe!=null&&rb!=null)?rMe-rb:null;
    const tip=(rMe!=null&&rb!=null)?`${esc(me.ticker)} ${rMe>=0?'+':''}${rMe.toFixed(1)}% vs ${esc(t)} ${rb>=0?'+':''}${rb.toFixed(1)}% over ${tfLabel()}`:'not enough history';
    return `<div class="crow"><span class="ct">${esc(t)}</span>${bar(v)}<span class="cv ${v>=0?'pos':'neg'}">${v>=0?'+':''}${v.toFixed(2)}</span><span class="cv2" title="${esc(tip)}">${spp(d)}</span></div>`; };
  const tfl=tfLabel();
  p.hidden=false;
  p.innerHTML=`<div class="cp-head">${esc(me.ticker)} <span class="sec" style="font-weight:400">— ${tfl} ${CORR._intraday?'intraday':'daily'}-return correlation · Δ = ${esc(me.ticker)} return − other</span></div>
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
  const row=p=>{ const ra=corrRet(rows[p.i]), rb=corrRet(rows[p.j]), d=(ra!=null&&rb!=null)?ra-rb:null;
    const dt=(ra!=null&&rb!=null)?`${tfl}: ${p.a} ${ra>=0?'+':''}${ra.toFixed(1)}% vs ${p.b} ${rb>=0?'+':''}${rb.toFixed(1)}%`:'not enough history';
    return `<tr data-i="${p.i}" data-j="${p.j}"><td class="pp">${esc(p.a)} <span class="sec">×</span> ${esc(p.b)}</td>`+
      `<td class="${p.v>=0?'pos':'neg'}" style="text-align:right">${p.v>=0?'+':''}${p.v.toFixed(2)}</td>`+
      `<td style="text-align:right" title="${esc(dt)}">${spp(d)}</td>`+
      `<td class="sec" style="text-align:right">${p.n}${CORR._intraday?'':'d'}</td></tr>`; };
  const head='<thead><tr><th>Pair</th><th>r</th><th title="window-return spread: left ticker − right ticker">Δ</th><th>n</th></tr></thead>';
  box.innerHTML=`<div class="cp-cols">
    <div><div class="cp-sub">Strongest correlations (${tfl})</div><table class="ptbl">${head}<tbody>${top.map(row).join('')}</tbody></table></div>
    <div><div class="cp-sub">Strongest inverse correlations (${tfl})</div><table class="ptbl">${head}<tbody>${bot.length?bot.map(row).join(''):'<tr><td class="sec" colspan="4">no negative correlations in this window</td></tr>'}</tbody></table></div>
  </div>`;
  box.querySelectorAll('tbody tr[data-i]').forEach(tr=>tr.addEventListener('click',()=>{ openPair(+tr.dataset.i, +tr.dataset.j); }));
}
// (-105) the pair view aligns the same bars the matrix correlated: the session view, forming bar
// dropped, a crypto leg folded onto the US calendar when the other leg keeps sessions.
function alignedDaily(a,b,Ldays){ if(!a.daily||!b.daily) return null;
  const mixed=!!sessCalOf(a)!==!!sessCalOf(b), ca=closedDaily(sessBarsFor(a, corrCalFor(a,mixed))), cb=closedDaily(sessBarsFor(b, corrCalFor(b,mixed)));
  if(!ca||!cb) return null;
  const cutoff=Math.floor(Date.now()/DAY)-Ldays, ma=new Map(), mb=new Map();
  for(const k of ca){ const cl=parseFloat(k.c), d=Math.floor(k.t/DAY); if(isFinite(cl)&&d>=cutoff) ma.set(d,cl); }
  for(const k of cb){ const cl=parseFloat(k.c), d=Math.floor(k.t/DAY); if(isFinite(cl)&&d>=cutoff) mb.set(d,cl); }
  const days=[...ma.keys()].filter(d=>mb.has(d)).sort((x,y)=>x-y);
  return {days, pa:days.map(d=>ma.get(d)), pb:days.map(d=>mb.get(d))}; }
// Crypto pair alignment: both names already sit on the matrix's shared intraday grid (CORR._bars),
// so we just intersect the non-null closes — same {days,pa,pb} shape alignedDaily returns, so the
// pair-view math below is identical. The β / spread-z / rolling-ρ read is on intraday returns.
function alignedIntraday(A,B){ if(!CORR._bars) return null;
  const a=CORR._bars.get(A.ticker), b=CORR._bars.get(B.ticker); if(!a||!b) return null;
  const pa=[],pb=[]; const n=Math.min(a.length,b.length);
  for(let k=0;k<n;k++){ if(a[k]!=null&&b[k]!=null){ pa.push(a[k]); pb.push(b[k]); } }
  return pa.length>=2?{days:pa.map((_,k)=>k), pa, pb}:null; }
function sparkline(vals, opts){ opts=opts||{}; const w=260, h=46, pad=4;
  const fin=vals.filter(v=>v!=null&&isFinite(v)); if(fin.length<2) return '<div class="sec" style="font-size:var(--fs-xs)">not enough data</div>';
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
  const _series=vals.map(v=>(v==null||!isFinite(v))?'':(+v)).join(',');
  const _meta=`data-series="${_series}"`
    + (opts.tipName ? ` data-name="${esc(opts.tipName)}"` : '')
    + (opts.tipUnit ? ` data-unit="${esc(opts.tipUnit)}"` : '')
    + (opts.tipLabel ? ` data-tip="${esc(opts.tipLabel)}"` : '')
    + (opts.tipDates ? ` data-labels="${esc(opts.tipDates.join('|'))}"` : '');
  return `<svg class="spark" ${_meta} viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${pre}<path d="${d.trim()}" fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>${dot}</svg>`; }
function rollStability(roll){ const v=roll.filter(x=>x!=null&&isFinite(x)); if(v.length<3)return '';
  const s=stdev(v), mn=Math.min(...v), mx=Math.max(...v);
  if(s<0.15) return 'stable relationship across the window';
  if(mx-mn>0.8) return 'unstable — the relationship flips within the window';
  return 'moderately variable over the window'; }
function openPair(i,j){ const rows=CORR._rows; if(!rows||i==null||j==null||i===j||i>=rows.length||j>=rows.length) return;
  state.corr.pair=[i,j]; state.corr.selected=null; renderCorrPanel(); renderPairPanel();
  el('pairpanel').scrollIntoView({behavior:SCROLL_B,block:'nearest'}); }
// A pair-view leg's display name: a basket leg shows its clean label (industry) or token; a ticker
// shows its symbol. The ratio/candles handoff still uses .ticker (the key) — display only.
function pairLegName(R){ return R._basket ? (R._basket.label||R._basket.name) : String(R.ticker||'').toUpperCase(); }
function renderPairPanel(){
  const p=el('pairpanel'), rows=CORR._rows, pr=state.corr.pair;
  if(!rows||!pr){ p.hidden=true; return; }
  const [i,j]=pr, A=rows[i], B=rows[j]; if(!A||!B){ p.hidden=true; return; }
  const cr=CORR._intraday, al = cr ? alignedIntraday(A,B) : alignedDaily(A,B,+state.corr.tf);
  const minPts = cr ? Math.max(12, CORR._minOv||20) : 8;
  const close='<button class="btn xtiny" id="pairclose" title="close" style="float:right">✕</button>';
  if(!al||al.days.length<minPts){ p.hidden=false;
    p.innerHTML=`<div class="cp-head">${A._basket?'<span class="bkg">\u2b12</span>':''}${esc(pairLegName(A))} ÷ ${B._basket?'<span class="bkg">\u2b12</span>':''}${esc(pairLegName(B))} ${close}</div><div class="sec" style="margin-top:6px">Not enough overlapping ${cr?'intraday':'daily'} history yet — still loading in the background, or one of these listed recently.</div>`;
    el('pairclose').onclick=()=>{ state.corr.pair=null; p.hidden=true; }; return; }
  const retA=[],retB=[]; for(let k=1;k<al.pa.length;k++){ retA.push(Math.log(al.pa[k]/al.pa[k-1])); retB.push(Math.log(al.pb[k]/al.pb[k-1])); }
  let saA=0,saB=0; const nR=retA.length; for(let k=0;k<nR;k++){saA+=retA[k];saB+=retB[k];}
  const mA=saA/nR, mB=saB/nR; let cov=0,vB=0; for(let k=0;k<nR;k++){const da=retA[k]-mA,db=retB[k]-mB;cov+=da*db;vB+=db*db;}
  const hedge=vB>0?cov/vB:1;
  const resid=al.pa.map((x,k)=>Math.log(x)-hedge*Math.log(al.pb[k]));
  const m=resid.reduce((s,x)=>s+x,0)/resid.length, sd=stdev(resid), last=resid[resid.length-1], z=sd>0?(last-m)/sd:0;
  const W=Math.min(30, Math.max(10, Math.floor(retA.length/3))), roll=[];
  for(let k=0;k<retA.length;k++){ if(k<W-1){ roll.push(null); continue; } roll.push(pearson(retA.slice(k-W+1,k+1), retB.slice(k-W+1,k+1))); }
  const cNow=CORR._C[i][j], ra=corrRet(A), rb=corrRet(B), spread=(ra!=null&&rb!=null)?ra-rb:null;
  const zc=Math.abs(z)>=2?'neg':(Math.abs(z)>=1?'pos':'sec');
  const rcap=z>1.5?`spread stretched high — ${esc(A.ticker)} rich vs ${esc(B.ticker)}`:(z<-1.5?`spread stretched low — ${esc(A.ticker)} cheap vs ${esc(B.ticker)}`:'spread near its mean (fair value)');
  p.hidden=false;
  p.innerHTML=`
    <div class="cp-head">${A._basket?'<span class="bkg">\u2b12</span>':''}${esc(pairLegName(A))} ÷ ${B._basket?'<span class="bkg">\u2b12</span>':''}${esc(pairLegName(B))} <span class="sec" style="font-weight:400">— ${tfLabel()} pair view</span> ${close}${featureOn('baskets')?`<button class="btn xtiny" id="pairratio" data-tip="open these two legs as ratio candles — the same ${esc(A.ticker)} ÷ ${esc(B.ticker)} series as TF candlesticks with an honest EMA200" style="float:right;margin-right:8px">candles</button>`:''}</div>
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
      <div><div class="cp-sub">Rolling ${W}-${cr?'bar':'day'} correlation <span class="sec">· now ${cNow==null?'—':cNow.toFixed(2)}</span></div>
        ${sparkline(roll,{zero:true,lo:-1,hi:1,color:'var(--blue)'})}
        <div class="sec spk-cap">${rollStability(roll)}</div></div>
    </div>`;
  el('pairclose').onclick=()=>{ state.corr.pair=null; p.hidden=true; };
  const prb=el('pairratio'); if(prb) prb.onclick=()=>openRatio(A.ticker,B.ticker);
}

// ===== Custom baskets (build 2026.07.28-06) ==============================================
// Synthetic EW instruments for the VISUAL layer. Definitions + server-synthesized daily series
// arrive via /api/baskets — the client never invents membership, and the equity COMP/G leg
// consumes the SERVER's daily synthesis verbatim. Crypto COMP/G (intraday) synthesizes over the
// matrix's own bars with basketClosesClient below, which the suite DUELS against compute.js
// basketCloses on one fixture — one math, two runtimes, outputs pinned bit-identical.
// Tier boundary, load-bearing: baskets and ratios exist in COMP/G, the ratio panel, the manager
// and the picker ONLY. They never touch signal math, alerts, or the ladder — there is no ledger
// to unwind when one is dropped.
let BASKETS={ts:0, floor:0.6, maxMembers:20, maxCustom:12, rev:-1, list:[]};
let _basketsInflight=false;
// ===== Guest baskets (build 2026.07.28-11) ===============================================
// Ownership model: the SERVER registry belongs to the admin alone (persisted, roster-synthesized).
// A non-admin's custom baskets live ONLY in this browser (localStorage) — non-persistent across
// cleared storage or another device, invisible to the admin and to every other guest, and never
// sent to the server (which refuses a non-admin write anyway). Built-ins (MAG7, sector baskets)
// stay global and read-only for everyone. When real users land later, this whole guest path is
// deleted and `owner` keys to a user id instead — the server seam already carries the field.
const GUEST_BK_KEY='xyz-guest-baskets';
let _guestRev=0;
function guestBasketsLoad(){
  if(IS_ADMIN) return [];
  try{ const raw=localStorage.getItem(GUEST_BK_KEY); if(!raw) return [];
    const arr=JSON.parse(raw); if(!Array.isArray(arr)) return [];
    return arr.filter(b=>b&&/^[A-Z][A-Z0-9]{1,11}$/.test(b.name)&&Array.isArray(b.members)&&b.members.length>=2)
      .slice(0,12).map(b=>({name:b.name, scope:b.scope==='crypto'?'crypto':'stocks',
        members:[...new Set(b.members.map(m=>String(m||'').toUpperCase()).filter(Boolean))].slice(0,20),
        builtin:false, guest:true}));
  }catch(_){ return []; }
}
function guestBasketsSave(list){ try{ localStorage.setItem(GUEST_BK_KEY, JSON.stringify(
  list.map(b=>({name:b.name, scope:b.scope, members:b.members})))); }catch(_){}
  _guestRev++; }
// Synthesize the daily series for a guest basket the same way the server does for admin baskets —
// the client already carries every member's r.daily, and basketClosesClient is the duel-tested
// mirror of the server's basketCloses. So a guest basket charts identically to an admin one; only
// where it's STORED differs.
function guestBasketDaily(b){
  const rowsByTk=new Map(); for(const r of activeRows()) rowsByTk.set((r.ticker||'').toUpperCase(), r);
  const maps=b.members.map(m=>{ const r=rowsByTk.get(m), mm=new Map();
    if(r&&Array.isArray(r.daily)) for(const k of r.daily){ const c=parseFloat(k.c), d=Math.floor(k.t/DAY); if(isFinite(c)&&c>0) mm.set(d,c); }
    return mm; });
  const axset=new Set(); maps.forEach(m=>m.forEach((_,d)=>axset.add(d)));
  const axis=[...axset].sort((a,b)=>a-b);
  const series=maps.map(m=>axis.map(d=>{ const v=m.get(d); return v===undefined?null:v; }));
  const bc=basketClosesClient(series, BASKETS.floor);
  let covN=0; for(let i=axis.length-1;i>=0;i--){ if(bc.closes[i]!=null){ covN=bc.cov[i]; break; } }
  const daily=[]; for(let i=0;i<axis.length;i++) if(bc.closes[i]!=null) daily.push([axis[i]*DAY, +bc.closes[i].toFixed(4)]);
  return { daily:daily.map(p=>({t:p[0], c:p[1]})), cov:{n:covN, N:b.members.length} };
}
function guestMerge(serverList){
  if(IS_ADMIN) return serverList;
  const guests=guestBasketsLoad().map(b=>{ const s=guestBasketDaily(b);
    return { name:b.name, scope:b.scope, members:b.members, builtin:false, guest:true, daily:s.daily, cov:s.cov }; });
  // a guest name never collides with a built-in (validated on create); append after the server's
  // built-ins so the picker groups them naturally.
  return serverList.concat(guests);
}
async function loadBaskets(force){
  if(!featureOn('baskets')) return;
  if(_basketsInflight) return;
  if(!force && Date.now()-BASKETS.ts<60000 && BASKETS.list.length){ renderBasketPanel(); return; }
  _basketsInflight=true;
  let serverList=[];
  try{ const d=await fetchJSON('/api/baskets');
    if(d&&Array.isArray(d.baskets)){ serverList=d.baskets;
      BASKETS={ts:Date.now(), floor:d.floor||0.6, maxMembers:d.maxMembers||20, maxCustom:d.maxCustom||12, rev:(d.rev||0)+'|'+_guestRev, list:guestMerge(d.baskets)};
    }
  }catch(_){}
  _basketsInflight=false;
  renderBasketPanel(); syncCorrBk();
  const cg=el('compg'); if(cg&&!cg.hidden&&COMPG.sel.some(t=>isBasketName(t))) renderCompg();
  // -09: baskets now surface on three more tabs — repaint whichever is live so the registry
  // landing is visible without a manual poke. Each call is cheap and view-gated internally.
  if(state.view==='markets'){ buildHead(); render(); }
  if(state.view==='backtest') drawBacktest();
  if(state.view==='corr'&&state.scope!=='crypto') renderCorr();
}
// Guest-side create/drop: pure localStorage, never touches the server. Returns the same {ok,error}
// shape the server does so the callers (manager form + terminal) are identical for both audiences.
function guestCreateBasket(name, members){
  const nm=String(name||'').toUpperCase().trim();
  if(!/^[A-Z][A-Z0-9]{1,11}$/.test(nm)) return {ok:false, error:'name must be 2–12 chars, A–Z / 0–9, starting with a letter'};
  const existing=guestBasketsLoad();
  if(existing.length>=(BASKETS.maxCustom||12)) return {ok:false, error:`basket cap reached (${BASKETS.maxCustom||12}) — drop one first`};
  const ms=[...new Set((members||[]).map(m=>String(m||'').toUpperCase().trim()).filter(Boolean))];
  if(ms.length<2||ms.length>(BASKETS.maxMembers||20)) return {ok:false, error:`needs 2–${BASKETS.maxMembers||20} members (got ${ms.length})`};
  // reserved: benchmark aliases, BTC, curated + loaded built-ins, and this browser's own. The
  // curated names are pinned unconditionally so a guest can't shadow MAG7 before the registry loads.
  const reserved=new Set(['SPX','SPX500','SP500','US500','BTC','MAG7',...BASKETS.list.filter(b=>b.builtin).map(b=>b.name),...existing.map(b=>b.name)]);
  if(reserved.has(nm)) return {ok:false, error:`“${nm}” collides with a built-in or benchmark alias, or you already have a basket by that name`};
  // scope inference from the live universe (guests only ever see one scope's rows at a time, but
  // validate against both so a wrong-scope member is caught, same as the server)
  const uni=new Set(activeRows().map(r=>(r.ticker||'').toUpperCase()));
  const miss=ms.filter(m=>!uni.has(m));
  if(miss.length) return {ok:false, error:`not in the ${state.scope} universe: ${miss.join(' ')}`};
  existing.push({name:nm, scope:state.scope==='crypto'?'crypto':'stocks', members:ms});
  guestBasketsSave(existing);
  return {ok:true, basket:{name:nm, scope:state.scope, members:ms, builtin:false, guest:true}};
}
function guestDropBasket(name){
  const nm=String(name||'').toUpperCase().trim();
  const existing=guestBasketsLoad(), i=existing.findIndex(b=>b.name===nm);
  if(i<0) return {ok:false, error:`no basket “${nm}” in this browser`};
  existing.splice(i,1); guestBasketsSave(existing);
  return {ok:true, name:nm};
}
// One entry point both audiences call — admin hits the server, guest hits localStorage. Async so
// the two paths share a signature.
async function basketMutate(body){
  if(IS_ADMIN){
    const r=await fetch('/api/baskets',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body)});
    return await r.json().catch(()=>({ok:false, error:'network'}));
  }
  return body.drop ? guestDropBasket(body.name) : guestCreateBasket(body.name, body.members);
}
function basketByName(t){ t=String(t||'').toUpperCase(); for(const b of BASKETS.list){ if(b.name===t) return b; } return null; }
// Display name for a basket key: an industry shadow carries a clean human label ("Semiconductors"),
// which is what the user should SEE — the 12-char token (SEMICONDUCTO) stays the internal key for
// selection, ratio legs, colour order, everything. One helper so chips, legend, picker, RATIO and
// the matrix all show the same friendly name and nothing re-derives it.
function basketDisplayName(t){ const b=basketByName(t); return (b&&b.label)?b.label:String(t||'').toUpperCase(); }
function isBasketName(t){ return !!basketByName(t); }
function basketScopeList(){ const cr=state.scope==='crypto'; return BASKETS.list.filter(b=>(b.scope==='crypto')===cr); }
// Manager list: the operator's own baskets + curated defaults (MAG7), NEVER the derived shadow
// baskets (sectors + industries). Shadows are pickable everywhere as instruments but would drown
// the editable list and can't be dropped anyway.
function basketManagerList(){ return basketScopeList().filter(b=>!b.shadow); }
function basketTip(b){
  const kind=b.shadow?(b.kind==='industry'?'industry basket':'sector basket'):(b.builtin?'built-in basket':'custom basket');
  const nm=b.label?`${b.name} (${b.label})`:b.name;
  return `\u2b12 ${nm} \u2014 ${kind}${b.builtin?' (derived from the classification table \u00b7 follows the live roster)':''} \u00b7 ${b.members.length} members \u00b7 EW \u00b7 daily-rebalanced (the only honest default without market-cap data) \u00b7 coverage ${b.cov?b.cov.n+'/'+b.cov.N:'\u2014'} \u00b7 a day under ${Math.round((BASKETS.floor||0.6)*100)}% membership renders as a GAP, never a renormalized guess \u00b7 visual layer only \u2014 baskets never enter signal math \u00b7 members: ${b.members.join(' ')}`;
}
// MIRROR of compute.js basketCloses — same algorithm, same floor semantics, verbatim. The suite
// executes both against one ragged fixture and asserts deepEqual, so this copy cannot drift from
// the server's without failing the build. Do not "improve" one side alone.
function basketClosesClient(seriesArr, floor){
  const N = Array.isArray(seriesArr) ? seriesArr.length : 0;
  const L = N ? Math.max(...seriesArr.map(s=>Array.isArray(s)?s.length:0)) : 0;
  const closes = new Array(L).fill(null), cov = new Array(L).fill(0);
  if (!N || !L) return { closes, cov, n: N };
  const need = Math.ceil((floor == null ? 0.6 : floor) * N);
  const last = new Array(N).fill(null);
  let idx = null;
  for (let i = 0; i < L; i++) {
    if (idx === null) {
      let cnt = 0;
      for (let m = 0; m < N; m++) { const v = seriesArr[m][i]; if (v != null && isFinite(v) && v > 0) cnt++; }
      cov[i] = cnt;
      if (cnt < need) continue;
      idx = 100; closes[i] = 100;
      for (let m = 0; m < N; m++) { const v = seriesArr[m][i]; if (v != null && isFinite(v) && v > 0) last[m] = v; }
      continue;
    }
    let sum = 0, cnt = 0;
    for (let m = 0; m < N; m++) {
      const v = seriesArr[m][i];
      if (v != null && isFinite(v) && v > 0 && last[m] != null) { sum += Math.log(v / last[m]); cnt++; }
    }
    cov[i] = cnt;
    if (cnt < need) continue;
    idx *= Math.exp(sum / cnt);
    closes[i] = idx;
    for (let m = 0; m < N; m++) { const v = seriesArr[m][i]; if (v != null && isFinite(v) && v > 0) last[m] = v; }
  }
  return { closes, cov, n: N };
}
// Crypto COMP/G leg: synthesize the basket over the matrix's OWN intraday bars (CORR._bars on
// CORR._times) so the overlay and the matrix agree to the number — the same seam the plain
// tickers already ride. Members absent from the matrix set are all-null series, handled by the
// same floor as everywhere else. Memoized per (registry rev, window, bar set).
function compgBasketBars(b){
  if(!b||!(CORR._intraday&&CORR._bars&&CORR._times)) return null;
  const key=BASKETS.rev+'|'+(CORR._win||'')+'|'+CORR._times.length;
  if(b._barsKey===key) return b._bars;
  const nul=CORR._times.map(()=>null);
  const series=b.members.map(m=>CORR._bars.get(m)||nul);
  const bc=basketClosesClient(series, BASKETS.floor);
  b._barsKey=key;
  b._bars=bc.closes.some(v=>v!=null)?bc.closes:null;
  return b._bars;
}
function compgBasketNames(){
  if(!featureOn('baskets')) return [];
  const cr=state.scope==='crypto';
  return basketScopeList().filter(b=>!cr||compgBasketBars(b)).map(b=>b.name);
}
// One virtual row per basket, shared by COMP/G, the correlation matrix, the pair view and the
// backtest yardstick — {ticker, coin, daily} is the whole contract those consumers read, and the
// daily is the SERVER's synthesis verbatim. Memoized per registry revision so dailyReturns'
// per-row cache survives repeated renders instead of recomputing on every paint.
function basketVirtualRow(b){
  if(!b) return null;
  if(b._vrow && b._vrowRev===BASKETS.rev) return b._vrow;
  b._vrowRev=BASKETS.rev;
  b._vrow={ ticker:b.name, coin:b.name, uni:'xyz', _basket:b, daily:(b.daily||[]).map(p=>({t:p[0], c:p[1]})) };
  return b._vrow;
}

// ===== Δ vs ⬒ — the markets-tab screener column (build 2026.07.28-09) =====================
// One header-picked basket; each row shows its own window return MINUS the EW mean of the
// basket members' returns over the SAME window — computed entirely from the h1/h4/d1/d7/d30
// fields already on the rows, following the board's timeframe selector. One code path with the
// board's own numbers: no fetch, no series, no re-derivation. Coverage floor 60% — a thinner
// mean is a dash, never a quieter lie. Tier boundary: a LENS, not the benchmark; RS and every
// beta stay on SP500/BTC, and r.dvb feeds no rule engine, no alert, no signal.
function dvbBasketDef(){
  if(!featureOn('baskets')) return null;
  const list=basketScopeList();
  if(!list.length) return null;
  return list.find(b=>b.name===state.dvbBasket)||list[0];
}
function dvbPickOpts(){
  const cur=dvbBasketDef();
  return basketScopeList().map(b=>`<option value="${esc(b.name)}"${cur&&cur.name===b.name?' selected':''}>\u2b12 ${esc(b.label||b.name)}</option>`).join('')||'<option value="">\u2014</option>';
}
function computeDvb(rows){
  const f=TF_MAP[state.tf], b=dvbBasketDef();
  if(!b||!f){ for(const r of rows) r.dvb=undefined; state._dvbMean=null; return; }
  const byTk=new Map(); for(const r of rows) byTk.set((r.ticker||'').toUpperCase(), r);
  let s=0,n=0;
  for(const m of b.members){ const mr=byTk.get(m); const v=mr?mr[f]:null; if(v!=null&&isFinite(v)){ s+=v; n++; } }
  const mean=n>=Math.ceil(0.6*b.members.length)?s/n:null;
  state._dvbMean=mean; state._dvbCov={n, N:b.members.length};
  for(const r of rows){ const v=r[f];
    r.dvb=(v===undefined)?undefined:((mean!=null&&v!=null&&isFinite(v))?v-mean:null); }
}
function dvbCell(r){
  if(r.dvb===undefined) return '<td><span class="ph">\u00b7</span></td>';
  if(r.dvb===null){ const c=state._dvbCov;
    return `<td class="sec" title="basket mean unavailable \u2014 ${c?c.n+'/'+c.N+' members carry this field, under the 60% floor':'no basket picked'}; a thinner average would be a quieter lie">\u2014</td>`; }
  const b=dvbBasketDef(), c=state._dvbCov;
  return `<td${shade(r.dvb,8)} title="${esc('vs \u2b12'+(b?b.name:'')+' \u00b7 EW mean of '+(c?c.n+'/'+c.N:'')+' members over '+state.tf+' \u00b7 screener lens, not the benchmark under RS/beta')}">${pctInner(r.dvb)}</td>`;
}

// ===== Basket rows in the stocks correlation matrix (build 2026.07.28-09) =================
// Custom baskets always join (when the feature is on); the 11 derived sector built-ins sit
// behind a toggle so they don't crowd an 84-name matrix. Virtual rows ride the exact same
// dailyReturns → pearson path as every ticker — no special math, so the matrix cannot disagree
// with COMP/G about what a basket did. Crypto matrix is server-built from the 5m archive, so
// basket rows there are DEFERRED and the toggle's tooltip says so — stated, not half-implemented.
function corrBasketRows(){
  if(!featureOn('baskets')||state.scope==='crypto') return [];
  // The toggle adds customs + curated + SECTOR shadows. Industry shadows are excluded here on
  // purpose: there are many, and 20+ extra rows would drown an 84-name matrix — they stay
  // comparison-only instruments (COMP/G, ratio, the Δ column) rather than matrix rows.
  return BASKETS.list
    .filter(b=>b.scope==='stocks' && b.kind!=='industry' && (state.corr.showBuiltins||!b.builtin))
    .map(basketVirtualRow)
    .filter(r=>r&&r.daily.length>=5);
}
function syncCorrBk(){
  const seg=el('corrbk'); if(!seg) return;
  const on=featureOn('baskets')&&state.scope!=='crypto';
  seg.hidden=!on; if(!on) return;
  const nCust=BASKETS.list.filter(b=>b.scope==='stocks'&&!b.builtin).length;
  seg.innerHTML=`<span class="seglbl" title="custom baskets (${nCust}) always join the stocks matrix as dashed \u2b12 rows \u2014 synthetic EW series, visual layer only, same daily-return math as every ticker">\u2b12 rows \u00b7 custom ${nCust}</span>`
    +`<button type="button" data-bk="blt"${state.corr.showBuiltins?' class="active"':''} title="add the derived sector baskets (TECH, HEALTH, \u2026) as matrix rows \u2014 off by default so 11 extra rows don't crowd the matrix. Crypto matrix is server-built from the 5m archive, so basket rows there are deferred.">+ built-ins</button>`;
  const b=seg.querySelector&&seg.querySelector('[data-bk="blt"]');
  if(b) b.onclick=()=>{ state.corr.showBuiltins=!state.corr.showBuiltins; syncCorrBk(); renderCorr(); };
}


// ===== Basket manager panel ==============================================================
// Lives on the Corr tab under COMP/G. Built-ins render as derived (no drop button); customs
// carry create/drop wired to POST /api/baskets. Every constraint the server enforces is stated
// in the form line — the error path is for races, not for discovery.
function renderBasketPanel(){
  const p=el('basketpanel'); if(!p) return;
  if(!featureOn('baskets')||state.view!=='corr'){ p.hidden=true; return; }
  const list=basketManagerList();
  const rowsH=list.map(b=>`<tr>
      <td style="white-space:nowrap"><span class="bkg">\u2b12</span> <b>${esc(b.name)}</b>${b.builtin?' <span class="bk-builtin">BUILT-IN</span>':(b.guest?' <span class="bk-guest" data-tip="stored in THIS browser only \u2014 not saved on the server, invisible to the admin and to other visitors, and gone if you clear site data">THIS BROWSER</span>':'')}</td>
      <td class="sec">${esc(b.members.join(' '))} <span class="sec">\u00b7 ${b.members.length}</span></td>
      <td class="sec" style="white-space:nowrap" data-tip="equal weight, daily-rebalanced \u2014 the only honest default without market-cap data \u00b7 coverage = members contributing on the latest valid day \u00b7 a day under ${Math.round((BASKETS.floor||0.6)*100)}% membership renders as a gap, never a renormalized guess">EW \u00b7 ${b.cov?b.cov.n+'/'+b.cov.N:'\u2014'}</td>
      <td>${b.builtin?'<span class="sec" style="font-size:var(--fs-2xs)">derived \u2014 follows the roster</span>':`<button class="btn xtiny" data-bkdrop="${esc(b.name)}">drop</button>`}</td>
    </tr>`).join('');
  const customN=BASKETS.list.filter(b=>!b.builtin).length;
  // Ownership banner: the admin's customs persist server-side; a guest's live only in this browser.
  const scopeBanner=IS_ADMIN
    ? `<div class="sec" style="font-size:var(--fs-xs);margin-top:2px">Your custom baskets are saved on the server and available on every admin browser. Visitors don't see them \u2014 they only get the built-ins.</div>`
    : `<div class="sec bk-guestbanner" style="font-size:var(--fs-xs);margin-top:2px" data-tip="no accounts yet \u2014 without an admin session your baskets can only live in this browser">Your custom baskets are stored in <b>this browser only</b> \u2014 not saved on the server, and gone if you clear site data. The built-ins (MAG7, sectors) are shared and always here.</div>`;
  p.hidden=false;
  p.innerHTML=`<div class="cp-head">Baskets <span class="sec" style="font-weight:400">\u2014 synthetic EW instruments \u00b7 visual layer only, never signal math</span></div>
    ${scopeBanner}
    <table class="bk-mgr"><tbody>${rowsH||'<tr><td class="sec">no baskets in this universe yet \u2014 create one below, or in the terminal: <span class="amber">basket create MAG7 AAPL MSFT GOOGL AMZN NVDA META TSLA</span></td></tr>'}</tbody></table>
    <div class="bk-new">
      <input id="bk-name" placeholder="name \u2014 e.g. MAG7" maxlength="12" autocomplete="off"/>
      <input id="bk-members" placeholder="members \u2014 e.g. AAPL MSFT GOOGL AMZN NVDA META TSLA" autocomplete="off"/>
      <button class="btn xtiny" id="bk-create">create</button>
      <span id="bk-err" class="tp-err"></span></div>
    <div class="sec" style="font-size:var(--fs-xs);margin-top:5px">2\u2013${BASKETS.maxMembers} members \u00b7 one universe (baskets never cross the stocks/crypto separation) \u00b7 ${customN}/${BASKETS.maxCustom} custom \u00b7 name must not collide with a listed ticker or a benchmark alias</div>`;
  p.querySelectorAll('[data-bkdrop]').forEach(x=>x.onclick=async()=>{
    const d=await basketMutate({name:x.dataset.bkdrop, drop:true});
    if(d&&d.ok) loadBaskets(true); else { const e=el('bk-err'); if(e) e.textContent=(d&&d.error)||'drop failed'; } });
  const cb=el('bk-create'); if(cb) cb.onclick=async()=>{
    const nm=(el('bk-name')||{}).value||'', mem=((el('bk-members')||{}).value||'').split(/[\s,]+/).filter(Boolean);
    const eo=el('bk-err'); if(eo) eo.textContent='';
    const d=await basketMutate({name:nm, members:mem});
    if(d&&d.ok) loadBaskets(true); else if(eo) eo.textContent=(d&&d.error)||'create failed'; };
}

// ===== RATIO — synthetic pair candles ====================================================
// Server-computed (one code path): hourly ratio closes bucketed into TF candles, EMA200 over the
// full series before the wire trim. The client renders and rebases — a display transform only
// (rebase is a scalar multiply, so the shipped EMA scales by the same factor and stays exact).
const RATIO={num:null, den:null, tf:'4h', scale:'reb', ema:true, data:null, inflight:false, closed:false};
function openRatio(num,den,tf){
  RATIO.num=String(num||'').toUpperCase(); RATIO.den=String(den||'').toUpperCase();
  if(tf) RATIO.tf=String(tf).toLowerCase();
  RATIO.closed=false;
  loadRatio();
}
async function loadRatio(){
  const p=el('ratiopanel'); if(!p||!featureOn('baskets')||RATIO.closed) return;
  if(!RATIO.num||!RATIO.den){ p.hidden=true; return; }
  p.hidden=false;
  p.innerHTML=`<div class="cp-head">RATIO <span class="sec" style="font-weight:400">\u2014 building ${esc(RATIO.num)} \u00f7 ${esc(RATIO.den)} \u00b7 ${esc(RATIO.tf.toUpperCase())}\u2026</span></div>`;
  RATIO.inflight=true;
  try{ RATIO.data=await fetchJSON('/api/ratio?num='+encodeURIComponent(RATIO.num)+'&den='+encodeURIComponent(RATIO.den)+'&tf='+encodeURIComponent(RATIO.tf)); }
  catch(e){ RATIO.data={ok:false,error:e.message||'network error'}; }
  RATIO.inflight=false;
  renderRatio();
  p.scrollIntoView({behavior:SCROLL_B,block:'nearest'});
}
// Pure SVG builder — no DOM, no globals beyond esc — so the suite can EXECUTE it against a fixture
// payload and assert real candle markup emerges (the -84 lesson: existence pins don't prove wiring).
// Returns {svg, pts} where pts[i] = {x, yo, yh, yl, yc, k} for the hover wiring.
function ratioSvg(d, opt){
  const W=940, H=300, PL=52, PR=14, PT=10, PB=24;
  const ks=d.candles||[]; if(!ks.length) return {svg:'<div class="sec">no candles</div>', pts:[]};
  const f = opt.scale==='reb' ? 100/ks[0].o : 1;
  const ema = (opt.ema&&d.ema200) ? d.ema200.map(v=>v==null?null:v*f) : null;
  let lo=Infinity, hi=-Infinity;
  for(const k of ks){ if(k.l*f<lo) lo=k.l*f; if(k.h*f>hi) hi=k.h*f; }
  if(ema) for(const v of ema){ if(v!=null){ if(v<lo)lo=v; if(v>hi)hi=v; } }
  const pad=(hi-lo)*0.06||1e-9; lo-=pad; hi+=pad;
  const X=i=>PL+(i+0.5)*(W-PL-PR)/ks.length, Y=v=>PT+(hi-v)*(H-PT-PB)/(hi-lo);
  const bw=Math.max(1.5, Math.min(9, (W-PL-PR)/ks.length*0.62));
  let g='';
  const dp=(hi-lo)<0.5?4:(hi-lo)<5?3:2;
  for(let i=0;i<5;i++){ const v=lo+pad+(hi-lo-2*pad)*i/4, y=Y(v).toFixed(1);
    g+=`<line x1="${PL}" x2="${W-PR}" y1="${y}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`
      +`<text x="${PL-6}" y="${(+y+3).toFixed(1)}" fill="var(--faint)" font-size="10" text-anchor="end">${v.toFixed(dp)}</text>`; }
  const pts=[];
  let body='';
  for(let i=0;i<ks.length;i++){ const k=ks[i], x=X(i), up=k.c>=k.o, col=up?'var(--up)':'var(--down)';
    const yo=Y(k.o*f), yc=Y(k.c*f), yh=Y(k.h*f), yl=Y(k.l*f);
    const top=Math.min(yo,yc), hh=Math.max(0.8, Math.abs(yo-yc));
    body+=`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${yh.toFixed(1)}" y2="${yl.toFixed(1)}" stroke="${col}" stroke-width="1"/>`
      +`<rect class="rt-k" x="${(x-bw/2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${col}"/>`;
    pts.push({x, yo, yh, yl, yc, k}); }
  let emaPath='';
  if(ema){ let dstr='', pen=false;
    for(let i=0;i<ks.length;i++){ const v=ema[i];
      if(v==null){ pen=false; continue; }
      dstr+=(pen?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)+' '; pen=true; }
    if(dstr) emaPath=`<path class="rt-ema" d="${dstr.trim()}" fill="none" stroke="var(--blue)" stroke-width="1.6" opacity="0.95"/>`; }
  const svg=`<svg id="rt-chart" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" style="display:block">`
    +g+body+emaPath
    +`<line id="rt-cx" x1="0" x2="0" y1="${PT}" y2="${H-PB}" stroke="var(--faint)" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>`
    +`<rect id="rt-hl" x="0" y="${PT}" width="0" height="${H-PT-PB}" fill="var(--text)" opacity="0"/>`
    +`</svg>`;
  return {svg, pts, W, H, PT, PB};
}
// The static picture of a ratio (build 2026.09.11-74): what /ratio posts into a chat. Same candle
// geometry as ratioSvg above (rebased 100, EMA on the same scale), plus everything a PICTURE needs
// that the interactive panel gets from hover — a time axis, a y axis with room, the EMA named, the
// last close tagged, the pair and window in the header. Pure: no DOM, colours come in as literals
// (CSS variables don't resolve inside an <img>), so the suite can execute it against a fixture.
function ratioImageSvg(d, opt){
  const C=Object.assign({bg:'#0E1116',panel:'#151A21',border:'#262E39',grid:'#1A212A',text:'#E8E3D7',muted:'#8A93A0',dim:'#7A8592',accent:'#E3A53C',up:'#46B97E',down:'#E5604D',blue:'#6f93c9'},(opt&&opt.colors)||{});
  const ks=d.candles||[]; if(!ks.length) return {svg:'',W:0,H:0,n:0};
  const W=1200, H=560, PL=70, PR=84, PT=76, PB=54, mono='ui-monospace,Menlo,Consolas,monospace';
  const f=(opt&&opt.scale==='raw')?1:100/ks[0].o;
  const ema=d.ema200?d.ema200.map(v=>v==null?null:v*f):null;
  let lo=Infinity, hi=-Infinity;
  for(const k of ks){ if(k.l*f<lo) lo=k.l*f; if(k.h*f>hi) hi=k.h*f; }
  if(ema) for(const v of ema){ if(v!=null){ if(v<lo)lo=v; if(v>hi)hi=v; } }
  const pad=(hi-lo)*0.07||1e-9; lo-=pad; hi+=pad;
  const pw=W-PL-PR, ph=H-PT-PB;
  const X=i=>PL+(i+0.5)*pw/ks.length, Y=v=>PT+(hi-v)*ph/(hi-lo);
  const bw=Math.max(3, Math.min(14, pw/ks.length*0.68));
  const dp=(hi-lo)<0.5?4:(hi-lo)<5?3:(hi-lo)<50?2:1;
  const esc_=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  let g='';
  for(let i=0;i<=5;i++){ const v=lo+pad+(hi-lo-2*pad)*i/5, y=Y(v).toFixed(1);
    g+=`<line x1="${PL}" x2="${W-PR}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-width="1"/>`
      +`<text x="${PL-10}" y="${(+y+4).toFixed(1)}" fill="${C.dim}" font-family="${mono}" font-size="12" text-anchor="end">${v.toFixed(dp)}</text>`; }
  // Time axis: ~6 ticks on candle timestamps, labelled at the resolution the timeframe needs.
  const tf=String(d.tf||opt&&opt.tf||'').toLowerCase();
  const lbl=t=>{ if(!t) return ''; const dt=new Date(+t); const o={timeZone:'America/New_York',month:'short',day:'2-digit'}; if(tf!=='1d') Object.assign(o,{hour:'2-digit',hour12:false});
    try{ const t=dt.toLocaleString('en-US',o).replace(',',''); return tf==='1d'?t:t.replace(/ (\d\d)$/,' $1h'); }catch(_){ return dt.toISOString().slice(5,16).replace('T',' '); } };
  const step=Math.max(1,Math.round(ks.length/6)); let xa='';
  for(let i=0;i<ks.length;i+=step){ const x=X(i).toFixed(1);
    xa+=`<line x1="${x}" x2="${x}" y1="${PT}" y2="${H-PB}" stroke="${C.grid}" stroke-width="1"/>`
      +`<text x="${x}" y="${H-PB+20}" fill="${C.dim}" font-family="${mono}" font-size="12" text-anchor="middle">${esc_(lbl(ks[i].t))}</text>`; }
  let body='';
  for(let i=0;i<ks.length;i++){ const k=ks[i], x=X(i), up=k.c>=k.o, col=up?C.up:C.down;
    const yo=Y(k.o*f), yc=Y(k.c*f), yh=Y(k.h*f), yl=Y(k.l*f), top=Math.min(yo,yc), hh=Math.max(1.2,Math.abs(yo-yc));
    body+=`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${yh.toFixed(1)}" y2="${yl.toFixed(1)}" stroke="${col}" stroke-width="1.2"/>`
      +`<rect class="ri-k" x="${(x-bw/2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${col}"/>`; }
  let emaPath='', emaLeg='';
  if(ema){ let dstr='', pen=false;
    for(let i=0;i<ks.length;i++){ const v=ema[i]; if(v==null){ pen=false; continue; } dstr+=(pen?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)+' '; pen=true; }
    if(dstr){ emaPath=`<path class="ri-ema" d="${dstr.trim()}" fill="none" stroke="${C.blue}" stroke-width="2" opacity="0.95"/>`;
      emaLeg=`<line x1="${W-PR-96}" x2="${W-PR-72}" y1="${PT-14}" y2="${PT-14}" stroke="${C.blue}" stroke-width="2"/><text x="${W-PR-64}" y="${PT-10}" fill="${C.blue}" font-family="${mono}" font-size="12">EMA ${d.emaSpan||200}</text>`; } }
  // Last close: a dashed level across the plot and a tag in the right gutter.
  const last=ks[ks.length-1], first=ks[0], lv=last.c*f, ly=Y(lv), chg=first.o>0?(last.c/first.o-1)*100:null, upW=chg==null||chg>=0;
  const tag=`<line x1="${PL}" x2="${W-PR}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${C.accent}" stroke-width="1" stroke-dasharray="4 4" opacity="0.8"/>`
    +`<rect x="${W-PR+6}" y="${(ly-11).toFixed(1)}" width="${PR-12}" height="22" rx="4" fill="${C.accent}"/>`
    +`<text x="${W-PR/2}" y="${(ly+4).toFixed(1)}" fill="${C.bg}" font-family="${mono}" font-size="12" font-weight="700" text-anchor="middle">${lv.toFixed(dp)}</text>`;
  const pair=`${d.numBasket?'⬒ ':''}${d.num||''} ÷ ${d.denBasket?'⬒ ':''}${d.den||''}`;
  const head=`<text x="${PL}" y="30" fill="${C.accent}" font-family="${mono}" font-size="12" font-weight="700" letter-spacing="1">RATIO</text>`
    +`<text x="${PL+62}" y="31" fill="${C.text}" font-family="${mono}" font-size="20" font-weight="700">${esc_(pair)}</text>`
    +`<text x="${PL}" y="52" fill="${C.muted}" font-family="${mono}" font-size="12">${esc_(`${tf.toUpperCase()} candles · ${(opt&&opt.scale==='raw')?'raw ratio':'rebased 100 at window start'} · last ${d.shown||ks.length}/${d.bars||ks.length} bars`)}</text>`
    +(chg!=null?`<text x="${W-PR}" y="31" fill="${upW?C.up:C.down}" font-family="${mono}" font-size="20" font-weight="700" text-anchor="end">${chg>=0?'+':''}${chg.toFixed(2)}%</text>`
      +`<text x="${W-PR}" y="52" fill="${C.muted}" font-family="${mono}" font-size="12" text-anchor="end">window · last ${esc_(last.c.toFixed(Math.abs(last.c)>=100?2:4))} raw</text>`:'');
  const foot=`<text x="${PL}" y="${H-12}" fill="${C.dim}" font-family="${mono}" font-size="11">bucketed from hourly ratio closes · intrabar extremes finer than 1H not captured</text>`;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.bg}"/>`
    +`<rect x="${PL}" y="${PT}" width="${pw}" height="${ph}" fill="${C.panel}" stroke="${C.border}"/>`+head+g+xa+body+emaPath+emaLeg+tag+foot+`</svg>`;
  return {svg, W, H, n:ks.length};
}
function renderRatio(){
  const p=el('ratiopanel'); if(!p) return;
  if(!featureOn('baskets')||state.view!=='corr'||RATIO.closed||!RATIO.num){ p.hidden=true; return; }
  const d=RATIO.data;
  const close=`<button class="btn xtiny" id="rt-close" title="close" style="float:right">\u2715</button>`;
  const head=(extra)=>`<div class="cp-head">RATIO <span class="sec" style="font-weight:400">\u2014 ${esc(basketDisplayName(RATIO.num))} \u00f7 ${esc(basketDisplayName(RATIO.den))}</span> ${close}${extra||''}</div>`;
  if(!d){ p.hidden=false; p.innerHTML=head(); wireRatioCommon(); return; }
  if(!d.ok){ p.hidden=false;
    p.innerHTML=head()+`<div class="sec" style="margin-top:8px">${esc(d.error||'ratio unavailable')}</div>`;
    wireRatioCommon(); return; }
  // Adopt the server's canonical leg names: if you typed a natural label ("semiconductor"), the
  // server resolved it to the real basket token, and the panel should show that, not the raw input.
  if(d.num) RATIO.num=String(d.num).toUpperCase();
  if(d.den) RATIO.den=String(d.den).toUpperCase();
  const tfBtns=['1h','4h','12h','1d'].map(t=>`<button class="cg-pill${RATIO.tf===t?' on':''}" data-rtf="${t}">${t.toUpperCase()}</button>`).join('');
  const scBtns=[['reb','rebased 100'],['raw','raw ratio']].map(([k,l])=>`<button class="cg-pill${RATIO.scale===k?' on':''}" data-rsc="${k}" data-tip="${k==='reb'?'both the candles and the EMA multiplied by 100 \u00f7 first shown open \u2014 a scalar display transform, the geometry is untouched':'the ratio as computed \u2014 numerator close \u00f7 denominator close on the hourly spine'}">${l}</button>`).join('');
  const emaOk=!!d.ema200;
  const emaBtn=emaOk
    ? `<button class="cg-pill${RATIO.ema?' on':''}" id="rt-ema" data-tip="EMA ${d.emaSpan} computed server-side over the FULL ${d.bars}-bar series (SMA-seeded, the ladder's own construction), then trimmed with the window \u2014 the plotted line is exact, not window-seeded">EMA ${d.emaSpan}</button>`
    : `<button class="cg-pill" id="rt-ema" disabled data-tip="EMA ${d.emaSpan} needs ${d.emaMin} closed ${esc(RATIO.tf.toUpperCase())} bars \u2014 this pair has ${d.bars} on a ${d.spineDays}d spine; the toggle enables itself as history deepens. No shorter EMA ever wears the 200 name.">EMA ${d.emaSpan} \u2014 n/a</button>`;
  const S=ratioSvg(d,{scale:RATIO.scale, ema:RATIO.ema&&emaOk});
  const covBit=(lbl,isB,cov)=>isB?`${lbl} synthesized hourly (EW, coverage ${cov?cov.n+'/'+cov.N:'\u2014'}, floor ${Math.round((d.floor||0.6)*100)}%)`:null;
  const legBits=[
    `${d.numBasket?'\u2b12':''}${esc(d.num)} \u00f7 ${d.denBasket?'\u2b12':''}${esc(d.den)}`,
    `${esc(RATIO.tf.toUpperCase())} candles bucketed from hourly ratio closes`,
    RATIO.scale==='reb'?'rebased 100 at window start':'raw ratio',
    covBit('numerator',d.numBasket,d.numCov), covBit('denominator',d.denBasket,d.denCov),
    'intrabar extremes finer than 1H not captured',
    `showing last ${d.shown}/${d.bars} bars`,
  ].filter(Boolean);
  p.hidden=false;
  p.innerHTML=head()
    +`<div class="rt-ctrls"><span class="seg">${tfBtns}</span><button class="cg-pill" id="rt-swap" data-tip="flip numerator and denominator">\u21c4 swap</button><span class="seg">${scBtns}</span>${emaBtn}</div>`
    +`<div class="cg-chartwrap">${S.svg}<div class="rt-read" id="rt-read"></div></div>`
    +`<div class="rt-leg">${legBits.join(' \u00b7 ')}</div>`;
  wireRatioCommon();
  p.querySelectorAll('[data-rtf]').forEach(b=>b.onclick=()=>{ RATIO.tf=b.dataset.rtf; loadRatio(); });
  p.querySelectorAll('[data-rsc]').forEach(b=>b.onclick=()=>{ RATIO.scale=b.dataset.rsc; renderRatio(); });
  const eb=el('rt-ema'); if(eb&&emaOk) eb.onclick=()=>{ RATIO.ema=!RATIO.ema; renderRatio(); };
  const sw=el('rt-swap'); if(sw) sw.onclick=()=>{ const n=RATIO.num; RATIO.num=RATIO.den; RATIO.den=n; loadRatio(); };
  wireRatioHover(S,d);
}
function wireRatioCommon(){ const c=el('rt-close'); if(c) c.onclick=()=>{ RATIO.closed=true; const p=el('ratiopanel'); if(p) p.hidden=true; }; }
// Crosshair + candle highlight + OHLC readout — the standing rule: every chart hovers.
function wireRatioHover(S,d){
  const svg=el('rt-chart'), read=el('rt-read'), cx=el('rt-cx'), hl=el('rt-hl');
  if(!svg||!S.pts.length) return;
  const f=RATIO.scale==='reb'?100/d.candles[0].o:1;
  const dp=(v)=>{ const a=Math.abs(v); return a>=100?2:a>=1?4:6; };
  const fmt=(v)=>v.toFixed(dp(v));
  const move=(ev)=>{
    const r=svg.getBoundingClientRect();
    const mx=(ev.clientX-r.left)*S.W/r.width;
    let bi=0, bd=Infinity;
    for(let i=0;i<S.pts.length;i++){ const dd=Math.abs(S.pts[i].x-mx); if(dd<bd){bd=dd;bi=i;} }
    const P=S.pts[bi], k=P.k;
    cx.setAttribute('x1',P.x); cx.setAttribute('x2',P.x); cx.setAttribute('opacity','1');
    const bw=Math.max(3,(S.W-66)/S.pts.length);
    hl.setAttribute('x',P.x-bw/2); hl.setAttribute('width',bw); hl.setAttribute('opacity','0.06');
    const chg=(k.c/k.o-1)*100;
    const emaV=(RATIO.ema&&d.ema200&&d.ema200[bi]!=null)?d.ema200[bi]*f:null;
    read.innerHTML=`<span class="sec">${new Date(k.t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span>`
      +`<span>O <b>${fmt(k.o*f)}</b></span><span>H <b>${fmt(k.h*f)}</b></span><span>L <b>${fmt(k.l*f)}</b></span><span>C <b>${fmt(k.c*f)}</b></span>`
      +`<span class="${chg>=0?'pos':'neg'}">${chg>=0?'+':''}${chg.toFixed(2)}%</span>`
      +(emaV!=null?`<span style="color:var(--blue)">EMA${d.emaSpan} <b>${fmt(emaV)}</b></span>`:'');
  };
  svg.addEventListener('mousemove',move);
  svg.addEventListener('mouseleave',()=>{ cx.setAttribute('opacity','0'); hl.setAttribute('opacity','0'); read.innerHTML=''; });
}

// ===== COMP/G — N-name normalized comparison =============================================
// The pair view generalized to N names: rebase every series to 100 at a chosen anchor date and
// overlay (index mode), or plot each name minus the equal-weight basket / a chosen base in
// percentage points (spread mode). Runs entirely on r.daily — the same daily closes the board
// and the pair view already consume — so it's 100% client-side, zero server calls. Ragged
// histories are honest: a name listed after the anchor rebases to its own first close and the
// legend states the date, never a silent 100 at a different origin.
const COMPG_PAL=['var(--accent)','var(--blue)','var(--up)','var(--down)','#b98cd6','#d6c25a','#5ac8d6','#d68f5a'];
const COMPG={ sel:[], off:new Set(), mode:'index', base:'__basket', anchorTs:null, win:null, _intraday:false, _span:0, closed:false, _empty:false };
function compgColor(i){ return COMPG_PAL[i%COMPG_PAL.length]; }
function compgRowFor(tk){ tk=String(tk||'').toUpperCase();
  const b=basketByName(tk);   // virtual row: the SERVER's daily synthesis verbatim — the client never re-derives it
  if(b) return basketVirtualRow(b);
  for(const r of activeRows()){ if((r.ticker||'').toUpperCase()===tk||(r.coin||'').toUpperCase()===tk) return r; }
  if(tk==='BTC') return compgBtcRow();
  return null; }
// union-day alignment across N names; a name missing a day carries null (gaps stay visible)
function alignedDailyN(rows, Ldays){
  const cutoff=Math.floor(Date.now()/DAY)-Ldays;
  const maps=rows.map(r=>{ const m=new Map(), c=r&&r.daily?r.daily:[];
    for(const k of c){ const cl=parseFloat(k.c), d=Math.floor(k.t/DAY); if(isFinite(cl)&&d>=cutoff) m.set(d,cl); } return m; });
  const dayset=new Set(); maps.forEach(m=>m.forEach((_,d)=>dayset.add(d)));
  const days=[...dayset].sort((x,y)=>x-y);
  const series=maps.map(m=>days.map(d=>{ const v=m.get(d); return v===undefined?null:v; }));
  return {days, series};
}
// One data seam for COMP/G, so the rebase/spread/render below is universe-agnostic. Equities align
// daily closes over the window (axis = day-ms). Crypto reads the SAME intraday closes the matrix was
// built from (CORR._bars on CORR._times) — axis = bar timestamps in ms — so the overlay and the
// correlation matrix agree to the number. Returns { axis(ms[]), series(closes[][]), selPresent(tk[]) }.
function compgAligned(){
  if(state.scope==='crypto' && CORR._intraday && CORR._bars && CORR._times){
    const axis=CORR._times.slice();
    const selP=COMPG.sel.filter(t=>CORR._bars.has(t)||(isBasketName(t)&&compgBasketBars(basketByName(t))));
    return { axis, series:selP.map(t=>CORR._bars.has(t)?CORR._bars.get(t):compgBasketBars(basketByName(t))), selPresent:selP, intraday:true };
  }
  const L=COMPG.win||+state.corr.tf, rows=COMPG.sel.map(compgRowFor);
  const idx=COMPG.sel.map((_,i)=>i).filter(i=>rows[i]);
  const al=alignedDailyN(idx.map(i=>rows[i]), L);
  return { axis:al.days.map(d=>d*DAY), series:al.series, selPresent:idx.map(i=>COMPG.sel[i]), intraday:false };
}
function compgTickLabel(ts){ const d=new Date(ts), md=(d.getMonth()+1)+'/'+d.getDate();
  return (COMPG._intraday && COMPG._span<=1.6*DAY) ? md+' '+String(d.getHours()).padStart(2,'0')+':00' : md; }
function compgHoverLabel(ts){ const d=new Date(ts), md=(d.getMonth()+1)+'/'+d.getDate();
  return COMPG._intraday ? md+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0') : md; }
function compgSeries(){
  const A=compgAligned(), axis=A.axis, series=A.series, selP=A.selPresent;
  COMPG._intraday=!!A.intraday; COMPG._span=axis.length?axis[axis.length-1]-axis[0]:0;
  if(axis.length<2||!selP.length) return {axis, lines:[], anchorIdx:0};
  // anchor = first axis point at/after the chosen timestamp (index into the shared grid)
  let aIdx=0; if(COMPG.anchorTs!=null){ while(aIdx<axis.length-1&&axis[aIdx]<COMPG.anchorTs) aIdx++; }
  // rebase each series to 100 at the anchor (or its own first close after it, if it listed later)
  const reb=series.map(s=>{ let bi=aIdx; while(bi<s.length&&s[bi]==null) bi++;
    if(bi>=s.length) return {vals:s.map(()=>null), lateTs:null};
    const base=s[bi]; return {vals:s.map((v,i)=> (i<bi||v==null)?null:(v/base*100)), lateTs:bi>aIdx?axis[bi]:null}; });
  const rebByTk={}; selP.forEach((tk,k)=>{ rebByTk[tk]=reb[k].vals; });
  const colorOf=tk=>compgColor(COMPG.sel.indexOf(tk));   // colour stays keyed to the chip order
  let lines;
  if(COMPG.mode==='index'){
    lines=selP.map((tk,k)=>({tk, color:colorOf(tk), vals:reb[k].vals, lateTs:reb[k].lateTs}));
  } else {
    const vis=new Set(selP.filter(tk=>!COMPG.off.has(tk)));
    let baseVals;
    if(COMPG.base==='__basket'){ baseVals=axis.map((_,i)=>{ let s=0,n=0; for(const tk of vis){ const v=rebByTk[tk]?rebByTk[tk][i]:null; if(v!=null){s+=v;n++;} } return n?s/n:null; }); }
    else baseVals=rebByTk[COMPG.base]||axis.map(()=>null);
    lines=selP.map((tk,k)=>({tk, color:colorOf(tk),
      vals:reb[k].vals.map((v,i)=> (v==null||baseVals[i]==null)?null:(v-baseVals[i])), lateTs:reb[k].lateTs}));
  }
  return {axis, lines, anchorIdx:aIdx};
}
const CG={W:900,H:360,PL:46,PR:56,PT:12,PB:22};
function compgSvg(S){
  const {W,H,PL,PR,PT,PB}=CG, axis=S.axis, vis=S.lines.filter(l=>!COMPG.off.has(l.tk));
  const baseline=COMPG.mode==='index'?100:0;
  let mn=baseline,mx=baseline;
  vis.forEach(l=>l.vals.forEach(v=>{ if(v!=null){ if(v<mn)mn=v; if(v>mx)mx=v; }}));
  if(mn===mx){mn-=1;mx+=1;} const pad=(mx-mn)*0.08; mn-=pad; mx+=pad;
  const n=axis.length, X=i=>PL+(n<2?0:(i/(n-1))*(W-PL-PR)), Y=v=>PT+(1-(v-mn)/(mx-mn))*(H-PT-PB);
  let g='';
  for(let k=0;k<=5;k++){ const v=mn+(mx-mn)*k/5, y=Y(v).toFixed(1);
    g+=`<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`
      +`<text x="${W-PR+5}" y="${(+y+3).toFixed(1)}" fill="var(--faint)" font-size="10">${COMPG.mode==='index'?v.toFixed(0):(v>=0?'+':'')+v.toFixed(1)}</text>`; }
  const yb=Y(baseline).toFixed(1);
  g+=`<line x1="${PL}" y1="${yb}" x2="${W-PR}" y2="${yb}" stroke="var(--faint)" stroke-dasharray="4 3"/>`;
  for(let i=0;i<n;i+=Math.max(1,Math.floor(n/6))){
    g+=`<text x="${X(i).toFixed(1)}" y="${H-6}" fill="var(--faint)" font-size="10" text-anchor="middle">${compgTickLabel(axis[i])}</text>`; }
  const ax=X(S.anchorIdx).toFixed(1);
  g+=`<line id="cg-anchor" x1="${ax}" y1="${PT}" x2="${ax}" y2="${H-PB}" stroke="var(--accent)" stroke-width="1" opacity="0.5"/>`
    +`<rect id="cg-anchorhit" x="${(+ax-6).toFixed(1)}" y="${PT}" width="12" height="${H-PT-PB}" fill="transparent" style="cursor:ew-resize"/>`;
  vis.forEach(l=>{ let d='',st=false; l.vals.forEach((v,i)=>{ if(v==null){st=false;return;} d+=(st?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)+' '; st=true; });
    if(d) g+=`<path d="${d}" fill="none" stroke="${l.color}" stroke-width="1.4"/>`; });
  g+=`<line id="cg-cx" x1="0" y1="${PT}" x2="0" y2="${H-PB}" stroke="var(--muted)" stroke-dasharray="2 2" opacity="0"/><g id="cg-dots"></g>`;
  return {svg:`<svg id="cg-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${g}</svg>`, X, Y};
}
function compgLegend(S){
  const rows=S.lines.map(l=>{ let li=l.vals.length-1; while(li>0&&l.vals[li]==null)li--;
    const last=l.vals[li], chg=COMPG.mode==='index'?(last!=null?last-100:null):last;
    return {tk:l.tk,color:l.color,last,chg,lateTs:l.lateTs}; });
  rows.sort((a,b)=>(b.chg==null?-1e9:b.chg)-(a.chg==null?-1e9:a.chg));
  return rows.map(r=>{ const off=COMPG.off.has(r.tk)?' off':'';
    const late=r.lateTs?` <span class="cg-late" data-tip="listed after the anchor — rebased to its own first close">·${compgHoverLabel(r.lateTs)}</span>`:'';
    const v=r.last==null?'<span class="na">·</span>':(COMPG.mode==='index'
      ? `${r.last.toFixed(1)} <span class="${r.chg>=0?'pos':'neg'}">${r.chg>=0?'+':''}${r.chg.toFixed(1)}%</span>`
      : `<span class="${r.chg>=0?'pos':'neg'}">${r.chg>=0?'+':''}${r.chg.toFixed(1)}pp</span>`);
    const b=basketByName(r.tk);
    return `<div class="cg-lg${off}" data-tk="${esc(r.tk)}"${b?` data-tip="${esc(basketTip(b))}"`:''}><span class="cg-sw" style="background:${r.color}"></span><span class="cg-tk">${b?'<span class="bkg">\u2b12</span>':''}${esc(basketDisplayName(r.tk))}</span>${late}<span class="cg-v">${v}</span></div>`; }).join('');
}
// ===== COMP/G picker: universe-validated typeahead + fill shortcuts =====
// The panel auto-opens on the Corr tab (no launcher button) and re-renders live on every
// add/remove — selection is chips + typeahead, matrix clicks still work as before.
// BTC is the one name allowed across the stocks/crypto wall (build 2026.09.11-75): in stocks
// scope it joins the overlay universe on its daily closes, so "comp NVDA BTC" and "ratio NVDA/BTC"
// answer. Nothing else crosses, and baskets never do.
function compgBtcRow(){ if(state.scope==='crypto') return null; const r=state.rows.get('BTC'); return (r&&!r.delisted&&r.daily&&r.daily.length)?r:null; }
function compgUniverse(){ const base = state.scope==='crypto'
  ? (CORR._bars ? [...CORR._bars.keys()].map(t=>String(t).toUpperCase()) : [])
  : activeRows().map(r=>(r.ticker||'').toUpperCase()).filter(Boolean);
  if(compgBtcRow()&&!base.includes('BTC')) base.push('BTC');
  return base.concat(compgBasketNames()); }
function compgDefaultSel(){ const cr=state.scope==='crypto';
  const rows=(CORR._rows&&CORR._rows.length?CORR._rows:corrScope());
  return [...new Set(rows.map(r=>({t:(r.ticker||'').toUpperCase(),m:Math.abs((cr?corrRet(r):windowRetPct(r,+state.corr.tf))||0)}))
    .sort((a,b)=>b.m-a.m).slice(0,8).map(x=>x.t))].slice(0,8); }
function compgAddName(t){ t=String(t||'').toUpperCase(); if(!t||COMPG.sel.includes(t)||COMPG.sel.length>=8) return false;
  if(!compgUniverse().includes(t)) return false;
  COMPG.sel.push(t); renderCompg(); return true; }
function compgPickerHtml(){ const n=COMPG.sel.length;
  const cap=n>=8?'<span class="cg-cap">max 8 — remove one to add</span>':'';
  return `<div class="cg-pick"><input id="cg-add" placeholder="add name — type to search the ${state.scope==='crypto'?'crypto':'xyz'} universe" autocomplete="off"/><div id="cg-sugg" class="cg-sugg" hidden></div></div>
    <div class="cg-fill"><span class="cg-lbl">fill:</span>
      <button class="cg-pill" id="cg-top8" title="the current matrix set, top 8 by |window return| — the auto-launch default">top 8 movers</button>
      <button class="cg-pill" id="cg-watch" title="your starred names present in this universe (up to 8)">\u2605 watchlist</button>
      <button class="cg-pill" id="cg-clear" title="empty the selection">clear</button>
      <button class="cg-pill" id="cg-ai" title="AI group report on the selected names (2-12 live equities; synthetic baskets excluded) — prose-tier breadth/rotation read, no trade geometry">AI report</button>
      <span class="cg-cnt">${n}/8</span>${cap}</div>`; }
function compgWirePicker(p){
  const inp=el('cg-add'), sg=el('cg-sugg'); if(!inp) return;
  const show=()=>{ const q=inp.value.trim().toUpperCase();
    if(!q){ sg.hidden=true; return; }
    // Baskets group first (⬒-flagged), then plain tickers — a synthetic series is labelled as one
    // even inside the dropdown.
    const bks=compgBasketNames().filter(t=>!COMPG.sel.includes(t)&&(t.startsWith(q)||t.includes(q))).slice(0,4);
    const uni=compgUniverse().filter(t=>!COMPG.sel.includes(t)&&!isBasketName(t));
    const m=[...uni.filter(t=>t.startsWith(q)),...uni.filter(t=>!t.startsWith(q)&&t.includes(q))].slice(0,6-Math.min(2,bks.length));
    if(!m.length&&!bks.length){ sg.innerHTML='<div class="cg-sg-none">no match in the live universe</div>'; sg.hidden=false; return; }
    sg.innerHTML=bks.map(t=>{ const b=basketByName(t); const tag=b&&b.shadow?(b.kind==='industry'?'industry':'sector'):(b&&b.builtin?'built-in':'basket');
        const nm=b&&b.label?`${esc(b.label)} <span class="sec" style="font-size:var(--fs-2xs)">${esc(t)}</span>`:esc(t);
        return `<div class="cg-sg bk" data-t="${esc(t)}"><span class="bkg">\u2b12</span> ${nm} <span class="cg-sg-r">${tag}</span></div>`; }).join('')
      + m.map(t=>`<div class="cg-sg" data-t="${esc(t)}">${esc(t)}</div>`).join(''); sg.hidden=false;
    sg.querySelectorAll('.cg-sg').forEach(x=>x.onclick=()=>{ if(compgAddName(x.dataset.t)){ const ni=el('cg-add'); if(ni){ ni.focus(); } } }); };
  inp.oninput=show;
  inp.onkeydown=e=>{
    if(e.key==='Escape'){ sg.hidden=true; return; }
    if(e.key!=='Enter') return;
    const q=inp.value.trim().toUpperCase(); if(!q) return;
    const uni=compgUniverse().filter(t=>!COMPG.sel.includes(t));
    // Resolve a typed basket LABEL to its token too, so "semiconductor" adds the SEMICONDUCTO
    // shadow even though the visible universe key is the truncated token.
    const nq=q.replace(/[^A-Z0-9]/g,''), strip=s=>s.replace(/S$/,'');
    const byLabel=()=>{ for(const b of basketScopeList()){ if(!b.label) continue; const nl=b.label.toUpperCase().replace(/[^A-Z0-9]/g,'');
      if(nl===nq||strip(nl)===strip(nq)||((nl.startsWith(nq)||nq.startsWith(nl))&&Math.min(nl.length,nq.length)>=5)) return b.name; } return null; };
    const m=uni.find(t=>t===q)||uni.find(t=>t.startsWith(q))||byLabel();
    if(m&&compgAddName(m)){ const ni=el('cg-add'); if(ni) ni.focus(); } };
  const t8=el('cg-top8'); if(t8) t8.onclick=()=>{ COMPG.sel=compgDefaultSel(); COMPG.off=new Set(); COMPG.base='__basket'; renderCompg(); };
  const w=el('cg-watch'); if(w) w.onclick=()=>{ const uni=new Set(compgUniverse());
    const sel=[]; for(const c of state.watch){ const r=state.rows.get(c); const tk=r?String(r.ticker||r.coin||'').toUpperCase():String(c).toUpperCase();
      if(uni.has(tk)&&!sel.includes(tk)) sel.push(tk); if(sel.length>=8) break; }
    COMPG.sel=sel; COMPG.off=new Set(); COMPG.base='__basket'; renderCompg(); };
  const cl=el('cg-clear'); if(cl) cl.onclick=()=>{ COMPG.sel=[]; COMPG.off=new Set(); COMPG.base='__basket'; renderCompg(); };
  const ab=el('cg-ai'); if(ab) ab.onclick=()=>{
    // Live single-name equities only: synthetic baskets have no server-side rows, crypto is out for v1.
    const ts=COMPG.sel.filter(t=>!isBasketName(t)).map(t=>String(t).toUpperCase())
      .filter(t=>{ for(const r of state.rows.values()) if((r.ticker||'').toUpperCase()===t&&r.uni!=='main') return true; return false; });
    if(ts.length<2) return pushToast('Pick at least 2 live equities for a basket report (crypto and synthetic baskets are excluded for now)');
    if(ts.length>12) return pushToast('Basket reports cap at 12 names — trim the selection');
    openAiReport('grp:bkt:'+[...new Set(ts)].sort().join('+')); };
}
// Auto-launch: called whenever the Corr tab paints (view switch or scope flip). First visit
// seeds the default set via openCompg (which self-defers on crypto until the matrix's intraday
// series is ready); later visits keep whatever selection you built. A closed panel stays
// closed for the session; the terminal comp verb reopens it.
function compgAuto(){ if(COMPG.closed) return;
  const present=COMPG.sel.filter(t=>compgUniverse().includes(t));
  if(present.length>=2){ const pp=el('compg'); if(pp){ pp.hidden=false; renderCompg(); } }
  else openCompg();
}
function openCompg(tickers){
  const cr=state.scope==='crypto';
  if(cr && !(CORR._intraday && CORR._bars && CORR._times)){
    // COMP/G rides on the correlation matrix's intraday series — build it first, then retry.
    const want=state.corr.ctf||'1d'; if(typeof renderCorr==='function') renderCorr();
    let tries=0; const wait=()=>{ if(state.scope!=='crypto') return;
      if(CORR._intraday && CORR._bars && CORR._win===want){ openCompg(tickers); }
      else if(tries++<50){ setTimeout(wait,100); } };
    const p0=el('compg'); if(p0){ p0.hidden=false; p0.innerHTML='<div class="cp-head">COMP/G <span class="sec" style="font-weight:400">— building '+esc(want)+' intraday series…</span></div>'; }
    setTimeout(wait,120); return;
  }
  const uni = new Set((cr ? [...CORR._bars.keys()].map(t=>String(t).toUpperCase())
                          : activeRows().map(r=>(r.ticker||'').toUpperCase())).concat(compgBasketNames()));
  let sel=(tickers&&tickers.length?tickers.map(t=>String(t).toUpperCase()):[]).filter(t=>uni.has(t));
  if(!sel.length) sel=compgDefaultSel();   // default: the current matrix set, top 8 by |window return|
  sel=[...new Set(sel)].slice(0,8);
  COMPG.closed=false;
  COMPG.sel=sel; COMPG.off=new Set(); COMPG.mode='index'; COMPG.base='__basket';
  COMPG.win = cr ? (state.corr.ctf||'1d') : +state.corr.tf;
  COMPG.anchorTs = cr ? (CORR._times.length?CORR._times[0]:null)
                      : (Math.floor(Date.now()/DAY)-(+state.corr.tf))*DAY;   // rebase from the window start
  const p=el('compg'); if(p){ p.hidden=false; renderCompg(); p.scrollIntoView({behavior:SCROLL_B,block:'nearest'}); }
}
// One chip template for both COMP/G branches. Basket anatomy — dashed border + ⬒ glyph + the
// disclosure tooltip — exists so a synthetic series can never be mistaken for a listed name.
function compgChipHtml(t,i){ const b=basketByName(t);
  return `<span class="cg-chip${COMPG.off.has(t)?' off':''}${b?' bk':''}" data-tk="${esc(t)}"${b?` data-tip="${esc(basketTip(b))}"`:''}><span class="cg-sw" style="background:${compgColor(i)}"></span>${b?'<span class="bkg">\u2b12</span>':''}${esc(basketDisplayName(t))}<span class="cg-x" data-x="${esc(t)}">✕</span></span>`; }
function renderCompg(){
  const p=el('compg'); if(!p) return;
  if(COMPG.sel.length<2){ p.hidden=false;
    const chips=COMPG.sel.map(compgChipHtml).join('');
    p.innerHTML=`<div class="cp-head">COMP/G <span class="sec" style="font-weight:400">— normalized comparison</span> <button class="btn xtiny" id="cg-close" title="close for this session" style="float:right">✕</button></div>
      <div class="cg-ctrls"><div class="cg-chips">${chips}</div>${compgPickerHtml()}</div>
      <div class="sec" style="margin-top:6px">Add at least two names — type above, use the fill buttons, or click tickers in the matrix. Terminal: <span class="amber">comp NVDA AAPL MSFT</span>.</div>`;
    const c=el('cg-close'); if(c) c.onclick=()=>{ p.hidden=true; COMPG.closed=true; };
    p.querySelectorAll('.cg-chip .cg-x').forEach(x=>x.onclick=()=>{ COMPG.sel=COMPG.sel.filter(t=>t!==x.dataset.x); renderCompg(); });
    compgWirePicker(p); return; }
  const S=compgSeries();
  // -07: an empty axis means the selection has NO loaded history yet (a corr-tab visit racing
  // /api/daily). The old path painted a lineless chart with a NaN anchor label — a broken-looking
  // panel that never healed and read as "comparison removed". Say what's happening instead; the
  // daily-arrival hook repaints this panel out of the empty state the moment data lands.
  COMPG._empty=!S.axis.length;
  if(COMPG._empty){ p.hidden=false;
    const chipsE=COMPG.sel.map(compgChipHtml).join('');
    const rowsE=COMPG.sel.map(compgRowFor), haveE=rowsE.filter(r=>r&&Array.isArray(r.daily)&&r.daily.length).length;
    p.innerHTML=`<div class="cp-head">COMP/G <span class="sec" style="font-weight:400">— ${COMPG.sel.length} names · waiting for history</span>
        <button class="btn xtiny" id="cg-close" title="close for this session" style="float:right">✕</button></div>
      <div class="cg-ctrls"><div class="cg-chips">${chipsE}</div>${compgPickerHtml()}</div>
      <div class="sec" style="margin-top:6px">Loading ${COMPG._intraday?'intraday':'daily'} history — ${haveE}/${COMPG.sel.length} selected names have series so far. The chart draws itself the moment the data lands; nothing to click. If this line never advances, the ${COMPG._intraday?'archive':'/api/daily feed'} isn't reaching this page.</div>`;
    const c0=el('cg-close'); if(c0) c0.onclick=()=>{ p.hidden=true; COMPG.closed=true; };
    p.querySelectorAll('.cg-chip .cg-x').forEach(x=>x.onclick=()=>{ COMPG.sel=COMPG.sel.filter(t=>t!==x.dataset.x); renderCompg(); });
    compgWirePicker(p); return; }
  const {svg,X,Y}=compgSvg(S);
  const chips=COMPG.sel.map(compgChipHtml).join('');
  const cr=COMPG._intraday, ax=S.axis;
  let anchorCtl;
  if(cr){
    const cpick=(ts,lbl)=>{ const on=(COMPG.anchorTs!=null&&Math.abs(COMPG.anchorTs-ts)<1)?' on':''; return `<button class="cg-pill${on}" data-cgts="${ts}">${lbl}</button>`; };
    anchorCtl = ax.length>=2
      ? `<span class="cg-lbl">rebase</span>${cpick(ax[0],'start')}${cpick(ax[Math.floor((ax.length-1)/2)],'mid')}${cpick(ax[Math.max(0,ax.length-2)],'recent')}<span class="cg-lbl">or drag the amber line</span>`
      : `<span class="cg-lbl">rebase — drag the amber line</span>`;
  } else {
    const anchISO=new Date((COMPG.anchorTs!=null?COMPG.anchorTs:Date.now())).toISOString().slice(0,10);
    const minISO=new Date((Math.floor(Date.now()/DAY)-365)*DAY).toISOString().slice(0,10);
    const maxISO=new Date(Math.floor(Date.now()/DAY)*DAY).toISOString().slice(0,10);
    const presets=[[30,'30d'],[60,'60d'],[90,'90d'],[COMPG.win,'full']].map(([d,l])=>{
      const ts=(Math.floor(Date.now()/DAY)-d)*DAY, on=Math.abs((COMPG.anchorTs||0)-ts)<DAY?' on':'';
      return `<button class="cg-pill${on}" data-cgd="${d}">${l}</button>`; }).join('');
    anchorCtl=`<span class="cg-lbl">rebase</span>${presets}<input type="date" id="cg-date" value="${anchISO}" min="${minISO}" max="${maxISO}"/><span class="cg-lbl">or drag the amber line</span>`;
  }
  const baseOpts=`<option value="__basket">equal-wt basket</option>`+COMPG.sel.map(t=>`<option value="${esc(t)}"${COMPG.base===t?' selected':''}>${esc(t)}</option>`).join('');
  p.hidden=false;
  p.innerHTML=`
    <div class="cp-head">COMP/G <span class="sec" style="font-weight:400">— ${COMPG.sel.length} names · rebased to 100 · ${tfLabel()} window</span>
      <button class="btn xtiny" id="cg-close" title="close" style="float:right">✕</button>
      <span class="seg cg-seg" id="cg-mode" style="float:right;margin-right:8px">
        <button data-cgm="index"${COMPG.mode==='index'?' class="on"':''}>Index =100</button>
        <button data-cgm="spread"${COMPG.mode==='spread'?' class="on"':''}>Spread</button></span></div>
    <div class="cg-ctrls">
      <div class="cg-chips">${chips}</div>
      ${compgPickerHtml()}
      <div class="cg-anchorctl">${anchorCtl}</div>
      <div class="cg-basectl"${COMPG.mode==='spread'?'':' hidden'}><span class="cg-lbl">vs</span><select id="cg-base">${baseOpts}</select></div>
    </div>
    <div class="cg-chartwrap">${svg}<div class="cg-read" id="cg-read"></div></div>
    <div class="cg-legend">${compgLegend(S)}</div>
    <div class="cg-foot">${COMPG.mode==='index'
      ? `Each name rebased to 100 at the anchor (${compgHoverLabel(COMPG.anchorTs)}). Above 100 = outperformed since; below = lagged. A name listed after the anchor starts at its own first close (dated in the legend).`
      : `Each name minus ${COMPG.base==='__basket'?'the equal-weight basket of visible names':esc(COMPG.base)}, in percentage points. Zero = moving with the ${COMPG.base==='__basket'?'group':'base'}; positive = leading it.`}</div>`;
  // wire
  el('cg-close').onclick=()=>{ p.hidden=true; COMPG.closed=true; };
  compgWirePicker(p);
  p.querySelectorAll('#cg-mode button').forEach(b=>b.onclick=()=>{ COMPG.mode=b.dataset.cgm; renderCompg(); });
  p.querySelectorAll('[data-cgd]').forEach(b=>b.onclick=()=>{ COMPG.anchorTs=(Math.floor(Date.now()/DAY)-(+b.dataset.cgd))*DAY; renderCompg(); });
  p.querySelectorAll('[data-cgts]').forEach(b=>b.onclick=()=>{ COMPG.anchorTs=+b.dataset.cgts; renderCompg(); });
  const dt=el('cg-date'); if(dt) dt.onchange=()=>{ const t=new Date(dt.value+'T00:00:00Z').getTime(); if(isFinite(t)){ COMPG.anchorTs=t; renderCompg(); } };
  const bs=el('cg-base'); if(bs) bs.onchange=()=>{ COMPG.base=bs.value; renderCompg(); };
  p.querySelectorAll('.cg-chip').forEach(c=>c.onclick=e=>{ const t=c.dataset.tk;
    if(e.target.dataset.x){ COMPG.sel=COMPG.sel.filter(x=>x!==t); COMPG.off.delete(t); if(COMPG.base===t)COMPG.base='__basket'; renderCompg(); return; }
    if(COMPG.off.has(t))COMPG.off.delete(t); else COMPG.off.add(t); renderCompg(); });
  p.querySelectorAll('.cg-lg').forEach(l=>l.onclick=()=>{ const t=l.dataset.tk; if(COMPG.off.has(t))COMPG.off.delete(t); else COMPG.off.add(t); renderCompg(); });
  compgWireChart(S,X,Y);
}
function compgWireChart(S,X,Y){
  const svg=el('cg-chart'), read=el('cg-read'), cx=el('cg-cx'), dots=el('cg-dots'); if(!svg) return;
  const {W,PL,PR,PT,PB,H}=CG, n=S.axis.length, vis=S.lines.filter(l=>!COMPG.off.has(l.tk));
  const idxAt=e=>{ const r=svg.getBoundingClientRect(); const xv=(e.clientX-r.left)/r.width*W;
    let i=Math.round((xv-PL)/(W-PL-PR)*(n-1)); return Math.max(0,Math.min(n-1,i)); };
  const hit=el('cg-anchorhit'); if(hit) hit.addEventListener('mousedown',()=>{COMPG._drag=true;});
  if(!COMPG._dragBound){ COMPG._dragBound=true; window.addEventListener('mouseup',()=>{COMPG._drag=false;}); }
  svg.addEventListener('mousemove',e=>{
    if(COMPG._drag){ const i=idxAt(e); COMPG.anchorTs=S.axis[i]; renderCompg(); return; }
    const i=idxAt(e), x=X(i); cx.setAttribute('x1',x); cx.setAttribute('x2',x); cx.setAttribute('opacity','0.7');
    let d='',rows=[]; vis.forEach(l=>{ const v=l.vals[i]; if(v==null)return;
      d+=`<circle cx="${x.toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2.6" fill="${l.color}"/>`; rows.push({tk:l.tk,color:l.color,v}); });
    dots.innerHTML=d; rows.sort((a,b)=>b.v-a.v);
    read.innerHTML=`<div class="cg-rdate">${compgHoverLabel(S.axis[i])}</div>`+rows.map(r=>`<div class="cg-rd"><span><span style="color:${r.color}">■</span> ${esc(r.tk)}</span><span>${COMPG.mode==='index'?r.v.toFixed(1):(r.v>=0?'+':'')+r.v.toFixed(1)}</span></div>`).join('');
    read.style.display='block'; const rr=svg.getBoundingClientRect(), px=(x/W)*rr.width;
    read.style.left=(px>rr.width-170?px-160:px+12)+'px';
  });
  svg.addEventListener('mouseleave',()=>{ if(COMPG._drag)return; cx.setAttribute('opacity','0'); dots.innerHTML=''; read.style.display='none'; });
}

// ===== CSV export =====
function downloadCSV(name, matrix){
  const csv=matrix.map(row=>row.map(c=>{ const s=(c==null)?'':String(c); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }).join(',')).join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}), url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
  usageAct('csv');   // (build 2026.09.24-110) the usage counter: that an export happened, never what it held
  usageCtl(state.view+'.csv');   // (build 2026.09.24-112) and which tab's CSV button (sitewide; a tab outside the allowlist is ignored)
}
function csvCell(k,r){ switch(k){
  case 'ticker': return r.ticker; case 'px': return r.px;
  case 'funding': return r.funding!=null?(r.funding*24*365*100).toFixed(4):'';
  case 'h1':return r.h1; case 'h4':return r.h4; case 'd1':return r.d1; case 'd7':return r.d7; case 'd30':return r.d30;
  case 'gap': return r.gap!=null&&isFinite(r.gap)?r.gap.toFixed(3):'';
  case 'prem': return r.prem!=null&&isFinite(r.prem)?r.prem.toFixed(2):'';
  case 'sqz': return r.sqz!==undefined?r.sqz:'';
  case 'carry': return r.carry!=null&&isFinite(r.carry)?r.carry.toFixed(3):'';
  case 'rs': return r.rs; case 'mom': return r.mom!=null?Math.round(r.mom):'';
  case 'vol30': return r.vol30!=null&&isFinite(r.vol30)?r.vol30.toFixed(1):'';
  case 'adr': return r.adr!=null&&isFinite(r.adr)?r.adr.toFixed(3):'';
  case 'beta': return r.beta!=null&&isFinite(r.beta)?r.beta.toFixed(3):'';
  case 'doi': return r.doi!=null?r.doi.toFixed(2):'';
  case 'vwap': return r.vwap30!=null&&isFinite(r.vwap30)?r.vwap30:'';
  case 'vsvwap': return r.vsvwap!=null&&isFinite(r.vsvwap)?r.vsvwap.toFixed(3):'';
  case 'vol': return r.vol; case 'oi': return r.oi; default: return ''; } }
function exportMarkets(){
  if(mktGrp()!=='names'){   // the lens exports exactly what's on screen: same groups, same sort, same weighting
    const list=groupRowsSorted(), n2=v=>(v!=null&&isFinite(v))?v.toFixed(2):'';
    const head=['Group','Type','Members','Dopen%','1h%','4h%','24h%','7d%','30d%','Mopen%','Yopen%','Breadth%','DeltaOI%','RVOL','Vol24h','OI','Cohesion','Best','Best24h%','Worst','Worst24h%'];
    const body=list.map(g=>[g.name,g.assetClass,g.n,n2(g.agg.dopen.v),n2(g.agg.h1.v),n2(g.agg.h4.v),n2(g.agg.d1.v),n2(g.agg.d7.v),n2(g.agg.d30.v),n2(g.agg.mopen.v),n2(g.agg.yopen.v),
      g.brN?Math.round(100*g.brUp/g.brN):'',n2(g.agg.doi.v),n2(g.agg.rvol.v),g.totVol?Math.round(g.totVol):'',g.totOI?Math.round(g.totOI):'',
      g.cohesion!=null?g.cohesion.toFixed(3):'',g.best?g.best.t:'',g.best?n2(g.best.v):'',g.worst?g.worst.t:'',g.worst?n2(g.worst.v):'']);
    downloadCSV(`xyz-markets-${mktGrp()}.csv`,[head,...body]); return; }
  const cols=visibleCols(); const head=cols.map(c=>c.label.replace(/&amp;/g,'&'));
  const body=sortedRows().map(r=>cols.map(c=>csvCell(c.key,r))); downloadCSV('xyz-markets.csv',[head,...body]); }
function exportCorr(){ const rows=CORR._rows, C=CORR._C, ord=CORR._ord; if(!rows||!C||!ord){ return; }
  const head=['',...ord.map(i=>rows[i].ticker)];
  const body=ord.map(ri=>[rows[ri].ticker, ...ord.map(ci=>{ const v=C[ri][ci]; return v==null?'':v.toFixed(4); })]);
  downloadCSV(`xyz-correlation-${tfLabel()}.csv`,[head,...body]); }
export { BASKETS, COMPG, RATIO, basketByName, basketMutate, basketScopeList, basketVirtualRow, buildCorr, compgAuto, computeDvb, corrCI, corrColor, dailyFunding, dailyLevels, dailyOI, dailyReturns, downloadCSV, dvbBasketDef, dvbCell, dvbPickOpts, exportCorr, exportMarkets, isBasketName, loadBaskets, openCompg, openCorr, openRatio, overnightReturns, pearson, ratioImageSvg, renderCompg, renderCorr, renderCorrPairs, sessReturns, sparkline, syncCorrLookback, tfLabel };
