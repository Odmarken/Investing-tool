// Shared test data for the trend desks: hourly candles with a quiet year and
// a closing rally, market snapshots, and a Bybit-shaped fake for page and cloud tests.
import {FLOOR} from '../trading-floor.js';
import {TREND} from '../floor-trend.js';
import {CONTRACTS,CONTRACT_UNITS} from '../bybit-contracts.js';
export const TIME=Date.parse('2026-09-22T12:00:00Z'),HOUR=3600000,STEP=TREND.step;
export const SCALE=Object.freeze({BTC:60000,ETH:3000,SOL:150,XRP:.6,DOGE:.2,SHIB:.00002,PEPE:.00001});
const DAYS=380;
// Unit-price candles ending the hour before `end`: noisy and flat, then a
// 20-day climb that breaks every horizon's channel (or, without the rally, a
// slow slide that leaves every horizon flat). Opens equal the previous close.
export function unitBars(end=TIME,{rally=true,days=DAYS}={}){
  const hour=Math.floor(end/HOUR)*HOUR,n=days*24,out=[];let x=17,c=1;
  const rnd=()=>(x=(x*48271)%2147483647)/2147483647;
  for(let i=0;i<n;i++){
    const o=c,late=i>=n-20*24;
    c=late?o*(rally?1.0012:.9992):(1+.04*Math.sin(i/37))*(1+(rnd()-.5)*.01)*.97;
    // Wide enough ranges that the momentum account's SL/TP geometry clears its R:R filter.
    out.push({t:hour-(n-i)*HOUR,o,h:Math.max(o,c)*1.004,l:Math.min(o,c)*.996,c});
  }
  return out;
}
export const coinBars=(symbol,bars)=>bars.map(b=>({t:b.t,o:b.o*SCALE[symbol],h:b.h*SCALE[symbol],l:b.l*SCALE[symbol],c:b.c*SCALE[symbol]}));
// What fetchTrendMarket returns, for every desk, from unit candles.
export function trendSnapshot(time=TIME,unit=unitBars(time)){
  const hour=Math.floor(time/HOUR)*HOUR;
  return {hour,market:Object.fromEntries(FLOOR.desks.map(symbol=>{
    const bars=coinBars(symbol,unit.filter(b=>b.t<hour)),price=bars.at(-1).c;
    return [symbol,{bars,price,mark:price,at:time}];
  }))};
}
// Flat mark-price history since the desk's last check, as fetchDerivatives returns it.
export function riskFor(desk,time,price){
  const p=desk.position,from=Math.min(p.nextBar,Math.floor(p.fundingThrough/STEP)*STEP),markBars=[];
  for(let t=from;t<=Math.floor(time/STEP)*STEP;t+=STEP)markBars.push({t,o:price,h:price,l:price,c:price});
  return {price,mark:price,at:time,historyFrom:from,fundingThrough:time,funding:[],markBars};
}
// Adds held desks' risk history to a snapshot, like the real market fetch.
export function withRisk(firm,snapshot,time){
  const market={...snapshot.market};
  for(const symbol of FLOOR.desks){const d=firm.desks[symbol];if(d.position)market[symbol]={...market[symbol],...riskFor(d,time,market[symbol].price)};}
  return {...snapshot,market};
}
export const riskSnapshot=(firm,time,prices={})=>({market:Object.fromEntries(FLOOR.desks.filter(s=>firm.desks[s].position).map(s=>[s,riskFor(firm.desks[s],time,prices[s]??firm.desks[s].position.entry)]))});

/**
 * Bybit V5 market endpoints for page and cloud tests. runtime: {at, urls}.
 * Hourly candles come from runtime.unit (unit prices × SCALE), paged by start/end
 * like the floor fetch, or the latest `limit` like the momentum account's fetch.
 */
export const fakeBybit=runtime=>async url=>{
  const u=new URL(url),contract=u.searchParams.get('symbol'),time=runtime.at;runtime.urls.push(u);
  const symbol=Object.keys(CONTRACTS).find(s=>CONTRACTS[s]===contract),unit=CONTRACT_UNITS[symbol]??1;
  const hour=Math.floor(time/HOUR)*HOUR,bars=coinBars(symbol,runtime.unit??unitBars(time));
  const last=(bars.filter(b=>b.t<hour).at(-1)?.c??SCALE[symbol])*unit,px=String(runtime.price?.[symbol]!==undefined?runtime.price[symbol]*unit:last);
  if(u.pathname.endsWith('/tickers'))return {retCode:0,time,result:{category:'linear',list:[{symbol:contract,lastPrice:px,markPrice:px,nextFundingTime:String((Math.floor(time/28800000)+1)*28800000)}]}};
  if(u.pathname.endsWith('/instruments-info'))return {retCode:0,time,result:{category:'linear',list:[{symbol:contract,fundingInterval:'480',status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',leverageFilter:{minLeverage:'1',maxLeverage:'150',leverageStep:'.01'}}]}};
  if(u.pathname.endsWith('/risk-limit'))return {retCode:0,time,result:{category:'linear',list:[{id:1,symbol:contract,riskLimitValue:'10000000',maxLeverage:'150',maintenanceMargin:'.005',mmDeduction:''}]}};
  if(u.pathname.endsWith('/funding/history'))return {retCode:0,time,result:{category:'linear',list:Array.from({length:10},(_,i)=>({symbol:contract,fundingRate:'0',fundingRateTimestamp:String(Math.floor(time/28800000)*28800000-i*28800000)}))}};
  if(u.pathname.endsWith('/mark-price-kline'))return {retCode:0,time,result:{category:'linear',symbol:contract,list:Array.from({length:1000},(_,i)=>[Math.floor(time/300000)*300000-i*300000,px,px,px,px].map(String))}};
  if(u.searchParams.get('interval')==='60'){
    const limit=+u.searchParams.get('limit'),start=u.searchParams.get('start'),end=u.searchParams.get('end');
    // Include the forming hour like Bybit does; the floor never asks for it.
    const all=[...bars.filter(b=>b.t<hour),{t:hour,o:+px/unit,h:+px/unit,l:+px/unit,c:+px/unit}];
    const rows=start!==null?all.filter(b=>b.t>=+start&&b.t<=+end).slice(-limit):all.slice(-limit);
    return {retCode:0,time,result:{category:'linear',symbol:contract,list:rows.reverse().map(b=>[b.t,b.o*unit,b.h*unit,b.l*unit,b.c*unit,1].map(String))}};
  }
  throw Error('Unexpected request '+url);
};
export const urlKinds=urls=>[...new Set(urls.map(u=>u.pathname.replace('/v5/market/','')+(u.searchParams.get('interval')==='60'?':hourly':'')))].sort();
