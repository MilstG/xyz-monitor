// drawer.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { attachLineHover, hoverChart, lcTicks } from "./admin.js";
import { setHash } from "./alerts.js";
import { showView } from "./backtest.js";
import { nowChip } from "./base.js";
import { loadNews } from "./calendar.js";
import { DAY, G, activeRows, el, esc, fmtFunding, fmtPct, fmtPrice, fmtUsd, inScope, momColor, regimeReadout, state } from "./core.js";
import { corrColor, dailyReturns, pearson, sparkline } from "./corr.js";
import { fetchJSON } from "./data.js";
import { render, sessDrawerHtml, sessEx } from "./markets.js";
import { openRuleFor, updateFocusChip } from "./nav.js";
import { earnDrawerHtml, loadNotes, noteDrawerHtml, renderDrawerNotes, wireDrawerNotes } from "./notes.js";
import { renderDrawerPos, savePrefs } from "./prefs.js";
import { aiPick, openAiReport } from "./report.js";
import { EV_LABELS, fillDrawerNews, fmtAge } from "./trend.js";


// ===== per-ticker detail drawer =====
function comoversFor(coin, L){ const me=state.rows.get(coin); if(!me||!me.daily) return null;
  const mr=dailyReturns(me); if(!mr) return null; const cutoff=Math.floor(Date.now()/DAY)-L, res=[];
  for(const r of activeRows()){ if(r.coin===coin||!r.daily) continue; const or=dailyReturns(r); if(!or) continue;
    const a=[],b=[]; for(const [d,v] of mr){ if(d<cutoff)continue; const w=or.get(d); if(w!==undefined){a.push(v);b.push(w);} }
    if(a.length<20) continue; const c=pearson(a,b); if(c!=null&&isFinite(c)) res.push([r.ticker,c]); }
  res.sort((x,y)=>y[1]-x[1]); return res; }
function openDetail(coin){ const r=state.rows.get(coin); if(!r) return; state.detail=coin;
  state.focus=coin; updateFocusChip();   // focus survives the drawer closing — it follows you across tabs
  const co=comoversFor(coin,90), pos=co?co.slice(0,6):[], neg=co?co.slice(-6).reverse().filter(x=>x[1]<0):[];
  const closes=r.daily?r.daily.slice(-90).map(k=>parseFloat(k.c)).filter(isFinite):[];
  const fu=fmtFunding(r.funding), pct=v=>{const p=fmtPct(v);return `<span class="${p.c}">${p.t}</span>`;};
  const st=(k,v)=>`<div class="dstat"><span class="dk">${k}</span><span class="dv">${v}</span></div>`;
  const betaTxt=(r.beta!=null&&isFinite(r.beta))?r.beta.toFixed(2):'·';
  const momTxt=(r.mom==null)?'·':`<span style="color:${momColor(r.mom)}">${r.mom>0?'+':''}${Math.round(r.mom)}</span>`;
  const bar=v=>`<span class="cbar" style="width:${Math.round(Math.abs(v)*64)}px;background:${corrColor(v)}"></span>`;
  const li=(t,v)=>`<div class="crow"><span class="ct">${esc(t)}</span>${bar(v)}<span class="cv ${v>=0?'pos':'neg'}">${v>=0?'+':''}${v.toFixed(2)}</span></div>`;
  const starred=state.watch.has(coin);
  const split=r.uni==='main'?null:sessionSplit30(r);   // no cash session exists to decompose against
  const sessLbl=r.hm?`the ${sessEx(r.hm)} home session`:'09:30\u201316:00 ET';   // the overnight holds under `split` are already home-anchored server-side
  const splitHtml = split
    ? `<div class="dsec" data-tip="30d off-hours split \u00b7 return decomposed into what accrued off-hours (overnight + weekend close\u2192open) vs during cash sessions \u00b7 a persistent off-hours drift is the overnight-effect edge this panel exists to expose">Where the 30d return happened</div>`+
      `<div class="dsplit">`+
        `<span data-tip="total 30d price return">total <b class="${split.total>=0?'pos':'neg'}">${split.total>=0?'+':''}${split.total.toFixed(1)}%</b></span>`+
        `<span data-tip="compounded across ${split.n} close\u2192open holds (overnight + weekend)">off-hours <b class="${split.off>=0?'pos':'neg'}">${split.off>=0?'+':''}${split.off.toFixed(1)}%</b></span>`+
        `<span data-tip="the residual: what accrued during ${esc(sessLbl)}">session <b class="${split.sess>=0?'pos':'neg'}">${split.sess>=0?'+':''}${split.sess.toFixed(1)}%</b></span>`+
        (Math.abs(split.off)>Math.abs(split.total)*0.7&&Math.abs(split.total)>2?`<span class="sec" style="font-size:10.5px" data-tip="\u226570% of the 30d move accrued while the cash market was closed">\u26a1 overnight-driven</span>`:'')+
      `</div>`
    : '';
  el('drawer').innerHTML=`
    <div class="dhead">${esc(r.ticker)}
      <span class="star${starred?' on':''}" id="dstar" role="button" tabindex="0" style="font-size:16px;cursor:pointer" title="${starred?'remove from watchlist':'add to watchlist'}">${starred?'★':'☆'}</span>
      <button class="dclose" id="dclose" title="close">✕</button></div>
    ${r.nm?`<div class="dname" data-tip="the instrument behind the ticker — static server-side map; a name that isn\u2019t seeded shows no line rather than a guess">${esc(r.nm)}</div>`:''}
    <div class="dsub">${esc(r.coin)} · ${fmtPrice(r.px)}${r.coin===state.benchCoin?' · S&amp;P benchmark':''}${r.coin===state.benchMain?' · BTC — crypto benchmark':''}${r.uni==='main'?' · 24/7 · 90d dailies':''} · <span id="dai" style="color:var(--blue);cursor:pointer;text-decoration:underline;text-underline-offset:2px" data-tip="jump to the Report tab — everything this server holds on this name, synthesized into a plain-language read with scenarios and R/R">AI report →</span></div>
    <div class="dact"><button class="btn" id="drep" title="compile everything the server holds on this name into one analyst read">AI report \u2192</button><button class="btn" id="dalert" title="arm a price alert at a level of your choosing — opens the rule form pre-filled with this name and its mark">\u2691 alert</button></div>
    <div class="dsec">Metrics</div>
    <div class="dgrid">
      ${st('Funding (APR)',`<span class="${fu.c}">${fu.t}</span>`)}
      ${st('Momentum',momTxt)} ${st('MOM+', (r.momp!=null&&isFinite(r.momp))?`<span class="${r.momp>0?'pos':(r.momp<0?'neg':'sec')}">${r.momp>0?'+':''}${Math.round(r.momp)}</span>`:'·')}
      ${st('1h',pct(r.h1))} ${st('4h',pct(r.h4))}
      ${st('1d',pct(r.d1))} ${st('7d',pct(r.d7))}
      ${st('30d',pct(r.d30))} ${st('vs S&amp;P ('+state.tf+')', r.rs==null?'<span class="na">—</span>':pct(r.rs))}
      ${st('β vs S&amp;P',betaTxt)} ${st('Vol (ann)', r.vol30!=null?r.vol30.toFixed(0)+'%':'·')}
      ${st('Premium', (r.prem!=null&&isFinite(r.prem))?`<span class="${r.prem>0.5?'pos':(r.prem<-0.5?'neg':'sec')}">${r.prem>=0?'+':''}${r.prem.toFixed(1)}bp</span>`:'·')}
      ${st('Gap', (r.gap!=null&&isFinite(r.gap))?`<span class="${r.gap>=0?'pos':'neg'}">${r.gap>=0?'+':''}${r.gap.toFixed(2)}%</span>`:'·')}
      ${st('Squeeze', r.sqz!==undefined?`<span style="color:${r.sqz>=60?'var(--accent)':(r.sqz>=30?'var(--text)':'var(--faint)')}">${r.sqz}</span>`:'·')}
      ${st('Carry', (r.carry!=null&&isFinite(r.carry))?`<span class="${r.carry>0.05?'pos':(r.carry<-0.05?'neg':'sec')}">${r.carry>=0?'+':''}${r.carry.toFixed(2)}</span>`:'·')}
      ${st('vs 30d high', r.dd!=null?`<span class="${r.dd>=-0.5?'pos':'sec'}">${r.dd.toFixed(1)}%</span>`:'·')}
      ${st('ΔOI ('+state.tf+')', r.doi!=null?`<span class="${r.doi>=0?'pos':'neg'}">${r.doi>=0?'+':''}${r.doi.toFixed(2)}%</span>`:'<span class="na">—</span>')}
      ${st('24h Vol',fmtUsd(r.vol))} ${st('Open Interest',fmtUsd(r.oi))}
    </div>
    <div id="dpos"></div>
    ${sessDrawerHtml(r)}
    ${earnDrawerHtml(r)}
    ${noteDrawerHtml(r)}
    ${closes.length>2?`<div class="dsec">90-day price</div>${sparkline(closes,{color: closes[closes.length-1]>=closes[0]?'var(--up)':'var(--down)'})}`:''}
    <div id="dcandles"></div>
    ${splitHtml}
    <div id="dseries"></div>
    ${r.uni==='main'?'<div id="dderivs"></div>':''}
    ${r.uni==='xyz'?'<div id="dfund"></div>':''}
    <div id="dledger"></div>
    <div id="dnews"></div>
    ${r.regime?`<div class="sec" style="font-size:11.5px;margin:2px 0 12px;line-height:1.55">${regimeReadout(r)}</div>`:''}
    <div class="dsec">Top co-movers (90d)</div>${pos.length?pos.map(x=>li(x[0],x[1])).join(''):'<div class="sec" style="font-size:12px">daily history still loading…</div>'}
    <div class="dsec">Top hedges — inverse (90d)</div>${neg.length?neg.map(x=>li(x[0],x[1])).join(''):'<div class="sec" style="font-size:12px">no negative correlations</div>'}`;
  el('drawer').classList.add('show'); el('drawerbg').classList.add('show'); el('drawer').setAttribute('aria-hidden','false');
  if(!state._drawerFrom) state._drawerFrom=document.activeElement;   // return focus here on close
  el('dclose').onclick=closeDetail;
  try{ el('dclose').focus({preventScroll:true}); }catch(_){}
  { const b=el('drep'); if(b) b.onclick=()=>{ showView('report'); aiPick(coin); };
    const a=el('dalert'); if(a) a.onclick=()=>openRuleFor(r); }
  el('dstar').onclick=()=>{ toggleWatch(coin);   // renders the table; the drawer (and a half-typed note) stays put
    const on=state.watch.has(coin), st=el('dstar'); if(st){ st.textContent=on?'\u2605':'\u2606'; st.classList.toggle('on',on); } };
  wireDrawerNotes(coin);
  if(!state.notes) loadNotes().then(()=>{ if(state.detail===coin) renderDrawerNotes(coin); });
  setHash('t='+encodeURIComponent(coin));
  loadDrawerSeries(coin);
  loadDrawerCandles(coin);
  loadDrawerLedger(coin);
  if(r.uni==='main') loadDrawerDerivs(coin);
  if(r.uni==='xyz') loadDrawerFund(coin);
  renderDrawerPos(coin);
  fillDrawerNews(); if(!state.news) loadNews();   // slice from the shared payload; first open triggers the fetch
  { const dai=el('dai'); if(dai){ dai.onclick=()=>{ closeDetail(); openAiReport(coin); };
    // state-aware label: annotate with the shared cache's age so the group knows a read exists
    fetchJSON('/api/ai-report?coin='+encodeURIComponent(coin)).then(d=>{
      if(state.detail!==coin||!dai.isConnected||!d||d.status==='none') return;
      const age=d.ageMs!=null?(d.ageMs>=3600000?(d.ageMs/3600000).toFixed(0)+'h':(Math.max(1,Math.round(d.ageMs/60000)))+'m'):null;
      dai.textContent='AI report'+(d.status==='fresh'&&age?` (cached ${age} ago)`:d.status==='invalidated'?' (outdated)':' (stale)')+' \u2192';
    }).catch(()=>{}); } }
}
// 30d overnight-effect decomposition for one name: total return vs the compounded off-hours
// (close→open) leg, session = the residual. Built entirely from data already shipped to the
// client (daily closes + the overnight hold series), so it costs nothing server-side.
function sessionSplit30(r){
  if(!r.daily||!r.overnight||r.daily.length<5||!r.overnight.length) return null;
  const cut=Date.now()-30*DAY;
  let first=null,last=null;
  for(const k of r.daily){ const c=parseFloat(k.c); if(!isFinite(c))continue; if(k.t>=cut&&first==null)first=c; last=c; }
  if(!(first>0)||last==null) return null;
  const total=last/first-1;
  let eq=1,n=0;
  for(const h of r.overnight){ if(h.t>=cut&&isFinite(h.g)){ eq*=(1+h.g); n++; } }
  if(n<3) return null;
  const off=eq-1, sess=(1+total)/(1+off)-1;
  return {total:total*100, off:off*100, sess:sess*100, n};
}
// Hourly candlestick chart for the drawer, fed by /api/candles. Crosshair + OHLC readout via
// the shared hoverChart infrastructure (same one the Sessions curves use).
function candleSvg(cd){
  const W=420,H=176, pl=4,pr=52,pt=10,pb=20;
  if(!cd||cd.length<5) return '';
  let lo=Infinity,hi=-Infinity;
  for(const k of cd){ if(isFinite(k[3])&&k[3]<lo)lo=k[3]; if(isFinite(k[2])&&k[2]>hi)hi=k[2]; }
  if(!(hi>lo)) return '';
  const pad=(hi-lo)*0.06; hi+=pad; lo-=pad;
  const n=cd.length, X=i=>pl+(i+0.5)/n*(W-pl-pr), Y=v=>pt+(1-(v-lo)/(hi-lo))*(H-pt-pb);
  const bw=Math.max(1,Math.min(6,(W-pl-pr)/n*0.72));
  const axf=v=>{ const a=Math.abs(v);
    if(a>=1e6) return (v/1e6).toFixed(2)+'M';
    if(a>=1e4) return (v/1e3).toFixed(1)+'k';
    return fmtPrice(v); };
  let s='';
  for(const v of lcTicks(lo,hi,4)){ const y=Y(v).toFixed(1);
    s+=`<line x1="${pl}" y1="${y}" x2="${W-pr}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`+
       `<text x="${W-pr+5}" y="${(+y+3).toFixed(1)}" class="lc-tick">${axf(v)}</text>`; }
  for(let i=0;i<n;i++){ const k=cd[i], o=k[1],h=k[2],l=k[3],c=k[4];
    if(!isFinite(o)||!isFinite(c)) continue;
    const up=c>=o, col=up?'var(--up)':'var(--down)', x=X(i);
    if(isFinite(h)&&isFinite(l)) s+=`<line x1="${x.toFixed(1)}" y1="${Y(h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${Y(l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    const y0=Y(Math.max(o,c)), hgt=Math.max(1,Math.abs(Y(o)-Y(c)));
    s+=`<rect x="${(x-bw/2).toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}"${up?' fill-opacity="0.85"':''}/>`; }
  const dfmt=t=>{ const d=new Date(t); return (d.getMonth()+1)+'/'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':00'; };
  s+=`<text x="${pl}" y="${H-6}" class="lc-tick">${dfmt(cd[0][0])}</text>`;
  s+=`<text x="${(W-pr)}" y="${H-6}" text-anchor="end" class="lc-tick">${dfmt(cd[n-1][0])}</text>`;
  const xs=cd.map((_,i)=>X(i));
  const rows=cd.map(k=>{ const chg=(isFinite(k[1])&&k[1]>0&&isFinite(k[4]))?(k[4]/k[1]-1)*100:null;
    return `<b style="color:var(--text)">${dfmt(k[0])}</b><br>O ${fmtPrice(k[1])} · H ${fmtPrice(k[2])}<br>L ${fmtPrice(k[3])} · C ${fmtPrice(k[4])}`+
      (chg!=null?`<br><span class="${chg>=0?'pos':'neg'}" style="color:${chg>=0?'var(--up)':'var(--down)'}">${chg>=0?'+':''}${chg.toFixed(2)}%</span>`:''); });
  return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});
}
async function loadDrawerCandles(coin){
  const box=el('dcandles'); if(!box) return;
  const days=state.candTf||7;
  try{
    const res=await fetchJSON('/api/candles?coin='+encodeURIComponent(coin)+'&days='+days);
    if(state.detail!==coin || !box.isConnected) return;
    const cd=(res&&Array.isArray(res.candles))?res.candles:[];
    if(cd.length<5){ box.innerHTML=''; return; }   // server not updated yet, or spine still filling — the drawer just omits the chart
    const seg=[3,7,14,30,90].map(d=>`<button type="button" class="cdtf${d===days?' on':''}" data-d="${d}">${d}d</button>`).join('');
    box.innerHTML=`<div class="dsec" style="display:flex;align-items:center;gap:8px">Hourly candles <span class="cdtf-seg" style="margin-left:auto">${seg}</span></div>`+candleSvg(cd);
    box.querySelectorAll('.cdtf').forEach(b=>b.addEventListener('click',()=>{ state.candTf=+b.dataset.d; loadDrawerCandles(coin); }));
    attachLineHover();
  }catch(_){ }
}
async function loadDrawerSeries(coin){
  const box=el('dseries'); if(!box) return;
  try{
    const s=await fetchJSON('/api/series?coin='+encodeURIComponent(coin));
    if(state.detail!==coin || !box.isConnected) return;
    const span=arr=>{ if(!arr||arr.length<2)return ''; const ms=arr[arr.length-1][0]-arr[0][0], d=ms/86400000; return d>=1?('· last '+d.toFixed(0)+'d'):('· last '+(ms/3600000).toFixed(0)+'h'); };
    let html='';
    if(s.oi && s.oi.length>2){ const v=s.oi.map(p=>p[1]), up=v[v.length-1]>=v[0];
      html+=`<div class="dsec">Open interest ${span(s.oi)}</div>${sparkline(v,{color:up?'var(--up)':'var(--down)'})}`; }
    if(s.funding && s.funding.length>2){ const v=s.funding.map(p=>p[1]*24*365*100), last=v[v.length-1];
      html+=`<div class="dsec">Funding APR ${span(s.funding)} · now ${(last>=0?'+':'')+last.toFixed(1)}%</div>${sparkline(v,{zero:true,color:'var(--blue)'})}`; }
    box.innerHTML = html || '<div class="dsec">OI / funding history</div><div class="sec" style="font-size:12px">collecting — the trend appears here as history accrues server-side</div>';
  }catch(_){}
}
// ===== drawer: fundamentals panel (xyz equity universe · Finnhub basic financials) =====
// Equity-side counterpart to the derivs panel. Everything is the server payload; the three
// price-sensitive figures (mkt cap / P/E / P/S) are derived server-side off the live mark, so this
// panel can never disagree with the price in the drawer header. Client renders, never re-derives.
let FUNDSEQ=0;
function loadDrawerFund(coin){ const box=el('dfund'); if(!box) return; const seq=++FUNDSEQ;
  fetchJSON('/api/fundamentals?coin='+encodeURIComponent(coin))
    .then(d=>{ if(state.detail!==coin||seq!==FUNDSEQ||!box.isConnected) return; renderFund(box,coin,d); })
    .catch(()=>{ if(state.detail===coin&&box.isConnected) box.innerHTML=''; }); }
function renderFund(box,coin,d){
  if(!d||d.enabled===false){ box.innerHTML=''; return; }   // no FINNHUB_TOKEN on the server — the panel simply doesn't exist
  const head=`<div class="dsec" data-tip="company fundamentals for the underlying \u2014 Finnhub basic financials + profile \u00b7 point-in-time, quarterly-updated, refreshed daily server-side \u00b7 US listings only (free tier) \u00b7 market cap / P/E / P/S are derived live off this board\u2019s mark, everything else is the cached quarterly figure">Fundamentals <span class="dzsrc">finnhub \u00b7 basic financials \u2014 not live</span></div>`;
  if(!d.covered){
    const why=esc(d.reason||'not covered');
    const tail=d.pending?'':`<span class="why">Absent, never guessed \u2014 same gate as the earnings tab: a name the US feed can\u2019t resolve gets no fabricated grid.</span>`;
    box.innerHTML=head+`<div class="fnnone">${d.pending?'Collecting \u2014 not fetched yet. The panel fills once the slow rotation reaches this name.':`Not covered on this feed \u2014 <b>${why}</b>.`}${tail}</div>`;
    return;
  }
  const num=(v,dg)=>(v==null||!isFinite(v))?null:(+v).toFixed(dg==null?2:dg);
  const na='<span class="na">\u00b7</span>';
  // trillion-aware compact formatter (fmtUsd caps at B) — local so no shared helper is touched
  const nfc=(v,dg)=>{ const a=Math.abs(v); if(a>=1e12)return (v/1e12).toFixed(dg)+'T'; if(a>=1e9)return (v/1e9).toFixed(dg)+'B'; if(a>=1e6)return (v/1e6).toFixed(dg)+'M'; if(a>=1e3)return (v/1e3).toFixed(1)+'K'; return (+v).toFixed(0); };
  const pct=(v,dg)=>num(v,dg)==null?na:num(v,dg)+'%';
  const pe = d.peNm ? '<span class="na" data-tip="trailing EPS is negative or zero \u2014 P/E is not meaningful">n/m</span>' : (num(d.pe,1)!=null?num(d.pe,1):na);
  const chip=(k,v,t)=>`<div class="dzchip" data-tip="${esc(t)}"><span class="dzk">${k}</span><span class="dzv">${v}</span></div>`;
  let html=head;
  html+=`<div class="fnsub"><span class="fndot"></span>${esc(d.name||coin)}${d.ind?' \u00b7 '+esc(d.ind):''}${d.asOf?' \u00b7 refreshed '+fmtAge(Date.now()-d.asOf)+' ago':''}</div>`;
  html+=`<div class="dzchips">`
    +chip('mkt cap', d.mcap!=null?'$'+nfc(d.mcap,2):na, 'market cap = live mark \u00d7 shares outstanding (Finnhub profile) \u2014 derived off the board price, so it tracks the header')
    +chip('P/E (TTM)', pe, 'live mark \u00f7 trailing-12m EPS \u2014 derived here so it never disagrees with the price above')
    +chip('P/S (TTM)', d.ps!=null?num(d.ps,1):na, 'live mark \u00f7 trailing-12m sales per share')
    +chip('div yield', pct(d.divY,2), 'indicated annual dividend yield (TTM)')
    +`</div>`;
  // 52-week range bar with crosshair readout
  if(d.wkHi!=null&&d.wkLo!=null&&d.px!=null&&d.wkHi>d.wkLo){
    const posPct=Math.max(0,Math.min(1,d.rangePos!=null?d.rangePos:((d.px-d.wkLo)/(d.wkHi-d.wkLo))))*100;
    const offHi=((d.px/d.wkHi)-1)*100;
    html+=`<div class="fnlbl">52-week range \u00b7 hover to scan</div>`
      +`<div class="fnrange" id="fnrng" data-lo="${d.wkLo}" data-hi="${d.wkHi}" data-px="${d.px}">`
      +`<span class="lo">${num(d.wkLo,2)}</span><span class="hi">${num(d.wkHi,2)}</span>`
      +`<span class="mk" style="left:${posPct.toFixed(2)}%"></span></div>`
      +`<div class="fnread" id="fnread">now <b>${num(d.px,2)}</b> \u00b7 ${posPct.toFixed(0)}% of range \u00b7 <span class="${offHi>=-0.05?'pos':'neg'}">${offHi>=0?'+':''}${offHi.toFixed(1)}%</span> from 52w high${d.wkHiD?' ('+esc(d.wkHiD)+')':''}</div>`;
  }
  // margins (TTM), each bar hoverable
  if(d.gm!=null||d.om!=null||d.nm!=null){
    const bar=(k,v)=>{ if(v==null||!isFinite(v)) return `<div class="fnbar" data-tip="${k} margin (TTM): no data"><span class="bk">${k}</span><span class="track"></span><span class="bv na">\u00b7</span></div>`;
      const neg=v<0, w=Math.max(2,Math.min(100,Math.abs(v))), col=neg?'var(--down)':(v>=45?'var(--up)':(v>=20?'var(--accent)':'var(--blue)'));
      return `<div class="fnbar${neg?' neg':''}" data-tip="${k} margin (TTM): ${v.toFixed(1)}%"><span class="bk">${k}</span><span class="track"><span class="fill" style="width:${w}%;background:${col}"></span></span><span class="bv">${v.toFixed(1)}%</span></div>`; };
    html+=`<div class="fnlbl">Margins (TTM)</div><div class="fnbars">`+bar('gross',d.gm)+bar('operating',d.om)+bar('net',d.nm)+`</div>`;
  }
  // detail grid
  const st=(k,v)=>`<div class="dstat"><span class="dk">${k}</span><span class="dv">${v}</span></div>`;
  const g=(v)=>num(v,1)==null?na:`<span class="${v>=0?'pos':'neg'}">${v>=0?'+':''}${num(v,1)}%</span>`;
  html+=`<div class="dgrid" style="margin-top:12px">`
    +st('EPS TTM', d.epsTTM!=null?num(d.epsTTM,2):na)+st('rev/sh TTM', d.revPsTTM!=null?num(d.revPsTTM,2):na)
    +st('rev growth', g(d.revG))+st('EPS growth', g(d.epsG))
    +st('P/B', d.pb!=null?num(d.pb,1):na)+st('ROE', pct(d.roe,1))
    +st('ROA', pct(d.roa,1))+st('shares out', d.shares!=null?nfc(d.shares*1e6,2):na)
    +`</div>`;
  box.innerHTML=html;
  // crosshair readout on the 52w bar — local mousemove (no shared chart machinery needed for one bar)
  const rng=el('fnrng'), read=el('fnread');
  if(rng&&read){ const lo=+rng.dataset.lo, hi=+rng.dataset.hi, px=+rng.dataset.px, base=read.innerHTML;
    rng.addEventListener('mousemove',e=>{ const rc=rng.getBoundingClientRect(); const fr=Math.max(0,Math.min(1,(e.clientX-rc.left)/rc.width)); const v=lo+(hi-lo)*fr; const dv=((v/px)-1)*100;
      read.innerHTML=`at <b>${v.toFixed(2)}</b> \u00b7 ${(fr*100).toFixed(0)}% of range \u00b7 <span class="${v>=px?'pos':'neg'}">${dv>=0?'+':''}${dv.toFixed(1)}%</span> vs mark ${px.toFixed(2)}`; });
    rng.addEventListener('mouseleave',()=>read.innerHTML=base);
  }
}
// ===== drawer: deriv-context panel (crypto universe · aggregated CEX via Coinalyze) =====
// Everything rendered here is the server payload — chips, buckets, cascade flags. Nothing is
// re-derived client-side, so this panel, the CASC column and any future consumer always agree.
// Charts: mirrored hourly liquidation bars (shorts up green, longs down red) + agg-OI line on a
// separate scale below (no dual-axis), shared crosshair + per-bucket tooltip across both.
let DZSEQ=0;
function loadDrawerDerivs(coin){ const box=el('dderivs'); if(!box) return; const seq=++DZSEQ;
  fetchJSON('/api/derivs?coin='+encodeURIComponent(coin))
    .then(d=>{ if(state.detail!==coin||seq!==DZSEQ||!box.isConnected) return; renderDerivs(box,coin,d); })
    .catch(()=>{ if(state.detail===coin&&box.isConnected) box.innerHTML=''; }); }
function renderDerivs(box,coin,d){
  if(!d||d.enabled===false){ box.innerHTML=''; return; }   // no key on the server — the panel simply doesn't exist
  const head=`<div class="dsec" data-tip="aggregated CEX liquidations + open interest for this coin \u2014 market context for the HL name, NOT Hyperliquid-native \u00b7 source: Coinalyze${d.venue?' \u00b7 venue: '+esc(d.venue)+' perp':''} \u00b7 USD values source-converted \u00b7 15-min buckets, chart aggregated hourly">Derivs context <span class="dzsrc">${esc(d.venue||'CEX')} \u00b7 coinalyze \u2014 not HL</span></div>`;
  if(d.error&&!(d.hours&&d.hours.length)){ box.innerHTML=head+`<div class="sec" style="font-size:11.5px;margin-bottom:10px">${esc(d.error)}</div>`; return; }
  const H=d.hours||[], roll=d.roll, now=Date.now();
  const stale=d.staleMs!=null&&d.staleMs>2*15*60*1000;
  const asOf=d.asOf?fmtAge(now-d.asOf)+' ago':'never';
  const chip=(k,v,t)=>`<div class="dzchip" data-tip="${esc(t)}"><span class="dzk">${k}</span><span class="dzv">${v}</span></div>`;
  let chips='<div class="dzchips">';
  if(roll){
    chips+=chip('agg OI',roll.oi!=null?fmtUsd(roll.oi):'\u2014','latest aggregated CEX open interest (USD, source-converted)');
    chips+=chip('OI \u0394 24h',roll.doi24!=null?`<span class="${roll.doi24>=0?'pos':'neg'}">${roll.doi24>=0?'+':''}${roll.doi24}%</span>`:'\u2014','open-interest change vs the stored bucket ~24h ago \u2014 dash when accumulated coverage is thinner (honest null, never a guess)');
    chips+=chip('long liqs 24h',`<span class="neg">${fmtUsd(roll.ll24)}</span>`,'longs force-liquidated over the last 24h of 15-min buckets');
    chips+=chip('short liqs 24h',`<span class="pos">${fmtUsd(roll.sl24)}</span>`,'shorts force-liquidated over the last 24h of 15-min buckets');
  }
  const r0=state.rows.get(coin);
  if(r0&&r0.fundPct!=null) chips+=chip('HL fund pctile',`P${r0.fundPct}`,'HL-NATIVE: where the current Hyperliquid funding rate sits in this market\u2019s own 31d hourly distribution \u2014 the one number in this panel from our own book, same percentile the funding column flags');
  chips+='</div>';
  const cov=d.coverageMs!=null?Math.max(1,Math.round(d.coverageMs/86400000)):null;
  const dot=`<span class="dzdot${stale?' warn':''}" data-tip="${stale?'STALE \u2014 last successful Coinalyze fetch '+asOf+' \u00b7 HL-native data elsewhere in this drawer is unaffected':'fresh \u00b7 last fetch '+asOf}"></span>`;
  const rbtn=`<button class="dzrefresh" id="dzref" data-tip="manual out-of-band refresh for this name (2 call-units against the shared Coinalyze budget) \u00b7 60s per-ticker cooldown, server-enforced and shared across the group \u00b7 queues behind the sweep, never blows the rate limit">refresh</button>`;
  const sub=`<div class="dzsub">as of ${asOf} ${dot}${cov?` \u00b7 <span data-tip="how much 15-min history THIS server has accumulated for the coin \u2014 Coinalyze deletes intraday history daily, so baselines only grow here \u00b7 cascade flags need \u226524h">${cov}d accumulated</span>`:''}${rbtn}</div>`;
  let charts='';
  if(H.length>=6){
    const W=560,HA=104,HB=64,mid=54,N=H.length,bw=Math.max(1,W/N-2);
    let sc=1; for(const b of H){ if(b[1]>sc)sc=b[1]; if(b[2]>sc)sc=b[2]; }
    const cx=i=>i*(W/N)+bw/2;
    let g=`<line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="var(--grid,rgba(128,128,128,.25))" stroke-width="1"/>`;
    const cascSet=new Set((d.casc||[]).map(f=>Math.floor(f.t/3600000)*3600000));
    for(let i=0;i<N;i++){ const b=H[i], x=i*(W/N)+1;
      const hs=(b[2]||0)/sc*46, hl=(b[1]||0)/sc*46;
      g+=`<rect x="${x.toFixed(1)}" y="${(mid-hs).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(hs,0.8).toFixed(1)}" fill="var(--up)"/>`;
      g+=`<rect x="${x.toFixed(1)}" y="${mid+1}" width="${bw.toFixed(1)}" height="${Math.max(hl,0.8).toFixed(1)}" fill="var(--down)"/>`;
      if(cascSet.has(b[0])) g+=`<text x="${cx(i).toFixed(1)}" y="9" fill="var(--accent)" font-size="9" text-anchor="middle">\u25c6</text>`;
    }
    g+=`<line class="dzchA" x1="0" y1="0" x2="0" y2="${HA}" stroke="var(--accent)" stroke-width="1" opacity="0"/>`;
    const oiV=H.map(b=>b[3]).filter(v=>v!=null);
    let oiSvg='';
    if(oiV.length>=2){ const mn=Math.min(...oiV),mx=Math.max(...oiV),sp=(mx-mn)||1; let pts='';
      for(let i=0;i<N;i++){ const v=H[i][3]; if(v==null)continue; pts+=`${cx(i).toFixed(1)},${(56-((v-mn)/sp)*48).toFixed(1)} `; }
      oiSvg=`<div class="dzlbl">agg OI (USD) \u00b7 same window</div><div class="dzwrap"><svg class="dzoi" viewBox="0 0 ${W} ${HB}" preserveAspectRatio="none"><polyline points="${pts.trim()}" fill="none" stroke="var(--blue)" stroke-width="1.6" stroke-linejoin="round"/><line class="dzchB" x1="0" y1="0" x2="0" y2="${HB}" stroke="var(--accent)" stroke-width="1" opacity="0"/><circle class="dzdotB" r="3" fill="var(--blue)" opacity="0"/></svg></div>`; }
    charts=`<div class="dzlbl">liquidations \u00b7 hourly \u00b7 ${Math.min(48,H.length)}h <span class="pos">shorts \u25b4</span> <span class="neg">longs \u25be</span> <span style="color:var(--accent)">\u25c6 cascade</span></div><div class="dzwrap"><svg class="dzliq" viewBox="0 0 ${W} ${HA}" preserveAspectRatio="none">${g}</svg></div>${oiSvg}<div class="dztip" style="display:none"></div>`;
  } else {
    charts=`<div class="sec" style="font-size:11.5px;margin-bottom:8px">accumulating \u2014 the chart appears once a few hourly buckets exist${d.error?' \u00b7 '+esc(d.error):''}</div>`;
  }
  box.innerHTML=head+sub+chips+charts+`<div class="dzfoot">context only \u00b7 a different venue population than the HL book \u00b7 baselines grow server-side from day one</div>`;
  box.classList.toggle('dzstale',stale);
  dzWire(box,coin,d);
}
function dzWire(box,coin,d){
  const btn=box.querySelector('#dzref');
  if(btn){ if(d.refreshInMs>0){ btn.disabled=true; btn.textContent=`refresh \u00b7 ${Math.ceil(d.refreshInMs/1000)}s`; setTimeout(()=>{ if(state.detail===coin&&btn.isConnected){ btn.disabled=false; btn.textContent='refresh'; } },d.refreshInMs+250); }
    btn.onclick=async()=>{ btn.disabled=true; btn.textContent='\u2026';
      try{ const r=await fetch('/api/derivs/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({coin})});
        const j=await r.json().catch(()=>null);
        if(r.status===429&&j&&j.retryInMs!=null){ btn.textContent=`cooldown \u00b7 ${Math.ceil(j.retryInMs/1000)}s`; setTimeout(()=>{ if(state.detail===coin) loadDrawerDerivs(coin); },j.retryInMs+250); return; }
        loadDrawerDerivs(coin);
      }catch(_){ btn.disabled=false; btn.textContent='refresh'; } }; }
  const H=d.hours||[]; if(H.length<6) return;
  const liq=box.querySelector('.dzliq'), oi=box.querySelector('.dzoi'), tip=box.querySelector('.dztip');
  const chA=box.querySelector('.dzchA'), chB=box.querySelector('.dzchB'), dotB=box.querySelector('.dzdotB');
  const N=H.length, W=560, oiV=H.map(b=>b[3]).filter(v=>v!=null);
  const mn=oiV.length?Math.min(...oiV):0, mx=oiV.length?Math.max(...oiV):1, sp=(mx-mn)||1;
  const cascByH=new Map(); for(const f of d.casc||[]) cascByH.set(Math.floor(f.t/3600000)*3600000,f);
  function move(ev,svg){ const r=svg.getBoundingClientRect();
    const i=Math.max(0,Math.min(N-1,Math.floor((ev.clientX-r.left)/r.width*N)));
    const b=H[i], x=(i*(W/N)+Math.max(1,W/N-2)/2);
    if(chA){ chA.setAttribute('x1',x); chA.setAttribute('x2',x); chA.setAttribute('opacity','.6'); }
    if(chB){ chB.setAttribute('x1',x); chB.setAttribute('x2',x); chB.setAttribute('opacity','.6'); }
    if(dotB&&b[3]!=null){ dotB.setAttribute('cx',x); dotB.setAttribute('cy',56-((b[3]-mn)/sp)*48); dotB.setAttribute('opacity','1'); }
    const f=cascByH.get(b[0]);
    const dte=new Date(b[0]);
    const pd=i>0&&H[i-1][3]!=null&&b[3]!=null&&H[i-1][3]>0?((b[3]/H[i-1][3]-1)*100).toFixed(2):null;
    tip.innerHTML=`${String(dte.getUTCHours()).padStart(2,'0')}:00 UTC${f?` <span style="color:var(--accent)">\u25c6 ${esc(f.side)} cascade</span>`:''}<br/><span class="neg">long liq ${fmtUsd(b[1]||0)}</span> \u00b7 <span class="pos">short liq ${fmtUsd(b[2]||0)}</span><br/><span style="color:var(--blue)">agg OI ${b[3]!=null?fmtUsd(b[3]):'\u2014'}</span>${pd!=null?` <span class="sec">\u0394 ${pd>0?'+':''}${pd}%</span>`:''}`;
    tip.style.display='block';
    const br=box.getBoundingClientRect();
    let tx=ev.clientX-br.left+12; if(tx>br.width-170) tx=Math.max(0,ev.clientX-br.left-165);
    tip.style.left=tx+'px'; tip.style.top=(ev.clientY-br.top+14)+'px'; }
  function out(){ tip.style.display='none'; for(const e of [chA,chB,dotB]) if(e) e.setAttribute('opacity','0'); }
  for(const svg of [liq,oi]){ if(!svg) continue; svg.addEventListener('mousemove',e=>move(e,svg)); svg.addEventListener('mouseleave',out); }
}
// ===== per-ticker signal record (drawer) + full history (Signals tab search) =====
// The drawer shows only the compact record — hit rate, per-event fractions, open count — so it
// stays scannable; the full claim-by-claim audit trail lives behind the ticker search on the
// Signals tab (openSigHistory deep-links there). Both read /api/ledger. Outcomes are signed
// with the claim, in the unit each claim resolved in (R for sigma-united events, % / bp
// otherwise); pre-epoch legacy entries are labeled rather than silently mixed.
function shDate(t){ try{ return new Date(t).toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+new Date(t).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}); }catch(_){ return ''; } }
function shVal(v,unit){ if(v==null) return '<span class="na">\u2014</span>';
  const s=(v>=0?'+':'')+(unit==='bp'?v.toFixed(0):v.toFixed(2))+(unit==='R'?'R':unit);
  return `<span class="${v>0?'pos':'neg'}">${s}</span>`; }
function shLeft(resolveAt){ const left=resolveAt-Date.now(); return left>0?(left>=86400000?(left/86400000).toFixed(1)+'d':(left/3600000).toFixed(0)+'h'):'due'; }
async function loadDrawerLedger(coin){
  const box=el('dledger'); if(!box) return;
  try{
    const d=await fetchJSON('/api/ledger?coin='+encodeURIComponent(coin));
    if(state.detail!==coin || !box.isConnected) return;
    const res=d.closed.filter(e=>e.status==='resolved'), open=d.open.length;
    if(!res.length&&!open&&!d.closed.length){ box.innerHTML=''; return; }   // nothing ever fired here
    const wins=res.filter(e=>e.win).length;
    const per={}; for(const e of res){ const b=per[e.ev]||(per[e.ev]={n:0,w:0,label:e.label}); b.n++; if(e.win)b.w++; }
    const chips=Object.keys(per).sort((a,b)=>per[b].n-per[a].n).map(ev=>{ const b=per[ev];
      return `<span class="sigrec-chip" data-tip="${esc(`${b.label}: ${b.w} of ${b.n} resolved claim${b.n===1?'':'s'} on this name went the way the signal implied`)}">${esc(b.label)} <b class="${b.w/b.n>=0.5?'pos':'neg'}">${b.w}/${b.n}</b></span>`; }).join('');
    const head=res.length?`<b class="${wins/res.length>=0.5?'pos':'neg'}">${Math.round(100*wins/res.length)}%</b> hit <span style="color:var(--faint)">(n=${res.length})</span>`:'<span class="sec">no resolutions yet</span>';
    const canJump=state.scope!=='crypto';
    box.innerHTML=`<div class="dsec" data-tip="out-of-sample record of every visible claim the engine ever fired on this name \u2014 hit = share of resolved claims that went the way the signal implied. The claim-by-claim history lives behind the ticker search on the Signals tab.">Signal record</div>`
      +`<div class="dsplit" style="flex-wrap:wrap">`
      +`<span>${head}</span>`
      +(open?`<span data-tip="claims on the books, awaiting their horizon">open <b>${open}</b></span>`:'')
      +(canJump?`<span id="dledger-full" class="sec" style="cursor:pointer;font-size:11px;text-decoration:underline;text-underline-offset:2px" data-tip="jump to the Signals tab with this ticker\u2019s full claim-by-claim history loaded">full history \u2192</span>`:'')
      +`</div>`
      +(chips?`<div class="dsplit" style="flex-wrap:wrap;gap:6px">${chips}</div>`:'');
    const fb=el('dledger-full');
    if(fb) fb.onclick=()=>{ const t=d.ticker||coin; closeDetail(); openSigHistory(t); };
  }catch(_){ box.innerHTML=''; }
}
// Full history panel on the Signals tab, driven by the static #sighist-q search input.
let _shSeq=0;

export function __boot_drawer_3163() { G._shTimer = null;
}

function sigHistRow(e,withTicker){
  const side=e.side==='long'?'<span class="pos">LONG</span>':e.side==='short'?'<span class="neg">SHORT</span>':'<span class="sec">\u2014</span>';
  const flags=(e.pr?' <span data-tip="fired as a \u2605 prime-quality claim">\u2605</span>':'')
    +(e.eg?' <span style="color:var(--accent)" data-tip="claim was in force within 1 ET day of a scheduled earnings print \u2014 tagged for the earnings-conditioned base-rate split (an earnings gap is a different animal than an overnight-drift gap)">E</span>':'')
    +(e.conf?' <span data-tip="fired WITH same-side company on this name (confluence)" style="color:var(--blue)">\u29c9</span>':'')
    +(e.legacy?' <i class="sig-unp" data-tip="resolved before sigma-normalization \u2014 outcome is in raw % and excluded from the R aggregates">legacy %</i>':'');
  const fired=shDate(e.t0)+(e.boot?' <span class="sec" style="cursor:help" data-tip="claim opened on the FIRST build after a server restart or deploy \u2014 the condition may have been in force before this stamp. The mark and outcome are measured from this moment, so the record is honest; only the onset time is a floor, not the true trigger time. Identical timestamps across events on one boot are this, not shared bookkeeping.">\u27f2</span>':'');
  const mark=e.mark0!=null?fmtPrice(e.mark0):'<span class="na">\u2014</span>';
  const tcell=withTicker?`<td><span class="sh-tk" data-shtk="${esc(e.tk||e.coin||'')}" style="cursor:pointer;color:var(--accent)" data-tip="drill down to this name\u2019s full history">${esc(e.tk||e.coin||'\u2014')}</span></td>`:'';
  const tip=`fired ${shDate(e.t0)} at ${e.mark0!=null?fmtPrice(e.mark0):'\u2014'} \u00b7 score ${e.score0!=null?e.score0:'\u2014'} at fire`
    +(e.claimMed!=null?` \u00b7 claimed med ${(e.claimMed>=0?'+':'')+e.claimMed.toFixed(2)}${e.unit}`:'')
    +(e.status==='resolved'?' \u00b7 outcome is signed with the claim: positive = it went the way the signal implied':'');
  // now: the live mark against THIS claim, client-computed (see nowChip). Open claims only — a
  // settled claim's trade is over and the outcome column already owns the answer.
  const nowc = `<td>${nowChip(e.coin||e.tk, { side:e.side, mark0:e.mark0, stp:e.stp, tgt:e.tgt, status:e.status }, { wrap:false })}</td>`;
  if(e.status==='open')
    return `<tr data-tip="${esc(tip+` \u00b7 resolves in ${shLeft(e.resolveAt)}`)}">${tcell}<td>${esc(e.label)}${flags}</td><td>${side}</td><td>${fired}</td><td>${mark}</td>${nowc}<td class="sec">in ${shLeft(e.resolveAt)}</td><td>${e.score0!=null?e.score0:'\u2014'}</td><td class="sec">open</td><td></td></tr>`;
  if(e.status==='void')
    return `<tr data-tip="${esc(tip+' \u00b7 could not be resolved (no usable price at horizon) \u2014 excluded from the record')}">${tcell}<td>${esc(e.label)}${flags}</td><td>${side}</td><td>${fired}</td><td>${mark}</td>${nowc}<td>${shDate(e.tR||e.t0)}</td><td>${e.score0!=null?e.score0:'\u2014'}</td><td class="na">void</td><td></td></tr>`;
  const sa=e.realizedS!=null&&e.realizedS!==e.realized
    ?`${shVal(e.realizedS,e.unit)}${e.stopped?' <span class="neg" data-tip="the frozen void level was touched before horizon">\u26d4</span>':''}`
    :(e.stopped?'<span class="neg" data-tip="the frozen void level was touched before horizon">\u26d4</span>':'<span class="sec">\u2014</span>');
  return `<tr data-tip="${esc(tip)}">${tcell}<td>${esc(e.label)}${flags}</td><td>${side}</td><td>${fired}</td><td>${mark}</td>${nowc}<td>${shDate(e.tR)}</td><td>${e.score0!=null?e.score0:'\u2014'}</td><td>${shVal(e.realized,e.unit)}</td><td>${sa}</td></tr>`;
}
async function loadSigHistory(f){
  const p=el('sighist-panel'); if(!p) return;
  const seq=++_shSeq;
  p.hidden=false; p.innerHTML='<div class="msg">Loading\u2026</div>';
  try{
    const qs=[]; if(f.coin) qs.push('coin='+encodeURIComponent(f.coin)); if(f.ev) qs.push('ev='+encodeURIComponent(f.ev));
    const d=await fetchJSON('/api/ledger?'+qs.join('&'));
    if(seq!==_shSeq||!p.isConnected) return;
    const withTicker=!f.coin;   // browsing across names -> show whose claim each row is
    const res=d.closed.filter(e=>e.status==='resolved'), wins=res.filter(e=>e.win).length;
    const rec=res.length?` \u00b7 <b class="${wins/res.length>=0.5?'pos':'neg'}">${Math.round(100*wins/res.length)}%</b> hit <span style="color:var(--faint)">(n=${res.length})</span>`:'';
    const evLbl=f.ev?(EV_LABELS[f.ev]||f.ev):'';
    const title=f.coin&&f.ev?`${esc(d.ticker||f.ticker||f.coin)} \u00b7 ${esc(evLbl)}`:(f.coin?esc(d.ticker||f.ticker||f.coin):esc(evLbl));
    const rows=d.open.map(e=>sigHistRow(e,withTicker)).join('')+d.closed.map(e=>sigHistRow(e,withTicker)).join('');
    const capNote=d.closed.length>=150?' <span class="sec" data-tip="the ledger keeps the last 4,000 resolved claims; this view shows the most recent 150 matching">\u00b7 most recent 150 shown</span>':'';
    p.innerHTML=`<div class="cp-head">${title} <span class="sec" style="font-weight:400">\u2014 signal history${rec}${d.open.length?` \u00b7 ${d.open.length} open`:''}${capNote}</span> <button class="btn xtiny" id="sighist-close" title="close" style="float:right">\u2715</button></div>`
      +(rows?`<table class="sigrec-t"><thead><tr>${withTicker?'<th>ticker</th>':''}<th>event</th><th>side</th><th data-tip="when THIS claim opened its own entry in the ledger (your local time) \u2014 every event instance stamps its own time. \u27f2 marks claims opened on the first build after a restart/deploy, where the condition may predate the stamp">fired</th><th data-tip="the mark THIS instance was triggered at \u2014 outcomes are measured from this price">mark</th><th data-tip="live price against this claim, computed here from the same streaming mark the board uses \u2014 never shipped in the cached ledger payload. \u0394 is signed WITH the claim: a short whose price is falling reads GREEN, because this column answers \u201cis this claim currently winning\u201d, not \u201cis the chart up\u201d. Touch-mode claims add a bracket bar: travel toward the frozen target (green, right) vs the frozen void (red, left). Settled claims show a dash \u2014 their outcome column already owns the answer">now</th><th data-tip="when it reached its horizon and was scored \u00b7 open claims show time remaining">resolved</th><th data-tip="signal score at fire time">score</th><th data-tip="at-horizon outcome, signed with the claim (positive = followed through), in the unit the study claims">outcome</th><th data-tip="stop-aware outcome: capped at the frozen void level when it was touched before horizon \u00b7 \u2014 when it coincides with at-horizon">\u26d4</th></tr></thead><tbody>${rows}</tbody></table>`
      :`<div class="sec" style="font-size:11.5px;padding:6px 2px">No claims match${f.ev?` \u2014 no ${esc(evLbl)} claim has ever fired${f.coin?` on ${esc(d.ticker||f.coin)}`:''}`:''}. The history starts with the first fire.</div>`);
    const cb=el('sighist-close'); if(cb) cb.onclick=()=>{ p.hidden=true; const q=el('sighist-q'); if(q) q.value=''; const ee=el('sighist-ev'); if(ee) ee.value=''; };
    p.querySelectorAll('[data-shtk]').forEach(c=>c.addEventListener('click',()=>{ const qi=el('sighist-q'); if(qi) qi.value=c.dataset.shtk; runSigHist(); }));
  }catch(_){ if(seq===_shSeq) p.innerHTML='<div class="msg">Could not load the history \u2014 try again.</div>'; }
}
function runSigHist(){
  const p=el('sighist-panel'); if(!p) return;
  const qi=el('sighist-q'), ei=el('sighist-ev');
  const q=(qi&&qi.value||'').trim().toUpperCase(), ev=(ei&&ei.value)||'';
  if(!q&&!ev){ p.hidden=true; return; }
  if(!q){ loadSigHistory({ev}); return; }   // pure signal-type browse, cross-ticker
  const cand=[]; let exact=null;
  for(const r of state.rows.values()){ if(r.delisted||!inScope(r)) continue; const t=(r.ticker||'').toUpperCase();
    if(t===q){ exact=r; break; } if(t.startsWith(q)) cand.push(r); }
  const pick=exact||(cand.length===1?cand[0]:null);
  if(pick){ loadSigHistory({coin:pick.coin, ticker:pick.ticker, ev}); return; }
  p.hidden=false;
  p.innerHTML=cand.length
    ? `<div class="cp-head">matches <span class="sec" style="font-weight:400">\u2014 pick a ticker</span></div><div class="dsplit" style="flex-wrap:wrap;gap:6px">${cand.slice(0,12).map(r=>`<span class="sigrec-chip" style="cursor:pointer" data-shc="${esc(r.ticker)}">${esc(r.ticker)}</span>`).join('')}</div>`
    : `<div class="sec" style="font-size:11.5px;padding:6px 2px">No ticker matching \u201c${esc(q)}\u201d in this scope.</div>`;
  p.querySelectorAll('[data-shc]').forEach(c=>c.addEventListener('click',()=>{ const q2=el('sighist-q'); if(q2) q2.value=c.dataset.shc; runSigHist(); }));
}
function openSigHistory(ticker){
  showView('signals');
  const q=el('sighist-q'); if(q) q.value=ticker;
  const ee=el('sighist-ev'); if(ee) ee.value='';
  runSigHist();
  const p=el('sighist-panel'); if(p) try{ p.scrollIntoView({block:'nearest'}); }catch(_){}
}
function closeDetail(){ state.detail=null; el('drawer').classList.remove('show'); el('drawerbg').classList.remove('show'); el('drawer').setAttribute('aria-hidden','true'); setHash(state.view==='markets'?'':state.view); }
function toggleWatch(coin){ if(state.watch.has(coin)) state.watch.delete(coin); else state.watch.add(coin); savePrefs(); render(); }
export { closeDetail, openDetail, openSigHistory, runSigHist, shDate, toggleWatch };
