import { ACTIVE as MOMENTUM, readActiveAccount as readMomentum, newActiveAccount as newMomentumAccount, advanceActiveAccount as advanceMomentum, fetchActiveSnapshot as fetchMomentumSnapshot, fetchActiveRisk, advanceActiveRisk } from './crypto-momentum-active.js';
import {ACTIVE_PROFILES} from './crypto-momentum-active-signal.js';
import {ACTIVE_RESEARCH} from './crypto-momentum-active-research.js';
import {liquidationPrice} from './crypto-leverage.js';
import {momentumLiveValue,QUOTE_INTERVAL} from './crypto-momentum-live.js';
const money = n => !Number.isFinite(n) ? '–' : n.toFixed(2)+' $';
const price = n => !Number.isFinite(n) ? '–' : n.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:n<.01?10:n<1?6:2})+' $';
const date = t => t ? new Date(t).toLocaleString('sv-SE',{timeZone:'Europe/Stockholm'}) : '–';
const signed = n => (n>=0?'+':'')+n.toFixed(2);
const time = t => new Date(t).toLocaleTimeString('sv-SE',{timeZone:'Europe/Stockholm'});
export function mountMomentum(root, { getUser, isActive, grab, rulesRoot = null, storage = {getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value)}, locks = navigator.locks, now = () => Date.now() }) {
  root.innerHTML = `<div class="ai-top"><label><input type="checkbox" data-momentum-toggle> AI-momentum · aktiv demo med SL / TP</label>
    <button type="button" class="btn" data-momentum-export>Exportera momentumkonto</button>
    <button type="button" class="btn" data-momentum-reset title="Arkivera nuvarande momentumkonto och börja om med 100 $, utan öppna positioner och med automatiken pausad">Återställ till 100 $</button></div>
    <p class="dim" data-momentum-policy></p>
    <p class="dim">Teststatus: ingen profil klarade utvecklingskraven. Förvalt 12 h-experiment, inte en validerad vinnare.</p>
    <p data-momentum-status role="status" aria-live="polite"></p>
    <div class="btstats" data-momentum-balance></div>
    <p class="dim" data-momentum-live-status></p>
    <h3>Öppna positioner</h3><div data-momentum-positions></div>
    <details><summary>Avslutade affärer och beslut</summary><div class="ai-scroll" data-momentum-history></div></details>`;
  const rulesHTML=`<p>Experimentell timmomentum: BTC, ETH, SOL, XRP, DOGE, SHIB och PEPE. Medelavkastning över 14, 28 och 56 avslutade timmar på Bybits perpetualkontrakt. När kontot är ledigt kan coin med högst positivt momentum köpas vid ett nytt timbeslut. Ingen ny affär tvingas fram utan signal. Högst en position och minst en timmes karens efter avslut.</p>
    <p>Varje ny affär får fast SL och TP. SL-avståndet är det större av 2 × tim-ATR14 och 0,5 % av signalpriset. TP sätts enligt den valda profilens multipel av prisavståndet. Fasta nivåer flyttas inte bort när positionen går med förlust. Positionen stängs senast vid tidsgränsen i kortet. Nya beslut granskas ungefär varje minut; signalen ändras först när en timstapel stängs.</p>
    <p>Maximal planerad stopprisk är 50 % av kontot inklusive antagna köp-/säljkostnader. Högst 50 % av saldot låses som isolerad marginal inklusive köpavgiften. Faktisk stopprisk kan vara lägre och visas i kortet. Hävstången anpassas inom Bybits offentliga gränser så att SL ligger före beräknad likvidation med buffert vid köp. Det är inte ett löfte om stopputfall: gap och funding kan öka förlusten. Upprepade förluster kan tömma nästan hela kontot.</p>
    <p>SL och TP triggas av markpris. Var femte sekund försöker sidan uppdatera livesaldo, funding och positionsskydd. Inga nya affärer öppnas av denna snabba kontroll. Avmarkerad kryssruta stoppar nya köp; SL, TP, tidsgräns och likvidation fortsätter. Körningen kräver inloggning och öppen kryptosida. Efter frånvaro återställs historiska exits före nya köp; missade inträden hittas inte på.</p>
    <p>Saldo och öppet netto inkluderar köpavgift, bokförd funding och uppskattade stängningskostnader. Avgift 0,055 % och antagen slippage 0,05 % per sida. Kontovärdet använder senaste avslutspris, medan markpris styr skyddet. Saknade eller gamla data ger vänteläge.</p>
    <p>Detta är ett separat demokonto. Inga order eller stopp läggs på ditt riktiga Bybit-konto. Mängder är kontinuerliga i simuleringen; minsta order och orderbok modelleras inte. Risknivå, underhållsmarginal och avdrag låses vid köp. Vid likvidation förloras positionens marginal, inte fria kontanter. Tvetydiga markprisstaplar räknas som SL; gap förbi likvidation räknas som likvidation. Tidigare extrema i inträdesstapeln hoppas över och kan därför missa en snabb exit.</p>
    <p>Gamla momentumpositioner avslutas med bokförda kostnader vid övergången, utan att kontot nollställs. Historiken behålls. Återställ till 100 $ arkiverar kontot lokalt och börjar om pausat. Kontot sparas per inloggning i denna webbläsare.</p>
    <p>Den tidigare tränade AI-modellen klarade inte valideringskraven. Detta är en ny regelbaserad testvariant; tidigare resultat för dagars momentum gäller inte timstrategin.</p><div data-active-research></div>`;
  if(rulesRoot)rulesRoot.innerHTML=rulesHTML;
  else root.innerHTML+='<details><summary>Regler och historiska tester</summary>'+rulesHTML+'</details>';
  const research=(rulesRoot??root).querySelector('[data-active-research]');
  const sample=(profile,period,slip=.0005)=>ACTIVE_RESEARCH.rows.find(r=>r.profile===profile&&r.period===period&&r.slip===slip);
  const scenario=ACTIVE_RESEARCH.userRiskScenario?.rows.find(r=>r.profile===MOMENTUM.profile&&r.period==='validation'&&r.slip===.0005);
  research.innerHTML='<details><summary>Historisk jämförelse · ingen kandidat godkänd</summary><p>Retrospektivt: utveckling 14 mars–30 juni 2026, kontroll juli–augusti. Alla tre profiler jämförs vid samma 0,5 % stopprisk och högst 2× exponering. Dessa resultat gäller inte ditt 50 %-risktak.</p><div class="ai-scroll"><table><thead><tr><th>Profil</th><th>Utveckling</th><th>Juli–augusti</th><th>Dubbel slippage juli–augusti</th><th>Avslut juli–augusti</th></tr></thead><tbody>'+
    Object.keys(ACTIVE_PROFILES).map(profile=>'<tr><td>'+({pulse12:'SL/TP · 12 h',pulse24:'SL/TP · 24 h',trend24:'Utbrott · 24 h'}[profile])+'</td><td>'+signed(sample(profile,'development').returnPct)+' %</td><td>'+signed(sample(profile,'validation').returnPct)+' %</td><td>'+signed(sample(profile,'validation',.001).returnPct)+' %</td><td>'+sample(profile,'validation').n+'</td></tr>').join('')+'</tbody></table></div>'+
    (scenario?'<p>Separat scenario med ditt 50 %-tak för stopprisk och marginal: det förvalda 12 h-experimentet gav '+signed(scenario.netPct)+' % under juli–augusti. Scenariot använder dagens Bybit-riskgränser på historiska priser; det är ingen exakt historisk hävstångsrekonstruktion.</p>':'')+
    '<p>Ingen profil valdes efter kontrollperiodens resultat. Kortare hålltid och SL/TP bevisar inte lönsamhet. En ny meningsfull prövning är framtida demo med dessa frysta regler.</p></details>';
  const toggle = root.querySelector('[data-momentum-toggle]');
  let uid = null, account = null, snapshot = null, error = '', riskError='', busy = false, resetting = false, lastCheck = -Infinity, generation = 0;
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
    if (user !== uid) { uid=user; account=null; snapshot=null; error='';riskError=''; lastCheck=-Infinity; quotes={};quoteKey='';quoteFailed=false;lastQuoteCheck=-Infinity;generation++; }
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
    const profile=ACTIVE_PROFILES[account?.profile??MOMENTUM.profile];
    root.querySelector('[data-momentum-policy]').textContent='Experiment · timbeslut · 1 position · max 50 % marginal · SL + TP '+profile.rewardMultiple+'× prisavståndet · högst '+profile.maxHoldMs/MOMENTUM.hour+' h';
    const liveStatus=!hasPosition?'':live.reason||((quoteFailed?'Prisuppdateringen misslyckades · senaste pris ':'Pris uppdaterat ')+time(live.at)+' · hämtas var 5:e sekund');
    root.querySelector('[data-momentum-live-status]').textContent=liveStatus;
    root.querySelector('[data-momentum-status]').textContent = riskError || error || account?.waitReason || (!uid ? 'Logga in för momentumdemo.' :
      (account?.enabled ? 'Automatik på' : 'Nya köp pausade') + (busy ? ' · hämtar timpriser…' : '') +
      (account?.lastSignalAt ? ' · senaste timbeslut '+date(account.activeDecisions.at(-1).at)+'.' : ' · väntar på första timbeslutet.')+
      (account?.cooldownUntil>now()?' Nästa möjliga köp efter '+date(account.cooldownUntil)+'.':'')+
      (hasPosition && value===null ? ' '+live.reason+'.' : ''));
    if(account?.migrationPending)root.querySelector('[data-momentum-status]').textContent+=' Äldre positioner avslutas vid nästa kompletta skyddskontroll före övergång till SL/TP.';
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
        const p=s.position,q=live.positions[s.symbol].quote,pnl=live.positions[s.symbol].pnl;
        return '<div class="oppen momentum-position"><div class="position-top"><span class="tag long">LONG</span><b>'+s.symbol+'</b><span>'+(p.rules?.leverage??20)+'× · '+money(p.units*p.entry)+' notional</span></div>'+
          '<div class="position-live"><div><span>Livesaldo · hela kontot</span><strong class="'+cls+'" data-position-balance>'+money(value)+'</strong></div>'+
          '<div><span>Öppet resultat · netto</span><strong class="'+(pnl===null?'dim':pnl>=0?'pos':'neg')+'" data-position-pnl>'+(pnl===null?'–':signed(pnl)+' $')+'</strong><small>'+(pnl===null?'':signed(pnl/p.budget*100)+' % av marginalbudgeten')+'</small></div></div>'+
          '<div class="position-meta">'+liveStatus+' · inklusive bokförd funding och beräknade stängningskostnader</div>'+
          '<div class="position-prices"><span>Entry <b>'+price(p.entry)+'</b></span><span>Markpris <b>'+price(q?.mark)+'</b></span><span>Likvidation <b class="neg">'+price(liquidationPrice(p))+'</b></span><span>Marginalbudget <b>'+money(p.budget)+'</b></span></div>'+
          (p.sl?'<div class="position-prices"><span>SL <b class="neg">'+price(p.sl)+'</b></span><span>TP <b class="pos">'+price(p.tp)+'</b></span><span>Stängs senast <b>'+date(p.deadline)+'</b></span></div>'+
          '<div class="position-meta">Planerad SL-förlust '+money(p.initialRisk)+' ('+(p.initialRisk/p.accountAtEntry*100).toFixed(2)+' % av kontot vid köp) · netto R:R '+p.netRR.toFixed(2)+' · markpris utlöser SL/TP</div>':'<div class="position-meta">Äldre position · inväntar avslut inför övergång till SL/TP</div>')+
          '<div class="position-meta">Köpt '+date(p.at)+' · funding '+money(p.funding)+'</div></div>';
      }).join(''):'<div class="empty">Inga öppna positioner. '+(account.enabled?'Väntar på nästa giltiga timsignal och avslutad karens.':'Aktivera kryssrutan för att köra AI-momentum.')+'</div>')+
      '<p class="dim">Bevakar '+MOMENTUM.symbols.join(', ')+'. Ledigt kapital används gemensamt vid nästa köp. Saldo och öppet netto inkluderar bokförd funding och beräknade säljkostnader.</p>' : '';
    const history=JSON.stringify([uid,account?.activeDecisions,account?.decisions,account?.trades]);
    if(history!==historyStamp){
    historyStamp=history;
    root.querySelector('[data-momentum-history]').innerHTML = account ? '<p>Senaste 20 beslut och 20 avslut. Exporten innehåller hela historiken.</p><table><thead><tr><th>Beslut</th><th>Utfört</th><th>Åtgärder</th></tr></thead><tbody>'+
      [...account.decisions,...account.activeDecisions].slice(-20).reverse().map(d=>'<tr><td>'+date(d.hour??d.week)+'</td><td>'+date(d.at)+'</td><td>'+(d.signals?d.signals.map(s=>s.symbol+': '+s.action).join(' · '):(d.symbol??'Kontanter')+' · '+d.action)+'</td></tr>').join('')+
      '</tbody></table><table><thead><tr><th>Stängd</th><th>Coin</th><th>Hävstång</th><th>Orsak</th><th>Nettoresultat</th></tr></thead><tbody>'+account.trades.slice(-20).reverse().map(t=>'<tr><td>'+date(t.at)+'</td><td>'+t.symbol+'</td><td>'+(t.leverage??20)+'×</td><td>'+({SL:'SL',TP:'TP',timeout:'Tidsgräns',risk:'Marginalskydd',likvidation:'Likvidation','strategy-change':'Byte till SL/TP','single-position':'Byte till en position'}[t.reason]??'Veckosignal')+'</td><td>'+signed(t.pnl)+' $</td></tr>').join('')+'</tbody></table>' : '';
    }
  }
  async function refresh(force=false) {
    if(resetting)return;
    try { sync(); } catch(e) { account=null; error=e.message; render(); return; }
    render();
    if (!uid || !isActive() || busy || quoteBusy || !force && now()-lastCheck<60000 || !account.enabled && !account.sleeves.some(s=>s.position)) return;
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
        account=next; snapshot=fetched; error='';riskError='';alignQuotes();acceptQuotes(fetched.market);quoteFailed=false;
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
        uid=user;account=fresh;snapshot=null;error='';riskError='';lastCheck=-Infinity;
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
    if(!uid||!isActive()||busy||quoteBusy||!account.sleeves.some(s=>s.position)||now()-lastQuoteCheck<QUOTE_INTERVAL)return;
    const user=uid,token=generation,positions=quoteKey;
    quoteBusy=true;lastQuoteCheck=now();
    try{
      const fetched=await fetchActiveRisk(grab,now,account);
      if(getUser()!==user||token!==generation||!isActive())return;
      await exclusive(user,()=>{
        if(getUser()!==user||token!==generation||!isActive())return;
        sync();if(positions!==quoteKey)return;
        const next=advanceActiveRisk(account,fetched,now());
        if(next!==account)storage.setItem(key(user),JSON.stringify(next));
        account=next;alignQuotes();acceptQuotes(fetched.market);quoteFailed=false;riskError='';
      });
    }catch(e){if(getUser()===user&&token===generation){quoteFailed=true;riskError='Skyddskontroll väntar: '+e.message;}}
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
