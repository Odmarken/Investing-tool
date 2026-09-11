import {LEVERAGE} from './crypto-leverage.js';
import {fetchContract} from './bybit-contracts.js';
const api='https://api.bybit.com/v5/market/';
const valid=x=>Number.isFinite(x)&&x>0;
export async function fetchDerivatives(grab,symbol,position,now){
  const get=async(path,params)=>{
    const j=await grab(api+path+'?'+new URLSearchParams({category:'linear',symbol:symbol+'USDT',...params}),{json:true,timeout:8000});
    if(j?.retCode!==0||!Array.isArray(j.result?.list)||!Number.isFinite(j.time)||j.time>now()+5000||now()-j.time>120000)
      throw Error('Färskt derivatsvar saknas för '+symbol);
    return j;
  };
  const [ticker,contract]=await Promise.all([get('tickers',{}),fetchContract(grab,symbol,now).catch(()=>null)]),quote=ticker.result.list.find(x=>x.symbol===symbol+'USDT');
  const market={price:+quote?.lastPrice,mark:+quote?.markPrice,at:ticker.time,contract};
  if(!valid(market.price)||!valid(market.mark))throw Error('Ogiltigt derivatpris');
  if(!position)return market;
  const step=LEVERAGE.step,from=Math.min(position.nextBar,Math.floor(position.fundingThrough/step)*step);
  const bars=new Map();let end=now(),pages=0;
  while(end>=from){
    if(++pages>40)throw Error('För lång frånvaro: markprishistoriken kunde inte återställas');
    const j=await get('mark-price-kline',{interval:'5',limit:'1000',end:String(end)});
    if(j.result.category!=='linear'||j.result.symbol!==symbol+'USDT'||!j.result.list.length)throw Error('Markpriser saknas');
    for(const r of j.result.list){const b={t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4]};
      if(!Number.isFinite(b.t)||b.t%step||![b.o,b.h,b.l,b.c].every(valid)||b.h<Math.max(b.o,b.l,b.c)||b.l>Math.min(b.o,b.c))throw Error('Ogiltig markprisstapel');
      if(b.t>=from&&b.t<=now())bars.set(b.t,b);
    }
    const next=Math.min(...j.result.list.map(r=>+r[0]))-1;if(next>=end)throw Error('Markprispaginering stannade');end=next;
  }
  const info=await get('instruments-info',{}),instrument=info.result.list.find(x=>x.symbol===symbol+'USDT');
  const interval=+instrument?.fundingInterval*60000,nextFunding=+quote.nextFundingTime;
  if(!valid(interval)||!valid(nextFunding)||nextFunding<=now()||nextFunding-now()>interval+120000)throw Error('Fundingintervall saknas eller håller på att växla');
  const funds=new Map();end=now();pages=0;let covered=false;
  while(!covered){
    if(++pages>40)throw Error('Fundinghistoriken kunde inte återställas');
    const j=await get('funding/history',{limit:'200',endTime:String(end)});
    if(!j.result.list.length)throw Error('Fundinghistorik saknas');
    for(const r of j.result.list){const f={t:+r.fundingRateTimestamp,rate:+r.fundingRate};
      if(r.symbol!==symbol+'USDT'||!Number.isFinite(f.t)||f.t%step||!Number.isFinite(f.rate))throw Error('Ogiltig funding');
      funds.set(f.t,f);
    }
    const next=Math.min(...j.result.list.map(r=>+r.fundingRateTimestamp))-1;
    if(next>=end)throw Error('Fundingpaginering stannade');
    covered=next<position.fundingThrough;end=next;
  }
  const allFunds=[...funds.values()].sort((a,b)=>a.t-b.t);
  if(allFunds.at(-1).t<nextFunding-interval||allFunds.some((f,i)=>i&&f.t>position.fundingThrough&&f.t-allFunds[i-1].t>8*3600000))
    throw Error('Fundinghistoriken är ännu inte komplett');
  market.markBars=[...bars.values()].sort((a,b)=>a.t-b.t);
  if(market.markBars[0]?.t!==from||market.markBars.some((b,i)=>i&&b.t-market.markBars[i-1].t!==step))throw Error('Lucka i markpriser');
  market.historyFrom=from;market.funding=allFunds.filter(f=>f.t>position.fundingThrough&&f.t<=now());market.fundingThrough=now();
  return market;
}
