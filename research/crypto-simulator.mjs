export const FEE = 0.00055;
export const VARIANTS = ['current','net','net-hour','atr-net-hour','pullback-fixed','pullback-runner'];
export const NAMES = ['Nuvarande','Nettofilter','Netto + 1h','ATR + netto + 1h','Kryptorekyl fast','Kryptorekyl runner'];
const STEP=300000, DAY=86400000;
const sideOf=s => s.side==='long'?1:-1;
export function hourlyTrends(bars) {
  let e20=null,e50=null,trend=0,count=0,parts=0,bucket=null;
  return bars.map(b => {
    const h=Math.floor(b.t/3600000);
    if(h!==bucket){bucket=h;parts=0;}
    parts++;
    if(b.t%3600000===3300000 && parts===12) {
      e20=e20===null?b.c:e20+(b.c-e20)*2/21;
      e50=e50===null?b.c:e50+(b.c-e50)*2/51;
      count++;
      trend=count<50?0:b.c>e50 && e20>e50?1:b.c<e50 && e20<e50?-1:0;
    }
    return trend;
  });
}
export function netRatio(entry, stop, target, dir, slip, fee=FEE) {
  const take=target*(1-dir*slip), loss=stop*(1-dir*slip);
  const reward=dir*(take-entry)-fee*(entry+take);
  const risk=dir*(entry-loss)+fee*(entry+loss);
  return reward>0 && risk>0 ? reward/risk : -Infinity;
}
export function pullback(ctx, trend) {
  if(!trend) return null;
  const b=ctx.bars.at(-1), prev=ctx.bars.at(-2), e=ctx.e21;
  if(trend>0 ? !(b.l<=e && b.c>e && b.c>prev.c) : !(b.h>=e && b.c<e && b.c<prev.c)) return null;
  const recent=ctx.bars.slice(-6), a=ctx.atr;
  const stop=trend>0?Math.min(...recent.map(x=>x.l))-.1*a:Math.max(...recent.map(x=>x.h))+.1*a;
  const risk=trend*(b.c-stop);
  if(risk<a || risk>3*a) return null;
  return { id:ctx.inst.key+'|pullback@'+b.t,inst:ctx.inst.key,side:trend>0?'long':'short',
    sl:stop,tp:b.c+trend*3*risk,atr:a,fam:'pullback',grade:null,conf:0,oppnad:b.t+STEP,trend };
}

export class Portfolio {
  constructor(variant, slip, size, period) {
    Object.assign(this,{variant,slip,size,period,balance:100,peak:100,maxDD:0,position:null,
      trades:[],seen:new Set(),cooldown:new Map(),daily:[],lastDay:null,lastEquity:100,halted:false});
  }
  finish(bar, reason) {
    const p=this.position;
    if(!p) return;
    this.exit(p,bar.c,1,bar.t+STEP,reason);
  }
  exit(p, raw, fraction, time, reason) {
    const amount=Math.min(fraction,p.left);
    const fill=raw*(1-p.dir*this.slip);
    p.pnl+=amount*p.units*(p.dir*(fill-p.entry)-FEE*fill);
    p.fees+=amount*p.units*FEE*fill;
    p.left-=amount;
    p.exits.push({time,price:fill,fraction:amount,reason});
    if(p.left>1e-9) return;
    this.close(p,time,reason);
  }
  close(p,time,reason) {
    // Isolated margin: loss cannot consume more than posted margin.
    p.pnl=Math.max(p.pnl,-p.margin);
    this.balance=Math.max(0,this.balance+p.pnl);
    this.trades.push({symbol:p.inst,fam:p.fam,side:p.dir>0?'long':'short',entry:p.entry,sl:p.initialStop,
      tp:p.target,opened:p.time,closed:time,reason,pnl:p.pnl,R:p.pnl/p.initialRisk,
      fees:p.fees,funding:p.funding,capital:this.balance,exits:p.exits});
    this.cooldown.set(p.inst,time+6*STEP);
    this.position=null;
    if(this.balance<1) this.halted=true;
  }
  tryEntry(signals,bars,time) {
    if(this.position || this.halted) return;
    const custom=this.variant.startsWith('pullback');
    for(const s of signals) {
      if(this.seen.has(s.id) || custom && (this.cooldown.get(s.inst)||0)>time) continue;
      const b=bars[s.inst],dir=sideOf(s),entry=b.o*(1+dir*this.slip);
      if(!(dir*(entry-s.sl)>0 && dir*(s.tp-entry)>0)) continue;
      if((s.tp-entry)*dir/((entry-s.sl)*dir)<1) continue;
      if(this.variant!=='current' && netRatio(entry,s.sl,s.tp,dir,this.slip)<2) continue;
      if(this.variant.includes('hour') && s.trend!==dir) continue;
      const risk=Math.abs(entry-s.sl);
      const units=this.size==='all20'?this.balance*20/entry:Math.min(this.balance*.01/risk,this.balance*20/entry);
      const notional=units*entry,margin=this.size==='all20'?this.balance:notional/20;
      const p={inst:s.inst,fam:s.fam,entry,stop:s.sl,initialStop:s.sl,target:s.tp,dir,units,margin,
        time,left:1,pnl:-notional*FEE,fees:notional*FEE,funding:0,initialRisk:units*risk,exits:[],
        partial:false,partialTarget:entry+dir*2*risk,best:entry,
        liq:entry*(1+dir*(-1/20+.005))};
      this.position=p;
      this.seen.add(s.id);
      return;
    }
  }
  step(signals,bars,time,funding,atrs) {
    const day=Math.floor(time/DAY);
    if(this.lastDay!==null && day!==this.lastDay) this.daily.push({t:this.lastDay*DAY,equity:this.lastEquity});
    this.lastDay=day;
    const held=this.position;
    if(held && funding[held.inst]) {
      const cash=held.dir*held.units*held.left*bars[held.inst].o*funding[held.inst];
      held.pnl-=cash;held.funding+=cash;
    }
    this.tryEntry(signals,bars,time);
    const p=this.position;
    if(p) {
      const b=bars[p.inst],dir=p.dir;
      const stopHit=dir>0?b.l<=p.stop:b.h>=p.stop;
      const liqHit=dir>0?b.l<=p.liq:b.h>=p.liq;
      // Follow the app's conservative ambiguity rule: liquidation before stop.
      if(liqHit) { p.pnl=-p.margin;p.left=0;this.close(p,time,'liquidation'); }
      else if(stopHit) this.exit(p,dir>0?Math.min(p.stop,b.o):Math.max(p.stop,b.o),p.left,time,'stop');
      else if(this.variant==='pullback-runner') {
        if(!p.partial && (dir>0?b.h>=p.partialTarget:b.l<=p.partialTarget)) {
          this.exit(p,p.partialTarget,.5,time,'partial');p.partial=true;
        }
        if(p.partial) {
          p.best=dir>0?Math.max(p.best,b.h):Math.min(p.best,b.l);
          const next=p.best-dir*2*atrs[p.inst];
          p.stop=dir>0?Math.max(p.stop,next):Math.min(p.stop,next);
        }
      } else if(dir>0?b.h>=p.target:b.l<=p.target) this.exit(p,p.target,1,time,'target');
    }
    let equity=this.balance;
    if(this.position) {
      const q=this.position,px=bars[q.inst].c;
      const unreal=q.pnl+q.left*q.units*(q.dir*(px-q.entry)-FEE*px);
      equity+=Math.max(unreal,-q.margin);
    }
    this.peak=Math.max(this.peak,equity);
    this.maxDD=Math.max(this.maxDD,this.peak>0?1-equity/this.peak:0);
    this.lastEquity=equity;
  }
  summary() {
    const wins=this.trades.filter(t=>t.pnl>0),gain=wins.reduce((s,t)=>s+t.pnl,0),loss=-this.trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0);
    const returns=this.trades.map(t=>t.R);
    return {variant:this.variant,slip:this.slip,size:this.size,period:this.period,n:this.trades.length,
      winRate:wins.length/this.trades.length||0,meanR:returns.reduce((s,r)=>s+r,0)/returns.length||0,
      profitFactor:loss?gain/loss:null,returnPct:this.balance-100,maxDrawdownPct:this.maxDD*100,
      capital:this.balance,liquidations:this.trades.filter(t=>t.reason==='liquidation').length,halted:this.halted};
  }
}
