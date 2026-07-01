// ===== Treemap tab — self-installing ========================================
// Drop this file in /public and add ONE line to index.html, right AFTER the
// existing app.js script tag:
//     <script src="treemap.js"></script>
// It injects its own tab + view and wires itself to the app's existing
// showView / setWindow / openDetail / computeSectors. No other edits needed.

// --- size / color metrics -------------------------------------------------
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
      const theme=document.getElementById('themeBtn');
      if(theme && theme.parentNode===nav) nav.insertBefore(btn,theme); else nav.appendChild(btn); }

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

    // deep link (#treemap on load)
    if((location.hash||'').replace(/^#/,'')==='treemap' && typeof showView==='function'){
      showView('treemap'); sec.hidden=false; renderTreemap(); }
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
  else boot();
})();
