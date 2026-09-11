import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const DAY = 86400000, STEP = 300000;
export const START = Date.parse('2026-03-14T00:00:00Z');
export const SPLIT = Date.parse('2026-07-12T00:00:00Z');
export const END = Date.parse('2026-09-10T00:00:00Z');
export const WARMUP = 8*DAY;
export const SYMBOLS = ['BTC','ETH','SOL','XRP','DOGE','SHIB','PEPE'];
export const ROOT = new URL('../.matning/crypto/', import.meta.url);
mkdirSync(ROOT, { recursive:true });
async function api(path, query) {
  const url = 'https://api.bybit.com/v5/market/' + path + '?' + new URLSearchParams(query);
  for(let attempt=0; attempt<4; attempt++) {
    try {
      const response = await fetch(url, { signal:AbortSignal.timeout(20000) });
      if(!response.ok) throw Error('HTTP ' + response.status);
      const data = await response.json();
      if(data.retCode !== 0) throw Error(data.retMsg);
      return data.result;
    } catch(error) {
      if(attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 500*(attempt+1)));
    }
  }
}
export function validateBars(bars, from=START-WARMUP, to=END) {
  if(bars.length !== (to-from)/STEP) throw Error(`Incomplete history: ${bars.length}, expected ${(to-from)/STEP}`);
  for(let i=0; i<bars.length; i++) {
    const b=bars[i];
    if(b.t !== from+i*STEP || ![b.o,b.h,b.l,b.c,b.v].every(Number.isFinite)
      || Math.min(b.o,b.h,b.l,b.c)<=0 || b.v<0 || b.h<Math.max(b.o,b.c,b.l) || b.l>Math.min(b.o,b.c)) {
      throw Error('Invalid candle ' + JSON.stringify(b));
    }
  }
}
export function readData(symbol) {
  const data=JSON.parse(readFileSync(new URL(symbol+'.json', ROOT),'utf8'));
  validateBars(data.bars);
  return data;
}
async function download(symbol) {
  const file=new URL(symbol+'.json', ROOT);
  const previous=existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : null;
  if(previous?.from === START-WARMUP) { const d=readData(symbol); console.log(symbol+' cached '+d.bars.length); return; }
  const map=new Map((previous?.bars || []).map(b=>[b.t,b]));
  let end=previous ? previous.bars[0].t-1 : END-1, pages=0;
  while(end >= START-WARMUP) {
    const result=await api('kline',{category:'spot',symbol:symbol+'USDT',interval:'5',limit:'1000',end:String(end)});
    if(!result.list?.length) throw Error('No candles for '+symbol);
    for(const r of result.list) { const b={t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]}; if(b.t>=START-WARMUP && b.t<END) map.set(b.t,b); }
    const oldest=Math.min(...result.list.map(r=>+r[0]));
    if(oldest>end) throw Error('Pagination did not advance');
    end=oldest-1;
    if(++pages%15===0) console.log(symbol+' candles '+map.size);
  }
  const bars=[...map.values()].sort((a,b)=>a.t-b.t);
  validateBars(bars);
  const fundingSymbol = ({SHIB:'SHIB1000USDT',PEPE:'1000PEPEUSDT'})[symbol] || symbol+'USDT';
  const funding=[]; end=END-1;
  while(end>=START) {
    const result=await api('funding/history',{category:'linear',symbol:fundingSymbol,limit:'200',endTime:String(end)});
    if(!result.list?.length) break;
    for(const r of result.list) if(+r.fundingRateTimestamp>=START) funding.push({t:+r.fundingRateTimestamp,rate:+r.fundingRate});
    const oldest=Math.min(...result.list.map(r=>+r.fundingRateTimestamp));
    if(oldest>end) throw Error('Funding pagination did not advance');
    end=oldest-1;
  }
  if(!funding.length) throw Error('Funding missing for '+fundingSymbol);
  funding.sort((a,b)=>a.t-b.t);
  const checksum=createHash('sha256').update(JSON.stringify(bars)).digest('hex');
  writeFileSync(file,JSON.stringify({symbol,category:'spot',source:'api.bybit.com',from:START-WARMUP,to:END,
    fetchedAt:new Date().toISOString(),checksum,bars,fundingSymbol,funding}));
  console.log(symbol+' complete: '+bars.length+' candles, '+funding.length+' funding records, sha256 '+checksum.slice(0,12));
}
if(process.argv.includes('--download')) {
  // Three independent public-data downloads at a time.
  for(let i=0;i<SYMBOLS.length;i+=3) {
    const results=await Promise.allSettled(SYMBOLS.slice(i,i+3).map(download));
    for(const r of results) if(r.status==='rejected') throw r.reason;
  }
}
