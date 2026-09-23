// Runs floor-day-protocol.md: development selection is locked to disk before
// validation, the old Bybit leverage scenario and the risk levels are computed.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loadFloorData,sha} from './floor-trend-data.mjs';
import {HOUR,COSTS,firmMetrics} from './floor-trend-core.mjs';
import {PERIODS,STRESS} from './floor-trend-run.mjs';
import {CANDIDATES,prepareDay,simulateDay,tradeStats} from './floor-day-core.mjs';

export const DAY_DIR=new URL('../.matning/floor-day/',import.meta.url);
const NAMES=Object.keys(CANDIDATES),REFERENCE='pulse12';
const RISKS=[.005,.01,.02,.03,.05,.1];

export function runFirm(prepared,name,period,options={}){
  const desks=period.coins.map(coin=>simulateDay(coin,prepared[coin],name,{start:period.start,end:period.end,...options}));
  return {desks,metrics:firmMetrics(desks,period.start,100*desks.length),stats:tradeStats(desks)};
}
function yearly(metrics,period){
  const out={},eq=metrics.equity,value=t=>t<=period.start?metrics.capital:eq[Math.min(eq.length,(t-period.start)/HOUR)-1];
  for(let y=new Date(period.start).getUTCFullYear();Date.UTC(y,0,1)<period.end;y++)
    out[y]=value(Math.min(period.end,Date.UTC(y+1,0,1)))/value(Math.max(period.start,Date.UTC(y,0,1)))-1;
  return out;
}
const summary=(r,period)=>{const {equity,daily,...m}=r.metrics;return {...m,years:yearly(r.metrics,period),stats:r.stats,
  desks:Object.fromEntries(r.desks.map(d=>[d.coin,{final:d.final,trades:d.roundTrips,liquidations:d.liquidations}]))};};
const pct=x=>(x*100).toFixed(2)+' %';
const line=(tag,name,s)=>process.stdout.write(`${tag} ${name.padEnd(9)} net ${pct(s.net).padStart(10)} sharpe ${s.sharpe.toFixed(2).padStart(6)} dd ${pct(s.maxDD).padStart(9)} trades ${s.stats.closed} win ${s.stats.winShare===null?'-':pct(s.stats.winShare)} R ${s.stats.meanR?.toFixed(3)} hold ${s.stats.medianHours}h liq ${s.liquidations}\n`);

export async function run(){
  await mkdir(DAY_DIR,{recursive:true});
  const protocol=await readFile(new URL('floor-day-protocol.md',import.meta.url),'utf8');
  const core=await readFile(new URL('floor-day-core.mjs',import.meta.url),'utf8');
  const contractsRaw=await readFile(new URL('contracts.json',DAY_DIR),'utf8'),contracts=JSON.parse(contractsRaw);
  const {data,manifest}=await loadFloorData('binance');
  const prepared=Object.fromEntries(Object.entries(data).map(([c,raw])=>[c,prepareDay(raw)]));
  const hashes={protocol:sha(protocol),core:sha(core),contracts:sha(contractsRaw),data:Object.fromEntries(Object.entries(manifest.files).map(([c,f])=>[c,f.sha256]))};

  // 1. Development with research sizing, then lock the choice.
  const development={};
  for(const name of [...NAMES,REFERENCE]){
    development[name]={normal:summary(runFirm(prepared,name,PERIODS.development),PERIODS.development),
      stress:summary(runFirm(prepared,name,PERIODS.development,{costs:STRESS}),PERIODS.development)};
    line('dev',name,development[name].normal);
  }
  const eligible=NAMES.filter(n=>{const d=development[n];return d.normal.net>0&&d.stress.net>0&&d.normal.stats.closed>=200&&d.normal.stats.medianHours<=72;});
  const selected=[...eligible].sort((a,b)=>development[b].normal.sharpe-development[a].normal.sharpe||development[a].normal.maxDD-development[b].normal.maxDD)[0]??null;
  const shortest=NAMES.filter(n=>n==='vb-f-1d'||CANDIDATES[n].maxHold<=24).sort((a,b)=>development[b].normal.sharpe-development[a].normal.sharpe)[0];
  await writeFile(new URL('selection-lock.json',DAY_DIR),JSON.stringify({lockedAt:new Date().toISOString(),hashes,eligible,selected,shortest,
    development:Object.fromEntries(Object.entries(development).map(([n,d])=>[n,{net:d.normal.net,stress:d.stress.net,sharpe:d.normal.sharpe,maxDD:d.normal.maxDD,trades:d.normal.stats.closed,medianHours:d.normal.stats.medianHours}]))},null,2)+'\n');
  process.stdout.write('eligible: '+(eligible.join(', ')||'none')+'\nselected: '+selected+'\nbest one-day: '+shortest+'\n');

  // 2. Validation for every candidate and the reference.
  const validation={};
  for(const name of [...NAMES,REFERENCE]){
    validation[name]={normal:summary(runFirm(prepared,name,PERIODS.validation),PERIODS.validation),
      stress:summary(runFirm(prepared,name,PERIODS.validation,{costs:STRESS}),PERIODS.validation)};
    line('val',name,validation[name].normal);
  }
  const validated=selected?['normal','stress'].every(k=>validation[selected][k].net>0&&validation[selected][k].sharpe>0):false;

  // 3. The old desks' Bybit leverage rules, descriptive only.
  const bybit={};
  for(const name of [...NAMES,REFERENCE]){
    bybit[name]={};
    for(const period of ['development','validation']){
      bybit[name][period]=summary(runFirm(prepared,name,PERIODS[period],{mode:'bybit',contracts:contracts.contracts}),PERIODS[period]);
      line('bybit-'+period.slice(0,3),name,bybit[name][period]);
    }
  }

  // 4. Risk levels for the selected (or, failing that, the best one-day) candidate.
  const focus=selected??shortest,risk={};
  for(const r of RISKS){
    risk[r]={};
    for(const period of ['development','validation'])risk[r][period]=summary(runFirm(prepared,focus,PERIODS[period],{risk:r,cap:20}),PERIODS[period]);
    process.stdout.write(`risk ${r} ${focus} dev ${pct(risk[r].development.net)} cagr ${pct(risk[r].development.cagr)} dd ${pct(risk[r].development.maxDD)} | val ${pct(risk[r].validation.net)} cagr ${pct(risk[r].validation.cagr)} dd ${pct(risk[r].validation.maxDD)} liq ${risk[r].validation.liquidations}\n`);
  }

  // 5. Venue check on Bybit's own contracts for the focus candidate.
  const {data:bybitData,manifest:bm}=await loadFloorData('bybit');
  const bp=Object.fromEntries(Object.entries(bybitData).map(([c,raw])=>[c,prepareDay(raw)]));
  const venue=summary(runFirm(bp,focus,PERIODS.validation),PERIODS.validation);
  hashes.bybit=Object.fromEntries(Object.entries(bm.files).map(([c,f])=>[c,f.sha256]));
  line('bybit-data',focus,venue);

  // 6. The current trend desks from the trend research, same periods and data.
  const trend=JSON.parse(await readFile(new URL('../.matning/floor-trend/results.json',import.meta.url),'utf8'));
  const trendDesks=Object.fromEntries(['development','validation'].map(p=>{const m=trend.risk['1'][p];return [p,{net:m.net,cagr:m.cagr,sharpe:m.sharpe,maxDD:m.maxDD,roundTrips:m.roundTrips,years:m.years}];}));

  const results={generatedAt:new Date().toISOString(),hashes,contractsFetchedAt:contracts.fetchedAt,periods:PERIODS,costs:{normal:COSTS,stress:STRESS},
    candidates:CANDIDATES,eligible,selected,validated,shortest,focus,development,validation,bybit,risk,venue,trendDesks};
  await writeFile(new URL('results.json',DAY_DIR),JSON.stringify(results));
  process.stdout.write('validated: '+validated+'\n');
  return results;
}
if(process.argv[1]===fileURLToPath(import.meta.url))await run();
