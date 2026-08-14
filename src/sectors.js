"use strict";
// Ticker -> {assetClass, sector} classification.
// Equities map to a GICS sector from a curated table; ETFs, indices, FX, commodities and
// crypto get an asset-class label. Unknown tickers return "Unclassified" — never guessed.
// Tuned to the live `xyz` HIP-3 universe (foreign chipmakers, 2025 IPOs, sector/region ETFs,
// bare FX codes, the XYZ100 dex index, and commodity CME codes like CL=WTI).

const SECTOR_TICKERS = {
  "Information Technology": ["AAPL","MSFT","NVDA","AVGO","ORCL","CRM","ADBE","AMD","INTC","CSCO","ACN","TXN","QCOM","IBM","NOW","INTU","AMAT","MU","ADI","LRCX","KLAC","SNPS","CDNS","PANW","ANET","MRVL","FTNT","ON","DELL","HPQ","HPE","NXPI","MCHP","ROP","TEL","GLW","SMCI","WDC","STX","ZS","CRWD","DDOG","SNOW","NET","PLTR","TEAM","WDAY","ADSK","APH","MPWR","FSLR","KEYS","CTSH","IT","GRMN","TER","ZBRA","TYL","PTC","ANSS","EPAM","ZM","TSM","ASML","ARM","MSTR","BB","NBIS","CRWV","CBRS","LITE","SNDK","SKHX","SMSN","KIOXIA","IBIDEN","ZHIPU","MINIMAX"],
  "Communication Services": ["GOOGL","GOOG","META","NFLX","DIS","CMCSA","T","VZ","TMUS","CHTR","EA","TTWO","WBD","OMC","LYV","MTCH","PINS","SNAP","RBLX","SPOT","ROKU","IPG","NWSA","FOXA","PARA","WMG","SOFTBANK"],
  "Consumer Discretionary": ["AMZN","TSLA","HD","MCD","NKE","LOW","SBUX","BKNG","TJX","ORLY","CMG","MAR","GM","F","HLT","ROST","AZO","YUM","LULU","DHI","LEN","EBAY","ETSY","ABNB","DRI","RCL","CCL","NCLH","EXPE","APTV","RIVN","LCID","DKNG","PHM","BBY","DPZ","TSCO","ULTA","LVS","WYNN","MGM","GPC","KMX","POOL","NVR","BABA","GME","HYUNDAI","BIRD"],
  "Consumer Staples": ["PG","KO","PEP","COST","WMT","PM","MO","MDLZ","TGT","KMB","GIS","KHC","SYY","STZ","KDP","MNST","HSY","KR","ADM","DG","DLTR","CLX","CHD","MKC","K","HRL","TSN","CAG","CPB","EL","KVUE","BG","TAP"],
  "Health Care": ["UNH","JNJ","LLY","ABBV","MRK","PFE","TMO","ABT","DHR","AMGN","BMY","GILD","CVS","MDT","ISRG","ELV","VRTX","REGN","CI","ZTS","BSX","HCA","SYK","BDX","HUM","MRNA","BIIB","IDXX","DXCM","IQV","MCK","CNC","GEHC","EW","A","RMD","WST","BAX","ZBH","MTD","COR","ALGN","HOLX","STE","HIMS"],
  "Financials": ["BRK.B","BRKB","JPM","V","MA","BAC","WFC","GS","MS","SPGI","AXP","BLK","C","SCHW","CB","PGR","MMC","PNC","USB","TFC","AON","ICE","CME","COF","MET","AIG","PRU","TRV","ALL","BK","AFL","MSCI","PYPL","SQ","COIN","HOOD","FIS","FI","GPN","DFS","SYF","MCO","AJG","NDAQ","STT","FITB","HBAN","RF","CFG","KEY","AMP","TROW","CRCL","BX","STRC"],
  "Industrials": ["CAT","HON","UPS","BA","GE","RTX","UNP","DE","LMT","ADP","GD","NOC","ETN","MMM","ITW","EMR","CSX","FDX","NSC","WM","GEV","PH","TDG","CTAS","PCAR","CARR","OTIS","CMI","ROK","IR","FAST","ODFL","LUV","DAL","UAL","AAL","PAYX","VRSK","URI","LHX","RSG","GWW","AME","DOV","HWM","WAB","EFX","XYL","FTV","PWR","BLDR","J","RKLB","BE","SPCX"],
  "Energy": ["XOM","CVX","COP","SLB","EOG","MPC","PSX","VLO","WMB","OKE","HES","OXY","KMI","HAL","DVN","BKR","FANG","TRGP","CTRA","MRO","APA","EQT","LNG","OVV","MTDR","DINO"],
  "Materials": ["LIN","APD","SHW","ECL","FCX","NEM","DOW","DD","NUE","CTVA","VMC","MLM","PPG","ALB","IFF","LYB","STLD","CF","MOS","CE","EMN","IP","PKG","AMCR","BALL","AVY","FMC","USAR"],
  "Utilities": ["NEE","DUK","SO","D","AEP","SRE","EXC","XEL","ED","PEG","WEC","AWK","PCG","EIX","DTE","AEE","ETR","ES","FE","PPL","CMS","CNP","NRG","VST","LNT","EVRG","ATO","NI","PNW"],
  "Real Estate": ["PLD","AMT","EQIX","CCI","PSA","O","SPG","WELL","DLR","VICI","SBAC","AVB","EQR","EXR","INVH","VTR","ARE","MAA","ESS","KIM","UDR","HST","BXP","IRM","CBRE","CPT","REG","DOC","WY"],
};

const SECTOR_ETF = { XLE:"Energy", XOP:"Energy", SMH:"Information Technology", SOXX:"Information Technology", XLK:"Information Technology", XLF:"Financials", XLV:"Health Care", XLI:"Industrials", XLP:"Consumer Staples", XLY:"Consumer Discretionary", XLB:"Materials", XLU:"Utilities", XLRE:"Real Estate", XLC:"Communication Services", URNM:"Materials", URA:"Materials" };
// Pre-IPO synthetic perps (track a private company's implied valuation before listing).
// GRADUATION IS A CURATED EDIT, NEVER AUTO-DETECTED: several synthetic tickers collide with
// real listed symbols (RAMP is LiveRamp on NYSE; FIGURE, DISCORD are plausible future
// collisions), so matching a symbol against an external listings feed would silently
// reclassify a private synthetic the moment an unrelated company lists under the same code.
// When a name actually lists: move the ticker into SECTOR_TICKERS, drop it here, update its
// DISPLAY_NAMES label (the "pre-IPO synthetic" disclosure must go), and add a COMPANY_NAMES
// alias — earnings-calendar eligibility then follows automatically from assetClass "Equity".
// Graduated: SPCX (SpaceX, Nasdaq listing 2026-06-12).
const PREIPO = { OPENAI:"Information Technology", ANTHROPIC:"Information Technology", CURSOR:"Information Technology", XAI:"Information Technology", DATABRICKS:"Information Technology", STRIPE:"Financials", REVOLUT:"Financials", DISCORD:"Communication Services", CANVA:"Information Technology", RAMP:"Financials", ANDURIL:"Industrials", FIGURE:"Industrials" };
// Thematic / synthetic price indices that don't map to a single company.
const THEMATIC = new Set(["DRAM","H100","BOT","GPU","HBM","WAFER","COMPUTE","NAND","MEMORY"]);
const REGION_ETF = new Set(["EWY","EWJ","EWZ","EWT","EWG","EWU","EWH","EWA","EWW","EWC","FXI","MCHI","INDA","EEM","VEA","VWO","SPY","QQQ","IWM","DIA","VOO"]);

const INDEX = new Set(["SPX","SP500","US500","USSPX500","SP500USD","SPXUSD","GSPC","US500USD","SPX500","ES","NDX","NAS100","US100","USTECH100","NQ","DJI","US30","DOW","DJIA","YM","RUT","US2000","RTY","RUSSELL2000","VIX","VOL","FTSE","FTSE100","UK100","DAX","DAX40","DE40","GER40","NIKKEI","NIKKEI225","N225","JP225","HSI","HK50","CAC","CAC40","FR40","ESTX50","EU50","STOXX50","ASX200","AUS200","SMI","IBEX35","AEX","KR200","KOSPI","KOSPI200","NIFTY","NIFTY50","IBOV","BOVESPA","XYZ100"]);
const CRYPTO = new Set(["BTC","XBT","ETH","SOL","XRP","DOGE","ADA","AVAX","LINK","DOT","MATIC","POL","BNB","LTC","BCH","ATOM","UNI","ETC","FIL","APT","ARB","OP","SUI","SEI","TIA","INJ","NEAR","TRX","TON","SHIB","PEPE","WIF","BONK","AAVE","MKR","LDO","RNDR","IMX","ORDI","JUP","PYTH","JTO","WLD","ENA","ONDO","HYPE","PURR","QNT","PURRDAT"]);
const COMMOD = new Set(["XAU","GOLD","XAUUSD","XAG","SILVER","XAGUSD","WTI","OIL","USOIL","CL","CRUDE","BRENT","UKOIL","BRENTOIL","NATGAS","NGAS","NG","XNG","TTF","COPPER","XCU","HG","XPT","PLATINUM","XPD","PALLADIUM","URANIUM","ALUMINIUM","ALUMINUM","CORN","WHEAT","SOYBEAN","SOYBEANS","COCOA","COFFEE","SUGAR","COTTON"]);
const FX = new Set(["EURUSD","GBPUSD","USDJPY","USDCHF","AUDUSD","USDCAD","NZDUSD","EURGBP","EURJPY","GBPJPY","EURCHF","AUDJPY","CADJPY","CHFJPY","NZDJPY","EURAUD","EURCAD","GBPAUD","GBPCAD","AUDNZD","AUDCAD","DXY","USDX","USDCNH","USDMXN","USDZAR","USDTRY","USDSGD","USDHKD","USDSEK","USDNOK","EURNOK","EURSEK","USDCNY"]);
const CCY = new Set(["USD","EUR","GBP","JPY","CHF","AUD","CAD","NZD","CNH","CNY","MXN","ZAR","TRY","SGD","HKD","SEK","NOK","DKK","PLN","KRW","INR","BRL"]);

const EQ = {};
for (const [sector, arr] of Object.entries(SECTOR_TICKERS)) for (const t of arr) EQ[t] = sector;

function norm(t) { return String(t || "").toUpperCase().replace(/[^A-Z0-9.]/g, ""); }

// ---- runtime classification overlay (build 2026.08.05-02) -------------------------------------
// The weekly sector-audit job's write surface. The curated tables above are SOURCE CODE — a job
// cannot durably edit them (Railway redeploys from git) — so audit decisions land as a persisted
// overlay the poller loads from /data and installs here. Precedence is deliberate and narrow:
//   · a "graduate" entry supersedes the PREIPO table only (Pre-IPO -> Equity; sector stays the
//     CURATED Pre-IPO sector — graduation changes asset class, it never invents a new sector);
//   · a "classify" entry fills ONLY where every static table is silent (the Unclassified branch);
//   · a curated SECTOR_TICKERS entry always wins — the overlay can never reclassify a curated name.
// Entries carry `auto` in the classify() result ("grad"/"cls") so every consumer — board payload,
// admin panel, terminal — reads provenance off the ONE classification path, never a side channel.
// Sector values are validated against the GICS table here (defense in depth: the poller validates
// too, but a corrupt overlay file must not be able to mint a sector the client has never heard of).
const GICS_SECTORS = new Set(Object.keys(SECTOR_TICKERS));
const OVERLAY = new Map();   // TICKER -> { action: "classify"|"graduate", sector, ind }
function setSectorOverlay(list) {
  OVERLAY.clear();
  for (const e of (Array.isArray(list) ? list : [])) {
    const T = norm(e && e.ticker); if (!T) continue;
    const action = e.action === "graduate" ? "graduate" : "classify";
    const sector = String((e && e.sector) || "");
    if (!GICS_SECTORS.has(sector)) continue;   // invalid sector -> entry dropped, ticker stays honest
    const ind = e && e.ind ? String(e.ind) : sector;
    OVERLAY.set(T, { action, sector, ind });
  }
  return OVERLAY.size;
}
function overlayFor(t) { return OVERLAY.get(norm(t)) || null; }

// ---- home-market classification (build 2026.08.14-01) -----------------------------------------
// Foreign listings WITHOUT a US symbol: the reference line under the perp discovers price on an
// Asian exchange, so the ET session machinery is re-anchored to the home market for these names
// (see compute.js HOME_MKTS). Curated and NEVER guessed — an unlisted ticker returns null and
// keeps the full ET machinery, which is the correct default for every US listing.
// KR = KRX (SMSN Samsung 005930, SKHX SK Hynix 000660, HYUNDAI 005380).
// JP = TSE (SOFTBANK 9984, KIOXIA 285A, IBIDEN 4062).
// HK = HKEX (ZHIPU 02513.HK and MINIMAX — both listed Hong Kong, Jan 2026).
const HOME_MKT = { SMSN: "KR", SKHX: "KR", HYUNDAI: "KR", SOFTBANK: "JP", KIOXIA: "JP", IBIDEN: "JP", ZHIPU: "HK", MINIMAX: "HK" };
// ADR ANNOTATION ONLY — these are US-listed instruments, so every ET anchor is already correct
// for the listed line; the home code is context (the overseas line leads it overnight), and it
// must NEVER route a name into the home-anchored machinery. Kept in a separate table so the two
// meanings cannot be conflated by a future edit.
const HOME_ADR = { TSM: "TW", ASML: "NL", ARM: "GB", BABA: "HK" };
function homeMkt(t, uni) { if (uni === "main") return null; return HOME_MKT[norm(t)] || null; }
function homeAdr(t) { return HOME_ADR[norm(t)] || null; }

// ---- industry groups (build 2026.07.28-04) ----------------------------------------------------
// A finer, trader-oriented grouping LAYERED ON TOP of the GICS sector — never replacing it.
// Rationale: Info Tech is a ~70-ticker mega-bucket where AAPL/MSFT volume-weighting drowns a
// 6-name memory complex; the industry lens makes memory-vs-semis-vs-software rotation legible.
// Rules of this table:
//   · Curated static edit, reviewed like the GICS map — never AI-learned, never auto-promoted.
//   · Groups are DELIBERATELY allowed to cross GICS sectors when that is how the tape trades
//     (Crypto-Fi holds COIN/HOOD from Financials next to MSTR from Info Tech; Mega Platforms
//     spans three sectors; the DRAM/HBM/NAND thematic indices sit inside Memory/Storage).
//   · A ticker with no entry here inherits its GICS sector as its industry — the client renders
//     that fallback VISIBLY (italic, "= sector" chip), it is never hidden or guessed.
//   · Group names must never collide with a GICS sector name or "Unclassified": the client
//     detects fallback groups by name-vs-entry, and a collision would silently merge a curated
//     group with fallback members. Guarded by test.
//   · Scope: display grouping in the Sectors tab ONLY. Signal-engine pooling, news badges and
//     asset-class scoping stay on the untouched 11-sector GICS map.
const IND_TICKERS = {
  // -- Info Tech splits (plus the deliberate cross-sector groups) --
  "Mega Platforms": ["AAPL","MSFT","GOOGL","GOOG","META","AMZN"],
  "Semiconductors": ["NVDA","AMD","AVGO","INTC","TXN","QCOM","ADI","NXPI","MCHP","ON","MRVL","MPWR","TSM","ARM","CBRS","SMH","SOXX"],
  "Semi Equipment": ["AMAT","LRCX","KLAC","ASML","TER","KEYS","IBIDEN","WAFER"],
  "Memory/Storage": ["MU","WDC","STX","SNDK","SKHX","KIOXIA","SMSN","DRAM","HBM","NAND","MEMORY"],
  "AI Infra":       ["NBIS","CRWV","SMCI","SOFTBANK","GPU","H100","COMPUTE"],
  "AI Software":    ["PLTR","ZHIPU","MINIMAX","OPENAI","ANTHROPIC","XAI","CURSOR","DATABRICKS"],
  "Software":       ["ORCL","CRM","ADBE","NOW","INTU","SNPS","CDNS","TEAM","WDAY","ADSK","TYL","PTC","ANSS","ZM","IBM","DDOG","SNOW","CANVA"],
  "Cybersecurity":  ["PANW","CRWD","ZS","FTNT","NET"],
  "IT Services":    ["ACN","CTSH","IT","EPAM"],
  "Hardware":       ["DELL","HPQ","HPE","APH","TEL","GLW","ZBRA","GRMN","LITE","BB","CSCO","ANET"],
  "Clean Energy":   ["FSLR","BE"],
  // -- Communication Services splits --
  "Media/Streaming": ["NFLX","DIS","CMCSA","CHTR","WBD","PARA","FOXA","NWSA","WMG","LYV","SPOT","ROKU","OMC","IPG"],
  "Telecom":         ["T","VZ","TMUS"],
  "Social/Gaming":   ["PINS","SNAP","MTCH","RBLX","EA","TTWO","DISCORD"],
  // -- Consumer Discretionary splits --
  "Autos/EV":        ["TSLA","GM","F","RIVN","LCID","APTV","HYUNDAI"],
  "E-Commerce":      ["BABA","EBAY","ETSY"],
  "Retail":          ["HD","LOW","TJX","ROST","AZO","ORLY","BBY","GPC","KMX","TSCO","ULTA","GME"],
  "Restaurants":     ["MCD","SBUX","CMG","YUM","DPZ","DRI"],
  "Travel/Leisure":  ["BKNG","MAR","HLT","ABNB","EXPE","RCL","CCL","NCLH"],
  "Casinos/Betting": ["LVS","WYNN","MGM","DKNG"],
  "Home/Building":   ["DHI","LEN","PHM","NVR","BLDR","POOL"],
  "Apparel":         ["NKE","LULU","BIRD"],
  // -- Consumer Staples splits --
  "Staples Retail":  ["WMT","COST","TGT","KR","DG","DLTR"],
  "Bev/Tobacco":     ["KO","PEP","PM","MO","STZ","KDP","MNST","TAP"],
  "Food":            ["MDLZ","GIS","KHC","SYY","HSY","ADM","K","HRL","TSN","CAG","CPB","BG","MKC"],
  "Household":       ["PG","KMB","CLX","CHD","EL","KVUE"],
  // -- Health Care splits --
  "Pharma":          ["JNJ","LLY","ABBV","MRK","PFE","AMGN","BMY","GILD","ZTS"],
  "Biotech":         ["VRTX","REGN","MRNA","BIIB"],
  "MedTech":         ["MDT","ISRG","BSX","SYK","BDX","EW","ZBH","ALGN","HOLX","STE","DXCM","IDXX","RMD","WST","BAX","A","MTD","TMO","DHR","GEHC"],
  "Health Services": ["UNH","ELV","CI","HUM","CNC","CVS","MCK","COR","HCA","IQV","HIMS"],
  // -- Financials splits --
  "Banks":           ["JPM","BAC","WFC","C","USB","PNC","TFC","FITB","HBAN","RF","CFG","KEY"],
  "Capital Markets": ["GS","MS","SCHW","BLK","BX","TROW","AMP","STT","BK"],
  "Exchanges/Data":  ["ICE","CME","NDAQ","SPGI","MCO","MSCI"],
  "Payments/Credit": ["V","MA","AXP","PYPL","SQ","FIS","FI","GPN","DFS","SYF","COF","STRIPE","RAMP","REVOLUT"],
  "Crypto-Fi":       ["COIN","HOOD","MSTR","CRCL","STRC"],
  "Insurance":       ["BRK.B","BRKB","CB","PGR","MMC","AON","MET","AIG","PRU","TRV","ALL","AFL","AJG"],
  // -- Industrials splits (rest of the sector falls back visibly) --
  "Aero/Defense":    ["BA","GE","RTX","LMT","GD","NOC","LHX","TDG","HWM","RKLB","ANDURIL","SPCX"],
  "Transport":       ["UNP","CSX","NSC","UPS","FDX","ODFL","LUV","DAL","UAL","AAL","PCAR","WAB"],
  "Power/Grid":      ["GEV","VST","NRG","PWR"],
  "Robotics":        ["FIGURE","BOT"],
  // -- Energy splits --
  "E&P/Majors":      ["XOM","CVX","COP","EOG","OXY","DVN","FANG","CTRA","MRO","APA","EQT","OVV","MTDR","HES"],
  "Refiners":        ["MPC","PSX","VLO","DINO"],
  "Oil Services":    ["SLB","HAL","BKR"],
  "Midstream/LNG":   ["WMB","OKE","KMI","LNG","TRGP"],
  // -- Materials splits --
  "Metals/Mining":   ["FCX","NEM","NUE","STLD","USAR","ALB","URNM","URA"],
  "Chemicals":       ["LIN","APD","SHW","ECL","DOW","DD","PPG","LYB","CF","MOS","CE","EMN","IFF","CTVA","FMC"],
  // -- Real Estate split --
  "Digital REITs":   ["EQIX","DLR","AMT","CCI","SBAC","IRM"],
};
const IND = {};
for (const [ind, arr] of Object.entries(IND_TICKERS)) for (const t of arr) IND[t] = ind;
// The industry for a classified instrument: its curated group, else its own sector (the visible
// fallback). One helper so every classify() branch attaches `ind` by the exact same rule.
function indOf(T, Td, sector) { return IND[T] || IND[Td] || sector; }

// Crypto taxonomy for the Hyperliquid main dex (Build B): curated, same shape as the GICS
// map. Unknowns fall to "Other" — still classed Crypto, so scope filtering stays airtight.
const CRYPTO_SECTORS = {
  BTC: "Majors", ETH: "Majors", SOL: "Majors", XRP: "Majors", BNB: "Majors", DOGE: "Meme",
  ADA: "L1", AVAX: "L1", SUI: "L1", APT: "L1", SEI: "L1", TIA: "L1", NEAR: "L1", TON: "L1",
  DOT: "L1", ATOM: "L1", TRX: "L1", LTC: "L1", BCH: "L1", ETC: "L1", KAS: "L1", INJ: "L1",
  ARB: "L2", OP: "L2", STRK: "L2", ZK: "L2", BLAST: "L2", MNT: "L2", POL: "L2", MATIC: "L2",
  HYPE: "DeFi", LINK: "DeFi", UNI: "DeFi", AAVE: "DeFi", MKR: "DeFi", CRV: "DeFi", LDO: "DeFi",
  ENA: "DeFi", PENDLE: "DeFi", JUP: "DeFi", DYDX: "DeFi", GMX: "DeFi", SNX: "DeFi", COMP: "DeFi",
  ONDO: "DeFi", EIGEN: "DeFi", ETHFI: "DeFi", MORPHO: "DeFi", AERO: "DeFi",
  WIF: "Meme", PEPE: "Meme", BONK: "Meme", SHIB: "Meme", FLOKI: "Meme", MEME: "Meme",
  POPCAT: "Meme", MEW: "Meme", BRETT: "Meme", MOODENG: "Meme", PNUT: "Meme", FARTCOIN: "Meme",
  SPX: "Meme", GOAT: "Meme", TRUMP: "Meme", MELANIA: "Meme", DOGS: "Meme", NEIRO: "Meme",
  WLD: "AI", FET: "AI", RENDER: "AI", TAO: "AI", AI16Z: "AI", VIRTUAL: "AI", GRIFFAIN: "AI", ARC: "AI",
  FIL: "Infra", AR: "Infra", GRT: "Infra", PYTH: "Infra", W: "Infra", JTO: "Infra", ICP: "Infra",
  STX: "Infra", IMX: "Infra", GALA: "Gaming", SAND: "Gaming", AXS: "Gaming", APE: "Gaming",
};
// Every branch now also carries `ind`, the industry group. For anything without a curated
// industry (crypto sub-sectors, indices, FX, commodities, unsplit equities) ind === sector —
// the fallback is part of the contract, so a consumer can always group on `ind` safely.
function classify(ticker, uni) {
  if (uni === "main") {
    const T = String(ticker || "").toUpperCase();
    const sec = CRYPTO_SECTORS[T] || "Other";
    return { assetClass: "Crypto", sector: sec, ind: sec };   // crypto sectors ARE the fine grouping
  }
  const T = norm(ticker), Td = T.replace(/\./g, "");
  if (EQ[T]) return { assetClass: "Equity", sector: EQ[T], ind: indOf(T, Td, EQ[T]) };
  if (EQ[Td]) return { assetClass: "Equity", sector: EQ[Td], ind: indOf(T, Td, EQ[Td]) };
  const ov = OVERLAY.get(T) || OVERLAY.get(Td);
  // Graduation outranks the PREIPO row it supersedes — that is its entire job. The curated
  // industry group (indOf) still applies if one exists; the overlay's ind is only the fallback.
  if (ov && ov.action === "graduate") { const ci = indOf(T, Td, null);
    return { assetClass: "Equity", sector: ov.sector, ind: ci || (ov.ind !== ov.sector ? ov.ind : ov.sector), auto: "grad" }; }
  if (PREIPO[T]) return { assetClass: "Pre-IPO", sector: PREIPO[T], ind: indOf(T, Td, PREIPO[T]) };
  if (THEMATIC.has(T)) return { assetClass: "Thematic", sector: "Thematic", ind: indOf(T, Td, "Thematic") };
  if (SECTOR_ETF[T]) return { assetClass: "ETF", sector: SECTOR_ETF[T], ind: indOf(T, Td, SECTOR_ETF[T]) };
  if (REGION_ETF.has(T)) return { assetClass: "ETF", sector: "Index", ind: "Index" };
  if (INDEX.has(T) || INDEX.has(Td)) return { assetClass: "Index", sector: "Index", ind: "Index" };
  if (CRYPTO.has(T) || CRYPTO.has(Td)) return { assetClass: "Crypto", sector: "Crypto", ind: "Crypto" };
  if (COMMOD.has(T) || COMMOD.has(Td)) return { assetClass: "Commodity", sector: "Commodity", ind: "Commodity" };
  if (FX.has(T) || FX.has(Td)) return { assetClass: "FX", sector: "FX", ind: "FX" };
  if (/^[A-Z]{6}$/.test(Td)) { const a = Td.slice(0, 3), b = Td.slice(3); if (CCY.has(a) && CCY.has(b)) return { assetClass: "FX", sector: "FX", ind: "FX" }; }
  if (CCY.has(Td)) return { assetClass: "FX", sector: "FX", ind: "FX" };
  // Overlay "classify" entries fill ONLY here — every static table above already declined.
  if (ov) return { assetClass: "Equity", sector: ov.sector, ind: ov.ind !== ov.sector ? ov.ind : ov.sector, auto: "cls" };
  return { assetClass: "Unclassified", sector: "Unclassified", ind: "Unclassified" };
}

// Company-name aliases for news relevance gating: a headline fetched under ticker T is only
// ATTRIBUTED to T if it actually mentions the company (symbol as a word, or any alias,
// case-insensitive). Seeded for the names most likely to appear in headlines; anything
// unseeded gets AI-learned aliases at runtime (write-once, persisted) — this table is the
// deterministic floor, not the ceiling. Aliases are substrings, so "Apple" covers
// "Apple Inc." and "Apple's".
const COMPANY_NAMES = {
  AAPL:["Apple"], MSFT:["Microsoft"], NVDA:["Nvidia"], AMZN:["Amazon"], GOOGL:["Google","Alphabet"], GOOG:["Google","Alphabet"],
  META:["Meta","Facebook","Instagram"], TSLA:["Tesla"], NFLX:["Netflix"], AMD:["AMD","Advanced Micro"], INTC:["Intel"],
  MU:["Micron"], AVGO:["Broadcom"], QCOM:["Qualcomm"], TXN:["Texas Instruments"], ORCL:["Oracle"], CRM:["Salesforce"],
  ADBE:["Adobe"], IBM:["IBM"], CSCO:["Cisco"], NOW:["ServiceNow"], PLTR:["Palantir"], SNOW:["Snowflake"], CRWD:["CrowdStrike"],
  DDOG:["Datadog"], NET:["Cloudflare"], PANW:["Palo Alto"], ANET:["Arista"], MRVL:["Marvell"], SMCI:["Super Micro"],
  WDC:["Western Digital"], STX:["Seagate"], SNDK:["Sandisk","SanDisk"], DELL:["Dell"], HPQ:["HP Inc","Hewlett"],
  TSM:["TSMC","Taiwan Semi"], ASML:["ASML"], ARM:["Arm Holdings"], MSTR:["MicroStrategy","Strategy Inc","Strategy Pads","Michael Saylor"],
  CRWV:["CoreWeave"], NBIS:["Nebius"], SKHX:["SK Hynix","SK hynix"], SMSN:["Samsung"], KIOXIA:["Kioxia"], IBIDEN:["Ibiden"],
  ZHIPU:["Zhipu"], MINIMAX:["MiniMax"], BABA:["Alibaba"], SOFTBANK:["SoftBank"], HYUNDAI:["Hyundai"], GME:["GameStop"],
  COIN:["Coinbase"], HOOD:["Robinhood"], PYPL:["PayPal"], SQ:["Block Inc","Square"], BX:["Blackstone"], CRCL:["Circle"],
  JPM:["JPMorgan","JP Morgan"], GS:["Goldman"], MS:["Morgan Stanley"], BAC:["Bank of America"], WFC:["Wells Fargo"],
  V:["Visa"], MA:["Mastercard"], AXP:["American Express"], BLK:["BlackRock"], SCHW:["Schwab"],
  DIS:["Disney"], CMCSA:["Comcast"], TMUS:["T-Mobile"], VZ:["Verizon"], SPOT:["Spotify"], RBLX:["Roblox"], SNAP:["Snap "],
  UNH:["UnitedHealth"], LLY:["Eli Lilly","Lilly"], PFE:["Pfizer"], JNJ:["Johnson & Johnson"], MRK:["Merck"], MRNA:["Moderna"],
  ABBV:["AbbVie"], HIMS:["Hims"], XOM:["Exxon"], CVX:["Chevron"], COP:["ConocoPhillips"], SLB:["Schlumberger","SLB"],
  OXY:["Occidental"], LNG:["Cheniere"], CAT:["Caterpillar"], BA:["Boeing"], GE:["GE Aerospace","General Electric"],
  LMT:["Lockheed"], RTX:["RTX","Raytheon"], NOC:["Northrop"], DE:["Deere"], UPS:["UPS"], FDX:["FedEx"],
  RKLB:["Rocket Lab"], BE:["Bloom Energy"], SPCX:["SpaceX","Space Exploration Technologies"], WMT:["Walmart"], COST:["Costco"], TGT:["Target"], KO:["Coca-Cola"],
  PEP:["Pepsi"], PG:["Procter"], MCD:["McDonald"], SBUX:["Starbucks"], NKE:["Nike"], HD:["Home Depot"], LOW:["Lowe's"],
  BKNG:["Booking"], ABNB:["Airbnb"], MAR:["Marriott"], RIVN:["Rivian"], LCID:["Lucid"], F:["Ford"], GM:["General Motors"],
  NEE:["NextEra"], DUK:["Duke Energy"], VST:["Vistra"], NRG:["NRG"], FCX:["Freeport"], NEM:["Newmont"], NUE:["Nucor"],
  ALB:["Albemarle"], LIN:["Linde"], PLD:["Prologis"], AMT:["American Tower"], EQIX:["Equinix"], SPG:["Simon Property"],
};
function nameAliases(t) { return COMPANY_NAMES[String(t || "").toUpperCase()] || null; }
// Canonical display name for the analyst context: the first alias is the common name
// ("Nvidia", "Apple"). Unseeded tickers return null — the ticker itself stays the label.
function companyName(t) { const a = COMPANY_NAMES[String(t || "").toUpperCase()]; return (a && a[0]) || null; }

// ---- display names (build 2026.07.28-03) ------------------------------------------------------
// The human-readable name behind a ticker, for the drawer head, the report head and the board
// tooltip. DELIBERATELY separate from COMPANY_NAMES: those are match FRAGMENTS tuned for headline
// substring hits ("Snap ", "HP Inc", "Procter") and reading them as labels would put fragments on
// screen. This table is a label table — one canonical string per ticker, hand-seeded, never AI-
// filled. Unseeded tickers return null and the ticker stands alone: a wrong name is worse than
// no name, and there is no confident-sounding guess available here.
const DISPLAY_NAMES = {
  AAPL:"Apple Inc.", MSFT:"Microsoft Corp.", NVDA:"NVIDIA Corp.", AMZN:"Amazon.com Inc.",
  GOOGL:"Alphabet Inc. (class A)", GOOG:"Alphabet Inc. (class C)", META:"Meta Platforms Inc.",
  TSLA:"Tesla Inc.", NFLX:"Netflix Inc.", AMD:"Advanced Micro Devices", INTC:"Intel Corp.",
  MU:"Micron Technology", AVGO:"Broadcom Inc.", QCOM:"Qualcomm Inc.", TXN:"Texas Instruments",
  ORCL:"Oracle Corp.", CRM:"Salesforce Inc.", ADBE:"Adobe Inc.", IBM:"IBM Corp.", CSCO:"Cisco Systems",
  NOW:"ServiceNow Inc.", INTU:"Intuit Inc.", AMAT:"Applied Materials", ADI:"Analog Devices",
  LRCX:"Lam Research", KLAC:"KLA Corp.", SNPS:"Synopsys Inc.", CDNS:"Cadence Design Systems",
  PANW:"Palo Alto Networks", ANET:"Arista Networks", MRVL:"Marvell Technology", FTNT:"Fortinet Inc.",
  ON:"ON Semiconductor", DELL:"Dell Technologies", HPQ:"HP Inc.", HPE:"Hewlett Packard Enterprise",
  NXPI:"NXP Semiconductors", MCHP:"Microchip Technology", GLW:"Corning Inc.", SMCI:"Super Micro Computer",
  WDC:"Western Digital", STX:"Seagate Technology", ZS:"Zscaler Inc.", CRWD:"CrowdStrike Holdings",
  DDOG:"Datadog Inc.", SNOW:"Snowflake Inc.", NET:"Cloudflare Inc.", PLTR:"Palantir Technologies",
  TEAM:"Atlassian Corp.", WDAY:"Workday Inc.", ADSK:"Autodesk Inc.", APH:"Amphenol Corp.",
  MPWR:"Monolithic Power Systems", FSLR:"First Solar", KEYS:"Keysight Technologies", ACN:"Accenture plc",
  TER:"Teradyne Inc.", TSM:"Taiwan Semiconductor (TSMC)", ASML:"ASML Holding", ARM:"Arm Holdings",
  MSTR:"Strategy Inc. (MicroStrategy)", NBIS:"Nebius Group", CRWV:"CoreWeave Inc.", LITE:"Lumentum Holdings",
  SNDK:"SanDisk Corp.", SKHX:"SK hynix", SMSN:"Samsung Electronics", KIOXIA:"Kioxia Holdings",
  IBIDEN:"Ibiden Co.", ZHIPU:"Zhipu AI", MINIMAX:"MiniMax AI", CBRS:"Cerebras Systems", BB:"BlackBerry Ltd.",
  DIS:"Walt Disney Co.", CMCSA:"Comcast Corp.", T:"AT&T Inc.", VZ:"Verizon Communications",
  TMUS:"T-Mobile US", CHTR:"Charter Communications", EA:"Electronic Arts", TTWO:"Take-Two Interactive",
  WBD:"Warner Bros. Discovery", PINS:"Pinterest Inc.", SNAP:"Snap Inc.", RBLX:"Roblox Corp.",
  SPOT:"Spotify Technology", ROKU:"Roku Inc.", ZM:"Zoom Communications", PARA:"Paramount",
  SOFTBANK:"SoftBank Group", HD:"Home Depot", MCD:"McDonald's Corp.", NKE:"Nike Inc.", LOW:"Lowe's Companies",
  SBUX:"Starbucks Corp.", BKNG:"Booking Holdings", TJX:"TJX Companies", CMG:"Chipotle Mexican Grill",
  MAR:"Marriott International", GM:"General Motors", F:"Ford Motor Co.", LULU:"Lululemon Athletica",
  EBAY:"eBay Inc.", ABNB:"Airbnb Inc.", RCL:"Royal Caribbean", CCL:"Carnival Corp.", EXPE:"Expedia Group",
  RIVN:"Rivian Automotive", LCID:"Lucid Group", DKNG:"DraftKings Inc.", ULTA:"Ulta Beauty",
  LVS:"Las Vegas Sands", WYNN:"Wynn Resorts", MGM:"MGM Resorts", BABA:"Alibaba Group", GME:"GameStop Corp.",
  HYUNDAI:"Hyundai Motor", BIRD:"Allbirds Inc.",
  PG:"Procter & Gamble", KO:"Coca-Cola Co.", PEP:"PepsiCo Inc.", COST:"Costco Wholesale",
  WMT:"Walmart Inc.", PM:"Philip Morris International", MO:"Altria Group", MDLZ:"Mondelez International",
  TGT:"Target Corp.", KHC:"Kraft Heinz", STZ:"Constellation Brands", KDP:"Keurig Dr Pepper",
  MNST:"Monster Beverage", HSY:"Hershey Co.", KR:"Kroger Co.", EL:"Estee Lauder", KVUE:"Kenvue Inc.",
  UNH:"UnitedHealth Group", JNJ:"Johnson & Johnson", LLY:"Eli Lilly and Co.", ABBV:"AbbVie Inc.",
  MRK:"Merck & Co.", PFE:"Pfizer Inc.", TMO:"Thermo Fisher Scientific", ABT:"Abbott Laboratories",
  DHR:"Danaher Corp.", AMGN:"Amgen Inc.", BMY:"Bristol Myers Squibb", GILD:"Gilead Sciences",
  CVS:"CVS Health", MDT:"Medtronic plc", ISRG:"Intuitive Surgical", VRTX:"Vertex Pharmaceuticals",
  REGN:"Regeneron Pharmaceuticals", BSX:"Boston Scientific", HCA:"HCA Healthcare", SYK:"Stryker Corp.",
  HUM:"Humana Inc.", MRNA:"Moderna Inc.", BIIB:"Biogen Inc.", DXCM:"DexCom Inc.", GEHC:"GE HealthCare",
  HIMS:"Hims & Hers Health",
  "BRK.B":"Berkshire Hathaway (class B)", BRKB:"Berkshire Hathaway (class B)", JPM:"JPMorgan Chase",
  V:"Visa Inc.", MA:"Mastercard Inc.", BAC:"Bank of America", WFC:"Wells Fargo", GS:"Goldman Sachs",
  MS:"Morgan Stanley", SPGI:"S&P Global", AXP:"American Express", BLK:"BlackRock Inc.", C:"Citigroup Inc.",
  SCHW:"Charles Schwab", PGR:"Progressive Corp.", ICE:"Intercontinental Exchange", CME:"CME Group",
  COF:"Capital One Financial", MSCI:"MSCI Inc.", PYPL:"PayPal Holdings", SQ:"Block Inc.",
  COIN:"Coinbase Global", HOOD:"Robinhood Markets", MCO:"Moody's Corp.", NDAQ:"Nasdaq Inc.",
  CRCL:"Circle Internet Group", BX:"Blackstone Inc.", STRC:"Strategy preferred (STRC)",
  CAT:"Caterpillar Inc.", HON:"Honeywell International", UPS:"United Parcel Service", BA:"Boeing Co.",
  GE:"GE Aerospace", RTX:"RTX Corp.", UNP:"Union Pacific", DE:"Deere & Co.", LMT:"Lockheed Martin",
  GD:"General Dynamics", NOC:"Northrop Grumman", ETN:"Eaton Corp.", MMM:"3M Co.", CSX:"CSX Corp.",
  FDX:"FedEx Corp.", NSC:"Norfolk Southern", GEV:"GE Vernova", TDG:"TransDigm Group", PCAR:"PACCAR Inc.",
  LUV:"Southwest Airlines", DAL:"Delta Air Lines", UAL:"United Airlines", AAL:"American Airlines",
  LHX:"L3Harris Technologies", RKLB:"Rocket Lab", BE:"Bloom Energy", SPCX:"SpaceX (Space Exploration Technologies)",
  XOM:"Exxon Mobil", CVX:"Chevron Corp.", COP:"ConocoPhillips", SLB:"SLB (Schlumberger)",
  EOG:"EOG Resources", MPC:"Marathon Petroleum", PSX:"Phillips 66", VLO:"Valero Energy",
  OXY:"Occidental Petroleum", HAL:"Halliburton Co.", FANG:"Diamondback Energy", EQT:"EQT Corp.",
  LNG:"Cheniere Energy",
  LIN:"Linde plc", APD:"Air Products", SHW:"Sherwin-Williams", FCX:"Freeport-McMoRan", NEM:"Newmont Corp.",
  DOW:"Dow Inc.", NUE:"Nucor Corp.", ALB:"Albemarle Corp.", USAR:"USA Rare Earth",
  NEE:"NextEra Energy", DUK:"Duke Energy", SO:"Southern Co.", VST:"Vistra Corp.", NRG:"NRG Energy",
  PLD:"Prologis Inc.", AMT:"American Tower", EQIX:"Equinix Inc.", CCI:"Crown Castle", SPG:"Simon Property Group",
  // pre-IPO synthetics: the perp tracks an implied private valuation, and the label says so
  OPENAI:"OpenAI (pre-IPO synthetic)", ANTHROPIC:"Anthropic (pre-IPO synthetic)",
  CURSOR:"Cursor / Anysphere (pre-IPO synthetic)", XAI:"xAI (pre-IPO synthetic)", DATABRICKS:"Databricks (pre-IPO synthetic)",
  STRIPE:"Stripe (pre-IPO synthetic)", REVOLUT:"Revolut (pre-IPO synthetic)", DISCORD:"Discord (pre-IPO synthetic)",
  CANVA:"Canva (pre-IPO synthetic)", RAMP:"Ramp (pre-IPO synthetic)", ANDURIL:"Anduril (pre-IPO synthetic)",
  FIGURE:"Figure (pre-IPO synthetic)",
  // thematic price indices — no single issuer, so the label names the basket
  DRAM:"DRAM spot price index", H100:"H100 GPU price index", GPU:"GPU price index", HBM:"HBM memory index",
  WAFER:"Silicon wafer price index", COMPUTE:"Compute cost index", NAND:"NAND flash price index",
  MEMORY:"Memory price index", BOT:"Robotics basket index",
  // ETFs
  SPY:"SPDR S&P 500 ETF", VOO:"Vanguard S&P 500 ETF", QQQ:"Invesco QQQ (Nasdaq-100) ETF",
  IWM:"iShares Russell 2000 ETF", DIA:"SPDR Dow Jones Industrial Average ETF",
  EWZ:"iShares MSCI Brazil ETF", EWY:"iShares MSCI South Korea ETF", EWJ:"iShares MSCI Japan ETF",
  EWT:"iShares MSCI Taiwan ETF", EWG:"iShares MSCI Germany ETF", EWU:"iShares MSCI United Kingdom ETF",
  EWH:"iShares MSCI Hong Kong ETF", EWA:"iShares MSCI Australia ETF", EWW:"iShares MSCI Mexico ETF",
  EWC:"iShares MSCI Canada ETF", FXI:"iShares China Large-Cap ETF", MCHI:"iShares MSCI China ETF",
  INDA:"iShares MSCI India ETF", EEM:"iShares MSCI Emerging Markets ETF", VEA:"Vanguard Developed Markets ETF",
  VWO:"Vanguard Emerging Markets ETF", XLE:"Energy Select Sector SPDR", XOP:"SPDR Oil & Gas Exploration ETF",
  SMH:"VanEck Semiconductor ETF", SOXX:"iShares Semiconductor ETF", XLK:"Technology Select Sector SPDR",
  XLF:"Financial Select Sector SPDR", XLV:"Health Care Select Sector SPDR", XLI:"Industrial Select Sector SPDR",
  XLP:"Consumer Staples Select Sector SPDR", XLY:"Consumer Discretionary Select Sector SPDR",
  XLB:"Materials Select Sector SPDR", XLU:"Utilities Select Sector SPDR", XLRE:"Real Estate Select Sector SPDR",
  XLC:"Communication Services Select Sector SPDR", URNM:"Sprott Uranium Miners ETF", URA:"Global X Uranium ETF",
  // indices
  SPX:"S&P 500 index", SP500:"S&P 500 index", US500:"S&P 500 index", ES:"S&P 500 futures",
  NDX:"Nasdaq-100 index", NAS100:"Nasdaq-100 index", US100:"Nasdaq-100 index", NQ:"Nasdaq-100 futures",
  DJI:"Dow Jones Industrial Average", US30:"Dow Jones Industrial Average", DOW:"Dow Jones Industrial Average",
  RUT:"Russell 2000 index", US2000:"Russell 2000 index", VIX:"CBOE volatility index (VIX)",
  FTSE:"FTSE 100 index", UK100:"FTSE 100 index", DAX:"DAX 40 index", DE40:"DAX 40 index",
  NIKKEI:"Nikkei 225 index", N225:"Nikkei 225 index", JP225:"Nikkei 225 index", HSI:"Hang Seng index",
  HK50:"Hang Seng index", CAC:"CAC 40 index", CAC40:"CAC 40 index", ESTX50:"Euro Stoxx 50 index",
  ASX200:"S&P/ASX 200 index", KOSPI:"KOSPI index", NIFTY:"Nifty 50 index", NIFTY50:"Nifty 50 index",
  IBOV:"Ibovespa index", BOVESPA:"Ibovespa index", XYZ100:"XYZ100 dex index",
  // commodities
  XAU:"Gold (spot, USD/oz)", GOLD:"Gold (spot, USD/oz)", XAUUSD:"Gold (spot, USD/oz)",
  XAG:"Silver (spot, USD/oz)", SILVER:"Silver (spot, USD/oz)", XAGUSD:"Silver (spot, USD/oz)",
  CL:"WTI crude oil", WTI:"WTI crude oil", OIL:"WTI crude oil", USOIL:"WTI crude oil", CRUDE:"WTI crude oil",
  BRENT:"Brent crude oil", UKOIL:"Brent crude oil", NATGAS:"Natural gas (Henry Hub)", NG:"Natural gas (Henry Hub)",
  TTF:"Dutch TTF natural gas", COPPER:"Copper", HG:"Copper futures", XPT:"Platinum (spot)",
  PLATINUM:"Platinum (spot)", XPD:"Palladium (spot)", PALLADIUM:"Palladium (spot)", URANIUM:"Uranium (U3O8)",
  ALUMINIUM:"Aluminium", ALUMINUM:"Aluminium", CORN:"Corn", WHEAT:"Wheat", SOYBEAN:"Soybeans",
  SOYBEANS:"Soybeans", COCOA:"Cocoa", COFFEE:"Coffee", SUGAR:"Sugar", COTTON:"Cotton",
  // FX — bare currency codes quote against USD on this dex; pairs name both legs
  JPY:"Japanese yen", EUR:"Euro", GBP:"British pound", CHF:"Swiss franc", AUD:"Australian dollar",
  CAD:"Canadian dollar", NZD:"New Zealand dollar", CNH:"Chinese yuan (offshore)", CNY:"Chinese yuan",
  MXN:"Mexican peso", ZAR:"South African rand", TRY:"Turkish lira", SGD:"Singapore dollar",
  HKD:"Hong Kong dollar", SEK:"Swedish krona", NOK:"Norwegian krone", DKK:"Danish krone",
  PLN:"Polish zloty", KRW:"South Korean won", INR:"Indian rupee", BRL:"Brazilian real", USD:"US dollar",
  DXY:"US dollar index (DXY)", USDX:"US dollar index (DXY)",
  EURUSD:"Euro / US dollar", GBPUSD:"British pound / US dollar", USDJPY:"US dollar / Japanese yen",
  USDCHF:"US dollar / Swiss franc", AUDUSD:"Australian dollar / US dollar", USDCAD:"US dollar / Canadian dollar",
  NZDUSD:"New Zealand dollar / US dollar", EURGBP:"Euro / British pound", EURJPY:"Euro / Japanese yen",
  GBPJPY:"British pound / Japanese yen", USDCNH:"US dollar / offshore yuan", USDMXN:"US dollar / Mexican peso",
  USDTRY:"US dollar / Turkish lira",
};
// Main-dex coin names. Same rule: seeded or null, never derived from the symbol.
const CRYPTO_NAMES = {
  BTC:"Bitcoin", ETH:"Ethereum", SOL:"Solana", XRP:"XRP (Ripple)", BNB:"BNB Chain", DOGE:"Dogecoin",
  ADA:"Cardano", AVAX:"Avalanche", SUI:"Sui", APT:"Aptos", SEI:"Sei", TIA:"Celestia", NEAR:"NEAR Protocol",
  TON:"Toncoin", DOT:"Polkadot", ATOM:"Cosmos", TRX:"TRON", LTC:"Litecoin", BCH:"Bitcoin Cash",
  ETC:"Ethereum Classic", KAS:"Kaspa", INJ:"Injective", ARB:"Arbitrum", OP:"Optimism", STRK:"Starknet",
  ZK:"zkSync", BLAST:"Blast", MNT:"Mantle", POL:"Polygon (POL)", MATIC:"Polygon (legacy MATIC)",
  HYPE:"Hyperliquid", LINK:"Chainlink", UNI:"Uniswap", AAVE:"Aave", MKR:"Maker", CRV:"Curve DAO",
  LDO:"Lido DAO", ENA:"Ethena", PENDLE:"Pendle", JUP:"Jupiter", DYDX:"dYdX", GMX:"GMX", SNX:"Synthetix",
  COMP:"Compound", ONDO:"Ondo Finance", EIGEN:"EigenLayer", ETHFI:"ether.fi", MORPHO:"Morpho", AERO:"Aerodrome",
  WIF:"dogwifhat", PEPE:"Pepe", BONK:"Bonk", SHIB:"Shiba Inu", FLOKI:"Floki", POPCAT:"Popcat", MEW:"cat in a dogs world",
  BRETT:"Brett", MOODENG:"Moo Deng", PNUT:"Peanut the Squirrel", FARTCOIN:"Fartcoin", SPX:"SPX6900",
  GOAT:"Goatseus Maximus", TRUMP:"OFFICIAL TRUMP", MELANIA:"Melania Meme", NEIRO:"Neiro",
  WLD:"Worldcoin", FET:"Artificial Superintelligence Alliance", RENDER:"Render", TAO:"Bittensor",
  AI16Z:"ai16z", VIRTUAL:"Virtuals Protocol", FIL:"Filecoin", AR:"Arweave", GRT:"The Graph", PYTH:"Pyth Network",
  W:"Wormhole", JTO:"Jito", ICP:"Internet Computer", STX:"Stacks", IMX:"Immutable", GALA:"Gala",
  SAND:"The Sandbox", AXS:"Axie Infinity", APE:"ApeCoin", PURR:"Purr", ORDI:"ORDI", QNT:"Quant",
};
function displayName(t, uni) {
  const T = String(t || "").toUpperCase();
  if (!T) return null;
  if (uni === "main") return CRYPTO_NAMES[T] || null;
  return DISPLAY_NAMES[T] || DISPLAY_NAMES[T.replace(/\./g, "")] || null;
}

// ---- macro news lanes (build 2026.07.28-03) ---------------------------------------------------
// The drawer used to fill EVERY non-equity name with the raw general tape, so a Brazil ETF and the
// yen showed the same five items — a Seagate earnings print and a Medicare headline — under a
// "macro tape" label. Honest label, filler content: the one place in the news pipeline with no
// relevance gate at all. A macro instrument now declares WHICH topics are its news, and the tape
// is gated on them by the same word-boundary matcher the company lane uses.
//   broad:true = the general tape IS this instrument's news (the S&P, the VIX, the dollar index).
//   topics     = word-boundary keys; a tape item matches the name only if it names one of them.
//   absent     = no lane at all. The drawer then says "no headlines", exactly like an equity.
// Keys are chosen to be unambiguous in a headline. Deliberately NOT included: bare currency words
// that read as prose ("real" for BRL), and metals whose names are common adjectives ("gold" is
// kept, "copper" is kept — both are overwhelmingly the commodity in a financial tape, and a false
// positive here costs one wrong row, not a wrong signal).
const MACRO_LANES = {
  SP500:{broad:true}, SPX:{broad:true}, US500:{broad:true}, ES:{broad:true}, SPY:{broad:true},
  VOO:{broad:true}, XYZ100:{broad:true}, VIX:{broad:true}, DXY:{broad:true}, USDX:{broad:true}, USD:{broad:true},
  NDX:{label:"Nasdaq",topics:["Nasdaq","Nasdaq-100","tech stocks","megacap","mega-cap"]},
  NAS100:{label:"Nasdaq",topics:["Nasdaq","Nasdaq-100","tech stocks","megacap","mega-cap"]},
  US100:{label:"Nasdaq",topics:["Nasdaq","Nasdaq-100","tech stocks","megacap","mega-cap"]},
  QQQ:{label:"Nasdaq",topics:["Nasdaq","Nasdaq-100","tech stocks","megacap","mega-cap"]},
  DJI:{label:"Dow",topics:["Dow Jones","Dow industrials"]}, US30:{label:"Dow",topics:["Dow Jones","Dow industrials"]},
  DIA:{label:"Dow",topics:["Dow Jones","Dow industrials"]},
  RUT:{label:"small caps",topics:["Russell 2000","Russell","small caps","small-cap"]},
  US2000:{label:"small caps",topics:["Russell 2000","Russell","small caps","small-cap"]},
  IWM:{label:"small caps",topics:["Russell 2000","Russell","small caps","small-cap"]},
  EWZ:{label:"Brazil",topics:["Brazil","Brazilian","Bovespa","Ibovespa","BRL","Lula","Petrobras","Vale","Copom","Selic","B3"]},
  EWW:{label:"Mexico",topics:["Mexico","Mexican","peso","MXN","Banxico","Sheinbaum","Pemex"]},
  EWJ:{label:"Japan",topics:["Japan","Japanese","Nikkei","yen","JPY","Bank of Japan","BoJ","BOJ","Topix"]},
  EWY:{label:"South Korea",topics:["Korea","Korean","KOSPI","won","Bank of Korea","Samsung","SK hynix"]},
  EWT:{label:"Taiwan",topics:["Taiwan","Taiwanese","TSMC","TAIEX","Taipei"]},
  EWG:{label:"Germany",topics:["Germany","German","DAX","Bundesbank","Berlin","Frankfurt"]},
  EWU:{label:"United Kingdom",topics:["Britain","British","UK","FTSE","Bank of England","BoE","sterling","gilt","gilts"]},
  EWH:{label:"Hong Kong",topics:["Hong Kong","Hang Seng","HKMA"]},
  EWA:{label:"Australia",topics:["Australia","Australian","ASX","RBA","Aussie dollar"]},
  EWC:{label:"Canada",topics:["Canada","Canadian","TSX","Bank of Canada","loonie"]},
  FXI:{label:"China",topics:["China","Chinese","Beijing","PBOC","Hang Seng","CSI 300","yuan","renminbi"]},
  MCHI:{label:"China",topics:["China","Chinese","Beijing","PBOC","Hang Seng","CSI 300","yuan","renminbi"]},
  INDA:{label:"India",topics:["India","Indian","Nifty","Sensex","RBI","rupee","Mumbai"]},
  EEM:{label:"emerging markets",topics:["emerging markets","emerging-market","EM equities","EM currencies"]},
  VWO:{label:"emerging markets",topics:["emerging markets","emerging-market","EM equities","EM currencies"]},
  VEA:{label:"developed markets",topics:["developed markets","ex-US equities","international equities"]},
  NIKKEI:{label:"Japan",topics:["Japan","Japanese","Nikkei","yen","Bank of Japan","BoJ","BOJ","Topix"]},
  N225:{label:"Japan",topics:["Japan","Japanese","Nikkei","yen","Bank of Japan","BoJ","BOJ","Topix"]},
  JP225:{label:"Japan",topics:["Japan","Japanese","Nikkei","yen","Bank of Japan","BoJ","BOJ","Topix"]},
  HSI:{label:"Hong Kong",topics:["Hong Kong","Hang Seng","China","Chinese","Beijing","HKMA"]},
  HK50:{label:"Hong Kong",topics:["Hong Kong","Hang Seng","China","Chinese","Beijing","HKMA"]},
  DAX:{label:"Germany",topics:["Germany","German","DAX","Bundesbank","ECB"]},
  DE40:{label:"Germany",topics:["Germany","German","DAX","Bundesbank","ECB"]},
  FTSE:{label:"United Kingdom",topics:["Britain","British","UK","FTSE","Bank of England","BoE","sterling","gilt"]},
  UK100:{label:"United Kingdom",topics:["Britain","British","UK","FTSE","Bank of England","BoE","sterling","gilt"]},
  CAC:{label:"France",topics:["France","French","CAC","Paris","ECB"]}, CAC40:{label:"France",topics:["France","French","CAC","Paris","ECB"]},
  ESTX50:{label:"eurozone",topics:["eurozone","euro zone","ECB","Euro Stoxx","European stocks"]},
  ASX200:{label:"Australia",topics:["Australia","Australian","ASX","RBA"]},
  KOSPI:{label:"South Korea",topics:["Korea","Korean","KOSPI","won","Bank of Korea"]},
  NIFTY:{label:"India",topics:["India","Indian","Nifty","Sensex","RBI","rupee"]},
  NIFTY50:{label:"India",topics:["India","Indian","Nifty","Sensex","RBI","rupee"]},
  IBOV:{label:"Brazil",topics:["Brazil","Brazilian","Bovespa","Ibovespa","Lula","Copom","Selic","Petrobras"]},
  BOVESPA:{label:"Brazil",topics:["Brazil","Brazilian","Bovespa","Ibovespa","Lula","Copom","Selic","Petrobras"]},
  JPY:{label:"Japan",topics:["yen","JPY","Japan","Japanese","Bank of Japan","BoJ","BOJ","Ueda","Nikkei"]},
  USDJPY:{label:"Japan",topics:["yen","JPY","Japan","Japanese","Bank of Japan","BoJ","BOJ","Ueda"]},
  EUR:{label:"euro",topics:["euro","EUR","ECB","eurozone","euro zone","Lagarde"]},
  EURUSD:{label:"euro",topics:["euro","EUR","ECB","eurozone","euro zone","Lagarde"]},
  GBP:{label:"sterling",topics:["sterling","pound","GBP","Bank of England","BoE","Britain","British","gilt"]},
  GBPUSD:{label:"sterling",topics:["sterling","pound","GBP","Bank of England","BoE","Britain","British","gilt"]},
  CHF:{label:"Swiss franc",topics:["franc","CHF","Swiss","Switzerland","SNB"]},
  AUD:{label:"Australian dollar",topics:["Aussie","AUD","Australia","Australian","RBA"]},
  CAD:{label:"Canadian dollar",topics:["loonie","CAD","Canada","Canadian","Bank of Canada"]},
  NZD:{label:"New Zealand dollar",topics:["kiwi","NZD","New Zealand","RBNZ"]},
  CNH:{label:"yuan",topics:["yuan","renminbi","CNH","CNY","China","Chinese","PBOC","Beijing"]},
  CNY:{label:"yuan",topics:["yuan","renminbi","CNH","CNY","China","Chinese","PBOC","Beijing"]},
  MXN:{label:"Mexican peso",topics:["peso","MXN","Mexico","Mexican","Banxico"]},
  BRL:{label:"Brazilian real",topics:["BRL","Brazil","Brazilian","Copom","Selic","Lula"]},
  TRY:{label:"Turkish lira",topics:["lira","TRY","Turkey","Turkish","Erdogan","CBRT"]},
  ZAR:{label:"South African rand",topics:["rand","ZAR","South Africa","SARB"]},
  KRW:{label:"Korean won",topics:["won","KRW","Korea","Korean","Bank of Korea"]},
  INR:{label:"Indian rupee",topics:["rupee","INR","India","Indian","RBI"]},
  SEK:{label:"Swedish krona",topics:["krona","SEK","Sweden","Riksbank"]},
  NOK:{label:"Norwegian krone",topics:["krone","NOK","Norway","Norges Bank"]},
  XAU:{label:"gold",topics:["gold","bullion","XAU","precious metals"]},
  GOLD:{label:"gold",topics:["gold","bullion","XAU","precious metals"]},
  XAG:{label:"silver",topics:["silver","XAG","precious metals"]},
  SILVER:{label:"silver",topics:["silver","XAG","precious metals"]},
  CL:{label:"crude oil",topics:["crude","oil","WTI","Brent","OPEC","OPEC+","barrel","petroleum","refinery"]},
  WTI:{label:"crude oil",topics:["crude","oil","WTI","Brent","OPEC","OPEC+","barrel","petroleum"]},
  OIL:{label:"crude oil",topics:["crude","oil","WTI","Brent","OPEC","OPEC+","barrel","petroleum"]},
  USOIL:{label:"crude oil",topics:["crude","oil","WTI","Brent","OPEC","OPEC+","barrel","petroleum"]},
  BRENT:{label:"crude oil",topics:["crude","oil","Brent","WTI","OPEC","OPEC+","barrel","petroleum"]},
  UKOIL:{label:"crude oil",topics:["crude","oil","Brent","WTI","OPEC","OPEC+","barrel","petroleum"]},
  NATGAS:{label:"natural gas",topics:["natural gas","natgas","LNG","Henry Hub","gas prices"]},
  NG:{label:"natural gas",topics:["natural gas","natgas","LNG","Henry Hub","gas prices"]},
  TTF:{label:"European gas",topics:["natural gas","TTF","LNG","Europe gas","European gas","Gazprom"]},
  COPPER:{label:"copper",topics:["copper","base metals","Codelco","LME"]},
  HG:{label:"copper",topics:["copper","base metals","Codelco","LME"]},
  XPT:{label:"platinum",topics:["platinum","precious metals","PGM"]}, PLATINUM:{label:"platinum",topics:["platinum","precious metals","PGM"]},
  XPD:{label:"palladium",topics:["palladium","precious metals","PGM"]}, PALLADIUM:{label:"palladium",topics:["palladium","precious metals","PGM"]},
  URANIUM:{label:"uranium",topics:["uranium","nuclear","enrichment","Cameco","U3O8"]},
  URA:{label:"uranium",topics:["uranium","nuclear","enrichment","Cameco","U3O8"]},
  URNM:{label:"uranium",topics:["uranium","nuclear","enrichment","Cameco","U3O8"]},
  ALUMINIUM:{label:"aluminium",topics:["aluminium","aluminum","Alcoa","LME","base metals"]},
  ALUMINUM:{label:"aluminium",topics:["aluminium","aluminum","Alcoa","LME","base metals"]},
  CORN:{label:"corn",topics:["corn","grain","USDA","ethanol"]}, WHEAT:{label:"wheat",topics:["wheat","grain","USDA","Black Sea"]},
  SOYBEAN:{label:"soybeans",topics:["soybean","soybeans","grain","USDA"]}, SOYBEANS:{label:"soybeans",topics:["soybean","soybeans","grain","USDA"]},
  COCOA:{label:"cocoa",topics:["cocoa","Ivory Coast","Ghana","chocolate"]},
  COFFEE:{label:"coffee",topics:["coffee","arabica","robusta","Brazil coffee"]},
  SUGAR:{label:"sugar",topics:["sugar","cane","ethanol"]}, COTTON:{label:"cotton",topics:["cotton"]},
  XLE:{label:"energy",topics:["crude","oil","OPEC","OPEC+","natural gas","energy stocks","refiner","refinery"]},
  XOP:{label:"energy",topics:["crude","oil","OPEC","OPEC+","shale","drilling","energy stocks"]},
  SMH:{label:"semiconductors",topics:["semiconductor","semiconductors","chip","chips","chipmaker","foundry","export controls","wafer"]},
  SOXX:{label:"semiconductors",topics:["semiconductor","semiconductors","chip","chips","chipmaker","foundry","export controls","wafer"]},
  XLK:{label:"technology",topics:["tech stocks","technology sector","software","megacap tech"]},
  XLF:{label:"financials",topics:["banks","bank stocks","financials","Fed","regional banks","lending"]},
  XLV:{label:"health care",topics:["health care","healthcare","drugmaker","pharma","Medicare","Medicaid","FDA","biotech"]},
  XLI:{label:"industrials",topics:["industrials","manufacturing","ISM","factory","aerospace","freight"]},
  XLP:{label:"consumer staples",topics:["consumer staples","grocery","packaged food","household products"]},
  XLY:{label:"consumer discretionary",topics:["consumer spending","retail sales","retailers","discretionary"]},
  XLB:{label:"materials",topics:["materials","chemicals","mining","base metals","commodities"]},
  XLU:{label:"utilities",topics:["utilities","power grid","electricity","data center power"]},
  XLRE:{label:"real estate",topics:["real estate","REIT","REITs","housing","mortgage rates","commercial property"]},
  XLC:{label:"communication services",topics:["streaming","advertising","telecom","social media"]},
};
function macroLane(t, uni) {
  if (uni === "main") return null;   // the crypto drawer has no news feed at all
  const T = String(t || "").toUpperCase();
  const L = MACRO_LANES[T] || MACRO_LANES[T.replace(/\./g, "")];
  return L || null;
}

module.exports = { classify, nameAliases, companyName, displayName, macroLane, MACRO_LANES, DISPLAY_NAMES, CRYPTO_NAMES, IND_TICKERS, SECTOR_TICKERS, setSectorOverlay, overlayFor, PREIPO, GICS_SECTORS, homeMkt, homeAdr };

