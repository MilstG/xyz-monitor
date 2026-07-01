// ===== App-wide tooltips — self-installing ==================================
// Drop into /public and add ONE line to index.html, after app.js:
//     <script src="tooltips.js"></script>
//
//  1. Styled, cursor-following tooltips for every SVG chart carrying a <title>
//     (flow map, leaders map, treemap tiles).
//  2. Crosshair + value readout on the trend sparklines (.tspark), read from
//     state.rows — and on any sparkline that carries data-series (e.g. after
//     the one-line sparkline() patch: drawer OI/funding + correlation pairs).

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
    var parts=raw.split(' \u00b7 '), h='<b>'+esc(parts[0])+'</b>';
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
})();
