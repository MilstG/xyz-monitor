// access.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { IS_ADMIN } from "./admin.js";
import { el, esc, lazyCall } from "./core.js";
import { fetchJSON } from "./data.js";
import { dmPost, dmSysLine } from "./messages.js";


// ===== admin panel: access (members + invites) =================================================
// The only box in the admin panel that decides WHO gets in. Everything else there decides what
// they see once they are in, which is why this sits at the top.
//
// The freshly minted link is shown ONCE here, in full, at mint time — and stays copyable while the
// invite is pending, because the code is stored in plaintext deliberately. Hashing it would buy
// nothing (anyone who can read the volume already holds the session secret and can forge a session
// directly) and would cost the operator the ability to re-send a link they minted an hour ago.
let _acc=null,_accBusy=false,_accMinted='';
async function loadAccess(){
  if(!IS_ADMIN) return;
  try{ _acc=await fetchJSON('/api/access'); }
  catch(e){ _acc={error:String(e&&e.message||e)}; }
  renderAccess();
}
async function accPost(body){
  if(_accBusy) return {ok:false};
  _accBusy=true; renderAccess();
  let out={ok:false};
  try{
    const r=await fetch('/api/access',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    out={ok:r.ok&&d.ok,d:d};
    if(!out.ok&&d&&d.error) alert(d.error);
  }catch(e){ alert('network error — try again'); }
  _accBusy=false;
  await loadAccess();
  return out;
}
function accWhen(ts){
  if(!ts) return '—';
  const d=Math.round((Date.now()-ts)/86400000);
  if(d<=0) return 'today';
  return d===1?'yesterday':d+'d ago';
}
function accUntil(ts){
  const ms=ts-Date.now();
  if(ms<=0) return 'expired';
  const d=Math.round(ms/86400000);
  return d<=0?'under a day':'in '+d+'d';
}
function accLink(code){ return location.origin+'/join/'+code; }

function renderAccess(){
  const box=el('admAccessBox'); if(!box) return;
  if(!IS_ADMIN){ box.innerHTML=''; return; }
  if(!_acc){ box.innerHTML='<div class="adm-navhd">Access</div><div class="acc-note">loading…</div>'; return; }
  if(_acc.error){ box.innerHTML='<div class="adm-navhd">Access</div><div class="acc-note">'+esc(_acc.error)+'</div>'; return; }

  const members=(_acc.members||[]).map(u=>{
    const on=u.disabled?'<span class="acc-mu" style="color:var(--down)">disabled</span>':'';
    return '<div class="acc-row">'
      +'<span style="color:'+(u.disabled?'var(--faint)':'var(--up)')+'">●</span>'
      +'<span class="grow">'+esc(u.display)
      +(String(u.handle||'')!==String(u.display||'').toLowerCase()?' <span class="acc-mu">@'+esc(u.handle)+'</span>':'')
      +(u.isAdmin?' <span class="acc-chip on">♛ operator</span>':'')+'</span>'
      +'<span class="acc-mu">joined '+accWhen(u.createdAt)+' · seen '+accWhen(u.lastSeen)+'</span>'+on
      +'<button type="button" class="acc-chip" data-accrename="'+esc(u.uid)+'" data-cur="'+esc(u.display)+'" title="Rename how this member reads everywhere — messages, conversations, calls. Their sign-in handle and @mentions stay exactly what they were.">rename</button>'
      +'<button type="button" class="acc-chip" data-accreset="'+esc(u.uid)+'" title="Mint a one-day reset link for this member. They set a new password, which signs out every one of their devices.">reset link</button>'
      +'<button type="button" class="acc-chip" data-accsignout="'+esc(u.uid)+'" title="Bump their epoch — every outstanding session on this account stops verifying. Nobody else is affected.">sign out</button>'
      +'<button type="button" class="acc-chip'+(u.isAdmin?' on':'')+'" data-accadmin="'+esc(u.uid)+'" data-on="'+(u.isAdmin?'0':'1')+'" title="Operators can mint invites, disable accounts and see the admin tabs.">'+(u.isAdmin?'demote':'make operator')+'</button>'
      +'<button type="button" class="acc-chip'+(u.disabled?'':' warn')+'" data-accdis="'+esc(u.uid)+'" data-on="'+(u.disabled?'0':'1')+'" title="'+(u.disabled?'Let this account sign in again.':'Stop this account signing in. Their notes and rules stay, attributed. Nobody else is signed out.')+'">'+(u.disabled?'enable':'disable')+'</button>'
      +'</div>';
  }).join('')||'<div class="acc-note">No accounts yet.</div>';

  const inv=(_acc.invites||[]).filter(i=>i.state==='open');
  const spent=(_acc.invites||[]).filter(i=>i.state!=='open').slice(0,6);
  const invRows=inv.map(i=>'<div class="acc-row">'
    +'<span style="color:var(--accent)">◷</span>'
    +'<span class="grow">'+(i.label?esc(i.label):'<span class="acc-mu">no label</span>')
      +(i.kind==='reset'?' <span class="acc-chip">reset · '+esc(i.target||'')+'</span>':'')+'</span>'
    +'<span class="acc-mu">expires '+accUntil(i.expiresAt)+'</span>'
    +'<button type="button" class="acc-chip" data-acccopy="'+esc(i.code)+'" title="Copy the full join link to the clipboard">copy link</button>'
    +'<button type="button" class="acc-chip warn" data-accrevoke="'+esc(i.code)+'" title="Kill this invite. The link stops working immediately.">revoke</button>'
    +'</div>').join('')||'<div class="acc-note">No invites outstanding.</div>';

  const spentRows=spent.length?('<div class="acc-note">Recently spent: '
    +spent.map(i=>esc((i.label||i.kind))+' · '+esc(i.state)+(i.usedBy?' by '+esc(i.usedBy):'')).join(' &nbsp;·&nbsp; ')
    +'</div>'):'';

  const minted=_accMinted?('<div class="acc-link" id="accMintedLink">'+esc(accLink(_accMinted))+'</div>'
    +'<div class="acc-note">Send this to one person. It works once, and you can copy it again from the list above while it is pending.</div>'):'';

  const legacy=_acc.legacyDoor?('<div class="acc-note" style="color:var(--down)">'
    +'The shared password is still accepted — existing sessions land on /claim to pick a handle. '
    +'Once everyone has claimed, set <b>LEGACY_SHARED_PASSWORD=0</b> to close that door for good.</div>'):'';

  box.innerHTML='<div class="adm-navhd">Access '
    +'<span class="adm-navsub">'+(_acc.stats?esc(_acc.stats.users+' member(s) · '+_acc.stats.invitesOpen+' invite(s) open · '+_acc.stats.messages+' message(s)'):'')+'</span></div>'
    +'<div class="acc-sec"><div class="dm-sh" style="padding-left:0">Members</div>'+members+'</div>'
    +'<div class="acc-sec"><div class="dm-sh" style="padding-left:0">Pending invites</div>'+invRows+spentRows+'</div>'
    +'<div class="acc-sec"><div class="dm-sh" style="padding-left:0">Mint an invite</div>'
      +'<div class="acc-mint">'
      +'<input id="accLabel" placeholder="who is this for?" maxlength="64" style="flex:1;min-width:170px">'
      +'<select id="accDays"><option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option></select>'
      +'<button type="button" class="btn" id="accMint"'+(_accBusy?' disabled':'')+'>Mint</button>'
      +'</div>'+minted
      +'<div class="acc-note">The label is your own note — the invitee never sees it, and they still pick their own handle.</div>'
    +'</div>'
    +(legacy?'<div class="acc-sec">'+legacy+'</div>':'');
}

function accWire(){
  const box=el('admAccessBox'); if(!box||box._accWired) return;
  box._accWired=true;
  box.addEventListener('click',async(e)=>{
    const mint=e.target.closest('#accMint');
    if(mint){
      const label=(el('accLabel')||{}).value||'';
      const days=+((el('accDays')||{}).value||7);
      const r=await accPost({op:'mint',label:label,days:days});
      if(r.ok&&r.d&&r.d.invite){ _accMinted=r.d.invite.code; renderAccess(); accCopy(_accMinted,true); }
      return;
    }
    const cp=e.target.closest('[data-acccopy]'); if(cp){ accCopy(cp.dataset.acccopy); return; }
    const rv=e.target.closest('[data-accrevoke]');
    if(rv){ if(confirm('Revoke this invite? The link stops working immediately.')) accPost({op:'revoke',code:rv.dataset.accrevoke}); return; }
    const rn=e.target.closest('[data-accrename]');
    if(rn){
      const nn=(prompt('New display name for this member (2–24 characters; spaces are fine). Their sign-in handle and @mentions stay what they were.',rn.dataset.cur||'')||'').trim();
      if(!nn||nn===rn.dataset.cur) return;
      await accPost({op:'rename',uid:rn.dataset.accrename,handle:nn});   // failures alert inside accPost
      return; }
    const rs=e.target.closest('[data-accreset]');
    if(rs){ const r=await accPost({op:'reset-link',uid:rs.dataset.accreset});
      if(r.ok&&r.d&&r.d.invite){ _accMinted=r.d.invite.code; renderAccess(); accCopy(_accMinted,true); } return; }
    const so=e.target.closest('[data-accsignout]');
    if(so){ if(confirm('Sign this member out of every device? They keep their account and password.')) accPost({op:'signout',uid:so.dataset.accsignout}); return; }
    const ad=e.target.closest('[data-accadmin]');
    if(ad){ const on=ad.dataset.on==='1';
      if(confirm(on?'Make this member an operator? They will be able to mint invites and disable accounts.':'Remove operator from this member?'))
        accPost({op:'admin',uid:ad.dataset.accadmin,on:on}); return; }
    const ds=e.target.closest('[data-accdis]');
    if(ds){ const on=ds.dataset.on==='1';
      if(confirm(on?'Disable this account? They stop being able to sign in. Their notes and rules stay, attributed, and nobody else is signed out.':'Let this account sign in again?'))
        accPost({op:on?'disable':'enable',uid:ds.dataset.accdis}); return; }
  });
}

function accCopy(code,quiet){
  const link=accLink(code);
  const done=()=>{ if(!quiet) alert('Invite link copied.'); };
  try{
    if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(link).then(done,()=>prompt('Copy this invite link:',link)); return; }
  }catch(_){ }
  prompt('Copy this invite link:',link);
}

// ===== admin panel: operator read-through ======================================================
// The owner decided an operator may read every message on this terminal. This is the surface for
// it — deliberately its own box, and deliberately noisy about the audit trail: a power that leaves
// no trace is one nobody can hold you to.
let _admDm=null,_admDmThread=null,_admDmQ='',_admDmAudit=null;
async function loadAdmDm(){
  if(!IS_ADMIN) return;
  try{ _admDm=await fetchJSON('/api/access/dm'); }
  catch(e){ _admDm={error:String(e&&e.message||e)}; }
  try{ _admDmAudit=await fetchJSON('/api/access/dm/audit?limit=12'); }catch(_){ _admDmAudit=null; }
  renderAdmDm();
}
async function admDmOpen(id){
  _admDmThread={loading:true,id:id}; renderAdmDm();
  try{ _admDmThread=await fetchJSON('/api/access/dm/'+encodeURIComponent(id)); }
  catch(e){ _admDmThread={error:String(e&&e.message||e)}; }
  loadAdmDmAudit(); renderAdmDm();
}
async function loadAdmDmAudit(){
  try{ _admDmAudit=await fetchJSON('/api/access/dm/audit?limit=12'); }catch(_){ }
}
async function admDmSearch(q){
  _admDmQ=q;
  if(!q||q.trim().length<2){ _admDmThread=null; renderAdmDm(); return; }
  try{ _admDmThread={search:true,...(await fetchJSON('/api/access/dm/search?q='+encodeURIComponent(q)))}; }
  catch(e){ _admDmThread={error:String(e&&e.message||e)}; }
  loadAdmDmAudit(); renderAdmDm();
}
// One verb against /api/dm, then the conversation is re-read (which itself lands in the read log).
async function admDmModerate(body,confirmText){
  if(confirmText&&!confirm(confirmText)) return;
  const res=await dmPost(body);
  if(!res.ok){ alert((res.d&&res.d.error)||'could not do that'); return; }
  if(_admDmThread&&_admDmThread.ok&&_admDmThread.thread) admDmOpen(_admDmThread.thread);
}
function admWhen(ts){ try{ return new Date(ts).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}); }catch(_){ return ''; } }

// How each dm_audit action reads in the log. Unlisted actions show their raw name, as they always did.
// (build 2026.09.24-109) view-usage: an operator opened one member's usage detail in the Usage fold.
// (build 2026.09.24-113) usage-nudge: a lapsed-member reminder went out (the actor is the admin who switched reminders on).
const ADM_AUDIT_LABEL={'view-usage':'viewed the usage detail of','usage-nudge':'(reminders on) sent a lapsed-member reminder to'};
function renderAdmDm(){
  const box=el('admDmBox'); if(!box) return;
  if(!IS_ADMIN){ box.innerHTML=''; return; }
  if(!_admDm){ box.innerHTML='<div class="adm-navhd">All messages</div><div class="acc-note">loading…</div>'; return; }
  if(_admDm.error){ box.innerHTML='<div class="adm-navhd">All messages</div><div class="acc-note">'+esc(_admDm.error)+'</div>'; return; }

  const threads=(_admDm.threads||[]).map(t=>
    '<div class="acc-row" data-admdm="'+t.id+'">'
    +'<span class="'+(t.kind==='group'?'dm-grp':'sec')+'">'+(t.kind==='group'?'#':'↔')+'</span>'
    +'<span class="grow">'+esc(t.kind==='group'?(t.title||'untitled group'):t.members.map(m=>m.handle).join(' ↔ '))+'</span>'
    +'<span class="acc-mu">'+t.n+' message'+(t.n===1?'':'s')+(t.lastAt?' · '+admWhen(t.lastAt):'')+'</span>'
    +'<button type="button" class="acc-chip" data-admdm="'+t.id+'">read</button></div>').join('')
    ||'<div class="acc-note">No conversations yet.</div>';

  let panel='';
  if(_admDmThread&&_admDmThread.loading) panel='<div class="acc-note">reading…</div>';
  else if(_admDmThread&&_admDmThread.error) panel='<div class="acc-note">'+esc(_admDmThread.error)+'</div>';
  else if(_admDmThread&&_admDmThread.search){
    panel='<div class="dm-sh" style="padding-left:0">'+(_admDmThread.results||[]).length+' hit(s) for “'+esc(_admDmQ)+'”</div>'
      +((_admDmThread.results||[]).map(r=>'<div class="acc-row" data-admdm="'+r.thread+'">'
        +'<span class="grow">'+esc(String(r.body||'').slice(0,140))+'</span>'
        +'<span class="acc-mu">'+esc(r.sender)+' · '+esc(r.threadName)+' · '+admWhen(r.ts)+'</span></div>').join('')
        ||'<div class="acc-note">Nothing matches.</div>');
  } else if(_admDmThread&&_admDmThread.ok){
    panel='<div class="dm-sh" style="padding-left:0">'+esc(_admDmThread.name)+'</div>'
      +'<div class="adm-dmlog">'+(_admDmThread.messages||[]).map(m=>
        m.sys?('<div class="dm-sys">'+esc(dmSysLine(m,null))+'</div>')
        :('<div class="adm-dmrow"><span class="adm-dmwho">'+esc(m.sender)+'</span>'
          +'<span class="adm-dmbody">'+esc(m.body||(m.file?('['+m.file.name+']'):m.deleted?(m.deletedBy?'(removed by '+m.deletedBy+')':'(deleted)'):'')).replace(/\n/g,'<br>')
          +(m.ref?' <span class="dm-tk-s">$'+esc(m.ref)+'</span>':'')
          +(m.editedBy?' <span class="dm-mk">edited by '+esc(m.editedBy)+'</span>':m.edited?' <span class="dm-mk">edited</span>':'')
          +(m.callDropped?' <span class="dm-mk">call removed by '+esc(m.callDropped)+'</span>':'')+'</span>'
          +'<span class="acc-mu">'+admWhen(m.ts)+'</span>'
          // Moderation (build 2026.09.23-94), from the read-through as well as from the tab: the
          // operator can act on a conversation they are not in, which is exactly what this
          // panel is for. Same verbs, same route, same audit row.
          +'<span class="adm-dmmod">'
          +((m.ref&&m.refPx!=null)?'<button type="button" class="dm-tool dm-mod" data-admcalldrop="'+m.id+'" title="Remove this call from the record altogether \u2014 the words stay, the stamp and score go. Audited.">drop call</button> ':'')
          +((!m.deleted&&!m.cmd&&!m.card)?'<button type="button" class="dm-tool dm-mod" data-admedit="'+m.id+'" title="Rewrite this message as the operator \u2014 the room sees it was edited by you. Audited.">edit</button> ':'')
          +(!m.deleted?'<button type="button" class="dm-tool dm-mod" data-admdel="'+m.id+'" title="Delete this message as the operator \u2014 the room sees it was removed by you. Audited.">delete</button>':'')
          +'</span></div>')).join('')+'</div>';
  }

  const audit=(_admDmAudit&&_admDmAudit.entries||[]).map(a=>
    '<div class="acc-note" style="margin:0">'+admWhen(a.at)+' · <b>'+esc(a.who)+'</b> '+esc(ADM_AUDIT_LABEL[a.action]||a.action)
    +(a.thread?' #'+a.thread:'')+(a.detail?' · '+esc(a.detail):'')+'</div>').join('')
    ||'<div class="acc-note" style="margin:0">Nothing read yet.</div>';

  box.innerHTML='<div class="adm-navhd">All messages '
    +'<span class="adm-navsub">every conversation on this terminal, including ones you are not in</span></div>'
    +'<div class="acc-sec"><div class="acc-mint" style="margin-top:0">'
      +'<input id="admDmQ" placeholder="search every message…" value="'+esc(_admDmQ)+'" style="flex:1;min-width:180px">'
      +'<button type="button" class="btn" id="admDmGo">Search</button>'
      +(_admDmThread?'<button type="button" class="btn" id="admDmClear">clear</button>':'')+'</div></div>'
    +'<div class="acc-sec"><div class="dm-sh" style="padding-left:0">Conversations</div>'+threads+'</div>'
    +(panel?'<div class="acc-sec">'+panel+'</div>':'')
    +'<div class="acc-sec"><div class="dm-sh" style="padding-left:0">Read log</div>'+audit
      +'<div class="acc-note">Every read and search above is recorded here, and so is every member usage detail opened in Usage. Members are told, in the Messages tab, that the operator can read their messages and see their usage summary.</div></div>';
}

function admDmWire(){
  const box=el('admDmBox'); if(!box||box._wired) return;
  box._wired=true;
  box.addEventListener('click',(e)=>{
    const t=e.target.closest('[data-admdm]');
    if(t){ admDmOpen(+t.dataset.admdm); return; }
    const md=e.target.closest('[data-admdel]');
    if(md){ admDmModerate({id:+md.dataset.admdel,drop:true},'Delete this message as the operator? Everyone in the conversation sees that you removed it, and the act is written to the audit log.'); return; }
    const mc=e.target.closest('[data-admcalldrop]');
    if(mc){ admDmModerate({callDrop:+mc.dataset.admcalldrop},'Remove this call from the record altogether? The words stay; the stamp, its score and its place in the summary are gone for everyone. This cannot be undone, and it is written to the audit log.'); return; }
    const me=e.target.closest('[data-admedit]');
    if(me){ const m=(_admDmThread&&_admDmThread.messages||[]).find(x=>x.id===+me.dataset.admedit);
      const body=prompt('Rewrite this message as the operator \u2014 the room sees it was edited by you, and the act is written to the audit log.',m?m.body:'');
      if(body!=null&&body.trim()&&(!m||body!==m.body)) admDmModerate({id:+me.dataset.admedit,body:body},null); return; }
    if(e.target.closest('#admDmGo')){ admDmSearch((el('admDmQ')||{}).value||''); return; }
    if(e.target.closest('#admDmClear')){ _admDmThread=null; _admDmQ=''; renderAdmDm(); return; }
  });
  box.addEventListener('keydown',(e)=>{
    if(e.target&&e.target.id==='admDmQ'&&e.key==='Enter') admDmSearch(e.target.value||'');
  });
}

// ===== admin panel: collapsible segments =======================================================
// The panel had grown to eight full-height boxes, so reaching the one you wanted meant scrolling
// past the seven you did not. Each segment now folds, and every segment starts folded.
//
// The wrapper lives OUTSIDE each box, which is what makes this safe: every renderer in this file
// replaces its own box's innerHTML and never touches the wrapper, so open/closed state survives a
// re-render without a single renderer knowing this exists.
//
// Open folds are remembered per browser. "Collapsed by default" is the state you get on a fresh
// browser, not one you have to re-clear every visit — re-collapsing a panel somebody deliberately
// opened five seconds ago is its own kind of annoying.
const ADM_FOLD_KEY='xyz-adm-folds';
function admFoldState(){ try{ return JSON.parse(localStorage.getItem(ADM_FOLD_KEY)||'{}')||{}; }catch(_){ return {}; } }
function admFoldSave(o){ try{ localStorage.setItem(ADM_FOLD_KEY,JSON.stringify(o)); }catch(_){ } }
function admFolds(){ return [...document.querySelectorAll('#view-admin .adm-fold')]; }

function admFoldApply(){
  const st=admFoldState();
  admFolds().forEach(f=>{
    const open=!!st[f.dataset.fold];
    const body=f.querySelector('.adm-foldbody'), caret=f.querySelector('.asec-c'), hd=f.querySelector('.adm-foldhd');
    if(body) body.hidden=!open;
    if(caret) caret.textContent=open?'▾':'▸';
    if(hd) hd.setAttribute('aria-expanded',open?'true':'false');
    f.classList.toggle('open',open);
  });
  // The event-loop row hides itself until it has data to show. Its fold follows it: a header over
  // nothing is worse than no header.
  { const box=el('admLoop'), fold=document.querySelector('#view-admin .adm-fold[data-fold="loop"]');
    if(box&&fold) fold.hidden=!!box.hidden; }
  // (build 2026.09.24-109) The Usage fold's module loads on first open, and refreshes (at most once a
  // minute, its own rule) whenever the fold is open as the panel is applied.
  { const uf=document.querySelector('#view-admin .adm-fold[data-fold="usage"]');
    if(uf&&uf.classList.contains('open')&&IS_ADMIN) lazyCall('usageadm','openUsageAdm'); }
  const all=el('admFoldAll');
  if(all) all.textContent=admFolds().some(f=>f.classList.contains('open')&&!f.hidden)?'collapse all':'expand all';
}

function admFoldWire(){
  const v=el('view-admin'); if(!v||v._foldWired) return;
  v._foldWired=1;
  v.addEventListener('click',(e)=>{
    const hd=e.target.closest('.adm-foldhd');
    if(hd){
      const f=hd.closest('.adm-fold'), key=f&&f.dataset.fold;
      if(!key) return;
      const st=admFoldState();
      if(st[key]) delete st[key]; else st[key]=true;
      admFoldSave(st); admFoldApply();
      return;
    }
    if(e.target.closest('#admFoldAll')){
      const open=admFolds().some(f=>f.classList.contains('open')&&!f.hidden);
      const st={};
      if(!open) admFolds().forEach(f=>{ if(!f.hidden) st[f.dataset.fold]=true; });
      admFoldSave(st); admFoldApply();
    }
  });
}

export { accWire, admDmWire, admFoldApply, admFoldWire, loadAccess, loadAdmDm, renderAccess, renderAdmDm };
