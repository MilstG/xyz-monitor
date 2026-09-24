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
// (build 2026.09.24-111) And two more:
//   h     the same minutes split by the clock hour they were spent in ({UTC hour index -> ms}; an ET
//         hour is a whole UTC hour, so the server maps each to its ET weekday × hour): the heatmap no
//         longer buckets by when the beacon ARRIVED. The server keeps only the hours of the beacon's
//         own wall-time window and never more than the screen time it accepted.
//   ld    1 on the page load's first beacon that carries the build: page loads per build, the
//         denominator of the operator's post-deploy error-rate check. A count, nothing else.
import { el, esc, state } from "./core.js";

const US_IDLE_MS=5*60000, US_FLUSH_MS=60000, US_GAP_MS=30000, US_INPUT_THROTTLE=1000;
// ---- the accumulator (pure: every entry point takes `now`, so the tests drive it with a fake clock) ----
function usAcc(now,tab,vis){ const a={acc:{},hr:{},tab:tab||null,vis:vis!==false,lastIn:now,since:null}; a.since=usCounting(a,now)?now:null; return a; }
function usCounting(a,now){ return !!(a.tab&&a.vis&&now-a.lastIn<US_IDLE_MS); }
// Close the open segment: count [since, min(now, lastInput+idle)], then reopen it if still counting.
// (-111) The same span is also split at clock-hour boundaries into a.hr (hour index -> ms).
function usHrAdd(a,from,to){ let x=from; while(x<to){ const h=Math.floor(x/3600000), e=Math.min(to,(h+1)*3600000); a.hr[h]=(a.hr[h]||0)+(e-x); x=e; } }
function usSettle(a,now){
  if(a.since!=null&&a.tab){ const end=Math.min(now,a.lastIn+US_IDLE_MS); if(end>a.since){ a.acc[a.tab]=(a.acc[a.tab]||0)+(end-a.since); usHrAdd(a,a.since,end); } }
  a.since=usCounting(a,now)?now:null; }
function usSetTab(a,tab,now){ usSettle(a,now); a.tab=tab||null; a.since=usCounting(a,now)?now:null; }
function usSetVis(a,vis,now){ usSettle(a,now); a.vis=!!vis; a.since=usCounting(a,now)?now:null; }
function usInput(a,now){ if(now-a.lastIn<US_INPUT_THROTTLE&&a.since!=null) return; usSettle(a,now); a.lastIn=now; a.since=usCounting(a,now)?now:null; }
// Hand over what has accumulated (whole ms, zero tabs dropped) and start a fresh map.
function usTake(a,now){ usSettle(a,now); const out={}; for(const k in a.acc){ const v=Math.round(a.acc[k]); if(v>0) out[k]=v; } a.acc={}; return out; }
// (-111) The hour split of what usTake just handed over (call right after it): whole ms, empties dropped.
function usTakeHr(a){ const out={}; for(const k in a.hr){ const v=Math.round(a.hr[k]); if(v>0) out[k]=v; } a.hr={}; return out; }
function usGive(a,tabs,hr){ for(const k in tabs) a.acc[k]=(a.acc[k]||0)+tabs[k]; for(const k in (hr||{})) a.hr[k]=(a.hr[k]||0)+hr[k]; }   // a flush that could not go out puts its minutes back

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
  acts:{}, perf:null, perfDone:false, hiddenSeen:false, errs:new Map(),   // (-110) counters, the paint sample, errors
  ldSent:false,   // (-111) this page load has been counted
  tr:null, ctl:{}, srch:{}};   // (build 2026.09.24-112) the tab-path accumulator, control counts, search-burst stamps

// ---- (build 2026.09.24-112) SITEWIDE tab paths and control usage ---------------------------------
// Both ride the same beacon and are stored by the server WITHOUT a member id (uid '0', the sitewide
// bucket): the operator sees "Markets → Trend 412 times", never who. Paused members send nothing.
//
// The control ALLOWLIST: the one table of every UI control that is counted. The server parses THIS
// TEXT between the two marker comments as strict JSON at boot (src/usage-controls.js) and drops any
// key not in it, so the table must stay JSON: double quotes, no comments inside, no trailing commas.
// { group: { control: [values] } } — a group is a tab id, or 'header' (above every tab) or 'drawer'
// (the ticker drawer, which has no collapsible sections: its per-section "go deeper" controls are
// what is counted). Keys: '<group>.<control>' when the list is empty, else '<group>.<control>=<value>'.
// Values are fixed option sets — column ids, window lengths, preset ids — never text, never a ticker,
// never a number someone typed. Search boxes count "used" (one typing burst), never what was typed.
const US_CONTROLS=/*US_CONTROLS{*/{
  "header":{"scope":["stocks","crypto"],"search":[]},
  "markets":{"window":["1h","4h","1d","7d","30d"],"group":["names","sectors","industries"],"weight":["vol","eq"],
    "preset":["watch","notes","pos","clear"],"search":[],"csv":[],"share":[],
    "col-on":["sess","px","funding","prem","m5","m15","h1","h4","d1","vcc","dopen","hopen","h4open","h12open","d7","d30","gap","trend","rs","rscc","vstape","dvb","dcap","hitr","rvol","beta","mom","momp","vol30","adr","dd","swr","ddy","yopen","mopen","doi","sqz","cascT","liq24","carry","vol","oi","pos","ma20","ma50","ma100","ma200","vwap","vsvwap","turn"],
    "col-off":["sess","px","funding","prem","m5","m15","h1","h4","d1","vcc","dopen","hopen","h4open","h12open","d7","d30","gap","trend","rs","rscc","vstape","dvb","dcap","hitr","rvol","beta","mom","momp","vol30","adr","dd","swr","ddy","yopen","mopen","doi","sqz","cascT","liq24","carry","vol","oi","pos","ma20","ma50","ma100","ma200","vwap","vsvwap","turn"]},
  "trend":{"side":["long","short"],"share":[]},
  "sectors":{"window":["1h","4h","1d","7d","30d"],"weight":["vol","eq"],"grouping":["sector","ind"],"view":["flow","leaders"],"csv":[],"share":[]},
  "corr":{"lookback":["30","90","180","365"],"top":["20","40","60"],"pairs":["10","20"],"search":[],"csv":[]},
  "drawdown":{"since":["30","60","90","180","ytd","365"],"csv":[],"share":[]},
  "funding":{"share":[]},
  "charts":{"share":[]},
  "signals":{"search":[]},
  "actionable":{"side":["all","long","short"],"share":[]},
  "backtest":{"csv":[]},
  "news":{"search":[]},
  "drawer":{"candles":["3","7","14","30","90"],"ledger-full":[],"news-all":[],"derivs-refresh":[],"share":[]}
}/*}US_CONTROLS*/;
function usCtlKeys(T){ const out=[]; for(const g of Object.keys(T)) for(const c of Object.keys(T[g])){ const v=T[g][c]; if(!v.length) out.push(g+'.'+c); else for(const x of v) out.push(g+'.'+c+'='+x); } return out; }
const US_CTL_SET=new Set(usCtlKeys(US_CONTROLS));
const US_CTL_N_MAX=20, US_CTL_KEYS_MAX=40, US_TR_BOUNCE_MS=2000, US_TR_N_MAX=30, US_TR_KEYS_MAX=40, US_SEARCH_BURST_MS=10000;
// Tab paths (pure; `now` passed in, like the accumulator above). A transition from→to counts once the
// destination has held the screen for 2s: a tab left inside 2s is a bounce and is skipped, so
// A → B (1s) → C counts A→C, and A → B (1s) → A counts nothing. Re-selecting the tab you are on is not
// a transition. The first tab that holds for 2s is the page load's ENTRY tab (once per load).
// (build 2026.09.24-114) Only VISIBLE time holds a tab: the dwell clock stops while the page is hidden
// (`hid` = when it went hidden; on return `at` moves forward by the hidden span), so an hour in a
// background tab never turns a 1s bounce into a move, and a page opened in the background has no entry
// tab until it has been on screen for 2s.
function usTr(now,tab,vis){ return {cur:tab||null,at:now,last:null,done:false,tr:{},en:null,enDone:false,hid:vis===false?now:null}; }
function usTrSettle(t,now){
  if(!t.cur||t.done||(t.hid!=null?t.hid:now)-t.at<US_TR_BOUNCE_MS) return;
  if(t.last==null){ if(!t.enDone){ t.en=t.cur; t.enDone=true; } }
  else if(t.last!==t.cur){ const k=t.last+'>'+t.cur;
    if(k in t.tr||Object.keys(t.tr).length<US_TR_KEYS_MAX) t.tr[k]=Math.min(US_TR_N_MAX,(t.tr[k]||0)+1); }
  t.last=t.cur; t.done=true;
}
function usTrView(t,v,now){ if(!v||v===t.cur) return; usTrSettle(t,now); t.cur=v; t.at=now; t.done=false; if(t.hid!=null) t.hid=now; }
// (-114) the page went hidden / came back: settle what already held, then pause / resume the dwell clock
function usTrVis(t,vis,now){
  if(!vis){ if(t.hid==null){ usTrSettle(t,now); t.hid=now; } }
  else if(t.hid!=null){ t.at+=Math.max(0,now-t.hid); t.hid=null; }
}
// Hand over what has settled (the tab on screen now counts if it has held 2s) and start fresh.
function usTrTake(t,now){ usTrSettle(t,now); const out={tr:t.tr,en:t.en}; t.tr={}; t.en=null; return out; }
function usTrGive(t,x){ for(const k in (x.tr||{})) t.tr[k]=Math.min(US_TR_N_MAX,(t.tr[k]||0)+x.tr[k]); if(x.en&&!t.en) t.en=x.en; }
// One control use, at the control's own handler. Anything outside the allowlist is ignored here (and
// dropped by the server); paused or signed out, nothing is counted at all.
function usageCtl(k){
  if(!US_CTL_SET.has(k)||US.paused||!usSignedIn()) return false;
  if(!(k in US.ctl)&&Object.keys(US.ctl).length>=US_CTL_KEYS_MAX) return false;
  US.ctl[k]=Math.min(US_CTL_N_MAX,(US.ctl[k]||0)+1); return true;
}
// A search box "used": one count per typing burst (no input for 10s ends the burst). The text is
// never read — the handler passes only which box it is.
function usageSearch(k,now){
  const t=now!=null?now:usNow(), last=US.srch[k]||0; US.srch[k]=t;
  return t-last>US_SEARCH_BURST_MS?usageCtl(k):false;
}
const US_ACTS_CLIENT=new Set(['csv','drawer-open']), US_ERR_MAX=20, US_ERRS_PER_BEACON=5, US_BODY_MAX=3800;
function usSignedIn(){ return !!(typeof window!=='undefined'&&window.__ME&&window.__ME.uid); }
function usNow(){ return Date.now(); }
function usPwa(){ try{ return !!(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator&&window.navigator.standalone===true; }catch(_){ return false; } }
// Called by showView (backtest.js) on every tab switch — the one door every switch goes through.
function usageView(v){ const now=usNow(); if(US.acc) usSetTab(US.acc,v,now); if(US.tr&&!US.paused) usTrView(US.tr,v,now); }   // (-112) + the tab path
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
  const tabs=usTake(US.acc,now), hr=usTakeHr(US.acc);
  let tot=0; for(const k in tabs) tot+=tabs[k];
  const acts=US.acts, hasActs=Object.keys(acts).length>0;
  const errs=[...US.errs.values()].filter(e=>e.c>0).slice(0,US_ERRS_PER_BEACON);
  // (-112) the settled tab paths, the entry tab (once per load) and the control counts
  const tp=US.tr?usTrTake(US.tr,now):{tr:{},en:null}, ctl=US.ctl, hasTr=Object.keys(tp.tr).length>0, hasCtl=Object.keys(ctl).length>0;
  if(tot<1000&&!hasActs&&US.perf==null&&!errs.length&&!hasTr&&!hasCtl&&!tp.en){ usGive(US.acc,tabs,hr); return false; }   // under a second is not worth a request
  const out={tabs,pwa:usPwa(),s:US.sid};
  if(hasTr) out.tr=tp.tr;
  if(tp.en) out.en=tp.en;
  if(hasCtl) out.ctl=ctl;
  if(tot>0&&Object.keys(hr).length) out.h=hr;
  const b=state.bootBuild||state.build; if(b) out.b=String(b);
  if(b&&!US.ldSent) out.ld=1;
  if(hasActs) out.acts=acts;
  if(US.perf!=null&&b) out.perf=US.perf;
  if(errs.length&&b) out.errs=errs.map(e=>({m:e.m,f:e.f,l:e.l,c:e.c}));
  let body=JSON.stringify(out);
  while(body.length>US_BODY_MAX&&out.errs&&out.errs.length){ out.errs.pop(); if(!out.errs.length) delete out.errs; body=JSON.stringify(out); }   // the server's 4 KB cap
  for(const f of ['ctl','tr']) while(body.length>US_BODY_MAX&&out[f]){ const ks=Object.keys(out[f]); delete out[f][ks[ks.length-1]]; if(ks.length<=1) delete out[f]; body=JSON.stringify(out); }   // (-112) never reached at the caps; a bound all the same
  let sent=false;
  try{ if(navigator.sendBeacon) sent=navigator.sendBeacon('/api/usage',body); }catch(_){ sent=false; }
  if(!sent){ try{ fetch('/api/usage',{method:'POST',body,keepalive:true,headers:{'content-type':'text/plain'}}).catch(()=>{}); sent=true; }catch(_){ } }
  if(!sent){ usGive(US.acc,tabs,hr); if(US.tr) usTrGive(US.tr,tp); return false; }   // (-112) the paths go back too; ctl was never cleared
  US.acts={}; US.ctl={}; if(out.perf!=null) US.perf=null; if(out.ld) US.ldSent=true;
  for(const e of (out.errs||[])){ const x=US.errs.get(e.m+'\u0001'+e.f+':'+e.l); if(x) x.c=0; }   // sent once; later hits ride as a count
  US.lastSent=now; return true;
}
export function __boot_usage_1(){
  if(!usSignedIn()) return;
  US.paused=!!window.__ME.usagePaused;
  const vis=typeof document==='undefined'||document.visibilityState!=='hidden';
  US.acc=usAcc(usNow(),state.view||'markets',vis);
  US.tr=usTr(usNow(),state.view||'markets',vis);   // (-112) this page load's tab path starts on the tab it opened on; (-114) its clock runs only while visible
  const onIn=()=>{ if(US.acc) usInput(US.acc,usNow()); };
  for(const ev of ['pointerdown','pointermove','keydown','wheel','scroll','touchstart'])
    try{ document.addEventListener(ev,onIn,{passive:true,capture:true}); }catch(_){ }
  if(!vis) US.hiddenSeen=true;
  usErrWire();
  try{ document.addEventListener('visibilitychange',()=>{
    const hidden=document.visibilityState==='hidden';
    if(hidden) US.hiddenSeen=true;
    usSetVis(US.acc,!hidden,usNow());
    if(US.tr) usTrVis(US.tr,!hidden,usNow());   // (-114) hidden time never holds a tab
    if(hidden) usageFlush(false); }); }catch(_){ }
  try{ window.addEventListener('pagehide',()=>{ usSetVis(US.acc,false,usNow()); if(US.tr) usTrVis(US.tr,false,usNow()); usageFlush(true); }); }catch(_){ }
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
// (build 2026.09.24-111) The monthly rows kept about this member, shown as kept: this month and last.
function usMonthsHtml(d){
  const m=(d&&d.months)||[]; if(!m.length) return '';
  const nm=(k)=>{ try{ return new Date(String(k)+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'long',timeZone:'UTC'}); }catch(_){ return String(k); } };
  return '<div class="us-disc" style="margin:0 0 6px">'+m.map(x=>esc(nm(x.key))+': '+usFmtH(+x.ms||0)+' · '+(+x.days||0)+' active day'+(x.days===1?'':'s')).join(' — ')+'</div>';
}
function usageCardHtml(){
  if(!usSignedIn()) return '';
  const d=US.mine, paused=US.paused;
  const k=(lbl,val)=>'<div class="us-kpi"><div class="k">'+lbl+'</div><div class="v">'+val+'</div></div>';
  const top=d&&d.tabs&&d.tabs[0]?esc(d.tabs[0].label):'—';
  return '<div class="dm-sh" style="padding:0 0 6px">Your usage</div>'
    // (build 2026.09.24-110 follow-up) everything the member guide (docs.html) lists, in the same order
    +'<div class="us-disc">The operator can see this summary for every member: which tabs you open and for how long (only while the page is visible and you have used it in the last five minutes); roughly which hour of the week that was (Eastern time); the kind of device (desktop, mobile or tablet, installed or not); how many times you use a few features (calls, targets, alerts, shares, CSV exports, asks, AI reports, ticker drawer opens, linking Telegram, turning on push — the count only, never which ticker); and, to catch bugs, how long the page took to first show the markets table, which build your tab is running, how many times you load the page, and any JavaScript errors it hit (the error message with quoted text removed, cut to 200 characters, and file:line). It never records what you search, which tickers you look at or your filter values, and which filters or columns you set is never linked to you. Opening your detail is logged in the admin audit. Kept '+((d&&d.keepDays)||30)+' days, then only sitewide totals remain — except a yes/no per week you were active (for join-week retention), kept 8 weeks, and one total per month (minutes on screen and active days, for month-over-month trends), kept for this month and last.</div>'
    // (build 2026.09.24-112) the sitewide-only counts, said separately because nobody's name is on them
    +'<div class="us-disc">Also collected, sitewide and not linked to you (totals with no member attached, kept 30 days): navigation paths — which tab people move to from which, and the first tab a page load settles on; control-usage counts from a fixed list — the Markets column picker (which column), window and scope buttons, filter presets (the preset name only), CSV and share buttons, drawer sections, and whether a search box was used (never the text); and screen time per tab by device class. Never text, never tickers, never filter values beyond those preset names. Paused, you add nothing to these either. The operator sees these only for ranges of 7 or more complete days (never today) in which at least 3 members contributed on one day; below that the fold says “not enough members to show without identifying someone (n&lt;3)”, since a “sitewide” count from one or two people could identify them.</div>'
    +(d&&d.ok&&!paused?'<div class="us-kpis">'+k('active days · '+(d.keepDays||30)+'d',String(d.activeDays||0))+k('on screen',usFmtH(d.ms||0))+k('top tab',top)+'</div>'
      +usMonthsHtml(d)
      +((d.acts||[]).some(a=>a.n>0)?'<div class="us-acts">'+(d.acts||[]).filter(a=>a.n>0).map(a=>'<span class="acc-chip on">'+esc(US_ACT_CHIP[a.key]||a.key)+' '+(+a.n||0)+'</span>').join('')+'</div>':''):'')
    +'<div class="us-row"><span class="acc-chip'+(paused?'':' on')+'">'+(paused?'paused':'sharing usage')+'</span>'
    +'<button type="button" class="dm-tool" data-uspause="'+(paused?'0':'1')+'"'+(US.busy?' disabled':'')+'>'+(paused?'Resume':'Pause for me')+'</button></div>'
    +'<div class="us-disc" style="margin-top:6px">'+(paused?'Paused: nothing is recorded for this account, and the operator sees “paused”.':'Pausing stops the beacon for this account; the operator sees “paused”.')+'</div>'
    // (build 2026.09.24-113) the opt-in lapsed-member reminder, and how to avoid it
    +'<div class="us-disc" style="margin-top:6px">Reminders: if the operator turns them on, a member who was active and then goes a week without using the terminal may get one friendly reminder (at most once every 30 days) with a few market lines — on the Telegram or browser push you already linked, never email or SMS, and nothing if you have neither. To never get one, pause usage here (paused accounts are never reminded). '+(d&&d.ok?'Reminders are currently <b>'+(d.nudgeOn?'on':'off')+'</b>.':'')+'</div>';
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
      if(US.paused){ US.acts={}; US.perf=null; US.errs.clear(); US.ctl={}; US.tr=null; }   // (-110) counters, the paint sample and errors too; (-112) paths and controls
      else { if(US.acc) US.lastSent=0;
        // (-112) a fresh path from the tab on screen; this load's entry tab is not counted again
        US.tr=usTr(usNow(),state.view||'markets',typeof document==='undefined'||document.visibilityState!=='hidden'); US.tr.enDone=true; }
    }
  }catch(_){ }
  US.busy=false; usageMeLoad();
}
export { US, US_CONTROLS, US_CTL_SET, usCtlKeys, usTr, usTrGive, usTrSettle, usTrTake, usTrView, usTrVis, usageCtl, usageSearch, usUnquote, usAcc, usCounting, usGive, usHrAdd, usInput, usSetTab, usSetVis, usSettle, usTake, usTakeHr, usageAct, usageCardHtml, usageErr, usageFirstPaint, usageFlush, usageMeLoad, usagePaint, usagePause, usageView };
