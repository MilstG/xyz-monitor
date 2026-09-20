// funds.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { IS_ADMIN } from "./admin.js";
import { el, esc, overlayPop, overlayPush, safeHref, state } from "./core.js";
import { fetchJSON } from "./data.js";
import { openDetail } from "./drawer.js";
import { tcount, termErr, termOut, termThinking, tesc, tmoney, tpad } from "./terminal.js";


// ===== FUNDS tab — 13F whale watchlist (build 2026.08.16-01) ====================================
// Everything rendered here is the server's payload RESTATED: books, deltas, season lanes and the
// filing window all arrive computed from /api/whale and the client re-derives nothing (the
// concentration bar's widths are the payload's own pct values, not a client re-sum). Honesty
// framing is part of the layout, not a footnote option: staleness is stamped in the header, share
// columns dash when the filing mixed principal rows, a season lane row whose flow is one whale's
// leg says so on hover. The `whale` terminal family reads the SAME endpoints — one code path.
const WHL={ data:null, season:null, timer:0, edit:false, cand:null, addPend:false };
function whlMoney(v){ return tmoney(v); }
function whlSh(v){ if(v==null||!isFinite(v)) return '\u2014'; return tcount(v); }
function whlSgnSh(v){ if(v==null||!isFinite(v)) return null; return (v>0?'+':'\u2212')+tcount(Math.abs(v)); }
function whlAge(ts){ if(!ts) return '\u2014'; const d=Math.round((Date.now()-ts)/86400000); return d<=0?'today':d+'d ago'; }
function whlDateStr(ts){ return ts?new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'\u2014'; }
function whlFundName(key){ const w=WHL.data&&WHL.data.watch.find(x=>x.key===key); return w?w.name:key; }
async function whlPost(body){
  const r=await fetch('/api/whale/watch',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body||{})});
  if(r.status===403) return { ok:false, error:'admin only' };
  try{ return await r.json(); }catch(_){ return { ok:false, error:'HTTP '+r.status }; }
}
function openFunds(){
  whlFetch();
  if(!WHL.timer) WHL.timer=setInterval(()=>{ const v=el('view-funds'); if(v&&!v.hidden) whlFetch(); },60000);
}
async function whlFetch(){
  try{
    const d=await fetchJSON('/api/whale'); WHL.data=d;
    if(d.seasonQ){ try{ WHL.season=await fetchJSON('/api/whale?season='+encodeURIComponent(d.seasonQ)); }catch(_){ WHL.season=null; } }
    else WHL.season=null;
    renderFunds(); whlTabDot();
  }catch(e){ const w=el('fundswrap'); if(w&&!WHL.data) w.innerHTML=`<div class="msg err"><span class="big">Couldn't load the fund watchlist</span>${esc((e&&e.message)||'network error')}. Will retry on the next interval.</div>`; }
}
// Tab badge: the amber dot on the FUNDS tab mirrors any unseen filing — cleared by opening the
// fund, exactly like the row badge, so the tab can never nag about something already read.
function whlTabDot(){ const t=el('tab-funds'); if(t) t.classList.toggle('whl-dot', !!(WHL.data&&WHL.data.unseenAny)); }
function whlWindowLine(w){
  if(!w||!w.cur) return '';
  const dl=new Date(w.cur.deadline).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const op=new Date(w.cur.opens).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const nx=w.next?` \u00b7 next: ${esc(w.next.q)} due ${new Date(w.next.deadline).toLocaleDateString('en-US',{month:'short',day:'numeric'})}`:'';
  const lbl=w.state==='open'?`window OPEN \u00b7 due ${dl}`:w.state==='upcoming'?`window opens ${op} \u00b7 due ${dl}`:`window closed ${dl}`;
  return `<span class="sec" data-tip="13F-HR is due 45 days after quarter end (weekend due dates roll to the next business day; holiday rolls are not modeled — disclosed simplification) · badges arm when the window opens · the season summary builds when every watched fund has filed, or at deadline+1 with whoever made it">${esc(w.cur.q)} \u00b7 ${lbl}${nx}</span>`;
}
function renderFunds(){
  const box=el('fundswrap'); if(!box||!WHL.data) return;
  const d=WHL.data;
  const rows=d.watch.map(w=>{
    const bell=`<button type="button" class="whl-bell${w.notify?'':' off'}" data-whlbell="${esc(w.key)}" data-tip="${w.notify?'notify: ON — a new 13F fires a filing alert (bell log + Telegram for subscribers of the filing class); click to mute this fund':'notify: OFF — row still updates and badges, it just never alerts; click to unmute'}">${w.notify?'\ud83d\udd14':'\ud83d\udd15'}</button>`;
    const badge=w.unseen?`<span class="whl-badge" data-tip="new filing — unseen · clears when you open the fund">NEW 13F</span>`:(w.amended?`<span class="whl-badge hra" data-tip="the latest ingested filing is a 13F-HR/A amendment — it supersedes the original for the same quarter; the card always reads the newest accession">HR/A</span>`:'');
    const del=WHL.edit?`<button type="button" class="whl-del" data-whlrm="${esc(w.key)}" data-tip="remove from watchlist — cached history kept, row hidden; re-adding restores it">\u00d7</button>`:'';
    return `<tr class="whl-row${w.unseen?' unseen':''}" data-whlopen="${esc(w.key)}">`
      +`<td class="l">${bell}</td>`
      +`<td class="l"><span class="whl-name">${esc(w.name)}</span>${badge}<div class="whl-sub">whale ${esc(w.key)} \u00b7 CIK ${esc(String(w.cik))}</div></td>`
      +`<td>${w.q?esc(w.q):'<span class="na" data-tip="no 13F ingested yet — the poll finds it within the half hour, or pull now">\u2014</span>'+(IS_ADMIN?'<button type="button" class="whl-btn whl-pull" data-whlpull="'+esc(w.key)+'" data-tip="check EDGAR for this filer\u2019s latest 13F right now — one on-demand fetch, at most once a minute per fund">find latest filing</button>':'')}${w.filedAt?` <span class="sec">\u00b7 filed ${esc(whlDateStr(w.filedAt))}</span>`:''}</td>`
      +`<td class="r"${w.scaled?' data-tip="filer reported values in the pre-2023 thousands convention — corrected \u00d71000 (detected: filed value \u00f7 shares implied sub-$1 prices; rule + sample floor in compute, flagged on the stored filing)"':''}>${w.total!=null?whlMoney(w.total):'\u2014'}${w.scaled?'<span class="whl-scl" data-tip="values corrected \u00d71000 — filer used the pre-2023 thousands convention; detection disclosed, never a silent guess">\u00d7k</span>':''}</td>`
      +`<td class="r ${w.dPct>0?'pos':w.dPct<0?'neg':''}" data-tip="book value vs the prior filed quarter \u2014 value change, NOT performance: marks, flows, options notional and newly-reportable assets are all mixed in this number and cannot be separated (hover the column header for the full framing)">${w.dPct!=null?(w.dPct>0?'+':'')+w.dPct.toFixed(1)+'%':'\u2014'}</td>`
      +`<td class="r">${w.n!=null?w.n:'\u2014'}</td>`
      +`<td class="l">${w.top?`${esc(w.top.name.slice(0,22))} <span class="sec">${w.top.pct!=null?w.top.pct.toFixed(1)+'%':''}</span>`:'\u2014'}</td>`
      +`<td>${del}</td></tr>`;
  }).join('');
  const addRow=WHL.edit?`<div class="whl-add"><input id="whl-addq" placeholder="add fund — name or CIK, resolved via EDGAR search" maxlength="60">`
    +`<button type="button" id="whl-addgo">search</button><div id="whl-cand"></div></div>`:'';
  box.innerHTML=`<div class="whl-head"><span class="whl-hd" data-tip="Quarter-end institutional books from SEC EDGAR 13F-HR filings — filed up to 45 days late, long US-listed equity + listed options only. Positioning HISTORY, never the current book; shorts, futures, non-US and cash are invisible here.">TRACKED FUNDS</span>`
    +`<span class="sec">${d.watch.length} filer${d.watch.length===1?'':'s'} \u00b7 13F-HR watched via EDGAR</span>`
    +`<span class="whl-sp"></span>${whlWindowLine(d.window)}`
    +(IS_ADMIN?`<button type="button" id="whl-edit" class="whl-btn${WHL.edit?' on':''}">${WHL.edit?'DONE':'EDIT'}</button>`:'')+`</div>`
    +`<div class="whl-who"><div class="whl-shd"><span class="whl-hd" data-tip="reverse lookup across the tracked funds' cached 13F books — who holds it, how big, at what conviction, what they did QoQ. Cached state only; a query costs zero EDGAR traffic. QoQ chips come from the SAME delta engine as the fund modal — the two can never disagree.">WHO HOLDS</span>`
    +`<input id="whl-whoq" placeholder="search a ticker, company name (\u22653 chars), or CUSIP across the tracked books\u2026" maxlength="40" autocomplete="off"></div><div id="whl-whoout"></div></div>`
    +(d.watch.length?`<div class="tblwrap"><table class="whl-tbl"><thead><tr><th></th><th class="l">FUND</th><th class="l">LAST 13F</th><th class="r">BOOK</th><th class="r" data-tip="five inputs, one number: marks + investor flows + options notional expansion + assets ENTERING the 13F universe (an IPO makes a years-old private stake reportable overnight) + rotation from non-13F assets \u00b7 never read as returns \u2014 a fund printing +40% here made nobody 40%; the share-count deltas inside the book are the trustworthy layer, this column is context">\u0394 QoQ</th><th class="r">POS</th><th class="l">TOP HOLDING</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      :`<div class="msg">No funds watched yet${IS_ADMIN?' \u2014 hit EDIT and add one by name or CIK':' \u2014 the operator curates this list'}.</div>`)
    +addRow
    +`<div id="whl-season"></div>`
    +`<div class="whl-foot">source: SEC EDGAR 13F-HR \u00b7 values verbatim from filings (whole USD) \u00b7 tickers appear only where the issuer name matched the SEC company map exactly after normalization \u2014 unmatched rows keep the filed name, nothing is guessed \u00b7 list + books persist on the data volume</div>`;
  whlBindList(box);
  renderWhlSeason();
}
function whlBindList(box){
  const eb=el('whl-edit'); if(eb) eb.onclick=()=>{ WHL.edit=!WHL.edit; WHL.cand=null; renderFunds(); };
  box.querySelectorAll('[data-whlbell]').forEach(b=>b.onclick=async(ev)=>{ ev.stopPropagation();
    const w=WHL.data.watch.find(x=>x.key===b.dataset.whlbell); if(!w) return;
    const r=await whlPost({op:'mute',key:w.key,on:!!w.notify});   // on=true means MUTE when currently notifying
    if(r&&r.ok!==false) whlFetch(); });
  box.querySelectorAll('[data-whlrm]').forEach(b=>b.onclick=async(ev)=>{ ev.stopPropagation();
    const k=b.dataset.whlrm;
    if(!confirm('Remove '+k+' from the watchlist? History is kept; the row is hidden.')) return;
    const r=await whlPost({op:'rm',key:k}); if(r&&r.ok) whlFetch(); else alert((r&&r.error)||'remove failed'); });
  box.querySelectorAll('[data-whlopen]').forEach(tr=>tr.onclick=(ev)=>{
    if(ev.target.closest('[data-whlbell],[data-whlrm],[data-whlpull]')) return;
    whlOpenFund(tr.dataset.whlopen); });
  box.querySelectorAll('[data-whlpull]').forEach(b=>b.onclick=async(ev)=>{ ev.stopPropagation(); whlPull(b.dataset.whlpull, b); });
  const wq=el('whl-whoq');
  if(wq){ wq.value=WHL.whoQ||''; let deb=0;
    wq.oninput=()=>{ clearTimeout(deb); const v=wq.value; deb=setTimeout(()=>whlWho(v),300); };
    wq.onkeydown=(e)=>{ if(e.key==='Enter'){ clearTimeout(deb); whlWho(wq.value); } };
    if(WHL.whoQ) whlWho(WHL.whoQ,true); }
  const go=el('whl-addgo'), q=el('whl-addq');
  const doSearch=async()=>{
    const v=(q&&q.value||'').trim(); if(!v) return;
    el('whl-cand').innerHTML='<span class="sec">searching EDGAR\u2026</span>';
    const r=await whlPost({op:'search',q:v});
    if(!r||!r.ok){ el('whl-cand').innerHTML=`<span class="err">${esc((r&&r.error)||'search failed')}</span>`; return; }
    el('whl-cand').innerHTML=r.candidates.map((c,i)=>`<button type="button" class="whl-cand" data-whladd="${c.cik}" data-whlname="${esc(c.name)}">${esc(c.name)} <span class="sec">CIK ${c.cik}</span></button>`).join('');
    el('whl-cand').querySelectorAll('[data-whladd]').forEach(b=>b.onclick=async()=>{
      const r2=await whlPost({op:'add',cik:+b.dataset.whladd,name:b.dataset.whlname});
      if(r2&&r2.ok){ if(q) q.value=''; el('whl-cand').innerHTML=`<span class="pos">added ${esc(r2.fund.key)} \u2014 watching for 13F-HR</span>`; whlFetch(); }
      else el('whl-cand').innerHTML=`<span class="err">${esc((r2&&r2.error)||'add failed')}</span>`; });
  };
  if(go) go.onclick=doSearch;
  if(q) q.onkeydown=(e)=>{ if(e.key==='Enter') doSearch(); };
}
// ---- "who holds" reverse lookup ---------------------------------------------------------------
// Renders /api/whale?holds=Q verbatim. -07: the payload is a LIST OF ISSUERS, not one merged
// result. The strongest match renders in full; every other issuer the query touched renders as a
// collapsed strip that expands in place. A query like "amd" legitimately hits two companies and
// a query like "capital" hits five — a switch would hide them behind a click and a stack would
// bury the answer you wanted, so weak matches are subordinate but present, ranked by lane
// strength. Survives re-renders: the query and the expanded set live on WHL and re-fire after
// whlFetch repaints the tab.
const WHO_DIR={add:['ADDED','b-add','net share count grew vs the prior filed quarter, across this fund\u2019s COMMON lines only'],
  trim:['TRIMMED','b-trim','net share count shrank vs the prior filed quarter, across this fund\u2019s COMMON lines only'],
  new:['NEW','b-new','opened this quarter \u2014 no position in the prior filing'],
  flat:['FLAT','b-flat','share count unchanged \u2014 mark drift only, not a trade'],
  exit:['EXITED','b-exit','held it in the prior quarter, absent from the latest filing: exited, or fell below reporting \u2014 indistinguishable in a 13F'],
  na:['\u2014','b-na','no prior filing ingested for this fund, or the position is option lines only \u2014 no direction claimed']};
// One chip component for every lot class. -06 rendered option lines as bare coloured text and
// common lines as a bordered tag, picked by an unrelated condition (does this fund hold 2+ common
// lots), so the same column carried two different widgets and the fund name ran straight into the
// class with no separator. Options are a COLOUR here, not a different component.
function whoLot(l){
  const lbl=l.put?esc(l.put.toUpperCase())+'S':(l.cls?esc(String(l.cls).toUpperCase().split(/\s+/).slice(-2).join(' ')):'COM');
  return `<span class="wo-cls${l.put?' '+esc(l.put):''}">${lbl}</span>`;
}
// Sub-0.05% is "<0.1%", never a fabricated 0.0%. A rounded zero on a real position reads as an
// absent position, which is the one thing this panel exists to distinguish.
function whoPct(p){ if(p==null) return '<span class="na">\u2014</span>';
  if(p>0&&p<0.05) return '<span class="sec">&lt;0.1%</span>';
  return p.toFixed(1)+'%'; }
// The unit is always printed. "+3.3M" sitting next to "$9.36B" is unreadable: shares and dollars
// are both plausible and the column mixes them by design (share deltas where both quarters report
// SH counts, value deltas where they don't).
function whoD(d){
  if(!d||d.cls==='na') return '<span class="na" data-tip="no prior filing ingested \u2014 no delta is claimed, not \u2018all new\u2019">\u2014</span>';
  if(d.cls==='new') return '<span class="new">opened</span>';
  if(d.cls==='flat') return '<span class="sec">flat</span>';
  if(d.dSh!=null) return `<span class="${d.dSh>0?'pos':'neg'}">${whlSgnSh(d.dSh)} sh</span>`;
  if(d.dVal!=null) return `<span class="${d.dVal>0?'pos':'neg'}" data-tip="value delta only \u2014 share counts aren\u2019t comparable across the two filings (options or principal-amount rows)">${(d.dVal>0?'+':'\u2212')}${whlMoney(Math.abs(d.dVal)).slice(1)}</span>`;
  return '<span class="na">\u2014</span>';
}
function whoTable(iss){
  const rows=iss.funds.map(f=>{
    const d=WHO_DIR[f.dir]||WHO_DIR.na;
    const mix=f.mixed?` <span class="wo-mix" data-tip="legs disagree \u2014 at least one lot grew while another shrank. The chip prints the NET direction across this fund\u2019s common lines, so the fund is counted ONCE in the strip above; the per-lot deltas below show both sides.">\u00b1</span>`:'';
    if(!f.held){
      const ex=f.exited.map(x=>`${x.put?esc(x.put)+'s ':''}was ${whlMoney(x.prevVal)}`).join(' \u00b7 ');
      return `<tr class="wo-fund wo-exit" data-whlopen2="${esc(f.key)}" data-tip="${esc(f.name)} \u2014 held it in the ${esc(f.q)} prior quarter and it is absent from the latest filed book: EXITED, or fell below reporting \u2014 a 13F cannot tell the two apart">`
        +`<td class="l"><span class="whl-name">${esc(f.key)}</span><span class="whl-badge b-exit">EXITED</span></td>`
        +`<td colspan="4" class="l sec">${ex}</td></tr>`;
    }
    const fv=f.lines.reduce((s,l)=>s+(l.value||0),0);
    const fp=f.lines.reduce((s,l)=>s+(l.pct||0),0);
    const best=Math.min.apply(null,f.lines.map(l=>l.rank));
    // The fund's OWN roll-up. -06 put the fund name, the direction chip and the largest lot's
    // numbers on one row, so a fund's headline was whichever lot happened to sort first.
    const head=`<tr class="wo-fund" data-whlopen2="${esc(f.key)}" data-tip="${esc(f.name+' \u00b7 '+f.q+' book \u00b7 '+f.lines.length+' filed line(s) on this issuer \u00b7 combined '+whlMoney(fv)+' \u00b7 best rank #'+best+' \u00b7 click for the full book')}">`
      +`<td class="l"><span class="whl-name">${esc(f.key)}</span>`
      +`<span class="whl-badge ${d[1]}" data-tip="${esc(d[2])}">${d[0]}</span>${mix}</td>`
      +`<td class="r wo-n">${whlMoney(fv)}</td>`
      +`<td class="r wo-n">${whoPct(fp)}</td>`
      +`<td class="r wo-n sec" data-tip="best (lowest) rank this issuer reaches in that fund\u2019s book \u2014 per-lot ranks below">#${best}</td>`
      +`<td class="r wo-n sec">\u2014</td></tr>`;
    const lots=f.lines.map(l=>`<tr class="wo-lot" data-whlopen2="${esc(f.key)}" data-tip="${esc(f.name+' \u00b7 '+(l.put?l.put+'s line':'common')+' \u00b7 cusip '+l.cusip+(l.cls?' \u00b7 '+l.cls:'')+' \u00b7 value $'+Math.round(l.value).toLocaleString()+(l.shares!=null?' \u00b7 '+Math.round(l.shares).toLocaleString()+' sh':' \u00b7 share count not claimed (PRN/mixed rows)')+' \u00b7 rank #'+l.rank+' in their book'+(l.put?' \u00b7 a separate 13F line: option value is the UNDERLYING notional per 13F rules, not premium, and is never merged into the common position':'')+' \u00b7 click for the full book')}">`
      +`<td class="l">${whoLot(l)}</td>`
      +`<td class="r wo-n">${whlMoney(l.value)}</td>`
      +`<td class="r wo-n" data-tip="value \u00f7 that fund\u2019s 13F total \u2014 conviction proxy">${whoPct(l.pct)}</td>`
      +`<td class="r wo-n sec">#${l.rank}</td>`
      +`<td class="r wo-n">${whoD(l.d)}</td></tr>`).join('');
    return head+lots;
  }).join('');
  return `<div class="tblwrap"><table class="whl-tbl whl-wotbl">`
    +`<colgroup><col class="wo-c1"><col class="wo-c2"><col class="wo-c3"><col class="wo-c4"><col class="wo-c5"></colgroup>`
    +`<thead><tr><th class="l">FUND \u00b7 LOT</th>`
    +`<th data-tip="value as filed (thousands-convention filers already corrected \u00d71000 upstream); option lines are underlying notional, not premium">VALUE</th>`
    +`<th>% OF BOOK</th><th>RANK</th>`
    +`<th data-tip="share delta when both quarters report SH counts, value delta otherwise, opened on new positions \u2014 the unit is always printed">\u0394 QoQ</th></tr></thead>`
    +`<tbody>${rows}</tbody></table></div>`;
}
function whoAgg(iss,watchN){
  return `<div class="whl-woagg"><b>${esc(iss.name||'')}</b>${iss.tk?` <span class="whl-tk">${esc(iss.tk)}</span>`:''}`
    +`<span class="sec" data-tip="how your query found THIS issuer \u2014 the basis is per-issuer, never borrowed from a stronger match elsewhere in the result. Lanes, strongest first: exact CUSIP, ticker via the SEC company map, normalized name, filed-name substring.">matched by ${esc(iss.basisLabel)}</span>`
    +`<span class="wo-sep">\u00b7</span><span><b>${iss.held}</b><span class="sec">/${watchN} hold</span></span>`
    +`<span class="wo-sep">\u00b7</span>`
    +`<span class="sec" data-tip="long common-equity value only. Option lines are stated separately because a 13F reports them at UNDERLYING NOTIONAL, not premium paid \u2014 adding the two produces a number that describes no position anyone holds.">common <b>${whlMoney(iss.common)}</b></span>`
    +(iss.optNotional?`<span class="sec" data-tip="the underlying notional of every matched calls/puts line, per 13F reporting rules. Never added to the common figure, and never counted in the adding/cutting strip.">+ option notional <b>${whlMoney(iss.optNotional)}</b></span>`:'')
    +`<span class="wo-sep">\u00b7</span>`
    +(iss.adding?`<span class="pos" data-tip="funds whose NET common-line direction is up. Each holder is counted exactly once \u2014 adding + cutting + flat can never exceed the hold count \u2014 and option lines never vote: a new puts line is not accumulation.">${iss.adding} adding</span>`:'')
    +(iss.cutting?`<span class="neg" data-tip="funds whose NET common-line direction is down, plus funds that exited outright. Options excluded by the same rule.">${iss.cutting} cutting</span>`:'')
    +(iss.flat?`<span class="sec" data-tip="held, share count unchanged \u2014 mark drift only, not a trade">${iss.flat} flat</span>`:'')
    +`</div>`;
}
function whoFoot(iss,r){
  const nh=iss.notHeld&&iss.notHeld.length?`<span class="fl"><b>not held:</b> ${iss.notHeld.map(esc).join(', ')} \u2014 absent from their latest filed book; shorts, derivatives and non-US would be invisible anyway</span>`:'';
  const nb=r.noBook&&r.noBook.length?`<span class="fl"><b>no book yet:</b> ${r.noBook.map(esc).join(', ')} \u2014 nothing ingested for these filers, so they are unmeasured here rather than absent</span>`:'';
  return nh+nb;
}
async function whlWho(qv,keep){
  WHL.whoQ=(qv||'').trim();
  const out=el('whl-whoout'); if(!out) return;
  if(!WHL.whoQ){ out.innerHTML=''; WHL.whoOpen=null; return; }
  if(!keep) out.innerHTML='<div class="msg">searching the cached books\u2026</div>';
  let r; try{ r=await fetchJSON('/api/whale?holds='+encodeURIComponent(WHL.whoQ)); }
  catch(e){ out.innerHTML=`<div class="msg err">${esc(e.message||'fetch failed')}</div>`; return; }
  if((el('whl-whoq')&&el('whl-whoq').value.trim())!==WHL.whoQ) return;   // a newer keystroke owns the panel
  if(!r.ok){ out.innerHTML=`<div class="msg">${esc(r.error||'no result')}</div>`; WHL.whoOpen=null;
    if(r.topMeta&&!r.topMeta.ready) out.innerHTML+=`<div class="sec" style="padding:8px 2px">market-wide top holders: ${r.topMeta.busy?'data set ingesting \u2014 a few minutes, progress in ops':'no data set ingested yet \u2014 automatic after each quarter\u2019s deadline, or admin: whale ingest13f'}</div>`;
    return; }
  if(r.missButTop){ out.innerHTML=`<div class="msg">no tracked fund holds ${esc(r.q)} \u2014 showing the market-wide answer</div>`; }
  if(!WHL.whoOpen||WHL.whoKey!==WHL.whoQ){ WHL.whoOpen=new Set(); WHL.whoKey=WHL.whoQ; }
  const iss=r.issuers||[];
  const P=iss[0];
  const alts=iss.slice(1).map(a=>{
    const open=WHL.whoOpen.has(a.key);
    return `<div class="wo-alt${open?' open':''}">`
      +`<div class="wo-althd" data-whoalt="${esc(a.key)}" data-tip="${esc('a weaker lane matched this issuer too: '+a.basisLabel+'. It is kept separate \u2014 two companies are never summed into one result \u2014 and shown here rather than dropped, because a substring or name collision is a real answer to what you typed, just not the strongest one. Click to expand.')}">`
      +`<span class="k">ALSO MATCHED</span>`
      +`<b>${esc(a.name||'')}</b>${a.tk?` <span class="whl-tk">${esc(a.tk)}</span>`:''}`
      +`<span class="sec">${esc(a.basisLabel)}</span>`
      +`<span class="sec">${a.held}/${r.watchN} hold \u00b7 ${whlMoney(a.combined)}</span>`
      +`<span class="wo-sp"></span><span class="wo-car">${open?'\u25be':'\u25b8'}</span></div>`
      +(open?whoAgg(a,r.watchN)+whoTable(a)+`<div class="whl-foot">${whoFoot(a,r)}</div>`:'')
      +`</div>`;
  }).join('');
  out.innerHTML=whoAgg(P,r.watchN)+whoTable(P)+alts
    +`<div class="whl-foot">${whoFoot(P,r)}`
    +`<span class="fl">searched the latest cached filing of each tracked fund + its prior quarter for exits \u00b7 quarter-end snapshots filed up to 45d late \u2014 positioning history, never the current book</span></div>`;
  // Market-wide TOP HOLDERS (2026.08.21-05): the SEC data-set index rendered under the tracked-
  // funds tables. Tracked rows gold + clickable into your books; NEW when absent from the prior
  // set; dash when the prior row sat outside the stored cap (ambiguity disclosed, not guessed).
  if(r.top){
    const t=r.top;
    const maxV=Math.max(...t.rows.map(x=>x.value||0),1);
    const trow=(x)=>{
      const d=x.isNew?'<span class="new" data-tip="no row in the prior data set — for a fresh listing this is a pre-IPO stake becoming reportable, not a buy at these prices">NEW</span>'
        :(x.dSh!=null?`<span class="${x.dSh>0?'pos':'neg'}">${whlSgnSh(x.dSh)}</span>`
        :'<span class="na" data-tip="prior-quarter share count unavailable — the holder sat outside the stored top-'+t.cap+' last set, or reported non-SH counts; nothing is guessed">\u2014</span>');
      return `<tr class="whl-worow${x.tracked?' whl-mine':''}"${x.tracked?' data-whlopen2="'+esc(x.tracked)+'"':''} data-tip="${esc(x.name+' \u00b7 CIK '+x.cik+' \u00b7 $'+Math.round(x.value).toLocaleString()+(x.shares!=null?' \u00b7 '+Math.round(x.shares).toLocaleString()+' sh':'')+(x.tracked?' \u00b7 ON YOUR WATCHLIST — click for the book':''))}">`
        +`<td class="r sec">${x.rank}</td>`
        +`<td class="l">${esc(x.name)}${x.tracked?'<span class="whl-badge whl-trk">TRACKED</span>':''}</td>`
        +`<td class="r">${whlMoney(x.value)}</td>`
        +`<td class="r">${whlSh(x.shares)}</td>`
        +`<td class="r">${d}</td>`
        +`<td class="l"><span class="whl-tbar" style="width:${Math.max(2,Math.round((x.value||0)/maxV*120))}px" data-tip="relative to the largest holder's position — NOT % of float (shares outstanding is not in a 13F; the number is omitted rather than faked)"></span></td></tr>`; };
    out.innerHTML+=`<div class="whl-tophd"><span class="whl-hd" data-tip="top institutional holders across ALL ~8,500 13F filers — from the SEC's quarterly Form 13F structured data set, indexed on your volume. Common-share lines only (an options desk must never outrank a real owner); per-filer thousands-convention correction applied; HR/A supersedes HR. Quarter-end positions in a data set published ~a week after the 45-day deadline — the freshest possible market-wide view is still ~7 weeks stale.">TOP HOLDERS \u00b7 MARKET-WIDE</span>`
      +`<span class="whl-qtag" data-tip="which quarterly data set this reads${t.prevQ?' \u00b7 \u0394 shares vs the '+esc(t.prevQ)+' set':' \u00b7 no prior set stored — the \u0394 column dashes'}">${esc(t.q)} data set</span>`
      +`<span class="sec">${t.nFilers.toLocaleString()} filer${t.nFilers===1?'':'s'} hold \u00b7 ${whlMoney(t.totVal)} institutional value${t.otherCusips?` \u00b7 ${t.otherCusips} sibling share class${t.otherCusips===1?'':'es'} indexed separately`:''}</span></div>`
      +(t.allNew?`<div class="whl-ipowarn" data-tip="every top holder is NEW to the data set — the signature of a listing inside the quarter">13F shows INSTITUTIONAL MANAGERS only \u2014 founder/insider stakes, employee shares and non-filing pre-IPO entities are invisible here; for a fresh listing the true largest holders are mostly NOT on this list.</div>`:'')
      +`<div class="tblwrap"><table class="whl-tbl whl-wotbl"><thead><tr><th class="r">#</th><th class="l">HOLDER</th><th class="r" data-tip="value as in the SEC data set — thousands-convention filers corrected by the same rule your watchlist uses">VALUE</th><th class="r">SHARES</th><th class="r" data-tip="share change vs the prior quarter's data set">\u0394 QoQ</th><th class="l">SIZE</th></tr></thead><tbody>${t.rows.map(trow).join('')}</tbody></table></div>`
      +`<div class="whl-foot">source: SEC quarterly Form 13F structured data set \u00b7 top ${t.rows.length} holders shown \u00b7 top-${t.cap} per cusip stored, aggregates exact over all holders \u00b7 index complexes (Vanguard/BlackRock/State Street/Geode) hold by mandate, not conviction</div>`;
  } else if(r.topMeta&&!r.topMeta.ready){
    out.innerHTML+=`<div class="sec" style="padding:8px 2px" data-tip="the market-wide index builds from the SEC's quarterly data set (~300MB) — it downloads automatically ~a week after each 45-day deadline, or an admin can force it: terminal \u2192 whale ingest13f">market-wide top holders: ${r.topMeta.busy?'data set ingesting \u2014 a few minutes, progress in ops':'no data set ingested yet \u2014 it lands automatically after each quarter\u2019s deadline'}</div>`;
  }
  out.querySelectorAll('[data-whlopen2]').forEach(tr=>tr.onclick=()=>whlOpenFund(tr.dataset.whlopen2));
  out.querySelectorAll('[data-whoalt]').forEach(h=>h.onclick=()=>{
    const k=h.dataset.whoalt;
    if(WHL.whoOpen.has(k)) WHL.whoOpen.delete(k); else WHL.whoOpen.add(k);
    whlWho(WHL.whoQ,true); });
}
// ---- season panel -----------------------------------------------------------------------------
function whlLegLine(l){
  const who=esc(l.key);
  if(l.opened) return who+' opened '+whlMoney(l.dVal);
  if(l.exited) return who+' exited (was '+whlMoney(-l.dVal)+')';
  return who+' '+(l.dSh!=null?((l.dSh>0?'+':'\u2212')+tcount(Math.abs(l.dSh))+' sh'):((l.dVal>0?'+':'\u2212')+whlMoney(Math.abs(l.dVal)).slice(1)));
}
function whlLaneRows(rows,kind){
  if(!rows||!rows.length) return '<div class="sec">nothing this quarter</div>';
  const max=Math.max(...rows.map(r=>Math.abs(r.net!=null?r.net:r.tot)||0),1);
  return rows.slice(0,6).map(r=>{
    const v=r.net!=null?r.net:(kind==='exits'?-r.tot:r.tot);
    const nm=(r.tk?r.tk:esc(r.name.slice(0,16)))+(r.put?' <span class="whl-oc '+r.put+'">'+esc(r.put)+'s</span>':'');
    const legs=(r.legs||r.funds||[]).map(l=>l.dVal!=null||l.opened||l.exited?whlLegLine(l):esc(l.key)+' '+whlMoney(l.val!=null?l.val:-(l.prevVal||0))).join(' \u00b7 ');
    const dom=r.domPct!=null&&r.domPct>=75&&(r.legs||[]).length>1?' \u00b7 one fund is '+r.domPct.toFixed(0)+'% of this flow \u2014 a single whale can BE the consensus':'';
    const estn=r.estN?' \u00b7 '+r.estN+' leg(s) had no comparable share counts (options/PRN) \u2014 those ride at value change, the polluted layer':'';
    const fn=(r.n!=null?r.n:(r.legs?new Set(r.legs.map(l=>l.key)).size:0));
    return `<div class="whl-srow" data-tip="${esc((r.tk?r.tk+' \u00b7 ':'')+r.name)} \u00b7 ${esc(legs)}${esc(dom)}${esc(estn||'')}">`
      +`<span class="whl-snm">${nm}</span><span class="whl-sfn">${fn}/${WHL.season.agg.nFunds}</span>`
      +`<span class="whl-sbar"><span class="whl-sfill ${kind}" style="width:${Math.round(Math.abs(v)/max*100)}%"></span></span>`
      +`<span class="whl-sfl ${v>0?(kind==='opens'?'new':'pos'):(kind==='exits'?'exitc':'neg')}">${(v>0?'+':'\u2212')}${whlMoney(Math.abs(v)).slice(1)}</span></div>`;
  }).join('');
}
function renderWhlSeason(){
  const host=el('whl-season'); if(!host) return;
  const s=WHL.season;
  if(!s||!s.ok){ host.innerHTML=WHL.data&&WHL.data.watch.length?`<div class="whl-shd"><span class="whl-hd">13F SEASON</span><span class="sec">${esc((s&&s.error)||'no season built yet \u2014 it lands when the watched funds file')}</span></div>`:''; return; }
  const a=s.agg;
  // Cells ride the SEASON'S OWN ROSTER, not the live watchlist. These two lists diverge the
  // moment you edit the watchlist, and rendering the squares from one while the N/M beside them
  // came from the other made the row contradict itself. Worse than the wrong denominator: a fund
  // added mid-quarter drew a grey "no position" square, which is an absence of measurement being
  // painted as a finding about a filer. One producer — the build says who it covered, and the
  // grid draws exactly that.
  const cells=(r)=>(a.roster||[]).map(w=>{
    const st=r.state&&r.state[w.key];
    const lbl=st==='new'?'NEW this quarter':st==='add'?'added':st==='trim'?'trimmed':st==='exit'?'exited':st==='hold'?'holds, unchanged':'no position';
    const gone=w.dropped?' \u00b7 no longer watched \u2014 this square is history, not a live holding':'';
    return `<span class="whl-cell ${st||'none'}${w.dropped?' gone':''}" data-tip="${esc(w.key)} \u2014 ${lbl}${gone}"></span>`;
  }).join('');
  // Duplicate display names (GOOG/GOOGL both normalize to "ALPHABET INC"): when a lane shows one
  // name twice, each row appends its share-class tail (titleOfClass's last two tokens) or the
  // cusip head — the rows were never wrong, they were indistinguishable.
  const nameCount={}; a.crowd.forEach(r=>{ const k=(r.tk||r.name)+(r.put||''); nameCount[k]=(nameCount[k]||0)+1; });
  const tagOf=(r)=>r.cls?String(r.cls).split(/\s+/).slice(-2).join(' '):null;
  const tagCount={}; a.crowd.forEach(r=>{ const k=(r.tk||r.name)+(r.put||''); if((nameCount[k]||0)>=2){ const t=(k+'\u0000')+(tagOf(r)||''); tagCount[t]=(tagCount[t]||0)+1; } });
  const disamb=(r)=>{ const k=(r.tk||r.name)+(r.put||''); if((nameCount[k]||0)<2) return '';
    // titleOfClass first — but two filers can both write just "Equity", which disambiguates
    // nothing; when the tags inside the group collide, the cusip head takes over (two share
    // classes can never share one).
    const tg=tagOf(r);
    const collided=!tg||tagCount[(k+'\u0000')+tg]>1;
    const t=collided?esc(String(r.cusip||'').slice(0,6)):esc(tg);
    return ` <span class="whl-clstag" data-tip="two share classes of one issuer are two cusips and two rows — tagged by the filing's titleOfClass, or the cusip head when the filed titles collide or are missing">${t}</span>`; };
  const rosterNote=!(a.roster&&a.roster.length)&&a.crowd.length?`<div class="sec" style="padding:4px 0 8px">grid cells pending one season rebuild \u2014 this build was stored by an older version; the server heals it at boot</div>`:'';
  const crowd=a.crowd.length?a.crowd.slice(0,8).map(r=>
    `<div class="whl-crow" data-tip="${esc((r.tk?r.tk+' \u00b7 ':'')+r.name)} \u00b7 held by ${r.held} of ${a.nFunds} \u00b7 ${r.adding} adding \u00b7 ${r.cutting} cutting \u00b7 one square per fund THIS SEASON WAS BUILT FROM \u2014 not the current watchlist, which may have changed since">`
    +`<span class="whl-snm">${r.tk?r.tk:esc(r.name.slice(0,16))}${disamb(r)}${r.put?' <span class="whl-oc '+r.put+'">'+esc(r.put)+'s</span>':''}</span>`
    +`<span class="whl-cells">${cells(r)}</span><span class="sec">${r.held}/${a.nFunds}${r.adding?' \u00b7 '+r.adding+' adding':''}${r.cutting?' \u00b7 '+r.cutting+' cutting':''}</span></div>`).join('')
    :'<div class="sec">no name is held by 2+ watched funds</div>';
  // The stale chip fires only when this build covers funds that have since LEFT the watchlist and
  // the rebuild couldn't run (nothing left to build from). It never fires for the ordinary case —
  // an edit that reopens the build repaints the whole panel from the new aggregate instead.
  const staleChip=s.stale?`<span class="whl-stale" data-tip="this aggregate was built from ${esc(s.stale.dropped.join(', '))}, which ${s.stale.dropped.length===1?'is':'are'} no longer watched \u2014 and no watched fund has a filing for this quarter, so it cannot be rebuilt. Kept rather than deleted: it is what the books said at the time. Re-add ${s.stale.dropped.length===1?'the fund':'a fund'}, or wait for the next filing, and it rebuilds.">STALE \u00b7 built from ${esc(s.stale.dropped.join(', '))}, no longer watched</span>`:'';
  host.innerHTML=`<div class="whl-shd"><span class="whl-hd">${esc(s.q)} \u00b7 13F SEASON</span>${staleChip}`
    +`<span class="sec">${s.filedN}/${s.watchN} watched funds filed${s.missing&&s.missing.length?' \u00b7 missing: '+esc(s.missing.join(', ')):''}${s.healed?' \u00b7 <span data-tip="this aggregate was rebuilt from the books stored on the volume (a shape migration) — header counts, lanes and grid all describe THIS rebuild; the original build\u2019s roster was unrecoverable">rebuilt from stored books</span>':s.amended?' \u00b7 rebuilt after amendment':''}${s.closedAt?' \u00b7 closed '+esc(whlDateStr(s.closedAt)):''}</span>`
    +(WHL.data.seasonList&&WHL.data.seasonList.length>1?`<span class="whl-sp"></span><span class="whl-qnav">${WHL.data.seasonList.map(q=>`<button type="button" data-whlq="${esc(q)}" class="${WHL.season.q===q?'on':''}">${esc(q)}</button>`).join('')}</span>`:'')+`</div>`
    +`<div class="whl-grid">`
    +`<div class="whl-lane"><div class="whl-lhd pos" data-tip="net TRADED dollars: each fund's share change \u00d7 that filing's own implied quarter-end price (value \u00f7 shares) — mark drift is priced OUT, so a stock that rallied while everyone trimmed can no longer sit here; legs without comparable shares (options/PRN) fall back to value change and the row says so on hover. Estimate at quarter-end marks, from filed numbers only.">MOST BOUGHT \u00b7 net traded $ (est)</div>${whlLaneRows(a.bought,'buy')}</div>`
    +`<div class="whl-lane"><div class="whl-lhd neg" data-tip="same traded-dollar basis as MOST BOUGHT — share change \u00d7 implied quarter-end price; these lanes and the crowding grid now read the SAME layer (share counts) and cannot disagree">MOST SOLD \u00b7 net traded $ (est)</div>${whlLaneRows(a.sold,'sell')}</div>`
    +`<div class="whl-lane"><div class="whl-lhd new">CONSENSUS OPENS \u00b7 new positions</div>${whlLaneRows(a.opens,'opens')}</div>`
    +`<div class="whl-lane"><div class="whl-lhd exitc">EXITS \u00b7 positions closed</div>${whlLaneRows(a.exits,'exits')}</div>`
    +`</div>`
    +`<div class="whl-crowd"><div class="whl-lhd amber">CROWDING \u00b7 who holds what</div>${rosterNote}${crowd}`
    +`<div class="whl-legend"><span><span class="whl-cell none"></span>no position</span><span><span class="whl-cell hold"></span>holds</span><span><span class="whl-cell add"></span>added</span><span><span class="whl-cell trim"></span>trimmed</span><span><span class="whl-cell new"></span>new</span><span><span class="whl-cell exit"></span>exited</span></div></div>`
    +`<div class="whl-foot">consensus across YOUR ${a.nFunds} watched fund(s) only \u2014 not the market \u00b7 net $ mixes share deltas and value deltas where shares aren't comparable (options/PRN rows); hover shows the per-fund legs verbatim \u00b7 a lane row dominated by one fund's leg says so on hover</div>`;
  host.querySelectorAll('[data-whlq]').forEach(b=>b.onclick=async()=>{
    try{ WHL.season=await fetchJSON('/api/whale?season='+encodeURIComponent(b.dataset.whlq)); renderWhlSeason(); }catch(_){} });
}
// On-demand pull: the row/modal "find latest filing" button and the terminal's `whale pull`
// share this one path. The button narrates its own lifecycle in place (finding… / up to date /
// the error verbatim) instead of an alert — the answer belongs where the question was asked.
async function whlPull(key, btn){
  if(btn){ btn.disabled=true; btn.textContent='finding\u2026'; }
  const r=await whlPost({op:'pull',key});
  if(r&&r.ok){ if(btn) btn.textContent=r.ingested?'found '+(r.q||''):'up to date'; whlFetch(); }
  else if(btn){ btn.disabled=false; btn.textContent='find latest filing'; btn.setAttribute('data-tip',esc((r&&r.error)||'pull failed')); }
  return r;
}
// ---- fund detail modal ------------------------------------------------------------------------
function whlModalEnsure(){
  if(el('whlmodal')) return;
  const d=document.createElement('div'); d.id='whlmodal'; d.hidden=true;
  d.innerHTML=`<div id="whlwin"><button type="button" class="whl-x" id="whl-x" data-tip="close (Esc)">\u2715</button><div id="whlbody"></div></div>`;
  document.body.appendChild(d);
  d.addEventListener('click',(e)=>{ if(e.target===d) whlModalClose(); });
  el('whl-x').onclick=whlModalClose;   // Escape: overlay stack (core.js)
}
function whlModalClose(){ overlayPop('whl'); const d=el('whlmodal'); if(d) d.hidden=true; }
async function whlOpenFund(key,full){
  whlModalEnsure();
  const d=el('whlmodal'); d.hidden=false; overlayPush('whl', whlModalClose);
  el('whlbody').innerHTML='<div class="msg">Loading the book\u2026</div>';
  whlPost({op:'seen',key}).then(()=>whlFetch());   // clears the badge for everyone — seen is group state, like the rest of the app
  let f;
  try{ f=await fetchJSON('/api/whale?fund='+encodeURIComponent(key)+(full?'&full=1':'')); }
  catch(e){ el('whlbody').innerHTML=`<div class="msg err">${esc(e.message||'fetch failed')}</div>`; return; }
  if(!f.ok){
    el('whlbody').innerHTML=`<div class="msg err">${esc(f.error||'unavailable')}</div>`
      +(IS_ADMIN&&/no ingested 13F/.test(f.error||'')?`<button type="button" class="whl-btn" id="whl-mpull">find latest filing</button>`:'');
    const mp=el('whl-mpull'); if(mp) mp.onclick=async()=>{ const r=await whlPull(key,mp); if(r&&r.ok) whlOpenFund(key); };
    return; }
  renderWhlFund(f,!!full);
}
function whlDeltaBox(lbl,cls,rows,flow){
  const tip=rows.length?rows.slice(0,6).map(r=>(r.tk?r.tk:r.name.slice(0,18))+' '+(r.dSh!=null?((r.dSh>0?'+':'\u2212')+tcount(Math.abs(r.dSh))+' sh'):(r.dVal!=null?((r.dVal>0?'+':'\u2212')+whlMoney(Math.abs(r.dVal)).slice(1)):''))).join(' \u00b7 '):'none this quarter';
  return `<div class="whl-dbox" data-tip="${esc(lbl+' \u00b7 '+tip)}"><div class="whl-dlb">${lbl}</div><div class="whl-dn ${cls}">${rows.length}</div><div class="whl-dfl">${flow!==0?(flow>0?'+':'\u2212')+whlMoney(Math.abs(flow)).slice(1):'\u2014'}</div></div>`;
}
function renderWhlFund(f,full){
  const dcell=(p)=>{
    if(!p.d||p.d.cls==='na') return `<span class="na" data-tip="no prior filing ingested — no delta is claimed, not 'all new'">\u2014</span>`;
    if(p.d.cls==='new') return `<span class="new">NEW</span>`;
    if(p.d.cls==='flat') return `<span class="sec">\u2014</span>`;
    if(p.d.dSh!=null) return `<span class="${p.d.dSh>0?'pos':'neg'}">${whlSgnSh(p.d.dSh)}</span>`;
    return `<span class="${p.d.dVal>0?'pos':'neg'}" data-tip="value delta only — share counts aren't comparable across the two filings (options or principal-amount rows)">${(p.d.dVal>0?'+':'\u2212')}${whlMoney(Math.abs(p.d.dVal)).slice(1)}</span>`;
  };
  const rows=f.positions.map((p,i)=>`<tr class="whl-prow" data-tip="${esc(p.name+(p.put?' ('+p.put+'s)':'')+' \u00b7 cusip '+p.cusip+(p.cls?' \u00b7 '+p.cls:'')+' \u00b7 value $'+Math.round(p.value).toLocaleString()+(p.shares!=null?' \u00b7 '+Math.round(p.shares).toLocaleString()+' sh':' \u00b7 share count not claimed (PRN/mixed rows)')+(p.tk?' \u00b7 matched \u2192 '+p.tk:' \u00b7 not matched to a ticker \u2014 filed name only'))}">`
    +`<td class="r sec">${i+1}</td>`
    +`<td class="r">${p.pct!=null?p.pct.toFixed(1)+'%':'\u2014'}</td>`
    +`<td class="r">${whlMoney(p.value)}</td>`
    +`<td class="r">${whlSh(p.shares)}</td>`
    +`<td class="r">${dcell(p)}</td>`
    +`<td class="l">${esc(p.name)}${p.put?` <span class="whl-put ${p.put}">${esc(p.put.toUpperCase())}</span>`:''}${p.tk?` <span class="whl-tk" data-whltk="${esc(p.tk)}">${esc(p.tk)}</span>`:''}</td></tr>`).join('');
  const conc=f.positions.slice(0,10).map((p,i)=>`<span class="whl-cseg whlc${i%10}" style="width:${Math.max(0.4,p.pct||0)}%" data-tip="${esc((p.tk||p.name.slice(0,20))+' \u00b7 '+(p.pct!=null?p.pct.toFixed(1):'?')+'% of the 13F book')}"></span>`).join('')
    +(f.n>10?`<span class="whl-cseg rest" style="width:${Math.max(0,100-f.positions.slice(0,10).reduce((s,p)=>s+(p.pct||0),0)).toFixed(1)}%" data-tip="${esc('other '+(f.n-10)+' position(s)')}"></span>`:'');
  el('whlbody').innerHTML=`<div class="whl-mhd"><span class="whl-hd">${esc(f.name)}</span><span class="sec">\u00b7 CIK ${esc(String(f.cik))} \u00b7 whale ${esc(f.key)}</span>${f.url?` <a class="whl-lnk" href="${esc(safeHref(f.url))}" target="_blank" rel="noopener noreferrer">EDGAR \u2197</a>`:''}</div>`
    +`<div class="whl-meta"><span class="sec">quarter</span> <b>${esc(f.q||'?')}</b> <span class="sec">(period ${esc(f.period||'?')} \u00b7 ${esc(f.form||'13F-HR')} filed ${esc(whlDateStr(f.filedAt))} \u00b7 ${f.ageDays!=null?f.ageDays+'d old at pull':''}${f.amended?' \u00b7 AMENDED':''})</span></div>`
    +`<div class="whl-meta"><span class="sec">13F book</span> <b>${whlMoney(f.total)}</b> <span class="sec">across ${f.n} position(s)${f.nRaw>f.n?' ('+f.nRaw+' filed rows aggregated on cusip)':''}${f.prevTotal!=null?' \u00b7 vs '+whlMoney(f.prevTotal)+' prior Q':''}${f.truncated?' \u00b7 stored book truncated at cap ('+f.truncated+' tail positions dropped, disclosed)':''}${f.scaled?' \u00b7 <span class="whl-sclnote" data-tip="the 2023 13F amendments moved values to whole dollars, but this filer still reports in thousands — EDGAR accepts both silently. Detection: median filed value \u00f7 shares across SH rows implied sub-$1 share prices (\u2265 3-row sample floor); options and principal-amount rows excluded. Corrected \u00d71000, flagged on the stored filing.">values \u00d71000 (thousands filer)</span>':''}</span></div>`
    +(f.hasPrev?`<div class="whl-dstrip" data-tip="$ flows on the ADDED/TRIMMED boxes are TRADED dollars (share change \u00d7 the filing's implied quarter-end price) where shares were comparable — mark drift no longer counts as flow; NEW and EXITED are position values at their quarter-end marks">${whlDeltaBox('NEW','new',f.lanes.opened,f.flows.opened)}${whlDeltaBox('ADDED','pos',f.lanes.added,f.flows.added)}${whlDeltaBox('TRIMMED','neg',f.lanes.trimmed,f.flows.trimmed)}${whlDeltaBox('EXITED','exitc',f.lanes.exited,f.flows.exited)}</div>`
      :`<div class="sec whl-meta">no prior quarter ingested yet \u2014 the delta strip appears once both legs exist</div>`)
    +`<div class="tblwrap"><table class="whl-tbl"><thead><tr><th class="r">#</th><th class="r">% BOOK</th><th class="r">VALUE</th><th class="r" data-tip="shares as filed; a dash means the filing mixed principal-amount rows — no share count is claimed">SHARES</th><th class="r" data-tip="quarter-over-quarter: share delta when both filings report SH counts, value delta otherwise (disclosed per cell)">\u0394 QoQ</th><th class="l">NAME</th></tr></thead><tbody>${rows}</tbody></table></div>`
    +(!full&&f.n>f.shown?`<button type="button" class="whl-btn" id="whl-full">show all ${f.n} positions</button>`:'')
    +`<div class="whl-clbl">CONCENTRATION \u00b7 % OF 13F BOOK</div><div class="whl-cbar">${conc}</div>`
    +`<div class="whl-foot">source: SEC EDGAR 13F-HR \u00b7 quarter-end snapshot filed up to 45 days late \u2014 positioning HISTORY, not the current book \u00b7 long US-listed equity + listed options only; shorts, futures, non-US and cash are invisible \u00b7 % of book is value \u00f7 filing total \u00b7 tickers only on exact normalized name matches${f.scaled?' \u00b7 this filer reports in the pre-2023 thousands convention \u2014 values corrected \u00d71000, detection rule disclosed on the book line':''}</div>`;
  const fb=el('whl-full'); if(fb) fb.onclick=()=>whlOpenFund(f.key,true);
  el('whlbody').querySelectorAll('[data-whltk]').forEach(t=>t.onclick=()=>{
    const r=[...state.rows.values()].find(x=>x.ticker===t.dataset.whltk&&!x.delisted);
    if(r){ whlModalClose(); openDetail(r.coin); } });
}
// ---- terminal: the whale family ---------------------------------------------------------------
function termWhaleList(){
  const think=termThinking();
  // RETURNED, not fired: a chat capture (dmRunCmd) awaits the verb, and a promise dropped on the
  // floor here meant the answer arrived after the sink was gone — into the hidden panel.
  return fetchJSON('/api/whale').then(d=>{ think.remove(); WHL.data=d;
    if(!d.watch.length) return termOut('<span class="sec">no funds watched yet'+(IS_ADMIN?' \u2014 <span class="ex" data-tcmd="whale add ">whale add &lt;name or CIK&gt;</span>':' \u2014 the operator curates the list')+'</span>');
    const lines=d.watch.map(w=>`  <span role="button" tabindex="0" class="tp-deep" data-tcmd="whale ${tesc(w.key)}">${tpad(tesc(w.key),12)}</span> ${tpad(tesc(w.name.slice(0,22)),24)} ${tpad(w.q?tesc(w.q):'\u2014',8)} ${tpad(w.total!=null?whlMoney(w.total):'\u2014',9,true)} ${tpad(w.dPct!=null?((w.dPct>0?'+':'')+w.dPct.toFixed(1)+'%'):'\u2014',8,true)}${w.unseen?' <span class="amber">\u25cf unseen</span>':''}${w.amended&&!w.unseen?' <span class="sec">HR/A</span>':''}`).join('\n');
    const win=d.window&&d.window.cur?`${d.window.cur.q} window ${d.window.state} \u00b7 due ${new Date(d.window.cur.deadline).toLocaleDateString('en-US',{month:'short',day:'numeric'})}`:'';
    termOut(`<span class="tp-hd">tracked 13F funds</span> <span class="tp-trans">\u00b7 the FUNDS tab list, verbatim \u00b7 ${tesc(win)}</span>\n<span class="tp-th">  ${tpad('KEY',12)} ${tpad('NAME',24)} ${tpad('LAST',8)} ${tpad('BOOK',9,true)} ${tpad('\u0394QoQ',8,true)}</span>\n${lines}\n<span class="tp-trans">whale &lt;key&gt; opens the book \u00b7 whale season for the quarter summary \u00b7 quarter-end books filed up to 45d late</span>`);
  }).catch(()=>{ think.remove(); termErr('whale list fetch failed \u2014 try again in a moment'); });
}
function termWhaleFund(key,full){
  const think=termThinking();
  return fetchJSON('/api/whale?fund='+encodeURIComponent(key)+(full?'&full=1':'')).then(f=>{ think.remove();
    if(!f.ok) return termErr(tesc(f.error||'unavailable'));
    const dl=f.hasPrev?`\n<span class="tp-k">${tpad('QoQ',14)}</span> <span class="pos">${f.lanes.opened.length} new</span> \u00b7 <span class="pos">${f.lanes.added.length} added</span> \u00b7 <span class="neg">${f.lanes.trimmed.length} trimmed</span> \u00b7 <span class="sec">${f.lanes.exited.length} exited</span>`:'';
    const rows=f.positions.slice(0,full?f.positions.length:10).map((p,i)=>{
      const d=!p.d||p.d.cls==='na'?'\u2014':p.d.cls==='new'?'<span class="amber">NEW</span>':p.d.cls==='flat'?'\u2014':(p.d.dSh!=null?`<span class="${p.d.dSh>0?'pos':'neg'}">${whlSgnSh(p.d.dSh)}</span>`:`<span class="${p.d.dVal>0?'pos':'neg'}">${(p.d.dVal>0?'+':'\u2212')+whlMoney(Math.abs(p.d.dVal)).slice(1)}</span>`);
      return `  <span class="tp-trans">${tpad(String(i+1),3)}</span> ${tpad(p.pct!=null?p.pct.toFixed(1)+'%':'\u2014',7,true)} ${tpad(whlMoney(p.value),8,true)} ${tpad(d,10,true)}  ${tesc(p.name.slice(0,26))}${p.put?' <span class="'+(p.put==='put'?'neg':'pos')+'">'+tesc(p.put.toUpperCase())+'</span>':''}${p.tk?' <span role="button" tabindex="0" class="tp-deep" data-tcmd="'+tesc(p.tk)+'">'+tesc(p.tk)+'</span>':''}`; }).join('\n');
    termOut(`<span class="tp-hd">${tesc(f.key)} 13F</span> <span class="tp-trans">\u00b7 ${tesc(f.name)} \u00b7 CIK ${tesc(String(f.cik))}</span>\n<span class="tp-k">${tpad('quarter',14)}</span> <b>${tesc(f.q||'?')}</b> <span class="tp-trans">(filed ${tesc(whlDateStr(f.filedAt))} \u00b7 ${f.ageDays!=null?f.ageDays+'d old':''}${f.amended?' \u00b7 AMENDED':''})</span>\n<span class="tp-k">${tpad('book',14)}</span> <b>${whlMoney(f.total)}</b> <span class="tp-trans">\u00b7 ${f.n} positions${f.prevTotal!=null?' \u00b7 vs '+whlMoney(f.prevTotal)+' prior Q':''}${f.scaled?' \u00b7 values \u00d71000 (thousands filer, corrected + disclosed)':''}</span>${dl}\n<span class="tp-th">  ${tpad('#',3)} ${tpad('%BOOK',7,true)} ${tpad('VALUE',8,true)} ${tpad('\u0394QoQ',10,true)}  NAME</span>\n${rows}\n<span class="tp-trans">${full?'':'top '+Math.min(10,f.positions.length)+' of '+f.n+' \u00b7 <span class="ex" data-tcmd="whale '+tesc(f.key)+' full">whale '+tesc(f.key)+' full</span> for all \u00b7 '}quarter-end snapshot filed up to 45d late \u00b7 long US book only \u00b7 full card on the FUNDS tab</span>`);
    whlPost({op:'seen',key:f.key});
  }).catch(()=>{ think.remove(); termErr('whale fetch failed \u2014 try again in a moment'); });
}
function termWhaleSeason(q){
  const think=termThinking();
  return fetchJSON('/api/whale?season='+encodeURIComponent(q||'')).then(s=>{ think.remove();
    if(!s.ok) return termErr(tesc(s.error||'no season'));
    const a=s.agg;
    const l=(rows,neg)=>rows.slice(0,3).map(r=>`${r.tk?tesc(r.tk):tesc(r.name.slice(0,14))}${r.put?' <span class="'+(r.put==='put'?'neg':'pos')+'">'+tesc(r.put)+'s</span>':''} ${(r.net!=null?(r.net>0?'+':'\u2212')+whlMoney(Math.abs(r.net)).slice(1):whlMoney(r.tot))}${r.n!=null?' ('+r.n+'/'+a.nFunds+')':''}`).join(' \u00b7 ')||'\u2014';
    termOut(`<span class="tp-hd">${tesc(s.q)} 13F season</span> <span class="tp-trans">\u00b7 ${s.filedN}/${s.watchN} filed${s.missing&&s.missing.length?' \u00b7 missing '+tesc(s.missing.join(',')):''}${s.healed?' \u00b7 rebuilt from stored books':s.amended?' \u00b7 rebuilt after amendment':''}</span>\n<span class="tp-k" data-tip="net traded $ — share change \u00d7 implied quarter-end price">${tpad('most bought',14)}</span> <span class="pos">${l(a.bought)}</span>\n<span class="tp-k">${tpad('most sold',14)}</span> <span class="neg">${l(a.sold)}</span>\n<span class="tp-k">${tpad('opens',14)}</span> <span class="amber">${l(a.opens)}</span>\n<span class="tp-k">${tpad('exits',14)}</span> <span class="sec">${l(a.exits)}</span>\n<span class="tp-k">${tpad('crowding',14)}</span> ${a.crowd.slice(0,3).map(r=>(r.tk?tesc(r.tk):tesc(r.name.slice(0,12)))+' '+r.held+'/'+a.nFunds).join(' \u00b7 ')||'\u2014'}\n<span class="tp-trans">consensus across your ${a.nFunds} watched fund(s) only \u2014 full breakdown with per-fund legs lives on the FUNDS tab</span>`);
  }).catch(()=>{ think.remove(); termErr('season fetch failed'); });
}
export { WHL, openFunds, termWhaleFund, termWhaleList, termWhaleSeason, whlMoney, whlOpenFund, whlPost, whlPull, whlSgnSh, whlSh };
