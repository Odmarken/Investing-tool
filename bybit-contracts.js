// Public contract limits only. No account credentials or leverage-setting API.
export const CONTRACTS=Object.freeze({BTC:'BTCUSDT',ETH:'ETHUSDT',SOL:'SOLUSDT',XRP:'XRPUSDT',DOGE:'DOGEUSDT',SHIB:'SHIB1000USDT',PEPE:'1000PEPEUSDT'});
// Perpetual prices for these contracts quote 1000 underlying tokens.
export const CONTRACT_UNITS=Object.freeze({BTC:1,ETH:1,SOL:1,XRP:1,DOGE:1,SHIB:1000,PEPE:1000});
export const LIMIT_TTL=10*60000;
const positive=x=>Number.isFinite(x)&&x>0;
// A plain decimal as Bybit sends it ("0.001", "150.000", "10") and its number of decimals; anything else is null.
function decimal(x){
  const m=typeof x==='string'?/^(\d+)(?:\.(\d+))?$/.exec(x.trim()):null;
  return m?{value:Number(m[0]),decimals:m[2]?.length??0}:null;
}
/**
 * Bybit's order filters for market orders (instruments-info lotSizeFilter and priceFilter), or null when they are
 * missing or malformed. Quantities and the price tick are per token: SHIB1000USDT and 1000PEPEUSDT count 1000 tokens
 * per unit of quantity and quote the price of 1000 tokens. `bybit` keeps Bybit's own numbers (contract units) and
 * their decimals, which floorQty and roundPrice use to round exactly.
 */
export function orderFilters(symbol,instrument){
  const unit=CONTRACT_UNITS[symbol],lot=instrument?.lotSizeFilter,price=instrument?.priceFilter;
  if(!unit||!lot||typeof lot!=='object'||!price||typeof price!=='object')return null;
  const step=decimal(lot.qtyStep),min=decimal(lot.minOrderQty),mkt=decimal(lot.maxMktOrderQty),tick=decimal(price.tickSize);
  // Bybit lists a minimum order value for linear contracts; without one there is none.
  const notional=lot.minNotionalValue===undefined?{value:0}:decimal(lot.minNotionalValue);
  if(!step||!min||!mkt||!tick||!notional||![step.value,min.value,mkt.value,tick.value].every(positive)||mkt.value<min.value)return null;
  return Object.freeze({unit,qtyStep:step.value*unit,minQty:min.value*unit,maxMktQty:mkt.value*unit,minNotional:notional.value,tickSize:tick.value/unit,
    bybit:Object.freeze({qtyStep:step.value,minOrderQty:min.value,maxMktOrderQty:mkt.value,tickSize:tick.value,minNotionalValue:notional.value,
      qtyDecimals:step.decimals,tickDecimals:tick.decimals})});
}
// A quantity in tokens rounded down to Bybit's quantity step, counted in Bybit's units so the steps stay exact.
export function floorQty(filters,units){
  const b=filters.bybit,n=Math.floor(units/filters.unit/b.qtyStep+1e-9);
  return n>0?Number((n*b.qtyStep).toFixed(b.qtyDecimals))*filters.unit:0;
}
// A quantity in tokens rounded up to Bybit's quantity step.
export function ceilQty(filters,units){
  const b=filters.bybit,n=Math.max(0,Math.ceil(units/filters.unit/b.qtyStep-1e-9));
  return Number((n*b.qtyStep).toFixed(b.qtyDecimals))*filters.unit;
}
// A price per token rounded to Bybit's tick, in Bybit's price units.
export function roundPrice(filters,price){
  const b=filters.bybit,n=Math.round(price*filters.unit/b.tickSize);
  return Number((n*b.tickSize).toFixed(b.tickDecimals))/filters.unit;
}
export function parseContract(symbol,info,risk,at){
  const contract=CONTRACTS[symbol],i=info.find(x=>x.symbol===contract);
  if(!i||i.status!=='Trading'||i.contractType!=='LinearPerpetual'||i.quoteCoin!=='USDT'||i.settleCoin!=='USDT')throw Error('Aktivt USDT-perpetualkontrakt saknas för '+symbol);
  const max=+i.leverageFilter?.maxLeverage,min=+i.leverageFilter?.minLeverage,step=+i.leverageFilter?.leverageStep;
  if(![max,min,step].every(positive)||min>max)throw Error('Ogiltig hävstångsgräns');
  const tiers=risk.filter(r=>r.symbol===contract).map(r=>({id:+r.id,cap:+r.riskLimitValue,max:+r.maxLeverage,maintenance:+r.maintenanceMargin,deduction:r.mmDeduction===''?0:+r.mmDeduction})).sort((a,b)=>a.cap-b.cap);
  if(!tiers.length||tiers.some((t,j)=>![t.id,t.cap,t.max,t.maintenance].every(positive)||t.maintenance>=1||!Number.isFinite(t.deduction)||t.deduction<0||j&&t.cap<=tiers[j-1].cap))
    throw Error('Bybits risknivåer saknas eller är ogiltiga');
  // The order filters are an addition: a contract without them (or with malformed ones) is returned as before.
  const filters=orderFilters(symbol,i);
  return filters?{symbol,contract,max,min,step,tiers,at,filters}:{symbol,contract,max,min,step,tiers,at};
}
export async function fetchContract(grab,symbol,now=()=>Date.now()){
  const contract=CONTRACTS[symbol];if(!contract)throw Error('Okänt kontrakt');
  const get=async(path,extra={})=>{
    const j=await grab('https://api.bybit.com/v5/market/'+path+'?'+new URLSearchParams({category:'linear',symbol:contract,...extra}),{json:true,timeout:8000});
    if(j?.retCode!==0||j.result?.category!=='linear'||!Array.isArray(j.result.list)||!Number.isFinite(j.time)||j.time>now()+5000||now()-j.time>120000)
      throw Error('Färska kontraktsgränser saknas för '+symbol);
    return j;
  };
  const [info,first]=await Promise.all([get('instruments-info'),get('risk-limit')]);
  const rows=[...first.result.list];let cursor=first.result.nextPageCursor,seen=new Set();
  while(cursor){
    if(seen.has(cursor)||seen.size>=30)throw Error('Riskpaginering stannade');seen.add(cursor);
    const page=await get('risk-limit',{cursor});rows.push(...page.result.list);cursor=page.result.nextPageCursor;
  }
  return parseContract(symbol,info.result.list,rows,Math.min(info.time,first.time));
}
export function maxLeverageFor(contract,budget,{fee=0,price=1,mark=price}={},now=Date.now()){
  if(!contract||!Number.isFinite(contract.at)||now-contract.at>LIMIT_TTL||contract.at>now+5000)throw Error('Bybits hävstångsgräns saknas eller är för gammal');
  if(!positive(budget)||!positive(price)||!positive(mark)||!Number.isFinite(fee)||fee<0)throw Error('Ogiltig marginalbudget');
  // Each tier constrains both leverage and notional. A cap can require an
  // intermediate leverage (e.g. 120x), not just one of the tier ceilings.
  const ratio=Math.max(1,mark/price);
  const choices=[...new Set(contract.tiers.map(t=>{
    const cap=t.cap/ratio,capLeverage=budget>cap*fee?cap/(budget-cap*fee):Infinity;
    return Math.floor((Math.min(t.max,contract.max,capLeverage)+1e-10)/contract.step)*contract.step;
  }))].sort((a,b)=>b-a);
  for(const raw of choices){
    const leverage=Number(raw.toFixed(8));if(leverage<contract.min)continue;
    const notional=budget/(1/leverage+fee),markedNotional=notional*mark/price;
    const tier=contract.tiers.find(t=>Math.max(notional,markedNotional)<=t.cap);
    if(tier&&leverage<=tier.max+1e-8&&leverage<=contract.max+1e-8)
      return {leverage,maintenance:tier.maintenance,deduction:tier.deduction,riskId:tier.id,riskCap:tier.cap,apiMax:contract.max,contract:contract.contract,limitsAt:contract.at};
  }
  throw Error('Positionen ryms inte inom Bybits risk- och hävstångsgränser');
}
export function createContractCache(grab,now=()=>Date.now()){
  const values=new Map(),pending=new Map(),retries=new Map();
  return {
    get(symbol){const c=values.get(symbol);return c&&now()-c.at<=LIMIT_TTL?c:null;},
    async load(symbol){
      const current=this.get(symbol);if(current)return current;
      if(pending.has(symbol))return pending.get(symbol);
      if(now()<(retries.get(symbol)??0))return null;
      const task=fetchContract(grab,symbol,now).then(c=>{values.set(symbol,c);return c;}).catch(()=>{retries.set(symbol,now()+60000);return null;}).finally(()=>pending.delete(symbol));
      pending.set(symbol,task);return task;
    }
  };
}
export function isolatedLevel(side,entry,budget,units,fee,plan){
  const cost=units*entry*fee,deduction=plan.deduction??0;
  return side==='long'?
    Math.max(0,(units*entry-budget+cost-deduction)/(units*(1-plan.maintenance-fee))):
    (units*entry+budget-cost+deduction)/(units*(1+plan.maintenance+fee));
}
/**
 * Bybit's liquidation price for an isolated USDT perpetual position (Unified Trading Account), as its help centre gives
 * it: long (E·S − E·S/L − Extra/(1 − fee) − D) / (S − S·MMR), short (E·S + E·S/L + Extra/(1 + fee) + D) / (S + S·MMR),
 * with E the entry price, S the size, L the leverage, D the tier's deduction and fee the taker fee rate. Bybit holds the
 * fee to close in both the initial and the maintenance margin, so it cancels out. extra: margin beyond E·S/L, negative
 * once funding has been taken from the position's margin. A long's level is never below 0. isolatedLevel is unchanged.
 */
export function bybitIsolatedLevel(side,entry,units,leverage,plan,{extra=0,fee=0}={}){
  const value=entry*units,deduction=plan.deduction??0;
  return side==='long'?
    Math.max(0,(value-value/leverage-extra/(1-fee)-deduction)/(units*(1-plan.maintenance))):
    (value+value/leverage+extra/(1+fee)+deduction)/(units*(1+plan.maintenance));
}
