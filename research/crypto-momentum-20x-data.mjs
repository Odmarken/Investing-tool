import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const ROOT=new URL('../.matning/crypto-momentum20/',import.meta.url);
export const FROM=Date.parse('2025-01-01T00:00:00Z'),END=Date.parse('2026-01-01T00:00:00Z'),STEP=900000;
mkdirSync(ROOT,{recursive:true});
export const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function validate(d){
  if(d.category!=='linear'||d.kind!=='mark'||d.bars.length!==(END-FROM)/STEP||d.hash!==hash(d.bars))throw Error('Invalid mark cache');
  if(d.bars.some((b,i)=>b.t!==FROM+i*STEP||![b.o,b.h,b.l,b.c].every(x=>Number.isFinite(x)&&x>0)||b.h<Math.max(b.o,b.l,b.c)||b.l>Math.min(b.o,b.c)))throw Error('Invalid mark candle');
  return d;
}
export const readMarks=s=>validate(JSON.parse(readFileSync(new URL('mark-'+s+'.json',ROOT),'utf8')));
async function download(symbol){
  const file=new URL('mark-'+symbol+'.json',ROOT);if(existsSync(file)){readMarks(symbol);return;}
  let end=END-1,pages=0;const bars=new Map();
  while(end>=FROM){
    const url='https://api.bybit.com/v5/market/mark-price-kline?'+new URLSearchParams({category:'linear',symbol:symbol+'USDT',interval:'15',limit:'1000',end:String(end)});
    let j;
    for(let retry=0;retry<3;retry++)try{
      const r=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('HTTP '+r.status);
      j=await r.json();if(j.retCode!==0||j.result?.category!=='linear'||j.result?.symbol!==symbol+'USDT'||!j.result.list.length)throw Error('Invalid API result');break;
    }catch(e){if(retry===2)throw e;}
    for(const r of j.result.list){const b={t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4]};if(b.t>=FROM&&b.t<END)bars.set(b.t,b);}
    const next=Math.min(...j.result.list.map(r=>+r[0]))-1;if(next>=end)throw Error('Pagination');end=next;
    if(++pages%10===0)console.log(symbol+': '+bars.size+' mark candles');
  }
  const sorted=[...bars.values()].sort((a,b)=>a.t-b.t),d={category:'linear',kind:'mark',symbol,source:'https://api.bybit.com/v5/market/mark-price-kline',fetchedAt:new Date().toISOString(),bars:sorted,hash:hash(sorted)};
  validate(d);writeFileSync(file,JSON.stringify(d));console.log(symbol+' complete: '+sorted.length);
}
if(process.argv.includes('--download')){const results=await Promise.allSettled(['BTC','ETH','SOL'].map(download));for(const r of results)if(r.status==='rejected')throw r.reason;}
