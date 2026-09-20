// base.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { earnBadge } from "./calendar.js";
import { COL_BY_KEY, brkBar, claimDelta, esc, fmtFunding, fmtPrice, fmtUsd, liq24Cell, liveMark, maCell, state, turnCell, vwapCell } from "./core.js";
import { dvbCell } from "./corr.js";
import { betaCell } from "./data.js";
import { adrCell, anchOpenCell, carryCell, cdsHtml, dcapCell, ddCell, ddyCell, dopenCell, gapCell, hitCell, momCell, mompCell, oiCell, openCell, pctInner, premCell, railHtml, rsCell, rvolCell, scCls, sessCell, shade, sqzCell, trendCell, volCell, vsTapeCell } from "./markets.js";
import { noteBadge } from "./notes.js";
import { posBadge, posCell } from "./prefs.js";
import { fmtAge } from "./trend.js";
   // named table layouts: columns, sort, window, filters

const COLS=[
  {key:'ticker', label:'Ticker', type:'str', def:'asc', hideable:false,
    td:r=>`<td class="tkc">${railHtml(r)}<span class="star${state.watch.has(r.coin)?' on':''}" data-star="${esc(r.coin)}" role="button" tabindex="0" title="${state.watch.has(r.coin)?'remove from watchlist':'add to watchlist'}">${state.watch.has(r.coin)?'★':'☆'}</span><span class="tk" title="${esc(r.nm?r.nm+' \u00b7 '+r.coin:r.coin)}">${esc(r.ticker)}</span>${earnBadge(r)}${noteBadge(r)}${posBadge(r)}${cdsHtml(r)}</td>`},
  {key:'sess', label:'Sess', type:'str', def:'asc', tip:'Home market of the reference line under the perp \u2014 KR (KRX), JP (TSE), HK (HKEX), CN (SSE) for foreign listings with no US symbol; US for everything else. Lit dot = that exchange is OPEN right now (server-computed, holiday-aware). US\u00b7TW etc. on ADRs = US-listed line (full ET machinery applies) with the home line leading it overnight \u2014 context, never anchoring. Stocks scope only.',
    td:r=>sessCell(r)},
  {key:'px', label:'Price', type:'num',
    td:r=>`<td class="px${r.flash?' flash-'+r.flash:''}">${fmtPrice(r.px)}</td>`},
  {key:'funding', label:'Funding (APR)', type:'num',
    td:r=>{ const f=fmtFunding(r.funding);
      const p=r.fundPct, ext=p!=null&&(p>=90||p<=10);
      const flag=ext?`<i class="fpx ${p>=90?'hi':'lo'}" title="${p}th percentile of this market's OWN 31d hourly funding distribution — the crowd's payment is at a monthly extreme (${p>=90?'longs paying near their monthly max: crowded long, classic mean-reversion zone':'shorts paying near their monthly max: crowded short, squeeze fuel'})">${p>=90?'\u25b4':'\u25be'}${p}</i>`:'';
      const t2=p!=null?`${f.title} \u00b7 ${p}th pctile of its own 31d funding`:f.title;
      return `<td class="${f.c}" title="${t2}">${f.t}${flag}</td>`; }},
  {key:'prem', label:'Prem', type:'num', tip:'Perp vs oracle dislocation in basis points: (mark \u2212 oracle) / oracle. When the cash market is closed the oracle sits near the last print, so a persistent premium (perp rich) or discount (perp cheap) IS the live off-hours price discovery \u2014 the tradeable dislocation. Hover a cell for the exact mark vs oracle prices.',
    td:r=>premCell(r)},
  {key:'m5', label:'5m', type:'num', tip:'5-minute price change: live mark vs the mark ~5 minutes ago, sampled server-side every 15s from the SAME streaming mark the Price column shows \u2014 one code path, accurate to within one tick of the true lookback. The sample ring is memory-only: for the first ~5 minutes after a deploy, or across a feed gap wider than 90s at the lookback point, this is an honest dash \u2014 never a longer move wearing a 5m label. Hidden by default \u2014 enable it here in the column menu.',
    td:r=>`<td class="${scCls(r)}"${shade(r.m5,1)}>${pctInner(r.m5)}</td>`},
  {key:'m15', label:'15m', type:'num', tip:'15-minute price change: live mark vs the mark ~15 minutes ago, sampled server-side every 15s from the same streaming mark the Price column shows. Memory-only ring: dashes for the first ~15 minutes after a deploy or across a feed gap wider than 90s \u2014 the label is exact or the cell is blank. Hidden by default \u2014 enable it here in the column menu.',
    td:r=>`<td class="${scCls(r)}"${shade(r.m15,1.8)}>${pctInner(r.m15)}</td>`},
  {key:'h1', label:'1h', type:'num', td:r=>`<td class="${scCls(r)}"${shade(r.h1,2.5)}>${pctInner(r.h1)}</td>`},
  {key:'h4', label:'4h', type:'num', td:r=>`<td class="${scCls(r)}"${shade(r.h4,4)}>${pctInner(r.h4)}</td>`},
  {key:'d1', label:'24h', type:'num', tip:'Rolling 24-hour change: live mark vs Hyperliquid\u2019s prevDayPx (the price ~24h ago), so the window slides continuously \u2014 at 3pm it measures against yesterday 3pm, not the day boundary. For "since today started" see D open.', td:r=>`<td${shade(r.d1,5)}>${pctInner(r.d1)}</td>`},
  {key:'dopen', label:'D open', type:'num', tip:'% change since the open of the current UTC day. Perps trade continuously, so today\u2019s open IS the prior day\u2019s close from the daily-close series \u2014 same convention as M open / Y open. Contrast with 24h, which is a rolling window; this one anchors on the day boundary. Hover for the exact open price. Dash while daily history backfills \u2014 honest null, never a guess.', td:r=>dopenCell(r)},
  {key:'hopen', label:'H open', type:'num', tip:'% change since the current UTC hour opened \u2014 what the forming 1h candle shows on a chart, vs the rolling 1h column. Anchors at :00 and resets there by construction, so it reads small early in the hour: that\u2019s the anchor, not a data gap. Hover for the exact open. Dash while the hourly spine catches up to the boundary \u2014 honest null, never a stale anchor. Hidden by default \u2014 enable it here in the column menu.', td:r=>anchOpenCell(r,'hopen','hopenPx','current UTC hour',1.5)},
  {key:'h4open', label:'4h open', type:'num', tip:'% change since the current UTC 4h bucket opened (00/04/08/12/16/20) \u2014 the forming 4h candle\u2019s read on a chart, vs the rolling 4h column. Resets at each bucket boundary by construction. Hover for the exact open. Dash while the spine catches up \u2014 honest null, never a stale anchor. Hidden by default \u2014 enable it here in the column menu.', td:r=>anchOpenCell(r,'h4open','h4openPx','current UTC 4h bucket',2.5)},
  {key:'h12open', label:'12h open', type:'num', tip:'% change since the current UTC 12h bucket opened (00/12) \u2014 the forming 12h candle\u2019s read, vs the rolling window columns. Resets at each boundary by construction. Hover for the exact open. Dash while the spine catches up \u2014 honest null, never a stale anchor. Hidden by default \u2014 enable it here in the column menu.', td:r=>anchOpenCell(r,'h12open','h12openPx','current UTC 12h bucket',3.5)},
  {key:'d7', label:'7d', type:'num', td:r=>`<td class="${scCls(r)}"${shade(r.d7,12)}>${pctInner(r.d7)}</td>`},
  {key:'d30', label:'30d', type:'num', td:r=>`<td class="${scCls(r)}"${shade(r.d30,25)}>${pctInner(r.d30)}</td>`},
  {key:'gap', label:'Gap', type:'num', tip:'Last close\u2192open gap \u2014 how much the perp moved from the most recent cash-session close to the next open, measured on the name\u2019s HOME session: 16:00\u219209:30 ET for US names, the KRX/TSE/HKEX boundary for foreign-home names (SMSN gaps on Seoul\u2019s clock, not New York\u2019s). One move, always the latest, regardless of the timeframe selector. Hover for the cumulative off-hours drift over ~30d.',
    td:r=>gapCell(r)},
  {key:'trend', label:'30d trend', type:'num', tip:'30-day price path (sparkline). Sorts by 30-day % change.', td:r=>trendCell(r)},
  {key:'rs', label:'vs S&P', type:'num', tip:'Excess return vs the S&P 500 perp over the window (this market % − S&P %).',
    td:r=>`<td${shade(r.rs,8)}>${rsCell(r)}</td>`},
  {key:'vstape', label:'vs tape', type:'num', def:'desc', tip:'This market\u2019s window return minus the UNIVERSE MEDIAN return \u2014 relative strength against the whole tape, not a benchmark. On a red tape, sort descending: the names above zero are holding stronger than the rest. Same reference as DownCap/Hit%, so today\u2019s read and the 31d character read line up one-to-one.',
    td:r=>`<td${shade(r.vstape,8)}>${vsTapeCell(r)}</td>`},
  {key:'dvb', label:'\u0394 vs \u2b12', type:'num', def:'desc',
    tip:'This market\u2019s window return minus the EW MEAN of the picked basket\u2019s members over the SAME window \u2014 a screener lens computed from the board\u2019s own h1/h4/1d/7d/30d fields, following the timeframe selector. Coverage floor 60%: when fewer members carry the field, the basket mean is a dash \u2014 never a thinner average. Pick the basket in the column header (\u25be). Tier note, load-bearing: this is a LENS, not the benchmark \u2014 the RS column and every beta stay on SP500/BTC; an editable basket is never the benchmark under signal math.',
    td:r=>dvbCell(r)},
  {key:'dcap', label:'DownCap 31d', type:'num', def:'asc', tip:'Down-capture vs the tape: over the last 31 days, on 4h bars where the whole scope was red (\u226570% of names down, negative median), how much of the tape\u2019s move this name ate. <100 = dumps less than the typical name, negative = net GREEN on red bars, >100 amplifies red tape. Sum-ratio vs the universe median, cascade bars winsorized. Fixed 31d/4h \u2014 does not follow the window selector. Dash below 20 matched bars.',
    td:r=>dcapCell(r)},
  {key:'hitr', label:'Hit%', type:'num', def:'desc', tip:'On those same red-tape 4h bars: the share where this name beat the universe median. The consistency check on DownCap \u2014 a good DownCap with a low Hit% means the average is carried by a couple of lucky bars; both strong means the resilience is character, not one print. Dash below 20 matched bars.',
    td:r=>hitCell(r)},
  {key:'rvol', label:'RVOL', type:'num', def:'desc', tip:'Relative volume, clock-hour matched: notional traded over the selected window (1h/4h/1d) \u00f7 the median notional of the SAME clock hours across the prior month. 1.0\u00d7 = normal for this time of day, \u22652\u00d7 = genuinely elevated. Clock matching means the quiet overnight hours are judged against prior overnights, not against the open \u2014 so an off-hours reading is real, just noisier. Defined up to the 1d window; 7d/30d show a dash.',
    td:r=>rvolCell(r)},
  {key:'beta', label:'β', type:'num', tip:'Beta to the S&P perp (90d daily returns): sensitivity to the benchmark. >1 amplifies it, 0–1 dampens, <0 moves inverse. Fills in once daily history loads in the background.',
    td:r=>betaCell(r)},
  {key:'mom', label:'Momentum', type:'num', def:'desc', tip:'Self-normalizing momentum −100…+100: risk-adjusted multi-horizon return × 7d trend quality + range position, modulated by OI conviction.',
    td:r=>`<td${shade(r.mom,60)}>${momCell(r)}</td>`},
  {key:'momp', label:'MOM+', type:'num', def:'desc', tip:'CANDIDATE momentum, running head-to-head with the incumbent: same core, but the OI term is regime-qualified (OI building amplifies only when funding corroborates the score\u2019s side; falling OI is short-covering \u2014 mechanically different flow \u2014 and dampens at half strength) and a funding-crowding haircut applies when the crowd pays its own monthly extreme to sit on the score\u2019s side (\u00d70.8 \u2014 the exhaustion tax the \u25b4/\u25be flag points at). Hover a diverging cell for which terms fired. Adjudicated on daily forward rank IC in the Backtest tab\u2019s Score duel panel \u2014 promotion only on a locked verdict, not by eye.',
    td:r=>mompCell(r)},
  {key:'vol30', label:'Vol (ann)', type:'num', tip:'Annualized realized volatility from hourly returns over ~30 days.', td:r=>volCell(r)},
  {key:'adr', label:'Avg Range', type:'num', tip:'Average daily range: mean of each completed day\u2019s (high − low) / close, over the window (7d, or 30d when the 30d window is selected). Reads as "on a typical day this moves X%."', td:r=>adrCell(r)},
  {key:'dd', label:'vs 30d hi', type:'num', tip:'Distance below the 30-day high (0% = sitting at the high).', td:r=>ddCell(r)},
  {key:'swr', label:'Swing R', type:'num', def:'desc',
    tip:'Swing R available \u2014 structural room for the NEXT swing trade, per unit of risk: distance to the nearest unified-level-map target in the trend direction \u00f7 distance to the D1 EMA21 void. The map merges detected structure, volume-profile HVN/LVN, and the daily EMA50/200, confluence-weighted \u2014 hand-set weights (str 1.0 \u00b7 hvn 0.8 \u00b7 e200 0.7 \u00b7 e50 0.6 \u00b7 lvn 0.5), disclosed until the levels study earns measured ones; pure-LVN entries are excluded as targets (thin volume is a path, not a destination). Stocks: profile is DEX volume \u2014 this venue\u2019s tape, not the cash market. Needs a stacked trend side and a live EMA21 \u2014 dash otherwise. Sort descending to find where the big structural trades are BEFORE any signal fires. Hover a cell for target, sources, void.',
    td:r=>{ if(r.swr==null) return '<td class="sec">\u2014</td>';
      const t=`target ${fmtPrice(r.swrT)} (${r.swrS}) \u00b7 void ${fmtPrice(r.swrV)} (D1 EMA21) \u00b7 ${r.swr}R of structural room in the trend direction \u00b7 map levels move on daily cadence; ratio measured at snapshot against the mark`;
      const cls=r.swr>=3?'pos':(r.swr<1?'neg':'');
      return `<td class="${cls}" title="${esc(t)}">${(+r.swr).toFixed(1)}R</td>`; }},
  {key:'ddy', label:'vs YTD hi', type:'num', tip:'Distance below the year\u2019s highest DAILY CLOSE (0% = making the YTD high now). Closes-based \u2014 intraday highs aren\u2019t retained at daily granularity, so this is the honest computable basis, same convention as the MA columns. Names listed this year use their full-life high (which IS their YTD high). Crypto: 31d retention only reaches Jan 1 in January \u2014 outside that, an honest dash.', td:r=>ddyCell(r)},
  {key:'yopen', label:'Y open', type:'num', tip:'Open of the first UTC day of the year. Perps trade continuously, so the yearly open IS the prior day\u2019s close, taken from the daily-close series. Names listed this year use their first close \u2014 their true opening level. Green when price is above it, red below; hover for the distance. Crypto: 31d retention only reaches Jan 1 in January.', td:r=>openCell(r,'yopen','yearly open')},
  {key:'mopen', label:'M open', type:'num', tip:'Open of the first UTC day of the current month \u2014 the prior day\u2019s close on a continuously-traded perp. Names listed this month use their first close. Green when price is above it, red below; hover for the distance.', td:r=>openCell(r,'mopen','monthly open')},
  {key:'doi', label:'ΔOI', type:'num', tip:'Open-interest change over the window, with a price-vs-OI regime tag. Stored server-side and persistent.',
    td:r=>`<td>${oiCell(r)}</td>`},
  {key:'sqz', label:'Squeeze', type:'num', def:'desc', tip:'Squeeze susceptibility 0\u2013100: how loaded the short-squeeze spring is over the window. Crowding (how hard shorts pay via window-avg negative funding) \u00d7 fuel (OI building) \u00d7 trigger (price pressing toward the 30d high). 0 whenever funding is positive \u2014 no crowded shorts, no squeeze. Sort descending to screen. Hover for the components.',
    td:r=>sqzCell(r)},
  {key:'cascT', label:'Casc', type:'num', def:'desc', tip:'Liquidation-cascade flag (crypto scope only): \u25c6 with age when a 15-minute bucket in the last 24h printed a side\u2019s forced-liquidation notional \u22653\u03c3 above its own trailing 24h baseline WITH open interest dropping \u22651% in the same bucket \u2014 forced flow that actually cleared positioning. Red \u25c6 = longs liquidated (down-cascade), green \u25c6 = shorts (up-cascade). Aggregated CEX data via Coinalyze \u2014 market context for the HL name, NOT Hyperliquid-native. Hover a cell for the bucket\u2019s numbers; the drawer has the full panel. Computed server-side \u2014 board and drawer always agree.',
    td:r=>cascCell(r)},
  {key:'liq24', label:'24h Liqs', type:'num', def:'desc', tip:'Total forced-liquidation volume over the last 24 hours, USD (crypto scope only): longs + shorts liquidated, summed from 15-minute buckets. Aggregated CEX data via Coinalyze, USD source-converted \u2014 market context for the HL name, NOT Hyperliquid-native. Hover a cell for the long/short split \u2014 a heavily one-sided day tells you which crowd was carried out. Same server-computed rollup the drawer\u2019s Derivs panel shows.',
    td:r=>liq24Cell(r)},
  {key:'carry', label:'Carry', type:'num', def:'desc', tip:'Funding carry per unit of risk: window-avg funding (APR%) \u00f7 annualized realized vol. +0.5 = the short side collects half a vol-unit per year just for holding; negative = the long side is paid. The screen for "paid to take the unpopular side." Same sign convention as the funding column.',
    td:r=>carryCell(r)},
  {key:'vol', label:'24h Vol', type:'num', td:r=>`<td class="sec">${fmtUsd(r.vol)}</td>`},
  {key:'oi', label:'OI', type:'num', td:r=>`<td class="sec">${fmtUsd(r.oi)}</td>`},
  {key:'pos', label:'Position', type:'num', tip:'Your open position in this market, from the wallet linked under Filters \u203a Positions: side, notional at the live mark, and the move since entry signed with the side (a short whose price fell reads green). Sorts by signed notional. Hidden until a wallet is linked; unrealized P&L is derived here off the same mark the table shows, so it moves with the tape between wallet polls.', td:r=>posCell(r)},
  {key:'ma20', label:'MA 20', type:'num', tip:'20-day simple moving average of daily closes \u00b7 green when price is above it, red below \u00b7 fills in once daily history loads \u00b7 hover for distance', td:r=>maCell(r,'ma20',20)},
  {key:'ma50', label:'MA 50', type:'num', tip:'50-day simple moving average of daily closes \u00b7 green when price is above it, red below \u00b7 crypto scope shows \u2014 (31d retention holds fewer than 50 closes)', td:r=>maCell(r,'ma50',50)},
  {key:'ma100', label:'MA 100', type:'num', tip:'100-day simple moving average of daily closes \u00b7 green when price is above it, red below \u00b7 crypto scope shows \u2014 (31d retention)', td:r=>maCell(r,'ma100',100)},
  {key:'ma200', label:'MA 200', type:'num', tip:'200-day simple moving average of daily closes \u00b7 green when price is above it, red below \u00b7 crypto scope shows \u2014 (31d retention)', td:r=>maCell(r,'ma200',200)},
  {key:'vwap', label:'VWAP 30d', type:'num', tip:'Volume-weighted average price over the last ~31 days of hourly candles: \u03a3(typical price \u00d7 volume) \u00f7 \u03a3(volume), typical = (H+L+C)/3 per bar. The average holder\u2019s entry over the month, weighted by where the volume actually printed \u2014 unlike the MAs, which weight every day equally. Candle-level approximation of tick VWAP; slightly less exact on thin markets with gappy candles. Green when price is above it, red below; hover for distance. Both scopes.', td:r=>vwapCell(r)},
  {key:'vsvwap', label:'vs VWAP', type:'num', def:'desc', tip:'Distance of the mark from the 30d rolling VWAP, in %. Positive = price above where the month\u2019s volume was done (average recent buyer in profit); negative = below it (trapped longs overhead). Stretch far from VWAP mean-reverts more often than it trends \u2014 read alongside Momentum and \u0394OI, not alone.', td:r=>vsvwapCell(r)},
  {key:'turn', label:'OI/Vol', type:'num', def:'desc', tip:'Open interest \u00f7 24h volume: how large standing positioning is relative to the flow that could move it. High (\u22652) = stale, crowded positioning \u2014 fragile to squeezes and unwinds, reads well next to the Squeeze and \u0394OI columns. Low (<0.5) = fresh churn, positions turn over within the day.',
    td:r=>turnCell(r)},
];
function vsvwapCell(r){ const v=r.vsvwap;
  if(v==null||!isFinite(v)) return '<td><span class="na" title="fills in once hourly history loads (\u226410 min after deploy)">\u2014</span></td>';
  return `<td${shade(v,15)}><span class="${v>=0?'pos':'neg'}" title="mark ${v>=0?'above':'below'} the 30d VWAP (${fmtPrice(r.vwap30)})">${v>=0?'+':''}${v.toFixed(1)}%</span></td>`; }
function cascCell(r){ if(r.uni!=='main') return '<td><span class="na">\u2014</span></td>';
  const c=r.casc;
  if(!c||!c.t) return '<td><span class="na" title="no liquidation cascade flagged in the last 24h \u00b7 aggregated CEX data (Coinalyze), not HL-native \u00b7 a bucket is only judged against \u226524h of its own accumulated baseline \u2014 honest blank until then">\u00b7</span></td>';
  const age=fmtAge(Date.now()-c.t);
  return `<td class="${c.side==='long'?'neg':'pos'}" title="${c.side} cascade ${age} ago \u00b7 ${fmtUsd(c.liq)} of ${c.side}s force-liquidated in one 15m bucket \u00b7 OI ${c.doiPct>0?'+':''}${c.doiPct}% in the same bucket \u00b7 aggregated CEX (Coinalyze) \u2014 context for the HL name, not HL-native \u00b7 drawer has the full panel">\u25c6 ${age}</td>`; }

export function __boot_base_1() { COLS.forEach(c=>COL_BY_KEY[c.key]=c);
}

// The shared chip. `c` is a claim-shaped object: {side, px|mark0, stp|stop, tgt, status}.
// Settled claims deliberately get a dash: their trade is over and the outcome column owns the
// answer — a live price on a claim that resolved three weeks ago is noise wearing information.
function nowChip(coin,c,opts){
  const o=opts||{}, wrap=o.wrap!==false;
  const dash=(why)=>wrap?`<span class="nowchip" data-tip="${esc(why)}">now <span class="na">\u2014</span></span>`
    :`<span class="na" data-tip="${esc(why)}">\u2014</span>`;
  if(!c){
    // -31: a re-arm-parked episode is not "nothing" — its claim already resolved into the
    // record, and the server ships that resolution. Render the outcome, not a dash: the reader's
    // real question here is "did this already play out", and the answer is sitting in the ledger.
    const sc=o.scored;
    if(sc){
      const ago=sc.tR!=null?fmtAge(Date.now()-sc.tR):null;
      const val=sc.realized!=null
        ?`<b class="${sc.realized>0?'pos':sc.realized<0?'neg':'sec'}">${sc.realized>0?'+':''}${sc.realized}${esc(sc.unit||'')}</b>`
        :'<span class="na">void</span>';
      const tip=`this episode already SCORED \u2014 the claim behind this signal ${sc.voided
          ?'expired without a resolvable outcome (settled as void)'
          :`resolved ${sc.realized!=null?(sc.realized>0?'+':'')+sc.realized+(sc.unit||''):'\u2014'}${sc.stopped?' by hitting its frozen void level':' at its horizon'}`}${ago?` ${ago} ago`:''} and is in the record. The condition has not lapsed since, so the re-arm gate refuses a second claim on the same episode \u2014 one episode, one claim; a serial re-claim would inflate n with pseudo-replication. A fresh claim opens only after the condition clears for a full build and then fires again. No live delta is shown because there is no open mark to measure against: the trade this record scored is over, and what you are looking at is its persistence, not a new setup.`;
      const inner=`scored ${val}${ago?` <span class="sec">\u00b7 ${ago} ago</span>`:''}`;
      return wrap?`<span class="nowchip" data-tip="${esc(tip)}">${inner}</span>`:`<span data-tip="${esc(tip)}">${inner}</span>`;
    }
    return dash('no ledger claim behind this signal yet \u2014 nothing to measure a live price against');
  }
  if(c.status&&c.status!=='open')
    return dash('this claim is settled \u2014 its trade is over and the outcome column states what happened. A live price here would be noise, not information.');
  const px=liveMark(coin);
  if(px==null) return dash('no live mark for this name in the loaded book \u2014 the other universe\u2019s snapshot isn\u2019t in the client, or the market is delisted. A dash rather than a stale price: the last value seen could be minutes old with no way to tell from here.');
  const side=c.side||'long', mark=c.px!=null?+c.px:(c.mark0!=null?+c.mark0:null);
  const stp=c.stp!=null?+c.stp:(c.stop!=null?+c.stop:null), tgt=c.tgt!=null?+c.tgt:null;
  const d=claimDelta(side,mark,px);
  const bb=brkBar(side,mark,px,stp,tgt);
  const dTxt=d==null?'':` <span class="${d>0?'pos':d<0?'neg':'sec'}">${d>0?'+':''}${d.toFixed(1)}%</span>`;
  const tip=`LIVE \u2014 ${fmtPrice(px)} now, read from the same streaming mark the board and screener use (never shipped in the cached ledger payload, so nothing here can disagree with the board).`
    +(d==null?' The claim carries no fire mark, so no delta can be stated.'
      :` \u0394 is signed WITH the claim: this is a ${side.toUpperCase()}, so ${side==='short'?'price falling':'price rising'} reads GREEN \u2014 the chip answers \u201cis this claim currently winning\u201d, not \u201cis the chart up\u201d. From ${fmtPrice(mark)} at fire: ${d>0?'+':''}${d.toFixed(2)}%.`)
    +(bb?` Bracket: ${Math.round(bb.frac*100)}% of the way to the frozen ${bb.towardT?'target':'void'} (${fmtPrice(bb.towardT?tgt:stp)}); the frozen ${bb.towardT?'void':'target'} (${fmtPrice(bb.towardT?stp:tgt)}) is untouched. The claim resolves at the FIRST touch of either level, or at its horizon.`
      :(stp==null&&tgt==null?' This convention froze no levels, so there is nothing to measure travel against \u2014 \u0394 only.':''));
  const inner=`now <b>${fmtPrice(px)}</b>${dTxt}${bb?bb.html:''}`;
  return wrap?`<span class="nowchip" data-tip="${esc(tip)}">${inner}</span>`:`<span data-tip="${esc(tip)}">${inner}</span>`;
}
export { COLS, nowChip };
