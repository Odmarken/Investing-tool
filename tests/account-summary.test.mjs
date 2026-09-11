import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeAccount,summaryCSV,mountSummary} from '../account-summary.js';
import {mergeHistory} from '../account-history.js';
const DAY=86400000,now=Date.parse('2026-09-11T12:00:00Z');
function account(n=20){let balance=100;const startad=now-10*DAY;
  const affarer=Array.from({length:n},(_,i)=>{const pnl=i%2===0?10:-5,before=balance;balance+=pnl;return {id:'trade'+i,inst:'BTC',side:i%2?'short':'long',pnl,avgift:1,kapitalFore:before,kapitalEfter:balance,oppnad:startad+i*DAY/3,stangd:startad+i*DAY/3+60000};});
  return {start:100,startad,kapital:balance,affarer};}
test('summary reconciles wins, losses, net profit and historical balances',()=>{
  const s=summarizeAccount(account(),now);assert.equal(s.wins,10);assert.equal(s.losses,10);assert.equal(s.winRate,.5);
  assert.equal(s.net,50);assert.equal(s.balance,150);assert.equal(s.fees,20);assert.equal(s.incomplete,false);
  assert.equal(s.trades[1].before,110);assert.equal(s.trades[1].after,105);
});
test('legacy before-balance is reconstructed from recorded after minus profit, not current balance',()=>{
  const a=account();delete a.affarer[0].kapitalFore;
  assert.equal(summarizeAccount(a,now).trades[0].before,100);
  a.affarer=a.affarer.slice(10);const s=summarizeAccount(a,now);assert.equal(s.incomplete,true);assert.equal(s.trades[0].before,125);
});
test('forecast uses realized calendar-day net, with no invented positive ETA',()=>{
  let s=summarizeAccount(account(),now);assert.equal(s.daily,5);assert.equal(s.forecast.days,1970);assert.equal(s.forecast.status,'estimate');
  const a=account();a.affarer.forEach(t=>t.pnl=-5);a.kapital=0;s=summarizeAccount(a,now);assert.equal(s.forecast.status,'nonpositive');assert.equal(s.forecast.date,null);
  assert.equal(summarizeAccount(account(2),now).forecast.status,'insufficient');
  assert.equal(summarizeAccount({...account(),kapital:10001},now).forecast.status,'reached');
  assert.equal(summarizeAccount({...account(),kapital:undefined},now).forecast.status,'insufficient');
});
test('empty and breakeven histories have no NaN ratio or false target estimate',()=>{
  const empty=summarizeAccount({start:100,kapital:100,startad:now,affarer:[]},now);assert.equal(empty.winRate,null);assert.equal(empty.forecast.status,'insufficient');
  const a=account(1);a.affarer[0].pnl=0;a.affarer[0].kapitalEfter=100;a.kapital=100;
  const s=summarizeAccount(a,now);assert.equal(s.flat,1);assert.equal(s.winRate,null);
});
test('merge preserves history beyond 300, deduplicates snapshots and does not mutate records',()=>{
  const old=account(650).affarer,copy=JSON.stringify(old),merged=mergeHistory(old,old.slice(-300));
  assert.equal(merged.length,650);assert.equal(JSON.stringify(old),copy);
  const changed={...old[0],kapitalFore:99};assert.equal(mergeHistory(old,[changed])[0].kapitalFore,99);
});
test('CSV exports all closes and protects text cells while keeping negative numbers numeric',()=>{
  const a=account();a.affarer[0].namn='=HYPERLINK("evil")';const csv=summaryCSV(summarizeAccount(a,now).trades);
  assert.equal(csv.split('\r\n').length,21);assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes('"-5"'));
});
test('summary renderer paginates all records and filters side/outcome without changing the account',()=>{
  const a=account(63),original=JSON.stringify(a),nodes=new Map();
  const root={innerHTML:'',querySelector:key=>{if(!nodes.has(key))nodes.set(key,{value:'all',innerHTML:'',textContent:''});return nodes.get(key);}};
  const view=mountSummary(root,()=>a,()=>({cloud:true}));view.render();
  assert.match(nodes.get('#summaryPage').textContent,/1 av 2/);
  assert.equal((nodes.get('#summaryRows').innerHTML.match(/<tr>/g)||[]).length,50);
  nodes.get('#summaryNext').onclick();assert.equal((nodes.get('#summaryRows').innerHTML.match(/<tr>/g)||[]).length,13);
  const side=nodes.get('#summarySide');side.value='short';side.onchange();
  assert.ok(!nodes.get('#summaryRows').innerHTML.includes('>LONG<'));assert.match(nodes.get('#summaryCount').textContent,/31 av 63/);
  const outcome=nodes.get('#summaryOutcome');outcome.value='win';outcome.onchange();assert.match(nodes.get('#summaryRows').innerHTML,/Inga avslutade/);
  assert.equal(JSON.stringify(a),original);
});
