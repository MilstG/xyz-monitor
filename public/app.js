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
    td:r=>{ const f=fmtFunding(r.funding);
      const p=r.fundPct, ext=p!=null&&(p>=90||p<=10);
      const flag=ext?`<i class="fpx ${p>=90?'hi':'lo'}" title="${p}th percentile of this market's OWN 31d hourly funding distribution — the crowd's payment is at a monthly extreme (${p>=90?'longs paying near their monthly max: crowded long, classic mean-reversion zone':'shorts paying near their monthly max: crowded short, squeeze fuel'})">${p>=90?'\u25b4':'\u25be'}${p}</i>`:'';
      const t2=p!=null?`${f.title} \u00b7 ${p}th pctile of its own 31d funding`:f.title;
      return `<td class="${f.c}" title="${t2}">${f.t}${flag}</td>`; }},
  {key:'prem', label:'Prem', type:'num', tip:'Perp vs oracle dislocation in basis points: (mark \u2212 oracle) / oracle. When the cash market is closed the oracle sits near the last print, so a persistent premium (perp rich) or discount (perp cheap) IS the live off-hours price discovery \u2014 the tradeable dislocation. Hover a cell for the exact mark vs oracle prices.',
    td:r=>premCell(r)},
  {key:'h1', label:'1h', type:'num', td:r=>`<td class="${scCls(r)}"${shade(r.h1,2.5)}>${pctInner(r.h1)}</td>`},
  {key:'h4', label:'4h', type:'num', td:r=>`<td class="${scCls(r)}"${shade(r.h4,4)}>${pctInner(r.h4)}</td>`},
  {key:'d1', label:'1d', type:'num', td:r=>`<td${shade(r.d1,5)}>${pctInner(r.d1)}</td>`},
  {key:'d7', label:'7d', type:'num', td:r=>`<td class="${scCls(r)}"${shade(r.d7,12)}>${pctInner(r.d7)}</td>`},
  {key:'d30', label:'30d', type:'num', td:r=>`<td class="${scCls(r)}"${shade(r.d30,25)}>${pctInner(r.d30)}</td>`},
  {key:'gap', label:'Gap', type:'num', tip:'Last close\u2192open gap \u2014 how much the perp moved from the most recent cash-session close to the next open (overnight 16:00\u219209:30 ET, or Fri\u2192Mon over a weekend). One move, always the latest, regardless of the timeframe selector. Hover for the cumulative off-hours drift over ~30d. Measured on US session hours, so it reads cleanest for US-linked names.',
    td:r=>gapCell(r)},
  {key:'trend', label:'30d trend', type:'num', tip:'30-day price path (sparkline). Sorts by 30-day % change.', td:r=>trendCell(r)},
  {key:'rs', label:'vs S&P', type:'num', tip:'Excess return vs the S&P 500 perp over the window (this market % − S&P %).',
    td:r=>`<td${shade(r.rs,8)}>${rsCell(r)}</td>`},
  {key:'beta', label:'β', type:'num', tip:'Beta to the S&P perp (90d daily returns): sensitivity to the benchmark. >1 amplifies it, 0–1 dampens, <0 moves inverse. Fills in once daily history loads in the background.',
    td:r=>betaCell(r)},
  {key:'mom', label:'Momentum', type:'num', def:'desc', tip:'Self-normalizing momentum −100…+100: risk-adjusted multi-horizon return × 7d trend quality + range position, modulated by OI conviction.',
    td:r=>`<td${shade(r.mom,60)}>${momCell(r)}</td>`},
  {key:'vol30', label:'Vol (ann)', type:'num', tip:'Annualized realized volatility from hourly returns over ~30 days.', td:r=>volCell(r)},
  {key:'adr', label:'Avg Range', type:'num', tip:'Average daily range: mean of each completed day\u2019s (high − low) / close, over the window (7d, or 30d when the 30d window is selected). Reads as "on a typical day this moves X%."', td:r=>adrCell(r)},
  {key:'dd', label:'vs 30d hi', type:'num', tip:'Distance below the 30-day high (0% = sitting at the high).', td:r=>ddCell(r)},
  {key:'ddy', label:'vs YTD hi', type:'num', tip:'Distance below the year\u2019s highest DAILY CLOSE (0% = making the YTD high now). Closes-based \u2014 intraday highs aren\u2019t retained at daily granularity, so this is the honest computable basis, same convention as the MA columns. Names listed this year use their full-life high (which IS their YTD high). Crypto: 31d retention only reaches Jan 1 in January \u2014 outside that, an honest dash.', td:r=>ddyCell(r)},
  {key:'yopen', label:'Y open', type:'num', tip:'Open of the first UTC day of the year. Perps trade continuously, so the yearly open IS the prior day\u2019s close, taken from the daily-close series. Names listed this year use their first close \u2014 their true opening level. Green when price is above it, red below; hover for the distance. Crypto: 31d retention only reaches Jan 1 in January.', td:r=>openCell(r,'yopen','yearly open')},
  {key:'mopen', label:'M open', type:'num', tip:'Open of the first UTC day of the current month \u2014 the prior day\u2019s close on a continuously-traded perp. Names listed this month use their first close. Green when price is above it, red below; hover for the distance.', td:r=>openCell(r,'mopen','monthly open')},
  {key:'doi', label:'ΔOI', type:'num', tip:'Open-interest change over the window, with a price-vs-OI regime tag. Stored server-side and persistent.',
    td:r=>`<td>${oiCell(r)}</td>`},
  {key:'sqz', label:'Squeeze', type:'num', def:'desc', tip:'Squeeze susceptibility 0\u2013100: how loaded the short-squeeze spring is over the window. Crowding (how hard shorts pay via window-avg negative funding) \u00d7 fuel (OI building) \u00d7 trigger (price pressing toward the 30d high). 0 whenever funding is positive \u2014 no crowded shorts, no squeeze. Sort descending to screen. Hover for the components.',
    td:r=>sqzCell(r)},
  {key:'carry', label:'Carry', type:'num', def:'desc', tip:'Funding carry per unit of risk: window-avg funding (APR%) \u00f7 annualized realized vol. +0.5 = the short side collects half a vol-unit per year just for holding; negative = the long side is paid. The screen for "paid to take the unpopular side." Same sign convention as the funding column.',
    td:r=>carryCell(r)},
  {key:'vol', label:'24h Vol', type:'num', td:r=>`<td class="sec">${fmtUsd(r.vol)}</td>`},
  {key:'oi', label:'OI', type:'num', td:r=>`<td class="sec">${fmtUsd(r.oi)}</td>`},
  {key:'ma20', label:'MA 20', type:'num', tip:'20-day simple moving average of daily closes \u00b7 green when price is above it, red below \u00b7 fills in once daily history loads \u00b7 hover for distance', td:r=>maCell(r,'ma20',20)},
  {key:'ma50', label:'MA 50', type:'num', tip:'50-day simple moving average of daily closes \u00b7 green when price is above it, red below \u00b7 crypto scope shows \u2014 (31d retention holds fewer than 50 closes)', td:r=>maCell(r,'ma50',50)},
  {key:'ma100', label:'MA 100', type:'num', tip:'100-day simple moving average of daily closes \u00b7 green when price is above it, red below \u00b7 crypto scope shows \u2014 (31d retention)', td:r=>maCell(r,'ma100',100)},
  {key:'ma200', label:'MA 200', type:'num', tip:'200-day simple moving average of daily closes \u00b7 green when price is above it, red below \u00b7 crypto scope shows \u2014 (31d retention)', td:r=>maCell(r,'ma200',200)},
  {key:'turn', label:'OI/Vol', type:'num', def:'desc', tip:'Open interest \u00f7 24h volume: how large standing positioning is relative to the flow that could move it. High (\u22652) = stale, crowded positioning \u2014 fragile to squeezes and unwinds, reads well next to the Squeeze and \u0394OI columns. Low (<0.5) = fresh churn, positions turn over within the day.',
    td:r=>turnCell(r)},
];
function maCell(r,key,nD){ const v=r[key];
  if(v==null||!isFinite(v)) return `<td><span class="na" title="needs ${nD} daily closes \u2014 ${r.uni==='main'&&nD>20?'crypto retention is 31d, so this MA is out of reach by design':'fills in as daily history loads'}">\u2014</span></td>`;
  const above=r.px!=null&&isFinite(r.px)?r.px>=v:null, d=above!=null&&v>0?((r.px/v-1)*100):null;
  return `<td class="${above==null?'sec':(above?'pos':'neg')}" title="SMA${nD} ${fmtPrice(v)}${d!=null?` \u00b7 price ${d>=0?'+':''}${d.toFixed(1)}% ${d>=0?'above':'below'}`:''}">${fmtPrice(v)}</td>`; }
function turnCell(r){ if(r.turn==null||!isFinite(r.turn)) return '<td><span class="na">\u2014</span></td>';
  const c=r.turn>=2?'accent':(r.turn<0.5?'sec':'');
  return `<td${c?` class="${c}"`:''} title="OI ${fmtUsd(r.oi)} \u00f7 24h vol ${fmtUsd(r.vol)} \u2014 positioning is ${r.turn.toFixed(1)}\u00d7 the daily flow">\u00d7${r.turn>=10?r.turn.toFixed(0):r.turn.toFixed(1)}</td>`; }
const COL_BY_KEY={}; COLS.forEach(c=>COL_BY_KEY[c.key]=c);
// Default table layout (order + which columns show). Hidden by default: beta, Vol(ann), ΔOI, Squeeze, Carry, OI.
const DEFAULT_ORDER=['ticker','px','funding','prem','h1','h4','d1','d7','d30','gap','trend','rs','mom','dd','ddy','yopen','mopen','vol','adr','beta','vol30','doi','sqz','carry','oi','turn','ma20','ma50','ma100','ma200'];
const DEFAULT_HIDDEN=['beta','vol30','doi','sqz','carry','oi','ma20','ma50','ma100','ma200'];
const LAYOUT_V=3; // bump to force a one-time reset of saved layouts to the new default (v3: prem column placed after funding; sqz/carry screens added)

const state={ rows:new Map(), order:[], mainOrder:[], scope:(()=>{try{return localStorage.getItem('xyz-scope')==='crypto'?'crypto':'stocks';}catch(_){return 'stocks';}})(), sortKey:'vol', sortDir:'desc', filter:'', tf:'1d', refreshMs:60000, benchCoin:null, benchMain:null,
  filters:{volMin:null,volMax:null,oiMin:null,oiMax:null}, corr:{tf:'30', topN:40, selected:null, search:'', topPairs:10, pair:null},
  colOrder:[...DEFAULT_ORDER], colHidden:new Set(DEFAULT_HIDDEN), pollMs:60000,
  sect:{ wt:'vol', sel:null, mode:'flow', corrTf:'30' }, dataTs:0, connOk:true, view:'markets', regimeSrv:null,
  backtest:{ signal:'mom', lookback:20, cadence:5, quantile:0.2, cost:5, universe:'all', split:0.6,
    direction:'high', structure:'ls', weighting:'eq', reqSign:false, holdWindow:'cc' },
  watch:new Set(), watchOnly:false, detail:null,
  analytics:{ data:null, err:null, ts:0, clock:{ sel:'all', metric:'vol' }, overlay:{ metric:'vol' }, dow:{ sel:'all', metric:'vol' }, season:{ sel:'all' } },
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
function inScope(r){ return (r.uni==='main')===(state.scope==='crypto'); }
function scopeBench(){ return state.scope==='crypto'?state.benchMain:state.benchCoin; }
function activeRows(){ const a=[]; for(const r of state.rows.values()) if(!r.delisted&&inScope(r))a.push(r); return a; }
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
  const mainM=Array.isArray(s.mainMarkets)?s.mainMarkets:[];
  state.mainOrder=mainM.map(m=>m.coin);
  state.benchMain=s.benchMain||null;
  const seen=new Set();
  for(const m of s.markets.concat(mainM)){
    let r=state.rows.get(m.coin);
    if(!r){ r={coin:m.coin, ticker:m.ticker||(m.coin.includes(':')?m.coin.split(':')[1]:m.coin),
      ref:null, feat:null, daily:null, candleTs:0,
      h1:undefined,h4:undefined,d7:undefined,d30:undefined}; state.rows.set(m.coin,r); }
    r.ticker=m.ticker||r.ticker; r.delisted=!!m.delisted; r.uni=m.uni||'xyz';
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
    if(m.fundByWin) r.fundByWin=m.fundByWin;
    if(m.sector) r.sector=m.sector;
    r.fundPct=(m.fundPct!=null)?m.fundPct:r.fundPct;
    if(m.assetClass) r.assetClass=m.assetClass;
    r.d1=(r.px!=null&&r.prevDay)?(r.px-r.prevDay)/r.prevDay*100:r.d1;
    recomputeChanges(r);
    r.candleTs=r.feat?Date.now():(r.candleTs||0);
    seen.add(m.coin);
  }
  for(const k of [...state.rows.keys()]) if(!seen.has(k)) state.rows.delete(k);
  state.benchCoin=s.benchCoin||detectBenchmark();
  if(s.dataTs) state.dataTs=s.dataTs;
  if(s.regime) state.regimeSrv=s.regime;
  if(s.warm) state.warm=s.warm;
  { const vis=el('view-signals')&&!el('view-signals').hidden;
    if(Date.now()-_sigLast > (vis?60*1000:5*60*1000)) loadSignals(); }
  if(s.v){ state.build=s.v; const bv=el('ver'); if(bv) bv.textContent=s.v; }
  // offHours now rides the snapshot (15s server rebuild), so the live-gap open↔closed flip
  // lands within one refresh instead of the old daily-path ~15 min. On a flip, pull /api/daily
  // immediately: the closed→open direction needs the freshly completed close→open gap, and
  // open→closed needs the new liveClose anchors.
  if(s.offHours){ const prev=state._ohClosed; state._ohSnap=true; state.offHours=s.offHours;
    const cl=!!s.offHours.closed;
    if(prev!=null&&prev!==cl) loadDaily();
    state._ohClosed=cl; }
  updateBenchNote();
  updateAggregates(); render(); updateMovers(); updateSyncProgress(); renderRegimeStrip();
}
function applyDaily(d){ if(!d||!d.daily) return;
  if(!state._ohSnap) state.offHours = d.offHours || {closed:false};   // legacy path: only until a snapshot has shipped the fresher copy
  for(const coin in d.daily){ const r=state.rows.get(coin); if(!r) continue;
    const arr=d.daily[coin];
    r.daily=Array.isArray(arr)?arr.map(p=>({t:p[0], c:p[1]})):r.daily;
    r.closePx=(d.liveClose && d.liveClose[coin]>0)?d.liveClose[coin]:null;   // price at the last close, for the live in-progress gap
    if(d.funding && Array.isArray(d.funding[coin])){ r.dailyFund=d.funding[coin].map(p=>({t:p[0], f:p[1]})); r._dfund=null; }
    if(d.overnight && Array.isArray(d.overnight[coin])){ r.overnight=d.overnight[coin].map(p=>({t:p[0], g:p[1], f:p[2]})); r._dov=null;
      const cut=Date.now()-30*DAY; let eq=1, n=0;                    // 30d cumulative off-hours drift (tooltip)
      for(const h of r.overnight){ if(h.t>=cut && isFinite(h.g)){ eq*=(1+h.g); n++; } }
      r.gap30 = n? (eq-1)*100 : undefined;
      const last=r.overnight[r.overnight.length-1]; r.gapDone = last&&isFinite(last.g)? last.g*100 : undefined;   // last completed close->open gap
    }
    r._dret=null; r._wrL=null; }
  scheduleRender();
  if(!el('view-corr').hidden) openCorr();           // wrapper, so the "loading X/Y" sync counter advances with the data
  if(!el('view-sectors').hidden) renderSectors();   // leaders map + sector corr fill in live as daily coverage grows
}
function updateAggregates(){ const rows=activeRows(); let v=0,o=0;
  for(const r of rows){ if(r.vol)v+=r.vol; if(r.oi)o+=r.oi; }
  el('s-mkts').textContent=rows.length; el('s-vol').textContent=fmtUsd(v); el('s-oi').textContent=fmtUsd(o);
  el('s-upd').textContent=new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function errRow(m){ return `<tr><td colspan="${COLS.length}"><div class="msg err"><span class="big">Couldn't reach the server</span>${esc(m||'Network error')}. Will retry on the next interval.</div></td></tr>`; }
function setStatus(ok){ state.connOk=ok; const d=el('live'); if(d){ d.style.background=ok?'var(--up)':'var(--down)'; d.title=ok?'live':'connection error'; } if(ok) updateFreshness(); }
function updateFreshness(){ if(!state.connOk) return; const d=el('live'); if(!d||!state.dataTs) return;
  const age=Date.now()-state.dataTs;
  if(age>180000){ d.style.background='var(--accent)'; d.title='server data is '+Math.round(age/60000)+'m old — the poller may be stalled'; }
  else { d.style.background='var(--up)'; d.title='live'; } }
function updateSyncProgress(){ const rows=activeRows(); let done=0; for(const r of rows) if(r.feat) done++;
  const s=el('sync'); if(!s) return;
  if(rows.length>0&&done>=rows.length){ s.classList.add('done'); el('sync-t').textContent='synced'; }
  else { s.classList.remove('done'); el('sync-t').textContent=`syncing ${done}/${rows.length}`; } }

// ===== derived metrics =====
function computeMomentum(r){
  const f=r.feat; if(!f||!(f.volH>0)) return undefined;
  const volD=(f.volD>0)?f.volD:null;   // measured daily vol; null until hourly features load -> falls back to hourly x sqrt(t)
  const H=[[r.h1,1,0.10],[r.h4,4,0.15],[r.d1,24,0.30],[r.d7,168,0.30],[r.d30,720,0.15]];
  let s=0,w=0,sa=0;
  for(const [ret,hrs,wt] of H){ if(ret==null||!isFinite(ret))continue;
    // 1d+ horizons use directly-measured daily vol (no iid sqrt(t) assumption); intraday uses hourly vol
    const sigma=(hrs>=24&&volD)?volD*Math.sqrt(hrs/24):f.volH*Math.sqrt(hrs);
    if(!(sigma>0))continue;
    const z=(ret/100)/sigma; s+=wt*z; sa+=wt*Math.abs(z); w+=wt; }
  if(w===0) return null;
  // cross-horizon coherence: |net blended move| / total absolute path across horizons, in [0,1].
  // 1 = every horizon agrees (clean trend), ->0 = horizons fight (choppy / rolling over). Replaces the
  // single-horizon 30d r2 gate so the quality factor reflects the multi-horizon blend the score is built from.
  const kappa = sa>0 ? Math.abs(s)/sa : 0;
  let core=(s/w)*(0.5+0.5*kappa);
  if(r.px!=null&&f.hi30!=null&&f.lo30!=null&&f.hi30>f.lo30) core+=0.4*(clamp((r.px-f.lo30)/(f.hi30-f.lo30),0,1)-0.5)*2;
  if(r.doi!=null&&isFinite(r.doi)) core*=clamp(1+0.4*Math.tanh(r.doi/8),0.6,1.4);
  return 100*Math.tanh(core/1.5);
}
function computeDerived(){
  const tfKey=TF_MAP[state.tf]||'d1';
  const bX=state.benchCoin?state.rows.get(state.benchCoin):null, bM=state.benchMain?state.rows.get(state.benchMain):null;
  for(const r of state.rows.values()){ if(r.delisted)continue;
    const benchC=r.uni==='main'?state.benchMain:state.benchCoin;   // BTC anchors crypto; SP500 anchors equities
    const bench=r.uni==='main'?bM:bX, benchRet=bench?bench[tfKey]:null;
    r.doi=r.doiByWin?(r.doiByWin[tfKey]??null):null;
    r.regime=regimeDetail(r[tfKey], r.doi, (r.fundByWin?(r.fundByWin[tfKey]??r.funding):r.funding), (r.feat&&r.feat.volH), (TF_MS[state.tf]||DAY)/HOUR);
    r.mom=computeMomentum(r);
    const prem=(r.px!=null&&r.oracle)?Math.abs((r.px-r.oracle)/r.oracle):0;
    const vs=(r.vol!=null&&r.feat&&r.feat.volBase>0)?r.vol/r.feat.volBase:null;
    r.hot=(vs!=null&&vs>=1.8)||prem>=0.004;
    if(!benchC) r.rs=undefined;
    else if(r.coin===benchC) r.rs=0;
    else if(benchRet==null) r.rs=null;
    else { const a=r[tfKey]; r.rs=(a!=null&&isFinite(a))?a-benchRet:null; }
    r.vol30=(r.feat&&r.feat.volH>0)?r.feat.volH*Math.sqrt(24*365)*100:undefined;
    const adrN=state.tf==='30d'?30:7;
    r.adr=(r.feat&&r.feat.dr&&r.feat.dr.length)?(()=>{ const s=r.feat.dr.slice(-adrN); return s.reduce((p,q)=>p+q,0)/s.length; })():undefined;
    r.dd=(r.px!=null&&r.feat&&r.feat.hi30>0)?(r.px-r.feat.hi30)/r.feat.hi30*100:undefined;
    // vs YTD high: distance below the year's highest DAILY CLOSE. Honest only when the daily
    // history actually covers the year: series reaching ~Jan 1, or a name listed this year
    // (xyz 370d retention means a late first point IS a new listing; crypto's flat 31d buffer
    // can't distinguish new listing from truncation unless the series is shorter than the
    // retention window). The live mark participates in the max, so 0% = making the high now.
    { let hy=null;
      const cl=r.daily;
      if(Array.isArray(cl)&&cl.length){
        const y0=Date.UTC(new Date().getUTCFullYear(),0,1);
        const covered = cl[0].t<=y0+3*DAY || (r.uni!=='main' ? cl[0].t>y0 : cl.length<28);
        if(covered) for(const k of cl){ if(k.t>=y0){ const c=+k.c; if(isFinite(c)&&(hy==null||c>hy)) hy=c; } }
      }
      if(hy!=null&&r.px!=null&&isFinite(r.px)&&r.px>hy) hy=r.px;
      r.ddy=(r.px!=null&&isFinite(r.px)&&hy>0)?(r.px-hy)/hy*100:undefined; }
    // Yearly / monthly open: these perps trade continuously, so the open of the first UTC day
    // of a period IS the prior day's close — which the daily-close series already carries, so
    // no new payload is needed. A name with no close before the boundary (listed inside the
    // period) uses its first close within it: its true opening level. The yearly open reuses
    // the vs-YTD-hi coverage guard (a truncated series that merely starts after Jan 1 must
    // dash, not masquerade as a new listing); the monthly boundary is always within reach of
    // both retention windows, so only genuine new listings ever hit the fallback there.
    { const cl=r.daily; let yo=null, mo=null;
      if(Array.isArray(cl)&&cl.length){
        const nowD=new Date(), y0=Date.UTC(nowD.getUTCFullYear(),0,1), m0=Date.UTC(nowD.getUTCFullYear(),nowD.getUTCMonth(),1);
        const openAt=(b)=>{ let prev=null;
          for(const k of cl){ const c=+k.c; if(!isFinite(c)) continue;
            if(k.t<b) prev=c; else return prev!=null?prev:c; }
          return prev; };   // series entirely before the boundary: stale, but the last close is still the level carried in
        const coveredY = cl[0].t<=y0+3*DAY || (r.uni!=='main' ? cl[0].t>y0 : cl.length<28);
        if(coveredY) yo=openAt(y0);
        mo=openAt(m0);
      }
      r.yopen=(yo!=null&&yo>0)?yo:undefined;
      r.mopen=(mo!=null&&mo>0)?mo:undefined; }
    // premium / squeeze / carry — all off data already in the row (oracle, window funding, ΔOI, vol)
    const fw=(r.fundByWin?(r.fundByWin[tfKey]??r.funding):r.funding);
    r.prem=(r.px!=null&&r.oracle>0)?(r.px/r.oracle-1)*1e4:undefined;
    r.sqz=computeSqueeze(r,fw);
    r._carryF=(fw!=null&&isFinite(fw))?fw*24*365*100:null;
    r.carry=(r._carryF!=null&&r.vol30!=null&&isFinite(r.vol30)&&r.vol30>5)?r._carryF/r.vol30:undefined;
    r.gap = r.uni==='main' ? undefined : ((state.offHours && state.offHours.closed && r.closePx>0 && isFinite(r.px)) ? (r.px/r.closePx-1)*100 : r.gapDone);   // crypto never gaps (24/7); else live in-progress gap when the cash market is closed, else the last completed gap
    r.trend=(r.d30!=null&&isFinite(r.d30))?r.d30:undefined;
    r.turn=(r.oi>0&&r.vol>0)?r.oi/r.vol:undefined;
    // Simple moving averages of DAILY closes. null until enough history: crypto (31d retention)
    // supports MA20 only — the longer MAs stay honest dashes rather than fabricated values.
    { const cl=r.daily; let m=null;
      if(Array.isArray(cl)&&cl.length){ m={}; for(const nD of [20,50,100,200]){
        if(cl.length>=nD){ let t=0,k=0; for(let i=cl.length-nD;i<cl.length;i++){ const c=+cl[i].c; if(isFinite(c)){t+=c;k++;} }
          m[nD]=k===nD?t/k:null; } else m[nD]=null; } }
      r.ma20=m?m[20]:undefined; r.ma50=m?m[50]:undefined; r.ma100=m?m[100]:undefined; r.ma200=m?m[200]:undefined; }
    if(!benchC) r.beta=undefined;
    else if(r.coin===benchC){ r.beta=1; r.betaR2=1; }
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
  const bC=r.uni==='main'?state.benchMain:state.benchCoin;
  if(!bC) return '<td><span class="na" title="no benchmark detected">—</span></td>';
  if(r.coin===bC) return '<td><span class="sec" title="the benchmark itself">1.00</span></td>';
  if(r.beta==null||!isFinite(r.beta)) return '<td><span class="na" title="loading daily history…">·</span></td>';
  const c=r.beta<0?'neg':(r.beta>1.15?'pos':'sec');
  return `<td><span class="${c}" title="R²=${(r.betaR2||0).toFixed(2)} — fit quality vs the S&amp;P">${r.beta.toFixed(2)}</span></td>`;
}

// ===== rendering =====
let renderQueued=false;
function scheduleRender(){ if(renderQueued)return; renderQueued=true; requestAnimationFrame(()=>{renderQueued=false; render(); updateMovers();}); }
function scCls(r){ return (r.candleTs && (Date.now()-r.candleTs>2*state.refreshMs+60000)) ? 'stale':''; }
const XYZ_ONLY_COLS=new Set(['gap']);   // session-anchored concepts — a 24/7 market has none
function visibleCols(){ return state.colOrder.map(k=>COL_BY_KEY[k]).filter(c=>c && !state.colHidden.has(c.key) && !(state.scope==='crypto'&&XYZ_ONLY_COLS.has(c.key))); }
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
    let label=c.label; if(c.key==='rs')label=`vs ${state.scope==='crypto'?'BTC':'S&amp;P'} (${state.tf})`; if(c.key==='doi')label=`ΔOI (${state.tf})`;
    if(c.key==='adr')label=`Avg Range (${state.tf==='30d'?'30d':'7d'})`;
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
function gapCell(r){ const g=r.gap;
  const live = !!(state.offHours && state.offHours.closed && r.closePx>0 && isFinite(r.px));
  const t = (g!=null&&isFinite(g))
    ? (live ? 'Live \u2014 move since the last cash close (market closed now)' : 'Last close\u2192open gap')
        + ((r.gap30!=null&&isFinite(r.gap30))?' \u00b7 30d off-hours drift '+(r.gap30>0?'+':'')+r.gap30.toFixed(1)+'%':'')
    : 'Off-hours (overnight + weekend) gap \u2014 fills in with the hourly spine';
  const dot = live ? '<span class="live-dot" title="live \u2014 market closed">\u25cf</span>' : '';
  return `<td${shade(g,4)} title="${esc(t)}">${pctInner(g)}${dot}</td>`; }
function momCell(r){ if(r.mom===undefined)return '<span class="ph">·</span>'; if(r.mom===null)return '<span class="na">—</span>';
  const sign=r.mom>0?'+':'';
  return `<span style="color:${momColor(r.mom)};font-weight:600">${sign}${Math.round(r.mom)}</span>`+(r.hot?'<span class="hotdot" title="volume / activity well above this market\u2019s own norm">●</span>':''); }
function rsCell(r){ const bC=r.uni==='main'?state.benchMain:state.benchCoin;
  if(!bC)return '<span class="na" title="no benchmark detected">—</span>';
  if(r.coin===bC)return `<span class="sec" title="this is the benchmark">${r.uni==='main'?'BTC':'S&amp;P'}</span>`;
  const p=fmtPct(r.rs); return `<span class="${p.c}">${p.t}</span>`; }
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
  return `<td class="sec" title="annualized realized vol">${r.vol30.toFixed(0)}%</td>`; }
function adrCell(r){ if(r.adr==null||!isFinite(r.adr)) return '<td><span class="na" title="loading hourly history…">·</span></td>';
  const t=Math.min(r.adr/8,1)*0.18;
  return `<td class="sec" style="background:rgba(227,165,60,${t.toFixed(3)})" title="avg daily high−low as % of close, over ${state.tf==='30d'?'30d':'7d'}">${r.adr.toFixed(2)}%</td>`; }
function ddCell(r){ if(r.dd==null||!isFinite(r.dd)) return '<td><span class="na">·</span></td>';
  const c=r.dd>=-0.5?'pos':(r.dd<=-15?'neg':'sec'); return `<td class="${c}" title="distance below the 30-day high">${r.dd.toFixed(1)}%</td>`; }
function ddyCell(r){ if(r.ddy==null||!isFinite(r.ddy)) return '<td><span class="na" title="needs daily history reaching Jan 1 \u2014 crypto retention is 31d, so outside January this is out of reach by design; equities fill in as the daily backfill loads">\u2014</span></td>';
  const c=r.ddy>=-0.5?'pos':(r.ddy<=-25?'neg':'sec');
  return `<td class="${c}" title="distance below the year\u2019s highest daily close (0% = making the YTD high now)">${r.ddy.toFixed(1)}%</td>`; }
function openCell(r,key,lbl){ const v=r[key];
  if(v==null||!isFinite(v)) return `<td><span class="na" title="needs daily history reaching the ${key==='yopen'?'start of the year \u2014 crypto retention is 31d, so outside January this is out of reach by design; equities fill in as the daily backfill loads':'start of the month \u2014 fills in as daily history loads'}">\u2014</span></td>`;
  const above=r.px!=null&&isFinite(r.px)?r.px>=v:null, d=above!=null&&v>0?((r.px/v-1)*100):null;
  return `<td class="${above==null?'sec':(above?'pos':'neg')}" title="${lbl} ${fmtPrice(v)}${d!=null?` \u00b7 price ${d>=0?'+':''}${d.toFixed(1)}% ${d>=0?'above':'below'}`:''}">${fmtPrice(v)}</td>`; }
function premCell(r){ if(r.prem==null||!isFinite(r.prem)) return '<td><span class="na" title="needs both mark and oracle prices">·</span></td>';
  const v=r.prem, c=v>0.5?'pos':(v<-0.5?'neg':'sec');
  const t=`mark ${fmtPrice(r.px)} vs oracle ${fmtPrice(r.oracle)} \u2014 perp ${v>=0?'rich (premium)':'cheap (discount)'} ${Math.abs(v).toFixed(1)}bp`+
    (state.offHours&&state.offHours.closed?' \u00b7 cash market closed: this dislocation is the live off-hours price discovery':'');
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
function render(){
  if(!state.rows.size) return; computeDerived(); evaluateAlerts();
  const body=el('body'), rows=sortedRows(), vc=visibleCols();
  const fc=el('fcount'); if(fc){ const tot=activeRows().length; fc.textContent=(rows.length!==tot)?`showing ${rows.length} of ${tot}`:''; }
  if(!rows.length){ body.innerHTML=`<tr><td colspan="${vc.length}"><div class="msg"><span class="big">No matches</span>Clear the filters to see all markets.</div></td></tr>`; return; }
  const out=[];
  const bScope=scopeBench();
  for(const r of rows){ const cls=(r.coin===bScope)?' class="benchrow"':'';
    let row=`<tr data-coin="${esc(r.coin)}"${cls}>`; for(const c of vc) row+=c.td(r); row+='</tr>'; r.flash=null; out.push(row); }
  body.innerHTML=out.join('');
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
      (domL?`<b class="${RG_CLS[domL]}" style="font-size:11px" data-tip="largest non-flat regime by OI share">${Math.round(domV*100)}% ${esc(domL)}</b>`:'')+`</span>`; }
  box.innerHTML=
     `<span class="rs-lab ${lab.cls}" data-tip="${esc(lab.tip)}">${esc(lab.t)}</span>`
    +`<span class="rs-m" data-tip="share of markets up over ${state.tf} (${upN}/${g.n})"><span class="rs-k">breadth</span>`
      +`<span class="rs-bar"><span class="rs-bar-fill" style="width:${bw}%"></span></span>`
      +`<b class="${g.breadth>=0.5?'pos':'neg'}">${bw}%</b></span>`
    +`<span class="rs-m" data-tip="cross-sectional stdev of ${state.tf} returns \u2014 how spread out the moves are"><span class="rs-k">dispersion</span> <b>\u00b1${g.dispersion!=null?g.dispersion.toFixed(2):'\u2014'}%</b></span>`
    +mixHtml
    +`<span class="rs-m" data-tip="${esc(corrTip)}"><span class="rs-k">30d corr</span> ${corrTxt}</span>`;
}

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
function dailyFunding(r){ if(r._dfund!==undefined && r._dfund!==null) return r._dfund; const c=r.dailyFund; if(!c||!c.length){ r._dfund=null; return null; }
  const m=new Map(); for(const k of c){ const f=parseFloat(k.f); if(isFinite(f)) m.set(Math.floor(k.t/DAY), f); } r._dfund=m; return m; }
function overnightReturns(r){ if(r._dov!==undefined && r._dov!==null) return r._dov; const c=r.overnight; if(!c||!c.length){ r._dov=null; return null; }
  const g=new Map(), f=new Map(); for(const k of c){ const gr=parseFloat(k.g), fn=parseFloat(k.f); const d=Math.floor(k.t/DAY); if(isFinite(gr)){ g.set(d,gr); f.set(d, isFinite(fn)?fn:0); } } r._dov={g,f}; return r._dov; }
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
  case 'gap': return r.gap!=null&&isFinite(r.gap)?r.gap.toFixed(3):'';
  case 'prem': return r.prem!=null&&isFinite(r.prem)?r.prem.toFixed(2):'';
  case 'sqz': return r.sqz!==undefined?r.sqz:'';
  case 'carry': return r.carry!=null&&isFinite(r.carry)?r.carry.toFixed(3):'';
  case 'rs': return r.rs; case 'mom': return r.mom!=null?Math.round(r.mom):'';
  case 'vol30': return r.vol30!=null&&isFinite(r.vol30)?r.vol30.toFixed(1):'';
  case 'adr': return r.adr!=null&&isFinite(r.adr)?r.adr.toFixed(3):'';
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
  const split=r.uni==='main'?null:sessionSplit30(r);   // no cash session exists to decompose against
  const splitHtml = split
    ? `<div class="dsec" data-tip="30d off-hours split \u00b7 return decomposed into what accrued off-hours (overnight + weekend close\u2192open) vs during cash sessions \u00b7 a persistent off-hours drift is the overnight-effect edge this panel exists to expose">Where the 30d return happened</div>`+
      `<div class="dsplit">`+
        `<span data-tip="total 30d price return">total <b class="${split.total>=0?'pos':'neg'}">${split.total>=0?'+':''}${split.total.toFixed(1)}%</b></span>`+
        `<span data-tip="compounded across ${split.n} close\u2192open holds (overnight + weekend)">off-hours <b class="${split.off>=0?'pos':'neg'}">${split.off>=0?'+':''}${split.off.toFixed(1)}%</b></span>`+
        `<span data-tip="the residual: what accrued 09:30\u201316:00 ET">session <b class="${split.sess>=0?'pos':'neg'}">${split.sess>=0?'+':''}${split.sess.toFixed(1)}%</b></span>`+
        (Math.abs(split.off)>Math.abs(split.total)*0.7&&Math.abs(split.total)>2?`<span class="sec" style="font-size:10.5px" data-tip="\u226570% of the 30d move accrued while the cash market was closed">\u26a1 overnight-driven</span>`:'')+
      `</div>`
    : '';
  el('drawer').innerHTML=`
    <div class="dhead">${esc(r.ticker)}
      <span class="star${starred?' on':''}" id="dstar" style="font-size:16px;cursor:pointer">${starred?'★':'☆'}</span>
      <button class="dclose" id="dclose" title="close">✕</button></div>
    <div class="dsub">${esc(r.coin)} · ${fmtPrice(r.px)}${r.coin===state.benchCoin?' · S&amp;P benchmark':''}${r.coin===state.benchMain?' · BTC — crypto benchmark':''}${r.uni==='main'?' · 24/7 · 31d history':''}</div>
    ${closes.length>2?`<div class="dsec">90-day price</div>${sparkline(closes,{color: closes[closes.length-1]>=closes[0]?'var(--up)':'var(--down)'})}`:''}
    <div id="dcandles"></div>
    ${splitHtml}
    <div id="dseries"></div>
    <div id="dledger"></div>
    <div class="dsec">Metrics</div>
    <div class="dgrid">
      ${st('Funding (APR)',`<span class="${fu.c}">${fu.t}</span>`)}
      ${st('Momentum',momTxt)}
      ${st('1h',pct(r.h1))} ${st('4h',pct(r.h4))}
      ${st('1d',pct(r.d1))} ${st('7d',pct(r.d7))}
      ${st('30d',pct(r.d30))} ${st('vs S&amp;P ('+state.tf+')', r.rs==null?'<span class="na">—</span>':pct(r.rs))}
      ${st('β vs S&amp;P',betaTxt)} ${st('Vol (ann)', r.vol30!=null?r.vol30.toFixed(0)+'%':'·')}
      ${st('Premium', (r.prem!=null&&isFinite(r.prem))?`<span class="${r.prem>0.5?'pos':(r.prem<-0.5?'neg':'sec')}">${r.prem>=0?'+':''}${r.prem.toFixed(1)}bp</span>`:'·')}
      ${st('Gap', (r.gap!=null&&isFinite(r.gap))?`<span class="${r.gap>=0?'pos':'neg'}">${r.gap>=0?'+':''}${r.gap.toFixed(2)}%</span>`:'·')}
      ${st('Squeeze', r.sqz!==undefined?`<span style="color:${r.sqz>=60?'var(--accent)':(r.sqz>=30?'var(--text)':'var(--faint)')}">${r.sqz}</span>`:'·')}
      ${st('Carry', (r.carry!=null&&isFinite(r.carry))?`<span class="${r.carry>0.05?'pos':(r.carry<-0.05?'neg':'sec')}">${r.carry>=0?'+':''}${r.carry.toFixed(2)}</span>`:'·')}
      ${st('vs 30d high', r.dd!=null?`<span class="${r.dd>=-0.5?'pos':'sec'}">${r.dd.toFixed(1)}%</span>`:'·')}
      ${st('ΔOI ('+state.tf+')', r.doi!=null?`<span class="${r.doi>=0?'pos':'neg'}">${r.doi>=0?'+':''}${r.doi.toFixed(2)}%</span>`:'<span class="na">—</span>')}
      ${st('24h Vol',fmtUsd(r.vol))} ${st('Open Interest',fmtUsd(r.oi))}
    </div>
    ${r.regime?`<div class="sec" style="font-size:11.5px;margin:2px 0 12px;line-height:1.55">${regimeReadout(r)}</div>`:''}
    <div class="dsec">Top co-movers (90d)</div>${pos.length?pos.map(x=>li(x[0],x[1])).join(''):'<div class="sec" style="font-size:12px">daily history still loading…</div>'}
    <div class="dsec">Top hedges — inverse (90d)</div>${neg.length?neg.map(x=>li(x[0],x[1])).join(''):'<div class="sec" style="font-size:12px">no negative correlations</div>'}`;
  el('drawer').classList.add('show'); el('drawerbg').classList.add('show'); el('drawer').setAttribute('aria-hidden','false');
  el('dclose').onclick=closeDetail;
  el('dstar').onclick=()=>{ toggleWatch(coin); openDetail(coin); };
  setHash('t='+encodeURIComponent(coin));
  loadDrawerSeries(coin);
  loadDrawerCandles(coin);
  loadDrawerLedger(coin);
}
// 30d overnight-effect decomposition for one name: total return vs the compounded off-hours
// (close→open) leg, session = the residual. Built entirely from data already shipped to the
// client (daily closes + the overnight hold series), so it costs nothing server-side.
function sessionSplit30(r){
  if(!r.daily||!r.overnight||r.daily.length<5||!r.overnight.length) return null;
  const cut=Date.now()-30*DAY;
  let first=null,last=null;
  for(const k of r.daily){ const c=parseFloat(k.c); if(!isFinite(c))continue; if(k.t>=cut&&first==null)first=c; last=c; }
  if(!(first>0)||last==null) return null;
  const total=last/first-1;
  let eq=1,n=0;
  for(const h of r.overnight){ if(h.t>=cut&&isFinite(h.g)){ eq*=(1+h.g); n++; } }
  if(n<3) return null;
  const off=eq-1, sess=(1+total)/(1+off)-1;
  return {total:total*100, off:off*100, sess:sess*100, n};
}
// Hourly candlestick chart for the drawer, fed by /api/candles. Crosshair + OHLC readout via
// the shared hoverChart infrastructure (same one the Sessions curves use).
function candleSvg(cd){
  const W=420,H=176, pl=4,pr=52,pt=10,pb=20;
  if(!cd||cd.length<5) return '';
  let lo=Infinity,hi=-Infinity;
  for(const k of cd){ if(isFinite(k[3])&&k[3]<lo)lo=k[3]; if(isFinite(k[2])&&k[2]>hi)hi=k[2]; }
  if(!(hi>lo)) return '';
  const pad=(hi-lo)*0.06; hi+=pad; lo-=pad;
  const n=cd.length, X=i=>pl+(i+0.5)/n*(W-pl-pr), Y=v=>pt+(1-(v-lo)/(hi-lo))*(H-pt-pb);
  const bw=Math.max(1,Math.min(6,(W-pl-pr)/n*0.72));
  const axf=v=>{ const a=Math.abs(v);
    if(a>=1e6) return (v/1e6).toFixed(2)+'M';
    if(a>=1e4) return (v/1e3).toFixed(1)+'k';
    return fmtPrice(v); };
  let s='';
  for(const v of lcTicks(lo,hi,4)){ const y=Y(v).toFixed(1);
    s+=`<line x1="${pl}" y1="${y}" x2="${W-pr}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`+
       `<text x="${W-pr+5}" y="${(+y+3).toFixed(1)}" class="lc-tick">${axf(v)}</text>`; }
  for(let i=0;i<n;i++){ const k=cd[i], o=k[1],h=k[2],l=k[3],c=k[4];
    if(!isFinite(o)||!isFinite(c)) continue;
    const up=c>=o, col=up?'var(--up)':'var(--down)', x=X(i);
    if(isFinite(h)&&isFinite(l)) s+=`<line x1="${x.toFixed(1)}" y1="${Y(h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${Y(l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    const y0=Y(Math.max(o,c)), hgt=Math.max(1,Math.abs(Y(o)-Y(c)));
    s+=`<rect x="${(x-bw/2).toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}"${up?' fill-opacity="0.85"':''}/>`; }
  const dfmt=t=>{ const d=new Date(t); return (d.getMonth()+1)+'/'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':00'; };
  s+=`<text x="${pl}" y="${H-6}" class="lc-tick">${dfmt(cd[0][0])}</text>`;
  s+=`<text x="${(W-pr)}" y="${H-6}" text-anchor="end" class="lc-tick">${dfmt(cd[n-1][0])}</text>`;
  const xs=cd.map((_,i)=>X(i));
  const rows=cd.map(k=>{ const chg=(isFinite(k[1])&&k[1]>0&&isFinite(k[4]))?(k[4]/k[1]-1)*100:null;
    return `<b style="color:var(--text)">${dfmt(k[0])}</b><br>O ${fmtPrice(k[1])} · H ${fmtPrice(k[2])}<br>L ${fmtPrice(k[3])} · C ${fmtPrice(k[4])}`+
      (chg!=null?`<br><span class="${chg>=0?'pos':'neg'}" style="color:${chg>=0?'var(--up)':'var(--down)'}">${chg>=0?'+':''}${chg.toFixed(2)}%</span>`:''); });
  return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});
}
async function loadDrawerCandles(coin){
  const box=el('dcandles'); if(!box) return;
  const days=state.candTf||7;
  try{
    const res=await fetchJSON('/api/candles?coin='+encodeURIComponent(coin)+'&days='+days);
    if(state.detail!==coin || !box.isConnected) return;
    const cd=(res&&Array.isArray(res.candles))?res.candles:[];
    if(cd.length<5){ box.innerHTML=''; return; }   // server not updated yet, or spine still filling — the drawer just omits the chart
    const seg=[3,7,14,30,90].map(d=>`<button type="button" class="cdtf${d===days?' on':''}" data-d="${d}">${d}d</button>`).join('');
    box.innerHTML=`<div class="dsec" style="display:flex;align-items:center;gap:8px">Hourly candles <span class="cdtf-seg" style="margin-left:auto">${seg}</span></div>`+candleSvg(cd);
    box.querySelectorAll('.cdtf').forEach(b=>b.addEventListener('click',()=>{ state.candTf=+b.dataset.d; loadDrawerCandles(coin); }));
    attachLineHover();
  }catch(_){ }
}
async function loadDrawerSeries(coin){
  const box=el('dseries'); if(!box) return;
  try{
    const s=await fetchJSON('/api/series?coin='+encodeURIComponent(coin));
    if(state.detail!==coin || !box.isConnected) return;
    const span=arr=>{ if(!arr||arr.length<2)return ''; const ms=arr[arr.length-1][0]-arr[0][0], d=ms/86400000; return d>=1?('· last '+d.toFixed(0)+'d'):('· last '+(ms/3600000).toFixed(0)+'h'); };
    let html='';
    if(s.oi && s.oi.length>2){ const v=s.oi.map(p=>p[1]), up=v[v.length-1]>=v[0];
      html+=`<div class="dsec">Open interest ${span(s.oi)}</div>${sparkline(v,{color:up?'var(--up)':'var(--down)'})}`; }
    if(s.funding && s.funding.length>2){ const v=s.funding.map(p=>p[1]*24*365*100), last=v[v.length-1];
      html+=`<div class="dsec">Funding APR ${span(s.funding)} · now ${(last>=0?'+':'')+last.toFixed(1)}%</div>${sparkline(v,{zero:true,color:'var(--blue)'})}`; }
    box.innerHTML = html || '<div class="dsec">OI / funding history</div><div class="sec" style="font-size:12px">collecting — the trend appears here as history accrues server-side</div>';
  }catch(_){}
}
// ===== per-ticker signal record (drawer) + full history (Signals tab search) =====
// The drawer shows only the compact record — hit rate, per-event fractions, open count — so it
// stays scannable; the full claim-by-claim audit trail lives behind the ticker search on the
// Signals tab (openSigHistory deep-links there). Both read /api/ledger. Outcomes are signed
// with the claim, in the unit each claim resolved in (R for sigma-united events, % / bp
// otherwise); pre-epoch legacy entries are labeled rather than silently mixed.
function shDate(t){ try{ return new Date(t).toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+new Date(t).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}); }catch(_){ return ''; } }
function shVal(v,unit){ if(v==null) return '<span class="na">\u2014</span>';
  const s=(v>=0?'+':'')+(unit==='bp'?v.toFixed(0):v.toFixed(2))+(unit==='R'?'R':unit);
  return `<span class="${v>0?'pos':'neg'}">${s}</span>`; }
function shLeft(resolveAt){ const left=resolveAt-Date.now(); return left>0?(left>=86400000?(left/86400000).toFixed(1)+'d':(left/3600000).toFixed(0)+'h'):'due'; }
async function loadDrawerLedger(coin){
  const box=el('dledger'); if(!box) return;
  try{
    const d=await fetchJSON('/api/ledger?coin='+encodeURIComponent(coin));
    if(state.detail!==coin || !box.isConnected) return;
    const res=d.closed.filter(e=>e.status==='resolved'), open=d.open.length;
    if(!res.length&&!open&&!d.closed.length){ box.innerHTML=''; return; }   // nothing ever fired here
    const wins=res.filter(e=>e.win).length;
    const per={}; for(const e of res){ const b=per[e.ev]||(per[e.ev]={n:0,w:0,label:e.label}); b.n++; if(e.win)b.w++; }
    const chips=Object.keys(per).sort((a,b)=>per[b].n-per[a].n).map(ev=>{ const b=per[ev];
      return `<span class="sigrec-chip" data-tip="${esc(`${b.label}: ${b.w} of ${b.n} resolved claim${b.n===1?'':'s'} on this name went the way the signal implied`)}">${esc(b.label)} <b class="${b.w/b.n>=0.5?'pos':'neg'}">${b.w}/${b.n}</b></span>`; }).join('');
    const head=res.length?`<b class="${wins/res.length>=0.5?'pos':'neg'}">${Math.round(100*wins/res.length)}%</b> hit <span style="color:var(--faint)">(n=${res.length})</span>`:'<span class="sec">no resolutions yet</span>';
    const canJump=state.scope!=='crypto';
    box.innerHTML=`<div class="dsec" data-tip="out-of-sample record of every visible claim the engine ever fired on this name \u2014 hit = share of resolved claims that went the way the signal implied. The claim-by-claim history lives behind the ticker search on the Signals tab.">Signal record</div>`
      +`<div class="dsplit" style="flex-wrap:wrap">`
      +`<span>${head}</span>`
      +(open?`<span data-tip="claims on the books, awaiting their horizon">open <b>${open}</b></span>`:'')
      +(canJump?`<span id="dledger-full" class="sec" style="cursor:pointer;font-size:11px;text-decoration:underline;text-underline-offset:2px" data-tip="jump to the Signals tab with this ticker\u2019s full claim-by-claim history loaded">full history \u2192</span>`:'')
      +`</div>`
      +(chips?`<div class="dsplit" style="flex-wrap:wrap;gap:6px">${chips}</div>`:'');
    const fb=el('dledger-full');
    if(fb) fb.onclick=()=>{ const t=d.ticker||coin; closeDetail(); openSigHistory(t); };
  }catch(_){ box.innerHTML=''; }
}
// Full history panel on the Signals tab, driven by the static #sighist-q search input.
let _shSeq=0, _shTimer=null;
function sigHistRow(e,withTicker){
  const side=e.side==='long'?'<span class="pos">LONG</span>':e.side==='short'?'<span class="neg">SHORT</span>':'<span class="sec">\u2014</span>';
  const flags=(e.pr?' <span data-tip="fired as a \u2605 prime-quality claim">\u2605</span>':'')
    +(e.conf?' <span data-tip="fired WITH same-side company on this name (confluence)" style="color:var(--blue)">\u29c9</span>':'')
    +(e.legacy?' <i class="sig-unp" data-tip="resolved before sigma-normalization \u2014 outcome is in raw % and excluded from the R aggregates">legacy %</i>':'');
  const fired=shDate(e.t0)+(e.boot?' <span class="sec" style="cursor:help" data-tip="claim opened on the FIRST build after a server restart or deploy \u2014 the condition may have been in force before this stamp. The mark and outcome are measured from this moment, so the record is honest; only the onset time is a floor, not the true trigger time. Identical timestamps across events on one boot are this, not shared bookkeeping.">\u27f2</span>':'');
  const mark=e.mark0!=null?fmtPrice(e.mark0):'<span class="na">\u2014</span>';
  const tcell=withTicker?`<td><span class="sh-tk" data-shtk="${esc(e.tk||e.coin||'')}" style="cursor:pointer;color:var(--accent)" data-tip="drill down to this name\u2019s full history">${esc(e.tk||e.coin||'\u2014')}</span></td>`:'';
  const tip=`fired ${shDate(e.t0)} at ${e.mark0!=null?fmtPrice(e.mark0):'\u2014'} \u00b7 score ${e.score0!=null?e.score0:'\u2014'} at fire`
    +(e.claimMed!=null?` \u00b7 claimed med ${(e.claimMed>=0?'+':'')+e.claimMed.toFixed(2)}${e.unit}`:'')
    +(e.status==='resolved'?' \u00b7 outcome is signed with the claim: positive = it went the way the signal implied':'');
  if(e.status==='open')
    return `<tr data-tip="${esc(tip+` \u00b7 resolves in ${shLeft(e.resolveAt)}`)}">${tcell}<td>${esc(e.label)}${flags}</td><td>${side}</td><td>${fired}</td><td>${mark}</td><td class="sec">in ${shLeft(e.resolveAt)}</td><td>${e.score0!=null?e.score0:'\u2014'}</td><td class="sec">open</td><td></td></tr>`;
  if(e.status==='void')
    return `<tr data-tip="${esc(tip+' \u00b7 could not be resolved (no usable price at horizon) \u2014 excluded from the record')}">${tcell}<td>${esc(e.label)}${flags}</td><td>${side}</td><td>${fired}</td><td>${mark}</td><td>${shDate(e.tR||e.t0)}</td><td>${e.score0!=null?e.score0:'\u2014'}</td><td class="na">void</td><td></td></tr>`;
  const sa=e.realizedS!=null&&e.realizedS!==e.realized
    ?`${shVal(e.realizedS,e.unit)}${e.stopped?' <span class="neg" data-tip="the frozen void level was touched before horizon">\u26d4</span>':''}`
    :(e.stopped?'<span class="neg" data-tip="the frozen void level was touched before horizon">\u26d4</span>':'<span class="sec">\u2014</span>');
  return `<tr data-tip="${esc(tip)}">${tcell}<td>${esc(e.label)}${flags}</td><td>${side}</td><td>${fired}</td><td>${mark}</td><td>${shDate(e.tR)}</td><td>${e.score0!=null?e.score0:'\u2014'}</td><td>${shVal(e.realized,e.unit)}</td><td>${sa}</td></tr>`;
}
async function loadSigHistory(f){
  const p=el('sighist-panel'); if(!p) return;
  const seq=++_shSeq;
  p.hidden=false; p.innerHTML='<div class="msg">Loading\u2026</div>';
  try{
    const qs=[]; if(f.coin) qs.push('coin='+encodeURIComponent(f.coin)); if(f.ev) qs.push('ev='+encodeURIComponent(f.ev));
    const d=await fetchJSON('/api/ledger?'+qs.join('&'));
    if(seq!==_shSeq||!p.isConnected) return;
    const withTicker=!f.coin;   // browsing across names -> show whose claim each row is
    const res=d.closed.filter(e=>e.status==='resolved'), wins=res.filter(e=>e.win).length;
    const rec=res.length?` \u00b7 <b class="${wins/res.length>=0.5?'pos':'neg'}">${Math.round(100*wins/res.length)}%</b> hit <span style="color:var(--faint)">(n=${res.length})</span>`:'';
    const evLbl=f.ev?(EV_LABELS[f.ev]||f.ev):'';
    const title=f.coin&&f.ev?`${esc(d.ticker||f.ticker||f.coin)} \u00b7 ${esc(evLbl)}`:(f.coin?esc(d.ticker||f.ticker||f.coin):esc(evLbl));
    const rows=d.open.map(e=>sigHistRow(e,withTicker)).join('')+d.closed.map(e=>sigHistRow(e,withTicker)).join('');
    const capNote=d.closed.length>=150?' <span class="sec" data-tip="the ledger keeps the last 4,000 resolved claims; this view shows the most recent 150 matching">\u00b7 most recent 150 shown</span>':'';
    p.innerHTML=`<div class="cp-head">${title} <span class="sec" style="font-weight:400">\u2014 signal history${rec}${d.open.length?` \u00b7 ${d.open.length} open`:''}${capNote}</span> <button class="btn xtiny" id="sighist-close" title="close" style="float:right">\u2715</button></div>`
      +(rows?`<table class="sigrec-t"><thead><tr>${withTicker?'<th>ticker</th>':''}<th>event</th><th>side</th><th data-tip="when THIS claim opened its own entry in the ledger (your local time) \u2014 every event instance stamps its own time. \u27f2 marks claims opened on the first build after a restart/deploy, where the condition may predate the stamp">fired</th><th data-tip="the mark THIS instance was triggered at \u2014 outcomes are measured from this price">mark</th><th data-tip="when it reached its horizon and was scored \u00b7 open claims show time remaining">resolved</th><th data-tip="signal score at fire time">score</th><th data-tip="at-horizon outcome, signed with the claim (positive = followed through), in the unit the study claims">outcome</th><th data-tip="stop-aware outcome: capped at the frozen void level when it was touched before horizon \u00b7 \u2014 when it coincides with at-horizon">\u26d4</th></tr></thead><tbody>${rows}</tbody></table>`
      :`<div class="sec" style="font-size:11.5px;padding:6px 2px">No claims match${f.ev?` \u2014 no ${esc(evLbl)} claim has ever fired${f.coin?` on ${esc(d.ticker||f.coin)}`:''}`:''}. The history starts with the first fire.</div>`);
    const cb=el('sighist-close'); if(cb) cb.onclick=()=>{ p.hidden=true; const q=el('sighist-q'); if(q) q.value=''; const ee=el('sighist-ev'); if(ee) ee.value=''; };
    p.querySelectorAll('[data-shtk]').forEach(c=>c.addEventListener('click',()=>{ const qi=el('sighist-q'); if(qi) qi.value=c.dataset.shtk; runSigHist(); }));
  }catch(_){ if(seq===_shSeq) p.innerHTML='<div class="msg">Could not load the history \u2014 try again.</div>'; }
}
function runSigHist(){
  const p=el('sighist-panel'); if(!p) return;
  const qi=el('sighist-q'), ei=el('sighist-ev');
  const q=(qi&&qi.value||'').trim().toUpperCase(), ev=(ei&&ei.value)||'';
  if(!q&&!ev){ p.hidden=true; return; }
  if(!q){ loadSigHistory({ev}); return; }   // pure signal-type browse, cross-ticker
  const cand=[]; let exact=null;
  for(const r of state.rows.values()){ if(r.delisted||!inScope(r)) continue; const t=(r.ticker||'').toUpperCase();
    if(t===q){ exact=r; break; } if(t.startsWith(q)) cand.push(r); }
  const pick=exact||(cand.length===1?cand[0]:null);
  if(pick){ loadSigHistory({coin:pick.coin, ticker:pick.ticker, ev}); return; }
  p.hidden=false;
  p.innerHTML=cand.length
    ? `<div class="cp-head">matches <span class="sec" style="font-weight:400">\u2014 pick a ticker</span></div><div class="dsplit" style="flex-wrap:wrap;gap:6px">${cand.slice(0,12).map(r=>`<span class="sigrec-chip" style="cursor:pointer" data-shc="${esc(r.ticker)}">${esc(r.ticker)}</span>`).join('')}</div>`
    : `<div class="sec" style="font-size:11.5px;padding:6px 2px">No ticker matching \u201c${esc(q)}\u201d in this scope.</div>`;
  p.querySelectorAll('[data-shc]').forEach(c=>c.addEventListener('click',()=>{ const q2=el('sighist-q'); if(q2) q2.value=c.dataset.shc; runSigHist(); }));
}
function openSigHistory(ticker){
  showView('signals');
  const q=el('sighist-q'); if(q) q.value=ticker;
  const ee=el('sighist-ev'); if(ee) ee.value='';
  runSigHist();
  const p=el('sighist-panel'); if(p) try{ p.scrollIntoView({block:'nearest'}); }catch(_){}
}
function closeDetail(){ state.detail=null; el('drawer').classList.remove('show'); el('drawerbg').classList.remove('show'); el('drawer').setAttribute('aria-hidden','true'); setHash(state.view==='markets'?'':state.view); }
function toggleWatch(coin){ if(state.watch.has(coin)) state.watch.delete(coin); else state.watch.add(coin); savePrefs(); render(); }

// ===== persistence (localStorage; UI prefs only) =====
let prefsT=null;
function savePrefs(){ clearTimeout(prefsT); prefsT=setTimeout(()=>{ store.set(PKEY, JSON.stringify({
  colOrder:state.colOrder, colHidden:[...state.colHidden], layoutV:LAYOUT_V, tf:state.tf, refreshMs:state.pollMs,
  sortKey:state.sortKey, sortDir:state.sortDir, filterText:state.filter, watch:[...state.watch], watchOnly:!!state.watchOnly,
  filters:{vMin:el('volMin').value,vMax:el('volMax').value,oMin:el('oiMin').value,oMax:el('oiMax').value} })); }, 250); }
function loadPrefs(){ let p; try{ p=JSON.parse(store.get(PKEY)||'null'); }catch(_){ p=null; } if(!p) return;
  if(p.layoutV===LAYOUT_V){ // otherwise a one-time migration leaves the new default layout in place
    if(Array.isArray(p.colOrder)){ const v=p.colOrder.filter(k=>COL_BY_KEY[k]);
      for(const c of COLS) if(!v.includes(c.key)){ v.push(c.key); if(DEFAULT_HIDDEN.includes(c.key)) state.colHidden.add(c.key); }
      state.colOrder=v; }
    if(Array.isArray(p.colHidden)) state.colHidden=new Set(p.colHidden.filter(k=>COL_BY_KEY[k]));
  }
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
  {k:'prem',label:'Premium (bp)',unit:'bp',get:r=>r.prem},
  {k:'sqz',label:'Squeeze (0-100)',unit:'',get:r=>r.sqz},
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
  const vs = m.unit==='%' ? (v>=0?'+':'')+v.toFixed(2)+'%' : m.unit==='$' ? fmtPrice(v) : m.unit==='M' ? fmtUsd(v) : m.unit==='bp' ? (v>=0?'+':'')+v.toFixed(1)+'bp' : (Math.round(v*100)/100);
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

function setHash(h){ try{ history.replaceState(null,'', h?('#'+h):(location.pathname+location.search)); }catch(_){} }
function applyHash(){ let h; try{ h=decodeURIComponent(location.hash.replace(/^#/,'')); }catch(_){ h=''; }
  if(h.indexOf('t=')===0){ const coin=h.slice(2); showView('markets'); if(state.rows.has(coin)) openDetail(coin); return; }
  if(h==='sectors'||h==='corr'||h==='markets'||h==='sessions'||h==='backtest') showView(h); }
let _analyticsInflight=false;
function renderSessions(){ drawSessions(); loadAnalytics(); }
async function loadAnalytics(){
  if(_analyticsInflight) return; _analyticsInflight=true;
  try{ const d=await fetchJSON('/api/analytics'); state.analytics.data=d; state.analytics.err=null; state.analytics.ts=Date.now(); }
  catch(e){ state.analytics.err=e.message||String(e); }
  finally{ _analyticsInflight=false; }
  if(state.view==='sessions') drawSessions();
}
function covPct(n,d){ return d>0?Math.round(100*n/d):0; }
function fp(x,dp){ dp=(dp==null?2:dp); if(x==null||!isFinite(x))return '—'; return (x>0?'+':'')+(x*100).toFixed(dp)+'%'; }
function dcls(x){ return x>0?'pos':(x<0?'neg':'sec'); }
function sessDate(t){ try{ return new Date(t).toLocaleDateString('en-US',{month:'short',day:'numeric'}); }catch(_){ return ''; } }
// Shared interactive hover for line/bar charts: builder registers per-index x-pixels + readout rows,
// the wrapper embeds a crosshair line + a readout box, and attachLineHover wires mousemove to the
// nearest index. Every chart carries hover info (a standing requirement).
let _hoverReg={}, _hoverSeq=0;
function hoverChart(svgInner, o){
  const id='lc'+(++_hoverSeq);
  _hoverReg[id]={ xs:o.xs, rows:o.rows };
  return `<div class="lwrap"><svg id="${id}" class="lchart" viewBox="0 0 ${o.w} ${o.h}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">`+
    svgInner+
    `<line class="lcx" x1="0" y1="${o.pt}" x2="0" y2="${o.h-o.pb}"/></svg>`+
    `<div class="lread" id="${id}-r"></div></div>`;
}
function attachLineHover(){
  document.querySelectorAll('svg.lchart').forEach(svg=>{
    if(svg.dataset.hb) return; svg.dataset.hb='1';   // bind once — this now runs from several render paths
    const reg=_hoverReg[svg.id]; if(!reg||!reg.xs||!reg.xs.length) return;
    const cx=svg.querySelector('.lcx'), read=el(svg.id+'-r'); if(!read) return;
    svg.addEventListener('mousemove',(ev)=>{
      const r=svg.getBoundingClientRect(); if(!r.width) return;
      const vbW=(svg.viewBox&&svg.viewBox.baseVal&&svg.viewBox.baseVal.width)||r.width;
      const px=(ev.clientX-r.left)/r.width*vbW;
      let bi=0,bd=Infinity; for(let i=0;i<reg.xs.length;i++){ const dd=Math.abs(reg.xs[i]-px); if(dd<bd){bd=dd;bi=i;} }
      cx.setAttribute('x1',reg.xs[bi]); cx.setAttribute('x2',reg.xs[bi]); cx.style.opacity='1';
      read.innerHTML=reg.rows[bi]; read.style.opacity='1';
      read.style.left = px > vbW*0.55 ? '10px' : 'auto'; read.style.right = px > vbW*0.55 ? 'auto' : '10px';
    });
    svg.addEventListener('mouseleave',()=>{ if(cx)cx.style.opacity='0'; read.style.opacity='0'; });
  });
}
// ---- shared chart-system helpers (one visual language for the whole tab) ----
function sHead(t,d){ return `<div class="cp-sub s-sec"><span class="t">◆ ${t}</span> <span class="d">— ${d}</span></div>`; }
function sCard(inner){ return `<div class="s-card">${inner}</div>`; }
function sCap(t){ return `<div class="s-cap">${t}</div>`; }
function sLeg(items){ return `<div class="s-leg">`+items.map(it=>{
    const mark = it.shape==='dot'
      ? `<span class="dot" style="${it.ring?`background:transparent;border:1.6px solid ${it.ring}`:`background:${it.color}`}"></span>`
      : `<span class="sw" style="background:${it.color}"></span>`;
    return `<span class="it">${mark}${it.label}</span>`; }).join('')+`</div>`; }
// nice round axis ticks between lo..hi (≈n intervals), and the gridlines+labels for a line chart
function lcTicks(lo,hi,n){ n=n||4; let span=hi-lo; if(!(span>0)) span=1;
  const raw=span/n, mag=Math.pow(10,Math.floor(Math.log10(raw))), norm=raw/mag;
  const step=(norm<1.5?1:norm<3?2:norm<7?5:10)*mag, out=[];
  for(let v=Math.ceil(lo/step)*step; v<=hi+step*1e-6; v+=step) out.push(+v.toFixed(10));
  return out; }
function lcGrid(x0,x1,ticks,Y,fmt){ let s='';
  for(const v of ticks){ const y=Y(v).toFixed(1);
    s+=`<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`+
       `<text x="${x0-6}" y="${(+y+3).toFixed(1)}" text-anchor="end" class="lc-tick">${fmt(v)}</text>`; }
  return s; }
function sessCurveSvg(curve, horizonTs){
  const W=520,H=158, pl=44,pr=50,pt=14,pb=24;
  if(!curve || curve.length<2) return '<div class="msg" style="height:120px;display:flex;align-items:center;justify-content:center">Not enough boundaries yet.</div>';
  const n=curve.length, gs=curve.map(p=>p[1]), ns=curve.map(p=>p[2]);
  let lo=Math.min(0,...gs,...ns), hi=Math.max(0,...gs,...ns);
  if(hi===lo){ hi+=0.01; lo-=0.01; }
  const padd=(hi-lo)*0.1; hi+=padd; lo-=padd;
  const X=i=> pl + (n<=1?0:i/(n-1))*(W-pl-pr);
  const Y=v=> pt + (1-(v-lo)/(hi-lo))*(H-pt-pb);
  const line=idx=> curve.map((p,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(p[idx]).toFixed(1)).join(' ');
  let hIdx=-1; if(horizonTs!=null){ for(let i=0;i<n;i++){ if(curve[i][0]>=horizonTs){ hIdx=i; break; } } }
  // gridlines + % ticks (readable scale)
  let s=lcGrid(pl,W-pr,lcTicks(lo,hi,4),Y,v=>fp(v,1));
  s+=`<line x1="${pl}" y1="${Y(0).toFixed(1)}" x2="${W-pr}" y2="${Y(0).toFixed(1)}" stroke="var(--faint)" stroke-width="1"/>`;
  // shaded gross→net gap = the funding drag, made legible against the compounded swing
  let poly=''; for(let i=0;i<n;i++) poly+=`${X(i).toFixed(1)},${Y(gs[i]).toFixed(1)} `; for(let i=n-1;i>=0;i--) poly+=`${X(i).toFixed(1)},${Y(ns[i]).toFixed(1)} `;
  s+=`<polygon points="${poly.trim()}" fill="var(--accent)" fill-opacity="0.10"/>`;
  if(hIdx>0){ const hx=X(hIdx).toFixed(1);
    s+=`<line x1="${hx}" y1="${pt}" x2="${hx}" y2="${H-pb}" stroke="var(--accent-dim)" stroke-dasharray="2 3" stroke-width="1"/>`;
    s+=`<text x="${hx}" y="${pt+8}" text-anchor="middle" class="lc-tick" style="fill:var(--accent-dim)">funding→</text>`; }
  s+=`<path d="${line(1)}" fill="none" stroke="var(--blue)" stroke-width="1.6"/>`;
  const netDash = hIdx<0 ? ' stroke-dasharray="4 3"' : '';
  s+=`<path d="${line(2)}" fill="none" stroke="var(--accent)" stroke-width="1.8"${netDash}/>`;
  s+=`<circle cx="${X(n-1).toFixed(1)}" cy="${Y(gs[n-1]).toFixed(1)}" r="2.4" fill="var(--blue)"/>`;
  s+=`<circle cx="${X(n-1).toFixed(1)}" cy="${Y(ns[n-1]).toFixed(1)}" r="2.6" fill="var(--accent)"/>`;
  s+=`<text x="${(W-pr+5)}" y="${(Y(gs[n-1])+3).toFixed(1)}" class="lc-end" style="fill:var(--blue)">${fp(gs[n-1],1)}</text>`;
  s+=`<text x="${(W-pr+5)}" y="${(Y(ns[n-1])+3).toFixed(1)}" class="lc-end" style="fill:var(--accent)">${fp(ns[n-1],1)}</text>`;
  s+=`<text x="${pl}" y="${H-7}" class="lc-tick">${sessDate(curve[0][0])}</text>`;
  s+=`<text x="${(W-pr)}" y="${H-7}" text-anchor="end" class="lc-tick">${sessDate(curve[n-1][0])}</text>`;
  const xs=curve.map((_,i)=>X(i));
  const rows=curve.map((p,i)=>`<b style="color:var(--text)">${sessDate(p[0])}</b> · bet ${i+1}/${n}<br><span style="color:var(--blue)">gross ${fp(p[1])}</span> · <span style="color:var(--accent)">net ${fp(p[2])}</span><br><span style="opacity:.7">${p[4]||0} names · funding ${Math.round((p[3]||0)*100)}% known</span>`);
  return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});
}
function renderSessionDecomp(sd){
  const h=sd.headline, S=sd.sessions;
  const funded = h.fundingHorizonTs!=null;
  const dragBp = (h.meanGross - h.meanNet)*1e4;
  const endp = sd.fundingEndpoint==='on' ? 'live funding history' : 'sampled funding';
  const head = `<div style="background:var(--panel2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;padding:16px 18px;margin-bottom:16px">`+
    `<div style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">Overnight · buy at close, sell before open · ${sd.equityCount} equities</div>`+
    `<div style="display:flex;align-items:flex-end;gap:20px;flex-wrap:wrap">`+
      `<div><div style="font-family:var(--mono);font-size:32px;line-height:1" class="${dcls(h.medianNet)}">${fp(h.medianNet)}</div><div class="sec" style="font-size:11px;margin-top:3px">median net / night</div></div>`+
      `<div><div style="font-family:var(--mono);font-size:20px;line-height:1;color:var(--blue)">${fp(h.medianGross)}</div><div class="sec" style="font-size:11px;margin-top:3px">gross / night</div></div>`+
      `<div><div style="font-family:var(--mono);font-size:20px;line-height:1;color:var(--muted)">−${dragBp.toFixed(1)}bp</div><div class="sec" style="font-size:11px;margin-top:3px">funding drag</div></div>`+
      `<div style="width:1px;align-self:stretch;background:var(--border)"></div>`+
      `<div><div style="font-family:var(--mono);font-size:20px;line-height:1" class="${dcls(h.totNet)}">${fp(h.totNet)}</div><div class="sec" style="font-size:11px;margin-top:3px">60d net · gross ${fp(h.totGross)}</div></div>`+
      `<div><div style="font-family:var(--mono);font-size:20px;line-height:1;color:var(--text)">${(h.winNet*100).toFixed(0)}%</div><div class="sec" style="font-size:11px;margin-top:3px">win · ${h.nights} nights</div></div>`+
    `</div>`+
    `<div class="s-cap" style="margin-top:12px">${funded ? `Net-of-funding reliable from <b>${sessDate(h.fundingHorizonTs)}</b> onward (${endp}).` : `Net-of-funding approximate — funding history sparse (${endp}); the dashed net line tracks gross before coverage begins.`}</div></div>`;
  const chart=(key,label)=>{ const x=S[key]; if(!x||!x.n) return '';
    return `<div style="flex:1 1 320px;min-width:290px" class="s-card">`+
      `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px"><span style="color:var(--text);font-size:13px;font-weight:600">${label}</span>`+
      `<span class="sec" style="font-size:11px">net <span class="${dcls(x.totNet)}">${fp(x.totNet)}</span> · ${x.n} bets · win ${(x.winNet*100).toFixed(0)}%</span></div>`+
      sessCurveSvg(x.curve, x.fundingHorizonTs)+`</div>`; };
  const charts = `<div class="s-grid" style="margin-bottom:6px">`+
    chart('overnight','Overnight · close→open')+chart('weekend','Weekend · Fri→Mon')+chart('cash','Cash · open→close')+`</div>`;
  return sHead('Session decomposition','what an overnight / weekend / cash hold actually pays, pooled one bet per calendar boundary across the equity class')+
    head+
    sLeg([{color:'var(--blue)',label:'gross'},{color:'var(--accent)',label:'net of funding'},{shape:'dot',color:'var(--accent)',label:'shaded gap = funding cost'}])+
    charts+
    sCap('Each boundary is one equal-weight bet across every equity that traded it; per-boundary means are compounded. <b>Hover</b> any curve for the date, gross/net, and breadth. The shaded band is the running funding drag.');
}

// ---- hour-of-day activity + funding clocks (ET, midnight at top, clockwise) ----
function clockPolar(cx,cy,r,deg){ const a=deg*Math.PI/180; return [cx+r*Math.cos(a), cy+r*Math.sin(a)]; }
function clockDeg(hf){ return hf*15-90; }   // hour 0 = top; clockwise
function clockWedge(cx,cy,ri,ro,d0,d1){
  const P=(r,a)=>clockPolar(cx,cy,r,a).map(v=>v.toFixed(2));
  const [x0,y0]=P(ri,d0),[x1,y1]=P(ro,d0),[x2,y2]=P(ro,d1),[x3,y3]=P(ri,d1);
  const large=(d1-d0)>180?1:0;
  return `M${x0} ${y0} L${x1} ${y1} A${ro} ${ro} 0 ${large} 1 ${x2} ${y2} L${x3} ${y3} A${ri} ${ri} 0 ${large} 0 ${x0} ${y0} Z`;
}
function clockArc(cx,cy,r,d0,d1){ const P=(a)=>clockPolar(cx,cy,r,a).map(v=>v.toFixed(2)); const [x0,y0]=P(d0),[x1,y1]=P(d1); const large=(d1-d0)>180?1:0; return `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1}`; }
function clockScaffold(cx,cy,ri,ro){
  let s='';
  // US cash-session highlight arc (09:30–16:00 ET)
  s+=`<path d="${clockWedge(cx,cy,ri-3,ro+10,clockDeg(9.5),clockDeg(16))}" fill="var(--blue)" opacity="0.08"/>`;
  // hour ticks + labels every 3h
  for(let h=0;h<24;h+=3){ const [lx,ly]=clockPolar(cx,cy,ro+16,clockDeg(h)); const lab=h===0?'0':(h===12?'12':(''+h));
    s+=`<text x="${lx.toFixed(1)}" y="${(ly+3).toFixed(1)}" text-anchor="middle" class="lc-tick">${lab}</text>`; }
  // open/close ticks
  for(const hh of [9.5,16]){ const [a,b]=clockPolar(cx,cy,ri-3,clockDeg(hh)), [c,d]=clockPolar(cx,cy,ro+3,clockDeg(hh));
    s+=`<line x1="${a.toFixed(1)}" y1="${b.toFixed(1)}" x2="${c.toFixed(1)}" y2="${d.toFixed(1)}" stroke="var(--blue)" stroke-width="1" opacity="0.6"/>`; }
  return s;
}
function activityClockSvg(vec, metric){
  const W=240,H=240, cx=120,cy=120, ri=30, roMax=94;
  const arr = (metric==='volume'?vec.qr:vec.vr)||[];
  const vals = arr.filter(Number.isFinite);
  if(vals.length<6) return '<div class="msg" style="height:200px;display:flex;align-items:center;justify-content:center">Not enough samples yet.</div>';
  const maxV = Math.max(...vals, 1.2);
  const rOf=v=> ri + (v/maxV)*(roMax-ri);
  let s=`<svg viewBox="0 0 ${W} ${H}" class="sclock" style="width:100%;height:auto;display:block">`;
  s+=clockScaffold(cx,cy,ri,roMax);
  // concentric ×-average reference rings + labels (readable magnitude)
  for(let k=0.5;k<=maxV+1e-9;k+=0.5){ if(k<0.5) continue; const r=rOf(k), one=Math.abs(k-1)<1e-9;
    s+=`<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="${one?'var(--muted)':'var(--grid)'}" stroke-width="1"${one?' stroke-dasharray="2 3"':''}/>`;
    if(k%1===0||one) s+=`<text x="${cx+2}" y="${(cy-r+3).toFixed(1)}" class="lc-tick" style="fill:var(--faint)">${k}×</text>`; }
  for(let h=0;h<24;h++){ const val=arr[h]; if(!Number.isFinite(val)) continue;
    const ro=rOf(val), col= val>=1?'var(--accent)':'var(--accent-dim)', op=0.35+0.55*Math.min(1,val/maxV);
    s+=`<path d="${clockWedge(cx,cy,ri,ro,clockDeg(h)+1.4,clockDeg(h+1)-1.4)}" fill="${col}" fill-opacity="${op.toFixed(2)}"><title>${h}:00 ET · ${val.toFixed(2)}× avg${vec.volAbsMean&&metric!=='volume'?' · '+(val*vec.volAbsMean*100).toFixed(2)+'% hourly range':''}</title></path>`; }
  s+=`<circle cx="${cx}" cy="${cy}" r="${ri}" fill="var(--panel)" stroke="var(--border)"/>`;
  s+=`<text x="${cx}" y="${cy-1}" text-anchor="middle" style="font-size:10px;fill:var(--muted)">${metric==='volume'?'volume':'range'}</text>`;
  s+=`<text x="${cx}" y="${cy+11}" text-anchor="middle" style="font-size:8px;fill:var(--faint)">× avg</text>`;
  return s+'</svg>';
}
function fundingClockSvg(fund){
  const W=240,H=240, cx=120,cy=120, ri=44, ro=94;
  const arr = fund||[]; const vals=arr.filter(Number.isFinite);
  if(vals.length<6) return '<div class="msg" style="height:200px;display:flex;align-items:center;justify-content:center">No funding schedule yet.</div>';
  const maxAbs = Math.max(...vals.map(Math.abs))||1e-9;
  let s=`<svg viewBox="0 0 ${W} ${H}" class="sclock" style="width:100%;height:auto;display:block">`;
  s+=clockScaffold(cx,cy,ri,ro);
  for(let h=0;h<24;h++){ const f=arr[h]; if(!Number.isFinite(f)) continue;
    const col = f>0?'var(--down)':'var(--up)';   // >0 longs pay (cost), <0 longs receive
    const op = 0.2 + 0.62*(Math.abs(f)/maxAbs);
    s+=`<path d="${clockWedge(cx,cy,ri,ro,clockDeg(h)+1.4,clockDeg(h+1)-1.4)}" fill="${col}" fill-opacity="${op.toFixed(2)}"><title>${h}:00 ET · ${(f*100).toFixed(4)}%/h · ${f>0?'longs pay':'longs receive'}</title></path>`; }
  const net = arr.reduce((a,b)=>a+(Number.isFinite(b)?b:0),0);
  const netCls = net>0?'--down':(net<0?'--up':'--muted');
  s+=`<circle cx="${cx}" cy="${cy}" r="${ri}" fill="var(--panel)" stroke="var(--border)"/>`;
  s+=`<text x="${cx}" y="${cy-11}" text-anchor="middle" style="font-size:9px;fill:var(--muted)">net / day</text>`;
  s+=`<text x="${cx}" y="${cy+4}" text-anchor="middle" style="font-size:15px;fill:var(${netCls})">${(net>0?'+':'')+(net*100).toFixed(3)}%</text>`;
  s+=`<text x="${cx}" y="${cy+17}" text-anchor="middle" style="font-size:8px;fill:var(--faint)">${(net*365*100>0?'+':'')+(net*365*100).toFixed(0)}%/yr · 1× long</text>`;
  return s+'</svg>';
}
function clockResolve(hc, sel){
  if(sel && sel.indexOf('coin:')===0){ const c=sel.slice(5); const t=(hc.tickers||[]).find(x=>x.coin===c); if(t) return Object.assign({}, t, {label:t.ticker, sub:t.sector+' · '+t.assetClass}); }
  if(sel && sel.indexOf('class:')===0){ const c=sel.slice(6); const p=(hc.pooled.byClass||{})[c]; if(p) return Object.assign({}, p, {label:'Pooled · '+c, sub:p.count+' markets, equal-weight'}); }
  const all=hc.pooled.all||{}; return Object.assign({}, all, {label:'Pooled · all markets', sub:(all.count||0)+' markets, equal-weight'});
}
function peakHour(arr){ let bi=-1,bv=-Infinity; for(let h=0;h<24;h++) if(Number.isFinite(arr[h])&&arr[h]>bv){bv=arr[h];bi=h;} return bi<0?null:bi; }
function renderClocks(hc){
  const st=state.analytics.clock, vec=clockResolve(hc, st.sel);
  const opt=(v,l,sel)=>`<option value="${esc(v)}"${sel===v?' selected':''}>${esc(l)}</option>`;
  const classes=Object.keys(hc.pooled.byClass||{}).sort();
  let selHtml=`<select id="clocksel" class="clocksel">`;
  selHtml+=`<optgroup label="Pooled">`+opt('all','All markets',st.sel)+classes.map(c=>opt('class:'+c, c, st.sel)).join('')+`</optgroup>`;
  const byCls={}; (hc.tickers||[]).forEach(t=>{ (byCls[t.assetClass]=byCls[t.assetClass]||[]).push(t); });
  for(const c of Object.keys(byCls).sort()){ selHtml+=`<optgroup label="${esc(c)}">`+byCls[c].sort((a,b)=>a.ticker<b.ticker?-1:1).map(t=>opt('coin:'+t.coin, t.ticker, st.sel)).join('')+`</optgroup>`; }
  selHtml+=`</select>`;
  const mbtn=(m,l)=>`<button type="button" class="clockmetric${st.metric===m?' on':''}" data-m="${m}">${l}</button>`;
  const controls=`<div class="s-ctrls"><span class="lbl">clock</span>${selHtml}`+
    `<span class="clockseg">${mbtn('vol','range vol')}${mbtn('volume','volume')}</span>`+
    `<span class="rt">${esc(vec.label)} · ${esc(vec.sub||'')}</span></div>`;
  const ph=peakHour(st.metric==='volume'?vec.qr:vec.vr);
  const fh=vec.fund?peakHour(vec.fund.map(Math.abs)):null;
  const twin=`<div class="s-grid">`+
    `<div style="flex:1 1 240px;min-width:230px" class="s-card"><div style="color:var(--text);font-size:13px;font-weight:600;margin-bottom:6px">Activity — when it moves</div>${activityClockSvg(vec, st.metric)}</div>`+
    `<div style="flex:1 1 240px;min-width:230px" class="s-card"><div style="color:var(--text);font-size:13px;font-weight:600;margin-bottom:6px">Funding — <span style="color:var(--up)">receive</span> / <span style="color:var(--down)">pay</span> by hour</div>${fundingClockSvg(vec.fund)}</div>`+
    `</div>`;
  const cap=`Midnight ET at top, clockwise. Left clock: spoke length = that hour's range/volume vs the day's average — rings mark 1×, 2×… and the blue arc is the US cash session. Right clock: color = carry direction, brightness = size. `+
    (ph!=null?`Busiest near <b>${ph}:00 ET</b>`:'')+(fh!=null&&Number.isFinite(vec.fund[fh])?`; strongest carry near <b>${fh}:00 ET</b> (${vec.fund[fh]>0?'longs pay':'longs receive'})`:'')+`. <b>Hover</b> a wedge for exact values.`;
  return sHead('Hour-of-day clocks','the robust timing layer — range volatility, volume and funding by ET hour')+controls+twin+sCap(cap);
}
function attachClockControls(){
  const sel=el('clocksel'); if(sel) sel.addEventListener('change',()=>{ state.analytics.clock.sel=sel.value; drawSessions(); });
  document.querySelectorAll('.clockmetric').forEach(b=>b.addEventListener('click',()=>{ state.analytics.clock.metric=b.dataset.m; drawSessions(); }));
}

// ---- asset-class composite overlays (pooled hour-of-day curves, from the Slice-3 hourClock data) ----
const CLASS_COLORS={ Equity:'var(--accent)', Crypto:'var(--blue)', FX:'var(--up)', Commodity:'#c98a3c', Index:'var(--muted)', 'Pre-IPO':'var(--down)', Rates:'#7d6ff0' };
const CLASS_FALLBACK=['var(--accent)','var(--blue)','var(--up)','var(--down)','var(--muted)','#c98a3c','#7d6ff0'];
function classColor(c,i){ return CLASS_COLORS[c]||CLASS_FALLBACK[i%CLASS_FALLBACK.length]; }
function overlayLineSvg(series, metric){
  const W=560,H=190, pl=48,pr=16,pt=14,pb=26;
  const base = metric==='funding'?0:1;
  let lo=base, hi=base, any=false;
  for(const s of series) for(const v of s.vec) if(Number.isFinite(v)){ lo=Math.min(lo,v); hi=Math.max(hi,v); any=true; }
  if(!any) return '<div class="msg" style="height:150px;display:flex;align-items:center;justify-content:center">No pooled profiles yet.</div>';
  if(hi===lo){ hi+=0.01; lo-=0.01; }
  const padd=(hi-lo)*0.08; hi+=padd; lo-=padd;
  const X=h=> pl + (h/23)*(W-pl-pr);
  const Y=v=> pt + (1-(v-lo)/(hi-lo))*(H-pt-pb);
  const fmtV=(v)=> metric==='funding' ? (v*100).toFixed(4)+'%' : v.toFixed(2)+'×';
  const fmtTick=(v)=> metric==='funding' ? (v*100).toFixed(3)+'%' : v.toFixed(1)+'×';
  let s=`<rect x="${X(9.5).toFixed(1)}" y="${pt}" width="${(X(16)-X(9.5)).toFixed(1)}" height="${H-pt-pb}" fill="var(--blue)" opacity="0.06"/>`;
  s+=lcGrid(pl,W-pr,lcTicks(lo,hi,4),Y,fmtTick);
  s+=`<line x1="${pl}" y1="${Y(base).toFixed(1)}" x2="${W-pr}" y2="${Y(base).toFixed(1)}" stroke="var(--faint)" stroke-dasharray="3 3" stroke-width="1"/>`;
  for(let h=0;h<=24;h+=6){ const hh=Math.min(h,23); s+=`<text x="${X(hh).toFixed(1)}" y="${H-9}" text-anchor="middle" class="lc-tick">${h}</text>`; }
  s+=`<text x="${(pl+W-pr)/2}" y="${H-1}" text-anchor="middle" class="lc-ax">ET hour</text>`;
  for(const ser of series){
    let d='', pen=false;
    for(let h=0;h<24;h++){ const v=ser.vec[h]; if(!Number.isFinite(v)){ pen=false; continue; } d+=(pen?'L':'M')+X(h).toFixed(1)+' '+Y(v).toFixed(1)+' '; pen=true; }
    if(d) s+=`<path d="${d.trim()}" fill="none" stroke="${ser.color}" stroke-width="1.7" stroke-linejoin="round"/>`;
  }
  const xs=[]; for(let h=0;h<24;h++) xs.push(X(h));
  const rows=[]; for(let h=0;h<24;h++){ rows.push(`<b style="color:var(--text)">${h}:00 ET</b><br>`+series.map(ser=>`<span style="color:${ser.color}">${esc(ser.cls)} ${Number.isFinite(ser.vec[h])?fmtV(ser.vec[h]):'—'}</span>`).join('<br>')); }
  return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});
}
function renderClassOverlay(hc){
  const st=state.analytics.overlay, key = st.metric==='volume'?'qr':(st.metric==='funding'?'fund':'vr');
  const byClass=hc.pooled.byClass||{};
  const classes=Object.keys(byClass).sort((a,b)=>(byClass[b].count||0)-(byClass[a].count||0));
  const series=classes.map((c,i)=>({ cls:c, color:classColor(c,i), vec:(byClass[c][key]||[]) }));
  const legend=sLeg(series.map(s=>({color:s.color,label:`${esc(s.cls)} <span style="opacity:.6">${byClass[s.cls].count}</span>`})));
  const mbtn=(m,l)=>`<button type="button" class="ovmetric${st.metric===m?' on':''}" data-m="${m}">${l}</button>`;
  const controls=`<div class="s-ctrls"><span class="lbl">metric</span><span class="clockseg">${mbtn('vol','range vol')}${mbtn('volume','volume')}${mbtn('funding','funding')}</span></div>`;
  const cap = st.metric==='funding'
    ? 'Mean funding rate by ET hour, one line per class. Above the dashed zero = longs pay; below = longs receive. Blue band = US cash session. <b>Hover</b> for exact rates.'
    : 'Each class\'s pooled hour-of-day shape, normalized so 1× is its own daily average — this compares <b>timing</b>, not absolute size. Blue band = US cash session. <b>Hover</b> for values.';
  return sHead('Asset-class overlays','pooled hour-of-day shapes, one line per class')+controls+legend+sCard(overlayLineSvg(series, st.metric))+sCap(cap);
}
function attachOverlayControls(){ document.querySelectorAll('.ovmetric').forEach(b=>b.addEventListener('click',()=>{ state.analytics.overlay.metric=b.dataset.m; drawSessions(); })); }

// ---- day-of-week 7x24 heatmap ----
const WD_NAMES=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const WD_ORDER=[1,2,3,4,5,6,0];   // display Mon..Sun
function dowResolve(dow, sel){
  if(sel && sel.indexOf('class:')===0){ const c=sel.slice(6); const p=(dow.pooled.byClass||{})[c]; if(p) return { grid:p, label:c, count:p.count }; }
  const all=dow.pooled.all||{}; return { grid:all, label:'All markets', count:all.count||0 };
}
function dowHeatSvg(grid, metric){
  const cells = metric==='volume'?grid.volume:grid.vol;
  const ns = grid.n||[];
  if(!cells) return '<div class="msg">No grid yet.</div>';
  const lx=38, cw=Math.max(18,Math.min(30,Math.floor((560-lx-14)/24))), ch=20, top=6, W=lx+cw*24+14, H=top+ch*7+22;
  let cap=0; for(let d=0;d<7;d++)for(let h=0;h<24;h++){ const v=cells[d][h]; if(Number.isFinite(v)&&v>cap)cap=v; } if(!cap)cap=1;
  let s=`<svg viewBox="0 0 ${W} ${H}" class="sheat" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">`;
  const rx=lx+9.5*cw, rw=(16-9.5)*cw;
  s+=`<rect x="${rx.toFixed(1)}" y="${top}" width="${rw.toFixed(1)}" height="${(ch*5)}" fill="var(--blue)" opacity="0.06"/>`;
  for(let row=0;row<7;row++){ const d=WD_ORDER[row]; const y=top+row*ch;
    s+=`<text x="${lx-6}" y="${(y+ch/2+3).toFixed(1)}" text-anchor="end" style="font-size:10px;fill:${(d===0||d===6)?'var(--faint)':'var(--muted)'}">${WD_NAMES[d]}</text>`;
    for(let h=0;h<24;h++){ const x=lx+h*cw; const v=cells[d][h];
      s+=`<rect x="${x}" y="${y}" width="${cw-1}" height="${ch-1}" fill="var(--panel2)"/>`;
      if(Number.isFinite(v)){ const op=Math.max(0.04,Math.min(1,v/cap)); s+=`<rect x="${x}" y="${y}" width="${cw-1}" height="${ch-1}" fill="var(--accent)" fill-opacity="${op.toFixed(3)}"><title>${WD_NAMES[d]} ${h}:00 ET · ${v.toFixed(2)}× avg${ns[d]?' · n='+(ns[d][h]||0):''}</title></rect>`; }
    }
  }
  for(let h=0;h<=24;h+=3){ const hh=Math.min(h,23); const x=lx+hh*cw+cw/2; s+=`<text x="${x.toFixed(1)}" y="${(top+ch*7+13)}" text-anchor="middle" class="lc-tick">${h}</text>`; }
  s+=`<text x="${(lx+cw*24/2).toFixed(1)}" y="${(top+ch*7+21)}" text-anchor="middle" class="lc-ax">ET hour</text>`;
  return s+'</svg>';
}
function renderDow(dow){
  const st=state.analytics.dow, r=dowResolve(dow, st.sel);
  const classes=Object.keys(dow.pooled.byClass||{}).sort();
  const opt=(v,l,sel)=>`<option value="${esc(v)}"${sel===v?' selected':''}>${esc(l)}</option>`;
  let selHtml=`<select id="dowsel" class="clocksel">`+opt('all','All markets',st.sel)+classes.map(c=>opt('class:'+c,c,st.sel)).join('')+`</select>`;
  const mbtn=(m,l)=>`<button type="button" class="dowmetric${st.metric===m?' on':''}" data-m="${m}">${l}</button>`;
  const controls=`<div class="s-ctrls"><span class="lbl">group</span>${selHtml}`+
    `<span class="clockseg">${mbtn('vol','range vol')}${mbtn('volume','volume')}</span>`+
    `<span class="rt">${esc(r.label)} · ${r.count} markets</span></div>`;
  const legend=`<div class="s-leg"><span class="it">less</span>`+
    `<span style="width:120px;height:9px;border-radius:3px;display:inline-block;background:linear-gradient(90deg,var(--panel2),var(--accent))"></span>`+
    `<span class="it">more active vs its own average</span></div>`;
  const cap='Each cell is that weekday-hour\'s range/volume vs the group\'s own average — darker = busier. Blue block = weekday US cash session. Weekend rows sit empty for equities but stay alive for 24/7 crypto — the Friday→Monday gap is the overnight-risk story. <b>Hover</b> a cell for its value and sample count.';
  return sHead('Day-of-week × hour heatmap','the weekend-gap and Friday→Monday risk map')+controls+legend+`<div class="s-card" style="overflow-x:auto">${dowHeatSvg(r.grid, st.metric)}</div>`+sCap(cap);
}
function attachDowControls(){
  const sel=el('dowsel'); if(sel) sel.addEventListener('change',()=>{ state.analytics.dow.sel=sel.value; drawSessions(); });
  document.querySelectorAll('.dowmetric').forEach(b=>b.addEventListener('click',()=>{ state.analytics.dow.metric=b.dataset.m; drawSessions(); }));
}

// ---- cross-ticker clustering (PCA of the normalized 24h vol profile) ----
function clusterScatterSvg(points, classes){
  const W=560,H=360, pl=30,pr=16,pt=16,pb=28;
  if(!points||points.length<2) return '<div class="msg">Not enough markets yet.</div>';
  let xlo=Infinity,xhi=-Infinity,ylo=Infinity,yhi=-Infinity;
  for(const p of points){ xlo=Math.min(xlo,p.x);xhi=Math.max(xhi,p.x);ylo=Math.min(ylo,p.y);yhi=Math.max(yhi,p.y); }
  if(xhi===xlo){xhi+=1;xlo-=1;} if(yhi===ylo){yhi+=1;ylo-=1;}
  const px=(xhi-xlo)*0.08, py=(yhi-ylo)*0.08; xlo-=px;xhi+=px;ylo-=py;yhi+=py;
  const X=v=>pl+(v-xlo)/(xhi-xlo)*(W-pl-pr), Y=v=>pt+(1-(v-ylo)/(yhi-ylo))*(H-pt-pb);
  const cidx={}; classes.forEach((c,i)=>cidx[c]=i);
  let s=`<svg viewBox="0 0 ${W} ${H}" class="lchart" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">`;
  // origin crosshair + axis labels
  if(X(0)>pl&&X(0)<W-pr) s+=`<line x1="${X(0).toFixed(1)}" y1="${pt}" x2="${X(0).toFixed(1)}" y2="${H-pb}" stroke="var(--grid)" stroke-width="1"/>`;
  if(Y(0)>pt&&Y(0)<H-pb) s+=`<line x1="${pl}" y1="${Y(0).toFixed(1)}" x2="${W-pr}" y2="${Y(0).toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`;
  s+=`<text x="${((pl+W-pr)/2).toFixed(1)}" y="${H-6}" text-anchor="middle" class="lc-ax">PC1 — main rhythm axis →</text>`;
  s+=`<text x="11" y="${((pt+H-pb)/2).toFixed(1)}" transform="rotate(-90 11 ${((pt+H-pb)/2).toFixed(1)})" text-anchor="middle" class="lc-ax">PC2 →</text>`;
  for(const p of points){ const col=classColor(p.assetClass, cidx[p.assetClass]||0), cx=X(p.x).toFixed(1), cy=Y(p.y).toFixed(1);
    const tip=`${p.ticker} · ${p.assetClass}${p.odd&&p.bestClass?` — trades like ${p.bestClass} (r ${p.bestCorr}) vs own ${p.ownCorr}`:(p.ownCorr!=null?` — fits its class (r ${p.ownCorr})`:'')}`;
    if(p.odd){ s+=`<circle cx="${cx}" cy="${cy}" r="6.5" fill="none" stroke="var(--down)" stroke-width="1.6"/>`;
      s+=`<circle cx="${cx}" cy="${cy}" r="3.6" fill="${col}"><title>${esc(tip)}</title></circle>`;
      s+=`<text x="${(+cx+8).toFixed(1)}" y="${(+cy+3).toFixed(1)}" style="font-size:9px;fill:var(--down)">${esc(p.ticker)}</text>`; }
    else s+=`<circle cx="${cx}" cy="${cy}" r="3.6" fill="${col}" fill-opacity="0.85"><title>${esc(tip)}</title></circle>`;
  }
  return s+'</svg>';
}
function renderClusters(cl){
  const classes=cl.classes||[];
  const legend=sLeg(classes.map((c,i)=>({shape:'dot',color:classColor(c,i),label:esc(c)})).concat([{shape:'dot',ring:'var(--down)',label:'oddball'}]));
  const ve=cl.varExplained||[0,0];
  const sub=`${cl.count} markets · PC1 ${(ve[0]*100).toFixed(0)}% + PC2 ${(ve[1]*100).toFixed(0)}% of profile variance shown`;
  const odd=(cl.oddballs||[]);
  const oddList = odd.length
    ? `<div class="s-cap" style="line-height:1.7"><b>Oddballs</b> — activity rhythm matches another class:<br>`+
        odd.slice(0,8).map(o=>`<span style="color:var(--down)">${esc(o.ticker)}</span> <span style="opacity:.7">(${esc(o.assetClass)})</span> trades like <b>${esc(o.bestClass)}</b> — r ${o.bestCorr} vs own ${o.ownCorr}`).join('<br>')+`</div>`
    : `<div class="s-cap">No oddballs — every market's 24h rhythm best matches its own class. Taxonomy looks clean.</div>`;
  const cap=`Each market is placed by the shape of its 24-hour volatility profile (when it\'s alive), projected to 2D. Nearby dots = similar rhythm; distance from the origin = how distinctive. Red-ringed dots trade more like a <b>different</b> class than their own. <b>Hover</b> a dot for its class fit.`;
  return sHead('Cross-ticker clustering','markets grouped by when they trade, with the misfits flagged')+
    `<div class="s-cap" style="margin-top:0;margin-bottom:8px">${sub}</div>`+legend+sCard(clusterScatterSvg(cl.points, classes))+sCap(cap)+oddList;
}

// ---- return seasonality by hour (EXPLORATORY / quarantined) ----
function seasonBarSvg(hours){
  const W=560,H=200, pl=46,pr=16,pt=16,pb=26;
  const means=hours.map(h=>h.mean), ses=hours.map(h=>h.se);
  let lo=0,hi=0,any=false;
  for(let i=0;i<24;i++){ const m=means[i],e=ses[i]||0; if(Number.isFinite(m)){ lo=Math.min(lo,m-e); hi=Math.max(hi,m+e); any=true; } }
  if(!any) return '<div class="msg" style="height:150px;display:flex;align-items:center;justify-content:center">No returns yet.</div>';
  if(hi===lo){hi+=0.001;lo-=0.001;} const pad=(hi-lo)*0.12; hi+=pad; lo-=pad;
  const X=h=> pl + (h+0.5)/24*(W-pl-pr);
  const Y=v=> pt + (1-(v-lo)/(hi-lo))*(H-pt-pb);
  const bw=(W-pl-pr)/24*0.66;
  // gridlines in basis points
  let s=lcGrid(pl,W-pr,lcTicks(lo,hi,4),Y,v=>(v*1e4).toFixed(0));
  s+=`<line x1="${pl}" y1="${Y(0).toFixed(1)}" x2="${W-pr}" y2="${Y(0).toFixed(1)}" stroke="var(--faint)" stroke-width="1"/>`;
  s+=`<text x="11" y="${(pt+(H-pt-pb)/2).toFixed(1)}" transform="rotate(-90 11 ${(pt+(H-pt-pb)/2).toFixed(1)})" text-anchor="middle" class="lc-ax">mean bp</text>`;
  s+=`<rect x="${X(9.5).toFixed(1)}" y="${pt}" width="${(X(16)-X(9.5)).toFixed(1)}" height="${H-pt-pb}" fill="var(--blue)" opacity="0.05"/>`;
  for(let h=0;h<24;h++){ const m=means[h]; if(!Number.isFinite(m)) continue; const sig=hours[h].t!=null&&Math.abs(hours[h].t)>=2;
    const col= sig ? (m>=0?'var(--up)':'var(--down)') : 'var(--faint)';
    const y0=Y(0), y1=Y(m), tp=Math.min(y0,y1), hgt=Math.abs(y1-y0);
    s+=`<rect x="${(X(h)-bw/2).toFixed(1)}" y="${tp.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5,hgt).toFixed(1)}" fill="${col}" fill-opacity="${sig?0.9:0.5}"/>`;
    const e=ses[h]||0; if(e>0) s+=`<line x1="${X(h).toFixed(1)}" y1="${Y(m-e).toFixed(1)}" x2="${X(h).toFixed(1)}" y2="${Y(m+e).toFixed(1)}" stroke="var(--muted)" stroke-width="1"/>`;
  }
  for(let h=0;h<=24;h+=3){ const hh=Math.min(h,23); s+=`<text x="${X(hh).toFixed(1)}" y="${H-9}" text-anchor="middle" class="lc-tick">${h}</text>`; }
  s+=`<text x="${((pl+W-pr)/2).toFixed(1)}" y="${H-1}" text-anchor="middle" class="lc-ax">ET hour</text>`;
  const xs=[]; for(let h=0;h<24;h++) xs.push(X(h));
  const rows=hours.map(h=>{ if(h.mean==null) return `<b style="color:var(--text)">${h.h}:00 ET</b><br><span style="opacity:.7">no data</span>`;
    const sig=h.t!=null&&Math.abs(h.t)>=2; return `<b style="color:var(--text)">${h.h}:00 ET</b><br>mean ${(h.mean*1e4).toFixed(1)} bp · t ${h.t}<br><span style="color:${sig?(h.mean>=0?'var(--up)':'var(--down)'):'var(--faint)'}">${sig?'significant':'noise'}</span> · n=${h.n}`; });
  return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});
}
function seasonResolve(se, sel){
  if(sel && sel.indexOf('sec:')===0){ const s=sel.slice(4); const p=se.bySector&&se.bySector[s];
    if(p) return { hours:p.hours, sigCount:p.sigCount, label:s, kind:'sector', n:p.n }; }
  if(sel && sel.indexOf('tk:')===0){ const c=sel.slice(3); const p=se.byTicker&&se.byTicker[c];
    if(p){ const u=(se.universe||[]).find(x=>x.coin===c); return { hours:p.hours, sigCount:p.sigCount, label:u?u.ticker:c, kind:'ticker', sub:u?u.sector:'' }; } }
  const a=se.all||{}, hours=(a.hours&&a.hours.length)?a.hours:(se.hours||[]);   // legacy shape (server predates drill-down) still renders the cross-section
  const sigCount=(a.sigCount!=null?a.sigCount:se.sigCount)||0;
  return { hours, sigCount, label:'All equities', kind:'all', n:se.equityCount };
}
function renderSeasonality(se){
  const st=state.analytics.season, v=seasonResolve(se, st.sel);
  const opt=(val,l,sel)=>`<option value="${esc(val)}"${sel===val?' selected':''}>${esc(l)}</option>`;
  const sectors=Object.keys(se.bySector||{}).sort(), uni=se.universe||[];
  let selHtml=`<select id="seasonsel" class="clocksel">`+opt('all','All equities (cross-section)',st.sel);
  if(sectors.length) selHtml+=`<optgroup label="By sector">`+sectors.map(s=>opt('sec:'+s, `${s} (${se.bySector[s].n})`, st.sel)).join('')+`</optgroup>`;
  if(uni.length) selHtml+=`<optgroup label="By ticker">`+uni.map(u=>opt('tk:'+u.coin, u.ticker, st.sel)).join('')+`</optgroup>`;
  selHtml+=`</select>`;
  const rt = v.kind==='ticker' ? `${esc(v.label)}${v.sub?' · '+esc(v.sub):''} · one name, across days`
          : v.kind==='sector' ? `${esc(v.label)} · ${v.n} stocks, cross-section`
          : `${v.n} equities, cross-section`;
  const controls=`<div class="s-ctrls"><span class="lbl">series</span>${selHtml}<span class="rt">${rt}</span></div>`;
  const isTS = v.kind==='ticker';
  const unit = isTS ? 'each trading day = one observation' : (v.kind==='sector' ? `each of ${v.n} stocks = one observation` : 'each equity = one observation');
  const bannerBody = isTS
    ? `Mean intra-hour return by ET hour for <b style="color:var(--text)">${esc(v.label)}</b> alone, time-series t-test (${unit}). Single-name and noisy — autocorrelation isn't modeled, so treat |t| loosely: <b style="color:var(--text)">${v.sigCount} of 24</b> hours clear |t|≥2. Not a standalone signal.`
    : `Mean intra-hour return by ET hour, cross-sectional t-test (${unit}). Fragile: <b style="color:var(--text)">${v.sigCount} of 24</b> hours clear |t|≥2 and ~1 is expected by chance. Only the colored bars are flagged — never trade this alone.`;
  const banner=`<div style="background:var(--panel2);border:1px solid var(--border);border-left:3px solid var(--down);border-radius:10px;padding:11px 14px;margin-bottom:12px">`+
    `<span style="color:var(--down);font-family:var(--mono);font-size:11px;letter-spacing:.5px;font-weight:600">⚠ EXPLORATORY</span> `+
    `<span class="sec" style="font-size:12px">${bannerBody}</span></div>`;
  const cap = `Bar height = mean return in basis points; whiskers = ±1 standard error across ${isTS?"this name's trading days":'the cross-section'}. Grey bars are noise; green/red bars cleared |t|≥2. Blue band = US cash session. <b>Hover</b> a bar for its mean, t-stat and sample size.`;
  return sHead('Return seasonality by hour','quarantined — pick all, a sector or one name; grey is noise, colored cleared significance')+controls+banner+sCard(seasonBarSvg(v.hours))+sCap(cap);
}
function attachSeasonControls(){ const sel=el('seasonsel'); if(sel) sel.addEventListener('change',()=>{ state.analytics.season.sel=sel.value; drawSessions(); }); }
function drawSessions(){
  const host=el('sessions-body'); if(!host) return;
  // GC stale hover entries instead of wiping the registry: hoverChart is now also used by the
  // drawer candle chart, which must survive a sessions re-render. _hoverSeq is never reset —
  // resetting it could reissue an id that a still-live chart owns.
  for(const id in _hoverReg) if(!document.getElementById(id)) delete _hoverReg[id];
  const a=state.analytics.data, err=state.analytics.err;
  const head=`<div class="cp-head" style="margin-bottom:4px">Session &amp; time-of-day analytics</div>`+
    `<div class="sec" style="margin-bottom:16px;max-width:680px;line-height:1.55">Server-side studies of when each market is alive and what an overnight / weekend / cash hold actually pays — built on the 60-day hourly price &amp; funding spines. Panels unlock here as coverage accrues.</div>`;
  if(err && !a){ host.innerHTML=head+`<div class="msg">Couldn't load analytics: ${esc(err)}. Retrying on the next refresh.</div>`; return; }
  if(!a || !a.coverage || !a.coverage.hourly){ host.innerHTML=head+`<div class="msg">Computing… warming up the spines.</div>`; return; }
  const c=a.coverage, w=a.window||{}, hr=c.hourly||{}, fund=c.funding||{};
  const endpoint = fund.endpoint==='on' ? '<span class="pos">live history</span>' : '<span class="sec">sampled fallback</span>';
  const card=(label,val,sub)=>`<div class="s-stat"><div class="k">${label}</div><div class="v">${val}</div>`+
    (sub?`<div class="s">${sub}</div>`:'')+`</div>`;
  const cards=`<div class="s-grid" style="margin-bottom:18px">`+
    card('Markets', c.markets, `${c.equityMarkets} equity`)+
    card('Hourly spine', hr.coins||0, `${(hr.candles||0).toLocaleString()} candles · ${w.hourlyDays||60}d`)+
    card('Funding spine', fund.coins||0, `${(fund.points||0).toLocaleString()} pts · ${endpoint}`)+
    card('Ready', `${c.ready}/${c.markets}`, `≥ ${Math.round((c.readyHours||480)/24)}d hourly · ${covPct(c.ready,c.markets)}%`)+
    `</div>`;
  const rp=covPct(c.ready,c.markets);
  const bar=`<div style="margin-bottom:8px"><div class="sec" style="font-size:11px;margin-bottom:6px">Spine readiness — session studies unlock as this fills · <b style="color:var(--text)">${rp}%</b></div>`+
    `<div style="height:8px;border-radius:4px;background:var(--grid);overflow:hidden"><div style="height:100%;width:${rp}%;background:var(--accent);transition:width .4s"></div></div></div>`;
  let panels=[
    ['Session decomposition','cash / overnight / weekend equity curves, gross &amp; net-of-funding','★★★★★'],
    ['Hour-of-day activity clock','volatility · volume · funding per ticker','★★★★☆'],
    ['Funding clock','when carry is with you or against you, on a schedule','★★★★☆'],
    ['Cross-ticker clustering','group markets by when they trade; flag the oddballs','★★★★☆'],
    ['Asset-class overlays','pooled hour-of-day curves per class','★★★☆☆'],
    ['Day-of-week 7×24 heatmap','weekend-gap &amp; Friday→Monday risk','★★★☆☆'],
    ['Return seasonality by hour','exploratory · significance-flagged','★★☆☆☆'],
  ];
  const sd = a.sections && a.sections.sessionDecomp;
  let flagship='';
  if(sd && !sd.pending){ flagship = renderSessionDecomp(sd); panels = panels.filter(p=>p[0]!=='Session decomposition'); }
  else if(sd && sd.pending){ panels[0]=['Session decomposition',`computing — needs ≥${sd.need} equities with ≥3d hourly spine (have ${sd.equityCount})`,'★★★★★']; }
  const hc = a.sections && a.sections.hourClock;
  let clocks='', overlay='';
  if(hc && !hc.pending){ clocks = renderClocks(hc); panels = panels.filter(p=>p[0]!=='Hour-of-day activity clock' && p[0]!=='Funding clock');
    if(hc.pooled && hc.pooled.byClass && Object.keys(hc.pooled.byClass).length){ overlay = renderClassOverlay(hc); panels = panels.filter(p=>p[0]!=='Asset-class overlays'); }
  }
  else if(hc && hc.pending){ const ci=panels.findIndex(p=>p[0]==='Hour-of-day activity clock'); if(ci>=0) panels[ci]=['Hour-of-day activity clock',`computing — needs ≥3 markets with ≥5d hourly spine (have ${hc.count})`,'★★★★☆']; }
  const dow = a.sections && a.sections.dow;
  let dowBlock='';
  if(dow && !dow.pending){ dowBlock = renderDow(dow); panels = panels.filter(p=>p[0]!=='Day-of-week 7×24 heatmap'); }
  else if(dow && dow.pending){ const di=panels.findIndex(p=>p[0]==='Day-of-week 7×24 heatmap'); if(di>=0) panels[di]=['Day-of-week 7×24 heatmap',`computing — needs ≥3 markets with ≥5d hourly spine (have ${dow.count})`,'★★★☆☆']; }
  const cl = a.sections && a.sections.clusters;
  let clBlock='';
  if(cl && !cl.pending){ clBlock = renderClusters(cl); panels = panels.filter(p=>p[0]!=='Cross-ticker clustering'); }
  else if(cl && cl.pending){ const ci=panels.findIndex(p=>p[0]==='Cross-ticker clustering'); if(ci>=0) panels[ci]=['Cross-ticker clustering',`computing — needs ≥8 markets with an hourly profile (have ${cl.count||0})`,'★★★★☆']; }
  const se = a.sections && a.sections.seasonality;
  let seBlock='';
  if(se && !se.pending){ seBlock = renderSeasonality(se); panels = panels.filter(p=>p[0]!=='Return seasonality by hour'); }
  else if(se && se.pending){ const si=panels.findIndex(p=>p[0]==='Return seasonality by hour'); if(si>=0) panels[si]=['Return seasonality by hour',`computing — needs ≥${se.need||8} equities with ≥5d hourly spine (have ${se.count||0})`,'★★☆☆☆']; }
  const deck = panels.length
    ? `<div class="cp-sub" style="margin:22px 0 10px">On deck</div>`+
      `<div style="display:flex;flex-direction:column;gap:1px;background:var(--border);border:1px solid var(--border);border-radius:8px;overflow:hidden">`+
      panels.map(p=>`<div style="display:flex;align-items:baseline;gap:12px;padding:10px 14px;background:var(--panel);flex-wrap:wrap">`+
        `<span style="color:var(--accent);font-size:11px;letter-spacing:1px;min-width:52px">${p[2]}</span>`+
        `<span style="min-width:180px;color:var(--text)">${p[0]}</span>`+
        `<span class="sec" style="font-size:12px;flex:1 1 200px">${p[1]}</span>`+
        `<span class="sec" style="margin-left:auto;font-size:10.5px;opacity:.7;text-transform:uppercase;letter-spacing:.5px">pending</span>`+
        `</div>`).join('')+`</div>`
    : `<div class="sec" style="margin:22px 0 4px;font-size:12px;opacity:.8">All seven studies live. ◆</div>`;
  const age=a.ts?`updated ${Math.max(0,Math.round((Date.now()-a.ts)/1000))}s ago`:'';
  host.innerHTML=head+cards+bar+flagship+clocks+overlay+dowBlock+clBlock+seBlock+deck+`<div class="sec" style="margin-top:12px;font-size:11px">${age}</div>`;
  if(hc && !hc.pending){ attachClockControls(); if(overlay) attachOverlayControls(); }
  if(dow && !dow.pending) attachDowControls();
  if(se && !se.pending) attachSeasonControls();
  attachLineHover();
}
// ===== Strategy backtest — client-side, cross-sectional long/short on the daily returns already loaded =====
// Everything runs in-browser off state.rows[*].daily (shipped via /api/daily) + the SP500 benchmark, so
// parameter tweaks are instant and add no server load. Non-fitted ranking rules: the honest overfitting
// risk is the user picking params by eye, which the in-sample/out-of-sample split is there to expose.
const BT_MIN_DAYS=25, BT_ANN=252;
const BT_SIGNALS={ mom:'Momentum', rev:'Short-term reversion', res:'Residual momentum (β-neutral)', lowvol:'Low volatility' };
function btUniverse(){
  const u=state.backtest.universe;
  return [...state.rows.values()].filter(r=>{
    if(r.uni==='main') return false;
    if(r.delisted || !r.daily || r.coin===state.benchCoin) return false;
    const m=dailyReturns(r); if(!m || m.size<BT_MIN_DAYS) return false;
    if(u==='eq') return r.assetClass==='Equity';
    if(u && u.indexOf('sec:')===0) return r.sector===u.slice(4);
    return true;
  });
}
function btMatrix(){
  const rows=btUniverse(), dayset=new Set(), rmap=new Map();
  for(const r of rows){ const m=dailyReturns(r); rmap.set(r.coin,m); for(const d of m.keys()) dayset.add(d); }
  const days=[...dayset].sort((a,b)=>a-b), idx=new Map(days.map((d,i)=>[d,i]));
  const series=new Map();                                   // dense per-name log-return series over the common day axis (NaN where missing)
  for(const r of rows){ const m=rmap.get(r.coin), a=new Float64Array(days.length).fill(NaN);
    for(const [d,v] of m) a[idx.get(d)]=v; series.set(r.coin,a); }
  let benchSeries=null; const bench=state.benchCoin?state.rows.get(state.benchCoin):null;
  if(bench){ const bm=dailyReturns(bench); if(bm){ benchSeries=new Float64Array(days.length).fill(NaN); for(const [d,v] of bm) if(idx.has(d)) benchSeries[idx.get(d)]=v; } }
  const fund=new Map();                                     // per-name daily funding a 1x long pays (0 where unknown), aligned to the day axis
  let fundCov=0;
  for(const r of rows){ const fm=dailyFunding(r); if(fm && fm.size){ const a=new Float64Array(days.length).fill(0); for(const [d,v] of fm) if(idx.has(d)) a[idx.get(d)]=v; fund.set(r.coin,a); fundCov++; } }
  const ovG=new Map(), ovF=new Map(); let ovCov=0;          // overnight+weekend hold: gross return (NaN where no hold that morning) and the funding paid during the hold
  for(const r of rows){ const ov=overnightReturns(r); if(ov && ov.g.size){ const g=new Float64Array(days.length).fill(NaN), f=new Float64Array(days.length).fill(0);
      for(const [d,v] of ov.g) if(idx.has(d)){ g[idx.get(d)]=v; f[idx.get(d)]=ov.f.get(d)||0; } ovG.set(r.coin,g); ovF.set(r.coin,f); ovCov++; } }
  return { rows, days, series, benchSeries, fund, fundCov, ovG, ovF, ovCov };
}
// signal score for one name at day-index di over a trailing L-day window (uses returns through di only — no lookahead)
function btScore(sig, a, bench, di, L){
  const lo=di-L+1; if(lo<0) return NaN;
  if(sig==='rev'){ const v=a[di]; return Number.isFinite(v)? -v : NaN; }            // fade the most recent day
  if(sig==='res'){                                                                   // cumulative return net of a within-window β to the benchmark
    let mn=0,mb=0,cn=0; for(let i=lo;i<=di;i++){ const x=a[i], y=bench?bench[i]:NaN; if(Number.isFinite(x)&&Number.isFinite(y)){ mn+=x; mb+=y; cn++; } }
    if(cn<Math.max(5,L*0.6)) return NaN; mn/=cn; mb/=cn;
    let c=0,vb=0,sx=0,sy=0; for(let i=lo;i<=di;i++){ const x=a[i], y=bench?bench[i]:NaN; if(Number.isFinite(x)&&Number.isFinite(y)){ c+=(x-mn)*(y-mb); vb+=(y-mb)*(y-mb); sx+=x; sy+=y; } }
    return sx-(vb>0?c/vb:0)*sy;
  }
  let sum=0,sq=0,n=0; for(let i=lo;i<=di;i++){ const x=a[i]; if(Number.isFinite(x)){ sum+=x; sq+=x*x; n++; } }
  if(n<Math.max(5,L*0.6)) return NaN;
  if(sig==='lowvol'){ const mean=sum/n, varr=(sq-n*mean*mean)/Math.max(1,n-1); return -Math.sqrt(Math.max(0,varr)); }  // low vol ranks high
  // momentum: skip the most recent day so 1-day reversion doesn't contaminate the trend
  let s2=0,n2=0; for(let i=lo;i<=di-1;i++){ const x=a[i]; if(Number.isFinite(x)){ s2+=x; n2++; } }
  return n2>=Math.max(4,L*0.5)? s2 : NaN;
}
function btRun(){
  const p=state.backtest, mx=btMatrix();
  if(mx.rows.length<8 || mx.days.length<p.lookback+p.cadence+6) return { ok:false, have:mx.rows.length, days:mx.days.length };
  const { rows, days, series, benchSeries, fund, fundCov, ovG, ovF, ovCov }=mx, coins=rows.map(r=>r.coin);
  const L=p.lookback, cad=Math.max(1,p.cadence), q=p.quantile, costR=p.cost/1e4, start=L, on=p.holdWindow==='on';
  let weights=new Map(), lastBook=null, feeCum=0, fundCum=0;
  const tkOf=new Map(rows.map(r=>[r.coin, r.ticker]));
  const portR=[], eq=[1], eqg=[1], eqb=[1], eqew=[1], curveDays=[days[start]];
  let turnoverSum=0, rebalances=0, posSum=0, posCount=0;
  for(let di=start; di<days.length-1; di++){
    if((di-start)%cad===0){                                          // rebalance
      const scored=[];
      for(const c of coins){ const raw=btScore(p.signal, series.get(c), benchSeries, di, L);
        if(Number.isFinite(raw)) scored.push({ c, raw, s:(p.direction==='low'? -raw : raw) }); }  // s = the quantity we go long on
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
function btVol(a, di, L){ const lo=di-L+1; if(lo<0) return 0; let s=0,sq=0,n=0;
  for(let i=lo;i<=di;i++){ const x=a[i]; if(Number.isFinite(x)){ s+=x; sq+=x*x; n++; } }
  if(n<3) return 0; const m=s/n; return Math.sqrt(Math.max(0,(sq-n*m*m)/(n-1))); }
function btStats(portR, eqSeg){
  const n=portR.length; if(!n||eqSeg.length<2) return null;
  let mean=0; for(const x of portR) mean+=x; mean/=n;
  let v=0; for(const x of portR) v+=(x-mean)*(x-mean); const sd=Math.sqrt(v/Math.max(1,n-1));
  let hit=0; for(const x of portR) if(x>0) hit++;
  const total=eqSeg[eqSeg.length-1]/eqSeg[0]-1;
  let peak=eqSeg[0], mdd=0; for(const e of eqSeg){ if(e>peak) peak=e; const dd=e/peak-1; if(dd<mdd) mdd=dd; }
  return { total, sharpe: sd>0? mean/sd*Math.sqrt(BT_ANN):0, hit:hit/n, mdd, n };
}
// equity curve: net (accent) / gross (blue) / benchmark (muted) / equal-weight (faint); IS|OOS split shaded; crosshair hover
function btCurveSvg(res, splitIdx){
  const W=680,H=210, pl=48,pr=54,pt=14,pb=26, days=res.days, m=days.length;
  const pct=arr=>arr.map(e=>(e/arr[0]-1)*100);
  const net=pct(res.eq), gross=pct(res.eqg), bench=pct(res.eqb), ew=pct(res.eqew);
  let lo=Infinity,hi=-Infinity; for(const arr of [net,gross,bench,ew]) for(const y of arr){ if(y<lo)lo=y; if(y>hi)hi=y; }
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
  s+=`<path d="${path(ew)}" fill="none" stroke="var(--faint)" stroke-width="1"/>`;
  s+=`<path d="${path(bench)}" fill="none" stroke="var(--muted)" stroke-width="1.2"/>`;
  s+=`<path d="${path(gross)}" fill="none" stroke="var(--blue)" stroke-width="1.2" opacity="0.85"/>`;
  s+=`<path d="${path(net)}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
  const endLab=(arr,col)=>`<text x="${(W-pr+4)}" y="${(Y(arr[m-1])+3).toFixed(1)}" style="font-size:9px;fill:${col}">${(arr[m-1]>0?'+':'')+arr[m-1].toFixed(1)}%</text>`;
  s+=endLab(net,'var(--accent)');
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
      `<span style="color:var(--faint)">EW ${(ew[i]>0?'+':'')+ew[i].toFixed(2)}%</span>`;
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
function renderBacktest(){
  const p=state.backtest;
  const res=btRun();
  const head=sHead('Strategy backtest','define a cross-sectional rule and test it net of costs — in-sample vs out-of-sample');
  // controls
  const opt=(v,l,cur)=>`<option value="${esc(v)}"${cur===v?' selected':''}>${esc(l)}</option>`;
  const seg=(id,cur,opts)=>`<div class="seg" id="${id}">`+opts.map(([v,l])=>`<button data-v="${v}"${String(cur)===String(v)?' class="active"':''}>${l}</button>`).join('')+`</div>`;
  const sectors=[...new Set([...state.rows.values()].filter(r=>r.assetClass==='Equity'&&r.sector).map(r=>r.sector))].sort();
  let uniSel=`<select id="btUni" class="clocksel">`+opt('all','All markets',p.universe)+opt('eq','Equities only',p.universe);
  if(sectors.length) uniSel+=`<optgroup label="By sector">`+sectors.map(sc=>opt('sec:'+sc, sc, p.universe)).join('')+`</optgroup>`;
  uniSel+=`</select>`;
  let sigSel=`<select id="btSig" class="clocksel">`+Object.keys(BT_SIGNALS).map(k=>opt(k,BT_SIGNALS[k],p.signal)).join('')+`</select>`;
  const controls=
    `<div class="s-ctrls"><span class="lbl">signal</span>${sigSel}<span class="lbl">universe</span>${uniSel}`+
    `<span class="lbl">hold</span>${seg('btHold',p.holdWindow,[['cc','close→close'],['on','overnight']])}</div>`+
    `<div class="s-ctrls"><span class="lbl">lookback</span>${seg('btLb',p.lookback,[[5,'5d'],[10,'10d'],[20,'20d'],[40,'40d']])}`+
    `<span class="lbl">rebalance</span>${seg('btCad',p.cadence,[[1,'1d'],[5,'5d'],[10,'10d']])}`+
    `<span class="lbl">book</span>${seg('btQ',p.quantile,[[0.1,'10%'],[0.2,'20%'],[0.33,'33%'],[1,'all']])}`+
    `<span class="lbl">taker bps</span>${seg('btCost',p.cost,[[0,'0'],[5,'5'],[10,'10'],[20,'20']])}`+
    `<span class="lbl">in-sample</span>${seg('btSplit',p.split,[[0.5,'50%'],[0.6,'60%'],[0.7,'70%']])}</div>`+
    `<div class="s-ctrls"><span class="lbl">direction</span>${seg('btDir',p.direction,[['high','long strong'],['low','long weak']])}`+
    `<span class="lbl">structure</span>${seg('btStruct',p.structure,[['ls','long / short'],['long','long-only'],['short','short-only']])}`+
    `<span class="lbl">weighting</span>${seg('btWt',p.weighting,[['eq','equal'],['sig','by signal'],['vol','inverse-vol']])}`+
    `<span class="lbl">gate</span>${seg('btReq',p.reqSign?'sign':'any',[['any','any rank'],['sign','signal must agree']])}</div>`;
  if(!res.ok){
    return head+controls+sCard(`<div class="msg" style="height:150px;display:flex;align-items:center;justify-content:center">Not enough daily history yet — ${res.have||0} names, need 8 with ≥${BT_MIN_DAYS}d. Fills in as /api/daily loads.</div>`);
  }
  const m=res.days.length, splitIdx=Math.max(1,Math.min(m-2,Math.floor(m*p.split)));
  const isR=res.portR.slice(0,splitIdx), oosR=res.portR.slice(splitIdx);
  const isE=res.eq.slice(0,splitIdx+1), oosE=res.eq.slice(splitIdx);
  const full=btStats(res.portR,res.eq), is=btStats(isR,isE), oos=btStats(oosR,oosE);
  const stats=`<div class="s-grid" style="margin:12px 0 4px">`+
    btStatBox('In-sample',is,'var(--blue)')+btStatBox('Out-of-sample',oos,'var(--accent)')+btStatBox('Full period',full,'var(--text)')+
    `<div class="s-stat"><div class="s-k">Frictions</div>`+
      `<div class="s-row"><span>universe</span><b>${res.universeN}</b></div>`+
      `<div class="s-row"><span>turnover</span><b>${(res.turnover*100).toFixed(0)}%</b></div>`+
      `<div class="s-row"><span>funding</span>${res.fundCov>0?`<b class="${res.fundCum>=0?'pos':'neg'}">${(res.fundCum>0?'+':'')+(res.fundCum*100).toFixed(1)}%</b>`:`<b class="sec" title="funding not loaded — update the server">—</b>`}</div>`+
      `<div class="s-row"><span>fees</span><b class="neg">−${(res.feeCum*100).toFixed(1)}%</b></div></div></div>`;
  const leg=sLeg([{color:'var(--accent)',label:'net'},{color:'var(--blue)',label:'gross'},{color:'var(--muted)',label:'benchmark'},{color:'var(--faint)',label:'equal-weight'}]);
  const pctq=(p.quantile*100).toFixed(0), dirTop=p.direction==='high'?'top':'bottom';
  const structTxt = p.structure==='long' ? `<b>long-only</b>, holding the ${dirTop} ${pctq}%`
    : p.structure==='short' ? `<b>short-only</b>, shorting the ${p.direction==='high'?'bottom':'top'} ${pctq}%`
    : `<b>long/short</b> — long the ${dirTop} ${pctq}%, short the other tail, dollar-neutral`;
  const wtTxt = p.weighting==='sig'?'signal-weighted':p.weighting==='vol'?'inverse-vol weighted':'equal-weight';
  const cap = p.holdWindow==='on'
    ? `<b>Overnight hold.</b> Each night buy the book at the 16:00 ET close and sell at the next 09:30 ET open (Fri→Mon over the weekend), flat during the cash session — ${structTxt}, ${wtTxt}. The book round-trips every night, so it pays the ${p.cost}bp taker fee twice a night (that's the big drag here), plus the funding accrued over each hold. Gross is price-only; the gross↔net gap is fees + funding. Uses the close→open boundary holds from the hourly spine${res.ovCov>0?'':' — not loaded yet, so this is empty until the server ships them'}. Shaded = out-of-sample. Slippage not modeled. <b>Hover</b> the curve. Not a live trade signal.`
    : `Each rebalance, rank the universe by ${BT_SIGNALS[p.signal].toLowerCase()} and go ${structTxt}, ${wtTxt}, held to the next rebalance. Net of a ${p.cost}bp market-order taker fee on turnover and the actual funding each position pays or earns while held${res.fundCov>0?'':' — funding not loaded yet, so this is price-only until the server ships it'}. Gross line is price-only; the gross↔net gap is your funding + fee drag. Shaded region is out-of-sample. In-sample-selected, slippage not yet modeled, ~2 months of the current universe. <b>Hover</b> the curve. Not a live trade signal.`;
  return head+controls+stats+btBookPanel(res.book)+leg+sCard(btCurveSvg(res,splitIdx))+sCap(cap);
}
function attachBtControls(){
  const sig=el('btSig'); if(sig) sig.addEventListener('change',()=>{ state.backtest.signal=sig.value; drawBacktest(); });
  const uni=el('btUni'); if(uni) uni.addEventListener('change',()=>{ state.backtest.universe=uni.value; drawBacktest(); });
  const segWire=(id,key,num)=>{ const g=el(id); if(!g) return; g.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{ state.backtest[key]=num?parseFloat(b.dataset.v):b.dataset.v; drawBacktest(); })); };
  segWire('btLb','lookback',true); segWire('btCad','cadence',true); segWire('btQ','quantile',true); segWire('btCost','cost',true); segWire('btSplit','split',true);
  segWire('btDir','direction',false); segWire('btStruct','structure',false); segWire('btWt','weighting',false); segWire('btHold','holdWindow',false);
  const rq=el('btReq'); if(rq) rq.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{ state.backtest.reqSign=(b.dataset.v==='sign'); drawBacktest(); }));
}
function drawBacktest(){ const host=el('backtest-body'); if(!host) return; host.innerHTML=renderBacktest(); attachBtControls(); attachLineHover(); }
async function renderBacktest_load(){ drawBacktest(); if(![...state.rows.values()].some(r=>r.daily)){ await loadDaily(); if(state.view==='backtest') drawBacktest(); } }

function updateBenchNote(){ const bn=el('benchnote'); if(!bn) return;
  const bc=scopeBench(); bn.textContent=(bc&&state.rows.get(bc))?state.rows.get(bc).ticker:'not found'; }
function setScope(v){
  if(v!=='stocks'&&v!=='crypto') return;
  if(state.scope===v) return;
  state.scope=v;
  try{ localStorage.setItem('xyz-scope',v); }catch(_){}
  applyScope();
}
function applyScope(){
  const cr=state.scope==='crypto';
  document.querySelectorAll('.tabs .tab').forEach(b=>{ b.hidden = cr && b.dataset.view!=='markets'; });
  document.querySelectorAll('[data-scope]').forEach(b=>b.classList.toggle('on', b.dataset.scope===state.scope));
  if(cr && state.view!=='markets') { showView('markets'); }
  buildHead(); render(); updateAggregates(); updateMovers(); updateBenchNote();
  renderRegimeStrip();   // stocks: correlation regime; crypto: the crypto tape strip
}
function showView(v){
  if(state.scope==='crypto' && v!=='markets') v='markets';   // crypto scope is Markets-only by design
  { const hm=el('helpmodal'); if(hm&&!hm.hidden) closeHelp(); }   // help is per-tab — never leave a stale explainer open across a switch
  state.view=v;
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.view===v));
  const setHidden=(id,hidden)=>{ const e=el(id); if(e) e.hidden=hidden; };   // null-safe: a stale index.html missing a section can't break navigation
  setHidden('view-markets', v!=='markets');
  setHidden('view-sectors', v!=='sectors');
  setHidden('view-corr', v!=='corr');
  setHidden('view-sessions', v!=='sessions');
  setHidden('view-signals', v!=='signals');
  setHidden('view-backtest', v!=='backtest');
  if(v==='corr') openCorr();
  if(v==='sessions') renderSessions();
  if(v==='signals'){ if(el('view-signals')) openSignals(); else { showView('markets'); return; } }
  if(v==='backtest'){ if(el('view-backtest')) renderBacktest_load(); else { showView('markets'); return; } }
  if(v==='sectors') renderSectors();
  if(!state.detail) setHash(v==='markets'?'':v);
}

// ===== signals tab =====
// Server-ranked live conditions. Each row = a condition on one market + that market's OWN
// historical base rate for the same event (median forward return, hit rate, n). Anything with
// n < 8 wears an "unproven" badge instead of being hidden or oversold.
let _sigLast=0;
async function loadSignals(){
  try{ const d=await fetchJSON('/api/signals'); _sigLast=Date.now();
    if(d&&Array.isArray(d.signals)){ state.signals=d;
      const tb=el('tab-signals'); if(tb) tb.textContent = d.count>0 ? `Signals (${d.count})` : 'Signals';
      if(!el('view-signals').hidden) renderSignals(); }
  }catch(_){}
}
function openSignals(){ renderSignals(); if(Date.now()-_sigLast>30*1000) loadSignals(); }
const EV_LABELS={bigmove:'Big move',breakout:'30d-high breakout',breakdown:'30d-low breakdown',volshift:'Vol expansion',gap:'Outsized gap',fundflip:'Funding flip',squeeze:'Squeeze setup',unwind:'Long unwind',oiflush:'OI flush',fpdiv:'Funding\u2013price divergence',coil:'Range compression',ondrift:'Overnight drift',prem:'Premium dislocation',volume:'Volume surge'};
const EV_TIP={
  bigmove:'Today\u2019s move is \u22652\u03c3 of this market\u2019s own trailing 30d daily returns. History measures whether such moves continued (positive) or faded (negative) the next day, signed with the move.',
  breakout:'First close/mark above the prior 30-day high. History: forward 5d return after past first-crosses on this market.',
  volshift:'10d realized vol crossed above the 90th percentile of its own trailing ~6 months. History: forward 5d return after past expansions.',
  breakdown:'Close crossed below the prior 30d low. Forward 5d study, signed with the breakdown \u2014 the bearish mirror of the breakout.',gap:'The live move since the last cash close is outsized vs this market\u2019s own gap distribution. History: did the next cash session continue (positive) or fade (negative) such gaps?',
  fundflip:'Day-summed funding changed sign after \u22653 days pinned the other way \u2014 the crowd switched sides. History: 3d move toward the new crowd.',
  squeeze:'Crowded shorts (negative 7d funding) \u00d7 OI building \u00d7 price pressing the range \u2014 the squeeze spring is loaded. No historical study yet: needs longer OI history.',
  unwind:'Crowded longs paying funding while OI builds and price sits near range lows \u2014 the bearish mirror of the squeeze. Their liquidation is the seller of last resort.',oiflush:'7d \u0394OI collapsed below \u22122\u03c3 of this market\u2019s own distribution while price fell \u2014 forced deleveraging exhausting itself. Flushes measure positions destroyed, not price traveled; the claim is a 5d bottoming thesis.',fpdiv:'Funding trajectory diverging from the tape: strength while funding falls = shorts pressing into a rising market (squeeze-adjacent, long); weakness while funding rises = longs averaging down into a falling one (fragile, short). 3d horizon, with the divergence.',coil:'10d realized vol in the bottom decile of its own trailing 120 observations \u2014 the spring is loaded, direction unknown. Context only: it never claims a side; it exists to corroborate a breakout or breakdown firing OUT of the compression.',ondrift:'This market\u2019s summed off-hours drift over ~21 closed windows sits \u22652\u03c3 from the universe. The claim covers ONLY the next 5 overnight windows held close\u2192open \u2014 the structural edge of a venue where cash-hours assets trade 24/7. Ships without a backtest study by design: it earns trust purely out of sample.',prem:'Perp price dislocated from oracle vs its own 7-day premium baseline. During closed cash sessions this IS the live price discovery for the synthetic.',
  volume:'24h volume is a multiple of this market\u2019s own 30d norm \u2014 a context flag that amplifies whatever else is firing.',
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
  const c=g.claim0, frozen=!!(c&&c.tgt!=null&&c.stop!=null);
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
  const tgt=frozen&&c.tgt!=null?c.tgt:p.target, stp=frozen&&c.stop!=null?c.stop:p.stop;
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
    +(p.watch?`<span class="sp-watch" data-tip="the one corroborating condition that confirms or kills this setup">watch: ${esc(p.watch)}</span>`:'')
    +`</span>`;
}
function fmtTrig(t0){ if(t0==null) return ''; const d=new Date(t0), n=new Date();
  const hm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  return (d.getDate()===n.getDate()&&d.getMonth()===n.getMonth())?hm:(d.getMonth()+1)+'/'+d.getDate()+' '+hm; }
function fmtAge(ms){ if(ms==null) return ''; const h=ms/3600000; if(h<1) return Math.max(1,Math.round(ms/60000))+'m'; if(h<48) return h.toFixed(h<10?1:0)+'h'; return (h/24).toFixed(1)+'d'; }
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
    return `<span class="sig-age${g.decayed?' dk':''}" data-tip="${esc(tip)}">${g.decayed?'\u29d6 ':''}${fmtTrig(g.t0)}${g.age!=null?' \u00b7 '+fmtAge(g.age)+' ago':''}${c.px!=null?' @ '+fmtPrice(c.px):''}${(g.sinceBoot||c.boot)?' \u27f2':''}${g.decayed?' \u00b7 decaying':''}</span>`;
  }
  let s=`<span class="sig-age${g.decayed?' dk':''}" data-tip="${esc(baseTip)}">${g.decayed?'\u29d6 ':''}${fmtTrig(g.t0)}${g.age!=null?' \u00b7 '+fmtAge(g.age)+' ago':''}${g.sinceBoot?' \u27f2':''}${g.decayed?' \u00b7 decaying':''}</span>`;
  if(c&&c.t!=null){
    const left=c.resolveAt!=null?c.resolveAt-Date.now():null;
    const tip=`the LEDGER CLAIM this signal is scored against: opened ${new Date(c.t).toLocaleString()} at ${c.px!=null?fmtPrice(c.px):'\u2014'}${c.boot?' \u2014 \u27f2 on the first build after a restart/deploy (the condition may predate the stamp)':''}. One episode carries ONE claim even if the condition lapses and returns, so the claim can be older than the condition you are looking at \u2014 the outcome is measured from the claim's own mark and time.${left!=null?(left>0?` Resolves in ${fmtAge(left)}.`:' Resolution due.'):''}`;
    s+=`<span class="sig-age" data-tip="${esc(tip)}">claim ${fmtTrig(c.t)} @ ${c.px!=null?fmtPrice(c.px):'\u2014'}${c.boot?' \u27f2':''}</span>`;
  }
  return s;
}
function sigCardHtml(gr, rank, collapsible){
  let s=`<div class="sigcard${gr.sigs.length>1?' conf':''}${gr.sigs.some(x=>x.prime)?' prime':''}"${collapsible?` data-coll="${esc(gr.coin)}"`:''}>`;
  s+=`<div class="sigcard-h"${collapsible?' style="cursor:pointer" data-tip="click to collapse back to the compact row"':''}><span class="sig-rank">${rank}</span>`
    +(collapsible?`<span class="sig-caret">\u25be</span>`:'')
    +`<b class="sig-tick" data-coin="${esc(gr.coin)}">${esc(gr.ticker)}</b>`
    +(gr.sigs.length>1?`<span class="sig-conf" data-tip="confluence: ${gr.sigs.length} independent conditions firing on the same name \u2014 each condition's score gets a confluence bonus because agreement is itself the signal">${gr.sigs.length} conditions</span>`:'')
    +`<span class="sig-score" data-tip="best condition's score: unusualness + historical edge + confluence bonus, 0\u2013100"><span class="sig-bar"><span style="width:${Math.min(100,gr.score)}%"></span></span>${gr.score}</span></div>`;
  for(const g of gr.sigs){
    const ownOk = g.study && g.study.n>=8;
    const U = (st)=>st&&st.unit==='R'?'R':'%';   // R = sigma units (outcome / the market's own vol at event time) — apples-to-apples across names
    const exp = (st)=>st&&st.avg!=null?` \u00b7 <span data-tip="expectancy: the MEAN direction-signed outcome per event \u2014 hit rate and payoff sizes folded into one number. ${st.unit==='R'?'Measured in R (sigma units \u2014 the outcome divided by the market\u2019s own volatility at event time), so it compares fairly across quiet and wild names and pools cleanly. ':''}This, not the R/R screen, is what decides whether the setup pays over many occurrences.">exp <b class="${st.avg>=0?'pos':'neg'}">${st.avg>=0?'+':''}${st.avg}${U(st)}</b>/ev</span>`:'';
    const hist = ownOk
      ? `on ${esc(g.ticker)} (n=${g.study.n}): median <b class="${g.study.med>=0?'pos':'neg'}">${g.study.med>=0?'+':''}${g.study.med}${U(g.study)}</b> \u00b7 ${Math.round(g.study.hit*100)}% hit${exp(g.study)} \u2014 ${esc(g.horizon||'')}`
      : (g.pooled
        ? `${g.study?`on ${esc(g.ticker)}: n=${g.study.n} \u00b7 `:''}pooled across its asset class (n=${g.pooled.n}): median <b class="${g.pooled.med>=0?'pos':'neg'}">${g.pooled.med>=0?'+':''}${g.pooled.med}${U(g.pooled)}</b> \u00b7 ${Math.round(g.pooled.hit*100)}% hit${exp(g.pooled)} \u2014 ${esc(g.horizon||'')}`
        : (g.study
          ? `on ${esc(g.ticker)} (n=${g.study.n}): median ${g.study.med>=0?'+':''}${g.study.med}${U(g.study)} \u00b7 ${Math.round(g.study.hit*100)}% hit \u2014 ${esc(g.horizon||'')}`
          : `${esc(g.horizon||'no historical study yet')}`));
    s+=`<div class="sig${g.prime?' prime':''}">`
      +`<span class="sig-chip" data-tip="${esc(EV_TIP[g.ev]||g.label)}">${esc(g.label)}</span>`
      +(g.confl?`<span class="sig-chip" style="color:var(--down);border-color:var(--down)" data-tip="${esc(`conflicting signals \u00b7 a long-side and a short-side event are BOTH live on this name${(g.conflWith&&g.conflWith.length)?` \u00b7 opposing: ${g.conflWith.map(o=>`${o.label} (${(o.side||'').toUpperCase()}, score ${o.score})`).join('; ')} \u2014 the counterpart may rank below the visible list or be hidden by your filters; the conflict stands because both are live and both claims are on the books`:''} \u00b7 no confluence bonus is granted amid contradiction \u00b7 each claim resolves independently on its own record \u2014 the ledger, not the dashboard, decides which side was right`)}">\u21c4 conflict</span>`:'')
      +`<span class="sig-line1">${g.prime?'<i class="sig-prime" data-tip="prime setup: \u226560% hit, positive expectancy, sound structure (R/R \u22651.2 where levels exist), not unproven/decayed/no-edge \u2014 the bars this signal clears to earn emphasis">\u2605 prime</i>':''}${trigChip(g)}<span class="sig-read">${esc(g.reading)}</span></span>`
      +`<span class="sig-hist" data-tip="${esc((ownOk?'own base rate \u00b7 this market\u2019s median forward outcome and hit share across past occurrences, over the stated horizon':(g.pooled?'pooled base rate \u00b7 fewer than 8 occurrences on this market, so evidence pools across every market in its asset class \u00b7 broader sample, applied at a 30% score discount':EV_TIP[g.ev]||''))+(g.liveW?` \u00b7 evidence is Bayesian-blended with the live out-of-sample record at ${g.liveW}% weight \u2014 the weight grows with resolved count, so trust migrates from backtest to reality`:''))}">${hist}${g.unproven&&!g.pooled?' <i class="sig-unp" data-tip="fewer than 8 historical occurrences and no usable pooled sample \u2014 a flag, not an edge">unproven</i>':''}${g.negexp?' <i class="sig-unp" style="color:var(--down);border-color:var(--down)" data-tip="this base rate has NEGATIVE expectancy \u2014 past occurrences of this event lost money on average under its own sign convention. Evidence score zeroed; shown for awareness, ranked as noise.">neg exp</i>':''}${g.noedge?' <i class="sig-unp" style="color:var(--down);border-color:var(--down)" data-tip="the LIVE out-of-sample record for this event type shows no edge (\u226510 resolved, <50% hit) \u2014 evidence score capped">no live edge</i>':''}</span>`
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
    return `<span class="sig-chip" data-tip="${esc(g.reading+hist+(g.play&&g.play.bias?` \u00b7 play: ${g.play.bias}`:''))}">${esc(g.label)}${g.noedge?' \u26a0':''}</span>`;
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
function sigRecordHtml(d){
  const thr=sigMovePref(), pr=sigPrimePref();
  const rs=(d&&d.records&&d.records[String(thr)+(pr?'p':'')])||d||{};
  const rc=rs.record||{};
  const evs=Object.keys(rc);
  let fired=0,resolved=0,wins=0,open=0,nS=0,winsS=0;
  for(const ev of evs){ const r=rc[ev]; resolved+=r.resolved||0; open+=r.open||0; wins+=Math.round((r.hit||0)*(r.resolved||0));
    nS+=r.nS||0; winsS+=Math.round((r.hitS||0)*(r.nS||0)); }
  fired=resolved+open;
  let s=`<div class="dsec" style="margin-top:22px" data-tip="out-of-sample accuracy \u00b7 every fired signal is ledgered at its mark and resolved at its stated horizon under the study\u2019s own sign convention \u00b7 this section is what actually happened after the engine spoke \u2014 the record it must answer to">Signal accuracy \u2014 live track record${thr>0||pr?` <span class="sec" style="text-transform:none;letter-spacing:0">\u00b7 ${pr?'\u2605 prime':''}${pr&&thr>0?' \u00b7 ':''}${thr>0?'move \u2265'+thr+'%':''} claims only</span>`:''}</div>`;
  if(!fired){
    return s+`<div class="sec" style="font-size:11.5px;padding:4px 2px">No claims ledgered yet \u2014 the record starts accruing from the first signals this deploy fires. First resolutions land at their horizons (12h\u20135d).</div>`;
  }
  const hitAll=resolved?Math.round(100*wins/resolved):null;
  s+=`<div class="sigrec-top">`
    +`<span data-tip="every distinct (market, event) claim ledgered since launch">fired <b>${fired}</b></span>`
    +`<span data-tip="claims that reached their horizon and were scored">resolved <b>${resolved}</b></span>`
    +`<span data-tip="claims still inside their horizon, awaiting resolution">open <b>${open}</b></span>`
    +(hitAll!=null&&resolved?`<span data-tip="AT-HORIZON track: share of resolved claims that moved the way the signal implied, held to the stated horizon with NO stop \u2014 this is what the studies claim and what the engine learns from"><b class="${hitAll>=50?'pos':'neg'}">${hitAll}%</b> at-horizon hit</span>`:'')
    +(nS?`<span data-tip="stop-aware record \u00b7 same claims, but the outcome is capped at the void level when it was touched before horizon \u00b7 what trading the playbook with its void as a hard stop would have done \u00b7 covers claims resolved since stop-tracking began \u2014 older claims carry no frozen void, so n trails the resolved total"><b class="${Math.round(100*winsS/nS)>=50?'pos':'neg'}">${Math.round(100*winsS/nS)}%</b> stop-aware <i style="font-style:normal;color:var(--faint)">(n=${nS})</i></span>`:'')
    +`</div>`;
  if(resolved){
    s+='<table class="sigrec-t"><thead><tr><th>event</th><th data-tip="resolved / still open">n</th><th data-tip="share of resolved claims that resolved positive under the event\u2019s sign convention">live hit</th><th data-tip="median realized outcome across resolved claims">live med</th><th data-tip="profit factor: gross wins \u00f7 gross losses across resolved claims. >1 = the winners outweigh the losers in size, not just count \u2014 hover for the average win vs average loss">pf</th><th data-tip="average of the in-sample medians claimed at fire time \u2014 compare against live med: this is the honesty gap">claimed</th><th class="ss" data-tip="stop-aware hit \u00b7 outcomes capped at the void when touched before horizon \u00b7 covers claims resolved since stop-tracking began (build -22) \u2014 n can trail the live column\u2019s">\u26d4 hit</th><th class="ss" data-tip="stop-aware median realized">\u26d4 med</th><th class="ss" data-tip="stop-aware profit factor \u2014 hover the row\u2019s \u26d4 hit for how many claims were stopped out">\u26d4 pf</th><th></th></tr></thead><tbody>';
    for(const ev of evs){ const r=rc[ev]; if(!r.resolved&&!r.open) continue;
      const bad=r.resolved>=10&&r.hit<0.5&&r.med<=0, good=r.resolved>=10&&r.hit>=0.55&&r.med>0;
      s+=`<tr><td>${esc(EV_LABELS[ev]||ev)}</td><td>${r.resolved}${r.open?` <span class="sec">/${r.open}</span>`:''}</td>`
        +`<td>${r.hit!=null?`<span class="${r.hit>=0.5?'pos':'neg'}">${Math.round(r.hit*100)}%</span>`:'\u2014'}</td>`
        +`<td>${r.med!=null?`<span class="${r.med>=0?'pos':'neg'}">${r.med>=0?'+':''}${r.med}${r.unit}</span>`:'\u2014'}</td>`
        +`<td>${r.pf!=null?`<span class="${r.pf>=1?'pos':'neg'}" data-tip="${esc(`avg win ${r.avgWin!=null?'+'+r.avgWin+r.unit:'\u2014'} vs avg loss ${r.avgLoss!=null?r.avgLoss+r.unit:'\u2014'}`)}">${r.pf}</span>`:'\u2014'}</td>`
        +`<td>${r.claimMed!=null?`${r.claimMed>=0?'+':''}${r.claimMed}${r.unit}`:'\u2014'}</td>`
        +`<td class="ss">${r.nS?`<span class="${r.hitS>=0.5?'pos':'neg'}" data-tip="${esc(`${EV_LABELS[ev]||ev} \u2014 stop-aware hit (n=${r.nS}) \u00b7 share of stop-disciplined outcomes that resolved positive \u00b7 stopped en route: ${r.stopped||0} of ${r.nS} (${Math.round(100*(r.stopped||0)/r.nS)}%) \u2014 separate fact: a claim can lose at horizon without ever touching its void \u00b7 n trails the live column when claims predate stop-tracking (no frozen void on older claims)`)}">${Math.round(r.hitS*100)}% <i style="font-style:normal;color:var(--faint);font-size:10px">(n=${r.nS})</i></span>`:'\u2014'}</td>`
        +`<td class="ss">${r.medS!=null?`<span class="${r.medS>=0?'pos':'neg'}">${r.medS>=0?'+':''}${r.medS}${r.unit}</span>`:'\u2014'}</td>`
        +`<td class="ss">${r.pfS!=null?`<span class="${r.pfS>=1?'pos':'neg'}">${r.pfS}</span>`:'\u2014'}</td>`
        +`<td>${bad?'<i class="sig-unp" style="color:var(--down);border-color:var(--down)">no live edge</i>':(good?'<i class="sig-unp" style="color:var(--up);border-color:var(--up)">confirmed</i>':'')}</td></tr>`;
    }
    s+='</tbody></table>';
  }
  const rx=rs.recordX;
  if(rx){
    if(rx.buckets&&rx.buckets.some(b=>b.n>0)){
      s+=`<div class="sigrec-xr"><span class="sigrec-k" data-tip="calibration: does the score at fire time actually rank outcomes? If higher buckets don't hit more often, the scoring \u2014 not the events \u2014 needs work.">calibration</span>`;
      for(const b of rx.buckets) s+=`<span class="sigrec-chip" data-tip="claims fired with score ${esc(b.k)}: ${b.n} resolved">score ${esc(b.k)}: ${b.hit!=null?`<b class="${b.hit>=0.5?'pos':'neg'}">${Math.round(b.hit*100)}%</b>`:'\u2014'} <i>(n=${b.n})</i></span>`;
      s+='</div>';
    }
    if(rx.side&&(rx.side.long.n||rx.side.short.n)){
      s+=`<div class="sigrec-xr"><span class="sigrec-k" data-tip="resolved claims split by implied direction \u2014 a persistent gap here means the engine reads one side of the tape better than the other">by side</span>`
        +`<span class="sigrec-chip">longs ${rx.side.long.hit!=null?`<b class="${rx.side.long.hit>=0.5?'pos':'neg'}">${Math.round(rx.side.long.hit*100)}%</b>`:'\u2014'} <i>(n=${rx.side.long.n})</i></span>`
        +`<span class="sigrec-chip">shorts ${rx.side.short.hit!=null?`<b class="${rx.side.short.hit>=0.5?'pos':'neg'}">${Math.round(rx.side.short.hit*100)}%</b>`:'\u2014'} <i>(n=${rx.side.short.n})</i></span></div>`;
    }
    if(rx.form&&rx.form.recentN>=10){
      const f=rx.form, up=f.recentHit>=f.allHit;
      s+=`<div class="sigrec-xr"><span class="sigrec-k" data-tip="recent form vs all-time \u2014 is the engine improving as the blend and caps kick in, or degrading with the regime?">form</span>`
        +`<span class="sigrec-chip">last ${f.recentN}: <b class="${f.recentHit>=0.5?'pos':'neg'}">${Math.round(f.recentHit*100)}%</b> ${up?'\u2197':'\u2198'} vs all-time ${Math.round(f.allHit*100)}% <i>(n=${f.allN})</i></span></div>`;
    }
    if(rx.tickers){
      const chip=(x)=>`<span class="sigrec-chip" data-tip="${x.n} resolved claims on ${esc(x.t)}">${esc(x.t)} <b class="${x.hit>=0.5?'pos':'neg'}">${Math.round(x.hit*100)}%</b> <i>(n=${x.n})</i></span>`;
      s+=`<div class="sigrec-xr"><span class="sigrec-k" data-tip="which markets this engine actually reads well (\u22655 resolutions each) \u2014 signal quality is not uniform across the universe">reads best</span>${rx.tickers.best.map(chip).join('')}`
        +`<span class="sigrec-k" style="margin-left:14px">worst</span>${rx.tickers.worst.map(chip).join('')}</div>`;
    }
    if(SHOW_CLAIM_CURVE&&rx.curve&&rx.curve.length>=5){
      s+=`<div class="sec" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;margin:12px 0 4px" data-tip="cumulative R curve \u00b7 equal-weight running sum of every resolved R-united claim in fired order \u00b7 solid: at-horizon outcomes \u00b7 dashed: stop-aware outcomes \u00b7 hover for the claim behind each step">claim equity curve (R) <span style="text-transform:none;letter-spacing:0">\u2014 solid: at-horizon \u00b7 <span style="color:var(--blue)">dashed: stop-aware</span></span></div>`+recCurveSvg(rx.curve);
    }
  }
  if(rs.confluence&&(rs.confluence.confN||rs.confluence.soloN)){
    const c=rs.confluence;
    s+=`<div class="sec" style="font-size:11.5px;margin:8px 0 2px" data-tip="Does agreement actually help? Resolved claims split by whether they fired WITH other conditions on the same name or alone. Once both sides have 15+ resolutions, the confluence score bonus scales to this measured lift \u2014 and drops to zero if agreement doesn't prove out.">confluence: `
      +(c.confN&&c.confHit!=null?`<b class="${c.confHit>=(c.soloHit||0)?'pos':'neg'}">${Math.round(c.confHit*100)}%</b> hit with company (n=${c.confN})`:`n=${c.confN||0} with company`)
      +` vs `+(c.soloN&&c.soloHit!=null?`<b>${Math.round(c.soloHit*100)}%</b> solo (n=${c.soloN})`:`n=${c.soloN||0} solo`)
      +` \u2014 bonus ${c.confN>=15&&c.soloN>=15?`<b>${c.bonus}</b>/condition (earned from the measured lift)`:`8/condition (default until 15+ resolutions per side)`}</div>`;
  }
  if(d&&d.variants&&d.variants.length){
    s+=`<div class="sec" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;margin:12px 0 4px" data-tip="Bounded self-improvement: each gated event runs 2\u20133 candidate thresholds. Only the incumbent emits visible signals \u2014 but ALL variants (incumbent included) silently ledger shadow claims on identical bookkeeping, so the comparison is out-of-sample and apples-to-apples. A challenger is promoted only with \u226530 resolutions on BOTH sides, expectancy beating the incumbent by \u22650.08 native units and positive, and no hit-rate collapse. Promotions are logged, persisted, and reversible by the same rule. This searches a small fixed hypothesis space under out-of-sample discipline \u2014 it cannot re-fit freely.">self-tuning (shadow variants)</div>`;
    for(const v of d.variants){
      s+=`<div class="sigrec-xr"><span class="sigrec-k" data-tip="${esc('trigger parameter: '+v.param+' \u2014 live signals currently fire at '+v.param+v.cur)}">${esc(EV_LABELS[v.ev]||v.ev)}</span>`;
      for(const x of v.vals){
        s+=`<span class="sigrec-chip${x.inc?' inc':''}" data-tip="${esc(`${v.param}${x.v} \u2014 ${x.inc?'INCUMBENT: the threshold live signals use':'shadow challenger: ledgered silently, never shown as a signal'}. ${x.n} resolved shadow claim${x.n===1?'':'s'}${x.n<30?' (promotion needs 30 on both sides)':''}.`)}">${x.inc?'\u2605 ':''}${esc(v.param)}${x.v}${x.hit!=null?` <b class="${x.hit>=0.5?'pos':'neg'}">${Math.round(x.hit*100)}%</b>`:''}${x.avg!=null?` <span class="${x.avg>=0?'pos':'neg'}">${x.avg>=0?'+':''}${x.avg}${v.unit}</span>`:''} <i>(n=${x.n})</i></span>`;
      }
      if(v.hist&&v.hist.length){ const h=v.hist[v.hist.length-1];
        s+=`<span class="sec" style="font-size:10px" data-tip="${esc(`most recent promotion: incumbent ${h.incAvg}${v.unit} on n=${h.incN} vs challenger ${h.chAvg}${v.unit} on n=${h.chN} \u2014 out-of-sample shadow claims only`)}">promoted ${h.from}\u2192${h.to} on n=${h.chN} out-of-sample</span>`; }
      s+='</div>';
    }
  }
  if(rs.recent&&rs.recent.length){
    s+=`<div class="sec" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;margin:10px 0 4px" data-tip="the most recent claims to reach their horizon and get scored">recent resolutions</div><div class="sigrec-recent">`;
    for(const e of rs.recent){
      s+=`<span class="recr ${e.win?'w':'l'}" data-tip="${esc(`${e.ticker} \u00b7 ${EV_LABELS[e.ev]||e.ev} \u00b7 fired ${new Date(e.t0).toLocaleString()}, resolved ${new Date(e.tR).toLocaleString()} \u2014 at-horizon ${e.realized>=0?'+':''}${e.realized}${e.unit}${e.realizedS!=null?`; stop-aware ${e.realizedS>=0?'+':''}${e.realizedS}${e.unit}${e.stopped?' (void level touched before horizon)':''}`:''}`)}">${e.stopped?'\u26d4 ':''}${esc(e.ticker)} <b class="${e.win?'pos':'neg'}">${e.realized>=0?'+':''}${e.realized}${e.unit}</b></span>`;
    }
    s+='</div>';
  }
  return s;
}
function renderSignals(){
  const box=el('signals-body'); if(!box) return;
  const d=state.signals, view=sigViewPref(), mvThr=sigMovePref(), prOn=sigPrimePref();
  const mvBtn=(v,lbl)=>`<button type="button" class="cdtf${mvThr===v?' on':''}" data-mv="${v}" data-tip="${v===0?'show every signal regardless of target distance':`hide setups whose playbook target sits closer than ${lbl} from the live mark \u2014 statistically fine, but a few bp of expected move is not hand-tradeable. Signals with no computable target are hidden too while a threshold is active.`}">${v===0?'any':'\u2265'+lbl}</button>`;
  const seg=`<span class="cdtf-seg" style="margin-left:auto"><button type="button" class="cdtf${prOn?' on':''}" data-pr="1" data-tip="show only \u2605 prime setups \u2014 \u226560% hit, positive expectancy, sound structure at fire time \u2014 and switch the stats below to the record of prime claims only">\u2605 prime</button></span>`
    +`<span class="cdtf-seg" data-tip="minimum actionable move: distance from live mark to the playbook target">${mvBtn(0,'')}${mvBtn(0.5,'0.5%')}${mvBtn(1,'1%')}${mvBtn(2,'2%')}</span>`
    +`<span class="cdtf-seg"><button type="button" class="cdtf${view==='detail'?' on':''}" data-sv="detail" data-tip="full cards: readings, base rates, playbooks">detailed</button><button type="button" class="cdtf${view==='compact'?' on':''}" data-sv="compact" data-tip="one row per market \u2014 hover the chips for the full reading and base rate, click a row to expand it">compact</button></span>`;
  const intro=`<div class="sec" style="font-size:11.5px;line-height:1.55;margin-bottom:10px;display:flex;align-items:flex-start;gap:10px" data-tip="Scoring: how unusual the condition is right now (0\u201350) + historical edge \u2014 this market's own base rate when it has \u22658 occurrences, else the asset-class pooled base rate at a 30% discount, else a token score. Event types whose LIVE track record shows no edge (\u226510 resolved, <50% hit, \u22640 median) get their evidence capped automatically. Signals decay past their horizon and drop at 2\u00d7. Nothing here is a prediction."><span>Live conditions ranked by <b>unusualness \u00d7 historical edge</b>, self-audited: every fired signal is ledgered and resolved at its horizon \u2014 the record below is <b>out-of-sample</b>. Click a ticker for the drawer.</span>${seg}</div>`;
  let rec='';
  const rsTop=(d&&d.records&&d.records[String(mvThr)+(prOn?'p':'')])||d||{};
  const recSrc=rsTop.record||{};
  if(Object.keys(recSrc).length){
    rec='<div class="recstrip">';
    for(const ev in recSrc){ const r=recSrc[ev]; if(!r) continue;
      const live = r.resolved>0
        ? `${Math.round((r.hit||0)*100)}% hit \u00b7 med ${r.med>=0?'+':''}${r.med}${r.unit} (n=${r.resolved})`
        : `${r.open||0} open, none resolved yet`;
      const bad = r.resolved>=10 && r.hit<0.5 && r.med<=0;
      const good = r.resolved>=10 && r.hit>=0.55 && r.med>0;
      rec+=`<span class="rec${bad?' bad':(good?' good':'')}" data-tip="${esc(`${(EV_TIP[ev]||ev).split('.')[0]} \u00b7 out-of-sample record: every firing ledgered at its mark, resolved at the stated horizon under the study\u2019s own sign convention \u00b7 what actually happened after the engine spoke`)}"><b>${esc(EV_LABELS[ev]||ev)}</b> ${live}${bad?' \u00b7 <i>capped</i>':''}</span>`;
    }
    rec+='</div>';
  }
  if(!d||!d.signals||!d.signals.length){
    box.innerHTML=intro+rec+`<div class="msg">No unusual conditions firing right now \u2014 the tape is quiet.${warmCount()}<br><span class="sec" style="font-size:11px">Premium baselines, event studies and the live track record all accrue server-side; early after a cold start this list is naturally sparse.</span></div>`+sigRecordHtml(d);
    bindSigControls(box); return;
  }
  let hiddenN=0;
  const sigs = (mvThr>0||prOn) ? d.signals.filter(g=>{
    const m=sigMove(g);
    const ok=(mvThr===0||(m!=null&&m>=mvThr))&&(!prOn||g.prime);
    if(!ok)hiddenN++; return ok; }) : d.signals;
  const groups=[], byCoin={};
  for(const g of sigs){ if(byCoin[g.coin]){ byCoin[g.coin].sigs.push(g); byCoin[g.coin].score=Math.max(byCoin[g.coin].score,g.score); }
    else { byCoin[g.coin]={coin:g.coin,ticker:g.ticker,score:g.score,sigs:[g]}; groups.push(byCoin[g.coin]); } }
  if((mvThr>0||prOn)&&!groups.length){
    box.innerHTML=intro+rec+`<div class="msg">All ${hiddenN} live signal${hiddenN===1?'':'s'} hidden by the active filter${prOn?' (no prime setups firing'+(mvThr>0?' at this size':'')+')':''}.</div>`+sigRecordHtml(d);
    bindSigControls(box); attachLineHover(); return;
  }
  const main=groups.filter(g=>g.score>=35), low=groups.filter(g=>g.score<35);
  const rowOf=(gr,rank)=> view==='compact' ? (sigExpanded.has(gr.coin) ? sigCardHtml(gr, rank, true) : sigRowHtml(gr, rank)) : sigCardHtml(gr, rank, false);
  let s=intro+rec+'<div class="siglist">';
  let rank=0;
  for(const gr of main){ rank++; s+=rowOf(gr,rank); }
  if(low.length){
    s+=`<div class="sig-lowx" data-lowx data-tip="markets whose best condition scores below 35 \u2014 weak evidence, poor structure, decayed, or negative-expectancy base rates. Collapsed by default to keep the list high signal; nothing is deleted.">${state._sigLow?'\u25be':'\u25b8'} ${low.length} low-conviction market${low.length===1?'':'s'} (score &lt; 35)</div>`;
    if(state._sigLow) for(const gr of low){ rank++; s+=rowOf(gr,rank); }
  }
  s+='</div>';
  if(hiddenN>0) s+=`<div class="sec" style="font-size:10.5px;padding:6px 2px" data-tip="signals whose playbook target is closer than the active threshold, or which have no computable target">${hiddenN} signal${hiddenN===1?'':'s'} hidden by the active filter${prOn?' (prime-only)':''}</div>`;
  s+=sigRecordHtml(d);
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
}

// ===== sectors tab =====
const SECT={ _rows:null, _cohesion:null };
function zscores(arr){ const v=arr.filter(x=>x!=null&&isFinite(x));
  if(v.length<2) return arr.map(()=>0);
  const m=v.reduce((a,b)=>a+b,0)/v.length, sd=stdev(v)||1;
  return arr.map(x=>(x!=null&&isFinite(x))?(x-m)/sd:0); }
function sectorShort(name){ const M={'Information Technology':'Info Tech','Communication Services':'Comm Svcs','Consumer Discretionary':'Cons Disc','Consumer Staples':'Cons Stpl','Health Care':'Health','Real Estate':'Real Est'}; return M[name]||name; }

function computeSectors(){
  const tfKey=TF_MAP[state.tf]||'d1', byVol=state.sect.wt!=='eq';
  const groups=new Map();
  for(const r of activeRows()){ const g=r.sector||'Unclassified';
    let o=groups.get(g); if(!o){ o={name:g, assetClass:r.assetClass||'—', members:[]}; groups.set(g,o); }
    o.members.push(r); }
  const list=[];
  for(const o of groups.values()){ const ms=o.members;
    let wsum=0; for(const r of ms) if(byVol&&r.vol>0) wsum+=r.vol;
    const wOf=r=> byVol ? (wsum>0?((r.vol>0?r.vol:0)/wsum):1/ms.length) : 1/ms.length;
    const wavg=(sel)=>{ let s=0,ww=0; for(const r of ms){ const v=sel(r); if(v==null||!isFinite(v))continue; const wi=wOf(r); s+=wi*v; ww+=wi; } return ww>0?s/ww:null; };
    const withRet=ms.filter(r=>r[tfKey]!=null&&isFinite(r[tfKey]));
    const ret=wavg(r=>r[tfKey]);
    const retEW=withRet.length?withRet.reduce((a,r)=>a+r[tfKey],0)/withRet.length:null;
    const doi=wavg(r=>r.doi);
    const rvol=wavg(r=>r.vol30);
    let totVol=0,totOI=0,volBase=0;
    for(const r of ms){ if(r.vol)totVol+=r.vol; if(r.oi)totOI+=r.oi; if(r.feat&&r.feat.volBase>0)volBase+=r.feat.volBase; }
    const relVol=volBase>0?totVol/volBase:null;
    const green=withRet.length?withRet.filter(r=>r[tfKey]>0).length/withRet.length:null;
    const greenN=withRet.length?withRet.filter(r=>r[tfKey]>0).length:0;
    const momArr=ms.filter(r=>r.mom!=null&&isFinite(r.mom));
    const momUp=momArr.length?momArr.filter(r=>r.mom>0).length/momArr.length:null;
    list.push({ name:o.name, assetClass:o.assetClass, n:ms.length, members:ms,
      ret, retEW, doi, rvol, relVol, totVol, totOI, green, greenN, greenT:withRet.length, momUp });
  }
  // rotation = capital direction (return + OI conviction) · heat = activity (volume + volatility)
  const rets=list.map(g=>g.ret);
  const retSd=stdev(rets.filter(x=>x!=null&&isFinite(x)))||1;
  const oic=list.map(g=>(g.doi!=null&&g.ret!=null)?g.doi*Math.tanh(g.ret/retSd):null);
  const zRet=zscores(rets), zOIc=zscores(oic),
        zRV=zscores(list.map(g=>g.relVol!=null&&g.relVol>0?Math.log(g.relVol):null)),
        zVol=zscores(list.map(g=>g.rvol)), zDO=zscores(list.map(g=>g.doi!=null?Math.abs(g.doi):null));
  list.forEach((g,i)=>{
    g.direction=(g.ret==null)?null:100*Math.tanh((0.55*zRet[i]+0.45*zOIc[i])/1.2);
    const hr=0.5*zRV[i]+0.3*zVol[i]+0.2*zDO[i];
    g.heat=Math.round(100/(1+Math.exp(-hr)));
    g.rotation=g.direction;
  });
  // cohesion (avg internal daily-return correlation) via the shared correlation builder
  const withDaily=activeRows().filter(r=>r.daily&&r.sector);
  const coh=new Map();
  if(withDaily.length>1){ const scL=({'7':7,'30':30,'90':90}[state.sect.corrTf]||30); const {C}=buildCorr(withDaily,scL);
    const idxByG=new Map(); withDaily.forEach((r,i)=>{ const g=r.sector; (idxByG.get(g)||idxByG.set(g,[]).get(g)).push(i); });
    for(const [g,idx] of idxByG){ let s=0,n=0; for(let a=0;a<idx.length;a++)for(let b=a+1;b<idx.length;b++){ const v=C[idx[a]][idx[b]]; if(v!=null&&isFinite(v)){s+=v;n++;} } coh.set(g,n?s/n:null); }
    SECT._corrCache={C, idxByG, rows:withDaily};
  } else SECT._corrCache=null;
  list.forEach(g=>g.cohesion=coh.has(g.name)?coh.get(g.name):null);
  list.sort((a,b)=>{ const av=a.rotation,bv=b.rotation; if(av==null&&bv==null)return (b.totVol||0)-(a.totVol||0); if(av==null)return 1; if(bv==null)return -1; return bv-av; });
  SECT._rows=list;
  return list;
}

function renderSectors(){
  if(!state.rows.size){ el('sect-map').innerHTML='<div class="msg">Markets still loading — switch back in a moment.</div>'; return; }
  computeDerived();
  const list=computeSectors();
  const lg=el('sect-legend'); if(lg) lg.innerHTML = state.sect.mode==='leaders'
    ? `<b>Leadership map</b> — where each sector sits vs the S&amp;P over the last <b>${leadersDays()}d</b>${leadersFloored()?' <span class="sec">(leadership needs a multi-day window, so intraday selections show 7d — use the rotation board below for shorter windows)</span>':''}. <b>Right</b> = beating the S&amp;P, <b>left</b> = behind it. <b>Up</b> = its lead is <i>growing</i>, <b>down</b> = <i>shrinking</i>. So <b class="pos">top-right</b> sectors are winning and pulling further ahead; <b class="neg">bottom-left</b> are losing and falling further behind. Bubble size = 24h volume. The <b>dotted tail</b> behind each bubble is its recent path (oldest → now) — hover the tail dots for the values.`
    : '<b>Flow map</b> — horizontal = capital direction (price + OI conviction) over the selected window, vertical = activity heat (volume + volatility). Top-right = accumulation, top-left = distribution. Bubble size = 24h volume.';
  if(state.sect.mode==='leaders'){
    const data=computeLeaders(list);
    // Trails: re-evaluate the same map with the window ending 2/4/6 (7d) or 4/8/12 (30d)
    // benchmark days earlier, giving each sector a short trajectory — the whole point of a
    // rotation graph is the path, not the snapshot. Drawn oldest→newest into the live bubble.
    if(data){
      const offs = leadersDays()<=7 ? [6,4,2] : [12,8,4];
      const hist = offs.map(o=>({o, pts:computeLeaders(list,o)}));
      for(const sec of data){ sec.trail=[];
        for(const h of hist){ if(!h.pts) continue; const p=h.pts.find(x=>x.name===sec.name); if(p) sec.trail.push({x:p.x, y:p.y, o:h.o}); } }
    }
    el('sect-map').innerHTML = data ? renderLeaders(data)
      : `<div class="msg">The leadership map needs the S&amp;P benchmark and daily history — it fills in automatically as the server backfill completes.${warmCount()}</div>`;
    if(data) attachLeadersHandlers();
    if(data) attachMapHover();
  } else {
    el('sect-map').innerHTML=renderSectorMap(list);
    attachMapHandlers();
    attachMapHover();
  }
  renderSectorBoard(list);
  renderSectorDetail();
  renderSectorCorr(list);
}
// ---- Leadership map: plain % relative to the S&P (X) and whether the lead is growing (Y) ----
// Leadership lookback follows the window selector (7d/30d). It's daily-based, so intraday choices floor to 7d.
function leadersDays(){ return {'1h':7,'4h':7,'1d':7,'7d':7,'30d':30}[state.tf]||30; }
function leadersFloored(){ return state.tf==='1h'||state.tf==='4h'||state.tf==='1d'; }
function computeLeaders(list, offset){
  offset=offset||0;   // end the window `offset` benchmark days ago (0 = now) — powers the trails
  const bench=state.benchCoin?state.rows.get(state.benchCoin):null;
  if(!bench||!bench.daily||bench.daily.length<5) return null;
  const bDay=new Map();
  for(const k of bench.daily){ const cl=parseFloat(k.c), d=Math.floor(k.t/DAY); if(isFinite(cl)) bDay.set(d,cl); }
  const days=[...bDay.keys()].sort((a,b)=>a-b);
  const endI=days.length-offset;
  if(endI<5) return null;
  const win=days.slice(Math.max(0, endI-leadersDays()), endI);
  if(win.length<5) return null;
  const b0=bDay.get(win[0]); if(!(b0>0)) return null;
  const mid=Math.floor(win.length/2), bMid=bDay.get(win[mid]), bEnd=bDay.get(win[win.length-1]);
  const benchRet=bEnd/b0-1, benchEarly=bMid/b0-1, benchLate=bEnd/bMid-1;
  const out=[];
  for(const g of list){
    if(g.name==='Unclassified') continue;
    const series=[];
    for(const r of g.members){ if(!r.daily||r.daily.length<5) continue;
      const bd=new Map();
      for(const k of r.daily){ const cl=parseFloat(k.c), d=Math.floor(k.t/DAY); if(isFinite(cl)) bd.set(d,cl); }
      const first=win.find(d=>bd.has(d)); if(first==null) continue; const f=bd.get(first); if(!(f>0)) continue;
      series.push({bd, f}); }
    if(!series.length) continue;
    const idxAt=d=>{ let s=0,n=0; for(const ms of series){ const cl=ms.bd.get(d); if(cl!=null&&cl>0){ s+=cl/ms.f; n++; } } return n?s/n:null; };
    const i0=idxAt(win[0]), iMid=idxAt(win[mid]), iEnd=idxAt(win[win.length-1]);
    if(i0==null||iEnd==null||!(i0>0)) continue;
    const x=((iEnd/i0-1)-benchRet)*100;                    // % ahead of / behind the S&P
    let y=0;                                                // change in that lead (recent vs earlier)
    if(iMid!=null&&iMid>0){ const exEarly=((iMid/i0-1)-benchEarly)*100, exLate=((iEnd/iMid-1)-benchLate)*100; y=exLate-exEarly; }
    out.push({name:g.name, x, y, vol:g.totVol});
  }
  return out.length?out:null;
}
function leadQuad(x,y){ if(x>=0&&y>=0)return {l:'Leaders',c:'var(--up)'}; if(x<0&&y>=0)return {l:'Catching up',c:'var(--blue)'}; if(x>=0&&y<0)return {l:'Cooling',c:'var(--accent)'}; return {l:'Laggards',c:'var(--down)'}; }
// ---- shared bubble-map label handling: halo (#1) + greedy de-collision w/ leader lines (#2) + hover (#3) ----
// nodes: [{cx,cy,r,label,...}] mutated in place with n._lbl={p,x1,y1,x2,y2,def}. b={px0,px1,py1,py0}.
// Bubbles never move (their position IS the data); only labels are routed to a free side, which is lossless.
function layoutMapLabels(nodes, b){
  const placed=[], boxes=nodes.map(n=>({x1:n.cx-n.r,y1:n.cy-n.r,x2:n.cx+n.r,y2:n.cy+n.r}));
  const ov=(a,c)=>!(a.x2<c.x1||a.x1>c.x2||a.y2<c.y1||a.y1>c.y2);
  const inB=c=>c.x1>=b.px0-34&&c.x2<=b.px1+34&&c.y1>=b.py1-6&&c.y2<=b.py0+22;
  for(const n of [...nodes].sort((a,c)=>c.r-a.r)){          // biggest bubbles keep the natural spot; small ones route around
    const w=(n.label||'').length*6.2+2, h=12;
    const cand=[
      {p:'below',x1:n.cx-w/2,     y1:n.cy+n.r+3},
      {p:'above',x1:n.cx-w/2,     y1:n.cy-n.r-3-h},
      {p:'right',x1:n.cx+n.r+5,   y1:n.cy-h/2},
      {p:'left', x1:n.cx-n.r-5-w, y1:n.cy-h/2},
      {p:'below',x1:n.cx-w/2,     y1:n.cy+n.r+3+h+3},
      {p:'above',x1:n.cx-w/2,     y1:n.cy-n.r-3-2*h-3},
    ].map(c=>({...c,x2:c.x1+w,y2:c.y1+h}));
    let chosen=null;
    for(const c of cand){ if(!inB(c))continue;
      let bad=placed.some(p=>ov(c,p));
      if(!bad) for(let i=0;i<nodes.length;i++){ if(nodes[i]===n)continue; if(ov(c,boxes[i])){bad=true;break;} }
      if(!bad){ chosen=c; break; } }
    if(!chosen) chosen=cand[0];                             // last resort: default below (halo still helps)
    chosen.def=(chosen===cand[0]);                          // default 'below' needs no leader line
    placed.push(chosen); n._lbl=chosen;
  }
  return nodes;
}
function mapLabelSvg(n, sizePx){
  const L=n._lbl;
  const ln=(x1,y1,x2,y2)=>`<line class="mleader" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  let tx,ty,anchor,leader='';
  if(L.p==='below'||L.p==='above'){ tx=n.cx; ty=L.y1+9.5; anchor='middle';
    if(!L.def) leader = L.p==='below' ? ln(n.cx,n.cy+n.r,n.cx,L.y1-1) : ln(n.cx,n.cy-n.r,n.cx,L.y2+1); }
  else if(L.p==='right'){ tx=L.x1; ty=n.cy+3.5; anchor='start'; leader=ln(n.cx+n.r,n.cy,L.x1-2,n.cy); }
  else { tx=L.x2; ty=n.cy+3.5; anchor='end'; leader=ln(n.cx-n.r,n.cy,L.x2+2,n.cy); }
  // halo: paint-order stroke in the page colour carves the label out from bubbles and neighbouring labels
  const txt=`<text class="mlbl" x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}" style="font-family:var(--mono);font-size:${sizePx}px;fill:var(--text);paint-order:stroke;stroke:var(--bg);stroke-width:3px;stroke-linejoin:round">${esc(n.label)}</text>`;
  return { leader, txt };
}
// hover a bubble -> raise it to the front and dim the rest
function attachMapHover(){
  const svg=el('sect-map').querySelector('svg.smapsvg'); if(!svg) return;
  // Emphasis is done purely with a class + CSS dimming of the others. We deliberately do NOT re-append
  // the hovered <g> to raise it: moving a node inside its own mouseenter cancels the browser's click
  // gesture (mousedown/mouseup land on a re-inserted node), which made bubbles unclickable.
  svg.querySelectorAll('.bub,.lead').forEach(g=>{
    g.addEventListener('mouseenter',()=>{ svg.classList.add('hv'); g.classList.add('hot'); });
    g.addEventListener('mouseleave',()=>{ svg.classList.remove('hv'); g.classList.remove('hot'); });
  });
}
function renderLeaders(data){
  const wl=leadersDays()+'d';
  const W=760,H=430, px0=44,px1=W-14, py0=H-48, py1=30;
  let mx=0.6,my=0.6;
  for(const s of data){ mx=Math.max(mx,Math.abs(s.x)); my=Math.max(my,Math.abs(s.y));
    if(s.trail) for(const t of s.trail){ mx=Math.max(mx,Math.abs(t.x)); my=Math.max(my,Math.abs(t.y)); } }
  mx*=1.18; my*=1.18;
  const xM=v=>px0+(clamp(v,-mx,mx)+mx)/(2*mx)*(px1-px0);
  const yM=v=>py0-(clamp(v,-my,my)+my)/(2*my)*(py0-py1);
  const cx=xM(0), cy=yM(0), maxVol=Math.max(1,...data.map(s=>s.vol||0));
  const ql='font-family:var(--mono);font-size:10px;fill:var(--faint)';
  let s=`<svg class="smapsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">`;
  s+=`<rect x="${px0}" y="${py1}" width="${px1-px0}" height="${py0-py1}" fill="var(--panel2)" opacity="0.3"/>`;
  s+=`<rect x="${cx}" y="${py1}" width="${px1-cx}" height="${cy-py1}" fill="rgb(70,185,126)" opacity="0.07"/>`;
  s+=`<rect x="${px0}" y="${py1}" width="${cx-px0}" height="${cy-py1}" fill="rgb(111,147,201)" opacity="0.07"/>`;
  s+=`<rect x="${cx}" y="${cy}" width="${px1-cx}" height="${py0-cy}" fill="rgb(227,165,60)" opacity="0.07"/>`;
  s+=`<rect x="${px0}" y="${cy}" width="${cx-px0}" height="${py0-cy}" fill="rgb(229,96,77)" opacity="0.07"/>`;
  s+=`<line x1="${cx}" y1="${py1}" x2="${cx}" y2="${py0}" stroke="var(--border)"/>`;
  s+=`<line x1="${px0}" y1="${cy}" x2="${px1}" y2="${cy}" stroke="var(--border)"/>`;
  s+=`<text x="${px1-8}" y="${py1+14}" text-anchor="end" style="font-family:var(--mono);font-size:10.5px;fill:var(--up);font-weight:600">LEADERS · ahead &amp; gaining</text>`;
  s+=`<text x="${px0+8}" y="${py1+14}" style="font-family:var(--mono);font-size:10.5px;fill:var(--blue);font-weight:600">CATCHING UP · behind, gaining</text>`;
  s+=`<text x="${px1-8}" y="${py0-8}" text-anchor="end" style="font-family:var(--mono);font-size:10.5px;fill:var(--accent);font-weight:600">COOLING · ahead, slowing</text>`;
  s+=`<text x="${px0+8}" y="${py0-8}" style="font-family:var(--mono);font-size:10.5px;fill:var(--down);font-weight:600">LAGGARDS · behind &amp; falling</text>`;
  [-mx, -mx/2, mx/2, mx].forEach(t=>{ const x=xM(t); s+=`<line x1="${x}" y1="${py0}" x2="${x}" y2="${py0+4}" stroke="var(--faint)"/><text x="${x.toFixed(1)}" y="${py0+16}" text-anchor="middle" style="${ql}">${t>0?'+':''}${t.toFixed(1)}%</text>`; });
  s+=`<text x="${cx.toFixed(1)}" y="${py0+16}" text-anchor="middle" style="${ql}">S&amp;P</text>`;
  s+=`<text x="${(px0+px1)/2}" y="${H-6}" text-anchor="middle" style="${ql}">← behind the S&amp;P    ·    % vs S&amp;P over ${wl}    ·    ahead →</text>`;
  s+=`<text x="12" y="${(py0+py1)/2}" text-anchor="middle" transform="rotate(-90 12 ${(py0+py1)/2})" style="${ql}">lead shrinking ▼ · growing ▲</text>`;
  const nodes=data.map(sec=>({cx:xM(sec.x),cy:yM(sec.y),r:8+22*Math.sqrt((sec.vol||0)/maxVol),label:sectorShort(sec.name),sec}));
  layoutMapLabels(nodes,{px0,px1,py1,py0});
  for(const n of nodes){ const sec=n.sec, q=leadQuad(sec.x,sec.y), col=q.c;
    const dir=sec.y>=0?'lead growing':'lead shrinking';
    const tip=`${sec.name}: ${sec.x>=0?'+':''}${sec.x.toFixed(1)}% vs S&P over ${wl}, ${dir} — ${q.l}. Dotted tail = its path (oldest → now).`;
    const lp=mapLabelSvg(n,10.5);
    s+=`<g class="lead" data-sect="${esc(sec.name)}" style="cursor:pointer"><title>${esc(tip)}</title>`;
    s+=lp.leader;
    if(sec.trail&&sec.trail.length){
      const tp=sec.trail.map(t=>({px:xM(t.x), py:yM(t.y), t}));
      let d=''; tp.forEach((p,i)=>d+=(i?'L':'M')+p.px.toFixed(1)+' '+p.py.toFixed(1)+' ');
      d+='L'+n.cx.toFixed(1)+' '+n.cy.toFixed(1);
      s+=`<path d="${d.trim()}" fill="none" stroke="${col}" stroke-width="1" stroke-dasharray="2 3" opacity="0.5"/>`;
      tp.forEach((p,i)=>{
        const dt=`${sec.name} · ${p.t.o} bench-day${p.t.o===1?'':'s'} ago: ${p.t.x>=0?'+':''}${p.t.x.toFixed(1)}% vs S&P, ${p.t.y>=0?'lead growing':'lead shrinking'}`;
        s+=`<circle cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="${(2+i*0.7).toFixed(1)}" fill="${col}" fill-opacity="${(0.28+0.16*i).toFixed(2)}"><title>${esc(dt)}</title></circle>`; });
    }
    s+=`<circle cx="${n.cx.toFixed(1)}" cy="${n.cy.toFixed(1)}" r="${n.r.toFixed(1)}" fill="${col}" fill-opacity="0.3" stroke="${col}" stroke-width="1.5"/>`;
    s+=lp.txt+`</g>`; }
  s+='</svg>';
  return s + leadersRankHtml(data);
}
function leadersRankHtml(data){
  const sorted=[...data].sort((a,b)=>b.x-a.x);
  const maxAbs=Math.max(0.5,...sorted.map(s=>Math.abs(s.x)));
  const li=s=>{ const ahead=s.x>=0, w=Math.round(Math.abs(s.x)/maxAbs*88);
    const arrow=s.y>=0?'<span class="pos" title="beating the S&amp;P by more lately (lead growing)">▲</span>':'<span class="neg" title="lead is shrinking">▼</span>';
    return `<div class="crow lrow" data-sect="${esc(s.name)}"><span class="ct" style="width:104px">${esc(sectorShort(s.name))}</span>`+
      `<span class="cv ${ahead?'pos':'neg'}" style="width:56px;margin-left:0">${ahead?'+':''}${s.x.toFixed(1)}%</span>`+
      `<span style="width:16px;text-align:center">${arrow}</span>`+
      `<span class="cbar" style="width:${w}px;background:${ahead?'var(--up)':'var(--down)'};opacity:.55"></span></div>`; };
  return `<div class="cp-sub" style="margin:16px 2px 8px">Sectors ranked vs the S&amp;P (${leadersDays()}d) <span class="sec" style="text-transform:none;letter-spacing:0">· ▲ lead growing · ▼ shrinking · click a row to drill in</span></div>`+
    sorted.map(li).join('');
}
function attachLeadersHandlers(){ el('sect-map').querySelectorAll('.lead, .lrow').forEach(g=>g.addEventListener('click',()=>{ state.sect.sel=g.dataset.sect; renderSectorDetail(); el('sect-detail').scrollIntoView({behavior:'smooth',block:'nearest'}); })); }
function renderSectorMap(list){
  const W=760,H=380, px0=52,px1=W-18, py0=H-30, py1=20;
  const plot=list.filter(g=>g.direction!=null&&g.name!=='Unclassified');
  if(plot.length<1) return '<div class="msg">No classified sectors with returns yet.</div>';
  const maxVol=Math.max(1,...plot.map(g=>g.totVol||0));
  const xM=d=>px0+(clamp(d,-100,100)+100)/200*(px1-px0);
  const yM=h=>py0-clamp(h,0,100)/100*(py0-py1);
  const cx0=xM(0), cy50=yM(50);
  let s=`<svg class="smapsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">`;
  s+=`<rect x="${px0}" y="${py1}" width="${px1-px0}" height="${py0-py1}" fill="var(--panel2)" opacity="0.35"/>`;
  s+=`<line x1="${cx0}" y1="${py1}" x2="${cx0}" y2="${py0}" stroke="var(--border)" stroke-dasharray="4 4"/>`;
  s+=`<line x1="${px0}" y1="${cy50}" x2="${px1}" y2="${cy50}" stroke="var(--border)" stroke-dasharray="4 4"/>`;
  const ql='font-family:var(--mono);font-size:10px;fill:var(--faint)';
  s+=`<text x="${px1-6}" y="${py1+14}" text-anchor="end" style="${ql}">accumulation ▲in</text>`;
  s+=`<text x="${px0+6}" y="${py1+14}" style="${ql}">distribution ▲out</text>`;
  s+=`<text x="${px1-6}" y="${py0-6}" text-anchor="end" style="${ql}">stealth inflow</text>`;
  s+=`<text x="${px0+6}" y="${py0-6}" style="${ql}">quiet / lagging</text>`;
  s+=`<text x="${(px0+px1)/2}" y="${H-6}" text-anchor="middle" style="${ql}">← outflow   ·   capital direction   ·   inflow →</text>`;
  s+=`<text x="14" y="${(py0+py1)/2}" text-anchor="middle" transform="rotate(-90 14 ${(py0+py1)/2})" style="${ql}">activity heat →</text>`;
  const nodes=plot.map(g=>({cx:xM(g.direction),cy:yM(g.heat),r:6+24*Math.sqrt((g.totVol||0)/maxVol),label:sectorShort(g.name),g}));
  layoutMapLabels(nodes,{px0,px1,py1,py0});
  for(const n of nodes){ const g=n.g, col=momColor(g.direction);
    const lp=mapLabelSvg(n,10);
    s+=`<g class="bub" data-sect="${esc(g.name)}" style="cursor:pointer"><title>${esc(g.name)} · rotation ${Math.round(g.direction)} · heat ${g.heat} · ret ${g.ret==null?'n/a':(g.ret>=0?'+':'')+g.ret.toFixed(2)+'%'} · ΔOI ${g.doi==null?'n/a':(g.doi>=0?'+':'')+g.doi.toFixed(2)+'%'}</title>`;
    s+=lp.leader;
    s+=`<circle cx="${n.cx.toFixed(1)}" cy="${n.cy.toFixed(1)}" r="${n.r.toFixed(1)}" fill="${col}" fill-opacity="0.32" stroke="${col}" stroke-width="1.4"/>`;
    s+=lp.txt+`</g>`; }
  s+='</svg>';
  return s;
}
function attachMapHandlers(){ el('sect-map').querySelectorAll('.bub').forEach(b=>b.addEventListener('click',()=>{ state.sect.sel=b.dataset.sect; renderSectorDetail(); el('sect-detail').scrollIntoView({behavior:'smooth',block:'nearest'}); })); }
function heatBar(h){ const c=h>=66?'var(--accent)':h>=33?'var(--blue)':'var(--faint)'; return `<span style="display:inline-block;vertical-align:middle;width:46px;height:7px;border-radius:3px;background:var(--grid)"><span style="display:block;height:7px;border-radius:3px;width:${clamp(h,0,100)}%;background:${c}"></span></span>`; }
function rotCell(d){ if(d==null)return '<span class="na">—</span>'; const s=d>0?'+':''; return `<span style="color:${momColor(d)};font-weight:600">${s}${Math.round(d)}</span>`; }
function renderSectorBoard(list){
  const rows=list.map(g=>{
    const sel=state.sect.sel===g.name?' style="background:rgba(227,165,60,.08)"':'';
    return `<tr data-sect="${esc(g.name)}"${sel}>`+
      `<td class="pp">${esc(sectorShort(g.name))}</td>`+
      `<td class="sec" style="text-align:left">${esc(g.assetClass)}</td>`+
      `<td class="sec">${g.n}</td>`+
      `<td>${rotCell(g.rotation)}</td>`+
      `<td>${heatBar(g.heat)}</td>`+
      `<td class="${g.ret>=0?'pos':'neg'}">${g.ret==null?'<span class="na">—</span>':(g.ret>=0?'+':'')+g.ret.toFixed(2)+'%'}</td>`+
      `<td class="${g.doi>=0?'pos':'neg'}">${g.doi==null?'<span class="na">—</span>':(g.doi>=0?'+':'')+g.doi.toFixed(2)+'%'}</td>`+
      `<td class="sec" title="${g.greenN}/${g.greenT} up${g.momUp!=null?' · '+Math.round(g.momUp*100)+'% mom+':''}">${g.green==null?'—':Math.round(g.green*100)+'%'}</td>`+
      `<td class="sec">${fmtUsd(g.totVol)}</td>`+
      `<td class="sec">${fmtUsd(g.totOI)}</td>`+
      `<td class="sec" title="avg internal daily-return correlation">${g.cohesion==null?'·':g.cohesion.toFixed(2)}</td>`+
      `</tr>`;
  }).join('');
  const head='<thead><tr><th>Sector</th><th style="text-align:left">Type</th><th>#</th><th title="capital direction: price + OI conviction, ranked across sectors">Rotation</th><th>Heat</th><th>Return</th><th title="avg open-interest change over the window">ΔOI</th><th title="% of members up">Breadth</th><th>24h Vol</th><th>OI</th><th title="avg internal correlation">Cohesion</th></tr></thead>';
  el('sect-board').innerHTML=`<div class="cp-head" style="margin-bottom:10px">Sector rotation board <span class="sec" style="font-weight:400">— ${state.tf} window · ${state.sect.wt==='eq'?'equal-weighted':'volume-weighted'} · click a row or bubble for detail</span></div>`+
    `<div style="overflow-x:auto"><table class="ptbl" style="min-width:760px">${head}<tbody>${rows}</tbody></table></div>`;
  el('sect-board').querySelectorAll('tbody tr[data-sect]').forEach(tr=>tr.addEventListener('click',()=>{ state.sect.sel=tr.dataset.sect; renderSectorDetail(); el('sect-detail').scrollIntoView({behavior:'smooth',block:'nearest'}); }));
}
function renderSectorDetail(){
  const p=el('sect-detail'), list=SECT._rows, name=state.sect.sel;
  if(!list||!name){ p.hidden=true; return; }
  const g=list.find(x=>x.name===name); if(!g){ p.hidden=true; return; }
  const tfKey=TF_MAP[state.tf]||'d1';
  const bench=state.benchCoin?state.rows.get(state.benchCoin):null, benchRet=bench?bench[tfKey]:null;
  const rs=(g.ret!=null&&benchRet!=null)?g.ret-benchRet:null;
  const ms=[...g.members].sort((a,b)=>((b[tfKey]||-1e9)-(a[tfKey]||-1e9)));
  const mrow=r=>`<tr data-coin="${esc(r.coin)}"><td class="pp">${esc(r.ticker)}</td>`+
    `<td class="${(r[tfKey]||0)>=0?'pos':'neg'}">${r[tfKey]==null?'<span class="na">·</span>':(r[tfKey]>=0?'+':'')+r[tfKey].toFixed(2)+'%'}</td>`+
    `<td class="${(r.doi||0)>=0?'pos':'neg'}">${r.doi==null?'<span class="na">·</span>':(r.doi>=0?'+':'')+r.doi.toFixed(2)+'%'}</td>`+
    `<td>${r.mom==null?'<span class="ph">·</span>':`<span style="color:${momColor(r.mom)}">${r.mom>0?'+':''}${Math.round(r.mom)}</span>`}</td>`+
    `<td class="sec">${r.vol30!=null?r.vol30.toFixed(0)+'%':'·'}</td>`+
    `<td class="sec">${fmtUsd(r.vol)}</td></tr>`;
  const st=(k,v)=>`<span>${k}<b>${v}</b></span>`;
  p.hidden=false;
  p.innerHTML=`<div class="cp-head">${esc(sectorShort(g.name))} <span class="sec" style="font-weight:400">— ${esc(g.assetClass)} · ${g.n} markets · ${state.tf} window</span>`+
    `<button class="btn xtiny" id="sectDetClose" style="float:right">✕</button></div>`+
    `<div class="pairstats">${st('rotation ', rotCell(g.rotation))}${st('heat ', g.heat)}`+
      `${st('return ', g.ret==null?'—':`<span class="${g.ret>=0?'pos':'neg'}">${g.ret>=0?'+':''}${g.ret.toFixed(2)}%</span>`)}`+
      `${st('ΔOI ', g.doi==null?'—':`<span class="${g.doi>=0?'pos':'neg'}">${g.doi>=0?'+':''}${g.doi.toFixed(2)}%</span>`)}`+
      `${st('vs S&amp;P ', rs==null?'—':`<span class="${rs>=0?'pos':'neg'}">${rs>=0?'+':''}${rs.toFixed(2)}%</span>`)}`+
      `${st('breadth ', g.green==null?'—':`${g.greenN}/${g.greenT}`)}`+
      `${st('cohesion ', g.cohesion==null?'·':g.cohesion.toFixed(2))}`+
      `${st('24h vol ', fmtUsd(g.totVol))}${st('OI ', fmtUsd(g.totOI))}</div>`+
    `<div class="cp-sub">Members <span class="sec" style="text-transform:none;letter-spacing:0">· sorted by ${state.tf} return · click to open the ticker</span></div>`+
    `<div style="overflow-x:auto"><table class="ptbl"><thead><tr><th>Ticker</th><th>${state.tf}</th><th>ΔOI</th><th>Mom</th><th>Vol</th><th>24h Vol</th></tr></thead><tbody>${ms.map(mrow).join('')}</tbody></table></div>`;
  el('sectDetClose').onclick=()=>{ state.sect.sel=null; p.hidden=true; renderSectorBoard(SECT._rows); };
  p.querySelectorAll('tbody tr[data-coin]').forEach(tr=>tr.addEventListener('click',()=>openDetail(tr.dataset.coin)));
  renderSectorBoard(SECT._rows);
}
function renderSectorCorr(list){
  const box=el('sect-corr');
  const tf=({'7':1,'30':1,'90':1}[state.sect.corrTf])?state.sect.corrTf:'30';
  const btn=(d,on)=>`<button type="button" data-scorr="${d}" style="font:inherit;cursor:pointer;padding:2px 8px;margin-left:4px;border-radius:4px;border:1px solid ${on?'var(--accent)':'var(--grid)'};background:transparent;color:${on?'var(--accent)':'inherit'};font-weight:${on?600:400}">${d}d</button>`;
  const ctl=`<div class="cp-head" style="margin-bottom:8px;display:flex;align-items:center;flex-wrap:wrap;gap:4px">`
    +`Sector × sector correlation <span class="sec" style="font-weight:400">— ${tf}d daily-return correlation, averaged across members</span>`
    +`<span style="margin-left:auto"><span class="sec" style="margin-right:2px">lookback</span>${btn('7',tf==='7')}${btn('30',tf==='30')}${btn('90',tf==='90')}</span></div>`;
  const bind=()=>{ box.querySelectorAll('button[data-scorr]').forEach(b=>b.addEventListener('click',()=>{
    state.sect.corrTf=b.dataset.scorr; if(!el('view-sectors').hidden) renderSectors(); })); };
  const cache=SECT._corrCache;
  if(!cache){ box.innerHTML=ctl+`<div class="sec" style="padding:8px 2px">Daily history still loading — sector correlation appears automatically once enough markets have it.${warmCount()}</div>`; bind(); return; }
  const {C, idxByG}=cache;
  const names=list.map(g=>g.name).filter(n=>idxByG.has(n)&&idxByG.get(n).length);
  if(names.length<2){ box.innerHTML=ctl+'<div class="sec" style="padding:8px 2px">Need at least two sectors with daily history.</div>'; bind(); return; }
  const avg=(A,B)=>{ const ia=idxByG.get(A), ib=idxByG.get(B); let s=0,n=0;
    for(const i of ia)for(const j of ib){ if(A===B&&j<=i)continue; const v=C[i][j]; if(v!=null&&isFinite(v)){s+=v;n++;} }
    return n?s/n:null; };
  const cell=names.length<=8?34:names.length<=14?24:18;
  let h=`<table class="cmx" style="--cell:${cell}px"><thead><tr><th class="corner"></th>`;
  names.forEach(n=>h+=`<th class="cl"><span>${esc(sectorShort(n))}</span></th>`);
  h+='</tr></thead><tbody>';
  names.forEach(rn=>{ h+=`<tr><th class="rl">${esc(sectorShort(rn))}</th>`;
    names.forEach(cn=>{ const self=rn===cn, v=self?1:avg(rn,cn);
      const txt=(v==null)?'':`${v<0?'−':''}${Math.abs(v).toFixed(1).replace(/^0/,'')}`;
      h+=`<td class="${self?'diag':(v==null?'nodata':'')}" title="${esc(sectorShort(rn))} × ${esc(sectorShort(cn))} · ${tf}d: ${v==null?'n/a':v.toFixed(2)}" style="${self||v==null?'':'background:'+corrColor(v)}">${self?'':txt}</td>`; });
    h+='</tr>'; });
  h+='</tbody></table>';
  box.innerHTML=ctl+h;
  bind();
}
function exportSectors(){ const list=SECT._rows; if(!list) return;
  const head=['Sector','Type','Members','Rotation','Heat','Return%','DeltaOI%','Breadth%','Vol24h','OI','Cohesion'];
  const body=list.map(g=>[g.name,g.assetClass,g.n, g.rotation!=null?Math.round(g.rotation):'', g.heat,
    g.ret!=null?g.ret.toFixed(2):'', g.doi!=null?g.doi.toFixed(2):'', g.green!=null?Math.round(g.green*100):'',
    g.totVol!=null?Math.round(g.totVol):'', g.totOI!=null?Math.round(g.totOI):'', g.cohesion!=null?g.cohesion.toFixed(3):'']);
  downloadCSV(`xyz-sectors-${state.tf}.csv`,[head,...body]); }

// ===== polling cycle + countdown =====
let cycleTimer=null, nextCycle=0, dailyTimer=null;
// Daily refetch cadence is adaptive. The old fixed 15-min interval meant a tab open across a
// redeploy (or opened mid-warmup) showed empty leaders/correlation panels for up to 15 minutes
// AFTER the server was already warm. While coverage is incomplete we poll every 20s — the
// server rebuilds /api/daily every 60s and serves 304s in between, so this is nearly free —
// then relax to 15 min once the benchmark plus ~80% of active markets have daily history.
function dailyWarm(){
  const rows=activeRows(); if(!rows.length) return true;
  let have=0; for(const r of rows) if(r.daily&&r.daily.length>=5) have++;
  const b=state.benchCoin?state.rows.get(state.benchCoin):null;
  const benchOk=!state.benchCoin||(b&&b.daily&&b.daily.length>=5);
  return !benchOk || have<rows.length*0.8;
}
function scheduleDaily(){
  clearTimeout(dailyTimer);
  dailyTimer=setTimeout(async()=>{ await loadDaily(); scheduleDaily(); }, dailyWarm()? 20*1000 : 15*60*1000);
}
// Live warmup annotation for placeholder panels, fed by the snapshot's server-side counts.
function warmCount(){
  const w=state.warm;
  if(!w||!(w.d>0)) return '';
  return ` <span class="sec">(server backfill in progress — <b>${w.d}</b> market${w.d===1?'':'s'} remaining, refreshing every 20s)</span>`;
}
function startCycle(){ clearInterval(cycleTimer); cycleTimer=setInterval(()=>{ loadSnapshot(); nextCycle=Date.now()+state.refreshMs; }, state.refreshMs); nextCycle=Date.now()+state.refreshMs; }
function setRefresh(ms){ state.refreshMs=ms; state.pollMs=ms; startCycle(); }
function forceRefresh(){ loadSnapshot(); nextCycle=Date.now()+state.refreshMs; }
setInterval(()=>{ const left=Math.max(0,nextCycle-Date.now()), m=Math.floor(left/60000), s=Math.floor((left%60000)/1000);
  el('cd').textContent=m+':'+String(s).padStart(2,'0'); updateFreshness(); },500);

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
el('watchOnly').addEventListener('click',()=>{ state.watchOnly=!state.watchOnly; el('watchOnly').classList.toggle('on', state.watchOnly); updateFilterChip(); render(); savePrefs(); });
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
  updateFilterChip(); render(); savePrefs();
}
['volMin','volMax','oiMin','oiMax'].forEach(id=>el(id).addEventListener('input', applyNumFilters));
applyNumFilters();
el('clearFilters').addEventListener('click', ()=>{ ['volMin','volMax','oiMin','oiMax'].forEach(id=>{ el(id).value=''; el(id).classList.remove('bad'); });
  state.filters={volMin:null,volMax:null,oiMin:null,oiMax:null}; updateFilterChip(); render(); savePrefs(); });
function updateFilterChip(){
  const f=state.filters, on = f.volMin!=null||f.volMax!=null||f.oiMin!=null||f.oiMax!=null||!!state.watchOnly;
  const dot=el('filtDot'); if(dot) dot.hidden=!on;
  const b=el('filtersBtn'); if(b) b.classList.toggle('on', on);
}
el('filtersBtn').addEventListener('click',e=>{ e.stopPropagation(); const pop=el('filterpop');
  if(pop.hidden){ pop.hidden=false; el('filtersBtn').setAttribute('aria-expanded','true'); const m=el('volMin'); if(m) m.focus(); }
  else { pop.hidden=true; el('filtersBtn').setAttribute('aria-expanded','false'); } });
document.addEventListener('click',e=>{ const pop=el('filterpop');
  if(pop && !pop.hidden && !pop.contains(e.target) && !el('filtersBtn').contains(e.target)){ pop.hidden=true; el('filtersBtn').setAttribute('aria-expanded','false'); } });
function buildColMenu(){ const pop=el('colpop'); let h='<div class="cphead">Show columns · drag headers to reorder</div>';
  for(const key of state.colOrder){ const c=COL_BY_KEY[key]; if(!c) continue;
    const dis=c.hideable===false, checked=!state.colHidden.has(key);
    h+=`<label class="copt${dis?' dis':''}"><input type="checkbox" data-col="${key}" ${checked?'checked':''} ${dis?'disabled':''}/> ${esc(c.label)}</label>`; }
  h+='<button class="btn" id="colReset" style="margin-top:8px;width:100%;justify-content:center">Reset layout</button>';
  pop.innerHTML=h;
  pop.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.addEventListener('change',()=>{
    const k=cb.dataset.col; if(cb.checked) state.colHidden.delete(k); else state.colHidden.add(k); buildHead(); render(); savePrefs(); }));
  el('colReset').addEventListener('click',()=>{ state.colOrder=[...DEFAULT_ORDER]; state.colHidden=new Set(DEFAULT_HIDDEN); buildColMenu(); buildHead(); render(); savePrefs(); });
}
el('colsBtn').addEventListener('click',e=>{ e.stopPropagation(); const pop=el('colpop');
  if(pop.hidden){ buildColMenu(); pop.hidden=false; el('colsBtn').setAttribute('aria-expanded','true'); }
  else { pop.hidden=true; el('colsBtn').setAttribute('aria-expanded','false'); } });
document.addEventListener('click',e=>{ const pop=el('colpop');
  if(pop && !pop.hidden && !pop.contains(e.target) && !el('colsBtn').contains(e.target)){ pop.hidden=true; el('colsBtn').setAttribute('aria-expanded','false'); } });
function setWindow(tf){ state.tf=tf;
  document.querySelectorAll('#tfseg button').forEach(x=>x.classList.toggle('active',x.dataset.tf===tf));
  document.querySelectorAll('#sectf button').forEach(x=>x.classList.toggle('active',x.dataset.tf===tf));
  buildHead(); render(); renderRegimeStrip();
  if(!el('view-sectors').hidden) renderSectors();
  savePrefs(); }
document.querySelectorAll('#tfseg button').forEach(b=>{ if(b.dataset.tf===state.tf)b.classList.add('active');
  b.addEventListener('click',()=>setWindow(b.dataset.tf)); });
document.querySelectorAll('#sectf button').forEach(b=>{ if(b.dataset.tf===state.tf)b.classList.add('active');
  b.addEventListener('click',()=>setWindow(b.dataset.tf)); });
document.querySelectorAll('#sectwt button').forEach(b=>{ if(b.dataset.wt===state.sect.wt)b.classList.add('active');
  b.addEventListener('click',()=>{ state.sect.wt=b.dataset.wt;
    document.querySelectorAll('#sectwt button').forEach(x=>x.classList.toggle('active',x===b));
    if(!el('view-sectors').hidden) renderSectors(); }); });
el('sectExport').addEventListener('click', exportSectors);
document.querySelectorAll('#sectmode button').forEach(b=>{ if(b.dataset.mode===state.sect.mode)b.classList.add('active');
  b.addEventListener('click',()=>{ state.sect.mode=b.dataset.mode;
    document.querySelectorAll('#sectmode button').forEach(x=>x.classList.toggle('active',x===b));
    if(!el('view-sectors').hidden) renderSectors(); }); });
document.querySelectorAll('#rfseg button').forEach(b=>{ if(+b.dataset.ms===state.refreshMs)b.classList.add('active');
  b.addEventListener('click',()=>{ document.querySelectorAll('#rfseg button').forEach(x=>x.classList.toggle('active',x===b));
    setRefresh(+b.dataset.ms); savePrefs(); }); });
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>showView(t.dataset.view)));
document.querySelectorAll('[data-scope]').forEach(b=>b.addEventListener('click',()=>setScope(b.dataset.scope)));
applyScope();
(function(){ const isAmber=()=>document.documentElement.getAttribute('data-theme')==='amber';
  const setLabel=()=>{ const b=el('themeBtn'); if(b) b.textContent = isAmber()?'◐ dark':'◐ amber'; };
  setLabel();
  el('themeBtn').addEventListener('click',()=>{
    if(isAmber()){ document.documentElement.removeAttribute('data-theme'); store.set('xyzmon.theme','dark'); }
    else { document.documentElement.setAttribute('data-theme','amber'); store.set('xyzmon.theme','amber'); }
    setLabel();
    render(); if(!el('view-sectors').hidden) renderSectors(); if(!el('view-corr').hidden) renderCorr();
  });
})();
document.querySelectorAll('#corrtf button').forEach(b=>{ if(b.dataset.d===state.corr.tf)b.classList.add('active');
  b.addEventListener('click',()=>{ state.corr.tf=b.dataset.d; document.querySelectorAll('#corrtf button').forEach(x=>x.classList.toggle('active',x===b));
    if(!el('view-corr').hidden) renderCorr(); }); });
document.querySelectorAll('#corrn button').forEach(b=>{ if(+b.dataset.n===state.corr.topN)b.classList.add('active');
  b.addEventListener('click',()=>{ state.corr.topN=+b.dataset.n; state.corr.selected=null; state.corr.pair=null; document.querySelectorAll('#corrn button').forEach(x=>x.classList.toggle('active',x===b));
    if(!el('view-corr').hidden) openCorr(); }); });
document.querySelectorAll('#corrtop button').forEach(b=>{ if(+b.dataset.k===state.corr.topPairs)b.classList.add('active');
  b.addEventListener('click',()=>{ state.corr.topPairs=+b.dataset.k; document.querySelectorAll('#corrtop button').forEach(x=>x.classList.toggle('active',x===b)); renderCorrPairs(); }); });
let corrSearchT=null;
// ===== per-tab help ("?" in the nav): how to READ each view, not just what it shows =====
const HELP={
markets:`
<div class="hlp-h">The table</div>
<p>One row per market, one column per lens. The <b>window selector</b> (1h–30d) re-anchors every windowed column at once: <b>vs S&amp;P</b>, <b>ΔOI</b>, <b>Squeeze</b>, <b>Carry</b>, and Avg Range all answer "over this window". Click any header to sort; drag in the column menu (⚙) to reorder or hide. Cell shading scales with the size of the move — a wall of deep red 7d cells IS the market breadth read. <b>★</b> pins a name to the top. Everything deep-links: the URL carries your view, so a layout can be shared.</p>
<div class="hlp-h">Funding — the crowd's payment</div>
<p>Annualized APR: <b class="pos">green = longs pay</b> to hold (crowded long), <b class="neg">red = shorts pay</b> (crowded short — squeeze fuel). The ▴/▾ percentile flag fires when today's funding sits at a monthly extreme of that market's <i>own</i> 31d distribution — the crowd is paying near its max, the classic mean-reversion zone. <b>Carry</b> divides window funding by realized vol: how much you're paid per unit of risk just for taking the unpopular side.</p>
<div class="hlp-h">ΔOI and the regime tag</div>
<p>Open-interest change answers "is money entering or leaving?" — but only <i>with price</i> does it tell a story. The four tags: <b class="pos">longs+</b> price↑/OI↑ (new money confirming), <b>squeeze</b> price↑/OI↓ (shorts covering, NOT fresh demand), <b class="neg">shorts+</b> price↓/OI↑ (new money pressing lower), <b>unwind</b> price↓/OI↓ (longs deleveraging, not fresh shorting). Hover for conviction and whether funding corroborates the story. Caveat that matters: OI is symmetric — long/short attribution is always an inference, never an observation.</p>
<div class="hlp-h">Momentum, levels, structure</div>
<p><b>Momentum</b> (−100…+100) is self-normalizing: risk-adjusted multi-horizon returns × trend quality, tilted by range position, modulated by OI conviction — comparable across a quiet FX pair and a violent pre-IPO synthetic. The ● dot means volume above the market's own norm. <b>vs 30d hi / vs YTD hi</b> are distance below the high (0% = at it now). <b>Y open / M open</b> show the level the period opened at — on a 24/7 perp that IS the prior day's close — green when price is above. MAs are daily-close SMAs; dashes are honest (not enough history), never fabricated.</p>
<div class="hlp-h">Prem and Gap — the off-hours edge</div>
<p><b>Prem</b> is the perp vs oracle dislocation in bp. When the cash market is <i>closed</i>, the oracle freezes near the last print — so a persistent premium or discount is the live off-hours price discovery, and the tradeable reversion. <b>Gap</b> is the last close→open move (live while the market is closed); its hover carries the cumulative 30d off-hours drift — a persistent sign there is the overnight effect.</p>
<div class="hlp-h">Squeeze &amp; OI/Vol</div>
<p><b>Squeeze</b> (0–100) is how loaded the spring is: crowding (shorts paying) × fuel (OI building) × trigger (price pressing the 30d high). Zero whenever funding is positive — no crowded shorts, no squeeze. <b>OI/Vol</b> is standing positioning ÷ daily flow: ≥2× means stale, crowded positioning that can't exit quickly — fragile to squeezes and unwinds. High squeeze + negative funding + rising OI + high OI/Vol is the full configuration.</p>
<div class="hlp-h">Crypto scope</div>
<p>The Stocks|Crypto switch is a hard wall: separate universes, separate benchmark (BTC, not S&amp;P), no mixing anywhere. Crypto adds the tape strip up top — <b>crowd pays</b> (OI-weighted funding APR: euphoria tax vs squeeze fuel), <b>breadth</b>, total OI with its weighted delta, BTC's day, and the alt-season gauge. Session concepts (gap) vanish: a 24/7 market has none. Crypto history is 31d by design, so long MAs and YTD columns show honest dashes.</p>`,
sectors:`
<div class="hlp-h">Flow map (default)</div>
<p>Each bubble is a sector. <b>Horizontal = capital direction</b>: a blend of return and OI-conviction — right means money flowing in <i>with</i> conviction, left means flowing out. <b>Vertical = heat</b>: activity from volume and volatility. So <b>top-right = accumulation</b> (in, loudly), <b>top-left = distribution</b> (out, loudly), and the bottom half is simply quiet. Bubble size = 24h volume. Click a bubble for the sector's members.</p>
<div class="hlp-h">Leadership map</div>
<p>Positioning vs the S&amp;P over the window. <b>Right of center = beating it, left = behind</b>. <b>Up = the lead is growing, down = shrinking</b>. That yields four regimes: <b class="pos">Leaders</b> (ahead &amp; pulling away), <b>Catching up</b> (behind but gaining — early rotation candidates), <b>Cooling</b> (ahead but fading — where leadership goes to die), <b class="neg">Laggards</b>. The interesting cells are the off-diagonal ones: a sector migrating from Catching-up toward Leaders is rotation happening in front of you. Intraday windows floor to 7d — leadership needs multi-day evidence.</p>
<div class="hlp-h">Rotation board &amp; cohesion</div>
<p>The board ranks sectors by capital direction with the same inputs as the flow map. <b>Cohesion</b> is the average pairwise correlation <i>inside</i> a sector: high cohesion means the sector trades as one macro block (own the theme, any name); low cohesion means it's a stock-picker's sector where the label tells you little.</p>
<div class="hlp-h">Sector × sector correlation</div>
<p>Average pairwise daily-return correlation between members of each pair of sectors (90d). Deep co-movement between two sectors means they're one risk factor wearing two names — diversifying across them is cosmetic.</p>`,
corr:`
<div class="hlp-h">The matrix</div>
<p>Pairwise correlation of <b>daily log returns</b> over the chosen lookback. Rows/columns are <b>cluster-ordered</b> (UPGMA on correlation distance), so blocks along the diagonal are real co-movement families — the visual structure IS the finding. Color runs inverse→co-moving; the number of overlapping days (n) is in every hover — a ±0.9 on 12 overlapping days is noise wearing a costume. Use the focus search to isolate tickers, and the top-by-vol selector to widen or tighten the universe.</p>
<div class="hlp-h">Pair view (click a cell)</div>
<p>Three reads on one pair. <b>Hedge β</b>: units of B per unit of A for a beta-neutral pair. The <b>beta-adjusted spread</b> ln(A) − β·ln(B) with its mean ±1σ band — the <b>z-score</b> says how stretched the pair is <i>relative to its own history</i>: beyond ±1.5–2, A is rich or cheap vs B, the mean-reversion trade. The <b>rolling correlation</b> tells you whether the relationship is stable enough to trust: a spread z-score on a pair whose correlation is disintegrating is not a signal, it's a divorce.</p>
<div class="hlp-h">Co-movers &amp; hedges (click a ticker label)</div>
<p>The names that move with it (proxies, contagion map) and against it (natural hedges). Strongest-pairs below surfaces the tightest relationships across the whole set. ↓ CSV exports the matrix.</p>`,
sessions:`
<div class="hlp-h">Session decomposition — the flagship</div>
<p>What an <b>overnight</b> (close→open), <b>weekend</b> (Fri→Mon), and <b>cash</b> (open→close) hold actually pays, pooled one equal-weight bet per calendar boundary across the equity class, compounded into equity curves. <b>Gross</b> vs <b>net</b>: the shaded band is the running funding drag — an edge that dies net-of-funding is not an edge, it's a donation. A persistently rising overnight curve while the cash curve is flat is the classic overnight effect; the drawer's "where the 30d return happened" split is the per-name version of the same question.</p>
<div class="hlp-h">The clocks</div>
<p><b>Hour-of-day activity</b>: when each market is actually alive, in its own volume norm — trade the loud hours, mistrust prints from the dead ones. <b>Funding clock</b>: when the payment concentrates. <b>Day-of-week 7×24 heatmap</b> and <b>return seasonality by hour</b>: where returns systematically cluster in the week — read these with sample-size humility, seasonality is the easiest pattern to hallucinate.</p>
<div class="hlp-h">Structure panels</div>
<p><b>Cross-ticker clustering</b> groups markets by the shape of their trading day; <b>asset-class overlays</b> compare the composite day of equities vs FX vs commodities. Panels unlock as the 60-day hourly spine accrues — an empty panel means insufficient coverage, not a bug.</p>
<div class="hlp-h">Every chart hovers</div>
<p>Crosshair + readout on all curves: date, value, and breadth (how many names stood behind that point). Points built on thin breadth deserve less trust.</p>`,
signals:`
<div class="hlp-h">What a signal is</div>
<p>An unusual condition, ranked — <b>never a prediction</b>. Score = unusualness now (0–50) + historical edge: the market's <b>own base rate</b> when it has ≥8 occurrences, else the <b>asset-class pooled</b> rate at a 30% discount, else a token score. Every base rate shows n, median forward outcome, and hit — evidence, not adjectives. <i>unproven</i> = flag without history; <i>neg exp</i> = past occurrences lost money on average (shown for awareness, ranked as noise).</p>
<div class="hlp-h">Self-audit — the part to trust</div>
<p>Every fired signal is <b>ledgered at its mark and resolved at its horizon</b>, out-of-sample. The record blends back into scoring (weight grows with resolved count — trust migrates from backtest to reality), and event types whose live record shows no edge get capped automatically. In the accuracy panel: <b>live hit/med vs claimed</b> is the honesty gap; <b>pf</b> (profit factor) catches the 55%-hit event that still loses money; <b>calibration buckets</b> audit the scorer itself — if 55+ scores don't hit more than &lt;35 scores, the ranking is broken; <b>⛔ stop-aware</b> re-scores every claim as if the void level had been a hard stop.</p>
<div class="hlp-h">Playbooks, prime, decay</div>
<p>Each signal states a side, a mechanical level that voids it, and a target from the historical median — the <b>R:R</b> is scored (poor structure is penalized). <b>★ prime</b> = ≥60% hit, positive expectancy, sound structure at fire time. Signals <b>decay</b> past their claimed horizon (amber) and drop at 2× — a stale signal is not a signal.</p>
<div class="hlp-h">Confluence — direction-aware</div>
<p>Multiple <i>same-side</i> conditions on one name compound (the bonus is <b>earned</b>: once 15+ resolutions exist on each side, it scales to the measured lift of with-company firings, and drops to zero if agreement doesn't prove out). <b>⇄</b> means long AND short fired on one name — flagged, no bonus for anyone, each claim resolves on its own.</p>
<div class="hlp-h">Ticker history</div>
<p>The search bar loads any name's full claim-by-claim audit trail: what fired, at what score and mark, what it claimed, and what actually happened — including open claims counting down to their horizon. The drawer's Signal record is the compact version of the same ledger.</p>
<div class="hlp-h">Self-tuning (shadow variants)</div>
<p>Each gated event runs 2–3 candidate thresholds; only the incumbent emits visible signals, but ALL variants silently ledger shadow claims on identical bookkeeping. A challenger is promoted only on ≥30 out-of-sample resolutions per side with a real expectancy beat — bounded self-improvement, not free re-fitting.</p>`,
backtest:`
<div class="hlp-h">What it is</div>
<p>A client-side, cross-sectional long/short backtest on the daily returns already in your browser — parameter tweaks are instant and cost the server nothing. Ranking rules are deliberately non-fitted; the honest overfitting risk is <i>you</i>, picking parameters by eye.</p>
<div class="hlp-h">How to read the curve</div>
<p>Four lines: <b>net</b> (after funding), <b>gross</b>, <b>benchmark</b>, <b>equal-weight universe</b>. The shaded split is <b>in-sample | out-of-sample</b>: a strategy that only works left of the line was curve-fit by your eyeballs. Judge on OOS net vs equal-weight — beating the benchmark with a long/short book is table stakes; beating naive equal-weight is the actual bar.</p>`,
};
function openHelp(){
  const bg=el('helpbg'), m=el('helpmodal'); if(!bg||!m) return;
  const v=state.scope==='crypto'?'markets':state.view;
  const TITLES={markets:'Markets',sectors:'Sectors',corr:'Correlation',sessions:'Sessions',signals:'Signals',backtest:'Backtest'};
  m.innerHTML=`<div class="hlp-head">How to read: ${TITLES[v]||v}<button class="btn xtiny" id="helpclose" title="close">\u2715</button></div>`
    +`<div class="hlp-sub">What each element means and \u2014 more importantly \u2014 how to interpret it. Every number in the app also explains itself on hover; this is the map. Nothing here is investment advice.</div>`
    +(HELP[v]||HELP.markets);
  bg.hidden=false; m.hidden=false; m.scrollTop=0;
  const cb=el('helpclose'); if(cb) cb.onclick=closeHelp;
}
function closeHelp(){ const bg=el('helpbg'), m=el('helpmodal'); if(bg)bg.hidden=true; if(m)m.hidden=true; }
{ const hb=el('helpBtn'); if(hb) hb.addEventListener('click',openHelp);
  const bg=el('helpbg'); if(bg) bg.addEventListener('click',closeHelp);
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ const m=el('helpmodal'); if(m&&!m.hidden) closeHelp(); } }); }
{ const shq=el('sighist-q');   // claim-history browser on the Signals tab (static markup — survives signals-body re-renders)
  if(shq) shq.addEventListener('input',()=>{ clearTimeout(_shTimer); _shTimer=setTimeout(runSigHist,250); });
  const she=el('sighist-ev');
  if(she){ for(const ev of Object.keys(EV_LABELS)){ const o=document.createElement('option'); o.value=ev; o.textContent=EV_LABELS[ev]; she.appendChild(o); }
    she.addEventListener('change',runSigHist); } }
el('corrsearch').addEventListener('input',e=>{ state.corr.search=e.target.value; state.corr.selected=null; state.corr.pair=null;
  clearTimeout(corrSearchT); corrSearchT=setTimeout(()=>{ if(!el('view-corr').hidden) openCorr(); },300); });
el('mktExport').addEventListener('click', exportMarkets);
el('corrExport').addEventListener('click', exportCorr);

(async ()=>{
  await Promise.all([loadSnapshot(), loadDaily()]);
  applyHash();
  startCycle();
  scheduleDaily();
})();


// ============================================================================
//  Folded-in modules (were separate /public drop-ins; moved here so index.html
//  needs no extra <script> tags). Each self-installs on load.
//    - Treemap tab   - app-wide chart tooltips   - corr 7/30/90 + unclassified
// ============================================================================

// ---- Treemap tab (self-installing; injects its own tab + view) -------------
(function(){
function tmSize(r){ return state.map.size==='oi' ? (r.oi||0) : (r.vol||0); }
function tmRet(r){ const k=TF_MAP[state.tf]||'d1'; const v=r[k]; return (v==null||!isFinite(v))?null:v; }

const MAP_SCALE={ honest:1, balanced:0.5, flat:0.28 };
const MIN_SHARE=0.0012;   // floor: no visible market below ~0.12% of the map

function tmRGB(ret, cap){
  if(ret==null) return null;
  const t=clamp(ret/cap,-1,1), a=Math.abs(t);
  const mid=[26,24,18], up=[70,185,126], dn=[229,96,77], tg=t>=0?up:dn;
  const L=(x,y)=>Math.round(x+(y-x)*a);
  return [L(mid[0],tg[0]),L(mid[1],tg[1]),L(mid[2],tg[2])];
}
function tmFill(rgb){ return rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : 'var(--panel2)'; }
function tmInk(rgb){ if(!rgb) return '#e8e8e0';                        // null → dark tile → light ink
  const lum=0.299*rgb[0]+0.587*rgb[1]+0.114*rgb[2]; return lum>150?'#0d0d0a':'#fff'; }
// crude monospace width estimate; JetBrains Mono ~0.6em per glyph
function tmFits(str, fs){ return str.length*fs*0.60; }
function pctile(arr,p){ const a=arr.filter(x=>x!=null&&isFinite(x)).sort((x,y)=>x-y);
  if(!a.length) return 0; return a[clamp(Math.floor(p*(a.length-1)),0,a.length-1)]; }

function tmCompress(raws, gamma){
  let w=raws.map(v=>Math.pow(Math.max(0,v), gamma));
  let sum=w.reduce((a,b)=>a+b,0)||1;
  w=w.map(x=>x/sum);
  if(gamma<1){ w=w.map(x=>Math.max(x, MIN_SHARE));
    sum=w.reduce((a,b)=>a+b,0); w=w.map(x=>x/sum); }
  return w;
}

// --- squarified layout (Bruls, Huizing, van Wijk) -------------------------
function tmScale(nodes, area){ const tot=nodes.reduce((s,n)=>s+Math.max(0,n.size),0)||1;
  const k=area/tot; nodes.forEach(n=>n.area=Math.max(0,n.size)*k); }
function tmWorst(row, sum, side, extra){
  if(!row.length && extra==null) return Infinity;
  let mx=-Infinity, mn=Infinity, s=sum;
  for(const c of row){ if(c.area>mx)mx=c.area; if(c.area<mn)mn=c.area; }
  if(extra!=null){ if(extra>mx)mx=extra; if(extra<mn)mn=extra; s+=extra; }
  const s2=s*s, d2=side*side; return Math.max(d2*mx/s2, s2/(d2*mn));
}
function tmLayoutRow(row, sum, rect, out){
  if(rect.w>=rect.h){ const rw=sum/rect.h; let cy=rect.y;
    for(const c of row){ const ch=c.area/rw; c.x=rect.x; c.y=cy; c.w=rw; c.h=ch; out.push(c); cy+=ch; }
    return {x:rect.x+rw, y:rect.y, w:rect.w-rw, h:rect.h}; }
  const rh=sum/rect.w; let cx=rect.x;
  for(const c of row){ const cw=c.area/rh; c.x=cx; c.y=rect.y; c.w=cw; c.h=rh; out.push(c); cx+=cw; }
  return {x:rect.x, y:rect.y+rh, w:rect.w, h:rect.h-rh};
}
function tmSquarify(nodes, X,Y,W,H){
  const items=nodes.filter(n=>n.area>0).sort((a,b)=>b.area-a.area);
  const out=[]; let rect={x:X,y:Y,w:W,h:H}, row=[], sum=0, i=0;
  while(i<items.length){ const c=items[i], side=Math.min(rect.w,rect.h);
    if(!row.length || tmWorst(row,sum,side,c.area) <= tmWorst(row,sum,side)){ row.push(c); sum+=c.area; i++; }
    else { rect=tmLayoutRow(row,sum,rect,out); row=[]; sum=0; }
  }
  if(row.length) tmLayoutRow(row,sum,rect,out);
  return out;
}

// --- render ---------------------------------------------------------------
const TM_PAD=2, TM_HEAD=16;
function tmSyncControls(){
  const set=(sel,attr,val)=>document.querySelectorAll(sel+' button').forEach(b=>b.classList.toggle('active',b.dataset[attr]===val));
  set('#tmf','tf',state.tf); set('#mapsize','size',state.map.size); set('#mapscale','scale',state.map.scale);
}
function renderTreemap(){
  const host=el('map-canvas'); if(!host) return;
  if(!state.map) state.map={size:'vol',scale:'balanced',sel:null};
  tmSyncControls();
  if(!state.rows.size){ host.innerHTML='<div class="msg">Markets still loading…</div>'; return; }
  computeDerived();
  const gamma=MAP_SCALE[state.map.scale] ?? 0.5;

  let sectors=computeSectors()
    .map(s=>({ name:s.name, cls:s.assetClass,
      members:[...s.members].filter(r=>tmSize(r)>0)
        .map(r=>({ coin:r.coin, ticker:r.ticker, raw:tmSize(r), ret:tmRet(r) })) }))
    .filter(s=>s.members.length);
  if(!sectors.length){ host.innerHTML='<div class="msg">No markets match the current filters.</div>'; return; }

  const flat=sectors.flatMap(s=>s.members);
  const w=tmCompress(flat.map(m=>m.raw), gamma);
  flat.forEach((m,i)=>m.size=w[i]);
  sectors.forEach(s=>s.size=s.members.reduce((a,m)=>a+m.size,0));

  const W=1000, H=620, cap=Math.max(2, pctile(flat.map(m=>Math.abs(m.ret)), 0.95));

  tmScale(sectors, W*H);
  const cells=tmSquarify(sectors, 0,0,W,H);
  let s=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block;font-family:var(--mono)">`;

  for(const sec of cells){
    s+=`<rect x="${sec.x.toFixed(1)}" y="${sec.y.toFixed(1)}" width="${sec.w.toFixed(1)}" height="${sec.h.toFixed(1)}" fill="var(--panel)" stroke="var(--border)" stroke-width="1"/>`;

    // header band — only when there's real room, so short sectors aren't squashed
    const canHead = sec.w>66 && sec.h>30;
    const head = canHead ? TM_HEAD : 0;
    if(canHead){
      s+=`<rect x="${sec.x.toFixed(1)}" y="${sec.y.toFixed(1)}" width="${sec.w.toFixed(1)}" height="${head}" fill="var(--panel2)"/>`;
      const nm=sectorShort(sec.name).toUpperCase();
      let hfs=Math.min(10, (sec.w-10)/Math.max(1,nm.length*0.62));
      if(hfs>=7) s+=`<text x="${(sec.x+5).toFixed(1)}" y="${(sec.y+11.5).toFixed(1)}" style="font-size:${hfs.toFixed(1)}px;letter-spacing:.4px;fill:var(--muted)">${esc(nm)}</text>`;
    }

    const ix=sec.x+TM_PAD, iy=sec.y+(canHead?head:TM_PAD), iw=sec.w-2*TM_PAD, ih=sec.h-(canHead?head:TM_PAD)-TM_PAD;
    if(iw<3||ih<3) continue;
    tmScale(sec.members, iw*ih);
    const tiles=tmSquarify(sec.members, ix,iy,iw,ih);

    for(const t of tiles){
      const rgb=tmRGB(t.ret, cap), fill=tmFill(rgb), ink=tmInk(rgb);
      const rp=t.ret==null?'n/a':(t.ret>=0?'+':'')+t.ret.toFixed(2)+'%';
      s+=`<g class="tm-tile" data-coin="${esc(t.coin)}" style="cursor:pointer">`;
      s+=`<title>${esc(t.ticker)} · ${rp} (${state.tf}) · ${fmtUsd(t.raw)} ${state.map.size==='oi'?'OI':'vol'}</title>`;
      s+=`<rect x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" width="${t.w.toFixed(1)}" height="${t.h.toFixed(1)}" fill="${fill}" stroke="var(--bg)" stroke-width="1"/>`;

      // labels: only draw what actually fits the tile — never overflow
      const availW=t.w-5, cx=(t.x+t.w/2);
      let fs=Math.min(11, availW/Math.max(1,t.ticker.length*0.60));
      if(t.w>=24 && t.h>=13 && fs>=6.5){
        fs=clamp(fs,6.5,11);
        const twoLines = t.h>=30 && t.ret!=null;
        let pfs=Math.min(fs-1, availW/Math.max(1,rp.length*0.60));
        const showPct = twoLines && pfs>=6.5 && tmFits(rp,pfs)<=availW;
        const tickY = showPct ? (t.y+t.h/2-1) : (t.y+t.h/2+fs*0.34);
        s+=`<text x="${cx.toFixed(1)}" y="${tickY.toFixed(1)}" text-anchor="middle" style="font-size:${fs.toFixed(1)}px;fill:${ink};font-weight:600">${esc(t.ticker)}</text>`;
        if(showPct)
          s+=`<text x="${cx.toFixed(1)}" y="${(t.y+t.h/2+pfs+1).toFixed(1)}" text-anchor="middle" style="font-size:${pfs.toFixed(1)}px;fill:${ink};opacity:.82">${rp}</text>`;
      }
      s+='</g>';
    }
  }
  s+='</svg>';
  host.innerHTML=s;

  const lg=el('map-legend');
  if(lg) lg.innerHTML = `<b>Treemap</b> — size = ${state.map.size==='oi'?'open interest':'24h volume'}, color = return over ${state.tf}. `
    + (gamma<1
        ? `<span class="sec">areas compressed for legibility (${esc(state.map.scale)}) — hover for the exact figure.</span>`
        : `<span class="sec">areas are literally proportional.</span>`);

  el('map-canvas').querySelectorAll('.tm-tile').forEach(g=>g.addEventListener('click',()=>{
    const coin=g.dataset.coin;
    if(typeof openDetail==='function' && state.rows.has(coin)) openDetail(coin);
  }));
}

// --- self-install: tab, view, controls, deep link -------------------------
(function installTreemap(){
  function seg(id,label,attr,opts){ return `<div class="seg" id="${id}" role="group" aria-label="${label}">`
    + `<span class="seglbl">${label}</span>`
    + opts.map(o=>`<button type="button" data-${attr}="${o[0]}">${o[1]}</button>`).join('') + `</div>`; }
  function bindSeg(sel,attr,fn){ document.querySelectorAll(sel+' button').forEach(b=>{
    b.addEventListener('click',()=>{ fn(b.dataset[attr]);
      document.querySelectorAll(sel+' button').forEach(x=>x.classList.toggle('active',x===b)); }); }); }

  function boot(){
    if(document.getElementById('view-treemap')) return;               // already installed
    if(typeof state==='undefined') return;                            // app.js not loaded yet
    if(!state.map) state.map={size:'vol',scale:'balanced',sel:null};

    // tab button
    const nav=document.querySelector('nav.tabs')||document.querySelector('.tabs');
    if(nav){ const btn=document.createElement('button'); btn.className='tab'; btn.dataset.view='treemap'; btn.textContent='Treemap';
      const theme=document.getElementById('themeBtn');
      if(theme && theme.parentNode===nav) nav.insertBefore(btn,theme); else nav.appendChild(btn); }

    // view section
    const sec=document.createElement('section'); sec.id='view-treemap'; sec.hidden=true;
    sec.innerHTML =
      `<div class="controls">`
      + seg('tmf','window','tf',[['1h','1h'],['4h','4h'],['1d','1d'],['7d','7d'],['30d','30d']])
      + seg('mapsize','size','size',[['vol','by volume'],['oi','by OI']])
      + seg('mapscale','areas','scale',[['honest','honest'],['balanced','balanced'],['flat','flat']])
      + `</div>`
      + `<div class="sect-legend" id="map-legend"></div>`
      + `<div id="map-canvas"><div class="msg">Loading…</div></div>`;
    const corr=document.getElementById('view-corr');
    if(corr && corr.parentNode) corr.insertAdjacentElement('afterend',sec);
    else (document.querySelector('main')||document.body).appendChild(sec);

    // minimal styling so the canvas doesn't collapse before first render
    if(!document.getElementById('tm-style')){ const st=document.createElement('style'); st.id='tm-style';
      st.textContent='#map-canvas{min-height:420px;border:1px solid var(--border);border-radius:6px;padding:2px;margin-top:8px}';
      document.head.appendChild(st); }

    // nav clicks: show/render on our tab, hide our view on any other
    if(nav && !nav.dataset.tmBound){ nav.dataset.tmBound='1';
      nav.addEventListener('click',e=>{ const t=e.target.closest('.tab'); if(!t) return; const v=t.dataset.view;
        if(v==='treemap' && typeof showView==='function') showView('treemap');   // hides built-in views, sets active tab + hash
        const tv=document.getElementById('view-treemap'); if(tv) tv.hidden = v!=='treemap';
        if(v==='treemap') renderTreemap();
      }); }

    // control bindings (window syncs with the rest of the app via setWindow)
    bindSeg('#tmf','tf', tf=>{ if(typeof setWindow==='function') setWindow(tf); renderTreemap(); });
    bindSeg('#mapsize','size', v=>{ state.map.size=v; renderTreemap(); });
    bindSeg('#mapscale','scale', v=>{ state.map.scale=v; renderTreemap(); });

    // deep link (#treemap on load)
    if((location.hash||'').replace(/^#/,'')==='treemap' && typeof showView==='function'){
      showView('treemap'); sec.hidden=false; renderTreemap(); }
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
  else boot();
})();
})();

// ---- App-wide chart tooltips (styled <title> + sparkline crosshair) --------
(function(){
  var tip, cross=null;
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }

  function ensure(){
    if(tip) return;
    var st=document.createElement('style'); st.id='tt-style';
    st.textContent=
      '.tt-pop{position:fixed;z-index:9999;pointer-events:none;left:0;top:0;'+
      'background:var(--panel2,#17140d);border:1px solid var(--border,#3a3524);border-radius:6px;'+
      'padding:6px 9px;font:11.5px/1.45 var(--mono,ui-monospace,Menlo,monospace);'+
      'color:var(--text,#ffcf6b);box-shadow:0 6px 22px rgba(0,0,0,.5);max-width:300px;'+
      'opacity:0;transition:opacity .08s}'+
      '.tt-pop.on{opacity:1}.tt-pop b{color:var(--text,#ffcf6b);font-weight:600}'+
      '.tt-pop .k{color:var(--muted,#c2913a)}';
    document.head.appendChild(st);
    tip=document.createElement('div'); tip.className='tt-pop'; document.body.appendChild(tip);
  }
  function place(x,y){
    var r=tip.getBoundingClientRect(), nx=x+14, ny=y+16;
    if(nx+r.width>innerWidth-8) nx=x-r.width-14;
    if(ny+r.height>innerHeight-8) ny=y-r.height-16;
    tip.style.left=Math.max(8,nx)+'px'; tip.style.top=Math.max(8,ny)+'px';
  }
  function show(html,x,y){ ensure(); tip.innerHTML=html; tip.classList.add('on'); place(x,y); }
  function hide(){ if(tip) tip.classList.remove('on'); clearCross(); }

  // --- generic <title> tooltips -------------------------------------------
  function tipNode(start){
    var n=start;
    while(n && n.nodeType===1){
      if(n.getAttribute && n.getAttribute('data-tip')!=null) return n;
      if(n.querySelector){ var t=n.querySelector(':scope > title'); if(t) return n; }
      if(n.tagName && n.tagName.toLowerCase()==='svg') break;
      n=n.parentNode;
    }
    return null;
  }
  function hoist(node){
    var d=node.getAttribute('data-tip'); if(d!=null) return d;
    var t=node.querySelector(':scope > title'); if(!t) return null;
    var txt=t.textContent||''; node.setAttribute('data-tip',txt); t.parentNode.removeChild(t); return txt;
  }
  function fmtTitle(raw){
    var parts=raw.split(' \u00b7 ');
    if(parts.length===1 && raw.length>90){
      // Unstructured long tip: bold-heading the whole paragraph is unreadable. Split a short
      // head at the first sentence/em-dash boundary; failing that, render as plain body text.
      var cut=-1, dot=raw.indexOf('. '), q=raw.indexOf('? '), dash=raw.indexOf(' \u2014 ');
      if(q>0&&(dot<0||q<dot)) dot=q;
      if(dot>0&&dot<=90) cut=dot+1; else if(dash>0&&dash<=90) cut=dash;
      if(cut>0) return '<b>'+esc(raw.slice(0,cut))+'</b><div class="k">'+esc(raw.slice(cut).replace(/^[\s\u2014]+/,''))+'</div>';
      return '<div class="k">'+esc(raw)+'</div>';
    }
    var h='<b>'+esc(parts[0])+'</b>';
    for(var i=1;i<parts.length;i++) h+='<div class="k">'+esc(parts[i])+'</div>';
    return h;
  }

  // --- sparkline crosshair -------------------------------------------------
  function fmtNum(v){ v=+v; if(!isFinite(v)) return '\u2014'; var a=Math.abs(v);
    if(a>=1000) return v.toLocaleString(undefined,{maximumFractionDigits:0});
    if(a>=1) return v.toFixed(2); if(a>=0.01) return v.toFixed(4); return v.toPrecision(2); }

  function seriesFromState(svg){
    var host=svg.closest && svg.closest('[data-coin]');
    if(!host || typeof state==='undefined' || !state.rows) return null;
    var r=state.rows.get(host.getAttribute('data-coin')); if(!r) return null;
    var cl=(r.feat && Array.isArray(r.feat.px30)) ? r.feat.px30.slice(-31)
          : (r.daily ? r.daily.slice(-31).map(function(k){return parseFloat(k.c);}).filter(isFinite) : null);
    if(!cl || cl.length<2) return null;
    return { vals:cl, name:r.ticker||host.getAttribute('data-coin'), unit:'price', pre:'close' };
  }
  function seriesFromData(svg){
    var d=svg.dataset||{}; if(d.series==null) return null;
    var vals=d.series.split(',').map(function(x){ if(x==='') return null; var n=parseFloat(x); return isFinite(n)?n:null; });
    if(vals.filter(function(x){return x!=null;}).length<2) return null;
    return { vals:vals, labels:d.labels?d.labels.split('|'):null,
      name:d.name||'', unit:d.unit||'', pre:d.tip||'' };
  }
  // nearest finite sample to idx (series may have gaps)
  function nearest(vals, idx){
    if(vals[idx]!=null) return idx;
    for(var k=1;k<vals.length;k++){
      if(idx-k>=0 && vals[idx-k]!=null) return idx-k;
      if(idx+k<vals.length && vals[idx+k]!=null) return idx+k;
    }
    return -1;
  }

  function clearCross(){ if(cross){ if(cross.g.parentNode) cross.g.parentNode.removeChild(cross.g); cross=null; } }
  function drawCross(svg,frac){
    clearCross();
    var vb=svg.viewBox && svg.viewBox.baseVal; if(!vb || !vb.width) return;
    var NS='http://www.w3.org/2000/svg', x=vb.x+frac*vb.width;
    var g=document.createElementNS(NS,'g'); g.setAttribute('class','tt-cross'); g.style.pointerEvents='none';
    var ln=document.createElementNS(NS,'line');
    ln.setAttribute('x1',x); ln.setAttribute('x2',x); ln.setAttribute('y1',vb.y); ln.setAttribute('y2',vb.y+vb.height);
    ln.setAttribute('stroke','var(--faint,#75612f)'); ln.setAttribute('stroke-width','1'); ln.setAttribute('vector-effect','non-scaling-stroke');
    g.appendChild(ln); svg.appendChild(g); cross={svg:svg,g:g};
  }

  function handleSpark(svg,e){
    var info=seriesFromData(svg) || (svg.classList.contains('tspark') ? seriesFromState(svg) : null);
    if(!info){ hide(); return; }
    var rect=svg.getBoundingClientRect(); if(!rect.width){ hide(); return; }
    var frac=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
    var n=info.vals.length, idx=nearest(info.vals, Math.round(frac*(n-1)));
    if(idx<0){ hide(); return; }
    var v=info.vals[idx];
    drawCross(svg, idx/(n-1));
    var valStr = info.unit==='price' ? '$'+fmtNum(v) : (fmtNum(v)+(info.unit||''));
    var line = (info.pre?esc(info.pre)+' ':'')+valStr;
    if(info.labels && info.labels[idx]) line = esc(info.labels[idx])+' \u00b7 '+line;
    var h = info.name ? '<b>'+esc(info.name)+'</b>' : '';
    h += '<div class="k">'+line+'</div>';
    var base=null; for(var b=0;b<n;b++){ if(info.vals[b]!=null){ base=info.vals[b]; break; } }
    if(base){ var chg=(v/base-1)*100; if(isFinite(chg)) h+='<div class="k">'+(chg>=0?'+':'')+chg.toFixed(2)+'% from start</div>'; }
    show(h, e.clientX, e.clientY);
  }

  // --- dispatch ------------------------------------------------------------
  document.addEventListener('mousemove', function(e){
    var t=e.target;
    var spark = t.closest && t.closest('svg.tspark, svg[data-series]');
    if(spark){ handleSpark(spark,e); return; }
    var node = tipNode(t);
    if(node){ var raw=hoist(node); if(raw){ clearCross(); show(fmtTitle(raw), e.clientX, e.clientY); return; } }
    hide();
  }, true);
  document.addEventListener('mouseleave', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
})();

// ---- Correlation lookback (7d/30d/90d, default 30d) + unclassified alert ---
(function(){
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
  function ready(fn){ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',fn); else fn(); }

  // --- A. correlation lookback: 7d / 30d ----------------------------------
  function fixCorrLookback(){
    var seg=document.getElementById('corrtf'); if(!seg) return;
    if(typeof state!=='undefined' && state.corr){ if(state.corr.tf!=='7' && state.corr.tf!=='30' && state.corr.tf!=='90') state.corr.tf='30'; }
    seg.innerHTML='<span class="seglbl">lookback</span>'
      +'<button type="button" data-d="7">7d</button>'
      +'<button type="button" data-d="30">30d</button>'
      +'<button type="button" data-d="90">90d</button>';
    seg.querySelectorAll('button').forEach(function(b){
      if(typeof state!=='undefined' && state.corr && b.getAttribute('data-d')===state.corr.tf) b.classList.add('active');
      b.addEventListener('click',function(){
        if(typeof state!=='undefined' && state.corr) state.corr.tf=b.getAttribute('data-d');
        seg.querySelectorAll('button').forEach(function(x){ x.classList.toggle('active',x===b); });
        var v=document.getElementById('view-corr');
        if(typeof renderCorr==='function' && v && !v.hidden) renderCorr();
      });
    });
    var v=document.getElementById('view-corr');
    if(typeof renderCorr==='function' && v && !v.hidden) renderCorr();
  }

  // --- B. unclassified-listing alert --------------------------------------
  var badge;
  function ensureBadge(){
    if(badge) return;
    var st=document.createElement('style'); st.id='uc-style';
    st.textContent='#uc-badge{position:fixed;left:12px;bottom:12px;z-index:9998;'
      +'max-width:min(560px,calc(100vw - 24px));background:var(--panel2,#17140d);'
      +'border:1px solid var(--down,#ff5b49);border-radius:8px;padding:8px 12px;'
      +'font:12px/1.45 var(--mono,ui-monospace,Menlo,monospace);color:var(--text,#ffcf6b);'
      +'cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.5)}#uc-badge b{color:var(--down,#ff5b49)}';
    document.head.appendChild(st);
    badge=document.createElement('div'); badge.id='uc-badge'; badge.style.display='none';
    badge.title='Click to copy the ticker list';
    badge.addEventListener('click',function(){
      var t=badge.getAttribute('data-names')||'';
      if(t && navigator.clipboard) navigator.clipboard.writeText(t).catch(function(){});
    });
    document.body.appendChild(badge);
  }
  function scanUnclassified(){
    if(typeof state==='undefined' || !state.rows) return [];
    var out=[];
    state.rows.forEach(function(r){
      if(r.delisted) return;
      if(!r.sector || r.sector==='Unclassified') out.push(r.ticker||r.coin);
    });
    return out;
  }
  function updateBadge(){
    ensureBadge();
    var names=scanUnclassified();
    if(!names.length){ badge.style.display='none'; return; }
    badge.setAttribute('data-names', names.join(', '));
    badge.style.display='';
    var shown=names.slice(0,12).map(esc).join(', ')+(names.length>12?', \u2026':'');
    badge.innerHTML='<b>\u26a0 Unclassified ('+names.length+')</b> '+shown+' \u2014 add to src/sectors.js';
  }

  // The unclassified badge is a maintainer aid ("add to src/sectors.js"), so only show it
  // locally or when ?debug is present — friends visiting the live site shouldn't see it.
  var UC_DEBUG = (function(){ try {
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      || /[?&]debug\b/.test(location.search);
  } catch(_){ return false; } })();

  ready(function(){
    fixCorrLookback();
    if(UC_DEBUG){ updateBadge(); setInterval(updateBadge, 4000); }   // re-checks as snapshots refresh (~15s server-side)
  });
})();
