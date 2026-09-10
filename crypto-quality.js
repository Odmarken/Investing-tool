// Experimental entry checks for crypto. Passing is not a probability or a
// calibrated forecast. Pure functions shared by the dashboard and tests.
export const CRYPTO_RULES = Object.freeze({
  fee:0.00055, slippage:0.0005, minNetRR:1.5, maxCostShare:0.25,
  maxAgeMs:30*60e3, maxChaseATR:0.75, minRelativeVolume:1,
  leverage:20, maintenance:0.005
});
const STEP=300000,HOUR=3600000;
const valid=n=>typeof n==='number'&&Number.isFinite(n);

export function cryptoContext(bars=[],now=Date.now()){
  const closed=bars.filter(b=>valid(b.t)&&b.t+STEP<=now).slice(-2000);
  const tail=closed.slice(-600);
  const validData=tail.length===600&&tail.every((b,i)=>
    [b.o,b.h,b.l,b.c,b.v].every(valid)&&Math.min(b.o,b.h,b.l,b.c)>0&&b.v>=0&&
    b.h>=Math.max(b.o,b.c,b.l)&&b.l<=Math.min(b.o,b.c)&&b.t%STEP===0&&(!i||b.t-tail[i-1].t===STEP));
  let e20=null,e50=null,hours=0,lastHour=null,bucket=null,parts=[];
  for(const b of closed){
    const h=Math.floor(b.t/HOUR)*HOUR;
    if(h!==bucket){bucket=h;parts=[];}parts.push(b);
    if(parts.length===12&&parts.every((x,i)=>x.t===h+i*STEP)&&b.t+STEP===h+HOUR){
      if(lastHour!==null&&h!==lastHour+HOUR){e20=null;e50=null;hours=0;}
      e20=e20===null?b.c:e20+2/21*(b.c-e20);
      e50=e50===null?b.c:e50+2/51*(b.c-e50);
      lastHour=h;hours++;
    }
  }
  const last=closed.at(-1),prev=closed.at(-2);
  const hourClose=closed.findLast(b=>b.t+STEP===lastHour+HOUR)?.c;
  const trend=hours>=50?(hourClose>e50&&e20>e50?1:hourClose<e50&&e20<e50?-1:0):0;
  const volumes=closed.slice(-21,-1),avgVolume=volumes.reduce((s,b)=>s+b.v,0)/volumes.length;
  let a=null;
  for(let i=0;i<tail.length;i++){
    const b=tail[i],p=tail[i-1],tr=p?Math.max(b.h-b.l,Math.abs(b.h-p.c),Math.abs(b.l-p.c)):b.h-b.l;
    a=a===null?tr:(13*a+tr)/14;
  }
  const newest=bars.at(-1);
  return {valid:validData&&hours>=50,trend,last,prev,atr:a,
    relativeVolume:avgVolume>0?last.v/avgVolume:null,
    fresh:!!newest&&newest.t<=now&&now-newest.t<=2*STEP&&!!last&&now-(last.t+STEP)<=STEP};
}

export function reviewCrypto(signal,ctx,now=Date.now(),rules=CRYPTO_RULES,snapshot){
  const market=snapshot||cryptoContext(ctx?.bars,now),dir=signal.side==='long'?1:signal.side==='short'?-1:0;
  const active=signal.status==='ACTIVE';
  const raw=active?ctx?.px:signal.entry;
  const entry=raw*(1+dir*rules.slippage),stop=signal.sl,target=signal.tp;
  const geometry=dir!==0&&[entry,stop,target].every(x=>valid(x)&&x>0)&&dir*(entry-stop)>0&&dir*(target-entry)>0;
  const stopFill=stop*(1-dir*rules.slippage),targetFill=target*(1-dir*rules.slippage);
  const risk=dir*(entry-stopFill)+rules.fee*(entry+stopFill);
  const reward=dir*(targetFill-entry)-rules.fee*(entry+targetFill);
  const netRR=geometry&&risk>0?reward/risk:null;
  const costShare=geometry?2*(rules.fee+rules.slippage)*raw/(dir*(raw-stop)):null;
  const last=market.last,prev=market.prev;
  const trigger=!!last&&!!prev&&dir*(last.c-last.o)>0&&dir*(last.c-prev.c)>0&&
    (last.h>last.l)&&(dir>0?(last.c-last.l)/(last.h-last.l):(last.h-last.c)/(last.h-last.l))>=2/3;
  const reference=valid(signal.entryFyllt)?signal.entryFyllt:signal.entry;
  const chase=active&&market.atr>0?dir*(raw-reference)/market.atr:0;
  const age=valid(signal.oppnad)?now-signal.oppnad:null;
  const liquidation=entry*(1+dir*(-1/rules.leverage+rules.maintenance));
  const checks=[
    {key:'data',label:'Färsk, sammanhängande prisdata',ok:!!ctx&&!ctx.simulated&&market.valid&&market.fresh&&valid(raw)&&raw>0},
    {key:'geometry',label:'Stopp före likvidation och mål framför entry',ok:geometry&&dir*(stop-liquidation)>0},
    {key:'net',label:'Minst 1,5:1 efter avgifter och antagen slippage',ok:netRR!==null&&netRR>=rules.minNetRR},
    {key:'cost',label:'Kostnader högst 25 % av avståndet till stopp',ok:valid(costShare)&&costShare>0&&costShare<=rules.maxCostShare},
    {key:'trend',label:'Avslutad 1h-trend stödjer riktningen',ok:market.valid&&market.trend===dir&&dir!==0},
    {key:'volume',label:'Senaste avslutade 5m har minst normal volym',ok:valid(market.relativeVolume)&&market.relativeVolume>=rules.minRelativeVolume},
    {key:'trigger',label:'Avslutad 5m bekräftar riktningen',ok:trigger},
    {key:'chase',label:'Priset högst 0,75 ATR förbi signalens entry',ok:!active||valid(chase)&&chase<=rules.maxChaseATR},
    {key:'age',label:'Aktiv signal högst 30 minuter gammal',ok:!active||age!==null&&age>=0&&age<=rules.maxAgeMs}
  ];
  const failed=checks.filter(x=>!x.ok);
  return {pass:!failed.length,checks,failed,netRR,costShare,trend:market.trend,relativeVolume:market.relativeVolume,
    basis:active?'marknadspris nu':'planerad entry',reason:failed.map(x=>x.label).join(' · ')};
}
