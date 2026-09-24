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
import { el, esc } from "./core.js";

const UA={r:7,data:null,err:null,loading:false,loadedAt:0,msort:{k:'days',d:-1},tsort:{k:'ms',d:-1},sel:null,detail:null,wired:false,
  triBusy:null,triErr:null};   // (-111) the triage toggle in flight, and its last error
const UA_STALE_MS=60000;

async function uaLoad(){
  UA.loading=true; uaRender();
  try{
    const r=await fetch('/api/admin/usage?r='+UA.r,{headers:{accept:'application/json'}});
    if(!r.ok) throw new Error('HTTP '+r.status);
    UA.data=await r.json(); UA.err=null; UA.loadedAt=Date.now();
  }catch(e){ UA.err=String(e&&e.message||e); }
  UA.loading=false; uaRender();
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
    +'<div class="acc-note">Error text is whatever the browser reported, with quoted text removed and cut to 200 characters; only builds this deployment served count, at most '+(+H.errCap||200)+' distinct errors are kept per build (500 overall, 20 new per member per day), and this card shows this build and the previous one. Public (signed-out) visitors are not tracked: the flag is off and the anonymous-visitor path is deliberately not built.</div>';
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
  else if(V.state==='no-baseline'){ v='<span class="pos">build '+sb+': OK</span>'; s='no earlier build with traffic to compare against'; }
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
    +'<div class="us-tw"><table class="us-tbl us-errs us-tri"><thead><tr><th>state</th><th>file:line · message</th><th>builds</th><th>first seen</th><th>last seen</th><th class="n">hits</th><th class="n">members</th><th></th></tr></thead><tbody>'
    +rows.map(e=>'<tr'+(e.resolved?' class="us-res"':'')+'><td>'+st(e)+'</td>'
      +'<td class="us-emsg"><span class="mono">'+esc(e.loc)+'</span> · '+esc(e.msg)+'</td>'
      +'<td class="mono">'+esc(uaShort(e.firstBuild))+(e.lastBuild!==e.firstBuild?' → '+esc(uaShort(e.lastBuild)):'')+'</td>'
      +'<td class="mono">'+esc(uaWhen(e.firstAt))+'</td><td class="mono">'+esc(uaWhen(e.lastAt))+'</td>'
      +'<td class="n">'+(+e.hits||0)+'</td><td class="n">'+(+e.members||0)+'</td>'
      +'<td><button type="button" class="btn" data-uatri="'+esc(e.sig)+'" data-on="'+(e.resolved?'0':'1')+'"'+(UA.triBusy?' disabled':'')+'>'+(UA.triBusy===e.sig?'…':e.resolved?'reopen':'resolve')+'</button></td></tr>').join('')
    +'</tbody></table></div>'
    +'<div class="acc-note">One row per distinct error (file + message, across builds and line moves). Members is a count, never who. Resolving stamps the latest build it was seen on; a hit from a newer build reopens it as “regressed”, while stale tabs on the old build do not.</div>';
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

// ---- the daily-active chart: bars per ET day + the trailing 7-day mean ---------------------------
function uaDauSvg(series,marks){
  const W=640,H=150,P={l:26,r:6,t:8,b:20}, n=series.length||1;
  const max=Math.max(1,...series.map(x=>x.n))*1.15, bw=(W-P.l-P.r)/n, y=v=>H-P.b-(v/max)*(H-P.t-P.b);
  let g='';
  for(const t of [0,.5,1]){ const v=Math.round(max*t); g+='<line class="us-grid" x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text class="us-axis" x="'+(P.l-4)+'" y="'+(y(v)+3)+'" text-anchor="end">'+v+'</text>'; }
  series.forEach((x,i)=>{ const X=P.l+i*bw+bw*.12, w=bw*.76;
    g+='<rect class="us-barf" x="'+X.toFixed(1)+'" y="'+y(x.n).toFixed(1)+'" width="'+w.toFixed(1)+'" height="'+(H-P.b-y(x.n)).toFixed(1)+'" rx="1.5"><title>'+esc(x.day)+': '+x.n+' active</title></rect>'; });
  const pts=series.map((x,i)=>{ const a=series.slice(Math.max(0,i-6),i+1); const m=a.reduce((p,q)=>p+q.n,0)/a.length; return (P.l+i*bw+bw/2).toFixed(1)+','+y(m).toFixed(1); });
  if(pts.length>1) g+='<polyline class="us-mean" points="'+pts.join(' ')+'"/>';
  // (-111) deploy & gate markers: a vertical line at the start of the ET day each one happened on
  const col=new Map(series.map((x,i)=>[x.day,i]));
  for(const m of (marks||[])){ const i=col.get(m.day); if(i==null) continue;
    const X=(P.l+i*bw+0.5).toFixed(1), cls=m.kind==='deploy'?'us-mk-dep':m.kind==='alert'?'us-mk-alert':'us-mk-gate';
    g+='<line class="us-mk '+cls+'" x1="'+X+'" x2="'+X+'" y1="'+P.t+'" y2="'+(H-P.b)+'"><title>'+esc(uaMarkWord(m))+'</title></line>'; }
  const step=n<=7?1:7;
  for(let i=n-1;i>=0;i-=step) g+='<text class="us-axis" x="'+(P.l+i*bw+bw/2).toFixed(1)+'" y="'+(H-5)+'" text-anchor="middle">'+esc(uaDay(series[i].day))+'</text>';
  return '<svg class="us-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="active members per day">'+g+'</svg>';
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

function uaRender(){
  const box=el('admUsageBox'); if(!box) return;
  const sub=el('admUsageSub');
  const D=UA.data;
  if(!D){ box.innerHTML='<div class="acc-note" style="margin:0">'+(UA.err?'could not load — '+esc(UA.err):'loading…')+'</div>'; return; }
  const K=D.kpi||{};
  if(sub) sub.textContent=K.activeToday+' active today · '+K.activeRange+' in '+D.r+'d · stickiness '+uaPct(K.stickiness);
  const seg='<div class="seg" id="uaRange"><span class="seglbl">range</span>'
    +[7,30].map(r=>'<button type="button" data-uar="'+r+'"'+(D.r===r?' class="active"':'')+'>'+r+'d</button>').join('')+'</div>';
  const chips='<span class="right"><span class="acc-chip on">beacon on</span><span class="acc-chip">retention '+(D.keepDays||30)+'d</span>'
    +'<span class="acc-chip'+(D.publicOn?' on':'')+'">public '+(D.publicOn?'on':'off')+'</span>'
    +'<button type="button" class="btn" data-uarefresh="1"'+(UA.loading?' disabled':'')+'>'+(UA.loading?'…':'refresh')+'</button></span>';
  const kp=(k,v,s)=>'<div class="us-kpi"><div class="k">'+k+'</div><div class="v">'+v+'</div><div class="s">'+s+'</div></div>';
  const kpis='<div class="us-kpis">'
    +kp('<span class="us-live"></span>online now',String(K.online||0),'members with an open tab')
    +kp('active today',String(K.activeToday||0),'≥60s on screen (ET day)')
    +kp('active · '+D.r+'d',String(K.activeRange||0),'of '+(K.members||0)+' members')
    +kp('stickiness',uaPct(K.stickiness),'mean daily ÷ '+D.r+'d active')
    +kp('median / day',K.medMinPerDay==null?'—':uaMin(K.medMinPerDay)+' min','per active member-day')
    +kp('new members',String(K.newMembers||0),'in range · '+(K.newActive||0)+' active')+'</div>';
  const dau='<div class="us-grid2"><div class="us-card"><h4>Active people per day</h4><div class="sub">distinct members with ≥1 minute on screen that ET day</div>'
    +uaDauSvg(D.series||[],D.marks||[])
    +'<div class="us-legend"><span><i class="c0"></i>members</span><span><i class="us-legmean"></i>7-day mean</span>'
    +((D.marks||[]).length?'<span><i class="us-mkdot us-mk-dep"></i>deploy</span><span><i class="us-mkdot us-mk-gate"></i>gate / menu</span><span><i class="us-mkdot us-mk-alert"></i>regression alert</span>':'')+'</div></div>'
    // (build 2026.09.24-110) when people are here
    +'<div class="us-card"><h4>When people are here</h4><div class="sub">minutes on screen by weekday × hour (ET), whole range</div>'
    +uaHeatSvg(D.heat)+uaHeatNote(D.heat)+'</div></div>';
  const C=D.cohorts||{};
  const adopt='<div class="us-grid2" style="margin-top:var(--sp-3)"><div class="us-card"><h4>Feature adoption</h4><div class="sub">members who did it at least once in range (of '+(K.activeRange||0)+' active)</div>'
    +uaFunnelHtml(D)+'</div>'
    +'<div class="us-card"><h4>Retention by join week</h4><div class="sub">% of each ET week’s new members active (a minute on screen on any day) in week N after joining; w0 is the join week</div>'
    +'<div class="us-tw" style="border:0">'+uaCohortHtml(C)+'</div>'
    +'<div class="us-flag">Per-member daily rows fold away after '+(D.keepDays||30)+' days; these cells read a separate yes/no-per-week bit kept '+Math.round((C.keepDays||56)/7)+' weeks (plus the week in progress)'
    +(C.since?', on record since the week of '+esc(uaDay(C.since)):'')+'. “·” = not measured (before the beacon, or a week still to come).</div></div></div>';
  const tval=(t,k)=>k==='label'?t.label.toLowerCase():k==='gate'?t.gate:t[k];
  const tRows=uaSorted(D.tabs||[],UA.tsort,tval), maxMs=Math.max(1,...(D.tabs||[]).map(t=>t.ms));
  const tabs='<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Tabs · reach and time</div>'
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
  const members='<div class="dm-sh" style="padding-left:0;margin-top:var(--sp-3)">Members</div>'
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
    +'<div class="acc-note">“Lapsed” = no activity for more than 10 days. Opening a member’s detail is logged (All messages → Read log); these sitewide numbers are not. Members see their own summary, and can pause it, in Messages.</div>';
  box.innerHTML='<div class="us-row">'+seg+chips+'</div>'+kpis+dau+uaMarksHtml(D)+tabs+adopt+members+uaHealthHtml(D.health);
}

function uaWire(){
  const box=el('admUsageBox'); if(!box||UA.wired) return;
  UA.wired=true;
  const sortBy=(s,k)=>{ if(s.k===k) s.d=-s.d; else { s.k=k; s.d=(k==='handle'||k==='label'||k==='gate'||k==='dev')?1:-1; } };
  box.addEventListener('click',(e)=>{
    const r=e.target.closest('[data-uar]');
    if(r){ const v=+r.dataset.uar; if(v!==UA.r){ UA.r=v; uaLoad(); } return; }
    if(e.target.closest('[data-uarefresh]')){ uaLoad(); return; }
    const tri=e.target.closest('[data-uatri]'); if(tri){ uaTriage(tri.dataset.uatri,tri.dataset.on==='1'); return; }   // (-111)
    if(e.target.closest('[data-uaclose]')){ UA.sel=null; UA.detail=null; uaRender(); return; }
    const th=e.target.closest('[data-uat]'); if(th){ sortBy(UA.tsort,th.dataset.uat); uaRender(); return; }
    const mh=e.target.closest('[data-uam]'); if(mh){ sortBy(UA.msort,mh.dataset.uam); uaRender(); return; }
    const row=e.target.closest('[data-uah]'); if(row){ uaOpenMember(row.dataset.uah); return; }
  });
  box.addEventListener('keydown',(e)=>{ const row=e.target.closest&&e.target.closest('[data-uah]'); if(row&&e.key==='Enter') uaOpenMember(row.dataset.uah); });
}
export { UA, openUsageAdm, uaCohortHtml, uaDauSvg, uaFunnelHtml, uaHealthHtml, uaHeatSvg, uaMarksHtml, uaRegressCard, uaRender, uaTriage, uaTriageHtml };
