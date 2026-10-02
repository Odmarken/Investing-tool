// Market data for the trend desks. Completed hourly Bybit candles are cached
// in memory, so a warm page or cloud instance fetches only the newest page
// each hour; a cold start refills the full window from Bybit.
import {CONTRACTS,CONTRACT_UNITS} from './bybit-contracts.js';
import {fetchDerivatives} from './crypto-momentum-market.js';
import {WINDOW} from './floor-trend.js';
const HOUR=3600000,PAGE=1000;
// The longest channel behind the decision hour, with room for a late run.
const KEEP=WINDOW+48;
const cache=new Map();
export function clearTrendCache(){cache.clear();}

async function page(grab,symbol,start,end,now){
  const contract=CONTRACTS[symbol],scale=CONTRACT_UNITS[symbol];
  const j=await grab('https://api.bybit.com/v5/market/kline?'+new URLSearchParams({category:'linear',symbol:contract,interval:'60',start:String(start),end:String(end),limit:String(PAGE)}),{json:true,timeout:8000});
  if(j?.retCode!==0||j.result?.category!=='linear'||j.result?.symbol!==contract||!Array.isArray(j.result.list)||!Number.isFinite(j.time)||now()-j.time>120000||j.time>now()+5000)
    throw Error('Färska timpriser saknas för '+symbol);
  return j.result.list.map(r=>{
    const b={t:+r[0],o:+r[1]/scale,h:+r[2]/scale,l:+r[3]/scale,c:+r[4]/scale};
    if(!Number.isFinite(b.t)||b.t%HOUR||![b.o,b.h,b.l,b.c].every(x=>Number.isFinite(x)&&x>0)||b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c))throw Error('Ogiltig timstapel för '+symbol);
    return b;
  });
}
/**
 * Completed candles from `from` through the hour before `hour`, continuous.
 * The latest completed hour must come from Bybit itself; an older missing hour
 * is filled flat at the previous close, as in the research data.
 */
export async function fetchHourly(grab,symbol,from,hour,now){
  from=Math.floor(from/HOUR)*HOUR;
  if(!(from<hour)||hour%HOUR)throw Error('Ogiltigt timintervall');
  const known=new Map((cache.get(symbol)??[]).map(b=>[b.t,b]));
  const missing=[];for(let t=from;t<hour;t+=HOUR)if(!known.has(t))missing.push(t);
  // Fetch contiguous missing ranges in pages of at most 1000 candles.
  for(let i=0;i<missing.length;){
    let j=i;while(j+1<missing.length&&missing[j+1]===missing[j]+HOUR&&j-i<PAGE-1)j++;
    for(const b of await page(grab,symbol,missing[i],missing[j]+HOUR-1,now))if(b.t>=from&&b.t<hour)known.set(b.t,b);
    i=j+1;
  }
  if(!known.has(hour-HOUR))throw Error('Senaste timstapeln för '+symbol+' finns inte ännu');
  // Before the listing there is nothing to fetch: start at the first real candle.
  let first=from;while(!known.has(first))first+=HOUR;
  const bars=[];
  for(let t=first;t<hour;t+=HOUR){
    let b=known.get(t);
    if(!b){const c=bars.at(-1).c;b={t,o:c,h:c,l:c,c,filled:true};}
    bars.push(b);
  }
  // Keep the newest KEEP hours of real candles for the next call.
  const keepFrom=hour-KEEP*HOUR;
  cache.set(symbol,[...known.values()].filter(b=>b.t>=keepFrom&&b.t<hour).sort((a,b)=>a.t-b.t));
  return bars;
}
// Hours each desk needs: the longest channel behind its first unprocessed hour.
// A new desk starts from zero at the decision hour, so the same window loads the cache.
export function historyStart(desk,hour){
  return Math.min(desk.signal.through??hour,hour)-WINDOW*HOUR;
}
// desks: {symbol: desk}. Candles, quote, Bybit's limits for a flat desk that may
// buy, and mark-price and funding history for a held position.
export async function fetchTrendMarket(grab,now,desks){
  const hour=Math.floor(now()/HOUR)*HOUR;
  const entries=await Promise.all(Object.entries(desks).map(async([symbol,desk])=>{
    const [bars,market]=await Promise.all([fetchHourly(grab,symbol,historyStart(desk,hour),hour,now),fetchDerivatives(grab,symbol,desk.position,now,{limits:!desk.position})]);
    return [symbol,{...market,bars}];
  }));
  if(hour!==Math.floor(now()/HOUR)*HOUR)throw Error('Ny timme: prisdata hämtas igen');
  return {hour,market:Object.fromEntries(entries)};
}
// Between hourly decisions: funding and liquidation checks for held desks only.
export async function fetchTrendRisk(grab,now,desks){
  const entries=await Promise.all(Object.entries(desks).filter(([,d])=>d.position).map(async([symbol,desk])=>[symbol,await fetchDerivatives(grab,symbol,desk.position,now,{limits:false})]));
  return {market:Object.fromEntries(entries)};
}
