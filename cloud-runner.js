// Cloud runner: the AI momentum account keeps its frozen hourly SL/TP rules
// and the six trading floor desks run the trend ensemble, with the same
// modules the browser uses. Planning and applying are separated so Firestore
// can re-read the accounts inside a transaction before the plan is applied.
// Firestore wiring lives in functions/index.js; nothing here sends orders.
import {ACTIVE,advanceActiveAccount,advanceActiveRisk,fetchActiveSnapshot,fetchActiveRisk} from './crypto-momentum-active.js';
import {fetchMomentumQuotes} from './crypto-momentum-live.js';
import {advanceFirm,advanceFirmRisk,heldSymbols,firmLive,sampleEquity,needsHourly} from './trading-floor.js';
import {fetchTrendMarket,fetchTrendRisk} from './floor-trend-market.js';
export const hourOf=now=>Math.floor(now/ACTIVE.hour)*ACTIVE.hour;
const held=account=>account.sleeves.some(s=>s.position);
// A free, enabled momentum account whose hour has not been decided yet needs the hourly candles.
export function needsDecision(account,now){
  if(!account||!account.enabled||held(account))return false;
  return (account.lastSignalAt===null||account.lastSignalAt<hourOf(now))&&now>=account.cooldownUntil;
}
export const momentumActive=momentum=>!!momentum&&(momentum.enabled||held(momentum));
async function momentumPlan(grab,now,momentum){
  if(!momentumActive(momentum))return {mode:'idle'};
  if(needsDecision(momentum,now()))return {mode:'decide',snapshot:await fetchActiveSnapshot(grab,now,momentum)};
  // An active account gets a run every minute even when nothing is held, so the page sees the cloud alive.
  return {mode:'risk',risk:held(momentum)?await fetchActiveRisk(grab,now,momentum):{market:{}}};
}
// The desks decide every hour, paused or not, so their trend states stay current.
async function floorPlan(grab,now,firm){
  if(!firm)return {mode:'idle'};
  if(needsHourly(firm,now()))return {mode:'decide',snapshot:await fetchTrendMarket(grab,now,firm.desks)};
  const desks=Object.fromEntries(heldSymbols(firm).map(s=>[s,firm.desks[s]]));
  return {mode:'risk',risk:Object.keys(desks).length?await fetchTrendRisk(grab,now,desks):{market:{}}};
}
const failed=e=>({mode:'error',error:e.message||String(e)});
// Independent plans: a failed fetch for one never blocks the other.
export async function fetchPlan(grab,now,momentum,firm){
  const [m,f]=await Promise.all([momentumPlan(grab,now,momentum).catch(failed),floorPlan(grab,now,firm).catch(failed)]);
  return {momentum:m,floor:f};
}
export function applyPlan(plan,momentum,firm,now){
  const out={momentum:{account:momentum,error:null},firm:{firm,error:null}};
  const m=plan?.momentum,f=plan?.floor;
  if(momentum&&m&&m.mode!=='idle'){
    if(m.mode==='error')out.momentum.error=m.error;
    else if(momentumActive(momentum)){
      try{out.momentum.account=m.mode==='decide'?advanceActiveAccount(momentum,m.snapshot,now):advanceActiveRisk(momentum,m.risk,now);}
      catch(e){out.momentum.error=e.message;}
    }
  }
  if(firm&&f&&f.mode!=='idle'){
    if(f.mode==='error')out.firm.error=f.error;
    else try{
      if(f.mode==='decide')out.firm.firm=advanceFirm(firm,f.snapshot,now);
      else{let next=firm;for(const symbol of heldSymbols(firm))next=advanceFirmRisk(next,symbol,f.risk,now);out.firm.firm=next;}
    }catch(e){out.firm.error=e.message;}
  }
  return out;
}
// Fresh tickers for the held desks give the firm's live total for the equity curve.
export async function sampleFirmEquity(grab,now,firm,points){
  const symbols=heldSymbols(firm);
  const quotes=symbols.length?await fetchMomentumQuotes(grab,symbols,now):{};
  const live=firmLive(firm,quotes,now());
  return live.total===null?points:sampleEquity(points,now(),live.total);
}
