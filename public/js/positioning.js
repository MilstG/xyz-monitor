// positioning.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { WD_NAMES, _hoverReg, _szCash, attachClockControls, attachDowControls, attachLineHover, attachOverlayControls, attachSeasonControls, covPct, fp, hoverChart, lcGrid, lcTicks, renderClassOverlay, renderClocks, renderClusters, renderDow, renderSeasonality, renderSessionDecomp, sCap, sCard, sHead, sessDate } from "./admin.js";
import { SCROLL_B, el, esc, fmtUsd, state, store } from "./core.js";

// ===== Positioning regime strip (crowding + system leverage, crypto / stocks / both) =====
// Reads a.sections.regime (pure server aggregate of fields already on the board). Chart-bearing
// tiles come off the same series the chart draws, so the number and the line can't disagree.
function regimeCurveSvg(series, o){
  const W=520,H=150, pl=54,pr=16,pt=12,pb=22;
  const pts=(series||[]).map(p=>[p[0],p[o.idx]]).filter(p=>p[1]!=null&&isFinite(p[1]));
  if(pts.length<2) return '<div class="msg" style="height:110px;display:flex;align-items:center;justify-content:center">Not enough history yet — the line fills in as OI banks.</div>';
  const n=pts.length, vs=pts.map(p=>p[1]);
  let lo=Math.min(...vs), hi=Math.max(...vs);
  const zeroCross = o.kind==='skew' && lo<0 && hi>0;
  if(o.kind==='skew'){ lo=Math.min(lo,0); hi=Math.max(hi,0); }
  if(hi===lo){ hi+=Math.abs(hi)*0.1||1; lo-=Math.abs(lo)*0.1||1; }
  const padd=(hi-lo)*0.1; hi+=padd; lo-=padd;
  const X=i=> pl+(n<=1?0:i/(n-1))*(W-pl-pr);
  const Y=v=> pt+(1-(v-lo)/(hi-lo))*(H-pt-pb);
  const fmtY = o.kind==='oi' ? (v=>fmtUsd(v)) : (v=>(v>=0?'+':'')+v.toFixed(0)+'%');
  let s=lcGrid(pl,W-pr,lcTicks(lo,hi,4),Y,fmtY);
  if(zeroCross) s+=`<line x1="${pl}" y1="${Y(0).toFixed(1)}" x2="${W-pr}" y2="${Y(0).toFixed(1)}" stroke="var(--faint)" stroke-width="1"/>`;
  const baseV = o.kind==='skew'?0:lo;
  let area=`M ${X(0).toFixed(1)} ${Y(baseV).toFixed(1)}`;
  for(let i=0;i<n;i++) area+=` L ${X(i).toFixed(1)} ${Y(vs[i]).toFixed(1)}`;
  area+=` L ${X(n-1).toFixed(1)} ${Y(baseV).toFixed(1)} Z`;
  s+=`<path d="${area}" fill="${o.color}" fill-opacity="0.09"/>`;
  s+=`<path d="${pts.map((p,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(p[1]).toFixed(1)).join(' ')}" fill="none" stroke="${o.color}" stroke-width="1.7"/>`;
  s+=`<circle cx="${X(n-1).toFixed(1)}" cy="${Y(vs[n-1]).toFixed(1)}" r="2.6" fill="${o.color}"/>`;
  s+=`<text x="${pl}" y="${H-6}" class="lc-tick">${sessDate(pts[0][0])}</text>`;
  s+=`<text x="${(W-pr).toFixed(1)}" y="${H-6}" text-anchor="end" class="lc-tick">${sessDate(pts[n-1][0])}</text>`;
  const xs=pts.map((_,i)=>X(i));
  const rows=pts.map(p=>`<b style="color:var(--text)">${sessDate(p[0])}</b><br><span style="color:${o.color}">${o.label}: ${o.kind==='oi'?fmtUsd(p[1]):((p[1]>=0?'+':'')+p[1].toFixed(1)+'% APR')}</span>`);
  return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});
}
function renderRegime(reg, sel){
  if(!reg) return '';
  const classes=[['all','Both'],['crypto','Crypto'],['stocks','Stocks']];
  if(!classes.some(c=>c[0]===sel)) sel='all';
  const label = sel==='all'?'the whole book':(sel==='crypto'?'crypto':'stocks');
  const selHtml=`<select id="regimesel" style="background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:3px 7px;font-family:var(--mono);font-size:var(--fs-xs)">`+
    classes.map(c=>`<option value="${c[0]}"${c[0]===sel?' selected':''}>${c[1]}</option>`).join('')+`</select>`;
  const headRow=`<div class="cp-sub" style="margin:2px 0 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span class="t" style="color:var(--text)">◆ Positioning regime</span> <span class="d sec">— how crowded &amp; leveraged ${label} is, tape-wide</span><span style="margin-left:auto">${selHtml}</span></div>`;
  const d=reg[sel];
  if(!d || d.pending || !d.series || !d.series.length){
    return headRow+`<div class="msg">Accruing — the regime line fills in as OI &amp; funding history banks${d&&d.names?` (${d.names} ${sel==='all'?'':sel+' '}names)`:''}.</div>`;
  }
  const cw=d.crowd||{}, lv=d.lev||{};
  const aprCell=(v)=> v==null?'—':`<span class="${v>=0?'up':'down'}">${v>=0?'+':''}${v.toFixed(1)}%</span>`;
  const pctCell=(v,g,b)=> v==null?'—':`<span style="color:${g?'var(--accent)':(b?'var(--blue)':'var(--text)')}">${v}%</span>`;
  const crowdTiles=`<div class="s-grid" style="margin-bottom:12px">`+
    `<div class="s-stat"><div class="k" title="OI-weighted mean funding across ${label}, annualized. Positive = the book, weighted by size, is paying to be long.">net funding skew</div><div class="v">${aprCell(cw.netFundApr)}</div><div class="s">${cw.pctNames||0} names priced</div></div>`+
    `<div class="s-stat"><div class="k" title="Share of names at or above the 90th percentile of their OWN 31d funding — crowded long.">crowded long</div><div class="v">${pctCell(cw.longExtPct,true,false)}</div><div class="s">&ge; 90th pctile</div></div>`+
    `<div class="s-stat"><div class="k" title="Share at or below the 10th percentile of own 31d funding — crowded short, squeeze fuel.">crowded short</div><div class="v">${pctCell(cw.shortExtPct,false,true)}</div><div class="s">&le; 10th pctile</div></div>`+
    `<div class="s-stat"><div class="k" title="crowded-long% minus crowded-short%. Tape-wide net crowding.">net crowding</div><div class="v">${cw.netCrowd==null?'—':(cw.netCrowd>0?'+':'')+cw.netCrowd}</div><div class="s">${cw.netCrowd==null?'':(cw.netCrowd>0?'skewed long':(cw.netCrowd<0?'skewed short':'balanced'))}</div></div>`+
    `</div>`;
  const chgCell=(v,suf)=> v==null?'':`<span class="${v>=0?'up':'down'}">${v>=0?'+':''}${v.toFixed(1)}%</span> ${suf}`;
  const levTiles=`<div class="s-grid" style="margin-bottom:12px">`+
    `<div class="s-stat"><div class="k" title="Sum of notional open interest across ${label} (reconstructed daily — matches the chart end).">total OI</div><div class="v">${fmtUsd(lv.totalOi)}</div><div class="s">${chgCell(lv.oi7dPct,'7d')}</div></div>`+
    `<div class="s-stat"><div class="k" title="Total OI as a z-score vs its own trailing window mean — how far current leverage sits above normal.">leverage stretch</div><div class="v">${lv.oiZ==null?'—':(lv.oiZ>0?'+':'')+lv.oiZ.toFixed(1)+'\u03c3'}</div><div class="s">${lv.oiZ==null?'accruing':(lv.oiZ>=1?'elevated':(lv.oiZ<=-1?'light':'normal'))}</div></div>`+
    `<div class="s-stat"><div class="k" title="Total OI over trailing 24h notional volume. Higher = leverage is sticky (held, not churned).">OI / 24h vol</div><div class="v">${lv.oiVol==null?'—':lv.oiVol.toFixed(2)+'\u00d7'}</div><div class="s">positions vs turnover</div></div>`+
    `<div class="s-stat"><div class="k" title="30-day change in total OI — leverage building or bleeding out of the book.">&Delta; OI 30d</div><div class="v">${lv.oi30dPct==null?'—':(lv.oi30dPct>=0?'<span class="up">+':'<span class="down">')+lv.oi30dPct.toFixed(1)+'%</span>'}</div><div class="s">over the window</div></div>`+
    `</div>`;
  const oiChart=regimeCurveSvg(d.series, {idx:1, color:'var(--blue)', kind:'oi', label:'total OI'});
  const skewChart=regimeCurveSvg(d.series, {idx:2, color:'var(--accent)', kind:'skew', label:'net funding skew'});
  const grid=`<div class="rg-charts" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">`+
    sCard(sCap('Total OI \u00b7 '+(sel==='all'?'both':sel))+oiChart)+
    sCard(sCap('Net funding skew (APR) \u00b7 '+(sel==='all'?'both':sel))+skewChart)+
    `</div>`;
  return headRow+crowdTiles+levTiles+grid+`<div class="sec" style="margin:10px 0 20px;font-size:var(--fs-xs);max-width:720px;line-height:1.5">Crowding is OI-weighted funding + how many names sit at a funding extreme; leverage is aggregate OI and how stretched it is vs its own norm. Crowded <em>and</em> stretched is the cascade precondition — context, not a trade.</div>`;
}
// ---- structural-level validation (sections.levels) ----
// The -09 detector's report card. Two charts + one table, all control-matched: excess = real rate
// minus a same-distance permutation control, so a bar above zero is edge over matched noise. Every
// element carries a <title> readout (bars/cells hover contract).
function lvlPct(x){ return x==null?'—':(x*100).toFixed(1)+'%'; }
// scope selector shared by the study panels: pooled default, or one name (within-name time series)
function studyScopeSel(id, byTicker, sel){
  const opts=Object.entries(byTicker||{}).map(([coin,v])=>({coin,tk:v.ticker})).sort((a,b)=>String(a.tk).localeCompare(String(b.tk)));
  return `<select id="${id}" class="clocksel"><option value="">All equities — pooled</option>`+
    opts.map(o=>`<option value="${esc(o.coin)}"${sel===o.coin?' selected':''}>${esc(o.tk)}</option>`).join('')+`</select>`;
}
function studyScopeState(key){ if(!state.analytics[key]) state.analytics[key]={sel:''}; return state.analytics[key]; }
function attachStudyScope(id,key){ const el2=el(id); if(el2) el2.addEventListener('change',()=>{ studyScopeState(key).sel=el2.value; drawSessions(); }); }

function lvlTouchSvg(st){
  const rows=st.buckets.concat(st.far?[Object.assign({lo:st.far.lo,hi:null},st.far)]:[]);
  const W=560,H=230,pl=44,pr=14,pt=14,pb=34, n=rows.length;
  const bw=(W-pl-pr)/n, Y=v=>pt+(1-v)*(H-pt-pb);
  let s=`<svg viewBox="0 0 ${W} ${H}" class="lchart" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">`;
  for(const g of [0,.25,.5,.75,1]){ const y=Y(g).toFixed(1);
    s+=`<line x1="${pl}" y1="${y}" x2="${W-pr}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`+
       `<text x="${pl-7}" y="${(+y+3.5).toFixed(1)}" text-anchor="end" class="lc-tick">${(g*100)|0}%</text>`; }
  for(let i=0;i<n;i++){ const b=rows[i], x=pl+i*bw, lab=b.hi==null?('>'+b.lo):(b.lo+'–'+b.hi);
    s+=`<text x="${(x+bw/2).toFixed(1)}" y="${H-pb+16}" text-anchor="middle" class="lc-tick">${lab}</text>`;
    if(b.touchRate==null){ // floored cell: honest empty slot, hoverable so the floor is explained
      s+=`<rect x="${(x+3).toFixed(1)}" y="${pt}" width="${(bw-6).toFixed(1)}" height="${H-pt-pb}" fill="var(--panel2)" opacity=".35"><title>${lab}σ · n=${b.n} — under the ${st.cellFloor}-event floor, no rate published</title></rect>`;
      continue; }
    const bw2=(bw-8)/2, xr=x+3, xc=x+5+bw2;
    const tip=`${lab}σ from detection mark · n=${b.n} (${b.nTouched} touched)&#10;level touch ${lvlPct(b.touchRate)} vs control ${lvlPct(b.baseline)} → excess ${(b.excess>=0?'+':'')+(b.excess*100).toFixed(1)}pp`;
    s+=`<rect x="${xr.toFixed(1)}" y="${Y(b.touchRate).toFixed(1)}" width="${bw2.toFixed(1)}" height="${(Y(0)-Y(b.touchRate)).toFixed(1)}" fill="var(--accent)" opacity=".85"><title>${tip}</title></rect>`;
    s+=`<rect x="${xc.toFixed(1)}" y="${Y(b.baseline).toFixed(1)}" width="${bw2.toFixed(1)}" height="${(Y(0)-Y(b.baseline)).toFixed(1)}" fill="var(--muted)" opacity=".45"><title>${tip}</title></rect>`;
  }
  s+=`<text x="${((pl+W-pr)/2).toFixed(1)}" y="${H-5}" text-anchor="middle" class="lc-ax">level distance at detection (× the name's own daily σ)</text></svg>`;
  return s;
}
function lvlHoldRow(label,c,floor){
  if(!c) return '';
  const ex=c.excess!=null?`<span class="${c.excess>=0?'pos':'neg'}">${(c.excess>=0?'+':'')+(c.excess*100).toFixed(1)}pp</span>`:'—';
  const hb=c.holdBaseline!=null?lvlPct(c.holdBaseline):'—';
  const hEx=(c.holdRate!=null&&c.holdBaseline!=null)?`<span class="${c.holdRate-c.holdBaseline>=0?'pos':'neg'}">${((c.holdRate-c.holdBaseline)>=0?'+':'')+((c.holdRate-c.holdBaseline)*100).toFixed(1)}pp</span>`:'—';
  const tip=`${label} · n=${c.n}, ${c.nTouched} touched&#10;touch ${lvlPct(c.touchRate)} vs control ${lvlPct(c.baseline)}&#10;hold ${lvlPct(c.holdRate)} vs control ${hb}${c.medBeyondSd!=null?'&#10;median run past a BROKEN level: '+c.medBeyondSd.toFixed(2)+'σ':''}${(c.nTouched<floor)?'&#10;hold cells under the '+floor+'-touch floor stay —':''}`;
  return `<tr title="${tip}"><td>${label}</td><td>${c.n.toLocaleString()}</td><td>${lvlPct(c.touchRate)}</td><td>${ex}</td>`+
    `<td>${lvlPct(c.holdRate)}</td><td>${hb}</td><td>${hEx}</td><td>${c.medBeyondSd!=null?c.medBeyondSd.toFixed(2)+'σ':'—'}</td></tr>`;
}
function renderLevels(lv){
  const cov=lv.coverage||{};
  const st=studyScopeState('levels'), one=st.sel&&lv.byTicker?lv.byTicker[st.sel]:null;
  const scope=`<span class="lbl">scope</span>`+studyScopeSel('lvlsel',lv.byTicker,st.sel);
  const note=one?`<span class="rt">${esc(one.ticker)} · ${one.n} level-events — within-name time series (each event one obs; pooled chart above is unchanged)</span>`
    :`<span class="rt">${cov.tickers||0} equities · ${lv.n.toLocaleString()} level-events · ${cov.windowDays||180}d daily bars off the hourly spine · walk-forward every ${cov.stride||5} bars, ${lv.horizon}-bar horizon</span>`;
  const controls=`<div class="s-ctrls">${scope}${note}</div>`;
  const o=lv.overall;
  const head=sHead('Structural level validation','does the -09 detector\'s output earn its place on the chart');
  const chartSrc=(one&&one.buckets)?one:lv;
  const chart=sCard(lvlTouchSvg(chartSrc));
  const cap1=sCap((one&&one.buckets?`<b>${esc(one.ticker)}</b> distance buckets — one name's events, so most cells sit under the floor by construction; dim slots disclose their n. `:'')+'Orange = how often a detected level was touched inside the horizon; grey = a same-distance permutation control resolved through the identical bar test. The gap is the only signal: above control, levels attract; below, they repel; equal, the detector is drawing noise. Dim slots sit under the '+lv.cellFloor+'-event floor and publish nothing. <b>Hover</b> any bar for exact rates and n.');
  const src=one||lv, srcT=one?one.byTouches:lv.byTouches;
  const rows=[lvlHoldRow(one?esc(one.ticker)+' — all levels':'All levels',Object.assign({n:src.n,medBeyondSd:null},src.overall||o),lv.cellFloor)];
  const side={res:'Resistance',sup:'Support',flip:'Flip — served both sides'};
  if(!one) for(const k of ['res','sup','flip']) if(lv.bySide[k]) rows.push(lvlHoldRow(side[k],lv.bySide[k],lv.cellFloor));
  for(const k of ['2','3','4+']) if(srcT&&srcT[k]) rows.push(lvlHoldRow(k+'-touch levels',srcT[k],lv.cellFloor));
  // Volume-profile HVN audit (-22): same loop, same placebo, same floors as everything above —
  // directly comparable. Until this row shows excess over control, the level map's hvn weight
  // is hand-set and no HVN may be cited as a measured edge.
  if(!one && lv.profile && lv.profile.overall) rows.push(lvlHoldRow('Volume-profile HVNs (audit)',Object.assign({n:lv.profile.n,medBeyondSd:null},lv.profile.overall),lv.profile.cellFloor||lv.cellFloor));
  const table=`<div class="s-card" style="overflow-x:auto"><table class="ptbl" style="min-width:640px"><thead><tr>`+
    `<th>group</th><th>n</th><th>touch</th><th>vs ctl</th><th>hold</th><th>hold ctl</th><th>vs ctl</th><th>run past</th>`+
    `</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const cap2=sCap('Hold = the touch bar closed back on the side price came from; run past = how far a BROKEN level was exceeded before the horizon — the stop-run cost of a void parked there. The touch-count split audits the detector\'s own minimum (2 touches): if 2-touch rows show no hold edge over control while 4+ does, the snap rule is anchoring AI voids to noise. Out of sample by construction; the control is matched per event, validated unbiased on pooled random walks. <b>Hover</b> a row for the full readout. The <b>Volume-profile HVNs</b> row runs walk-forward profile nodes through this same loop and control \u2014 the measurement that decides whether the level map\u2019s hand-set hvn weight ever becomes an earned one. LVNs are traversal features (thin volume), not touch/hold claims, and are deliberately not audited here.');
  return head+controls+chart+cap1+table+cap2;
}
// ---- session anatomy (sections.anatomy) ----
// Four descriptive base-rate panels off one per-session record pass. Descriptive means
// descriptive: openQ conditions on the realized range (readable only after the fact) and the
// captions say so. Rates are day-pooled; the honest n is days/weeks, never ticker-sessions.
// ---- EMA200 trend events (sections.ema200, build -26) ----
// Close-confirmed crosses + retests of the 200-EMA vs matched placebo. Crosses come as
// tf.cross.{up,dn}.{raw,buf,2cl} cells; retests ride the structural-level study's own
// aggregator (tf.retest.bySide.sup/res), so those rows are column-compatible with the
// section above. Everything renders from the server payload — nothing re-derived here.
function emaXCell(c,floor,dip){
  if(!c) return '<td class="dim2">·</td><td class="dim2">·</td><td class="dim2">·</td><td class="dim2">·</td><td class="dim2">·</td><td class="dim2">·</td>';
  if(c.hit==null) return `<td>${c.n}</td><td class="dim2">·</td><td class="dim2">·</td><td class="dim2">·</td><td class="dim2" data-tip="n=${c.n} sits under the ${floor}-event floor — the cell publishes its n and nothing else; an early rate on this few events is a coin path wearing a percentage">under floor</td><td class="dim2">·</td>`;
  const ex=Math.round((c.hit-c.placebo)*100);
  return `<td>${c.n}</td><td class="${c.med>0?'pos':c.med<0?'neg':''}">${c.med>0?'+':''}${c.med.toFixed(2)}σ</td>`
    +`<td>${Math.round(c.hit*100)}%</td><td class="sec">${Math.round(c.placebo*100)}%</td>`
    +`<td class="${ex>0?'pos':ex<0?'neg':''}" data-tip="hit ${Math.round(c.hit*100)}% vs matched placebo ${Math.round(c.placebo*100)}% on n=${c.n}${dip?' · '+dip:''}">${ex>0?'+':''}${ex}pp</td>`
    +`<td class="sec" data-tip="share of fired events that closed back through the line within 5 bars — the whipsaw tax this confirmation variant pays down">${Math.round(c.whip*100)}%</td>`;
}
function emaRtRow(label,cell,floor,tip){
  if(!cell||cell.n==null) return '';
  const under=cell.holdRate==null;
  const hb=cell.holdBaseline, ex=(!under&&hb!=null)?Math.round((cell.holdRate-hb)*100):null;
  return `<tr data-tip="${esc(tip)}"><td>${label} <span class="pill2">levels loop</span></td><td>${cell.n}</td>`
    +(under?`<td class="dim2">·</td><td class="dim2">·</td><td class="dim2">·</td><td class="dim2" data-tip="touched-level events under the hold floor — publishes n only">under floor</td><td class="dim2">·</td>`
    :`<td class="sec" data-tip="share of detected EMA-level events that were touched inside the horizon">${cell.touchRate!=null?Math.round(cell.touchRate*100)+'%':'·'}</td>`
      +`<td>${Math.round(cell.holdRate*100)}% <i class="ft">hold</i></td><td class="sec">${hb!=null?Math.round(hb*100)+'%':'·'}</td>`
      +`<td class="${ex>0?'pos':ex<0?'neg':''}">${ex!=null?(ex>0?'+':'')+ex+'pp':'·'}</td><td class="dim2">—</td>`)+'</tr>';
}
function renderEma200(em){
  const head=sHead('EMA200 trend events','close-confirmed crosses and retests of the most common trend EMA — does the line earn the reverence · study tier, nothing trades');
  const ctrl=`<div class="s-ctrls"><span class="rt" data-tip="Walk-forward: the EMA is SMA-seeded exactly as every other EMA in the app, events fire only on CLOSED candles, forward outcomes measured strictly after the firing bar in the rung's own bar-σ. Placebo: deterministic permutation anchors resolved through the identical loop — excess is edge over matched noise, not over a formula. Re-arm: after a stream fires it stays blocked until ${em.rearm} consecutive closes on the far side reset the episode; blocked fires are counted on the TF header hover, never silently eaten. Tail events whose horizon runs past the tape are excluded whole.">close-confirmed · re-arm ${em.rearm} closes · horizon ${em.horizons['1d']} bars (D1) · ${em.horizons['4h']} bars (H4) · placebo-matched · hover anything</span></div>`;
  // ---- the variant duel: event hit vs matched placebo, per TF x direction x confirmation ----
  const groups=[]; for(const tf of ['1d','4h']){ const T=em.tf[tf]; if(!T) continue;
    for(const d of ['up','dn']) groups.push({g:(tf==='1d'?'D1':'H4')+(d==='up'?' brk-out':' brk-dn'),rows:['raw','buf','2cl'].map(v=>[v,T.cross[d][v]])}); }
  let sv='',x=14; const Y0=96,SC=2.6;
  for(const grp of groups){ const x0=x;
    for(const [v,c] of grp.rows){
      if(!c||c.hit==null){ sv+=`<rect x="${x}" y="${Y0-18}" width="9" height="18" fill="var(--grid)" data-tip="${grp.g} · ${v}: ${c?('n='+c.n+' — under the '+em.cellFloor+'-event floor, publishes nothing'):'no events yet'}"/><rect x="${x+10}" y="${Y0-18}" width="9" height="18" fill="var(--grid)" fill-opacity="0.6"/>`; }
      else{ const h1=Math.max(2,(c.hit*100-35)*SC),h2=Math.max(2,(c.placebo*100-35)*SC);
        sv+=`<rect x="${x}" y="${(Y0-h1).toFixed(1)}" width="9" height="${h1.toFixed(1)}" fill="var(--accent)" data-tip="${grp.g} · ${v}: hit ${Math.round(c.hit*100)}% vs placebo ${Math.round(c.placebo*100)}% → excess ${c.excess>0?'+':''}${Math.round(c.excess*100)}pp (n=${c.n})"/>`
          +`<rect x="${x+10}" y="${(Y0-h2).toFixed(1)}" width="9" height="${h2.toFixed(1)}" fill="var(--dim2,#3a465a)" data-tip="${grp.g} · ${v}: matched placebo ${Math.round(c.placebo*100)}%"/>`; }
      sv+=`<text x="${x+9}" y="${Y0+10}" fill="var(--faint)" font-size="8" text-anchor="middle">${v}</text>`; x+=30; }
    sv+=`<text x="${(x0+x-30+9)/2}" y="${Y0+21}" fill="var(--muted)" font-size="8.5" text-anchor="middle">${grp.g}</text>`; x+=14; }
  sv+=`<line x1="8" y1="${Y0}" x2="${x}" y2="${Y0}" stroke="var(--grid)"/>`;
  const chart=sCard(`<div style="overflow-x:auto"><svg viewBox="0 0 ${x+6} 124" width="${x+6}" height="124">${sv}</svg></div><div class="s-cap" style="margin:6px 0 0">orange = event hit · grey = matched placebo · dim = under the ${em.cellFloor}-event floor</div>`);
  const cap1=sCap('<b>Three definitions duel per side</b> — raw close-cross, ≥'+em.bufSd+'σ buffered close, and two-consecutive-close — because "the" EMA200 break has no canonical definition and picking one by hand is how false precision starts. Whichever variant shows excess over its matched placebo (and survives out of sample) becomes a ledger shadow candidate; the others are the disclosed cost of asking. Crosses fire on <b>closed candles only</b> — an intrabar poke that closes back never counts.');
  // ---- the table ----
  const VL={raw:'raw close',buf:'≥'+em.bufSd+'σ buffer','2cl':'2-close confirm'};
  let rows='';
  for(const tf of ['1d','4h']){ const T=em.tf[tf]; if(!T) continue;
    const sup=T.suppressed, supTxt=`chop suppressed by the re-arm gate: raw ${sup.raw} · buf ${sup.buf} · 2cl ${sup['2cl']}`;
    rows+=`<tr class="tfh"><td colspan="7" data-tip="${esc(`${T.contributing} names contributing · ${T.n} cross events pooled · ${supTxt}`)}">${tf==='1d'?`D1 · horizon ${em.horizons['1d']} bars · both universes (crypto dailies 370d)`:`H4 · horizon ${em.horizons['4h']} bars (≈14d) · both universes (crypto: 90d spine → the walk is thin by construction, disclosed not hidden)`}</td></tr>`;
    for(const d of ['up','dn']) for(const v of ['raw','buf','2cl'])
      rows+=`<tr data-tip="${esc(`${d==='up'?'Breakout':'Breakdown'} — ${VL[v]}. Outcome signed with the event's direction: a breakdown that falls scores POSITIVE. σ = this rung's own bar volatility. ${supTxt}`)}"><td>${d==='up'?'Breakout':'Breakdown'} — ${VL[v]}</td>${emaXCell(T.cross[d][v],em.cellFloor)}</tr>`;
    if(T.retest){
      rows+=emaRtRow('Support retest (bullish)',T.retest.bySide&&T.retest.bySide.sup,T.retest.cellFloor,'EMA200 fed through the injectable level audit as a walk-forward level: intrabar touch from ABOVE, HELD = the touch bar closed back above — the bullish retest. Same touch/hold loop and permutation control as the Structural level validation section; rows directly comparable.');
      rows+=emaRtRow('Resistance retest (bearish)',T.retest.bySide&&T.retest.bySide.res,T.retest.cellFloor,'Touch from BELOW into an overhead EMA200, HELD = the close rejected back under — the bearish retest. Same loop and control as the structural study.');
    }
  }
  const table=`<div class="s-card" style="overflow-x:auto"><table class="ptbl" style="min-width:680px"><thead><tr>`
    +`<th>event</th><th data-tip="episodes fired after the re-arm gate — chop dupes suppressed; counts on the TF header hover">n</th>`
    +`<th data-tip="median forward move over the horizon from the firing close, in the rung's own bar-σ, signed with the event's direction">fwd med</th>`
    +`<th data-tip="share of events whose forward move went the event's way — for retest rows this is the HOLD rate">hit</th>`
    +`<th data-tip="matched permutation placebo through the identical resolution loop — the honest null for this tape's drift and discreteness">placebo</th>`
    +`<th data-tip="hit − placebo, percentage points. The only column that means anything.">excess</th>`
    +`<th data-tip="share of fires that closed back through the line within 5 bars — the whipsaw tax each confirmation variant is trying to buy down. Retests: not applicable">whip 5b</th>`
    +`</tr></thead><tbody>${rows}</tbody></table></div>`;
  const cap2=sCap('<b>Reading it:</b> the excess column is the whole panel — everything else is context for it. Crosses resolve at a fixed forward horizon in σ units; retests ride the structural-level study\u2019s own touch/hold loop and control, so their rows read one-to-one against the section above. <b>Whip 5b</b> is the tax each confirmation variant pays down: raw fires earliest and chops hardest, 2-close fires latest and chops least — the excess column says whether the patience was paid for. H12 is out (the crypto spine cannot converge an EMA200 there); the H4 crypto walk is thin and says so. Nothing here trades: a variant showing excess graduates to a shadow event and earns its record out of sample like everything else.');
  return head+ctrl+chart+cap1+table+cap2;
}
function anMfeSvg(m){
  const labs=m.edges.map((e,i)=>(i?m.edges[i-1]:0)+'–'+e).concat([m.edges[m.edges.length-1]+'+']);
  const n=labs.length, W=560,H=240,pl=44,pr=14,pt=14,pb=36;
  const mid=(pt+H-pb)/2, half=(H-pt-pb)/2-4;
  const cap=Math.max(...m.upShare,...m.dnShare,0.001);
  const bw=(W-pl-pr)/n, X=i=>pl+i*bw;
  let s=`<svg viewBox="0 0 ${W} ${H}" class="lchart" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">`;
  s+=`<line x1="${pl}" y1="${mid}" x2="${W-pr}" y2="${mid}" stroke="var(--grid)" stroke-width="1"/>`;
  for(const g of [0.5,1]){ for(const k of [1,-1]){ const y=(mid-k*g*half).toFixed(1);
    s+=`<line x1="${pl}" y1="${y}" x2="${W-pr}" y2="${y}" stroke="var(--grid)" stroke-width="1" opacity=".45"/>`+
       `<text x="${pl-7}" y="${(+y+3.5).toFixed(1)}" text-anchor="end" class="lc-tick">${(g*cap*100).toFixed(0)}%</text>`; } }
  for(let i=0;i<n;i++){
    const hu=m.upShare[i]/cap*half, hd=m.dnShare[i]/cap*half, x=X(i);
    const tip=(d,v)=>`${labs[i]}σ · max ${d} excursion from open&#10;${(v*100).toFixed(1)}% of ${m.n.toLocaleString()} ${m.basis||'sd-scored ticker-sessions'}`;
    s+=`<rect x="${(x+2).toFixed(1)}" y="${(mid-hu).toFixed(1)}" width="${(bw-4).toFixed(1)}" height="${hu.toFixed(1)}" fill="var(--up)" opacity=".7"><title>${tip('UP',m.upShare[i])}</title></rect>`;
    s+=`<rect x="${(x+2).toFixed(1)}" y="${mid.toFixed(1)}" width="${(bw-4).toFixed(1)}" height="${hd.toFixed(1)}" fill="var(--down)" opacity=".7"><title>${tip('DOWN',m.dnShare[i])}</title></rect>`;
    if(i%2===0) s+=`<text x="${(x+bw/2).toFixed(1)}" y="${H-pb+15}" text-anchor="middle" class="lc-tick">${labs[i]}</text>`;
  }
  const medX=v=>pl+Math.min(n-0.02,(v/ (m.edges[m.edges.length-1]+0.25))*n)*bw;
  if(m.medUpSd!=null) s+=`<line x1="${medX(m.medUpSd).toFixed(1)}" y1="${(mid-half).toFixed(1)}" x2="${medX(m.medUpSd).toFixed(1)}" y2="${mid}" stroke="var(--up)" stroke-width="1.4" stroke-dasharray="3 3"><title>median up excursion ${m.medUpSd}σ</title></line>`;
  if(m.medDnSd!=null) s+=`<line x1="${medX(m.medDnSd).toFixed(1)}" y1="${mid}" x2="${medX(m.medDnSd).toFixed(1)}" y2="${(mid+half).toFixed(1)}" stroke="var(--down)" stroke-width="1.4" stroke-dasharray="3 3"><title>median down excursion ${m.medDnSd}σ</title></line>`;
  s+=`<text x="${((pl+W-pr)/2).toFixed(1)}" y="${H-5}" text-anchor="middle" class="lc-ax">max excursion from the session open (× the name's own pre-session σ)</text></svg>`;
  return s;
}
function anPct(x){ return x==null?'—':(x*100).toFixed(1)+'%'; }
// -19: a per-name scope whose cells all sit under the sample floor renders a wall of em-dashes,
// which reads as "broken" rather than "not enough data yet". Mirror what the MFE histogram already
// does — fall back to the pooled table and say so out loud. The floor is NEVER lowered: a rate on
// n=8 is +/-35pp and publishing it would be exactly the false precision this app refuses.
function _anyCell(rows,keys){ return !!rows&&rows.some(r=>keys.some(k=>r[k]!=null)); }
function _fbNote(name,scopeLabel){ return `<div class="s-cap" style="margin-top:-4px"><b>${scopeLabel}</b> has too few sessions per bucket for its own ${name} \u2014 the table stays pooled.</div>`; }
function renderAnatomy(an){
  const cov=an.coverage||{};
  const st=studyScopeState('anatomy'), one=st.sel&&an.byTicker?an.byTicker[st.sel]:null;
  const head=sHead('Session anatomy','how far a session travels, where opens sit, what Monday contains, which opens stay naked');
  const scope=`<span class="lbl">scope</span>`+studyScopeSel('anatsel',an.byTicker,st.sel);
  const note=one?`<span class="rt">${esc(one.ticker)} · ${one.sessions} sessions — within-name time series (each session one obs; histogram stays pooled)</span>`
    :`<span class="rt">${an.tickers} equities · ${an.days} UTC sessions · ${an.tickerSessions.toLocaleString()} ticker-sessions (${an.sdSessions.toLocaleString()} σ-scored) · ${cov.windowDays||180}d spine</span>`;
  const controls=`<div class="s-ctrls">${scope}${note}</div>`;
  // Chart follows the scope: per-name histogram when it clears the floor (same edges/binning as
  // the pool — one code path server-side), else the pooled chart with the fallback said out loud.
  const oneHist=one&&one.mfeHist?Object.assign({medUpSd:one.mfe.medUpSd,medDnSd:one.mfe.medDnSd,basis:esc(one.ticker)+' sd-scored sessions'},one.mfeHist):null;
  const mfeSrc=oneHist||an.mfe;
  const mfeBlock=sCard(anMfeSvg(mfeSrc))+
    sCap((oneHist?`<b>${esc(one.ticker)}</b> — within-name histogram over ${oneHist.n} sd-scored sessions. `
      :(one?`<b>${esc(one.ticker)}</b> has too few sd-scored sessions for its own histogram — the chart stays pooled. `:''))+
    `Green above the axis = the session's maximum push UP from its open; red below = maximum push DOWN, each in the name's own pre-session σ (frozen before the session — no lookahead). Medians dashed: ${mfeSrc.medUpSd??'—'}σ up / ${mfeSrc.medDnSd??'—'}σ down. This is the yardstick for every level: a target beyond the typical excursion needs more than one session to be reachable. <b>Hover</b> a bar for its share.`);
  const oneMfe=one?`<div class="s-cap" style="margin-top:-4px"><b>${esc(one.ticker)}</b> medians: up ${one.mfe.medUpSd??'—'}σ (${one.mfe.medUpPct??'—'}%) · down ${one.mfe.medDnSd??'—'}σ (${one.mfe.medDnPct??'—'}%) over ${one.sdSessions} σ-scored sessions.</div>`:'';
  const QL=['lowest quarter','lower middle','upper middle','highest quarter'];
  const qOne=one?one.quartiles.map(q=>({q:q.q,closedAbove:q.closedAbove,firstHr:q.firstHr,medRangeSd:null,nDays:q.n,nTS:q.n})):null;
  const qFallback=!!qOne&&!_anyCell(qOne,['closedAbove','firstHr']);
  const qSrc=qFallback?an.quartiles:(qOne||an.quartiles);
  const qScope=qFallback?null:one;   // row tooltips must describe the scope actually shown
  const qMed=!qScope;   // median day range is pooled-only — omit the column per-name rather than ship a dash column
  const qRows=qSrc.map(q=>{
    const tip=`Q${q.q} — open in the ${QL[q.q-1]} of the day's eventual range&#10;closed above open ${anPct(q.closedAbove)} · extreme in first UTC hour ${anPct(q.firstHr)}&#10;median day range ${q.medRangeSd!=null?q.medRangeSd+'σ':'—'}&#10;${qScope?`n = ${q.nDays} sessions — within-name time series`:`n = ${q.nDays} days (cross-sectional means, ≥${cov.minCross||3} names/day) · ${q.nTS.toLocaleString()} ticker-sessions`}`;
    return `<tr title="${tip}"><td>Q${q.q} — ${QL[q.q-1]}</td><td>${anPct(q.closedAbove)}</td><td>${anPct(q.firstHr)}</td>${qMed?`<td>${q.medRangeSd!=null?q.medRangeSd.toFixed(2)+'σ':'—'}</td>`:''}<td>${q.nDays}</td></tr>`;
  }).join('');
  const qTable=(qFallback?_fbNote('open-quartile splits',esc(one.ticker)):'')+`<div class="s-card" style="overflow-x:auto"><table class="ptbl" style="min-width:520px"><thead><tr>`+
    `<th>open quartile</th><th>closed above</th><th>extreme in 1st hr</th>${qMed?'<th>med range</th>':''}<th>n (${qScope?'sessions':'days'})</th></tr></thead><tbody>${qRows}</tbody></table></div>`+
    sCap(`Which quarter of the day's <em>eventual</em> range the open landed in. Q1's high close-above rate is mostly mechanical — conditioning on the realized range makes these readable only after the fact. Base rates for context, never an entry. <b>Hover</b> a row for the full readout.`);
  const moOne=one?{weeks:one.monday.weeks,contained:one.monday.contained,breakUp:null,breakDown:null,breakBoth:null,medDaysToBreak:null,nBreaks:null}:null;
  const moFallback=!!moOne&&moOne.contained==null;
  const mo=moFallback?an.monday:(moOne||an.monday);
  const nkOne=one?{horizons:one.naked.horizons,revisit:one.naked.horizons.map(h=>one.naked.revisit[h]),nDays:one.naked.horizons.map(()=>one.sessions)}:null;
  const nkFallback=!!nkOne&&!nkOne.revisit.some(x=>x!=null);
  const nk=nkFallback?an.naked:(nkOne||an.naked);
  const moTip=`Monday range as the week's container · ${mo.weeks} pooled weeks&#10;held all week ${anPct(mo.contained)}&#10;first break up ${anPct(mo.breakUp)} · down ${anPct(mo.breakDown)} · both sides same session ${anPct(mo.breakBoth)}&#10;median sessions to first break: ${mo.medDaysToBreak??'—'} · ${mo.nBreaks} break events`;
  const nkRow=nk.horizons.map((h,i)=>`<td title="open revisited within ${h} session(s) — day-pooled over ${nk.nDays[i]} anchor days">${anPct(nk.revisit[i])}</td>`).join('');
  const moNk=((moFallback||nkFallback)?_fbNote('weekly / naked-open rates',esc(one.ticker)):'')+`<div class="s-card" style="overflow-x:auto"><table class="ptbl" style="min-width:520px"><thead><tr>`+
    `<th>weekly &amp; open studies</th><th colspan="4">rates</th></tr></thead><tbody>`+
    `<tr title="${moTip}"><td>Monday range held all week</td><td>${anPct(mo.contained)}</td><td class="sec" colspan="3">${mo.breakUp!=null?`breaks: ${anPct(mo.breakUp)} up · ${anPct(mo.breakDown)} down · ${anPct(mo.breakBoth)} both — median ${mo.medDaysToBreak??'—'} session(s) to break (${mo.weeks} wks)`:`${mo.weeks} weeks — break-direction split needs the pooled scope`}</td></tr>`+
    `<tr><td title="a session's open traded back through within N later sessions — untested (naked) opens are the complement">Open revisited within 1 / 3 / 5 / 10 sessions</td>${nkRow}</tr>`+
    `</tbody></table></div>`+
    sCap(`Monday's [low, high] as the week's container on a 24/7 book — "both" marks a session that pierced both sides, unorderable at daily granularity and counted separately rather than guessed. The revisit row is the naked-open study: the complement of each rate is the share of opens still untested at that horizon. <b>Hover</b> any cell for n.`);
  return head+controls+mfeBlock+oneMfe+qTable+moNk;
}
// ---- candle behaviour (sections.anatomy.candles) ----
const CB_LABELS={outside:'Outside bar',inside:'Inside bar',doji:'Doji',strongBull:'Strong bull close',strongBear:'Strong bear close',plain:'Plain'};
const CB_TIPS={outside:'engulfed the prior bar both sides',inside:'held inside the prior bar',doji:'body ≤ 20% of range',strongBull:'up day closing in the top fifth of its range',strongBear:'down day closing in the bottom fifth',plain:'everything else'};
function renderCandles(an){
  const cd=an.candles; if(!cd||!cd.n) return '';
  const st=studyScopeState('candles'), one=st.sel&&an.byTicker?an.byTicker[st.sel]:null;
  const head=sHead('Candle behaviour','what each daily bar type was followed by');
  const scope=`<span class="lbl">scope</span>`+studyScopeSel('cbsel',an.byTicker,st.sel);
  const note=one?`<span class="rt">${esc(one.ticker)} — within-name time series</span>`:`<span class="rt">${cd.n.toLocaleString()} typed bars · follow-through in the NEXT session's own σ, signed with the type's thesis</span>`;
  // If not one bar type clears the follow-through floor for this name, the per-name table would be
  // an all-dash column. Fall back to pooled wholesale (never a per-name share next to a pooled
  // follow — mixing scopes in one row is worse than either scope alone) and label it.
  const cbFallback=!!one&&!cd.types.some(t=>{ const o=one.candles&&one.candles[t.type]; return o&&o.follow!=null; });
  const cbOne=cbFallback?null:one;
  const rows=cd.types.filter(t=>t.nTS>0).map(t=>{
    const one=cbOne, oneT=one&&one.candles[t.type];
    const fol=one?(oneT?oneT.follow:null):t.follow;
    const shr=one?(oneT?oneT.share:null):t.share;
    const rgx=one?(oneT?oneT.rngX:null):t.rngX;
    const nStr=one?(oneT?oneT.n+' bars':'—'):`${t.nDays} days`;
    const folCell=fol==null?'—':`<span class="${fol>=0?'pos':'neg'}">${fol>=0?'+':''}${fol.toFixed(2)}R</span>`;
    const tip=`${CB_LABELS[t.type]} — ${CB_TIPS[t.type]}&#10;${one?`${esc(one.ticker)}: ${oneT?oneT.n:0} bars — share ${anPct(shr)} of its own typed bars, mean follow ${fol==null?'—':fol.toFixed(2)+'R'}&#10;next-session range ${rgx!=null?rgx+'× the name\'s own unconditional median':'—'}`:`share ${anPct(t.share)} of all bars · mean signed follow ${fol==null?'—':fol.toFixed(2)+'R'} over ${t.nDays} pooled days&#10;next-session range ${t.rngX!=null?t.rngX+'× the unconditional median':'—'}`}&#10;cells under the floor stay —`;
    return `<tr title="${tip}"><td>${CB_LABELS[t.type]}</td><td>${anPct(shr)}</td><td>${folCell}</td><td>${rgx!=null?rgx.toFixed(2)+'×':'—'}</td><td>${nStr}</td></tr>`;
  }).join('');
  const table=(cbFallback?_fbNote('follow-through rates',esc(one.ticker)):'')+`<div class="s-card" style="overflow-x:auto"><table class="ptbl" style="min-width:520px"><thead><tr><th>bar type</th><th>share</th><th>next-day follow</th><th>next range</th><th>n</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const cap=sCap('Follow-through is the next session\'s close-to-close move in that session\'s own pre-frozen σ, signed with the bar\'s thesis — a strong bear close followed by more downside scores <em>positive</em>. Neutral types (doji, inside, outside) stay raw-signed. Descriptive conditionals, not signals. <b>Hover</b> a row for the full readout.');
  return head+`<div class="s-ctrls">${scope}${note}</div>`+table+cap;
}
// ---- time-based pivots (sections.anatomy.pivots) ----
function pivotHistSvg(pv){
  const W=560,H=210,pl=40,pr=12,pt=12,pb=30;
  const cap=Math.max(...pv.hi.share,...pv.lo.share,0.001);
  const bw=(W-pl-pr)/24, Y=v=>pt+(1-v/cap)*(H-pt-pb);
  let s=`<svg viewBox="0 0 ${W} ${H}" class="lchart" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">`;
  if(_szCash()){ const rx=pl+13.5*bw, rw=(20-13.5)*bw;
    s+=`<rect x="${rx.toFixed(1)}" y="${pt}" width="${rw.toFixed(1)}" height="${H-pt-pb}" fill="var(--blue)" opacity="0.06"><title>US cash session (13:30–20:00 UTC)</title></rect>`; }
  for(let h=0;h<24;h++){
    const x=pl+h*bw, hw=(bw-3)/2;
    const basisH=pv.basis?`${pv.basis} — share of its ${pv.hi.nDays} sessions`:`% of names (mean of ${pv.hi.nDays} daily distributions)`;
    const basisL=pv.basis?`${pv.basis} — share of its ${pv.lo.nDays} sessions`:`% of names (mean of ${pv.lo.nDays} daily distributions)`;
    s+=`<rect x="${(x+1).toFixed(1)}" y="${Y(pv.hi.share[h]).toFixed(1)}" width="${hw.toFixed(1)}" height="${(Y(0)-Y(pv.hi.share[h])).toFixed(1)}" fill="var(--up)" opacity=".75"><title>day HIGH printed in ${h}:00 UTC — ${(pv.hi.share[h]*100).toFixed(1)}% · ${basisH}</title></rect>`;
    s+=`<rect x="${(x+2+hw).toFixed(1)}" y="${Y(pv.lo.share[h]).toFixed(1)}" width="${hw.toFixed(1)}" height="${(Y(0)-Y(pv.lo.share[h])).toFixed(1)}" fill="var(--down)" opacity=".75"><title>day LOW printed in ${h}:00 UTC — ${(pv.lo.share[h]*100).toFixed(1)}% · ${basisL}</title></rect>`;
    if(h%4===0) s+=`<text x="${(x+bw/2).toFixed(1)}" y="${H-pb+14}" text-anchor="middle" class="lc-tick">${h}:00</text>`;
  }
  s+=`<text x="${((pl+W-pr)/2).toFixed(1)}" y="${H-4}" text-anchor="middle" class="lc-ax">UTC hour the session extreme printed · green = high, red = low${_szCash()?' · blue band = US cash':''}</text></svg>`;
  return s;
}
function renderPivots(an){
  if(!an.pivots||!an.pivots.hi||!an.pivots.hi.nDays) return '';
  const st=studyScopeState('pivots'), one=st.sel&&an.byTicker?an.byTicker[st.sel]:null;
  // Within-name mode: each session one observation — a different n basis than the pooled
  // cross-sectional mean, labeled as such. Under the floor the pooled histogram stays and says so.
  const pv=one&&one.pivots?Object.assign({basis:esc(one.ticker)},one.pivots):an.pivots;
  const head=sHead('Time-based pivots','when the day\'s extremes actually print');
  const scope=`<span class="lbl">scope</span>`+studyScopeSel('pvsel',an.byTicker,st.sel);
  const note=pv.basis?`<span class="rt">${pv.basis} · ${pv.hi.nDays} sessions — within-name time series (each session one obs; no cross-sectional pooling for one name)</span>`
    :(one?`<span class="rt">${esc(one.ticker)} has too few sessions for its own histogram — showing the pooled study · ${an.pivots.hi.nDays} pooled days</span>`
    :`<span class="rt">${an.pivots.hi.nDays} pooled days · each day one cross-sectional distribution — one violent tape day cannot own the histogram</span>`);
  const controls=`<div class="s-ctrls">${scope}${note}</div>`;
  // The histogram already falls back to pooled under the floor; the conditional rates need the same
  // treatment or they render as two bare dashes under a per-name header.
  const cvFallback=!!pv.basis&&pv.earlyLowUp.rate==null&&pv.earlyHighDown.rate==null;
  const cv=cvFallback?an.pivots:pv;
  const el2=cv.earlyLowUp, eh=cv.earlyHighDown;
  const nb=(cvFallback?false:pv.basis)?'qualifying sessions — within-name; rates under the floor stay —':'days';
  const cond=(cvFallback?_fbNote('early-extreme conditionals',esc(one.ticker)):'')+`<div class="s-card" style="overflow-x:auto"><table class="ptbl" style="min-width:480px"><thead><tr><th>conditional</th><th>rate</th><th title="${nb}">n (${(cvFallback?false:pv.basis)?'sessions':'days'})</th></tr></thead><tbody>`+
    `<tr title="the day's LOW printed before ${pv.earlyH}:00 UTC — how often the session then closed ABOVE its open (the early-low trend-day folklore, measured)&#10;n basis: ${nb}"><td>Low in first ${pv.earlyH}h → closed above open</td><td>${anPct(el2.rate)}</td><td>${el2.nDays}</td></tr>`+
    `<tr title="the day's HIGH printed before ${pv.earlyH}:00 UTC — how often the session then closed BELOW its open&#10;n basis: ${nb}"><td>High in first ${pv.earlyH}h → closed below open</td><td>${anPct(eh.rate)}</td><td>${eh.nDays}</td></tr>`+
    `</tbody></table></div>`;
  const cap=sCap(_szCash()
    ? 'An extreme that prints early and holds is the trend-day signature — but its rate is only meaningful against the ~50% coin-flip base, and the histogram is the context: on a 24/7 synthetic book the extremes cluster where the underlying cash session concentrates variance. <b>Hover</b> any bar or row for exact shares and n.'
    : 'An extreme that prints early and holds is the trend-day signature — but its rate is only meaningful against the ~50% coin-flip base. On a continuous book the extremes spread across all 24 UTC hours rather than concentrating in a cash window; where they cluster is this histogram\'s story. <b>Hover</b> any bar or row for exact shares and n.');
  return head+controls+sCard(pivotHistSvg(pv))+cond+cap;
}
function wireRegimeControls(){ const s=el('regimesel'); if(!s) return; s.addEventListener('change',()=>{ if(!state.analytics.regime) state.analytics.regime={sel:'all'}; state.analytics.regime.sel=s.value; drawSessions(); }); }
// ===== Sessions tab: grouped, collapsible layout (build 2026.07.24-15) =====
// The tab used to be one blind scroll: a blurb, four coverage cards, a readiness bar, eleven
// studies fully expanded, then a separate "on deck" table. Reorganized: one status line (the
// coverage bookkeeping collapses once ready hits 100% — full numbers stay on hover), a sticky
// jump bar, and five thematic groups. Each group header carries a one-line live verdict computed
// from the SAME section payload its panels render — one code path, the verdict can never disagree
// with the chart. Open state persists per browser like the tab order. Pending studies stay
// visible as dimmed rows inside their own group with the same "computing — needs X" wording;
// nothing pending is hidden, it just stops being a separate table.
const SESS_GROUPS=[
  {id:'positioning',label:'Positioning'},
  {id:'holds',label:'Holds'},
  {id:'clocks',label:'Clocks'},
  {id:'week',label:'Week'},
  {id:'structure',label:'Structure'}];
// -19: the payload declares which groups this universe publishes (crypto drops Clocks/Week/
// Structure — see analyticsUniverse). Client renders exactly that set; one source of truth.
function sessGroups(){ const a=state.analytics.data, g=a&&a.groups;
  return Array.isArray(g)&&g.length ? SESS_GROUPS.filter(x=>g.indexOf(x.id)>-1) : SESS_GROUPS; }
const SG_KEY='xyz-sessgroups2';   // -17: bumped from xyz-sessgroups so a stale saved set from an
                                  // earlier session can't override the intended default (positioning
                                  // + holds open, the rest collapsed). Applies to both universes —
                                  // the sessions tab shares one collapse model across crypto/stocks.
function sgOpenSet(){ if(state.analytics.sgOpen) return state.analytics.sgOpen;
  let v=null; try{ v=JSON.parse(store.get(SG_KEY)||'null'); }catch(_){}
  state.analytics.sgOpen=new Set(Array.isArray(v)?v.filter(id=>SESS_GROUPS.some(g=>g.id===id)):['positioning','holds']);
  return state.analytics.sgOpen; }
function sgToggle(id){ const s=sgOpenSet(); if(s.has(id)) s.delete(id); else s.add(id);
  store.set(SG_KEY,JSON.stringify([...s])); drawSessions(); }
// Dimmed in-group row for a study that hasn't unlocked — same honest wording the deck used.
function sgPendRow(name,detail,stars){
  return `<div class="sg-pend"><span class="sp-s">${stars||''}</span><span class="sp-n">${name}</span>`+
    `<span class="sp-d">${detail}</span><span class="sp-t">pending</span></div>`; }
function sgSection(id,label,verdict,items){
  const live=items.filter(x=>x&&x.html).map(x=>x.html);
  const pends=items.filter(x=>x&&x.pend).map(x=>x.pend);
  const open=sgOpenSet().has(id), allPend=!live.length, count=live.length+pends.length;
  return `<section class="sg${allPend?' sg-dim':''}" id="sg-${id}">`+
    `<div class="sg-h" data-g="${id}" role="button" tabindex="0" aria-expanded="${open?'true':'false'}" title="${open?'collapse':'expand'} — the state is saved in this browser">`+
    `<span class="sg-c">${open?'\u25be':'\u25b8'}</span><span class="sg-t">${label}</span>`+
    `<span class="sg-v">${verdict}</span>`+
    `<span class="sg-n">${open?'open':'collapsed'}${count>1?` \u00b7 ${count} studies`:''}</span></div>`+
    `<div class="sg-b"${open?'':' hidden'}>${live.join('')}${pends.join('')}</div></section>`;
}
function wireSessGroups(host){
  host.querySelectorAll('.sg-h').forEach(h=>{ const go=()=>sgToggle(h.dataset.g);
    h.addEventListener('click',go);
    h.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); go(); } }); });
  host.querySelectorAll('.jchip').forEach(b=>b.addEventListener('click',()=>{
    const id=b.dataset.j, s=sgOpenSet(), jump=()=>{ const t=el('sg-'+id); if(t) t.scrollIntoView({behavior:SCROLL_B,block:'start'}); };
    if(!s.has(id)){ s.add(id); store.set(SG_KEY,JSON.stringify([...s])); drawSessions(); requestAnimationFrame(jump); }
    else jump(); }));
  if(!window._sgScrollWired){ window._sgScrollWired=true;
    window.addEventListener('scroll',()=>{ const vs=el('view-sessions'); if(!vs||vs.hidden) return;
      let act=null;
      for(const g of sessGroups()){ const sec=el('sg-'+g.id); if(sec&&sec.getBoundingClientRect().top<=90) act=g.id; }
      document.querySelectorAll('#sessions-body .jchip').forEach(x=>x.classList.toggle('on',x.dataset.j===act));
    },{passive:true}); }
}
function drawSessions(){
  const host=el('sessions-body'); if(!host) return;
  // GC stale hover entries instead of wiping the registry: hoverChart is now also used by the
  // drawer candle chart, which must survive a sessions re-render. _hoverSeq is never reset —
  // resetting it could reissue an id that a still-live chart owns.
  for(const id in _hoverReg) if(!document.getElementById(id)) delete _hoverReg[id];
  const a=state.analytics.data, err=state.analytics.err;
  const title=`<div class="cp-head" style="margin-bottom:6px">Session &amp; time-of-day analytics</div>`;
  if(err && !a){ host.innerHTML=title+`<div class="msg">Couldn't load analytics: ${esc(err)}. Retrying on the next refresh.</div>`; return; }
  if(!a || !a.coverage || !a.coverage.hourly){
    // A cold cache and a build that throws every cycle look identical from here — the server now
    // ships the reason when it has one, so say which it is rather than implying progress forever.
    const be=a&&a.buildError;
    host.innerHTML=title+(be
      ? `<div class="msg">Analytics build is failing server-side: ${esc(be)}<br><span class="sec">Retrying every cycle. This is a bug, not a warm-up \u2014 the reason above is from the server log.</span></div>`
      : `<div class="msg">Computing\u2026 warming up the spines.</div>`);
    return; }
  const c=a.coverage, w=a.window||{}, hr=c.hourly||{}, fund=c.funding||{};
  const rp=covPct(c.ready,c.markets);
  const age=a.ts?`updated ${Math.max(0,Math.round((Date.now()-a.ts)/1000))}s ago`:'';
  // The four coverage cards + readiness bar collapse into one status line; full numbers on hover.
  // Below 100% ready a thin inline bar returns so the unlock progress stays visible.
  const statTip=`hourly spine: ${hr.coins||0} coins \u00b7 ${(hr.candles||0).toLocaleString()} candles \u00b7 ${w.hourlyDays||60}d`+
    `&#10;funding spine: ${fund.coins||0} coins \u00b7 ${(fund.points||0).toLocaleString()} pts \u00b7 ${fund.endpoint==='on'?'live history':'sampled fallback'}`+
    `&#10;ready: ${c.ready}/${c.markets} at \u2265 ${Math.round((c.readyHours||480)/24)}d hourly \u2014 studies unlock as this fills`;
  const status=`<div class="sg-status" title="${statTip}">${c.markets} markets \u00b7 ${c.equityMarkets} ${a.isCrypto?'perps':'equity'} \u00b7 spine ${rp}% \u00b7 ${w.hourlyDays||60}d hourly \u00b7 funding ${fund.endpoint==='on'?'live history':'sampled fallback'}${age?' \u00b7 '+age:''}</div>`;
  const bar= rp<100 ? `<div style="margin:0 0 10px" title="spine readiness \u2014 session studies unlock as this fills \u00b7 ${rp}%"><div style="height:5px;border-radius:3px;background:var(--grid);overflow:hidden"><div style="height:100%;width:${rp}%;background:var(--accent);transition:width .4s"></div></div></div>` : '';
  const jump=`<div class="jumpbar"><span class="lbl">jump</span>`+
    sessGroups().map(g=>`<button type="button" class="jchip" data-j="${g.id}">${g.label}</button>`).join('')+`</div>`;
  // ---- sections (unchanged renderers) ----
  const sd = a.sections && a.sections.sessionDecomp;
  let flagship='', sdPend='';
  if(sd && !sd.pending) flagship = renderSessionDecomp(sd);
  else sdPend = sgPendRow('Session decomposition', sd?`computing \u2014 needs \u2265${sd.need} equities with \u22653d hourly spine (have ${sd.equityCount})`:'cash / overnight / weekend equity curves, gross &amp; net-of-funding','\u2605\u2605\u2605\u2605\u2605');
  const hc = a.sections && a.sections.hourClock;
  let clocks='', overlay='', hcPend='', ovPend='';
  if(hc && !hc.pending && !hc.disabled){ clocks = renderClocks(hc);
    if(hc.pooled && hc.pooled.byClass && Object.keys(hc.pooled.byClass).length) overlay = renderClassOverlay(hc);
    else ovPend = sgPendRow('Asset-class overlays','pooled hour-of-day curves per class \u2014 needs \u22652 classes with profiles','\u2605\u2605\u2605\u2606\u2606'); }
  else if(!hc||!hc.disabled) hcPend = sgPendRow('Hour-of-day + funding clocks', hc?`computing \u2014 needs \u22653 markets with \u22655d hourly spine (have ${hc.count})`:'volatility \u00b7 volume \u00b7 funding per ticker','\u2605\u2605\u2605\u2605\u2606');
  const dow = a.sections && a.sections.dow;
  let dowBlock='', dowPend='';
  if(dow && !dow.pending && !dow.disabled) dowBlock = renderDow(dow);
  else if(!dow||!dow.disabled) dowPend = sgPendRow('Day-of-week 7\u00d724 heatmap', dow?`computing \u2014 needs \u22653 markets with \u22655d hourly spine (have ${dow.count})`:'weekend-gap &amp; Friday\u2192Monday risk','\u2605\u2605\u2605\u2606\u2606');
  const cl = a.sections && a.sections.clusters;
  let clBlock='', clPend='';
  if(cl && !cl.pending && !cl.disabled) clBlock = renderClusters(cl);
  else if(!cl||!cl.disabled) clPend = sgPendRow('Cross-ticker clustering', cl?`computing \u2014 needs \u22658 markets with an hourly profile (have ${cl.count||0})`:'group markets by when they trade; flag the oddballs','\u2605\u2605\u2605\u2605\u2606');
  const se = a.sections && a.sections.seasonality;
  let seBlock='', sePend='';
  if(se && !se.pending && !se.disabled) seBlock = renderSeasonality(se);
  else if(se && se.disabled) sePend = '';
  else if(se && se.notApplicable) sePend = sgPendRow('Return seasonality by hour','not applicable to crypto \u2014 this is a by-sector cross-sectional test and the crypto book is one class','\u2605\u2605\u2606\u2606\u2606');
  else sePend = sgPendRow('Return seasonality by hour', se?`computing \u2014 needs \u2265${se.need||8} equities with \u22655d hourly spine (have ${se.count||0})`:'exploratory \u00b7 significance-flagged','\u2605\u2605\u2606\u2606\u2606');
  const lv = a.sections && a.sections.levels;
  let lvBlock='', lvPend='';
  if(lv && !lv.pending && !lv.disabled) lvBlock = renderLevels(lv);
  const em = a.sections && a.sections.ema200;
  let emBlock='', emPend='';
  if(em && !em.pending && !em.disabled) emBlock = renderEma200(em);
  else if(!em||!em.disabled) emPend = sgPendRow('EMA200 trend events', em?`computing \u2014 needs \u2265${em.need||5} names with \u2265226 closed daily bars (have ${em.count||0})`:'close-confirmed crosses &amp; retests vs a matched control','\u2605\u2605\u2605\u2606\u2606');
  else if(!lv||!lv.disabled) lvPend = sgPendRow('Structural level validation', lv?`computing \u2014 needs \u2265${lv.need||5} names with \u226571 closed daily bars off the spine (have ${lv.count||0})`:'touch &amp; hold vs a matched control','\u2605\u2605\u2605\u2605\u2606');
  const an = a.sections && a.sections.anatomy;
  let anBlock='', cbBlock='', pvBlock='', anPend='', cbPend='', pvPend='';
  if(an && !an.pending){ anBlock = renderAnatomy(an);
    cbBlock = renderCandles(an);
    if(!cbBlock) cbPend = sgPendRow('Candle behaviour','no typed daily bars yet \u2014 rides the anatomy records','\u2605\u2605\u2606\u2606\u2606');
    pvBlock = renderPivots(an);
    if(!pvBlock) pvPend = sgPendRow('Time-based pivots','no session extremes recorded yet \u2014 rides the anatomy records','\u2605\u2605\u2605\u2606\u2606'); }
  else { const det = an?`computing \u2014 needs \u2265${an.need||5} equities with \u226520 complete UTC sessions (have ${an.count||0})`:'rides the anatomy records';
    anPend = sgPendRow('Session anatomy', det,'\u2605\u2605\u2605\u2606\u2606');
    cbPend = sgPendRow('Candle behaviour', det,'\u2605\u2605\u2606\u2606\u2606');
    pvPend = sgPendRow('Time-based pivots', det,'\u2605\u2605\u2605\u2606\u2606'); }
  const regime = a.sections && a.sections.regime;
  const regimeBlock = renderRegime(regime, (state.analytics.regime&&state.analytics.regime.sel)||'all');
  // ---- group verdicts: computed from the same section objects the panels render ----
  const vPositioning=()=>{ const d=regime&&regime.all;
    if(!d||d.pending||!d.crowd) return 'accruing \u2014 fills in as OI &amp; funding history banks';
    const cw=d.crowd, p=[];
    if(cw.netFundApr!=null) p.push(`skew ${cw.netFundApr>=0?'+':''}${cw.netFundApr.toFixed(1)}%`);
    if(cw.longExtPct!=null) p.push(`${cw.longExtPct}% crowded-long`);
    if(cw.shortExtPct!=null) p.push(`${cw.shortExtPct}% crowded-short`);
    return p.join(' \u00b7 ')||'\u2014'; };
  const vHolds=()=>{ if(!sd||sd.pending) return sd?`computing \u2014 ${sd.equityCount}/${sd.need} ${sd.isCrypto?'perps':'equities'} ready`:'computing';
    const S=sd.sessions||{}, seg=(k,l)=>S[k]&&S[k].totNet!=null?`${l} ${fp(S[k].totNet)} net`:null;
    return (sd.isCrypto
      ? [seg('utcday','UTC day'),seg('weekend','weekend')]
      : [seg('overnight','overnight'),seg('weekend','weekend'),seg('cash','cash')]).filter(Boolean).join(' \u00b7 ')||'\u2014'; };
  const vClocks=()=>{ if(!hc||hc.pending) return hc?`computing \u2014 ${hc.count} markets with a spine`:'computing';
    const all=(hc.pooled&&hc.pooled.all)||{}, p=[];
    let ph=null,pv2=-Infinity; (all.vol||[]).forEach((x,i)=>{ if(Number.isFinite(x)&&x>pv2){pv2=x;ph=i;} });
    if(ph!=null) p.push(`busiest ${ph}:00 ET`);
    let fh=null,fv=0; (all.fund||[]).forEach((x,i)=>{ if(Number.isFinite(x)&&Math.abs(x)>fv){fv=Math.abs(x);fh=i;} });
    if(fh!=null&&fv>0) p.push(`carry peaks ${fh}:00 ET (${all.fund[fh]>0?'longs pay':'longs receive'})`);
    return p.join(' \u00b7 ')||'\u2014'; };
  const vWeek=()=>{ if(!dow||dow.pending) return dow?`computing \u2014 ${dow.count} markets with a spine`:'computing';
    const g=(dow.pooled&&dow.pooled.all)||{}, cells=g.vol;
    if(Array.isArray(cells)){ let bd=null,bh=null,bv=-Infinity;
      for(let d2=0;d2<7;d2++){ const row=cells[d2]; if(!Array.isArray(row)) continue;
        for(let h=0;h<24;h++){ const x=row[h]; if(Number.isFinite(x)&&x>bv){bv=x;bd=d2;bh=h;} } }
      if(bd!=null) return `busiest ${WD_NAMES[bd]} ${bh}:00 ET \u00b7 ${g.count||0} markets`; }
    return `${g.count||0} markets \u00b7 7\u00d724 ET grid`; };
  const vStructure=()=>{ const p=[];
    if(lv&&!lv.pending&&lv.overall&&lv.overall.excess!=null)
      p.push(`levels ${(lv.overall.excess>=0?'+':'')+(lv.overall.excess*100).toFixed(1)}pp vs control`);
    if(cl&&!cl.pending) p.push(`${cl.count} markets clustered${(cl.oddballs&&cl.oddballs.length)?` \u00b7 ${cl.oddballs.length} oddballs`:''}`);
    if(em&&!em.pending&&em.tf&&em.tf['1d']&&em.tf['1d'].n) p.push(`ema200 ${em.tf['1d'].n} D1 events`);
    return p.join(' \u00b7 ')||'computing'; };
  // ---- assemble ----
  const anySections = flagship||clocks||overlay||dowBlock||clBlock||seBlock||lvBlock||emBlock||anBlock||cbBlock||pvBlock;
  const isCr = !!(a && a.isCrypto);
  // Only studies this universe actually publishes can hold back the all-live footer, and the count
  // is derived from the live payload rather than hard-coded — crypto ships a five-study Holds +
  // Positioning set, so claiming "eleven" there would be a lie. (-19)
  const onG=(id)=>sessGroups().some(g=>g.id===id);
  const gate=[sdPend,anPend,cbPend,pvPend]
    .concat(onG('clocks')?[hcPend,ovPend,sePend]:[])
    .concat(onG('week')?[dowPend]:[])
    .concat(onG('structure')?[clPend,lvPend,emPend]:[]);
  const allLive = anySections && !gate.some(Boolean);
  const nStudies = 1/*regime*/+4/*decomp, anatomy, candles, pivots*/
    +(onG('clocks')?3:0)+(onG('week')?1:0)+(onG('structure')?2:0);
  const foot = allLive ? `<div class="sec" style="margin-top:4px;font-size:var(--fs-xs);opacity:.8">All ${nStudies} studies live. \u25c6</div>` : '';
  // Render only the groups this universe publishes (-19) — crypto ships positioning + holds.
  const GROUP_BODY={
    positioning:()=>sgSection('positioning','Positioning',vPositioning(),[{html:regimeBlock}]),
    holds:()=>sgSection('holds','Holds',vHolds(),[{html:flagship},{pend:sdPend},{html:anBlock},{pend:anPend},{html:cbBlock},{pend:cbPend},{html:pvBlock},{pend:pvPend}]),
    clocks:()=>sgSection('clocks','Clocks',vClocks(),[{html:clocks},{pend:hcPend},{html:overlay},{pend:ovPend},{html:seBlock},{pend:sePend}]),
    week:()=>sgSection('week','Week',vWeek(),[{html:dowBlock},{pend:dowPend}]),
    structure:()=>sgSection('structure','Structure',vStructure(),[{html:clBlock},{pend:clPend},{html:lvBlock},{pend:lvPend},{html:emBlock},{pend:emPend}]),
  };
  const groups = sessGroups().map(g=>GROUP_BODY[g.id]()).join('');
  host.innerHTML=title+status+bar+jump+groups+foot;
  if(regime) wireRegimeControls();
  if(hc && !hc.pending && !hc.disabled){ attachClockControls(); if(overlay) attachOverlayControls(); }
  if(dow && !dow.pending && !dow.disabled) attachDowControls();
  if(se && !se.pending && !se.disabled) attachSeasonControls();
  if(lv && !lv.pending && !lv.disabled) attachStudyScope('lvlsel','levels');
  if(an && !an.pending){ attachStudyScope('anatsel','anatomy'); attachStudyScope('cbsel','candles'); attachStudyScope('pvsel','pivots'); }
  attachLineHover();
  wireSessGroups(host);
}
export { drawSessions };
