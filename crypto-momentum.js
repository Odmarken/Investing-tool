// Forward demo only. Bybit per-contract isolated margin; no broker orders.
import {LEVERAGE,openLeveraged,closeLeveraged,inspectLeveraged,leveragedValue,liquidationPrice} from './crypto-leverage.js';
import {fetchDerivatives} from './crypto-momentum-market.js';
import {CONTRACTS,maxLeverageFor} from './bybit-contracts.js';
const LEGACY_SYMBOLS=['BTC','ETH','SOL'];
const LEGACY_VERSIONS=['momentum-14-28-56-20x-v1','momentum-14-28-56-bybitmax-v2'];
export const MOMENTUM = Object.freeze({ version: 'momentum-14-28-56-single-v3', symbols: Object.keys(CONTRACTS), day: 86400000, ...LEVERAGE, leverage:null, leverageMode:'bybitMax', maxPositions:1, allocation:1, exitMode:'weekly-momentum', start: 100 });
const finite = x => typeof x === 'number' && Number.isFinite(x);
const positive = x => finite(x) && x > 0;
export function weekStart(now) {
  const day = Math.floor(now / MOMENTUM.day) * MOMENTUM.day;
  return day - ((new Date(day).getUTCDay() + 6) % 7) * MOMENTUM.day;
}
export function momentumScore(bars, week) {
  const closed = bars.filter(b => b.t < week).slice(-57);
  if (closed.length !== 57 || closed.some((b, i) => b.t !== week - (57-i)*MOMENTUM.day || !positive(b.c)))
    throw Error('57 sammanhängande avslutade dygn saknas');
  return [14,28,56].reduce((sum,n) => sum + closed[56].c / closed[56-n].c - 1, 0) / 3;
}
export function newMomentumAccount() {
  return { version: MOMENTUM.version, enabled: false, startedAt: null, lastWeek: null, fees: 0, funding:0,
    // Cash is pooled for entries; these buckets preserve older account history.
    sleeves: MOMENTUM.symbols.map((symbol,i) => ({ symbol, cash: i===0?MOMENTUM.start:0, position: null })), decisions: [], trades: [] };
}
export function validateMomentumAccount(a) {
  const symbols=LEGACY_VERSIONS.includes(a?.version)?LEGACY_SYMBOLS:MOMENTUM.symbols;
  if (!a || ![MOMENTUM.version,...LEGACY_VERSIONS].includes(a.version) || typeof a.enabled !== 'boolean' ||
      !(a.startedAt === null || positive(a.startedAt)) || !(a.lastWeek === null || positive(a.lastWeek) && weekStart(a.lastWeek) === a.lastWeek) ||
      !finite(a.fees) || a.fees < 0 || !finite(a.funding) || !Array.isArray(a.sleeves) || a.sleeves.length !== symbols.length ||
      !Array.isArray(a.decisions) || !Array.isArray(a.trades)) throw Error('Momentumkontot kan inte läsas');
  for (const [i,s] of a.sleeves.entries()) {
    const p = s.position;
    if (s.symbol !== symbols[i] || !finite(s.cash) || s.cash < 0 ||
        p !== null && (!p || !positive(p.units) || !positive(p.entry) || !positive(p.budget) || !positive(p.at) || !finite(p.fee) || p.fee < 0 ||
          !finite(p.funding) || !finite(p.fundingThrough) || p.fundingThrough<p.at || !finite(p.nextBar) || p.nextBar<=p.at || p.nextBar%MOMENTUM.step))
      throw Error('Ogiltigt momentuminnehav');
    if(p&&p.rules&&(!positive(p.rules.leverage)||!positive(p.rules.maintenance)||p.rules.maintenance>=1||!finite(p.rules.fee)||p.rules.fee<0||!finite(p.rules.slip)||p.rules.slip<0||p.rules.step!==LEVERAGE.step||!finite(p.rules.deduction??0)||(p.rules.deduction??0)<0))throw Error('Ogiltiga låsta positionsregler');
    if(p&&Math.abs(p.units*p.entry/(p.rules?.leverage??20)+p.fee-p.budget)>1e-7*Math.max(1,p.budget))
      throw Error('Positionens marginal stämmer inte med låst hävstång');
  }
  const held=a.sleeves.filter(s=>s.position);
  if(a.version===MOMENTUM.version&&held.length>1&&!(a.singlePending===true&&held.length<=3&&held.every(s=>LEGACY_SYMBOLS.includes(s.symbol))))
    throw Error('Momentumkontot får bara ha en öppen position');
  if (a.trades.some(t => !t || !MOMENTUM.symbols.includes(t.symbol) || !finite(t.pnl) || !positive(t.at) ||
      !positive(t.opened) || t.at < t.opened || !positive(t.entry) || !positive(t.exit) || !finite(t.fees) || t.fees < 0 || !finite(t.funding)) ||
      a.decisions.some(d => !d || !positive(d.week) || !positive(d.at) || d.at < d.week || weekStart(d.week) !== d.week ||
        !Array.isArray(d.signals) || ![LEGACY_SYMBOLS.length,MOMENTUM.symbols.length].includes(d.signals.length) || d.signals.some((s,i) => s.symbol !== MOMENTUM.symbols[i] || !finite(s.score))))
    throw Error('Ogiltig momentumhistorik');
  if ((a.decisions.at(-1)?.week ?? null) !== a.lastWeek || a.decisions.some((d,i) => i && d.week <= a.decisions[i-1].week))
    throw Error('Momentumets beslutshistorik stämmer inte');
  const capital = a.sleeves.reduce((sum,s) => sum+s.cash+(s.position?.budget ?? 0), 0);
  const realized = a.trades.reduce((sum,t) => sum+t.pnl, 0);
  const fees = a.trades.reduce((sum,t) => sum+t.fees, 0)+a.sleeves.reduce((sum,s) => sum+(s.position?.fee??0), 0);
  const funding = a.trades.reduce((sum,t) => sum+t.funding, 0)+a.sleeves.reduce((sum,s) => sum+(s.position?.funding??0), 0);
  if (Math.abs(capital-MOMENTUM.start-realized)>1e-7*Math.max(1,capital) || Math.abs(fees-a.fees)>1e-7*Math.max(1,fees))
    throw Error('Momentumkontots saldo eller avgifter stämmer inte');
  if(Math.abs(funding-a.funding)>1e-7*Math.max(1,Math.abs(funding)))throw Error('Fundingbokföringen stämmer inte');
  return a;
}
export function readMomentum(storage, key) {
  const raw = storage.getItem(key);
  if(raw===null)return newMomentumAccount();
  const a=validateMomentumAccount(JSON.parse(raw));
  return upgradeMomentum(a);
}
function upgradeMomentum(a){
  if(a.version===MOMENTUM.version)return a;
  // Preserve all money, positions and history. Extra legacy positions are closed
  // at fresh observed prices by advanceMomentum, never removed during loading.
  return validateMomentumAccount({...a,version:MOMENTUM.version,singlePending:a.sleeves.filter(s=>s.position).length>1,
    sleeves:[...a.sleeves,...MOMENTUM.symbols.slice(3).map(symbol=>({symbol,cash:0,position:null}))]});
}
export function validateSnapshot(snapshot, now) {
  if (!snapshot || snapshot.week !== weekStart(now)) throw Error('Prisdata tillhör fel beslutsvecka');
  for (const symbol of MOMENTUM.symbols) {
    const q = snapshot.market[symbol];
    if (!q || !positive(q.price) || !positive(q.mark) || !finite(q.at) || q.at > now+5000 || now-q.at > 120000 || !finite(q.score))
      throw Error('Färska riktiga prisdata saknas för '+symbol);
  }
}
export function advanceMomentum(account, snapshot, now) {
  validateMomentumAccount(account);
  account=upgradeMomentum(account);
  if (!account.enabled && !account.sleeves.some(s=>s.position)) return account;
  validateSnapshot(snapshot, now);
  const next = structuredClone(account);
  let decide=account.enabled&&(account.lastWeek===null||account.lastWeek<snapshot.week);
  delete next.waitReason;
  const close=(s,price,time,reason)=>{
    const result=closeLeveraged(s.position,price,time,reason);
    s.cash+=result.cash;next.fees+=result.exitFee;next.trades.push({symbol:s.symbol,...result.trade});s.position=null;
  };
  const actions=new Map(MOMENTUM.symbols.map(s=>[s,'kontanter']));
  // Risk monitoring commits even if public entry limits are unavailable.
  for(const s of next.sleeves){
    if(!s.position)continue;
    const checked=inspectLeveraged(s.position,snapshot.market[s.symbol],now);
    s.position=checked.position;next.funding+=checked.funding;
    if(checked.liquidated){close(s,checked.liquidated.price,checked.liquidated.at,'likvidation');actions.set(s.symbol,'likvidation');}
  }
  const ranked=sleeves=>[...sleeves].sort((a,b)=>snapshot.market[b.symbol].score-snapshot.market[a.symbol].score||MOMENTUM.symbols.indexOf(a.symbol)-MOMENTUM.symbols.indexOf(b.symbol));
  if(next.singlePending){
    const held=ranked(next.sleeves.filter(s=>s.position)),keep=held.find(s=>snapshot.market[s.symbol].score>0);
    for(const s of held)if(s!==keep){close(s,snapshot.market[s.symbol].price,now,'single-position');actions.set(s.symbol,'sälj');}
    delete next.singlePending;
  }
  if(decide){
    const held=next.sleeves.find(s=>s.position);
    if(held&&snapshot.market[held.symbol].score<=0){close(held,snapshot.market[held.symbol].price,now,'signal');actions.set(held.symbol,'sälj');}
    if(!next.sleeves.some(s=>s.position)){
      const candidate=ranked(next.sleeves).find(s=>snapshot.market[s.symbol].score>0);
      const budget=next.sleeves.reduce((sum,s)=>sum+s.cash,0);
      if(candidate&&budget>0){
        const q=snapshot.market[candidate.symbol];
        try{
          if(q.contract?.symbol!==candidate.symbol)throw Error('Kontraktsgräns saknas för '+candidate.symbol);
          const selected=maxLeverageFor(q.contract,budget,{fee:LEVERAGE.fee,price:q.price*(1+LEVERAGE.slip),mark:q.mark},now);
          const p=openLeveraged(budget,q.price,now,{...LEVERAGE,...selected});
          if(q.mark>liquidationPrice(p)){
            for(const s of next.sleeves)s.cash=0;
            candidate.position=p;next.fees+=p.fee;actions.set(candidate.symbol,'köp');
          }
        }catch(e){decide=false;next.waitReason='Veckobeslut väntar: '+e.message;}
      }
    }
  }
  if(decide){
    next.startedAt ??= now;next.lastWeek=snapshot.week;
    const signals=next.sleeves.map(s=>({symbol:s.symbol,score:snapshot.market[s.symbol].score,price:snapshot.market[s.symbol].price,
      action:s.position&&actions.get(s.symbol)==='kontanter'?'behåll':actions.get(s.symbol)}));
    next.decisions.push({week:snapshot.week,at:now,signals});
  }
  return validateMomentumAccount(next);
}
export function momentumValue(account, snapshot, now) {
  const hasPositions = account.sleeves.some(s => s.position);
  if (hasPositions) { try { validateSnapshot(snapshot,now); } catch { return null; } }
  // Show net liquidation value including estimated exit fee and slippage.
  return account.sleeves.reduce((sum,s) => sum+s.cash+(s.position ? leveragedValue(s.position,snapshot.market[s.symbol].price) : 0), 0);
}

export async function fetchMomentumSnapshot(grab, now = () => Date.now(), account = null) {
  const week = weekStart(now());
  const entries = await Promise.all(MOMENTUM.symbols.map(async symbol => {
    const j = await grab('https://api.bybit.com/v5/market/kline?'+new URLSearchParams({ category:'spot', symbol:symbol+'USDT', interval:'D', limit:'100' }), { json:true, timeout:8000 });
    if (j?.retCode !== 0 || j.result?.category !== 'spot' || j.result?.symbol !== symbol+'USDT' || !Array.isArray(j.result.list))
      throw Error('Bybit kunde inte hämta '+symbol);
    const bars = j.result.list.map(r => ({ t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5] })).sort((a,b) => a.t-b.t);
    if (bars.some((b,i) => !finite(b.t) || b.t%MOMENTUM.day || ![b.o,b.h,b.l,b.c].every(positive) || !finite(b.v) || b.v<0 ||
      b.h<Math.max(b.o,b.c,b.l) || b.l>Math.min(b.o,b.c) || i && b.t!==bars[i-1].t+MOMENTUM.day)) throw Error('Ogiltiga dygnspriser för '+symbol);
    const latest = bars.at(-1);
    if (latest?.t !== Math.floor(now()/MOMENTUM.day)*MOMENTUM.day) throw Error('Aktuellt dygnspris saknas för '+symbol);
    if(!finite(j.time)||now()-j.time>120000||j.time>now()+5000)throw Error('Dygnssvaret är för gammalt');
    const derivative=await fetchDerivatives(grab,symbol,account?.sleeves.find(s=>s.symbol===symbol)?.position,now);
    return [symbol,{score:momentumScore(bars,week),...derivative}];
  }));
  const snapshot = { week, market:Object.fromEntries(entries) };
  validateSnapshot(snapshot,now());
  return snapshot;
}
