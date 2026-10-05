// AI Forecast demo account: its own 100 $ ledger, separate from every other
// demo account, trading Bybit's linear USDT perpetuals long and short with
// isolated margin, at Bybit's maximum leverage unless the user picks less.
// Pure functions on JSON state: no network, no clock, no orders. Every
// function copies its input and validates what it returns.
// openPosition returns {account,opened,reason,position?}; settlePosition,
// checkQuote, closePosition, updateSettings, setPaused and markProcessed
// return the new account (a close appends to account.trades).
import {SYMBOLS,TF,CHART_TFS,SIGNAL_PARAMS} from './forecast-config.js';
import {CONTRACTS,LIMIT_TTL,maxLeverageFor,isolatedLevel} from './bybit-contracts.js';

// liqBuffer: how far beyond the stop (a share of the entry price) Bybit's liquidation must lie for the stop to count as
// the first exit when sizing; it covers Bybit's ordinary funding (0.01 % per 8 h) over the longest hold, 20 days.
export const ACCOUNT=Object.freeze({version:'ai-forecast-account-v1',start:100,fee:.00055,slip:.0005,step:300000,
  quoteTtl:15000,logLimit:500,minMargin:.01,minRR:1,maxSignalAge:1800000,liqBuffer:.01,
  defaults:Object.freeze({tf:'1h',symbols:SYMBOLS,positionPct:.25,riskPct:.10,maxOpen:3,leverage:'max',paused:false})});
export const SETTING_LIMITS=Object.freeze({positionPct:Object.freeze([.01,1]),riskPct:Object.freeze([.001,1]),maxOpen:Object.freeze([1,7]),leverage:Object.freeze([1,200])});
export const accountKey=uid=>'riptide.forecast.v1:'+encodeURIComponent(uid);
export const tradeReasons=Object.freeze({stopp:'Stopp',mål:'Mål',likvidation:'Likvidation',tid:'Tidsstopp',manuell:'Stängd manuellt',signal:'Motsatt signal',slut:'Periodens slut'});

// No prototype: a stored side such as '__proto__' or 'constructor' must not count as a direction.
const DIR=Object.freeze(Object.assign(Object.create(null),{long:1,short:-1}));
const SIDE_TEXT=Object.freeze({long:'lång',short:'kort'});
const CLOSE_REASONS=Object.freeze(['manuell','signal','tid','slut']);
const LOG_KINDS=Object.freeze(['öppnad','avvisad','stängd']);
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
const realized=a=>a.cash+sum(a.positions,p=>p.margin);
// Bybit's isolated liquidation price for the margin the position holds now.
// isolatedLevel takes margin plus the opening fee and deducts that fee itself.
const levelOf=p=>isolatedLevel(p.side,p.entry,p.margin+p.units*p.entry*ACCOUNT.fee,p.units,ACCOUNT.fee,p);

function checkSettings(s){
  const keys=Object.keys(ACCOUNT.defaults),L=SETTING_LIMITS;
  if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).length!==keys.length||!keys.every(k=>Object.hasOwn(s,k)))throw Error('Ogiltiga inställningar för AI Forecast');
  if(!CHART_TFS.includes(s.tf))throw Error('Okänd tidsram');
  if(!Array.isArray(s.symbols)||!s.symbols.length)throw Error('Välj minst ett par att handla');
  if(!s.symbols.every(x=>SYMBOLS.includes(x))||new Set(s.symbols).size!==s.symbols.length)throw Error('Ogiltiga par: '+s.symbols.join(', '));
  if(!within(s.positionPct,L.positionPct))throw Error('Positionsstorleken ska vara '+pctText(L.positionPct[0])+'–'+pctText(L.positionPct[1])+' av kapitalet');
  if(!within(s.riskPct,L.riskPct))throw Error('Risken per affär ska vara '+pctText(L.riskPct[0])+'–'+pctText(L.riskPct[1])+' av kapitalet');
  if(!Number.isInteger(s.maxOpen)||!within(s.maxOpen,L.maxOpen))throw Error('Max öppna positioner ska vara '+L.maxOpen[0]+'–'+L.maxOpen[1]);
  if(s.leverage!=='max'&&!within(s.leverage,L.leverage))throw Error('Hävstången ska vara Bybits max eller '+L.leverage[0]+'–'+L.leverage[1]+'×');
  if(typeof s.paused!=='boolean')throw Error('Ogiltigt pausläge');
  return s;
}
const normalized=s=>({...s,symbols:SYMBOLS.filter(x=>s.symbols.includes(x))});
function checkPosition(p){
  const dir=DIR[p?.side];
  if(!p||typeof p.id!=='string'||!p.id||!SYMBOLS.includes(p.symbol)||!dir||typeof p.signalId!=='string'||!p.signalId||!CHART_TFS.includes(p.tf)||
    ![p.entry,p.units,p.leverage,p.sl,p.tp,p.openedAt,p.deadline,p.nextBar,p.fundingThrough,p.equityAtOpen,p.riskId].every(positive)||
    !finite(p.margin)||!finite(p.funding)||!positive(p.margin+p.funding)||!finite(p.fees)||p.fees<0||!finite(p.maintenance)||p.maintenance<=0||p.maintenance>=1||
    !finite(p.deduction)||p.deduction<0||!finite(p.liq)||p.liq<0||p.nextBar%ACCOUNT.step||p.nextBar<=p.openedAt||p.fundingThrough<p.openedAt||p.deadline<=p.openedAt||
    dir*(p.entry-p.sl)<=0||dir*(p.tp-p.entry)<=0)throw Error('Ogiltig AI Forecast-position');
  if(Math.abs(p.liq-levelOf(p))>1e-9*p.entry)throw Error('Likvidationsnivån för '+p.symbol+' stämmer inte med marginalen');
}
function checkTrade(t){
  if(!t||typeof t.id!=='string'||!t.id||!SYMBOLS.includes(t.symbol)||!DIR[t.side]||typeof t.signalId!=='string'||!t.signalId||!CHART_TFS.includes(t.tf)||
    ![t.entry,t.exit,t.units,t.margin,t.leverage,t.openedAt,t.closedAt].every(positive)||t.closedAt<t.openedAt||!Object.hasOwn(tradeReasons,t.reason)||
    !finite(t.pnl)||!finite(t.fees)||t.fees<0||!finite(t.funding)||!finite(t.equityAfter)||t.pnl<-(t.margin+t.fees)*(1+1e-9))
    throw Error('Ogiltig AI Forecast-affär');
}
function checkLog(e){
  if(!e||!positive(e.t)||!LOG_KINDS.includes(e.kind)||typeof e.text!=='string'||!e.text||!(e.symbol===null||SYMBOLS.includes(e.symbol))||
    !(e.signalId===null||typeof e.signalId==='string'))throw Error('Ogiltig logg i AI Forecast-kontot');
}
export function validateForecastAccount(a){
  // A page loaded before a deploy can meet a newer stored format: say so instead of failing silently.
  if(typeof a?.version==='string'&&a.version!==ACCOUNT.version&&a.version.startsWith('ai-forecast-account-'))
    throw Error('AI Forecast-kontot har en annan version ('+a.version+'). Ladda om sidan.');
  if(!a||typeof a!=='object'||a.version!==ACCOUNT.version||!positive(a.createdAt)||!positive(a.start)||!finite(a.cash)||a.cash<0||
    !finite(a.fees)||a.fees<0||!finite(a.funding)||!Array.isArray(a.positions)||!Array.isArray(a.trades)||!Array.isArray(a.log)||
    !a.processed||typeof a.processed!=='object'||Array.isArray(a.processed))throw Error('Ogiltigt AI Forecast-konto');
  checkSettings(a.settings);
  a.positions.forEach(checkPosition);a.trades.forEach(checkTrade);
  if(a.log.length>ACCOUNT.logLimit)throw Error('AI Forecast-loggen är för lång');
  a.log.forEach(checkLog);
  for(const [symbol,t] of Object.entries(a.processed))if(!SYMBOLS.includes(symbol)||!(t===null||positive(t)))throw Error('Ogiltig bearbetningsmarkering för '+symbol);
  const held=a.positions.map(p=>p.symbol),both=[...a.positions,...a.trades];
  if(new Set(held).size!==held.length)throw Error('Högst en position per par');
  if(new Set(both.map(x=>x.id)).size!==both.length||new Set(both.map(x=>x.signalId)).size!==both.length)throw Error('Samma signal är handlad två gånger');
  // The ledger reconciles: the start plus realized results, minus what open positions locked up.
  const cash=a.start+sum(a.trades,t=>t.pnl)-sum(a.positions,p=>p.margin+p.funding+p.fees);
  if(!same(a.cash,cash)||!same(a.fees,sum(a.trades,t=>t.fees)+sum(a.positions,p=>p.fees))||!same(a.funding,sum(a.trades,t=>t.funding)+sum(a.positions,p=>p.funding)))
    throw Error('AI Forecast-kontots kassa stämmer inte');
  return a;
}
export function newForecastAccount(now,settings={}){
  if(!positive(now))throw Error('Ogiltig starttid');
  const s=checkSettings({...ACCOUNT.defaults,...settings});
  return validateForecastAccount({version:ACCOUNT.version,createdAt:now,start:ACCOUNT.start,cash:ACCOUNT.start,settings:normalized(s),
    positions:[],trades:[],log:[],processed:{},fees:0,funding:0});
}
export function readForecastAccount(storage,key,now){
  const raw=storage.getItem(key);if(raw===null||raw===undefined)return newForecastAccount(now);
  let a;try{a=JSON.parse(raw);}catch{throw Error('AI Forecast-kontot kan inte läsas');}
  return validateForecastAccount(a);
}
export function updateSettings(a,patch){
  validateForecastAccount(a);
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('Ogiltiga inställningar för AI Forecast');
  const unknown=Object.keys(patch).find(k=>!Object.hasOwn(ACCOUNT.defaults,k));
  if(unknown)throw Error('Okänd inställning: '+unknown);
  const next=structuredClone(a),s=checkSettings({...next.settings,...structuredClone(patch)});
  next.settings=normalized(s);
  // Bar times from another timeframe say nothing about the new one.
  if(s.tf!==a.settings.tf)next.processed={};
  return validateForecastAccount(next);
}
export function setPaused(a,paused){
  if(typeof paused!=='boolean')throw Error('Ogiltigt pausläge');
  return updateSettings(a,{paused});
}
// The runner's record of the last bar it evaluated for entries in this symbol; only moves forward.
export function markProcessed(a,symbol,t){
  validateForecastAccount(a);
  if(!SYMBOLS.includes(symbol)||!positive(t))throw Error('Ogiltig bearbetningsmarkering');
  const next=structuredClone(a);next.processed[symbol]=Math.max(next.processed[symbol]??0,t);
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

export function openPosition(a,{signal,symbol,quote,contract,now,tfMs,dataReliable}={}){
  validateForecastAccount(a);
  if(!positive(now))throw Error('Ogiltig tid');
  const next=structuredClone(a),s=next.settings,signalId=typeof signal?.id==='string'&&signal.id?signal.id:null;
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
  if(next.positions.length>=s.maxOpen)return reject('Max antal öppna positioner är nått ('+s.maxOpen+')');
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
    fees:plan.openFee,funding:0,nextBar:(Math.floor(now/ACCOUNT.step)+1)*ACCOUNT.step,fundingThrough:now,equityAtOpen:equity};
  next.cash-=plan.margin+plan.openFee;
  // The sizing keeps margin plus fee within cash; only rounding can dip below zero.
  if(next.cash<0&&next.cash>-1e-9)next.cash=0;
  next.fees+=plan.openFee;next.positions.push(p);
  log(next,{t:now,kind:'öppnad',symbol,signalId,text:'Öppnade '+SIDE_TEXT[p.side]+' '+symbol+' till '+priceText(p.entry)+' · '+
    p.leverage.toLocaleString('sv-SE',{maximumFractionDigits:2})+'× · marginal '+num(p.margin)+' $'});
  return {account:validateForecastAccount(next),opened:true,reason:'',position:{...p}};
}

// Isolated margin: a close returns the margin plus the result after the
// closing fee, never less than zero; a liquidation returns nothing.
function closeAt(a,p,price,at,reason){
  const dir=DIR[p.side],liquidated=reason==='likvidation',closeFee=liquidated?0:p.units*price*ACCOUNT.fee;
  const proceeds=liquidated?0:Math.max(0,p.margin+dir*(price-p.entry)*p.units-closeFee),marginOpen=p.margin+p.funding,pnl=proceeds-marginOpen-p.fees;
  a.positions=a.positions.filter(x=>x.id!==p.id);a.cash+=proceeds;a.fees+=closeFee;
  a.trades.push({id:p.id,symbol:p.symbol,side:p.side,signalId:p.signalId,tf:p.tf,entry:p.entry,exit:price,units:p.units,margin:marginOpen,
    leverage:p.leverage,openedAt:p.openedAt,closedAt:at,reason,pnl,fees:p.fees+closeFee,funding:p.funding,equityAfter:realized(a)});
  log(a,{t:at,kind:'stängd',symbol:p.symbol,signalId:p.signalId,text:tradeReasons[reason]+': '+SIDE_TEXT[p.side]+' '+p.symbol+' '+signed(pnl)});
  return a;
}
function checkRisk(r,p,now){
  const step=ACCOUNT.step,bar=(b,n=step)=>!!b&&finite(b.t)&&b.t%n===0&&[b.o,b.h,b.l,b.c].every(positive)&&b.h>=Math.max(b.o,b.c,b.l)&&b.l<=Math.min(b.o,b.c);
  if(!r||!Array.isArray(r.markBars)||!Array.isArray(r.lastBars)||!Array.isArray(r.funding)||!finite(r.historyFrom)||
    r.historyFrom>Math.min(p.nextBar,Math.floor(p.fundingThrough/step)*step)||!finite(r.fundingThrough)||r.fundingThrough<now-RISK_TTL||
    r.fundingThrough<p.fundingThrough||!positive(r.price)||!positive(r.mark)||!finite(r.at)||r.at>now+5000||now-r.at>RISK_TTL)
    throw Error('Markpris- eller fundinghistorik saknas för '+p.symbol);
  if(!r.markBars.every(b=>bar(b))||!r.lastBars.every(b=>bar(b)))throw Error('Ogiltiga 5-minuterspriser för '+p.symbol);
  if([r.minuteMarks,r.minuteLasts].some(x=>x!=null&&(!Array.isArray(x)||!x.every(b=>bar(b,MIN)))))throw Error('Ogiltiga 1-minuterspriser för '+p.symbol);
  if(r.funding.some((f,i)=>!f||!finite(f.t)||f.t%step||!finite(f.rate)||i&&f.t<=r.funding[i-1].t))throw Error('Ogiltig fundinghistorik för '+p.symbol);
}
/**
 * Replays the 5-minute bars since the last check, in time order. Funding
 * settles at its timestamp on that bar's mark open, out of the position
 * margin, and moves the liquidation level. Within a bar the adverse event
 * wins: liquidation on mark first, then the stop on last price (a gap past it
 * fills at the open), then the target. At the first bar on or after the
 * deadline the position closes at that bar's open, so a long absence cannot
 * stretch a trade past its holding time.
 * The 5-minute bar of the step the position opened in also holds prices from
 * before the entry, so until the first full bar after it is settled that step
 * is replayed first, the same way, with Bybit's 1-minute candles
 * (risk.minuteMarks, risk.minuteLasts) from the minute after the open: every
 * closed minute is needed, the forming one is checked when Bybit has it.
 */
export function settlePosition(a,id,risk,now){
  validateForecastAccount(a);
  const next=structuredClone(a),p=next.positions.find(x=>x.id===id);
  if(!p)return next;
  if(!positive(now)||now<p.openedAt)throw Error('Ogiltig tid för riskkontrollen');
  checkRisk(risk,p,now);
  const step=ACCOUNT.step,dir=DIR[p.side],current=Math.floor(now/step)*step,through=Math.min(now,risk.fundingThrough);
  const marks=new Map(risk.markBars.map(b=>[b.t,b])),lasts=new Map(risk.lastBars.map(b=>[b.t,b]));
  const due=risk.funding.filter(f=>f.t>p.fundingThrough&&f.t<=through);let fi=0;
  const charge=until=>{
    while(fi<due.length&&due[fi].t<=until){
      const f=due[fi++],m=marks.get(f.t);if(!m)throw Error('Markpris vid funding saknas för '+p.symbol);
      const cost=dir*p.units*m.o*f.rate;p.margin-=cost;p.funding+=cost;next.funding+=cost;p.liq=levelOf(p);
    }
  };
  const fill=level=>level*(1-dir*ACCOUNT.slip),worst=b=>dir>0?b.l:b.h,best=b=>dir>0?b.h:b.l;
  const exit=(price,at,reason)=>validateForecastAccount(closeAt(next,p,price,at,reason));
  const inside=(m,l,t,end)=>dir*(worst(m)-p.liq)<=0?exit(p.liq,end,'likvidation'):dir*(l.o-p.sl)<=0?exit(fill(l.o),t,'stopp'):
    dir*(worst(l)-p.sl)<=0?exit(fill(p.sl),end,'stopp'):dir*(best(l)-p.tp)>=0?exit(fill(p.tp),dir*(l.o-p.tp)>=0?t:end,'mål'):null;
  // Funding times are 5-minute boundaries, so none falls inside the opening step after the open.
  const first=(Math.floor(p.openedAt/step)+1)*step;
  if(p.nextBar===first){
    const mm=new Map((risk.minuteMarks??[]).map(b=>[b.t,b])),ml=new Map((risk.minuteLasts??[]).map(b=>[b.t,b])),forming=Math.floor(now/MIN)*MIN;
    for(let t=Math.ceil(p.openedAt/MIN)*MIN;t<first&&t<=forming;t+=MIN){
      const m=mm.get(t),l=ml.get(t);
      if(!m||!l){if(t===forming)break;throw Error('Lucka i 1-minuterspriserna för '+p.symbol);}
      if(dir*(m.o-p.liq)<=0)return exit(m.o,t,'likvidation');
      const done=inside(m,l,t,Math.min(now,t+MIN));if(done)return done;
    }
  }
  for(let t=p.nextBar;t<=current;t+=step){
    const m=marks.get(t),l=lasts.get(t),end=Math.min(now,t+step);
    if(!m||!l)throw Error('Lucka i 5-minuterspriserna för '+p.symbol);
    charge(t);
    if(dir*(m.o-p.liq)<=0)return exit(m.o,t,'likvidation');
    if(t>=p.deadline){
      if(dir*(l.o-p.sl)<=0)return exit(fill(l.o),t,'stopp');
      if(dir*(l.o-p.tp)>=0)return exit(fill(p.tp),t,'mål');
      return exit(fill(l.o),t,'tid');
    }
    const done=inside(m,l,t,end);if(done)return done;
    // The forming bar is checked but stays pending until it has closed.
    if(t+step<=now)p.nextBar=t+step;
  }
  charge(through);
  p.fundingThrough=Math.max(p.fundingThrough,through);
  if(now>=p.deadline)return exit(fill(risk.price),now,'tid');
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
 * From the deadline on it does nothing: settlePosition ends the trade at the
 * deadline candle's open, as a replay after a reload would.
 */
export function checkQuote(a,id,quote,now){
  validateForecastAccount(a);
  const next=structuredClone(a),p=next.positions.find(x=>x.id===id);
  if(!p||!positive(now)||!fresh(quote,now)||quote.at<p.openedAt||now<p.openedAt||now-p.fundingThrough>RISK_TTL||
    Math.max(now,quote.at)>=p.deadline||Math.floor(now/HOUR)*HOUR>p.fundingThrough)return next;
  const dir=DIR[p.side],fill=level=>level*(1-dir*ACCOUNT.slip);
  if(dir*(quote.mark-p.liq)<=0)return validateForecastAccount(closeAt(next,p,p.liq,now,'likvidation'));
  if(dir*(quote.price-p.sl)<=0)return validateForecastAccount(closeAt(next,p,fill(dir>0?Math.min(quote.price,p.sl):Math.max(quote.price,p.sl)),now,'stopp'));
  if(dir*(quote.price-p.tp)>=0)return validateForecastAccount(closeAt(next,p,fill(p.tp),now,'mål'));
  return next;
}
export function closePosition(a,id,{price,now,reason}={}){
  validateForecastAccount(a);
  if(!CLOSE_REASONS.includes(reason))throw Error('Ogiltig orsak till stängning');
  if(!positive(price))throw Error('Färskt pris saknas för stängningen');
  const next=structuredClone(a),p=next.positions.find(x=>x.id===id);
  if(!p)throw Error('Positionen är redan stängd');
  if(!positive(now)||now<p.openedAt)throw Error('Ogiltig tid för stängningen');
  return validateForecastAccount(closeAt(next,p,price*(1-DIR[p.side]*ACCOUNT.slip),now,reason));
}

// Value if closed at the quote now: slippage and the closing fee included, never below zero.
export function accountLive(a,quotes,now){
  validateForecastAccount(a);
  const positions=[],stale=[],unsettled=[];let value=0,openPnl=0,at=null;
  for(const p of a.positions){
    const q=quotes?.[p.symbol],ok=fresh(q,now),dir=DIR[p.side];
    const row={...p,price:null,mark:null,value:null,pnl:null,pnlPct:null,toLiq:null,toSl:null,toTp:null};
    if(ok)Object.assign(row,{price:q.price,mark:q.mark,toLiq:dir*(q.mark-p.liq)/q.mark,toSl:dir*(q.price-p.sl)/q.price,toTp:dir*(p.tp-q.price)/q.price});
    if(!ok)stale.push(p.symbol);
    else if(now-p.fundingThrough>RISK_TTL)unsettled.push(p.symbol);
    else{
      const exit=q.price*(1-dir*ACCOUNT.slip),marginOpen=p.margin+p.funding;
      const v=dir*(q.mark-p.liq)<=0?0:Math.max(0,p.margin+dir*(exit-p.entry)*p.units-p.units*exit*ACCOUNT.fee);
      Object.assign(row,{value:v,pnl:v-marginOpen-p.fees,pnlPct:(v-marginOpen-p.fees)/marginOpen});
      value+=v;openPnl+=row.pnl;at=at===null?q.at:Math.min(at,q.at);
    }
    positions.push(row);
  }
  const waiting=[...stale,...unsettled],done=!waiting.length;
  return {equity:done?a.cash+value:null,cash:a.cash,marginUsed:sum(a.positions,p=>p.margin),openPnl:done?openPnl:null,positions,waiting,at:done?at:null,
    reason:stale.length?'Väntar på färskt pris för '+stale.join(', '):unsettled.length?'Väntar på funding- och likvidationskontroll för '+unsettled.join(', '):''};
}
export function accountStats(a){
  validateForecastAccount(a);
  const t=a.trades,pnl=t.map(x=>x.pnl),gain=sum(pnl.filter(x=>x>0),x=>x),loss=-sum(pnl.filter(x=>x<0),x=>x);
  let peak=a.start,maxDrawdown=0;
  for(const x of t){peak=Math.max(peak,x.equityAfter);maxDrawdown=Math.max(maxDrawdown,(peak-x.equityAfter)/peak);}
  const wins=pnl.filter(x=>x>0).length;
  return {trades:t.length,wins,losses:pnl.filter(x=>x<0).length,winRate:t.length?wins/t.length:null,net:sum(pnl,x=>x),fees:a.fees,funding:a.funding,
    liquidations:t.filter(x=>x.reason==='likvidation').length,profitFactor:loss>0?gain/loss:null,maxDrawdown,
    best:t.length?pnl.reduce((m,x)=>Math.max(m,x)):null,worst:t.length?pnl.reduce((m,x)=>Math.min(m,x)):null,open:a.positions.length};
}
