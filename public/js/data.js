// data.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { fhLiveRefresh } from "./admin.js";
import { notifyNewBuild } from "./alerts.js";
import { updateBenchNote } from "./backtest.js";
import { COLS } from "./base.js";
import { _earnLast, _newsLast, _sigLast, loadEarnings, loadNews, loadSignals, renderMacroStrip } from "./calendar.js";
import { DAY, HOUR, TF_MAP, TF_MS, activeRows, clamp, detectBenchmark, el, esc, fmtUsd, isoUtc, recomputeChanges, regimeDetail, setPrice, state } from "./core.js";
import { COMPG, dailyReturns, openCorr, renderCompg } from "./corr.js";
import { computeSqueeze, render, renderRegimeStrip, rowSessState, scheduleRender, updateMovers } from "./markets.js";
import { _hsgLast, _liqLast, loadHousing, loadLiquidity } from "./notes.js";
import { aiFmtAgo } from "./report.js";
import { renderSectors } from "./sectors.js";
import { renderDrawdown } from "./drawdown.js";
import { loadTriggers } from "./triggers.js";


// ===== data ingestion (server snapshots) =====
// The session expired mid-use (the app polls for days). A reload lost whatever was being typed and,
// when the reload was blocked (a PWA in the background), left every later fetch failing behind a
// misleading "couldn't reach the server". A persistent banner with a link that brings you back to
// the same tab and ticker instead; /login honours ?next=.
function sessionExpired(){
  if(window.__reauth) return; window.__reauth=1;
  const next=encodeURIComponent(location.pathname+location.hash);
  const w=el('toastwrap'); if(!w) return;
  const t=document.createElement('div'); t.className='toast toast-sticky';
  t.innerHTML='Your session expired — <a href="/login?next='+next+'">sign in again</a> to pick up where you were.';
  w.appendChild(t);
}
async function fetchJSON(url){ const r=await fetch(url,{headers:{accept:'application/json'}});
  // Session expired mid-use (the app polls for days): reload once — the unauthenticated
  // navigation lands on the server's login page instead of a silently dead dashboard.
  if(r.status===401){ sessionExpired(); throw new Error('HTTP 401'); }
  if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
// Pulls overlap (a poke, the fallback poll and a manual refresh can all be in flight at once) and
// nothing guarantees they answer in order: a slow older response landing last moved the board
// backwards. Every pull takes a sequence number; only the newest pull's answer is applied.
let _snapSeq=0;
async function loadSnapshot(){
  const seq=++_snapSeq;
  try{ const s=await fetchJSON('/api/snapshot'); if(seq!==_snapSeq) return; applySnapshot(s); setStatus(true); }
  catch(e){ if(seq!==_snapSeq) return; setStatus(false); if(!activeRows().some(r=>r.px!=null)) el('body').innerHTML=errRow(e.message); }
}
async function loadDaily(){ try{ applyDaily(await fetchJSON('/api/daily')); }catch(_){} }
// The signals/earnings/news tabs pull on their own cadences off the back of the snapshot poll —
// they stay live even when the snapshot body itself is content-identical (served as a 304 upstream).
function maybePullSidecars(){
  { const vis=el('view-signals')&&!el('view-signals').hidden;
    if(Date.now()-_sigLast > (vis?60*1000:5*60*1000)) loadSignals(); }
  if(Date.now()-_earnLast > 10*60*1000) loadEarnings();   // 6h server refresh — 10 min client pull is already generous
  if(el('view-housing')&&!el('view-housing').hidden&&Date.now()-_hsgLast > 15*60*1000) loadHousing();   // 6h server refresh; only pulled while the tab is open
  if(el('view-liquidity')&&!el('view-liquidity').hidden&&Date.now()-_liqLast > 15*60*1000) loadLiquidity();
  renderMacroStrip();   // cheap re-derive so the strip flips at 8:30 / 14:00 ET between pulls
  if(Date.now()-_newsLast > 3*60*1000) loadNews();   // rotation lands new names every minute server-side
}
function applySnapshot(s){
  if(!s||!Array.isArray(s.markets)) return;
  // Second half of the ordering guard: a payload OLDER than what is painted is dropped outright —
  // unless the build changed, because a redeploy restarts the server's content clock and the
  // first snapshot of the new build must land whatever its dataTs says.
  if(s.dataTs&&state.dataTs&&s.dataTs<state.dataTs&&(!s.v||!state.build||s.v===state.build)) return;
  // Checked BEFORE the content short-circuit below. An idle board is exactly when an alert matters
  // most, and returning early on an unchanged dataTs would have skipped the alert pull precisely
  // then. alertVer rides the snapshot's content signature server-side, so a fired alert always
  // bumps dataTs too — this stays correct either way.
  if(s.alertVer!=null && s.alertVer!==state.alerts.alertVer){ state.alerts.alertVer=s.alertVer; loadTriggers(); }
  // Content short-circuit: the server freezes dataTs while nothing a client renders has changed
  // (see buildSnapshot's content signature), so an unchanged poll — the norm off-hours, and every
  // 304 — arrives with the SAME dataTs. Skip the full 140-market row-walk + table innerHTML rebuild
  // + movers/regime/aggregates repaint; just keep the timed sidecar pulls alive. dataTs starts 0 so
  // the first snapshot always falls through, and a redeploy bumps it so the build badge still updates.
  if(s.dataTs && s.dataTs===state.dataTs){ maybePullSidecars(); return; }
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
    if(m.sector){ r.sector=m.sector;
      // Industry group rides the same payload as sector, in LOCKSTEP: the wire ships `ind` only
      // when it differs from sector, so its absence next to a present sector MEANS ind===sector —
      // clear rather than keep, or a name whose industry is later removed from the curated table
      // would wear a stale group on any long-lived page until reload. (Build -05: this line is the
      // fix for -04's field-name-mismatch bug — the wire carried ind, this explicit merge dropped it.)
      r.ind=(m.ind!==undefined)?m.ind:undefined;
      // Audit-overlay provenance rides the same payload in lockstep: absent MEANS curated — clear
      // rather than keep, or a reverted overlay entry would wear a stale "auto" chip until reload.
      r.secAuto=(m.secAuto!==undefined)?m.secAuto:undefined; }
    // Home-market classification rides EVERY snapshot in lockstep: absent on the wire MEANS US
    // (the default), so copy unconditionally — keep-on-absent would freeze a stale KR/JP/HK chip
    // if a name ever left the curated table. (2026.08.14-02: the -01 miss was the -04 `ind` bug
    // again — the wire carried hm/hadr, this explicit merge dropped them, every chip rendered US.
    // The regression below pushes a payload through the REAL applySnapshot, not string pins.)
    r.hm=(m.hm!==undefined)?m.hm:undefined; r.hadr=(m.hadr!==undefined)?m.hadr:undefined;
    // 5m/15m ring references: absence on the wire MEANS no honest reference right now (server
    // warm-up or a feed gap at the lookback point) — clear rather than keep, or a long-lived page
    // would compute a "5m" change against a reference minutes older than its label.
    r.p5m=(m.p5m!=null)?m.p5m:null; r.p15m=(m.p15m!=null)?m.p15m:null;
    // Anchored intraday open LEVELS (H/4h/12h UTC buckets). Absence on the wire MEANS the spine
    // hasn't reached the bucket boundary — clear rather than keep, or the column would measure
    // against the previous bucket's anchor under this bucket's label.
    r.hopenPx=(m.hopenPx!=null)?m.hopenPx:null; r.h4openPx=(m.h4openPx!=null)?m.h4openPx:null; r.h12openPx=(m.h12openPx!=null)?m.h12openPx:null;
    r.bid=(m.bid!==undefined&&m.bid!==null)?m.bid:null;   // dip-reclaim claim {d,r,m} (xyz, 5m archive tail) — absence MEANS no fresh claim: clear, never carry a stale bid
    r.fundPct=(m.fundPct!=null)?m.fundPct:r.fundPct;
    if(m.red!==undefined) r.red=m.red;             // {dcap,hit,n} or null — fixed 31d/4h red-tape resilience, server-computed
    if(m.rvol!==undefined) r.rvolByWin=m.rvol;     // {h1,h4,d1} clock-hour-matched relative volume, server-computed
    if(m.assetClass) r.assetClass=m.assetClass;
    r.d1=(r.px!=null&&r.prevDay)?(r.px-r.prevDay)/r.prevDay*100:r.d1;
    recomputeChanges(r);
    r.candleTs=r.feat?Date.now():(r.candleTs||0);
    seen.add(m.coin);
  }
  for(const k of [...state.rows.keys()]) if(!seen.has(k)) state.rows.delete(k);
  fhLiveRefresh();   // the funding board's now column reads these rows; repaint it only if a rate rolled
  state.benchCoin=s.benchCoin||detectBenchmark();
  if(s.dataTs) state.dataTs=s.dataTs;
  if(s.regime) state.regimeSrv=s.regime;
  if(s.redBars) state.redBars=s.redBars;
  if(s.warm) state.warm=s.warm;
  maybePullSidecars();
  if(s.v){ if(!state.bootBuild) state.bootBuild=s.v; if(state.build&&state.build!==s.v) notifyNewBuild(s.v); state.build=s.v; const bv=el('ver'); if(bv) bv.textContent=s.v; }
  // offHours now rides the snapshot (15s server rebuild), so the live-gap open↔closed flip
  // lands within one refresh instead of the old daily-path ~15 min. On a flip, pull /api/daily
  // immediately: the closed→open direction needs the freshly completed close→open gap, and
  // open→closed needs the new liveClose anchors.
  if(s.offHours){ const prev=state._ohClosed; state._ohSnap=true; state.offHours=s.offHours;
    const cl=!!s.offHours.closed;
    if(prev!=null&&prev!==cl) loadDaily();
    state._ohClosed=cl; }
  // Home-market states ride the same snapshot. A flip on ANY home exchange refreshes /api/daily
  // for the same reason a US flip does: closed→open needs the freshly completed close→open gap
  // for that market's names, open→closed needs their new liveClose anchors.
  if(s.homeMkts) state.homeMkts=s.homeMkts;
  if(s.homeState){ const prev=state._hmSig;
    const sig=Object.keys(s.homeState).sort().map(k=>s.homeState[k]&&s.homeState[k].closed?1:0).join('');   // every home market the server ships, never a fixed list
    state.homeState=s.homeState;
    if(prev!=null&&prev!==sig) loadDaily();
    state._hmSig=sig; }
  updateBenchNote();
  updateAggregates(); render(); updateMovers(); updateSyncProgress(); renderRegimeStrip();
}
function applyDaily(d){ if(!d||!d.daily) return;
  if(!state._ohSnap) state.offHours = d.offHours || {closed:false};   // legacy path: only until a snapshot has shipped the fresher copy
  for(const coin in d.daily){ const r=state.rows.get(coin); if(!r) continue;
    const arr=d.daily[coin];
    r.daily=Array.isArray(arr)?arr.map(p=>({t:p[0], c:p[1], h:p[2], v:p[3]})):r.daily;   // h/v are additive tuple columns (2026.07.24-04) — absent on an older server, undefined here
    if(d.oi && Array.isArray(d.oi[coin])){ r.dailyOI=d.oi[coin]; r._doi=null; }
    r.closePx=(d.liveClose && d.liveClose[coin]>0)?d.liveClose[coin]:null;   // price at the last close, for the live in-progress gap
    if(d.funding && Array.isArray(d.funding[coin])){ r.dailyFund=d.funding[coin].map(p=>({t:p[0], f:p[1]})); r._dfund=null; }
    if(d.overnight && Array.isArray(d.overnight[coin])){ r.overnight=d.overnight[coin].map(p=>({t:p[0], g:p[1], f:p[2]})); r._dov=null;
      const cut=Date.now()-30*DAY; let eq=1, n=0;                    // 30d cumulative off-hours drift (tooltip)
      for(const h of r.overnight){ if(h.t>=cut && isFinite(h.g)){ eq*=(1+h.g); n++; } }
      r.gap30 = n? (eq-1)*100 : undefined;
      const last=r.overnight[r.overnight.length-1]; r.gapDone = last&&isFinite(last.g)? last.g*100 : undefined;   // last completed close->open gap
    }
    r._dret=null; r._wrL=null; r._dlvl=null; }
  scheduleRender();
  if(!el('view-corr').hidden){ openCorr();           // wrapper, so the "loading X/Y" sync counter advances with the data
    // -07 self-heal: a COMP/G panel painted before this data landed rendered its honest loading
    // state (COMPG._empty). Repaint it now — this hook was already the matrix's refresh, but the
    // panel had no path back from empty and stayed broken-looking for the life of the page.
    if(COMPG._empty && el('compg') && !el('compg').hidden) renderCompg(); }
  if(!el('view-sectors').hidden) renderSectors();   // leaders map + sector corr fill in live as daily coverage grows
  { const dv=el('view-drawdown'); if(dv&&!dv.hidden) renderDrawdown(); }   // the study is a pure function of these closes
}
function updateAggregates(){ const rows=activeRows(); let v=0,o=0;
  for(const r of rows){ if(r.vol)v+=r.vol; if(r.oi)o+=r.oi; }
  el('s-mkts').textContent=rows.length; el('s-vol').textContent=fmtUsd(v); el('s-oi').textContent=fmtUsd(o);
  el('s-upd').textContent=new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function errRow(m){ return `<tr><td colspan="${COLS.length}"><div class="msg err"><span class="big">Couldn't reach the server</span>${esc(m||'Network error')}. Will retry on the next interval.</div></td></tr>`; }
let _freshLast='';   // last painted freshness title — the 500ms tick only touches the DOM when it changes
function setStatus(ok){ state.connOk=ok; const d=el('live'); if(d){ d.style.background=ok?'var(--up)':'var(--down)'; d.title=ok?'live':'connection error'; } _freshLast=ok?'live':''; if(ok) updateFreshness(); }
function updateFreshness(){ if(!state.connOk||document.hidden) return; const d=el('live'); if(!d||!state.dataTs) return;
  const age=Date.now()-state.dataTs, stale=age>180000;
  const title=stale?'server data is '+Math.round(age/60000)+'m old — the poller may be stalled':'live';
  if(title===_freshLast) return; _freshLast=title;
  d.style.background=stale?'var(--accent)':'var(--up)'; d.title=title; }
// Data-source freshness tray: one dot per live feed with its age, colour-graded. Reads /api/health
// (auth-exempt, already carries every source's timestamp via poller.stats) so it needs no new
// endpoint. Each source declares its own "aging" and "stale" thresholds because a 30s price poll and
// a 6h earnings refresh have very different notions of fresh. A source that's actively fetch-failing
// shows red regardless of age. Cheap and slow (45s), independent of the 60s snapshot poll.
const FRESH_SOURCES=[
  {k:'data', label:'Data', warn:120000, stale:300000, at:h=>h.lastPoll, fail:h=>h.failing&&(h.failing.hourly>((h.active||0)/2)), tip:'Hyperliquid poll (price · OI · funding)'},
  {k:'earn', label:'Earn', warn:9*3600e3, stale:24*3600e3, at:h=>h.earnings&&h.earnings.asOf, fail:h=>h.earnings&&h.earnings.error&&h.earnings.error!=='not fetched yet'&&!(h.earnings.asOf), tip:'Finnhub earnings calendar (~6h refresh)'},
  {k:'news', label:'News', warn:2*3600e3, stale:6*3600e3, at:h=>h.news&&h.news.fetchedAt, fail:h=>h.news&&h.news.error&&!(h.news.fetchedAt), tip:'Company + macro news tape'},
  {k:'edgar', label:'Filings', warn:3*3600e3, stale:12*3600e3, at:h=>h.news&&h.news.filings&&h.news.filings.fetch&&h.news.filings.fetch.lastOk, fail:h=>{const f=h.news&&h.news.filings&&h.news.filings.fetch; return f&&!f.lastOk&&(f.forbidden||f.netFail);}, tip:'SEC EDGAR filings feed'}];
function renderFreshTray(h){ const box=el('freshtray'); if(!box||!h) return;
  const now=Date.now();
  const dots=FRESH_SOURCES.map(s=>{ let cls='', label=s.label, age=null;
    const failing=s.fail&&s.fail(h);
    const ts=s.at(h);
    if(failing){ cls='stale'; }
    else if(!ts){ cls=''; }
    else { age=now-ts; cls=age>s.stale?'stale':(age>s.warn?'warn':'ok'); }
    const ageTxt=age!=null?aiFmtAgo(age)+' ago':(failing?'fetch failing':'no data yet');
    return `<span class="fdot ${cls}" title="${esc(s.tip)} — ${ageTxt}"><i></i>${esc(label)}</span>`; }).join('');
  // Event-loop dot: value-graded (p99 ms), not age-graded like the feed dots — the thresholds are
  // the worker-thread decision gate itself: green <20ms, amber <50ms, red ≥50ms. Reads the LIVE
  // still-open window so a stall shows within one 45s tray poll, not at the next 6h window close.
  let loopDot='';
  if(h.loop&&h.loop.p99!=null){ const p=h.loop.p99, cls=p>=50?'stale':(p>=20?'warn':'ok');
    // -08: the histogram's worst number now carries a NAME. h.ticks is worst-first from the server;
    // the top entry is the answer to "what was that max". Async ticks are yielding builds — their
    // duration is wall time across yields, not loop hold, and the label says so honestly.
    let culprit='';
    if(Array.isArray(h.ticks)&&h.ticks.length){ const w=h.ticks[0];
      culprit=` — worst tick: ${w.name} ${w.worst>=1000?(w.worst/1000).toFixed(1)+'s':w.worst+'ms'}${w.async?' (yielding build, wall time)':''} ${aiFmtAgo(Date.now()-w.worstAt)} ago`; }
    loopDot=`<span class="fdot ${cls}" title="event loop delay (live window) — p50 ${h.loop.p50}ms · p99 ${p}ms · max ${h.loop.max}ms — green <20 · amber <50 · red \u226550 (the worker-thread gate)${culprit}"><i></i>Loop</span>`; }
  box.innerHTML=dots+loopDot; box.hidden=false; }
async function updateFreshTray(){ try{ const h=await fetchJSON('/api/health'); _lastHealth=h; renderFreshTray(h); if(h&&h.ai) renderAskBudget(h.ai.askDayLeft, h.ai.askPerDay); renderAdmLoop(h); }catch(_){ } }
// Last /api/health payload, shared with the admin loop row so opening the panel between tray polls
// renders instantly from the 45s-old read instead of a blank box.
let _lastHealth=null;
// ===== admin panel: event-loop latency row (build 2026.07.29-04) ===============================
// Phase 0 of the perf batch: chips for the live window + a p99-per-window sparkline over the
// persisted 7d ring, with the 50ms decision-gate line drawn as a dashed reference. Admin-only by
// placement (it lives inside view-admin, whose route/tab gating is already server-enforced).
function renderAdmLoop(h){ const box=el('admLoop'); if(!box) return;
  if(!h||!h.loop){ return; }
  const L=h.loop, ring=Array.isArray(L.hist)?L.hist:[];
  const chip=(v,lab,tip)=>{ const cls=v>=50?'bad':(v>=20?'warn':'ok');
    return `<span class="alp-chip ${cls}" data-tip="${esc(tip)}">${esc(lab)} ${v}ms</span>`; };
  const me=L.maxEver?`<span class="alp-chip dim" data-tip="worst single stall ever observed on this data dir — kept separately so one boot spike stays attributable without polluting the rolling read">maxEver ${L.maxEver.v}ms · ${isoUtc(L.maxEver.t,5,16)}</span>`:'';
  const winH=Math.round((L.windowMs||0)/3600e3), liveMin=Math.round((L.sinceMs||0)/60e3);
  let spark='<div class="alp-none">no closed windows yet — first ring point lands at the '+winH+'h mark (or on the next deploy, which folds the open window in)</div>';
  if(ring.length){
    const W=600,H=72,top=6,bot=58,vmax=Math.max(60,...ring.map(r=>r[2]));
    const xs=ring.length>1?(i)=>i*(W/(ring.length-1)):()=>W/2;
    const y=(v)=>bot-Math.min(v,vmax)/vmax*(bot-top);
    const pts=ring.map((r,i)=>xs(i).toFixed(1)+','+y(r[2]).toFixed(1)).join(' ');
    const gate=y(50);
    spark=`<svg class="alp-spark" viewBox="0 0 ${W} ${H}" data-n="${ring.length}">`
      +`<line x1="0" y1="${bot}" x2="${W}" y2="${bot}" class="alp-base"/>`
      +`<line x1="0" y1="${gate.toFixed(1)}" x2="${W}" y2="${gate.toFixed(1)}" class="alp-gate"/>`
      +`<text x="${W-4}" y="${(gate-4).toFixed(1)}" text-anchor="end" class="alp-gtxt">50ms</text>`
      +(ring.length>1?`<polyline class="alp-line" points="${pts}"/>`:`<circle class="alp-dotp" cx="${xs(0).toFixed(1)}" cy="${y(ring[0][2]).toFixed(1)}" r="2.5"/>`)
      +`<line class="alp-cx" x1="0" y1="0" x2="0" y2="${H}" visibility="hidden"/>`
      +`<circle class="alp-cd" r="3" visibility="hidden"/></svg>`
      +`<div class="alp-ro" hidden></div>`;
  }
  box.innerHTML=`<div class="alp-head"><span class="alp-t">Event loop</span><span class="sec">live window ${liveMin}m of ${winH}h · ring ${ring.length}/28 · p99 per closed window</span></div>`
    +`<div class="alp-chips">${chip(L.p50,'p50','median tick delay, live window')}${chip(L.p99,'p99','99th-percentile tick delay, live window — the decision-gate number: sustained \u226550ms for a week justifies moving builds to worker threads; sustained <50ms kills that work item')}${chip(L.max,'max','worst stall in the live window')}${me}</div>${spark}`;
  box.hidden=false;
  const svg=box.querySelector('.alp-spark');
  if(svg&&ring.length){
    const cx=svg.querySelector('.alp-cx'), cd=svg.querySelector('.alp-cd'), ro=box.querySelector('.alp-ro');
    const W=600,top=6,bot=58,vmax=Math.max(60,...ring.map(r=>r[2]));
    svg.addEventListener('mousemove',(e)=>{ const r=svg.getBoundingClientRect();
      const x=(e.clientX-r.left)/r.width*W;
      const i=ring.length>1?Math.max(0,Math.min(ring.length-1,Math.round(x/(W/(ring.length-1))))):0;
      const px=ring.length>1?i*(W/(ring.length-1)):W/2, py=bot-Math.min(ring[i][2],vmax)/vmax*(bot-top);
      cx.setAttribute('x1',px); cx.setAttribute('x2',px); cx.setAttribute('visibility','visible');
      cd.setAttribute('cx',px); cd.setAttribute('cy',py); cd.setAttribute('visibility','visible');
      ro.textContent=new Date(ring[i][0]).toISOString().slice(5,16).replace('T',' ')+'  p50 '+ring[i][1]+'  p99 '+ring[i][2]+'  max '+ring[i][3]+'ms';
      ro.style.left=Math.min(px/W*r.width+10, r.width-190)+'px'; ro.hidden=false; });
    svg.addEventListener('mouseleave',()=>{ cx.setAttribute('visibility','hidden'); cd.setAttribute('visibility','hidden'); ro.hidden=true; });
  } }
// Ambient ask-AI budget chip in the terminal bar. Shared group pool, resets midnight UTC; green
// with headroom, amber when low (<=25%), red at zero. Fed by the 45s health poll AND by each ask
// response (askDayLeft/askPerDay ride on every /api/ask reply) so it updates the instant you spend.
function renderAskBudget(left,per){ const b=el('termBudget'); if(!b||left==null||per==null) return;
  const cls=left<=0?'out':left<=Math.max(1,per*0.25)?'low':'';
  b.className='tp-budget'+(cls?' '+cls:'');
  b.innerHTML='ask&nbsp;<b>'+left+'/'+per+'</b>'; }
function updateSyncProgress(){ const rows=activeRows(); let done=0; for(const r of rows) if(r.feat) done++;
  const s=el('sync'); if(!s) return;
  if(rows.length>0&&done>=rows.length){ s.classList.add('done'); el('sync-t').textContent='synced'; }
  else { s.classList.remove('done'); el('sync-t').textContent=`syncing ${done}/${rows.length}`; } }

// ===== derived metrics =====
// computeMomentum now returns the PAIR {mom, momp, why} (build 2026.07.24-07):
//   mom  — the incumbent score, math byte-identical to what shipped before this build.
//   momp — MOM+, the candidate: same shared core, OI term regime-qualified (bench V2 — OI
//          building amplifies only scaled by funding corroboration with the score's side;
//          falling OI is covering and dampens at half band) plus the funding-crowding
//          haircut (bench V3 — the crowd paying its own-31d extreme to be on the score's
//          side → ×0.8). why = short mechanism tags for whichever terms made the two differ.
// This mirrors momPair in src/compute.js, which the poller runs for the canonical daily duel
// snapshot; a constant-fragment test pins the coefficients identical across the two files.
function computeMomentum(r){
  const f=r.feat; if(!f||!(f.volH>0)) return {mom:undefined,momp:undefined,why:null};
  const volD=(f.volD>0)?f.volD:null;   // measured daily vol; null until hourly features load -> falls back to hourly x sqrt(t)
  const H=[[r.h1,1,0.10],[r.h4,4,0.15],[r.d1,24,0.30],[r.d7,168,0.30],[r.d30,720,0.15]];
  let s=0,w=0,sa=0;
  for(const [ret,hrs,wt] of H){ if(ret==null||!isFinite(ret))continue;
    // 1d+ horizons use directly-measured daily vol (no iid sqrt(t) assumption); intraday uses hourly vol
    const sigma=(hrs>=24&&volD)?volD*Math.sqrt(hrs/24):f.volH*Math.sqrt(hrs);
    if(!(sigma>0))continue;
    const z=(ret/100)/sigma; s+=wt*z; sa+=wt*Math.abs(z); w+=wt; }
  if(w===0) return {mom:null,momp:null,why:null};
  // cross-horizon coherence: |net blended move| / total absolute path across horizons, in [0,1].
  // 1 = every horizon agrees (clean trend), ->0 = horizons fight (choppy / rolling over). Replaces the
  // single-horizon 30d r2 gate so the quality factor reflects the multi-horizon blend the score is built from.
  const kappa = sa>0 ? Math.abs(s)/sa : 0;
  let core=(s/w)*(0.5+0.5*kappa);
  if(r.px!=null&&f.hi30!=null&&f.lo30!=null&&f.hi30>f.lo30) core+=0.4*(clamp((r.px-f.lo30)/(f.hi30-f.lo30),0,1)-0.5)*2;
  // incumbent branch: direction-agnostic OI conviction — unchanged
  let coreA=core;
  if(r.doi!=null&&isFinite(r.doi)) coreA*=clamp(1+0.4*Math.tanh(r.doi/8),0.6,1.4);
  // MOM+ branch: window-avg funding APR (same window expression the regime read uses) + the
  // fixed-31d funding percentile the ▴/▾ column flag already ships
  const tfKey=TF_MAP[state.tf]||'d1';
  const fh=r.fundByWin?(r.fundByWin[tfKey]??r.funding):r.funding;
  const fAPR=(fh!=null&&isFinite(fh))?fh*24*365*100:null;
  let coreB=core; const why=[];
  if(r.doi!=null&&isFinite(r.doi)&&core!==0&&r.doi!==0){
    if(r.doi>0){
      let c=0.5;   // corroboration: 1 with the score, 0 against, 0.5 flat/unknown
      if(fAPR!=null&&isFinite(fAPR)&&Math.abs(Math.tanh(fAPR/25))>=0.15) c=((core>0)===(fAPR>0))?1:0;
      coreB*=clamp(1+0.4*Math.tanh(r.doi/8)*(0.5+0.5*c),0.6,1.4);
      why.push(c===1?'OI+ corroborated':c===0?'OI+ conflicted':'OI+ fund flat');
    } else {
      coreB*=clamp(1-0.2*Math.tanh(-r.doi/8),0.6,1.4);
      why.push(core>0?'squeeze-side OI':'unwind-side OI');
    }
  }
  const fp=r.fundPct;
  if(core!==0&&fp!=null&&fAPR!=null&&isFinite(fAPR)){
    if(core>0&&fAPR>0&&fp>=90){ coreB*=0.8; why.push('crowded long −20%'); }
    else if(core<0&&fAPR<0&&fp<=10){ coreB*=0.8; why.push('crowded short −20%'); }
  }
  return {mom:100*Math.tanh(coreA/1.5), momp:100*Math.tanh(coreB/1.5), why:why.length?why.join(' · '):null};
}
function computeDerived(){
  const tfKey=TF_MAP[state.tf]||'d1';
  const bX=state.benchCoin?state.rows.get(state.benchCoin):null, bM=state.benchMain?state.rows.get(state.benchMain):null;
  // Universe-median return over the selected window, per scope — the reference for "vs tape".
  // Median, not mean: one violent name must not move the tape's definition of itself.
  const tapeMed={xyz:null,main:null};
  { const acc={xyz:[],main:[]};
    for(const r of state.rows.values()){ if(r.delisted)continue; const v=r[tfKey];
      if(v!=null&&isFinite(v)) acc[r.uni==='main'?'main':'xyz'].push(v); }
    for(const u of ['xyz','main']){ const a=acc[u]; if(a.length>=5){ a.sort((x,y)=>x-y);
      tapeMed[u]=a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2; } } }
  state._tapeMed=tapeMed;
  for(const r of state.rows.values()){ if(r.delisted)continue;
    // vs tape: this market's window return minus the universe median — the live counterpart of
    // DownCap/Hit% (same reference), and the direct read for "holding stronger than the rest".
    { const tm=tapeMed[r.uni==='main'?'main':'xyz'], a=r[tfKey];
      r.vstape=(tm!=null&&a!=null&&isFinite(a))?a-tm:null; }
    r.dcap=(r.red&&r.red.dcap!=null)?r.red.dcap:null;
    r.hitr=(r.red&&r.red.hit!=null)?r.red.hit:null;
    r.rvol=(r.rvolByWin&&(tfKey==='h1'||tfKey==='h4'||tfKey==='d1'))?(r.rvolByWin[tfKey]??null):null;
    const benchC=r.uni==='main'?state.benchMain:state.benchCoin;   // BTC anchors crypto; SP500 anchors equities
    const bench=r.uni==='main'?bM:bX, benchRet=bench?bench[tfKey]:null;
    r.doi=r.doiByWin?(r.doiByWin[tfKey]??null):null;
    r.regime=regimeDetail(r[tfKey], r.doi, (r.fundByWin?(r.fundByWin[tfKey]??r.funding):r.funding), (r.feat&&r.feat.volH), (TF_MS[state.tf]||DAY)/HOUR);
    { const mp=computeMomentum(r); r.mom=mp.mom; r.momp=mp.momp; r.momWhy=mp.why; }
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
    // 30d rolling VWAP (server-computed from the hourly spine; candle-typical-price approximation)
    r.vwap30=(r.feat&&r.feat.vwap30>0)?r.feat.vwap30:undefined;
    r.vsvwap=(r.vwap30!==undefined&&r.px!=null&&isFinite(r.px))?(r.px/r.vwap30-1)*100:undefined;
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
    { const cl=r.daily; let yo=null, mo=null, dop=null;
      if(Array.isArray(cl)&&cl.length){
        const nowD=new Date(), y0=Date.UTC(nowD.getUTCFullYear(),0,1), m0=Date.UTC(nowD.getUTCFullYear(),nowD.getUTCMonth(),1),
          d0=Date.UTC(nowD.getUTCFullYear(),nowD.getUTCMonth(),nowD.getUTCDate());   // today's UTC 00:00 — the D-open anchor
        const openAt=(b)=>{ let prev=null;
          for(const k of cl){ const c=+k.c; if(!isFinite(c)) continue;
            if(k.t<b) prev=c; else return prev!=null?prev:c; }
          return prev; };   // series entirely before the boundary: stale, but the last close is still the level carried in
        const coveredY = cl[0].t<=y0+3*DAY || (r.uni!=='main' ? cl[0].t>y0 : cl.length<28);
        if(coveredY) yo=openAt(y0);
        mo=openAt(m0);
        dop=openAt(d0);   // prior UTC day's close = today's open on a continuously-traded perp — same convention as the M/Y rungs
      }
      r.yopen=(yo!=null&&yo>0)?yo:undefined;
      r.mopen=(mo!=null&&mo>0)?mo:undefined;
      r.dopenPx=(dop!=null&&dop>0)?dop:undefined;
      // Sortable value IS the % — the column shows only the change; the level lives in the hover.
      r.dopen=(r.dopenPx!=null&&r.px>0&&isFinite(r.px))?(r.px/r.dopenPx-1)*100:undefined; }
    // premium / squeeze / carry — all off data already in the row (oracle, window funding, ΔOI, vol)
    const fw=(r.fundByWin?(r.fundByWin[tfKey]??r.funding):r.funding);
    r.prem=(r.px!=null&&r.oracle>0)?(r.px/r.oracle-1)*1e4:undefined;
    r.sqz=computeSqueeze(r,fw);
    r._carryF=(fw!=null&&isFinite(fw))?fw*24*365*100:null;
    r.carry=(r._carryF!=null&&r.vol30!=null&&isFinite(r.vol30)&&r.vol30>5)?r._carryF/r.vol30:undefined;
    r.sess = r.uni==='main' ? undefined : (r.hm || 'US');   // sortable home-market key (chip column)
    { const oh=rowSessState(r);   // foreign-home rows gap on THEIR market's state, never the US flag
      r.gap = r.uni==='main' ? undefined : ((oh && oh.closed && r.closePx>0 && isFinite(r.px)) ? (r.px/r.closePx-1)*100 : r.gapDone); }   // crypto never gaps (24/7); else live in-progress gap when the name's cash market is closed, else the last completed gap
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
export { _lastHealth, betaCell, computeDerived, fetchJSON, loadDaily, loadSnapshot, renderAdmLoop, renderAskBudget, updateAggregates, updateFreshTray, updateFreshness };
