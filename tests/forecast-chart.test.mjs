import test from 'node:test';
import assert from 'node:assert/strict';
import {CHART_COLORS,createForecastChart,priceDecimals,niceTicks,timeTicks,slotState,comparisonStats} from '../forecast-chart.js';
import {TF,CHART_TFS} from '../forecast-config.js';

const C=CHART_COLORS,HOUR=TF['1h'].ms,DAY=86400000,T0=Date.UTC(2026,8,28);
const near=(a,b,eps,msg='')=>assert.ok(Math.abs(a-b)<=eps,`${msg} ${a} != ${b}`);
const sv=(x,dec)=>x.toLocaleString('sv-SE',{minimumFractionDigits:dec,maximumFractionDigits:dec});
const pct=x=>{const v=Math.round(x*10000)/100||0;return (v>0?'+':'')+sv(v,2)+' %';};
const stockholmClock=t=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Stockholm',hour:'2-digit',minute:'2-digit'}).format(t);
const deepFreeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.freeze(x);Object.values(x).forEach(deepFreeze);}return x;};
const mid=k=>k.args[0]+k.args[2]/2;

function makeBars(n,{start=T0,tf=HOUR,base=85000}={}){
  return Array.from({length:n},(_,i)=>{
    const o=base+Math.round(Math.sin(i/6)*300+i*2),c=o+(i%3===0?-70:90);
    return {t:start+i*tf,o,h:Math.max(o,c)+40+(i%5)*5,l:Math.min(o,c)-35-(i%4)*5,c,v:1000+i};
  });
}
// A stored forecast record (forecast-store shape) whose cutoff is bars[at].
function makeRecord(bars,{at=bars.length-1,H=20,tf=HOUR,tfKey='1h',id}={}){
  const cut=bars[at],base=cut.c,candles=[],bands=[];let prev=base;
  for(let h=1;h<=H;h++){
    const t=cut.t+h*tf,o=prev,c=base+12*h+(h%2?35:-20),w=25*Math.sqrt(h);
    candles.push({t,o,h:Math.max(o,c)+45,l:Math.min(o,c)-40,c});
    bands.push({t,q10:c-2*w,q25:c-w,q50:c,q75:c+w,q90:c+2*w});prev=c;
  }
  const forecast={model:'af-forecast-v1',cutoff:cut.t,base,unit:.004,horizon:H,k:30,candles,bands,medoid:{t:bars[5].t,d:.4},
    analogs:[bars[5].t],train:{from:bars[0].t,to:cut.t,n:at}};
  return deepFreeze({id:id??`f|u1|BTC|${tfKey}|${cut.t}|af-forecast-v1`,kind:'forecast',schema:1,uid:'u1',symbol:'BTC',tf:tfKey,
    model:'af-forecast-v1',createdAt:cut.t+tf+4000,cutoff:cut.t,cutoffClose:cut.t+tf,origin:'live',forecast,hash:'0123456789abcd'});
}
function sceneFrom(bars,over={},{tf=HOUR,tfKey='1h'}={}){
  const last=bars.at(-1),forming={t:last.t+tf,o:last.c,h:last.c+80,l:last.c-40,c:last.c+50,v:10},latest=makeRecord(bars,{tf,tfKey});
  return deepFreeze({symbol:'BTC',tf:tfKey,dec:0,bars,forming,latest,compare:latest,horizon:10,signals:[],levels:[],
    showBand:true,showSignals:true,showLevels:true,status:{reliable:true,text:'Live · uppdaterad 3 s sedan'},...over});
}
const scene=(over={})=>sceneFrom(makeBars(120),over);

// Records every drawing call with the style that was active, plus the current path for fill/stroke.
function fakeCanvas({width=800,height=400,listeners=false}={}){
  const calls=[],stack=[];let path=[];
  const ctx={fillStyle:'#000',strokeStyle:'#000',lineWidth:1,globalAlpha:1,font:'10px sans-serif',textAlign:'start',textBaseline:'alphabetic',lineJoin:'miter',lineCap:'butt',dash:[]};
  const keys=Object.keys(ctx);
  const rec=(op,extra)=>calls.push({op,fill:ctx.fillStyle,stroke:ctx.strokeStyle,lw:ctx.lineWidth,alpha:ctx.globalAlpha,dash:[...ctx.dash],font:ctx.font,align:ctx.textAlign,baseline:ctx.textBaseline,...extra});
  const finiteArgs=(op,args)=>{for(const a of args)if(typeof a==='number')assert.ok(Number.isFinite(a),op+' got a non-finite number');};
  Object.assign(ctx,{
    save(){stack.push(Object.fromEntries(keys.map(k=>[k,k==='dash'?[...ctx.dash]:ctx[k]])));},
    restore(){Object.assign(ctx,stack.pop()??{});},
    setLineDash(a){ctx.dash=[...a];},
    measureText:s=>({width:String(s).length*6}),
    setTransform(...a){finiteArgs('setTransform',a);rec('setTransform',{args:a});},
    beginPath(){path=[];},
    moveTo(x,y){finiteArgs('moveTo',[x,y]);path.push(['M',x,y]);},
    lineTo(x,y){finiteArgs('lineTo',[x,y]);path.push(['L',x,y]);},
    closePath(){path.push(['Z']);},
    rect(...a){finiteArgs('rect',a);path.push(['R',...a]);},
    roundRect(x,y,w,h){finiteArgs('roundRect',[x,y,w,h]);path.push(['R',x,y,w,h]);},
    clip(){rec('clip',{path:[...path]});},
    fill(){rec('fill',{path:[...path]});},
    stroke(){rec('stroke',{path:[...path]});},
    fillRect(...a){finiteArgs('fillRect',a);rec('fillRect',{args:a});},
    strokeRect(...a){finiteArgs('strokeRect',a);rec('strokeRect',{args:a});},
    fillText(text,x,y){finiteArgs('fillText',[x,y]);rec('fillText',{text,args:[x,y]});}
  });
  const handlers={};
  const canvas={clientWidth:width,clientHeight:height,width:0,height:0,style:{},getContext:type=>type==='2d'?ctx:null};
  if(listeners)Object.assign(canvas,{
    addEventListener(type,fn){(handlers[type]??=[]).push(fn);},
    removeEventListener(type,fn){handlers[type]=(handlers[type]??[]).filter(f=>f!==fn);},
    getBoundingClientRect:()=>({left:0,top:0,width:canvas.clientWidth,height:canvas.clientHeight}),
    setPointerCapture(){},releasePointerCapture(){},focus(){}
  });
  const fire=(type,e={})=>{for(const fn of handlers[type]??[])fn({preventDefault(){},pointerId:1,pointerType:'mouse',button:0,...e,type});};
  return {canvas,ctx,calls,handlers,fire};
}
function setup({width=800,height=400,dpr=1,raf=null,tooltip=null,listeners=false,reducedMotion=true,onViewChange}={}){
  const f=fakeCanvas({width,height,listeners});
  return {...f,chart:createForecastChart(f.canvas,{tooltip,raf,dpr,reducedMotion,onViewChange})};
}
// Slot geometry from the public view: x follows time, every slot is barPx wide.
const xOf=(chart,t,tf=HOUR)=>{const v=chart.view();return v.plot.right-(v.rightT-t)/tf*v.barPx;};
const centre=(chart,t,tf=HOUR)=>xOf(chart,t,tf)+chart.view().barPx/2;
const timeAt=(chart,x)=>{const v=chart.view();return v.rightT-(v.plot.right-x)/v.barPx*HOUR;};
const texts=calls=>calls.filter(k=>k.op==='fillText').map(k=>k.text);
// The tooltip binds a label to its number with no-break spaces; the content is compared with plain spaces.
const plain=s=>s.replace(/\xa0/g,' ');

test('priceDecimals keeps about five significant digits within 0–10 decimals',()=>{
  for(const [p,dec] of [[85230,0],[10000,0],[3000,1],[1000,1],[150,2],[99.99,3],[2.5,4],[1,4],[.6,5],[.000012,9],[1e-12,10],[1e9,0]])
    assert.equal(priceDecimals(p),dec,String(p));
  for(const bad of [0,-5,NaN,Infinity,null,undefined,'85'])assert.equal(priceDecimals(bad),2);
});

test('niceTicks returns round, evenly spaced price ticks without float noise',()=>{
  assert.deepEqual(niceTicks(0,10,5),[0,2,4,6,8,10]);
  assert.deepEqual(niceTicks(84123,86789,5),[84500,85000,85500,86000,86500]);
  assert.deepEqual(niceTicks(86789,84123,5),[84500,85000,85500,86000,86500],'reversed bounds');
  assert.deepEqual(niceTicks(.1,.7,6),[.1,.2,.3,.4,.5,.6,.7]);
  assert.deepEqual(niceTicks(2.31,2.49,4),[2.35,2.4,2.45]);
  assert.deepEqual(niceTicks(.0000121,.0000134,4),[.0000125,.000013]);
  const flat=niceTicks(100,100,4);assert.ok(flat.length>=3&&flat.includes(100)&&flat.every(v=>v>99&&v<101));
  assert.deepEqual(niceTicks(NaN,1),[]);assert.deepEqual(niceTicks(0,Infinity),[]);
});

test('timeTicks sit on candle opens at round Stockholm times and label day starts',()=>{
  // 1h candles at 9 px: every 12 hours at local midnight and noon (CEST = UTC+2 in early October).
  const t0=Date.UTC(2026,9,3,0),t1=Date.UTC(2026,9,6,0),ticks=timeTicks(t0,t1,HOUR,9);
  assert.deepEqual(ticks.slice(0,4),[
    {t:Date.UTC(2026,9,3,10),label:'12:00',major:false},{t:Date.UTC(2026,9,3,22),label:'4 okt',major:true},
    {t:Date.UTC(2026,9,4,10),label:'12:00',major:false},{t:Date.UTC(2026,9,4,22),label:'5 okt',major:true}]);
  for(const k of ticks){assert.equal(k.t%HOUR,0);assert.ok(k.t>=t0&&k.t<=t1);}
  // Across the end of summer time (25 Oct 2026 03:00 CEST → 02:00 CET) the ticks stay on local midnight and noon.
  assert.deepEqual(timeTicks(Date.UTC(2026,9,24,12),Date.UTC(2026,9,26,12),HOUR,9),[
    {t:Date.UTC(2026,9,24,22),label:'25 okt',major:true},{t:Date.UTC(2026,9,25,11),label:'12:00',major:false},
    {t:Date.UTC(2026,9,25,23),label:'26 okt',major:true},{t:Date.UTC(2026,9,26,11),label:'12:00',major:false}]);
  // 15m candles: every third local hour.
  const q=timeTicks(Date.UTC(2026,9,4,0),Date.UTC(2026,9,4,12),TF['15m'].ms,9);
  assert.deepEqual(q.map(k=>k.label),['03:00','06:00','09:00','12:00']);assert.equal(q[0].t,Date.UTC(2026,9,4,1));
  // 4h candles: every second local day on its first candle (02:00 local = 00:00 UTC).
  const f=timeTicks(Date.UTC(2026,9,1),Date.UTC(2026,9,15),TF['4h'].ms,9);
  assert.ok(f.length>=6);
  f.forEach((k,i)=>{assert.equal(k.t%DAY,0);assert.equal(k.major,true);assert.equal(k.label,new Date(k.t).getUTCDate()+' okt');if(i)assert.equal(k.t-f[i-1].t,2*DAY);});
  // Daily candles at 9 px: every other Monday; at 2 px: quarter starts.
  const w=timeTicks(Date.UTC(2026,0,1),Date.UTC(2026,11,31),DAY,9);
  w.forEach((k,i)=>{assert.equal(new Date(k.t).getUTCDay(),1);if(i)assert.equal(k.t-w[i-1].t,14*DAY);});
  assert.deepEqual(timeTicks(Date.UTC(2025,0,1),Date.UTC(2026,11,31),DAY,2).map(k=>k.label),['1 jan','1 apr','1 jul','1 okt','1 jan','1 apr','1 jul','1 okt']);
  // Labels never crowd: at least 84 px between ticks for every chart timeframe and zoom (no DST change in this window).
  for(const tf of CHART_TFS)for(const px of [1.5,4,9,20,60]){
    const ms=TF[tf].ms,list=timeTicks(Date.UTC(2026,9,1),Date.UTC(2026,9,1)+Math.min(1500*ms,22*DAY),ms,px);
    list.forEach((k,i)=>{assert.equal(k.t%ms,0);if(i)assert.ok((k.t-list[i-1].t)/ms*px>=84,`${tf} @ ${px}px`);});
  }
  assert.deepEqual(timeTicks(10,0,HOUR,9),[]);assert.deepEqual(timeTicks(0,10,0,9),[]);assert.deepEqual(timeTicks(0,HOUR,HOUR,NaN),[]);
});

test('slotState marks forecast candles at or before the last real candle as realized',()=>{
  const bars=makeBars(30),rec=makeRecord(bars,{at:24,H:10}),last=bars.at(-1).t;
  const states=slotState(rec,last);
  assert.deepEqual(states,[...Array(5).fill('realized'),...Array(5).fill('future')]);
  assert.deepEqual(slotState(rec.forecast,last),states,'a bare forecast works too');
  assert.deepEqual(slotState(rec,last+HOUR),[...Array(6).fill('realized'),...Array(4).fill('future')],'the forming candle counts as real');
  assert.deepEqual(slotState(rec,null),Array(10).fill('future'));
  assert.deepEqual(slotState(null,last),[]);
});

test('comparisonStats measures forecast against closed outcomes only, relative to the base',()=>{
  const t=k=>T0+k*HOUR,base=100;
  const forecast=deepFreeze({model:'af-forecast-v1',cutoff:t(0),base,horizon:5,
    candles:[101,99,102,100,98].map((c,i)=>({t:t(i+1),o:base,h:Math.max(base,c)+1,l:Math.min(base,c)-1,c})),
    bands:[[99,100,101,102,103],[96,98,99,100,101],[99,100,102,103,104],[97,98,100,101,103],[95,96,98,99,100]]
      .map(([q10,q25,q50,q75,q90],i)=>({t:t(i+1),q10,q25,q50,q75,q90}))});
  // Outcomes for slots 1–4; slot 5 has no closed candle yet.
  const bars=[100,102,95,103.5,100.5].map((c,i)=>({t:t(i),o:base,h:Math.max(base,c),l:Math.min(base,c),c}));
  const s=comparisonStats(forecast,bars,5);
  // errors (forecast − real)/base: −1 %, +4 %, −1,5 %, −0,5 %. Slot 4 forecast equals the base, so it has no direction.
  assert.deepEqual({...s,mae:undefined},{elapsed:4,total:5,mae:undefined,dirHits:3,dirN:3,in80:3,in50:2,lastError:-.005});
  near(s.mae,.0175,1e-12);
  const two=comparisonStats({forecast},bars,2);
  assert.deepEqual({...two,mae:undefined},{elapsed:2,total:2,mae:undefined,dirHits:2,dirN:2,in80:1,in50:1,lastError:.04});
  near(two.mae,.025,1e-12);
  // A real close against the forecast's direction is a miss.
  const miss=comparisonStats(forecast,[...bars.slice(0,3),{...bars[3],c:99,h:100,l:99},bars[4]],5);
  assert.equal(miss.dirHits,2);assert.equal(miss.dirN,3);
  assert.deepEqual(comparisonStats(forecast,bars.slice(0,1),5),{elapsed:0,total:5,mae:null,dirHits:0,dirN:0,in80:0,in50:0,lastError:null});
  assert.equal(comparisonStats(null,bars,5),null);
});

test('the chart draws the forecast region, its dashed start, "Data t.o.m." and the exact pill label',()=>{
  const {chart,calls}=setup(),d=scene();chart.setData(d);chart.render();
  const v=chart.view(),cut=d.latest.cutoff;
  assert.deepEqual({rightT:v.rightT,barPx:v.barPx,price:v.price,follow:v.follow},{rightT:cut+13*HOUR,barPx:9,price:null,follow:true},
    'default: end of slot horizon plus two slots');
  assert.ok(texts(calls).includes('Forecast — estimated scenario'));
  assert.ok(texts(calls).includes('Data t.o.m. '+stockholmClock(d.latest.cutoffClose)));
  const region=calls.find(k=>k.op==='fillRect'&&k.fill===C.region);
  near(region.args[0],xOf(chart,cut+HOUR),1e-9);near(region.args[0]+region.args[2],xOf(chart,cut+11*HOUR),1e-9);
  near(region.args[3],v.plot.bottom-v.plot.top,1e-9);
  const start=calls.find(k=>k.op==='stroke'&&k.dash.length&&k.path.length===2&&k.path[0][1]===k.path[1][1]&&Math.abs(k.path[0][1]-xOf(chart,cut+HOUR))<1);
  assert.ok(start,'dashed vertical line between the cutoff candle and slot 1');
  const grid=calls.filter(k=>k.op==='stroke'&&k.stroke===C.grid);
  assert.ok(grid.length);for(const g of grid){assert.deepEqual(g.dash,[],'grid is never dashed');assert.equal(g.lw,1,'hairline');}
  // Price axis labels are sv-SE formatted round ticks; time axis labels are Stockholm times.
  assert.ok(texts(calls).includes(sv(85000,0)));assert.ok(texts(calls).includes('12:00'));
  // Longer timeframes add the date to the cutoff label.
  const four=setup(),bars4=makeBars(60,{tf:TF['4h'].ms,start:Date.UTC(2026,8,20)});
  four.chart.setData(sceneFrom(bars4,{},{tf:TF['4h'].ms,tfKey:'4h'}));four.chart.render();
  assert.ok(texts(four.calls).includes('Data t.o.m. 30 sep 02:00'));
});

test('forecast length N shows N gray candles, a translucent body and wick in one tone with no brighter rim, slot 1 behind the forming candle',()=>{
  const {chart,calls}=setup(),d=scene();chart.setData(d);chart.render();
  const shown=d.latest.forecast.candles.slice(0,10),bodies=calls.filter(k=>k.op==='fillRect'&&k.fill===C.fcFill);
  // The cutoff is the newest closed candle, so slot 1 is the forming candle's period: a gray candle too.
  assert.equal(shown[0].t,d.forming.t);
  assert.equal(bodies.length,10,'10 slots from the start line, 10 gray candles');
  shown.forEach((c,i)=>{
    const x=centre(chart,c.t),body=bodies[i];near(mid(body),x,1);
    const price=y=>chart.hitTest(x,y).price,tol=3*(price(100)-price(101));
    near(price(body.args[1]),Math.max(c.o,c.c),tol,'body top on the shared price scale');
    near(price(body.args[1]+body.args[3]),Math.min(c.o,c.c),tol,'body bottom');
    // An edge brighter than the fill read as a light rim around a darker middle; short bodies had none and looked darker.
    // (The only edge in slot 1 is the forming candle's own dashed outline.)
    assert.ok(!calls.some(k=>k.op==='strokeRect'&&!k.dash.length&&Math.abs(mid(k)-x)<1),'no edge of its own around the body');
    const wick=calls.find(k=>k.op==='stroke'&&k.stroke===C.fcFill&&k.path.length===4&&k.path.every(p=>Math.abs(p[1]-x)<1));
    assert.ok(wick,'upper and lower wick in the body\'s own gray');
    assert.ok(wick.path[1][2]<=body.args[1]+1e-9&&wick.path[2][2]>=body.args[1]+body.args[3]-1e-9,'the wick stops at the body, so no pixel is gray twice');
    near(price(Math.min(...wick.path.map(p=>p[2]))),c.h,tol,'wick reaches the high');
    near(price(Math.max(...wick.path.map(p=>p[2]))),c.l,tol,'wick reaches the low');
  });
  // Slot 1 lies behind the forming candle: its gray body first, then the real body, then the real candle's dashed outline.
  const fx=centre(chart,d.forming.t),at=f=>calls.findIndex(k=>f(k)&&Math.abs(mid(k)-fx)<1);
  const gray=at(k=>k.op==='fillRect'&&k.fill===C.fcFill),real=at(k=>k.op==='fillRect'&&(k.fill===C.up||k.fill===C.down)),outline=at(k=>k.op==='strokeRect'&&k.dash.length);
  assert.ok(gray>=0&&gray<real&&real<outline,'gray candle, then the forming candle over it, then its dashed outline');
  const last=centre(chart,d.latest.forecast.candles[9].t);
  assert.ok(bodies.every(b=>mid(b)<=last+1),'nothing beyond the chosen horizon');
  for(const n of [5,20]){chart.setData({...d,horizon:n});calls.length=0;chart.render();assert.equal(calls.filter(k=>k.op==='fillRect'&&k.fill===C.fcFill).length,n,'length '+n);}
  // An older version whose slots have closed candles keeps those as outlines; only the slots after them are gray candles.
  const old=makeRecord(d.bars,{at:115,id:'older'});chart.setData({...d,latest:old,compare:old,horizon:10});calls.length=0;chart.render();
  assert.equal(calls.filter(k=>k.op==='fillRect'&&k.fill===C.fcFill).length,6,'the forming slot and the five after it');
});

test('future forecast bodies read as solid gray candles on every background the forecast region has',()=>{
  const parse=s=>{const m=/rgba?\(([^)]+)\)/.exec(s);if(m){const [r,g,b,a=1]=m[1].split(',').map(Number);return {r,g,b,a};}
    const n=parseInt(s.slice(1),16);return {r:n>>16,g:n>>8&255,b:n&255,a:1};};
  const over=(top,below)=>{const t=parse(top),b=typeof below==='string'?parse(below):below;return {r:t.r*t.a+b.r*(1-t.a),g:t.g*t.a+b.g*(1-t.a),b:t.b*t.a+b.b*(1-t.a),a:1};};
  const lum=c=>[c.r,c.g,c.b].reduce((s,v,i)=>{v/=255;return s+[.2126,.7152,.0722][i]*(v<=.04045?v/12.92:((v+.055)/1.055)**2.4);},0);
  const contrast=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  // The surface inside the forecast region, inside the 80 % band and inside the 50 % band.
  const plain=over(C.region,C.surface),band80=over(C.band80,plain),band50=over(C.band50,band80);
  for(const [where,bg] of Object.entries({plain,band80,band50}))
    assert.ok(contrast(over(C.fcFill,bg),bg)>=2.5,where+': the body stands out from what is behind it');
  // Body and wick are one colour, as on a real candle: no second, brighter edge colour exists.
  assert.ok(!('fcStroke' in C));
  // Neutral gray and translucent, so a forecast candle never passes for a rising or falling real one.
  const chroma=c=>Math.max(c.r,c.g,c.b)-Math.min(c.r,c.g,c.b),fill=parse(C.fcFill);
  assert.ok(chroma(fill)<=30&&fill.a<1);assert.ok(chroma(parse(C.up))>=140&&chroma(parse(C.down))>=140);
});

test('the forming candle\'s "pågår" mark sits on the time axis right under its slot, never over the candles beside it, and stays whole',()=>{
  const d=scene(),{chart,calls,fire}=setup({listeners:true}),w=6*'pågår'.length;
  const mark=()=>{calls.length=0;chart.render();return calls.findLast(k=>k.op==='fillText'&&k.text==='pågår');};
  chart.setData(d);
  let k=mark(),v=chart.view();
  // On the time axis, centred under the forming candle (the first slot after the start line).
  assert.ok(k.args[1]>v.plot.bottom&&k.args[1]<v.plot.bottom+26,'on the time axis');
  near(k.args[0],centre(chart,d.forming.t),1e-9,'under the forming candle');
  // A pill with a dashed edge, like the candle's own dashed outline.
  const i=calls.indexOf(k),edge=calls.slice(0,i).findLast(c=>c.op==='stroke');
  assert.ok(edge.dash.length&&edge.path[0][2]>=v.plot.bottom,'dashed pill on the axis');
  // Nothing of it in the plot: no word, leader or tick among the candles.
  assert.ok(!calls.some(c=>c.op==='fillText'&&c.text==='pågår'&&c.args[1]<=v.plot.bottom));
  assert.ok(!calls.some(c=>c.op==='stroke'&&c.stroke===C.axisText),'no leader line');
  // Time labels it would cover are left out.
  for(const l of calls.filter(c=>c.op==='fillText'&&c.align==='center'&&c.args[1]===v.plot.bottom+13&&c.text!=='pågår')){
    const half=l.text.length*3;assert.ok(l.args[0]+half<=k.args[0]-w/2-6||l.args[0]-half>=k.args[0]+w/2+6,'time label '+l.text);
  }
  // Panned until the forming candle's centre is 2 px inside the right edge: the mark moves in and stays whole.
  chart.panBy(v.plot.right-2-centre(chart,d.forming.t),0);
  k=mark();v=chart.view();
  assert.ok(k.args[0]-w/2>=v.plot.left&&k.args[0]+w/2<=v.plot.right,'whole inside the plot\'s width');
  // The crosshair's time tag on or beside it takes its place, as level tags yield to its price tag: a strip of the mark
  // next to the time read as part of it ("påg 5 okt 17:00", "pågår" against "5 okt 18:00"). Clear of the tag it is back.
  chart.resetView();v=chart.view();
  const F=centre(chart,d.forming.t),dashed=()=>calls.some(c=>c.op==='stroke'&&c.stroke==='rgba(230,237,243,.55)'&&c.path[0]?.[2]>v.plot.bottom);
  for(const n of [-4,-3,-2,-1,0,1,2,3,4]){
    fire('pointermove',{clientX:F+n*v.barPx,clientY:150});
    assert.equal(mark(),undefined,n+' slots from the forming candle: no word');assert.equal(dashed(),false,n+' slots: no dashed edge');
    const tag=calls.find(c=>c.op==='fill'&&c.fill==='#283240'&&c.path[0][2]>v.plot.bottom);assert.ok(tag,'the crosshair\'s time tag');
  }
  for(const n of [-8,-12]){fire('pointermove',{clientX:F+n*v.barPx,clientY:150});assert.ok(mark()&&dashed(),n+' slots away it is drawn');}
  fire('pointerleave');assert.ok(mark());
  // With the forming candle out of view there is no mark; without a forecast it is the same mark.
  chart.panBy(300,0);assert.equal(mark(),undefined);
  chart.resetView();chart.setData({...d,latest:null,compare:null});k=mark();
  near(k.args[0],centre(chart,d.forming.t),1);assert.ok(k.args[1]>chart.view().plot.bottom);
});

test('realized forecast slots are thin outlines drawn before the real candle in the same slot',()=>{
  const d=scene(),compare=makeRecord(d.bars,{at:115,id:'older'}),{chart,calls}=setup();
  chart.setData({...d,compare});chart.render();
  const solid=k=>k.op==='strokeRect'&&k.stroke===C.fcOutline&&!k.dash.length;
  const realized=compare.forecast.candles.slice(0,10).filter(c=>c.t<=d.forming.t);
  assert.equal(realized.length,5,'four closed candles and the forming one');
  for(const c of realized){
    const x=centre(chart,c.t);
    const outline=calls.findIndex(k=>solid(k)&&Math.abs(mid(k)-x)<1);
    const real=calls.findIndex(k=>k.op==='fillRect'&&(k.fill===C.up||k.fill===C.down)&&Math.abs(mid(k)-x)<1);
    assert.ok(outline>=0&&real>=0&&outline<real,'outline sits behind the real candle');
    assert.equal(calls[outline].lw,1);
    // Under a closed candle no gray body; the forming candle's slot is the latest version's slot 1, a gray candle behind it.
    const gray=calls.findIndex(k=>k.op==='fillRect'&&k.fill===C.fcFill&&Math.abs(mid(k)-x)<1);
    if(c.t<d.forming.t)assert.equal(gray,-1,'no filled forecast body under a closed candle');
    else assert.ok(gray>=0&&gray<real,'the latest version\'s gray candle behind the forming one');
  }
  // In the forming candle's slot: the older version's outline and the latest version's gray candle, no second outline.
  const fx=centre(chart,d.forming.t);
  assert.equal(calls.filter(k=>solid(k)&&Math.abs(mid(k)-fx)<1).length,1);
  // The older version's unrealized slots are dotted outlines, plus its thin dashed median.
  assert.equal(calls.filter(k=>k.op==='strokeRect'&&k.stroke===C.fcOutline&&k.dash.length).length,5);
  assert.ok(calls.some(k=>k.op==='stroke'&&k.stroke===C.fcOutline&&k.dash.length&&k.lw===1&&k.path.length===11));
  // When the comparison is the latest version itself, nothing is doubled and nothing is dotted: its slot 1 is only the gray candle.
  calls.length=0;chart.setData(d);chart.render();
  assert.equal(calls.filter(k=>solid(k)&&Math.abs(mid(k)-fx)<1).length,0);
  assert.equal(calls.filter(k=>k.op==='fillRect'&&k.fill===C.fcFill&&Math.abs(mid(k)-fx)<1).length,1);
  assert.equal(calls.filter(k=>k.op==='strokeRect'&&k.stroke===C.fcOutline&&k.dash.length).length,0);
  // The forming candle itself has a dashed outline and a "pågår" tick.
  assert.ok(texts(calls).includes('pågår'));
  assert.ok(calls.some(k=>k.op==='strokeRect'&&k.dash.length&&k.stroke!==C.fcOutline&&Math.abs(mid(k)-fx)<1));
});

test('an older compared version nobody picked is drawn only where its outcome is known, never over the latest forecast',()=>{
  const d=scene(),compare=makeRecord(d.bars,{at:115,id:'older'}),{chart,calls}=setup();
  chart.setData({...d,compare,compareAhead:false});chart.render();
  const outlines=dashed=>calls.filter(k=>k.op==='strokeRect'&&k.stroke===C.fcOutline&&!!k.dash.length===dashed);
  assert.equal(outlines(true).length,0,'no dotted slots ahead of the data');
  assert.equal(outlines(false).length,5,'its five slots with an outcome (four closed, one forming); the latest version\'s slot 1 is a gray candle');
  // Its median runs from its cutoff through the slots with an outcome only.
  const med=calls.find(k=>k.op==='stroke'&&k.stroke===C.fcOutline&&k.dash.length&&k.lw===1&&k.path.length>2);
  assert.equal(med.path.length,1+5);near(med.path.at(-1)[1],centre(chart,d.forming.t),1e-9);
  // Picked (compareAhead not false), its slots ahead are dotted again, as in the test above.
  calls.length=0;chart.setData({...d,compare,compareAhead:true});chart.render();
  assert.equal(outlines(true).length,5);
  // A slot that is not drawn does not answer the pointer either.
  const solo=setup();solo.chart.setData({...d,latest:null,compare,compareAhead:false});solo.chart.render();
  const y=(solo.chart.view().plot.top+solo.chart.view().plot.bottom)/2,ahead=centre(solo.chart,d.forming.t+HOUR);
  assert.equal(solo.chart.hitTest(ahead,y).kind,'empty');
  assert.equal(solo.chart.hitTest(centre(solo.chart,d.bars[117].t),y).compare.candle.t,d.bars[117].t,'its outcome is still compared');
  solo.chart.setData({...d,latest:null,compare});
  assert.equal(solo.chart.hitTest(ahead,y).kind,'forecast');
});

test('the uncertainty band starts at the cutoff close with zero width and widens; the median is dashed',()=>{
  const {chart,calls}=setup(),d=scene(),f=d.latest.forecast,H=10;chart.setData(d);chart.render();
  for(const [fill,lo,hi] of [[C.band80,'q10','q90'],[C.band50,'q25','q75']]){
    const poly=calls.find(k=>k.op==='fill'&&k.fill===fill);assert.ok(poly,fill);
    assert.equal(poly.path.at(-1)[0],'Z');
    const pts=poly.path.filter(p=>p[0]!=='Z');assert.equal(pts.length,1+2*H);
    const [m,sx,sy]=pts[0];assert.equal(m,'M');
    near(sx,centre(chart,f.cutoff),1e-9);near(chart.hitTest(sx,sy).price,f.base,1e-6);
    let width=0;
    for(let h=1;h<=H;h++){
      const up=pts[h],down=pts[2*H+1-h],x=centre(chart,f.bands[h-1].t);
      near(up[1],x,1e-9);near(down[1],x,1e-9);
      near(chart.hitTest(up[1],up[2]).price,f.bands[h-1][hi],1e-6);near(chart.hitTest(down[1],down[2]).price,f.bands[h-1][lo],1e-6);
      assert.ok(down[2]-up[2]>width,'widens');width=down[2]-up[2];
    }
  }
  const med=calls.find(k=>k.op==='stroke'&&k.stroke===C.median);
  assert.ok(med.dash.length>0);assert.equal(med.path.length,1+H);
  near(chart.hitTest(med.path[3][1],med.path[3][2]).price,f.bands[2].q50,1e-6);
  calls.length=0;chart.setData({...d,showBand:false});chart.render();
  assert.ok(!calls.some(k=>k.op==='fill'&&(k.fill===C.band80||k.fill===C.band50)));
  assert.ok(!calls.some(k=>k.op==='stroke'&&k.stroke===C.median));
});

test('signals show ▲ KÖP under the low and ▼ SÄLJ over the high of their candle',()=>{
  const d=scene(),buy=d.bars[100],sell=d.bars[105],{chart,calls}=setup();
  const signals=[{id:'s1',side:'long',barTime:buy.t,tf:'1h',symbol:'BTC'},{id:'s2',side:'short',barTime:sell.t},
    {id:'s3',side:'long',barTime:d.bars[110].t,tf:'4h'}];
  chart.setData({...d,signals});chart.render();
  const k=calls.filter(c=>c.op==='fillText'&&c.text==='KÖP'),s=calls.filter(c=>c.op==='fillText'&&c.text==='SÄLJ');
  assert.equal(k.length,1,'a signal from another timeframe is not drawn');assert.equal(s.length,1);
  near(k[0].args[0],centre(chart,buy.t),1e-9);near(s[0].args[0],centre(chart,sell.t),1e-9);
  const price=(x,y)=>chart.hitTest(x,y).price;
  assert.ok(price(k[0].args[0],k[0].args[1])<buy.l,'KÖP below the low');assert.ok(price(s[0].args[0],s[0].args[1])>sell.h,'SÄLJ above the high');
  const up=calls.find(c=>c.op==='fill'&&c.fill===C.up&&c.path.length===4),down=calls.find(c=>c.op==='fill'&&c.fill===C.down&&c.path.length===4);
  assert.ok(price(up.path[0][1],up.path[0][2])<buy.l&&up.path[1][2]>up.path[0][2],'▲ points up from under the low');
  assert.ok(price(down.path[0][1],down.path[0][2])>sell.h&&down.path[1][2]<down.path[0][2],'▼ points down from over the high');
  calls.length=0;chart.setData({...d,signals,showSignals:false});chart.render();
  assert.ok(!texts(calls).some(t=>t==='KÖP'||t==='SÄLJ'));
});

test('levels draw entry, SL, TP and liquidation lines with zones and right-axis tags',()=>{
  const d=scene(),from=d.bars[110].t,{chart,calls}=setup();
  const levels=[{kind:'entry',price:85300,from,label:'Entry'},{kind:'sl',price:85000,from,label:'SL'},
    {kind:'tp',price:85750,from,label:'TP'},{kind:'liq',price:84900,from,label:'Likv.'}];
  chart.setData({...d,levels});chart.render();
  const v=chart.view(),x0=xOf(chart,from);
  for(const [want,fill] of [['Entry '+sv(85300,0),'rgba(159,176,192,0.9)'],['SL '+sv(85000,0),'rgba(226,72,60,0.9)'],
    ['TP '+sv(85750,0),'rgba(20,167,160,0.9)'],['Likv. '+sv(84900,0),'rgba(240,160,32,0.9)']]){
    const i=calls.findIndex(k=>k.op==='fillText'&&k.text===want);assert.ok(i>0,want);
    assert.equal(calls.slice(0,i).findLast(k=>k.op==='fill').fill,fill,'tag filled with the line colour');
    assert.ok(calls[i].args[0]>v.plot.right,'tag on the price axis');
  }
  const line=(color,price)=>calls.find(k=>k.op==='stroke'&&k.stroke===color&&k.path.length===2&&k.path[0][2]===k.path[1][2]&&
    Math.abs(k.path[0][1]-x0)<1&&k.path[1][1]===v.plot.right&&Math.abs(chart.hitTest(200,k.path[0][2]).price-price)<5);
  assert.deepEqual(line(C.entry,85300).dash,[],'entry solid');
  assert.deepEqual(line(C.sl,85000).dash,[6,4],'SL dashed');assert.deepEqual(line(C.tp,85750).dash,[6,4],'TP dashed');
  assert.deepEqual(line(C.liq,84900).dash,[1,3],'liquidation dotted');
  for(const [fill,a,b] of [['rgba(226,72,60,0.07)',85300,85000],['rgba(20,167,160,0.07)',85300,85750]]){
    const z=calls.find(k=>k.op==='fillRect'&&k.fill===fill);assert.ok(z,fill);
    near(z.args[0],x0,1e-9);near(z.args[0]+z.args[2],v.plot.right,1e-9);
    const p=y=>chart.hitTest(300,y).price;
    near(p(z.args[1]),Math.max(a,b),1e-6);near(p(z.args[1]+z.args[3]),Math.min(a,b),1e-6);
  }
  // Price-axis tick labels that a tag would cover are left out instead of peeking out behind it.
  const tagYs=calls.filter(k=>k.op==='fillText'&&/^(Entry|SL|TP|Likv\.) /.test(k.text)).map(k=>k.args[1]);
  const tickLabels=calls.filter(k=>k.op==='fillText'&&k.fill===C.axisText&&k.args[0]===v.plot.right+8);
  assert.ok(tickLabels.length>=3);
  for(const label of tickLabels)assert.ok(tagYs.every(y=>Math.abs(y-label.args[1])>=15),label.text);
  // A level outside the visible prices is pinned to the edge with an arrow towards it.
  calls.length=0;chart.setData({...d,levels:[{kind:'tp',price:90000,from,label:'TP'}]});chart.render();
  assert.ok(texts(calls).includes('▲ TP '+sv(90000,0)));
  calls.length=0;chart.setData({...d,levels,showLevels:false});chart.render();
  assert.ok(!texts(calls).some(t=>/^(Entry|SL|TP|Likv\.) /.test(t)));
});

test('on a narrow chart long level tags reach into the plot instead of widening the price axis past 30 % of the width',()=>{
  // Long prices (four decimals here, ten on PEPE) make "Entry 85 300,0000" wider than a third of a 300 px phone chart.
  const d=scene({dec:4}),from=d.bars[110].t,levels=[{kind:'entry',price:85300,from,label:'Entry'},{kind:'sl',price:85000,from,label:'SL'},
    {kind:'tp',price:85750,from,label:'TP'}],{chart,calls}=setup({width:300,height:400});
  chart.setData({...d,levels});chart.render();
  const v=chart.view(),axis=300-v.plot.right,tag=calls.find(k=>k.op==='fillText'&&k.text==='Entry '+sv(85300,4));
  assert.ok(axis<=Math.ceil(300*.3),'axis '+axis+' px');
  assert.ok(axis>=6*sv(85470,4).length+20,'the axis still fits its own price labels');
  assert.ok(tag.args[0]-6<v.plot.right,'the wider tag reaches into the plot');assert.ok(tag.args[0]+6*tag.text.length+6<=300,'and stays whole');
  // A wide chart still gives the tags the whole axis, and a resize recomputes the share.
  const wide=setup({width:800,height:400});wide.chart.setData({...d,levels});wide.chart.render();
  const w=wide.chart.view(),wtag=wide.calls.find(k=>k.op==='fillText'&&k.text==='Entry '+sv(85300,4));
  assert.ok(wtag.args[0]>w.plot.right,'on the axis');
  wide.canvas.clientWidth=300;wide.chart.resize();assert.equal(wide.chart.view().plot.right,v.plot.right);
});

test('the last price has a dotted line and a coloured tag on the price axis',()=>{
  const d=scene(),{chart,calls}=setup();chart.setData(d);chart.render();
  const i=calls.findIndex(k=>k.op==='fillText'&&k.text===sv(d.forming.c,0));assert.ok(i>0);
  assert.equal(calls.slice(0,i).findLast(k=>k.op==='fill').fill,'rgba(20,167,160,0.9)');
  const line=calls.find(k=>k.op==='stroke'&&k.stroke==='rgba(20,167,160,0.8)');
  assert.deepEqual(line.dash,[1,3]);near(chart.hitTest(100,line.path[0][2]).price,d.forming.c,5);
});

test('unreliable data shows an amber badge with the status text in the top-left corner',()=>{
  const text='Fördröjd data (21 s) — nya demoaffärer pausade',{chart,calls}=setup();
  chart.setData(scene({status:{reliable:false,text}}));chart.render();
  const i=calls.findIndex(k=>k.op==='fillText'&&k.text===text);assert.ok(i>0,'badge text');
  assert.equal(calls[i].fill,C.surface);assert.ok(calls[i].args[0]<40&&calls[i].args[1]<30,'top-left');
  assert.equal(calls.slice(0,i).findLast(k=>k.op==='fill').fill,'rgba(240,160,32,0.92)');
  calls.length=0;chart.setData(scene());chart.render();assert.ok(!texts(calls).includes(text));
  calls.length=0;chart.setData(scene({status:null}));chart.render();assert.ok(!texts(calls).includes(text));
  // On a phone the pill moves below the badge instead of covering it.
  const narrow=setup({width:360,height:500});narrow.chart.setData(scene({status:{reliable:false,text}}));narrow.chart.render();
  const pill=narrow.calls.find(k=>k.op==='fillText'&&k.text==='Forecast — estimated scenario'),badge=narrow.calls.find(k=>k.op==='fillText'&&k.text.startsWith('Fördröjd'));
  assert.ok(pill.args[1]>badge.args[1]+15);
});

test('a normal load is no warning: no amber badge, and the empty chart says it is fetching candles',()=>{
  const d=scene(),empty={...d,bars:[],forming:null,latest:null,compare:null},amber=calls=>calls.some(k=>k.op==='fill'&&k.fill==='rgba(240,160,32,0.92)');
  const loading={reliable:false,state:'loading',text:'Hämtar data…'},{chart,calls}=setup();
  chart.setData({...empty,status:loading});chart.render();
  assert.ok(texts(calls).includes('Hämtar candles…'));assert.ok(!texts(calls).includes('Ingen kursdata ännu'));
  assert.ok(!texts(calls).includes('Hämtar data…')&&!amber(calls),'no warning badge while loading');
  // A load that failed is a warning, and then there is no data.
  const missing='Data saknas — nya demoaffärer pausade';
  calls.length=0;chart.setData({...empty,status:{reliable:false,state:'error',text:missing}});chart.render();
  assert.ok(texts(calls).includes('Ingen kursdata ännu'));assert.ok(texts(calls).includes(missing)&&amber(calls));
  // Candles on screen while the next series loads: no badge either.
  calls.length=0;chart.setData({...d,status:loading});chart.render();
  assert.ok(!texts(calls).includes('Hämtar data…')&&!amber(calls));
});

test('hitTest tells real candles from forecast slots and empty space',()=>{
  const d=scene(),compare=makeRecord(d.bars,{at:115,id:'older'}),{chart}=setup();
  chart.setData({...d,compare});chart.render();
  const v=chart.view(),y=(v.plot.top+v.plot.bottom)/2;
  const real=chart.hitTest(centre(chart,d.bars[117].t),y);
  assert.equal(real.kind,'real');assert.equal(real.bar,d.bars[117]);assert.equal(real.closed,true);assert.equal(real.forming,false);
  const cc=compare.forecast.candles.find(c=>c.t===d.bars[117].t);
  near(real.compare.error,(cc.c-d.bars[117].c)/compare.forecast.base,1e-12);
  const live=chart.hitTest(centre(chart,d.forming.t),y);
  assert.equal(live.kind,'real');assert.equal(live.forming,true);assert.equal(live.compare,null,'no outcome before the candle closes');
  assert.deepEqual([live.forecast.h,live.forecast.state],[1,'realized']);
  const slot=d.latest.forecast.candles[4],x5=centre(chart,slot.t),fc=chart.hitTest(x5,y);
  assert.equal(fc.kind,'forecast');assert.equal(fc.bar,null);assert.equal(fc.forecast.h,5);assert.equal(fc.forecast.state,'future');
  assert.equal(fc.forecast.candle,slot);assert.equal(fc.forecast.band,d.latest.forecast.bands[4]);near(fc.x,x5,1e-9);
  for(const dx of [-4,-2,2,4])assert.equal(chart.hitTest(x5+dx,y).t,slot.t,'snaps to the slot centre');
  assert.equal(chart.hitTest(v.plot.right-2,y).kind,'empty');
  assert.equal(chart.hitTest(v.plot.right+5,y),null);assert.equal(chart.hitTest(100,v.plot.bottom+5),null);
  assert.equal(chart.hitTest(NaN,y),null);
  const old=chart.hitTest(centre(chart,d.bars[50].t),y);assert.equal(old.kind,'real');assert.equal(old.forecast,null);assert.equal(old.compare,null);
});

test('zoomAt keeps the time under the pointer fixed and clamps the candle width',()=>{
  const {chart}=setup();chart.setData(scene());chart.render();
  for(const [x,f] of [[300,1.6],[120,.5],[700,1.3]]){
    const before=chart.view(),t=timeAt(chart,x);chart.zoomAt(x,f);
    near(chart.view().barPx,before.barPx*f,1e-9);near(timeAt(chart,x),t,1e-3,'time under the pointer');
  }
  assert.equal(chart.view().follow,true,'zooming alone keeps following');
  chart.zoomAt(300,1000);assert.equal(chart.view().barPx,60);
  chart.zoomAt(300,1e-6);assert.equal(chart.view().barPx,1.5);
  const v=chart.view();chart.zoomAt(300,0);chart.zoomAt(300,NaN);assert.deepEqual(chart.view(),v);
});

test('panBy turns follow-latest off; while following, new data moves the view along',()=>{
  const bars=makeBars(130),{chart}=setup(),seen=[];
  chart.setData(sceneFrom(bars.slice(0,120)));const v0=chart.view();assert.equal(v0.follow,true);
  chart.setData(sceneFrom(bars.slice(0,121)));const v1=chart.view();assert.equal(v1.rightT,v0.rightT+HOUR,'one new candle, one slot');
  chart.zoomAt(400,1.2);const zoomed=chart.view().rightT;
  chart.setData(sceneFrom(bars.slice(0,122)));assert.equal(chart.view().rightT,zoomed+HOUR,'a zoomed view still follows');
  chart.panBy(90,0);const v2=chart.view();assert.equal(v2.follow,false);near(v2.rightT,zoomed+HOUR-90/v2.barPx*HOUR,1e-6);
  chart.setData(sceneFrom(bars.slice(0,123)));assert.equal(chart.view().rightT,v2.rightT,'a panned view stays put');
  chart.scrollToLatest();const v3=chart.view();assert.equal(v3.follow,true);assert.equal(v3.rightT,bars[122].t+13*HOUR);
  chart.panBy(0,20);const v4=chart.view();assert.equal(v4.follow,true,'a vertical pan keeps following');assert.ok(v4.price&&v4.price.hi>v4.price.lo);
  // Changing coin starts at the latest data with an automatic price range. The BTC forecast record is not
  // drawn on the ETH chart, so the view ends three slots after the forming candle.
  chart.panBy(50,0);chart.setData(sceneFrom(bars.slice(0,123),{symbol:'ETH'}));
  const v5=chart.view();assert.equal(v5.follow,true);assert.equal(v5.price,null);assert.equal(v5.rightT,bars[122].t+4*HOUR);
});

test('scalePrice and vertical pans use a manual price range; resetView restores the defaults',()=>{
  const d=scene(),views=[],{chart}=setup({onViewChange:v=>views.push(v)});chart.setData(d);chart.render();
  const span=()=>{const p=chart.view().price;return p.hi-p.lo;},middle=()=>{const p=chart.view().price;return (p.hi+p.lo)/2;};
  chart.scalePrice(1);const auto=span(),centreP=middle();
  chart.scalePrice(2);near(span(),auto/2,1e-6);near(middle(),centreP,1e-6);
  chart.scalePrice(.5);near(span(),auto,1e-6);
  const before=chart.hitTest(300,200).price;chart.panBy(0,40);
  near(chart.hitTest(300,240).price,before,1e-6,'the price under the pointer moves with a downward drag');
  chart.zoomAt(300,2);chart.panBy(-30,0);
  chart.resetView();
  const v=chart.view();assert.deepEqual({rightT:v.rightT,barPx:v.barPx,price:v.price,follow:v.follow},{rightT:d.latest.cutoff+13*HOUR,barPx:9,price:null,follow:true});
  assert.ok(views.length>=5&&views.every(x=>Object.isFrozen(x)));assert.equal(views.at(-1).barPx,9);
  const n=views.length;chart.resetView();assert.equal(views.length,n,'no event without a change');
});

test('the canvas backing store follows devicePixelRatio and lines stay on device pixels',()=>{
  const a=setup({width:640,height:360,dpr:2});a.chart.setData(scene());a.chart.render();
  assert.deepEqual([a.canvas.width,a.canvas.height],[1280,720]);
  assert.deepEqual(a.calls.find(k=>k.op==='setTransform').args,[2,0,0,2,0,0]);
  const grid=a.calls.find(k=>k.op==='stroke'&&k.stroke===C.grid);assert.equal(grid.lw,.5,'one device pixel');
  for(let i=0;i<grid.path.length;i+=2){
    const [,x0,y0]=grid.path[i],[,x1,y1]=grid.path[i+1],v=y0===y1?y0:x0;assert.ok(y0===y1||x0===x1);
    assert.equal((v*2-.5)%1,0,'centred on a device pixel');
  }
  for(const body of a.calls.filter(k=>k.op==='fillRect'&&(k.fill===C.up||k.fill===C.down)))
    for(const n of body.args)assert.equal(n*2%1,0,'candle bodies snap to device pixels');
  let r=1.5;const b=setup({width:600,height:300,dpr:()=>r});b.chart.setData(scene());b.chart.render();
  assert.deepEqual([b.canvas.width,b.canvas.height],[900,450]);
  r=3;b.chart.render();assert.deepEqual([b.canvas.width,b.canvas.height],[1800,900]);
  r=5;b.chart.render();assert.equal(b.canvas.width,1800,'capped at 3×');
  b.canvas.clientWidth=300;b.chart.resize();assert.equal(b.canvas.width,900,'follows the CSS size');
  // A hidden canvas (no CSS size) draws nothing.
  const c=setup({width:0,height:0});c.chart.setData(scene());c.chart.render();assert.equal(c.calls.length,0);
});

test('drawing waits for one animation frame and the forming close eases unless motion is reduced',()=>{
  const frames=[],raf=fn=>frames.push(fn),d=scene(),{chart,calls}=setup({raf,reducedMotion:false});
  chart.setData(d);chart.panBy(10,0);chart.zoomAt(300,1.1);
  assert.equal(frames.length,1,'many changes, one frame');assert.equal(calls.length,0,'nothing drawn before the frame');
  frames.shift()(1000);assert.ok(calls.some(k=>k.op==='setTransform'));assert.equal(frames.length,0,'idle after drawing');
  const from=d.forming.c,to=from+40,moved={...d,forming:{...d.forming,c:to,h:Math.max(d.forming.h,to)}};
  chart.setData(moved);
  calls.length=0;frames.shift()(2000);assert.ok(texts(calls).includes(sv(from,0)),'starts from what was on screen');
  calls.length=0;frames.shift()(2125);assert.ok(texts(calls).includes(sv(from+(to-from)*(1-.5**3),0)),'ease-out halfway');
  calls.length=0;frames.shift()(2250);assert.ok(texts(calls).includes(sv(to,0)));assert.equal(frames.length,0,'done after 250 ms');
  // A new candle jumps instead of easing.
  const next={...moved,forming:{...moved.forming,t:moved.forming.t+HOUR}};chart.setData(next);
  calls.length=0;frames.shift()(3000);assert.ok(texts(calls).includes(sv(to,0)));assert.equal(frames.length,0);
  // Reduced motion shows the new close at once.
  const quiet=setup({raf,reducedMotion:()=>true});quiet.chart.setData(d);frames.shift()(0);
  quiet.chart.setData(moved);quiet.calls.length=0;frames.shift()(16);
  assert.ok(texts(quiet.calls).includes(sv(to,0)));assert.equal(frames.length,0);
});

test('pointer, wheel and keyboard interactions pan, zoom, scale and reset the view',()=>{
  const d=scene(),{chart,fire,canvas,handlers}=setup({listeners:true});chart.setData(d);chart.render();
  assert.equal(canvas.style.touchAction,'pan-y');assert.equal(canvas.tabIndex,0);
  for(const type of ['pointerdown','pointermove','pointerup','pointercancel','pointerleave','wheel','dblclick','keydown'])assert.ok(handlers[type]?.length,type);
  const v=()=>chart.view(),anchor=d.latest.cutoff+13*HOUR;
  const t=timeAt(chart,300);fire('wheel',{clientX:300,clientY:200,deltaY:-100,deltaMode:0});
  assert.ok(v().barPx>9,'wheel up zooms in');near(timeAt(chart,300),t,1e-3);
  const r0=v().rightT,b0=v().barPx;
  fire('pointerdown',{clientX:400,clientY:200});fire('pointermove',{clientX:430,clientY:220});fire('pointerup',{clientX:430,clientY:220});
  near(v().rightT,r0-30/b0*HOUR,1e-6);assert.equal(v().follow,false);assert.ok(v().price,'vertical drag leaves the auto range');
  fire('dblclick');assert.deepEqual([v().rightT,v().barPx,v().price,v().follow],[anchor,9,null,true]);
  // A click without movement changes nothing.
  fire('pointerdown',{clientX:400,clientY:200});fire('pointermove',{clientX:401,clientY:201});fire('pointerup',{clientX:401,clientY:201});
  assert.deepEqual([v().rightT,v().price,v().follow],[anchor,null,true]);
  // Dragging up on the price axis magnifies the prices.
  chart.scalePrice(1);const span=v().price.hi-v().price.lo,ax=v().plot.right+20;
  fire('pointerdown',{clientX:ax,clientY:200});fire('pointermove',{clientX:ax,clientY:150});fire('pointerup',{clientX:ax,clientY:150});
  near(v().price.hi-v().price.lo,span/Math.exp(.5),1e-6);
  // Dragging right on the time axis widens the candles, anchored at the right edge.
  const ty=v().plot.bottom+10,rightT=v().rightT;
  fire('pointerdown',{clientX:300,clientY:ty});fire('pointermove',{clientX:340,clientY:ty});fire('pointerup',{clientX:340,clientY:ty});
  near(v().barPx,9*Math.exp(.4),1e-9);near(v().rightT,rightT,1e-6);
  // Wheel over the price axis scales prices; a sideways trackpad scroll pans.
  const p=v().price;fire('wheel',{clientX:ax,clientY:200,deltaY:100});assert.ok(v().price.hi-v().price.lo>p.hi-p.lo);
  const r1=v().rightT;fire('wheel',{clientX:300,clientY:200,deltaX:45,deltaY:2});near(v().rightT,r1+45/v().barPx*HOUR,1e-6);
  // Pinch: two pointers spreading apart zoom in.
  fire('keydown',{key:'0'});
  fire('pointerdown',{pointerId:1,pointerType:'touch',clientX:300,clientY:200});fire('pointerdown',{pointerId:2,pointerType:'touch',clientX:400,clientY:200});
  fire('pointermove',{pointerId:2,pointerType:'touch',clientX:450,clientY:200});
  near(v().barPx,9*1.5,1e-9);
  // Lifting one finger hands the pan to the other one.
  fire('pointerup',{pointerId:1,pointerType:'touch',clientX:300,clientY:200});
  const r2=v().rightT;fire('pointermove',{pointerId:2,pointerType:'touch',clientX:477,clientY:200});
  near(v().rightT,r2-27/v().barPx*HOUR,1e-6);
  fire('pointerup',{pointerId:2,pointerType:'touch',clientX:477,clientY:200});
  // Keyboard on the focused canvas.
  fire('keydown',{key:'0'});assert.equal(v().barPx,9);
  fire('keydown',{key:'+'});assert.equal(v().barPx,11.25);fire('keydown',{key:'-'});near(v().barPx,9,1e-9);
  fire('keydown',{key:'+',ctrlKey:true});near(v().barPx,9,1e-9,'browser zoom is left alone');
  fire('keydown',{key:'ArrowLeft'});assert.equal(v().follow,false);assert.ok(v().rightT<anchor);
  fire('keydown',{key:'End'});assert.deepEqual([v().rightT,v().follow],[anchor,true]);
  fire('keydown',{key:'ArrowRight'});assert.ok(v().rightT>anchor);
  // Two quick taps reset on touch screens.
  fire('pointerdown',{pointerType:'touch',clientX:200,clientY:200});fire('pointerup',{pointerType:'touch',clientX:200,clientY:200});
  fire('pointerdown',{pointerType:'touch',clientX:202,clientY:201});fire('pointerup',{pointerType:'touch',clientX:202,clientY:201});
  assert.deepEqual([v().rightT,v().follow],[anchor,true]);
});

test('the tooltip uses textContent for real candles, forecast slots and forecast vs outcome',()=>{
  const tooltip={hidden:false,textContent:'',style:{},offsetWidth:150,offsetHeight:70},frames=[];
  const d=scene(),compare=makeRecord(d.bars,{at:115,id:'older'}),{chart,fire}=setup({listeners:true,tooltip,raf:fn=>frames.push(fn)});
  chart.setData({...d,compare});frames.shift()(0);
  assert.equal(tooltip.hidden,true);assert.equal(tooltip.style.position,'absolute');assert.equal(tooltip.style.pointerEvents,'none');
  const hover=t=>{fire('pointermove',{clientX:centre(chart,t),clientY:150});frames.shift()(16);return tooltip.textContent.split('\n');};
  // Forecast slot 5: cutoff 2 Oct 23:00 UTC + 5 h = 3 Oct 06:00 in Stockholm.
  const c=d.latest.forecast.candles[4],q=d.latest.forecast.bands[4],fc=hover(c.t);
  // "80 %-band", not "80 %" alone, which could read as a probability.
  assert.deepEqual(fc,['Prognos (scenario) · 3 okt 06:00',`O ${sv(c.o,0)}   H ${sv(c.h,0)}`,`L ${sv(c.l,0)}   C ${sv(c.c,0)}`,
    `80 %-band: ${sv(q.q10,0)} – ${sv(q.q90,0)}`]);
  assert.equal(tooltip.hidden,false);assert.match(tooltip.style.left,/^\d+px$/);assert.match(tooltip.style.top,/^\d+px$/);
  // A closed real candle where the older version made a forecast.
  const b=d.bars[117],cc=compare.forecast.candles.find(k=>k.t===b.t),real=hover(b.t);
  assert.equal(real[0],'2 okt 23:00');
  assert.equal(real[1],`O ${sv(b.o,0)}   H ${sv(b.h,0)}`);assert.equal(real[2],`L ${sv(b.l,0)}   C ${sv(b.c,0)}`);
  assert.equal(real[3],'Förändring '+pct(b.c/d.bars[116].c-1));
  assert.equal(real[4],'Prognos vs utfall: '+pct((cc.c-b.c)/compare.forecast.base));
  // The forming candle has no outcome yet.
  const live=hover(d.forming.t);assert.match(live[0],/ · pågår$/);assert.ok(!live.some(l=>l.startsWith('Prognos vs utfall')));
  // Near the right edge the tooltip flips to the left of the pointer.
  hover(d.latest.forecast.candles[9].t);assert.ok(parseInt(tooltip.style.left)<centre(chart,d.latest.forecast.candles[9].t));
  fire('pointerleave');frames.shift()(32);assert.equal(tooltip.hidden,true);
  assert.ok(!('innerHTML' in tooltip),'never innerHTML');
});

test('the tooltip change compares with the previous close and is left out when that candle is not loaded',()=>{
  const tooltip={hidden:true,textContent:'',style:{},offsetWidth:150,offsetHeight:70},d=scene(),{chart,fire}=setup({listeners:true,tooltip});
  const lines=(data,t)=>{chart.setData(data);chart.render();fire('pointermove',{clientX:centre(chart,t),clientY:150});chart.render();return tooltip.textContent.split('\n');};
  const b=d.bars[110],prev=d.bars[109];
  // These candles open away from the previous close, so "against the open" would give another number.
  assert.notEqual(pct(b.c/prev.c-1),pct(b.c/b.o-1));
  const full=lines(d,b.t);
  assert.equal(full.length,4);assert.equal(full[3],'Förändring '+pct(b.c/prev.c-1));
  // A reload whose history happens to start at this candle shows the same candle without a change line,
  // never a different number under the same label.
  assert.deepEqual(lines({...d,bars:d.bars.slice(110)},b.t),full.slice(0,3));
  // Likewise after a missing candle.
  const after=d.bars[106],gap=lines({...d,bars:d.bars.filter((_,i)=>i!==105)},after.t);
  assert.equal(gap.length,3);assert.ok(!gap.some(l=>l.startsWith('Förändring')));
  // The forming candle compares with the last closed one.
  assert.ok(lines(d,d.forming.t).includes('Förändring '+pct(d.forming.c/d.bars.at(-1).c-1)));
});

test('records are drawn without changes, wrong-timeframe forecasts are ignored and bad input fails in Swedish',()=>{
  const d=scene(),{chart,calls}=setup();
  chart.setData(d);chart.render();
  assert.throws(()=>chart.setData({...d,tf:'2h'}),/Okänd tidsram/);
  calls.length=0;chart.setData({...d,latest:{...d.latest,tf:'4h'},compare:null});chart.render();
  assert.ok(!texts(calls).includes('Forecast — estimated scenario'));assert.ok(!calls.some(k=>k.fill===C.fcFill));
  // No forecast yet: real candles end two slots before the right edge.
  chart.setData({...d,latest:null,compare:null});const v=chart.view();assert.equal(v.rightT,d.forming.t+3*HOUR);
  calls.length=0;chart.render();assert.ok(calls.some(k=>k.op==='fillRect'&&k.fill===C.up));
  calls.length=0;chart.setData({...d,bars:[],forming:null,latest:null,compare:null});chart.render();
  assert.ok(texts(calls).includes('Ingen kursdata ännu'));
  chart.setData(null);calls.length=0;chart.render();assert.equal(calls.filter(k=>k.op==='fillText').length,0);
  assert.throws(()=>createForecastChart({getContext:()=>null}),/canvas saknas/);
});

test('forecasts and signals from another coin are never drawn on this chart',()=>{
  const d=scene(),eth={...d.latest,symbol:'ETH'},signal=symbol=>[{id:'s1',side:'long',barTime:d.bars[100].t,tf:'1h',symbol}];
  const {chart,calls}=setup();chart.setData({...d,latest:eth,compare:eth,signals:signal('ETH')});chart.render();
  assert.ok(!texts(calls).includes('Forecast — estimated scenario'));assert.ok(!texts(calls).includes('KÖP'));
  assert.ok(!calls.some(k=>k.fill===C.fcFill||k.fill===C.band80||k.stroke===C.fcOutline||k.stroke===C.median));
  calls.length=0;chart.setData({...d,signals:signal('BTC')});chart.render();
  assert.ok(texts(calls).includes('Forecast — estimated scenario'));assert.ok(texts(calls).includes('KÖP'));
});

test('destroy removes every listener and hides the tooltip',()=>{
  const tooltip={hidden:false,textContent:'',style:{}},{chart,handlers,calls}=setup({listeners:true,tooltip});
  chart.setData(scene());
  assert.ok(Object.values(handlers).flat().length>=8);
  chart.destroy();assert.equal(Object.values(handlers).flat().length,0);assert.equal(tooltip.hidden,true);
  calls.length=0;chart.render();assert.equal(calls.length,0);
});

test('a wide chart starts zoomed in to about 100 slots and keeps that width until the user zooms',()=>{
  const d=scene(),{chart,canvas}=setup({width:1600,height:600});chart.setData(d);chart.render();
  const v=()=>chart.view(),auto=w=>Math.min(16,Math.max(9,w/100));
  near(v().barPx,auto(v().plot.right-v().plot.left),1e-9);assert.ok(v().barPx>9);
  // A resize follows while the width is automatic.
  canvas.clientWidth=1200;chart.resize();near(v().barPx,auto(v().plot.right-v().plot.left),1e-9);
  // Zooming takes over; a resize then leaves the user's width alone.
  chart.zoomAt(v().plot.right,1.25);const zoomed=v().barPx;canvas.clientWidth=1500;chart.resize();assert.equal(v().barPx,zoomed);
  // Reset returns to the automatic width for the current size.
  chart.resetView();near(v().barPx,auto(v().plot.right-v().plot.left),1e-9);
});

test('on a narrow chart the automatic slots shrink until the forecast and 30 closed candles fit, never below 5,5 px; wide charts keep theirs',()=>{
  // A phone: 390 px wide. With length 20 at 9 px only about a dozen closed candles stayed in view.
  const d=scene(),closedInView=c=>{const v=c.view();return Math.floor((xOf(c,d.forming.t)-v.plot.left)/v.barPx+1e-6);};
  for(const horizon of [5,10,20]){
    const {chart}=setup({width:390,height:600});chart.setData({...d,horizon});chart.render();
    const v=chart.view(),w=v.plot.right-v.plot.left;
    near(v.barPx,Math.min(9,w/(horizon+2+30)),1e-9,'length '+horizon);
    assert.ok(closedInView(chart)>=30,'length '+horizon+': '+closedInView(chart)+' closed candles in view');
    assert.ok(xOf(chart,d.latest.cutoff+(horizon+1)*HOUR)<=v.plot.right+1e-9,'the whole forecast too');
  }
  // Much narrower still, the slots stop at 5,5 px.
  const tiny=setup({width:250,height:600});tiny.chart.setData({...d,horizon:20});tiny.chart.render();assert.equal(tiny.chart.view().barPx,5.5);
  // Desktop sizes keep the widths they had: 9 px at 800 px, about a hundredth of the plot from 900 px of plot up.
  for(const width of [800,1280,1600]){
    const {chart}=setup({width,height:600});chart.setData({...d,horizon:20});chart.render();
    const v=chart.view(),w=v.plot.right-v.plot.left;near(v.barPx,Math.min(16,Math.max(9,w/100)),1e-9,width+' px');
  }
});

test('a sideways pan with a little vertical drift keeps the automatic price range; double-click on the price axis restores only the prices',()=>{
  const d=scene(),{chart,fire}=setup({listeners:true});chart.setData(d);chart.render();
  const v=()=>chart.view();
  fire('pointerdown',{clientX:400,clientY:200});fire('pointermove',{clientX:440,clientY:209});fire('pointermove',{clientX:470,clientY:212});fire('pointerup',{clientX:470,clientY:212});
  assert.equal(v().follow,false,'panned back in time');assert.equal(v().price,null,'12 px of drift does not freeze the prices');
  fire('pointerdown',{clientX:400,clientY:200});fire('pointermove',{clientX:405,clientY:240});fire('pointerup',{clientX:405,clientY:240});
  assert.ok(v().price,'a clear vertical drag moves the prices');
  const {rightT,barPx}=v(),ax=v().plot.right+20;
  fire('dblclick',{clientX:ax,clientY:200});
  assert.deepEqual([v().price,v().rightT,v().barPx,v().follow],[null,rightT,barPx,false],'only the price range resets');
  fire('dblclick',{clientX:300,clientY:200});assert.equal(v().follow,true,'a double-click in the plot resets everything');
});

test('the crosshair tags own their axes: the price tag spans the whole price axis and no axis label peeks out beside either tag',()=>{
  const d=scene(),from=d.bars[100].t,label='SL '+sv(85000,0),{chart,calls,fire}=setup({listeners:true});
  chart.setData({...d,levels:[{kind:'sl',price:85000,from,label:'SL'}]});chart.render();
  const v=chart.view(),y=calls.find(k=>k.op==='fillText'&&k.text===label).args[1];
  // The pointer at the stop's height, over a real candle: the crosshair tag lands on the SL tag.
  fire('pointermove',{clientX:centre(chart,d.bars[110].t),clientY:y});calls.length=0;chart.render();
  const dark=i=>calls[i].op==='fill'&&calls[i].fill==='#283240';
  const pi=calls.findIndex((k,i)=>dark(i)&&k.path[0][1]>v.plot.right),ti=calls.findIndex((k,i)=>dark(i)&&k.path[0][2]>v.plot.bottom);
  assert.ok(pi>0&&ti>0,'both crosshair tags');
  const [,px,py,pw,ph]=calls[pi].path[0],[,tx,,tw]=calls[ti].path[0];
  near(px,v.plot.right+1,1e-9);near(px+pw,800-1,1e-9,'the price tag reaches the canvas edge');
  assert.equal(calls.findIndex(k=>k.op==='fillText'&&k.text===label),-1,'the level tag at its height yields to it');
  for(const k of calls.filter(k=>k.op==='fillText'&&k.fill===C.axisText&&k.args[0]===v.plot.right+8))
    assert.ok(Math.abs(k.args[1]-(py+ph/2))>=15,'price label '+k.text+' next to the crosshair tag');
  const stamp=calls[ti+1].text;
  for(const k of calls.filter(k=>k.op==='fillText'&&k.align==='center'&&k.args[1]===v.plot.bottom+13&&k.text!==stamp)){
    const half=k.text.length*3;assert.ok(k.args[0]+half<=tx-6||k.args[0]-half>=tx+tw+6,'time label '+k.text+' under the crosshair tag');
  }
});

test('a press on the chart leaves focus to the browser, so the keyboard focus ring does not light up on a click',()=>{
  const {chart,canvas,fire}=setup({listeners:true});let scripted=0;canvas.focus=()=>{scripted++;};
  chart.setData(scene());chart.render();
  fire('pointerdown',{clientX:300,clientY:200});fire('pointermove',{clientX:340,clientY:200});fire('pointerup',{clientX:340,clientY:200});
  fire('pointerdown',{pointerType:'touch',clientX:300,clientY:200});fire('pointerup',{pointerType:'touch',clientX:300,clientY:200});
  assert.equal(scripted,0);
});

test('labels drawn over the candles have a halo in the surface colour, so outlines and bands never cross the letters',()=>{
  const d=scene(),{chart,ctx,calls}=setup(),halos=[];
  ctx.strokeText=(text,x,y)=>halos.push({text,args:[x,y],stroke:ctx.strokeStyle,lw:ctx.lineWidth});
  chart.setData({...d,signals:[{id:'s1',side:'long',barTime:d.bars[100].t,tf:'1h',symbol:'BTC'},{id:'s2',side:'short',barTime:d.bars[104].t}]});chart.render();
  for(const text of ['KÖP','SÄLJ','Data t.o.m. '+stockholmClock(d.latest.cutoffClose)]){
    const h=halos.find(k=>k.text===text),f=calls.findLast(k=>k.op==='fillText'&&k.text===text);
    assert.ok(h&&f,text);assert.equal(h.stroke,C.surface);assert.ok(h.lw>=2);assert.deepEqual(h.args,f.args,text+' halo under the text');
  }
  // "pågår" sits on its own pill on the time axis, over no candle, so it needs none.
  assert.ok(texts(calls).includes('pågår'));assert.ok(!halos.some(k=>k.text==='pågår'));
});

test('on a touch screen a vertical swipe is left to the page: only sideways drags move the chart, and the prices stay automatic',()=>{
  const d=scene(),{chart,fire,canvas}=setup({listeners:true});chart.setData(d);chart.render();
  const v=()=>chart.view(),start=v(),touch={pointerType:'touch'};
  // The browser scrolls the page for a vertical swipe (touch-action pan-y) and then cancels the pointer.
  assert.equal(canvas.style.touchAction,'pan-y');
  fire('pointerdown',{...touch,clientX:300,clientY:300});
  for(const [x,y] of [[301,296],[302,288],[303,270],[304,240]])fire('pointermove',{...touch,clientX:x,clientY:y});
  fire('pointercancel',{...touch,clientX:304,clientY:240});
  assert.deepEqual([v().rightT,v().barPx,v().price,v().follow],[start.rightT,start.barPx,null,true],'nothing moved');
  // Where nothing scrolls (a large touch screen) a finger still never moves the prices, in the plot or on the price axis.
  fire('pointerdown',{...touch,clientX:300,clientY:300});fire('pointermove',{...touch,clientX:303,clientY:200});fire('pointerup',{...touch,clientX:303,clientY:200});
  assert.deepEqual([v().rightT,v().price,v().follow],[start.rightT,null,true]);
  const ax=v().plot.right+20;
  fire('pointerdown',{...touch,clientX:ax,clientY:300});fire('pointermove',{...touch,clientX:ax,clientY:200});fire('pointerup',{...touch,clientX:ax,clientY:200});
  assert.equal(v().price,null,'nor on the price axis');
  // Sideways the chart follows the finger in time; a little vertical drift moves nothing.
  fire('pointerdown',{...touch,clientX:300,clientY:300});
  fire('pointermove',{...touch,clientX:310,clientY:302});fire('pointermove',{...touch,clientX:360,clientY:330});fire('pointerup',{...touch,clientX:360,clientY:330});
  near(v().rightT,start.rightT-60/start.barPx*HOUR,1e-6,'60 px of finger, 60 px of chart');
  assert.equal(v().price,null);assert.equal(v().follow,false);
  // A mouse still pans the prices after a clear vertical drag.
  fire('pointerdown',{clientX:400,clientY:200});fire('pointermove',{clientX:405,clientY:240});fire('pointerup',{clientX:405,clientY:240});
  assert.ok(v().price);
});

test('a tap on a touch screen holds the crosshair and tooltip at its candle until the next tap',()=>{
  const tooltip={hidden:true,textContent:'',style:{},offsetWidth:150,offsetHeight:70},frames=[];
  const bars=makeBars(130),d=sceneFrom(bars.slice(0,120)),{chart,fire,calls}=setup({listeners:true,tooltip,raf:fn=>frames.push(fn)});
  const flush=()=>{calls.length=0;while(frames.length)frames.shift()(16);};
  const touch={pointerType:'touch'},tap=(x,y)=>{fire('pointerdown',{...touch,clientX:x,clientY:y});fire('pointerup',{...touch,clientX:x,clientY:y});fire('pointerleave',touch);flush();};
  const first=()=>tooltip.hidden?null:tooltip.textContent.split('\n')[0],cross=()=>calls.filter(k=>k.op==='stroke'&&k.stroke===C.crosshair);
  chart.setData(d);flush();
  // A gray forecast candle: its OHLC and band.
  const c=d.latest.forecast.candles[4];tap(centre(chart,c.t),150);
  assert.equal(first(),'Prognos (scenario) · 3 okt 06:00');assert.match(tooltip.textContent,/80 %-band: /);
  assert.equal(cross().length,2,'the crosshair stays after the finger has left');
  // While the chart follows the data, a new candle moves the view one slot and the crosshair moves with its candle.
  chart.setData(sceneFrom(bars.slice(0,121)));flush();
  assert.equal(first(),'Prognos (scenario) · 3 okt 06:00');near(cross()[0].path[0][1],centre(chart,c.t),1);
  // The same candle again lets go (a second tap further away than a double tap).
  tap(centre(chart,c.t),220);assert.equal(first(),null);assert.equal(cross().length,0);
  // A real candle; then a tap outside the plot lets go.
  const b=bars[110];tap(centre(chart,b.t),150);assert.equal(first(),'2 okt 16:00');
  tap(chart.view().plot.right+20,150);assert.equal(first(),null);
  // Another candle moves it there; a sideways pan lets go.
  tap(centre(chart,b.t),150);tap(centre(chart,bars[100].t),150);assert.equal(first(),'2 okt 06:00');
  fire('pointerdown',{...touch,clientX:300,clientY:300});fire('pointermove',{...touch,clientX:340,clientY:300});fire('pointerup',{...touch,clientX:340,clientY:300});flush();
  assert.equal(first(),null);
});

test('a pill wider than the forecast region gets a thin bracket under it that spans exactly the region',()=>{
  const d=scene({horizon:5}),{chart,calls}=setup();chart.setData(d);chart.render();
  const cut=d.latest.cutoff,x0=xOf(chart,cut+HOUR),x1=xOf(chart,cut+6*HOUR);
  const bracketOf=list=>list.find(k=>k.op==='stroke'&&k.stroke==='rgba(139,155,176,.6)'&&k.path.length===4&&k.path[1][2]===k.path[2][2]&&
    k.path[0][1]===k.path[1][1]&&k.path[2][1]===k.path[3][1]&&k.path[0][2]>k.path[1][2]);
  const pill=calls.find(k=>k.op==='fill'&&k.fill==='rgba(26,33,43,.88)'),[,,py,pw,ph]=pill.path[0];
  assert.ok(pw>x1-x0,'the pill is wider than the five-candle region');
  const b=bracketOf(calls);assert.ok(b,'a bracket');
  near(b.path[1][1],x0,1,'from the start line');near(b.path[2][1],x1,1,'to the end of the region');
  assert.ok(b.path[1][2]>py+ph&&b.path[1][2]<py+ph+8,'right under the pill');
  // A pill that fits inside the region needs none.
  const wide=setup({width:1600,height:600});wide.chart.setData({...d,horizon:20});wide.chart.render();
  const [,wx,,ww]=wide.calls.find(k=>k.op==='fill'&&k.fill==='rgba(26,33,43,.88)').path[0];
  assert.ok(wx>=xOf(wide.chart,cut+HOUR)&&wx+ww<=xOf(wide.chart,cut+21*HOUR));assert.equal(bracketOf(wide.calls),undefined);
});

test('the tooltip of a candle with a signal marker says when the signal was confirmed, as the signal lists do',()=>{
  const tooltip={hidden:true,textContent:'',style:{},offsetWidth:150,offsetHeight:70},d=scene(),buy=d.bars[100],sell=d.bars[105];
  const signals=[{id:'s1',side:'long',barTime:buy.t,confirmedAt:buy.t+HOUR,tf:'1h',symbol:'BTC'},{id:'s2',side:'short',barTime:sell.t}];
  const {chart,fire}=setup({listeners:true,tooltip});
  const lines=(data,t)=>{chart.setData(data);chart.render();fire('pointermove',{clientX:centre(chart,t),clientY:150});chart.render();return tooltip.textContent.split('\n');};
  // The marker sits on the 06:00 candle (Stockholm); the signal was confirmed when it closed at 07:00.
  assert.equal(lines({...d,signals},buy.t)[0],'2 okt 06:00');
  assert.equal(plain(lines({...d,signals},buy.t).at(-1)),'▲ KÖP · bekräftad 2 okt 07:00');
  assert.equal(plain(lines({...d,signals},sell.t).at(-1)),'▼ SÄLJ · bekräftad 2 okt 12:00','without confirmedAt: the candle\'s close');
  assert.ok(!lines({...d,signals,showSignals:false},buy.t).some(l=>/bekräftad/.test(l)),'no marker, no line');
  assert.ok(!lines({...d,signals},d.bars[101].t).some(l=>/bekräftad/.test(l)));
});

test('a level tag a few pixels from the crosshair\'s price tag yields to it, so no strip of it peeks out above or below',()=>{
  const d=scene(),from=d.bars[100].t,label='Likv. '+sv(85000,0),{chart,calls,fire}=setup({listeners:true});
  chart.setData({...d,levels:[{kind:'liq',price:85000,from,label:'Likv.'}]});chart.render();
  const y=calls.find(k=>k.op==='fillText'&&k.text===label).args[1],x=centre(chart,d.bars[110].t);
  const liq=()=>calls.filter(k=>k.op==='fill'&&k.fill==='rgba(240,160,32,0.9)');
  for(const dy of [-17,-4,0,4,17]){
    // The tags are 18 px tall: centres 4 px apart left a 4 px amber strip of the level tag beside the crosshair's.
    fire('pointermove',{clientX:x,clientY:y+dy});calls.length=0;chart.render();
    assert.equal(liq().length,0,dy+' px: no part of the level tag');assert.ok(!texts(calls).includes(label));
  }
  // Clear of the crosshair's tag it is drawn as usual.
  fire('pointermove',{clientX:x,clientY:y+30});calls.length=0;chart.render();
  assert.equal(liq().length,1);assert.ok(texts(calls).includes(label));
});

test('"Data t.o.m." takes the page\'s own text, with the date and the year it gives; without one the chart writes the time',()=>{
  const {chart,calls}=setup(),d=scene();
  chart.setData({...d,dataEnd:'2 okt 2025 01:00'});chart.render();
  assert.ok(texts(calls).includes('Data t.o.m. 2 okt 2025 01:00'));
  calls.length=0;chart.setData(d);chart.render();
  assert.ok(texts(calls).includes('Data t.o.m. '+stockholmClock(d.latest.cutoffClose)));
});

// The rounded pill ([x,y,w,h]) a text call was drawn on: the last filled path before it.
const pillOf=(calls,k)=>calls.slice(0,calls.indexOf(k)).findLast(c=>c.op==='fill').path[0].slice(1);
// A stored signal record as forecast-store seals it (the fields the chart reads).
const storedSignal=(bar,over={})=>deepFreeze({id:'s|u1|BTC|1h|'+bar.t+'|af-signal-v1',kind:'signal',symbol:'BTC',tf:'1h',side:'long',barTime:bar.t,
  confirmedAt:bar.t+HOUR,recordedAt:bar.t+5*HOUR,origin:'backfill',entry:85123,sl:84800,tp:85769,regime:'trend-up',
  explanation:['Trend upp: EMA20 över EMA50 och EMA50 stiger · ADX 27','4h-trenden uppåt (stängning över EMA20)','Utbrott: stängning 85\xa0123 över 20-candle-högsta 85\xa0010'],...over});

test('hovering or tapping a stored signal\'s candle shows its record: side, regime, confirmation time, efterhand, entry, SL, TP and its own explanation',()=>{
  const tooltip={hidden:true,textContent:'',style:{},offsetWidth:150,offsetHeight:70},d=scene(),buy=d.bars[100],record=storedSignal(buy);
  const {chart,fire}=setup({listeners:true,tooltip});
  const lines=signals=>{chart.setData({...d,signals});chart.render();fire('pointermove',{clientX:centre(chart,buy.t),clientY:150});chart.render();return tooltip.textContent.split('\n');};
  // The marker's candle opened 06:00 (Stockholm) and closed, confirming the signal, at 07:00.
  const got=lines([record]);
  assert.equal(got[0],'2 okt 06:00');
  assert.deepEqual(got.slice(-5).map(plain),['▲ KÖP · Trend upp · bekräftad 2 okt 07:00 · efterhand',`Entry ${sv(85123,0)} · SL ${sv(84800,0)} · TP ${sv(85769,0)}`,...record.explanation].map(plain));
  // Wrapped, a line breaks only between words or before a ' · ': never between a label and its number ('ADX' / '27',
  // '20-candle-högsta' / '85 010'), inside a time or after a dot, so no number stands alone at the start of a line.
  const [head,levels,...why]=got.slice(-5);
  for(const line of [head,levels])assert.equal(line.replace(/ ·\xa0/g,'').includes(' '),false,line);
  for(const line of why){assert.doesNotMatch(line,/ [−+-]?\d/,line);assert.doesNotMatch(line,/· /,line);}
  assert.equal(why[0],'Trend upp: EMA20 över EMA50 och EMA50 stiger ·\xa0ADX\xa027');
  assert.equal(why[2],'Utbrott: stängning\xa085\xa0123 över\xa020-candle-högsta\xa085\xa0010');
  // The lines come from the record, never from a new calculation: a record that says otherwise is shown as it is.
  const short=lines([{...record,origin:'live',side:'short',regime:'trend-down',entry:85000,sl:85300,tp:84400,explanation:['Egen rad <b>ur posten</b>']}]);
  assert.deepEqual(short.slice(-3).map(plain),['▼ SÄLJ · Trend ned · bekräftad 2 okt 07:00',`Entry ${sv(85000,0)} · SL ${sv(85300,0)} · TP ${sv(84400,0)}`,'Egen rad <b>ur posten</b>'].map(plain));
  // A regime the labels do not know, even one named like an object's own property, is left out rather than shown.
  for(const regime of ['constructor','__proto__','toString','sidled'])
    assert.equal(plain(lines([{...record,regime}]).at(-5)),'▲ KÖP · bekräftad 2 okt 07:00 · efterhand',regime);
  assert.ok(!('innerHTML' in tooltip),'text only');
  // Long explanation lines wrap inside the tooltip instead of running off a phone screen.
  assert.equal(tooltip.style.whiteSpace,'pre-wrap');
  // A tap holds the same lines.
  fire('pointerleave');const touch={pointerType:'touch',clientX:centre(chart,buy.t),clientY:150};
  chart.setData({...d,signals:[record]});fire('pointerdown',touch);fire('pointerup',touch);fire('pointerleave',touch);chart.render();
  assert.equal(plain(tooltip.textContent.split('\n').at(-1)),plain(record.explanation.at(-1)));
});

test('the tooltip is measured where nothing squeezes it, so a long one flipped left of the pointer never lands over it',()=>{
  // Like a browser's absolutely placed box with wrapping lines: it shrinks to the room right of its left edge (the canvas is
  // 800 px wide), at most 360 px, and wraps into more lines when narrower.
  const natural=t=>Math.min(360,6*Math.max(...t.split('\n').map(l=>l.length))+18);
  const tooltip={hidden:true,textContent:'',style:{},
    get offsetWidth(){return Math.min(natural(this.textContent),800-(parseInt(this.style.left)||0));},
    get offsetHeight(){return 18*this.textContent.split('\n').reduce((n,l)=>n+Math.ceil((6*l.length+18)/this.offsetWidth),0);}};
  const d=scene(),signal=storedSignal(d.bars[110]),{chart,fire}=setup({listeners:true,tooltip});
  chart.setData({...d,signals:[signal]});chart.render();
  const hover=t=>{const x=centre(chart,t);fire('pointermove',{clientX:x,clientY:150});chart.render();return x;};
  // A plain candle first: its short tooltip lands right of the pointer, its left edge far over to the right.
  hover(d.bars[100].t);const first=parseInt(tooltip.style.left);assert.ok(first>centre(chart,d.bars[100].t));
  // Then the signal's candle, whose long lines do not fit right of the pointer: flipped to its left, all of it.
  const x=hover(d.bars[110].t),left=parseInt(tooltip.style.left);
  assert.ok(left+tooltip.offsetWidth<=x-16+1,`right edge ${left+tooltip.offsetWidth} left of the pointer at ${x}`);
  assert.equal(tooltip.offsetWidth,natural(tooltip.textContent),'its whole width');
});

test('a picked stored signal draws its own entry, SL and TP from its candle on, marked as that signal\'s and apart from the live levels',()=>{
  const d=scene(),bar=d.bars[110],picked=storedSignal(bar,{entry:85300,sl:85000,tp:85900,origin:'live'}),{chart,calls}=setup();
  const live=[{kind:'entry',price:85400,from:d.bars[116].t,label:'Entry'}];
  chart.setData({...d,levels:live,picked});chart.render();
  const v=chart.view(),x0=centre(chart,bar.t);
  // From the centre of the signal candle to the right edge: entry solid, SL and TP dashed, in the level colours.
  const line=(color,price)=>calls.find(k=>k.op==='stroke'&&k.stroke===color&&k.path.length===2&&k.path[0][2]===k.path[1][2]&&
    Math.abs(k.path[0][1]-x0)<1&&k.path[1][1]===v.plot.right&&Math.abs(chart.hitTest(200,k.path[0][2]).price-price)<5);
  assert.deepEqual(line(C.entry,85300).dash,[]);assert.deepEqual(line(C.sl,85000).dash,[6,4]);assert.deepEqual(line(C.tp,85900).dash,[6,4]);
  for(const fill of ['rgba(226,72,60,0.07)','rgba(20,167,160,0.07)'])assert.ok(calls.some(k=>k.op==='fillRect'&&k.fill===fill&&Math.abs(k.args[0]-x0)<1e-9),'zone '+fill);
  // A label at the start names the signal: its side and the close that confirmed it (the 16:00 candle closed 17:00). It ends
  // just left of the signal candle's slot, so it covers none of the candles after the signal (see the next test).
  const label=calls.find(k=>k.op==='fillText'&&k.text==='▲ KÖP 2 okt 17:00'),pill=pillOf(calls,label);
  assert.ok(label&&pill[0]+pill[2]<=xOf(chart,bar.t)&&pill[0]+pill[2]>=xOf(chart,bar.t)-4,'just before its candle');
  assert.ok(chart.hitTest(label.args[0],label.args[1]).price>85300,'on the target\'s side of its entry line');
  // Its axis tags are outlined: the dark tag fill, the line colour as the edge, light text. The live level's tag stays filled.
  for(const [text,color] of [['Entry '+sv(85300,0),C.entry],['SL '+sv(85000,0),C.sl],['TP '+sv(85900,0),C.tp]]){
    const i=calls.findIndex(k=>k.op==='fillText'&&k.text===text),before=calls.slice(0,i);assert.ok(i>0,text);
    assert.equal(before.findLast(k=>k.op==='fill').fill,'#283240',text);assert.equal(before.findLast(k=>k.op==='stroke').stroke,color,text);
    assert.equal(calls[i].fill,C.text);assert.ok(calls[i].args[0]>v.plot.right,'on the price axis');
  }
  const li=calls.findIndex(k=>k.op==='fillText'&&k.text==='Entry '+sv(85400,0));
  assert.equal(calls.slice(0,li).findLast(k=>k.op==='fill').fill,'rgba(159,176,192,0.9)','the live entry keeps its filled tag');
  // The user asked for them, so the Nivåer toggle does not hide them; another coin's or timeframe's signal is never drawn.
  calls.length=0;chart.setData({...d,levels:live,picked,showLevels:false});chart.render();
  assert.ok(texts(calls).includes('TP '+sv(85900,0)));assert.ok(!texts(calls).includes('Entry '+sv(85400,0)));
  for(const other of [{tf:'4h'},{symbol:'ETH'}]){calls.length=0;chart.setData({...d,picked:{...picked,...other}});chart.render();assert.ok(!texts(calls).includes('TP '+sv(85900,0)),JSON.stringify(other));}
  // In view, its whole stop-to-target span is in the price range; dropped, it is gone.
  chart.setData({...d,picked:{...picked,tp:87500}});chart.render();assert.ok(chart.hitTest(300,chart.view().plot.top+31).price>=87500-1);
  calls.length=0;chart.setData({...d,picked:null});chart.render();assert.ok(!texts(calls).some(t=>/^▲ KÖP \d/.test(t)));
});

test('a picked signal\'s label ends just left of its candle, clear of the candles after it; reveal makes room for it, and without room it starts right of the candle',()=>{
  // A signal 40 candles back, out of view on a 390 px chart that follows the latest data.
  const d=scene(),bar=d.bars[80],{chart,calls}=setup({width:390,height:600});
  const long=storedSignal(bar,{entry:85300,sl:85000,tp:85900,origin:'live'}),short=storedSignal(bar,{side:'short',entry:85300,sl:85600,tp:84700,origin:'live'});
  const drawLabel=picked=>{chart.setData({...d,picked});calls.length=0;chart.render();const k=calls.find(c=>c.op==='fillText'&&/^[▲▼] (KÖP|SÄLJ) \d/.test(c.text));return {k,pill:pillOf(calls,k)};};
  const v=()=>chart.view(),price=y=>chart.hitTest(150,y).price,slotLeft=()=>xOf(chart,bar.t),mid=()=>centre(chart,bar.t);
  chart.setData({...d,picked:long});chart.render();assert.ok(mid()<v().plot.left);
  // The label is 118 px wide here (6 px a character and the pill's padding): a third of the plot is less than that, so
  // reveal puts the candle just far enough in for it, and the label covers none of the candles from the signal on.
  assert.equal(chart.reveal(bar.t),true);
  let {k,pill}=drawLabel(long);
  assert.equal(pill[2],118);assert.match(k.text,/^▲ KÖP \d+ okt \d\d:\d\d$/);
  assert.ok(pill[0]>=v().plot.left+4-1e-9,'whole inside the plot');
  // Drawn over the last price's dotted line, which often runs at the entry's height right after a signal.
  const lastLine=calls.findIndex(c=>c.op==='stroke'&&c.dash.join()==='1,3'&&/^rgba\((20,167,160|226,72,60),0\.8\)$/.test(c.stroke));
  assert.ok(lastLine>=0&&calls.indexOf(k)>lastLine,'over the last price\'s line');
  assert.ok(pill[0]+pill[2]<=slotLeft()&&pill[0]+pill[2]>=slotLeft()-4,'ends just before the signal candle\'s slot');
  assert.ok(mid()-v().plot.left>(v().plot.right-v().plot.left)/3,'further in than a third, for the label');
  // A long's label sits over its entry line (on the target's side), a short's under it. The short's is 6 px wider ("SÄLJ"):
  // the room made for the long one is too little, so it starts right of the candle until reveal makes room for it too.
  assert.ok(price(pill[1]+pill[3])>85300,'long: over the entry line');
  ({pill}=drawLabel(short));assert.ok(pill[0]>mid());
  assert.equal(chart.reveal(bar.t),true);
  ({pill}=drawLabel(short));assert.ok(price(pill[1])<85300,'short: under the entry line');assert.ok(pill[0]+pill[2]<=slotLeft()&&pill[0]>=v().plot.left+4-1e-9);
  // In view with room for the label, reveal leaves the chart alone.
  const at=v().rightT;assert.equal(chart.reveal(bar.t),false);assert.equal(v().rightT,at);
  // Panned until the candle is 60 px from the left edge: inside the middle 80 %, but without room for its label. There the
  // label starts just right of the candle's centre; reveal brings the candle in far enough and the label is back on its left.
  chart.panBy(60-(mid()-v().plot.left),0);
  ({pill}=drawLabel(long));assert.ok(pill[0]>mid(),'without room: right of the candle\'s centre');
  assert.equal(chart.reveal(bar.t),true);
  ({pill}=drawLabel(long));assert.ok(pill[0]+pill[2]<=slotLeft()&&pill[0]>=v().plot.left+4-1e-9);
  // Without a pick, or with another candle picked, only the middle 80 % counts, as before.
  chart.panBy(60-(mid()-v().plot.left),0);const before=v().rightT;
  chart.setData({...d,picked:null});assert.equal(chart.reveal(bar.t),false);
  chart.setData({...d,picked:storedSignal(d.bars[100])});assert.equal(chart.reveal(bar.t),false);assert.equal(v().rightT,before);
  // A plot too narrow for the label left of the candle even at its middle: a third from the left as before, label on the right.
  const narrow=setup({width:300,height:600});narrow.chart.setData({...d,picked:long});narrow.chart.render();
  const nv=()=>narrow.chart.view(),nw=nv().plot.right-nv().plot.left;assert.ok(nw/2<118+nv().barPx/2+6,'too narrow: '+nw);
  assert.equal(narrow.chart.reveal(bar.t),true);near(centre(narrow.chart,bar.t),nv().plot.left+nw/3,1e-6);
  narrow.calls.length=0;narrow.chart.render();const nk=narrow.calls.find(c=>c.op==='fillText'&&/^▲ KÖP \d/.test(c.text));
  assert.ok(pillOf(narrow.calls,nk)[0]>centre(narrow.chart,bar.t),'right of the candle\'s centre');
  assert.equal(narrow.chart.reveal(bar.t),false,'and it stays there');
});

test('reveal brings a candle far back into view a third from the left, like a pan, and leaves a candle in view alone',()=>{
  const d=scene(),{chart}=setup();chart.setData(d);chart.render();
  const v0=chart.view();
  assert.equal(chart.reveal(d.bars[115].t),false,'already in view');assert.deepEqual(chart.view(),v0);
  const far=d.bars[20].t;assert.equal(chart.reveal(far),true);
  const v=chart.view();
  near(centre(chart,far),v.plot.left+(v.plot.right-v.plot.left)/3,1e-6,'a third from the left');
  assert.deepEqual([v.follow,v.price,v.barPx],[false,null,v0.barPx]);
  assert.equal(chart.reveal(far),false,'now in view');
  // Like a pan: a new candle leaves the view where it is, and End returns to the latest.
  chart.setData(sceneFrom(makeBars(121)));assert.equal(chart.view().rightT,v.rightT);
  chart.scrollToLatest();assert.equal(chart.view().follow,true);
  assert.equal(chart.reveal(NaN),false);
});
