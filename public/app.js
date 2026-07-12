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
