// Long hourly perpetual history for the trading floor trend research.
// Binance USDT-M perpetuals give the longest continuous hourly record
// (listings 2019-2021). Bybit's own desk contracts are fetched as a venue
// cross-check for the years they exist. Public market data only.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const COINS=Object.freeze(['BTC','ETH','SOL','XRP','DOGE','SHIB']);
export const BINANCE=Object.freeze({BTC:'BTCUSDT',ETH:'ETHUSDT',SOL:'SOLUSDT',XRP:'XRPUSDT',DOGE:'DOGEUSDT',SHIB:'1000SHIBUSDT'});
export const BYBIT=Object.freeze({BTC:'BTCUSDT',ETH:'ETHUSDT',SOL:'SOLUSDT',XRP:'XRPUSDT',DOGE:'DOGEUSDT',SHIB:'SHIB1000USDT'});
// Both SHIB contracts quote 1000 tokens; prices are normalised to one token.
export const UNITS=Object.freeze({BTC:1,ETH:1,SOL:1,XRP:1,DOGE:1,SHIB:1000});
export const DATA_END=Date.parse('2026-09-23T00:00:00Z');
export const HOUR=3600000;
export const DATA_DIR=new URL('../.matning/floor-trend/',import.meta.url);
export const sha=data=>createHash('sha256').update(data).digest('hex');
const wait=ms=>new Promise(r=>setTimeout(r,ms));

async function getJson(url){
  let error;
  for(let attempt=0;attempt<6;attempt++){
    try{
      const res=await fetch(url,{signal:AbortSignal.timeout(30000)});
      if(!res.ok)throw Error('HTTP '+res.status);
      return await res.json();
    }catch(e){error=e;await wait(500*(attempt+1));}
  }
  throw Error(url+': '+error.message);
}

// Missing exchange hours become flat bars at the previous close with zero
// volume. They are counted and reported; no price is invented beyond that.
function continuous(rows,coin,end){
  const sorted=[...rows.values()].sort((a,b)=>a.t-b.t),out=[];let filled=0;
  if(!sorted.length)throw Error(coin+' has no bars');
  for(let t=sorted[0].t,i=0;t<end;t+=HOUR){
    const b=sorted[i]?.t===t?sorted[i++]:null;
    if(b){
      if(![b.o,b.h,b.l,b.c].every(x=>Number.isFinite(x)&&x>0)||b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c))throw Error(coin+' invalid bar '+t);
      out.push(b);
    }else{
      const c=out.at(-1)?.c;if(!c)throw Error(coin+' leading gap');
      out.push({t,o:c,h:c,l:c,c,v:0});filled++;
    }
  }
  return {bars:out,filled};
}

// startTime=0 counts as absent on the funding endpoint and returns only the latest page.
const EPOCH=Date.parse('2017-01-01T00:00:00Z');
async function binanceBars(coin){
  const rows=new Map(),scale=UNITS[coin];let start=EPOCH;
  for(;;){
    const list=await getJson('https://fapi.binance.com/fapi/v1/klines?'+new URLSearchParams({symbol:BINANCE[coin],interval:'1h',startTime:String(start),endTime:String(DATA_END-1),limit:'1500'}));
    if(!Array.isArray(list))throw Error('Binance klines '+coin+': '+JSON.stringify(list).slice(0,200));
    if(!list.length)break;
    for(const r of list){const t=+r[0];if(t%HOUR)throw Error(coin+' off-hour bar');if(t<DATA_END)rows.set(t,{t,o:+r[1]/scale,h:+r[2]/scale,l:+r[3]/scale,c:+r[4]/scale,v:+r[5]*scale});}
    const last=+list.at(-1)[0];if(last+HOUR>=DATA_END||list.length<1500)break;
    start=last+HOUR;await wait(120);
  }
  return continuous(rows,coin,DATA_END);
}

async function binanceFunding(coin){
  const rows=new Map();let start=EPOCH;
  for(;;){
    const list=await getJson('https://fapi.binance.com/fapi/v1/fundingRate?'+new URLSearchParams({symbol:BINANCE[coin],startTime:String(start),endTime:String(DATA_END-1),limit:'1000'}));
    if(!Array.isArray(list))throw Error('Binance funding '+coin+': '+JSON.stringify(list).slice(0,200));
    if(!list.length)break;
    for(const r of list){
      // Settlement stamps carry a few milliseconds of jitter.
      const t=Math.round(+r.fundingTime/HOUR)*HOUR,rate=+r.fundingRate;
      if(!Number.isFinite(rate)||Math.abs(rate)>.05)throw Error('Invalid funding '+coin+' '+r.fundingTime);
      if(t<DATA_END)rows.set(t,{t,rate});
    }
    // The endpoint may return fewer rows than the limit per page; stop only when a page is empty.
    const last=+list.at(-1).fundingTime;if(last>=DATA_END-1||last<start)break;
    start=last+1;await wait(150);
  }
  return [...rows.values()].sort((a,b)=>a.t-b.t);
}

// Bybit occasionally answers a valid request with a transient service error.
async function bybitList(path,params){
  let error;
  for(let attempt=0;attempt<6;attempt++){
    const j=await getJson('https://api.bybit.com/v5/market/'+path+'?'+new URLSearchParams(params));
    if(j.retCode===0&&Array.isArray(j.result?.list))return j.result.list;
    error=Error('Bybit '+path+' '+j.retCode+' '+j.retMsg);await wait(800*(attempt+1));
  }
  throw error;
}
async function bybitLaunch(coin){
  const [info]=await bybitList('instruments-info',{category:'linear',symbol:BYBIT[coin]});
  const t=+info?.launchTime;if(!Number.isFinite(t)||t<=0)throw Error('Bybit launch time '+coin);
  return Math.floor(t/HOUR)*HOUR;
}
// Fixed windows walk back to the listing, so a gap inside one window cannot end the download early.
async function bybitBars(coin){
  const rows=new Map(),scale=UNITS[coin],launch=await bybitLaunch(coin);
  for(let end=DATA_END-1;end>=launch;end-=1000*HOUR){
    const list=await bybitList('kline',{category:'linear',symbol:BYBIT[coin],interval:'60',start:String(Math.max(launch,end-1000*HOUR+1)),end:String(end),limit:'1000'});
    for(const r of list){const t=+r[0];if(t<DATA_END)rows.set(t,{t,o:+r[1]/scale,h:+r[2]/scale,l:+r[3]/scale,c:+r[4]/scale,v:+r[5]*scale});}
    await wait(60);
  }
  return continuous(rows,coin,DATA_END);
}
async function bybitFunding(coin){
  const rows=new Map(),launch=await bybitLaunch(coin),span=150*HOUR;
  for(let end=DATA_END-1;end>=launch;end-=span){
    const list=await bybitList('funding/history',{category:'linear',symbol:BYBIT[coin],startTime:String(Math.max(launch,end-span+1)),endTime:String(end),limit:'200'});
    if(list.length>=200)throw Error('Bybit funding window too wide '+coin);
    for(const r of list){const t=Math.round(+r.fundingRateTimestamp/HOUR)*HOUR,rate=+r.fundingRate;if(!Number.isFinite(rate)||Math.abs(rate)>.05)throw Error('Invalid Bybit funding '+coin);if(t<DATA_END)rows.set(t,{t,rate});}
    await wait(60);
  }
  return [...rows.values()].sort((a,b)=>a.t-b.t);
}

const SOURCES={binance:{bars:binanceBars,funding:binanceFunding,contracts:BINANCE},bybit:{bars:bybitBars,funding:bybitFunding,contracts:BYBIT}};

export async function loadFloorData(source='binance',{download=false}={}){
  const src=SOURCES[source];if(!src)throw Error('Unknown source '+source);
  await mkdir(DATA_DIR,{recursive:true});
  const data={},manifest={source,end:DATA_END,assembledAt:new Date().toISOString(),files:{}};
  for(const coin of COINS){
    const url=new URL(source+'-'+coin+'.json',DATA_DIR);let raw;
    try{raw=await readFile(url,'utf8');}catch(e){if(!download)throw e;}
    if(!raw){
      const [{bars,filled},funding]=await Promise.all([src.bars(coin),src.funding(coin)]);
      raw=JSON.stringify({coin,source,contract:src.contracts[coin],scale:UNITS[coin],end:DATA_END,filled,bars,funding});
      await writeFile(url,raw);
      process.stdout.write(source+' '+coin+': '+bars.length+' bars from '+new Date(bars[0].t).toISOString().slice(0,10)+', '+filled+' filled, '+funding.length+' funding\n');
    }
    data[coin]=JSON.parse(raw);
    if(data[coin].end!==DATA_END)throw Error('Cached range mismatch '+coin);
    manifest.files[coin]={sha256:sha(raw),bars:data[coin].bars.length,first:data[coin].bars[0].t,filled:data[coin].filled,funding:data[coin].funding.length};
  }
  await writeFile(new URL(source+'-manifest.json',DATA_DIR),JSON.stringify(manifest,null,2)+'\n');
  return {data,manifest};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const download=process.argv.includes('--download');
  for(const source of process.argv.includes('--bybit')?['binance','bybit']:['binance'])await loadFloorData(source,{download});
}
