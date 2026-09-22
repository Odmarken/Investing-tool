// Isometric office for the trading floor: layout, walking routes, the little
// people and the canvas renderer. The layout and the simulation are pure and
// testable; only createScene touches a canvas.
import {FLOOR,ROOMS,traderNames} from './trading-floor.js';

export const TILE=Object.freeze({w:60,h:30});
export const GRID=Object.freeze({w:24,h:18});
export const CANVAS=Object.freeze({w:1320,h:820});
export const ORIGIN=Object.freeze({x:570,y:175});
export const WALL_H=190;
// Walkable lines. Every seat and spot connects to one of them.
export const AISLES=Object.freeze({vertical:Object.freeze([6.5,11,15.5,20]),horizontal:Object.freeze([1.4,8,15])});
export const project=(x,y,z=0)=>({x:ORIGIN.x+(x-y)*TILE.w/2,y:ORIGIN.y+(x+y)*TILE.h/2-z});
const near=(a,b)=>Math.abs(a-b)<1e-6;
// Derived from the current open trade, never from accumulated desk profits.
// No stored celebration state: closing, losing the threshold or stale prices
// removes the props on the very next frame, including any airborne banknotes.
export function deskCelebration(desk,now){
  if(desk?.status!=='trade'||!Number.isFinite(desk.openReturn)||!Number.isFinite(desk.celebrationUntil)||now>desk.celebrationUntil)return null;
  return desk.openReturn>=.5?'lounge':desk.openReturn>=.2?'money':null;
}
export function celebrationPose(agent,mode,now,reduced=false){
  if(agent.kind!=='trader'||!mode)return null;
  const desk=DESK_GEOMETRY.find(d=>d.symbol===agent.desk),seat=desk?.seats.findIndex(s=>s.key===agent.home.key);
  if(!desk||seat<0)return null;
  const phase=reduced?agent.phase:now/420+agent.phase;
  if(mode==='money')return {mode,x:desk.x0+(seat<2 ? .5 : 1),y:desk.y0+.75+(seat%2)*2.1,
    z:24+(reduced?0:Math.abs(Math.sin(phase))*10),lean:0,facing:reduced?agent.home.facing:['+x','+y','-x','-y'][Math.floor(now/360+agent.phase)%4]};
  return {mode,x:agent.home.x,y:agent.home.y,z:0,lean:agent.home.facing==='+x'?-.32:.32,facing:agent.home.facing};
}
const towards=(from,to)=>{const dx=to.x-from.x,dy=to.y-from.y;return Math.abs(dx)>=Math.abs(dy)?(dx>=0?'+x':'-x'):(dy>=0?'+y':'-y');};

export const ROOM_GEOMETRY=ROOMS.map((room,i)=>{
  const y0=i*4.5;
  return {...room,x0:0,x1:4.5,y0,y1:y0+4,desk:{x0:0.9,x1:2.2,y0:y0+0.9,y1:y0+3.1},door:{y0:y0+3,y1:y0+4},plant:{x:4,y:y0+0.5},
    seat:{key:'office:'+room.id,kind:'office',x:0.45,y:y0+2,facing:'+x',aisle:{x:6.5,y:y0+3.5},path:[{x:0.45,y:y0+3.5},{x:5.3,y:y0+3.5}]}};
});
export const DESK_GEOMETRY=FLOOR.desks.map((symbol,i)=>{
  const col=i%3,row=Math.floor(i/3),cx=8+col*4.5,py=2.5+row*7;
  const seat=(n,x,y,facing,ax)=>({key:'seat:'+symbol+':'+n,kind:'seat',x,y,facing,aisle:{x:ax,y},path:[]});
  return {symbol,index:i,x0:cx,x1:cx+1.5,y0:py,y1:py+4,names:traderNames(symbol),
    seats:[seat(0,cx-0.75,py+1,'+x',cx-1.5),seat(1,cx-0.75,py+3,'+x',cx-1.5),seat(2,cx+2.25,py+1,'-x',cx+3),seat(3,cx+2.25,py+3,'-x',cx+3)],
    visit:{key:'visit:'+symbol,kind:'visit',x:cx-1.5,y:py+2,facing:'+x',aisle:{x:cx-1.5,y:py+2},path:[]}};
});
export const FIKA=Object.freeze({x0:17.2,x1:24,y0:15.4,y1:18,table:{x:20.8,y:16.9,r:0.55},sofa:{x0:17.5,x1:19,y0:17.1,y1:17.8},coffee:{x:23.3,y:15.9},cooler:{x:8.6,y:17.3}});
const spot=(kind,i,x,y,facing,aisle,path=[])=>({key:kind+':'+i,kind,x,y,facing,aisle,path});
export const SPOTS=Object.freeze({
  screen:[8.5,10,11.5,13,14.5].map((x,i)=>spot('screen',i,x,1.4,'-y',{x,y:1.4})),
  news:[18,19.5,21].map((x,i)=>spot('news',i,x,1.4,'-y',{x,y:1.4})),
  chat:[[9,8],[13.5,8],[17.5,8],[9,15],[13.5,15]].map(([x,y],i)=>spot('chat',i,x,y,i%2?'-x':'+x',{x,y})),
  fika:[180,225,270,315,0].map((a,i)=>{const r=a*Math.PI/180,x=+(FIKA.table.x+Math.cos(r)*0.95).toFixed(3),y=+(FIKA.table.y+Math.sin(r)*0.95).toFixed(3);
    return spot('fika',i,x,y,towards({x,y},FIKA.table),{x:20,y:15},[{x:20.8,y:15.6}]);}),
  sofa:[17.9,18.6].map((x,i)=>spot('sofa',i,x,17.4,'-y',{x:20,y:15},[{x,y:15.6}])),
  coffee:[spot('coffee',0,22.8,16.1,'+x',{x:20,y:15},[{x:22.8,y:15.6}])],
  cooler:[spot('cooler',0,8.6,16.6,'+y',{x:6.5,y:16.6})]
});
export const PLANTS=Object.freeze([{x:5.6,y:0.5},{x:23.4,y:0.5},{x:11.6,y:17.6},{x:23.5,y:8.3},{x:14.6,y:17.6},{x:16.6,y:17.6}]);
export const SCREENS=Object.freeze({equity:{x0:5.8,x1:16.2,top:178,bottom:32},news:{x0:16.8,x1:23.6,top:178,bottom:32}});
export const allLocations=()=>[...ROOM_GEOMETRY.map(r=>r.seat),...DESK_GEOMETRY.flatMap(d=>[...d.seats,d.visit]),...Object.values(SPOTS).flat()];

export function onNetwork(p){return AISLES.vertical.some(x=>near(p.x,x))||AISLES.horizontal.some(y=>near(p.y,y));}
// Manhattan route along the aisles between two aisle points, ending at b.
export function routeBetween(a,b){
  const av=AISLES.vertical.find(x=>near(a.x,x)),bv=AISLES.vertical.find(x=>near(b.x,x));
  const ah=AISLES.horizontal.find(y=>near(a.y,y)),bh=AISLES.horizontal.find(y=>near(b.y,y));
  const best=(list,pick)=>list.reduce((m,v)=>pick(v)<pick(m)?v:m);
  if(av!==undefined&&bv!==undefined){
    if(near(av,bv))return [b];
    const yh=best(AISLES.horizontal,y=>Math.abs(a.y-y)+Math.abs(b.y-y));
    return [{x:av,y:yh},{x:bv,y:yh},b];
  }
  if(av!==undefined&&bh!==undefined)return [{x:av,y:bh},b];
  if(ah!==undefined&&bv!==undefined)return [{x:bv,y:ah},b];
  if(ah!==undefined&&bh!==undefined){
    if(near(ah,bh))return [b];
    const xv=best(AISLES.vertical,x=>Math.abs(a.x-x)+Math.abs(b.x-x));
    return [{x:xv,y:ah},{x:xv,y:bh},b];
  }
  throw Error('Punkten ligger inte på gångnätet');
}
export function routeTo(from,to){
  if(from===to||from.key&&from.key===to.key)return [];
  const out=[...from.path,from.aisle,...routeBetween(from.aisle,to.aisle),...[...to.path].reverse(),{x:to.x,y:to.y}];
  return out.filter((p,i)=>!i||!(near(p.x,out[i-1].x)&&near(p.y,out[i-1].y)));
}

const SKIN=['#f9d9bf','#eebb96','#d09a6a','#a86f45','#7a4a2c'];
const HAIR=['#2a1b14','#4b2e1b','#c98a3c','#151515','#a83e2a','#d8c7a3','#72695f'];
const SHIRT=['#c29d79','#718791','#667663','#c7b99d','#56616c','#ab755c','#68918c','#e9e5dc','#894f46','#8b9276','#ae9563','#8c9d9c'];
const look=k=>({skin:SKIN[k%SKIN.length],hair:HAIR[(k*3+3)%HAIR.length],shirt:SHIRT[(k*5+1)%SHIRT.length],glasses:k%5===2,beard:k%3===0,style:k%4,headset:k%6===1});
const STAFF_LOOK={elias:{skin:'#f3cfae',hair:'#3a2618',shirt:'#424e53',tie:'#c5ac83'},pablo:{skin:'#e3b08a',hair:'#1c1c1c',shirt:'#e8e2d5',tie:'#8ed7cc'},
  manuel:{skin:'#c98d5a',hair:'#2a1b14',shirt:'#ed8575'},miguel:{skin:'#d9a97f',hair:'#5a3a22',shirt:'#e4bc75',glasses:true}};
export function createAgents(rnd=Math.random){
  const agents=[];
  for(const desk of DESK_GEOMETRY)desk.seats.forEach((seat,i)=>{
    const k=desk.index*4+i;
    agents.push({id:'trader:'+desk.symbol+':'+i,name:desk.names[i],kind:'trader',desk:desk.symbol,home:seat,look:look(k),
      pos:{x:seat.x,y:seat.y},facing:seat.facing,state:'seated',activity:'work',at:seat,target:seat,path:[],until:0,stay:0,hurry:false,phase:rnd()*Math.PI*2,step:0});
  });
  for(const room of ROOM_GEOMETRY)agents.push({id:'staff:'+room.id,name:room.name,kind:'staff',room:room.id,home:room.seat,look:STAFF_LOOK[room.id],
    pos:{x:room.seat.x,y:room.seat.y},facing:room.seat.facing,state:'seated',activity:'office',at:room.seat,target:room.seat,path:[],until:0,stay:0,hurry:false,phase:0,step:0});
  return agents;
}
const SPEED=1.7,HURRY=2.6;
const between=(rnd,a,b)=>a+rnd()*(b-a);
const TRADER_ACTIVITIES=[['work',3],['fika',2],['sofa',1],['coffee',1],['cooler',1],['screen',2],['news',1],['chat',1],['walk',1]];
const DURATION={work:[25,70],office:[60,180],fika:[20,50],sofa:[20,45],coffee:[8,20],cooler:[8,18],screen:[10,30],news:[10,30],chat:[10,25],walk:[3,8],visit:[12,30]};
function occupied(agents){const set=new Set();for(const a of agents)if(a.target?.key&&a.target.kind!=='seat'&&a.target.kind!=='office')set.add(a.target.key);return set;}
function freeSpot(kind,taken,rnd){const list=(SPOTS[kind]??[]).filter(s=>!taken.has(s.key));return list.length?list[Math.floor(rnd()*list.length)]:null;}
function walkSpot(rnd){const x=AISLES.vertical[Math.floor(rnd()*AISLES.vertical.length)],y=+between(rnd,1.4,15).toFixed(2);return {key:null,kind:'walk',x,y,facing:'+y',aisle:{x,y},path:[]};}
function arrive(agent,now){
  const t=agent.target;agent.pos={x:t.x,y:t.y};agent.at=t;agent.path=[];agent.facing=t.facing;
  agent.state=['seat','office','fika','sofa'].includes(t.kind)?'seated':'standing';agent.until=now+agent.stay;agent.hurry=false;
}
function send(agent,location,activity,now,rnd,reduced){
  const [lo,hi]=DURATION[activity]??[10,20];
  agent.activity=activity;agent.stay=between(rnd,lo,hi)*1000;
  if(agent.at===location||agent.at.key&&agent.at.key===location.key){agent.target=location;agent.until=now+agent.stay;return;}
  const path=routeTo(agent.at,location);
  agent.target=location;
  if(reduced){arrive(agent,now);return;}
  agent.path=path;agent.state='walking';
}
function decide(agent,world,agents,now,rnd){
  const taken=occupied(agents),reduced=!!world.reduced;
  if(agent.kind==='trader'){
    if(world.inTrade[agent.desk]){agent.hurry=agent.at!==agent.home;return send(agent,agent.home,'work',now,rnd,reduced);}
    const pool=TRADER_ACTIVITIES.flatMap(([k,w])=>Array(w).fill(k));
    for(let tries=0;tries<4;tries++){
      const kind=pool[Math.floor(rnd()*pool.length)];
      if(kind==='work')return send(agent,agent.home,'work',now,rnd,reduced);
      if(kind==='walk')return send(agent,walkSpot(rnd),'walk',now,rnd,reduced);
      const s=freeSpot(kind,taken,rnd);if(s)return send(agent,s,kind,now,rnd,reduced);
    }
    return send(agent,agent.home,'work',now,rnd,reduced);
  }
  // Staff make one outing from the office and then return.
  if(agent.at!==agent.home||agent.activity!=='office')return send(agent,agent.home,'office',now,rnd,reduced);
  const inTrade=FLOOR.desks.filter(s=>world.inTrade[s]);
  const visit=symbol=>{const d=DESK_GEOMETRY.find(d=>d.symbol===symbol);return d&&!taken.has(d.visit.key)?d.visit:null;};
  let s=null,kind='walk';
  if(agent.room==='elias'){const v=inTrade.length?visit(inTrade[Math.floor(rnd()*inTrade.length)]):null;if(v){s=v;kind='visit';}else{s=freeSpot('screen',taken,rnd);kind='screen';}}
  else if(agent.room==='pablo'){s=freeSpot('screen',taken,rnd);kind='screen';if(!s||rnd()<.3){const v=inTrade.length?visit(inTrade[0]):null;if(v){s=v;kind='visit';}}}
  else if(agent.room==='manuel'){const v=world.riskDesk?visit(world.riskDesk):null;if(v){s=v;kind='visit';}else{s=freeSpot('coffee',taken,rnd);kind='coffee';}}
  else{s=freeSpot('news',taken,rnd);kind='news';if(!s){s=freeSpot('coffee',taken,rnd);kind='coffee';}}
  if(!s){s=walkSpot(rnd);kind='walk';}
  return send(agent,s,kind,now,rnd,reduced);
}
// world: {inTrade:{BTC:true,...}, riskDesk:'ETH'|null, reduced:boolean}
export function stepAgents(agents,world,now,dt,rnd=Math.random){
  dt=Math.min(Math.max(dt,0),0.1);
  for(const agent of agents){
    if(agent.state==='walking'){
      if(world.reduced){arrive(agent,now);continue;}
      let left=(agent.hurry?HURRY:SPEED)*dt;
      while(agent.path.length&&left>0){
        const p=agent.path[0],dx=p.x-agent.pos.x,dy=p.y-agent.pos.y,dist=Math.hypot(dx,dy);
        if(dist<=left){agent.pos={x:p.x,y:p.y};agent.path.shift();left-=dist;}
        else{agent.pos={x:agent.pos.x+dx/dist*left,y:agent.pos.y+dy/dist*left};agent.facing=towards({x:0,y:0},{x:dx,y:dy});left=0;}
      }
      agent.step+=dt*11;
      if(!agent.path.length)arrive(agent,now);
      continue;
    }
    // A trader away from the desk returns the moment the desk enters a trade.
    if(agent.kind==='trader'&&world.inTrade[agent.desk]&&agent.at!==agent.home){decide(agent,world,agents,now,rnd);continue;}
    if(now>=agent.until)decide(agent,world,agents,now,rnd);
  }
  return agents;
}

const C={bgTop:'#c7c4bd',bgBottom:'#e7e1d5',floorA:'#d6d0c3',floorB:'#cfc9bc',roomA:'#e8dfcb',roomB:'#dfd5bf',fikaA:'#bfb8a7',fikaB:'#b7b09f',tileLine:'rgba(78,75,66,.12)',
  wall:'#dedbd3',wallDeep:'#a9aaa5',wallLine:'rgba(255,252,240,.6)',glass:'rgba(186,210,208,.15)',glassLine:'rgba(94,118,118,.6)',
  deskTop:'#e9dcc0',deskLeft:'#bca98a',deskRight:'#a6967e',deskLine:'rgba(78,71,58,.25)',monitor:'#242c2e',screenIdle:'#50696a',
  chairA:'#c5ac83',chairB:'#849692',plate:'rgba(38,44,44,.94)',pink:'#c5ac83',cyan:'#8ed7cc',pos:'#78c997',neg:'#ed8575',amber:'#e4bc75',
  text:'#ffffff',muted:'#cbc9be',dim:'#9daba5',panel:'#202a2c',plant:'#78c997',plantDeep:'#527e57',pot:'#bba887',wood:'#cfb58c',woodDeep:'#9e896b'};
const MONO='ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',SANS='"Inter", "Segoe UI", Roboto, sans-serif';
const money=n=>n.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
const signed=n=>(n>=0?'+':'')+money(n);
const clock=t=>new Date(t).toLocaleTimeString('sv-SE',{timeZone:'Europe/Stockholm',hour:'2-digit',minute:'2-digit'});
const hex=(x0,y0,x1,y1,h)=>[project(x0,y0,h),project(x1,y0,h),project(x1,y0,0),project(x1,y1,0),project(x0,y1,0),project(x0,y1,h)];
const inside=(pts,x,y)=>{let hit=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const a=pts[i],b=pts[j];if(a.y>y!==b.y>y&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)hit=!hit;}return hit;};
const screenPoly=s=>[project(s.x0,0,s.top),project(s.x1,0,s.top),project(s.x1,0,s.bottom),project(s.x0,0,s.bottom)];
export const REGIONS=()=>[
  ...Object.entries(SCREENS).map(([id,s])=>({kind:'screen',id,poly:screenPoly(s)})),
  ...ROOM_GEOMETRY.map(r=>({kind:'room',id:r.id,poly:hex(r.x0,r.y0,r.x1,r.y1,120)})),
  ...DESK_GEOMETRY.map(d=>({kind:'desk',id:d.symbol,poly:hex(d.x0-1.3,d.y0-0.4,d.x1+1.3,d.y1+0.4,46)})),
  {kind:'fika',id:'fika',poly:hex(FIKA.x0,FIKA.y0,FIKA.x1,FIKA.y1,34)}
];
export function hitAt(x,y,regions=REGIONS()){return regions.find(r=>inside(r.poly,x,y))??null;}

// The camera maps the fixed world (CANVAS) onto a viewport of any size.
// Zooming keeps the point under the cursor still; panning keeps part of the
// world on screen so the office can never be lost.
export function createCamera(world=CANVAS){
  const cam={zoom:1,x:0,y:0,width:world.w,height:world.h,fitZoom:1};
  const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
  function limits(){
    const w=world.w*cam.zoom,h=world.h*cam.zoom,keepX=Math.min(w,cam.width)*.25,keepY=Math.min(h,cam.height)*.25;
    cam.x=clamp(cam.x,keepX-w,cam.width-keepX);cam.y=clamp(cam.y,keepY-h,cam.height-keepY);
  }
  return {
    fit(width=cam.width,height=cam.height,margin=24){
      cam.width=width;cam.height=height;
      cam.fitZoom=Math.max(.05,Math.min((width-margin*2)/world.w,(height-margin*2)/world.h));
      cam.zoom=cam.fitZoom;cam.x=(width-world.w*cam.zoom)/2;cam.y=(height-world.h*cam.zoom)/2;
    },
    resize(width,height){cam.width=width;cam.height=height;limits();},
    zoomAt(px,py,factor){
      if(!Number.isFinite(factor)||factor<=0)return;
      const next=clamp(cam.zoom*factor,cam.fitZoom*.5,Math.max(cam.fitZoom*6,4)),k=next/cam.zoom;
      cam.x=px-(px-cam.x)*k;cam.y=py-(py-cam.y)*k;cam.zoom=next;limits();
    },
    panBy(dx,dy){cam.x+=dx;cam.y+=dy;limits();},
    toWorld(px,py){return {x:(px-cam.x)/cam.zoom,y:(py-cam.y)/cam.zoom};},
    toScreen(wx,wy){return {x:wx*cam.zoom+cam.x,y:wy*cam.zoom+cam.y};},
    state(){return {...cam};}
  };
}

export function createScene(canvas){
  const ctx=canvas.getContext?.('2d');if(!ctx)return null;
  let dpr=0,width=0,height=0,fitted=false,interacted=false,hover=null,particles=[];const regions=REGIONS(),truncated=new Map(),camera=createCamera(CANVAS);
  function resize(){
    const cw=canvas.clientWidth||0,ch=canvas.clientHeight||0,w=cw||CANVAS.w,h=ch||CANVAS.h,next=Math.min(2,globalThis.devicePixelRatio||1);
    if(w===width&&h===height&&next===dpr)return;
    width=w;height=h;dpr=next;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
    // Fit once the canvas has a real size; keep the user's own view afterwards.
    if(!fitted||!interacted){camera.fit(w,h);fitted=cw>0;}else camera.resize(w,h);
  }
  const poly=(pts,fill,stroke,lw=1)=>{ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=lw;ctx.stroke();}};
  // An iso block between two heights: the two visible faces, then the top.
  const zbox=(x0,y0,x1,y1,z0,z1,top,left,right,stroke)=>{
    poly([project(x0,y1,z1),project(x1,y1,z1),project(x1,y1,z0),project(x0,y1,z0)],left,stroke);
    poly([project(x1,y0,z1),project(x1,y1,z1),project(x1,y1,z0),project(x1,y0,z0)],right,stroke);
    poly([project(x0,y0,z1),project(x1,y0,z1),project(x1,y1,z1),project(x0,y1,z1)],top,stroke);
  };
  const box=(x0,y0,x1,y1,h,top,left,right,stroke)=>zbox(x0,y0,x1,y1,0,h,top,left,right,stroke);
  const wallY=(y,x0,x1,h,fill,stroke)=>poly([project(x0,y,h),project(x1,y,h),project(x1,y,0),project(x0,y,0)],fill,stroke);
  const wallX=(x,y0,y1,h,fill,stroke)=>poly([project(x,y0,h),project(x,y1,h),project(x,y1,0),project(x,y0,0)],fill,stroke);
  const rect=(x,y,w,h,fill)=>{ctx.fillStyle=fill;ctx.fillRect(x,y,w,h);};
  const round=(x,y,w,h,r,fill,stroke,lw=1)=>{ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=lw;ctx.stroke();}};
  const circle=(x,y,r,fill)=>{ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=fill;ctx.fill();};
  const text=(s,x,y,font,fill,align='left')=>{ctx.font=font;ctx.fillStyle=fill;ctx.textAlign=align;ctx.textBaseline='alphabetic';ctx.fillText(s,x,y);};
  function fit(s,font,max){
    const key=font+'|'+max+'|'+s;if(truncated.has(key))return truncated.get(key);
    ctx.font=font;let out=s;
    if(ctx.measureText(out).width>max){while(out.length>1&&ctx.measureText(out+'…').width>max)out=out.slice(0,-1);out+='…';}
    if(truncated.size>600)truncated.clear();truncated.set(key,out);return out;
  }
  const zone=(x,y)=>{
    if(x<=4&&ROOM_GEOMETRY.some(r=>y+0.5>=r.y0&&y+0.5<r.y1))return 'room';
    if(x+0.5>=FIKA.x0&&y+0.5>=FIKA.y0)return 'fika';
    return 'floor';
  };
  function backdrop(){
    // Screen space: fills the whole viewport whatever the camera does.
    const g=ctx.createLinearGradient(0,0,0,height);g.addColorStop(0,C.bgTop);g.addColorStop(1,C.bgBottom);
    rect(0,0,width,height,g);
    const c=camera.toScreen(660,420),r=760*camera.state().zoom;
    const glow=ctx.createRadialGradient(c.x,c.y,r*.05,c.x,c.y,r);glow.addColorStop(0,'rgba(255,248,225,.5)');glow.addColorStop(1,'rgba(255,248,225,0)');
    rect(0,0,width,height,glow);
  }
  function background(){
    // A raised concrete slab gives the miniature office a visible edge.
    zbox(0,0,GRID.w,GRID.h,-14,0,C.floorA,'#a8a398','#93968e');
    for(let y=0;y<GRID.h;y++)for(let x=0;x<GRID.w;x++){
      const z=zone(x,y),odd=(x+y)%2,fill=z==='room'?(odd?C.roomA:C.roomB):z==='fika'?(odd?C.fikaA:C.fikaB):(odd?C.floorA:C.floorB);
      poly([project(x,y),project(x+1,y),project(x+1,y+1),project(x,y+1)],fill,C.tileLine,.6);
    }
    // Far walls with the two wall-mounted screens.
    const gl=ctx.createLinearGradient(0,project(0,0,WALL_H).y,0,project(0,GRID.h).y);gl.addColorStop(0,C.wall);gl.addColorStop(1,C.wallDeep);
    wallX(0,0,GRID.h,WALL_H,gl,C.wallLine);
    const gr=ctx.createLinearGradient(0,project(0,0,WALL_H).y,0,project(GRID.w,0).y);gr.addColorStop(0,C.wall);gr.addColorStop(1,C.wallDeep);
    wallY(0,0,GRID.w,WALL_H,gr,C.wallLine);
    // Warm cove lighting and tall windows behind the private offices.
    for(const r of ROOM_GEOMETRY){
      const y0=r.y0+.35,y1=r.y0+3.6;
      poly([project(0,y0,173),project(0,y1,173),project(0,y1,65),project(0,y0,65)],'#edf0e8','#8e9b96',2);
      for(let i=0;i<7;i++){
        const y=y0+i*.45,h=78+(i*19%51);
        poly([project(0,y,h),project(0,y+.3,h),project(0,y+.3,66),project(0,y,66)],i%2?'#c4cec7':'#b4c2bc');
      }
      poly([project(0,(y0+y1)/2,173),project(0,(y0+y1)/2+.045,173),project(0,(y0+y1)/2+.045,65),project(0,(y0+y1)/2,65)],'#8e9b96');
      poly([project(.02,y0,176),project(.02,y1,176),project(.02,y1,179),project(.02,y0,179)],'#fff2cc');
    }
    // A woven rug defines the lounge without changing any walking routes.
    poly([project(17.3,15.7),project(23.7,15.7),project(23.7,17.9),project(17.3,17.9)],'#a9a48e');
    for(let y=15.8;y<17.9;y+=.2)poly([project(17.4,y),project(23.6,y),project(23.6,y+.025),project(17.4,y+.025)],'rgba(239,228,198,.4)');
    poly([project(0,0,WALL_H),project(GRID.w,0,WALL_H),project(GRID.w,0,WALL_H-6),project(0,0,WALL_H-6)],'rgba(255,255,255,.18)');
    poly([project(0,0,WALL_H),project(0,GRID.h,WALL_H),project(0,GRID.h,WALL_H-6),project(0,0,WALL_H-6)],'rgba(255,255,255,.12)');
    // Firm name on the left wall as a billboard.
    const lp=project(0,9,118);
    text('RIPTIDE',lp.x-4,lp.y,'800 13px '+SANS,'#46534e','center');
    text('INVESTMENTS · TRADING FLOOR',lp.x-4,lp.y+13,'700 7.5px '+SANS,'#60716a','center');
  }
  function screenFrame(s,now,hot){
    const p=project(s.x0,0,s.top),w=(s.x1-s.x0)*TILE.w/2,h=s.top-s.bottom;
    ctx.save();ctx.transform(1,TILE.h/TILE.w,0,1,p.x,p.y);
    ctx.shadowColor=hot?'rgba(137,191,180,.65)':'rgba(35,47,45,.28)';ctx.shadowBlur=hot?26:16;
    round(0,0,w,h,6,C.panel,hot?C.cyan:C.pink,hot?2:1.4);
    ctx.shadowBlur=0;
    const gloss=ctx.createLinearGradient(0,0,0,h);gloss.addColorStop(0,'rgba(255,255,255,.07)');gloss.addColorStop(.35,'rgba(255,255,255,0)');
    round(0,0,w,h,6,gloss);
    return {w,h};
  }
  function drawEquityScreen(view,now){
    const s=SCREENS.equity,{w,h}=screenFrame(s,now,hover?.kind==='screen'&&hover.id==='equity');
    const t=view.total,val=t.value??t.last??null;
    text('RIPTIDE · TRADING FLOOR',10,14,'800 8.5px '+SANS,C.pink);
    text(view.paused?'NYA KÖP PAUSADE':'KAPITAL · LIVE',w-10,14,'700 8px '+SANS,view.paused?C.amber:C.muted,'right');
    text(val===null?'– $':money(val),10,46,'700 25px '+MONO,t.value===null?C.dim:C.text);
    ctx.font='700 25px '+MONO;const tw=ctx.measureText(val===null?'– $':money(val)).width;
    if(val!==null){const net=val-view.start,cls=net>=0?C.pos:C.neg;text(signed(net)+' · '+(net>=0?'+':'')+(net/view.start*100).toFixed(2)+' %',18+tw,46,'700 10.5px '+MONO,cls);}
    if(t.value===null)text(t.waiting?.length?'väntar på pris · '+t.waiting.join(' '):'väntar på pris',18+tw,46-14,'600 7.5px '+SANS,C.amber);
    else if(t.at)text('uppdaterat '+clock(t.at),18+tw,46-14,'600 7.5px '+SANS,C.dim);
    // Equity line over the last 24 hours, baseline at the invested amount.
    const x0=10,x1=w-10,y0=58,y1=116,points=view.equity.filter(p=>p.t>=now-86400000);
    if(t.value!==null)points.push({t:now,v:t.value});
    const lo=Math.min(view.start,...points.map(p=>p.v)),hi=Math.max(view.start,...points.map(p=>p.v)),pad=Math.max(.5,(hi-lo)*.15);
    const yOf=v=>y1-(v-(lo-pad))/((hi+pad)-(lo-pad))*(y1-y0),tMin=points.length?Math.min(points[0].t,now-3600000):now-3600000;
    const xOf=tt=>x0+(tt-tMin)/Math.max(1,now-tMin)*(x1-x0);
    ctx.setLineDash([3,3]);ctx.strokeStyle='rgba(210,213,198,.25)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x0,yOf(view.start));ctx.lineTo(x1,yOf(view.start));ctx.stroke();ctx.setLineDash([]);
    text(money(view.start),x1,yOf(view.start)-3,'600 7px '+MONO,C.dim,'right');
    if(points.length>1){
      const up=points.at(-1).v>=view.start,col=up?C.pos:C.neg;
      ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(xOf(p.t),yOf(p.v)):ctx.moveTo(xOf(p.t),yOf(p.v)));
      ctx.lineTo(xOf(points.at(-1).t),y1);ctx.lineTo(xOf(points[0].t),y1);ctx.closePath();
      const area=ctx.createLinearGradient(0,y0,0,y1);area.addColorStop(0,up?'rgba(61,220,132,.35)':'rgba(255,51,85,.35)');area.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=area;ctx.fill();
      ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(xOf(p.t),yOf(p.v)):ctx.moveTo(xOf(p.t),yOf(p.v)));ctx.strokeStyle=col;ctx.lineWidth=1.8;ctx.stroke();
      const last=points.at(-1);circle(xOf(last.t),yOf(last.v),2.6,col);
    }else text('Kapitalkurvan ritas när första minutproverna finns',x0,y0+30,'600 7.5px '+SANS,C.dim);
    // One chip per desk.
    const cw=(w-20)/FLOOR.desks.length;
    FLOOR.desks.forEach((symbol,i)=>{
      const d=view.desks[symbol],x=10+i*cw,col=d.pnl===null?C.dim:d.pnl>=0?C.pos:C.neg;
      round(x+1,124,cw-2,16,3,'rgba(255,255,255,.05)',d.status==='trade'?col:'rgba(255,255,255,.12)',.8);
      text(symbol,x+5,135,'800 7.5px '+SANS,C.text);
      text(d.pnl===null?'–':(d.pnl>=0?'+':'')+d.pnl.toFixed(2),x+cw-5,135,'700 7.5px '+MONO,col,'right');
    });
    ctx.restore();
  }
  function drawNewsScreen(view,now){
    const s=SCREENS.news,{w,h}=screenFrame(s,now,hover?.kind==='screen'&&hover.id==='news');
    text('NYHETER · VÄRLDEN & KRYPTO',10,14,'800 8px '+SANS,C.pink);
    text(view.news.length?view.news.length+' rubriker':'',w-10,14,'700 7px '+SANS,C.muted,'right');
    const rows=view.news.slice(0,40),rowH=13,top=22,bottom=h-8;
    ctx.save();ctx.beginPath();ctx.rect(6,top,w-12,bottom-top);ctx.clip();
    if(!rows.length)text('Inga rubriker ännu · flödet fylls på vid nästa uppdatering',10,top+30,'600 7.5px '+SANS,C.dim);
    else{
      const cycle=rows.length*rowH,offset=view.reduced?0:(now/1000*9)%cycle;
      for(let pass=0;pass<2;pass++)rows.forEach((n,i)=>{
        const y=top+11+i*rowH-offset+pass*cycle;if(y<top-2||y>bottom+12)return;
        text(clock(n.ts),10,y,'600 6.5px '+MONO,n.world?C.cyan:C.pink);
        text(fit(n.title,'600 7.5px '+SANS,w-52),38,y,'600 7.5px '+SANS,n.hot?'#f0dec0':C.text);
      });
    }
    ctx.restore();ctx.restore();
  }
  function monitor(x,y,facing,z,color,glow){
    // A slim monitor standing on the desk top. The lit top edge shows the
    // desk's state even when the screen faces away from the viewer.
    const c=project(x,y,z),g=ctx.createRadialGradient(c.x,c.y,1,c.x,c.y,24);g.addColorStop(0,glow);g.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=g;ctx.beginPath();ctx.ellipse(c.x,c.y,26,12,0,0,Math.PI*2);ctx.fill();
    const along=facing==='+x'||facing==='-x',dx=along?0.05:0.26,dy=along?0.26:0.05,front=facing==='+x'||facing==='+y';
    zbox(x-0.03,y-0.03,x+0.03,y+0.03,z,z+3,C.monitor,C.monitor,C.monitor);
    zbox(x-dx,y-dy,x+dx,y+dy,z+3,z+13,C.monitor,C.monitor,front?color:C.monitor,'rgba(0,0,0,.35)');
    zbox(x-dx,y-dy,x+dx,y+dy,z+13,z+13.8,color,color,color);
  }
  const CHAIR={pink:['#c5ac83','#89765e','#71634f'],blue:['#849692','#667571','#53635f']};
  function chair(x,y,facing,[top,left,right]){
    zbox(x-0.15,y-0.15,x+0.15,y+0.15,0,6,top,left,right,'rgba(0,0,0,.2)');
    if(facing==='+x')zbox(x-0.16,y-0.15,x-0.09,y+0.15,4,15,top,left,right,'rgba(0,0,0,.2)');
    else if(facing==='-x')zbox(x+0.09,y-0.15,x+0.16,y+0.15,4,15,top,left,right,'rgba(0,0,0,.2)');
    else if(facing==='+y')zbox(x-0.15,y-0.16,x+0.15,y-0.09,4,15,top,left,right,'rgba(0,0,0,.2)');
    else zbox(x-0.15,y+0.09,x+0.15,y+0.16,4,15,top,left,right,'rgba(0,0,0,.2)');
  }
  function plant(x,y){
    box(x-0.18,y-0.18,x+0.18,y+0.18,10,C.pot,'#5f3a20','#4a2c18');
    const p=project(x,y,10);circle(p.x-5,p.y-6,6,C.plantDeep);circle(p.x+5,p.y-7,6.5,C.plant);circle(p.x,p.y-13,6,C.plant);circle(p.x+1,p.y-4,4.5,C.plantDeep);
  }
  function moneyBag(x,y){
    const p=project(x,y);
    ctx.fillStyle='rgba(45,43,30,.2)';ctx.beginPath();ctx.ellipse(p.x,p.y+1,14,6,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#b49455';ctx.beginPath();ctx.ellipse(p.x,p.y-12,12,15,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#d6bc79';ctx.beginPath();ctx.ellipse(p.x-3,p.y-14,7,12,-.2,0,Math.PI*2);ctx.fill();
    poly([{x:p.x-5,y:p.y-23},{x:p.x-7,y:p.y-31},{x:p.x+6,y:p.y-30},{x:p.x+4,y:p.y-23}],'#cfb272','#8d7240');
    round(p.x-6,p.y-24,12,3,1,'#78613b');
    text('$',p.x,p.y-7,'800 16px '+MONO,'#68502d','center');
  }
  function moneyShower(p,a,now,reduced){
    const angle=reduced?a.phase:now/500+a.phase;
    const hand={x:p.x+Math.cos(angle)*9,y:p.y-18+Math.sin(angle)*4};
    circle(hand.x,hand.y,2.4,a.look.skin);
    ctx.save();const c=Math.cos(angle),s=Math.sin(angle);
    ctx.transform(c,s,-s,c,hand.x,hand.y);
    // A chunky gold cash cannon, with a visible stack of banknotes on top.
    round(-3,-4,15,7,2,'#d8b35d','#766039');rect(0,2,4,6,'#766039');
    rect(9,-3,4,5,'#454f45');rect(-1,-7,8,3,'#b4d79e');rect(0,-6,6,.7,'#557d53');
    ctx.restore();
    // Fixed-count, time-derived notes cannot accumulate or survive a mode change.
    for(let i=0;i<10;i++){
      const age=reduced?(i+.5)/10:((now/1250+i/10+a.phase)%1),heading=angle-age*2.5;
      const radius=14+age*40,x=p.x+Math.cos(heading)*radius,y=p.y-20+Math.sin(heading)*radius*.55+age*age*15;
      ctx.save();const tilt=heading+Math.sin(age*9)*.5,c=Math.cos(tilt),s=Math.sin(tilt);
      ctx.transform(c,s,-s,c,x,y);ctx.globalAlpha=1-age*.7;
      round(-5,-2.5,10,5,1,'#b9d99a','#56764e',.7);rect(-3,-1.3,6,2.6,'#86b573');circle(0,0,1.2,'#dceac3');ctx.restore();
    }
  }
  function cigar(p,headY,facing,now,phase,reduced){
    const dir=facing==='+x'?1:-1,x=p.x+dir*5,y=headY+3;
    round(dir>0?x:x-10,y,10,3,1,'#805238','#4e3527',.6);
    rect(x+dir*9-(dir<0?1:0),y,2,3,'#e99d52');
    for(let i=0;i<4;i++){
      const age=reduced?(i+1)/5:(now/2200+i/4+phase)%1;
      const sx=x+dir*11+Math.sin(age*7+phase)*4,sy=y-3-age*24;
      ctx.strokeStyle='rgba(232,231,217,'+(.5*(1-age))+')';ctx.lineWidth=1.8;
      ctx.beginPath();ctx.arc(sx,sy,2+age*3,.2,Math.PI*1.7);ctx.stroke();
    }
  }
  function person(a,now,world,pose=null){
    const p=project(pose?.x??a.pos.x,pose?.y??a.pos.y,pose?.z??0),seated=pose?pose.mode==='lounge':a.state==='seated',walking=!pose&&a.state==='walking',lift=seated?4:0;
    const facing=pose?.facing??a.facing;
    const working=seated&&a.kind==='trader'&&world.inTrade[a.desk];
    const bob=world.reduced||pose?0:working?Math.sin(now/110+a.phase)*.7:walking?Math.abs(Math.sin(a.step))*1.2:0;
    ctx.fillStyle='rgba(35,37,32,.22)';ctx.beginPath();ctx.ellipse(p.x,p.y,7,3.2,0,0,Math.PI*2);ctx.fill();
    ctx.save();
    if(pose?.lean){const c=Math.cos(pose.lean),s=Math.sin(pose.lean),y=p.y-7;ctx.transform(c,s,-s,c,p.x-c*p.x+s*y,y-s*p.x-c*y);}
    if(!seated){const sw=walking?Math.sin(a.step)*2.4:0;rect(p.x-4.6,p.y-9+Math.max(0,sw),3.6,9-Math.max(0,sw),'#3b4142');rect(p.x+1,p.y-9+Math.max(0,-sw),3.6,9-Math.max(0,-sw),'#3b4142');}
    const bodyY=p.y+lift-20-bob,headY=p.y+lift-26-bob;
    round(p.x-6.5,bodyY,13,12,4,a.look.shirt);
    // Shirt collars, jacket seams and ID badges make each little trader distinct.
    poly([{x:p.x-3,y:bodyY},{x:p.x,y:bodyY+4},{x:p.x+3,y:bodyY}], '#eee8da');
    if(a.look.style===1){rect(p.x-.4,bodyY+4,.8,7,'rgba(35,43,39,.4)');rect(p.x+3,bodyY+5,2,3,'#dedacb');}
    if(a.look.tie)rect(p.x-1,bodyY+1,2,7,a.look.tie);
    if(seated){const dir=facing==='+x'||facing==='-y'?1:-1;rect(p.x+dir*2,bodyY+7,4,2.4,a.look.skin);}
    if(pose?.mode==='lounge'){
      // Elbow behind the head, feet stretched out: clearly off duty.
      round(p.x-9,bodyY-5,3,12,1.5,a.look.shirt);rect(p.x-8,bodyY-6,6,2.5,a.look.skin);
      const dir=facing==='+x'?1:-1;round(p.x+(dir>0?0:-12),bodyY+10,12,4,2,'#3b4142');
    }
    circle(p.x,headY,6,a.look.skin);
    ctx.fillStyle=a.look.hair;ctx.beginPath();ctx.arc(p.x,headY-.6,6.2,Math.PI,0);ctx.fill();
    if(a.look.style===2)round(p.x-4,headY-7,8,3,2,a.look.hair);
    const toward=facing==='+x'||facing==='+y';
    if(toward){const dir=facing==='+x'?1:-1;rect(p.x-dir*6.2-(dir<0?0:0),headY-1,1.6,4,a.look.hair);
      circle(p.x+dir*1.6,headY+.4,.95,'#292c29');circle(p.x+dir*3.9,headY+.4,.95,'#292c29');
      if(a.look.beard){ctx.strokeStyle=a.look.hair;ctx.lineWidth=2;ctx.beginPath();ctx.arc(p.x+dir,headY+1,3.6,.15,Math.PI-.15);ctx.stroke();}
      if(a.look.glasses){ctx.strokeStyle='rgba(32,37,35,.8)';ctx.lineWidth=.8;ctx.strokeRect(p.x+dir*.4-1.2*(dir<0?1:0),headY-.9,2.4,2.4);ctx.strokeRect(p.x+dir*2.9-1.2*(dir<0?1:0),headY-.9,2.4,2.4);}
    }else rect(p.x-6.2,headY-2,12.4,3,a.look.hair);
    if(a.look.headset){ctx.strokeStyle='#394440';ctx.lineWidth=1.6;ctx.beginPath();ctx.arc(p.x,headY,6.7,Math.PI,0);ctx.stroke();round(p.x-7,headY-1,2.8,4,1,'#394440');}
    if(pose?.mode==='lounge')cigar(p,headY,facing,now,a.phase,world.reduced);
    ctx.restore();
    if(pose?.mode==='money')moneyShower(p,a,now,world.reduced);
  }
  function plate(x,y,z,lines,border,width){
    const p=project(x,y,z),h=lines.length>1?31:17,w=width;
    ctx.shadowColor='rgba(0,0,0,.45)';ctx.shadowBlur=8;
    round(p.x-w/2,p.y-h/2,w,h,5,C.plate,border,1.2);ctx.shadowBlur=0;
    text(lines[0].text,p.x,p.y+(lines.length>1?-4:3.5),lines[0].font,lines[0].color,'center');
    if(lines[1])text(lines[1].text,p.x,p.y+9,lines[1].font,lines[1].color,'center');
    ctx.fillStyle=border;ctx.beginPath();ctx.moveTo(p.x-4,p.y+h/2);ctx.lineTo(p.x+4,p.y+h/2);ctx.lineTo(p.x,p.y+h/2+5);ctx.closePath();ctx.fill();
  }
  function items(view,agents,now,world){
    const list=[];const add=(depth,draw)=>list.push({depth,draw});
    for(const r of ROOM_GEOMETRY){
      if(r.y0>0)add(r.y0-0.02,()=>wallY(r.y0,0,4.5,120,C.glass,C.glassLine));
      add(4.5+r.y1,()=>{wallX(4.5,r.y0,r.door.y0,120,C.glass,C.glassLine);poly([project(4.5,r.door.y0,120),project(4.5,r.door.y1,120),project(4.5,r.door.y1,112),project(4.5,r.door.y0,112)],C.glassLine);});
      add(4.5+r.y1+0.01,()=>wallY(r.y1,0,4.5,120,C.glass,C.glassLine));
      add(r.desk.x1+r.desk.y1,()=>{box(r.desk.x0,r.desk.y0,r.desk.x1,r.desk.y1,22,C.deskTop,C.deskLeft,C.deskRight,C.deskLine);
        monitor(1.05,r.y0+2,'-x',22,C.screenIdle,'rgba(142,215,204,.25)');zbox(1.85,r.y0+1.2,2.1,r.y0+1.5,22,25,'#f0dec0','#d2c1a3','#b9a789');});
      add(r.seat.x+r.seat.y-0.01,()=>chair(r.seat.x,r.seat.y,'+x',CHAIR.blue));
      add(r.plant.x+r.plant.y,()=>plant(r.plant.x,r.plant.y));
    }
    for(const d of DESK_GEOMETRY){
      const v=view.desks[d.symbol],glow=v.status==='trade'?(v.pnl===null?'rgba(95,240,255,.45)':v.pnl>=0?'rgba(61,220,132,.45)':'rgba(255,51,85,.45)'):'rgba(84,114,111,.18)';
      const screen=v.status==='trade'?(v.pnl===null?C.cyan:v.pnl>=0?C.pos:C.neg):C.screenIdle;
      // One long bench. Its depth sits between the far seats (behind it) and the near seats (in front).
      add(d.x1+d.y0+1,()=>{
        box(d.x0,d.y0,d.x1,d.y1,24,C.deskTop,C.deskLeft,C.deskRight,C.deskLine);
        for(const ys of [d.y0+1.35,d.y0+3.35]){monitor(d.x0+0.22,ys,'-x',24,screen,glow);monitor(d.x1-0.22,ys,'+x',24,screen,glow);}
        for(const ys of [d.y0+0.5,d.y0+2.5])zbox(d.x0+0.55,ys,d.x0+0.95,ys+0.3,24,25.5,'#f1eee5','#c5beaf','#aaa595');
        for(const ys of [d.y0+1.1,d.y0+3.1]){
          zbox(d.x0+.05,ys-.35,d.x0+.32,ys+.15,24,25,'#687771','#52605c','#485550');
          zbox(d.x1-.32,ys-.35,d.x1-.05,ys+.15,24,25,'#687771','#52605c','#485550');
          const mug=project(d.x0+.75,ys+.55,27);
          round(mug.x-2.5,mug.y-2,5,5,1.5,'#f7f0dd');circle(mug.x,mug.y-1.5,1.6,'#79614a');
          ctx.strokeStyle='#f7f0dd';ctx.lineWidth=1;ctx.strokeRect(mug.x+2,mug.y,2,2);
        }
      });
      for(const s of d.seats)add(s.x+s.y+(s.facing==='+x'?-0.01:0.01),()=>chair(s.x,s.y,s.facing,s.facing==='+x'?CHAIR.pink:CHAIR.blue));
      if(world.celebrations[d.symbol]==='lounge')for(const x of [d.x0-.4,d.x1+.4])for(const y of [d.y0+.15,d.y1-.15])add(x+y,()=>moneyBag(x,y));
    }
    add(FIKA.table.x+FIKA.table.y,()=>{
      const b=project(FIKA.table.x,FIKA.table.y),t=project(FIKA.table.x,FIKA.table.y,20);
      ctx.fillStyle=C.woodDeep;ctx.beginPath();ctx.ellipse(b.x,b.y-10,18,9,0,0,Math.PI*2);ctx.fill();rect(b.x-18,b.y-10,36,10,C.woodDeep);
      ctx.fillStyle=C.wood;ctx.beginPath();ctx.ellipse(t.x,t.y,18,9,0,0,Math.PI*2);ctx.fill();
      circle(t.x-6,t.y-1,2.2,'#fff');circle(t.x+5,t.y+2,2.2,'#fff');circle(t.x+1,t.y-4,2.2,'#f0dec0');
    });
    for(const s of SPOTS.fika)add(s.x+s.y-0.01,()=>box(s.x-0.16,s.y-0.16,s.x+0.16,s.y+0.16,8,'#b4a180','#96896e','#80755d'));
    // Seat cushion behind the people sitting on it, backrest in front of them.
    add(FIKA.sofa.x0+FIKA.sofa.y0,()=>box(FIKA.sofa.x0,FIKA.sofa.y0,FIKA.sofa.x1,FIKA.sofa.y1,13,'#9b9f92','#7f8678','#697364','rgba(0,0,0,.2)'));
    add(FIKA.sofa.x1+FIKA.sofa.y1,()=>box(FIKA.sofa.x0,FIKA.sofa.y1-0.18,FIKA.sofa.x1,FIKA.sofa.y1,24,'#9b9f92','#7f8678','#697364','rgba(0,0,0,.2)'));
    add(FIKA.coffee.x+0.2+FIKA.coffee.y+0.2,()=>{box(FIKA.coffee.x-0.2,FIKA.coffee.y-0.2,FIKA.coffee.x+0.2,FIKA.coffee.y+0.2,30,'#58625f','#414b49','#303b39','rgba(0,0,0,.3)');const p=project(FIKA.coffee.x+0.2,FIKA.coffee.y,22);circle(p.x-3,p.y,1.6,Math.floor(now/600)%2?'#ed8575':'#d4be95');});
    add(FIKA.cooler.x+0.15+FIKA.cooler.y+0.15,()=>{box(FIKA.cooler.x-0.15,FIKA.cooler.y-0.15,FIKA.cooler.x+0.15,FIKA.cooler.y+0.15,26,'#e9f4ff','#9bd7ff','#7fc4f5','rgba(0,0,0,.25)');const p=project(FIKA.cooler.x,FIKA.cooler.y,26);circle(p.x,p.y-6,6,'rgba(150,215,255,.85)');});
    for(const p of PLANTS)add(p.x+p.y,()=>plant(p.x,p.y));
    for(const a of agents){
      const pose=celebrationPose(a,world.celebrations[a.desk],now,world.reduced);
      const desk=pose&&DESK_GEOMETRY.find(d=>d.symbol===a.desk);
      const depth=pose?Math.max(pose.x+pose.y,pose.mode==='money'?desk.x1+desk.y0+1.01:0):a.pos.x+a.pos.y;
      add(depth,()=>person(a,now,world,pose));
    }
    return list.sort((a,b)=>a.depth-b.depth);
  }
  function overlay(view,now){
    if(hover){
      const r=regions.find(r=>r.kind===hover.kind&&r.id===hover.id);
      if(r&&r.kind!=='screen'){ctx.save();ctx.shadowColor='rgba(95,240,255,.9)';ctx.shadowBlur=14;poly(r.poly,'rgba(95,240,255,.08)','rgba(95,240,255,.85)',1.6);ctx.restore();}
    }
    for(const r of ROOM_GEOMETRY)plate(2.2,r.y0+2,150,[{text:(r.name+' · '+r.role).toUpperCase(),font:'800 8px '+SANS,color:C.text}],C.pink,r.role.length>8?118:96);
    for(const d of DESK_GEOMETRY){
      const v=view.desks[d.symbol],border=v.status==='trade'?(v.pnl===null?C.cyan:v.pnl>=0?C.pos:C.neg):v.status==='paused'?C.dim:v.status==='cooldown'?C.amber:'#bcc2b2';
      const line=v.status==='trade'?(v.pnl===null?'väntar på pris':(v.pnl>=0?'+':'')+v.pnl.toFixed(2)+' $'):v.status==='paused'?'pausad':v.status==='cooldown'?'karens':'väntar signal';
      plate(d.x0+0.75,d.y0+2,84,[{text:d.symbol,font:'800 11px '+SANS,color:C.text},{text:line,font:'700 8px '+MONO,color:border}],border,74);
    }
    plate(FIKA.table.x,FIKA.table.y,64,[{text:'FIKA',font:'800 8px '+SANS,color:C.text}],'#b4a180',52);
    plate(FIKA.cooler.x,FIKA.cooler.y,56,[{text:'VATTEN',font:'800 7px '+SANS,color:C.text}],'#7fc4f5',52);
    particles=view.reduced?[]:particles.filter(p=>p.life>0);
    for(const p of particles){p.y+=p.vy;p.x+=p.vx;p.life-=0.02;text(p.text,p.x,p.y,'800 11px '+MONO,p.color.replace('1)',Math.max(0,p.life)+')'));}
  }
  function draw(view,agents,now){
    resize();ctx.setTransform(dpr,0,0,dpr,0,0);
    backdrop();
    const c=camera.state();ctx.setTransform(dpr*c.zoom,0,0,dpr*c.zoom,dpr*c.x,dpr*c.y);
    const world={inTrade:Object.fromEntries(FLOOR.desks.map(s=>[s,view.desks[s]?.status==='trade'])),reduced:view.reduced,
      celebrations:Object.fromEntries(FLOOR.desks.map(s=>[s,deskCelebration(view.desks[s],now)]))};
    background();drawEquityScreen(view,now);drawNewsScreen(view,now);
    for(const it of items(view,agents,now,world))it.draw();
    overlay(view,now);
  }
  // Pointer positions are CSS pixels inside the canvas; hits are tested in world space.
  function pointer(clientX,clientY){const r=canvas.getBoundingClientRect();return {x:clientX-r.left,y:clientY-r.top};}
  function hitTest(px,py){const w=camera.toWorld(px,py);return hitAt(w.x,w.y,regions);}
  function zoomAt(px,py,factor){resize();interacted=true;camera.zoomAt(px,py,factor);}
  function panBy(dx,dy){resize();interacted=true;camera.panBy(dx,dy);}
  function resetView(){resize();interacted=false;camera.fit(width,height);}
  const viewport=()=>({width,height,zoom:camera.state().zoom});
  function burst(symbol,positive){
    const d=DESK_GEOMETRY.find(d=>d.symbol===symbol);if(!d)return;
    const p=project(d.x0+0.75,d.y0+2,40);
    for(let i=0;i<10;i++)particles.push({x:p.x+(Math.random()-.5)*40,y:p.y-Math.random()*10,vx:(Math.random()-.5)*.6,vy:-(.6+Math.random()*.9),life:1+Math.random()*.4,text:positive?'$':'·',color:positive?'rgba(61,220,132,1)':'rgba(255,51,85,1)'});
  }
  return {resize,draw,pointer,hitTest,zoomAt,panBy,resetView,viewport,burst,setHover:h=>{hover=h;},getHover:()=>hover};
}
