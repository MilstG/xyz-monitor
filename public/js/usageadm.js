// usageadm.js — the Admin tab's Usage fold (build 2026.09.24-109). Lazy (core.js LAZY_IMPORTERS):
// only an operator who opens the fold ever downloads it. Reads GET /api/admin/usage?r=7|30 (the
// sitewide aggregates — not logged) and, on a member row click, GET /api/admin/usage/member?h=
// (one member's detail — WRITTEN TO THE AUDIT LOG, shown in All messages → Read log).
// Every handle, display name and label goes through esc(): member text is member-controlled.
// (build 2026.09.24-110) Stage B+C sections: the ET heatmap, the adoption funnel, join-week
// retention, the drill-in's features row, and client health. Error messages come from BROWSERS —
// any member (or anything injected into their page) can make one say anything — so the message,
// the file:line and the build all go through esc() like every other string here, never raw.
// (build 2026.09.24-111) Deploy & gate markers on the daily-active chart plus their list with the
// affected tab's reach before/after; the post-deploy verdict card; the error triage list with a
// resolve toggle (POST /api/admin/usage/errors — the only write this fold makes, by signature).
// Marker details are operator config (feature keys, build stamps) and still go through esc().
// (build 2026.09.24-112) Sitewide sections (no member in any of them): tab paths (top transitions,
// "where people go from X", entry tabs) with a READ-ONLY suggested nav order; control usage per tab
// with "never used in range" highlighted and the quiet-controls list; time per tab by device class.
// Tab labels, control keys and values all come from the payload and still go through esc().
// (build 2026.09.24-113) "Digest & nudges": the weekly operator digest's settings (on/off, ET weekday),
// last sent, this week's schedule and a PREVIEW of its text (plain text from the server — member display
// names and browser-supplied error messages in it, so it goes through esc() like everything else), the
// "send test now" button, the opt-in lapsed-member nudge (toggle + the lead text) and the nudge log (the
// dm_audit 'usage-nudge' rows). Reads GET /api/admin/usage/digest; writes POST …/digest and …/digest/test.
// (build 2026.09.25-122) Public (signed-out) visitors: a "who" control — members | public | both — over
// the KPIs, the daily chart (stacked for both), the heatmap, the tab table (public reach = the MEAN DAILY
// reach, since a visitor is never linked across days), the sitewide sections and client health. Every
// number says which population it counts. The deploy markers' reach, adoption, cohorts and the members
// table stay members-only and say so. The chip shows the public path's live state (visitors today,
// drops); a checkbox writes the toggle (POST /api/admin/usage/public). Public numbers are aggregates
// the server derived without any identifier; they still go through esc() wherever text is involved.
import { el, esc } from "./core.js";

const UA={r:7,data:null,err:null,loading:false,loadedAt:0,msort:{k:'days',d:-1},tsort:{k:'ms',d:-1},sel:null,detail:null,wired:false,
  triBusy:null,triErr:null,   // (-111) the triage toggle in flight, and its last error
  pathTab:null,ctlTab:null,   // (-112) the tab picked for "where people go from X", and for its controls
  dg:{data:null,err:null,busy:null,msg:null,draft:null},   // (-113) digest & nudges: payload, error, action in flight, last result, unsaved reminder text
  who:'members',pubBusy:false,pubErr:null};   // (build 2026.09.25-122) the population shown; the public toggle in flight / its last error
const UA_STALE_MS=60000;

async function uaLoad(){
  UA.loading=true; uaRender();
  try{
    const r=await fetch('/api/admin/usage?r='+UA.r,{headers:{accept:'application/json'}});
    if(!r.ok) throw new Error('HTTP '+r.status);
    UA.data=await r.json(); UA.err=null; UA.loadedAt=Date.now();
  }catch(e){ UA.err=String(e&&e.message||e); }
  UA.loading=false; uaRender();
  uaDgLoad();   // (-113) the digest & nudges sub-section rides every refresh
}
// ---- (build 2026.09.24-113) digest & nudges ------------------------------------------------------------
async function uaDgLoad(){
  try{
    const r=await fetch('/api/admin/usage/digest',{headers:{accept:'application/json'}});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||('HTTP '+r.status));
    UA.dg.data=d; UA.dg.err=null;
  }catch(e){ UA.dg.err=String(e&&e.message||e); }
  uaRender();
}
async function uaDgPost(url,body,what){
  if(UA.dg.busy) return;
  UA.dg.busy=what; UA.dg.msg=null; uaRender();
  try{
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body||{})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||d.ok===false) UA.dg.msg={bad:true,text:d.error||('HTTP '+r.status)};
    else if(what==='test') UA.dg.msg={bad:false,text:'sent to '+(+d.sent||0)+' operator chat'+(d.sent===1?'':'s')+' · '+(+d.chars||0)+' chars'};
    else { UA.dg.data=d; UA.dg.msg={bad:false,text:'saved'}; if(what==='text') UA.dg.draft=null; }
  }catch(e){ UA.dg.msg={bad:true,text:String(e&&e.message||e)}; }
  UA.dg.busy=null;
  if(what==='test') await uaDgLoad(); else uaRender();
}
// (build 2026.09.25-122) the public-visitor toggle; the fold reloads (the payload's cache key carries it)
async function uaPubToggle(on){
  if(UA.pubBusy) return;
  UA.pubBusy=true; UA.pubErr=null; uaRender();
  try{
    const r=await fetch('/api/admin/usage/public',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({on:!!on})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok) UA.pubErr=d.error||('HTTP '+r.status);
  }catch(e){ UA.pubErr=String(e&&e.message||e); }
  UA.pubBusy=false;
  await uaLoad();
}
async function uaOpenMember(h){
  if(UA.sel===h){ UA.sel=null; UA.detail=null; uaRender(); return; }
  UA.sel=h; UA.detail={loading:true}; uaRender();
  try{
    const r=await fetch('/api/admin/usage/member?h='+encodeURIComponent(h),{headers:{accept:'application/json'}});
    const d=await r.json().catch(()=>({}));
    UA.detail=r.ok?Object.assign(d,{viewedAt:Date.now()}):{error:d.error||('HTTP '+r.status)};
  }catch(e){ UA.detail={error:String(e&&e.message||e)}; }
  if(UA.sel===h) uaRender();
}
// (build 2026.09.24-111) Resolve / reopen one distinct error. The server answers with the new state;
// the fold then reloads (the triage list rides the usage payload, whose cache key the toggle bumped).
async function uaTriage(sig,on){
  if(UA.triBusy) return;
  UA.triBusy=sig; UA.triErr=null; uaRender();
  try{
    const r=await fetch('/api/admin/usage/errors',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({sig,resolved:!!on})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok) UA.triErr=d.error||('HTTP '+r.status);
  }catch(e){ UA.triErr=String(e&&e.message||e); }
  UA.triBusy=null;
  await uaLoad();
}
// Opened by access.js whenever the Usage fold is open (lazyCall). Refetches at most once a minute —
// the server's own aggregates only move on its 60s flush.
function openUsageAdm(){
  uaWire();
  if(!UA.loading&&(!UA.data||Date.now()-UA.loadedAt>UA_STALE_MS)) uaLoad(); else uaRender();
}

// ---- formatting ---------------------------------------------------------------------------------
const uaPct=(x)=>x==null?'—':Math.round(x*100)+'%';
const uaMin=(x)=>x==null?'—':(x<10?x.toFixed(1):String(Math.round(x)));
const uaHours=(ms)=>{ const h=ms/3600000; return h<1?Math.round(ms/60000)+'m':(h<10?h.toFixed(1):String(Math.round(h)))+'h'; };
const uaDelta=(x)=>x==null?'<span class="na">—</span>':'<span class="'+(x>=0?'pos':'neg')+'">'+(x>=0?'+':'')+Math.round(x*100)+'%</span>';
function uaDev(k){ if(!k) return '—'; const pwa=/-pwa$/.test(k), c=k.replace(/-pwa$/,''); return pwa?'PWA · '+c:c; }
function uaSeen(m){
  if(m.online) return '<span class="pos">online now</span>';
  if(!m.lastSeen) return '<span class="na">never</span>';
  const h=(Date.now()-m.lastSeen)/3600000;
  return h<1?Math.max(1,Math.round(h*60))+'m ago':h<24?Math.round(h)+'h ago':Math.round(h/24)+'d ago';
}
function uaDay(d){ try{ return new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}); }catch(_){ return d; } }

// ---- (build 2026.09.24-110) stage B: heatmap, funnel, cohorts ---------------------------------------
const UA_ACT_LBL={call:'made a call',target:'set a target',alert:'created an alert',share:'shared a card',csv:'exported CSV',ask:'asked the AI',
  'ai-report':'ran an AI report','drawer-open':'opened a ticker drawer','telegram-link':'linked Telegram','push-enable':'turned on push'};
const UA_ACT_CHIP={call:'calls',target:'targets',alert:'alerts',share:'shares',csv:'CSV exports',ask:'asks','ai-report':'AI reports',
  'drawer-open':'drawer opens','telegram-link':'Telegram links','push-enable':'push turned on'};
const UA_DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], UA_DOW_ORDER=[1,2,3,4,5,6,0];   // rows Monday first; the key's 0 is Sunday
const uaHH=(h)=>String(h).padStart(2,'0');
// Minutes on screen by ET weekday × hour over the range. Numbers only reach the markup.
function uaHeatSvg(H){
  const grid=(H&&H.ms)||[], cw=12, ch=19, x0=30, y0=6;
  let mx=0; for(const r of grid) for(const v of (r||[])) if(v>mx) mx=v;
  let g='';
  UA_DOW_ORDER.forEach((d,row)=>{
    g+='<text class="us-axis" x="'+(x0-5)+'" y="'+(y0+row*ch+13)+'" text-anchor="end">'+UA_DOW[d]+'</text>';
    for(let h=0;h<24;h++){ const v=+((grid[d]||[])[h])||0, op=v>0&&mx>0?(0.12+v/mx*0.83):0.05;
      g+='<rect class="us-heatc" x="'+(x0+h*cw)+'" y="'+(y0+row*ch)+'" width="'+(cw-1.5)+'" height="'+(ch-2)+'" rx="2" fill-opacity="'+op.toFixed(2)+'"><title>'+UA_DOW[d]+' '+uaHH(h)+':00 ET · '+Math.round(v/60000)+' min</title></rect>'; }
  });
  for(const h of [0,6,12,18]) g+='<text class="us-axis" x="'+(x0+h*cw)+'" y="'+(y0+7*ch+10)+'">'+uaHH(h)+'</text>';
  return '<svg class="us-svg us-heat" viewBox="0 0 330 150" role="img" aria-label="screen time by weekday and hour, ET">'+g+'</svg>';
}
function uaHeatNote(H){
  if(!H||!H.total||!H.peak) return '<div class="us-flag">nothing on screen in this range yet</div>';
  const p=H.peak;
  return '<div class="us-flag">peak <b>'+UA_DOW[p.dow]+' '+uaHH(p.h)+':00–'+uaHH((p.h+1)%24)+':00 ET</b> · <b>'+uaPct(H.coreShare)+'</b> of screen time is 08:00–16:00 ET</div>';
}
// Adoption: of the members active in the range, how many did each at least once.
function uaFunnelHtml(D){
  const act=(D.kpi&&D.kpi.activeRange)||0;
  const mk=(D.tabs||[]).find(t=>t.key==='markets');
  const rows=(mk?[{lbl:'opened Markets',users:mk.users,hits:null}]:[]).concat((D.funnel||[]).map(f=>({lbl:UA_ACT_LBL[f.key]||f.key,users:+f.users||0,hits:+f.hits||0})));
  return rows.map(r=>{ const w=act?Math.min(100,r.users/act*100):0;
    return '<div class="us-fr"><span>'+esc(r.lbl)+'</span><span class="us-track"><span style="width:'+w.toFixed(1)+'%"></span></span>'
      +'<span class="v" title="'+(r.hits!=null?r.hits+' times in range, everyone counted':'members who opened it')+'">'+r.users+' · '+(act?Math.round(w)+'%':'—')+'</span></div>'; }).join('');
}
// Retention by join week: rows = the ET weeks members joined in, cells = share active N weeks later.
function uaCohortHtml(C){
  const rows=(C&&C.rows)||[], W=(C&&C.weeks)||9;
  let h='<thead><tr><th>joined (week of)</th><th class="n">n</th>';
  for(let w=0;w<W;w++) h+='<th class="n">w'+w+'</th>';
  h+='</tr></thead><tbody>';
  for(const r of rows){
    h+='<tr><td>'+esc(uaDay(r.mon))+'</td><td class="n">'+(+r.n||0)+'</td>';
    (r.cells||[]).forEach((v,i)=>{
      if(v==null){ h+='<td class="na">'+(r.n&&i<=r.cur?'·':'')+'</td>'; return; }
      const pct=Math.round(v*100);
      h+='<td class="n'+(i===r.cur?' cur':'')+'" style="background:rgba(70,185,126,'+(v*0.55).toFixed(2)+')"'+(i===r.cur?' title="week in progress"':'')+'>'+pct+'</td>'; });
    h+='</tr>';
  }
  return '<table class="us-cohort">'+h+'</tbody></table>';
}
// ---- (build 2026.09.24-110) stage C: client health ------------------------------------------------
const uaSec=(ms)=>ms==null?'—':(ms/1000).toFixed(ms<10000?1:0)+'s';
function uaHealthHtml(H){
  if(!H) return '';
  const P=H.perf||{}, cur=P.cur, prev=P.prev, E=H.errors||{};
  const kc=(h4,sub,v,s)=>'<div class="us-card"><h4>'+h4+'</h4><div class="sub">'+sub+'</div><div class="us-hv">'+v+'</div><div class="us-hs">'+s+'</div></div>';
  let perfS='no samples on this build yet';
  if(cur){ perfS=cur.n+' page load'+(cur.n===1?'':'s');
    if(prev&&prev.p50!=null&&cur.p50!=null){ const d=cur.p50-prev.p50;
      perfS+=' · <span class="'+(d<=0?'pos':'neg')+'">'+(d<=0?'−':'+')+uaSec(Math.abs(d))+'</span> vs build '+esc(prev.build)+' (p50)'; }
    else if(prev) perfS+=' · build '+esc(prev.build)+': '+uaSec(prev.p50)+' / '+uaSec(prev.p75); }
  else if(prev) perfS='build '+esc(prev.build)+': '+uaSec(prev.p50)+' / '+uaSec(prev.p75)+' ('+prev.n+')';
  const perf=kc('First paint → table','p50 / p75 across members, build '+esc(H.build||'?'),
    cur?uaSec(cur.p50)+' <span class="acc-mu">/ '+uaSec(cur.p75)+'</span>':'—', perfS);
  const top=(E.top||[])[0];
  const errs=kc('JS errors','window.onerror + unhandledrejection, deduped by message and file:line',
    (E.distinct||0)+' <span class="acc-mu">distinct · '+(E.hits||0)+' hits</span>',
    top?'top: <span class="neg">'+esc(top.loc)+' · '+esc(top.msg)+'</span> · '+(+top.members||0)+' member'+(top.members===1?'':'s'):'none in range');
  const stale=kc('Stale builds','members whose open tab runs an older build (last beacon inside the hour; kept across restarts)',
    H.stale==null?'—':String(H.stale), H.stale?'the new-version toast offers them the reload':'everyone online is on '+esc(H.build||'this build'));
  // (-111) with a triage list in the payload, it replaces the top-five table (it carries the same rows and more)
  const list=!H.triage&&(E.top||[]).length?'<div class="us-tw" style="margin-top:var(--sp-2)"><table class="us-tbl us-errs"><thead><tr><th>build</th><th>file:line</th><th>message</th><th class="n">hits</th><th class="n">members</th></tr></thead><tbody>'
    +(E.top||[]).map(e=>'<tr><td class="mono">'+esc(e.build)+'</td><td class="mono">'+esc(e.loc)+'</td><td class="us-emsg">'+esc(e.msg)+'</td><td class="n">'+(+e.hits||0)+'</td><td class="n">'+(+e.members||0)+'</td></tr>').join('')
    +'</tbody></table></div>':'';
  return '<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Client health</div><div class="us-health">'+uaRegressCard(H.regress,kc)+perf+errs+stale+'</div>'+list+uaTriageHtml(H.triage)
    +'<div class="acc-note">Error text is whatever the browser reported, with quoted text removed and cut to 200 characters; only builds this deployment served count, at most '+(+H.errCap||200)+' distinct errors are kept per build (500 overall, 20 new per member per day), and this card shows this build and the previous one. Members only here (“members” counts accounts, never a visitor); signed-out pages’ paint and errors are under who → public, and never feed the post-deploy alerts.</div>';
}

// ---- (build 2026.09.24-111) the post-deploy verdict, error triage, deploy & gate markers ---------------
const uaShort=(b)=>{ const m=/-(\d+)$/.exec(String(b||'')); return m?'-'+m[1]:String(b||'?'); };
function uaCondWord(c){
  if(!c) return '';
  if(c.kind==='new-errors') return (+c.n||0)+' new error'+(c.n===1?'':'s')+' hit by ≥2 members';
  if(c.kind==='err-rate') return 'errors per page load '+(+c.x||0).toFixed(1)+'×';
  if(c.kind==='perf') return 'p75 first paint +'+Math.round(((+c.p75||0)/(+c.p75Prev||1)-1)*100)+'% ('+uaSec(c.p75)+' vs '+uaSec(c.p75Prev)+')';
  return String(c.kind||'');
}
function uaRegressCard(V,kc){
  if(!V) return '';
  const sb=esc(uaShort(V.build)), vs=V.prev?' vs build '+esc(uaShort(V.prev)):'';
  let v, s;
  if(V.state==='regression'){ v='<span class="neg">regression</span>'; s='<span class="neg">regression: '+(V.conds||[]).map(c=>esc(uaCondWord(c))).join(' · ')+'</span>'+vs+' · alerted once per condition'; }
  else if(V.state==='ok'){ v='<span class="pos">build '+sb+': OK</span>'; s=(+V.loads||0)+' page loads'+vs+': no new errors, error rate and p75 within bounds'; }
  else if(V.state==='no-baseline'){ v='<span class="pos">build '+sb+': OK</span>'; s='no earlier build with ≥ 20 page loads to compare against'; }
  else if(V.state==='collecting'){ v='build '+sb+': collecting'; s=(+V.loads||0)+' / '+(+(V.need&&V.need.loads)||20)+' page loads — decides at that many, or '+Math.round(((V.need&&V.need.ageMs)||7200000)/3600000)+'h after the deploy'; }
  else { v='—'; s='this build is not in the known-builds list'; }
  return kc('Post-deploy check','this build against the previous known one: new errors (≥2 members), errors per page load (≥3×), p75 paint (≥30% and ≥0.3s)',v,s);
}
const uaWhen=(ms)=>{ if(!ms) return '—'; try{ return new Date(ms).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}); }catch(_){ return '—'; } };
function uaTriageHtml(T){
  if(!T) return '';
  const rows=T.rows||[];
  if(!rows.length) return '<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Error triage</div><div class="acc-note" style="margin:0">No errors on record.</div>';
  const st=(e)=>e.resolved?'<span class="acc-chip">resolved</span>':e.regressed?'<span class="acc-chip warn" title="resolved, then hit again on a newer build">regressed · '+esc(uaShort(e.regressedBuild))+'</span>':'<span class="acc-chip on">open</span>';
  return '<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Error triage · '+(+T.open||0)+' open of '+(+T.total||0)+'</div>'
    +(UA.triErr?'<div class="acc-note neg" style="margin:0 0 var(--sp-1)">could not update — '+esc(UA.triErr)+'</div>':'')
    +'<div class="us-tw"><table class="us-tbl us-errs us-tri"><thead><tr><th>state</th><th>file:line · message</th><th>builds</th><th>first seen</th><th>last seen</th><th class="n">hits</th><th class="n">members</th><th class="n" title="hits from signed-out pages (anonymous; never counted as members)">public</th><th></th></tr></thead><tbody>'
    +rows.map(e=>'<tr'+(e.resolved?' class="us-res"':'')+'><td>'+st(e)+'</td>'
      +'<td class="us-emsg">'+(e.pubOnly?'<span class="acc-chip">public-only</span> · <span class="mono">'+esc(e.loc)+'</span>':'<span class="mono">'+esc(e.loc)+'</span> · '+esc(e.msg))+'</td>'
      +'<td class="mono">'+esc(uaShort(e.firstBuild))+(e.lastBuild!==e.firstBuild?' → '+esc(uaShort(e.lastBuild)):'')+'</td>'
      +'<td class="mono">'+esc(uaWhen(e.firstAt))+'</td><td class="mono">'+esc(uaWhen(e.lastAt))+'</td>'
      +'<td class="n">'+(+e.hits||0)+'</td><td class="n">'+(+e.members||0)+'</td><td class="n">'+(+e.pubHits||0)+'</td>'
      +'<td><button type="button" class="btn" data-uatri="'+esc(e.sig)+'" data-on="'+(e.resolved?'0':'1')+'"'+(UA.triBusy?' disabled':'')+'>'+(UA.triBusy===e.sig?'…':e.resolved?'reopen':'resolve')+'</button></td></tr>').join('')
    +'</tbody></table></div>'
    +'<div class="acc-note">One row per distinct error (file + message, across builds and line moves). Members is a count, never who, and never includes a signed-out page (its hits are the “public” column, part of hits, counted only on days with 3+ visitors). “public-only” = only signed-out pages hit it: no message text is kept for it. Only a member’s hit reopens a resolved error. Resolving stamps the newest build (in deploy order) it was seen on; a hit from a build deployed after that one reopens it as “regressed”, while stale tabs on that or older builds do not.</div>';
}
function uaMarkWord(m){
  const d=String(m.detail||'');
  if(m.kind==='deploy') return 'deploy · build '+d;
  if(m.kind==='gate'){ const i=d.indexOf('='); return 'gate · '+(m.tabLabel||(i>=0?d.slice(0,i):d))+' → '+(i>=0?d.slice(i+1):'?'); }
  if(m.kind==='nav'){ if(d[0]==='#') return 'menu renamed · '+d.slice(1); const i=d.indexOf('>'); return 'menu · '+(m.tabLabel||(i>=0?d.slice(0,i):d))+' moved to '+(i>=0?d.slice(i+1):'?'); }
  if(m.kind==='alert'){ const i=d.lastIndexOf('|'); return 'regression alert · build '+(i>=0?uaShort(d.slice(0,i))+' · '+d.slice(i+1):d); }
  return m.kind+' · '+d;
}
function uaReachCell(w,pending){
  if(!w) return '<span class="na">'+(pending?'from tomorrow':'folded')+'</span>';
  const notes=[]; if(w.days<7) notes.push((w.days)+'d'); if(w.active<5) notes.push('small n');
  return uaPct(w.reach)+' <span class="acc-mu">'+(+w.users||0)+'/'+(+w.active||0)+'</span>'+(notes.length?' <span class="acc-chip warn">'+notes.join(' · ')+'</span>':'');
}
function uaMarksHtml(D){
  const M=D.marks; if(!M) return '';
  const head='<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Deploys &amp; gate changes</div>';
  if(!M.length) return head+'<div class="acc-note" style="margin:0">No deploys or gate changes in the last 90 days.</div>';
  return head+'<div class="us-tw"><table class="us-tbl us-marks"><thead><tr><th>when</th><th>change</th><th class="n">reach · 7d before</th><th class="n">after</th><th class="n">Δ</th></tr></thead><tbody>'
    +M.map(m=>{ const tab=!!m.tab, b=m.before, a=m.after;
      const dd=tab&&b&&a&&b.reach!=null&&a.reach!=null?Math.round((a.reach-b.reach)*100):null;
      return '<tr><td class="mono">'+esc(uaWhen(m.at))+'</td><td><i class="us-mkdot '+(m.kind==='deploy'?'us-mk-dep':m.kind==='alert'?'us-mk-alert':'us-mk-gate')+'"></i>'+esc(uaMarkWord(m))+'</td>'
        +(tab?'<td class="n">'+uaReachCell(b,false)+'</td><td class="n">'+uaReachCell(a,!a)+'</td><td class="n">'+(dd==null?'<span class="na">—</span>':'<span class="'+(dd>=0?'pos':'neg')+'">'+(dd>=0?'+':'')+dd+' pts</span>')+'</td>'
          :'<td class="n na" colspan="3">'+(m.kind==='deploy'?'see Client health':'')+'</td>')+'</tr>'; }).join('')
    +'</tbody></table></div>'
    +'<div class="acc-note">Reach = members who opened the tab ÷ members active (≥1 min on screen) in the window: the 7 ET days before the change day against the 7 after it, or the days since (“Nd”); the change day itself is in neither. “small n” = under 5 active members. Windows are clipped to the '+(D.keepDays||30)+'-day per-member retention. Markers are operator config history (no member data), kept 90 days.</div>';
}

// ---- (build 2026.09.24-112) sitewide: tab paths, the suggested nav order, controls, device split -------
const UA_DEV_LBL={desktop:'desktop',mobile:'mobile',tablet:'tablet',pwa:'PWA'};
function uaSelHtml(kind,opts,cur){
  return '<select class="us-sel" data-uasel="'+kind+'" aria-label="pick a tab">'+opts.map(o=>'<option value="'+esc(o.key)+'"'+(o.key===cur?' selected':'')+'>'+esc(o.label)+'</option>').join('')+'</select>';
}
function uaSplitRows(rows,lblOf){
  return rows.map(r=>{ const w=Math.max(0,Math.min(100,(+r.share||0)*100));
    return '<div class="us-fr"><span>'+esc(lblOf(r))+'</span><span class="us-track"><span style="width:'+w.toFixed(1)+'%"></span></span><span class="v">'+(+r.n||0)+' · '+Math.round(w)+'%</span></div>'; }).join('');
}
// (build 2026.09.25-122) the population a sitewide section counts, for its heading
const UA_POP={members:'members',public:'public visitors',both:'members + public'};
const uaPopTag=(pop)=>' · <span class="us-pop">'+esc(UA_POP[pop||'members']||pop)+'</span>';
function uaPathsHtml(S,pop){
  const P=S&&S.paths; if(!P) return '';
  const head='<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Tab paths · sitewide'+uaPopTag(pop)+'</div>';
  const top=(P.top||[]).length?'<div class="us-tw" style="border:0"><table class="us-tbl us-paths"><thead><tr><th>from</th><th>to</th><th class="n">times</th><th class="n">share</th></tr></thead><tbody>'
    +P.top.map(e=>'<tr><td>'+esc(e.fromLabel||e.from)+'</td><td>→ '+esc(e.toLabel||e.to)+'</td><td class="n">'+(+e.n||0)+'</td><td class="n">'+uaPct(e.share)+' <span class="us-bar b" style="width:'+Math.round((+e.share||0)*60)+'px"></span></td></tr>').join('')
    +'</tbody></table></div>':'<div class="acc-note" style="margin:0">No tab-to-tab moves in this range yet.</div>';
  const from=P.from||[];
  if(!UA.pathTab||!from.some(x=>x.key===UA.pathTab)) UA.pathTab=from.length?from[0].key:null;
  const sel=from.find(x=>x.key===UA.pathTab);
  const out=from.length?'<div class="us-row" style="margin:0 0 var(--sp-2)"><span class="acc-mu">where people go from</span> '+uaSelHtml('path',from,UA.pathTab)
    +(sel?' <span class="acc-mu">'+(+sel.n||0)+' moves</span>':'')+'</div>'+(sel?uaSplitRows(sel.to||[],r=>r.label||r.key):''):'<div class="acc-note" style="margin:0">—</div>';
  const E=P.entry||{};
  const entry=(E.rows||[]).length?uaSplitRows(E.rows,r=>r.label||r.key):'<div class="acc-note" style="margin:0">No page loads settled on a tab in this range yet.</div>';
  return head+'<div class="us-grid2"><div class="us-card"><h4>Top transitions</h4><div class="sub">tab → tab moves in range, top 15 of '+(+P.total||0)+' (a tab left inside 2s is a bounce and skipped; re-selecting the same tab is not a move)</div>'+top+'</div>'
    +'<div class="us-card"><h4>Where people go next</h4><div class="sub">the outbound split of one tab’s moves</div>'+out
    +'<h4 style="margin-top:var(--sp-3)">Entry tabs</h4><div class="sub">the first tab each page load settled on ('+(+E.total||0)+' loads)</div>'+entry+'</div></div>'
    +uaNavHtml(S.nav,pop);
}
// Read-only: the ribbon is changed in Features, never from here.
function uaNavHtml(N,pop){
  if(!N||!(N.current||[]).length) return '';
  const line=(xs)=>xs.map((x,i)=>'<span class="us-navk">'+(i+1)+'</span>'+esc(x.label||x.key)).join(' <span class="acc-mu">·</span> ');
  return '<div class="us-card us-nav" style="margin-top:var(--sp-3)"><h4>Suggested order'+(N.same?' <span class="acc-chip on">matches the current order</span>':'')+'</h4>'
    +'<div class="sub">'+(pop==='public'?'by public visitors’ mean daily reach × hours — ':pop==='both'?'by members’ reach × hours — ':'')+'movable tabs ranked by reach × hours in range (ties keep the current place) — a suggestion only; menus and moves live in Features</div>'
    +'<div class="us-navl"><b>suggested</b> '+line(N.suggested||[])+'</div><div class="us-navl"><b>current</b> '+line(N.current||[])+'</div></div>';
}
function uaCtlWord(x){ return esc(x.control)+(x.value!=null?' = <span class="mono">'+esc(x.value)+'</span>':''); }
function uaControlsHtml(S,pop){
  const C=S&&S.controls; if(!C) return '';
  const G=(C.groups||[]);
  const head='<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Controls · sitewide · '+(+C.total||0)+' uses'+uaPopTag(pop)+'</div>';
  if(C.error) return head+'<div class="acc-note neg" style="margin:0">control allowlist unavailable — '+esc(C.error)+'</div>';
  if(!UA.ctlTab||!G.some(g=>g.tab===UA.ctlTab)) UA.ctlTab=(G.find(g=>g.tab==='markets')||G[0]||{}).tab||null;
  const g=G.find(x=>x.tab===UA.ctlTab);
  let tbl='';
  if(g){
    const cols=(g.items||[]).filter(x=>x.control==='col-on'||x.control==='col-off');
    const rows=(g.items||[]).filter(x=>!(x.control==='col-on'||x.control==='col-off')||x.n>0);
    tbl='<div class="us-tw" style="border:0"><table class="us-tbl us-ctl"><thead><tr><th>control</th><th class="n">uses</th></tr></thead><tbody>'
      +rows.map(x=>'<tr'+(x.n===0?' class="us-never"':'')+'><td>'+uaCtlWord(x)+(x.n===0?' <span class="acc-chip warn">never used in range</span>':'')+'</td><td class="n">'+(+x.n||0)+'</td></tr>').join('')
      +'</tbody></table></div>'
      +(cols.length&&g.colsNever?'<div class="acc-note" style="margin:var(--sp-1) 0 0">'+(+g.colsNever.length||0)+' of '+new Set(cols.map(x=>x.value)).size+' columns never toggled either way in range'+(g.colsNever.length?': <span class="mono">'+g.colsNever.map(esc).join(' ')+'</span>':'')+'</div>':'')
      +(g.active?'':'<div class="acc-note" style="margin:var(--sp-1) 0 0">No screen time on this tab in range, so its controls are not called quiet.</div>');
  }
  const Q=C.quiet||[];
  const quiet=Q.length?'<div class="us-quiet">'+Q.map(q=>'<span class="acc-chip warn" title="'+esc(q.key)+'">'+esc(q.label)+' · '+uaCtlWord(q)+'</span>').join('')+'</div>'
    :'<div class="acc-note" style="margin:0">Every control on a tab people used was used at least once.</div>';
  return head+'<div class="us-grid2"><div class="us-card"><h4>Controls by use</h4><div class="sub">'+uaSelHtml('ctl',G.map(x=>({key:x.tab,label:x.label+' · '+(+x.n||0)})),UA.ctlTab)+' allowlisted controls, most used first</div>'+tbl+'</div>'
    +'<div class="us-card"><h4>Quiet controls · '+Q.length+'</h4><div class="sub">never used in range, on tabs that had screen time — candidates to simplify, like the quiet tabs</div>'+quiet+'</div></div>'
    +'<div class="acc-note">Counts only, from a fixed allowlist of '+(+C.allowlist||0)+' control keys (column ids, window and scope options, preset ids, CSV, share, drawer sections, “search used”). Never text, never a ticker, never a filter value. Stored without a member id.</div>';
}
function uaDevicesHtml(S,pop){
  const D=S&&S.devices; if(!D) return '';
  const cls=D.classes||['desktop','mobile','tablet','pwa'], rows=D.rows||[];
  const head='<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Device split per tab · sitewide'+uaPopTag(pop)+'</div>';
  if(!rows.length) return head+'<div class="acc-note" style="margin:0">No screen time in this range yet.</div>';
  const leg='<div class="us-mixleg">'+cls.map((c,i)=>'<span><i class="c'+i+'"></i>'+esc(UA_DEV_LBL[c]||c)+'</span>').join('')+'</div>';
  return head+'<div class="us-card">'+leg+rows.map(r=>{ const tot=+r.ms||0;
    return '<div class="us-devr"><span>'+esc(r.label||r.key)+'</span><span class="us-mix">'+cls.map((c,i)=>{ const v=+((r.dev||{})[c])||0; return v>0&&tot>0?'<span class="c'+i+'" style="width:'+(v/tot*100).toFixed(1)+'%" title="'+esc(UA_DEV_LBL[c]||c)+' '+Math.round(v/tot*100)+'%"></span>':''; }).join('')+'</span><span class="v">'+uaHours(tot)+'</span></div>'; }).join('')
    +'</div><div class="acc-note">Screen time on each tab by the device class it came from (desktop, mobile, tablet; PWA = installed, any size). Complete days only (today left out), shown once ≥ '+(+((S.threshold||{}).k)||3)+' '+(pop==='public'?'visitors':pop==='both'?'members + visitors':'members')+' contributed on one day; kept '+(+S.keepDays||30)+' days, without a member id.</div>';
}
// (build 2026.09.24-114) the k-threshold: paths, controls and the device split cover the range's
// complete days (never today), need a 7-day range, and show only when ≥ 3 members contributed.
// (build 2026.09.25-122) the same rule for public visitors (≥ 3 distinct visitors on a complete day —
// 'pv', the day's distinct count) and for members + public (members + visitors on one day)
function uaSiteWithheldHtml(S,pop){
  const K=S.threshold||{}, k=+K.k||3, days=+K.minDays||7;
  const who=pop==='public'?'visitors':pop==='both'?'members and visitors':'members';
  const why=S.withheld==='range'?'Pick a range of '+days+' days or more: the sitewide sections leave today out and never cover a single day.'
    :'not enough '+who+' to show without identifying someone (n<'+k+')';
  return '<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Tab paths · controls · device split · sitewide'+(pop&&pop!=='members'?uaPopTag(pop):'')+'</div>'
    +'<div class="acc-note us-withheld" style="margin:0">'+esc(why)+'</div>'
    +'<div class="acc-note">Sitewide counts are shown only for ranges of '+days+'+ complete days (today left out) in which at least '+k+' '+who+' contributed on one day — below that a “sitewide” count could be one person’s. Kept '+(+S.keepDays||30)+' days, without a member id.</div>'
    +uaNavHtml(S.nav,pop);
}
function uaSiteHtml(D,pop){
  const P=D&&D.pub;
  const S=pop==='public'?P&&P.site:pop==='both'?P&&P.both&&P.both.site:D&&D.site;
  if(!S) return ''; if(S.withheld) return uaSiteWithheldHtml(S,pop); return uaPathsHtml(S,pop)+uaControlsHtml(S,pop)+uaDevicesHtml(S,pop); }

// ---- (build 2026.09.25-122) the population views: members | public | both ---------------------------
// Public numbers come from uid '-1' totals only. A visitor's key rotates at ET midnight, so over a range
// there are visitor-DAYS, never "distinct visitors" — the labels say so. "both" adds the two populations
// where the unit is the same (people online, people active today) and shows them side by side where not.
const UA_WHO=['members','public','both'];
function uaHeatSum(a,b){
  const cell=(H,d,h)=>+((((H&&H.ms)||[])[d]||[])[h])||0;
  const ms=Array.from({length:7},(_,d)=>Array.from({length:24},(_,h)=>cell(a,d,h)+cell(b,d,h)));
  let total=0,core=0,peak=null;
  for(let d=0;d<7;d++) for(let h=0;h<24;h++){ const v=ms[d][h]; total+=v; if(h>=8&&h<16) core+=v; if(v>0&&(!peak||v>peak.ms)) peak={dow:d,h,ms:v}; }
  return {ms,total,peak,coreShare:total?core/total:null};
}
// (build 2026.09.25-122) k ≥ 3: a public day figure (or online-now) of 1–2 arrives as the string "<3"
const uaKn=(v)=>typeof v==='string'?esc(v):String(+v||0);
const uaKadd=(a,b)=>typeof b==='string'?((+a||0)?(+a||0)+' + '+esc(b):esc(b)):String((+a||0)+(+b||0));
const UA_PUB_K_NOTE='days with fewer than 3 visitors are hidden';
function uaPubChip(D){
  const P=D.pub, L=P&&P.live;
  if(!D.publicOn||!L) return '<span class="acc-chip">public off'+(L&&L.forcedOff?' · USAGE_PUBLIC=0':'')+'</span>';
  const K=P.kpi||{}, dr=(P.drops&&P.drops.today)||{}, nd=(+dr.rate||0)+(+dr.visitors||0);
  return '<span class="acc-chip on" title="signed-out visitors, counted without cookies or ids: distinct visitors today (ET) and beacons the server-wide caps dropped today">public on · '+uaKn(K.visitorsToday)+' visitor'+(K.visitorsToday===1?'':'s')+' today · '+nd+' dropped</span>';
}
function uaPubCtlHtml(D){
  const L=(D.pub&&D.pub.live)||{}, forced=!!L.forcedOff, tog=L.toggle!==false;
  return '<div class="us-pubctl"><label><input type="checkbox" data-uapub="1"'+(tog?' checked':'')+(UA.pubBusy||forced?' disabled':'')+'> count signed-out visitors (anonymous totals)</label>'
    +(forced?'<span class="acc-chip warn">USAGE_PUBLIC=0 forces this off</span>':'')
    +(UA.pubErr?'<span class="neg">could not update — '+esc(UA.pubErr)+'</span>':'')
    +'<span class="acc-mu">no cookies or ids; a daily-salted key held in memory only, so a visit is not linked across days; '+UA_PUB_K_NOTE+' · caps '+(+((L.caps||{}).visitors)||20000)+' visitors/day, '+(+((L.caps||{}).perMin)||600)+' beacons/min</span></div>';
}
function uaKpisHtml(D,who){
  const K=D.kpi||{}, P=D.pub||{}, PK=P.kpi||{};
  const kp=(k,v,s)=>'<div class="us-kpi"><div class="k">'+k+'</div><div class="v">'+v+'</div><div class="s">'+s+'</div></div>';
  if(who==='public'){ const dr=(P.drops&&P.drops.today)||{};
    return '<div class="us-kpis">'
      +kp('<span class="us-live"></span>online now',PK.online==null?'—':uaKn(PK.online),'public · open signed-out tabs (not people)')
      +kp('visitors today',uaKn(PK.visitorsToday),'public · distinct visitors, ET day')
      +kp('active today',uaKn(PK.activeToday),'public · visitors ≥60s on screen')
      +kp('visitor-days · '+D.r+'d',String(+PK.visitorDays||0),'public · daily visitors summed (never linked across days)')
      +kp('mean / day',PK.meanDaily==null?'—':uaMin(PK.meanDaily),'public · visitors per day in range')
      +kp('median / day',PK.medMinPerDay==null?'—':'≈'+uaMin(PK.medMinPerDay)+' min','public · per active visitor-day (bucketed)')
      +kp('dropped today',String((+dr.rate||0)+(+dr.visitors||0)),'public · beacons over the server-wide caps')+'</div>'+uaPubKNote(PK);
  }
  if(who==='both'){ const B=P.both||{};
    return '<div class="us-kpis">'
      +kp('<span class="us-live"></span>online now',uaKadd(K.online,PK.online),(+K.online||0)+' members + '+uaKn(PK.online)+' signed-out tabs')
      +kp('active today',uaKadd(K.activeToday,PK.activeToday),(+K.activeToday||0)+' members + '+uaKn(PK.activeToday)+' public visitors (≥60s)')
      +kp('active · '+D.r+'d',(+K.activeRange||0)+' + '+(+PK.activeVisitorDays||0),'distinct members + active public visitor-days')
      +kp('median / day',B.medMinPerDay==null?'—':'≈'+uaMin(B.medMinPerDay)+' min','members + public · per active member- or visitor-day (bucketed)')
      +kp('visitors today',uaKn(PK.visitorsToday),'public · distinct, ET day')+'</div>'+uaPubKNote(PK);
  }
  return '<div class="us-kpis">'
    +kp('<span class="us-live"></span>online now',String(K.online||0),'members with an open tab')
    +kp('active today',String(K.activeToday||0),'members ≥60s on screen (ET day)')
    +kp('active · '+D.r+'d',String(K.activeRange||0),'of '+(K.members||0)+' members')
    +kp('stickiness',uaPct(K.stickiness),'members · mean daily ÷ '+D.r+'d active')
    +kp('median / day',K.medMinPerDay==null?'—':uaMin(K.medMinPerDay)+' min','per active member-day')
    +kp('new members',String(K.newMembers||0),'in range · '+(K.newActive||0)+' active')+'</div>';
}
// (build 2026.09.25-122) the k ≥ 3 rule, said under the public / both KPIs
function uaPubKNote(PK){
  const n=+PK.hiddenDays||0;
  return '<div class="acc-note" style="margin:var(--sp-1) 0 0">Public: '+UA_PUB_K_NOTE+' (“&lt;3”, and left out of every public figure and range total, online-now included)'
    +(n?' — '+n+' day'+(n===1?'':'s')+' in this range':'')+'.</div>';
}
// The tab table for public / both. Public reach = the MEAN DAILY reach (visitors who opened the tab that
// day ÷ that day's visitors, averaged over the range's days with visitors).
function uaPubTabsHtml(D,who){
  const pt=new Map(((D.pub&&D.pub.tabs)||[]).map(t=>[t.key,t])), mt=new Map((D.tabs||[]).map(t=>[t.key,t]));
  const pk=!(D.pub&&D.pub.priorKept===false);   // (build 2026.09.25-122) the public prior window is still kept
  const keys=[...new Set([...(D.tabs||[]).map(t=>t.key),...pt.keys()])];
  const rows=keys.map(k=>{ const m=mt.get(k)||{}, p=pt.get(k)||{};
    const ms=who==='both'?(+m.ms||0)+(+p.ms||0):(+p.ms||0), prev=who==='both'?(+m.prevMs||0)+(+p.prevMs||0):(+p.prevMs||0);
    return {key:k,label:m.label||p.label||k,gate:m.gate||p.gate||'',reach:who==='both'?m.reach:p.reach,preach:p.reach,ms,delta:pk&&prev>0?(ms-prev)/prev:null}; })
    .filter(t=>t.ms>0||t.gate!=='off');
  const tval=(t,k)=>k==='label'?String(t.label).toLowerCase():k==='gate'?t.gate:t[k];
  const tRows=uaSorted(rows,UA.tsort,tval), maxMs=Math.max(1,...rows.map(t=>t.ms));
  const th=(k,l,n)=>uaTh(k,l,UA.tsort,n,'data-uat');
  return '<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Tabs · reach and time'+uaPopTag(who)+'</div>'
    +'<div class="us-tw"><table class="us-tbl" id="uaTabs"><thead><tr>'+th('label','tab',false)
    +(who==='both'?th('reach','members used',true)+th('preach','public · mean daily reach',true):th('preach','public · mean daily reach',true))
    +th('ms',who==='both'?'hours · members + public':'hours · public',true)+th('delta','vs prior',true)+th('gate','gate',false)+'</tr></thead><tbody>'
    +tRows.map(t=>'<tr><td>'+esc(t.label)+'</td>'
      +(who==='both'?'<td class="n">'+uaPct(t.reach)+'</td>':'')
      +'<td class="n">'+uaPct(t.preach)+' <span class="us-bar b" style="width:'+Math.round((t.preach||0)*50)+'px"></span></td>'
      +'<td class="n">'+uaHours(t.ms)+' <span class="us-bar" style="width:'+Math.round(t.ms/maxMs*60)+'px"></span></td>'
      +'<td class="n">'+uaDelta(t.delta)+'</td><td><span class="acc-chip'+(t.gate==='admin'?' on':t.gate==='off'?' warn':'')+'">'+esc(t.gate)+'</span></td></tr>').join('')
    +'</tbody></table></div>'
    +'<div class="acc-note">Public reach is the mean daily reach: on each day with visitors, the share of that day’s distinct visitors who opened the tab, averaged over those days — a visitor is never linked across days, so a range-wide share of “people” does not exist for them.'
    +(who==='both'?' “members used” is the members’ own reach (members active in range who opened it); hours add both populations.':' Only tabs open to signed-out visitors can get public time.')
    +(pk?'':' “vs prior” is blank: the prior window beyond retention (public rows are kept '+(+((D.pub||{}).keepDays)||30)+' days).')
    +' Days with fewer than 3 visitors are hidden.</div>';
}
function uaPubHealthHtml(D,who){
  const P=D.pub||{}, H=who==='both'?(P.both||{}).health:P.health;
  if(!H) return '';
  const pp=(H.perf||{}), cur=pp.cur, prev=pp.prev, E=H.errors||{};
  const kc=(h4,sub,v,s2)=>'<div class="us-card"><h4>'+h4+'</h4><div class="sub">'+sub+'</div><div class="us-hv">'+v+'</div><div class="us-hs">'+s2+'</div></div>';
  const lbl=who==='both'?'members + public':'public';
  const perf=kc('First paint → table','p50 / p75 · '+lbl+' · build '+esc(H.build||'?'),cur?uaSec(cur.p50)+' <span class="acc-mu">/ '+uaSec(cur.p75)+'</span>':'—',
    cur?cur.n+' page load'+(cur.n===1?'':'s')+(prev?' · build '+esc(prev.build)+': '+uaSec(prev.p50)+' / '+uaSec(prev.p75):''):'no samples on this build yet');
  const top=(E.top||[])[0];
  const errs=kc('JS errors',lbl+' · this build and the previous one',(+E.distinct||0)+' <span class="acc-mu">distinct · '+(+E.hits||0)+' hits</span>',
    top?'top: <span class="neg">'+esc(top.loc)+' · '+(top.msg==null?'public-only':esc(top.msg))+'</span>'+(who==='both'&&top.members!=null?' · '+(+top.members||0)+' member'+(top.members===1?'':'s')+' (visitors never counted as members)':''):'none in range');
  const list=(E.top||[]).length?'<div class="us-tw" style="margin-top:var(--sp-2)"><table class="us-tbl us-errs"><thead><tr><th>build</th><th>file:line</th><th>message</th><th class="n">hits · '+esc(lbl)+'</th>'+(who==='both'?'<th class="n">members</th>':'')+'</tr></thead><tbody>'
    +(E.top||[]).map(e=>'<tr><td class="mono">'+esc(e.build)+'</td><td class="mono">'+esc(e.loc)+'</td><td class="us-emsg">'+(e.msg==null?'<span class="acc-mu">public-only · text not kept</span>':esc(e.msg))+'</td><td class="n">'+(+e.hits||0)+'</td>'+(who==='both'?'<td class="n">'+(+e.members||0)+'</td>':'')+'</tr>').join('')
    +'</tbody></table></div>':'';
  return '<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Client health'+uaPopTag(who)+'</div><div class="us-health">'+perf+errs+'</div>'+list
    +'<div class="acc-note">Signed-out pages report first paint and errors under the same rules (known builds only, quoted text removed, 200 characters); an error only signed-out pages hit keeps its file:line but no message text (the text appears once a member hits it); all visitors together may add at most 10 new distinct errors a day, public numbers never trigger the post-deploy alerts nor reopen a resolved error, and days with fewer than 3 visitors are hidden. The verdict, stale builds and error triage are under who → members (triage also shows public hits per error).</div>';
}

// ---- the daily-active chart: bars per ET day + the trailing 7-day mean ---------------------------
// (build 2026.09.25-122) `pub` (the public series, aligned by day) stacks public visitors on top of the
// members' bar ("both"); `only`==='public' draws the public series alone. The mean line follows the total.
function uaDauSvg(series,marks,pub,only){
  const W=640,H=150,P={l:26,r:6,t:8,b:20}, n=series.length||1;
  const pAt=new Map((pub||[]).map(x=>[x.day,+x.n||0]));
  const tot=(x)=>(only==='public'?0:x.n)+(pub?pAt.get(x.day)||0:0);
  const max=Math.max(1,...series.map(tot))*1.15, bw=(W-P.l-P.r)/n, y=v=>H-P.b-(v/max)*(H-P.t-P.b);
  let g='';
  for(const t of [0,.5,1]){ const v=Math.round(max*t); g+='<line class="us-grid" x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text class="us-axis" x="'+(P.l-4)+'" y="'+(y(v)+3)+'" text-anchor="end">'+v+'</text>'; }
  series.forEach((x,i)=>{ const X=P.l+i*bw+bw*.12, w=bw*.76, m=only==='public'?0:x.n, p=pub?pAt.get(x.day)||0:0;
    if(only!=='public') g+='<rect class="us-barf" x="'+X.toFixed(1)+'" y="'+y(m).toFixed(1)+'" width="'+w.toFixed(1)+'" height="'+(H-P.b-y(m)).toFixed(1)+'" rx="1.5"><title>'+esc(x.day)+': '+m+' active member'+(m===1?'':'s')+'</title></rect>';
    if(pub&&p>0) g+='<rect class="us-barp" x="'+X.toFixed(1)+'" y="'+y(m+p).toFixed(1)+'" width="'+w.toFixed(1)+'" height="'+(y(m)-y(m+p)).toFixed(1)+'" rx="1.5"><title>'+esc(x.day)+': '+p+' active public visitor'+(p===1?'':'s')+'</title></rect>'; });
  const pts=series.map((x,i)=>{ const a=series.slice(Math.max(0,i-6),i+1); const m=a.reduce((p,q)=>p+tot(q),0)/a.length; return (P.l+i*bw+bw/2).toFixed(1)+','+y(m).toFixed(1); });
  if(pts.length>1) g+='<polyline class="us-mean" points="'+pts.join(' ')+'"/>';
  // (-111) deploy & gate markers: a vertical line at the start of the ET day each one happened on
  const col=new Map(series.map((x,i)=>[x.day,i]));
  for(const m of (marks||[])){ const i=col.get(m.day); if(i==null) continue;
    const X=(P.l+i*bw+0.5).toFixed(1), cls=m.kind==='deploy'?'us-mk-dep':m.kind==='alert'?'us-mk-alert':'us-mk-gate';
    g+='<line class="us-mk '+cls+'" x1="'+X+'" x2="'+X+'" y1="'+P.t+'" y2="'+(H-P.b)+'"><title>'+esc(uaMarkWord(m))+'</title></line>'; }
  const step=n<=7?1:7;
  for(let i=n-1;i>=0;i-=step) g+='<text class="us-axis" x="'+(P.l+i*bw+bw/2).toFixed(1)+'" y="'+(H-5)+'" text-anchor="middle">'+esc(uaDay(series[i].day))+'</text>';
  return '<svg class="us-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="'+(only==='public'?'active public visitors per day':pub?'active members and public visitors per day':'active members per day')+'">'+g+'</svg>';
}

function uaSorted(rows,s,valOf){
  return [...rows].sort((a,b)=>{ const A=valOf(a,s.k),B=valOf(b,s.k); if(A==null&&B==null) return 0; if(A==null) return 1; if(B==null) return -1; return (A>B?1:A<B?-1:0)*s.d; });
}
function uaTh(k,lbl,s,num,attr){ return '<th'+(num?' class="n'+(s.k===k?' sorted':'')+'"':(s.k===k?' class="sorted"':''))+' '+attr+'="'+k+'">'+lbl+'</th>'; }

function uaDetailHtml(){
  const d=UA.detail; if(!UA.sel||!d) return '';
  const hd='<div class="hd"><span class="t">'+esc(d.display||UA.sel)+'</span>';
  if(d.loading) return '<div class="us-drawer">'+hd+'</div><div class="acc-note">loading…</div></div>';
  if(d.error) return '<div class="us-drawer">'+hd+'</div><div class="acc-note">'+esc(d.error)+'</div></div>';
  const stamp=new Date(d.viewedAt||Date.now()).toISOString().slice(0,16).replace('T',' ');
  const meta='<span class="acc-mu">'+(d.createdAt?'joined '+esc(new Date(d.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})):'')
    +(d.invitedBy?' · invited by '+esc(d.invitedBy):'')+(d.devices&&d.devices[0]?' · '+esc(uaDev(d.devices[0].key)):'')+'</span>';
  const audit='<div class="us-audit">⚑ logged: “view-usage '+esc(d.handle||UA.sel)+'” at '+stamp+' UTC — shows in All messages → Read log</div>';
  const close='<span class="right"><button type="button" class="btn" data-uaclose="1">close</button></span></div>';
  if(d.paused) return '<div class="us-drawer">'+hd+'<span class="acc-chip">paused</span>'+meta+close+audit
    +'<div class="acc-note" style="margin:0">'+esc(d.display||UA.sel)+' paused usage sharing. Nothing is recorded for this account while it stays paused.</div></div>';
  const mins=d.minutes||[], mx=Math.max(1,...mins);
  const spark=mins.map((v,i)=>'<rect class="'+(v>0?'us-barf':'us-bar0')+'" x="'+(i*10)+'" y="'+(40-v/mx*40).toFixed(1)+'" width="8" height="'+Math.max(1,v/mx*40).toFixed(1)+'" rx="1"><title>'+esc(uaDay(d.days[i]))+': '+v+' min</title></rect>').join('');
  const mix=(d.tabs||[]).slice(0,5), rest=(d.tabs||[]).slice(5).reduce((s,t)=>s+t.share,0);
  if(rest>0) mix.push({label:'other',share:rest});
  return '<div class="us-drawer">'+hd+meta+close+audit
    +'<div class="us-grid2"><div><div class="dm-sh" style="padding-left:0">minutes per day · '+(d.keepDays||30)+'d · '+(d.activeDays||0)+' active</div>'
      +'<svg class="us-svg" viewBox="0 0 '+(mins.length*10)+' 40" preserveAspectRatio="none" style="height:60px">'+spark+'</svg></div>'
    +'<div><div class="dm-sh" style="padding-left:0">tab mix · '+esc(uaHours(d.ms||0))+'</div>'
      +(mix.length?'<div class="us-mix">'+mix.map((x,i)=>'<span class="c'+i+'" style="width:'+(x.share*100).toFixed(1)+'%"></span>').join('')+'</div>'
        +'<div class="us-mixleg">'+mix.map((x,i)=>'<span><i class="c'+i+'"></i>'+esc(x.label)+' '+Math.round(x.share*100)+'%</span>').join('')+'</div>'
        :'<div class="acc-note" style="margin:0">nothing recorded in the window</div>')
    +'</div></div>'
    // (build 2026.09.24-110) the features row: this member's action counts over the window
    +'<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-2)">features · '+(d.keepDays||30)+'d</div>'
    +'<div class="us-acts">'+(d.acts||[]).map(a=>'<span class="acc-chip'+(a.n>0?' on':'')+'">'+esc(UA_ACT_CHIP[a.key]||a.key)+' '+(+a.n||0)+'</span>').join('')+'</div>'
    +'</div>';
}

const UA_DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const uaAgo=(ms)=>{ if(!ms) return 'never'; const h=(Date.now()-ms)/3600000; return h<1?Math.max(1,Math.round(h*60))+'m ago':h<48?Math.round(h)+'h ago':Math.round(h/24)+'d ago'; };
function uaDigestHtml(){
  const G=UA.dg, d=G.data;
  const head='<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Digest &amp; nudges</div>';
  if(!d) return head+'<div class="acc-note" style="margin:0">'+(G.err?'could not load — '+esc(G.err):'loading…')+'</div>';
  const S=d.schedule||{}, P=d.preview||{}, busy=!!G.busy;
  const chan=!d.pushOn?'<span class="neg">Telegram is not configured — nothing can be sent</span>'
    :(+d.operators||0)?(+d.operators)+' operator chat'+(d.operators===1?'':'s')+' (the Telegram roster’s operator designation)':'<span class="neg">no operator chat designated — mark one on the Telegram roster</span>';
  const dig='<div class="us-card"><h4>Weekly usage digest</h4><div class="sub">to the operator, once per ISO week, after the morning brief’s default hour ('+String(+S.briefHourUtc||0).padStart(2,'0')+':00 UTC) on the chosen ET weekday</div>'
    +'<div class="us-row" style="flex-wrap:wrap;gap:var(--sp-2)"><label><input type="checkbox" data-uadg="digestOn"'+(d.digestOn?' checked':'')+(busy?' disabled':'')+'> send the weekly digest</label>'
    +'<label>on <select data-uadg="digestDay"'+(busy?' disabled':'')+'>'+UA_DAYS.map((n,i)=>'<option value="'+i+'"'+(i===d.digestDay?' selected':'')+'>'+n+'</option>').join('')+'</select></label>'
    +'<button type="button" class="btn" data-uadgtest="1"'+(busy||!d.pushOn||!d.operators?' disabled':'')+'>'+(G.busy==='test'?'…':'send test now')+'</button></div>'
    +'<div class="acc-note" style="margin:var(--sp-1) 0 0">last sent: <b>'+esc(d.lastAt?uaWhen(d.lastAt)+' ('+uaAgo(d.lastAt)+') · '+(d.lastWeek||''):'never')+'</b>'
    +' · this week ('+esc(S.week||'')+'): '+(!d.digestOn?'off':S.sentThisWeek?'sent':S.due?'due now':'due '+esc(uaDay(S.day||'')))+' · to '+chan+'</div>'
    +'<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-2)">Preview · '+esc(P.week||'')+' · '+(+P.chars||0)+' of '+(+P.limit||4096)+' chars</div>'
    +'<pre class="us-dgpre" style="white-space:pre-wrap;margin:0;max-height:22em;overflow:auto">'+esc(P.text||'')+'</pre>'
    +'<div class="acc-note">Names are members’ display names; paused members are only counted, never named. The test goes to the same operator chats now and does not count as this week’s send.</div></div>';
  const R=d.rules||{}, text=G.draft!=null?G.draft:(d.nudgeText||'');
  const log=(d.nudgeLog||[]);
  const nud='<div class="us-card"><h4>Lapsed-member reminder</h4><div class="sub">optional, off by default: one friendly reminder to a member active in the prior '+(+R.recentDays||14)+' days who then goes '+(+R.quietDays||7)+' days without activity — at most once per '+(+R.everyDays||30)+' days, never to paused, disabled or operator accounts, only over the channel they already have (their linked Telegram, else browser push; none → skipped). Sent 10:00–18:00 ET.</div>'
    +'<div class="us-row" style="flex-wrap:wrap;gap:var(--sp-2)"><label><input type="checkbox" data-uadg="nudgeOn"'+(d.nudgeOn?' checked':'')+(busy?' disabled':'')+'> send reminders</label>'
    +(d.nudgeOn&&d.nudgeSince?'<span class="acc-chip on">on since '+esc(uaWhen(d.nudgeSince))+'</span>':'<span class="acc-chip">off</span>')+'</div>'
    +'<label class="acc-note" style="display:block;margin:var(--sp-1) 0 0">reminder text (then 2–3 market lines — benchmarks and the day’s top movers; nothing personal)</label>'
    +'<textarea data-uadgtext="1" rows="2" maxlength="'+(+d.nudgeMax||300)+'" style="width:100%;box-sizing:border-box"'+(busy?' disabled':'')+'>'+esc(text)+'</textarea>'
    +'<div class="us-row" style="gap:var(--sp-2)"><button type="button" class="btn" data-uadgsave="1"'+(busy?' disabled':'')+'>'+(G.busy==='text'?'…':'save text')+'</button>'
    +'<button type="button" class="btn" data-uadgreset="1"'+(busy?' disabled':'')+'>default</button></div>'
    +'<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-2)">Reminders sent · '+log.length+'</div>'
    +(log.length?'<div class="us-tw"><table class="us-tbl us-nudges"><thead><tr><th>when</th><th>member · channel</th><th>switched on by</th></tr></thead><tbody>'
      +log.map(x=>'<tr><td class="mono">'+esc(uaWhen(x.at))+'</td><td>'+esc(x.detail)+'</td><td class="acc-mu">'+esc(x.by)+'</td></tr>').join('')+'</tbody></table></div>'
      :'<div class="acc-note" style="margin:0">none yet</div>')
    +'<div class="acc-note">Every reminder is written to the audit log as “usage-nudge” (All messages → Read log). Members are told in their Your usage card that the operator may turn this on, and that pausing usage opts them out.</div></div>';
  return head+(G.msg?'<div class="acc-note '+(G.msg.bad?'neg':'pos')+'" style="margin:0 0 var(--sp-1)">'+esc(G.msg.text)+'</div>':'')+'<div class="us-grid2">'+dig+nud+'</div>';
}

function uaRender(){
  const box=el('admUsageBox'); if(!box) return;
  const sub=el('admUsageSub');
  const D=UA.data;
  if(!D){ box.innerHTML='<div class="acc-note" style="margin:0">'+(UA.err?'could not load — '+esc(UA.err):'loading…')+'</div>'; return; }
  const K=D.kpi||{};
  if(sub) sub.textContent=K.activeToday+' active today · '+K.activeRange+' in '+D.r+'d · stickiness '+uaPct(K.stickiness);
  const seg='<div class="seg" id="uaRange"><span class="seglbl">range</span>'
    +[7,30].map(r=>'<button type="button" data-uar="'+r+'"'+(D.r===r?' class="active"':'')+'>'+r+'d</button>').join('')+'</div>';
  // (build 2026.09.25-122) who: members | public | both (a view choice only; one payload carries all three)
  const who=D.pub&&UA_WHO.includes(UA.who)?UA.who:'members', P=D.pub||{};
  const wseg=D.pub?'<div class="seg" id="uaWho"><span class="seglbl">who</span>'
    +UA_WHO.map(w=>'<button type="button" data-uawho="'+w+'"'+(who===w?' class="active"':'')+'>'+w+'</button>').join('')+'</div>':'';
  const chips='<span class="right"><span class="acc-chip on">beacon on</span><span class="acc-chip">retention '+(D.keepDays||30)+'d</span>'
    +uaPubChip(D)
    +'<button type="button" class="btn" data-uarefresh="1"'+(UA.loading?' disabled':'')+'>'+(UA.loading?'…':'refresh')+'</button></span>';
  const kpis=uaKpisHtml(D,who);
  const pubS=P.series||[], mOnly=who!=='members'?' <span class="acc-chip">members only</span>':'';
  const dauSub=who==='public'?'public visitors with ≥1 minute on screen that ET day (distinct per day; bars) — all visitors incl. under a minute: '+pubS.reduce((a,x)=>a+(+x.v||0),0)+' visitor-days'
    :who==='both'?'members (amber) + public visitors (blue) with ≥1 minute on screen that ET day, stacked; the mean follows the total':'distinct members with ≥1 minute on screen that ET day';
  const heatD=who==='public'?P.heat:who==='both'?uaHeatSum(D.heat,P.heat):D.heat;
  const dau='<div class="us-grid2"><div class="us-card"><h4>Active people per day'+uaPopTag(who)+'</h4><div class="sub">'+dauSub+'</div>'
    +uaDauSvg(D.series||[],who==='members'?(D.marks||[]):[],who==='members'?null:pubS,who==='public'?'public':null)
    +'<div class="us-legend">'+(who!=='public'?'<span><i class="c0"></i>members</span>':'')+(who!=='members'?'<span><i style="background:var(--blue)"></i>public visitors</span>':'')+'<span><i class="us-legmean"></i>7-day mean</span>'
    +(who==='members'&&(D.marks||[]).length?'<span><i class="us-mkdot us-mk-dep"></i>deploy</span><span><i class="us-mkdot us-mk-gate"></i>gate / menu</span><span><i class="us-mkdot us-mk-alert"></i>regression alert</span>':'')+'</div></div>'
    // (build 2026.09.24-110) when people are here
    +'<div class="us-card"><h4>When people are here'+uaPopTag(who)+'</h4><div class="sub">minutes on screen by weekday × hour (ET), whole range</div>'
    +uaHeatSvg(heatD)+uaHeatNote(heatD)+'</div></div>';
  const C=D.cohorts||{};
  const adopt='<div class="us-grid2" style="margin-top:var(--sp-3)"><div class="us-card"><h4>Feature adoption'+mOnly+'</h4><div class="sub">members who did it at least once in range (of '+(K.activeRange||0)+' active)</div>'
    +uaFunnelHtml(D)+'</div>'
    +'<div class="us-card"><h4>Retention by join week'+mOnly+'</h4><div class="sub">% of each ET week’s new members active (a minute on screen on any day) in week N after joining; w0 is the join week</div>'
    +'<div class="us-tw" style="border:0">'+uaCohortHtml(C)+'</div>'
    +'<div class="us-flag">Per-member daily rows fold away after '+(D.keepDays||30)+' days; these cells read a separate yes/no-per-week bit kept '+Math.round((C.keepDays||56)/7)+' weeks (plus the week in progress)'
    +(C.since?', on record since the week of '+esc(uaDay(C.since)):'')+'. “·” = not measured (before the beacon, or a week still to come).</div></div></div>';
  const tval=(t,k)=>k==='label'?t.label.toLowerCase():k==='gate'?t.gate:t[k];
  const tRows=uaSorted(D.tabs||[],UA.tsort,tval), maxMs=Math.max(1,...(D.tabs||[]).map(t=>t.ms));
  const tabs=who!=='members'?uaPubTabsHtml(D,who):'<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Tabs · reach and time</div>'
    +'<div class="us-tw"><table class="us-tbl" id="uaTabs"><thead><tr>'
    +uaTh('label','tab',UA.tsort,false,'data-uat')+uaTh('reach','members used',UA.tsort,true,'data-uat')+uaTh('ms','hours',UA.tsort,true,'data-uat')
    +uaTh('medMin','median min / user',UA.tsort,true,'data-uat')+uaTh('delta','vs prior',UA.tsort,true,'data-uat')+uaTh('gate','gate',UA.tsort,false,'data-uat')
    +'</tr></thead><tbody>'
    +tRows.map(t=>{ const quiet=t.reach!=null&&t.reach<0.1&&(K.activeRange||0)>0;
      return '<tr><td>'+esc(t.label)+(quiet?' <span class="acc-chip on">quiet</span>':'')+'</td>'
        +'<td class="n">'+uaPct(t.reach)+' <span class="us-bar b" style="width:'+Math.round((t.reach||0)*50)+'px"></span></td>'
        +'<td class="n">'+uaHours(t.ms)+' <span class="us-bar" style="width:'+Math.round(t.ms/maxMs*60)+'px"></span></td>'
        +'<td class="n">'+uaMin(t.medMin)+'</td><td class="n">'+uaDelta(t.delta)+'</td>'
        +'<td><span class="acc-chip'+(t.gate==='admin'?' on':t.gate==='off'?' warn':'')+'">'+esc(t.gate)+'</span></td></tr>'; }).join('')
    +'</tbody></table></div>'
    +'<div class="acc-note">Reach is the share of members active in the range who opened the tab at all. Under 10% gets a “quiet” flag — evidence for the gate and menu decisions in Features (Feature visibility shows the same flag at 30 days).'
    +(D.priorKept?'':' “vs prior” compares sitewide hours with the '+D.r+' days before. Per-member history older than '+(D.keepDays||30)+' days is folded away, so at this range a member’s trend compares this month’s screen time per day with last month’s (a small monthly total per member, kept 2 months; blank until both months cover a week'+(D.moDays?' — now '+(+D.moDays.cur||0)+'d and '+(+D.moDays.prev||0)+'d':'')+').')+'</div>';
  const me=(window.__ME&&window.__ME.handle)||'';
  const mval=(m,k)=>m.paused&&k!=='handle'&&k!=='lastSeen'?null:k==='handle'?m.handle:k==='top'?null:m[k];
  const mRows=uaSorted(D.members||[],UA.msort,mval);
  const members='<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Members'+mOnly+'</div>'
    +'<div class="us-tw"><table class="us-tbl" id="uaMembers"><thead><tr>'
    +uaTh('handle','member',UA.msort,false,'data-uam')+uaTh('lastSeen','last active',UA.msort,false,'data-uam')+uaTh('days','active days',UA.msort,true,'data-uam')
    +uaTh('minPerDay','min / active day',UA.msort,true,'data-uam')+'<th>top tabs</th>'+uaTh('dev','device',UA.msort,false,'data-uam')+uaTh('trend','trend',UA.msort,true,'data-uam')
    +'</tr></thead><tbody>'
    +mRows.map(m=>'<tr class="us-mrow'+(UA.sel===m.handle?' sel':'')+'" data-uah="'+esc(m.handle)+'" tabindex="0" title="open '+esc(m.display)+'’s detail — the view is written to the audit log">'
      +'<td><span class="us-handle">'+esc(m.display)+'</span>'+(m.handle===me?'<span class="us-you">you</span>':'')
        +(m.paused?' <span class="acc-chip">paused</span>':'')+(m.lapsed?' <span class="acc-chip warn">lapsed</span>':'')+'</td>'
      +'<td class="mono">'+uaSeen(m)+'</td>'
      +'<td class="n">'+(m.paused?'—':m.days+' <span class="us-bar" style="width:'+Math.round(m.days/(D.r||1)*48)+'px"></span>')+'</td>'
      +'<td class="n">'+(m.paused?'—':uaMin(m.minPerDay))+'</td>'
      +'<td class="acc-mu">'+(m.paused?'':(m.top||[]).map(esc).join(' · '))+'</td>'
      +'<td class="acc-mu">'+(m.paused?'—':esc(uaDev(m.dev)))+'</td>'
      +'<td class="n">'+(m.paused?'':uaDelta(m.trend))+'</td></tr>').join('')
    +'</tbody></table></div>'+uaDetailHtml()
    +'<div class="acc-note">“Lapsed” = no activity for more than 10 days. Opening a member’s detail is logged (All messages → Read log); these sitewide numbers are not. Members see their own summary, and can pause it, in Messages.'
    +(who!=='members'?' The members table, the drill-in, adoption, retention and the deploy markers are members-only: public visitors have no per-person rows to show.':'')+'</div>';
  const health=who==='members'?uaHealthHtml(D.health):uaPubHealthHtml(D,who)+uaTriageHtml(D.health&&D.health.triage);
  box.innerHTML='<div class="us-row">'+seg+wseg+chips+'</div>'+(D.pub?uaPubCtlHtml(D):'')+kpis+dau+(who==='members'?uaMarksHtml(D):'')+tabs+uaSiteHtml(D,who)+adopt+members+health+uaDigestHtml();   // (-113) digest & nudges last   // (-112) the sitewide sections after the tab table
}

function uaWire(){
  const box=el('admUsageBox'); if(!box||UA.wired) return;
  UA.wired=true;
  const sortBy=(s,k)=>{ if(s.k===k) s.d=-s.d; else { s.k=k; s.d=(k==='handle'||k==='label'||k==='gate'||k==='dev')?1:-1; } };
  box.addEventListener('click',(e)=>{
    const r=e.target.closest('[data-uar]');
    if(r){ const v=+r.dataset.uar; if(v!==UA.r){ UA.r=v; uaLoad(); } return; }
    if(e.target.closest('[data-uarefresh]')){ uaLoad(); return; }
    const w=e.target.closest('[data-uawho]'); if(w){ UA.who=w.dataset.uawho; uaRender(); return; }   // (build 2026.09.25-122) a view choice only
    const tri=e.target.closest('[data-uatri]'); if(tri){ uaTriage(tri.dataset.uatri,tri.dataset.on==='1'); return; }   // (-111)
    if(e.target.closest('[data-uaclose]')){ UA.sel=null; UA.detail=null; uaRender(); return; }
    const th=e.target.closest('[data-uat]'); if(th){ sortBy(UA.tsort,th.dataset.uat); uaRender(); return; }
    const mh=e.target.closest('[data-uam]'); if(mh){ sortBy(UA.msort,mh.dataset.uam); uaRender(); return; }
    const row=e.target.closest('[data-uah]'); if(row){ uaOpenMember(row.dataset.uah); return; }
    // (-113) digest & nudges
    if(e.target.closest('[data-uadgtest]')){ uaDgPost('/api/admin/usage/digest/test',{},'test'); return; }
    if(e.target.closest('[data-uadgsave]')){ const t=box.querySelector('[data-uadgtext]'); uaDgPost('/api/admin/usage/digest',{nudgeText:t?t.value:''},'text'); return; }
    if(e.target.closest('[data-uadgreset]')){ UA.dg.draft=null; uaDgPost('/api/admin/usage/digest',{nudgeText:''},'text'); return; }
  });
  box.addEventListener('input',(e)=>{ if(e.target.closest&&e.target.closest('[data-uadgtext]')) UA.dg.draft=e.target.value; });
  box.addEventListener('keydown',(e)=>{ const row=e.target.closest&&e.target.closest('[data-uah]'); if(row&&e.key==='Enter') uaOpenMember(row.dataset.uah); });
  // (-112) the two tab pickers (a view choice only — nothing is fetched or written)
  box.addEventListener('change',(e)=>{
    const pb=e.target.closest&&e.target.closest('[data-uapub]'); if(pb){ uaPubToggle(!!pb.checked); return; }   // (build 2026.09.25-122)
    const g=e.target.closest&&e.target.closest('[data-uadg]');   // (-113) the digest & nudge settings
    if(g){ const k=g.dataset.uadg; uaDgPost('/api/admin/usage/digest',{[k]:k==='digestDay'?+g.value:!!g.checked},'cfg'); return; }
    const s=e.target.closest&&e.target.closest('[data-uasel]'); if(!s) return;
    if(s.dataset.uasel==='path') UA.pathTab=s.value; else if(s.dataset.uasel==='ctl') UA.ctlTab=s.value; uaRender(); });
}
export { uaKpisHtml, uaPubTabsHtml, uaPubHealthHtml, uaPubChip, uaPubCtlHtml, uaHeatSum, uaPubToggle, UA, openUsageAdm, uaSiteWithheldHtml, uaDigestHtml, uaDgLoad, uaDgPost, uaCohortHtml, uaControlsHtml, uaDauSvg, uaDevicesHtml, uaFunnelHtml, uaHealthHtml, uaHeatSvg, uaMarksHtml, uaNavHtml, uaPathsHtml, uaRegressCard, uaRender, uaSiteHtml, uaTriage, uaTriageHtml };
