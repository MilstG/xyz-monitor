// notes.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { IS_ADMIN, attachLineHover, featureOn, hoverChart, lcGrid, lcTicks, sLeg } from "./admin.js";
import { showView } from "./backtest.js";
import { earnDiffC, earnFilingHtml, earnNext, earnSessLbl, loadEarnings, macroDayLbl, macroList, macroRangeFmt, macroRowHtml, macroStateC } from "./calendar.js";
import { DAY, G, el, esc, fmtPrice, fmtUsd, state } from "./core.js";
import { fetchJSON } from "./data.js";
import { closeDetail, openDetail } from "./drawer.js";
import { render } from "./markets.js";
import { forceRefresh } from "./nav.js";

let NOTES_WRITE;   // assigned in __boot (impure initializers keep their original order)


// ===== per-ticker notes (build 2026.08.24-01) ==================================================
// Two data paths, deliberately: the markets table paints its markers off the {n,ts,px} digest that
// already rides every snapshot row (r.nt), so a note costs the 15s poll nothing; the bodies come
// from /api/notes, fetched once and refetched only when a write moves the revision or the digest
// disagrees with what we hold. The drawer and the tab read the same in-memory book.
const NOTE_FRESH_D = 7, NOTE_WARM_D = 30;
// Notes are keyed by coin and DISPLAYED by ticker, so a market rename moves the note with the
// market instead of orphaning it. Falls back to the coin when the board no longer carries the row.
function noteTicker(coin){ const r=state.rows?state.rows.get(coin):null;
  if(r&&r.ticker) return r.ticker;
  // No row: the market left the universe. Show the bare symbol rather than the dex-prefixed
  // storage key — 'FTM' is what the operator wrote the note about, 'xyz:FTM' is bookkeeping.
  const c=String(coin||''), i=c.indexOf(':'); return i>0?c.slice(i+1):c; }
let _notesLast = 0, _notesLoading = null;

export function __boot_notes_8010() {   // calendar days — see the age classes in styles.css
// Two locks, same as every other write in this app: the manifest act key decides audience, the
// admin cookie decides authz, and the server re-checks both. This only hides the pen.
NOTES_WRITE = IS_ADMIN && featureOn('notes.write'); G._notesSeenSnap = 0;
}

// Age is CALENDAR time and only calendar time. The rejected alternative was scaling by the name's
// own volatility; it would move the marker when the MARKET changed rather than when the note did,
// so a note written Tuesday would brighten through Thursday because realised vol came in.
function noteAgeDays(ts){ return Math.max(0, Math.floor((Date.now()-ts)/DAY)); }
function noteAgeCls(d){ return d<=NOTE_FRESH_D?'fresh':d<=NOTE_WARM_D?'warm':'cold'; }
function noteAgeTxt(d){
  return d===0?'today':d===1?'yesterday':d<30?d+'d ago':d<365?Math.round(d/30)+'mo ago':(d/365).toFixed(1)+'y ago';
}
// The move since the note was written — the whole reason the px stamp exists. Null (not zero) when
// either end is missing: a note written with no mark available has no move to report.
function noteSince(n, r){
  if(!n||!r||!n.px||!isFinite(n.px)||n.px<=0||r.px==null||!isFinite(r.px)) return null;
  return (r.px/n.px-1)*100;
}
function noteSinceHtml(v){ return v==null?'':`<span class="${v>=0?'pos':'neg'}">${v>=0?'+':'−'}${Math.abs(v).toFixed(1)}%</span>`; }
const NOTE_TAG_RE = /#[a-z0-9][a-z0-9_-]{0,23}/gi;
function noteTags(body){
  const out=[]; for(const m of String(body||'').match(NOTE_TAG_RE)||[]){ const t=m.slice(1).toLowerCase(); if(!out.includes(t)) out.push(t); }
  return out;
}
// Escape FIRST, then linkify the tags — never the other way round, or a body containing markup
// would have it re-introduced by the replace.
function noteBodyHtml(body){
  return esc(body).replace(NOTE_TAG_RE, m=>`<span class="nt-tag" data-ntag="${esc(m.slice(1).toLowerCase())}">${m}</span>`);
}
const NOTE_PIT_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><path class="pbody" d="M1 1 H11 V7.5 L7.5 11 H1 Z"/><path class="pfold" d="M11 7.5 H7.5 V11 Z"/></svg>';
// The markets-table marker. Absent when the name has no note — an always-drawn hollow outline would
// sit next to the ☆ and mean nothing. Reads the snapshot digest, so it needs no fetch.
function noteBadge(r){
  const d = r.nt; if(!d||!d.n) return '';
  const days = noteAgeDays(d.ts), cls = noteAgeCls(days);
  // Hover carries the actual read: the newest note's first line, its age, and the move since.
  const book = state.notes ? notesFor(r.coin) : null;
  const newest = book&&book.length?book[0]:null;
  let t = `${d.n} note${d.n>1?'s':''} · newest ${noteAgeTxt(days)}`;
  if(newest){ const f=newest.body.split('\n')[0]; t += `\n"${f.length>96?f.slice(0,95)+'…':f}"`; }
  if(d.px){ const sc=noteSince({px:d.px}, r);
    t += `\nwritten at ${fmtPrice(d.px)}` + (sc==null?'':` · ${sc>=0?'+':'−'}${Math.abs(sc).toFixed(1)}% since`); }
  return `<span class="pit ${cls}" tabindex="0" role="button" data-pit="${esc(r.coin)}" title="${esc(t)}">`
    + NOTE_PIT_SVG + (d.n>1?`<i class="pn">${d.n}</i>`:'') + '</span>';
}
async function loadNotes(force){
  if(_notesLoading) return _notesLoading;
  _notesLoading = (async()=>{
    try{ const d = await fetchJSON('/api/notes');
      if(d&&Array.isArray(d.notes)){ state.notes = d.notes; state.notesRev = d.rev; _notesLast = Date.now(); }
    }catch(_){}
    finally{ _notesLoading = null; }
  })();
  return _notesLoading;
}
// The digest on the snapshot is the source of truth for "is our book current". If the counts
// disagree with what we hold, a write happened somewhere (another browser, another admin) and the
// bodies are refetched. Cheap: one comparison per render, one fetch only when they diverge.
function notesStale(){
  if(!state.notes||!state.rows) return true;
  for(const r of state.rows.values()) if(r.nt&&r.nt.n){
    if(notesFor(r.coin).length!==r.nt.n) return true;
  }
  return false;
}
function notesFor(coin){ return (state.notes||[]).filter(n=>n.coin===coin); }

// ---- drawer panel ----------------------------------------------------------------------------
// Sits ABOVE the charts on purpose: everything else in the drawer is the server's read of the
// name; the note is yours, and it is what you want to hit before re-deriving an opinion from the
// same metrics that produced it last time.
function noteDrawerHtml(r){
  if(!NOTES_WRITE && !notesFor(r.coin).length) return '';   // nothing to show and nothing to add
  return `<div class="nt-head"><div class="dsec" style="margin-bottom:8px">Notes</div>`
    + (NOTES_WRITE?`<button class="nt-new" id="ntNew" style="margin-bottom:8px">＋ note</button>`:'')
    + `</div><div class="nt-compose" id="ntCompose" hidden>`
    + `<textarea class="nt-box" id="ntBox" maxlength="2000" placeholder="What do you actually think about this name? A level, a reason, a rule for yourself. #tags work."></textarea>`
    + `<div class="nt-crow"><span class="nt-stamp" id="ntStamp"></span>`
    + `<button class="nt-btn ghost" id="ntCancel">cancel</button><button class="nt-btn" id="ntSave" disabled>save note</button></div>`
    + `<div class="nt-err" id="ntErr" hidden></div></div><div id="ntList"></div>`;
}
function renderDrawerNotes(coin){
  const list = el('ntList'); if(!list) return;
  const r = state.rows ? state.rows.get(coin) : null;
  const ns = notesFor(coin);
  list.innerHTML = ns.length ? ns.map(n=>{
    const d = noteAgeDays(n.at), sc = noteSince(n, r);
    const since = n.px ? `<span class="nt-since" title="${esc('the mark has moved from '+fmtPrice(n.px)+' (when you wrote this) to '+(r&&r.px!=null?fmtPrice(r.px):'—')+' now')}">wrote it at ${fmtPrice(n.px)}${sc==null?'':' · '+noteSinceHtml(sc)+' since'}</span>` : '';
    return `<div class="nt-item${noteAgeCls(d)==='cold'?' cold':''}">`
      + `<div class="nt-body">${noteBodyHtml(n.body)}</div>`
      + `<div class="nt-meta"><span class="age" title="${esc(new Date(n.at).toLocaleString())}">${noteAgeTxt(d)}</span>${since}`
      + (n.edited?'<span title="the body was rewritten — the price stamp still measures from when the note was FIRST written, because that is when the claim was made">· edited</span>':'')
      + (NOTES_WRITE?`<span class="nt-act"><button data-nedit="${n.id}">edit</button><button class="del" data-ndel="${n.id}">delete</button></span>`:'')
      + `</div></div>`;
  }).join('')
    : `<div class="nt-empty">Nothing written on ${esc(r?r.ticker:coin)} yet.${NOTES_WRITE?' Notes are kept on the server and never expire — they only fade.':''}</div>`;
}
let _ntEditing = null;
function ntStampTxt(coin){
  const r = state.rows ? state.rows.get(coin) : null;
  if(_ntEditing){ const n=(state.notes||[]).find(x=>x.id===_ntEditing);
    return n&&n.px?'keeps its original stamp of '+fmtPrice(n.px):'keeps its original stamp'; }
  return r&&r.px!=null?'stamps at '+fmtPrice(r.px):'no live mark — this note saves without a price stamp';
}
function ntOpenCompose(coin, id){
  _ntEditing = id||null;
  const box=el('ntBox'), cmp=el('ntCompose'); if(!box||!cmp) return;
  const n = id?(state.notes||[]).find(x=>x.id===id):null;
  let draft=''; if(!n){ try{ draft=sessionStorage.getItem(ntDraftKey(coin))||''; }catch(_){} }   // a half-typed note survives the drawer closing
  cmp.hidden=false; box.value=n?n.body:draft;
  el('ntSave').disabled=!box.value.trim();
  el('ntSave').textContent=n?'save edit':'save note';
  el('ntStamp').textContent=ntStampTxt(coin);
  el('ntStamp').title=_ntEditing
    ? 'an edit rewrites the body and nothing else — the claim was made at the original price, and a record whose author can move its own goalposts is not a record'
    : 'the mark at the moment you save, frozen into the note so the move since can be measured against what you were actually looking at';
  const err=el('ntErr'); if(err){ err.hidden=true; err.textContent=''; }
  box.focus();
}
// Closing with text in the box asks first — Escape is a habit here and it used to wipe a note.
function ntCloseCompose(force){ const b=el('ntBox');
  if(!force&&b&&b.value.trim()&&!confirm('Discard this note? The text will be lost.')) return;
  _ntEditing=null; const c=el('ntCompose'); if(c){ c.hidden=true; if(b) b.value=''; } }
const ntDraftKey=(coin)=>'nt.draft|'+coin;
async function ntWrite(body, coin){
  const save=el('ntSave'), err=el('ntErr');
  if(save) save.disabled=true;
  try{
    const b = _ntEditing?{id:_ntEditing, body}:{coin, body};
    const res = await fetch('/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
    const d = await res.json().catch(()=>null);
    if(!d||!d.ok){
      if(err){ err.hidden=false; err.textContent = d&&d.error==='not-admin'
        ? 'Notes are admin-only on this board — this note was not saved.'
        : (d&&d.error? d.error : 'Could not save the note. It is still in the box — try again.'); }
      if(save) save.disabled=false;
      return false;
    }
    try{ sessionStorage.removeItem(ntDraftKey(coin)); }catch(_){}
    ntCloseCompose(true);
    await loadNotes(true);
    renderDrawerNotes(coin);
    render();                      // repaint the markers off the refreshed book
    if(el('view-notes')&&!el('view-notes').hidden) renderNotes();
    forceRefresh();                // pull a snapshot so r.nt agrees with the book we just changed
    return true;
  }catch(_){
    if(err){ err.hidden=false; err.textContent='Could not reach the server. The note is still in the box.'; }
    if(save) save.disabled=false;
    return false;
  }
}
// Delegated once on the drawer, not rebound per render — the panel's innerHTML is replaced on
// every note write, and per-render handlers would leak one listener per keystroke-to-save cycle.
function wireDrawerNotes(coin){
  const nn=el('ntNew'); if(nn) nn.onclick=()=>ntOpenCompose(coin,null);
  const cancel=el('ntCancel'); if(cancel) cancel.onclick=ntCloseCompose;
  const box=el('ntBox');
  if(box){
    box.oninput=()=>{ el('ntSave').disabled=!box.value.trim(); };
    box.addEventListener('input',()=>{ try{ if(!_ntEditing) sessionStorage.setItem(ntDraftKey(coin), box.value); }catch(_){} });
    box.onkeydown=e=>{ if(e.key==='Escape'){ e.stopPropagation(); ntCloseCompose(); }
      if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){ e.preventDefault(); const s=el('ntSave'); if(s&&!s.disabled) s.click(); } };
  }
  const save=el('ntSave'); if(save) save.onclick=()=>{ const b=el('ntBox').value.trim(); if(b) ntWrite(b, coin); };
  const list=el('ntList');
  if(list) list.onclick=e=>{
    const tag=e.target.closest('[data-ntag]');
    if(tag){ state.noteTag=tag.dataset.ntag; state.noteQ=''; closeDetail(); showView('notes'); return; }
    const ed=e.target.closest('[data-nedit]'); if(ed) return ntOpenCompose(coin, +ed.dataset.nedit);
    const del=e.target.closest('[data-ndel]');
    if(del){ const n=(state.notes||[]).find(x=>x.id===+del.dataset.ndel);
      if(n&&confirm('Delete this note?\n\n"'+(n.body.length>140?n.body.slice(0,139)+'…':n.body)+'"\n\nThis cannot be undone.')){
        _ntEditing=null;
        fetch('/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:n.id,drop:true})})
          .then(r=>r.json()).then(async d=>{ if(d&&d.ok){ await loadNotes(true); renderDrawerNotes(coin); render();
            if(el('view-notes')&&!el('view-notes').hidden) renderNotes(); forceRefresh(); } }).catch(()=>{});
      } }
  };
  renderDrawerNotes(coin);
}

// ---- Notes tab -------------------------------------------------------------------------------
function openNotes(){ renderNotes(); if(!state.notes||Date.now()-_notesLast>60*1000) loadNotes().then(renderNotes); }
function renderNotes(){
  const host=el('notes-body'); if(!host) return;
  const all = state.notes||[];
  const tags={}; all.forEach(n=>noteTags(n.body).forEach(t=>{ tags[t]=(tags[t]||0)+1; }));
  const q=(state.noteQ||'').toLowerCase();
  // Sorted HERE, not inherited. The server ships newest-first, but this view buckets by age and
  // a book that arrives out of order renders repeating day headers — a correctness bug that
  // depends on someone else's invariant holding. One sort makes the view answer for itself.
  let list=all.slice().sort((a,b)=>b.at-a.at);
  if(state.noteTag) list=list.filter(n=>noteTags(n.body).includes(state.noteTag));
  if(q) list=list.filter(n=>(n.body+' '+noteTicker(n.coin)).toLowerCase().includes(q));
  const chips=Object.keys(tags).sort((a,b)=>tags[b]-tags[a]||a.localeCompare(b)).slice(0,12)
    .map(t=>`<button class="tagchip${state.noteTag===t?' on':''}" data-ntag="${esc(t)}">#${esc(t)} <span class="sec">${tags[t]}</span></button>`).join('');
  let rows='';
  if(!list.length){
    rows = `<div class="ntb-none">${all.length
      ? 'No note matches'+(state.noteTag?' #'+esc(state.noteTag):'')+(q?' containing “'+esc(state.noteQ)+'”':'')+'.'
      : 'No notes yet. Open any ticker’s drawer and write one — it is stamped with the price at that moment, so it carries the move since.'}</div>`;
  } else {
    let bucket=null;
    for(const n of list){
      const d=noteAgeDays(n.at), cls=noteAgeCls(d);
      const row=state.rows?state.rows.get(n.coin):null, r=(row&&!row.delisted)?row:null;
      const sc=noteSince(n,r);
      const b = d<=1?'Today & yesterday':d<=7?'This week':d<=30?'This month':d<=90?'Older than a month':'Older than a quarter';
      if(b!==bucket){ rows+=`<div class="ntb-day">${b}</div>`; bucket=b; }
      // A note outlives its market: a name rotated out of the universe keeps its note, greyed and
      // labelled, because a record that silently drops rows is not one.
      const side = r
        ? `<b>${noteAgeTxt(d)}</b>${n.px?'wrote it at '+fmtPrice(n.px)+'<br>now '+(r.px!=null?fmtPrice(r.px):'—')+(sc==null?'':' · '+noteSinceHtml(sc)):'no price stamp'}`
        : `<b>${noteAgeTxt(d)}</b>${n.px?'wrote it at '+fmtPrice(n.px)+'<br>':''}<span class="na">market gone</span>`;
      const sideT = r
        ? (sc==null?'this note carries no price stamp, so there is no move to measure':'the mark has moved '+(sc>=0?'+':'−')+Math.abs(sc).toFixed(1)+'% since you wrote this')
        : 'this market is no longer in the universe, so there is no live price to measure against — the note is kept anyway';
      rows += `<div class="ntb-row ${r?(cls==='cold'?'cold':''):'gone'}"${r?` data-nopen="${esc(n.coin)}"`:''}>`
        + `<div class="ntb-tk">${esc(noteTicker(n.coin))}<span class="pit ${cls}" style="cursor:inherit">${NOTE_PIT_SVG}</span>`
        + (r?'':'<span class="sub">NOT IN UNIVERSE</span>') + `</div>`
        + `<div class="ntb-mid"><div class="nt-body">${noteBodyHtml(n.body)}</div></div>`
        + `<div class="ntb-side" title="${esc(sideT)}">${side}</div></div>`;
    }
  }
  host.innerHTML = `<div class="ntb-bar"><input class="ntb-q" id="ntbQ" placeholder="search your notes…" autocomplete="off" spellcheck="false" value="${esc(state.noteQ||'')}">`
    + `<div style="display:flex;gap:6px;flex-wrap:wrap">${chips}</div>`
    + `<span class="ntb-count">${list.length===all.length?all.length+' note'+(all.length===1?'':'s'):list.length+' of '+all.length+' notes'}</span></div>${rows}`;
  const qi=el('ntbQ');
  if(qi){ qi.oninput=e=>{ state.noteQ=e.target.value; renderNotes(); const f=el('ntbQ'); if(f){ f.focus(); f.setSelectionRange(f.value.length,f.value.length); } }; }
  host.querySelectorAll('[data-ntag]').forEach(b=>b.onclick=e=>{
    e.stopPropagation(); state.noteTag = state.noteTag===b.dataset.ntag?null:b.dataset.ntag; renderNotes(); });
  host.querySelectorAll('[data-nopen]').forEach(rw=>rw.onclick=e=>{
    if(e.target.closest('[data-ntag]')) return;
    openDetail(rw.dataset.nopen); });
}

// ---- Liquidity tab (build 2026.08.21-04) ----------------------------------------------------
// Fed net liquidity board off /api/liquidity. Same contract as Housing: paint from cache, refetch
// when stale, window client-side, every chart on the shared crosshair.
let _liqLast=0;
async function loadLiquidity(){
  _liqLast=Date.now();
  try{ const d=await fetchJSON('/api/liquidity');
    if(d&&d.levels){ state.liq=d; if(el('view-liquidity')&&!el('view-liquidity').hidden) renderLiquidity(); }
  }catch(_){}
}
function openLiquidity(){ renderLiquidity(); if(Date.now()-_liqLast>60*1000) loadLiquidity(); }
function liqB(v){ if(v==null||!isFinite(v)) return '—'; const a=Math.abs(v); return (v<0?'−':'')+(a>=1000?'$'+(a/1000).toFixed(2)+'T':a>=10?'$'+a.toFixed(0)+'B':'$'+a.toFixed(1)+'B'); }
function liqSigned(v,unit){ if(v==null||!isFinite(v)) return '<span class="sec">—</span>'; const c=v>0?'pos':v<0?'neg':'sec'; return `<span class="${c}">${v>0?'+':v<0?'−':''}${unit==='bp'?Math.abs(v).toFixed(0)+'bp':liqB(Math.abs(v))}</span>`; }
// categorical signed bars (YTD by component); items = [{label, effect, delta, net?}]
function liqBarsSvg(items){
  const W=560,H=220,pl=48,pr=12,pt=14,pb=34;
  if(!items||!items.length) return '<div class="msg sec" style="padding:30px 0">no YTD data</div>';
  let lo=0,hi=0; for(const it of items){ lo=Math.min(lo,it.effect); hi=Math.max(hi,it.effect); }
  const pad=(hi-lo)*0.12||1; lo-=pad; hi+=pad;
  const ticks=lcTicks(lo,hi,4), n=items.length, bw=(W-pl-pr)/n;
  const X=i=>pl+bw*(i+0.5), Y=v=>pt+(H-pt-pb)*(1-(v-lo)/(hi-lo));
  let s=lcGrid(pl,W-pr,ticks,Y,v=>(v<0?'−':'')+'$'+Math.abs(v).toFixed(0)+'B');
  s+=`<line x1="${pl}" y1="${Y(0).toFixed(1)}" x2="${W-pr}" y2="${Y(0).toFixed(1)}" stroke="var(--faint)"/>`;
  items.forEach((it,i)=>{ const y0=Y(0),y1=Y(it.effect); const top=Math.min(y0,y1), h=Math.max(1.5,Math.abs(y1-y0));
    const fill = it.net ? (it.effect>=0?'var(--up)':'var(--down)') : (it.effect>=0?'var(--blue)':'var(--accent)');
    s+=`<rect x="${(X(i)-bw*0.34).toFixed(1)}" y="${top.toFixed(1)}" width="${(bw*0.68).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" rx="2"/>`;
    s+=`<text x="${X(i).toFixed(1)}" y="${(it.effect>=0?top-5:top+h+11).toFixed(1)}" text-anchor="middle" class="lc-tick" style="fill:var(--text)">${(it.effect>=0?'+':'−')+Math.abs(it.effect).toFixed(0)}</text>`;
    s+=`<text x="${X(i).toFixed(1)}" y="${H-8}" text-anchor="middle" class="lc-tick">${it.label}</text>`; });
  const xs=items.map((_,i)=>X(i)), rows=items.map(it=>`<div class="sec">${it.label}${it.net?'':' · '+(it.effect>=0?'adds':'drains')+' liquidity'}</div><div><b>${(it.effect>=0?'+':'−')}${liqB(Math.abs(it.effect))}</b>${it.net?'':` <span class="sec">(level ${it.delta>=0?'+':'−'}${liqB(Math.abs(it.delta))})</span>`}</div>`);
  return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});
}
// N-series stacked area; series = [{label,color,op,pts:[[d,v]]}] aligned on the first series' dates
function liqStackSvg(series,o){
  o=o||{}; const W=o.w||1140,H=o.h||220,pl=52,pr=12,pt=10,pb=20;
  const base=series[0].pts; if(!base||base.length<2) return '<div class="msg sec" style="padding:30px 0">not enough data in this window</div>';
  const maps=series.map(sr=>new Map(sr.pts.map(p=>[p[0],p[1]])));
  const rows0=base.map(p=>[p[0],...maps.map(m=>m.get(p[0])||0)]);
  let hi=0; for(const r of rows0){ let t=0; for(let k=1;k<r.length;k++) t+=r[k]; hi=Math.max(hi,t); } hi*=1.06;
  const ticks=lcTicks(0,hi,4);
  const X=i=>pl+(W-pl-pr)*(i/(rows0.length-1)), Y=v=>pt+(H-pt-pb)*(1-v/hi);
  let s=lcGrid(pl,W-pr,ticks,Y,v=>liqB(v));
  s+=hsgXLabels(rows0,W,pl,pr).replace(/__YB__/g,(H-4).toFixed(1));
  // paint top-down so each lower layer covers the one above down to the baseline
  for(let k=series.length;k>=1;k--){
    const d=rows0.map((r,i)=>{ let t=0; for(let j=1;j<=k;j++) t+=r[j]; return (i?'L':'M')+X(i).toFixed(1)+' '+Y(t).toFixed(1); }).join('')+`L${X(rows0.length-1).toFixed(1)} ${Y(0).toFixed(1)}L${X(0).toFixed(1)} ${Y(0).toFixed(1)}Z`;
    s+=`<path d="${d}" fill="${series[k-1].color}" opacity="${series[k-1].op||.8}"/>`;
    if(k>1) s+=`<path d="${rows0.map((r,i)=>{ let t=0; for(let j=1;j<k;j++) t+=r[j]; return (i?'L':'M')+X(i).toFixed(1)+' '+Y(t).toFixed(1); }).join('')}" fill="none" stroke="var(--panel)" stroke-width="1.2"/>`;
  }
  const xs=rows0.map((_,i)=>X(i)), rows=rows0.map(r=>`<div class="sec">${hsgDate(r[0])}</div>`+series.map((sr,k)=>`<div><span class="sw" style="background:${sr.color}"></span>${sr.label} <b>${liqB(r[k+1])}</b></div>`).join(''));
  return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});
}
function liqCard(title,chip,kpis,chart,cap,wide){
  return `<div class="s-card hsg-card${wide?' hsg-wide':''}"><div class="hsg-head"><span class="hsg-title">${title}</span>${chip||''}</div>`+(kpis?`<div class="hsg-kpis">${kpis}</div>`:'')+chart+(cap?`<div class="s-cap">${cap}</div>`:'')+`</div>`;
}
function liqChip(sid,kind,tip){ return `<span class="src-chip ${kind||'direct'}" title="${esc(tip||'')}"><i></i>${kind==='proxy'?'Ours':'Direct'} · ${esc(sid)}</span>`; }
function renderLiquidity(){
  const root=el('liq-body'); if(!root) return;
  const d=state.liq;
  document.querySelectorAll('#liqwin button').forEach(b=>b.classList.toggle('active',b.dataset.w===state.liqWin));
  if(!d){ root.innerHTML='<div class="msg">Loading…</div>'; return; }
  const L=d.levels||{}, D=d.derived;
  if(!Object.keys(L).length){ root.innerHTML=`<div class="msg err">Liquidity board unavailable — ${esc(d.error||'not fetched yet')}.<div class="sec" style="margin-top:6px">Set <b>FRED_KEY</b> on the server and the board fills on the next pass.</div></div>`; return; }
  const win=state.liqWin, from=hsgWindowStart(win);
  const cut=pts=>(pts||[]).filter(p=>p[0]>=from);
  const tile=(k,label,extra)=>{ const x=L[k]; if(!x) return '';
    const v = x.unit==='%' ? x.v.toFixed(2)+'%' : liqB(x.v);
    return `<div class="stat"><span class="k">${label}</span><span class="v">${v}</span><span style="font-size:11px">${x.chg!=null?liqSigned(x.chg,x.unit==='%'?'bp':'$'):''} <span class="sec">w/w · ${esc(x.sid)}</span>${extra||''}</span></div>`; };
  const qt = D&&D.qtEnd ? `<div class="sec" style="font-size:10.5px">QT end (derived): ${hsgDate(D.qtEnd)}</div>` : '';
  const netTile = D ? `<div class="stat" style="border-left:1px solid var(--border);padding-left:18px"><span class="k">Net liquidity</span><span class="v" style="color:var(--accent)">${liqB(D.last.v)}</span><span style="font-size:11px">${D.prev?liqSigned(+(D.last.v-D.prev.v).toFixed(1)):''} <span class="sec">w/w · ${D.last.pctGdp!=null?D.last.pctGdp.toFixed(1)+'% of GDP':''}</span></span></div>` : '';
  const tiles=`<div class="hsg-tiles">`+tile('assets','Total assets')+tile('ust','Treasuries',qt)+tile('agency','Agency debt')+tile('mbs','MBS')+tile('tga','TGA')+tile('rrp','ON RRP')+netTile+
    `<div class="stat" style="margin-left:auto"><span class="k">As of</span><span class="v" style="font-size:13px">${d.asOf?new Date(d.asOf).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—'}</span><span class="sec" style="font-size:11px">H.4.1 · ${D?hsgDate(D.last.d):''}</span></div></div>`;
  const cards=[];
  if(D){
    const netPts=cut(D.net.map(p=>[p[0],p[1]]));
    cards.push(liqCard('Net liquidity',liqChip('WALCL − WTREGEN − RRPONTSYD','direct','Total assets minus TGA minus ON RRP, on H.4.1 Wednesday dates. All in billions.'),
      `<span class="hsg-v">${liqB(D.last.v)}</span><span class="sec hsg-d">${hsgDate(D.last.d)}</span>${D.prev?liqSigned(+(D.last.v-D.prev.v).toFixed(1)):''}<span class="sec">w/w</span>`,
      hsgLineSvg({unit:'$B',dp:0,k:'net'},netPts,{color:'var(--accent)'}),
      null));
    const ytdItems=D.ytd.items.map(it=>({label:it.label,effect:it.effect,delta:it.delta})).concat(D.ytd.net!=null?[{label:'NET Δ',effect:D.ytd.net,net:true}]:[]);
    const driver=D.ytd.items.slice().sort((a,b)=>Math.abs(b.effect)-Math.abs(a.effect))[0];
    cards.push(liqCard('Year-to-date change by component',`<span class="src-chip direct"><i></i>${D.ytd.from?hsgDate(D.ytd.from):'Jan 1'} → ${hsgDate(D.ytd.to)}</span>`,
      `<span class="hsg-v ${D.ytd.net>=0?'pos':'neg'}">${D.ytd.net>=0?'+':'−'}${liqB(Math.abs(D.ytd.net))}</span><span class="sec hsg-d">net liquidity YTD</span>`+sLeg([{color:'var(--blue)',label:'adds liquidity'},{color:'var(--accent)',label:'drains liquidity'}]),
      liqBarsSvg(ytdItems),
      driver?`Largest driver: <b>${esc(driver.label)}</b> ${driver.effect>=0?'added':'drained'} ${liqB(Math.abs(driver.effect))}. Bars are signed by liquidity effect — TGA and ON RRP add when they <i>fall</i>.`:''));
    const gdpPts=cut(D.net.filter(p=>p[2]!=null).map(p=>[p[0],p[2]]));
    cards.push(liqCard('Net liquidity as % of nominal GDP',liqChip('÷ GDP','direct','Quarterly BEA nominal GDP, forward-filled to each weekly print.'),
      `<span class="hsg-v">${D.last.pctGdp!=null?D.last.pctGdp.toFixed(1)+'%':'—'}</span><span class="sec hsg-d">${hsgDate(D.last.d)}</span><span class="sec">peak ${D.peak.pctGdp!=null?D.peak.pctGdp.toFixed(1)+'%':'—'} · ${hsgDate(D.peak.d)}</span>`,
      hsgLineSvg({unit:'%',dp:1},gdpPts,{color:'var(--blue)',zero:win==='max'}),
      D.last.pctGdp!=null&&D.peak.pctGdp!=null?`${(D.peak.pctGdp-D.last.pctGdp).toFixed(1)}pt below the ${hsgDate(D.peak.d)} peak.`:''));
  }
  if(L.reserves) cards.push(liqCard('Bank reserves',liqChip('WRESBAL','proxy','Reserve balances with Federal Reserve Banks — not on the source page; added because it is what the Fed actually targets as "ample".'),
    `<span class="hsg-v">${liqB(L.reserves.v)}</span><span class="sec hsg-d">${hsgDate(L.reserves.d)}</span>${liqSigned(L.reserves.chg)}<span class="sec">w/w</span>`,
    hsgLineSvg({unit:'$B',dp:0},cut(L.reserves.obs),{color:'var(--muted)'}),
    'The 2019 repo spike hit with reserves near $1.4T; the Fed’s own "ample" estimates sit around 10–12% of GDP.'));
  if(D&&D.sofrIorb&&D.sofrIorb.length){ const si=D.sofrIorb, last=si[si.length-1];
    cards.push(liqCard('SOFR − IORB',liqChip('SOFR, IORB','proxy','Overnight funding rate minus interest on reserve balances, in bp — not on the source page; the earliest read on reserve scarcity.'),
      `<span class="hsg-v ${last[1]>0?'neg':'pos'}">${last[1]>0?'+':''}${last[1]}bp</span><span class="sec hsg-d">${hsgDate(last[0])}</span>`,
      hsgLineSvg({unit:'bp',dp:0},cut(si),{color:'var(--down)'}),
      'Persistently positive = collateral scarce, reserves getting tight. Negative = cash abundant.')); }
  let stack='';
  if(L.ust&&L.mbs&&L.agency){
    stack=liqCard('Balance-sheet composition',liqChip('TREAST · WSHOMCB · FEDDT','direct','The three securities holdings; the gap to total assets is loans, repo and other assets.'),
      null, sLeg([{color:'var(--blue)',label:'Treasuries'},{color:'var(--accent)',label:'MBS'},{color:'var(--muted)',label:'Agency debt'}])+
      liqStackSvg([{label:'Treasuries',color:'var(--blue)',op:.75,pts:cut(L.ust.obs)},{label:'MBS',color:'var(--accent)',op:.6,pts:cut(L.mbs.obs)},{label:'Agency debt',color:'var(--muted)',op:.8,pts:cut(L.agency.obs)}]),
      null,true);
  }
  let drains='';
  if(L.tga&&L.rrp){
    drains=liqCard('The drains — TGA and ON RRP',liqChip('WTREGEN · RRPONTSYD','direct','What sits at the Fed outside the banking system. Higher = less liquidity for markets.'),
      null, sLeg([{color:'var(--accent)',label:'TGA'},{color:'var(--down)',label:'ON RRP (sampled on the H.4.1 Wednesday)'}])+
      liqStackSvg([{label:'TGA',color:'var(--accent)',op:.6,pts:cut(L.tga.obs)},{label:'ON RRP',color:'var(--down)',op:.55,pts:cut(D?D.net.map(p=>[p[0],p[5]]):L.rrp.obs)}]),
      null,true);
  }
  const missing=(d.missing&&d.missing.length)?`<div class="s-cap" style="margin-top:10px">Absent this pass (not shown stale): ${d.missing.map(esc).join(', ')}</div>`:'';
  const errl=d.error?`<div class="s-cap" style="margin-top:10px;color:var(--down)">Last refresh failed — showing the previous board. ${esc(d.error)}</div>`:'';
  root.innerHTML=tiles+`<div class="s-grid">${cards.join('')}</div>`+stack+drains+missing+errl;
  attachLineHover();
}

// ---- Housing tab (build 2026.08.21-04) ------------------------------------------------------
// FRED-fed macro housing / MBS board. Paints from the cached payload, refetches when stale, and
// every chart rides the shared hoverChart crosshair. Windowing is client-side over the full
// history the server ships, so the seg switch never costs a request.
let _hsgLast=0;
async function loadHousing(){
  _hsgLast=Date.now();
  try{ const d=await fetchJSON('/api/housing');
    if(d&&d.series){ state.housing=d; if(el('view-housing')&&!el('view-housing').hidden) renderHousing(); }
  }catch(_){}
}
function openHousing(){ renderHousing(); if(Date.now()-_hsgLast>60*1000) loadHousing(); }
function hsgWindowStart(win){
  const y=new Date().getUTCFullYear();
  if(win==='1y') return new Date(Date.now()-366*864e5).toISOString().slice(0,10);
  if(win==='5y') return (y-5)+'-01-01';
  return '1900-01-01';
}
function hsgSlice(ser,win){ const from=hsgWindowStart(win); return (ser&&ser.obs||[]).filter(o=>o[0]>=from); }
function hsgNum(v,d){ return (v==null||!isFinite(v))?'—':(+v).toFixed(d); }   // a FRED "." observation lands as null; one unguarded toFixed blanked the whole tab
function hsgFmt(v,ser){ if(v==null||!isFinite(v)) return '—';
  if(ser.unit==='$B') return liqB(v);
  if(ser.unit==='$k') return '$'+v.toFixed(0)+'k';
  if(ser.unit==='%') return v.toFixed(ser.dp)+'%';
  if(ser.unit==='bp') return v.toFixed(0)+'bp';
  if(ser.unit==='M saar') return v.toFixed(2)+'M';
  return v.toFixed(ser.dp); }
function hsgDate(d){ try{ return new Date(d+'T00:00:00Z').toLocaleDateString('en-US',{month:'short',year:'2-digit',timeZone:'UTC'}); }catch(_){ return d; } }
function hsgXLabels(pts,W,pl,pr){
  // year ticks at the first observation of each year; thin to <=8 labels
  const idx=[]; let ly=null;
  pts.forEach((p,i)=>{ const y=p[0].slice(0,4); if(y!==ly){ ly=y; idx.push(i); } });
  const step=Math.max(1,Math.ceil(idx.length/8)); let s='';
  const X=i=>pl+(W-pl-pr)*(pts.length>1?i/(pts.length-1):0.5);
  idx.forEach((i,k)=>{ if(k%step) return; if(pts.length>12&&i>pts.length*0.97) return;
    s+=`<text x="${X(i).toFixed(1)}" y="${'__YB__'}" text-anchor="middle" class="lc-tick">'${pts[i][0].slice(2,4)}</text>`; });
  return s;
}
// single-series line (optionally area-filled); pts = [[date, v], ...]
function hsgLineSvg(ser,pts,o){
  o=o||{}; const W=o.w||560,H=o.h||190,pl=44,pr=12,pt=10,pb=20;
  if(!pts||pts.length<2) return '<div class="msg sec" style="padding:30px 0">not enough data in this window</div>';
  let lo=Infinity,hi=-Infinity; for(const p of pts){ if(p[1]<lo)lo=p[1]; if(p[1]>hi)hi=p[1]; }
  if(o.zero&&lo>0) lo=0;
  const pad=(hi-lo)*0.08||1; lo-=pad; hi+=pad;
  const ticks=lcTicks(lo,hi,4);
  const X=i=>pl+(W-pl-pr)*(i/(pts.length-1)), Y=v=>pt+(H-pt-pb)*(1-(v-lo)/(hi-lo));
  const color=o.color||'var(--blue)';
  let s=lcGrid(pl,W-pr,ticks,Y,v=>hsgFmt(v,ser).replace('.00',''));
  s+=hsgXLabels(pts,W,pl,pr).replace(/__YB__/g,(H-4).toFixed(1));
  const d=pts.map((p,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(p[1]).toFixed(1)).join('');
  s+=`<path d="${d}L${X(pts.length-1).toFixed(1)} ${Y(lo).toFixed(1)}L${X(0).toFixed(1)} ${Y(lo).toFixed(1)}Z" fill="${color}" opacity=".09"/>`;
  s+=`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const L=pts[pts.length-1];
  s+=`<circle cx="${X(pts.length-1).toFixed(1)}" cy="${Y(L[1]).toFixed(1)}" r="3.5" fill="${color}" stroke="var(--panel)" stroke-width="2"/>`;
  const xs=pts.map((_,i)=>X(i)), rows=pts.map(p=>`<div class="sec">${hsgDate(p[0])}</div><div><b>${hsgFmt(p[1],ser)}</b></div>`);
  return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});
}
// stacked area: multifamily on the floor, single-family on top (both in M saar)
function hsgStackSvg(sf,mf,sfPts,mfPts,o){
  o=o||{}; const W=o.w||1140,H=o.h||200,pl=44,pr=12,pt=10,pb=20;
  const m=new Map(mfPts.map(p=>[p[0],p[1]]));
  const pts=sfPts.filter(p=>m.has(p[0])).map(p=>[p[0],p[1],m.get(p[0])]);
  if(pts.length<2) return '<div class="msg sec" style="padding:30px 0">not enough data in this window</div>';
  let hi=0; for(const p of pts) hi=Math.max(hi,p[1]+p[2]); hi*=1.08;
  const ticks=lcTicks(0,hi,4);
  const X=i=>pl+(W-pl-pr)*(i/(pts.length-1)), Y=v=>pt+(H-pt-pb)*(1-v/hi);
  let s=lcGrid(pl,W-pr,ticks,Y,v=>v.toFixed(1)+'M');
  s+=hsgXLabels(pts,W,pl,pr).replace(/__YB__/g,(H-4).toFixed(1));
  const path=(f)=>pts.map((p,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(f(p)).toFixed(1)).join('')+`L${X(pts.length-1).toFixed(1)} ${Y(0).toFixed(1)}L${X(0).toFixed(1)} ${Y(0).toFixed(1)}Z`;
  s+=`<path d="${path(p=>p[1]+p[2])}" fill="var(--blue)" opacity=".45"/>`;
  s+=`<path d="${path(p=>p[2])}" fill="var(--muted)" opacity=".8"/>`;
  s+=`<path d="${pts.map((p,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(p[2]).toFixed(1)).join('')}" fill="none" stroke="var(--panel)" stroke-width="1.5"/>`;
  const xs=pts.map((_,i)=>X(i)), rows=pts.map(p=>`<div class="sec">${hsgDate(p[0])}</div><div><span class="sw" style="background:var(--blue)"></span>single-family <b>${p[1].toFixed(2)}M</b></div><div><span class="sw" style="background:var(--muted)"></span>multifamily <b>${p[2].toFixed(2)}M</b></div>`);
  return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});
}
function hsgChip(ser){
  const proxy=!!ser.proxy;
  return `<span class="src-chip ${proxy?'proxy':'direct'}" title="${esc(ser.src)}${proxy?' — '+esc(ser.proxy):''}"><i></i>${proxy?'Proxy':'Direct'} · ${esc(ser.sid)}</span>`;
}
function hsgDelta(ser){
  const y=ser.yoy; if(!y) return '<span class="sec">12m —</span>';
  const isLvl = ser.unit==='%'||ser.unit==='bp'||ser.unit==='months';
  const v = isLvl ? y.diff : y.pct;
  if(v==null) return '<span class="sec">12m —</span>';
  const txt = isLvl ? (ser.unit==='%' ? (v*100).toFixed(0)+'bp' : ser.unit==='bp' ? v.toFixed(0)+'bp' : ser.unit==='months' ? v.toFixed(1)+' mo' : v.toFixed(1)+'pt') : Math.abs(v).toFixed(1)+'%';
  // direction semantics: higher rates / spreads / supply / tightening read as the bad side
  const bad = ser.k==='rate30'||ser.k==='spread'||ser.k==='supply';
  const cls = v===0?'sec':((v>0)!==bad?'pos':'neg');
  return `<span class="${cls}">${v>0?'▲':'▼'} ${txt.replace('-','')}</span> <span class="sec">12m</span>`;
}
function hsgCard(ser,chart,extra){
  return `<div class="s-card hsg-card">`+
    `<div class="hsg-head"><span class="hsg-title">${esc(ser.title)}</span>${hsgChip(ser)}</div>`+
    `<div class="hsg-kpis"><span class="hsg-v">${hsgFmt(ser.last.v,ser)}</span><span class="sec hsg-d">${hsgDate(ser.last.d)}</span>${hsgDelta(ser)}`+
      `<span class="sec hsg-rng">range ${hsgFmt(ser.lo.v,ser)} – ${hsgFmt(ser.hi.v,ser)}</span></div>`+
    chart+(extra||'')+(ser.proxy?`<div class="s-cap">${esc(ser.proxy)}</div>`:'')+`</div>`;
}
function renderHousing(){
  const root=el('hsg-body'); if(!root) return;
  const d=state.housing;
  document.querySelectorAll('#hsgwin button').forEach(b=>b.classList.toggle('active',b.dataset.w===state.housingWin));
  if(!d){ root.innerHTML='<div class="msg">Loading…</div>'; return; }
  const S=d.series||{}; const keys=Object.keys(S);
  if(!keys.length){ root.innerHTML=`<div class="msg err">Housing board unavailable — ${esc(d.error||'not fetched yet')}.<div class="sec" style="margin-top:6px">Set <b>FRED_KEY</b> on the server (free key at fred.stlouisfed.org) and the board fills on the next pass.</div></div>`; return; }
  const win=state.housingWin, g=k=>S[k], sl=k=>g(k)?hsgSlice(g(k),win):[];
  // headline tiles — only for series that came back
  const tile=(k,label,fmt)=>{ const x=g(k); if(!x) return '';
    return `<div class="stat"><span class="k">${label}</span><span class="v">${fmt?fmt(x):hsgFmt(x.last.v,x)}</span><span style="font-size:11px">${hsgDelta(x)}</span></div>`; };
  const tiles=`<div class="hsg-tiles">`+tile('rate30','30y mortgage')+tile('spread','BBB OAS (proxy)')+tile('sf','SF starts')+tile('supply',"Months' supply")+tile('sales','New home sales')+tile('price','Median price')+
    `<div class="stat" style="margin-left:auto"><span class="k">As of</span><span class="v" style="font-size:13px">${d.asOf?new Date(d.asOf).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—'}</span><span class="sec" style="font-size:11px">FRED · 6h refresh</span></div></div>`;
  const cards=[];
  if(g('rate30')) cards.push(hsgCard(g('rate30'),hsgLineSvg(g('rate30'),sl('rate30'),{color:'var(--blue)'})));
  if(g('spread')) cards.push(hsgCard(g('spread'),hsgLineSvg(g('spread'),sl('spread'),{color:'var(--accent)'})));
  if(g('supply')) cards.push(hsgCard(g('supply'),hsgLineSvg(g('supply'),sl('supply'),{color:'var(--accent)',zero:true})));
  if(g('sales')) cards.push(hsgCard(g('sales'),hsgLineSvg(g('sales'),sl('sales'),{color:'var(--muted)',zero:true})));
  if(g('price')) cards.push(hsgCard(g('price'),hsgLineSvg(g('price'),sl('price'),{color:'var(--accent)'})));
  let starts='';
  if(g('sf')&&g('mf')){ const sf=g('sf'), mf=g('mf');
    starts=`<div class="s-card hsg-card hsg-wide"><div class="hsg-head"><span class="hsg-title">Housing starts — single-family vs multifamily</span>${hsgChip(sf)}<span class="src-chip direct" title="${esc(mf.src)}"><i></i>Direct · ${esc(mf.sid)}</span></div>`+
      `<div class="hsg-kpis"><span class="hsg-v">${hsgNum(sf.last.v,2)}M</span><span class="sec hsg-d">single-family · ${hsgDate(sf.last.d)}</span>${hsgDelta(sf)}<span class="sec" style="margin:0 6px">|</span><span class="hsg-v" style="font-size:15px">${hsgNum(mf.last.v,2)}M</span><span class="sec hsg-d">multifamily</span>${hsgDelta(mf)}</div>`+
      sLeg([{color:'var(--blue)',label:'Single-family'},{color:'var(--muted)',label:'Multifamily (5+ units)'}])+
      hsgStackSvg(sf,mf,sl('sf'),sl('mf'))+`</div>`; }
  const missing=(d.missing&&d.missing.length)?`<div class="s-cap" style="margin-top:10px">Absent this pass (not shown stale): ${d.missing.map(esc).join(', ')}</div>`:'';
  const errl=d.error?`<div class="s-cap" style="margin-top:10px;color:var(--down)">Last refresh failed — showing the previous board. ${esc(d.error)}</div>`:'';
  root.innerHTML=tiles+`<div class="s-grid">${cards.join('')}</div>`+starts+missing+errl;
  attachLineHover();
}
// Surprise % exactly as the row prints it — ONE definition, because epsPairFmt reconciles the
// numbers it shows against this very string. Gains a decimal when it would otherwise round to a
// signless 0.0%.
function epsSurStr(a,b){
  if(a==null||b==null||b===0) return null;
  const s=(a-b)/Math.abs(b)*100;
  return s===0?null:(s>=0?'+':'')+s.toFixed(Math.abs(s)<0.95?2:1)+'%';
}
// Adaptive EPS display precision: expand decimals (2 -> 4, the precision the feed rows are stored
// at) until the printed pair tells the truth twice over.
//   1. Values that DIFFER must READ as different. "EPS 0.8 vs 0.8 miss -0.52%" (the live NFLX
//      print: 0.8000 actual vs 0.8042 est collapsed at 2dp) contradicts its own verdict.
//   2. The pair must RECONCILE with the surprise printed beside it. Rule 1 alone passed 0.3116 vs
//      0.3000 at 2dp — "EPS 0.31 vs 0.3 beat +3.9%", a pair that reads +3.3% (live CRWD,
//      2026-08-26). The surprise is computed on the stored 4dp values and must NOT be rounded to
//      match the display (that was the NFLX lie in the other direction), so the NUMBERS expand
//      until they explain the percentage standing next to them.
// Trailing zeros then come off both sides in lockstep or not at all: two decimals on the actual
// and one on the estimate ("0.31 vs 0.3") reads as false precision on one of them. Removing a
// shared trailing zero changes neither value, so neither rule can regress in the trim.
function epsPairFmt(a,b){
  const sur=epsSurStr(a,b);
  let dp=2;
  while(dp<4&&((a!==b&&a.toFixed(dp)===b.toFixed(dp))||(sur!=null&&epsSurStr(+a.toFixed(dp),+b.toFixed(dp))!==sur))) dp++;
  while(dp>1&&a.toFixed(dp).endsWith('0')&&b.toFixed(dp).endsWith('0')) dp--;
  return [a.toFixed(dp),b.toFixed(dp)];
}
// A single EPS number with no partner to contradict it: 2dp house style, expanding to 4dp only
// when 2dp would round the print away entirely — a sub-cent estimate is not "0.00". The raw feed
// value (4dp, which is what leaked into the row as "EPS est 2.1283") stays in the tooltip.
function epsFmt(x){
  return typeof x!=='number'||!isFinite(x)?'—':(x!==0&&+x.toFixed(2)===0?x.toFixed(4):x.toFixed(2));
}
// EPS segment: schedule estimate before the print; estimate vs ACTUAL with a beat/miss/in-line
// verdict and surprise % once the feed fills the actual (same calendar row updates after the
// report). Verdict is computed on the stored 4dp values, tri-state — equal values are IN LINE,
// never a miss.
function earnEpsHtml(e){
  if(e.epsA!=null&&e.eps!=null){
    const v=e.epsA>e.eps?'beat':e.epsA<e.eps?'miss':'in line';
    const surStr=epsSurStr(e.epsA,e.eps);
    const [fa,fe]=epsPairFmt(e.epsA,e.eps);
    const tip=`reported · EPS ${e.epsA} vs ${e.eps} est${surStr!=null?` (${surStr} surprise)`:''}${e.rev!=null||e.revA!=null?` · revenue ${e.revA!=null?fmtUsd(e.revA):'—'} vs ${e.rev!=null?fmtUsd(e.rev):'—'} est`:''} · verdict is EPS-only, vs the FEED's estimate (consensus differs by source) — the tape's verdict is the move next to it`;
    return `<span class="earn-eps" data-tip="${esc(tip)}">EPS ${fa} vs ${fe} <b class="${v==='beat'?'pos':v==='miss'?'neg':'sec'}">${v}${v!=='in line'&&surStr!=null?' '+surStr:''}</b></span>`;
  }
  if(e.epsA!=null) return `<span class="earn-eps sec" data-tip="${esc('actual reported, exactly '+e.epsA+' per the feed; no estimate carried to compare against')}">EPS ${epsFmt(e.epsA)} · no est</span>`;
  const revTip=e.rev!=null?` · revenue est ${fmtUsd(e.rev)}`:'';
  return `<span class="earn-eps sec"${e.eps!=null||e.rev!=null?` data-tip="${esc('EPS est '+(e.eps!=null?e.eps:'—')+revTip+(e.eps!=null?' · the feed’s own estimate, shown rounded in the row':''))}"`:''}>${e.eps!=null?'EPS est '+epsFmt(e.eps):'—'}</span>`;
}
// Live context from the snapshot already in the browser: today's move, live volume, ADR.
// Null-honest — a row still backfilling shows dashes, never zeros.
function earnLiveHtml(e){
  const r=state.rows.get(e.coin); if(!r) return '<span class="earn-live sec">—</span>';
  const d1=r.d1!=null&&isFinite(r.d1)?`<b class="${r.d1>=0?'pos':'neg'}">${r.d1>=0?'+':''}${r.d1.toFixed(1)}%</b>`:'—';
  const vol=r.vol>0?fmtUsd(r.vol):'—';
  const adr=r.adr!=null&&isFinite(r.adr)?r.adr.toFixed(1)+'%':'—';
  return `<span class="earn-live sec" data-tip="live context from the markets snapshot · day move · 24h notional volume · average daily range — which of today's prints actually matter for the book">${d1} · ${vol} · ADR ${adr}</span>`;
}
// Per-ticker reaction study chip. History = this name's own past prints measured on the perp's
// daily closes (UTC — trades through weekends); n is whatever the feed's depth plus accrual
// honestly provides. Never a prediction — a base rate for sizing expectations.
function earnStudyHtml(t){
  const st=state.earnPayload&&state.earnPayload.study&&state.earnPayload.study[t];
  if(!st) return '<span class="earn-study sec" data-tip="no reaction history yet — the study needs past print dates matched to retained daily candles; it accrues automatically as prints pass">no history</span>';
  const gap=st.gapN>0?` · gapped ${st.gapUp}/${st.gapN} up, ${st.gapHeld}/${st.gapN} held to close`:'';
  const x=st.xMed!=null?` · median ${st.xMed}x the usual daily move (n=${st.xN})`:'';
  // Reaction curve: the move from the print anchor itself (16:00 ET for AMC, 06:00 for BMO, read
  // off the hourly spine) to +1h / +4h / +24h — the intraday shape the daily bar cannot show.
  const cv=st.curve&&st.curve.agg, cvH=(k)=>cv&&cv[k]&&cv[k].n>0?`+${k.slice(1)}h |${cv[k].medAbs}%| (${cv[k].up}/${cv[k].n} up)`:null;
  const curveParts=cv?['h1','h4','h24'].map(cvH).filter(Boolean):[];
  const curve=curveParts.length?` · from the print anchor: ${curveParts.join(', ')}${st.curve.approx?' (some anchors read off an hourly close)':''}`:'';
  const tip=`this name's own earnings reaction base rate over ${st.n} print(s): avg |${st.avgAbs}%| next-session move (median |${st.medAbs}%|), ${st.up}/${st.n} up${gap}${x}${curve}. Reaction = the print day's own bar (BMO/DMH prints against the prior close, AMC prints against the pre-print reference; with the hourly spine the AMC leg is anchored at 16:00 ET, +24h). Gap stats need opens — they cover the live-fetched candle window only. A base rate, not a prediction.`;
  const cv24=cv&&cv.h24&&cv.h24.n>0?` · +24h |${cv.h24.medAbs}%|`:'';
  return `<span class="earn-study" data-tip="${esc(tip)}">${st.n} print${st.n===1?'':'s'} · avg |${st.avgAbs}%| · ${st.up}↑${st.n-st.up}↓${st.xMed!=null?' · '+st.xMed+'x':''}${cv24}</span>`;
}
// Drawer line: upcoming print inside the window + the study one-liner.
function earnDrawerHtml(r){
  if(!r||r.uni!=='xyz'||!state.earn) return '';
  const p=earnNext(r.ticker);
  const st=state.earnPayload&&state.earnPayload.study&&state.earnPayload.study[r.ticker];
  if(!p&&!st) return '';
  const up=p?`Earnings ${p.diff===0?'<b style="color:var(--accent)">TODAY</b>':p.diff===1?'<b style="color:var(--accent)">tomorrow</b>':'in '+p.diff+'d'} · ${esc(earnSessLbl(p.e.s))}${p.e.eps!=null?' · EPS est '+epsFmt(p.e.eps):''}`:'';
  const hist=st?`${up?' · ':''}<span class="sec" data-tip="own reaction base rate — hover the Earnings tab row for the full breakdown">${st.n} print${st.n===1?'':'s'}, avg |${st.avgAbs}%|</span>`:'';
  return `<div class="dsub" style="margin-top:2px">${up}${hist}</div>`;
}
// Reported window for the tab: the server's `recent` (past 2 ET days, derived from the persisted
// print history) MERGED with any upcoming entries that rolled past ET midnight since the last
// fetch (the calendar refreshes 4x/day, so up to ~6h can pass where a print is negative-diff in
// `entries` but not yet in `recent`). Dedupe by ticker+date, preferring whichever record carries
// the ACTUAL — a report never blinks out of the tab at the rollover and never shows twice.
function earnRecentList(){
  const d=state.earnPayload; if(!d) return [];
  const m=new Map();
  const put=(e)=>{ const df=earnDiffC(e.d); if(df==null||df>=0||df<-2) return;
    const k=e.t+'|'+e.d, old=m.get(k);
    if(!old||(e.epsA!=null&&old.epsA==null)) m.set(k,e); };
  for(const e of (d.recent||[])) put(e);
  for(const e of (d.entries||[])) put(e);
  return [...m.values()];
}
// Per-print reaction move for a reported row, computed from the daily closes already in the
// browser and mirroring the reaction study's convention EXACTLY: BMO/DMH prints score their own
// UTC daily candle, AMC prints the next one (the perp trades through weekends, so a Friday AMC
// print lands on Saturday's candle). The live day-move column would be WRONG here — that is
// today's move, not the reaction to a print one or two days old. Null-honest: a reaction candle
// still forming reads "so far"; one not opened or not retained yet is stated, never zeroed.
function earnReactHtml(e){
  const r=state.rows.get(e.coin), cl=r&&r.daily;
  const dash=(why)=>`<span class="earn-live sec" data-tip="${esc(why)}">reaction —</span>`;
  if(!cl||cl.length<2) return dash('reaction pending — daily candles for this name are not loaded in the browser yet');
  const dayOf=(t)=>{ const x=new Date(t); return x.getUTCFullYear()+'-'+String(x.getUTCMonth()+1).padStart(2,'0')+'-'+String(x.getUTCDate()).padStart(2,'0'); };
  let pi=-1; for(let i=0;i<cl.length;i++){ if(dayOf(cl[i].t)===e.d){ pi=i; break; } }
  if(pi<0) return dash('the print date is outside the retained daily candle window');
  const ri=e.s==='AMC'?pi+1:pi;
  if(ri<=0||ri>=cl.length) return dash('the reaction candle (the session after an AMC print) has not opened yet');
  const c1=parseFloat(cl[ri].c), c0=parseFloat(cl[ri-1].c);
  if(!isFinite(c1)||!isFinite(c0)||c0<=0) return dash('reaction candle retained but its closes are not usable yet');
  const mv=(c1-c0)/c0*100;
  const live=ri===cl.length-1&&dayOf(cl[ri].t)===dayOf(Date.now());
  const tip=`the print's own reaction move — ${e.s==='AMC'?'the daily candle AFTER the report (AMC prints land after the close)':'the report day\u2019s own daily candle'} vs the prior close, same convention as the reaction study (UTC candles; the perp trades through weekends)${live?'. That candle is STILL OPEN \u2014 this is the move so far, not a settled print':''}`;
  return `<span class="earn-live" data-tip="${esc(tip)}"><b class="${mv>=0?'pos':'neg'}">${mv>=0?'+':''}${mv.toFixed(1)}%</b><span class="sec"> reaction${live?' so far':''}</span></span>`;
}
// Void-control wiring for reported rows: confirm, POST the tombstone, reload the payload (the
// server bumps the ETag so the repaint is immediate). stopPropagation keeps the row's
// open-drawer click out of it.
function wireEarnVoid(box){
  box.querySelectorAll('.earn-void').forEach(b=>b.addEventListener('click',async(ev)=>{
    ev.stopPropagation();
    const t=b.dataset.vt,d=b.dataset.vd;
    if(!confirm('Void '+t+' '+d+'?\n\nRemoves this print from history and the reaction study, permanently (tombstoned \u2014 the feed cannot re-add it). For feed garbage only.')) return;
    b.disabled=true;
    try{
      const r=await fetch('/api/earnings/void',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({t,d})});
      if(r.ok){ await loadEarnings(); } else { b.disabled=false; alert('void failed ('+r.status+')'); }
    }catch(_){ b.disabled=false; alert('void failed (network)'); }
  }));
}
function renderEarnings(){
  const box=el('earnings-body'); if(!box) return;
  const d=state.earnPayload;
  if(!d){ box.innerHTML='<div class="msg">Loading\u2026</div>'; return; }
  const asOf=d.asOf?new Date(d.asOf):null;
  const ageMin=d.asOf?Math.round((Date.now()-d.asOf)/60000):null;
  const stale=ageMin!=null&&ageMin>8*60;   // > 8h without a good fetch = the 6h cadence is failing
  const src=`<span class="sec" style="font-size:11px">${d.error
    ?`<span style="color:var(--down)">feed error: ${esc(d.error)}</span>${asOf?` \u00b7 showing last good fetch (${ageMin>=60?Math.round(ageMin/60)+'h':ageMin+'m'} old)`:''}`
    :(asOf?`as of ${asOf.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}${stale?` <span style="color:var(--accent)">\u00b7 ${Math.round(ageMin/60)}h stale</span>`:''} \u00b7 source: ${esc(d.source||'finnhub')}`:'never fetched')}</span>`;
  const head=`<div class="controls" style="margin-bottom:10px"><span style="font-weight:600">Calendar <span class="sec" style="font-weight:400">\u00b7 earnings + macro \u00b7 last 2 + next ${d.windowDays||14} days, ET</span></span><span style="margin-left:auto"></span>${src}</div>`;
  const covered=new Set((d.entries||[]).map(e=>e.t)).size;
  const cov=`<div class="sec" style="font-size:11.5px;line-height:1.55;margin-bottom:12px" data-tip="eligibility = live xyz EQUITIES; indices, ETFs, FX, commodities, thematics and pre-IPO synthetics never report. Foreign listings without a US symbol are eligible but absent from the feed \u2014 shown as uncovered, never guessed. A name missing here means the feed has no report scheduled in the window OR does not cover it.">${d.entries&&d.entries.length?`<b>${d.entries.length}</b> report${d.entries.length===1?'':'s'} across <b>${covered}</b> ticker${covered===1?'':'s'}`:'No reports in the window'} \u00b7 ${d.eligible||0} eligible equities in the universe \u00b7 names the feed doesn\u2019t cover simply don\u2019t appear${(()=>{const ml=macroList();const up=ml.filter(e=>macroStateC(e)==='upcoming').length;return ` \u00b7 <span data-tip="universe-wide macro binaries: FOMC decisions (static Fed schedule) + CPI / NFP / PPI / retail / GDP / PCE (FRED schedule). Prior shown as reference \u2014 no street consensus exists in this feed, so rows read prior \u2192 actual + the tape\u2019s reaction, never beat/miss vs estimates.">${up} macro event${up===1?'':'s'} in the window</span>${d.macroErr?` <span style="color:var(--down)" data-tip="the FOMC table still serves \u2014 only the FRED-fed print rows and their numbers are degraded">(FRED: ${esc(d.macroErr)})</span>`:''}`})()}</div>`;
  if(d.error&&!(d.entries&&d.entries.length)){
    box.innerHTML=head+cov+`<div class="msg">No earnings data.<br><span class="sec" style="font-size:11px">${d.error==='FINNHUB_TOKEN not set'?'Set <b>FINNHUB_TOKEN</b> in the Railway service variables (free key from finnhub.io) and redeploy.':'The feed is unreachable \u2014 the server retries every 30 minutes.'}</span></div>`;
    return;
  }
  // Reported — last 48h: two prior ET days, most recent first, so the scoreboard survives the
  // midnight rollover instead of vanishing hours after an AMC print. Today's reported rows keep
  // living under TODAY below — the full picture reads reported → today → upcoming.
  const rep=earnRecentList();
  let repHtml='';
  if(rep.length){
    const rg=new Map();
    for(const e of rep){ let g=rg.get(e.d); if(!g){g={d:e.d,diff:earnDiffC(e.d),rows:[]};rg.set(e.d,g);} g.rows.push(e); }
    repHtml+=`<div class="sec" style="font-size:11.5px;margin:2px 0 6px" data-tip="prints from the two prior ET calendar days, kept on the tab with their beat/miss and reaction move; today\u2019s reports show under TODAY below. Rows come from the persisted print history \u2014 an actual that lands on a later feed pass upgrades the row in place."><b>${rep.length}</b> report${rep.length===1?'':'s'} in the past 2 days</div>`;
    for(const g of rg.values()){
      const dt=new Date(g.d+'T12:00:00Z');
      const lbl=dt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}).toUpperCase();
      repHtml+=`<div class="earn-day">REPORTED \u00b7 ${g.diff===-1?'YESTERDAY \u00b7 ':''}${lbl}<span class="sec" style="margin-left:8px;text-transform:none;letter-spacing:0">${g.diff===-1?'1 day ago':(-g.diff)+' days ago'}</span></div>`;
      g.rows.sort((a,b)=>{ const wa=state.watch.has(a.coin)?0:1, wb=state.watch.has(b.coin)?0:1; return wa-wb; });   // stable: watchlist floats up, session order preserved within each half
      for(const e of g.rows){
        const starred=state.watch.has(e.coin);
        repHtml+=`<div class="earn-row" data-coin="${esc(e.coin)}" title="open the ${esc(e.t)} drawer">`
          +`<span class="earn-tk">${starred?'<span class="star on" style="margin-right:4px">\u2605</span>':''}${esc(e.t)}</span>`
          +`<span class="earn-sess ${e.s==='BMO'?'bmo':e.s==='AMC'?'amc':''}" data-tip="session per the feed \u2014 BMO reports land before the 09:30 ET open, AMC after the 16:00 ET close">${esc(earnSessLbl(e.s))}</span>`
          +earnEpsHtml(e)
          +earnFilingHtml(e)
          +earnReactHtml(e)
          +earnStudyHtml(e.t)
          +`<button class="earn-void" data-vt="${esc(e.t)}" data-vd="${esc(e.d)}" style="background:none;border:0;color:var(--faint);cursor:pointer;font-size:14px;line-height:1;padding:0 2px" data-tip="void this print \u2014 operator override for feed garbage: removes it from history and the reaction study and tombstones it so the feed cannot re-add it. Permanent.">\u00d7</button>`
          +`</div>`;
      }
    }
  }
  { const mrep=macroList().filter(e=>{const df=earnDiffC(e.d);return df!=null&&df<0&&df>=-2&&macroStateC(e)==='released';})
      .sort((a,b)=>String(b.d).localeCompare(String(a.d))||String(b.tEt||'').localeCompare(String(a.tEt||'')));   // total order: equal keys return 0, never 1
    if(mrep.length){ let mh=''; let lastD=null;
      for(const e of mrep){ if(e.d!==lastD){ lastD=e.d; const df=earnDiffC(e.d);
          mh+=`<div class="earn-day">MACRO \u00b7 REPORTED \u00b7 ${df===-1?'YESTERDAY \u00b7 ':''}${macroDayLbl(e.d).toUpperCase()}</div>`; }
        mh+=macroRowHtml(e); }
      repHtml=mh+repHtml; } }
  // Upcoming day groups: union of earnings dates and macro dates (macro rows first inside a day
  // — they carry real clocks; earnings sessions don't). Today-released macro rows stay under
  // TODAY with their actuals; only prior ET days graduate to the REPORTED block above.
  const groups=new Map();
  for(const e of d.entries||[]){ const diff=earnDiffC(e.d); if(diff==null||diff<0) continue;
    let g=groups.get(e.d); if(!g){g={d:e.d,diff,rows:[]};groups.set(e.d,g);} g.rows.push(e); }
  const mgroups=new Map();
  for(const e of macroList()){ const diff=earnDiffC(e.d); if(diff==null||diff<0) continue;
    let g=mgroups.get(e.d); if(!g){g=[];mgroups.set(e.d,g);} g.push(e);
    if(e.k==='FOMC'&&e.d1&&macroStateC(e)==='upcoming'){ const d1f=earnDiffC(e.d1);
      if(d1f!=null&&d1f>=0){ let g1=mgroups.get(e.d1); if(!g1){g1=[];mgroups.set(e.d1,g1);}
        g1.push({_fomc1:true,e}); } } }
  if(!groups.size&&!mgroups.size&&!repHtml){ box.innerHTML=head+cov+'<div class="msg">No upcoming events in the next '+(d.windowDays||14)+' days for this universe.</div>'; return; }
  let html=head+cov+repHtml;
  if(!groups.size&&!mgroups.size){
    html+='<div class="msg">No upcoming reports in the next '+(d.windowDays||14)+' days for this universe.</div>';
    box.innerHTML=html;
    box.querySelectorAll('.earn-row[data-coin]').forEach(rw=>rw.addEventListener('click',(ev)=>{ if(ev.target.closest('a,button')) return; const c=rw.dataset.coin; if(state.rows.has(c)) openDetail(c); }));   // in-place drawer — no tab switch
  wireEarnVoid(box);
    return;
  }
  const allDates=[...new Set([...groups.keys(),...mgroups.keys()])].sort();
  for(const dd of allDates){
    const g=groups.get(dd)||{d:dd,diff:earnDiffC(dd),rows:[]};
    const mg=mgroups.get(dd)||[];
    const dt=new Date(g.d+'T12:00:00Z');
    const lbl=dt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}).toUpperCase();
    const tag=g.diff===0?'TODAY \u00b7 ':g.diff===1?'TOMORROW \u00b7 ':'';
    html+=`<div class="earn-day${g.diff<=1?' hot':''}">${tag}${lbl}<span class="sec" style="margin-left:8px;text-transform:none;letter-spacing:0">${g.diff===0?'':g.diff===1?'in 1 day':'in '+g.diff+' days'}</span></div>`;
    for(const me of mg){
      if(me._fomc1){ const e=me.e;
        html+=`<div class="earn-row mrow" style="opacity:.85">`
          +`<span class="earn-mk" data-tip="day one of the two-day meeting \u2014 no statement today; the decision lands tomorrow 2:00 PM ET">FOMC</span>`
          +`<span class="macro-nm">FOMC meeting begins</span><span class="earn-sess">day 1 of 2</span>`
          +`<span class="sec" style="flex:1">decision ${macroDayLbl(e.d)} 2:00 PM ET${e.prior?` \u00b7 target <b>${macroRangeFmt(e.prior)}</b>`:''}</span></div>`;
        continue; }
      html+=macroRowHtml(me);
    }
    g.rows.sort((a,b)=>{ const wa=state.watch.has(a.coin)?0:1, wb=state.watch.has(b.coin)?0:1; return wa-wb; });   // stable: watchlist floats up, session order preserved within each half
    for(const e of g.rows){
      const starred=state.watch.has(e.coin);
      html+=`<div class="earn-row${g.diff<=1?' hot':''}" data-coin="${esc(e.coin)}" title="open the ${esc(e.t)} drawer">`
        +`<span class="earn-tk">${starred?'<span class="star on" style="margin-right:4px">\u2605</span>':''}${esc(e.t)}</span>`
        +`<span class="earn-sess ${e.s==='BMO'?'bmo':e.s==='AMC'?'amc':''}" data-tip="${e.s==='TBD'?'the feed has the date but not the session \u2014 confirm before trading around it':'session per the feed \u2014 BMO reports land before the 09:30 ET open, AMC after the 16:00 ET close'}">${esc(earnSessLbl(e.s))}</span>`
        +earnEpsHtml(e)
        +earnStudyHtml(e.t)
        +earnLiveHtml(e)
        +`</div>`;
    }
  }
  html+=`<div class="sec" style="font-size:11px;margin-top:14px;line-height:1.5">Dates and sessions are the feed\u2019s scheduled values and can move \u2014 companies reschedule. Session-spanning signals (breakout, gap, overnight drift) on names reporting \u2264 1 day out carry an <i>earnings</i> flag on the Signals tab and have their evidence contribution capped: the base rates weren\u2019t sampled around a known binary catalyst. Macro rows work the same way universe-wide \u2014 an FOMC/CPI/NFP print \u2264 1 day out flags session-spanning signals on <b>both</b> universes with the same cap, and events inside an open setup\u2019s horizon are flagged on the Actionable board (\u25c6) and in AI reports. Macro dates come from the Fed\u2019s published schedule and FRED; prior values are the previous print (labeled by month), never consensus \u2014 no street-estimate feed exists here, so there is no beat/miss verdict, only prior \u2192 actual and the tape.</div>`;
  box.innerHTML=html;
  box.querySelectorAll('.earn-row[data-coin]').forEach(rw=>rw.addEventListener('click',(ev)=>{ if(ev.target.closest('a,button')) return; const c=rw.dataset.coin; if(state.rows.has(c)) openDetail(c); }));   // in-place drawer — no tab switch
  wireEarnVoid(box);
}
export { _hsgLast, _liqLast, _notesLoading, earnDrawerHtml, epsFmt, epsPairFmt, loadHousing, loadLiquidity, loadNotes, noteBadge, noteDrawerHtml, notesStale, openHousing, openLiquidity, openNotes, renderDrawerNotes, renderEarnings, renderHousing, renderLiquidity, renderNotes, wireDrawerNotes };
