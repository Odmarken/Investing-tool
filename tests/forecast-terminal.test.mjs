import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mountTerminal,TERMINAL_PREFS,TERMINAL_TABS,TERMINAL_PAGE} from '../forecast-terminal.js';
// terminalFigures through the namespace, so this file also loads against a terminal without it (each test then fails alone).
import * as terminalModule from '../forecast-terminal.js';
import {ACCOUNT,newForecastAccount,openManual,openPosition,closePosition,deposit,withdraw,setFree,setLevels,previewLevels,accountLive,accountStats,
  tradeReasons,checkQuote} from '../forecast-account.js';
import {createForecastRunner} from '../forecast-runner.js';
import {createForecastStore,memoryBackend} from '../forecast-store.js';
import {scriptMarket,fakeBybit,limitsFor,memoryStorage,tabLocks} from './forecast-fixtures.mjs';

// A file of the repo as text with LF line ends, whatever the checkout made of them.
const source=rel=>readFileSync(new URL(rel,import.meta.url),'utf8').replace(/\r\n/g,'\n');

// ---- A small DOM: HTML parsing, simple selectors, events with keys, focus and form state ----
const VOID=new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\xa0'};
const decode=s=>s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|\w+);/g,(m,k)=>k[0]==='#'?String.fromCodePoint(k[1]==='x'||k[1]==='X'?parseInt(k.slice(2),16):+k.slice(1)):ENTITIES[k]??m);
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
const parseSelector=text=>text.split(',').map(s=>s.trim().split(/\s+/).map(compound));
function one(el,c){
  if(el?.nodeType!==1||c.tag&&el.localName!==c.tag||c.id&&el.getAttribute('id')!==c.id)return false;
  return c.classes.every(k=>el.classList.contains(k))&&c.attrs.every(([k,v])=>{const a=el.getAttribute(k);return a!==null&&(v===null||a===v);});
}
function chain(el,parts){
  if(!one(el,parts.at(-1)))return false;
  let k=parts.length-2;for(let n=el.parentNode;k>=0&&n;n=n.parentNode)if(one(n,parts[k]))k--;
  return k<0;
}
class FakeText{constructor(data){this.nodeType=3;this.data=data;this.parentNode=null;}get textContent(){return this.data;}}
// As in a browser, focus falls back to the page when the focused control is removed. One that is disabled is still
// reported as focused until the browser's next frame, as Chrome does, and only then falls back to the page.
function blur(el,self){
  const doc=el.ownerDocument,a=doc?.activeElement;
  if(a&&(self?a===el:a!==el&&el.contains(a)))doc.activeElement=null;
}
const blurLater=el=>{setImmediate(()=>{if(el.disabled)blur(el,true);});};
function clear(el){blur(el,false);for(const c of el.childNodes)c.parentNode=null;el.childNodes=[];}
class FakeElement{
  constructor(tag,doc){
    this.nodeType=1;this.localName=tag;this.tagName=tag.toUpperCase();this.ownerDocument=doc;
    this.attrs=new Map();this.childNodes=[];this.parentNode=null;this.listeners=new Map();this.state={};
  }
  getAttribute(k){return this.attrs.has(k)?this.attrs.get(k):null;}
  setAttribute(k,v){this.attrs.set(k,String(v));}
  removeAttribute(k){this.attrs.delete(k);}
  hasAttribute(k){return this.attrs.has(k);}
  get children(){return this.childNodes.filter(n=>n.nodeType===1);}
  get hidden(){return this.attrs.has('hidden');}set hidden(v){if(v)this.attrs.set('hidden','');else this.attrs.delete('hidden');}
  get disabled(){return this.attrs.has('disabled');}set disabled(v){if(v){this.attrs.set('disabled','');blurLater(this);}else this.attrs.delete('disabled');}
  get value(){return 'value' in this.state?this.state.value:this.getAttribute('value')??'';}
  set value(v){this.state.value=String(v);}
  get classList(){
    const list=()=>(this.getAttribute('class')??'').split(/\s+/).filter(Boolean),write=xs=>this.setAttribute('class',[...new Set(xs)].join(' '));
    return {contains:k=>list().includes(k),add:(...ks)=>write([...list(),...ks]),remove:(...ks)=>write(list().filter(x=>!ks.includes(x))),
      toggle:(k,force)=>{const on=force===undefined?!list().includes(k):!!force;write(on?[...list(),k]:list().filter(x=>x!==k));return on;}};
  }
  get textContent(){return this.childNodes.map(n=>n.textContent).join('');}
  set textContent(v){const t=String(v??'');clear(this);this.childNodes=t?[Object.assign(new FakeText(t),{parentNode:this})]:[];}
  set innerHTML(html){
    clear(this);
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
  focus(){if(!this.disabled&&(['a','button','input','select','summary','textarea'].includes(this.localName)||this.hasAttribute('tabindex')))this.ownerDocument.activeElement=this;}
}
function fakeDocument(){const doc={activeElement:null,createElement:tag=>new FakeElement(tag,doc)};return doc;}
function fire(target,type,extra={}){
  const e={type,target,...extra,defaultPrevented:false,stopped:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;}};
  for(let n=target;n&&!e.stopped;n=n.parentNode)for(const fn of [...(n.listeners?.get(type)??[])])fn.call(n,e);
  return e;
}
// A click on an enabled control, as a browser sends it (a disabled one gets none).
function click(el){assert.ok(el,'nothing to click');if(el.disabled)return false;fire(el,'click');return true;}
const key=(el,k)=>fire(el,'keydown',{key:k});
const type=(el,value)=>{assert.ok(el,'no field');el.value=value;fire(el,'input');};
const busy=el=>el.disabled||el.getAttribute('aria-disabled')==='true';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(n=12){for(let k=0;k<n;k++)await turn();}
async function until(f,what){for(let k=0;k<3000;k++){if(f())return;await turn();}assert.fail('timed out waiting for '+what);}

// ---- Numbers and times as the page writes them ----
const fixed=(x,d)=>x.toLocaleString('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d});
const money=x=>fixed(x,2)+'\xa0$';
const signed=(x,d,unit)=>{const v=Math.round(x*10**d)/10**d;return (v>0?'+':v<0?'−':'')+fixed(Math.abs(v),d)+unit;};
const signedMoney=x=>signed(x,2,'\xa0$');
const signedPct=x=>signed(x*100,1,'\xa0%');
const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps*Math.max(1,Math.abs(b)),a+' vs '+b);
const MONTHS=['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];
const hhmm=t=>new Date(t).toLocaleTimeString('sv-SE',{timeZone:'Europe/Stockholm',hour:'2-digit',minute:'2-digit'});
const dayOf=t=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Stockholm',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(t).map(x=>[x.type,+x.value]));
const stamp=(t,now)=>{const a=dayOf(t),b=dayOf(now);return (a.year===b.year&&a.month===b.month&&a.day===b.day?'':a.day+' '+MONTHS[a.month-1]+(a.year===b.year?'':' '+a.year)+' ')+hhmm(t);};
// The runner's own text formats, for a fake runner that answers as it does.
const dollars=x=>x.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
const priceText=x=>x.toLocaleString('sv-SE',{maximumSignificantDigits:6});
// The view binds a number to its unit with a no-break space; sv-SE groups thousands with one too.
const bound=s=>s.replace(/(\d) ([%$])/g,'$1\xa0$2');
const NB='\xa0';
// When a close notice says a position closed: 'kl. 10:10', after the date when that is not today.
const klock=(t,now)=>{const s=stamp(t,now),i=s.lastIndexOf(' ');return (i<0?'':s.slice(0,i)+' ')+'kl.'+NB+s.slice(i+1);};
// An element's text as a wide screen shows it, or (wide false) as a phone or a tablet does: the other layout's words go.
const shownText=(n,wide=true)=>n.nodeType===3?n.data:n.classList.contains(wide?'fct-narrow':'fct-wide')?'':n.childNodes.map(c=>shownText(c,wide)).join('');
// The ticket's buttons are named as they read, each kept together on its line.
const NO_POSITIONS='Inga öppna positioner. Lägg en order med Köp'+NB+'/'+NB+'Lång eller Sälj'+NB+'/'+NB+'Kort uppe till höger.';

// ---- An account built with the engine: closed trades, a deposit and a withdrawal, and three open positions ----
const SEC=1000,MIN=60000,HOUR=3600000;
const T0=Date.UTC(2026,9,6,8,10);
const quote=(price,at,mark=price)=>({price,mark,at});
const QUOTES=Object.freeze({BTC:quote(60412.3,T0,60409.8),ETH:quote(2987.45,T0,2988.1),DOGE:quote(.20101,T0,.20098)});
const BASE={BTC:60000,ETH:3000,SOL:150,XRP:.6,DOGE:.2},COINS=['BTC','ETH','SOL','XRP','DOGE'];
function build({trades=3,open=true,deposits=true,withdrawAfter=1}={}){
  let a=newForecastAccount(T0-30*HOUR);
  if(deposits)a=deposit(a,50,T0-29*HOUR);
  let t=T0-28*HOUR;
  for(let k=0;k<trades;k++){
    const symbol=COINS[k%5],side=k%3?'long':'short',base=BASE[symbol];
    const r=openManual(a,{symbol,side,margin:10+k%4*2,leverage:[10,20,25.5,15][k%4],quote:quote(base,t),contract:limitsFor(symbol,t),now:t});
    assert.ok(r.ok,r.reason);
    a=closePosition(r.account,r.position.id,{price:base*(1+(k%4===0?-.004:.003)*(side==='long'?1:-1)),now:t+20*MIN,reason:'manuell'});
    t+=25*MIN;
    if(deposits&&k===withdrawAfter)a=withdraw(a,20,t);
  }
  if(!open)return a;
  const at=T0-5*SEC;
  let r=openManual(a,{symbol:'BTC',side:'long',margin:20,leverage:10,sl:59000,tp:62500,quote:quote(60200,at),contract:limitsFor('BTC',at),now:at});
  assert.ok(r.ok,r.reason);a=r.account;
  r=openManual(a,{symbol:'ETH',side:'short',margin:12.5,leverage:25,sl:3050,quote:quote(3001.2,at),contract:limitsFor('ETH',at),now:at});
  assert.ok(r.ok,r.reason);a=r.account;
  // A signal position: its 20-candle time stop ends it.
  const barTime=Math.floor(T0/HOUR)*HOUR-HOUR,s=T0-30*SEC;
  const signal={id:'s|u1|DOGE|1h|'+barTime+'|af-signal-v1',symbol:'DOGE',tf:'1h',side:'long',entry:.2,sl:.195,tp:.211,barTime,confirmedAt:barTime+HOUR};
  const o=openPosition(a,{signal,symbol:'DOGE',quote:quote(.20012,s),contract:limitsFor('DOGE',s),now:s,tfMs:HOUR,dataReliable:true});
  assert.ok(o.opened,o.reason);
  return o.account;
}
// A runner stand-in over that account: its reads are the engine's own (accountLive, previewLevels), its actions apply
// the engine's functions and answer in the runner's words. hold() keeps every action waiting until it is released.
// st.limits: whether it holds Bybit's limits for the coins (the real runner's limits(symbol), with their order filters).
function fakeRunner(account,{now=()=>T0,limits=true}={}){
  const calls=[],st={account,quotes:{...QUOTES},signedOut:false,status:null,gate:null,limits};
  const wait=async()=>{while(st.gate)await st.gate.promise;};
  const side=p=>p.side==='long'?'lång':'kort';
  const runner={
    account:()=>st.signedOut?null:st.account,
    live:()=>st.signedOut||!st.account?null:accountLive(st.account,st.quotes,now()),
    status:()=>st.status??(st.signedOut?{state:'signed-out',text:'Logga in för att handla med AI Forecast-kontot'}:
      st.account?{state:'manual',text:'Manuell handel'}:{state:'loading',text:'Laddar AI Forecast-kontot…'}),
    quoteLevels(id,levels){
      const p=st.account.positions.find(x=>x.id===id);
      return previewLevels(st.account,id,levels,{quote:p?st.quotes[p.symbol]:null,contract:p?limitsFor(p.symbol,now()):null,now:now()});
    },
    limits:symbol=>st.limits?limitsFor(symbol,now()):null,
    async closePosition(id){
      calls.push(['closePosition',id]);await wait();
      const p=st.account.positions.find(x=>x.id===id);
      if(!p)return {ok:false,text:'Positionen är redan stängd',trade:null};
      st.account=closePosition(st.account,id,{price:st.quotes[p.symbol].price,now:now(),reason:'manuell'});
      const trade=st.account.trades.at(-1);
      return {ok:true,text:'Stängde '+side(p)+' '+p.symbol+(p.origin==='manual'?' (manuell)':'')+' till '+priceText(trade.exit)+' · '+(trade.pnl<0?'−':'+')+dollars(Math.abs(trade.pnl)),trade};
    },
    async setLevels(id,levels){
      calls.push(['setLevels',id,levels]);await wait();
      const p=st.account.positions.find(x=>x.id===id);
      const r=setLevels(st.account,id,levels,{quote:st.quotes[p.symbol],contract:limitsFor(p.symbol,now()),now:now()});
      if(!r.ok)return {ok:false,text:r.reason,position:null,trade:null};
      st.account=r.account;
      const q=r.position;
      return {ok:true,text:r.changed?'Nya nivåer för '+side(q)+' '+q.symbol+': '+(q.sl===null?'ingen SL':'SL '+priceText(q.sl))+', '+(q.tp===null?'ingen TP':'TP '+priceText(q.tp)):
        'SL och TP är oförändrade',position:q,trade:null};
    },
    async transfer(x){
      calls.push(['transfer',x]);await wait();
      try{st.account=(x.kind==='in'?deposit:withdraw)(st.account,x.amount,now());}catch(e){return {ok:false,text:e.message,account:st.account};}
      const t=st.account.transfers.at(-1);
      return {ok:true,text:(t.kind==='in'?'Satte in ':'Tog ut ')+dollars(t.amount)+' · tillgängligt '+dollars(st.account.cash),account:st.account};
    },
    async setFree(v){
      calls.push(['setFree',v]);await wait();
      try{st.account=setFree(st.account,v,now());}catch(e){return {ok:false,text:e.message,account:st.account};}
      const t=st.account.transfers.at(-1);
      return {ok:true,text:(t.kind==='in'?'Satte in ':'Tog ut ')+dollars(t.amount)+' · tillgängligt '+dollars(st.account.cash),account:st.account};
    }
  };
  const hold=()=>{let release;st.gate={promise:new Promise(r=>{release=r;})};return ()=>{st.gate=null;release();};};
  return {runner,calls,st,hold};
}
// The terminal in its section, with prefs, a confirm that answers `answer` and an announce that records.
function mount(runner,{prefs=memoryStorage(),answer=true,now=()=>T0,announce=true,doc=fakeDocument()}={}){
  const root=doc.createElement('section'),asked=[],said=[];
  root.setAttribute('data-fc-terminal','');
  const term=mountTerminal(root,{runner,now,prefs,confirm:message=>{asked.push(message);return typeof answer==='function'?answer(message):answer;},
    ...(announce?{announce:text=>said.push(text)}:{})});
  return {doc,root,term,asked,said,prefs,q:s=>root.querySelector(s),qa:s=>root.querySelectorAll(s)};
}
const val=(p,k)=>p.q(`[data-fct-val="${k}"]`).textContent;
const figures=p=>['equity','cash','margin','open','result'].map(k=>val(p,k));
const openTab=(p,name)=>click(p.q(`[data-fct-tab="${name}"]`));
const panel=(p,name)=>p.q(`[data-fct-panel="${name}"]`);
const row=(p,id)=>p.qa('[data-fct-row]').find(r=>r.getAttribute('data-fct-row')===id);
const field=(r,level)=>r.querySelector(`[data-fct-level="${level}"]`);
const button=(r,what,level)=>r.querySelector(`[data-fct-${what}="${level}"]`);

test('the header shows the money as the rows, Historik and Saldo show it, the result since the start without deposits and withdrawals, and why a figure waits',()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner),live=f.runner.live();
  assert.deepEqual(p.qa('.fct-fig dt').map(x=>x.textContent),['Kapital','Tillgängligt','Marginal i bruk','Orealiserat resultat','Resultat sedan start']);
  assert.ok(live.equity>0&&live.openPnl!==0);
  // Orealiserat resultat is the positions' Resultat in Positioner added up, each as its row shows it: what the open
  // positions give if they close now, after every fee and the funding, so a row and the header never tell two stories.
  const cents=x=>Math.round(Number(x.replace(/[^\d,−+-]/g,'').replace('−','-').replace(',','.'))*100);
  const rows=()=>p.qa('[data-fct-row] [data-fct-pnl]').reduce((s,x)=>s+cents(x.textContent),0);
  const fig=terminalModule.terminalFigures(a,live);
  assert.deepEqual(figures(p),[money(fig.equity),money(a.cash),money(fig.margin),signedMoney(rows()/100),signedMoney(fig.result)]);
  // Here the rows' 0,26 + 0,75 + 2,19 = 3,20 $ and Historik's netto of 0,13 $ make +3,33 $ since the start, and the start's
  // 100 $ with 50 $ in and 20 $ out make Kapital 133,33 $: rounded once, the unrounded account (133,3249… $) reads 133,32 $.
  assert.deepEqual(figures(p),['133,33\xa0$',money(a.cash),'42,80\xa0$','+3,20\xa0$','+3,33\xa0$']);
  assert.deepEqual([money(live.equity),signedMoney(live.result)],['133,32\xa0$','+3,32\xa0$']);
  assert.ok(Math.abs(cents(val(p,'open'))-live.openPnl*100)<=1.5,val(p,'open')+' vs '+live.openPnl);
  // Its opening fees and funding are paid already, so it is less than Kapital beyond Tillgängligt and Marginal i bruk.
  const paid=a.positions.reduce((s,x)=>s+x.fees+x.funding,0);
  near(live.equity-live.cash-live.marginUsed,live.openPnl+paid);assert.ok(paid>.02);
  // Resultat sedan start is the closed trades' net (Historik) plus Orealiserat resultat.
  near(live.result,accountStats(a).net+live.openPnl);
  // Whatever the prices, the rows add up to it to the cent.
  for(let k=0;k<300;k++){
    const btc=59000+k*7.37,eth=2950+k*.413;
    f.st.quotes={...QUOTES,BTC:quote(btc,T0,btc-1.3),ETH:quote(eth,T0,eth+.2)};p.term.update();
    const l=f.runner.live();
    assert.equal(cents(val(p,'open')),rows(),'BTC '+btc);
    assert.ok(Math.abs(cents(val(p,'open'))-l.openPnl*100)<=1.5,val(p,'open')+' vs '+l.openPnl);
  }
  f.st.quotes={...QUOTES};p.term.update();
  // 50 $ in and 20 $ out are no result: Resultat sedan start is the equity less the start and the net transfers.
  assert.equal(live.netTransfers,30);near(live.result,live.equity-100-30);
  assert.equal(p.q('[data-fct-val="result"]').getAttribute('class'),live.result>0?'pos':'neg');
  assert.equal(p.q('[data-fct-val="open"]').getAttribute('class'),live.openPnl>0?'pos':'neg');
  assert.equal(p.q('[data-fct-wait]').hidden,true);
  // A price that has gone stale: Kapital and both results wait, and the reason says for what.
  f.st.quotes={...QUOTES,ETH:quote(2987.45,T0-60*SEC)};p.term.update();
  assert.deepEqual(figures(p),['–',money(a.cash),money(fig.margin),'–','–']);
  assert.deepEqual([p.q('[data-fct-wait]').hidden,p.q('[data-fct-wait]').textContent],[false,'Väntar på färskt pris för ETH']);
  // The open-positions count rides on its tab.
  assert.equal(p.q('[data-fct-count]').textContent,'3');
});

test('the − button folds the terminal to a thin bar with Kapital, + opens it again, and the choice survives a reload in the prefs',()=>{
  const prefs=memoryStorage(),f=fakeRunner(build()),p=mount(f.runner,{prefs}),toggle=p.q('[data-fct-toggle]'),body=p.q('[data-fct-body]');
  assert.deepEqual([toggle.localName,toggle.getAttribute('type'),toggle.getAttribute('aria-expanded'),toggle.textContent,toggle.getAttribute('aria-label'),
    toggle.getAttribute('aria-controls'),body.hidden],['button','button','true','−','Kontoterminal',body.getAttribute('id'),false]);
  toggle.focus();click(toggle);
  assert.deepEqual([toggle.getAttribute('aria-expanded'),toggle.textContent,body.hidden,p.root.getAttribute('data-collapsed'),p.q('[data-fct]').classList.contains('is-collapsed')],
    ['false','+',true,'true',true]);
  assert.equal(p.doc.activeElement,toggle,'focus stays on the button');
  // The bar keeps Kapital, live, as the open terminal shows it.
  const kapital=()=>money(terminalModule.terminalFigures(f.st.account,f.runner.live()).equity);
  assert.equal(val(p,'equity'),kapital());
  f.st.quotes={...QUOTES,BTC:quote(61000,T0,61000)};p.term.update();
  assert.equal(val(p,'equity'),kapital());assert.notEqual(kapital(),'–');
  assert.deepEqual(JSON.parse(prefs.getItem(TERMINAL_PREFS)),{collapsed:true,tab:'positions'});
  // A reload opens it folded; + opens it, and that is kept too.
  p.term.destroy();
  const again=mount(f.runner,{prefs});
  assert.deepEqual([again.q('[data-fct-toggle]').getAttribute('aria-expanded'),again.q('[data-fct-body]').hidden],['false',true]);
  click(again.q('[data-fct-toggle]'));
  assert.deepEqual([again.q('[data-fct-body]').hidden,again.q('[data-fct-toggle]').textContent],[false,'−']);
  assert.deepEqual(JSON.parse(prefs.getItem(TERMINAL_PREFS)),{collapsed:false,tab:'positions'});
  // Prefs as a {get,set} store or a function returning a storage; a storage that throws only loses the memory.
  const kv=new Map(),adapter={get:k=>kv.get(k),set:(k,v)=>kv.set(k,v)};
  click(mount(f.runner,{prefs:adapter}).q('[data-fct-toggle]'));
  assert.deepEqual(kv.get(TERMINAL_PREFS),{collapsed:true,tab:'positions'});
  assert.equal(mount(f.runner,{prefs:adapter}).q('[data-fct-body]').hidden,true);
  const storage=memoryStorage();
  click(mount(f.runner,{prefs:()=>storage}).q('[data-fct-toggle]'));
  assert.equal(mount(f.runner,{prefs:()=>storage}).q('[data-fct-body]').hidden,true);
  const blocked={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}},c=mount(f.runner,{prefs:blocked});
  assert.equal(c.q('[data-fct-body]').hidden,false);
  assert.doesNotThrow(()=>click(c.q('[data-fct-toggle]')));assert.equal(c.q('[data-fct-body]').hidden,true);
  // Stored nonsense is ignored.
  const odd=memoryStorage();odd.setItem(TERMINAL_PREFS,'{"collapsed":"ja","tab":"constructor"}');
  const d=mount(f.runner,{prefs:odd});
  assert.deepEqual([d.q('[data-fct-body]').hidden,d.q('[data-fct-tab="positions"]').getAttribute('aria-selected')],[false,'true']);
});

test('the tabs are a tablist: arrow keys, Home and End move between them and open the one they reach, and the open tab is kept',()=>{
  const prefs=memoryStorage(),f=fakeRunner(build()),p=mount(f.runner,{prefs}),tabs=p.qa('[role="tab"]');
  assert.equal(p.q('[role="tablist"]').getAttribute('aria-labelledby'),p.q('.fct-title').getAttribute('id'));
  assert.equal(p.q('.fct-title').textContent,'Kontoterminal');
  // The count is part of the tab's name, a word of its own: "Positioner 3".
  assert.deepEqual(tabs.map(t=>[t.getAttribute('data-fct-tab'),t.textContent]),[['positions','Positioner 3'],['history','Historik'],['events','Händelser'],['balance','Saldo']]);
  assert.deepEqual(TERMINAL_TABS,['positions','history','events','balance']);
  for(const t of tabs){
    const box=p.q('#'+t.getAttribute('aria-controls'));
    assert.deepEqual([box.getAttribute('role'),box.getAttribute('aria-labelledby'),box.getAttribute('tabindex')],['tabpanel',t.getAttribute('id'),'0']);
  }
  const state=()=>tabs.map(t=>(t.getAttribute('aria-selected')==='true'?'*':'')+t.getAttribute('tabindex')+(p.q('#'+t.getAttribute('aria-controls')).hidden?'':'+'));
  assert.deepEqual(state(),['*0+','-1','-1','-1']);
  tabs[0].focus();
  const go=(from,k,to)=>{const e=key(tabs[from],k);assert.equal(e.defaultPrevented,true,k);assert.equal(p.doc.activeElement,tabs[to],k);};
  go(0,'ArrowRight',1);assert.deepEqual(state(),['-1','*0+','-1','-1']);
  go(1,'ArrowRight',2);go(2,'ArrowRight',3);go(3,'ArrowRight',0);
  go(0,'ArrowLeft',3);assert.deepEqual(state(),['-1','-1','-1','*0+']);
  go(3,'Home',0);go(0,'End',3);go(3,'ArrowLeft',2);
  assert.deepEqual(state(),['-1','-1','*0+','-1']);
  // Other keys are the browser's.
  assert.equal(key(tabs[2],'a').defaultPrevented,false);assert.equal(key(tabs[2],'Enter').defaultPrevented,false);
  assert.deepEqual(JSON.parse(prefs.getItem(TERMINAL_PREFS)),{collapsed:false,tab:'events'});
  // A click opens a tab; a reload opens the last one.
  click(tabs[1]);assert.deepEqual(state(),['-1','*0+','-1','-1']);
  const again=mount(f.runner,{prefs});
  assert.equal(again.q('[data-fct-tab="history"]').getAttribute('aria-selected'),'true');assert.equal(panel(again,'history').hidden,false);
  assert.ok(panel(again,'history').querySelector('table'),'and paints it');
});

test('Positioner shows coin, side, origin, leverage, quantity, entry, price, liquidation, margin, live result, SL and TP and Stäng for every open position',()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner),live=f.runner.live();
  // The result before the levels, Stäng last.
  assert.deepEqual(p.qa('[data-fct-panel="positions"] thead th').map(th=>th.textContent),
    ['Coin','Sida','Typ','Hävstång','Antal','Entry','Pris','Likv.','Marginal','Resultat','SL / TP','Stäng']);
  assert.deepEqual(p.qa('[data-fct-panel="positions"] thead th').at(-1).getAttribute('class'),'fct-act');
  assert.deepEqual(p.qa('[data-fct-row]').map(r=>r.getAttribute('data-fct-row')),a.positions.map(x=>x.id));
  // Prices with the decimals of the coin's tick on Bybit (BTC 0,10, ETH 0,01, DOGE 0,00001), as the runner writes them.
  const dec={BTC:1,ETH:2,DOGE:5},qty=x=>x.toLocaleString('sv-SE',{maximumSignificantDigits:6});
  for(const x of live.positions){
    const r=row(p,x.id),cells=r.children.map(c=>c.textContent),d=dec[x.symbol];
    const origin=x.origin==='manual'?'Manuell':'Signal'+'tidsstopp '+stamp(x.deadline,T0);
    assert.deepEqual(cells.slice(0,10),
      [x.symbol,x.side==='long'?'Lång':'Kort',origin,x.leverage.toLocaleString('sv-SE',{maximumFractionDigits:2})+'×',qty(x.units),fixed(x.entry,d),fixed(x.price,d),
        fixed(x.liq,d),money(x.margin+(x.reserve??0)),signedMoney(x.pnl)+' '+signedPct(x.pnlPct)],x.symbol);
    // The result's amount, and its percentage under it, in the colour of its sign.
    const pnl=r.querySelector('[data-fct-cell="pnl"]');
    assert.deepEqual([pnl.getAttribute('class'),pnl.querySelector('[data-fct-pnl]').textContent,pnl.querySelector('small').textContent],
      ['num fct-pnl '+(x.pnl>0?'pos':'neg'),signedMoney(x.pnl),' '+signedPct(x.pnlPct)]);
    // A manual order's margin includes the fee to close Bybit reserves with it; the title gives the parts.
    assert.equal(r.querySelector('[data-fct-cell="margin"]').getAttribute('title'),x.reserve>0?'Marginal '+money(x.margin)+' + reserverad avgift för stängning '+money(x.reserve):null);
    const close=r.querySelector('[data-fct-close]');
    assert.deepEqual([close.textContent,close.getAttribute('aria-label'),close.closest('td').getAttribute('class')],['Stäng','Stäng '+(x.side==='long'?'lång ':'kort ')+x.symbol,'fct-act']);
    // In a phone's card each figure carries its name.
    assert.deepEqual(r.querySelectorAll('[data-label]').map(c=>c.getAttribute('data-label')),['Hävstång','Antal','Entry','Pris','Likv.','Marginal','Resultat']);
  }
  assert.deepEqual(a.positions.map(x=>x.reserve>0),[true,true,false],'two manual orders and a signal position');
  near(live.positions.reduce((s,x)=>s+x.margin+(x.reserve??0),0),live.marginUsed);
  // The table keeps its semantics where a phone's card layout changes its display.
  const table=panel(p,'positions').querySelector('table');
  assert.deepEqual([table.getAttribute('role'),table.querySelector('tbody').getAttribute('role'),row(p,a.positions[0].id).getAttribute('role'),
    row(p,a.positions[0].id).querySelector('th').getAttribute('role'),row(p,a.positions[0].id).querySelector('td').getAttribute('role')],['table','rowgroup','row','rowheader','cell']);
  // The levels as inputs, on Bybit's tick as their tags write them (ETH's 3 050,0, DOGE's 0,19500), a missing one empty
  // ("ingen"), and Ta bort only where there is a level.
  const [btc,eth,doge]=a.positions.map(x=>row(p,x.id));
  assert.deepEqual([field(btc,'sl').value,field(btc,'tp').value,field(eth,'sl').value,field(eth,'tp').value,field(doge,'sl').value,field(doge,'tp').value],
    ['59000','62500','3050,0','','0,19500','0,21100']);
  assert.deepEqual([field(eth,'tp').getAttribute('placeholder'),field(btc,'sl').getAttribute('aria-label'),field(eth,'tp').getAttribute('aria-label')],
    ['ingen','SL för lång BTC','TP för kort ETH']);
  assert.deepEqual([button(btc,'remove','tp').disabled,button(eth,'remove','tp').disabled,button(eth,'remove','sl').disabled],[false,true,false]);
  assert.deepEqual([button(btc,'save','sl').textContent,button(btc,'save','sl').getAttribute('aria-label'),button(btc,'remove','sl').getAttribute('aria-label')],
    ['Spara','Spara SL för lång BTC','Ta bort SL för lång BTC']);
  // Nothing typed yet: nothing to save.
  assert.ok(p.qa('[data-fct-save]').every(b=>b.disabled));
  // A price without a fresh quote reads '–', and the result too.
  f.st.quotes={...QUOTES,DOGE:quote(.2,T0-60*SEC)};p.term.update();
  assert.deepEqual([doge.querySelector('[data-fct-cell="price"]').textContent,doge.querySelector('[data-fct-cell="pnl"]').textContent],['–','–']);
  // No positions: said so, with where orders are placed.
  const none=mount(fakeRunner(build({open:false})).runner);
  assert.equal(shownText(panel(none,'positions')),NO_POSITIONS);
});

test('where Positioner is wider than its panel the result, the levels and Stäng stay at its right edge: the terminal holds each off it by the drawn widths of the columns after it',()=>{
  // A browser's widths for the head cells (the stylesheet keeps those three columns as wide as their content).
  const widths={'fct-act':67.25,'fct-levels':236.5};
  FakeElement.prototype.getBoundingClientRect=function(){
    const k=this.localName==='th'?Object.keys(widths).find(c=>this.classList.contains(c)):null,w=k?widths[k]:50;
    return {width:w,height:20,top:0,bottom:20,left:0,right:w};
  };
  try{
    const f=fakeRunner(build()),p=mount(f.runner),table=()=>panel(p,'positions').querySelector('table');
    assert.deepEqual(p.qa('[data-fct-panel="positions"] thead th').map(th=>th.getAttribute('class')),
      [null,null,null,'num','num','num','num','num','num','num fct-pnl','fct-levels','fct-act']);
    assert.equal(table().getAttribute('style'),'--fct-act:67.25px;--fct-lv:236.5px');
    // Stäng's column widens while its close runs ('Stänger…'): the levels and the result move with it at the next paint.
    widths['fct-act']=80;p.term.update();
    assert.equal(table().getAttribute('style'),'--fct-act:80px;--fct-lv:236.5px');
    // A table painted afresh (a position closed) is measured again.
    f.st.account=closePosition(f.st.account,f.st.account.positions[2].id,{price:.2,now:T0,reason:'manuell'});p.term.update();
    assert.equal(p.qa('[data-fct-row]').length,2);assert.equal(table().getAttribute('style'),'--fct-act:80px;--fct-lv:236.5px');
  }finally{delete FakeElement.prototype.getBoundingClientRect;}
});

test('the pinned columns are measured again when the browser resizes them between paints (a font arrives, a phone turns, a pointer changes)',()=>{
  const widths={'fct-act':67,'fct-levels':256},seen=[];
  FakeElement.prototype.getBoundingClientRect=function(){
    const k=this.localName==='th'?Object.keys(widths).find(c=>this.classList.contains(c)):null,w=k?widths[k]:50;
    return {width:w,height:20,top:0,bottom:20,left:0,right:w};
  };
  const Real=globalThis.ResizeObserver;
  globalThis.ResizeObserver=class{constructor(fn){this.fn=fn;this.on=new Set();seen.push(this);}observe(x){this.on.add(x);}unobserve(x){this.on.delete(x);}disconnect(){this.on.clear();}};
  try{
    const f=fakeRunner(build()),p=mount(f.runner),table=()=>panel(p,'positions').querySelector('table'),[watch]=seen;
    assert.equal(seen.length,1);
    assert.deepEqual([...watch.on].map(x=>x.getAttribute('class')),['fct-levels','fct-act'],'the head cells of the levels and Stäng');
    assert.equal(table().getAttribute('style'),'--fct-act:67px;--fct-lv:256px');
    // The levels narrow without a paint (a mouse instead of a finger: 92 px fields instead of 112).
    widths['fct-levels']=236;watch.fn([]);
    assert.equal(table().getAttribute('style'),'--fct-act:67px;--fct-lv:236px');
    // Hidden (another tab, or folded) they measure nothing, and the last widths stay for when they show again.
    widths['fct-levels']=0;watch.fn([]);
    assert.equal(table().getAttribute('style'),'--fct-act:67px;--fct-lv:236px');
    // A table painted afresh is watched instead of the old one; destroy() stops the watching.
    widths['fct-levels']=236;
    f.st.account=closePosition(f.st.account,f.st.account.positions[2].id,{price:.2,now:T0,reason:'manuell'});p.term.update();
    assert.ok([...watch.on].every(x=>table().contains(x))&&watch.on.size===2);
    p.term.destroy();assert.equal(watch.on.size,0);
  }finally{delete FakeElement.prototype.getBoundingClientRect;if(Real===undefined)delete globalThis.ResizeObserver;else globalThis.ResizeObserver=Real;}
  // Without a layout to measure (no getBoundingClientRect) nothing is set, and the stylesheet's defaults hold.
  const plain=mount(fakeRunner(build()).runner);
  assert.equal(panel(plain,'positions').querySelector('table').getAttribute('style'),null);
});

test('with no open position Positioner is one line that says where orders are placed, and over 900 px its box takes just that line, so the chart gets the height',()=>{
  const f=fakeRunner(build({open:false})),p=mount(f.runner),view=p.q('[data-fct-view]'),pos=panel(p,'positions');
  const fit=()=>view.classList.contains('is-fit');
  assert.deepEqual(pos.children.map(x=>x.localName+'.'+x.getAttribute('class')),['p.fct-empty']);
  // Where the ticket is: up to the right on a wide screen, at the top under the header on a tablet or a phone.
  assert.equal(shownText(pos),NO_POSITIONS);
  assert.equal(shownText(pos,false),NO_POSITIONS.replace('uppe till höger','längst upp'));
  assert.equal(fit(),true);
  // The other tabs keep the box's height, so their tables have their room.
  openTab(p,'history');assert.equal(fit(),false);
  openTab(p,'positions');assert.equal(fit(),true);
  // An order opens a position: the box takes its height again; the position closes: one line again.
  const o=openManual(f.st.account,{symbol:'SOL',side:'long',margin:10,leverage:10,quote:quote(150,T0),contract:limitsFor('SOL',T0),now:T0});
  assert.ok(o.ok,o.reason);
  f.st.account=o.account;p.term.update();
  assert.deepEqual([fit(),!!pos.querySelector('table')],[false,true]);
  f.st.account=closePosition(f.st.account,o.position.id,{price:150,now:T0,reason:'manuell'});p.term.update();
  assert.deepEqual([fit(),shownText(pos)],[true,NO_POSITIONS]);
  // Signed out: the reason, one line too.
  f.st.signedOut=true;p.term.update();
  assert.deepEqual([pos.textContent,fit()],['Logga in för att handla med AI Forecast-kontot',true]);
  // The stylesheet: over 900 px such a box is as tall as its content; each layout names its own place for the ticket.
  const css=source('../forecast-terminal.css');
  assert.match(css,/@media \(min-width:901px\)\{#aiForecast \.fct-view\.is-fit\{height:auto\}\}/);
  assert.match(css,/#aiForecast \.fct-narrow\{display:none\}/);
  assert.match(css,/@media \(max-width:900px\)\{#aiForecast \.fct-wide\{display:none\}#aiForecast \.fct-narrow\{display:inline\}\}/);
});

test('under the positions one short line, and how the figures add up in a Så räknas siffrorna disclosure that keeps its state and focus through repaints',()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner),pos=panel(p,'positions'),btc=a.positions[0];
  const set=levels=>{const x=setLevels(f.st.account,btc.id,levels,{quote:QUOTES.BTC,contract:limitsFor('BTC',T0),now:T0});assert.ok(x.ok,x.reason);f.st.account=x.account;};
  assert.deepEqual(pos.querySelectorAll('.fct-hint').map(x=>x.textContent),['Skriv en ny nivå och tryck Spara eller Enter; Esc ångrar.']);
  let d=pos.querySelector('details');
  assert.deepEqual([d.getAttribute('class'),d.hasAttribute('open'),d.children[0].localName,d.querySelector('summary').textContent],['fct-explain',false,'summary','Så räknas siffrorna']);
  // The same facts as the paragraphs it replaces.
  assert.deepEqual(d.querySelectorAll('p').map(x=>x.textContent),[
    'Nivån gäller från ändringen, och en signalposition vars nivå ändras blir manuell utan tidsstopp.',
    'Marginal är positionens marginal plus avgiften för stängning som Bybit reserverar med den; raderna summeras till Marginal i bruk.',
    'Resultat är vad positionen ger om den stängs nu, efter alla avgifter och funding; raderna summeras till Orealiserat resultat.',
    'Resultat sedan start = nettot av stängda affärer i Historik + Orealiserat resultat, och Kapital = startkapitalet + insatt − uttaget i Saldo + Resultat sedan start, '+
      'alltså Tillgängligt plus det positionerna lämnar tillbaka om de stängs nu.',
    'Varje belopp avrundas till hela cent, så summorna stämmer som de visas.']);
  // Opened from the keyboard (the summary is the browser's own control): a level change repaints the table, and the
  // disclosure stays open with focus on its summary.
  d.querySelector('summary').focus();d.setAttribute('open','');fire(d,'toggle');
  set({tp:62400});p.term.update();
  assert.notEqual(pos.querySelector('details'),d,'painted afresh');
  d=pos.querySelector('details');
  assert.deepEqual([d.hasAttribute('open'),p.doc.activeElement],[true,d.querySelector('summary')]);
  // Closed, it stays closed.
  d.removeAttribute('open');fire(d,'toggle');set({tp:62300});p.term.update();
  assert.equal(pos.querySelector('details').hasAttribute('open'),false);
  // Opening it scrolls the panel just enough to show what it holds, never past its summary (over 900 px the panel shows
  // a slice of its content): here the summary lies at 120–136 px of the panel and the facts reach 236, under its edge.
  d=pos.querySelector('details');
  Object.assign(pos,{scrollTop:0,clientHeight:150,getBoundingClientRect:()=>({top:500,bottom:650,height:150})});
  pos.querySelector('thead').getBoundingClientRect=()=>({top:500,bottom:528,height:28});
  d.getBoundingClientRect=()=>({top:620-pos.scrollTop,bottom:736-pos.scrollTop,height:116});
  d.querySelector('summary').getBoundingClientRect=()=>({top:620-pos.scrollTop,bottom:636-pos.scrollTop,height:16});
  d.setAttribute('open','');fire(d,'toggle');
  assert.equal(pos.scrollTop,86,'the facts\' bottom, 736 px, up to 650');
  pos.scrollTop=0;d.getBoundingClientRect=()=>({top:620-pos.scrollTop,bottom:900-pos.scrollTop,height:280});fire(d,'toggle');
  assert.equal(pos.scrollTop,92,'the summary just under the head');
});

test('a typed level\'s note writes the level as the chart\'s tag and the runner do: on PEPE with the nine decimals of Bybit\'s tick, not the ten of a price that size',()=>{
  const at=T0-5*SEC,o=openManual(newForecastAccount(T0-HOUR),{symbol:'PEPE',side:'short',margin:10,leverage:10,quote:quote(.0000043048,at),contract:limitsFor('PEPE',at),now:at});
  assert.ok(o.ok,o.reason);
  const f=fakeRunner(o.account);f.st.quotes={...QUOTES,PEPE:quote(.0000043048,T0)};
  const p=mount(f.runner),r=row(p,o.position.id),sl=field(r,'sl'),note=r.querySelector('[data-fct-note="sl"]');
  sl.focus();type(sl,'0,0000045');
  const preview=f.runner.quoteLevels(o.position.id,{sl:.0000045});
  assert.ok(preview.ok,preview.reasons.join(' · '));
  assert.equal(note.textContent,'Inte sparad: SL 0,000004500 · '+signedMoney(preview.slPnl));
  // The entry and the price beside it have the same nine.
  assert.deepEqual([r.querySelector('[data-label="Entry"]').textContent,r.querySelector('[data-fct-cell="price"]').textContent],
    [fixed(o.position.entry,9),fixed(.0000043048,9)]);
  // A target set (on the chart, say) at 0,0000041: its field reads as its tag, 0,000004100, not 0,0000041.
  key(sl,'Escape');
  const s=setLevels(f.st.account,o.position.id,{tp:.0000041},{quote:f.st.quotes.PEPE,contract:limitsFor('PEPE',T0),now:T0});
  assert.ok(s.ok,s.reason);f.st.account=s.account;p.term.update();
  assert.equal(field(row(p,o.position.id),'tp').value,'0,000004100');
});

test('a typed SL previews what saving it would do, survives every update with focus, and Enter saves it through runner.setLevels',async()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner),id=a.positions[0].id,btc=row(p,id);
  const sl=field(btc,'sl'),save=button(btc,'save','sl'),note=btc.querySelector('[data-fct-note="sl"]');
  sl.focus();type(sl,'59 500,15');
  const preview=previewLevels(a,id,{sl:59500.15},{quote:QUOTES.BTC,contract:limitsFor('BTC',T0),now:T0});
  assert.ok(preview.ok);assert.equal(preview.sl,59500.2,'rounded to Bybit\'s tick');
  // As the chart's drag tag says it, the rounded level and the result there after fees, after words that tell it from
  // the level the position has; the field's frame is dashed while it holds what is not saved.
  assert.deepEqual([save.disabled,note.textContent,note.getAttribute('class'),sl.getAttribute('class')],
    [false,'Inte sparad: SL 59\xa0500,2 · '+signedMoney(preview.slPnl),'fct-level-note','fct-input fct-draft']);
  assert.equal(sl.getAttribute('aria-describedby'),note.getAttribute('id'));
  // New prices: the row's figures change in place; the field, its text and the focus stay.
  f.st.quotes={...QUOTES,BTC:quote(60555,T0,60550)};p.term.update();
  assert.equal(btc.querySelector('[data-fct-cell="price"]').textContent,'60\xa0555,0');
  assert.deepEqual([row(p,id),field(row(p,id),'sl'),sl.value,p.doc.activeElement],[btc,sl,'59 500,15',sl]);
  // A level on the wrong side: the reason, in the warning colour, with the price as the row writes it; Spara stays, the
  // runner decides.
  type(sl,'61000');
  assert.match(note.textContent,/^SL för en lång position måste ligga under priset \(60\xa0555,0\) och över likvidationen \([\d\xa0]+,\d\)$/);
  assert.equal(note.getAttribute('class'),'fct-level-note bad');assert.equal(save.disabled,false);
  type(sl,'abc');assert.deepEqual([note.textContent,save.disabled,sl.getAttribute('class')],['Ange SL som ett pris över 0',true,'fct-input fct-draft']);
  type(sl,'');assert.deepEqual([note.textContent,save.disabled,sl.getAttribute('class')],['Ta bort tar bort SL',true,'fct-input fct-draft']);
  // The level as saved: nothing to save, no draft.
  type(sl,'59000');assert.deepEqual([note.textContent,save.disabled,sl.getAttribute('class')],['',true,'fct-input']);
  // Enter saves; meanwhile the terminal is busy and a second action is ignored.
  f.st.quotes={...QUOTES};
  type(sl,'59 500,15');
  const release=f.hold();
  const e=key(sl,'Enter');assert.equal(e.defaultPrevented,true);
  await settle();
  assert.deepEqual(f.calls,[['setLevels',id,{sl:59500.15}]]);
  assert.equal(p.q('[data-fct-msg]').textContent,'Sparar SL för lång BTC…');
  assert.equal(button(row(p,id),'save','sl').textContent,'Sparar…');
  assert.ok(p.qa('[data-fct-close],[data-fct-save]').every(busy));
  assert.equal(p.doc.activeElement.getAttribute('data-fct-key'),'level:'+id+'|sl','focus stays in the field');
  click(row(p,id).querySelector('[data-fct-close]'));key(field(row(p,id),'tp'),'Enter');
  await settle();assert.equal(f.calls.length,1);assert.deepEqual(p.asked,[]);
  release();await settle();
  // The runner's answer, shown and announced; the field shows the level as saved, and keeps focus.
  const pos=f.st.account.positions[0],text='Nya nivåer för lång BTC: SL '+priceText(59500.2)+', TP '+priceText(62500);
  assert.deepEqual([pos.sl,pos.tp,pos.levelsAt],[59500.2,62500,T0]);
  assert.deepEqual([p.q('[data-fct-msg]').textContent,p.q('[data-fct-msg]').classList.contains('bad'),p.said],
    [text,false,[text]]);
  const now=field(row(p,id),'sl');
  assert.deepEqual([now.value,p.doc.activeElement,button(row(p,id),'save','sl').disabled,row(p,id).querySelector('[data-fct-note="sl"]').textContent,now.getAttribute('class')],
    ['59500,2',now,true,'','fct-input']);
});

test('Spara saves a typed TP, Ta bort removes a level, Esc takes typing back, and a refusal keeps the typed value with the reason',async()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner),[btcId,ethId]=a.positions.map(x=>x.id);
  // ETH has no TP: type one and press Spara.
  const tp=field(row(p,ethId),'tp');
  type(tp,'2950');
  const save=button(row(p,ethId),'save','tp');
  save.focus();assert.equal(click(save),true);
  await settle();
  assert.deepEqual(f.calls.at(-1),['setLevels',ethId,{tp:2950}]);
  assert.equal(f.st.account.positions[1].tp,2950);
  assert.equal(p.q('[data-fct-msg]').textContent,'Nya nivåer för kort ETH: SL '+priceText(3050)+', TP '+priceText(2950));
  // Spara is disabled now that nothing is typed, so focus goes to the field instead of the page.
  assert.equal(p.doc.activeElement,field(row(p,ethId),'tp'));
  assert.equal(field(row(p,ethId),'tp').value,'2950,0');assert.equal(button(row(p,ethId),'remove','tp').disabled,false);
  // Ta bort: the level goes (null), and with it the button.
  const remove=button(row(p,btcId),'remove','tp');remove.focus();click(remove);
  await settle();
  assert.deepEqual(f.calls.at(-1),['setLevels',btcId,{tp:null}]);
  assert.equal(f.st.account.positions[0].tp,null);
  assert.deepEqual([field(row(p,btcId),'tp').value,button(row(p,btcId),'remove','tp').disabled,p.doc.activeElement],['',true,field(row(p,btcId),'tp')]);
  assert.equal(p.q('[data-fct-msg]').textContent,'Nya nivåer för lång BTC: SL '+priceText(59000)+', ingen TP');
  // Esc: what was typed goes, the saved level comes back.
  const sl=field(row(p,btcId),'sl');
  type(sl,'58000');assert.equal(button(row(p,btcId),'save','sl').disabled,false);
  assert.equal(key(sl,'Escape').defaultPrevented,true);
  assert.deepEqual([sl.value,button(row(p,btcId),'save','sl').disabled],['59000',true]);
  assert.equal(key(sl,'Escape').defaultPrevented,false,'nothing typed: Esc is not taken');
  // Refused by the runner: the reason, marked bad and announced, and the typed value stays to correct.
  type(sl,'61000');click(button(row(p,btcId),'save','sl'));
  await settle();
  const msg=p.q('[data-fct-msg]');
  assert.match(msg.textContent,/^SL för en lång position måste ligga under priset \(60\xa0412,3\) och över likvidationen \([\d\xa0,]+\)$/);
  assert.equal(msg.classList.contains('bad'),true);assert.equal(p.said.at(-1),msg.textContent);
  assert.deepEqual([field(row(p,btcId),'sl').value,f.st.account.positions[0].sl],['61000',59000]);
  // A runner that throws or answers nothing is said plainly.
  f.runner.setLevels=async()=>{throw Error('Nätverksfel');};
  type(field(row(p,btcId),'sl'),'58500');click(button(row(p,btcId),'save','sl'));await settle();
  assert.equal(p.q('[data-fct-msg]').textContent,'Kunde inte ändra SL och TP för BTC: Nätverksfel');
  f.runner.setLevels=async()=>undefined;
  click(button(row(p,btcId),'save','sl'));await settle();
  assert.equal(p.q('[data-fct-msg]').textContent,'Kunde inte ändra SL och TP för BTC: inget svar');
});

test('a level saved or removed for a signal position asks first, as the chart does, since the position then becomes manual without its time stop',async()=>{
  // A signal position and a manual one, both settled moments ago.
  const at=T0-5*SEC,barTime=Math.floor(T0/HOUR)*HOUR-HOUR;
  const signal={id:'s|u1|DOGE|1h|'+barTime+'|af-signal-v1',symbol:'DOGE',tf:'1h',side:'long',entry:.2,sl:.195,tp:.211,barTime,confirmedAt:barTime+HOUR};
  const o=openPosition(newForecastAccount(T0-HOUR),{signal,symbol:'DOGE',quote:quote(.20012,at),contract:limitsFor('DOGE',at),now:at,tfMs:HOUR,dataReliable:true});
  assert.ok(o.opened,o.reason);
  const m=openManual(o.account,{symbol:'BTC',side:'long',margin:20,leverage:10,quote:quote(60200,at),contract:limitsFor('BTC',at),now:at});
  assert.ok(m.ok,m.reason);
  const answers=[false,true],f=fakeRunner(m.account),p=mount(f.runner,{answer:()=>answers.shift()}),doge=o.position,r=()=>row(p,doge.id);
  const ask=what=>what+' för signalpositionen lång DOGE?\nPositionen hanteras då manuellt: inget tidsstopp och ingen stängning på en motsatt signal.';
  // A stop between the liquidation and the price, on Bybit's tick.
  const sl=Math.round((Math.max(doge.liq,doge.sl)+QUOTES.DOGE.price)/2*1e5)/1e5,typed=sl.toLocaleString('sv-SE',{useGrouping:false,maximumFractionDigits:5});
  // Spara, declined: nothing goes to the runner, and the typed value stays to be saved later.
  type(field(r(),'sl'),typed);click(button(r(),'save','sl'));await settle();
  assert.deepEqual([p.asked,f.calls,field(r(),'sl').value,p.q('[data-fct-msg]').textContent],[[ask('Flytta SL till '+fixed(sl,5))],[],typed,'']);
  // Ta bort, confirmed: the target goes, and the position is manual from then on.
  click(button(r(),'remove','tp'));await settle();
  assert.deepEqual([p.asked.at(-1),f.calls],[ask('Ta bort TP'),[['setLevels',doge.id,{tp:null}]]]);
  const now=()=>f.st.account.positions.find(x=>x.id===doge.id);
  assert.deepEqual([now().origin,now().deadline,now().tp],['manual',null,null]);
  // Manual now: Enter saves the stop typed before, unasked.
  key(field(r(),'sl'),'Enter');await settle();
  assert.deepEqual([p.asked.length,f.calls.at(-1),now().sl],[2,['setLevels',doge.id,{sl}],sl]);
  // A manual order's position is never asked.
  type(field(row(p,m.position.id),'sl'),'59500');click(button(row(p,m.position.id),'save','sl'));await settle();
  assert.deepEqual([p.asked.length,f.calls.at(-1)],[2,['setLevels',m.position.id,{sl:59500}]]);
});

test('Saldo: the free cash as the header shows it can be taken out, all of it, also when the fees left it with a fraction of a cent',async()=>{
  // DOGE at 10× with 10,07 $: the fees leave 89,8297… $ of free cash, shown as 89,83 $.
  const at=T0-5*SEC,o=openManual(newForecastAccount(T0-HOUR),{symbol:'DOGE',side:'long',margin:10.07,leverage:10,quote:quote(.2,at),contract:limitsFor('DOGE',at),now:at});
  assert.ok(o.ok,o.reason);
  const f=fakeRunner(o.account),p=mount(f.runner),cash=o.account.cash;
  assert.ok(cash<89.83);assert.equal(val(p,'cash'),'89,83\xa0$');
  openTab(p,'balance');
  const amount=p.q('[data-fct-amount]'),out=p.q('[data-fct-transfer="out"]'),preview=()=>p.q('[data-fct-amount-preview]').querySelectorAll('li').map(li=>li.textContent);
  // A cent more is refused, with the figure the header shows.
  type(amount,'89,84');
  assert.equal(preview()[1],'Ta ut: Det går bara att ta ut tillgängligt saldo (högst 89,83\xa0$), inte marginalen i öppna positioner');
  assert.equal(out.disabled,true);
  type(amount,'89,83');
  assert.deepEqual(preview(),['Nytt tillgängligt saldo efter insättning: '+money(cash+89.83),'Nytt tillgängligt saldo efter uttag: 0,00\xa0$']);
  click(out);await settle();
  assert.deepEqual(f.calls,[['transfer',{kind:'out',amount:89.83}]]);
  assert.deepEqual([f.st.account.cash,val(p,'cash'),p.q('[data-fct-msg]').textContent],[0,'0,00\xa0$','Tog ut 89,83\xa0$ · tillgängligt 0,00\xa0$']);
  assert.deepEqual(f.st.account.positions,o.account.positions,'the margin stays');
});

test('Stäng asks first, closes through runner.closePosition, and hands focus to the panel when the row is gone',async()=>{
  const a=build(),f=fakeRunner(a),answers=[false,true],p=mount(f.runner,{answer:()=>answers.shift()}),[btcId]=a.positions.map(x=>x.id);
  const live=f.runner.live().positions[0];
  let close=row(p,btcId).querySelector('[data-fct-close]');
  close.focus();click(close);await settle();
  assert.deepEqual(p.asked,['Stäng lång BTC till marknadspris nu? Resultat just nu: '+signedMoney(live.pnl)+'. Hela positionen stängs i demokontot.']);
  assert.deepEqual(f.calls,[],'declined');
  const release=f.hold();
  click(close);await settle();
  assert.deepEqual(f.calls,[['closePosition',btcId]]);
  close=row(p,btcId).querySelector('[data-fct-close]');
  assert.deepEqual([close.textContent,close.getAttribute('aria-disabled'),p.doc.activeElement,p.q('[data-fct-msg]').textContent],['Stänger…','true',close,'Stänger lång BTC…']);
  release();await settle();
  assert.equal(row(p,btcId),undefined);
  assert.equal(p.doc.activeElement,panel(p,'positions'),'focus to the panel, not the page');
  const trade=f.st.account.trades.at(-1);
  assert.equal(p.q('[data-fct-msg]').textContent,bound('Stängde lång BTC (manuell) till '+priceText(trade.exit)+' · '+(trade.pnl<0?'−':'+')+dollars(Math.abs(trade.pnl))));
  assert.equal(p.said.length,1);
  assert.equal(p.q('[data-fct-count]').textContent,'2');
  // A confirm that answers with a promise works the same.
  const g=fakeRunner(build()),q=mount(g.runner,{answer:()=>Promise.resolve(true)});
  click(q.qa('[data-fct-close]')[1]);await settle();
  assert.deepEqual(g.calls,[['closePosition',g.st.account.trades.at(-1).id]]);
});

test('a control disabled while it has keyboard focus hands focus to its own field, never to the page: Spara after a save or a change on the chart, Saldo\'s buttons',async()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner),eth=a.positions[1],r=()=>row(p,eth.id),tp=()=>field(r(),'tp');
  const set=levels=>{const x=setLevels(f.st.account,eth.id,levels,{quote:QUOTES.ETH,contract:limitsFor('ETH',T0),now:T0});assert.ok(x.ok,x.reason);f.st.account=x.account;};
  // A TP typed and Spara clicked: once saved nothing is left to save and Spara is disabled. Chrome still names it as
  // focused until its next frame and then drops focus to the page; focus goes to the row's TP field instead.
  type(tp(),'2950');let save=button(r(),'save','tp');save.focus();click(save);await settle();
  assert.equal(f.st.account.positions[1].tp,2950);
  assert.deepEqual([button(r(),'save','tp').disabled,p.doc.activeElement],[true,tp()]);
  // Spara reached with Tab after typing, and the TP dragged on the chart meanwhile: the typing goes, Spara is disabled
  // with no action of the terminal's running, and focus goes to the field.
  type(tp(),'2940');save=button(r(),'save','tp');save.focus();assert.equal(save.disabled,false);
  set({tp:2945});p.term.update();
  assert.deepEqual([button(r(),'save','tp').disabled,p.doc.activeElement,tp().value],[true,tp(),'2945,0']);
  await settle();assert.equal(p.doc.activeElement,tp(),'still there after the browser\'s next frame');
  // Saldo: Ta ut books, the amount field empties, and both its buttons are disabled: focus goes to the amount.
  openTab(p,'balance');
  const amount=p.q('[data-fct-amount]'),out=p.q('[data-fct-transfer="out"]');
  type(amount,'5');out.focus();click(out);await settle();
  assert.deepEqual([f.calls.at(-1),amount.value,out.disabled,p.doc.activeElement],[['transfer',{kind:'out',amount:5}],'',true,amount]);
  // Sätt tillgängligt, focused, is disabled when another tab sets that very amount: focus goes to its field.
  const free=p.q('[data-fct-free]'),setButton=p.q('[data-fct-set-free]');
  type(free,'200');setButton.focus();assert.equal(setButton.disabled,false);
  f.st.account=setFree(f.st.account,200,T0);p.term.update();
  assert.deepEqual([setButton.disabled,p.doc.activeElement],[true,free]);
  await settle();assert.equal(p.doc.activeElement,free);
});

test('a Stäng the runner refuses keeps the position: the reason shows in the warning colour and is announced, and Stäng works again',async()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner),[btcId]=a.positions.map(x=>x.id),close=f.runner.closePosition;
  f.runner.closePosition=async id=>{f.calls.push(['closePosition',id]);return {ok:false,text:'Kunde inte stänga BTC: Proxy nere',trade:null};};
  let b=row(p,btcId).querySelector('[data-fct-close]');
  b.focus();click(b);await settle();
  const msg=p.q('[data-fct-msg]');
  assert.deepEqual([f.calls,p.asked.length],[[['closePosition',btcId]],1]);
  assert.deepEqual([msg.textContent,msg.classList.contains('bad'),msg.hidden,p.said],['Kunde inte stänga BTC: Proxy nere',true,false,['Kunde inte stänga BTC: Proxy nere']]);
  // The row stays, its Stäng usable again and still focused.
  b=row(p,btcId).querySelector('[data-fct-close]');
  assert.deepEqual([b.textContent,b.getAttribute('aria-disabled'),f.st.account.positions.length,p.q('[data-fct-count]').textContent],['Stäng',null,3,'3']);
  assert.equal(p.doc.activeElement,b);
  assert.ok(!p.qa('[data-fct-close],[data-fct-save]').some(x=>x.getAttribute('aria-disabled')==='true'),'nothing is left busy');
  // A runner that throws is said plainly.
  f.runner.closePosition=async()=>{throw Error('Nätverksfel');};
  click(b);await settle();
  assert.deepEqual([msg.textContent,msg.classList.contains('bad'),p.said.at(-1)],['Kunde inte stänga BTC: Nätverksfel',true,'Kunde inte stänga BTC: Nätverksfel']);
  // Stäng once more with the runner able: closed.
  f.runner.closePosition=close;
  click(row(p,btcId).querySelector('[data-fct-close]'));await settle();
  assert.equal(row(p,btcId),undefined);assert.match(msg.textContent,/^Stängde lång BTC \(manuell\) till /);assert.equal(msg.classList.contains('bad'),false);
  assert.equal(f.st.account.trades.at(-1).id,btcId);
});

test('a refusal on the spot is announced like a runner\'s answer: a level that is no price, a position closed meanwhile, an amount the ledger refuses',async()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner),[btcId,ethId]=a.positions.map(x=>x.id),msg=p.q('[data-fct-msg]');
  // abc in TP and Enter: nothing goes to the runner; the reason shows in the warning colour and is told to screen readers.
  const tp=field(row(p,ethId),'tp');type(tp,'abc');
  assert.equal(key(tp,'Enter').defaultPrevented,true);await settle();
  assert.deepEqual([msg.textContent,msg.classList.contains('bad'),msg.hidden,p.said,f.calls],['Ange TP som ett pris över 0',true,false,['Ange TP som ett pris över 0'],[]]);
  // An emptied SL and Enter: the same (Ta bort removes a level).
  const sl=field(row(p,btcId),'sl');type(sl,'');key(sl,'Enter');await settle();
  assert.deepEqual([p.said.at(-1),f.calls],['Ange SL som ett pris över 0',[]]);
  // Positions another tab closed meanwhile (no repaint yet): Spara, Ta bort and Stäng tell how each closed instead of
  // acting, ask nothing, and the stale row goes.
  const staleSl=field(row(p,btcId),'sl');
  f.st.account=closePosition(f.st.account,btcId,{price:60412.3,now:T0,reason:'manuell'});
  key(staleSl,'Enter');await settle();
  const told=id=>{const t=f.st.account.trades.find(x=>x.id===id);
    return 'Stängde '+(t.side==='long'?'lång ':'kort ')+t.symbol+(t.origin==='manual'?' (manuell)':'')+' '+klock(t.closedAt,T0)+' till '+fixed(t.exit,{BTC:1,ETH:2,DOGE:5}[t.symbol])+' · '+signedMoney(t.pnl);};
  assert.deepEqual([p.said.at(-1),msg.textContent,msg.classList.contains('bad'),row(p,btcId)],[told(btcId),told(btcId),false,undefined]);
  const staleRemove=button(row(p,ethId),'remove','sl');
  f.st.account=closePosition(f.st.account,ethId,{price:2987.45,now:T0,reason:'manuell'});
  click(staleRemove);await settle();
  assert.deepEqual([p.said.length,p.said.at(-1),row(p,ethId)],[4,told(ethId),undefined]);
  const dogeId=a.positions[2].id,staleClose=row(p,dogeId).querySelector('[data-fct-close]');
  f.st.account=closePosition(f.st.account,dogeId,{price:.20101,now:T0,reason:'manuell'});
  click(staleClose);await settle();
  assert.deepEqual([p.said.length,p.said.at(-1),row(p,dogeId),p.asked,f.calls],[5,told(dogeId),undefined,[],[]]);
  assert.equal(told(dogeId),'Stängde lång DOGE kl.'+NB+'10:10 till '+fixed(.20101*(1-ACCOUNT.slip),5)+' · '+signedMoney(f.st.account.trades.at(-1).pnl),'a signal position is not marked manual');
  // Saldo: another tab took the free cash after the preview allowed a withdrawal; Ta ut says why.
  openTab(p,'balance');type(p.q('[data-fct-amount]'),'10');
  const out=p.q('[data-fct-transfer="out"]');assert.equal(out.disabled,false);
  f.st.account=withdraw(f.st.account,Math.round(f.st.account.cash*100)/100,T0);
  click(out);await settle();
  assert.match(p.said.at(-1),/^Det går bara att ta ut tillgängligt saldo \(högst 0,00\xa0\$\), inte marginalen i öppna positioner$/);
  assert.deepEqual([msg.textContent,msg.classList.contains('bad')],[p.said.at(-1),true]);
  // Sätt tillgängligt with Enter, after another tab set the same amount: already so.
  type(p.q('[data-fct-free]'),'300');
  f.st.account=setFree(f.st.account,300,T0);
  key(p.q('[data-fct-free]'),'Enter');await settle();
  assert.equal(p.said.at(-1),'Tillgängligt saldo är redan 300,00\xa0$');
  assert.deepEqual(f.calls,[],'nothing went to the runner');
});

test('a manual position\'s Marginal is Bybit\'s position margin, its margin and the fee to close Bybit reserves with it, so the rows add up to Marginal i bruk',()=>{
  const at=T0-5*SEC,r=openManual(newForecastAccount(T0-HOUR),{symbol:'BTC',side:'long',margin:10,leverage:100,quote:quote(60200,at),contract:limitsFor('BTC',at),now:at});
  assert.ok(r.ok,r.reason);
  const p=mount(fakeRunner(r.account).runner),x=r.position,cell=row(p,x.id).querySelector('[data-fct-cell="margin"]');
  assert.ok(x.reserve>.5,'at 100× the reserved fee to close is a visible part');
  assert.deepEqual([cell.textContent,val(p,'margin')],[money(x.margin+x.reserve),money(x.margin+x.reserve)]);
  assert.notEqual(cell.textContent,money(x.margin));
  assert.equal(cell.getAttribute('title'),'Marginal '+money(x.margin)+' + reserverad avgift för stängning '+money(x.reserve));
  // Så räknas siffrorna, under the table, says what the figures are and how they add up to the header's.
  const hint=panel(p,'positions').querySelector('details.fct-explain').textContent;
  assert.ok(hint.includes('Marginal är positionens marginal plus avgiften för stängning som Bybit reserverar med den; raderna summeras till Marginal i bruk.'));
  assert.ok(hint.includes('Resultat är vad positionen ger om den stängs nu, efter alla avgifter och funding; raderna summeras till Orealiserat resultat.'));
  assert.ok(hint.includes('Resultat sedan start = nettot av stängda affärer i Historik + Orealiserat resultat, och Kapital = startkapitalet + insatt − uttaget i Saldo + '+
    'Resultat sedan start, alltså Tillgängligt plus det positionerna lämnar tillbaka om de stängs nu.'));
  assert.ok(hint.includes('Varje belopp avrundas till hela cent, så summorna stämmer som de visas.'));
  assert.ok(!hint.includes('Kapital = Tillgängligt'),'no longer the sum the header shows');
});

test('every sum the terminal states holds to the cent as shown: the rows\' Marginal and Resultat, Historik\'s netto plus Orealiserat resultat, Saldo\'s start and transfers plus that',()=>{
  // Three positions whose Marginal read 14,23 + 9,87 + 7,64 = 31,74 $ in their rows, though together they hold 31,748… $,
  // after three closed trades, 50 $ in and 20 $ out.
  const at=T0-5*SEC;let a=build({open:false});
  for(const [symbol,side,margin,leverage,price] of [['ETH','short',15,25,2700.13],['SOL','long',10,20,150.27],['XRP','long',7.5,35,.6024]]){
    const r=openManual(a,{symbol,side,margin,leverage,quote:quote(price,at),contract:limitsFor(symbol,at),now:at});assert.ok(r.ok,r.reason);a=r.account;
  }
  const f=fakeRunner(a),p=mount(f.runner);
  const cents=x=>Math.round(Number(x.replace(/[^\d,−+-]/g,'').replace('−','-').replace(',','.'))*100),sum=list=>list.reduce((s,x)=>s+cents(x.textContent),0);
  const margins=()=>p.qa('[data-fct-cell="margin"]'),results=()=>p.qa('[data-fct-pnl]');
  f.st.quotes={...QUOTES,ETH:quote(2701.4,T0),SOL:quote(150.3,T0),XRP:quote(.6026,T0)};p.term.update();
  // Positioner's rows add up to Marginal i bruk, as the hint under them says; unrounded, the positions hold a little more.
  assert.deepEqual(margins().map(x=>x.textContent),['14,23\xa0$','9,87\xa0$','7,64\xa0$']);
  assert.deepEqual([val(p,'margin'),money(f.runner.live().marginUsed)],['31,74\xa0$','31,75\xa0$']);
  // Historik's netto and Saldo's start, deposits and withdrawals, as they are shown.
  openTab(p,'history');
  const netto=/netto ([+−]?[\d,]+\xa0\$)/.exec(panel(p,'history').querySelector('.fct-summary').textContent)[1];
  openTab(p,'balance');
  const [start,inn,out]=/^Startkapital ([\d,]+\xa0\$) · insatt ([\d,]+\xa0\$) · uttaget ([\d,]+\xa0\$)/.exec(p.q('[data-fct-bal-line]').textContent).slice(1);
  assert.deepEqual([start,inn,out],['100,00\xa0$','50,00\xa0$','20,00\xa0$']);
  openTab(p,'positions');
  // Whatever the prices: Resultat sedan start = netto + Orealiserat resultat and Kapital = start + insatt − uttaget +
  // Resultat sedan start, to the cent, each total within a cent or two of the unrounded account.
  let apart=0;
  for(let k=0;k<300;k++){
    const eth=2690+k*.137,sol=150.1+k*.0093,xrp=Math.round((.6+k*.0000131)*1e4)/1e4;
    f.st.quotes={...QUOTES,ETH:quote(eth,T0,eth+.05),SOL:quote(sol,T0,sol-.01),XRP:quote(xrp,T0)};p.term.update();
    const l=f.runner.live(),[equity,,margin,open,result]=figures(p).map(cents);
    assert.deepEqual([margin,open,result,equity],[sum(margins()),sum(results()),cents(netto)+open,cents(start)+cents(inn)-cents(out)+result],'ETH '+eth);
    assert.ok(Math.abs(result-l.result*100)<=2&&Math.abs(equity-l.equity*100)<=3,figures(p).join(' | '));
    if(result!==Math.round(l.result*100))apart++;
  }
  // Rounded once, the unrounded result disagrees with its parts in many of these (as the header read before).
  assert.ok(apart>=30,apart+' of 300');
});

test('terminalFigures: nothing without an account; the money held and the free cash without prices; Kapital and both results once every position has its price',()=>{
  const {terminalFigures}=terminalModule,a=build(),fig=terminalFigures(a,accountLive(a,QUOTES,T0));
  assert.deepEqual(terminalFigures(null,null),{equity:null,cash:null,margin:null,open:null,result:null});
  // In whole cents, each.
  for(const [k,v] of Object.entries(fig))assert.ok(typeof v==='number'&&Math.abs(v*100-Math.round(v*100))<1e-9,k+' '+v);
  assert.equal(fig.cash,Math.round(a.cash*100)/100);
  // A price gone stale, or no live figures at all: the money held and the free cash still show; Kapital and the results wait.
  const waiting={...fig,equity:null,open:null,result:null};
  assert.deepEqual(terminalFigures(a,accountLive(a,{...QUOTES,ETH:quote(2987.45,T0-60*SEC)},T0)),waiting);
  assert.deepEqual(terminalFigures(a,null),waiting);
  // No positions: Kapital is the start and the net transfers plus the closed trades' net, each as shown.
  const flat=build({open:false}),net=Math.round(accountStats(flat).net*100);
  assert.deepEqual(terminalFigures(flat,accountLive(flat,{},T0)),{equity:(10000+5000-2000+net)/100,cash:Math.round(flat.cash*100)/100,margin:0,open:0,result:net/100});
});

test('a position that closes without the terminal asking is told on every tab and to screen readers, once: its SL, its TP, a liquidation, Stäng in another tab',async()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner),[btc,eth,doge]=a.positions,msg=p.q('[data-fct-msg]');
  // A level saved for BTC: its answer stands in the message line.
  type(field(row(p,btc.id),'tp'),'62000');key(field(row(p,btc.id),'tp'),'Enter');await settle();
  assert.match(msg.textContent,/^Nya nivåer för lång BTC/);
  // BTC's stop fires at the next price (the runner's live check): the row goes, and instead of speaking of a position that
  // is gone the line tells how it closed, as news (neither a success nor an error).
  const at=T0+SEC;
  f.st.account=checkQuote(f.st.account,btc.id,quote(58990,at),at);p.term.update();
  const t=f.st.account.trades.at(-1),text='Stopp: lång BTC (manuell) stängdes '+klock(at,T0)+' till '+fixed(t.exit,1)+' · '+signedMoney(t.pnl);
  assert.deepEqual([t.id,t.reason],[btc.id,'stopp']);
  assert.deepEqual([msg.textContent,msg.hidden,msg.classList.contains('bad'),msg.classList.contains('note'),row(p,btc.id),p.said.at(-1)],[text,false,false,true,undefined,text]);
  // Every tab shows it, and screen readers hear it once however often the terminal paints.
  const said=p.said.length;
  for(const name of TERMINAL_TABS){openTab(p,name);p.term.update();assert.deepEqual([msg.hidden,msg.textContent],[false,text],name);}
  assert.equal(p.said.length,said);
  openTab(p,'positions');
  // A liquidation and a target at the same read: both, in one line, in the order of the positions.
  f.st.account=checkQuote(f.st.account,eth.id,quote(eth.liq+5,at),at);
  f.st.account=checkQuote(f.st.account,doge.id,quote(.2115,at),at);
  p.term.update();
  const [liq,goal]=f.st.account.trades.slice(-2);
  assert.deepEqual([liq.reason,goal.reason],['likvidation','mål']);
  assert.equal(msg.textContent,'Likvidation: kort ETH (manuell) stängdes '+klock(at,T0)+' till '+fixed(liq.exit,2)+' · '+signedMoney(liq.pnl)+'; Mål: lång DOGE stängdes '+klock(at,T0)+' till '+fixed(goal.exit,5)+' · '+signedMoney(goal.pnl));
  assert.deepEqual([p.said.length,p.said.at(-1),p.q('[data-fct-count]').textContent,shownText(panel(p,'positions'))],[said+1,msg.textContent,'',NO_POSITIONS]);
  // Stäng in another tab.
  const g=fakeRunner(build()),q=mount(g.runner),other=g.st.account.positions[1];
  g.st.account=closePosition(g.st.account,other.id,{price:2987.45,now:T0,reason:'manuell'});q.term.update();
  const c=g.st.account.trades.at(-1),closed='Stängde kort ETH (manuell) '+klock(T0,T0)+' till '+fixed(c.exit,2)+' · '+signedMoney(c.pnl);
  assert.deepEqual([q.q('[data-fct-msg]').textContent,q.said],[closed,[closed]]);
  // This terminal's own Stäng is told by the runner's answer alone, also when the terminal paints while it closes.
  const close=g.runner.closePosition;
  g.runner.closePosition=async id=>{const r=await close(id);q.term.update();return r;};
  click(row(q,g.st.account.positions[0].id).querySelector('[data-fct-close]'));await settle();
  assert.deepEqual([q.said.length,q.said.at(-1).slice(0,16)],[2,'Stängde lång BTC']);
  // Another account (a reset) is no news about the last one's positions.
  g.st.account=newForecastAccount(T0);q.term.update();
  assert.deepEqual([q.q('[data-fct-msg]').textContent,q.said.length],['',2]);
});

test('such a close says when it closed (kl. 10:10, after the date when that is not today) and goes at the account\'s next change or after a short while; Händelser and Historik keep it',async()=>{
  let now=T0;
  const a=build(),f=fakeRunner(a),p=mount(f.runner,{now:()=>now}),[btc,eth,doge]=a.positions,msg=p.q('[data-fct-msg]'),wait=terminalModule.TERMINAL_NOTICE_MS;
  assert.ok(wait>=10*SEC&&wait<=60*SEC,'a short while: '+wait);
  // BTC's stop fires at 10:10:01; the line says when, so it never reads as fresh news while it stays.
  const at=T0+SEC;
  f.st.account=checkQuote(f.st.account,btc.id,quote(58990,at),at);now=at;p.term.update();
  const t=f.st.account.trades.at(-1),text='Stopp: lång BTC (manuell) stängdes kl.'+NB+'10:10 till '+fixed(t.exit,1)+' · '+signedMoney(t.pnl);
  assert.equal(klock(at,T0),'kl.'+NB+'10:10');
  assert.deepEqual([msg.textContent,msg.hidden,msg.classList.contains('note'),p.said.at(-1)],[text,false,true,text]);
  // New prices, repaints, another tab of the terminal, almost the whole while: it stays.
  now=at+wait-SEC;f.st.quotes={...QUOTES,ETH:quote(2990,T0)};p.term.update();openTab(p,'history');openTab(p,'positions');p.term.update();
  assert.deepEqual([msg.textContent,msg.hidden],[text,false]);
  // Then it goes; Händelser and Historik keep the close.
  now=at+wait;p.term.update();
  assert.deepEqual([msg.textContent,msg.hidden,p.said.length],['',true,1]);
  openTab(p,'events');
  assert.equal(panel(p,'events').querySelector('.fct-log li span').textContent,bound(f.st.account.log.at(-1).text));
  assert.match(f.st.account.log.at(-1).text,/^Stopp: lång BTC/);
  openTab(p,'history');
  const top=panel(p,'history').querySelector('tbody tr');
  assert.deepEqual([top.children[1].textContent,top.children.at(-1).textContent],['BTC','Stopp']);
  openTab(p,'positions');
  // The next close stays until the account changes again: ETH's stop moved on the chart (its new SL in the row).
  f.st.account=checkQuote(f.st.account,doge.id,quote(.2115,at),at);p.term.update();
  assert.match(msg.textContent,/^Mål: lång DOGE stängdes kl.\xa010:10 till /);
  const moved=setLevels(f.st.account,eth.id,{sl:3040},{quote:QUOTES.ETH,contract:limitsFor('ETH',T0),now:T0});assert.ok(moved.ok,moved.reason);
  f.st.account=moved.account;p.term.update();
  assert.deepEqual([msg.textContent,msg.hidden,field(row(p,eth.id),'sl').value],['',true,'3040,0']);
  // An order from the ticket: the close is no longer the news either.
  f.st.account=checkQuote(f.st.account,eth.id,quote(eth.liq+5,at),at);p.term.update();
  assert.match(msg.textContent,/^Likvidation: kort ETH \(manuell\) stängdes kl.\xa010:10 till /);
  const o=openManual(f.st.account,{symbol:'SOL',side:'long',margin:10,leverage:10,quote:quote(150,T0),contract:limitsFor('SOL',T0),now:T0});
  assert.ok(o.ok,o.reason);
  f.st.account=o.account;p.term.update();
  assert.deepEqual([msg.textContent,msg.hidden,p.said.length],['',true,3]);
  // Money moved in another tab: the same.
  f.st.account=closePosition(f.st.account,o.position.id,{price:150.2,now:T0,reason:'manuell'});p.term.update();
  assert.match(msg.textContent,/^Stängde lång SOL \(manuell\) kl.\xa010:10 till /);
  f.st.account=deposit(f.st.account,5,T0);p.term.update();
  assert.deepEqual([msg.textContent,msg.hidden],['',true]);
  // A close and an opening in one read: the close is told.
  const o2=openManual(f.st.account,{symbol:'XRP',side:'long',margin:10,leverage:10,quote:quote(.6,T0),contract:limitsFor('XRP',T0),now:T0});
  assert.ok(o2.ok,o2.reason);
  const o3=openManual(o2.account,{symbol:'DOGE',side:'long',margin:10,leverage:10,quote:quote(.2,T0),contract:limitsFor('DOGE',T0),now:T0});
  assert.ok(o3.ok,o3.reason);
  f.st.account=o2.account;p.term.update();
  f.st.account=closePosition(o3.account,o2.position.id,{price:.6,now:T0,reason:'manuell'});p.term.update();
  assert.match(msg.textContent,/^Stängde lång XRP \(manuell\) kl.\xa010:10 till /);assert.equal(msg.hidden,false);
  // The terminal's own next action has its say instead.
  type(field(row(p,o3.position.id),'sl'),'abc');key(field(row(p,o3.position.id),'sl'),'Enter');await settle();
  assert.deepEqual([msg.textContent,msg.classList.contains('note'),msg.classList.contains('bad')],['Ange SL som ett pris över 0',false,true]);
  // Read the next day (the browser slept): the date comes with the time.
  const g=fakeRunner(build()),q=mount(g.runner,{now:()=>T0+30*HOUR}),dg=g.st.account.positions[2];
  g.st.account=checkQuote(g.st.account,dg.id,quote(.2115,at),at);q.term.update();
  const goal=g.st.account.trades.at(-1);
  assert.equal(goal.reason,'mål');
  assert.equal(q.q('[data-fct-msg]').textContent,'Mål: lång DOGE stängdes 6 okt kl.'+NB+'10:10 till '+fixed(goal.exit,5)+' · '+signedMoney(goal.pnl));
});

test('the answer line goes when the account changes another way, so it never contradicts the rows and figures under it: levels moved on the chart, an order, money moved elsewhere',async()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner),[btc]=a.positions,msg=p.q('[data-fct-msg]'),sl=()=>field(row(p,btc.id),'sl');
  // An SL saved in Positioner: its answer stands while only the prices change, through repaints and tab switches.
  type(sl(),'59500');key(sl(),'Enter');await settle();
  const saved='Nya nivåer för lång BTC: SL '+priceText(59500)+', TP '+priceText(62500);
  assert.equal(msg.textContent,saved);
  f.st.quotes={...QUOTES,BTC:quote(60480,T0,60477)};p.term.update();openTab(p,'events');openTab(p,'positions');p.term.update();
  assert.deepEqual([msg.textContent,msg.hidden],[saved,false]);
  // The SL is then dragged on the chart (the runner's setLevels; the view's onChange paints the terminal): the answer
  // would name an SL the row no longer has, so it goes.
  const moved=setLevels(f.st.account,btc.id,{sl:59400},{quote:QUOTES.BTC,contract:limitsFor('BTC',T0),now:T0});assert.ok(moved.ok,moved.reason);
  f.st.account=moved.account;p.term.update();
  assert.deepEqual([msg.textContent,msg.hidden,sl().value],['',true,'59400']);
  // Saldo: a deposit's answer names the free cash after it.
  openTab(p,'balance');type(p.q('[data-fct-amount]'),'25');click(p.q('[data-fct-transfer="in"]'));await settle();
  assert.equal(msg.textContent,bound('Satte in 25,00 $ · tillgängligt '+dollars(f.st.account.cash)));
  // An order from the ticket takes from that cash: the answer goes, and the line above the forms tells the cash as it is.
  const o=openManual(f.st.account,{symbol:'SOL',side:'long',margin:10,leverage:10,quote:quote(150,T0),contract:limitsFor('SOL',T0),now:T0});
  assert.ok(o.ok,o.reason);
  f.st.account=o.account;p.term.update();
  assert.deepEqual([msg.textContent,msg.hidden],['',true]);
  assert.ok(p.q('[data-fct-bal-line]').textContent.endsWith('tillgängligt '+money(f.st.account.cash)));
  // A withdrawal's answer goes when another tab deposits.
  type(p.q('[data-fct-amount]'),'5');click(p.q('[data-fct-transfer="out"]'));await settle();
  assert.match(msg.textContent,/^Tog ut 5,00\xa0\$ · tillgängligt /);
  f.st.account=deposit(f.st.account,10,T0);p.term.update();
  assert.deepEqual([msg.textContent,msg.hidden],['',true]);
  // An answer kept for its tab while another is open goes too: it is not there on return.
  type(p.q('[data-fct-free]'),'300');key(p.q('[data-fct-free]'),'Enter');await settle();
  assert.match(msg.textContent,/^Satte in /);
  openTab(p,'positions');assert.equal(msg.hidden,true);
  f.st.account=withdraw(f.st.account,1,T0);p.term.update();openTab(p,'balance');
  assert.deepEqual([msg.textContent,msg.hidden],['',true]);
  // A refusal on the spot goes the same way.
  openTab(p,'positions');type(sl(),'abc');key(sl(),'Enter');await settle();
  assert.equal(msg.textContent,'Ange SL som ett pris över 0');
  f.st.account=setLevels(f.st.account,btc.id,{tp:62400},{quote:QUOTES.BTC,contract:limitsFor('BTC',T0),now:T0}).account;p.term.update();
  assert.deepEqual([msg.textContent,msg.hidden],['',true]);
  // Nothing of this is announced: the rows and the figures tell the change.
  assert.deepEqual(p.said.map(x=>x.slice(0,8)),['Nya nivå','Satte in','Tog ut 5','Satte in','Ange SL ']);
});

test('a level typed and not saved is marked so, and goes when that level is changed another way: dragged on the chart, removed there, set in another tab',async()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner),eth=a.positions[1],id=eth.id;
  const r=()=>row(p,id),tp=()=>field(r(),'tp'),note=()=>r().querySelector('[data-fct-note="tp"]'),msg=p.q('[data-fct-msg]');
  // The chart's drag commits through the runner, and the view's onChange paints the terminal: here, a level set straight
  // in the account and an update().
  const set=levels=>{const x=setLevels(f.st.account,id,levels,{quote:f.st.quotes.ETH,contract:limitsFor('ETH',T0),now:T0});assert.ok(x.ok,x.reason);f.st.account=x.account;};
  // ETH (short) has no TP. 2950 typed and left unsaved: a dashed frame, a note that says so, and Spara.
  assert.equal(eth.tp,null);
  type(tp(),'2950');
  const preview=previewLevels(f.st.account,id,{tp:2950},{quote:QUOTES.ETH,contract:limitsFor('ETH',T0),now:T0});
  assert.deepEqual([tp().getAttribute('class'),note().textContent,button(r(),'save','tp').disabled],
    ['fct-input fct-draft','Inte sparad: TP '+fixed(2950,1)+' · '+signedMoney(preview.tpPnl),false]);
  // The TP is dragged on the chart and dropped at 2940: the field shows it as saved, nothing is left to save, and Enter
  // or Spara cannot put the typed 2950 over it.
  set({tp:2940});p.term.update();
  assert.deepEqual([tp().value,tp().getAttribute('class'),note().textContent,button(r(),'save','tp').disabled],['2940,0','fct-input','',true]);
  key(tp(),'Enter');await settle();
  assert.deepEqual([f.calls,f.st.account.positions[1].tp],[[],2940]);
  // Typed again, then dragged off the chart (removed): the field is empty, as the level is.
  type(tp(),'2900');assert.equal(tp().getAttribute('class'),'fct-input fct-draft');
  set({tp:null});p.term.update();
  assert.deepEqual([tp().value,note().textContent,button(r(),'remove','tp').disabled,button(r(),'save','tp').disabled],['','',true,true]);
  // A draft of the other level stays: only its own level's change makes a draft stale.
  type(field(r(),'sl'),'3040');set({tp:2945});p.term.update();
  assert.deepEqual([field(r(),'sl').value,field(r(),'sl').getAttribute('class'),tp().value],['3040','fct-input fct-draft','2945,0']);
  key(field(r(),'sl'),'Escape');
  // Folded, or on another tab, the change is seen as well: the field shows the level when Positioner opens again.
  type(tp(),'2930');openTab(p,'history');set({tp:2935});p.term.update();openTab(p,'positions');
  assert.deepEqual([tp().value,tp().getAttribute('class')],['2935,0','fct-input']);
  click(p.q('[data-fct-toggle]'));type(tp(),'2925');set({tp:2936});p.term.update();click(p.q('[data-fct-toggle]'));
  assert.equal(tp().value,'2936,0');
  // Set in another tab, and Spara pressed before this one painted: nothing goes to the runner, the field shows the level
  // as it is now, and the line says why.
  type(tp(),'2900');set({tp:2932});
  click(button(r(),'save','tp'));await settle();
  assert.deepEqual([f.calls,tp().value,tp().getAttribute('class')],[[],'2932,0','fct-input']);
  const why='TP ändrades till 2\xa0932,0 medan du skrev. Skriv in nivån igen om du vill flytta den.';
  assert.deepEqual([msg.textContent,msg.classList.contains('note'),msg.classList.contains('bad'),p.said.at(-1)],[why,true,false,why]);
  // Removed in another tab before Enter: said so too.
  type(tp(),'2900');set({tp:null});key(tp(),'Enter');await settle();
  assert.deepEqual([f.calls,tp().value,msg.textContent],[[],'','TP togs bort medan du skrev. Skriv in nivån igen om du vill sätta den.']);
  // A keystroke that finds its own draft stale is newer than the change: the typing stays, against the level as it is
  // now, and Spara saves it.
  type(tp(),'291');set({tp:2920});type(tp(),'2910');
  assert.deepEqual([tp().value,tp().getAttribute('class')],['2910','fct-input fct-draft']);
  click(button(r(),'save','tp'));await settle();
  assert.deepEqual([f.calls,f.st.account.positions[1].tp],[[['setLevels',id,{tp:2910}]],2910]);
});

test('moving into a Saldo field or a level, or typing in it, keeps the line under it in view: the panel scrolls just enough, never past the field or the table\'s head',()=>{
  const p=mount(fakeRunner(build()).runner);
  // Over 900 px a panel shows a slice of its content and scrolls inside. A layout: where each element lies in the content.
  const layout=(box,top)=>(el,y,h)=>{el.getBoundingClientRect=()=>({top:top+y-box.scrollTop,bottom:top+y+h-box.scrollTop,height:h});};
  openTab(p,'balance');
  // Saldo shows 100–300 px of the page; a deposit's message above has pushed the second form down: its field lies at
  // 172–212 px of the content and its preview at 215–231, under the panel's edge.
  const pane=panel(p,'balance'),free=p.q('[data-fct-free]'),preview=p.q('[data-fct-free-preview]');
  Object.assign(pane,{scrollTop:0,clientHeight:200,getBoundingClientRect:()=>({top:100,bottom:300,height:200})});
  const at=layout(pane,100);at(free,172,40);at(preview,215,16);
  fire(free,'focusin');
  assert.equal(pane.scrollTop,31,'the preview\'s bottom, 331 px, up to the panel\'s, 300 px');
  type(free,'125');assert.equal(pane.scrollTop,31,'in view already: nothing moves');
  // A preview taller than the room under the field: the field stays at the panel's top.
  pane.scrollTop=0;at(preview,215,160);type(free,'12');
  assert.equal(pane.scrollTop,172);
  // Positioner: a level's note, with the table's sticky head (24 px) over the panel's top.
  openTab(p,'positions');
  const pos=panel(p,'positions'),r=p.qa('[data-fct-row]')[2],sl=field(r,'sl'),note=r.querySelector('[data-fct-note="sl"]');
  Object.assign(pos,{scrollTop:0,clientHeight:150,getBoundingClientRect:()=>({top:500,bottom:650,height:150})});
  pos.querySelector('thead').getBoundingClientRect=()=>({top:500,bottom:524,height:24});
  const put=layout(pos,500);put(sl,140,26);put(note,168,30);
  type(sl,'0,19');
  assert.equal(pos.scrollTop,48,'the note\'s bottom, 698 px, up to 650');
  pos.scrollTop=0;put(note,168,200);type(sl,'0,198');
  assert.equal(pos.scrollTop,116,'the field\'s top just under the head');
});

test('when a position closes the panel goes back to its first row, or to the row being typed in, so no row is left half under the table\'s sticky head',async()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner),[btc,eth,doge]=a.positions,pos=panel(p,'positions'),rows=()=>pos.querySelectorAll('[data-fct-row]');
  // Over 900 px the panel shows 160 px of its content from 500 px down: the sticky head (28 px), then rows of 89 px.
  // Så räknas siffrorna's summary comes after the rows and the line under them (27 px).
  const layout=el=>{
    if(el===pos)return {top:500,bottom:660,height:160};
    if(el.localName==='thead')return {top:500,bottom:528,height:28};
    if(el.localName==='summary'){const top=528+rows().length*89+27-pos.scrollTop;return {top,bottom:top+20,height:20};}
    const i=rows().indexOf(el),top=528+i*89-pos.scrollTop;
    return i<0?{top:0,bottom:0,height:0}:{top,bottom:top+89,height:89};
  };
  pos.clientHeight=160;
  FakeElement.prototype.getBoundingClientRect=function(){return layout(this);};
  try{
    // DOGE's SL was typed with the panel scrolled to it; then DOGE closes on its target and its row goes. The browser
    // keeps the offset as far as the shorter table allows (here 106 px), where BTC's row would sit under the head.
    field(row(p,doge.id),'sl').focus();type(field(row(p,doge.id),'sl'),'0,19');pos.scrollTop=106;
    f.st.account=checkQuote(f.st.account,doge.id,quote(.2115,T0+SEC),T0+SEC);p.term.update();
    assert.deepEqual([rows().length,p.doc.activeElement,pos.scrollTop],[2,pos,0]);
    // A level changed repaints the table but closes nothing: the offset the user chose stays.
    pos.scrollTop=40;
    const moved=setLevels(f.st.account,eth.id,{sl:3040},{quote:QUOTES.ETH,contract:limitsFor('ETH',T0),now:T0});assert.ok(moved.ok,moved.reason);
    f.st.account=moved.account;p.term.update();
    assert.equal(pos.scrollTop,40);
    // A third position, the panel scrolled to its row and its SL typed: BTC closes on its stop. That row is now the
    // second, below the panel's edge from the top, so the panel puts it just under the head, with focus kept in it.
    const o=openManual(f.st.account,{symbol:'SOL',side:'long',margin:10,leverage:10,quote:quote(150,T0),contract:limitsFor('SOL',T0),now:T0});assert.ok(o.ok,o.reason);
    f.st.account=o.account;p.term.update();
    const sol=()=>field(row(p,o.position.id),'sl');
    sol().focus();type(sol(),'149');pos.scrollTop=150;
    f.st.account=checkQuote(f.st.account,btc.id,quote(58990,T0+SEC),T0+SEC);p.term.update();
    assert.deepEqual([rows().map(x=>x.getAttribute('data-fct-row')),p.doc.activeElement,sol().value,pos.scrollTop],[[eth.id,o.position.id],sol(),'149',117-28]);
    // Focus on Så räknas siffrorna, the panel scrolled to it: ETH closes in another tab. The summary, now at 144 px of
    // the content, would lie below the panel's edge from the top, so it goes just under the head, with focus kept on it.
    pos.querySelector('summary').focus();pos.scrollTop=150;
    f.st.account=closePosition(f.st.account,eth.id,{price:2987.45,now:T0,reason:'manuell'});p.term.update();
    assert.deepEqual([rows().length,p.doc.activeElement,pos.scrollTop],[1,pos.querySelector('summary'),144-28]);
  }finally{delete FakeElement.prototype.getBoundingClientRect;}
});

test('a quantity reads as the position holds it: on Bybit\'s step exactly however large, off the step (a signal position) with six significant digits',()=>{
  const at=T0-5*SEC,r=openManual(deposit(newForecastAccount(T0-HOUR),10000,T0-HOUR),{symbol:'XRP',side:'long',margin:7411.11,leverage:10,quote:quote(.6,at),contract:limitsFor('XRP',at),now:at});
  assert.ok(r.ok,r.reason);assert.equal(r.position.units,123456.7);
  const f=fakeRunner(r.account);f.st.quotes={...QUOTES,XRP:quote(.6012,T0)};
  const p=mount(f.runner),id=r.position.id;
  assert.equal(row(p,id).children[4].textContent,'123\xa0456,7');
  // As the log wrote the order.
  assert.ok(r.account.log.at(-1).text.startsWith('Öppnade lång 123\xa0456,7 XRP till '),r.account.log.at(-1).text);
  // Closed: the trade's quantity in Historik.
  f.st.account=closePosition(f.st.account,id,{price:.6012,now:T0,reason:'manuell'});p.term.update();
  openTab(p,'history');
  assert.equal(panel(p,'history').querySelector('tbody tr').children[6].textContent,'123\xa0456,7');
  // A signal position is sized off the step: six significant digits (DOGE 4 671,94722… reads 4 671,95).
  const g=fakeRunner(build()),q=mount(g.runner),doge=g.st.account.positions[2];
  assert.ok(Math.abs(doge.units*1e4-Math.round(doge.units*1e4))>1e-3,'off the step');
  assert.equal(row(q,doge.id).children[4].textContent,doge.units.toLocaleString('sv-SE',{maximumSignificantDigits:6}));
});

test('prices carry the decimals of the coin\'s tick once the runner holds Bybit\'s limits, as the runner\'s texts and the log write them; the chart\'s until then',()=>{
  const a=build(),f=fakeRunner(a,{limits:false}),p=mount(f.runner),btc=a.positions[0],entry=()=>row(p,btc.id).children[5].textContent;
  // No limits yet: the chart's decimals for a price of that size (whole dollars for BTC).
  assert.equal(entry(),fixed(btc.entry,0));
  // The limits arrive (the runner reads them for the shown coin and for every order): BTC's tick is 0,10.
  f.st.limits=true;p.term.update();
  assert.deepEqual([entry(),row(p,btc.id).querySelector('[data-fct-cell="price"]').textContent,row(p,btc.id).querySelector('[data-fct-cell="liq"]').textContent],
    [fixed(btc.entry,1),fixed(QUOTES.BTC.price,1),fixed(btc.liq,1)]);
  // The same figure as the log's line for the order.
  const opened=a.log.find(e=>e.kind==='öppnad'&&e.t===btc.openedAt&&e.symbol==='BTC');
  assert.ok(opened.text.includes(' till '+entry()+' · '),opened.text+' / '+entry());
  // Kept once seen, also when the runner lets the limits go after their ten minutes.
  f.st.limits=false;p.term.update();
  assert.equal(entry(),fixed(btc.entry,1));
  openTab(p,'history');
  const t=a.trades.filter(x=>x.symbol==='BTC').at(-1),rows=panel(p,'history').querySelectorAll('tbody tr');
  const r=rows.find(x=>x.children[1]?.textContent==='BTC'&&x.children[0].textContent===stamp(t.closedAt,T0));
  assert.deepEqual([r.children[4].textContent,r.children[5].textContent],[fixed(t.entry,1),fixed(t.exit,1)]);
});

test('the message line shares one box with the panels, so on a wide screen a message never changes the terminal\'s height',()=>{
  const p=mount(fakeRunner(build()).runner),box=p.q('[data-fct-view]');
  assert.ok(box,'the box');
  assert.deepEqual(box.children.map(x=>x.hasAttribute('data-fct-msg')?'msg':x.getAttribute('data-fct-panel')),['msg',...TERMINAL_TABS]);
  assert.equal(box.parentNode,p.q('[data-fct-body]'));
  assert.equal(box.getAttribute('class'),'fct-view');
});

test('Historik: closed trades with every column, deposits and withdrawals as rows of their own, newest first, 50 at a time with Visa fler',async()=>{
  const a=build({trades:60,withdrawAfter:40}),f=fakeRunner(a),p=mount(f.runner);
  openTab(p,'history');
  const box=panel(p,'history');
  assert.deepEqual(box.querySelectorAll('thead th').map(th=>th.textContent),['Stängd','Coin','Sida','Typ','Entry','Exit','Antal','Hävstång','Resultat','Avgifter','Funding','Orsak']);
  // Ledger order, newest first: the withdrawal came after trade 41, the deposit before the first one.
  const ledger=[{t:a.transfers[0]},...a.trades.slice(0,41).map(x=>({x})),{t:a.transfers[1]},...a.trades.slice(41).map(x=>({x}))].reverse();
  let rows=box.querySelectorAll('tbody tr');
  assert.equal(rows.length,TERMINAL_PAGE);assert.equal(TERMINAL_PAGE,50);
  // Entry and exit with the decimals of the coin's tick on Bybit.
  const tick={BTC:1,ETH:2,SOL:2,XRP:4,DOGE:5};
  const text=e=>e.t?[stamp(e.t.t,T0),(e.t.kind==='in'?'Insättning ':'Uttag ')+money(e.t.amount)+' · tillgängligt efter '+money(e.t.cashAfter)]:
    [stamp(e.x.closedAt,T0),e.x.symbol,e.x.side==='long'?'Lång':'Kort',e.x.origin==='manual'?'Manuell':'Signal',fixed(e.x.entry,tick[e.x.symbol]),
      fixed(e.x.exit,tick[e.x.symbol]),e.x.units.toLocaleString('sv-SE',{maximumSignificantDigits:6}),
      e.x.leverage.toLocaleString('sv-SE',{maximumFractionDigits:2})+'×',signedMoney(e.x.pnl),money(e.x.fees),signedMoney(-e.x.funding),tradeReasons[e.x.reason]];
  assert.deepEqual(rows.map(r=>r.children.map(c=>c.textContent)),ledger.slice(0,50).map(text));
  const out=rows.find(r=>r.classList.contains('fct-transfer'));
  assert.deepEqual([out.classList.contains('out'),out.querySelector('td').getAttribute('colspan')],[true,'11']);
  // The account's own measures above it, net of deposits and withdrawals.
  const s=accountStats(a);
  assert.equal(box.querySelector('.fct-summary').textContent,'Kontots egen historik '+[s.trades+' avslut','vinstandel '+fixed(s.winRate*100,1)+'\xa0%','netto '+signedMoney(s.net),
    'max nedgång '+fixed(s.maxDrawdown*100,1)+'\xa0%','vinstfaktor '+fixed(s.profitFactor,2),'avgifter '+money(s.fees),'funding '+signedMoney(-s.funding),
    'likvidationer 0','insatt '+money(50),'uttaget '+money(20)].join(' · '));
  const since=dayOf(a.createdAt);
  assert.equal(box.querySelector('.fct-hint').textContent,'Uppmätt på kontots egna affärer sedan '+since.day+' '+MONTHS[since.month-1]+' '+since.year+'. Netto och max nedgång räknas utan insättningar och uttag.');
  // Under the rows: Exit is the price the close filled at; a stop or a target closes as a market order, with the account's slippage.
  assert.equal(ACCOUNT.slip,.0005);
  const under=box.children.at(-1);
  assert.deepEqual([under.getAttribute('class'),under.textContent],
    ['fct-hint','Exit är fyllnadspriset: SL och TP utlöses på senaste pris och stängs som marknadsorder med 0,05\xa0% slippage, så exit blir något sämre än nivån.']);
  // Visa fler: 50 more (here the last 12), then no button.
  const more=box.querySelector('[data-fct-more]');
  assert.deepEqual([more.textContent,box.querySelector('.fct-more span').textContent],['Visa fler','Visar 50 av 62']);
  more.focus();click(more);
  rows=box.querySelectorAll('tbody tr');
  assert.equal(rows.length,62);assert.deepEqual(rows.map(r=>r.children.map(c=>c.textContent)),ledger.map(text));
  assert.equal(box.querySelector('[data-fct-more]'),null);assert.equal(p.doc.activeElement,box,'focus to the panel');
  // A new trade arrives on top; the paging stays.
  const q=f.st.account.positions[0];
  f.st.account=closePosition(f.st.account,q.id,{price:61000,now:T0,reason:'manuell'});p.term.update();
  rows=box.querySelectorAll('tbody tr');
  assert.deepEqual([rows.length,rows[0].children[1].textContent,rows[0].children.at(-1).textContent],[63,'BTC','Stängd manuellt']);
  // Nothing yet: said so, with the measures.
  const empty=mount(fakeRunner(build({trades:0,open:false,deposits:false})).runner);
  openTab(empty,'history');
  assert.match(panel(empty,'history').textContent,/Inga avslut, insättningar eller uttag ännu\.$/);
});

test('Händelser: the account log newest first, refusals marked, 50 at a time',()=>{
  const a=build({trades:30}),f=fakeRunner(a),p=mount(f.runner);
  openTab(p,'events');
  const log=[...a.log].reverse(),items=()=>panel(p,'events').querySelectorAll('.fct-log li');
  assert.equal(log.length,a.log.length);assert.ok(log.length>50);
  assert.deepEqual(items().map(li=>[li.querySelector('time').textContent,li.querySelector('span').textContent]),
    log.slice(0,50).map(e=>[stamp(e.t,T0),e.text.replace(/(\d) ([%$])/g,'$1\xa0$2')]));
  assert.ok(items().some(li=>/^Insättning|^Uttag/.test(li.querySelector('span').textContent))||log.slice(0,50).every(e=>!['insättning','uttag'].includes(e.kind)));
  click(panel(p,'events').querySelector('[data-fct-more]'));
  assert.equal(items().length,log.length);
  assert.ok(items().some(li=>li.querySelector('span').textContent==='Insättning 50,00\xa0$'));
  // A refusal reads with its coin, in the warning colour.
  f.st.account={...f.st.account,log:[...f.st.account.log,{t:T0,kind:'avvisad',symbol:'BTC',signalId:'s|x',text:'Det finns redan en position i BTC'}]};
  p.term.update();
  const first=items()[0];
  assert.deepEqual([first.querySelector('span').textContent,first.getAttribute('class')],['Avvisad BTC: Det finns redan en position i BTC','no']);
});

test('Saldo previews the new free balance with the account\'s own rules, refuses what the ledger would refuse, and books through the runner',async()=>{
  const a=build({trades:0}),f=fakeRunner(a),p=mount(f.runner);
  openTab(p,'balance');
  const amount=p.q('[data-fct-amount]'),free=p.q('[data-fct-free]'),inn=p.q('[data-fct-transfer="in"]'),out=p.q('[data-fct-transfer="out"]'),set=p.q('[data-fct-set-free]');
  const preview=()=>p.q('[data-fct-amount-preview]').querySelectorAll('li').map(li=>[li.textContent,li.getAttribute('class')]);
  const freeLines=()=>p.q('[data-fct-free-preview]').querySelectorAll('li').map(li=>[li.textContent,li.getAttribute('class')]);
  assert.equal(p.q('[data-fct-bal-line]').textContent,'Startkapital 100,00\xa0$ · insatt 50,00\xa0$ · uttaget 0,00\xa0$ · tillgängligt '+money(a.cash));
  assert.deepEqual([inn.textContent,out.textContent,set.textContent],['Sätt in','Ta ut','Sätt tillgängligt']);
  assert.deepEqual([inn.disabled,out.disabled,set.disabled],[true,true,true]);
  assert.deepEqual(preview(),[['Ange ett belopp i $ att sätta in eller ta ut.',null]]);
  assert.equal(amount.getAttribute('aria-describedby'),p.q('[data-fct-amount-preview]').getAttribute('id'));
  assert.equal(inn.getAttribute('aria-describedby'),p.q('[data-fct-amount-preview]').getAttribute('id'));
  // A Swedish amount: a decimal comma, spaces, a $.
  type(amount,'1 025,5 $');
  assert.deepEqual(preview(),[['Nytt tillgängligt saldo efter insättning: '+money(a.cash+1025.5),null],
    ['Ta ut: Det går bara att ta ut tillgängligt saldo (högst '+money(a.cash)+'), inte marginalen i öppna positioner','bad']]);
  assert.deepEqual([inn.disabled,out.disabled],[false,true]);
  type(amount,'25,5');
  assert.deepEqual(preview(),[['Nytt tillgängligt saldo efter insättning: '+money(a.cash+25.5),null],['Nytt tillgängligt saldo efter uttag: '+money(a.cash-25.5),null]]);
  // The ledger's own refusals, word for word.
  for(const [typed,reason] of [['1,234','Ange beloppet i hela cent'],['0','Ange ett belopp över 0 $'],['-5','Ange ett belopp över 0 $'],['abc','Ange ett belopp över 0 $'],
    ['2 000 000','Högst 1'+NB+'000'+NB+'000 $ per insättning eller uttag'],['1,2.3','Ange ett belopp över 0 $']]){
    type(amount,typed);
    assert.deepEqual(preview(),[[reason.replace(/(\d) \$/g,'$1\xa0$'),'bad']],typed);assert.deepEqual([inn.disabled,out.disabled],[true,true],typed);
  }
  assert.equal(ACCOUNT.transferMax,1000000);
  // Sätt in: booked by the runner; the field empties, focus stays in the form, the result is shown and announced.
  type(amount,'25,5');
  const cash=f.st.account.cash;
  inn.focus();click(inn);await settle();
  assert.deepEqual(f.calls,[['transfer',{kind:'in',amount:25.5}]]);
  assert.deepEqual([amount.value,p.doc.activeElement,p.q('[data-fct-msg]').textContent],['',amount,bound('Satte in 25,50 $ · tillgängligt '+dollars(cash+25.5))]);
  assert.equal(val(p,'cash'),money(cash+25.5));
  assert.deepEqual(p.said,['Satte in 25,50\xa0$ · tillgängligt '+money(cash+25.5)]);
  // The message belongs to the tab where its action was taken: hidden on the others, back on return.
  openTab(p,'positions');assert.equal(p.q('[data-fct-msg]').hidden,true);
  openTab(p,'balance');assert.deepEqual([p.q('[data-fct-msg]').hidden,p.q('[data-fct-msg]').textContent],[false,bound('Satte in 25,50 $ · tillgängligt '+dollars(cash+25.5))]);
  // Ta ut.
  type(amount,'10');click(out);await settle();
  assert.deepEqual(f.calls.at(-1),['transfer',{kind:'out',amount:10}]);assert.equal(f.st.account.cash,cash+15.5);
  // Sätt tillgängligt till: deposits or withdraws the difference.
  assert.deepEqual(freeLines(),[['Ange hur mycket som ska vara tillgängligt; skillnaden sätts in eller tas ut.',null]]);
  type(free,'300');
  assert.deepEqual(freeLines(),[['Insättning '+money(300-f.st.account.cash)+' · nytt tillgängligt saldo 300,00\xa0$',null]]);
  type(free,'5');
  assert.deepEqual(freeLines(),[['Uttag '+money(f.st.account.cash-5)+' · nytt tillgängligt saldo 5,00\xa0$',null]]);
  for(const [typed,reason] of [['-1','Ange ett tillgängligt saldo på 0 $ eller mer'],['5,555','Ange beloppet i hela cent'],[fixed(f.st.account.cash,2),'Tillgängligt saldo är redan '+dollars(f.st.account.cash)],[String(f.st.account.cash),'Ange beloppet i hela cent'],
    ['1 500 000','Högst 1'+NB+'000'+NB+'000 $ per insättning eller uttag']]){
    type(free,typed);assert.deepEqual(freeLines(),[[reason.replace(/(\d) \$/g,'$1\xa0$'),'bad']],typed);assert.equal(set.disabled,true,typed);
  }
  type(free,'0');assert.equal(set.disabled,false,'all free cash can be taken out');
  type(free,'130');
  const e=key(free,'Enter');assert.equal(e.defaultPrevented,true);
  await settle();
  assert.deepEqual(f.calls.at(-1),['setFree',130]);
  assert.deepEqual([f.st.account.cash,free.value,p.q('[data-fct-msg]').textContent],[130,'',bound('Satte in '+dollars(130-(cash+15.5))+' · tillgängligt 130,00 $')]);
  assert.equal(f.st.account.transfers.length,4);
  // Another tab deposits 100 $ between two paints: typing previews on the account as the runner holds it now.
  f.st.account=deposit(f.st.account,100,T0);
  type(amount,'10');
  assert.deepEqual(preview()[0],['Nytt tillgängligt saldo efter insättning: '+money(230+10),null]);
  // The refusals of a runner that knows more (another tab took the money meanwhile) are shown as they come.
  f.runner.transfer=async()=>({ok:false,text:'Kontot byttes medan ändringen sparades',account:null});
  type(amount,'1');click(inn);await settle();
  assert.deepEqual([p.q('[data-fct-msg]').textContent,p.q('[data-fct-msg]').classList.contains('bad'),amount.value],['Kontot byttes medan ändringen sparades',true,'1']);
});

test('signed out, loading or busy: every action is disabled or waits, and says why',async()=>{
  const a=build(),f=fakeRunner(a),p=mount(f.runner);
  // Busy: one action at a time; the others are marked and ignored until it ends.
  openTab(p,'balance');
  type(p.q('[data-fct-amount]'),'5');
  const release=f.hold();
  click(p.q('[data-fct-transfer="in"]'));await settle();
  assert.deepEqual([p.q('[data-fct-transfer="in"]').textContent,p.q('[data-fct-msg]').textContent],['Sätter in…','Sätter in 5,00\xa0$…']);
  assert.ok([p.q('[data-fct-transfer="in"]'),p.q('[data-fct-transfer="out"]')].every(busy));
  click(p.q('[data-fct-transfer="out"]'));
  openTab(p,'positions');
  assert.ok(p.qa('[data-fct-close],[data-fct-save]').every(busy),'the positions\' actions wait too');
  click(p.qa('[data-fct-close]')[0]);type(field(p.qa('[data-fct-row]')[0],'sl'),'58000');key(field(p.qa('[data-fct-row]')[0],'sl'),'Enter');
  await settle();
  assert.deepEqual(f.calls,[['transfer',{kind:'in',amount:5}]]);assert.deepEqual(p.asked,[]);
  release();await settle();
  assert.ok(!p.qa('[data-fct-close]').some(busy));
  // Signed out: no figures, the reason, and no action anywhere.
  f.st.signedOut=true;p.term.update();
  assert.deepEqual(figures(p),['–','–','–','–','–']);
  assert.deepEqual([p.q('[data-fct-wait]').hidden,p.q('[data-fct-wait]').textContent],[false,'Logga in för att handla med AI Forecast-kontot']);
  assert.equal(panel(p,'positions').textContent,'Logga in för att handla med AI Forecast-kontot');
  assert.equal(p.q('[data-fct-count]').textContent,'');
  openTab(p,'balance');
  assert.ok([p.q('[data-fct-amount]'),p.q('[data-fct-free]'),p.q('[data-fct-transfer="in"]'),p.q('[data-fct-transfer="out"]'),p.q('[data-fct-set-free]')].every(x=>x.disabled));
  assert.equal(p.q('[data-fct-amount-preview]').textContent,'Logga in för att ändra saldot');
  for(const name of ['history','events']){openTab(p,name);assert.equal(panel(p,name).textContent,'Logga in för att handla med AI Forecast-kontot');}
  // Typed values and messages of the last account never carry over to the next one.
  assert.deepEqual([p.q('[data-fct-amount]').value,p.q('[data-fct-msg]').textContent],['','']);
  // Loading: said so.
  const l=fakeRunner(null),q=mount(l.runner);
  assert.equal(q.q('[data-fct-wait]').textContent,'Laddar AI Forecast-kontot…');
  openTab(q,'balance');assert.equal(q.q('[data-fct-amount-preview]').textContent,'AI Forecast-kontot laddas');
  // No runner at all: the terminal still stands.
  const r=mount(null);
  assert.deepEqual([figures(r)[0],r.q('[data-fct-wait]').textContent],['–','AI Forecast-kontot kan inte läsas']);
});

test('another account (a sign-in, a reset) drops what was typed and said for the last one, and an action\'s answer is shown only to its own account',async()=>{
  const a=build({trades:60}),f=fakeRunner(a),p=mount(f.runner),id=a.positions[0].id;
  type(field(row(p,id),'sl'),'58000');
  openTab(p,'balance');type(p.q('[data-fct-amount]'),'5');type(p.q('[data-fct-free]'),'7');
  openTab(p,'history');click(panel(p,'history').querySelector('[data-fct-more]'));
  assert.equal(panel(p,'history').querySelectorAll('tbody tr').length,62);
  const release=f.hold();
  openTab(p,'balance');click(p.q('[data-fct-transfer="in"]'));await settle();
  // A reset meanwhile: a new account.
  f.st.account=newForecastAccount(T0);
  release();await settle();
  assert.deepEqual([p.q('[data-fct-msg]').textContent,p.said,p.q('[data-fct-amount]').value,p.q('[data-fct-free]').value],['',[],'','']);
  f.st.account=a;p.term.update();
  openTab(p,'history');assert.equal(panel(p,'history').querySelectorAll('tbody tr').length,50,'the paging starts again');
  openTab(p,'positions');
  assert.equal(field(row(p,id),'sl').value,'59000','the typed SL is gone');
});

test('every text goes in as text: data and answers with markup are shown, never parsed',async()=>{
  const a=build({trades:1}),f=fakeRunner(a),p=mount(f.runner);
  const evil='<img src=x onerror="alert(1)">';
  f.st.account={...a,log:[...a.log,{t:T0,kind:'avvisad',symbol:'BTC',signalId:null,text:evil}],
    trades:[{...a.trades[0],reason:'<b>x</b>'}]};
  f.st.status={state:'error',text:evil};
  p.term.update();
  openTab(p,'events');
  assert.equal(panel(p,'events').querySelector('.fct-log li span').textContent,'Avvisad BTC: '+evil);
  openTab(p,'history');
  assert.ok(panel(p,'history').textContent.includes('<b>x</b>'));
  // A runner's answer with markup (on a valid account again: the broken trade above makes the ledger refuse every transfer).
  f.st.account=a;f.runner.transfer=async()=>({ok:false,text:evil});
  openTab(p,'balance');type(p.q('[data-fct-amount]'),'1');click(p.q('[data-fct-transfer="in"]'));await settle();
  assert.equal(p.q('[data-fct-msg]').textContent,evil);
  f.st.signedOut=true;f.st.status={state:'error',text:evil};p.term.update();
  assert.equal(p.q('[data-fct-wait]').textContent,evil);
  assert.equal(p.root.querySelectorAll('img').length+p.root.querySelectorAll('b').filter(b=>b.textContent==='x').length,0,'no element from data');
});

test('no confidence wording anywhere in the terminal, and every value keeps its unit on its line',async()=>{
  const p=mount(fakeRunner(build({trades:12})).runner),texts=[];
  for(const name of TERMINAL_TABS){openTab(p,name);texts.push(p.root.textContent);}
  type(p.q('[data-fct-amount]'),'5');type(p.q('[data-fct-free]'),'50');texts.push(p.root.textContent);
  const all=texts.join('\n');
  assert.doesNotMatch(all,/säker|sannolik|konfiden|förtroende|garant|troligen|confiden|probab|certain|tillförlitlig/i);
  assert.doesNotMatch(all,/\d [%$]/,'a number never splits from its unit');
  assert.doesNotMatch(source('../forecast-terminal.js'),/säker|sannolik|konfiden|förtroende|garant|troligen|confiden|probab|certain/i);
});

test('update() after destroy() is harmless; destroy() removes the content and stops listening; an action ending after it touches nothing',async()=>{
  const f=fakeRunner(build()),p=mount(f.runner);
  const release=f.hold();
  click(p.qa('[data-fct-close]')[0]);await settle();
  p.term.destroy();
  assert.equal(p.root.childNodes.length,0);assert.equal(p.root.getAttribute('data-collapsed'),null);
  assert.deepEqual([...p.root.listeners.values()].flat(),[]);
  release();await settle();
  assert.doesNotThrow(()=>p.term.update());assert.doesNotThrow(()=>p.term.destroy());
  assert.equal(p.root.childNodes.length,0);assert.deepEqual(p.said,[]);
  assert.throws(()=>mountTerminal(null,{}),/Kontoterminalen saknar sin plats i sidan/);
});

test('with the real runner: the figures are its own, Saldo books a deposit, a typed SL is saved, Stäng closes, and Historik and Händelser show it all',async()=>{
  const m=scriptMarket(),Q=m.end+30,rt={at:m.closeOf(Q)+2*SEC,urls:[],market:m},storage=memoryStorage();
  const runner=createForecastRunner({grab:fakeBybit(rt),storage,store:createForecastStore(memoryBackend()),locks:tabLocks(),now:()=>rt.at,getUser:()=>'u1',isActive:()=>true});
  await runner.tick();
  const order=await runner.order({symbol:'BTC',side:'long',margin:20,leverage:10});
  assert.equal(order.ok,true,order.text);
  rt.at+=5*SEC;await runner.tick();
  const p=mount(runner,{now:()=>rt.at}),live=runner.live();
  // One position: Orealiserat resultat is its Resultat.
  assert.deepEqual(figures(p),[money(live.equity),money(runner.account().cash),money(live.marginUsed),signedMoney(live.positions[0].pnl),signedMoney(live.result)]);
  assert.equal(val(p,'open'),row(p,order.position.id).querySelector('[data-fct-pnl]').textContent);
  // Its margin with the fee to close it holds: the one row is Marginal i bruk.
  assert.equal(row(p,order.position.id).querySelector('[data-fct-cell="margin"]').textContent,val(p,'margin'));
  assert.ok(order.position.reserve>0);
  const id=order.position.id,btc=row(p,id);
  assert.deepEqual(btc.children.slice(0,5).map(c=>c.textContent),['BTC','Lång','Manuell','10×',order.position.units.toLocaleString('sv-SE',{maximumSignificantDigits:6})]);
  // Saldo: 50 $ in. The free cash grows by exactly that; the result since the start does not move.
  openTab(p,'balance');
  const before=runner.live();
  type(p.q('[data-fct-amount]'),'50');click(p.q('[data-fct-transfer="in"]'));
  await until(()=>runner.account().transfers.length===1&&p.q('[data-fct-msg]').textContent.startsWith('Satte'),'the deposit');
  assert.equal(p.q('[data-fct-msg]').textContent,bound('Satte in 50,00 $ · tillgängligt '+dollars(before.cash+50)));
  const after=runner.live();
  assert.deepEqual([val(p,'cash'),val(p,'result')],[money(before.cash+50),signedMoney(after.result)]);
  near(after.result,before.result);
  // An SL typed in Positioner, saved by the runner after it settled the position; the field shows it as saved.
  rt.at+=3*MIN;openTab(p,'positions');
  const price=runner.quotes().BTC.price,typed=(Math.round(price*.995*10)/10).toLocaleString('sv-SE',{useGrouping:false,maximumFractionDigits:1});
  type(field(row(p,id),'sl'),typed);click(button(row(p,id),'save','sl'));
  await until(()=>runner.account().positions[0]?.sl!=null&&p.q('[data-fct-msg]').textContent.startsWith('Nya'),'the new SL');
  const sl=runner.account().positions[0].sl;
  assert.equal(p.q('[data-fct-msg]').textContent,'Nya nivåer för lång BTC: SL '+priceText(sl)+', ingen TP');
  assert.equal(field(row(p,id),'sl').value,sl.toLocaleString('sv-SE',{useGrouping:false,maximumFractionDigits:1}));
  // Stäng: asked, closed at market.
  click(row(p,id).querySelector('[data-fct-close]'));
  await until(()=>runner.account().trades.length===1&&p.q('[data-fct-msg]').textContent.startsWith('Stängde'),'the close');
  const trade=runner.account().trades[0];
  assert.match(p.asked[0],/^Stäng lång BTC till marknadspris nu\? Resultat just nu: [+−]\d+,\d\d\xa0\$\. Hela positionen stängs i demokontot\.$/);
  assert.equal(p.q('[data-fct-msg]').textContent,bound('Stängde lång BTC (manuell) till '+priceText(trade.exit)+' · '+(trade.pnl<0?'−':'+')+dollars(Math.abs(trade.pnl))));
  assert.equal(shownText(panel(p,'positions')),NO_POSITIONS);
  assert.deepEqual(figures(p),[money(runner.live().equity),money(runner.account().cash),money(0),signedMoney(0),signedMoney(runner.live().result)]);
  near(runner.live().result,trade.pnl,1e-6);
  // Historik: the trade on top, then the deposit.
  openTab(p,'history');
  const rows=panel(p,'history').querySelectorAll('tbody tr');
  assert.deepEqual(rows.map(r=>r.children[1].textContent),['BTC','Insättning 50,00\xa0$ · tillgängligt efter '+money(runner.account().transfers[0].cashAfter)]);
  assert.deepEqual([rows[0].children[3].textContent,rows[0].children.at(-1).textContent,rows[0].children[8].textContent],['Manuell','Stängd manuellt',signedMoney(trade.pnl)]);
  // Händelser: the log, newest first.
  openTab(p,'events');
  assert.deepEqual(panel(p,'events').querySelectorAll('.fct-log span').map(s=>s.textContent),[...runner.account().log].reverse().map(e=>bound(e.text)));
  assert.deepEqual(runner.account().log.map(e=>e.kind),['öppnad','insättning','ändrad','stängd']);
  assert.equal(runner.account().log[2].text,'Nya nivåer för lång BTC: SL '+priceText(sl)+', ingen TP (manuell)');
  // Every action's answer was announced, bound like the view binds it.
  assert.deepEqual(p.said.map(x=>x.slice(0,8)),['Satte in','Nya nivå','Stängde ']);
});

test('the stylesheet: scoped under #aiForecast with the view\'s own colours, dense tabular numbers, one panel height on wide screens, phones, touch, focus and motion',()=>{
  const css=source('../forecast-terminal.css'),view=source('../forecast.css');
  // Every rule is the view's: its selectors start at #aiForecast.
  const text=css.replace(/\/\*[\s\S]*?\*\//g,''),heads=[];
  let start=0;for(let i=0;i<text.length;i++){if(text[i]==='{'){heads.push(text.slice(start,i).trim());start=i+1;}else if(text[i]==='}')start=i+1;}
  const split=s=>{const out=[];let depth=0,from=0;for(let i=0;i<s.length;i++){if(s[i]==='(')depth++;else if(s[i]===')')depth--;else if(s[i]===','&&!depth){out.push(s.slice(from,i));from=i+1;}}out.push(s.slice(from));return out.map(x=>x.trim());};
  const selectors=heads.filter(h=>!h.startsWith('@')).flatMap(split);
  assert.ok(selectors.length>50);
  assert.deepEqual(selectors.filter(s=>!s.startsWith('#aiForecast ')),[]);
  // Colours are the view's tokens; the few literal ones are the view's own button states.
  const literal=[...new Set(text.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)??[])];
  assert.deepEqual(literal.filter(c=>!view.includes(c)),[]);
  for(const token of ['--fc-panel','--fc-panel-2','--fc-line','--fc-text','--fc-text-2','--fc-accent','--fc-up-text','--fc-down-text','--fc-warn-text'])assert.ok(css.includes('var('+token+')'),token);
  assert.match(css,/#aiForecast \.fct-table \.num\{text-align:right;font-family:var\(--mono,monospace\);font-variant-numeric:tabular-nums\}/);
  assert.match(css,/#aiForecast \.fct-fig dd\{[^}]*font-variant-numeric:tabular-nums/);
  // Wide screens: the message line and the open panel share one box of one height, so neither a message nor a tab
  // switch resizes the chart; the panel takes what the message leaves and scrolls inside. On a short screen the box gives
  // the chart its room first (the chart's 280 px under the view's header and the ticket), down to its floor (the next test).
  assert.match(css,/@media \(min-width:901px\)\{#aiForecast \.fct-view\{height:clamp\(var\(--fct-floor\),min\(22vh,calc\(100vh - 710px\)\),280px\)\}#aiForecast \.fct-view>\.fct-panel\{flex:1 1 auto;min-height:0;overscroll-behavior:contain\}\}/);
  assert.match(css,/#aiForecast \.fct-view\{display:flex;flex-direction:column;min-width:0\}/);assert.match(css,/#aiForecast \.fct-msg\{flex:none;/);
  assert.doesNotMatch(css,/\.fct-panel\{(?:[^}]*;)?height:/,'the panel has no height of its own');
  assert.match(css,/#aiForecast \.fct-panel\{[^}]*overflow:auto/);
  assert.match(css,/#aiForecast \.fct-table thead th\{position:sticky;top:0;/);assert.match(css,/#aiForecast \.fct-table tbody th\{position:sticky;left:0;/);
  assert.match(css,/#aiForecast \.fct-table\{width:100%;min-width:max-content;/);
  // Positioner over a phone's width: the result, the levels and Stäng keep to the panel's right edge, each as wide as its
  // content and held off the edge by the widths of the columns after it (which the terminal measures), so where the table
  // is wider than the panel (1024–1366 px, a long price, a time stop) the columns before them scroll under them: Stäng is
  // always in view and nothing lies over the SL and TP editors.
  assert.match(css,/#aiForecast \.fct-positions :is\(thead th,tbody td\)\.fct-act\{border-left:1px solid var\(--fc-line\)\}/);
  const pinned=/@media \(min-width:561px\)\{([\s\S]*?)\n\}/.exec(css)?.[1]??'';
  assert.match(pinned,/#aiForecast \.fct-positions :is\(th,td\):is\(\.fct-pnl,\.fct-levels,\.fct-act\)\{position:sticky;z-index:1;width:1px;background:var\(--fc-panel\)\}/);
  assert.match(pinned,/#aiForecast \.fct-positions thead th:is\(\.fct-pnl,\.fct-levels,\.fct-act\)\{z-index:3\}/);
  assert.match(pinned,/#aiForecast \.fct-positions :is\(th,td\)\.fct-act\{right:0\}/);
  assert.match(pinned,/#aiForecast \.fct-positions :is\(th,td\)\.fct-levels\{right:var\(--fct-act,0px\)\}/);
  assert.match(pinned,/#aiForecast \.fct-positions :is\(th,td\)\.fct-pnl\{right:calc\(var\(--fct-act,0px\) \+ var\(--fct-lv,0px\)\);border-left:1px solid var\(--fc-line\)\}/);
  // Saldo: the two forms side by side where the panel has room for both and one under the other on a phone, so the whole
  // tab fits a wide screen's panel under an action's message.
  assert.match(css,/#aiForecast \.fct-balance\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(250px,1fr\)\);align-items:start;/);
  assert.match(css,/#aiForecast \.fct-balance>p\{grid-column:1\/-1;margin:0\}/);
  // News about the account (a position closed on its SL or TP) is plain text: neither the success nor the error colour.
  assert.match(css,/#aiForecast \.fct-msg\.note\{color:var\(--fc-text\)\}/);
  // A level's note wraps within the editor's width and adds nothing to the column's, so typing never moves the columns.
  assert.match(css,/#aiForecast \.fct-table small\.fct-level-note\{grid-column:2\/-1;width:0;min-width:100%;white-space:normal\}/);
  assert.doesNotMatch(css,/fct-level-note\{[^}]*max-width/);
  // Folded: only Kapital; hidden always hides.
  assert.match(css,/#aiForecast \.fct\.is-collapsed \.fct-fig:not\(\[data-fct-fig=equity\]\)/);assert.match(css,/#aiForecast \.fct \[hidden\]\{display:none!important\}/);
  // Phones: the figures in three columns under the title and the button; touch targets of 40 px.
  const phone=/@media \(max-width:560px\)\{([\s\S]*?)\n\}/.exec(css)?.[1]??'';
  assert.match(phone,/\.fct-figs\{grid-column:1\/-1;grid-row:2;display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  // Phones: a card per position and per trade, so the result and Stäng need no sideways scrolling; the table head
  // stays for screen readers and each figure shows its name.
  assert.match(phone,/#aiForecast :is\(\.fct-positions,\.fct-history\)\{display:block;width:auto;min-width:0\}/);
  assert.match(phone,/#aiForecast :is\(\.fct-positions,\.fct-history\) thead\{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect\(0 0 0 0\);clip-path:inset\(50%\);white-space:nowrap\}/);
  assert.match(phone,/#aiForecast :is\(\.fct-positions,\.fct-history\) tbody tr\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(phone,/#aiForecast :is\(\.fct-positions,\.fct-history\) tbody :is\(th,td\)\{position:static;display:block;/);
  assert.match(phone,/td\[data-label\]::before\{content:attr\(data-label\);content:attr\(data-label\)\/'';display:block;/);
  assert.match(phone,/#aiForecast \.fct-positions td:is\(\.fct-pnl,\.fct-levels,\.fct-act\)\{grid-column:1\/-1\}/);
  assert.match(phone,/#aiForecast \.fct-positions tbody td\.fct-act\{position:static;justify-self:end;/);
  assert.match(phone,/#aiForecast \.fct-history tbody tr\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  const touch=/@media \(pointer:coarse\)\{([\s\S]*?)\n\}/.exec(css)?.[1]??'';
  assert.match(touch,/:is\(\.fct-btn,\.fct-input,\.fct-tab\)\{min-height:40px\}/);assert.match(touch,/\.fct-toggle\{width:40px;height:40px\}/);
  // Focus stays visible: the tab's ring inside its clipping row, the panel's and the fields' own.
  assert.match(css,/#aiForecast \.fct-tab:focus-visible\{outline-offset:-2px\}/);
  assert.match(css,/#aiForecast \.fct-panel:focus-visible\{outline:2px solid var\(--fc-accent\);outline-offset:-2px\}/);
  assert.match(css,/#aiForecast \.fct-input:focus-visible\{outline:2px solid var\(--fc-accent\)/);
  assert.match(view,/#aiForecast :is\(button,select,input,a\):focus-visible\{outline:2px solid var\(--fc-accent\);outline-offset:2px\}/,'and the view\'s ring for the rest');
  assert.match(css,/@media \(prefers-reduced-motion:reduce\)\{#aiForecast \.fct \*\{transition:none!important;animation:none!important\}\}/);
});

test('on a short wide screen the terminal\'s box still holds a message line, the table head and one whole position with its SL and TP editors',()=>{
  // A laptop's viewport (1366 × 657, 1280 × 800) once got a 90 px box, where one position (89 px with touch's controls)
  // under the head (28 px) lost its TP editor below the box's edge.
  const text=source('../forecast-terminal.css').replace(/\/\*[\s\S]*?\*\//g,'');
  const px=re=>{const m=re.exec(text);assert.ok(m,String(re));return Number(m[1]);};
  assert.match(text,/@media \(min-width:901px\)\{#aiForecast \.fct-view\{height:clamp\(var\(--fct-floor\),/);
  const touch=/@media \(pointer:coarse\)\{([\s\S]*?)\n\}/.exec(text)?.[1]??'';
  const floor={mouse:px(/^#aiForecast \.fct\{--fct-floor:(\d+)px\}$/m),touch:Number(/#aiForecast \.fct\{--fct-floor:(\d+)px\}/.exec(touch)?.[1])};
  // A position's SL and TP editors stand one above the other, each as tall as its controls, in a cell with padding above
  // and under, a margin between them and the row's border under it.
  const control={mouse:Math.max(px(/#aiForecast \.fct-input\{[^}]*min-height:(\d+)px/),px(/#aiForecast \.fct-btn\{[^}]*min-height:(\d+)px/)),
    touch:Number(/:is\(\.fct-btn,\.fct-input,\.fct-tab\)\{min-height:(\d+)px\}/.exec(touch)?.[1])};
  const pad=px(/#aiForecast \.fct-positions td\.fct-levels\{padding-block:(\d+)px\}/),gap=px(/#aiForecast \.fct-level\+\.fct-level\{margin-top:(\d+)px\}/);
  const position=k=>2*control[k]+2*pad+gap+1;
  assert.deepEqual([position('mouse'),position('touch')],[61,89],'as Chrome measures a row');
  // The message line (its padding and one line) and the table head (a line, padding above and under, a border), in the
  // terminal's line height; and a sideways scrollbar (17 px), which the panel shows where the table is wider than it.
  const lh=px(/#aiForecast \.fct\{[^}]*line-height:([\d.]+)/);
  const msg=px(/#aiForecast \.fct-msg\{[^}]*padding:(\d+)px/)+px(/#aiForecast \.fct-msg\{[^}]*font-size:([\d.]+)px/)*lh;
  const head=2*px(/#aiForecast \.fct-table thead th\{[^}]*padding-block:(\d+)px/)+px(/#aiForecast \.fct-table thead th\{[^}]*font-size:([\d.]+)px/)*lh+1;
  assert.deepEqual([Math.ceil(msg),Math.ceil(head)],[23,28]);
  for(const k of ['mouse','touch']){
    const need=Math.ceil(msg)+Math.ceil(head)+position(k)+17;
    assert.ok(floor[k]>=need,k+': a floor of '+floor[k]+' px, where a message, the head and one position need '+need+' px');
    // The floor is the room for one position, not for two: the chart keeps its share.
    assert.ok(floor[k]<need+position(k)/2,k+': '+floor[k]+' px');
  }
});

test('the terminal\'s files have no invisible space characters: a no-break space is written as an escape where it is meant',()=>{
  for(const file of ['../forecast-terminal.js','../forecast-terminal.css','./forecast-terminal.test.mjs']){
    const text=source(file),at=[...text.matchAll(/[\u00a0\u202f\u2007\u200b\ufeff]/g)].map(m=>text.slice(0,m.index).split('\n').length);
    assert.deepEqual(at,[],file);
  }
});

test('index.html links the terminal\'s stylesheet once, right after the view\'s',()=>{
  const html=source('../index.html'),links=html.match(/<link rel="stylesheet" href="\.\/forecast-terminal\.css">/g)??[];
  assert.equal(links.length,1);
  assert.match(html,/<link rel="stylesheet" href="\.\/forecast\.css">\n<link rel="stylesheet" href="\.\/forecast-terminal\.css">\n/);
});
