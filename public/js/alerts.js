// alerts.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { applyHash } from "./admin.js";
import { macroStatFmt } from "./calendar.js";
import { activeRows, el, esc, fmtPrice, fmtUsd, state, store } from "./core.js";
import { render } from "./markets.js";
import { alertMatrixHtml, buildPushSection, loadTriggers, pushAct, pushState, ruleAct, ruleState } from "./triggers.js";


// ===== alerts (in-tab, edge-triggered) =====
// What remains of the in-tab evaluator. Everything the SERVER can compute moved there in -05, so
// these rules keep firing with no tab open and reach Telegram. The three below stayed because they
// are derived HERE, in this browser, from raw features against the analysis window you happen to
// have selected — so there is no single server-side value to alert on. Porting them would mean the
// same math living in two files, which is the drift this codebase refuses everywhere else.
// They are labelled "this browser" in the panel and die with the tab; that is the honest boundary,
// not an oversight.
const ALERT_METRICS=[
  {k:'sqz',label:'Squeeze (0-100)',unit:'',get:r=>r.sqz},
  {k:'mom',label:'Momentum',unit:'',get:r=>r.mom},
  {k:'beta',label:'Beta',unit:'',get:r=>r.beta},
];
const AM_BY={};
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
  if(A.notify && typeof Notification!=='undefined' && Notification.permission==='granted'){ try{ new Notification('Milst Screener alert',{body:text}); }catch(_){} }
  if(!el('alertpop').hidden) buildAlertsPanel(); }
// An error stays until dismissed: a 6.5s timeout on "Could not save …" was gone before it was read.
function pushToast(text, opts){ const w=el('toastwrap'); const t=document.createElement('div'); t.className='toast';
  const sticky=(opts&&opts.sticky)||/^(\u26a0|Could not|could not|Failed|failed|Your session)/.test(String(text));
  if(sticky){ t.classList.add('toast-sticky'); const x=document.createElement('span'); x.className='ax'; x.title='dismiss'; x.textContent='\u2715'; x.onclick=()=>t.remove(); t.appendChild(document.createTextNode(text)); t.appendChild(x); }
  else t.textContent=text;
  w.appendChild(t);
  if(!sticky) setTimeout(()=>{ t.style.transition='opacity .3s'; t.style.opacity='0'; setTimeout(()=>t.remove(),300); }, 6500); }
// A redeploy used to announce itself only as a silently changing build stamp in the statusline —
// a tab left open kept running the old bundle indefinitely. The moment any snapshot (plain poll
// and push-triggered pull alike, since both land here) carries a build other than the one this
// page is running, ONE persistent toast offers the reload. Called BEFORE state.build is
// overwritten so the message can name the version this tab is still on; never fires on the first
// snapshot (state.build unset = nothing to compare against), and a dismissed toast stays
// dismissed for that version — the next deploy raises a fresh one.
let _buildToastFor=null;
function notifyNewBuild(v){
  state.newBuild=v;   // (build 2026.09.24-108) read by core.js lazyFailToast: a lazy import failing after a deploy is a reload, not a retry
  if(_buildToastFor===v) return; _buildToastFor=v;
  const w=el('toastwrap'); if(!w) return;
  const t=document.createElement('div'); t.className='toast toast-trig';
  t.innerHTML=`<div class="tt-h"><span class="tt-lbl">NEW VERSION</span><span class="ax" data-x="1" title="dismiss">✕</span></div>`
    +`<div class="tt-n">A new version is live — please refresh</div>`
    +`<div class="tt-g">server is on build ${esc(v)}; this tab is still running ${esc(state.bootBuild||state.build)}. Your layouts, watchlist and prefs survive the reload.</div>`
    +`<div class="tt-a"><button class="btn" data-re="1">Refresh now</button></div>`;
  t.querySelector('[data-x]').addEventListener('click',()=>t.remove());
  t.querySelector('[data-re]').addEventListener('click',()=>{ try{ location.reload(); }catch(_){} });
  w.appendChild(t);
}
// Unread = server events past the persisted read watermark, PLUS local in-tab fires. The old
// in-memory counter reset to zero on every refresh, so anything that fired while you were away
// was invisible by the time you looked — the exact failure this slice exists to fix.
function alertUnread(){ const A=state.alerts;
  const floor=Math.max(A.seenSeq||0, A.clearedSeq||0);
  return A.feed.filter(e=>(e.seq||0)>floor).length + A.unseen; }
function updateBell(){ const b=el('bellBadge'), n=alertUnread(); b.textContent=n>99?'99+':String(n); b.classList.toggle('show', n>0); }
// Marks everything currently held as read and persists the watermark, so the badge stays cleared
// across a refresh and across devices' own separate reading.
function alertMarkRead(){ const A=state.alerts;
  let hi=A.seenSeq||0; for(const e of A.feed) if((e.seq||0)>hi) hi=e.seq||0;
  A.seenSeq=hi; A.unseen=0; saveAlerts(); updateBell(); }
// ONE formatter for every server event kind, shared by the toast path and the panel. Previously
// each fire* built its own string and pushed it into a local array; the panel then rendered that
// array, so the displayed history and the notification could drift apart and neither survived a
// reload. Now the panel renders the server's list through this, and fire* only interrupts.
// The confirmation stamp a close-confirmed trend event carries: which candle close made it true
// (UTC — Hyperliquid buckets are UTC on both universes) and, when the live board ran ahead of that
// close, the first intrabar sighting. Same fields the Telegram message renders (compute.trendWhen);
// bell log and phone read ONE event and can never disagree about when a trend began.
function trendWhenTxt(ev){
  if(!ev||ev.confAt==null||!isFinite(+ev.confAt)) return '';
  const hm=ts=>{const d=new Date(+ts);return String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0');};
  const md=ts=>{const d=new Date(+ts);return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]+' '+d.getUTCDate();};
  let s=`confirmed ${ev.confTf||ev.tf||''} close ${hm(ev.confAt)} UTC`;
  if(ev.seenAt!=null&&isFinite(+ev.seenAt)&&+ev.seenAt<+ev.confAt)
    s+=` \u00b7 first seen ${md(ev.seenAt)===md(ev.confAt)?'':md(ev.seenAt)+' '}${hm(ev.seenAt)}`;
  return s;
}
function alertText(ev){
  const k=ev.kind||'setup';
  if(k==='ops') return `${ev.title||'ops'}${ev.text?' \u2014 '+ev.text:''}`;
  if(k==='filing') return `${ev.t} \u00b7 ${ev.form} \u00b7 ${ev.h||''}`;
  if(k==='earnings'){
    // Two shapes in one class: the roster-wide daily calendar and the claim-scoped single name.
    // The log states which, because "AAPL reports tomorrow" and "9 names report tomorrow" are
    // different messages and collapsing them would make the feed unreadable.
    if(ev.sub==='preview'){
      const up=(ev.tomorrow||[]).length+(+ev.moreUp||0), rp=(ev.reported||[]).length+(+ev.moreRep||0);
      const names=(ev.tomorrow||[]).slice(0,6).map(e=>e.t).join(', ');
      return `earnings calendar \u00b7 ${up} reporting tomorrow${names?' ('+names+(up>6?'\u2026':'')+')':''}${rp?` \u00b7 ${rp} reported today`:''}`;
    }
    return `${ev.t} reports ${ev.when}${ev.session?' ('+ev.session+')':''}`;   // claim gates the alert server-side, never renders — positioning stays off earnings messages
  }
  if(k==='macro'){
    const st=macroStatFmt({k:ev.k},ev.sub==='result'?ev.actual:ev.prior).replace(/<\/?b>/g,'').replace(/<span[^>]*>|<\/span>/g,'');
    if(ev.sub==='result') return `${ev.label||ev.k} released \u00b7 ${st||'actual pending'}${ev.prior&&st?` (prior ${macroStatFmt({k:ev.k},ev.prior).replace(/<\/?b>/g,'')})`:''}`;
    const when=ev.sub==='imminent'?(ev.mins!=null?`in ${Math.max(1,Math.round(ev.mins))} min`:'shortly'):'tomorrow';
    return `${ev.label||ev.k} ${when} \u00b7 ${ev.tEt||''} ET${st?` \u00b7 prior ${st}`:''}`;
  }
  if(k==='ai') return `${ev.t} \u00b7 analyst read flipped: ${ev.from} \u2192 ${ev.to}`;
  if(k==='trend'){ const w=trendWhenTxt(ev);
    return `${ev.t} \u00b7 ${ev.title}${ev.score!=null?' \u00b7 '+ev.score+'/4':''}${ev.text?' \u00b7 '+ev.text:''}${w?' \u00b7 \u23f1 '+w:''}`; }
  if(k==='ma200'){ const w=trendWhenTxt(ev);
    return `${ev.t} ${String(ev.side||'').toUpperCase()} \u00b7 ${ev.title}${ev.held!=null?' \u00b7 held '+ev.held+' bars':''}${ev.text?' \u00b7 '+ev.text:''}${w?' \u00b7 \u23f1 '+w:''}`; }
  if(k==='regime') return `${ev.scope==='main'?'crypto':'stocks'} positioning \u00b7 ${ev.title} \u00b7 ${ev.text||''}`;
  if(k==='coverage') return `\u26a0 ${ev.t} \u00b7 data gap \u00b7 ${ev.text||''}`;
  if(k==='rule') return `${ev.t} \u00b7 ${ev.rule||(ev.label+' '+ev.op+' '+ev.value)} \u00b7 now ${ev.now||'\u2014'}${ev.note?' \u00b7 '+ev.note:''}`;
  if(k==='ledger'){
    const head=ev.sub==='stop'?'\u26d4 void taken':ev.sub==='target'?'\u2713 target':'resolved';
    let tail;
    if(ev.sub==='resolved'){ const r=ev.realized;
      tail=(r==null?'\u2014':(r>=0?'+':'')+(+r).toFixed(2)+(ev.unit||'R'))+(ev.stopped?' (stopped en route)':''); }
    else tail=(ev.level!=null?fmtPrice(ev.level):'\u2014')+(ev.held?' \u00b7 held '+ev.held:'');
    return `${ev.t} ${String(ev.side||'').toUpperCase()} \u00b7 ${ev.label} \u2014 ${head} \u00b7 ${tail}`;
  }
  const rr=ev.rr&&ev.rr.gross!=null?(+ev.rr.gross).toFixed(2):'\u2014';
  const evs=ev.evR!=null?((ev.evR>=0?'+':'')+(+ev.evR).toFixed(2)+'R'):'no record';
  return `${ev.t} ${String(ev.side||'').toUpperCase()} \u00b7 ${ev.label} \u00b7 R:R ${rr} \u00b7 EV ${evs}`;
}
function buildAlertsPanel(){ const pop=el('alertpop'), A=state.alerts;
  // ONE form. The metric chosen decides where the rule lives: server metrics become shared,
  // persistent, Telegram-capable rules; the three browser-derived ones stay in this tab. Two
  // separate forms would make the user carry that distinction; a labelled dropdown does it for them.
  const srvMetrics=(ruleState&&ruleState.metrics)||[];
  const metricOpts=srvMetrics.map(m=>`<option value="s:${esc(m.k)}">${esc(m.label)}</option>`).join('')
    +(ALERT_METRICS.length?`<optgroup label="this browser only">${ALERT_METRICS.map(m=>`<option value="l:${m.k}">${esc(m.label)}</option>`).join('')}</optgroup>`:'');
  const opOpts=(ruleState&&ruleState.ops||['>','<']).map(o=>`<option value="${esc(o)}">${esc((ruleState&&ruleState.opLabels&&ruleState.opLabels[o])||o)}</option>`).join('');
  const srvRules=(ruleState&&ruleState.rules)||[];
  const srvHtml=srvRules.length? srvRules.map(rl=>
      `<div class="arule"><span>${esc(rl.text||rl.metric)}${rl.mine?'':' <span class="sec" data-tip="written from another browser \u2014 visible because you are admin">(not yours)</span>'}${rl.note?' <span class="sec">'+esc(rl.note)+'</span>':''}${rl.thread?' <span class="sec" data-tip="set with /alert in a conversation \u2014 it fires there, as a message, instead of to your phone">\u2192 '+esc(rl.threadName||'a conversation')+'</span>':''}</span><span class="ax" data-sdel="${rl.id}" title="delete">\u2715</span></div>`).join('')
    : '<div class="sec" style="font-size:var(--fs-sm);padding:4px">You have no rules yet.</div>';
  const otherRules=(ruleState&&ruleState.othersRules)||0;
  const rulesHtml=A.rules.length? A.rules.map(rl=>{ const m=AM_BY[rl.metric];
    return `<div class="arule"><span>${rl.coin?esc(tickerOf(rl.coin)):'<span class="sec">any</span>'} \u00b7 ${esc(m?m.label:rl.metric)} ${rl.op} ${rl.value}</span><span class="ax" data-del="${rl.id}" title="delete">\u2715</span></div>`; }).join('')
    : '';
  // The log is a MERGE of two sources with different lifetimes, and the tag column says which is
  // which: server-held events (survive a refresh, a closed tab, a redeploy) and this browser's own
  // in-tab rule fires (die with the tab, until their server-side replacement lands).
  const ATAG={setup:['SETUP','pos'], ledger:['LEDGER',''], ops:['OPS','sec'], rule:['RULE','sec'],
    filing:['FILING',''], earnings:['EARN','sec'], ai:['AI',''], regime:['REGIME','sec'], coverage:['GAP','neg'],
    trend:['TREND','pos'], ma200:['MA200','pos'], macro:['MACRO','sec']};
  const feedRows=A.feed.filter(e=>(e.seq||0)>(A.clearedSeq||0)).map(e=>({t:e.at||0, seq:e.seq||0,
    kind:(e.kind||'setup'), sub:e.sub||null, text:alertText(e), coin:e.coin||null}));
  const localRows=A.log.map(e=>({t:e.t, seq:0, kind:'rule', sub:null, text:e.text, coin:null}));
  // Collapse consecutive identical-text rows into one with a count. Ten "deploy — build X is live"
  // lines in a row carry exactly as much information as one line saying it happened ten times, and
  // they were burying every setup and ledger event under them.
  const sorted=feedRows.concat(localRows).sort((a,b)=>(b.t||0)-(a.t||0));
  const merged=[];
  for(const e of sorted){
    const last=merged[merged.length-1];
    if(last && last.kind===e.kind && last.text===e.text){ last.n=(last.n||1)+1; continue; }
    merged.push(Object.assign({},e));
    if(merged.length>=14) break;
  }
  const logHtml=merged.length? merged.map(e=>{
    const tag=ATAG[e.kind]||['?','']; 
    const lbl=e.kind==='ledger'&&e.sub==='stop'?['VOID','neg']:e.kind==='ledger'&&e.sub==='target'?['TGT','pos']:e.kind==='ledger'?['RES','sec']:tag;
    const unread=e.seq>0&&e.seq>(A.seenSeq||0);
    return `<div class="alog${unread?' aunread':''}"><span class="at">${e.t?new Date(e.t).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}):'\u2014'}</span>`
      +`<span class="atag ${lbl[1]}">${lbl[0]}</span> ${esc(e.text)}${e.n>1?` <span class="sec" data-tip="repeated ${e.n} times \u2014 collapsed">\u00d7${e.n}</span>`:''}</div>`; }).join('')
    : `<div class="sec" style="font-size:var(--fs-sm);padding:4px">${(A.clearedSeq||0)>0?'Cleared. New events will appear here.':'Nothing has fired yet.'}</div>`;
  const navail=(typeof Notification!=='undefined');
  const T=A.trig;
  const mutedHtml=T.muted.length? T.muted.map(c=>`<span class="arule" style="display:inline-flex;margin:0 4px 4px 0"><span>${esc(tickerOf(c))}</span><span class="ax" data-unmute="${esc(c)}" title="unmute">✕</span></span>`).join('')
    : '<div class="sec" style="font-size:var(--fs-sm);padding:4px">Nothing muted.</div>';
  // Collapsible sections. Four stacked blocks plus a log had turned the panel into a wall; the
  // header is now a toggle and the open/closed state persists per browser.
  const O=A.open||{};
  const sec=(k,title,note,body,extra)=>`<div class="asec-h${O[k]?' on':''}" data-asec="${k}"><span class="asec-c">${O[k]?'\u25be':'\u25b8'}</span>${title}${note?` <span class="sec" style="text-transform:none;letter-spacing:0">\u00b7 ${note}</span>`:''}${extra||''}</div>${O[k]?`<div class="asec-b">${body}</div>`:''}`;
  const numIn=(id,val,ph,tip)=>`<label class="anum" data-tip="${esc(tip)}"><span>${ph}</span><input id="${id}" type="number" step="0.05" value="${val==null?'':val}" placeholder="any"/></label>`;
  pop.innerHTML=
    sec('trig','Trigger alerts','new confirmed setups only',
      `<label class="copt"><input type="checkbox" id="at-on" ${T.on?'checked':''}/> Alert on new triggers</label>
       <div class="anum-row">
         ${numIn('at-ev',T.minEV,'EV \u2265','Minimum expectancy, in R, to interrupt you for. Blank = any. Applies to this browser AND your telegram.')}
         ${numIn('at-rr',T.minRR,'R:R \u2265','Minimum reward-to-risk FROZEN AT FIRE. The board classes anything under 2.0 as a grinder rather than a windfall \u2014 neither is wrong, but they are different trades. Blank = any.')}
         ${numIn('at-late',T.maxLate,'late \u2264','How far the setup has already run from its fire, in its own risk unit. An alert on a setup that already spent its edge is noise. Blank = any.')}
       </div>
       <div class="anum-row" style="margin-top:6px">
         ${['rr','ev'].map(c=>{
           const onC=!Array.isArray(T.cls)||!T.cls.length||T.cls.includes(c);
           return `<button type="button" class="cdtf${onC?' on':''}" data-acls="${c}" style="flex:1" data-tip="${esc(c==='rr'
             ?'Setups whose frozen R:R at fire clears 2:1 \u2014 level-triggered trades (breakouts, trend retests) with the stop at a real chart level. Win big, less often.'
             :'Setups below 2:1 at fire whose expectancy is still positive \u2014 the statistical family (big moves, funding divergences) built on median outcomes against a 1\u03c3 void. Win small, more often. Every one still clears the same record and EV gates.')}">${c==='rr'?'2:1+ setups':'positive-EV grinders'}</button>`;
         }).join('')}
       </div>
       <div class="sec" style="font-size:var(--fs-xs);margin-top:4px">these thresholds apply to the in-tab toasts and to your telegram delivery</div>
       <div class="cphead" style="margin-top:8px">Muted (${T.muted.length})</div>${mutedHtml}`)
    + sec('rules',`Rules (${srvRules.length})`,'private to you \u00b7 evaluated server-side, fire with no tab open',
      `<div class="arule-form">
        <input id="ar-ticker" class="full" placeholder="Ticker (blank = any market)" autocomplete="off" spellcheck="false"/>
        <select id="ar-metric">${metricOpts}</select>
        <select id="ar-op">${opOpts}</select>
        <input id="ar-val" class="full" placeholder="Threshold (e.g. 5 for 5%, 50 for 50M)" autocomplete="off" spellcheck="false"/>
        <button class="btn full" id="ar-add" style="justify-content:center">Add alert</button>
       </div>${srvHtml}${otherRules>0?`<div class="sec" style="font-size:var(--fs-xs);padding:2px 4px">${otherRules} rule(s) written by other people \u2014 not shown</div>`:''}
       ${A.rules.length?`<div class="cphead" style="margin-top:8px">This browser only (${A.rules.length}) <span class="sec" style="text-transform:none;letter-spacing:0" data-tip="squeeze, momentum and beta are derived in your browser against the analysis window you have selected, so there is no single server-side value to alert on. These fire only while this tab is open and never reach telegram.">\u00b7 why?</span></div>${rulesHtml}`:''}`)
    + sec('deliv','Delivery','your own telegram \u00b7 DMs sent with no tab open', alertMatrixHtml()+buildPushSection())
    + sec('recent','Recent','server-held \u2014 survives a closed tab', logHtml,
        `<span class="asec-x" data-aclear="1" data-tip="hides everything currently listed, for this browser only. The server\u2019s ring is the record and is never edited from here \u2014 other devices and the telegram history are untouched.">clear</span>`)
    + `<label class="copt" style="margin-top:8px"><input type="checkbox" id="ar-notify" ${A.notify?'checked':''} ${navail?'':'disabled'}/> Browser notifications${navail?'':' (unavailable here)'}</label>
    <button class="btn" id="ar-clear" style="width:100%;justify-content:center;margin-top:6px">Mark all read</button>`;
  pop.querySelectorAll('[data-asec]').forEach(x=>x.addEventListener('click',e=>{
    if(e.target.closest('[data-aclear]')) return;
    const k=x.dataset.asec; A.open[k]=!A.open[k]; saveAlerts(); buildAlertsPanel(); }));
  const clr=pop.querySelector('[data-aclear]');
  if(clr) clr.addEventListener('click',e=>{ e.stopPropagation();
    let hi=A.clearedSeq||0; for(const ev of A.feed) if((ev.seq||0)>hi) hi=ev.seq||0;
    A.clearedSeq=hi; A.log=[]; A.unseen=0; if((A.seenSeq||0)<hi) A.seenSeq=hi;
    saveAlerts(); updateBell(); buildAlertsPanel(); });
  const addBtn=el('ar-add'); if(addBtn) addBtn.onclick=addAlertRule;
  pop.querySelectorAll('[data-sdel]').forEach(x=>x.addEventListener('click',()=>{ if(confirm('Remove this rule? It fires from the server, with no tab open.')) ruleAct({del:+x.dataset.sdel}); }));
  const valIn=el('ar-val'); if(valIn) valIn.addEventListener('keydown',e=>{ if(e.key==='Enter') addAlertRule(); });
  pop.querySelectorAll('[data-del]').forEach(x=>x.addEventListener('click',()=>{ if(confirm('Remove this rule?')) deleteAlertRule(+x.dataset.del); }));
  el('ar-notify').addEventListener('change',e=>toggleNotify(e.target.checked));
  // The server's ring is the record; a client cannot and should not delete from it. "Read" is the
  // only state a browser owns here, so that is the only thing this button changes.
  el('ar-clear').onclick=()=>{ alertMarkRead(); buildAlertsPanel(); };
  const onBox=el('at-on'); if(onBox) onBox.addEventListener('change',e=>{ T.on=e.target.checked; saveAlerts(); if(T.on) loadTriggers(); });
  // One control writes both sides: the in-tab filter and the same thresholds on every telegram
  // recipient this browser owns. Two places to set the same number is how they end up disagreeing.
  const syncTrig=()=>{ saveAlerts();
    const rs=(pushState&&pushState.recipients)||[];
    for(const r of rs) if(r.mine) pushAct('/api/alerts/prefs',{chat:r.chat, trig:{minEV:T.minEV, minRR:T.minRR, maxLate:T.maxLate, cls:T.cls}}); };
  pop.querySelectorAll('[data-acls]').forEach(x=>x.addEventListener('click',()=>{
    const c=x.dataset.acls;
    let cur=Array.isArray(T.cls)&&T.cls.length?T.cls.slice():['rr','ev'];
    cur = cur.includes(c) ? cur.filter(v=>v!==c) : cur.concat([c]);
    // Turning both off would read as "no setup alerts" but persist as "both" — refuse the
    // ambiguous state; the master toggle above is how you turn setups off.
    if(!cur.length) return;
    T.cls=cur; syncTrig(); buildAlertsPanel(); }));
  for(const [id,key] of [['at-ev','minEV'],['at-rr','minRR'],['at-late','maxLate']]){
    const n=el(id); if(!n) continue;
    n.addEventListener('change',e=>{ const v=e.target.value.trim();
      T[key]=v===''?null:parseFloat(v);
      if(T[key]!=null&&!isFinite(T[key])) T[key]=null;
      syncTrig(); }); }
  pop.querySelectorAll('[data-unmute]').forEach(x=>x.addEventListener('click',()=>{
    T.muted=T.muted.filter(c=>c!==x.dataset.unmute); saveAlerts(); buildAlertsPanel(); }));
  const pl=el('p-link'); if(pl) pl.addEventListener('click',()=>pushAct('/api/alerts/link'));
  const pt=el('p-test'); if(pt) pt.addEventListener('click',()=>pushAct('/api/alerts/test'));
  pop.querySelectorAll('[data-pcls]').forEach(x=>x.addEventListener('click',()=>{
    const P=pushState; if(!P) return;
    const rec=(P.recipients||[]).find(r=>r.chat===x.dataset.pchat); if(!rec) return;
    const all=P.classes||[];
    let cur=(rec.classes&&rec.classes.length)?rec.classes.slice():((P.defaultClasses||all).slice());
    const c=x.dataset.pcls;
    cur = cur.includes(c) ? cur.filter(v=>v!==c) : cur.concat([c]);
    // Turning the last class off would read as silence but persist as "all" — mute is a separate
    // control, so refuse the ambiguous state instead of quietly inverting the intent.
    if(!cur.length){ return; }
    // Always send the explicit list. Collapsing "all selected" to [] used to mean "default", which
    // now differs from "all" — sending [] would silently unsubscribe the opt-in classes the user
    // just turned on.
    pushAct('/api/alerts/classes',{chat:rec.chat, classes:cur}); }));
  pop.querySelectorAll('[data-prec]').forEach(x=>x.addEventListener('click',()=>{
    const c=x.dataset.prec; A.openRec[c]=!A.openRec[c]; buildAlertsPanel(); }));
  pop.querySelectorAll('[data-pquiet]').forEach(x=>x.addEventListener('click',()=>{
    const rec=((pushState&&pushState.recipients)||[]).find(r=>r.chat===x.dataset.pquiet); if(!rec) return;
    if(rec.quiet){ pushAct('/api/alerts/prefs',{chat:rec.chat, quiet:null}); return; }
    const v=(prompt('Quiet hours, local 24h (e.g. 23-7). Blank to turn off.','23-7')||'').trim();
    if(!v) return;
    const m=v.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/); if(!m){ alert('Use a from-to range like 23-7.'); return; }
    // The browser knows the reader's offset; asking them for it would be a worse question than one
    // they can already answer wrongly.
    pushAct('/api/alerts/prefs',{chat:rec.chat, quiet:{from:+m[1], to:+m[2], tz:-new Date().getTimezoneOffset()}}); }));
  pop.querySelectorAll('[data-psched]').forEach(x=>x.addEventListener('click',()=>{
    const rec=((pushState&&pushState.recipients)||[]).find(r=>r.chat===x.dataset.pchat2); if(!rec) return;
    const k=x.dataset.psched, kind=((pushState&&pushState.schedKinds)||[]).find(z=>z.k===k)||{};
    const sc=(rec.sched&&rec.sched[k])||null;
    const cur=sc&&sc.hour!=null?String(sc.hour):String(kind.defaultHour!=null?kind.defaultHour:10);
    const v=(prompt(kind.label+' at which local hour? (0-23, blank to turn it off)',cur)||'').trim();
    if(v===''){ pushAct('/api/alerts/prefs',{chat:rec.chat, sched:{[k]:{h:null}}, tz:-new Date().getTimezoneOffset()}); return; }
    const dCur=sc&&sc.days?sc.days.join(','):'all';
    const d=(prompt('Which days? ("all", "weekdays", "mon,wed,fri" or "MWF")',dCur)||'').trim();
    // Days are parsed SERVER-side; sending the raw string would put a second parser in the browser
    // and give the two somewhere to disagree. The client only ever sends numbers or nothing.
    const days=schedDaysClient(d);
    if(days===undefined){ alert('Could not read those days. Try "all", "weekdays", "mon,wed,fri" or "MWF".'); return; }
    pushAct('/api/alerts/prefs',{chat:rec.chat, sched:{[k]:{h:+v, days}}, tz:-new Date().getTimezoneOffset()}); }));
  pop.querySelectorAll('[data-punlink]').forEach(x=>x.addEventListener('click',()=>{
    if(confirm('Unlink this recipient? They stop receiving alerts immediately.')) pushAct('/api/alerts/unlink',{chat:x.dataset.punlink}); })); }
// Mirrors the server's schedParseDays for the ONE job the browser has: turning what someone typed
// into day numbers, or refusing. Deliberately not a second source of truth about schedules — it
// returns numbers and the server re-validates them.
function schedDaysClient(str){
  const s=String(str==null?'':str).trim().toLowerCase();
  if(!s||s==='all'||s==='daily'||s==='everyday'||s==='every day') return null;
  if(s==='weekdays'||s==='wd') return [1,2,3,4,5];
  const NM=['sun','mon','tue','wed','thu','fri','sat'], out=[];
  const add=n=>{ if(out.indexOf(n)===-1) out.push(n); };
  const parts=s.split(/[\s,;/|]+/).filter(Boolean);
  if(parts.length===1&&/^[mtwrfsu]+$/.test(parts[0])){
    const M={m:1,t:2,w:3,r:4,f:5,s:6,u:0};
    for(const ch of parts[0]) add(M[ch]);
    return out.sort((a,b)=>a-b);
  }
  for(const p of parts){
    if(/^\d$/.test(p)){ add(+p); continue; }
    const ix=NM.indexOf(p.slice(0,3));
    if(ix===-1) return undefined;
    add(ix);
  }
  return out.length?out.sort((a,b)=>a-b):undefined;
}
function addAlertRule(){ const A=state.alerts, tIn=el('ar-ticker').value.trim().toUpperCase(); let coin='';
  if(tIn){ for(const r of state.rows.values()){ if(r.ticker.toUpperCase()===tIn||r.coin.toUpperCase()===tIn){ coin=r.coin; break; } }
    if(!coin){ el('ar-ticker').classList.add('bad'); return; } }
  el('ar-ticker').classList.remove('bad');
  const sel=el('ar-metric').value, op=el('ar-op').value, val=parseFloat(el('ar-val').value);
  if(!isFinite(val)){ el('ar-val').classList.add('bad'); return; } el('ar-val').classList.remove('bad');
  const metric=sel.slice(2), server=sel.charAt(0)==='s';
  el('ar-ticker').value=''; el('ar-val').value='';
  if(server){ ruleAct({metric, op, value:val, coin}); return; }
  // A browser-derived metric only supports the two comparisons this tab can evaluate.
  A.rules.push({id:Date.now()+Math.floor(Math.random()*1000), coin, metric, op:(op==='<'?'<':'>'), value:val});
  saveAlerts(); buildAlertsPanel(); render(); }
function deleteAlertRule(id){ const A=state.alerts; A.rules=A.rules.filter(r=>r.id!==id);
  for(const k of [...alertFired]) if(k.startsWith(id+':')) alertFired.delete(k);
  saveAlerts(); buildAlertsPanel(); }
function toggleNotify(on){ const A=state.alerts;
  if(on && typeof Notification!=='undefined'){ if(Notification.permission==='granted'){ A.notify=true; }
    else { Notification.requestPermission().then(p=>{ A.notify=(p==='granted'); saveAlerts(); if(!el('alertpop').hidden) buildAlertsPanel(); }); return; } }
  else A.notify=false; saveAlerts(); }
function saveAlerts(){ store.set(AKEY, JSON.stringify({rules:state.alerts.rules, notify:state.alerts.notify, trig:state.alerts.trig,
  seenSeq:state.alerts.seenSeq, clearedSeq:state.alerts.clearedSeq, open:state.alerts.open})); }
function loadAlerts(){ let d; try{ d=JSON.parse(store.get(AKEY)||'null'); }catch(_){ d=null; } if(!d) return;
  if(Array.isArray(d.rules)) state.alerts.rules=d.rules.filter(r=>r&&AM_BY[r.metric]); state.alerts.notify=!!d.notify;
  if(d.trig&&typeof d.trig==='object') state.alerts.trig=Object.assign(state.alerts.trig,d.trig,{muted:Array.isArray(d.trig.muted)?d.trig.muted:[]});
  if(Number.isFinite(d.seenSeq)) state.alerts.seenSeq=d.seenSeq;
  if(Number.isFinite(d.clearedSeq)) state.alerts.clearedSeq=d.clearedSeq;
  if(d.open&&typeof d.open==='object') state.alerts.open=Object.assign(state.alerts.open,d.open); }

export function __boot_alerts_3533() { ALERT_METRICS.forEach(m=>AM_BY[m.k]=m);

window.addEventListener('hashchange',()=>{ if(!_hashSelf) applyHash(); });
}
   // a pasted #t=… into an open tab now works
let _hashSelf=false;
function setHash(h){ _hashSelf=true; try{ history.replaceState(null,'', h?('#'+h):(location.pathname+location.search)); }catch(_){} setTimeout(()=>{ _hashSelf=false; },0); }
const HASH_VIEWS=new Set(['markets','focus','funds','trend','charts','sectors','drawdown','corr','funding','sessions','signals','earnings','news','backtest','report','actionable','admin','housing','liquidity','notes','congress','insiders','dm']);
export { HASH_VIEWS, alertMarkRead, alertText, buildAlertsPanel, evaluateAlerts, loadAlerts, notifyNewBuild, pushToast, saveAlerts, schedDaysClient, setHash, tickerOf, updateBell };
