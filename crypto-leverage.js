// Shared, deliberately conservative isolated-margin demo accounting.
export const LEVERAGE = Object.freeze({ leverage:20, fee:.00055, slip:.0005, maintenance:.005, step:300000 });
export function openLeveraged(budget, price, at, rules=LEVERAGE) {
  const entry=price*(1+rules.slip), units=budget/(entry*(1/rules.leverage+rules.fee)), fee=units*entry*rules.fee;
  return { budget, entry, units, fee, at, funding:0, fundingThrough:at, nextBar:(Math.floor(at/rules.step)+1)*rules.step };
}
export function liquidationPrice(p,rules=LEVERAGE) {
  return Math.max(0,(p.units*p.entry-p.budget+p.fee+p.funding)/(p.units*(1-rules.maintenance-rules.fee)));
}
export function leveragedValue(p,price,rules=LEVERAGE) {
  const exit=price*(1-rules.slip);
  return Math.max(0,p.budget+(exit-p.entry)*p.units-p.fee-p.units*exit*rules.fee-p.funding);
}
export function closeLeveraged(p,price,at,reason='signal',rules=LEVERAGE) {
  const exit=price*(1-rules.slip), exitFee=p.units*exit*rules.fee;
  const cash=reason==='likvidation'?0:leveragedValue(p,price,rules);
  return { cash, exitFee, trade:{ opened:p.at, at, entry:p.entry, exit, pnl:cash-p.budget, fees:p.fee+exitFee, funding:p.funding, reason } };
}
export function inspectLeveraged(p, market, now, rules=LEVERAGE) {
  const bars=market.markBars, funding=market.funding, step=rules.step;
  if(!Array.isArray(bars)||!Array.isArray(funding)||!Number.isFinite(market.historyFrom)||market.historyFrom>Math.min(p.nextBar,Math.floor(p.fundingThrough/step)*step)||
    !Number.isFinite(market.fundingThrough)||market.fundingThrough<now-120000) throw Error('Markpris- eller fundinghistorik saknas');
  const current=Math.floor(now/step)*step;
  const required=bars.filter(b=>b.t>=p.nextBar&&b.t<=current);
  if(p.nextBar<=current&&(required.length!==(current-p.nextBar)/step+1||required.some((b,i)=>b.t!==p.nextBar+i*step)))
    throw Error('Lucka i markprishistoriken');
  const outstanding=funding.filter(f=>f.t>p.fundingThrough&&f.t<=now);
  const next={...p}; let paid=0,fi=0;
  const charge=until=>{
    while(fi<outstanding.length&&outstanding[fi].t<=until){
      const f=outstanding[fi++],bar=bars.find(b=>b.t===f.t);
      if(!bar)throw Error('Markpris vid funding saknas');
      const cost=p.units*bar.o*f.rate;paid+=cost;next.funding+=cost;
    }
  };
  for(const b of required){
    charge(b.t);
    const liq=liquidationPrice(next,rules);
    if(b.l<=liq) return {position:next,funding:paid,liquidated:{price:Math.min(b.o,liq),at:Math.min(now,b.t+step)}};
    if(b.t+step<=now)next.nextBar=b.t+step;
  }
  charge(now);
  next.fundingThrough=now;
  if(market.mark<=liquidationPrice(next,rules))return {position:next,funding:paid,liquidated:{price:market.mark,at:now}};
  return {position:next,funding:paid,liquidated:null};
}
