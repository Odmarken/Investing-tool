// Pablo's "✦ Rita" in simulation. Cut points in the hourly Bybit history after
// Opus 5.5's knowledge cutoff (June 2026), so Pablo cannot remember what came
// next. At each cut point a strategy builds the question from the same material
// the chart sends (the last 60 closed candles, the af-signal-v1 evaluation and
// the af-forecast-v1 bands), Claude Code answers on Opus 5.5 with no tools —
// exactly like the app's bridge — and the drawn candles are scored against the
// candles that really came.
//
// Run it with research/pablo-rita-run.mjs:
//   node research/pablo-rita-run.mjs --strategy research/pablo-rita-strategies/baseline.mjs --set dev [--n 30] [--concurrency 3]
//   node research/pablo-rita-run.mjs --baselines --set dev        (flat price, momentum and the AI Forecast scenario; no Claude)
//
// A strategy is a module whose default export is {name, description, system?, prompt(material) → string, parse?(text, material) → candles}.
// Answers are cached in .matning/pablo-rita/cache by the exact question, so a rerun costs nothing; runs land in .matning/pablo-rita/runs.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loadForecastData,sha,HOUR} from './ai-forecast-data.mjs';
import {TF,SIGNAL_PARAMS,FORECAST_PARAMS} from '../forecast-config.js';
import {aggregateClosed,evaluateBar,forecastFeatures,forecastAt} from '../forecast-model.js';
import {REGIME_LABELS,priceDecimals} from '../forecast-chart.js';
import {createSketchReader} from '../claude-sketch.js';
import {findClaude,readLine} from '../electron/claude-bridge.js';

export const MODEL='claude-opus-5-5';
export const N=10;                                  // the chart's default horizon: ten candles
export const SETS=Object.freeze({                   // disjoint date ranges, both after the model's knowledge cutoff
  dev:{from:Date.UTC(2026,6,1),to:Date.UTC(2026,7,15)},
  test:{from:Date.UTC(2026,7,16),to:Date.UTC(2026,8,28)}
});
export const SYMBOLS=Object.freeze(['BTC','ETH','SOL','XRP','DOGE']);
export const TFS=Object.freeze(['1h','4h']);
const DIR=new URL('../.matning/pablo-rita/',import.meta.url);
// The chart's research note under the forecast (forecast-ui.js RESEARCH.forecast), sent with every question.
const RESEARCH_FORECAST='Uppmätt historik: i forskningens test utanför träningsdatan, okt 2025–sep 2026 på timcandles, var modellen inte bättre än ett oförändrat pris (skill −3,3 %, −4,0 % och −6,4 % på 5, 10 och 20 candles), och riktningen stämde på slumpens nivå. De grå candlerna visar därför ett möjligt förlopp och bandet den vanliga spridningen, inte en förutsägelse. 80 %-bandet rymde 75–78 % av stängningarna.';
const time=t=>new Date(t).toISOString().slice(0,16).replace('T',' ');

// A small seeded generator, so a set is the same cut points every run.
function rng(seed){let s=seed>>>0;return()=>{s=(s+0x6D2B79F5)>>>0;let t=s;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}

let data=null;
const series=new Map();       // symbol|tf → {bars, features}
async function seriesOf(symbol,tf){
  const key=symbol+'|'+tf;
  if(series.has(key))return series.get(key);
  data??=await loadForecastData();
  const hourly=data.series[symbol].bars;
  const bars=tf==='1h'?hourly:aggregateClosed(hourly,'1h',tf,hourly.at(-1).t+HOUR);
  const s={bars,features:forecastFeatures(bars)};
  series.set(key,s);
  return s;
}

/* The set's cut points: n of them, spread over the symbols and timeframes, each with N candles after it inside the data. */
export async function samples(set='dev',n=30,seed=7){
  const range=SETS[set];
  if(!range)throw Error('Okänd mängd: '+set);
  const r=rng(seed+(set==='test'?1000:0)),out=[],seen=new Set();
  for(let k=0;out.length<n&&k<n*50;k++){
    const symbol=SYMBOLS[out.length%SYMBOLS.length],tf=TFS[Math.floor(out.length/SYMBOLS.length)%TFS.length];
    const {bars}=await seriesOf(symbol,tf),T=TF[tf];
    const t=range.from+Math.floor(r()*(range.to-range.from)/T.ms)*T.ms;
    const c=bars.findIndex(b=>b.t===t);
    if(c<200||c+N>=bars.length||seen.has(symbol+tf+c))continue;
    seen.add(symbol+tf+c);
    out.push({id:`${set}-${String(out.length).padStart(3,'0')}-${symbol}-${tf}-${time(t).replace(/[ :]/g,'')}`,symbol,tf,c});
  }
  return out;
}

/* Everything a strategy may use at a cut point. The future is kept apart for the scoring and never reaches a prompt. */
export async function material(sample){
  const {symbol,tf,c}=sample,T=TF[tf],{bars,features}=await seriesOf(symbol,tf);
  const last=bars[c],base=last.c,dec=priceDecimals(base),start=last.t+T.ms;
  const history=bars.slice(Math.max(0,c-299),c+1);
  let evaluation=null,forecast=null;
  try{evaluation=evaluateBar(bars.slice(0,c+1),c,{tf,params:SIGNAL_PARAMS});}catch{/* för kort historik */}
  try{const f=forecastAt(bars,c,{tf,params:FORECAST_PARAMS,features});if(f.ok)forecast=f;}catch{/* ingen prognos */}
  const m={symbol,tf,tfLabel:T.label,tfMs:T.ms,n:N,base,dec,start,now:start,history,evaluation,forecast,
    from:time(start),price:+base.toFixed(dec)};
  m.context=chartContext(m);
  Object.defineProperty(m,'future',{value:bars.slice(c+1,c+1+N),enumerable:false});
  return m;
}

/* The chart's chartContext() text (forecast-ui.js) at the cut point, without an account: the app's own question material. */
export function chartContext(m){
  const {symbol,tfLabel,dec,history,evaluation:e,forecast:f,now}=m,p=x=>Number.isFinite(x)?x.toFixed(dec):'–';
  const ohlc=b=>`${time(b.t)} ${p(b.o)} ${p(b.h)} ${p(b.l)} ${p(b.c)}${Number.isFinite(b.v)?' '+Math.round(b.v):''}`;
  const bars=history.slice(-60);
  const lines=[`AI Forecast-grafen: ${symbol}USDT perpetual på Bybit, tidsram ${tfLabel}, nu ${time(now)} UTC. Datastatus: live.`];
  lines.push(`Senaste ${bars.length} stängda candles (start UTC, open high low close volym):`,...bars.map(ohlc));
  if(e){
    lines.push(`Signalregeln af-signal-v1 på senaste stängda candle: ${e.side==='long'?'KÖP':e.side==='short'?'SÄLJ':'ingen signal'}, regim ${REGIME_LABELS[e.regime]??e.regime}.`+
      (e.side?` Entry ${p(e.entry)}, SL ${p(e.sl)}, TP ${p(e.tp)}.`:''));
    if(Array.isArray(e.checks))lines.push('Villkor: '+e.checks.map(c=>`${c.label} ${c.ok?'✓':'–'}`).join(', ')+'.');
    if(Array.isArray(e.explanation)&&e.explanation.length)lines.push('Förklaring: '+e.explanation.join(' · '));
  }
  if(f?.bands?.length){
    const bands=f.bands.slice(0,m.n);
    lines.push(`Senaste prognosen (${f.model}, data t.o.m. ${time(f.cutoff)} UTC, ${bands.length} candles framåt; median och 10–90 %-band):`,
      ...bands.map(b=>`${time(b.t)} median ${p(b.q50)} · ${p(b.q10)}–${p(b.q90)}`));
  }
  lines.push(`Inga öppna demopositioner i ${symbol}.`,RESEARCH_FORECAST);
  return lines.join('\n');
}

/* The bridge's system prompt for ✦ Rita before this research, kept for the same reason as appPrompt below. */
export const OLD_SKETCH_SYSTEM=[
  'Du är Claude, inbyggd i Riptide: användarens privata hobbyapp för kryptohandel med demokonton.',
  'Du ritar en gissning på de kommande candlarna i en graf. Läs underlaget noga: trend, nivåer, volatilitet och candlarnas storlek.',
  'Håll candlarna realistiska i storlek för tidsramen. Följ svarsformatet exakt — appen ritar raderna direkt.'
].join(' ');

/* The app's question before this research (claude-sketch.js sketchPrompt, replaced by ritaPrompt in Oct 2026), kept here
   word for word so the baseline and the strategies built on it rerun from the cache. */
export function appPrompt(m){
  return [
    `Underlag från Riptide-appen:\n${m.context}`,
    `Rita din bästa gissning på de ${m.n} kommande candlarna för ${m.symbol}USDT på ${m.tfLabel}, från senaste priset ${m.price}. Den första börjar ${m.from} UTC, direkt efter den pågående candlen.`,
    'Svara exakt så här och inget annat:',
    'Rad 1: en kort mening på svenska om vad du ser och varför (högst 200 tecken).',
    `Rad 2–${m.n+1}: en candle per rad i tidsordning: open high low close, med punkt som decimaltecken och utan tusentalsavgränsare.`
  ].join('\n\n');
}
/* The app's own reader: a sentence, then one candle per line. */
export function readCandles(text,m){
  const r=createSketchReader({base:m.base,start:m.start,tfMs:m.tfMs,n:m.n});
  r.feed(String(text||''));r.end();
  return {candles:r.candles,note:r.note};
}

/* One question to Claude Code exactly as the bridge's sketch(): Opus 5.5, no tools, no session, no settings or MCP servers. */
export async function ask({system=OLD_SKETCH_SYSTEM,prompt,model=MODEL,cache=true}){
  const key=sha(JSON.stringify({model,system,prompt})),file=new URL('cache/'+key+'.json',DIR);
  if(cache){try{return JSON.parse(await readFile(file,'utf8')).text;}catch{/* inte frågat än */}}
  const bin=findClaude();
  if(!bin)throw Error('Hittar inte claude.exe');
  await mkdir(new URL('work/',DIR),{recursive:true});
  const args=['-p','--output-format','stream-json','--verbose','--model',model,'--tools','','--no-session-persistence',
    '--strict-mcp-config','--setting-sources','','--system-prompt',system];
  const started=Date.now();
  const text=await new Promise((done,fail)=>{
    const child=spawn(bin,args,{cwd:fileURLToPath(new URL('work/',DIR)),windowsHide:true,env:process.env});
    let buf='',out='',result=null,error=null,err='';
    const line=l=>{const r=readLine(l);if(!r)return;if(r.delta)out+=r.delta;else if(r.error)error=r.error;else if('done' in r)result=r.done;};
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){line(buf.slice(0,i));buf=buf.slice(i+1);}});
    child.stderr.on('data',d=>{err=(err+d).slice(-1000);});
    child.on('error',fail);
    child.on('close',code=>{if(buf.trim())line(buf);if(result!==null||(!error&&code===0))done(result||out);else fail(Error(error||err.trim().split('\n').pop()||'kod '+code));});
    child.stdin.end(prompt);
  });
  await mkdir(new URL('cache/',DIR),{recursive:true});
  await writeFile(file,JSON.stringify({model,ms:Date.now()-started,at:new Date().toISOString(),text}));
  return text;
}

/* How good a drawing is against what happened. Prices relative to the last close, so coins of every size weigh alike. */
export function score(candles,m){
  const A=m.future,B=m.base,n=m.n;
  const ok=candles.length===n;
  const P=candles.length?Array.from({length:n},(_,i)=>candles[Math.min(i,candles.length-1)]):Array.from({length:n},()=>({o:B,h:B,l:B,c:B}));
  const mae=P.reduce((s,p,i)=>s+Math.abs(p.c-A[i].c),0)/n/B;
  const flat=A.reduce((s,a)=>s+Math.abs(B-a.c),0)/n/B;
  const end=(P[n-1].c-A[n-1].c)/B,move=(A[n-1].c-B)/B,drawn=(P[n-1].c-B)/B;
  const range=x=>x.reduce((s,b)=>s+(b.h-b.l),0)/x.length;
  const hit=Math.sign(drawn)===0||Math.sign(move)===0?null:Math.sign(drawn)===Math.sign(move);
  const covered=A.filter((a,i)=>a.c>=P[i].l&&a.c<=P[i].h).length/n;
  const lo=Math.min(...P.map(p=>p.l)),hi=Math.max(...P.map(p=>p.h));
  const envelope=A.filter(a=>a.c>=lo&&a.c<=hi).length/n;
  return {ok,count:candles.length,mae,flat,endErr:Math.abs(end),move,drawn,hit,rangeRatio:range(P)/range(A),covered,envelope};
}

export function summarize(rows){
  const valid=rows.filter(r=>r.score),s=valid.map(r=>r.score),hits=s.filter(x=>x.hit!==null);
  const mean=f=>s.length?s.reduce((a,x)=>a+f(x),0)/s.length:NaN;
  const med=f=>{const v=s.map(f).sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:NaN;};
  const sumMae=s.reduce((a,x)=>a+x.mae,0),sumFlat=s.reduce((a,x)=>a+x.flat,0);
  return {samples:rows.length,answered:valid.length,parsed:s.filter(x=>x.ok).length,errors:rows.filter(r=>r.error).length,
    skill:sumFlat?1-sumMae/sumFlat:NaN,                      // > 0: closer to what happened than an unchanged price
    maePct:mean(x=>x.mae)*100,flatPct:mean(x=>x.flat)*100,
    direction:hits.length?hits.filter(x=>x.hit).length/hits.length:NaN,directionN:hits.length,
    endErrMedianPct:med(x=>x.endErr)*100,rangeRatio:med(x=>x.rangeRatio),covered:mean(x=>x.covered),envelope:mean(x=>x.envelope),
    drawnMovePct:mean(x=>Math.abs(x.drawn))*100,realMovePct:mean(x=>Math.abs(x.move))*100};
}

/* The free yardsticks: an unchanged price, the last ten candles' drift carried on, and the AI Forecast scenario. */
export const BASELINES={
  flat:m=>Array.from({length:m.n},(_,i)=>({t:m.start+i*m.tfMs,o:m.base,h:m.base,l:m.base,c:m.base})),
  momentum:m=>{
    const h=m.history,k=Math.min(10,h.length-1),step=(h.at(-1).c-h.at(-1-k).c)/k,rng=h.slice(-20).reduce((s,b)=>s+b.h-b.l,0)/20;
    let prev=m.base;
    return Array.from({length:m.n},(_,i)=>{const c=m.base+step*(i+1),o=prev;prev=c;return {t:m.start+i*m.tfMs,o,h:Math.max(o,c)+rng/2,l:Math.min(o,c)-rng/2,c};});
  },
  forecast:m=>m.forecast?m.forecast.candles.slice(0,m.n).map(x=>({...x})):[]
};

async function pool(items,limit,fn){
  const out=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;out[i]=await fn(items[i],i);}}));
  return out;
}

export async function runStrategy(strategy,{set='dev',n=30,concurrency=3,log=()=>{}}={}){
  const list=await samples(set,n),rows=await pool(list,concurrency,async s=>{
    const m=await material(s);
    try{
      const prompt=strategy.prompt(m),text=await ask({system:strategy.system??OLD_SKETCH_SYSTEM,prompt});
      const {candles,note}=(strategy.parse??readCandles)(text,m);
      const r={id:s.id,note,score:score(candles,m),candles:candles.map(c=>[c.o,c.h,c.l,c.c])};
      log(`${s.id}: ${r.score.ok?'':'('+r.score.count+' candles) '}mae ${(r.score.mae*100).toFixed(2)} % vs flat ${(r.score.flat*100).toFixed(2)} %`);
      return r;
    }catch(e){log(`${s.id}: fel ${e.message}`);return {id:s.id,error:e.message};}
  });
  const result={strategy:strategy.name,description:strategy.description??'',set,n,model:MODEL,at:new Date().toISOString(),summary:summarize(rows),rows};
  await mkdir(new URL('runs/',DIR),{recursive:true});
  await writeFile(new URL(`runs/${strategy.name}-${set}.json`,DIR),JSON.stringify(result,null,1));
  return result;
}

export async function runBaselines({set='dev',n=30}={}){
  const list=await samples(set,n),ms=[];
  for(const s of list)ms.push(await material(s));
  return Object.fromEntries(Object.entries(BASELINES).map(([k,f])=>[k,summarize(ms.map((m,i)=>({id:list[i].id,score:score(f(m),m)})))]));
}

export function table(rows){
  const f=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'–';
  const head='strategi                 | svar  | skill   | MAE %  | riktning     | slutfel % | storlek | täckt';
  return [head,'-'.repeat(head.length),...rows.map(([name,s])=>
    `${name.padEnd(24)} | ${String(s.parsed).padStart(2)}/${String(s.samples).padEnd(2)} | ${f(s.skill*100,1).padStart(6)} % | ${f(s.maePct).padStart(6)} | ${f(s.direction*100,0).padStart(3)} % av ${String(s.directionN).padEnd(3)} | ${f(s.endErrMedianPct).padStart(9)} | ${f(s.rangeRatio).padStart(7)} | ${f(s.covered*100,0).padStart(3)} %`)].join('\n');
}
