// messages.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { IS_ADMIN, featureOn } from "./admin.js";
import { pushToast } from "./alerts.js";
import { showView } from "./backtest.js";
import { G, el, esc, fmtPrice, overlayPop, overlayPush, state } from "./core.js";
import { ratioImageSvg } from "./corr.js";
import { fetchJSON } from "./data.js";
import { openDetail } from "./drawer.js";
import { HELP_KEYS, closeHelp } from "./nav.js";
import { TFIELD, nlResolve, termActive, termAsk, termComps, termErr, termExec, termFind, termGrammarComplete, termHistPush, termOutTrans, termSetSink, termSink, tpad } from "./terminal.js";
import { loadRules } from "./triggers.js";


// ===== MESSAGES tab (build 2026.08.30-46, groups/files/reactions/search 2026.08.31-47) =========
// Two rules shape everything here:
//
//   1. Message bodies, handles, group titles and filenames are the ONLY attacker-controlled strings
//      this client renders. Every other value on the board is a server-computed number. So all of
//      them go through esc() on every path — the log, the rail, the search results, the member
//      list. There is no "trusted" rendering path for anything a person typed.
//   2. The stream carries versions, never payloads — the same contract as the snapshot push. An SSE
//      `dm` frame says "the sequence moved" (and may carry an ephemeral typing hint); this client
//      answers it with an ordinary /api/dm/sync pull keyed by its own cursor. A dropped frame costs
//      nothing: the cursor is authoritative and the next pull collects whatever was missed.
const dmState = { me: null, threads: [], members: [], online: new Set(),
  sel: null, msgs: new Map(), info: new Map(), cursor: 0, loaded: false, err: '', sending: false,
  picking: false, editing: null, pendingPeer: null, reactions: [], maxLen: 4000, maxFile: 8388608,
  typing: new Map(), q: '', results: null, searching: false, manage: false, pendingFile: null,
  watching: [], admin: false, operatorReadsAll: false, calls: null, mode: 'chat', watchAdd: false,
  boards: [], meTg: false, adoptables: null,
  replying: null, unreadMark: null, scrollToNew: false, showClosed: false,
  callsBy: null, webPushOn: false, searchScope: 'all',
  // Chat terminal (build 2026.09.11-69): per-thread lines only this viewer sees (help, errors,
  // "running…"), never sent anywhere; and the one-at-a-time latch for a command in flight.
  localOut: new Map(), cmdBusy: false, cmdLine: '', compIdx: 0,
  // Timeframe switches on posted ratio charts: per message, the viewer's own live redraw (tf +
  // svg). Never sent — the posted picture is the record, this is a lens on it.
  rtLive: new Map() };

function dmSignedIn(){ return !!(window.__ME && window.__ME.uid); }
function dmUnreadTotal(){ return dmState.threads.reduce((a,t)=>a+((t.muted||t.hidden)?0:(t.unread||0)),0); }
// Re-pull the open conversation's page — used by the 45s tick's cousin cases: a tweet card
// landing, a jumped-to message needing fresh context.
async function dmRefreshOpen(){
  if(!dmState.sel) return;
  try{
    const d=await fetchJSON('/api/dm/'+encodeURIComponent(dmState.sel));
    if(d&&d.ok){ dmMerge(d.messages); if(d.info){ d.info.more=!!d.more; dmState.info.set(dmState.sel,d.info); } if(state.view==='dm') dmRender(); }
  }catch(_){ }
}
// Older history, one page at a time. The server has paged history (`before`/`limit`/`more`) but
// the client never called it: anything past the newest 50 messages was unreachable in the UI
// while still inside retention (and in the export). The pre-load top message stays anchored in
// the viewport, so loading the past never teleports the reader.
async function dmLoadOlder(){
  const id=dmState.sel; if(!id) return;
  const arr=dmMsgs(id); if(!arr.length) return;
  const anchor=arr[Math.max(0,arr.length-_dmWin)].id;   // the top of what is showing stays put
  const keepTop=()=>{ const elm=document.querySelector('.dm-msg[data-mid="'+anchor+'"]'); if(elm) elm.scrollIntoView({block:'start'}); };
  // Cached but outside the window: widen the window, no fetch.
  if(arr.length>_dmWin){ _dmWin=Math.min(arr.length,_dmWin+DM_WINDOW); dmRenderNow(); keepTop(); return; }
  try{
    const d=await fetchJSON('/api/dm/'+encodeURIComponent(id)+'?before='+encodeURIComponent(arr[0].id)+'&limit='+DM_WINDOW);
    if(d&&d.ok){
      _dmWin+=(d.messages||[]).length;   // the page just fetched is the page being asked for — show it
      dmMerge(d.messages);
      const info=dmState.info.get(id); if(info) info.more=!!d.more;
      dmRenderNow(); keepTop();
    }
  }catch(_){ }
}

// The tab pip. Painted from the thread list rather than a separate counter so it can never
// disagree with what the rail shows. The browser-tab title carries the same count, so unread
// messages are visible from ANY tab of the app — and from another window entirely.
let _dmBaseTitle='';
function dmUpdatePip(){
  const n=dmUnreadTotal();
  if(!_dmBaseTitle) _dmBaseTitle=document.title;
  try{ document.title=(n?'('+(n>99?'99+':n)+') ':'')+_dmBaseTitle; }catch(_){}
  const b=el('tab-dm'); if(!b) return;
  b.innerHTML='Messages'+(n?'<span class="tabpip">'+(n>99?'99+':n)+'</span>':'');
  // If the admin moved Messages into a ribbon menu, the pip on the tab is invisible until the
  // menu opens — mirror it onto the menu's own button so unread is visible from the main screen.
  const wrap=b.closest('.tabgrp'), gb=wrap?wrap.querySelector('.grp'):null;
  if(gb){
    let pip=gb.querySelector('.tabpip');
    if(n){ if(!pip){ pip=document.createElement('span'); pip.className='tabpip'; gb.insertBefore(pip, gb.querySelector('.caret')); }
      pip.textContent=n>99?'99+':String(n); }
    else if(pip) pip.remove();
  }
  // The chat dock's red count rides the same number.
  const dp=el('dm-dockpip');
  if(dp){ dp.hidden=!n; if(n) dp.textContent=n>99?'99+':String(n); }
  dmFavicon(n);
}
// The browser-tab ICON carries the count too — pinned tabs truncate the title, and the favicon is
// all that survives. The site icon is drawn under a red badge; if the SVG taints the canvas the
// badge draws on a plain dark tile instead, and any failure leaves the original icon alone.
let _favLink=null,_favImg=null,_favLast=null;
function dmFavicon(n){
  try{
    if(_favLast===n) return; _favLast=n;
    if(!_favLink){ _favLink=document.querySelector('link[rel="icon"]');
      if(!_favLink){ _favLink=document.createElement('link'); _favLink.rel='icon'; document.head.appendChild(_favLink); } }
    if(!n){ _favLink.href='/icon.svg'; return; }
    const draw=()=>{
      try{
        const c=document.createElement('canvas'); c.width=c.height=64;
        const x=c.getContext('2d');
        try{ if(_favImg&&_favImg.complete&&_favImg.naturalWidth) x.drawImage(_favImg,0,0,64,64); }
        catch(_){ }
        let url;
        try{ url=c.toDataURL('image/png'); }
        catch(_){ // tainted: redraw badge-only on a clean canvas
          const c2=document.createElement('canvas'); c2.width=c2.height=64; const y=c2.getContext('2d');
          y.fillStyle='#151A21'; y.beginPath(); y.roundRect?y.roundRect(0,0,64,64,14):y.rect(0,0,64,64); y.fill();
          badge(y); url=c2.toDataURL('image/png'); _favLink.href=url; return;
        }
        badge(x); _favLink.href=c.toDataURL('image/png');
      }catch(_){ }
    };
    const badge=(x)=>{
      x.fillStyle='#E5604D'; x.beginPath(); x.arc(45,19,18,0,7); x.fill();
      x.fillStyle='#fff'; x.font='bold 26px system-ui,sans-serif'; x.textAlign='center'; x.textBaseline='middle';
      x.fillText(n>9?'9+':String(n),45,21);
    };
    if(!_favImg){ _favImg=new Image(); _favImg.onload=draw; _favImg.src='/icon.svg'; setTimeout(draw,400); }
    else draw();
  }catch(_){ }
}

function dmThread(id){ return dmState.threads.find(t=>t.id===id)||null; }
function dmMsgs(id){ let a=dmState.msgs.get(id); if(!a){ a=[]; dmState.msgs.set(id,a); } return a; }
// Merge by id, newest wins: an edit, a reaction or a tombstone arrives as the same id with new
// fields, so a blind push would render the message twice — once stale.
// The log is WINDOWED: a thread paints its newest DM_WINDOW messages and the "older" pager walks
// back (locally first, then the server's before= pages). The per-thread cache is capped at
// DM_CACHE newest — a conversation that lives for days used to keep every message ever merged.
// The open thread's cap stretches to whatever the pager has walked to, so paging never trims
// what it just fetched.
const DM_WINDOW=100, DM_CACHE=500;
let _dmWin=DM_WINDOW;   // how many of the open thread's messages the log shows; reset on every open
function dmMerge(list){
  const touched=new Set(); let added=0; const updated=[];
  for(const m of (list||[])){
    const arr=dmMsgs(m.thread);
    const i=arr.findIndex(x=>x.id===m.id);
    if(i>=0){ arr[i]=m; if(m.thread===dmState.sel) updated.push(m.id); } else { arr.push(m); added++; }
    touched.add(m.thread);
    // The sync cursor is deliberately NOT advanced here. It is global across threads, and a
    // single-thread history fetch advancing it meant opening thread A skipped every not-yet-
    // synced lower-id message in thread B. Only dmSync, which sees all threads, moves it; a
    // message merged twice is a no-op by the id-dedupe above.
  }
  for(const [id,arr] of dmState.msgs){ if(!touched.has(id)) continue; arr.sort((a,b)=>a.id-b.id);
    const cap=id===dmState.sel?Math.max(DM_CACHE,_dmWin):DM_CACHE;
    if(arr.length>cap){ arr.splice(0,arr.length-cap); const info=dmState.info.get(id); if(info) info.more=true; } }   // what was dropped is still on the server: the pager can re-fetch it
  return {added, updated};
}

async function dmLoad(){
  if(!dmSignedIn()) return;
  try{
    const d=await fetchJSON('/api/dm');
    if(!d||!d.ok) throw new Error((d&&d.error)||'could not load messages');
    dmState.me=d.me; dmState.threads=d.threads||[]; dmState.members=d.members||[];
    dmState.online=new Set(d.online||[]); dmState.maxLen=d.maxLen||4000;
    dmState.maxFile=d.maxFile||8388608; dmState.reactions=d.reactions||[];
    dmState.watching=d.watching||[]; dmState.admin=!!d.admin; dmState.operatorReadsAll=!!d.operatorReadsAll;
    dmState.boards=d.boards||[]; dmState.meTg=!!d.meTg;
    // With no Telegram linked, ask whether the bot already messages a chat no account owns —
    // that is this member's own phone from before accounts, offered for a code-verified claim.
    if(!dmState.meTg&&dmState.adoptables===null){
      try{ const a=await fetchJSON('/api/alerts/adoptable'); dmState.adoptables=(a&&a.ok)?(a.candidates||[]):[]; }
      catch(_){ dmState.adoptables=[]; }
    }
    dmState.loaded=true; dmState.err='';
  }catch(e){ dmState.err=e.message||String(e); }
  dmUpdatePip();
}

// Code-verified claim of an already-linked chat: request sends a 6-digit code TO that Telegram,
// typing it back here is the proof of control that moves ownership to this account.
async function dmAdopt(chat){
  const r=await fetch('/api/alerts/adopt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.ok){ pushToast('Could not send a code — '+((d&&d.error)||('HTTP '+r.status))); return; }
  const code=(prompt('A 6-digit code was sent to “'+(d.name||'that chat')+'” on Telegram.\nEnter it here to link that chat to your account:')||'').trim();
  if(!code) return;
  const v=await fetch('/api/alerts/adopt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat,code})});
  const dv=await v.json().catch(()=>({}));
  if(v.ok&&dv.ok){ pushToast('Telegram linked — messages that arrive while you are away now nudge your phone');
    dmState.adoptables=null; await dmLoad(); dmRender(); }
  else pushToast((dv&&dv.error)||'That code did not match');
}

// The pull the SSE frame triggers. Runs whatever tab is showing — the unread pip has to be right
// before you look at it, not after.
let _dmSyncing=false,_dmSyncQueued=false;
async function dmSync(){
  if(!dmSignedIn()) return;
  // A poke landing while a sync is in flight used to be dropped on the floor — the in-flight
  // response predates the message that poked, and nothing retried. Queue it and run once more.
  if(_dmSyncing){ _dmSyncQueued=true; return; }
  _dmSyncing=true;
  try{
    const prevCursor=dmState.cursor||0;
    const d=await fetchJSON('/api/dm/sync?since='+encodeURIComponent(prevCursor));
    if(d&&d.ok){
      const chg=dmMerge(d.messages);
      if(d.threads) dmState.threads=d.threads;
      if(d.cursor>dmState.cursor) dmState.cursor=d.cursor;
      if(d.more) _dmSyncQueued=true;   // the server truncated: come straight back for the rest
      dmUpdatePip();
      // A message landing while you are anywhere BUT the Messages tab surfaces as a toast — the
      // pip alone was easy to miss under a ribbon menu. Muted conversations stay quiet here too.
      if(prevCursor&&state.view!=='dm'){
        const muted=new Set(dmState.threads.filter(t=>t.muted).map(t=>t.id));
        // A muted thread stays quiet — unless the message calls YOUR handle, which pierces the
        // mute here exactly as it does on the Telegram escalation.
        const fresh=(d.messages||[]).filter(m=>!m.mine&&!m.sys&&!m.deleted&&m.id>prevCursor
          &&(!muted.has(m.thread)||dmMentionsMe(m.body)));
        if(fresh.length){
          const f=fresh[fresh.length-1];
          pushToast('💬 '+f.sender+': '+String(f.body||'attachment').slice(0,80)
            +(fresh.length>1?'  (+'+(fresh.length-1)+' more)':'')+' — open Messages');
        }
      }
      // THE "sent · not read yet forever" fix: a reader sitting IN the open conversation never
      // marked arrivals read — the receipt only moved when they re-opened the thread, so senders
      // concluded delivery itself was broken. Reading is being here with the tab visible.
      if(state.view==='dm'&&dmState.sel&&!document.hidden
        &&(d.messages||[]).some(m=>m.thread===dmState.sel&&!m.mine)) dmMarkRead(dmState.sel);
      // Nothing NEW on the open thread (a reaction, an edit, a read receipt): touch only those rows.
      if(state.view==='dm'){ if(chg.added||!dmState.sel||dmState.results||dmState.mode!=='chat') dmRender();
        else { for(const id of chg.updated) dmPatchMsg(id); dmPatchReceipt(); } }
    }
  }catch(_){ /* the next frame or the next open retries; a failed sync is never fatal */ }
  finally{ _dmSyncing=false; if(_dmSyncQueued){ _dmSyncQueued=false; dmSync(); } }
}

// Ephemeral, and treated as such: a typing hint that arrives is shown for its own lifetime and
// never stored, never merged into a thread, never survives a reload.
function dmTypingFrame(t){
  if(!t||!t.thread) return;
  dmState.typing.set(t.thread,{uids:(t.uids||[]).filter(u=>u!==(dmState.me&&dmState.me.uid)),at:Date.now()});
  dmPatchTyping(t.thread);
  setTimeout(()=>{ const e=dmState.typing.get(t.thread);
    if(e&&Date.now()-e.at>=5500){ dmState.typing.delete(t.thread); dmPatchTyping(t.thread); } },6000);
}
// A typing frame arrives on every keystroke at the other end; it used to rebuild the whole panel.
// The line has its own slot under the log, so only that slot is rewritten.
function dmPatchTyping(id){ if(state.view!=='dm'||dmState.sel!==id) return; const box=el('dm-typing'); if(box) box.innerHTML=dmTypingLine(id); }
// One message changed in place (a reaction, an edit, a tombstone): rewrite that row only.
function dmPatchMsg(id){ const t=dmThread(dmState.sel); if(!t) return;
  const elm=document.querySelector('#dm-log .dm-msg[data-mid="'+(+id)+'"]'); if(!elm) return;
  const arr=dmMsgs(t.id), i=arr.findIndex(x=>x.id===id); if(i<0) return;
  elm.outerHTML=dmMessageHtml(arr[i],t,arr[i-1]); }
// "seen by" under your last message rides the thread list, not a message: rewrite that line only.
function dmReceiptHtml(t, arr){
  const lastMine=[...arr].reverse().find(x=>x.mine&&!x.sys);
  const seenBy=(t.seen||[]).filter(x=>lastMine&&x.readMsgId>=lastMine.id).map(x=>x.handle);
  return lastMine?('<div class="dm-seen">'+(seenBy.length
    ?('seen by '+esc(seenBy.join(', ')))
    :(t.kind!=='dm'?'sent':'sent \u00b7 not read yet'))+'</div>'):''; }
function dmPatchReceipt(){ const t=dmThread(dmState.sel); if(!t) return; const cur=document.querySelector('#dm-log .dm-seen'); if(!cur) return;
  const html=dmReceiptHtml(t, dmMsgs(t.id)); if(html&&cur.outerHTML!==html) cur.outerHTML=html; }
function dmTypingLine(threadId){
  const e=dmState.typing.get(threadId);
  if(!e||Date.now()-e.at>6000||!e.uids.length) return '';
  const names=e.uids.map(u=>{ const m=dmState.members.find(x=>x.uid===u); return m?m.display:'someone'; });
  return '<div class="dm-typing">'+esc(names.join(', '))+(names.length===1?' is':' are')+' typing…</div>';
}

async function dmOpenThread(id){
  // Whatever is in the box belongs to the thread being left, not the one being opened.
  if(dmState.sel&&dmState.sel!==id){ const ta=el('dm-input'); if(ta) dmDraftSave(dmState.sel,ta.value); }
  dmState.sel=id; dmState.editing=null; dmState.replying=null; dmState.picking=false; dmState.manage=false;
  dmState.results=null; dmState.pendingPeer=null; dmState.pendingFile=null; dmState.mode='chat'; _dmWin=DM_WINDOW;
  // Where "new" starts is decided NOW, before markRead moves the watermark: the divider draws at
  // the read position this open found, and stays put while you read past it.
  { const th0=dmThread(id);
    dmState.unreadMark=(th0&&th0.unread>0)?{thread:id,after:+th0.myRead||0}:null;
    dmState.scrollToNew=!!dmState.unreadMark; }
  dmRenderNow();
  { const ta=el('dm-input'); if(ta){ ta.value=dmDraftGet(id); dmAutoGrow(ta); } }
  try{
    const d=await fetchJSON('/api/dm/'+encodeURIComponent(id));
    if(d&&d.ok){ dmMerge(d.messages); if(d.info){ d.info.more=!!d.more; dmState.info.set(id,d.info); } dmRender(); }
  }catch(_){ }
  requestAnimationFrame(()=>{ if(state.view==='dm'&&dmState.sel===id&&!dmState.results&&dmState.mode!=='calls'){ dmScrollBottom(); dmPageToComposer(); } });
  dmMarkRead(id);
}

async function dmMarkRead(id){
  const arr=dmMsgs(id); if(!arr.length) return;
  const last=arr[arr.length-1].id;
  const t=dmThread(id); if(t&&!t.unread) return;
  try{
    await fetch('/api/dm',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({thread:id,read:last})});
    if(t) t.unread=0;
    dmUpdatePip(); dmRender();
  }catch(_){ }
}

async function dmPost(body){
  const r=await fetch('/api/dm',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  return {ok:r.ok&&d&&d.ok!==false,d:d};
}

// ---- sending -----------------------------------------------------------------------------------
async function dmSend(){
  const ta=el('dm-input'); if(!ta||dmState.sending) return;
  let text=ta.value.trim();
  // "/verb …" is a terminal command, not a message (build 2026.09.11-69): it runs through the
  // ask terminal's own handlers and its OUTPUT is what gets posted. "//…" sends a message that
  // really starts with a slash. Editing never routes here — a rewording is prose by definition.
  if(!dmState.editing&&/^\/[^\/\s]/.test(text)) return dmRunCmd(text);
  if(!dmState.editing&&text.startsWith('//')) text=text.slice(1);
  const file=dmState.editing?null:dmState.pendingFile;   // the edit verb has no fileId — never upload into it
  if(!text&&!file) return;
  const t=dmThread(dmState.sel), peer=dmState.pendingPeer;
  if(!t&&!peer) return;
  dmState.sending=true; dmState.err=''; dmRender();

  let fileId=null;
  if(file){
    // The thread has to exist before a file can belong to it, so a first message with an
    // attachment sends the text first and attaches on the follow-up rather than inventing a
    // pre-thread upload slot.
    const threadId=t?t.id:null;
    if(threadId){
      const up=await dmUpload(threadId,file);
      if(!up.ok){ dmState.err=up.error||'could not attach that file'; dmState.sending=false; dmRender(); return; }
      fileId=up.id;
    }else{ dmState.err='say something first, then attach'; dmState.sending=false; dmRender(); return; }
  }

  const body=dmState.editing?{id:dmState.editing,body:text}
    :t?{thread:t.id,body:text,fileId:fileId,replyTo:dmState.replying||null}
    :{to:peer,body:text};
  const res=await dmPost(body);
  dmState.sending=false;
  if(res.ok){
    // Nothing is kept in the box on success; on failure the text stays exactly where it was,
    // because a dropped connection must never eat something somebody typed.
    ta.value=''; dmState.editing=null; dmState.replying=null; dmState.pendingFile=null; dmState.pendingPeer=null;
    dmDraftSave(dmState.sel,'');
    _dmClearOnNextRender=true;
    if(res.d.message) dmMerge([res.d.message]);
    if(res.d.thread) dmState.sel=res.d.thread;
    await dmLoad();
    if(dmState.sel) { try{ const h=await fetchJSON('/api/dm/'+dmState.sel); if(h&&h.ok){ dmMerge(h.messages); if(h.info){ h.info.more=!!h.more; dmState.info.set(dmState.sel,h.info); } } }catch(_){ } }
    dmRender(); dmScrollBottom();
  }else{
    dmState.err=(res.d&&res.d.error)||'could not send — try again';
    dmRender();
  }
}

// ---- chat terminal ------------------------------------------------------------------------------
// The ask terminal's verbs, run from the composer and posted into the conversation. One code path:
// the SAME handlers the panel uses run against the SAME rows, with the panel's output sink swapped
// for a collector (see termEmit); the collected blocks are flattened to text and sent as an
// ordinary message carrying `cmd`, so everyone in the thread reads the same table under the
// sender's name, badged computed or AI exactly as the panel badges it.
//
// Two switches, both the operator's (Admin › Features): dm.terminal for the local grammar (public
// by default — it costs nothing), dm.ask for the AI leg (admin by default — it spends the shared
// budget and the answer lands where the whole conversation reads it). The server enforces both on
// the post and on the ask; the checks here only spare a member the round trip.
//
// Not everything the panel can do belongs in a chat. Verbs that OPEN A VIEW (comp, report, ratio,
// drawer), CHANGE STATE (basket, whale add/rm, backfills, admin …) or STEER THE PANEL (clear,
// stocks/crypto) are refused with a pointer to the terminal — a table posted for a group is a
// different act from navigating your own screen.
const DM_CMD_BLOCKED={comp:'opens the chart view',report:'opens the AI report view',ai:'opens the AI report view',
  basket:'edits the basket registry',admin:'admin verbs stay in the terminal',clear:'steers the panel',stocks:'switches your scope',crypto:'switches your scope',
  drawer:'opens the drawer',history:'is the panel\u2019s own scrollback',watch:'edits your watchlist',notes:'opens the notes book'};
const DM_CMD_SUB_BLOCKED={earnings:['backfill'],earn:['backfill'],whale:['add','pick','rm','ingest13f','pull','mute','unmute'],'13f':['add','pick','rm','ingest13f','pull','mute','unmute'],
  insiders:['parse','requeue','backfill'],form4:['parse','requeue','backfill'],congress:['ingest','parse','ocr']};
// null = fine, else the reason a RESOLVED command may not run from a chat.
function dmCmdCheck(cmd){
  const p=cmd.trim().split(/\s+/), h=(p[0]||'').toLowerCase(), sub=(p[1]||'').toLowerCase();
  if(/^report\s+(sector|basket)\b/i.test(cmd)) return '"report" opens the AI report view \u2014 use the terminal (~)';
  if(DM_CMD_BLOCKED[h]) return '"'+h+'" '+DM_CMD_BLOCKED[h]+' \u2014 use the terminal (~)';
  if(DM_CMD_SUB_BLOCKED[h]&&DM_CMD_SUB_BLOCKED[h].includes(sub)) return '"'+h+' '+sub+'" changes state \u2014 use the terminal (~)';
  return null;
}
function dmCmdAllowed(){ return IS_ADMIN||featureOn('dm.terminal'); }
function dmAskAllowed(){ return IS_ADMIN||featureOn('dm.ask'); }
// A line only this viewer sees, in this thread, under the messages. Never persisted, never sent;
// cleared by /clear, capped so a run of errors can't push the conversation off the screen.
function dmLocal(html,cls){
  const id=dmState.sel; if(id==null) return;
  let arr=dmState.localOut.get(id); if(!arr){ arr=[]; dmState.localOut.set(id,arr); }
  arr.push({html:html,cls:cls||'',ts:Date.now()}); while(arr.length>6) arr.shift();
  dmRender(); dmScrollBottom();
}
function dmLocalHtml(threadId){
  const arr=dmState.localOut.get(threadId)||[]; let h='';
  for(const x of arr) h+='<div class="dm-local '+x.cls+'"><span class="dm-localmk">only you see this</span>'+x.html+'</div>';
  if(dmState.cmdBusy) h+='<div class="dm-local run"><span class="dm-cmdpr">\u25b8</span> '+esc(dmState.cmdLine)+' <i>running\u2026</i></div>';
  return h;
}
// One source for the chat's /help card and the full guide modal (build 2026.09.11-70): the rows
// live here and render two ways, so the card can never list a verb the guide forgot. Tags:
// c = runs from a chat · t = panel only (opens a view or changes state) · i = AI, spends budget ·
// a = operator only.
const DM_CMD_GUIDE=[
  {h:'Lookups',rows:[
    ['<ticker>','the card \u2014 price, day move, funding, OI, squeeze, momentum, vs tape \u00b7 /nvda \u00b7 /btc','c'],
    ['<ticker> <field>','one column on one name: funding \u00b7 oi \u00b7 squeeze \u00b7 d7 \u00b7 rvol \u00b7 gap \u00b7 vsvwap \u00b7 vsma200 \u00b7 ytd \u00b7 sector \u00b7 any board column','c']]},
  {h:'Rankings & screens',rows:[
    ['top|bottom <field> [n]','any column, plus gainers \u00b7 losers \u00b7 trending \u2014 /top funding 5 \u00b7 /bottom d7','c'],
    ['screen <expr>','fields joined with & \u2014 /screen funding>20 & squeeze>50 \u00b7 /screen rvol>2','c'],
    ['breadth \u00b7 sectors [d7|d30]','tape health \u00b7 sector performance','c']]},
  {h:'Signals \u00b7 earnings \u00b7 news',rows:[
    ['signals [ticker]','active signals, ledgered and resolved out of sample','c'],
    ['earnings [ticker|today|tomorrow|week|recent]','the calendar, or one name\u2019s next print','c'],
    ['news [ticker] [n]','verified headlines, 72h window','c'],
    ['reports','recent AI reports','c']]},
  {h:'Compare',rows:[
    ['vs <a> <b>','side-by-side field compare','c'],
    ['corr <a> <b>','correlation and hedge \u03b2 over 90 days of daily returns','c'],
    ['diverge <ticker>','a name against its benchmark \u2014 is it decoupling','c'],
    ['comp <a> <b> \u2026','overlay rebased to 100 (COMP/G) \u2014 opens the chart view \u00b7 BTC may join a stock set','t'],
    ['ratio <A>/<B> [1h|4h|12h|1d]','synthetic pair candles with EMA200 \u2014 in a chat the chart posts as an image \u00b7 /ratio MAG7/EWZ 4h \u00b7 BTC may face a stock: /ratio NVDA/BTC','ca'],
    ['basket create|list|drop','custom equal-weight baskets, usable in comp and ratio','ta']]},
  {h:'Filings & holders',rows:[
    ['fund <ticker> \u00b7 etf <symbol>','SEC-filed balance sheet \u00b7 fund composition (N-PORT)','c'],
    ['whale [KEY [full] | season]','tracked 13F funds, one fund\u2019s book, the quarter summary','c'],
    ['holds <ticker>','who holds a name, from the market-wide index','c'],
    ['insiders \u00b7 congress','Form 4 and PTR lane status','c']]},
  {h:'AI',rows:[
    ['<plain english>','anything the grammar can\u2019t parse \u2014 the answer posts here, badged AI','ci'],
    ['report <ticker> \u00b7 report sector <name> \u00b7 report basket <t> <t> \u2026','the AI analyst report \u2014 opens the report view','ti']]},
  {h:'Chat only',rows:[
    ['/alert <ticker> <above|below|crosses> <n>','a threshold alert that fires INTO this conversation \u00b7 /alert NVDA > 200 \u00b7 /alert NVDA crosses down 180 \u00b7 /alert NVDA above 200ma \u00b7 /alert HOOD d1 > 5 \u00b7 /alert list \u00b7 /alert off <id>','c'],
    ['/help','the short card, privately \u2014 only you see it','c'],
    ['/clear','forget your private lines; the conversation is untouched','c'],
    ['//text','send a message that really starts with a slash','c']]},
  {h:'Admin',rows:[
    ['admin unlock <password> \u00b7 admin lock \u00b7 admin reset-reports <password>','AI unlock and the daily budget \u2014 the echo is redacted','ta'],
    ['whale add|pick|rm|mute|unmute|pull|ingest13f','curate the 13F watchlist','ta'],
    ['earnings backfill \u00b7 insiders parse|requeue|backfill \u00b7 congress ingest|parse|ocr','lane maintenance','ta']]},
];
const DM_CMD_EXAMPLES=[['most crowded shorts','top funding'],['who reports tomorrow','earnings tomorrow'],['best sector this week','sectors d7'],
  ['whats above the 200dma','screen vsma200>0'],['nvda vs amd','vs NVDA AMD'],['hows the tape','breadth']];
function dmGuideChips(tags){
  const ai=dmAskAllowed();
  return (tags.includes('c')?'<span class="hlp-chip chat">chat'+(tags.includes('i')&&!ai?' \u00b7 admin here':'')+'</span>':'<span class="hlp-chip term">terminal</span>')
    +(tags.includes('i')?'<span class="hlp-chip ai">AI</span>':'')+(tags.includes('a')?'<span class="hlp-chip adm">admin</span>':'');
}
// The full guide, in the app's own help modal: every verb with where it runs, the plain-English
// phrasebook, and the keys. Opened from the ? beside the composer and from the /help card.
function openDmGuide(){
  const bg=el('helpbg'), m=el('helpmodal'); if(!bg||!m) return;
  const ai=dmAskAllowed(), on=dmCmdAllowed();
  let h=`<div class="hlp-head">Commands \u2014 what you can type here<button class="btn xtiny" id="helpclose" title="close">\u2715</button></div>`
    +`<div class="hlp-sub">Type <b>/</b> and a verb in the message box and the result posts into the conversation under your name, badged <b>computed</b> or <b>AI</b>. The same verbs run bare in the terminal (<kbd>~</kbd>). `
    +(on?'':'<b>Chat commands are switched off on this deployment</b> \u2014 the terminal still takes them. ')
    +(ai?'Plain-English questions go to the AI and post here.':'Plain-English questions are <b>admin-only in chat</b> on this deployment \u2014 ask them in the terminal instead.')+'</div>';
  for(const s of DM_CMD_GUIDE){
    h+='<div class="hlp-h">'+esc(s.h)+'</div><table class="hlp-cmd">'
      +s.rows.map(r=>'<tr><td class="c">'+esc(r[0])+'</td><td>'+esc(r[1])+'</td><td class="w">'+dmGuideChips(r[2])+'</td></tr>').join('')+'</table>';
  }
  h+='<div class="hlp-h">Plain English</div><div class="hlp-sub" style="margin-bottom:6px">Everyday phrasing maps onto the grammar locally first \u2014 free, and badged computed. What follows the arrow is what runs.</div><table class="hlp-cmd">'
    +DM_CMD_EXAMPLES.map(x=>'<tr><td class="c">/'+esc(x[0])+'</td><td>\u2192 '+esc(x[1])+'</td><td class="w"><span class="hlp-chip chat">chat</span></td></tr>').join('')+'</table>'
    +'<div class="hlp-sub" style="margin-top:8px">A result carries no price stamp and can\u2019t be edited \u2014 delete it and run it again. Errors and <b>/help</b> stay private to you.</div>'
    +HELP_KEYS;
  m.innerHTML=h; bg.hidden=false; m.hidden=false; m.scrollTop=0;
  const cb=el('helpclose'); if(cb) cb.onclick=closeHelp;
}
// /help — the short card, derived from the guide's chat rows so the two can never disagree.
function dmHelpCmd(){
  const row=(k,v)=>'<span class="amber">'+esc(tpad(k,30))+'</span>'+esc(v)+'\n';
  const ai=dmAskAllowed();
  let h='<span class="tp-hd">chat terminal</span> <span class="tp-trans">\u00b7 type / then a verb \u00b7 the result posts into this conversation under your name</span>\n';
  for(const s of DM_CMD_GUIDE) for(const r of s.rows){
    if(!r[2].includes('c')) continue;
    const k=r[0].startsWith('/')?r[0]:'/'+r[0];
    if(r[2].includes('i')&&!ai){ h+=row(k,'AI answers are admin-only in chat on this deployment \u2014 ask in the terminal (~) instead'); continue; }
    h+=row(k,r[1]);
  }
  h+='<span class="tp-trans">Tab completes verbs, fields and tickers. Results carry a computed or AI badge and can\u2019t be edited \u2014 delete and rerun. Not here: comp, basket, report, admin and every verb that changes state \u2014 those live in the terminal (~). </span><span role="button" tabindex="0" class="amber" data-dmguide="1">open the full guide \u25b8</span>';
  dmLocal(h,'help');
}
// Flatten the captured blocks to the text that becomes the message body. Badges are dropped (the
// message carries its own), <br> becomes a newline, and error blocks are kept apart so a command
// that produced nothing but an error is shown privately instead of posted.
function dmCmdText(blocks){
  const out=[], errs=[]; let ai=false, real=0;
  for(const b of blocks){
    if(b.querySelector('.tp-badge.ai')) ai=true;
    const c=b.cloneNode(true);
    c.querySelectorAll('.tp-badge').forEach(x=>x.remove());
    c.querySelectorAll('br').forEach(x=>x.replaceWith('\n'));
    const isErr=!!c.querySelector('.tp-err');
    const line=c.querySelector('.tp-line')||c;
    const txt=String(line.textContent||'').replace(/[ \t]+$/gm,'').replace(/^\n+/,'').replace(/\s+$/,'');
    if(!txt) continue;
    if(isErr) errs.push(txt); else { out.push(txt); if(c.querySelector('.tp-line')) real++; }
  }
  // The "→ screen vsma200>0" translation line is context for an answer, not an answer: with no
  // real block behind it there is nothing to post, and the error shows privately instead.
  return {text:real?out.join('\n'):'',errs:errs.join('\n'),ai:ai};
}
// /ratio in a chat posts the CHART, not a table: the same pure SVG builder the Correlation tab
// draws (ratioSvg) is rasterised to a PNG offscreen and rides the ordinary attachment path, so the
// message renders inline like any pasted screenshot. CSS variables don't resolve inside an <img>,
// so the theme colours are read off the document and substituted before drawing.
async function dmRatioChart(args){
  let a=args[0]||'', b=args[1]||'', tf=args[2];
  if(a.includes('/')){ const s=a.split('/'); a=s[0]; b=s[1]; tf=args[1]; }
  if(!a||!b) return {error:'usage: /ratio <A>/<B> [1h|4h|12h|1d] \u2014 legs are listed names or baskets'};
  tf=(tf||'4h').toLowerCase();
  if(!['1h','4h','12h','1d'].includes(tf)) return {error:'tf must be 1h \u00b7 4h \u00b7 12h \u00b7 1d'};
  if(!featureOn('baskets')&&!IS_ADMIN) return {error:'the ratio chart is not enabled for this view'};
  let d; try{ d=await fetchJSON('/api/ratio?num='+encodeURIComponent(a.toUpperCase())+'&den='+encodeURIComponent(b.toUpperCase())+'&tf='+encodeURIComponent(tf)); }
  catch(e){ return {error:'ratio fetch failed \u2014 '+(e&&e.message||'network error')}; }
  if(!d||!d.ok) return {error:(d&&d.error)||'ratio unavailable'};
  if(!d.candles||!d.candles.length) return {error:'no candles for that pair yet'};
  const cs=getComputedStyle(document.documentElement), v=n=>(cs.getPropertyValue(n)||'').trim()||null;
  const colors={}; for(const k of ['bg','panel','border','grid','text','muted','dim','accent','up','down','blue']){ const c=v('--'+k); if(c) colors[k]=c; }
  if(!d.tf) d.tf=tf;
  const S=ratioImageSvg(d,{scale:'reb',colors,tf});
  const title=`${d.num} \u00f7 ${d.den} \u00b7 ${tf.toUpperCase()} \u00b7 rebased 100${d.ema200?' \u00b7 EMA '+(d.emaSpan||200):''} \u00b7 last ${d.shown||d.candles.length}/${d.bars||d.candles.length} bars`;
  const W=S.W, H=S.H, svg=S.svg;
  const png=await new Promise((res)=>{
    const img=new Image(); const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
    img.onload=()=>{ try{ const c=document.createElement('canvas'); c.width=W*2; c.height=H*2; const g=c.getContext('2d'); g.scale(2,2); g.drawImage(img,0,0); c.toBlob(bl=>{ URL.revokeObjectURL(url); res(bl); },'image/png'); }catch(_){ URL.revokeObjectURL(url); res(null); } };
    img.onerror=()=>{ URL.revokeObjectURL(url); res(null); };
    img.src=url; });
  if(!png) return {error:'could not render the chart image'};
  const legs=[d.numBasket?'numerator is a basket (EW, synthesized hourly)':null, d.denBasket?'denominator is a basket (EW, synthesized hourly)':null].filter(Boolean);
  const last=d.candles[d.candles.length-1], first=d.candles[0];
  const chg=(first&&first.o>0&&last)?((last.c/first.o-1)*100):null;
  const body=title+(chg!=null?`\nwindow ${chg>=0?'+':''}${chg.toFixed(2)}% \u00b7 last ${last.c.toFixed(Math.abs(last.c)>=100?2:4)}`:'')+(legs.length?'\n'+legs.join(' \u00b7 '):'')+'\nintrabar extremes finer than 1H not captured';
  return {file:new File([png],`ratio-${d.num}-${d.den}-${tf}.png`,{type:'image/png'}), body:body};
}
// Tab completion in the composer (build 2026.09.11-72). The panel's own completion engine
// (termComps) supplies verbs, fields and tickers; the chat filters out what it refuses to run and
// shows the candidates in the same popup @mentions use. Tab applies the highlighted one and moves
// the highlight; Enter still SENDS, because a command you finished typing should run, not complete.
function dmComps(text){
  const body=text.replace(/^\//,'');
  const p=body.split(/\s+/), first=p.length===1;
  // A finished argument is finished: with the caret after a trailing space, Tab must not swap
  // "top funding " for "top vol " (the panel's completer rewrites the last token, and the last
  // token here is empty).
  if(!first&&p[p.length-1]==='') return [];
  let c=termComps(body);
  if(first){
    c=c.filter(x=>!DM_CMD_BLOCKED[x.split(' ')[0]]);
    const extra=['help','clear','ratio'].filter(x=>x.startsWith(p[0].toLowerCase())&&!c.includes(x));
    c=extra.concat(c);
  }else{
    const h=p[0].toLowerCase();
    if(h==='ratio'&&p.length===2){ const q=p[1].toLowerCase(), legA=q.replace(/\/.*$/,''), after=q.includes('/')?q.slice(q.indexOf('/')+1):null;
      const names=termActive().map(r=>r.ticker.toLowerCase()).concat(state.scope!=='crypto'&&state.rows.get('BTC')?['btc']:[]);
      c=after==null?names.filter(x=>x.startsWith(legA)).map(x=>'ratio '+x+'/'):names.filter(x=>x.startsWith(after)&&x!==legA).map(x=>'ratio '+legA+'/'+x); }
    if(h==='ratio'&&p.length===3) c=['1h','4h','12h','1d'].filter(x=>x.startsWith(p[2].toLowerCase())).map(x=>p.slice(0,2).join(' ')+' '+x);
    if(h==='screen'&&p.length===2) c=Object.keys(TFIELD).filter(x=>x.startsWith(p[1].toLowerCase())).map(x=>'screen '+x+'>');
    if((h==='breadth'||h==='sectors')&&p.length===2) c=['d1','d7','d30','h1','h4'].filter(x=>x.startsWith(p[1].toLowerCase())).map(x=>h+' '+x);
  }
  return [...new Set(c)].slice(0,8);
}
function dmCmdPop(ta){
  const box=el('dm-mpop'); if(!box) return false;
  const v=ta.value;
  if(!/^\/[^\/]/.test(v)&&v!=='/'){ return false; }
  if(ta.selectionStart!=null&&ta.selectionStart!==v.length){ box.hidden=true; return true; }
  const c=dmComps(v);
  if(!c.length){ box.hidden=true; return true; }
  if(dmState.compIdx>=c.length) dmState.compIdx=0;
  box.innerHTML=c.map((x,i)=>'<div class="dm-mopt'+(i===dmState.compIdx?' sel':'')+'" data-dmcomp="'+esc(x)+'"><span class="amber" style="font-family:var(--mono)">/'+esc(x)+'</span></div>').join('');
  box.hidden=false; return true;
}
function dmCompPick(x){
  const ta=el('dm-input'), box=el('dm-mpop'); if(!ta) return;
  ta.value='/'+x+(/[>\/]$/.test(x)?'':' '); ta.selectionStart=ta.selectionEnd=ta.value.length;
  dmAutoGrow(ta); dmDraftSave(dmState.sel,ta.value);
  if(box) box.hidden=true; dmState.compIdx=0; dmCmdPop(ta); ta.focus();
}
// A posted ratio chart carries a timeframe row (build 2026.09.11-74). The picture in the message is
// the record and never changes; the pills fetch the same pair at another timeframe and redraw the
// same picture LIVE in the bubble for this viewer only. The posted timeframe restores the image.
const DM_RT_TFS=['1h','4h','12h','1d'];
function dmRatioArgs(cmd){
  const p=String(cmd||'').trim().split(/\s+/); if((p[0]||'').toLowerCase()!=='ratio') return null;
  let a=p[1]||'', b=p[2]||'', tf=p[3];
  if(a.includes('/')){ const s=a.split('/'); a=s[0]; b=s[1]; tf=p[2]; }
  tf=(tf||'4h').toLowerCase(); if(!DM_RT_TFS.includes(tf)) tf='4h';
  return (a&&b)?{a:a.toUpperCase(),b:b.toUpperCase(),tf}:null;
}
function dmRatioBlock(m){
  const ra=(m.file&&m.file.inline)?dmRatioArgs(m.cmd):null;
  if(!ra) return dmFile(m);
  const live=dmState.rtLive.get(m.id);
  const pills='<div class="dm-rtf">'+DM_RT_TFS.map(t=>'<button type="button" class="cg-pill'+((live?live.tf:ra.tf)===t?' on':'')+'" data-dmrtf="'+t+'" data-mid="'+m.id+'" title="'+(t===ra.tf?'the posted timeframe':'redraw at '+t.toUpperCase()+' \u2014 for you only, nothing is posted')+'">'+t.toUpperCase()+'</button>').join('')
    +(live&&live.tf!==ra.tf?'<span class="dm-rtnote">live \u00b7 posted at '+esc(ra.tf.toUpperCase())+'</span>':'')+'</div>';
  const pic=(live&&live.tf!==ra.tf&&live.svg)?'<div class="dm-img dm-rtlive">'+live.svg+'</div>':dmFile(m);
  return pic+pills;
}
async function dmRatioSwitch(mid,tf){
  const m=dmMsgs(dmState.sel).find(x=>x.id===mid); if(!m) return;
  const ra=dmRatioArgs(m.cmd); if(!ra) return;
  if(tf===ra.tf){ dmState.rtLive.delete(mid); dmRender(); return; }
  const cur=dmState.rtLive.get(mid); if(cur&&cur.tf===tf&&cur.svg) return;
  dmState.rtLive.set(mid,{tf,svg:''}); dmRender();
  let d; try{ d=await fetchJSON('/api/ratio?num='+encodeURIComponent(ra.a)+'&den='+encodeURIComponent(ra.b)+'&tf='+encodeURIComponent(tf)); }catch(e){ d={ok:false,error:e&&e.message||'network error'}; }
  const now=dmState.rtLive.get(mid); if(!now||now.tf!==tf) return;   // the viewer moved on
  if(!d||!d.ok||!d.candles||!d.candles.length){ dmState.rtLive.delete(mid); dmRender(); dmLocal('\u2717 ratio '+esc(ra.a+'/'+ra.b+' '+tf)+' \u2014 '+esc((d&&d.error)||'no candles for that timeframe yet'),'err'); return; }
  const cs=getComputedStyle(document.documentElement), v=n=>(cs.getPropertyValue(n)||'').trim()||null;
  const colors={}; for(const k of ['bg','panel','border','grid','text','muted','dim','accent','up','down','blue']){ const c=v('--'+k); if(c) colors[k]=c; }
  d.tf=tf; const S=ratioImageSvg(d,{scale:'reb',colors,tf});
  now.svg=S.svg.replace(/^<svg([^>]*?) width="\d+" height="\d+"/,'<svg$1 width="100%" style="display:block;height:auto;border:1px solid var(--border);border-radius:6px"');
  dmRender();
}
async function dmRunCmd(raw){
  const ta=el('dm-input');
  const line=String(raw||'').replace(/^\//,'').trim();
  const t=dmThread(dmState.sel);
  if(!t){ dmState.err='say something first \u2014 commands run inside an existing conversation'; dmRender(); return; }
  // The box empties the moment the command is accepted, like the panel's: an error line below
  // repeats what was typed, so nothing is lost.
  if(ta){ ta.value=''; dmAutoGrow(ta); } dmDraftSave(dmState.sel,'');
  // /alert (build 2026.09.21-83) is server-side end to end and NOT a terminal verb: the rule lives
  // with the alerts engine every member already has, bound to THIS conversation, so it runs ahead
  // of the chat-terminal switch exactly as the server accepts it. A definition or a removal posts
  // into the thread (the room should know a watch was set); list and help come back privately.
  if(/^alert\b/i.test(line)){
    const res=await dmPost({thread:t.id,alert:line.replace(/^alert\s*/i,'')});
    if(!res.ok) return dmLocal('\u2717 '+esc(line)+' \u2014 '+esc((res.d&&res.d.error)||'could not set that alert'),'err');
    if(res.d.message){ dmMerge([res.d.message]); dmRender(); dmScrollBottom(); }
    else dmLocal(esc(res.d.text||'done').replace(/\n/g,'<br>'),'');
    return;
  }
  if(!dmCmdAllowed()) return dmLocal('terminal commands are switched off in chat on this deployment','err');
  if(!line||/^(help|\?)$/i.test(line)) return dmHelpCmd();
  if(/^clear$/i.test(line)){ dmState.localOut.delete(dmState.sel); dmRender(); return; }
  if(dmState.cmdBusy||termSink()) return dmLocal('\u2717 still running the last command \u2014 a moment','err');
  if(/^ratio\b/i.test(line)){
    dmState.cmdBusy=true; dmState.cmdLine=line; dmRender(); dmScrollBottom();
    let r; try{ r=await dmRatioChart(line.split(/\s+/).slice(1)); }catch(e){ r={error:'ratio failed \u2014 '+(e&&e.message||e)}; }
    finally{ dmState.cmdBusy=false; dmState.cmdLine=''; }
    if(r.error) return dmLocal('\u2717 '+esc(line)+' \u2014 '+esc(r.error),'err');
    const up=await dmUpload(t.id,r.file);
    if(!up.ok) return dmLocal('\u2717 '+esc(line)+' \u2014 '+esc(up.error||'could not attach the chart'),'err');
    const res=await dmPost({thread:t.id,body:r.body,cmd:line,fileId:up.id});
    if(!res.ok){ const e=res.d&&res.d.error; return dmLocal('\u2717 '+esc(line)+' \u2014 '+esc(e==='feature-gated'?'terminal commands are switched off in chat on this deployment':(e||'could not post the chart')),'err'); }
    if(res.d.message) dmMerge([res.d.message]);
    await dmLoad();
    if(dmState.sel){ try{ const h=await fetchJSON('/api/dm/'+dmState.sel); if(h&&h.ok){ dmMerge(h.messages); if(h.info){ h.info.more=!!h.more; dmState.info.set(dmState.sel,h.info); } } }catch(_){ } }
    dmRender(); dmScrollBottom(); return;
  }
  // Resolve exactly as the panel does: complete grammar runs as typed, local NL maps to grammar,
  // anything else is a question for the AI. Blocked verbs are answered before anything runs.
  const p=line.split(/\s+/); let cmd=null, mapped='';
  if(/^admin\b/i.test(line)) cmd=line;
  else if(termGrammarComplete(p)) cmd=line;
  else { const nl=nlResolve(line); if(nl){ cmd=nl; mapped=nl; } }
  // The panel redacts a password in its echo; the private error line here does the same — it is
  // only the sender's screen, but a secret sitting in the DOM is a secret in a screenshot.
  const shown=line.replace(/^(admin\s+(?:unlock|reset-reports))\s+\S+.*$/i,'$1 \u2022\u2022\u2022\u2022\u2022\u2022');
  if(cmd){ const why=dmCmdCheck(cmd); if(why) return dmLocal('\u2717 '+esc(shown)+' \u2014 '+esc(why),'err'); }
  else if(!dmAskAllowed()) return dmLocal('\u2717 '+esc(line)+' \u2014 the grammar didn\u2019t understand that, and AI answers are admin-only in chat on this deployment. /help lists what runs here; the terminal (~) takes questions.','err');
  const ai=dmAskAllowed();
  dmState.cmdBusy=true; dmState.cmdLine=line; dmRender(); dmScrollBottom();
  const sink={blocks:[],ai:ai,via:'dm',check:dmCmdCheck}; termSetSink(sink);
  try{
    if(cmd){ termHistPush(line,mapped?'\u2192 '+mapped+' (computed locally)':line); if(mapped) termOutTrans(mapped); await termExec(cmd); }
    else await termAsk(line);
  }catch(e){ termErr('failed \u2014 '+(e&&e.message||e)); }
  finally{ termSetSink(null); dmState.cmdBusy=false; dmState.cmdLine=''; }
  const r=dmCmdText(sink.blocks);
  if(!r.text){ dmLocal('\u2717 '+esc(line)+(r.errs?' \u2014 '+esc(r.errs.replace(/^\u2717\s*/gm,'')):' \u2014 nothing to post'),'err'); return; }
  const body=r.text.length>dmState.maxLen?r.text.slice(0,dmState.maxLen-2)+'\u2026':r.text;
  const res=await dmPost({thread:t.id,body:body,cmd:line,cmdAi:!cmd||r.ai});
  if(res.ok){
    if(res.d.message) dmMerge([res.d.message]);
    await dmLoad();
    if(dmState.sel){ try{ const h=await fetchJSON('/api/dm/'+dmState.sel); if(h&&h.ok){ dmMerge(h.messages); if(h.info){ h.info.more=!!h.more; dmState.info.set(dmState.sel,h.info); } } }catch(_){ } }
    if(r.errs) dmLocal(esc(r.errs),'err');   // a partial answer posts; what failed stays private
    dmRender(); dmScrollBottom();
  }else{
    const e=res.d&&res.d.error;
    dmLocal('\u2717 '+esc(line)+' \u2014 '+esc(e==='feature-gated'?(res.d.feature==='dm.ask'?'AI answers are admin-only in chat on this deployment':'terminal commands are switched off in chat on this deployment'):(e||'could not post the result')),'err');
  }
}

async function dmUpload(threadId,file){
  if(file.size>dmState.maxFile) return {ok:false,error:'that file is too large (8 MB maximum)'};
  const b64=await new Promise((res,rej)=>{
    const fr=new FileReader();
    fr.onload=()=>{ const s=String(fr.result||''); res(s.slice(s.indexOf(',')+1)); };
    fr.onerror=()=>rej(new Error('could not read that file'));
    fr.readAsDataURL(file);
  }).catch(()=>null);
  if(b64==null) return {ok:false,error:'could not read that file'};
  try{
    const r=await fetch('/api/dm/upload',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({thread:threadId,name:file.name,data:b64})});
    const d=await r.json().catch(()=>({}));
    return (r.ok&&d.ok)?{ok:true,id:d.file.id}:{ok:false,error:d.error||'upload failed'};
  }catch(_){ return {ok:false,error:'upload failed'}; }
}

// A draft outlives a reload. dmCapture/dmRestore keep it across a re-render; this keeps it across
// a refresh, a tab switch and a browser restart — the same localStorage the layouts use.
const DM_DRAFT_KEY='xyz-dm-drafts';
function dmDrafts(){ try{ return JSON.parse(localStorage.getItem(DM_DRAFT_KEY)||'{}')||{}; }catch(_){ return {}; } }
// The stamp preview: the mark and the side a $TICKER will carry, read from the live board before
// the message is sent — the direction rule used to be discoverable only from the sent card.
function dmStampPreview(text){
  const pv=el('dm-stamppv'); if(!pv) return;
  const m=String(text||'').match(/\$([A-Za-z][A-Za-z0-9.\-]{0,9})/); const r=m&&typeof termFind==='function'?termFind(m[1]):null;
  if(!r){ pv.hidden=true; return; }
  const up=String(text).toUpperCase(), i=up.indexOf('$'+m[1].toUpperCase());
  const before=up.slice(Math.max(0,i-24),i), after=up.slice(i+m[1].length+1,i+m[1].length+13);
  const short=/\b(SHORT|SELL|FADE)\b/.test(before)||/\b(SHORT|PUTS)\b/.test(after);
  pv.hidden=false; pv.innerHTML='will stamp <b>'+esc(r.ticker)+'</b> at <b>'+fmtPrice(r.px)+'</b> as <b class="'+(short?'neg':'pos')+'">'+(short?'short':'long')+'</b> <span class="sec">('+(short?'because of the word before it':'write short / sell / fade before the ticker for a short')+')</span>';
}
function dmDraftSave(id,text){
  if(!id) return;
  try{ const d=dmDrafts();
    if(text&&text.trim()) d[id]=text; else delete d[id];
    localStorage.setItem(DM_DRAFT_KEY,JSON.stringify(d)); }catch(_){ }
}
function dmDraftGet(id){ return (dmDrafts()||{})[id]||''; }

let _dmTypedAt=0;
function dmTypingPing(){
  // One ping every three seconds while typing. Any faster turns a quiet stream into a chatty one
  // for a hint nobody is reading closely.
  const now=Date.now();
  if(!dmState.sel||now-_dmTypedAt<3000) return;
  _dmTypedAt=now;
  fetch('/api/dm',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({thread:dmState.sel,typing:true})}).catch(()=>{});
}

async function dmStartWith(uid){
  const existing=dmState.threads.find(t=>t.peer===uid);
  if(existing){
    dmState.picking=false;
    // Picking a person whose conversation you closed reopens it — history and all.
    if(existing.hidden){ await dmPost({reopen:existing.id}); await dmLoad(); }
    dmOpenThread(existing.id); return;
  }
  // No thread until there is a message: an empty conversation in the rail is a row that says
  // nothing happened. The composer targets the member directly and the thread appears on send.
  dmState.picking=false; dmState.sel=null; dmState.pendingPeer=uid; dmState.results=null; dmRenderNow();
  const ta=el('dm-input'); if(ta) ta.focus();
}

async function dmToggleMute(){
  const t=dmThread(dmState.sel); if(!t) return;
  const res=await dmPost({thread:t.id,mute:!t.muted});
  if(res.ok){ t.muted=!t.muted; dmUpdatePip(); dmRender(); }
}
async function dmToggleBoardNotify(){
  const t=dmThread(dmState.sel); if(!t) return;
  const res=await dmPost({thread:t.id,boardNotify:!t.boardNotify});
  if(res.ok){ t.boardNotify=!t.boardNotify; dmRender(); }
}
async function dmToggleTgSync(){
  const t=dmThread(dmState.sel); if(!t||!dmState.meTg) return;
  const res=await dmPost({thread:t.id,tgSync:!t.tgSync});
  // The server keeps ONE synced conversation per member, so every other row flips off locally
  // too — the rail must agree with the server without a reload.
  if(res.ok){ for(const x of dmState.threads) x.tgSync=false; t.tgSync=!!(res.d&&res.d.tgSync); dmState.err=''; }
  else dmState.err=(res.d&&res.d.error)||'could not change Telegram sync';
  dmRender();
}

// ---- @mention autocomplete ---------------------------------------------------------------------
// A trailing "@prefix" at the caret pops the member list; Enter/Tab or a click completes it.
// Mentions already pierce mutes and jump the Telegram queue — this makes them typo-proof.
function dmMentionPop(ta){
  const box=el('dm-mpop'); if(!box) return;
  const pos=ta.selectionStart==null?ta.value.length:ta.selectionStart;
  const m=/(^|\s)@([A-Za-z0-9._-]{0,24})$/.exec(ta.value.slice(0,pos));
  if(!m){ box.hidden=true; return; }
  const q=m[2].toLowerCase();
  const opts=(dmState.members||[]).filter(u=>
    String(u.handle||'').toLowerCase().startsWith(q)||String(u.display||'').toLowerCase().startsWith(q)).slice(0,6);
  if(!opts.length){ box.hidden=true; return; }
  box.innerHTML=opts.map(u=>'<div class="dm-mopt" data-dmmention="'+esc(u.handle)+'">'
    +'<b style="color:'+dmNameColor(u.uid)+'">'+esc(u.display)+'</b> <span class="acc-mu">@'+esc(u.handle)+'</span></div>').join('');
  box.hidden=false;
}
function dmMentionPick(handle){
  const ta=el('dm-input'), box=el('dm-mpop'); if(box) box.hidden=true;
  if(!ta) return;
  const pos=ta.selectionStart==null?ta.value.length:ta.selectionStart;
  const upto=ta.value.slice(0,pos);
  const m=/(^|\s)@([A-Za-z0-9._-]{0,24})$/.exec(upto);
  if(!m) return;
  const start=upto.length-m[2].length;
  ta.value=ta.value.slice(0,start)+handle+' '+ta.value.slice(pos);
  dmAutoGrow(ta);
  const caret=start+String(handle).length+1;
  ta.focus(); try{ ta.setSelectionRange(caret,caret); }catch(_){}
  if(!dmState.editing) dmDraftSave(dmState.sel,ta.value); dmStampPreview(ta.value);
}

// ---- browser push ------------------------------------------------------------------------------
// The offline escalation's browser leg: subscriptions live per account on the server, payloads
// are built by the same sweep that feeds Telegram, and this side only turns the permission
// handshake into one button. State is probed from the live subscription, never assumed.
function dmB64ToU8(str){ const pad='='.repeat((4-str.length%4)%4);
  const b=atob((str+pad).replace(/-/g,'+').replace(/_/g,'/'));
  const a=new Uint8Array(b.length); for(let i=0;i<b.length;i++) a[i]=b.charCodeAt(i); return a; }
function dmPushCapable(){ return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification!=='undefined'; }
async function dmPushProbe(){
  if(!dmPushCapable()) return;
  try{
    const reg=await navigator.serviceWorker.getRegistration(); if(!reg) return;
    const sub=await reg.pushManager.getSubscription();
    const on=!!sub&&Notification.permission==='granted';
    if(on!==dmState.webPushOn){ dmState.webPushOn=on; if(state.view==='dm') dmRender(); }
  }catch(_){}
}
async function dmPushEnable(){
  if(!dmPushCapable()){ pushToast('this browser cannot do notifications'); return; }
  try{
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){ pushToast('notifications are blocked for this site — allow them in the browser first'); return; }
    const reg=await navigator.serviceWorker.ready;
    const k=await fetchJSON('/api/dm/push-key');
    if(!k||!k.ok){ pushToast('push is not configured on this server'); return; }
    const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:dmB64ToU8(k.key)});
    const r=await fetch('/api/dm/push-sub',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sub:sub.toJSON()})});
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d&&d.ok){ dmState.webPushOn=true; pushToast('🔔 browser notifications on — unread messages reach this device even with the tab closed'); dmRender(); }
    else pushToast('could not register — '+((d&&d.error)||'server error'));
  }catch(_){ pushToast('could not enable notifications'); }
}
async function dmPushDisable(){
  try{
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.getSubscription();
    if(sub){ try{ await fetch('/api/dm/push-sub',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({remove:sub.endpoint})}); }catch(_){}
      await sub.unsubscribe(); }
    dmState.webPushOn=false; dmRender();
  }catch(_){ dmState.webPushOn=false; dmRender(); }
}

// ---- voice notes -------------------------------------------------------------------------------
// One button: press to record, press to stop; the note lands as the pending attachment, sent like
// any file. The server verifies the container by magic bytes and caps audio at 3 MB.
let _dmRec=null,_dmRecT0=0,_dmRecTimer=null;
async function dmMicToggle(){
  if(_dmRec){ try{ _dmRec.stop(); }catch(_){} return; }
  if(!navigator.mediaDevices||!window.MediaRecorder){ pushToast('Voice notes need microphone support in this browser'); return; }
  let stream;
  try{ stream=await navigator.mediaDevices.getUserMedia({audio:true}); }
  catch(_){ pushToast('Microphone permission denied — allow it in the browser to record'); return; }
  const mime=MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus'
    :(MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported('audio/mp4')?'audio/mp4':'');
  let rec;
  try{ rec=new MediaRecorder(stream, mime?{mimeType:mime}:undefined); }
  catch(_){ stream.getTracks().forEach(tr=>tr.stop()); pushToast('Recording is not supported here'); return; }
  const chunks=[];
  rec.ondataavailable=(e)=>{ if(e.data&&e.data.size) chunks.push(e.data); };
  rec.onstop=()=>{
    stream.getTracks().forEach(tr=>tr.stop());
    clearInterval(_dmRecTimer); _dmRecTimer=null; _dmRec=null;
    dmMicPaint();
    const type=rec.mimeType||mime||'audio/webm';
    const blob=new Blob(chunks,{type});
    if(blob.size<200) return;   // a tap, not a take
    const ext=/mp4/.test(type)?'m4a':(/ogg/.test(type)?'ogg':'webm');
    const name='voice-'+new Date().toISOString().slice(11,19).replace(/:/g,'')+'.'+ext;
    try{ dmState.pendingFile=new File([blob],name,{type}); }
    catch(_){ dmState.pendingFile=blob; dmState.pendingFile.name=name; }
    dmState.err=''; dmRender();
  };
  _dmRec=rec; _dmRecT0=Date.now();
  rec.start();
  dmMicPaint();
  _dmRecTimer=setInterval(dmMicPaint,1000);
}
function dmMicPaint(){
  const btn=el('dm-mic'); if(!btn) return;
  if(_dmRec){ btn.classList.add('rec'); btn.textContent='■'+Math.floor((Date.now()-_dmRecT0)/1000); btn.title='Stop recording'; }
  else { btn.classList.remove('rec'); btn.textContent='🎙'; btn.title='Record a voice note (3 MB max)'; }
}
// Close: off YOUR rail, history intact — the row comes back when either side writes again.
async function dmCloseThread(){
  const t=dmThread(dmState.sel); if(!t) return;
  const res=await dmPost({close:t.id});
  if(res.ok){ dmState.sel=null; await dmLoad(); dmRender(); }
}
// Clear: forget the backscroll for YOU — the local cache goes with it, or the render would keep
// showing history the server no longer serves this account.
async function dmClearHistory(){
  const t=dmThread(dmState.sel); if(!t) return;
  if(!confirm('Clear this conversation’s history for you? The other side keeps theirs, and the operator record is untouched. This cannot be undone.')) return;
  const res=await dmPost({clearHistory:t.id});
  if(res.ok){ dmState.msgs.delete(t.id); dmState.sel=null; await dmLoad(); dmRender(); }
}
async function dmDrop(id){
  if(!confirm('Delete this message? The other side sees that it was deleted.')) return;
  const res=await dmPost({id:id,drop:true});
  if(res.ok&&res.d.message){ dmMerge([res.d.message]); dmRender(); }
}
function dmEdit(id){
  const m=dmMsgs(dmState.sel).find(x=>x.id===id); if(!m) return;
  dmState.editing=id;
  const ta=el('dm-input'); if(ta){ ta.value=m.body; dmAutoGrow(ta); ta.focus(); }
  dmRender();
}
async function dmWatch(coin,on){
  const res=await dmPost({watch:coin,on:on});
  if(res.ok){ dmState.watching=res.d.watching||[]; dmState.watchAdd=false; dmRender(); }
  else { dmState.err=(res.d&&res.d.error)||'could not change that'; dmRender(); }
}
async function dmPin(id,on){
  const res=await dmPost({pin:id,on:on});
  if(res.ok&&res.d.message){ dmMerge([res.d.message]); await dmLoad(); dmRender(); }
}
async function dmToNote(id){
  const res=await dmPost({toNote:true,id:id});
  if(res.ok) alert('Promoted to a note, keeping the price and time it was called at.');
  else alert((res.d&&res.d.error)||'could not promote that');
}
async function dmOpenCalls(){
  dmState.mode='calls'; dmState.results=null; dmRender();
  try{ await dmFetchCalls(); dmRender(); }
  catch(_){ dmState.calls={calls:[],summary:[]}; dmRender(); }
}
async function dmReact(id,emoji){
  const res=await dmPost({react:true,id:id,emoji:emoji});
  if(res.ok&&res.d.message){ dmMerge([res.d.message]); dmRender(); }
}

// ---- groups --------------------------------------------------------------------------------------
async function dmNewGroup(){
  const picked=[...document.querySelectorAll('.dm-gpick:checked')].map(i=>i.value);
  const title=(el('dm-gtitle')||{}).value||'';
  if(!title.trim()){ dmState.err='give the group a name'; dmRender(); return; }
  if(!picked.length){ dmState.err='a group needs somebody else in it'; dmRender(); return; }
  const res=await dmPost({group:true,title:title,members:picked});
  if(res.ok){ dmState.picking=false; await dmLoad(); dmOpenThread(res.d.thread); }
  else { dmState.err=(res.d&&res.d.error)||'could not create the group'; dmRender(); }
}
async function dmGroupOp(body,confirmText){
  if(confirmText&&!confirm(confirmText)) return;
  const res=await dmPost(body);
  if(res.ok){
    await dmLoad();
    if(body.leave){ dmState.sel=null; dmState.manage=false; dmRender(); return; }
    if(dmState.sel){ try{ const h=await fetchJSON('/api/dm/'+dmState.sel);
      if(h&&h.ok){ dmMerge(h.messages); dmState.info.set(dmState.sel,h.info); } }catch(_){ } }
    dmRender();
  }else{ dmState.err=(res.d&&res.d.error)||'that did not work'; dmRender(); }
}

// ---- search ----------------------------------------------------------------------------------------
let _dmSearchTimer=null;
function dmSearchInput(v){
  dmState.q=v;
  clearTimeout(_dmSearchTimer);
  if(!v.trim()){ dmState.results=null; dmRender(); return; }
  _dmSearchTimer=setTimeout(dmRunSearch,250);
}
async function dmRunSearch(){
  const q=dmState.q.trim();
  if(q.length<2){ dmState.results=null; dmRender(); return; }
  dmState.searching=true; dmRender();
  try{
    const scoped=dmState.searchScope==='thread'&&dmState.sel?'&thread='+encodeURIComponent(dmState.sel):'';
    const d=await fetchJSON('/api/dm/search?q='+encodeURIComponent(q)+scoped);
    if(q!==dmState.q.trim()) return;   // the box moved on: "nv" must not land under the "nvda" header
    dmState.results=(d&&d.ok)?d.results:[];
  }catch(_){ if(q!==dmState.q.trim()) return; dmState.results=[]; }
  dmState.searching=false; dmRender();
}

function dmScrollBottom(){ const l=el('dm-log'); if(l) l.scrollTop=l.scrollHeight; }
// Entering the tab (build 2026.09.11-76): the log box scrolls to its bottom, but on a narrow screen
// the panel is height:auto and the PAGE scrolls too — the composer sat below the fold with the
// rail in view. Bring the composer into view, and only when it is out of view, so a desktop
// layout that already fits is never yanked.
function dmPageToComposer(){
  const ta=el('dm-input'); if(!ta) return;
  const r=ta.getBoundingClientRect(), vh=window.innerHeight||document.documentElement.clientHeight;
  if(r.bottom>vh-8) window.scrollBy({top:r.bottom-vh+12,left:0,behavior:'auto'});
}

// ---- rendering ---------------------------------------------------------------------------------
function dmWhen(ts){
  try{
    const d=new Date(ts), now=new Date();
    const sameDay=d.toDateString()===now.toDateString();
    return sameDay ? d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false})
                   : d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '
                     +d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
  }catch(_){ return ''; }
}
// Bare clock time — the day is carried by the divider above the run, so repeating it per message
// would be noise. dmWhen stays for the rail and search results, which have no divider context.
function dmTime(ts){ try{ return new Date(ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}); }catch(_){ return ''; } }
function dmSameDay(a,b){ try{ return new Date(a).toDateString()===new Date(b).toDateString(); }catch(_){ return true; } }
function dmDayLabel(ts){
  try{
    const d=new Date(ts), now=new Date();
    if(d.toDateString()===now.toDateString()) return 'today';
    if(d.toDateString()===new Date(now.getTime()-864e5).toDateString()) return 'yesterday';
    return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  }catch(_){ return ''; }
}
// The price stamp. refPx is what the market showed when the message was sent and never changes;
// px is read live at render. The move between them is the entire reason this feature exists, so
// it is computed here and nowhere else.
// Display name for a stamped market: the "xyz:" universe prefix is routing, not information —
// the card already said $HOOD in the body, repeating it as xyz:HOOD reads as a different thing.
function dmTkName(ref){ return String(ref||'').replace(/^xyz:/,''); }
function dmStamp(m){
  if(!m.ref) return '';
  const at=m.refPx, now=m.px;
  const has=at!=null&&isFinite(at)&&at>0;
  const live=now!=null&&isFinite(now)&&now>0;
  const chg=(has&&live)?(now/at-1):null;
  // The stamp knows its direction: the % shown stays the RAW price move, but the color says
  // whether the CALL is winning \u2014 a short that falls paints green.
  const side=m.side==='short'?'short':'long';
  const adj=chg==null?null:(side==='short'?-chg:chg);
  const cls=adj==null?'':(adj>0?'pos':(adj<0?'neg':'sec'));
  const right=chg==null?'<span class="dm-tk-d sec" title="this market is no longer listed">\u2014</span>'
    :'<span class="dm-tk-d '+cls+'" title="price move since sent \u2014 colored by whether the '+side+' is right">'+(chg>0?'+':'')+(chg*100).toFixed(1)+'%</span>';
  const dirChip=has?' <span class="dm-dir '+(side==='short'?'neg':'pos')+'" title="read from the words around the ticker \u2014 short/sell/fade before it (or short/puts after) makes it a short; everything else is a long. One word in the message fixes a miscall.">'+(side==='short'?'\u25bc short':'\u25b2 long')+'</span>':'';
  const bell=has?' <button type="button" class="dm-tool dm-tkbell" data-dmalert="'+esc(m.ref)+'" data-px="'+at+'" title="arm a price alert at the stamp ('+fmtPx(at)+') \u2014 fires when the market crosses back through the level this call was made at">\u2691 alert</button>':'';
  const sub=has?('sent at '+fmtPx(at)+(live?' \u00b7 now '+fmtPx(now):' \u00b7 no longer listed')):'no mark at send';
  // The card is a door, not just a label: clicking it opens the market drawer for the name \u2014
  // same in-place drawer the earnings rows and news badges use, so no tab switch.
  return '<div role="button" tabindex="0" class="dm-tk" data-coin="'+esc(m.ref)+'" title="open the '+esc(dmTkName(m.ref))+' drawer"><div><div class="dm-tk-s">'+esc(dmTkName(m.ref))+dirChip+'</div>'
    +'<div class="dm-tk-m">'+esc(sub)+bell+'</div></div>'+right+'</div>';
}
// One tap on a stamp arms a "back to the level" alert: crossing DOWN through the stamp when the
// market sits above it, UP when below \u2014 the retest/reclaim of the price the call was made at.
async function dmArmCallAlert(coin, refPx){
  if(!isFinite(refPx)||refPx<=0) return;
  const r=state.rows.get(coin);
  const cur=r&&isFinite(r.px)&&r.px>0?r.px:null;
  const op=cur!=null&&cur>=refPx?'cross_dn':'cross_up';
  try{
    const res=await fetch('/api/alerts/rules',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({metric:'px',op:op,value:refPx,coin:coin,note:'call retest'})});
    const d=await res.json().catch(()=>({}));
    if(res.ok&&d&&d.ok!==false){ pushToast('\u2691 alert armed \u2014 '+(r?r.ticker:dmTkName(coin))+' crossing '+(op==='cross_dn'?'\u2193':'\u2191')+' '+fmtPx(refPx)); loadRules(); }
    else pushToast('could not arm that alert'+(d&&d.error?' \u2014 '+d.error:''));
  }catch(_){ pushToast('could not arm that alert'); }
}
function fmtPx(v){ return fmtPrice(v); }   // one price formatter: HOOD read 45.123 in the drawer and 45.12 on the stamp
function fmtBytes(n){
  if(!isFinite(n)) return '';
  if(n<1024) return n+' B';
  if(n<1024*1024) return (n/1024).toFixed(0)+' KB';
  return (n/1048576).toFixed(1)+' MB';
}
// An attachment renders inline ONLY when the server verified it as a raster image by its magic
// bytes. Anything else is a download chip — the server forces the disposition too, so this is the
// second of two locks, not the only one.
function dmFile(m){
  if(!m.file) return '';
  const url='/api/dm/file/'+encodeURIComponent(m.file.id);
  if(/^audio\//.test(m.file.mime||''))
    return '<span class="dm-aud">🎙 <audio controls preload="none" src="'+esc(url)+'"></audio></span>';
  if(m.file.inline)
    return '<a class="dm-img" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'
      +'<img src="'+esc(url)+'" alt="'+esc(m.file.name)+'" loading="lazy"></a>';
  return '<a class="dm-att" href="'+esc(url)+'" rel="noopener noreferrer">'
    +'<span class="dm-att-i">↓</span><span class="dm-att-n">'+esc(m.file.name)+'</span>'
    +'<span class="dm-att-s">'+esc(fmtBytes(m.file.size))+'</span></a>';
}
// The tweet card. Server-parsed fields only, escaped here like any user-authored text — X's embed
// HTML never reaches this client. $CASHTAGS inside the tweet pick up the terminal's accent, tying
// the card to the board's own vocabulary. tweet === null means no link (or still fetching: the
// card paints on the refresh poke); {ok:false} is a real failure and gets the honest stub.
function dmTweet(m){
  const t=m.tweet;
  if(!t) return '';
  if(!t.ok) return '<span class="dm-x dead"><span class="dm-x-h"><span class="dm-x-logo">𝕏</span>'
    +'<span class="dm-x-deadt">preview unavailable — deleted, protected, or X didn’t answer. The link still works.</span></span></span>';
  const cash=(html)=>html.replace(/(^|[\s>])\$([A-Za-z]{1,6})(?![A-Za-z])/g,(a,p,s)=>p+'<span class="dm-x-cash">$'+s+'</span>');
  return '<a class="dm-x" href="'+esc(t.url)+'" target="_blank" rel="noopener noreferrer">'
    +'<span class="dm-x-h"><span class="dm-x-logo">𝕏</span>'
    +'<span class="dm-x-who">'+esc(t.author||t.handle||'—')+'</span>'
    +'<span class="dm-x-at">'+esc((t.handle?'@'+t.handle:'')+(t.when?(t.handle?' · ':'')+t.when:''))+'</span></span>'
    +(t.text?'<span class="dm-x-t">'+cash(esc(t.text)).replace(/\n/g,'<br>')+'</span>':'')
    +(t.img?'<img class="dm-x-img" src="'+esc(t.img)+'" alt="" loading="lazy">':'')
    +'<span class="dm-x-f">'+((t.media&&!t.img)?'<span class="dm-x-media">🖼 media attached</span>':'')
    +'<span class="dm-x-open">open on X ↗</span></span></a>';
}

function dmReactions(m){
  const r=m.reactions;
  const chips=[];
  if(r) for(const e of Object.keys(r))
    chips.push('<button type="button" class="dm-rx'+(r[e].mine?' mine':'')+'" data-dmrx="'+m.id+'" data-emoji="'+esc(e)+'"'
      +' title="'+esc(r[e].who.join(', '))+'">'+esc(e)+' '+r[e].n+'</button>');
  // Chips only, and only when somebody has actually reacted — an always-present picker row
  // reserved a blank line under every message, which is where most of the old layout's air came
  // from. The picker lives in the hover action bar now.
  return chips.length?'<div class="dm-rxrow">'+chips.join('')+'</div>':'';
}

// Deterministic per-person color for group and topic rooms: the uid hashes to a palette picked to
// stay legible on the dark ground, so a member keeps their color across every conversation and
// every device — nothing is stored, nothing can drift.
const DM_NAME_COLORS=['#E3A53C','#5CC8FF','#46B97E','#E5604D','#C792EA','#F2C14E','#6ED3CF','#F28FAD','#9CCC65','#7E9CD8'];
function dmNameColor(key){ let h=0; const s=String(key||''); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return DM_NAME_COLORS[h%DM_NAME_COLORS.length]; }

// One message. `p` is the message rendered above it: a run from the same sender inside five
// minutes groups chat-app style — the name/time header paints once at the head of the run and
// the bubbles underneath sit tight. A grouped bubble keeps its exact time in a hover tooltip.
function dmMessageHtml(m,t,p){
  if(m.sys) return '<div class="dm-sys">'+esc(dmSysLine(m,t))+'</div>';
  const own=m.mine;
  const who=own?'you':(m.sender||'\u2014');
  const head=!p||p.sys||p.mine!==m.mine||p.sender!==m.sender||(m.ts-p.ts)>5*60e3||!dmSameDay(p.ts,m.ts);
  // Own messages carry only the time: they sit right-aligned in their own color, so "you" was
  // saying what the layout already says.
  const meta=head?'<div class="dm-meta">'+(own?'':(t&&t.kind!=='dm'
    ?'<b class="dm-who" style="color:'+dmNameColor(m.senderUid||m.sender)+'">'+esc(who)+'</b> \u00b7 '
    :esc(who)+' \u00b7 '))+dmTime(m.ts)+'</div>':'';
  // Pinning is any member's; editing and deleting are the author's; promoting a call to a note is
  // the operator's, because the notes book itself is operator-only. All of it — the reaction
  // picker included — lives in a hover action bar over the bubble, so a message at rest is
  // just its bubble.
  const act=m.deleted?'':'<span class="dm-act">'
    +'<span class="dm-rxadd"><button type="button" class="dm-tool" data-dmrxopen="'+m.id+'" title="React">+</button>'
      +'<span class="dm-rxmenu">'+dmState.reactions.map(e=>
        '<button type="button" class="dm-rxopt" data-dmrx="'+m.id+'" data-emoji="'+esc(e)+'">'+esc(e)+'</button>').join('')+'</span></span>'
    +'<button type="button" class="dm-tool" data-dmreply="'+m.id+'" title="Quote this message in your reply">reply</button>'
    +'<button type="button" class="dm-tool" data-dmpin="'+m.id+'" data-on="'+(m.pinned?'0':'1')+'" title="'+(m.pinned?'Unpin':'Pin this to the top of the conversation')+'">'+(m.pinned?'unpin':'pin')+'</button>'
    +((m.ref&&m.refPx!=null&&dmState.admin)?'<button type="button" class="dm-tool" data-dmnote="'+m.id+'" title="Write this into the notes book, keeping the price and time it was called at">\u2192 note</button>':'')
    +(own?(m.cmd?'':'<button type="button" class="dm-tool" data-dmedit="'+m.id+'" title="Edit \u2014 the price stamp stays at what it was sent at">edit</button>')
      +'<button type="button" class="dm-tool" data-dmdel="'+m.id+'" title="Delete \u2014 this removes the attachment too">delete</button>':'')
    +'</span>';
  // Edited / via-telegram ride inside the bubble as a faint suffix: the header line is gone on
  // grouped messages, so anything that lived only there would vanish with it.
  const marks=m.deleted?'':((m.via==='telegram'?'<span class="dm-mk" title="sent from Telegram">tg</span>':'')
    +(m.edited?'<span class="dm-mk">edited</span>':''));
  // The quote a reply carries: one line of what it answers, clickable back to the original.
  const quote=(!m.deleted&&m.reply)
    ? '<div class="dm-quote" data-dmq="'+m.replyTo+'" title="jump to the quoted message"><b style="color:'+dmNameColor(m.reply.senderUid||m.reply.sender)+'">'+esc(m.reply.sender||'\u2014')+'</b> '
      +esc(m.reply.deleted?'message deleted':((m.reply.ref?'$'+dmTkName(m.reply.ref)+' \u00b7 ':'')+(m.reply.body||'attachment'))).replace(/\n/g,' ')+'</div>'
    : '';
  const body=m.deleted
    ? '<div class="dm-b dm-del">message deleted</div>'
    : m.cmd
    // A command result: the command as a header with the engine's badge, the output as a
    // monospace block so the panel's padded columns line up. No stamp, no tweet, no quote —
    // it is the board's output under a name, not a message about anything.
    ? '<div class="dm-b dm-cmdb" title="'+esc(who+' \u00b7 '+dmWhen(m.ts))+'"><div class="dm-cmdhd"><span class="dm-cmdpr">\u25b8</span> '+esc(m.cmd)
      +' <span class="tp-badge '+(m.cmdAi?'ai':'c')+'">'+(m.cmdAi?'AI':'computed')+'</span></div>'+dmRatioBlock(m)+'<pre class="dm-cmdout">'+esc(m.body)+'</pre>'+marks+'</div>'
    : '<div class="dm-b" title="'+esc(who+' \u00b7 '+dmWhen(m.ts))+'">'+quote
      +(m.body?dmMentionHtml(esc(m.body)).replace(/\n/g,'<br>'):'')+marks+dmFile(m)+dmStamp(m)+dmTweet(m)+'</div>';
  return '<div class="dm-msg'+(own?' out':'')+(head?' hd':'')+(m.cmd&&!m.deleted?' cmd':'')+'" data-mid="'+m.id+'">'+meta
    +body+act+(m.deleted?'':dmReactions(m))+'</div>';
}
// @handle rendered as a mention chip, YOURS in the loud style \u2014 the visual half of the escalation
// rule that lets your own handle pierce a muted thread. Runs over already-escaped HTML; the handle
// alphabet contains nothing esc() rewrites.
function dmMentionHtml(html){
  const me=dmState.me&&dmState.me.handle?String(dmState.me.handle).toLowerCase():'';
  return String(html).replace(/(^|[\s>])@([A-Za-z0-9._-]{2,24})/g,(a,pre,h)=>
    pre+'<span class="dm-mention'+(me&&h.toLowerCase()===me?' me':'')+'">@'+h+'</span>');
}
function dmMentionsMe(body){
  const me=dmState.me&&dmState.me.handle; if(!me) return false;
  const h=String(me).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp('(^|[^A-Za-z0-9._-])@'+h+'(?![A-Za-z0-9._-])','i').test(String(body||''));
}
function dmSysLine(m,t){
  const who=m.mine?'you':(m.sender||'someone');
  if(m.sys==='created') return who+' created “'+m.body+'”';
  if(m.sys==='added') return who+' added '+m.body;
  if(m.sys==='removed') return who+' removed '+m.body;
  if(m.sys==='left') return m.body+' left';
  if(m.sys==='joined') return m.body+' joined';
  if(m.sys==='renamed') return who+' renamed this to “'+m.body+'”';
  return '';
}

function dmRailHtml(){
  // Boards live in their own "Topics" section below — the conversations rail is people. Closed
  // conversations fold into their own row: closing never deletes anything, so there must always
  // be a road back that doesn't depend on somebody writing first.
  const all=dmState.threads.filter(t=>t.kind!=='board');
  const list=all.filter(t=>!t.hidden), closed=all.filter(t=>t.hidden);
  const closedSec=closed.length
    ? '<div class="dm-sh" id="dm-closedhd" style="margin-top:10px;cursor:pointer">'
      +(dmState.showClosed?'▾':'▸')+' Closed — '+closed.length+'</div>'
      +(dmState.showClosed?closed.map(t=>'<div role="button" tabindex="0" class="dm-th" data-dmreopen="'+t.id+'">'
        +'<div class="dm-thn">'+(t.kind==='group'?'<span class="dm-grp">#</span> ':'')+esc(t.name)
        +'<span class="dm-join">reopen</span></div></div>').join(''):'')
    : '';
  if(!list.length&&!closed.length) return '<div class="dm-empty">No conversations yet.</div>';
  return (list.length?'':'<div class="dm-empty">Nothing open.</div>')+list.map(t=>{
    const grp=t.kind==='group';
    const dot=grp?'<span class="dm-grp">#</span>'
      :'<span class="'+(dmState.online.has(t.peer)?'dm-on':'dm-off')+'">●</span>';
    return '<div class="dm-th'+(t.id===dmState.sel?' sel':'')+'" data-dmth="'+t.id+'">'
      +'<div class="dm-thn">'+dot+' '+esc(t.name)
      +(t.muted?' <span class="dm-mute" title="muted — no Telegram escalation">⊘</span>':'')
      +(t.tgSync?' <span class="dm-mute" title="synced with your Telegram">\u21c4</span>':'')
      +(t.unread?'<span class="dm-badge">'+(t.unread>99?'99+':t.unread)+'</span>':'')+'</div>'
      +'<div class="dm-thp">'+esc(t.preview||'no messages yet')+'</div></div>';
  }).join('')+closedSec;
}

// Standing topics — open threads anyone on the desk can discover and join, for discussing one
// idea in one place instead of scattering it across DMs.
function dmTopicsHtml(){
  const rows=(dmState.boards||[]).map(b=>{
    const th=dmThread(b.id);
    const unread=b.joined?((th&&th.muted)?0:(th?th.unread:b.unread)||0):0;
    return '<div class="dm-th'+(b.id===dmState.sel?' sel':'')+'" data-dmboard="'+b.id+'" data-joined="'+(b.joined?'1':'0')+'">'
      +'<div class="dm-thn"><span class="dm-grp">#</span> '+esc(b.title)
      +(unread?'<span class="dm-badge">'+(unread>99?'99+':unread)+'</span>':'')
      +(b.joined?'':'<span class="dm-join">join</span>')+'</div>'
      +'<div class="dm-thp">'+(+b.members||0)+' member'+(b.members===1?'':'s')+' · '+esc(b.preview||'')+'</div></div>';
  }).join('');
  return '<div class="dm-sh" style="margin-top:12px;display:flex;align-items:center">Topics'
    +'<button type="button" class="dm-tool" id="dm-topicbtn" style="margin-left:auto" title="Open a standing topic anyone on the desk can join — an idea, a ticker thesis, a theme">+ new</button></div>'
    +(rows||'<div class="dm-empty" style="padding:4px 14px 8px">No topics yet — open one.</div>');
}
async function dmOpenBoard(id,joined){
  if(!joined){
    const r=await dmPost({joinBoard:id});
    if(!r.ok){ dmState.err=(r.d&&r.d.error)||'could not join that topic'; dmRender(); return; }
    await dmLoad();
  }
  dmOpenThread(id);
}
async function dmNewTopic(){
  const name=(prompt('Name the topic — an idea, a ticker, a theme. Anyone on the desk can see and join it.')||'').trim();
  if(!name) return;
  const r=await dmPost({board:true,title:name});
  if(r.ok&&r.d.thread){ await dmLoad(); dmOpenThread(r.d.thread); }
  else { dmState.err=(r.d&&r.d.error)||'could not create the topic'; dmRender(); }
}

// The away-delivery story, said where messages are written: with no Telegram linked to THIS
// account, nothing nudges this member's phone. If the bot already messages a chat no account owns
// (linked before accounts existed), it is offered for a code-verified claim.
function dmPushBlockHtml(){
  if(!dmPushCapable()) return '';
  return '<div class="dm-sh" style="padding:10px 0 6px">Browser notifications</div>'
    +(dmState.webPushOn
      ?'<div class="dm-tgtxt">On for this device — unread messages arrive as system notifications even with every tab closed. <button type="button" class="dm-tool" id="dm-pushoff">turn off</button></div>'
      :'<div class="dm-tgtxt">Unread messages as system notifications on this device, tab closed included — same 5-minute grace and mute rules as Telegram. <button type="button" class="dm-tool" id="dm-pushon">enable</button></div>');
}
function dmTgHintHtml(){
  if(!dmState.loaded) return '';
  if(dmState.meTg){ const pb=dmPushBlockHtml(); return pb?('<div class="dm-tglink">'+pb+'</div>'):''; }
  return '<div class="dm-tglink"><div class="dm-sh" style="padding:0 0 6px">Telegram nudges</div>'
    +'<div class="dm-tgtxt">No Telegram linked — messages that arrive while you are away cannot reach your phone.</div>'
    +((dmState.adoptables&&dmState.adoptables.length)
      ?'<div class="dm-tgtxt">The bot already messages:</div>'
        +dmState.adoptables.map(c=>'<div class="dm-tgrow"><span class="grow">'+esc(c.name)+' <span class="acc-mu">'+esc(c.mask)+'</span></span>'
          +'<button type="button" class="dm-tool" data-dmadopt="'+esc(c.chat)+'" title="A 6-digit code goes to that Telegram; typing it back links the chat to your account.">this is me</button></div>').join('')
      :'<div class="dm-tgtxt">Link one from the alerts panel: mint a code there and send the bot /start CODE.</div>')
    +dmPushBlockHtml()
    +'</div>';
}

function dmPickerHtml(){
  if(!dmState.picking) return '';
  const people=dmState.members;
  if(!people.length) return '<div class="dm-pick"><div class="dm-empty">Nobody else has an account yet.</div></div>';
  return '<div class="dm-pick">'
    +'<div class="dm-sh">Message one person</div>'
    +people.map(m=>'<div role="button" tabindex="0" class="dm-th" data-dmnew="'+esc(m.uid)+'">'
      +'<div class="dm-thn"><span class="'+(dmState.online.has(m.uid)?'dm-on':'dm-off')+'">●</span> '+esc(m.display)+'</div>'
      +'<div class="dm-thp">'+(dmState.online.has(m.uid)?'online now':(m.lastSeen?'last seen '+esc(dmWhen(m.lastSeen)):'—'))+'</div></div>').join('')
    +'<div class="dm-sh" style="margin-top:12px">Or start a group</div>'
    +'<div class="dm-gform"><input id="dm-gtitle" placeholder="group name" maxlength="48">'
    +people.map(m=>'<label class="dm-gopt"><input type="checkbox" class="dm-gpick" value="'+esc(m.uid)+'"> '+esc(m.display)+'</label>').join('')
    +'<button type="button" class="btn" id="dm-gmake">Create group</button></div>'
    +'</div>';
}

function dmManageHtml(info){
  if(!dmState.manage||!info||(info.kind!=='group'&&info.kind!=='board')) return '';
  const notIn=dmState.members.filter(m=>!info.members.some(x=>x.uid===m.uid));
  // The group's owner manages it; the terminal's operator can too — moderation of rooms they are
  // already in, mirrored server-side, so this is visibility of a power, not the power itself.
  const canMan=info.owner||dmState.admin;
  return '<div class="dm-manage">'
    +'<div class="dm-sh">Members · '+info.members.length+'</div>'
    +info.members.map(m=>'<div class="dm-mrow"><span class="grow">'+esc(m.display)
      +(m.owner?' <span class="mk-chip">owner</span>':'')+'</span>'
      +(canMan&&!m.owner?'<button type="button" class="dm-tool" data-dmrm="'+esc(m.uid)+'">remove</button>':'')
      +'</div>').join('')
    +(canMan?'<div class="dm-sh" style="margin-top:10px">Add</div>'
      +(notIn.length?notIn.map(m=>'<div class="dm-mrow"><span class="grow">'+esc(m.display)+'</span>'
        +'<button type="button" class="dm-tool" data-dmadd="'+esc(m.uid)+'">add</button></div>').join('')
        :'<div class="dm-empty">Everyone is already in.</div>')
      +'<div class="dm-sh" style="margin-top:10px">Rename</div>'
      +'<div class="dm-mrow"><input id="dm-rename" value="'+esc(info.title||'')+'" maxlength="48">'
      +'<button type="button" class="dm-tool" id="dm-dorename">save</button></div>':'')
    +'<div class="dm-mrow" style="margin-top:10px"><button type="button" class="dm-tool dm-leave" id="dm-leave">leave this group</button>'
    +(canMan?'<button type="button" class="dm-tool dm-leave" id="dm-delgroup" style="margin-left:auto" title="Deletes the whole conversation for EVERYONE — messages, files, membership. Close (in the header) just tidies your own list.">delete for everyone</button>':'')
    +'</div>'
    +'</div>';
}
// The shredder, as distinct from "close": everything, for everyone, forever. The double-take is
// deliberate — the confirm names the group and says who loses what.
async function dmDeleteGroup(){
  const t=dmThread(dmState.sel); if(!t) return;
  if(!confirm('Delete “'+t.name+'” for EVERYONE? All messages and files in it are removed for every member, permanently. “Close” in the header just hides it from your own list — this does not.')) return;
  const res=await dmPost({deleteGroup:t.id});
  if(res.ok){ dmState.msgs.delete(t.id); dmState.sel=null; dmState.manage=false; await dmLoad(); dmRender(); }
  else { dmState.err=(res.d&&res.d.error)||'could not delete it'; dmRender(); }
}

function dmResultsHtml(){
  const r=dmState.results;
  if(dmState.searching) return '<div class="dm-log" id="dm-log"><div class="dm-empty">searching…</div></div>';
  if(!r||!r.length) return '<div class="dm-log" id="dm-log"><div class="dm-empty">Nothing matches “'+esc(dmState.q)+'”.</div></div>';
  return '<div class="dm-log" id="dm-log">'+r.map(m=>
    '<div class="dm-res" data-dmres="'+m.thread+'" data-mid="'+m.id+'">'
    +'<div class="dm-meta">'+esc(m.threadName)+' · '+esc(m.mine?'you':m.sender)+' · '+dmWhen(m.ts)+'</div>'
    +'<div class="dm-b">'+esc(m.cmd?'\u25b8 '+m.cmd+' \u00b7 ':'')+esc(m.body).replace(/\n/g,' ')+'</div></div>').join('')+'</div>';
}

// The panel is re-rendered wholesale, which means every render is a chance to destroy something
// somebody is in the middle of typing — and renders now arrive unprompted: an incoming message, a
// reaction, somebody else's typing hint. So the composer and the search box are captured before
// the rebuild and restored after, caret included. Without this, a message landing while you write
// eats your draft, which is the worst thing a chat client can do.
function dmCapture(){
  const ta=el('dm-input'), q=el('dm-q'), log=el('dm-log');
  return { text: ta?ta.value:null, selA: ta?ta.selectionStart:0, selB: ta?ta.selectionEnd:0,
    focus: document.activeElement===ta?'input':(document.activeElement===q?'q':''),
    qSelA: q?q.selectionStart:0, qSelB: q?q.selectionEnd:0,
    // Which state the capture belongs to, so restore never crosses contexts: the text is only
    // put back into the SAME edit it was typed in, and the scroll position only into the same
    // thread and mode it was read at.
    editing: dmState.editing, sel: dmState.sel, mode: dmState.mode,
    logTop: log?log.scrollTop:0,
    // A hidden log (the tab was elsewhere) measures 0 tall and would read as "scrolled up", so a
    // re-opened tab restored a stale offset instead of landing at the bottom. Hidden = at bottom.
    logAtBottom: log ? (log.clientHeight===0 || log.scrollTop+log.clientHeight>=log.scrollHeight-40) : true };
}
// Composer autosize. scrollHeight is content+padding, but the box is border-box — the old bare
// Math.min(scrollHeight,160) left the textarea exactly its 2px of borders shorter than its own
// content, i.e. permanently overflowed, i.e. a permanent scrollbar riding next to Send. Add the
// border back, and allow a scrollbar only once the 160px cap is genuinely hit.
function dmAutoGrow(ta){ if(!ta) return; ta.style.height='auto';
  const need=ta.scrollHeight+(ta.offsetHeight-ta.clientHeight);
  ta.style.height=Math.min(need,160)+'px';
  ta.style.overflowY=need>160?'auto':'hidden'; }
let _dmClearOnNextRender=false;
function dmRestore(c){
  if(!c) return;
  // A successful send clears the box; the capture taken before that render still holds the sent
  // text, so the clear has to win or the message reappears in the composer after sending.
  if(_dmClearOnNextRender){ _dmClearOnNextRender=false; const t0=el('dm-input'); if(t0) t0.value=''; return; }
  const ta=el('dm-input');
  // While editing, the capture holds the IN-PROGRESS rewording — skipping it (the old behavior)
  // meant any unsolicited render (a typing frame, an arriving reaction, the 45s tick) reverted
  // the box to the original body mid-edit. Restore applies whenever the capture belongs to the
  // same edit; a capture from a different edit (or none) stays out of the box.
  if(ta&&c.text!=null&&(!dmState.editing||c.editing===dmState.editing)){
    ta.value=c.text;
    dmAutoGrow(ta);
  }
  if(c.focus==='input'&&ta){ ta.focus(); try{ ta.setSelectionRange(c.selA,c.selB); }catch(_){} }
  if(c.focus==='q'){ const q=el('dm-q'); if(q){ q.focus(); try{ q.setSelectionRange(c.qSelA,c.qSelB); }catch(_){} } }
}

// The calls record. Every price-stamped message with the move since it was sent, and a per-person
// summary — because "who is right" is the only question a call record actually answers.
function dmCallsHtml(){
  const d=dmState.calls;
  if(!d) return '<div class="dm-log" id="dm-log"><div class="dm-empty">loading\u2026</div></div>';
  if(!d.calls.length) return '<div class="dm-log" id="dm-log"><div class="dm-empty">'
    +'No calls yet. Type <b>$TICKER</b> in a message and it carries the mark it was sent at \u2014 those land here.</div></div>';
  // Summary rows are the by-filter: click a person to read just their record (server-side
  // filter, so it reaches past the newest page).
  const sum=d.summary.map(x=>'<div class="dm-callsum'+(dmState.callsBy===x.uid?' sel':'')+'" data-dmcallsby="'+esc(x.uid)+'" title="'+(dmState.callsBy===x.uid?'show everyone':'show only '+esc(x.who)+'’s calls')+'"><span class="grow">'+esc(x.who)+'</span>'
    +'<span class="acc-mu">'+x.n+' call'+(x.n===1?'':'s')+'</span>'
    +'<span class="'+(x.upPct>=0.5?'pos':'neg')+'" title="fraction of calls whose direction-adjusted move is positive — at the fixed 1d horizon once it has printed, live until then">'+Math.round(x.upPct*100)+'% right</span>'
    +'<span class="'+(x.avg>=0?'pos':'neg')+'" title="average direction-adjusted move on the same yardstick">avg '+(x.avg>=0?'+':'')+(x.avg*100).toFixed(1)+'%</span></div>').join('');
  const hz=(v)=>v==null?'<span class="sec">—</span>':'<span class="'+(v>0?'pos':(v<0?'neg':'sec'))+'">'+((v>0?'+':'')+(v*100).toFixed(1)+'%')+'</span>';
  const head='<div class="dm-callrow dm-callhead"><span>call</span><span>message</span><span>who \u00b7 when</span>'
    +'<span class="dm-callpx">sent</span><span class="dm-callpx">now</span>'
    +'<span title="raw price move since sent — colored by whether the call is right">move</span>'
    +'<span class="dm-callhz" title="direction-adjusted move at the fixed 1-day horizon (the first daily close ≥ 24h after the call) — positive means the call was right">1d</span>'
    +'<span class="dm-callhz" title="the same at the 7-day horizon">7d</span></div>';
  const rows=d.calls.map(c=>{
    const cls=c.adj==null?'sec':(c.adj>0?'pos':'neg');
    const mv=c.chg==null?'\u2014':((c.chg>0?'+':'')+(c.chg*100).toFixed(1)+'%');
    return '<div class="dm-callrow'+(c.deleted?' dm-calldel':'')+'" data-dmjump-thread="'+c.thread+'" data-mid="'+c.id+'">'
      +'<span class="dm-callt" data-coin="'+esc(c.ref)+'" title="open the '+esc(dmTkName(c.ref))+' drawer \u2014 the rest of the row jumps to the conversation">'
        +(c.side==='short'?'<span class="neg" title="short call">\u25bc</span>':'<span class="pos" title="long call">\u25b2</span>')+' '+esc(dmTkName(c.ref))+'</span>'
      +'<span class="dm-callb">'+(c.deleted?'<span class="dm-calldelmk">message deleted \u2014 the stamp stands</span>':esc(String(c.body||'').slice(0,120)))+'</span>'
      +'<span class="acc-mu">'+esc(c.sender)+' \u00b7 '+esc(c.threadName)+' \u00b7 '+dmWhen(c.ts)+'</span>'
      +'<span class="dm-callpx" title="the mark when it was sent">'+(c.refPx!=null?fmtPx(c.refPx):'\u2014')+'</span>'
      +'<span class="dm-callpx dm-callnow" title="the current mark">'+(c.px!=null?fmtPx(c.px):'\u2014')+'</span>'
      +'<span class="dm-callmv '+cls+'" title="price move since sent \u2014 colored by whether the '+(c.side||'long')+' is right">'+mv+'</span>'
      +'<span class="dm-callhz">'+hz(c.adj1)+'</span>'
      +'<span class="dm-callhz">'+hz(c.adj7)+'</span></div>';
  }).join('');
  return '<div class="dm-log" id="dm-log"><div class="dm-callsums">'+sum+'</div>'+head+rows+'</div>';
}
// One fetch for the calls board, filter included \u2014 both the open and the 45s tick ride it.
async function dmFetchCalls(){
  const by=dmState.callsBy?'&by='+encodeURIComponent(dmState.callsBy):'';
  const d=await fetchJSON('/api/dm/calls?limit=500'+by); if(d&&d.ok) dmState.calls=d;
}

// Throttled: the first call in a frame paints at once (callers read the composer straight after),
// every further call in the same frame folds into one paint on the next frame — a burst of sync
// frames, receipts and typing hints used to rebuild the panel once per event.
let _dmRaf=0, _dmDirty=false;
function dmRender(){
  if(_dmRaf){ _dmDirty=true; return; }
  dmRenderNow();
  if(typeof requestAnimationFrame==='function') _dmRaf=requestAnimationFrame(()=>{ _dmRaf=0; if(_dmDirty){ _dmDirty=false; dmRender(); } })||0;
}
function dmRenderNow(){
  const host=el('dm-body'); if(!host) return;
  const keep=dmCapture();
  // Search results are a layer over the conversation: Escape backs out through the overlay stack.
  if(dmState.results||dmState.searching) overlayPush('dm-search',()=>{ dmState.q=''; dmState.results=null; dmState.searching=false; dmRender(); }); else overlayPop('dm-search');
  if(!dmSignedIn()){
    host.innerHTML='<div class="msg">Messages need an account. '
      +'<a href="/login">Sign in</a> — or ask the operator for an invite link.'
      +'<div style="margin-top:10px"><button type="button" class="btn" id="dm-reqinvite">Request an invite</button>'
      +'<span class="sec" id="dm-reqnote" style="margin-left:8px"></span></div></div>';
    const rb=el('dm-reqinvite');
    if(rb) rb.addEventListener('click',async ()=>{
      const who=(prompt('Who should the operator invite? A name they will recognize:')||'').trim();
      if(!who) return;
      rb.disabled=true;
      const note=el('dm-reqnote');
      try{
        const r=await fetch('/api/dm/request-invite',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:who})});
        const d=await r.json().catch(()=>({}));
        if(note) note.textContent=(r.ok&&d&&d.ok)?'Request sent — the operator has been pinged.':'Could not send — ask the operator directly.';
      }catch(_){ if(note) note.textContent='Could not send — ask the operator directly.'; }
    });
    return;
  }
  const t=dmThread(dmState.sel);
  const info=t?dmState.info.get(t.id):null;
  const pendingPeer=dmState.pendingPeer?dmState.members.find(m=>m.uid===dmState.pendingPeer):null;

  let main;
  if(dmState.mode==='calls'){
    const byName=dmState.callsBy?((dmState.members.find(m=>m.uid===dmState.callsBy)||{}).display||'one member'):null;
    main='<div class="dm-hd"><b>Calls</b>'
      +'<span class="sec" data-tip="a stamped call is exempt from the 30d/7d message retention — the row is kept permanently, and the record reads it for as long as it exists. Deleting a call removes its body, never its score.">every price-stamped message — sent price, current price, and the move · kept forever, never ages out</span>'
      +(byName?'<span class="mk-chip" style="color:var(--accent)">'+esc(byName)+' only <button type="button" class="dm-tool" data-dmcallsby="'+esc(dmState.callsBy)+'" title="show everyone">✕</button></span>':'')
      +'<button type="button" class="btn dm-mutebtn" id="dm-backchat">back</button></div>'+dmCallsHtml();
  }else if(dmState.results||dmState.searching){   // `searching` alone covers the FIRST query, when no prior result set exists yet
    const scopeCtl=dmState.sel?('<span class="dm-sscope">'
      +'<button type="button" class="dm-tool'+(dmState.searchScope!=='thread'?' on':'')+'" data-dmsscope="all">everywhere</button>'
      +'<button type="button" class="dm-tool'+(dmState.searchScope==='thread'?' on':'')+'" data-dmsscope="thread" title="only the conversation that was open when you searched">this conversation</button></span>'):'';
    main='<div class="dm-hd"><b>Search</b><span class="sec">'+esc(dmState.q)+'</span>'+scopeCtl
      +'<button type="button" class="btn dm-mutebtn" id="dm-clearsearch">clear</button></div>'+dmResultsHtml();
  }else if(pendingPeer){
    main='<div class="dm-hd"><b>'+esc(pendingPeer.display)+'</b>'
      +'<span class="sec" style="margin-left:auto">new conversation</span></div>'
      +'<div class="dm-log" id="dm-log"><div class="dm-empty">Say something to start.</div></div>';
  }else if(!t){
    main='<div class="dm-log" id="dm-log"><div class="dm-empty">'
      +(dmState.threads.length?'Pick a conversation.':'No conversations yet — press <b>+ new</b>.')+'</div></div>';
  }else{
    const all=dmMsgs(t.id), arr=all.length>_dmWin?all.slice(-_dmWin):all;   // the window; pins and the receipt read the whole cache
    // "Seen" only under the LAST message you sent: a receipt on every line is noise, and the only
    // question it answers is whether the thing you just said has landed.
    const receipt=dmReceiptHtml(t, all);
    const pinned=(t.pins?all.filter(x=>x.pinned):[]);
    // On a topic board the FIRST pinned message is the standing post — the thesis the topic was
    // opened to argue — rendered in full at the top rather than as a one-line strip row.
    const thesis=(t.kind==='board'&&pinned.length)?pinned[0]:null;
    const thesisHtml=thesis?('<div class="dm-thesis">'
      +'<div class="dm-thesis-h">§ standing post — '+esc(thesis.mine?'you':(thesis.sender||'—'))+' · '+dmWhen(thesis.ts)
      +'<button type="button" class="dm-tool" data-dmpin="'+thesis.id+'" data-on="0" style="margin-left:auto">unpin</button></div>'
      +'<div class="dm-thesis-b">'+dmMentionHtml(esc(thesis.body||'')).replace(/\n/g,'<br>')+'</div>'
      +dmStamp(thesis)+'</div>'):'';
    const stripPins=thesis?pinned.slice(1):pinned;
    const pinStrip=stripPins.length?('<div class="dm-pinstrip">'+stripPins.slice(0,3).map(x=>
      '<div class="dm-pinrow" data-dmjump="'+x.id+'"><span class="dm-pinicon">\u2691</span>'
      +'<span class="dm-pintext">'+esc(String((x.ref?'$'+x.ref+' \u00b7 ':'')+(x.cmd?'\u25b8 '+x.cmd+' \u00b7 ':'')+(x.body||'attachment')).slice(0,120))+'</span>'
      +'<button type="button" class="dm-tool" data-dmpin="'+x.id+'" data-on="0">unpin</button></div>').join('')+'</div>'):'';
    // Day dividers carry the date once, so per-message headers can be bare clock times; each
    // message also sees its predecessor, which is what chat-style grouping keys on.
    const parts=[];
    // The "new" line draws where this open found the read watermark, once, before the first
    // incoming message past it — and stays put while the reader catches up.
    const um=(dmState.unreadMark&&dmState.unreadMark.thread===t.id)?dmState.unreadMark.after:null;
    let newMarked=false;
    for(let i=0;i<arr.length;i++){
      const m=arr[i], p=arr[i-1];
      if(!p||!dmSameDay(p.ts,m.ts)) parts.push('<div class="dm-day"><span>'+esc(dmDayLabel(m.ts))+'</span></div>');
      if(um!=null&&!newMarked&&m.id>um&&!m.mine&&!m.sys){
        parts.push('<div class="dm-day dm-newmark"><span>new</span></div>'); newMarked=true; }
      parts.push(dmMessageHtml(m,t,p));
    }
    const older=(((info&&info.more)||all.length>arr.length)&&arr.length)
      ?'<div class="dm-more"><button type="button" class="dm-tool" id="dm-older">↑ load older messages</button></div>':'';
    const log=(arr.length?older+parts.join('')+receipt:'<div class="dm-empty">No messages yet.</div>')+dmLocalHtml(t.id);
    const grp=t.kind==='group'||t.kind==='board';
    const nMem=info?info.members.length:t.members?t.members.length:0;
    main='<div class="dm-hd">'+(grp?'<span class="dm-grp">#</span> ':'')+'<b>'+esc(t.name)+'</b>'
      +(grp?'<span class="mk-chip">'+nMem+' member'+(nMem===1?'':'s')+'</span>'
        :(function(){ const on=dmState.online.has(t.peer), pm=dmState.members.find(m=>m.uid===t.peer);
          // "away" answers the question this tab keeps raising: will they even know I wrote?
          return '<span class="mk-chip '+(on?'dm-chip-on':'')+'" title="'+(on?'connected right now'
            :(pm&&pm.tg?'away \u2014 unread messages nudge their Telegram after 5 minutes'
              :'away \u2014 no Telegram linked: they will only see this when they next open the terminal'))+'">'
            +(on?'online':'away'+(pm&&!pm.tg?' \u00b7 no telegram':''))+'</span>'; })())
      +(t.disabled?'<span class="sec">account disabled</span>':'')
      +'<span class="dm-hdact">'
      +(grp?'<button type="button" class="btn dm-mutebtn" id="dm-managebtn">'+(dmState.manage?'close':'members')+'</button>':'')
      // Telegram sync (build 2026.09.21-83): the box mirrors THIS conversation to the member's
      // phone both ways. One at a time by construction, so ticking it here unticks it elsewhere.
      +'<label class="dm-sync'+(dmState.meTg?'':' off')+'" title="'+(dmState.meTg
        ?'Sync this conversation with your Telegram, both ways: every message lands on your phone as it happens, and plain text you send the bot posts here under your name. One conversation at a time \u2014 ticking it here unticks it anywhere else.'
        :'Link a Telegram in the alerts panel first')+'"><input type="checkbox" id="dm-tgsync"'+(t.tgSync?' checked':'')+(dmState.meTg?'':' disabled')+'> \u21c4 telegram</label>'
      +'<a class="btn dm-mutebtn" href="/api/dm/export/'+t.id+'" title="Download this conversation as JSON \u2014 messages, stamps and members">\u2913</a>'
      +(t.kind==='board'
        ?'<button type="button" class="btn dm-mutebtn" id="dm-bnotify" title="Boards are quiet on Telegram by default: only @mentions and tickers you watch reach your phone. Toggle to get every message nudged like a group.">'
          +(t.boardNotify?'\ud83d\udd14 everything':'\ud83d\udd14 mentions only')+'</button>'
        :'<button type="button" class="btn dm-mutebtn" id="dm-mute" title="Muted conversations never escalate to Telegram'+(t.muted?'':' \u2014 except tickers you watch and your @handle, which always come through')+'">'
          +(t.muted?'unmute':'mute')+'</button>')
      +'<button type="button" class="btn dm-mutebtn" id="dm-clearhist" title="Clear this conversation\u2019s history for YOU \u2014 the other side keeps theirs, and the operator record is untouched. Cannot be undone.">clear</button>'
      +'<button type="button" class="btn dm-mutebtn" id="dm-close" title="Close this conversation \u2014 it leaves your list; the history stays and it comes back the moment either of you writes again.">close</button>'
      +'</span></div>'
      +dmManageHtml(info)+thesisHtml+pinStrip
      +'<div class="dm-log" id="dm-log">'+log+'</div><div id="dm-typing">'+dmTypingLine(t.id)+'</div>';
  }

  const canWrite=!!(t||pendingPeer)&&!dmState.results&&!dmState.searching&&dmState.mode!=='calls';
  const attach=dmState.pendingFile
    ? '<div class="dm-pending">📎 '+esc(dmState.pendingFile.name)+' <button type="button" class="dm-tool" id="dm-unattach">remove</button></div>'
    : '';
  // No attaching mid-edit: the edit verb carries no fileId, so an attachment picked here was
  // uploaded, stored server-side, and silently discarded.
  const canAttach=canWrite&&t&&!dmState.editing;
  const composer='<div class="dm-cmp">'
    +'<label class="dm-clip'+(canAttach?'':' off')+'" title="Attach an image or a .txt note (8 MB maximum) — or just paste a screenshot into the box">📎'
    +'<input type="file" id="dm-file" accept=".png,.jpg,.jpeg,.gif,.webp,.txt,image/png,image/jpeg,image/gif,image/webp,text/plain"'+(canAttach?'':' disabled')+'></label>'
    +'<button type="button" class="dm-clip dm-mic'+(canAttach?'':' off')+'" id="dm-mic" title="Record a voice note (3 MB max)"'+(canAttach?'':' disabled')+'>🎙</button>'
    +'<button type="button" class="dm-clip dm-guidebtn" id="dm-guide" title="Commands \u2014 everything you can type here, and what runs from a chat">?</button>'
    +'<div class="dm-mpop" id="dm-mpop" hidden></div>'
    +'<textarea id="dm-input" rows="1" maxlength="'+dmState.maxLen+'" '
    +(canWrite?'':'disabled ')+'placeholder="'
    +(canWrite?'message '+esc((t&&t.name)||(pendingPeer&&pendingPeer.display)||'')+'…  ($TICKER attaches the mark · /help for commands)':'pick a conversation first')
    +'"></textarea><div class="dm-stamppv" id="dm-stamppv" hidden></div>'
    +'<button type="button" class="btn dm-send" id="dm-send"'+(canWrite?'':' disabled')+'>'
    +(dmState.sending?'…':(dmState.editing?'Save':'Send'))+'</button></div>'
    +attach
    +(dmState.editing?'<div class="dm-editing">Editing — the original timestamp and price stamp stand. '
      +'<button type="button" class="dm-tool" id="dm-canceledit">cancel</button></div>':'')
    +(dmState.replying?(function(){ const rm=dmMsgs(dmState.sel).find(x=>x.id===dmState.replying);
      return '<div class="dm-editing">Replying to <b>'+esc(rm?(rm.mine?'you':(rm.sender||'—')):'…')+'</b>'
        +(rm?' — '+esc(String(rm.body||'attachment')).replace(/\n/g,' ').slice(0,60):'')
        +' <button type="button" class="dm-tool" id="dm-cancelreply">cancel</button></div>'; })():'')
    +(dmState.err?'<div class="dm-err">'+esc(dmState.err)+'</div>':'');

  const watchChips=(dmState.watching||[]).map(c=>
    '<span class="dm-wchip">'+esc(c)+'<button type="button" class="dm-wx" data-dmunwatch="'+esc(c)+'" title="stop watching">×</button></span>').join('');
  const watchBox='<div class="dm-watch">'
    +'<div class="dm-sh" style="padding:0 0 6px">Tell me about'
      +'<span class="dm-whelp" data-tip="A message whose $TICKER is on this list reaches you straight away and gets through a muted conversation. Everything else waits out the usual five minutes.">?</span></div>'
    +(watchChips||'<span class="dm-empty" style="padding:0">nothing yet</span>')
    +(dmState.watchAdd
      ? '<input id="dm-wadd" class="dm-winput" placeholder="ticker, then Enter" maxlength="24" autofocus>'
      : '<button type="button" class="dm-tool" id="dm-waddbtn">+ add a ticker</button>')
    +'</div>';
  // Said plainly, where people write. They will assume a direct message is private unless told
  // otherwise, and on this deployment it is not.
  // Retention is policy, so it is said where people write, not discovered when history is gone.
  const disclosure='<div class="dm-disclose">'
    +(dmState.operatorReadsAll?'The operator of this terminal can read every message here. ':'')
    +'Messages are kept 30 days — 7 in groups and topics — except pinned messages and price-stamped calls, which stay.</div>';
  // Who is here RIGHT NOW, at the top of the rail — before this, presence hid as a small dot per
  // conversation and you only learned somebody was around after opening theirs. Clicking a chip
  // starts (or jumps to) a conversation with that person.
  const onNames=(dmState.members||[]).filter(m=>dmState.online.has(m.uid));
  const onlineStrip='<div class="dm-onrow">'
    +(onNames.length
      ? onNames.map(m=>'<span role="button" tabindex="0" class="dm-onchip" data-dmnew="'+esc(m.uid)+'" title="message '+esc(m.display)+'"><i></i>'+esc(m.display)+'</span>').join('')
      : '<span class="dm-onnone">nobody else online</span>')
    +'</div>';
  host.innerHTML='<div class="dm-wrap">'
    +'<div class="dm-side">'
      +'<div class="dm-search"><input id="dm-q" placeholder="search messages…" value="'+esc(dmState.q)+'"></div>'
      +'<div class="dm-sh">Online</div>'+onlineStrip
      +'<div class="dm-sh">Conversations'
        +'<button type="button" class="dm-tool dm-callsbtn" id="dm-callsbtn" title="Every price-stamped call, and how each has done since">calls \u2197</button></div>'
      +dmRailHtml()
      +'<div role="button" tabindex="0" class="dm-new" id="dm-newbtn">'+(dmState.picking?'× close':'+ new message')+'</div>'+dmPickerHtml()
      +dmTopicsHtml()
      +dmTgHintHtml()
      +watchBox+'</div>'
    +'<div class="dm-main">'+main+composer+disclosure+'</div></div>';

  const ta=el('dm-input');
  if(ta){
    // Seed the original body only when this render ENTERS the edit — a re-render mid-edit
    // carries the rewording in `keep` and dmRestore puts it back below.
    if(dmState.editing&&keep.editing!==dmState.editing){
      const m=dmMsgs(dmState.sel).find(x=>x.id===dmState.editing); if(m){ ta.value=m.body; dmAutoGrow(ta); } }
    ta.addEventListener('input',()=>{
      dmAutoGrow(ta);
      // An edit is not the thread's draft: saving it here destroyed whatever the member had
      // half-typed for that conversation before clicking "edit".
      if(!dmState.editing) dmDraftSave(dmState.sel,ta.value); dmStampPreview(ta.value);
      dmState.compIdx=0;
      if(!dmCmdPop(ta)) dmMentionPop(ta);
      dmTypingPing(); });
    ta.addEventListener('keydown',(e)=>{
      // The @mention popup captures Enter/Tab while it is showing — completion, not send.
      const pop=el('dm-mpop');
      // Command completions: Tab applies the highlighted candidate and advances the highlight,
      // arrows move it, Escape closes, and Enter falls through to SEND — a finished command runs.
      if(pop&&!pop.hidden&&pop.querySelector('[data-dmcomp]')){
        const opts=[...pop.querySelectorAll('[data-dmcomp]')];
        if(e.key==='Tab'){ e.preventDefault(); const o=opts[dmState.compIdx%opts.length]; if(o){ dmCompPick(o.dataset.dmcomp); } return; }
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){ e.preventDefault(); dmState.compIdx=(dmState.compIdx+(e.key==='ArrowDown'?1:opts.length-1))%opts.length; opts.forEach((o,i)=>o.classList.toggle('sel',i===dmState.compIdx)); return; }
        if(e.key==='Escape'){ pop.hidden=true; return; }
        if(e.key==='Enter'&&!e.shiftKey){ pop.hidden=true; }
      }
      else if(pop&&!pop.hidden){
        if(e.key==='Enter'||e.key==='Tab'){ e.preventDefault();
          const first=pop.querySelector('[data-dmmention]');
          if(first) dmMentionPick(first.dataset.dmmention); return; }
        if(e.key==='Escape'){ pop.hidden=true; return; }
      }
      else if(e.key==='Tab'&&/^\//.test(ta.value)){ e.preventDefault(); dmState.compIdx=0; if(dmCmdPop(ta)){ const o=el('dm-mpop').querySelector('[data-dmcomp]'); if(o) dmCompPick(o.dataset.dmcomp); } return; }
      // Enter sends, Shift+Enter is a newline. A chat box that needs a mouse to send is a form.
      if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); dmSend(); }
      if(e.key==='Escape'&&dmState.editing){ e.stopPropagation(); dmState.editing=null; ta.value=dmDraftGet(dmState.sel)||''; dmAutoGrow(ta); dmRender(); }
      else if(e.key==='Escape'&&dmState.replying){ e.stopPropagation(); dmState.replying=null; dmRender(); }
    });
    // A pasted screenshot is the desk's most common attachment — straight from the clipboard to
    // the pending chip, no save-to-disk detour.
    ta.addEventListener('paste',(e)=>{
      const items=(e.clipboardData&&e.clipboardData.items)||[];
      for(const it of items){
        if(it.kind==='file'&&/^image\//.test(it.type)){
          if(dmState.editing) return;   // edits carry no attachment — let the paste fall through as nothing
          const f=it.getAsFile(); if(!f) continue;
          e.preventDefault();
          const ext=(f.type.split('/')[1]||'png').replace(/[^a-z0-9]/gi,'');
          try{ dmState.pendingFile=new File([f],'paste-'+new Date().toISOString().slice(11,19).replace(/:/g,'')+'.'+ext,{type:f.type}); }
          catch(_){ dmState.pendingFile=f; }
          dmState.err=''; dmRender(); return;
        }
      }
    });
  }
  const q=el('dm-q');
  if(q) q.addEventListener('input',()=>dmSearchInput(q.value));   // Escape: the 'dm-search' overlay (core.js stack) clears the results
  { const w=el('dm-wadd');
    if(w) w.addEventListener('keydown',(e)=>{
      if(e.key==='Enter'&&w.value.trim()) dmWatch(w.value.trim(),true);
      if(e.key==='Escape'){ dmState.watchAdd=false; dmRender(); } }); }
  const f=el('dm-file');
  if(f) f.addEventListener('change',()=>{ if(f.files&&f.files[0]){ dmState.pendingFile=f.files[0]; dmState.err=''; dmRender(); } });
  dmRestore(keep);
  // Scroll discipline. A re-render of the SAME view (same thread, same mode — the common case:
  // a typing frame, a reaction, the 45s tick) preserves where the reader is: yanked-to-bottom
  // every ~3s made backscroll unreadable while the other side typed. Only a reader already at
  // the bottom rides new content down. A view CHANGE gets the entry behavior: chat opens at the
  // bottom (or the "new" line), and Calls opens at the TOP — it is a newest-first list, and the
  // old unconditional dmScrollBottom landed it on the oldest row.
  const sameView=keep.sel===dmState.sel&&keep.mode===dmState.mode;
  if(dmState.mode==='calls'){
    const log=el('dm-log'); if(log) log.scrollTop=sameView?keep.logTop:0;
  }else if(!dmState.results){
    if(dmState.scrollToNew){
      // The flag survives until the mark actually renders — the open paints once before the
      // history fetch lands, and consuming it on that first empty paint would scroll past "new".
      const nm=document.querySelector('.dm-newmark');
      if(nm){ dmState.scrollToNew=false; nm.scrollIntoView({block:'center'}); }
      else dmScrollBottom();
    }
    else if(sameView&&!keep.logAtBottom){ const log=el('dm-log'); if(log) log.scrollTop=keep.logTop; }
    else dmScrollBottom();
  }
  dmPinBottomOnImages();
}
// Images (attachments, ratio charts, tweet cards) finish loading after the paint and grow the log,
// pushing the bottom away from a reader who was at it. Keep them pinned until every image has
// landed; a reader who has since scrolled up is left alone.
function dmPinBottomOnImages(){
  const log=el('dm-log'); if(!log) return;
  for(const img of log.querySelectorAll('img')){
    if(img.complete||img._dmPinned) continue; img._dmPinned=1;
    img.addEventListener('load',()=>{ const l=el('dm-log'); if(l&&l.scrollTop+l.clientHeight>=l.scrollHeight-img.clientHeight-40) dmScrollBottom(); },{once:true});
  }
}

// One delegated listener for the whole tab — the panel is re-rendered wholesale on every change,
// so per-element handlers would leak on each paint.
function dmWire(){
  const host=el('dm-body'); if(!host||host._dmWired) return;
  host._dmWired=true;
  // Double-tap (dblclick on desktop, double-tap on phones) toggles the first quick reaction —
  // the hover action bar has no hover to ride on a touch screen.
  host.addEventListener('dblclick',(e)=>{
    const msg=e.target.closest('.dm-msg[data-mid]');
    if(!msg||e.target.closest('a,button,textarea,input')) return;
    if(msg.querySelector('.dm-del')) return;
    const emo=(dmState.reactions&&dmState.reactions[0])||null;
    if(emo) dmReact(+msg.dataset.mid,emo);
  });
  // Long-press (500ms, no movement) opens the message's action bar on touch screens — the
  // hover bar has no hover to ride there; a tap anywhere else folds it back up. Double-tap
  // keeps its quick-reaction meaning; the two do not overlap in time.
  let _lpT=0,_lpFired=false;
  host.addEventListener('touchstart',(e)=>{
    const msg=e.target.closest('.dm-msg[data-mid]');
    if(!msg||e.target.closest('.dm-act')){ if(!e.target.closest('.dm-act')) host.querySelectorAll('.dm-msg.acton').forEach(x=>x.classList.remove('acton')); return; }
    _lpFired=false;
    _lpT=setTimeout(()=>{ _lpFired=true;
      host.querySelectorAll('.dm-msg.acton').forEach(x=>x.classList.remove('acton'));
      msg.classList.add('acton'); },500);
  },{passive:true});
  host.addEventListener('touchmove',()=>clearTimeout(_lpT),{passive:true});
  host.addEventListener('touchcancel',()=>clearTimeout(_lpT),{passive:true});
  host.addEventListener('touchend',(e)=>{ clearTimeout(_lpT);
    if(_lpFired){ e.preventDefault(); _lpFired=false; } },{passive:false});
  host.addEventListener('click',(e)=>{
    const pinBtn=e.target.closest('[data-dmpin]');
    if(pinBtn){ dmPin(+pinBtn.dataset.dmpin, pinBtn.dataset.on==='1'); return; }
    const noteBtn=e.target.closest('[data-dmnote]');
    if(noteBtn){ dmToNote(+noteBtn.dataset.dmnote); return; }
    const unw=e.target.closest('[data-dmunwatch]');
    if(unw){ dmWatch(unw.dataset.dmunwatch,false); return; }
    if(e.target.closest('#dm-waddbtn')){ dmState.watchAdd=true; dmRender(); return; }
    if(e.target.closest('#dm-callsbtn')){ dmOpenCalls(); return; }
    if(e.target.closest('#dm-backchat')){ dmState.mode='chat'; dmRender(); return; }
    const bell=e.target.closest('[data-dmalert]');
    if(bell){ dmArmCallAlert(bell.dataset.dmalert, +bell.dataset.px); return; }
    const cby=e.target.closest('[data-dmcallsby]');
    if(cby){ dmState.callsBy=dmState.callsBy===cby.dataset.dmcallsby?null:cby.dataset.dmcallsby;
      dmFetchCalls().then(()=>dmRender()); dmRender(); return; }
    const ssc=e.target.closest('[data-dmsscope]');
    if(ssc){ dmState.searchScope=ssc.dataset.dmsscope==='thread'?'thread':'all'; dmRunSearch(); return; }
    if(e.target.closest('#dm-pushon')){ dmPushEnable(); return; }
    if(e.target.closest('#dm-pushoff')){ dmPushDisable(); return; }
    const tk=e.target.closest('.dm-tk[data-coin],.dm-callt[data-coin]');
    if(tk){ const c=tk.dataset.coin;
      if(state.rows.has(c)) openDetail(c);
      else pushToast('That market is not on the board right now');
      return; }
    const rp=e.target.closest('[data-dmreply]');
    if(rp){ dmState.replying=+rp.dataset.dmreply; dmState.editing=null; dmRenderNow();
      const ta=el('dm-input'); if(ta) ta.focus(); return; }
    if(e.target.closest('#dm-cancelreply')){ dmState.replying=null; dmRender(); return; }
    const q=e.target.closest('[data-dmq]');
    if(q){ const n=document.querySelector('.dm-msg[data-mid="'+q.dataset.dmq+'"]');
      if(n){ n.scrollIntoView({block:'center'}); n.classList.add('dm-flash'); setTimeout(()=>n.classList.remove('dm-flash'),1200); }
      return; }
    const ad=e.target.closest('[data-dmadopt]');
    if(ad){ dmAdopt(ad.dataset.dmadopt); return; }
    if(e.target.closest('#dm-closedhd')){ dmState.showClosed=!dmState.showClosed; dmRender(); return; }
    const ro=e.target.closest('[data-dmreopen]');
    if(ro){ const id=+ro.dataset.dmreopen;
      dmPost({reopen:id}).then(()=>dmLoad()).then(()=>dmOpenThread(id)); return; }
    if(e.target.closest('#dm-delgroup')){ dmDeleteGroup(); return; }
    const bd=e.target.closest('[data-dmboard]');
    if(bd){ dmOpenBoard(+bd.dataset.dmboard, bd.dataset.joined==='1'); return; }
    if(e.target.closest('#dm-topicbtn')){ dmNewTopic(); return; }
    const jt=e.target.closest('[data-dmjump-thread]');
    if(jt){ dmState.mode='chat'; dmOpenThread(+jt.dataset.dmjumpThread); return; }
    const jump=e.target.closest('[data-dmjump]');
    if(jump){ const n=document.querySelector('.dm-msg [data-dmpin="'+jump.dataset.dmjump+'"]');
      if(n) n.closest('.dm-msg').scrollIntoView({block:'center'}); return; }
    const rx=e.target.closest('[data-dmrx]');
    if(rx){ dmReact(+rx.dataset.dmrx,rx.dataset.emoji); return; }
    const rxo=e.target.closest('[data-dmrxopen]');
    if(rxo){ const menu=rxo.parentElement.querySelector('.dm-rxmenu');
      if(menu) menu.classList.toggle('open'); return; }
    const res=e.target.closest('[data-dmres]');
    if(res){ dmState.q=''; dmState.results=null; dmOpenThread(+res.dataset.dmres); return; }
    const th=e.target.closest('[data-dmth]');
    if(th){ dmOpenThread(+th.dataset.dmth); return; }
    const nw=e.target.closest('[data-dmnew]');
    if(nw){ dmStartWith(nw.dataset.dmnew); return; }
    const add=e.target.closest('[data-dmadd]');
    if(add){ dmGroupOp({addMembers:true,thread:dmState.sel,members:[add.dataset.dmadd]}); return; }
    const rm=e.target.closest('[data-dmrm]');
    if(rm){ dmGroupOp({removeMember:true,thread:dmState.sel,uid:rm.dataset.dmrm},'Remove them from this group?'); return; }
    if(e.target.closest('#dm-gmake')){ dmNewGroup(); return; }
    if(e.target.closest('#dm-managebtn')){ dmState.manage=!dmState.manage; dmRender(); return; }
    if(e.target.closest('#dm-dorename')){ dmGroupOp({rename:true,thread:dmState.sel,title:(el('dm-rename')||{}).value||''}); return; }
    if(e.target.closest('#dm-leave')){ dmGroupOp({leave:true,thread:dmState.sel},'Leave this group? You stop seeing it.'); return; }
    if(e.target.closest('#dm-clearsearch')){ dmState.q=''; dmState.results=null; dmRender(); return; }
    if(e.target.closest('#dm-unattach')){ dmState.pendingFile=null; dmRender(); return; }
    if(e.target.closest('#dm-newbtn')){ dmState.picking=!dmState.picking; dmRender(); return; }
    if(e.target.closest('#dm-send')){ dmSend(); return; }
    if(e.target.closest('#dm-guide')||e.target.closest('[data-dmguide]')){ openDmGuide(); return; }
    { const co=e.target.closest('[data-dmcomp]'); if(co){ dmCompPick(co.dataset.dmcomp); return; } }
    { const rt=e.target.closest('[data-dmrtf]'); if(rt){ dmRatioSwitch(+rt.dataset.mid, rt.dataset.dmrtf); return; } }
    if(e.target.closest('#dm-mute')){ dmToggleMute(); return; }
    if(e.target.closest('#dm-bnotify')){ dmToggleBoardNotify(); return; }
    if(e.target.id==='dm-tgsync'){ e.preventDefault(); dmToggleTgSync(); return; }
    if(e.target.closest('#dm-mic')){ dmMicToggle(); return; }
    const mn=e.target.closest('[data-dmmention]');
    if(mn){ dmMentionPick(mn.dataset.dmmention); return; }
    if(e.target.closest('#dm-close')){ dmCloseThread(); return; }
    if(e.target.closest('#dm-clearhist')){ dmClearHistory(); return; }
    if(e.target.closest('#dm-older')){ dmLoadOlder(); return; }
    if(e.target.closest('#dm-canceledit')){ dmState.editing=null;
      // The thread's own draft comes back — the edit text must not linger as a phantom draft.
      const ta0=el('dm-input'); if(ta0){ ta0.value=dmDraftGet(dmState.sel)||''; dmAutoGrow(ta0); }
      dmRender(); return; }
    const ed=e.target.closest('[data-dmedit]'); if(ed){ dmEdit(+ed.dataset.dmedit); return; }
    const dl=e.target.closest('[data-dmdel]'); if(dl){ dmDrop(+dl.dataset.dmdel); return; }
  });
}

// Keyboard. Deliberately NOT its own document listener: the app already has one global keydown
// handler with an established grammar — `/` focuses the current tab's search, j/k walk a list,
// Escape backs out a level — and Ctrl+K already belongs to the command palette. This hooks into
// that handler instead of competing with it, so the conventions stay true across tabs.
// Called only when the view is `dm`, no modifier is held, and the caret is NOT in a field: the
// outer handler guarantees all three, which is why none of it is re-checked here.
function dmKeys(e){
  if(e.key==='Escape'){
    if(e.defaultPrevented) return;   // the overlay stack already spent this Escape (search results, a modal)
    if(dmState.mode==='calls'){ dmState.mode='chat'; dmRender(); }
    else if(dmState.results){ dmState.q=''; dmState.results=null; dmRender(); }
    else if(dmState.picking||dmState.manage){ dmState.picking=false; dmState.manage=false; dmRender(); }
    return;
  }
  if(e.key==='j'||e.key==='k'){
    // Navigate what the rail SHOWS: closed (hidden) threads live in a folded section and boards
    // are listed elsewhere — stepping through them made j/k jump to rows that aren't there.
    const list=dmState.threads.filter(t=>!t.hidden);
    if(!list.length) return;
    const i=Math.max(0,list.findIndex(t=>t.id===dmState.sel));
    const next=e.key==='j'?Math.min(list.length-1,i+1):Math.max(0,i-1);
    if(list[next]&&list[next].id!==dmState.sel){ e.preventDefault(); dmOpenThread(list[next].id); }
    return;
  }
  // A bare letter is almost always the start of a sentence somebody means to send.
  if(e.key.length===1){ const ta=el('dm-input'); if(ta&&!ta.disabled) ta.focus(); }
}

async function openDM(){
  dmWire();
  dmPushProbe();                  // reflect this browser's real subscription state, async
  dmRender();                     // paint the shell immediately, fill it as data lands
  await dmLoad();
  if(!dmState.sel&&dmState.threads.length) { await dmOpenThread(dmState.threads[0].id); return; }
  await dmSync();
  dmRender();
  if(dmState.sel) dmMarkRead(dmState.sel);
  // The tab is visible only now: scroll once more after layout, so opening Messages never leaves
  // the reader mid-history because the first paint happened while the section was hidden.
  requestAnimationFrame(()=>{ if(state.view==='dm'&&!dmState.results&&dmState.mode!=='calls'){ dmScrollBottom(); dmPageToComposer(); } });
}

export function __boot_messages_14817() {

// The price stamp's "since sent" is computed live at READ on the server, but a fetched message
// sat frozen in dmState forever — a stamp showed +0.0% no matter how far the market moved. While
// a conversation is on screen, re-pull its page every 45s: dmMerge replaces rows by id, so every
// visible stamp (and the calls view) re-marks against the current price.
setInterval(async ()=>{
  if(document.hidden||!dmSignedIn()||state.view!=='dm') return;   // nobody is reading a hidden tab; the visibilitychange sync catches up
  try{
    await dmLoad();   // presence, thread list and the pip stay fresh while the tab sits open
    if(dmState.mode==='calls') await dmFetchCalls();
    else if(dmState.sel&&!dmState.results){
      const d=await fetchJSON('/api/dm/'+encodeURIComponent(dmState.sel));
      if(d&&d.ok){ dmMerge(d.messages); if(d.info){ d.info.more=!!d.more; dmState.info.set(dmState.sel,d.info); } }
    }
    dmRender();
  }catch(_){ }
},45000);

// Messages boot with the app, not with the tab: the pip must be accurate on the first paint, and a
// signed-in member who never opens the tab still needs their Telegram escalation cancelled by the
// simple fact of being here.
if(dmSignedIn()){
  dmDockInit();
  dmLoad().then(()=>{
    // Unread waiting at open gets said out loud once — the pip alone was easy to miss.
    const n=dmUnreadTotal();
    if(n) pushToast('💬 '+n+' unread message'+(n===1?'':'s')+' — open Messages');
    return dmSync();
  });
}
else { const b=el('tab-dm'); if(b) b.hidden=true; }
}


// ---- the chat dock -----------------------------------------------------------------------------
// The Ask console's twin, bottom-left: conversations reachable from ANY tab, one click. The dock
// lists the rail (unread first-class, red count on the button) and jumping into one lands on the
// Messages tab with that conversation open.
function dmDockRows(){
  const rows=dmState.threads.filter(t=>!t.hidden).slice(0,8).map(t=>
    '<div role="button" tabindex="0" class="dm-th" data-dockth="'+t.id+'"><div class="dm-thn">'
    +(t.kind==='dm'?'<span class="'+(dmState.online.has(t.peer)?'dm-on':'dm-off')+'">●</span> ':'<span class="dm-grp">#</span> ')
    +esc(t.name)
    +((t.unread&&!t.muted)?'<span class="dm-badge">'+(t.unread>99?'99+':t.unread)+'</span>':'')+'</div>'
    +'<div class="dm-thp">'+esc(t.preview||'no messages yet')+'</div></div>');
  return rows.join('')||'<div class="dm-empty">No conversations yet.</div>';
}
function dmDockToggle(){
  const p=el('dm-dockpanel'); if(!p) return;
  if(p.hidden){
    p.innerHTML='<div class="dm-sh" style="padding:10px 14px 7px">Messages</div>'+dmDockRows()
      +'<div class="dm-dockfoot" id="dm-dockopen">open messages ↗</div>';
    p.hidden=false;
  } else p.hidden=true;
}
function dmDockInit(){
  if(el('dm-dock')) return;
  const b=document.createElement('button');
  b.type='button'; b.id='dm-dock'; b.className='term-fab';
  b.title='Messages — your conversations, from any tab';
  b.innerHTML='<span class="tf-ic">💬</span><span class="tf-t">Chat</span><span class="dm-dockpip" id="dm-dockpip" hidden></span>';
  document.body.appendChild(b);
  const p=document.createElement('div');
  p.id='dm-dockpanel'; p.hidden=true;
  document.body.appendChild(p);
  b.addEventListener('click',(e)=>{ e.stopPropagation(); dmDockToggle(); });
  p.addEventListener('click',(e)=>{
    const row=e.target.closest('[data-dockth]');
    if(row){ p.hidden=true; showView('dm'); dmOpenThread(+row.dataset.dockth); return; }
    if(e.target.closest('#dm-dockopen')){ p.hidden=true; showView('dm'); }
  });
  document.addEventListener('click',(e)=>{ if(!p.hidden&&(!e.target.closest||!e.target.closest('#dm-dock,#dm-dockpanel'))) p.hidden=true; });
}
export { dmKeys, dmLoad, dmRefreshOpen, dmRender, dmState, dmSync, dmSysLine, dmTypingFrame, openDM };
