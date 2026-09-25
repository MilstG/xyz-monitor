// nav.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { fhShareCard, tabVisible, toggleViewAsPublic } from "./admin.js";
import { alertMarkRead, buildAlertsPanel, loadAlerts, notifyNewBuild, updateBell } from "./alerts.js";
import { applyScope, setScope, showView, syncTabNav, syncTabScroll } from "./backtest.js";
import { COLS } from "./base.js";
import { COL_BY_KEY, DEFAULT_HIDDEN, DEFAULT_ORDER, G, PKEY, activeRows, el, esc, fmtPrice, mktGrp, overlayPop, overlayPush, overlayTop, parseAmount, state, store } from "./core.js";
import { exportCorr, exportMarkets, openCorr, renderCorr, renderCorrPairs } from "./corr.js";
import { loadDaily, loadSnapshot, updateFreshness } from "./data.js";
import { closeDetail, openDetail, runSigHist, toggleWatch } from "./drawer.js";
import { buildHead, clearDrill, paintMarkets, render, renderActionLists, renderRegimeStrip, scheduleRender, setGrp, sortedRows, syncGrpSeg, visibleCols } from "./markets.js";
import { dmKeys, dmLoad, dmRefreshOpen, dmRender, dmState, dmSync, dmTypingFrame } from "./messages.js";
import { renderHousing, renderLiquidity } from "./notes.js";
import { shareSetSource, shareWireBoard, shareWireDrawer, shareWireTable } from "./share.js";
import { buildLayoutMenu, loadLayouts, loadPositions, loadPrefs, posLink, posStatText, prefsRemoteFrame, saveLayouts, savePrefs, updateLayoutBtn } from "./prefs.js";
import { aiMatches, openAiReport } from "./report.js";
import { exportSectors, renderSectors } from "./sectors.js";
import { EV_LABELS } from "./trend.js";
import { loadPush, loadRules, loadTriggers } from "./triggers.js";
import { usageCtl, usageSearch } from "./usage.js";


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
  dailyTimer=setTimeout(async()=>{ if(document.hidden) _dailyDirty=true; else await loadDaily(); scheduleDaily(); }, dailyWarm()? 20*1000 : 15*60*1000);
}
// Live warmup annotation for placeholder panels, fed by the snapshot's server-side counts.
function warmCount(){
  const w=state.warm;
  if(!w||!(w.d>0)) return '';
  return ` <span class="sec">(server backfill in progress — <b>${w.d}</b> market${w.d===1?'':'s'} remaining, refreshing every 20s)</span>`;
}
// ===== SSE version push (build 2026.07.29-07) ==================================================
// The server pushes {dataTs, alertVer, v} the second the content clock or alert seq moves; the
// reaction is the SAME loadSnapshot the poll runs — the stream changes WHEN we pull, never WHAT.
// While the stream is healthy the poll survives as a stretched 120s fallback (belt and braces: a
// proxy can wedge a stream half-open without erroring); any stream error snaps the cadence back
// instantly and EventSource handles its own reconnect. No EventSource support = the poll exactly
// as it always was.
let _sseOk=false, _sseSrc=null, _sseBackoff=2000, _sseRetryT=null;
function startEvents(){ if(typeof EventSource==='undefined'||_sseSrc) return;
  try{ _sseSrc=new EventSource('/api/events'); }catch(_){ return; }
  _sseSrc.onopen=()=>{ _sseOk=true; _sseBackoff=2000; startCycle(); };
  _sseSrc.onerror=()=>{
    if(_sseOk){ _sseOk=false; startCycle(); }   // a transient drop: the browser reconnects itself; we just restore the fast poll
    // A non-retryable answer (a 5xx mid-redeploy, a 401 after the session expired, a proxy 502)
    // leaves the source CLOSED for good and the browser never retries — and dmSync only ever ran
    // off this stream, so the unread pip and read receipts went dark for the rest of the session.
    if(_sseSrc&&_sseSrc.readyState===2){ try{ _sseSrc.close(); }catch(_){} _sseSrc=null;
      clearTimeout(_sseRetryT); _sseRetryT=setTimeout(startEvents,_sseBackoff); _sseBackoff=Math.min(_sseBackoff*2,60000); }
  };
  _sseSrc.onmessage=(ev)=>{ let d; try{ d=JSON.parse(ev.data); }catch(_){ return; }
    // A pushed dataTs we already hold is a no-op (the initial sync frame, typically). A new one —
    // including the new `v` a redeploy pushes via the reconnect's first frame — pulls immediately;
    // applySnapshot's own short-circuit and alertVer handling then do exactly what they do on a poll.
    if(d&&d.dataTs&&d.dataTs!==state.dataTs){ pullSnapshot(); nextCycle=Date.now()+_cycleMs(); }
    // (build 2026.09.24-108) The frame already carries alertVer: a moved one pulls the trigger log
    // DIRECTLY, visible or hidden. Since -103 a hidden tab pulls no snapshot (unless it holds an
    // in-browser rule), and the snapshot was the only road to loadTriggers — so server triggers
    // stopped raising desktop Notifications in background tabs, which is exactly where they matter.
    // Setting alertVer here first makes applySnapshot's own check a no-op for this version.
    frameAlertVer(d);
    // The reconnect's first frame after a redeploy is the fastest new-build signal there is —
    // dataTs is a restarted counter that can coincide with the one this tab already holds, so
    // the version notice must not depend on that comparison triggering a pull.
    if(d&&d.v&&state.build&&d.v!==state.build) notifyNewBuild(d.v);
    // Another of this member's devices wrote its watchlist or layouts: a version poke, pull on demand.
    if(d&&d.prefs) prefsRemoteFrame(d.prefs);
    // The positions lane saw a structural change in this member's book (a fill, a close, a new leg).
    if(d&&d.pos) loadPositions();
    // The dm frame carries a sequence, never a message. Pull whatever tab is showing: the unread
    // pip has to be right before you look at it, not after you switch to the tab.
    if(d&&d.dm){
      if(d.dm.typing) dmTypingFrame(d.dm.typing);
      // A tweet card landed for a message already on screen: re-pull the open page so it paints.
      if(d.dm.refresh&&state.view==='dm'&&dmState.sel===d.dm.refresh) dmRefreshOpen();
      // A group was deleted for everyone: drop it locally without waiting for the next full load.
      if(d.dm.gone){ dmState.msgs.delete(+d.dm.gone); if(dmState.sel===+d.dm.gone) dmState.sel=null;
        dmLoad().then(()=>{ if(state.view==='dm') dmRender(); }); }
      if(typeof d.dm.seq==='number'&&d.dm.seq>dmState.cursor) dmSync();
    } };
}
function frameAlertVer(d){
  const A=state.alerts;
  if(!d||d.alertVer==null||!A||d.alertVer===A.alertVer) return false;
  A.alertVer=d.alertVer; loadTriggers(); return true;
}
function _cycleMs(){ return _sseOk?Math.max(state.refreshMs,120000):state.refreshMs; }
// ===== hidden tabs idle (build 2026.09.24-103) ================================================
// A background tab used to pull /api/snapshot on every poke and poll, and applySnapshot then ran
// the whole derive + table rebuild for a page nobody was looking at — dozens of forgotten tabs
// were dozens of full client pipelines per server cycle. Now the poke/poll path goes through
// pullSnapshot: visible = pull exactly as before; hidden = remember that something moved
// (_hiddenDirty) and pull ONCE on the visibilitychange back to visible.
// The one exception is the in-browser alert evaluator (alerts.js: sqz/mom/beta rules, which fire
// desktop Notifications and exist nowhere server-side — Telegram and web push are the SERVER's
// escalation sweep and never needed this tab). While this browser holds at least one such rule a
// hidden tab keeps a SLOW background pull (at most one per BG_PULL_MS) so those rules still fire
// off-screen; the pull evaluates alerts but paints nothing (render()'s paint gate, markets.js).
const BG_PULL_MS=60000;
let _hiddenDirty=false, _bgPullAt=0, _dailyDirty=false;
function pullSnapshot(){
  if(document.hidden){
    _hiddenDirty=true;
    const rules=state.alerts&&state.alerts.rules;
    if(!(rules&&rules.length)||Date.now()-_bgPullAt<BG_PULL_MS) return false;
    _bgPullAt=Date.now();
  }
  loadSnapshot(); return true;
}
// Foregrounding catch-up: one pull if anything was skipped while hidden (poke, poll or daily
// timer), and a paint if the markets table was left dirty by a background alert pull.
function visibleCatchUp(){
  if(document.hidden) return;
  // (build 2026.09.24-108) The catch-up pull can land with a dataTs this tab already holds (a
  // background alert pull applied it), and applySnapshot then short-circuits without painting — the
  // table stayed at its pre-hide state with G.mktDirty set. So the deferred paint runs after the
  // pull too, whenever it is still owed.
  const owed=()=>{ if(!document.hidden&&G.mktDirty&&state.view==='markets') paintMarkets(); };
  if(_hiddenDirty){ _hiddenDirty=false; Promise.resolve(loadSnapshot()).then(owed,owed); nextCycle=Date.now()+_cycleMs(); }
  else owed();
  if(_dailyDirty){ _dailyDirty=false; loadDaily(); }
}
function startCycle(){ clearInterval(cycleTimer); const ms=_cycleMs(); cycleTimer=setInterval(()=>{ pullSnapshot(); nextCycle=Date.now()+_cycleMs(); }, ms); nextCycle=Date.now()+ms; }
function setRefresh(ms){ state.refreshMs=ms; startCycle(); }
function forceRefresh(){ loadSnapshot(); nextCycle=Date.now()+state.refreshMs; }
// The countdown is honest about the push stream: while SSE is healthy the poll is only a
// stretched 120s fallback, and painting THAT number read as "the app refreshes every 2 minutes"
// when updates actually land the moment the server's content clock moves (~15s rebuild cadence).
// So a live stream shows "push live" and the countdown only returns when the poll is really
// what's driving.
let _cdMode=null, _cdText='';

export function __boot_nav_10165() {   // last painted mode + text, so the 500ms tick doesn't rewrite unchanged DOM/titles
setInterval(()=>{ if(document.hidden) return;   // a background tab has nobody reading the countdown; visibilitychange brings it back
  const lbl=el('cdlbl'), c=el('cd'), mode=_sseOk?'push':'poll';
  if(mode!==_cdMode){ _cdMode=mode;
    if(lbl) lbl.textContent=_sseOk?'push':'next';
    if(c) c.title=_sseOk?'the server pushes a poke the moment its data changes (~15s build cadence) and this browser pulls immediately — the refresh selector only paces the fallback poll':''; }
  let txt='live';
  if(!_sseOk){ const left=Math.max(0,nextCycle-Date.now()), m=Math.floor(left/60000), s=Math.floor((left%60000)/1000); txt=m+':'+String(s).padStart(2,'0'); }
  if(c&&txt!==_cdText){ _cdText=txt; c.textContent=txt; }
  updateFreshness(); },500);
}


// ===== init =====

// Unread is marked on CLOSE, not open: marking on open zeroed the count before the panel painted,
// so the five new rows looked exactly like the forty old ones and `.aunread` never rendered.
// "I'm looking at HOOD, alert me at 113": open the bell with the rule form already carrying the name and its mark.
function openRuleFor(r){
  const pop=el('alertpop'); if(pop.hidden) el('bellBtn').click();
  const t=el('ar-ticker'), v=el('ar-val'), m=el('ar-metric');
  if(t) t.value=r.ticker||''; if(v&&r.px!=null) v.value=String(+(+r.px).toPrecision(6));
  if(m){ const o=[...m.options].find(o=>/^(px|price)$/i.test(o.value)||/price/i.test(o.textContent)); if(o) m.value=o.value; }
  const sec=el('sec-rules'); if(sec&&sec.hidden) { const h=pop.querySelector('[data-sec="rules"]'); if(h) h.click(); }
  if(v) v.focus();
}
function closeAlertPop(){ const pop=el('alertpop'); if(pop.hidden) return; pop.hidden=true; el('bellBtn').setAttribute('aria-expanded','false'); alertMarkRead(); updateBell(); }
// A control that rebuilds its own popover destroys the element that was clicked. By the time the
// click bubbles to document, e.target is DETACHED — and a detached node is contained by nothing, so
// the "did they click outside?" test says yes and the popover closes under the user's finger. Every
// popover here rebuilds itself from some control, so all four shared the bug; only the alerts panel
// grew enough re-rendering controls for it to become obvious.
function clickedOutside(pop, btn, e){
  if(!pop || pop.hidden) return false;
  if(!e.target || !e.target.isConnected) return false;   // we removed it ourselves — not an outside click
  return !pop.contains(e.target) && (!btn || !btn.contains(e.target));
}
function applyNumFilters(){
  for(const id of ['volMin','volMax','oiMin','oiMax']){ const inp=el(id), v=parseAmount(inp.value);
    if(Number.isNaN(v)) inp.classList.add('bad'); else { inp.classList.remove('bad'); state.filters[id]=v; } }
  updateFilterChip(); scheduleRender(); savePrefs();
}
function updateFilterChip(){
  const f=state.filters, on = f.volMin!=null||f.volMax!=null||f.oiMin!=null||f.oiMax!=null||!!state.watchOnly||!!state.noteOnly||!!state.posOnly;
  const dot=el('filtDot'); if(dot) dot.hidden=!on;
  const b=el('filtersBtn'); if(b) b.classList.toggle('on', on);
}
function buildColMenu(){ const pop=el('colpop'); let h='<div class="cphead">Show columns · drag headers to reorder</div>';
  for(const key of state.colOrder){ const c=COL_BY_KEY[key]; if(!c) continue;
    const dis=c.hideable===false, checked=!state.colHidden.has(key);
    h+=`<label class="copt${dis?' dis':''}"><input type="checkbox" data-col="${key}" ${checked?'checked':''} ${dis?'disabled':''}/> ${esc(c.label)}</label>`; }
  h+='<button class="btn" id="colReset" style="margin-top:8px;width:100%;justify-content:center">Reset layout</button>';
  pop.innerHTML=h;
  pop.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.addEventListener('change',()=>{
    const k=cb.dataset.col; if(cb.checked) state.colHidden.delete(k); else state.colHidden.add(k);
    usageCtl('markets.col-'+(cb.checked?'on':'off')+'='+k);   // (build 2026.09.24-112) which column, from the fixed id list — never the layout
    if(k==='pos') store.set('xyzmon.posCol', cb.checked?'shown':'hidden'); buildHead(); render(); savePrefs(); }));
  el('colReset').addEventListener('click',()=>{ state.colOrder=[...DEFAULT_ORDER]; state.colHidden=new Set(DEFAULT_HIDDEN); buildColMenu(); buildHead(); render(); savePrefs(); });
}
function setWindow(tf){ state.tf=tf;
  document.querySelectorAll('#tfseg button').forEach(x=>x.classList.toggle('active',x.dataset.tf===tf));
  document.querySelectorAll('#sectf button').forEach(x=>x.classList.toggle('active',x.dataset.tf===tf));
  buildHead(); render(); renderRegimeStrip();
  if(!el('view-sectors').hidden) renderSectors();
  savePrefs(); }

export function __boot_nav_10228() {loadPrefs();
loadLayouts();
loadAlerts();
buildHead();
updateBell();
el('filter').value=state.filter;
if(state._savedFilters){ const sf=state._savedFilters; el('volMin').value=sf.vMin||''; el('volMax').value=sf.vMax||''; el('oiMin').value=sf.oMin||''; el('oiMax').value=sf.oMax||''; }
el('watchOnly').classList.toggle('on', state.watchOnly);
{ const nb=el('noteOnly'); if(nb) nb.classList.toggle('on', state.noteOnly); }
updateLayoutBtn();
el('refresh').addEventListener('click', forceRefresh);
// Foregrounding the tab: reopen a dead stream and pull messages once, whatever tab is showing.
document.addEventListener('visibilitychange',()=>{ if(document.hidden) return;
  if(!_sseSrc) startEvents();
  if(typeof dmSync==='function'&&dmState&&dmState.me){ try{ dmSync(); }catch(_){} }
  visibleCatchUp(); });   // (build 2026.09.24-103) the one pull a hidden tab skipped, plus any deferred markets paint
// Search-as-you-type re-rendered the whole table synchronously per keystroke; one frame is plenty.
el('filter').addEventListener('input', e=>{ usageSearch('markets.search'); state.filter=e.target.value; scheduleRender(); savePrefs(); });
el('body').addEventListener('click', e=>{ const star=e.target.closest('.star');
  if(star){ e.stopPropagation(); toggleWatch(star.dataset.star); return; }
  const pit=e.target.closest('.pit[data-pit]');
  if(pit){ e.stopPropagation(); openDetail(pit.dataset.pit); return; }
  const tr=e.target.closest('tr[data-coin]'); if(tr) openDetail(tr.dataset.coin); });
// The marker is focusable, so it has to answer the keyboard too — a tabindex that does nothing on
// Enter is worse than no tabindex at all.
el('body').addEventListener('keydown', e=>{ const pit=e.target.closest&&e.target.closest('.pit[data-pit]');
  if(pit&&(e.key==='Enter'||e.key===' ')){ e.preventDefault(); e.stopPropagation(); openDetail(pit.dataset.pit); } });
// Share to chat (build 2026.09.21-84): the screener hands the share module its live rows and
// columns, and the table grows the floating glyph, the right-click menu and the `s` key.
shareSetSource(()=>({rows:sortedRows(),cols:visibleCols()}));
shareWireTable(el('body'), visibleCols);
// ...and every other surface (build 2026.09.24-98): the same glyph on the boards' rows, with the row
// and the whole board in the right-click menu, and on every section header of the drawer. The boards
// are read from what they drew; the funding heatmap is an SVG, so its row comes from the payload.
shareWireBoard(el('trend-body'), {view:'trend', title:'Trend ladder', rowSel:'tr[data-coin]'});
shareWireBoard(el('act-body'), {view:'actionable', title:'Actionable', rowSel:'tr.act-row'});
shareWireBoard(el('sect-board'), {view:'sectors', title:()=>state.sect&&state.sect.grp==='ind'&&state.scope!=='crypto'?'Industry rotation':'Sector rotation', rowSel:'tr[data-sect]'});
shareWireBoard(el('rvd-wrap'), {view:'drawdown', title:'Drawdown', rowSel:'tr[data-coin]'});
shareWireBoard(el('funding-body'), {view:'funding', title:'Funding heat', rowSel:'text.fh-tk[data-coin]', capture:n=>fhShareCard(n.getAttribute('data-coin'))});
shareWireDrawer(el('drawer'));
el('watchOnly').addEventListener('click',()=>{ state.watchOnly=!state.watchOnly; usageCtl('markets.preset=watch'); el('watchOnly').classList.toggle('on', state.watchOnly); updateFilterChip(); render(); savePrefs(); });
// Deliberately NOT part of a saved layout, unlike ★-only: adding a field to the layout signature
// would mark every layout the operator has already saved as dirty. Per browser, in prefs.
{ const nb=el('noteOnly'); if(nb) nb.addEventListener('click',()=>{ state.noteOnly=!state.noteOnly; usageCtl('markets.preset=notes'); nb.classList.toggle('on', state.noteOnly); updateFilterChip(); render(); savePrefs(); }); }
{ const pb=el('posOnly'); if(pb) pb.addEventListener('click',()=>{ state.posOnly=!state.posOnly; usageCtl('markets.preset=pos'); pb.classList.toggle('on', state.posOnly); updateFilterChip(); render(); });
  const lk=el('posLink'), inp=el('posAddr'), ub=el('posUnlink');
  if(lk&&inp){ lk.addEventListener('click',()=>{ const v=(inp.value||'').trim(); if(!v){ inp.classList.add('bad'); inp.focus(); return; } posLink(v); });
    inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); lk.click(); } }); }
  if(ub) ub.addEventListener('click',()=>{ if(confirm('Unlink the wallet? The overlay disappears; nothing else changes.')) posLink(null); });
  posStatText(); }
{ const db=el('dimOff');   // variant A toggle — visual only, per browser, never part of a saved layout
  if(db){ db.classList.toggle('on', state.dimOff);
    db.addEventListener('click',()=>{ state.dimOff=!state.dimOff; db.classList.toggle('on', state.dimOff);
      try{ localStorage.setItem('xyz-dimoff', state.dimOff?'1':'0'); }catch(_){}
      render(); }); } }
el('drawerbg').addEventListener('click', closeDetail);   // Escape is the overlay stack's (core.js): the drawer registers itself on open
el('bellBtn').addEventListener('click',e=>{ e.stopPropagation(); const pop=el('alertpop');
  if(pop.hidden){ loadPush(); loadRules(); }   // delivery state is server-truth; read it fresh every open (a link code expires in 10 min)
  if(pop.hidden){ buildAlertsPanel(); pop.hidden=false; el('bellBtn').setAttribute('aria-expanded','true'); }
  else closeAlertPop(); });
document.addEventListener('click',e=>{ const pop=el('alertpop');
  if(clickedOutside(pop, el('bellBtn'), e)) closeAlertPop(); });
['volMin','volMax','oiMin','oiMax'].forEach(id=>el(id).addEventListener('input', applyNumFilters));
applyNumFilters();
el('clearFilters').addEventListener('click', ()=>{ usageCtl('markets.preset=clear'); ['volMin','volMax','oiMin','oiMax'].forEach(id=>{ el(id).value=''; el(id).classList.remove('bad'); });
  state.filters={volMin:null,volMax:null,oiMin:null,oiMax:null}; updateFilterChip(); render(); savePrefs(); });
el('filtersBtn').addEventListener('click',e=>{ e.stopPropagation(); const pop=el('filterpop');
  if(pop.hidden){ pop.hidden=false; el('filtersBtn').setAttribute('aria-expanded','true'); const m=el('volMin'); if(m) m.focus(); }
  else { pop.hidden=true; el('filtersBtn').setAttribute('aria-expanded','false'); } });
document.addEventListener('click',e=>{ const pop=el('filterpop');
  if(clickedOutside(pop, el('filtersBtn'), e)){ pop.hidden=true; el('filtersBtn').setAttribute('aria-expanded','false'); } });
el('colsBtn').addEventListener('click',e=>{ e.stopPropagation(); const pop=el('colpop');
  if(pop.hidden){ buildColMenu(); pop.hidden=false; el('colsBtn').setAttribute('aria-expanded','true'); }
  else { pop.hidden=true; el('colsBtn').setAttribute('aria-expanded','false'); } });
document.addEventListener('click',e=>{ const pop=el('colpop');
  if(clickedOutside(pop, el('colsBtn'), e)){ pop.hidden=true; el('colsBtn').setAttribute('aria-expanded','false'); } });
el('layBtn').addEventListener('click',e=>{ e.stopPropagation(); const pop=el('laypop');
  if(pop.hidden){ buildLayoutMenu(); pop.hidden=false; el('layBtn').setAttribute('aria-expanded','true'); }
  else { pop.hidden=true; el('layBtn').setAttribute('aria-expanded','false'); } });
document.addEventListener('click',e=>{ const pop=el('laypop');
  if(clickedOutside(pop, el('layBtn'), e)){ pop.hidden=true; el('layBtn').setAttribute('aria-expanded','false'); } });
document.querySelectorAll('#tfseg button').forEach(b=>{ if(b.dataset.tf===state.tf)b.classList.add('active');
  b.addEventListener('click',()=>{ usageCtl('markets.window='+b.dataset.tf); setWindow(b.dataset.tf); }); });   // (build 2026.09.24-112) usage: sitewide control count
document.querySelectorAll('#grpseg button').forEach(b=>b.addEventListener('click',()=>{ usageCtl('markets.group='+b.dataset.grp); setGrp(b.dataset.grp); }));   // (build 2026.09.24-112) usage: sitewide control count
{ const ah=el('acthead'); if(ah) ah.addEventListener('click',()=>{ state.actOpen=!state.actOpen; renderActionLists(); savePrefs(); }); }
document.querySelectorAll('#grpwtseg button').forEach(b=>b.addEventListener('click',()=>{
  state.grpWt=b.dataset.gwt==='eq'?'eq':'vol'; usageCtl('markets.weight='+state.grpWt); syncGrpSeg(); render(); savePrefs(); }));
syncGrpSeg();   // after loadPrefs: reflect the restored lens (buttons, weighting seg, parked column/layout menus)
document.querySelectorAll('#sectf button').forEach(b=>{ if(b.dataset.tf===state.tf)b.classList.add('active');
  b.addEventListener('click',()=>{ usageCtl('sectors.window='+b.dataset.tf); setWindow(b.dataset.tf); }); });   // (build 2026.09.24-112) usage: sitewide control count
document.querySelectorAll('#sectwt button').forEach(b=>{ if(b.dataset.wt===state.sect.wt)b.classList.add('active');
  b.addEventListener('click',()=>{ state.sect.wt=b.dataset.wt; usageCtl('sectors.weight='+b.dataset.wt);
    document.querySelectorAll('#sectwt button').forEach(x=>x.classList.toggle('active',x===b));
    if(!el('view-sectors').hidden) renderSectors(); }); });
el('sectExport').addEventListener('click', exportSectors);
document.querySelectorAll('#sectgrp button').forEach(b=>{ if(b.dataset.grp===state.sect.grp)b.classList.add('active');
  b.addEventListener('click',()=>{ state.sect.grp=b.dataset.grp; usageCtl('sectors.grouping='+b.dataset.grp);
    document.querySelectorAll('#sectgrp button').forEach(x=>x.classList.toggle('active',x===b));
    // A drill-in selection is a group NAME; the other grouping may not contain it. Clear rather
    // than let a stale name pin a phantom row.
    state.sect.sel=null; const dp=el('sect-detail'); if(dp) dp.hidden=true;
    if(!el('view-sectors').hidden) renderSectors(); savePrefs(); }); });
document.querySelectorAll('#sectmode button').forEach(b=>{ if(b.dataset.mode===state.sect.mode)b.classList.add('active');
  b.addEventListener('click',()=>{ state.sect.mode=b.dataset.mode; usageCtl('sectors.view='+b.dataset.mode);
    document.querySelectorAll('#sectmode button').forEach(x=>x.classList.toggle('active',x===b));
    if(!el('view-sectors').hidden) renderSectors(); }); });
document.querySelectorAll('#rfseg button').forEach(b=>{ if(+b.dataset.ms===state.refreshMs)b.classList.add('active');
  b.addEventListener('click',()=>{ document.querySelectorAll('#rfseg button').forEach(x=>x.classList.toggle('active',x===b));
    setRefresh(+b.dataset.ms); savePrefs(); }); });
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>showView(t.dataset.view)));
// ← / ⌂ beside the help button: back to the tab you were on before this one, and home to Markets.
{ const b=el('backBtn'); if(b) b.addEventListener('click',goBackTab);
  const h=el('homeBtn'); if(h) h.addEventListener('click',()=>showView('markets')); }
document.querySelectorAll('#hsgwin button').forEach(b=>b.addEventListener('click',()=>{ state.housingWin=b.dataset.w; renderHousing(); }));
document.querySelectorAll('#liqwin button').forEach(b=>b.addEventListener('click',()=>{ state.liqWin=b.dataset.w; renderLiquidity(); }));
document.querySelectorAll('[data-scope]').forEach(b=>b.addEventListener('click',()=>{ usageCtl('header.scope='+b.dataset.scope); setScope(b.dataset.scope); }));   // (build 2026.09.24-112) usage: sitewide control count
}

// ===== nav tabs: drag to reorder, order persisted per browser =====
// Tabs live between the scope switcher and the right-side control cluster. #tabSpacer is the
// insertion anchor — a dedicated element rather than whichever button happens to sit first, so a
// moved tab can never land among the controls and no anchor dies when a control is removed.
const TABKEY='xyzmon.tabs.v1';
function saveTabOrder(){ try{ const nav=document.querySelector('nav.tabs');
  store.set(TABKEY, JSON.stringify([...nav.querySelectorAll('.tab')].map(t=>t.dataset.view))); }catch(_){} }
// Tabs present in the build but kept OUT of the nav strip by default. Deliberately a list of
// view names rather than an edit to index.html: the markup, the view section, every renderer and
// the whole API surface behind a hidden tab stay live and tested, so this is a display decision
// and un-hiding is a one-word change here. The tab remains reachable by deep link (#backtest) and
// through the command palette — hidden from the strip, not withdrawn from the app.
// The old client-side hide list is gone: 'backtest' and 'actionable' are now admin-state entries in
// the server manifest, which is the same hide expressed once instead of twice. Every tab is evaluated, so this
// both hides AND un-hides — a flag flipped in the panel takes effect on the next load with no
// markup change, and nothing can be left stuck hidden by a stale list.
function goBackTab(){ const p=state.prevView; if(p&&p!==state.view&&tabVisible(p)) showView(p); }
function applyTabVisibility(){
  const nav=document.querySelector('nav.tabs'); if(!nav) return;
  nav.querySelectorAll('.tab').forEach(t=>{ t.hidden = !tabVisible(t.dataset.view); });
  syncTabNav();   // a scope flip or a flag can hide the tab Back would return to — the button says so
  if(typeof syncTabGroups==='function') syncTabGroups(state.view);   // a group with nothing left in it hides too
}
function applyTabOrder(){ let ord; try{ ord=JSON.parse(store.get(TABKEY)||'null'); }catch(_){ ord=null; }
  const nav=document.querySelector('nav.tabs'); if(!nav||!Array.isArray(ord)||!ord.length) return;
  const anchor=el('tabSpacer');
  const byView={}; nav.querySelectorAll('.tab').forEach(t=>{ byView[t.dataset.view]=t; });
  for(const v of ord){ const t=byView[v]; if(t){ nav.insertBefore(t,anchor); delete byView[v]; } }
  for(const v in byView) nav.insertBefore(byView[v],anchor);   // tabs shipped AFTER the order was saved still show, appended in default order
}
function wireTabDrag(){ const nav=document.querySelector('nav.tabs'); if(!nav) return;
  // Idempotent: safe to re-run after a tab is injected at runtime (the self-installing
  // Treemap tab arrives on DOMContentLoaded, after the initial wiring pass).
  nav.querySelectorAll('.tab').forEach(t=>{ if(t.__dragWired) return; t.__dragWired=1; t.draggable=true;
    t.addEventListener('dragstart',e=>{ t.classList.add('dragging');
      try{ e.dataTransfer.setData('text/plain',t.dataset.view); e.dataTransfer.effectAllowed='move'; }catch(_){} });
    t.addEventListener('dragend',()=>{ t.classList.remove('dragging'); saveTabOrder(); }); });
  if(nav.__dragWired) return; nav.__dragWired=1;
  nav.addEventListener('dragover',e=>{ const drag=nav.querySelector('.tab.dragging'); if(!drag) return;
    e.preventDefault();
    const over=(e.target&&e.target.closest)?e.target.closest('.tab'):null; if(!over||over===drag) return;
    if(over.parentNode!==drag.parentNode) return;   // no dragging across groups: a tab's group is the taxonomy's call, not a drop target
    const r=over.getBoundingClientRect();
    const menu=over.closest('.tabmenu');            // menus stack vertically, the flat row horizontally
    const before=menu ? (e.clientY < r.top + r.height/2) : (e.clientX < r.left + r.width/2);
    over.parentNode.insertBefore(drag, before ? over : over.nextSibling); });   // live reorder — the moving tab IS the drop indicator
}
// ===== nav groups: five triggers instead of eighteen peers =====================================
// The ribbon was one flex row holding the scope switcher, every tab and two controls, and it ran
// out of width — visibly, with four tabs already hidden to make it fit. Grouping stops the row
// growing with the feature list: adding a tab now costs a menu row, not horizontal space.
//
// The real .tab buttons MOVE INTO the menus rather than being replaced by copies. Everything that
// already keys off them keeps working untouched: showView's active sweep, applyTabVisibility's
// per-tab hidden, the per-tab click handlers, the treemap installer's delegated nav listener
// (menus stay inside nav.tabs, so clicks still bubble to it) and saveTabOrder's DOM read.
//
// markets and admin stay flat on purpose: markets is pin:true in the server manifest and is the
// view every load lands on, so putting home two clicks away would be a bad trade; admin is a
// single locked entry and a one-item menu is pure cost. A tab in NO group and not pinned stays
// flat too — a tab added without touching this list degrades to today's behaviour instead of
// disappearing.
const TAB_PINNED = new Set(['markets','admin']);
// Taxonomy AND labels arrive in the page shell, resolved server-side from compute.js — one list
// answers both "which views does this menu hold" and "what is it called", and the admin's names are
// on the first painted frame instead of flashing the defaults until a fetch lands. The literal
// below is the fallback for a shell whose flag slot failed to inject: the ribbon still groups, with
// default names, which is the same degradation the feature flags already take.
const TAB_GROUPS = (Array.isArray(window.__NAVGROUPS) && window.__NAVGROUPS.length)
  ? window.__NAVGROUPS.map(g=>({ key:g.key, label:g.label, def:g.def||g.label, views:(g.views||[]).slice() }))
  : [
  { key:'tape',     label:'Tape',     views:['trend','charts','treemap','sectors','drawdown','corr','sessions'] },
  { key:'signals',  label:'Signals',  views:['signals','actionable','focus','backtest','ematouch'] },
  { key:'macro',    label:'Macro',    views:['earnings','news','housing','liquidity'] },
  { key:'research', label:'Research', views:['report','funds'] },
];
const tabGroupOf=(v)=>TAB_GROUPS.find(g=>g.views.includes(v))||null;
function closeTabMenus(except){
  document.querySelectorAll('.tabgrp').forEach(w=>{ if(w===except) return;
    const b=w.querySelector('.grp'), m=w.querySelector('.tabmenu');
    if(b) b.setAttribute('aria-expanded','false'); if(m) m.hidden=true; });
}
function openTabMenu(wrap){
  const btn=wrap.querySelector('.grp'), menu=wrap.querySelector('.tabmenu');
  if(!btn||!menu) return;
  closeTabMenus(wrap);
  menu.hidden=false; btn.setAttribute('aria-expanded','true');
  // fixed positioning, measured on open: nav.tabs becomes an overflow-x scroller on narrow
  // viewports and would otherwise clip the menu.
  const r=btn.getBoundingClientRect();
  menu.style.top=(r.bottom+5)+'px';
  menu.style.left='0px'; menu.style.right='auto';
  const w=menu.offsetWidth||186;
  menu.style.left=Math.max(8, Math.min(r.left, window.innerWidth-w-8))+'px';
}
function toggleTabMenu(wrap){
  const btn=wrap.querySelector('.grp');
  if(btn&&btn.getAttribute('aria-expanded')==='true') closeTabMenus(); else openTabMenu(wrap);
}
// Idempotent: re-runnable after a tab is injected at runtime (treemap arrives on DOMContentLoaded).
function buildTabGroups(){
  const nav=document.querySelector('nav.tabs'); const anchor=el('tabSpacer');
  if(!nav||!anchor) return;
  const byView={}; nav.querySelectorAll('.tab').forEach(t=>{ byView[t.dataset.view]=t; });
  // pinned first, in a fixed order, so home never moves
  if(byView['markets']) nav.insertBefore(byView['markets'],anchor);
  for(const g of TAB_GROUPS){
    const members=g.views.map(v=>byView[v]).filter(Boolean);
    let wrap=nav.querySelector('.tabgrp[data-grp="'+g.key+'"]');
    if(!members.length){ if(wrap) wrap.remove(); continue; }
    if(!wrap){
      wrap=document.createElement('span'); wrap.className='tabgrp'; wrap.dataset.grp=g.key;
      const btn=document.createElement('button');
      btn.type='button'; btn.className='grp'; btn.setAttribute('aria-haspopup','true');
      btn.setAttribute('aria-expanded','false');
      btn.innerHTML='<span class="lbl"></span><span class="cnt"></span><span class="caret">\u25BE</span>';
      const menu=document.createElement('div');
      menu.className='tabmenu'; menu.setAttribute('role','menu'); menu.hidden=true;
      wrap.appendChild(btn); wrap.appendChild(menu);
      btn.addEventListener('click',(e)=>{ e.stopPropagation(); toggleTabMenu(wrap); });
      btn.addEventListener('keydown',(e)=>{ if(e.key==='ArrowDown'||e.key==='Enter'||e.key===' '){
        e.preventDefault(); openTabMenu(wrap); const f=menu.querySelector('.tab:not([hidden])'); if(f) f.focus(); } });
    }
    wrap.querySelector('.lbl').textContent=g.label;
    const menu=wrap.querySelector('.tabmenu');
    members.forEach(t=>menu.appendChild(t));      // preserves the persisted relative order
    nav.insertBefore(wrap,anchor);
  }
  // ungrouped, unpinned tabs stay flat rather than vanishing
  nav.querySelectorAll('.tab').forEach(t=>{ const v=t.dataset.view;
    if(t.closest('.tabmenu')||TAB_PINNED.has(v)) return;
    if(!tabGroupOf(v)) nav.insertBefore(t,anchor); });
  if(byView['admin']) nav.insertBefore(byView['admin'],anchor);   // admin sits last, next to the controls
  syncTabGroups(state.view);
  setTimeout(syncTabScroll,0);
}
// A group shows only if it has a visible member, and its count reflects what the viewer can
// actually reach — crypto scope and the feature flags both prune members, so an admin on stocks
// and a group member on crypto see different counts on the same trigger.
function syncTabGroups(v){
  document.querySelectorAll('.tabgrp').forEach(wrap=>{
    const menu=wrap.querySelector('.tabmenu'), btn=wrap.querySelector('.grp');
    if(!menu||!btn) return;
    const shown=[...menu.querySelectorAll('.tab')].filter(t=>!t.hidden);
    wrap.hidden=!shown.length;
    const g=TAB_GROUPS.find(x=>x.key===wrap.dataset.grp);
    if(g) btn.querySelector('.lbl').textContent=g.label;   // a rename repaints here, no reload
    btn.querySelector('.cnt').textContent=shown.length?String(shown.length):'';
    btn.classList.toggle('active', shown.some(t=>t.dataset.view===v));
  });
}

export function __boot_nav_10422() {
document.addEventListener('click',(e)=>{ if(!e.target.closest||!e.target.closest('.tabgrp')) closeTabMenus(); });
document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') closeTabMenus(); });
window.addEventListener('resize',()=>closeTabMenus());
applyTabOrder(); buildTabGroups(); applyTabVisibility(); wireTabDrag();
{ const vb=el('admVap'); if(vb) vb.addEventListener('click',toggleViewAsPublic); }
// Logout button: only meaningful when the server set the JS-visible auth marker at login.
{ const lb=el('logoutBtn'); if(lb && /(^|;\s*)xyzauth=1/.test(document.cookie)){ lb.hidden=false;
    // Name the account the button would sign out of. With accounts, "sign out" is no longer a
    // single shared door — knowing WHICH identity you are about to drop is the whole point.
    if(window.__ME&&window.__ME.handle){ lb.title='Signed in as '+window.__ME.display+' — sign out of this device';
      lb.textContent='\u23CF '+window.__ME.display; }
    lb.addEventListener('click',()=>{ location.href='/logout'; }); } }
applyScope();
}

// ===== theme + density: one of each, no toggles ===============================================
// The amber palette and the cozy/compact switch were both removed. There is one terminal theme in
// styles.css and compact is the only density, so there is nothing here to restore, persist or
// re-render on — the whole surface is CSS. Kept as a note so the next reader doesn't go looking
// for the wiring that used to live at this line.

// ===== focused ticker: set by any drawer open, shown in the statusline, follows across tabs =====
function updateFocusChip(){ const c=el('focusChip'); if(!c) return;
  const r=state.focus?state.rows.get(state.focus):null;
  if(!r){ c.hidden=true; return; }
  c.hidden=false; const t=el('focusChipT'); if(t) t.textContent='◎ '+(r.ticker||state.focus); }

export function __boot_nav_10545() {
{ const t=el('focusChipT'), x=el('focusChipX');
  if(t) t.addEventListener('click',()=>{ if(state.focus&&state.rows.has(state.focus)){ showView('markets'); openDetail(state.focus); } });
  if(x) x.addEventListener('click',()=>{ state.focus=null; updateFocusChip(); }); }
}


// ===== keyboard navigation: "/" search · j/k rows · Enter drawer · Esc clear =====
function applyKsel(){ const body=el('body'); if(!body) return;
  body.querySelectorAll('tr.krow').forEach(tr=>tr.classList.remove('krow'));
  if(!state.ksel||state.view!=='markets') return;
  const tr=body.querySelector(`tr[data-coin="${CSS.escape(state.ksel)}"]`); if(tr) tr.classList.add('krow'); }
function kmoveSel(dir){ const rows=sortedRows(); if(!rows.length) return;
  let i=rows.findIndex(r=>r.coin===state.ksel);
  i = i<0 ? (dir>0?0:rows.length-1) : Math.min(rows.length-1, Math.max(0, i+dir));
  state.ksel=rows[i].coin; applyKsel();
  const tr=el('body').querySelector('tr.krow'); if(tr) tr.scrollIntoView({block:'nearest'}); }

export function __boot_nav_10554() {
// Enter / Space on a custom control acts like a click, and Enter on a focused market row opens it —
// the rows, the star, conversation rows and the terminal chips were mouse-only before.
document.addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ') return;
  const t=e.target; if(!t||t.tagName==='BUTTON'||t.tagName==='A'||t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT') return;
  if(t.matches&&(t.matches('[role="button"]')||(t.matches('tr[data-coin]')&&e.key==='Enter'))){ e.preventDefault(); t.click(); }
});
document.addEventListener('keydown',e=>{
  if(e.ctrlKey||e.metaKey||e.altKey) return;
  if(e.key==='Escape'&&e.defaultPrevented) return;   // the overlay stack already spent this Escape on its top layer
  const t=e.target, tag=t&&t.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||(t&&t.isContentEditable)) return;
  if(e.key==='?'){ e.preventDefault(); openHelp(); return; }
  if(e.key==='b'){ e.preventDefault(); goBackTab(); return; }          // ← the tab you were on before this one
  if(e.key==='h'){ e.preventDefault(); showView('markets'); return; }   // ⌂ home
  if(e.key==='/'){ e.preventDefault();
    // focus the current tab's primary search; tabs without one fall back to the markets filter
    const map={markets:'filter',corr:'corrsearch',report:'ai-q',dm:'dm-q',signals:'sighist-q',news:'nfilter',insiders:'ins-q'};
    let inp=el(map[state.view]||'');
    if(!inp){ const sec=el('view-'+state.view); inp=sec&&sec.querySelector('input[type="search"],input[type="text"],input:not([type]),textarea'); }   // any tab with a box keeps you on it
    if(!inp){ showView('markets'); inp=el('filter'); }
    if(inp){ inp.focus(); inp.select&&inp.select(); } return; }
  if(state.view==='dm'){ dmKeys(e); return; }                            // j/k walk the conversation rail, Escape backs out a level
  if(state.view!=='markets'||overlayTop()||mktGrp()!=='names') return;   // j/k/Enter drive the markets NAMES table only — never under an open layer (drawer, help, palette…) or a group lens
  if(e.key==='j'){ e.preventDefault(); kmoveSel(1); return; }
  if(e.key==='k'){ e.preventDefault(); kmoveSel(-1); return; }
  if(e.key==='Enter'&&state.ksel&&state.rows.has(state.ksel)){ e.preventDefault(); openDetail(state.ksel); return; }
  if(e.key==='Escape'){ if(state.ksel){ state.ksel=null; applyKsel(); } else if(state.grpDrill) clearDrill(); } });
}
   // two-stage: first the row highlight, then the drill filter — keyboard parity with the chip's ×

// ===== mobile column preset: the phone-width table, as a built-in layout =====
// Columns that survive a ~390px viewport with the ticker pinned: price, the day, the week,
// funding and positioning. Everything else stays one ⚙ toggle away — this hides, never removes.
const MOBILE_COLS=['ticker','px','d1','d7','funding','doi','vol'];
function applyMobileCols(){
  const ord=[...MOBILE_COLS.filter(k=>COL_BY_KEY[k])];
  for(const c of COLS) if(!ord.includes(c.key)) ord.push(c.key);
  state.colOrder=ord;
  state.colHidden=new Set(COLS.filter(c=>c.hideable!==false && !MOBILE_COLS.includes(c.key)).map(c=>c.key));
  state.layouts.active=null; saveLayouts();
  buildHead(); render(); savePrefs(); updateLayoutBtn(); }

export function __boot_nav_10590() {
// First visit on a phone-width screen with no stored table prefs → start from the mobile preset
// instead of a 1300px table. One-shot: the flag is set either way, so a user who widens the
// column set never gets overridden on a later visit.
(function(){ try{
  if(!matchMedia('(max-width:680px)').matches) return;
  if(store.get('xyzmon.mobilePreset.v1')) return;
  store.set('xyzmon.mobilePreset.v1','1');
  if(store.get(PKEY)) return;   // returning browser — their arrangement wins
  applyMobileCols();
}catch(_){}})();
}


// ===== PWA: install-only service worker (caches nothing — see server.js /sw.js) =====


export function __boot_nav_10612() {if('serviceWorker' in navigator){ try{ navigator.serviceWorker.register('/sw.js').catch(()=>{});
  // A notification click on an OPEN tab asks the page to switch tabs (sw.js postMessage) instead
  // of navigating it: a full navigation reloaded the app and dropped whatever was being typed.
  navigator.serviceWorker.addEventListener('message',e=>{ const d=e&&e.data; if(d&&d.go==='dm') showView('dm'); else if(d&&d.go==='markets') showView('markets'); }); }catch(_){}}

document.querySelectorAll('#corrtf button').forEach(b=>{ if(b.dataset.d===state.corr.tf)b.classList.add('active');
  b.addEventListener('click',()=>{ state.corr.tf=b.dataset.d; usageCtl('corr.lookback='+b.dataset.d); document.querySelectorAll('#corrtf button').forEach(x=>x.classList.toggle('active',x===b));
    if(!el('view-corr').hidden) renderCorr(); }); });
document.querySelectorAll('#corrn button').forEach(b=>{ if(+b.dataset.n===state.corr.topN)b.classList.add('active');
  b.addEventListener('click',()=>{ state.corr.topN=+b.dataset.n; usageCtl('corr.top='+b.dataset.n); state.corr.selected=null; state.corr.pair=null; document.querySelectorAll('#corrn button').forEach(x=>x.classList.toggle('active',x===b));
    if(!el('view-corr').hidden) openCorr(); }); });
document.querySelectorAll('#corrtop button').forEach(b=>{ if(+b.dataset.k===state.corr.topPairs)b.classList.add('active');
  b.addEventListener('click',()=>{ state.corr.topPairs=+b.dataset.k; usageCtl('corr.pairs='+b.dataset.k); document.querySelectorAll('#corrtop button').forEach(x=>x.classList.toggle('active',x===b)); renderCorrPairs(); }); });
}

let corrSearchT=null;
// ===== per-tab help ("?" in the nav): how to READ each view, not just what it shows =====
const HELP={
  liquidity:`<div class="hlp-h">What this is</div><p>The Fed's balance sheet netted against the two accounts that pull cash back out of the banking system. <b>Net liquidity = total assets − Treasury General Account − ON RRP</b>. It is the dollar amount actually circulating against risk assets, and its direction has tracked equity drawdowns and melt-ups since 2009. All series are FRED (H.4.1 release, Thursdays ~4:30pm ET); the board refreshes after each release and every 6h otherwise.</p>
<div class="hlp-h">The tiles</div><p>Total assets and its three big holdings (Treasuries, agency debt, MBS) are Wednesday levels. TGA is the Treasury's checking account at the Fed — a weekly average; when Treasury hoards cash (tax season, post-debt-ceiling rebuild) it drains liquidity. ON RRP is where money funds park cash overnight at the Fed — daily, sampled on the H.4.1 Wednesday. Everything is shown in billions; the H.4.1 lines publish in millions and ON RRP in billions, and the board normalises before subtracting.</p>
<div class="hlp-h">Year-to-date bars</div><p>Each bar is the change since the last print of the prior year, <i>signed by its liquidity effect</i>: holdings add when they grow; TGA and ON RRP add when they <i>shrink</i>. The net bar is their sum. A blue TGA bar therefore means Treasury ran its balance down, not up.</p>
<div class="hlp-h">% of GDP</div><p>Net liquidity divided by nominal GDP (quarterly, forward-filled). The level that matters is relative to the economy — $6T meant something different in 2014 than in 2024. The caption shows the peak and how far below it we sit.</p>
<div class="hlp-h">Plumbing stress (ours)</div><p>Two series the usual net-liquidity pages leave out. <b>Bank reserves</b> are what the Fed actually targets as "ample"; the 2019 repo spike came when they hit ~$1.4T. <b>SOFR − IORB</b> is the overnight funding rate against what the Fed pays on reserves — persistently positive means collateral is scarce and reserves are getting tight, the earliest warning that QT has gone too far. <b>QT end</b> on the Treasuries tile is derived: the first week after the 13-week change in holdings stopped being negative.</p>`,
  housing:`<div class="hlp-h">What this is</div><p>A macro board for US housing and mortgage credit — the backdrop behind the homebuilders, mortgage servicers, REITs and banks in the universe. Every panel is a public series pulled server-side from FRED and refreshed every 6 hours; nothing here is intraday.</p>
<div class="hlp-h">Reading the source chips</div><p>Each card carries a chip naming its series. <b>Direct</b> means the panel is the same series the institutional Market Monitor uses. <b>Proxy</b> means the original is paid or proprietary (jumbo rates, NAR existing-home data, Deutsche Bank's non-QM spread) and the card shows the closest public stand-in — the chip text says exactly what differs.</p>
<div class="hlp-h">Panels</div><p><b>Mortgage rate</b> — Freddie Mac 30y conforming, weekly. <b>Starts</b> — single-family and multifamily, millions SAAR. <b>Months' supply</b> — new homes; 6+ months historically reads as a buyer's market. <b>Sales / price</b> — Census new-home sales and the median price of houses sold. <b>Spread proxy</b> — ICE BofA BBB corporate OAS in bp, standing in for non-QM spreads.</p>
<div class="hlp-h">Change columns</div><p>12m compares the latest print with the observation closest to one year earlier — a missing month returns a dash, never an approximation. Series that didn't come back on the last pass are listed at the foot of the tab rather than shown stale.</p>
<div class="hlp-h">What is deliberately absent</div><p>FRED retires series without erroring — the request still returns 200 and the observations simply stop. A panel whose newest print is older than its own cadence can explain is dropped and named at the foot of the tab, never charted as if it were current; SLOOS lending standards (<b>DRTSPM</b>) was removed for exactly that reason, having stopped at 2014Q4 when the survey retired the question. Non-agency MBS issuance (SIFMA) and TRACE secondary volume (FINRA) are absent too: both are xlsx downloads with no API, and an empty card promising a future feed is a roadmap item, not a panel.</p>`,
focus:`
<div class="hlp-h">What this list is</div>
<p>Six seats, <b>stamped once at the 09:30 ET cash open</b>, one late fill at +1h, then immutable for the day — a compressed morning scan, not a signal. The engine reads only what the board already computed (gap machinery, clock-matched RVOL, the OI history, the earnings calendar, the news tape, the 30d extremes) and freezes it. The first hour itself is measured on <b>1m</b> bars captured by a lane reserved for the six seats, republished every ~25s until the 10:30 freeze. It never reshuffles at 10:47 because a number ticked; yesterday's list stays viewable exactly as stamped.</p>
<div class="hlp-h">How seats are earned</div>
<p>A disclosed <b>loudness ordering</b> (in compute, one formula): |gap σ| + RVOL excess + |ΔOI| + a flat earnings boost + a small headline count. Every unit is the name's <b>own distribution</b> — a +1.1% gap on a sleepy name outranks +2.9% on a high-beta one when the σ says so. <b>Max 2 seats per cluster</b> (curated industry): six seats should be six trades, not one theme wearing six tickers. The cut line discloses what just missed and why (rank vs cluster cap). Foreign-home names (KRX/TSE/HKEX) are excluded by doctrine — their gap anchors to the wrong exchange for an ET open stamp.</p>
<div class="hlp-h">Liquidity floors</div>
<p>Two walls set in the admin panel — a <b>24h notional minimum</b> and an <b>OI minimum</b> — applied at candidate assembly, before loudness is ever compared: a seat you cannot exit at your size is not a seat. Names that clear the tape but fail a wall never enter the ranking, so they are not "cuts"; they get their own <b>BELOW FLOOR</b> roster under the table, loudest-first, with which wall they failed and how far it would have to fall to admit them. A name whose OI series is too sparse to be honest is <i>never</i> refused on the OI wall — cutting on a number we do not have is a fabricated rejection, and the volume wall still judges it. The floors in force at 09:30 are <b>frozen onto the record</b>: raising them tomorrow never rewrites how yesterday's list was made. If the walls leave fewer than six names, the stamp seats what cleared and says so on the bar rather than padding the list or withholding it — the booting-universe check reads the count <i>before</i> the floors, so a strict wall can never be mistaken for a cold start.</p>
<div class="hlp-h">The +1h columns</div>
<p><b>sVWAP</b>, <b>1H HI</b>, <b>1H LO</b> (actual prices) fill once at 10:30 ET from the 5m archive and freeze. The <b>1H RANGE</b> bar shows where the open sat in the hour's eventual range (grey) vs the 10:30 print (amber) — the "who won the first hour" read. A name missing from the archive shows dashes, never guesses.</p>
<div class="hlp-h">The chart (▦)</div>
<p>5m/15m/1h/4h candles over the <b>last 72h, read from the local 5m archive</b> — the exact series that fills the +1h columns, so board and chart cannot disagree, and no live fetch happens on open. Off-session time (nights, weekends, holidays) shades dark from the calendar engine; the gap is visible forming across it. The frozen 1H HI/LO and open draw <b>verbatim from the stamped row</b>; the VWAP line is the chart's own session-anchored series (labeled), with the frozen board sVWAP restated in the header so the two sit side by side rather than being conflated. Crosshair for exact OHLC.</p>`,
markets:`
<div class="hlp-h">The table</div>
<p>One row per market, one column per lens. The <b>window selector</b> (1h–30d) re-anchors every windowed column at once: <b>vs S&amp;P</b>, <b>ΔOI</b>, <b>Squeeze</b>, <b>Carry</b>, and Avg Range all answer "over this window". Click any header to sort; drag in the column menu (⚙) to reorder or hide. Cell shading scales with the size of the move — a wall of deep red 7d cells IS the market breadth read. <b>★</b> pins a name to the top. Everything deep-links: the URL carries your view, so a layout can be shared. <b>Layouts</b> saves the whole arrangement as a named view — columns + order, sort, window, vol/OI filters, ★-only — and switches between them in one click; there is no one-size-fits-all table. The active name shows on the button, with a • when the live view has drifted from the saved one (open the menu to re-save). Stored per browser, so the phone can hold different layouts than the desktop. The ticker search box and the scope toggle are deliberately not part of a layout.</p>
<div class="hlp-h">Group lens — sectors &amp; industries</div>
<p>The <b>group</b> toggle re-renders the same board with one row per <b>sector</b> (GICS + asset classes) or <b>industry</b> (the finer curated split — Semis vs Software vs Memory, Banks vs Capital Markets), every window column at once: D open, 1h→30d, M/Y open, breadth, ΔOI, RVOL, volume, OI, cohesion. Each cell is the <b>weighted average of exactly the rows the names view shows</b> — vol-weighted by default (equal on the toggle), computed only over members that have the value, with the hover disclosing coverage; a missing window is excluded and the weights renormalize, never zero-filled. <b>Best · Worst</b> (pinned to 24h) is the aggregate-liar detector: whether the group number is everyone, or one name dragging the rest — read it against <b>Cohesion</b> (90d avg internal correlation: high = the label trades as one block, low = a stock-picker's bucket). <b>Click a group row</b> to drill in: the table flips back to names filtered to its members, with a chip to clear. Vol/OI filters and ★-only apply to members <i>before</i> aggregation; industries are equities-only (crypto's curated sectors are already its fine grouping); industry rows marked <i>= sector</i> have no curated split yet. CSV exports whichever lens is on screen.</p>
<div class="hlp-h">Action strip — heating · cooling · strongest bid</div>
<p>The collapsible strip under the table is the <b>rate-of-change</b> read next to the table's levels, and it always describes <b>exactly the rows the table shows</b> — scope, the window selector, vol/OI filters and any active drill all apply. Per name, <b>accel</b> = the window's natural fast leg (1h→15m, 4h→1h, 1d→4h, 7d→1d, 30d→7d) minus the window's own pace, both measured relative to the tape; <b>heat</b> = accel + 0.6·tanh(ΔOI/8) + 0.4·clamp(RVOL−1) — flow can only <i>confirm</i> an acceleration, never replace it, and RVOL (clock-matched, ≤1d only) is dropped at 7d/30d, not faked. <b>HEATING</b> = positive accel with flow agreeing: what is starting. <b>COOLING</b> = names still <i>ahead of the tape</i> whose pace has died — with a high MOM this is the take-profit read, and it is a different animal from "never went anywhere", which makes no list at all. <b>STRONGEST BID</b> ranks the server's dip-reclaim claims off the 5m archive (equities, last 4h): the deepest peak→trough dip, the fraction reclaimed, minutes since the low, ranked dip × reclaimed ÷ √minutes — demand response, not momentum; a flat name absorbing every dip has the strongest bid on the board. <b>M</b> on every chip is the momentum <i>level</i>, printed so the pair reads at a glance: high/high = ride, high/stalling = exit, low/accelerating = new rotation. Empty lists are honest, not hidden. Click a chip to open the name's drawer. <b>In a group lens</b> the strip regroups with the table: HEATING/COOLING become sector/industry rows (accel on the group aggregates vs the same names tape) whose volume confirm is <b>Δ share of tape</b> — today's slice of total volume vs the group's own ~30d baseline mix — instead of RVOL, because rotation between groups is zero-sum: share only moves when the mix moves, while every group can print RVOL ×1.5 at once on a hot day and tell you nothing. Group chips show <b>B</b> (breadth) where names show MOM, and click-drill into their members. STRONGEST BID stays name-level in every lens — a dip is an event in time and does not aggregate.</p>
<div class="hlp-h">Funding — the crowd's payment</div>
<p>Annualized APR: <b class="pos">green = longs pay</b> to hold (crowded long), <b class="neg">red = shorts pay</b> (crowded short — squeeze fuel). The ▴/▾ percentile flag fires when today's funding sits at a monthly extreme of that market's <i>own</i> 31d distribution — the crowd is paying near its max, the classic mean-reversion zone. <b>Carry</b> divides window funding by realized vol: how much you're paid per unit of risk just for taking the unpopular side.</p>
<div class="hlp-h">ΔOI and the regime tag</div>
<p>Open-interest change answers "is money entering or leaving?" — but only <i>with price</i> does it tell a story. The four tags: <b class="pos">longs+</b> price↑/OI↑ (new money confirming), <b>squeeze</b> price↑/OI↓ (shorts covering, NOT fresh demand), <b class="neg">shorts+</b> price↓/OI↑ (new money pressing lower), <b>unwind</b> price↓/OI↓ (longs deleveraging, not fresh shorting). Hover for conviction and whether funding corroborates the story. Caveat that matters: OI is symmetric — long/short attribution is always an inference, never an observation.</p>
<div class="hlp-h">Momentum, levels, structure</div>
<p><b>Momentum</b> (−100…+100) is self-normalizing: risk-adjusted multi-horizon returns × trend quality, tilted by range position, modulated by OI conviction — comparable across a quiet FX pair and a violent pre-IPO synthetic. The ● dot means volume above the market's own norm. <b>vs 30d hi / vs YTD hi</b> are distance below the high (0% = at it now). <b>Y open / M open</b> show the level the period opened at — on a 24/7 perp that IS the prior day's close — green when price is above. MAs are daily-close SMAs; dashes are honest (not enough history), never fabricated. <b>VWAP 30d / vs VWAP</b> (hidden by default) are the volume-weighted counterpart: Σ(typical price × volume) ÷ Σ(volume) over ~31 days of hourly candles, typical = (H+L+C)/3 per bar. Where the MAs weight every day equally, VWAP weights by where the volume actually printed — read it as the average recent holder's entry. Positive vs VWAP = the month's buyers are in profit; deeply negative = trapped supply overhead. Honest caveat: it's a candle-level approximation of tick VWAP (no per-fill data in candles), slightly less exact on thin markets. Both scopes, fills in as hourly history loads.</p>
<div class="hlp-h">Prem and Gap — the off-hours edge</div>
<p><b>Prem</b> is the perp vs oracle dislocation in bp. When the cash market is <i>closed</i>, the oracle freezes near the last print — so a persistent premium or discount is the live off-hours price discovery, and the tradeable reversion. <b>Gap</b> is the last close→open move (live while the market is closed); its hover carries the cumulative 30d off-hours drift — a persistent sign there is the overnight effect.</p>
<div class="hlp-h">Home sessions — the names that live on Seoul/Tokyo/Hong Kong time</div>
<p>A handful of equities have no US symbol: their reference line trades on <b>KRX</b> (SMSN, SKHX, HYUNDAI), <b>TSE</b> (SOFTBANK, KIOXIA, IBIDEN) or <b>HKEX</b> (ZHIPU, MINIMAX) — roughly the <i>ET evening</i>, the mirror image of the US day. The <b>Sess</b> chip carries the home market with a lit dot while that exchange is open (server-computed against its real holiday calendar); the amber <b>rail</b> on the row's left edge is the same state in peripheral vision, and the microline under the ticker counts down to the next open/close. For these names <b>Gap</b>, the overnight holds and the drawer's session split are <b>anchored to the home exchange</b> — SMSN gaps on Seoul's clock, never New York's — and they are excluded from the ET-pooled session composites rather than contaminating them. ADRs (TSM, ASML, ARM, BABA) show <i>US·TW</i>-style chips: the listed line is a US instrument, so ET machinery applies as-is; the home code is context. The <b>☾ dim</b> toggle in the filter menu fades foreign-home rows while their exchange sleeps — the perp still trades, but the oracle under it is coasting. Past the curated calendar horizon the state degrades to weekend-only and says so on hover.</p>
<div class="hlp-h">Squeeze &amp; OI/Vol</div>
<p><b>Squeeze</b> (0–100) is how loaded the spring is: crowding (shorts paying) × fuel (OI building) × trigger (price pressing the 30d high). Zero whenever funding is positive — no crowded shorts, no squeeze. <b>OI/Vol</b> is standing positioning ÷ daily flow: ≥2× means stale, crowded positioning that can't exit quickly — fragile to squeezes and unwinds. High squeeze + negative funding + rising OI + high OI/Vol is the full configuration.</p>
<div class="hlp-h">Red-tape resilience &amp; RVOL (hidden by default — column menu ⚙)</div>
<p>The setup these serve: on a red tape, the names that dump least tend to keep leading once the market stabilizes. <b>vs tape</b> is the live read — this market's window return minus the <i>universe median</i>, not a benchmark, so BTC-green-while-alts-bleed days are measured correctly and the benchmark is just another row. <b>DownCap 31d</b> is the character read: over the last month's 4h bars where the whole scope was red (≥70% of names down, negative median), how much of the tape's move this name ate — &lt;100% dumps less than the typical name, negative means net green on red bars, &gt;100% amplifies. <b>Hit%</b> is the consistency check: the share of those bars where it beat the median — good DownCap with low Hit% means a couple of lucky bars carried the average. Both are fixed 31d/4h and don't follow the window selector. The workflow: red tape → sort vs tape → confirm the strength is character (DownCap low, Hit% high) and being <i>bought</i> (RVOL up). Honest caveats: one month of character, not a regime; cascade bars are winsorized so a single liquidation event can't dominate the ratio; dashes below 20 matched bars, always.</p>
<p><b>RVOL</b> is relative volume, clock-hour matched: notional over the selected window (1h/4h/1d) ÷ the median of the <i>same clock hours</i> across the prior month. 1.0× = normal for this time of day; ≥2× = genuinely elevated. Clock matching is the point — overnight hours are judged against prior overnights, the open against prior opens, so the session shape doesn't masquerade as a volume signal. Positive vs-tape on ~1× RVOL is drift; on 2×+ it's demand. Weekends read slightly cold by construction (the baseline mixes weekday hours); 7d/30d windows show a dash — clock matching has no meaning beyond a day.</p>
<div class="hlp-h">Crypto scope</div>
<p>The Stocks|Crypto switch is a hard wall: separate universes, separate benchmark (BTC, not S&amp;P), no mixing anywhere. Crypto adds the tape strip up top — <b>crowd pays</b> (OI-weighted funding APR: euphoria tax vs squeeze fuel), <b>breadth</b>, total OI with its weighted delta, BTC's day, and the alt-season gauge. Session concepts (gap) vanish: a 24/7 market has none. Crypto history is 31d by design, so long MAs and YTD columns show honest dashes.</p>`,
trend:`
<div class="hlp-h">What this is</div>
<p>An <b>EMA 13/21 ribbon</b> evaluated on four timeframes — <b>D1 · H12 · H4 · H1</b> — for every market in the active scope, ranked into long and short leaderboards. The tab follows the <b>scope switcher</b>: stocks scope shows the xyz board, crypto scope shows the main-dex board — flip it for the other universe. Per timeframe: <b class="pos">green</b> = price &gt; EMA13 &gt; EMA21 (stacked, trending), <b style="color:var(--accent)">yellow</b> = the middle state (above EMA21 but not stacked on the longs lens; below EMA21 but not stacked on the shorts lens), <b class="neg">red</b> = stacked down. The <b>score</b> counts aligned timeframes: 4/4 is an established trend on every rung; 2–3/4 means higher timeframes lead and you wait for the lower ones to agree.</p>
<div class="hlp-h">RETEST — the entry flag</div>
<p><b style="color:var(--blue)">RETEST</b> fires when the last few bars (forming bar included) probed into the 13/21 ribbon zone on a <i>trending</i> timeframe while the close held the EMA21 side — the classic continuation pullback (long) or rally-into-resistance (short). The highest timeframe showing it is the one named in the read. Honest approximation, stated plainly: the zone test compares recent bar extremes against the <i>current</i> EMAs, not bar-by-bar historical EMAs, and daily candles restored from the warm cache carry closes only, so their zone probe degrades to closes.</p>
<p>The badge carries a <b>volume read</b> when the baseline qualifies: <b style="color:var(--blue)">RETEST · 0.8×</b> means the last completed bar-length of the retesting timeframe traded 0.8× its clock-matched norm — the same construction as the Markets-table RVOL, so overnight pullbacks are judged against prior overnights. The interpretation is the whole point: a pullback into the zone on <b>~1× or less</b> is quiet — sellers aren't pressing, the healthy continuation character. At <b>≥2×</b> the level is being <i>fought</i>, not respected — heavy tape into the zone reads as distribution (longs) or determined dip-buying against the short. No multiple shown = the volume baseline couldn't qualify (an honest dash, never a guess).</p>
<div class="hlp-h">Width — ribbon thickness</div>
<p><b>Width</b> is the average EMA13–EMA21 spread across the rungs aligned with this side, as a percent — how far apart the ribbon actually is. It exists to disambiguate equal scores: two 4/4s are not the same trade when one holds a 0.08% ribbon (a stack one bad bar unwinds) and the other a 2% ribbon (established separation that takes real selling to flip). Per-rung, so it's comparable across scores; always positive by construction (it only measures aligned rungs). Pairs with age: young + thin = a breakout still proving itself, old + wide = the established trend you're late to.</p>
<div class="hlp-h">Sourcing & ranking</div>
<p>H1 is the hourly spine; H4/H12 are UTC-aligned aggregations of it; D1 is the daily series with the live mark driving the forming bar — the board moves with price between candle refreshes; on a US (or foreign-home) name it is the <b>session</b> series: a weekend or exchange holiday folds into the next session's bar, so EMA13/21 count trading sessions, not UTC days (crypto: calendar days). EMAs are SMA-seeded and require 26+ bars per rung; a market missing any rung is <b>excluded and counted</b> in the header line, never guessed at. Crypto's 31-day retention means its D1 EMA21 is young — converged enough to classify, but treat fresh listings' D1 rung with appropriate suspicion. Ranked by score, then <b>fresh-first</b>: within a score, the youngest D1 stack ranks highest — a day-3 trend is the entry, a day-40 trend is the chase. <b>Age</b> is an exact per-bar EMA walk counting consecutive D1 days the ribbon has been stacked this side (N+ means "at least" — the stack extends past available history, most common on crypto's 31d retention; a dash means the D1 rung itself isn't aligned). <b>Δ21</b> is the live distance from the H1 EMA21 — the proximity-to-entry number: a 4/4 at +0.4% is at the zone, at +6% it's extended. Ticker badges carry per-scope context from the machinery the Markets table already uses: crypto shows the ▴/▾ funding-percentile flag when the crowd's payment is at a monthly extreme (a 4/4 uptrend on a ▴ is a consensus trade), stocks show the earnings badge when a report is imminent (a retest two days before earnings is a different trade). Only names with ≥2/4 alignment on that side appear, top 10. This is a <i>screener lens</i>, not a ledger signal: nothing here carries frozen entry/stop/target geometry.</p>
<p><b>Chart button</b> (row end) opens a candlestick chart of any rung (1H · 4H · 12H · 1D) with the EMA 13/21 ribbon plotted, the retest zone banded at the ladder's own levels, and a crosshair OHLC + EMA readout. One-code-path honesty: every annotation — state badge, retest flag, zone levels, Δ21, the read — is the board's own payload restated, and the candles are the exact series the ladder consumed for that rung, so the plotted ribbon reproduces the board's EMAs to the last bit. Bars inside the EMA seed window (before EMA21 exists) render dimmed with no ribbon — real candles, no half-converged lines — which on crypto's 31-day retention is most visible on the D1 view. Closes-only daily bars (warm-cache restores, the forming day) draw as close ticks, never fabricated flat candles.</p>`,
sectors:`
<div class="hlp-h">Flow map (default)</div>
<p>Each bubble is a sector. <b>Horizontal = capital direction</b>: a blend of return and OI-conviction — right means money flowing in <i>with</i> conviction, left means flowing out. <b>Vertical = heat</b>: activity from volume and volatility. So <b>top-right = accumulation</b> (in, loudly), <b>top-left = distribution</b> (out, loudly), and the bottom half is simply quiet. Bubble size = 24h volume. Click a bubble for the sector's members.</p>
<div class="hlp-h">Grouping: sector vs industry</div>
<p>The <b>grouping</b> toggle (equities scope only) re-cuts the whole tab — map, board, drill-in, cohesion, the pairwise matrix — by a finer curated <b>industry</b> layer: memory/storage split from semis split from software, banks from payments from crypto-fi, and so on. Groups may deliberately cross GICS sectors when that's how the tape trades (Crypto-Fi holds MSTR beside COIN; the DRAM index sits inside Memory/Storage) — the <b>GICS</b> column keeps the parent sector visible. Two honesty chips: <b>«thin»</b> marks groups under 5 members whose averages and cross-group ranks are noisier, and <b>«= sector»</b> marks names with no industry split, which inherit their GICS sector unchanged rather than disappearing. This is a <i>display grouping only</i> — signal-engine pooling and news badges stay on the 11-sector GICS map.</p>
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
<p>The names that move with it (proxies, contagion map) and against it (natural hedges). Strongest-pairs below surfaces the tightest relationships across the whole set. ↓ CSV exports the matrix.</p>
<div class="hlp-h">COMP/G — N-name comparison</div>
<p>The pair view generalized. <b>COMP/G</b> (button top-right, or <span class="amber">comp NVDA AAPL MSFT …</span> in the terminal) rebases every selected name to <b>100</b> at a chosen date and overlays them — "how have these six traded relative to each other since X." Set the anchor with the presets, the date picker, or by <b>dragging the amber line</b>. <b>Spread mode</b> plots each name minus the equal-weight basket of visible names (or a base you pick) in percentage points — a clean read on who's leading and lagging the group. Runs on the closes already loaded — daily on equities, the shared intraday grid (4h/1d/7d) on crypto, the same series the correlation matrix uses — so it's instant and never adds a fetch. A name listed after the anchor rebases to its own first close, dated in the legend — no fake shared origin.</p>`,
funding:`
<div class="hlp-h">What a cell is</div>
<p>One time bucket of one market's funding, read in one of two units. <b>Annualized</b> (the default): the mean hourly rate the spine saw in that bucket, ×24×365 — the same convention as the funding column on the Markets table, the terminal and the drawer, so the newest 1h cell and the table agree. <b>Per bucket</b>: the funding a <b>1× long paid</b> over that bucket, the hourly spine summed across it — what the hold actually cost. Either way <b>red = longs pay</b>: the crowded side is long and carry is a cost to hold it. <b>Green = longs receive</b>: the crowded side is short and the carry pays you to be long. Flat carry is the panel colour, so a quiet market reads as nothing rather than as a hue of its own. Every tooltip carries both numbers.</p>
<div class="hlp-h">1h / 8h / 24h — a resolution when annualized, a quantity per bucket</div>
<p>Annualized, the buttons change how finely one rate is sliced: the same market reads one number on every grid, and all three share <b>one colour scale</b> (the 8h grid's own 98th percentile) so switching resolution never repaints a cell. Per bucket, Hyperliquid pays hourly, so an 8h bucket is eight payments and a 24h bucket is twenty-four — the same market genuinely reads ~8× and ~24× larger, and each timeframe has <b>its own colour scale</b>. In both units the window moves with the button: 1h spans two days, 8h fourteen, 24h thirty. The unit you pick is remembered in this browser.</p>
<div class="hlp-h">Hatched means unknown, never zero</div>
<p>The funding spine has holes — it is seeded from the persisted OI samples and topped up by a best-effort backfill. A bucket that can't see at least half its hours is drawn as a <b>hatch</b>, because a gap in the data and a market that genuinely went flat mean opposite things to anyone sizing a position. The newest column is always the last <b>complete</b> bucket for the same reason.</p>
<div class="hlp-h">Reading it</div>
<p>The scale is capped at the grid's own 98th percentile so one blowout can't flatten everything else; past the cap a cell just saturates. The two numbers on the right are that row's mean over the window and its <b>current</b> funding (this hour's rate from the live snapshot), both in the unit you are reading — a sign is the direction, stated without relying on colour, and now above mean means carry is building. Rows rank by open interest; sort by carry side or |carry| — on the window mean, or on the <b>now</b> column — to bring the crowded names to the top. <b>Hover</b> any cell for its exact rate and which side is paying.</p>`,
sessions:`
<div class="hlp-h">Session decomposition — the flagship</div>
<p>What an <b>overnight</b> (close→open), <b>weekend</b> (Fri→Mon), and <b>cash</b> (open→close) hold actually pays, pooled one equal-weight bet per calendar boundary across the equity class, compounded into equity curves. <b>Gross</b> vs <b>net</b>: the shaded band is the running funding drag — an edge that dies net-of-funding is not an edge, it's a donation. A persistently rising overnight curve while the cash curve is flat is the classic overnight effect; the drawer's "where the 30d return happened" split is the per-name version of the same question.</p>
<div class="hlp-h">The clocks</div>
<p><b>Hour-of-day activity</b>: when each market is actually alive, in its own volume norm — trade the loud hours, mistrust prints from the dead ones. <b>Funding clock</b>: when the payment concentrates. <b>Day-of-week 7×24 heatmap</b> and <b>return seasonality by hour</b>: where returns systematically cluster in the week — read these with sample-size humility, seasonality is the easiest pattern to hallucinate.</p>
<div class="hlp-h">Structure panels</div>
<p><b>Cross-ticker clustering</b> groups markets by the shape of their trading day; <b>asset-class overlays</b> compare the composite day of equities vs FX vs commodities. Panels unlock as the 180-day hourly spine accrues — an empty panel means insufficient coverage, not a bug.</p>
<div class="hlp-h">Every chart hovers</div>
<p>Crosshair + readout on all curves: date, value, and breadth (how many names stood behind that point). Points built on thin breadth deserve less trust.</p>`,
signals:`
<div class="hlp-h">What a signal is</div>
<p>An unusual condition, ranked — <b>never a prediction</b>. Score = unusualness now (0–50) + historical edge: the market's <b>own base rate</b> when it has ≥8 occurrences, else the <b>asset-class pooled</b> rate at a 30% discount, else a token score. Every base rate shows n, median forward outcome, and hit — evidence, not adjectives. <i>unproven</i> = flag without history; <i>neg exp</i> = past occurrences lost money on average (shown for awareness, ranked as noise).</p>
<div class="hlp-h">How to read a card</div>
<p>Every condition renders in the same four-line grammar. <b>Line 1</b>: the event chip, the plain-language reading, and — at the right edge — when the condition appeared and the ledger claim it’s scored against (@ the frozen mark, with time to resolution). <b>Line 2</b>: the evidence in one fixed format — scope (own base rate / class-pooled / thin) · n · median · hit · expectancy · horizon — with any qualifier pills (unproven, neg exp, no live edge, earnings proximity) at the end. <b>Line 3</b>: the mechanical play — side, target, void, R/R — frozen from the claim when one is open, live-computed otherwise. <b>Line 4</b>: the single corroborating thing to watch. Same information, same tooltips; the grammar is fixed so your eye lands on the same fact in the same place on every card.</p>
<div class="hlp-h">Self-audit — the part to trust</div>
<p>Every fired signal is <b>ledgered at its mark and resolved at its horizon</b>, out-of-sample. The record blends back into scoring (weight grows with resolved count — trust migrates from backtest to reality), and event types whose live record shows no edge get capped automatically. In the accuracy panel: <b>live hit/med vs claimed</b> is the honesty gap; <b>pf</b> (profit factor) catches the 55%-hit event that still loses money; <b>calibration buckets</b> audit the scorer itself — if 55+ scores don't hit more than &lt;35 scores, the ranking is broken; <b>⛔ stop-aware</b> re-scores every claim as if the void level had been a hard stop. The <b>bracket track</b> (build -20) goes one further: outcomes cap at whichever frozen level \u2014 target or void \u2014 was touched FIRST, the symmetric discipline a real bracket order would have enforced.</p>
<div class="hlp-h">Playbooks, prime, decay</div>
<p>Each signal states a side, a mechanical level that voids it, and a target from the historical median — the <b>R:R</b> is scored (poor structure is penalized). <b>★ prime</b> = ≥60% hit, positive expectancy, sound structure at fire time. Signals <b>decay</b> past their claimed horizon (amber) and drop at 2× — a stale signal is not a signal.</p>
<div class="hlp-h">Confluence — direction-aware</div>
<p>Multiple <i>same-side</i> conditions on one name compound (the bonus is <b>earned</b>: once 15+ resolutions exist on each side, it scales to the measured lift of with-company firings, and drops to zero if agreement doesn't prove out). <b>⇄</b> means long AND short fired on one name — flagged, no bonus for anyone, each claim resolves on its own.</p>
<div class="hlp-h">Ticker history</div>
<p>The search bar loads any name's full claim-by-claim audit trail: what fired, at what score and mark, what it claimed, and what actually happened — including open claims counting down to their horizon. The drawer's Signal record is the compact version of the same ledger.</p>
<div class="hlp-h">Self-tuning (shadow variants)</div>
<p>Each gated event runs 2–3 candidate thresholds; only the incumbent emits visible signals, but ALL variants silently ledger shadow claims on identical bookkeeping. A challenger is promoted only on ≥30 out-of-sample resolutions per side with a real expectancy beat — bounded self-improvement, not free re-fitting.</p>`,
actionable:`
<div class="hlp-h">What this board is</div>
<p>Every name in the equity universe currently sitting <b>at a swing trigger</b> — one row per name per side, with the entry, invalidation and target you would actually use. It is the morning list: the other tabs tell you what is true, this one tells you what is actionable, and it exists so you stop assembling that list by hand across three tabs.</p>
<div class="hlp-h">Where the levels come from</div>
<p>Nothing on this board is computed here. Every claim in the ledger froze its <b>side, void and target at fire time</b>, and those frozen values are what you see — the same numbers the track record was scored against. That is the point: if the board recomputed a level, the board and the record would be answering different questions about the same trade. <b>Entry</b> is the one live number — the current mark, because that is what entering now costs.</p>
<div class="hlp-h">R:R is net of funding</div>
<p>These are perpetuals and these are multi-day holds, so carry is a real slice of R, not a rounding error. A three-week hold on a crowded long at 45% APR donates ~2.6% of notional before the trade does anything; against a 5% stop that is half your risk unit. The headline <b>R:R is therefore net of expected funding</b> across the setup's horizon, and it <i>flips sign</i>: a short in a name paying to be short is <b class="pos">paid to wait</b>. Hover any row for the gross figure and the exact carry drag.</p>
<div class="hlp-h">EV, and where it is blank</div>
<p><b>EV</b> is expectancy in R for entering <i>this</i> instance here — the event's out-of-sample hit rate applied to this row's own net geometry (a win takes the net R:R, a loss takes the void for −1R). It is deliberately <i>not</i> the average realized R of past fires, which answers a different question. Below <b>8 resolved fires</b> the hit rate cannot honestly price anything, so EV stays blank and the row sits in the <b>no record yet</b> section — ranked by net R:R instead of being handed a fabricated rank. Expect that section to hold everything at first: these setups accrue their records out of sample, from scratch.</p>
<div class="hlp-h">Age, and falling off</div>
<p><b>Age</b> is bars in trigger measured in the setup's own timeframe — a daily retest on its ninth bar is not the same animal as one on its first. A row leaves the board when it ages past 10 bars, when its reward:risk from the live mark drops under 1.2, or when price passes its void and the geometry stops being tradeable from here. None of that is a judgement about the setup; it is the arithmetic of entering <i>now</i> rather than at the fire.</p>
<div class="hlp-h">Flags</div>
<p>⚠ marks a scheduled earnings print <i>inside</i> the setup's horizon — a binary the base rate cannot see. It is flagged, never filtered: standing aside is your call, and the post-earnings-drift setup deliberately trades the aftermath. A <b>+n</b> chip means other detectors fired on the same name and side; they are corroboration, not extra trades, and they never overwrite the winning claim's levels. Horizons of 3d or longer only (D1 · H12 · H4); crypto runs its own compressed floor. Both universes, scoped by the toggle — never mixed in one list.</p>
`,
earnings:`
<div class="hlp-h">What it shows</div>
<p>Scheduled earnings reports over the next 14 days for the <b>equity</b> names in the universe, grouped by <b>ET calendar day</b> with the session: <b>BMO</b> = before the 09:30 ET open, <b>AMC</b> = after the 16:00 ET close, <b>DMH</b> = during market hours, <b>TBD</b> = date known, session not. Click a row to open that ticker's drawer. Data is Finnhub's schedule, refreshed server-side every ~6h — companies reschedule, so treat dates as scheduled, not guaranteed.</p>
<div class="hlp-h">The E badge on Markets</div>
<p>A <b>solid E</b> next to a ticker = reports <b>today</b>; a <b>hollow E</b> = <b>tomorrow</b> (ET days, since BMO/AMC are ET concepts — the badge doesn't flip at your local midnight). Hover it for the session and EPS estimate. Nothing shows beyond one day out — the table flags only what can hit the next session; the full window lives here.</p>
<div class="hlp-h">Coverage — what's honestly absent</div>
<p>Indices, ETFs, FX, commodities, thematic baskets and pre-IPO synthetics never report earnings. Foreign listings without a US symbol (SMSN, KIOXIA, SOFTBANK…) are real companies with real earnings, but this feed doesn't carry them — they're <b>absent, never guessed</b>. A missing name means "no report scheduled in the window OR not covered", and the coverage line states how many eligible equities exist so absence is auditable.</p>
<div class="hlp-h">Reported rows — beat/miss, kept for 48h</div>
<p>Once a company reports, the same feed row fills in the <b>actual</b>: the tab shows "EPS 5.71 vs 5.62 est · <b>beat</b> +1.6%" and the E badge flips to a scoreboard (verdict + the live day move). The verdict is EPS-only — the tape's verdict is the move next to it, and they disagree often enough to be interesting. Reports don't vanish at midnight: a <b>Reported</b> section at the top keeps the two prior ET days on the tab with their beat/miss and a <b>reaction</b> move — the print's own reaction candle per the study convention (BMO/DMH scores its own UTC daily candle, AMC the next one), never today's unrelated move. A reaction candle still forming reads "so far"; one not opened yet says so instead of showing zero. Rows come from the persisted print history, so a late-landing actual upgrades the row in place and the section survives redeploys. Two hygiene rules run against every (chunked, complete) fetch: a print the feed retracted from the refetched 5-day back window is dropped, and a past print whose ticker is still scheduled ahead for the same fiscal quarter is a placeholder-date phantom, dropped. For garbage neither rule can reach — a feed asserting a report that never happened, with no corrected row anywhere — the <b>×</b> on a reported row voids the print permanently (tombstoned; no future fetch can re-add it). The verdict is beat / miss / <b>in line</b> vs the feed's own estimate. The pair's display precision expands in lockstep — both numbers always at the same decimals — until two things hold: actual and estimate read as different numbers whenever they are, AND the pair reconciles with the surprise % printed beside it. The surprise is computed on the feed's stored 4dp values and is never rounded to match the display, so it is the NUMBERS that expand to explain it (“EPS 0.31 vs 0.3 beat +3.9%” reads as +3.3%, and that contradiction is what the rule prevents). An estimate with no actual beside it prints at two decimals — four only when two would round a sub-cent estimate away entirely — with the feed's exact value in the row's tooltip.</p>
<div class="hlp-h">The reaction study</div>
<p>Each name's <b>own earnings base rate</b>, measured as the move from the <b>last cash close before the print to the first cash close after it</b> (BMO: prior close → print-day close; AMC: print-day close → next session's close, so a Friday AMC reads Monday; holidays and 13:00 half days on the exchange calendar — build 2026.09.24-106), read at the exact 16:00 ET anchors off the hourly spine / 5m archive, with session daily closes as a labelled fallback (the share is shown): number of prints, average and median |move| with a bootstrap 90% interval (n ≥ 4), up/down split, the <b>cash-session gap</b> (the reaction session's 09:30 ET open vs that reference close, and whether the session's close held beyond it — intraday-only, with "gap n=X of Y" when prints lack coverage), and the move as a multiple of that name's usual daily range. Untimed (TBD) prints are excluded. History starts from a one-time ~1y feed backfill (depth = whatever the free tier honestly returns) and <b>self-accrues</b> from there — every print that passes is persisted like the OI log. n is shown always; "no history" means exactly that, never a hidden zero.</p>
<div class="hlp-h">Live context columns</div>
<p>Day move, 24h volume and ADR on each row come from the live snapshot already in your browser — so a Thursday with eight prints reads at a glance as one that matters and seven that don't. ★ watchlist names float to the top of each day.</p>
<div class="hlp-h">Interaction with Signals</div>
<p>Session-spanning claims (breakout, breakdown, outsized gap, overnight drift) firing on a name that reports ≤1 day out wear an <i>earnings</i> flag and have their <b>evidence contribution capped</b> (same 8-point cap as the no-live-edge guard) and can't be ★ prime. Why: the historical base rates weren't conditioned on a known binary catalyst sitting inside the horizon — this is a stated <b>prior</b>, not a measured expectancy, and it's labeled as such on the card. The condition's intensity is untouched; only borrowed statistical confidence is trimmed. Every such claim is also <b>tagged in the ledger</b> (E in the claim history), and once ≥5 tagged claims resolve per event, the Signals tab shows the earnings-window record next to the ordinary one — over time the guard stops being a prior and becomes a measured base rate.</p>
<div class="hlp-h">Macro rows — FOMC and the print calendar</div>
<p>Interleaved with earnings by ET day: <b>FOMC decisions</b> (statement 2:00 PM ET, presser 2:30; <b>SEP</b> chip = dot-plot meeting) from the Fed's published schedule, and <b>CPI · nonfarm payrolls · PPI · retail sales · GDP · PCE</b> (all 8:30 ET) from FRED's release schedule. These are <b>universe-wide</b> — an FOMC decision moves BTC as hard as it moves SPX, so the rows, the global banner and every flag apply to both scopes. The banner under the nav appears when the next event is <b>\u22642 ET days out</b> on every tab, and flips to a blue <b>result strip</b> for the rest of the ET day once the print is out.</p>
<div class="hlp-h">Macro rows — what the numbers are (and aren't)</div>
<p>Upcoming rows show the <b>prior</b> — the previous print, labeled by its reference month. It is <b>not a consensus estimate</b>: no street-estimate feed exists in this system, so macro rows never claim a beat/miss vs expectations. Once released, a row reads <b>prior → actual</b>; between the ET release clock and FRED's data landing (typically under an hour) it says <i>"released — actual pending"</i> instead of dressing a stale month as the print. FOMC rows resolve to <b>held / cut / hiked</b> against the range going in. Dates come from the agencies' published schedules and can move.</p>
<div class="hlp-h">Macro × Signals, Actionable, AI reports</div>
<p>A macro event ≤1 ET day out flags session-spanning signals on <b>both universes</b> with the same 8-point evidence cap as the earnings guard (applied once — a claim already capped for earnings isn't trimmed twice), and stamps the claim in the ledger for a future conditioned split. On the <b>Actionable</b> board, events inside a setup's remaining horizon show a blue <b>◆</b> — flagged, never filtered. <b>AI reports</b> receive the same events as deterministic flags plus context, and the analyst is required to acknowledge any event inside the scenario horizon in the read and the plan. Absent a <b>FRED_KEY</b> the FOMC schedule still serves (it's a static table); only the print rows and their numbers degrade, with the reason shown on the coverage line.</p>`,
backtest:`
<div class="hlp-h">What it is</div>
<p>A client-side, cross-sectional long/short backtest on the daily returns already in your browser — parameter tweaks are instant and cost the server nothing. Ranking rules are deliberately non-fitted; the honest overfitting risk is <i>you</i>, picking parameters by eye.</p>
<div class="hlp-h">The signal roster</div>
<p>Seventeen non-fitted ranking rules in six families. <b>Trend</b>: momentum, sector-relative momentum (demeaned within each sector so no rank is just a sector bet), residual momentum (β-neutral), high proximity (closeness to the window high). <b>Reversion</b>: short-term reversion. <b>Risk</b>: low volatility, low idiosyncratic vol, low beta (BAB), anti-lottery (fade the biggest single-day pop). <b>Perp-native</b>: funding carry — long the names shorts pay to hold. <b>Flow</b>: volume trend and OI change, both deliberately sign-ambiguous — the direction toggle decides which tail you own. <b>Live-score variants</b>: Blend M0 is the daily mirror of the Markets-tab momentum score (risk-adjusted 1/7/30d blend × cross-horizon coherence + range tilt), and V1–V4 each add exactly one candidate upgrade — β-residual slow horizons, regime-qualified OI, a funding-crowding haircut, volume participation. This family is the promotion bench for the live column: a candidate ships into the board's Momentum only after beating M0 on out-of-sample net, and losers get deleted, not left as clutter. These five run fixed horizons, so the lookback control doesn't apply. Rules that rank on daily highs/volume, OI, or funding say so honestly when the server isn't shipping that column yet.</p>
<div class="hlp-h">Testing one name — the target picker</div>
<p>The <b>target</b> box takes a ticker from the live universe (typeahead, not a dropdown — the roster is too long to scroll, and free text never resolves). Pick <b>one</b> name and the tab switches to <b>single-asset mode</b>: a rank of one name isn't a rank, so the same signal runs as a <i>timing rule</i> — the score's own sign decides the position, and <b>entry</b> decides how far from zero it has to sit first (sign only, ±0.5σ or ±1σ of that name's own trailing score scale, measured through that day only, never with hindsight). The controls that exist purely to slice a cross-section — the book quantile and the rank gate — are dimmed with the reason on hover rather than silently ignored; <b>weighting</b> becomes position <b>sizing</b> (flat 1×, scaled by conviction, or sized to a 20% annualized vol target); <b>structure</b> keeps its three options as long/short, long-or-flat, short-or-flat. Costs, funding, the hold window and the IS/OOS split are the identical accounting the cross-sectional path uses — that is what makes the two modes comparable.</p>
<p>The curve gains two things: <b>buy &amp; hold that name</b> as the dashed line — the only benchmark a one-name rule actually has to beat — and a <b>position ribbon</b> under the axis showing when the rule was long, short or flat. The book panel becomes the current position plus every round trip it took. Read the round-trip count first: one name over the history this server ships is a few dozen decisions at most, there is no cross-sectional diversification to average the luck out, and a Sharpe on under ten round trips is an anecdote with a decimal point — the stat flags itself, shown rather than hidden. Sector-relative momentum still demeans against the name's live sector peers; with fewer than three of them the tab refuses the run instead of quietly serving plain momentum under the wrong label.</p>
<p>Pick <b>several</b> names and it stays cross-sectional, ranked only among those — a custom universe, with the thin-book arithmetic stated up front (a 20% book of five names is one name per side); a picked set needs at least four names to run. The <b>★ watchlist</b> pill replaces the picks with your starred names from this scope that carry enough daily history — one star runs single-asset, several a custom universe; it sits dead, with the reason on hover, when none qualify. The trades box reads round trips, <b>avg trade</b> (the mean round trip on the net curve, the open one at its mark), win rate, funding and fees. Picks belong to one universe: flipping Stocks/Crypto clears them.</p>
<div class="hlp-h">Crypto scope</div>
<p>The tab follows the Stocks/Crypto switcher: crypto runs the top-60 Hyperliquid perps against a <b>BTC benchmark</b> with 365-day annualization, no overnight hold (24/7 markets have no boundary), and funding carry at home. The two universes never mix in one run.</p>
<div class="hlp-h">How to read the curve</div>
<p>Four lines: <b>net</b> (after funding), <b>gross</b>, <b>benchmark</b>, <b>equal-weight universe</b>. The shaded split is <b>in-sample | out-of-sample</b>: a strategy that only works left of the line was curve-fit by your eyeballs. Judge on OOS net vs equal-weight — beating the benchmark with a long/short book is table stakes; beating naive equal-weight is the actual bar.</p>
<div class="hlp-h">Fills, costs and error bars</div>
<p>(build 2026.09.24-106) The signal reads bar <i>d</i>'s close, so by default the book <b>fills at the next bar's close</b> and earns from the bar after — <b>fill: same close (as before)</b> restores the older, optimistic fill at the very close the signal was computed from. Every fill pays the <b>taker bps</b> plus <b>slip bps</b> per side on turnover (overnight: twice a night). Each Sharpe carries <b>± its standard error</b> (Lo 2002, √((1+½SR²)/T) per period, annualized) and a ⚠ when the 95% band includes zero. <b>Survivorship:</b> the history is current listings only — delisted names' daily history is not shipped, so a rule never held the names that died.</p>
<div class="hlp-h">Score duel</div>
<p>Below the curve: the head-to-head between the board's <b>Momentum</b> and the <b>MOM+</b> candidate (same core; OI term regime-qualified so covering flow doesn't amplify like new money, plus a funding-crowding haircut at the crowd's own monthly extreme). Once per UTC day the server snapshots both scores for every name and, when the next day's prices land, computes each column's <b>rank IC</b> — the Spearman correlation between that day's ordering and the realized next-day return. Forward, out of sample, accruing from deploy; the record persists on the volume across redeploys. The <b>verdict gate</b> refuses to call a winner before 60 days or |t| ≥ 2 on the daily IC difference — the same anti-eyeball doctrine as the IS/OOS split, applied to the score itself. The live-disagreements list underneath shows which names the two columns argue about right now and <i>why</i>, so you can spot-check that MOM+ diverges for the stated mechanisms rather than just measuring that it diverges. On a locked verdict the winner keeps the column and the loser gets deleted.</p>
<div class="hlp-h">D1 retest study</div>
<p>Under the duel (build 2026.09.24-96): the Trend board's <b>D1 RETEST</b> — a stacked daily ribbon whose low probed the 13/21 zone while the close held EMA21, or the short mirror — replayed over every <b>closed</b> day the server holds, with the EMAs walked bar by bar exactly as the ladder builds them. The <b>control</b> is every stacked bar of the same side on the same names whose probe did <i>not</i> hold, so the <b>excess σ</b> column answers the real question: does the pullback beat simply being in the trend? Two choices are yours: the <b>event</b> (<i>board</i> is ladder-verbatim — the last 3 bars' extreme — so one probe fires up to three days running; <i>first touch</i> fires once per pullback) and the <b>cooldown</b> (bars before the same name and side may fire again; what it suppresses is counted). Per horizon: hit, mean, median, σ-mean, the void rate (price back to the event bar's own EMA21 — the tretest stop), the control and the excess; cells under 30 events show only their n. Daily lows exist only where the hourly spine covers (~180d equities, ~90d crypto); older bars read the close as the low, which can only under-count, and the status line prints the true-extreme share. D1 rung only — the board's other three rungs aren't replayed. Nothing here trades: the live claim is still tretest / tretestdn in the ledger. ↓ CSV exports the events.</p>`,
report:`
<div class="hlp-h">What this is</div>
<p>Everything the server already holds on one name — price structure, positioning, funding, the signal ledger's own base rates, earnings context — compiled into one prompt and synthesized by <b>Claude</b> into a plain-language read. It is a <i>reading of the board</i>, not an oracle: every number it cites is the same number the other tabs show, and the machinery around the model exists to keep it honest rather than fluent. The search box takes any ticker in either universe; a <b>focused ticker</b> or the drawer's "AI report →" deep-link opens straight to that name.</p>
<div class="hlp-h">Cached for the whole group — the cooldown IS the rate limit</div>
<p>Reports are <b>shared</b>: the first generation is cached for everyone, and the <b>regenerate</b> button unlocks only on the TTL cooldown <i>or</i> a material change (a moved mark, a fresh signal, an earnings print that invalidates the cached read). The cooldown is enforced <b>server-side</b> — the disabled button is convenience, the 429 is the gate — so no amount of clicking spends the API budget twice. The freshness line ticks live: <b class="pos">fresh · regenerate in M:SS</b>, then <b>stale</b>, or <b style="color:var(--accent)">invalidated</b> with the reason. "Generated Xm ago" is the cache age, not your session.</p>
<div class="hlp-h">The annotated chart</div>
<p>A candlestick chart with a <b>timeframe switcher</b> (D1 · H12 · H4), the <b>EMA 13/21 ribbon</b> with its band fill, and the levels the read leans on drawn as labelled lines (collision-staggered so they don't overprint). <b>Proven-edge markers</b> plot past signal fires as side-typed, colour-coded glyphs with a decoded legend — but only when the edge has earned it: ≥8 resolved roster-wide with positive average R, or ≥5 resolved at ≥60% hit for a name-specific edge. Below that bar the markers are <b>suppressed and the count disclosed</b> in the legend, never quietly shown as if proven. Every annotation is the server's own payload restated — the chart cannot disagree with the board.</p>
<div class="hlp-h">Scenarios, EV, and the plan</div>
<p>Each scenario carries a computed <b>R/R and expected value</b>, and the colour follows the <i>money</i>, not the label — an adverse-direction "target" the model mislabelled renders red. The action block is mandatory and its <b>EV-at-entry is computed server-side</b>: a plan that prices out negative is <b>downgraded to "wait"</b> before it ever reaches you, so the tab never presents a losing entry as a call. Directional reads are validated too — a short read without a correctly-sided void level and scenario is rejected, EMAs can't be smuggled in as chart levels, and an opposing-bias anchor can't override the void.</p>
<div class="hlp-h">Analyst record — the part that keeps it honest</div>
<p>Every directional read is <b>ledgered at its mark and resolved out-of-sample</b>, exactly like a Signals claim. The record shown (n, hit, average R, both overall and on this name) is <b>live</b> — it moves as claims resolve, not frozen with the report — so over time the tab grades its own past reads instead of asking you to trust the current one. Open reads count down to their horizon alongside the resolved ones.</p>`,
news:`
<div class="hlp-h">What it shows</div>
<p>Two feeds merged into one tape for the <b>xyz</b> universe: company-specific <b>headlines</b> tied to names you follow, and the <b>macro tape</b> that moves everything. Served whole to the browser and sliced client-side — the drawer's per-name news is the same payload filtered, so there's one fetch and one source of truth. Retention is <b>72h</b>; older items age off rather than accumulating into noise.</p>
<div class="hlp-h">Telegram channels — shared group config</div>
<p>The channel list is <b>group configuration, not cache</b> — it lives in its own file on the volume so a trimmed news cache can never lose it, and edits apply within seconds for everyone. Each channel shows a live status; a channel erroring out says so rather than silently contributing nothing. Attribution is best-effort: a headline is tied to a ticker only when the match verifies, and unverified items stay in the tape without a false company tag.</p>
<div class="hlp-h">Filings overlay (SEC EDGAR)</div>
<p>Regulatory filings for covered US names ride the same feed, flagged <b>FL</b>, with <b>material</b> ones marked. They join the earnings tab when a release links (see the earnings help), but here they read as the raw regulatory tape. Coverage is honest about its edges: foreign listings and non-reporting instruments (indices, ETFs, FX, synthetics) simply don't file, so their absence is real, not a gap.</p>
<div class="hlp-h">Honest caveats</div>
<p>This is a <b>tape, not a verdict</b>: it surfaces what was said and filed, not whether it matters. Relevance verification trims obvious mismatches, but a headline's presence is never a signal — the ledger and the board are where a story becomes a measurable condition. A warm cache serves the last good pull across redeploys so the tab comes back populated instead of blank while the rotation catches up.</p>`,
};
const HELP_KEYS=`<div class="hlp-h">Keyboard</div><table class="hlp-keys">
<tr><td><kbd>/</kbd></td><td>focus this tab's search</td></tr>
<tr><td><kbd>j</kbd> <kbd>k</kbd> <kbd>Enter</kbd></td><td>walk the markets table (or the conversation rail) and open the highlighted row</td></tr>
<tr><td><kbd>Esc</kbd></td><td>close the drawer, a menu, or back out a level</td></tr>
<tr><td><kbd>b</kbd> <kbd>h</kbd></td><td>back to the tab you were on before this one · home (Markets) — the ← and ⌂ buttons beside the help button</td></tr>
<tr><td><kbd>Ctrl</kbd>+<kbd>K</kbd> / <kbd>⌘</kbd>+<kbd>K</kbd></td><td>command palette — a ticker or a tab; <kbd>⇧</kbd>+<kbd>Enter</kbd> runs an AI report</td></tr>
<tr><td><kbd>~</kbd></td><td>the terminal (<code>help</code> lists its verbs)</td></tr>
<tr><td><kbd>?</kbd></td><td>this help</td></tr>
</table>`;
function openHelp(){
  const bg=el('helpbg'), m=el('helpmodal'); if(!bg||!m) return;
  const v=(state.scope==='crypto'&&!HELP[state.view])?'markets':state.view;
  // The title comes from the tab itself, so a renamed tab never says "How to read: dm".
  const tb=document.querySelector('.tab[data-view="'+v+'"]');
  const TAB_TITLES={markets:'Markets',focus:'Focus',sectors:'Sectors',corr:'Correlation',sessions:'Sessions',signals:'Signals',earnings:'Calendar',backtest:'Backtest',ematouch:'EMA Touch',housing:'Housing',liquidity:'Liquidity',treemap:'Treemap'};   // fallback for a view with no ribbon tab (the runtime treemap)
  const title=tb?tb.textContent.trim().replace(/\s*\d+\s*$/,''):(TAB_TITLES[v]||v);
  m.innerHTML=`<div class="hlp-head">How to read: ${esc(title)}<button class="btn xtiny" id="helpclose" title="close">\u2715</button></div>`
    +`<div class="hlp-sub">What each element means and \u2014 more importantly \u2014 how to interpret it. Every number in the app also explains itself on hover; this is the map. Nothing here is investment advice. <a class="hlp-docs" href="/docs#tab-${esc(v)}" target="_blank" rel="noopener" title="the complete manual \u2014 every tab, column, command, alert and setting, in a page of its own">full documentation \u2197</a></div>`
    +`<div class="hlp-guides"><a href="/docs/ref/howto" target="_blank" rel="noopener"><b>How to use this site \u2197</b><span>Every feature: what it is worth, how to use it properly, a daily routine.</span></a><a href="/docs/ref/explainer" target="_blank" rel="noopener"><b>Explainer \u2197</b><span>What each screen is for and what the numbers say, in plain words.</span></a></div>`
    +(HELP[v]||`<div class="hlp-h">${esc(title)}</div><p>${esc((tb&&tb.title)||'')||'No explainer written for this tab yet.'}</p>`)
    +HELP_KEYS;
  bg.hidden=false; m.hidden=false; m.scrollTop=0; overlayPush('help', closeHelp);
  const cb=el('helpclose'); if(cb) cb.onclick=closeHelp;
}
function closeHelp(){ overlayPop('help'); const bg=el('helpbg'), m=el('helpmodal'); if(bg)bg.hidden=true; if(m)m.hidden=true; }

export function __boot_nav_10624() {
// Short entries for the tabs that had none: pressing ? on Messages used to open the Markets text
// under the title "How to read: dm".
Object.assign(HELP,{
  dm:`<div class="hlp-h">What it is</div><p>Direct messages and topic boards between account holders. Type <b>$TICKER</b> and the message carries the mark it was sent at — read later it says "sent at 113.90 · +4.0%". <b>short / sell / fade</b> before the ticker (or <b>short / puts</b> after) makes it a short; everything else is a long. Editing rewrites the words, never the stamp.</p><div class="hlp-h">Commands</div><p>Type <b>/</b> and a terminal verb — <b>/top funding 5</b>, <b>/nvda</b>, <b>/screen rvol>2</b> — and the result posts into the conversation under your name, badged <b>computed</b>. <b>/help</b> lists what runs here (only you see it); the <b>?</b> beside the message box opens the full guide, and <b>Tab</b> completes verbs, fields and tickers. <b>/ratio A/B</b> posts the pair chart as an image. A plain-English question after the slash goes to the AI only where the operator has opened that in Admin › Features; it is admin-only by default. <b>//</b> sends a message that really starts with a slash.</p><div class="hlp-h">Calls</div><p><b>calls ↗</b> in the rail is every stamped message in one place, scored live and at fixed 1d / 7d horizons, with a per-person record. Deleting a call removes the words, never the score.</p><div class="hlp-h">Who can read this</div><p>The operator of this terminal can read every message, including conversations they are not in; every read is logged in Admin.</p>`,
  notes:`<div class="hlp-h">What it is</div><p>Your written notes, per ticker, written in the ticker drawer. Each note is stamped with the mark it was written at, so every later read carries the move since. <b>#tags</b> in the body filter the tab.</p><div class="hlp-h">Markers on Markets</div><p>A post-it in the ticker cell means a note exists: solid within 7 days, dimmed to 30, hollow after. Hover for the first line; click to open.</p>`,
  drawdown:`<div class="hlp-h">What it is</div><p>One dot per market, two numbers that every other tab shows one of but never side by side. <b>Up</b> is the <b>return since the anchor</b>: the live mark over the <b>prior close</b> — the last daily close before the anchor date, so the anchor day's own move counts. <b>Right</b> is <b>less pain</b>: the max drawdown the name took in the same window — by default <b>intraday</b>, the deepest fall from the running peak of daily highs to a later daily low; the <b>drawdown</b> toggle switches to close-to-close — with zero drawdown at the right edge. <b>Up and to the right is better</b>: more return for less pain.</p>
<div class="hlp-h">The references</div><p>The benchmarks are dashed horizontal lines at their own return — <b>BTC</b> (gold) and <b>ETH</b> (violet) in crypto scope, the <b>S&amp;P</b> and the <b>XYZ100</b> index in stocks scope — so "beat the market" and "beat it without the hole" read at once. Their dots wear the same colour.</p>
<div class="hlp-h">Return: now or best</div><p><b>now</b> (the default) is where the name sits today. <b>best</b> is the highest daily close it printed since the anchor, over the prior close — the amplitude of the excursion, which never goes below zero. The table carries both, plus <b>gave back</b> (best minus now) and <b>Best / DD</b>: above 1 the name made more than it ever gave back.</p>
<div class="hlp-h">Show top N</div><p>The chart draws the top 10, 20, 30 or 50 names by the return axis, or everyone; the references always stay. The table underneath always has the whole universe, 25 rows a page, sortable on every column — the cut is what the eye can read, not the study.</p>
<div class="hlp-h">Anchor</div><p>The presets count back from today's UTC midnight (YTD is January 1); the date box takes any day in the last year. A US name reads <b>US sessions</b>: its UTC bars are folded so a weekend or exchange holiday belongs to the next session's bar (its high, low and close), and a weekend anchor starts from Friday's close. Crypto reads calendar days. A name whose first close is well after the anchor is drawn with a dashed ring and marked <b>late</b>: it starts at its own first close, which is not the same race.</p>
<div class="hlp-h">What it is not</div><p>Tick-exact: the lows are daily candle lows, and a bar's own high never counts against its own low (the order inside a day is unknown), so a same-day spike-and-flush is under-read. Older history restored without a low reads on the close there, and the caption counts those names. Crypto history on the wire is about 90 days, so an older anchor starts every coin late and the header says how many.</p>`,
  ematouch:`<div class="hlp-h">What it is</div><p>Every name's <b>50 and 200 EMA</b> on the <b>4H</b> and <b>1D</b> candles: which are touching a line right now, and which are about to. The line is the EMA over closed candles carried to the live mark, which is what a chart draws while the candle forms. 1D is the session series on a US name (weekends and holidays fold into the next session), calendar days on crypto.</p><div class="hlp-h">Near a line</div><p>Every line within 1.5\u03c3 of the mark, nearest first. \u03c3 is that rung's own bar-return stdev (the unit the EMA200 alerts use), so 0.5\u03c3 is equally close on BTC and on GOLD; the % is beside it. The shaded band is the near zone (0.5\u03c3). <b>stacked</b> = the 50 and the 200 sit within half a sigma of each other, so one touch tests both.</p><div class="hlp-h">Feed and cooldown</div><p>A touch (the forming candle's range reaches the line) opens a card. At that candle's close the card resolves in place: <b>held</b> (closed back on the side it came from) or <b>closed through</b>. After a card the line has to <b>re-arm</b>: a close at least 1\u03c3 clear of it. Until then, later touches fold into the card as <i>retouches</i>, once per candle, so chop around a line is one card, not ten. <b>+ near</b> adds a faint line each time a name enters the 0.5\u03c3 band (out again only past 0.75\u03c3).</p><div class="hlp-h">Alerts</div><p>Four classes, each picked separately in the bell's delivery panel (operator-only while this tab soaks): <b>ma200</b> and <b>ma50</b> are close-confirmed reclaim / breakdown / bullish and bearish retests; <b>touch200</b> and <b>touch50</b> are the intrabar touches, opt-in. Nothing is announced in the first ~6 minutes after a deploy: every line seeds silently first.</p>`,
  charts:`<div class="hlp-h">What it is</div><p>Up to eight names side by side on the same timeframe. Pick tickers in the bar above; each chart shares the ladder the drawer uses.</p>`,
  treemap:`<div class="hlp-h">What it is</div><p>The universe by sector, tile area = the size measure you pick, colour = the move over the window. Click a tile to open the name.</p>`,
  funds:`<div class="hlp-h">What it is</div><p>Fund and ETF holdings from SEC filings (N-PORT, 13F) for the names in the universe — who holds what, and how that changed quarter over quarter. Filings are quarterly and lag by up to 45 days; the tab says when each was filed.</p>`,
  congress:`<div class="hlp-h">What it is</div><p>Congressional trading disclosures (PTRs) that name a ticker in the universe, parsed from the House and Senate filings. A disclosure lands up to 45 days after the trade; the filing date is shown next to the trade date.</p>`,
  insiders:`<div class="hlp-h">What it is</div><p>SEC Form 4 insider transactions for the equity names, rotated through EDGAR two names a minute. Open-market buys and sells are the signal; option exercises and 10b5-1 plans are labelled so you can discount them.</p>`,
  admin:`<div class="hlp-h">What it is</div><p>Operator surface: accounts and invites, feature visibility ("Everyone / Operators / Hidden"), the alert delivery state for every member, the read-through audit log, and the boot/loop diagnostics.</p>`,
});
{ const hb=el('helpBtn'); if(hb) hb.addEventListener('click',openHelp);
  const bg=el('helpbg'); if(bg) bg.addEventListener('click',closeHelp); }   // Escape: overlay stack (core.js)
}


// ===== Command palette (⌘K / Ctrl+K) — jump to any ticker's drawer or AI report, or any tab =====
// Reuses the same universe-validated matcher the AI-report search uses, so a name that isn't in the
// live universe can't be jumped to. Results are: matching tabs first, then matching tickers. Enter
// opens the ticker's drawer; Shift+Enter opens its AI report; a tab row switches tabs.
const CMDK_TABS=[
  {v:'markets',label:'Markets'},{v:'focus',label:'Focus'},{v:'funds',label:'Funds'},{v:'trend',label:'Trend'},{v:'charts',label:'Charts'},{v:'sectors',label:'Sectors'},{v:'drawdown',label:'Drawdown'},
  {v:'corr',label:'Correlation'},{v:'funding',label:'Funding'},{v:'sessions',label:'Sessions'},{v:'signals',label:'Signals'},
  {v:'earnings',label:'Earnings'},{v:'news',label:'News'},{v:'report',label:'AI Report'},
  {v:'actionable',label:'Actionable'},{v:'backtest',label:'Backtest'},{v:'ematouch',label:'EMA Touch'},{v:'housing',label:'Housing'},{v:'liquidity',label:'Liquidity'},
  {v:'congress',label:'Congress'},{v:'insiders',label:'Insiders'},{v:'admin',label:'Admin'}];
// The ribbon is the source of truth at run time: every tab under the name it actually shows (the
// literal above omitted Messages, Notes and Treemap and called Calendar "Earnings"), with the
// literal's labels kept as aliases so "earnings" still finds Calendar.
function cmdkTabs(){
  const out=[], seen=new Set();
  document.querySelectorAll('nav.tabs .tab[data-view]').forEach(t=>{ const v=t.dataset.view, label=t.textContent.trim().replace(/\s*\d+\s*$/,''); if(v&&label&&!seen.has(v)){ seen.add(v); const alias=(CMDK_TABS.find(x=>x.v===v)||{}).label; out.push({v,label,alias:alias&&alias!==label?alias:undefined}); } });
  for(const t of CMDK_TABS) if(!seen.has(t.v)){ seen.add(t.v); out.push(t); }
  return out;
}
let _cmdkSel=0, _cmdkRows=[];
function openCmdk(){ const bg=el('cmdkbg'), m=el('cmdk'), q=el('cmdk-q'); if(!bg||!m||!q) return;
  bg.hidden=false; m.hidden=false; q.value=''; cmdkRender(''); q.focus(); overlayPush('cmdk', closeCmdk);
  requestAnimationFrame(()=>q.focus()); }
function closeCmdk(){ overlayPop('cmdk'); const bg=el('cmdkbg'), m=el('cmdk'); if(bg)bg.hidden=true; if(m)m.hidden=true; _cmdkRows=[]; }
function cmdkOpen(){ const m=el('cmdk'); return m&&!m.hidden; }
function cmdkRender(qs){ const list=el('cmdk-list'); if(!list) return;
  qs=(qs||'').trim();
  // Cmd+K is a THIRD way into a view, independent of the nav strip. Filtering here is not cosmetic:
  // without it a gated tab stays reachable by name even with its button gone.
  const tabHits=qs?cmdkTabs().filter(t=>tabVisible(t.v)&&(t.label.toLowerCase().includes(qs.toLowerCase())||(t.alias||'').toLowerCase().includes(qs.toLowerCase())||t.v.includes(qs.toLowerCase()))):cmdkTabs().filter(t=>tabVisible(t.v));
  const mk=aiMatches(qs).slice(0,8);
  _cmdkRows=[];
  let html='';
  if(tabHits.length){ html+='<div class="cmdk-sec">Tabs</div>';
    tabHits.forEach(t=>{ _cmdkRows.push({kind:'tab',v:t.v});
      html+=`<div role="button" tabindex="0" class="cmdk-row" data-i="${_cmdkRows.length-1}"><span class="ic">▸</span><span class="nm">${esc(t.label)}</span></div>`; }); }
  if(mk.length){ html+='<div class="cmdk-sec">Tickers</div>';
    mk.forEach(r=>{ _cmdkRows.push({kind:'ticker',coin:r.coin});   // aiMatches returns rows, not {r} wrappers — the destructure threw on every keystroke and the palette never listed a ticker
      const uni=r.uni==='main'?'crypto':'stocks';
      const px=r.px!=null&&isFinite(r.px)?fmtPrice(r.px):'';
      html+=`<div role="button" tabindex="0" class="cmdk-row" data-i="${_cmdkRows.length-1}"><span class="ic">◎</span><span class="tk">${esc(r.ticker||r.coin)}</span><span class="u">${uni}</span>${px?`<span class="px">${px}</span>`:''}</div>`; }); }
  if(!_cmdkRows.length) html=`<div class="cmdk-none">${qs?'No ticker or tab matches':'Type a ticker symbol, or a tab name'}</div>`;
  list.innerHTML=html;
  _cmdkSel=0; cmdkPaint();
  list.querySelectorAll('.cmdk-row').forEach(row=>{
    row.addEventListener('mousemove',()=>{ _cmdkSel=+row.dataset.i; cmdkPaint(); });
    row.addEventListener('click',(e)=>cmdkActivate(+row.dataset.i, e.shiftKey)); }); }
function cmdkPaint(){ const list=el('cmdk-list'); if(!list) return;
  list.querySelectorAll('.cmdk-row').forEach(row=>row.classList.toggle('sel',+row.dataset.i===_cmdkSel));
  const sel=list.querySelector('.cmdk-row.sel'); if(sel) sel.scrollIntoView({block:'nearest'}); }
function cmdkActivate(i, report){ const row=_cmdkRows[i]; if(!row) return; closeCmdk();
  if(row.kind==='tab'){ showView(row.v); return; }
  if(row.kind==='ticker'){ if(report) openAiReport(row.coin);
    else { showView('markets'); openDetail(row.coin); } } }

export function __boot_nav_10845() {
{ const q=el('cmdk-q'), bg=el('cmdkbg');
  if(bg) bg.addEventListener('click',closeCmdk);
  if(q){ q.addEventListener('input',()=>{ usageSearch('header.search'); cmdkRender(q.value); });   // (build 2026.09.24-112) a typing burst counted, never the text
    q.addEventListener('keydown',e=>{   // Escape bubbles to the overlay stack, which closes the palette as its top layer
      if(e.key==='ArrowDown'){ e.preventDefault(); if(_cmdkRows.length){ _cmdkSel=(_cmdkSel+1)%_cmdkRows.length; cmdkPaint(); } return; }
      if(e.key==='ArrowUp'){ e.preventDefault(); if(_cmdkRows.length){ _cmdkSel=(_cmdkSel-1+_cmdkRows.length)%_cmdkRows.length; cmdkPaint(); } return; }
      if(e.key==='Enter'){ e.preventDefault(); cmdkActivate(_cmdkSel, e.shiftKey); } }); }
  document.addEventListener('keydown',e=>{
    if((e.metaKey||e.ctrlKey)&&(e.key==='k'||e.key==='K')){ e.preventDefault(); cmdkOpen()?closeCmdk():openCmdk(); } }); }
{ const shq=el('sighist-q');   // claim-history browser on the Signals tab (static markup — survives signals-body re-renders)
  if(shq) shq.addEventListener('input',()=>{ usageSearch('signals.search'); clearTimeout(G._shTimer); G._shTimer=setTimeout(runSigHist,250); });
  const she=el('sighist-ev');
  if(she){ for(const ev of Object.keys(EV_LABELS)){ const o=document.createElement('option'); o.value=ev; o.textContent=EV_LABELS[ev]; she.appendChild(o); }
    she.addEventListener('change',runSigHist); } }
el('corrsearch').addEventListener('input',e=>{ usageSearch('corr.search'); state.corr.search=e.target.value; state.corr.selected=null; state.corr.pair=null;
  clearTimeout(corrSearchT); corrSearchT=setTimeout(()=>{ if(!el('view-corr').hidden) openCorr(); },300); });
el('mktExport').addEventListener('click', exportMarkets);
el('corrExport').addEventListener('click', exportCorr);
}

export { HELP, HELP_KEYS, TAB_GROUPS, applyKsel, applyMobileCols, applyNumFilters, applyTabOrder, applyTabVisibility, buildTabGroups, closeHelp, closeTabMenus, forceRefresh, openRuleFor, scheduleDaily, setWindow, startCycle, startEvents, syncTabGroups, updateFocusChip, warmCount, wireTabDrag };
