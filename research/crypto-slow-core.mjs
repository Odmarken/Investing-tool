export const DAY=86400000,FEE=.001;
export const VARIANTS=['momentum28','momentum84','rotation28'];

export function momentum(bars,index,lookback){
  if(index<lookback+1)return null;
  // Index is the day whose OPEN can be traded; never read its close.
  return bars[index-1].c/bars[index-1-lookback].c-1;
}
export function choice(variant,data,index){
  const symbols=Object.keys(data),lookback=variant==='momentum84'?84:28;
  const scored=symbols.map(s=>({symbol:s,score:momentum(data[s],index,lookback)}));
  if(variant==='rotation28')return [scored.filter(s=>s.score!==null&&s.score>0).sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol))[0]?.symbol??null];
  return scored.map(s=>s.score!==null&&s.score>0?s.symbol:null);
}
export function simulate(variant,data,from,to,slip=.0005,fee=FEE){
  const symbols=Object.keys(data),first=data[symbols[0]].findIndex(b=>b.t===from),last=data[symbols[0]].findIndex(b=>b.t===to-DAY);
  if(first<85||last<first)throw Error('Missing warmup or period');
  const rotation=variant==='rotation28',count=rotation?1:symbols.length;
  const sleeves=Array.from({length:count},()=>({cash:100/count,position:null}));
  const trades=[],daily=[];let turnover=0,totalFees=0;
  const close=(s,raw,time,reason)=>{
    const p=s.position,fill=raw*(1-slip),exitFee=p.units*fill*fee,proceeds=p.units*fill-exitFee;
    s.cash+=proceeds;totalFees+=exitFee;turnover+=p.units*fill;
    trades.push({symbol:p.symbol,opened:p.at,closed:time,entry:p.entry,exit:fill,pnl:proceeds-p.budget,
      fees:p.entryFee+exitFee,days:(time-p.at)/DAY,reason});s.position=null;
  };
  const open=(s,symbol,raw,time)=>{
    const budget=s.cash,fill=raw*(1+slip),units=budget/(fill*(1+fee)),entryFee=units*fill*fee;
    s.position={symbol,at:time,entry:fill,units,budget,entryFee};s.cash=0;totalFees+=entryFee;turnover+=units*fill;
  };
  for(let i=first;i<=last;i++){
    const time=data[symbols[0]][i].t;
    const rebalance=new Date(time).getUTCDay()===1;
    if(variant==='buyhold'&&i===first)symbols.forEach((symbol,j)=>open(sleeves[j],symbol,data[symbol][i].o,time));
    else if(rebalance&&variant!=='buyhold'){
      const wanted=choice(variant,data,i);
      sleeves.forEach((s,j)=>{
        const symbol=wanted[j];if((s.position?.symbol??null)===symbol)return;
        if(s.position)close(s,data[s.position.symbol][i].o,time,'signal');
        if(symbol)open(s,symbol,data[symbol][i].o,time);
      });
    }
    let held=0,equity=0;
    for(const s of sleeves){const value=s.position?s.position.units*data[s.position.symbol][i].c:0;held+=value;equity+=s.cash+value;}
    daily.push({t:time+DAY,equity,exposure:held/equity});
  }
  for(const s of sleeves)if(s.position)close(s,data[s.position.symbol][last].c,to,'period-end');
  const balance=sleeves.reduce((s,p)=>s+p.cash,0);daily.at(-1).equity=balance;
  let peak=100,maxDD=0,previous=100;const returns=[];
  for(const d of daily){peak=Math.max(peak,d.equity);maxDD=Math.max(maxDD,1-d.equity/peak);returns.push(d.equity/previous-1);previous=d.equity;}
  const mean=returns.reduce((s,x)=>s+x,0)/returns.length,sd=Math.sqrt(returns.reduce((s,x)=>s+(x-mean)**2,0)/Math.max(1,returns.length-1));
  return {variant,from,to,slip,fee,balance,returnPct:balance-100,maxDDPct:100*maxDD,n:trades.length,
    winRate:trades.length?trades.filter(t=>t.pnl>0).length/trades.length:null,sharpe:sd?mean/sd*Math.sqrt(365):null,
    exposurePct:100*daily.reduce((s,d)=>s+d.exposure,0)/daily.length,turnoverTimes:turnover/100,fees:totalFees,
    meanHoldingDays:trades.length?trades.reduce((s,t)=>s+t.days,0)/trades.length:null,
    byCoin:symbols.map(s=>({symbol:s,n:trades.filter(t=>t.symbol===s).length,pnl:trades.filter(t=>t.symbol===s).reduce((x,t)=>x+t.pnl,0)})),
    trades,daily};
}
