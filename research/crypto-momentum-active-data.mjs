import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CONTRACTS,CONTRACT_UNITS,fetchContract} from '../bybit-contracts.js';

export const DATA_START=Date.parse('2026-03-06T00:00:00Z');
export const DATA_END=Date.parse('2026-09-10T00:00:00Z');
export const DATA_DIR=new URL('../.matning/crypto-active/',import.meta.url);
const STEP=900000;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const sha=data=>createHash('sha256').update(data).digest('hex');
async function api(path,params){
  const url='https://api.bybit.com/v5/market/'+path+'?'+new URLSearchParams(params);
  let error;
  for(let attempt=0;attempt<5;attempt++){
    try{
      const res=await fetch(url,{signal:AbortSignal.timeout(25000)});
      if(!res.ok)throw Error('HTTP '+res.status);
      const j=await res.json();if(j.retCode!==0||!Array.isArray(j.result?.list))throw Error('Bybit '+j.retCode+' '+j.retMsg);
      if(j.result.category&&j.result.category!==params.category||j.result.symbol&&j.result.symbol!==params.symbol)throw Error('Unexpected Bybit response contract');
      return j.result.list;
    }catch(e){error=e;await wait(400*(attempt+1));}
  }
  throw Error(url+': '+error.message);
}
async function bars(symbol,path){
  const rows=new Map(),scale=CONTRACT_UNITS[symbol];let end=DATA_END-1;
  while(end>=DATA_START){
    const list=await api(path,{category:'linear',symbol:CONTRACTS[symbol],interval:'15',start:String(DATA_START),end:String(end),limit:'1000'});
    if(!list.length)throw Error(symbol+' missing '+path+' before '+new Date(end).toISOString());
    for(const r of list){const t=+r[0];if(t>=DATA_START&&t<DATA_END)rows.set(t,{t,o:+r[1]/scale,h:+r[2]/scale,l:+r[3]/scale,c:+r[4]/scale,v:+r[5]||0});}
    const oldest=Math.min(...list.map(r=>+r[0]));if(oldest>end)throw Error('Pagination stuck');end=oldest-1;
    await wait(35);
  }
  const result=[...rows.values()].sort((a,b)=>a.t-b.t);
  if(result.length!==(DATA_END-DATA_START)/STEP)throw Error(symbol+' incomplete '+path+': '+result.length);
  result.forEach((b,i)=>{if(b.t!==DATA_START+i*STEP||![b.o,b.h,b.l,b.c].every(x=>Number.isFinite(x)&&x>0)||b.l>Math.min(b.o,b.c)||b.h<Math.max(b.o,b.c)||b.l>b.h)throw Error(symbol+' invalid bar '+b.t);});
  return result;
}
async function funding(symbol){
  const rows=new Map();let end=DATA_END-1;
  while(end>=DATA_START){
    const list=await api('funding/history',{category:'linear',symbol:CONTRACTS[symbol],startTime:String(DATA_START),endTime:String(end),limit:'200'});
    if(!list.length)break;
    for(const r of list){const t=+r.fundingRateTimestamp,rate=+r.fundingRate;if(r.symbol!==CONTRACTS[symbol]||!Number.isFinite(rate)||Math.abs(rate)>.1||t%STEP)throw Error('Invalid funding '+symbol);if(t>=DATA_START&&t<DATA_END)rows.set(t,{t,rate});}
    const oldest=Math.min(...list.map(r=>+r.fundingRateTimestamp));if(oldest>end)throw Error('Funding pagination stuck');end=oldest-1;
    await wait(35);
  }
  const result=[...rows.values()].sort((a,b)=>a.t-b.t);
  if(!result.length||result[0].t-DATA_START>8*3600000||DATA_END-result.at(-1).t>8*3600000)throw Error('Funding coverage '+symbol);
  result.forEach((r,i)=>{if(i&&r.t-result[i-1].t>8*3600000)throw Error('Funding gap '+symbol+' '+r.t);});
  return result;
}
export async function loadActiveData({download=false}={}){
  await mkdir(DATA_DIR,{recursive:true});const data={},manifest={source:'Bybit V5 public linear perpetual',start:DATA_START,end:DATA_END,step:STEP,assembledAt:new Date().toISOString(),files:{}};
  for(const symbol of Object.keys(CONTRACTS)){
    const url=new URL(symbol+'.json',DATA_DIR);let raw;
    try{raw=await readFile(url,'utf8');}catch(e){if(!download)throw e;}
    if(!raw){
      const [price,mark,rates]=await Promise.all([bars(symbol,'kline'),bars(symbol,'mark-price-kline'),funding(symbol)]);
      raw=JSON.stringify({symbol,contract:CONTRACTS[symbol],scale:CONTRACT_UNITS[symbol],start:DATA_START,end:DATA_END,price,mark,funding:rates});
      await writeFile(url,raw);process.stdout.write(symbol+' '+price.length+' bars, '+rates.length+' funding events\n');
    }
    data[symbol]=JSON.parse(raw);
    if(data[symbol].start!==DATA_START||data[symbol].end!==DATA_END)throw Error('Cached range mismatch '+symbol);
    manifest.files[symbol]={path:fileURLToPath(url),sha256:sha(raw),bars:data[symbol].price.length,funding:data[symbol].funding.length};
  }
  await writeFile(new URL('manifest.json',DATA_DIR),JSON.stringify(manifest,null,2)+'\n');
  return {data,manifest};
}
export async function downloadCurrentContracts(){
  await mkdir(DATA_DIR,{recursive:true});const contracts={};
  for(const symbol of Object.keys(CONTRACTS)){
    contracts[symbol]=await fetchContract(async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('HTTP '+r.status);return r.json();},symbol);
    process.stdout.write(symbol+' public current max '+contracts[symbol].max+'x\n');
  }
  const result={fetchedAt:new Date().toISOString(),note:'Current public tiers, NOT historical tiers',contracts};
  await writeFile(new URL('current-contracts.json',DATA_DIR),JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--contracts'))await downloadCurrentContracts();else await loadActiveData({download:process.argv.includes('--download')});
}
