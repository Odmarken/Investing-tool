// Cloud runner: one market fetch per user drives the AI momentum account and
// the six trading floor desks with the same frozen rules the browser uses.
// Planning and applying are separated so Firestore can re-read the accounts
// inside a transaction before the plan is applied. Firestore wiring lives in
// functions/index.js; nothing here sends orders.
import {ACTIVE,advanceActiveAccount,advanceActiveRisk,fetchActiveSnapshot,fetchActiveRisk} from './crypto-momentum-active.js';
import {fetchMomentumQuotes} from './crypto-momentum-live.js';
import {FLOOR,advanceFirm,advanceFirmRisk,heldSymbols,firmLive,sampleEquity} from './trading-floor.js';
export const hourOf=now=>Math.floor(now/ACTIVE.hour)*ACTIVE.hour;
const held=account=>account.sleeves.some(s=>s.position);
// A free, enabled account whose hour has not been decided yet needs the hourly candles.
export function needsDecision(account,now){
  if(!account||!account.enabled||held(account))return false;
  return (account.lastSignalAt===null||account.lastSignalAt<hourOf(now))&&now>=account.cooldownUntil;
}
export function activeAccounts(momentum,firm){
  const list=[];
  if(momentum&&(momentum.enabled||held(momentum)))list.push({kind:'momentum',account:momentum});
  if(firm)for(const symbol of FLOOR.desks){const desk=firm.desks[symbol];if(desk.enabled||held(desk))list.push({kind:'desk',symbol,account:desk});}
  return list;
}
// Per contract, history must start at the earliest open position so every
// account's funding and mark-price replay is complete.
export function mergedPositions(accounts){
  const bySymbol={};
  for(const {account} of accounts)for(const s of account.sleeves){
    const p=s.position;if(!p)continue;const cur=bySymbol[s.symbol];
    bySymbol[s.symbol]=cur?{nextBar:Math.min(cur.nextBar,p.nextBar),fundingThrough:Math.min(cur.fundingThrough,p.fundingThrough)}:{nextBar:p.nextBar,fundingThrough:p.fundingThrough};
  }
  return {profile:ACTIVE.profile,sleeves:ACTIVE.symbols.map(symbol=>({symbol,cash:0,position:bySymbol[symbol]??null}))};
}
export async function fetchPlan(grab,now,momentum,firm){
  const accounts=activeAccounts(momentum,firm);
  if(!accounts.length)return {mode:'idle'};
  const merged=mergedPositions(accounts);
  if(accounts.some(a=>needsDecision(a.account,now())))return {mode:'decide',snapshot:await fetchActiveSnapshot(grab,now,merged)};
  return {mode:'risk',risk:merged.sleeves.some(s=>s.position)?await fetchActiveRisk(grab,now,merged):{market:{}}};
}
export function applyPlan(plan,momentum,firm,now){
  const out={momentum:{account:momentum,error:null},firm:{firm,error:null}};
  if(!plan||plan.mode==='idle')return out;
  if(plan.mode==='error'){out.momentum.error=momentum?plan.error:null;out.firm.error=firm?plan.error:null;return out;}
  if(momentum&&(momentum.enabled||held(momentum))){
    try{out.momentum.account=plan.mode==='decide'?advanceActiveAccount(momentum,plan.snapshot,now):advanceActiveRisk(momentum,plan.risk,now);}
    catch(e){out.momentum.error=e.message;}
  }
  if(firm){
    try{
      if(plan.mode==='decide')out.firm.firm=advanceFirm(firm,plan.snapshot,now);
      else{let next=firm;for(const symbol of heldSymbols(firm))next=advanceFirmRisk(next,symbol,plan.risk,now);out.firm.firm=next;}
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
