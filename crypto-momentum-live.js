// Read-only quotes and valuation. Trading and funding stay in the account loop.
import {CONTRACTS,CONTRACT_UNITS} from './bybit-contracts.js';
import {leveragedValue} from './crypto-leverage.js';
export const QUOTE_INTERVAL=5000, QUOTE_TTL=15000;
const positive=n=>Number.isFinite(n)&&n>0;
const fresh=(q,now)=>q&&positive(q.price)&&positive(q.mark)&&Number.isFinite(q.at)&&q.at<=now+5000&&now-q.at<=QUOTE_TTL;

export async function fetchMomentumQuotes(grab,symbols,now=()=>Date.now()){
  return Object.fromEntries(await Promise.all([...new Set(symbols)].map(async symbol=>{
    const contract=CONTRACTS[symbol],scale=CONTRACT_UNITS[symbol];
    if(!contract||!scale)throw Error('Okänt perpetualkontrakt');
    const j=await grab('https://api.bybit.com/v5/market/tickers?'+new URLSearchParams({category:'linear',symbol:contract}),{json:true,timeout:4000,budget:4500});
    const row=j?.result?.list?.find(r=>r.symbol===contract);
    const q={price:+row?.lastPrice/scale,mark:+row?.markPrice/scale,at:j?.time};
    if(j?.retCode!==0||j.result?.category!=='linear'||!fresh(q,now()))throw Error('Färskt perpetualpris saknas för '+symbol);
    return [symbol,q];
  })));
}

export function momentumLiveValue(account,quotes,now){
  let balance=account.sleeves.reduce((sum,s)=>sum+s.cash,0),openNet=0,at=null,reason='';
  const positions={};
  for(const s of account.sleeves){
    const p=s.position;if(!p)continue;
    const q=quotes?.[s.symbol],current=fresh(q,now);
    // A fresh ticker cannot certify funding or liquidation during an old gap.
    const reconciled=Number.isFinite(p.fundingThrough)&&now-p.fundingThrough<=120000;
    const value=current&&reconciled?leveragedValue(p,q.price):null;
    positions[s.symbol]={quote:current?q:null,value,pnl:value===null?null:value-p.budget};
    if(!current)reason='Väntar på färskt pris';
    else if(!reconciled)reason ||= 'Väntar på funding- och likvidationskontroll';
    if(value!==null){balance+=value;openNet+=value-p.budget;at=at===null?q.at:Math.min(at,q.at);}
  }
  return {balance:reason?null:balance,openNet:reason?null:openNet,at:reason?null:at,reason,positions};
}
