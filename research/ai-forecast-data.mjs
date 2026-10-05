// Hourly Bybit history, funding and today's leverage limits for the AI Forecast
// research (ai-forecast-protocol.md). Public market endpoints only, read through
// the feature's own parsers (forecast-market.js, bybit-contracts.js), so the
// research sees the candles exactly as the page and the demo account see them:
// linear USDT perpetuals, SHIB/PEPE per token, volume = USDT turnover.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SYMBOLS} from '../forecast-config.js';
import {CONTRACTS,CONTRACT_UNITS,fetchContract} from '../bybit-contracts.js';
import {fetchKlines,fetchFunding} from '../forecast-market.js';

export const START=Date.UTC(2022,0,1),DATA_END=Date.UTC(2026,9,1),HOUR=3600000;
export const DATA_DIR=new URL('../.matning/ai-forecast/',import.meta.url);
export const sha=data=>createHash('sha256').update(data).digest('hex');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const iso=t=>new Date(t).toISOString().slice(0,16).replace('T',' ');

// The page's grab(url,{json,timeout}) on plain fetch: paced, and retried because
// Bybit now and then answers a valid request with a transient error.
export async function grab(url,{timeout=8000}={}){
  let error;
  for(let attempt=0;attempt<6;attempt++){
    await wait(attempt?1500*attempt:80);
    try{
      const res=await fetch(url,{signal:AbortSignal.timeout(Math.max(timeout,20000))});
      if(!res.ok)throw Error('HTTP '+res.status);
      const j=await res.json();
      if(j?.retCode!==0)throw Error('Bybit '+j?.retCode+' '+j?.retMsg);
      return j;
    }catch(e){error=e;}
  }
  throw Error(url+': '+error.message);
}

// Pages back by end time from the last hour before DATA_END. Paging on the oldest
// candle returned means a gap inside a page cannot end the download early; an
// empty page means the listing start.
async function hourlyBars(symbol){
  const rows=new Map();let end=DATA_END-1;
  for(let pages=0;;pages++){
    if(pages>100)throw Error('Kline paging did not finish for '+symbol);
    const got=(await fetchKlines(grab,symbol,'1h',{limit:1000,end,timeout:20000})).bars.filter(b=>b.t<=end);
    if(!got.length)break;
    for(const b of got)if(b.t>=START)rows.set(b.t,b);
    if(got[0].t<=START)break;
    end=got[0].t-1;
  }
  return [...rows.values()].sort((a,b)=>a.t-b.t);
}

// Missing exchange hours become flat candles at the previous close with zero
// volume, as the protocol says. They are counted and listed per coin.
export function continuous(bars,symbol,end=DATA_END){
  if(!bars.length)throw Error(symbol+' has no candles');
  const out=[],gaps=[];let i=0;
  for(let t=bars[0].t;t<end;t+=HOUR){
    const b=bars[i]?.t===t?bars[i++]:null;
    if(b){out.push(b);continue;}
    const c=out.at(-1).c,g=gaps.at(-1);
    out.push({t,o:c,h:c,l:c,c,v:0});
    if(g&&g.to===t){g.to+=HOUR;g.hours++;}else gaps.push({from:t,to:t+HOUR,hours:1});
  }
  if(i!==bars.length)throw Error(symbol+' has candles outside the hourly range');
  return {bars:out,filled:gaps.reduce((s,g)=>s+g.hours,0),gaps};
}

async function download(symbol){
  const bars=await hourlyBars(symbol);
  // Funding through DATA_END itself: a position still open at the period end closes at that
  // moment, so the end of both periods is treated alike (the development end has it too).
  const funding=await fetchFunding(grab,symbol,{from:START,to:DATA_END});
  return JSON.stringify({symbol,contract:CONTRACTS[symbol],scale:CONTRACT_UNITS[symbol],start:START,end:DATA_END,
    fetchedAt:new Date().toISOString(),bars,funding});
}

function fundingCheck(funding,bars){
  const steps=funding.slice(1).map((f,i)=>f.t-funding[i].t);
  return {events:funding.length,first:funding[0]?.t??null,last:funding.at(-1)?.t??null,
    offHour:funding.filter(f=>f.t%HOUR).length,maxStepHours:steps.length?Math.max(...steps)/HOUR:null,
    beforeFirstCandle:funding.filter(f=>f.t<bars[0].t).length};
}

/**
 * Cached data (download=true fetches what is missing). → {series:{[symbol]:{bars
 * (continuous hourly, flat-filled),funding}},contracts:{[symbol]:limits},manifest}
 */
export async function loadForecastData({download:fetchMissing=false}={}){
  await mkdir(DATA_DIR,{recursive:true});
  const series={},manifest={start:START,end:DATA_END,assembledAt:new Date().toISOString(),files:{},contracts:null};
  for(const symbol of SYMBOLS){
    const url=new URL('bybit-'+symbol+'.json',DATA_DIR);let raw=null;
    try{raw=await readFile(url,'utf8');}catch(e){if(!fetchMissing)throw Error('No cached data for '+symbol+'; run node research/ai-forecast-data.mjs --download');}
    if(raw===null){
      raw=await download(symbol);
      await writeFile(url,raw);
    }
    const d=JSON.parse(raw);
    if(d.start!==START||d.end!==DATA_END||d.contract!==CONTRACTS[symbol])throw Error('Cached range or contract mismatch for '+symbol);
    const {bars,filled,gaps}=continuous(d.bars,symbol);
    series[symbol]={bars,funding:d.funding};
    // Zero-volume candles never signal (relative volume 0), so Bybit's own are counted too.
    manifest.files[symbol]={file:'bybit-'+symbol+'.json',sha256:sha(raw),contract:d.contract,fetchedAt:d.fetchedAt,candles:d.bars.length,
      first:bars[0].t,last:bars.at(-1).t,hours:bars.length,filled,gaps,zeroVolume:d.bars.filter(b=>b.v===0).length,funding:fundingCheck(d.funding,bars)};
    if(raw&&fetchMissing)process.stdout.write(`${symbol}: ${d.bars.length} candles from ${iso(bars[0].t)}, ${filled} filled hours in ${gaps.length} gaps, ${d.funding.length} funding\n`);
  }
  // Today's limits, read once: Bybit does not publish its historical tiers.
  const curl=new URL('contracts.json',DATA_DIR);let craw=null;
  try{craw=await readFile(curl,'utf8');}catch(e){if(!fetchMissing)throw Error('No cached Bybit limits; run node research/ai-forecast-data.mjs --download');}
  if(craw===null){
    const contracts={};
    for(const symbol of SYMBOLS)contracts[symbol]=await fetchContract(grab,symbol);
    craw=JSON.stringify({fetchedAt:new Date().toISOString(),contracts});
    await writeFile(curl,craw);
  }
  const {contracts,fetchedAt}=JSON.parse(craw);
  manifest.contracts={file:'contracts.json',sha256:sha(craw),fetchedAt,
    max:Object.fromEntries(SYMBOLS.map(s=>[s,{max:contracts[s].max,tiers:contracts[s].tiers.length,at:contracts[s].at}]))};
  await writeFile(new URL('manifest.json',DATA_DIR),JSON.stringify(manifest,null,2)+'\n');
  return {series,contracts,manifest};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const {manifest}=await loadForecastData({download:process.argv.includes('--download')});
  for(const [s,f] of Object.entries(manifest.files))
    process.stdout.write(`${s.padEnd(5)} ${iso(f.first)} → ${iso(f.last)}  ${f.hours} h, ${f.filled} filled (${f.gaps.length} gaps), funding ${f.funding.events} (off-hour ${f.funding.offHour}, max step ${f.funding.maxStepHours} h)  ${f.sha256.slice(0,12)}\n`);
  process.stdout.write('limits fetched '+manifest.contracts.fetchedAt+'\n');
}
