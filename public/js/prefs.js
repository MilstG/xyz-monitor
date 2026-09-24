// prefs.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { COLS } from "./base.js";
import { COL_BY_KEY, DEFAULT_HIDDEN, DEFAULT_ORDER, LAYOUT_V, LKEY, PKEY, TF_MAP, el, esc, fmtPrice, fmtUsd, state, store } from "./core.js";
import { fetchJSON } from "./data.js";
import { buildHead, colAdjacent, render } from "./markets.js";
import { applyMobileCols, applyNumFilters, setWindow } from "./nav.js";
import { fmtAge } from "./trend.js";


// ===== persistence (localStorage; UI prefs only) =====
let prefsT=null;
function savePrefs(){ clearTimeout(prefsT); prefsT=setTimeout(()=>{ store.set(PKEY, JSON.stringify({
  colOrder:state.colOrder, colHidden:[...state.colHidden], layoutV:LAYOUT_V, tf:state.tf, refreshMs2:state.refreshMs,
  sortKey:state.sortKey, sortDir:state.sortDir, filterText:state.filter, watch:[...state.watch], watchOnly:!!state.watchOnly, noteOnly:!!state.noteOnly, dvbBasket:state.dvbBasket||null,
  sectGrp:state.sect.grp, grp:state.grp, grpWt:state.grpWt, actOpen2:state.actOpen?1:0,
  filters:{vMin:el('volMin').value,vMax:el('volMax').value,oMin:el('oiMin').value,oMax:el('oiMax').value} }));
  updateLayoutBtn(); prefsMaybePush('watch'); }, 250); }
function loadPrefs(){ let p; try{ p=JSON.parse(store.get(PKEY)||'null'); }catch(_){ p=null; } if(!p) return;
  if(p.layoutV===LAYOUT_V){ // otherwise a one-time migration leaves the new default layout in place
    if(Array.isArray(p.colOrder)){ const v=p.colOrder.filter(k=>COL_BY_KEY[k]);
      for(const c of COLS) if(!v.includes(c.key)){ v.push(c.key); if(DEFAULT_HIDDEN.includes(c.key)) state.colHidden.add(c.key); }
      colAdjacent(v,'momp','mom');   // the candidate migrates in NEXT TO the incumbent, not appended at the far right
      colAdjacent(v,'m5','px'); colAdjacent(v,'m15','m5');   // the intraday pair migrates in next to Price, ahead of 1h
      colAdjacent(v,'hopen','dopen'); colAdjacent(v,'h4open','hopen'); colAdjacent(v,'h12open','h4open');   // the anchored-open trio migrates in next to D open
      colAdjacent(v,'pos','oi');   // the position column migrates in next to OI
      colAdjacent(v,'vcc','d1'); colAdjacent(v,'rscc','rs');   // (-104) the cash-close pair migrates in next to 24h / vs S&P
      state.colOrder=v; }
    if(Array.isArray(p.colHidden)) state.colHidden=new Set(p.colHidden.filter(k=>COL_BY_KEY[k]));
  }
  if(p.tf&&TF_MAP[p.tf]) state.tf=p.tf;
  // refreshMs2: the fallback-poll default moved 60s → 30s. The old key stored the unchosen 60s
  // default in every browser that ever saved prefs (the actOpen trap again), so a saved 60000
  // under it cannot be read as a choice — only a NON-default old value migrates. A deliberate 1m
  // picked from now on persists under the new key and is honored.
  if(typeof p.refreshMs2==='number'&&p.refreshMs2>0) state.refreshMs=p.refreshMs2;
  else if(typeof p.refreshMs==='number'&&p.refreshMs>0&&p.refreshMs!==60000) state.refreshMs=p.refreshMs;
  if(p.sortKey&&COL_BY_KEY[p.sortKey]){ state.sortKey=p.sortKey; state.sortDir=p.sortDir==='asc'?'asc':'desc'; }
  if(p.grp==='sectors'||p.grp==='industries'||p.grp==='names') state.grp=p.grp;   // the drill filter is deliberately NOT persisted — a reload always lands on the full lens
  state.actOpen = p.actOpen2===undefined ? true : !!p.actOpen2;   // -03: open unless explicitly collapsed. New key on purpose — the -02 key (actOpen) stored the unchosen collapsed DEFAULT in every browser that saved prefs, so honoring it would pin the strip shut for exactly the people who never chose that. The old key is ignored, not migrated.
  if(p.grpWt==='eq'||p.grpWt==='vol') state.grpWt=p.grpWt;
  if(typeof p.dvbBasket==='string'&&/^[A-Z][A-Z0-9]{1,11}$/.test(p.dvbBasket)) state.dvbBasket=p.dvbBasket;
  if(typeof p.filterText==='string') state.filter=p.filterText;
  if(Array.isArray(p.watch)) state.watch=new Set(p.watch);
  if(p.sectGrp==='ind'||p.sectGrp==='sector') state.sect.grp=p.sectGrp;
  state.watchOnly=!!p.watchOnly; state.noteOnly=!!p.noteOnly; state._savedFilters=p.filters||null; }

// ===== saved layouts (named views of the markets table) =====
// A layout captures: column order + visibility, sort key/dir, analysis window, the vol/OI
// threshold filters (raw input strings, so they round-trip exactly), and the ★-only toggle.
// Deliberately NOT captured: the ticker search text (ephemeral), scope (a layout applies to
// whichever scope you're in), and the refresh rate. localStorage, so per-browser — which
// means the phone can hold different layouts than the desktop.
function layoutSnapshot(){ return {
  colOrder:[...state.colOrder], colHidden:[...state.colHidden],
  sortKey:state.sortKey, sortDir:state.sortDir, tf:state.tf, watchOnly:!!state.watchOnly,
  filters:{vMin:el('volMin').value||'', vMax:el('volMax').value||'', oMin:el('oiMin').value||'', oMax:el('oiMax').value||''} }; }
function layoutSig(s){ if(!s) return '';
  return JSON.stringify({o:s.colOrder||[], h:[...(s.colHidden||[])].sort(), k:s.sortKey, d:s.sortDir, t:s.tf, w:!!s.watchOnly,
    f:{vMin:(s.filters&&s.filters.vMin)||'', vMax:(s.filters&&s.filters.vMax)||'', oMin:(s.filters&&s.filters.oMin)||'', oMax:(s.filters&&s.filters.oMax)||''}}); }
function saveLayouts(){ store.set(LKEY, JSON.stringify({list:state.layouts.list, active:state.layouts.active})); prefsMaybePush('layouts'); }
function loadLayouts(){ let d; try{ d=JSON.parse(store.get(LKEY)||'null'); }catch(_){ d=null; } if(!d) return;
  if(d.list&&typeof d.list==='object'&&!Array.isArray(d.list)) state.layouts.list=d.list;
  if(typeof d.active==='string'&&state.layouts.list[d.active]) state.layouts.active=d.active; }
// ===== account-synced prefs: watchlist + layouts follow the ACCOUNT (build 2026.09.16-78) =========
// localStorage stays the working copy and the signed-out experience is untouched. Signed in, each
// key carries a stamp — the time of the last local change, or the server's stamp when a remote
// value was adopted — and the newer stamp wins in both directions: on boot, on every local edit
// (a debounced POST), and on a {prefs} poke from another device (a GET). The active layout is NOT
// synced: the phone runs its own layout by design, only the list of saved ones travels.
const SKEY='xyzmon.sync.v1';
const TAB_ID=Math.random().toString(36).slice(2);
function prefsSignedIn(){ return !!(window.__ME&&window.__ME.uid); }
function prefsLocal(key){ return key==='watch' ? [...state.watch].sort() : { list: state.layouts.list }; }
function prefsSig(v){ return JSON.stringify(v); }
function prefsMeta(){ let m; try{ m=JSON.parse(store.get(SKEY)||'null'); }catch(_){ m=null; } return (m&&typeof m==='object')?m:{}; }
function prefsSetMeta(key, ts, sig){ const m=prefsMeta(); m[key]={ts, sig}; store.set(SKEY, JSON.stringify(m)); }
// Pure: given the local stamp/signature and the server's, say which way the value flows.
// 'pull' = adopt the server's, 'push' = send ours, null = already in step. A stamp-less local value
// that is non-empty still pushes on first sign-in — otherwise the watchlist a browser built up
// before accounts existed would never reach the account.
function prefsDecide(local, remote, empty){
  const lts=(local&&local.ts)||0, rts=(remote&&remote.ts)||0;
  if(rts>lts) return 'pull';
  if(rts<lts) return 'push';
  if(!rts&&!lts&&!empty) return 'push';
  return null;
}
let _prefsPushT={};
function prefsMaybePush(key){ if(!prefsSignedIn()) return;
  const v=prefsLocal(key), sig=prefsSig(v), m=prefsMeta()[key]||{};
  if(m.sig===sig) return;                        // unchanged since the last sync in either direction
  const ts=Date.now(); prefsSetMeta(key, ts, sig);
  clearTimeout(_prefsPushT[key]); _prefsPushT[key]=setTimeout(()=>prefsPush(key, v, ts), 400); }
async function prefsPush(key, v, ts){
  try{ const r=await fetch('/api/prefs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key, value:v, ts, tab:TAB_ID})});
    if(r.status===401) return;                   // signed out mid-session: the local copy stands
    const d=await r.json().catch(()=>null);
    // Our stamp lost to a newer one on the server: somebody else's device wrote after us — pull it.
    if(d&&d.ok&&d.stored===false) prefsPullAll();
  }catch(_){} }
function prefsApply(key, v, ts){
  if(key==='watch'){ if(!Array.isArray(v)) return; state.watch=new Set(v.filter(c=>typeof c==='string')); prefsSetMeta(key, ts, prefsSig(prefsLocal(key)));
    render(); savePrefs(); const st=el('dstar'); if(st&&state.detail){ const on=state.watch.has(state.detail); st.textContent=on?'\u2605':'\u2606'; st.classList.toggle('on',on); } }
  else { if(!v||typeof v!=='object'||!v.list||typeof v.list!=='object') return; state.layouts.list=v.list;
    if(state.layouts.active&&!state.layouts.list[state.layouts.active]) state.layouts.active=null;
    prefsSetMeta(key, ts, prefsSig(prefsLocal(key))); saveLayouts(); updateLayoutBtn();
    const pop=el('laypop'); if(pop&&!pop.hidden) buildLayoutMenu(); } }
let _prefsPulling=null;
function prefsPullAll(){ if(!prefsSignedIn()) return Promise.resolve(); if(_prefsPulling) return _prefsPulling;
  _prefsPulling=fetchJSON('/api/prefs').then(d=>{ if(!d||!d.ok||!d.prefs) return; const meta=prefsMeta();
    for(const key of ['watch','layouts']){ const loc=meta[key]||{}, rem=d.prefs[key]||null, v=prefsLocal(key);
      const empty=key==='watch'?!v.length:!Object.keys(v.list||{}).length;
      const how=prefsDecide(loc, rem, empty);
      if(how==='pull') prefsApply(key, rem.v, rem.ts);
      else if(how==='push'){ const ts=loc.ts||Date.now(); prefsSetMeta(key, ts, prefsSig(v)); prefsPush(key, v, ts); } }
  }).catch(()=>{}).finally(()=>{ _prefsPulling=null; });
  return _prefsPulling; }
function prefsRemoteFrame(p){ if(!p||p.from===TAB_ID) return; prefsPullAll(); }

function layoutDirty(){ const a=state.layouts.active; if(!a||!state.layouts.list[a]) return false;
  return layoutSig(state.layouts.list[a])!==layoutSig(layoutSnapshot()); }
function updateLayoutBtn(){ const b=el('layBtn'); if(!b) return; const a=state.layouts.active;
  const lbl=b.querySelector('.laylbl'); if(lbl) lbl.textContent=a?(a+(layoutDirty()?' \u2022':'')):'Layouts';
  b.classList.toggle('on', !!a);
  b.title=a?`Active layout: ${a}${layoutDirty()?' (unsaved changes \u2014 open to re-save)':''}`:'Save & switch table layouts \u2014 columns, sort, window, filters'; }
// Apply a saved layout by name; name==null applies the factory default view.
function applyLayout(name){ const s=name!=null?state.layouts.list[name]:null;
  const src=s||{colOrder:[...DEFAULT_ORDER], colHidden:[...DEFAULT_HIDDEN], sortKey:'vol', sortDir:'desc', tf:'1d', watchOnly:false, filters:{vMin:'',vMax:'',oMin:'',oMax:''}};
  // Column merge, same rule as loadPrefs: drop keys that no longer exist, append columns
  // added since the layout was saved (hidden if they're hidden in the default layout).
  const ord=(Array.isArray(src.colOrder)?src.colOrder:[]).filter(k=>COL_BY_KEY[k]);
  const hid=new Set((Array.isArray(src.colHidden)?src.colHidden:[]).filter(k=>COL_BY_KEY[k]));
  for(const c of COLS) if(!ord.includes(c.key)){ ord.push(c.key); if(DEFAULT_HIDDEN.includes(c.key)) hid.add(c.key); }
  colAdjacent(ord,'momp','mom');   // same adjacency rule for saved layouts
  colAdjacent(ord,'m5','px'); colAdjacent(ord,'m15','m5');
  colAdjacent(ord,'hopen','dopen'); colAdjacent(ord,'h4open','hopen'); colAdjacent(ord,'h12open','h4open');
  colAdjacent(ord,'pos','oi');
  colAdjacent(ord,'vcc','d1'); colAdjacent(ord,'rscc','rs');
  state.colOrder=ord; state.colHidden=hid;
  if(src.sortKey&&COL_BY_KEY[src.sortKey]){ state.sortKey=src.sortKey; state.sortDir=src.sortDir==='asc'?'asc':'desc'; }
  state.watchOnly=!!src.watchOnly; el('watchOnly').classList.toggle('on', state.watchOnly);
  const f=src.filters||{};
  el('volMin').value=f.vMin||''; el('volMax').value=f.vMax||''; el('oiMin').value=f.oMin||''; el('oiMax').value=f.oMax||'';
  state.layouts.active=(name!=null&&s)?name:null; saveLayouts();
  if(src.tf&&TF_MAP[src.tf]) setWindow(src.tf);   // syncs the window segment UI + rebuilds
  applyNumFilters();                              // syncs state.filters from the inputs + filter chip
  buildHead(); render(); savePrefs(); updateLayoutBtn(); }
function buildLayoutMenu(){ const pop=el('laypop'); const names=Object.keys(state.layouts.list).sort((a,b)=>a.localeCompare(b));
  let h='<div class="cphead">Layouts \u00b7 columns, sort, window, filters</div>';
  h+=`<div class="lrow2${state.layouts.active==null?' cur':''}" data-lay=""><span class="lname">Default</span><span class="lmut">factory</span></div>`;
  h+=`<div class="lrow2" data-mob="1"><span class="lname">Mobile</span><span class="lmut">built-in \u00b7 phone columns</span></div>`;
  for(const n of names){ const cur=state.layouts.active===n;
    h+=`<div class="lrow2${cur?' cur':''}" data-lay="${esc(n)}"><span class="lname">${esc(n)}${cur&&layoutDirty()?' \u2022':''}</span>`+
       `<button class="lact" data-ren="${esc(n)}" title="Rename">\u270e</button><button class="lact" data-del="${esc(n)}" title="Delete">\u2715</button></div>`; }
  if(!names.length) h+='<div class="lmut" style="padding:4px 5px 8px;display:block">No saved layouts yet \u2014 arrange the table how you want it, then save it below.</div>';
  h+='<div class="lsaverow"><input class="fnum lnamein" id="layName" placeholder="layout name" maxlength="24" autocomplete="off" spellcheck="false"/><button class="btn" id="laySaveAs">Save as</button></div>';
  if(state.layouts.active&&state.layouts.list[state.layouts.active])
    h+=`<button class="btn" id="laySave" style="margin-top:7px;width:100%;justify-content:center" title="Overwrite this layout with the current view">Save to \u2018${esc(state.layouts.active)}\u2019${layoutDirty()?' \u2022':''}</button>`;
  pop.innerHTML=h;
  pop.querySelectorAll('.lrow2').forEach(rw=>rw.addEventListener('click',e=>{ if(e.target.closest('.lact')) return;
    if(rw.dataset.mob){ applyMobileCols(); buildLayoutMenu(); return; }
    applyLayout(rw.dataset.lay||null); buildLayoutMenu(); }));
  pop.querySelectorAll('[data-ren]').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation(); const old=b.dataset.ren;
    const nn=(prompt('Rename layout', old)||'').trim(); if(!nn||nn===old) return;
    if(state.layouts.list[nn]&&!confirm(`\u2018${nn}\u2019 already exists \u2014 overwrite it?`)) return;
    state.layouts.list[nn]=state.layouts.list[old]; delete state.layouts.list[old];
    if(state.layouts.active===old) state.layouts.active=nn;
    saveLayouts(); updateLayoutBtn(); buildLayoutMenu(); }));
  pop.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation(); const n=b.dataset.del;
    if(!confirm(`Delete layout \u2018${n}\u2019?`)) return;
    delete state.layouts.list[n]; if(state.layouts.active===n) state.layouts.active=null;
    saveLayouts(); updateLayoutBtn(); buildLayoutMenu(); }));
  const sa=el('laySaveAs'); if(sa) sa.addEventListener('click',()=>{ const inp=el('layName'), n=(inp.value||'').trim();
    if(!n){ inp.classList.add('bad'); inp.focus(); return; } inp.classList.remove('bad');
    if(state.layouts.list[n]&&!confirm(`\u2018${n}\u2019 already exists \u2014 overwrite it?`)) return;
    state.layouts.list[n]=layoutSnapshot(); state.layouts.active=n;
    saveLayouts(); updateLayoutBtn(); buildLayoutMenu(); });
  const sv=el('laySave'); if(sv) sv.addEventListener('click',()=>{ const a=state.layouts.active; if(!a) return;
    state.layouts.list[a]=layoutSnapshot(); saveLayouts(); updateLayoutBtn(); buildLayoutMenu(); });
  const inp=el('layName'); if(inp) inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); const b=el('laySaveAs'); if(b) b.click(); } });
}

// ===== positions overlay: what the linked wallet actually holds (build 2026.09.16-79) ==========
// The server ships the STRUCTURE of each position (side, size, entry, leverage, liquidation, margin,
// funding paid since open); everything that moves with price — notional, unrealized P&L, ROE, the
// move since entry — is derived here off the same live mark the rest of the row shows, so a
// position reads consistently with the columns beside it and never waits on a wallet poll.
// Derived in one place (posCalc) for the cell, the badge and the drawer panel.
function posCalc(r){ const p=state.pos.get(r.coin); if(!p) return null;
  const mark=(r.px!=null&&isFinite(r.px))?r.px:null, dir=p.side==='long'?1:-1;
  const ntl=mark!=null?p.sz*mark:p.ntl;
  const upnl=(mark!=null&&p.entry!=null)?(mark-p.entry)*p.sz*dir:p.upnl;
  const roe=(p.margin>0&&upnl!=null)?upnl/p.margin*100:null;
  const vsEntry=(mark!=null&&p.entry>0)?(mark/p.entry-1)*100*dir:null;
  const liqDist=(mark!=null&&p.liq>0)?(p.liq/mark-1)*100:null;   // signed: negative below the mark (a long's liq), positive above (a short's)
  return {p, mark, ntl, upnl, roe, vsEntry, liqDist}; }
function posDecorate(){ for(const r of state.rows.values()){ const c=state.pos.size?posCalc(r):null; r.pos=c?(c.p.side==='long'?1:-1)*(c.ntl||0):undefined; } }
function posTip(r,c){ const p=c.p, s=[];
  s.push(`${p.side==='long'?'LONG':'SHORT'} ${p.sz} ${esc(r.ticker)} · ${fmtUsd(c.ntl)} notional${p.lev?' · '+p.lev+'x'+(p.levType?' '+p.levType:''):''}`);
  if(p.entry!=null) s.push(`entry ${fmtPrice(p.entry)}${c.mark!=null?' · mark '+fmtPrice(c.mark):''}${c.vsEntry!=null?' · '+(c.vsEntry>=0?'+':'')+c.vsEntry.toFixed(2)+'% since entry':''}`);
  if(c.upnl!=null) s.push(`unrealized ${c.upnl>=0?'+':'−'}${fmtUsd(Math.abs(c.upnl))}${c.roe!=null?' · ROE '+(c.roe>=0?'+':'')+c.roe.toFixed(1)+'%':''}`);
  if(p.liq!=null) s.push(`liquidation ${fmtPrice(p.liq)}${c.liqDist!=null?' ('+(c.liqDist>=0?'+':'')+c.liqDist.toFixed(1)+'% from mark)':''}`);
  if(p.fundOpen!=null) s.push(`funding since open ${p.fundOpen>=0?'paid ':'received '}${fmtUsd(Math.abs(p.fundOpen))}`);
  return s.join('\n'); }
function posCell(r){ const c=posCalc(r); if(!c) return '<td class="sec">—</td>';
  const cls=c.upnl>0?'pos':(c.upnl<0?'neg':'sec');
  return `<td class="posc" title="${esc(posTip(r,c))}"><span class="pside ${c.p.side}">${c.p.side==='long'?'L':'S'}</span>${fmtUsd(c.ntl)} <span class="${cls}">${c.vsEntry==null?'':(c.vsEntry>=0?'+':'')+c.vsEntry.toFixed(1)+'%'}</span></td>`; }
// The markets-table marker, beside the note post-it: absent when nothing is held, a hexagon in the
// side's colour otherwise, tinted by whether the position is currently winning.
function posBadge(r){ const c=posCalc(r); if(!c) return '';
  const cls=c.upnl>0?'win':(c.upnl<0?'lose':'flat');
  return `<span class="posb ${c.p.side} ${cls}" title="${esc(posTip(r,c))}">\u2b21</span>`; }
function renderDrawerPos(coin){ const box=el('dpos'); if(!box) return; const r=state.rows.get(coin); const c=r?posCalc(r):null;
  if(!c){ box.innerHTML=''; return; }
  const p=c.p, meta=state.posMeta||{};
  const chip=(k,v,t)=>`<div class="dzchip"${t?' data-tip="'+esc(t)+'"':''}><span class="dzk">${k}</span><span class="dzv">${v}</span></div>`;
  const sgn=(v,d,suf)=>v==null?'<span class="na">·</span>':`<span class="${v>0?'pos':(v<0?'neg':'sec')}">${v>=0?'+':''}${v.toFixed(d)}${suf||''}</span>`;
  // The board's read of the name, next to the side you are on. tscore is the trend ladder, signed.
  const ts=r.tscore; let agree='';
  if(typeof ts==='number'&&ts!==0){ const boardSide=ts>0?'long':'short'; agree=boardSide===p.side
    ? `<span class="pos">with the trend board</span> (D1 ladder ${ts>0?'+':''}${ts})`
    : `<span class="neg">against the trend board</span> (D1 ladder ${ts>0?'+':''}${ts})`; }
  box.innerHTML=`<div class="dsec" data-tip="your open position in this market, from the wallet linked under Filters \u203a Positions \u00b7 structure (size, entry, leverage, liquidation, margin, funding) from the wallet poll, everything price-dependent derived off the live mark in the header">Position <span class="dzsrc">${esc(meta.wallet&&meta.wallet.label?meta.wallet.label:(meta.wallet?meta.wallet.addr.slice(0,6)+'\u2026'+meta.wallet.addr.slice(-4):''))}${meta.ts?' \u00b7 polled '+fmtAge(Date.now()-meta.ts)+' ago':''}</span></div>`
    +`<div class="dzchips">`
    +chip('side \u00b7 size', `<span class="pside ${p.side}">${p.side==='long'?'LONG':'SHORT'}</span> ${p.sz}`, 'signed size from the clearinghouse')
    +chip('notional', fmtUsd(c.ntl), 'size \u00d7 live mark')
    +chip('entry', p.entry!=null?fmtPrice(p.entry):'<span class="na">\u00b7</span>', 'average entry price')
    +chip('since entry', sgn(c.vsEntry,2,'%'), 'move from entry, signed with the side \u2014 positive = the position is winning')
    +chip('unrealized', c.upnl==null?'<span class="na">\u00b7</span>':`<span class="${c.upnl>0?'pos':(c.upnl<0?'neg':'sec')}">${c.upnl>=0?'+':'\u2212'}${fmtUsd(Math.abs(c.upnl))}</span>`, '(mark \u2212 entry) \u00d7 size, signed with the side')
    +chip('ROE', sgn(c.roe,1,'%'), 'unrealized P&L over the margin backing the position')
    +chip('leverage', p.lev?p.lev+'x'+(p.levType?' <span class="sec">'+esc(p.levType)+'</span>':''):'<span class="na">\u00b7</span>', 'as set on the wallet')
    +chip('liquidation', p.liq!=null?fmtPrice(p.liq)+(c.liqDist!=null?' <span class="sec">('+(c.liqDist>=0?'+':'')+c.liqDist.toFixed(1)+'%)</span>':''):'<span class="na">\u00b7</span>', 'estimated liquidation price and its distance from the live mark')
    +chip('margin', p.margin!=null?fmtUsd(p.margin):'<span class="na">\u00b7</span>', 'margin used by this position')
    +chip('funding', p.fundOpen==null?'<span class="na">\u00b7</span>':`<span class="${p.fundOpen>0?'neg':(p.fundOpen<0?'pos':'sec')}">${p.fundOpen>0?'paid ':'received '}${fmtUsd(Math.abs(p.fundOpen))}</span>`, 'cumulative funding since the position opened \u2014 the carry you have actually paid or received')
    +`</div>`+(agree?`<div class="sec" style="font-size:var(--fs-xs);margin:-4px 0 10px">${agree}</div>`:''); }
let POSSEQ=0, _posColShown=false;
async function loadPositions(quiet){ if(!prefsSignedIn()){ posStatText(); return; } const seq=++POSSEQ;
  let d; try{ d=await fetchJSON('/api/positions'); }catch(_){ return; }
  if(seq!==POSSEQ||!d||!d.ok) return;
  state.posMeta=d;
  const next=new Map(); for(const p of (d.positions||[])) if(p&&p.coin) next.set(p.coin,p);
  // Structural equality: a re-pull that changed nothing must not repaint the table.
  const sig=m=>[...m.entries()].map(([k,p])=>k+':'+p.side+':'+p.sz+':'+p.entry+':'+p.margin+':'+p.lev).sort().join('|');
  const changed=sig(next)!==sig(state.pos);
  state.pos=next;
  // Pending = the lane is fetching a wallet it has not read yet: pull again shortly rather than wait for the poke.
  if(d.pending&&d.wallet) setTimeout(()=>{ if(seq===POSSEQ) loadPositions(true); }, 4000);
  // First positions for a linked wallet: show the column once, unless the operator has hidden it since.
  if(d.wallet&&next.size&&!_posColShown&&state.colHidden.has('pos')&&store.get('xyzmon.posCol')!=='hidden'){ _posColShown=true; state.colHidden.delete('pos'); buildHead(); }
  posStatText();
  if(changed||!quiet){ render(); if(state.detail) renderDrawerPos(state.detail); } }
function posStatText(){ const s=el('posStat'), inp=el('posAddr'), lb=el('posLink'), ub=el('posUnlink'); if(!s) return;
  const m=state.posMeta;
  if(!prefsSignedIn()){ s.textContent='sign in to link a wallet'; if(inp) inp.disabled=true; if(lb) lb.disabled=true; if(ub) ub.hidden=true; return; }
  if(inp) inp.disabled=false; if(lb) lb.disabled=false;
  if(!m||!m.wallet){ s.textContent='no wallet linked \u2014 paste an address to overlay its open perps'; if(ub) ub.hidden=true; return; }
  if(ub) ub.hidden=false;
  const a=m.wallet.addr, short=a.slice(0,6)+'\u2026'+a.slice(-4);
  if(m.err&&!m.positions.length){ s.textContent=`${short} \u00b7 wallet read failed: ${m.err}`; return; }
  if(m.pending){ s.textContent=`${short} \u00b7 reading\u2026`; return; }
  const eq=m.summary&&m.summary.equity!=null?' \u00b7 equity '+fmtUsd(m.summary.equity):'';
  s.textContent=`${m.wallet.label?m.wallet.label+' ':''}${short} \u00b7 ${m.positions.length} open${eq}`; }
async function posLink(addr){ const inp=el('posAddr');
  try{ const r=await fetch('/api/positions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(addr?{addr}:{remove:true})});
    const d=await r.json().catch(()=>null);
    if(!r.ok||!d||!d.ok){ if(inp){ inp.classList.add('bad'); inp.title=(d&&d.error)||'could not link'; } const s=el('posStat'); if(s) s.textContent=(d&&d.error)||'could not link that address'; return; }
    if(inp){ inp.classList.remove('bad'); inp.title=''; inp.value=''; }
    if(!addr){ state.pos=new Map(); state.posMeta={ok:true,wallet:null,positions:[]}; posStatText(); render(); if(state.detail) renderDrawerPos(state.detail); return; }
    loadPositions();
  }catch(_){} }
export { buildLayoutMenu, loadLayouts, loadPositions, loadPrefs, posBadge, posCell, posDecorate, posLink, posStatText, prefsPullAll, prefsRemoteFrame, renderDrawerPos, saveLayouts, savePrefs, updateLayoutBtn };
