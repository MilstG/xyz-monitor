// sectors.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { DAY, SCROLL_B, TF_MAP, activeRows, clamp, el, esc, fmtUsd, momColor, state, stdev } from "./core.js";
import { buildCorr, corrColor, downloadCSV } from "./corr.js";
import { computeDerived } from "./data.js";
import { openDetail } from "./drawer.js";
import { drillMembers } from "./markets.js";
import { warmCount } from "./nav.js";


// ===== sectors tab =====
const SECT={ _rows:null, _cohesion:null };
function zscores(arr){ const v=arr.filter(x=>x!=null&&isFinite(x));
  if(v.length<2) return arr.map(()=>0);
  const m=v.reduce((a,b)=>a+b,0)/v.length, sd=stdev(v)||1;
  return arr.map(x=>(x!=null&&isFinite(x))?(x-m)/sd:0); }
function sectorShort(name){ const M={'Information Technology':'Info Tech','Communication Services':'Comm Svcs','Consumer Discretionary':'Cons Disc','Consumer Staples':'Cons Stpl','Health Care':'Health','Real Estate':'Real Est'}; return M[name]||name; }
// ===== grouping key (build -04) =====
// The Sectors tab groups by ONE key everywhere — map, board, detail, cohesion, correlation.
// grp='ind' switches that key to the server-shipped industry group; the wire contract is
// `r.ind || r.sector` (the server only ships `ind` when it differs), so a name with no curated
// industry lands in a group NAMED after its GICS sector — the board marks those "= sector"
// instead of hiding them. Crypto scope has no industry layer (its sectors ARE the fine
// grouping), so the toggle is inert and hidden there.
function sectGrpActive(){ return state.sect.grp==='ind' && state.scope!=='crypto'; }
function sectKeyOf(r){ return (sectGrpActive() ? (r.ind||r.sector) : r.sector) || 'Unclassified'; }

function computeSectors(){
  const tfKey=TF_MAP[state.tf]||'d1', byVol=state.sect.wt!=='eq';
  const groups=new Map(), byInd=sectGrpActive();
  for(const r of activeRows()){ const g=sectKeyOf(r);
    let o=groups.get(g); if(!o){ o={name:g, assetClass:r.assetClass||'—', members:[]}; groups.set(g,o); }
    o.members.push(r);
    // Mixed-class groups are a FEATURE of industry mode (Crypto-Fi holds equities beside a
    // preferred; Memory/Storage holds the DRAM index) — the label must say so, not lie by
    // wearing the first member's class.
    if((r.assetClass||'—')!==o.assetClass) o.assetClass='Mixed'; }
  const list=[];
  for(const o of groups.values()){ const ms=o.members;
    if(byInd){
      // Parent-GICS provenance for the board (deduped short names), and the honest-fallback
      // flag: a group is "= sector" iff NO member carries a curated industry — i.e. the group
      // exists only because its members inherited their sector name.
      const ps=[...new Set(ms.map(m=>m.sector||'Unclassified'))];
      o.gics=ps.map(sectorShort).join(' / ');
      o.fall=ms.every(m=>!m.ind);
    }
    let wsum=0; for(const r of ms) if(byVol&&r.vol>0) wsum+=r.vol;
    const wOf=r=> byVol ? (wsum>0?((r.vol>0?r.vol:0)/wsum):1/ms.length) : 1/ms.length;
    const wavg=(sel)=>{ let s=0,ww=0; for(const r of ms){ const v=sel(r); if(v==null||!isFinite(v))continue; const wi=wOf(r); s+=wi*v; ww+=wi; } return ww>0?s/ww:null; };
    const withRet=ms.filter(r=>r[tfKey]!=null&&isFinite(r[tfKey]));
    const ret=wavg(r=>r[tfKey]);
    const retEW=withRet.length?withRet.reduce((a,r)=>a+r[tfKey],0)/withRet.length:null;
    const doi=wavg(r=>r.doi);
    const rvol=wavg(r=>r.vol30);
    let totVol=0,totOI=0,volBase=0;
    for(const r of ms){ if(r.vol)totVol+=r.vol; if(r.oi)totOI+=r.oi; if(r.feat&&r.feat.volBase>0)volBase+=r.feat.volBase; }
    const relVol=volBase>0?totVol/volBase:null;
    const green=withRet.length?withRet.filter(r=>r[tfKey]>0).length/withRet.length:null;
    const greenN=withRet.length?withRet.filter(r=>r[tfKey]>0).length:0;
    const momArr=ms.filter(r=>r.mom!=null&&isFinite(r.mom));
    const momUp=momArr.length?momArr.filter(r=>r.mom>0).length/momArr.length:null;
    list.push({ name:o.name, assetClass:o.assetClass, n:ms.length, members:ms, gics:o.gics, fall:!!o.fall,
      ret, retEW, doi, rvol, relVol, totVol, totOI, green, greenN, greenT:withRet.length, momUp });
  }
  // rotation = capital direction (return + OI conviction) · heat = activity (volume + volatility)
  const rets=list.map(g=>g.ret);
  const retSd=stdev(rets.filter(x=>x!=null&&isFinite(x)))||1;
  const oic=list.map(g=>(g.doi!=null&&g.ret!=null)?g.doi*Math.tanh(g.ret/retSd):null);
  const zRet=zscores(rets), zOIc=zscores(oic),
        zRV=zscores(list.map(g=>g.relVol!=null&&g.relVol>0?Math.log(g.relVol):null)),
        zVol=zscores(list.map(g=>g.rvol)), zDO=zscores(list.map(g=>g.doi!=null?Math.abs(g.doi):null));
  list.forEach((g,i)=>{
    g.direction=(g.ret==null)?null:100*Math.tanh((0.55*zRet[i]+0.45*zOIc[i])/1.2);
    const hr=0.5*zRV[i]+0.3*zVol[i]+0.2*zDO[i];
    g.heat=Math.round(100/(1+Math.exp(-hr)));
    g.rotation=g.direction;
  });
  // cohesion (avg internal daily-return correlation) via the shared correlation builder
  const withDaily=activeRows().filter(r=>r.daily&&r.sector);
  const coh=new Map();
  if(withDaily.length>1){ const scL=({'7':7,'30':30,'90':90}[state.sect.corrTf]||30); const {C}=buildCorr(withDaily,scL);
    const idxByG=new Map(); withDaily.forEach((r,i)=>{ const g=sectKeyOf(r); (idxByG.get(g)||idxByG.set(g,[]).get(g)).push(i); });
    for(const [g,idx] of idxByG){ let s=0,n=0; for(let a=0;a<idx.length;a++)for(let b=a+1;b<idx.length;b++){ const v=C[idx[a]][idx[b]]; if(v!=null&&isFinite(v)){s+=v;n++;} } coh.set(g,n?s/n:null); }
    SECT._corrCache={C, idxByG, rows:withDaily};
  } else SECT._corrCache=null;
  list.forEach(g=>g.cohesion=coh.has(g.name)?coh.get(g.name):null);
  list.sort((a,b)=>{ const av=a.rotation,bv=b.rotation; if(av==null&&bv==null)return (b.totVol||0)-(a.totVol||0); if(av==null)return 1; if(bv==null)return -1; return bv-av; });
  SECT._rows=list;
  return list;
}

function renderSectors(){
  if(!state.rows.size){ el('sect-map').innerHTML='<div class="msg">Markets still loading — switch back in a moment.</div>'; return; }
  computeDerived();
  const list=computeSectors();
  const secNoun=sectGrpActive()?'industry group':'sector', secNounPl=sectGrpActive()?'industry groups':'sectors';
  const lg=el('sect-legend'); if(lg) lg.innerHTML = state.sect.mode==='leaders'
    ? `<b>Leadership map</b> — where each ${secNoun} sits vs the S&amp;P over the last <b>${leadersDays()}d</b>${leadersFloored()?' <span class="sec">(leadership needs a multi-day window, so intraday selections show 7d — use the rotation board below for shorter windows)</span>':''}. <b>Right</b> = beating the S&amp;P, <b>left</b> = behind it. <b>Up</b> = its lead is <i>growing</i>, <b>down</b> = <i>shrinking</i>. So <b class="pos">top-right</b> ${secNounPl} are winning and pulling further ahead; <b class="neg">bottom-left</b> are losing and falling further behind. Bubble size = 24h volume. Bubble <b>fill</b> = money over the selected window: <b class="pos">green</b> = OI building (money in), <b class="neg">red</b> = leaving; deeper fill = bigger ΔOI. The outline keeps the quadrant color. The <b>dotted tail</b> behind each bubble is its recent path (oldest → now) — hover the tail dots for the values.`
    : '<b>Flow map</b> — horizontal = capital direction (price + OI conviction) over the selected window, vertical = activity heat (volume + volatility). Top-right = accumulation, top-left = distribution. Bubble size = 24h volume.';
  if(state.sect.mode==='leaders'){
    const data=computeLeaders(list);
    // Trails: re-evaluate the same map with the window ending 2/4/6 (7d) or 4/8/12 (30d)
    // benchmark days earlier, giving each sector a short trajectory — the whole point of a
    // rotation graph is the path, not the snapshot. Drawn oldest→newest into the live bubble.
    if(data){
      const offs = leadersDays()<=7 ? [6,4,2] : [12,8,4];
      const hist = offs.map(o=>({o, pts:computeLeaders(list,o)}));
      for(const sec of data){ sec.trail=[];
        for(const h of hist){ if(!h.pts) continue; const p=h.pts.find(x=>x.name===sec.name); if(p) sec.trail.push({x:p.x, y:p.y, o:h.o}); } }
    }
    el('sect-map').innerHTML = data ? renderLeaders(data)
      : `<div class="msg">The leadership map needs the S&amp;P benchmark and daily history — it fills in automatically as the server backfill completes.${warmCount()}</div>`;
    if(data) attachLeadersHandlers();
    if(data) attachMapHover();
  } else {
    el('sect-map').innerHTML=renderSectorMap(list);
    attachMapHandlers();
    attachMapHover();
  }
  renderSectorBoard(list);
  renderSectorDetail();
  renderSectorCorr(list);
}
// ---- Leadership map: plain % relative to the S&P (X) and whether the lead is growing (Y) ----
// Leadership lookback follows the window selector (7d/30d). It's daily-based, so intraday choices floor to 7d.
function leadersDays(){ return {'1h':7,'4h':7,'1d':7,'7d':7,'30d':30}[state.tf]||30; }
function leadersFloored(){ return state.tf==='1h'||state.tf==='4h'||state.tf==='1d'; }
function computeLeaders(list, offset){
  offset=offset||0;   // end the window `offset` benchmark days ago (0 = now) — powers the trails
  const bench=state.benchCoin?state.rows.get(state.benchCoin):null;
  if(!bench||!bench.daily||bench.daily.length<5) return null;
  const bDay=new Map();
  for(const k of bench.daily){ const cl=parseFloat(k.c), d=Math.floor(k.t/DAY); if(isFinite(cl)) bDay.set(d,cl); }
  const days=[...bDay.keys()].sort((a,b)=>a-b);
  const endI=days.length-offset;
  if(endI<5) return null;
  const win=days.slice(Math.max(0, endI-leadersDays()), endI);
  if(win.length<5) return null;
  const b0=bDay.get(win[0]); if(!(b0>0)) return null;
  const mid=Math.floor(win.length/2), bMid=bDay.get(win[mid]), bEnd=bDay.get(win[win.length-1]);
  const benchRet=bEnd/b0-1, benchEarly=bMid/b0-1, benchLate=bEnd/bMid-1;
  const out=[];
  for(const g of list){
    if(g.name==='Unclassified') continue;
    const series=[];
    for(const r of g.members){ if(!r.daily||r.daily.length<5) continue;
      const bd=new Map();
      for(const k of r.daily){ const cl=parseFloat(k.c), d=Math.floor(k.t/DAY); if(isFinite(cl)) bd.set(d,cl); }
      const first=win.find(d=>bd.has(d)); if(first==null) continue; const f=bd.get(first); if(!(f>0)) continue;
      series.push({bd, f}); }
    if(!series.length) continue;
    const idxAt=d=>{ let s=0,n=0; for(const ms of series){ const cl=ms.bd.get(d); if(cl!=null&&cl>0){ s+=cl/ms.f; n++; } } return n?s/n:null; };
    const i0=idxAt(win[0]), iMid=idxAt(win[mid]), iEnd=idxAt(win[win.length-1]);
    if(i0==null||iEnd==null||!(i0>0)) continue;
    const x=((iEnd/i0-1)-benchRet)*100;                    // % ahead of / behind the S&P
    let y=0;                                                // change in that lead (recent vs earlier)
    if(iMid!=null&&iMid>0){ const exEarly=((iMid/i0-1)-benchEarly)*100, exLate=((iEnd/iMid-1)-benchLate)*100; y=exLate-exEarly; }
    out.push({name:g.name, x, y, vol:g.totVol, doi:g.doi, coins:g.members.map(r=>r.coin)});   // doi/coins power the money-fill and the Markets drill
  }
  return out.length?out:null;
}
function leadQuad(x,y){ if(x>=0&&y>=0)return {l:'Leaders',c:'var(--up)'}; if(x<0&&y>=0)return {l:'Catching up',c:'var(--blue)'}; if(x>=0&&y<0)return {l:'Cooling',c:'var(--accent)'}; return {l:'Laggards',c:'var(--down)'}; }
// ---- shared bubble-map label handling: halo (#1) + greedy de-collision w/ leader lines (#2) + hover (#3) ----
// nodes: [{cx,cy,r,label,...}] mutated in place with n._lbl={p,x1,y1,x2,y2,def}. b={px0,px1,py1,py0}.
// Bubbles never move (their position IS the data); only labels are routed to a free side, which is lossless.
function layoutMapLabels(nodes, b){
  const placed=[], boxes=nodes.map(n=>({x1:n.cx-n.r,y1:n.cy-n.r,x2:n.cx+n.r,y2:n.cy+n.r}));
  const ov=(a,c)=>!(a.x2<c.x1||a.x1>c.x2||a.y2<c.y1||a.y1>c.y2);
  const inB=c=>c.x1>=b.px0-34&&c.x2<=b.px1+34&&c.y1>=b.py1-6&&c.y2<=b.py0+22;
  for(const n of [...nodes].sort((a,c)=>c.r-a.r)){          // biggest bubbles keep the natural spot; small ones route around
    const w=(n.label||'').length*6.2+2, h=12;
    const cand=[
      {p:'below',x1:n.cx-w/2,     y1:n.cy+n.r+3},
      {p:'above',x1:n.cx-w/2,     y1:n.cy-n.r-3-h},
      {p:'right',x1:n.cx+n.r+5,   y1:n.cy-h/2},
      {p:'left', x1:n.cx-n.r-5-w, y1:n.cy-h/2},
      {p:'below',x1:n.cx-w/2,     y1:n.cy+n.r+3+h+3},
      {p:'above',x1:n.cx-w/2,     y1:n.cy-n.r-3-2*h-3},
    ].map(c=>({...c,x2:c.x1+w,y2:c.y1+h}));
    let chosen=null;
    for(const c of cand){ if(!inB(c))continue;
      let bad=placed.some(p=>ov(c,p));
      if(!bad) for(let i=0;i<nodes.length;i++){ if(nodes[i]===n)continue; if(ov(c,boxes[i])){bad=true;break;} }
      if(!bad){ chosen=c; break; } }
    if(!chosen) chosen=cand[0];                             // last resort: default below (halo still helps)
    chosen.def=(chosen===cand[0]);                          // default 'below' needs no leader line
    placed.push(chosen); n._lbl=chosen;
  }
  return nodes;
}
function mapLabelSvg(n, sizePx){
  const L=n._lbl;
  const ln=(x1,y1,x2,y2)=>`<line class="mleader" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  let tx,ty,anchor,leader='';
  if(L.p==='below'||L.p==='above'){ tx=n.cx; ty=L.y1+9.5; anchor='middle';
    if(!L.def) leader = L.p==='below' ? ln(n.cx,n.cy+n.r,n.cx,L.y1-1) : ln(n.cx,n.cy-n.r,n.cx,L.y2+1); }
  else if(L.p==='right'){ tx=L.x1; ty=n.cy+3.5; anchor='start'; leader=ln(n.cx+n.r,n.cy,L.x1-2,n.cy); }
  else { tx=L.x2; ty=n.cy+3.5; anchor='end'; leader=ln(n.cx-n.r,n.cy,L.x2+2,n.cy); }
  // halo: paint-order stroke in the page colour carves the label out from bubbles and neighbouring labels
  const txt=`<text class="mlbl" x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}" style="font-family:var(--mono);font-size:${sizePx}px;fill:var(--text);paint-order:stroke;stroke:var(--bg);stroke-width:3px;stroke-linejoin:round">${esc(n.label)}</text>`;
  return { leader, txt };
}
// hover a bubble -> raise it to the front and dim the rest
function attachMapHover(){
  const svg=el('sect-map').querySelector('svg.smapsvg'); if(!svg) return;
  // Emphasis is done purely with a class + CSS dimming of the others. We deliberately do NOT re-append
  // the hovered <g> to raise it: moving a node inside its own mouseenter cancels the browser's click
  // gesture (mousedown/mouseup land on a re-inserted node), which made bubbles unclickable.
  svg.querySelectorAll('.bub,.lead').forEach(g=>{
    g.addEventListener('mouseenter',()=>{ svg.classList.add('hv'); g.classList.add('hot'); });
    g.addEventListener('mouseleave',()=>{ svg.classList.remove('hv'); g.classList.remove('hot'); });
  });
}
function renderLeaders(data){
  const wl=leadersDays()+'d';
  const W=760,H=430, px0=44,px1=W-14, py0=H-48, py1=30;
  let mx=0.6,my=0.6;
  for(const s of data){ mx=Math.max(mx,Math.abs(s.x)); my=Math.max(my,Math.abs(s.y));
    if(s.trail) for(const t of s.trail){ mx=Math.max(mx,Math.abs(t.x)); my=Math.max(my,Math.abs(t.y)); } }
  mx*=1.18; my*=1.18;
  const xM=v=>px0+(clamp(v,-mx,mx)+mx)/(2*mx)*(px1-px0);
  const yM=v=>py0-(clamp(v,-my,my)+my)/(2*my)*(py0-py1);
  const cx=xM(0), cy=yM(0), maxVol=Math.max(1,...data.map(s=>s.vol||0));
  const ql='font-family:var(--mono);font-size:10px;fill:var(--faint)';
  let s=`<svg class="smapsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">`;
  s+=`<rect x="${px0}" y="${py1}" width="${px1-px0}" height="${py0-py1}" fill="var(--panel2)" opacity="0.3"/>`;
  s+=`<rect x="${cx}" y="${py1}" width="${px1-cx}" height="${cy-py1}" fill="rgb(70,185,126)" opacity="0.07"/>`;
  s+=`<rect x="${px0}" y="${py1}" width="${cx-px0}" height="${cy-py1}" fill="rgb(111,147,201)" opacity="0.07"/>`;
  s+=`<rect x="${cx}" y="${cy}" width="${px1-cx}" height="${py0-cy}" fill="rgb(227,165,60)" opacity="0.07"/>`;
  s+=`<rect x="${px0}" y="${cy}" width="${cx-px0}" height="${py0-cy}" fill="rgb(229,96,77)" opacity="0.07"/>`;
  s+=`<line x1="${cx}" y1="${py1}" x2="${cx}" y2="${py0}" stroke="var(--border)"/>`;
  s+=`<line x1="${px0}" y1="${cy}" x2="${px1}" y2="${cy}" stroke="var(--border)"/>`;
  s+=`<text x="${px1-8}" y="${py1+14}" text-anchor="end" style="font-family:var(--mono);font-size:10.5px;fill:var(--up);font-weight:600">LEADERS · ahead &amp; gaining</text>`;
  s+=`<text x="${px0+8}" y="${py1+14}" style="font-family:var(--mono);font-size:10.5px;fill:var(--blue);font-weight:600">CATCHING UP · behind, gaining</text>`;
  s+=`<text x="${px1-8}" y="${py0-8}" text-anchor="end" style="font-family:var(--mono);font-size:10.5px;fill:var(--accent);font-weight:600">COOLING · ahead, slowing</text>`;
  s+=`<text x="${px0+8}" y="${py0-8}" style="font-family:var(--mono);font-size:10.5px;fill:var(--down);font-weight:600">LAGGARDS · behind &amp; falling</text>`;
  [-mx, -mx/2, mx/2, mx].forEach(t=>{ const x=xM(t); s+=`<line x1="${x}" y1="${py0}" x2="${x}" y2="${py0+4}" stroke="var(--faint)"/><text x="${x.toFixed(1)}" y="${py0+16}" text-anchor="middle" style="${ql}">${t>0?'+':''}${t.toFixed(1)}%</text>`; });
  s+=`<text x="${cx.toFixed(1)}" y="${py0+16}" text-anchor="middle" style="${ql}">S&amp;P</text>`;
  s+=`<text x="${(px0+px1)/2}" y="${H-6}" text-anchor="middle" style="${ql}">← behind the S&amp;P    ·    % vs S&amp;P over ${wl}    ·    ahead →</text>`;
  s+=`<text x="12" y="${(py0+py1)/2}" text-anchor="middle" transform="rotate(-90 12 ${(py0+py1)/2})" style="${ql}">lead shrinking ▼ · growing ▲</text>`;
  const nodes=data.map(sec=>({cx:xM(sec.x),cy:yM(sec.y),r:8+22*Math.sqrt((sec.vol||0)/maxVol),label:sectorShort(sec.name),sec}));
  layoutMapLabels(nodes,{px0,px1,py1,py0});
  for(const n of nodes){ const sec=n.sec, q=leadQuad(sec.x,sec.y), col=q.c;
    const dir=sec.y>=0?'lead growing':'lead shrinking';
    const oiTxt=(sec.doi!=null&&isFinite(sec.doi))?`ΔOI (${state.tf}) ${sec.doi>=0?'+':''}${sec.doi.toFixed(2)}% — money ${sec.doi>=0?'coming in':'leaving'}`:'ΔOI n/a';
    const tip=`${sec.name}: ${sec.x>=0?'+':''}${sec.x.toFixed(1)}% vs S&P over ${wl}, ${dir} — ${q.l}. ${oiTxt}. Dotted tail = its path (oldest → now). Click = detail below; the detail has the → Markets drill.`;
    const lp=mapLabelSvg(n,10.5);
    s+=`<g class="lead" data-sect="${esc(sec.name)}" style="cursor:pointer"><title>${esc(tip)}</title>`;
    s+=lp.leader;
    if(sec.trail&&sec.trail.length){
      const tp=sec.trail.map(t=>({px:xM(t.x), py:yM(t.y), t}));
      let d=''; tp.forEach((p,i)=>d+=(i?'L':'M')+p.px.toFixed(1)+' '+p.py.toFixed(1)+' ');
      d+='L'+n.cx.toFixed(1)+' '+n.cy.toFixed(1);
      s+=`<path d="${d.trim()}" fill="none" stroke="${col}" stroke-width="1" stroke-dasharray="2 3" opacity="0.5"/>`;
      tp.forEach((p,i)=>{
        const dt=`${sec.name} · ${p.t.o} bench-day${p.t.o===1?'':'s'} ago: ${p.t.x>=0?'+':''}${p.t.x.toFixed(1)}% vs S&P, ${p.t.y>=0?'lead growing':'lead shrinking'}`;
        s+=`<circle cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="${(2+i*0.7).toFixed(1)}" fill="${col}" fill-opacity="${(0.28+0.16*i).toFixed(2)}"><title>${esc(dt)}</title></circle>`; });
    }
    // Fill answers "is money coming or going" independently of position: green = OI building over
    // the selected window, red = leaving, depth scales with |ΔOI| (saturating at 8%); neutral grey
    // when the group ships no ΔOI. The quadrant keeps the OUTLINE — two dimensions, one bubble.
    const fN=(sec.doi!=null&&isFinite(sec.doi))?sec.doi:null;
    const fC=fN==null?'var(--muted)':(fN>=0?'var(--up)':'var(--down)');
    const fO=fN==null?'0.10':(0.14+0.30*Math.min(1,Math.abs(fN)/8)).toFixed(2);
    s+=`<circle cx="${n.cx.toFixed(1)}" cy="${n.cy.toFixed(1)}" r="${n.r.toFixed(1)}" fill="${fC}" fill-opacity="${fO}" stroke="${col}" stroke-width="1.5"/>`;
    s+=lp.txt+`</g>`; }
  s+='</svg>';
  return s + leadersRankHtml(data);
}
function leadersRankHtml(data){
  const sorted=[...data].sort((a,b)=>b.x-a.x);
  const maxAbs=Math.max(0.5,...sorted.map(s=>Math.abs(s.x)));
  const wl=leadersDays()+'d';
  const li=s=>{ const ahead=s.x>=0, w=Math.round(Math.abs(s.x)/maxAbs*88);
    // The arrow is the TRAJECTORY (y sign); which story that tells depends on which side of the
    // S&P the group sits (x sign) — a laggard improving is closing a gap, not "beating by more".
    // Glyph by trajectory, color + phrase by quadrant: same leadQuad the map bubbles use.
    const q=leadQuad(s.x,s.y);
    const phrase = ahead
      ? (s.y>=0 ? 'ahead of the S&amp;P and pulling further away (lead growing)'
                : 'still ahead of the S&amp;P, but the lead is shrinking')
      : (s.y>=0 ? 'behind the S&amp;P, but closing the gap — losing by less lately, not beating it'
                : 'behind the S&amp;P and falling further behind');
    const arrow=`<span style="color:${q.c}" title="${phrase} — ${q.l}">${s.y>=0?'▲':'▼'}</span>`;
    // Row hover carries what the glyphs compress: full group name, exact distance vs the S&P,
    // the trajectory MAGNITUDE (the arrow only shows its sign), and the quadrant verdict.
    const rowTip=`${s.name}: ${s.x>=0?'+':''}${s.x.toFixed(1)}% vs the S&P over ${wl} · trajectory ${s.y>=0?'+':''}${s.y.toFixed(1)}pp (recent half vs earlier half) — ${q.l}`;
    return `<div class="crow lrow" data-sect="${esc(s.name)}" title="${esc(rowTip)}"><span class="ct" style="width:128px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(sectorShort(s.name))}</span>`+
      `<span class="cv ${ahead?'pos':'neg'}" style="width:56px;margin-left:0">${ahead?'+':''}${s.x.toFixed(1)}%</span>`+
      `<span style="width:16px;text-align:center">${arrow}</span>`+
      `<span class="cbar" style="width:${w}px;background:${ahead?'var(--up)':'var(--down)'};opacity:.55"></span></div>`; };
  return `<div class="cp-sub" style="margin:16px 2px 8px">${sectGrpActive()?'Industry groups':'Sectors'} ranked vs the S&amp;P (${leadersDays()}d) <span class="sec" style="text-transform:none;letter-spacing:0">· ▲ trajectory improving · ▼ deteriorating · arrow color = quadrant (hover it — what "improving" means depends on which side of the S&amp;P the group sits) · click a row to drill in</span></div>`+
    sorted.map(li).join('');
}
function attachLeadersHandlers(){ el('sect-map').querySelectorAll('.lead, .lrow').forEach(g=>g.addEventListener('click',()=>{ state.sect.sel=g.dataset.sect; renderSectorDetail(); el('sect-detail').scrollIntoView({behavior:SCROLL_B,block:'nearest'}); })); }
function renderSectorMap(list){
  const W=760,H=380, px0=52,px1=W-18, py0=H-30, py1=20;
  const plot=list.filter(g=>g.direction!=null&&g.name!=='Unclassified');
  if(plot.length<1) return '<div class="msg">No classified sectors with returns yet.</div>';
  const maxVol=Math.max(1,...plot.map(g=>g.totVol||0));
  const xM=d=>px0+(clamp(d,-100,100)+100)/200*(px1-px0);
  const yM=h=>py0-clamp(h,0,100)/100*(py0-py1);
  const cx0=xM(0), cy50=yM(50);
  let s=`<svg class="smapsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">`;
  s+=`<rect x="${px0}" y="${py1}" width="${px1-px0}" height="${py0-py1}" fill="var(--panel2)" opacity="0.35"/>`;
  s+=`<line x1="${cx0}" y1="${py1}" x2="${cx0}" y2="${py0}" stroke="var(--border)" stroke-dasharray="4 4"/>`;
  s+=`<line x1="${px0}" y1="${cy50}" x2="${px1}" y2="${cy50}" stroke="var(--border)" stroke-dasharray="4 4"/>`;
  const ql='font-family:var(--mono);font-size:10px;fill:var(--faint)';
  s+=`<text x="${px1-6}" y="${py1+14}" text-anchor="end" style="${ql}">accumulation ▲in</text>`;
  s+=`<text x="${px0+6}" y="${py1+14}" style="${ql}">distribution ▲out</text>`;
  s+=`<text x="${px1-6}" y="${py0-6}" text-anchor="end" style="${ql}">stealth inflow</text>`;
  s+=`<text x="${px0+6}" y="${py0-6}" style="${ql}">quiet / lagging</text>`;
  s+=`<text x="${(px0+px1)/2}" y="${H-6}" text-anchor="middle" style="${ql}">← outflow   ·   capital direction   ·   inflow →</text>`;
  s+=`<text x="14" y="${(py0+py1)/2}" text-anchor="middle" transform="rotate(-90 14 ${(py0+py1)/2})" style="${ql}">activity heat →</text>`;
  const nodes=plot.map(g=>({cx:xM(g.direction),cy:yM(g.heat),r:6+24*Math.sqrt((g.totVol||0)/maxVol),label:sectorShort(g.name),g}));
  layoutMapLabels(nodes,{px0,px1,py1,py0});
  for(const n of nodes){ const g=n.g, col=momColor(g.direction);
    const lp=mapLabelSvg(n,10);
    s+=`<g class="bub" data-sect="${esc(g.name)}" style="cursor:pointer"><title>${esc(g.name)} · rotation ${Math.round(g.direction)} · heat ${g.heat} · ret ${g.ret==null?'n/a':(g.ret>=0?'+':'')+g.ret.toFixed(2)+'%'} · ΔOI ${g.doi==null?'n/a':(g.doi>=0?'+':'')+g.doi.toFixed(2)+'%'}</title>`;
    s+=lp.leader;
    s+=`<circle cx="${n.cx.toFixed(1)}" cy="${n.cy.toFixed(1)}" r="${n.r.toFixed(1)}" fill="${col}" fill-opacity="0.32" stroke="${col}" stroke-width="1.4"/>`;
    s+=lp.txt+`</g>`; }
  s+='</svg>';
  return s;
}
function attachMapHandlers(){ el('sect-map').querySelectorAll('.bub').forEach(b=>b.addEventListener('click',()=>{ state.sect.sel=b.dataset.sect; renderSectorDetail(); el('sect-detail').scrollIntoView({behavior:SCROLL_B,block:'nearest'}); })); }
function heatBar(h){ const c=h>=66?'var(--accent)':h>=33?'var(--blue)':'var(--faint)'; return `<span style="display:inline-block;vertical-align:middle;width:46px;height:7px;border-radius:3px;background:var(--grid)"><span style="display:block;height:7px;border-radius:3px;width:${clamp(h,0,100)}%;background:${c}"></span></span>`; }
function rotCell(d){ if(d==null)return '<span class="na">—</span>'; const s=d>0?'+':''; return `<span style="color:${momColor(d)};font-weight:600">${s}${Math.round(d)}</span>`; }
function renderSectorBoard(list){
  const byInd=sectGrpActive();
  // Two honesty chips, industry mode only. «thin»: n<5 — the group's averages and its rank in
  // the cross-group z-scores are noisier at that size; disclosed, never hidden. «= sector»: no
  // member of this group carries a curated industry, so the group is just the GICS sector
  // wearing its own name — italicized so a curated group and a fallback never look alike.
  const nameCell=g=>{
    const thin=byInd&&g.n<5?`<span class="sthin" title="${g.n} members — averages and cross-group z-scores are noisier at this size">thin</span>`:'';
    const fall=byInd&&g.fall?`<span class="sthin" title="no industry split defined — this group is the GICS sector unchanged">= sector</span>`:'';
    return `<td class="pp"${byInd&&g.fall?' style="font-style:italic"':''}>${esc(sectorShort(g.name))}${thin}${fall}</td>`;
  };
  const rows=list.map(g=>{
    const sel=state.sect.sel===g.name?' style="background:rgba(227,165,60,.08)"':'';
    return `<tr data-sect="${esc(g.name)}"${sel}>`+
      nameCell(g)+
      (byInd?`<td class="sec" style="text-align:left" title="parent GICS sector(s) of this group's members">${esc(g.gics||'—')}</td>`:'')+
      `<td class="sec" style="text-align:left">${esc(g.assetClass)}</td>`+
      `<td class="sec">${g.n}</td>`+
      `<td>${rotCell(g.rotation)}</td>`+
      `<td>${heatBar(g.heat)}</td>`+
      `<td class="${g.ret>=0?'pos':'neg'}">${g.ret==null?'<span class="na">—</span>':(g.ret>=0?'+':'')+g.ret.toFixed(2)+'%'}</td>`+
      `<td class="${g.doi>=0?'pos':'neg'}">${g.doi==null?'<span class="na">—</span>':(g.doi>=0?'+':'')+g.doi.toFixed(2)+'%'}</td>`+
      `<td class="sec" title="${g.greenN}/${g.greenT} up${g.momUp!=null?' · '+Math.round(g.momUp*100)+'% mom+':''}">${g.green==null?'—':Math.round(g.green*100)+'%'}</td>`+
      `<td class="sec">${fmtUsd(g.totVol)}</td>`+
      `<td class="sec">${fmtUsd(g.totOI)}</td>`+
      `<td class="sec" title="avg internal daily-return correlation">${g.cohesion==null?'·':g.cohesion.toFixed(2)}</td>`+
      `</tr>`;
  }).join('');
  const head='<thead><tr><th>'+(byInd?'Industry':'Sector')+'</th>'+(byInd?'<th style="text-align:left" title="parent GICS sector(s)">GICS</th>':'')+'<th style="text-align:left">Type</th><th>#</th><th title="capital direction: price + OI conviction, ranked across '+(byInd?'industries':'sectors')+'">Rotation</th><th>Heat</th><th>Return</th><th title="avg open-interest change over the window">ΔOI</th><th title="% of members up">Breadth</th><th>24h Vol</th><th>OI</th><th title="avg internal correlation">Cohesion</th></tr></thead>';
  el('sect-board').innerHTML=`<div class="cp-head" style="margin-bottom:10px">${byInd?'Industry':'Sector'} rotation board <span class="sec" style="font-weight:400">— ${state.tf} window · ${state.sect.wt==='eq'?'equal-weighted':'volume-weighted'}${byInd?' · finer groups, thinner samples — «thin» rows carry noisier stats':''} · click a row or bubble for detail</span></div>`+
    `<div style="overflow-x:auto"><table class="ptbl" style="min-width:${byInd?820:760}px">${head}<tbody>${rows}</tbody></table></div>`;
  el('sect-board').querySelectorAll('tbody tr[data-sect]').forEach(tr=>tr.addEventListener('click',()=>{ state.sect.sel=tr.dataset.sect; renderSectorDetail(); el('sect-detail').scrollIntoView({behavior:SCROLL_B,block:'nearest'}); }));
}
function renderSectorDetail(){
  const p=el('sect-detail'), list=SECT._rows, name=state.sect.sel;
  if(!list||!name){ p.hidden=true; return; }
  const g=list.find(x=>x.name===name); if(!g){ p.hidden=true; return; }
  const tfKey=TF_MAP[state.tf]||'d1';
  const bench=state.benchCoin?state.rows.get(state.benchCoin):null, benchRet=bench?bench[tfKey]:null;
  const rs=(g.ret!=null&&benchRet!=null)?g.ret-benchRet:null;
  const ms=[...g.members].sort((a,b)=>((b[tfKey]||-1e9)-(a[tfKey]||-1e9)));
  const mrow=r=>`<tr data-coin="${esc(r.coin)}"><td class="pp">${esc(r.ticker)}</td>`+
    `<td class="${(r[tfKey]||0)>=0?'pos':'neg'}">${r[tfKey]==null?'<span class="na">·</span>':(r[tfKey]>=0?'+':'')+r[tfKey].toFixed(2)+'%'}</td>`+
    `<td class="${(r.doi||0)>=0?'pos':'neg'}">${r.doi==null?'<span class="na">·</span>':(r.doi>=0?'+':'')+r.doi.toFixed(2)+'%'}</td>`+
    `<td>${r.mom==null?'<span class="ph">·</span>':`<span style="color:${momColor(r.mom)}">${r.mom>0?'+':''}${Math.round(r.mom)}</span>`}</td>`+
    `<td class="sec">${r.vol30!=null?r.vol30.toFixed(0)+'%':'·'}</td>`+
    `<td class="sec">${fmtUsd(r.vol)}</td></tr>`;
  const st=(k,v)=>`<span>${k}<b>${v}</b></span>`;
  p.hidden=false;
  p.innerHTML=`<div class="cp-head">${esc(sectorShort(g.name))} <span class="sec" style="font-weight:400">— ${g.gics?esc(g.gics)+' · ':''}${esc(g.assetClass)} · ${g.n} markets · ${state.tf} window</span>`+
    `<button class="btn xtiny" id="sectDetClose" style="float:right">✕</button>`+
    `<button class="btn xtiny" id="sectDetDrill" style="float:right;margin-right:6px" title="open the Markets table filtered to exactly these members — same drill the group lens uses, one code path">→ Markets</button></div>`+
    `<div class="pairstats">${st('rotation ', rotCell(g.rotation))}${st('heat ', g.heat)}`+
      `${st('return ', g.ret==null?'—':`<span class="${g.ret>=0?'pos':'neg'}">${g.ret>=0?'+':''}${g.ret.toFixed(2)}%</span>`)}`+
      `${st('ΔOI ', g.doi==null?'—':`<span class="${g.doi>=0?'pos':'neg'}">${g.doi>=0?'+':''}${g.doi.toFixed(2)}%</span>`)}`+
      `${st('vs S&amp;P ', rs==null?'—':`<span class="${rs>=0?'pos':'neg'}">${rs>=0?'+':''}${rs.toFixed(2)}%</span>`)}`+
      `${st('breadth ', g.green==null?'—':`${g.greenN}/${g.greenT}`)}`+
      `${st('cohesion ', g.cohesion==null?'·':g.cohesion.toFixed(2))}`+
      `${st('24h vol ', fmtUsd(g.totVol))}${st('OI ', fmtUsd(g.totOI))}</div>`+
    `<div class="cp-sub">Members <span class="sec" style="text-transform:none;letter-spacing:0">· sorted by ${state.tf} return · click to open the ticker</span></div>`+
    `<div style="overflow-x:auto"><table class="ptbl"><thead><tr><th>Ticker</th><th>${state.tf}</th><th>ΔOI</th><th>Mom</th><th>Vol</th><th>24h Vol</th></tr></thead><tbody>${ms.map(mrow).join('')}</tbody></table></div>`;
  el('sectDetClose').onclick=()=>{ state.sect.sel=null; p.hidden=true; renderSectorBoard(SECT._rows); };
  { const db=el('sectDetDrill'); if(db) db.onclick=()=>drillMembers(g.name, g.members.map(r=>r.coin)); }
  p.querySelectorAll('tbody tr[data-coin]').forEach(tr=>tr.addEventListener('click',()=>openDetail(tr.dataset.coin)));
  renderSectorBoard(SECT._rows);
}
function renderSectorCorr(list){
  const box=el('sect-corr');
  const tf=({'7':1,'30':1,'90':1}[state.sect.corrTf])?state.sect.corrTf:'30';
  const btn=(d,on)=>`<button type="button" data-scorr="${d}" style="font:inherit;cursor:pointer;padding:2px 8px;margin-left:4px;border-radius:4px;border:1px solid ${on?'var(--accent)':'var(--grid)'};background:transparent;color:${on?'var(--accent)':'inherit'};font-weight:${on?600:400}">${d}d</button>`;
  const ctl=`<div class="cp-head" style="margin-bottom:8px;display:flex;align-items:center;flex-wrap:wrap;gap:4px">`
    +`Sector × sector correlation <span class="sec" style="font-weight:400">— ${tf}d daily-return correlation, averaged across members</span>`
    +`<span style="margin-left:auto"><span class="sec" style="margin-right:2px">lookback</span>${btn('7',tf==='7')}${btn('30',tf==='30')}${btn('90',tf==='90')}</span></div>`;
  const bind=()=>{ box.querySelectorAll('button[data-scorr]').forEach(b=>b.addEventListener('click',()=>{
    state.sect.corrTf=b.dataset.scorr; if(!el('view-sectors').hidden) renderSectors(); })); };
  const cache=SECT._corrCache;
  if(!cache){ box.innerHTML=ctl+`<div class="sec" style="padding:8px 2px">Daily history still loading — sector correlation appears automatically once enough markets have it.${warmCount()}</div>`; bind(); return; }
  const {C, idxByG}=cache;
  const names=list.map(g=>g.name).filter(n=>idxByG.has(n)&&idxByG.get(n).length);
  if(names.length<2){ box.innerHTML=ctl+'<div class="sec" style="padding:8px 2px">Need at least two sectors with daily history.</div>'; bind(); return; }
  const avg=(A,B)=>{ const ia=idxByG.get(A), ib=idxByG.get(B); let s=0,n=0;
    for(const i of ia)for(const j of ib){ if(A===B&&j<=i)continue; const v=C[i][j]; if(v!=null&&isFinite(v)){s+=v;n++;} }
    return n?s/n:null; };
  const cell=names.length<=8?34:names.length<=14?24:18;
  let h=`<table class="cmx" style="--cell:${cell}px"><thead><tr><th class="corner"></th>`;
  names.forEach(n=>h+=`<th class="cl"><span>${esc(sectorShort(n))}</span></th>`);
  h+='</tr></thead><tbody>';
  names.forEach(rn=>{ h+=`<tr><th class="rl">${esc(sectorShort(rn))}</th>`;
    names.forEach(cn=>{ const self=rn===cn, v=self?1:avg(rn,cn);
      const txt=(v==null)?'':`${v<0?'−':''}${Math.abs(v).toFixed(1).replace(/^0/,'')}`;
      h+=`<td class="${self?'diag':(v==null?'nodata':'')}" title="${esc(sectorShort(rn))} × ${esc(sectorShort(cn))} · ${tf}d: ${v==null?'n/a':v.toFixed(2)}" style="${self||v==null?'':'background:'+corrColor(v)}">${self?'':txt}</td>`; });
    h+='</tr>'; });
  h+='</tbody></table>';
  box.innerHTML=ctl+h;
  bind();
}
function exportSectors(){ const list=SECT._rows; if(!list) return;
  const byInd=sectGrpActive();
  const head=[byInd?'Industry':'Sector',...(byInd?['GICS']:[]),'Type','Members','Rotation','Heat','Return%','DeltaOI%','Breadth%','Vol24h','OI','Cohesion'];
  const body=list.map(g=>[g.name,...(byInd?[g.gics||'']:[]),g.assetClass,g.n, g.rotation!=null?Math.round(g.rotation):'', g.heat,
    g.ret!=null?g.ret.toFixed(2):'', g.doi!=null?g.doi.toFixed(2):'', g.green!=null?Math.round(g.green*100):'',
    g.totVol!=null?Math.round(g.totVol):'', g.totOI!=null?Math.round(g.totOI):'', g.cohesion!=null?g.cohesion.toFixed(3):'']);
  downloadCSV(`xyz-${byInd?'industries':'sectors'}-${state.tf}.csv`,[head,...body]); }
export { computeSectors, exportSectors, renderSectors, sectorShort };
