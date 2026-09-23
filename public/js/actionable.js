// actionable.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { showView } from "./backtest.js";
import { macroDayLbl, macroNextC, macroTimeLbl, scopeGuard } from "./calendar.js";
import { el, esc, fmtPrice, isoUtc, state, store } from "./core.js";
import { fetchJSON } from "./data.js";
import { openDetail } from "./drawer.js";
import { aiPick } from "./report.js";


// ===== actionable tab =====
// One cross-universe list of names currently AT a swing trigger. One-code-path contract, same as
// the trend chart modal: EVERY level on this board (entry, void, target) arrives on the payload,
// frozen by the ledger at fire time — the client never re-derives a level, and never recomputes
// reward:risk. Carry-netting, expectancy and rank are the server's; this file renders them.
// Cross-universe since the crypto engine's return (2026.07.26-08): rows arrive universe-tagged
// and the scope toggle picks one list at a time — crypto and stocks never share a sort order.
// is xyz-only and says so rather than showing an empty crypto scope.
let _act=null,_actLast=0,_actInflight=false,_actWired=false,_actSide='all';
async function loadActionable(){
  if(_actInflight) return; _actInflight=true;
  try{ const d=await fetchJSON('/api/actionable'); _act=d; _actLast=Date.now(); }
  catch(_){ }
  finally{ _actInflight=false; }
  if(state.view==='actionable') renderActionable();
}
function openActionable(){
  if(!_actWired){ _actWired=true;
    const seg=el('actside');
    if(seg) seg.addEventListener('click',(e)=>{ const b=e.target.closest('button[data-aside]'); if(!b) return;
      _actSide=b.dataset.aside;
      seg.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));
      renderActionable(); });
    const ce=el('act-noearn'); if(ce) ce.addEventListener('change',renderActionable);
    for(const id of ['act-cls-rr','act-cls-ev']){ const c=el(id); if(c) c.addEventListener('change',renderActionable); }
    const rs=el('act-sortreset'); if(rs) rs.addEventListener('click',()=>{ _actSort={k:'ago',d:1}; actSortSave(); renderActionable(); });
    actSortLoad();
  }
  renderActionable();
  if(Date.now()-_actLast>60*1000) loadActionable();
}
// ---- board renderer ----------------------------------------------------------------------
// Every number here arrives on the payload. The client sorts and formats; it never re-derives a
// level, a reward:risk, an expectancy or a lateness. Sorting is the ONE thing it owns.
const ASKEY='xyzmon.act.sort.v1';
let _actSort={k:'ago',d:1}, _actOpen={};
function actSortLoad(){ try{ const d=JSON.parse(store.get(ASKEY)||'null');
  if(d&&typeof d.k==='string'&&(d.d===1||d.d===-1)) _actSort=d; }catch(_){ } }
function actSortSave(){ try{ store.set(ASKEY,JSON.stringify(_actSort)); }catch(_){} }
// ===== settled board record =====
// The board's own out-of-sample record, rendered below the live list. EVERY number here arrives
// on the payload (d.settled), stamped server-side at first appearance and at resolution — the
// client formats and sums shipped counts, it never re-scores an episode. Split by the SAME class
// tag the live board's checkboxes filter on: "2+1" = the >=2:1-at-fire family, grinders = the
// sub-2:1 positive-EV family; each bucket includes every outcome its episodes reached (target,
// void, expired) — a grinder that tagged its modest target belongs to the grinders row.
let _actEpOpen={}, _actSetOpen=(store.get('actSettled')==='1');
// Settled record only grows (out-of-sample rows are never pruned), so the episode list is paged.
// Size is sticky across visits and shared by both universes; the batch index is kept PER universe
// so switching scope holds each side's place instead of snapping the other back to the top.
let _actEpPage={};
let _actEpSize=(()=>{ const v=+store.get('actEpSize'); return (v===10||v===20||v===50)?v:20; })();
function actEpSizeSet(n){ if(n!==10&&n!==20&&n!==50) return; _actEpSize=n; try{ store.set('actEpSize',String(n)); }catch(_){} }
function actSetPct(x){ return x==null?'\u2014':Math.round(x*100)+'%'; }
function actSetR(x){ return x==null?'\u2014':`<span class="${x>0?'pos':x<0?'neg':'sec'}">${x>0?'+':''}${x.toFixed(2)}R</span>`; }
// Lateness is a COST: positive means the board's surfacing lost you R, so positive reads red.
// The generic R formatter painted +0.73R of lateness green — the exact opposite of its meaning.
function actSetCost(x){ return x==null?'\u2014':`<span class="${x>0.005?'neg':x<-0.005?'pos':'sec'}">${x>0?'+':''}${x.toFixed(2)}R</span>`; }
function actSetDays(ms){ return ms==null?'\u2014':(ms/86400000).toFixed(1)+'d'; }
function actSettled(d,wantU){
  const st=d&&d.settled, u=st&&st.perUni&&st.perUni[wantU];
  let h=`<div class="act-set"><div class="act-set-h dsec" data-settgl style="cursor:pointer" data-tip="the board's own out-of-sample record: every suggestion it ever surfaced, stamped at first appearance and scored when the underlying claim resolved \u2014 on or off the board. Once shown, always scored. Click to ${_actSetOpen?'collapse':'expand'}">${_actSetOpen?'\u25be':'\u25b8'} Settled \u2014 every suggestion this board ever showed, scored${st&&st.since?` <span class="sec" style="text-transform:none;letter-spacing:0">\u00b7 out of sample since ${new Date(st.since).toISOString().slice(0,10)}</span>`:''}</div>`;
  if(!u||(!u.all.n&&!u.open)){
    h+=_actSetOpen?`<div class="sec" style="font-size:var(--fs-xs);padding:4px 2px">No episodes in this scope yet \u2014 the record opens with the first suggestion the board surfaces and scores when its claim resolves. Starting from zero is the point: nothing here is backfilled.</div>`:'';
    return h+`</div>`;
  }
  const a=u.all;
  h+=`<div class="act-set-strip">`
    +`<span data-tip="every distinct suggestion that ever appeared in this scope \u2014 one episode per underlying claim, flicker reappearances folded into the original">shown <b>${a.n+u.open}</b></span>`
    +`<span data-tip="episodes whose claim is still inside its horizon \u2014 they score when it resolves, whether or not the row is still on the board">open <b>${u.open}</b></span>`
    +`<span data-tip="episodes whose claim resolved \u2014 scored from the geometry frozen at first appearance">resolved <b>${a.n}</b></span>`
    +(u.lat!=null?`<span data-tip="avg R at the fire mark minus avg R from the first-shown mark, over the ${u.latN||0} episode(s) with a trustworthy first-shown stamp \u2014 the measured cost of the board surfacing late (confirmation, record and EV gates all delay a row). Positive is a COST and reads red.${u.btN?` ${u.btN} boot-stamped episode(s) (\u27f2) are excluded \u2014 their stamp is a lower bound on visibility, not a surfacing.`:''}">lateness ${actSetCost(u.lat)}</span>`:(u.btN&&u.all.n?`<span class="sec" data-tip="every resolved episode here is boot-stamped (\u27f2): the first-shown stamps are the feature's own birth, not surfacings, so a lateness number would be manufactured. It starts measuring with the first episode shown by a running process.">lateness \u2014 (${u.btN} boot-stamped)</span>`:''))
    +((u.split&&u.split.n)?`<span data-tip="fire\u2192shown split over ${u.split.n} resolved episode(s) with full stamps${u.split.excl?` (${u.split.excl} pre-stamp/boot excluded \u2014 dashes over invented numbers)`:''}. cadence = claim fired \u2192 first board build that evaluated it (pure latency \u2014 the event-driven rebuild attacks this); gate = that build \u2192 first shown (EV/tradeable gates holding the row back \u2014 a selection effect no speed fix touches). Medians.">fire\u2192shown ${actAgo(u.split.cadMed)} cadence \u00b7 ${actAgo(u.split.gateMed)} gated</span>`
      :((u.split&&u.split.excl&&u.all.n)?`<span class="sec" data-tip="every resolved episode predates the decomposition stamps or is boot-stamped \u2014 the split starts measuring with episodes evaluated by a running post-stamp process">fire\u2192shown \u2014 (${u.split.excl} unstamped)</span>`:''))
    +(u.clus?`<span class="neg" data-tip="resolved episodes of the same family and side first shown on the SAME build \u2014 one correlated market condition observed several times, not independent samples. Read n accordingly: a cluster of four is closer to one observation than to four.">${u.clus} correlated cluster${u.clus===1?'':'s'}</span>`:'')
    +(u.flick?`<span data-tip="rows that dropped off (the mark wobbled through a gate) and reappeared \u2014 folded into their original episode so oscillation never manufactures sample size">${u.flick} flicker${u.flick===1?'':'s'} folded</span>`:'')
    +(st.dropped?`<span data-tip="episodes shown but unscoreable \u2014 the claim was voided or purged, or no exit price survived. Counted, never silently gone.">${st.dropped} unscoreable</span>`:'')
    +(a.approx?`<span data-tip="episodes scored with a gap in the hourly spine (a restart trimmed it): level touches were unknowable, so they scored at their endpoints \u2014 labeled, not hidden">${a.approx} approx</span>`:'')
    +`</div>`;
  if(!_actSetOpen) return h+`</div>`;
  const row=(lbl,tip,b,mut)=>`<tr${mut?' class="act-set-mut"':''}><td><span data-tip="${esc(tip)}">${lbl}</span></td>`
    +`<td style="text-align:right">${b.n}</td>`
    +`<td style="text-align:right" class="sec">${b.n?`${b.t}t / ${b.v}v / ${b.x}x`:'\u2014'}</td>`
    +`<td style="text-align:right">${b.x?`<span class="pos">${b.xp||0}+</span><span class="sec"> / </span><span class="neg">${b.xn||0}\u2212</span>`:'\u2014'}</td>`
    +`<td style="text-align:right">${b.hit!=null?`<span class="${b.hit>=0.5?'pos':'neg'}">${actSetPct(b.hit)}</span>`:'\u2014'}</td>`
    +`<td style="text-align:right">${actSetR(b.avgM)}</td>`
    +`<td style="text-align:right" class="sec">${actSetR(b.avgE)}</td>`
    +`<td style="text-align:right">${b.pf!=null?b.pf.toFixed(2):'\u2014'}</td></tr>`;
  h+=`<table class="act-set-t"><thead><tr><th></th>`
    +`<th data-tip="resolved episodes in this bucket. Correlated same-build clusters are tagged on their rows below \u2014 a cluster counts here as its full size but is closer to ONE observation." style="text-align:right">n</th>`
    +`<th data-tip="how those resolutions split: t = target touched, v = void touched, x = expired between the levels \u2014 partial outcomes, never hits" style="text-align:right">t/v/x</th>`
    +`<th data-tip="expiries split by the sign of R@shown \u2014 the basis a reader could actually have had. Disclosed separately precisely so a favorable drift can never pad the hit rate." style="text-align:right">exp \u00b1</th>`
    +`<th data-tip="targets over level-touched resolutions ONLY (t \u00f7 (t+v)). Expiries are excluded \u2014 a dash means nothing has touched a level yet, and no rate is claimed." style="text-align:right">hit</th>`
    +`<th data-tip="avg realized R from the live mark at FIRST appearance \u2014 what acting on the board actually got. The economically meaningful number: the first price anyone watching could have had." style="text-align:right">avg @shown</th>`
    +`<th data-tip="avg realized R at the fire mark \u2014 a diagnostic counterfactual: the basis the family record was scored on, at a price nobody watching the board could trade. The gap to @shown is the lateness cost." style="text-align:right">avg @fire</th>`
    +`<th data-tip="gross win R \u00f7 gross loss R at the SHOWN mark \u2014 priced on the basis a reader could actually trade" style="text-align:right">pf</th></tr></thead><tbody>`
    +row('2+1 \u2014 \u22652:1 at fire','the level-triggered family: frozen R:R cleared 2:1 at fire. All of its outcomes \u2014 targets, voids, expiries \u2014 are in this row.',u.cls.rr)
    +row('grinders \u2014 sub-2:1, +EV','the statistical family: below 2:1 at fire, positive expectancy anyway. All of its outcomes are here too \u2014 a grinder that tagged its modest target counts exactly like a 2+1 that tagged its big one.',u.cls.ev)
    +row('all resolved','both families combined \u2014 the whole record',a,true)
    +`</tbody></table>`;
  const eps=(st.episodes||[]).filter(e=>e.uni===wantU).slice().reverse();
  if(eps.length){
    // Page the record. Only the current batch is ever in the DOM, so the settled list stays bounded
    // no matter how large the out-of-sample record grows. Batch index is per universe and clamped
    // here (a size change can drop the last page out from under the stored index).
    const epsTotal=eps.length, epsSize=_actEpSize, epsPages=Math.max(1,Math.ceil(epsTotal/epsSize));
    let epsPg=_actEpPage[wantU]||0; if(epsPg>epsPages-1) epsPg=epsPages-1; if(epsPg<0) epsPg=0; _actEpPage[wantU]=epsPg;
    const epsStart=epsPg*epsSize, epsEnd=Math.min(epsStart+epsSize,epsTotal), epsPageRows=eps.slice(epsStart,epsStart+epsSize);
    if(epsTotal>10){
      const szBtn=n=>`<button type="button" class="act-ep-sz${n===epsSize?' on':''}" data-epsz="${n}">${n}</button>`;
      h+=`<div class="act-ep-pager" data-tip="the settled record only grows \u2014 this pages it. Batch size is remembered; the batch you're on is kept per universe, so crypto and stocks hold their own place.">`
        +`<span class="act-ep-show">show ${szBtn(10)}${szBtn(20)}${szBtn(50)}</span>`
        +`<span class="act-ep-nav"><span class="sec">${epsStart+1}\u2013${epsEnd} of ${epsTotal} \u00b7 batch ${epsPg+1}/${epsPages}</span>`
        +`<button type="button" class="act-ep-pg" data-eppg="-1"${epsPg<=0?' disabled':''}>\u2190 prev</button>`
        +`<button type="button" class="act-ep-pg" data-eppg="1"${epsPg>=epsPages-1?' disabled':''}>next \u2192</button></span></div>`;
    }
    h+=`<table class="trend-t act-set-eps"><thead><tr><th>name</th><th>event</th><th>class</th><th>side</th>`
      +`<th data-tip="when the row first appeared on the board \u00b7 \u27f2 marks a boot-stamped episode: the stamp is the record's own first scan, a LOWER BOUND on when the row was visible \u2014 excluded from the headline lateness" style="text-align:right">shown</th>`
      +`<th data-tip="how the claim resolved \u2014 target / void touched first, or expired between them (a candle spanning both scores pessimistically as the void) \u2014 with the price it was scored at: the frozen level for touches, the mark at horizon for expiries">outcome</th>`
      +`<th data-tip="realized R from the mark at first appearance \u2014 what acting on this row when it appeared actually got" style="text-align:right">R@shown</th>`
      +`<th data-tip="realized R at the fire mark \u2014 diagnostic counterfactual: nobody watching the board could have had this price" style="text-align:right">R@fire</th>`
      +`<th data-tip="first appearance to resolution (or to the level touch that decided it) \u2014 NOT the claim's full life: a claim surfaced near its horizon shows a short hold by construction" style="text-align:right">held</th><th></th></tr></thead><tbody>`;
    for(const e of epsPageRows){ const op=!!_actEpOpen[e.k];
      const oc=e.kind==='target'?'pos':e.kind==='void'?'neg':'sec';
      const opx=e.kind==='target'?e.target:e.kind==='void'?e.void:e.exitPx;
      h+=`<tr class="act-set-ep" data-epk="${esc(e.k)}"><td class="${e.side==='long'?'pos':'neg'}"><span class="tk">${esc(e.t)}</span></td>`
        +`<td class="sec">${esc(e.label||e.ev)}${e.cor?` <span class="act-tf neg" data-tip="one of ${e.cor} resolved episodes of this family and side first shown on the SAME build \u2014 one correlated market condition, not ${e.cor} independent observations">corr \u00d7${e.cor}</span>`:''}</td>`
        +`<td class="sec">${e.cls==='ev'?'grinder':'2+1'}</td>`
        +`<td class="${e.side==='long'?'pos':'neg'}">${e.side}</td>`
        +`<td class="sec" style="text-align:right">${actAgo(Date.now()-e.tShow)}${e.bt?` <span data-tip="boot-stamped: opened on the record's first scan for a claim fired ${e.tFire?actAgo(e.tShow-e.tFire)+' earlier':'well before'} \u2014 the row may have been visible before the stamp; excluded from the headline lateness">\u27f2</span>`:''}</td>`
        +`<td class="${oc}">${e.kind}${e.approx?' \u2248':''}${opx!=null?` <span class="sec">@ ${fmtPrice(opx)}</span>`:''}</td>`
        +`<td style="text-align:right">${actSetR(e.rM)}</td>`
        +`<td style="text-align:right" class="sec">${actSetR(e.rE)}</td>`
        +`<td class="sec" style="text-align:right">${actSetDays(e.held)}</td>`
        +`<td>${op?'\u25be':'\u25b8'}</td></tr>`;
      if(op) h+=`<tr class="act-detrow"><td colspan="10">${actEpDetail(e)}</td></tr>`;
    }
    h+=`</tbody></table>`;
  }
  h+=`<div class="sec" style="font-size:var(--fs-xs);margin-top:6px">All stamps and scores are frozen server-side at first appearance and at resolution \u2014 this section renders them and never re-derives. The record started at zero when this feature shipped; nothing before it is claimed.</div></div>`;
  return h;
}
function actEpDetail(e){
  const risk=Math.abs(e.fired-e.void), riskPct=e.fired?(risk/e.fired*100):null;
  const opx=e.kind==='target'?e.target:e.kind==='void'?e.void:e.exitPx;
  return `<div class="act-set-det">`
    +`<span>first shown <b>${isoUtc(e.tShow,0,16)}</b> at mark <b>${fmtPrice(e.markShow)}</b>${e.tFire?` \u00b7 claim fired <b>${actAgo(e.tShow-e.tFire)}</b> earlier`:''}</span>`
    +(e.bt?`<span class="sec">\u27f2 boot-stamped \u2014 the first-shown stamp is the record's own first scan; the row may have been visible earlier, so this episode's lateness is a lower bound and it is excluded from the headline lateness number</span>`:'')
    +((e.tBld!=null&&e.tFire!=null&&e.tShow!=null&&!e.bt&&!e.be)?`<span>fire\u2192shown: <b>${actAgo(e.tBld-e.tFire)}</b> to first evaluating build \u00b7 <b>${actAgo(e.tShow-e.tBld)}</b> held at the gates</span>`
      :(e.be?`<span class="sec">\u27f2 build-stamped \u2014 the first-evaluated stamp was minted on a fresh process's first build (a lower bound, not a measurement); excluded from the fire\u2192shown split</span>`:''))
    +(e.cor?`<span class="sec">corr \u00d7${e.cor} \u2014 one of ${e.cor} same-family, same-side episodes first shown on the same build: one correlated market condition, not ${e.cor} independent observations</span>`:'')
    +`<span>frozen: fired <b>${fmtPrice(e.fired)}</b> \u00b7 void <b>${fmtPrice(e.void)}</b> \u00b7 target <b>${fmtPrice(e.target)}</b>${riskPct!=null?` \u00b7 risk <b>${riskPct.toFixed(2)}%</b>`:''}</span>`
    +`<span>displayed at show: r:r <b>${e.rr!=null?e.rr.toFixed(2):'\u2014'}</b> \u00b7 ev <b>${e.evR!=null?(e.evR>0?'+':'')+e.evR.toFixed(2)+'R':'\u2014'}</b>${e.rec&&e.rec.n?` \u00b7 rec <b>${Math.round(e.rec.hit*100)}%\u00b7${e.rec.n}</b>`:''}</span>`
    +`<span>resolved <b>${e.tRes?new Date(e.tRes).toISOString().slice(0,16).replace('T',' '):'\u2014'}</b> \u2014 <b>${e.kind}</b>${opx!=null?` at <b>${fmtPrice(opx)}</b>`:e.kind==='expired'?' <span class="sec">(exit price not recorded \u2014 pre-fix episode)</span>':''}${e.approx?' <span class="sec" data-tip="hourly-spine gap over this window: level touches were unknowable, scored at the endpoints">(approx \u2014 spine gap)</span>':''}${e.flick?` \u00b7 ${e.flick} flicker${e.flick===1?'':'s'} folded`:''}</span>`
    +`</div>`;
}
function actSettledWire(box){
  const tg=box.querySelector('[data-settgl]');
  if(tg) tg.addEventListener('click',()=>{ _actSetOpen=!_actSetOpen; try{ store.set('actSettled',_actSetOpen?'1':'0'); }catch(_){} renderActionable(); });
  box.querySelectorAll('tr.act-set-ep').forEach(tr=>tr.addEventListener('click',()=>{
    const k=tr.dataset.epk; _actEpOpen[k]=!_actEpOpen[k]; renderActionable(); }));
  // Size change holds your place by row anchor: the first row of the current batch stays on screen
  // rather than snapping to the top when the page grows or shrinks.
  box.querySelectorAll('.act-ep-sz').forEach(b=>b.addEventListener('click',ev=>{
    ev.stopPropagation();
    const n=+b.dataset.epsz, u=state.scope==='crypto'?'crypto':'stocks';
    const anchor=(_actEpPage[u]||0)*_actEpSize;
    actEpSizeSet(n); _actEpPage[u]=Math.floor(anchor/n);
    renderActionable(); }));
  box.querySelectorAll('.act-ep-pg').forEach(b=>b.addEventListener('click',ev=>{
    ev.stopPropagation();
    if(b.disabled) return;
    const u=state.scope==='crypto'?'crypto':'stocks';
    _actEpPage[u]=(_actEpPage[u]||0)+(+b.dataset.eppg);
    renderActionable(); }));
}
function actRR(x){ return x!=null&&isFinite(x)?(+x).toFixed(2):'\u2014'; }
function actEV(x){ return x!=null&&isFinite(x)?((x>=0?'+':'')+(+x).toFixed(2)):'\u2014'; }
function actLate(x){ return x!=null&&isFinite(x)?((x>=0?'+':'')+(+x).toFixed(2)):'\u2014'; }
// Colour reads the trade, not the sign: coming back to you is good, running away is not.
function actLateCls(x){ if(x==null||!isFinite(x)) return 'sec'; if(x<=0) return 'pos'; return x>0.5?'act-late-bad':'sec'; }
// Elapsed since the claim fired, in the units a person thinks in.
function actAgo(ms){ if(ms==null||!isFinite(ms)||ms<0) return '\u2014';
  const m=Math.floor(ms/60000); if(m<60) return m+'m';
  if(m<1440){ const h=Math.floor(m/60), r=m%60; return h+'h'+(r?' '+r+'m':''); }
  const d=Math.floor(m/1440), h=Math.floor((m%1440)/60); return d+'d'+(h?' '+h+'h':''); }
const ACT_COLS=[
  {k:'t',    lb:'Ticker', al:'left'},
  {k:'ev',   lb:'Setup',  al:'left'},
  {k:'ago',  lb:'Ago',    al:'right', tip:'Time since the claim fired. The default sort, newest first.'},
  {k:'fired',lb:'Fired',  al:'right', tip:'The mark frozen when the claim opened \u2014 the entry its record was scored on.'},
  {k:'entry',lb:'Now',    al:'right', tip:'The live mark. Reward:risk is priced from here, so a setup the market walks away from decays off the board on its own.'},
  {k:'late', lb:'Late',   al:'right', tip:'Distance from the fire in the setup\u2019s OWN risk unit. +0.60R means over half your stop distance is spent before you are in. Negative means the market came back and you enter better than the record did.'},
  {k:'void', lb:'Void',   al:'right', tip:'The claim\u2019s frozen invalidation level. Never recomputed here.'},
  {k:'target',lb:'Target',al:'right', tip:'The claim\u2019s frozen target.'},
  {k:'rr',   lb:'R:R',    al:'right', tip:'Reward:risk NET of expected funding across the horizon.'},
  {k:'evR',  lb:'EV',     al:'right', tip:'Expectancy in R for entering THIS instance here: hit\u00d7(net R:R) \u2212 (1\u2212hit)\u00d71.'},
  {k:'rec',  lb:'Rec',    al:'right', tip:'Out-of-sample record for this setup: hit rate and resolved fires.'}];
function actCell(r,k){
  if(k==='rr') return r.rr?r.rr.gross:null;
  if(k==='rec') return r.rec?r.rec.n:null;
  if(k==='ago') return r.t0?(Date.now()-r.t0):null;
  return r[k];
}
function actCmp(a,b){
  const k=_actSort.k, d=_actSort.d;
  if(k==='t'||k==='ev'){ const x=String(a[k]||''), y=String(b[k]||'');
    return (x<y?-1:x>y?1:0)*d; }
  let x=actCell(a,k), y=actCell(b,k);
  // Nulls always sort last, in BOTH directions. Reversing a column must never float a row with
  // no value to the top as though it had the best one.
  const xn=(x==null||!isFinite(x)), yn=(y==null||!isFinite(y));
  if(xn&&yn) return 0; if(xn) return 1; if(yn) return -1;
  return (y-x)*d;
}
function actHead(){
  let h='<thead><tr>';
  for(const c of ACT_COLS){ const on=_actSort.k===c.k, ar=on?(_actSort.d===1?' \u25be':' \u25b4'):'';
    h+=`<th data-sk="${c.k}" title="${esc((c.tip?c.tip+' \u00b7 ':'')+'click to sort')}" class="act-th${on?' on':''}" style="text-align:${c.al}">${esc(c.lb)}${ar}</th>`; }
  return h+'</tr></thead>';
}
// Expanded trade card. Says what the trade is, what the record behind it is, and every condition
// that would take it off the board — all from the payload.
function actDetail(r){
  const rec=r.rec||{}, R=r.rr||{};
  const g=[];
  g.push(['the claim',`fired ${fmtPrice(r.fired)} \u00b7 void ${fmtPrice(r.void)} \u00b7 target ${fmtPrice(r.target)} \u2014 all three frozen at fire`]);
  g.push(['the record',rec.n?`${Math.round(rec.hit*100)}% hit \u00b7 n=${rec.n} resolved \u00b7 avg ${rec.avgR>=0?'+':''}${rec.avgR}R`:'no resolved fires']);
  g.push(['risk / reward',`${R.riskPct}% to void \u00b7 ${R.rewardPct}% to target \u2014 measured from the fire mark`]);
  g.push(['R:R',`<b>${actRR(R.gross)}</b> at fire \u00b7 price geometry only`]);
  g.push(['carry',r.carry&&r.carry.aprPct!=null?`${r.carry.aprPct>=0?'+':''}${r.carry.aprPct}% APR over ${r.horizonD}d = ${actEV(r.carry.r)}R ${r.carry.r>=0?'(paid to hold)':'(you pay)'} \u2014 not counted in R:R or EV`:'funding unavailable']);
  g.push(['expectancy',`<b class="act-ev">${actEV(r.evR)}R</b> = hit\u00d7R:R \u2212 (1\u2212hit)\u00d71`]);
  g.push(['taking it now',`${fmtPrice(r.entry)} \u2014 ${r.late==null?'lateness unavailable':(r.late<0?`${actLate(-r.late)}R of the claim's risk already spent against you`:`${actLate(r.late)}R of the move already made`)}`]);
  g.push(['fired',`${actAgo(Date.now()-r.t0)} ago \u00b7 ${r.bars==null?'\u2014':r.bars} ${r.tf} bar(s) in trigger`]);
  g.push(['lateness',r.late==null?'unavailable':`${actLate(r.late)}R ${r.late<0?'\u2014 price moved AGAINST the claim: better entry price, but that much less room to the void than the record\u2019s fires had':'of the claim\u2019s move already made before entry'}`]);
  let h=`<div class="act-det"><div class="ad-h"><b class="${r.side==='long'?'pos':'neg'}">${esc(r.t)} ${esc(String(r.side||'').toUpperCase())}</b> \u00b7 ${esc(r.label)} on the ${esc(r.tf)} rung \u00b7 ${r.horizonD}d horizon`
    +(r.prime===true?' <span class="ad-badge" title="This setup was prime at fire time by the signals engine\u2019s heuristic: hit \u2265 60%, positive average, clean structure, no earnings. Shown, not enforced \u2014 a lower-hit setup at high R:R is still worth taking.">prime at fire</span>':'')
    +(r.also&&r.also.length?` \u00b7 <span class="sec">corroborated by ${esc(r.also.map(a=>a.label).join(', '))}</span>`:'')+`</div><div class="ad-g">`;
  for(const [k,v] of g) h+=`<div class="ad-k">${k}</div><div class="ad-v">${v}</div>`;
  h+=`</div><div class="ad-sc">if it works, target pays <b class="pos">+${actRR(R.gross)}R</b> \u00b7 if it fails, the void costs <b class="neg">\u22121.00R</b></div>`
    +`<div class="ad-x">Leaves the board at ${r.bars==null?'\u2014':''}${_actMaxBars} bars in trigger or if price passes ${fmtPrice(r.void)}. R:R is frozen at fire — ${_actMinRR} is the line between the 2:1+ and grinder families, not an exit.</div>`;
  if(r.earn) h+=`<div class="ad-w">\u26a0 earnings in ${r.earn.days}d (${esc(r.earn.s)}) \u2014 inside the ${r.horizonD}d horizon. Flagged, not filtered: a scheduled binary is a prior the base rate cannot see.</div>`;
  if(r.mac&&r.mac.length) for(const m of r.mac) h+=`<div class="ad-w" style="color:var(--blue)">\u25c6 ${esc(m.label)} ${m.days===0?'today':m.days===1?'tomorrow':'in '+m.days+'d'} (${esc(m.d)}, ${esc(m.tEt)} ET) \u2014 a universe-wide scheduled binary inside the ${r.horizonD}d horizon. Flagged, not filtered \u2014 same contract as earnings.</div>`;
  h+=`<div class="ad-a"><button class="btn" data-rep="${esc(r.coin)}">AI report \u2192</button>`
    +`<button class="btn" data-dr="${esc(r.coin)}">Open ${esc(r.t)}</button></div></div>`;
  return h;
}
let _actMaxBars=10, _actMinRR='2.00';
function renderActionable(){
  if(state.view==='actionable' && scopeGuard('actionable')) return;   // flipped scope re-enters this renderer
  const box=el('act-body'); if(!box) return;
  const d=_act;
  if(!d){ box.innerHTML='<div class="msg">Loading\u2026</div>'; return; }
  const asof=el('act-asof');
  if(asof) asof.textContent=d.ts?('as of '+new Date(d.ts).toLocaleTimeString()):'';
  const p=d.params||{}, c=d.coverage||{};
  _actMaxBars=p.maxBars||10; _actMinRR=(p.minRR||2).toFixed(2);
  const noEarn=!!(el('act-noearn')&&el('act-noearn').checked);
  // The two families, reader's choice. Unchecking both is read as 'show nothing', honestly.
  const showRR=!el('act-cls-rr')||el('act-cls-rr').checked, showEV=!el('act-cls-ev')||el('act-cls-ev').checked;
  // Scope filter, same rule as the Signals tab: rows arrive universe-tagged ('crypto' / 'stocks')
  // and the board serves one universe at a time. Without this an equity setup sits in the crypto
  // board's sort order competing on R:R against perps — two universes in one ranked list, which is
  // the merged view the scope split exists to prevent.
  const wantU=state.scope==='crypto'?'crypto':'stocks';
  const rows=(d.rows||[]).filter(r=>r.uni===wantU&&(_actSide==='all'||r.side===_actSide)&&!(noEarn&&r.earn)&&((r.cls==='ev')?showEV:showRR)).slice().sort(actCmp);
  let h='';
  { const mn=macroNextC();
    if(mn&&mn.diff<=2) h+=`<div class="sec" style="font-size:var(--fs-xs);margin-bottom:8px;color:var(--blue)" data-tip="universe-wide scheduled binary \u2014 rows whose remaining horizon contains the event carry a \u25c6; flagged, never filtered. Applies to crypto exactly as to equities.">\u25c6 ${esc(mn.e.label)} ${mn.diff===0?'today':mn.diff===1?'tomorrow':macroDayLbl(mn.e.d)} (${macroDayLbl(mn.e.d)}, ${macroTimeLbl(mn.e)}) \u2014 inside every open horizon \u2265${Math.max(1,mn.diff)}d; flagged per row, never filtered</div>`; }
  if(!rows.length){
    h+=`<div class="msg">Nothing confirmed at a swing trigger right now.`
      +`${c.openClaims!=null?` ${c.openClaims} open claim(s) scanned across both universes`:''}`
      +`${c.norecord?` \u00b7 ${c.norecord} without a record yet`:''}`
      +`${c.negexp?` \u00b7 ${c.negexp} whose record is flat or negative`:''}`
      +`${c.negev?` \u00b7 ${c.negev} negative-EV from here`:''}`
      +`${c.expired?` \u00b7 ${c.expired} aged out`:''}`
      +`${c.noGeometry?` \u00b7 ${c.noGeometry} whose frozen geometry never framed a trade`:''}`
      +`${c.degenerate?` \u00b7 ${c.degenerate} whose void sat on top of the entry (ratio is an artifact)`:''}`
      +`${c.untakeable?` \u00b7 ${c.untakeable} no longer takeable from here`:''}.`
      +` This board suggests only confirmed setups \u2014 an empty board is a real answer.</div>`;
  } else {
    h+=`<table class="trend-t act-tbl">${actHead()}<tbody>`;
    for(const r of rows){
      // Side is a WORD, not a colour. It used to be carried only by the pos/neg tint on this cell,
      // which is unreadable for anyone who can't separate the hues and — worse — reads like a
      // day-change tint on a ticker, so a short looked like a name that was simply down. The chip
      // states the direction; the tint is now a second, redundant encoding of the same fact.
      const sd=r.side==='long'?'l':'s', op=!!_actOpen[r.coin+'|'+r.side];
      h+=`<tr class="act-row${op?' open':''}" data-key="${esc(r.coin+'|'+r.side)}" data-coin="${esc(r.coin)}">`
        +`<td>${op?'\u25be ':''}<span class="tk">${esc(r.t)}</span> <span class="act-side ${sd}" title="${r.side==='long'?'LONG \u2014 the claim pays if price rises; the void sits below the entry':'SHORT \u2014 the claim pays if price falls; the void sits above the entry'}">${r.side==='long'?'\u25b2':'\u25bc'} ${esc(r.side)}</span>${r.earn?' <i class="act-warn" title="earnings inside the horizon">\u26a0</i>':''}${r.mac&&r.mac.length?` <i class="act-mwarn" data-tip="${esc(r.mac.map(m=>m.label+' '+(m.days===0?'today':m.days===1?'tomorrow':'in '+m.days+'d')+' ('+m.tEt+' ET)').join(' \u00b7 '))} \u2014 universe-wide scheduled binar${r.mac.length===1?'y':'ies'} inside the horizon">\u25c6</i>`:''}</td>`
        +`<td class="sec">${esc(r.label)} <span class="act-tf">${esc(r.tf)}</span>${r.cls==='ev'?' <span class="act-tf" title="below 2:1 at fire, positive expectancy — the win-often family">grinder</span>':''}${r.also&&r.also.length?` <span class="act-also" title="${esc(r.also.map(a=>a.label).join(', '))}">+${r.also.length}</span>`:''}</td>`
        +`<td style="text-align:right">${actAgo(Date.now()-r.t0)}</td>`
        +`<td class="sec" style="text-align:right">${fmtPrice(r.fired)}</td>`
        +`<td style="text-align:right">${fmtPrice(r.entry)}</td>`
        +`<td style="text-align:right" class="${actLateCls(r.late)}">${actLate(r.late)}</td>`
        +`<td class="neg" style="text-align:right">${fmtPrice(r.void)}</td>`
        +`<td class="sec" style="text-align:right">${fmtPrice(r.target)}</td>`
        +`<td style="text-align:right">${actRR(r.rr.gross)}</td>`
        +`<td class="act-ev" style="text-align:right">${actEV(r.evR)}</td>`
        +`<td class="sec act-rec" style="text-align:right">${r.rec&&r.rec.n?Math.round(r.rec.hit*100)+'%\u00b7'+r.rec.n:'\u2014'}</td>`
        +`</tr>`;
      if(op) h+=`<tr class="act-detrow"><td colspan="${ACT_COLS.length}">${actDetail(r)}</td></tr>`;
    }
    h+=`</tbody></table>`;
  }
  h+=actSettled(d,wantU);
  h+=`<div class="act-foot"><b style="color:var(--text)">Confirmed only.</b> A row appears here only if the setup has at least ${p.recMinN||8} resolved out-of-sample fires, those fires paid on average, this entry still models positive expectancy after carry and lateness, and net R:R is at least ${_actMinRR}. Most events in the ledger do not clear that \u2014 which is the honest result of testing them, and why this board is often short or empty. Setups still earning a record are not shown here; the strategy panel tracks those. `
    +`<b style="color:var(--text)">Fired</b> is the mark frozen when the claim opened \u2014 the entry its record was scored on; <b style="color:var(--text)">Now</b> is live, and <b style="color:var(--text)">Late</b> is the gap in the setup's own risk unit. Void and target are the claim's geometry, frozen at fire time and never re-derived here. R:R is net of expected funding over the horizon. `
    +`Horizons of ${p.minHorizonDays||3}d or longer only (${(p.tfs||['D1','H12','H4']).join(' \u00b7 ')}). Both universes, scoped by the toggle above \u2014 crypto and stocks never share this list. Not investment advice.</div>`;
  box.innerHTML=h;
  actSettledWire(box);
  box.querySelectorAll('th[data-sk]').forEach(th=>th.addEventListener('click',()=>{
    const k=th.dataset.sk;
    if(_actSort.k===k) _actSort.d=-_actSort.d; else _actSort={k,d:1};
    actSortSave(); renderActionable(); }));
  box.querySelectorAll('tr.act-row').forEach(tr=>tr.addEventListener('click',()=>{
    const k=tr.dataset.key; _actOpen[k]=!_actOpen[k]; renderActionable(); }));
  box.querySelectorAll('[data-rep]').forEach(b=>b.addEventListener('click',(e)=>{ e.stopPropagation();
    showView('report'); aiPick(b.dataset.rep); }));
  box.querySelectorAll('[data-dr]').forEach(b=>b.addEventListener('click',(e)=>{ e.stopPropagation();
    const cn=b.dataset.dr; if(state.rows.has(cn)) openDetail(cn); }));   // in-place drawer — no tab switch
}
export { _act, openActionable, renderActionable };
