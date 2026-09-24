// usageadm.js — the Admin tab's Usage fold (build 2026.09.24-109). Lazy (core.js LAZY_IMPORTERS):
// only an operator who opens the fold ever downloads it. Reads GET /api/admin/usage?r=7|30 (the
// sitewide aggregates — not logged) and, on a member row click, GET /api/admin/usage/member?h=
// (one member's detail — WRITTEN TO THE AUDIT LOG, shown in All messages → Read log).
// Every handle, display name and label goes through esc(): member text is member-controlled.
import { el, esc } from "./core.js";

const UA={r:7,data:null,err:null,loading:false,loadedAt:0,msort:{k:'days',d:-1},tsort:{k:'ms',d:-1},sel:null,detail:null,wired:false};
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

// ---- the daily-active chart: bars per ET day + the trailing 7-day mean ---------------------------
function uaDauSvg(series){
  const W=640,H=150,P={l:26,r:6,t:8,b:20}, n=series.length||1;
  const max=Math.max(1,...series.map(x=>x.n))*1.15, bw=(W-P.l-P.r)/n, y=v=>H-P.b-(v/max)*(H-P.t-P.b);
  let g='';
  for(const t of [0,.5,1]){ const v=Math.round(max*t); g+='<line class="us-grid" x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text class="us-axis" x="'+(P.l-4)+'" y="'+(y(v)+3)+'" text-anchor="end">'+v+'</text>'; }
  series.forEach((x,i)=>{ const X=P.l+i*bw+bw*.12, w=bw*.76;
    g+='<rect class="us-barf" x="'+X.toFixed(1)+'" y="'+y(x.n).toFixed(1)+'" width="'+w.toFixed(1)+'" height="'+(H-P.b-y(x.n)).toFixed(1)+'" rx="1.5"><title>'+esc(x.day)+': '+x.n+' active</title></rect>'; });
  const pts=series.map((x,i)=>{ const a=series.slice(Math.max(0,i-6),i+1); const m=a.reduce((p,q)=>p+q.n,0)/a.length; return (P.l+i*bw+bw/2).toFixed(1)+','+y(m).toFixed(1); });
  if(pts.length>1) g+='<polyline class="us-mean" points="'+pts.join(' ')+'"/>';
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
    +'</div></div></div>';
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
  const dau='<div class="us-card"><h4>Active people per day</h4><div class="sub">distinct members with ≥1 minute on screen that ET day</div>'
    +uaDauSvg(D.series||[])
    +'<div class="us-legend"><span><i class="c0"></i>members</span><span><i class="us-legmean"></i>7-day mean</span></div></div>';
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
    +'<div class="acc-note">Reach is the share of members active in the range who opened the tab at all. Under 10% gets a “quiet” flag — evidence for the gate and menu decisions in Features.'
    +(D.priorKept?'':' “vs prior” compares sitewide hours with the '+D.r+' days before; per-member history older than '+(D.keepDays||30)+' days is folded away, so member trends are blank at this range.')+'</div>';
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
  box.innerHTML='<div class="us-row">'+seg+chips+'</div>'+kpis+dau+tabs+members;
}

function uaWire(){
  const box=el('admUsageBox'); if(!box||UA.wired) return;
  UA.wired=true;
  const sortBy=(s,k)=>{ if(s.k===k) s.d=-s.d; else { s.k=k; s.d=(k==='handle'||k==='label'||k==='gate'||k==='dev')?1:-1; } };
  box.addEventListener('click',(e)=>{
    const r=e.target.closest('[data-uar]');
    if(r){ const v=+r.dataset.uar; if(v!==UA.r){ UA.r=v; uaLoad(); } return; }
    if(e.target.closest('[data-uarefresh]')){ uaLoad(); return; }
    if(e.target.closest('[data-uaclose]')){ UA.sel=null; UA.detail=null; uaRender(); return; }
    const th=e.target.closest('[data-uat]'); if(th){ sortBy(UA.tsort,th.dataset.uat); uaRender(); return; }
    const mh=e.target.closest('[data-uam]'); if(mh){ sortBy(UA.msort,mh.dataset.uam); uaRender(); return; }
    const row=e.target.closest('[data-uah]'); if(row){ uaOpenMember(row.dataset.uah); return; }
  });
  box.addEventListener('keydown',(e)=>{ const row=e.target.closest&&e.target.closest('[data-uah]'); if(row&&e.key==='Enter') uaOpenMember(row.dataset.uah); });
}
export { UA, openUsageAdm, uaDauSvg, uaRender };
