// Runs floor-trend-protocol.md: development selection is locked to disk
// before validation, risk levels and sensitivity are computed.
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loadFloorData,DATA_DIR,sha} from './floor-trend-data.mjs';
import {HOUR,DAY,COSTS,SIZING,STRATEGIES,prepare,strategySignal,simulateDesk,simulatePulse12,firmMetrics} from './floor-trend-core.mjs';

const ALL=['BTC','ETH','SOL','XRP','DOGE','SHIB'];
export const PERIODS=Object.freeze({
  early:{start:Date.parse('2020-10-01T00:00:00Z'),end:Date.parse('2021-06-01T00:00:00Z'),coins:['BTC','ETH','SOL','XRP','DOGE']},
  development:{start:Date.parse('2021-06-01T00:00:00Z'),end:Date.parse('2024-01-01T00:00:00Z'),coins:ALL},
  validation:{start:Date.parse('2024-01-01T00:00:00Z'),end:Date.parse('2026-09-23T00:00:00Z'),coins:ALL}
});
export const STRESS=Object.freeze({...COSTS,slip:.001});
export const RISK_LEVELS=Object.freeze([.25,.5,.75,1]);
// Added after the first results as description only; never used for a choice.
export const EXTRA_LEVELS=Object.freeze([1.25,1.5,2,3]);
const REFERENCES=['pulse12','bh'];

function signalsFor(prepared,names,options){
  const out={};
  for(const [coin,d] of Object.entries(prepared)){out[coin]={};for(const n of names)if(n!=='pulse12')out[coin][n]=strategySignal(n,d.bars,d.days,options);}
  return out;
}
export function runFirm(prepared,signals,name,period,{costs=COSTS,sizing=SIZING}={}){
  const {start,end}=period;
  const desks=period.coins.map(coin=>{
    const d=prepared[coin];
    if(name==='pulse12')return simulatePulse12(coin,d,{start,end,costs});
    return simulateDesk(coin,d,signals[coin][name],{start,end,costs,sizing,fixedExposure:name==='bh'?1:null});
  });
  return {desks,metrics:firmMetrics(desks,start,100*desks.length)};
}
// Calendar-year returns inside one continuous run.
function yearly(metrics,period){
  const out={},eq=metrics.equity,value=t=>t<=period.start?metrics.capital:eq[Math.min(eq.length,(t-period.start)/HOUR)-1];
  for(let y=new Date(period.start).getUTCFullYear();Date.UTC(y,0,1)<period.end;y++){
    const a=Math.max(period.start,Date.UTC(y,0,1)),b=Math.min(period.end,Date.UTC(y+1,0,1));
    out[y]=value(b)/value(a)-1;
  }
  return out;
}
const slim=({equity,daily,...m})=>m;
const summary=(r,period)=>({...slim(r.metrics),years:yearly(r.metrics,period),
  desks:Object.fromEntries(r.desks.map(d=>[d.coin,{final:d.final,roundTrips:d.roundTrips,orders:d.orders,fees:d.fees,funding:d.funding,liquidations:d.liquidations,timeInMarket:d.timeInMarket,shortShare:d.shortShare}])),
  trades:r.desks.flatMap(d=>d.trades.map(t=>({coin:d.coin,...t})))});
const pct=x=>(x*100).toFixed(2)+' %';

export async function run(){
  const protocol=await readFile(new URL('floor-trend-protocol.md',import.meta.url),'utf8');
  const core=await readFile(new URL('floor-trend-core.mjs',import.meta.url),'utf8');
  const {data,manifest}=await loadFloorData('binance');
  const prepared=Object.fromEntries(Object.entries(data).map(([c,raw])=>[c,prepare(raw)]));
  const names=[...STRATEGIES,...REFERENCES],signals=signalsFor(prepared,names);
  const hashes={protocol:sha(protocol),core:sha(core),data:Object.fromEntries(Object.entries(manifest.files).map(([c,f])=>[c,f.sha256]))};

  // 1. Development only, then lock the choice.
  const development={};
  for(const name of names){
    development[name]={normal:summary(runFirm(prepared,signals,name,PERIODS.development),PERIODS.development),
      stress:summary(runFirm(prepared,signals,name,PERIODS.development,{costs:STRESS}),PERIODS.development)};
    const m=development[name].normal;
    process.stdout.write(`dev ${name.padEnd(10)} net ${pct(m.net).padStart(10)} sharpe ${m.sharpe.toFixed(2).padStart(6)} dd ${pct(m.maxDD).padStart(9)} rt ${m.roundTrips} stress ${pct(development[name].stress.net)}\n`);
  }
  const eligible=STRATEGIES.filter(n=>development[n].normal.net>0&&development[n].stress.net>0&&development[n].normal.roundTrips>=20);
  const selected=[...eligible].sort((a,b)=>development[b].normal.sharpe-development[a].normal.sharpe||development[a].normal.maxDD-development[b].normal.maxDD)[0]??null;
  const lock={lockedAt:new Date().toISOString(),hashes,eligible,selected,development:Object.fromEntries(names.map(n=>[n,{normal:{net:development[n].normal.net,sharpe:development[n].normal.sharpe,maxDD:development[n].normal.maxDD,roundTrips:development[n].normal.roundTrips},stress:{net:development[n].stress.net}}]))};
  await writeFile(new URL('selection-lock.json',DATA_DIR),JSON.stringify(lock,null,2)+'\n');
  process.stdout.write('eligible: '+eligible.join(', ')+'\nselected: '+selected+'\n');

  // 2. Validation and the descriptive early period for every candidate.
  const validation={},early={};
  for(const name of names){
    validation[name]={normal:summary(runFirm(prepared,signals,name,PERIODS.validation),PERIODS.validation),
      stress:summary(runFirm(prepared,signals,name,PERIODS.validation,{costs:STRESS}),PERIODS.validation)};
    early[name]={normal:summary(runFirm(prepared,signals,name,PERIODS.early),PERIODS.early)};
    const m=validation[name].normal;
    process.stdout.write(`val ${name.padEnd(10)} net ${pct(m.net).padStart(10)} sharpe ${m.sharpe.toFixed(2).padStart(6)} dd ${pct(m.maxDD).padStart(9)} rt ${m.roundTrips} stress ${pct(validation[name].stress.net)}\n`);
  }
  const validated=selected?validation[selected].normal.net>0&&validation[selected].stress.net>0&&validation[selected].normal.sharpe>0&&validation[selected].stress.sharpe>0:false;

  // 3. Risk levels for the selected signal.
  const risk={};let level=null;
  if(selected){
    for(const target of RISK_LEVELS){
      const sizing={...SIZING,volTarget:target,maxLeverage:target/.25};
      risk[target]={development:summary(runFirm(prepared,signals,selected,PERIODS.development,{sizing}),PERIODS.development),
        validation:summary(runFirm(prepared,signals,selected,PERIODS.validation,{sizing}),PERIODS.validation),
        validationStress:summary(runFirm(prepared,signals,selected,PERIODS.validation,{sizing,costs:STRESS}),PERIODS.validation)};
      const d=risk[target].development,v=risk[target].validation;
      process.stdout.write(`risk ${target} dev net ${pct(d.net)} cagr ${pct(d.cagr)} dd ${pct(d.maxDD)} liq ${d.liquidations} | val net ${pct(v.net)} cagr ${pct(v.cagr)} dd ${pct(v.maxDD)} liq ${v.liquidations}\n`);
    }
    level=RISK_LEVELS.filter(t=>risk[t].development.maxDD<=.4&&risk[t].development.liquidations===0)
      .sort((a,b)=>risk[b].development.cagr-risk[a].development.cagr)[0]??null;
    process.stdout.write('default risk level: '+level+'\n');
  }

  // 4. Descriptive sensitivity of the selected signal at the base sizing.
  const sensitivity={};
  if(selected){
    const {data:bybit,manifest:bm}=await loadFloorData('bybit');
    const bp=Object.fromEntries(Object.entries(bybit).map(([c,raw])=>[c,prepare(raw)]));
    sensitivity.bybit=summary(runFirm(bp,signalsFor(bp,[selected]),selected,PERIODS.validation),PERIODS.validation);
    hashes.bybit=Object.fromEntries(Object.entries(bm.files).map(([c,f])=>[c,f.sha256]));
    for(const days of [60,120]){
      const p=Object.fromEntries(Object.entries(data).map(([c,raw])=>[c,prepare(raw,days)]));
      sensitivity['vol'+days]={development:summary(runFirm(p,signals,selected,PERIODS.development,{sizing:{...SIZING,volDays:days}}),PERIODS.development),
        validation:summary(runFirm(p,signals,selected,PERIODS.validation,{sizing:{...SIZING,volDays:days}}),PERIODS.validation)};
    }
    for(const band of [.1,.5])sensitivity['band'+band]={development:summary(runFirm(prepared,signals,selected,PERIODS.development,{sizing:{...SIZING,band}}),PERIODS.development),
      validation:summary(runFirm(prepared,signals,selected,PERIODS.validation,{sizing:{...SIZING,band}}),PERIODS.validation)};
    const slip2={...COSTS,slip:.002};
    sensitivity.slip20={development:summary(runFirm(prepared,signals,selected,PERIODS.development,{costs:slip2}),PERIODS.development),
      validation:summary(runFirm(prepared,signals,selected,PERIODS.validation,{costs:slip2}),PERIODS.validation)};
  }
  // 5. Post-hoc description: levels above the protocol, desk drawdowns, trade shape, price change.
  const extra={levels:{},trades:{},priceChange:{}};
  const deskDD=r=>Math.max(...r.desks.map(d=>{let pk=100,dd=0;for(const v of d.equity){pk=Math.max(pk,v);dd=Math.max(dd,1-v/pk);}return dd;}));
  if(selected){
    for(const target of [...RISK_LEVELS,...EXTRA_LEVELS]){
      const sizing={...SIZING,volTarget:target,maxLeverage:target/.25};extra.levels[target]={};
      for(const period of ['development','validation']){
        const r=runFirm(prepared,signals,selected,PERIODS[period],{sizing}),m=r.metrics;
        extra.levels[target][period]={net:m.net,cagr:m.cagr,sharpe:m.sharpe,maxDD:m.maxDD,worstDeskDD:deskDD(r),liquidations:m.liquidations,peakExposure:Math.max(...r.desks.map(d=>d.peakExposure))};
        if(target===level){
          const closed=r.desks.flatMap(d=>d.trades.filter(t=>!t.open&&t.opened)),hold=closed.map(t=>(t.closed-t.opened)/HOUR).sort((a,b)=>a-b),years=(PERIODS[period].end-PERIODS[period].start)/DAY/365.25;
          extra.trades[period]={closed:closed.length,winShare:closed.filter(t=>t.pnl>0).length/closed.length,medianHours:hold[hold.length>>1],p90Hours:hold[Math.floor(hold.length*.9)],
            perDeskYear:closed.length/r.desks.length/years,timeInMarket:m.timeInMarket,best:Math.max(...closed.map(t=>t.pnl)),worst:Math.min(...closed.map(t=>t.pnl)),
            topFiveShare:closed.map(t=>t.pnl).filter(x=>x>0).sort((a,b)=>b-a).slice(0,5).reduce((s,x)=>s+x,0)/closed.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0)};
        }
      }
    }
  }
  for(const [name,period] of Object.entries(PERIODS))extra.priceChange[name]=Object.fromEntries(period.coins.map(c=>{
    const b=data[c].bars,first=b[0].t;return [c,b[(period.end-first)/HOUR-1].c/b[(period.start-first)/HOUR].o-1];}));
  const results={generatedAt:new Date().toISOString(),hashes,periods:PERIODS,costs:{normal:COSTS,stress:STRESS},sizing:SIZING,
    eligible,selected,validated,riskLevel:level,development,validation,early,risk,sensitivity,extra};
  await writeFile(new URL('results.json',DATA_DIR),JSON.stringify(results));
  return results;
}
if(process.argv[1]===fileURLToPath(import.meta.url))await run();
