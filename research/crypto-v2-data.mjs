import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const STEP=900000,HOUR=3600000,DAY=24*HOUR;
export const START=Date.parse('2025-01-01Z'),SPLIT=Date.parse('2025-07-01Z'),END=Date.parse('2026-01-01Z'),FROM=START-30*DAY;
export const SYMBOLS=['BTC','ETH','SOL'];
export const ROOT=new URL('../.matning/crypto-v2/',import.meta.url);
export const hash=value=>createHash('sha256').update(value).digest('hex');
mkdirSync(ROOT,{recursive:true});
async function api(path,query){
  for(let attempt=0;attempt<4;attempt++)try{
    const r=await fetch('https://api.bybit.com/v5/market/'+path+'?'+new URLSearchParams(query),{signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw Error('HTTP '+r.status);
    const j=await r.json();if(j.retCode!==0)throw Error(j.retMsg);return j.result.list;
  }catch(e){if(attempt===3)throw e;await new Promise(r=>setTimeout(r,500*(attempt+1)));}
}
export function validate(d){
  if(d.category!=='linear'||d.bars.length!==(END-FROM)/STEP)throw Error('Incomplete or wrong market data');
  d.bars.forEach((b,i)=>{if(b.t!==FROM+i*STEP||![b.o,b.h,b.l,b.c,b.v].every(Number.isFinite)||Math.min(b.o,b.h,b.l,b.c)<=0||b.v<0||b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c))throw Error('Invalid candle '+i);});
  if(!d.funding.length)throw Error('Missing funding');
  d.funding.forEach((f,i)=>{if(!Number.isFinite(f.rate)||f.t%STEP!==0||f.t<START||f.t>=END||i&&f.t<=d.funding[i-1].t)throw Error('Invalid funding');});
  // Contracts normally fund every eight hours; fail on a gap rather than assume zero.
  if(d.funding[0].t-START>8*HOUR||END-d.funding.at(-1).t>8*HOUR||d.funding.some((f,i)=>i&&f.t-d.funding[i-1].t>8*HOUR))throw Error('Funding coverage gap');
  if(d.checksum!==hash(JSON.stringify({bars:d.bars,funding:d.funding})))throw Error('Checksum mismatch');
  return d;
}
export const readData=s=>validate(JSON.parse(readFileSync(new URL(s+'.json',ROOT),'utf8')));
async function download(s){
  const file=new URL(s+'.json',ROOT);if(existsSync(file)){readData(s);console.log(s+' cache validated');return;}
  const map=new Map();let end=END-1;
  while(end>=FROM){
    const rows=await api('kline',{category:'linear',symbol:s+'USDT',interval:'15',limit:'1000',end:String(end)});
    if(!rows.length)throw Error('Missing candles '+s);
    for(const r of rows){const b={t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]};if(b.t>=FROM&&b.t<END)map.set(b.t,b);}
    const next=Math.min(...rows.map(r=>+r[0]))-1;if(next>=end)throw Error('Pagination');end=next;
  }
  const funds=new Map();end=END-1;
  while(end>=START){
    const rows=await api('funding/history',{category:'linear',symbol:s+'USDT',limit:'200',endTime:String(end)});
    if(!rows.length)break;
    for(const r of rows)if(+r.fundingRateTimestamp>=START&&+r.fundingRateTimestamp<END)funds.set(+r.fundingRateTimestamp,{t:+r.fundingRateTimestamp,rate:+r.fundingRate});
    const next=Math.min(...rows.map(r=>+r.fundingRateTimestamp))-1;if(next>=end)throw Error('Funding pagination');end=next;
  }
  const bars=[...map.values()].sort((a,b)=>a.t-b.t),funding=[...funds.values()].sort((a,b)=>a.t-b.t);
  const d={symbol:s,category:'linear',source:'https://api.bybit.com',fetchedAt:new Date().toISOString(),bars,funding,checksum:hash(JSON.stringify({bars,funding}))};
  validate(d);writeFileSync(file,JSON.stringify(d));console.log(s+': '+bars.length+' candles, '+funding.length+' funding observations');
}
if(process.argv.includes('--download')){const results=await Promise.allSettled(SYMBOLS.map(download));for(const r of results)if(r.status==='rejected')throw r.reason;}
