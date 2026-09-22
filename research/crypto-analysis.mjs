import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ROOT,SYMBOLS,SPLIT,END,DAY } from './crypto-data.mjs';
import { VARIANTS,NAMES } from './crypto-simulator.mjs';

const result=JSON.parse(readFileSync(new URL('results.json',ROOT),'utf8'));
const name=v=>NAMES[VARIANTS.indexOf(v)]||v;
const main=result.books.filter(b=>b.period==='test'&&b.size==='risk1'&&b.slip===.0005);
const baseline=main.find(b=>b.variant==='current');
const winner=main.find(b=>b.variant===result.selected);
const f=(x,d=3)=>Number.isFinite(x)?x.toFixed(d):'—';
const weeks=Math.ceil((END-SPLIT)/(7*DAY));
const weekOf=t=>Math.min(weeks-1,Math.floor((t-SPLIT)/(7*DAY)));
const byWeek=book=>Array.from({length:weeks},(_,w)=>book.trades.filter(t=>weekOf(t.opened)===w));
const baseWeeks=byWeek(baseline),winnerWeeks=winner?byWeek(winner):null;
let delta=null;
if(winner && winner.variant!=='current') {
  let seed=9137;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const draws=[];
  for(let k=0;k<4000;k++) {
    let sumBase=0,nBase=0,sumWin=0,nWin=0;
    for(let w=0;w<weeks;w++) {
      const ix=Math.floor(random()*weeks);
      for(const t of baseWeeks[ix]){sumBase+=t.R;nBase++;}
      for(const t of winnerWeeks[ix]){sumWin+=t.R;nWin++;}
    }
    if(nBase&&nWin) draws.push(sumWin/nWin-sumBase/nBase);
  }
  draws.sort((a,b)=>a-b);
  if(draws.length) delta={low:draws[Math.floor(draws.length*.025)],high:draws[Math.floor(draws.length*.975)],resamples:draws.length};
}
const concentration=main.map(book=>{
  const coin=SYMBOLS.map(s=>{
    const t=book.trades.filter(t=>t.symbol===s);
    return {symbol:s,n:t.length,totalR:t.reduce((sum,t)=>sum+t.R,0)};
  });
  const weekly=byWeek(book).map(t=>({n:t.length,totalR:t.reduce((sum,t)=>sum+t.R,0)}));
  const sorted=book.trades.slice().sort((a,b)=>b.R-a.R);
  const withoutTop5=sorted.slice(5);
  return {variant:book.variant,positiveCoins:coin.filter(c=>c.totalR>0).length,
    tradedCoins:coin.filter(c=>c.n>0).length,positiveWeeks:weekly.filter(w=>w.totalR>0).length,
    tradedWeeks:weekly.filter(w=>w.n>0).length,meanRWithoutTop5:withoutTop5.length?withoutTop5.reduce((sum,t)=>sum+t.R,0)/withoutTop5.length:null,
    coins:coin,weeks:weekly};
});
const hashes={};
for(const path of ['crypto-protocol.md','crypto-data.mjs','crypto-simulator.mjs','crypto-backtest.mjs','crypto-analysis.mjs']) {
  hashes[path]=createHash('sha256').update(readFileSync(new URL(path,import.meta.url))).digest('hex');
}
for(const symbol of SYMBOLS) hashes[symbol+'.json']=createHash('sha256').update(readFileSync(new URL(symbol+'.json',ROOT))).digest('hex');
const analysis={selected:result.selected,selectedVsBaselineCI:delta,concentration,hashes};
writeFileSync(new URL('analysis.json',ROOT),JSON.stringify(analysis,null,2));
const header='\n## Kontroll av resultatspridning\n';
const reportFile=new URL('crypto-results.md',import.meta.url);
const existing=readFileSync(reportFile,'utf8');
if(existing.includes(header)) writeFileSync(reportFile,existing.slice(0,existing.indexOf(header)));
let text=header+'\n| Variant | Coins med positiv total R | Veckor med positiv total R | Netto-R/affär utan fem bästa affärerna |\n|---|---:|---:|---:|\n';
for(const c of concentration) text+=`| ${name(c.variant)} | ${c.positiveCoins}/${c.tradedCoins} | ${c.positiveWeeks}/${c.tradedWeeks} | ${f(c.meanRWithoutTop5)} |\n`;
text+='\nSummorna här räknas i R för att inte låta varierande kontostorlek dominera. De är efterhandsdiagnostik, inte nya urvalsregler.\n';
if(delta) text+=`\nUtvecklingsvinnaren **${name(result.selected)}** mot nuvarande modell: 95 % parat veckobootstrapintervall för skillnaden i netto-R/affär **${f(delta.low)} till ${f(delta.high)}**. Samma veckor återprovas i båda strategierna. Ett positivt intervall betyder möjlig relativ förbättring; det visar inte i sig positiv absolut avkastning.\n`;
text+='\nFullständiga affärer, equity, koncentrationskontroller och checksummor för koden och hela rådatafilerna finns i `.matning/crypto/results.json` och `.matning/crypto/analysis.json`. Kör `node research/crypto-analysis.mjs` efter backtestet för denna komplettering.\n';
appendFileSync(reportFile,text);
console.log(JSON.stringify({selected:analysis.selected,selectedVsBaselineCI:delta,concentration:concentration.map(({coins,weeks,...x})=>x)},null,2));
