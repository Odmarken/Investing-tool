import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const DAY=86400000,FROM=Date.parse('2022-10-01T00:00:00Z'),END=Date.parse('2026-09-10T00:00:00Z');
export const SYMBOLS=['BTC','ETH','SOL'],ROOT=new URL('../.matning/crypto-slow/',import.meta.url);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
mkdirSync(ROOT,{recursive:true});
export function validate(d){
  if(d.category!=='spot'||d.bars.length!==(END-FROM)/DAY)throw Error('Wrong market or missing days');
  d.bars.forEach((b,i)=>{if(b.t!==FROM+i*DAY||![b.o,b.h,b.l,b.c,b.v].every(Number.isFinite)||Math.min(b.o,b.h,b.l,b.c)<=0||b.v<0||b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c))throw Error('Invalid daily bar '+i);});
  if(d.checksum!==hash(d.bars))throw Error('Checksum mismatch');return d;
}
export const readData=s=>validate(JSON.parse(readFileSync(new URL(s+'.json',ROOT),'utf8')));
async function download(s){
  const path=new URL(s+'.json',ROOT);if(existsSync(path)){readData(s);return;}
  let end=END-1;const bars=new Map();
  while(end>=FROM){
    const url='https://api.bybit.com/v5/market/kline?'+new URLSearchParams({category:'spot',symbol:s+'USDT',interval:'D',limit:'1000',end:String(end)});
    const res=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!res.ok)throw Error('HTTP '+res.status);
    const j=await res.json();if(j.retCode!==0||!j.result.list.length)throw Error(j.retMsg||'No candles');
    for(const r of j.result.list){const b={t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]};if(b.t>=FROM&&b.t<END)bars.set(b.t,b);}
    const next=Math.min(...j.result.list.map(r=>+r[0]))-1;if(next>=end)throw Error('Pagination');end=next;
  }
  const sorted=[...bars.values()].sort((a,b)=>a.t-b.t);
  const d={symbol:s,category:'spot',interval:'D',source:'https://api.bybit.com/v5/market/kline',fetchedAt:new Date().toISOString(),bars:sorted,checksum:hash(sorted)};
  validate(d);writeFileSync(path,JSON.stringify(d));console.log(s+' '+sorted.length+' daily bars');
}
if(process.argv.includes('--download')){const results=await Promise.allSettled(SYMBOLS.map(download));for(const r of results)if(r.status==='rejected')throw r.reason;}
