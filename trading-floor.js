// Trading floor: six independent desk accounts. Each desk runs the frozen
// hourly momentum rules from crypto-momentum-active.js on one Bybit perpetual.
// The momentum modules are reused unchanged; nothing here sends orders.
import {ACTIVE,newActiveAccount,validateActiveAccount,advanceActiveAccount,advanceActiveRisk} from './crypto-momentum-active.js';
import {momentumLiveValue} from './crypto-momentum-live.js';
import {liquidationPrice} from './crypto-leverage.js';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;
export const FLOOR=Object.freeze({version:'trading-floor-v1',desks:Object.freeze(ACTIVE.symbols.slice(0,6)),start:ACTIVE.start,
  decisionLimit:500,equityLimit:1440,equityInterval:60000,storagePrefix:'riptide.floor.v1:'});
export const ROOMS=Object.freeze([
  {id:'elias',name:'Elias',role:'VD'},
  {id:'pablo',name:'Pablo',role:'Analys'},
  {id:'manuel',name:'Manuel',role:'Makro & nyheter'},
  {id:'miguel',name:'Miguel',role:'Risk'}
]);
const NAMES=Object.freeze(['Lucas','Leo','Mateo','Vincent','Diego','Carlos','Nils','Erik','Hugo','Adam','Rafael','Ivan',
  'Tomas','Johan','Andrés','Charlie','Oskar','Viktor','Sergio','Liam','Bruno','Marco','Felix','Noah']);
export const traderNames=symbol=>{const i=FLOOR.desks.indexOf(symbol);return i<0?[]:NAMES.slice(i*4,i*4+4);};
export const firmKey=user=>FLOOR.storagePrefix+encodeURIComponent(user);
export const equityKey=user=>firmKey(user)+':equity';

export function newDesk(){return {...newActiveAccount(),enabled:true};}
export function newFirm(now){
  if(!positive(now))throw Error('Ogiltig starttid');
  return {version:FLOOR.version,createdAt:now,paused:false,desks:Object.fromEntries(FLOOR.desks.map(symbol=>[symbol,newDesk()]))};
}
export function validateFirm(firm){
  if(firm?.version!==FLOOR.version||!positive(firm.createdAt)||typeof firm.paused!=='boolean'||!firm.desks||typeof firm.desks!=='object')throw Error('Ogiltig trading floor');
  const keys=Object.keys(firm.desks);
  if(keys.length!==FLOOR.desks.length||FLOOR.desks.some(symbol=>!keys.includes(symbol)))throw Error('Borden stämmer inte');
  for(const symbol of FLOOR.desks){
    const desk=validateActiveAccount(firm.desks[symbol]);
    if(desk.enabled!==!firm.paused)throw Error('Bordets handelsläge stämmer inte med firman');
    if(desk.sleeves.some(s=>s.position&&s.symbol!==symbol))throw Error('Bord '+symbol+' håller fel coin');
    if(desk.trades.some(t=>t.symbol!==symbol)||desk.activeDecisions.some(d=>d.symbol!==null&&d.symbol!==symbol))throw Error('Bord '+symbol+' har handlat fel coin');
  }
  return firm;
}
export function readFirm(storage,key,now){
  const raw=storage.getItem(key);
  return raw===null?newFirm(now):validateFirm(JSON.parse(raw));
}
// Every desk's position keyed by symbol, so one shared market fetch includes
// the mark-price and funding history of each held contract.
export function firmPositions(firm){
  return {profile:ACTIVE.profile,sleeves:ACTIVE.symbols.map(symbol=>({symbol,cash:0,position:firm.desks[symbol]?.sleeves.find(s=>s.symbol===symbol)?.position??null}))};
}
// A desk sees fresh quotes for every coin but only its own entry signal.
export function deskSnapshot(shared,symbol){
  return {hour:shared.hour,market:Object.fromEntries(Object.entries(shared.market??{}).map(([s,m])=>[s,s===symbol?m:{...m,signal:null}]))};
}
const trim=desk=>desk.activeDecisions.length<=FLOOR.decisionLimit?desk:{...desk,activeDecisions:desk.activeDecisions.slice(-FLOOR.decisionLimit)};
export function advanceFirm(firm,shared,now){
  validateFirm(firm);
  const desks={};let changed=false;
  for(const symbol of FLOOR.desks){
    const desk=firm.desks[symbol],next=trim(advanceActiveAccount(desk,deskSnapshot(shared,symbol),now));
    desks[symbol]=next;if(next!==desk)changed=true;
  }
  return changed?validateFirm({...firm,desks}):firm;
}
export function advanceFirmRisk(firm,symbol,market,now){
  validateFirm(firm);
  const desk=firm.desks[symbol];if(!desk)throw Error('Okänt bord');
  const next=advanceActiveRisk(desk,market,now);
  return next===desk?firm:validateFirm({...firm,desks:{...firm.desks,[symbol]:next}});
}
export function setFirmPaused(firm,paused){
  validateFirm(firm);
  return validateFirm({...firm,paused,desks:Object.fromEntries(FLOOR.desks.map(symbol=>[symbol,{...firm.desks[symbol],enabled:!paused}]))});
}
export const heldSymbols=firm=>FLOOR.desks.filter(symbol=>firm.desks[symbol].sleeves.some(s=>s.position));
export const deskPosition=desk=>desk.sleeves.find(s=>s.position)?.position??null;
export const deskCash=desk=>desk.sleeves.reduce((sum,s)=>sum+s.cash,0);

export function firmLive(firm,quotes,now){
  const desks={},waiting=[];let total=0,at=null;
  for(const symbol of FLOOR.desks){
    const desk=firm.desks[symbol],live=momentumLiveValue(desk,quotes,now),position=deskPosition(desk);
    desks[symbol]={balance:live.balance,openNet:live.openNet,reason:live.reason,at:live.at,position,cash:deskCash(desk),
      quote:position?live.positions[symbol]?.quote??null:null,pnl:live.balance===null?null:live.balance-FLOOR.start};
    if(live.balance===null)waiting.push(symbol);else total+=live.balance;
    if(position&&live.at!==null)at=at===null?live.at:Math.min(at,live.at);
  }
  const start=FLOOR.start*FLOOR.desks.length;
  return {total:waiting.length?null:total,at:waiting.length?null:at,waiting,desks,start,net:waiting.length?null:total-start};
}
// Midnight in Stockholm, so "today" matches the clocks on the page.
const STOCKHOLM=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Stockholm',year:'numeric',month:'2-digit',day:'2-digit'});
let cachedDay=null,cachedStart=null;
export function dayStart(now){
  // Find the first millisecond of this local date, including 23/25-hour days.
  const date=STOCKHOLM.format(now);if(date===cachedDay)return cachedStart;
  let lo=Math.floor(now)-27*3600000,hi=Math.floor(now);
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(STOCKHOLM.format(mid)===date)hi=mid;else lo=mid+1;}
  cachedDay=date;cachedStart=lo;return lo;
}
export function deskStatus(desk,now){
  if(deskPosition(desk))return 'trade';
  if(!desk.enabled)return 'paused';
  if(desk.cooldownUntil>now)return 'cooldown';
  return 'waiting';
}
export function firmStats(firm,now){
  const day=dayStart(now),desks={};
  let realized=0,today=0,trades=0,wins=0,losses=0,liquidations=0,fees=0,funding=0;
  for(const symbol of FLOOR.desks){
    const desk=firm.desks[symbol],list=desk.trades,pnl=list.reduce((sum,t)=>sum+t.pnl,0),dayPnl=list.filter(t=>t.at>=day).reduce((sum,t)=>sum+t.pnl,0);
    const w=list.filter(t=>t.pnl>0).length,l=list.filter(t=>t.pnl<0).length,liq=list.filter(t=>t.reason==='likvidation').length;
    desks[symbol]={realized:pnl,today:dayPnl,trades:list.length,wins:w,losses:l,liquidations:liq,status:deskStatus(desk,now),
      cash:deskCash(desk),position:deskPosition(desk),last:list.at(-1)??null,decision:desk.activeDecisions.at(-1)??null,waitReason:desk.waitReason??''};
    realized+=pnl;today+=dayPnl;trades+=list.length;wins+=w;losses+=l;liquidations+=liq;fees+=desk.fees;funding+=desk.funding;
  }
  return {desks,realized,today,trades,wins,losses,liquidations,fees,funding,inTrade:heldSymbols(firm).length,day};
}
export function readEquity(storage,key){
  const raw=storage.getItem(key);if(raw===null)return [];
  const points=JSON.parse(raw);
  if(!Array.isArray(points)||points.length>FLOOR.equityLimit||points.some((p,i)=>!p||!positive(p.t)||!finite(p.v)||i&&p.t<=points[i-1].t))throw Error('Kapitalhistoriken kan inte läsas');
  return points;
}
export function sampleEquity(points,t,v,rules=FLOOR){
  if(!positive(t)||!finite(v))return points;
  const last=points.at(-1);
  if(last&&t-last.t<rules.equityInterval)return points;
  const next=[...points.filter(p=>p.t<t),{t,v}];
  return next.length>rules.equityLimit?next.slice(-rules.equityLimit):next;
}
export function riskRows(firm,live){
  return FLOOR.desks.map(symbol=>{
    const p=deskPosition(firm.desks[symbol]);if(!p)return null;
    const mark=live?.desks[symbol]?.quote?.mark??null,liq=liquidationPrice(p);
    return {symbol,budget:p.budget,initialRisk:p.initialRisk,leverage:p.rules.leverage,sl:p.sl,tp:p.tp,liquidation:liq,deadline:p.deadline,mark,
      toSl:mark===null?null:(mark-p.sl)/mark,toTp:mark===null?null:(p.tp-mark)/mark,toLiq:mark===null?null:(mark-liq)/mark};
  }).filter(Boolean);
}
const money=n=>n.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
const signed=n=>(n>=0?'+':'')+money(n);
const clock=t=>new Date(t).toLocaleTimeString('sv-SE',{timeZone:'Europe/Stockholm',hour:'2-digit',minute:'2-digit'});
// Pablo reads the floor the way he reads a setup: only what the accounts know.
export function floorNarrative(firm,live,stats,now){
  const rows=[];
  rows.push(live.total===null?'Firman väntar på färska priser för '+live.waiting.join(', ')+', så totalen håller jag inne med.':
    'Firman står i '+money(live.total)+' av '+money(live.start)+' insatta. Det är '+signed(live.net)+' sedan start, och '+signed(stats.today)+' realiserat i dag.');
  const inTrade=FLOOR.desks.filter(s=>stats.desks[s].status==='trade');
  if(inTrade.length){
    rows.push(inTrade.length+' av '+FLOOR.desks.length+' bord sitter i affär: '+inTrade.map(s=>{
      const d=live.desks[s],p=d.position,mark=d.quote?.mark;
      return s+(d.openNet===null?' (väntar på pris)':' '+signed(d.openNet)+(mark?', '+((mark-p.sl)/mark*100).toFixed(1)+' % till SL och '+((p.tp-mark)/mark*100).toFixed(1)+' % till TP':''));
    }).join('; ')+'.');
  }else rows.push(firm.paused?'Inga bord är i affär och nya köp är pausade. Kontoret fikar.':'Inga bord är i affär just nu. Alla väntar på nästa timsignal med positivt momentum.');
  const cooling=FLOOR.desks.filter(s=>stats.desks[s].status==='cooldown');
  if(cooling.length)rows.push('Karens efter avslut: '+cooling.map(s=>s+' till '+clock(firm.desks[s].cooldownUntil)).join(', ')+'.');
  const ranked=FLOOR.desks.map(s=>[s,live.desks[s].pnl]).filter(([,v])=>v!==null).sort((a,b)=>b[1]-a[1]);
  if(ranked.length>1)rows.push('Bäst hittills är '+ranked[0][0]+' med '+signed(ranked[0][1])+'. Sämst är '+ranked.at(-1)[0]+' med '+signed(ranked.at(-1)[1])+'.');
  rows.push(stats.trades?stats.trades+' avslut sedan start: '+stats.wins+' vinster, '+stats.losses+' förluster'+(stats.liquidations?', '+stats.liquidations+' likvidationer':'')+'. Avgifter '+money(stats.fees)+', funding '+money(stats.funding)+'.':'Inga avslut ännu. Historiken börjar när första bordet stänger sin affär.');
  rows.push('Pablos bedömning: samma regler som AI-momentum, ett coin per bord. Ingen av profilerna klarade utvecklingskraven, så räkna det här som ett demospel med riktiga priser, inte en validerad edge. Klockan är '+clock(now)+'.');
  return rows.join('\n\n');
}
