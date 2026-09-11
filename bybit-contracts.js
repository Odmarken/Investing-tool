// Public contract limits only. No account credentials or leverage-setting API.
export const CONTRACTS=Object.freeze({BTC:'BTCUSDT',ETH:'ETHUSDT',SOL:'SOLUSDT',XRP:'XRPUSDT',DOGE:'DOGEUSDT',SHIB:'SHIB1000USDT',PEPE:'1000PEPEUSDT'});
// Perpetual prices for these contracts quote 1000 underlying tokens.
export const CONTRACT_UNITS=Object.freeze({BTC:1,ETH:1,SOL:1,XRP:1,DOGE:1,SHIB:1000,PEPE:1000});
export const LIMIT_TTL=10*60000;
const positive=x=>Number.isFinite(x)&&x>0;
export function parseContract(symbol,info,risk,at){
  const contract=CONTRACTS[symbol],i=info.find(x=>x.symbol===contract);
  if(!i||i.status!=='Trading'||i.contractType!=='LinearPerpetual'||i.quoteCoin!=='USDT'||i.settleCoin!=='USDT')throw Error('Aktivt USDT-perpetualkontrakt saknas för '+symbol);
  const max=+i.leverageFilter?.maxLeverage,min=+i.leverageFilter?.minLeverage,step=+i.leverageFilter?.leverageStep;
  if(![max,min,step].every(positive)||min>max)throw Error('Ogiltig hävstångsgräns');
  const tiers=risk.filter(r=>r.symbol===contract).map(r=>({id:+r.id,cap:+r.riskLimitValue,max:+r.maxLeverage,maintenance:+r.maintenanceMargin,deduction:r.mmDeduction===''?0:+r.mmDeduction})).sort((a,b)=>a.cap-b.cap);
  if(!tiers.length||tiers.some((t,j)=>![t.id,t.cap,t.max,t.maintenance].every(positive)||t.maintenance>=1||!Number.isFinite(t.deduction)||t.deduction<0||j&&t.cap<=tiers[j-1].cap))
    throw Error('Bybits risknivåer saknas eller är ogiltiga');
  return {symbol,contract,max,min,step,tiers,at};
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
