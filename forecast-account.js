// AI Forecast demo account: its own 100 $ ledger, separate from every other
// demo account, trading Bybit's linear USDT perpetuals long and short with
// isolated margin and market orders. Positions come from the signals while
// auto-trading is on (settings.auto) or from the user's own orders, at most one
// per coin. Pure functions on JSON state: no network, no clock, no orders. Every
// function copies its input, reads a version 1 account as version 2, and
// validates what it returns.
// openPosition, openManual and setLevels return {account,…}; previewOrder and
// previewLevels return a preview; settlePosition, checkQuote, closePosition,
// updateSettings, setPaused, setAuto, markProcessed, deposit, withdraw and
// setFree return the new account (a close appends to account.trades).
// A manual order's position is margined as Bybit margins an isolated position:
// the order also reserves Bybit's fee to close (position.reserve, released at a
// close, lost in a liquidation), its liquidation price is Bybit's, and funding
// is paid from the free cash first. Signal positions keep the margining they
// were sized with, as the backtest has it.
import {SYMBOLS,TF,CHART_TFS,SIGNAL_PARAMS} from './forecast-config.js';
import {CONTRACTS,LIMIT_TTL,maxLeverageFor,isolatedLevel,bybitIsolatedLevel,floorQty,ceilQty,roundPrice} from './bybit-contracts.js';

// liqBuffer: how far beyond the stop (a share of the entry price) Bybit's liquidation must lie for the stop to count as
// the first exit when sizing; it covers Bybit's ordinary funding (0.01 % per 8 h) over the longest hold, 20 days.
// transferMax: the largest single deposit or withdrawal.
export const ACCOUNT=Object.freeze({version:'ai-forecast-account-v2',start:100,fee:.00055,slip:.0005,step:300000,
  quoteTtl:15000,logLimit:500,minMargin:.01,minRR:1,maxSignalAge:1800000,liqBuffer:.01,transferMax:1000000,
  defaults:Object.freeze({tf:'1h',symbols:SYMBOLS,positionPct:.25,riskPct:.10,maxOpen:3,leverage:'max',paused:false,auto:false})});
export const SETTING_LIMITS=Object.freeze({positionPct:Object.freeze([.01,1]),riskPct:Object.freeze([.001,1]),maxOpen:Object.freeze([1,7]),leverage:Object.freeze([1,200])});
export const accountKey=uid=>'riptide.forecast.v1:'+encodeURIComponent(uid);
export const tradeReasons=Object.freeze({stopp:'Stopp',mål:'Mål',likvidation:'Likvidation',tid:'Tidsstopp',manuell:'Stängd manuellt',signal:'Motsatt signal',slut:'Periodens slut'});

// No prototype: a stored side such as '__proto__' or 'constructor' must not count as a direction.
const DIR=Object.freeze(Object.assign(Object.create(null),{long:1,short:-1}));
const SIDE_TEXT=Object.freeze({long:'lång',short:'kort'});
const CLOSE_REASONS=Object.freeze(['manuell','signal','tid','slut']);
// The first stored format: no auto-trading switch, every position from a signal, no transfers.
const V1='ai-forecast-account-v1',V1_KEYS=Object.freeze(['tf','symbols','positionPct','riskPct','maxOpen','leverage','paused']);
const ORIGINS=Object.freeze(['signal','manual']);
const LOG_KINDS=Object.freeze({[V1]:Object.freeze(['öppnad','avvisad','stängd']),[ACCOUNT.version]:Object.freeze(['öppnad','avvisad','stängd','ändrad','insättning','uttag'])});
// A fresh ticker cannot vouch for funding or liquidation across an unsettled gap longer than this.
const RISK_TTL=120000,MIN=60000,HOUR=3600000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;
const within=(x,[lo,hi])=>finite(x)&&x>=lo&&x<=hi;
const same=(x,y,eps=1e-7)=>Math.abs(x-y)<=eps*Math.max(1,Math.abs(x),Math.abs(y));
const sum=(xs,f)=>xs.reduce((s,x)=>s+f(x),0);
const fresh=(q,now)=>!!q&&positive(q.price)&&positive(q.mark)&&finite(q.at)&&q.at<=now+5000&&now-q.at<=ACCOUNT.quoteTtl;
const num=(x,d=2)=>x.toLocaleString('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d});
const signed=x=>(x<0?'−':'+')+num(Math.abs(x))+' $';
const priceText=x=>x.toLocaleString('sv-SE',{maximumSignificantDigits:6});
const pctText=x=>(x*100).toLocaleString('sv-SE',{maximumFractionDigits:1})+' %';
// A manual order's position holds Bybit's fee to close, `reserve` (present, possibly 0, only there).
const bybitMargined=p=>p.reserve!==undefined;
// Its initial margin, value / leverage, as the order set it.
const stake=p=>p.units*p.entry/p.leverage;
// Bybit's fee to close, estimated at the bankruptcy price: value × (1 ∓ 1/L) × the taker fee, the larger for a short.
const feeToClose=(units,entry,leverage,dir)=>units*entry*(1-dir/leverage)*ACCOUNT.fee;
// What a position holds of the account's money: its margin and, for a manual order's, the fee to close.
const inPosition=p=>p.margin+(p.reserve??0);
const realized=a=>a.cash+sum(a.positions,inPosition);
const flow=x=>x.kind==='in'?x.amount:-x.amount;
const marked=p=>p.origin==='manual'?' (manuell)':'';
// The liquidation price for the margin the position holds now. A manual order's: Bybit's, where funding taken from the
// margin counts as negative extra margin. A signal position's: the level it was sized with (isolatedLevel takes margin
// plus the opening fee and deducts that fee itself).
const levelOf=p=>bybitMargined(p)?bybitIsolatedLevel(p.side,p.entry,p.units,p.leverage,p,{extra:p.margin-stake(p),fee:ACCOUNT.fee}):
  isolatedLevel(p.side,p.entry,p.margin+p.units*p.entry*ACCOUNT.fee,p.units,ACCOUNT.fee,p);

function checkSettings(s,version=ACCOUNT.version){
  const keys=version===V1?V1_KEYS:Object.keys(ACCOUNT.defaults),L=SETTING_LIMITS;
  if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).length!==keys.length||!keys.every(k=>Object.hasOwn(s,k)))throw Error('Ogiltiga inställningar för AI Forecast');
  if(!CHART_TFS.includes(s.tf))throw Error('Okänd tidsram');
  if(!Array.isArray(s.symbols)||!s.symbols.length)throw Error('Välj minst ett par att handla');
  if(!s.symbols.every(x=>SYMBOLS.includes(x))||new Set(s.symbols).size!==s.symbols.length)throw Error('Ogiltiga par: '+s.symbols.join(', '));
  if(!within(s.positionPct,L.positionPct))throw Error('Positionsstorleken ska vara '+pctText(L.positionPct[0])+'–'+pctText(L.positionPct[1])+' av kapitalet');
  if(!within(s.riskPct,L.riskPct))throw Error('Risken per affär ska vara '+pctText(L.riskPct[0])+'–'+pctText(L.riskPct[1])+' av kapitalet');
  if(!Number.isInteger(s.maxOpen)||!within(s.maxOpen,L.maxOpen))throw Error('Max öppna positioner ska vara '+L.maxOpen[0]+'–'+L.maxOpen[1]);
  if(s.leverage!=='max'&&!within(s.leverage,L.leverage))throw Error('Hävstången ska vara Bybits max eller '+L.leverage[0]+'–'+L.leverage[1]+'×');
  if(typeof s.paused!=='boolean')throw Error('Ogiltigt pausläge');
  if(version!==V1&&typeof s.auto!=='boolean')throw Error('Ogiltigt läge för auto-handel');
  return s;
}
const normalized=s=>({...s,symbols:SYMBOLS.filter(x=>s.symbols.includes(x))});
// Version 2: a position comes from a signal (its stop, target and time stop) or is manual: no time stop, and a stop
// and a target that may be missing. A signal position whose levels the user changed is manual and keeps its signal's
// id and timeframe. levelsAt: when the current levels took effect; nextBar never lies before the step after it.
function checkPosition(p,version){
  const dir=DIR[p?.side],v2=version!==V1,manual=v2&&p?.origin==='manual',level=x=>positive(x)||manual&&x===null;
  // A manual order's position: no signal, Bybit's fee to close as the order reserved it, and a margin that funding can only
  // take from (funding received goes to the free cash).
  const bybit=p?.reserve!==undefined;
  if(!p||typeof p.id!=='string'||!p.id||!SYMBOLS.includes(p.symbol)||!dir||v2&&!ORIGINS.includes(p.origin)||
    !(typeof p.signalId==='string'&&p.signalId||manual&&p.signalId===null)||!(CHART_TFS.includes(p.tf)||manual&&p.tf===null)||
    ![p.entry,p.units,p.leverage,p.openedAt,p.nextBar,p.fundingThrough,p.equityAtOpen,p.riskId].every(positive)||!level(p.sl)||!level(p.tp)||
    !(positive(p.deadline)&&p.deadline>p.openedAt||manual&&p.deadline===null)||v2&&!(finite(p.levelsAt)&&p.levelsAt>=p.openedAt&&p.nextBar>p.levelsAt)||
    bybit&&!(manual&&p.signalId===null&&p.tf===null&&finite(p.reserve)&&same(p.reserve,feeToClose(p.units,p.entry,p.leverage,dir)))||
    !finite(p.margin)||!finite(p.funding)||!(bybit?p.margin<=stake(p)*(1+1e-9):positive(p.margin+p.funding))||!finite(p.fees)||p.fees<0||
    !finite(p.maintenance)||p.maintenance<=0||p.maintenance>=1||
    !finite(p.deduction)||p.deduction<0||!finite(p.liq)||p.liq<0||p.nextBar%ACCOUNT.step||p.nextBar<=p.openedAt||p.fundingThrough<p.openedAt||
    (manual?p.sl!==null&&p.tp!==null&&dir*(p.tp-p.sl)<=0:dir*(p.entry-p.sl)<=0||dir*(p.tp-p.entry)<=0))throw Error('Ogiltig AI Forecast-position');
  if(Math.abs(p.liq-levelOf(p))>1e-9*p.entry)throw Error('Likvidationsnivån för '+p.symbol+' stämmer inte med marginalen');
}
// A trade without an origin (version 1, or the backtest's ledger) came from a signal. A manual order's trade also has
// the fee to close its position reserved (`reserve`): a liquidation loses it, and funding it paid from the free cash.
function checkTrade(t,version){
  const manual=version!==V1&&t?.origin==='manual',bybit=t?.reserve!==undefined;
  if(!t||typeof t.id!=='string'||!t.id||!SYMBOLS.includes(t.symbol)||!DIR[t.side]||version!==V1&&!(t.origin===undefined||ORIGINS.includes(t.origin))||
    !(typeof t.signalId==='string'&&t.signalId||manual&&t.signalId===null)||!(CHART_TFS.includes(t.tf)||manual&&t.tf===null)||
    bybit&&!(manual&&t.signalId===null&&t.tf===null&&finite(t.reserve)&&t.reserve>=0)||
    ![t.entry,t.exit,t.units,t.margin,t.leverage,t.openedAt,t.closedAt].every(positive)||t.closedAt<t.openedAt||!Object.hasOwn(tradeReasons,t.reason)||
    !finite(t.pnl)||!finite(t.fees)||t.fees<0||!finite(t.funding)||!finite(t.equityAfter)||
    t.pnl<-(t.margin+t.fees+(bybit?t.reserve+Math.max(0,t.funding):0))*(1+1e-9))
    throw Error('Ogiltig AI Forecast-affär');
}
function checkLog(e,version){
  if(!e||!positive(e.t)||!LOG_KINDS[version].includes(e.kind)||typeof e.text!=='string'||!e.text||!(e.symbol===null||SYMBOLS.includes(e.symbol))||
    !(e.signalId===null||typeof e.signalId==='string'))throw Error('Ogiltig logg i AI Forecast-kontot');
}
// A deposit or withdrawal: never an edit of the balance. tradeCount: how many trades had closed before it, which
// places it among the trades for accountStats.
function checkTransfer(x,a){
  if(!x||typeof x.id!=='string'||!x.id||!positive(x.t)||x.kind!=='in'&&x.kind!=='out'||!positive(x.amount)||x.amount>ACCOUNT.transferMax||
    !finite(x.cashAfter)||x.cashAfter<0||!Number.isInteger(x.tradeCount)||x.tradeCount<0||x.tradeCount>a.trades.length)
    throw Error('Ogiltig insättning eller uttag i AI Forecast-kontot');
}
/**
 * Validates a stored account of either version and returns it unchanged. Version 1 is held to its own rules;
 * migrateForecastAccount turns it into version 2. A version 2 account may lack `transfers` (none were made) and
 * its trades their origin (a signal), as the backtest's ledger does.
 */
export function validateForecastAccount(a){
  const version=a?.version;
  // A page loaded before a deploy can meet a newer stored format: say so instead of failing silently.
  if(typeof version==='string'&&version!==ACCOUNT.version&&version!==V1&&version.startsWith('ai-forecast-account-'))
    throw Error('AI Forecast-kontot har en annan version ('+version+'). Ladda om sidan.');
  if(!a||typeof a!=='object'||version!==ACCOUNT.version&&version!==V1||!positive(a.createdAt)||!positive(a.start)||!finite(a.cash)||a.cash<0||
    !finite(a.fees)||a.fees<0||!finite(a.funding)||!Array.isArray(a.positions)||!Array.isArray(a.trades)||!Array.isArray(a.log)||
    version!==V1&&a.transfers!==undefined&&!Array.isArray(a.transfers)||
    !a.processed||typeof a.processed!=='object'||Array.isArray(a.processed))throw Error('Ogiltigt AI Forecast-konto');
  checkSettings(a.settings,version);
  a.positions.forEach(p=>checkPosition(p,version));a.trades.forEach(t=>checkTrade(t,version));
  if(a.log.length>ACCOUNT.logLimit)throw Error('AI Forecast-loggen är för lång');
  a.log.forEach(e=>checkLog(e,version));
  const transfers=version===V1?[]:a.transfers??[];
  transfers.forEach(x=>checkTransfer(x,a));
  if(new Set(transfers.map(x=>x.id)).size!==transfers.length||transfers.some((x,i)=>i&&x.tradeCount<transfers[i-1].tradeCount))
    throw Error('Ogiltig insättning eller uttag i AI Forecast-kontot');
  for(const [symbol,t] of Object.entries(a.processed))if(!SYMBOLS.includes(symbol)||!(t===null||positive(t)))throw Error('Ogiltig bearbetningsmarkering för '+symbol);
  const held=a.positions.map(p=>p.symbol),both=[...a.positions,...a.trades],signals=both.map(x=>x.signalId).filter(x=>x!==null);
  if(new Set(held).size!==held.length)throw Error('Högst en position per par');
  if(new Set(both.map(x=>x.id)).size!==both.length||new Set(signals).size!==signals.length)throw Error('Samma signal är handlad två gånger');
  // The ledger reconciles: the start plus deposits less withdrawals plus realized results, minus what open positions locked
  // up (their margin, the funding and fees paid, and a manual order's fee to close).
  const cash=a.start+sum(transfers,flow)+sum(a.trades,t=>t.pnl)-sum(a.positions,p=>p.margin+p.funding+p.fees+(p.reserve??0));
  if(!same(a.cash,cash)||!same(a.fees,sum(a.trades,t=>t.fees)+sum(a.positions,p=>p.fees))||!same(a.funding,sum(a.trades,t=>t.funding)+sum(a.positions,p=>p.funding)))
    throw Error('AI Forecast-kontots kassa stämmer inte');
  return a;
}
/**
 * The account as version 2, validated. Version 1 (pure, nothing else changes): auto-trading off, every position
 * and trade from a signal, a position's levels in effect since its opening, no transfers. A version 2 account
 * without transfers or trade origins gets them filled in; a complete one is returned as it is.
 */
export function migrateForecastAccount(a){
  validateForecastAccount(a);
  if(a.version===ACCOUNT.version&&Array.isArray(a.transfers)&&a.trades.every(t=>t.origin!==undefined))return a;
  const next=structuredClone(a);
  if(a.version===V1){
    next.version=ACCOUNT.version;
    next.settings={...next.settings,auto:false};
    next.positions=next.positions.map(p=>({...p,origin:'signal',levelsAt:p.openedAt}));
  }
  next.trades=next.trades.map(t=>t.origin===undefined?{...t,origin:'signal'}:t);
  next.transfers??=[];
  return validateForecastAccount(next);
}
// A version 2 copy to change.
const own=a=>structuredClone(migrateForecastAccount(a));
export function newForecastAccount(now,settings={}){
  if(!positive(now))throw Error('Ogiltig starttid');
  const s=checkSettings({...ACCOUNT.defaults,...settings});
  return validateForecastAccount({version:ACCOUNT.version,createdAt:now,start:ACCOUNT.start,cash:ACCOUNT.start,settings:normalized(s),
    positions:[],trades:[],transfers:[],log:[],processed:{},fees:0,funding:0});
}
// A version 1 account is read as version 2 under the same key; the next write stores it so.
export function readForecastAccount(storage,key,now){
  const raw=storage.getItem(key);if(raw===null||raw===undefined)return newForecastAccount(now);
  let a;try{a=JSON.parse(raw);}catch{throw Error('AI Forecast-kontot kan inte läsas');}
  return migrateForecastAccount(a);
}
export function updateSettings(a,patch){
  const next=own(a),before=next.settings.tf;
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('Ogiltiga inställningar för AI Forecast');
  const unknown=Object.keys(patch).find(k=>!Object.hasOwn(ACCOUNT.defaults,k));
  if(unknown)throw Error('Okänd inställning: '+unknown);
  const s=checkSettings({...next.settings,...structuredClone(patch)});
  next.settings=normalized(s);
  // Bar times from another timeframe say nothing about the new one.
  if(s.tf!==before)next.processed={};
  return validateForecastAccount(next);
}
export function setPaused(a,paused){
  if(typeof paused!=='boolean')throw Error('Ogiltigt pausläge');
  return updateSettings(a,{paused});
}
// Auto-trading: signal entries and opposite-signal exits. Open signal positions keep their own rules either way.
export function setAuto(a,auto){
  if(typeof auto!=='boolean')throw Error('Ogiltigt läge för auto-handel');
  return updateSettings(a,{auto});
}
// The runner's record of the last bar it evaluated for entries in this symbol; only moves forward.
export function markProcessed(a,symbol,t){
  const next=own(a);
  if(!SYMBOLS.includes(symbol)||!positive(t))throw Error('Ogiltig bearbetningsmarkering');
  next.processed[symbol]=Math.max(next.processed[symbol]??0,t);
  return validateForecastAccount(next);
}
function log(a,entry){
  a.log.push(entry);
  if(a.log.length>ACCOUNT.logLimit)a.log.splice(0,a.log.length-ACCOUNT.logLimit);
}

/**
 * Margin and leverage for one entry. Leverage is Bybit's maximum for the
 * notional (or the user's number, capped there); the margin is the largest that
 * the position budget, the cash left after the opening fee and riskPct of
 * equity allow. The risk is the loss when the price moves to the stop: the
 * stop's (the move plus fees and slippage, L·per of the margin) when the stop
 * comes first, else the whole margin plus the opening fee (1 + L·fee). The stop
 * comes first only when Bybit's isolated liquidation for that very margin lies
 * more than ACCOUNT.liqBuffer of the entry price beyond it: funding paid while
 * the position is open moves the liquidation closer, the mark can run ahead of
 * the last price, and a candle that reaches the stop often runs past it, so a
 * liquidation just beyond the stop would often come first. The tier's deduction
 * moves the liquidation away as the margin shrinks, so when the stop's margin is
 * too large for that, the largest smaller margin at which the stop still comes
 * first is used if it beats the liquidation's margin. Smaller margins can reach
 * higher-leverage risk tiers, so leverage is re-read for the new margin up to
 * four times; each pass may only shrink the margin, so the final leverage stays
 * within Bybit's limits. lossAtStop = margin × lossFraction ≤ riskPct of equity.
 */
export function sizePosition({equity,cash,settings,contract,side,price,mark,sl,now}={}){
  const no=reason=>({ok:false,reason}),dir=DIR[side],{fee,slip,minMargin}=ACCOUNT;
  if(!dir)return no('Ogiltig riktning');
  if(![equity,price,mark,sl,now].every(positive)||!finite(cash))return no('Ogiltiga uppgifter för positionsstorleken');
  if(!settings||!within(settings.positionPct,SETTING_LIMITS.positionPct)||!within(settings.riskPct,SETTING_LIMITS.riskPct)||
    settings.leverage!=='max'&&!within(settings.leverage,SETTING_LIMITS.leverage))return no('Ogiltiga inställningar för AI Forecast');
  const c=contract;
  if(!c||typeof c!=='object'||!finite(c.at)||now-c.at>LIMIT_TTL||c.at>now+5000||![c.min,c.max,c.step].every(positive)||!Array.isArray(c.tiers)||!c.tiers.length||
    !c.tiers.every(t=>t&&[t.id,t.cap,t.max,t.maintenance].every(positive)&&t.maintenance<1&&finite(t.deduction)&&t.deduction>=0))
    return no('Bybits hävstångsgräns saknas eller är för gammal');
  const fill=price*(1+dir*slip);
  if(dir*(fill-sl)<=0)return no('Stoppet ligger på fel sida om priset');
  if(cash<=0)return no('Otillräcklig kassa för en ny position');
  const ratio=Math.max(1,mark/fill),d=Math.abs(fill-sl)/fill,tiers=[...c.tiers].sort((x,y)=>x.cap-y.cap),risk=settings.riskPct*equity;
  // Share of the notional lost at the stop: the move plus fee and slippage on both sides, on top of the
  // already slipped fill. A short's exit costs grow with the stop's distance (only beyond ~48 % does that exceed it).
  const per=Math.max(d+2*(fee+slip),dir<0?d+(1+d)*(slip+fee*(1+slip))+fee:0);
  // maxLeverageFor's budget includes the opening fee; with fee 0 its notional is exactly margin × leverage.
  const leverageFor=m=>{
    const top=maxLeverageFor(c,m,{price:fill,mark},now).leverage;
    return settings.leverage==='max'?top:Number((Math.floor((Math.min(settings.leverage,top)+1e-10)/c.step)*c.step).toFixed(8));
  };
  const tierAt=notional=>tiers.find(t=>notional*ratio<=t.cap*(1+1e-12));
  // Whether the stop comes first at margin m: the stop takes less than the whole margin, and Bybit's isolated
  // liquidation for that margin lies more than the buffer beyond the stop.
  const room=ACCOUNT.liqBuffer*fill;
  const first=(L,m)=>{
    const t=L*per<1?tierAt(m*L):null;
    return !!t&&dir*(isolatedLevel(side,fill,m*(1+L*fee),m*L/fill,fee,t)-sl)+room<0;
  };
  // The largest margin within the budget and the cash that loses at most riskPct at the stop. `most`: the previous
  // pass's margin. Bybit's deduction moves the liquidation away from a smaller margin, so when the stop does not come
  // first at the stop's margin, the largest margin at which it does (found by halving; within a tier the liquidation
  // only moves closer as the margin grows) is used when it is more than the liquidation's margin.
  const sized=(L,most)=>{
    const cap=Math.min(most,settings.positionPct*equity,cash/(1+L*fee)),whole=Math.min(cap,risk/(1+L*fee));
    if(L*per<1){
      let hi=Math.min(cap,risk/(L*per));
      if(first(L,hi))return {L,margin:hi,lossFraction:L*per};
      if(first(L,whole)){
        let lo=whole;
        for(let k=0;k<60&&hi-lo>1e-12*hi;k++){const mid=(lo+hi)/2;if(first(L,mid))lo=mid;else hi=mid;}
        return {L,margin:lo,lossFraction:L*per};
      }
    }
    return {L,margin:whole,lossFraction:1+L*fee};
  };
  let s;
  try{
    s=sized(leverageFor(Math.min(settings.positionPct*equity,cash)),Infinity);
    for(let k=0;k<4&&s.margin>=minMargin;k++){const L=leverageFor(s.margin);if(L===s.L)break;s=sized(L,s.margin);}
  }catch(e){return no(e.message);}
  if(!(s.margin>=minMargin))return no(cash/(1+s.L*fee)<minMargin?'Otillräcklig kassa för en ny position':'Positionen blir för liten (marginal under '+num(minMargin)+' $)');
  const L=s.L,margin=s.margin,notional=margin*L,units=notional/fill,openFee=notional*fee;
  if(L<c.min-1e-8)return no('Hävstången är lägre än Bybits minsta ('+c.min+'×)');
  const tier=tierAt(notional);
  if(!tier||L>tier.max+1e-8||L>c.max+1e-8)return no('Positionen ryms inte inom Bybits risk- och hävstångsgränser');
  return {ok:true,leverage:L,margin,notional,units,fill,openFee,liq:isolatedLevel(side,fill,margin+openFee,units,fee,tier),
    lossAtStop:margin*s.lossFraction,lossFraction:s.lossFraction,maintenance:tier.maintenance,deduction:tier.deduction,riskId:tier.id};
}

// A signal entry, sized by the settings. The runner calls it only while auto-trading is on; settings.auto is not read here.
// maxOpen counts the open signal positions: manual ones take no slot.
export function openPosition(a,{signal,symbol,quote,contract,now,tfMs,dataReliable}={}){
  const next=own(a);
  if(!positive(now))throw Error('Ogiltig tid');
  const s=next.settings,signalId=typeof signal?.id==='string'&&signal.id?signal.id:null;
  const reject=reason=>{
    // A runner retrying the same signal for the same reason does not flood the log.
    const last=signalId===null?null:next.log.findLast(e=>e.signalId===signalId);
    if(!(last?.kind==='avvisad'&&last.text===reason))log(next,{t:now,kind:'avvisad',symbol:SYMBOLS.includes(symbol)?symbol:null,signalId,text:reason});
    return {account:validateForecastAccount(next),opened:false,reason};
  };
  if(s.paused)return reject('Nya affärer är pausade');
  if(dataReliable!==true)return reject('Marknadsdatan är inte tillförlitlig just nu — ingen ny affär');
  if(!SYMBOLS.includes(symbol))return reject('Okänt par');
  const dir=DIR[signal?.side];
  if(!signalId||!dir||![signal.entry,signal.sl,signal.tp,signal.barTime,signal.confirmedAt,tfMs].every(positive)||!CHART_TFS.includes(signal.tf)||
    TF[signal.tf].ms!==tfMs||signal.confirmedAt!==signal.barTime+tfMs||signal.symbol!==undefined&&signal.symbol!==symbol||dir*(signal.tp-signal.sl)<=0)
    return reject('Ogiltig signal för '+symbol);
  if(!s.symbols.includes(symbol))return reject(symbol+' ingår inte i de handlade paren');
  if(signal.tf!==s.tf)return reject('Signalen gäller '+TF[signal.tf].label+' men kontot handlar '+TF[s.tf].label);
  if(!fresh(quote,now))return reject('Färskt pris saknas för '+symbol);
  const age=now-signal.confirmedAt,deadline=signal.confirmedAt+SIGNAL_PARAMS.maxHold*tfMs;
  if(age<-5000)return reject('Signalen är inte bekräftad ännu');
  if(age>Math.min(ACCOUNT.maxSignalAge,tfMs))return reject('Signalen är för gammal ('+Math.round(age/60000)+' min)');
  if(now>=deadline)return reject('Signalens hålltid har redan gått ut');
  // A price from before the candle closed existed before the signal did: filling at it would look ahead.
  if(quote.at<signal.confirmedAt)return reject('Färskt pris efter signalen saknas för '+symbol);
  if([...next.positions,...next.trades].some(x=>x.signalId===signalId))return reject('Signalen är redan handlad');
  if(next.positions.some(p=>p.symbol===symbol))return reject('Det finns redan en position i '+symbol);
  if(next.positions.filter(p=>p.origin==='signal').length>=s.maxOpen)return reject('Max antal öppna positioner är nått ('+s.maxOpen+')');
  const price=quote.price,fill=price*(1+dir*ACCOUNT.slip);
  // The fill must also sit inside: an entry that slips past the target can only lose.
  if(!(dir*(price-signal.sl)>0&&dir*(signal.tp-price)>0&&dir*(fill-signal.sl)>0&&dir*(signal.tp-fill)>0))return reject('Priset ligger redan utanför stopp och mål');
  const rr=Math.abs(signal.tp-price)/Math.abs(price-signal.sl);
  if(rr<ACCOUNT.minRR)return reject('Kvarvarande vinst/risk '+num(rr)+' är under '+num(ACCOUNT.minRR,0));
  if(contract&&typeof contract==='object'&&(contract.symbol!==symbol||contract.contract!==CONTRACTS[symbol]))return reject('Bybits gränser gäller ett annat kontrakt än '+symbol);
  const equity=realized(next),plan=sizePosition({equity,cash:next.cash,settings:s,contract,side:signal.side,price,mark:quote.mark,sl:signal.sl,now});
  if(!plan.ok)return reject(plan.reason);
  if(dir*(quote.mark-plan.liq)<=0)return reject('Markpriset ligger redan vid likvidationsnivån');
  const p={id:'p|'+signalId,symbol,side:signal.side,signalId,tf:signal.tf,entry:plan.fill,units:plan.units,margin:plan.margin,leverage:plan.leverage,
    maintenance:plan.maintenance,deduction:plan.deduction,riskId:plan.riskId,sl:signal.sl,tp:signal.tp,liq:plan.liq,openedAt:now,deadline,
    fees:plan.openFee,funding:0,nextBar:(Math.floor(now/ACCOUNT.step)+1)*ACCOUNT.step,fundingThrough:now,equityAtOpen:equity,origin:'signal',levelsAt:now};
  next.cash-=plan.margin+plan.openFee;
  // The sizing keeps margin plus fee within cash; only rounding can dip below zero.
  if(next.cash<0&&next.cash>-1e-9)next.cash=0;
  next.fees+=plan.openFee;next.positions.push(p);
  log(next,{t:now,kind:'öppnad',symbol,signalId,text:'Öppnade '+SIDE_TEXT[p.side]+' '+symbol+' till '+priceText(p.entry)+' · '+
    leverageText(p.leverage)+' · marginal '+num(p.margin)+' $'});
  return {account:validateForecastAccount(next),opened:true,reason:'',position:{...p}};
}

// ---- Manual orders and levels ---------------------------------------------------------------------------------
const leverageText=x=>x.toLocaleString('sv-SE',{maximumFractionDigits:2})+'×';
// The decimals a step needs (0.1 → 1, 0.001 → 3, 10 000 → 0, 1e-9 → 9).
export function stepDecimals(step){
  for(let d=0;d<20;d++){const x=step*10**d;if(Math.abs(x-Math.round(x))<=1e-9*x)return d;}
  return 20;
}
/**
 * levelDecimals(x,tick?) → the decimals a stop or a target is written with: as many as the chart gives a price of its size
 * (four significant digits, at most ten), more where the level has them, and never more than Bybit's tick (`tick`: its
 * decimals, as stepDecimals gives them) when that is known. 85 700 and 85 700,5 on BTC (tick 0,1), 120,80 on SOL (0,01),
 * 0,000005890 on SHIB (nine decimals per token, where the chart writes such a price with ten). A level off the tick (a
 * signal's) has the chart's decimals, never more than the tick's.
 */
export function levelDecimals(x,tick=null){
  const size=positive(x)?Math.min(10,Math.max(0,4-Math.floor(Math.log10(x)))):2;
  let need=10;
  for(let d=0;d<10;d++){const y=x*10**d;if(Math.abs(y-Math.round(y))<=1e-9*Math.max(1,Math.abs(y))){need=d;break;}}
  if(!(Number.isInteger(tick)&&tick>=0))return Math.max(size,need);
  return Math.min(tick,need<=tick?Math.max(size,need):size);
}
// Quantities and prices in the coin's own steps per token: a quantity to Bybit's quantity step; a fill, a price or a
// liquidation with all of the tick's decimals, as the page writes them ('60 030,0'); a stop or a target as levelDecimals
// writes it (without Bybit's filters at hand, six significant digits).
const fixedText=(x,d)=>x.toLocaleString('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d});
const qtyText=(x,f)=>x.toLocaleString('sv-SE',{maximumFractionDigits:stepDecimals(f.qtyStep)});
const tickText=(x,f)=>f?fixedText(x,stepDecimals(f.tickSize)):priceText(x);
const levelText=(x,f)=>f?fixedText(x,levelDecimals(x,stepDecimals(f.tickSize))):priceText(x);
const levelsText=(p,f)=>(p.sl===null?'':' · SL '+levelText(p.sl,f))+(p.tp===null?'':' · TP '+levelText(p.tp,f));
// Bybit's limits as parseContract returns them, read within LIMIT_TTL, for this coin.
const limitsOk=(c,symbol,now)=>!!c&&typeof c==='object'&&c.symbol===symbol&&c.contract===CONTRACTS[symbol]&&finite(c.at)&&now-c.at<=LIMIT_TTL&&c.at<=now+5000&&
  [c.min,c.max,c.step].every(positive)&&Array.isArray(c.tiers)&&c.tiers.length>0&&
  c.tiers.every(t=>t&&[t.id,t.cap,t.max,t.maintenance].every(positive)&&t.maintenance<1&&finite(t.deduction)&&t.deduction>=0);
const filtersOk=f=>!!f&&typeof f==='object'&&[f.unit,f.qtyStep,f.minQty,f.maxMktQty,f.tickSize].every(positive)&&finite(f.minNotional)&&f.minNotional>=0&&
  !!f.bybit&&[f.bybit.qtyStep,f.bybit.tickSize].every(positive)&&Number.isInteger(f.bybit.qtyDecimals)&&Number.isInteger(f.bybit.tickDecimals);
const orderFiltersOf=(c,symbol,now)=>limitsOk(c,symbol,now)&&filtersOk(c.filters)?c.filters:null;
// The result if the position closed at `level` now: the exit with slippage, the closing fee, and the funding paid so far.
function resultAt(p,level){
  const dir=DIR[p.side],exit=level*(1-dir*ACCOUNT.slip),reserve=p.reserve??0;
  return Math.max(0,p.margin+reserve+dir*(exit-p.entry)*p.units-p.units*exit*ACCOUNT.fee)-(p.margin+p.funding+reserve)-p.fees;
}
// A stop or a target as Bybit checks it (trigger on the last price), after rounding to Bybit's tick: a long's stop
// below the price and above the liquidation, its target above the price; a short's the other way round.
function levelCheck(kind,value,{side,price,liq,f}){
  if(value===null)return {value:null,reason:''};
  const name=kind==='sl'?'SL':'TP',v=positive(value)?roundPrice(f,value):NaN,dir=DIR[side],what=name+' för en '+SIDE_TEXT[side]+' position';
  if(!positive(v))return {value:null,reason:'Ange '+name+' som ett pris över 0'};
  if(kind==='sl'&&!(dir*(price-v)>0&&dir*(v-liq)>0))
    return {value:v,reason:what+' måste ligga '+(dir>0?'under':'över')+' priset ('+tickText(price,f)+') och '+(dir>0?'över':'under')+' likvidationen ('+tickText(liq,f)+')'};
  if(kind==='tp'&&!(dir*(v-price)>0))return {value:v,reason:what+' måste ligga '+(dir>0?'över':'under')+' priset ('+tickText(price,f)+')'};
  return {value:v,reason:''};
}
function manualId(a,symbol,now){
  const ids=new Set([...a.positions,...a.trades].map(x=>x.id)),base='m|'+symbol+'|'+now;
  let id=base;for(let k=2;ids.has(id);k++)id=base+'|'+k;
  return id;
}
/**
 * A market order as Bybit fills it, without changing the account. The stake is the margin; the position value is
 * margin × leverage. Leverage is rounded down to Bybit's step and may not exceed what the risk tier of the position it
 * opens allows (its value after rounding, at the mark when that is higher: the maximum drops once the value crosses a
 * tier's cap). The quantity is the value at the fill, rounded down to Bybit's quantity step, and must meet Bybit's
 * minimum quantity and order value and stay within its largest market order; the margin is then quantity × fill /
 * leverage. Bybit's order cost, the margin, the fee to open
 * and the fee to close (value × (1 ∓ 1/L) × fee, the larger for a short), which Bybit reserves with the position, must
 * fit the free cash. The liquidation price is Bybit's for an isolated position in the tier of the resulting value. A
 * stop and a target may come with the order (null or left out: none), checked as setLevels checks them. One position per
 * coin; no limit on the number of manual positions. Needs a fresh quote and Bybit's limits with their order filters.
 * params: {symbol, side:'long'|'short', margin (USDT), leverage, sl?, tp?, quote:{price,mark,at}, contract, now}
 * → {ok, reasons:[Swedish, all that apply], symbol, side, leverage, price, mark, fill, qty (tokens), value, margin, fee
 *    (to open), reserve (the fee to close, reserved), cost (margin + fee + reserve), liq, maxLeverage (Bybit's maximum
 *    for this stake), minMargin (the smallest stake, in whole cents, that meets Bybit's minimums at this leverage),
 *    maxMargin (the largest stake whose order cost on this side fits the free cash and whose position fits a risk tier
 *    that allows the leverage; null when no tier does), sl, tp (rounded to Bybit's tick),
 *    riskId, maintenance, deduction, filters}
 * What cannot be worked out yet (no fresh price, no limits) is null.
 */
export function previewOrder(a,{symbol,side,margin,leverage,sl=null,tp=null,quote,contract,now}={}){
  a=migrateForecastAccount(a);
  const dir=DIR[side],reasons=[],out={ok:false,reasons,symbol:SYMBOLS.includes(symbol)?symbol:null,side:dir?side:null,leverage:null,price:null,mark:null,fill:null,
    qty:null,value:null,margin:null,fee:null,reserve:null,cost:null,liq:null,maxLeverage:null,minMargin:null,maxMargin:null,sl:null,tp:null,riskId:null,
    maintenance:null,deduction:null,filters:null};
  const no=reason=>{reasons.push(reason);return out;};
  if(!SYMBOLS.includes(symbol))return no('Okänt par');
  if(!dir)return no('Välj köp (lång) eller sälj (kort)');
  if(!positive(now))return no('Ogiltig tid');
  if(a.positions.some(p=>p.symbol===symbol))reasons.push('Det finns redan en position i '+symbol+' — stäng den först');
  const priced=fresh(quote,now),f=orderFiltersOf(contract,symbol,now);
  if(!priced)reasons.push('Färskt pris saknas för '+symbol);
  if(!limitsOk(contract,symbol,now))reasons.push('Bybits gränser för '+symbol+' saknas eller är för gamla');
  else if(!f)reasons.push('Bybits ordergränser för '+symbol+' saknas');
  if(!positive(margin))reasons.push('Ange insatsen i $');
  if(!positive(leverage))reasons.push('Ange hävstången');
  if(!priced||!f)return out;
  const fill=quote.price*(1+dir*ACCOUNT.slip),ratio=Math.max(1,quote.mark/fill);
  Object.assign(out,{price:quote.price,mark:quote.mark,fill,filters:f});
  // maxLeverageFor without a fee: its notional is exactly margin × leverage, read at the fill and at the mark.
  try{out.maxLeverage=maxLeverageFor(contract,positive(margin)?margin:1e-9,{price:fill,mark:quote.mark},now).leverage;}catch{out.maxLeverage=null;}
  if(!positive(leverage))return out;
  const L=Number((Math.floor((leverage+1e-10)/contract.step)*contract.step).toFixed(8));
  out.leverage=L;
  if(L<contract.min-1e-8)return no('Bybits lägsta hävstång är '+leverageText(contract.min));
  const smallest=Math.max(f.minQty,ceilQty(f,f.minNotional/fill));
  out.minMargin=Math.ceil(smallest*fill/L*100-1e-6)/100;
  // Each dollar of stake costs itself, the fee to open on L dollars of value and the fee to close on L ∓ 1; and its L
  // dollars of value, at the mark when that is higher, must fit a risk tier that allows L. Null: no tier allows L.
  const room=contract.tiers.filter(t=>L<=t.max+1e-8&&L<=contract.max+1e-8).map(t=>t.cap/(L*ratio));
  out.maxMargin=room.length?Math.max(0,Math.floor(Math.min(a.cash/(1+L*ACCOUNT.fee+(L-dir)*ACCOUNT.fee),Math.max(...room))*100)/100):null;
  if(!positive(margin))return out;
  if(out.maxLeverage===null)return no('Positionen ryms inte inom Bybits risknivåer');
  const qty=floorQty(f,margin*L/fill),value=qty*fill;
  // Bybit checks the leverage against the risk tier of the position the order opens: its value after the quantity is
  // rounded down, at the mark when that is higher. Bybit's maximum for the stake (maxLeverage) names the figure.
  const tier=[...contract.tiers].sort((x,y)=>x.cap-y.cap).find(t=>value*ratio<=t.cap*(1+1e-12));
  const fits=qty>0&&!!tier&&L<=tier.max+1e-8&&L<=contract.max+1e-8,over=!fits&&L>out.maxLeverage+1e-8;
  if(over)reasons.push('Bybits högsta hävstång för den här storleken är '+leverageText(out.maxLeverage));
  Object.assign(out,{qty,value,margin:value/L,fee:value*ACCOUNT.fee,reserve:feeToClose(qty,fill,L,dir)});
  out.cost=out.margin+out.fee+out.reserve;
  if(qty<f.minQty*(1-1e-12))reasons.push('Under Bybits minsta order ('+qtyText(f.minQty,f)+' '+symbol+')');
  else if(value<f.minNotional-1e-9)reasons.push('Under Bybits minsta ordervärde ('+num(f.minNotional)+' $)');
  if(qty>f.maxMktQty*(1+1e-12))reasons.push('Över Bybits största marknadsorder ('+qtyText(f.maxMktQty,f)+' '+symbol+')');
  if(out.cost>a.cash+1e-9){
    // In whole cents: what is needed rounded up, what is free rounded down, so the two never read the same.
    const have=Math.floor(a.cash*100+1e-6)/100,need=Math.max(Math.ceil(out.cost*100-1e-6)/100,have+.01);
    reasons.push('Otillräckligt tillgängligt saldo: '+num(need)+' $ behövs, '+num(have)+' $ finns');
  }
  if(!(qty>0))return out;
  if(!fits){if(!over)reasons.push('Positionen ryms inte inom Bybits risk- och hävstångsgränser');return out;}
  Object.assign(out,{riskId:tier.id,maintenance:tier.maintenance,deduction:tier.deduction,liq:bybitIsolatedLevel(side,fill,qty,L,tier,{fee:ACCOUNT.fee})});
  if(dir*(quote.mark-out.liq)<=0)reasons.push('Markpriset ligger redan vid likvidationsnivån');
  for(const [kind,value] of [['sl',sl],['tp',tp]]){
    const r=levelCheck(kind,value===undefined?null:value,{side,price:quote.price,liq:out.liq,f});
    out[kind]=r.value;if(r.reason)reasons.push(r.reason);
  }
  out.ok=!reasons.length;
  return out;
}
// Opens exactly what previewOrder shows. A refused order leaves the account as it was (nothing is logged).
// → {account, ok, reason, position?, preview}
export function openManual(a,params={}){
  const next=own(a),now=params?.now;
  if(!positive(now))throw Error('Ogiltig tid');
  const r=previewOrder(next,params);
  if(!r.ok)return {account:validateForecastAccount(next),ok:false,reason:r.reasons[0],preview:r};
  const p={id:manualId(next,r.symbol,now),symbol:r.symbol,side:r.side,signalId:null,tf:null,entry:r.fill,units:r.qty,margin:r.margin,leverage:r.leverage,
    maintenance:r.maintenance,deduction:r.deduction,riskId:r.riskId,sl:r.sl,tp:r.tp,liq:r.liq,openedAt:now,deadline:null,fees:r.fee,reserve:r.reserve,funding:0,
    nextBar:(Math.floor(now/ACCOUNT.step)+1)*ACCOUNT.step,fundingThrough:now,equityAtOpen:realized(next),origin:'manual',levelsAt:now};
  next.cash-=r.cost;
  // previewOrder keeps the order cost within cash; only rounding can dip below zero.
  if(next.cash<0&&next.cash>-1e-9)next.cash=0;
  next.fees+=r.fee;next.positions.push(p);
  log(next,{t:now,kind:'öppnad',symbol:p.symbol,signalId:null,text:'Öppnade '+SIDE_TEXT[p.side]+' '+qtyText(p.units,r.filters)+' '+p.symbol+' till '+tickText(p.entry,r.filters)+' · '+
    leverageText(p.leverage)+' · marginal '+num(p.margin)+' $'+levelsText(p,r.filters)+' (manuell)'});
  return {account:validateForecastAccount(next),ok:true,reason:'',position:{...p},preview:r};
}
/**
 * New levels for an open position, checked as Bybit checks a stop and a target set on a position, without changing
 * the account. levels: {sl?, tp?}: a key left out keeps that level, null removes it, a price sets it (rounded to
 * Bybit's tick, so a level needs Bybit's limits; removing one does not). A level sent back as the position has it, or
 * within half of Bybit's tick of it (a signal's level is off the tick), is unchanged. Checked against the last price and
 * the position's liquidation price now.
 * → {ok, reasons, changed, sl, tp (the levels after the change), price, liq, slPnl, tpPnl (the result if the position
 *    closed at that level now, after slippage, the closing fee and the funding so far; null without a level)}
 */
export function previewLevels(a,id,levels,{quote,contract,now}={}){
  a=migrateForecastAccount(a);
  const p=a.positions.find(x=>x.id===id),reasons=[];
  const out={ok:false,reasons,changed:false,sl:p?p.sl:null,tp:p?p.tp:null,price:null,liq:p?p.liq:null,slPnl:null,tpPnl:null};
  const no=reason=>{reasons.push(reason);return out;};
  if(!p)return no('Positionen är redan stängd');
  if(!levels||typeof levels!=='object'||Array.isArray(levels))return no('Ange SL eller TP');
  const unknown=Object.keys(levels).find(k=>k!=='sl'&&k!=='tp');
  if(unknown)return no('Okänd nivå: '+unknown);
  if(levels.sl===undefined&&levels.tp===undefined)return no('Ange SL eller TP');
  // Any fresh price will do, also the one the order filled at: Bybit stamped it before the order was written.
  if(!positive(now)||!fresh(quote,now))return no('Färskt pris saknas för '+p.symbol);
  out.price=quote.price;
  const f=orderFiltersOf(contract,p.symbol,now);
  const kept=kind=>{const v=levels[kind],was=p[kind];return v===was||!!f&&positive(v)&&positive(was)&&Math.abs(v-was)<=f.tickSize/2;};
  const asked=['sl','tp'].filter(kind=>levels[kind]!==undefined&&!kept(kind));
  if(!f&&asked.some(kind=>levels[kind]!==null))return no('Bybits prissteg för '+p.symbol+' saknas just nu');
  for(const kind of asked){
    const r=levelCheck(kind,levels[kind],{side:p.side,price:quote.price,liq:p.liq,f});
    out[kind]=r.value;if(r.reason)reasons.push(r.reason);
  }
  out.changed=out.sl!==p.sl||out.tp!==p.tp;
  out.slPnl=out.sl===null?null:resultAt(p,out.sl);out.tpPnl=out.tp===null?null:resultAt(p,out.tp);
  out.ok=!reasons.length;
  return out;
}
/**
 * Sets the levels previewLevels accepts, from `now` on. The position must have been settled with its old levels up to
 * now (within ACCOUNT.quoteTtl): prices before the change were checked against them. levelsAt becomes now, and the
 * next replay goes through the 5-minute step of the change with 1-minute candles (the new stop and target from the
 * minute after it, the liquidation on every minute), then 5-minute candles. A signal position whose levels change
 * becomes manual: no time stop and no exit on an opposite signal. Unchanged levels change nothing.
 * → {account, ok, changed, reason, position, preview}
 */
export function setLevels(a,id,levels,{quote,contract,now}={}){
  const next=own(a);
  if(!positive(now))throw Error('Ogiltig tid');
  const r=previewLevels(next,id,levels,{quote,contract,now}),p=next.positions.find(x=>x.id===id),f=p?orderFiltersOf(contract,p.symbol,now):null;
  const result=(ok,changed,reason)=>({account:validateForecastAccount(next),ok,changed,reason,position:p?{...p}:null,preview:r});
  if(!r.ok)return result(false,false,r.reasons[0]);
  if(now-p.fundingThrough>ACCOUNT.quoteTtl)return result(false,false,'Positionen i '+p.symbol+' är inte avräknad just nu — försök igen');
  if(p.deadline!==null&&now>=p.deadline)return result(false,false,'Tidsstoppet för '+p.symbol+' har redan passerat');
  if(!r.changed)return result(true,false,'');
  const converted=p.origin==='signal';
  p.sl=r.sl;p.tp=r.tp;p.levelsAt=now;
  p.nextBar=Math.max(p.nextBar,(Math.floor(now/ACCOUNT.step)+1)*ACCOUNT.step);
  if(converted){p.origin='manual';p.deadline=null;}
  log(next,{t:now,kind:'ändrad',symbol:p.symbol,signalId:p.signalId,text:'Nya nivåer för '+SIDE_TEXT[p.side]+' '+p.symbol+': '+
    (p.sl===null?'ingen SL':'SL '+levelText(p.sl,f))+', '+(p.tp===null?'ingen TP':'TP '+levelText(p.tp,f))+
    (converted?' — signalpositionen hanteras nu manuellt, utan tidsstopp':' (manuell)')});
  return result(true,true,'');
}

// ---- Deposits and withdrawals ---------------------------------------------------------------------------------
// An amount as the user enters it: over 0, at most ACCOUNT.transferMax, in whole cents.
function amountOf(x){
  if(!finite(x)||x<=0)throw Error('Ange ett belopp över 0 $');
  if(x>ACCOUNT.transferMax)throw Error('Högst '+num(ACCOUNT.transferMax,0)+' $ per insättning eller uttag');
  if(Math.abs(x*100-Math.round(x*100))>1e-6)throw Error('Ange beloppet i hela cent');
  return Math.round(x*100)/100;
}
function transfer(next,kind,amount,now,cashAfter=next.cash+(kind==='in'?amount:-amount)){
  // Withdrawing all free cash may leave a rounding residue below zero.
  next.cash=cashAfter<0&&cashAfter>-1e-9?0:cashAfter;
  next.transfers.push({id:'t|'+(next.transfers.length+1)+'|'+now,t:now,kind,amount,cashAfter:next.cash,tradeCount:next.trades.length});
  log(next,{t:now,kind:kind==='in'?'insättning':'uttag',symbol:null,signalId:null,text:(kind==='in'?'Insättning ':'Uttag ')+num(amount)+' $'});
  return validateForecastAccount(next);
}
// Adds to the free cash. A deposit is no trading result: accountStats and accountLive keep it apart.
export function deposit(a,amount,now){
  const next=own(a);
  if(!positive(now))throw Error('Ogiltig tid');
  return transfer(next,'in',amountOf(amount),now);
}
// Takes from the free cash only, never from the margin of open positions. The free cash as the page shows it, in whole
// cents, can be taken out: an amount less than half a cent over the free cash (fees leave it in fractions of a cent)
// takes all of it, and books what there was.
export function withdraw(a,amount,now){
  const next=own(a);
  if(!positive(now))throw Error('Ogiltig tid');
  const x=amountOf(amount);
  if(x>next.cash+.005+1e-9)throw Error('Det går bara att ta ut tillgängligt saldo (högst '+num(next.cash)+' $), inte marginalen i öppna positioner');
  return x>next.cash?transfer(next,'out',next.cash,now,0):transfer(next,'out',x,now);
}
// Deposits or withdraws the difference so the free cash becomes `target` (whole cents, 0 $ or more).
export function setFree(a,target,now){
  const next=own(a);
  if(!positive(now))throw Error('Ogiltig tid');
  if(!finite(target)||target<0)throw Error('Ange ett tillgängligt saldo på 0 $ eller mer');
  if(Math.abs(target*100-Math.round(target*100))>1e-6)throw Error('Ange beloppet i hela cent');
  const goal=Math.round(target*100)/100,diff=goal-next.cash;
  if(Math.abs(diff)<.005)throw Error('Tillgängligt saldo är redan '+num(next.cash)+' $');
  if(Math.abs(diff)>ACCOUNT.transferMax)throw Error('Högst '+num(ACCOUNT.transferMax,0)+' $ per insättning eller uttag');
  return transfer(next,diff>0?'in':'out',Math.abs(diff),now,goal);
}

// Isolated margin: a close returns the margin (and a manual order's reserved fee to close) plus the result after the
// closing fee, never less than zero; a liquidation returns nothing. Bybit liquidates at the bankruptcy price, where a
// manual order's reserved fee to close pays the closing fee. A manual order's trade records its initial margin and the
// reserve; a signal position's the margin it opened with.
function closeAt(a,p,price,at,reason){
  const dir=DIR[p.side],liquidated=reason==='likvidation',reserve=p.reserve??0,closeFee=liquidated?reserve:p.units*price*ACCOUNT.fee;
  const proceeds=liquidated?0:Math.max(0,p.margin+reserve+dir*(price-p.entry)*p.units-closeFee),pnl=proceeds-(p.margin+p.funding+reserve)-p.fees;
  a.positions=a.positions.filter(x=>x.id!==p.id);a.cash+=proceeds;a.fees+=closeFee;
  const trade={id:p.id,symbol:p.symbol,side:p.side,signalId:p.signalId,tf:p.tf,entry:p.entry,exit:price,units:p.units,margin:bybitMargined(p)?stake(p):p.margin+p.funding,
    leverage:p.leverage,openedAt:p.openedAt,closedAt:at,reason,pnl,fees:p.fees+closeFee,funding:p.funding,equityAfter:realized(a),origin:p.origin};
  if(bybitMargined(p))trade.reserve=reserve;
  a.trades.push(trade);
  log(a,{t:at,kind:'stängd',symbol:p.symbol,signalId:p.signalId,text:tradeReasons[reason]+': '+SIDE_TEXT[p.side]+' '+p.symbol+' '+signed(pnl)+marked(p)});
  return a;
}
// risk.through, when present: a window of a long absence, its closed 5-minute candles before that boundary.
function checkRisk(r,p,now){
  const step=ACCOUNT.step,bar=(b,n=step)=>!!b&&finite(b.t)&&b.t%n===0&&[b.o,b.h,b.l,b.c].every(positive)&&b.h>=Math.max(b.o,b.c,b.l)&&b.l<=Math.min(b.o,b.c);
  const window=r?.through!==undefined;
  if(!r||!Array.isArray(r.markBars)||!Array.isArray(r.lastBars)||!Array.isArray(r.funding)||!finite(r.historyFrom)||
    r.historyFrom>Math.min(p.nextBar,Math.floor(p.fundingThrough/step)*step)||!finite(r.fundingThrough)||
    (window?!(finite(r.through)&&r.through%step===0&&r.through<=Math.floor(now/step)*step&&r.fundingThrough===r.through-step):r.fundingThrough<now-RISK_TTL)||
    r.fundingThrough<p.fundingThrough||!positive(r.price)||!positive(r.mark)||!finite(r.at)||r.at>now+5000||now-r.at>RISK_TTL)
    throw Error('Markpris- eller fundinghistorik saknas för '+p.symbol);
  if(!r.markBars.every(b=>bar(b))||!r.lastBars.every(b=>bar(b)))throw Error('Ogiltiga 5-minuterspriser för '+p.symbol);
  if([r.minuteMarks,r.minuteLasts].some(x=>x!=null&&(!Array.isArray(x)||!x.every(b=>bar(b,MIN)))))throw Error('Ogiltiga 1-minuterspriser för '+p.symbol);
  if(r.funding.some((f,i)=>!f||!finite(f.t)||f.t%step||!finite(f.rate)||i&&f.t<=r.funding[i-1].t))throw Error('Ogiltig fundinghistorik för '+p.symbol);
}
/**
 * Replays the 5-minute bars since the last check, in time order. Funding
 * settles at its timestamp on that bar's mark open and is paid out of the
 * position margin, which moves the liquidation level; a manual order's is
 * paid from the free cash first, as Bybit takes it, and only what the cash
 * lacks comes out of its margin (funding received goes to the free cash).
 * Within a bar the adverse event wins: liquidation on mark first, then the
 * stop on last price (a gap past it fills at the open), then the target; a
 * missing stop or target is skipped. At the first bar on or after the
 * deadline the position closes at that bar's open, so a long absence cannot
 * stretch a trade past its holding time; a manual position has no deadline.
 * The 5-minute bar of the step the position opened in also holds prices from
 * before the entry, and the bar of the step its levels changed in holds prices
 * from before the change, so until the first full bar after the later of the two
 * (openedAt, levelsAt) is settled that step is replayed first, the same way, with
 * Bybit's 1-minute candles (risk.minuteMarks, risk.minuteLasts): the liquidation
 * on every minute of the step after the opening, since it does not depend on
 * the levels, and the stop and the target on the minutes after the later of
 * the two. Every closed minute is needed, the forming one is checked when Bybit
 * has it.
 * A long absence is settled in windows (risk.through, see fetchPositionRisk):
 * the closed bars before that boundary and the funding due before it, after
 * which nextBar is the boundary and the rest waits for the next window.
 */
export function settlePosition(a,id,risk,now){
  const next=own(a),p=next.positions.find(x=>x.id===id);
  if(!p)return next;
  if(!positive(now)||now<p.openedAt)throw Error('Ogiltig tid för riskkontrollen');
  checkRisk(risk,p,now);
  const step=ACCOUNT.step,dir=DIR[p.side],window=risk.through!==undefined;
  const current=window?risk.through-step:Math.floor(now/step)*step,through=window?risk.through-step:Math.min(now,risk.fundingThrough);
  const marks=new Map(risk.markBars.map(b=>[b.t,b])),lasts=new Map(risk.lastBars.map(b=>[b.t,b]));
  const due=risk.funding.filter(f=>f.t>p.fundingThrough&&f.t<=through);let fi=0;
  const charge=until=>{
    while(fi<due.length&&due[fi].t<=until){
      const f=due[fi++],m=marks.get(f.t);if(!m)throw Error('Markpris vid funding saknas för '+p.symbol);
      const cost=dir*p.units*m.o*f.rate,paid=bybitMargined(p)?Math.min(cost,next.cash):0;
      next.cash-=paid;p.margin-=cost-paid;p.funding+=cost;next.funding+=cost;
      if(cost!==paid)p.liq=levelOf(p);
    }
  };
  const fill=level=>level*(1-dir*ACCOUNT.slip),worst=b=>dir>0?b.l:b.h,best=b=>dir>0?b.h:b.l;
  const exit=(price,at,reason)=>validateForecastAccount(closeAt(next,p,price,at,reason));
  const sl=p.sl!==null,tp=p.tp!==null;
  const inside=(m,l,t,end)=>dir*(worst(m)-p.liq)<=0?exit(p.liq,end,'likvidation'):sl&&dir*(l.o-p.sl)<=0?exit(fill(l.o),t,'stopp'):
    sl&&dir*(worst(l)-p.sl)<=0?exit(fill(p.sl),end,'stopp'):tp&&dir*(best(l)-p.tp)>=0?exit(fill(p.tp),dir*(l.o-p.tp)>=0?t:end,'mål'):null;
  // Funding times are 5-minute boundaries, so none falls inside that step after its start.
  const from=Math.max(p.openedAt,p.levelsAt),first=(Math.floor(from/step)+1)*step,levelsFrom=Math.ceil(from/MIN)*MIN;
  if(p.nextBar===first){
    const mm=new Map((risk.minuteMarks??[]).map(b=>[b.t,b])),ml=new Map((risk.minuteLasts??[]).map(b=>[b.t,b])),forming=Math.floor(now/MIN)*MIN;
    for(let t=Math.max(first-step,Math.ceil(p.openedAt/MIN)*MIN);t<first&&t<=forming;t+=MIN){
      const m=mm.get(t),l=t>=levelsFrom?ml.get(t):null;
      if(!m||t>=levelsFrom&&!l){if(t===forming)break;throw Error('Lucka i 1-minuterspriserna för '+p.symbol);}
      if(dir*(m.o-p.liq)<=0)return exit(m.o,t,'likvidation');
      const end=Math.min(now,t+MIN);
      // Before the levels took effect only the liquidation counts.
      if(!l){if(dir*(worst(m)-p.liq)<=0)return exit(p.liq,end,'likvidation');continue;}
      const done=inside(m,l,t,end);if(done)return done;
    }
  }
  for(let t=p.nextBar;t<=current;t+=step){
    const m=marks.get(t),l=lasts.get(t),end=Math.min(now,t+step);
    if(!m||!l)throw Error('Lucka i 5-minuterspriserna för '+p.symbol);
    charge(t);
    if(dir*(m.o-p.liq)<=0)return exit(m.o,t,'likvidation');
    if(p.deadline!==null&&t>=p.deadline){
      if(sl&&dir*(l.o-p.sl)<=0)return exit(fill(l.o),t,'stopp');
      if(tp&&dir*(l.o-p.tp)>=0)return exit(fill(p.tp),t,'mål');
      return exit(fill(l.o),t,'tid');
    }
    const done=inside(m,l,t,end);if(done)return done;
    // The forming bar is checked but stays pending until it has closed.
    if(t+step<=now)p.nextBar=t+step;
  }
  charge(through);
  p.fundingThrough=Math.max(p.fundingThrough,through);
  // A window ends before now: a time stop after it is reached at its own candle in a later window.
  if(!window&&p.deadline!==null&&now>=p.deadline)return exit(fill(risk.price),now,'tid');
  return validateForecastAccount(next);
}
/**
 * Live protection between settlements. Acts only on a fresh quote taken after
 * the open and only while the last settlement is recent: an older gap is
 * replayed bar by bar by settlePosition first, in time order. Nor does it act
 * once a whole hour (Bybit's funding times are whole hours) has passed since
 * the last settlement: a funding due before the exit is charged by
 * settlePosition, which knows its rate and the mark it is charged at. A stop
 * fills at its level, or at the quote when the price already jumped past it.
 * Levels apply only to quotes taken after they were set (levelsAt); a missing
 * stop or target is skipped. From the deadline on it does nothing:
 * settlePosition ends the trade at the deadline candle's open, as a replay after
 * a reload would.
 */
export function checkQuote(a,id,quote,now){
  const next=own(a),p=next.positions.find(x=>x.id===id);
  if(!p||!positive(now)||!fresh(quote,now)||quote.at<p.openedAt||now<p.openedAt||now-p.fundingThrough>RISK_TTL||
    p.deadline!==null&&Math.max(now,quote.at)>=p.deadline||Math.floor(now/HOUR)*HOUR>p.fundingThrough)return next;
  const dir=DIR[p.side],fill=level=>level*(1-dir*ACCOUNT.slip);
  if(dir*(quote.mark-p.liq)<=0)return validateForecastAccount(closeAt(next,p,p.liq,now,'likvidation'));
  if(quote.at<p.levelsAt)return next;
  if(p.sl!==null&&dir*(quote.price-p.sl)<=0)return validateForecastAccount(closeAt(next,p,fill(dir>0?Math.min(quote.price,p.sl):Math.max(quote.price,p.sl)),now,'stopp'));
  if(p.tp!==null&&dir*(quote.price-p.tp)>=0)return validateForecastAccount(closeAt(next,p,fill(p.tp),now,'mål'));
  return next;
}
// A manual position closes only on its stop, its target, liquidation or the user's close ('manuell').
export function closePosition(a,id,{price,now,reason}={}){
  const next=own(a);
  if(!CLOSE_REASONS.includes(reason))throw Error('Ogiltig orsak till stängning');
  if(!positive(price))throw Error('Färskt pris saknas för stängningen');
  const p=next.positions.find(x=>x.id===id);
  if(!p)throw Error('Positionen är redan stängd');
  if(!positive(now)||now<p.openedAt)throw Error('Ogiltig tid för stängningen');
  if(p.origin==='manual'&&reason!=='manuell')throw Error('En manuell position stängs bara av SL, TP, likvidation eller Stäng');
  return validateForecastAccount(closeAt(next,p,price*(1-DIR[p.side]*ACCOUNT.slip),now,reason));
}

// Value if closed at the quote now: slippage and the closing fee included, never below zero (a manual order's position
// also returns its reserved fee to close). pnl: that value less what the position cost, its pnlPct of the margin it
// opened with. marginUsed: what the positions hold, their margin and the reserved fees to close.
// netTransfers: deposits less withdrawals; result: the equity less the start and the net transfers, the trading
// result since the start including open positions (null while the equity is).
export function accountLive(a,quotes,now){
  a=migrateForecastAccount(a);
  const positions=[],stale=[],unsettled=[];let value=0,openPnl=0,at=null;
  for(const p of a.positions){
    const q=quotes?.[p.symbol],ok=fresh(q,now),dir=DIR[p.side];
    const row={...p,price:null,mark:null,value:null,pnl:null,pnlPct:null,toLiq:null,toSl:null,toTp:null};
    if(ok)Object.assign(row,{price:q.price,mark:q.mark,toLiq:dir*(q.mark-p.liq)/q.mark,toSl:p.sl===null?null:dir*(q.price-p.sl)/q.price,
      toTp:p.tp===null?null:dir*(p.tp-q.price)/q.price});
    if(!ok)stale.push(p.symbol);
    else if(now-p.fundingThrough>RISK_TTL)unsettled.push(p.symbol);
    else{
      const exit=q.price*(1-dir*ACCOUNT.slip),reserve=p.reserve??0,opened=bybitMargined(p)?stake(p):p.margin+p.funding;
      const v=dir*(q.mark-p.liq)<=0?0:Math.max(0,p.margin+reserve+dir*(exit-p.entry)*p.units-p.units*exit*ACCOUNT.fee),pnl=v-(p.margin+p.funding+reserve)-p.fees;
      Object.assign(row,{value:v,pnl,pnlPct:pnl/opened});
      value+=v;openPnl+=row.pnl;at=at===null?q.at:Math.min(at,q.at);
    }
    positions.push(row);
  }
  const waiting=[...stale,...unsettled],done=!waiting.length,equity=done?a.cash+value:null,netTransfers=sum(a.transfers,flow);
  return {equity,cash:a.cash,marginUsed:sum(a.positions,inPosition),openPnl:done?openPnl:null,positions,waiting,at:done?at:null,
    reason:stale.length?'Väntar på färskt pris för '+stale.join(', '):unsettled.length?'Väntar på funding- och likvidationskontroll för '+unsettled.join(', '):'',
    netTransfers,result:equity===null?null:equity-a.start-netTransfers};
}
/**
 * Closed trades' measures. Win rate, profit factor, net, best and worst come from the trades alone. Max drawdown is
 * measured on realized equity (trade.equityAfter) net of deposits and withdrawals: the curve is scaled at each
 * transfer so that the transfer moves it neither up nor down (a time-weighted curve), so a deposit is no gain and
 * a withdrawal no drawdown. Without transfers it is the realized equity itself, from the start.
 * deposits, withdrawals and netTransfers (deposits less withdrawals) in USDT.
 */
export function accountStats(a){
  a=migrateForecastAccount(a);
  const t=a.trades,pnl=t.map(x=>x.pnl),gain=sum(pnl.filter(x=>x>0),x=>x),loss=-sum(pnl.filter(x=>x<0),x=>x),tr=a.transfers;
  let peak=a.start,maxDrawdown=0,prev=a.start,scale=1,k=0;
  for(let i=0;i<t.length;i++){
    // Transfers made after the trades before this one and before this one closed.
    let moved=0;while(k<tr.length&&tr[k].tradeCount<=i)moved+=flow(tr[k++]);
    // An account emptied before the transfer stays emptied on this curve: nothing it lost is won back by new money.
    if(moved!==0&&prev+moved>0)scale*=Math.max(0,prev)/(prev+moved);
    const x=t[i].equityAfter*scale;prev=t[i].equityAfter;
    peak=Math.max(peak,x);maxDrawdown=Math.max(maxDrawdown,(peak-x)/peak);
  }
  const wins=pnl.filter(x=>x>0).length,deposits=sum(tr.filter(x=>x.kind==='in'),x=>x.amount),withdrawals=sum(tr.filter(x=>x.kind==='out'),x=>x.amount);
  return {trades:t.length,wins,losses:pnl.filter(x=>x<0).length,winRate:t.length?wins/t.length:null,net:sum(pnl,x=>x),fees:a.fees,funding:a.funding,
    liquidations:t.filter(x=>x.reason==='likvidation').length,profitFactor:loss>0?gain/loss:null,maxDrawdown,
    best:t.length?pnl.reduce((m,x)=>Math.max(m,x)):null,worst:t.length?pnl.reduce((m,x)=>Math.min(m,x)):null,open:a.positions.length,
    deposits,withdrawals,netTransfers:deposits-withdrawals};
}
