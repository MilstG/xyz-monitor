// usage.js — the first-party usage beacon and the member's own "Your usage" card (build 2026.09.24-109).
// Eager on purpose, and tiny: the accumulator has to see the first tab and every switch after it.
// What it records is one number per tab — visible, attended milliseconds — and nothing else: no
// tickers, no search text, no filter state, no drawer contents. The server adds the coarse device
// class from the User-Agent (three words, never the UA itself); the client adds one boolean, whether
// it runs installed (display-mode: standalone).
//
// Time counts only while BOTH hold: the page is visible, and there was input (pointer, key, wheel,
// scroll, touch) in the last 5 minutes — an idle wall monitor is not eight hours on Markets. The
// accumulator is segment-based rather than a ticking interval: every state change (tab switch,
// visibility, input after idle) settles the open segment, and a segment never runs past the last
// input + 5 min, so there is no timer to drift and nothing to count while the page sleeps.
//
// Flush: navigator.sendBeacon('/api/usage') every 60s and on pagehide / visibilitychange→hidden.
// A flush inside 30s of the last one keeps its minutes and rides the next one (hidden time never
// counts, so holding them costs nothing) — except pagehide, which cannot wait. (build 2026.09.24-110
// follow-up) The beacon carries `s`, a random id minted once per page load; the server gates per
// (member, s), so two tabs or devices never drop each other's minutes, and a beacon that arrives
// inside the gap (the pagehide one) is held and merged server-side instead of refused — still
// clamped to wall time (src/usage-gate.js). Signed-out visitors never beacon; a paused member never beacons.
//
// (build 2026.09.24-110) The same beacon carries three more things, and still nothing typed:
//   acts  counts of the two actions that happen only in the browser — a CSV export and a ticker
//         drawer opening (the count; the ticker never leaves). Every other counter (calls, alerts,
//         shares, asks, AI reports, Telegram link, push) is counted by the server at its own call.
//   perf  ms from navigation start to the first markets-table paint, once per page load, and only
//         when the page was on screen the whole time (a tab loaded in the background paints late
//         because nobody was looking, which says nothing about speed).
//   errs  window.onerror / unhandledrejection, deduped here by message + file:line: the message
//         cut to 200 characters and the file reduced to this site's path. No stack, no locals.
//         (-110 follow-up) Quoted text in the message ('…', "…", `…`) is replaced by an ellipsis
//         before anything leaves the page (the server does it again).
//   b     the build this tab runs (its first snapshot's stamp): the operator's stale-build count.
import { el, esc, state } from "./core.js";

const US_IDLE_MS=5*60000, US_FLUSH_MS=60000, US_GAP_MS=30000, US_INPUT_THROTTLE=1000;
// ---- the accumulator (pure: every entry point takes `now`, so the tests drive it with a fake clock) ----
function usAcc(now,tab,vis){ const a={acc:{},tab:tab||null,vis:vis!==false,lastIn:now,since:null}; a.since=usCounting(a,now)?now:null; return a; }
function usCounting(a,now){ return !!(a.tab&&a.vis&&now-a.lastIn<US_IDLE_MS); }
// Close the open segment: count [since, min(now, lastInput+idle)], then reopen it if still counting.
function usSettle(a,now){
  if(a.since!=null&&a.tab){ const end=Math.min(now,a.lastIn+US_IDLE_MS); if(end>a.since) a.acc[a.tab]=(a.acc[a.tab]||0)+(end-a.since); }
  a.since=usCounting(a,now)?now:null; }
function usSetTab(a,tab,now){ usSettle(a,now); a.tab=tab||null; a.since=usCounting(a,now)?now:null; }
function usSetVis(a,vis,now){ usSettle(a,now); a.vis=!!vis; a.since=usCounting(a,now)?now:null; }
function usInput(a,now){ if(now-a.lastIn<US_INPUT_THROTTLE&&a.since!=null) return; usSettle(a,now); a.lastIn=now; a.since=usCounting(a,now)?now:null; }
// Hand over what has accumulated (whole ms, zero tabs dropped) and start a fresh map.
function usTake(a,now){ usSettle(a,now); const out={}; for(const k in a.acc){ const v=Math.round(a.acc[k]); if(v>0) out[k]=v; } a.acc={}; return out; }
function usGive(a,tabs){ for(const k in tabs) a.acc[k]=(a.acc[k]||0)+tabs[k]; }   // a flush that could not go out puts its minutes back

// ---- the live instance -------------------------------------------------------------------------
// (-110 follow-up) The page session id: random, per page load, never stored — the server's rate-gate key.
function usSid(){ try{ const a=new Uint8Array(9); crypto.getRandomValues(a); return Array.from(a,x=>(x%36).toString(36)).join('')+Date.now().toString(36).slice(-3); }catch(_){ return Math.random().toString(36).slice(2,14).padEnd(12,'0'); } }
// (-110 follow-up) Quoted substrings out of an error message: each '…', "…" or `…` run becomes its
// quotes around an ellipsis; an unclosed quote hides the rest; don't/can't stay. Same rule as the server.
function usUnquote(m){
  const s=String(m==null?'':m); let out='';
  for(let i=0;i<s.length;i++){ const c=s[i];
    if(c!=="'"&&c!=='"'&&c!=='`'){ out+=c; continue; }
    if(c==="'"&&/\w/.test(s[i-1]||'')&&/\w/.test(s[i+1]||'')){ out+=c; continue; }
    const j=s.indexOf(c,i+1);
    if(j<0){ out+=c+'\u2026'; break; }
    out+=c+'\u2026'+c; i=j; }
  return out;
}
const US={acc:null,lastSent:0,paused:false,me:null,mine:null,busy:false,sid:usSid(),
  acts:{}, perf:null, perfDone:false, hiddenSeen:false, errs:new Map()};   // (-110) counters, the paint sample, errors
const US_ACTS_CLIENT=new Set(['csv','drawer-open']), US_ERR_MAX=20, US_ERRS_PER_BEACON=5, US_BODY_MAX=3800;
function usSignedIn(){ return !!(typeof window!=='undefined'&&window.__ME&&window.__ME.uid); }
function usNow(){ return Date.now(); }
function usPwa(){ try{ return !!(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator&&window.navigator.standalone===true; }catch(_){ return false; } }
// Called by showView (backtest.js) on every tab switch — the one door every switch goes through.
function usageView(v){ if(US.acc) usSetTab(US.acc,v,usNow()); }
// (-110) A client-only action: counted, never described. Anything outside the two-word list is
// ignored (the server would drop it anyway); paused or signed out, nothing is counted at all.
function usageAct(k){ if(!US_ACTS_CLIENT.has(k)||US.paused||!usSignedIn()) return; US.acts[k]=Math.min(50,(US.acts[k]||0)+1); }
// (-110) The first markets-table paint (markets.js render). One sample per page load.
function usageFirstPaint(){
  if(US.perfDone) return; US.perfDone=true;
  try{ if(US.hiddenSeen||(typeof document!=='undefined'&&document.visibilityState==='hidden')) return;
    const t=performance.now(); if(t>0&&t<=120000) US.perf=Math.round(t); }catch(_){ }
}
// (-110) Errors: file reduced to this site's path (or "external"), message cut to 200 characters.
function usErrLoc(file){
  const s=String(file||''); if(!s) return '';
  try{ const u=new URL(s,location.href); return u.origin===location.origin?u.pathname:'external'; }catch(_){ return 'external'; }
}
function usageErr(msg,file,line){
  if(US.paused||!usSignedIn()) return;
  const m=Array.from(usUnquote(String(msg==null?'':msg).slice(0,800))).slice(0,200).join('')||'(no message)', f=usErrLoc(file), l=Math.max(0,Math.trunc(+line||0));
  const k=m+'\u0001'+f+':'+l;
  const e=US.errs.get(k);
  if(e){ e.c=Math.min(50,e.c+1); return; }
  if(US.errs.size>=US_ERR_MAX) return;                   // a page that throws in a loop sends the first twenty
  US.errs.set(k,{m,f,l,c:1});
}
// The first frame's file:line out of a stack (the URL and line only — nothing else from it).
function usStackLoc(stack){ const m=/((?:https?|file):\/\/[^\s)]+?):(\d+)(?::\d+)?\)?(?:\n|$)/.exec(String(stack||'')); return m?[m[1],+m[2]]:['',0]; }
function usErrWire(){
  try{ window.addEventListener('error',(e)=>{ try{ if(!e||e.target&&e.target!==window&&!e.message) return;   // a failed <img>/<script> load is not a JS error
    usageErr(e.message||(e.error&&e.error.message),e.filename,e.lineno); }catch(_){ } }); }catch(_){ }
  try{ window.addEventListener('unhandledrejection',(e)=>{ try{ const r=e&&e.reason;
    const msg=r&&typeof r==='object'&&'message' in r?String(r.message):typeof r==='string'?r:Object.prototype.toString.call(r);
    const loc=usStackLoc(r&&r.stack); usageErr('unhandled rejection: '+msg,loc[0],loc[1]); }catch(_){ } }); }catch(_){ }
}
function usageFlush(force){
  if(!US.acc||US.paused||!usSignedIn()) return false;
  const now=usNow();
  if(!force&&US.lastSent&&now-US.lastSent<US_GAP_MS) return false;   // inside the server's gap: keep accumulating
  const tabs=usTake(US.acc,now);
  let tot=0; for(const k in tabs) tot+=tabs[k];
  const acts=US.acts, hasActs=Object.keys(acts).length>0;
  const errs=[...US.errs.values()].filter(e=>e.c>0).slice(0,US_ERRS_PER_BEACON);
  if(tot<1000&&!hasActs&&US.perf==null&&!errs.length){ usGive(US.acc,tabs); return false; }   // under a second is not worth a request
  const out={tabs,pwa:usPwa(),s:US.sid};
  const b=state.bootBuild||state.build; if(b) out.b=String(b);
  if(hasActs) out.acts=acts;
  if(US.perf!=null&&b) out.perf=US.perf;
  if(errs.length&&b) out.errs=errs.map(e=>({m:e.m,f:e.f,l:e.l,c:e.c}));
  let body=JSON.stringify(out);
  while(body.length>US_BODY_MAX&&out.errs&&out.errs.length){ out.errs.pop(); if(!out.errs.length) delete out.errs; body=JSON.stringify(out); }   // the server's 4 KB cap
  let sent=false;
  try{ if(navigator.sendBeacon) sent=navigator.sendBeacon('/api/usage',body); }catch(_){ sent=false; }
  if(!sent){ try{ fetch('/api/usage',{method:'POST',body,keepalive:true,headers:{'content-type':'text/plain'}}).catch(()=>{}); sent=true; }catch(_){ } }
  if(!sent){ usGive(US.acc,tabs); return false; }
  US.acts={}; if(out.perf!=null) US.perf=null;
  for(const e of (out.errs||[])){ const x=US.errs.get(e.m+'\u0001'+e.f+':'+e.l); if(x) x.c=0; }   // sent once; later hits ride as a count
  US.lastSent=now; return true;
}
export function __boot_usage_1(){
  if(!usSignedIn()) return;
  US.paused=!!window.__ME.usagePaused;
  const vis=typeof document==='undefined'||document.visibilityState!=='hidden';
  US.acc=usAcc(usNow(),state.view||'markets',vis);
  const onIn=()=>{ if(US.acc) usInput(US.acc,usNow()); };
  for(const ev of ['pointerdown','pointermove','keydown','wheel','scroll','touchstart'])
    try{ document.addEventListener(ev,onIn,{passive:true,capture:true}); }catch(_){ }
  if(!vis) US.hiddenSeen=true;
  usErrWire();
  try{ document.addEventListener('visibilitychange',()=>{
    const hidden=document.visibilityState==='hidden';
    if(hidden) US.hiddenSeen=true;
    usSetVis(US.acc,!hidden,usNow());
    if(hidden) usageFlush(false); }); }catch(_){ }
  try{ window.addEventListener('pagehide',()=>{ usSetVis(US.acc,false,usNow()); usageFlush(true); }); }catch(_){ }
  setInterval(()=>usageFlush(false),US_FLUSH_MS);
  try{ document.addEventListener('click',(e)=>{ const b=e.target&&e.target.closest&&e.target.closest('[data-uspause]'); if(b) usagePause(b.dataset.uspause==='1'); }); }catch(_){ }
}

// ---- "Your usage": the member sees exactly the summary the operator sees about them -------------
// Lives in the Messages rail, beside the read-through notice (the terminal has no separate Account
// page): same tone, same place people already look for "who can see what".
function usFmtH(ms){ const m=ms/60000; return m<60?Math.round(m)+' min':(m/60).toFixed(1)+'h'; }
// (-110) The feature counters as the member's card names them (the drill-in shows the same row).
const US_ACT_CHIP={call:'calls',target:'targets',alert:'alerts',share:'shares',csv:'CSV exports',ask:'asks','ai-report':'AI reports',
  'drawer-open':'drawer opens','telegram-link':'Telegram links','push-enable':'push turned on'};
function usageCardHtml(){
  if(!usSignedIn()) return '';
  const d=US.mine, paused=US.paused;
  const k=(lbl,val)=>'<div class="us-kpi"><div class="k">'+lbl+'</div><div class="v">'+val+'</div></div>';
  const top=d&&d.tabs&&d.tabs[0]?esc(d.tabs[0].label):'—';
  return '<div class="dm-sh" style="padding:0 0 6px">Your usage</div>'
    // (build 2026.09.24-110 follow-up) everything the member guide (docs.html) lists, in the same order
    +'<div class="us-disc">The operator can see this summary for every member: which tabs you open and for how long (only while the page is visible and you have used it in the last five minutes); roughly which hour of the week that was (Eastern time); the kind of device (desktop, mobile or tablet, installed or not); how many times you use a few features (calls, targets, alerts, shares, CSV exports, asks, AI reports, ticker drawer opens, linking Telegram, turning on push — the count only, never which ticker); and, to catch bugs, how long the page took to first show the markets table, which build your tab is running, and any JavaScript errors it hit (the error message with quoted text removed, cut to 200 characters, and file:line). It never records what you search, which filters or columns you set, or which tickers you look at. Opening your detail is logged in the admin audit. Kept '+((d&&d.keepDays)||30)+' days, then only sitewide totals remain — except a yes/no per week you were active (for join-week retention), kept 8 weeks.</div>'
    +(d&&d.ok&&!paused?'<div class="us-kpis">'+k('active days · '+(d.keepDays||30)+'d',String(d.activeDays||0))+k('on screen',usFmtH(d.ms||0))+k('top tab',top)+'</div>'
      +((d.acts||[]).some(a=>a.n>0)?'<div class="us-acts">'+(d.acts||[]).filter(a=>a.n>0).map(a=>'<span class="acc-chip on">'+esc(US_ACT_CHIP[a.key]||a.key)+' '+(+a.n||0)+'</span>').join('')+'</div>':''):'')
    +'<div class="us-row"><span class="acc-chip'+(paused?'':' on')+'">'+(paused?'paused':'sharing usage')+'</span>'
    +'<button type="button" class="dm-tool" data-uspause="'+(paused?'0':'1')+'"'+(US.busy?' disabled':'')+'>'+(paused?'Resume':'Pause for me')+'</button></div>'
    +'<div class="us-disc" style="margin-top:6px">'+(paused?'Paused: nothing is recorded for this account, and the operator sees “paused”.':'Pausing stops the beacon for this account; the operator sees “paused”.')+'</div>';
}
function usagePaint(){ const box=el('dm-usage'); if(box) box.innerHTML=usageCardHtml(); }
async function usageMeLoad(){
  if(!usSignedIn()) return;
  try{ const r=await fetch('/api/usage/me',{headers:{accept:'application/json'}}); if(r.ok) US.mine=await r.json(); }catch(_){ }
  usagePaint();
}
async function usagePause(on){
  if(US.busy) return;
  US.busy=true; usagePaint();
  try{
    const r=await fetch('/api/usage/pause',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({paused:!!on})});
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d.ok){
      US.paused=!!d.paused; if(window.__ME) window.__ME.usagePaused=US.paused;
      if(US.paused&&US.acc) US.acc.acc={};                    // what was pending goes too: paused means from the click
      if(US.paused){ US.acts={}; US.perf=null; US.errs.clear(); }   // (-110) counters, the paint sample and errors too
      else if(US.acc) US.lastSent=0;
    }
  }catch(_){ }
  US.busy=false; usageMeLoad();
}
export { US, usUnquote, usAcc, usCounting, usGive, usInput, usSetTab, usSetVis, usSettle, usTake, usageAct, usageCardHtml, usageErr, usageFirstPaint, usageFlush, usageMeLoad, usagePaint, usagePause, usageView };
