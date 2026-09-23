// triggers.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { alertText, buildAlertsPanel, pushToast, saveAlerts, tickerOf, updateBell } from "./alerts.js";
import { showView } from "./backtest.js";
import { el, esc, fmtPrice, state, store } from "./core.js";
import { fetchJSON } from "./data.js";
import { openDetail } from "./drawer.js";
import { aiPick } from "./report.js";
import { fmtAge } from "./trend.js";


// ===== trigger alerts (browser transport) =====
// This is a TRANSPORT, not a detector. The poller owns detection: it decides what counts as a new
// trigger, dedups it, persists the announced set across restarts and hands out a sequenced stream.
// All this file does is advance a cursor and decide whether THIS channel wants to interrupt you.
// A Telegram bot is the same consumer with a different cursor and its own thresholds — which is
// why none of the logic below is about what a setup is, only about how to show one.
const TSEQ='xyzmon.trig.seq';
function trigSeqGet(){ const v=parseInt(store.get(TSEQ)||'',10); return isFinite(v)?v:null; }
function trigSeqSet(n){ try{ store.set(TSEQ,String(n)); }catch(_){} }
// Mirror of the server's compute.trigEligible. Kept deliberately simple and in one place so the
// board and the alert can't disagree about which setups are worth surfacing.
function trigEligibleClient(ev,c){
  if(!ev) return false;
  if((ev.kind||'setup')!=='setup') return false;   // ops events ride the same ring; they get their own presentation
  if(c.minEV!=null && (ev.evR==null || ev.evR<c.minEV)) return false;
  if(c.minRR!=null && !(ev.rr && ev.rr.gross>=c.minRR)) return false;
  if(c.maxLate!=null && ev.late!=null && ev.late>c.maxLate) return false;
  if(Array.isArray(c.cls) && c.cls.length && !c.cls.includes(ev.cls)) return false;
  if(Array.isArray(c.muted) && c.muted.includes(ev.coin)) return false;
  return true;
}
async function loadTriggers(){
  // Deliberately NOT gated on A.trig.on. That toggle governs whether a new SETUP interrupts you;
  // it was never meant to decide whether ops events, void hits and resolutions are recorded at
  // all. Gating the whole pull on it meant a user who turned setup toasts off silently lost the
  // bell log too.
  const A=state.alerts;
  const cur=trigSeqGet();
  try{
    const d=await fetchJSON('/api/triggers'+(cur!=null?('?since='+cur):''));
    if(!d||!Array.isArray(d.events)) return;
    // The display list is adopted WHOLESALE from the server on every pull, cursor or no cursor.
    // That is what makes the panel show what fired overnight: the ring is the record, this tab is
    // just a window onto it.
    if(Array.isArray(d.recent)) A.feed=d.recent.slice().reverse();
    if(d.alertVer!=null) A.alertVer=d.alertVer;
    // First run on this device: adopt the server's high-water mark WITHOUT firing — but the feed
    // has already been taken above, so the panel still opens onto real history rather than blank.
    if(cur==null){ trigSeqSet(d.seq||0);
      // …and start the badge clean: forty retained events are history, not forty things you have
      // not read yet.
      if(!A.seenSeq){ A.seenSeq=d.seq||0; saveAlerts(); }
      updateBell(); if(!el('alertpop').hidden) buildAlertsPanel(); return; }
    for(const ev of d.events){
      // Per event: one malformed row used to throw out of the loop, skip trigSeqSet, and replay
      // the whole window (repeat toasts) on every alertVer bump.
      try{
        const k=ev.kind||'setup';
        if(k==='ops'){ fireOps(ev); continue; }
        if(k==='ledger'){ fireLedger(ev); continue; }
        // Kind -> channel. Only setup events used to toast; a member's own `NVDA px > 120` rule
        // crossing while they watched produced nothing but a bell count. ALERT_CHANNELS is also
        // what the Delivery fold renders, so the matrix on screen is the one the code runs.
        if(ALERT_CHANNELS[k]&&ALERT_CHANNELS[k].toast){ fireGeneric(ev); continue; }
        if(k!=='setup'){ updateBell(); if(!el('alertpop').hidden) buildAlertsPanel(); continue; }
        if(A.trig.on && trigEligibleClient(ev,A.trig)) fireTrigger(ev);
      }catch(_){ /* this event is broken, the batch is not */ }
    }
    if(d.seq!=null) trigSeqSet(d.seq);
  }catch(_){ /* cursor unadvanced — the next poll retries the same window, nothing is lost */ }
}
// INTERRUPT only. The event is already in A.feed (server truth) by the time this runs, so nothing
// here writes to a log — a second copy is exactly how the badge, the panel and the toast used to
// be able to disagree about what had happened.
// Which client channels each server event kind reaches. Telegram/push are per-recipient class
// choices made in the Delivery fold; this is the in-tab half of the same matrix.
const ALERT_CHANNELS={
  setup:{toast:true,bell:true,tg:true,push:true,note:'subject to your trigger thresholds'},
  rule:{toast:true,bell:true,tg:true,push:true,note:'your own metric rules'},
  trend:{toast:true,bell:true,tg:true,push:false},
  ma200:{toast:true,bell:true,tg:true,push:false},
  ledger:{toast:true,bell:true,tg:true,push:false,note:'toast on a void hit only'},
  ops:{toast:false,bell:true,tg:true,push:false,note:'toast on a warning only'},
  filing:{toast:false,bell:true,tg:true,push:false},
  earnings:{toast:false,bell:true,tg:true,push:false},
  macro:{toast:false,bell:true,tg:true,push:false},
  ai:{toast:false,bell:true,tg:true,push:false},
  regime:{toast:false,bell:true,tg:true,push:false},
  coverage:{toast:false,bell:true,tg:false,push:false},
};
function alertMatrixHtml(){
  const y='<span class="pos">●</span>', n='<span class="faint">·</span>';
  return `<table class="amx"><thead><tr><th>event</th><th>toast</th><th>bell</th><th>telegram</th><th>push</th></tr></thead><tbody>`
    +Object.keys(ALERT_CHANNELS).map(k=>{ const c=ALERT_CHANNELS[k];
      return `<tr><td>${esc(k)}${c.note?` <span class="sec">${esc(c.note)}</span>`:''}</td><td>${c.toast?y:n}</td><td>${c.bell?y:n}</td><td>${c.tg?y:n}</td><td>${c.push?y:n}</td></tr>`; }).join('')
    +`</tbody></table>`;
}
// Rule / trend / MA200 events: a card with the event text and one action — open the name.
function fireGeneric(ev){
  const A=state.alerts;
  updateBell();
  const w=el('toastwrap');
  if(w){
    const t=document.createElement('div'); t.className='toast toast-trig';
    const lbl=(ev.kind||'alert').toUpperCase();
    t.innerHTML=`<div class="tt-h"><span class="tt-lbl">${esc(lbl)}</span><span class="ax" data-x="1" title="dismiss">✕</span></div>`
      +`<div class="tt-n">${esc(alertText(ev))}</div>`
      +(ev.coin&&state.rows.has(ev.coin)?`<div class="tt-a"><button class="btn" data-open="1">Open ${esc(ev.t||tickerOf(ev.coin))} →</button></div>`:'');
    t.querySelector('[data-x]').addEventListener('click',()=>t.remove());
    const o=t.querySelector('[data-open]'); if(o) o.addEventListener('click',()=>{ t.remove(); showView('markets'); openDetail(ev.coin); });
    w.appendChild(t);
    setTimeout(()=>{ if(!t.isConnected) return; t.style.transition='opacity .3s'; t.style.opacity='0'; setTimeout(()=>t.remove(),300); }, 15000);
  }
  if(A.notify && typeof Notification!=='undefined' && Notification.permission==='granted'){
    try{ new Notification('Milst Screener — '+(ev.kind||'alert'),{body:alertText(ev)}); }catch(_){} }
  if(!el('alertpop').hidden) buildAlertsPanel();
}
function fireTrigger(ev){
  const A=state.alerts;
  updateBell(); pushTrigToast(ev);
  if(A.notify && typeof Notification!=='undefined' && Notification.permission==='granted'){
    try{ new Notification('Milst Screener — new trigger',{body:alertText(ev)}); }catch(_){} }
  if(!el('alertpop').hidden) buildAlertsPanel();
}
// Richer than pushToast's one-liner: a trigger is only useful with its geometry attached, and the
// two actions that matter (go read it / stop telling me about this name) are one click away.
function pushTrigToast(ev){
  const w=el('toastwrap'); if(!w) return;
  const t=document.createElement('div'); t.className='toast toast-trig';
  const sideCls=ev.side==='long'?'pos':'neg';
  const late=ev.late==null?'—':((ev.late>=0?'+':'')+ev.late.toFixed(2)+'R');
  const lateCls=ev.late==null?'sec':(ev.late<=0?'pos':(ev.late>0.5?'warn':'sec'));
  t.innerHTML=`<div class="tt-h"><span class="tt-lbl">NEW TRIGGER</span><span class="ax" data-x="1" title="dismiss">✕</span></div>`
    +`<div class="tt-n"><b class="${sideCls}">${esc(ev.t)}</b> <span class="${sideCls}">${esc(String(ev.side||'').toUpperCase())}</span> <span class="sec">${esc(ev.label)}</span></div>`
    +`<div class="tt-g">fired ${fmtPrice(ev.fired)} · void ${fmtPrice(ev.void)} · target ${fmtPrice(ev.target)}</div>`
    +`<div class="tt-g">R:R ${ev.rr&&ev.rr.gross!=null?(+ev.rr.gross).toFixed(2):'—'} at fire · EV ${ev.evR!=null?((ev.evR>=0?'+':'')+(+ev.evR).toFixed(2)+'R'):'no record'} · late <span class="${lateCls}">${late}</span></div>`
    +(ev.earn?`<div class="tt-w">⚠ earnings ${ev.earn.days}d out — inside the ${ev.horizonD}d horizon</div>`:'')
    +`<div class="tt-a"><button class="btn" data-rep="1">AI report →</button><button class="btn" data-mute="1">Mute ${esc(ev.t)}</button></div>`;
  t.querySelector('[data-x]').addEventListener('click',()=>t.remove());
  t.querySelector('[data-rep]').addEventListener('click',()=>{ t.remove(); showView('report'); aiPick(ev.coin); });
  t.querySelector('[data-mute]').addEventListener('click',()=>{ const A=state.alerts;
    if(!A.trig.muted.includes(ev.coin)) A.trig.muted.push(ev.coin);
    saveAlerts(); t.remove(); if(!el('alertpop').hidden) buildAlertsPanel(); });
  w.appendChild(t);
  setTimeout(()=>{ if(!t.isConnected) return; t.style.transition='opacity .3s'; t.style.opacity='0'; setTimeout(()=>t.remove(),300); }, 15000);
}

// Ops events share the ring but not the presentation: there is no geometry to show and no name to
// mute, so they land in the bell log as a plain line. Deliberately quiet — no toast for an info
// event, one for a warning, because a deploy notice that interrupts you is a notice you will turn
// off, and then the stall warning goes with it.
function fireOps(ev){
  updateBell();
  if(ev.level==='warn') pushToast('\u26a0 '+alertText(ev));
  if(!el('alertpop').hidden) buildAlertsPanel();
}

// A claim's death, from the same ring its birth came through. Deliberately NOT filtered by the
// trigger thresholds: those decide whether a setup is worth interrupting you for, and once you
// HAVE been interrupted, being told the void was taken is not optional. Only the void hit gets a
// toast — the target and the horizon resolution are for the log.
function fireLedger(ev){
  const A=state.alerts;
  updateBell();
  if(ev.sub==='stop'){
    const text=alertText(ev);
    pushToast(text);
    if(A.notify && typeof Notification!=='undefined' && Notification.permission==='granted'){
      try{ new Notification('Milst Screener \u2014 void taken',{body:text}); }catch(_){} }
  }
  if(!el('alertpop').hidden) buildAlertsPanel();
}

// ===== alert delivery (telegram push) =====
// The panel is a thin view over /api/alerts. Every decision — who is linked, which classes they
// take, whether the wire is healthy — lives on the server, because the alerts have to keep flowing
// with no tab open at all. This screen only reads and edits that state.
let pushState=null, pushBusy=false, ruleState=null;
async function loadRules(){
  try{ ruleState=await fetchJSON('/api/alerts/rules'); }
  catch(_){ ruleState=null; }
  if(!el('alertpop').hidden) buildAlertsPanel();
}
async function ruleAct(body){
  try{
    const res=await fetch('/api/alerts/rules',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
    await res.json().catch(()=>null);
  }catch(_){}
  await loadRules();
}
async function loadPush(){
  try{ pushState=await fetchJSON('/api/alerts'); }
  catch(_){ pushState=null; }
  if(!el('alertpop').hidden) buildAlertsPanel();
}
function pushCodeLeft(c){
  if(!c||!c.expiresAt) return '';
  const ms=c.expiresAt-Date.now(); if(ms<=0) return 'expired';
  const m=Math.floor(ms/60000), sec=Math.floor((ms%60000)/1000);
  return m+':'+String(sec).padStart(2,'0');
}
function buildPushSection(){
  // `A` is a caller-local in buildAlertsPanel, not a global. This function is called from inside
  // that one's template concatenation, which reads like shared scope and is not — the collapsed
  // per-recipient state below needs its own reference to the same store, or every call that gets
  // as far as a linked recipient throws before the panel's innerHTML is ever assigned.
  const P=pushState, A=state.alerts;
  if(!P) return '<div class="sec" style="font-size:var(--fs-sm);padding:4px">Delivery state unavailable \u2014 the server did not answer.</div>';
  if(!P.enabled) return '<div class="sec" style="font-size:var(--fs-sm);padding:4px">Telegram push is off \u2014 set <b>TG_BOT_TOKEN</b> on the server to enable it. Nothing else changes while it is unset.</div>';
  // The bell panel shows YOUR recipients and nobody else's — with three linked accounts and nine
  // class chips each it had become a wall of controls for people you cannot help. Admin's view of
  // everyone lives in the admin panel now, collapsed, where managing other people belongs.
  const mineOnly=(P.recipients||[]).filter(r=>r.mine);
  const others=(P.othersLinked||0)+((P.recipients||[]).length-mineOnly.length);
  const othersNote=others>0?`<div class="sec" style="font-size:var(--fs-xs);padding:2px 4px">${others} recipient(s) linked by other people${P.admin?' \u2014 manage them in the Admin tab':''}</div>`:'';
  const recips=mineOnly.length? mineOnly.map(r=>{
    const dot=r.muted?'neg':(r.lastErr?'warn':'pos');
    const tip=r.muted?(r.lastErr||'muted'):(r.lastOk?('last delivery '+fmtAge(Date.now()-r.lastOk)+' ago'):'linked, nothing delivered yet');
    // Matches the server: an absent selection means the DEFAULT classes, not all of them.
    const dflt=P.defaultClasses||P.classes||[];
    const on=(c)=>(r.classes&&r.classes.length)?r.classes.includes(c):dflt.includes(c);
    const CTIP={
      setup:'new confirmed setups',
      ledger:'void taken, target reached, horizon resolved \u2014 only for claims you were already told about. Level hits are detected LIVE (mark + 5m bars, ~2s off the socket); the ledger\u2019s stop-aware record is still decided by the resolver against the hourly spine, so a fast wick can enter the record without having alerted',
      rule:'your own threshold rules, evaluated server-side against the snapshot the board renders',
      filing:'material SEC filings only \u2014 8-K, 10-K/Q, 13D, 6-K, 425. Ownership forms (3/4/5/144/13G) are deliberately excluded: routine insider flow, several a day per active name',
      earnings:'two legs. URGENT: a name you hold an open, announced claim on reports today or tomorrow. CALENDAR: one message at 17:00 ET listing tomorrow\u2019s scheduled prints and today\u2019s results across the whole roster \u2014 batched into a single daily message on purpose, because the per-name version in season is a dozen interruptions a day',
      macro:'universe-wide scheduled binaries \u2014 FOMC decisions plus CPI / NFP / PPI / retail sales / GDP / PCE. Three messages per release: the ET day before, the last hour before the clock, and the actual once FRED publishes it. No ticker, because a CPI print moves the whole board. Prior only \u2014 this feed carries no street consensus, so nothing here is a beat or a miss',
      ai:'a cached analyst report changed its action stance on regeneration (wait \u2192 a side, or back)',
      ma200:'EMA200 events, close-confirmed on the rung\u2019s own candle (H4 + D1): reclaim, breakdown, and bullish/bearish retests \u2014 the study\u2019s buffered-cross and clear-air-retest definitions, full roster. Silent on names whose history can\u2019t seed a 200 yet',
      regime:'tape-wide positioning extremes \u2014 crowding and leverage stretch. Episode-gated: one alert per episode, re-armed only once the condition lapses',
      coverage:'a name you hold an open, announced claim on is running on a stale spine \u2014 its live numbers are being computed from old data',
      ops:'server health: poller stalls and recoveries. Deploy notices are recorded in the log but never pushed'};
    const rates=(P.rates)||{};
    const adminCls=P.adminClasses||['ops'];
    const chips=(P.classes||[]).filter(c=>!adminCls.includes(c)||r.admin).map(c=>{
      const rt=rates[c]||{}, per=rt.d1==null?'':(rt.capped?'400+':rt.d1)+'/d';
      const optIn=rt.dflt===false;
      return `<button type="button" class="cdtf${on(c)?' on':''}" data-pcls="${esc(c)}" data-pchat="${esc(r.chat)}" data-tip="${esc((CTIP[c]||c)+(optIn?' \u00b7 opt-in: not delivered unless you select it':''))}">${esc(c)}${per?` <i style="font-style:normal;opacity:.6">${esc(per)}</i>`:''}</button>`; }).join('');
    const q=r.quiet, qLbl=q?`${String(q.from).padStart(2,'0')}:00\u2013${String(q.to).padStart(2,'0')}:00`:'off';
    // briefHour is the EFFECTIVE hour with the default folded in — a chip reading "off" for
    // someone who is about to receive a brief would be a lie the reader acts on.
    const bH=(r.briefHour!=null?r.briefHour:r.digestHour);
    // An hour with no known offset is UTC, and must SAY so: a chip reading "07:00" that actually
    // fires at 04:00 local is the kind of quiet wrongness the reader only discovers by being woken.
    const dLbl=bH!=null?`${String(bH).padStart(2,'0')}:00${r.briefUtc?' UTC':''}`:'off';
    const openR=!!A.openRec[r.chat];
    const nOn=(P.classes||[]).filter(c=>on(c)&&(!adminCls.includes(c)||r.admin)).length;
    return `<div class="arule" style="flex-wrap:wrap">`
      +`<span class="arec-h" data-prec="${esc(r.chat)}"><span class="asec-c">${openR?'\u25be':'\u25b8'}</span><b class="${dot}" data-tip="${esc(tip)}">\u25cf</b> ${esc(r.name)} <span class="sec">${esc(r.mask)} \u00b7 ${nOn} class(es) \u00b7 ${r.sentHour}/${P.capHour}h${r.quietNow?' \u00b7 <b>quiet</b>':''}</span></span>`
      +`<span class="ax" data-punlink="${esc(r.chat)}" title="unlink">\u2715</span>`
      +(openR?`<span style="display:flex;gap:4px;width:100%;margin-top:5px;flex-wrap:wrap">${chips}</span>`
      +`<span style="display:flex;gap:6px;width:100%;margin-top:4px;align-items:center">`
      +`<button type="button" class="cdtf${q?' on':''}" data-pquiet="${esc(r.chat)}" data-tip="quiet hours delay non-urgent alerts until the window ends \u2014 they are never dropped. A void being taken and a poller stall always pierce.">quiet ${esc(qLbl)}</button>`
      +((P.schedKinds||[]).map(k=>{
          const sc=(r.sched&&r.sched[k.k])||null, h=sc?sc.hour:null;
          // The label states the hour, the days AND whether it is UTC. A chip reading "10:00" that
          // actually fires at 07:00 local is the kind of quiet wrongness you only find out about
          // by being woken, and "daily" vs "mon\u00b7wed\u00b7fri" is the whole point of the control.
          const lbl=h!=null?`${String(h).padStart(2,'0')}:00${sc&&sc.utc?' UTC':''}${sc&&sc.days?' \u00b7 '+sc.daysLabel:''}`:'off';
          return `<button type="button" class="cdtf${h!=null?' on':''}" data-psched="${esc(k.k)}" data-pchat2="${esc(r.chat)}" data-tip="${esc(k.label+(k.tip?' \u2014 '+k.tip:'')+' \u00b7 on by default; click to set the hour and which days you want it')}">${esc(k.label.toLowerCase())} ${esc(lbl)}</button>`;
        }).join(''))
      +`</span>`:'')+`</div>`;
  }).join('') : '<div class="sec" style="font-size:var(--fs-sm);padding:4px">You haven\u2019t linked a telegram account yet.</div>';
  void othersNote;
  const code=P.code&&pushCodeLeft(P.code)!=='expired'
    ? `<div class="pushcode"><div class="sec" style="font-size:var(--fs-xs)">DM the bot <b>/start ${esc(P.code.code)}</b></div><div class="pcode">${esc(P.code.code)}</div><div class="sec" style="font-size:var(--fs-xs)">expires in ${esc(pushCodeLeft(P.code))}</div></div>`
    : '';
  const errs=P.lastErr?`<div class="sec neg" style="font-size:var(--fs-xs);padding:2px 4px" data-tip="verbatim from the Telegram API \u2014 this is what a bad token or chat looks like">${esc(P.lastErr)}</div>`:'';
  const logHtml=P.log&&P.log.length? P.log.slice(0,6).map(e=>`<div class="alog"><span class="at">${new Date(e.t).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</span> ${esc(e.chat)} ${e.ok?'<span class="pos">sent</span>':'<span class="neg">'+esc(e.err||'failed')+'</span>'}</div>`).join('') : '';
  return `${recips}${others>0?othersNote:''}${code}${errs}
    <div style="display:flex;gap:6px;margin-top:6px">
      <button class="btn" id="p-link" style="flex:1;justify-content:center">Link telegram</button>
      <button class="btn" id="p-test" style="flex:1;justify-content:center" ${P.recipients&&P.recipients.length?'':'disabled'}>Test fire</button>
    </div>
    <div class="sec" style="font-size:var(--fs-xs);margin-top:5px">queue ${P.queue}${P.dropped?' \u00b7 <span class="neg">'+P.dropped+' dropped</span>':''} \u00b7 cap ${P.capHour}/h per person</div>${logHtml}`;
}
async function pushAct(url, body){
  if(pushBusy) return null;
  pushBusy=true;
  try{
    const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
    const d=await res.json().catch(()=>null);
    return d;
  }catch(_){ return null; }
  finally{ pushBusy=false; await loadPush(); }
}
export { alertMatrixHtml, buildPushSection, loadPush, loadRules, loadTriggers, pushAct, pushState, ruleAct, ruleState };
