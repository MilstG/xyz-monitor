// admin.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { accWire, admDmWire, admFoldApply, admFoldWire, loadAccess, loadAdmDm, renderAccess, renderAdmDm } from "./access.js";
import { HASH_VIEWS, pushToast, schedDaysClient } from "./alerts.js";
import { showView } from "./backtest.js";
import { clamp, el, esc, fmtUsd, lerp, state } from "./core.js";
import { _lastHealth, fetchJSON, renderAdmLoop, updateFreshTray } from "./data.js";
import { openDetail } from "./drawer.js";
import { FOC, focFetch } from "./focus.js";
import { homeWallToEtMin, sessEx } from "./markets.js";
import { TAB_GROUPS, applyTabVisibility, buildTabGroups, wireTabDrag } from "./nav.js";
import { drawSessions } from "./positioning.js";
import { shPanel } from "./share.js";
import { termFind } from "./terminal.js";
import { loadPush, pushAct, pushState } from "./triggers.js";

// ===== admin panel: feature visibility switchboard =============================================
// Reads /api/features (manifest + raw states + BOTH resolved audiences). Writes one key per call and
// rolls back on failure — a batch write would make a partial failure ambiguous, and there is no save
// button because a draft state is another way for the panel and the server to disagree.
let _adm=null, _admVap=false, _admBusy='';
async function openAdmin(){ if(!IS_ADMIN) return;
  admFoldWire();
  renderAdmLoop(_lastHealth); updateFreshTray(); renderAdmin(); renderAudit(); loadAudit();
  renderAdmFloors(); loadAdmFloors(); accWire(); renderAccess(); loadAccess();
  admDmWire(); renderAdmDm(); loadAdmDm();
  // After renderAdmLoop, so the loop fold knows whether its row has anything to show.
  admFoldApply();
  await loadAdmin();
  admFoldApply(); }
async function loadAdmin(){
  try{ _adm=await fetchJSON('/api/features'); }
  catch(e){ _adm={error:String(e&&e.message||e)}; }
  renderAdmin(); }
// ===== admin panel: weekly classification audit =================================================
// Reads /api/sector-audit (the folded record log). Three verbs, all admin-gated server-side:
// revert an applied entry (pins it against auto re-apply), resolve a flagged name to one of the
// sectors the sources offered, run the audit now. Every row's evidence is the persisted blob the
// decision actually saw, rendered as a hover title — nothing here re-derives or summarizes it.
let _aud=null,_audBusy=false,_audShowAck=false;
async function loadAudit(){ try{ _aud=await fetchJSON('/api/sector-audit'); }catch(e){ _aud={error:String(e&&e.message||e)}; } renderAudit(); }
function audIndOf(host,t){ const sel='.aud-ind[data-t="'+(window.CSS&&CSS.escape?CSS.escape(t):t)+'"]';
  const i=host.querySelector(sel); return i&&i.value?i.value.trim():''; }
function audEvTitle(ev){ if(!ev) return ''; const parts=[];
  for(const k of ['reason','resolvedFrom','confidence','name','expectedName','edgarName','exchange','ipo','finnhubIndustry','sic','finnSector','sicSector','error'])
    if(ev[k]!=null&&ev[k]!=='') parts.push(k+': '+(k==='confidence'?Number(ev[k]).toFixed(2):ev[k]));
  return esc(parts.join(' \u00b7 ')); }
async function audPost(url,body){ if(_audBusy) return; _audBusy=true; renderAudit();
  try{ const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok) pushToast('audit: '+(d.error||('HTTP '+r.status)));
  }catch(e){ pushToast('audit: '+String(e&&e.message||e)); }
  _audBusy=false; await loadAudit(); }
function renderAudit(){
  const host=el('admAuditBox'); if(!host) return;
  if(!_aud){ host.innerHTML='<div class="aud-head"><div class="aud-title">Classification audit</div><div class="aud-sub">Loading\u2026</div></div>'; return; }
  if(_aud.error){ host.innerHTML='<div class="aud-head"><div class="aud-title">Classification audit</div><div class="aud-sub">could not load \u2014 '+esc(_aud.error)+'</div></div>'; return; }
  const fmtT=(ts)=>ts?new Date(ts).toISOString().slice(0,16).replace('T',' ')+' UTC':'never';
  let h='<div class="aud-head"><div class="aud-title">Classification audit</div>'
    +'<div class="aud-sub">weekly \u00b7 Sundays 12:00 UTC \u00b7 last run '+fmtT(_aud.lastRun)
    +(_aud.lastRunRec?' ('+(_aud.lastRunRec.applied||0)+' applied, '+(_aud.lastRunRec.flagged||0)+' flagged'+(_aud.lastRunRec.err?' \u00b7 '+esc(_aud.lastRunRec.err):'')+')':'')
    +'</div><button class="btn" id="audRun" style="margin-left:auto"'+(_audBusy||_aud.running?' disabled':'')
    +' title="Run the audit now instead of waiting for Sunday \u2014 same gates, same record log">'+(_aud.running?'running\u2026':'\u25b8 run now')+'</button></div>';
  const appliedAll=_aud.applied||[], flagged=_aud.flagged||[];
  const acked=appliedAll.filter(a=>a.ack), applied=_audShowAck?appliedAll:appliedAll.filter(a=>!a.ack);
  if(!appliedAll.length&&!flagged.length) h+='<div class="msg">Nothing applied or flagged \u2014 every roster name resolves against the curated tables.</div>';
  if(applied.length){ h+='<div class="aud-grp">Applied \u00b7 overlay active'
      +(acked.length?' <a href="#" id="audAckTog" style="float:right;font-size:var(--fs-xs)" title="Cleared rows are hidden acknowledgements \u2014 their overlay entries are still active on the board">'+(_audShowAck?'hide cleared':'show cleared ('+acked.length+')')+'</a>':'')+'</div>';
    for(const a of applied){ const grad=a.action==='graduate';
      h+='<div class="aud-row'+(a.ack?' reverted':'')+'"><div class="aud-top"><div><b>'+esc(a.ticker)+'</b>'
        +'<span class="aud-badge '+(grad?'grad':'cls')+'">'+(grad?'GRADUATED':'CLASSIFIED')+'</span>'
        +(a.by==='admin'?'<span class="aud-badge adm" title="applied manually by an admin resolving a flag">admin</span>':'')
        +esc(grad?('Pre-IPO \u2192 Equity \u00b7 '+a.sector):(a.sector+(a.ind&&a.ind!==a.sector?' / '+a.ind:'')))+'</div>'
        +'<span style="white-space:nowrap">'+(a.ack?'':'<button class="aud-fix aud-ack" data-t="'+esc(a.ticker)+'"'+(_audBusy?' disabled':'')
        +' title="Clear this row from the panel \u2014 acknowledgement only: the overlay entry STAYS ACTIVE and the board keeps this classification. It resurfaces automatically if the audit ever re-applies with new evidence.">clear</button>')
        +'<button class="aud-rev" data-t="'+esc(a.ticker)+'"'+(_audBusy?' disabled':'')
        +' title="Remove this overlay entry \u2014 the ticker reverts to its table classification and is PINNED: the audit will never auto re-apply it">revert</button></span></div>'
        +'<div class="aud-ev" title="'+audEvTitle(a.ev)+'">'+fmtT(a.ts)+' \u00b7 '+audEvTitle(a.ev).slice(0,180)+'</div></div>'; } }
  if(flagged.length){ h+='<div class="aud-grp">Flagged \u00b7 no auto-write</div>';
    for(const f of flagged){ const ev=f.ev||{};
      // sources-disagree offers BOTH sectors the evidence named as one-click resolutions.
      const opts=f.reason==='sources-disagree'?[ev.finnSector,ev.sicSector].filter(Boolean):(f.reason==='single-source'?[ev.finnSector||ev.sicSector].filter(Boolean):[]);
      // No source offered a sector (no-data / error): the admin picks one. Manual applies are
      // by:"admin"-stamped overlay entries with the full revert/pin machinery — same as always.
      const pick=!opts.length&&f.action!=='graduate'&&(_aud.gics||[]).length;
      h+='<div class="aud-row flag"><div class="aud-top"><div><b>'+esc(f.ticker)+'</b>'
        +'<span class="aud-badge hold">'+esc((f.reason||'hold').toUpperCase().replace(/-/g,' '))+'</span>'
        +opts.map(o=>'<button class="aud-fix" data-t="'+esc(f.ticker)+'" data-s="'+esc(o)+'"'+(_audBusy?' disabled':'')
          +' title="Resolve this hold: apply '+esc(o)+' as an admin-stamped overlay entry">apply '+esc(o)+'</button>').join('')
        +(pick?'<span style="white-space:nowrap"><select class="aud-sel" data-t="'+esc(f.ticker)+'" title="No source offered a sector \u2014 pick one to classify this name manually (admin-stamped, revertable)"><option value="">sector\u2026</option>'
          +_aud.gics.map(g=>'<option>'+esc(g)+'</option>').join('')+'</select>'
          +'<button class="aud-fix aud-go" data-t="'+esc(f.ticker)+'"'+(_audBusy?' disabled':'')
          +' title="Apply the chosen sector (and industry, if typed) as an admin-stamped overlay entry \u2014 same revert/pin machinery as auto applies">apply</button></span>':'')
        +((pick||opts.length)?'<input class="aud-ind" data-t="'+esc(f.ticker)+'" maxlength="40" placeholder="industry (optional)" title="Optional industry group for the sectors tab \u2014 blank falls back to the sector name (renders italic like every fallback group)">':'')
        +'</div></div>'
        +'<div class="aud-ev" title="'+audEvTitle(f.ev)+'">'+fmtT(f.ts)+' \u00b7 '+audEvTitle(f.ev).slice(0,180)+'</div></div>'; } }
  if((_aud.pinned||[]).length) h+='<div class="aud-sub" style="margin-top:6px" title="Reverted names \u2014 the audit never auto re-applies these; only a manual apply can">pinned: '+_aud.pinned.map(esc).join(', ')+'</div>';
  host.innerHTML=h;
  const rb=el('audRun'); if(rb) rb.addEventListener('click',()=>audPost('/api/sector-audit/run',{}));
  host.querySelectorAll('.aud-rev').forEach(b=>b.addEventListener('click',()=>audPost('/api/sector-audit/revert',{ticker:b.dataset.t})));
  host.querySelectorAll('.aud-fix:not(.aud-go):not(.aud-ack)').forEach(b=>b.addEventListener('click',()=>audPost('/api/sector-audit/apply',{ticker:b.dataset.t,sector:b.dataset.s,ind:audIndOf(host,b.dataset.t)})));
  host.querySelectorAll('.aud-ack').forEach(b=>b.addEventListener('click',()=>audPost('/api/sector-audit/ack',{ticker:b.dataset.t})));
  host.querySelectorAll('.aud-go').forEach(b=>b.addEventListener('click',()=>{
    const sel=host.querySelector('.aud-sel[data-t="'+(window.CSS&&CSS.escape?CSS.escape(b.dataset.t):b.dataset.t)+'"]');
    const sec=sel&&sel.value; if(!sec){ pushToast('audit: pick a sector first'); return; }
    audPost('/api/sector-audit/apply',{ticker:b.dataset.t,sector:sec,ind:audIndOf(host,b.dataset.t)}); }));
  const tog=el('audAckTog'); if(tog) tog.addEventListener('click',(e)=>{ e.preventDefault(); _audShowAck=!_audShowAck; renderAudit(); });
}
// ===== admin panel: FOCUS liquidity floors (build 2026.08.18-03) ===============================
// Two walls — 24h notional and open interest — under which a name is not considered for a seat,
// because a seat you cannot exit at your clip is not a seat. Everything here is drawn from the
// SERVER's structural scan (/api/focus/limits), not from the markets snapshot in this browser: the
// engine's eligible universe excludes home-market names, delisted rows and anything without a live
// mark, and a histogram counting a different field than the gate would make every survivor count
// it prints a lie.
// The survivor counts for an UNSAVED value are necessarily a client-side projection — the server
// has not been asked yet — so they run the same predicate shape the gate does and are labelled as
// a projection. Once saved, the authoritative numbers arrive on the focus payload with the stamp.
let _admFl=null,_admFlBusy=false,_admFlDirty=false,_admFlV=null,_admFlO=null;
async function loadAdmFloors(){
  try{ _admFl=await fetchJSON('/api/focus/limits'); _admFlV=_admFl.limits.vol; _admFlO=_admFl.limits.oi; _admFlDirty=false; }
  catch(e){ _admFl={error:String(e&&e.message||e)}; }
  renderAdmFloors(); }
// Projection of the wall over the server's scan. Mirrors compute.focusFloorFail exactly, including
// the rule that a null OI never fails the OI floor — refusing a name on a number we do not have is
// a fabricated rejection. If this ever drifts from the server, the saved payload's own counts
// (which the panel prints beside the projection) will disagree visibly rather than silently.
function admFlProject(vol,oi){
  const scan=(_admFl&&_admFl.scan)||[];
  const pass=[],below=[];
  for(const s of scan){ const fv=!(s[1]>=vol), fo=(s[2]!=null&&s[2]<oi);
    if(fv||fo) below.push({t:s[0],vol:s[1],oi:s[2],cl:s[3],why:fv&&fo?'both':fv?'vol':'oi'}); else pass.push(s); }
  return {pass,below};
}
// Log-bucket histogram with a per-bar readout (hover contract: every bar states its range, its
// count, the names inside it and which side of the wall it sits on) plus a draggable floor line.
function admFlHist(key,idx,floor){
  const W=520,H=132,PADB=18,PADT=8,LO=4,HI=8.6,NB=18,STEP=(HI-LO)/NB;
  const scan=(_admFl&&_admFl.scan)||[];
  const bins=Array.from({length:NB},(_,i)=>({a:LO+i*STEP,b:LO+(i+1)*STEP,n:[]}));
  let noRead=0;
  for(const s of scan){ const v=s[idx];
    if(v==null||!(v>0)){ noRead++; continue; }
    let i=Math.floor((Math.log10(v)-LO)/STEP); i=Math.max(0,Math.min(NB-1,i)); bins[i].n.push(s[0]); }
  const max=Math.max(1,...bins.map(b=>b.n.length));
  const x=lg=>((lg-LO)/(HI-LO))*W, fLg=Math.log10(Math.max(floor,1));
  let g='';
  for(const b of bins){
    const bw=W/NB, bx=x(b.a), bh=(b.n.length/max)*(H-PADB-PADT);
    const cut=b.b<=fLg||(b.a<fLg&&b.b>fLg);
    const tip=fmtUsd(Math.pow(10,b.a))+' \u2013 '+fmtUsd(Math.pow(10,b.b))+' \u00b7 '+b.n.length+' name'+(b.n.length===1?'':'s')
      +(b.n.length?' \u00b7 '+b.n.slice(0,8).join(' ')+(b.n.length>8?' +'+(b.n.length-8):''):'')
      +' \u00b7 '+(cut?'below your floor':'clears your floor');
    g+='<rect class="admfl-bar'+(cut?' cut':'')+'" x="'+(bx+0.6).toFixed(1)+'" y="'+(H-PADB-bh).toFixed(1)+'" width="'+(bw-1.2).toFixed(1)+'" height="'+Math.max(bh,1).toFixed(1)+'" data-tip="'+esc(tip)+'"></rect>';
  }
  for(let lg=5;lg<=8;lg++) g+='<text class="admfl-ax" x="'+(x(lg)+2).toFixed(1)+'" y="'+(H-6)+'">'+fmtUsd(Math.pow(10,lg))+'</text>';
  const fx=Math.max(0,Math.min(W,x(fLg)));
  g+='<line class="admfl-line" x1="'+fx.toFixed(1)+'" y1="'+(PADT-4)+'" x2="'+fx.toFixed(1)+'" y2="'+(H-PADB)+'"></line>'
    +'<polygon class="admfl-grab" points="'+(fx-4).toFixed(1)+','+(PADT-4)+' '+(fx+4).toFixed(1)+','+(PADT-4)+' '+fx.toFixed(1)+','+(PADT+3)+'"></polygon>'
    +'<text class="admfl-ax on" x="'+Math.min(fx+6,W-52).toFixed(1)+'" y="'+(PADT+4)+'">'+fmtUsd(floor)+'</text>'
    +(noRead?'<text class="admfl-ax" x="2" y="'+(PADT+4)+'" data-tip="'+esc(noRead+' name(s) carry no honest '+(idx===2?'OI':'volume')+' read \u2014 they clear this wall by construction rather than being refused on a number we do not have')+'">'+noRead+' no read</text>':'');
  return '<svg class="admfl-hist" data-flk="'+key+'" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="distribution of eligible names by '+(idx===2?'open interest':'24h notional volume')+'">'+g+'</svg>';
}
function renderAdmFloors(){
  const host=el('admFloorsBox'); if(!host||!IS_ADMIN) return;
  if(!_admFl){ host.innerHTML='<div class="msg">Loading FOCUS floors…</div>'; return; }
  if(_admFl.error){ host.innerHTML='<div class="msg">Could not load the FOCUS floors — '+esc(_admFl.error)+'</div>'; return; }
  const V=_admFlV,O=_admFlO,hard=_admFl.hard||{vol:200000,oi:0};
  const pr=admFlProject(V,O), n=(_admFl.scan||[]).length;
  const thin=pr.pass.length?pr.pass.reduce((a,b)=>a[1]<b[1]?a:b):null;
  const loud=pr.below.length?pr.below[0]:null;
  const short=pr.pass.length<6;
  const chip=(k,v)=>'<button type="button" class="admfl-chip'+((k==='v'?V:O)===v?' on':'')+'" data-flq="'+k+'" data-flv="'+v+'">'+fmtUsd(v)+'</button>';
  host.innerHTML='<div class="admfl-h">'
      +'<div><div class="adm-title">FOCUS liquidity floors</div>'
      +'<div class="adm-sub">Names under these walls are never considered for a seat. Applied at candidate assembly, so the 09:00 preview and the 09:30 stamp meet the same wall.</div></div>'
      +'<div class="admfl-state'+(_admFlDirty?' dirty':'')+'" data-tip="'+esc(_admFlDirty?'Unsaved — the engine is still gating on the saved wall':'Saved — the next stamp gates on this')+'">'+(_admFlDirty?'unsaved':'in force')+'</div></div>'
    +'<div class="admfl-grid">'
      +'<div><label class="admfl-lab" for="admFlVol">Minimum 24h notional volume</label>'
        +'<div class="admfl-in"><span>$</span><input id="admFlVol" type="text" inputmode="numeric" value="'+V.toLocaleString('en-US')+'" aria-label="Minimum 24h notional volume in dollars"></div>'
        +'<div class="admfl-chips">'+[200000,1000000,5000000,25000000].map(v=>chip('v',v)).join('')+'</div>'
        +admFlHist('v',1,V)
        +'<div class="admfl-note">'+n+' name'+(n===1?'':'s')+' in scope after the foreign-home exclusion. Click or drag a chart to set its floor.</div></div>'
      +'<div><label class="admfl-lab" for="admFlOi">Minimum open interest</label>'
        +'<div class="admfl-in"><span>$</span><input id="admFlOi" type="text" inputmode="numeric" value="'+O.toLocaleString('en-US')+'" aria-label="Minimum open interest in dollars"></div>'
        +'<div class="admfl-chips">'+[0,250000,1000000,5000000].map(v=>chip('o',v)).join('')+'</div>'
        +admFlHist('o',2,O)
        +'<div class="admfl-note">OI notional on the HIP-3 perp. A name with no honest OI read <span data-tip="Missing OI is not zero OI \u2014 it means the series is too sparse on that name to be honest. The volume floor still judges it.">is never cut on this floor</span>.</div></div>'
    +'</div>'
    +'<div class="admfl-ro">'
      +'<div class="admfl-t"><div class="k">clear both floors</div><div class="v'+(pr.pass.length<6?' warn':'')+'">'+pr.pass.length+'</div><div class="s">of '+n+' in scope</div></div>'
      +'<div class="admfl-t"><div class="k">below floor</div><div class="v">'+pr.below.length+'</div><div class="s">excluded from candidacy</div></div>'
      +'<div class="admfl-t"><div class="k">thinnest cleared</div><div class="v sm">'+(thin?esc(thin[0]):'\u2014')+'</div><div class="s">'+(thin?fmtUsd(thin[1])+' vol \u00b7 '+(thin[2]==null?'no OI read':fmtUsd(thin[2])+' OI'):'nothing clears')+'</div></div>'
      +'<div class="admfl-t"><div class="k">loudest refused</div><div class="v sm">'+(loud?esc(loud.t):'\u2014')+'</div><div class="s">'+(loud?fmtUsd(loud.vol)+' vol \u00b7 '+(loud.oi==null?'no OI read':fmtUsd(loud.oi)+' OI'):'nothing refused')+'</div></div>'
    +'</div>'
    +(short?'<div class="admfl-warn">Only '+pr.pass.length+' name'+(pr.pass.length===1?'':'s')+' would clear this wall \u2014 the stamp seats what cleared and says so, rather than padding the list or withholding it. The universe-booting check reads the pre-floor count, so a strict wall can never be mistaken for a cold start.</div>':'')
    +'<div class="admfl-act">'
      +'<button type="button" class="btn" id="admFlSave"'+(_admFlBusy||!_admFlDirty?' disabled':'')+'>'+(_admFlBusy?'Saving\u2026':'Save floors')+'</button>'
      +'<button type="button" class="btn xtiny" id="admFlReset" data-tip="Drop both walls to the hard backstop">reset to backstop</button>'
      +'<span class="admfl-foot">Effective floor is max(backstop, yours) \u2014 backstop '+fmtUsd(hard.vol)+' volume / '+fmtUsd(hard.oi)+' OI, so a typo can loosen the tab but never below what the engine already refused. '
      +'Counts above are a projection over the live scan; the stamped record carries the authoritative ones. '
      +'<b>Today\u2019s stamp is frozen with the floors that stood at 09:30 and does not move when you save</b> \u2014 the wall rides the record so a track record stays readable.</span>'
    +'</div>';
  const vi=el('admFlVol'),oi=el('admFlOi');
  const commit=(which,val)=>{ const v=Math.max(0,Math.round(val)||0);
    if(which==='v') _admFlV=v; else _admFlO=v;
    _admFlDirty=(_admFlV!==_admFl.limits.vol)||(_admFlO!==_admFl.limits.oi); renderAdmFloors(); };
  const num=s=>{ const v=parseFloat(String(s).replace(/[^0-9.]/g,'')); return isFinite(v)?v:0; };
  if(vi){ vi.addEventListener('change',()=>commit('v',num(vi.value)));
    vi.addEventListener('keydown',e=>{ if(e.key==='Enter') commit('v',num(vi.value)); }); }
  if(oi){ oi.addEventListener('change',()=>commit('o',num(oi.value)));
    oi.addEventListener('keydown',e=>{ if(e.key==='Enter') commit('o',num(oi.value)); }); }
  host.querySelectorAll('.admfl-chip').forEach(b=>b.addEventListener('click',()=>commit(b.dataset.flq==='v'?'v':'o',+b.dataset.flv)));
  host.querySelectorAll('.admfl-hist').forEach(sv=>{
    const LO=4,HI=8.6;
    const at=ev=>{ const r=sv.getBoundingClientRect(); if(!r.width) return;
      const f=Math.max(0,Math.min(1,((ev.touches?ev.touches[0].clientX:ev.clientX)-r.left)/r.width));
      commit(sv.dataset.flk,Math.pow(10,LO+f*(HI-LO))); };
    // commit() re-renders the box, which replaces this SVG mid-drag — so the drag only tracks the
    // pointer and commits ONCE on release (a click is mousedown+mouseup at the same spot).
    sv.addEventListener('mousedown',e=>{ e.preventDefault(); sv._d=1; sv._last=e; });
    sv.addEventListener('mousemove',e=>{ if(sv._d) sv._last=e; });
    const release=()=>{ if(sv._d&&sv._last){ const e=sv._last; sv._d=0; sv._last=null; at(e); } sv._d=0; };
    sv.addEventListener('mouseup',release);
    sv.addEventListener('mouseleave',release);
  });
  const sb=el('admFlSave'); if(sb) sb.addEventListener('click',saveAdmFloors);
  const rb=el('admFlReset'); if(rb) rb.addEventListener('click',()=>{ _admFlV=hard.vol; _admFlO=hard.oi;
    _admFlDirty=(_admFlV!==_admFl.limits.vol)||(_admFlO!==_admFl.limits.oi); renderAdmFloors(); });
}
async function saveAdmFloors(){
  if(_admFlBusy||!_admFl||_admFl.error) return;
  _admFlBusy=true; renderAdmFloors();
  try{
    const r=await fetch('/api/focus/limits',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({vol:_admFlV,oi:_admFlO})});
    const d=await r.json().catch(()=>({}));
    _admFlBusy=false;
    if(!r.ok||!d.ok){ pushToast('Could not save the FOCUS floors — '+((d&&d.error)||('HTTP '+r.status))); renderAdmFloors(); return; }
    // Reconcile with what the server actually RESOLVED, never with what was asked: the clamp to the
    // backstop happens server-side, so a below-backstop entry must come back showing the backstop.
    _admFl={..._admFl,limits:d.limits,hard:d.hard||_admFl.hard,scan:d.scan||_admFl.scan};
    _admFlV=d.limits.vol; _admFlO=d.limits.oi; _admFlDirty=false;
    renderAdmFloors();
    pushToast('FOCUS floors saved — '+fmtUsd(d.limits.vol)+' volume / '+fmtUsd(d.limits.oi)+' OI. Live from the next preview tick; today\u2019s stamp unchanged.');
    if(FOC.data) focFetch();
  }catch(e){ _admFlBusy=false; renderAdmFloors(); pushToast('Network error saving the FOCUS floors'); }
}
function admLabel(st){ return st==='public'?'public':st==='admin'?'admin':'off'; }
// Everyone's linked telegram accounts, in the admin panel rather than the bell. Collapsed by
// default and deliberately plain: this is an operator's roster for revoking access, not a place to
// tune somebody else's subscriptions — those are theirs, set from their own browser.
let admRecOpen={};
function renderAdmRecips(){
  const h=el('admRecH'), b=el('admRecB'), n=el('admRecN');
  if(!h||!b) return;
  const P=pushState;
  const rows=(P&&P.recipients)||[];
  if(n) n.textContent=P?`\u00b7 ${rows.length} linked`:'';
  h.querySelector('.asec-c').textContent=b.hidden?'\u25b8':'\u25be';
  if(b.hidden) return;
  if(!P){ b.innerHTML='<div class="msg">Open the alerts bell once to load delivery state.</div>'; return; }
  if(!P.admin){ b.innerHTML='<div class="msg">Admin only.</div>'; return; }
  // Editable, not just readable. Revoke-only lasted exactly one build before the operator asked
  // where the controls went — fair: whoever runs the bot fields the "why am I getting X" messages,
  // so the roster edits classes in place. Writes ride the same routes the owner uses, with the
  // admin override the server already honoured; the person's own panel shows the change on next open.
  const dflt=P.defaultClasses||[];
  const adminCls=P.adminClasses||['ops'];
  // Brief test-fire. The formatting of a Telegram message cannot be checked from the browser —
  // proportional font, entity parsing and the 4096 ceiling only bite on the real transport — so
  // this sends the actual thing, by the actual path, to the operator's own linked accounts.
  b.innerHTML=(rows.length? rows.map(r=>{
    const dot=r.muted?'neg':(r.lastErr?'warn':'pos');
    const openR=!!admRecOpen[r.chat];
    const on=(c)=>(r.classes&&r.classes.length)?r.classes.includes(c):dflt.includes(c);
    const nOn=(P.classes||[]).filter(c=>on(c)&&(!adminCls.includes(c)||r.admin)).length;
    const chips=openR?(P.classes||[]).filter(c=>!adminCls.includes(c)||r.admin).map(c=>
      `<button type="button" class="cdtf${on(c)?' on':''}" data-apcls="${esc(c)}" data-apchat="${esc(r.chat)}">${esc(c)}</button>`).join(''):'';
    // The brief is a scheduled summary, not an event class, so it has no chip among the classes —
    // it needs its own. Admin-scoped: the operator fields the "why am I getting this" messages.
    const bH=(r.briefHour!=null?r.briefHour:null);
    const bLbl=bH!=null?`${String(bH).padStart(2,'0')}:00${r.briefUtc?' UTC':''}`:'off';
    const briefChip=openR?`<button type="button" class="cdtf${bH!=null?' on':''}" data-apbrief="${esc(r.chat)}" data-tip="the morning brief for THIS recipient \u2014 click to set the hour or turn it off. Setting it from here records the hour only, never your timezone: stamping your offset onto somebody else's account would move their delivery without them asking.">brief ${esc(bLbl)}</button>`:'';
    const opChip=openR?`<button type="button" class="cdtf${r.admin?' on':''}" data-aop="${esc(r.chat)}" data-tip="operator designation. The operator receives server-health (ops) alerts and the \u2018send test\u2019 fires from the boxes above. Any number of recipients can hold it; zero means test buttons refuse rather than guess. Click to toggle.">\u265b operator${r.admin?'':' \u00b7 off'}</button>`:'';
    const schedChips=openR?((P.schedKinds||[]).map(k=>{
      const sc=(r.sched&&r.sched[k.k])||null, h=sc?sc.hour:null;
      const lbl=h!=null?`${String(h).padStart(2,'0')}:00${sc&&sc.utc?' UTC':''}${sc&&sc.days?' \u00b7 '+sc.daysLabel:''}`:'off';
      return `<button type="button" class="cdtf${h!=null?' on':''}" data-asched="${esc(k.k)}" data-aschat="${esc(r.chat)}" data-tip="${esc(k.label+' for THIS recipient \u2014 hour and days. Records the schedule only, never your timezone: stamping your offset onto somebody else\u2019s account would move their delivery without them asking.')}">${esc(k.label.toLowerCase())} ${esc(lbl)}</button>`;
    }).join('')):'';
    return `<div class="arule" style="flex-wrap:wrap"><span class="arec-h" data-admexp="${esc(r.chat)}"><span class="asec-c">${openR?'\u25be':'\u25b8'}</span><b class="${dot}">\u25cf</b> ${esc(r.name)} <span class="sec">${esc(r.mask)} \u00b7 ${r.admin?'operator':'public'} \u00b7 ${nOn} class(es) \u00b7 ${r.sentHour}/${P.capHour}h${r.mine?' \u00b7 yours':(r.owned?' \u00b7 another browser':' \u00b7 unclaimed')}</span></span>`
      +(r.owned?'':`<button type="button" class="cdtf" data-admclaim="${esc(r.chat)}" style="margin-left:auto" data-tip="this recipient was linked before per-browser ownership existed, so no browser manages it. Claiming moves it to THIS browser and it appears in your alerts panel with its class chips and quiet hours.">claim</button>`)
      +`<span class="ax" data-admunlink="${esc(r.chat)}" title="revoke this recipient">\u2715</span>`
      +(openR?`<span style="display:flex;gap:4px;width:100%;margin-top:5px;flex-wrap:wrap">${chips}${opChip}${schedChips}</span>`:'')+`</div>`; }).join('')
    : '<div class="sec" style="font-size:var(--fs-sm);padding:4px">Nobody has linked a telegram account.</div>');
  b.querySelectorAll('[data-admexp]').forEach(x=>x.addEventListener('click',()=>{
    admRecOpen[x.dataset.admexp]=!admRecOpen[x.dataset.admexp]; renderAdmRecips(); }));
  b.querySelectorAll('[data-apcls]').forEach(x=>x.addEventListener('click',()=>{
    const rec=rows.find(r=>r.chat===x.dataset.apchat); if(!rec) return;
    const all=(P.classes||[]).filter(c=>!adminCls.includes(c)||rec.admin);
    let cur=(rec.classes&&rec.classes.length)?rec.classes.slice():dflt.filter(c=>all.includes(c));
    const c=x.dataset.apcls;
    cur = cur.includes(c) ? cur.filter(v=>v!==c) : cur.concat([c]);
    pushAct('/api/alerts/classes',{chat:rec.chat, classes:cur}).then(()=>renderAdmRecips()); }));
  b.querySelectorAll('[data-apbrief]').forEach(x=>x.addEventListener('click',()=>{
    const rec=rows.find(r=>r.chat===x.dataset.apbrief); if(!rec) return;
    const cur=rec.briefHour;
    const v=(prompt('Morning brief for '+rec.name+' at which hour? (0-23, blank to turn it off)',cur!=null?String(cur):'10')||'').trim();
    // No tz in this write. An admin setting somebody else's hour from their own browser would
    // otherwise stamp the operator's offset onto that person's record and silently move them.
    pushAct('/api/alerts/prefs',{chat:rec.chat, digestHour: v===''?null:+v}).then(()=>renderAdmRecips()); }));
  b.querySelectorAll('[data-aop]').forEach(x=>x.addEventListener('click',()=>{
    const rec=rows.find(r=>r.chat===x.dataset.aop); if(!rec) return;
    const to=!rec.admin;
    if(!confirm((to?'Make ':'Remove ')+rec.name+(to?' the operator? They will receive server-health (ops) alerts and the test fires from the admin boxes.':' as operator? They will stop receiving ops alerts and test fires.'))) return;
    pushAct('/api/alerts/prefs',{chat:rec.chat, operator:to}).then(()=>renderAdmRecips()); }));
  b.querySelectorAll('[data-asched]').forEach(x=>x.addEventListener('click',()=>{
    const rec=rows.find(r=>r.chat===x.dataset.aschat); if(!rec) return;
    const k=x.dataset.asched, kind=((P.schedKinds)||[]).find(z=>z.k===k)||{};
    const sc=(rec.sched&&rec.sched[k])||null;
    const cur=sc&&sc.hour!=null?String(sc.hour):String(kind.defaultHour!=null?kind.defaultHour:10);
    const v=(prompt(kind.label+' for '+rec.name+' at which hour? (0-23, blank to turn it off)',cur)||'').trim();
    if(v===''){ pushAct('/api/alerts/prefs',{chat:rec.chat, sched:{[k]:{h:null}}}).then(()=>renderAdmRecips()); return; }
    const d=(prompt('Which days? ("all", "weekdays", "mon,wed,fri" or "MWF")',sc&&sc.days?sc.days.join(','):'all')||'').trim();
    const days=schedDaysClient(d);
    if(days===undefined){ alert('Could not read those days.'); return; }
    // No tz in this write, same reason the brief hour never carried one: setting somebody else's
    // schedule from the operator's browser must not stamp the operator's offset onto their record.
    pushAct('/api/alerts/prefs',{chat:rec.chat, sched:{[k]:{h:+v, days}}}).then(()=>renderAdmRecips()); }));
  b.querySelectorAll('[data-admclaim]').forEach(x=>x.addEventListener('click',()=>{
    pushAct('/api/alerts/claim',{chat:x.dataset.admclaim}).then(()=>renderAdmRecips()); }));
  b.querySelectorAll('[data-admunlink]').forEach(x=>x.addEventListener('click',()=>{
    if(!confirm('Revoke this recipient? They stop receiving alerts immediately and must re-link.')) return;
    pushAct('/api/alerts/unlink',{chat:x.dataset.admunlink}).then(()=>renderAdmRecips()); }));
}
// Morning brief: an always-visible admin block, not a row inside a collapsed accordion. Renders
// whether or not the recipients section is expanded, and whether or not anyone is linked.
function renderAdmBrief(){
  const box=el('admBriefBox'); if(!box) return;
  if(!IS_ADMIN){ box.hidden=true; return; }
  box.hidden=false;
  const P=pushState;
  const rows=(P&&P.recipients)||[];
  // The operator's own schedule, stated inside each box rather than only on a roster chip you have
  // to know to expand. One resolved line, click to edit, same validated route as everything else.
  const mySchedRow=(k)=>{
    const kind=((P&&P.schedKinds)||[]).find(z=>z.k===k)||{};
    // Prefer the row this browser linked; fall back to the designated operator, since that is who
    // the admin boxes serve — an operator administering from a second machine still sees and edits
    // their own schedule here instead of a dead "link a telegram" line.
    const me=rows.find(r=>r.mine)||rows.find(r=>r.admin);
    if(!me) return `<div class="sec" style="font-size:var(--fs-xs);margin-top:4px">your schedule: <span class="warn">link a telegram or mark an operator below</span></div>`;
    const sc=(me.sched&&me.sched[k])||null, h=sc?sc.hour:null;
    const lbl=h!=null?`${String(h).padStart(2,'0')}:00${sc&&sc.utc?' UTC':''} \u00b7 ${esc(sc&&sc.daysLabel||'daily')}`:'off';
    return `<div class="sec" style="font-size:var(--fs-xs);margin-top:4px">your schedule: <button type="button" class="cdtf${h!=null?' on':''}" data-mysched="${esc(k)}" data-tip="when YOUR copy of ${esc(kind.label||k)} arrives \u2014 hour and days. Everyone else\u2019s is on their roster row.">${esc(lbl)}</button></div>`;
  };

  const utcN=rows.filter(r=>r.briefHour!=null&&r.briefUtc).length;
  const onN=rows.filter(r=>r.briefHour!=null).length;
  const st=(P&&P.brief)||null;
  const state=st?(st.enabled?`<span class="pos">on</span> \u00b7 default ${String(st.defaultHour).padStart(2,'0')}:00 UTC \u00b7 ${st.dayLeft}/${st.perDay} generations left today`
    :'<span class="neg">disabled</span> (BRIEF_ENABLED=0)'):'\u2026';
  box.innerHTML=`<div class="abr-t" data-tip="One market brief a day per recipient, delivered as two telegram messages: indices, movers, sectors, regime, positioning, earnings, macro and the day\u2019s headlines, with two model-written sections. On by default for everyone who links telegram.">Morning brief</div>`
    +`<div class="sec" style="font-size:var(--fs-xs)">${state}${st&&st.model?` \u00b7 ${esc(st.model)}`:''}</div>`
    +`<div class="sec" style="font-size:var(--fs-xs);margin-top:3px">${onN} of ${rows.length} linked recipient(s) receiving it${utcN?` \u00b7 <span class="warn">${utcN} on the UTC default</span>`:''}</div>`
    +(st&&st.lastErr?`<div class="sec neg" style="font-size:var(--fs-xs);margin-top:3px" data-tip="the last time the prose layer failed \u2014 the mechanical brief still shipped">last prose failure: ${esc(st.lastErr)}</div>`:'')
    +`<div class="abr-row">`
      +`<button type="button" class="cdtf" id="adm-brief" data-tip="re-serves this hour\u2019s brief \u2014 no model call, no budget spent">send test (cached)</button>`
      +`<button type="button" class="cdtf" id="adm-brief-f" data-tip="regenerate from live state and spend one of today\u2019s brief budget">send test (fresh)</button>`
      +`<span class="sec" style="font-size:var(--fs-xs)" data-tip="test fires go ONLY to the recipient(s) marked operator on the roster below \u2014 never to anyone else. Toggle who is operator with the crown chip on their row.">\u2192 operator only</span>`
    +`</div><div class="abr-r" id="adm-brief-r"></div>`
    +mySchedRow('brief');
  // Separate state line and test pair, not a shared row with the brief: separate schedules,
  // separate budgets, separate failure modes — one averaged row would hide exactly the case worth
  // seeing, the brief fine and the commentary dead.
  const L=(P&&P.landscape)||null;
  const lState=L?(L.enabled?`<span class="pos">on</span> \u00b7 default ${String(L.defaultHour).padStart(2,'0')}:00 UTC \u00b7 ${esc(L.defaultDays||'daily')} \u00b7 ${L.dayLeft}/${L.perDay} generations left today \u00b7 ${L.windowH}h corpus`
    :'<span class="neg">disabled</span> (LANDSCAPE_ENABLED=0)'):'\u2026';
  box.innerHTML+=`<div class="abr-t" style="margin-top:10px" data-tip="One written commentary message per scheduled day, an hour after the brief. Built from the headline corpus and it must cite the headlines it rests on \u2014 those citations render as the sources footer. Interpretation, not measurement: unlike the brief, its claims are not checked against server-computed figures. Per-recipient hour and days are on each roster row below.">THE LANDSCAPE</div>`
    +`<div class="sec" style="font-size:var(--fs-xs)">${lState}${L&&L.model?` \u00b7 ${esc(L.model)}`:''}</div>`
    +(L&&L.lastErr?`<div class="sec neg" style="font-size:var(--fs-xs);margin-top:3px" data-tip="the last time commentary generation failed \u2014 the message still ships, saying so">last failure: ${esc(L.lastErr)}</div>`:'')
    +`<div class="abr-row">`
      +`<button type="button" class="cdtf" id="adm-land" data-tip="re-serves this hour\u2019s commentary \u2014 no model call, no budget spent">send test (cached)</button>`
      +`<button type="button" class="cdtf" id="adm-land-f" data-tip="regenerate from the live headline corpus and spend one of today\u2019s landscape budget">send test (fresh)</button>`
    +`</div><div class="abr-r" id="adm-land-r"></div>`
    +mySchedRow('landscape');
  // Report what actually shipped: parts, entity-parsed length of each, whether the prose layer
  // degraded, and which budget-ladder steps fired. A silent success tells the operator nothing
  // about whether the message that landed is the message they designed.
  const briefRun=(fresh)=>{
    const out=el('adm-brief-r'); if(out) out.textContent='sending\u2026';
    ['adm-brief','adm-brief-f'].forEach(id=>{ const x=el(id); if(x) x.disabled=true; });
    fetch('/api/alerts/brief-test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fresh:!!fresh, operator:true})})
      .then(r=>r.json().catch(()=>null)).then(d=>{
        if(!out) return;
        if(!d||!d.ok){ out.innerHTML='<span class="neg">'+esc((d&&d.error)||'failed')+'</span>'; return; }
        const p=[`sent to ${d.sent} account(s) \u00b7 ${d.parts} message(s) \u00b7 ${(d.chars||[]).join(' + ')} chars`];
        if(d.model) p.push('model '+esc(d.model));
        if(d.degraded) p.push('<span class="warn">prose degraded: '+esc(d.degraded)+'</span>');
        if(d.dropped&&d.dropped.length) p.push('<span class="warn">ladder: '+esc(d.dropped.join(', '))+'</span>');
        if(d.dayLeft!=null) p.push(d.dayLeft+' left today');
        out.innerHTML=p.join(' \u00b7 ');
      }).catch(()=>{ if(out) out.innerHTML='<span class="neg">request failed</span>'; })
      .finally(()=>{ ['adm-brief','adm-brief-f'].forEach(id=>{ const x=el(id); if(x) x.disabled=false; }); });
  };
  const landRun=(fresh)=>{
    const out=el('adm-land-r'); if(out) out.textContent='sending\u2026';
    ['adm-land','adm-land-f'].forEach(id=>{ const x=el(id); if(x) x.disabled=true; });
    fetch('/api/alerts/brief-test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'landscape',fresh:!!fresh, operator:true})})
      .then(r=>r.json().catch(()=>null)).then(d=>{
        if(!out) return;
        if(!d||!d.ok){ out.innerHTML='<span class="neg">'+esc((d&&d.error)||'failed')+'</span>'; return; }
        const p=[`sent to ${d.sent} account(s) \u00b7 ${(d.chars||[]).join('')} chars`];
        if(d.sources!=null) p.push(d.sources+' source(s) cited');
        if(d.model) p.push('model '+esc(d.model));
        if(d.degraded) p.push('<span class="warn">degraded: '+esc(d.degraded)+'</span>');
        if(d.dropped&&d.dropped.length) p.push('<span class="warn">shed: '+esc(d.dropped.join(', '))+'</span>');
        if(d.dayLeft!=null) p.push(d.dayLeft+' left today');
        out.innerHTML=p.join(' \u00b7 ');
      }).catch(()=>{ if(out) out.innerHTML='<span class="neg">request failed</span>'; })
      .finally(()=>{ ['adm-land','adm-land-f'].forEach(id=>{ const x=el(id); if(x) x.disabled=false; }); });
  };
  box.querySelectorAll('[data-mysched]').forEach(x=>x.addEventListener('click',()=>{
    const k=x.dataset.mysched, kind=((P&&P.schedKinds)||[]).find(z=>z.k===k)||{};
    const me=rows.find(r=>r.mine); if(!me) return;
    const sc=(me.sched&&me.sched[k])||null;
    const cur=sc&&sc.hour!=null?String(sc.hour):String(kind.defaultHour!=null?kind.defaultHour:10);
    const v=(prompt((kind.label||k)+' at which local hour for YOU? (0-23, blank to turn it off)',cur)||'').trim();
    if(v===''){ pushAct('/api/alerts/prefs',{chat:me.chat, sched:{[k]:{h:null}}, tz:-new Date().getTimezoneOffset()}).then(()=>renderAdmBrief()); return; }
    const d=(prompt('Which days? ("all", "weekdays", "mon,wed,fri" or "MWF")',sc&&sc.days?sc.days.join(','):(kind.defaultDays?kind.defaultDays.join(','):'all'))||'').trim();
    const days=schedDaysClient(d);
    if(days===undefined){ alert('Could not read those days. Try "all", "weekdays", "mon,wed,fri" or "MWF".'); return; }
    pushAct('/api/alerts/prefs',{chat:me.chat, sched:{[k]:{h:+v, days}}, tz:-new Date().getTimezoneOffset()}).then(()=>renderAdmBrief()); }));
  { const x=el('adm-land'); if(x) x.addEventListener('click',()=>landRun(false)); }
  { const x=el('adm-land-f'); if(x) x.addEventListener('click',()=>landRun(true)); }
  { const x=el('adm-brief'); if(x) x.addEventListener('click',()=>briefRun(false)); }
  { const x=el('adm-brief-f'); if(x) x.addEventListener('click',()=>briefRun(true)); }
}
// ===== Admin: rename a ribbon menu, move a tab between menus ==================================
// Same write contract as the feature rows: one field per call, optimistic paint, roll back on
// failure. The ribbon repaints from the response rather than a reload, so the admin sees the
// result in the row above while still standing in the panel.
let _navBusy='';
function renderAdmNavGroups(){
  const host=el('adm-navgrp'); if(!host||!IS_ADMIN) return;
  const label=(v)=>{ const t=document.querySelector('.tab[data-view="'+v+'"]');
    return t?(t.textContent||v):v; };
  const opts=(sel)=>TAB_GROUPS.map(g=>'<option value="'+esc(g.key)+'"'+(g.key===sel?' selected':'')+'>'+esc(g.label)+'</option>').join('');
  let h='<div class="adm-navhd">Ribbon menus<span class="adm-navsub">rename a menu, or move a tab into another one \u2014 everyone sees it</span></div>';
  for(const g of TAB_GROUPS){
    h+='<div class="adm-navgroup"><div class="adm-navrow">'
      +'<input class="adm-navname" data-grp="'+esc(g.key)+'" value="'+esc(g.label)+'" maxlength="18" '
      +'placeholder="'+esc(g.def||g.label)+'" aria-label="Name for the '+esc(g.label)+' menu"'
      +(_navBusy===g.key?' disabled':'')+'>'
      +'<span class="adm-navkey">'+esc(g.key)+(g.def&&g.label!==g.def?' \u00b7 default "'+esc(g.def)+'"':'')+'</span></div>'
      +'<div class="adm-navtabs">'
      +(g.views.length?g.views.map(v=>'<span class="adm-navtab"><span class="adm-navtl">'+esc(label(v))+'</span>'
        +'<select class="adm-navmove" data-view="'+esc(v)+'"'+(_navBusy===v?' disabled':'')+'>'+opts(g.key)+'</select></span>').join('')
        :'<span class="adm-navempty">empty \u2014 this menu is hidden until a tab moves in</span>')
      +'</div></div>';
  }
  h+='<div class="adm-navfoot">Markets and Admin stay outside the menus: Markets is where every load lands, and Admin is this panel. Clearing a name restores the default.</div>';
  host.innerHTML=h;
  host.querySelectorAll('.adm-navname').forEach(inp=>{
    const send=()=>{ if(inp.__sent===inp.value) return; inp.__sent=inp.value;
      navWrite({key:inp.dataset.grp,label:inp.value}, inp.dataset.grp); };
    inp.addEventListener('blur',send);
    inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); inp.blur(); }
      if(e.key==='Escape'){ inp.value=(TAB_GROUPS.find(g=>g.key===inp.dataset.grp)||{}).label||''; inp.blur(); } });
  });
  host.querySelectorAll('.adm-navmove').forEach(sel=>{
    sel.addEventListener('change',()=>navWrite({view:sel.dataset.view,group:sel.value}, sel.dataset.view));
  });
}
async function navWrite(body, busyKey){
  _navBusy=busyKey; renderAdmNavGroups();
  try{
    const r=await fetch('/api/nav-groups',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok){ pushToast('Could not save \u2014 '+((d&&d.error)||('HTTP '+r.status))); }
    else applyNavGroups(d.groups);
  }catch(_){ pushToast('Network error saving the ribbon menus'); }
  _navBusy=''; renderAdmNavGroups();
}
// The response is the whole resolved set, so the ribbon is rebuilt from the server's answer rather
// than from what the panel hoped the write would do — same rule the feature rows follow.
function applyNavGroups(groups){
  if(!Array.isArray(groups)||!groups.length) return;
  TAB_GROUPS.length=0;
  groups.forEach(g=>TAB_GROUPS.push({key:g.key,label:g.label,def:g.def||g.label,views:(g.views||[]).slice()}));
  buildTabGroups(); applyTabVisibility(); wireTabDrag();
}
function renderAdmin(){
  renderAdmNavGroups();
  { const h=el('admRecH'), b=el('admRecB');
    if(h&&!h._wired){ h._wired=1; h.addEventListener('click',()=>{ b.hidden=!b.hidden; renderAdmRecips(); }); }
    if(!pushState) loadPush().then(()=>{ renderAdmRecips(); renderAdmBrief(); }); else { renderAdmRecips(); renderAdmBrief(); } }
  const host=el('adm-rows'); if(!host) return;
  if(!_adm){ host.innerHTML='<div class="msg">Loading…</div>'; return; }
  if(_adm.error){ host.innerHTML='<div class="msg">Could not load feature state — '+esc(_adm.error)+'</div>'; return; }
  const man=_adm.manifest||[];
  const groups=[['tab','Tabs'],['act','Actions']];
  // One row renderer for parents and their nested scope children — the scope rows are the SAME
  // three-state control on the same write path (setAdmFlag), only presented indented under the tab
  // whose payloads they slice. `scope:true` adds the indent class and swaps the route line for an
  // honest description of what a scope actually is (it owns no route — it filters payload rows).
  const rowHtml=(m,scope)=>{
    const locked=!m.settable;
    // A pinned/locked row shows its state as a static chip, not a control whose write the server
    // would refuse — offering a button that always fails is worse than offering none.
    const seg=locked
      ? '<span class="adm-lock" title="'+(m.pin?'Always public — this is the fallback every gated view falls through to':'Always admin — this is the panel that controls every other flag')+'">'+esc(admLabel(m.state))+' · locked</span>'
      : ['public','admin','off'].map(v=>'<button type="button" class="adm-b'+(m.state===v?' on '+v:'')+'" data-k="'+esc(m.key)+'" data-v="'+v+'"'+(_admBusy===m.key?' disabled':'')+'>'+v+'</button>').join('');
    const dim=_admVap && m.state!=='public';
    return '<div class="adm-row'+(scope?' adm-scope':'')+(dim?' dim':'')+'">'
      +'<div class="adm-meta"><div class="adm-lab">'+esc(m.label)+'</div>'
      +'<div class="adm-key">'+esc(m.key)+(scope?' · filters payload rows · no route of its own':(m.routes&&m.routes.length?' · '+esc(m.routes.join(', ')):' · no route'))+'</div></div>'
      +'<div class="adm-seg">'+seg+'</div></div>';
  };
  let h='';
  for(const [kind,title] of groups){
    const rows=man.filter(m=>m.kind===kind);
    if(!rows.length) continue;
    h+='<div class="adm-grp">'+esc(title)+'</div>';
    for(const m of rows){
      h+=rowHtml(m,false);
      // Scope children nest directly under their parent tab. The manifest is the only source of
      // the linkage (m.parent, shipped by the server) — nothing here hardcodes which tabs split.
      if(kind==='tab') for(const c of man.filter(x=>x.kind==='scope'&&x.parent===m.key)) h+=rowHtml(c,true);
    }
  }
  host.innerHTML=h;
  host.querySelectorAll('.adm-b').forEach(b=>b.addEventListener('click',()=>setAdmFlag(b.dataset.k,b.dataset.v)));
  const c=_adm.counts||{};
  const cnt=el('adm-count');
  if(cnt) cnt.innerHTML='Public users see <b>'+(c.public||0)+'</b> of '+(c.total||0)+' · <b>'+(c.admin||0)+'</b> admin-only · <b>'+(c.off||0)+'</b> off'+(c.scoped?' · <b>'+c.scoped+'</b> scoped':'');
  const pv=el('adm-prev');
  if(pv){ // the preview reflects the RESOLVED public set, not raw states — a public-state tab whose
    // scopes are all closed self-demotes server-side and must not preview as visible
    const pub=man.filter(m=>m.kind==='tab'&&(_adm.resolvedPublic?!!_adm.resolvedPublic[m.key]:m.state==='public'));
    pv.innerHTML=pub.length?pub.map(m=>'<span class="adm-chip">'+esc(m.label)+'</span>').join(''):'<span class="adm-none">no tabs visible to the public</span>'; }
  const ft=el('adm-foot');
  if(ft) ft.innerHTML='Server-enforced: a gated tab is absent from the markup and every route it owns returns 403. '
    +'Changes apply to the whole group on their next load — there is no per-user setting. '
    +(_admVap?'<b>Viewing as public.</b> Your session is unchanged; the Admin tab stays visible so you can switch back.':'');
  const vb=el('admVap'); if(vb) vb.classList.toggle('on',_admVap);
}
// Optimistic: paint the new state, then reconcile with whatever the server actually resolved (a
// request can be legally transformed — or refused — and the panel must show the truth, not the ask).
async function setAdmFlag(key,state){
  if(!_adm||!_adm.manifest||_admBusy) return;
  const row=_adm.manifest.find(m=>m.key===key); if(!row||!row.settable) return;
  const prev=row.state;
  row.state=state; _admBusy=key; renderAdmin();
  try{
    const r=await fetch('/api/features',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:key,state:state})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok){ row.state=prev; _admBusy=''; renderAdmin();
      pushToast('Could not change '+key+' — '+((d&&d.error)||('HTTP '+r.status))); return; }
    _adm=d.features||_adm; _admBusy='';
    // The gate is server-side, so the live page is now out of date for the CURRENT viewer too.
    if(!_admVap && _adm.resolved){ FLAGS_VIEW=_adm.resolved; applyTabVisibility(); }
    renderAdmin();
  }catch(e){ row.state=prev; _admBusy=''; renderAdmin(); pushToast('Network error changing '+key); }
}
function toggleViewAsPublic(){
  if(!_adm) return;
  _admVap=!_admVap;
  // Swaps in a SERVER-resolved set either way — never a locally recomputed one.
  FLAGS_VIEW = _admVap ? (_adm.resolvedPublic||FLAGS) : FLAGS;
  applyTabVisibility();
  if(!tabVisible(state.view)) showView('markets');
  renderAdmin();
}

// ===== feature visibility: ONE composition point ===============================================
// Server-resolved, injected pre-paint into the shell (window.__FLAGS). Never re-derived here from a
// raw flag — the same one-code-path rule the chart annotations follow. Before this, four places
// decided whether a tab was visible (a client hide list, applyScope's loop, showView's crypto
// redirect and the Treemap installer's own hide) and they could disagree; tabVisible() is the only
// answer now, and the suite fails if a second list reappears.
// Missing injection degrades to SHOWING everything rather than a blank app: the shell is served
// no-store so this should be impossible, and the server gate is authoritative either way — a
// cosmetic leak beats an app with no tabs.
const FLAGS = (window.__FLAGS && typeof window.__FLAGS==='object') ? window.__FLAGS : null;
const IS_ADMIN = !!window.__ADMIN;
function featureOn(key){ return FLAGS_VIEW ? !!FLAGS_VIEW[key] : true; }
// Crypto scope is Markets + Trend + Report + Correlation + Backtest + Sessions by design (the signal
// engine is xyz-only since -101). This set was written out longhand in two places that had already
// drifted apart once; it lives here now and both callers read it.
// funding joins the crypto set: the heatmap is built per universe and the 24/7 book is where
// carry is most worth watching — nothing on the board is an equities-only concept.
const CRYPTO_VIEWS=new Set(['markets','trend','charts','report','drawdown','corr','backtest','sessions','funding','signals','actionable','dm','notes']);   // dm/notes: not universe-specific — pruning them made the chat dock land on Markets. drawdown: the study runs on either universe's closes   // dm/notes: not universe-specific — pruning them made the chat dock land on Markets
// NOT named inScope: that name was already taken at the top of this file by the predicate that
// decides whether a market ROW belongs to the active universe. Function declarations hoist, so the
// later definition silently won, activeRows() started asking "is this row object one of the six
// crypto view names" (always false), and the crypto board rendered zero rows while the stocks board
// showed both universes. Shipped in -05, fixed in -07. The suite now fails on ANY duplicate
// top-level declaration, not just names someone remembered to list.
function viewInScope(v){ return state.scope!=='crypto' || CRYPTO_VIEWS.has(v); }
// The Admin tab keys off IS_ADMIN, not the flag set, and deliberately bypasses viewInScope. It is the
// control surface for every other flag, so making it flag-driven would be circular: "view as public"
// swaps in the public set, which hides the panel, which removes the toggle that turns it back off.
// The manifest still carries an `admin` entry with lock:true so the markup->manifest join holds and
// no write can ever open it; this line is what keeps the switchboard reachable while it is in use.
function tabVisible(v){ if(v==='admin') return IS_ADMIN; return viewInScope(v) && featureOn(v); }
// featureOn reads FLAGS_VIEW, not FLAGS, so "view as public" can swap the whole resolved set in one
// assignment. Both sets come from the server; nothing here recomputes a visibility.
let FLAGS_VIEW = FLAGS;
function applyHash(){ let h; try{ h=decodeURIComponent(location.hash.replace(/^#/,'')); }catch(_){ h=''; }
  if(h.indexOf('t=')===0){ const want=h.slice(2); showView('markets');
    // #t= takes the coin id OR the ticker people actually type (#t=HOOD).
    const coin=state.rows.has(want)?want:(typeof termFind==='function'&&termFind(want)?termFind(want).coin:null);
    if(coin&&coin!==state.detail) openDetail(coin); return; }
  // Every view name is routable, not a hand-kept subset. The old whitelist silently omitted
  // actionable, signals and news — which made #actionable a no-op, i.e. a hidden tab would have
  // been unreachable by the very URL that is supposed to reach it.
  // showView re-checks anyway, but stopping here keeps a gated #hash from clearing the active view.
  if(HASH_VIEWS.has(h) && tabVisible(h)) showView(h); }
let _analyticsInflight=false;
function renderSessions(){ drawSessions(); loadAnalytics(); }
async function loadAnalytics(){
  if(_analyticsInflight) return; _analyticsInflight=true;
  const cr=state.scope==='crypto';
  const url=cr?'/api/analytics?u=crypto':'/api/analytics';
  try{ const d=await fetchJSON(url);
    // Keep the two universes in separate slots so a scope flip mid-flight never renders crypto
    // data into a stocks view or vice-versa; drawSessions reads whichever matches the live scope.
    if(cr) state.analyticsCrypto={data:d,err:null,ts:Date.now()}; else state.analyticsStocks={data:d,err:null,ts:Date.now()};
    syncAnalyticsSlot();
  }
  catch(e){ if(cr){ state.analyticsCrypto=Object.assign(state.analyticsCrypto||{},{err:e.message||String(e)}); } else { state.analyticsStocks=Object.assign(state.analyticsStocks||{},{err:e.message||String(e)}); } syncAnalyticsSlot(); }
  finally{ _analyticsInflight=false; }
  if(state.view==='sessions') drawSessions();
}
// Point state.analytics.{data,err,ts} at the slot for the live scope — preserves the many existing
// call sites that read state.analytics.* while keeping per-universe payloads isolated.
function syncAnalyticsSlot(){
  const src=(state.scope==='crypto'?state.analyticsCrypto:state.analyticsStocks)||{};
  state.analytics.data=src.data||null; state.analytics.err=src.err||null; state.analytics.ts=src.ts||0;
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
  // Entries used to be pruned only inside drawSessions, so every housing / report / trend render
  // leaked its rows until the user happened to visit Sessions. Sweep on registration instead.
  if((_hoverSeq&15)===0) for(const k in _hoverReg) if(!document.getElementById(k)) delete _hoverReg[k];
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
    const scrubAt=(clientX)=>{
      const r=svg.getBoundingClientRect(); if(!r.width) return;
      const vbW=(svg.viewBox&&svg.viewBox.baseVal&&svg.viewBox.baseVal.width)||r.width;
      const px=(clientX-r.left)/r.width*vbW;
      let bi=0,bd=Infinity; for(let i=0;i<reg.xs.length;i++){ const dd=Math.abs(reg.xs[i]-px); if(dd<bd){bd=dd;bi=i;} }
      cx.setAttribute('x1',reg.xs[bi]); cx.setAttribute('x2',reg.xs[bi]); cx.style.opacity='1';
      read.innerHTML=reg.rows[bi]; read.style.opacity='1';
      read.style.left = px > vbW*0.55 ? '10px' : 'auto'; read.style.right = px > vbW*0.55 ? 'auto' : '10px';
    };
    svg.addEventListener('mousemove',(ev)=>scrubAt(ev.clientX));
    svg.addEventListener('mouseleave',()=>{ if(cx)cx.style.opacity='0'; read.style.opacity='0'; });
    // Touch: a drag whose intent is horizontal scrubs the crosshair (and stops the page pan);
    // a vertical drag is a scroll and is left alone. First-touch shows the readout immediately —
    // charts have no competing tap action, so no long-press gate is needed here.
    let tst=null;
    svg.addEventListener('touchstart',(ev)=>{ const t=ev.touches[0]; if(!t) return;
      tst={x:t.clientX,y:t.clientY,on:false}; scrubAt(t.clientX); },{passive:true});
    svg.addEventListener('touchmove',(ev)=>{ const t=ev.touches[0]; if(!t||!tst) return;
      if(!tst.on){
        const dx=Math.abs(t.clientX-tst.x), dy=Math.abs(t.clientY-tst.y);
        if(dx>dy+4) tst.on=true; else if(dy>12){ tst=null; if(cx)cx.style.opacity='0'; read.style.opacity='0'; return; } }
      if(tst&&tst.on){ ev.preventDefault(); scrubAt(t.clientX); } },{passive:false});
    svg.addEventListener('touchend',()=>{ tst=null; });
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
  const cr=!!sd.isCrypto;
  const h=sd.headline, S=sd.sessions;
  const funded = h.fundingHorizonTs!=null;
  const dragBp = (h.meanGross - h.meanNet)*1e4;
  const endp = sd.fundingEndpoint==='on' ? 'live funding history' : 'sampled funding';
  const unit = cr?'day':'night', units = cr?'days':'nights', period = cr?`${sd.window.days}d`:'60d';
  const headLabel = cr
    ? `UTC day · buy at 00:00, sell at 24:00 · ${sd.equityCount} perps`
    : `Overnight · buy at close, sell before open · ${sd.equityCount} equities`;
  const head = `<div style="background:var(--panel2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;padding:16px 18px;margin-bottom:16px">`+
    `<div style="color:var(--muted);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">${headLabel}</div>`+
    `<div style="display:flex;align-items:flex-end;gap:20px;flex-wrap:wrap">`+
      `<div><div style="font-family:var(--mono);font-size:var(--fs-xl);line-height:1" class="${dcls(h.medianNet)}">${fp(h.medianNet)}</div><div class="sec" style="font-size:var(--fs-xs);margin-top:3px">median net / ${unit}</div></div>`+
      `<div><div style="font-family:var(--mono);font-size:var(--fs-xl);line-height:1;color:var(--blue)">${fp(h.medianGross)}</div><div class="sec" style="font-size:var(--fs-xs);margin-top:3px">gross / ${unit}</div></div>`+
      `<div><div style="font-family:var(--mono);font-size:var(--fs-xl);line-height:1;color:var(--muted)">−${dragBp.toFixed(1)}bp</div><div class="sec" style="font-size:var(--fs-xs);margin-top:3px">funding drag</div></div>`+
      `<div style="width:1px;align-self:stretch;background:var(--border)"></div>`+
      `<div><div style="font-family:var(--mono);font-size:var(--fs-xl);line-height:1" class="${dcls(h.totNet)}">${fp(h.totNet)}</div><div class="sec" style="font-size:var(--fs-xs);margin-top:3px">${period} net · gross ${fp(h.totGross)}</div></div>`+
      `<div><div style="font-family:var(--mono);font-size:var(--fs-xl);line-height:1;color:var(--text)">${(h.winNet*100).toFixed(0)}%</div><div class="sec" style="font-size:var(--fs-xs);margin-top:3px">win · ${h.nights} ${units}</div></div>`+
    `</div>`+
    `<div class="s-cap" style="margin-top:12px">${funded ? `Net-of-funding reliable from <b>${sessDate(h.fundingHorizonTs)}</b> onward (${endp}).` : `Net-of-funding approximate — funding history sparse (${endp}); the dashed net line tracks gross before coverage begins.`}</div></div>`;
  const chart=(key,label)=>{ const x=S[key]; if(!x||!x.n) return '';
    return `<div style="flex:1 1 320px;min-width:290px" class="s-card">`+
      `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px"><span style="color:var(--text);font-size:var(--fs-md);font-weight:600">${label}</span>`+
      `<span class="sec" style="font-size:var(--fs-xs)">net <span class="${dcls(x.totNet)}">${fp(x.totNet)}</span> · ${x.n} bets · win ${(x.winNet*100).toFixed(0)}%</span></div>`+
      sessCurveSvg(x.curve, x.fundingHorizonTs)+`</div>`; };
  const charts = cr
    ? `<div class="s-grid" style="margin-bottom:6px">`+chart('utcday','UTC day · 00:00→24:00')+chart('weekend','Weekend · Fri→Mon')+`</div>`
    : `<div class="s-grid" style="margin-bottom:6px">`+chart('overnight','Overnight · close→open')+chart('weekend','Weekend · Fri→Mon')+chart('cash','Cash · open→close')+`</div>`;
  const subtitle = cr
    ? 'what a full UTC-day hold and a Fri→Mon weekend hold actually pay on a 24/7 book, net of funding'
    : 'what an overnight / weekend / cash hold actually pays, pooled one bet per calendar boundary across the equity class';
  const capText = cr
    ? 'Each boundary is one equal-weight bet across every perp that traded it; per-boundary means compounded. No cash leg exists on a continuous book — the UTC day is the holding-period analogue. <b>Hover</b> any curve for the date, gross/net, and breadth. The shaded band is the running funding drag.'
    : 'Each boundary is one equal-weight bet across every equity that traded it; per-boundary means are compounded. <b>Hover</b> any curve for the date, gross/net, and breadth. The shaded band is the running funding drag.';
  return sHead('Session decomposition',subtitle)+
    head+
    sLeg([{color:'var(--blue)',label:'gross'},{color:'var(--accent)',label:'net of funding'},{shape:'dot',color:'var(--accent)',label:'shaded gap = funding cost'}])+
    charts+
    sCap(capText);
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
// -17: sessions renderers read the live payload's tz so crypto (24/7) labels UTC and drops the
// US cash-session band. One helper, consulted by the clock/dow/pivot builders; falls back to ET.
function _szTz(){ const a=state.analytics.data; return (a&&a.tz)||'ET'; }
function _szCash(){ const a=state.analytics.data; return !(a&&a.isCrypto); }   // cash band only for equities
function clockScaffold(cx,cy,ri,ro,cash){
  let s='';
  if(cash!==false){
    // US cash-session highlight arc (09:30–16:00 ET) — equities only; a 24/7 book has no cash window
    s+=`<path d="${clockWedge(cx,cy,ri-3,ro+10,clockDeg(9.5),clockDeg(16))}" fill="var(--blue)" opacity="0.08"/>`;
  }
  // hour ticks + labels every 3h
  for(let h=0;h<24;h+=3){ const [lx,ly]=clockPolar(cx,cy,ro+16,clockDeg(h)); const lab=h===0?'0':(h===12?'12':(''+h));
    s+=`<text x="${lx.toFixed(1)}" y="${(ly+3).toFixed(1)}" text-anchor="middle" class="lc-tick">${lab}</text>`; }
  if(cash!==false){
    // open/close ticks
    for(const hh of [9.5,16]){ const [a,b]=clockPolar(cx,cy,ri-3,clockDeg(hh)), [c,d]=clockPolar(cx,cy,ro+3,clockDeg(hh));
      s+=`<line x1="${a.toFixed(1)}" y1="${b.toFixed(1)}" x2="${c.toFixed(1)}" y2="${d.toFixed(1)}" stroke="var(--blue)" stroke-width="1" opacity="0.6"/>`; }
  }
  return s;
}
// Home-session arc(s) for a foreign-home ticker (build 2026.08.14-01): the KRX/TSE/HKEX/SSE window
// converted to ET hours (fixed home offset from the wire, ET offset via Intl), wrap-safe, lunch
// halts drawn as separate arcs. Amber to contrast the blue US cash arc.
function homeArcSvg(cx,cy,ri,ro,mk){
  const d=state.homeMkts&&state.homeMkts[mk]; if(!d) return '';
  const segs=d.lunch?[[d.o,d.lunch[0]],[d.lunch[1],d.c]]:[[d.o,d.c]];
  let s='';
  for(const sg of segs){
    const a=homeWallToEtMin(d,sg[0][0]*60+sg[0][1])/60, b=homeWallToEtMin(d,sg[1][0]*60+sg[1][1])/60;
    const spans=b>a?[[a,b]]:[[a,24],[0,b]];   // midnight-ET wrap
    for(const sp of spans){
      s+=`<path d="${clockWedge(cx,cy,ri-3,ro+10,clockDeg(sp[0]),clockDeg(sp[1]))}" fill="var(--accent)" opacity="0.10"><title>${sessEx(mk)} home session (ET hours)</title></path>`;
    }
    for(const hh of [a,b]){ const [p,q]=clockPolar(cx,cy,ri-3,clockDeg(hh)), [u,v]=clockPolar(cx,cy,ro+3,clockDeg(hh));
      s+=`<line x1="${p.toFixed(1)}" y1="${q.toFixed(1)}" x2="${u.toFixed(1)}" y2="${v.toFixed(1)}" stroke="var(--accent)" stroke-width="1" opacity="0.6"/>`; }
  }
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
  s+=clockScaffold(cx,cy,ri,roMax,_szCash());
  if(vec.hm) s+=homeArcSvg(cx,cy,ri,roMax,vec.hm);   // amber home-session arc for a foreign-home name — the empirical check that its hump sits where the home market trades
  // concentric ×-average reference rings + labels (readable magnitude)
  for(let k=0.5;k<=maxV+1e-9;k+=0.5){ if(k<0.5) continue; const r=rOf(k), one=Math.abs(k-1)<1e-9;
    s+=`<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="${one?'var(--muted)':'var(--grid)'}" stroke-width="1"${one?' stroke-dasharray="2 3"':''}/>`;
    if(k%1===0||one) s+=`<text x="${cx+2}" y="${(cy-r+3).toFixed(1)}" class="lc-tick" style="fill:var(--faint)">${k}×</text>`; }
  for(let h=0;h<24;h++){ const val=arr[h]; if(!Number.isFinite(val)) continue;
    const ro=rOf(val), col= val>=1?'var(--accent)':'var(--accent-dim)', op=0.35+0.55*Math.min(1,val/maxV);
    s+=`<path d="${clockWedge(cx,cy,ri,ro,clockDeg(h)+1.4,clockDeg(h+1)-1.4)}" fill="${col}" fill-opacity="${op.toFixed(2)}"><title>${h}:00 ${_szTz()} · ${val.toFixed(2)}× avg${vec.volAbsMean&&metric!=='volume'?' · '+(val*vec.volAbsMean*100).toFixed(2)+'% hourly range':''}</title></path>`; }
  s+=`<circle cx="${cx}" cy="${cy}" r="${ri}" fill="var(--panel)" stroke="var(--border)"/>`;
  s+=`<text x="${cx}" y="${cy-1}" text-anchor="middle" style="font-size:var(--fs-2xs);fill:var(--muted)">${metric==='volume'?'volume':'range'}</text>`;
  s+=`<text x="${cx}" y="${cy+11}" text-anchor="middle" style="font-size:var(--fs-2xs);fill:var(--faint)">× avg</text>`;
  return s+'</svg>';
}
function fundingClockSvg(fund){
  const W=240,H=240, cx=120,cy=120, ri=44, ro=94;
  const arr = fund||[]; const vals=arr.filter(Number.isFinite);
  if(vals.length<6) return '<div class="msg" style="height:200px;display:flex;align-items:center;justify-content:center">No funding schedule yet.</div>';
  const maxAbs = Math.max(...vals.map(Math.abs))||1e-9;
  let s=`<svg viewBox="0 0 ${W} ${H}" class="sclock" style="width:100%;height:auto;display:block">`;
  s+=clockScaffold(cx,cy,ri,ro,_szCash());
  for(let h=0;h<24;h++){ const f=arr[h]; if(!Number.isFinite(f)) continue;
    const col = f>0?'var(--down)':'var(--up)';   // >0 longs pay (cost), <0 longs receive
    const op = 0.2 + 0.62*(Math.abs(f)/maxAbs);
    s+=`<path d="${clockWedge(cx,cy,ri,ro,clockDeg(h)+1.4,clockDeg(h+1)-1.4)}" fill="${col}" fill-opacity="${op.toFixed(2)}"><title>${h}:00 ${_szTz()} · ${(f*100).toFixed(4)}%/h · ${f>0?'longs pay':'longs receive'}</title></path>`; }
  const net = arr.reduce((a,b)=>a+(Number.isFinite(b)?b:0),0);
  const netCls = net>0?'--down':(net<0?'--up':'--muted');
  s+=`<circle cx="${cx}" cy="${cy}" r="${ri}" fill="var(--panel)" stroke="var(--border)"/>`;
  s+=`<text x="${cx}" y="${cy-11}" text-anchor="middle" style="font-size:var(--fs-2xs);fill:var(--muted)">net / day</text>`;
  s+=`<text x="${cx}" y="${cy+4}" text-anchor="middle" style="font-size:var(--fs-lg);fill:var(${netCls})">${(net>0?'+':'')+(net*100).toFixed(3)}%</text>`;
  s+=`<text x="${cx}" y="${cy+17}" text-anchor="middle" style="font-size:var(--fs-2xs);fill:var(--faint)">${(net*365*100>0?'+':'')+(net*365*100).toFixed(0)}%/yr · 1× long</text>`;
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
  for(const c of Object.keys(byCls).sort()){ selHtml+=`<optgroup label="${esc(c)}">`+byCls[c].sort((a,b)=>String(a.ticker).localeCompare(String(b.ticker))).map(t=>opt('coin:'+t.coin, t.ticker, st.sel)).join('')+`</optgroup>`; }
  selHtml+=`</select>`;
  const mbtn=(m,l)=>`<button type="button" class="clockmetric${st.metric===m?' on':''}" data-m="${m}">${l}</button>`;
  const controls=`<div class="s-ctrls"><span class="lbl">clock</span>${selHtml}`+
    `<span class="clockseg">${mbtn('vol','range vol')}${mbtn('volume','volume')}</span>`+
    `<span class="rt">${esc(vec.label)} · ${esc(vec.sub||'')}</span></div>`;
  const ph=peakHour(st.metric==='volume'?vec.qr:vec.vr);
  const fh=vec.fund?peakHour(vec.fund.map(Math.abs)):null;
  const twin=`<div class="s-grid">`+
    `<div style="flex:1 1 240px;min-width:230px" class="s-card"><div style="color:var(--text);font-size:var(--fs-md);font-weight:600;margin-bottom:6px">Activity — when it moves</div>${activityClockSvg(vec, st.metric)}</div>`+
    `<div style="flex:1 1 240px;min-width:230px" class="s-card"><div style="color:var(--text);font-size:var(--fs-md);font-weight:600;margin-bottom:6px">Funding — <span style="color:var(--up)">receive</span> / <span style="color:var(--down)">pay</span> by hour</div>${fundingClockSvg(vec.fund)}</div>`+
    `</div>`;
  const _tz=_szTz();
  const cap=`Midnight ${_tz} at top, clockwise. Left clock: spoke length = that hour's range/volume vs the day's average — rings mark 1×, 2×…${_szCash()?' and the blue arc is the US cash session':''}${vec.hm?`; the amber arc is the ${sessEx(vec.hm)} home session — if this name's hump doesn't sit inside it, the home-session premise is wrong for the perp's own flow`:''}. Right clock: color = carry direction, brightness = size. `+
    (ph!=null?`Busiest near <b>${ph}:00 ${_tz}</b>`:'')+(fh!=null&&Number.isFinite(vec.fund[fh])?`; strongest carry near <b>${fh}:00 ${_tz}</b> (${vec.fund[fh]>0?'longs pay':'longs receive'})`:'')+`. <b>Hover</b> a wedge for exact values.`;
  return sHead('Hour-of-day clocks',`the robust timing layer — range volatility, volume and funding by ${_tz} hour`)+controls+twin+sCap(cap);
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
  let s=_szCash()?`<rect x="${X(9.5).toFixed(1)}" y="${pt}" width="${(X(16)-X(9.5)).toFixed(1)}" height="${H-pt-pb}" fill="var(--blue)" opacity="0.06"/>`:'';
  s+=lcGrid(pl,W-pr,lcTicks(lo,hi,4),Y,fmtTick);
  s+=`<line x1="${pl}" y1="${Y(base).toFixed(1)}" x2="${W-pr}" y2="${Y(base).toFixed(1)}" stroke="var(--faint)" stroke-dasharray="3 3" stroke-width="1"/>`;
  for(let h=0;h<=24;h+=6){ const hh=Math.min(h,23); s+=`<text x="${X(hh).toFixed(1)}" y="${H-9}" text-anchor="middle" class="lc-tick">${h}</text>`; }
  s+=`<text x="${(pl+W-pr)/2}" y="${H-1}" text-anchor="middle" class="lc-ax">${_szTz()} hour</text>`;
  for(const ser of series){
    let d='', pen=false;
    for(let h=0;h<24;h++){ const v=ser.vec[h]; if(!Number.isFinite(v)){ pen=false; continue; } d+=(pen?'L':'M')+X(h).toFixed(1)+' '+Y(v).toFixed(1)+' '; pen=true; }
    if(d) s+=`<path d="${d.trim()}" fill="none" stroke="${ser.color}" stroke-width="1.7" stroke-linejoin="round"/>`;
  }
  const xs=[]; for(let h=0;h<24;h++) xs.push(X(h));
  const rows=[]; for(let h=0;h<24;h++){ rows.push(`<b style="color:var(--text)">${h}:00 ${_szTz()}</b><br>`+series.map(ser=>`<span style="color:${ser.color}">${esc(ser.cls)} ${Number.isFinite(ser.vec[h])?fmtV(ser.vec[h]):'—'}</span>`).join('<br>')); }
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
    ? `Mean funding rate by ${_szTz()} hour, one line per class. Above the dashed zero = longs pay; below = longs receive.${_szCash()?' Blue band = US cash session.':''} <b>Hover</b> for exact rates.`
    : `Each class's pooled hour-of-day shape, normalized so 1× is its own daily average — this compares <b>timing</b>, not absolute size.${_szCash()?' Blue band = US cash session.':''} <b>Hover</b> for values.`;
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
  if(_szCash()){ const rx=lx+9.5*cw, rw=(16-9.5)*cw;
    s+=`<rect x="${rx.toFixed(1)}" y="${top}" width="${rw.toFixed(1)}" height="${(ch*5)}" fill="var(--blue)" opacity="0.06"/>`; }
  for(let row=0;row<7;row++){ const d=WD_ORDER[row]; const y=top+row*ch;
    s+=`<text x="${lx-6}" y="${(y+ch/2+3).toFixed(1)}" text-anchor="end" style="font-size:var(--fs-2xs);fill:${(d===0||d===6)?'var(--faint)':'var(--muted)'}">${WD_NAMES[d]}</text>`;
    for(let h=0;h<24;h++){ const x=lx+h*cw; const v=cells[d][h];
      s+=`<rect x="${x}" y="${y}" width="${cw-1}" height="${ch-1}" fill="var(--panel2)"/>`;
      if(Number.isFinite(v)){ const op=Math.max(0.04,Math.min(1,v/cap)); s+=`<rect x="${x}" y="${y}" width="${cw-1}" height="${ch-1}" fill="var(--accent)" fill-opacity="${op.toFixed(3)}"><title>${WD_NAMES[d]} ${h}:00 ${_szTz()} · ${v.toFixed(2)}× avg${ns[d]?' · n='+(ns[d][h]||0):''}</title></rect>`; }
    }
  }
  for(let h=0;h<=24;h+=3){ const hh=Math.min(h,23); const x=lx+hh*cw+cw/2; s+=`<text x="${x.toFixed(1)}" y="${(top+ch*7+13)}" text-anchor="middle" class="lc-tick">${h}</text>`; }
  s+=`<text x="${(lx+cw*24/2).toFixed(1)}" y="${(top+ch*7+21)}" text-anchor="middle" class="lc-ax">${_szTz()} hour</text>`;
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
  const cap=`Each cell is that weekday-hour's range/volume vs the group's own average — darker = busier.${_szCash()?' Blue block = weekday US cash session. Weekend rows sit empty for equities but stay alive for 24/7 crypto — the Friday→Monday gap is the overnight-risk story.':' Hours are UTC; the Friday→Monday weekend is the thin-book gap-risk story.'} <b>Hover</b> a cell for its value and sample count.`;
  return sHead('Day-of-week × hour heatmap','the weekend-gap and Friday→Monday risk map')+controls+legend+`<div class="s-card" style="overflow-x:auto">${dowHeatSvg(r.grid, st.metric)}</div>`+sCap(cap);
}
function attachDowControls(){
  const sel=el('dowsel'); if(sel) sel.addEventListener('change',()=>{ state.analytics.dow.sel=sel.value; drawSessions(); });
  document.querySelectorAll('.dowmetric').forEach(b=>b.addEventListener('click',()=>{ state.analytics.dow.metric=b.dataset.m; drawSessions(); }));
}

// ---- funding heatmap: every market's carry, at 1h / 8h / 24h ----
// Rows are markets, columns are time buckets, and a cell is the funding a 1× long PAID over that
// bucket — so the timeframe buttons change the QUANTITY, not the zoom: the same market reads
// ~0.00125%/1h, ~0.01%/8h, ~0.03%/24h. Each timeframe carries its own colour cap from the server
// (a percentile of that grid's own |cells|), so one blowout never flattens the rest and a re-sort
// never repaints the survivors.
//
// Colour is the app's standing carry semantic, shared with the funding clock: red = longs pay,
// green = longs receive, neutral midpoint = the panel itself, so flat carry reads as "nothing
// here" rather than as a hue of its own. Red/green is the hard pair for deuteranopes, so the sign
// is carried twice more without colour — every row is direct-labelled with its signed mean, and
// every cell's tooltip names the direction in words. An unknown bucket is HATCHED, never
// zero-filled: a gap in the funding spine and a genuinely flat market must not look alike.
const FH_STRIDE={'1h':6,'8h':6,'24h':5};        // label every Nth column — chosen to land on clean 6h/2d/5d marks
// Two families of carry sort: by the window MEAN (pay / recv / abs) and by the NOW column
// (nowpay / nowrecv / nowabs, build 2026.09.21-82) — the same three readings of the live rate.
// Both are unit-blind (a positive multiplier keeps every ranking), and a now-sort reorders on the
// snapshot path the moment a rate rolls, because that is when "paying most right now" changes.
const FH_SORTS=[['oi','open interest'],['pay','longs pay most'],['recv','longs receive most'],['abs','strongest carry'],
  ['nowpay','now: longs pay most'],['nowrecv','now: longs receive most'],['nowabs','now: strongest'],['tkr','ticker A–Z']];
const FH_ROWOPTS=[['25','top 25'],['50','top 50'],['all','all rows']];
// ---- the unit layer (build 2026.09.16-77): annualized by default, per bucket one click away ----
// The grid shipped reading per bucket — an honest cost, but a unit nothing else on the site uses:
// the Markets table, the terminal, the carry column and the drawer all quote funding as an
// annualized rate (hourly ×24×365). So the default read is now that rate, and per bucket stays as
// the second unit because it answers a different question (what the last day actually COST).
// Annualizing is a multiplier over the payload the server already ships — a cell is the mean
// hourly rate the spine saw in the bucket scaled to the bucket's width, so ×(8760/bucketHours)
// scales the same mean to a year and one market reads ONE number at 1h, 8h and 24h. No new
// field, no ETag change, no rebuild. The multiplier is positive, so every sort is unit-blind.
//
// Under 'apr' the three resolutions share ONE colour cap — the default (8h) grid's own percentile,
// annualized. Per bucket each timeframe needs its own cap because the 8h quantity genuinely is
// eight times the 1h one; annualized they are one quantity sampled three ways (different windows,
// different smoothing), and a cell that changed hue because you changed the resolution would be a
// zoom that repaints. Hourly spikes saturate more often under the shared cap; that is what a cap
// is for. The colour of a rate never depends on how finely it was sliced.
const FH_UNITS=[['apr','annualized'],['bucket','per bucket']];
const FH_HPY=24*365;
function fhUnit(){ return state.analytics.fheat.unit==='bucket'?'bucket':'apr'; }
function fhAnn(fh,tf){ const ax=(fh&&fh.axis||{})[tf]; return ax&&ax.bucketHours>0?FH_HPY/ax.bucketHours:1; }
function fhCapApr(fh,tf){ const axs=(fh&&fh.axis)||{}, k=axs[fh&&fh.tfDefault]?fh.tfDefault:tf; return ((axs[k]||{}).cap||0)*fhAnn(fh,k); }
function fhCap(fh,tf){ return fhUnit()==='apr'?fhCapApr(fh,tf):((fh&&fh.axis||{})[tf]||{}).cap; }
function fhCells(fh,row,tf){ const c=(row.tf&&row.tf[tf])||[]; if(fhUnit()!=='apr') return c;
  const a=fhAnn(fh,tf); return c.map(v=>(v==null||!isFinite(v))?null:v*a); }   // an unknown ×1095 is still unknown
// An annual rate deserves fewer decimals than a bucket cost: one above a 10% cap, two below, never
// more — the inputs are hourly prints rounded to the basis point, and "+11.412%" is false precision.
function fhDpApr(cap){ const c=Math.abs((cap||0)*100)||1e-9; return clamp(2-Math.floor(Math.log10(c)),0,2); }
function fhDpU(cap){ return fhUnit()==='apr'?fhDpApr(cap):fhDp(cap); }
function fhUnitTag(tf){ return fhUnit()==='apr'?'APR':'per '+tf; }
// ---- the "now" column (build 2026.09.20-81): the market's CURRENT funding beside the window mean ----
// The mean says what the window averaged; the live rate says what the book is paying this hour,
// which is the number a reader arriving from the Markets table already has in mind. It is read
// off the client's own streaming snapshot (state.rows, keyed by coin — the same keys the board
// ships), never from the board payload: the snapshot refreshes every ~15s, the board every 60s,
// and a "current" rate that was 60s stale by construction would be a mean wearing a live label.
// Printed in the unit on screen — hourly ×24×365 annualized, hourly × bucketHours per bucket —
// so the two columns are directly comparable: now above mean = carry is building.
let _fhNowSig='';
function fhNowOf(r){ const lr=r&&r.coin?state.rows.get(r.coin):null; const f=lr?lr.funding:null; return (f==null||!isFinite(f))?null:f; }
function fhNowSig(fh){ if(!fh||!Array.isArray(fh.rows)) return ''; let s='';
  for(const r of fh.rows){ const f=fhNowOf(r); s+=(f==null?'x':f.toExponential(4))+','; } return s; }
// Called from the snapshot path: a funding roll while the tab is open repaints the column, an
// unchanged rate does not (a repaint every 15s would reset every open tooltip on the grid).
function fhLiveRefresh(){ if(state.view!=='funding') return; const v=state.funding&&state.funding.view, fh=v&&v.data;
  if(fh&&Array.isArray(fh.rows)&&fh.rows.length&&fhNowSig(fh)!==_fhNowSig) renderFunding(); }
function fhColor(v,cap){
  if(v==null||!isFinite(v)) return null;                       // null = unknown; the caller hatches it
  const t=clamp(Math.abs(v)/(cap>0?cap:1e-12),0,1);
  const k=Math.pow(t,0.7);                                     // lift the small end so a quiet cell is still legibly tinted
  const mid=[20,26,33], tg=v>0?[229,96,77]:[70,185,126];       // >0 longs pay (--down), <0 longs receive (--up)
  return `rgb(${lerp(mid[0],tg[0],k)},${lerp(mid[1],tg[1],k)},${lerp(mid[2],tg[2],k)})`;
}
function fhTf(fh){ const tfs=(fh&&fh.tfs)||['1h','8h','24h'], st=state.analytics.fheat;
  return tfs.indexOf(st.tf)>-1?st.tf:((fh&&fh.tfDefault)||tfs[0]); }
function fhMean(row,tf){ const c=(row.tf&&row.tf[tf])||[]; let s=0,n=0;
  for(const v of c) if(Number.isFinite(v)){ s+=v; n++; } return n?s/n:null; }
// Time labels follow the payload's own tz (ET for the xyz book, UTC for the 24/7 crypto book) —
// the same clock every other session study is drawn on. Built once per tz, not per cell.
let _fhFmtTz=null,_fhFmtD=null,_fhFmtH=null;
function fhFmts(tz){ if(_fhFmtTz!==tz){ const z=tz==='UTC'?'UTC':'America/New_York';
    _fhFmtD=new Intl.DateTimeFormat('en-GB',{timeZone:z,month:'short',day:'numeric'});
    _fhFmtH=new Intl.DateTimeFormat('en-GB',{timeZone:z,hour:'2-digit',minute:'2-digit',hour12:false});
    _fhFmtTz=tz; }
  return {d:_fhFmtD,h:_fhFmtH}; }
// Percent at the precision the grid deserves. The whole mean column shares ONE dp, derived from
// that timeframe's colour cap (THREE significant figures at the cap), so the numbers line up and a
// 1h grid is not forced into the same decimals as a 24h one. Three, not two: at 8h the cap sits
// near 0.1%, and two figures collapsed a whole book into "+0.01%" — the third decimal is what
// separates one row's carry from the next. A value that rounds away prints as
// "~0%" rather than "-0.0000%" — a string of zeros still claims a direction the number lacks.
function fhDp(cap){ const c=Math.abs((cap||0)*100)||1e-9; return clamp(2-Math.floor(Math.log10(c)),3,6); }
function fhPct(v,dp){
  if(v==null||!isFinite(v)) return '\u2014';
  const body=Math.abs(v*100).toFixed(dp==null?4:dp);
  if(!parseFloat(body)) return '\u22480%';
  return (v>0?'+':'\u2212')+body+'%';
}
function fhSortRows(rows,tf,sort){
  const a=rows.slice();
  if(sort==='tkr') a.sort((x,y)=>x.ticker<y.ticker?-1:(x.ticker>y.ticker?1:0));
  else if(sort==='oi') a.sort((x,y)=>((y.oi==null?-1:y.oi)-(x.oi==null?-1:x.oi))||(x.ticker<y.ticker?-1:1));
  else { const now=sort.startsWith('now'), kind=now?sort.slice(3):sort;
    const key=r=>{ const m=now?fhNowOf(r):fhMean(r,tf); return m==null?null:(kind==='abs'?Math.abs(m):(kind==='recv'?-m:m)); };
    a.sort((x,y)=>{ const kx=key(x),ky=key(y);
      if(kx==null&&ky==null) return x.ticker<y.ticker?-1:1;
      if(kx==null) return 1; if(ky==null) return -1;
      return (ky-kx)||(x.ticker<y.ticker?-1:1); }); }
  return a;
}
// Time-axis ticks. Buckets are anchored to the EPOCH, so an 8h bucket never opens at local
// midnight (ET is UTC-4/5) — asking "is this tick midnight?" labels nothing and the axis reads as
// the same clock time seven times over. A date tick is instead the first bucket whose LOCAL DATE
// differs from the bucket before it; sub-daily grids top up the gaps with clock ticks. Labels are
// then packed newest-first and only kept where they physically fit, so nothing ever overprints.
function fhTicks(ax,f,nb,cw){
  // Deliberately generous against the 8px axis type: the packer keeps every label that FITS, so
  // a tighter estimate would just crowd the axis with dates nobody asked for. Breathing room
  // is the point of the smaller type, not more ticks.
  const wOf=(lab)=>lab.length*6+12;
  const day=[]; let prev=null;
  for(let i=0;i<nb;i++){ const d=f.d.format(ax.t0+i*ax.width); if(d!==prev){ day.push(i); prev=d; } }
  const isDay=new Set(day);
  const cands=day.map((i)=>({i,lab:f.d.format(ax.t0+i*ax.width),day:true}));
  if(ax.bucketHours<24){ const hs=Math.max(1,Math.round(6/ax.bucketHours));
    for(let i=nb-1;i>=0;i-=hs) if(!isDay.has(i)) cands.push({i,lab:f.h.format(ax.t0+i*ax.width),day:false}); }
  for(const c of cands) c.w=wOf(c.lab);
  cands.sort((a,b)=>(b.day?1:0)-(a.day?1:0)||b.i-a.i);   // dates win the space, newest first
  const kept=[];
  for(const c of cands){ const x=c.i*cw+cw/2;
    if(kept.every((k)=>Math.abs((k.i*cw+cw/2)-x)>=(k.w+c.w)/2)) kept.push(c); }
  return kept.sort((a,b)=>a.i-b.i);
}
function fhHeatSvg(fh,rows,tf){
  const ax=(fh.axis||{})[tf]; if(!ax||!rows.length) return '<div class="msg">No funding grid yet.</div>';
  // cap and decimals follow the UNIT: per bucket they are this timeframe's own (cap=ax.cap); annualized the
  // cap is shared across resolutions (fhCapApr) and the decimals are an annual rate's, not a bucket cost's.
  const nb=ax.buckets, apr=fhUnit()==='apr', ann=fhAnn(fh,tf), cap=fhCap(fh,tf), f=fhFmts(fh.tz), dp=fhDpU(cap), zero=0.5*Math.pow(10,-dp)/100;
  // Geometry is deliberately tight: the grid must fit a laptop screen without scrolling, and the
  // SVG scales to its container, so a shorter row against the same width is what shrinks it.
  // The label gutter is measured, not guessed: a fixed one clipped the longest ticker on the
  // book (BRENTOIL read as "3RENTOIL"), and a half-drawn ticker is worse than a narrower grid.
  let mtk=0; for(const r of rows) if(r.ticker&&r.ticker.length>mtk) mtk=r.ticker.length;
  const lx=clamp(Math.ceil(mtk*5.7)+9,40,86), rx=126, pt=18, ch=13, pb=26, W=780;   // right gutter holds TWO numbers: window mean, then now
  const nowMul=apr?FH_HPY:ax.bucketHours, nowTip=apr?'current funding \u2014 this hour\u2019s rate \u00d724\u00d7365, from the live snapshot':`current funding \u2014 this hour\u2019s rate \u00d7 ${ax.bucketHours}h, from the live snapshot`;
  const cw=(W-lx-rx)/nb, H=pt+ch*rows.length+pb;
  const pid='fhg'+(++_hoverSeq);   // one hatch pattern per render — ids must not collide across redraws
  let s=`<svg viewBox="0 0 ${W} ${H.toFixed(1)}" class="sheat fheat" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">`+
    `<defs><pattern id="${pid}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">`+
    `<rect width="4" height="4" fill="var(--panel2)"/><line x1="0" y1="0" x2="0" y2="4" stroke="var(--faint)" stroke-width="1" stroke-opacity=".45"/></pattern></defs>`+
    `<text x="${lx-7}" y="13" text-anchor="end" class="fh-hd">market</text>`+
    `<text x="${W-66}" y="13" text-anchor="end" class="fh-hd">${apr?'mean APR':'mean / '+esc(tf)}</text>`+
    `<text x="${W-4}" y="13" text-anchor="end" class="fh-hd"><title>${esc(nowTip)}</title>${apr?'now APR':'now / '+esc(tf)}</text>`;
  rows.forEach((r,ri)=>{
    const y=pt+ri*ch, cells=fhCells(fh,r,tf), mraw=fhMean(r,tf), mean=mraw==null?null:mraw*(apr?ann:1);
    s+=`<text x="${lx-7}" y="${(y+ch/2+3.3).toFixed(1)}" text-anchor="end" class="fh-tk" data-coin="${esc(r.coin||'')}">${esc(r.ticker)}</text>`;   // data-coin: the share glyph's handle (build 2026.09.24-98)
    for(let i=0;i<nb;i++){
      const x=lx+i*cw, v=cells[i], col=fhColor(v,cap);
      const t0=ax.t0+i*ax.width, when=f.d.format(t0)+(ax.bucketHours>=24?'':' '+f.h.format(t0));
      // Both units in every tooltip: the rate says how crowded, the bucket says what it cost, and a
      // reader sizing a hold wants the second even while scanning by the first.
      const side=v>0?'longs pay':(v<0?'longs receive':'flat');
      const tip=`${r.ticker} \u00b7 ${when} ${fh.tz} \u00b7 ${ax.bucketHours}h bucket\n`+
        (col==null?'no funding data for this bucket'
          :apr?`${fhPct(v,dp+1)} APR \u2014 ${side} \u00b7 ${fhPct(v/ann,fhDp(ax.cap)+1)} over this ${ax.bucketHours}h bucket`
              :`${fhPct(v,dp+1)} \u2014 ${side} \u00b7 ${fhPct(v*ann,fhDpApr(fhCapApr(fh,tf))+1)} APR`);
      s+=`<rect x="${x.toFixed(2)}" y="${y}" width="${Math.max(0.5,cw-1).toFixed(2)}" height="${ch-1}" `+
         `fill="${col==null?`url(#${pid})`:col}"><title>${esc(tip)}</title></rect>`;
    }
    // Direct label: the row's signed mean per bucket. The sign is the whole point — it says which
    // way the carry runs without asking the reader to separate red from green.
    const flat = mean==null||Math.abs(mean)<zero;   // rounds away -> it is not a direction, so it wears neither colour
    s+=`<text x="${W-66}" y="${(y+ch/2+3.3).toFixed(1)}" text-anchor="end" class="fh-nv ${flat?'sec':(mean>0?'neg':'pos')}">${esc(fhPct(mean,dp))}</text>`;
    // Now: the live rate in the same unit, same decimals, same sign rule — so the two columns read
    // as one pair. A market the snapshot has not priced prints a dash, never a zero.
    const fnow=fhNowOf(r), now=fnow==null?null:fnow*nowMul, nflat=now==null||Math.abs(now)<zero;
    s+=`<text x="${W-4}" y="${(y+ch/2+3.3).toFixed(1)}" text-anchor="end" class="fh-nv ${nflat?'sec':(now>0?'neg':'pos')}"><title>${esc(r.ticker)} \u00b7 ${esc(nowTip)}</title>${esc(fhPct(now,dp))}</text>`;
  });
  const ay=pt+ch*rows.length;
  s+=`<line x1="${lx}" y1="${(ay+3).toFixed(1)}" x2="${(W-rx).toFixed(1)}" y2="${(ay+3).toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`;
  for(const t of fhTicks(ax,f,nb,cw)){
    const x=lx+t.i*cw+cw/2;
    s+=`<line x1="${x.toFixed(1)}" y1="${(ay+3).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(ay+6).toFixed(1)}" stroke="var(--faint)" stroke-width="1"/>`+
       `<text x="${x.toFixed(1)}" y="${(ay+14).toFixed(1)}" text-anchor="middle" class="lc-tick">${esc(t.lab)}</text>`;
  }
  s+=`<text x="${((lx+W-rx)/2).toFixed(1)}" y="${(ay+23).toFixed(1)}" text-anchor="middle" class="lc-ax">${esc(fh.tz)} \u00b7 ${ax.bucketHours}h buckets \u00b7 oldest left${apr?' \u00b7 annualized':''}</text>`;
  return s+'</svg>';
}
function renderFundHeat(fh){
  const st=state.analytics.fheat, tf=fhTf(fh), ax=(fh.axis||{})[tf]||{}, apr=fhUnit()==='apr', cap=fhCap(fh,tf);
  _fhNowSig=fhNowSig(fh);   // what the now column was painted from; the snapshot path repaints only when this moves
  const sorted=fhSortRows(fh.rows||[],tf,st.sort);
  const lim=st.rows==='all'?sorted.length:Math.min(sorted.length,parseInt(st.rows,10)||25);
  const shown=sorted.slice(0,lim);
  const tbtn=(k)=>`<button type="button" class="fhtf${tf===k?' on':''}" data-tf="${k}">${k}</button>`;
  const opt=(v,l,sel)=>`<option value="${esc(v)}"${sel===v?' selected':''}>${esc(l)}</option>`;
  const ubtn=([k,l])=>`<button type="button" class="fhunit${fhUnit()===k?' on':''}" data-u="${k}">${l}</button>`;
  // The timeframe label follows the unit: per bucket the buttons choose what the cell IS ("funding
  // per"); annualized they choose how finely one rate is sliced ("resolution").
  const controls=`<div class="s-ctrls"><span class="lbl">read as</span>`+
    `<span class="clockseg">${FH_UNITS.map(ubtn).join('')}</span>`+
    `<span class="lbl">${apr?'resolution':'funding per'}</span>`+
    `<span class="clockseg">${(fh.tfs||['1h','8h','24h']).map(tbtn).join('')}</span>`+
    `<span class="lbl">sort</span><select id="fhsort" class="clocksel">${FH_SORTS.map(([v,l])=>opt(v,l,st.sort)).join('')}</select>`+
    `<select id="fhrows" class="clocksel">${FH_ROWOPTS.map(([v,l])=>opt(v,l,st.rows)).join('')}</select>`+
    `<span class="rt">${shown.length} of ${fh.count} markets${fh.capped?` · top ${fh.rowCap} of ${fh.universe} by OI`:''}</span></div>`;
  const capPct=fhPct(cap,fhDpU(cap)).replace('+',''), capU=apr?' APR':'';
  const legend=`<div class="s-leg"><span class="it">−${esc(capPct)}${capU} · longs receive</span>`+
    `<span style="width:150px;height:10px;border-radius:3px;display:inline-block;background:linear-gradient(90deg,rgb(70,185,126),rgb(20,26,33),rgb(229,96,77))"></span>`+
    `<span class="it">longs pay · +${esc(capPct)}${capU}</span>`+
    `<span class="it" style="margin-left:6px"><span class="fh-gapsw"></span>no data</span>`+
    `<span class="it">${esc(fhUnitTag(tf))}</span></div>`;
  const pctl=Math.round((fh.capPctl||0.98)*100), cov=Math.round((fh.minCov||0.5)*100);
  const capTxt=apr
    ?`One row per market, one column per ${ax.bucketHours}h bucket; a cell is that bucket's funding <b>annualized</b> — the mean hourly rate the spine saw, ×24×365, the same convention as the funding column on the Markets table — `+
     `<b>red = longs pay</b> (crowded long, carry is a cost), <b>green = longs receive</b> (crowded short, carry pays you to be long). `+
     `The resolution buttons change how finely the same rate is sliced, not the quantity: one market reads one number at 1h, 8h and 24h. `+
     `The scale is capped at ±${esc(capPct)} APR — the ${esc(fh.tfDefault||'8h')} grid's own ${pctl}th percentile, shared by all three resolutions so a zoom never repaints a cell; beyond it the cell just saturates. `+
     `Hatched cells are gaps in the funding spine, not flat carry — a bucket needs ≥${cov}% of its hours to print. `+
     `The two numbers on the right are that row's mean annualized rate over the window and its <b>current</b> funding (this hour's rate, annualized, from the live snapshot) — now above mean means carry is building. <b>Hover</b> any cell for its rate and what it cost over the bucket.`
    :`One row per market, one column per ${ax.bucketHours}h bucket; a cell is the funding a <b>1× long paid</b> over that bucket — `+
     `<b>red = longs pay</b> (crowded long, carry is a cost), <b>green = longs receive</b> (crowded short, carry pays you to be long). `+
     `The timeframe buttons change the quantity, not the zoom: the same market reads roughly 8× larger per 8h than per 1h. `+
     `The scale is capped at the grid's own ${pctl}th percentile (±${esc(capPct)} per ${esc(tf)}) so one blowout can't flatten everything else; `+
     `beyond that the cell just saturates. Hatched cells are gaps in the funding spine, not flat carry — a bucket needs ≥${cov}% of its hours to print. `+
     `The two numbers on the right are that row's mean per bucket over the window and its <b>current</b> funding (this hour's rate × the bucket width, from the live snapshot). <b>Hover</b> any cell for its exact rate, direction and annualized equivalent.`;
  // No sHead: the board IS the tab now, so the tab's own title carries the name. A section header
  // here would print the same sentence twice, one line apart.
  return controls+legend+`<div class="s-card" style="overflow-x:auto">${fhHeatSvg(fh,shown,tf)}</div>`+sCap(capTxt);
}
// A heatmap row as a card (build 2026.09.24-98): the grid is a picture (SVG), so the row is read from
// the payload that drew it, in the unit on screen — the window mean, the live now, the window, and
// the row's cells as the card's spark (zero-lined: the sign is the reading). Same numbers, same
// formatter, same "flat wears no colour" rule as the row's own labels.
function fhShareCard(coin){
  const fh=((state.funding&&state.funding.view)||{}).data; if(!fh||!Array.isArray(fh.rows)) return null;
  const row=fh.rows.find(r=>r.coin===coin); if(!row) return null;
  const tf=fhTf(fh), ax=(fh.axis||{})[tf]; if(!ax) return null;
  const apr=fhUnit()==='apr', cap=fhCap(fh,tf), dp=fhDpU(cap), zero=0.5*Math.pow(10,-dp)/100;
  const cells=fhCells(fh,row,tf), mraw=fhMean(row,tf), mean=mraw==null?null:mraw*(apr?fhAnn(fh,tf):1);
  const fnow=fhNowOf(row), now=fnow==null?null:fnow*(apr?FH_HPY:ax.bucketHours);
  const cls=v=>v==null||Math.abs(v)<zero?'sec':(v>0?'neg':'pos');   // red = longs pay, as on the grid
  const L=(t,v,c)=>({t,c:[{s:v,c:c||''}]});
  return shPanel({ view:'funding', coin, title:'Funding heat \u00b7 '+tf+(apr?' \u00b7 APR':' \u00b7 per bucket'),
    rows:[L(apr?'mean APR':'mean / '+tf,fhPct(mean,dp),cls(mean)), L(apr?'now APR':'now / '+tf,fhPct(now,dp),cls(now)),
      L('window',ax.buckets+' \u00d7 '+ax.bucketHours+'h buckets','sec'), L('reads','+ = longs pay \u00b7 \u2212 = longs receive','sec')],
    spark:{ v:cells.map(v=>v==null?null:v*100), l:'funding '+fhUnitTag(tf)+' per bucket, oldest left (%)', z:true } });
}
function attachFundHeatControls(){
  document.querySelectorAll('.fhunit').forEach(b=>b.addEventListener('click',()=>{ state.analytics.fheat.unit=b.dataset.u==='bucket'?'bucket':'apr';
    try{ localStorage.setItem('xyz-fh-unit', state.analytics.fheat.unit); }catch(_){}
    renderFunding(); }));
  document.querySelectorAll('.fhtf').forEach(b=>b.addEventListener('click',()=>{ state.analytics.fheat.tf=b.dataset.tf; renderFunding(); }));
  const s=el('fhsort'); if(s) s.addEventListener('change',()=>{ state.analytics.fheat.sort=s.value; renderFunding(); });
  const r=el('fhrows'); if(r) r.addEventListener('change',()=>{ state.analytics.fheat.rows=r.value; renderFunding(); });
}
// ---- FUNDING tab (build 2026.08.26-34) ------------------------------------------------------
// The board rides its OWN payload. As a section of /api/analytics, opening it meant pulling the
// entire session study set — levels, anatomy, seasonality, the decomposition — to paint one grid,
// and waiting on the analytics build cadence to do it. Same two-slot discipline the sessions tab
// uses: each universe lands in its own slot, so a scope flip mid-flight can never paint a crypto
// grid into a stocks view, and `view` points at whichever slot matches the live scope.
// Per-scope inflight + freshness. Held globally, a stocks fetch in flight would swallow the
// crypto refetch that applyScope fires on a flip, and a recent stocks load would convince
// openFunding that an empty crypto slot needed no fetch — the tab then sits on "Loading..."
// until the TTL lapses AND it is re-entered.
const _fundingInflight={stocks:false,crypto:false}, _fundingLast={stocks:0,crypto:0};
function fundingSlot(){ return state.scope==='crypto'?'crypto':'stocks'; }
function syncFundingSlot(){ state.funding.view=state.funding[fundingSlot()]; }
async function loadFunding(){
  const k=fundingSlot();                       // captured up front: the answer lands in the slot it was asked for
  if(_fundingInflight[k]) return;
  _fundingInflight[k]=true;
  try{ const d=await fetchJSON(k==='crypto'?'/api/funding?u=crypto':'/api/funding');
    state.funding[k]={data:d,err:null,ts:Date.now()}; _fundingLast[k]=Date.now();
  }catch(e){ state.funding[k]=Object.assign({},state.funding[k],{err:e.message||String(e)}); }
  finally{ _fundingInflight[k]=false; syncFundingSlot(); }
  if(state.view==='funding') renderFunding();
  // The scope may have flipped while this was in flight; the slot it just filled is no longer the
  // one on screen, so fetch the one that is.
  if(fundingSlot()!==k && state.view==='funding') loadFunding();
}
function fundingStale(){ const k=fundingSlot();
  return !state.funding[k].data || Date.now()-_fundingLast[k]>60*1000; }
function openFunding(){ syncFundingSlot(); renderFunding(); if(fundingStale()) loadFunding(); }
function renderFunding(){
  const host=el('funding-body'); if(!host) return;
  syncFundingSlot();
  const slot=state.funding.view||{}, fh=slot.data, err=slot.err;
  const title=`<div class="cp-head">Funding heatmap <span class="sec" style="font-weight:400;font-size:var(--fs-sm)">\u2014 every market\u2019s carry over calendar time, at 1h \u00b7 8h \u00b7 24h</span></div>`;
  if(err && !fh){ host.innerHTML=title+`<div class="msg">Couldn\u2019t load the funding board: ${esc(err)}. Retrying on the next refresh.</div>`; return; }
  if(!fh){ host.innerHTML=title+`<div class="msg">Loading\u2026</div>`; return; }
  // A build that throws every cycle and a cache that has not filled yet look identical from here.
  // The server ships the reason when it has one, so say which it is rather than promising progress.
  if(fh.buildError){
    host.innerHTML=title+`<div class="msg">The funding board is failing server-side: ${esc(fh.buildError)}`+
      `<br><span class="sec">Retrying every cycle. This is a bug, not a warm-up \u2014 the reason above is from the server log.</span>`+
      (Array.isArray(fh.rows)&&fh.rows.length?`<br><span class="sec">The grid below is the last one that built.</span></div>`+renderFundHeat(fh):`</div>`);
    if(Array.isArray(fh.rows)&&fh.rows.length) attachFundHeatControls();
    return; }
  if(fh.pending || !Array.isArray(fh.rows) || !fh.rows.length){
    host.innerHTML=title+`<div class="msg">Warming up \u2014 the grid needs \u2265${fh.need||5} markets with a funding spine (have ${fh.count||0}).`+
      `<br><span class="sec">The spine is seeded from the persisted OI samples on boot, so this fills in within a poll or two of a cold start.</span></div>`;
    return; }
  const age=slot.ts?`updated ${Math.max(0,Math.round((Date.now()-slot.ts)/1000))}s ago`:'';
  // `universe` counts markets that HAVE a funding spine; `book` is the roster. Billing the first
  // as the second read as "30 of 30 in the book" on a book of 140.
  const status=`<div class="sg-status">${fh.count} shown \u00b7 ${fh.universe} with a funding spine`+
    `${fh.book?` \u00b7 ${fh.book} in the ${fh.isCrypto?'main':'xyz'} book`:''}`+
    `${fh.capped?` \u00b7 top ${fh.rowCap} by OI`:''}`+
    ` \u00b7 ${Math.round((fh.minCov||0.5)*100)}% bucket-coverage floor \u00b7 ${esc(fh.tz)}${age?' \u00b7 '+age:''}</div>`;
  host.innerHTML=title+status+renderFundHeat(fh);
  attachFundHeatControls();
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
      s+=`<text x="${(+cx+8).toFixed(1)}" y="${(+cy+3).toFixed(1)}" style="font-size:var(--fs-2xs);fill:var(--down)">${esc(p.ticker)}</text>`; }
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
    `<span style="color:var(--down);font-family:var(--mono);font-size:var(--fs-xs);letter-spacing:.5px;font-weight:600">⚠ EXPLORATORY</span> `+
    `<span class="sec" style="font-size:var(--fs-sm)">${bannerBody}</span></div>`;
  const cap = `Bar height = mean return in basis points; whiskers = ±1 standard error across ${isTS?"this name's trading days":'the cross-section'}. Grey bars are noise; green/red bars cleared |t|≥2. Blue band = US cash session. <b>Hover</b> a bar for its mean, t-stat and sample size.`;
  return sHead('Return seasonality by hour','quarantined — pick all, a sector or one name; grey is noise, colored cleared significance')+controls+banner+sCard(seasonBarSvg(v.hours))+sCap(cap);
}
function attachSeasonControls(){ const sel=el('seasonsel'); if(sel) sel.addEventListener('change',()=>{ state.analytics.season.sel=sel.value; drawSessions(); }); }
export { IS_ADMIN, WD_NAMES, _hoverReg, _szCash, applyHash, attachClockControls, attachDowControls, attachLineHover, attachOverlayControls, attachSeasonControls, covPct, featureOn, fhLiveRefresh, fhShareCard, fp, hoverChart, lcGrid, lcTicks, loadAnalytics, loadFunding, openAdmin, openFunding, renderClassOverlay, renderClocks, renderClusters, renderDow, renderFunding, renderSeasonality, renderSessionDecomp, renderSessions, sCap, sCard, sHead, sLeg, sessDate, syncAnalyticsSlot, syncFundingSlot, tabVisible, toggleViewAsPublic };
