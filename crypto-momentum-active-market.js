import {CONTRACTS,CONTRACT_UNITS} from './bybit-contracts.js';
import {fetchDerivatives} from './crypto-momentum-market.js';
import {activeSignal} from './crypto-momentum-active-signal.js';
export const ACTIVE_HOUR=3600000;

export async function fetchActiveSnapshot(grab,now=()=>Date.now(),account){
  const hour=Math.floor(now()/ACTIVE_HOUR)*ACTIVE_HOUR;
  const entries=await Promise.all(Object.keys(CONTRACTS).map(async symbol=>{
    const [j,market]=await Promise.all([
      grab('https://api.bybit.com/v5/market/kline?'+new URLSearchParams({category:'linear',symbol:CONTRACTS[symbol],interval:'60',limit:'100'}),{json:true,timeout:8000}),
      fetchDerivatives(grab,symbol,account?.sleeves.find(s=>s.symbol===symbol)?.position,now)
    ]);
    if(j?.retCode!==0||j.result?.category!=='linear'||j.result?.symbol!==CONTRACTS[symbol]||!Array.isArray(j.result.list)||!Number.isFinite(j.time)||now()-j.time>120000||j.time>now()+5000)throw Error('Färska timpriser saknas för '+symbol);
    const scale=CONTRACT_UNITS[symbol],bars=j.result.list.map(r=>({t:+r[0],o:+r[1]/scale,h:+r[2]/scale,l:+r[3]/scale,c:+r[4]/scale,v:+r[5]})).sort((a,b)=>a.t-b.t);
    if(bars.length<81||bars.at(-1).t!==hour||bars.some((b,i)=>!Number.isFinite(b.t)||b.t%ACTIVE_HOUR||![b.o,b.h,b.l,b.c].every(n=>Number.isFinite(n)&&n>0)||!Number.isFinite(b.v)||b.v<0||b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c)||i&&b.t!==bars[i-1].t+ACTIVE_HOUR))throw Error('Sammanhängande timpriser saknas för '+symbol);
    const signal=activeSignal(symbol,bars,now(),account?.profile??'pulse12');
    return [symbol,{...market,signal}];
  }));
  if(hour!==Math.floor(now()/ACTIVE_HOUR)*ACTIVE_HOUR)throw Error('Ny timme: prisdata hämtas igen');
  return {hour,market:Object.fromEntries(entries)};
}

// Independent of the other six coins and their entry-signal history.
export async function fetchActiveRisk(grab,now=()=>Date.now(),account){
  const entries=await Promise.all(account.sleeves.filter(s=>s.position).map(async s=>[s.symbol,await fetchDerivatives(grab,s.symbol,s.position,now,{limits:false})]));
  return {market:Object.fromEntries(entries)};
}
