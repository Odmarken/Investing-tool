// Forward demo only. Isolated 20x margin; no broker orders or backdated entries.
import {LEVERAGE,openLeveraged,closeLeveraged,inspectLeveraged,leveragedValue,liquidationPrice} from './crypto-leverage.js';
import {fetchDerivatives} from './crypto-momentum-market.js';
export const MOMENTUM = Object.freeze({ version: 'momentum-14-28-56-20x-v1', symbols: ['BTC','ETH','SOL'], day: 86400000, ...LEVERAGE, start: 100 });
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
    sleeves: MOMENTUM.symbols.map(symbol => ({ symbol, cash: MOMENTUM.start/3, position: null })), decisions: [], trades: [] };
}
export function validateMomentumAccount(a) {
  if (!a || a.version !== MOMENTUM.version || typeof a.enabled !== 'boolean' ||
      !(a.startedAt === null || positive(a.startedAt)) || !(a.lastWeek === null || positive(a.lastWeek) && weekStart(a.lastWeek) === a.lastWeek) ||
      !finite(a.fees) || a.fees < 0 || !finite(a.funding) || !Array.isArray(a.sleeves) || a.sleeves.length !== 3 ||
      !Array.isArray(a.decisions) || !Array.isArray(a.trades)) throw Error('Momentumkontot kan inte läsas');
  for (const [i,s] of a.sleeves.entries()) {
    const p = s.position;
    if (s.symbol !== MOMENTUM.symbols[i] || !finite(s.cash) || s.cash < 0 ||
        p !== null && (!p || !positive(p.units) || !positive(p.entry) || !positive(p.budget) || !positive(p.at) || !finite(p.fee) || p.fee < 0 ||
          !finite(p.funding) || !finite(p.fundingThrough) || p.fundingThrough<p.at || !finite(p.nextBar) || p.nextBar<=p.at || p.nextBar%MOMENTUM.step))
      throw Error('Ogiltigt momentuminnehav');
    if(p&&Math.abs(p.units*p.entry/MOMENTUM.leverage+p.fee-p.budget)>1e-7*Math.max(1,p.budget))
      throw Error('Positionens marginal stämmer inte med 20×');
  }
  if (a.trades.some(t => !t || !MOMENTUM.symbols.includes(t.symbol) || !finite(t.pnl) || !positive(t.at) ||
      !positive(t.opened) || t.at < t.opened || !positive(t.entry) || !positive(t.exit) || !finite(t.fees) || t.fees < 0 || !finite(t.funding)) ||
      a.decisions.some(d => !d || !positive(d.week) || !positive(d.at) || d.at < d.week || weekStart(d.week) !== d.week ||
        !Array.isArray(d.signals) || d.signals.length !== 3 || d.signals.some((s,i) => s.symbol !== MOMENTUM.symbols[i] || !finite(s.score))))
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
  return raw === null ? newMomentumAccount() : validateMomentumAccount(JSON.parse(raw));
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
  if (!account.enabled && !account.sleeves.some(s=>s.position)) return account;
  validateSnapshot(snapshot, now);
  const next = structuredClone(account);
  const decide=account.enabled&&(account.lastWeek===null||account.lastWeek<snapshot.week);
  if(decide)next.startedAt ??= now;
  const close=(s,price,time,reason)=>{
    const result=closeLeveraged(s.position,price,time,reason);
    s.cash+=result.cash;next.fees+=result.exitFee;next.trades.push({symbol:s.symbol,...result.trade});s.position=null;
  };
  const signals = [];
  for (const s of next.sleeves) {
    const q = snapshot.market[s.symbol], wanted = q.score > 0;
    let action = wanted ? 'behåll' : 'kontanter';
    if(s.position){
      const checked=inspectLeveraged(s.position,q,now);s.position=checked.position;next.funding+=checked.funding;
      if(checked.liquidated){close(s,checked.liquidated.price,checked.liquidated.at,'likvidation');action='likvidation';}
    }
    if(!decide)continue;
    if (s.position && !wanted) {
      close(s,q.price,now,'signal');action='sälj';
    } else if (!s.position && wanted && s.cash > 0) {
      const p=openLeveraged(s.cash,q.price,now);
      if(q.mark>liquidationPrice(p)){s.position=p;s.cash=0;next.fees+=p.fee;action='köp';}
      else action='kontanter';
    }
    signals.push({ symbol:s.symbol, score:q.score, action, price:q.price });
  }
  if(decide){next.lastWeek=snapshot.week;next.decisions.push({week:snapshot.week,at:now,signals});}
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
