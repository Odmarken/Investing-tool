import {FLOOR,ROOMS,newFirm,readFirm,validateFirm,firmKey,equityKey,advanceFirm,advanceFirmRisk,setFirmPaused,heldSymbols,firmLive,firmStats,readEquity,sampleEquity,riskRows,floorNarrative,traderNames,needsHourly,upgradeStoredFirm} from './trading-floor.js';
import {TREND,trendLiquidation} from './floor-trend.js';
import {fetchTrendMarket,fetchTrendRisk} from './floor-trend-market.js';
import {fetchMomentumQuotes,QUOTE_INTERVAL,QUOTE_TTL} from './crypto-momentum-live.js';
import {CONTRACTS} from './bybit-contracts.js';
import {createScene,createAgents,stepAgents} from './trading-floor-scene.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const newsLink=value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;}};
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const number=(x,d=2)=>finite(x)?x.toLocaleString('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d}):'–';
const money=x=>finite(x)?number(x)+' $':'–';
const signed=x=>finite(x)?(x>=0?'+':'')+money(x):'–';
const signedPct=x=>finite(x)?(x>=0?'+':'')+number(x*100,2)+' %':'–';
const price=n=>finite(n)?n.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:n<.01?10:n<1?6:2})+' $':'–';
const date=t=>finite(t)&&t>0?new Date(t).toLocaleString('sv-SE',{timeZone:'Europe/Stockholm',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'–';
const clock=t=>finite(t)&&t>0?new Date(t).toLocaleTimeString('sv-SE',{timeZone:'Europe/Stockholm',hour:'2-digit',minute:'2-digit'}):'–';
const cls=x=>!finite(x)?'dim':x>=0?'pos':'neg';
const REASON={trend:'Trenden vände',likvidation:'Likvidation'};
const ACTION={köp:'köper',öka:'ökar',minska:'minskar',sälj:'säljer allt',behåll:'behåller',avvakta:'avvaktar',pausad:'pausad, ökar inte'};
const STATUS={trade:'I affär',waiting:'Väntar på trend',paused:'Pausad'};
const ROLE_TEXT={
  elias:'Chefen. Sitter i hörnrummet med firmans siffror, går ut på golvet och tittar över axeln på borden som är i affär.',
  pablo:'Analytikern. Läser bara det kontona vet, precis som i signalkorten. Ingen prognos, ingen API.',
  manuel:'Makro och nyheter. Står vid nyhetsskärmen och väger rubrikerna om världen och krypto.',
  miguel:'Riskchefen. Håller koll på exponering, avståndet till trendstoppen och till likvidation. Går till bordet vars första stopp ligger närmast.'
};

// cloud (optional): {available(), subscribe(uid,onState), initialize(uid,{firm,equity}), togglePause(uid), reset(uid)}.
// With a cloud store the firm is read from it and traded by the cloud runner;
// this page then only fetches quotes for the live figures, pauses and resets.
export function mountFloor(root,{getUser,getEmail=()=>'',isActive,isVisible=()=>false,grab,getNews=()=>({items:[],bias:0}),loadWorldNews=null,cloud=null,
  storage={getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value)},locks=globalThis.navigator?.locks,now=()=>Date.now(),
  confirm=message=>globalThis.confirm?globalThis.confirm(message):true,raf=globalThis.requestAnimationFrame?globalThis.requestAnimationFrame.bind(globalThis):null,
  reducedMotion=()=>!!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches}){
  root.innerHTML=`<div class="floor-stage" data-floor-stage>
    <canvas class="floor-canvas" data-floor-canvas tabindex="0" role="application" aria-label="Trading floor: isometriskt kontor med fyra rum, sex handelsbord, storskärm och nyhetsskärm. Dra för att panorera, scrolla eller nyp för att zooma, dubbelklicka för att återställa vyn. Klicka på bord, rum och skärmar för detaljer. Piltangenter panorerar, plus och minus zoomar, 0 återställer."></canvas>
    <div class="floor-heading"><div class="floor-heading-text"><div class="floor-eyebrow">RIPTIDE / KRYPTO / TRADING FLOOR</div><h1 id="floorTitle" tabindex="-1">Trading floor</h1>
      <p class="floor-status" data-floor-status role="status" aria-live="polite"></p>
      <details class="floor-about"><summary>Om golvet</summary><p>Sex bord med 100 $ vardera, ett coin per bord. Varje bord följer nio trender från 5 till 360 dygn på timstängningar och håller en lång position som växer med antalet trender uppåt och krymper med coinets volatilitet. Demo med riktiga Bybit-priser; inga order skickas.</p>
      <p>Traders sitter vid bordet under affär och rör sig fritt annars. Klicka på bord, rum och skärmar. Dra för att panorera, scrolla eller nyp för att zooma, dubbelklicka för att återställa vyn.</p>
      <p>Bordets etikett visar den pågående affärens öppna nettovinst i procent av bordets kapital när affären öppnades, samma som ”Öppet netto” i detaljpanelen. Vid +20 % blir det pengapistoler, vid +50 % cigarrer och pengasäckar. Tidigare affärer räknas inte. Firandet upphör under gränsen, vid avslut eller när färska priser saknas.</p>
      <p>Med molnlagring ligger firman i Firestore och handlas av molnfunktionen varje minut, även när sidan är stängd. Utan moln sparas den per inloggning i denna webbläsare och kräver öppen kryptosida. Regeln var bäst av sju i ett historiskt test 2021–2026 och klarade valideringen där, men det är ett demospel med riktiga priser, inte ett löfte om vinst.</p></details></div>
    <div class="floor-actions"><button type="button" class="btn" data-floor-pause></button><button type="button" class="btn" data-floor-reset title="Arkivera firman och börja om med sex nya bord på 100 $">Återställ firman</button><a class="btn" href="#">← Tillbaka till signaler</a></div></div>
    <div class="floor-zoom"><button type="button" data-floor-zoom="in" aria-label="Zooma in" title="Zooma in">+</button><button type="button" data-floor-zoom="out" aria-label="Zooma ut" title="Zooma ut">−</button><button type="button" data-floor-zoom="reset" aria-label="Återställ vyn" title="Återställ vyn (dubbelklick i bilden)">⌂</button></div>
    <div class="floor-panel" data-floor-panel hidden></div></div>
    <div class="modal floor-modal" data-floor-modal><div class="box"><div class="ph"><span class="accent"></span><h2 data-floor-modal-title></h2><span class="right"><button type="button" class="btn" data-floor-modal-close>✕ Stäng</button></span></div><div class="floor-modal-body" data-floor-modal-body></div></div></div>`;
  const q=selector=>root.querySelector(selector);
  const canvas=q('[data-floor-canvas]'),panelEl=q('[data-floor-panel]'),modalEl=q('[data-floor-modal]');
  const scene=createScene(canvas),agents=createAgents();
  let uid=null,firm=null,equity=[],live=null,error='',riskError='',busy=false,quoteBusy=false,quoteFailed=false,resetting=false;
  let lastCheck=-Infinity,lastQuote=-Infinity,generation=0,riskIndex=0,quotes={},lastTotal=null,tradeCounts={};
  let panel=null,modal=null,worldNews=[],worldAt=-Infinity,worldBusy=false,running=false,lastFrame=0,typing=null,sceneView=null,sceneWorld={inTrade:{},riskDesk:null,reduced:false};
  let cloudUnsub=null,cloudUid=null,cloudState=null,cloudError='',migrating=false,cloudGeneration=0,frameEpoch=0;
  const cloudOn=()=>!!cloud&&typeof cloud.available==='function'&&cloud.available();
  const exclusive=(user,callback)=>locks?.request?locks.request(firmKey(user),callback):Promise.reject(Error('Trading floor kräver en webbläsare med stöd för säkra fliklås'));
  const ensure=key=>{if(storage.getItem(key)===null)storage.setItem(key,JSON.stringify(newFirm(now())));};
  function attachCloud(){
    const want=cloudOn()?uid:null;
    if(want===cloudUid)return;
    if(cloudUnsub){cloudUnsub();cloudUnsub=null;}
    cloudUid=want;cloudState=null;cloudError='';migrating=false;cloudGeneration++;generation++;
    if(!want)return;
    const user=want,subscription=cloudGeneration;
    cloudUnsub=cloud.subscribe(user,state=>{
      if(user!==cloudUid||subscription!==cloudGeneration)return;
      if(state?.error){cloudError='Molnet: '+state.error;render();return;}
      cloudError='';
      if(state?.missing){void migrate(user);return;}
      if(state?.legacy){cloudState=null;firm=null;void upgradeCloud(user);render();return;}
      cloudState=state;
      try{sync();}catch(e){firm=null;error=e.message;}
      render();
    });
  }
  // The first cloud sync uploads this browser's firm once so its history is kept.
  async function migrate(user){
    if(migrating)return;migrating=true;const subscription=cloudGeneration;
    try{
      let local=null,points=[];
      try{if(storage.getItem(firmKey(user))!==null)local=readFirm(storage,firmKey(user),now());points=readEquity(storage,equityKey(user));}catch(e){local=null;points=[];}
      await cloud.initialize(user,{firm:local??newFirm(now()),equity:points});
    }catch(e){if(subscription===cloudGeneration){cloudError='Kunde inte ladda upp firman till molnet: '+e.message;render();}}
    finally{if(subscription===cloudGeneration)migrating=false;}
  }
  // The old SL/TP firm in the cloud is archived once and replaced by trend desks.
  async function upgradeCloud(user){
    if(migrating)return;migrating=true;const subscription=cloudGeneration;
    try{await cloud.upgrade(user);}
    catch(e){if(subscription===cloudGeneration){cloudError='Kunde inte byta firman till trendborden: '+e.message;render();}}
    finally{if(subscription===cloudGeneration)migrating=false;}
  }
  // Inside the tab lock: archive an old local firm, then make sure a firm exists.
  const prepare=user=>{const key=firmKey(user);upgradeStoredFirm(storage,key,equityKey(user),now());ensure(key);return key;};
  function sync(){
    const user=getUser();
    if(user!==uid){uid=user;firm=null;equity=[];live=null;error='';riskError='';lastCheck=-Infinity;lastQuote=-Infinity;quotes={};lastTotal=null;tradeCounts={};panel=null;modal=null;generation++;stopTyping();panelEl.hidden=true;modalEl.classList?.remove('show');}
    attachCloud();
    if(!uid)return uid;
    if(cloudUid){
      if(cloudState){firm=validateFirm(cloudState.firm);equity=Array.isArray(cloudState.equity)?cloudState.equity:[];}else firm=null;
    }else{firm=readFirm(storage,firmKey(uid),now());try{equity=readEquity(storage,equityKey(uid));}catch(e){equity=[];}}
    return uid;
  }
  function acceptQuotes(market){
    for(const [symbol,m] of Object.entries(market??{}))if(m&&finite(m.price)&&finite(m.mark)&&finite(m.at)&&(!quotes[symbol]||m.at>=quotes[symbol].at))quotes[symbol]={price:m.price,mark:m.mark,at:m.at};
  }
  function sampleNow(){
    if(!uid||!firm)return;
    live=firmLive(firm,quotes,now());
    if(live.total===null)return;
    lastTotal={value:live.total,at:live.at??now()};
    if(cloudUid)return;
    const next=sampleEquity(equity,now(),live.total);
    if(next!==equity){equity=next;try{storage.setItem(equityKey(uid),JSON.stringify(equity));}catch(e){/* chart only */}}
  }
  function newsItems(){
    const crypto=(getNews()?.items??[]).map(n=>({...n,world:false})),all=[...crypto,...worldNews.map(n=>({...n,world:true}))];
    const seen=new Set(),out=[];
    for(const n of all.filter(n=>n&&n.title).sort((a,b)=>(b.ts||0)-(a.ts||0))){
      const key=String(n.title).toLowerCase().replace(/[^a-z0-9åäö ]/g,'').slice(0,60);
      if(!key||seen.has(key))continue;seen.add(key);
      out.push({ts:n.ts,title:n.title,src:n.src,link:newsLink(n.link),hot:!!n.an?.hot,world:n.world});
    }
    return out.slice(0,60);
  }
  async function refreshWorld(){
    if(!loadWorldNews||worldBusy||!isVisible()||now()-worldAt<600000)return;
    worldBusy=true;worldAt=now();
    try{const items=await loadWorldNews();if(Array.isArray(items))worldNews=items;}catch(e){/* keep the previous list */}
    finally{worldBusy=false;render();}
  }
  function buildView(){
    const t=now();
    // No firm yet (loading, signed out or unreadable): never show it as paused.
    if(!firm||!live){
      sceneWorld={inTrade:{},riskDesk:null,reduced:reducedMotion()};
      const problem=error||cloudError,note=!uid?'logga in':/Ladda om sidan/.test(problem)?'ladda om sidan':problem?'se statusraden':'laddar firman';
      return {desks:Object.fromEntries(FLOOR.desks.map(s=>[s,{status:'loading',pnl:null,openNet:null}])),total:{value:null,last:null,at:null,waiting:[],note},start:FLOOR.start*FLOOR.desks.length,equity:[],news:newsItems(),paused:false,loading:true,reduced:reducedMotion()};
    }
    const stats=firmStats(firm,t),rows=riskRows(firm,live).filter(r=>r.toFirst!==null).sort((a,b)=>a.toFirst-b.toFirst);
    sceneWorld={inTrade:Object.fromEntries(FLOOR.desks.map(s=>[s,stats.desks[s].status==='trade'])),riskDesk:rows[0]?.symbol??null,reduced:reducedMotion()};
    return {desks:Object.fromEntries(FLOOR.desks.map(s=>{const d=live.desks[s];return [s,{status:stats.desks[s].status,pnl:d.pnl,openNet:d.openNet,
      openReturn:finite(d.openReturn)?d.openReturn:null,celebrationUntil:d.quote?d.quote.at+QUOTE_TTL:0,count:stats.desks[s].count}];})),
      total:{value:live.total,last:lastTotal?.value??null,at:live.total===null?lastTotal?.at??null:(live.at??t),waiting:live.waiting},
      start:live.start,equity,news:newsItems(),paused:firm.paused,reduced:reducedMotion()};
  }
  function cloudNote(t){
    if(!cloudUid)return '';
    const run=cloudState?.lastRun;
    if(!run)return ' · körs i molnet: väntar på första molnvarvet';
    const age=t-run;
    return ' · molnet körde '+clock(run)+(age>180000?' · molnet har inte kört på '+Math.round(age/60000)+' min':'')+(cloudState?.lastError?' · molnfel: '+cloudState.lastError:'');
  }
  function render(){
    const t=now();
    if(firm)live=firmLive(firm,quotes,t);else live=null;
    const pause=q('[data-floor-pause]');pause.textContent=firm?.paused?'▶ Återuppta nya köp':'⏸ Pausa nya köp';pause.disabled=!uid||!firm||resetting;
    q('[data-floor-reset]').disabled=!uid||!firm||resetting;
    let status;const stats=firm?firmStats(firm,t):null;
    if(!uid)status='Logga in för att öppna trading floor.';
    else if(cloudError)status=cloudError;
    else if(!firm)status=error||(cloudUid?'Hämtar firman från molnet…':'Trading floor kunde inte läsas.');
    else{
      const decisions=FLOOR.desks.map(s=>stats.desks[s].decision).filter(Boolean).sort((a,b)=>b.at-a.at);
      status=riskError||error||((firm.paused?'Nya köp pausade':'Firman handlar')+(busy?' · hämtar timpriser…':'')+' · '+stats.inTrade+' av '+FLOOR.desks.length+' bord i affär'+
        (decisions.length?' · senaste timbeslut '+date(decisions[0].at):' · väntar på första timbeslutet')+
        (live.total===null&&live.waiting.length?' · väntar på pris för '+live.waiting.join(', '):live.at?' · pris '+clock(live.at):'')+
        (quoteFailed?' · senaste prisuppdatering misslyckades':'')+cloudNote(t));
      if(!isActive()&&!cloudUid)status+=' · körs bara med kryptosidan öppen';
    }
    q('[data-floor-status]').textContent=status;
    if(firm&&scene)for(const s of FLOOR.desks){const n=firm.desks[s].trades.length;if(tradeCounts[s]!==undefined&&n>tradeCounts[s])scene.burst(s,firm.desks[s].trades.at(-1).pnl>=0);tradeCounts[s]=n;}
    sceneView=buildView();
    if(panel)renderPanel();else panelEl.hidden=true;
    if(modal)renderModal();else modalEl.classList?.remove('show');
    if(scene&&!running&&isVisible())start();
    if(isVisible())void refreshWorld();
  }
  function frame(epoch){
    if(!running||epoch!==frameEpoch)return;
    if(!isVisible()){running=false;return;}
    const t=now(),dt=lastFrame?(t-lastFrame)/1000:0;lastFrame=t;
    stepAgents(agents,sceneWorld,t,dt);
    scene.draw(sceneView??buildView(),agents,t);
    raf(()=>frame(epoch));
  }
  function start(){if(running||!scene||!raf)return;running=true;lastFrame=0;const epoch=++frameEpoch;raf(()=>frame(epoch));}
  function stopTyping(){if(typing){clearInterval(typing);typing=null;}}
  function renderPanel(){
    if(!panel||!firm||!live){panelEl.hidden=true;return;}
    const t=now(),stats=firmStats(firm,t);
    const head=(title,sub)=>'<div class="floor-panel-head"><div><b>'+title+'</b><small>'+sub+'</small></div><button type="button" class="btn" data-floor-panel-close aria-label="Stäng">✕</button></div>';
    const row=(k,v,c='')=>'<div><span>'+k+'</span><b class="'+c+'">'+v+'</b></div>';
    let html='';
    if(panel.kind==='desk'){
      const symbol=panel.id,desk=firm.desks[symbol],d=live.desks[symbol],st=stats.desks[symbol],p=d.position,n=TREND.lookbacks.length;
      if(!desk){panelEl.hidden=true;return;}
      const text={trade:'I affär sedan '+date(p?.openedAt),waiting:'Väntar på att en trend ska bryta uppåt',paused:'Nya köp pausade'}[st.status],liq=trendLiquidation(desk);
      const lamps='<div class="floor-trends" role="list" aria-label="'+st.count+' av '+n+' trender uppåt">'+TREND.lookbacks.map((days,i)=>{const on=desk.signal.sides[i]===1;
        return '<span role="listitem" class="'+(on?'on':'')+'" title="'+days+' dygn'+(on?' · stopp '+esc(price(desk.signal.stops[i])):' · ingen position')+'">'+days+'d</span>';}).join('')+'</div>';
      html=head(esc(symbol),esc(CONTRACTS[symbol])+' · bord '+(FLOOR.desks.indexOf(symbol)+1)+' · 100 $ vid start')+
        '<p class="floor-panel-traders">'+traderNames(symbol).map(esc).join(' · ')+'</p>'+
        '<p class="floor-panel-state '+st.status+'">'+esc(text)+(st.waitReason?' · '+esc(st.waitReason):'')+'</p>'+
        '<h4>Trender · '+st.count+' av '+n+' uppåt</h4>'+lamps+
        '<div class="floor-panel-grid">'+row(p?'Livesaldo · netto':'Saldo',money(d.balance),cls(d.pnl))+row('Sedan start',d.pnl===null?'–':signed(d.pnl)+' · '+signedPct(d.pnl/FLOOR.start),cls(d.pnl))+
        row('Realiserat',signed(st.realized),cls(st.realized))+row('I dag',signed(st.today),cls(st.today))+
        row('Avslut',st.trades+' · '+st.wins+' vinst · '+st.losses+' förlust'+(st.liquidations?' · '+st.liquidations+' likv.':''))+row('Avgifter · funding',money(desk.fees)+' · '+money(desk.funding))+'</div>'+
        (p?'<h4>Öppen position · LONG · '+number(d.exposure,2)+'× exponering · '+money(p.units*(d.quote?.price??p.entry))+' värde</h4><div class="floor-panel-grid">'+
          row('Öppet netto',d.openNet===null?'–':signed(d.openNet)+' · '+signedPct(d.openReturn)+' av kapitalet vid köp',cls(d.openNet))+row('Snittpris',price(p.entry))+row('Markpris',price(d.quote?.mark))+
          row('Första trendstopp',price(st.stops?.first),'neg')+row('Sista trendstopp',price(st.stops?.last),'neg')+row('Likvidation',liq>0?price(liq):'ingen utan belåning','neg')+
          row('Affärens avgifter · funding',money(p.fees)+' · '+money(p.funding))+row('Största exponering',number(p.peakExposure,2)+'×')+'</div>'+
          '<p class="dim">'+esc(d.reason||'En timstängning under ett stopp tar bort den trenden och minskar positionen; under det sista stoppet säljs allt. Markpris utlöser likvidation.')+'</p>':'')+
        (desk.trades.length?'<h4>Senaste avslut</h4><table class="floor-panel-table">'+desk.trades.slice(-5).reverse().map(tr=>'<tr><td>'+date(tr.at)+'</td><td>'+esc(REASON[tr.reason]??tr.reason)+'</td><td class="'+cls(tr.pnl)+'">'+signed(tr.pnl)+'</td></tr>').join('')+'</table>':'')+
        '<p class="dim">'+(st.decision?'Senaste timbeslut '+date(st.decision.at)+': '+esc(ACTION[st.decision.action]??st.decision.action)+' · '+st.decision.count+' av '+n+' trender · mål '+number(st.decision.target,2)+'×':'Inget timbeslut ännu.')+'</p>';
    }else if(panel.kind==='room'){
      const room=ROOMS.find(r=>r.id===panel.id);if(!room){panelEl.hidden=true;return;}
      const intro='<p class="dim">'+esc(ROLE_TEXT[room.id])+'</p>';
      if(room.id==='elias'){
        const ranked=FLOOR.desks.map(s=>[s,live.desks[s].pnl]).filter(([,v])=>v!==null).sort((a,b)=>b[1]-a[1]);
        html=head(esc(room.name)+' · VD',esc(getEmail()||'din gubbe'))+intro+'<div class="floor-panel-grid">'+
          row('Firmans kapital',live.total===null?'väntar på pris':money(live.total),cls(live.net))+row('Sedan start',live.net===null?'–':signed(live.net)+' · '+signedPct(live.net/live.start),cls(live.net))+
          row('Realiserat i dag',signed(stats.today),cls(stats.today))+row('Bord i affär',stats.inTrade+' av '+FLOOR.desks.length)+
          row('Bästa bord',ranked.length?ranked[0][0]+' '+signed(ranked[0][1]):'–',ranked.length?cls(ranked[0][1]):'')+row('Sämsta bord',ranked.length?ranked.at(-1)[0]+' '+signed(ranked.at(-1)[1]):'–',ranked.length?cls(ranked.at(-1)[1]):'')+
          row('Avslut',stats.trades+' · '+stats.wins+' vinst · '+stats.losses+' förlust')+row('Avgifter · funding',money(stats.fees)+' · '+money(stats.funding))+'</div>'+
          '<p class="dim">'+(firm.paused?'Nya köp är pausade. Borden kan bara minska eller sälja när trender vänder.':'Firman handlar. Varje bord fattar ett beslut per timme och köper mer ju fler av de nio trenderna som pekar uppåt.')+(cloudUid?' Firman ligger i molnet och handlas av molnfunktionen, även när sidan är stängd.':' Firman sparas i denna webbläsare.')+'</p>';
      }else if(room.id==='pablo'){
        html=head(esc(room.name)+' · Analys','läser golvet')+intro+'<div class="floor-pablo" data-floor-pablo></div><p class="dim">Lokal läsning av det kontona vet. Klicka i texten för att hoppa till slutet.</p>';
      }else if(room.id==='miguel'){
        const rows=riskRows(firm,live),value=rows.reduce((sum,r)=>sum+(r.mark??r.entry)*r.units,0),n=TREND.lookbacks.length,pc=(x,d)=>x===null?'–':number(x*100,d)+' %';
        html=head(esc(room.name)+' · Risk',rows.length?rows.length+' öppna positioner':'inga öppna positioner')+intro+
          '<div class="floor-panel-grid">'+row('Positionernas värde',money(value))+row('Mot firmans kapital',live.total?number(value/live.total,2)+'×':'–')+
          row('Närmast första stopp',rows.filter(r=>r.toFirst!==null).sort((a,b)=>a.toFirst-b.toFirst)[0]?.symbol??'–')+row('Likvidationer',String(stats.liquidations),stats.liquidations?'neg':'')+'</div>'+
          (rows.length?'<table class="floor-panel-table"><tr><th>Bord</th><th>Trend</th><th>Exp.</th><th title="Avstånd till första trendstoppet">Första</th><th title="Avstånd till sista trendstoppet">Sista</th><th title="Avstånd till likvidation">Likv.</th></tr>'+rows.map(r=>'<tr><td><b>'+r.symbol+'</b></td><td>'+r.count+'/'+n+'</td><td>'+number(r.exposure,1)+'×</td><td class="neg">'+pc(r.toFirst,1)+'</td><td class="neg">'+pc(r.toLast,1)+'</td><td>'+pc(r.toLiq,0)+'</td></tr>').join('')+'</table><p class="dim">Avstånd från markpriset till stoppen och till likvidation.</p>':'')+
          '<p class="dim">Regler per bord: positionen är andelen trender uppåt × 100 % årsvolatilitet delat med coinets volatilitet, högst 4× bordets kapital. Hela bordets kapital är marginal. Stoppen gäller timstängningar, så en snabb rörelse inom timmen kan gå förbi dem; likvidation kontrolleras på markpris.</p>';
      }else{
        const news=newsItems(),bias=getNews()?.bias??0,hot=news.filter(n=>n.hot).slice(0,4),latest=news.filter(n=>!hot.includes(n)).slice(0,4);
        html=head(esc(room.name)+' · Makro & nyheter',news.length+' rubriker på skärmen')+intro+
          '<div class="floor-panel-grid">'+row('Kryptobias i flödet',(bias>0?'+':'')+number(bias,0)+' av 100',bias>10?'pos':bias<-10?'neg':'')+row('Rubriker',news.length+' · '+news.filter(n=>n.world).length+' om världen')+'</div>'+
          (hot.length?'<h4>Rubriker som sticker ut</h4><ul class="floor-panel-news">'+hot.map(n=>'<li><span>'+clock(n.ts)+'</span>'+esc(n.title)+'</li>').join('')+'</ul>':'')+
          (latest.length?'<h4>Senaste</h4><ul class="floor-panel-news">'+latest.map(n=>'<li><span>'+clock(n.ts)+'</span>'+esc(n.title)+'</li>').join('')+'</ul>':'')+
          '<p class="dim">Analysreglerna är skrivna för Nasdaq och ger mest neutralt på kryptorubriker. Ingen bias styr borden; de följer bara sina trender.</p>';
      }
    }else if(panel.kind==='fika'){
      const here=agents.filter(a=>a.state!=='walking'&&['fika','sofa','coffee'].includes(a.at?.kind)).map(a=>esc(a.name)+(a.kind==='trader'?' ('+a.desk+')':''));
      const cooler=agents.filter(a=>a.state!=='walking'&&a.at?.kind==='cooler').map(a=>esc(a.name));
      html=head('Fikarummet','kaffe, soffa och en vattenautomat på golvet')+'<p>'+(here.length?'Här sitter just nu: '+here.join(', ')+'.':'Tomt just nu. Alla sitter vid borden eller är på väg.')+'</p>'+
        (cooler.length?'<p>Vid vattenautomaten: '+cooler.join(', ')+'.</p>':'')+'<p class="dim">Traders utan öppen affär rör sig fritt på kontoret. När bordets coin får en signal och köpet går igenom skyndar alla fyra tillbaka till sina platser.</p>';
    }
    panelEl.hidden=false;panelEl.innerHTML=html;
    stopTyping();
    if(panel.kind==='room'&&panel.id==='pablo'){
      const box=q('[data-floor-pablo]'),text=floorNarrative(firm,live,stats,t);let i=0;
      const draw=()=>{box.innerHTML=esc(text.slice(0,i))+(i<text.length?'<span class="mark"></span>':'');};
      draw();
      if(reducedMotion()||!globalThis.setInterval){i=text.length;draw();}
      else{typing=setInterval(()=>{i=Math.min(text.length,i+(text[i]==='\n'?1:2));draw();if(i>=text.length)stopTyping();},14);
        box.onclick=()=>{stopTyping();i=text.length;draw();};}
    }
  }
  function equitySVG(points,start,total,t){
    const pts=points.slice();if(total!==null)pts.push({t,v:total});
    if(pts.length<2)return '<div class="floor-empty">Kapitalkurvan ritas när minutprover finns. Första provet tas vid nästa prisuppdatering.</div>';
    const minT=pts[0].t,maxT=Math.max(minT+1,pts.at(-1).t);let lo=Math.min(start,...pts.map(p=>p.v)),hi=Math.max(start,...pts.map(p=>p.v));const pad=Math.max(.5,(hi-lo)*.12);lo-=pad;hi+=pad;
    const x=tt=>62+(tt-minT)/(maxT-minT)*816,y=v=>180-(v-lo)/(hi-lo)*152,up=pts.at(-1).v>=start,col=up?'#28724e':'#b1493b';
    const path=pts.map((p,i)=>(i?'L':'M')+x(p.t).toFixed(2)+' '+y(p.v).toFixed(2)).join(' ');
    const grid=[0,.5,1].map(f=>{const v=lo+(hi-lo)*f,yy=y(v);return '<line x1="62" y1="'+yy+'" x2="878" y2="'+yy+'" stroke="#d1ccbf"/><text x="54" y="'+(yy+4)+'" text-anchor="end" fill="#65685f" font-size="11">'+number(v,0)+'</text>';}).join('');
    return '<svg class="floor-equity" viewBox="0 0 900 218" role="img" aria-label="Firmans kapital över tid">'+grid+'<line x1="62" y1="'+y(start)+'" x2="878" y2="'+y(start)+'" stroke="#70776b" stroke-dasharray="4 4"/>'+
      '<path d="'+path+' L'+x(pts.at(-1).t).toFixed(2)+' 180 L'+x(pts[0].t).toFixed(2)+' 180 Z" fill="'+col+'" opacity=".12"/><path d="'+path+'" fill="none" stroke="'+col+'" stroke-width="2.5" vector-effect="non-scaling-stroke"/>'+
      '<text x="62" y="208" fill="#65685f" font-size="11">'+date(minT)+'</text><text x="878" y="208" text-anchor="end" fill="#65685f" font-size="11">'+date(maxT)+'</text></svg>';
  }
  function renderModal(){
    if(!modal||!firm||!live){modalEl.classList?.remove('show');return;}
    const t=now(),stats=firmStats(firm,t);
    const tile=(label,value,c='')=>'<div class="floor-tile"><span>'+label+'</span><b class="'+c+'">'+value+'</b></div>';
    let title,body;
    if(modal==='equity'){
      title='Storskärm · firmans kapital';
      body='<div class="floor-tiles">'+tile('Kapital · live',live.total===null?money(lastTotal?.value)+(lastTotal?' (senast '+clock(lastTotal.at)+')':''):money(live.total),cls(live.net))+
        tile('Sedan start',live.net===null?'–':signed(live.net)+' · '+signedPct(live.net/live.start),cls(live.net))+tile('Realiserat i dag',signed(stats.today),cls(stats.today))+tile('Bord i affär',stats.inTrade+' av '+FLOOR.desks.length)+'</div>'+
        (live.waiting.length?'<p class="dim">Väntar på färska priser för '+live.waiting.join(', ')+'. Totalen visas när alla bord har pris.</p>':'')+equitySVG(equity,live.start,live.total,t)+
        '<table class="floor-panel-table floor-modal-table"><tr><th>Bord</th><th>Status</th><th>Saldo</th><th>Sedan start</th><th>Öppet netto</th><th>Realiserat</th><th>Avslut</th></tr>'+
        FLOOR.desks.map(s=>{const d=live.desks[s],st=stats.desks[s];return '<tr><td><b>'+s+'</b></td><td>'+STATUS[st.status]+'</td><td>'+money(d.balance)+'</td><td class="'+cls(d.pnl)+'">'+signed(d.pnl)+'</td><td class="'+cls(d.openNet)+'">'+(d.position?signed(d.openNet):'–')+'</td><td class="'+cls(st.realized)+'">'+signed(st.realized)+'</td><td>'+st.trades+'</td></tr>';}).join('')+'</table>'+
        '<p class="dim">Kurvan är minutprover av firmans livesaldo, netto efter köpavgift, funding och beräknade stängningskostnader. Högst 24 timmar syns på väggskärmen; här visas hela den sparade historiken (högst 1 440 prover).</p>';
    }else{
      const news=newsItems();
      title='Nyhetsskärm · världen & krypto';
      body=news.length?'<ul class="floor-news-list">'+news.map(n=>'<li><span class="floor-news-time">'+clock(n.ts)+'</span><span class="floor-news-tag '+(n.world?'world':'crypto')+'">'+(n.world?'Världen':'Krypto')+'</span>'+
        (n.link&&n.link!=='#'?'<a href="'+esc(n.link)+'" target="_blank" rel="noopener">'+esc(n.title)+'</a>':esc(n.title))+(n.hot?' <em>het</em>':'')+'<small>'+esc(n.src||'')+'</small></li>').join('')+'</ul>':
        '<div class="floor-empty">Inga rubriker ännu. Flödet fylls på vid nästa uppdatering av sidan.</div>';
      body+='<p class="dim">Kryptorubrikerna är sidans vanliga kryptoflöde. Rubrikerna om världen hämtas från dina vanliga RSS-källor var tionde minut medan golvet är öppet.</p>';
    }
    q('[data-floor-modal-title]').textContent=title;q('[data-floor-modal-body]').innerHTML=body;modalEl.classList?.add('show');
  }
  function pick(target){
    stopTyping();
    if(!target){panel=null;panelEl.hidden=true;render();return;}
    if(target.kind==='screen'){modal=target.id;renderModal();render();return;}
    panel={kind:target.kind,id:target.id};render();
  }
  function closeModal(){modal=null;modalEl.classList?.remove('show');render();}
  async function refresh(force=false){
    if(resetting)return;
    try{sync();}catch(e){firm=null;error=e.message;render();return;}
    render();
    if(cloudUid)return;
    // One decision per hour for every desk; the minute gate spaces out retries after a failed fetch.
    if(!uid||!firm||!isActive()||busy||quoteBusy||!force&&now()-lastCheck<60000||!needsHourly(firm,now()))return;
    const user=uid,token=generation;
    busy=true;lastCheck=now();render();
    try{
      const fetched=await fetchTrendMarket(grab,now,firm.desks);
      if(getUser()!==user||token!==generation||!isActive())return;
      await exclusive(user,()=>{
        if(getUser()!==user||token!==generation||!isActive())return;
        const key=prepare(user);
        const current=readFirm(storage,key,now()),next=advanceFirm(current,fetched,now());
        // Commit before showing a simulated fill. A failed write leaves no in-memory trade.
        if(next!==current)storage.setItem(key,JSON.stringify(next));
        firm=next;error='';riskError='';acceptQuotes(fetched.market);quoteFailed=false;
      });
    }catch(e){if(getUser()===user&&token===generation)error='Handeln väntar: '+e.message;}
    finally{busy=false;try{sync();}catch(e){firm=null;error=e.message;}sampleNow();render();}
  }
  async function refreshLive(){
    if(resetting)return;
    try{sync();}catch(e){firm=null;error=e.message;render();return;}
    if(!uid||!isActive()||busy||quoteBusy||!firm||now()-lastQuote<QUOTE_INTERVAL){render();return;}
    const user=uid,token=generation,held=heldSymbols(firm);
    quoteBusy=true;lastQuote=now();
    try{
      if(held.length){
        const results=await Promise.allSettled(held.map(symbol=>fetchMomentumQuotes(grab,[symbol],now)));
        if(getUser()!==user||token!==generation||!isActive())return;
        quoteFailed=false;for(const r of results)if(r.status==='fulfilled')acceptQuotes(r.value);else quoteFailed=true;
        // Cloud mode: the cloud runner trades and settles funding and liquidation; the page only quotes.
        if(cloudUid)return;
        // The desks take turns settling funding and liquidation on mark price history.
        const symbol=held[riskIndex++%held.length],fetched=await fetchTrendRisk(grab,now,{[symbol]:firm.desks[symbol]});
        if(getUser()!==user||token!==generation||!isActive())return;
        await exclusive(user,()=>{
          if(getUser()!==user||token!==generation||!isActive())return;
          const key=prepare(user),current=readFirm(storage,key,now()),next=advanceFirmRisk(current,symbol,fetched,now());
          if(next!==current)storage.setItem(key,JSON.stringify(next));
          firm=next;acceptQuotes(fetched.market);riskError='';
        });
      }
    }catch(e){if(getUser()===user&&token===generation){quoteFailed=true;riskError='Skyddskontroll väntar: '+e.message;}}
    finally{quoteBusy=false;try{sync();}catch(e){firm=null;error=e.message;}sampleNow();render();}
  }
  async function togglePause(){
    try{sync();}catch(e){firm=null;error=e.message;render();return;}
    const user=getUser();if(!user||resetting)return;
    const token=++generation;
    if(cloudUid){
      try{if(!firm)throw Error('firman har inte laddats från molnet');await cloud.togglePause(user);if(getUser()===user&&token===generation)error='';}
      catch(e){if(getUser()===user&&token===generation)error='Inställningen kunde inte sparas i molnet: '+e.message;}
      render();return;
    }
    try{
      await exclusive(user,()=>{
        if(getUser()!==user||token!==generation)return;
        const key=prepare(user);
        const current=readFirm(storage,key,now()),next=setFirmPaused(current,!current.paused);
        storage.setItem(key,JSON.stringify(next));firm=next;error='';
      });
    }catch(e){error='Inställningen kunde inte sparas: '+e.message;}
    try{sync();}catch(e){firm=null;error=e.message;}
    render();
  }
  async function reset(){
    try{sync();}catch(e){firm=null;error=e.message;render();return;}
    const user=getUser();if(!user||resetting)return;
    if(!confirm('Arkivera nuvarande firma och börja om med '+FLOOR.desks.length+' × '+FLOOR.start+' $? Öppna positioner följer med i arkivet utan att stängas.'))return;
    const token=++generation;resetting=true;render();
    if(cloudUid){
      try{if(!firm)throw Error('firman har inte laddats från molnet');await cloud.reset(user);if(getUser()===user&&token===generation){quotes={};lastTotal=null;tradeCounts={};panel=null;panelEl.hidden=true;modal=null;modalEl.classList?.remove('show');error='';}}
      catch(e){if(getUser()===user)error='Återställningen misslyckades: '+e.message;}
      finally{resetting=false;try{sync();}catch(e){firm=null;error=e.message;}render();}
      return;
    }
    try{
      await exclusive(user,()=>{
        if(getUser()!==user||token!==generation)return;
        const key=firmKey(user),raw=storage.getItem(key),fresh=newFirm(now());
        // Archive first. A failed archive or write leaves the saved firm intact.
        if(raw!==null){let suffix=now(),backup=key+':before-reset:'+suffix;while(storage.getItem(backup)!==null)backup=key+':before-reset:'+(++suffix);storage.setItem(backup,raw);}
        const chart=storage.getItem(equityKey(user));if(chart!==null)storage.setItem(equityKey(user)+':before-reset:'+now(),chart);
        storage.setItem(key,JSON.stringify(fresh));
        storage.setItem(equityKey(user),'[]');
        firm=fresh;equity=[];quotes={};live=null;lastTotal=null;error='';riskError='';lastCheck=-Infinity;tradeCounts={};panel=null;
      });
    }catch(e){if(getUser()===user)error='Återställningen misslyckades: '+e.message;}
    finally{resetting=false;try{sync();}catch(e){firm=null;error=e.message;}render();}
  }
  function show(){try{sync();}catch(e){firm=null;error=e.message;}render();if(scene)start();}
  function hide(){running=false;frameEpoch++;stopTyping();panel=null;modal=null;if(panelEl)panelEl.hidden=true;modalEl.classList?.remove('show');}
  q('[data-floor-pause]').onclick=togglePause;
  q('[data-floor-reset]').onclick=reset;
  if(canvas.addEventListener&&scene){
    // Drag pans, wheel and pinch zoom around the pointer, a still click picks.
    const pointers=new Map();let drag=null,pinch=null;
    const pos=e=>scene.pointer(e.clientX,e.clientY);
    canvas.addEventListener('pointerdown',e=>{
      if(e.pointerType==='mouse'&&e.button!==0)return;
      canvas.setPointerCapture?.(e.pointerId);const p=pos(e);pointers.set(e.pointerId,p);
      if(pointers.size===1){drag={id:e.pointerId,start:p,last:p,moved:false};canvas.classList?.add('dragging');}
      else if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={dist:Math.hypot(a.x-b.x,a.y-b.y),mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};drag=null;}
    });
    canvas.addEventListener('pointermove',e=>{
      const p=pos(e);
      if(pointers.has(e.pointerId))pointers.set(e.pointerId,p);
      if(pinch&&pointers.size===2){
        const [a,b]=[...pointers.values()],dist=Math.hypot(a.x-b.x,a.y-b.y),mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
        if(pinch.dist>0)scene.zoomAt(mid.x,mid.y,dist/pinch.dist);scene.panBy(mid.x-pinch.mid.x,mid.y-pinch.mid.y);pinch={dist,mid};return;
      }
      if(drag&&drag.id===e.pointerId){
        if(!drag.moved&&Math.hypot(p.x-drag.start.x,p.y-drag.start.y)>5)drag.moved=true;
        if(drag.moved)scene.panBy(p.x-drag.last.x,p.y-drag.last.y);drag.last=p;return;
      }
      const h=scene.hitTest(p.x,p.y);scene.setHover(h);canvas.style.cursor=h?'pointer':'';
    });
    const finish=e=>{
      const p=pos(e);
      if(drag&&drag.id===e.pointerId&&!drag.moved&&!pinch)pick(scene.hitTest(p.x,p.y));
      pointers.delete(e.pointerId);
      if(pointers.size<2&&pinch){pinch=null;const rest=[...pointers.entries()][0];if(rest)drag={id:rest[0],start:rest[1],last:rest[1],moved:true};}
      if(drag&&drag.id===e.pointerId)drag=null;
      if(!pointers.size)canvas.classList?.remove('dragging');
    };
    canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',finish);
    canvas.addEventListener('pointerleave',()=>{if(!drag)scene.setHover(null);});
    canvas.addEventListener('wheel',e=>{e.preventDefault();const p=pos(e),delta=e.deltaMode===1?e.deltaY*16:e.deltaY;scene.zoomAt(p.x,p.y,Math.exp(-delta*0.0015));},{passive:false});
    canvas.addEventListener('dblclick',e=>{e.preventDefault();scene.resetView();});
    canvas.addEventListener('keydown',e=>{
      const step=48,vp=scene.viewport(),pan={ArrowLeft:[step,0],ArrowRight:[-step,0],ArrowUp:[0,step],ArrowDown:[0,-step]}[e.key];
      if(pan)scene.panBy(...pan);else if(e.key==='+'||e.key==='=')scene.zoomAt(vp.width/2,vp.height/2,1.25);else if(e.key==='-')scene.zoomAt(vp.width/2,vp.height/2,.8);else if(e.key==='0')scene.resetView();else return;
      e.preventDefault();
    });
  }
  if(root.addEventListener){
    root.addEventListener('click',e=>{
      const zoom=e.target.closest?.('[data-floor-zoom]');
      if(zoom&&scene){const vp=scene.viewport(),mode=zoom.dataset.floorZoom;if(mode==='reset')scene.resetView();else scene.zoomAt(vp.width/2,vp.height/2,mode==='in'?1.25:.8);return;}
      if(e.target.closest?.('[data-floor-panel-close]')){pick(null);return;}
      if(e.target.closest?.('[data-floor-modal-close]')||e.target===modalEl)closeModal();
    });
    root.addEventListener('keydown',e=>{if(e.key==='Escape'){if(modal)closeModal();else if(panel)pick(null);}});
  }
  return {refresh,refreshLive,reset,togglePause,pick,show,hide};
}
