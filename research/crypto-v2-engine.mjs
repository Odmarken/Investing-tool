export const HOUR=3600000,STEP=900000,FEE=.00055;
export const VARIANTS=['breakout','pullback','range','regime'];
const sum=a=>a.reduce((s,x)=>s+x,0);
const mean=a=>sum(a)/a.length;
const ema=(previous,value,n)=>previous===null?value:previous+2/(n+1)*(value-previous);
export function aggregate(bars,milliseconds){
  const out=[];let bucket=null,part=[];
  for(const b of bars){
    const key=Math.floor(b.t/milliseconds)*milliseconds;
    if(key!==bucket){bucket=key;part=[];}part.push(b);
    if(b.t+STEP===key+milliseconds&&part.length===milliseconds/STEP&&part[0].t===key){
      out.push({t:key,o:part[0].o,h:Math.max(...part.map(x=>x.h)),l:Math.min(...part.map(x=>x.l)),c:b.c,v:sum(part.map(x=>x.v))});
    }
  }return out;
}
export function features(bars){
  const hours=aggregate(bars,HOUR),four=aggregate(bars,4*HOUR),out=new Map();
  let a=null,e=null,e4a=null,e4b=null,j=0,trend=0;
  for(let i=0;i<hours.length;i++){
    const b=hours[i],prev=hours[i-1],time=b.t+HOUR;
    while(j<four.length&&four[j].t+4*HOUR<=time){const c=four[j].c;e4a=ema(e4a,c,20);e4b=ema(e4b,c,50);j++;trend=j<50?0:c>e4b&&e4a>e4b?1:c<e4b&&e4a<e4b?-1:0;}
    const tr=prev?Math.max(b.h-b.l,Math.abs(b.h-prev.c),Math.abs(b.l-prev.c)):b.h-b.l;
    a=a===null?tr:(a*13+tr)/14;e=ema(e,b.c,20);
    if(i<50)continue;
    const recent=hours.slice(i-23,i+1),old=hours.slice(i-24,i),closes=recent.map(x=>x.c),m=mean(closes),sd=Math.sqrt(mean(closes.map(c=>(c-m)**2)));
    const pm=mean(old.map(x=>x.c)),psd=Math.sqrt(mean(old.map(x=>(x.c-pm)**2)));
    let moves=0;for(let k=i-23;k<=i;k++)moves+=Math.abs(hours[k].c-hours[k-1].c);
    const f={time,b,prev,atr:a,ema:e,trend,eff:moves?Math.abs(b.c-hours[i-24].c)/moves:0,
      high:Math.max(...old.map(x=>x.h)),low:Math.min(...old.map(x=>x.l)),volume:mean(old.map(x=>x.v)),
      mean:m,lower:m-2*sd,upper:m+2*sd,prevLower:pm-2*psd,prevUpper:pm+2*psd,
      sixLow:Math.min(...hours.slice(i-5,i+1).map(x=>x.l)),sixHigh:Math.max(...hours.slice(i-5,i+1).map(x=>x.h))};
    out.set(time,f);
  }return out;
}
export function signal(variant,symbol,f){
  if(!f)return null;
  const {b,prev,atr,trend}=f;
  let kind=variant,dir=0,stop,target,hours;
  if(kind==='regime')kind=f.eff>=.35?'breakout':f.eff<.2?'range':'none';
  if(kind==='breakout'){
    dir=trend>0&&b.c>f.high?1:trend<0&&b.c<f.low?-1:0;
    if(b.v<f.volume*1.2)dir=0;
    stop=b.c-dir*2*atr;target=b.c+dir*8*atr;hours=72;
  }else if(kind==='pullback'){
    dir=trend>0&&b.l<=f.ema&&b.c>f.ema&&b.c>prev.c?1:trend<0&&b.h>=f.ema&&b.c<f.ema&&b.c<prev.c?-1:0;
    stop=dir>0?f.sixLow-.1*atr:f.sixHigh+.1*atr;
    const risk=dir*(b.c-stop);if(risk<1.5*atr||risk>4*atr)dir=0;
    target=b.c+dir*3*risk;hours=48;
  }else if(kind==='range'&&f.eff<.2){
    dir=prev.c<f.prevLower&&b.c>f.lower?1:prev.c>f.prevUpper&&b.c<f.upper?-1:0;
    stop=b.c-dir*1.5*atr;target=f.mean;hours=24;
  }
  return dir?{symbol,kind,dir,stop,target,time:f.time,deadline:f.time+hours*HOUR}:null;
}
export function geometry(s,open,slip){
  const entry=open*(1+s.dir*slip),risk=s.dir*(entry-s.stop),reward=s.dir*(s.target-entry);
  const stopFill=s.stop*(1-s.dir*slip),targetFill=s.target*(1-s.dir*slip);
  const costRisk=s.dir*(entry-stopFill)+FEE*(entry+stopFill),netReward=s.dir*(targetFill-entry)-FEE*(entry+targetFill);
  return {entry,risk,reward,costRisk,ratio:netReward/costRisk,
    valid:risk>0&&reward>0&&risk/entry>=.005&&risk/entry<=.06&&risk/entry>=5*2*(FEE+slip)&&netReward/costRisk>=1.5};
}
export class Book{
  constructor(variant,slip){Object.assign(this,{variant,slip,balance:100,peak:100,maxDD:0,p:null,trades:[],equity:[],cooldown:new Map(),halted:false});}
  enter(signals,bars,time){
    if(this.p||this.halted)return;
    const candidates=signals.filter(s=>s&&s.time===time&&(this.cooldown.get(s.symbol)||0)<=time)
      .map(s=>({s,g:geometry(s,bars[s.symbol].o,this.slip)})).filter(x=>x.g.valid)
      .sort((a,b)=>b.g.ratio-a.g.ratio||['BTC','ETH','SOL'].indexOf(a.s.symbol)-['BTC','ETH','SOL'].indexOf(b.s.symbol));
    if(!candidates.length)return;
    const {s,g}=candidates[0],units=Math.min(this.balance*.005/g.costRisk,this.balance*2/g.entry);
    this.p={...s,entry:g.entry,initialStop:s.stop,units,initialRisk:units*g.costRisk,pnl:-units*g.entry*FEE,fees:units*g.entry*FEE,funding:0};
  }
  close(raw,time,reason){
    const p=this.p,fill=raw*(1-p.dir*this.slip);
    p.pnl+=p.units*(p.dir*(fill-p.entry)-FEE*fill);p.fees+=p.units*fill*FEE;
    this.balance+=p.pnl;
    this.trades.push({symbol:p.symbol,kind:p.kind,dir:p.dir,opened:p.time,closed:time,entry:p.entry,exit:fill,units:p.units,initialRisk:p.initialRisk,sl:p.initialStop,
      pnl:p.pnl,R:p.pnl/p.initialRisk,fees:p.fees,funding:p.funding,reason,capital:this.balance});
    this.cooldown.set(p.symbol,time+6*HOUR);this.p=null;if(this.balance<=0)this.halted=true;
  }
  step(signals,bars,time,rates={}){
    const held=this.p;
    if(held){const funding=held.dir*held.units*bars[held.symbol].o*(rates[held.symbol]||0);held.pnl-=funding;held.funding+=funding;}
    this.enter(signals,bars,time);
    const p=this.p;
    if(p){const b=bars[p.symbol],gap=p.dir*(b.o-p.stop)<=0,stop=p.dir>0?b.l<=p.stop:b.h>=p.stop;
      if(gap)this.close(b.o,time,'gap-stop');
      else if(time>=p.deadline)this.close(b.o,time,'timeout');
      else if(stop)this.close(p.stop,time+STEP,'stop');
      else if(p.dir>0?b.h>=p.target:b.l<=p.target)this.close(p.target,time+STEP,'target');
    }
    this.mark(bars,time+STEP);
  }
  trail(featureMap){
    const p=this.p,f=p&&featureMap[p.symbol];if(!p||!f||p.kind!=='breakout')return;
    const next=f.b.c-p.dir*3*f.atr;
    p.stop=p.dir>0?Math.max(p.stop,next):Math.min(p.stop,next);
  }
  mark(bars,time){
    const p=this.p,px=p?bars[p.symbol].c*(1-p.dir*this.slip):0;
    const equity=this.balance+(p?p.pnl+p.units*(p.dir*(px-p.entry)-FEE*px):0);
    this.peak=Math.max(this.peak,equity);this.maxDD=Math.max(this.maxDD,1-equity/this.peak);
    this.equity.push({t:time,value:equity});
  }
  summary(){
    const t=this.trades,gain=sum(t.filter(x=>x.pnl>0).map(x=>x.pnl)),loss=-sum(t.filter(x=>x.pnl<0).map(x=>x.pnl));
    return {variant:this.variant,slip:this.slip,n:t.length,returnPct:this.balance-100,maxDD:this.maxDD*100,meanR:t.length?mean(t.map(x=>x.R)):0,
      PF:loss?gain/loss:null,winRate:t.length?t.filter(x=>x.pnl>0).length/t.length:0,fees:sum(t.map(x=>x.fees)),funding:sum(t.map(x=>x.funding)),
      gross:sum(t.map(x=>x.pnl+x.fees+x.funding)),withoutBest5:sum([...t].sort((a,b)=>b.pnl-a.pnl).slice(5).map(x=>x.pnl)),halted:this.halted};
  }
}
