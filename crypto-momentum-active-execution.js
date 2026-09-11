import {LEVERAGE,openLeveraged,liquidationPrice,leveragedValue} from './crypto-leverage.js';
import {CONTRACTS,LIMIT_TTL} from './bybit-contracts.js';
const positive=n=>Number.isFinite(n)&&n>0;
export const ACTIVE_RISK=Object.freeze({riskFraction:.5,marginFraction:.5,liquidationBuffer:.25});

// High permitted leverage with a conservative buffer below the technical stop.
// Quantities remain continuous in this demo; this is not an exchange order.
export function openActivePosition(equity,market,signal,now,settings=ACTIVE_RISK){
  const {riskFraction,marginFraction,liquidationBuffer}=settings,c=market.contract;
  if(!positive(equity)||![riskFraction,marginFraction].every(n=>positive(n)&&n<=.5)||!Number.isFinite(liquidationBuffer)||liquidationBuffer<.25)throw Error('Ogiltig riskbudget');
  if(!c||c.symbol!==signal.symbol||c.contract!==CONTRACTS[signal.symbol]||!Number.isFinite(c.at)||now-c.at>LIMIT_TTL||c.at>now+5000)throw Error('Färska Bybit-gränser saknas');
  if(!positive(c.min)||!positive(c.max)||!positive(c.step)||!Array.isArray(c.tiers)||!c.tiers.length)throw Error('Ogiltiga kontraktsgränser');
  const rules={...LEVERAGE,...settings},raw=market.price,entry=raw*(1+rules.slip),sl=raw-signal.slDistance,tp=raw+signal.rewardMultiple*signal.slDistance;
  const stopFill=sl*(1-rules.slip),riskPerUnit=entry-stopFill+rules.fee*(entry+stopFill),targetFill=tp*(1-rules.slip);
  if(![raw,market.mark,signal.reference,signal.slDistance,signal.maxHoldMs,sl,riskPerUnit].every(positive)||!(tp>entry)||Math.abs(raw-signal.reference)>signal.slDistance*.5||market.mark<=sl||market.mark>=tp)return null;
  const netRR=(targetFill-entry-rules.fee*(entry+targetFill))/riskPerUnit;
  if(netRR<1.5)return null;
  const boundary=sl-liquidationBuffer*(entry-sl),choices=[];
  for(const tier of c.tiers){
    if(![tier.cap,tier.max,tier.maintenance].every(positive)||tier.maintenance>=1||!Number.isFinite(tier.deduction)||tier.deduction<0)throw Error('Ogiltig risknivå');
    // Ignoring the deduction here is conservative; verify the actual tier below.
    const safeMax=1/(1-boundary/entry*(1-tier.maintenance-rules.fee));
    const leverage=Number((Math.floor((Math.min(c.max,tier.max,safeMax)+1e-10)/c.step)*c.step).toFixed(8));
    if(leverage<c.min)continue;
    const units=Math.min(equity*riskFraction/riskPerUnit,equity*marginFraction/(entry*(1/leverage+rules.fee)),tier.cap/Math.max(entry,market.mark),
      settings.maxExposure?equity*settings.maxExposure/entry:Infinity);
    if(!positive(units))continue;
    const actual=c.tiers.find(t=>units*Math.max(entry,market.mark)<=t.cap*(1+1e-12));
    if(!actual||leverage>actual.max+1e-8)continue;
    const budget=units*entry*(1/leverage+rules.fee);
    const plan={...rules,leverage,maintenance:actual.maintenance,deduction:actual.deduction,riskId:actual.id,riskCap:actual.cap,apiMax:c.max,contract:c.contract,limitsAt:c.at};
    const p={...openLeveraged(budget,raw,now,plan),strategy:'hourly-momentum-v1',signalAt:signal.at,
      sl,tp,deadline:Math.floor(now/rules.step)*rules.step+signal.maxHoldMs,initialRisk:units*riskPerUnit,netRR,accountAtEntry:equity};
    if(liquidationPrice(p)<=boundary+1e-10*entry&&market.mark>liquidationPrice(p)&&p.budget<=equity*marginFraction+1e-8)choices.push(p);
  }
  return choices.sort((a,b)=>b.rules.leverage-a.rules.leverage||b.units-a.units)[0]??null;
}

// Mark-price SL/TP, funding and liquidation share one chronological pass.
export function inspectActivePosition(position,market,now){
  const p={...position},step=p.rules.step,bars=market.markBars,funds=market.funding;
  if(!Array.isArray(bars)||!Array.isArray(funds)||!Number.isFinite(market.historyFrom)||market.historyFrom>Math.min(p.nextBar,Math.floor(p.fundingThrough/step)*step)||
    !Number.isFinite(market.fundingThrough)||market.fundingThrough<now-120000||market.fundingThrough<p.fundingThrough||!positive(market.mark)||!positive(market.price))throw Error('Markpris- eller fundinghistorik saknas');
  const current=Math.floor(now/step)*step,required=bars.filter(b=>b.t>=p.nextBar&&b.t<=current);
  if(p.nextBar<=current&&(required.length!==(current-p.nextBar)/step+1||required.some((b,i)=>b.t!==p.nextBar+i*step)))throw Error('Lucka i markprishistoriken');
  if(bars.some(b=>!Number.isFinite(b.t)||b.t%step||![b.o,b.h,b.l,b.c].every(positive)||b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c)))throw Error('Ogiltiga markpriser');
  if(funds.some((f,i)=>!Number.isFinite(f.t)||!Number.isFinite(f.rate)||i&&f.t<=funds[i-1].t))throw Error('Ogiltig fundinghistorik');
  const outstanding=funds.filter(f=>f.t>p.fundingThrough&&f.t<=now);let paid=0,fi=0;
  const charge=until=>{while(fi<outstanding.length&&outstanding[fi].t<=until){const f=outstanding[fi++],b=bars.find(b=>b.t===f.t);if(!b)throw Error('Fundingmarkpris saknas');const cost=p.units*b.o*f.rate;p.funding+=cost;paid+=cost;}};
  const exit=(price,at,reason)=>({position:p,funding:paid,exit:{price,at,reason}});
  const bufferBroken=()=>liquidationPrice(p)>=p.sl;
  for(const b of required){
    charge(b.t);
    const liq=liquidationPrice(p),end=Math.min(now,b.t+step);
    if(b.o<=liq)return exit(b.o,b.t,'likvidation');
    if(b.o<=p.sl)return exit(b.o,b.t,'SL');
    if(b.o>=p.tp)return exit(p.tp,b.t,'TP');
    if(bufferBroken())return exit(b.o,b.t,'risk');
    if(b.t>=p.deadline)return exit(b.o,b.t,'timeout');
    // Both levels in one candle: choose the adverse SL. The technical stop
    // precedes a lower liquidation level unless the candle already gapped past it.
    if(b.l<=p.sl)return exit(p.sl,end,'SL');
    if(b.h>=p.tp)return exit(p.tp,end,'TP');
    if(b.t+step<=now)p.nextBar=b.t+step;
  }
  charge(now);p.fundingThrough=market.fundingThrough;
  if(market.mark<=liquidationPrice(p))return exit(Math.min(market.price,market.mark),now,'likvidation');
  if(market.mark<=p.sl)return exit(Math.min(market.price,p.sl),now,'SL');
  if(market.mark>=p.tp)return exit(Math.min(market.price,p.tp),now,'TP');
  if(bufferBroken())return exit(market.price,now,'risk');
  if(now>=p.deadline)return exit(market.price,now,'timeout');
  return {position:p,funding:paid,exit:null};
}

export const stopRiskNow=p=>Math.max(0,p.budget-leveragedValue(p,p.sl));
