// ematouch.js — the EMA Touch tab (build 2026.09.25-115). Two panes over /api/ema-feed, which the
// server rebuilds once a minute (poller.js emaScan):
//   on deck — every H4/D1 x EMA50/200 line within 1.5 sigma of the live mark, nearest first, the
//             distance in the rung's own bar sigma with the % beside it; the near band shaded.
//   feed    — one card per touch EPISODE: opened while the candle is still forming, resolved in
//             place at that candle's close (held / closed through), later touches folded into it as
//             retouches until a close clears the line and re-arms it. Near-band entries optional.
// Everything here is the server's payload restated — no EMA is recomputed in the browser, so the
// tab and the alert lanes (ma200 / ma50 / touch200 / touch50) can never disagree about a line.
// Follows the Stocks|Crypto switcher. Rows and cards open the drawer.
import { el, esc, fmtPrice, state, store } from "./core.js";
import { fetchJSON } from "./data.js";
import { openDetail } from "./drawer.js";

const EMT_KEY='xyzmon.emt.v1';
const EMT=Object.assign({ tf:'all', n:'all', near:'0' }, (()=>{ try{ return JSON.parse(store.get(EMT_KEY)||'{}')||{}; }catch(_){ return {}; } })());
function emtSave(){ try{ store.set(EMT_KEY, JSON.stringify({ tf:EMT.tf, n:EMT.n, near:EMT.near })); }catch(_){} }
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
  return `<div class="zone">${segHtml('tf','TF',[['all','both'],['H4','4H'],['D1','1D']])}${segHtml('n','EMA',[['all','both'],['50','50'],['200','200']])}${segHtml('near','Feed',[['0','touches'],['1','+ near']])}</div>`;
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

function cardHtml(c){
  if(c.k==='near') return `<div class="emt-ev near" data-coin="${esc(c.coin)}"><div class="l1"><span class="emt-pill near">near</span><span class="tk">${esc(c.t)}</span><span class="emt-chip">${tfLbl(c.tf)}</span><span class="emt-chip e${c.n}">EMA${c.n}</span><span class="ts" title="${esc(new Date(c.at).toISOString().slice(0,16).replace('T',' '))} UTC">${agoTxt(c.at)}</span></div>
    <div class="l2">entered the band ${c.from==='above'?'above':'below'} the line · ${Math.abs(c.gapSd).toFixed(2)}σ / ${Math.abs(c.gapPct).toFixed(2)}% away at ${fmtPrice(c.px)}</div></div>`;
  const live=c.st==='live', role=c.from==='above'?'support':'resistance';
  const verdict=c.st==='held'?(c.from==='above'?'closed back above: support held':'closed back below: resistance rejected')
    :c.st==='thru'?(c.from==='above'?'closed below the line: breakdown':'closed above the line: reclaim'):'';
  const pill=live?'<span class="emt-pill live">touched \u00b7 open</span>':c.st==='held'?'<span class="emt-pill held">held</span>':'<span class="emt-pill thru">closed through</span>';
  const lane=c.n===200?'ma200':'ma50';
  return `<div class="emt-ev ${live?'touch':c.st}" data-coin="${esc(c.coin)}"><div class="l1">${pill}<span class="tk">${esc(c.t)}</span><span class="emt-chip">${tfLbl(c.tf)}</span><span class="emt-chip e${c.n}">EMA${c.n}</span>${c.stacked?'<span class="emt-chip stack">stacked</span>':''}<span class="ts" title="${esc(new Date(c.at).toISOString().slice(0,16).replace('T',' '))} UTC">${agoTxt(c.at)}</span></div>
    <div class="l2">${live?`tagged the ${c.n} from ${c.from} (${role} test) at <b>${fmtPrice(c.px)}</b> · line ${fmtPrice(c.line)}`
      :`<b>${verdict}</b> · close ${fmtPrice(c.close)} vs ${fmtPrice(c.lineC)}`}</div>
    <div class="l3">${live?`<span>${tfLbl(c.tf)} candle closes in ${leftTxt(c.closeAt)}</span>`:`<span>touched ${agoTxt(c.at)} → resolved ${agoTxt(c.resAt)}</span>`}
      ${c.retouch?`<span class="faint" title="later touches of the same line before a close cleared it — one fight, not new signals">+${c.retouch} retouch${c.retouch>1?'es':''} folded</span>`:''}
      ${live?`<span class="faint" title="the close-confirmed ${lane} lane decides reclaim / breakdown / retest at the close">${lane} decides at the close</span>`:''}</div></div>`;
}

function renderEmaTouch(){
  const wrap=el('emt-wrap'); if(!wrap) return;
  const ctl=el('emt-ctrls'); if(ctl) ctl.innerHTML=controlsHtml();
  wireControls();
  const d=_emt;
  if(!d){ wrap.innerHTML=`<div class="msg">${_emtErr?'The EMA feed did not answer ('+esc(_emtErr)+') — retrying.':'Loading…'}</div>`; return; }
  const P=d.params||{};
  const near=(d.near||[]).filter(emtPass);
  const cards=(d.cards||[]).filter(c=>emtPass(c)&&(c.k==='touch'||EMT.near==='1')).slice(0,80);
  const touchesU=(d.cards||[]).filter(c=>c.k==='touch'&&c.uni===uniNow());
  const liveN=touchesU.filter(c=>c.st==='live').length;
  const day=(d.scanAt||Date.now())-86400e3, t24=touchesU.filter(c=>c.at>=day);
  const kpi=(k,v,s)=>`<div class="emt-kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const cr=state.scope==='crypto';
  wrap.innerHTML=`<div class="emt-title">EMA 50 / 200 touches · 4H and 1D</div>
    <div class="emt-sub">Which ${cr?'coins':'names'} are touching their 50 or 200 EMA right now, and which are about to. Distance is in each rung’s own bar sigma (the % beside it), so “close” means the same on every name. ${d.primed?'':'<b class="warn">Priming:</b> the first ~6 minutes after a deploy seed every line silently, so nothing already standing is announced as new. '}${d.scanAt?`Scanned ${agoTxt(d.scanAt)}.`:'Waiting for the first scan.'}</div>
    <div class="emt-kpis">${kpi('live touches',liveN,'candle still open')}${kpi('touches · 24h',t24.length,`${t24.filter(c=>c.st==='held').length} held · ${t24.filter(c=>c.st==='thru').length} through`)}${kpi('folded · 24h',t24.reduce((a,c)=>a+(c.retouch||0),0),'retouches, no new card')}${kpi('lines on deck',near.length,`${near.filter(r=>r.inBand||r.touching).length} inside ${P.nearSd||0.5}σ`)}</div>
    <div class="emt-grid">
      <div class="emt-card"><div class="emt-h">Near a line <span>${near.length} line${near.length===1?'':'s'} within ${P.listSd||1.5}σ</span></div><div class="emt-deck">${deckHtml(near.slice(0,40),P)}</div>
        <p class="emt-cap">Gauge: the mark's distance to the line, the shaded part is the near band (${P.nearSd||0.5}σ). <span class="pos">▼</span> = the gap is closing. The line is the EMA over closed candles carried to the live mark: what a chart draws while the candle forms. ${cr?'Crypto reads calendar days.':'1D is the session series: weekends and holidays fold into the next session.'}</p></div>
      <div class="emt-card"><div class="emt-h">Feed <span>${cards.length} card${cards.length===1?'':'s'} · last ${P.ttlH||48}h</span></div><div class="emt-feed">${cards.length?cards.map(cardHtml).join(''):'<div class="emt-empty">No touches in the window under this filter.</div>'}</div>
        <p class="emt-cap">One card per touch episode, resolved at the candle's close. Until a close lands at least ${P.rearmSd||1}σ clear of the line, later touches fold into the open card (once per candle). Phone alerts, operator-only while this tab soaks: <b>ma200</b> / <b>ma50</b> (reclaim, breakdown, retests, close-confirmed) and <b>touch200</b> / <b>touch50</b> (intrabar, opt-in), each chosen separately in the bell's delivery panel.</p></div>
    </div>`;
  wrap.querySelectorAll('[data-coin]').forEach(n=>n.addEventListener('click',()=>{ const c=n.dataset.coin; if(state.rows.has(c)) openDetail(c); }));
}
function wireControls(){
  document.querySelectorAll('#emt-ctrls [data-emt]').forEach(b=>b.onclick=()=>{ EMT[b.dataset.emt]=b.dataset.v; emtSave(); renderEmaTouch(); });
}
function openEmaTouch(){ renderEmaTouch(); if(!_emt||Date.now()-_emtLast>EMT_POLL) loadEmaTouch(); }

export { EMT, emtPass, loadEmaTouch, openEmaTouch, pollEmaTouch, renderEmaTouch };
