// Descriptive check of the live floor rule at Bybit's maximum leverage: the
// live engine itself (floor-trend.js) replayed on Bybit's own hourly perpetual
// candles and funding, one fresh desk per coin at every month start, with
// every horizon off at the start like a reset. Today's tier-1 limits are used
// for all history. Each hour's low and high stand in for the mark price inside
// that hour, so a wick through the liquidation level counts. Not a strategy
// selection: nothing here changes the live rules.
import {fileURLToPath} from 'node:url';
import {loadFloorData} from './floor-trend-data.mjs';
import {TREND,WINDOW,newTrendDesk,advanceTrendDesk} from '../floor-trend.js';
import {CONTRACTS} from '../bybit-contracts.js';

const HOUR=3600000,DAY=24*HOUR,STEP=TREND.step,LIMIT_DAYS=30;
// Bybit's public tier-1 limits on 2026-10-02 (instruments-info and risk-limit).
const LIMITS=Object.freeze({BTC:[150,.0033,300000],ETH:[150,.0033,300000],SOL:[100,.005,50000],XRP:[100,.005,50000],DOGE:[75,.0075,250000],SHIB:[50,.01,200000]});
const contract=(symbol,at)=>{const [max,maintenance,cap]=LIMITS[symbol];return {symbol,contract:CONTRACTS[symbol],at,min:1,max,step:.01,tiers:[{id:1,cap,max,maintenance,deduction:0}]};};
// Twelve five-minute mark bars per hour, each spanning that hour's range.
const markBars=(bars,index,from,to)=>{const out=[];for(let t=from;t<=to;t+=STEP){const b=bars[index.get(Math.floor(t/HOUR)*HOUR)];out.push({t,o:b.o,h:b.h,l:b.l,c:b.c});}return out;};

export function runDesk(symbol,{bars,funding},start){
  const index=new Map(bars.map((b,i)=>[b.t,i])),end=Math.min(start+LIMIT_DAYS*DAY,bars.at(-1).t);
  let desk=newTrendDesk(),opened=null,trades=0;
  for(let hour=start;hour<=end;hour+=HOUR){
    const i=index.get(hour),now=hour+30000,price=bars[i].o,p=desk.position;
    const market={hour,bars:bars.slice(Math.max(0,i-WINDOW-48),i),price,mark:price,at:now,contract:contract(symbol,now)};
    if(p){
      const from=Math.min(p.nextBar,Math.floor(p.fundingThrough/STEP)*STEP);
      Object.assign(market,{historyFrom:from,fundingThrough:now,funding:funding.filter(f=>f.t>p.fundingThrough&&f.t<=now),markBars:markBars(bars,index,from,Math.floor(now/STEP)*STEP)});
    }
    desk=advanceTrendDesk(desk,symbol,market,now);
    if(desk.position&&opened===null)opened=desk.position.openedAt;
    trades=desk.trades.length;
    if(desk.cash<=0&&!desk.position)break;
  }
  const last=desk.trades.at(-1),liquidated=last?.reason==='likvidation';
  return {symbol,start,opened,trades,liquidated,hoursToLiquidation:liquidated?(last.at-opened)/HOUR:null,
    firstTrade:desk.trades[0]?{reason:desk.trades[0].reason,pnl:desk.trades[0].pnl,hours:(desk.trades[0].at-desk.trades[0].opened)/HOUR}:null,
    balance:desk.position?null:desk.cash,held:!!desk.position};
}

export async function run(){
  const {data}=await loadFloorData('bybit'),rows=[];
  for(const [symbol,raw] of Object.entries(data)){
    // A start needs the longest channel of history behind it.
    const first=raw.bars[0].t+(WINDOW+48)*HOUR;
    for(let y=2020;y<=2026;y++)for(let m=0;m<12;m++){
      const start=Date.UTC(y,m,1);
      if(start<first||start+DAY>raw.bars.at(-1).t)continue;
      rows.push(runDesk(symbol,raw,start));
    }
  }
  const entered=rows.filter(r=>r.opened!==null),liq=entered.filter(r=>r.liquidated),hours=liq.map(r=>r.hoursToLiquidation).sort((a,b)=>a-b);
  const share=x=>(x*100).toFixed(0)+' %',median=v=>v.length?v[Math.floor(v.length/2)]:null;
  const firstTrades=entered.map(r=>r.firstTrade).filter(Boolean);
  console.log('Desks: '+rows.length+' ('+Object.keys(data).join(', ')+'), '+LIMIT_DAYS+' days each from a month start.');
  console.log('Bought within '+LIMIT_DAYS+' days: '+entered.length);
  console.log('Liquidated: '+liq.length+' ('+share(liq.length/entered.length)+' of those that bought)');
  console.log('First trade liquidated: '+firstTrades.filter(t=>t.reason==='likvidation').length+' of '+firstTrades.length);
  console.log('Hours from first buy to liquidation: median '+median(hours)?.toFixed(1)+', within 1 h '+share(hours.filter(h=>h<=1).length/entered.length)+', within 24 h '+share(hours.filter(h=>h<=24).length/entered.length)+', within 7 days '+share(hours.filter(h=>h<=168).length/entered.length));
  const alive=entered.filter(r=>!r.liquidated);
  console.log('Not liquidated after '+LIMIT_DAYS+' days: '+alive.length+(alive.length?' · '+alive.map(r=>r.symbol+' '+new Date(r.start).toISOString().slice(0,7)+(r.held?' (holding)':' $'+r.balance.toFixed(2))).join(', '):''));
  for(const symbol of Object.keys(data)){
    const own=entered.filter(r=>r.symbol===symbol),h=own.filter(r=>r.liquidated).map(r=>r.hoursToLiquidation).sort((a,b)=>a-b);
    console.log(symbol.padEnd(5)+' starts '+String(own.length).padStart(3)+' · liquidated '+share(h.length/Math.max(1,own.length)).padStart(5)+' · median hours '+(median(h)?.toFixed(1)??'–'));
  }
  return rows;
}
if(process.argv[1]===fileURLToPath(import.meta.url))await run();
