// core.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).


export function __boot_core_1() {
// ONE Escape handler for every modal layer. Each layer used to own a document listener, so one
// keypress fell through them all: the palette closed AND the drawer under it. The stack closes only
// the top layer and marks the event consumed (preventDefault) so the other document-level key
// handlers (j/k ring, DM levels) leave the rest alone.
document.addEventListener('keydown',e=>{ if(e.key!=='Escape'||e.defaultPrevented||!_overlays.length) return; e.preventDefault(); overlayCloseTop(); });
}
const G = {};   // shared mutable state written from more than one module (ES module bindings are read-only for importers)
// ===== overlay stack =====
// Every layer that sits over the page (drawer, help, palette, trend chart, fund modal, DM search)
// registers on open and unregisters on close; re-pushing an open id moves it to the top.
const _overlays=[];
function overlayPush(id, close){ overlayPop(id); _overlays.push({id, close}); }
function overlayPop(id){ const i=_overlays.findIndex(o=>o.id===id); if(i>=0) _overlays.splice(i,1); }
function overlayTop(){ return _overlays.length?_overlays[_overlays.length-1].id:null; }
function overlayCloseTop(){ const o=_overlays[_overlays.length-1]; if(!o) return false; overlayPop(o.id); try{ o.close(); }catch(_){} return true; }
// A view change dismisses every layer, top-down — a drawer over the wrong tab is the bug this exists for.
function overlayCloseAll(){ while(_overlays.length) overlayCloseTop(); }
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
const LKEY = 'xyzmon.layouts.v1';
function maCell(r,key,nD){ const v=r[key];
  if(v==null||!isFinite(v)) return `<td><span class="na" title="needs ${nD} daily closes \u2014 ${r.uni==='main'&&nD>20?'crypto retention is 31d, so this MA is out of reach by design':'fills in as daily history loads'}">\u2014</span></td>`;
  const above=r.px!=null&&isFinite(r.px)?r.px>=v:null, d=above!=null&&v>0?((r.px/v-1)*100):null;
  return `<td class="${above==null?'sec':(above?'pos':'neg')}" title="SMA${nD} ${fmtPrice(v)}${d!=null?` \u00b7 price ${d>=0?'+':''}${d.toFixed(1)}% ${d>=0?'above':'below'}`:''}">${fmtPrice(v)}</td>`; }
function vwapCell(r){ const v=r.vwap30;
  if(v==null||!isFinite(v)) return '<td><span class="na" title="fills in once hourly history loads (\u226410 min after deploy)">\u2014</span></td>';
  const above=r.px!=null&&isFinite(r.px)?r.px>=v:null, d=above!=null?((r.px/v-1)*100):null;
  return `<td class="${above==null?'sec':(above?'pos':'neg')}" title="30d rolling VWAP ${fmtPrice(v)}${d!=null?` \u00b7 price ${d>=0?'+':''}${d.toFixed(1)}% ${d>=0?'above':'below'}`:''}">${fmtPrice(v)}</td>`; }
function turnCell(r){ if(r.turn==null||!isFinite(r.turn)) return '<td><span class="na">\u2014</span></td>';
  const c=r.turn>=2?'accent':(r.turn<0.5?'sec':'');
  return `<td${c?` class="${c}"`:''} title="OI ${fmtUsd(r.oi)} \u00f7 24h vol ${fmtUsd(r.vol)} \u2014 positioning is ${r.turn.toFixed(1)}\u00d7 the daily flow">\u00d7${r.turn>=10?r.turn.toFixed(0):r.turn.toFixed(1)}</td>`; }
function liq24Cell(r){ if(r.uni!=='main') return '<td><span class="na">\u2014</span></td>';
  if(r.liq24==null||!isFinite(r.liq24)) return '<td><span class="na" title="no aggregated CEX liq data yet for this name \u00b7 accumulating (Coinalyze), or no CEX perp mapped \u2014 disclosed gap, never a zero">\u2014</span></td>';
  const L=r.liqL24||0,S=r.liqS24||0,tot=r.liq24;
  const lp=tot>0?Math.round(100*L/tot):0;
  const sk=tot>0?(lp>=67?'neg':(lp<=33?'pos':'')):'';
  return `<td class="${sk||'sec'}" title="24h forced liquidations ${fmtUsd(tot)} \u00b7 longs ${fmtUsd(L)} (${lp}%) / shorts ${fmtUsd(S)} (${100-lp}%)${lp>=67?' \u2014 long-side flush':(lp<=33?' \u2014 short-side squeeze':'')} \u00b7 aggregated CEX (Coinalyze), USD source-converted \u2014 context, not HL-native">${fmtUsd(tot)}</td>`; }
const COL_BY_KEY={};
// Default table layout (order + which columns show). Hidden by default: beta, Vol(ann), ΔOI, Squeeze, Carry, OI.
const DEFAULT_ORDER=['ticker','sess','px','m5','m15','h1','h4','d1','dopen','hopen','h4open','h12open','d7','d30','gap','rs','vstape','momp','vol','funding','rvol','adr','turn','vwap','prem','trend','dvb','dcap','hitr','mom','dd','swr','ddy','yopen','mopen','beta','vol30','doi','sqz','cascT','liq24','carry','oi','pos','ma20','ma50','ma100','ma200','vsvwap'];
const DEFAULT_HIDDEN=['m5','m15','hopen','h4open','h12open','prem','trend','dvb','dcap','hitr','beta','mom','vol30','dd','swr','ddy','yopen','mopen','doi','sqz','cascT','liq24','carry','oi','pos','ma20','ma50','ma100','ma200','vsvwap'];
const LAYOUT_V=5; // bump to force a one-time reset of saved layouts to the new default (v5: sess home-market chip column after ticker)

const state={ rows:new Map(), order:[], mainOrder:[], scope:(()=>{try{return localStorage.getItem('xyz-scope')==='crypto'?'crypto':'stocks';}catch(_){return 'stocks';}})(), sortKey:'vol', sortDir:'desc', filter:'', tf:'1d', refreshMs:30000, benchCoin:null, benchMain:null, dvbBasket:'MAG7',
  // Markets group lens: 'names' = the classic per-market table; 'sectors'/'industries' aggregate
  // it in place. grpSort is the lens's own sort (the names sort must survive a round trip);
  // grpDrill is the transient member filter a group-row click leaves behind — never persisted.
  grp:'names', grpWt:'vol', grpSort:{key:'d1',dir:'desc'}, grpDrill:null,
  pos:new Map(), posOnly:false, posMeta:null,   // positions overlay (build 2026.09.16-79): coin -> held position, the ⬡ held filter, the last /api/positions envelope
  actOpen:true,   // action lists under the markets table: OPEN by default (-03), collapse persisted
  filters:{volMin:null,volMax:null,oiMin:null,oiMax:null}, corr:{tf:'30', ctf:'1d', topN:40, selected:null, search:'', topPairs:10, pair:null, showBuiltins:false},
  colOrder:[...DEFAULT_ORDER], colHidden:new Set(DEFAULT_HIDDEN),
  sect:{ wt:'vol', sel:null, mode:'flow', corrTf:'30', grp:'sector' }, dataTs:0, connOk:true, view:'markets', prevView:null, regimeSrv:null,
  backtest:{ signal:'mom', lookback:20, cadence:5, quantile:0.2, cost:5, universe:'all', split:0.6,
    direction:'high', structure:'ls', weighting:'eq', reqSign:false, holdWindow:'cc', vsBasket:'',
    picks:[], entry:0 },   // picks: explicitly targeted coins — one = single-asset timing test, several = a custom universe. entry: the σ threshold that replaces the book quantile on one name.
  duel:{ data:null, at:0, pending:false },   // score-duel record (/api/duel), 60s client memo
  watch:new Set(), watchOnly:false, detail:null,
  notes:null, notesRev:0, noteOnly:false, noteTag:null, noteQ:'',   // written notes: the book from /api/notes, the ★-only-style row filter, and the Notes tab's own filters
  homeMkts:null, homeState:null,   // home-session defs + live per-market state — server-computed, client renders only
  dimOff:(()=>{try{return localStorage.getItem('xyz-dimoff')==='1';}catch(_){return false;}})(),   // variant A: dim foreign-home rows while their exchange sleeps
  report:{ coin:null, data:null, list:null, gen:false, tick:null, tf:'1d' },   // AI analyst report tab
  housing:null, housingWin:'5y', liq:null, liqWin:'5y',   // Housing tab: the /api/housing board and the chart window
  earn:null, earnPayload:null,   // earnings calendar: ticker -> upcoming entries, and the raw /api/earnings payload
  layouts:{ list:{}, active:null },
  analytics:{ data:null, err:null, ts:0, regime:{ sel:'all' }, clock:{ sel:'all', metric:'vol' }, overlay:{ metric:'vol' }, dow:{ sel:'all', metric:'vol' }, season:{ sel:'all' },
    // funding heatmap. `unit` is how a cell is READ (build 2026.09.16-77): 'apr' annualizes every
    // cell (hourly ×24×365, the convention the whole site quotes funding in) and the timeframe is
    // then a resolution; 'bucket' is the funding a 1× long paid over the bucket, and the timeframe
    // is the quantity. Remembered per browser like the dim-off switch; annualized on a fresh one.
    fheat:{ tf:'8h', sort:'oi', rows:'25', unit:(()=>{try{return localStorage.getItem('xyz-fh-unit')==='bucket'?'bucket':'apr';}catch(_){return 'apr';}})() } },
  // FUNDING tab (build 2026.08.26-34) — its own board on /api/funding. Two slots so a scope flip
  // mid-flight can never paint a crypto grid into a stocks view; `view` is whichever matches.
  // err and ts live INSIDE each slot: held globally, one universe's failure and freshness stamp
  // would be shown under the other, which is the bug the sessions tab's two slots already avoid.
  funding:{ stocks:{data:null,err:null,ts:0}, crypto:{data:null,err:null,ts:0}, view:null },
  alerts:{ rules:[], log:[], unseen:0, notify:false,
    // feed = the server's own recent event list, re-read on every pull. This is the log now: it
    // survives a refresh and a closed laptop, because the events live in the poller's persisted
    // ring rather than in this tab's memory. `log` is what remains local — the in-tab metric
    // rules, which still evaluate here until their server-side replacement lands.
    feed:[], seenSeq:0, alertVer:null,
    // clearedSeq hides everything up to a point for THIS browser. The ring is the record and a
    // client has no business deleting from it, so "clear" is a view watermark, and the panel says
    // so rather than implying the history is gone.
    clearedSeq:0,
    // Collapsed sections, persisted. The panel had grown to four stacked blocks and a wall of log
    // rows; everything below is still one click away, it just is not all shouting at once.
    open:{ trig:false, rules:false, deliv:true, recent:true }, openRec:{},
    // Trigger alerts are NOT user-authored rules — they're a standing subscription to "any new
    // setup passing these filters", so they sit alongside A.rules rather than inside it.
    // No provenOnly here: the server's stream now carries only CONFIRMED setups, so the filter
    // would be a no-op that implies unconfirmed alerts are possible. minRR tracks the board's gate.
    trig:{ on:false, minEV:0.30, maxLate:0.50, minRR:2.0, cls:['rr','ev'], muted:[] } } };

function el(id){ return document.getElementById(id); }
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
// Smooth scrolling honours the OS motion preference (the CSS query cannot reach a JS scrollIntoView).
const SCROLL_B=(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches)?'auto':'smooth';
// new Date(null-ish).toISOString() throws RangeError and aborts the renderer that called it.
function isoUtc(ts,a,b){ return Number.isFinite(+ts)?new Date(+ts).toISOString().slice(a,b).replace('T',' '):'—'; }
// href values are escaped everywhere, but esc() cannot refuse a javascript: scheme. One gate.
function safeHref(u){ u=String(u==null?'':u); return /^https?:\/\//i.test(u)?u:''; }
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
  // One convention across the table, the sessions clock and the Funding heatmap: positive = longs
  // PAY (crowded long, carry is a cost) = red; negative = longs receive = green. The table used to
  // paint the same number the other way round.
  return {t:(apr>0?'+':'')+apr.toFixed(2)+'%', c:f>0?'neg':(f<0?'pos':'sec'), title:`${(f*100).toFixed(4)}% / hour · annualized ×24×365. Positive = longs pay shorts (red, crowded long); negative = longs receive (green).`}; }
function fmtUsd(x){ if(x==null||!isFinite(x))return '—'; const a=Math.abs(x);
  if(a>=1e9)return '$'+nf(x/1e9,2)+'B'; if(a>=1e6)return '$'+nf(x/1e6,2)+'M'; if(a>=1e3)return '$'+nf(x/1e3,1)+'K'; return '$'+nf(x,0); }
function lerp(a,b,t){ return Math.round(a+(b-a)*t); }
function momColor(m){ if(m==null||!isFinite(m))return 'var(--faint)';
  const t=clamp(Math.abs(m)/100,0,1), mut=[126,135,148], tg=m>=0?[70,185,126]:[229,96,77];
  return `rgb(${lerp(mut[0],tg[0],t)},${lerp(mut[1],tg[1],t)},${lerp(mut[2],tg[2],t)})`; }

// ===== live "now" against an open claim (build 2026.07.27-29) =====
// Three numbers a claim view has to state and until -29 did not: the price it fired at, the
// price right now, and which way that is for THIS claim. The live mark is read from the
// client's own streaming snapshot (state.rows) — never shipped in the cached ledger payload,
// so the ETag economy and the 15s tick are untouched, and the number cannot disagree with the
// screener because it IS the screener's number. Delta is signed WITH the claim: a short whose
// price is falling reads GREEN, because the chip answers "is this claim currently winning",
// not "is the chart up". A missing mark, a missing fire price, or a settled claim renders a
// dash with a hover saying which — never a stale price, never a fabricated one.
function liveMark(coin){ const r=coin?state.rows.get(coin):null;
  return r&&!r.delisted&&r.px!=null&&isFinite(r.px)?+r.px:null; }
// Signed % move from the claim's own mark, in the claim's own direction.
function claimDelta(side,mark,px){
  if(mark==null||!isFinite(mark)||mark<=0||px==null||!isFinite(px)) return null;
  return (side==='short'?-1:1)*(px/mark-1)*100;
}
// Micro bracket bar: how much of the FROZEN bracket price has travelled, and toward which
// level. Only for claims that froze both — a convention with no target has nothing to measure
// travel against, and inventing a scale there would be exactly the false precision this app
// refuses. Returns null when the geometry isn't there.
function brkBar(side,mark,px,stp,tgt){
  if(mark==null||px==null||stp==null||tgt==null) return null;
  if(!(isFinite(mark)&&isFinite(px)&&isFinite(stp)&&isFinite(tgt))) return null;
  const toT=tgt-mark, toS=stp-mark;
  if(!(toT!==0&&toS!==0)) return null;
  const mv=px-mark;
  // fraction of the way toward whichever level the move points at, clamped at the level itself
  const frac=clamp(Math.abs(mv)/Math.abs((mv>0)===(toT>0)?toT:toS),0,1);
  const towardT=(mv>0)===(toT>0);
  const w=(frac*50).toFixed(1);
  return {frac, towardT,
    html:`<span class="nowbrk"><i class="${towardT?'tgt':'stp'}" style="${towardT?'left:50%':'right:50%'};width:${w}%"></i><span class="z"></span></span>`};
}

// ===== row helpers =====
function recomputeChanges(r){ const cur=r.px; if(cur==null)return;
  // 5m/15m read the server's ring references (p5m/p15m on the row), not the hourly-spine ref —
  // they exist before the spine warms and null out independently (deploy warm-up / feed gap).
  r.m5=r.p5m>0?(cur-r.p5m)/r.p5m*100:null; r.m15=r.p15m>0?(cur-r.p15m)/r.p15m*100:null;
  // Anchored intraday opens: % derived from the shipped LEVEL against the live mark — the exact
  // math dopenCell/openCell restate, one convention for every anchored column.
  r.hopen=r.hopenPx>0?(cur-r.hopenPx)/r.hopenPx*100:null;
  r.h4open=r.h4openPx>0?(cur-r.h4openPx)/r.h4openPx*100:null;
  r.h12open=r.h12openPx>0?(cur-r.h12openPx)/r.h12openPx*100:null;
  const ref=r.ref; if(!ref)return;
  r.h1=ref.p1h?(cur-ref.p1h)/ref.p1h*100:null; r.h4=ref.p4h?(cur-ref.p4h)/ref.p4h*100:null;
  r.d7=ref.p7d?(cur-ref.p7d)/ref.p7d*100:null;  r.d30=ref.p30d?(cur-ref.p30d)/ref.p30d*100:null; }
function setPrice(r,px){ if(px==null)return; if(r.px!=null&&px!==r.px) r.flash=px>r.px?'up':'down'; r.px=px; }
function inScope(r){ return (r.uni==='main')===(state.scope==='crypto'); }
function scopeBench(){ return state.scope==='crypto'?state.benchMain:state.benchCoin; }
function activeRows(){ const a=[]; for(const r of state.rows.values()) if(!r.delisted&&inScope(r))a.push(r); return a; }
// Effective grouping lens for the Markets tab. The industry layer is equities-only (crypto's
// curated sectors ARE its fine grouping — sectors.js sets ind===sector there), so crypto scope
// coerces 'industries' to 'sectors': the stocks-side choice is preserved, never silently
// rewritten, and flipping back restores it.
function mktGrp(){ const g=state.grp||'names'; return (state.scope==='crypto'&&g==='industries')?'sectors':g; }
// ===== ΔOI regime =====
// Category (price×OI signs, with a noise dead-zone) + conviction (magnitude, OI-led) +
// funding corroboration (does the crowded/paying side agree with the story?).
// side: +1 = long-side story (expects positive funding: longs pay), -1 = short-side story
// (expects negative funding: shorts pay), 0 = flat.
const RG_COLOR={'rg-long':'var(--up)','rg-sqz':'var(--accent)','rg-short':'var(--down)','rg-unw':'var(--blue)','rg-flat':'var(--faint)'};
const RG_STORY={
  'longs+':'new longs opening as price rises — new money confirming the up-move',
  'squeeze':'price up while OI falls — shorts covering (a squeeze), not fresh demand',
  'shorts+':'new shorts opening as price falls — new money pressing lower',
  'unwind':'price down while OI falls — longs closing / deleveraging, not fresh shorting',
  'flat':'price and OI both within noise this window — no meaningful positioning signal' };
function regimeOf(p,o,pEps,oEps){ if(p==null||o==null||!isFinite(p)||!isFinite(o)) return null;
  pEps=pEps||0; oEps=oEps||0;
  if(Math.abs(p)<=pEps && Math.abs(o)<=oEps) return {l:'flat',c:'rg-flat',side:0};
  const pu=p>=0, ou=o>=0;
  if(pu&&ou)  return {l:'longs+', c:'rg-long', side:+1};
  if(pu&&!ou) return {l:'squeeze',c:'rg-sqz',  side:-1};
  if(!pu&&ou) return {l:'shorts+',c:'rg-short',side:-1};
  return {l:'unwind',c:'rg-unw', side:+1}; }
// Full regime for one window: category + conviction (0..1) + funding note.
function regimeDetail(price,oi,funding,volH,hours){
  if(price==null||oi==null||!isFinite(price)||!isFinite(oi)) return null;
  const expMove=(volH!=null&&volH>0)?volH*100*Math.sqrt(hours):null;   // ~1σ price move over the window (%)
  const pEps=expMove!=null?Math.max(0.08,0.18*expMove):0.12;           // price dead-zone, vol-scaled
  const oEps=Math.max(0.4,0.3*Math.sqrt(hours/24));                    // OI dead-zone, window-scaled
  const cat=regimeOf(price,oi,pEps,oEps); if(!cat) return null;
  const sOI=Math.tanh(Math.abs(oi)/8);                                 // OI-led strength (matches momentum scale)
  const sPx=expMove!=null?Math.tanh((Math.abs(price)/expMove)/1.4):Math.tanh(Math.abs(price)/6);
  const base=Math.pow(sOI,0.6)*Math.pow(Math.max(sPx,1e-6),0.4);       // both legs required
  let fAPR=null,align=0,fN=0; const hasF=(funding!=null&&isFinite(funding));
  if(hasF){ fAPR=funding*24*365*100; fN=Math.tanh(fAPR/25); align=fN*cat.side; }  // +funding = longs pay
  const mult=hasF?clamp(1+0.30*align,0.7,1.3):1;                       // funding corroboration, bounded ±30%
  let conv=clamp(base*mult,0,1); if(cat.side===0) conv=0;
  const tier=conv>=0.6?'high':(conv>=0.3?'moderate':'low');
  let fnote='';
  if(cat.side!==0){
    if(!hasF) fnote='funding n/a';
    else if(Math.abs(fN)<0.15) fnote=`funding ${fAPR>=0?'+':''}${fAPR.toFixed(0)}% ~flat (neutral)`;
    else if(align>0) fnote=`funding ${fAPR>=0?'+':''}${fAPR.toFixed(0)}% corroborates the ${cat.side>0?'long':'short'}-side read`;
    else fnote=`funding ${fAPR>=0?'+':''}${fAPR.toFixed(0)}% conflicts — crowd is on the opposite side`;
  }
  return {l:cat.l,c:cat.c,side:cat.side,conv,tier,fAPR,fnote}; }
function regimeMeter(rg){ const n=rg.tier==='high'?3:(rg.tier==='moderate'?2:1), col=RG_COLOR[rg.c]||'var(--muted)';
  let m=`<span style="display:inline-flex;gap:1.5px;margin-left:5px;vertical-align:middle" title="conviction ${rg.tier} — ${Math.round(rg.conv*100)}/100">`;
  for(let i=0;i<3;i++) m+=`<i style="width:3px;height:9px;border-radius:1px;display:inline-block;background:${i<n?col:'var(--grid)'}"></i>`;
  return m+'</span>'; }
function pctTxt(x){ return (x!=null&&isFinite(x))?`${x>=0?'+':''}${x.toFixed(2)}%`:'n/a'; }
function regimeTip(rg,pPct,oPct){
  let t=`${rg.l.toUpperCase()} — ${RG_STORY[rg.l]||''}. Price ${pctTxt(pPct)} · OI ${pctTxt(oPct)} over ${state.tf}.`;
  if(rg.side!==0){ t+=` Conviction ${Math.round(rg.conv*100)}/100 (${rg.tier}).`; if(rg.fnote) t+=' '+rg.fnote+'.'; }
  return esc(t); }
function regimeReadout(r){ const rg=r.regime; if(!rg) return '';
  const pPct=r[TF_MAP[state.tf]];
  if(rg.side===0) return esc(`FLAT — ${RG_STORY.flat}. Price ${pctTxt(pPct)} · OI ${pctTxt(r.doi)} over ${state.tf}.`);
  const head=`<span class="rg ${rg.c}">${rg.l}</span>${regimeMeter(rg)} <span class="sec">conviction ${Math.round(rg.conv*100)}/100 (${rg.tier})</span>`;
  const body=esc(`${RG_STORY[rg.l]}. Price ${pctTxt(pPct)} · OI ${pctTxt(r.doi)} over ${state.tf}.${rg.fnote?' '+rg.fnote+'.':''}`);
  return `${head}<br><span style="opacity:.8">${body}</span>`; }
function detectBenchmark(){
  for(const a of SP_ALIASES){ for(const r of state.rows.values()) if(r.uni!=='main'&&!r.delisted&&r.ticker.toUpperCase()===a) return r.coin; }
  for(const r of state.rows.values()){ if(r.uni!=='main'&&!r.delisted&&/(?:^|[^A-Z])(SPX|SP500|S&P)/i.test(r.ticker)) return r.coin; }
  return null; }
export { COL_BY_KEY, DAY, DEFAULT_HIDDEN, DEFAULT_ORDER, G, HOUR, LAYOUT_V, LKEY, PKEY, RG_COLOR, RG_STORY, SCROLL_B, TF_MAP, TF_MS, activeRows, brkBar, claimDelta, clamp, detectBenchmark, el, esc, fmtFunding, fmtPct, fmtPrice, fmtUsd, inScope, isoUtc, lerp, liq24Cell, liveMark, maCell, median, mktGrp, momColor, overlayCloseAll, overlayCloseTop, overlayPop, overlayPush, overlayTop, parseAmount, pctTxt, recomputeChanges, regimeDetail, regimeMeter, regimeReadout, regimeTip, safeHref, scopeBench, setPrice, state, stdev, store, turnCell, vwapCell };
