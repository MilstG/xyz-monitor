// report.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { _act, renderActionable } from "./actionable.js";
import { IS_ADMIN, attachLineHover, hoverChart, lcTicks } from "./admin.js";
import { pushToast } from "./alerts.js";
import { showView } from "./backtest.js";
import { el, esc, fmtPrice, state } from "./core.js";
import { fetchJSON } from "./data.js";
import { openSigHistory, shDate } from "./drawer.js";
import { HELP } from "./nav.js";
import { loadTriggers } from "./triggers.js";


// ===== AI analyst report (Report tab) ==========================================================

function aiFmtLeft(ms){ if(ms==null||ms<=0) return ''; return ms>=3600000?(ms/3600000).toFixed(1)+'h':Math.max(1,Math.round(ms/60000))+'m'; }
// Live cooldown readout: M:SS (or H:MM:SS past an hour). "now" once the cooldown has elapsed.
function aiFmtCountdown(ms){ if(ms==null||ms<=0) return 'now'; const s=Math.round(ms/1000);
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60, p=n=>String(n).padStart(2,'0');
  return h>0?`${h}:${p(m)}:${p(ss)}`:`${m}:${p(ss)}`; }
function aiFmtAgo(ms){ if(ms==null||ms<0) return 'just now'; const s=Math.round(ms/1000);
  if(s<60) return s+'s'; const m=Math.floor(s/60); if(m<60) return m+'m';
  const h=Math.floor(m/60); if(h<48) return h+'h'; return Math.floor(h/24)+'d'; }
// One shared 1s tick drives the report freshness UI so the countdown actually counts down and the
// regenerate button unlocks the moment the cooldown lapses — no waiting on the 60s data poll. Cheap:
// it no-ops whenever the report elements aren't on the page.
function aiTickCountdown(){
  const cd=el('ai-cd');
  if(cd){ const until=+cd.dataset.until, left=until-Date.now();
    cd.textContent=aiFmtCountdown(left);
    if(left<=0){ const b=el('ai-regen'); if(b&&b.disabled&&!b.dataset.cap){ b.disabled=false; b.title='cooldown elapsed — regenerate for everyone'; } cd.classList.add('pos'); } }
  const ag=el('ai-age'); if(ag){ ag.textContent=aiFmtAgo(Date.now()-(+ag.dataset.ts)); } }

export function __boot_report_12113() {// Client for /api/ai-report: universe-validated ticker search, the report card, an annotated
// daily candle chart, and the shared recent-reports feed. Contract mirrors the server: this is a
// synthesis layer that READS the ledger — every number on the card (R/R, EV, risk) arrives
// pre-computed server-side from validated levels; the chart is drawn HERE from /api/candles and
// the server's level list, so it cannot disagree with the data. Regenerate is cooldown-gated
// server-side — the disabled button is convenience, the 429 is the gate.
HELP.report=`
<div class="hlp-h">What this is</div>
<p>One ticker, everything this server holds on it — trend ladder (D1 · H12 · H4), live signals with their frozen claim geometry, this name's own out-of-sample track record, positioning (OI, funding), benchmark decomposition, volatility regime, divergence flags, coverage gaps, and (equities) earnings event risk and sector context — compiled into one context object and synthesized by the configured model — <b>Claude Fable 5</b> or <b>GPT-5.6 Sol</b> depending on which provider key the server carries, with an automatic same-family fallback — into a plain-language read. The card footer names the model that actually produced each report.</p>
<div class="hlp-h">What the numbers are</div>
<p>The <b>VP</b> toggle overlays the volume profile \u2014 where volume actually transacted over a 365d composite (last 90d weighted 1.5\u00d7), with the POC dotted and high-volume nodes accented. On stocks this is <b>DEX volume</b>: this venue\u2019s tape, not the cash market \u2014 real positioning information for trading here, and labelled for exactly what it is. HVNs are audited against a matched placebo in Analytics \u00b7 Levels before any of it earns weight beyond the disclosed hand-set map.</p>
<p>The <b>risk unit</b> is the distance from the price at generation to the void level — when a live claim exists, the void IS that claim's frozen stop (the model cannot move it). Per-scenario <b>R/R</b> and the <b>expected value</b> are computed server-side from the validated levels and probabilities, never taken from the model's prose. Scenario odds are anchored on the name's own base rates; where n is thin, the card says so.</p>
<div class="hlp-h">Cache &amp; regenerate</div>
<p>Reports are cached for <i>everyone</i> — one generation serves the whole group. Regenerate unlocks when the TTL expires or on material change (a new claim opened, a claim resolved, an earnings print landed); the reason shows on the card. The cooldown is enforced server-side, so the cache is the group's rate limit by construction.</p>
<div class="hlp-h">What this is not</div>
<p>Not a ledger signal. The report has no frozen side/void/target geometry of its own and never enters the track record — it reads the ledger, it cannot write to it.</p>`;
setInterval(aiTickCountdown,1000);
// Trigger cursor: polled on its own cadence so an alert lands whether or not the Actionable
// tab is the one you're looking at. Server-side detection means nothing is missed while closed.
// The alert pull now rides applySnapshot's alertVer check, so this is only a cold-start prime plus
// a slow safety net for the case where the snapshot path itself is wedged.
setTimeout(loadTriggers,4000); setInterval(loadTriggers,5*60*1000);
// Ago is elapsed wall-clock, so a static render goes stale. Cheap repaint, only while visible.
setInterval(()=>{ if(state.view==='actionable'&&_act) renderActionable(); },30*1000);
}

function aiMatches(qs){ qs=(qs||'').trim().toUpperCase(); if(!qs) return [];
  const out=[];
  for(const r of state.rows.values()){ if(r.delisted) continue;
    const tk=(r.ticker||'').toUpperCase(), cn=(r.coin||'').toUpperCase();
    if(tk.startsWith(qs)||cn.startsWith(qs)) out.push({r,rank:0});
    else if(tk.includes(qs)) out.push({r,rank:1}); }
  out.sort((a,b)=>(a.rank-b.rank)||((b.r.vol||0)-(a.r.vol||0)));
  return out.slice(0,8).map(x=>x.r); }
function aiRenderSug(list){ const box=el('ai-sug'); if(!box) return;
  if(!list.length){ box.innerHTML='<div class="none">no match in the live universe — only universe tickers can be searched</div>'; box.hidden=false; return; }
  box.innerHTML=list.map((r,i)=>`<div class="row${i===0?' sel':''}" data-coin="${esc(r.coin)}"><span>${esc(r.ticker||r.coin)}</span><span class="u">${r.uni==='main'?'crypto':'stocks'}</span></div>`).join('');
  box.hidden=false;
  box.querySelectorAll('.row').forEach(el2=>el2.addEventListener('mousedown',ev=>{ ev.preventDefault(); aiPick(el2.dataset.coin); })); }
function aiPick(coin){ const box=el('ai-sug'); if(box) box.hidden=true;
  const r=state.rows.get(coin); const q=el('ai-q'); if(q&&r) q.value=r.ticker||coin;
  state.report.coin=coin; loadAiReport(coin); }
function openAiReport(coin){ state.report.coin=coin; showView('report');
  const r=state.rows.get(coin), q=el('ai-q');
  if(q){ if(r) q.value=r.ticker||coin; else if(String(coin).startsWith('grp:sec:')) q.value=coin.slice(8)+' (sector)';
    else if(String(coin).startsWith('grp:bkt:')) q.value='basket: '+coin.slice(8).split('+').join(' '); }
  loadAiReport(coin); }
function openReportView(){
  const q=el('ai-q');
  if(q&&!q.dataset.wired){ q.dataset.wired='1';
    q.addEventListener('input',()=>{ const v=q.value; if(!v.trim()){ el('ai-sug').hidden=true; return; } aiRenderSug(aiMatches(v)); });
    q.addEventListener('keydown',e=>{
      const box=el('ai-sug');
      if(e.key==='Escape'){ box.hidden=true; return; }
      if(e.key==='Enter'){ const sel=box&&!box.hidden?box.querySelector('.row.sel')||box.querySelector('.row'):null;
        if(sel) aiPick(sel.dataset.coin);
        else { const m=aiMatches(q.value); if(m.length) aiPick(m[0].coin); }
        return; }
      if((e.key==='ArrowDown'||e.key==='ArrowUp')&&box&&!box.hidden){ e.preventDefault();
        const rows=[...box.querySelectorAll('.row')]; if(!rows.length) return;
        let i=rows.findIndex(x=>x.classList.contains('sel')); i=(i+(e.key==='ArrowDown'?1:-1)+rows.length)%rows.length;
        rows.forEach((x,j)=>x.classList.toggle('sel',j===i)); } });
    q.addEventListener('blur',()=>{ setTimeout(()=>{ const b=el('ai-sug'); if(b) b.hidden=true; },150); }); }
  const note=el('ai-note'); if(note) note.textContent='everything the server holds on one name, synthesized by Claude — cached for the whole group; regenerate unlocks on TTL or material change';
  // No active report but a focused ticker exists → open its report instead of a blank pane.
  if(!state.report.coin && state.focus && state.rows.has(state.focus)){ state.report.coin=state.focus;
    const fr=state.rows.get(state.focus); if(q&&fr) q.value=fr.ticker||state.focus; }
  if(state.report.coin) loadAiReport(state.report.coin); else { const p=el('ai-report'); if(p) p.hidden=true; }
  loadAiRecent();
  if(!state.report.tick) state.report.tick=setInterval(()=>{ const v=el('view-report');
    if(!v||v.hidden) return;
    loadAiRecent();
    if(state.report.coin&&!state.report.gen) loadAiReport(state.report.coin,true); },60000);
}
async function loadAiReport(coin,quiet){
  const box=el('ai-report'); if(!box) return;
  if(!quiet){ box.hidden=false; box.innerHTML='<div class="msg">Loading report…</div>'; }
  try{ const d=await fetchJSON('/api/ai-report?coin='+encodeURIComponent(coin));
    if(state.report.coin!==coin) return;
    const prev=state.report.data;
    state.report.data=d;
    // quiet tick: repaint only when something the card shows actually changed (a new generation,
    // or the freshness state flipping) — a full innerHTML swap mid-read resets chart hover/scroll
    if(quiet&&prev&&prev.ts===d.ts&&prev.status===d.status) return;
    renderAiReport(d,coin); }
  catch(e){ if(!quiet) box.innerHTML=`<div class="msg err">report load failed — ${esc(e.message)}</div>`; }
}
async function aiRegenerate(coin){
  if(state.report.gen) return; state.report.gen=true; renderAiGenState(coin,true);
  try{
    const r=await fetch('/api/ai-report',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({coin})});
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d.ok){ state.report.data=d.report; if(state.report.coin===coin) renderAiReport(d.report,coin); loadAiRecent();
      pushToast('AI report generated — cached for everyone'+(d.admin?' · admin (unlimited)':(d.userDayLeft!=null?' · yours: '+d.userDayLeft+'/'+d.userPerDay+' today, '+d.userMonthLeft+'/'+d.userPerMonth+' this month':(d.dayLeft!=null?' · '+d.dayLeft+'/'+d.perDay+' left today':'')))); }
    else if(r.status===429&&d.error==='user-day-cap'){ pushToast('Your daily report budget is spent ('+(d.userPerDay||3)+'/day) — resets at midnight UTC'); if(state.report.coin===coin) loadAiReport(coin,true); }
    else if(r.status===429&&d.error==='user-month-cap'){ pushToast('Your monthly report budget is spent ('+(d.userPerMonth||20)+'/month) — resets on the 1st (UTC)'); if(state.report.coin===coin) loadAiReport(coin,true); }
    else if(r.status===429&&d.error==='daily-cap'){ pushToast('The shared daily report pool is exhausted ('+(d.perDay||5)+'/day across all users) — resets at midnight UTC, or an admin can reset it in the terminal'); if(state.report.coin===coin) loadAiReport(coin,true); }
    else if(r.status===429){ pushToast('On cooldown — regenerate unlocks in '+aiFmtLeft(d.regenInMs)+' (or on material change)'); if(d.report&&state.report.coin===coin){ state.report.data=d.report; renderAiReport(d.report,coin); } }
    else if(r.status===401&&d.error==='ai-locked'){ pushToast(IS_ADMIN?'AI is locked — open the terminal (~) and run: admin unlock <password>':'AI generation is locked by the operator'); }
    else pushToast('Generation failed — '+(d.error||('HTTP '+r.status)));
  }catch(e){ pushToast('Generation failed — '+e.message); }
  state.report.gen=false; if(state.report.coin===coin) renderAiGenState(coin,false);
}
// ---- group report card (grp:sec:* / grp:bkt:*) -------------------------------------------
// Deliberately prose-tier: no geometry, no marks, no ledger claim — and the card SAYS so.
// The EW-index chart carries a full crosshair readout; the breadth strip hovers per cell.
function grpLabelOf(coin,d){ if(d&&d.label) return d.label;
  if(String(coin).startsWith('grp:sec:')) return coin.slice(8)+' (sector)';
  if(String(coin).startsWith('grp:bkt:')) return coin.slice(8).split('+').join(' · ');
  return coin; }
function grpIndexSvg(idx){
  const W=640,H=170,PL=40,PR=14,PT=10,PB=22;
  const pts=(idx||[]).filter(p=>p&&p.v!=null&&isFinite(p.v));
  if(pts.length<2) return '<div class="sec" style="padding:14px 4px">not enough shared history to draw the equal-weight index yet</div>';
  const vs=pts.map(p=>p.v); let lo=Math.min(...vs),hi=Math.max(...vs); if(hi-lo<1e-6){lo-=1;hi+=1;}
  const X=i=>PL+(W-PL-PR)*i/(pts.length-1), Y=v=>PT+(H-PT-PB)*(1-(v-lo)/(hi-lo));
  const path=pts.map((p,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(p.v).toFixed(1)).join(' ');
  const y100=(100>=lo&&100<=hi)?`<line x1="${PL}" x2="${W-PR}" y1="${Y(100).toFixed(1)}" y2="${Y(100).toFixed(1)}" stroke="var(--faint)" stroke-dasharray="3 3"/><text x="${W-PR+2}" y="${(Y(100)+3).toFixed(1)}" fill="var(--faint)" font-size="9">100</text>`:'';
  const gl=[lo,hi].map(v=>`<text x="4" y="${(Y(v)+3).toFixed(1)}" fill="var(--faint)" font-size="9">${v.toFixed(0)}</text>`).join('');
  return `<div class="cg-chartwrap" style="position:relative">
    <svg id="grp-ix" viewBox="0 0 ${W} ${H}" style="width:100%;display:block" data-n="${pts.length}">
      ${gl}${y100}
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>
      <line id="grp-cx" x1="0" x2="0" y1="${PT}" y2="${H-PB}" stroke="var(--faint)" visibility="hidden"/>
      <circle id="grp-cd" r="3" fill="var(--accent)" visibility="hidden"/>
      <rect x="${PL}" y="${PT}" width="${W-PL-PR}" height="${H-PT-PB}" fill="transparent" id="grp-hit"/>
    </svg>
    <div class="cg-read" id="grp-read"></div>
    <div class="sec" style="font-size:var(--fs-2xs);margin-top:2px">equal-weight index of member daily closes, rebased to 100 — a synthetic composite, drawn for context only; no levels are annotated on it by design (structure on a synthetic index would be false precision)</div>
  </div>`;
}
function grpWireIndexHover(idx){
  const svg=el('grp-ix'),hit=el('grp-hit'),cx=el('grp-cx'),cd=el('grp-cd'),rd=el('grp-read');
  if(!svg||!hit) return;
  const pts=(idx||[]).filter(p=>p&&p.v!=null&&isFinite(p.v)); if(pts.length<2) return;
  const W=640,PL=40,PR=14,PT=10,PB=22,H=170;
  const vs=pts.map(p=>p.v); let lo=Math.min(...vs),hi=Math.max(...vs); if(hi-lo<1e-6){lo-=1;hi+=1;}
  const X=i=>PL+(W-PL-PR)*i/(pts.length-1), Y=v=>PT+(H-PT-PB)*(1-(v-lo)/(hi-lo));
  const mv=e=>{ const r=svg.getBoundingClientRect(); const fx=(e.clientX-r.left)/r.width*W;
    let i=Math.round((fx-PL)/(W-PL-PR)*(pts.length-1)); i=Math.max(0,Math.min(pts.length-1,i));
    const p=pts[i];
    cx.setAttribute('x1',X(i).toFixed(1)); cx.setAttribute('x2',X(i).toFixed(1)); cx.setAttribute('visibility','visible');
    cd.setAttribute('cx',X(i).toFixed(1)); cd.setAttribute('cy',Y(p.v).toFixed(1)); cd.setAttribute('visibility','visible');
    if(rd){ rd.textContent=p.d+' · '+p.v.toFixed(1)+' ('+(p.v>=100?'+':'')+(p.v-100).toFixed(1)+'% since rebase)'; rd.style.display='block'; } };
  const out=()=>{ cx.setAttribute('visibility','hidden'); cd.setAttribute('visibility','hidden'); if(rd) rd.style.display='none'; };
  hit.addEventListener('mousemove',mv); hit.addEventListener('mouseleave',out);
}
function renderAiGroupReport(d,coin,box){
  const label=grpLabelOf(coin,d);
  const budget=(d&&d.dayLeft!=null?`<div class="sec" style="font-size:var(--fs-xs);margin-top:6px">${d.admin?'admin — unlimited':(d.userDayLeft!=null?'yours: '+d.userDayLeft+'/'+d.userPerDay+' today · '+d.userMonthLeft+'/'+d.userPerMonth+' this month · ':'')+'shared pool '+d.dayLeft+'/'+d.perDay+' today'}</div>`:'');
  if(!d||d.status==='none'||!d.ai){
    box.innerHTML=`<div class="ai-head"><span class="tk">${esc(label)}</span><span class="sec">group report</span></div>`
      +`<div class="msg" style="padding:22px 10px">No report for this ${String(coin).startsWith('grp:sec:')?'sector':'basket'} yet.${d&&d.error?'<br><span class="neg" style="font-size:var(--fs-sm)">'+esc(d.error)+'</span>':''}<br><span class="sec" style="font-size:var(--fs-sm)">Group reads are prose-tier: breadth, leadership and rotation over an equal-weight basket — no entry/stop/target, nothing enters the track record.</span></div>`
      +(d&&d.enabled!==false&&!d.error?`<div style="text-align:center;padding-bottom:12px"><button class="btn" id="ai-regen" ${d&&d.dayLeft===0&&!d.admin?'disabled data-cap="1" title="shared daily pool exhausted — resets at midnight UTC"':''}>generate group report</button>${budget}</div>`:'');
    const b=el('ai-regen'); if(b) b.onclick=()=>aiRegenerate(coin);
    return;
  }
  const c=d.computed||{}, br=c.breadth||{};
  const stateLine=(d.status==='fresh'?`<span class="pos">fresh</span> · regenerate in <b id="ai-cd" data-until="${Date.now()+(d.regenInMs||0)}">${aiFmtCountdown(d.regenInMs)}</b>`
    :d.status==='invalidated'?`<span style="color:var(--accent)">invalidated — ${esc(d.invalidReason||'format updated')}</span>`
    :'<span class="sec">stale</span> · <span class="pos">regenerate available</span>')
    +(d.dayLeft!=null?` · <span class="sec">pool ${d.dayLeft}/${d.perDay}</span>`:'')
    +(d.admin?' · <span class="sec">admin ∞</span>':d.userDayLeft!=null?` · <span class="${d.userDayLeft>0?'sec':'neg'}">yours ${d.userDayLeft}/${d.userPerDay}d · ${d.userMonthLeft}/${d.userPerMonth}m</span>`:'');
  const chips=(d.members||[]).map(t=>`<span class="cg-chip" data-tip="member of this ${String(coin).startsWith('grp:sec:')?'sector':'basket'}">${esc(t)}</span>`).join(' ');
  const brRow=(k,v,tip)=>v==null?'':`<span class="sec" style="margin-right:12px" data-tip="${esc(tip)}"><b>${esc(k)}</b> ${esc(String(v))}</span>`;
  box.innerHTML=`<div class="ai-head"><span class="tk">${esc(label)}</span><span class="sec">group report · ${d.memberCount||''} members</span></div>
    <div style="margin:6px 0 8px"><span class="ai-badge ${d.ai.bias==='short'?'short':d.ai.bias==='neutral'?'neutral':''}">${esc(d.ai.headline)}</span></div>
    <div class="sec" style="font-size:var(--fs-xs);margin-bottom:6px">${stateLine} · <span id="ai-age" data-ts="${d.ts}">${aiFmtAgo(Date.now()-d.ts)}</span> old · ${esc(d.model||'')}</div>
    ${grpIndexSvg(c.ewIndex)}
    <div style="margin:8px 0 4px">${brRow('up today',br.pctUpD1!=null?br.pctUpD1+'%':null,'share of members positive on the day')}${brRow('above 200dma',br.pctAboveMa200!=null?br.pctAboveMa200+'%':null,'share of members above their 200-day SMA (of those with enough history)')}${brRow('avg pair corr',c.avgPairCorr,'average pairwise 30d correlation of member daily returns — high means one trade wearing many names')}${brRow('7d dispersion',c.dispersionD7!=null?c.dispersionD7+'pp':null,'cross-sectional stdev of member 7d returns — how differently the members are trading')}</div>
    <div style="margin:4px 0 10px">${chips}</div>
    ${(d.ai.read||[]).map(p=>`<p style="margin:6px 0">${esc(p)}</p>`).join('')}
    <div class="hlp-h">Leaders</div><p style="margin:4px 0">${esc(d.ai.leaders||'')}</p>
    <div class="hlp-h">Laggards</div><p style="margin:4px 0">${esc(d.ai.laggards||'')}</p>
    ${(d.ai.risks&&d.ai.risks.length)?`<div class="hlp-h">Risks</div><p style="margin:4px 0">${d.ai.risks.map(esc).join(' · ')}</p>`:''}
    ${(d.ai.watch&&d.ai.watch.length)?`<div class="hlp-h">What would change the read</div><p style="margin:4px 0">${d.ai.watch.map(esc).join(' · ')}</p>`:''}
    <div class="sec" style="font-size:var(--fs-2xs);margin-top:8px">Group reads are prose-tier by design: no frozen side/void/target, no ledger claim, no track record — a breadth-and-rotation synthesis over an equal-weight composite, cached for the whole group like any report.</div>
    <div style="text-align:center;padding:10px 0"><button class="btn" id="ai-regen" ${(!d.canRegen)?'disabled title="on cooldown"':''} ${d.dayLeft===0&&!d.admin?'disabled data-cap="1" title="shared daily pool exhausted"':''}>regenerate</button>${budget}</div>`;
  grpWireIndexHover(c.ewIndex);
  const b=el('ai-regen'); if(b&&!b.disabled) b.onclick=()=>aiRegenerate(coin);
}
function renderAiGenState(coin,on){ const b=el('ai-regen'); if(!b) return;
  if(on){ b.disabled=true; b.innerHTML='<span class="ai-gen"><span class="sdot"></span>generating…</span>'; }
  else { b.disabled=false; b.textContent='regenerate'; } }
function aiBiasBadge(d){ const cls=d.ai.bias==='short'?'short':d.ai.bias==='neutral'?'neutral':'';
  const warn=d.ai.eventRisk?' warn':'';
  return `<span class="ai-badge ${cls}${warn}">${esc(d.ai.headline)}</span>`; }
function renderAiReport(d,coin){
  const box=el('ai-report'); if(!box) return; box.hidden=false;
  if(String(coin).startsWith('grp:')||(d&&d.kind==='group')) return renderAiGroupReport(d,coin,box);
  const r=state.rows.get(coin);
  const tk=(d&&d.ticker)||(r&&r.ticker)||coin;
  const uni=(d&&d.uni)||(r&&r.uni==='main'?'crypto':'stocks');
  if(!d||d.status==='none'){
    box.innerHTML=`<div class="ai-head"><span class="tk">${esc(tk)}</span><span class="sec">${uni} universe</span>${r&&r.px!=null?`<span class="px">${fmtPrice(r.px)}</span>`:''}</div>`+
      `<div class="msg" style="padding:26px 10px">No report for this name yet.${d&&d.enabled===false?'<br><span class="sec" style="font-size:var(--fs-sm)">ANTHROPIC_API_KEY is not set on the server — generation is disabled.</span>':' The first generation is cached for the whole group.'}</div>`+
      (d&&d.enabled!==false?`<div style="text-align:center;padding-bottom:12px"><button class="btn" id="ai-regen" ${d&&d.dayLeft===0?'disabled data-cap="1" title="daily budget exhausted — resets at midnight UTC, or admin reset-reports in the terminal"':''}>generate report</button>${d&&d.dayLeft!=null?`<div class="sec" style="font-size:var(--fs-xs);margin-top:6px" data-tip="daily generation budget, shared by the whole group — resets at midnight UTC; an admin can reset it early from the ask terminal">${d.dayLeft}/${d.perDay} generations left today</div>`:''}</div>`:'');
    const b=el('ai-regen'); if(b) b.onclick=()=>aiRegenerate(coin);
    return;
  }
  const c=d.computed||{}, livePx=r&&r.px!=null?r.px:c.px0;
  const chg=r&&r.d1!=null&&isFinite(r.d1)?`<span class="${r.d1>=0?'pos':'neg'}">${r.d1>=0?'+':''}${(+r.d1).toFixed(2)}% today</span>`:'';
  const stateLine=(d.status==='fresh'?`<span class="pos">fresh</span> · regenerate in <b id="ai-cd" data-until="${Date.now()+(d.regenInMs||0)}">${aiFmtCountdown(d.regenInMs)}</b>`
    :d.status==='invalidated'?`<span style="color:var(--accent)">invalidated — ${esc(d.invalidReason||'material change')}</span>`
    :'<span class="sec">stale</span> · <span class="pos">regenerate available</span>')
    +(d.dayLeft!=null?` · <span class="${d.dayLeft>0?'sec':'neg'}" data-tip="daily generation budget, shared by all non-admin users — resets at midnight UTC; an admin can reset it early from the ask terminal (admin reset-reports)">${d.dayLeft}/${d.perDay} today</span>`:'')
    +(d.admin?' · <span class="sec" data-tip="admin — unlimited generations, burns no budget">admin ∞</span>'
      :d.userDayLeft!=null?` · <span class="${d.userDayLeft>0?'sec':'neg'}" data-tip="your personal budget — ${d.userPerDay}/day and ${d.userPerMonth}/month, resets at midnight UTC / on the 1st">yours ${d.userDayLeft}/${d.userPerDay}d · ${d.userMonthLeft}/${d.userPerMonth}m</span>`:'');
  const capped=d.dayLeft===0;
  const ev=(d.ai.evidence||[]).map(e2=>`<tr><td class="k">${esc(e2.k)}</td><td>${esc(e2.v)}</td></tr>`).join('');
  const hasRisk=c.riskAbs!=null;
  const scen=(c.scenarios||[]).map(s=>{
    // Color follows the MONEY, not the label: a "target" scenario that pays negative (an
    // adverse-direction target the model mislabeled) renders red, the void renders red, the
    // event coin-flip renders amber. Kind is the fallback only when no payoff exists.
    const col=s.payoffR!=null?(s.payoffR>0?'var(--up)':s.payoffR<0?'var(--down)':'var(--accent)')
      :(s.kind==='target'?'var(--up)':s.kind==='void'?'var(--down)':s.kind==='event'?'var(--accent)':'var(--muted)');
    const rr=s.kind==='target'&&s.rr!=null&&s.payoffR>0?s.rr.toFixed(1)+' : 1':s.kind==='void'?'stop':'—';
    const pay=s.payoffR==null?'—':s.kind==='event'?'<span class="sec" data-tip="the print decides — treated as a coin flip; contributes 0 to EV by construction">coin-flip</span>'
      :`<span class="${s.payoffR>0?'pos':s.payoffR<0?'neg':'sec'}">${s.payoffR>0?'+':''}${s.payoffR.toFixed(1)}R</span>`;
    const tip=esc((s.note||'')+(s.target!=null?` · level ${fmtPrice(s.target)}`:''));
    return `<span class="nm" style="color:${col}" data-tip="${tip}">${esc(s.name)}</span>`+
      `<div class="bar"><i style="width:${Math.round(s.p*100)}%;background:${col};opacity:.55"></i></div>`+
      `<span>${Math.round(s.p*100)}%</span>`+(hasRisk?`<span>${rr}</span><span>${pay}</span>`:''); }).join('');
  const flags=(c.flags||[]).map(f=>`<div class="ai-flag"><b style="color:var(--accent)">\u25c6 ${esc(f.kind.replace(/_/g,' '))}</b> — ${esc(f.txt)}${f.t?` <span class="sec">(${shDate(f.t)})</span>`:''}</div>`).join('');
  const cov=c.coverage||null;
  const covGaps=cov?[].concat((cov.oiGaps||[]).map(g=>`OI sampling gap ${shDate(g.from)} \u2192 ${shDate(g.to)} (${g.hours}h) — positioning stats exclude it`),
    (cov.hourlyGaps||[]).map(g=>`price-spine gap ${shDate(g.from)} \u2192 ${shDate(g.to)} (${g.hours}h)`)):[];
  const covHtml=cov?`<div class="ai-flag">${covGaps.length?covGaps.map(t=>`<div><b class="sec">\u25c7 coverage</b> — ${esc(t)}</div>`).join(''):`<div><b class="sec">\u25c7 coverage</b> — no gaps in the ${cov.windowDays}d window</div>`}</div>`:'';
  const inv=(d.ai.invalidations||[]).map(s=>`· ${esc(s)}`).join('<br>');
  const evBox=c.evR!=null
    ?`Expected value \u2248 <b class="${c.evR>0?'pos':c.evR<0?'neg':'sec'}">${c.evR>0?'+':''}${c.evR.toFixed(2)}R</b> per unit risked · risk unit = distance to the void at ${fmtPrice(c.voidLevel)} (${c.riskPct!=null?'\u2212'+c.riskPct.toFixed(1)+'%':'\u2014'} from the mark at generation)${c.correctedVoid?' · <span data-tip="the model proposed a different void; the server overwrote it with the live claim\u2019s frozen stop — geometry is never model-controlled">void pinned to the frozen claim stop</span>':''}${c.correctedTarget?' · <span data-tip="the target price is stated twice in the payload — as the chart level and as the scenario\u2019s own figure; the level is the single source of truth and the scenario was reconciled to it, so the chart and the R/R column can never show two different targets">target reconciled to the chart level</span>':''}`
    :'<span class="sec">No frozen void level on this name right now — per-scenario R/R and EV are not computable, and the card won\u2019t fabricate them.</span>';
  box.innerHTML=`
    <div class="ai-head"><span class="tk">${esc(tk)}</span>
      <span class="sec">${r&&r.nm?esc(r.nm)+' · ':''}${uni==='crypto'?'Hyperliquid perp · crypto':'xyz-dex perp · stocks'}</span>
      <span class="px">${fmtPrice(livePx)}</span>${chg}
      ${aiBiasBadge(d)}</div>
    ${(()=>{const ar=d.analystRecord;if(!ar)return'';const o=ar.overall||{},m=ar.thisName||{};
      const f=(x)=>x&&x.n?`<b class="${x.hit>=0.5?'pos':'neg'}">${Math.round(x.hit*100)}%</b> hit \u00b7 <span class="${x.avgR>=0?'pos':'neg'}">${x.avgR>=0?'+':''}${x.avgR}R</span> <i style="font-style:normal;color:var(--faint);font-size:var(--fs-2xs)">(n=${x.n})</i>`:null;
      const ov=f(o), mn=f(m);
      return `<div class="sec" style="font-size:var(--fs-xs);margin:2px 0 8px" data-tip="the analyst's OWN out-of-sample record: every directional report read is frozen as a claim at generation — the report's void as the stop, its target, mark at generation — and resolved at a 5d horizon, stop-aware, in a bucket fully separate from the signal engine's record. Same discipline the signals answer to; a report that sounds authoritative earns it here or it doesn't.${ar.openOnName?' \u00b7 a read on this name is currently open and resolving':''}">analyst reads: ${ov||'first reads still open \u2014 resolutions land at 5d horizons'}${mn?` \u00b7 this name ${mn}`:''}${ar.open?` \u00b7 ${ar.open} open`:''}</div>`;})()}
    <div class="dsec">The picture in one paragraph</div>
    <div class="ai-syn">${esc(d.ai.synthesis)}</div>
    ${aiChartTfSeg(coin,c)}
    <div id="ai-chart"><div class="msg" style="padding:14px 0">loading candles…</div></div>
    <div class="dsec">What the data says</div>
    <table class="ai-ev">${ev}</table>
    ${d.ai.eventRisk?`<div class="dsec">Event risk</div><div class="ai-event">${esc(d.ai.eventRisk)}</div>`:''}
    <div class="dsec">Track record on this name</div>
    <div id="ai-claims" class="sec" style="font-size:var(--fs-sm)">loading claim history…</div>
    ${(flags||covHtml)?`<div class="dsec">Flags</div>${flags}${covHtml}`:''}
    ${aiActionHtml(c)}
    <div class="dsec">Scenarios${c.riskPct!=null?` · risk unit = distance to ${fmtPrice(c.voidLevel)} (\u2212${c.riskPct.toFixed(1)}%)`:''}</div>
    <div class="ai-scen${hasRisk?'':' norisk'}"><span class="h">scenario</span><span class="h b"></span><span class="h">odds</span>${hasRisk?'<span class="h">r/r</span><span class="h">payoff</span>':''}${scen}</div>
    <div class="ai-evbox">${evBox}</div>
    <div class="dsec">What would change the read</div>
    <div class="ai-inv">${inv}</div>
    <div class="ai-foot">
      <span>${esc(d.model||'')} · generated ${shDate(d.ts)} (<b id="ai-age" data-ts="${d.ts}">${aiFmtAgo(Date.now()-d.ts)}</b> ago) · ${stateLine}</span>
      <span class="contract" data-tip="no frozen side/void/target geometry of its own — the report reads the ledger and can never enter it">synthesis layer — not a ledger signal</span>
      <button class="btn" id="ai-regen" ${d.canRegen&&!capped?'':'disabled'}${capped?' data-cap="1"':''} title="${capped?'daily budget exhausted — resets at midnight UTC, or admin reset-reports in the terminal':d.canRegen?'compile fresh data and regenerate for everyone':'unlocks on TTL expiry or material change (new claim · claim resolved · earnings print)'}">regenerate</button>
    </div>`;
  const b=el('ai-regen'); if(b) b.onclick=()=>aiRegenerate(coin);
  box.querySelectorAll('[data-aitf]').forEach(el2=>el2.addEventListener('click',()=>{
    state.report.tf=el2.dataset.aitf;
    box.querySelectorAll('[data-aitf]').forEach(x=>x.classList.toggle('on',x===el2));
    const hd=el2.closest('.dsec'); if(hd) hd.firstChild.textContent=(state.report.tf==='1d'?'Daily':state.report.tf==='12h'?'12-hour':'4-hour')+' chart · key levels and events marked';
    aiReportChart(coin,c); }));
  box.querySelectorAll('[data-aivp]').forEach(el2=>el2.addEventListener('click',()=>{
    state.report.vp=state.report.vp===false?true:false;
    el2.classList.toggle('on',state.report.vp!==false);
    aiReportChart(coin,c); }));
  if(state.report.gen) renderAiGenState(coin,true);
  aiReportChart(coin,c);
  aiLoadClaims(coin);
}
function aiActionHtml(c){
  const a=c&&c.action; if(!a) return '';
  if(a.stance==='enter_now'||a.stance==='enter_on_pullback'){
    const sideCol=a.side==='short'?'var(--down)':'var(--up)';
    return `<div class="dsec">If you act on this · mechanical plan, not advice</div>
    <div class="ai-act">
      <span class="cell"><span class="k">side</span><b style="color:${sideCol}">${esc((a.side||'').toUpperCase())}</b></span>
      <span class="cell"><span class="k">entry</span><b>${a.entryIsMarket?fmtPrice(a.entry)+' <i class="sec">(market)</i>':fmtPrice(a.entry)+' <i class="sec">(pullback)</i>'}</b></span>
      <span class="cell"><span class="k">stop / void</span><b class="neg">${fmtPrice(a.stop)}</b> <i class="sec">(−${a.riskPct!=null?a.riskPct.toFixed(1):'—'}%)</i></span>
      <span class="cell"><span class="k">target</span><b class="pos">${fmtPrice(a.target)}</b></span>
      <span class="cell"><span class="k">r/r</span><b>${a.rr!=null?a.rr.toFixed(1)+' : 1':'—'}</b></span>
      <span class="cell"><span class="k">ev</span><b class="${a.evR>0?'pos':'neg'}">${a.evR>0?'+':''}${a.evR!=null?a.evR.toFixed(2):'—'}R</b></span>
    </div>${a.note?`<div class="sec" style="font-size:var(--fs-sm);line-height:1.6;margin-top:4px">${esc(a.note)}</div>`:''}`;
  }
  const lbl=a.stance==='take_profit'?'Take profit':a.stance==='no_trade'?'No trade':'Wait';
  return `<div class="dsec">If you act on this · mechanical plan, not advice</div>
    <div class="ai-act muted"><span class="cell"><span class="k">stance</span><b style="color:var(--accent)">${lbl.toUpperCase()}</b></span>
    <span style="font-size:var(--fs-sm);line-height:1.6;align-self:center">${esc(a.note||'the odds and geometry don\u2019t support an entry here')}${a.downgraded?' <i class="sec" data-tip="the model proposed an entry, but the expected value at that entry was not positive — the server downgraded it rather than shipping a losing plan">(server-downgraded)</i>':''}</span></div>`;
}
async function aiLoadClaims(coin){
  const box=el('ai-claims'); if(!box) return;
  try{ const d=await fetchJSON('/api/ledger?coin='+encodeURIComponent(coin));
    if(!box.isConnected) return;
    const res=d.closed.filter(e=>e.status==='resolved');
    if(!res.length&&!d.open.length){ box.innerHTML='<span class="sec">nothing ever fired on this name — the record starts with the first claim</span>'; return; }
    const wins=res.filter(e=>e.win).length;
    const head=res.length?`<b class="${wins/res.length>=0.5?'pos':'neg'}">${Math.round(100*wins/res.length)}%</b> hit across <b>${res.length}</b> resolved claim(s)${d.open.length?` · <b>${d.open.length}</b> open`:''}`:`<b>${d.open.length}</b> open claim(s), none resolved yet`;
    const rows=res.slice(0,3).map(e=>{
      const out=e.realized==null?'\u2014':`<span class="${e.realized>0?'pos':'neg'}">${e.realized>0?'+':''}${e.realized.toFixed(1)}${e.unit==='R'?'R':e.unit}</span>`;
      const dur=e.tR?((e.tR-e.t0)/86400000).toFixed(1)+'d':'';
      return `<tr><td class="d">${shDate(e.t0)}</td><td>${esc(e.label)} — ${out}${e.stopped?' <span class="sec" data-tip="resolved on the stop-aware track: the frozen void was touched before the horizon">(stopped)</span>':''}${dur?` in ${dur}`:''}</td></tr>`; }).join('');
    box.className=''; box.innerHTML=`<div style="font-size:var(--fs-sm);margin-bottom:4px">${head} · <span class="sec" style="cursor:pointer;text-decoration:underline;text-underline-offset:2px" id="ai-fullhist">full history \u2192</span></div><table class="ai-claims">${rows}</table>`;
    const fh=el('ai-fullhist'); if(fh) fh.onclick=()=>openSigHistory(d.ticker||coin);
  }catch(_){ box.innerHTML='<span class="sec">claim history unavailable</span>'; }
}
function aiChartTfSeg(coin,c){
  const cur=state.report.tf||'1d';
  return `<div class="dsec" style="display:flex;align-items:center;gap:8px">${cur==='1d'?'Daily':cur==='12h'?'12-hour':'4-hour'} chart · key levels and events marked<span class="cdtf-seg" style="margin-left:auto">${['1d','12h','4h'].map(t=>`<button class="cdtf ai-tf${t===cur?' on':''}" data-aitf="${t}">${t.toUpperCase()}</button>`).join('')}<button class="cdtf ai-vp${state.report.vp!==false?' on':''}" data-aivp="1" title="volume profile \u2014 where the volume transacted (365d composite, last 90d \u00d71.5). POC dotted, HVNs accented, per-bin hover. Stocks: DEX volume \u2014 this venue\u2019s tape, not the cash market.">VP</button></span></div>`;
}
async function aiReportChart(coin,c){
  const box=el('ai-chart'); if(!box) return;
  const tf=state.report.tf||'1d';
  try{
    const d=await fetchJSON('/api/candles?coin='+encodeURIComponent(coin)+'&tf='+tf);
    if(!box.isConnected||((state.report.tf||'1d')!==tf)) return;
    const SHOW=tf==='1d'?92:tf==='12h'?110:120;
    const cd=(d.candles||[]).slice(-SHOW);
    if(cd.length<10){ box.innerHTML='<div class="msg" style="padding:14px 0">not enough '+tf+' candles yet — the series is still filling server-side</div>'; return; }
    const px=d.px!=null&&isFinite(d.px)?+d.px:null;
    const closes=cd.map(k=>+k[4]); if(px!=null) closes[closes.length-1]=px;   // live mark drives the forming bar, matching the ladder
    const emaW=(N)=>{ const out=[],k2=2/(N+1); let e=closes[0]; for(let i=0;i<closes.length;i++){ e=i===0?closes[0]:closes[i]*k2+e*(1-k2); out.push(e); } return out; };
    const e13=emaW(13), e21=emaW(21);
    const levels=(c&&c.levels)||[], marks=(c&&c.marks)||[], flags=(c&&c.flags)||[];
    const noOHLC=cd.filter(k=>k[1]==null||!isFinite(+k[1])).length;
    const lineMode=noOHLC>cd.length/3;   // deep fallback only — the server now rebuilds daily OHLC from the hourly spine
    const W=640,H=300,pl=6,pr=56,pt=10,pb=20,n=cd.length;
    // Domain from PRICE ACTION ONLY — a far level never squashes the candles; off-domain levels
    // are listed under the chart instead of stretching it.
    let lo=Infinity,hi=-Infinity;
    for(const k of cd){ const l=k[3]!=null&&isFinite(+k[3])?+k[3]:+k[4], h=k[2]!=null&&isFinite(+k[2])?+k[2]:+k[4]; if(l<lo)lo=l; if(h>hi)hi=h; }
    if(px!=null){ if(px<lo)lo=px; if(px>hi)hi=px; }
    const span0=hi-lo;
    for(const l of levels){ if(l.value>=lo-span0*0.12&&l.value<=hi+span0*0.12){ if(l.value<lo)lo=l.value; if(l.value>hi)hi=l.value; } }
    const pad=(hi-lo)*0.05; hi+=pad; lo-=pad;
    const inView=v=>v>=lo&&v<=hi;
    const offView=levels.filter(l=>!inView(l.value));
    const X=i=>pl+(i+0.5)/n*(W-pl-pr), Y=v=>pt+(1-(v-lo)/(hi-lo))*(H-pt-pb);
    const ticks=lcTicks(lo,hi,4);
    const step=ticks.length>1?ticks[1]-ticks[0]:(hi-lo)/4;
    const axDec=step>=1?(step>=10?0:1):Math.min(6,Math.max(0,Math.ceil(-Math.log10(step))+1));
    const axf=v=>v.toFixed(axDec);
    const bw=Math.max(2.2,Math.min(6,(W-pl-pr)/n*0.62));
    let s='';
    for(const v of ticks){ const y=Y(v).toFixed(1);
      s+=`<line x1="${pl}" y1="${y}" x2="${W-pr}" y2="${y}" stroke="var(--grid)" stroke-width="1"/><text x="${W-pr+5}" y="${(+y+3).toFixed(1)}" class="lc-tick">${axf(v)}</text>`; }
    // ===== dex volume profile histogram (build -22) =====
    // Right-anchored inside the plot, drawn BEFORE structure and price so it reads as terrain the
    // tape moves through, never competing with the annotations. Bin fill: HVNs accented, POC as a
    // dotted line; every bin carries a hover readout (price, share, node type, value area) with
    // the composite convention and the dex-volume caveat stated where the number is, not in a
    // footnote nobody reads. Toggleable (VP button); levels for the map ride the same server
    // object, so the histogram and the screener's Swing R column can never disagree.
    if(state.report.vp!==false && d.vp && Array.isArray(d.vp.bins) && d.vp.bins.length){
      const vp=d.vp; let maxV=0; for(const b of vp.bins) if(b[1]>maxV) maxV=b[1];
      if(maxV>0){ const HW=64, x1=W-pr, bh=Math.max(1.4,(H-pt-pb)/vp.bins.length*0.86);
        for(const [pV,share] of vp.bins){ if(pV<lo||pV>hi) continue;
          const y=Y(pV), w2=Math.max(0.6,HW*share/maxV);
          const isH=vp.hvn.some(h2=>h2.p===pV), isL=vp.lvn.some(l2=>l2.p===pV), isP=pV===vp.poc;
          const inVA=pV>=vp.vaLo&&pV<=vp.vaHi;
          s+=`<rect x="${(x1-w2).toFixed(1)}" y="${(y-bh/2).toFixed(1)}" width="${w2.toFixed(1)}" height="${bh.toFixed(1)}" fill="${isH?'var(--accent)':'var(--muted)'}" fill-opacity="${isH?'0.32':inVA?'0.16':'0.10'}"/>`
            +`<rect x="${(x1-HW).toFixed(1)}" y="${(y-bh/2).toFixed(1)}" width="${HW}" height="${bh.toFixed(1)}" fill="transparent" data-tip="${esc(`${fmtPrice(pV)} \u00b7 ${(share*100).toFixed(1)}% of transacted volume${isP?' \u00b7 POC \u2014 highest-volume price':''}${isH?' \u00b7 HVN \u2014 high-volume node (audited vs placebo in Analytics \u00b7 Levels)':''}${isL?' \u00b7 LVN \u2014 thin, price traverses fast':''}${inVA?' \u00b7 inside the 70% value area':''} \u00b7 365d composite, last 90d weighted ${vp.recentW}\u00d7${d.dexVol?' \u00b7 DEX volume \u2014 this venue\u2019s tape, not the cash market':''}`)}"/>`; }
        if(vp.poc>=lo&&vp.poc<=hi) s+=`<line x1="${pl}" y1="${Y(vp.poc).toFixed(1)}" x2="${x1}" y2="${Y(vp.poc).toFixed(1)}" stroke="var(--accent)" stroke-width="1" stroke-opacity="0.5" stroke-dasharray="1 3"/>`;
      }
    }
    // Structural levels: the confirmed pivot clusters the analyst's void had to land on. Drawn
    // here — before price, faint — so they read as the evidence behind the read rather than
    // competing with the void/target annotations. Deliberately unlabelled: up to eight of them
    // would wreck the collision-staggered label column, so the detail (touches, age, distance)
    // lives on a hit-rect tooltip one hover away. Server-shipped with the report, never
    // re-derived here: the chart may not disagree with the validator that accepted the read.
    const struct=((c&&c.structLevels)||[]).filter(l=>l&&isFinite(+l.v)&&inView(+l.v)
      &&!levels.some(x=>x.value>0&&Math.abs(+l.v/x.value-1)<0.002));
    for(const l of struct){ const y=Y(+l.v);
      const col=l.side==='flip'?'var(--accent)':(l.side==='res'?'var(--down)':'var(--up)');
      const what=l.side==='flip'?'flip \u2014 has served as both resistance and support':(l.side==='res'?'resistance':'support');
      const tip=`${fmtPrice(+l.v)} \u00b7 ${what} \u00b7 ${l.n} confirmed pivot touch${l.n===1?'':'es'}, most recent ${l.ageD}d ago \u00b7 ${l.distPct>=0?'+':''}${(+l.distPct).toFixed(1)}% from the mark \u00b7 detected structure, not an annotation \u2014 a directional read with no frozen claim must place its void on one of these or the report is rejected server-side`;
      s+=`<line x1="${pl}" y1="${y.toFixed(1)}" x2="${W-pr}" y2="${y.toFixed(1)}" stroke="${col}" stroke-width="1" stroke-opacity="0.24" stroke-dasharray="2 4"/>`
        +`<rect x="${pl}" y="${(y-4).toFixed(1)}" width="${W-pl-pr}" height="8" fill="transparent" data-tip="${esc(tip)}"/>`; }
    const zl=levels.find(l=>l.kind==='zone_low'), zh=levels.find(l=>l.kind==='zone_high');
    if(zl&&zh&&inView(zl.value)&&inView(zh.value)){ let zt=Y(Math.max(zl.value,zh.value)), zb=Y(Math.min(zl.value,zh.value));
      s+=`<rect x="${pl}" y="${zt.toFixed(1)}" width="${W-pl-pr}" height="${Math.max(2,zb-zt).toFixed(1)}" fill="var(--accent)" fill-opacity="0.06" stroke="var(--accent)" stroke-opacity="0.45" stroke-dasharray="3 3"/>`; }
    const lineLv=levels.filter(l=>l.kind!=='zone_low'&&l.kind!=='zone_high'&&inView(l.value));
    for(const l of lineLv){ const col=l.kind==='void'?'var(--down)':l.kind==='target'?'var(--up)':'var(--muted)';
      s+=`<line x1="${pl}" y1="${Y(l.value).toFixed(1)}" x2="${W-pr}" y2="${Y(l.value).toFixed(1)}" stroke="${col}" stroke-dasharray="5 4"/>`; }
    // EMA 13/21 ribbon: band fill between the two, then both lines — same visual language as the trend modal
    { let up='',dn=''; for(let i=0;i<n;i++){ up+=(i===0?'M':'L')+X(i).toFixed(1)+' '+Y(e13[i]).toFixed(1)+' '; }
      for(let i=n-1;i>=0;i--){ dn+='L'+X(i).toFixed(1)+' '+Y(e21[i]).toFixed(1)+' '; }
      s+=`<path d="${up}${dn}Z" fill="var(--blue)" fill-opacity="0.08"/>`;
      let p13='',p21=''; for(let i=0;i<n;i++){ p13+=(i===0?'M':'L')+X(i).toFixed(1)+' '+Y(e13[i]).toFixed(1)+' '; p21+=(i===0?'M':'L')+X(i).toFixed(1)+' '+Y(e21[i]).toFixed(1)+' '; }
      s+=`<path d="${p13}" fill="none" stroke="var(--blue)" stroke-width="1.1" stroke-opacity="0.75"/><path d="${p21}" fill="none" stroke="var(--blue)" stroke-width="1.4" stroke-opacity="0.9"/>`; }
    if(lineMode){
      let p2=''; for(let i=0;i<n;i++){ const cc=i===n-1&&px!=null?px:closes[i]; p2+=(i===0?'M':'L')+X(i).toFixed(1)+' '+Y(cc).toFixed(1)+' '; }
      s+=`<path d="${p2}" fill="none" stroke="var(--text)" stroke-width="1.6"/>`;
    } else {
      for(let i=0;i<n;i++){ const k=cd[i], o=k[1],h=k[2],l=k[3];
        const cc=i===n-1&&px!=null?px:+k[4];
        if(o==null||!isFinite(+o)){ s+=`<line x1="${(X(i)-bw/2).toFixed(1)}" y1="${Y(cc).toFixed(1)}" x2="${(X(i)+bw/2).toFixed(1)}" y2="${Y(cc).toFixed(1)}" stroke="var(--muted)" stroke-width="1.6"/>`; continue; }
        const up=cc>=+o, col=up?'var(--up)':'var(--down)', x=X(i);
        if(h!=null&&l!=null&&isFinite(+h)&&isFinite(+l)) s+=`<line x1="${x.toFixed(1)}" y1="${Y(Math.max(+h,cc)).toFixed(1)}" x2="${x.toFixed(1)}" y2="${Y(Math.min(+l,cc)).toFixed(1)}" stroke="${col}" stroke-width="1.1"/>`;
        const y0=Y(Math.max(+o,cc)), hh=Math.max(1.2,Math.abs(Y(+o)-Y(cc)));
        s+=`<rect x="${(x-bw/2).toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${col}"${up?' fill-opacity="0.85"':''}/>`; }
    }
    { const labs=lineLv.map(l=>({l, y:Y(l.value)})).sort((a,b)=>a.y-b.y);
      for(let i=1;i<labs.length;i++) if(labs[i].y-labs[i-1].y<15) labs[i].y=labs[i-1].y+15;
      for(let i=labs.length-1;i>=0;i--){ const max=H-pb-4-(labs.length-1-i)*15; if(labs[i].y>max) labs[i].y=max; }
      for(let i=1;i<labs.length;i++) if(labs[i].y-labs[i-1].y<15) labs[i].y=labs[i-1].y+15;
      for(const {l,y} of labs){ const col=l.kind==='void'?'var(--down)':l.kind==='target'?'var(--up)':'var(--muted)';
        const ty=Math.max(pt+10,Math.min(H-pb-3,y-4));
        s+=`<text x="${pl+6}" y="${ty.toFixed(1)}" class="lc-tick" style="fill:${col};paint-order:stroke;stroke:var(--panel);stroke-width:3.5px">${fmtPrice(l.value)} — ${esc(l.label)}</text>`; } }
    const tfMs=tf==='1d'?86400000:tf==='12h'?43200000:14400000;
    const nearIdx=t=>{ let bi=0,bd=Infinity; for(let i=0;i<n;i++){ const dd=Math.abs(+cd[i][0]-t); if(dd<bd){bd=dd;bi=i;} } return bd<=2*tfMs?bi:null; };
    // ===== side-typed first-fire markers + legend =====
    // Server ships first-fires only (episode-run filtered) with side, status and outcome on each
    // mark. Here: same-kind marks within a bar of each other collapse into ONE lettered glyph
    // whose ×N counts DISTINCT signal types at onset; the legend below decodes every letter with
    // names, dates and ledger outcomes. Placement is semantic — longs under the low, shorts
    // above the high — so the glyph itself points at the trade.
    const AI_MK={ long:{col:'var(--up)'}, short:{col:'var(--down)'}, ctx:{col:'var(--accent)'}, flag:{col:'var(--accent)'}, earn:{col:'var(--blue)'} };
    const noteAt={}, items=[];
    for(const m of marks){ const i=nearIdx(m.t); if(i!=null) items.push(Object.assign({i},m)); }
    for(const f of flags){ if(!f.t) continue; const i=nearIdx(f.t); if(i!=null) items.push({i,t:f.t,kind:'flag',ev:f.kind,label:f.txt,status:null}); }
    items.sort((a,b)=>a.t-b.t);
    const groups=[];
    for(const it of items){
      noteAt[it.i]=(noteAt[it.i]?noteAt[it.i]+' · ':'')+it.label;
      const g=groups.find(x=>x.kind===it.kind&&Math.abs(x.i-it.i)<=1);
      if(g){ g.items.push(it); if(it.i>g.i) g.i=it.i; } else groups.push({kind:it.kind,i:it.i,t:it.t,items:[it]});
    }
    const LETTERS='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    groups.forEach((g,gi)=>{ g.key=LETTERS[gi]||('#'+(gi+1)); });
    for(const g of groups){ const x=X(g.i), k=cd[g.i];
      const lowV=k[3]!=null&&isFinite(+k[3])?+k[3]:+k[4], hiV=k[2]!=null&&isFinite(+k[2])?+k[2]:+k[4];
      const col=(AI_MK[g.kind]||AI_MK.ctx).col, cnt=g.items.length;
      const tag=g.key+(cnt>1?' \u00d7'+cnt:'');
      if(g.kind==='short'){ const y=Math.max(pt+12,Y(hiV)-10);
        s+=`<path d="M${x.toFixed(1)} ${(y+8).toFixed(1)} l-4.4 -8 l8.8 0 z" fill="${col}"/>`+
           `<text x="${(x+6).toFixed(1)}" y="${(y+6).toFixed(1)}" class="lc-tick" style="fill:${col}">${tag}</text>`; }
      else if(g.kind==='earn'){ const y=Math.min(H-pb-14,Y(lowV)+10);
        s+=`<rect x="${(x-4.5).toFixed(1)}" y="${y.toFixed(1)}" width="9" height="9" fill="var(--panel)" stroke="${col}" transform="rotate(45 ${x.toFixed(1)} ${(y+4.5).toFixed(1)})"/>`+
           `<text x="${(x+8).toFixed(1)}" y="${(y+9).toFixed(1)}" class="lc-tick" style="fill:${col}">${tag}</text>`; }
      else if(g.kind==='flag'||g.kind==='ctx'){ const y=Math.max(pt+12,Y(hiV)-7);
        s+=`<text x="${(x-4).toFixed(1)}" y="${y.toFixed(1)}" style="fill:${col};font-size:var(--fs-xs)">\u25c6</text>`+
           `<text x="${(x+7).toFixed(1)}" y="${y.toFixed(1)}" class="lc-tick" style="fill:${col}">${tag}</text>`; }
      else { const y=Math.min(H-pb-12,Y(lowV)+9);
        s+=`<path d="M${x.toFixed(1)} ${y.toFixed(1)} l-4.4 8 l8.8 0 z" fill="${col}"/>`+
           `<text x="${(x+6).toFixed(1)}" y="${(y+8).toFixed(1)}" class="lc-tick" style="fill:${col}">${tag}</text>`; } }
    const xs=cd.map((_,i)=>X(i));
    const dfmt=t=>{ const dd=new Date(+t); const base=(dd.getUTCMonth()+1)+'/'+dd.getUTCDate();
      return tf==='1d'?base:base+' '+String(dd.getUTCHours()).padStart(2,'0')+':00'; };
    const rows=cd.map((k,i)=>{ const o=k[1],cc=i===n-1&&px!=null?px:+k[4];
      const body=o!=null&&isFinite(+o)?`O ${fmtPrice(+o)} · H ${fmtPrice(+k[2])}<br>L ${fmtPrice(+k[3])} · C ${fmtPrice(cc)}`:`C ${fmtPrice(cc)} <span class="sec">(close-only bar)</span>`;
      return `<b style="color:var(--text)">${dfmt(k[0])}</b><br>${body}<br><span style="color:var(--blue)">EMA13 ${fmtPrice(e13[i])} · EMA21 ${fmtPrice(e21[i])}</span>`+
        (noteAt[i]?`<br><span style="color:var(--accent)">${esc(noteAt[i])}</span>`:''); });
    s+=`<text x="${pl}" y="${H-6}" class="lc-tick">${dfmt(cd[0][0])}</text><text x="${W-pr}" y="${H-6}" text-anchor="end" class="lc-tick">${dfmt(cd[n-1][0])}</text>`;
    let below='';
    if(groups.length){
      const dshort=t=>{ const dd=new Date(+t); return (dd.getUTCMonth()+1)+'/'+dd.getUTCDate(); };
      const outTxt=it=>{ if(it.kind==='flag'||it.kind==='ctx'||it.kind==='earn') return '';
        if(it.status==='resolved'&&it.realized!=null){ const u=it.unit==='R'?'R':(it.unit||'');
          return `<span class="${it.realized>0?'pos':'neg'}">${it.realized>0?'+':''}${it.realized.toFixed(1)}${u}</span>${it.days?` in ${it.days}d`:''}`; }
        if(it.status==='void') return '<span class="sec">voided</span>';
        return '<span class="sec">open</span>'; };
      const rows=groups.map(g=>{ const col=(AI_MK[g.kind]||AI_MK.ctx).col;
        const gl=g.kind==='short'?'\u25bc':g.kind==='earn'?'\u25c7':(g.kind==='flag'||g.kind==='ctx')?'\u25c6':'\u25b2';
        const cnt=g.items.length;
        const body=g.items.map(it=>{ const o=outTxt(it); return esc(it.label)+(o?' \u2014 '+o:''); }).join(' · ');
        return `<tr><td style="white-space:nowrap;padding:2px 10px 2px 0;color:${col}">${g.key} ${gl} ${dshort(g.t)}${cnt>1?' \u00d7'+cnt:''}</td><td style="padding:2px 0">${body}</td></tr>`; }).join('');
      below+=`<div class="ai-mkleg">`+
        `<div class="keys"><span><i style="color:var(--up)">\u25b2</i> long signal (below bar)</span>`+
        `<span><i style="color:var(--down)">\u25bc</i> short signal (above bar)</span>`+
        `<span><i style="color:var(--accent)">\u25c6</i> context / positioning</span>`+
        `<span><i style="color:var(--blue)">\u25c7</i> earnings print</span>`+
        `<span class="sec">\u00d7N = distinct signal types at onset \u00b7 first fires only \u00b7 proven-edge signals only</span></div>`+
        `<table>${rows}</table>`+
        (c&&c.marksSuppressed?`<div class="sec" style="font-size:var(--fs-xs);margin-top:5px">${c.marksSuppressed} fire(s) from unproven or negative-edge signal types not marked \u2014 the ledger records them all (full history \u2192 Signals tab)</div>`:'')+
        `</div>`;
    } else if(c&&c.marksSuppressed){
      below+=`<div class="sec" style="font-size:var(--fs-xs);margin-top:6px">${c.marksSuppressed} signal fire(s) in the window, none from a proven-edge type \u2014 nothing marked; the ledger records them all</div>`;
    }
    if(offView.length) below+=`<div class="sec" style="font-size:var(--fs-xs);margin-top:4px">off-chart: ${offView.map(l=>`${fmtPrice(l.value)} — ${esc(l.label)} (${l.value<lo?'below':'above'} view)`).join(' · ')}</div>`;
    if(struct.length) below+=`<div class="sec" style="font-size:var(--fs-xs);margin-top:4px">${struct.length} detected structural level(s) drawn faint \u2014 confirmed daily pivot clusters (<span style="color:var(--up)">support</span> \u00b7 <span style="color:var(--down)">resistance</span> \u00b7 <span style="color:var(--accent)">flip</span>); hover any for its touch count and age. Without a frozen claim, the void above had to sit on one of them.</div>`;
    if(lineMode) below+=`<div class="sec" style="font-size:var(--fs-xs);margin-top:4px">close-line mode — full candles return automatically as the daily backfill refreshes (warm-cache dailies carry closes only)</div>`;
    box.innerHTML=hoverChart(s,{w:W,h:H,pt,pb,xs,rows})+below;
    attachLineHover();
  }catch(e){ box.innerHTML=`<div class="msg" style="padding:14px 0">chart unavailable — ${esc(e.message)}</div>`; }
}
async function loadAiRecent(){
  const box=el('ai-recent'); if(!box) return;
  try{ const d=await fetchJSON('/api/ai-reports');
    if(!box.isConnected) return;
    state.report.list=d;
    if(!d.reports||!d.reports.length){
      box.innerHTML=`<div class="dsec">Recent reports · cached for everyone</div><div class="sec" style="font-size:var(--fs-sm)">none yet — search a ticker above and generate the first one${d.enabled===false?' (no AI API key set on the server)':''}</div>`;
      return; }
    const rows=d.reports.map(rep=>{
      const st=rep.status==='fresh'?`fresh · ${aiFmtLeft(rep.regenInMs)} left`:rep.status==='invalidated'?`invalidated — ${esc(rep.invalidReason||'')}`:'stale';
      return `<tr><td><span class="tk" data-aicoin="${esc(rep.coin)}">${esc(rep.ticker||rep.coin)}</span></td>`+
        `<td class="sec">${rep.uni==='crypto'?'crypto':'stocks'}</td>`+
        `<td>${esc(rep.headline||'')}</td>`+
        `<td>${rep.evR!=null?`<span class="${rep.evR>0?'pos':rep.evR<0?'neg':'sec'}">${rep.evR>0?'+':''}${rep.evR.toFixed(2)}R</span>`:'<span class="na">\u2014</span>'}</td>`+
        `<td class="sec">${shDate(rep.ts)}</td><td class="st-${rep.status}">${st}</td></tr>`; }).join('');
    box.innerHTML=`<div class="dsec">Recent reports · cached for everyone · TTL ${Math.round(d.ttlMs/60000)} min</div>`+
      `<table class="ai-rec"><tr><th>ticker</th><th>uni</th><th>read</th><th>ev</th><th>generated</th><th>state</th></tr>${rows}</table>`;
    box.querySelectorAll('[data-aicoin]').forEach(el2=>el2.addEventListener('click',()=>{ aiPick(el2.dataset.aicoin); }));
  }catch(_){}
}
export { aiFmtAgo, aiMatches, aiPick, loadAiRecent, loadAiReport, openAiReport, openReportView };
