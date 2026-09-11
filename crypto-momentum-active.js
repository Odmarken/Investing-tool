import {MOMENTUM,newMomentumAccount,readMomentum,validateMomentumAccount} from './crypto-momentum.js';
import {closeLeveraged,inspectLeveraged} from './crypto-leverage.js';
import {ACTIVE_PROFILES,chooseActiveSignal} from './crypto-momentum-active-signal.js';
import {ACTIVE_RISK,openActivePosition,inspectActivePosition} from './crypto-momentum-active-execution.js';
export {fetchActiveSnapshot,fetchActiveRisk} from './crypto-momentum-active-market.js';
export const ACTIVE=Object.freeze({version:'momentum-hourly-sl-tp-v4',profile:'pulse12',hour:3600000,start:100,symbols:MOMENTUM.symbols,...ACTIVE_RISK});
const positive=n=>Number.isFinite(n)&&n>0;

export function newActiveAccount(){
  return {...newMomentumAccount(),version:ACTIVE.version,profile:ACTIVE.profile,activeDecisions:[],lastSignalAt:null,cooldownUntil:0,migrationPending:false};
}
export function validateActiveAccount(a){
  if(a?.version!==ACTIVE.version||!Object.hasOwn(ACTIVE_PROFILES,a.profile)||!Array.isArray(a.activeDecisions)||
    !(a.lastSignalAt===null||positive(a.lastSignalAt)&&a.lastSignalAt%ACTIVE.hour===0)||!Number.isFinite(a.cooldownUntil)||a.cooldownUntil<0||typeof a.migrationPending!=='boolean')throw Error('Ogiltigt aktivt momentumkonto');
  // Reuse all cash/fee/funding/history reconciliation from the previous ledger.
  validateMomentumAccount({...a,version:MOMENTUM.version});
  const held=a.sleeves.filter(s=>s.position),capital=a.sleeves.reduce((sum,s)=>sum+s.cash+(s.position?.budget??0),0);
  if(held.length>1&&!(a.migrationPending&&held.every(s=>s.position.strategy!=='hourly-momentum-v1')))throw Error('Högst en aktiv position tillåts');
  for(const s of a.sleeves){
    const p=s.position;if(!p)continue;
    if(p.strategy!=='hourly-momentum-v1'){if(!a.migrationPending)throw Error('Äldre position väntar på övergång');continue;}
    if(![p.sl,p.tp,p.deadline,p.initialRisk,p.accountAtEntry,p.signalAt,p.netRR].every(positive)||p.sl>=p.entry||p.tp<=p.entry||p.deadline<=p.at||p.deadline%p.rules.step||
      p.budget>p.accountAtEntry*ACTIVE.marginFraction+1e-7||p.initialRisk>p.accountAtEntry*ACTIVE.riskFraction+1e-7)throw Error('Ogiltig SL, TP eller riskstorlek');
    const stopFill=p.sl*(1-p.rules.slip),expectedRisk=p.units*(p.entry-stopFill+p.rules.fee*(p.entry+stopFill));
    if(Math.abs(p.accountAtEntry-capital)>1e-7*Math.max(1,capital)||Math.abs(p.initialRisk-expectedRisk)>1e-7*Math.max(1,expectedRisk))throw Error('Positionens riskbudget stämmer inte');
  }
  if(a.activeDecisions.some((d,i)=>!d||!positive(d.hour)||d.hour%ACTIVE.hour||!positive(d.at)||d.at<d.hour||d.symbol!==null&&!ACTIVE.symbols.includes(d.symbol)||
    !['köp','behåll','kontanter'].includes(d.action)||i&&d.hour<=a.activeDecisions[i-1].hour)||(a.activeDecisions.at(-1)?.hour??null)!==a.lastSignalAt)throw Error('Ogiltiga timbeslut');
  return a;
}
export function readActiveAccount(storage,key){
  const raw=storage.getItem(key);if(raw===null)return newActiveAccount();
  const a=JSON.parse(raw);if(a.version===ACTIVE.version)return validateActiveAccount(a);
  const legacy=readMomentum({getItem:()=>raw},key);
  return validateActiveAccount({...legacy,version:ACTIVE.version,enabled:false,profile:ACTIVE.profile,activeDecisions:[],lastSignalAt:null,cooldownUntil:0,migrationPending:legacy.sleeves.some(s=>s.position)});
}
function quote(q,now){
  if(!q||![q.price,q.mark].every(positive)||!Number.isFinite(q.at)||q.at>now+5000||now-q.at>120000)throw Error('Färska perpetualpriser saknas');
}
function close(a,s,exit){
  const p=s.position,result=closeLeveraged(p,exit.price,exit.at,exit.reason);
  s.cash+=result.cash;a.fees+=result.exitFee;
  a.trades.push({symbol:s.symbol,...result.trade,sl:p.sl??null,tp:p.tp??null,initialRisk:p.initialRisk??null,profile:a.profile});s.position=null;
  a.cooldownUntil=Math.max(a.cooldownUntil,exit.at+ACTIVE.hour);
}
export function advanceActiveRisk(account,snapshot,now){
  validateActiveAccount(account);
  if(!account.sleeves.some(s=>s.position))return account;
  const next=structuredClone(account);
  for(const s of next.sleeves){
    if(!s.position)continue;
    const q=snapshot.market?.[s.symbol];quote(q,now);
    if(q.at<s.position.at-5000)throw Error('Priset är äldre än positionen');
    if(s.position.strategy==='hourly-momentum-v1'){
      const checked=inspectActivePosition(s.position,q,now);s.position=checked.position;next.funding+=checked.funding;
      if(checked.exit)close(next,s,checked.exit);
    }else{
      const checked=inspectLeveraged(s.position,q,now);s.position=checked.position;next.funding+=checked.funding;
      close(next,s,checked.liquidated?{price:checked.liquidated.price,at:checked.liquidated.at,reason:'likvidation'}:{price:q.price,at:now,reason:'strategy-change'});
    }
  }
  next.migrationPending=false;delete next.singlePending;
  return validateActiveAccount(next);
}
export function advanceActiveAccount(account,snapshot,now){
  // Risk settlement precedes hourly entry selection and does not need the other coins.
  const next=structuredClone(advanceActiveRisk(account,snapshot,now));
  if(!next.enabled)return validateActiveAccount(next);
  if(snapshot.hour!==Math.floor(now/ACTIVE.hour)*ACTIVE.hour)throw Error('Signalerna tillhör fel timme');
  if(next.lastSignalAt!==null&&next.lastSignalAt>=snapshot.hour)return next;
  for(const symbol of ACTIVE.symbols)quote(snapshot.market?.[symbol],now);
  delete next.waitReason;
  const held=next.sleeves.find(s=>s.position);
  let action=held?'behåll':'kontanter',symbol=held?.symbol??null,score=null;
  if(!held&&now>=next.cooldownUntil){
    const candidates=ACTIVE.symbols.map(s=>snapshot.market[s].signal).filter(s=>s?.at===snapshot.hour);
    const signal=chooseActiveSignal(candidates),cash=next.sleeves.reduce((sum,s)=>sum+s.cash,0);
    if(signal&&cash>0){
      try{
        const p=openActivePosition(cash,snapshot.market[signal.symbol],signal,now);
        if(p){
          for(const s of next.sleeves)s.cash=0;
          const s=next.sleeves.find(s=>s.symbol===signal.symbol);s.cash=cash-p.budget;s.position=p;
          next.fees+=p.fee;next.startedAt??=now;action='köp';symbol=s.symbol;score=signal.score;
        }
      }catch(e){next.waitReason='Timbeslut väntar: '+e.message;return validateActiveAccount(next);}
    }
  }
  // A cooldown can finish later within this hour. Do not consume that new candle early.
  if(!held&&now<next.cooldownUntil)return validateActiveAccount(next);
  next.activeDecisions.push({hour:snapshot.hour,at:now,action,symbol,score});next.lastSignalAt=snapshot.hour;
  return validateActiveAccount(next);
}
