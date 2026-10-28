// AI Forecast view (#forecast): Bybit's USDT-perpetual candles, the stored
// af-signal-v1 signals and the af-forecast-v1 forecast versions on one canvas
// chart, beside the AI Forecast demo account. While it is open this view is the
// only producer of forecasts: one immutable version per closed candle, never
// overwritten. Signals are built exactly as the runner builds them, so both make
// the same record: the same id, content and contentHash. Only recordedAt and
// origin can differ, and the record stored first stands. Every account change
// goes through the runner, which keeps the account's protection (and its
// auto-trading, when on) running in crypto mode while the view is hidden. The
// user trades by hand from the order ticket at the top right (market orders in
// isolated margin, as Bybit fills them) and moves a position's SL and TP by
// dragging them on the chart; the account terminal under the chart
// (forecast-terminal.js) shows the money, the positions and the history. Demo
// only: public market data through the page's grab(), no orders to Bybit.
import {TF,CHART_TFS,SYMBOLS,SIGNAL_PARAMS,FORECAST_PARAMS} from './forecast-config.js';
import {requiredLookback,computeIndicators,aggregateClosed,evaluateBar,signalsInRange,forecastFeatures,forecastAt} from './forecast-model.js';
import {createForecastStore,defaultBackend,signalRecord,forecastRecord} from './forecast-store.js';
import {createLiveSeries,dataStatus,fetchHistory,fetchFunding,splitForming} from './forecast-market.js';
import {createForecastChart,CHART_COLORS,REGIME_LABELS,keepNumbers,priceDecimals,comparisonStats} from './forecast-chart.js';
import {createForecastRunner} from './forecast-runner.js';
import {ACCOUNT,SETTING_LIMITS,accountStats,stepDecimals,levelDecimals} from './forecast-account.js';
import {walkForwardSteps,DEV_END} from './forecast-backtest.js';
import {createContractCache,roundPrice} from './bybit-contracts.js';
import {mountTerminal,terminalFigures} from './forecast-terminal.js';
import {sketchPrompt,createSketchReader} from './claude-sketch.js';

const PREFS='riptide.forecast.ui.v1',HISTORY=2000,HORIZONS=Object.freeze([5,10,20]),BACKFILL=Object.freeze([20,10,5]);
// The order ticket's choices per browser: the stake as typed, the leverage per coin and whether an order is confirmed
// first. A new ticket starts at a 10 $ stake and Bybit's default 10×; LEVEL_MSG_MS: how long a level change's result stays.
const TICKET='riptide.forecast.ticket.v1',STAKE='10',LEVERAGE=10,CHIPS=Object.freeze([10,25,50]),LEVEL_MSG_MS=10000;
// MKT_ROOM: the share by which the price may fall between Max and the order's fill while the quantity a Max stake buys
// stays within Bybit's largest market order (a lower price buys more for the same stake).
const MKT_ROOM=.005;
const LEVERAGES=Object.freeze(['max',1,2,3,5,10,20,50]),EVAL_BARS=12000,VERSIONS_SHOWN=300,OLDER='older';
// A chart read still open after STUCK_MS never settles (a stalled response body has no deadline; a slow
// two-page load through the proxies can take about 45 s); an archive call gets ARCHIVE_MS before it fails.
const STUCK_MS=60000,ARCHIVE_MS=10000;
// forecastAt reads the training window plus the feature windows before it (155 bars): a cutoff
// with less history before it in the loaded series could change with where that series starts.
const forecastMin=()=>FORECAST_PARAMS.train+155;
const C=CHART_COLORS,HOUR=3600000,DAY=86400000,MINUS='−',DATE_MAX=8.64e15;
// Days of test windows left on a timeframe by EVAL_BARS candles once the first window's forecast library has its
// FORECAST_PARAMS.train candles with their feature windows (the forming candle is not tested): on 5m and 15m
// this cap, not DEV_END, sets where the windows start.
const cappedDays=tf=>Math.floor((EVAL_BARS-1-forecastMin())*TF[tf].ms/DAY);
// The audited research (frozen protocol), shown as measured history: the numbers are those of the summary at
// the top of research/ai-forecast-results.md, measured on hourly candles of all seven coins.
const RESULTS_URL='https://github.com/Odmarken/Investing-tool/blob/main/research/ai-forecast-results.md';
// A number keeps its unit on the same line (−35,2 %, 100 $), as in Swedish typesetting. The runner's and the
// account log's texts use plain spaces, so they are bound the same way when shown.
const bind=s=>String(s??'').replace(/(\d) ([%$])/g,'$1\xa0$2');
const unbroken=texts=>Object.freeze(Object.fromEntries(Object.entries(texts).map(([k,s])=>[k,bind(s)])));
const RESEARCH=unbroken({
  signal:'Uppmätt historik: reglerna af-signal-v1 är ej validerade. I forskningen förlorade de både på utvecklingsdatan 2022–2025 och på valideringsåret 2025–2026, där de gav −35,2 % med 1 % risk och 10×.',
  forecast:'Uppmätt historik: i forskningens test utanför träningsdatan, okt 2025–sep 2026 på timcandles, var modellen inte bättre än ett oförändrat pris (skill −3,3 %, −4,0 % och −6,4 % på 5, 10 och 20 candles), och riktningen stämde på slumpens nivå. De grå candlerna visar därför ett möjligt förlopp och bandet den vanliga spridningen, inte en förutsägelse. 80 %-bandet rymde 75–78 % av stängningarna.',
  account:'Uppmätt historik: på forskningens valideringsår, okt 2025–sep 2026, förlorade standardinställningarna (Bybits maxhävstång, 25 % marginal och 10 % risk) 99,91 % av 100 $. 83 av 95 affärer likviderades, och kapitalet var under 1 $ efter 22 dagar.',
  summary:'Ingen av de åtta regelvarianterna blev behörig: alla förlorade på utvecklingsdatan 2022–2025 (−96,6 % till −43,3 %). Standardreglerna gav −35,2 % på valideringsåret okt 2025–sep 2026 med 1 % risk och 10×, och −99,91 % med kontots standard och Bybits maxhävstång. Prognosen slog inte ett oförändrat pris (skill −3,3 %, −4,0 % och −6,4 % på 5, 10 och 20 candles), och 80 %-bandet rymde 75–78 % av stängningarna. Allt är uppmätt i efterhand på timcandles.'
});
// A regime's name, or null for a value that names none: a stored record's regime is data, so a key such as
// 'constructor' must not reach the object's prototype.
const regimeName=r=>typeof r==='string'&&Object.hasOwn(REGIME_LABELS,r)?REGIME_LABELS[r]:null;
const SIDE=Object.freeze({long:'lång',short:'kort'});
const PILL=Object.freeze({live:['live','Live'],delayed:['warn','Fördröjd'],stale:['bad','Inaktuell'],gap:['bad','Lucka'],error:['bad','Data saknas'],loading:['idle','Hämtar…']});
const MONTHS=['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
const dated=t=>finite(t)&&Math.abs(t)<=DATE_MAX;
// Browser errors arrive in English ('Failed to fetch', an aborted request, a proxy's HTML page read as
// JSON, blocked or full storage); the page speaks Swedish.
function reasonOf(e){
  const name=e?.name,text=String(e?.message??e??'');
  if(name==='AbortError'||name==='TimeoutError')return 'Bybit svarade inte i tid via proxyn';
  if(name==='TypeError'&&/^(failed to fetch|fetch failed|networkerror|load failed)/i.test(text))return 'Bybit kunde inte nås via proxyn';
  if(name==='SyntaxError')return 'Proxyn gav ett oläsligt svar från Bybit';
  if(name==='SecurityError')return 'Webbläsarens lagring är blockerad';
  if(name==='QuotaExceededError')return 'Webbläsarens lagring är full';
  return text||'okänt fel';
}
// The store checks each record's hashes, but anything that can write this origin's storage can seal a
// record of another shape. Only well-formed records are shown or drawn; the rest count as damaged.
function wellFormed(r,kind){
  const T=TF[r?.tf];
  if(!T||typeof r.id!=='string')return false;
  if(kind==='signal')return (r.side==='long'||r.side==='short')&&dated(r.barTime)&&r.confirmedAt===r.barTime+T.ms&&[r.entry,r.sl,r.tp].every(x=>finite(x)&&x>0);
  const f=r.forecast;
  return dated(r.cutoff)&&r.cutoffClose===r.cutoff+T.ms&&dated(r.createdAt)&&!!f&&typeof f==='object'&&finite(f.base)&&f.base>0&&
    Number.isInteger(f.horizon)&&Number.isInteger(f.k)&&Array.isArray(f.candles)&&Array.isArray(f.bands);
}
const fixed=(x,d)=>x.toLocaleString('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d});
// The sign is written out, so a value that rounds to zero never reads −0,00.
const signed=(x,d,unit)=>{const v=Math.round(x*10**d)/10**d;return (v>0?'+':v<0?MINUS:'')+fixed(Math.abs(v),d)+unit;};
const num=(x,d=0)=>finite(x)?fixed(x,d):'–';
// Like the research texts, a value keeps its unit on its line (a no-break space), so "0,67 %" never splits in a card.
const money=x=>finite(x)?fixed(x,2)+'\xa0$':'–';
const signedMoney=x=>finite(x)?signed(x,2,'\xa0$'):'–';
const pct=(x,d=1)=>finite(x)?fixed(x*100,d)+'\xa0%':'–';
const signedPct=(x,d=1)=>finite(x)?signed(x*100,d,'\xa0%'):'–';
const price=(x,dec)=>finite(x)?fixed(x,Number.isInteger(dec)?dec:priceDecimals(x)):'–';
const tone=x=>!finite(x)||Math.abs(x)<.005?'':x>0?'pos':'neg';
const leverageText=v=>v==='max'?'Bybit max':fixed(v,Number.isInteger(v)?0:2)+'×';
// An amount as typed in the ticket: digits with a decimal comma or point, spaces between the thousands allowed
// ("1 000,50"). Anything else, a sign included, is NaN, which the preview refuses with its reason.
function amount(text){
  const s=String(text??'').replace(/[\s\u00a0\u202f]/g,'').replace(',','.');
  return /^(\d+(\.\d*)?|\.\d+)$/.test(s)?Number(s):NaN;
}
// A number for an input field: a decimal comma, no thousands separators.
const field=(x,d)=>x.toFixed(d).replace('.',',');
// The two sides' reasons as one when they differ only in their figures (a buy fills a little higher than a sell), each
// differing figure as the range of the two: 'Otillräckligt tillgängligt saldo: 504,21–504,25 $ behövs, 92,94 $ finns'.
// null when they say different things.
const FIGURE=/\d+(?:[\u00a0\u202f ]\d{3})*(?:,\d+)?/g;
function mergedReason(a,b){
  const ta=a.split(FIGURE),tb=b.split(FIGURE),na=a.match(FIGURE)??[],nb=b.match(FIGURE)??[];
  if(ta.length!==tb.length||na.length!==nb.length||ta.some((x,i)=>x!==tb[i]))return null;
  const value=x=>Number(x.replace(/[\u00a0\u202f ]/g,'').replace(',','.'));
  return ta.map((x,i)=>i<na.length?x+(na[i]===nb[i]?na[i]:value(na[i])<=value(nb[i])?na[i]+'–'+nb[i]:nb[i]+'–'+na[i]):x).join('');
}
// A quantity in Bybit's own steps (0,001 BTC; 10 000 SHIB), trailing zeros left out.
const quantity=(x,step)=>x.toLocaleString('sv-SE',{maximumFractionDigits:finite(step)&&step>0?stepDecimals(step):8});
// The model's display rule for a value that misses a limit, so a check shows the same number as the
// explanation line: ADX 17,96 under 18 reads 17,9, never 18.
function below(x,limit,dec){
  if(+x.toFixed(dec)<limit)return fixed(x,dec);
  for(let d=dec+1;d<=dec+4;d++){const f=10**d,y=Math.floor(x*f)/f;if(y<limit)return fixed(y,d);}
  return fixed(x,dec+4);
}
function above(x,limit,dec){
  if(+x.toFixed(dec)>limit)return fixed(x,dec);
  for(let d=dec+1;d<=dec+4;d++){const f=10**d,y=Math.ceil(x*f)/f;if(y>limit)return fixed(y,d);}
  return fixed(x,dec+4);
}

// Stockholm wall-clock time; the date is added when it is not today's.
let zone=null;
function wall(t){
  zone??=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Stockholm',hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric'});
  const p={};for(const x of zone.formatToParts(t))p[x.type]=+x.value;return p;
}
const two=n=>String(n).padStart(2,'0');
function when(t,now,{date=false}={}){
  if(!dated(t))return '–';
  const w=wall(t),n=dated(now)?wall(now):w,other=w.year!==n.year||w.month!==n.month||w.day!==n.day;
  return (date||other?w.day+' '+MONTHS[w.month-1]+(w.year!==n.year?' '+w.year:'')+' ':'')+two(w.hour)+':'+two(w.minute);
}
const dateText=t=>{if(!dated(t))return '–';const w=wall(t);return w.day+' '+MONTHS[w.month-1]+' '+w.year;};

/**
 * The value beside one rule check of an evaluateBar result, written with the
 * explanation lines' rounding (params are the rules that made it).
 */
export function checkText(c,e,dec,params=SIGNAL_PARAMS){
  const v=c?.value,p=params,f=e?.features??{},dir=f.emaFast>f.emaSlow?1:f.emaFast<f.emaSlow?-1:0,[lo,hi]=dir>0?p.rsiLong:p.rsiShort;
  if(c?.key==='cooldown')return finite(v)?'signal för '+v+(v===1?' candle':' candles')+' sedan':c.ok?'ingen nyligen':'–';
  if(!finite(v))return '–';
  switch(c.key){
    case 'trend':return 'ADX '+(v<p.adxRange?below(v,p.adxRange,0):v<p.adxTrend?below(v,p.adxTrend,0):fixed(v,0));
    case 'htf':return v>0?'uppåt':v<0?'nedåt':'neutral';
    case 'trigger':return price(v,dec);
    case 'momentum':return 'RSI '+(dir&&v>hi?above(v,hi,0):dir&&v<lo?below(v,lo,0):fixed(v,0));
    case 'volume':return (v<p.volMin?below(v,p.volMin,1):fixed(v,1))+'× median';
    case 'volatility':return 'percentil '+(v>p.volRankMax?above(v*100,p.volRankMax*100,0):v<p.volRankMin?below(v*100,p.volRankMin*100,0):fixed(v*100,0));
    default:return String(v);
  }
}

/**
 * Level lines for the chart. An open AI Forecast position on this symbol shows
 * its entry, SL, TP and liquidation; each of its lines carries the position's
 * id as `edit`, and a manual position's missing SL or TP has no line. Without
 * one, the latest stored signal of the series shows entry, SL and TP only while
 * it is still live: fewer than maxHold candles have closed since it was
 * confirmed, all of them are loaded, and none of them touched its SL or TP.
 * Decided signals get no lines. bars: closed candles of the chart's series.
 */
export function chartLevels({symbol,tf,positions=[],signals=[],bars=[],params=SIGNAL_PARAMS}={}){
  const T=TF[tf];if(!T)return [];
  const held=(Array.isArray(positions)?positions:[]).filter(p=>p?.symbol===symbol);
  if(held.length)return held.flatMap(p=>{
    const from=Math.floor(p.openedAt/T.ms)*T.ms,line=(kind,price,label)=>finite(price)&&price>0?[{kind,price,from,label,edit:p.id}]:[];
    return [...line('entry',p.entry,'Entry'),...line('sl',p.sl,'SL'),...line('tp',p.tp,'TP'),...line('liq',p.liq,'Likv.')];
  });
  const list=(Array.isArray(signals)?signals:[]).filter(s=>s&&s.symbol===symbol&&s.tf===tf&&finite(s.barTime)&&(s.side==='long'||s.side==='short'));
  const s=list.reduce((a,b)=>!a||b.barTime>a.barTime?b:a,null),last=Array.isArray(bars)?bars.at(-1):null;
  if(!s||!last||last.t<s.barTime)return [];
  const since=Math.round((last.t-s.barTime)/T.ms),after=bars.filter(b=>b.t>s.barTime),dir=s.side==='long'?1:-1;
  if(since>=params.maxHold||after.length!==since)return [];
  if(after.some(b=>dir>0?b.l<=s.sl||b.h>=s.tp:b.h>=s.sl||b.l<=s.tp))return [];
  return [{kind:'entry',price:s.entry,from:s.barTime,label:'Entry'},{kind:'sl',price:s.sl,from:s.barTime,label:'SL'},{kind:'tp',price:s.tp,from:s.barTime,label:'TP'}];
}

// The order ticket: auto-trading on or off, the stake (margin) and the leverage for the chart's coin, a market buy and
// sell with what each would open, and the result of the last order. Its texts are set with textContent. The two switches
// come first, as phones show them, then the order itself. Each side shows its value, Bybit's order cost (what it takes
// from the free cash) and its liquidation price; the shared line the quantity, the margin and the opening fee. A phone has
// room for the liquidation price only under each button, so its shared line takes the value and the cost (CSS).
function ticketHtml(){
  return `<section class="fc-ticket" data-fc-ticket aria-labelledby="fcTicketTitle" tabindex="-1">
    <h2 class="fc-sr" id="fcTicketTitle">Order i demokontot</h2>
    <div class="fc-tk-auto"><span class="fc-tk-cap" id="fcAutoCap">Auto-handel</span>
      <button type="button" class="fc-switch" role="switch" aria-checked="false" aria-labelledby="fcAutoCap" data-fc-auto><i aria-hidden="true"></i><span data-fc-auto-text>Av</span></button></div>
    <label class="fc-tk-confirm"><input type="checkbox" data-fc-confirm> Bekräfta order</label>
    <div class="fc-tk-stake"><label class="fc-tk-cap" for="fcStake">Insats (marginal)</label>
      <div class="fc-tk-row"><span class="fc-tk-box"><input id="fcStake" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-fc-stake aria-describedby="fcTkShared"><span aria-hidden="true">$</span></span>
        <span class="fc-tk-chips" role="group" aria-label="Insats av tillgängligt saldo">${CHIPS.map(k=>`<button type="button" data-fc-stake-pct="${k}" aria-label="${k} procent av tillgängligt saldo">${k}\xa0%</button>`).join('')}<button type="button" data-fc-stake-pct="max" aria-label="Max: hela tillgängliga saldot med plats för avgifterna att öppna och stänga, för både köp och sälj, inom Bybits största marknadsorder">Max</button></span></div></div>
    <div class="fc-tk-lev"><label class="fc-tk-cap" for="fcLev">Hävstång</label><span class="fc-tk-hint" id="fcLevHint" data-fc-lev-hint><span data-fc-lev-hint-text aria-hidden="true"></span><span class="fc-sr" data-fc-lev-hint-full></span></span>
      <div class="fc-tk-row"><input type="range" class="fc-tk-range" data-fc-lev-range min="1" max="100" step="1" value="10" aria-label="Hävstång, reglage" aria-describedby="fcLevHint">
        <span class="fc-tk-box fc-tk-x"><input id="fcLev" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-fc-lev aria-describedby="fcLevHint"><span aria-hidden="true">×</span></span></div></div>
    ${['long','short'].map(side=>`<div class="fc-tk-side fc-tk-${side}"><button type="button" class="fc-tk-btn" data-fc-order="${side}" aria-describedby="fcTk-${side} fcTkShared fcTkWhy">${side==='long'?'Köp / Lång':'Sälj / Kort'}</button>`+
      `<p class="fc-tk-est" id="fcTk-${side}" data-fc-est="${side}"><span class="fc-tk-wide" data-fc-est-value></span><span class="fc-tk-wide" data-fc-est-cost></span><span data-fc-est-liq></span></p></div>`).join('')}
    <div class="fc-tk-info" data-fc-info><p class="fc-tk-shared" id="fcTkShared" data-fc-shared><span class="fc-tk-wide" data-fc-shared-wide></span><span class="fc-tk-narrow" data-fc-shared-narrow></span></p>
      <p class="fc-tk-msg" data-fc-ticket-msg role="status" aria-live="polite"></p><p class="fc-tk-why" id="fcTkWhy" data-fc-why></p></div>
  </section>`;
}
function skeleton(){
  // The forecast swatch takes the chart's own fill, so the legend always shows what the canvas draws.
  const swatch=(cls,color,text)=>`<li><i class="fc-sw ${cls}" style="--c:${color}" aria-hidden="true"></i>${text}</li>`;
  return `<div class="fc-shell">
  <div class="fc-top">
  <header class="fc-head">
    <div class="fc-titles"><div class="fc-eyebrow">RIPTIDE / KRYPTO / AI FORECAST</div><h1 id="forecastTitle" tabindex="-1">AI Forecast</h1></div>
    <div class="fc-quote"><span class="fc-pair" data-fc-pair></span><b class="fc-last" data-fc-last>–</b></div>
    <span class="fc-pill" data-fc-pill data-state="idle"><i aria-hidden="true"></i><span class="fc-sr">Datastatus: </span><span data-fc-pill-text>Hämtar…</span></span>
    <a class="fc-btn fc-back" href="#" title="Tillbaka till signaler"><span aria-hidden="true">←</span><span class="fc-back-text">Tillbaka till signaler</span></a>
  </header>
  ${ticketHtml()}
  </div>
  <p class="fc-banner" data-fc-banner hidden></p><p class="fc-sr" data-fc-announce role="status" aria-live="polite"></p>
  <p class="fc-sr" data-fc-terminal-announce role="status" aria-live="polite"></p>
  <div class="fc-toolbar" role="toolbar" aria-label="Diagraminställningar">
    <label class="fc-field fc-symbol"><span>Par</span><select data-fc-symbol>${SYMBOLS.map(s=>`<option value="${s}">${s}</option>`).join('')}</select></label>
    <div class="fc-group fc-tf"><span class="fc-cap" id="fcTfCap">Tidsram</span><div class="fc-seg" role="group" aria-labelledby="fcTfCap">${CHART_TFS.map(k=>`<button type="button" data-fc-tf="${k}" aria-pressed="false">${TF[k].label}</button>`).join('')}</div></div>
    <div class="fc-group fc-horizon"><span class="fc-cap" id="fcHCap">Prognos</span><div class="fc-seg" role="group" aria-labelledby="fcHCap">${HORIZONS.map(h=>`<button type="button" data-fc-horizon="${h}" aria-pressed="false" aria-label="${h} candles">${h}</button>`).join('')}</div></div>
    <div class="fc-seg fc-toggles" role="group" aria-label="Visa i grafen"><button type="button" data-fc-toggle="forecast" aria-pressed="true" title="AI Forecasts prognos-candles och band">Prognos</button><button type="button" data-fc-toggle="band" aria-pressed="true">Band</button><button type="button" data-fc-toggle="signals" aria-pressed="true">Signaler</button><button type="button" data-fc-toggle="levels" aria-pressed="true">Nivåer</button><button type="button" data-fc-toggle="ask" aria-pressed="true" aria-controls="fcAsk" title="Visa eller dölj Pablo" hidden>✦ Pablo</button></div>
    <div class="fc-seg fc-sketch" data-fc-sketchbar hidden><button type="button" data-fc-sketch title="Pablo ritar vart marknaden kan gå">✦ Rita</button><button type="button" data-fc-sketch-clear aria-label="Ta bort Pablos ritning" title="Ta bort Pablos ritning" hidden>✕</button></div>
    <div class="fc-seg fc-zoom" role="group" aria-label="Zoom"><button type="button" data-fc-zoom="out" aria-label="Zooma ut" title="Zooma ut">−</button><button type="button" data-fc-zoom="in" aria-label="Zooma in" title="Zooma in">+</button><button type="button" data-fc-zoom="reset" aria-label="Återställ vyn" title="Återställ vyn (dubbelklick i grafen)">⌂</button></div>
  </div>
  <div class="fc-grid">
    <section class="fc-chart" aria-label="Diagram">
      <div class="fc-comparebar" role="group" aria-label="Jämför prognoser">
        <label class="fc-field fc-compare"><span>Jämför med</span><select data-fc-compare disabled><option value="">Ingen sparad prognos ännu</option></select></label>
        <div class="fc-chips" data-fc-chips role="group" aria-label="Tidigare prognoser med utfall" hidden></div>
      </div>
      <div class="fc-canvas-wrap" data-fc-canvas-wrap><canvas data-fc-canvas tabindex="0" role="img" aria-label="Candlestick-diagram"></canvas>
        <div class="fc-handle" data-fc-handle="sl" aria-hidden="true" hidden></div><div class="fc-handle" data-fc-handle="tp" aria-hidden="true" hidden></div>
        <div class="fc-tooltip" data-fc-tooltip hidden></div><p class="fc-chart-note" data-fc-chart-note hidden></p>
        <p class="fc-level-msg" data-fc-level-msg role="status" aria-live="polite"></p><aside class="fc-ask" id="fcAsk" data-fc-ask aria-label="Fråga Pablo om grafen" hidden></aside></div>
      <ul class="fc-legend" aria-label="Teckenförklaring">${swatch('body',C.up,'Stigande')}${swatch('body',C.down,'Fallande')}${swatch('body',C.fcFill,'Prognos (scenario)')}${swatch('band',C.band50,'50\xa0%/80\xa0%-band (spridning)')}${swatch('dash',C.median,'Median')}${swatch('outline',C.fcOutline,'Jämförd prognos (kontur)')}
        <li><span class="fc-tri" style="--c:${C.up}" aria-hidden="true">▲</span>Köp <span class="fc-tri" style="--c:${C.down}" aria-hidden="true">▼</span>Sälj</li>
        <li><i class="fc-sw line" style="--c:${C.entry}" aria-hidden="true"></i>Entry <i class="fc-sw dash" style="--c:${C.sl}" aria-hidden="true"></i>SL <i class="fc-sw dash" style="--c:${C.tp}" aria-hidden="true"></i>TP <i class="fc-sw dot" style="--c:${C.liq}" aria-hidden="true"></i>Likv.</li></ul>
      <section class="fc-terminal" data-fc-terminal aria-label="Kontoterminal"></section>
    </section>
    <aside class="fc-side" aria-label="Signal, prognos och demokonto">
      <section class="fc-card" aria-labelledby="fcSignalTitle"><h2 id="fcSignalTitle">Signal · senaste stängda candle</h2><div data-fc-signal></div>
        <p class="fc-research" data-fc-research="signal">${esc(RESEARCH.signal)}</p></section>
      <section class="fc-card" aria-labelledby="fcForecastTitle"><h2 id="fcForecastTitle">Prognos</h2><div data-fc-forecast></div></section>
      <section class="fc-card" aria-labelledby="fcAccountTitle"><h2 id="fcAccountTitle" tabindex="-1">Demokonto · AI Forecast</h2>
        <div data-fc-account></div>
        <p class="fc-msg" data-fc-account-msg role="status" aria-live="polite"></p>
        <div class="fc-actions"><button type="button" class="fc-btn" data-fc-pause>⏸ Pausa nya signalaffärer</button><button type="button" class="fc-btn fc-danger" data-fc-reset title="Arkivera kontot och börja om med 100 $">Återställ kontot</button></div>
        <form class="fc-settings" data-fc-settings novalidate>
          <h3>Auto-handel · inställningar för signalaffärer</h3>
          <p class="fc-muted">Gäller bara affärer som auto-handeln öppnar på signalerna. Dina egna order tar insats och hävstång från orderrutan.</p>
          <div class="fc-form-grid">
            <label><span>Positionsstorlek</span><small>marginal, % av kapitalet</small><input type="number" name="positionPct" min="${SETTING_LIMITS.positionPct[0]*100}" max="${SETTING_LIMITS.positionPct[1]*100}" step="1" inputmode="decimal"></label>
            <label><span>Risk per affär</span><small>% av kapitalet</small><input type="number" name="riskPct" min="${SETTING_LIMITS.riskPct[0]*100}" max="${SETTING_LIMITS.riskPct[1]*100}" step="0.1" inputmode="decimal"></label>
            <label><span>Max öppna positioner</span><small>${SETTING_LIMITS.maxOpen[0]}–${SETTING_LIMITS.maxOpen[1]}</small><input type="number" name="maxOpen" min="${SETTING_LIMITS.maxOpen[0]}" max="${SETTING_LIMITS.maxOpen[1]}" step="1" inputmode="numeric"></label>
            <label><span>Hävstång</span><small>per position</small><select name="leverage">${LEVERAGES.map(v=>`<option value="${v}">${leverageText(v)}</option>`).join('')}</select></label>
            <label><span>Tidsram för handel</span><small>signalernas candles</small><select name="tf">${CHART_TFS.map(k=>`<option value="${k}">${TF[k].label}</option>`).join('')}</select></label>
          </div>
          <fieldset class="fc-pairs"><legend>Handlade par</legend>${SYMBOLS.map(s=>`<label><input type="checkbox" name="symbols" value="${s}"> ${s}</label>`).join('')}</fieldset>
          <div class="fc-actions"><button type="submit" class="fc-btn fc-primary" data-fc-save>Spara</button></div>
          <p class="fc-msg" data-fc-settings-msg role="status" aria-live="polite"></p>
        </form>
        <p class="fc-note">Med Bybits maxhävstång ligger likvidationen nästan alltid före stoppet eller mindre än 1 % bortom det; då riskerar du hela marginalen plus öppningsavgiften, så risk per affär styr den summan.</p>
        <p class="fc-research" data-fc-research="account">${esc(RESEARCH.account)}</p>
      </section>
      <section class="fc-card" aria-labelledby="fcEvalTitle"><h2 id="fcEvalTitle">Utvärdering · walk-forward</h2>
        <div class="fc-actions"><button type="button" class="fc-btn" data-fc-eval="pair">Kör för BTC 1h</button><button type="button" class="fc-btn" data-fc-eval="portfolio">Kör portfölj</button></div>
        <p class="fc-msg" data-fc-eval-progress></p><p class="fc-sr" data-fc-eval-announce role="status" aria-live="polite"></p>
        <div data-fc-eval-result></div>
        <div class="fc-research" data-fc-research="summary"><h3>Forskning (fryst protokoll)</h3><p>${esc(RESEARCH.summary)}</p>
          <p><a href="${esc(RESULTS_URL)}" target="_blank" rel="noopener">Hela resultatrapporten på GitHub</a></p></div>
      </section>
    </aside>
  </div>
</div>`;
}

// Archive calls that never settle (an IndexedDB open that never answers) must not stall the chart or the
// runner, which shares this store: after `ms` they fail like any storage error. A put that lands later is
// harmless, since records are never overwritten.
function bounded(store,ms){
  if(!(ms>0))return store;
  const wrap=fn=>(...a)=>new Promise((resolve,reject)=>{
    const t=setTimeout(()=>reject(Error('Prognosarkivet svarar inte')),ms);
    Promise.resolve().then(()=>fn.apply(store,a)).then(v=>{clearTimeout(t);resolve(v);},e=>{clearTimeout(t);reject(e);});
  });
  const out={...store};
  // info() opens IndexedDB when it has not answered yet.
  for(const k of ['putForecast','putSignal','listForecasts','listSignals','get','info'])if(typeof store[k]==='function')out[k]=wrap(store[k]);
  return out;
}
// A busy control stays focusable, so keyboard focus is not dropped to the page as it is from a disabled one:
// it is only marked aria-disabled, and its action ignores it until the running one has ended.
function markBusy(x,busy){if(busy)x.setAttribute('aria-disabled','true');else x.removeAttribute('aria-disabled');}

/**
 * mountForecast(root,{getUser,isActive,isVisible,grab,contracts,storage,store,locks,now,confirm,raf})
 *   → {show(),hide(),refreshLive(),renderSummary(el),destroy()}
 * Also injectable: runner, createChart, mountTerminal (the account terminal's mount, forecast-terminal.js by default),
 * prefs (storage for the UI choices), defer (yield to the page), reducedMotion, archiveTimeout (ms) and versions (how
 * many forecast versions a read of the archive lists, newest first, and how many more each "Visa äldre versioner" adds).
 * refreshLive() is meant to run every 5 s while the view is mounted: it always ticks the runner, and polls
 * and draws the chart only while the view is shown. destroy() tears the view down: the terminal, the chart and
 * every listener, and the runner stops reading the chart's coin for the ticket.
 */
export function mountForecast(root,deps={}){
  const {getUser=()=>null,isActive=()=>true,isVisible=null,grab,storage,locks,now=()=>Date.now(),
    confirm=message=>globalThis.confirm?globalThis.confirm(message):true,
    raf=globalThis.requestAnimationFrame?globalThis.requestAnimationFrame.bind(globalThis):null,
    reducedMotion=()=>!!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
    prefs=null,defer=()=>new Promise(resolve=>setTimeout(resolve,0)),createChart=createForecastChart,
    archiveTimeout=ARCHIVE_MS,versions=VERSIONS_SHOWN}=deps;
  const uid=()=>{try{const u=getUser();return u?String(u):null;}catch{return null;}};
  const limits=deps.contracts??(typeof grab==='function'?createContractCache(grab,now):null);
  const store=bounded(deps.store??createForecastStore(defaultBackend(globalThis)),archiveTimeout);
  const runner=deps.runner??createForecastRunner({grab,storage,store,locks,now,getUser:uid,isActive,contracts:limits,onChange:()=>paint()});
  // The manual-trading part of the runner, absent from a runner stand-in: a missing method leaves its control disabled.
  const can=name=>typeof runner?.[name]==='function';

  // UI choices per browser; optional, so every access is guarded.
  const prefStore=()=>{try{return prefs??globalThis.localStorage??null;}catch{return null;}};
  const readPref=key=>{try{const v=JSON.parse(prefStore()?.getItem(key)??'null');return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}};
  const saved=readPref(PREFS);
  const view={symbol:SYMBOLS.includes(saved.symbol)?saved.symbol:'BTC',tf:CHART_TFS.includes(saved.tf)?saved.tf:'1h',
    horizon:HORIZONS.includes(saved.horizon)?saved.horizon:10,forecast:saved.forecast!==false,band:saved.band!==false,signals:saved.signals!==false,levels:saved.levels!==false,ask:saved.ask!==false};
  const savePrefs=()=>{try{prefStore()?.setItem(PREFS,JSON.stringify(view));}catch{/* the choices are optional */}};
  // The ticket's own choices: the stake as typed, a leverage per coin, and whether an order is confirmed first (on by default).
  const keptTicket=readPref(TICKET);
  const ticket={stake:typeof keptTicket.stake==='string'&&keptTicket.stake.length<=24?keptTicket.stake:STAKE,confirm:keptTicket.confirm!==false,
    lev:Object.fromEntries(SYMBOLS.map(s=>[s,keptTicket.lev?.[s]]).filter(([,v])=>finite(v)&&v>=1&&v<=SETTING_LIMITS.leverage[1]))};
  const saveTicket=()=>{try{prefStore()?.setItem(TICKET,JSON.stringify(ticket));}catch{/* the choices are optional */}};
  // The UI prefs as storage, for the terminal's own choices (its collapsed state).
  const prefStorage=Object.freeze({getItem:key=>{try{return prefStore()?.getItem(key)??null;}catch{return null;}},
    setItem:(key,value)=>{try{prefStore()?.setItem(key,value);}catch{/* the choices are optional */}}});

  root.innerHTML=skeleton();
  const q=s=>root.querySelector(s);
  const el={pair:q('[data-fc-pair]'),last:q('[data-fc-last]'),pill:q('[data-fc-pill]'),pillText:q('[data-fc-pill-text]'),banner:q('[data-fc-banner]'),
    symbol:q('[data-fc-symbol]'),compare:q('[data-fc-compare]'),chips:q('[data-fc-chips]'),canvas:q('[data-fc-canvas]'),wrap:q('[data-fc-canvas-wrap]'),tooltip:q('[data-fc-tooltip]'),
    chartNote:q('[data-fc-chart-note]'),announce:q('[data-fc-announce]'),signal:q('[data-fc-signal]'),forecast:q('[data-fc-forecast]'),account:q('[data-fc-account]'),
    accountMsg:q('[data-fc-account-msg]'),pause:q('[data-fc-pause]'),reset:q('[data-fc-reset]'),form:q('[data-fc-settings]'),
    settingsMsg:q('[data-fc-settings-msg]'),evalPair:q('[data-fc-eval="pair"]'),evalAll:q('[data-fc-eval="portfolio"]'),
    progress:q('[data-fc-eval-progress]'),evalAnnounce:q('[data-fc-eval-announce]'),result:q('[data-fc-eval-result]'),
    auto:q('[data-fc-auto]'),autoText:q('[data-fc-auto-text]'),stake:q('[data-fc-stake]'),stakeChips:root.querySelectorAll('[data-fc-stake-pct]'),
    lev:q('[data-fc-lev]'),range:q('[data-fc-lev-range]'),levHint:q('[data-fc-lev-hint]'),levHintText:q('[data-fc-lev-hint-text]'),levHintFull:q('[data-fc-lev-hint-full]'),
    buy:q('[data-fc-order="long"]'),sell:q('[data-fc-order="short"]'),
    est:Object.fromEntries(['long','short'].map(side=>{const box=q(`[data-fc-est="${side}"]`);
      return [side,{value:box.querySelector('[data-fc-est-value]'),cost:box.querySelector('[data-fc-est-cost]'),liq:box.querySelector('[data-fc-est-liq]')}];})),
    shared:q('[data-fc-shared]'),sharedWide:q('[data-fc-shared-wide]'),sharedNarrow:q('[data-fc-shared-narrow]'),
    why:q('[data-fc-why]'),ticketMsg:q('[data-fc-ticket-msg]'),info:q('[data-fc-info]'),
    confirmBox:q('[data-fc-confirm]'),ticket:q('[data-fc-ticket]'),levelMsg:q('[data-fc-level-msg]'),terminal:q('[data-fc-terminal]'),
    terminalAnnounce:q('[data-fc-terminal-announce]'),ask:q('[data-fc-ask]')};
  el.stake.value=ticket.stake;el.confirmBox.checked=ticket.confirm;

  // polling: the chart read in flight ({at}); pass: the archive pass in flight ({my,user}); kept: the series
  // hidden last, reused when the same coin and timeframe are shown again.
  let visible=false,series=null,kept=null,token=0,loading=false,current=null,polling=null,pass=null,owner=null,listed=false;
  let signals=[],forecasts=[],older=0,shown=versions,broken={signals:0,forecasts:0},odd={signal:new Set(),forecast:new Set()};
  // evaluatedAt: the closed candle the evaluation was made for (it stays null when evaluateBar failed there).
  let status=dataStatus(null,now(),view.tf),evaluation=null,evaluatedTf=null,evaluatedAt=null,windowGap=false;
  // picked: the id of the stored signal whose row is open and whose levels the chart draws; revealed: where the chart
  // was moved to show its candle and whether it followed the latest data before ({rightT,follow}), so closing the
  // row can return the chart there.
  let picked=null,revealed=null;
  // done: the last closed candle evaluated for signals on reliable data; tried: the cutoff last tried for a forecast.
  let done=null,tried=null,backfill=false,forecastNote='',opened=null,choice=null,warnings=new Map(),failures={},shownPrice=null,flash=null;
  let summaryEl=null,announced=null,acting=false,saving=false,dirty=false,filled=null,evalRun=null,evalResult=null,evalToken=0,uiUser;
  // ordering: the side of the order on its way; switching: auto-trading being switched; ended: the view was torn down.
  // levelOf: the id of the open position the level message over the chart speaks of, or null.
  let ordering=null,switching=false,levelTimer=null,levelOf=null,ended=false;
  // archive: where the store keeps records ({kind,note}), asked on every load until it has answered.
  let archive=null,asking=false;
  const evalCache=new Map();
  const warn=(key,text)=>{warnings.set(key,text);};
  // A pass of the archive work stops once the series, the view or the signed-in user changed.
  const gone=(my,user)=>my!==token||owner!==user||uid()!==user;
  const shownNow=()=>{if(!visible)return false;try{return typeof isVisible==='function'?!!isVisible():true;}catch{return false;}};
  const lookbackOf=tf=>requiredLookback(tf,SIGNAL_PARAMS)+1;
  const read=f=>{try{return f();}catch{return null;}};

  // Drawing waits for the view: a frame asked for while it is hidden runs when it is shown again.
  let parked=null;
  const chartRaf=raf?fn=>{if(visible)raf(fn);else parked=fn;}:null;
  let chart=null;
  // The chart moves the shown position's SL and TP: it previews a level through the runner and commits it on a drop.
  const editor={preview:({id,kind,price})=>previewLevel(id,kind,price),commit:({id,kind,price,pointer})=>commitLevel(id,kind,price,pointer),
    cancel:({id,note})=>{if(note)levelMsg(note,true,id);}};
  const handles={sl:q('[data-fc-handle="sl"]'),tp:q('[data-fc-handle="tp"]')};
  try{chart=createChart(el.canvas,{tooltip:el.tooltip,raf:chartRaf,reducedMotion,editor,handles});}
  catch(e){el.chartNote.hidden=false;el.chartNote.textContent='Diagrammet kan inte ritas här: '+reasonOf(e);}
  // The account terminal under the chart: mounted once, updated with every paint, destroyed with the view.
  let terminal=null;
  try{
    const mount=typeof deps.mountTerminal==='function'?deps.mountTerminal:mountTerminal;
    terminal=mount(el.terminal,{runner,now,confirm,prefs:prefStorage,announce:text=>{el.terminalAnnounce.textContent=bind(text);}});
  }catch(e){terminal=null;el.terminal.textContent='Kontoterminalen kan inte visas här: '+reasonOf(e);}
  const updateTerminal=()=>{try{terminal?.update?.();}catch{/* the terminal shows its own problems */}};
  // The chart chat on the chart's right (deps.mountAsk, given by the page): a question to Claude about the chart, with
  // chartContext() as its material. Without it the toolbar has no Claude button. close hides it, draw asks for a sketch.
  let ask=null;
  if(typeof deps.mountAsk==='function')try{
    ask=deps.mountAsk(el.ask,{context:chartContext,close:()=>{view.ask=false;savePrefs();render();},
      draw:typeof deps.sketch==='function'?text=>drawSketch(text):null})??null;
    q('[data-fc-toggle="ask"]').hidden=false;
  }catch(e){ask=null;}
  // Claude's sketch of the coming candles (deps.sketch(prompt,onDelta) → {done,cancel}, the desktop app's): {symbol,tf,
  // candles,pending,job}, drawn in the chart as it streams in. Without deps.sketch the toolbar has no Rita button.
  let sketch=null;
  if(typeof deps.sketch==='function')q('[data-fc-sketchbar]').hidden=false;

  // Re-renders a region only when its HTML changed, and keeps keyboard focus on the same control.
  function patch(node,html){
    if(!node||node.__fcHtml===html)return;
    const doc=node.ownerDocument??globalThis.document,active=doc?.activeElement;
    const key=active&&node.contains?.(active)?active.getAttribute?.('data-fc-key'):null;
    node.innerHTML=html;node.__fcHtml=html;
    if(key)for(const x of node.querySelectorAll('[data-fc-key]'))if(x.getAttribute('data-fc-key')===key){x.focus?.({preventScroll:true});break;}
  }
  // A control that is disabled or removed when its action ends drops keyboard focus to the page. When the action ends,
  // focus returns to that control (or, when it is gone or disabled, to `fallback`) unless the user has moved on. A
  // browser can still report a control it has just disabled or removed as the focused one until its next frame (Chrome
  // does), so such a control counts as having lost focus.
  function holdFocus(fallback=null){
    const doc=root.ownerDocument??globalThis.document,from=doc?.activeElement;
    if(!from||!root.contains?.(from))return ()=>{};
    const key=from.getAttribute?.('data-fc-key');
    return ()=>{
      const at=doc.activeElement;
      if(!visible||at&&at!==doc.body&&!at.disabled&&at.isConnected!==false)return;
      const again=root.contains(from)?from:key?[...root.querySelectorAll('[data-fc-key]')].find(x=>x.getAttribute('data-fc-key')===key):null;
      (again&&!again.disabled?again:fallback)?.focus?.({preventScroll:true});
    };
  }

  // ---- Chart data: load, store, list -------------------------------------------
  // A series reads only while it is the one shown, so a superseded load, a replaced series or a hidden
  // view stops at its next request.
  function seriesFor(symbol,tf){
    let s=null;
    s=createLiveSeries({grab:(url,options)=>series===s?grab(url,options):Promise.reject(Error('Hämtningen avbröts')),symbol,tf,now,count:HISTORY});
    return s;
  }
  // The default archive falls back to localStorage or memory when IndexedDB cannot be used; the store says
  // which, and why. A call that fails or times out is asked again on the next load.
  function askArchive(){
    if(archive||asking||typeof store.info!=='function')return;
    asking=true;
    Promise.resolve().then(()=>store.info()).then(v=>{if(typeof v?.kind==='string')archive=v;},()=>{})
      .finally(()=>{asking=false;if(archive)render();});
  }
  function load(){
    const my=++token,symbol=view.symbol,tf=view.tf,reuse=kept?.symbol===symbol&&kept.tf===tf?kept:null;
    let s=series=reuse??seriesFor(symbol,tf);
    kept=null;
    signals=[];forecasts=[];older=0;shown=versions;broken={signals:0,forecasts:0};odd={signal:new Set(),forecast:new Set()};
    evaluation=null;evaluatedAt=null;windowGap=false;done=null;tried=null;backfill=false;forecastNote='';opened=null;choice=null;
    picked=null;revealed=null;warnings=new Map();failures={};shownPrice=null;owner=null;listed=false;loading=true;pass=null;
    // The last series' price flash would otherwise blink on the new series' empty price.
    clearTimeout(flash);el.last.classList.remove('up','down');
    const me=polling={at:now()};
    status=dataStatus(null,now(),tf);
    el.canvas.setAttribute('aria-label',symbol+' · '+TF[tf].label+': candlestick-diagram med Bybits USDT-perpetualpriser, sparade köp- och säljsignaler och en grå prognos (Forecast — estimated scenario). Dra för att panorera, scrolla för att zooma. Piltangenter panorerar, plus och minus zoomar, 0 återställer.');
    askArchive();
    render();
    current=(async()=>{
      try{
        // The series hidden last catches up with one poll; one still busy with a read that never settled is replaced.
        if(reuse&&(await s.poll())?.skipped&&my===token)s=series=seriesFor(symbol,tf);
        if(s!==reuse)await s.load();
        if(my!==token||series!==s)return;
        // The candles are in: polls go on while the archive pass below is busy. The signal card shows the newest
        // closed candle's evaluation at once instead of waiting for that pass.
        loading=false;if(polling===me)polling=null;evaluate(s.state().bars,tf);render();
        await ingest(my);
      }
      catch(e){if(my===token)warn('load','Diagrammet kunde inte uppdateras: '+reasonOf(e));}
      finally{if(my===token){loading=false;if(polling===me)polling=null;render();}}
    })();
    return current;
  }
  // After every load or poll: the data status and the latest evaluation, then one archive pass at a time:
  // new signals and the forecast for the newest closed candle, made only from reliable data.
  async function ingest(my){
    const s=series;if(!s)return;
    const st=s.state(),tf=s.tf,symbol=s.symbol,closed=st.bars,user=uid();
    status=dataStatus(st,now(),tf,{lookback:lookbackOf(tf)});
    const reliable=status.reliable;
    evaluate(closed,tf);
    // Records, choices and warnings belong to the signed-in user.
    if(user!==owner){
      owner=user;signals=[];forecasts=[];older=0;broken={signals:0,forecasts:0};odd={signal:new Set(),forecast:new Set()};
      done=null;tried=null;listed=false;opened=null;choice=null;picked=null;revealed=null;warnings=new Map();failures={};
    }
    if(st.revised.length){const n=st.revised.length;warn('revised','Bybit har ändrat '+(n===1?'en stängd candle':n+' stängda candles')+' i efterhand (senast '+when(st.revised.at(-1)+TF[tf].ms,now())+'). Sparade signaler och prognoser är oförändrade.');}
    // A poll during a slow pass leaves its candles to the next pass; the cursors make that safe.
    if(!user||pass?.my===my&&pass.user===user)return;
    const me=pass={my,user};
    try{
      if(reliable)await storeSignals(my,user,symbol,tf,closed,st);
      if(gone(my,user))return;
      // The series is read once per load; later records are merged in as they are stored.
      if(!listed){
        listed=await relist(my,user,symbol,tf);
        if(gone(my,user))return;
        // As-of forecasts a few candles back are made once, for a series with no stored version at all.
        backfill=listed&&!forecasts.length&&!older&&!broken.forecasts&&!odd.forecast.size;
      }
      if(reliable)await storeForecasts(my,user,symbol,tf,closed,st);
      if(gone(my,user))return;
      if(!opened&&forecasts.length)opened=firstCompared(closed.at(-1)?.t).id;
    }finally{if(pass===me){pass=null;if(!gone(my,user))render();}}
  }
  // What 'Jämför med' shows after a show, a reload or a switch of coin or timeframe: the newest stored version that
  // already has a closed outcome (the first quick pick), so saved forecasts lie as outlines behind the real candles at
  // once; the newest version only while none has one. It then stays for the visit while new candles close.
  const firstCompared=lastT=>[...forecasts].reverse().find(r=>finite(lastT)&&r.cutoff<lastT)??forecasts.at(-1);
  // A record this view stored, or the identical one already stored (verified by the store), joins the
  // list in the store's own order.
  const byKey=(a,b)=>a.id<b.id?-1:a.id>b.id?1:0;
  const ORDER={signal:(a,b)=>a.barTime-b.barTime||byKey(a,b),forecast:(a,b)=>a.cutoff-b.cutoff||a.createdAt-b.createdAt||byKey(a,b)};
  const merged=(list,record,kind)=>!record||list.some(r=>r.id===record.id)?list:[...list,record].sort(ORDER[kind]);
  // At most `shown` forecast versions stay in memory (the newest) plus the opened and the chosen one;
  // the version select offers the older ones on request.
  function bound(list){
    const cut=list.length-shown;
    if(cut<=0)return list;
    const keep=list.filter((r,i)=>i>=cut||r.id===opened||r.id===choice);
    older+=list.length-keep.length;
    return keep;
  }
  function damage(){
    const n=broken.signals+broken.forecasts,m=odd.signal.size+odd.forecast.size;
    if(n)warn('corrupt',(n===1?'En sparad post':n+' sparade poster')+' klarar inte kontrollsumman och visas inte. Originalen lämnas orörda.');
    else warnings.delete('corrupt');
    if(m)warn('odd',(m===1?'En sparad post har':m+' sparade poster har')+' ett ogiltigt innehåll och visas inte. Originalen lämnas orörda.');
    else warnings.delete('odd');
  }
  function keep(kind,r){
    if(!r)return;
    if(!wellFormed(r,kind)){odd[kind].add(r.id);damage();return;}
    if(kind==='signal')signals=merged(signals,r,'signal');else forecasts=bound(merged(forecasts,r,'forecast'));
  }
  // Failed writes are counted per kind, so an archive that is full shows one line, not one per candle.
  function saveFailed(kind,label,e){
    const f=failures[kind]={n:(failures[kind]?.n??0)+1,since:failures[kind]?.since??now()},why=reasonOf(e);
    const one=kind==='s'?'Signalen för '+label:'Prognosen med data t.o.m. '+label;
    warn('save-'+kind,f.n===1?one+' kunde inte sparas: '+why:
      f.n+(kind==='s'?' signaler':' prognoser')+' kunde inte sparas sedan '+when(f.since,now())+' (senast '+(kind==='s'?'':'data t.o.m. ')+label+'): '+why);
  }
  function evaluate(closed,tf){
    const last=closed.at(-1);
    if(!last){evaluation=null;evaluatedAt=null;windowGap=false;return;}
    if(evaluatedAt===last.t&&evaluatedTf===tf)return;
    const need=requiredLookback(tf,SIGNAL_PARAMS),i=closed.length-1;
    windowGap=i>=need&&closed[i].t-closed[i-need].t!==need*TF[tf].ms;
    evaluation=read(()=>evaluateBar(closed,i,{tf,params:SIGNAL_PARAMS}));evaluatedTf=tf;evaluatedAt=last.t;
  }
  // Bybit's clock now: its last answer's time plus the time since, so a record never reads as made before the
  // candle that closed it ended when this computer's clock runs a little behind. The page's clock without one.
  const bybitNow=st=>finite(st?.serverTime)&&finite(st?.lastOk)?Math.max(st.serverTime,st.serverTime+now()-st.lastOk):now();
  // The runner's rule: SIGNAL_PARAMS, TF[tf].ms, reliable data only, and no record for a candle whose
  // lookback window misses a candle, so the chart and the runner store the same record.
  async function storeSignals(my,user,symbol,tf,closed,st){
    const T=TF[tf],need=requiredLookback(tf,SIGNAL_PARAMS),last=closed.at(-1);
    if(!last||closed.length<=need||done!==null&&last.t<=done)return false;
    const from=done===null?need:Math.max(need,closed.findIndex(b=>b.t>done)),sub=closed.slice(from-need);
    const ctx={tf,params:SIGNAL_PARAMS,ind:computeIndicators(sub,SIGNAL_PARAMS),htfBars:T.htf?aggregateClosed(sub,tf,T.htf,last.t+T.ms):[]};
    const index=new Map(sub.map((b,k)=>[b.t,k])),whole=e=>{const k=index.get(e.t);return sub[k].t-sub[k-need].t===need*T.ms;};
    const found=signalsInRange(sub,need,sub.length-1,ctx).filter(whole);
    for(const e of found){
      // Stamped with Bybit's clock, and never before the close that confirmed the signal.
      const close=e.t+T.ms,recordedAt=Math.max(bybitNow(st),close),label=symbol+' '+when(close,recordedAt,{date:true});
      try{
        const record=signalRecord(user,symbol,tf,e,{recordedAt,origin:recordedAt-close<=T.ms?'live':'backfill',params:SIGNAL_PARAMS,tfMs:T.ms});
        const res=await store.putSignal(record);
        if(gone(my,user))return;
        if(res.conflict)warn('s'+e.t,'Den sparade signalen för '+label+' skiljer sig från en ny beräkning — originalet behålls');
        else keep('signal',res.stored?record:res.existing);
      }catch(err){if(!gone(my,user))saveFailed('s',label,err);}
      if(gone(my,user))return;
    }
    done=last.t;
  }
  async function storeForecasts(my,user,symbol,tf,closed,st){
    const T=TF[tf],c=closed.length-1,min=forecastMin(),jobs=[];
    if(c<0)return false;
    const have=t=>forecasts.some(r=>r.cutoff===t),latest=closed[c].t;
    if(!have(latest)&&tried!==latest){jobs.push([c,'live']);tried=latest;}
    if(backfill){backfill=false;for(const k of BACKFILL)if(c-k>=0&&!have(closed[c-k].t))jobs.push([c-k,'backfill']);}
    // A version is stamped with Bybit's clock, the one that closed its candle, so it never reads as made
    // before its data ended when this computer's clock runs a little behind.
    const created=()=>bybitNow(st);
    let features=null;
    for(const [i,origin] of jobs){
      const note=text=>{if(origin==='live')forecastNote=text;};
      if(i<min){note('För kort historik för prognos');continue;}
      if(closed[i].t-closed[i-min].t!==min*T.ms){note('Lucka i datan — ingen ny prognos');continue;}
      let f;
      try{features??=forecastFeatures(closed);f=forecastAt(closed,i,{tf,params:FORECAST_PARAMS,features});}
      catch(e){note('Prognosen kunde inte beräknas: '+reasonOf(e));continue;}
      if(!f.ok){note(f.reason);continue;}
      note('');
      const label=when(f.cutoff+T.ms,now(),{date:true});
      try{
        const record=forecastRecord(user,symbol,tf,f,{createdAt:created(),origin,tfMs:T.ms}),res=await store.putForecast(record);
        if(gone(my,user))return;
        if(res.conflict)warn('f'+f.cutoff,'Den sparade prognosen med data t.o.m. '+label+' skiljer sig från en ny beräkning — originalet behålls');
        else keep('forecast',res.stored?record:res.existing);
      }catch(e){if(!gone(my,user))saveFailed('f',label,e);}
      if(gone(my,user))return;
    }
  }
  // The store pages a series by the time inside each id (a forecast's cutoff), then by the id.
  const idTime=id=>Number(String(id).split('|').at(-2));
  // Bounded reads: the store reads and checks only the newest `shown` forecast versions and the newest HISTORY
  // signals (no more fit the loaded candles), so a show or a switch never reads the whole archive. They are
  // merged with what is already in memory. Resolves whether the archive could be read.
  async function relist(my,user,symbol,tf,{withSignals=true}={}){
    try{
      const [s,f]=await Promise.all([withSignals?store.listSignals(user,symbol,tf,{limit:HISTORY}):null,store.listForecasts(user,symbol,tf,{limit:shown})]);
      if(gone(my,user))return false;
      const sane=(list,kind)=>list.filter(r=>{const ok=wellFormed(r,kind);if(!ok)odd[kind].add(r.id);return ok;});
      const union=(a,b,kind)=>{const m=new Map(a.map(r=>[r.id,r]));for(const r of b)if(!m.has(r.id))m.set(r.id,r);return [...m.values()].sort(ORDER[kind]);};
      if(s){signals=union(sane(s.records,'signal'),signals,'signal');broken.signals=s.corrupt.length;}
      const list=union(sane(f.records,'forecast'),forecasts,'forecast'),next=f.next??null,edge=idTime(next);
      // Stored versions not in memory: those before the page, less the ones still kept from before (the opened
      // and the chosen one). A store without pages returns the whole series, and bound() counts what it drops.
      older=Math.max(0,(f.older??0)-(next===null?0:list.filter(r=>r.cutoff<edge||r.cutoff===edge&&r.id<next).length));
      forecasts=bound(list);
      broken.forecasts=f.corrupt.length;warnings.delete('list');
      damage();
      return true;
    }catch(e){if(!gone(my,user))warn('list','Prognosarkivet kunde inte läsas: '+reasonOf(e));return false;}
  }
  // "Visa äldre versioner": the list grows by `versions`, read again as one page of the newest ones, so the
  // versions that left memory while new ones arrived come back with the older ones.
  async function more(){
    const my=token,user=owner,s=series;
    if(!s||!user)return;
    shown+=versions;
    if(await relist(my,user,s.symbol,s.tf,{withSignals:false})&&!gone(my,user))render();
  }
  async function poll(){
    if(!series)return;
    if(polling){if(now()-polling.at>STUCK_MS)await revive();return;}
    if(loading)return;
    const my=token,s=series,me=polling={at:now()};
    let work=null;
    try{await s.poll();if(my===token&&series===s&&shownNow())work=ingest(my);}
    catch(e){if(my===token)warn('load','Diagrammet kunde inte uppdateras: '+reasonOf(e));}
    finally{if(polling===me){polling=null;render();}}
    // The candles and the status are painted; the records of this candle follow when the archive answers.
    try{await work;}catch(e){if(my===token)warn('load','Diagrammet kunde inte uppdateras: '+reasonOf(e));}
  }
  // A read that never settles keeps its series busy, so every later poll would be skipped: after STUCK_MS
  // a fresh series of the same candles takes over, and the stuck one can no longer read.
  async function revive(){
    const my=token,s=series=seriesFor(series.symbol,series.tf),me=polling={at:now()};
    let work=null;
    try{await s.load();if(my===token&&series===s){loading=false;if(shownNow())work=ingest(my);}}
    catch(e){if(my===token)warn('load','Diagrammet kunde inte uppdateras: '+reasonOf(e));}
    finally{if(polling===me){polling=null;render();}}
    try{await work;}catch(e){if(my===token)warn('load','Diagrammet kunde inte uppdateras: '+reasonOf(e));}
  }

  // ---- Painting ------------------------------------------------------------------
  const byId=id=>id?forecasts.find(r=>r.id===id)??null:null;
  const compareRecord=()=>byId(choice)??byId(opened)??forecasts.at(-1)??null;
  // The signal card lists the five newest stored signals; the one whose row is open is drawn with its levels.
  const recentSignals=()=>signals.slice(-5).reverse();
  const pickedRecord=()=>picked?recentSignals().find(r=>r.id===picked)??null:null;
  const lastCandle=()=>{const st=series?.state();return st?st.forming??st.bars.at(-1)??null:null;};
  const decimals=()=>priceDecimals(lastCandle()?.c);
  // The decimals of a coin's price tick on Bybit, from the limits the runner holds, kept once seen (a tick does not change)
  // as the terminal keeps them; null until then. Executed and risk prices and the price now are written with them, as the
  // terminal and the order's result line write them (85 283,7 on BTC, 0,000004305 on PEPE).
  const ticks=new Map();
  function tickOf(symbol){
    const f=can('limits')?read(()=>runner.limits(symbol))?.filters:null;
    if(finite(f?.tickSize)&&f.tickSize>0)ticks.set(symbol,stepDecimals(f.tickSize));
    return ticks.get(symbol)??null;
  }
  // A stop or a target as the runner and the terminal write it once the tick is known (levelDecimals: the chart's decimals
  // for a price of its size, more where it has them, never more than the tick: nine on PEPE, not the chart's ten).
  const levelPlaces=(x,symbol)=>{const tick=tickOf(symbol);return tick===null?decimals():levelDecimals(x,tick);};
  // 'Data t.o.m.' is the cutoff candle's close; on 4h and daily candles it always carries its date.
  const dataEnd=(r,t)=>when(r.cutoffClose,t,{date:(TF[r.tf]?.ms??0)>=4*HOUR});
  // The data end first: it tells versions apart, while backfills made together share their creation time.
  const versionText=(r,t)=>'data t.o.m. '+dataEnd(r,t)+' · skapad '+when(r.createdAt,t)+(r.origin==='backfill'?' · efterhand':'');
  // The chart's data status, worded about the chart. dataStatus() ends every problem with "nya demoaffärer
  // pausade", but the account reads its own candles and may trade on (another coin or timeframe): the pause is
  // said only when the runner reports this coin unreliable on the account's timeframe. account: the runner's status.
  const PAUSE=/ — nya demoaffärer pausade$/;
  function chartStatus(){
    const account=read(()=>runner.status()),text=String(status.text??'').replace(PAUSE,''),symbol=series?.symbol??view.symbol;
    // Only auto-trading takes signal entries, so with it off nothing is paused.
    const paused=account?.auto!==false&&Array.isArray(account?.unreliable)&&account.unreliable.includes(symbol);
    return {text:paused?text+' — nya demoaffärer i '+symbol+' pausade':text,paused,account};
  }
  function render(){
    follow();
    if(!visible)return;
    // The status ages between reads too, so a read that never returns cannot leave it on 'Live'.
    if(series&&!loading)status=dataStatus(series.state(),now(),series.tf,{lookback:lookbackOf(series.tf)});
    // An open row whose signal has left the five newest (a newer one was stored) leaves no row to close: the pick is
    // dropped, and a chart moved to its candle returns to the latest data, as closing the row would.
    const back=picked&&!pickedRecord()?unpick():false;
    paintHeader();paintTicket();paintToolbar();paintChart();paintSignal();paintForecast();paintAccount();paintEval();
    updateTerminal();
    if(back)chart?.scrollToLatest();
  }
  // The runner's onChange (the account changed or a tick ended) and the end of every refreshLive.
  function paint(){
    follow();
    if(visible)render();
    if(summaryEl)renderSummary(null);
  }
  // Per-user UI state never carries over to the next user on this page: unsaved settings, the last
  // messages, a walk-forward run or result and the account card are cleared when the signed-in user changes.
  function follow(){
    const user=uid();
    if(user===uiUser)return;
    const first=uiUser===undefined;uiUser=user;
    if(first)return;
    dirty=false;filled=null;evalToken++;evalRun=null;evalResult=null;evalCache.clear();
    accountMsg('',false);settingsMsg('',false);ticketMsg('',false);levelMsg('',false);el.progress.textContent='';el.evalAnnounce.textContent='';
    patch(el.account,'');patch(el.result,'');fillSettings(ACCOUNT.defaults);
  }
  function paintHeader(){
    const T=TF[view.tf],last=lastCandle(),p=last?.c,dec=tickOf(series?.symbol??view.symbol)??decimals();
    el.pair.textContent=view.symbol+' · USDT-perp · '+T.label;
    el.last.textContent=finite(p)?fixed(p,dec):'–';
    if(finite(p)&&finite(shownPrice)&&p!==shownPrice&&!reducedMotion()){
      el.last.classList.remove('up','down');el.last.classList.add(p>shownPrice?'up':'down');
      clearTimeout(flash);flash=setTimeout(()=>el.last.classList.remove('up','down'),600);flash?.unref?.();
    }
    shownPrice=finite(p)?p:shownPrice;
    const [kind,label]=status.state==='gap'&&/^För kort historik/.test(status.text)?['warn','Kort historik']:PILL[status.state]??PILL.loading;
    el.pill.setAttribute('data-state',kind);el.pillText.textContent=label;
    // The banner names the series whose candles it is about; unless the account pauses this coin, the account's
    // own state stands beside it, since the account reads its own candles.
    const bad=!status.reliable&&status.state!=='loading',cs=bad?chartStatus():null,said=bad?view.symbol+' '+T.label+': '+cs.text:'';
    // The pill's hover text is the chart's status as the banner words it, so it never claims a pause the account does not make.
    el.pill.setAttribute('title',cs?cs.text:String(status.text??''));
    // Screen readers hear a change of data state once (and when the account pauses this coin), not every poll's new age.
    const key=status.state+(cs?.paused?'|paused':'');
    if(key!==announced){announced=key;el.announce.textContent=status.state==='live'?'Datan är live':status.state==='loading'?'':said;}
    el.banner.hidden=!bad;el.banner.textContent=bad?said+(cs.paused||!cs.account?.text?'':' · Demokontot: '+bind(cs.account.text)):'';
  }
  function paintToolbar(){
    el.symbol.value=view.symbol;
    for(const b of root.querySelectorAll('[data-fc-tf]'))b.setAttribute('aria-pressed',String(b.getAttribute('data-fc-tf')===view.tf));
    for(const b of root.querySelectorAll('[data-fc-horizon]'))b.setAttribute('aria-pressed',String(+b.getAttribute('data-fc-horizon')===view.horizon));
    for(const b of root.querySelectorAll('[data-fc-toggle]'))b.setAttribute('aria-pressed',String(!!view[b.getAttribute('data-fc-toggle')]));
    if(ask){const open=view.ask;el.ask.hidden=!open;el.wrap.classList.toggle('fc-asking',open);if(open)ask.show?.();}
    const draw=q('[data-fc-sketch]');
    if(draw){const busy=!!sketch?.pending;draw.textContent=busy?'Ritar… stoppa':'✦ Rita';draw.setAttribute('aria-pressed',String(busy));
      q('[data-fc-sketch-clear]').hidden=!sketch||busy;}
    // Newest first: the versions kept in memory (the compared one always among them), then older ones on request.
    const t=now(),latest=forecasts.at(-1),cmp=compareRecord(),list=[...forecasts].reverse();
    patch(el.compare,list.length?list.map(r=>`<option value="${esc(r.id)}"${r===cmp?' selected':''}>${esc(versionText(r,t)+(r===latest?' · senaste':''))}</option>`).join('')+
      (older?`<option value="${OLDER}">Visa äldre versioner (${older} till)…</option>`:''):
      '<option value="">Ingen sparad prognos ännu</option>');
    el.compare.value=cmp?.id??'';el.compare.disabled=!list.length;
    // Quick picks: the newest earlier versions whose candles already have outcomes.
    const lastT=series?.state().bars.at(-1)?.t,ms=TF[view.tf].ms,ready=finite(lastT)?list.filter(r=>r.cutoff<lastT).slice(0,4):[];
    patch(el.chips,ready.map(r=>`<button type="button" class="fc-chip" data-fc-chip="${esc(r.id)}" data-fc-key="chip:${esc(r.id)}" aria-pressed="${r===cmp}" title="${esc('Jämför med prognosen '+versionText(r,t))}">t.o.m. ${esc(dataEnd(r,t))} · ${Math.min(view.horizon,Math.round((lastT-r.cutoff)/ms))} utfall</button>`).join(''));
    el.chips.hidden=!ready.length;
  }
  function paintChart(){
    // A level change's result speaks of its position: once that has closed (its SL or TP, a liquidation or Stäng) it goes.
    if(levelOf!==null&&!positionOf(levelOf))levelMsg('',false);
    // The chart's frame turns amber with the status pill while the data is not live.
    el.wrap?.classList.toggle('fc-stale',!status.reliable&&status.state!=='loading');
    if(!chart)return;
    const s=series,st=s?.state();
    if(!st){chart.setData(null);return;}
    const account=read(()=>runner.account()),latest=forecasts.at(-1)??null,pick=pickedRecord();
    // A picked signal's own levels replace the live lines of that same signal, never doubled; a position's stay.
    const same=l=>!!pick&&l.from===pick.barTime&&l.kind!=='liq'&&l.price===pick[l.kind]&&l.edit===undefined;
    const positions=Array.isArray(account?.positions)?account.positions:[];
    // The signed-in user moves the shown coin's position's SL and TP on the chart.
    const held=positions.find(p=>p.symbol===s.symbol),edit=held&&uid()&&can('setLevels')&&can('quoteLevels')?held.id:null;
    // With Bybit's tick known, the position's entry and liquidation tags have its decimals, the figures the terminal shows,
    // and its SL and TP read as the runner and the terminal write them (levelDecimals): finer than the chart's price
    // precision where the tick is (69 090,4 on BTC), never finer than the tick (nine decimals on PEPE). The last price's
    // tag has the tick's decimals too, as the header and Positioner's Pris.
    const tick=tickOf(s.symbol);
    const exact=l=>!held||tick===null||l.edit!==held.id?l:l.kind==='entry'||l.kind==='liq'?{...l,text:l.label+' '+fixed(l.price,tick)}:
      l.kind==='sl'||l.kind==='tp'?{...l,text:l.label+' '+fixed(l.price,levelDecimals(l.price,tick))}:l;
    const levels=chartLevels({symbol:s.symbol,tf:s.tf,positions,signals,bars:st.bars}).filter(l=>!same(l)).map(exact);
    // The version kept from when the chart opened is drawn only where its outcome is known; one the user picked also ahead.
    chart.setData({symbol:s.symbol,tf:s.tf,dec:decimals(),tick,bars:st.bars,forming:st.forming,
      // Prognos off hides AI Forecast's candles, band and compared version; Claude's sketch is its own.
      latest:view.forecast?latest:null,compare:view.forecast?compareRecord():null,claude:sketch,
      compareAhead:!!byId(choice),horizon:view.horizon,signals,levels,picked:pick,edit,
      showBand:view.band,showSignals:view.signals,showLevels:view.levels,
      status:{reliable:status.reliable,text:status.reliable?status.text:chartStatus().text,state:status.state},
      // 'Data t.o.m.' as the version list and the Prognos card write it: with the date and year when not today's.
      dataEnd:latest?dataEnd(latest,now()):null,
      // Without any version the chart says why there is none (too short a history, a gap), as the Prognos card does.
      note:!view.forecast||forecasts.length?null:forecastNote||null});
  }
  function paintSignal(){
    const s=series;if(!s){patch(el.signal,'');return;}
    const T=TF[s.tf],t=now(),e=evaluation,dec=decimals(),closedT=s.state().bars.at(-1)?.t;
    let html='';
    // Candles on their way, then the evaluation of the newest closed one (made right after the load); the data
    // status only when there are no candles at all.
    if(!e)html=`<p class="fc-muted">${loading?'Hämtar candles från Bybit…':!finite(closedT)?esc(chartStatus().text):
      evaluatedAt===closedT?'Signalen kunde inte beräknas för den senaste stängda candlen.':'Beräknar signalen…'}</p>`;
    else if(windowGap)html=`<p class="fc-warn">Lucka i datan före candlen som stängde ${esc(when(e.t+T.ms,t))} — ingen bedömning förrän datan är hel.</p>`;
    else{
      if(!status.reliable)html+=`<p class="fc-warn">${esc(chartStatus().text)}</p>`;
      html+=`<div class="fc-signal-top">${e.side==='long'?'<span class="fc-badge long">▲ KÖP</span>':e.side==='short'?'<span class="fc-badge short">▼ SÄLJ</span>':'<span class="fc-badge none">INGEN SIGNAL</span>'}`+
        `<span class="fc-regime" data-regime="${esc(e.regime)}">${esc(regimeName(e.regime)??e.regime)}</span></div>`+
        `<ul class="fc-checks">${e.checks.map(c=>`<li class="${c.ok?'ok':'no'}"><span class="fc-mark" aria-hidden="true">${c.ok?'✓':'–'}</span><span class="fc-check-label">${esc(c.label)}</span><b>${esc(checkText(c,e,dec))}</b><span class="fc-sr">${c.ok?' uppfyllt':' inte uppfyllt'}</span></li>`).join('')}</ul>`+
        `<ul class="fc-lines">${e.explanation.map(x=>`<li>${esc(keepNumbers(x))}</li>`).join('')}</ul>`+
        (e.side?`<dl class="fc-levels">${[['Entry',e.entry],['SL',e.sl],['TP',e.tp]].map(([k,v])=>`<div><dt>${k}</dt><dd>${price(v,dec)}</dd></div>`).join('')}</dl>`:'')+
        `<p class="fc-muted">Bekräftad ${esc(when(e.t+T.ms,t,{date:T.ms>=4*HOUR}))} när candlen stängde</p>`;
    }
    const recent=recentSignals();
    // The times are when the candle closed and confirmed the signal; the chart marks the candle itself, which opened one candle earlier.
    html+='<h3>Senaste sparade signaler <span class="fc-h3-note">· tid när candlen stängde</span></h3>'+(recent.length?`<ol class="fc-recent">${recent.map((r,k)=>signalRow(r,k,t,dec)).join('')}</ol>`:
      `<p class="fc-muted">Inga sparade signaler för ${esc(s.symbol+' '+T.label)} ännu.</p>`);
    patch(el.signal,html);
  }
  // A stored signal's row is a button that opens what its own record says (never a new calculation): side,
  // regime, the close that confirmed it, entry, SL, TP and its explanation lines. While it is open the chart
  // draws the signal's entry, SL and TP from its candle on.
  function signalRow(r,k,t,dec){
    const open=r.id===picked,id='fcSignal'+k,long=r.side==='long',confirmed=when(r.confirmedAt,t,{date:true}),regime=regimeName(r.regime);
    const lines=(Array.isArray(r.explanation)?r.explanation:[]).filter(x=>typeof x==='string'&&x.trim());
    const detail=!open?'':`<p class="fc-sig-meta">${regime?`<span class="fc-regime" data-regime="${esc(r.regime)}">${esc(regime)}</span>`:''}`+
      `<span>Bekräftad ${esc(confirmed)} när candlen stängde${r.origin==='backfill'?' · efterhand':''}</span></p>`+
      `<dl class="fc-levels">${[['Entry',r.entry],['SL',r.sl],['TP',r.tp]].map(([name,v])=>`<div><dt>${name}</dt><dd>${price(v,dec)}</dd></div>`).join('')}</dl>`+
      (lines.length?`<ul class="fc-lines">${lines.map(x=>`<li>${esc(keepNumbers(x))}</li>`).join('')}</ul>`:'')+
      '<p class="fc-muted">Ur den sparade signalen. Diagrammet visar dess entry, SL och TP från signalens candle tills raden stängs.</p>';
    return `<li class="fc-sig${open?' open':''}"><button type="button" class="fc-sig-row" data-fc-sig="${esc(r.id)}" data-fc-key="sig:${esc(r.id)}" aria-expanded="${open}" aria-controls="${id}">`+
      `<time>${esc(confirmed)}</time><b class="fc-dir ${long?'long':'short'}">${long?'▲ KÖP':'▼ SÄLJ'}</b><span class="fc-num">${price(r.entry,dec)}</span>`+
      `<small>${r.origin==='backfill'?'efterhand ':''}<span class="fc-chev" aria-hidden="true">▾</span></small></button>`+
      `<div class="fc-sig-detail" id="${id}"${open?'':' hidden'}>${detail}</div></li>`;
  }
  // Opening a row picks its signal: the chart draws its levels and, when its candle is out of view, moves there.
  // Closing the row drops it; a chart moved for it returns to the latest data if it followed it before and
  // nobody has moved it since.
  function togglePick(id){
    const r=recentSignals().find(x=>x.id===id);
    const v=chart?read(()=>chart.view()):null,untouched=!!revealed&&v?.rightT===revealed.rightT;
    if(picked===id||!r){
      const back=unpick();render();
      if(back)chart.scrollToLatest();
      return;
    }
    const follow=untouched?revealed.follow:!!v?.follow;
    picked=id;render();
    if(chart&&read(()=>chart.reveal(r.barTime)))revealed={rightT:chart.view().rightT,follow};
    else if(!untouched)revealed=null;
  }
  // Drops the pick. Returns whether the chart goes back to the latest data: it was moved to the signal's candle,
  // followed the latest data before, and nobody has moved it since.
  function unpick(){
    const v=chart?read(()=>chart.view()):null,back=!!revealed&&revealed.follow&&v?.rightT===revealed.rightT;
    picked=null;revealed=null;
    return back;
  }
  function paintForecast(){
    const s=series;if(!s){patch(el.forecast,'');return;}
    const T=TF[s.tf],t=now(),st=s.state(),lastT=st.bars.at(-1)?.t,latest=forecasts.at(-1)??null,cmp=compareRecord();
    const k=latest?.forecast?.k??FORECAST_PARAMS.k,origin=r=>r.origin==='backfill'?'efterhand':'live';
    let html='';
    if(!latest)html=`<p class="fc-empty">${esc(forecastNote||(loading?'Hämtar candles…':status.reliable?'Ingen prognos ännu.':'Prognosen görs när datan är live: '+chartStatus().text))}</p>`;
    else{
      // The model always reaches 20 candles; the toolbar's length decides how many of them the chart shows. With data up to
      // the newest closed candle the first of them is the forming candle's period, drawn behind that candle, where it
      // shows only where it reaches beyond it: said here, so the gray candles beside it read as the rest of the length.
      const H=latest.forecast.horizon,h=Math.min(view.horizon,H),reach=h<H?`visar ${esc(h)} av ${esc(H)} candles framåt`:`${esc(H)} candles framåt`;
      const behind=latest.cutoff===lastT&&st.forming?.t===lastT+T.ms?', den första bakom candlen som pågår':'';
      // The data end first, as in the version list and the 'Jämförs med' line below.
      html=`<dl class="fc-meta"><div><dt>Visas</dt><dd>Senaste versionen · data t.o.m. ${esc(dataEnd(latest,t))} · skapad ${esc(when(latest.createdAt,t))} · ${origin(latest)}</dd></div>`+
        `<div><dt>Modell</dt><dd>${esc(latest.model)} · ${esc(k)} analoger · ${reach}${behind}</dd></div>`+
        `<div><dt>Jämförs med</dt><dd>${cmp&&cmp!==latest?esc(versionText(cmp,t)+(cmp.origin==='backfill'?'':' · live')):'samma version'}</dd></div>`+
        `<div><dt>Sparade versioner</dt><dd>${forecasts.length+older}</dd></div></dl>`;
      if(finite(lastT)&&latest.cutoff<lastT)html+=`<p class="fc-warn">Ingen version för den senaste stängda candlen ännu${forecastNote?': '+esc(forecastNote):status.reliable?'':': '+esc(chartStatus().text)}.</p>`;
      const cs=cmp?comparisonStats(cmp,st.bars,view.horizon):null;
      if(cs)html+=`<p class="fc-stats"><b>Prognos mot utfall</b> ${cs.elapsed?`${cs.elapsed} av ${cs.total} candles har utfall · scenariots medelfel ${pct(cs.mae,2)} · riktning ${cs.dirHits} av ${cs.dirN} · ${cs.in80} av ${cs.elapsed} inom 80\xa0%-bandet`:
        'Inga utfall ännu: första prognoscandlen stänger '+esc(when(cmp.cutoff+2*T.ms,t,{date:T.ms>=4*HOUR}))+'.'}</p>`;
    }
    html+=`<p class="fc-fixed">Ett möjligt scenario byggt av ${esc(k)} liknande historiska lägen, inte ett löfte. Bandet visar spridningen mellan dem.</p>`+
      `<p class="fc-research" data-fc-research="forecast">${esc(RESEARCH.forecast)}</p>`+
      `<p class="fc-muted">Statistisk analogmodell: de ${esc(k)} lägen i coinets egen historik som mest liknar nuläget, inte ett neuralt nätverk eller en språkmodell. Varje version sparas en gång och ändras aldrig.</p>`;
    // Records kept only for this visit (memory) or in localStorage's limited room: the store says why.
    if((archive?.kind==='memory'||archive?.kind==='localStorage')&&archive.note)
      html+=`<p class="${archive.kind==='memory'?'fc-warn':'fc-muted'}" data-fc-archive="${esc(archive.kind)}">${esc(archive.note)}</p>`;
    const list=[...warnings.values(),...(read(()=>runner.status().notes)??[])];
    if(list.length)html+=`<div class="fc-integrity"><h3>Integritet</h3><ul>${list.map(x=>`<li>${esc(bind(x))}</li>`).join('')}</ul></div>`;
    patch(el.forecast,html);
  }
  // Problems the runner's status line leaves out because another one takes precedence (a protection
  // check, a waiting entry or an error hides unreliable data for another coin), so none of them is hidden.
  // With auto-trading off no signal is traded, so unreliable data pauses nothing and no pause is claimed.
  function hiddenProblems(st){
    if(!st||['signed-out','loading','inactive'].includes(st.state))return [];
    const out=[],manual=st.auto===false,text=x=>manual?String(x).replace(PAUSE,''):x;
    if(st.state!=='unreliable')for(const x of st.unreliable??[])out.push('Data opålitlig för '+x+(st.data?.[x]?.text?': '+text(st.data[x].text):manual?'':' — nya affärer pausade'));
    if(st.state!=='waiting'){
      if(st.protection)out.push('Väntar på '+st.protection);
      for(const [x,why] of Object.entries(st.waiting??{}))out.push('Väntar på ny affär i '+x+': '+why);
    }
    return out;
  }
  const tile=(label,value,cls='')=>`<div class="fc-tile"><span>${label}</span><b class="${cls}">${value}</b></div>`;
  function decisionText(last,t){
    const T=TF[last.tf],what=last.side==='long'?'köpsignal':last.side==='short'?'säljsignal':'ingen signal';
    return 'Senaste beslut '+when(last.at,t)+': '+last.symbol+' '+(T?T.label+' ':'')+'candle '+when(last.t+(T?.ms??0),t)+' · '+what+
      (last.closed?' · stängde '+SIDE[last.closed.side]+' '+last.closed.symbol:'')+(last.opened?' · öppnade '+SIDE[last.opened.side]+' '+last.opened.symbol:'')+(last.reason?' · '+last.reason:'');
  }
  // The card keeps what belongs to the auto-trading of signals: the runner's status, its latest decision and the settings.
  // The money, the positions and the history are in the terminal under the chart.
  function paintAccount(){
    const st=read(()=>runner.status())??{state:'error',text:'AI Forecast-kontot kan inte läsas'},a=read(()=>runner.account()),t=now(),user=uid();
    let html=`<p class="fc-status" data-state="${esc(st.state)}"><i aria-hidden="true"></i><span>${esc(bind(st.text))}</span></p>`+
      hiddenProblems(st).map(x=>`<p class="fc-warn">${esc(bind(x))}</p>`).join('');
    if(a){
      const s=a.settings,auto=s.auto===true;
      if(st.last)html+=`<p class="fc-muted">${esc(bind(decisionText(st.last,t)))}</p>`;
      html+=`<p class="fc-muted">${auto?'Auto-handel på':'Auto-handel av'} · signaler på ${esc(TF[s.tf].label)} · ${esc(s.symbols.join(', '))} · ${esc(leverageText(s.leverage))} · `+
        `högst ${esc(s.maxOpen)} signalpositioner · konto sedan ${esc(dateText(a.createdAt))}</p>`;
      if(!auto)html+='<p class="fc-muted">Signalerna utvärderas och sparas, men inget handlas på dem. Slå på auto-handeln i orderrutan för att låta kontot handla dem med inställningarna nedan.</p>';
    }
    patch(el.account,html);
    // The label says what the button does; a changing label with aria-pressed would read backwards.
    el.pause.textContent=a?.settings.paused?'▶ Återuppta nya signalaffärer':'⏸ Pausa nya signalaffärer';
    el.pause.disabled=el.reset.disabled=!user;
    markBusy(el.pause,!!user&&acting);markBusy(el.reset,!!user&&acting);
    if(a&&!dirty){const key=JSON.stringify(a.settings);if(key!==filled){fillSettings(a.settings);filled=key;}}
    // While a save runs the form is locked; the control that has keyboard focus (Spara, or the field Enter was
    // pressed in) is only marked busy, and a field is read-only meanwhile.
    const focused=(root.ownerDocument??globalThis.document)?.activeElement;
    for(const x of el.form.querySelectorAll('input,select,button')){
      const keep=!!user&&!!a&&saving&&x===focused;
      x.disabled=!user||!a||saving&&!keep;markBusy(x,keep);
      if(x.localName==='input')x.readOnly=keep;
    }
  }
  function fillSettings(s){
    const f=el.form,set=(name,v)=>{const x=f.querySelector(`[name="${name}"]`);if(x)x.value=String(v);};
    set('positionPct',+(s.positionPct*100).toFixed(4));set('riskPct',+(s.riskPct*100).toFixed(4));set('maxOpen',s.maxOpen);set('tf',s.tf);
    const lev=f.querySelector('[name="leverage"]'),opts=[...LEVERAGES];
    if(s.leverage!=='max'&&!opts.includes(s.leverage))opts.push(s.leverage);
    lev.innerHTML=opts.sort((x,y)=>x==='max'?-1:y==='max'?1:x-y).map(v=>`<option value="${esc(v)}">${esc(leverageText(v))}</option>`).join('');
    lev.value=String(s.leverage);
    for(const box of f.querySelectorAll('input[name="symbols"]'))box.checked=s.symbols.includes(box.value);
  }
  function summaryHtml(){
    const st=read(()=>runner.status())??{state:'error',text:'AI Forecast-kontot kan inte läsas'},a=read(()=>runner.account()),live=a?read(()=>runner.live()):null;
    let html=`<div class="fc-sum"><div class="fc-sum-head"><h3>AI Forecast · demokonto</h3><span class="fc-sum-state" data-state="${esc(st.state)}">${esc(bind(st.text))}</span></div>`+
      hiddenProblems(st).map(x=>`<p class="fc-sum-note fc-sum-warn">${esc(bind(x))}</p>`).join('');
    if(a){
      const stats=read(()=>accountStats(a)),cell=(k,v,cls='')=>`<div><span>${k}</span><b class="${cls}">${v}</b></div>`;
      // Kapital and the trading result as the terminal shows them (built from the same whole cents, so the two never
      // differ by a cent): deposits and withdrawals are no gain or loss. Its share is of the money put in (the start plus
      // deposits less withdrawals), shown while that is above zero.
      const fig=terminalFigures(a,live),eq=fig.equity,net=fig.result,moved=finite(stats?.netTransfers)?stats.netTransfers:0,base=a.start+moved;
      const auto=a.settings.auto===true,signal=a.positions.filter(p=>p.origin!=='manual').length,manual=a.positions.length-signal;
      const open=auto?signal+' av '+a.settings.maxOpen+(manual?' · '+manual+(manual===1?' manuell':' manuella'):''):String(a.positions.length);
      html+=`<div class="fc-sum-grid">${cell('Kapital · live',eq===null?'–':money(eq))}${cell('Sedan start',net===null?'–':signedMoney(net)+(base>0?' · '+signedPct(net/base,1):''),tone(net))}`+
        `${cell('Öppna positioner',esc(open))}${cell('Avslutade affärer',String(stats?.trades??0))}${cell('Vinstandel',stats?.winRate==null?'–':pct(stats.winRate,0))}</div>`;
      if(eq===null&&live?.reason)html+=`<p class="fc-sum-note">${esc(bind(live.reason))}</p>`;
      // Fees are a cost; funding is its effect on the result (− paid, + received), as the terminal's Historik writes them.
      if(stats)html+=`<p class="fc-sum-note">Kontots egen historik: netto ${signedMoney(stats.net)} · max nedgång ${pct(stats.maxDrawdown,1)} · vinstfaktor ${num(stats.profitFactor,2)} · avgifter ${money(stats.fees)} · funding ${signedMoney(-stats.funding)}</p>`;
      html+=auto?`<p class="fc-sum-note">Eget demokonto från ${money(a.start)} som handlar AI Forecast-signalerna på ${esc(TF[a.settings.tf].label)} med ${a.settings.leverage==='max'?'Bybits maxhävstång':esc(leverageText(a.settings.leverage))+' hävstång'}. Inga riktiga order.</p>`:
        `<p class="fc-sum-note">Eget demokonto från ${money(a.start)} för manuell handel med Bybits priser, avgifter och gränser. Auto-handeln är av. Inga riktiga order.</p>`;
    }
    return html+'<a class="btn" href="#forecast">Öppna AI Forecast →</a></div>';
  }
  function renderSummary(target){
    if(target)summaryEl=target;
    if(summaryEl)patch(summaryEl,summaryHtml());
  }

  // ---- Walk-forward on demand -------------------------------------------------------
  function paintEval(){
    el.evalPair.textContent='Kör för '+view.symbol+' '+TF[view.tf].label;
    markBusy(el.evalPair,!!evalRun);markBusy(el.evalAll,!!evalRun);
    el.progress.textContent=evalRun?evalRun.label+': '+evalRun.text:'';
    patch(el.result,evalResult?evalHtml(evalResult):`<p class="fc-muted">Testar signalreglerna och prognosen i efterhand på Bybits historik, i fyra testfönster utanför träningsdatan och med kontots storlek, hävstång och kostnader. `+
      `Fönstren börjar tidigast ${esc(dateText(DEV_END))}, men högst ${esc(fixed(EVAL_BARS,0))} candles hämtas per par, så på 5m och 15m täcker de bara de senaste cirka ${cappedDays('5m')} respektive ${cappedDays('15m')} dagarna. `+
      `Resultatet visar testets första och sista datum. Historiken hämtas via proxy och det tar en stund.</p>`);
  }
  function evalHtml(r){
    if(r.error)return `<p class="fc-warn">${esc(r.label)}: ${esc(r.error)}</p>`;
    const w=r.result,a=w.aggregate.trading,folds=w.folds,rows=Object.values(w.aggregate.forecast).sort((x,y)=>x.h-y.h),t=now();
    return `<p class="fc-eval-head"><b>${esc(r.label)}</b> · uppmätt i efterhand ${esc(dateText(folds[0]?.test.from))} – ${esc(dateText(folds.at(-1)?.test.to))}, utanför träningsfönstren · körd ${esc(when(r.at,t))}</p>`+
      `<div class="fc-tiles">${tile('Affärer',String(a.trades))}${tile('Vinstandel',pct(a.winRate,1))}${tile('Netto',signedMoney(a.net)+' · '+signedPct(a.netPct,1),tone(a.net))}`+
      `${tile('Max nedgång',pct(a.maxDrawdownPct,1)+' · '+money(a.maxDrawdown))}${tile('Vinstfaktor',a.profitFactor===null?'–':num(a.profitFactor,2))}</div>`+
      `<p class="fc-muted">Avgifter ${money(a.fees)} · funding ${money(a.funding)} · likvidationer ${a.liquidations}</p>`+
      `<div class="fc-table-wrap"><table class="fc-table"><caption>Handel per testfönster (uppmätt)</caption><thead><tr><th scope="col">Fönster</th><th scope="col">Affärer</th><th scope="col">Netto</th><th scope="col">Max ned.</th><th scope="col">Vinstf.</th></tr></thead><tbody>`+
      folds.map((f,k)=>`<tr><th scope="row">${k+1}<small><span>${esc(dateText(f.test.from))} –</span> <span>${esc(dateText(f.test.to))}</span></small></th><td>${f.trading.trades}</td><td class="${tone(f.trading.net)}">${signedMoney(f.trading.net)}</td><td>${pct(f.trading.maxDrawdownPct,1)}</td><td>${f.trading.profitFactor===null?'–':num(f.trading.profitFactor,2)}</td></tr>`).join('')+
      `</tbody></table></div><div class="fc-table-wrap"><table class="fc-table"><caption>Prognosens medianbana mot utfall (uppmätt, fel i % av priset vid prognosen)</caption><thead><tr><th scope="col">Candles fram</th>${rows.map(x=>`<th scope="col">${x.h}</th>`).join('')}</tr></thead><tbody>`+
      [['Medelfel',x=>pct(x.mae,2)],['Naivt fel',x=>pct(x.naiveMae,2)],['Skill',x=>signedPct(x.skill,1)],['Rätt riktning',x=>pct(x.dirHit,0)],['Prognoser med riktning',x=>String(x.dirN)],
        ['Inom 50\xa0%-bandet',x=>pct(x.cover50,0)],['Inom 80\xa0%-bandet',x=>pct(x.cover80,0)],['Prognoser',x=>String(x.n)]]
        .map(([label,f])=>`<tr><th scope="row">${label}</th>${rows.map(x=>`<td>${f(x)}</td>`).join('')}</tr>`).join('')+
      `</tbody></table></div><p class="fc-muted">Skill = 1 − medelfel/naivt fel, där det naiva felet antar oförändrat pris.</p><ul class="fc-notes">${w.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul>`;
  }
  async function runEvaluation(kind){
    if(evalRun)return;
    const settings=read(()=>runner.account())?.settings??ACCOUNT.defaults;
    const pair=kind==='pair',symbols=pair?[view.symbol]:[...settings.symbols],tf=pair?view.tf:settings.tf,T=TF[tf];
    const sizing={positionPct:settings.positionPct,riskPct:settings.riskPct,maxOpen:settings.maxOpen,leverage:settings.leverage};
    const label=(pair?symbols[0]:'Portfölj '+symbols.join(', '))+' · '+T.label;
    // One result per kind of run, coins, timeframe, sizing and the last candle that had closed; the two newest are kept.
    const key=JSON.stringify([pair?'pair':'portfolio',symbols,tf,sizing,Math.floor(now()/T.ms)*T.ms-T.ms]);
    if(evalCache.has(key)){evalResult=evalCache.get(key);el.evalAnnounce.textContent='Walk-forward klar: '+label;paintEval();return;}
    // A run belongs to the user and the view that started it: leaving the view or signing out stops it at its
    // next step or request, and its result is never shown to anyone else.
    const run=++evalToken,user=uid(),alive=()=>run===evalToken&&uid()===user;
    const bybit=(url,options)=>alive()?grab(url,options):Promise.reject(Error('Walk-forward avbröts'));
    const progress=text=>{evalRun.text=text;paintEval();};
    const regain=holdFocus();
    evalRun={label,text:'Startar…'};el.evalAnnounce.textContent='Walk-forward startad: '+label;paintEval();
    let result;
    try{
      if(typeof grab!=='function')throw Error('Ingen anslutning till Bybit');
      // From before DEV_END: the first window's forecast library (FORECAST_PARAMS.train candles), the 155 candles of
      // feature windows its first analog reads, and 50 more of slack.
      const count=Math.min(EVAL_BARS,Math.ceil((now()-DEV_END)/T.ms)+forecastMin()+50),input={},contracts={};
      for(const [k,symbol] of symbols.entries()){
        progress('hämtar '+symbol+' '+T.label+' ('+(k+1)+' av '+symbols.length+')…');
        const h=await fetchHistory(bybit,symbol,tf,{count,now}),bars=splitForming(h.bars,tf,h.serverTime).closed;
        if(!alive())return;
        let funding=null;
        if(bars.length){
          progress('hämtar funding för '+symbol+'…');
          try{funding=await fetchFunding(bybit,symbol,{from:bars[0].t,to:bars.at(-1).t+T.ms,now});}catch{funding=null;}
          if(!alive())return;
        }
        input[symbol]={bars,funding};
        await defer();
        if(!alive())return;
      }
      progress('hämtar Bybits hävstångsgränser…');
      for(const symbol of symbols){
        const c=limits?await limits.load(symbol):null;
        if(!alive())return;
        if(!c)throw Error('Bybits hävstångsgränser saknas för '+symbol+' — försök igen om en stund');
        contracts[symbol]=c;
      }
      // Where the history does not reach that far before DEV_END (the EVAL_BARS cap on 5m and 15m, or a younger coin),
      // the windows start once it does, so the first window's library is as full as the backtest's note says. A
      // history too short for even that (PEPE on 1D) keeps DEV_END, so the backtest says how short it is.
      const loaded=Object.values(input).filter(x=>x.bars.length),full=loaded.length?Math.min(...loaded.map(x=>x.bars[0].t))+forecastMin()*T.ms:null;
      const minTestFrom=full!==null&&full<=Math.max(...loaded.map(x=>x.bars.at(-1).t))?Math.max(DEV_END,full):DEV_END;
      const steps=walkForwardSteps({series:input,tf,params:SIGNAL_PARAMS,settings:{...settings,tf,symbols},contracts,minTestFrom});
      let r;
      while(!(r=steps.next()).done){progress(r.value.text+' · steg '+r.value.done+' av '+r.value.total);await defer();if(!alive())return;}
      result={label,result:r.value,at:now()};
      evalCache.set(key,result);
      while(evalCache.size>2)evalCache.delete(evalCache.keys().next().value);
    }catch(e){if(alive())result={label,error:reasonOf(e),at:now()};}
    finally{
      if(alive()){
        evalResult=result;evalRun=null;
        el.evalAnnounce.textContent=result?.error?'Walk-forward misslyckades: '+label+': '+result.error:'Walk-forward klar: '+label;
        paintEval();regain();
      }
    }
  }

  // ---- Account actions: all through the runner --------------------------------------
  const accountMsg=(text,bad)=>{el.accountMsg.textContent=bind(text);el.accountMsg.classList.toggle('bad',!!bad);};
  const settingsMsg=(text,bad)=>{el.settingsMsg.textContent=bind(text);el.settingsMsg.classList.toggle('bad',!!bad);};
  // An action's message is shown only to the user who started it.
  async function act(task,message){
    if(acting)return;
    const user=uid(),regain=holdFocus();
    acting=true;paintAccount();
    try{const next=await task();if(uid()===user)accountMsg(message(next),false);}
    catch(e){if(uid()===user)accountMsg(reasonOf(e),true);}
    finally{acting=false;paint();if(uid()===user)regain();}
  }
  // The pause holds back new signal entries only; the user's own orders and the protection of open positions go on.
  const togglePause=()=>{const paused=!!read(()=>runner.account())?.settings.paused;
    return act(()=>runner.setPaused(!paused),a=>a.settings.paused?'Nya signalaffärer är pausade. Öppna positioner skyddas och stängs som vanligt, och egna order går att lägga.':
      a.settings.auto===false?'Pausen är av. Signaler handlas när auto-handeln slås på.':'Kontot tar nya signaler igen.');};
  function resetAccount(){
    if(acting||!confirm('Arkivera AI Forecast-kontot och börja om med '+ACCOUNT.start+' $? Inställningarna behålls. Öppna positioner följer med i arkivet utan att stängas.'))return;
    return act(()=>runner.reset(),()=>{dirty=false;filled=null;return 'Kontot är återställt till '+ACCOUNT.start+'\xa0$. Det gamla kontot är arkiverat.';});
  }
  async function saveSettings(){
    if(saving)return;
    const f=el.form,value=name=>String(f.querySelector(`[name="${name}"]`)?.value??'').trim();
    const number=(name,what)=>{const raw=value(name),v=Number(raw.replace(',','.'));if(!raw||!finite(v))throw Error('Ange '+what);return v;};
    let patchSettings;
    try{
      const lev=value('leverage');
      patchSettings={positionPct:+(number('positionPct','positionsstorleken i procent av kapitalet')/100).toFixed(6),
        riskPct:+(number('riskPct','risken per affär i procent av kapitalet')/100).toFixed(6),maxOpen:number('maxOpen','max antal öppna positioner'),
        leverage:lev==='max'?'max':Number(lev),tf:value('tf'),symbols:[...f.querySelectorAll('input[name="symbols"]')].filter(x=>x.checked).map(x=>x.value)};
    }catch(e){settingsMsg(e.message,true);return;}
    const before=read(()=>runner.account())?.settings.tf,user=uid(),regain=holdFocus();
    saving=true;settingsMsg('Sparar…',false);paintAccount();
    try{
      const next=await runner.updateSettings(patchSettings);
      if(uid()===user){
        dirty=false;filled=null;
        settingsMsg('Sparat. Gäller nya affärer'+(next.settings.tf!==before?'; kontot handlar nu på '+TF[next.settings.tf].label+'-candles':'')+'.',false);
      }
    }catch(e){if(uid()===user)settingsMsg(reasonOf(e),true);}
    finally{saving=false;paint();if(uid()===user)regain();}
  }

  // ---- Order ticket: the user's own market orders, and auto-trading on or off --------------------------------------
  // The result line speaks of the chart's coin as it stood when the line was written: heldAt is the id of the coin's
  // open position then, or null. Once that has changed (the position closed on its SL or TP, a liquidation or Stäng, or
  // another one opened) the line is out of date and goes, and the ticket shows what an order would open again; the
  // terminal tells how the position closed.
  let heldAt=null;
  const heldNow=a=>a?.positions?.find?.(p=>p?.symbol===view.symbol)?.id??null;
  const ticketMsg=(text,bad)=>{el.ticketMsg.textContent=bind(text);el.ticketMsg.classList.toggle('bad',!!bad);heldAt=heldNow(read(()=>runner.account()));};
  // While the ticket is shown the runner reads the chart's coin on every tick, so its preview has a fresh price.
  const watch=symbol=>{if(can('watch'))read(()=>runner.watch(symbol));};
  const levFor=symbol=>ticket.lev[symbol]??LEVERAGE;
  // The chart's coin's leverage into the ticket: its own last choice in this browser, else Bybit's default 10×.
  function fillLeverage(){const v=levFor(view.symbol);el.lev.value=field(v,Number.isInteger(v)?0:2);}
  function rememberLeverage(){
    const v=amount(el.lev.value);
    if(finite(v)&&v>=SETTING_LIMITS.leverage[0]&&v<=SETTING_LIMITS.leverage[1]){ticket.lev[view.symbol]=v;saveTicket();}
  }
  const orderParams=side=>({symbol:view.symbol,side,margin:amount(el.stake.value),leverage:amount(el.lev.value)});
  // What the account would open on this side now: previewOrder on the runner's quote and Bybit's limits, the same code
  // path the order takes.
  const quoteSide=side=>can('quoteOrder')?read(()=>runner.quoteOrder(orderParams(side))):null;
  // Max: the largest stake both sides can order, the smaller of the two sides' largest (a short reserves a larger fee to
  // close, and a buy fills higher than a sell). A side's largest has its order cost within the free cash with the fees to
  // open and close and its position within a risk tier that allows the leverage (the preview's maxMargin), and buys at
  // most Bybit's largest market order at this leverage even after the price has fallen by MKT_ROOM. null without a preview.
  function maxStake(long,short){
    const one=p=>{
      if(!finite(p?.maxMargin))return null;
      const q=p.filters?.maxMktQty,L=p.leverage;
      return finite(q)&&finite(p.fill)&&finite(L)&&L>0?Math.min(p.maxMargin,Math.floor(q*p.fill*(1-MKT_ROOM)/L*100)/100):p.maxMargin;
    };
    const v=[one(long),one(short)].filter(finite);
    return v.length?Math.min(...v):null;
  }
  // A preview's prices with the decimals of Bybit's tick, as the result line, the terminal and the chart write an order's
  // and a position's prices (the chart's decimals without the tick).
  const tickDecimals=p=>finite(p.filters?.tickSize)&&p.filters.tickSize>0?stepDecimals(p.filters.tickSize):priceDecimals(p.price);
  // A liquidation price, or – where there is none (a long at 1×: Bybit's level lies below zero), as the terminal and the
  // chart show it.
  const liqText=p=>finite(p.liq)&&p.liq>0?price(p.liq,tickDecimals(p)):'–';
  // What each side would open: its value, Bybit's order cost (the margin, the fee to open and the fee to close Bybit
  // reserves, all taken from the free cash: the figure a refusal for too little cash names) and its liquidation price.
  // The shared line has the quantity, the margin and the opening fee, each one figure when the two sides agree and else
  // their range (a buy fills a little higher than a sell, so near a quantity step their rounding can part). A phone has
  // room for the liquidation price only under each button, so its own shared line has the value and the cost instead of
  // the margin (CSS shows one of the two lines). Each part stays whole; a line breaks only before a ' · '.
  function paintEstimates(long,short){
    const sized=p=>!!p&&finite(p.qty)&&p.qty>0,both=[long,short].filter(sized);
    const put=(x,text)=>{if(x.textContent!==text)x.textContent=text;};
    for(const [side,p] of [['long',long],['short',short]]){
      const box=el.est[side],ok=sized(p);
      put(box.value,ok?'Värde '+money(p.value):'');put(box.cost,ok&&finite(p.cost)?'Kostnad '+money(p.cost):'');
      put(box.liq,ok?'Likv. '+liqText(p):'');
    }
    // One figure when the sides agree as shown, else the range of the two.
    const range=(f,num,unit)=>{
      const v=both.map(f).filter(finite).sort((x,y)=>x-y);if(!v.length)return '';
      const lo=num(v[0]),hi=num(v.at(-1));return (lo===hi?lo:lo+'–'+hi)+unit;
    };
    const step=both[0]?.filters?.qtyStep,cents=x=>fixed(x,2),label=(name,f)=>{const r=range(f,cents,'\xa0$');return r?name+'\xa0'+r:'';};
    const qty=range(p=>p.qty,x=>quantity(x,step),'\xa0'+(both[0]?.symbol??'')),line=parts=>parts.filter(Boolean).map(x=>`<span>${esc(x)}</span>`).join(' ·\xa0');
    patch(el.sharedWide,line([qty,label('marginal',p=>p.margin),label('avgift',p=>p.fee)]));
    patch(el.sharedNarrow,line([qty,label('värde',p=>p.value),label('kostnad',p=>p.cost),label('avgift',p=>p.fee)]));
  }
  function paintTicket(){
    const user=uid(),a=read(()=>runner.account()),signed=!!user&&!!a;
    if(!ordering&&el.ticketMsg.textContent&&heldNow(a)!==heldAt)ticketMsg('',false);
    // Auto-trading: the switch reads the account's setting; its name stays "Auto-handel", its state says on or off.
    const auto=a?.settings?.auto===true;
    el.auto.setAttribute('aria-checked',String(auto));el.autoText.textContent=auto?'På':'Av';
    el.auto.disabled=!signed||!can('setAuto');markBusy(el.auto,!el.auto.disabled&&switching);
    const long=quoteSide('long'),short=quoteSide('short'),coin=can('limits')?read(()=>runner.limits(view.symbol)):null;
    // Leverage: the slider reaches Bybit's maximum for this stake (lower once the size crosses a risk tier). That maximum is
    // read before the quantity is rounded down, so a leverage both sides can be ordered at (right at a tier's cap the
    // rounded position still fits) counts as within it. The hint names the coin's own maximum, or the lower one for this
    // size in a few words that never widen the ticket; screen readers and the hint's title get both.
    const sizes=[long?.maxLeverage,short?.maxLeverage].filter(x=>finite(x)&&x>0),taken=long?.ok&&short?.ok&&finite(long.leverage)?long.leverage:0;
    const sizeMax=sizes.length?Math.max(Math.min(...sizes),taken):null;
    const coinMax=finite(coin?.max)?coin.max:null,lo=Math.max(1,Math.ceil(finite(coin?.min)?coin.min:1));
    const top=Math.max(lo,Math.floor(sizeMax??coinMax??(Number(el.range.getAttribute('max'))||100))),lev=amount(el.lev.value);
    el.range.setAttribute('min',String(lo));el.range.setAttribute('max',String(top));
    if(finite(lev))el.range.value=String(clamp(Math.round(lev),lo,top));
    el.range.setAttribute('aria-valuetext',finite(lev)?leverageText(lev):'ingen hävstång');
    el.range.disabled=!signed||sizeMax===null&&coinMax===null;
    const sized=coinMax!==null&&sizeMax!==null&&sizeMax<coinMax;
    const full=!signed||!can('quoteOrder')?'':coinMax===null?'Bybits gränser hämtas…':
      'Bybit max '+leverageText(coinMax)+(sized?' · '+leverageText(sizeMax)+' vid den här storleken':'');
    const shown=sized?'Max '+leverageText(sizeMax)+' (storlek)':full;
    if(el.levHintText.textContent!==shown)el.levHintText.textContent=shown;
    if(el.levHintFull.textContent!==full)el.levHintFull.textContent=full;
    if(full)el.levHint.setAttribute('title',full);else el.levHint.removeAttribute('title');
    // 10, 25 and 50 % of the free cash; Max: the largest stake both sides can order (maxStake).
    const most=maxStake(long,short);
    for(const b of el.stakeChips)b.disabled=!signed||b.getAttribute('data-fc-stake-pct')==='max'&&most===null;
    paintEstimates(long,short);
    // Why a side cannot be ordered: the preview's first reason, said once when both sides share it (their figures as ranges).
    const r1=long?.reasons?.[0]??'',r2=short?.reasons?.[0]??'',both=r1&&r2?r1===r2?r1:mergedReason(r1,r2):null;
    el.why.textContent=bind(!can('order')||!can('quoteOrder')?'Orderrutan är inte tillgänglig här':both??[r1&&'Köp: '+r1,r2&&'Sälj: '+r2].filter(Boolean).join(' · '));
    // While an order is on its way the buttons are only marked busy, so the pressed one keeps keyboard focus.
    for(const [b,p,side] of [[el.buy,long,'long'],[el.sell,short,'short']]){
      b.disabled=ordering!==side&&!(p?.ok&&can('order'));markBusy(b,!!ordering&&!b.disabled);
      const label=ordering===side?side==='long'?'Köper…':'Säljer…':side==='long'?'Köp / Lång':'Sälj / Kort';
      if(b.textContent!==label)b.textContent=label;
    }
    // The block under the controls keeps its height (two lines): the last result until the stake, the leverage or the
    // coin changes (or the coin's position does), else why an order cannot be placed, else what it would open. While
    // neither side can be ordered, the reason stays under the result (after an order: the position now open in the coin).
    const said=el.ticketMsg.textContent,why=el.why.textContent,blocked=!ordering&&el.buy.disabled&&el.sell.disabled;
    el.why.hidden=!why||!!said&&!(blocked&&why!==said);el.shared.hidden=!!said||!!why;
    // Then each has one of the two lines (the stylesheet cuts a longer text short with an ellipsis: 'Auto-handel av: du
    // handlar manuellt. …' over the reason); alone, a text has both. A text cut short is whole in its title, and screen
    // readers get all of it.
    el.info.classList.toggle('fc-tk-two',!!said&&!el.why.hidden);
    for(const x of [el.ticketMsg,el.why]){const t=x.textContent;if(!t)x.removeAttribute('title');else if(x.getAttribute('title')!==t)x.setAttribute('title',t);}
  }
  // The question before an order, with what the preview says it opens and what it takes from the free cash: Bybit's
  // order cost, the margin, the fee to open and the fee to close that Bybit reserves with the position. Its prices have
  // the decimals of Bybit's tick, as the result line and the terminal write the fill.
  function orderQuestion(p){
    const long=p.side==='long',dp=tickDecimals(p);
    return (long?'Köpa ':'Sälja ')+quantity(p.qty,p.filters?.qtyStep)+' '+p.symbol+' ('+(long?'lång':'kort')+') till marknadspris?\n'+
      'Pris nu '+price(p.price,dp)+' · beräknat fyllnadspris '+price(p.fill,dp)+'\n'+
      'Värde '+money(p.value)+' · '+leverageText(p.leverage)+' · '+(p.liq>0?'likvidation vid '+liqText(p):'ingen likvidationsnivå')+'\n'+
      'Kostnad '+money(p.cost)+' från tillgängligt saldo: marginal '+money(p.margin)+' + avgift '+money(p.fee)+' + reserverad avgift för stängning '+money(p.reserve)+'\n'+
      'Demokonto: ingen riktig order läggs hos Bybit.';
  }
  // A market order through the runner, which reads Bybit's limits and a fresh price and opens what the preview shows.
  // Once the position is open both buttons are disabled; keyboard focus then goes to the ticket itself.
  async function placeOrder(side){
    if(ordering||!can('order'))return;
    const params=orderParams(side),p=quoteSide(side);
    if(!p?.ok){ticketMsg(p?.reasons?.[0]??'Ordern kan inte läggas just nu',true);return;}
    if(ticket.confirm&&!confirm(orderQuestion(p)))return;
    const user=uid(),regain=holdFocus(el.ticket);
    ordering=side;ticketMsg((side==='long'?'Köper ':'Säljer ')+params.symbol+'…',false);paintTicket();
    try{const r=await runner.order(params);if(uid()===user)ticketMsg(r?.text||'Ordern gav inget svar',!r?.ok);}
    catch(e){if(uid()===user)ticketMsg('Kunde inte lägga ordern: '+reasonOf(e),true);}
    finally{ordering=null;paint();if(uid()===user)regain();}
  }
  function chipStake(kind){
    const a=read(()=>runner.account());
    if(!a||!uid())return;
    let v;
    if(kind==='max'){v=maxStake(quoteSide('long'),quoteSide('short'));if(v===null)return;}
    else{const k=Number(kind);if(!CHIPS.includes(k)||!finite(a.cash))return;v=Math.floor(a.cash*k+1e-6)/100;}
    el.stake.value=field(v,2);ticket.stake=el.stake.value;saveTicket();
    if(!ordering)ticketMsg('',false);
    paintTicket();
  }
  async function toggleAuto(){
    if(switching||!can('setAuto'))return;
    const a=read(()=>runner.account());
    if(!a||!uid())return;
    const user=uid(),regain=holdFocus();
    switching=true;paintTicket();
    try{const r=await runner.setAuto(a.settings.auto!==true);if(uid()===user)ticketMsg(r?.text||'',!r?.ok);}
    catch(e){if(uid()===user)ticketMsg(reasonOf(e),true);}
    finally{switching=false;paint();if(uid()===user)regain();}
  }

  // ---- SL and TP on the chart: previewed and set through the runner ------------------------------------------------
  // The result of a level change, shown over the chart for a while. id: the position it speaks of; while that is open the
  // message goes once it closes (paintChart), as the ticket's result does. One written after it closed says how it closed.
  function levelMsg(text,bad,id=null){
    el.levelMsg.textContent=bind(text);el.levelMsg.classList.toggle('bad',!!bad);
    levelOf=text&&id!==null&&positionOf(id)?id:null;
    clearTimeout(levelTimer);levelTimer=null;
    if(text){levelTimer=setTimeout(()=>{el.levelMsg.textContent='';levelOf=null;},LEVEL_MSG_MS);levelTimer?.unref?.();}
  }
  const positionOf=id=>read(()=>runner.account())?.positions?.find(p=>p.id===id)??null;
  // The chart asks while a level is dragged: the level on Bybit's tick, its tag ('SL 84 900 · −8,40 $': the result if the
  // position closed there now, after fees and the funding so far) and why it cannot go there.
  function previewLevel(id,kind,raw){
    const name=kind==='sl'?'SL':'TP',p=positionOf(id);
    if(!p)return {ok:false,price:raw,text:name,note:'Positionen är redan stängd'};
    const f=can('limits')?read(()=>runner.limits(p.symbol))?.filters:null,value=raw===null?null:f?read(()=>roundPrice(f,raw))??raw:raw;
    const r=can('quoteLevels')?read(()=>runner.quoteLevels(id,{[kind]:value})):null;
    if(!r)return {ok:false,price:value,text:name,note:'SL och TP kan inte ändras just nu'};
    const why=r.reasons?.[0]??'';
    // Past the chart's edge a level is removed; one that is not set (a ghost tag dragged out) has nothing to remove.
    if(value===null)return p[kind]===null?{ok:false,price:null,text:name,note:''}:{ok:!!r.ok,price:null,text:'Ta bort '+name,note:r.ok?'Släpp för att ta bort '+name:why};
    const pnl=kind==='sl'?r.slPnl:r.tpPnl;
    return {ok:!!r.ok,price:value,text:name+' '+fixed(value,levelPlaces(value,p.symbol))+(r.ok&&finite(pnl)?' · '+signedMoney(pnl):''),note:r.ok?'':why};
  }
  // The question before a level change made by a finger: the level and the result if the position closed there now.
  function levelQuestion(p,kind,value){
    const name=kind==='sl'?'SL':'TP',what=' för '+SIDE[p.side]+' '+p.symbol;
    if(value===null)return 'Ta bort '+name+what+'?';
    const r=can('quoteLevels')?read(()=>runner.quoteLevels(p.id,{[kind]:value})):null,pnl=kind==='sl'?r?.slPnl:r?.tpPnl;
    return (p[kind]===null?'Sätta ':'Flytta ')+name+what+' till '+fixed(value,levelPlaces(value,p.symbol))+'?'+
      (r?.ok&&finite(pnl)?'\nResultat om positionen stängs där nu, efter avgifter: '+signedMoney(pnl)+'.':'');
  }
  // A drop: the runner settles the position with its old levels up to now, then sets the new one from now on. pointer:
  // what dragged it ('mouse', 'pen' or 'touch').
  async function commitLevel(id,kind,value,pointer){
    const name=kind==='sl'?'SL':'TP',p=positionOf(id);
    if(!p||!can('setLevels')){levelMsg('Positionen är redan stängd',true);return {ok:false};}
    // A signal position whose levels change by hand becomes manual and loses its time stop: asked first.
    if(p.origin!=='manual'){
      if(!confirm((value===null?'Ta bort '+name:'Flytta '+name+' till '+fixed(value,levelPlaces(value,p.symbol)))+' för signalpositionen '+SIDE[p.side]+' '+p.symbol+'?\n'+
        'Positionen hanteras då manuellt: inget tidsstopp och ingen stängning på en motsatt signal.'))return {ok:false};
    }
    // A finger that lands on a level's handle may have meant to scroll the page: with Bekräfta order on, a level moved
    // by touch is asked about first, as an order is.
    else if(pointer==='touch'&&ticket.confirm&&!confirm(levelQuestion(p,kind,value)))return {ok:false};
    const user=uid();
    levelMsg((value===null?'Tar bort ':'Sparar ')+name+'…',false,id);
    try{const r=await runner.setLevels(id,{[kind]:value});if(uid()===user)levelMsg(r?.text||'',!r?.ok,id);return r;}
    catch(e){if(uid()===user)levelMsg('Kunde inte ändra '+name+': '+reasonOf(e),true,id);return {ok:false};}
    finally{paint();}
  }

  // ---- Toolbar -------------------------------------------------------------------------
  function switchSeries(symbol,tf){
    if(!SYMBOLS.includes(symbol)||!CHART_TFS.includes(tf)||symbol===view.symbol&&tf===view.tf)return;
    const coin=symbol!==view.symbol;
    view.symbol=symbol;view.tf=tf;savePrefs();
    // A level change's result belongs to the coin it was made on, so it does not stay over another coin's chart.
    if(coin){fillLeverage();if(!ordering)ticketMsg('',false);levelMsg('',false);if(visible)watch(symbol);}
    if(visible)void load();
  }
  // Asks Claude for the coming candles (as many as the forecast length) and draws them as they arrive. question: what the
  // user wrote in the chart chat, if anything; the question and Claude's reason are written there. A second press while
  // Claude draws stops it.
  function drawSketch(question){
    if(typeof deps.sketch!=='function')return;
    if(sketch?.pending){sketch.job?.cancel();return;}
    const s=series,last=lastCandle();
    if(!s||!last){levelMsg('Pablo kan rita när grafen har candles.',true);return;}
    const T=TF[s.tf],n=view.horizon,dec=decimals(),start=last.t+T.ms,base=last.c;
    const reader=createSketchReader({base,start,tfMs:T.ms,n});
    const prompt=sketchPrompt({context:chartContext()?.text??'',n,symbol:s.symbol,tf:T.label,price:+base.toFixed(dec),question,
      from:new Date(start).toISOString().slice(0,16).replace('T',' ')});
    const mine={symbol:s.symbol,tf:s.tf,candles:reader.candles,pending:true,job:null};
    sketch=mine;
    ask?.post?.('user',question||`✦ Rita vart ${s.symbol} kan gå de ${n} kommande candlarna (${T.label})`);
    let job;
    try{job=deps.sketch(prompt,delta=>{if(sketch!==mine)return;const had=reader.candles.length;reader.feed(delta);if(reader.candles.length!==had)paintChart();});}
    catch(e){sketch=null;levelMsg('Pablo kunde inte rita: '+reasonOf(e),true);render();return;}
    mine.job=job;render();
    Promise.resolve(job?.done).then(text=>{
      if(sketch!==mine)return;
      // A reply that came all at once (no stream) is read in full here.
      if(!reader.candles.length&&text)reader.feed(text);
      reader.end();
      mine.pending=false;
      if(!reader.candles.length){sketch=null;levelMsg('Pablo svarade utan candles att rita.',true);}
      ask?.post?.('claude',reader.note||'Här är min gissning.',reader.candles.length?`ritade ${reader.candles.length} candles i grafen`:'');
    },e=>{
      if(sketch!==mine)return;
      reader.end();mine.pending=false;
      const msg=reasonOf(e);
      if(!reader.candles.length)sketch=null;
      if(!/avbruten/i.test(msg))levelMsg('Pablo kunde inte rita: '+msg,true);
    }).finally(()=>{if(visible)render();});
  }
  function zoom(mode){
    if(!chart)return;
    if(mode==='reset'){chart.resetView();return;}
    const v=chart.view(),x=v.follow?v.plot.right:(v.plot.left+v.plot.right)/2;
    chart.zoomAt(x,mode==='in'?1.25:.8);
  }
  // Every listener the view adds, so destroy() can take them away again.
  const listeners=[];
  const listen=(target,type,fn)=>{if(typeof target?.addEventListener!=='function')return;target.addEventListener(type,fn);listeners.push([target,type,fn]);};
  listen(root,'click',e=>{
    const hit=s=>e.target?.closest?.(s),attr=(b,name)=>b.getAttribute(name);
    let b;
    if((b=hit('[data-fc-tf]'))){switchSeries(view.symbol,attr(b,'data-fc-tf'));render();}
    else if((b=hit('[data-fc-horizon]'))){const h=+attr(b,'data-fc-horizon');if(HORIZONS.includes(h)){view.horizon=h;savePrefs();render();}}
    else if((b=hit('[data-fc-toggle]'))){const k=attr(b,'data-fc-toggle');if(['forecast','band','signals','levels','ask'].includes(k)){view[k]=!view[k];savePrefs();render();}}
    else if(hit('[data-fc-sketch]'))drawSketch('');
    else if(hit('[data-fc-sketch-clear]')){sketch?.job?.cancel();sketch=null;render();}
    else if((b=hit('[data-fc-zoom]')))zoom(attr(b,'data-fc-zoom'));
    else if((b=hit('[data-fc-chip]'))){choice=attr(b,'data-fc-chip');render();}
    else if((b=hit('[data-fc-sig]')))togglePick(attr(b,'data-fc-sig'));
    else if((b=hit('[data-fc-order]')))void placeOrder(attr(b,'data-fc-order'));
    else if((b=hit('[data-fc-stake-pct]')))chipStake(attr(b,'data-fc-stake-pct'));
    else if(hit('[data-fc-auto]'))void toggleAuto();
    else if(hit('[data-fc-pause]'))void togglePause();
    else if(hit('[data-fc-reset]'))void resetAccount();
    else if((b=hit('[data-fc-eval]')))void runEvaluation(attr(b,'data-fc-eval'));
  });
  listen(root,'change',e=>{
    const t=e.target;
    if(t?.matches?.('[data-fc-symbol]')){switchSeries(t.value,view.tf);render();}
    else if(t?.matches?.('[data-fc-compare]')){if(t.value===OLDER)void more();else choice=t.value||null;render();}
    else if(t===el.confirmBox){ticket.confirm=!!t.checked;saveTicket();}
  });
  // The ticket previews as the stake and the leverage are typed or slid; the last result gives way to the new preview.
  listen(root,'input',e=>{
    const t=e.target;
    if(t!==el.stake&&t!==el.lev&&t!==el.range)return;
    if(t===el.stake){ticket.stake=String(t.value??'').slice(0,24);saveTicket();}
    else{if(t===el.range)el.lev.value=String(t.value);rememberLeverage();}
    if(!ordering)ticketMsg('',false);
    paintTicket();
  });
  // Another window's coin, timeframe and chart choices (Multiview's Dubbelfönster shows the chart in one window and the
  // ticket and the cards in the other): this view follows them, so both windows show the same coin. Saving the same
  // choices back changes nothing, so no event returns.
  listen(globalThis,'storage',e=>{
    if(e.key!==PREFS||!e.newValue||e.storageArea!==prefStore())return;
    let p;try{p=JSON.parse(e.newValue);}catch{return;}
    if(!p||typeof p!=='object')return;
    if(HORIZONS.includes(p.horizon))view.horizon=p.horizon;
    for(const k of ['forecast','band','signals','levels'])if(typeof p[k]==='boolean')view[k]=p[k];
    switchSeries(SYMBOLS.includes(p.symbol)?p.symbol:view.symbol,CHART_TFS.includes(p.tf)?p.tf:view.tf);
    render();
  });
  listen(el.form,'submit',e=>{e.preventDefault?.();void saveSettings();});
  listen(el.form,'input',()=>{dirty=true;});
  fillLeverage();

  function show(){
    if(ended)return Promise.resolve();
    if(visible)return current??Promise.resolve();
    visible=true;
    watch(view.symbol);
    if(parked&&raf){const f=parked;parked=null;raf(f);}
    return load();
  }
  // Leaving the view stops chart polling, drawing, a walk-forward run and the ticket's price reads; the runner keeps
  // protecting the account (and trading, with auto-trading on) through refreshLive. The series stays for the next show;
  // the records are read again then, so none stay in memory.
  function hide(){
    if(!visible)return;
    visible=false;token++;kept=series;series=null;current=null;loading=false;polling=null;pass=null;
    signals=[];forecasts=[];older=0;evalToken++;evalRun=null;
    watch(null);
    clearTimeout(flash);el.last.classList.remove('up','down');
  }
  async function refreshLive(){
    if(ended)return;
    let ticked=null;
    try{ticked=Promise.resolve(runner.tick()).catch(()=>{});}catch{/* the runner reports its own problems */}
    await Promise.all([ticked,shownNow()?poll():null]);
    paint();
  }
  // Tears the view down: the terminal, the chart and the view's listeners go, and nothing is read or drawn after it.
  function destroy(){
    if(ended)return;
    hide();ended=true;
    try{terminal?.destroy?.();}catch{/* the terminal cleans up after itself */}
    terminal=null;chart?.destroy();chart=null;
    for(const [target,type,fn] of listeners)target.removeEventListener?.(type,fn);
    listeners.length=0;summaryEl=null;
    clearTimeout(levelTimer);clearTimeout(flash);
    sketch?.job?.cancel();sketch=null;
  }
  // What the chart shows, as text for a question to Claude about it: the coin and timeframe, the data status, the latest
  // closed candles and the forming one, the signal evaluation, the newest forecast and the account's positions in the coin.
  // Times in UTC, prices with the chart's decimals.
  function chartContext(){
    const s=series;if(!s)return null;
    const st=s.state(),T=TF[s.tf],bars=st.bars.slice(-60),dec=decimals(),t=now();
    const p=x=>finite(x)?x.toFixed(dec):'–',time=x=>new Date(x).toISOString().slice(0,16).replace('T',' ');
    const ohlc=b=>`${time(b.t)} ${p(b.o)} ${p(b.h)} ${p(b.l)} ${p(b.c)}${finite(b.v)?' '+Math.round(b.v):''}`;
    const lines=[`AI Forecast-grafen: ${s.symbol}USDT perpetual på Bybit, tidsram ${T.label}, nu ${time(t)} UTC. Datastatus: ${chartStatus().text}.`];
    if(bars.length)lines.push(`Senaste ${bars.length} stängda candles (start UTC, open high low close volym):`,...bars.map(ohlc));
    if(st.forming)lines.push('Pågående candle: '+ohlc(st.forming));
    const e=evaluation;
    if(e){
      lines.push(`Signalregeln af-signal-v1 på senaste stängda candle: ${e.side==='long'?'KÖP':e.side==='short'?'SÄLJ':'ingen signal'}, regim ${regimeName(e.regime)??e.regime}.`+
        (e.side?` Entry ${p(e.entry)}, SL ${p(e.sl)}, TP ${p(e.tp)}.`:''));
      if(Array.isArray(e.checks))lines.push('Villkor: '+e.checks.map(c=>`${c.label} ${c.ok?'✓':'–'}`).join(', ')+'.');
      if(Array.isArray(e.explanation)&&e.explanation.length)lines.push('Förklaring: '+e.explanation.join(' · '));
    }
    const f=forecasts.at(-1)?.forecast;
    if(f?.bands?.length){
      const h=Math.min(view.horizon,f.bands.length),bands=f.bands.slice(0,h);
      lines.push(`Senaste prognosen (${f.model}, data t.o.m. ${time(f.cutoff)} UTC, ${h} candles framåt; median och 10–90 %-band):`,
        ...bands.map(b=>`${time(b.t)} median ${p(b.q50)} · ${p(b.q10)}–${p(b.q90)}`));
    }
    const open=(read(()=>runner.account())?.positions??[]).filter(x=>x.symbol===s.symbol);
    lines.push(open.length?'Öppna demopositioner i '+s.symbol+': '+open.map(x=>`${x.side==='long'?'lång':'kort'} ${x.units} st från ${p(x.entry)}, `+
      `${x.leverage}×, SL ${p(x.sl)}, TP ${p(x.tp)}, likvidation ${p(x.liq)}`).join('; ')+'.':'Inga öppna demopositioner i '+s.symbol+'.');
    lines.push(bind(RESEARCH.forecast));
    return {text:lines.join('\n'),label:`grafen ${s.symbol} ${T.label}`};
  }
  // The account as it stands, for read-only panels elsewhere (Multiview's Konto): status, the stored account and its live value.
  function accountSnapshot(){
    return {status:read(()=>runner.status()),account:read(()=>runner.account()),live:read(()=>runner.live())};
  }
  return {show,hide,refreshLive,renderSummary,accountSnapshot,chartContext,destroy};
}
