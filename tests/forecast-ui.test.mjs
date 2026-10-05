import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mountForecast,chartLevels,checkText} from '../forecast-ui.js';
import {createForecastStore,memoryBackend,signalRecord,forecastRecord,verifyRecord,hashOf,ARCHIVE_FULL} from '../forecast-store.js';
import {createForecastRunner} from '../forecast-runner.js';
import {accountKey,newForecastAccount,tradeReasons,accountStats} from '../forecast-account.js';
import {fetchHistory,splitForming} from '../forecast-market.js';
import {comparisonStats,CHART_COLORS,priceDecimals,createForecastChart} from '../forecast-chart.js';
import {createContractCache} from '../bybit-contracts.js';
import {TF,SYMBOLS,SIGNAL_PARAMS,FORECAST_PARAMS} from '../forecast-config.js';
import {evaluateBar,forecastAt,forecastFeatures,computeIndicators,aggregateClosed,requiredLookback} from '../forecast-model.js';
import {scriptMarket,fakeBybit,memoryStorage,tabLocks,START,HOUR,DAY,MAX_LEVERAGE} from './forecast-fixtures.mjs';

// A file of the repo as text with LF line ends, whatever the checkout made of them (core.autocrlf turns them into
// CRLF on Windows), so tests that split or match lines read the same text everywhere.
const source=rel=>readFileSync(new URL(rel,import.meta.url),'utf8').replace(/\r\n/g,'\n');

// ---- A small DOM: enough HTML parsing, selectors, events and form state for the view ----
const VOID=new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'};
const decode=s=>s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|\w+);/g,(m,k)=>k[0]==='#'?String.fromCodePoint(k[1]==='x'||k[1]==='X'?parseInt(k.slice(2),16):+k.slice(1)):ENTITIES[k]??m);
const escText=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const escAttr=s=>s.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
const TOKEN=/<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</g;
const ATTR=/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
function compound(text){
  const c={tag:null,id:null,classes:[],attrs:[]};let rest=text,m=/^[a-zA-Z][\w-]*/.exec(rest);
  if(m){c.tag=m[0].toLowerCase();rest=rest.slice(m[0].length);}
  while(rest){
    if((m=/^#([\w-]+)/.exec(rest)))c.id=m[1];
    else if((m=/^\.([\w-]+)/.exec(rest)))c.classes.push(m[1]);
    else if((m=/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest)))c.attrs.push([m[1],m[2]??m[3]??m[4]??null]);
    else throw Error('Unsupported selector: '+text);
    rest=rest.slice(m[0].length);
  }
  return c;
}
const selectors=new Map();
const parseSelector=text=>{if(!selectors.has(text))selectors.set(text,text.split(',').map(s=>s.trim().split(/\s+/).map(compound)));return selectors.get(text);};
function one(el,c){
  if(el?.nodeType!==1||c.tag&&el.localName!==c.tag||c.id&&el.getAttribute('id')!==c.id)return false;
  return c.classes.every(k=>el.classList.contains(k))&&c.attrs.every(([k,v])=>{const a=el.getAttribute(k);return a!==null&&(v===null||a===v);});
}
function chain(el,parts){
  if(!one(el,parts.at(-1)))return false;
  let k=parts.length-2;for(let n=el.parentNode;k>=0&&n;n=n.parentNode)if(one(n,parts[k]))k--;
  return k<0;
}
const serialize=n=>n.nodeType===3?escText(n.data):'<'+n.localName+[...n.attrs].map(([k,v])=>' '+k+'="'+escAttr(v)+'"').join('')+'>'+
  (VOID.has(n.localName)?'':n.childNodes.map(serialize).join('')+'</'+n.localName+'>');
class FakeText{constructor(data){this.nodeType=3;this.data=data;this.parentNode=null;}get textContent(){return this.data;}}
// As in a browser, focus falls back to the page when the focused control is disabled or removed.
function blur(el,self){
  const doc=el.ownerDocument,a=doc?.activeElement;
  if(a&&(self?a===el:a!==el&&el.contains(a)))doc.activeElement=null;
}
function clear(el){blur(el,false);for(const c of el.childNodes)c.parentNode=null;el.childNodes=[];}
class FakeElement{
  constructor(tag,doc){
    this.nodeType=1;this.localName=tag;this.tagName=tag.toUpperCase();this.ownerDocument=doc;
    this.attrs=new Map();this.childNodes=[];this.parentNode=null;this.listeners=new Map();this.style={};this.state={};
  }
  getAttribute(k){return this.attrs.has(k)?this.attrs.get(k):null;}
  setAttribute(k,v){this.attrs.set(k,String(v));}
  removeAttribute(k){this.attrs.delete(k);}
  hasAttribute(k){return this.attrs.has(k);}
  get children(){return this.childNodes.filter(n=>n.nodeType===1);}
  get hidden(){return this.attrs.has('hidden');}set hidden(v){if(v)this.attrs.set('hidden','');else this.attrs.delete('hidden');}
  get disabled(){return this.attrs.has('disabled');}set disabled(v){if(v){this.attrs.set('disabled','');blur(this,true);}else this.attrs.delete('disabled');}
  get checked(){return 'checked' in this.state?this.state.checked:this.attrs.has('checked');}set checked(v){this.state.checked=!!v;}
  get selected(){return 'selected' in this.state?this.state.selected:this.attrs.has('selected');}set selected(v){this.state.selected=!!v;}
  get options(){return this.querySelectorAll('option');}
  get value(){
    if(this.localName==='select'){const o=this.options;return (o.filter(x=>x.selected).at(-1)??(this.state.none?null:o[0]))?.value??'';}
    if(this.localName==='option')return this.getAttribute('value')??this.textContent;
    return 'value' in this.state?this.state.value:this.getAttribute('value')??'';
  }
  set value(v){
    v=String(v);
    if(this.localName!=='select'){this.state.value=v;return;}
    let hit=false;for(const o of this.options){o.selected=!hit&&o.value===v;hit||=o.selected;}this.state.none=!hit;
  }
  get classList(){
    const list=()=>(this.getAttribute('class')??'').split(/\s+/).filter(Boolean),write=xs=>this.setAttribute('class',[...new Set(xs)].join(' '));
    return {contains:k=>list().includes(k),add:(...ks)=>write([...list(),...ks]),remove:(...ks)=>write(list().filter(x=>!ks.includes(x))),
      toggle:(k,force)=>{const on=force===undefined?!list().includes(k):!!force;write(on?[...list(),k]:list().filter(x=>x!==k));return on;}};
  }
  get tabIndex(){return this.attrs.has('tabindex')?+this.getAttribute('tabindex'):-1;}set tabIndex(v){this.setAttribute('tabindex',v);}
  get textContent(){return this.childNodes.map(n=>n.textContent).join('');}
  set textContent(v){const t=String(v??'');clear(this);this.childNodes=t?[Object.assign(new FakeText(t),{parentNode:this})]:[];}
  get innerHTML(){return this.childNodes.map(serialize).join('');}
  set innerHTML(html){
    clear(this);this.state.none=false;
    const stack=[this];
    for(const m of String(html).matchAll(TOKEN)){
      const parent=stack.at(-1);
      if(m[0].startsWith('<!--'))continue;
      if(m[1]!==undefined){const tag=m[1].toLowerCase(),i=stack.findLastIndex((x,k)=>k>0&&x.localName===tag);if(i>0)stack.length=i;}
      else if(m[2]!==undefined){
        const el=new FakeElement(m[2].toLowerCase(),this.ownerDocument);
        for(const a of m[3].matchAll(ATTR))el.attrs.set(a[1].toLowerCase(),decode(a[2]??a[3]??a[4]??''));
        el.parentNode=parent;parent.childNodes.push(el);
        if(!VOID.has(el.localName)&&!m[4])stack.push(el);
      }else parent.childNodes.push(Object.assign(new FakeText(decode(m[0])),{parentNode:parent}));
    }
  }
  querySelectorAll(sel){
    const parts=parseSelector(sel),out=[];
    const walk=n=>{for(const c of n.childNodes)if(c.nodeType===1){if(parts.some(p=>chain(c,p)))out.push(c);walk(c);}};
    walk(this);return out;
  }
  querySelector(sel){return this.querySelectorAll(sel)[0]??null;}
  matches(sel){return parseSelector(sel).some(p=>chain(this,p));}
  closest(sel){for(let n=this;n?.nodeType===1;n=n.parentNode)if(n.matches(sel))return n;return null;}
  contains(n){for(;n;n=n.parentNode)if(n===this)return true;return false;}
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(fn);}
  removeEventListener(type,fn){this.listeners.set(type,(this.listeners.get(type)??[]).filter(f=>f!==fn));}
  focus(){if(!this.disabled&&(['a','button','input','select','textarea'].includes(this.localName)||this.hasAttribute('tabindex')))this.ownerDocument.activeElement=this;}
  // Canvas: a fixed CSS size and a 2D context that records what is drawn.
  getContext(type){return this.localName==='canvas'&&type==='2d'?this.ctx??=fakeContext():null;}
  get clientWidth(){return this.localName==='canvas'?900:0;}
  get clientHeight(){return this.localName==='canvas'?480:0;}
  getBoundingClientRect(){return {left:0,top:0,width:this.clientWidth,height:this.clientHeight};}
  setPointerCapture(){}
  releasePointerCapture(){}
}
function fakeDocument(){const doc={activeElement:null,createElement:tag=>new FakeElement(tag,doc)};return doc;}
function fakeContext(){
  const ctx={calls:[],fillStyle:'#000',strokeStyle:'#000',lineWidth:1,globalAlpha:1,font:'10px sans-serif',textAlign:'start',textBaseline:'alphabetic',lineJoin:'miter',lineCap:'butt'};
  const log=(...a)=>ctx.calls.push(a);
  return Object.assign(ctx,{save(){},restore(){},setLineDash(){},measureText:s=>({width:String(s).length*6}),setTransform(){log('frame');},beginPath(){},moveTo(){},lineTo(){},
    closePath(){},rect(){},roundRect(){},clip(){},fill(){log('fill',ctx.fillStyle);},stroke(){log('stroke',ctx.strokeStyle);},
    fillRect(...a){log('fillRect',ctx.fillStyle,...a);},strokeRect(...a){log('strokeRect',ctx.strokeStyle,...a);},fillText(text){log('text',text);}});
}
function fire(target,type){
  const e={type,target,defaultPrevented:false,stopped:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;}};
  for(let n=target;n&&!e.stopped;n=n.parentNode)for(const fn of [...(n.listeners?.get(type)??[])])fn.call(n,e);
  return e;
}
// A click on an enabled control; a submit button submits its form, as in a browser.
function click(el){
  assert.ok(el,'nothing to click');
  if(el.disabled)return false;
  const e=fire(el,'click');
  if(!e.defaultPrevented&&el.localName==='button'&&el.getAttribute('type')==='submit'){const form=el.closest('form');if(form)fire(form,'submit');}
  return true;
}
const enter=(el,value)=>{assert.ok(el,'no field');if('checked'===value||value===true||value===false)el.checked=!!value;else el.value=value;fire(el,'input');fire(el,'change');};
// A control whose action is running: marked aria-disabled (it keeps keyboard focus), or disabled.
const busy=el=>el.disabled||el.getAttribute('aria-disabled')==='true';
const drawn=ctx=>ctx.calls.filter(c=>c[0]==='text').map(c=>c[1]);
const frames=ctx=>ctx.calls.filter(c=>c[0]==='frame').length;

// ---- Fixtures --------------------------------------------------------------------
const SEC=1000,MIN=60000;
const m=scriptMarket(),[L1]=m.longs;
const after=(i,ms=2*SEC)=>m.closeOf(i)+ms;
const hhmm=t=>new Date(t).toLocaleTimeString('sv-SE',{timeZone:'Europe/Stockholm',hour:'2-digit',minute:'2-digit'});
const MONTHS=['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];
const dayOf=t=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Stockholm',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(t).map(x=>[x.type,+x.value]));
// Stockholm time, with the date when it is not the same day as `now`.
const stamp=(t,now)=>{const a=dayOf(t),b=dayOf(now);return (a.year===b.year&&a.month===b.month&&a.day===b.day?'':a.day+' '+MONTHS[a.month-1]+' ')+hhmm(t);};
const fixed=(x,d)=>x.toLocaleString('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(f,what='the view'){for(let k=0;k<2000;k++){if(f())return;await turn();}assert.fail('timed out waiting for '+what);}

// One browser tab: the view with its own runner, over a fake Bybit, storage, record archive and tab locks.
// store:null leaves the archive to the view (its default backend); wrap wraps the fake Bybit; extra adds deps.
function page({time,user='u1',runtime={},settings=null,storage=memoryStorage(),store=createForecastStore(memoryBackend()),locks=tabLocks(),prefs=memoryStorage(),runner=null,defer=()=>Promise.resolve(),wrap=g=>g,extra={}}={}){
  const rt={at:time,urls:[],market:m,...runtime},who={user,active:true,visible:true,answer:true},doc=fakeDocument(),root=doc.createElement('main'),queued=[],asked=[];
  if(settings)storage.setItem(accountKey(user),JSON.stringify(newForecastAccount(time-HOUR,settings)));
  const grab=wrap(fakeBybit(rt));
  const view=mountForecast(root,{getUser:()=>who.user,isActive:()=>who.active,isVisible:()=>who.visible,grab,contracts:createContractCache(grab,()=>rt.at),
    storage,...(store?{store}:{}),locks,now:()=>rt.at,confirm:message=>{asked.push(message);return who.answer;},raf:fn=>queued.push(fn),prefs,
    defer,reducedMotion:()=>true,...(runner?{runner}:{}),...extra});
  const q=s=>root.querySelector(s),ctx=q('[data-fc-canvas]').getContext('2d');
  // Runs the animation frames the chart asked for; returns how many ran.
  const draw=()=>{let n=0;while(queued.length){queued.shift()(rt.at);n++;}return n;};
  return {rt,who,doc,root,view,q,ctx,draw,asked,storage,store,locks,prefs};
}
const account=(p,user='u1')=>JSON.parse(p.storage.getItem(accountKey(user)));
async function records(store,{user='u1',symbol='BTC',tf='1h'}={}){
  const [s,f]=await Promise.all([store.listSignals(user,symbol,tf),store.listForecasts(user,symbol,tf)]);
  return {signals:s.records,forecasts:f.records,corrupt:s.corrupt.length+f.corrupt.length};
}
// The closed candles the chart loads at rt.at, read from the same fake Bybit.
async function loaded(rt,symbol='BTC',tf='1h'){
  const h=await fetchHistory(fakeBybit({...rt,urls:[]}),symbol,tf,{count:2000,now:()=>rt.at});
  return splitForming(h.bars,tf,h.serverTime).closed;
}

test('the first visit stores every signal and a live forecast plus three as-of backfills, exactly as the history gives them',async()=>{
  const p=page({time:after(1998)});
  await p.view.show();
  const closed=await loaded(p.rt),c=closed.length-1,{signals,forecasts,corrupt}=await records(p.store);
  assert.equal(closed.length,1999);assert.equal(closed[c].t,m.bar(1998).t);assert.equal(corrupt,0);
  // Each scripted breakout, recorded after the fact, with exactly the content the runner would store.
  assert.deepEqual(signals.map(r=>[r.barTime,r.side,r.origin,r.recordedAt]),m.signals.map(s=>[s.t,s.side,'backfill',p.rt.at]));
  for(const r of signals){
    const e=evaluateBar(closed,closed.findIndex(b=>b.t===r.barTime),{tf:'1h'});
    assert.ok(verifyRecord(r));
    assert.equal(r.contentHash,signalRecord('u1','BTC','1h',e,{recordedAt:1,origin:'live',params:SIGNAL_PARAMS,tfMs:HOUR}).contentHash);
  }
  // A live forecast for the newest closed candle, and as-of versions 20, 10 and 5 candles back.
  assert.deepEqual(forecasts.map(r=>[r.cutoff,r.origin,r.createdAt]),[[closed[c-20].t,'backfill',p.rt.at],[closed[c-10].t,'backfill',p.rt.at],
    [closed[c-5].t,'backfill',p.rt.at],[closed[c].t,'live',p.rt.at]]);
  const features=forecastFeatures(closed);
  for(const r of forecasts){
    const f=forecastAt(closed,closed.findIndex(b=>b.t===r.cutoff),{tf:'1h',features});
    assert.ok(verifyRecord(r));assert.equal(r.cutoffClose,r.cutoff+HOUR);
    assert.equal(r.contentHash,forecastRecord('u1','BTC','1h',f,{createdAt:1,origin:'live',tfMs:HOUR}).contentHash);
  }
  // The version list: newest first, data t.o.m. the cutoff candle's close first (the backfills share their creation
  // time, so that is what tells them apart), then when it was made, and "efterhand" for the backfills.
  const select=p.q('[data-fc-compare]'),options=select.options;
  assert.deepEqual(options.map(o=>o.value),[...forecasts].reverse().map(r=>r.id));
  assert.equal(options[0].textContent,'data t.o.m. '+hhmm(closed[c].t+HOUR)+' · skapad '+hhmm(p.rt.at)+' · senaste');
  assert.deepEqual(options.slice(1).map(o=>o.textContent),[5,10,20].map(k=>'data t.o.m. '+stamp(closed[c-k].t+HOUR,p.rt.at)+' · skapad '+hhmm(p.rt.at)+' · efterhand'));
  // Compared by default: the newest version that already has closed outcomes (the one 5 candles back, the first quick
  // pick), so the saved forecast lies as outlines behind the real candles at once.
  assert.equal(select.value,forecasts[2].id);
  assert.equal(p.q('[data-fc-chip]').getAttribute('data-fc-chip'),forecasts[2].id);assert.equal(p.q('[data-fc-chip]').getAttribute('aria-pressed'),'true');
  // Status, cards and the chart.
  assert.equal(p.q('[data-fc-pill-text]').textContent,'Live');assert.equal(p.q('[data-fc-banner]').hidden,true);
  assert.equal(p.q('[data-fc-pair]').textContent,'BTC · USDT-perp · 1h');
  const card=p.q('[data-fc-forecast]');
  assert.match(card.innerHTML,/<dt>Sparade versioner<\/dt><dd>4<\/dd>/);
  // The data end first, as in the version list and the 'Jämförs med' line.
  assert.match(card.textContent,new RegExp('Senaste versionen · data t\\.o\\.m\\. '+hhmm(closed[c].t+HOUR)+' · skapad '+hhmm(p.rt.at)+' · live'));
  assert.ok(card.textContent.includes('Ett möjligt scenario byggt av '+FORECAST_PARAMS.k+' liknande historiska lägen, inte ett löfte. Bandet visar spridningen mellan dem.'));
  const cs=comparisonStats(forecasts[2],closed,10);assert.equal(cs.elapsed,5);
  assert.ok(card.textContent.includes(`5 av 10 candles har utfall · scenariots medelfel ${fixed(cs.mae*100,2)}\xa0%`),'its outcomes at once');
  assert.ok(card.textContent.includes('Jämförs meddata t.o.m. '+stamp(closed[c-5].t+HOUR,p.rt.at)+' · skapad '+hhmm(p.rt.at)+' · efterhand'),'named as in the select');
  assert.doesNotMatch(card.innerHTML,/Integritet/);
  const signal=p.q('[data-fc-signal]');
  assert.match(signal.textContent,/INGEN SIGNAL/);assert.match(signal.textContent,new RegExp('Bekräftad '+hhmm(closed[c].t+HOUR)+' när candlen stängde'));
  assert.equal(signal.querySelectorAll('.fc-recent li').length,5);assert.equal(signal.querySelectorAll('.fc-checks li').length,7);
  assert.ok(p.draw()>=1);
  const texts=drawn(p.ctx);
  assert.ok(texts.includes('Forecast — estimated scenario'));assert.ok(texts.includes('Data t.o.m. '+hhmm(closed[c].t+HOUR)));
  assert.ok(p.ctx.calls.some(k=>k[0]==='fillRect'&&k[1]===CHART_COLORS.fcFill),'gray forecast candles');
});

test('a closed candle adds a new forecast version; every earlier record stays byte-identical and the opened version is compared',async()=>{
  const p=page({time:after(1998)});
  await p.view.show();
  // Opened: the newest version with closed outcomes, the backfill 5 candles back.
  const first=await records(p.store),opened=first.forecasts.at(-2),json=new Map([...first.signals,...first.forecasts].map(r=>[r.id,JSON.stringify(r)]));
  // Within the candle nothing new is made.
  p.rt.at+=5*SEC;await p.view.refreshLive();
  assert.equal((await records(p.store)).forecasts.length,4);
  p.rt.at=after(1999);await p.view.refreshLive();
  const next=await records(p.store),closed=await loaded(p.rt);
  assert.equal(next.forecasts.length,5);
  const added=next.forecasts.at(-1);
  assert.deepEqual([added.cutoff,added.cutoffClose,added.origin,added.createdAt],[m.bar(1999).t,m.bar(1999).t+HOUR,'live',p.rt.at]);
  assert.equal(added.contentHash,forecastRecord('u1','BTC','1h',forecastAt(closed,closed.length-1,{tf:'1h'}),{createdAt:1,origin:'live',tfMs:HOUR}).contentHash);
  for(const r of [...next.signals,...next.forecasts.slice(0,-1)]){assert.equal(JSON.stringify(r),json.get(r.id),'unchanged: '+r.id);assert.ok(verifyRecord(r));}
  assert.equal(next.signals.length,first.signals.length);
  // The newest version is drawn filled; the comparison stays on the version it opened with, while new candles close.
  const select=p.q('[data-fc-compare]');
  assert.equal(select.options[0].value,added.id);assert.equal(select.value,opened.id);
  const s=comparisonStats(opened,closed,10);
  assert.equal(s.elapsed,6);
  assert.ok(p.q('[data-fc-forecast]').textContent.includes(`6 av 10 candles har utfall · scenariots medelfel ${fixed(s.mae*100,2)}\xa0% · riktning ${s.dirHits} av ${s.dirN} · ${s.in80} av 6 inom 80\xa0%-bandet`));
  // Quick picks offer the earlier versions that have outcomes; choosing one compares with it.
  const chips=p.q('[data-fc-chips]').querySelectorAll('[data-fc-chip]');
  assert.deepEqual(chips.map(b=>b.getAttribute('data-fc-chip')),next.forecasts.slice(0,-1).reverse().map(r=>r.id));
  assert.deepEqual(chips.map(b=>b.getAttribute('aria-pressed')),['false','true','false','false']);
  assert.match(chips[0].textContent,/^t\.o\.m\. \d\d:\d\d · 1 utfall$/);assert.match(chips[1].textContent,/^t\.o\.m\. \d\d:\d\d · 6 utfall$/);
  click(chips[3]);
  assert.equal(select.value,next.forecasts[0].id);
  assert.match(p.q('[data-fc-forecast]').textContent,/^.*10 av 10 candles har utfall/);
  p.draw();
  assert.ok(p.ctx.calls.some(k=>k[0]==='strokeRect'&&k[1]===CHART_COLORS.fcOutline),'outlines of compared candles');
  enter(select,added.id);
  assert.match(p.q('[data-fc-forecast]').textContent,/Jämförs medsamma version/);
  // The newest version has no closed outcome yet: no outline, only its ten gray candles from the forming candle on.
  p.ctx.calls.length=0;p.draw();
  assert.ok(!p.ctx.calls.some(k=>k[0]==='strokeRect'&&k[1]===CHART_COLORS.fcOutline));
  assert.equal(p.ctx.calls.filter(k=>k[0]==='fillRect'&&k[1]===CHART_COLORS.fcFill).length,10);
});

test('a reload with a different history start shows the same signals and versions, with no conflicts',async()=>{
  const p=page({time:after(1998)});
  await p.view.show();
  p.rt.at=after(1999);await p.view.refreshLive();
  const before=await records(p.store),json=new Map([...before.signals,...before.forecasts].map(r=>[r.id,JSON.stringify(r)]));
  // Four hours later in a new tab: the 2000 loaded candles start five candles later.
  const again=page({time:after(2003),storage:p.storage,store:p.store,locks:p.locks,prefs:p.prefs});
  await again.view.show();
  const closed=await loaded(again.rt),first=await loaded({at:after(1998),market:m});
  assert.equal(closed[0].t-first[0].t,5*HOUR,'a different history start');
  const now=await records(again.store);
  assert.deepEqual(now.signals.map(r=>JSON.stringify(r)),before.signals.map(r=>JSON.stringify(r)),'signals recomputed and identical');
  assert.deepEqual(now.forecasts.slice(0,-1).map(r=>JSON.stringify(r)),before.forecasts.map(r=>JSON.stringify(r)));
  assert.deepEqual([now.forecasts.at(-1).cutoff,now.forecasts.at(-1).origin],[m.bar(2003).t,'live'],'only the new candle gets a version, no new backfill');
  assert.equal(now.corrupt,0);
  assert.doesNotMatch(again.q('[data-fc-forecast]').innerHTML,/Integritet/);
  // Recomputed from the shifted window every stored version is identical, so nothing could conflict.
  const features=forecastFeatures(closed);
  for(const r of before.forecasts){
    const f=forecastAt(closed,closed.findIndex(b=>b.t===r.cutoff),{tf:'1h',features});
    assert.equal(forecastRecord('u1','BTC','1h',f,{createdAt:1,origin:'live',tfMs:HOUR}).contentHash,r.contentHash);
  }
  for(const [id,text] of json)assert.equal(JSON.stringify((await again.store.get(id))),text);
  // The reloaded chart compares with the newest version that had closed outcomes when it opened (data t.o.m. 1999's close).
  assert.equal(again.q('[data-fc-compare]').value,now.forecasts.at(-2).id);assert.equal(now.forecasts.at(-2).cutoff,m.bar(1999).t);
});

test('conflicting and damaged stored records are kept untouched and shown as integrity warnings',async()=>{
  const backend=memoryBackend(),store=createForecastStore(backend),time=after(1998),closed=await loaded({at:time,market:m});
  // Different content under the id of the first scripted signal, and a forecast changed after it was sealed.
  const i=closed.findIndex(b=>b.t===m.signals[0].t),e=evaluateBar(closed,i,{tf:'1h'});
  const other=signalRecord('u1','BTC','1h',{...e,entry:e.entry*1.01},{recordedAt:time-DAY,origin:'live',tfMs:HOUR});
  assert.deepEqual(await store.putSignal(other),{stored:true});
  const sealed=forecastRecord('u1','BTC','1h',forecastAt(closed,closed.length-40,{tf:'1h'}),{createdAt:time-DAY,origin:'live',tfMs:HOUR});
  await backend.add({...structuredClone(sealed),forecast:{...structuredClone(sealed.forecast),base:sealed.forecast.base*1.1}});
  const p=page({time,store});
  await p.view.show();
  const warnings=p.q('.fc-integrity');
  assert.ok(warnings,'integrity warnings shown');
  assert.match(warnings.textContent,new RegExp('Den sparade signalen för BTC \\d+ jun \\d\\d:\\d\\d skiljer sig från en ny beräkning — originalet behålls'));
  assert.match(warnings.textContent,/En sparad post klarar inte kontrollsumman och visas inte\. Originalen lämnas orörda\./);
  const {signals,forecasts}=await records(store);
  assert.equal(signals.find(r=>r.barTime===e.t).hash,other.hash,'the original stays');
  assert.ok(!forecasts.some(r=>r.id===sealed.id));
  assert.ok(!p.q('[data-fc-compare]').options.some(o=>o.value===sealed.id),'a damaged version is never offered');
  // A stored version exists (the damaged one), so no as-of backfill is added.
  assert.deepEqual(forecasts.map(r=>r.origin),['live']);
});

test('a closed candle that Bybit changes afterwards is reported while the stored records stay as they were; signed out nothing is stored',async()=>{
  const p=page({time:after(1998)});
  await p.view.show();
  const before=await records(p.store),json=[...before.signals,...before.forecasts].map(r=>JSON.stringify(r));
  // Bybit now serves the newest closed candle 0,1 % higher than it did when it closed.
  p.rt.shocks=[{symbol:'BTC',at:m.bar(1998).t,factor:1.001}];p.rt.at+=5*SEC;
  await p.view.refreshLive();
  const warning=p.q('.fc-integrity');
  assert.ok(warning);
  assert.match(warning.textContent,new RegExp('Bybit har ändrat en stängd candle i efterhand \\(senast '+hhmm(m.closeOf(1998))+'\\)\\. Sparade signaler och prognoser är oförändrade\\.'));
  const after_=await records(p.store);
  assert.deepEqual([...after_.signals,...after_.forecasts].map(r=>JSON.stringify(r)),json);
  // Signed out the chart still shows Bybit's candles, but no record is made for anyone.
  const store=createForecastStore(memoryBackend()),out=page({time:after(1998),user:null,store});
  await out.view.show();
  assert.equal(out.q('[data-fc-pill-text]').textContent,'Live');
  assert.deepEqual(await records(store),{signals:[],forecasts:[],corrupt:0});
  assert.match(out.q('[data-fc-account]').textContent,/Logga in för att handla med AI Forecast-kontot/);
  assert.equal(out.q('[data-fc-pause]').disabled,true);assert.equal(out.q('[data-fc-save]').disabled,true);
  assert.ok(out.draw()>0);assert.ok(drawn(out.ctx).some(t=>/^\d+ \d{3}$/.test(t)),'price axis drawn');
});

test('missing data is unmistakable and pauses new demo entries; entries resume when the data is live again',async()=>{
  const p=page({time:after(L1.i-1)});
  await p.view.show();await p.view.refreshLive();
  assert.equal(p.q('[data-fc-pill-text]').textContent,'Live');
  assert.match(p.q('[data-fc-forecast]').textContent,/För kort historik för prognos/,'a short history gets no forecast');
  // Bybit's candles stop arriving while the first long breakout closes.
  p.rt.fail=u=>u.pathname.endsWith('/kline')?'Nätverksfel':null;
  p.rt.at=after(L1.i);await p.view.refreshLive();
  // About the chart's own candles, and since the account's runner finds BTC unreliable too, its pause for BTC.
  const banner=p.q('[data-fc-banner]'),chartText='Data saknas — nya demoaffärer i BTC pausade',text='BTC 1h: '+chartText;
  assert.equal(banner.hidden,false);assert.equal(banner.textContent,text);
  assert.equal(p.q('[data-fc-pill-text]').textContent,'Data saknas');assert.equal(p.q('[data-fc-pill]').getAttribute('data-state'),'bad');
  assert.equal(p.q('[data-fc-pill]').getAttribute('title'),chartText,'the pill\'s hover text names the account\'s pause for BTC too');
  // Screen readers hear the change once; the visible texts keep updating.
  const announce=p.q('[data-fc-announce]');
  assert.equal(announce.getAttribute('role'),'status');assert.equal(announce.textContent,text);
  assert.ok(p.q('[data-fc-signal]').textContent.includes(chartText));
  p.draw();assert.ok(drawn(p.ctx).includes(chartText),'the chart shows the status badge');
  assert.ok(!drawn(p.ctx).some(t=>/^(Entry|SL|TP) /.test(t)),'no level lines');
  assert.match(p.q('[data-fc-account]').textContent,/Data opålitlig för BTC, ETH, SOL, XRP, DOGE, SHIB, PEPE — nya affärer pausade/);
  let a=account(p);
  assert.deepEqual(a.positions,[]);assert.ok(!a.log.some(e=>e.kind==='öppnad'));
  assert.deepEqual((await records(p.store)).signals,[],'nothing is stored from missing data');
  // Back inside the signal's window: the runner trades it and the chart draws the open position's levels.
  p.rt.fail=null;p.rt.at=after(L1.i,20*SEC);await p.view.refreshLive();
  a=account(p);
  assert.deepEqual(a.positions.map(x=>[x.symbol,x.leverage]),[['BTC',MAX_LEVERAGE.BTC],['ETH',MAX_LEVERAGE.ETH],['SOL',MAX_LEVERAGE.SOL]]);
  assert.equal(p.q('[data-fc-pill-text]').textContent,'Live');assert.equal(banner.hidden,true);assert.equal(announce.textContent,'Datan är live');
  const stored=(await records(p.store)).signals;
  assert.deepEqual(stored.map(r=>[r.barTime,r.origin]),[[L1.t,'live']]);
  const btc=a.positions[0],dec=priceDecimals(btc.entry);
  p.draw();
  // Axis tags; a level outside the visible prices is pinned to the edge with an arrow.
  const texts=drawn(p.ctx).map(t=>t.replace(/^[▲▼] /,''));
  for(const [name,value] of [['Entry',btc.entry],['SL',btc.sl],['TP',btc.tp],['Likv.',btc.liq]])assert.ok(texts.includes(name+' '+fixed(value,dec)),name);
  assert.ok(texts.includes('KÖP'));
  const card=p.q('[data-fc-account]');
  assert.equal(card.querySelectorAll('[data-fc-close]').length,3);
  assert.match(card.textContent,/Öppna positioner · 3 av 3/);
});

test('levels: open positions first, otherwise only the latest signal while it is still live',()=>{
  const ms=HOUR,t0=Date.UTC(2026,8,1),hold=SIGNAL_PARAMS.maxHold;
  const bar=(i,l=99,h=101)=>({t:t0+i*ms,o:100,h,l,c:100,v:1});
  const bars=n=>Array.from({length:n},(_,i)=>bar(i));
  const sig=(i,side='long',over={})=>({id:'s'+i,symbol:'BTC',tf:'1h',barTime:t0+i*ms,side,entry:100,sl:side==='long'?97:103,tp:side==='long'?106:94,...over});
  const kinds=x=>x.map(l=>[l.kind,l.price,l.from]);
  // The signal candle is the newest closed one: entry, SL and TP from that candle.
  assert.deepEqual(kinds(chartLevels({symbol:'BTC',tf:'1h',signals:[sig(9)],bars:bars(10)})),[['entry',100,t0+9*ms],['sl',97,t0+9*ms],['tp',106,t0+9*ms]]);
  // Still live with maxHold − 1 candles closed after it; decided at maxHold.
  assert.equal(chartLevels({symbol:'BTC',tf:'1h',signals:[sig(9)],bars:bars(10+hold-1)}).length,3);
  assert.deepEqual(chartLevels({symbol:'BTC',tf:'1h',signals:[sig(9)],bars:bars(10+hold)}),[]);
  // A closed candle touching the target or the stop decides it; the forming one does not count (not in bars).
  const touched=(lo,hi)=>[...bars(12),bar(12,lo,hi),bar(13)];
  assert.deepEqual(chartLevels({symbol:'BTC',tf:'1h',signals:[sig(9)],bars:touched(99,106)}),[]);
  assert.deepEqual(chartLevels({symbol:'BTC',tf:'1h',signals:[sig(9)],bars:touched(97,101)}),[]);
  assert.equal(chartLevels({symbol:'BTC',tf:'1h',signals:[sig(9)],bars:touched(97.01,105.99)}).length,3);
  // Shorts mirror: a high at the stop or a low at the target decides.
  assert.deepEqual(chartLevels({symbol:'BTC',tf:'1h',signals:[sig(9,'short')],bars:touched(99,103)}),[]);
  assert.deepEqual(chartLevels({symbol:'BTC',tf:'1h',signals:[sig(9,'short')],bars:touched(94,101)}),[]);
  assert.equal(chartLevels({symbol:'BTC',tf:'1h',signals:[sig(9,'short')],bars:touched(94.5,102.5)}).length,3);
  // A missing candle after the signal: unknown, so no lines.
  assert.deepEqual(chartLevels({symbol:'BTC',tf:'1h',signals:[sig(9)],bars:bars(14).filter((_,i)=>i!==11)}),[]);
  // Only the latest signal counts: a decided newer one hides a live-looking older one.
  assert.deepEqual(chartLevels({symbol:'BTC',tf:'1h',signals:[sig(8),sig(10,'long',{tp:100.5})],bars:bars(13)}),[]);
  // Other coins and timeframes are ignored.
  assert.deepEqual(chartLevels({symbol:'BTC',tf:'1h',signals:[sig(9,'long',{symbol:'ETH'}),sig(9,'long',{tf:'4h'})],bars:bars(10)}),[]);
  // An open position on this coin wins, with its liquidation, from the candle it opened in.
  const position={symbol:'BTC',side:'long',entry:100.2,sl:97,tp:106,liq:99.4,openedAt:t0+10*ms+42000};
  assert.deepEqual(kinds(chartLevels({symbol:'BTC',tf:'1h',positions:[position],signals:[sig(9)],bars:bars(12)})),
    [['entry',100.2,t0+10*ms],['sl',97,t0+10*ms],['tp',106,t0+10*ms],['liq',99.4,t0+10*ms]]);
  assert.equal(chartLevels({symbol:'BTC',tf:'1h',positions:[{...position,symbol:'ETH'}],signals:[sig(9)],bars:bars(12)}).length,3);
  assert.deepEqual(chartLevels({symbol:'BTC',tf:'1h',positions:[{...position,liq:0}],bars:bars(12)}).map(l=>l.kind),['entry','sl','tp']);
  assert.deepEqual(chartLevels({symbol:'BTC',tf:'2h',signals:[sig(9)],bars:bars(10)}),[]);
});

test('the values beside the rule checks are the numbers of the explanation lines, also right at a limit',()=>{
  const bars=m.bars(0,m.end+40),ind=computeIndicators(bars),htfBars=aggregateClosed(bars,'1h','4h',bars.at(-1).t+HOUR);
  let compared=0;
  for(let i=requiredLookback('1h');i<bars.length;i++){
    const e=evaluateBar(bars,i,{tf:'1h',ind,htfBars}),text=key=>checkText(e.checks.find(c=>c.key===key),e,0),lines=e.explanation.join(' | ');
    if(e.regime==='insufficient'){assert.ok(e.checks.every(c=>checkText(c,e,0)==='–'||c.key==='cooldown'));continue;}
    for(const key of ['trend','momentum','volatility'])assert.ok(lines.includes(text(key)),i+': '+text(key)+' in '+lines);
    if(e.features.relVol!==null)assert.ok(lines.includes('Volym '+text('volume'))||lines.includes('('+text('volume')+')'),i+': '+text('volume'));
    compared++;
  }
  assert.ok(compared>300);
  // Just past a limit the value never rounds onto the limit it missed.
  const lean={features:{emaFast:2,emaSlow:1}},c=(key,value)=>({key,ok:false,value});
  assert.equal(checkText(c('trend',17.96),lean,0),'ADX 17,9');
  assert.equal(checkText(c('trend',21.97),lean,0),'ADX 21,9');
  assert.equal(checkText(c('momentum',75.04),lean,0),'RSI 75,1');
  assert.equal(checkText(c('momentum',49.97),lean,0),'RSI 49,9');
  assert.equal(checkText(c('volume',1.0996),lean,0),'1,09× median');
  assert.equal(checkText(c('volatility',.9504),lean,0),'percentil 95,1');
  assert.equal(checkText(c('volatility',.0996),lean,0),'percentil 9,9');
  assert.equal(checkText(c('htf',-1),lean,0),'nedåt');assert.equal(checkText(c('trigger',85230.4),lean,0),'85 230');
  assert.equal(checkText({key:'cooldown',ok:true,value:null},lean,0),'ingen nyligen');assert.equal(checkText(c('cooldown',3),lean,0),'signal för 3 candles sedan');
  assert.equal(checkText(c('cooldown',1),lean,0),'signal för 1 candle sedan','one candle is singular');
});

test('manual close asks first, shows the result and leaves a failed close open',async()=>{
  const p=page({time:after(L1.i),settings:{symbols:['BTC'],leverage:10}});
  await p.view.show();await p.view.refreshLive();
  const [pos]=account(p).positions,button=()=>p.q(`[data-fc-close="${pos.id}"]`),msg=p.q('[data-fc-account-msg]');
  assert.equal(pos.symbol,'BTC');assert.equal(button().textContent,'Stäng');
  // Declined: nothing happens.
  p.who.answer=false;click(button());
  assert.deepEqual(p.asked,['Stäng lång BTC till marknadspris nu? Hela positionen stängs i demokontot.']);
  await turn();assert.equal(account(p).positions.length,1);
  // A failing read is reported and the position stays open.
  p.who.answer=true;p.rt.fail='Proxy nere';p.rt.at+=10*MIN;
  click(button());
  // Busy, but still focusable: marked aria-disabled rather than disabled.
  assert.equal(button().textContent,'Stänger…');assert.deepEqual([button().disabled,button().getAttribute('aria-disabled')],[false,'true']);
  await until(()=>msg.textContent==='Kunde inte stänga BTC: Proxy nere','the failed close');
  assert.ok(msg.classList.contains('bad'));assert.equal(account(p).positions.length,1);assert.equal(busy(button()),false);
  // Closed at market.
  p.rt.fail=null;click(button());
  await until(()=>/^Stängde lång BTC/.test(msg.textContent),'the close');
  const a=account(p),[trade]=a.trades;
  assert.deepEqual(a.positions,[]);assert.equal(trade.reason,'manuell');
  assert.equal(msg.textContent,'Stängde lång BTC till '+trade.exit.toLocaleString('sv-SE',{maximumSignificantDigits:6})+' · '+(trade.pnl<0?'−':'+')+fixed(Math.abs(trade.pnl),2)+'\xa0$');
  assert.ok(!msg.classList.contains('bad'));
  assert.equal(button(),null);
  assert.match(p.q('[data-fc-account]').textContent,new RegExp('BTClång · '+tradeReasons.manuell));
});

test('settings are validated, saved through the runner, and pause, resume and reset with archive work',async()=>{
  const p=page({time:after(L1.i-1)});
  await p.view.show();await p.view.refreshLive();
  const f=name=>p.q(`[name="${name}"]`),boxes=()=>p.root.querySelectorAll('input[name="symbols"]'),msg=p.q('[data-fc-settings-msg]'),save=p.q('[data-fc-save]');
  assert.deepEqual(['positionPct','riskPct','maxOpen','leverage','tf'].map(k=>f(k).value),['25','10','3','max','1h']);
  assert.deepEqual(boxes().filter(b=>b.checked).map(b=>b.value),[...SYMBOLS]);
  assert.deepEqual(f('leverage').options.map(o=>o.textContent),['Bybit max','1×','2×','3×','5×','10×','20×','50×']);
  // Invalid input is refused in Swedish and nothing is saved.
  enter(f('maxOpen'),'9');click(save);
  await until(()=>msg.textContent==='Max öppna positioner ska vara 1–7','the refusal');
  assert.ok(msg.classList.contains('bad'));assert.equal(account(p).settings.maxOpen,3);
  enter(f('positionPct'),'');click(save);
  assert.equal(msg.textContent,'Ange positionsstorleken i procent av kapitalet');
  // A valid change: 10 % margin, 2,5 % risk, two positions, 10×, 4h candles, BTC and ETH.
  enter(f('positionPct'),'10');enter(f('riskPct'),'2,5');enter(f('maxOpen'),'2');enter(f('leverage'),'10');enter(f('tf'),'4h');
  for(const b of boxes())enter(b,['BTC','ETH'].includes(b.value));
  click(save);
  await until(()=>/^Sparat/.test(msg.textContent),'the save');
  assert.equal(msg.textContent,'Sparat. Gäller nya affärer; kontot handlar nu på 4h-candles.');
  assert.deepEqual(account(p).settings,{tf:'4h',symbols:['BTC','ETH'],positionPct:.1,riskPct:.025,maxOpen:2,leverage:10,paused:false});
  assert.deepEqual(['positionPct','riskPct','maxOpen','leverage','tf'].map(k=>f(k).value),['10','2.5','2','10','4h']);
  for(const b of boxes())enter(b,false);
  click(save);
  await until(()=>msg.textContent==='Välj minst ett par att handla','the empty pairs');
  // Pause and resume.
  const pause=p.q('[data-fc-pause]'),note=p.q('[data-fc-account-msg]');
  click(pause);
  await until(()=>account(p).settings.paused===true&&pause.textContent==='▶ Återuppta nya affärer','the pause');
  assert.equal(note.textContent,'Nya affärer är pausade. Öppna positioner skyddas och stängs som vanligt.');
  assert.match(p.q('[data-fc-account] .fc-status').textContent,/^Pausad$/);
  click(pause);
  await until(()=>account(p).settings.paused===false&&pause.textContent==='⏸ Pausa nya affärer','the resume');
  // Reset: asks first, archives the old account under before-reset and keeps the settings.
  const key=accountKey('u1'),old=p.storage.getItem(key);
  p.who.answer=false;click(p.q('[data-fc-reset]'));await turn();
  assert.equal(p.storage.getItem(key),old);
  p.who.answer=true;p.rt.at+=MIN;click(p.q('[data-fc-reset]'));
  await until(()=>/^Kontot är återställt/.test(note.textContent),'the reset');
  assert.equal(p.storage.getItem(key+':before-reset:'+p.rt.at),old);
  const fresh=account(p);
  assert.deepEqual([fresh.createdAt,fresh.cash,fresh.trades.length,fresh.settings.tf,fresh.settings.symbols],[p.rt.at,100,0,'4h',['BTC','ETH']]);
  assert.equal(p.asked.at(-1),'Arkivera AI Forecast-kontot och börja om med 100 $? Inställningarna behålls. Öppna positioner följer med i arkivet utan att stängas.');
});

test('renderSummary shows the account compactly in the Kryptokonton tab, follows the runner and escapes what it shows',async()=>{
  const p=page({time:after(L1.i)}),box=p.doc.createElement('section');
  p.view.renderSummary(box);
  assert.match(box.textContent,/Laddar AI Forecast-kontot…/);
  const link=box.querySelector('a[href="#forecast"]');assert.equal(link.textContent,'Öppna AI Forecast →');
  // The runner's tick (hidden view) opens the fresh signal at Bybit's maximum; the summary follows by itself.
  await p.view.refreshLive();
  const cells=Object.fromEntries(box.querySelectorAll('.fc-sum-grid div').map(d=>[d.querySelector('span').textContent,d.querySelector('b').textContent]));
  assert.deepEqual(Object.keys(cells),['Kapital · live','Sedan start','Öppna positioner','Avslutade affärer','Vinstandel']);
  assert.equal(cells['Öppna positioner'],'3 av 3');assert.equal(cells['Avslutade affärer'],'0');assert.equal(cells['Vinstandel'],'–');
  assert.match(cells['Kapital · live'],/^\d+,\d\d\xa0\$$/);assert.match(cells['Sedan start'],/^[+−]?\d+,\d\d\xa0\$ · [+−]?\d+,\d\xa0%$/);
  assert.match(box.querySelector('.fc-sum-state').textContent,/^Handlar · 3 av 3 positioner · nästa beslut \d\d:\d\d$/);
  assert.match(box.textContent,/Eget demokonto från 100,00\xa0\$ som handlar AI Forecast-signalerna på 1h med Bybits maxhävstång\. Inga riktiga order\./);
  // Signed out.
  p.who.user=null;await p.view.refreshLive();
  assert.match(box.textContent,/Logga in för att handla med AI Forecast-kontot/);assert.equal(box.querySelector('.fc-sum-grid'),null);
  // Text from the runner and the records is inserted as text, never as markup.
  const evil='<img src=x onerror="alert(1)">';
  const fake={tick:async()=>{},status:()=>({state:'error',text:evil,notes:[evil]}),account:()=>null,live:()=>null,
    closePosition:async()=>({ok:false,text:evil}),updateSettings:async()=>{throw Error(evil);},setPaused:async()=>{throw Error(evil);},reset:async()=>{throw Error(evil);}};
  const q=page({time:after(1998),runner:fake}),other=q.doc.createElement('section');
  q.view.renderSummary(other);await q.view.show();
  assert.equal(other.querySelector('img'),null);assert.ok(other.textContent.includes(evil),'shown as text');
  assert.equal(q.root.querySelector('img'),null);assert.ok(q.q('.fc-integrity').textContent.includes(evil));
  click(q.q('[data-fc-pause]'));
  await until(()=>q.q('[data-fc-account-msg]').textContent===evil,'the refusal');
  assert.equal(q.root.querySelector('img'),null);
});

test('leaving the view stops chart polling and drawing while refreshLive keeps ticking the runner',async()=>{
  const p=page({time:after(L1.i-1)});
  await p.view.show();await p.view.refreshLive();p.draw();
  // The chart polls the three newest 1h candles; the runner reads 1000 of them, and 5-minute candles for its positions.
  const chartPoll=()=>p.rt.urls.some(u=>u.pathname.endsWith('/kline')&&u.searchParams.get('interval')==='60'&&u.searchParams.get('limit')==='3');
  p.rt.urls=[];p.rt.at+=5*SEC;await p.view.refreshLive();
  assert.ok(chartPoll(),'shown: the chart polls the newest candles');
  assert.ok(p.draw()>0,'and draws');
  p.view.hide();p.who.visible=false;
  const before=frames(p.ctx);
  // Hidden: at the next candle close the runner reads, stores and trades; the chart neither polls nor draws.
  p.rt.urls=[];p.rt.at=after(L1.i);await p.view.refreshLive();
  assert.ok(!chartPoll(),'no chart poll');
  assert.ok(p.rt.urls.some(u=>u.pathname.endsWith('/kline')&&u.searchParams.get('limit')==='1000'),'the runner read its candles');
  assert.equal(account(p).positions.length,3,'the runner traded the fresh signal');
  assert.equal(p.draw(),0);assert.equal(frames(p.ctx),before,'nothing drawn while hidden');
  for(let k=0;k<3;k++){p.rt.urls=[];p.rt.at+=5*SEC;await p.view.refreshLive();assert.ok(!chartPoll());}
  // Outside crypto mode the runner rests and nothing at all is read.
  p.who.active=false;p.rt.urls=[];p.rt.at+=HOUR;await p.view.refreshLive();
  assert.deepEqual(p.rt.urls,[]);
  // Shown again: the series it had catches up with one read of the newest candles instead of 2000 again, and draws.
  p.who.active=true;p.who.visible=true;p.rt.urls=[];
  await p.view.show();
  assert.ok(chartPoll(),'the newest candles');
  assert.ok(!p.rt.urls.some(u=>u.pathname.endsWith('/kline')&&u.searchParams.get('limit')==='1000'),'no reload of the whole history');
  assert.equal(p.q('[data-fc-pill-text]').textContent,'Live');
  assert.ok(p.draw()>0);assert.ok(frames(p.ctx)>before);
});

test('the toolbar switches coin, timeframe, length and layers, and the choices are kept per browser',async()=>{
  const p=page({time:after(1998)});
  await p.view.show();
  click(p.q('[data-fc-tf="4h"]'));
  assert.equal(p.q('[data-fc-tf="4h"]').getAttribute('aria-pressed'),'true');assert.equal(p.q('[data-fc-tf="1h"]').getAttribute('aria-pressed'),'false');
  await until(()=>p.q('[data-fc-pill-text]').textContent==='Live'&&p.q('[data-fc-pair]').textContent==='BTC · USDT-perp · 4h','the 4h series');
  assert.ok(p.rt.urls.some(u=>u.searchParams.get('interval')==='240'));
  // 2000 hourly candles make 500 four-hour candles: too short for a forecast that cannot depend on where the history starts.
  await until(()=>/För kort historik för prognos/.test(p.q('[data-fc-forecast]').textContent),'the 4h forecast note');
  assert.equal(p.q('[data-fc-compare]').disabled,true);
  enter(p.q('[data-fc-symbol]'),'ETH');
  await until(()=>p.q('[data-fc-pair]').textContent==='ETH · USDT-perp · 4h'&&p.q('[data-fc-pill-text]').textContent==='Live','the ETH series');
  click(p.q('[data-fc-horizon="20"]'));click(p.q('[data-fc-toggle="band"]'));click(p.q('[data-fc-toggle="levels"]'));
  assert.equal(p.q('[data-fc-toggle="band"]').getAttribute('aria-pressed'),'false');
  assert.deepEqual(JSON.parse(p.prefs.getItem('riptide.forecast.ui.v1')),{symbol:'ETH',tf:'4h',horizon:20,band:false,signals:true,levels:false});
  assert.equal(p.q('[data-fc-eval="pair"]').textContent,'Kör för ETH 4h');
  // A new tab in the same browser starts where this one left off.
  const again=page({time:after(1998),prefs:p.prefs});
  await again.view.show();
  assert.equal(again.q('[data-fc-symbol]').value,'ETH');assert.equal(again.q('[data-fc-horizon="20"]').getAttribute('aria-pressed'),'true');
  assert.equal(again.q('[data-fc-toggle="levels"]').getAttribute('aria-pressed'),'false');
  // Zoom buttons act on the chart.
  again.draw();click(again.q('[data-fc-zoom="in"]'));assert.ok(again.draw()>0);
  // Unusable stored choices fall back to the defaults.
  const prefs=memoryStorage();prefs.setItem('riptide.forecast.ui.v1','{"symbol":"<b>","tf":"2h","horizon":7}');
  const plain=page({time:after(1998),prefs});
  assert.equal(plain.q('[data-fc-symbol]').value,'BTC');assert.equal(plain.q('[data-fc-tf="1h"]').getAttribute('aria-pressed'),'false','painted on show');
  await plain.view.show();
  assert.equal(plain.q('[data-fc-tf="1h"]').getAttribute('aria-pressed'),'true');assert.equal(plain.q('[data-fc-horizon="10"]').getAttribute('aria-pressed'),'true');
});

test('on 4h and daily candles the data end of every version carries its date',async()=>{
  const prefs=memoryStorage();prefs.setItem('riptide.forecast.ui.v1',JSON.stringify({symbol:'BTC',tf:'4h',horizon:10,band:true,signals:true,levels:true}));
  const p=page({time:after(8003),prefs});
  await p.view.show();
  const closed=await loaded(p.rt,'BTC','4h'),c=closed.length-1,options=p.q('[data-fc-compare]').options;
  assert.equal(closed.length,1999);assert.equal(options.length,4);
  assert.deepEqual(options.map(o=>o.textContent.replace(/ · skapad \d\d:\d\d/,'')),[
    'data t.o.m. '+stamp(closed[c].t+4*HOUR,0)+' · senaste',...[5,10,20].map(k=>'data t.o.m. '+stamp(closed[c-k].t+4*HOUR,0)+' · efterhand')]);
  assert.ok(options.every(o=>/data t\.o\.m\. \d+ [a-zåäö]+ \d\d:\d\d/.test(o.textContent)));
  assert.match(p.q('[data-fc-forecast]').textContent,/Senaste versionen · data t\.o\.m\. \d+ [a-zåäö]+ \d\d:\d\d · skapad \d\d:\d\d · live/);
});

test('walk-forward runs on demand, yields between steps, labels every number as measured history and uses no confidence wording',async()=>{
  // Each time the view yields to the page, the progress it shows is recorded.
  const seen=[],p=page({time:after(1998),defer:()=>{seen.push(p.q('[data-fc-eval-progress]').textContent);return new Promise(r=>setImmediate(r));}}),box=p.doc.createElement('section');
  await p.view.show();await p.view.refreshLive();p.view.renderSummary(box);
  const run=p.q('[data-fc-eval="pair"]'),result=p.q('[data-fc-eval-result]'),progress=p.q('[data-fc-eval-progress]');
  assert.equal(run.textContent,'Kör för BTC 1h');
  click(run);
  assert.equal(busy(run),true);assert.equal(busy(p.q('[data-fc-eval="portfolio"]')),true);
  await until(()=>!busy(run),'the walk-forward');
  assert.ok(seen.includes('BTC · 1h: hämtar funding för BTC…'),'progress while reading');
  const steps=seen.filter(t=>/^BTC · 1h: .* · steg \d+ av \d+$/.test(t));
  assert.ok(steps.length>=5,'the page gets a turn between the walk-forward steps');assert.ok(steps.some(t=>/Prognoser BTC · fönster 4 av 4/.test(t)));
  assert.equal(progress.textContent,'');
  const text=result.textContent;
  assert.match(text,/BTC · 1h · uppmätt i efterhand \d+ \w+ 2026 – \d+ \w+ 2026, utanför träningsfönstren/);
  for(const note of ['Reglerna och parametrarna bestämdes i förväg; inget valdes på testfönstren efter 1 okt 2025.','Alla mått är uppmätta i efterhand på historik utanför träningsfönstren, inte löften om framtiden.',
    'Bybits nuvarande hävstångsgränser används bakåt.'])assert.ok(text.includes(note),note);
  assert.deepEqual(result.querySelectorAll('.fc-tile span').map(x=>x.textContent),['Affärer','Vinstandel','Netto','Max nedgång','Vinstfaktor']);
  const tables=result.querySelectorAll('table');
  assert.equal(tables.length,2);assert.equal(tables[0].querySelectorAll('tbody tr').length,4,'four test windows');
  assert.deepEqual(tables[1].querySelectorAll('thead th').map(th=>th.textContent),['Candles fram','5','10','20']);
  const rows=tables[1].querySelectorAll('tbody tr');
  assert.deepEqual(rows.map(r=>r.querySelector('th').textContent),['Medelfel','Naivt fel','Skill','Rätt riktning','Prognoser med riktning','Inom 50\xa0%-bandet','Inom 80\xa0%-bandet','Prognoser']);
  assert.ok(rows.slice(0,3).every(r=>r.querySelectorAll('td').every(td=>/^[+−]?\d+,\d+\xa0%$/.test(td.textContent))),'fractions shown as %');
  assert.ok(rows[3].querySelectorAll('td').every(td=>/^\d+\xa0%$/.test(td.textContent)));
  assert.ok(rows[4].querySelectorAll('td').every(td=>/^\d+$/.test(td.textContent)));
  // The same coins, sizing and closed candle come from the cache, without reading Bybit again.
  p.rt.urls=[];click(run);
  assert.deepEqual(p.rt.urls,[]);assert.equal(result.textContent,text);
  // No invented confidence anywhere in the view or the summary.
  const all=p.root.innerHTML+box.innerHTML;
  for(const word of ['konfidens','confidence','sannolikhet','probabilit','träffsäkerhet','säkerhetsgrad','chans att','certainty','garanti'])assert.doesNotMatch(all,new RegExp(word,'i'),word);
  // A portfolio runs over the account's traded coins at the account's timeframe.
  for(const b of p.root.querySelectorAll('input[name="symbols"]'))enter(b,['BTC','ETH'].includes(b.value));
  click(p.q('[data-fc-save]'));
  await until(()=>/^Sparat/.test(p.q('[data-fc-settings-msg]').textContent),'the save');
  click(p.q('[data-fc-eval="portfolio"]'));
  await until(()=>!busy(run),'the portfolio');
  assert.match(result.textContent,/^Portfölj BTC, ETH · 1h · uppmätt i efterhand/);
  assert.equal(result.querySelectorAll('table')[0].querySelectorAll('tbody tr').length,4);
});

// ---- Review fixes ------------------------------------------------------------------
// A runner stand-in that never trades, for tests about the chart alone.
const idle=()=>({tick:async()=>{},status:()=>({state:'trading',text:'Handlar',notes:[]}),account:()=>null,live:()=>null,
  closePosition:async()=>({ok:false,text:''}),updateSettings:async()=>{},setPaused:async()=>{},reset:async()=>{}});
// Lets pending work run without waiting on any one promise.
const turns=async(n=40)=>{for(let k=0;k<n;k++)await turn();};
function within(promise,ms,what){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(what+' did not settle')),ms);})]).finally(()=>clearTimeout(timer));
}
// Seals a changed record again, as anything that can write this origin's storage could.
function reseal(r,change){
  const plain={...structuredClone(r),...change};delete plain.hash;delete plain.contentHash;
  const content={...plain};for(const k of ['createdAt','recordedAt','origin'])delete content[k];
  plain.contentHash=hashOf(content);return {...plain,hash:hashOf(plain)};
}

test('a walk-forward stops when the view closes on sign-out, and the next user never sees its result',async()=>{
  const p=page({time:after(1998),defer:()=>new Promise(r=>setImmediate(r))});
  await p.view.show();
  const result=p.q('[data-fc-eval-result]'),intro=result.textContent;
  click(p.q('[data-fc-eval="portfolio"]'));
  await turn();await turn();
  // Signing out on #forecast: the page hides the view, then nobody is signed in.
  p.view.hide();p.who.visible=false;p.who.user=null;
  const at=p.rt.urls.length;
  await turns(400);
  for(let k=0;k<3;k++){p.rt.at+=5*SEC;await p.view.refreshLive();}
  assert.equal(p.rt.urls.length,at,'no request after the sign-out');
  // Another user signs in on #forecast: no result of the earlier run, and both buttons work.
  p.who.user='u2';p.who.visible=true;await p.view.show();
  assert.equal(result.textContent,intro);assert.equal(p.q('[data-fc-eval-progress]').textContent,'');
  assert.equal(busy(p.q('[data-fc-eval="portfolio"]')),false);
});

test('a new user on the same page never gets the previous user\'s unsaved settings, messages or account card',async()=>{
  const p=page({time:after(L1.i)});
  p.storage.setItem(accountKey('u2'),JSON.stringify(newForecastAccount(p.rt.at-HOUR,{maxOpen:5,positionPct:.5,leverage:3})));
  await p.view.show();await p.view.refreshLive();
  const f=name=>p.q(`[name="${name}"]`),note=p.q('[data-fc-account-msg]'),msg=p.q('[data-fc-settings-msg]'),card=p.q('[data-fc-account]');
  assert.equal(card.querySelectorAll('[data-fc-close]').length,3);
  click(p.q('[data-fc-pause]'));
  await until(()=>/pausade/.test(note.textContent),'the pause');
  enter(f('maxOpen'),'7');enter(f('positionPct'),'90');enter(f('leverage'),'50');
  // u1 signs out: the page hides the view, and nothing of u1's account stays in the document.
  p.view.hide();p.who.visible=false;p.who.user=null;await p.view.refreshLive();
  assert.equal(card.querySelectorAll('[data-fc-close]').length,0);assert.doesNotMatch(card.textContent,/Kapital/);
  assert.equal(note.textContent,'');
  // u2 signs in on #forecast and sees only u2's own settings; Spara keeps them.
  p.who.user='u2';p.who.visible=true;await p.view.show();await p.view.refreshLive();
  assert.deepEqual(['positionPct','maxOpen','leverage'].map(k=>f(k).value),['50','5','3']);
  assert.equal(note.textContent,'');assert.equal(msg.textContent,'');
  click(p.q('[data-fc-save]'));
  await until(()=>/^Sparat/.test(msg.textContent),'the save');
  const s=account(p,'u2').settings;
  assert.deepEqual([s.positionPct,s.maxOpen,s.leverage,s.paused],[.5,5,3,false]);
  assert.equal(account(p).settings.paused,true,'u1 keeps its own pause');
});

test('a chart read that never returns cannot leave the status on Live, and a fresh read takes over',async()=>{
  let hang=false,hung=0;
  const p=page({time:after(1998),runner:idle(),wrap:g=>(url,o)=>{if(hang&&new URL(url).searchParams.get('limit')==='3'){hung++;return new Promise(()=>{});}return g(url,o);}});
  await p.view.show();
  const pill=p.q('[data-fc-pill-text]'),banner=p.q('[data-fc-banner]'),tick=async()=>{p.rt.at+=5*SEC;void p.view.refreshLive();await turns();};
  await tick();assert.equal(pill.textContent,'Live');
  // The next read stalls (a response body that never ends has no deadline in the page's grab).
  hang=true;p.rt.urls=[];
  for(let k=0;k<4;k++)await tick();
  assert.equal(hung,1);assert.equal(pill.textContent,'Fördröjd');assert.equal(banner.hidden,false);
  // About the chart's candles: the account reads its own and keeps trading (this runner says Handlar), so no pause is claimed,
  // in the banner nor in the status pill's hover text.
  assert.equal(banner.textContent,'BTC 1h: Fördröjd data (20 s) · Demokontot: Handlar');
  assert.equal(p.q('[data-fc-pill]').getAttribute('title'),'Fördröjd data (20 s)');
  p.draw();assert.ok(drawn(p.ctx).includes('Fördröjd data (20 s)'),'the chart badge says so too');assert.ok(!drawn(p.ctx).some(t=>/pausade/.test(t)));
  for(let k=0;k<9;k++)await tick();
  assert.equal(pill.textContent,'Inaktuell');assert.equal(banner.textContent,'BTC 1h: Inaktuell data (65 s) · Demokontot: Handlar');
  assert.ok(!p.rt.urls.some(u=>u.searchParams.get('limit')==='1000'),'a slow read gets a minute');
  // Once the read has been open for more than a minute a fresh series reads the candles again.
  await tick();
  assert.ok(p.rt.urls.some(u=>u.searchParams.get('limit')==='1000'),'a fresh read');
  assert.equal(pill.textContent,'Live');assert.equal(banner.hidden,true);
  assert.match(p.q('[data-fc-pill]').getAttribute('title'),/^Live · uppdaterad \d+ s sedan$/);
  hang=false;await tick();assert.equal(pill.textContent,'Live');
});

test('the version select lists the newest versions, offers older ones on request and always keeps the compared one',async()=>{
  const time=after(1998),closed=await loaded({at:time,market:m}),c=closed.length-1,features=forecastFeatures(closed),store=createForecastStore(memoryBackend());
  // Six versions stored on earlier visits, 30 to 25 candles back.
  for(let k=30;k>=25;k--){const f=forecastAt(closed,c-k,{tf:'1h',features});await store.putForecast(forecastRecord('u1','BTC','1h',f,{createdAt:f.cutoff+HOUR+MIN,origin:'live',tfMs:HOUR}));}
  const p=page({time,store,runner:idle(),extra:{versions:3}});
  await p.view.show();
  // Opened: the newest version with closed outcomes, the one stored 25 candles back (the live one has none yet).
  const select=p.q('[data-fc-compare]'),ids=()=>select.options.map(o=>o.value),all=(await records(store)).forecasts,opened=all.at(-2).id;
  assert.equal(all.length,7,'no as-of backfill for a series that has versions');
  assert.deepEqual(ids(),[...all.slice(-3).reverse().map(r=>r.id),'older']);
  assert.equal(select.options.at(-1).textContent,'Visa äldre versioner (4 till)…');
  assert.match(p.q('[data-fc-forecast]').innerHTML,/<dt>Sparade versioner<\/dt><dd>7<\/dd>/);
  // Older ones on request; the comparison stays where it was.
  enter(select,'older');
  await until(()=>ids().length===7,'the older versions');
  assert.deepEqual(ids(),[...all.slice(-6).reverse().map(r=>r.id),'older']);assert.equal(select.value,opened);
  const chosen=all[1].id;enter(select,chosen);assert.equal(select.value,chosen);
  // Six candles later neither the opened nor the chosen version has dropped out of the select.
  for(let k=1;k<=6;k++){p.rt.at=after(1998+k);await p.view.refreshLive();}
  assert.ok(ids().includes(opened)&&ids().includes(chosen));assert.equal(select.value,chosen);
  assert.equal(ids().length,9,'the six newest, the two kept and the request for older ones');
  assert.match(p.q('[data-fc-forecast]').innerHTML,/<dt>Sparade versioner<\/dt><dd>13<\/dd>/);
  assert.ok(p.q('[data-fc-forecast]').textContent.includes('Jämförs meddata t.o.m. '+stamp(all[1].cutoffClose,p.rt.at)+' · skapad '+stamp(all[1].createdAt,p.rt.at)+' · live'));
});

test('a version is stamped with Bybit\'s clock, so it never reads as made before its data ended',async()=>{
  // This computer's clock runs 3 s behind Bybit's, well inside what the data status allows.
  const close=m.closeOf(1998),p=page({time:close-32*SEC,runner:idle(),runtime:{server:close-29*SEC}});
  await p.view.show();
  for(let k=0;k<8;k++){p.rt.at+=5*SEC;p.rt.server=p.rt.at+3*SEC;await p.view.refreshLive();}
  const newest=(await records(p.store)).forecasts.at(-1);
  assert.equal(newest.cutoffClose,close);
  assert.ok(newest.createdAt>=newest.cutoffClose,'created when its candle had closed');
  assert.equal(p.q('[data-fc-compare]').options[0].textContent,'data t.o.m. '+hhmm(close)+' · skapad '+hhmm(newest.createdAt)+' · senaste');
});

test('a signal the view stores is stamped with Bybit\'s clock, never before the close that confirmed it',async()=>{
  // This computer's clock runs 3 s behind Bybit's: Bybit closed the first long breakout's candle 2 s ago, while this clock
  // still says 1 s to go. The chart stores the signal (the runner here never does).
  const close=m.closeOf(L1.i),p=page({time:close-SEC,runner:idle(),runtime:{server:close+2*SEC}});
  await p.view.show();
  assert.equal(p.q('[data-fc-pill-text]').textContent,'Live');
  const [s]=(await records(p.store)).signals;
  assert.deepEqual([s.barTime,s.confirmedAt,s.origin],[L1.t,close,'live']);
  assert.ok(s.recordedAt>=s.confirmedAt,'recorded once its candle had closed');
  assert.equal(s.recordedAt,close+2*SEC,'by Bybit\'s clock');
});

test('stored records of the wrong shape are never inserted as markup and cannot break the view, even with valid hashes',async()=>{
  const backend=memoryBackend(),store=createForecastStore(backend),time=after(1998),closed=await loaded({at:time,market:m});
  const i=closed.findIndex(b=>b.t===m.signals[0].t),e=evaluateBar(closed,i,{tf:'1h'});
  // A genuine signal moved to the newest closed candle (no signal there) with markup in its side,
  // and a forecast whose creation time no date can hold.
  const signal=reseal(signalRecord('u1','BTC','1h',{...e,t:closed.at(-1).t},{recordedAt:time,origin:'live',tfMs:HOUR}),{side:'long"><img src=x onerror="alert(1)"><b class="x'});
  const forecast=reseal(forecastRecord('u1','BTC','1h',forecastAt(closed,closed.length-40,{tf:'1h'}),{createdAt:time-HOUR,origin:'live',tfMs:HOUR}),{createdAt:1e20});
  for(const r of [signal,forecast]){assert.ok(verifyRecord(r));assert.equal((await backend.add(r)).ok,true);}
  const p=page({time,store});
  await p.view.show();
  assert.equal(p.root.querySelector('img'),null);
  assert.match(p.q('.fc-integrity').textContent,/2 sparade poster har ett ogiltigt innehåll och visas inte\. Originalen lämnas orörda\./);
  assert.ok(!p.q('[data-fc-compare]').options.some(o=>o.value===forecast.id));
  assert.equal(p.q('[data-fc-signal] .fc-recent').querySelectorAll('li').length,5);
  assert.match(p.q('[data-fc-forecast]').textContent,/Senaste versionen · data t\.o\.m\. \d\d:\d\d · skapad \d\d:\d\d · live/);
  assert.equal(p.q('[data-fc-pill-text]').textContent,'Live');
});

test('walk-forward results are cached per kind of run, and only the two newest are kept',async()=>{
  const p=page({time:after(1998),settings:{symbols:['BTC'],tf:'1h'}});
  await p.view.show();await p.view.refreshLive();
  const run=kind=>p.q(`[data-fc-eval="${kind}"]`),head=()=>p.q('[data-fc-eval-result] .fc-eval-head')?.textContent??'';
  const go=async kind=>{p.rt.urls=[];click(run(kind));await until(()=>!busy(run('pair')),'the walk-forward');return p.rt.urls.length;};
  assert.ok(await go('pair')>0);assert.match(head(),/^BTC · 1h · uppmätt/);
  // A portfolio of the same single coin is a run of its own, with its own label.
  assert.ok(await go('portfolio')>0);assert.match(head(),/^Portfölj BTC · 1h · uppmätt/);
  assert.equal(await go('pair'),0);assert.match(head(),/^BTC · 1h · uppmätt/);
  // A third result pushes out the oldest kept one.
  enter(p.q('[data-fc-symbol]'),'ETH');
  await until(()=>p.q('[data-fc-pill-text]').textContent==='Live'&&run('pair').textContent==='Kör för ETH 1h','the ETH series');
  assert.ok(await go('pair')>0);
  assert.equal(await go('portfolio'),0,'still kept');
  enter(p.q('[data-fc-symbol]'),'BTC');
  await until(()=>p.q('[data-fc-pill-text]').textContent==='Live'&&run('pair').textContent==='Kör för BTC 1h','the BTC series');
  assert.ok(await go('pair')>0,'pushed out');
});

test('the stylesheet keeps the chart\'s keyboard focus visible and never cuts the brand title in the crypto top bar',()=>{
  const css=source('../forecast.css');
  // An inset shadow sits under the canvas pixels; an outline inside the clipping wrap stays visible.
  const ring=/#aiForecast \.fc-canvas-wrap canvas:focus-visible\{([^}]*)\}/.exec(css)?.[1]??'';
  assert.match(ring,/outline:2px solid var\(--fc-accent\)/);assert.match(ring,/outline-offset:-2px/);assert.doesNotMatch(ring,/box-shadow/);
  // From 681 px the brand may shrink; below 1280 px that would cut the title itself, so up to 1279 px the row wraps.
  const wrap=/@media \(min-width:(\d+)px\) and \(max-width:(\d+)px\)\{body\.krypto \.tb-row\{flex-wrap:wrap\}\}/.exec(css);
  assert.ok(wrap,'the wrap rule');assert.deepEqual([+wrap[1],+wrap[2]],[681,1279]);
  assert.match(css,/@media \(min-width:681px\)\{\s*body\.krypto \.tb-row \.brand\{flex:0 1 auto;min-width:0\}/);
});

test('keyboard focus stays on the control while pause, save, close and walk-forward run, clicks meanwhile are ignored, and the pause button never reads backwards',async()=>{
  const p=page({time:after(L1.i),settings:{symbols:['BTC'],leverage:10}}),doc=p.doc;
  await p.view.show();await p.view.refreshLive();
  const pause=p.q('[data-fc-pause]'),reset=p.q('[data-fc-reset]');
  assert.equal(pause.getAttribute('aria-pressed'),null);
  pause.focus();click(pause);
  // Busy but focusable: marked aria-disabled instead of disabled, so focus never drops to the page.
  assert.equal(doc.activeElement,pause,'the busy button keeps focus');
  assert.deepEqual([pause.disabled,pause.getAttribute('aria-disabled'),reset.disabled,reset.getAttribute('aria-disabled')],[false,'true',false,'true']);
  // Clicks on them while the pause runs do nothing: no second toggle, no reset question.
  click(pause);click(reset);
  await until(()=>account(p).settings.paused&&!busy(pause),'the pause');
  await turns();
  assert.equal(account(p).settings.paused,true,'paused once');assert.deepEqual(p.asked,[]);
  assert.equal(doc.activeElement,pause);assert.equal(reset.getAttribute('aria-disabled'),null);
  // The label says what the button does now; no pressed state reads the opposite.
  assert.deepEqual([pause.textContent,pause.getAttribute('aria-pressed')],['▶ Återuppta nya affärer',null]);
  // Enter in a settings field submits the form; that field keeps focus, read-only, and the rest of the form is locked.
  const field=p.q('[name="maxOpen"]'),save=p.q('[data-fc-save]');field.focus();enter(field,'2');fire(p.q('[data-fc-settings]'),'submit');
  assert.equal(doc.activeElement,field);
  assert.deepEqual([field.disabled,field.getAttribute('aria-disabled'),field.readOnly,save.disabled],[false,'true',true,true]);
  await until(()=>/^Sparat/.test(p.q('[data-fc-settings-msg]').textContent)&&!busy(field),'the save');
  assert.equal(doc.activeElement,field);assert.deepEqual([field.readOnly,save.disabled],[false,false]);
  assert.equal(account(p).settings.maxOpen,2);
  // Closing keeps focus on the position's button; once the position is gone, focus moves to the card's heading.
  const close=p.q('[data-fc-close]');close.focus();click(close);
  const closing=p.q('[data-fc-close]');
  assert.equal(doc.activeElement,closing);assert.deepEqual([closing.textContent,closing.getAttribute('aria-disabled')],['Stänger…','true']);
  await until(()=>/^Stängde/.test(p.q('[data-fc-account-msg]').textContent),'the close');await turn();
  assert.equal(doc.activeElement,p.q('#fcAccountTitle'));
  const run=p.q('[data-fc-eval="pair"]');run.focus();click(run);
  assert.equal(doc.activeElement,run);assert.equal(run.getAttribute('aria-disabled'),'true');
  await until(()=>!busy(run),'the walk-forward');
  assert.equal(doc.activeElement,run);
});

test('unreliable data for one coin stays visible while another problem leads the status line',async()=>{
  const p=page({time:after(L1.i)}),box=p.doc.createElement('section');
  await p.view.show();await p.view.refreshLive();p.view.renderSummary(box);
  // BTC's protection check fails, and so do SOL's hourly candles at the next close.
  p.rt.fail=u=>u.pathname.endsWith('/mark-price-kline')&&u.searchParams.get('symbol')==='BTCUSDT'||
    u.pathname.endsWith('/kline')&&u.searchParams.get('symbol')==='SOLUSDT'&&u.searchParams.get('interval')==='60'?'Proxy nere':null;
  p.rt.at=after(L1.i+1,10*SEC);
  for(let k=0;k<4;k++){await p.view.refreshLive();p.rt.at+=5*SEC;}
  assert.match(p.q('[data-fc-account] .fc-status').textContent,/^Väntar på skyddskontroll för BTC/);
  for(const text of [p.q('[data-fc-account]').textContent,box.textContent])assert.match(text,/Data opålitlig för SOL: Data saknas — Proxy nere/);
});

test('browser errors reach the view and the runner\'s texts in Swedish',async()=>{
  // When every proxy fails, the page's grab passes fetch's own TypeError on.
  let down=false;
  const p=page({time:after(L1.i),settings:{symbols:['BTC'],leverage:10},wrap:g=>(url,o)=>down?Promise.reject(new TypeError('Failed to fetch')):g(url,o)});
  await p.view.show();await p.view.refreshLive();
  down=true;
  click(p.q('[data-fc-eval="pair"]'));
  await until(()=>!busy(p.q('[data-fc-eval="pair"]')),'the walk-forward');
  assert.equal(p.q('[data-fc-eval-result]').textContent,'BTC · 1h: Bybit kunde inte nås via proxyn');
  click(p.q('[data-fc-close]'));
  await until(()=>/^Kunde inte stänga/.test(p.q('[data-fc-account-msg]').textContent),'the failed close');
  assert.equal(p.q('[data-fc-account-msg]').textContent,'Kunde inte stänga BTC: Bybit kunde inte nås via proxyn');
  assert.doesNotMatch(p.root.textContent,/Failed to fetch/);
});

test('with site data blocked the view says records last only for this visit, and the runner says why in Swedish',async()=>{
  const keys=['localStorage','indexedDB'],saved=keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);
  const denied=()=>{throw new DOMException("Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",'SecurityError');};
  for(const k of keys)Object.defineProperty(globalThis,k,{configurable:true,get:denied});
  try{
    const p=page({time:after(1998),store:null});
    await p.view.show();
    // The archive itself says where it keeps the records, and why.
    await until(()=>p.q('[data-fc-archive]'),'the archive note');
    const note=p.q('[data-fc-archive]');
    assert.deepEqual([note.getAttribute('data-fc-archive'),note.textContent],['memory','Webbläsarens lagring är blockerad, så signaler och prognoser sparas bara under det här besöket.']);
    assert.ok(note.classList.contains('fc-warn'));assert.equal(note.closest('[data-fc-forecast]'),p.q('[data-fc-forecast]'));
    // The account itself lives in that storage too.
    const runner=createForecastRunner({grab:fakeBybit({at:after(1998),urls:[],market:m}),getUser:()=>'u1',isActive:()=>true,locks:tabLocks(),
      store:createForecastStore(memoryBackend()),now:()=>after(1998)});
    await runner.tick();
    assert.deepEqual([runner.status().state,runner.status().text],['error','Webbläsarens lagring är blockerad — AI Forecast-kontot kan inte sparas']);
  }finally{for(const [k,d] of saved)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}
});

test('the walk-forward progress is shown, but only its start and end are announced',async()=>{
  const p=page({time:after(1998),defer:()=>new Promise(r=>setImmediate(r))});
  await p.view.show();
  const progress=p.q('[data-fc-eval-progress]'),announce=p.q('[data-fc-eval-announce]'),said=[],seen=new Set();
  assert.equal(progress.getAttribute('aria-live'),null);assert.equal(progress.getAttribute('role'),null);
  assert.deepEqual([announce.getAttribute('role'),announce.getAttribute('aria-live')],['status','polite']);
  const text=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(announce),'textContent');
  Object.defineProperty(announce,'textContent',{get(){return text.get.call(this);},set(v){said.push(v);text.set.call(this,v);}});
  click(p.q('[data-fc-eval="pair"]'));
  await until(()=>{seen.add(progress.textContent);return !busy(p.q('[data-fc-eval="pair"]'));},'the walk-forward');
  assert.ok(seen.size>5,'the visible progress follows the steps');
  assert.deepEqual(said,['Walk-forward startad: BTC · 1h','Walk-forward klar: BTC · 1h']);
});

test('an archive that never answers stalls neither the runner that shares it nor the chart',async()=>{
  const never=()=>new Promise(()=>{}),store={putForecast:never,putSignal:never,listForecasts:never,listSignals:never,get:never};
  const p=page({time:after(L1.i),store,settings:{symbols:['BTC'],leverage:10},extra:{archiveTimeout:20}}),box=p.doc.createElement('section');
  p.who.visible=false;p.view.renderSummary(box);
  // The runner meets a fresh signal it cannot store: its tick ends and says why.
  await within(p.view.refreshLive(),3000,'the runner\'s tick');
  assert.match(box.querySelector('.fc-sum-state').textContent,/^Väntar på ny affär i BTC: Signalen för BTC kunde inte sparas/);
  // Shown, the chart loads, reports the archive and keeps reading new candles.
  p.who.visible=true;
  await within(p.view.show(),3000,'show()');
  assert.equal(p.q('[data-fc-pill-text]').textContent,'Live');
  assert.match(p.q('.fc-integrity').textContent,/Prognosarkivet svarar inte/);
  p.rt.urls=[];p.rt.at+=5*SEC;
  await within(p.view.refreshLive(),3000,'refreshLive');
  assert.ok(p.rt.urls.some(u=>u.searchParams.get('limit')==='3'),'the chart read the newest candles');
});

test('failed archive writes add one counted line, not one per candle',async()=>{
  const inner=createForecastStore(memoryBackend());let full=false;
  const store={...inner,putForecast:async r=>{if(full)throw Error('Prognosarkivet är fullt');return inner.putForecast(r);}};
  const p=page({time:after(1998),store,runner:idle()});
  await p.view.show();full=true;
  for(let k=1;k<=5;k++){p.rt.at=after(1998+k);await p.view.refreshLive();}
  const lines=p.root.querySelectorAll('.fc-integrity li').map(li=>li.textContent);
  assert.equal(lines.length,1);
  assert.equal(lines[0],'5 prognoser kunde inte sparas sedan '+hhmm(after(1999))+' (senast data t.o.m. '+stamp(m.closeOf(2003),0)+'): Prognosarkivet är fullt');
});

test('a coin choice that is replaced at once never reads its whole history',async()=>{
  const p=page({time:after(1998),runner:idle()});
  await p.view.show();
  p.rt.urls=[];
  for(const s of ['ETH','SOL','XRP'])enter(p.q('[data-fc-symbol]'),s);
  await until(()=>p.q('[data-fc-pair]').textContent==='XRP · USDT-perp · 1h'&&p.q('[data-fc-pill-text]').textContent==='Live','the XRP series');
  const pages=s=>p.rt.urls.filter(u=>u.pathname.endsWith('/kline')&&u.searchParams.get('symbol')===s&&u.searchParams.get('limit')==='1000').length;
  assert.deepEqual([pages('ETHUSDT'),pages('SOLUSDT'),pages('XRPUSDT')],[0,0,2]);
});

// ---- Research verdicts, evaluation dates, account events, bounded archive reads ----------------
const NO_CONFIDENCE=['konfidens','confidence','sannolikhet','probabilit','träffsäkerhet','säkerhetsgrad','chans att','certainty','garanti'];
const dateOf=t=>{const d=dayOf(t);return d.day+' '+MONTHS[d.month-1]+' '+d.year;};
// The page binds a number to its unit with a no-break space; the report uses plain spaces.
const plain=s=>s.replace(/\xa0/g,' ');

test('the research verdicts sit beside the signal, the forecast, the account and the evaluation as measured history, in the report\'s own numbers',async()=>{
  const p=page({time:after(1998),settings:{}});
  await p.view.show();
  const report=source('../research/ai-forecast-results.md');
  const note=kind=>p.q(`[data-fc-research="${kind}"]`),section=x=>x.closest('section');
  // Signal card: the rules are not validated.
  assert.equal(section(note('signal')),section(p.q('[data-fc-signal]')));
  assert.equal(plain(note('signal').textContent),'Uppmätt historik: reglerna af-signal-v1 är ej validerade. I forskningen förlorade de både på utvecklingsdatan 2022–2025 '+
    'och på valideringsåret 2025–2026, där de gav −35,2 % med 1 % risk och 10×.');
  // Prognos card: right after the fixed scenario text.
  const paras=p.q('[data-fc-forecast]').children,at=paras.findIndex(x=>x.classList.contains('fc-fixed'));
  assert.ok(at>=0);assert.equal(paras[at+1],note('forecast'));
  assert.equal(plain(note('forecast').textContent),'Uppmätt historik: i forskningens test utanför träningsdatan, okt 2025–sep 2026 på timcandles, var modellen inte bättre än ett '+
    'oförändrat pris (skill −3,3 %, −4,0 % och −6,4 % på 5, 10 och 20 candles), och riktningen stämde på slumpens nivå. De grå candlerna visar därför ett '+
    'möjligt förlopp och bandet den vanliga spridningen, inte en förutsägelse. 80 %-bandet rymde 75–78 % av stängningarna.');
  // Account card: right after the max-leverage note, as history; the defaults are what they were.
  const card=section(p.q('[data-fc-account]')).children,max=card.findIndex(x=>x.classList.contains('fc-note'));
  assert.ok(max>=0);assert.equal(card[max+1],note('account'));
  assert.equal(plain(note('account').textContent),'Uppmätt historik: på forskningens valideringsår, okt 2025–sep 2026, förlorade standardinställningarna (Bybits maxhävstång, '+
    '25 % marginal och 10 % risk) 99,91 % av 100 $. 83 av 95 affärer likviderades, och kapitalet var under 1 $ efter 22 dagar.');
  assert.deepEqual(['positionPct','riskPct','maxOpen','leverage','tf'].map(k=>p.q(`[name="${k}"]`).value),['25','10','3','max','1h']);
  // Utvärdering: the frozen protocol's headline numbers and the whole report, in a new tab.
  const summary=note('summary');
  assert.equal(section(summary),section(p.q('[data-fc-eval-result]')));
  assert.equal(summary.querySelector('h3').textContent,'Forskning (fryst protokoll)');
  assert.equal(plain(summary.querySelector('p').textContent),'Ingen av de åtta regelvarianterna blev behörig: alla förlorade på utvecklingsdatan 2022–2025 (−96,6 % till −43,3 %). '+
    'Standardreglerna gav −35,2 % på valideringsåret okt 2025–sep 2026 med 1 % risk och 10×, och −99,91 % med kontots standard och Bybits maxhävstång. '+
    'Prognosen slog inte ett oförändrat pris (skill −3,3 %, −4,0 % och −6,4 % på 5, 10 och 20 candles), och 80 %-bandet rymde 75–78 % av stängningarna. '+
    'Allt är uppmätt i efterhand på timcandles.');
  const link=summary.querySelector('a');
  assert.deepEqual([link.getAttribute('href'),link.getAttribute('target'),link.getAttribute('rel')],
    ['https://github.com/Odmarken/Investing-tool/blob/main/research/ai-forecast-results.md','_blank','noopener']);
  // Every figure shown is the report's own, in its own form; none of the verdicts is styled as a warning.
  const shown=plain(['signal','forecast','account','summary'].map(k=>note(k).textContent).join(' '));
  const figures=shown.match(/[−+]?\d+(?:,\d+)?(?:–\d+)? %|\d+ av \d+|\d+×|under 1 \$|\d+ dagar/g);
  assert.ok(figures.length>=20);
  for(const x of figures)assert.ok(report.includes(x),'not in the report: '+x);
  assert.ok(report.includes('−96,6 % till −43,3 %')&&report.includes('75–78 %')&&report.includes('99,91 %'));
  // A number never ends a line apart from its unit.
  const raw=['signal','forecast','account','summary'].map(k=>note(k).textContent).join(' ');
  assert.doesNotMatch(raw,/\d [%$]/);assert.ok(raw.includes('25\xa0% marginal')&&raw.includes('100\xa0$'));
  assert.equal(p.root.querySelectorAll('[data-fc-research]').filter(x=>x.classList.contains('fc-warn')).length,0);
  for(const word of NO_CONFIDENCE)assert.doesNotMatch(p.root.innerHTML,new RegExp(word,'i'),word);
});

test('the evaluation never promises windows from 1 okt 2025 on every timeframe, and a run shows its own first and last test dates and the backtest\'s notes',async()=>{
  const p=page({time:after(1998)});
  await p.view.show();
  const result=p.q('[data-fc-eval-result]'),run=p.q('[data-fc-eval="pair"]');
  // Before a run: the earliest start, the cap on candles and what that leaves on 5m and 15m once the first window's
  // forecast library has its 1 500 candles and the 155 candles of feature windows before them: 10 344 candles.
  const lead=FORECAST_PARAMS.train+155,days=ms=>Math.floor((12000-1-lead)*ms/DAY);
  assert.deepEqual([days(TF['5m'].ms),days(TF['15m'].ms)],[35,107]);
  assert.equal(result.textContent,'Testar signalreglerna och prognosen i efterhand på Bybits historik, i fyra testfönster utanför träningsdatan och med kontots '+
    'storlek, hävstång och kostnader. Fönstren börjar tidigast 1 okt 2025, men högst '+fixed(12000,0)+' candles hämtas per par, så på 5m och 15m täcker de bara '+
    'de senaste cirka 35 respektive 107 dagarna. Resultatet visar testets första och sista datum. Historiken hämtas via proxy och det tar en stund.');
  assert.doesNotMatch(result.textContent,/historik efter 1 okt 2025/);
  click(run);
  await until(()=>!busy(run),'the walk-forward');
  // The run's own windows: they start once the history holds the first window's whole library, 1 500 candles that all
  // have their features (the first 155 candles of any history have none), and end at the last closed candle.
  const closed=await loaded(p.rt),first=closed[lead].t,last=closed.at(-1).t,features=forecastFeatures(closed);
  assert.ok(closed[0].t>Date.UTC(2025,9,1),'this history starts long after 1 okt 2025, as the 12 000-candle cap makes it on 5m');
  assert.ok(features.slice(lead-FORECAST_PARAMS.train,lead).every(x=>x!==null),'a full library');assert.equal(features[lead-FORECAST_PARAMS.train-1],null);
  assert.match(result.querySelector('.fc-eval-head').textContent,new RegExp('^BTC · 1h · uppmätt i efterhand '+dateOf(first)+' – '+dateOf(last)+', utanför träningsfönstren'));
  const windows=result.querySelectorAll('table')[0].querySelectorAll('tbody th small');
  assert.equal(windows[0].querySelector('span').textContent,dateOf(first)+' –');assert.equal(windows.at(-1).querySelectorAll('span')[1].textContent,dateOf(last));
  // The notes as the backtest words them, in its order.
  const notes=result.querySelectorAll('.fc-notes li').map(li=>li.textContent);
  assert.deepEqual(notes.slice(0,2),['Reglerna och parametrarna bestämdes i förväg; inget valdes på testfönstren efter 1 okt 2025.',
    'Alla mått är uppmätta i efterhand på historik utanför träningsfönstren, inte löften om framtiden.']);
  assert.ok(notes.at(-1).startsWith('Prognosens analoger hämtas bara från de '+fixed(FORECAST_PARAMS.train,0)+' candles som slutar före varje testfönster'));
});

test('a walk-forward on a history shorter than the first window\'s library says it is too short, never that a later date has no data',async()=>{
  // 2 000 hourly candles of the scripted market make about 500 four-hour candles: fewer than 1 500 + 155.
  const prefs=memoryStorage();prefs.setItem('riptide.forecast.ui.v1',JSON.stringify({symbol:'BTC',tf:'4h',horizon:10,band:true,signals:true,levels:true}));
  const p=page({time:after(1998),prefs,runner:idle()});
  await p.view.show();
  const run=p.q('[data-fc-eval="pair"]');assert.equal(run.textContent,'Kör för BTC 4h');
  click(run);await until(()=>!busy(run),'the walk-forward');
  assert.equal(p.q('[data-fc-eval-result]').textContent,'BTC · 4h: För kort historik för walk-forward: 0 candles efter träningsfönstret');
});

test('the account card lists the newest account events, so a refusal and its reason are visible',async()=>{
  const p=page({time:after(L1.i)});
  await p.view.show();await p.view.refreshLive();
  // Default settings: three coins open on the shared breakout and the other four are refused for want of a slot.
  const a=account(p),items=p.q('[data-fc-account]').querySelectorAll('.fc-events li'),text=li=>li.querySelector('span').textContent;
  assert.deepEqual(a.log.map(e=>[e.kind,e.symbol]),[...['BTC','ETH','SOL'].map(s=>['öppnad',s]),...['XRP','DOGE','SHIB','PEPE'].map(s=>['avvisad',s])]);
  assert.equal(items.length,5,'the five newest');
  assert.deepEqual(items.slice(0,4).map(text),['PEPE','SHIB','DOGE','XRP'].map(s=>'Avvisad '+s+': Max antal öppna positioner är nått (3)'));
  // The log's own text, with its amounts bound to their units as everywhere in the view.
  assert.equal(text(items[4]),a.log[2].text.replace(/(\d) ([%$])/g,'$1\xa0$2'));assert.match(text(items[4]),/^Öppnade lång SOL till .*\d\xa0\$$/);
  assert.deepEqual(items.map(li=>li.classList.contains('no')),[true,true,true,true,false]);
  assert.equal(items[0].querySelector('time').textContent,hhmm(a.log.at(-1).t));
  assert.ok(p.q('[data-fc-account]').querySelectorAll('h3').some(h=>h.textContent==='Senaste händelser'));
  // A fresh account has none yet.
  const q=page({time:after(L1.i-1)});
  await q.view.show();await q.view.refreshLive();
  assert.match(q.q('[data-fc-account]').textContent,/Senaste händelserInga händelser ännu\./);
});

test('a show or a switch reads only the newest versions and signals from the archive, and older versions come one page at a time',async()=>{
  const time=after(1998),closed=await loaded({at:time,market:m}),c=closed.length-1,features=forecastFeatures(closed);
  // A backend that counts whole-series reads and the records read by id.
  const inner=memoryBackend(),reads={series:0,ids:[]};
  const backend={...inner,series:(...a)=>{reads.series++;return inner.series(...a);},getMany:ids=>{reads.ids.push(...ids);return inner.getMany(ids);}};
  const base=createForecastStore(backend),asked=[];
  // Eight versions stored on earlier visits, 30 to 23 candles back.
  for(let k=30;k>=23;k--){const f=forecastAt(closed,c-k,{tf:'1h',features});await base.putForecast(forecastRecord('u1','BTC','1h',f,{createdAt:f.cutoff+HOUR+MIN,origin:'live',tfMs:HOUR}));}
  const store={...base,listForecasts:(...a)=>{asked.push(['f',a[2],a[3]]);return base.listForecasts(...a);},listSignals:(...a)=>{asked.push(['s',a[2],a[3]]);return base.listSignals(...a);}};
  const p=page({time,store,runner:idle(),extra:{versions:3}});
  await p.view.show();
  const versionsRead=()=>reads.ids.filter(id=>id.startsWith('f|')).length,select=p.q('[data-fc-compare]');
  assert.equal(reads.series,0,'no whole-series read');
  assert.deepEqual(asked,[['s','1h',{limit:2000}],['f','1h',{limit:3}]]);
  assert.equal(versionsRead(),3,'only the page of the three newest');
  // The live version joined the three listed; the oldest of them left memory and counts among the older ones.
  const all=(await records(createForecastStore(inner))).forecasts;
  assert.equal(all.length,9);
  assert.deepEqual(select.options.map(o=>o.value),[...all.slice(-3).reverse().map(r=>r.id),'older']);
  assert.equal(select.options.at(-1).textContent,'Visa äldre versioner (6 till)…');
  assert.match(p.q('[data-fc-forecast]').innerHTML,/<dt>Sparade versioner<\/dt><dd>9<\/dd>/);
  // A switch away and back lists one page each time.
  click(p.q('[data-fc-tf="4h"]'));
  await until(()=>p.q('[data-fc-pair]').textContent==='BTC · USDT-perp · 4h'&&p.q('[data-fc-pill-text]').textContent==='Live'&&asked.length===4,'the 4h series');
  click(p.q('[data-fc-tf="1h"]'));
  await until(()=>p.q('[data-fc-pair]').textContent==='BTC · USDT-perp · 1h'&&p.q('[data-fc-pill-text]').textContent==='Live'&&asked.length===6,'the 1h series');
  assert.deepEqual(asked.slice(2),[['s','4h',{limit:2000}],['f','4h',{limit:3}],['s','1h',{limit:2000}],['f','1h',{limit:3}]]);
  assert.equal(reads.series,0);assert.equal(versionsRead(),6);
  // Older versions on request: one page of the newest six, read without the signals again.
  reads.ids=[];enter(select,'older');
  await until(()=>select.options.length===7,'the older versions');
  assert.deepEqual(asked.slice(6),[['f','1h',{limit:6}]]);
  assert.equal(versionsRead(),6);assert.equal(reads.series,0);
  assert.deepEqual(select.options.map(o=>o.value),[...all.slice(-6).reverse().map(r=>r.id),'older']);
  assert.equal(select.options.at(-1).textContent,'Visa äldre versioner (3 till)…');
  assert.match(p.q('[data-fc-forecast]').innerHTML,/<dt>Sparade versioner<\/dt><dd>9<\/dd>/);
});

test('the forecast card says where records are kept when IndexedDB cannot be used, and an archive that has not said yet is asked again',async()=>{
  // IndexedDB that refuses to open and a working localStorage: the records go to localStorage, which has a limit.
  const keys=['localStorage','indexedDB'],saved=keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]),local=memoryStorage();
  const refusing={open(){const req={};setImmediate(()=>{req.error=new DOMException('The operation failed','UnknownError');req.onerror?.();});return req;}};
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:refusing});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:local});
  try{
    const p=page({time:after(1998),store:null,runner:idle()});
    await p.view.show();
    await until(()=>p.q('[data-fc-archive]'),'the archive note');
    const note=p.q('[data-fc-archive]');
    assert.deepEqual([note.getAttribute('data-fc-archive'),note.textContent],
      ['localStorage','IndexedDB kunde inte öppnas, så signaler och prognoser sparas i webbläsarens lokala lagring, som rymmer högst 1,5 miljoner tecken.']);
    assert.ok(note.classList.contains('fc-muted'));assert.equal(p.q('.fc-integrity'),null,'not an integrity problem');
    await until(()=>local.keys().some(k=>k.startsWith('riptide.forecast.records.v1:record:f|u1|BTC|1h|')),'the versions in localStorage');
  }finally{for(const [k,d] of saved)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}
  // IndexedDB keeps the records: nothing to say.
  const quiet=page({time:after(1998),runner:idle(),store:{...createForecastStore(memoryBackend()),info:async()=>({kind:'indexedDB',note:''})}});
  await quiet.view.show();await turns();
  assert.equal(quiet.q('[data-fc-archive]'),null);
  // An archive whose answer never comes is given up on after archiveTimeout and asked again on the next show.
  let answer=null;
  const store={...createForecastStore(memoryBackend()),info:()=>answer??new Promise(()=>{})};
  const q=page({time:after(1998),store,runner:idle(),extra:{archiveTimeout:20}});
  await q.view.show();
  await new Promise(r=>setTimeout(r,60));
  assert.equal(q.q('[data-fc-archive]'),null);
  answer=Promise.resolve({kind:'memory',note:'Signaler och prognoser sparas bara under det här besöket.'});
  q.view.hide();await q.view.show();
  await until(()=>q.q('[data-fc-archive]'),'the archive note');
  assert.equal(q.q('[data-fc-archive]').textContent,'Signaler och prognoser sparas bara under det här besöket.');
});

test('a full archive shows the runner\'s own words in the account card and the summary, and the view reports its own failed save',async()=>{
  const full=()=>Promise.reject(Object.assign(Error('Prognosarkivet är fullt'),{code:ARCHIVE_FULL}));
  const store={...createForecastStore(memoryBackend()),putSignal:full,putForecast:full};
  const p=page({time:after(L1.i),store,settings:{symbols:['BTC'],leverage:10}}),box=p.doc.createElement('section');
  p.view.renderSummary(box);
  await p.view.show();await p.view.refreshLive();
  const text='Prognosarkivet är fullt: nya signaler kan inte sparas och nya affärer är pausade',status=p.q('[data-fc-account] .fc-status');
  assert.deepEqual([status.getAttribute('data-state'),status.textContent],['waiting',text]);
  assert.equal(box.querySelector('.fc-sum-state').textContent,text);
  assert.deepEqual(account(p).positions,[],'nothing traded without its stored signal');
  const lines=p.root.querySelectorAll('.fc-integrity li').map(li=>li.textContent);
  assert.ok(lines.some(x=>/^Signalen för BTC .* kunde inte sparas: Prognosarkivet är fullt$/.test(x)),'the view\'s own signal');
});

test('the module header says what the view and the runner share: id, content and contentHash, not every byte',()=>{
  const head=source('../forecast-ui.js').split('\nimport')[0];
  assert.doesNotMatch(head,/byte-identical/);
  assert.match(head,/the same id, content and contentHash\. Only recordedAt and\n\/\/ origin can differ/);
});

test('a value never splits from its unit: cards, legend, runner texts and the Kryptokonton summary bind it with a no-break space',async()=>{
  const split=/\d [%$]/;
  // An earlier version with outcomes: the comparison line has its error and its band hits.
  const p=page({time:after(1998)});
  await p.view.show();await p.view.refreshLive();
  click(p.q('[data-fc-chip]'));
  assert.match(p.q('.fc-stats').textContent,/medelfel \d+,\d\d\xa0% · .* inom 80\xa0%-bandet$/);
  for(const [what,el] of [['Prognos',p.q('[data-fc-forecast]')],['Demokonto',p.q('[data-fc-account]')],['Teckenförklaring',p.q('.fc-legend')]])
    assert.doesNotMatch(el.textContent,split,what);
  // Open positions, the account log's own texts and the compact summary in the Kryptokonton tab.
  const q=page({time:after(L1.i)}),box=q.doc.createElement('section');
  q.view.renderSummary(box);await q.view.show();await q.view.refreshLive();
  assert.ok(q.q('[data-fc-account]').querySelectorAll('.fc-pos').length>0,'positions are shown');
  assert.match(q.q('[data-fc-account] .fc-events').textContent,/marginal \d+,\d\d\xa0\$/);
  for(const [what,el] of [['Demokonto',q.q('[data-fc-account]')],['Kryptokonton',box]])assert.doesNotMatch(el.textContent,split,what);
});

test('on a phone the header is one row and the toolbar two: the pair select names only the coin, the back link keeps its words for screen readers',async()=>{
  const p=page({time:after(1998)});
  await p.view.show();
  // The coin alone fits beside the timeframes and forecast lengths; the header keeps the full instrument.
  assert.deepEqual(p.q('[data-fc-symbol]').options.map(o=>[o.value,o.textContent]),SYMBOLS.map(s=>[s,s]));
  assert.equal(p.q('[data-fc-pair]').textContent,'BTC · USDT-perp · 1h');
  const back=p.q('.fc-back');
  assert.equal(back.getAttribute('href'),'#');assert.equal(back.textContent,'←Tillbaka till signaler');
  assert.equal(back.querySelector('[aria-hidden="true"]').textContent,'←');assert.equal(back.querySelector('.fc-back-text').textContent,'Tillbaka till signaler');
  const css=source('../forecast.css'),phone=/@media \(max-width:560px\)\{([\s\S]*?)\n\}/.exec(css)?.[1]??'';
  assert.match(phone,/\.fc-head\{flex-wrap:nowrap;/);
  // Read but not shown: the pair line (the select and the timeframes show it) and the back link's words.
  assert.match(phone,/\.fc-pair,\.fc-back-text\{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect\(0 0 0 0\);clip-path:inset\(50%\)/);
  // Pair, timeframe and forecast length on one row; the toggles under the first two and zoom under the lengths.
  assert.match(phone,/\.fc-toolbar\{display:grid;grid-template-columns:minmax\(0,1fr\) auto auto;/);
  for(const [cls,col] of [['symbol','1'],['tf','2'],['horizon','3'],['toggles','1\/3;margin-left:0'],['zoom','3']])
    assert.match(phone,new RegExp('\.fc-'+cls+'\{grid-column:'+col+'\}?'),cls);
  // The version select and its quick picks scroll sideways in one row under the chart.
  assert.match(phone,/\.fc-comparebar\{order:2;flex-wrap:nowrap;overflow-x:auto;/);assert.match(phone,/\.fc-chips\{flex-wrap:nowrap\}/);
  assert.match(phone,/\.fc-canvas-wrap\{order:1;/);
});

test('the legend swatch of the forecast candles is the chart\'s own solid translucent gray, with no edge of its own',async()=>{
  const p=page({time:after(1998)});
  const item=p.root.querySelectorAll('.fc-legend li').find(li=>li.textContent==='Prognos (scenario)'),sw=item.querySelector('.fc-sw');
  assert.ok(sw.classList.contains('body'));assert.equal(sw.getAttribute('style'),'--c:'+CHART_COLORS.fcFill);
  const css=source('../forecast.css');
  assert.match(css,/\.fc-sw\.body\{background:var\(--c\)\}/);assert.doesNotMatch(css,/\.fc-sw\.ghost/);
});

test('switching coin or timeframe is a normal load: the chart shows no warning badge, only that candles are on their way',async()=>{
  const p=page({time:after(1998)});
  await p.view.show();p.draw();
  click(p.q('[data-fc-tf="4h"]'));
  p.ctx.calls.length=0;assert.ok(p.draw()>0);
  const texts=drawn(p.ctx);
  assert.ok(texts.includes('Hämtar candles…'));assert.ok(!texts.includes('Ingen kursdata ännu'));
  assert.ok(!texts.includes('Hämtar data…')&&!p.ctx.calls.some(k=>k[0]==='fill'&&k[1]==='rgba(240,160,32,0.92)'),'no amber badge');
  assert.equal(p.q('[data-fc-pill-text]').textContent,'Hämtar…');assert.equal(p.q('[data-fc-banner]').hidden,true);
  await until(()=>p.q('[data-fc-pill-text]').textContent==='Live','the 4h series');
});

test('a coin or timeframe switch ends the header price\'s flash at once, so the empty price of the new series never blinks',async()=>{
  const p=page({time:after(1998),extra:{reducedMotion:()=>false}});
  await p.view.show();
  const last=p.q('[data-fc-last]'),flashing=()=>last.classList.contains('up')||last.classList.contains('down');
  const shown=Number(last.textContent.replace(/[\s ]/g,'').replace(',','.'));
  p.rt.price={BTC:shown*1.002};p.rt.at+=5*SEC;await p.view.refreshLive();
  assert.ok(flashing(),'a new price flashes');
  click(p.q('[data-fc-tf="4h"]'));
  assert.equal(last.textContent,'–');assert.ok(!flashing(),'no flash on the price that is not there yet');
  await until(()=>p.q('[data-fc-pill-text]').textContent==='Live','the 4h series');
  assert.ok(!flashing(),'nor when the first 4h price arrives');
});

test('the version kept from when the chart opened is drawn only where its outcome is known; a version the user picks also ahead',async()=>{
  const p=page({time:after(1998)});
  await p.view.show();
  // Opened with the newest version that had outcomes: the backfill with data up to 5 candles back.
  const opened=(await records(p.store)).forecasts.at(-2);
  p.rt.at=after(1999);await p.view.refreshLive();
  const outlines=()=>{p.ctx.calls.length=0;p.draw();return p.ctx.calls.filter(k=>k[0]==='strokeRect'&&k[1]===CHART_COLORS.fcOutline).length;};
  // Its seven slots with an outcome (six closed, one forming); nothing over the newest version's gray candles, which
  // are all ten of the chosen length, the first behind the forming candle.
  assert.equal(p.q('[data-fc-compare]').value,opened.id);assert.equal(outlines(),7);
  assert.equal(p.ctx.calls.filter(k=>k[0]==='fillRect'&&k[1]===CHART_COLORS.fcFill).length,10);
  // Picked by the user, its three slots ahead are drawn as dotted outlines too.
  click(p.root.querySelectorAll('[data-fc-chip]').find(b=>b.getAttribute('data-fc-chip')===opened.id));
  assert.equal(p.q('[data-fc-compare]').value,opened.id);assert.equal(outlines(),7+3);
});

test('the forecast card says how many of the model\'s 20 candles the chart shows, as the toolbar\'s length does, and that the first lies behind the forming candle',async()=>{
  const inner=createForecastStore(memoryBackend());let full=false;
  const store={...inner,putForecast:async r=>{if(full)throw Error('Prognosarkivet är fullt');return inner.putForecast(r);}};
  const p=page({time:after(1998),store,runner:idle()});
  await p.view.show();
  const model=()=>p.q('[data-fc-forecast] .fc-meta').querySelectorAll('div').find(x=>x.querySelector('dt').textContent==='Modell').querySelector('dd').textContent;
  // Data up to the newest closed candle: the first forecast candle is the forming candle's period, drawn behind it.
  const behind=', den första bakom candlen som pågår';
  assert.equal(model(),'af-forecast-v1 · '+FORECAST_PARAMS.k+' analoger · visar 10 av 20 candles framåt'+behind);
  click(p.q('[data-fc-horizon="5"]'));assert.equal(model(),'af-forecast-v1 · '+FORECAST_PARAMS.k+' analoger · visar 5 av 20 candles framåt'+behind);
  click(p.q('[data-fc-horizon="20"]'));assert.equal(model(),'af-forecast-v1 · '+FORECAST_PARAMS.k+' analoger · 20 candles framåt'+behind);
  // No version for the next candle (the archive is full): the newest version's first candle has closed, so none lies behind the forming one.
  full=true;p.rt.at=after(1999);await p.view.refreshLive();
  assert.equal((await records(inner)).forecasts.at(-1).cutoff,m.bar(1998).t);
  assert.equal(model(),'af-forecast-v1 · '+FORECAST_PARAMS.k+' analoger · 20 candles framåt');
});

test('the stored signal list says its times are the candle closes, and its prices line up on the decimal comma',async()=>{
  const p=page({time:after(1998)});
  await p.view.show();
  const card=p.q('[data-fc-signal]'),head=card.querySelectorAll('h3').find(h=>h.textContent.startsWith('Senaste sparade signaler'));
  // The chart marks the candle that made a signal (its open time); the list gives the close that confirmed it.
  assert.equal(head.textContent,'Senaste sparade signaler · tid när candlen stängde');
  const first=card.querySelector('.fc-recent li'),s=(await records(p.store)).signals.at(-1),day=dayOf(s.confirmedAt);
  assert.equal(s.confirmedAt,s.barTime+HOUR);
  assert.equal(first.querySelector('time').textContent,day.day+' '+MONTHS[day.month-1]+' '+hhmm(s.confirmedAt));
  // The price is the third, flexible column of the list's grid, right-aligned in it, and the column never gets narrower
  // than the price, so a PEPE price (0,0000045070) in the 300 px side column cannot run under "efterhand". Each row is a
  // button that spans the grid's columns as a subgrid of its own, so its cells stay in the list's columns.
  const row=first.querySelector('.fc-sig-row');
  assert.deepEqual([...first.children].map(x=>x.localName),['button','div']);
  assert.deepEqual([...row.children].map(x=>x.localName),['time','b','span','small']);assert.ok(row.children[2].classList.contains('fc-num'));
  const css=source('../forecast.css');
  assert.match(css,/\.fc-recent\{grid-template-columns:auto auto minmax\(min-content,1fr\) auto\}/);
  assert.match(css,/\.fc-recent>li\{grid-template-columns:auto auto minmax\(min-content,1fr\) auto;grid-template-columns:subgrid\}/);
  assert.match(css,/\.fc-recent \.fc-sig-row\{grid-column:1\/-1;display:grid;grid-template-columns:auto auto minmax\(min-content,1fr\) auto;grid-template-columns:subgrid;/);
  assert.match(css,/\.fc-recent \.fc-num\{text-align:right\}/);
});

test('the view\'s screen-reader texts can never stretch the page behind the full-height view, and a phone swipe stays in the view',()=>{
  const css=source('../forecast.css');
  // .fc-sr is absolutely placed: without a positioned ancestor its static place deep in the side column made the
  // document 2651 px tall behind a 1000 px view, and scrollIntoView then pushed the whole view off the screen.
  assert.match(css,/\.fc-sr\{position:absolute;/);
  assert.match(/#aiForecast\{([^}]*)\}/.exec(css)?.[1]??'',/position:relative/);
  assert.match(/\.fc-card\{([^}]*)\}/.exec(css)?.[1]??'',/position:relative/);
  const narrow=/@media \(max-width:900px\)\{([\s\S]*?)\n\}/.exec(css)?.[1]??'';
  assert.match(narrow,/#aiForecast\{overflow-x:hidden;overflow-y:auto;overscroll-behavior-y:contain\}/);
});

test('in the full-height views the top bar keeps its buttons and pill on one line from 1440 px, as before the AI Forecast button',()=>{
  const css=source('../forecast.css');
  assert.match(css,/@media \(min-width:1440px\)\{body:is\(\.summary,\.floor,\.forecast\) \.tb-row>:is\(\.btn,\.sesspill\)\{white-space:nowrap\}\}/);
  // The brand gives way instead: it may shrink from 681 px, with its subtitle cut by an ellipsis.
  assert.match(css,/body\.krypto \.tb-row \.brand :is\(h1,\.sub\)\{overflow:hidden;white-space:nowrap;text-overflow:ellipsis\}/);
});

test('keyboard focus rings stay whole on the segmented buttons and in the phone\'s sideways-scrolling compare row',()=>{
  const css=source('../forecast.css');
  // The view-wide ring sits 2 px outside a control; a segment clips its buttons, so theirs goes inside. Only a rule
  // with the same id specificity overrides the offset (a plain class rule loses and leaves two vertical bars).
  assert.match(css,/#aiForecast :is\(button,select,input,a\):focus-visible\{outline:2px solid var\(--fc-accent\);outline-offset:2px\}/);
  assert.match(css,/\.fc-seg\{[^}]*overflow:hidden/);
  assert.match(css,/#aiForecast \.fc-seg button:focus-visible\{outline-offset:-2px\}/);
  // A row that scrolls sideways clips vertically too: 4 px of padding hold the 2 px ring and its 2 px offset.
  const phone=/@media \(max-width:560px\)\{([\s\S]*?)\n\}/.exec(css)?.[1]??'',bar=/\.fc-comparebar\{([^}]*)\}/.exec(phone)?.[1]??'';
  assert.match(bar,/overflow-x:auto/);assert.match(bar,/padding:4px 12px/);
});

test('on a tablet the toggles and zoom share the second toolbar row, and the breadcrumb gives way to a long price',()=>{
  const css=source('../forecast.css');
  const tablet=/@media \(min-width:561px\) and \(max-width:900px\)\{([\s\S]*?)\n\}/.exec(css)?.[1]??'';
  // A zero-height, full-width break item after the pair, timeframe and length; the toggles and zoom come after it.
  assert.match(tablet,/\.fc-toolbar::after\{content:'';order:1;flex-basis:100%\}/);
  assert.match(tablet,/\.fc-toggles,\.fc-zoom\{order:2\}/);assert.match(tablet,/\.fc-toggles\{margin-left:0\}/);
  assert.match(tablet,/\.fc-eyebrow\{display:none\}/);
  // Phones lay the toolbar out as a grid, where such an item would take a cell.
  const phone=/@media \(max-width:560px\)\{([\s\S]*?)\n\}/.exec(css)?.[1]??'';
  assert.ok(phone.length>0);assert.doesNotMatch(phone,/::after/);
});

// ---- Stored signals explained, default comparison, account history, wording ----------------------------------
// The page with its chart at hand, for tests that look at the chart's view or its pointer.
function pageWithChart(options){
  const ref={};
  const p=page({...options,extra:{...options.extra,createChart:(canvas,o)=>ref.chart=createForecastChart(canvas,o)}});
  const slotX=t=>{const v=ref.chart.view();return v.plot.right-(v.rightT-t)/HOUR*v.barPx+v.barPx/2;};
  const hover=(x,y=150)=>{for(const fn of p.q('[data-fc-canvas]').listeners.get('pointermove'))fn({clientX:x,clientY:y,pointerId:1,pointerType:'mouse',button:0});p.draw();};
  return {...p,ref,slotX,hover};
}
const stampDate=t=>{const d=dayOf(t);return d.day+' '+MONTHS[d.month-1]+' '+hhmm(t);};

test('every stored signal opens to its own record, and while its row is open the chart draws its entry, SL and TP, marked as its own',async()=>{
  const backend=memoryBackend(),store=createForecastStore(backend),time=after(1998),closed=await loaded({at:time,market:m});
  // The newest signal was stored earlier with an explanation of its own: what is shown must be the record, never a new calculation.
  const last=m.signals.at(-1),e=evaluateBar(closed,closed.findIndex(b=>b.t===last.t),{tf:'1h'});
  const mine=reseal(signalRecord('u1','BTC','1h',e,{recordedAt:last.close+3*HOUR,origin:'backfill',tfMs:HOUR}),{explanation:['Sparad rad <b>ur posten</b>',...e.explanation.slice(1)]});
  assert.equal((await backend.add(mine)).ok,true);
  const p=pageWithChart({time,store,runner:idle()});
  await p.view.show();p.draw();
  const row=()=>p.q(`[data-fc-sig="${mine.id}"]`),detail=()=>p.q('#'+row().getAttribute('aria-controls')),dec=priceDecimals(closed.at(-1).c);
  const tags=['Entry','SL','TP'].map(k=>k+' '+fixed(mine[k.toLowerCase()],dec)),label='▼ SÄLJ '+stampDate(mine.confirmedAt);
  // A real button that says whether it is open, first in the list (the newest), with the record's time, side, entry and efterhand.
  assert.equal(row().localName,'button');assert.equal(row().getAttribute('type'),'button');assert.equal(row().getAttribute('aria-expanded'),'false');
  assert.equal(p.q('.fc-recent .fc-sig-row'),row());
  assert.equal(row().textContent.replace('▾',''),stampDate(mine.confirmedAt)+'▼ SÄLJ'+fixed(mine.entry,dec)+'efterhand ');
  assert.equal(detail().hidden,true);
  assert.ok(!drawn(p.ctx).includes(label),'nothing of it drawn while closed');
  // Opened (keyboard focus stays on it while the card is redrawn): the record's own content, inserted as text.
  row().focus();click(row());
  assert.equal(p.doc.activeElement,row());assert.equal(row().getAttribute('aria-expanded'),'true');assert.equal(detail().hidden,false);
  const text=detail().textContent;
  assert.equal(detail().querySelector('.fc-regime').textContent,'Trend ned');
  assert.ok(text.includes('Bekräftad '+stampDate(mine.confirmedAt)+' när candlen stängde · efterhand'));
  assert.deepEqual(detail().querySelectorAll('.fc-levels dd').map(x=>x.textContent),[mine.entry,mine.sl,mine.tp].map(x=>fixed(x,dec)));
  assert.deepEqual(detail().querySelectorAll('.fc-lines li').map(x=>plain(x.textContent)),mine.explanation.map(plain));
  // Laid out for wrapping in the card, as in the tooltip: a label keeps its number ('ADX 28', 'högsta 85 555') and a line breaks
  // before a ' · ', never after it. The live evaluation's lines above too.
  for(const li of p.q('[data-fc-signal]').querySelectorAll('.fc-lines li')){assert.doesNotMatch(li.textContent,/ [−+-]?\d/,li.textContent);assert.doesNotMatch(li.textContent,/· /,li.textContent);}
  assert.ok(detail().querySelectorAll('.fc-lines li').some(li=>li.textContent.includes('RSI\xa0')),'a label bound to its number');
  assert.equal(detail().querySelector('img,b'),null,'the record\'s text is never markup');
  for(const word of NO_CONFIDENCE)assert.doesNotMatch(text,new RegExp(word,'i'),word);
  // The chart moved to its candle (far back) and draws its levels: a label naming the signal and outlined axis tags.
  assert.equal(p.ref.chart.view().follow,false);
  const x=p.slotX(mine.barTime),v=p.ref.chart.view();assert.ok(x>v.plot.left&&x<v.plot.right,'its candle in view');
  p.ctx.calls.length=0;p.draw();
  assert.ok(drawn(p.ctx).includes(label));for(const tag of tags)assert.ok(drawn(p.ctx).includes(tag),tag);
  // Hovering its candle shows the same record in the tooltip (whose lines keep a label with its number: no-break spaces).
  p.hover(x);
  const tip=p.q('[data-fc-tooltip]').textContent.split('\n').map(plain);
  assert.ok(tip.includes('▼ SÄLJ · Trend ned · bekräftad '+stampDate(mine.confirmedAt)+' · efterhand'),tip.join(' | '));
  assert.ok(tip.includes('Sparad rad <b>ur posten</b>'));
  // Closed again: the lines go and the chart returns to the latest data, which it followed before.
  click(row());
  assert.equal(row().getAttribute('aria-expanded'),'false');assert.equal(detail().hidden,true);assert.equal(p.ref.chart.view().follow,true);
  p.ctx.calls.length=0;p.draw();assert.ok(!drawn(p.ctx).includes(label));
  // Another row picks its own signal; a switch of coin drops the pick.
  click(p.root.querySelectorAll('[data-fc-sig]')[1]);
  assert.deepEqual(p.root.querySelectorAll('[data-fc-sig]').map(b=>b.getAttribute('aria-expanded')),['false','true','false','false','false']);
  enter(p.q('[data-fc-symbol]'),'ETH');
  await until(()=>p.q('[data-fc-pair]').textContent==='ETH · USDT-perp · 1h'&&p.q('[data-fc-pill-text]').textContent==='Live','the ETH series');
  assert.ok(p.root.querySelectorAll('[data-fc-sig]').every(b=>b.getAttribute('aria-expanded')==='false'));
});

test('with no stored version that has an outcome the chart compares with the newest; the compared one stays while candles close, a choice stays, and a switch picks again',async()=>{
  const time=after(1998),closed=await loaded({at:time,market:m}),store=createForecastStore(memoryBackend());
  const f=forecastAt(closed,closed.length-1,{tf:'1h'});await store.putForecast(forecastRecord('u1','BTC','1h',f,{createdAt:time,origin:'live',tfMs:HOUR}));
  const p=page({time,store,runner:idle()});
  await p.view.show();
  const select=p.q('[data-fc-compare]'),[only]=(await records(store)).forecasts;
  assert.equal(select.value,only.id,'the newest, since none has an outcome yet');assert.equal(p.q('[data-fc-chips]').hidden,true);
  // New candles close and newer versions come; the compared version stays, now with outcomes.
  for(let k=1;k<=2;k++){p.rt.at=after(1998+k);await p.view.refreshLive();}
  assert.equal(select.value,only.id);assert.match(p.q('[data-fc-forecast]').textContent,/2 av 10 candles har utfall/);
  // A choice stays as candles close.
  const chosen=(await records(store)).forecasts.at(-2).id;enter(select,chosen);
  p.rt.at=after(2001);await p.view.refreshLive();assert.equal(select.value,chosen);
  // Away to 4h and back: the newest version that has an outcome by now.
  click(p.q('[data-fc-tf="4h"]'));await until(()=>p.q('[data-fc-pair]').textContent==='BTC · USDT-perp · 4h'&&p.q('[data-fc-pill-text]').textContent==='Live','the 4h series');
  click(p.q('[data-fc-tf="1h"]'));await until(()=>p.q('[data-fc-pair]').textContent==='BTC · USDT-perp · 1h'&&p.q('[data-fc-pill-text]').textContent==='Live'&&!select.disabled,'the 1h series');
  await turns();
  const all=(await records(store)).forecasts;
  assert.equal(all.at(-1).cutoff,m.bar(2001).t);assert.equal(select.value,all.at(-2).id,'data t.o.m. the close of the candle before the newest');
});

test('the account card shows its own measured history, trades, win rate, net, max drawdown and profit factor, with – where a measure is not defined',async()=>{
  const p=page({time:after(L1.i),settings:{symbols:['BTC'],leverage:10}}),box=p.doc.createElement('section');
  p.view.renderSummary(box);
  await p.view.show();await p.view.refreshLive();
  const card=p.q('[data-fc-account]'),tiles=()=>Object.fromEntries(card.querySelector('.fc-history').querySelectorAll('.fc-tile').map(x=>[x.querySelector('span').textContent,x.querySelector('b').textContent]));
  assert.ok(card.querySelectorAll('h3').some(h=>h.textContent==='Kontots egen historik · avslutade affärer'));
  // No closed trade yet: no win rate and no profit factor, nothing to divide by.
  assert.deepEqual(tiles(),{'Affärer':'0','Vinstandel':'–','Netto':'0,00\xa0$','Max nedgång':'0,0\xa0%','Vinstfaktor':'–'});
  // One trade, closed at once at the market.
  const [pos]=account(p).positions;click(p.q(`[data-fc-close="${pos.id}"]`));
  await until(()=>/^Stängde/.test(p.q('[data-fc-account-msg]').textContent),'the close');
  const st=accountStats(account(p)),sgn=x=>{const v=Math.round(x*100)/100;return (v>0?'+':v<0?'−':'')+fixed(Math.abs(v),2)+'\xa0$';};
  assert.equal(st.trades,1);
  assert.deepEqual(tiles(),{'Affärer':'1','Vinstandel':fixed(st.winRate*100,1)+'\xa0%','Netto':sgn(st.net),'Max nedgång':fixed(st.maxDrawdown*100,1)+'\xa0%',
    'Vinstfaktor':st.profitFactor===null?'–':fixed(st.profitFactor,2)});
  assert.ok(card.textContent.includes('Avgifter '+fixed(st.fees,2)+'\xa0$ · funding '+fixed(st.funding,2)+'\xa0$ · likvidationer 0. Uppmätt på kontots egna affärer sedan'));
  // The Kryptokonton summary has the same measures on one line.
  assert.ok(box.textContent.includes('Kontots egen historik: netto '+sgn(st.net)+' · max nedgång '+fixed(st.maxDrawdown*100,1)+'\xa0% · vinstfaktor '+
    (st.profitFactor===null?'–':fixed(st.profitFactor,2))+' · avgifter '+fixed(st.fees,2)+'\xa0$'));
});

test('"Data t.o.m." on the chart is the page\'s own text, with the date when the newest version is not from today',async()=>{
  const p=page({time:after(1998),runner:idle()});
  await p.view.show();
  // Bybit's candles stop arriving, and the next morning the newest version is still yesterday's.
  p.rt.fail=u=>u.pathname.endsWith('/kline')?'Nätverksfel':null;p.rt.at=after(1998,20*HOUR);await p.view.refreshLive();
  const close=m.closeOf(1998),text='Data t.o.m. '+stampDate(close);
  assert.notEqual(dayOf(close).day,dayOf(p.rt.at).day);
  p.ctx.calls.length=0;p.draw();
  assert.ok(drawn(p.ctx).includes(text),'drawn: '+drawn(p.ctx).filter(t=>t.startsWith('Data t.o.m.')).join(', '));
  assert.ok(p.q('[data-fc-compare]').options[0].textContent.startsWith('data t.o.m. '+stampDate(close)+' · '),'as the version list writes it');
});

test('the legend names the bands as 50 %/80 %-band (spridning), and nothing in the view speaks of säkerhet',async()=>{
  const p=page({time:after(1998)});
  await p.view.show();
  const items=p.root.querySelectorAll('.fc-legend li').map(li=>li.textContent);
  assert.ok(items.includes('50\xa0%/80\xa0%-band (spridning)'),items.join(' | '));
  assert.doesNotMatch(p.root.textContent,/säkerhet/i);
});

test('right after a switch the signal card says candles are on their way, then shows the evaluation, never the data status',async()=>{
  const p=page({time:after(1998),runner:idle()});
  await p.view.show();
  // Every render of the card is recorded: the fake Bybit answers within one turn, so looking between turns would miss one.
  const card=p.q('[data-fc-signal]'),inner=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(card),'innerHTML'),seen=[];
  Object.defineProperty(card,'innerHTML',{get(){return inner.get.call(this);},set(v){seen.push(v);inner.set.call(this,v);}});
  click(p.q('[data-fc-tf="4h"]'));
  await until(()=>p.q('[data-fc-pill-text]').textContent==='Live'&&/Bekräftad/.test(card.textContent),'the 4h evaluation');
  const first=s=>/<p class="fc-muted">([^<]*)<\/p>/.exec(s)?.[1];
  assert.equal(first(seen[0]),'Hämtar candles från Bybit…','candles on their way');
  // The first render with the candles already has the evaluation of the newest closed one.
  assert.match(seen[1],/INGEN SIGNAL|▲ KÖP|▼ SÄLJ/);
  assert.ok(!seen.some(s=>/uppdaterad \d+ s sedan/.test(s)),'never the data status');
});

// ---- An open row that leaves the list, regimes that name none, levels drawn once, a failed evaluation ------------------
test('an open row whose signal leaves the five newest is closed, and a chart moved for it returns to the latest data unless the user moved it',async()=>{
  const mk=scriptMarket({shorts:3}),[s5,s6]=mk.signals.slice(4);
  const label=p=>{p.ctx.calls.length=0;p.draw();return drawn(p.ctx).filter(t=>/^[▲▼] (KÖP|SÄLJ) \d/.test(t));};
  for(const moved of [false,true]){
    const p=pageWithChart({time:mk.closeOf(s5.i)+2*SEC,runner:idle(),runtime:{market:mk}});
    await p.view.show();p.draw();
    const rows=()=>p.root.querySelectorAll('[data-fc-sig]');
    assert.equal(rows().length,5);
    // The oldest of the five, far back: the chart moves there and draws its levels.
    const oldest=rows().at(-1),id=oldest.getAttribute('data-fc-sig');click(oldest);
    assert.equal(p.ref.chart.view().follow,false);assert.equal(label(p).length,1);
    if(moved)p.ref.chart.panBy(40,0);
    const at=p.ref.chart.view().rightT;
    // A sixth signal is stored when its candle closes: the opened one is no longer listed, so no row is left to close it by.
    for(let i=s5.i+1;i<=s6.i;i++){p.rt.at=mk.closeOf(i)+2*SEC;await p.view.refreshLive();}
    assert.equal(rows().length,5);assert.ok(!rows().some(b=>b.getAttribute('data-fc-sig')===id));
    assert.ok(rows().every(b=>b.getAttribute('aria-expanded')==='false'),'no row open');
    assert.deepEqual(label(p),[],'its levels are gone');
    // As closing the row would: back at the latest data, unless the user has moved the chart since.
    if(moved)assert.deepEqual([p.ref.chart.view().follow,p.ref.chart.view().rightT],[false,at]);
    else assert.equal(p.ref.chart.view().follow,true);
  }
});

test('a stored record\'s regime that names no regime, even one named like an object\'s own property, is never shown',async()=>{
  const backend=memoryBackend(),store=createForecastStore(backend),time=after(1998),closed=await loaded({at:time,market:m});
  const last=m.signals.at(-1),e=evaluateBar(closed,closed.findIndex(b=>b.t===last.t),{tf:'1h'});
  const odd=reseal(signalRecord('u1','BTC','1h',e,{recordedAt:last.close+3*HOUR,origin:'backfill',tfMs:HOUR}),{regime:'constructor'});
  assert.equal((await backend.add(odd)).ok,true);
  const p=pageWithChart({time,store,runner:idle()});
  await p.view.show();p.draw();
  const row=p.q(`[data-fc-sig="${odd.id}"]`);click(row);
  const detail=p.q('#'+row.getAttribute('aria-controls'));
  assert.equal(detail.hidden,false);assert.equal(detail.querySelector('.fc-regime'),null,'no regime chip');
  assert.ok(detail.textContent.includes('Bekräftad '+stampDate(odd.confirmedAt)+' när candlen stängde · efterhand'));
  assert.doesNotMatch(p.root.textContent,/function|native code/);
  p.hover(p.slotX(odd.barTime));
  const tip=p.q('[data-fc-tooltip]').textContent.split('\n').map(plain);
  assert.ok(tip.includes('▼ SÄLJ · bekräftad '+stampDate(odd.confirmedAt)+' · efterhand'),tip.join(' | '));
  assert.doesNotMatch(tip.join('\n'),/function|native code/);
});

test('opening the row of a signal whose levels are still live draws them once, as that signal\'s, never doubled by the live lines',async()=>{
  const last=m.signals.at(-1),p=pageWithChart({time:m.closeOf(last.i)+2*SEC,runner:idle()});
  await p.view.show();
  // The fill of the tag under each "Entry …", "SL …" and "TP …" text the chart draws (one out of view is pinned to an edge, "▲ TP …").
  const tags=()=>{p.ctx.calls.length=0;p.draw();const c=p.ctx.calls;
    return c.map((k,i)=>{const m=k[0]==='text'&&/^(?:[▲▼] )?(Entry|SL|TP) \d/.exec(k[1]);return m?m[1]+':'+c.slice(0,i).findLast(x=>x[0]==='fill')[1]:null;}).filter(Boolean).sort();};
  // Its candle is the newest closed one, so its entry, SL and TP are the live levels, on filled tags.
  assert.deepEqual(tags(),['Entry:rgba(159,176,192,0.9)','SL:rgba(226,72,60,0.9)','TP:rgba(20,167,160,0.9)']);
  const row=p.q('[data-fc-sig]');assert.equal(row.getAttribute('data-fc-sig').split('|').at(-2),String(last.t));
  click(row);assert.equal(p.q('[data-fc-sig]').getAttribute('aria-expanded'),'true');
  // Opened: the same three levels, now as that signal's (outlined tags), and no second set of live ones.
  assert.deepEqual(tags().sort(),['Entry:#283240','SL:#283240','TP:#283240']);
});

test('a switch away and back to the same coin and timeframe never brings back a row opened before it',async()=>{
  const p=pageWithChart({time:after(1998),runner:idle()});
  await p.view.show();p.draw();
  const rows=()=>p.root.querySelectorAll('[data-fc-sig]'),labels=()=>{p.ctx.calls.length=0;p.draw();return drawn(p.ctx).filter(t=>/^[▲▼] (KÖP|SÄLJ) \d/.test(t));};
  click(rows()[1]);assert.equal(rows()[1].getAttribute('aria-expanded'),'true');assert.equal(labels().length,1);
  click(p.q('[data-fc-tf="4h"]'));
  await until(()=>p.q('[data-fc-pair]').textContent==='BTC · USDT-perp · 4h'&&p.q('[data-fc-pill-text]').textContent==='Live','the 4h series');
  click(p.q('[data-fc-tf="1h"]'));
  await until(()=>p.q('[data-fc-pair]').textContent==='BTC · USDT-perp · 1h'&&p.q('[data-fc-pill-text]').textContent==='Live'&&rows().length===5,'the 1h series');
  await turns();
  assert.ok(rows().every(b=>b.getAttribute('aria-expanded')==='false'),'no row open');
  assert.deepEqual(labels(),[]);assert.equal(p.ref.chart.view().follow,true);
});

test('when the rules cannot be evaluated for the newest closed candle the signal card says so, never that it is still working',async()=>{
  // The view's evaluateBar fails, as an unexpected error would: the candles' check throws inside it, and only there.
  const some=Array.prototype.some;let failing=true;
  Array.prototype.some=function(...a){
    if(failing&&this.length&&typeof this[0]?.o==='number'&&/\bevaluateBar\b/.test(new Error().stack))throw Error('Testfel');
    return some.apply(this,a);
  };
  try{
    const p=page({time:after(1998),runner:idle()});
    await p.view.show();
    const card=p.q('[data-fc-signal]');
    assert.equal(card.querySelector('p').textContent,'Signalen kunde inte beräknas för den senaste stängda candlen.');
    assert.equal(card.querySelectorAll('.fc-recent li').length,5,'the stored signals are listed as usual');
    // The next closed candle is evaluated again.
    failing=false;p.rt.at=after(1999);await p.view.refreshLive();
    assert.match(card.textContent,/INGEN SIGNAL|▲ KÖP|▼ SÄLJ/);assert.doesNotMatch(card.textContent,/kunde inte beräknas|Beräknar/);
  }finally{Array.prototype.some=some;}
});
