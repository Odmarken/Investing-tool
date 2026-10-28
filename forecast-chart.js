// Canvas candlestick chart for AI Forecast. Real candles, the gray forecast
// scenario, its uncertainty band, signals and demo-trade levels share ONE time
// axis (every candle slot is barPx wide and x follows time) and ONE price
// scale, so the forecast continues exactly where the data ends. The pure
// helpers are exported for tests; createForecastChart needs only a 2D context,
// so it also runs in Node with a fake context and no DOM. Nothing here fetches
// data, trades or changes the records it draws.
//
// The optional tooltip element should be absolutely positioned in the same
// offset parent as the canvas: the chart only sets its textContent, hidden,
// left/top and a data-state while it explains a level drag. The canvas size
// comes from CSS (clientWidth/clientHeight).
import {TF} from './forecast-config.js';

export const CHART_COLORS=Object.freeze({surface:'#0b0f14',grid:'rgba(148,163,184,.08)',axisText:'#8b9bb0',text:'#e6edf3',
  up:'#14a7a0',down:'#e2483c',fcFill:'rgba(170,179,192,.6)',fcOutline:'rgba(186,195,208,.70)',
  band80:'rgba(156,166,180,.10)',band50:'rgba(156,166,180,.17)',median:'rgba(205,212,222,.75)',region:'rgba(120,130,145,.06)',
  entry:'#9fb0c0',sl:'#e2483c',tp:'#14a7a0',liq:'#f0a020',crosshair:'rgba(220,228,238,.45)',claude:'#b48cff'});
// up/down/sl/tp were validated with the dataviz CVD validator on the dark surface (deutan ΔE 13.4).
// A forecast candle is one translucent gray, body and wick, like a real candle's one colour: a brighter edge of its
// own made the bodies read as light rims around a darker middle.
const C=CHART_COLORS,MINUTE=60000,HOUR=3600000,DAY=86400000;
const LABEL='Forecast — estimated scenario',CLAUDE_LABEL='Pablo — gissning',CLAUDE_BUSY='Pablo ritar…';
// A no-break space, and a ' · ' separator that a wrapped line may break before but never after.
const NB='\xa0',DOT=' ·'+NB;
// A signal's explanation line laid out for wrapping (in the tooltip and the signal card): a label keeps its number
// ('ADX 27', 'högsta 85 555') and a ' · ' breaks before its dot, so a wrapped line never starts with a number standing
// alone. Only spaces change.
export const keepNumbers=s=>String(s).trim().replace(/ (?=[−+-]?\d)/g,NB).replace(/ · /g,DOT);
// AUTO_MIN, MIN_REAL: on a narrow plot the automatic slot width shrinks (not below AUTO_MIN px) until the forecast and
// at least MIN_REAL closed candles fit.
const BAR_PX=9,MIN_BAR=1.5,MAX_BAR=60,AXIS_H=26,INSET=30,PAD=.08,EASE_MS=250,GROW_MS=320,TICK_PX=84,TAG_H=18,AUTO_MIN=5.5,MIN_REAL=30;
// The regime of an evaluation or a stored signal, as the cards and the tooltip name it.
export const REGIME_LABELS=Object.freeze({'trend-up':'Trend upp','trend-down':'Trend ned',range:'Sidledes',weak:'Svag trend',insufficient:'För kort historik'});
const SANS='Inter, "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';
const FONT='500 11px '+SANS,SMALL='500 10px '+SANS,BOLD='600 11px '+SANS,MARK='700 9px '+SANS;
// Chrome that carries no data: neutral steps of the same grays.
const AXIS_LINE='rgba(148,163,184,.18)',START_LINE='rgba(139,155,176,.6)',PILL_FILL='rgba(26,33,43,.88)',
  PILL_LINE='rgba(186,195,208,.38)',TAG_DARK='#283240',FORMING_LINE='rgba(230,237,243,.55)';
const LEVELS=Object.freeze({entry:{color:C.entry,dash:[],name:'Entry'},sl:{color:C.sl,dash:[6,4],name:'SL'},
  tp:{color:C.tp,dash:[6,4],name:'TP'},liq:{color:C.liq,dash:[1,3],name:'Likv.'}});
// The levels a position's owner may drag; LINE_HIT: how far from a line (px) a mouse or pen still takes it; a finger takes
// a level by its handle, at least HANDLE_W × HANDLE_H px over its tag. A tap's hint stays HINT_MS.
const EDITABLE=Object.freeze(['sl','tp']),LINE_HIT=6,HANDLE_W=44,HANDLE_H=36,HINT_MS=4000,BAD_TEXT='#ffa79f';

const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
const validCandle=b=>!!b&&finite(b.t)&&[b.o,b.h,b.l,b.c].every(positive)&&b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c);
// Accepts a stored forecast record ({forecast:{...}}) or a bare forecastAt result.
const forecastOf=r=>Array.isArray(r?.forecast?.candles)?r.forecast:Array.isArray(r?.candles)?r:null;
const rgba=(hex,a)=>{const n=parseInt(hex.slice(1),16);return `rgba(${n>>16},${n>>8&255},${n&255},${a})`;};
const luminance=hex=>{const n=parseInt(hex.slice(1),16);
  return [n>>16,n>>8&255,n&255].reduce((s,v,i)=>{v/=255;return s+[.2126,.7152,.0722][i]*(v<=.04045?v/12.92:((v+.055)/1.055)**2.4);},0);};
// Text on a filled tag takes whichever of light text and the dark surface contrasts more with the fill.
const inks=new Map();
const ink=hex=>{
  if(!inks.has(hex)){const l=luminance(hex);inks.set(hex,(luminance(C.text)+.05)/(l+.05)>=(l+.05)/(luminance(C.surface)+.05)?C.text:C.surface);}
  return inks.get(hex);
};

const formats=new Map();
const fmt=(x,dec)=>{let f=formats.get(dec);if(!f)formats.set(dec,f=new Intl.NumberFormat('sv-SE',{minimumFractionDigits:dec,maximumFractionDigits:dec}));return f.format(x);};
const pct=x=>{const v=Math.round(x*10000)/100||0;return (v>0?'+':'')+fmt(v,2)+' %';};

// Europe/Stockholm wall-clock time. Intl knows the DST rules; the offset only
// changes on DST Sundays, so it is cached per UTC day.
const MONTHS=['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];
let zoneFormat=null;const zoneDays=new Map();
function rawOffset(t){
  zoneFormat??=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Stockholm',hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric'});
  const p={};for(const x of zoneFormat.formatToParts(t))p[x.type]=+x.value;
  return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)-Math.floor(t/MINUTE)*MINUTE;
}
function zoneOffset(t){
  const day=Math.floor(t/DAY);let o=zoneDays.get(day);
  if(o===undefined){
    const a=rawOffset(day*DAY),b=rawOffset(day*DAY+DAY-MINUTE);o=a===b?a:null;
    if(zoneDays.size>40000)zoneDays.clear();zoneDays.set(day,o);
  }
  return o??rawOffset(t);
}
// A Date whose UTC fields read Stockholm wall-clock time.
const wall=t=>new Date(t+zoneOffset(t));
const two=n=>String(n).padStart(2,'0');
const hhmm=w=>two(w.getUTCHours())+':'+two(w.getUTCMinutes());
const dmon=w=>w.getUTCDate()+' '+MONTHS[w.getUTCMonth()];
const stamp=(t,tfMs)=>{const w=wall(t);return dmon(w)+' '+(tfMs>=DAY?w.getUTCFullYear():hhmm(w));};

export function priceDecimals(p){return positive(p)?clamp(4-Math.floor(Math.log10(p)),0,10):2;}

function niceStep(lo,hi,n){
  const raw=(hi-lo)/n,mag=10**Math.floor(Math.log10(raw)),f=raw/mag;
  return (f<1.5?1:f<3?2:f<7?5:10)*mag;
}
const stepDecimals=step=>Math.max(0,-Math.floor(Math.log10(step)+1e-9));
// Round price ticks (1/2/5 × 10^k) inside [lo,hi], about n intervals apart, free of float noise.
export function niceTicks(lo,hi,n=5){
  if(!finite(lo)||!finite(hi))return [];
  if(!(finite(n)&&n>=1))n=5;
  if(lo>hi)[lo,hi]=[hi,lo];
  if(hi===lo){const pad=Math.abs(lo)*.001||1;lo-=pad;hi+=pad;}
  const step=niceStep(lo,hi,n),dp=stepDecimals(step),out=[];
  for(let k=Math.ceil(lo/step-1e-9),end=Math.floor(hi/step+1e-9);k<=end&&out.length<1000;k++)out.push(+(k*step).toFixed(dp));
  return out;
}

const STEPS=[5,10,15,30,60,120,180,240,360,480,720].map(m=>m*MINUTE);
// Ticks sit on candle open times. Intraday steps divide the Stockholm day, so a
// tick lands on the first candle of each local step and every local day start
// gets one; wider zooms use day starts (every 1/2 days, Mondays) or month starts.
export function timeTicks(t0,t1,tfMs,pixelsPerBar){
  if(!finite(t0)||!finite(t1)||!positive(tfMs)||!positive(pixelsPerBar)||t1<t0)return [];
  const first=Math.ceil(t0/tfMs)*tfMs,n=Math.floor((t1-first)/tfMs)+1;
  if(n<=0||n>20000)return [];
  const gap=TICK_PX/pixelsPerBar;
  const step=STEPS.find(s=>s>=tfMs&&s%tfMs===0&&s/tfMs>=gap)??0;
  const days=step?0:[1,2,7,14].find(k=>k*DAY>=tfMs&&k*DAY/tfMs>=gap)??0;
  const months=step||days?0:[1,3,6,12].find(k=>k*28*DAY/tfMs>=gap)??12;
  const out=[];let prev=wall(first-tfMs);
  for(let i=0;i<n;i++){
    const t=first+i*tfMs,w=wall(t),wt=w.getTime(),pt=prev.getTime(),day=Math.floor(wt/DAY),dayStart=day!==Math.floor(pt/DAY);
    // 1970-01-05 (day 4) was a Monday, so weekly ticks fall on Mondays.
    const hit=step?Math.floor(wt/step)!==Math.floor(pt/step):days?dayStart&&((day-4)%days+days)%days===0:
      w.getUTCMonth()!==prev.getUTCMonth()&&(w.getUTCFullYear()*12+w.getUTCMonth())%months===0;
    if(hit)out.push({t,label:dayStart?dmon(w):hhmm(w),major:dayStart});
    prev=w;
  }
  return out;
}

export function slotState(forecast,lastRealT){
  const f=forecastOf(forecast);
  return f?f.candles.map(c=>finite(lastRealT)&&c.t<=lastRealT?'realized':'future'):[];
}

// Forecast vs outcome over the first `horizon` forecast candles that have a
// closed real candle at the same time (bars must be closed candles only).
// Errors are relative to the forecast base: mae = mean |forecast close − real
// close| / base and lastError = (forecast close − real close) / base of the
// latest such candle. Direction compares the sign of close − base; a zero on
// either side is left out of dirN. in80/in50 count real closes inside the
// q10–q90 and q25–q75 bands.
export function comparisonStats(forecast,bars,horizon){
  const f=forecastOf(forecast);if(!f||!positive(f.base))return null;
  const total=Number.isInteger(horizon)&&horizon>0?horizon:f.candles.length,real=new Map(),bands=new Map();
  for(const b of Array.isArray(bars)?bars:[])if(b&&finite(b.t)&&positive(b.c))real.set(b.t,b);
  for(const b of Array.isArray(f.bands)?f.bands:[])if(b&&finite(b.t))bands.set(b.t,b);
  let elapsed=0,sum=0,dirHits=0,dirN=0,in80=0,in50=0,lastError=null;
  for(const c of f.candles.slice(0,total)){
    const b=real.get(c?.t);if(!b||!positive(c.c))continue;
    const e=(c.c-b.c)/f.base;elapsed++;sum+=Math.abs(e);lastError=e;
    const fd=Math.sign(c.c-f.base),rd=Math.sign(b.c-f.base);
    if(fd&&rd){dirN++;if(fd===rd)dirHits++;}
    const q=bands.get(c.t);
    if(q){if(b.c>=q.q10&&b.c<=q.q90)in80++;if(b.c>=q.q25&&b.c<=q.q75)in50++;}
  }
  return {elapsed,total,mae:elapsed?sum/elapsed:null,dirHits,dirN,in80,in50,lastError};
}

/**
 * The chart. setData(d) takes {symbol,tf,dec,bars (closed),forming,latest,
 * compare,horizon,signals,levels,showBand,showSignals,showLevels,status} and an
 * optional note (why there is no forecast; shown only while latest is null).
 * status is {reliable,text,state}; state 'loading' is a normal load, not a warning.
 * compareAhead:false draws an older compared version only where its outcome is known.
 * dataEnd: the text after 'Data t.o.m.' at the forecast start (the page's own, with
 * the date and year when they are not today's); without it the chart writes the time.
 * tick: the decimals of Bybit's price tick for the coin, when known: the last price's
 * axis tag and a real candle's prices in the tooltip are written with them, as the page
 * writes the price now (dec otherwise).
 * claude: Claude's sketch of the coming candles ({symbol,tf,candles,pending}), drawn in
 * violet after the newest real candle; each candle grows in as it arrives, and while
 * pending the chart says that Claude is drawing.
 * picked: a stored signal record whose entry, SL and TP are drawn from its candle
 * on, marked as that signal's (a label just left of its candle, outlined axis tags).
 * View {rightT,barPx,price:null|{lo,hi}}: rightT is the time at the plot's
 * right edge. While following (until the user pans) every data update moves
 * the view with the newest candle or forecast; price:null is the auto range.
 *
 * Moving a position's stop and target: setData's `edit` is the id of the
 * position whose SL and TP the user may move, and its lines are the levels that
 * carry that id as `edit`. With an `editor` ({preview({id,kind,price}) →
 * {ok,price,text,note}, commit({id,kind,price,pointer}) → promise,
 * cancel?({id,kind,note})}, price null removing the level, pointer the
 * pointerType that dragged it) and the levels shown, a mouse or pen drags such
 * an SL or TP by its axis tag or its line (±6 px); a missing one has a ghost tag
 * ("+ SL", "+ TP") beside the entry tag that creates it. On a phone the canvas
 * leaves vertical swipes to the page, so `handles` ({sl,tp}: elements in the
 * canvas's offset parent) are laid over those tags with touch-action none and take
 * a finger's drag. While dragging, a dashed line and its tag follow the pointer
 * (keeping the distance at which it took the level, a ghost's from the entry) at
 * the chart's price precision, the tag showing the editor's text (and its note,
 * red when not ok, in the tooltip); past the top or the bottom of the plot the
 * level is removed. Esc cancels. A valid drop is committed: the line stays where it
 * was dropped until the editor's promise settles, then the data shows the outcome
 * (the new level, or the old one back). An invalid drop goes back, with its note
 * passed to editor.cancel.
 */
export function createForecastChart(canvas,{tooltip=null,onViewChange=null,raf=globalThis.requestAnimationFrame?.bind(globalThis)??null,dpr,reducedMotion,
  editor=null,handles=null}={}){
  const ctx=canvas?.getContext?.('2d');
  if(!ctx)throw Error('Diagrammet kan inte ritas: canvas saknas');
  const vs={rightT:null,barPx:BAR_PX,price:null},plot={left:0,top:0,right:0,bottom:0},listeners=[];
  let W=0,H=0,ratio=1,axisW=56,follow=true,anchor=null,auto=null,range={lo:0,hi:1},g={bw:1,wd:1},autoBar=true;
  // closedT: the newest closed candle; lastT: the newest real candle, the forming one included. pick: the picked signal.
  // tickDec: the decimals of Bybit's price tick for the coin (setData's tick), for the last price's tag and the real
  // candles' prices in the tooltip; null: dec's.
  let d=null,tfMs=HOUR,bars=[],byT=new Map(),forming=null,closedT=null,lastT=null,dec=2,tickDec=null,horizon=10,latest=null,compare=null,same=false,pick=null;
  // sketch: Claude's candles ({candles,at,pending}); born: when each of its candles (by time) was first drawn, for the grow-in.
  let sketch=null;const born=new Map();
  // pinned: the candle slot ({t,y}) a tap on a touch screen holds the crosshair and tooltip at.
  let hover=null,pinned=null,drag=null,dirty=true,queued=false,destroyed=false,anim=null,shown=null,emitted='',cursor='';
  // lv: the level being dragged ({id,kind,pointerId,source,el,start,y,moved,raw,price,view}); pending: a dropped level
  // whose commit has not settled ({id,kind,price,text}); hint: what a tap on a level's tag says ({kind,text,until}).
  let lv=null,pending=null,hint=null;
  const editing=!!editor&&typeof editor.preview==='function'&&typeof editor.commit==='function';
  const clock=()=>globalThis.performance?.now?.()??Date.now();
  const reduced=()=>typeof reducedMotion==='function'?!!reducedMotion():reducedMotion!==undefined?!!reducedMotion:
    !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const deviceRatio=()=>{const r=typeof dpr==='function'?dpr():dpr??globalThis.devicePixelRatio;return finite(r)&&r>0?clamp(r,1,3):1;};
  // pre-wrap: the lines stay lines, and a stored signal's long explanation wraps at the stylesheet's max-width.
  if(tooltip){tooltip.hidden=true;if(tooltip.style)Object.assign(tooltip.style,{position:'absolute',pointerEvents:'none',whiteSpace:'pre-wrap'});}

  function invalidate(){
    dirty=true;if(queued||destroyed||!raf)return;
    queued=true;raf(ts=>{queued=false;if(dirty&&!destroyed)draw(ts);});
  }
  function measure(){
    const w=Math.max(0,Math.round(canvas.clientWidth||0)),h=Math.max(0,Math.round(canvas.clientHeight||0)),r=deviceRatio();
    if(w!==W||h!==H||r!==ratio){
      W=w;H=h;ratio=r;
      // The tags' share of the price axis depends on the width.
      if(d)axisW=axisWidth();
      // A new backing size clears the canvas, so a frame must follow.
      if(w&&h){canvas.width=Math.round(w*r);canvas.height=Math.round(h*r);}
      invalidate();
    }
    plot.right=Math.max(0,W-axisW);plot.bottom=Math.max(0,H-AXIS_H);
    if(autoBar)vs.barPx=defaultBar();
  }
  // Until the user zooms, the slot width follows the plot: about 100 slots, so the forecast and the compared
  // candles stay large on a wide screen. On a narrow plot (a phone) it shrinks, down to AUTO_MIN px, until the
  // forecast slots, the two empty slots after them and MIN_REAL closed candles fit, so history stays in view.
  const defaultBar=()=>{
    const w=plot.right-plot.left,ahead=Math.max(latest?horizon:1,sketch?.candles.length??0)+2;
    return clamp(Math.min(Math.max(w/100,BAR_PX),w/(ahead+MIN_REAL)),AUTO_MIN,16);
  };
  const inner=()=>plot.top+Math.min(INSET,(plot.bottom-plot.top)*.15);
  const xOf=t=>plot.right-(vs.rightT-t)/tfMs*vs.barPx;
  const cxOf=t=>xOf(t)+vs.barPx/2;
  const timeAt=x=>vs.rightT-(plot.right-x)/vs.barPx*tfMs;
  const slotAt=x=>Math.floor(timeAt(x)/tfMs)*tfMs;
  const yOf=p=>plot.bottom-(p-range.lo)/(range.hi-range.lo)*(plot.bottom-inner());
  const priceAt=y=>range.lo+(plot.bottom-y)/(plot.bottom-inner())*(range.hi-range.lo);
  const firstAt=t=>{let lo=0,hi=bars.length;while(lo<hi){const m=lo+hi>>1;if(bars[m].t<t)lo=m+1;else hi=m;}return lo;};
  // Lines land on whole device pixels: an odd device width is centred on a half pixel.
  const crisp=(v,dw)=>(dw%2?Math.floor(v*ratio)+.5:Math.round(v*ratio))/ratio;
  const snap=v=>Math.round(v*ratio)/ratio;
  const css1=()=>Math.max(1,Math.round(ratio));

  function prepare(r,n){
    const f=forecastOf(r);
    if(!f||!finite(f.cutoff)||!positive(f.base)||r.tf&&r.tf!==d.tf||r.symbol&&d.symbol&&r.symbol!==d.symbol)return null;
    const candles=f.candles.slice(0,n).filter(validCandle),bands=new Map();
    for(const b of Array.isArray(f.bands)?f.bands.slice(0,n):[])if(b&&finite(b.t)&&[b.q10,b.q25,b.q50,b.q75,b.q90].every(positive))bands.set(b.t,b);
    return {key:r.id??r.hash??f.model+'|'+f.cutoff,cutoff:f.cutoff,close:finite(r.cutoffClose)?r.cutoffClose:f.cutoff+tfMs,base:f.base,
      candles,bands,at:new Map(candles.map((c,i)=>[c.t,i]))};
  }
  // Claude's sketch for this coin and timeframe: its valid candles after the newest real one, in time order.
  function sketchOf(x){
    if(!x||typeof x!=='object'||x.tf&&x.tf!==d.tf||x.symbol&&d.symbol&&x.symbol!==d.symbol)return null;
    const candles=(Array.isArray(x.candles)?x.candles:[]).filter(c=>validCandle(c)&&(lastT===null||c.t>lastT)).sort((a,b)=>a.t-b.t);
    if(!candles.length&&!x.pending)return null;
    return {candles,at:new Map(candles.map((c,i)=>[c.t,i])),pending:!!x.pending};
  }
  function anchorTime(){
    const ends=[];
    if(lastT!==null)ends.push(lastT+tfMs);
    if(latest)ends.push(latest.cutoff+(horizon+1)*tfMs);
    if(sketch?.candles.length)ends.push(sketch.candles.at(-1).t+tfMs);
    return ends.length?Math.max(...ends)+2*tfMs:null;
  }
  const levelList=()=>(Array.isArray(d?.levels)?d.levels:[]).filter(l=>LEVELS[l?.kind]&&positive(l.price));
  function levelText(l){
    if(typeof l.text==='string'&&l.text)return l.text;
    const name=typeof l.label==='string'&&l.label?l.label:LEVELS[l.kind].name;
    return /\d/.test(name)?name:name+' '+fmt(l.price,dec);
  }
  // The position whose stop and target may be dragged: only with an editor and while the levels are shown.
  const editId=()=>editing&&d&&d.showLevels!==false&&typeof d.edit==='string'&&d.edit?d.edit:null;
  // The level being dragged, or the one whose drop is being saved, of the editable position.
  const moving=()=>{const id=editId();return lv&&lv.id===id?lv:pending&&pending.id===id?pending:null;};
  // The levels as drawn: a dragged level follows the pointer (nothing while it is over the remove zone), a dropped one
  // stays where it was dropped until its commit settles. state: 'drag', 'bad' (an invalid zone) or 'pending'.
  function shownLevels(){
    const list=levelList(),id=editId(),m=moving();
    if(!m)return list;
    const out=list.filter(l=>!(l.edit===id&&l.kind===m.kind));
    if(!positive(m.price))return out;
    const entry=list.find(l=>l.edit===id&&l.kind==='entry');
    out.push({kind:m.kind,price:m.price,from:entry?.from,label:LEVELS[m.kind].name,edit:id,text:m.text,
      state:m===pending?'pending':m.view&&!m.view.ok?'bad':'drag'});
    return out;
  }
  // A signal of this chart's coin and timeframe, with a side.
  const marked=s=>(s?.side==='long'||s?.side==='short')&&!(s.tf&&s.tf!==d.tf)&&!(s.symbol&&d.symbol&&s.symbol!==d.symbol);
  const pickOf=s=>marked(s)&&finite(s.barTime)&&[s.entry,s.sl,s.tp].every(positive)?s:null;
  // The picked signal's levels: shown whatever the Nivåer toggle says, since the user asked for them.
  const pickLevels=()=>pick?['entry','sl','tp'].map(kind=>({kind,price:pick[kind],from:pick.barTime,label:LEVELS[kind].name})):[];
  const signalTime=s=>stamp(finite(s.confirmedAt)?s.confirmedAt:s.barTime+tfMs,tfMs);
  // The picked signal's label: its side and the close that confirmed it, on a pill.
  function pickLabel(){
    ctx.font=BOLD;
    const text=(pick.side==='long'?'▲ KÖP ':'▼ SÄLJ ')+signalTime(pick);
    return {text,w:Math.ceil(ctx.measureText(text).width)+16,h:18};
  }
  // The room the label takes left of its candle's centre: the label, 2 px to the candle's slot and 4 px from the plot's edge.
  const labelRoom=w=>w+vs.barPx/2+6;
  function axisWidth(){
    let hi=forming?.h??0;
    for(const b of bars)if(b.h>hi)hi=b.h;
    for(const f of [latest,compare,sketch])if(f)for(const c of f.candles)if(c.h>hi)hi=c.h;
    // The last price's tag has the tick's decimals where those are more (BTC's tenth).
    ctx.font=FONT;let w=ctx.measureText(fmt(hi||1,Math.max(dec,tickDec??dec))).width+20;
    // Level tags ("Entry 85 230") are wider than a bare price, so the axis makes room while they are shown, but at
    // most 30 % of the width: on a phone a long price ("Entry 0,0000045070") would halve the plot, so it reaches into it.
    const list=[...(d.showLevels!==false?levelList():[]),...pickLevels()];
    if(list.length){
      ctx.font=BOLD;let tags=0;for(const l of list)tags=Math.max(tags,ctx.measureText(levelText(l)).width+14);
      w=Math.max(w,Math.min(tags,(W||canvas.clientWidth||0)*.3||Infinity));
    }
    return clamp(Math.ceil(w),52,160);
  }
  function setData(next){
    if(!next){
      d=null;bars=[];byT=new Map();forming=null;closedT=lastT=null;latest=compare=pick=sketch=null;anim=shown=pinned=null;vs.rightT=anchor=null;born.clear();
      invalidate();emit();return;
    }
    const tf=TF[next.tf];if(!tf)throw Error('Okänd tidsram för diagrammet: '+next.tf);
    const series=!d||d.symbol!==next.symbol||d.tf!==next.tf;
    d=next;tfMs=tf.ms;
    let list=(Array.isArray(next.bars)?next.bars:[]).filter(validCandle);
    if(list.some((b,i)=>i&&b.t<=list[i-1].t))list=[...new Map(list.map(b=>[b.t,b])).values()].sort((a,b)=>a.t-b.t);
    bars=list;byT=new Map(bars.map(b=>[b.t,b]));
    const f=next.forming;
    forming=validCandle(f)&&!byT.has(f.t)&&!(bars.length&&f.t<bars.at(-1).t)?f:null;
    closedT=bars.at(-1)?.t??null;lastT=(forming??bars.at(-1))?.t??null;
    horizon=Number.isInteger(next.horizon)&&next.horizon>0?next.horizon:10;
    latest=prepare(next.latest,horizon);compare=prepare(next.compare,horizon);
    same=!!(latest&&compare&&latest.key===compare.key);
    pick=pickOf(next.picked);
    sketch=sketchOf(next.claude);
    // A candle seen before keeps its birth, so a redraw does not grow it again; reduced motion shows it at once.
    if(!sketch?.candles.length)born.clear();
    else{const t=clock(),keep=new Set(sketch.candles.map(c=>c.t));for(const k of born.keys())if(!keep.has(k))born.delete(k);
      for(const c of sketch.candles)if(!born.has(c.t))born.set(c.t,reduced()?-Infinity:t);}
    dec=Number.isInteger(next.dec)&&next.dec>=0&&next.dec<=12?next.dec:priceDecimals((forming??bars.at(-1))?.c);
    tickDec=Number.isInteger(next.tick)&&next.tick>=0&&next.tick<=12?next.tick:null;
    // Ease the forming close from what is on screen; a new candle, a new series or reduced motion jumps.
    anim=!series&&forming&&shown?.t===forming.t&&shown.c!==forming.c&&!reduced()?{t:forming.t,from:shown.c,to:forming.c,start:null}:null;
    if(series)shown=pinned=hint=null;
    // A drag whose position is no longer the editable one (closed, or another coin) ends; otherwise its preview is asked
    // again, since the price moves while the level is held.
    if(lv&&editId()!==lv.id)cancelLevel('');
    else if(lv?.moved)ask();
    axisW=axisWidth();
    const a=anchorTime();
    if(a===null)vs.rightT=null;
    else if(series||vs.rightT===null){vs.rightT=a;vs.price=null;follow=true;auto=null;autoBar=true;measure();}
    else if(follow&&anchor!==null)vs.rightT+=a-anchor;
    anchor=a;
    invalidate();emit();
  }

  function wholeRange(){
    let lo=Infinity,hi=-Infinity;
    for(const b of forming?[...bars,forming]:bars){if(b.l<lo)lo=b.l;if(b.h>hi)hi=b.h;}
    if(lo>hi){const base=latest?.base??compare?.base??1;lo=base*.99;hi=base*1.01;}
    const pad=(hi-lo)*PAD||hi*.004;return {lo:lo-pad,hi:hi+pad};
  }
  // Visible real candles, forecast candles and band, padded 8 %. With nothing in
  // view the previous range stays, so an empty stretch does not jump.
  function computeRange(){
    if(vs.price)return range=vs.price;
    // While a level is dragged the prices hold still, so the pointer and the level's price stay together.
    if(vs.rightT===null||lv)return range;
    const t0=timeAt(plot.left)-tfMs,t1=timeAt(plot.right);let lo=Infinity,hi=-Infinity;
    const add=(l,h)=>{if(l<lo)lo=l;if(h>hi)hi=h;};
    for(let i=firstAt(t0);i<bars.length&&bars[i].t<=t1;i++)add(bars[i].l,bars[i].h);
    if(forming&&forming.t>=t0&&forming.t<=t1)add(forming.l,forming.h);
    for(const f of [latest,compare,sketch])if(f)for(const c of f.candles)if(c.t>=t0&&c.t<=t1)add(c.l,c.h);
    if(latest&&d.showBand!==false)for(const b of latest.bands.values())if(b.t>=t0&&b.t<=t1)add(b.q10,b.q90);
    // A picked signal in view shows its whole stop-to-target span; one far back does not squeeze today's prices.
    if(pick&&pick.barTime>=t0&&pick.barTime<=t1)add(Math.min(pick.sl,pick.tp),Math.max(pick.sl,pick.tp));
    if(lo>hi)return range=auto??(auto=wholeRange());
    const pad=(hi-lo)*PAD||hi*.004;
    return range=auto={lo:lo-pad,hi:hi+pad};
  }
  function geometry(){
    // Body about 78 % of the slot (a 1–6 px surface gap) with the wick exactly centred.
    const wd=css1();let bw=Math.max(1,Math.round((vs.barPx-clamp(vs.barPx*.22,1,6))*ratio));
    if((bw-wd)%2)bw--;
    g={bw:Math.max(wd,bw),wd};
  }
  function box(t,o,c){
    const left=Math.round(cxOf(t)*ratio-g.bw/2),top=Math.round(yOf(Math.max(o,c))*ratio);
    let bottom=Math.round(yOf(Math.min(o,c))*ratio);if(bottom-top<1)bottom=top+1;
    return {x:left/ratio,y:top/ratio,w:g.bw/ratio,h:(bottom-top)/ratio,cx:(left+g.bw/2)/ratio};
  }
  function hline(y,x0,x1,color,dw,dash){
    const yy=crisp(y,dw);ctx.beginPath();ctx.moveTo(x0,yy);ctx.lineTo(x1,yy);
    ctx.strokeStyle=color;ctx.lineWidth=dw/ratio;ctx.setLineDash(dash);ctx.stroke();ctx.setLineDash([]);
  }
  function vline(x,y0,y1,color,dw,dash){
    const xx=crisp(x,dw);ctx.beginPath();ctx.moveTo(xx,y0);ctx.lineTo(xx,y1);
    ctx.strokeStyle=color;ctx.lineWidth=dw/ratio;ctx.setLineDash(dash);ctx.stroke();ctx.setLineDash([]);
  }
  const rr=(x,y,w,h,r)=>{ctx.beginPath();if(ctx.roundRect)ctx.roundRect(x,y,w,h,r);else ctx.rect(x,y,w,h);};
  const fit=(s,max)=>{if(ctx.measureText(s).width<=max)return s;while(s.length>1&&ctx.measureText(s+'…').width>max)s=s.slice(0,-1);return s+'…';};
  // Labels drawn over candles, bands and outlines get a thin halo in the surface colour, so lines never run through the letters.
  function halo(text,x,y){
    if(typeof ctx.strokeText==='function'){ctx.setLineDash([]);ctx.lineJoin='round';ctx.lineWidth=3;ctx.strokeStyle=C.surface;ctx.strokeText(text,x,y);}
    ctx.fillText(text,x,y);
  }

  // `cross`: the crosshair's tags, and `mark` the forming candle's tag on the time axis, so the axis labels they
  // would cover are left out instead of peeking out beside them.
  function grid(tags,cross,mark){
    const n=Math.max(2,Math.round((plot.bottom-inner())/56)),ticks=niceTicks(range.lo,range.hi,n);
    const dp=ticks.length>1?stepDecimals(niceStep(Math.min(range.lo,range.hi),Math.max(range.lo,range.hi),n)):dec;
    const times=timeTicks(timeAt(plot.left)-tfMs,timeAt(plot.right),tfMs,vs.barPx);
    ctx.setLineDash([]);ctx.lineWidth=1/ratio;ctx.strokeStyle=C.grid;ctx.beginPath();
    for(const p of ticks){const y=crisp(yOf(p),1);if(y>=plot.top&&y<=plot.bottom){ctx.moveTo(plot.left,y);ctx.lineTo(plot.right,y);}}
    for(const k of times){const x=crisp(cxOf(k.t),1);if(x>=plot.left&&x<=plot.right){ctx.moveTo(x,plot.top);ctx.lineTo(x,plot.bottom);}}
    ctx.stroke();
    ctx.strokeStyle=AXIS_LINE;ctx.beginPath();
    const ax=crisp(plot.right,1),ay=crisp(plot.bottom,1);ctx.moveTo(ax,0);ctx.lineTo(ax,H);ctx.moveTo(0,ay);ctx.lineTo(plot.right,ay);ctx.stroke();
    ctx.font=FONT;ctx.fillStyle=C.axisText;ctx.textAlign='left';ctx.textBaseline='middle';
    for(const p of ticks){
      const y=yOf(p);
      if(y>=plot.top+7&&y<=plot.bottom-7&&!tags.some(t=>Math.abs(t.y-y)<TAG_H/2+6)&&!(cross&&Math.abs(cross.y-y)<TAG_H/2+6))ctx.fillText(fmt(p,dp),plot.right+8,y);
    }
    ctx.textAlign='center';
    for(const k of times){
      const x=cxOf(k.t),half=ctx.measureText(k.label).width/2;
      if(x-half<2||x+half>plot.right-2||cross&&x+half>cross.x0-6&&x-half<cross.x1+6||mark&&x+half>mark.x0-6&&x-half<mark.x1+6)continue;
      ctx.fillStyle=k.major?C.text:C.axisText;ctx.fillText(k.label,x,plot.bottom+AXIS_H/2);
    }
  }
  function region(){
    const x0=xOf(latest.cutoff+tfMs),x1=xOf(latest.cutoff+(horizon+1)*tfMs);
    ctx.fillStyle=C.region;ctx.fillRect(x0,plot.top,x1-x0,plot.bottom-plot.top);
    vline(x0,plot.top,plot.bottom,START_LINE,css1(),[4,4]);
  }
  // `upTo`: the last slot the line reaches.
  function median(f,color,width,dash,upTo=Infinity){
    const list=[...f.bands.values()].filter(b=>b.t<=upTo);if(!list.length)return;
    ctx.beginPath();ctx.moveTo(cxOf(f.cutoff),yOf(f.base));for(const b of list)ctx.lineTo(cxOf(b.t),yOf(b.q50));
    ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineJoin='round';ctx.setLineDash(dash);ctx.stroke();ctx.setLineDash([]);
  }
  // Both bands start with zero width at the cutoff candle's close and widen per slot.
  function band(f){
    const list=[...f.bands.values()];if(!list.length)return;
    const sx=cxOf(f.cutoff),sy=yOf(f.base);
    const polygon=(lo,hi,fill)=>{
      ctx.beginPath();ctx.moveTo(sx,sy);
      for(const b of list)ctx.lineTo(cxOf(b.t),yOf(b[hi]));
      for(let i=list.length-1;i>=0;i--)ctx.lineTo(cxOf(list[i].t),yOf(list[i][lo]));
      ctx.closePath();ctx.fillStyle=fill;ctx.fill();
    };
    polygon('q10','q90',C.band80);polygon('q25','q75',C.band50);
    median(f,C.median,1.25,[5,4]);
  }
  function wick(c,b){
    const yh=snap(yOf(c.h)),yl=snap(yOf(c.l));ctx.beginPath();
    if(yh<b.y){ctx.moveTo(b.cx,yh);ctx.lineTo(b.cx,b.y);}
    if(yl>b.y+b.h){ctx.moveTo(b.cx,b.y+b.h);ctx.lineTo(b.cx,yl);}
    ctx.stroke();
  }
  function outline(c,color,dash){
    const b=box(c.t,c.o,c.c),lw=g.wd/ratio;
    ctx.setLineDash(dash);ctx.strokeStyle=color;ctx.lineWidth=lw;
    ctx.strokeRect(b.x+lw/2,b.y+lw/2,Math.max(0,b.w-lw),Math.max(0,b.h-lw));
    wick(c,b);ctx.setLineDash([]);
  }
  // The comparison version sits behind the real candles: thin outlines where the
  // outcome is known. An older version's slots ahead (dotted, with its median) only
  // when d.compareAhead is not false: unasked, they would lie over the latest forecast.
  const ahead=()=>!same&&d.compareAhead!==false;
  // A slot whose real candle has closed: there the latest version is an outline, never a gray candle.
  const decided=t=>closedT!==null&&t<=closedT;
  function comparison(){
    const more=ahead();
    for(const c of compare.candles){
      // The latest version's own forming slot holds its gray candle (forecastCandles); an outline round it would read as a rim.
      if(lastT!==null&&c.t<=lastT){if(!same||decided(c.t))outline(c,C.fcOutline,[]);}
      else if(more)outline(c,C.fcOutline,[1,2]);
    }
    if(!same||d.showBand===false)median(compare,C.fcOutline,1,[2,3],same||more?Infinity:lastT??-Infinity);
  }
  // Every slot after the newest closed candle is a gray candle, the forming candle's slot (slot 1 of a current
  // version) too: N slots from the start line hold N gray candles. The forming candle is drawn over its slot's.
  function forecastCandles(){
    for(const c of latest.candles){
      if(decided(c.t)){if(!same)outline(c,C.fcOutline,[]);continue;}
      const b=box(c.t,c.o,c.c);
      ctx.fillStyle=C.fcFill;ctx.fillRect(b.x,b.y,b.w,b.h);
      // The wick ends at the body's edges, so no pixel gets the translucent gray twice.
      ctx.setLineDash([]);ctx.strokeStyle=C.fcFill;ctx.lineWidth=g.wd/ratio;wick(c,b);
    }
  }
  // Claude's candles: violet, a rising one filled and a falling one hollow, with a dotted line through the closes from
  // the last price. Each grows from its open over GROW_MS after it arrives. Returns whether one is still growing.
  function sketchCandles(now,from){
    let growing=false;const pts=[];
    ctx.setLineDash([]);
    for(const c of sketch.candles){
      const p=clamp((now-(born.get(c.t)??-Infinity))/GROW_MS,0,1);if(p<1)growing=true;
      const e=1-(1-p)**3,close=c.o+(c.c-c.o)*e,hi=c.o+(c.h-c.o)*e,lo=c.o+(c.l-c.o)*e;
      const b=box(c.t,c.o,close);
      ctx.globalAlpha=.35+.65*e;
      ctx.strokeStyle=C.claude;ctx.lineWidth=g.wd/ratio;
      ctx.beginPath();ctx.moveTo(b.cx,snap(yOf(hi)));ctx.lineTo(b.cx,b.y);ctx.moveTo(b.cx,b.y+b.h);ctx.lineTo(b.cx,snap(yOf(lo)));ctx.stroke();
      if(close>=c.o){ctx.fillStyle=rgba(C.claude,.75);ctx.fillRect(b.x,b.y,b.w,b.h);}
      else{const lw=g.wd/ratio;ctx.strokeRect(b.x+lw/2,b.y+lw/2,Math.max(0,b.w-lw),Math.max(0,b.h-lw));}
      pts.push([b.cx,yOf(close)]);
    }
    ctx.globalAlpha=1;
    if(pts.length){
      ctx.beginPath();ctx.moveTo(...(from??pts[0]));
      for(const [x,y] of pts)ctx.lineTo(x,y);
      ctx.strokeStyle=rgba(C.claude,.8);ctx.lineWidth=1.25;ctx.lineJoin='round';ctx.setLineDash([2,3]);ctx.stroke();ctx.setLineDash([]);
    }
    return growing;
  }
  // The sketch's pill at the top right of the plot (below the forecast's when that one is drawn): "Claude ritar…" while
  // its answer streams in.
  function sketchLabel(){
    const text=sketch.pending?CLAUDE_BUSY:CLAUDE_LABEL;
    ctx.font=BOLD;const pw=Math.ceil(ctx.measureText(text).width)+22,ph=20;
    const px=Math.max(plot.left+6,plot.right-pw-6),py=latest?32:6;
    rr(px,py,pw,ph,ph/2);ctx.fillStyle=PILL_FILL;ctx.fill();ctx.setLineDash(sketch.pending?[3,3]:[]);ctx.strokeStyle=rgba(C.claude,.7);ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle=C.claude;ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(text,px+11,py+ph/2+.5);
  }
  // The forming candle's close as drawn this frame (eased ~250 ms towards the latest poll).
  function formingClose(now){
    if(!forming){shown=null;return null;}
    let close=forming.c;
    if(anim&&anim.t===forming.t){
      anim.start??=now;
      const p=clamp((now-anim.start)/EASE_MS,0,1);close=anim.from+(anim.to-anim.from)*(1-(1-p)**3);
      if(p>=1)anim=null;
    }
    shown={t:forming.t,c:close};return close;
  }
  function realCandles(close){
    const t0=timeAt(plot.left)-tfMs,t1=timeAt(plot.right),list=[];
    for(let i=firstAt(t0);i<bars.length&&bars[i].t<=t1;i++)list.push(bars[i]);
    let live=null;
    if(forming){
      live={t:forming.t,o:forming.o,h:Math.max(forming.h,close),l:Math.min(forming.l,close),c:close};
      if(live.t>=t0&&live.t<=t1)list.push(live);else live=null;
    }
    for(const up of [true,false]){
      const set=list.filter(b=>(b.c>=b.o)===up).map(b=>[b,box(b.t,b.o,b.c)]);if(!set.length)continue;
      const color=up?C.up:C.down;
      ctx.setLineDash([]);ctx.strokeStyle=color;ctx.lineWidth=g.wd/ratio;ctx.beginPath();
      for(const [b,r] of set){ctx.moveTo(r.cx,snap(yOf(b.h)));ctx.lineTo(r.cx,snap(yOf(b.l)));}
      ctx.stroke();ctx.fillStyle=color;
      for(const [,r] of set)ctx.fillRect(r.x,r.y,r.w,r.h);
    }
    // The forming candle keeps a dashed outline over everything in its slot; its "pågår" mark is on the time axis.
    if(live){
      const r=box(live.t,live.o,live.c),pad=1.5;
      ctx.setLineDash([2,2]);ctx.strokeStyle=FORMING_LINE;ctx.lineWidth=css1()/ratio;
      ctx.strokeRect(r.x-pad,r.y-pad,r.w+2*pad,r.h+2*pad);ctx.setLineDash([]);
    }
  }
  // The forming candle's "pågår" mark sits on the time axis right under its slot, dashed like the candle's outline:
  // it names the slot without covering the closed candles beside it, the start line or the gray candles.
  function formingBox(){
    if(!forming)return null;
    const x=cxOf(forming.t);if(x<plot.left||x>plot.right)return null;
    ctx.font=MARK;const w=Math.ceil(ctx.measureText('pågår').width)+14;
    const x0=clamp(x-w/2,plot.left+1,Math.max(plot.left+1,plot.right-w-1));
    return {x0,x1:x0+w,w};
  }
  function formingTag(b){
    if(!b)return;
    const h=AXIS_H-8;
    rr(b.x0,plot.bottom+4,b.w,h,h/2);ctx.fillStyle=PILL_FILL;ctx.fill();
    ctx.setLineDash([2,2]);ctx.strokeStyle=FORMING_LINE;ctx.lineWidth=css1()/ratio;ctx.stroke();ctx.setLineDash([]);
    ctx.font=MARK;ctx.fillStyle=C.text;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('pågår',b.x0+b.w/2,plot.bottom+AXIS_H/2+.5);
  }
  // ▲ KÖP under the low, ▼ SÄLJ over the high: shape and word back up the colour.
  function signals(){
    const t0=timeAt(plot.left)-tfMs,t1=timeAt(plot.right),size=clamp(vs.barPx*.5,4,7);
    for(const s of Array.isArray(d.signals)?d.signals:[]){
      const t=s?.barTime??s?.t,b=byT.get(t);
      if(!b||t<t0||t>t1||!marked(s))continue;
      const x=cxOf(t),long=s.side==='long',y=long?yOf(b.l)+6:yOf(b.h)-6,base=long?y+size*1.3:y-size*1.3;
      ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+size,base);ctx.lineTo(x-size,base);ctx.closePath();
      ctx.setLineDash([]);ctx.lineJoin='round';ctx.lineWidth=2;ctx.strokeStyle=C.surface;ctx.stroke();
      ctx.fillStyle=long?C.up:C.down;ctx.fill();
      ctx.font=MARK;ctx.fillStyle=C.text;ctx.textAlign='center';ctx.textBaseline=long?'top':'bottom';
      halo(long?'KÖP':'SÄLJ',x,long?base+3:base-3);
    }
  }
  const startX=l=>clamp(finite(l.from)?xOf(l.from):plot.left,plot.left,plot.right);
  // A dragged or dropped level is a short-dashed line; in an invalid zone it is red and its zone is left out.
  function levels(list){
    const entries=list.filter(l=>l.kind==='entry');
    for(const e of entries)for(const [kind,color] of [['sl',C.down],['tp',C.up]]){
      const o=list.find(l=>l.kind===kind&&l.from===e.from)??(entries.length===1?list.find(l=>l.kind===kind):null);if(!o||o.state==='bad')continue;
      const x=startX(e),y0=yOf(e.price),y1=yOf(o.price);
      ctx.fillStyle=rgba(color,.07);ctx.fillRect(x,Math.min(y0,y1),plot.right-x,Math.abs(y1-y0));
    }
    for(const l of list){
      const st=LEVELS[l.kind],color=l.state==='bad'?C.down:st.color;
      hline(yOf(l.price),startX(l),plot.right,color,l.state?css1()+1:css1(),l.state?[3,3]:st.dash);
    }
  }
  // The picked stored signal: its entry, SL and TP from the centre of its candle to the right edge, with the zones
  // between them, and a label at the start that names the signal (side and the close that confirmed it), so its
  // lines never read as the live ones. Its axis tags are outlined (placeTags).
  function pickedLevels(){
    const x0=clamp(cxOf(pick.barTime),plot.left,plot.right),ye=yOf(pick.entry);
    for(const [kind,color] of [['sl',C.down],['tp',C.up]]){const y=yOf(pick[kind]);ctx.fillStyle=rgba(color,.07);ctx.fillRect(x0,Math.min(ye,y),plot.right-x0,Math.abs(y-ye));}
    for(const kind of ['entry','sl','tp']){const st=LEVELS[kind];hline(yOf(pick[kind]),x0,plot.right,st.color,css1(),st.dash);}
  }
  // The label is drawn after the last price's dotted line, which often runs at the entry's height right after a signal.
  function pickedLabel(){
    const x0=clamp(cxOf(pick.barTime),plot.left,plot.right),ye=yOf(pick.entry),long=pick.side==='long';
    const {text,w,h}=pickLabel(),before=x0-vs.barPx/2-2-w;
    // Left of the signal candle, just off the entry line on the target's side: a breakout closes beyond the candles before
    // it, so there the label covers none of them, nor the candles after the signal that show whether the target or the
    // stop came first. Only without room there (reveal makes room) does it start just right of the candle's centre.
    // (Half a pixel of the margin is given up, so the room reveal makes is room after rounding too.)
    const x=before>=plot.left+3.5?before:Math.max(plot.left+4,Math.min(x0+6,plot.right-w-4)),y=clamp(long?ye-h-3:ye+3,plot.top+2,plot.bottom-h-2);
    rr(x,y,w,h,h/2);ctx.fillStyle=PILL_FILL;ctx.fill();ctx.setLineDash([]);ctx.strokeStyle=long?C.up:C.down;ctx.lineWidth=css1()/ratio;ctx.stroke();
    ctx.fillStyle=C.text;ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(text,x+8,y+h/2+.5);
  }
  const lastCandle=close=>{const b=forming??bars.at(-1);if(!b)return null;const c=forming?close:b.c;return {c,color:c>=b.o?C.up:C.down};};
  function lastPrice(close){
    const last=lastCandle(close);
    if(last)hline(yOf(last.c),plot.left,plot.right,rgba(last.color,.8),css1(),[1,3]);
  }
  // Right-axis tags for the levels and the last price, placed before the axis
  // labels so labels they would cover are left out. Tags are nudged apart; a
  // level outside the visible prices is pinned to the edge with an arrow.
  // `list`: the levels as shown (shownLevels). The editable position's SL and TP tags say which level they move (drag);
  // its entry tag is where the ghost tags of a missing level go (anchor). Each item has its box: x, w and the text drawn.
  function placeTags(close,list){
    const tags=[],last=lastCandle(close),lo=plot.top+TAG_H/2,hi=plot.bottom-TAG_H/2,id=editId();
    if(d.showLevels!==false)for(const l of list)tags.push({y:yOf(l.price),text:levelText(l),fill:LEVELS[l.kind].color,state:l.state??'',kind:l.kind,
      drag:id&&l.edit===id&&!l.state&&EDITABLE.includes(l.kind)?l.kind:null,anchor:!!id&&l.edit===id&&l.kind==='entry'});
    for(const l of pickLevels())tags.push({y:yOf(l.price),text:levelText(l),fill:LEVELS[l.kind].color,outlined:true});
    if(last)tags.push({y:yOf(last.c),text:fmt(last.c,tickDec??dec),fill:last.color});
    if(hi<lo)return [];
    const items=tags.map(t=>({...t,edge:t.y<lo?-1:t.y>hi?1:0,y:clamp(t.y,lo,hi)})).sort((a,b)=>a.y-b.y);
    for(let i=1;i<items.length;i++)items[i].y=Math.max(items[i].y,items[i-1].y+TAG_H+1);
    for(let i=items.length-1;i>=0;i--)items[i].y=Math.min(items[i].y,i===items.length-1?hi:items[i+1].y-TAG_H-1);
    ctx.font=BOLD;
    for(const t of items){t.label=(t.edge<0?'▲ ':t.edge>0?'▼ ':'')+t.text;t.w=Math.ceil(ctx.measureText(t.label).width)+12;t.x=Math.min(plot.right+1,W-t.w-1);}
    return items;
  }
  // "+ SL" / "+ TP" left of the editable position's entry tag, for each level it does not have (and is not being dragged).
  function ghostTags(items){
    const id=editId(),at=id&&!pending?items.find(t=>t.anchor):null;
    if(!at)return [];
    const have=new Set(levelList().filter(l=>l.edit===id).map(l=>l.kind)),out=[];
    ctx.font=BOLD;let right=at.x-4;
    for(const kind of ['tp','sl']){
      if(have.has(kind)||lv?.kind===kind)continue;
      const text='+ '+LEVELS[kind].name,w=Math.ceil(ctx.measureText(text).width)+12;
      out.unshift({kind,text,x:right-w,w,y:at.y});right-=w+4;
    }
    return out;
  }
  // `cross`: the crosshair's tags. A tag the crosshair's price tag overlaps yields to it, so no strip of it
  // peeks out above or below. A picked signal's tags are outlined in their line colour on the dark tag fill. A dragged
  // or saving level's tag is outlined too; in an invalid zone it is red, marked ⚠.
  function axisTags(items,cross){
    ctx.font=BOLD;ctx.textAlign='left';ctx.textBaseline='middle';
    for(const t of items){
      if(cross&&Math.abs(t.y-cross.y)<TAG_H)continue;
      const bad=t.state==='bad',text=(bad?'⚠ ':'')+t.label,w=bad?Math.ceil(ctx.measureText(text).width)+12:t.w,x=bad?Math.min(plot.right+1,W-w-1):t.x;
      rr(x,t.y-TAG_H/2,w,TAG_H,3);
      if(t.outlined||t.state){
        ctx.fillStyle=TAG_DARK;ctx.fill();ctx.setLineDash(t.state==='pending'?[3,2]:[]);ctx.strokeStyle=bad?C.down:t.fill;ctx.lineWidth=1.5;ctx.stroke();ctx.setLineDash([]);
        ctx.fillStyle=bad?BAD_TEXT:C.text;
      }
      else{ctx.fillStyle=rgba(t.fill,.9);ctx.fill();ctx.fillStyle=ink(t.fill);}
      ctx.fillText(text,x+6,t.y+.5);
    }
  }
  // Ghost tags: a dashed outline in the level's colour on the dark pill fill.
  function drawGhosts(list){
    ctx.font=BOLD;ctx.textAlign='left';ctx.textBaseline='middle';
    for(const gh of list){
      rr(gh.x,gh.y-TAG_H/2,gh.w,TAG_H,TAG_H/2);ctx.fillStyle=PILL_FILL;ctx.fill();
      ctx.setLineDash([3,2]);ctx.strokeStyle=LEVELS[gh.kind].color;ctx.lineWidth=1.5;ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle=C.text;ctx.fillText(gh.text,gh.x+6,gh.y+.5);
    }
  }
  function crossLines(hit){
    vline(hit.x,plot.top,plot.bottom,C.crosshair,css1(),[]);
    hline(hit.y,plot.left,plot.right,C.crosshair,css1(),[]);
  }
  // The crosshair's price tag spans the whole price axis, so a level or last-price tag at the same height is
  // covered completely rather than peeking out beside it; the time tag sits on the time axis.
  function crossBox(hit){
    ctx.font=BOLD;
    const pt=fmt(hit.price,dec),pw=Math.max(Math.ceil(ctx.measureText(pt).width)+12,W-plot.right-2),px=Math.min(plot.right+1,W-pw-1);
    const tt=stamp(hit.t,tfMs),tw=Math.ceil(ctx.measureText(tt).width)+14,tx=clamp(hit.x-tw/2,plot.left+1,Math.max(plot.left+1,plot.right-tw-1));
    return {pt,pw,px,y:clamp(hit.y,plot.top+TAG_H/2,plot.bottom-TAG_H/2),tt,tw,x0:tx,x1:tx+tw};
  }
  function crossTags(b){
    ctx.font=BOLD;ctx.textBaseline='middle';
    rr(b.px,b.y-TAG_H/2,b.pw,TAG_H,3);ctx.fillStyle=TAG_DARK;ctx.fill();
    ctx.fillStyle=C.text;ctx.textAlign='left';ctx.fillText(b.pt,b.px+6,b.y+.5);
    rr(b.x0,plot.bottom+3,b.tw,AXIS_H-6,3);ctx.fillStyle=TAG_DARK;ctx.fill();
    ctx.fillStyle=C.text;ctx.textAlign='center';ctx.fillText(b.tt,b.x0+b.tw/2,plot.bottom+AXIS_H/2);
  }
  // A normal load is no warning: the header's neutral pill says it, and the empty plot says 'Hämtar candles…'.
  function badgeBox(){
    if(d?.status?.reliable!==false||d.status.state==='loading')return null;
    ctx.font=BOLD;const text=fit(String(d.status.text||'Data saknas'),Math.max(40,(plot.right||W)-58));
    return {x:8,y:6,w:Math.ceil(ctx.measureText(text).width)+38,h:22,text};
  }
  function badge(b){
    if(!b)return;
    rr(b.x,b.y,b.w,b.h,6);ctx.fillStyle=rgba(C.liq,.92);ctx.fill();
    ctx.font=BOLD;ctx.fillStyle=C.surface;ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(b.text,b.x+28,b.y+b.h/2+.5);
    // A warning sign before the words (drawn after them, so the text sits on the badge's own fill).
    const cx=b.x+16,cy=b.y+b.h/2;
    ctx.beginPath();ctx.moveTo(cx,cy-6.5);ctx.lineTo(cx+7.5,cy+6);ctx.lineTo(cx-7.5,cy+6);ctx.closePath();ctx.fillStyle=C.surface;ctx.fill();
    ctx.fillStyle=rgba(C.liq,.92);ctx.fillRect(cx-.75,cy-2.5,1.5,5);ctx.fillRect(cx-.75,cy+3.5,1.5,1.5);
  }
  // Region labels are drawn over the candles so they stay readable at any zoom.
  function regionLabels(badgeAt){
    const x=xOf(latest.cutoff+tfMs),x1=xOf(latest.cutoff+(horizon+1)*tfMs);
    if(x1<plot.left||x>plot.right)return;
    ctx.font=BOLD;const pw=Math.ceil(ctx.measureText(LABEL).width)+22,ph=20;
    const px=Math.max(plot.left+6,Math.min(x+6,plot.right-pw-6)),py=badgeAt&&px<badgeAt.x+badgeAt.w+8?badgeAt.y+badgeAt.h+6:6;
    rr(px,py,pw,ph,ph/2);ctx.fillStyle=PILL_FILL;ctx.fill();ctx.setLineDash([]);ctx.strokeStyle=PILL_LINE;ctx.lineWidth=1;ctx.stroke();
    ctx.fillStyle=C.text;ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(LABEL,px+11,py+ph/2+.5);
    // A pill wider than the region it names (5 or 10 candles on most screens) overhangs the real candles: a thin bracket
    // under it spans exactly the region, so the label still points at the forecast.
    const a=crisp(Math.max(x,plot.left),css1()),b=crisp(Math.min(x1,plot.right),css1());
    if((px<a||px+pw>b)&&b-a>=2){
      const y=crisp(py+ph+4,css1());ctx.beginPath();ctx.moveTo(a,y+4);ctx.lineTo(a,y);ctx.lineTo(b,y);ctx.lineTo(b,y+4);
      ctx.strokeStyle=START_LINE;ctx.lineWidth=css1()/ratio;ctx.stroke();
    }
    if(x<plot.left)return;
    // The page's own text (with the date and year when they are not today's), as its version list and cards write it.
    const w=wall(latest.close),own=typeof d.dataEnd==='string'?d.dataEnd.trim():'';
    const text='Data t.o.m. '+(own||(tfMs>=4*HOUR?dmon(w)+' ':'')+hhmm(w));
    ctx.font=SMALL;ctx.fillStyle=C.axisText;ctx.textBaseline='bottom';
    const right=x-8-ctx.measureText(text).width>=plot.left+4;
    ctx.textAlign=right?'right':'left';halo(text,right?x-8:x+8,plot.bottom-6);
  }
  // With no forecast to draw, a muted dashed pill where its label would sit says why (d.note, e.g. too short a history).
  function noteLabel(badgeAt){
    const raw=typeof d.note==='string'?d.note.trim():'';if(!raw)return;
    ctx.font=BOLD;const text=fit(raw,Math.max(40,plot.right-plot.left-40)),pw=Math.ceil(ctx.measureText(text).width)+22,ph=20;
    const px=Math.max(plot.left+6,plot.right-pw-6),py=badgeAt&&px<badgeAt.x+badgeAt.w+8?badgeAt.y+badgeAt.h+6:6;
    rr(px,py,pw,ph,ph/2);ctx.fillStyle=PILL_FILL;ctx.fill();ctx.setLineDash([3,3]);ctx.strokeStyle=PILL_LINE;ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle=C.axisText;ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(text,px+11,py+ph/2+.5);
  }
  // A stored signal as its record says it, never recomputed: side, regime, the close that confirmed it (and
  // "efterhand" when it was stored after the fact), entry, SL and TP, and the record's own explanation lines.
  // The tooltip wraps long lines. In the head line and the Entry/SL/TP line the parts are glued with no-break
  // spaces, so those break only before a ' · ' and a label keeps its number; explanation lines wrap as stored.
  function signalLines(s,t){
    const regime=Object.hasOwn(REGIME_LABELS,s.regime)?REGIME_LABELS[s.regime]:null,levels=[['Entry',s.entry],['SL',s.sl],['TP',s.tp]].filter(([,v])=>positive(v));
    const head=[s.side==='long'?'▲ KÖP':'▼ SÄLJ',regime,'bekräftad '+stamp(finite(s.confirmedAt)?s.confirmedAt:t+tfMs,tfMs),s.origin==='backfill'&&'efterhand'];
    const out=[head.filter(Boolean).map(x=>x.replace(/ /g,NB)).join(DOT)];
    if(levels.length)out.push(levels.map(([k,v])=>k+NB+fmt(v,dec)).join(DOT));
    for(const x of Array.isArray(s.explanation)?s.explanation:[])if(typeof x==='string'&&x.trim())out.push(keepNumbers(x));
    return out;
  }
  function tooltipLines(hit){
    const ohlc=(c,p=dec)=>['O '+fmt(c.o,p)+'   H '+fmt(c.h,p),'L '+fmt(c.l,p)+'   C '+fmt(c.c,p)];
    if(hit.bar){
      // Change is always against the previous candle's close. When that candle is not loaded (first loaded
      // candle, data gap) the line is left out, so the number never depends on where the history starts.
      // Bybit's own prices, with its tick's decimals when known (the forming close is the last price's tag).
      const b=hit.bar,prev=byT.get(b.t-tfMs),out=[stamp(b.t,tfMs)+(hit.forming?' · pågår':''),...ohlc(b,tickDec??dec)];
      if(prev)out.push('Förändring '+pct(b.c/prev.c-1));
      if(hit.compare)out.push('Prognos vs utfall: '+pct(hit.compare.error));
      // The marker sits on the candle that made the signal; the signal lists give the close that confirmed it.
      const s=hit.closed&&d.showSignals!==false?(Array.isArray(d.signals)?d.signals:[]).find(x=>(x?.barTime??x?.t)===b.t&&marked(x)):null;
      if(s)out.push(...signalLines(s,b.t));
      return out;
    }
    const out=[];
    if(hit.forecast){
      const {candle,band}=hit.forecast;out.push('Prognos (scenario) · '+stamp(candle.t,tfMs),...ohlc(candle));
      // "80 %" alone could read as a probability; it names the band between the analogues' 10th and 90th percentiles.
      if(band)out.push('80 %-band: '+fmt(band.q10,dec)+' – '+fmt(band.q90,dec));
    }
    if(hit.claude)out.push('Pablo (gissning) · '+stamp(hit.claude.t,tfMs),...ohlc(hit.claude));
    return out;
  }
  function tip(hit){
    if(!tooltip)return;
    const lines=hit&&!drag?.moved?tooltipLines(hit):[];
    if(!lines.length){if(!tooltip.hidden)tooltip.hidden=true;return;}
    tooltip.removeAttribute?.('data-state');
    const text=lines.join('\n');if(tooltip.textContent!==text)tooltip.textContent=text;
    tooltip.hidden=false;
    // Measured at the canvas's left edge: an absolutely placed box shrinks to the room right of where it stands, and its
    // lines wrap, so measured at its last place near the right edge it reads narrower (and taller) than it is where it lands.
    if(tooltip.style)tooltip.style.left=Math.round(canvas.offsetLeft||0)+'px';
    const w=tooltip.offsetWidth||0,h=tooltip.offsetHeight||0;
    let x=hit.x+16,y=hit.y+16;
    if(x+w>plot.right-4)x=hit.x-16-w;
    if(y+h>plot.bottom-4)y=hit.y-16-h;
    if(tooltip.style){
      tooltip.style.left=Math.round((canvas.offsetLeft||0)+Math.max(plot.left+4,x))+'px';
      tooltip.style.top=Math.round((canvas.offsetTop||0)+Math.max(plot.top+4,y))+'px';
    }
  }
  function draw(ts){
    if(destroyed)return;
    measure();dirty=false;
    if(!W||!H){dirty=true;return;}
    ctx.setTransform(ratio,0,0,ratio,0,0);ctx.globalAlpha=1;ctx.setLineDash([]);
    ctx.fillStyle=C.surface;ctx.fillRect(0,0,W,H);
    if(!d||vs.rightT===null){
      if(d){ctx.font=FONT;ctx.fillStyle=C.axisText;ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillText(d.status?.state==='loading'?'Hämtar candles…':'Ingen kursdata ännu',W/2,H/2);}
      badge(badgeBox());placeHandles([],[]);tip(null);return;
    }
    computeRange();geometry();
    // A mouse or pen points; a tap on a touch screen pins the crosshair to its candle until the next tap.
    const at=lv?null:hover??(pinned?{x:cxOf(pinned.t),y:pinned.y}:null);
    const hit=at?hitAt(at.x,at.y):null,cross=hit?crossBox(hit):null;
    const list=shownLevels(),close=formingClose(finite(ts)?ts:clock()),tags=placeTags(close,list),ghosts=ghostTags(tags);
    // The "pågår" mark yields to the crosshair's time tag on or beside it, as level tags yield to its price tag: a
    // strip of it next to the time would read as part of it ("pågår 5 okt 18:00").
    let mark=formingBox();
    if(mark&&cross&&mark.x1>cross.x0-6&&mark.x0<cross.x1+6)mark=null;
    grid(tags,cross,mark);
    ctx.save();ctx.beginPath();ctx.rect(plot.left,plot.top,plot.right-plot.left,plot.bottom-plot.top);ctx.clip();
    if(latest)region();
    if(latest&&d.showBand!==false)band(latest);
    if(compare)comparison();
    if(latest)forecastCandles();
    const growing=sketch?.candles.length?sketchCandles(finite(ts)?ts:clock(),lastT!==null&&finite(close)?[cxOf(lastT),yOf(close)]:null):false;
    realCandles(close);
    if(d.showSignals!==false)signals();
    if(d.showLevels!==false)levels(list);
    if(pick)pickedLevels();
    lastPrice(close);
    if(pick)pickedLabel();
    if(hit)crossLines(hit);
    ctx.restore();
    const badgeAt=badgeBox();
    if(latest)regionLabels(badgeAt);else if(!sketch)noteLabel(badgeAt);
    if(sketch)sketchLabel();
    axisTags(tags,cross);
    drawGhosts(ghosts);
    formingTag(mark);
    if(cross)crossTags(cross);
    badge(badgeAt);
    placeHandles(tags,ghosts);
    // A dragged level's note (an invalid zone's reason, or what a drop there does), else a tap's hint, else the tooltip.
    const note=lv?.moved&&lv.view?.note?{text:lv.view.note,y:lv.y,bad:!lv.view.ok}:hint&&hint.until>clock()?hintBox(tags,ghosts):null;
    if(note)callout(note.text,note.y,note.bad);else tip(hit);
    if(anim||growing)invalidate();
  }

  function hitAt(x,y){
    if(!d||vs.rightT===null||!finite(x)||!finite(y)||x<plot.left||x>plot.right||y<plot.top||y>plot.bottom)return null;
    const t=slotAt(x),bar=forming?.t===t?forming:byT.get(t)??null,closed=!!bar&&bar!==forming;
    const li=latest?.at.get(t),ci=compare?.at.get(t),fc=li===undefined?null:latest.candles[li],cc=ci===undefined?null:compare.candles[ci];
    const si=bar?undefined:sketch?.at.get(t),sk=si===undefined?null:sketch.candles[si];
    const state=lastT!==null&&t<=lastT?'realized':'future';
    const slot=f=>Math.round((t-f.cutoff)/tfMs);
    const forecast=fc?{h:slot(latest),candle:fc,band:latest.bands.get(t)??null,state}:
      cc&&!bar&&(state==='realized'||ahead())?{h:slot(compare),candle:cc,band:compare.bands.get(t)??null,state,compare:true}:null;
    // The outcome is only compared once the real candle has closed.
    const ref=!closed?null:cc?{c:cc,base:compare.base}:fc?{c:fc,base:latest.base}:null;
    return {t,x:cxOf(t),y,price:priceAt(y),kind:bar?'real':forecast?'forecast':sk?'claude':'empty',bar,forming:!!bar&&bar===forming,closed,forecast,claude:sk,
      compare:ref?{candle:ref.c,error:(ref.c.c-bar.c)/ref.base}:null};
  }
  function hitTest(x,y){measure();if(d)computeRange();return hitAt(x,y);}

  // ---- Moving a position's stop and target ----------------------------------------------------------------
  const pos=e=>{const r=canvas.getBoundingClientRect?.()??{left:0,top:0};return {x:e.clientX-r.left,y:e.clientY-r.top};};
  const setCursor=c=>{if(canvas.style&&c!==cursor)canvas.style.cursor=cursor=c;};
  const doc=()=>canvas.ownerDocument??null;
  // The tags and ghost tags as the next frame places them, for a hit test between frames.
  function layout(){
    measure();
    if(!d||vs.rightT===null||!editId())return {tags:[],ghosts:[]};
    computeRange();
    const tags=placeTags(shown?.c??forming?.c??null,shownLevels());
    return {tags,ghosts:ghostTags(tags)};
  }
  const inBox=(p,b,pad=2)=>p.x>=b.x-pad&&p.x<=b.x+b.w+pad&&Math.abs(p.y-b.y)<=TAG_H/2+pad;
  // The SL or TP a mouse or pen at p takes: by its ghost tag, its axis tag, or its line within LINE_HIT px.
  function levelHit(p){
    if(!editId()||lv||pending)return null;
    const {tags,ghosts}=layout(),id=editId();
    for(const gh of ghosts)if(inBox(p,gh))return gh.kind;
    for(const t of tags)if(t.drag&&inBox(p,t))return t.drag;
    if(p.x<plot.left||p.x>plot.right||p.y<plot.top||p.y>plot.bottom)return null;
    let best=null,near=LINE_HIT+.5;
    for(const l of levelList())if(l.edit===id&&EDITABLE.includes(l.kind)&&p.x>=startX(l)){
      const dist=Math.abs(p.y-yOf(l.price));if(dist<near){near=dist;best=l.kind;}
    }
    return best;
  }
  const levelPrice=kind=>levelList().find(l=>l.edit===editId()&&l.kind===kind)?.price??null;
  // offset: how far from the level's own line (a ghost tag's: the entry's line) the pointer took it, a tag nudged off
  // its line included, so the level moves with the pointer instead of jumping to it. A line outside the plot counts from
  // where its tag is drawn (pinned to the edge, or stacked on other pinned tags there; a ghost tag's beside the entry's),
  // so the level comes into view under the pointer.
  function startLevel(kind,pointerId,source,p,el=null,pointerType=null){
    hint=null;hover=null;pinned=null;drag=null;
    const price=levelPrice(kind),base=price??levelPrice('entry'),y=positive(base)?yOf(base):null;
    let from=y;
    if(y!==null&&(y<plot.top||y>plot.bottom)){
      const {tags,ghosts}=layout(),tag=price===null?ghosts.find(g=>g.kind===kind)??tags.find(t=>t.anchor):tags.find(t=>t.drag===kind);
      from=finite(tag?.y)?tag.y:clamp(y,plot.top+TAG_H/2,plot.bottom-TAG_H/2);
    }
    const offset=from===null?0:p.y-from;
    lv={id:editId(),kind,pointerId,pointerType,source,el,start:p,offset,y:p.y-offset,moved:false,raw:price,price,text:null,view:null};
    doc()?.addEventListener?.('keydown',escape,true);
    setCursor('ns-resize');invalidate();
  }
  // The chart's own price precision: a level lands on a price its tag can show exactly.
  const onGrid=x=>{const k=10**dec;return Math.round(x*k)/k;};
  function moveLevel(p){
    if(!lv.moved&&Math.abs(p.y-lv.start.y)<3)return;
    lv.moved=true;lv.y=p.y-lv.offset;
    // Past the top or the bottom of the plot (where the pointer is), the level is removed.
    lv.raw=p.y<plot.top||p.y>plot.bottom?null:onGrid(priceAt(lv.y));
    ask();invalidate();
  }
  // The editor's word on the level at lv.raw: the price it would be set to (Bybit's tick), its tag text, and a note.
  function ask(){
    let v=null;try{v=editor.preview({id:lv.id,kind:lv.kind,price:lv.raw});}catch{v=null;}
    const name=LEVELS[lv.kind].name,ok=!!v?.ok,removing=lv.raw===null;
    const note=typeof v?.note==='string'&&v.note?v.note:removing&&ok?'Släpp för att ta bort '+name:'';
    lv.view={ok,note,text:typeof v?.text==='string'&&v.text?v.text:removing?'Ta bort '+name:name+' '+fmt(lv.raw,dec)};
    lv.price=removing?null:positive(v?.price)?v.price:lv.raw;
    lv.text=lv.view.text;
  }
  function escape(e){if(e.key==='Escape'&&lv){e.preventDefault?.();e.stopPropagation?.();cancelLevel('');}}
  function release(){doc()?.removeEventListener?.('keydown',escape,true);setCursor('crosshair');}
  // Back to the level as it was; a note (the reason a drop was refused) goes to the editor. `was`: the drag that ends,
  // the one under way by default.
  function cancelLevel(note,was=lv){
    if(was===lv){lv=null;release();}
    if(was&&note)try{editor.cancel?.({id:was.id,kind:was.kind,note});}catch{/* the page's problem */}
    invalidate();
  }
  async function dropLevel(){
    const was=lv;lv=null;release();
    if(!was)return;
    // A tap or click on a tag says what dragging it does.
    if(!was.moved){
      const name=LEVELS[was.kind].name;
      hint={kind:was.kind,until:clock()+HINT_MS,text:was.price===null?'Dra uppåt eller nedåt för att sätta '+name+'.':
        'Dra för att flytta '+name+'. Dra den ovanför eller under diagrammet för att ta bort den.'};
      globalThis.setTimeout?.(invalidate,HINT_MS+50)?.unref?.();
      invalidate();return;
    }
    if(!was.view?.ok){cancelLevel(was.view?.note||'',was);return;}
    const job=pending={id:was.id,kind:was.kind,price:was.price,text:was.view.text};
    invalidate();
    try{await editor.commit({id:was.id,kind:was.kind,price:was.price,pointer:was.pointerType});}catch{/* the editor reports its own failures */}
    if(pending===job){pending=null;invalidate();}
  }
  // Where a tap's hint points: at the tag or the ghost tag of its level.
  function hintBox(tags,ghosts){
    const at=tags.find(t=>t.drag===hint.kind)??ghosts.find(g=>g.kind===hint.kind);
    return at?{text:hint.text,y:at.y,bad:false}:null;
  }
  // The tooltip as a note beside a level: right-aligned in the plot, over the level (under it near the top).
  function callout(text,y,bad){
    if(!tooltip)return;
    if(tooltip.textContent!==text)tooltip.textContent=text;
    tooltip.hidden=false;tooltip.setAttribute?.('data-state',bad?'bad':'note');
    if(!tooltip.style)return;
    tooltip.style.left=Math.round(canvas.offsetLeft||0)+'px';
    const w=tooltip.offsetWidth||0,h=tooltip.offsetHeight||0,at=clamp(finite(y)?y:plot.top,plot.top,plot.bottom);
    const top=at-TAG_H/2-6-h>=plot.top+4?at-TAG_H/2-6-h:Math.min(plot.bottom-4-h,at+TAG_H/2+6);
    tooltip.style.left=Math.round((canvas.offsetLeft||0)+Math.max(plot.left+4,plot.right-8-w))+'px';
    tooltip.style.top=Math.round((canvas.offsetTop||0)+Math.max(plot.top+4,top))+'px';
  }
  // Each handle covers its level's tag (or ghost tag), at least HANDLE_W × HANDLE_H px; it follows its own drag.
  function placeHandles(tags,ghosts){
    if(!handles)return;
    const id=editId();
    for(const kind of EDITABLE){
      const el=handles[kind];if(!el)continue;
      let box=null,state='';
      if(lv&&lv.el===el){
        state='drag';
        box=tags.find(t=>t.state&&t.kind===kind)??{x:plot.right+1,w:Math.max(0,W-plot.right-2),y:clamp(lv.y,plot.top+TAG_H/2,plot.bottom-TAG_H/2)};
      }else if(id&&!lv&&!pending){
        const t=tags.find(x=>x.drag===kind),gh=ghosts.find(x=>x.kind===kind);
        box=t??gh??null;state=t?'level':gh?'ghost':'';
      }
      if(!box){if(!el.hidden)el.hidden=true;continue;}
      const w=Math.max(HANDLE_W,box.w+8),x=clamp(box.x+box.w/2-w/2,0,Math.max(0,W-w)),y=clamp(box.y-HANDLE_H/2,0,Math.max(0,H-HANDLE_H));
      if(el.style){
        const set=(k,v)=>{if(el.style[k]!==v)el.style[k]=v;};
        set('left',Math.round((canvas.offsetLeft||0)+x)+'px');set('top',Math.round((canvas.offsetTop||0)+y)+'px');set('width',Math.round(w)+'px');set('height',HANDLE_H+'px');
      }
      if(el.getAttribute?.('data-state')!==state)el.setAttribute?.('data-state',state);
      const name=LEVELS[kind].name,title=state==='ghost'?'Dra för att sätta '+name:'Dra för att flytta '+name+', ovanför eller under diagrammet för att ta bort den';
      if(el.title!==title)el.title=title;
      if(el.hidden)el.hidden=false;
    }
  }

  function snapshot(){
    measure();
    return Object.freeze({rightT:vs.rightT,barPx:vs.barPx,price:vs.price?Object.freeze({...vs.price}):null,follow,plot:Object.freeze({...plot})});
  }
  function emit(){
    if(typeof onViewChange!=='function')return;
    const v=snapshot(),key=JSON.stringify([v.rightT,v.barPx,v.price,v.follow]);
    if(key!==emitted){emitted=key;onViewChange(v);}
  }
  // Panning can leave the newest data but always keeps some candles in view.
  function clampView(){
    if(vs.rightT===null)return;
    const span=Math.max(0,plot.right-plot.left)/vs.barPx*tfMs,first=bars[0]?.t??anchor,end=anchor??vs.rightT;
    const hi=end+span*.8,lo=Math.min(first+Math.min(span,8*tfMs),hi);
    vs.rightT=clamp(vs.rightT,lo,hi);
  }
  function zoomAt(x,factor){
    if(!positive(factor))return;
    measure();
    const next=clamp(vs.barPx*factor,MIN_BAR,MAX_BAR);autoBar=false;if(next===vs.barPx)return;
    if(vs.rightT!==null){
      // Keep the time under the pointer where it is.
      const px=clamp(finite(x)?x:plot.right,plot.left,plot.right),t=timeAt(px);
      vs.rightT=t+(plot.right-px)/next*tfMs;
    }
    vs.barPx=next;clampView();invalidate();emit();
  }
  function panBy(dx,dy){
    measure();if(vs.rightT===null)return;
    if(finite(dx)&&dx){vs.rightT-=dx/vs.barPx*tfMs;follow=false;clampView();}
    if(finite(dy)&&dy&&plot.bottom>inner()){
      const r=computeRange(),k=(r.hi-r.lo)/(plot.bottom-inner());vs.price={lo:r.lo+dy*k,hi:r.hi+dy*k};
    }
    invalidate();emit();
  }
  // f > 1 magnifies around the middle of the visible prices, f < 1 shows more.
  function scalePrice(f){
    if(!positive(f)||!d||vs.rightT===null)return;
    measure();
    const r=computeRange(),mid=(r.lo+r.hi)/2,half=clamp((r.hi-r.lo)/2/f,Math.abs(mid)*1e-6||1e-12,Math.abs(mid)*20||1);
    vs.price={lo:mid-half,hi:mid+half};invalidate();emit();
  }
  function resetView(){autoBar=true;measure();vs.barPx=defaultBar();vs.price=null;follow=true;vs.rightT=anchor;auto=null;invalidate();emit();}
  // Double-click on the price axis: back to the automatic price range only, the time view stays.
  function autoPrice(){vs.price=null;auto=null;invalidate();emit();}
  function scrollToLatest(){vs.price=null;follow=true;vs.rightT=anchor;auto=null;invalidate();emit();}
  // Brings the candle at time t into view, a third from the left, when it lies outside the middle 80 % of the
  // plot (a picked signal far back). The picked signal's own candle also moves when its label, left of it, has no
  // room there, just far enough for the label; on a plot too narrow for that even at the middle the label goes right
  // of the candle and only the middle 80 % counts. The view then stays put like a pan. Returns whether the view moved.
  function reveal(t){
    measure();
    if(!d||vs.rightT===null||!finite(t))return false;
    const x=cxOf(t),w=plot.right-plot.left;
    if(!(w>0))return false;
    const need=pick?.barTime===t?labelRoom(pickLabel().w):0,room=need<=w/2?need:0;
    // Within half a pixel counts as in place, so a candle moved here stays put on the next call.
    if(x>=plot.left+Math.max(w*.1,room)-.5&&x<=plot.right-w*.1)return false;
    vs.rightT=t+(w-Math.max(w/3,room)+vs.barPx/2)/vs.barPx*tfMs;follow=false;vs.price=null;auto=null;
    clampView();invalidate();emit();return true;
  }

  function wheel(e){
    e.preventDefault?.();measure();
    const p=pos(e),k=e.deltaMode===1?16:e.deltaMode===2?Math.max(1,H):1,dx=(e.deltaX||0)*k,dy=clamp((e.deltaY||0)*k,-200,200);
    if(Math.abs(dx)>Math.abs(dy))panBy(-dx,0);
    else if(p.x>plot.right)scalePrice(Math.exp(-dy*.0015));
    else zoomAt(p.x,Math.exp(-dy*.0015));
  }
  if(typeof canvas.addEventListener==='function'){
    const on=(type,fn,opts)=>{canvas.addEventListener(type,fn,opts);listeners.push([type,fn,opts]);};
    const pointers=new Map();let pinch=null,tap=null;
    // On a phone the chart fills most of the screen: a one-finger vertical swipe is left to the browser, which
    // scrolls the view around it, while sideways drags (pan, stretch) and pinches still arrive here.
    if(canvas.style)canvas.style.touchAction='pan-y';
    if(!(canvas.tabIndex>=0))canvas.tabIndex=0;
    const zone=p=>p.x>plot.right?'price':p.y>plot.bottom?'time':'plot';
    const inPlot=p=>p.x>=plot.left&&p.x<=plot.right&&p.y>=plot.top&&p.y<=plot.bottom;
    on('pointerdown',e=>{
      if(e.pointerType==='mouse'&&e.button!==0)return;
      // No focus() here: the press focuses the canvas by itself, and a scripted focus would light the keyboard ring on every click.
      measure();
      // One level at a time, and nothing else while it moves.
      if(lv)return;
      hint=null;
      const p=pos(e),kind=e.pointerType==='touch'?null:levelHit(p);
      canvas.setPointerCapture?.(e.pointerId);
      // A mouse or pen on an SL or TP (its tag or its line) takes that level instead of the chart.
      if(kind){startLevel(kind,e.pointerId,'canvas',p,null,e.pointerType);return;}
      pointers.set(e.pointerId,p);
      if(pointers.size===1)drag={id:e.pointerId,start:p,last:p,moved:false,zone:zone(p),touch:e.pointerType==='touch'};
      else if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={dist:Math.hypot(a.x-b.x,a.y-b.y),mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};drag=pinned=null;}
    });
    on('pointermove',e=>{
      measure();const p=pos(e);
      if(lv){if(lv.source==='canvas'&&lv.pointerId===e.pointerId)moveLevel(p);return;}
      if(pointers.has(e.pointerId))pointers.set(e.pointerId,p);
      if(pinch&&pointers.size===2){
        const [a,b]=[...pointers.values()],dist=Math.hypot(a.x-b.x,a.y-b.y),mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
        if(pinch.dist>0&&dist>0)zoomAt(mid.x,dist/pinch.dist);
        panBy(mid.x-pinch.mid.x,0);pinch={dist,mid};hover=null;invalidate();return;
      }
      if(drag?.id===e.pointerId){
        if(drag.touch&&!drag.axis){
          // A finger decides once, after a few pixels: mostly vertical is the page's scroll (the browser takes the
          // touch over), mostly sideways moves the chart. A tap's jitter decides nothing.
          const dx=p.x-drag.start.x,dy=p.y-drag.start.y;
          if(Math.hypot(dx,dy)<8)return;
          drag.axis=Math.abs(dx)>=Math.abs(dy)?'x':'y';drag.moved=true;
          if(drag.axis==='x')pinned=null;
        }
        if(drag.axis==='y')return;
        // A few pixels of jitter on a click must not switch off the auto range.
        if(!drag.moved&&Math.hypot(p.x-drag.start.x,p.y-drag.start.y)<3)return;
        const dx=p.x-drag.last.x,dy=p.y-drag.last.y;drag.moved=true;drag.last=p;
        // A finger's vertical moves belong to the page, so touch never scales or pans the prices.
        if(drag.zone==='price'){if(!drag.touch)scalePrice(Math.exp(-dy*.01));}
        else if(drag.zone==='time')zoomAt(plot.right,Math.exp(dx*.01));
        else{
          // Sideways pans drift a little vertically; the price only follows after a clear vertical move,
          // so panning back in history does not switch off the automatic price range by accident.
          if(!drag.touch&&!drag.vertical&&Math.abs(p.y-drag.start.y)>14)drag.vertical=true;
          panBy(dx,drag.vertical?dy:0);setCursor('grabbing');
        }
      }
      // A finger shows the crosshair by a tap only, never under a moving finger.
      if(e.pointerType==='touch')return;
      const inside=inPlot(p);
      // Over an SL or TP that can be moved, the pointer says it moves up and down.
      if(!drag)setCursor(levelHit(p)||p.x>plot.right?'ns-resize':inside?'crosshair':'ew-resize');
      hover=inside?p:null;invalidate();
    });
    const end=e=>{
      if(lv){
        if(lv.source==='canvas'&&lv.pointerId===e.pointerId){canvas.releasePointerCapture?.(e.pointerId);if(e.type==='pointerup')void dropLevel();else cancelLevel('');}
        return;
      }
      const p=pos(e),touch=e.pointerType==='touch';
      if(e.type==='pointerup'&&touch&&drag?.id===e.pointerId&&!drag.moved){
        const at=clock();
        // Touch has no reliable dblclick: two quick taps reset the view.
        if(tap&&at-tap.at<320&&Math.hypot(p.x-tap.x,p.y-tap.y)<24){tap=null;pinned=null;resetView();}
        else{
          // A tap holds the crosshair and tooltip at its candle until the next tap; the same candle again or a tap
          // outside the plot lets go.
          tap={at,x:p.x,y:p.y};
          const t=vs.rightT===null?null:slotAt(p.x);
          pinned=t!==null&&inPlot(p)&&pinned?.t!==t?{t,y:p.y}:null;
        }
      }
      pointers.delete(e.pointerId);canvas.releasePointerCapture?.(e.pointerId);
      // Lifting one finger of a pinch hands the pan to the finger that stays.
      if(pointers.size<2&&pinch){pinch=null;const rest=[...pointers.entries()][0];
        drag=rest?{id:rest[0],start:rest[1],last:rest[1],moved:true,zone:'plot',touch,axis:touch?'x':undefined}:null;}
      if(drag?.id===e.pointerId)drag=null;
      if(!pointers.size)setCursor('crosshair');
      if(touch)hover=null;
      invalidate();
    };
    on('pointerup',end);on('pointercancel',end);
    on('pointerleave',()=>{if(!drag&&!lv){hover=null;if(hint?.until>clock())hint=null;invalidate();}});
    on('wheel',wheel,{passive:false});
    on('dblclick',e=>{e.preventDefault?.();if(lv)return;measure();if(zone(pos(e)).startsWith('price'))autoPrice();else resetView();});
    on('keydown',e=>{
      if(e.key==='Escape'&&lv){escape(e);return;}
      if(e.ctrlKey||e.metaKey||e.altKey)return;
      measure();
      const w=plot.right-plot.left,at=follow?plot.right:(plot.left+plot.right)/2;
      const act={ArrowLeft:()=>panBy(w*.1,0),ArrowRight:()=>panBy(-w*.1,0),'+':()=>zoomAt(at,1.25),'=':()=>zoomAt(at,1.25),
        '-':()=>zoomAt(at,.8),'_':()=>zoomAt(at,.8),'0':resetView,End:scrollToLatest}[e.key];
      if(!act)return;
      e.preventDefault?.();act();
    });
  }
  // The handles take any pointer that lands on them (a finger, and a mouse or pen over a tag); vertical drags there never
  // scroll the page (touch-action none). A wheel over one works as over the canvas.
  const handleListeners=[];
  if(handles&&editing)for(const kind of EDITABLE){
    const el=handles[kind];
    if(!el||typeof el.addEventListener!=='function')continue;
    if(el.style)el.style.touchAction='none';
    el.hidden=true;
    const add=(type,fn,opts)=>{el.addEventListener(type,fn,opts);handleListeners.push([el,type,fn,opts]);};
    const own=e=>!!lv&&lv.el===el&&lv.pointerId===e.pointerId;
    add('pointerdown',e=>{
      if(e.pointerType==='mouse'&&e.button!==0||lv||pending||!editId())return;
      e.preventDefault?.();measure();computeRange();
      el.setPointerCapture?.(e.pointerId);
      startLevel(kind,e.pointerId,'handle',pos(e),el,e.pointerType);
    });
    add('pointermove',e=>{if(own(e)){measure();moveLevel(pos(e));}});
    add('pointerup',e=>{if(own(e)){el.releasePointerCapture?.(e.pointerId);void dropLevel();}});
    add('pointercancel',e=>{if(own(e))cancelLevel('');});
    add('wheel',wheel,{passive:false});
  }
  const observer=typeof globalThis.ResizeObserver==='function'&&canvas.nodeType===1?new globalThis.ResizeObserver(()=>invalidate()):null;
  observer?.observe(canvas);

  function destroy(){
    destroyed=true;
    if(lv){lv=null;release();}
    for(const [type,fn,opts] of listeners)canvas.removeEventListener?.(type,fn,opts);
    for(const [el,type,fn,opts] of handleListeners){el.removeEventListener?.(type,fn,opts);el.hidden=true;}
    listeners.length=0;handleListeners.length=0;observer?.disconnect();
    if(tooltip)tooltip.hidden=true;
  }
  // The level being moved or saved, if any: {kind, price (null: removed), state:'drag'|'bad'|'pending', text}.
  function levelState(){
    if(lv)return Object.freeze({kind:lv.kind,price:lv.price,state:lv.view&&!lv.view.ok?'bad':'drag',text:lv.text??null});
    return pending?Object.freeze({kind:pending.kind,price:pending.price,state:'pending',text:pending.text}):null;
  }
  return {setData,render:()=>draw(clock()),resize:()=>draw(clock()),zoomAt,panBy,scalePrice,resetView,autoPrice,scrollToLatest,reveal,destroy,view:snapshot,hitTest,levelState};
}
