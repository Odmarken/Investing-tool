import {FLOOR,ROOMS,newFirm,readFirm,firmKey,equityKey,firmPositions,advanceFirm,advanceFirmRisk,setFirmPaused,heldSymbols,firmLive,firmStats,readEquity,sampleEquity,riskRows,floorNarrative,traderNames} from './trading-floor.js';
import {fetchActiveSnapshot,fetchActiveRisk} from './crypto-momentum-active.js';
import {fetchMomentumQuotes,QUOTE_INTERVAL} from './crypto-momentum-live.js';
import {liquidationPrice} from './crypto-leverage.js';
import {CONTRACTS} from './bybit-contracts.js';
import {createScene,createAgents,stepAgents,CANVAS} from './trading-floor-scene.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const number=(x,d=2)=>finite(x)?x.toLocaleString('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d}):'–';
const money=x=>finite(x)?number(x)+' $':'–';
const signed=x=>finite(x)?(x>=0?'+':'')+money(x):'–';
const signedPct=x=>finite(x)?(x>=0?'+':'')+number(x*100,2)+' %':'–';
const price=n=>finite(n)?n.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:n<.01?10:n<1?6:2})+' $':'–';
const date=t=>finite(t)&&t>0?new Date(t).toLocaleString('sv-SE',{timeZone:'Europe/Stockholm',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'–';
const clock=t=>finite(t)&&t>0?new Date(t).toLocaleTimeString('sv-SE',{timeZone:'Europe/Stockholm',hour:'2-digit',minute:'2-digit'}):'–';
const cls=x=>!finite(x)?'dim':x>=0?'pos':'neg';
const REASON={SL:'SL',TP:'TP',timeout:'Tidsgräns',risk:'Marginalskydd',likvidation:'Likvidation','strategy-change':'Strategibyte'};
const STATUS={trade:'I affär',waiting:'Väntar på timsignal',cooldown:'Karens',paused:'Pausad'};
const ROLE_TEXT={
  elias:'Chefen. Sitter i hörnrummet med firmans siffror, går ut på golvet och tittar över axeln på borden som är i affär.',
  pablo:'Analytikern. Läser bara det kontona vet, precis som i signalkorten. Ingen prognos, ingen API.',
  manuel:'Riskchefen. Håller koll på marginal, planerad SL-förlust och avståndet till likvidation. Går till bordet som ligger närmast sitt stopp.',
  miguel:'Makro och nyheter. Står vid nyhetsskärmen och väger rubrikerna om världen och krypto.'
};

export function mountFloor(root,{getUser,getEmail=()=>'',isActive,isVisible=()=>false,grab,getNews=()=>({items:[],bias:0}),loadWorldNews=null,
  storage={getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value)},locks=globalThis.navigator?.locks,now=()=>Date.now(),
  confirm=message=>globalThis.confirm?globalThis.confirm(message):true,raf=globalThis.requestAnimationFrame?globalThis.requestAnimationFrame.bind(globalThis):null,
  reducedMotion=()=>!!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches}){
  root.innerHTML=`<div class="floor-heading"><div><div class="floor-eyebrow">RIPTIDE / KRYPTO / TRADING FLOOR</div><h1 id="floorTitle" tabindex="-1">Trading floor</h1>
    <p>Sex bord med 100 $ vardera, ett coin per bord. Varje bord kör samma timmomentum med SL och TP som AI-momentum, men med eget konto. Demo med riktiga Bybit-priser; inga order skickas.</p></div>
    <div class="floor-actions"><button type="button" class="btn" data-floor-pause></button><button type="button" class="btn" data-floor-reset title="Arkivera firman lokalt och börja om med sex nya bord på 100 $">Återställ firman</button><a class="btn" href="#">← Tillbaka till signaler</a></div></div>
    <p class="floor-status" data-floor-status role="status" aria-live="polite"></p>
    <div class="floor-stage"><canvas class="floor-canvas" data-floor-canvas width="${CANVAS.w}" height="${CANVAS.h}" role="img" aria-label="Isometriskt kontor: fyra rum, sex handelsbord, storskärm med firmans kapital, nyhetsskärm och fikarum. Knapparna under bilden öppnar samma detaljer."></canvas>
    <div class="floor-panel" data-floor-panel hidden></div></div>
    <div class="floor-legend" data-floor-legend></div>
    <p class="floor-footnote">Bordens konton sparas per inloggning i denna webbläsare. Timbeslut hämtas ungefär varje minut, priser var femte sekund, och skyddskontrollen (SL, TP, funding, likvidation) turas borden om att göra vid varje prisuppdatering. Kräver inloggning och öppen kryptosida. Ingen profil i AI-momentum klarade utvecklingskraven; det här är ett demospel med riktiga priser, inte en validerad strategi.</p>
    <div class="modal floor-modal" data-floor-modal><div class="box"><div class="ph"><span class="accent"></span><h2 data-floor-modal-title></h2><span class="right"><button type="button" class="btn" data-floor-modal-close>✕ Stäng</button></span></div><div class="floor-modal-body" data-floor-modal-body></div></div></div>`;
  const q=selector=>root.querySelector(selector);
  const canvas=q('[data-floor-canvas]'),panelEl=q('[data-floor-panel]'),modalEl=q('[data-floor-modal]');
  const scene=createScene(canvas),agents=createAgents();
  let uid=null,firm=null,equity=[],live=null,error='',riskError='',busy=false,quoteBusy=false,quoteFailed=false,resetting=false;
  let lastCheck=-Infinity,lastQuote=-Infinity,generation=0,riskIndex=0,quotes={},lastTotal=null,tradeCounts={};
  let panel=null,modal=null,worldNews=[],worldAt=-Infinity,worldBusy=false,running=false,lastFrame=0,typing=null,sceneView=null,sceneWorld={inTrade:{},riskDesk:null,reduced:false};
  const exclusive=(user,callback)=>locks?.request?locks.request(firmKey(user),callback):Promise.reject(Error('Trading floor kräver en webbläsare med stöd för säkra fliklås'));
  const ensure=key=>{if(storage.getItem(key)===null)storage.setItem(key,JSON.stringify(newFirm(now())));};
  function sync(){
    const user=getUser();
    if(user!==uid){uid=user;firm=null;equity=[];live=null;error='';riskError='';lastCheck=-Infinity;lastQuote=-Infinity;quotes={};lastTotal=null;tradeCounts={};panel=null;modal=null;generation++;}
    if(uid){firm=readFirm(storage,firmKey(uid),now());try{equity=readEquity(storage,equityKey(uid));}catch(e){equity=[];}}
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
    const next=sampleEquity(equity,now(),live.total);
    if(next!==equity){equity=next;try{storage.setItem(equityKey(uid),JSON.stringify(equity));}catch(e){/* chart only */}}
  }
  function newsItems(){
    const crypto=(getNews()?.items??[]).map(n=>({...n,world:false})),all=[...crypto,...worldNews.map(n=>({...n,world:true}))];
    const seen=new Set(),out=[];
    for(const n of all.filter(n=>n&&n.title).sort((a,b)=>(b.ts||0)-(a.ts||0))){
      const key=String(n.title).toLowerCase().replace(/[^a-z0-9åäö ]/g,'').slice(0,60);
      if(!key||seen.has(key))continue;seen.add(key);
      out.push({ts:n.ts,title:n.title,src:n.src,link:n.link,hot:!!n.an?.hot,world:n.world});
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
    if(!firm||!live){
      return {desks:Object.fromEntries(FLOOR.desks.map(s=>[s,{status:'paused',pnl:null,openNet:null}])),total:{value:null,last:null,at:null,waiting:[]},start:FLOOR.start*FLOOR.desks.length,equity:[],news:newsItems(),paused:true,reduced:reducedMotion()};
    }
    const stats=firmStats(firm,t),rows=riskRows(firm,live).filter(r=>r.toSl!==null).sort((a,b)=>a.toSl-b.toSl);
    sceneWorld={inTrade:Object.fromEntries(FLOOR.desks.map(s=>[s,stats.desks[s].status==='trade'])),riskDesk:rows[0]?.symbol??null,reduced:reducedMotion()};
    return {desks:Object.fromEntries(FLOOR.desks.map(s=>[s,{status:stats.desks[s].status,pnl:live.desks[s].pnl,openNet:live.desks[s].openNet}])),
      total:{value:live.total,last:lastTotal?.value??null,at:live.total===null?lastTotal?.at??null:(live.at??t),waiting:live.waiting},
      start:live.start,equity,news:newsItems(),paused:firm.paused,reduced:reducedMotion()};
  }
  function render(){
    const t=now();
    if(firm)live=firmLive(firm,quotes,t);else live=null;
    const pause=q('[data-floor-pause]');pause.textContent=firm?.paused?'▶ Återuppta nya köp':'⏸ Pausa nya köp';pause.disabled=!uid||!firm||resetting;
    q('[data-floor-reset]').disabled=!uid||resetting;
    let status;const stats=firm?firmStats(firm,t):null;
    if(!uid)status='Logga in för att öppna trading floor.';
    else if(!firm)status=error||'Trading floor kunde inte läsas.';
    else{
      const decisions=FLOOR.desks.map(s=>stats.desks[s].decision).filter(Boolean).sort((a,b)=>b.at-a.at);
      status=riskError||error||((firm.paused?'Nya köp pausade':'Firman handlar')+(busy?' · hämtar timpriser…':'')+' · '+stats.inTrade+' av '+FLOOR.desks.length+' bord i affär'+
        (decisions.length?' · senaste timbeslut '+date(decisions[0].at):' · väntar på första timbeslutet')+
        (live.total===null&&live.waiting.length?' · väntar på pris för '+live.waiting.join(', '):live.at?' · pris '+clock(live.at):'')+
        (quoteFailed?' · senaste prisuppdatering misslyckades':''));
      if(!isActive())status+=' · körs bara med kryptosidan öppen';
    }
    q('[data-floor-status]').textContent=status;
    if(firm&&scene)for(const s of FLOOR.desks){const n=firm.desks[s].trades.length;if(tradeCounts[s]!==undefined&&n>tradeCounts[s])scene.burst(s,firm.desks[s].trades.at(-1).pnl>=0);tradeCounts[s]=n;}
    const chip=(pick,label,extra='')=>'<button type="button" class="floor-chip'+(panel&&panel.kind+':'+panel.id===pick||modal&&'screen:'+modal===pick?' on':'')+'" data-floor-pick="'+pick+'">'+label+(extra?' <b>'+extra+'</b>':'')+'</button>';
    q('[data-floor-legend]').innerHTML=(firm?FLOOR.desks.map(s=>{const d=live.desks[s];return chip('desk:'+s,s,'<span class="'+cls(d.pnl)+'">'+(d.pnl===null?STATUS[stats.desks[s].status]:signed(d.pnl))+'</span>');}).join(''):'')+
      ROOMS.map(r=>chip('room:'+r.id,esc(r.name),esc(r.role))).join('')+chip('screen:equity','Storskärm','kapital')+chip('screen:news','Nyhetsskärm','')+chip('fika:fika','Fikarummet','');
    sceneView=buildView();
    if(panel)renderPanel();
    if(modal)renderModal();
    if(scene&&!running&&isVisible())start();
    if(scene&&!running&&!isVisible()){/* drawn again when shown */}
    if(isVisible())void refreshWorld();
  }
  function frame(){
    if(!running)return;
    if(!isVisible()){running=false;return;}
    const t=now(),dt=lastFrame?(t-lastFrame)/1000:0;lastFrame=t;
    stepAgents(agents,sceneWorld,t,dt);
    scene.draw(sceneView??buildView(),agents,t);
    raf(frame);
  }
  function start(){if(running||!scene||!raf)return;running=true;lastFrame=0;raf(frame);}
  function stopTyping(){if(typing){clearInterval(typing);typing=null;}}
  function renderPanel(){
    if(!panel||!firm||!live){panelEl.hidden=true;return;}
    const t=now(),stats=firmStats(firm,t);
    const head=(title,sub)=>'<div class="floor-panel-head"><div><b>'+title+'</b><small>'+sub+'</small></div><button type="button" class="btn" data-floor-panel-close aria-label="Stäng">✕</button></div>';
    const row=(k,v,c='')=>'<div><span>'+k+'</span><b class="'+c+'">'+v+'</b></div>';
    let html='';
    if(panel.kind==='desk'){
      const symbol=panel.id,desk=firm.desks[symbol],d=live.desks[symbol],st=stats.desks[symbol],p=d.position;
      if(!desk){panelEl.hidden=true;return;}
      const text={trade:'I affär sedan '+date(p?.at),waiting:'Väntar på timsignal med positivt momentum',cooldown:'Karens till '+date(desk.cooldownUntil),paused:'Nya köp pausade'}[st.status];
      html=head(esc(symbol),esc(CONTRACTS[symbol])+' · bord '+(FLOOR.desks.indexOf(symbol)+1)+' · 100 $ vid start')+
        '<p class="floor-panel-traders">'+traderNames(symbol).map(esc).join(' · ')+'</p>'+
        '<p class="floor-panel-state '+st.status+'">'+esc(text)+(st.waitReason?' · '+esc(st.waitReason):'')+'</p>'+
        '<div class="floor-panel-grid">'+row(p?'Livesaldo · netto':'Saldo',money(d.balance),cls(d.pnl))+row('Sedan start',d.pnl===null?'–':signed(d.pnl)+' · '+signedPct(d.pnl/FLOOR.start),cls(d.pnl))+
        row('Ledigt kapital',money(d.cash))+row('Realiserat',signed(st.realized),cls(st.realized))+row('I dag',signed(st.today),cls(st.today))+
        row('Avslut',st.trades+' · '+st.wins+' vinst · '+st.losses+' förlust'+(st.liquidations?' · '+st.liquidations+' likv.':''))+'</div>'+
        (p?'<h4>Öppen position · LONG '+p.rules.leverage+'× · '+money(p.units*p.entry)+' notional</h4><div class="floor-panel-grid">'+
          row('Öppet netto',d.openNet===null?'–':signed(d.openNet)+' · '+signedPct(d.openNet/p.budget)+' av marginalen',cls(d.openNet))+row('Entry',price(p.entry))+row('Markpris',price(d.quote?.mark))+
          row('SL',price(p.sl),'neg')+row('TP',price(p.tp),'pos')+row('Likvidation',price(liquidationPrice(p)),'neg')+row('Marginal',money(p.budget))+
          row('Planerad SL-förlust',money(p.initialRisk))+row('Stängs senast',date(p.deadline))+'</div>'+
          '<p class="dim">'+esc(d.reason||'Markpris utlöser SL, TP och likvidation. Funding hittills '+money(p.funding)+'.')+'</p>':'')+
        (desk.trades.length?'<h4>Senaste avslut</h4><table class="floor-panel-table">'+desk.trades.slice(-5).reverse().map(tr=>'<tr><td>'+date(tr.at)+'</td><td>'+esc(REASON[tr.reason]??tr.reason)+'</td><td class="'+cls(tr.pnl)+'">'+signed(tr.pnl)+'</td></tr>').join('')+'</table>':'')+
        '<p class="dim">'+(st.decision?'Senaste timbeslut '+date(st.decision.at)+': '+esc(st.decision.action)+(st.decision.score!==null&&finite(st.decision.score)?' · momentum '+signedPct(st.decision.score):''):'Inget timbeslut ännu.')+'</p>';
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
          '<p class="dim">'+(firm.paused?'Nya köp är pausade. Öppna positioner följer fortfarande SL, TP och tidsgräns.':'Firman handlar. Varje bord får högst ett köp per timme och en timmes karens efter avslut.')+'</p>';
      }else if(room.id==='pablo'){
        html=head(esc(room.name)+' · Analys','läser golvet')+intro+'<div class="floor-pablo" data-floor-pablo></div><p class="dim">Lokal läsning av det kontona vet. Klicka i texten för att hoppa till slutet.</p>';
      }else if(room.id==='manuel'){
        const rows=riskRows(firm,live),margin=rows.reduce((s,r)=>s+r.budget,0),risk=rows.reduce((s,r)=>s+r.initialRisk,0);
        html=head(esc(room.name)+' · Risk',rows.length?rows.length+' öppna positioner':'inga öppna positioner')+intro+
          '<div class="floor-panel-grid">'+row('Låst marginal',money(margin))+row('Planerad SL-förlust',money(risk),risk?'neg':'')+row('Andel av kapitalet',live.total?number(margin/live.total*100,1)+' % marginal · '+number(risk/live.total*100,1)+' % risk':'–')+row('Närmast SL',rows.filter(r=>r.toSl!==null).sort((a,b)=>a.toSl-b.toSl)[0]?.symbol??'–')+'</div>'+
          (rows.length?'<table class="floor-panel-table"><tr><th>Bord</th><th>Hävst.</th><th>Till SL</th><th>Till TP</th><th>Till likv.</th><th>Stängs</th></tr>'+rows.map(r=>'<tr><td><b>'+r.symbol+'</b></td><td>'+r.leverage+'×</td><td class="neg">'+(r.toSl===null?'–':number(r.toSl*100,2)+' %')+'</td><td class="pos">'+(r.toTp===null?'–':number(r.toTp*100,2)+' %')+'</td><td>'+(r.toLiq===null?'–':number(r.toLiq*100,2)+' %')+'</td><td>'+clock(r.deadline)+'</td></tr>').join('')+'</table>':'')+
          '<p class="dim">Regler per bord: högst 50 % av saldot som isolerad marginal, högst 50 % planerad SL-risk, likvidation minst 25 % av SL-avståndet under SL vid köp. Gap och funding kan ge större förlust än planerat.</p>';
      }else{
        const news=newsItems(),bias=getNews()?.bias??0,hot=news.filter(n=>n.hot).slice(0,4),latest=news.filter(n=>!hot.includes(n)).slice(0,4);
        html=head(esc(room.name)+' · Makro & nyheter',news.length+' rubriker på skärmen')+intro+
          '<div class="floor-panel-grid">'+row('Kryptobias i flödet',(bias>0?'+':'')+number(bias,0)+' av 100',bias>10?'pos':bias<-10?'neg':'')+row('Rubriker',news.length+' · '+news.filter(n=>n.world).length+' om världen')+'</div>'+
          (hot.length?'<h4>Rubriker som sticker ut</h4><ul class="floor-panel-news">'+hot.map(n=>'<li><span>'+clock(n.ts)+'</span>'+esc(n.title)+'</li>').join('')+'</ul>':'')+
          (latest.length?'<h4>Senaste</h4><ul class="floor-panel-news">'+latest.map(n=>'<li><span>'+clock(n.ts)+'</span>'+esc(n.title)+'</li>').join('')+'</ul>':'')+
          '<p class="dim">Analysreglerna är skrivna för Nasdaq och ger mest neutralt på kryptorubriker. Ingen bias styr borden; de följer bara sitt timmomentum.</p>';
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
    const x=tt=>62+(tt-minT)/(maxT-minT)*816,y=v=>180-(v-lo)/(hi-lo)*152,up=pts.at(-1).v>=start,col=up?'#3ddc84':'#ff3355';
    const path=pts.map((p,i)=>(i?'L':'M')+x(p.t).toFixed(2)+' '+y(p.v).toFixed(2)).join(' ');
    const grid=[0,.5,1].map(f=>{const v=lo+(hi-lo)*f,yy=y(v);return '<line x1="62" y1="'+yy+'" x2="878" y2="'+yy+'" stroke="#2c2160"/><text x="54" y="'+(yy+4)+'" text-anchor="end" fill="#c9b8f0" font-size="11">'+number(v,0)+'</text>';}).join('');
    return '<svg class="floor-equity" viewBox="0 0 900 218" role="img" aria-label="Firmans kapital över tid">'+grid+'<line x1="62" y1="'+y(start)+'" x2="878" y2="'+y(start)+'" stroke="#8f7fc4" stroke-dasharray="4 4"/>'+
      '<path d="'+path+' L'+x(pts.at(-1).t).toFixed(2)+' 180 L'+x(pts[0].t).toFixed(2)+' 180 Z" fill="'+col+'" opacity=".12"/><path d="'+path+'" fill="none" stroke="'+col+'" stroke-width="2.5" vector-effect="non-scaling-stroke"/>'+
      '<text x="62" y="208" fill="#c9b8f0" font-size="11">'+date(minT)+'</text><text x="878" y="208" text-anchor="end" fill="#c9b8f0" font-size="11">'+date(maxT)+'</text></svg>';
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
    if(!uid||!isActive()||busy||quoteBusy||!force&&now()-lastCheck<60000||firm.paused&&!heldSymbols(firm).length)return;
    const user=uid,token=generation;
    busy=true;lastCheck=now();render();
    try{
      const fetched=await fetchActiveSnapshot(grab,now,firmPositions(firm));
      if(getUser()!==user||token!==generation||!isActive())return;
      await exclusive(user,()=>{
        if(getUser()!==user||token!==generation||!isActive())return;
        const key=firmKey(user);ensure(key);
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
    if(!uid||!isActive()||busy||quoteBusy||now()-lastQuote<QUOTE_INTERVAL){render();return;}
    const user=uid,token=generation,held=heldSymbols(firm);
    quoteBusy=true;lastQuote=now();
    try{
      if(held.length){
        const results=await Promise.allSettled(held.map(symbol=>fetchMomentumQuotes(grab,[symbol],now)));
        if(getUser()!==user||token!==generation||!isActive())return;
        quoteFailed=false;for(const r of results)if(r.status==='fulfilled')acceptQuotes(r.value);else quoteFailed=true;
        // The desks take turns settling SL, TP, funding and liquidation on mark price history.
        const symbol=held[riskIndex++%held.length],fetched=await fetchActiveRisk(grab,now,firm.desks[symbol]);
        if(getUser()!==user||token!==generation||!isActive())return;
        await exclusive(user,()=>{
          if(getUser()!==user||token!==generation||!isActive())return;
          const key=firmKey(user),current=readFirm(storage,key,now()),next=advanceFirmRisk(current,symbol,fetched,now());
          if(next!==current)storage.setItem(key,JSON.stringify(next));
          firm=next;acceptQuotes(fetched.market);riskError='';
        });
      }
    }catch(e){if(getUser()===user&&token===generation){quoteFailed=true;riskError='Skyddskontroll väntar: '+e.message;}}
    finally{quoteBusy=false;try{sync();}catch(e){firm=null;error=e.message;}sampleNow();render();}
  }
  async function togglePause(){
    const user=getUser();if(!user||resetting)return;
    const token=++generation;
    try{
      await exclusive(user,()=>{
        if(getUser()!==user||token!==generation)return;
        const key=firmKey(user);ensure(key);
        const current=readFirm(storage,key,now()),next=setFirmPaused(current,!current.paused);
        storage.setItem(key,JSON.stringify(next));firm=next;error='';
      });
    }catch(e){error='Inställningen kunde inte sparas: '+e.message;}
    try{sync();}catch(e){firm=null;error=e.message;}
    render();
  }
  async function reset(){
    const user=getUser();if(!user||resetting)return;
    if(!confirm('Arkivera nuvarande firma och börja om med '+FLOOR.desks.length+' × '+FLOOR.start+' $? Öppna positioner följer med i arkivet utan att stängas.'))return;
    const token=++generation;resetting=true;render();
    try{
      await exclusive(user,()=>{
        if(getUser()!==user||token!==generation)return;
        const key=firmKey(user),raw=storage.getItem(key),fresh=newFirm(now());
        // Archive first. A failed archive or write leaves the saved firm intact.
        if(raw!==null){let suffix=now(),backup=key+':before-reset:'+suffix;while(storage.getItem(backup)!==null)backup=key+':before-reset:'+(++suffix);storage.setItem(backup,raw);}
        storage.setItem(key,JSON.stringify(fresh));
        const chart=storage.getItem(equityKey(user));if(chart!==null)storage.setItem(equityKey(user)+':before-reset:'+now(),chart);
        storage.setItem(equityKey(user),'[]');
        firm=fresh;equity=[];quotes={};live=null;lastTotal=null;error='';riskError='';lastCheck=-Infinity;tradeCounts={};panel=null;
      });
    }catch(e){if(getUser()===user)error='Återställningen misslyckades: '+e.message;}
    finally{resetting=false;try{sync();}catch(e){firm=null;error=e.message;}render();}
  }
  function show(){try{sync();}catch(e){firm=null;error=e.message;}render();if(scene)start();}
  function hide(){running=false;stopTyping();panel=null;modal=null;if(panelEl)panelEl.hidden=true;modalEl.classList?.remove('show');}
  q('[data-floor-pause]').onclick=togglePause;
  q('[data-floor-reset]').onclick=reset;
  if(canvas.addEventListener&&scene){
    canvas.addEventListener('click',e=>{const p=scene.toLogical(e.clientX,e.clientY);pick(scene.hitTest(p.x,p.y));});
    canvas.addEventListener('mousemove',e=>{const p=scene.toLogical(e.clientX,e.clientY),h=scene.hitTest(p.x,p.y);scene.setHover(h);canvas.style.cursor=h?'pointer':'default';});
    canvas.addEventListener('mouseleave',()=>scene.setHover(null));
  }
  if(root.addEventListener){
    root.addEventListener('click',e=>{
      const chip=e.target.closest?.('[data-floor-pick]');
      if(chip){const [kind,id]=chip.dataset.floorPick.split(':');pick({kind,id});return;}
      if(e.target.closest?.('[data-floor-panel-close]')){pick(null);return;}
      if(e.target.closest?.('[data-floor-modal-close]')||e.target===modalEl)closeModal();
    });
    root.addEventListener('keydown',e=>{if(e.key==='Escape'){if(modal)closeModal();else if(panel)pick(null);}});
  }
  return {refresh,refreshLive,reset,togglePause,pick,show,hide};
}
