"use strict";
// Ticker -> {assetClass, sector} classification.
// Equities map to a GICS sector from a curated table; ETFs, indices, FX, commodities and
// crypto get an asset-class label. Unknown tickers return "Unclassified" — never guessed.
// Tuned to the live `xyz` HIP-3 universe (foreign chipmakers, 2025 IPOs, sector/region ETFs,
// bare FX codes, the XYZ100 dex index, and commodity CME codes like CL=WTI).

const SECTOR_TICKERS = {
  "Information Technology": ["AAPL","MSFT","NVDA","AVGO","ORCL","CRM","ADBE","AMD","INTC","CSCO","ACN","TXN","QCOM","IBM","NOW","INTU","AMAT","MU","ADI","LRCX","KLAC","SNPS","CDNS","PANW","ANET","MRVL","FTNT","ON","DELL","HPQ","HPE","NXPI","MCHP","ROP","TEL","GLW","SMCI","WDC","STX","ZS","CRWD","DDOG","SNOW","NET","PLTR","TEAM","WDAY","ADSK","APH","MPWR","FSLR","KEYS","CTSH","IT","GRMN","TER","ZBRA","TYL","PTC","ANSS","EPAM","TSM","ASML","ARM","MSTR","BB","NBIS","CRWV","CBRS","LITE","SNDK","SKHX","SMSN","KIOXIA","IBIDEN","ZHIPU","MINIMAX"],
  "Communication Services": ["GOOGL","GOOG","META","NFLX","DIS","CMCSA","T","VZ","TMUS","CHTR","EA","TTWO","WBD","OMC","LYV","MTCH","PINS","SNAP","RBLX","SPOT","ROKU","ZM","IPG","NWSA","FOXA","PARA","WMG","SOFTBANK"],
  "Consumer Discretionary": ["AMZN","TSLA","HD","MCD","NKE","LOW","SBUX","BKNG","TJX","ORLY","CMG","MAR","GM","F","HLT","ROST","AZO","YUM","LULU","DHI","LEN","EBAY","ETSY","ABNB","DRI","RCL","CCL","NCLH","EXPE","APTV","RIVN","LCID","DKNG","PHM","BBY","DPZ","TSCO","ULTA","LVS","WYNN","MGM","GPC","KMX","POOL","NVR","BABA","GME","HYUNDAI","BIRD"],
  "Consumer Staples": ["PG","KO","PEP","COST","WMT","PM","MO","MDLZ","TGT","KMB","GIS","KHC","SYY","STZ","KDP","MNST","HSY","KR","ADM","DG","DLTR","CLX","CHD","MKC","K","HRL","TSN","CAG","CPB","EL","KVUE","BG","TAP"],
  "Health Care": ["UNH","JNJ","LLY","ABBV","MRK","PFE","TMO","ABT","DHR","AMGN","BMY","GILD","CVS","MDT","ISRG","ELV","VRTX","REGN","CI","ZTS","BSX","HCA","SYK","BDX","HUM","MRNA","BIIB","IDXX","DXCM","IQV","MCK","CNC","GEHC","EW","A","RMD","WST","BAX","ZBH","MTD","COR","ALGN","HOLX","STE","HIMS"],
  "Financials": ["BRK.B","BRKB","JPM","V","MA","BAC","WFC","GS","MS","SPGI","AXP","BLK","C","SCHW","CB","PGR","MMC","PNC","USB","TFC","AON","ICE","CME","COF","MET","AIG","PRU","TRV","ALL","BK","AFL","MSCI","PYPL","SQ","COIN","HOOD","FIS","FI","GPN","DFS","SYF","MCO","AJG","NDAQ","STT","FITB","HBAN","RF","CFG","KEY","AMP","TROW","CRCL","BX","STRC"],
  "Industrials": ["CAT","HON","UPS","BA","GE","RTX","UNP","DE","LMT","ADP","GD","NOC","ETN","MMM","ITW","EMR","CSX","FDX","NSC","WM","GEV","PH","TDG","CTAS","PCAR","CARR","OTIS","CMI","ROK","IR","FAST","ODFL","LUV","DAL","UAL","AAL","PAYX","VRSK","URI","LHX","RSG","GWW","AME","DOV","HWM","WAB","EFX","XYL","FTV","PWR","BLDR","J","RKLB","BE"],
  "Energy": ["XOM","CVX","COP","SLB","EOG","MPC","PSX","VLO","WMB","OKE","HES","OXY","KMI","HAL","DVN","BKR","FANG","TRGP","CTRA","MRO","APA","EQT","LNG","OVV","MTDR","DINO"],
  "Materials": ["LIN","APD","SHW","ECL","FCX","NEM","DOW","DD","NUE","CTVA","VMC","MLM","PPG","ALB","IFF","LYB","STLD","CF","MOS","CE","EMN","IP","PKG","AMCR","BALL","AVY","FMC","USAR"],
  "Utilities": ["NEE","DUK","SO","D","AEP","SRE","EXC","XEL","ED","PEG","WEC","AWK","PCG","EIX","DTE","AEE","ETR","ES","FE","PPL","CMS","CNP","NRG","VST","LNT","EVRG","ATO","NI","PNW"],
  "Real Estate": ["PLD","AMT","EQIX","CCI","PSA","O","SPG","WELL","DLR","VICI","SBAC","AVB","EQR","EXR","INVH","VTR","ARE","MAA","ESS","KIM","UDR","HST","BXP","IRM","CBRE","CPT","REG","DOC","WY"],
};

const SECTOR_ETF = { XLE:"Energy", XOP:"Energy", SMH:"Information Technology", SOXX:"Information Technology", XLK:"Information Technology", XLF:"Financials", XLV:"Health Care", XLI:"Industrials", XLP:"Consumer Staples", XLY:"Consumer Discretionary", XLB:"Materials", XLU:"Utilities", XLRE:"Real Estate", XLC:"Communication Services", URNM:"Materials", URA:"Materials" };
// Pre-IPO synthetic perps (track a private company's implied valuation before listing).
const PREIPO = { SPCX:"Industrials", OPENAI:"Information Technology", ANTHROPIC:"Information Technology", CURSOR:"Information Technology", XAI:"Information Technology", DATABRICKS:"Information Technology", STRIPE:"Financials", REVOLUT:"Financials", DISCORD:"Communication Services", CANVA:"Information Technology", RAMP:"Financials", ANDURIL:"Industrials", FIGURE:"Industrials" };
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

function classify(ticker) {
  const T = norm(ticker), Td = T.replace(/\./g, "");
  if (EQ[T]) return { assetClass: "Equity", sector: EQ[T] };
  if (EQ[Td]) return { assetClass: "Equity", sector: EQ[Td] };
  if (PREIPO[T]) return { assetClass: "Pre-IPO", sector: PREIPO[T] };
  if (THEMATIC.has(T)) return { assetClass: "Thematic", sector: "Thematic" };
  if (SECTOR_ETF[T]) return { assetClass: "ETF", sector: SECTOR_ETF[T] };
  if (REGION_ETF.has(T)) return { assetClass: "ETF", sector: "Index" };
  if (INDEX.has(T) || INDEX.has(Td)) return { assetClass: "Index", sector: "Index" };
  if (CRYPTO.has(T) || CRYPTO.has(Td)) return { assetClass: "Crypto", sector: "Crypto" };
  if (COMMOD.has(T) || COMMOD.has(Td)) return { assetClass: "Commodity", sector: "Commodity" };
  if (FX.has(T) || FX.has(Td)) return { assetClass: "FX", sector: "FX" };
  if (/^[A-Z]{6}$/.test(Td)) { const a = Td.slice(0, 3), b = Td.slice(3); if (CCY.has(a) && CCY.has(b)) return { assetClass: "FX", sector: "FX" }; }
  if (CCY.has(Td)) return { assetClass: "FX", sector: "FX" };
  return { assetClass: "Unclassified", sector: "Unclassified" };
}

module.exports = { classify };
