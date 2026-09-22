import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { START,SPLIT,END,STEP,DAY,SYMBOLS,ROOT,readData } from './crypto-data.mjs';
import { Portfolio,VARIANTS,NAMES,hourlyTrends,pullback } from './crypto-simulator.mjs';

const data=Object.fromEntries(SYMBOLS.map(s=>[s,readData(s)]));
const hours=Object.fromEntries(SYMBOLS.map(s=>[s,hourlyTrends(data[s].bars)]));
const fund=Object.fromEntries(SYMBOLS.map(s=>[s,new Map(data[s].funding.map(f=>[f.t,f.rate]))]));
const periodOf=t=>t<SPLIT?'development':'test';
const mkBooks=period=>VARIANTS.flatMap(v=>[.0005,.001].flatMap(slip=>['risk1','all20'].map(size=>new Portfolio(v,slip,size,period))));
let books=mkBooks('development'),finished=[],engines,now=START;
const realNow=Date.now;
const byGrade=(a,b)=>({A:0,B:1,C:2}[a.grade]-{A:0,B:1,C:2}[b.grade]) || b.conf-a.conf;
async function newEngines(phase) {
  const out={};
  for(const symbol of SYMBOLS) {
    out[symbol]={};
    for(const type of ['base','atr']) {
      const m=await import('../motor.js?crypto-test='+phase+'-'+symbol+'-'+type);
      m.MOTORCFG.nyhetsSparr=false;m.MOTORCFG.formandeStapel=false;
      out[symbol][type]=m;
    }
  }
  return out;
}
function activeSignals(contexts,type,t,index) {
  const all=[];
  for(const symbol of SYMBOLS) {
    const m=engines[symbol][type],ctx={...contexts[symbol]};
    for(const [key,st] of m.LIVE) {
      if(st.slutAt && t-st.slutAt>1800000 || !st.slutAt && t-st.at>36*3600000) m.LIVE.delete(key);
    }
    if(type==='atr') {
      m.MOTORCFG.minPts=1.5*ctx.atr/ctx.px*23150;
      m.MOTORCFG.maxPts=6*ctx.atr/ctx.px*23150;
    }
    const signals=m.generateSignals(ctx);
    all.push(...signals);
  }
  all.sort(byGrade);
  const active=all.filter(s=>engines[s.inst][type].LIVE.has(s.nyckel));
  const waiting=all.filter(s=>!engines[s.inst][type].LIVE.has(s.nyckel));
  const selected=active.concat(waiting.slice(0,Math.max(3,14-active.length)));
  const output=[];
  for(const symbol of SYMBOLS) {
    const m=engines[symbol][type],ctx=contexts[symbol];
    const own=selected.filter(s=>s.inst===symbol),keys=new Set(own.map(s=>s.nyckel));
    for(const [key,st] of m.LIVE) if(st.sig && !keys.has(key)) own.push({...st.sig,bars:ctx.bars,ctxPx:ctx.px,atr:ctx.atr});
    const status=m.assignStatus(own,{[symbol]:ctx.px});
    for(const s of status) if(s.status==='ACTIVE' && m.handlasGrad(s.grade)) {
      output.push({id:s.id,inst:s.inst,side:s.side,sl:s.sl,tp:s.tp,atr:ctx.atr,fam:s.fam,grade:s.grade,
        conf:s.conf,oppnad:s.oppnad,trend:hours[symbol][index]});
    }
  }
  return output.sort((a,b)=>a.oppnad-b.oppnad || b.conf-a.conf || SYMBOLS.indexOf(a.inst)-SYMBOLS.indexOf(b.inst));
}
function endPeriod(time,index) {
  for(const book of books) {
    if(book.position) book.finish(data[book.position.inst].bars[index],'period-end');
    book.peak=Math.max(book.peak,book.balance);
    book.maxDD=Math.max(book.maxDD,1-book.balance/book.peak);
    book.daily.push({t:time-DAY,equity:book.balance});
  }
  finished.push(...books);
}
function confidence(trades) {
  // Fixed seven-day blocks, resampled with replacement, deterministic seed.
  const weeks=new Map();
  for(const t of trades) { const w=Math.floor((t.opened-SPLIT)/(7*DAY)); if(!weeks.has(w)) weeks.set(w,[]); weeks.get(w).push(t.R); }
  const blocks=[...weeks.values()];
  if(blocks.length<3) return null;
  let seed=1729;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const estimates=[];
  for(let i=0;i<2000;i++) { let total=0,n=0;for(let b=0;b<blocks.length;b++){const block=blocks[Math.floor(random()*blocks.length)];for(const r of block){total+=r;n++;}}estimates.push(total/n); }
  estimates.sort((a,b)=>a-b);
  return {low:estimates[50],high:estimates[1949],blocks:blocks.length};
}
try {
  engines=await newEngines('development');
  Date.now=()=>now;
  const first=data.BTC.bars.findIndex(b=>b.t===START);
  let pending={base:[],atr:[],custom:[]},atrs={};
  const started=performance.now();
  for(let i=first-1;i<data.BTC.bars.length;i++) {
    const t=data.BTC.bars[i].t;
    now=t+STEP;
    if(t===SPLIT) {
      endPeriod(SPLIT,i-1);
      books=mkBooks('test');engines=await newEngines('test');pending={base:[],atr:[],custom:[]};
    }
    const bars=Object.fromEntries(SYMBOLS.map(s=>[s,data[s].bars[i]]));
    if(t>=START) {
      const rates=Object.fromEntries(SYMBOLS.map(s=>[s,fund[s].get(t)||0]));
      for(const book of books) {
        const signals=book.variant.startsWith('pullback')?pending.custom:book.variant.startsWith('atr')?pending.atr:pending.base;
        book.step(signals,bars,t,rates,atrs);
      }
    }
    const contexts={};
    for(const symbol of SYMBOLS) {
      const m=engines[symbol].base;
      const ctx=m.buildContext(m.INSTR[symbol],data[symbol].bars.slice(i-1999,i+1));
      ctx.newsBias=0;ctx.biasRiktning=0;contexts[symbol]=ctx;atrs[symbol]=ctx.atr;
    }
    pending={base:activeSignals(contexts,'base',now,i),atr:activeSignals(contexts,'atr',now,i),
      custom:SYMBOLS.map(s=>pullback(contexts[s],hours[s][i])).filter(Boolean)};
    if((i-first+1)%(288*5)===0) {
      console.log('Replay '+new Date(t+STEP).toISOString().slice(0,10)+' '+Math.round((i-first+1)/(data.BTC.bars.length-first)*100)+'% elapsed '+Math.round((performance.now()-started)/1000)+'s');
      await new Promise(resolve=>setImmediate(resolve));
    }
  }
  endPeriod(END,data.BTC.bars.length-1);
} finally { Date.now=realNow; }

const summaries=finished.map(b=>({...b.summary(),ci:b.period==='test'?confidence(b.trades):null}));
const development=summaries.filter(s=>s.period==='development'&&s.slip===.0005&&s.size==='risk1'&&s.n>=30);
development.sort((a,b)=>b.meanR-a.meanR);
const selected=development[0]?.variant||null;
const hashes=Object.fromEntries(SYMBOLS.map(s=>[s,{sha256:data[s].checksum,candles:data[s].bars.length,funding:data[s].funding.length}]));
const sourceHash=createHash('sha256').update(readFileSync(new URL('../motor.js',import.meta.url))).digest('hex');
const result={createdAt:new Date().toISOString(),sourceHash,hashes,selected,selectionRule:'Highest development mean net R, >=30 trades, 1% risk, 5bp slippage',summaries,
  books:finished.map(b=>({variant:b.variant,size:b.size,slip:b.slip,period:b.period,trades:b.trades,daily:b.daily}))};
writeFileSync(new URL('results.json',ROOT),JSON.stringify(result));
const f=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'—';
const rows=period=>summaries.filter(s=>s.period===period&&s.slip===.0005&&s.size==='risk1').map(s=>
  `| ${NAMES[VARIANTS.indexOf(s.variant)]} | ${s.n} | ${f(s.winRate*100,1)} % | ${f(s.meanR,3)} | ${f(s.profitFactor)} | ${f(s.returnPct,1)} % | ${f(s.maxDrawdownPct,1)} % |`).join('\n');
let report=`# Kryptostrategier — historiskt test\n\nGenererad ${result.createdAt}. Ingen strategi eller kontoinställning har ändrats på sidan.\n\n`+
  `## Metod\n\nSe [låst protokoll](crypto-protocol.md). Sju coins, Bybit spot, 5 minuter, 2 000 staplars indikatorfönster. Avgift 0,055 % och slippage 0,05 % per sida, plus historisk funding värderad med spotpris. En position i taget; 1 % av aktuellt kapital i ursprunglig stopprisk, maximalt 20× exponering. Separat 20×-konto och dubbel slippage finns nedan.\n\n`+
  `Nyhetsfilter avstängt eftersom historiska rubriker saknas. Femminutersapproximation av livekontot; ingen intrabar-tickhistorik, perpetual-pris- eller orderboksmodell. Avkastning är simulerad, inte ett löfte eller en exakt reproduktion av sidans faktiska historik. Urvalet är dagens sju coins och prövar inte avnoterade coins.\n\n`+
  `## Utveckling: 14 mars–11 juli 2026\n\n| Variant | Affärer | Träff | Netto-R/affär | Profit factor | Avkastning | Max nedgång |\n|---|---:|---:|---:|---:|---:|---:|\n${rows('development')}\n\n`+
  `Förregistrerat urval på enbart utvecklingsdata: **${NAMES[VARIANTS.indexOf(selected)]||'ingen'}**. Ingen ändring av reglerna efter resultaten.\n\n`+
  `## Orört test: 12 juli–9 september 2026\n\n| Variant | Affärer | Träff | Netto-R/affär | Profit factor | Avkastning | Max nedgång |\n|---|---:|---:|---:|---:|---:|---:|\n${rows('test')}\n\n`+
  `## Osäkerhet och kostnadsstress, testperiod\n\n| Variant | 95 % block-bootstrap för netto-R | Netto-R med 0,10 % slippage/sida | 20× avkastning | 20× max nedgång |\n|---|---:|---:|---:|---:|\n`;
for(const v of VARIANTS) {
  const s=summaries.find(s=>s.variant===v&&s.period==='test'&&s.slip===.0005&&s.size==='risk1');
  const stress=summaries.find(s=>s.variant===v&&s.period==='test'&&s.slip===.001&&s.size==='risk1');
  const lever=summaries.find(s=>s.variant===v&&s.period==='test'&&s.slip===.0005&&s.size==='all20');
  report+=`| ${NAMES[VARIANTS.indexOf(v)]} | ${s.ci?f(s.ci.low,3)+' till '+f(s.ci.high,3)+' ('+s.ci.blocks+' veckoblock)':'för få veckor'} | ${f(stress.meanR,3)} (${stress.n} affärer) | ${f(lever.returnPct,1)} % | ${f(lever.maxDrawdownPct,1)} % |\n`;
}
report+='\nBootstrapintervallen är ungefärliga, baserade på få veckoblock och inte korrigerade för flera strategijämförelser. Ändrade slippageantaganden ändrar också vilka affärer som passerar nettofiltret. 20×-kontot stannar när saldot understiger 1 dollar från startens 100 dollar. Max nedgång mäts vid 5m-stängningar och efter avslut, inte på varje intrabar-pris.\n';
report+='\n## Resultat per coin, testperiod (1 % risk)\n\n| Variant | Coin | Affärer | Netto-R/affär |\n|---|---|---:|---:|\n';
for(const b of finished.filter(b=>b.period==='test'&&b.size==='risk1'&&b.slip===.0005)) for(const s of SYMBOLS) {
  const trades=b.trades.filter(t=>t.symbol===s);
  report+=`| ${NAMES[VARIANTS.indexOf(b.variant)]} | ${s} | ${trades.length} | ${trades.length?f(trades.reduce((a,t)=>a+t.R,0)/trades.length,3):'—'} |\n`;
}
report+='\n## Datakällor och reproduktion\n\n- [Bybit Kline API](https://bybit-exchange.github.io/docs/v5/market/kline)\n- [Bybit Funding History](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate)\n- [Bybit avgifter](https://www.bybit.com/en/help-center/article/Trading-Fee-Structure)\n\nKör `node research/crypto-data.mjs --download` och `node research/crypto-backtest.mjs`. Rådata, enskilda affärer och daglig equity sparas lokalt i `.matning/crypto/`; SHA-256 för varje prisserie och signalmotorn finns i `results.json`.\n';
writeFileSync(new URL('crypto-results.md',import.meta.url),report);
console.log(JSON.stringify({selected,development:development.map(s=>({variant:s.variant,n:s.n,meanR:s.meanR})),test:summaries.filter(s=>s.period==='test'&&s.size==='risk1'&&s.slip===.0005)},null,2));
