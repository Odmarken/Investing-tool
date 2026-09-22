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
const HAIR=['#2a1b14','#4b2e1b','#c98a3c','#151515','#a83e2a','#efe1bd','#6f3fa0'];
const SHIRT=['#ff5fa2','#6ea8ff','#3ddc84','#ffb020','#b388ff','#ff8a5c','#5ff0ff','#f4f0ff','#ff3355','#9fe870','#ffd166','#8ecae6'];
const look=k=>({skin:SKIN[k%SKIN.length],hair:HAIR[(k*7+3)%HAIR.length],shirt:SHIRT[(k*5+1)%SHIRT.length],glasses:k%5===2});
const STAFF_LOOK={elias:{skin:'#f3cfae',hair:'#3a2618',shirt:'#2d2b5a',tie:'#ff5fa2'},pablo:{skin:'#e3b08a',hair:'#1c1c1c',shirt:'#f6f2ff',tie:'#5ff0ff'},
  manuel:{skin:'#c98d5a',hair:'#2a1b14',shirt:'#ff3355'},miguel:{skin:'#d9a97f',hair:'#5a3a22',shirt:'#ffb020',glasses:true}};
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

const C={bgTop:'#1a1240',bgBottom:'#2f1c6b',floorA:'#c7b2f2',floorB:'#bfa8ee',roomA:'#dcc7fc',roomB:'#d4bff8',fikaA:'#e8cbee',fikaB:'#e1c2e9',tileLine:'rgba(60,30,120,.22)',
  wall:'#5a3fb8',wallDeep:'#43289a',wallLine:'rgba(220,200,255,.5)',glass:'rgba(255,140,220,.17)',glassLine:'rgba(255,170,230,.8)',
  deskTop:'#f6f0ff',deskLeft:'#cfbcf4',deskRight:'#bda7eb',deskLine:'rgba(80,50,140,.35)',monitor:'#1e1640',screenIdle:'#544a92',
  chairA:'#ff5fa2',chairB:'#6ea8ff',plate:'rgba(18,10,48,.92)',pink:'#ff5fa2',cyan:'#5ff0ff',pos:'#3ddc84',neg:'#ff3355',amber:'#ffb020',
  text:'#ffffff',muted:'#c9b8f0',dim:'#8f7fc4',panel:'#120b2e',plant:'#3ddc84',plantDeep:'#22a45e',pot:'#7a4b2a',wood:'#d9b27a',woodDeep:'#a97f4c'};
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

export function createScene(canvas){
  const ctx=canvas.getContext?.('2d');if(!ctx)return null;
  let dpr=0,hover=null,particles=[];const regions=REGIONS(),truncated=new Map();
  function resize(){const next=Math.min(2,globalThis.devicePixelRatio||1);if(next===dpr)return;dpr=next;canvas.width=Math.round(CANVAS.w*dpr);canvas.height=Math.round(CANVAS.h*dpr);}
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
  function background(){
    const g=ctx.createLinearGradient(0,0,0,CANVAS.h);g.addColorStop(0,C.bgTop);g.addColorStop(1,C.bgBottom);
    rect(0,0,CANVAS.w,CANVAS.h,g);
    const glow=ctx.createRadialGradient(660,420,40,660,420,760);glow.addColorStop(0,'rgba(140,90,255,.22)');glow.addColorStop(1,'rgba(140,90,255,0)');
    rect(0,0,CANVAS.w,CANVAS.h,glow);
    for(let y=0;y<GRID.h;y++)for(let x=0;x<GRID.w;x++){
      const z=zone(x,y),odd=(x+y)%2,fill=z==='room'?(odd?C.roomA:C.roomB):z==='fika'?(odd?C.fikaA:C.fikaB):(odd?C.floorA:C.floorB);
      poly([project(x,y),project(x+1,y),project(x+1,y+1),project(x,y+1)],fill,C.tileLine,.6);
    }
    // Far walls with the two wall-mounted screens.
    const gl=ctx.createLinearGradient(0,project(0,0,WALL_H).y,0,project(0,GRID.h).y);gl.addColorStop(0,C.wall);gl.addColorStop(1,C.wallDeep);
    wallX(0,0,GRID.h,WALL_H,gl,C.wallLine);
    const gr=ctx.createLinearGradient(0,project(0,0,WALL_H).y,0,project(GRID.w,0).y);gr.addColorStop(0,C.wall);gr.addColorStop(1,C.wallDeep);
    wallY(0,0,GRID.w,WALL_H,gr,C.wallLine);
    poly([project(0,0,WALL_H),project(GRID.w,0,WALL_H),project(GRID.w,0,WALL_H-6),project(0,0,WALL_H-6)],'rgba(255,255,255,.18)');
    poly([project(0,0,WALL_H),project(0,GRID.h,WALL_H),project(0,GRID.h,WALL_H-6),project(0,0,WALL_H-6)],'rgba(255,255,255,.12)');
    // Firm name on the left wall as a billboard.
    const lp=project(0,9,118);
    text('RIPTIDE',lp.x-4,lp.y,'800 13px '+SANS,'rgba(255,255,255,.28)','center');
    text('INVESTMENTS · TRADING FLOOR',lp.x-4,lp.y+13,'700 7.5px '+SANS,'rgba(255,255,255,.22)','center');
  }
  function screenFrame(s,now,hot){
    const p=project(s.x0,0,s.top),w=(s.x1-s.x0)*TILE.w/2,h=s.top-s.bottom;
    ctx.save();ctx.transform(1,TILE.h/TILE.w,0,1,p.x,p.y);
    ctx.shadowColor=hot?'rgba(95,240,255,.8)':'rgba(255,95,162,.55)';ctx.shadowBlur=hot?26:16;
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
    ctx.setLineDash([3,3]);ctx.strokeStyle='rgba(201,184,240,.35)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x0,yOf(view.start));ctx.lineTo(x1,yOf(view.start));ctx.stroke();ctx.setLineDash([]);
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
        text(fit(n.title,'600 7.5px '+SANS,w-52),38,y,'600 7.5px '+SANS,n.hot?'#ffd6ea':C.text);
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
  const CHAIR={pink:['#ff5fa2','#d94a88','#b83c72'],blue:['#6ea8ff','#5a8ee0','#4a78c2']};
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
  function person(a,now,world){
    const p=project(a.pos.x,a.pos.y),seated=a.state==='seated',walking=a.state==='walking',lift=seated?4:0;
    const working=seated&&a.kind==='trader'&&world.inTrade[a.desk];
    const bob=working?Math.sin(now/110+a.phase)*.7:walking?Math.abs(Math.sin(a.step))*1.2:0;
    ctx.fillStyle='rgba(20,10,50,.3)';ctx.beginPath();ctx.ellipse(p.x,p.y,7,3.2,0,0,Math.PI*2);ctx.fill();
    if(!seated){const sw=walking?Math.sin(a.step)*2.4:0;rect(p.x-4.6,p.y-9+Math.max(0,sw),3.6,9-Math.max(0,sw),'#2b2350');rect(p.x+1,p.y-9+Math.max(0,-sw),3.6,9-Math.max(0,-sw),'#2b2350');}
    const bodyY=p.y+lift-20-bob,headY=p.y+lift-26-bob;
    round(p.x-6.5,bodyY,13,12,4,a.look.shirt);
    if(a.look.tie)rect(p.x-1,bodyY+1,2,7,a.look.tie);
    if(seated){const dir=a.facing==='+x'||a.facing==='-y'?1:-1;rect(p.x+dir*2,bodyY+7,4,2.4,a.look.skin);}
    circle(p.x,headY,6,a.look.skin);
    ctx.fillStyle=a.look.hair;ctx.beginPath();ctx.arc(p.x,headY-.6,6.2,Math.PI,0);ctx.fill();
    const toward=a.facing==='+x'||a.facing==='+y';
    if(toward){const dir=a.facing==='+x'?1:-1;rect(p.x-dir*6.2-(dir<0?0:0),headY-1,1.6,4,a.look.hair);
      circle(p.x+dir*1.6,headY+.4,.95,'#1b1230');circle(p.x+dir*3.9,headY+.4,.95,'#1b1230');
      if(a.look.glasses){ctx.strokeStyle='rgba(20,15,40,.8)';ctx.lineWidth=.8;ctx.strokeRect(p.x+dir*.4-1.2*(dir<0?1:0),headY-.9,2.4,2.4);ctx.strokeRect(p.x+dir*2.9-1.2*(dir<0?1:0),headY-.9,2.4,2.4);}
    }else rect(p.x-6.2,headY-2,12.4,3,a.look.hair);
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
        monitor(1.05,r.y0+2,'-x',22,C.screenIdle,'rgba(95,240,255,.35)');zbox(1.85,r.y0+1.2,2.1,r.y0+1.5,22,25,'#ffd6ea','#e6b8d2','#d0a4be');});
      add(r.seat.x+r.seat.y-0.01,()=>chair(r.seat.x,r.seat.y,'+x',CHAIR.blue));
      add(r.plant.x+r.plant.y,()=>plant(r.plant.x,r.plant.y));
    }
    for(const d of DESK_GEOMETRY){
      const v=view.desks[d.symbol],glow=v.status==='trade'?(v.pnl===null?'rgba(95,240,255,.45)':v.pnl>=0?'rgba(61,220,132,.45)':'rgba(255,51,85,.45)'):'rgba(120,100,200,.18)';
      const screen=v.status==='trade'?(v.pnl===null?C.cyan:v.pnl>=0?C.pos:C.neg):C.screenIdle;
      // One long bench. Its depth sits between the far seats (behind it) and the near seats (in front).
      add(d.x1+d.y0+1,()=>{
        box(d.x0,d.y0,d.x1,d.y1,24,C.deskTop,C.deskLeft,C.deskRight,C.deskLine);
        for(const ys of [d.y0+1.35,d.y0+3.35]){monitor(d.x0+0.22,ys,'-x',24,screen,glow);monitor(d.x1-0.22,ys,'+x',24,screen,glow);}
        for(const ys of [d.y0+0.5,d.y0+2.5])zbox(d.x0+0.55,ys,d.x0+0.95,ys+0.3,24,25.5,'#e9e0ff','#cbbaf0','#b8a5e6');
      });
      for(const s of d.seats)add(s.x+s.y+(s.facing==='+x'?-0.01:0.01),()=>chair(s.x,s.y,s.facing,s.facing==='+x'?CHAIR.pink:CHAIR.blue));
    }
    add(FIKA.table.x+FIKA.table.y,()=>{
      const b=project(FIKA.table.x,FIKA.table.y),t=project(FIKA.table.x,FIKA.table.y,20);
      ctx.fillStyle=C.woodDeep;ctx.beginPath();ctx.ellipse(b.x,b.y-10,18,9,0,0,Math.PI*2);ctx.fill();rect(b.x-18,b.y-10,36,10,C.woodDeep);
      ctx.fillStyle=C.wood;ctx.beginPath();ctx.ellipse(t.x,t.y,18,9,0,0,Math.PI*2);ctx.fill();
      circle(t.x-6,t.y-1,2.2,'#fff');circle(t.x+5,t.y+2,2.2,'#fff');circle(t.x+1,t.y-4,2.2,'#ffd6ea');
    });
    for(const s of SPOTS.fika)add(s.x+s.y-0.01,()=>box(s.x-0.16,s.y-0.16,s.x+0.16,s.y+0.16,8,'#b57edc','#8f5fb8','#7b4fa3'));
    // Seat cushion behind the people sitting on it, backrest in front of them.
    add(FIKA.sofa.x0+FIKA.sofa.y0,()=>box(FIKA.sofa.x0,FIKA.sofa.y0,FIKA.sofa.x1,FIKA.sofa.y1,13,'#ff8fc0','#e46aa0','#cc5a8e','rgba(0,0,0,.2)'));
    add(FIKA.sofa.x1+FIKA.sofa.y1,()=>box(FIKA.sofa.x0,FIKA.sofa.y1-0.18,FIKA.sofa.x1,FIKA.sofa.y1,24,'#ff8fc0','#e46aa0','#cc5a8e','rgba(0,0,0,.2)'));
    add(FIKA.coffee.x+0.2+FIKA.coffee.y+0.2,()=>{box(FIKA.coffee.x-0.2,FIKA.coffee.y-0.2,FIKA.coffee.x+0.2,FIKA.coffee.y+0.2,30,'#3a3070','#2a2250','#221b45','rgba(0,0,0,.3)');const p=project(FIKA.coffee.x+0.2,FIKA.coffee.y,22);circle(p.x-3,p.y,1.6,Math.floor(now/600)%2?'#ff3355':'#ff8fa8');});
    add(FIKA.cooler.x+0.15+FIKA.cooler.y+0.15,()=>{box(FIKA.cooler.x-0.15,FIKA.cooler.y-0.15,FIKA.cooler.x+0.15,FIKA.cooler.y+0.15,26,'#e9f4ff','#9bd7ff','#7fc4f5','rgba(0,0,0,.25)');const p=project(FIKA.cooler.x,FIKA.cooler.y,26);circle(p.x,p.y-6,6,'rgba(150,215,255,.85)');});
    for(const p of PLANTS)add(p.x+p.y,()=>plant(p.x,p.y));
    for(const a of agents)add(a.pos.x+a.pos.y,()=>person(a,now,world));
    return list.sort((a,b)=>a.depth-b.depth);
  }
  function overlay(view,now){
    if(hover){
      const r=regions.find(r=>r.kind===hover.kind&&r.id===hover.id);
      if(r&&r.kind!=='screen'){ctx.save();ctx.shadowColor='rgba(95,240,255,.9)';ctx.shadowBlur=14;poly(r.poly,'rgba(95,240,255,.08)','rgba(95,240,255,.85)',1.6);ctx.restore();}
    }
    for(const r of ROOM_GEOMETRY)plate(2.2,r.y0+2,150,[{text:(r.name+' · '+r.role).toUpperCase(),font:'800 8px '+SANS,color:C.text}],C.pink,r.role.length>8?118:96);
    for(const d of DESK_GEOMETRY){
      const v=view.desks[d.symbol],border=v.status==='trade'?(v.pnl===null?C.cyan:v.pnl>=0?C.pos:C.neg):v.status==='paused'?C.dim:v.status==='cooldown'?C.amber:'#b28cff';
      const line=v.status==='trade'?(v.pnl===null?'väntar på pris':(v.pnl>=0?'+':'')+v.pnl.toFixed(2)+' $'):v.status==='paused'?'pausad':v.status==='cooldown'?'karens':'väntar signal';
      plate(d.x0+0.75,d.y0+2,84,[{text:d.symbol,font:'800 11px '+SANS,color:C.text},{text:line,font:'700 8px '+MONO,color:border}],border,74);
    }
    plate(FIKA.table.x,FIKA.table.y,64,[{text:'FIKA',font:'800 8px '+SANS,color:C.text}],'#b57edc',52);
    plate(FIKA.cooler.x,FIKA.cooler.y,56,[{text:'VATTEN',font:'800 7px '+SANS,color:C.text}],'#7fc4f5',52);
    particles=particles.filter(p=>p.life>0);
    for(const p of particles){p.y+=p.vy;p.x+=p.vx;p.life-=0.02;text(p.text,p.x,p.y,'800 11px '+MONO,p.color.replace('1)',Math.max(0,p.life)+')'));}
  }
  function draw(view,agents,now){
    resize();ctx.setTransform(dpr,0,0,dpr,0,0);
    const world={inTrade:Object.fromEntries(FLOOR.desks.map(s=>[s,view.desks[s]?.status==='trade'])),reduced:view.reduced};
    background();drawEquityScreen(view,now);drawNewsScreen(view,now);
    for(const it of items(view,agents,now,world))it.draw();
    overlay(view,now);
  }
  function toLogical(clientX,clientY){const r=canvas.getBoundingClientRect();return {x:(clientX-r.left)/r.width*CANVAS.w,y:(clientY-r.top)/r.height*CANVAS.h};}
  function burst(symbol,positive){
    const d=DESK_GEOMETRY.find(d=>d.symbol===symbol);if(!d)return;
    const p=project(d.x0+0.75,d.y0+2,40);
    for(let i=0;i<10;i++)particles.push({x:p.x+(Math.random()-.5)*40,y:p.y-Math.random()*10,vx:(Math.random()-.5)*.6,vy:-(.6+Math.random()*.9),life:1+Math.random()*.4,text:positive?'$':'·',color:positive?'rgba(61,220,132,1)':'rgba(255,51,85,1)'});
  }
  return {resize,draw,toLogical,burst,hitTest:(x,y)=>hitAt(x,y,regions),setHover:h=>{hover=h;},getHover:()=>hover};
}
