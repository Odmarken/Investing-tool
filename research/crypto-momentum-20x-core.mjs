import {MOMENTUM,momentumScore} from '../crypto-momentum.js';
import {LEVERAGE,openLeveraged,closeLeveraged,liquidationPrice,leveragedValue} from '../crypto-leverage.js';
export function simulateLeveraged(data,{from,to,leverage=20,slip=.0005,step=900000}){
  const rules={...LEVERAGE,leverage,slip,step},symbols=MOMENTUM.symbols;
  const sleeves=symbols.map(symbol=>({symbol,cash:100/3,position:null})),trades=[],curve=[];
  const indices=Object.fromEntries(symbols.map(s=>[s,new Map(data[s].bars.map((b,i)=>[b.t,i]))]));
  const marks=Object.fromEntries(symbols.map(s=>[s,new Map(data[s].marks.map(b=>[b.t,b]))]));
  const funds=Object.fromEntries(symbols.map(s=>[s,new Map(data[s].funding.map(f=>[f.t,f.rate]))]));
  let fees=0,funding=0,peak=100,maxDD=0;
  const close=(s,price,t,reason)=>{
    const r=closeLeveraged(s.position,price,t,reason,rules);
    s.cash+=r.cash;fees+=r.exitFee;trades.push({symbol:s.symbol,...r.trade});s.position=null;
  };
  for(let time=from;time<to;time+=step){
    const decide=time%MOMENTUM.day===0&&new Date(time).getUTCDay()===1;
    const current={};
    for(const s of sleeves){
      const i=indices[s.symbol].get(time),bar=data[s.symbol].bars[i],mark=marks[s.symbol].get(time);
      if(!bar||!mark)throw Error('Missing price history at '+time);
      current[s.symbol]=bar;
      if(s.position){
        const cost=s.position.at<time?s.position.units*mark.o*(funds[s.symbol].get(time)??0):0;
        s.position.funding+=cost;funding+=cost;
        if(mark.o<=liquidationPrice(s.position,rules))close(s,mark.o,time,'likvidation');
      }
      if(decide){
        const wanted=momentumScore(data[s.symbol].daily,time)>0;
        if(s.position&&!wanted)close(s,bar.o,time,'signal');
        else if(!s.position&&wanted&&s.cash>0){
          s.position=openLeveraged(s.cash,bar.o,time,rules);s.cash=0;fees+=s.position.fee;
        }
      }
      if(s.position&&mark.l<=liquidationPrice(s.position,rules))
        close(s,Math.min(mark.o,liquidationPrice(s.position,rules)),time+step,'likvidation');
    }
    const equity=sleeves.reduce((sum,s)=>sum+s.cash+(s.position?leveragedValue(s.position,current[s.symbol].c,rules):0),0);
    peak=Math.max(peak,equity);maxDD=Math.max(maxDD,1-equity/peak);
    curve.push({t:time+step,equity});
  }
  for(const s of sleeves)if(s.position){const b=data[s.symbol].bars[indices[s.symbol].get(to-step)];close(s,b.c,to,'periodslut');}
  const balance=sleeves.reduce((sum,s)=>sum+s.cash,0);
  return {from,to,leverage,slip,balance,returnPct:balance-100,maxDDPct:maxDD*100,fees,funding,
    liquidations:trades.filter(t=>t.reason==='likvidation').length,n:trades.length,
    depletedAt:curve.find(c=>c.equity<1e-10)?.t??null,
    byCoin:sleeves.map(s=>({symbol:s.symbol,balance:s.cash,pnl:s.cash-100/3,liquidations:trades.filter(t=>t.symbol===s.symbol&&t.reason==='likvidation').length})),trades,curve};
}
