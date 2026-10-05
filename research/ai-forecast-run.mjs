// Runs ai-forecast-protocol.md on the real AI Forecast engine (forecast-model.js,
// forecast-account.js, forecast-backtest.js). The development choice is written
// to selection-lock.json before any validation number exists. The validation
// year is one continuous 100 $ run per setting, reported per calendar quarter;
// each quarter's forecasts draw analogs only from the 1 500 hours before it.
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loadForecastData,DATA_DIR,START,DATA_END,HOUR,sha} from './ai-forecast-data.mjs';
import {SYMBOLS,SIGNAL_PARAMS,FORECAST_PARAMS} from '../forecast-config.js';
import {forecastFeatures,requiredLookback} from '../forecast-model.js';
import {ACCOUNT} from '../forecast-account.js';
import {DEV_END,simulate,walkForward,metricsOf,forecastErrors} from '../forecast-backtest.js';

const DAY=86400000;
// Only breakout, stop and target vary; every other rule is the frozen SIGNAL_PARAMS.
export const CANDIDATES=Object.freeze([[20,1.5,2],[20,1.5,3],[20,2.5,2],[20,2.5,3],[40,1.5,2],[40,1.5,3],[40,2.5,2],[40,2.5,3]]
  .map(([breakout,slAtr,tpR])=>Object.freeze({code:`b${breakout}-s${slAtr}-t${tpR}`,params:Object.freeze({...SIGNAL_PARAMS,breakout,slAtr,tpR})})));
// The protocol's default is the setting the code started with, whatever the config holds later.
export const DEFAULT_CODE='b20-s1.5-t2';
export const REFERENCE=Object.freeze({riskPct:.01,positionPct:.25,leverage:10});
export const ACCOUNT_DEFAULT=Object.freeze({});
export const COSTS=Object.freeze({normal:ACCOUNT.slip,stress:.001});
export const MIN_TRADES=150,STRIDE=4,HORIZONS=Object.freeze([5,10,20]);
export const QUARTERS=Object.freeze([
  {key:'2025Q4',label:'okt–dec 2025',from:Date.UTC(2025,9,1),to:Date.UTC(2026,0,1)},
  {key:'2026Q1',label:'jan–mar 2026',from:Date.UTC(2026,0,1),to:Date.UTC(2026,3,1)},
  {key:'2026Q2',label:'apr–jun 2026',from:Date.UTC(2026,3,1),to:Date.UTC(2026,6,1)},
  {key:'2026Q3',label:'jul–sep 2026',from:Date.UTC(2026,6,1),to:Date.UTC(2026,9,1)}
].map(q=>Object.freeze(q)));
const ENGINE=['forecast-config.js','forecast-model.js','forecast-account.js','forecast-backtest.js','forecast-market.js','bybit-contracts.js'];
// A source file's hash on its text with LF line ends, so a Windows checkout (core.autocrlf) gives the published hash.
export const sourceHash=text=>sha(text.replace(/\r\n/g,'\n'));
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const mean=xs=>xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:null;
const pct=x=>finite(x)?(x*100).toFixed(2)+' %':'–';
const fix=(x,d=2)=>finite(x)?x.toFixed(d):'–';
const log=s=>process.stdout.write(s+'\n');

// The fixed rules of the protocol, so a later edit of the config cannot slip into a rerun unnoticed.
function checkFrozen(){
  const p=SIGNAL_PARAMS,f=FORECAST_PARAMS,d=ACCOUNT.defaults;
  const ok=p.emaFast===20&&p.emaSlow===50&&p.emaWindow===4&&p.slopeBars===10&&p.adxPeriod===14&&p.adxTrend===22&&p.adxRange===18&&
    p.rsiPeriod===14&&p.rsiLong.join()==='50,75'&&p.rsiShort.join()==='25,50'&&p.rocPeriod===10&&p.volMedian===20&&p.volMin===1.1&&
    p.atrPeriod===14&&p.volRankWindow===200&&p.volRankMin===.1&&p.volRankMax===.95&&p.htfEma===20&&p.htfWindow===3&&p.cooldown===5&&p.maxHold===20&&
    f.k===30&&f.train===1500&&f.horizon===20&&ACCOUNT.start===100&&ACCOUNT.fee===.00055&&ACCOUNT.slip===.0005&&
    d.positionPct===.25&&d.riskPct===.1&&d.maxOpen===3&&d.leverage==='max'&&d.tf==='1h'&&DEV_END===Date.UTC(2025,9,1);
  if(!ok)throw Error('The engine constants no longer match ai-forecast-protocol.md');
  for(const c of CANDIDATES)if(requiredLookback('1h',c.params)!==requiredLookback('1h',SIGNAL_PARAMS))throw Error('Lookback differs for '+c.code);
}

const countBy=(xs,f)=>xs.reduce((o,x)=>{const k=f(x);o[k]=(o[k]??0)+1;return o;},{});
// UTC-midnight equity (plus the first and last point): enough to redraw the curve and check the Sharpe days.
const daily=eq=>eq.filter((p,i)=>!i||i===eq.length-1||p.t%DAY===0).map(p=>[p.t,p.v]);
function shape(r){
  return {reasons:countBy(r.trades,t=>t.reason),bySide:countBy(r.trades,t=>t.side),avgLeverage:mean(r.trades.map(t=>t.leverage)),
    maxLeverage:r.trades.length?Math.max(...r.trades.map(t=>t.leverage)):null,avgMargin:mean(r.trades.map(t=>t.margin)),
    avgHoldHours:mean(r.trades.map(t=>(t.closedAt-t.openedAt)/HOUR)),signals:r.decisions.length,skipped:r.skipped,notes:r.notes,ledger:r.ledger};
}
// Every trade and every signal decision, kept apart from the summary so the report stays light.
const rawOf=r=>({equityDaily:daily(r.equity),trades:r.trades,decisions:r.decisions.map(d=>[d.t,d.symbol,d.side,d.trade,d.reason])});

// A calendar quarter of one continuous run, sliced as walkForward slices its own
// windows: trades by the quarter they opened in, the curve from the equity at the
// quarter start. An account emptied earlier has nothing left to trade.
function quarterOf(run,q){
  let base=ACCOUNT.start;const curve=[];
  for(const p of run.equity){if(p.t<=q.from)base=p.v;else if(p.t<=q.to)curve.push(p);}
  const trades=run.trades.filter(t=>t.openedAt>=q.from&&t.openedAt<q.to);
  const m=base>0?metricsOf(trades,[{t:q.from,v:base},...curve],base):metricsOf(trades,[],ACCOUNT.start);
  return {key:q.key,label:q.label,startEquity:base,endEquity:curve.at(-1)?.v??base,...m,reasons:countBy(trades,t=>t.reason)};
}
function validationRun(series,contracts,params,settings,slip,raw,key){
  const w=walkForward({series,tf:'1h',params,settings,contracts,serverTime:DATA_END,slip});
  const quarters=QUARTERS.map(q=>quarterOf(w,q)),net=quarters.reduce((s,q)=>s+q.net,0);
  if(Math.abs(net-w.aggregate.trading.net)>1e-6*Math.max(1,Math.abs(net)))throw Error('Quarters do not add up to the year');
  raw[key]=rawOf(w);
  return {metrics:w.aggregate.trading,quarters,bySymbol:w.aggregate.bySymbol,
    engineFolds:w.folds.map(f=>({train:f.train,test:f.test,trading:f.trading,forecast:f.forecast,library:f.library})),
    engineForecast:w.aggregate.forecast,...shape(w)};
}

// Pools per-coin forecastErrors with sums (a ratio of sums, as walkForward pools its windows).
function pool(list){
  const out={};
  for(const h of HORIZONS){
    let n=0,abs=0,naive=0,scen=0,hits=0,dirN=0,in50=0,in80=0,missing=0;
    for(const e of list){
      const r=e[h];n+=r.n;dirN+=r.dirN;missing+=r.missing;
      if(r.n){abs+=r.mae*r.n;naive+=r.naiveMae*r.n;scen+=r.scenarioMae*r.n;in50+=Math.round(r.cover50*r.n);in80+=Math.round(r.cover80*r.n);}
      if(r.dirN)hits+=Math.round(r.dirHit*r.dirN);
    }
    out[h]={h,n,mae:n?abs/n:null,naiveMae:n?naive/n:null,skill:n&&naive>0?1-abs/naive:null,dirHit:dirN?hits/dirN:null,dirN,
      cover50:n?in50/n:null,cover80:n?in80/n:null,scenarioMae:n?scen/n:null,missing};
  }
  return out;
}
// The af-forecast-v1 study: every 4th hour per coin, each calendar quarter with a
// fixed library of the 1 500 hours before it (analog outcomes end before it too).
function forecastStudy(series){
  const rows=[];
  for(const symbol of SYMBOLS){
    const bars=series[symbol].bars,features=forecastFeatures(bars),last=bars.at(-1).t;
    for(const q of QUARTERS){
      const first=bars.findIndex(b=>b.t>=q.from),from=bars.findIndex(b=>b.t>=q.from-FORECAST_PARAMS.train*HOUR),cutoffs=[];
      if(first<=0||bars[first].t!==q.from||from<0)throw Error('No history before '+q.key+' for '+symbol);
      for(let i=first;i<bars.length&&bars[i].t<q.to;i+=STRIDE)cutoffs.push(i);
      const errors=forecastErrors({bars,tf:'1h',cutoffs,library:{from,to:first-1},horizons:[...HORIZONS],params:FORECAST_PARAMS,features});
      // A cutoff is missing when its forecast failed or its real candle lies past the data end.
      const failed=HORIZONS.map(h=>errors[h].missing-cutoffs.filter(c=>bars[c].t+h*HOUR>last).length);
      if(new Set(failed).size!==1||failed[0]<0)throw Error('Inconsistent forecast counts for '+symbol+' '+q.key);
      rows.push({quarter:q.key,symbol,cutoffs:cutoffs.length,failed:failed[0],library:{from:bars[from].t,to:bars[first-1].t,candles:first-from},errors});
    }
  }
  const sumOf=list=>({cutoffs:list.reduce((s,r)=>s+r.cutoffs,0),failed:list.reduce((s,r)=>s+r.failed,0),errors:pool(list.map(r=>r.errors))});
  return {quarters:QUARTERS.map(q=>({key:q.key,label:q.label,...sumOf(rows.filter(r=>r.quarter===q.key))})),
    bySymbol:Object.fromEntries(SYMBOLS.map(s=>[s,sumOf(rows.filter(r=>r.symbol===s))])),overall:sumOf(rows),rows};
}

export async function run({data=null,out=DATA_DIR}={}){
  checkFrozen();
  const {series,contracts,manifest}=data??await loadForecastData();
  const file=name=>readFile(new URL(name,import.meta.url),'utf8');
  const hashes={protocol:sourceHash(await file('ai-forecast-protocol.md')),run:sourceHash(await file('ai-forecast-run.mjs')),
    engine:Object.fromEntries(await Promise.all(ENGINE.map(async f=>[f,sourceHash(await file('../'+f))]))),
    data:Object.fromEntries(Object.entries(manifest.files).map(([s,f])=>[s,f.sha256])),contracts:manifest.contracts.sha256};

  // 1. Development only, then lock the choice to disk. The runs get no candle from the validation year at all
  // (funding through DEV_END, which a position still open at the period end pays as it closes).
  const devSeries=Object.fromEntries(Object.entries(series).map(([s,x])=>[s,{bars:x.bars.filter(b=>b.t<DEV_END),funding:x.funding.filter(f=>f.t<=DEV_END)}]));
  const development={},raw={};
  for(const c of CANDIDATES){
    development[c.code]={};
    for(const [cost,slip] of Object.entries(COSTS)){
      // `to` is the open of the last candle: the one closing at DEV_END.
      const r=simulate({series:devSeries,tf:'1h',params:c.params,settings:REFERENCE,contracts,from:START,to:DEV_END-HOUR,serverTime:DEV_END,slip});
      development[c.code][cost]={metrics:r.metrics,from:r.from,to:r.to,...shape(r)};
      raw[`development/${c.code}/${cost}`]=rawOf(r);
    }
    const m=development[c.code].normal.metrics,s=development[c.code].stress.metrics;
    log(`dev ${c.code.padEnd(12)} trades ${String(m.trades).padStart(5)} win ${pct(m.winRate)} net ${pct(m.netPct).padStart(9)} pf ${fix(m.profitFactor)} dd ${pct(m.maxDrawdownPct)} sharpe ${fix(m.sharpe)} | stress net ${pct(s.netPct)} pf ${fix(s.profitFactor)}`);
  }
  const dm=k=>development[k].normal.metrics,ds=k=>development[k].stress.metrics;
  const eligible=CANDIDATES.map(c=>c.code).filter(k=>dm(k).trades>=MIN_TRADES&&dm(k).net>0&&ds(k).net>0);
  const sharpe=k=>dm(k).sharpe??-Infinity;
  const selected=[...eligible].sort((a,b)=>sharpe(b)-sharpe(a)||dm(a).maxDrawdownPct-dm(b).maxDrawdownPct)[0]??null;
  const lock={lockedAt:new Date().toISOString(),hashes,rule:'trades >= 150 (normal), net > 0 at normal and stressed slippage; highest daily Sharpe at normal cost, ties by lower max drawdown',
    eligible,selected,development:Object.fromEntries(CANDIDATES.map(({code:k})=>[k,{normal:{trades:dm(k).trades,net:dm(k).net,sharpe:dm(k).sharpe,maxDrawdownPct:dm(k).maxDrawdownPct},
      stress:{trades:ds(k).trades,net:ds(k).net}}]))};
  await writeFile(new URL('selection-lock.json',out),JSON.stringify(lock,null,2)+'\n');
  log('eligible: '+(eligible.join(', ')||'none')+'\nselected: '+(selected??'none'));

  // 2. Validation, written after the lock: the chosen setting (the default when nothing qualified) decides;
  // the other candidates are run only so that all of them are reported.
  const chosen=selected??DEFAULT_CODE,params=k=>CANDIDATES.find(c=>c.code===k).params,validation={};
  for(const {code} of [CANDIDATES.find(c=>c.code===chosen),...CANDIDATES.filter(c=>c.code!==chosen)]){
    validation[code]={};
    for(const [cost,slip] of Object.entries(COSTS))validation[code][cost]=validationRun(series,contracts,params(code),REFERENCE,slip,raw,`validation/${code}/${cost}`);
    const m=validation[code].normal.metrics,s=validation[code].stress.metrics;
    log(`val ${code.padEnd(12)} trades ${String(m.trades).padStart(5)} win ${pct(m.winRate)} net ${pct(m.netPct).padStart(9)} pf ${fix(m.profitFactor)} dd ${pct(m.maxDrawdownPct)} sharpe ${fix(m.sharpe)} | stress net ${pct(s.netPct)} pf ${fix(s.profitFactor)}`);
  }
  const pfOver1=m=>m.profitFactor===null?m.wins>0:m.profitFactor>1;
  const vn=validation[chosen].normal.metrics,vs=validation[chosen].stress.metrics;
  const validated=selected!==null&&vn.net>0&&vs.net>0&&pfOver1(vn)&&pfOver1(vs);
  log(`validation of ${chosen}: ${validated?'approved':'not approved'}`);

  // 3. The account default on the same year (descriptive): Bybit's max leverage, 25 % margin, 10 % risk, 3 positions.
  const accountDefault={};
  for(const [cost,slip] of Object.entries(COSTS)){
    accountDefault[cost]=validationRun(series,contracts,params(chosen),ACCOUNT_DEFAULT,slip,raw,`accountDefault/${chosen}/${cost}`);
    const m=accountDefault[cost].metrics;
    log(`account default ${cost}: trades ${m.trades} net ${pct(m.netPct)} pf ${fix(m.profitFactor)} dd ${pct(m.maxDrawdownPct)} liquidations ${m.liquidations}`);
  }

  // 4. The forecast model, independent of the signal parameters.
  const forecast=forecastStudy(series);
  const skillPositive=HORIZONS.every(h=>forecast.overall.errors[h].skill>0);
  for(const h of HORIZONS){const e=forecast.overall.errors[h];log(`forecast h${h}: n ${e.n} mae ${pct(e.mae)} naive ${pct(e.naiveMae)} skill ${fix(e.skill,4)} dir ${pct(e.dirHit)} in50 ${pct(e.cover50)} in80 ${pct(e.cover80)} scenario ${pct(e.scenarioMae)}`);}
  log('forecast skill > 0 on all horizons: '+skillPositive);

  // 5. Look-ahead check: the default's development run with the whole history, validation year included,
  // must equal the run that never saw it.
  const full=simulate({series,tf:'1h',params:params(DEFAULT_CODE),settings:REFERENCE,contracts,from:START,to:DEV_END-HOUR,serverTime:DATA_END});
  const lookAheadFree=JSON.stringify(full.metrics)===JSON.stringify(development[DEFAULT_CODE].normal.metrics)&&JSON.stringify(full.trades)===JSON.stringify(raw[`development/${DEFAULT_CODE}/normal`].trades);
  if(!lookAheadFree)throw Error('The development result changes when the validation year is present');

  // Context: price change per coin over each period (open of the first hour to the last close).
  const priceChange={};
  for(const [name,from,to] of [['development',START,DEV_END],['validation',DEV_END,DATA_END]])
    priceChange[name]=Object.fromEntries(SYMBOLS.map(s=>{
      const b=series[s].bars,i=b.findIndex(x=>x.t>=from),j=b.findLastIndex(x=>x.t<to);
      return [s,{from:b[i].t,change:b[j].c/b[i].o-1}];
    }));
  const changed=Object.fromEntries(Object.entries(params(chosen)).filter(([k,v])=>selected!==null&&v!==SIGNAL_PARAMS[k]));
  const results={generatedAt:new Date().toISOString(),lockedAt:lock.lockedAt,hashes,manifest,
    periods:{development:{from:START,to:DEV_END},validation:{from:DEV_END,to:DATA_END}},quarters:QUARTERS,
    costs:COSTS,fee:ACCOUNT.fee,reference:REFERENCE,accountDefaultSettings:{...ACCOUNT.defaults},
    candidates:CANDIDATES.map(c=>({code:c.code,breakout:c.params.breakout,slAtr:c.params.slAtr,tpR:c.params.tpR})),defaultCode:DEFAULT_CODE,
    minTrades:MIN_TRADES,eligible,selected,chosen,selectedParams:changed,validated,lookAheadFree,development,validation,accountDefault,
    forecast:{params:FORECAST_PARAMS,stride:STRIDE,horizons:HORIZONS,skillPositive,...forecast},priceChange,
    leverageToday:Object.fromEntries(SYMBOLS.map(s=>[s,contracts[s].max]))};
  await writeFile(new URL('results.json',out),JSON.stringify(results));
  await writeFile(new URL('runs.json',out),JSON.stringify({generatedAt:results.generatedAt,hashes,runs:raw}));
  log('wrote results.json and runs.json in '+fileURLToPath(out));
  return results;
}
if(process.argv[1]===fileURLToPath(import.meta.url))await run();
