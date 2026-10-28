import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as motor from '../motor.js';
import {isolatedLevel} from '../bybit-contracts.js';

// Run the dashboard's actual functions, with DOM/network/storage boundaries
// replaced by in-memory fixtures. No requests or account writes are made.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const noop = () => {};
const element = () => ({ classList: { toggle:noop, add:noop, remove:noop } });
function context(names, values) {
  const ctx = vm.createContext({ ...motor, AUTH:{anvandare:{uid:'test'}}, ...values });
  for (const name of names) {
    const match = html.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'));
    assert.ok(match, name);
    vm.runInContext(match[0], ctx);
  }
  return ctx;
}

test('saved settings and subsequent edits reach the engine, even if storage fails', () => {
  const engine = { ...motor.MOTORCFG };
  const cfg = { minPts:50, maxPts:400, risk:'normal' };
  const ctx = context(['syncMotorCfg','loadCfg','saveCfg'], {
    CFG:cfg, MOTORCFG:engine, CFG_KEY:'cfg', CFG_KEY_GAMMAL:'old', cleanUrl:x => x,
    localStorage: {
      getItem:() => JSON.stringify({ minPts:120, maxPts:800, risk:'aggressive' }),
      setItem:() => { throw Error('storage full'); }
    }
  });
  ctx.loadCfg();
  assert.equal(engine.minPts, 120);
  assert.equal(engine.maxPts, 800);
  assert.equal(engine.risk, 'aggressive');
  cfg.minPts = 70; cfg.maxPts = 500; cfg.risk = 'normal';
  ctx.saveCfg();
  assert.equal(engine.minPts, 70);
  assert.equal(engine.maxPts, 500);
  assert.equal(engine.risk, 'normal');
});

test('signed-out visitors do not run account ticks, polling or dashboard refresh',async()=>{
  const ctx=context(['kryptoTick','demoTick','pollaKrypto','pollaLive','refresh'],{AUTH:{anvandare:null}});
  ctx.kryptoTick();ctx.demoTick();await ctx.pollaKrypto();await ctx.pollaLive();await ctx.refresh();
  // No account/market/DOM globals exist here: reaching any side effect would fail.
});

test('trading floor suppresses signal popups and sound without replaying them on exit',()=>{
  const location={hash:'#floor'},seen=new Set(),state={lage:'krypto',signals:[{id:'first',inst:'BTC',status:'ACTIVE'}]};
  let popups=0,sounds=0;
  const ctx=context(['bevakaAktiveringar'],{location,STATE:state,AKTIVA_SEDDA:seen,aktivSeddInit:true,
    INSTR:{BTC:{}},grupp:()=> 'crypto',visaAktivering:()=>popups++,spelaLjud:()=>sounds++});
  ctx.bevakaAktiveringar();assert.ok(seen.has('first'));assert.equal(popups,0);assert.equal(sounds,0);
  location.hash='';ctx.bevakaAktiveringar();assert.equal(popups,0);assert.equal(sounds,0);
  state.signals.push({id:'second',inst:'BTC',status:'ACTIVE'});ctx.bevakaAktiveringar();
  assert.equal(popups,1);assert.equal(sounds,1);
  // Direct calls must also stop before creating any DOM nodes.
  context(['visaAktivering'],{location:{hash:'#floor'}}).visaAktivering({});
});

test('authentication swaps landing/panel, resumes once, and invalidates pending work on logout',()=>{
  const nodes=new Map(),classes=new Set();let refreshes=0,routes=0,floors=0,forecasts=0,hubs=0,multiviews=0;
  const auth={anvandare:null},state={modeVersion:5,refreshPending:true};
  const ctx=context(['authRitaOm'],{
    AUTH:auth,STATE:state,document:{body:{classList:{toggle:(key,on)=>on?classes.add(key):classes.delete(key)}}},
    $:key=>{if(!nodes.has(key))nodes.set(key,{...element(),style:{}});return nodes.get(key);},
    summaryRoute:()=>routes++,floorRoute:()=>floors++,forecastRoute:()=>forecasts++,hubRoute:()=>hubs++,multiviewRoute:()=>multiviews++,renderDemo:noop,refresh:()=>refreshes++
  });
  ctx.authRitaOm();assert.ok(classes.has('landing'));assert.equal(nodes.get('#landingPage').hidden,false);assert.equal(refreshes,0);
  auth.anvandare={email:'member@example.com'};ctx.authRitaOm();assert.ok(!classes.has('landing'));assert.equal(nodes.get('#landingPage').hidden,true);assert.equal(refreshes,1);
  ctx.authRitaOm();assert.equal(refreshes,1);
  auth.anvandare=null;ctx.authRitaOm();assert.ok(classes.has('landing'));assert.equal(state.modeVersion,6);assert.equal(state.refreshPending,false);assert.equal(routes,4);assert.equal(floors,4);assert.equal(forecasts,4);assert.equal(hubs,4);assert.equal(multiviews,4);
});

test('AI Forecast suppresses signal popups and sound like the trading floor, and has its own account tab',()=>{
  const location={hash:'#forecast'},seen=new Set(),state={lage:'krypto',signals:[{id:'first',inst:'BTC',status:'ACTIVE'}]};
  let popups=0,sounds=0;
  const ctx=context(['bevakaAktiveringar'],{location,STATE:state,AKTIVA_SEDDA:seen,aktivSeddInit:true,
    INSTR:{BTC:{}},grupp:()=> 'crypto',visaAktivering:()=>popups++,spelaLjud:()=>sounds++});
  ctx.bevakaAktiveringar();assert.ok(seen.has('first'));assert.equal(popups,0);assert.equal(sounds,0);
  location.hash='';ctx.bevakaAktiveringar();assert.equal(popups,0,'nothing replayed on exit');
  state.signals.push({id:'second',inst:'BTC',status:'ACTIVE'});ctx.bevakaAktiveringar();assert.equal(popups,1);assert.equal(sounds,1);
  context(['visaAktivering'],{location:{hash:'#forecast'}}).visaAktivering({});
  // The Kryptokonton tabs accept the new view; unknown values still fall back to the ordinary account.
  const views=['standard','momentum','forecast','rules'],panels=Object.fromEntries(views.map(v=>[v,{hidden:false}]));
  const buttons=views.map(v=>({dataset:{cryptoView:v},classList:{on:false,toggle(k,on){this.on=on;}},attrs:{'aria-controls':v},
    setAttribute(k,x){this.attrs[k]=x;},getAttribute(k){return this.attrs[k];}}));
  const tabs=context(['setCryptoAccountView'],{$$:()=>buttons,document:{getElementById:id=>panels[id]}});
  tabs.setCryptoAccountView('forecast');
  assert.deepEqual(views.filter(v=>!panels[v].hidden),['forecast']);
  assert.deepEqual(buttons.map(b=>[b.classList.on,b.attrs['aria-pressed']]),views.map(v=>[v==='forecast',String(v==='forecast')]));
  tabs.setCryptoAccountView('okänd');
  assert.deepEqual(views.filter(v=>!panels[v].hidden),['standard']);
});

test('the start page shows once per tab after login, on #hub, and never in an extra window',()=>{
  const nodes=new Map(),classes=new Set(),store=new Map();
  const auth={anvandare:{email:'member@example.com'}},location={hash:'',search:''};
  const ctx=context(['hubDone','hubRoute'],{
    AUTH:auth,location,HUB_DONE:'done',window:{},
    windowNumber:()=>Number(new URLSearchParams(location.search).get('w'))||1,
    sessionStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},
    document:{body:{classList:{toggle:(key,on)=>on?classes.add(key):classes.delete(key),contains:key=>classes.has(key)}}},
    $:key=>{if(!nodes.has(key))nodes.set(key,{...element(),focus:noop});return nodes.get(key);}
  });
  ctx.hubRoute();assert.ok(classes.has('hub'));assert.equal(nodes.get('#hubPage').hidden,false);assert.equal(nodes.get('#hubEmail').textContent,'member@example.com');
  ctx.hubDone(true);ctx.hubRoute();assert.ok(!classes.has('hub'),'Forecast chosen: the dashboard shows');
  location.hash='#hub';ctx.hubRoute();assert.ok(classes.has('hub'),'the Hem button brings it back');
  location.hash='#multiview';ctx.hubRoute();assert.ok(!classes.has('hub'));
  store.clear();location.hash='';location.search='?w=2';ctx.hubRoute();assert.ok(!classes.has('hub'),'an extra window skips it');
  auth.anvandare=null;location.hash='#hub';location.search='';ctx.hubRoute();assert.ok(!classes.has('hub'),'logged out: the landing page instead');
});

test('AI Forecast moves into Multiview when its panel is on and back to its own place otherwise',()=>{
  const classes=new Set(),location={hash:'#multiview'};
  const body={children:[]};
  const place=(el,parent)=>{if(el.parentNode)el.parentNode.children.splice(el.parentNode.children.indexOf(el),1);el.parentNode=parent;parent.children.push(el);};
  const floor={id:'floor'},view={id:'forecast',hidden:true,parentNode:null};
  const slot={children:[],appendChild:el=>place(el,slot)};
  floor.after=el=>place(el,body);
  Object.defineProperty(view,'previousElementSibling',{get:()=>view.parentNode===body?floor:null});
  let shown=0,hidden=0,mode='nq',panel=true;
  const ctx=context(['forecastShown','forecastRoute'],{
    AUTH:{anvandare:{uid:'u'}},location,STATE:{get lage(){return mode;}},tillLage:m=>{mode=m;},forecastMount:noop,
    forecastView:{show:()=>shown++,hide:()=>hidden++},multiView:{shows:k=>k==='forecast'&&panel},
    document:{body:{classList:{toggle:(key,on)=>on?classes.add(key):classes.delete(key)}}},
    $:key=>({'#aiForecast':view,'#tradingFloor':floor,'#multiview [data-mv-slot="forecast"]':slot,'#forecastTitle':{focus:noop}})[key]
  });
  ctx.forecastRoute();
  assert.equal(view.parentNode,slot);assert.equal(view.hidden,false);assert.equal(shown,1);assert.equal(mode,'krypto');assert.ok(!classes.has('forecast'),'Multiview keeps its own layout');
  panel=false;ctx.forecastRoute();assert.equal(view.parentNode,body);assert.equal(view.hidden,true);assert.equal(hidden,1);
  location.hash='#forecast';ctx.forecastRoute();assert.equal(view.parentNode,body);assert.equal(view.hidden,false);assert.ok(classes.has('forecast'));
  location.hash='';ctx.forecastRoute();assert.equal(view.hidden,true);
  context(['visaAktivering'],{location:{hash:'#multiview'}}).visaAktivering({});
});

test('login always signs into an existing account even if a legacy signup mode is supplied',async()=>{
  const nodes=new Map();let logins=0,creates=0;
  const auth={auth:{},lage:'ny',modul:{signInWithEmailAndPassword:async()=>logins++,createUserWithEmailAndPassword:async()=>creates++,setPersistence:async()=>{},browserLocalPersistence:{},browserSessionPersistence:{}}};
  const ctx=context(['authLage','authKor'],{
    AUTH:auth,AUTH_FEL:{},authSakerstall:async()=>true,authMeddela:noop,
    $:key=>{if(!nodes.has(key))nodes.set(key,{...element(),value:key==='#authEpost'?'member@example.com':'password',checked:true,setAttribute:noop});return nodes.get(key);}
  });
  ctx.authLage('ny');assert.equal(auth.lage,'in');assert.equal(nodes.get('#authKor').textContent,'Logga in');
  auth.lage='ny';await ctx.authKor();assert.equal(logins,1);assert.equal(creates,0);assert.equal(nodes.get('#authLosen').value,'');
});

function cryptoFixture() {
  const state = { lage:'krypto', signals:[], ctx:{ BTC:{ simulated:true, px:80,
    bars:[{ t:1000, o:80, h:81, l:79, c:80 }] } } };
  const account = { start:100, kapital:100, havstang:20, mmr:.005, avgift:.00055, affarer:[],
    oppen:{ id:'position', inst:'BTC', side:'long', entry:100, sl:99, tp:102,
      liq:95.5, enheter:20, margin:100, notional:2000, kollad:1000, fyllStapel:1000 } };
  let saves = 0;
  const ctx = context(['krTagbar','krLikvidation','kryptoTick','riktigaPriser'], {
    STATE:state, KRYPTO:account, CFG:{cryptoSelective:false}, KR_ENHET:'test', krHandlarHar:() => true,
    krSpara:() => saves++, coreRead:noop, aktivaSyms:() => ['BTC','ETH'],isolatedLevel,
    krMaxPlan:()=>({leverage:20,maintenance:.005,deduction:0})
  });
  return { ctx, state, account, saves:() => saves };
}

test('simulated prices cannot liquidate positions; real prices resume evaluation', () => {
  const { ctx, state, account, saves } = cryptoFixture();
  ctx.kryptoTick();
  assert.equal(account.kapital, 100);
  assert.equal(account.affarer.length, 0);
  assert.ok(account.oppen);
  assert.equal(saves(), 0);
  state.ctx.BTC.simulated = false;
  ctx.kryptoTick();
  assert.equal(account.kapital, 0);
  assert.equal(account.affarer[0].hur, 'likviderad');
  assert.equal(saves(), 1);
});

test('simulated entries are blocked without blocking healthy instruments', () => {
  const { ctx, state, account } = cryptoFixture();
  account.oppen = null;
  state.ctx.BTC.px = 100;
  const signal = { id:'entry', inst:'BTC', side:'long', status:'ACTIVE', grade:'A', sl:99, tp:102 };
  state.signals = [signal];
  ctx.kryptoTick();
  assert.equal(account.oppen, null);
  state.ctx.ETH = { ...state.ctx.BTC, simulated:false };
  assert.equal(ctx.krTagbar({ ...signal, inst:'ETH' }).ok, true);
  assert.deepEqual(Object.keys(ctx.riktigaPriser()), ['ETH']);
  state.ctx.BTC.simulated = false;
  ctx.kryptoTick();
  assert.equal(account.oppen.id, 'entry');
});

test('ordinary crypto demo requires limits, uses per-coin maximum and preserves it on exit',()=>{
  const {ctx,state,account}=cryptoFixture();account.oppen=null;
  state.ctx.BTC={simulated:false,px:100,bars:[{t:1000,o:100,h:100,l:100,c:100}]};
  state.signals=[{id:'max',inst:'BTC',side:'long',status:'ACTIVE',grade:'A',sl:99,tp:102}];
  ctx.krMaxPlan=()=>null;ctx.kryptoTick();assert.equal(account.oppen,null);
  ctx.krMaxPlan=()=>({leverage:150,maintenance:.0033,deduction:0});
  ctx.kryptoTick();assert.equal(account.oppen.havstang,150);assert.equal(account.oppen.notional,15000);
  const liq=account.oppen.liq;
  ctx.krMaxPlan=()=>null;ctx.kryptoTick();assert.equal(account.oppen.liq,liq);
  state.ctx.BTC.px=103;ctx.kryptoTick();assert.equal(account.oppen,null);assert.equal(account.affarer[0].havstang,150);
  assert.equal(account.affarer[0].bybitPlan.maintenance,.0033);
});

test('selective mode blocks new entries, allows qualified entries and preserves open-position exits', () => {
  const {ctx,state,account} = cryptoFixture();
  state.ctx.BTC.simulated=false;state.ctx.BTC.px=100;
  state.ctx.BTC.bars=[{t:1000,o:100,h:100,l:100,c:100}];
  account.oppen=null;ctx.CFG.cryptoSelective=true;
  const s={id:'selective',inst:'BTC',side:'long',status:'ACTIVE',grade:'A',sl:99,tp:102};
  state.signals=[s];ctx.krReview=()=>({pass:false,reason:'test requirement'});
  assert.match(ctx.krTagbar(s).skal,/test requirement/);
  ctx.kryptoTick();assert.equal(account.oppen,null);
  ctx.krReview=()=>({pass:true});ctx.kryptoTick();assert.equal(account.oppen.id,s.id);
  assert.equal(account.oppen.kapitalFore,100);
  ctx.krReview=()=>{throw Error('Existing position must not be re-filtered');};
  state.ctx.BTC.px=98;ctx.kryptoTick();assert.equal(account.oppen,null);assert.equal(account.affarer.length,1);
  assert.equal(account.affarer[0].kapitalFore,100);
});

test('full history is retained locally while the shared live snapshot stays bounded',()=>{
  const account={start:100,kapital:750,startad:1,havstang:20,oppen:null,affarer:Array.from({length:650},(_,i)=>({id:String(i),pnl:1,stangd:i+1}))};
  let local,remote;
  const ctx=context(['krTillstand','krSparaLokalt','krSpara'],{
    KRYPTO:account,KR_NYCKEL:'account',krLocalError:false,krSistSkrivet:0,coreRead:noop,
    localStorage:{setItem:(_,value)=>local=JSON.parse(value)},
    AUTH:{anvandare:{uid:'test'},db:{},fs:{doc:()=>({}),setDoc:(_,value)=>{remote=value;return Promise.resolve();}}}
  });
  ctx.krSpara();assert.equal(local.affarer.length,650);assert.equal(remote.affarer.length,300);assert.equal(account.affarer.length,650);
});

test('crypto score is a rule score and does not reuse Nasdaq measured success', () => {
  const ctx=context(['traffHtml'],{});
  const html=ctx.traffHtml({inst:'BTC',conf:93,traff:{traff:99,n:10000,R:2}});
  assert.match(html,/93\/100/);assert.doesNotMatch(html,/99|93%/);
});

test('fallback history stays marked simulated even when a real feed bar arrives', async () => {
  const state = { modeVersion:0, ctx:{}, quotes:{}, feed:{} };
  let failing = true;
  const data = () => ({ bars:[{ t:1000, o:100, h:101, l:99, c:100 }], meta:{} });
  const ctx = context(['loadMarket'], {
    STATE:state, DEMO:false, feedErr:null, INSTR:{ BTC:{ bybit:'BTCUSDT', yahoo:'BTC', alt:[], dec:2 } },
    aktivaSyms:() => ['BTC'], fetchBybitBars:async () => { if(failing) throw Error(); return data(); },
    fetchBars:async () => { throw Error(); }, demoBars:data,
    fetchFeedBars:async () => [{ t:2000, o:101, h:102, l:100, c:101 }],
    mergeBars:(base, feed) => ({ bars:base.concat(feed), newest:2000, n:1, fardk:true }),
    buildContext:(inst, bars) => ({ inst, bars, px:bars.at(-1).c }),
    coreRead:noop, corePing:noop, renderFeedPill:noop, $:element
  });
  await ctx.loadMarket();
  assert.equal(state.ctx.BTC.simulated, true);
  assert.equal(ctx.DEMO, true);
  failing = false;
  await ctx.loadMarket();
  assert.equal(state.ctx.BTC.simulated, false);
  assert.equal(ctx.DEMO, false);
});

test('live bars with unchanged close update extremes and volume; old bars are ignored', () => {
  const state = { ctx:{ NQ:{ px:100, bars:[{ t:1000, o:100, h:101, l:99, c:100, v:1 }] } },
    quotes:{}, signals:[] };
  let evaluated = 0;
  const ctx = context(['taEmotLive','riktigaPriser'], {
    STATE:state, liveSenast:0, livePuls:0, aktivaSyms:() => ['NQ'],
    assignStatus:s => { evaluated++; return s; }, demoTick:noop,
    renderTape:noop, renderSignals:noop, renderMainChart:noop, renderTech:noop,
    renderDemo:noop, renderFeedPill:noop, corePing:noop
  });
  const updated = { t:1000, o:100, h:110, l:90, c:100, v:2 };
  ctx.taEmotLive(updated);
  assert.equal(state.ctx.NQ.bars[0].h, 110);
  assert.equal(state.ctx.NQ.bars[0].l, 90);
  assert.equal(state.ctx.NQ.bars[0].v, 2);
  assert.equal(evaluated, 1);
  state.liveNar = 123;
  ctx.taEmotLive(updated);
  assert.equal(evaluated, 1);
  assert.equal(state.liveNar, 123, 'duplicate polling must not make stale data look fresh');
  ctx.taEmotLive({ ...updated, t:500, c:80 });
  assert.equal(state.livePris, 100);
  assert.equal(state.ctx.NQ.px, 100);
  ctx.taEmotLive({ ...updated, t:2000 });
  assert.equal(state.ctx.NQ.bars.length, 2);
});

test('simulated prices are not displayed as account losses or available for manual closing', () => {
  const { state, account } = cryptoFixture();
  const nodes = new Map();
  const ctx = context(['renderKrypto'], {
    renderSummary:noop,
    STATE:state, KRYPTO:account, esc:x => String(x), krHandlarHar:() => true,
    $:key => { if(!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); }
  });
  ctx.renderKrypto();
  assert.equal(nodes.get('#krStang').disabled, true);
  assert.match(nodes.get('#krOppen').innerHTML, /Riktiga priser saknas/);
  assert.match(nodes.get('#krStats').innerHTML, /100,00/);
  state.ctx.BTC.simulated = false;
  ctx.renderKrypto();
  assert.equal(nodes.get('#krStang').disabled, false);
  assert.doesNotMatch(nodes.get('#krOppen').innerHTML, /Riktiga priser saknas/);
});

test('switching mode during loading queues a full refresh and discards old news', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const state = { lage:'nq', chartSym:'NQ', loading:false, refreshPending:false, modeVersion:0,
    loadedLage:null, signals:[], news:[], seNews:[], kalender:[{}], ctx:{} };
  const painted = [], markets = [], feeds = [];
  const ctx = context(['refresh','tillLage','loadNews'], {
    STATE:state, cycle:0, CFG:{ feeds:['nasdaq'], feedsSe:[] }, KRYPTO_FEEDS:['crypto'],
    localStorage:{ setItem:noop }, document:{ body:element() }, $:element,
    aktivaSyms:() => state.lage === 'krypto' ? ['BTC'] : ['NQ'],
    resetNet:noop, coreState:noop, renderChartSyms:noop, renderSignals:noop,
    loadSideQuotes:async () => {}, hamtaKalender:async () => {},
    fetchFeeds:async list => { feeds.push(...list); await pending; return list.map(title => ({ title })); },
    rensaNyheter:x => x, analyseHeadline:() => ({}), computeNewsBias:() => ({ nq:0, kr:0 }),
    corePing:noop, coreRead:noop,
    loadMarket:async () => { markets.push(state.lage); await pending; },
    paint:() => painted.push({ mode:state.lage, news:state.news[0]?.title }),
    demoTick:noop, kryptoTick:noop, bevakaAktiveringar:noop, demoHamtaServer:noop,
    renderDemo:noop, renderKrypto:noop, DEMO_NEWS:[], DEMO_NEWS_SE:[], esc:x => x
  });
  const first = ctx.refresh();
  ctx.tillLage('krypto');
  release();
  await first;
  assert.deepEqual(markets, ['nq','krypto']);
  assert.deepEqual(feeds, ['nasdaq','crypto']);
  assert.ok(painted.length);
  assert.ok(painted.every(p => p.mode === 'krypto' && p.news !== 'nasdaq'));
  assert.equal(state.news[0].title, 'crypto');
  assert.equal(state.loadedLage, 'krypto');
  assert.equal(state.loading, false);
});
