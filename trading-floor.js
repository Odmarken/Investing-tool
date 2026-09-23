// Trading floor: six independent trend desks, one Bybit perpetual each. Every
// desk runs the nine-horizon trend ensemble from floor-trend.js (selected and
// validated in research/floor-trend-results.md). Nothing here sends orders.
import {CONTRACTS} from './bybit-contracts.js';
import {TREND,newTrendDesk,validateTrendDesk,advanceTrendDesk,settleTrendRisk,trendLiveValue,trendLiquidation,trendCount,trendStops} from './floor-trend.js';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;
export const FLOOR=Object.freeze({version:'trading-floor-v2',legacy:'trading-floor-v1',desks:Object.freeze(Object.keys(CONTRACTS).slice(0,6)),start:TREND.start,
  decisionLimit:TREND.decisionLimit,equityLimit:1440,equityInterval:60000,storagePrefix:'riptide.floor.v1:'});
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

export function newFirm(now){
  if(!positive(now))throw Error('Ogiltig starttid');
  return {version:FLOOR.version,createdAt:now,paused:false,desks:Object.fromEntries(FLOOR.desks.map(symbol=>[symbol,newTrendDesk()]))};
}
export function validateFirm(firm){
  // A page loaded before a deploy meets the new format in the cloud: say so instead of failing silently.
  if(typeof firm?.version==='string'&&firm.version.startsWith('trading-floor-')&&firm.version!==FLOOR.version&&firm.version!==FLOOR.legacy)
    throw Error('Golvet har uppdaterats ('+firm.version+'). Ladda om sidan.');
  if(firm?.version!==FLOOR.version||!positive(firm.createdAt)||typeof firm.paused!=='boolean'||!firm.desks||typeof firm.desks!=='object')throw Error('Ogiltig trading floor');
  const keys=Object.keys(firm.desks);
  if(keys.length!==FLOOR.desks.length||FLOOR.desks.some(symbol=>!keys.includes(symbol)))throw Error('Borden stämmer inte');
  for(const symbol of FLOOR.desks){
    const desk=validateTrendDesk(firm.desks[symbol],symbol);
    if(desk.enabled!==!firm.paused)throw Error('Bordets handelsläge stämmer inte med firman');
  }
  return firm;
}
// The first floor ran the hourly SL/TP momentum rules. Its firm is archived
// and replaced by fresh trend desks; positions are not carried over.
export const isLegacyFirm=value=>value?.version===FLOOR.legacy;
export function readFirm(storage,key,now){
  const raw=storage.getItem(key);if(raw===null)return newFirm(now);
  const firm=JSON.parse(raw);
  return isLegacyFirm(firm)?newFirm(now):validateFirm(firm);
}
// Call inside the firm's tab lock. Archives an old firm and its curve, then stores new desks.
export function upgradeStoredFirm(storage,key,curveKey,now){
  const raw=storage.getItem(key);if(raw===null||!isLegacyFirm(JSON.parse(raw)))return false;
  let suffix=now,backup=key+':before-trend:'+suffix;while(storage.getItem(backup)!==null)backup=key+':before-trend:'+(++suffix);
  storage.setItem(backup,raw);
  const chart=storage.getItem(curveKey);if(chart!==null)storage.setItem(curveKey+':before-trend:'+suffix,chart);
  storage.setItem(key,JSON.stringify(newFirm(now)));storage.setItem(curveKey,'[]');
  return true;
}
// Desks whose hour has not been decided yet need fresh candles.
export const needsHourly=(firm,now)=>FLOOR.desks.some(symbol=>{const t=firm.desks[symbol].signal.through;return t===null||t<Math.floor(now/TREND.hour)*TREND.hour;});
export function advanceFirm(firm,snapshot,now){
  validateFirm(firm);
  const desks={};let changed=false;
  for(const symbol of FLOOR.desks){
    const desk=firm.desks[symbol],market=snapshot?.market?.[symbol];
    if(!market)throw Error('Timpriser saknas för '+symbol);
    const next=advanceTrendDesk(desk,symbol,{...market,hour:snapshot.hour},now);
    desks[symbol]=next;if(next!==desk)changed=true;
  }
  return changed?validateFirm({...firm,desks}):firm;
}
export function advanceFirmRisk(firm,symbol,snapshot,now){
  validateFirm(firm);
  const desk=firm.desks[symbol];if(!desk)throw Error('Okänt bord');
  if(!desk.position)return firm;
  const next=settleTrendRisk(desk,symbol,snapshot?.market?.[symbol],now);
  return next===desk?firm:validateFirm({...firm,desks:{...firm.desks,[symbol]:next}});
}
export function setFirmPaused(firm,paused){
  validateFirm(firm);
  return validateFirm({...firm,paused,desks:Object.fromEntries(FLOOR.desks.map(symbol=>[symbol,{...firm.desks[symbol],enabled:!paused}]))});
}
export const heldSymbols=firm=>FLOOR.desks.filter(symbol=>firm.desks[symbol].position);
export const deskPosition=desk=>desk.position;
export const deskCash=desk=>desk.cash;

export function firmLive(firm,quotes,now){
  const desks={},waiting=[];let total=0,at=null;
  for(const symbol of FLOOR.desks){
    const desk=firm.desks[symbol],live=trendLiveValue(desk,quotes?.[symbol],now),position=desk.position;
    desks[symbol]={balance:live.balance,openNet:live.openNet,openReturn:live.openReturn,exposure:live.exposure,reason:live.reason,at:live.at,position,cash:desk.cash,
      quote:position?live.quote:null,pnl:live.balance===null?null:live.balance-FLOOR.start};
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
export function deskStatus(desk){
  if(desk.position)return 'trade';
  if(!desk.enabled)return 'paused';
  return 'waiting';
}
export function firmStats(firm,now){
  const day=dayStart(now),desks={};
  let realized=0,today=0,trades=0,wins=0,losses=0,liquidations=0,fees=0,funding=0;
  for(const symbol of FLOOR.desks){
    const desk=firm.desks[symbol],list=desk.trades,pnl=list.reduce((sum,t)=>sum+t.pnl,0),dayPnl=list.filter(t=>t.at>=day).reduce((sum,t)=>sum+t.pnl,0);
    const w=list.filter(t=>t.pnl>0).length,l=list.filter(t=>t.pnl<0).length,liq=list.filter(t=>t.reason==='likvidation').length;
    desks[symbol]={realized:pnl,today:dayPnl,trades:list.length,wins:w,losses:l,liquidations:liq,status:deskStatus(desk),cash:desk.cash,position:desk.position,
      last:list.at(-1)??null,decision:desk.decisions.at(-1)??null,count:trendCount(desk.signal),stops:trendStops(desk.signal),waitReason:desk.waitReason??''};
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
// Distance from the mark to the first trend stop (the position shrinks), the
// last one (the position closes) and liquidation, per held desk.
export function riskRows(firm,live){
  return FLOOR.desks.map(symbol=>{
    const desk=firm.desks[symbol],p=desk.position;if(!p)return null;
    const mark=live?.desks[symbol]?.quote?.mark??null,liq=trendLiquidation(desk),stops=trendStops(desk.signal),rel=x=>mark===null||!x?null:(mark-x)/mark;
    return {symbol,count:trendCount(desk.signal),exposure:live?.desks[symbol]?.exposure??null,units:p.units,entry:p.entry,mark,liquidation:liq,
      firstStop:stops?.first??null,lastStop:stops?.last??null,toFirst:rel(stops?.first),toLast:rel(stops?.last),toLiq:rel(liq)};
  }).filter(Boolean);
}
const money=n=>n.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
const signed=n=>(n>=0?'+':'')+money(n);
const pct=n=>(n*100).toLocaleString('sv-SE',{minimumFractionDigits:1,maximumFractionDigits:1})+' %';
const clock=t=>new Date(t).toLocaleTimeString('sv-SE',{timeZone:'Europe/Stockholm',hour:'2-digit',minute:'2-digit'});
// Pablo reads the floor the way he reads a setup: only what the accounts know.
export function floorNarrative(firm,live,stats,now){
  const rows=[],n=TREND.lookbacks.length;
  rows.push(live.total===null?'Firman väntar på färska priser för '+live.waiting.join(', ')+', så totalen håller jag inne med.':
    'Firman står i '+money(live.total)+' av '+money(live.start)+' insatta. Det är '+signed(live.net)+' sedan start, och '+signed(stats.today)+' realiserat i dag.');
  const inTrade=FLOOR.desks.filter(s=>stats.desks[s].status==='trade');
  if(inTrade.length){
    rows.push(inTrade.length+' av '+FLOOR.desks.length+' bord sitter i affär: '+inTrade.map(s=>{
      const d=live.desks[s],st=stats.desks[s],mark=d.quote?.mark;
      return s+(d.openNet===null?' (väntar på pris)':' '+signed(d.openNet))+', '+st.count+' av '+n+' trender'+(finite(d.exposure)?', '+d.exposure.toFixed(1).replace('.',',')+'× exponering':'')+
        (mark&&st.stops?', '+pct((mark-st.stops.first)/mark)+' till första stoppet':'');
    }).join('; ')+'.');
  }else rows.push(firm.paused?'Inga bord är i affär och nya köp är pausade. Kontoret fikar.':'Inga bord är i affär just nu. Alla väntar på att någon trend ska bryta uppåt.');
  const idle=FLOOR.desks.filter(s=>stats.desks[s].status!=='trade');
  if(inTrade.length&&idle.length)rows.push('Utan position: '+idle.join(', ')+'. De köper först när en stängning slår sitt högsta på minst fem dygn.');
  const ranked=FLOOR.desks.map(s=>[s,live.desks[s].pnl]).filter(([,v])=>v!==null).sort((a,b)=>b[1]-a[1]);
  if(ranked.length>1)rows.push('Bäst hittills är '+ranked[0][0]+' med '+signed(ranked[0][1])+'. Sämst är '+ranked.at(-1)[0]+' med '+signed(ranked.at(-1)[1])+'.');
  rows.push(stats.trades?stats.trades+' avslutade affärer sedan start: '+stats.wins+' vinster, '+stats.losses+' förluster'+(stats.liquidations?', '+stats.liquidations+' likvidationer':'')+'. Avgifter '+money(stats.fees)+', funding '+money(stats.funding)+'.':'Inga avslutade affärer ännu. Historiken börjar när första bordet säljer hela sin position.');
  rows.push('Pablos bedömning: varje bord följer nio trender från 5 till 360 dygn och köper mer ju fler som pekar uppåt, med storlek efter volatiliteten. De flesta affärer blir små förluster; vinsten kommer från några få långa trender. Regeln var bäst av sju i historiska tester 2021–2026, men det är ett demospel med riktiga priser, inte ett löfte. Klockan är '+clock(now)+'.');
  return rows.join('\n\n');
}
