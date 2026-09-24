// charts.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { activeRows, el, esc, fmtPrice, state } from "./core.js";
import { fetchJSON } from "./data.js";
import { shCanvasPng, shChartCard, shareOpen } from "./share.js";


// ===== CHARTS tab (build 2026.08.21-01) ========================================================
// Multi-pane chart grid per the approved mockup: GRID mode (up to 8 names, per-pane timeframe) or
// MTF wall (one name across timeframes). Two sources, disclosed per pane, never mixed in one pane:
//   5m/15m/1h/4h  <- ONE res=5m archive fetch per name (20d raw window, under the route's 6000-bar
//                    cap so the server never coarsens it), aggregated client-side on the UTC grid.
//                    UTC-midnight anchoring (not 09:30) is deliberate for now: the client has no
//                    calendar-engine payload on this tab yet, and a hardcoded session clock is
//                    exactly the guessed rhythm the FOCUS chart was rebuilt to avoid. Session
//                    shading + open-anchoring arrive when session windows ride a public payload.
//   4h/12h/1d     <- the deep archive (res=4h / res=12h / res=1d), seeded back to each listing's birth.
//                    Bars are HL's own UTC prints, used verbatim — no client re-cutting.
// LINK broadcasts the TRANSFORM (zoom factor about the hovered instant, pan delta, crosshair
// time), never the window itself, so a 1D pane is never squeezed into a 5M pane's 12 hours.
// Layouts persist per browser (mode, pane count, picks per scope, link, named slots).
const CH_TFS=[{k:5,l:'5M',src:'i'},{k:15,l:'15M',src:'i'},{k:60,l:'1H',src:'i'},{k:240,l:'4H',src:'d4h'},{k:720,l:'12H',src:'d12'},{k:1440,l:'1D',src:'d1d'}];   // 4H moved to the deep lane (-03): 20d of intraday base is 120 bars — an EMA200 cannot exist there
const CH_SRC_RES={d4h:'4h',d12:'12h',d1d:'1d'};
const CH_IBASE_DAYS=20;                          // 5760 raw 5m bars — one fetch feeds all four intraday TFs uncoarsened
const CH_DEF={5:12*3600000,15:36*3600000,60:7*86400000,240:60*86400000,720:180*86400000,1440:730*86400000};   // 4H default widened to 60d (-03): 360 bars, so a 200-period EMA is on screen from the reset view
const CH_MIN_SPAN=2*3600000;
const CH_MTF_SETS={4:[15,60,240,1440],6:[5,15,60,240,720,1440],8:[5,15,60,240,720,1440,60,240]};
const CH_CACHE_MS=60000;                         // per-(name,source) refetch floor; ETag 304s make the refresh nearly free
const CH_EMA_DEF=[50,200];                       // default pair; both periods user-configurable (2..500)
const CH={mode:'grid',n:4,link:false,picks:{stocks:[],crypto:[]},mtf:{stocks:null,crypto:null},slots:[],
  ema:{on:true,p1:CH_EMA_DEF[0],p2:CH_EMA_DEF[1]},
  panes:[],cache:new Map(),timer:null,built:false,seq:0};
function chEmaPeriod(v,def){ v=Math.round(+v); return Number.isFinite(v)&&v>=2&&v<=500?v:def; }
function chPrefsSave(){ try{ localStorage.setItem('xyz-charts',JSON.stringify({mode:CH.mode,n:CH.n,link:CH.link,picks:CH.picks,mtf:CH.mtf,slots:CH.slots,ema:CH.ema})); }catch(_){} }
function chPrefsLoad(){
  try{ const p=JSON.parse(localStorage.getItem('xyz-charts')||'null'); if(!p) return;
    if(p.mode==='grid'||p.mode==='mtf') CH.mode=p.mode;
    if([4,6,8].indexOf(+p.n)>=0) CH.n=+p.n;
    CH.link=!!p.link;
    if(p.picks&&Array.isArray(p.picks.stocks)&&Array.isArray(p.picks.crypto)) CH.picks=p.picks;
    if(p.mtf&&typeof p.mtf==='object') CH.mtf={stocks:p.mtf.stocks||null,crypto:p.mtf.crypto||null};
    if(Array.isArray(p.slots)) CH.slots=p.slots.slice(0,12);
    if(p.ema&&typeof p.ema==='object') CH.ema={on:p.ema.on!==false,p1:chEmaPeriod(p.ema.p1,CH_EMA_DEF[0]),p2:chEmaPeriod(p.ema.p2,CH_EMA_DEF[1])};
  }catch(_){}
}
function chScopeKey(){ return state.scope==='crypto'?'crypto':'stocks'; }
function chRoster(){ return activeRows().sort((a,b)=>(b.vol||0)-(a.vol||0)); }
function chDefaultPicks(){
  const sk=chScopeKey(), have=new Set(chRoster().map(r=>r.coin));
  CH.picks[sk]=(CH.picks[sk]||[]).filter(c=>have.has(c));
  if(!CH.picks[sk].length) CH.picks[sk]=chRoster().slice(0,CH.n).map(r=>r.coin);
  if(!CH.mtf[sk]||!have.has(CH.mtf[sk])) CH.mtf[sk]=(chRoster()[0]||{}).coin||null;
}
function chTick(coin){ const r=state.rows.get(coin); return r?r.ticker:(String(coin).includes(':')?String(coin).split(':')[1]:coin); }
function chPx(v){ return fmtPrice(v); }
// ---- data --------------------------------------------------------------------------------------
// One cache entry per (name, source). Intraday is a fixed rolling window (the archive's honest
// recent slice); deep sources take the server's own default span (the full seedable history).
async function chFetch(coin,src){
  const key=coin+'|'+src, c=CH.cache.get(key);
  if(c&&Date.now()-c.at<CH_CACHE_MS) return c;
  const now=Date.now();
  const url=src==='i'
    ? '/api/candles?coin='+encodeURIComponent(coin)+'&res=5m&from='+(now-CH_IBASE_DAYS*86400000)+'&to='+now+'&max=6000'
    : '/api/candles?coin='+encodeURIComponent(coin)+'&res='+CH_SRC_RES[src]+'&max=3000';
  const res=await fetchJSON(url);
  const v={at:Date.now(),enabled:res.enabled!==false,candles:Array.isArray(res.candles)?res.candles:[],cov:res.coverage||null};
  CH.cache.set(key,v); return v;
}
// Intraday aggregation on the UTC grid: floor(t/w)*w anchors every width at UTC midnight (all four
// divide a day), so 5m constituents can never straddle a bucket and re-aggregation is stable.
function chAgg(base,k){
  if(k===5) return base;
  const w=k*60000, by=new Map();
  for(const b of base){ const t=+b[0]; if(!isFinite(t)) continue;
    const t0=Math.floor(t/w)*w; let g=by.get(t0); if(!g) by.set(t0,g=[]); g.push(b); }
  const out=[];
  for(const [t0,g] of [...by.entries()].sort((a,b)=>a[0]-b[0])){
    let h=-Infinity,l=Infinity,vv=0;
    for(const r of g){ if(+r[2]>h)h=+r[2]; if(+r[3]<l)l=+r[3]; vv+=(+r[5]||0); }
    out.push([t0,+g[0][1],h,l,+g[g.length-1][4],vv]);
  }
  return out;
}
// EMA series over the WHOLE tape, SMA-seeded at index n-1: everything before the seed is null (an
// unconverged EMA head is a fabricated line, so it is simply not drawn), and a series shorter than
// the period yields no line at all \u2014 the coverage row discloses why instead of plotting a guess.
function chEmaWalk(series,n){
  const out=new Array(series.length).fill(null);
  if(!n||n<2||series.length<n) return out;
  let sum=0; for(let i=0;i<n;i++) sum+=+series[i][4];
  let e=sum/n; out[n-1]=e;
  const k=2/(n+1);
  for(let i=n;i<series.length;i++){ e=+series[i][4]*k+e*(1-k); out[i]=e; }
  return out;
}
function chEmas(p,series){
  const d=CH.cache.get(p.coin+'|'+p.src), at=d?d.at:0;
  const c=p._ema;
  if(c&&c.at===at&&c.tf===p.tf&&c.p1===CH.ema.p1&&c.p2===CH.ema.p2) return c;
  const v={at,tf:p.tf,p1:CH.ema.p1,p2:CH.ema.p2,e1:chEmaWalk(series,CH.ema.p1),e2:chEmaWalk(series,CH.ema.p2)};
  p._ema=v; return v;
}
function chSeries(p){
  const d=CH.cache.get(p.coin+'|'+p.src);
  if(!d||!d.enabled) return null;
  if(p.src!=='i') return d.candles;
  if(p._aggK===p.tf&&p._aggAt===d.at&&p._agg) return p._agg;
  p._agg=chAgg(d.candles,p.tf); p._aggK=p.tf; p._aggAt=d.at;
  return p._agg;
}
// ---- panes -------------------------------------------------------------------------------------
function chSpecs(){
  const sk=chScopeKey();
  if(CH.mode==='mtf'){ const nm=CH.mtf[sk]; return nm?(CH_MTF_SETS[CH.n]||CH_MTF_SETS[4]).map(tf=>({coin:nm,tf})):[]; }
  return (CH.picks[sk]||[]).slice(0,CH.n).map(c=>({coin:c,tf:15}));
}
function chBuild(){
  const w=el('chartswrap'); if(!w) return;
  chDefaultPicks();
  if(!CH.built){
    w.innerHTML=
      '<div class="chtb">'
      +'<span class="chlbl">mode</span><span class="chseg" id="chmode"><button type="button" data-m="grid" class="on">GRID</button><button type="button" data-m="mtf">MTF WALL</button></span>'
      +'<span class="chlbl">panes</span><span class="chseg" id="chn"><button type="button" data-n="4" class="on">4</button><button type="button" data-n="6">6</button><button type="button" data-n="8">8</button></span>'
      +'<span class="chlbl" id="chpicklbl">names</span><span class="chpick" id="chpick"></span>'
      +'<span class="chsp"></span>'
      +'<button type="button" id="chlink" data-tip="broadcast crosshair + zoom/pan across panes — each pane keeps its own span">LINK</button>'
      +'<button type="button" id="chreset" data-tip="reset every pane to its timeframe\u2019s default window">RESET</button>'
      +'<span class="chlbl">ema</span><button type="button" id="chemabtn" data-tip="two EMAs on every pane, walked over each pane\u2019s FULL series (not the viewport) \u2014 warm-up bars stay empty rather than plotting an unconverged head">EMA</button>'
      +'<input type="number" id="chema1" class="chemain e1" min="2" max="500" step="1" data-tip="first EMA period (2\u2013500)"><input type="number" id="chema2" class="chemain e2" min="2" max="500" step="1" data-tip="second EMA period (2\u2013500)">'
      +'<span class="chlbl">layouts</span><span class="chpick" id="chslots"></span><button type="button" id="chsave">SAVE</button>'
      +'</div>'
      +'<div class="chgrid" id="chgrid"></div>'
      +'<div class="chfoot">intraday panes (5m\u20131h): local 5m archive, last '+CH_IBASE_DAYS+'d, UTC-grid buckets \u00b7 4H/12H/1D panes: deep archive seeded to each listing\u2019s birth, bars verbatim from the exchange \u00b7 wheel/pinch = zoom \u00b7 drag = pan \u00b7 double-click = reset \u00b7 per-pane coverage bottom-left</div>';
    el('chmode').querySelectorAll('button').forEach(b=>b.onclick=()=>{ CH.mode=b.dataset.m; if(CH.mode==='mtf') CH.link=true; chPrefsSave(); chBuild(); });
    el('chn').querySelectorAll('button').forEach(b=>b.onclick=()=>{ CH.n=+b.dataset.n; chPrefsSave(); chBuild(); });
    el('chlink').onclick=()=>{ if(CH.mode==='mtf') return; CH.link=!CH.link; chPrefsSave(); chSyncToolbar(); };
    el('chreset').onclick=()=>{ CH.panes.forEach(p=>{ chResetView(p); chDraw(p); }); };
    el('chemabtn').onclick=()=>{ CH.ema.on=!CH.ema.on; chPrefsSave(); chSyncToolbar(); CH.panes.forEach(chDraw); };
    const emaIn=(id,key,def)=>{ const i=el(id); i.addEventListener('change',()=>{ CH.ema[key]=chEmaPeriod(i.value,def); i.value=CH.ema[key]; chPrefsSave(); CH.panes.forEach(chDraw); }); };
    emaIn('chema1','p1',CH_EMA_DEF[0]); emaIn('chema2','p2',CH_EMA_DEF[1]);
    el('chsave').onclick=()=>{
      const nm=prompt('Name this layout','Layout '+(CH.slots.length+1));
      if(!nm) return;
      CH.slots.push({name:String(nm).slice(0,24),mode:CH.mode,n:CH.n,link:CH.link,scope:chScopeKey(),picks:(CH.picks[chScopeKey()]||[]).slice(0,8),mtf:CH.mtf[chScopeKey()]||null});
      if(CH.slots.length>12) CH.slots.shift();
      chPrefsSave(); chRenderSlots();
    };
    CH.built=true;
  }
  chSyncToolbar(); chRenderPicker(); chRenderSlots();
  const g=el('chgrid');
  g.className='chgrid g'+CH.n;
  g.innerHTML='';
  CH.panes=[];
  const specs=chSpecs(), seq=++CH.seq;
  if(!specs.length){
    g.innerHTML='<div class="chpane"><div class="chempty"><b>No charts loaded</b>Pick tickers in the bar above \u2014 up to '+CH.n+' panes from the active universe.</div></div>';
    return;
  }
  specs.forEach(sp=>{
    const d=document.createElement('div'); d.className='chpane';
    d.innerHTML=
      '<div class="chph"><span class="chtk">'+esc(chTick(sp.coin))+'</span>'
      +'<span class="chuni">'+(String(sp.coin).includes(':')?'XYZ':'PERP')+'</span>'
      +'<span class="chlast"></span>'
      +(CH.mode==='mtf'
        ?'<span class="chtflock">'+esc((CH_TFS.find(t=>t.k===sp.tf)||{}).l||sp.tf)+'</span>'
        :'<span class="chtfs">'+CH_TFS.map(t=>'<button type="button" data-tf="'+t.k+'"'+(t.k===sp.tf?' class="on"':'')+'>'+t.l+'</button>').join('')+'</span>')
      +'<button type="button" class="chshr" title="share this chart to chat \u2014 the pane as a picture, the window\u2019s facts as its caption">\u2934</button>'
      +'</div>'
      +'<div class="chrd"><span class="chk">hover for OHLC \u00b7 V \u00b7 bar \u0394</span></div>'
      +'<div class="chcw"><canvas></canvas><span class="chcov"></span></div>';
    g.appendChild(d);
    const src=(CH_TFS.find(t=>t.k===sp.tf)||{}).src||'i';
    const p={el:d,coin:sp.coin,tf:sp.tf,src,canvas:d.querySelector('canvas'),rd:d.querySelector('.chrd'),
      lastEl:d.querySelector('.chlast'),covEl:d.querySelector('.chcov'),view:null,hover:null,_agg:null,_aggK:0,_aggAt:0};
    p.ctx=p.canvas.getContext('2d');
    CH.panes.push(p);
    chWire(p);
    d.querySelector('.chshr').addEventListener('click',()=>shareOpen(chShareCard(p)));
    chLoad(p,seq);
  });
}
async function chLoad(p,seq){
  try{
    await chFetch(p.coin,p.src);
    if(seq!==CH.seq) return;                     // a rebuild superseded this pane
    if(!p.view) chResetView(p);
    chDraw(p);
  }catch(_){ if(seq===CH.seq&&p.rd) p.rd.innerHTML='<span class="chk">candles endpoint did not answer \u2014 will retry on the next refresh</span>'; }
}
function chBounds(p){
  const s=chSeries(p);
  if(!s||!s.length) return null;
  const w=p.tf*60000;
  return { from:s[0][0], to:s[s.length-1][0]+w };
}
function chResetView(p){
  const b=chBounds(p);
  if(!b){ p.view=null; return; }
  const span=Math.min(CH_DEF[p.tf]||(b.to-b.from), b.to-b.from);
  p.view={from:b.to-span,to:b.to};
}
function chClamp(p){
  const b=chBounds(p); if(!b||!p.view) return;
  const v=p.view, minSpan=Math.min(CH_MIN_SPAN,b.to-b.from);
  let span=Math.max(minSpan,Math.min(v.to-v.from,b.to-b.from));
  if(v.to-v.from!==span){ const mid=(v.from+v.to)/2; v.from=mid-span/2; v.to=mid+span/2; }   // zoom floor/ceiling re-applied about the center
  if(v.from<b.from){ v.from=b.from; v.to=b.from+span; }
  if(v.to>b.to){ v.to=b.to; v.from=b.to-span; }
  if(v.from<b.from) v.from=b.from;
}
// LINK: same factor / same delta / same instant to every pane — never the window itself.
function chZoomAll(src,factor,anchorT){
  const targets=CH.link?CH.panes:[src];
  for(const p of targets){
    if(!p.view) continue;
    const at=(p===src)?anchorT:(p.view.from+p.view.to)/2;
    const f=Math.max(0,Math.min(1,(at-p.view.from)/(p.view.to-p.view.from)));
    const span=(p.view.to-p.view.from)*factor;
    p.view={from:at-span*f,to:at+span*(1-f)};
    chClamp(p); chDraw(p);
  }
}
function chPanAll(src,dt){
  const targets=CH.link?CH.panes:[src];
  for(const p of targets){ if(!p.view) continue; p.view.from+=dt; p.view.to+=dt; chClamp(p); chDraw(p); }
}
function chHoverAll(src,t){
  const targets=CH.link?CH.panes:[src];
  for(const p of targets){ p.hover=t; chDraw(p); }
}
// ---- draw --------------------------------------------------------------------------------------
function chVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function chFmtT(t,tf){
  const d=new Date(t), hm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  const md=String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0');
  return tf>=1440?md+'/'+String(d.getFullYear()).slice(2):(tf>=240?md+' '+hm:hm);
}
function chFmtV(v){ v=+v; if(!isFinite(v)) return '\u2014'; return v>=1e9?(v/1e9).toFixed(1)+'B':v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(1)+'k':String(Math.round(v)); }
function chDraw(p){
  const c=p.canvas,ctx=p.ctx,dpr=window.devicePixelRatio||1;
  const w=c.clientWidth,h=c.clientHeight;
  if(!w||!h) return;
  if(c.width!==Math.round(w*dpr)||c.height!==Math.round(h*dpr)){ c.width=Math.round(w*dpr); c.height=Math.round(h*dpr); }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  const mono=chVar('--mono')||'monospace';
  const d=CH.cache.get(p.coin+'|'+p.src);
  const msg=(t)=>{ ctx.fillStyle=chVar('--muted'); ctx.font='10px '+mono; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(t,w/2,h/2); };
  if(d&&d.enabled===false){ msg('archive disabled on this deploy \u2014 no chart source'); p.covEl.textContent=''; return; }
  const series=chSeries(p);
  if(!series){ msg('loading\u2026'); return; }
  if(!series.length){ msg('no bars captured for this name yet'); p.covEl.textContent=''; return; }
  if(!p.view) chResetView(p);
  const PR=Math.min(58,w*0.17),PB=15,PT=4;
  const pw=w-PR, ph=h-PB-PT;
  if(pw<40||ph<30) return;
  const volH=Math.max(11,ph*0.15), wMs=p.tf*60000;
  const v=p.view, span=v.to-v.from;
  const bars=series.filter(b=>b[0]+wMs>=v.from&&b[0]<=v.to);
  const X=(t)=>(t-v.from)/span*pw;
  const up=chVar('--up'),dn=chVar('--down'),grid=chVar('--grid')||chVar('--border'),mute=chVar('--muted');
  if(!bars.length){ msg('no bars in this window'); }
  else{
    let lo=Infinity,hi=-Infinity,vmax=0;
    for(const b of bars){ if(+b[3]<lo)lo=+b[3]; if(+b[2]>hi)hi=+b[2]; if(+b[5]>vmax)vmax=+b[5]; }
    const pad=(hi-lo)*0.06||Math.abs(hi)*0.002||1; lo-=pad; hi+=pad;
    const Y=(x)=>PT+(ph-volH-3)-((x-lo)/(hi-lo))*(ph-volH-3);
    ctx.strokeStyle=grid; ctx.lineWidth=1; ctx.fillStyle=mute;
    ctx.font='9.5px '+mono; ctx.textAlign='left'; ctx.textBaseline='middle';
    for(let i=0;i<=3;i++){
      const val=lo+(hi-lo)*i/3, y=Math.round(Y(val))+0.5;
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(pw,y); ctx.stroke();
      ctx.fillText(chPx(val),pw+4,y);
    }
    const step=pw/Math.max(1,span/wMs), bw=Math.max(1,Math.min(11,step*0.68));
    // Right-edge fix (-02): the raw mapping put the LAST bar's center half a bar-width from the
    // plot edge, so with narrow bars its right half fell off the plot \u2014 the standing
    // \u201clast candle cut in half\u201d. Inset the drawable span by half a body (+1px) so a
    // series at rest always shows its final bar whole, and hard-clip the bar/EMA layer to the
    // plot rect so a bar straddling the edge mid-pan cuts cleanly instead of bleeding under the
    // price axis. The inset is stored on the pane so the pointer\u2192time inverse in chWire
    // uses the SAME mapping \u2014 a crosshair off by the inset would hover the wrong bar.
    const inset=Math.ceil(bw/2)+1;
    p._inset=inset;
    const Xi=(t)=>(t-v.from)/span*(pw-inset);
    ctx.save(); ctx.beginPath(); ctx.rect(0,PT,pw,ph); ctx.clip();
    for(const b of bars){
      const x=Xi(b[0]+wMs/2), col=+b[4]>=+b[1]?up:dn;
      ctx.fillStyle=col; ctx.strokeStyle=col;
      ctx.globalAlpha=0.32;
      const vh=vmax?(+b[5]/vmax)*volH:0;
      ctx.fillRect(x-bw/2,PT+ph-vh,Math.max(1,bw),vh);
      ctx.globalAlpha=1;
      ctx.beginPath(); ctx.moveTo(Math.round(x)+0.5,Y(+b[2])); ctx.lineTo(Math.round(x)+0.5,Y(+b[3])); ctx.stroke();
      const y1=Y(+b[1]),y2=Y(+b[4]);
      ctx.fillRect(x-bw/2,Math.min(y1,y2),Math.max(1,bw),Math.max(1,Math.abs(y2-y1)));
    }
    // EMA overlay (-02): drawn over the FULL walk (chEmas), sliced to the viewport by x \u2014 the
    // line entering the left edge already carries its whole history, never a viewport-local restart.
    let em=null;
    if(CH.ema.on){
      em=chEmas(p,series);
      const line=(arr,col)=>{ ctx.strokeStyle=col; ctx.lineWidth=1.2; ctx.beginPath(); let pen=false;
        for(let i=0;i<series.length;i++){ const val=arr[i]; if(val==null){ pen=false; continue; }
          const t=series[i][0]+wMs/2; if(t<v.from-wMs||t>v.to+wMs) continue;
          const x=Xi(t), y=Y(val); if(y<PT-20||y>PT+ph+20){ pen=false; continue; }
          if(pen) ctx.lineTo(x,y); else { ctx.moveTo(x,y); pen=true; } }
        ctx.stroke(); };
      line(em.e1,chVar('--blue')); line(em.e2,chVar('--accent'));
    }
    ctx.restore();
    ctx.fillStyle=mute; ctx.textAlign='center'; ctx.textBaseline='top';
    const ticks=Math.max(2,Math.min(6,Math.floor(pw/76)));
    for(let i=0;i<=ticks;i++){
      const t=v.from+span*i/ticks, x=Xi(t);
      if(x<16||x>pw-16) continue;
      ctx.fillText(chFmtT(t,p.tf),x,PT+ph+3);
    }
    // crosshair + readout (interactive hover on every chart — standing requirement)
    let hb=null;
    if(p.hover!=null&&p.hover>=v.from&&p.hover<=v.to){
      let best=Infinity;
      for(const b of bars){ const dd=Math.abs(b[0]+wMs/2-p.hover); if(dd<best){ best=dd; hb=b; } }
      if(hb){
        const x=Math.round(Xi(hb[0]+wMs/2))+0.5;
        ctx.strokeStyle=chVar('--border'); ctx.setLineDash([2,3]);
        ctx.beginPath(); ctx.moveTo(x,PT); ctx.lineTo(x,PT+ph); ctx.stroke();
        const yc=Math.round(Y(+hb[4]))+0.5;
        ctx.beginPath(); ctx.moveTo(0,yc); ctx.lineTo(pw,yc); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle=chVar('--blue'); ctx.fillRect(pw,yc-7,PR,14);
        ctx.fillStyle='#0E1116'; ctx.font='9.5px '+mono; ctx.textAlign='left'; ctx.textBaseline='middle';
        ctx.fillText(chPx(+hb[4]),pw+4,yc);
      }
    }
    const lastBar=series[series.length-1], prev=series.length>1?series[series.length-2]:lastBar;
    const chg=prev&&+prev[4]?(+lastBar[4]/+prev[4]-1)*100:null;
    p.lastEl.textContent=chPx(+lastBar[4])+(chg!=null?'  '+(chg>=0?'+':'')+chg.toFixed(2)+'%':'');
    p.lastEl.className='chlast '+(chg==null?'':chg>=0?'pos':'neg');
    if(hb){
      const dd=+hb[1]?(+hb[4]/+hb[1]-1)*100:null, cls=dd!=null&&dd>=0?'pos':'neg';
      let emh='';
      if(em){ const bi=series.indexOf(hb);
        const v1=bi>=0?em.e1[bi]:null, v2=bi>=0?em.e2[bi]:null;
        emh=' <span class="chke1">E'+CH.ema.p1+'</span> '+(v1!=null?chPx(v1):'\u2014')
           +' <span class="chke2">E'+CH.ema.p2+'</span> '+(v2!=null?chPx(v2):'\u2014'); }
      p.rd.innerHTML='<span class="chk">'+chFmtT(hb[0],p.tf)+'</span> <span class="chk">O</span> '+chPx(+hb[1])
        +' <span class="chk">H</span> '+chPx(+hb[2])+' <span class="chk">L</span> '+chPx(+hb[3])
        +' <span class="chk">C</span> '+chPx(+hb[4])+' <span class="chk">V</span> '+chFmtV(hb[5])
        +(dd!=null?' <span class="'+cls+'">'+(dd>=0?'+':'')+dd.toFixed(2)+'%</span>':'')+emh;
    }else p.rd.innerHTML='<span class="chk">hover for OHLC \u00b7 V \u00b7 bar \u0394'+(CH.ema.on?' \u00b7 EMA'+CH.ema.p1+'/'+CH.ema.p2:'')+'</span>';
  }
  // coverage disclosure: what this pane's SOURCE actually holds, never what the window implies
  const cov=d&&d.cov;
  let covTxt=cov&&cov.days?((p.src==='i'?'5m archive ':'deep archive ')+cov.days+'d \u00b7 '+(cov.count||0)+' bars'):'';
  if(covTxt&&CH.ema.on&&series&&series.length&&series.length<CH.ema.p2)
    covTxt+=' \u00b7 EMA'+CH.ema.p2+' needs '+CH.ema.p2+' bars ('+series.length+' held)';
  p.covEl.textContent=covTxt;
}
// ---- share (build 2026.09.24-98) -------------------------------------------------------------
// The pane as it is drawn — its zoom, its pan, its EMA ribbon — minus the crosshair, which is a
// pointer and not the chart: redrawn once without the hover, copied onto a panel-coloured floor,
// then redrawn as it was. The caption is the visible window's facts.
async function chShareCard(p){
  const s=chSeries(p); if(!s||!s.length||!p.view) return null;
  const hv=p.hover; p.hover=null; chDraw(p);
  const png=await shCanvasPng(p.canvas);
  p.hover=hv; chDraw(p);
  if(!png) return null;
  const wMs=p.tf*60000, bars=s.filter(b=>b[0]+wMs>=p.view.from&&b[0]<=p.view.to);
  if(!bars.length) return null;
  const a=bars[0], z=bars[bars.length-1], tfl=(CH_TFS.find(t=>t.k===p.tf)||{}).l||String(p.tf);
  let lo=Infinity,hi=-Infinity; for(const b of bars){ if(+b[3]<lo)lo=+b[3]; if(+b[2]>hi)hi=+b[2]; }
  const chg=+a[1]>0?(+z[4]/+a[1]-1)*100:null;
  return shChartCard({ view:'charts', coin:p.coin, tf:tfl, title:tfl+' candles \u00b7 '+bars.length+' bars', name:'chart-'+chTick(p.coin)+'-'+tfl+'.png', png,
    rows:[{t:'last',c:[{s:chPx(+z[4]),c:''}]},
      ...(chg!=null?[{t:'window',c:[{s:(chg>=0?'+':'')+chg.toFixed(2)+'%',c:chg>0?'pos':chg<0?'neg':'sec'}]}]:[]),
      {t:'range',c:[{s:chPx(lo)+' \u2013 '+chPx(hi),c:''}]},
      {t:'from',c:[{s:chFmtT(a[0],p.tf)+' \u2192 '+chFmtT(z[0],p.tf),c:'sec'}]}] });
}
// ---- interaction -------------------------------------------------------------------------------
function chWire(p){
  const c=p.canvas;
  const tAt=(ev)=>{
    const r=c.getBoundingClientRect(), pw=r.width-Math.min(58,r.width*0.17)-(p._inset||0);
    const f=Math.max(0,Math.min(1,(ev.clientX-r.left)/Math.max(1,pw)));
    return p.view?p.view.from+(p.view.to-p.view.from)*f:null;
  };
  c.addEventListener('wheel',(e)=>{ if(!p.view) return; e.preventDefault(); chZoomAll(p,e.deltaY>0?1.18:1/1.18,tAt(e)); },{passive:false});
  c.addEventListener('dblclick',()=>{ (CH.link?CH.panes:[p]).forEach(q=>{ chResetView(q); chDraw(q); }); });
  const ptrs=new Map(); let drag=null,pinchRef=null;
  c.addEventListener('pointerdown',(e)=>{
    ptrs.set(e.pointerId,e.clientX);
    if(ptrs.size===2){ const xs=[...ptrs.values()]; pinchRef={d:Math.abs(xs[0]-xs[1])||1,view:p.view?{...p.view}:null,lastF:1}; drag=null; }
    else if(p.view){ drag={x:e.clientX}; }
    c.setPointerCapture(e.pointerId);
  });
  c.addEventListener('pointermove',(e)=>{
    if(ptrs.has(e.pointerId)) ptrs.set(e.pointerId,e.clientX);
    if(ptrs.size===2&&pinchRef&&pinchRef.view){
      const xs=[...ptrs.values()], nd=Math.abs(xs[0]-xs[1])||1, f=pinchRef.d/nd;
      const mid=(pinchRef.view.from+pinchRef.view.to)/2, span=(pinchRef.view.to-pinchRef.view.from)*f;
      p.view={from:mid-span/2,to:mid+span/2}; chClamp(p); chDraw(p);
      // Linked peers get the INCREMENTAL factor since the last move (this pane's own window is set
      // absolutely from the pinch reference, so re-broadcasting the total factor would compound).
      if(CH.link&&pinchRef.lastF){ const inc=f/pinchRef.lastF;
        for(const q of CH.panes){ if(q===p||!q.view) continue;
          const m=(q.view.from+q.view.to)/2, s2=(q.view.to-q.view.from)*inc;
          q.view={from:m-s2/2,to:m+s2/2}; chClamp(q); chDraw(q); } }
      pinchRef.lastF=f;
      return;
    }
    if(drag&&p.view){
      const r=c.getBoundingClientRect(), pw=r.width-Math.min(58,r.width*0.17);
      const dt=-(e.clientX-drag.x)/Math.max(1,pw)*(p.view.to-p.view.from);
      drag.x=e.clientX; chPanAll(p,dt);
    }else{
      chHoverAll(p,tAt(e));
    }
  });
  const end=(e)=>{ ptrs.delete(e.pointerId); if(ptrs.size<2) pinchRef=null; if(!ptrs.size) drag=null; };
  c.addEventListener('pointerup',end); c.addEventListener('pointercancel',end);
  c.addEventListener('pointerleave',(e)=>{ end(e); chHoverAll(p,null); });
  p.el.querySelectorAll('[data-tf]').forEach(b=>b.onclick=()=>{
    p.tf=+b.dataset.tf;
    p.src=(CH_TFS.find(t=>t.k===p.tf)||{}).src||'i';
    p._agg=null; p._aggK=0; p.view=null;
    p.el.querySelectorAll('[data-tf]').forEach(x=>x.classList.toggle('on',x===b));
    chLoad(p,CH.seq);
  });
}
// ---- toolbar -----------------------------------------------------------------------------------
function chSyncToolbar(){
  if(!CH.built) return;
  el('chmode').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.m===CH.mode));
  el('chn').querySelectorAll('button').forEach(b=>b.classList.toggle('on',+b.dataset.n===CH.n));
  const lk=el('chlink');
  lk.classList.toggle('on',CH.link);
  lk.disabled=CH.mode==='mtf';
  lk.textContent=CH.mode==='mtf'?'LINK \u00b7 locked':'LINK';
  el('chemabtn').classList.toggle('on',CH.ema.on);
  el('chema1').value=CH.ema.p1; el('chema2').value=CH.ema.p2;
  el('chema1').disabled=el('chema2').disabled=!CH.ema.on;
}
function chRenderPicker(){
  const box=el('chpick'); if(!box) return;
  el('chpicklbl').textContent=CH.mode==='mtf'?'instrument':'names';
  const sk=chScopeKey(), roster=chRoster();
  const cur=CH.mode==='mtf'?null:new Set(CH.picks[sk]||[]);
  const mkChip=(coin,on)=>{ const b=document.createElement('button'); b.type='button';
    b.className='chchip'+(on?' on':''); b.textContent=chTick(coin);
    b.onclick=()=>{
      if(CH.mode==='mtf'){ CH.mtf[sk]=coin; }
      else{
        const arr=CH.picks[sk]||(CH.picks[sk]=[]);
        const i=arr.indexOf(coin);
        if(i>=0) arr.splice(i,1);
        else{ if(arr.length>=CH.n) arr.shift(); arr.push(coin); }   // grid full: oldest pick rotates out (mockup behaviour, approved)
      }
      chPrefsSave(); chBuild();
    };
    return b;
  };
  box.innerHTML='';
  // selected first (order preserved), then a type-ahead over the rest — 8 chips can't carry 150 names
  const sel=CH.mode==='mtf'?(CH.mtf[sk]?[CH.mtf[sk]]:[]):(CH.picks[sk]||[]);
  sel.forEach(c=>box.appendChild(mkChip(c,true)));
  const inp=document.createElement('input');
  inp.type='text'; inp.className='chfind'; inp.placeholder='add ticker\u2026'; inp.autocomplete='off'; inp.spellcheck=false;
  const dd=document.createElement('div'); dd.className='chdd'; dd.hidden=true;
  const fill=()=>{
    const q=inp.value.trim().toUpperCase();
    dd.innerHTML='';
    if(!q){ dd.hidden=true; return; }
    const hits=roster.filter(r=>r.ticker.toUpperCase().indexOf(q)>=0&&(CH.mode==='mtf'||!cur.has(r.coin))).slice(0,8);
    if(!hits.length){ dd.hidden=true; return; }
    hits.forEach(r=>{ const o=document.createElement('button'); o.type='button'; o.textContent=r.ticker;
      o.onclick=()=>{ inp.value=''; dd.hidden=true; mkChip(r.coin,false).onclick(); }; dd.appendChild(o); });
    dd.hidden=false;
  };
  inp.addEventListener('input',fill);
  inp.addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ const f=dd.querySelector('button'); if(f) f.click(); } if(e.key==='Escape'){ dd.hidden=true; } });
  inp.addEventListener('blur',()=>setTimeout(()=>{ dd.hidden=true; },150));
  const wrap=document.createElement('span'); wrap.className='chfindwrap'; wrap.appendChild(inp); wrap.appendChild(dd);
  box.appendChild(wrap);
}
function chRenderSlots(){
  const box=el('chslots'); if(!box) return;
  box.innerHTML='';
  CH.slots.forEach((s,i)=>{
    const b=document.createElement('button'); b.type='button'; b.className='chchip';
    b.textContent=s.name; b.title='load \u00b7 shift-click to delete';
    b.onclick=(e)=>{
      if(e.shiftKey){ CH.slots.splice(i,1); chPrefsSave(); chRenderSlots(); return; }
      CH.mode=s.mode==='mtf'?'mtf':'grid'; CH.n=[4,6,8].indexOf(+s.n)>=0?+s.n:4; CH.link=!!s.link||CH.mode==='mtf';
      const sk=s.scope==='crypto'?'crypto':'stocks';
      if(Array.isArray(s.picks)) CH.picks[sk]=s.picks.slice(0,8);
      if(s.mtf) CH.mtf[sk]=s.mtf;
      chPrefsSave(); chBuild();
    };
    box.appendChild(b);
  });
}
// ---- entry -------------------------------------------------------------------------------------
// Refresh rhythm: while the tab is visible, re-pull every pane's cache past the 60s floor (ETag
// 304s make an unchanged tape nearly free) and redraw PRESERVING each viewport — a refresh must
// never yank a chart out from under a zoomed-in read.
let _chScope=null;
function openCharts(){
  chPrefsLoad();
  const sk=chScopeKey();
  if(_chScope!==sk){ _chScope=sk; CH.seq++; }
  chBuild();
  if(CH.timer) clearInterval(CH.timer);
  CH.timer=setInterval(async()=>{
    const vw=el('view-charts'); if(!vw||vw.hidden) return;
    const seq=CH.seq;
    // Remember each pane's pre-refresh bounds + whether it sat at the live edge: a pinned view
    // FOLLOWS new bars (same span, shifted to the new close) so \u201cauto update\u201d means the
    // chart actually advances \u2014 while a view parked in history stays exactly where the reader
    // left it, never yanked forward by a refresh.
    const pre=CH.panes.map(p=>{ const b=chBounds(p);
      return { p, to:b?b.to:null, pinned:!!(b&&p.view&&p.view.to>=b.to-p.tf*60000*0.51) }; });
    const seen=new Set();
    for(const p of CH.panes){
      const key=p.coin+'|'+p.src;
      if(seen.has(key)) continue; seen.add(key);
      const c=CH.cache.get(key);
      if(c&&Date.now()-c.at<CH_CACHE_MS) continue;
      try{ p._agg=null; await chFetch(p.coin,p.src); }catch(_){}
      if(seq!==CH.seq) return;
    }
    for(const q of pre){
      const p=q.p; p._agg=null;
      const nb=chBounds(p);
      if(q.pinned&&nb&&q.to!=null&&nb.to>q.to&&p.view){
        const span=p.view.to-p.view.from;
        p.view={from:nb.to-span,to:nb.to};
      }
      chClamp(p); chDraw(p);
    }
  },CH_CACHE_MS);
}

export function __boot_charts_6690() {
{ let _chRt=null; window.addEventListener('resize',()=>{ clearTimeout(_chRt); _chRt=setTimeout(()=>{ const vw=el('view-charts'); if(vw&&!vw.hidden) CH.panes.forEach(chDraw); },90); }); }
}

export { openCharts };
