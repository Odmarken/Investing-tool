import { MOMENTUM, readMomentum, newMomentumAccount, advanceMomentum, fetchMomentumSnapshot } from './crypto-momentum.js';
import {liquidationPrice} from './crypto-leverage.js';
import {fetchMomentumQuotes,momentumLiveValue,QUOTE_INTERVAL} from './crypto-momentum-live.js';
import {MOMENTUM_RESEARCH} from './crypto-momentum-research.js';
const money = n => !Number.isFinite(n) ? '–' : n.toFixed(2)+' $';
const price = n => !Number.isFinite(n) ? '–' : n.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:n<.01?10:n<1?6:2})+' $';
const date = t => t ? new Date(t).toLocaleString('sv-SE',{timeZone:'Europe/Stockholm'}) : '–';
const signed = n => (n>=0?'+':'')+n.toFixed(2);
const time = t => new Date(t).toLocaleTimeString('sv-SE',{timeZone:'Europe/Stockholm'});
export function mountMomentum(root, { getUser, isActive, grab, rulesRoot = null, storage = {getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value)}, locks = navigator.locks, now = () => Date.now() }) {
  root.innerHTML = `<div class="ai-top"><label><input type="checkbox" data-momentum-toggle> AI-momentum · automatisk demo med Bybit max</label>
    <button type="button" class="btn" data-momentum-export>Exportera momentumkonto</button>
    <button type="button" class="btn" data-momentum-reset title="Arkivera nuvarande momentumkonto och börja om med 100 $, utan öppna positioner och med automatiken pausad">Återställ till 100 $</button></div>
    <p class="dim">7 coins · högst 1 position · hela saldot som marginal · ingen fast SL eller TP</p>
    <p data-momentum-status role="status" aria-live="polite"></p>
    <div class="btstats" data-momentum-balance></div>
    <p class="dim" data-momentum-live-status></p>
    <h3>Öppna positioner</h3><div data-momentum-positions></div>
    <details><summary>Avslutade affärer och veckobeslut</summary><div class="ai-scroll" data-momentum-history></div></details>`;
  const rulesHTML=`    <p>Momentum 14/28/56 dagar · BTC, ETH, SOL, XRP, DOGE, SHIB och PEPE · högsta hävstång enligt Bybits offentliga USDT-perpetualgränser för coin och positionsstorlek. Eget demokonto med 100 $ vid start. Högst en öppen position; hela det lediga saldot används som isolerad marginal inklusive köpavgiften. Öppna affärer behåller sin hävstång. Det vanliga kryptokontot fortsätter separat.</p>
    <p>När kontot är ledigt köps coin med högst positivt veckomomentum. Positionen behålls så länge dess veckomomentum är positivt, även om en annan coin blir starkare. Vid noll eller negativt momentum säljs positionen vid veckobeslutet; då kan nästa positiva coin köpas. Om ingen är positiv ligger saldot i kontanter.</p>
    <p>SL (stop loss) och TP (take profit): inga fasta prisnivåer används i denna momentumstrategi. Strategins exit styrs av veckosignalen. Simulerad likvidation kan inträffa innan dess och förbruka hela marginalbudgeten. Likvidationsnivån visas separat för positionen.</p>
    <p>Ibockad: köper, behåller eller säljer enligt veckosignalen. Avmarkerad: pausar strategins köp och sälj; innehaven ligger kvar och funding och likvidation följs fortfarande. Första beslutet tas när du aktiverar, sedan en gång per vecka från måndag 00:00 UTC.</p>
    <p>Kör när du är inloggad och kryptosidan är öppen. Missade beslut utförs till aktuellt pris när du återkommer. Kontot och inställningen sparas för din inloggning i denna webbläsare, inte mellan enheter.</p>
    <p>Livesaldo visar hela kontots beräknade nettovärde inklusive öppen position. Priset hämtas var femte sekund från Bybits perpetualkontrakt. Köpavgift, bokförd funding och uppskattad avgift och slippage vid stängning ingår. Funding och likvidation kontrolleras i kontouppdateringen ungefär en gång per minut. Gamla priser visas inte som livesaldo.</p>
    <p>Återställ till 100 $ börjar om med ett tomt momentumkonto och pausar automatiken. Det tidigare kontot arkiveras lokalt i webbläsaren. Det vanliga kryptokontot påverkas inte.</p>
    <details><summary>Historiskt test: 1× jämfört med 20×</summary>
    <p>Separata starter januari och juli 2025. Avgifter, slippage, funding och simulerad likvidation ingår. Detta är det tidigare testet med BTC, ETH och SOL i separata kapitaldelar och fast 20×; det testar inte dagens sju coins, en position eller maxhävstång.</p>
    <div class="ai-scroll"><table><thead><tr><th>Period 2025</th><th>Hävstång</th><th>Netto</th><th>Max nedgång</th><th>Likvidationer</th></tr></thead><tbody>${MOMENTUM_RESEARCH.rows.map(r=>'<tr><td>'+(new Date(r.from).getUTCMonth()===0?'Januari–december':'Juli–december')+'</td><td>'+r.leverage+'×</td><td>'+signed(r.returnPct)+' %</td><td>'+r.maxDDPct.toFixed(1)+' %</td><td>'+r.liquidations+'</td></tr>').join('')}</tbody></table></div></details>
    <p class="dim">Bybit max är inte lönsamhetsvaliderad. Tidigare +44,7 % gäller utan hävstång. Signalen använder spotpriser; demofyllningar använder perpetualpriser. Avgift 0,055 % och antagen slippage 0,05 % per sida. Historisk funding och markpriser används för öppna innehav. Underhållsmarginal och marginalavdrag hämtas från positionens risknivå vid inträde och hålls fasta i denna förenklade modell. Vid simulerad likvidation förloras hela positionens marginal. Inga order eller ändringar skickas till ditt Bybit-konto.</p>
    <p class="dim">Saldo inkluderar bokförd funding och uppskattade säljkostnader. Likvidation följs med femminutersstaplar och aktuellt markpris. Inträdesstapelns tidigare extrempriser hoppas över, vilket kan missa en snabb likvidation mellan observationer. Saknad historik pausar beräkningen.</p>`;
  if(rulesRoot)rulesRoot.innerHTML=rulesHTML;
  else root.innerHTML+='<details><summary>Regler och historiska tester</summary>'+rulesHTML+'</details>';
  const toggle = root.querySelector('[data-momentum-toggle]');
  let uid = null, account = null, snapshot = null, error = '', busy = false, resetting = false, lastCheck = -Infinity, generation = 0;
  let quotes={},quoteKey='',quoteBusy=false,quoteFailed=false,lastQuoteCheck=-Infinity,historyStamp='';
  const positionKey=()=>JSON.stringify(account?.sleeves.filter(s=>s.position).map(s=>[s.symbol,s.position.at,s.position.entry,s.position.units])??[]);
  function alignQuotes(){
    const current=positionKey();
    if(current!==quoteKey){quotes={};quoteKey=current;quoteFailed=false;lastQuoteCheck=-Infinity;}
  }
  function acceptQuotes(market){
    for(const s of account.sleeves)if(s.position&&market[s.symbol]&&(!quotes[s.symbol]||market[s.symbol].at>=quotes[s.symbol].at))quotes[s.symbol]=market[s.symbol];
  }
  const key = user => 'riptide.momentum.20x.v1:'+encodeURIComponent(user);
  const exclusive = (user, callback) => {
    if (!locks?.request) return Promise.reject(Error('Automatiken kräver en webbläsare med stöd för säkra fliklås'));
    return locks.request(key(user),callback);
  };
  function sync() {
    const user = getUser();
    if (user !== uid) { uid=user; account=null; snapshot=null; error=''; lastCheck=-Infinity; quotes={};quoteKey='';quoteFailed=false;lastQuoteCheck=-Infinity;generation++; }
    if (uid) account = readMomentum(storage,key(uid));
    alignQuotes();
    return uid;
  }
  function render() {
    toggle.checked = account?.enabled === true; toggle.disabled = !uid || !account || resetting;
    root.querySelector('[data-momentum-export]').disabled = !uid || !account;
    root.querySelector('[data-momentum-reset]').disabled = !uid || resetting;
    const live = account ? momentumLiveValue(account,quotes,now()) : null, value=live?.balance??null;
    const hasPosition=account?.sleeves.some(s=>s.position);
    const liveStatus=!hasPosition?'':live.reason||((quoteFailed?'Prisuppdateringen misslyckades · senaste pris ':'Pris uppdaterat ')+time(live.at)+' · hämtas var 5:e sekund');
    root.querySelector('[data-momentum-live-status]').textContent=liveStatus;
    root.querySelector('[data-momentum-status]').textContent = error || account?.waitReason || (!uid ? 'Logga in för momentumdemo.' :
      (account?.enabled ? 'Automatik på' : 'Automatik pausad') + (busy ? ' · hämtar dygnspriser…' : '') +
      (account?.lastWeek ? ' · senaste beslut '+date(account.decisions.at(-1).at)+'. Nästa veckobeslut från '+date(account.lastWeek+7*MOMENTUM.day)+'.' : ' · ingen affär ännu.')+
      (hasPosition && value===null ? ' '+live.reason+'.' : ''));
    if(account?.singlePending)root.querySelector('[data-momentum-status]').textContent+=' Äldre positioner anpassas till en vid nästa kompletta prisuppdatering.';
    const tile=(label,text,cls='')=>'<div class="btstat"><i>'+label+'</i><b class="'+cls+'">'+text+'</b></div>';
    const net=value===null?null:value-MOMENTUM.start, cls=net===null?'':net>=0?'pos':'neg';
    root.querySelector('[data-momentum-balance]').innerHTML = account ?
      tile(hasPosition?'Livesaldo · netto':'Saldo · netto',money(value),cls)+
      tile('Resultat',net===null?'–':signed(net)+' $',cls)+
      tile('Avkastning',net===null?'–':signed(net/MOMENTUM.start*100)+' %',cls)+
      tile('Ledigt kapital',money(account.sleeves.reduce((sum,s)=>sum+s.cash,0)))+
      tile('Öppna positioner',String(account.sleeves.filter(s=>s.position).length))+
      tile('Avslutade affärer',String(account.trades.length))+
      tile('Avgifter',money(account.fees))+
      tile('Fundingkostnad',money(account.funding))+
      tile('Likviderade',String(account.trades.filter(t=>t.reason==='likvidation').length)) : '';
    root.querySelector('[data-momentum-positions]').innerHTML = account ?
      (account.sleeves.some(s=>s.position)?account.sleeves.filter(s=>s.position).map(s=>{
        const p=s.position,q=live.positions[s.symbol].quote,pnl=live.positions[s.symbol].pnl,score=snapshot?.market[s.symbol]?.score;
        return '<div class="oppen momentum-position"><div class="position-top"><span class="tag long">LONG</span><b>'+s.symbol+'</b><span>'+(p.rules?.leverage??20)+'× · '+money(p.units*p.entry)+' notional</span></div>'+
          '<div class="position-live"><div><span>Livesaldo · hela kontot</span><strong class="'+cls+'" data-position-balance>'+money(value)+'</strong></div>'+
          '<div><span>Öppet resultat · netto</span><strong class="'+(pnl===null?'dim':pnl>=0?'pos':'neg')+'" data-position-pnl>'+(pnl===null?'–':signed(pnl)+' $')+'</strong><small>'+(pnl===null?'':signed(pnl/p.budget*100)+' % av marginalbudgeten')+'</small></div></div>'+
          '<div class="position-meta">'+liveStatus+' · inklusive bokförd funding och beräknade stängningskostnader</div>'+
          '<div class="position-prices"><span>Entry <b>'+price(p.entry)+'</b></span><span>Markpris <b>'+price(q?.mark)+'</b></span><span>Likvidation <b class="neg">'+price(liquidationPrice(p))+'</b></span><span>Marginalbudget <b>'+money(p.budget)+'</b></span></div>'+
          '<div class="position-meta">SL: ingen fast · TP: ingen fast · exit vid veckomomentum ≤ 0 eller likvidation</div>'+
          '<div class="position-meta">Köpt '+date(p.at)+' · funding '+money(p.funding)+(Number.isFinite(score)?' · veckomomentum '+signed(score*100)+' %':'')+'</div></div>';
      }).join(''):'<div class="empty">Inga öppna positioner. '+(account.enabled?'Väntar på nästa köp enligt veckosignalen.':'Aktivera kryssrutan för att köra AI-momentum.')+'</div>')+
      '<p class="dim">Bevakar '+MOMENTUM.symbols.join(', ')+'. Ledigt kapital används gemensamt vid nästa köp. Saldo och öppet netto inkluderar bokförd funding och beräknade säljkostnader.</p>' : '';
    const history=JSON.stringify([uid,account?.decisions,account?.trades]);
    if(history!==historyStamp){
    historyStamp=history;
    root.querySelector('[data-momentum-history]').innerHTML = account ? '<p>Senaste 20 beslut och 20 avslut. Exporten innehåller hela historiken.</p><table><thead><tr><th>Beslut</th><th>Utfört</th><th>Åtgärder</th></tr></thead><tbody>'+
      account.decisions.slice(-20).reverse().map(d=>'<tr><td>'+date(d.week)+'</td><td>'+date(d.at)+'</td><td>'+d.signals.map(s=>s.symbol+': '+({köp:'köp',sälj:'sälj',behåll:'behåll',kontanter:'kontanter',likvidation:'likvidation'}[s.action]??'–')+' ('+signed(s.score*100)+' %)').join(' · ')+'</td></tr>').join('')+
      '</tbody></table><table><thead><tr><th>Stängd</th><th>Coin</th><th>Hävstång</th><th>Orsak</th><th>Nettoresultat</th></tr></thead><tbody>'+account.trades.slice(-20).reverse().map(t=>'<tr><td>'+date(t.at)+'</td><td>'+t.symbol+'</td><td>'+(t.leverage??20)+'×</td><td>'+(t.reason==='likvidation'?'Likvidation':t.reason==='single-position'?'Byte till en position':'Veckosignal')+'</td><td>'+signed(t.pnl)+' $</td></tr>').join('')+'</tbody></table>' : '';
    }
  }
  async function refresh(force=false) {
    if(resetting)return;
    try { sync(); } catch(e) { account=null; error=e.message; render(); return; }
    render();
    if (!uid || !isActive() || busy || !force && now()-lastCheck<60000 || !account.enabled && !account.sleeves.some(s=>s.position)) return;
    const user=uid, token=generation;
    busy=true; lastCheck=now(); render();
    try {
      const fetched=await fetchMomentumSnapshot(grab,now,account);
      if (getUser()!==user || token!==generation || !isActive()) return;
      await exclusive(user,()=>{
        if (getUser()!==user || token!==generation || !isActive()) return;
        const current=readMomentum(storage,key(user));
        const next=advanceMomentum(current,fetched,now());
        // Commit before exposing a simulated fill. A failed write creates no in-memory trade.
        if (next!==current) storage.setItem(key(user),JSON.stringify(next));
        account=next; snapshot=fetched; error='';alignQuotes();acceptQuotes(fetched.market);quoteFailed=false;
      });
    } catch(e) { if(getUser()===user && token===generation) error='Momentum pausad: '+e.message; }
    finally { busy=false; try { sync(); } catch(e) { account=null; error=e.message; } render(); }
  }
  toggle.onchange=async()=>{
    const enabled=toggle.checked, user=getUser(); generation++;
    if(!user) return;
    try {
      await exclusive(user,()=>{
        if(getUser()!==user) return;
        const current=readMomentum(storage,key(user));
        current.enabled=enabled; storage.setItem(key(user),JSON.stringify(current)); account=current; error='';
      });
    } catch(e) { error='Inställningen kunde inte sparas: '+e.message; }
    await refresh(true);
  };
  async function reset(){
    const user=getUser();if(!user||resetting)return;
    const token=++generation;resetting=true;render();
    try{
      await exclusive(user,()=>{
        if(getUser()!==user||token!==generation)return;
        const accountKey=key(user),raw=storage.getItem(accountKey),fresh=newMomentumAccount();
        // Archive first. A failed archive or reset leaves the saved account intact.
        if(raw!==null){
          let suffix=now(),backupKey=accountKey+':before-reset:'+suffix;
          while(storage.getItem(backupKey)!==null)backupKey=accountKey+':before-reset:'+(++suffix);
          storage.setItem(backupKey,raw);
        }
        storage.setItem(accountKey,JSON.stringify(fresh));
        uid=user;account=fresh;snapshot=null;error='';lastCheck=-Infinity;
      });
    }catch(e){if(getUser()===user)error='Återställningen misslyckades: '+e.message;}
    finally{
      resetting=false;
      try{sync();}catch(e){account=null;error=e.message;}
      render();
    }
  }
  async function refreshLive(){
    if(resetting)return;
    try{sync();}catch(e){account=null;error=e.message;render();return;}
    render();
    if(!uid||!isActive()||quoteBusy||!account.sleeves.some(s=>s.position)||now()-lastQuoteCheck<QUOTE_INTERVAL)return;
    const user=uid,token=generation,positions=quoteKey,symbols=account.sleeves.filter(s=>s.position).map(s=>s.symbol);
    quoteBusy=true;lastQuoteCheck=now();
    try{
      const fetched=await fetchMomentumQuotes(grab,symbols,now);
      if(getUser()!==user||token!==generation||!isActive())return;
      sync();
      if(positions!==quoteKey)return;
      acceptQuotes(fetched);quoteFailed=false;
    }catch(e){if(getUser()===user&&token===generation)quoteFailed=true;}
    finally{
      quoteBusy=false;
      try{sync();}catch(e){account=null;error=e.message;}
      render();
    }
  }
  root.querySelector('[data-momentum-reset]').onclick=reset;
  root.querySelector('[data-momentum-export]').onclick=()=>{
    try {
      sync(); if(!account) return;
      const url=URL.createObjectURL(new Blob([JSON.stringify({format:'riptide-momentum-v1',exportedAt:now(),rules:MOMENTUM,account},null,2)],{type:'application/json'}));
      const a=document.createElement('a'); a.href=url;a.download='riptide-momentum.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(e) { error=e.message; render(); }
  };
  return { refresh, refreshLive, reset };
}
