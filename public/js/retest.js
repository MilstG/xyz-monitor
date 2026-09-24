// retest.js — the D1 retest study panel on the Backtest tab (build 2026.09.24-96). The Trend
// board's D1 RETEST (a stacked daily ribbon whose recent low probed the 13/21 zone while the close
// held EMA21 — the short mirror for rallies) replayed over every closed day the server holds, and
// scored against the same names' stacked-but-not-retesting bars: does the pullback beat the trend
// it rides? Server-computed (GET /api/retest-study, compute.d1RetestEvents + d1RetestStudy) —
// because the daily LOWS the probe needs exist only server-side (the spine overlay in
// mergedDailyBars; /api/daily ships closes), and crypto's wire history is ~90 days against the
// server's 370. This file renders the payload; it never re-derives an event.
//
// The mockup's two open decisions ship as controls instead of being settled by fiat: the event
// definition ('board' = ladder-verbatim 3-bar probe, fires in runs · 'touch' = first touch of the
// pullback only) and the cooldown (closed bars before the same name and side may fire again).
// Every pair is served and cached server-side; the choice persists per browser.
import { drawBacktest } from "./backtest.js";
import { sCap, sHead } from "./admin.js";
import { el, esc, isoUtc, state, store } from "./core.js";
import { downloadCSV } from "./corr.js";
import { fetchJSON } from "./data.js";
import { openDetail } from "./drawer.js";

const RT_KEY='xyzmon.d1rt.v1';
const RT_REFRESH_MS=300000;     // the study moves when a daily bar closes; 5 min is plenty
const RT_EVENTS_SHOWN=25;       // recent-events table; the CSV carries every event the server shipped
const RT=Object.assign({ side:'long', def:'board', cd:5 }, (()=>{ try{ return JSON.parse(store.get(RT_KEY)||'{}')||{}; }catch(_){ return {}; } })());
const rtMemo=new Map();         // "scope|def|cd" -> { data, at, pending }
function rtSave(){ try{ store.set(RT_KEY, JSON.stringify({ side:RT.side, def:RT.def, cd:RT.cd })); }catch(_){} }
function rtKey(){ return (state.scope==='crypto'?'crypto':'stocks')+'|'+RT.def+'|'+RT.cd; }
async function loadRetestStudy(){
  const k=rtKey(), m=rtMemo.get(k)||{ data:null, at:0, pending:false };
  rtMemo.set(k,m);
  if(m.pending||(m.at&&Date.now()-m.at<RT_REFRESH_MS)) return;
  m.pending=true;
  try{ m.data=await fetchJSON(`/api/retest-study?u=${state.scope==='crypto'?'crypto':'stocks'}&def=${encodeURIComponent(RT.def)}&cd=${encodeURIComponent(RT.cd)}`); m.at=Date.now(); }
  catch(_){ m.at=Date.now()-RT_REFRESH_MS+30000; }   // a failed pull retries in 30s, not on every repaint
  m.pending=false;
  if(state.view==='backtest'&&rtKey()===k) drawBacktest();
}
const rtPct=(v,d=2)=>v==null||!isFinite(v)?'·':(v>0?'+':'')+v.toFixed(d)+'%';
const rtSd=v=>v==null||!isFinite(v)?'·':(v>0?'+':'')+v.toFixed(2)+'σ';
const rtRate=v=>v==null||!isFinite(v)?'·':Math.round(v*100)+'%';
const rtPP=v=>v==null||!isFinite(v)?'·':(v>0?'+':'')+Math.round(v*100)+'pp';
const rtCls=v=>v==null||!isFinite(v)?'':v>0?'pos':v<0?'neg':'';
// One row per horizon: the event, its control, and the excess — the excess columns are the panel.
// (build 2026.09.24-106) horizon unit: session bars on a calendar market (the -105 session fold),
// calendar days on crypto — from the payload, else from the scope.
function rtUnit(p){ const u=p&&p.unit; return u?(u==='sessions'?' sess':'d'):(state.scope==='crypto'?'d':' sess'); }
// n with the number of distinct event DATES behind it (same-day events across names share a tape,
// so the dates are the effective sample), and the mean with ±1.96·SE clustered by event date.
function rtN(c){ return c.dates!=null&&c.dates>0?`${c.n}<span class="sec" data-tip="${c.n} events on ${c.dates} distinct dates — same-day events across names share one tape, so the dates are the effective sample"> · ${c.dates}dt</span>`:`${c.n}`; }
function rtMeanCi(c){ return c.se!=null&&isFinite(c.se)?`<span class="sec" data-tip="±1.96 × the standard error two-way clustered by name and event date (events on the same day, and one name\u2019s repeated retests, are not independent)${Math.abs(c.mean)<1.96*c.se?' — the interval includes 0':''}"> ±${(1.96*c.se).toFixed(2)}</span>`:''; }
function rtRow(h,c,floor,unit){
  if(!c) return '';
  const under=c.hit==null;
  const ctl=c.ctl||{};
  const ev=under
    ?`<td>${rtN(c)}</td><td class="dim2" colspan="5" data-tip="n=${c.n} sits under the ${floor}-event floor — the cell publishes its n and nothing else">under floor</td>`
    :`<td>${rtN(c)}</td><td>${rtRate(c.hit)}</td><td class="${rtCls(c.mean)}">${rtPct(c.mean)}${rtMeanCi(c)}</td><td class="${rtCls(c.med)}">${rtPct(c.med)}</td><td class="${rtCls(c.meanSd)}">${rtSd(c.meanSd)}</td>`
      +`<td class="sec" data-tip="share of events whose price touched the event bar's own EMA21 — the tretest void — inside ${h} bar${h===1?'':'s'}">${rtRate(c.void)}</td>`;
  const cc=ctl.hit==null
    ?`<td class="sec">${ctl.n||0}</td><td class="dim2" colspan="2">under floor</td>`
    :`<td class="sec">${ctl.n}</td><td class="sec">${rtRate(ctl.hit)}</td><td class="sec">${rtPct(ctl.mean)}</td>`;
  const ex=`<td class="${rtCls(c.exHit)}">${rtPP(c.exHit)}</td><td class="${rtCls(c.exMean)}">${rtPct(c.exMean)}</td><td class="${rtCls(c.exSd)}">${rtSd(c.exSd)}</td>`;
  return `<tr><td>+${h}${unit||'d'}</td>${ev}${cc}${ex}</tr>`;
}
function rtControls(p){
  const seg=(id,lbl,attr,opts,cur)=>`<div class="seg" id="${id}" role="group" aria-label="${lbl}"><span class="seglbl">${lbl}</span>${opts.map(([v,l,tip])=>`<button type="button" data-${attr}="${esc(String(v))}"${String(cur)===String(v)?' class="active"':''}${tip?` data-tip="${esc(tip)}"`:''}>${l}</button>`).join('')}</div>`;
  const cds=(p&&p.cooldowns)||[0,3,5,10,20];
  return `<div class="controls" id="rtCtl" style="margin:8px 0">`
    +seg('rtSide','side','rts',[['long','long','stacked uptrend, the low probed the zone, the close held above EMA21'],['short','short','stacked downtrend, the high probed the zone, the close held below EMA21']],RT.side)
    +seg('rtDef','event','rtd',[['board','board','ladder-verbatim: the extreme of the last 3 closed bars reached EMA13 while the close held EMA21 — one probe keeps the badge lit up to three closes, so it fires in runs'],['touch','first touch','THIS bar probed the zone and the bar before did not — one event per pullback by construction']],RT.def)
    +seg('rtCd','cooldown','rtc',cds.map(v=>[v,v===0?'none':v+'d','after a kept event the same name and side cannot fire again for '+v+' closed bar'+(v===1?'':'s')+' — suppressed events are counted, never silently dropped']),RT.cd)
    +`<button class="btn" id="rtCsv" title="Download the shipped events as CSV">↓ CSV</button></div>`;
}
function renderRetestSection(){
  const head=sHead('D1 retest study','the Trend board’s D1 RETEST replayed over every closed day — does the pullback beat the trend it rides · study tier, nothing trades');
  const m=rtMemo.get(rtKey()), d=m&&m.data;
  if(!d) return head+rtControls(null)+`<div class="s-card"><div class="msg" style="height:90px;display:flex;align-items:center;justify-content:center">${m&&m.pending?'Loading the D1 retest study…':'Study not served yet — redeploy the backend, the panel fills in on the next load.'}</div></div>`;
  const p=d.params||{};
  if(d.pending) return head+rtControls(p)+`<div class="s-card"><div class="msg" style="height:90px;display:flex;align-items:center;justify-content:center">Computing — needs ≥${d.need} names with ≥60 closed daily bars (have ${d.count}).</div></div>`;
  const sd=(d.side||{})[RT.side]||{ n:0, suppressed:0, tl:0, cells:{} };
  const H=p.horizons||[1,3,5,10,20], floor=p.cellFloor||30;
  const tlShare=sd.n?Math.round(100*sd.tl/sd.n):0;
  const status=`<div class="s-cap" style="margin:4px 0 8px"><b>${sd.n}</b> ${RT.side} event${sd.n===1?'':'s'} across <b>${d.names}</b> of ${d.count} names · ${Number(d.bars||0).toLocaleString()} closed bars walked`
    +` · <span data-tip="candidates the cooldown folded into an earlier event of the same name and side">${sd.suppressed} suppressed by the ${RT.cd}d cooldown</span>`
    +` · <span data-tip="share of events whose probe window carried TRUE daily lows/highs (the hourly spine overlays the daily history ~180d equities / ~90d crypto); older bars read the close as the low, which can only under-count probes and voids">${tlShare}% on true extremes</span>`
    +(d.dataTs?` · through the ${isoUtc(d.dataTs,0,10)} UTC close`:'')+`</div>`;
  const un=rtUnit(p);
  const rows=H.map(h=>rtRow(h,sd.cells&&sd.cells[h],floor,un)).join('');
  const table=`<div class="s-card" style="overflow-x:auto"><table class="ptbl rt-tbl" style="min-width:760px"><thead>`
    +`<tr><th></th><th colspan="6">retest events</th><th colspan="3">control — stacked, no retest</th><th colspan="3">excess</th></tr><tr>`
    +`<th data-tip="forward horizon, in closed ${un===' sess'?'SESSION bars (weekends and exchange holidays folded into the next session)':'daily bars (calendar days — crypto trades 24/7)'} from the event close">fwd</th>`
    +`<th>n</th><th data-tip="share of events whose forward close went the side's way">hit</th><th data-tip="mean forward return, signed with the side (a short that falls reads positive), ±1.96 × its standard error two-way clustered by name and event date">mean</th><th>median</th>`
    +`<th data-tip="mean forward return in units of the name's trailing 60-bar daily σ at the event — comparable across names, walk-forward">σ</th><th data-tip="share of events that touched the event bar's EMA21 inside the horizon — the tretest void">void</th>`
    +`<th>n</th><th>hit</th><th>mean</th>`
    +`<th data-tip="hit − control hit, percentage points">hit</th><th data-tip="mean − control mean">mean</th><th data-tip="σ-mean − control σ-mean: the retest's edge over the trend it rides. The column that means anything.">σ</th>`
    +`</tr></thead><tbody>${rows}</tbody></table></div>`;
  // most active names + the latest events (the shipped list is newest first)
  const ev=(d.events||[]).filter(e=>e.side===RT.side), fi=H.indexOf(5)>=0?H.indexOf(5):Math.min(2,H.length-1);
  const names=(d.byName||[]).filter(x=>x[RT.side]>0).sort((a,b)=>b[RT.side]-a[RT.side]||b.lastT-a.lastT).slice(0,12);
  const chips=names.length?`<div class="s-cap" style="margin:10px 0 4px">Most ${RT.side} retests: `+names.map(x=>`<a href="#" class="rt-nm" data-coin="${esc(x.coin)}">${esc(x.ticker)}</a> <span class="sec">${x[RT.side]}</span>`).join(' · ')+`</div>`:'';
  const evRows=ev.slice(0,RT_EVENTS_SHOWN).map(e=>{ const f=e.f&&e.f[fi], v=e.v&&e.v[fi];
    return `<tr data-coin="${esc(e.coin)}" style="cursor:pointer"><td>${esc(e.ticker)}</td><td>${isoUtc(e.t,0,10)}</td><td>${e.c}</td><td class="sec">${e.e13}</td><td class="sec">${e.e21}</td>`
      +`<td class="${rtCls(f)}">${f==null?'<span class="sec">open</span>':rtPct(f)}</td><td class="sec">${v==null?'·':v?'touched':'held'}</td><td class="sec">${e.tl?'true':'close'}</td></tr>`; }).join('');
  const evTbl=ev.length?`<div class="s-card" style="overflow-x:auto"><table class="ptbl rt-ev"><thead><tr><th>name</th><th data-tip="the event bar's UTC day">close</th><th>close px</th><th>EMA13</th><th>EMA21</th><th data-tip="forward return at +${H[fi]}${un}, signed with the side · open = the horizon has not closed yet">+${H[fi]}${un}</th><th data-tip="the event bar's EMA21 at +${H[fi]}${un}: touched = the void was hit">void</th><th data-tip="true = the probe read true daily extremes; close = the close stood in for the low">low</th></tr></thead><tbody>${evRows}</tbody></table></div>`
    :`<div class="s-cap">No ${RT.side} events under this definition and cooldown.</div>`;
  const cap=sCap(`<b>Reading it:</b> an event is the Trend board’s RETEST on the D1 rung alone, judged on <b>closed</b> daily bars with EMAs walked bar by bar (the ladder’s own construction) — ${RT.def==='touch'?'the <b>first touch</b>: this bar probed the zone and the one before did not':'<b>board</b>-verbatim: the last 3 bars’ extreme reached EMA13 while the close held EMA21'}, then a ${RT.cd}-bar cooldown per name and side. The control is every stacked ${RT.side==='long'?'up':'down'}trend bar on the same names whose probe did not hold, so the <b>excess σ</b> column is the retest’s edge over simply being in the trend — not over zero. Outcomes are signed with the side; cells under ${floor} events publish n only. Horizons count ${un===' sess'?'<b>sessions</b> (weekends and exchange holidays fold into the next session bar)':'calendar days'}. Events on the same day across names share one tape, so <b>n</b> is shown with its distinct event dates (<b>dt</b>, the effective sample) and the mean carries ±1.96 × its <b>two-way clustered</b> (name × date) standard error — a pooled n of 300 on 40 dates is closer to 40 observations than to 300. The other three rungs of the board are not replayed (the hourly spine is a fraction of the daily depth), so this is the D1 badge, not the 3/4 score. The live claim remains tretest / tretestdn in the ledger; a definition that shows excess here earns nothing until it earns it there. Click a name or row for the drawer.${d.eventsTotal>(d.events||[]).length?` The CSV carries the newest ${(d.events||[]).length} of ${d.eventsTotal} events; the table above read all of them.`:''}`);
  return head+rtControls(p)+status+table+chips+evTbl+cap;
}
function attachRetestControls(){
  const host=el('backtest-body'); if(!host) return;
  const wire=(attr,key,num)=>host.querySelectorAll(`[data-${attr}]`).forEach(b=>b.addEventListener('click',()=>{ RT[key]=num?+b.dataset[attr]:b.dataset[attr]; rtSave(); drawBacktest(); }));
  wire('rts','side',false); wire('rtd','def',false); wire('rtc','cd',true);
  host.querySelectorAll('.rt-nm').forEach(a=>a.addEventListener('click',e=>{ e.preventDefault(); openDetail(a.dataset.coin); }));
  host.querySelectorAll('.rt-ev tbody tr').forEach(tr=>tr.addEventListener('click',()=>openDetail(tr.dataset.coin)));
  const csv=el('rtCsv'); if(csv) csv.onclick=()=>{
    const m=rtMemo.get(rtKey()), d=m&&m.data; if(!d||!d.events) return;
    const H=(d.params&&d.params.horizons)||[1,3,5,10,20];
    const out=[['ticker','side','date','close','ema13','ema21','true_low','sigma_pct',...H.map(h=>'fwd_'+h+'d_pct'),...H.map(h=>'void_'+h+'d')]];
    for(const e of d.events) out.push([e.ticker,e.side,isoUtc(e.t,0,10),e.c,e.e13,e.e21,e.tl?1:0,e.sd==null?'':e.sd,...H.map((_,k)=>e.f[k]==null?'':e.f[k]),...H.map((_,k)=>e.v[k]==null?'':(e.v[k]?1:0))]);
    downloadCSV(`d1-retest-${state.scope}-${RT.def}-cd${RT.cd}.csv`, out); };
}

export { RT, attachRetestControls, loadRetestStudy, renderRetestSection, rtRow };
