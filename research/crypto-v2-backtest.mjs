import {readFileSync,writeFileSync} from 'node:fs';
import {START,SPLIT,END,STEP,DAY,SYMBOLS,ROOT,readData,hash} from './crypto-v2-data.mjs';
import {features,signal,Book,VARIANTS} from './crypto-v2-engine.mjs';

const data=Object.fromEntries(SYMBOLS.map(s=>[s,readData(s)]));
const feat=Object.fromEntries(SYMBOLS.map(s=>[s,features(data[s].bars)]));
const funds=Object.fromEntries(SYMBOLS.map(s=>[s,new Map(data[s].funding.map(x=>[x.t,x.rate]))]));
const sum=a=>a.reduce((s,x)=>s+x,0);
function interval(trades,from,to){
  const blocks=Array.from({length:Math.ceil((to-from)/(7*DAY))},()=>[]);
  for(const t of trades)blocks[Math.min(blocks.length-1,Math.floor((t.closed-from)/(7*DAY)))].push(t.R);
  // A handful of trades in one week creates a falsely precise bootstrap.
  // Suppress that interval; this reporting guard does not alter strategy selection.
  if(trades.length<30||blocks.filter(b=>b.length).length<3)return null;
  let seed=8128;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const samples=[];
  for(let i=0;i<4000;i++){let total=0,n=0;for(let k=0;k<blocks.length;k++){const b=blocks[Math.floor(random()*blocks.length)];total+=sum(b);n+=b.length;}if(n)samples.push(total/n);}
  samples.sort((a,b)=>a-b);return {low:samples[Math.floor(samples.length*.025)],high:samples[Math.floor(samples.length*.975)],blocks:blocks.length};
}
function attribution(trades,key){
  const result={};for(const t of trades){const k=key(t);result[k]=(result[k]||0)+t.pnl;}return result;
}
function run(from,to,period){
  const books=VARIANTS.flatMap(v=>[.0005,.001].map(s=>new Book(v,s)));
  const first=data.BTC.bars.findIndex(b=>b.t===from),end=data.BTC.bars.findIndex(b=>b.t===to);
  const last=end<0?data.BTC.bars.length:end;
  for(let i=first;i<last;i++){
    const time=data.BTC.bars[i].t,bars=Object.fromEntries(SYMBOLS.map(s=>[s,data[s].bars[i]]));
    const rates=Object.fromEntries(SYMBOLS.map(s=>[s,funds[s].get(time)||0]));
    for(const b of books){
      // First timestamp may use preceding closed candles, never preceding account positions.
      const signals=SYMBOLS.map(s=>signal(b.variant,s,feat[s].get(time))).filter(Boolean);
      b.step(signals,bars,time,rates);
      b.trail(Object.fromEntries(SYMBOLS.map(s=>[s,feat[s].get(time+STEP)])));
    }
  }
  for(const b of books){
    if(b.p)b.close(data[b.p.symbol].bars[last-1].c,to,'period-end');
    b.mark(Object.fromEntries(SYMBOLS.map(s=>[s,data[s].bars[last-1]])),to);
    // Audit every trade against independent cash arithmetic and chronology.
    let balance=100,lastClosed=from;
    for(const t of b.trades){
      const expected=t.dir*t.units*(t.exit-t.entry)-t.fees-t.funding;
      balance+=t.pnl;
      if(![t.pnl,t.R,t.capital,t.initialRisk].every(Number.isFinite)||Math.abs(expected-t.pnl)>1e-8||Math.abs(balance-t.capital)>1e-8||t.opened<lastClosed||t.closed<t.opened||t.closed>to)throw Error('Trade audit failed');
      lastClosed=t.closed;
    }
    if(Math.abs(balance-b.balance)>1e-8)throw Error('Balance audit failed');
  }
  return books.map(b=>({period,...b.summary(),ci:interval(b.trades,from,to),byCoin:attribution(b.trades,t=>t.symbol),byMonth:attribution(b.trades,t=>new Date(t.closed-1).toISOString().slice(0,7)),trades:b.trades,
    daily:b.equity.filter((x,i)=>x.t%DAY===0&&b.equity[i+1]?.t!==x.t)}));
}
const development=run(START,SPLIT,'development');
const eligible=development.filter(s=>s.slip===.0005&&s.n>=30&&s.returnPct>0&&s.PF>=1.15&&s.maxDD<=15).sort((a,b)=>b.meanR-a.meanR);
const selected=eligible[0]?.variant||null;
// Selection is frozen before validation is run or reported.
console.log('Development selection: '+(selected||'none'));
const validation=run(SPLIT,END,'validation');
const candidate=validation.find(s=>s.variant===selected&&s.slip===.0005),stress=validation.find(s=>s.variant===selected&&s.slip===.001);
const paperEligible=!!candidate&&candidate.n>=30&&candidate.returnPct>0&&candidate.PF>=1.15&&candidate.maxDD<=15&&stress.returnPct>0&&candidate.withoutBest5>0&&Object.values(candidate.byCoin).filter(x=>x>0).length>=2&&Object.values(candidate.byMonth).filter(x=>x>0).length>=3;
const result={createdAt:new Date().toISOString(),selected,paperEligible,hashes:Object.fromEntries(SYMBOLS.map(s=>[s,data[s].checksum])),sourceHashes:Object.fromEntries(['crypto-v2-data.mjs','crypto-v2-engine.mjs','crypto-v2-backtest.mjs','crypto-v2-protocol.md'].map(f=>[f,hash(readFileSync(new URL(f,import.meta.url)))])),development,validation};
writeFileSync(new URL('results.json',ROOT),JSON.stringify(result));
const f=(x,n=2)=>x===null?'n/a':x.toFixed(n);
const table=rows=>'| Strategy | Trades | Net return | Max DD | PF | Net R/trade | Win rate |\n|---|---:|---:|---:|---:|---:|---:|\n'+rows.filter(s=>s.slip===.0005).map(s=>`| ${s.variant} | ${s.n} | ${f(s.returnPct)}% | ${f(s.maxDD)}% | ${f(s.PF)} | ${f(s.meanR,3)} | ${f(s.winRate*100,1)}% |`).join('\n');
let report=`# Crypto v2: slower, cost-aware strategies\n\nGenerated ${result.createdAt}. Research only; live strategy and account unchanged.\n\nDevelopment-selected candidate: **${selected||'none'}**. All paper-test gates passed: **${paperEligible?'yes':'no'}**.\n\n## Method\n\n[Predeclared protocol](crypto-v2-protocol.md). Three Bybit linear perpetuals, BTC/ETH/SOL; 37,920 continuous 15m candles and 1,095 funding observations each. Closed 1h signals and closed 4h trend. 0.055% fees and 5bp adverse slippage per side, actual funding with candle-open mark approximation. Estimated risk including stop costs 0.5% of equity, exposure capped at 2x, one position. Results are synthetic.\n\nThis is fresh-to-this-experiment 2025 data, split chronologically; the strategy ideas were devised later in 2026. It is retrospective validation, not prospective evidence or a direct same-period comparison to the old strategy. Four attempts add selection bias. No parameter search was conducted.\n\n## Development: January–June 2025\n\n${table(development)}\n\n## Validation: July–December 2025\n\n${table(validation)}\n\n## Validation robustness\n\n| Strategy | 95% weekly bootstrap net R | Double slippage return | P/L minus best 5 trades |\n|---|---:|---:|---:|\n`;
for(const s of validation.filter(s=>s.slip===.0005))report+=`| ${s.variant} | ${s.ci?f(s.ci.low,3)+' to '+f(s.ci.high,3):'n/a'} | ${f(validation.find(x=>x.variant===s.variant&&x.slip===.001).returnPct)}% | $${f(s.withoutBest5)} |\n`;
report+='\nBootstrap uses 27 weekly blocks including inactive weeks, 4,000 deterministic resamples; approximate and not adjusted for multiple comparisons. Intervals are suppressed below 30 trades or three active weeks: the original calculation produced a misleading zero-width interval for two range trades in one week. This reporting correction was made after the first run; no trading rules, selection gates or P/L changed. Removing best trades subtracts realized trade P/L, without resizing later trades. Double slippage changes the entry filter and therefore trade selection.\n\n## Validation attribution\n\n';
for(const s of validation.filter(s=>s.slip===.0005))report+=`### ${s.variant}\n\n- Gross P/L before fees/funding, still after slippage: $${f(s.gross)}; fees: $${f(s.fees)}; net funding paid: $${f(s.funding)}.\n- Coin P/L: ${Object.entries(s.byCoin).map(([k,v])=>k+' $'+f(v)).join(', ')}.\n- Monthly P/L: ${Object.entries(s.byMonth).map(([k,v])=>k+' $'+f(v)).join(', ')}.\n\n`;
report+='## Limits and reproduction\n\nNo order-book, tick sequencing, spread, minimum order size, mark-price liquidation or exchange margin-tier model. Stops precede targets on ambiguous candles; drawdown sampled at 15m closes, not every intrabar extreme. Risk sizing cannot prevent losses beyond a stop during gaps. Selected coins are current survivors. Funding timestamps/coverage and all price candles were validated; trade cash flows, capital reconciliation and nonoverlap were independently audited.\n\nRun `node research/crypto-v2-data.mjs --download`, `node --test tests/crypto-v2.test.mjs`, then `node research/crypto-v2-backtest.mjs`. Raw histories, full trades, daily equity and SHA-256 fingerprints are local in `.matning/crypto-v2/`.\n\nSources: [Bybit candles](https://bybit-exchange.github.io/docs/v5/market/kline), [Bybit funding](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate). [Historical momentum research](https://www.nber.org/papers/w24877) motivates testing; it does not validate these rules.\n';
writeFileSync(new URL('crypto-v2-results.md',import.meta.url),report);
console.log(JSON.stringify({selected,paperEligible,development:development.map(({trades,daily,...s})=>s),validation:validation.map(({trades,daily,...s})=>s)},null,2));
