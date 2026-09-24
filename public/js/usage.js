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
// The server takes one beacon per member per 30s, so a flush inside that gap keeps its minutes and
// rides the next one (hidden time never counts, so holding them costs nothing). Signed-out
// visitors never beacon; a paused member never beacons.
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
const US={acc:null,lastSent:0,paused:false,me:null,mine:null,busy:false};
function usSignedIn(){ return !!(typeof window!=='undefined'&&window.__ME&&window.__ME.uid); }
function usNow(){ return Date.now(); }
function usPwa(){ try{ return !!(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator&&window.navigator.standalone===true; }catch(_){ return false; } }
// Called by showView (backtest.js) on every tab switch — the one door every switch goes through.
function usageView(v){ if(US.acc) usSetTab(US.acc,v,usNow()); }
function usageFlush(force){
  if(!US.acc||US.paused||!usSignedIn()) return false;
  const now=usNow();
  if(!force&&US.lastSent&&now-US.lastSent<US_GAP_MS) return false;   // inside the server's gap: keep accumulating
  const tabs=usTake(US.acc,now);
  let tot=0; for(const k in tabs) tot+=tabs[k];
  if(tot<1000){ usGive(US.acc,tabs); return false; }                 // under a second is not worth a request
  const body=JSON.stringify({tabs,pwa:usPwa()});
  let sent=false;
  try{ if(navigator.sendBeacon) sent=navigator.sendBeacon('/api/usage',body); }catch(_){ sent=false; }
  if(!sent){ try{ fetch('/api/usage',{method:'POST',body,keepalive:true,headers:{'content-type':'text/plain'}}).catch(()=>{}); sent=true; }catch(_){ } }
  if(!sent){ usGive(US.acc,tabs); return false; }
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
  try{ document.addEventListener('visibilitychange',()=>{
    const hidden=document.visibilityState==='hidden';
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
function usageCardHtml(){
  if(!usSignedIn()) return '';
  const d=US.mine, paused=US.paused;
  const k=(lbl,val)=>'<div class="us-kpi"><div class="k">'+lbl+'</div><div class="v">'+val+'</div></div>';
  const top=d&&d.tabs&&d.tabs[0]?esc(d.tabs[0].label):'—';
  return '<div class="dm-sh" style="padding:0 0 6px">Your usage</div>'
    +'<div class="us-disc">The operator can see this summary for every member: which tabs you open, for how long, and from what kind of device. It never records what you search, which filters you set, or which tickers you look at. Opening your detail is logged in the admin audit. Kept '+((d&&d.keepDays)||30)+' days, then only sitewide totals remain.</div>'
    +(d&&d.ok&&!paused?'<div class="us-kpis">'+k('active days · '+(d.keepDays||30)+'d',String(d.activeDays||0))+k('on screen',usFmtH(d.ms||0))+k('top tab',top)+'</div>':'')
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
      else if(US.acc) US.lastSent=0;
    }
  }catch(_){ }
  US.busy=false; usageMeLoad();
}
export { US, usAcc, usCounting, usGive, usInput, usSetTab, usSetVis, usSettle, usTake, usageCardHtml, usageFlush, usageMeLoad, usagePaint, usagePause, usageView };
