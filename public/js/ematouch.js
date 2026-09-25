// ematouch.js — the EMA Touch tab (build 2026.09.25-115). Two panes over /api/ema-feed, which the
// server rebuilds once a minute (poller.js emaScan):
//   on deck — every H4/D1 x EMA50/200 line within 1.5 sigma of the live mark, nearest first, the
//             distance in the rung's own bar sigma with the % beside it; the near band shaded.
//   feed    — one card per touch EPISODE: opened while the candle is still forming, resolved in
//             place at that candle's close (held / closed through), later touches folded into it as
//             retouches until a close clears the line and re-arms it. (-118) Each card then decays on
//             its own clock — candles of its timeframe: FRESH for the first few, FADING after (or at
//             once when a later close fails it), gone past the keep window — carries its follow-
//             through (worked at 1 sigma, failed on a close back through the line) and one plain
//             action line saying what it means and what would invalidate it. Sorted by relevance.
// Everything here is the server's payload restated — no EMA is recomputed in the browser, so the
// tab and the alert lanes (ma200 / ma50 / touch200 / touch50) can never disagree about a line.
// Follows the Stocks|Crypto switcher. Rows and cards open the drawer.
import { el, esc, fmtPrice, state, store } from "./core.js";
import { fetchJSON } from "./data.js";
import { openDetail } from "./drawer.js";

const EMT_KEY='xyzmon.emt.v1';
const EMT=Object.assign({ tf:'all', n:'all', sort:'rel', show:'all' }, (()=>{ try{ return JSON.parse(store.get(EMT_KEY)||'{}')||{}; }catch(_){ return {}; } })());
function emtSave(){ try{ store.set(EMT_KEY, JSON.stringify({ tf:EMT.tf, n:EMT.n, sort:EMT.sort, show:EMT.show })); }catch(_){} }
let _emt=null, _emtLast=0, _emtErr=null, _emtLoading=false;
const EMT_POLL=30*1000;   // the server scans every minute; half that keeps a fresh scan at most ~30s late

async function loadEmaTouch(){
  if(_emtLoading) return; _emtLoading=true;
  try{ const d=await fetchJSON('/api/ema-feed'); if(d&&Array.isArray(d.near)){ _emt=d; _emtErr=null; } }
  catch(e){ _emtErr=(e&&e.message)||'unavailable'; }
  finally{ _emtLoading=false; _emtLast=Date.now(); }
  if(state.view==='ematouch') renderEmaTouch();
}
// Called off the snapshot cadence (data.js): pulls only while the tab is open.
function pollEmaTouch(){ const v=el('view-ematouch'); if(v&&!v.hidden&&Date.now()-_emtLast>EMT_POLL) loadEmaTouch(); }

const uniNow=()=>state.scope==='crypto'?'crypto':'stocks';
function emtPass(x){ return x.uni===uniNow() && (EMT.tf==='all'||x.tf===EMT.tf) && (EMT.n==='all'||String(x.n)===EMT.n); }
const tfLbl=(tf)=>tf==='H4'?'4H':'1D';
function leftTxt(closeAt){ if(!closeAt) return ''; const m=Math.max(0,Math.round((closeAt-Date.now())/60000));
  return m>=60?Math.floor(m/60)+'h '+String(m%60).padStart(2,'0')+'m':m+'m'; }
function agoTxt(t){ const m=Math.max(0,Math.round((Date.now()-t)/60000));
  return m<1?'now':m<60?m+'m ago':m<1440?Math.floor(m/60)+'h ago':Math.floor(m/1440)+'d ago'; }

function segHtml(k,label,opts){
  return `<div class="seg" role="group" aria-label="${esc(label)}"><span class="seglbl">${esc(label)}</span>`
    +opts.map(([v,t])=>`<button type="button" data-emt="${k}" data-v="${v}" class="${EMT[k]===v?'active':''}">${esc(t)}</button>`).join('')+'</div>';
}
function controlsHtml(){
  return `<div class="zone">${segHtml('tf','TF',[['all','both'],['H4','4H'],['D1','1D']])}${segHtml('n','EMA',[['all','both'],['50','50'],['200','200']])}${segHtml('sort','Sort',[['rel','most relevant'],['new','newest']])}${segHtml('show','Show',[['all','all'],['fresh','live + fresh']])}</div>`;
}

function deckHtml(rows,P){
  if(!rows.length) return '<div class="emt-empty">No line within '+(P.listSd||1.5)+'σ of the mark under this filter.</div>';
  const band=P.nearSd||0.5, span=P.listSd||1.5;
  return rows.map(r=>{
    const pos=Math.min(1,Math.abs(r.gapSd)/span)*100, zoneW=band/span*100;
    const tag=r.touching?'<span class="emt-pill live" title="this candle\u2019s range has reached the line">touched</span>':r.inBand?'<span class="emt-pill near">in band</span>':'';
    return `<div class="emt-dk${r.touching?' tch':r.inBand?' in':''}" data-coin="${esc(r.coin)}" title="${esc(r.t)} ${tfLbl(r.tf)} EMA${r.n} at ${fmtPrice(r.line)} — mark ${fmtPrice(r.px)}, ${Math.abs(r.gapSd).toFixed(2)}σ (${Math.abs(r.gapPct).toFixed(2)}%) ${r.gapPct>=0?'above':'below'} it; 1σ on this rung = ${r.sd}% per bar · candle closes in ${leftTxt(r.closeAt)}">
      <div class="emt-tk">${esc(r.t)}<small>${fmtPrice(r.px)}</small></div>
      <div class="emt-mid"><div class="emt-chips"><span class="emt-chip">${tfLbl(r.tf)}</span><span class="emt-chip e${r.n}">EMA${r.n}</span><span class="emt-chip" title="the side the last close sat on \u2014 above: a support test, below: a resistance test">${r.from==='above'?'from above':'from below'}</span>${r.stacked?'<span class="emt-chip stack" title="the 50 and the 200 sit within half a sigma of each other on this rung — a touch tests both">stacked</span>':''}${tag}</div>
        <div class="emt-gauge"><span class="zone" style="width:${zoneW}%"></span><span class="pt${r.inBand||r.touching?' in':''}" style="left:${Math.max(2,pos)}%"></span></div></div>
      <div class="emt-num"><b>${Math.abs(r.gapSd).toFixed(2)}σ</b><br>${Math.abs(r.gapPct).toFixed(2)}% ${r.closing?'<span class="pos" title="the gap shrank over the last few scans">▼</span>':'<span class="faint">·</span>'}</div>
    </div>`;
  }).join('');
}

// ---- the card (-118) ----------------------------------------------------------------------------
// What happened, in words (the pill); what it means and what kills it (the action line); how old it
// is on its own clock and how much life it has left (the stage); and what price did since.
function emtUnit(c){ return c.tf==='H4'?'bar':(c.uni==='stocks'?'session':'day'); }
function emtPlural(n,w){ return n+' '+w+(n===1?'':'s'); }
function emtCardTitle(c){
  if(c.st==='live') return c.from==='above'?'Testing support':'Testing resistance';
  if(c.st==='held') return c.from==='above'?'Support held':'Resistance held';
  return c.from==='above'?'Broke down':'Reclaimed';
}
function emtTone(c){ if(c.st==='live') return 'live'; if(c.failed) return 'bad'; return emtBull(c)?'bull':'bear'; }
function emtBull(c){ return (c.st==='held')===(c.from==='above'); }   // held support / reclaim = bullish; rejection / breakdown = bearish
function emtCardAction(c){
  const L=fmtPrice(c.st==='live'?c.line:c.lineC);
  if(c.st==='live') return c.from==='above'
    ? `Watch the ${tfLbl(c.tf)} close: above ${L} = support held, below = breakdown.`
    : `Watch the ${tfLbl(c.tf)} close: below ${L} = rejected, above = reclaim.`;
  if(c.failed) return `Failed — a later close went back through ${L}. No longer a setup.`;
  if(c.st==='held') return c.from==='above'
    ? `Bullish while above ${L}. A ${tfLbl(c.tf)} close below it invalidates.`
    : `Bearish while below ${L}. A ${tfLbl(c.tf)} close above it invalidates.`;
  return c.from==='above'
    ? `Bearish: ${L} is now resistance. A ${tfLbl(c.tf)} close back above invalidates.`
    : `Bullish: ${L} is now support. A ${tfLbl(c.tf)} close back below invalidates.`;
}
function emtStageHtml(c,P){
  const u=emtUnit(c), age=Number.isFinite(c.age)?c.age:0;
  if(c.st==='live') return `<span class="emt-stage live" title="the touch candle is still forming">live · closes in ${leftTxt(c.closeAt)}</span>`;
  const fresh=(P.freshBars||{})[c.tf]||3, keep=(P.keepBars||{})[c.tf]||6;
  const since=age===0?'last '+u:emtPlural(age,u)+' ago';
  if(c.stage==='fresh') return `<span class="emt-stage fresh" title="fresh for ${emtPlural(fresh,u)} after the touch, then fading until ${emtPlural(keep,u)}">fresh · ${since}</span>`;
  const left=Math.max(0,keep-age);
  return `<span class="emt-stage fading" title="${c.failed?'failed: fading out early':'past its fresh window'} — leaves the feed after ${emtPlural(keep,u)}">fading · ${since}${left?'':' · last '+u}</span>`;
}
function emtOutcomeHtml(c,P){
  if(c.st==='live') return '';
  if(c.failed) return '<span class="emt-out bad" title="a later close went back through the line">✕ failed</span>';
  if(c.worked) return `<span class="emt-out ok" title="price went at least ${P.workedSd||1}σ from the line in the expected direction">✓ worked</span>`;
  return '<span class="emt-out wait" title="has not yet moved 1σ in the expected direction">pending</span>';
}
function emtCardHtml(c,P){
  const tone=emtTone(c), faded=c.st!=='live'&&c.stage!=='fresh';
  const ft=Number.isFinite(c.ft)?`<span title="how far price is from the line in the expected direction, in this rung’s σ (best since in brackets)">since: <b class="${c.ft>=0?'pos':'neg'}">${c.ft>=0?'+':''}${c.ft.toFixed(1)}σ</b>${Number.isFinite(c.ftMax)&&c.ftMax>c.ft+0.05?` (best ${c.ftMax>=0?'+':''}${c.ftMax.toFixed(1)}σ)`:''}</span>`:'';
  return `<div class="emt-ev ${tone}${faded?' fading':''}" data-coin="${esc(c.coin)}"><div class="l1">
      <span class="emt-pill ${tone}">${emtCardTitle(c)}</span><span class="tk">${esc(c.t)}</span><span class="emt-chip">${tfLbl(c.tf)}</span><span class="emt-chip e${c.n}">EMA${c.n}</span>${c.stacked?'<span class="emt-chip stack" title="the 50 and the 200 sit on the same level — one touch tests both">stacked</span>':''}${emtOutcomeHtml(c,P)}
      ${emtStageHtml(c,P)}</div>
    <div class="emt-act">${emtCardAction(c)}</div>
    <div class="l3"><span title="${esc(new Date(c.at).toISOString().slice(0,16).replace('T',' '))} UTC">touched ${fmtPrice(c.px)}${c.st!=='live'?` · closed ${fmtPrice(c.close)} vs line ${fmtPrice(c.lineC)}`:''}</span>${ft}
      ${c.retouch?`<span title="later touches of the same line before a close cleared it — one fight, not new signals">+${c.retouch} retouch${c.retouch>1?'es':''}</span>`:''}</div></div>`;
}
// Most relevant first: live touches (soonest close first), then fresh (1D before 4H, the 200 before
// the 50, stacked first, newest first), then fading; a failed card last.
function emtRelRank(c){ return c.st==='live'?0:c.failed?3:c.stage==='fresh'?1:2; }
function emtRelSort(a,b){
  const ra=emtRelRank(a), rb=emtRelRank(b); if(ra!==rb) return ra-rb;
  if(ra===0) return (a.closeAt||0)-(b.closeAt||0);
  const w=(c)=>(c.tf==='D1'?4:0)+(c.n===200?2:0)+(c.stacked?1:0);
  return (w(b)-w(a))||((b.at||0)-(a.at||0));
}

function renderEmaTouch(){
  const wrap=el('emt-wrap'); if(!wrap) return;
  const ctl=el('emt-ctrls'); if(ctl) ctl.innerHTML=controlsHtml();
  wireControls();
  const d=_emt;
  if(!d){ wrap.innerHTML=`<div class="msg">${_emtErr?'The EMA feed did not answer ('+esc(_emtErr)+') — retrying.':'Loading…'}</div>`; return; }
  const P=d.params||{};
  const near=(d.near||[]).filter(emtPass);
  let cards=(d.cards||[]).filter(c=>c.k==='touch'&&emtPass(c));
  if(EMT.show==='fresh') cards=cards.filter(c=>c.st==='live'||(c.stage==='fresh'&&!c.failed));
  cards=cards.slice().sort(EMT.sort==='new'?((a,b)=>(b.at||0)-(a.at||0)):emtRelSort).slice(0,80);
  const touchesU=(d.cards||[]).filter(c=>c.k==='touch'&&c.uni===uniNow());
  const liveN=touchesU.filter(c=>c.st==='live').length;
  const freshN=touchesU.filter(c=>c.stage==='fresh'&&!c.failed).length;
  const kpi=(k,v,s)=>`<div class="emt-kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const cr=state.scope==='crypto';
  wrap.innerHTML=`<div class="emt-title">EMA 50 / 200 touches · 4H and 1D</div>
    <div class="emt-sub">Which ${cr?'coins':'names'} are touching their 50 or 200 EMA right now, and which are about to. Distance is in each rung’s own bar sigma (the % beside it), so “close” means the same on every name. ${d.primed?'':'<b class="warn">Priming:</b> the first ~6 minutes after a deploy seed every line silently, so nothing already standing is announced as new. '}${d.scanAt?`Scanned ${agoTxt(d.scanAt)}.`:'Waiting for the first scan.'}</div>
    <div class="emt-kpis">${kpi('touching now',liveN,'candle still open')}${kpi('fresh setups',freshN,'just resolved, still actionable')}${kpi('worked',touchesU.filter(c=>c.worked&&!c.failed).length,`moved ≥ ${P.workedSd||1}σ the right way`)}${kpi('failed',touchesU.filter(c=>c.failed).length,'a later close went back through')}${kpi('near a line',near.length,`${near.filter(r=>r.inBand||r.touching).length} inside ${P.nearSd||0.5}σ`)}</div>
    <div class="emt-grid">
      <div class="emt-card"><div class="emt-h">Near a line <span>${near.length} line${near.length===1?'':'s'} within ${P.listSd||1.5}σ</span></div><div class="emt-deck">${deckHtml(near.slice(0,40),P)}</div>
        <p class="emt-cap">Gauge: the mark's distance to the line, the shaded part is the near band (${P.nearSd||0.5}σ). <span class="pos">▼</span> = the gap is closing. The line is the EMA over closed candles carried to the live mark: what a chart draws while the candle forms. ${cr?'Crypto reads calendar days.':'1D is the session series: weekends and holidays fold into the next session.'}</p></div>
      <div class="emt-card"><div class="emt-h">Touches <span>${cards.length} card${cards.length===1?'':'s'} · ${EMT.sort==='new'?'newest first':'most relevant first'}</span></div><div class="emt-feed">${cards.length?cards.map(c=>emtCardHtml(c,P)).join(''):'<div class="emt-empty">No touches under this filter right now.</div>'}</div>
        <div class="emt-legend"><span><b class="emt-stage live">live</b> the candle that touched is still open</span><span><b class="emt-stage fresh">fresh</b> resolved within the last ${((P.freshBars||{}).H4)||3} bars (4H) / ${((P.freshBars||{}).D1)||2} sessions (1D): actionable</span><span><b class="emt-stage fading">fading</b> older, or failed: context, not a setup; leaves after ${((P.keepBars||{}).H4)||6} bars / ${((P.keepBars||{}).D1)||5} sessions</span><span><b class="emt-out ok">✓ worked</b> moved ≥ ${P.workedSd||1}σ the expected way</span><span><b class="emt-out bad">✕ failed</b> a later close went back through the line</span></div>
        <p class="emt-cap">One card per touch, resolved at the candle's close. Until a close lands at least ${P.rearmSd||1}σ clear of the line, later touches fold into the same card. Phone alerts, operator-only while this tab soaks: <b>ma200</b> / <b>ma50</b> (reclaim, breakdown, retests, close-confirmed) and <b>touch200</b> / <b>touch50</b> (intrabar, opt-in), each chosen separately in the bell's delivery panel.</p></div>
    </div>`;
  wrap.querySelectorAll('[data-coin]').forEach(n=>n.addEventListener('click',()=>{ const c=n.dataset.coin; if(state.rows.has(c)) openDetail(c); }));
}
function wireControls(){
  document.querySelectorAll('#emt-ctrls [data-emt]').forEach(b=>b.onclick=()=>{ EMT[b.dataset.emt]=b.dataset.v; emtSave(); renderEmaTouch(); });
}
function openEmaTouch(){ renderEmaTouch(); if(!_emt||Date.now()-_emtLast>EMT_POLL) loadEmaTouch(); }

export { EMT, emtCardAction, emtCardTitle, emtPass, emtRelSort, loadEmaTouch, openEmaTouch, pollEmaTouch, renderEmaTouch };
