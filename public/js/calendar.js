// calendar.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { featureOn } from "./admin.js";
import { pushToast } from "./alerts.js";
import { setScope, showView } from "./backtest.js";
import { DAY, G, el, esc, safeHref, state } from "./core.js";
import { fetchJSON } from "./data.js";
import { render } from "./markets.js";
import { earnSetupDrawerHtml, renderEarnings } from "./notes.js";
import { fillDrawerNews, fmtAge, renderNews, renderSignals } from "./trend.js";


// ===== signals tab =====
// Server-ranked live conditions. Each row = a condition on one market + that market's OWN
// historical base rate for the same event (median forward return, hit rate, n). Anything with
// n < 8 wears an "unproven" badge instead of being hidden or oversold.
let _sigLast=0;
let _newsLast=0, tgChans=null;

export function __boot_calendar_7810() {
}

const SEC_SHORT={'Information Technology':'Info Tech','Consumer Discretionary':'Cons Disc','Communication Services':'Comms','Consumer Staples':'Staples','Health Care':'Health','Real Estate':'Real Est'};
function secShort(s){ return SEC_SHORT[s]||s; }
async function loadNews(){
  try{ const d=await fetchJSON('/api/news'); _newsLast=Date.now();
    if(d&&Array.isArray(d.items)){ state.news=d; if(state.view==='news') renderNews(); if(state.detail) fillDrawerNews(); }
  }catch(_){/* the tab shows the last good payload; the freshness stamp tells the truth */}
}
function openNews(){ renderNews(); if(Date.now()-_newsLast>60*1000) loadNews(); }
async function loadTgChannels(){
  try{ tgChans=await fetchJSON('/api/news/channels'); }catch(_){ tgChans={channels:[],max:12}; }
  if(state.view==='news') renderNews();
}
async function saveTgChannels(list){
  try{
    const r=await fetch('/api/news/channels',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({channels:list})});
    const d=await r.json();
    if(!r.ok){ pushToast('channels: '+(d&&d.error||('HTTP '+r.status))); }
    await loadTgChannels();
    setTimeout(loadNews, 2500);   // the immediate server-side fetch lands within a couple of seconds
  }catch(_){ pushToast('channels: save failed'); }
}
async function loadSignals(){
  try{ const d=await fetchJSON('/api/signals'); _sigLast=Date.now();
    if(d&&Array.isArray(d.signals)){ state.signals=d;
      setSigTabBadge();
      if(!el('view-signals').hidden) renderSignals(); }
  }catch(_){}
}
function setSigTabBadge(){
  const tb=el('tab-signals'), d=state.signals; if(!tb) return;
  // Scoped: the badge speaks for the universe on screen. countU carries the true per-universe
  // live-condition totals (kept, not the capped transport slice), so the number moves with reality.
  // Falls back to the whole-engine count only on a payload predating countU.
  const u = state.scope==='crypto' ? 'm' : 'x';
  const cu = d&&d.countU&&d.countU[u]!=null ? d.countU[u] : (d?(d.count||0):0);
  const n = cu||0;
  tb.textContent = n>0 ? `Signals (${n})` : 'Signals';
}
function openSignals(){ renderSignals(); if(Date.now()-_sigLast>30*1000) loadSignals(); }
// Scope guard (2026.08.03-02): the server never ships a hidden universe's rows, so a viewer parked
// in that universe would see an empty board with no explanation. Rather than mount an "unavailable"
// state (the hidden slice must not advertise itself), flip the global scope to the visible universe
// when a scoped tab renders — the pill and every scoped panel simply live where the data is.
// featureOn reads the SERVER-resolved set (never re-derived); both scopes hidden is unreachable
// here because the parent tab self-demotes server-side first. Returns true when it flipped: the
// caller must bail, setScope's applyScope has already re-entered the renderer in the visible scope.
function scopeGuard(parent){
  const cur=state.scope==='crypto'?'cx':'eq', other=cur==='cx'?'eq':'cx';
  if(!featureOn(parent+'.'+cur) && featureOn(parent+'.'+other)){ setScope(other==='cx'?'crypto':'stocks'); return true; }
  return false;
}


// ===== earnings calendar =====
// Server-fetched (Finnhub, 6h refresh, /data warm cache) and filtered server-side to the xyz
// equity universe. "Today"/"tomorrow" are ET CALENDAR DAYS — BMO/AMC are ET concepts, so the
// bucket must not flip at the viewer's local midnight.
let _earnLast=0;
const _etDayFmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
function etDayStrC(ms){ return _etDayFmt.format(ms!=null?ms:Date.now()); }
function earnDiffC(dateStr){ if(!/^\d{4}-\d{2}-\d{2}$/.test(dateStr||'')) return null;
  const a=Date.UTC(+dateStr.slice(0,4),+dateStr.slice(5,7)-1,+dateStr.slice(8,10));
  const t=etDayStrC(); const b=Date.UTC(+t.slice(0,4),+t.slice(5,7)-1,+t.slice(8,10));
  return Math.round((a-b)/DAY); }
function earnFilingHtml(e){
  if(!e||!e.filing) return '';
  const f=e.filing;
  return `<a class="earn-fl${/^8-K/.test(f.form)?' mat':''}" href="${esc(safeHref(f.url))}" target="_blank" rel="noopener noreferrer" data-tip="${esc('the actual filing on EDGAR \u2014 '+f.form+(/^8-K/.test(f.form)?' (the earnings release itself)':' (the report)')+' \u00b7 filed '+fmtAge(Date.now()-f.pub)+' ago')}">${esc(f.form)} \u2197</a>`;
}
function earnSessLbl(s){ return s==='BMO'?'pre-market (BMO)':s==='AMC'?'after close (AMC)':s==='DMH'?'during market hours':'time TBD'; }
async function loadEarnings(){
  _earnLast=Date.now();
  try{ const d=await fetchJSON('/api/earnings');
    if(d&&Array.isArray(d.entries)){ state.earnPayload=d;
      const m=new Map();
      for(const e of d.entries){ let a=m.get(e.t); if(!a){a=[];m.set(e.t,a);} a.push(e); }   // server ships date-sorted
      state.earn=m;
      wireMacroStrip(); renderMacroStrip();   // the banner rides this payload — every tab, both scopes
      if(el('view-earnings')&&!el('view-earnings').hidden) renderEarnings();
      render();   // paint/refresh the E badges without waiting for the next snapshot cycle
    }
  }catch(_){}
}
// Pre-earnings setup cards (build 2026.09.24-100): their own payload, pulled beside the calendar
// and on a shorter leash (positioning moves; the server rebuilds at most once a minute and 304s
// an unchanged body). Feeds the Setups strip on the tab and the drawer section — an open drawer
// on a carded name is filled in place, so a pull that lands after the drawer opened still shows.
let _setupLast=0;
async function loadEarnSetups(){
  _setupLast=Date.now();
  try{ const d=await fetchJSON('/api/earnings/setups');
    if(d&&Array.isArray(d.cards)){ state.earnSetups=d;
      const m=new Map(); for(const c of d.cards) m.set(c.t,c); state.earnSetupMap=m;
      if(el('view-earnings')&&!el('view-earnings').hidden) renderEarnings();
      const ds=el('dsetup'), r=state.detail?state.rows.get(state.detail):null;
      if(ds&&r){ const tmp=document.createElement('div'); tmp.innerHTML=earnSetupDrawerHtml(r); const nx=tmp.firstElementChild; if(nx) ds.replaceWith(nx); }
    }
  }catch(_){}
}
// Nearest upcoming report for a ticker: {diff, e}. Past entries (stale cache mid-window) skipped.
function earnNext(t){ const a=state.earn&&state.earn.get(t); if(!a) return null;
  for(const e of a){ const d=earnDiffC(e.d); if(d!=null&&d>=0) return {diff:d,e}; } return null; }
// ===== macro calendar (client) =====
// Universe-wide scheduled binaries (FOMC + FRED prints) ride the earnings payload. State is
// derived HERE on the ET clock — mirroring the server's macroEntryState — so a row flips at
// 8:30 / 14:00 ET between the <=10-min pulls, not whenever the server happens to refresh.
const _etHmFmt=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false});
function macroStateC(e){ if(!e||!e.d) return 'upcoming'; if(e.actual!=null) return 'released';
  const df=earnDiffC(e.d); if(df==null) return 'upcoming'; if(df<0) return 'released'; if(df>0) return 'upcoming';
  const parts=_etHmFmt.format(Date.now()).split(':'); let h=+parts[0]; if(h===24) h=0;
  const hh=+(e.tEt||'08:30').slice(0,2), mm=+(e.tEt||'08:30').slice(3,5);
  return (h>hh||(h===hh&&+parts[1]>=mm))?'released':'upcoming'; }
function macroList(){ const d=state.earnPayload; return d&&Array.isArray(d.macro)?d.macro:[]; }
function macroNextC(){ let best=null;
  for(const e of macroList()){ if(macroStateC(e)!=='upcoming') continue; const df=earnDiffC(e.d);
    if(df==null||df<0) continue; if(!best||df<best.diff||(df===best.diff&&(e.tEt||'')<(best.e.tEt||''))) best={diff:df,e}; }
  return best; }
function macroRecentC(){ let best=null;
  for(const e of macroList()){ if(macroStateC(e)!=='released') continue; const df=earnDiffC(e.d);
    if(df==null||df<-2) continue; if(!best||e.d>best.e.d||(e.d===best.e.d&&(e.tEt||'')>(best.e.tEt||''))) best={diff:df,e}; }
  return best; }
function macroTimeLbl(e){ const hh=+(e.tEt||'08:30').slice(0,2);
  return hh>=13?((hh-12)+':'+(e.tEt||'').slice(3)+' PM ET'):(hh+':'+(e.tEt||'08:30').slice(3)+' AM ET'); }
function macroRangeFmt(s){ return s&&s.lo!=null?`${(+s.lo).toFixed(2)}\u2013${(+s.hi).toFixed(2)}%`:''; }
function macroStatFmt(e,s){ if(!s) return '';
  const sg=(v)=>v>0?'+'+v:''+v;
  if(e.k==='FOMC') return `target <b>${macroRangeFmt(s)}</b>`;
  if(e.k==='CPI'||e.k==='PCE') return `YoY <b>${s.yoy}%</b>${s.core!=null?` \u00b7 core <b>${s.core}%</b>`:''}`;
  if(e.k==='NFP') return `<b>${sg(s.chgK)}k</b>${s.unemp!=null?` \u00b7 unemp <b>${s.unemp}%</b>`:''}`;
  if(e.k==='PPI') return `YoY <b>${s.yoy}%</b>`;
  if(e.k==='RETAIL') return `MoM <b>${sg(s.mom)}%</b>`;
  if(e.k==='GDP') return `QoQ SAAR <b>${sg(s.qoq)}%</b>`;
  return ''; }
function macroMonthLbl(m){ if(!m||!/^\d{4}-\d{2}/.test(m)) return '';
  return new Date(m+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'short',timeZone:'UTC'}); }
// Row value cell: upcoming = prior as reference (labeled by month — the prior PRINT, never a
// consensus; none exists in this feed); released = prior -> actual, or the honest pending state
// between the ET clock flip and FRED's data landing.
function macroValHtml(e){
  const st=macroStateC(e);
  if(e.k==='FOMC'){
    if(st==='released'){
      if(e.actual){ const held=e.prior&&e.prior.lo===e.actual.lo&&e.prior.hi===e.actual.hi;
        return held?`<b>held ${macroRangeFmt(e.actual)}</b>`
          :`${macroRangeFmt(e.prior)} \u2192 <b>${macroRangeFmt(e.actual)}</b> (${+e.actual.hi<+e.prior.hi?'cut':'hiked'})`; }
      return `<span class="macro-pend" data-tip="the statement is out (2:00 PM ET has passed) but the daily target-range series hasn\u2019t landed the new value yet \u2014 fills on the next FRED pass, typically within the hour">released \u2014 range pending (FRED lag)</span>`;
    }
    return `${macroStatFmt(e,e.prior)}${e.prior?' <span class="sec">(going in)</span>':''} \u00b7 presser 2:30`;
  }
  if(st==='released'){
    if(e.actual) return `${e.prior?macroStatFmt(e,e.prior).replace(/<\/?b>/g,'')+' \u2192 ':''}${macroStatFmt(e,e.actual)}${e.actual.m?` <span class="sec">(${macroMonthLbl(e.actual.m)})</span>`:''}`;
    return `<span class="macro-pend" data-tip="the release clock has passed but the series hasn\u2019t updated on FRED yet \u2014 the actual fills on the next pass, typically within the hour">released \u2014 actual pending (FRED lag)</span>`;
  }
  return e.prior?`prior ${macroStatFmt(e,e.prior)}${e.prior.m?` <span class="sec">(${macroMonthLbl(e.prior.m)})</span>`:''}`:'<span class="sec">\u2014</span>';
}
function macroRowHtml(e,extra){
  const tip=e.k==='FOMC'
    ?`FOMC \u2014 statement 2:00 PM ET, presser 2:30.${e.sep?' SEP / dot-plot meeting.':' No SEP at this meeting.'} Prior = the target range going in. Universe-wide \u2014 applies to crypto exactly as to equities.`
    :`${esc(e.label)} \u2014 scheduled ${macroTimeLbl(e)} (source schedule via FRED; the agency can reschedule). Prior = the previous print, labeled by reference month \u2014 NOT a consensus estimate; no street consensus exists in this feed. Universe-wide \u2014 applies to crypto exactly as to equities.`;
  return `<div class="earn-row mrow${extra||''}">`
    +`<span class="earn-mk" data-tip="${esc(tip)}">${esc(e.k)}</span>`
    +(e.sep?`<span class="earn-mk sepchip" data-tip="Summary of Economic Projections \u2014 dot plot at this meeting (Mar / Jun / Sep / Dec)">SEP</span>`:'')
    +`<span class="macro-nm">${esc(e.label)}</span>`
    +`<span class="earn-sess">${macroTimeLbl(e)}</span>`
    +`<span class="sec" style="flex:1">${macroValHtml(e)}</span>`
    +`</div>`;
}
// The global strip: next macro event when it lands today/tomorrow (ET) — amber; once released,
// the result strip (blue) for the rest of the ET day. Every tab, both scopes; click -> Calendar.
function renderMacroStrip(){
  const box=el('macrostrip'); if(!box) return;
  const tab=el('tab-calendar');
  const rec=macroRecentC(), nxt=macroNextC();
  let h='', cls='macrostrip';
  if(rec&&rec.diff===0){
    cls+=' result';
    const e=rec.e;
    h=`<span class="ms-g">\u25c6</span><span><b>${esc(e.label)}</b> <span class="ms-when">released ${macroTimeLbl(e)}</span> <span class="sec2">\u00b7</span> <span class="sec2">${macroValHtml(e)}</span></span>`;
  } else if(nxt&&nxt.diff<=2){
    const e=nxt.e;
    let when=nxt.diff===0?'today':nxt.diff===1?'tomorrow':macroDayLbl(e.d);
    let lead=esc(e.label);
    if(e.k==='FOMC'&&e.d1){ const d1f=earnDiffC(e.d1);
      if(d1f===1){ lead='FOMC meeting begins'; when='tomorrow'; }
      else if(d1f===0){ lead='FOMC meeting underway'; when='day 1 of 2'; } }
    h=`<span class="ms-g">\u26a0</span><span><b>${lead}</b> <span class="ms-when">${when}</span> <span class="sec2">\u00b7 ${e.k==='FOMC'?`decision ${macroDayLbl(e.d)}, ${macroTimeLbl(e)}`:`${macroDayLbl(e.d)}, ${macroTimeLbl(e)}`}${e.prior?` \u00b7 ${macroValHtml(e).replace(/<[^>]+>/g,'')}`:''}</span></span>`;
  }
  if(h){ box.className=cls; box.innerHTML=h; box.hidden=false;
    if(tab&&!tab.querySelector('.tabdot')) tab.insertAdjacentHTML('beforeend','<span class="tabdot"></span>');
  } else { box.hidden=true; const d=tab&&tab.querySelector('.tabdot'); if(d) d.remove(); }
}
function macroDayLbl(d){ return new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}); }
function wireMacroStrip(){ const box=el('macrostrip');
  if(box&&!box._w){ box._w=true; box.addEventListener('click',()=>showView('earnings')); } }
// Markets-table badge: solid = reports TODAY, hollow = tomorrow (ET). Nothing beyond that —
// the tab carries the full window; the table only flags what can hit the next session.
function earnBadge(r){
  if(state.scope==='crypto'||!state.earn) return '';
  const p=earnNext(r.ticker); if(!p||p.diff>1) return '';
  if(p.diff===0&&p.e.epsA!=null){
    // Reported: the badge flips from schedule to scoreboard \u2014 verdict + the tape's reaction.
    const beat=p.e.eps!=null?(p.e.epsA>p.e.eps?'beat':p.e.epsA<p.e.eps?'missed':'in line'):null;
    const dm=r.d1!=null&&isFinite(r.d1)?` \u00b7 day ${r.d1>=0?'+':''}${r.d1.toFixed(1)}%`:'';
    return `<i class="eb eb0" title="Reported TODAY (${earnSessLbl(p.e.s)}) \u00b7 EPS ${p.e.epsA}${p.e.eps!=null?` vs ${p.e.eps} est (${beat})`:''}${dm}">E</i>`;
  }
  const eps=p.e.eps!=null?` \u00b7 EPS est ${p.e.eps}`:'';
  return `<i class="eb ${p.diff===0?'eb0':'eb1'}" title="Earnings ${p.diff===0?'TODAY':'tomorrow'} \u00b7 ${earnSessLbl(p.e.s)}${eps} \u00b7 ${p.e.d} (ET calendar day)">E</i>`;
}
function openEarnings(){ renderEarnings(); if(Date.now()-_earnLast>60*1000) loadEarnings(); if(Date.now()-_setupLast>60*1000) loadEarnSetups(); }
export { _earnLast, _newsLast, _setupLast, _sigLast, earnBadge, earnDiffC, earnFilingHtml, earnNext, earnSessLbl, etDayStrC, loadEarnSetups, loadEarnings, loadNews, loadSignals, loadTgChannels, macroDayLbl, macroList, macroNextC, macroRangeFmt, macroRowHtml, macroStatFmt, macroStateC, macroTimeLbl, openEarnings, openNews, openSignals, renderMacroStrip, saveTgChannels, scopeGuard, secShort, setSigTabBadge, tgChans };
