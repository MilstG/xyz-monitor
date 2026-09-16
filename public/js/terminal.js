// terminal.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { IS_ADMIN, applyHash, featureOn, tabVisible } from "./admin.js";
import { showView } from "./backtest.js";
import { earnDiffC, earnNext, earnSessLbl, loadEarnings, loadNews, secShort } from "./calendar.js";
import { DAY, G, SCROLL_B, TF_MAP, activeRows, clamp, el, esc, fmtPrice, fmtUsd, inScope, median, state } from "./core.js";
import { BASKETS, RATIO, basketByName, basketMutate, dailyReturns, isBasketName, loadBaskets, openCompg, openRatio, renderCorr, syncCorrLookback, tfLabel } from "./corr.js";
import { computeDerived, fetchJSON, loadDaily, loadSnapshot, renderAskBudget, updateFreshTray } from "./data.js";
import { openDetail } from "./drawer.js";
import { termCongress, termEarnBackfill, termInsiders, termWhale } from "./insiders.js";
import { applyTabOrder, applyTabVisibility, buildTabGroups, scheduleDaily, setWindow, startCycle, startEvents, wireTabDrag } from "./nav.js";
import { epsFmt, epsPairFmt } from "./notes.js";
import { loadPositions, prefsPullAll } from "./prefs.js";
import { loadAiRecent, loadAiReport, openAiReport } from "./report.js";
import { computeSectors, sectorShort } from "./sectors.js";

let TALIAS;   // assigned in __boot (impure initializers keep their original order)



// ============================================================================
//  ASK-THE-BOARD TERMINAL — bottom-right console over the LIVE board.
//  Tier 1: grammar (ticker/field, top, screen, signals, report, corr).
//  Tier 2: local NL intent — maps human phrasing to the grammar, no AI, reads
//          the same state.rows the table renders (one code path). Badged 'computed'.
//  Tier 3: AI fallback (planner+analyst, gpt-5.6-sol) — STUBBED here; wires next build.
// ============================================================================
const termEl=id=>document.getElementById(id);
function termActive(){ return activeRows().filter(r=>!r.delisted); }
function termFind(tok){ tok=String(tok||'').toUpperCase(); if(!tok) return null;
  for(const r of state.rows.values()){ if(r.delisted) continue;
    if((r.ticker||'').toUpperCase()===tok||(r.coin||'').toUpperCase()===tok) return r; } return null; }
function termAprOf(r){ return (r.funding!=null&&isFinite(r.funding))? r.funding*24*365*100 : null; }
function tesc(s){ return esc(s); }
function tpad(s,w,r){ s=String(s); const g=w-s.length; return g<=0?s:(r?' '.repeat(g)+s:s+' '.repeat(g)); }
function tpct(v,dp){ if(v==null||!isFinite(v)) return '<span class="sec">—</span>'; dp=dp==null?1:dp; return `<span class="${v>=0?'pos':'neg'}">${v>=0?'+':''}${v.toFixed(dp)}%</span>`; }
function tint(v){ if(v==null||!isFinite(v)) return '<span class="sec">—</span>'; return `<span class="${v>=0?'pos':'neg'}">${v>=0?'+':''}${Math.round(v)}</span>`; }
// field accessors — every value read live off the row the board renders
const tpf1=v=>(v>=0?'+':'')+v.toFixed(1)+'%';
const TFIELD={
  funding:{g:termAprOf,f:v=>(v>=0?'+':'')+v.toFixed(0)+'%',l:'funding'},
  fundpct:{g:r=>r.fundPct,f:v=>v+'th',l:'fund pctile'},
  squeeze:{g:r=>r.sqz,f:v=>String(Math.round(v)),l:'squeeze'},
  momentum:{g:r=>r.mom,f:v=>(v>=0?'+':'')+Math.round(v),l:'momentum'},
  momentum2:{g:r=>r.momp,f:v=>(v>=0?'+':'')+Math.round(v),l:'MOM+'},
  oi:{g:r=>r.oi,f:fmtUsd,l:'oi'},
  vol:{g:r=>r.vol,f:fmtUsd,l:'24h vol'},
  vstape:{g:r=>r.vstape,f:v=>(v>=0?'+':'')+v.toFixed(1)+'%',l:'vs tape'},
  doi:{g:r=>r.doi,f:v=>(v>=0?'+':'')+v.toFixed(1)+'%',l:'Δoi'},
  beta:{g:r=>r.beta,f:v=>v.toFixed(2),l:'beta'},
  dd:{g:r=>r.dd,f:v=>v.toFixed(1)+'%',l:'vs 30d hi'},
  carry:{g:r=>r.carry,f:v=>(v>=0?'+':'')+v.toFixed(2),l:'carry'},
  turn:{g:r=>r.turn,f:v=>'×'+v.toFixed(1),l:'oi/vol'},
  d1:{g:r=>r.d1,f:v=>(v>=0?'+':'')+v.toFixed(1)+'%',l:'1d'},
  price:{g:r=>r.px,f:fmtPrice,l:'price'},
  ma20:{g:r=>r.ma20,f:fmtPrice,l:'MA 20'}, ma50:{g:r=>r.ma50,f:fmtPrice,l:'MA 50'},
  ma100:{g:r=>r.ma100,f:fmtPrice,l:'MA 100'}, ma200:{g:r=>r.ma200,f:fmtPrice,l:'MA 200'},
  vwap:{g:r=>r.vwap30,f:fmtPrice,l:'VWAP 30d'},
  // full board coverage — every numeric column is a callable lens, plus computed distances
  h1:{g:r=>r.h1,f:tpf1,l:'1h'}, h4:{g:r=>r.h4,f:tpf1,l:'4h'},
  d7:{g:r=>r.d7,f:tpf1,l:'7d'}, d30:{g:r=>r.d30,f:tpf1,l:'30d'},
  gap:{g:r=>r.gap,f:tpf1,l:'close→open gap'},
  prem:{g:r=>r.prem,f:v=>(v>=0?'+':'')+v.toFixed(1)+'bp',l:'perp premium'},
  rvol:{g:r=>r.rvol,f:v=>'×'+v.toFixed(1),l:'rvol'},
  adr:{g:r=>r.adr,f:v=>v.toFixed(2)+'%',l:'avg daily range'},
  vol30:{g:r=>r.vol30,f:v=>Math.round(v)+'%',l:'realized vol (ann)'},
  rs:{g:r=>r.rs,f:tpf1,l:'vs S&P'},
  dcap:{g:r=>r.dcap,f:v=>Math.round(v)+'%',l:'downcap 31d'},
  hitr:{g:r=>r.hitr,f:v=>Math.round(v)+'%',l:'hit% red tape'},
  ddy:{g:r=>r.ddy,f:v=>v.toFixed(1)+'%',l:'vs YTD hi'},
  vsvwap:{g:r=>r.vsvwap,f:tpf1,l:'vs 30d VWAP'},
  yopen:{g:r=>r.yopen,f:fmtPrice,l:'year open'}, mopen:{g:r=>r.mopen,f:fmtPrice,l:'month open'},
  vsyopen:{g:r=>(r.px>0&&r.yopen>0)?(r.px/r.yopen-1)*100:null,f:tpf1,l:'YTD'},
  vsmopen:{g:r=>(r.px>0&&r.mopen>0)?(r.px/r.mopen-1)*100:null,f:tpf1,l:'MTD'},
  vsma20:{g:r=>(r.px>0&&r.ma20>0)?(r.px/r.ma20-1)*100:null,f:tpf1,l:'vs 20dma'},
  vsma50:{g:r=>(r.px>0&&r.ma50>0)?(r.px/r.ma50-1)*100:null,f:tpf1,l:'vs 50dma'},
  vsma100:{g:r=>(r.px>0&&r.ma100>0)?(r.px/r.ma100-1)*100:null,f:tpf1,l:'vs 100dma'},
  vsma200:{g:r=>(r.px>0&&r.ma200>0)?(r.px/r.ma200-1)*100:null,f:tpf1,l:'vs 200dma'},
};
function tfield(name){ name=(name||'').toLowerCase().replace(/[^a-z0-9]/g,''); return TFIELD[name]?name:(TALIAS[name]||null); }
// top-list metrics, with natural-language aliases so "trending", "movers", "hot" resolve.
const METRICS=new Set(['vol','funding','squeeze','momentum','oi','carry','gainers','losers']);
const METRIC_ALIAS={volume:'vol',turnover:'vol',liquid:'vol',rate:'funding',fund:'funding',
  sqz:'squeeze',coiled:'squeeze',mom:'momentum',trending:'momentum',trend:'momentum',hot:'momentum',hottest:'momentum',strong:'momentum',leading:'momentum',
  openinterest:'oi',winner:'gainers',winners:'gainers',gainer:'gainers',movers:'gainers',up:'gainers',green:'gainers',best:'gainers',
  loser:'losers',losers:'losers',decliner:'losers',down:'losers',red:'losers',worst:'losers'};
function metricOf(word){ word=(word||'').toLowerCase().replace(/[^a-z]/g,''); return METRICS.has(word)?word:(METRIC_ALIAS[word]||null); }

// ---- Tier 1 grammar handlers ----
function termTkHdr(r){ const uni=r.uni==='main'?'crypto':'stocks'; return `<span class="tp-hd">${tesc(r.ticker)}</span> <span class="sec">${tesc(r.coin)}</span> <span class="tp-trans">${uni}${r.sector?' · '+tesc(r.sector):''}</span>`; }
function termCard(r){ const apr=termAprOf(r), fp=r.fundPct;
  termHi(r.coin);
  const lines=[ termTkHdr(r),
    `<span class="tp-k">price</span> <b>${fmtPrice(r.px)}</b>  ${tpct(r.d1)} ${r.d1>=0?'▲':'▼'}`,
    apr!=null?`<span class="tp-k">funding</span> ${apr>=0?'<span class=pos>+':'<span class=neg>'}${apr.toFixed(0)}% APR</span>${fp!=null?` · ${fp>=90?'<span class=pos>▴'+fp+'</span>':fp<=10?'<span class=neg>▾'+fp+'</span>':fp}th pctile`:''}`:'',
    `<span class="tp-k">oi</span> ${fmtUsd(r.oi)}${r.doi!=null?` · Δ ${tpct(r.doi)}`:''}`,
    (r.sqz!=null||r.mom!=null)?`<span class="tp-k">squeeze</span> <span class="${r.sqz>=50?'amber':'sec'}">${r.sqz!=null?Math.round(r.sqz):'—'}</span>  momentum ${tint(r.mom)}`:'',
    (r.vstape!=null||r.beta!=null)?`<span class="tp-k">vs tape</span> ${tpct(r.vstape)}${r.beta!=null&&isFinite(r.beta)?` · β ${r.beta.toFixed(2)}`:''}`:'',
    `<span class="tp-k">views</span> <span role="button" tabindex="0" class="tp-deep" data-tcmd="report ${tesc(r.ticker)}">report ▸</span>  <span role="button" tabindex="0" class="tp-deep" data-topen="${tesc(r.coin)}">drawer ▸</span>` ].filter(Boolean);
  termOut(lines.join('\n')); }
function termFieldCmd(r,fname){
  if((fname||'').toLowerCase().replace(/[^a-z]/g,'')==='sector'){ termHi(r.coin);
    return termOut(`${termTkHdr(r)}\n<span class="tp-k">sector</span> <b>${r.sector?tesc(r.sector):'—'}</b>${r.secAuto?` <span class="auto-chip${r.secAuto==='grad'?' grad':''}" title="${r.secAuto==='grad'?'auto-graduated Pre-IPO \u2192 Equity by the weekly sector audit \u2014 evidence + revert in Admin \u00b7 Classification audit':'auto-classified by the weekly sector audit (Finnhub + EDGAR agreement) \u2014 evidence + revert in Admin \u00b7 Classification audit'}">auto${r.secAuto==='grad'?'\u00b7grad':''}</span>`:''}`); }
  const fk=tfield(fname); if(!fk) return termAsk(r.ticker+' '+fname);   // unknown lens -> let the AI try, don't fake a card (returned: a chat capture awaits it)
  const F=TFIELD[fk], v=F.g(r); termHi(r.coin);
  termOut(`${termTkHdr(r)}\n<span class="tp-k">${F.l}</span> <b>${v==null||!isFinite(v)?'—':F.f(v)}</b>`); }
function termTop(metric,n,asc){ n=n||8; const m=metricOf(metric)||tfield(metric);
  if(!m) return termErr(`metric? any live column works — vol · funding · squeeze · momentum · oi · carry · gainers · losers · d7 · d30 · rvol · vsvwap · gap · …`);
  let key=m, label=m;
  if(m==='gainers'){key='d1';asc=false;} else if(m==='losers'){key='d1';asc=true;}
  const F=TFIELD[key];
  let list=termActive().map(r=>({r,v:F.g(r)})).filter(x=>x.v!=null&&isFinite(x.v));
  list.sort((a,b)=>asc?a.v-b.v:b.v-a.v); list=list.slice(0,n);
  if(!list.length) return termOut(`<span class="sec">no data for ${tesc(label)} in this scope yet</span>`);
  const rows=list.map((x,i)=>`${tpad(i+1,2)} <span role="button" tabindex="0" class="tp-deep" data-tcmd="${tesc(x.r.ticker)}">${tesc(tpad(x.r.ticker,8))}</span> ${tpad(F.f(x.v),10,true)}  <span class="tp-trans">${tpad(fmtUsd(x.r.vol),8,true)} vol</span>`).join('\n');
  termOut(`<span class="tp-hd">${asc&&m!=='losers'?'bottom':'top'} ${tesc(label)}</span> <span class="tp-trans">· ${state.scope}</span>\n<span class="tp-th">${tpad('#',2)} ${tpad('TICKER',8)} ${tpad((F.l||label).toUpperCase().slice(0,12),10,true)}</span>\n${rows}`); }
// Earnings — reads the live earnings map the E-badges use; equities only, honest about coverage.
function termEarnings(r){
  if(r.uni!=='xyz') return termOut(`${termTkHdr(r)}\n<span class="sec">earnings apply to equities — ${tesc(r.ticker)} doesn't report</span>`);
  if(!state.earn) return termOut(`${termTkHdr(r)}\n<span class="sec">earnings calendar still loading…</span>`);
  const p=earnNext(r.ticker); const win=(state.earnPayload&&state.earnPayload.windowDays)||14;
  termHi(r.coin);
  if(!p) return termOut(`${termTkHdr(r)}\n<span class="tp-k">earnings</span> <span class="sec">no report scheduled in the next ${win}d</span> <span class="tp-trans">(foreign listings without a US symbol aren't covered)</span>\n<span role="button" tabindex="0" class="tp-deep" data-tview="earnings">open earnings tab ▸</span>`);
  const when=p.diff===0?'<b class="amber">today</b>':p.diff===1?'<b>tomorrow</b>':`<b>in ${p.diff}d</b> (${tesc(p.e.d)})`;
  const rep=p.diff===0&&p.e.epsA!=null?` · reported EPS ${epsFmt(p.e.epsA)}`:'';
  termOut(`${termTkHdr(r)}\n<span class="tp-k">earnings</span> ${when} · ${tesc(earnSessLbl(p.e.s))}${rep}\n<span role="button" tabindex="0" class="tp-deep" data-tview="earnings">open earnings tab ▸</span>`); }
function termScreen(expr){ const cls=(expr||'').split('&').map(c=>c.trim()).filter(Boolean); if(!cls.length) return termErr('screen needs an expression, e.g. funding>20 & squeeze>50');
  const preds=[]; let sortF=null;
  // The field class admits digits: vsma200, ma50, d7, vol30 are lenses too, and `[a-z ]` refused
  // every one of them ("can't parse vsma200>0" — the phrasebook's own output for "above the 200dma").
  for(const c of cls){ const m=c.match(/^([a-z][a-z0-9 ]*?)\s*(>=|<=|>|<|=)\s*(-?[\d.]+[kmbt]?)$/i);
    if(!m) return termErr(`can't parse "${c}" — form is  field>value`);
    const fk=tfield(m[1].trim()); if(!fk) return termErr(`unknown field "${m[1].trim()}"`);
    let v=parseFloat(m[3]); const suf=(m[3].slice(-1)||'').toLowerCase(); if('kmbt'.includes(suf)) v*={k:1e3,m:1e6,b:1e9,t:1e12}[suf];
    const F=TFIELD[fk]; if(!sortF) sortF=F; preds.push({F,op:m[2],v}); }
  const pass=r=>preds.every(p=>{ const x=p.F.g(r); if(x==null||!isFinite(x)) return false;
    return p.op==='>'?x>p.v:p.op==='<'?x<p.v:p.op==='>='?x>=p.v:p.op==='<='?x<=p.v:x===p.v; });
  let hits=termActive().filter(pass); hits.sort((a,b)=>(sortF.g(b)||0)-(sortF.g(a)||0));
  if(!hits.length) return termOut(`<span class="tp-hd">screen</span> <span class="sec">${tesc(expr)}</span>\n<span class="tp-trans">no matches in ${state.scope}</span>`);
  const rows=hits.slice(0,14).map(r=>`<span role="button" tabindex="0" class="tp-deep" data-tcmd="${r.ticker}">${tpad(r.ticker,8)}</span> ${tpad(fmtPrice(r.px),9,true)}  ${tpad((termAprOf(r)>=0?'+':'')+(termAprOf(r)!=null?termAprOf(r).toFixed(0):'—')+'%',7,true)} f  ${tpad(r.sqz!=null?Math.round(r.sqz):'—',3,true)} sqz  ${tpad(tint(r.mom).replace(/<[^>]+>/g,''),4,true)} mom`).join('\n');
  termOut(`<span class="tp-hd">screen</span> <span class="sec">${tesc(expr)}</span> <span class="tp-trans">· ${hits.length} match${hits.length>1?'es':''} · ${state.scope}</span>\n${rows}`); }
function termSignals(t){ const d=state.signals; let groups=(d&&Array.isArray(d.signals))?d.signals.slice():[];
  groups=groups.filter(g=>{ const r=state.rows.get(g.coin); return r&&!r.delisted&&inScope(r); });
  if(t) groups=groups.filter(g=>(g.ticker||'').toUpperCase()===t||(g.coin||'').toUpperCase()===t);
  if(!groups.length) return termOut(`<span class="sec">no active signals${t?' for '+tesc(t):''} in ${state.scope}</span> <span class="tp-trans">— an unusual condition ranked, never a prediction</span>`);
  const rows=groups.slice(0,10).map(g=>{ const top=(g.sigs&&g.sigs[0])||{}; const side=(top.claim0&&top.claim0.side)||(top.play&&top.play.side)||'watch';
    const sc=side==='long'?'<span class="tp-chip l">long</span>':side==='short'?'<span class="tp-chip s">short</span>':'<span class="tp-chip">watch</span>';
    const prime=(g.sigs||[]).some(x=>x.prime)?' <span class="tp-chip p">★prime</span>':'';
    const score=g.score!=null?g.score:(top.score!=null?top.score:null);
    return `<span role="button" tabindex="0" class="tp-deep" data-tcmd="${tesc(g.ticker)}">${tesc(tpad(g.ticker,6))}</span> ${tpad(top.label||top.ev||'—',11)} ${score!=null?'<span class="amber">score '+Math.round(score)+'</span>':''}${prime} ${sc}`; }).join('\n');
  termOut(`<span class="amber">⚡ ${groups.length} active signal${groups.length>1?'s':''}</span> <span class="tp-trans">· ledgered &amp; resolved out-of-sample</span>\n${rows}`); }
function termReport(r){ termOut(`${termTkHdr(r)}\n<span class="tp-trans">opening the AI analyst report…</span>`); openAiReport(r.coin); }
function termComp(tickers){ showView('corr');
  setTimeout(()=>openCompg(tickers), 40);   // openCompg self-defers on crypto until the matrix's intraday series is ready
  termOut(`<span class="tp-hd">comp</span> ${tickers.map(t=>tesc(t)).join(' · ')} <span class="tp-trans">· COMP/G — ${tickers.length} names rebased to 100 over ${tfLabel()}</span>`); }
function termCorr(a,b){ const ra=termFind(a), rb=termFind(b); if(!ra||!rb) return termErr('need two tickers — e.g. corr btc eth');
  const ma=dailyReturns(ra), mb=dailyReturns(rb); if(!ma||!mb) return termOut(`<span class="sec">not enough daily history for ${tesc(ra.ticker)} × ${tesc(rb.ticker)} yet</span>`);
  const cut=Math.floor(Date.now()/DAY)-90, xs=[],ys=[];
  for(const [d,va] of ma){ if(d<cut) continue; const vb=mb.get(d); if(vb!==undefined){ xs.push(va); ys.push(vb); } }
  const n=xs.length; if(n<20) return termOut(`<span class="sec">only ${n} overlapping days for ${tesc(ra.ticker)} × ${tesc(rb.ticker)} — too few to trust</span>`);
  let sx=0,sy=0; for(let i=0;i<n;i++){sx+=xs[i];sy+=ys[i];} const mx=sx/n,my=sy/n; let cov=0,vx=0,vy=0;
  for(let i=0;i<n;i++){ const dx=xs[i]-mx,dy=ys[i]-my; cov+=dx*dy; vx+=dx*dx; vy+=dy*dy; }
  const rho=(vx>0&&vy>0)?cov/Math.sqrt(vx*vy):null, beta=vx>0?cov/vx:null;
  if(rho==null) return termOut('<span class="sec">flat series — no correlation</span>');
  const cl=rho>=0.5?'pos':rho<=-0.5?'neg':'sec';
  termOut(`<span class="tp-hd">corr</span> ${tesc(ra.ticker)} × ${tesc(rb.ticker)} <span class="tp-trans">· ${n}d daily returns</span>\nρ <b class="${cl}">${rho>=0?'+':''}${rho.toFixed(2)}</b>   hedge β ${beta!=null?beta.toFixed(2):'—'}\n<span class="tp-trans">${Math.abs(rho)>=0.7?'one risk factor wearing two names':Math.abs(rho)<0.3?'largely independent':'moderate co-movement'}</span>`); }
function termDiverge(r){ const benchC=r.uni==='main'?state.benchMain:state.benchCoin; const bench=benchC?state.rows.get(benchC):null;
  let rho=null; if(bench&&dailyReturns(r)&&dailyReturns(bench)){ const ma=dailyReturns(r),mb=dailyReturns(bench),cut=Math.floor(Date.now()/DAY)-90,xs=[],ys=[];
    for(const [d,va] of ma){ if(d<cut) continue; const vb=mb.get(d); if(vb!==undefined){xs.push(va);ys.push(vb);} }
    if(xs.length>=20){ let sx=0,sy=0;for(let i=0;i<xs.length;i++){sx+=xs[i];sy+=ys[i];}const mx=sx/xs.length,my=sy/xs.length;let cov=0,vx=0,vy=0;for(let i=0;i<xs.length;i++){const dx=xs[i]-mx,dy=ys[i]-my;cov+=dx*dy;vx+=dx*dx;vy+=dy*dy;}if(vx>0&&vy>0)rho=cov/Math.sqrt(vx*vy);} }
  termHi(r.coin);
  const verdict = (r.vstape!=null&&Math.abs(r.vstape)>1.5)?(r.vstape>0?'leading the group':'lagging the group'):'moving with the group';
  termOut(`${termTkHdr(r)}\n<span class="tp-k">corr→bench</span> ${rho!=null?'<b>'+rho.toFixed(2)+'</b>':'—'}${r.beta!=null&&isFinite(r.beta)?' · β '+r.beta.toFixed(2):''}\n<span class="tp-k">vs tape</span> ${tpct(r.vstape)}${r.fundPct!=null?' · funding '+r.fundPct+'th pctile':''}\n<span class="tp-trans">${verdict}${rho!=null&&rho<0.5?', and moving with it less than usual — decoupling':''}</span>`); }

// ---- whole-board commands: every surface the app holds is callable ------------------------
const TWIN_LBL={d1:'today',d7:'7d',d30:'30d',h1:'1h',h4:'4h'};
function termBreadth(k){ k=TFIELD[k]?k:'d1'; const F=TFIELD[k];
  const vals=termActive().map(r=>({r,v:F.g(r)})).filter(x=>x.v!=null&&isFinite(x.v));
  if(!vals.length) return termOut('<span class="sec">no data in this scope yet</span>');
  const up=vals.filter(x=>x.v>0).length, dn=vals.filter(x=>x.v<0).length, med=median(vals.map(x=>x.v));
  vals.sort((a,b)=>b.v-a.v); const hi=vals[0], lo=vals[vals.length-1];
  const cl=med>0.05?'pos':med<-0.05?'neg':'sec';
  termOut(`<span class="tp-hd">breadth</span> <span class="tp-trans">· ${state.scope} · ${TWIN_LBL[k]||k} · ${vals.length} names</span>\n`
    +`<span class="pos">${up} up</span> · <span class="neg">${dn} down</span> · median <b class="${cl}">${med>=0?'+':''}${med.toFixed(2)}%</b>\n`
    +`<span class="tp-k">best</span> <span role="button" tabindex="0" class="tp-deep" data-tcmd="${tesc(hi.r.ticker)}">${tesc(hi.r.ticker)}</span> ${tpct(hi.v)}   <span class="tp-k">worst</span> <span role="button" tabindex="0" class="tp-deep" data-tcmd="${tesc(lo.r.ticker)}">${tesc(lo.r.ticker)}</span> ${tpct(lo.v)}`); }
function termSectors(k){ k=TFIELD[k]?k:'d1'; const F=TFIELD[k]; const by=new Map();
  for(const r of termActive()){ const v=F.g(r); if(v==null||!isFinite(v)) continue;
    const sec=r.sector||'unclassified'; let a=by.get(sec); if(!a){a=[];by.set(sec,a);} a.push(v); }
  if(!by.size) return termOut('<span class="sec">no sector data in this scope</span>');
  const grp=[...by.entries()].map(([sec,vs])=>({sec,med:median(vs),n:vs.length})).sort((a,b)=>b.med-a.med);
  const lines=grp.slice(0,12).map(x=>`${tpad(tesc(secShort(x.sec)).slice(0,15),16)} <span class="${x.med>=0?'pos':'neg'}">${tpad((x.med>=0?'+':'')+x.med.toFixed(2)+'%',8,true)}</span>  <span class="tp-trans">${x.n} name${x.n>1?'s':''}</span>`).join('\n');
  termOut(`<span class="tp-hd">sectors</span> <span class="tp-trans">· median ${TWIN_LBL[k]||k} · ${state.scope}</span>\n${lines}`); }
async function termEarnCal(mode){
  if(state.scope==='crypto') termOut('<span class="tp-trans">earnings are an equities thing — showing the stocks calendar</span>');
  if(!state.earnPayload){ try{ await loadEarnings(); }catch(_){} }
  const d=state.earnPayload; if(!d) return termOut('<span class="sec">earnings calendar hasn\'t loaded yet — ask again in a moment</span>');
  if(mode==='recent'){ const rec=(d.recent||[]).slice(0,10);
    if(!rec.length) return termOut('<span class="sec">no recently reported names in the window</span>');
    const lines=rec.map(e=>{ const r=termFind(e.t);
      const eps=e.epsA!=null?(e.eps!=null?(([fa,fe])=>`EPS ${fa} vs ${fe} est (${e.epsA>e.eps?'<span class="pos">beat</span>':e.epsA<e.eps?'<span class="neg">miss</span>':'in line'})`)(epsPairFmt(e.epsA,e.eps)):`EPS ${epsFmt(e.epsA)}`):'<span class="sec">EPS pending</span>';
      const day=r&&r.d1!=null&&isFinite(r.d1)?` · day ${tpct(r.d1)}`:'';
      return `<span role="button" tabindex="0" class="tp-deep" data-tcmd="${tesc(e.t)}">${tpad(tesc(e.t),7)}</span> ${tesc(e.d)} ${tesc(earnSessLbl(e.s))} · ${eps}${day}`; }).join('\n');
    return termOut(`<span class="tp-hd">recently reported</span>\n${lines}\n<span role="button" tabindex="0" class="tp-deep" data-tview="earnings">open earnings tab ▸</span>`); }
  const max=mode==='today'?0:mode==='tomorrow'?1:(d.windowDays||14), min=mode==='tomorrow'?1:0;
  const ent=(d.entries||[]).map(e=>({e,diff:earnDiffC(e.d)})).filter(x=>x.diff!=null&&x.diff>=min&&x.diff<=max);
  if(!ent.length) return termOut(`<span class="tp-hd">earnings ${tesc(mode)}</span>\n<span class="sec">nothing scheduled${mode==='today'?' today':mode==='tomorrow'?' tomorrow':' in the next '+(d.windowDays||14)+'d'}</span> <span class="tp-trans">(universe names with a US listing — foreign-only listings aren't covered)</span>`);
  ent.sort((a,b)=>a.diff-b.diff);
  const lines=ent.slice(0,14).map(x=>{ const when=x.diff===0?'<b class="amber">today</b>':x.diff===1?'tomorrow':`in ${x.diff}d (${tesc(x.e.d)})`;
    return `<span role="button" tabindex="0" class="tp-deep" data-tcmd="${tesc(x.e.t)}">${tpad(tesc(x.e.t),7)}</span> ${when} · ${tesc(earnSessLbl(x.e.s))}${x.e.eps!=null?' · est '+x.e.eps:''}`; }).join('\n');
  termOut(`<span class="tp-hd">earnings ${tesc(mode)}</span> <span class="tp-trans">· ${ent.length} name${ent.length>1?'s':''}</span>\n${lines}\n<span role="button" tabindex="0" class="tp-deep" data-tview="earnings">open earnings tab ▸</span>`); }
function termAgo(ts){ const m=Math.max(0,Math.round((Date.now()-ts)/60000)); return m<60?m+'m':m<48*60?Math.round(m/60)+'h':Math.round(m/1440)+'d'; }
async function termNewsCmd(tk,n){ n=n||8;
  if(!state.news){ try{ await loadNews(); }catch(_){} }
  const d=state.news; if(!d||!Array.isArray(d.items)) return termOut('<span class="sec">news feed hasn\'t loaded yet — ask again in a moment</span>');
  let items=d.items.filter(a=>!a.fl);   // filings are their own lane — never mixed into headlines
  if(tk) items=items.filter(a=>(a.tk||'').toUpperCase()===tk); else items=items.filter(a=>!!a.tk);   // bare: verified attributions only
  items=items.slice().sort((a,b)=>(b.pub||0)-(a.pub||0)).slice(0,n);
  if(!items.length) return termOut(`<span class="sec">no ${tk?tesc(tk)+' ':''}headlines in the 72h window</span>${tk?' <span class="tp-trans">(per-name coverage rotates — thin names surface less often)</span>':''}`);
  const lines=items.map(a=>`<span class="tp-trans">${termAgo(a.pub||Date.now())}</span> ${a.tk?`<span role="button" tabindex="0" class="tp-deep" data-tcmd="${tesc(a.tk)}">${tpad(tesc(a.tk),6)}</span> `:''}${a.url?`<a href="${tesc(a.url)}" target="_blank" rel="noopener">${tesc(a.h||'')}</a>`:tesc(a.h||'')}`).join('\n');
  termOut(`<span class="tp-hd">news${tk?' · '+tesc(tk):''}</span> <span class="tp-trans">· verified attributions · 72h window</span>\n${lines}\n<span role="button" tabindex="0" class="tp-deep" data-tview="news">open news tab ▸</span>`); }
async function termReports(){ let d=state.report.list;
  if(!d){ try{ d=await fetchJSON('/api/ai-reports'); state.report.list=d; }catch(_){} }
  const list=d&&Array.isArray(d.reports)?d.reports:[];
  if(!list.length) return termOut('<span class="sec">no AI reports generated yet</span> <span class="tp-trans">— try <span class="ex" data-tcmd="report NVDA">report NVDA</span></span>');
  const lines=list.slice(0,8).map(x=>`<span class="tp-trans">${termAgo(x.ts)}</span> <span role="button" tabindex="0" class="tp-deep" data-tcmd="report ${tesc(x.ticker)}">${tpad(tesc(x.ticker),7)}</span> <span class="tp-chip ${x.bias==='long'?'l':x.bias==='short'?'s':''}">${tesc(x.bias||'—')}</span> ${tesc((x.headline||'').slice(0,64))}`).join('\n');
  termOut(`<span class="tp-hd">recent AI reports</span> <span class="tp-trans">· shared across the group</span>\n${lines}`); }
// ---- external fundamentals cards (SEC EDGAR) ----
// Card builders are PURE string functions (fetch-free) so the test suite can execute them
// against fixture payloads and assert real markup — the behavioral-render doctrine. Every
// number on these cards is a filed figure shaped server-side; a missing field renders as an
// explicit em-dash because the filer never tagged it, not because we dropped it.
function tmoney(v){ if(v==null||!isFinite(v)) return '\u2014'; const a=Math.abs(v), sg=v<0?'-':'';
  if(a>=1e12) return sg+'$'+(a/1e12).toFixed(2)+'T'; if(a>=1e9) return sg+'$'+(a/1e9).toFixed(2)+'B';
  if(a>=1e6) return sg+'$'+(a/1e6).toFixed(1)+'M'; if(a>=1e3) return sg+'$'+(a/1e3).toFixed(1)+'K'; return sg+'$'+a.toFixed(2); }
function tcount(v){ if(v==null||!isFinite(v)) return '\u2014'; const a=Math.abs(v);
  if(a>=1e9) return (v/1e9).toFixed(2)+'B'; if(a>=1e6) return (v/1e6).toFixed(1)+'M'; if(a>=1e3) return (v/1e3).toFixed(1)+'K'; return String(v); }
function termFundCard(d){
  if(!d||!d.ok) return `<span class="sec">${tesc((d&&d.error)||'fundamentals unavailable')}</span>`;
  const x=d.data||{}, f=x.fields||{};
  const row=(lbl,fd,fmt)=>`<span class="tp-k">${tpad(lbl,14)}</span> <b>${fd?fmt(fd.v):'\u2014'}</b>${fd&&fd.period?` <span class="tp-trans">${tesc(String(fd.period))}</span>`:''}`;
  const lines=[ row('assets',f.assets,tmoney), row('liabilities',f.liabilities,tmoney), row('equity',f.equity,tmoney),
    row('cash',f.cash,tmoney), row('lt debt',f.debt,tmoney), row('net cash',f.netCash,tmoney),
    row('revenue',f.revenue,tmoney), row('net income',f.netIncome,tmoney),
    row('diluted eps',f.eps,(v)=>'$'+(+v).toFixed(2)), row('shares out',f.shares,tcount) ];
  return `<span class="tp-hd">${tesc(d.ticker)} fundamentals</span>${x.name?` <span class="tp-trans">\u00b7 ${tesc(x.name)}</span>`:''}\n${lines.join('\n')}\n<span class="tp-trans">source: ${tesc(d.src||'SEC EDGAR')}${x.asOf?` \u00b7 latest filing data through ${tesc(String(x.asOf))}`:''} \u00b7 filed figures only \u2014 an em-dash means the filer never tagged that concept</span>`; }
function termEtfCard(d){
  if(!d||!d.ok) return `<span class="sec">${tesc((d&&d.error)||'holdings unavailable')}</span>`;
  const x=d.data||{}, hs=Array.isArray(x.holdings)?x.holdings:[];
  const rows=hs.map((h,i)=>`<span class="tp-trans">${tpad(String(i+1),3)}</span> ${tpad(h.pct!=null?h.pct.toFixed(2)+'%':'\u2014',8,true)}  ${tesc(h.name||'\u2014')}`).join('\n');
  return `<span class="tp-hd">${tesc(d.symbol)} holdings</span>${x.seriesName?` <span class="tp-trans">\u00b7 ${tesc(x.seriesName)}</span>`:''}\n<span class="tp-th">${tpad('#',3)} ${tpad('% NAV',8,true)}  NAME</span>\n${rows||'<span class="sec">no holdings parsed</span>'}\n<span class="tp-trans">${x.n?`top ${Math.min(hs.length,x.n)} of ${x.n} positions`:''}${x.totAssets?` \u00b7 total assets ${tmoney(x.totAssets)}`:''}${x.asOf?` \u00b7 as of ${tesc(String(x.asOf))}`:''} \u00b7 ${tesc(d.lag||'source: SEC EDGAR N-PORT')}</span>`; }
async function termFund(t){ const T=String(t||'').toUpperCase(); if(!T) return termErr('usage: fund <ticker>');
  const think=termThinking(); try{ const d=await fetchJSON('/api/fund/'+encodeURIComponent(T)); think.remove(); termOut(termFundCard(d)); }
  catch(_){ think.remove(); termErr('fundamentals fetch failed \u2014 try again in a moment'); } }
async function termEtf(t){ const T=String(t||'').toUpperCase(); if(!T) return termErr('usage: etf <symbol>');
  const think=termThinking(); try{ const d=await fetchJSON('/api/etf/'+encodeURIComponent(T)); think.remove(); termOut(termEtfCard(d)); }
  catch(_){ think.remove(); termErr('holdings fetch failed \u2014 try again in a moment'); } }
function termCompare(a,b){ termHi(a.coin);
  const F=['price','d1','d7','funding','fundpct','squeeze','momentum','vstape','oi','vol','beta','dd'];
  const cell=(r,k)=>{ const f=TFIELD[k], v=f.g(r); return v==null||!isFinite(v)?'—':f.f(v); };
  const lines=F.map(k=>`<span class="tp-k">${tpad(TFIELD[k].l,12)}</span> ${tpad(cell(a,k),12,true)} ${tpad(cell(b,k),12,true)}`).join('\n');
  termOut(`<span class="tp-hd">compare</span>\n<span class="tp-th">${tpad('',12)} <span role="button" tabindex="0" class="tp-deep" data-tcmd="${tesc(a.ticker)}">${tpad(tesc(a.ticker),12,true)}</span> <span role="button" tabindex="0" class="tp-deep" data-tcmd="${tesc(b.ticker)}">${tpad(tesc(b.ticker),12,true)}</span></span>\n${lines}\n<span class="tp-trans">every number is the live board's — same rows the table renders</span>`); }

// ---- Tier 2: local NL → grammar (no AI). Returns null when it genuinely can't map the
//      question, so termRun escalates to the AI instead of faking a degenerate answer.
// Ticker guard — the confident-but-wrong killer. A lowercase English word inside a sentence
// ("on", "all", "it", "now", "key") is NEVER treated as a ticker: only $SYM, CAPS, non-English
// tokens, or a single-word query count. "what's on the tape" is a question, not a request for
// the ON Semiconductor card. Blocked-but-real tickers escalate to the AI planner, which sees
// the ticker roster — an escalation over a wrong answer, never the reverse.
const TSTOP=new Set(('a an the and or but nor if then than so not no yes is are was were be been being am do does did done '
 +'can could may might must will would should shall has have had it its this that these those there here where when what '
 +'who whom whose why how which while all any some few many much more most less least lot lots one two three four five ten '
 +'on in at by to of for from with within without about into onto over under up down out off vs via per as like unlike just '
 +'very too also only even still yet again ever never always often now new old good bad best worst better worse big small '
 +'high low higher lower long short buy sell hold sold bought me my mine we us our ours you your yours they them their theirs '
 +'he him his she her hers i today tonight tomorrow yesterday week weeks month months year years day days hour hours '
 +'open opens close closes closed gap news report reports reporting earnings signal signals screen help clear top bottom show tell give find '
 +'list price prices market markets tape trend chart charts sector sectors name names stock stocks coin coins crypto going doing look looks '
 +'looking anything something nothing everything anyone whats hows near far above below between against relative move moves moved '
 +'moving trading trade trades pull pulling right left back next last first great really pretty kind sort bit around since until '
 +'because want wants need needs think thinks say says get gets got make makes let lets see sees seen watch keep keeps deep dive '
 +'read take takes came come comes went gone strong weak strength weakness active fresh stale live real time '
 +'key well met cat run runs play plays main fast slow pay pays paid peak edge camp mind cost costs care love '
 +'nice cool huge tiny wild flat side ride rose fell hit hits miss level levels').split(/\s+/));
function termTickerish(w,only){ let c=String(w||'').replace(/[?!.,:;()'"]+$/,'').replace(/^[?!.,:;()'"]+/,'');
  if(!c) return false;
  if(c[0]==='$') return true;                                         // $SYM is always intentional
  if(/[a-z]/.test(c)&&/[A-Z]/.test(c)) return false;                  // Mixed case is a word, not a symbol
  if(c===c.toUpperCase()&&/^[A-Z][A-Z0-9]{0,7}$/.test(c)) return true;   // typed in CAPS → intentional
  if(only) return true;                                               // the whole query IS this token
  return !TSTOP.has(c.toLowerCase());                                 // lowercase in a sentence: only non-English tokens
}
function nlTickers(rawWords){ const out=[], seen=new Set(), used=new Set(), only=rawWords.length===1;
  for(const w of rawWords){
    const c=w.replace(/^[$]/,'').replace(/[?!.,:;()'"]+$/,'');
    let ps=c.replace(/['\u2019]s$/,'');          // NVDA's → NVDA
    if(ps===c){ const m=c.match(/^(\$?[A-Z][A-Z0-9]+)s$/); if(m) ps=m[1]; }   // NVDAs → NVDA (caps body + bare s)
    let r=null;
    for(const cand of (ps!==c&&ps.length>=2?[c,ps]:[c])){
      const probe=(w[0]==='$'?'$':'')+cand;      // keep $-intent through the guard
      if(!termTickerish(probe,only)) continue;
      r=termFind(cand); if(r) break; }
    if(r&&!seen.has(r.coin)){ seen.add(r.coin); out.push(r); used.add(w.toLowerCase()); } }
  return {rs:out, used}; }
const TWINDOWS=[[/\b(this |past |last )?week(ly)?\b|\b7 ?days?\b/,'d7'],[/\b(this |past |last )?month(ly)?\b|\b30 ?days?\b/,'d30'],
  [/\b(past|last) hour\b|\b1 ?hour\b/,'h1'],[/\b4 ?hours?\b|\b4h\b/,'h4'],[/\btoday\b|\b24 ?h(ours?)?\b|\bdaily\b/,'d1']];
function termWin(s){ for(const [re,k] of TWINDOWS) if(re.test(s)) return k; return null; }
function nlResolve(text){ const rawWords=text.split(/\s+/); const s=' '+text.toLowerCase().replace(/[?!.,]/g,' ').replace(/\s+/g,' ').trim()+' ';
  const nt=nlTickers(rawWords); const found=nt.rs; const tk=found.length?found[0].ticker:null;
  const win=termWin(s); const n=(s.match(/\b(\d{1,3})\b/)||[])[1];
  if(/\b13 ?fs?\b/.test(s)&&/\b(season|summary|quarter|consensus)\b/.test(s)) return 'whale season';
  if((/\b13 ?fs?\b/.test(s)||/\bwhales?\b/.test(s))&&!tk) return 'whale';   // "show me the 13fs" — the watchlist; a named fund is the planner's job (it sees context.whales)
  if(/\b(help|how do i|what can|commands)\b/.test(s)) return 'help';
  if(/\b(clear|reset|wipe)\b/.test(s)) return 'clear';
  // Causal / explanatory intent -> the analyst, ALWAYS. "why is DRAM dumping so much today"
  // contains a ticker and the word "today", and the field scan below happily turned that into a
  // bare `DRAM d1` card — a "why" answered with a number, which is the exact ticker-degradation
  // failure the escalation contract forbids. A ticker inside a causal question is context for the
  // AI, never the answer. Runs before every local mapping; mirrored server-side in classifyAsk.
  if(/\bwhy\b|\bhow come\b|\bcaus(e|es|ed|ing)\b|\bexplain\b|\breasons?\b|\bdriving\b|\bwhat happened\b|\bgoing on\b|\bbehind (the|this|its)\b/.test(s)) return null;
  // ---- external filed data (SEC) ----
  // "balance sheet of X" / "what's inside QQQ" are pull-through commands, not board lenses —
  // they map locally so a plain-English ask never burns AI budget on something the grammar owns.
  if(/\b(balance sheet|fundamentals?|financials|income statement|debt load|cash position|net income|shares outstanding)\b/.test(s)&&tk) return 'fund '+tk;
  if(/\b(holdings?|composition|constituents|top holdings|made up of|what'?s inside|whats inside)\b/.test(s)){
    const sym=tk||rawWords.map(x=>x.replace(/[?!.,]/g,'')).find(x=>/^[A-Z]{2,6}$/.test(x)&&x===x.toUpperCase());
    if(sym) return 'etf '+sym; }
  // ---- whole-board questions (no ticker needed) ----
  if(/\bbreadth\b/.test(s)||/\b(hows?|how is|how are|how does|whats) the (market|tape|board)\b/.test(s)
    ||/\b(market|tape) (doing|look|looking|today)\b/.test(s)||/\bhow many (names? )?(are )?(up|down|green|red)\b/.test(s)
    ||/\bis the (tape|market) (red|green|up|down)\b/.test(s)) return 'breadth'+(win?' '+win:'');
  if(!tk&&/\bsectors?\b/.test(s)&&/\b(best|worst|leading|lagging|strongest|weakest|top|performance|performing|doing|which|hows?|moving|move)\b/.test(s)) return 'sectors'+(win?' '+win:'');
  if(!tk&&/\b(who|any(one|body|thing)?|what|which)\b/.test(s)&&/\b(reports?|reported|reporting|earnings)\b/.test(s)){
    if(/\btomorrow\b/.test(s)) return 'earnings tomorrow';
    if(/\b(reported|recent|just|recap|results)\b/.test(s)) return 'earnings recent';
    if(/\b(week|upcoming|next|soon|coming)\b/.test(s)) return 'earnings week';
    return 'earnings today'; }
  if(!tk&&/\bearnings (calendar|schedule|list)\b/.test(s)) return 'earnings week';
  if(!tk&&/\b(news|headlines?)\b/.test(s)) return 'news'+(n?' '+n:'');
  if(!tk&&/\breports?\b/.test(s)&&/\b(latest|recent|new|ai|feed|list)\b/.test(s)) return 'reports';
  // ---- positioning screens in trader phrasing ----
  if(/\b(crowded short|short squeeze|squeeze candidate|squeeze setup|coiled)/.test(s)) return 'screen funding<0 & squeeze>50';
  if(/\b(crowded long|overheat|euphori|longs paying)/.test(s)) return 'screen fundpct>85';
  if(/\b(paid to (be )?short|positive carry|get paid)/.test(s)) return 'screen carry>0.3';
  if(!tk&&/\b(near (its |their )?high|at (the )?high|breaking out|breakout)/.test(s)) return 'screen dd>-3';
  if(!tk&&/\b(oversold|beaten down|near (its |their )?low|washed out|dumped)/.test(s)) return 'screen dd<-25';
  if(/\b(rising oi|building oi|adding oi|oi building|new money)/.test(s)) return 'screen doi>3';
  if(/\b(most|heavily) shorted\b|\bbiggest shorts\b/.test(s)) return 'bottom funding';
  { const ma=s.match(/\b(above|below|over|under) (their |the |its )?(20|50|100|200) ?d?ma\b/)||s.match(/\b(above|below|over|under) (their |the |its )?ma ?(20|50|100|200)\b/);
    if(ma){ const nn=ma[3]; if(tk) return tk+' vsma'+nn; return 'screen vsma'+nn+((ma[1]==='above'||ma[1]==='over')?'>0':'<0'); } }
  if(/\b(above|over) (the |their |its )?vwap\b/.test(s)) return tk?tk+' vsvwap':'screen vsvwap>0';
  if(/\b(below|under) (the |their |its )?vwap\b/.test(s)) return tk?tk+' vsvwap':'screen vsvwap<0';
  if(!tk&&(/\b(unusual|elevated|abnormal|heavy) volume\b/.test(s)||/\bvolume spike\b/.test(s))) return 'screen rvol>2';
  if(!tk&&/\bgap(ped|ping)? up\b/.test(s)) return 'screen gap>1';
  if(!tk&&/\bgap(ped|ping)? down\b/.test(s)) return 'screen gap<-1';
  // ---- superlatives → top/bottom over ANY live field, window-aware ----
  if(/\b(top|most|highest|biggest|largest|best|worst|lowest|least|smallest|bottom|leading|hottest?)\b/.test(s)||/\b(gainers?|losers?|movers?|trending)\b/.test(s)){
    const asc=/\b(lowest|least|smallest|bottom)\b/.test(s);
    for(const w of rawWords){ const m=metricOf(w); if(m){
      if((m==='gainers'||m==='losers')&&win&&win!=='d1') return (m==='losers'?'bottom ':'top ')+win+(n?' '+n:'');
      return (asc&&m!=='losers'&&m!=='gainers'?'bottom ':'top ')+m+(n?' '+n:''); } }
    for(const w of rawWords){ if(nt.used.has(w.toLowerCase())) continue; const f=tfield(w); if(f&&f!=='price') return (asc?'bottom ':'top ')+f+(n?' '+n:''); }
    if(win) return (asc?'bottom ':'top ')+win+(n?' '+n:'');
  }
  if(/\b(signal|firing|setup|whats active|anything active)/.test(s)||(/\bwhats up\b/.test(s)&&rawWords.length<=3)) return 'signals'+(tk?' '+tk:'');
  // ---- two names → local side-by-side (a plain field compare never needs the AI) ----
  if(found.length>=2&&/\b(vs|versus|against|compare|compared|or)\b/.test(s)) return 'vs '+found[0].ticker+' '+found[1].ticker;
  if(found.length===2&&rawWords.length<=3) return 'vs '+found[0].ticker+' '+found[1].ticker;
  if(tk){
    if(/\b(news|headlines?)\b/.test(s)) return 'news '+tk;
    if(/\b(earnings?|announc)/.test(s)||/when.*(report|earnings)/.test(s)) return 'earnings '+tk;
    if(/\b(report|analysis|analyst|deep dive|read on)/.test(s)) return 'report '+tk;
    if(/\b(diverg|decoupl|correlated|moving with|moves with|vs its group|vs the group|vs sector|relative to)/.test(s)) return 'diverge '+tk;
    { // "yearly open" / "monthly open" — the level; "above/vs/since the year open" — the distance.
      // Must run BEFORE the single-word field scan: "monthly" alone aliases to d30.
      const yo=/\b(year(ly|'?s)?|annual)\s+open(ing)?\b/.test(s), mo=/\bmonth(ly|'?s)?\s+open(ing)?\b/.test(s);
      if(yo||mo){ const dist=/\b(above|below|over|under|vs|versus|from|since|off|against|relative)\b/.test(s);
        return tk+' '+(dist?(yo?'vsyopen':'vsmopen'):(yo?'yopen':'mopen')); } }
    for(const w of rawWords){ if(nt.used.has(w.toLowerCase())) continue; const fk=tfield(w); if(fk) return tk+' '+fk; }   // explicit field word
    if(/\b(moving average|\bma\b|sma|ema|vwap)/.test(s)){ if(/vwap/.test(s)) return tk+' vwap'; const nn=(s.match(/\b(20|50|100|200)\b/)||[])[1]; return nn?tk+' ma'+nn:null; }
    if(/\bfunding\b|\brate\b/.test(s)) return tk+' funding'; if(/\b(oi|open interest)\b/.test(s)) return tk+' oi';
    if(/\bsqueeze\b/.test(s)) return tk+' squeeze'; if(/\bmomentum\b/.test(s)) return tk+' momentum';
    if(/\b(sector|industry|group)\b/.test(s)) return tk+' sector';
    if(/\b(ytd|year to date)\b/.test(s)) return tk+' vsyopen'; if(/\b(mtd|month to date)\b/.test(s)) return tk+' vsmopen';
    if(/\b(off|from|below) (its |the )?(30d |monthly )?high\b/.test(s)) return tk+' dd';
    if(win&&/\b(do|doing|done|did|perform|performed|performance|move|moved|hold|holding|chang)/.test(s)) return tk+' '+win;
    if(win&&rawWords.length<=4) return tk+' '+win;
    if(rawWords.length<=1||/\b(price|quote|how is|hows|what is|whats|show|chart|pull up)\b/.test(s)) return tk;   // near-bare -> card
    return null;   // a ticker plus intent we don't understand -> let the AI try, never fake a card
  }
  return null; }

// ---- resolution / routing ----
// Only treat input as a direct command when it's an UNAMBIGUOUSLY COMPLETE, valid one. A grammar
// head with junk args ("top 5 trending stocks", "nvda earnings") is NOT complete, so it falls
// through to the NL layer and then the AI — never erroring or degrading to a bare card.
function termGrammarComplete(p){ const head=p[0].toLowerCase(), r=termFind(p[0]);
  if(r) return p.length===1 || tfield(p[1])!=null || (p[1]||'').toLowerCase()==='sector';   // <TICKER> alone, or <TICKER> <real field>
  if(head==='top'||head==='bottom') return p.slice(1).some(x=>metricOf(x)!=null||tfield(x)!=null);
  if(head==='screen'||head==='scr') return p.length>1 && /[<>=]/.test(p.join(' '));
  if(head==='signals'||head==='sig'||head==='help'||head==='clear'||head==='stocks'||head==='crypto'
    ||head==='breadth'||head==='sectors'||head==='news'||head==='reports') return true;
  if(head==='earnings'||head==='earn') return p.length===1||!!termFind(p[1])||['today','tomorrow','week','recent','backfill'].includes((p[1]||'').toLowerCase());
  if(head==='vs'||head==='compare') return !!(termFind(p[1])&&termFind(p[2]));
  if(head==='comp') return p.slice(1).filter(x=>termFind(x)||isBasketName(x)).length>=2;
  if(head==='report'||head==='ai'||head==='corr'||head==='diverge') return !!termFind(p[1]);
  if(head==='fund'||head==='bs'||head==='balance'||head==='etf'||head==='holdings') return !!p[1];   // symbols may live outside the universe (ETFs)
  if(head==='whale'||head==='13f') return true;   // bare = watchlist; args validate server-side against the live list
  if(head==='congress') return true;   // bare = status; the verb itself validates admin server-side
  if(head==='insiders'||head==='form4') return true;   // bare = status; the verbs validate admin server-side
  // `holds X` is always the holder query; bare `who X` only when X is a listed name, so the
  // phrasebook still gets "who reports tomorrow" (it went to a 13F search for "reports tomorrow").
  if(head==='holds') return !!p[1];
  if(head==='who') return p.length===2&&!!termFind(p[1]);
  if(head==='basket') return ['create','list','drop'].includes((p[1]||'').toLowerCase());
  if(head==='ratio') return p.length>=2;
  return false; }
function termExec(cmdStr){ const p=cmdStr.trim().split(/\s+/), h=p[0].toLowerCase(), T=p[0].toUpperCase();
  if(h==='stocks'||h==='crypto'){ const b=document.querySelector('.scope[data-scope="'+h+'"]'); if(b) b.click(); termOut(`<span class="sec">scope →</span> <span class="amber">${h}</span>`); return; }
  if(h==='clear'){ termEl('termScroll').innerHTML=''; return; }
  if(h==='help'||h==='?') return termHelp();
  if(h==='top'||h==='bottom'){ const rest=p.slice(1); const n=rest.map(x=>/^\d+$/.test(x)?+x:null).find(x=>x!=null); const metric=rest.find(x=>metricOf(x)||tfield(x)); return termTop(metric||(rest[0]||''), n, h==='bottom'); }
  if(h==='screen'||h==='scr') return termScreen(p.slice(1).join(' '));
  if(h==='signals'||h==='sig'){ const t=p[1]?p[1].toUpperCase():null; return termSignals(t); }
  if(h==='breadth') return termBreadth(tfield(p[1])||'d1');
  if(h==='sectors') return termSectors(tfield(p[1])||'d1');
  if(h==='news'){ const rr=termFind(p[1]); const nn=p.slice(1).map(x=>/^\d+$/.test(x)?+x:null).find(x=>x!=null); return termNewsCmd(rr?rr.ticker.toUpperCase():null,nn); }
  if(h==='reports') return termReports();
  if(h==='fund'||h==='bs'||h==='balance') return termFund(p[1]);
  if(h==='whale'||h==='13f') return termWhale(p.slice(1));
  if(h==='congress') return termCongress(p.slice(1));
  if(h==='insiders'||h==='form4') return termInsiders(p.slice(1));
  if(h==='holds'||h==='who') return termWhale(['who'].concat(p.slice(1)));
  if(h==='etf'||h==='holdings') return termEtf(p[1]);
  if(h==='vs'||h==='compare'){ const a=termFind(p[1]), b=termFind(p[2]); return (a&&b)?termCompare(a,b):termErr('usage: vs <a> <b>'); }
  if(h==='comp'){ const cr=state.scope==='crypto';
    const tks=[...new Set(p.slice(1).map(x=>{ const r=termFind(x); if(r) return (r.ticker||'').toUpperCase();
      const b=basketByName(x); return (b&&(b.scope==='crypto')===cr)?b.name:null; }).filter(Boolean))];
    return tks.length>=2?termComp(tks):termErr('usage: comp <ticker|basket> <ticker|basket> [more…] — needs at least two'); }
  if(h==='basket') return termBasket(p.slice(1));
  if(h==='ratio') return termRatio(p.slice(1));
  if(h==='report'||h==='ai'){ const rr=termFind(p[1])||termFind(p[0]); return rr?termReport(rr):termErr('usage: report <ticker>'); }
  if(h==='earnings'||h==='earn'){ const a1=(p[1]||'').toLowerCase();
    if(a1==='backfill') return termEarnBackfill(p.slice(2));
    if(!p[1]||['today','tomorrow','week','recent'].includes(a1)) return termEarnCal(a1||'today');
    const rr=termFind(p[1]); return rr?termEarnings(rr):termErr('usage: earnings [ticker | today | tomorrow | week | recent | backfill [days]]'); }
  if(h==='corr') return termCorr(p[1],p[2]);
  if(h==='diverge'){ const r=termFind(p[1]); return r?termDiverge(r):termErr('usage: diverge <ticker>'); }
  const r=termFind(T); if(r){ if(p[1]) return termFieldCmd(r,p[1]); return termCard(r); }
  const TERM_VERBS=['top','bottom','screen','breadth','sectors','earnings','news','vs','comp','basket','report','drawer','help','clear','history','watch','notes','ask','whale','admin'];
  const lev=(a,b)=>{ a=a.toLowerCase(); b=b.toLowerCase(); const d=[]; for(let i=0;i<=a.length;i++){ d[i]=[i]; } for(let j=1;j<=b.length;j++) d[0][j]=j;
    for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++) d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1)); return d[a.length][b.length]; };
  const w=String(h).split(/\s+/)[0]||''; const near=TERM_VERBS.filter(v=>w&&lev(w,v)<=2&&v!==w).sort((x,y)=>lev(w,x)-lev(w,y))[0];
  termErr(`unknown "${tesc(h)}"`+(near?` — did you mean <span class="tp-deep" data-tcmd="${tesc(String(h).replace(w,near))}">${tesc(String(h).replace(w,near))}</span>?`:' — type help')); }
// ---- basket / ratio verbs (build 2026.07.28-06) ----
async function termBasket(args){
  const sub=(args[0]||'').toLowerCase();
  if(!featureOn('baskets')) return termErr('baskets are not enabled for this view');
  if(sub==='list'){
    if(!BASKETS.list.length) await loadBaskets(true);
    if(!BASKETS.list.length) return termOut('no baskets yet — <span class="ex" data-tcmd="basket create MAG7 AAPL MSFT GOOGL AMZN NVDA META TSLA">basket create MAG7 AAPL MSFT …</span>');
    const cr=state.scope==='crypto';
    const scoped=BASKETS.list.filter(b=>(b.scope==='crypto')===cr);
    const line=b=>`<span class="amber">\u2b12 ${tesc(b.name)}</span> <span class="sec">${b.label?tesc(b.label)+' · ':''}${b.members.length} members · EW · ${b.cov?b.cov.n+'/'+b.cov.N:'—'} · ${tesc(b.members.slice(0,8).join(' '))}${b.members.length>8?' …':''}</span>`;
    const own=scoped.filter(b=>!b.shadow), sect=scoped.filter(b=>b.shadow&&b.kind==='sector'), ind=scoped.filter(b=>b.shadow&&b.kind==='industry');
    const blk=[];
    if(own.length) blk.push('<span class="sec">— yours + built-in —</span><br>'+own.map(line).join('<br>'));
    if(sect.length) blk.push('<span class="sec">— sectors (shadow · usable in comp / ratio) —</span><br>'+sect.map(line).join('<br>'));
    if(ind.length) blk.push('<span class="sec">— industries (shadow · usable in comp / ratio) —</span><br>'+ind.map(line).join('<br>'));
    return termOut(blk.join('<br><br>')); }
  if(sub==='create'){
    const name=args[1], members=args.slice(2);
    if(!name||members.length<2) return termErr('usage: basket create <NAME> <ticker> <ticker> …');
    const d=await basketMutate({name, members});
    if(d&&d.ok){ await loadBaskets(true);
      const where=IS_ADMIN?'saved on the server':'stored in <b>this browser only</b>';
      return termOut(`✓ basket <b class="amber">\u2b12 ${tesc(d.basket.name)}</b> created · ${d.basket.scope} · ${d.basket.members.length} members · EW daily-rebalanced · ${where} · available in COMP/G, RATIO and the picker`); }
    return termErr((d&&d.error)||'create failed'); }
  if(sub==='drop'){
    const name=args[1]; if(!name) return termErr('usage: basket drop <NAME>');
    const d=await basketMutate({name, drop:true});
    if(d&&d.ok){ await loadBaskets(true);
      return termOut(`✓ <b>${tesc(d.name)}</b> removed — charts fall back gracefully; baskets never enter signal math, so there is no ledger to unwind`); }
    return termErr((d&&d.error)||'drop failed'); }
  return termErr('usage: basket create <NAME> <members…> · basket list · basket drop <NAME>');
}
function termRatio(args){
  let a=args[0]||'', b=args[1]||'', tf=args[2];
  if(a.includes('/')){ const s=a.split('/'); a=s[0]; b=s[1]; tf=args[1]; }
  if(!a||!b) return termErr('usage: ratio <A>/<B> [1h|4h|12h|1d] — legs are listed names or baskets');
  tf=(tf||RATIO.tf||'4h').toLowerCase();
  if(!['1h','4h','12h','1d'].includes(tf)) return termErr('tf must be 1h · 4h · 12h · 1d');
  if(!featureOn('baskets')) return termErr('the ratio chart is not enabled for this view');
  showView('corr');
  openRatio(a,b,tf);
  return termOut(`✓ RATIO — <b>${tesc(a.toUpperCase())} ÷ ${tesc(b.toUpperCase())}</b> · ${tf.toUpperCase()} candles bucketed from hourly ratio closes · on the Correlation tab`);
}
// Tier 3 — AI fallback. The local layers couldn't resolve it, so escalate to /api/ask. Planner
// (which/what) returns a grammar query the CLIENT runs → numbers stay the board's; analyst
// (why/what-if) returns grounded prose over the compact bundle we send. Auto-routed by shape.
function termCompactUniverse(){ const rnd=v=>(v==null||!isFinite(v))?null:+v.toFixed(2);
  // The analyst only knows what this row carries — a field missing here IS "not in the data".
  // Ship every board metric (short keys; nulls dropped to keep the payload lean).
  return termActive().slice(0,160).map(r=>{ const o={ t:r.ticker, px:rnd(r.px), d1:rnd(r.d1), f:rnd(termAprOf(r)),
    fp:r.fundPct, sqz:r.sqz!=null?Math.round(r.sqz):null, mom:r.mom!=null?Math.round(r.mom):null,
    vs:rnd(r.vstape), oi:r.oi!=null?Math.round(r.oi):null, vol:r.vol!=null?Math.round(r.vol):null,
    doi:rnd(r.doi), beta:(r.beta!=null&&isFinite(r.beta))?+r.beta.toFixed(2):null, dd:rnd(r.dd), sector:r.sector||null,
    h1:rnd(r.h1), h4:rnd(r.h4), d7:rnd(r.d7), d30:rnd(r.d30), gap:rnd(r.gap), pr:rnd(r.prem),
    rv:rnd(r.rvol), adr:rnd(r.adr), v30:rnd(r.vol30), rs:rnd(r.rs), hitr:rnd(r.hitr), ddy:rnd(r.ddy),
    yo:rnd(r.yopen), mo:rnd(r.mopen), m20:rnd(r.ma20), m50:rnd(r.ma50), m100:rnd(r.ma100), m200:rnd(r.ma200),
    vw:rnd(r.vsvwap) };
    for(const k in o){ if(o[k]==null) delete o[k]; } return o; }); }
function termThinking(){ const d=document.createElement('div'); d.className='tp-blk';
  d.innerHTML=`<span class="tp-badge ai">AI</span> <span class="tp-line"><span class="amber tp-think">thinking…</span></span>`;
  // Under a chat sink the placeholder is never shown (the composer has its own "running…" line)
  // and never collected: a detached node's .remove() is a no-op, so callers need no branch.
  if(_termSink) return d;
  termEl('termScroll').appendChild(d); termScrollDown(); return d; }
// Session transcript. Statelessness made the AI blind to its own conversation — "not what I
// asked" arrived alone and the analyst could only shrug at four words. Every exchange (local OR
// AI: a complaint is usually about a LOCAL answer) is recorded and the tail rides every /api/ask,
// so follow-ups resolve against what was actually said. Session-scoped, never persisted.
let _termHist=[];
function termHistPush(q,a){ _termHist.push({q:String(q||'').slice(0,300), a:String(a||'').slice(0,500)}); if(_termHist.length>8) _termHist.shift(); }
function termCausal(text){ return /\bwhy\b|\bhow come\b|\bcaus(e|es|ed|ing)\b|\bexplain\b|\breasons?\b|\bdriving\b|\bwhat happened\b|\bgoing on\b|\bbehind (the|this|its)\b/i.test(text)
  || /^\s*(what if|what would|what happens|should i|do you think|is it|are they|which is better|compare|walk me)\b/i.test(text); }
async function termAsk(text){
  // Inside a chat capture the AI leg is a separate switch (dm.ask, admin by default): a verb that
  // would escalate on its own — an unknown lens, a question the grammar can't parse — stops HERE
  // with a plain answer rather than spending budget on a reply the composer may not post.
  if(_termSink&&!_termSink.ai) return termErr('AI answers are admin-only in chat on this deployment — /help lists what runs here, or ask in the terminal (~)');
  const mode=termCausal(text)?'analyst':'planner';
  const uni=termCompactUniverse(); const think=termThinking();
  try{
    const ctx={scope:state.scope, mode, universe:uni, hist:_termHist.slice(-6)};
    if(_termSink) ctx.via='dm';   // the server applies dm.ask on top of ai.ask for an answer bound for a conversation
    const r=await fetch('/api/ask',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({q:text, ctx})});
    const d=await r.json().catch(()=>({})); think.remove();
    if(d&&d.askDayLeft!=null) renderAskBudget(d.askDayLeft, d.askPerDay);   // reflect the spend immediately
    // Inside a chat capture these are NOTICES, not answers: an "AI isn't enabled" line posted
    // under somebody's name with an AI badge is a message nobody sent. Private in chat.
    if(d&&d.disabled) return _termSink?termErr("the AI fallback isn't enabled on the server (no API key set)")
      :termOutAI(`the AI fallback isn't enabled on the server yet <span class="tp-trans">(no API key set)</span>. The local engine handles most questions — try a ticker, <span class="ex" data-tcmd="top funding">top funding</span>, or <span class="ex" data-tcmd="help">help</span>.`);
    if(!d||!d.ok){ if(d&&d.error==='rate') return _termSink?termErr(`busy — the shared AI limit is maxed for a moment (retry in ${Math.ceil((d.retryMs||3000)/1000)}s)`)
        :termOutAI(`busy — the shared AI limit is maxed for a moment <span class="tp-trans">(retry in ${Math.ceil((d.retryMs||3000)/1000)}s)</span>.`);
      if(d&&d.error==='feature-gated') return termErr(d.feature==='dm.ask'?'AI answers are admin-only in chat on this deployment':'the AI fallback is not enabled for this view');
      if(_termSink&&(d&&(d.error==='ask-user-cap'||d.error==='ask-daily-cap'))) return termErr(d.error==='ask-user-cap'?`your daily AI limit is reached — ${d.askUserPerDay||5}/${d.askUserPerDay||5} of your ask calls used today, resets at midnight UTC`:`the shared daily AI pool is exhausted — resets at midnight UTC`);
      if(d&&d.error==='ask-user-cap') return termOutAI(`your daily AI limit is reached — <span class="tp-err">${d.askUserPerDay||5}/${d.askUserPerDay||5}</span> of your ask calls used today, resets at midnight UTC. Local commands still work: try a ticker, <span class="ex" data-tcmd="top funding">top funding</span>, or <span class="ex" data-tcmd="screen">screen</span>.`);
      if(d&&d.error==='ask-daily-cap') return termOutAI(`the shared daily AI pool is exhausted — <span class="tp-err">${d.askPerDay||0}/${d.askPerDay||0}</span> ask calls used across all users today, resets at midnight UTC. Local commands still work: try a ticker, <span class="ex" data-tcmd="top funding">top funding</span>, or <span class="ex" data-tcmd="screen">screen</span>.`);
      return termErr(`couldn't resolve that — ${tesc((d&&d.error)||'error')}`); }
    if(d.mode==='planner'&&d.query){
      // A chat capture's allowlist applies to what the AI PLANS too: "compare nvda and amd" could
      // plan `comp NVDA AMD`, which opens the chart view — from the panel that is the answer, from
      // a conversation it would navigate the sender away mid-chat. The sink says what may run.
      if(_termSink&&_termSink.check){ const why=_termSink.check(d.query); if(why) return termErr('planned → '+d.query+' — '+why); }
      termHistPush(text,'→ '+d.query); termOutAI(`<span class="tp-trans">planned → ${tesc(d.query)}</span>`); return termExec(d.query); }   // AI planned, client computes
    if(d.mode==='analyst'){ termHistPush(text,d.answer||'');
      const tail=d.admin?' · <span class="tp-trans">admin — unlimited</span>'
        :d.askUserDayLeft!=null?` · <span style="color:${d.askUserDayLeft<=1?'var(--accent)':'var(--faint)'}">${d.askUserDayLeft} of ${d.askUserPerDay} of your ask calls left today</span>`
        :d.askDayLeft!=null?` · <span style="color:${d.askDayLeft<=Math.max(1,(d.askPerDay||50)*0.25)?'var(--accent)':'var(--faint)'}">${d.askDayLeft} ask ${d.askDayLeft===1?'call':'calls'} left today</span>`:''; return termOutAI(`${tesc(d.answer||'').replace(/\n/g,'<br>')}\n<span class="tp-trans">— reasoned over ${d.marketsN||uni.length} live markets · ${tesc(d.model||'ai')}${d.cached?' · cached':''}${tail}</span>`); }
    return termErr('empty response');
  }catch(e){ think.remove(); termErr('ask failed — '+tesc(e.message)); }
}
function termRun(raw){ const line=raw.trim(); if(!line) return;
  // One sink at a time: while a chat command is collecting output, a panel command would land in
  // that conversation. Written straight to the panel — termErr itself would go to the sink.
  if(_termSink){ const d=document.createElement('div'); d.className='tp-blk'; d.innerHTML='<span class="tp-line tp-err">✗ a chat command is still running — try again in a moment</span>'; termEl('termScroll').appendChild(d); termScrollDown(); return; }
  // Admin command — intercepted BEFORE the echo (so the password renders redacted, never
  // sitting in scrollback) and before any tier can touch it: the password goes to
  // /api/ai-reset and nowhere else — it can never escalate to /api/ask.
  const aun=line.match(/^admin\s+unlock(?:\s+(\S+))?\s*$/i);
  if(aun){ termEcho('admin unlock'+(aun[1]?' ••••••':''));
    if(!aun[1]) return termErr('usage: admin unlock <password>');
    return termAdminUnlock(aun[1]); }
  const alk=line.match(/^admin\s+lock\s*$/i);
  if(alk){ termEcho('admin lock'); return termAdminLock(); }
  const adm=line.match(/^admin\s+reset-reports(?:\s+(\S+))?\s*$/i);
  if(adm){ termEcho('admin reset-reports'+(adm[1]?' ••••••':''));
    if(!adm[1]) return termErr('usage: admin reset-reports <password>');
    return termAdminReset(adm[1]); }
  const grp=line.match(/^report\s+(sector|basket)\s+(.+)$/i);
  if(grp){ termEcho(line);
    if(/^sector$/i.test(grp[1])){ const name=grp[2].trim();
      termOut(`opening sector report — <b>${tesc(name)}</b> <span class="tp-trans">(prose-tier group read; the server validates the sector name against the live universe)</span>`);
      return openAiReport('grp:sec:'+name); }
    const ts=[...new Set(grp[2].trim().toUpperCase().split(/[\s,+]+/).filter(Boolean))].sort();
    if(ts.length<2) return termErr('a basket needs at least 2 tickers — report basket NVDA AMD AVGO');
    if(ts.length>12) return termErr('basket reports cap at 12 names');
    termOut(`opening basket report — <b>${tesc(ts.join(' '))}</b>`);
    return openAiReport('grp:bkt:'+ts.join('+')); }
  termEcho(line);
  const p=line.split(/\s+/);
  if(termGrammarComplete(p)){ termHistPush(line, line); return termExec(line); }   // unambiguous, complete command — run it (no badge, you typed it)
  const nl=nlResolve(line);                            // Tier 2 — local NL intent
  if(nl){ termHistPush(line,'→ '+nl+' (computed locally)'); termOutTrans(nl); return termExec(nl); }
  return termAsk(line);                                // Tier 3 — AI fallback (stub)
}
async function termAdminReset(pw){
  try{
    const r=await fetch('/api/ai-reset',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({password:pw})});
    const d=await r.json().catch(()=>({}));
    if(d&&d.ok){ termOut(`daily report budget reset — <b class="pos">${d.dayLeft}/${d.perDay}</b> generations available today`);
      loadAiRecent(); if(state.report&&state.report.coin&&state.view==='report') loadAiReport(state.report.coin,true); return; }
    if(d&&d.error==='not-configured') return termErr('ADMIN_PASSWORD is not set on the server — add it on Railway first');
    if(d&&d.error==='rate') return termErr(`too many attempts — locked for ${Math.ceil((d.retryMs||60000)/1000)}s`);
    return termErr('wrong password');
  }catch(e){ termErr('reset failed — '+tesc(e.message)); }
}
async function termAdminUnlock(pw){
  try{
    const r=await fetch('/api/ai-unlock',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({password:pw})});
    const d=await r.json().catch(()=>({}));
    if(d&&d.ok){ termSetLock(false); const hrs=Math.round((d.ttlMs||864e5)/36e5);
      termOut(`AI unlocked for this session <span class="tp-trans">— report generation + AI answers enabled for ${hrs}h or until you close the browser</span>`); return; }
    if(d&&d.error==='not-configured') return termErr('ADMIN_PASSWORD is not set on the server — add it on Railway first');
    if(d&&d.error==='rate') return termErr(`too many attempts — locked for ${Math.ceil((d.retryMs||60000)/1000)}s`);
    return termErr('wrong password');
  }catch(e){ termErr('unlock failed — '+tesc(e.message)); }
}
async function termAdminLock(){
  try{ await fetch('/api/ai-lock',{method:'POST',headers:{accept:'application/json'}}); }catch(_){}
  termSetLock(true); termOut('AI locked <span class="tp-trans">— generation now requires admin unlock again</span>');
}
// Lock indicator in the terminal header. HttpOnly cookie is invisible to JS, so /api/ai-status is
// the source of truth for the initial paint on open; unlock/lock flip it optimistically after.
function termSetLock(locked){ const b=termEl('termLock'); if(!b) return;
  b.textContent=locked?'🔒 AI':'🔓 AI'; b.classList.toggle('open',!locked);
  b.title=locked?'AI generation is locked — run: admin unlock <password>':'AI unlocked for this session'; }
async function termRefreshLock(){ try{ const d=await fetchJSON('/api/ai-status'); const b=termEl('termLock');
  if(b) b.hidden=!(d&&d.gated); termSetLock(!(d&&d.unlocked)); }catch(_){} }
let _termSink=null;
function termEmit(d){ if(_termSink){ _termSink.blocks.push(d); return; } termEl('termScroll').appendChild(d); termScrollDown(); }
function termOut(html){ const d=document.createElement('div'); d.className='tp-blk'; d.innerHTML=`<span class="tp-badge c">computed</span> <span class="tp-line">${html}</span>`; termEmit(d); }
function termOutTrans(cmd){ const d=document.createElement('div'); d.className='tp-blk'; d.innerHTML=`<span class="tp-trans">→ ${tesc(cmd)}</span>`; termEmit(d); }
function termOutAI(html){ const d=document.createElement('div'); d.className='tp-blk'; d.innerHTML=`<span class="tp-badge ai">AI</span> <span class="tp-line">${html}</span>`; termEmit(d); }
function termEcho(c){ const d=document.createElement('div'); d.className='tp-blk'; d.innerHTML=`<div class="tp-line tp-echo"><span class="pr">▸</span> <span class="c">${tesc(c)}</span></div>`; termEmit(d); }
function termErr(m){ const d=document.createElement('div'); d.className='tp-blk'; d.innerHTML=`<span class="tp-line tp-err">✗ ${tesc(m)}</span>`; termEmit(d); }
function termScrollDown(){ const s=termEl('termScroll'); s.scrollTop=s.scrollHeight; }
function termHi(coin){ const r=state.rows.get(coin); if(!r) return; if(state.view!=='markets') return;
  const tr=document.querySelector(`#body tr[data-coin="${CSS.escape(coin)}"]`); if(tr){ tr.classList.add('rowflash'); tr.scrollIntoView({block:'center',behavior:SCROLL_B}); setTimeout(()=>tr.classList.remove('rowflash'),1500); } }
function termHelp(){ termOut(`<span class="tp-hd">ask the board</span> <span class="tp-trans">· plain English or the grammar below · every board column is a lens</span>
<span class="amber">${tpad('<ticker> [field]',20)}</span><span class="sec">card, or any column: funding·oi·squeeze·d7·rvol·gap·vsvwap·vsma200·ytd·sector·…</span>
<span class="amber">${tpad('top|bottom <field> [n]',20)}</span><span class="sec">any field, plus gainers·losers — "top d7 5", "bottom funding"</span>
<span class="amber">${tpad('screen <expr>',20)}</span><span class="sec">funding>20 &amp; squeeze>50 · vsma200>0 · rvol>2</span>
<span class="amber">${tpad('breadth · sectors',20)}</span><span class="sec">tape health · sector performance (add d7/d30 for a window)</span>
<span class="amber">${tpad('earnings [t|when]',20)}</span><span class="sec">a ticker, or today·tomorrow·week·recent</span>
<span class="amber">${tpad('news [ticker]',20)}</span><span class="sec">verified headlines · 72h window</span>
<span class="amber">${tpad('vs <a> <b>',20)}</span><span class="sec">side-by-side field compare · corr <a> <b> for correlation</span>
<span class="amber">${tpad('comp <a> <b> …',20)}</span><span class="sec">overlay N names rebased to 100 (COMP/G) · baskets welcome · index or spread mode</span>
<span class="amber">${tpad('basket create|list|drop',20)}</span><span class="sec">custom EW baskets — "basket create MAG7 AAPL MSFT …" · visual layer only</span>
<span class="amber">${tpad('ratio <a>/<b> [tf]',20)}</span><span class="sec">synthetic pair candles (1h·4h·12h·1d) with an honest EMA200 — "ratio MAG7/EWZ 4h"</span>
<span class="amber">${tpad('signals · reports',20)}</span><span class="sec">active signals · recent AI reports</span>
<span class="amber">${tpad('report <ticker>',20)}</span><span class="sec">open the AI analyst report</span>
<span class="amber">${tpad('fund <ticker>',20)}</span><span class="sec">latest SEC-filed balance sheet + income facts \u00b7 XBRL, on demand</span>
<span class="amber">${tpad('etf <symbol>',20)}</span><span class="sec">ETF/fund composition from the latest N-PORT filing (30\u201360d lag)</span>
<span class="amber">${tpad('whale [fund]',20)}</span><span class="sec">tracked 13F funds \u00b7 whale KEY = the book \u00b7 whale season = quarter summary \u00b7 add/rm/mute (admin)</span>
<span class="amber">${tpad('admin reset-reports',20)}</span><span class="sec">+ password — reset the daily report budget (echo is redacted)</span>
<span class="amber">${tpad('report sector',20)}</span><span class="sec">+ name — AI group report on a GICS sector (e.g. report sector Energy)</span>
<span class="amber">${tpad('report basket',20)}</span><span class="sec">+ tickers — AI group report on a custom basket (2-12 live equities)</span>
<span class="amber">${tpad('admin unlock',20)}</span><span class="sec">+ password — admin: unlimited AI, no caps, burns no budget (echo redacted)</span>
<span class="amber">${tpad('admin lock',20)}</span><span class="sec">re-lock AI generation now</span>
<span class="tp-trans">Or just ask: "who reports tomorrow", "best sector this week", "whats above the 200dma", "nvda vs amd", "hows the tape". Tab completes · ↑↓ history · ~ opens.</span>`); }

// ---- open / close / input ----
function termOpen(){ const p=termEl('termPanel'), fab=termEl('termFab'); if(!p) return; p.hidden=false; if(fab) fab.classList.add('hidden'); const q=termEl('termCmd'); if(q) q.focus(); updateFreshTray(); termRefreshLock();   /* refresh the ask-budget chip + AI lock state on open */ }
function termClose(){ const p=termEl('termPanel'), fab=termEl('termFab'); if(p) p.hidden=true; if(fab) fab.classList.remove('hidden'); }
function termToggle(){ const p=termEl('termPanel'); if(p&&p.hidden) termOpen(); else termClose(); }
// TERM_VERBS was referenced by the completion engine but never defined — a silent
// ReferenceError on every keystroke that killed ghost text + tab completion. Now real.
const TERM_VERBS=['top','bottom','screen','signals','earnings','news','breadth','sectors','reports','report','corr','comp','diverge','vs','compare','basket','ratio','fund','etf','whale','holds','congress','help','clear','stocks','crypto'];
const TERM_FIELDS=['funding','oi','squeeze','momentum','vstape','carry','beta','dd','vol','d7','d30','rvol','gap','vsvwap','vsma200','sector'];
function termComps(text){ const p=text.split(/\s+/), cur=(p[p.length-1]||'').toLowerCase();
  if(p.length===1) return TERM_VERBS.concat(termActive().map(r=>r.ticker.toLowerCase())).filter(x=>x.startsWith(cur));
  const h=p[0].toLowerCase();
  if(termFind(p[0])) return TERM_FIELDS.filter(f=>f.startsWith(cur)).map(f=>p.slice(0,-1).join(' ')+' '+f);
  if(h==='top'||h==='bottom') return ['vol','funding','squeeze','momentum','oi','carry','gainers','losers','d7','d30','rvol','vsvwap','gap','adr','vol30'].filter(x=>x.startsWith(cur)).map(x=>h+' '+x);
  if(h==='earnings') return ['today','tomorrow','week','recent'].concat(termActive().map(r=>r.ticker.toLowerCase())).filter(x=>x.startsWith(cur)).map(x=>'earnings '+x);
  if(h==='fund') return termActive().map(r=>r.ticker.toLowerCase()).filter(x=>x.startsWith(cur)).map(x=>'fund '+x);
  if(h==='report'||h==='signals'||h==='corr'||h==='comp'||h==='diverge'||h==='news'||h==='vs'||h==='compare') return termActive().map(r=>r.ticker.toLowerCase()).filter(x=>x.startsWith(cur)).map(x=>p.slice(0,-1).join(' ')+' '+x);
  return []; }
let termHist=[], termHi_=-1;
function termGhostFn(){ const q=termEl('termCmd'), g=termEl('termGhost'); const v=q.value; if(!v){ g.textContent=''; termHint(); return; }
  const c=termComps(v), p=v.split(/\s+/), cur=p[p.length-1].toLowerCase();
  if(c[0]){ const tail=c[0].slice(c[0].lastIndexOf(' ')+1); g.textContent=v+tail.slice(cur.length); } else g.textContent='';
  termHint(c); }
function termHint(c){ const h=termEl('termHint'), v=termEl('termCmd').value.trim();
  if(!v){ h.innerHTML=`<b>try</b> <span class="ex" data-tcmd="top funding 5">top funding 5</span> · <span class="ex" data-tcmd="most crowded shorts">most crowded shorts</span> · <span class="ex" data-tcmd="signals">signals</span> · <span class="ex" data-tcmd="help">help</span>`; return; }
  h.innerHTML=(c&&c.length)?`↹ ${c.slice(0,6).map(x=>`<span class="ex" data-tcmd="${tesc(x)}">${tesc(x.slice(x.lastIndexOf(' ')+1))}</span>`).join(' ')}`:'<span class="sec">↵ run</span>'; }
// termCmd is a textarea now: keep its height matched to its content (one row, growing to a
// cap then scrolling) so long questions wrap and jump lines instead of running off-screen.
function termAutoGrow(el){ if(!el) return; el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,120)+'px'; }

export function __boot_terminal_10926() {
TALIAS = {fund:'funding',apr:'funding',rate:'funding',fundingpct:'fundpct',pctile:'fundpct',
  sqz:'squeeze',mom:'momentum',volume:'vol',openinterest:'oi',tape:'vstape',
  deltaoi:'doi',oichange:'doi',b:'beta',drawdown:'dd',change:'d1',chg:'d1',day:'d1',today:'d1',perf:'d1',performance:'d1',px:'price',oivol:'turn',
  week:'d7',weekly:'d7','7d':'d7','7day':'d7',month:'d30',monthly:'d30','30d':'d30','30day':'d30',
  hour:'h1',hourly:'h1','1h':'h1','1hour':'h1','4h':'h4','4hour':'h4',
  ytd:'vsyopen',yeartodate:'vsyopen',mtd:'vsmopen',monthtodate:'vsmopen',yearopen:'yopen',monthopen:'mopen',
  premium:'prem',basis:'prem',range:'adr',avgrange:'adr',dailyrange:'adr',
  relvol:'rvol',relativevolume:'rvol',volatility:'vol30',vola:'vol30',volatile:'vol30',realizedvol:'vol30',
  downcap:'dcap',downcapture:'dcap',hit:'hitr',hitrate:'hitr',
  yearhigh:'ddy',ytdhigh:'ddy',high:'dd',fromhigh:'dd',offhigh:'dd',
  sp500:'rs',spx:'rs',vssp:'rs',vssp500:'rs',vsspx:'rs'};

// ---- panel plumbing / rendering ----
// Every block the terminal draws goes through termEmit. Normally that is the panel's scrollback;
// while a chat command runs (dmRunCmd, build 2026.09.11-69) a sink collects the blocks instead, so
// the SAME verb handlers — one code path, the numbers the board renders — answer inside a
// conversation without knowing they are not in the panel. `ai` on the sink says whether the AI
// leg may fire for this capture; termAsk reads it.

{ const q=termEl('termCmd');
  if(q){ q.addEventListener('input',()=>{ termGhostFn(); termAutoGrow(q); });
    q.addEventListener('keydown',e=>{
      if(e.key==='Tab'){ e.preventDefault(); const c=termComps(q.value); if(c[0]){ q.value=c[0]+' '; termGhostFn(); termAutoGrow(q); } return; }
      // Enter runs; Shift+Enter inserts a newline (default) then regrows. Skip while an IME
      // composition is open so committing a candidate with Enter doesn't fire the command.
      if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){ e.preventDefault(); const v=q.value; if(v.trim()) termHist.unshift(v); termHi_=-1; q.value=''; termAutoGrow(q); termEl('termGhost').textContent=''; termRun(v); termHint(); return; }
      if(e.key==='Enter'){ setTimeout(()=>termAutoGrow(q),0); return; }
      // History arrows only steal the keypress on the first/last visual line — mid-question the
      // caret moves between wrapped lines like a normal textarea.
      if(e.key==='ArrowUp'&&!q.value.slice(0,q.selectionStart).includes('\n')){ e.preventDefault(); if(termHi_<termHist.length-1){ termHi_++; q.value=termHist[termHi_]; termGhostFn(); termAutoGrow(q); } return; }
      if(e.key==='ArrowDown'&&!q.value.slice(q.selectionEnd).includes('\n')){ e.preventDefault(); if(termHi_>0){ termHi_--; q.value=termHist[termHi_]; } else { termHi_=-1; q.value=''; } termGhostFn(); termAutoGrow(q); return; }
      if(e.key==='Escape'){ termClose(); return; }
      if(e.key==='ArrowRight'&&termEl('termGhost').textContent&&q.selectionStart===q.value.length){ q.value=termEl('termGhost').textContent; termGhostFn(); termAutoGrow(q); } }); }
  const fab=termEl('termFab'); if(fab) fab.addEventListener('click',termOpen);
  const mn=termEl('termMin'); if(mn) mn.addEventListener('click',termClose);
  const ex=termEl('termExpand'); if(ex) ex.addEventListener('click',()=>{ const pn=termEl('termPanel'); if(!pn) return; const big=pn.classList.toggle('big'); ex.textContent=big?'⤡':'⤢'; ex.title=big?'shrink':'expand'; const q=termEl('termCmd'); if(q) q.focus(); });
  document.addEventListener('click',e=>{ const x=e.target.closest('[data-tcmd]'); if(x){ termOpen(); termRun(x.dataset.tcmd); return; }
    const tv=e.target.closest('[data-tview]'); if(tv){ showView(tv.dataset.tview); return; }
    const op=e.target.closest('[data-topen]'); if(op){ const c=op.dataset.topen; showView('markets'); if(state.rows.has(c)) openDetail(c); } });
  document.addEventListener('keydown',e=>{ if((e.key==='`'||e.key==='~')&&document.activeElement.tagName!=='INPUT'&&document.activeElement.tagName!=='TEXTAREA'){ e.preventDefault(); termToggle(); } });
}
{ const s=termEl('termScroll'); if(s&&!s.dataset.boot){ s.dataset.boot='1';
  s.innerHTML=`<div class="tp-blk"><span class="tp-line"><span class="amber">Milst Screener terminal</span> <span class="tp-trans">· ask the board in plain English — the app answers from live data, badged </span><span class="tp-badge c">computed</span></div><div class="tp-blk"><span class="tp-line tp-trans">try <span class="ex" data-tcmd="most crowded shorts">most crowded shorts</span>, a ticker, or <span class="ex" data-tcmd="help">help</span></span></div>`;
  termHint(); } }

(async ()=>{
  startEvents();   // push channel first: a change during boot loads lands as an instant re-pull
  prefsPullAll();  // account copy of watchlist + layouts: newer stamp wins, so a cold browser adopts the server's
  loadPositions(); setInterval(()=>{ if(state.posMeta&&state.posMeta.wallet&&!document.hidden) loadPositions(true); }, 5*60*1000);   // equity/margin refresh; marks are live already
  await Promise.all([loadSnapshot(), loadDaily()]);
  applyHash();
  startCycle();
  scheduleDaily();
  updateFreshTray(); setInterval(updateFreshTray, 45000);   // data-source freshness dots in the status line
})();
}



// ============================================================================


export function __boot_terminal_11651() {//  Folded-in modules (were separate /public drop-ins; moved here so index.html
//  needs no extra <script> tags). Each self-installs on load.
//    - Treemap tab   - app-wide chart tooltips   - corr 7/30/90 + unclassified
// ============================================================================

// ---- Treemap tab (self-installing; injects its own tab + view) -------------
(function(){
function tmSize(r){ return state.map.size==='oi' ? (r.oi||0) : (r.vol||0); }
function tmRet(r){ const k=TF_MAP[state.tf]||'d1'; const v=r[k]; return (v==null||!isFinite(v))?null:v; }

const MAP_SCALE={ honest:1, balanced:0.5, flat:0.28 };
const MIN_SHARE=0.0012;   // floor: no visible market below ~0.12% of the map

function tmRGB(ret, cap){
  if(ret==null) return null;
  const t=clamp(ret/cap,-1,1), a=Math.abs(t);
  const mid=[26,24,18], up=[70,185,126], dn=[229,96,77], tg=t>=0?up:dn;
  const L=(x,y)=>Math.round(x+(y-x)*a);
  return [L(mid[0],tg[0]),L(mid[1],tg[1]),L(mid[2],tg[2])];
}
function tmFill(rgb){ return rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : 'var(--panel2)'; }
function tmInk(rgb){ if(!rgb) return '#e8e8e0';                        // null → dark tile → light ink
  const lum=0.299*rgb[0]+0.587*rgb[1]+0.114*rgb[2]; return lum>150?'#0d0d0a':'#fff'; }
// crude monospace width estimate; JetBrains Mono ~0.6em per glyph
function tmFits(str, fs){ return str.length*fs*0.60; }
function pctile(arr,p){ const a=arr.filter(x=>x!=null&&isFinite(x)).sort((x,y)=>x-y);
  if(!a.length) return 0; return a[clamp(Math.floor(p*(a.length-1)),0,a.length-1)]; }

function tmCompress(raws, gamma){
  let w=raws.map(v=>Math.pow(Math.max(0,v), gamma));
  let sum=w.reduce((a,b)=>a+b,0)||1;
  w=w.map(x=>x/sum);
  if(gamma<1){ w=w.map(x=>Math.max(x, MIN_SHARE));
    sum=w.reduce((a,b)=>a+b,0); w=w.map(x=>x/sum); }
  return w;
}

// --- squarified layout (Bruls, Huizing, van Wijk) -------------------------
function tmScale(nodes, area){ const tot=nodes.reduce((s,n)=>s+Math.max(0,n.size),0)||1;
  const k=area/tot; nodes.forEach(n=>n.area=Math.max(0,n.size)*k); }
function tmWorst(row, sum, side, extra){
  if(!row.length && extra==null) return Infinity;
  let mx=-Infinity, mn=Infinity, s=sum;
  for(const c of row){ if(c.area>mx)mx=c.area; if(c.area<mn)mn=c.area; }
  if(extra!=null){ if(extra>mx)mx=extra; if(extra<mn)mn=extra; s+=extra; }
  const s2=s*s, d2=side*side; return Math.max(d2*mx/s2, s2/(d2*mn));
}
function tmLayoutRow(row, sum, rect, out){
  if(rect.w>=rect.h){ const rw=sum/rect.h; let cy=rect.y;
    for(const c of row){ const ch=c.area/rw; c.x=rect.x; c.y=cy; c.w=rw; c.h=ch; out.push(c); cy+=ch; }
    return {x:rect.x+rw, y:rect.y, w:rect.w-rw, h:rect.h}; }
  const rh=sum/rect.w; let cx=rect.x;
  for(const c of row){ const cw=c.area/rh; c.x=cx; c.y=rect.y; c.w=cw; c.h=rh; out.push(c); cx+=cw; }
  return {x:rect.x, y:rect.y+rh, w:rect.w, h:rect.h-rh};
}
function tmSquarify(nodes, X,Y,W,H){
  const items=nodes.filter(n=>n.area>0).sort((a,b)=>b.area-a.area);
  const out=[]; let rect={x:X,y:Y,w:W,h:H}, row=[], sum=0, i=0;
  while(i<items.length){ const c=items[i], side=Math.min(rect.w,rect.h);
    if(!row.length || tmWorst(row,sum,side,c.area) <= tmWorst(row,sum,side)){ row.push(c); sum+=c.area; i++; }
    else { rect=tmLayoutRow(row,sum,rect,out); row=[]; sum=0; }
  }
  if(row.length) tmLayoutRow(row,sum,rect,out);
  return out;
}

// --- render ---------------------------------------------------------------
const TM_PAD=2, TM_HEAD=16;
function tmSyncControls(){
  const set=(sel,attr,val)=>document.querySelectorAll(sel+' button').forEach(b=>b.classList.toggle('active',b.dataset[attr]===val));
  set('#tmf','tf',state.tf); set('#mapsize','size',state.map.size); set('#mapscale','scale',state.map.scale);
}
function renderTreemap(){
  const host=el('map-canvas'); if(!host) return;
  if(!state.map) state.map={size:'vol',scale:'balanced',sel:null};
  tmSyncControls();
  if(!state.rows.size){ host.innerHTML='<div class="msg">Markets still loading…</div>'; return; }
  computeDerived();
  const gamma=MAP_SCALE[state.map.scale] ?? 0.5;

  let sectors=computeSectors()
    .map(s=>({ name:s.name, cls:s.assetClass,
      members:[...s.members].filter(r=>tmSize(r)>0)
        .map(r=>({ coin:r.coin, ticker:r.ticker, raw:tmSize(r), ret:tmRet(r) })) }))
    .filter(s=>s.members.length);
  if(!sectors.length){ host.innerHTML='<div class="msg">No markets match the current filters.</div>'; return; }

  const flat=sectors.flatMap(s=>s.members);
  const w=tmCompress(flat.map(m=>m.raw), gamma);
  flat.forEach((m,i)=>m.size=w[i]);
  sectors.forEach(s=>s.size=s.members.reduce((a,m)=>a+m.size,0));

  const W=1000, H=620, cap=Math.max(2, pctile(flat.map(m=>Math.abs(m.ret)), 0.95));

  tmScale(sectors, W*H);
  const cells=tmSquarify(sectors, 0,0,W,H);
  let s=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block;font-family:var(--mono)">`;

  for(const sec of cells){
    s+=`<rect x="${sec.x.toFixed(1)}" y="${sec.y.toFixed(1)}" width="${sec.w.toFixed(1)}" height="${sec.h.toFixed(1)}" fill="var(--panel)" stroke="var(--border)" stroke-width="1"/>`;

    // header band — only when there's real room, so short sectors aren't squashed
    const canHead = sec.w>66 && sec.h>30;
    const head = canHead ? TM_HEAD : 0;
    if(canHead){
      s+=`<rect x="${sec.x.toFixed(1)}" y="${sec.y.toFixed(1)}" width="${sec.w.toFixed(1)}" height="${head}" fill="var(--panel2)"/>`;
      const nm=sectorShort(sec.name).toUpperCase();
      let hfs=Math.min(10, (sec.w-10)/Math.max(1,nm.length*0.62));
      if(hfs>=7) s+=`<text x="${(sec.x+5).toFixed(1)}" y="${(sec.y+11.5).toFixed(1)}" style="font-size:${hfs.toFixed(1)}px;letter-spacing:.4px;fill:var(--muted)">${esc(nm)}</text>`;
    }

    const ix=sec.x+TM_PAD, iy=sec.y+(canHead?head:TM_PAD), iw=sec.w-2*TM_PAD, ih=sec.h-(canHead?head:TM_PAD)-TM_PAD;
    if(iw<3||ih<3) continue;
    tmScale(sec.members, iw*ih);
    const tiles=tmSquarify(sec.members, ix,iy,iw,ih);

    for(const t of tiles){
      const rgb=tmRGB(t.ret, cap), fill=tmFill(rgb), ink=tmInk(rgb);
      const rp=t.ret==null?'n/a':(t.ret>=0?'+':'')+t.ret.toFixed(2)+'%';
      s+=`<g class="tm-tile" data-coin="${esc(t.coin)}" style="cursor:pointer">`;
      s+=`<title>${esc(t.ticker)} · ${rp} (${state.tf}) · ${fmtUsd(t.raw)} ${state.map.size==='oi'?'OI':'vol'}</title>`;
      s+=`<rect x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" width="${t.w.toFixed(1)}" height="${t.h.toFixed(1)}" fill="${fill}" stroke="var(--bg)" stroke-width="1"/>`;

      // labels: only draw what actually fits the tile — never overflow
      const availW=t.w-5, cx=(t.x+t.w/2);
      let fs=Math.min(11, availW/Math.max(1,t.ticker.length*0.60));
      if(t.w>=24 && t.h>=13 && fs>=6.5){
        fs=clamp(fs,6.5,11);
        const twoLines = t.h>=30 && t.ret!=null;
        let pfs=Math.min(fs-1, availW/Math.max(1,rp.length*0.60));
        const showPct = twoLines && pfs>=6.5 && tmFits(rp,pfs)<=availW;
        const tickY = showPct ? (t.y+t.h/2-1) : (t.y+t.h/2+fs*0.34);
        s+=`<text x="${cx.toFixed(1)}" y="${tickY.toFixed(1)}" text-anchor="middle" style="font-size:${fs.toFixed(1)}px;fill:${ink};font-weight:600">${esc(t.ticker)}</text>`;
        if(showPct)
          s+=`<text x="${cx.toFixed(1)}" y="${(t.y+t.h/2+pfs+1).toFixed(1)}" text-anchor="middle" style="font-size:${pfs.toFixed(1)}px;fill:${ink};opacity:.82">${rp}</text>`;
      }
      s+='</g>';
    }
  }
  s+='</svg>';
  host.innerHTML=s;

  const lg=el('map-legend');
  if(lg) lg.innerHTML = `<b>Treemap</b> — size = ${state.map.size==='oi'?'open interest':'24h volume'}, color = return over ${state.tf}. `
    + (gamma<1
        ? `<span class="sec">areas compressed for legibility (${esc(state.map.scale)}) — hover for the exact figure.</span>`
        : `<span class="sec">areas are literally proportional.</span>`);

  el('map-canvas').querySelectorAll('.tm-tile').forEach(g=>g.addEventListener('click',()=>{
    const coin=g.dataset.coin;
    if(typeof openDetail==='function' && state.rows.has(coin)) openDetail(coin);
  }));
}

// --- self-install: tab, view, controls, deep link -------------------------
(function installTreemap(){
  function seg(id,label,attr,opts){ return `<div class="seg" id="${id}" role="group" aria-label="${label}">`
    + `<span class="seglbl">${label}</span>`
    + opts.map(o=>`<button type="button" data-${attr}="${o[0]}">${o[1]}</button>`).join('') + `</div>`; }
  function bindSeg(sel,attr,fn){ document.querySelectorAll(sel+' button').forEach(b=>{
    b.addEventListener('click',()=>{ fn(b.dataset[attr]);
      document.querySelectorAll(sel+' button').forEach(x=>x.classList.toggle('active',x===b)); }); }); }

  function boot(){
    if(document.getElementById('view-treemap')) return;               // already installed
    if(typeof state==='undefined') return;                            // app.js not loaded yet
    if(!state.map) state.map={size:'vol',scale:'balanced',sel:null};

    // tab button
    const nav=document.querySelector('nav.tabs')||document.querySelector('.tabs');
    if(nav){ const btn=document.createElement('button'); btn.className='tab'; btn.dataset.view='treemap'; btn.textContent='Treemap';
      const anchor=document.getElementById('tabSpacer');
      if(anchor && anchor.parentNode===nav) nav.insertBefore(btn,anchor); else nav.appendChild(btn);
      // This installer runs on DOMContentLoaded — AFTER the boot applyScope() pass that hides
      // non-markets tabs in crypto scope. Without this line a page loaded in crypto scope
      // shows a stray Treemap tab until the next scope switch re-runs applyScope().
      btn.hidden = !tabVisible('treemap');   // was scope-only; now scope AND flags, same rule as every other tab
      // Join the systems that wired the static tabs before this one existed: saved tab order
      // (so a persisted position for treemap applies on load) and drag-to-reorder (idempotent).
      if(typeof applyTabOrder==='function') applyTabOrder();
      if(typeof buildTabGroups==='function') buildTabGroups();   // treemap lands in the Tape menu, not loose in the row
      if(typeof applyTabVisibility==='function') applyTabVisibility();
      if(typeof wireTabDrag==='function') wireTabDrag();
    }

    // view section
    const sec=document.createElement('section'); sec.id='view-treemap'; sec.hidden=true;
    sec.innerHTML =
      `<div class="controls">`
      + seg('tmf','window','tf',[['1h','1h'],['4h','4h'],['1d','1d'],['7d','7d'],['30d','30d']])
      + seg('mapsize','size','size',[['vol','by volume'],['oi','by OI']])
      + seg('mapscale','areas','scale',[['honest','honest'],['balanced','balanced'],['flat','flat']])
      + `</div>`
      + `<div class="sect-legend" id="map-legend"></div>`
      + `<div id="map-canvas"><div class="msg">Loading…</div></div>`;
    const corr=document.getElementById('view-corr');
    if(corr && corr.parentNode) corr.insertAdjacentElement('afterend',sec);
    else (document.querySelector('main')||document.body).appendChild(sec);

    // minimal styling so the canvas doesn't collapse before first render
    if(!document.getElementById('tm-style')){ const st=document.createElement('style'); st.id='tm-style';
      st.textContent='#map-canvas{min-height:420px;border:1px solid var(--border);border-radius:6px;padding:2px;margin-top:8px}';
      document.head.appendChild(st); }

    // nav clicks: show/render on our tab, hide our view on any other
    if(nav && !nav.dataset.tmBound){ nav.dataset.tmBound='1';
      nav.addEventListener('click',e=>{ const t=e.target.closest('.tab'); if(!t) return; const v=t.dataset.view;
        if(v==='treemap' && typeof showView==='function') showView('treemap');   // hides built-in views, sets active tab + hash
        const tv=document.getElementById('view-treemap'); if(tv) tv.hidden = v!=='treemap';
        if(v==='treemap') renderTreemap();
      }); }

    // control bindings (window syncs with the rest of the app via setWindow)
    bindSeg('#tmf','tf', tf=>{ if(typeof setWindow==='function') setWindow(tf); renderTreemap(); });
    bindSeg('#mapsize','size', v=>{ state.map.size=v; renderTreemap(); });
    bindSeg('#mapscale','scale', v=>{ state.map.scale=v; renderTreemap(); });

    // deep link (#treemap on load) — not in crypto scope, which is Markets-only by design;
    // without the guard the treemap section would render on top of the markets table.
    if((location.hash||'').replace(/^#/,'')==='treemap' && typeof showView==='function' && tabVisible('treemap')){
      showView('treemap'); sec.hidden=false; renderTreemap(); }
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
  else boot();
})();
})();

// ---- App-wide chart tooltips (styled <title> + sparkline crosshair) --------
(function(){
  var tip, cross=null;
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }

  function ensure(){
    if(tip) return;
    var st=document.createElement('style'); st.id='tt-style';
    st.textContent=
      '.tt-pop{position:fixed;z-index:9999;pointer-events:none;left:0;top:0;'+
      'background:var(--panel2,#17140d);border:1px solid var(--border,#3a3524);border-radius:6px;'+
      'padding:6px 9px;font:11.5px/1.45 var(--mono,ui-monospace,Menlo,monospace);'+
      'color:var(--text,#ffcf6b);box-shadow:0 6px 22px rgba(0,0,0,.5);max-width:300px;'+
      'opacity:0;transition:opacity .08s}'+
      '.tt-pop.on{opacity:1}.tt-pop b{color:var(--text,#ffcf6b);font-weight:600}'+
      '.tt-pop .k{color:var(--muted,#c2913a)}';
    document.head.appendChild(st);
    tip=document.createElement('div'); tip.className='tt-pop'; document.body.appendChild(tip);
  }
  function place(x,y){
    var r=tip.getBoundingClientRect(), nx=x+14, ny=y+16;
    if(nx+r.width>innerWidth-8) nx=x-r.width-14;
    if(ny+r.height>innerHeight-8) ny=y-r.height-16;
    tip.style.left=Math.max(8,nx)+'px'; tip.style.top=Math.max(8,ny)+'px';
  }
  function show(html,x,y){ ensure(); tip.innerHTML=html; tip.classList.add('on'); place(x,y); }
  function hide(){ if(tip) tip.classList.remove('on'); clearCross(); }

  // --- generic <title> tooltips -------------------------------------------
  function tipNode(start){
    var n=start;
    while(n && n.nodeType===1){
      if(n.getAttribute && n.getAttribute('data-tip')!=null) return n;
      if(n.querySelector){ var t=n.querySelector(':scope > title'); if(t) return n; }
      if(n.tagName && n.tagName.toLowerCase()==='svg') break;
      n=n.parentNode;
    }
    return null;
  }
  function hoist(node){
    var d=node.getAttribute('data-tip'); if(d!=null) return d;
    var t=node.querySelector(':scope > title'); if(!t) return null;
    var txt=t.textContent||''; node.setAttribute('data-tip',txt); t.parentNode.removeChild(t); return txt;
  }
  function fmtTitle(raw){
    var parts=raw.split(' \u00b7 ');
    if(parts.length===1 && raw.length>90){
      // Unstructured long tip: bold-heading the whole paragraph is unreadable. Split a short
      // head at the first sentence/em-dash boundary; failing that, render as plain body text.
      var cut=-1, dot=raw.indexOf('. '), q=raw.indexOf('? '), dash=raw.indexOf(' \u2014 ');
      if(q>0&&(dot<0||q<dot)) dot=q;
      if(dot>0&&dot<=90) cut=dot+1; else if(dash>0&&dash<=90) cut=dash;
      if(cut>0) return '<b>'+esc(raw.slice(0,cut))+'</b><div class="k">'+esc(raw.slice(cut).replace(/^[\s\u2014]+/,''))+'</div>';
      return '<div class="k">'+esc(raw)+'</div>';
    }
    var h='<b>'+esc(parts[0])+'</b>';
    for(var i=1;i<parts.length;i++) h+='<div class="k">'+esc(parts[i])+'</div>';
    return h;
  }

  // --- sparkline crosshair -------------------------------------------------
  function fmtNum(v){ v=+v; if(!isFinite(v)) return '\u2014'; var a=Math.abs(v);
    if(a>=1000) return v.toLocaleString(undefined,{maximumFractionDigits:0});
    if(a>=1) return v.toFixed(2); if(a>=0.01) return v.toFixed(4); return v.toPrecision(2); }

  function seriesFromState(svg){
    var host=svg.closest && svg.closest('[data-coin]');
    if(!host || typeof state==='undefined' || !state.rows) return null;
    var r=state.rows.get(host.getAttribute('data-coin')); if(!r) return null;
    var cl=(r.feat && Array.isArray(r.feat.px30)) ? r.feat.px30.slice(-31)
          : (r.daily ? r.daily.slice(-31).map(function(k){return parseFloat(k.c);}).filter(isFinite) : null);
    if(!cl || cl.length<2) return null;
    return { vals:cl, name:r.ticker||host.getAttribute('data-coin'), unit:'price', pre:'close' };
  }
  function seriesFromData(svg){
    var d=svg.dataset||{}; if(d.series==null) return null;
    var vals=d.series.split(',').map(function(x){ if(x==='') return null; var n=parseFloat(x); return isFinite(n)?n:null; });
    if(vals.filter(function(x){return x!=null;}).length<2) return null;
    return { vals:vals, labels:d.labels?d.labels.split('|'):null,
      name:d.name||'', unit:d.unit||'', pre:d.tip||'' };
  }
  // nearest finite sample to idx (series may have gaps)
  function nearest(vals, idx){
    if(vals[idx]!=null) return idx;
    for(var k=1;k<vals.length;k++){
      if(idx-k>=0 && vals[idx-k]!=null) return idx-k;
      if(idx+k<vals.length && vals[idx+k]!=null) return idx+k;
    }
    return -1;
  }

  function clearCross(){ if(cross){ if(cross.g.parentNode) cross.g.parentNode.removeChild(cross.g); cross=null; } }
  function drawCross(svg,frac){
    clearCross();
    var vb=svg.viewBox && svg.viewBox.baseVal; if(!vb || !vb.width) return;
    var NS='http://www.w3.org/2000/svg', x=vb.x+frac*vb.width;
    var g=document.createElementNS(NS,'g'); g.setAttribute('class','tt-cross'); g.style.pointerEvents='none';
    var ln=document.createElementNS(NS,'line');
    ln.setAttribute('x1',x); ln.setAttribute('x2',x); ln.setAttribute('y1',vb.y); ln.setAttribute('y2',vb.y+vb.height);
    ln.setAttribute('stroke','var(--faint,#75612f)'); ln.setAttribute('stroke-width','1'); ln.setAttribute('vector-effect','non-scaling-stroke');
    g.appendChild(ln); svg.appendChild(g); cross={svg:svg,g:g};
  }

  function handleSpark(svg,e){
    var info=seriesFromData(svg) || (svg.classList.contains('tspark') ? seriesFromState(svg) : null);
    if(!info){ hide(); return; }
    var rect=svg.getBoundingClientRect(); if(!rect.width){ hide(); return; }
    var frac=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
    var n=info.vals.length, idx=nearest(info.vals, Math.round(frac*(n-1)));
    if(idx<0){ hide(); return; }
    var v=info.vals[idx];
    drawCross(svg, idx/(n-1));
    var valStr = info.unit==='price' ? '$'+fmtNum(v) : (fmtNum(v)+(info.unit||''));
    var line = (info.pre?esc(info.pre)+' ':'')+valStr;
    if(info.labels && info.labels[idx]) line = esc(info.labels[idx])+' \u00b7 '+line;
    var h = info.name ? '<b>'+esc(info.name)+'</b>' : '';
    h += '<div class="k">'+line+'</div>';
    var base=null; for(var b=0;b<n;b++){ if(info.vals[b]!=null){ base=info.vals[b]; break; } }
    if(base){ var chg=(v/base-1)*100; if(isFinite(chg)) h+='<div class="k">'+(chg>=0?'+':'')+chg.toFixed(2)+'% from start</div>'; }
    show(h, e.clientX, e.clientY);
  }

  // --- dispatch ------------------------------------------------------------
  document.addEventListener('mousemove', function(e){
    var t=e.target;
    var spark = t.closest && t.closest('svg.tspark, svg[data-series]');
    if(spark){ handleSpark(spark,e); return; }
    var node = tipNode(t);
    if(node){ var raw=hoist(node); if(raw){ clearCross(); show(fmtTitle(raw), e.clientX, e.clientY); return; } }
    hide();
  }, true);
  document.addEventListener('mouseleave', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);

  // --- touch parity (standing requirement: every hover readout must work on touch) ---------
  // Convention: TAP keeps its click action untouched; LONG-PRESS (~420ms) is the hover. On a
  // sparkline the long-press engages a crosshair scrub that follows the finger (page scroll is
  // suppressed only while scrubbing). Releasing a long-press leaves the tip on screen to read;
  // the next touch anywhere clears it. The synthesized click after a long-press is swallowed so
  // holding a table row reads its tooltip without also opening the drawer.
  var lp={x:0,y:0,node:null,spark:null,timer:null,held:false,scrub:false};
  function lpCancel(){ if(lp.timer){ clearTimeout(lp.timer); lp.timer=null; } }
  document.addEventListener('touchstart', function(e){
    if(e.touches.length!==1){ lpCancel(); return; }
    var t=e.touches[0], tgt=e.target;
    hide();   // any new touch clears a lingering readout first
    lp.x=t.clientX; lp.y=t.clientY; lp.held=false; lp.scrub=false;
    lp.spark = (tgt.closest && tgt.closest('svg.tspark, svg[data-series]')) || null;
    lp.node = lp.spark ? null : tipNode(tgt);
    if(!lp.spark && !lp.node) return;
    lpCancel();
    lp.timer=setTimeout(function(){
      lp.held=true;
      if(lp.spark){ lp.scrub=true; handleSpark(lp.spark,{clientX:lp.x,clientY:lp.y}); }
      else { var raw=hoist(lp.node); if(raw){ clearCross(); show(fmtTitle(raw), lp.x, lp.y); } }
    }, 420);
  }, {passive:true});
  document.addEventListener('touchmove', function(e){
    var t=e.touches[0]; if(!t) return;
    if(lp.scrub){ e.preventDefault(); handleSpark(lp.spark,{clientX:t.clientX,clientY:t.clientY}); return; }
    if(Math.abs(t.clientX-lp.x)>10 || Math.abs(t.clientY-lp.y)>10){ lpCancel(); }   // it's a scroll, not a press
  }, {passive:false});
  document.addEventListener('touchend', function(e){
    lpCancel();
    if(lp.held){ e.preventDefault();   // swallow the synthesized click — the hold was a read, not a tap
      if(lp.scrub) hide();             // scrub readout dies with the finger; a data-tip stays to be read
      lp.held=false; lp.scrub=false; }
  }, {passive:false});
  document.addEventListener('touchcancel', function(){ lpCancel(); lp.held=false; lp.scrub=false; }, {passive:true});
  document.addEventListener('contextmenu', function(e){ if(lp.held||lp.timer){ e.preventDefault(); } });
})();

// ---- Correlation lookback (7d/30d/90d, default 30d) + unclassified alert ---
(function(){
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
  function ready(fn){ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',fn); else fn(); }

  // --- A. correlation lookback (scope-aware: stocks 7/30/90d, crypto 4h/1d/7d) -------------
  function fixCorrLookback(){
    if(typeof syncCorrLookback==='function'){ syncCorrLookback();
      var v=document.getElementById('view-corr');
      if(typeof renderCorr==='function' && v && !v.hidden) renderCorr();
      return; }
  }

  // --- B. unclassified-listing alert --------------------------------------
  var badge;
  function ensureBadge(){
    if(badge) return;
    var st=document.createElement('style'); st.id='uc-style';
    st.textContent='#uc-badge{position:fixed;left:12px;bottom:12px;z-index:9998;'
      +'max-width:min(560px,calc(100vw - 24px));background:var(--panel2,#17140d);'
      +'border:1px solid var(--down,#ff5b49);border-radius:8px;padding:8px 12px;'
      +'font:12px/1.45 var(--mono,ui-monospace,Menlo,monospace);color:var(--text,#ffcf6b);'
      +'cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.5)}#uc-badge b{color:var(--down,#ff5b49)}';
    document.head.appendChild(st);
    badge=document.createElement('div'); badge.id='uc-badge'; badge.style.display='none';
    badge.title='Click to copy the ticker list';
    badge.addEventListener('click',function(){
      var t=badge.getAttribute('data-names')||'';
      if(t && navigator.clipboard) navigator.clipboard.writeText(t).catch(function(){});
    });
    document.body.appendChild(badge);
  }
  function scanUnclassified(){
    if(typeof state==='undefined' || !state.rows) return [];
    var out=[];
    state.rows.forEach(function(r){
      if(r.delisted) return;
      if(!r.sector || r.sector==='Unclassified') out.push(r.ticker||r.coin);
    });
    return out;
  }
  function updateBadge(){
    ensureBadge();
    var names=scanUnclassified();
    if(!names.length){ badge.style.display='none'; return; }
    badge.setAttribute('data-names', names.join(', '));
    badge.style.display='';
    var shown=names.slice(0,12).map(esc).join(', ')+(names.length>12?', \u2026':'');
    badge.innerHTML='<b>\u26a0 Unclassified ('+names.length+')</b> '+shown+' \u2014 add to src/sectors.js';
  }

  // The unclassified badge is a maintainer aid ("add to src/sectors.js"), so only show it
  // locally or when ?debug is present — friends visiting the live site shouldn't see it.
  var UC_DEBUG = (function(){ try {
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      || /[?&]debug\b/.test(location.search);
  } catch(_){ return false; } })();

  ready(function(){
    fixCorrLookback();
    if(UC_DEBUG){ updateBadge(); setInterval(updateBadge, 4000); }   // re-checks as snapshots refresh (~15s server-side)
  });
})();
}

// The chat terminal (messages.js) captures a command's output by pointing the sink at a block list for the
// duration of one run; a module-scope let stays writable only through this door.
function termSink(){ return _termSink; }
function termSetSink(v){ _termSink=v||null; }

export { TFIELD, nlResolve, tcount, termActive, termAsk, termComps, termErr, termExec, termFind, termGrammarComplete, termHistPush, termOut, termOutTrans, termSetSink, termSink, termThinking, tesc, tmoney, tpad };
