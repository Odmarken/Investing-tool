// Writes ai-forecast-results.md from .matning/ai-forecast/results.json (the
// protocol's numbers), runs.json (every trade) and the cached Bybit candles
// (one descriptive figure). Nothing here changes a result or a choice.
import {readFile,writeFile} from 'node:fs/promises';
import {DATA_DIR} from './ai-forecast-data.mjs';

const r=JSON.parse(await readFile(new URL('results.json',DATA_DIR),'utf8'));
const runs=JSON.parse(await readFile(new URL('runs.json',DATA_DIR),'utf8')).runs;
const limits=JSON.parse(await readFile(new URL('contracts.json',DATA_DIR),'utf8')).contracts;
// The first run, on 2026-10-05, before the sizing rule was corrected: its own figures (net as a fraction of the
// 100 $ start, [normal, stressed slippage]), kept so that this report can say what the correction changed.
const FIRST=Object.freeze({date:'2026-10-05',
  development:{'b20-s1.5-t2':[-.890516,-.965949],'b20-s1.5-t3':[-.736479,-.915384],'b20-s2.5-t2':[-.685228,-.84099],'b20-s2.5-t3':[-.544013,-.768226],
    'b40-s1.5-t2':[-.846801,-.944446],'b40-s1.5-t3':[-.692488,-.885901],'b40-s2.5-t2':[-.647697,-.806214],'b40-s2.5-t3':[-.432112,-.686315]},
  validation:{'b20-s1.5-t2':[-.351509,-.545927],'b20-s1.5-t3':[-.265538,-.476828],'b20-s2.5-t2':[-.07132,-.251166],'b20-s2.5-t3':[-.045047,-.22663],
    'b40-s1.5-t2':[-.222754,-.430263],'b40-s1.5-t3':[-.107184,-.3381],'b40-s2.5-t2':[.012454,-.164497],'b40-s2.5-t3':[.024028,-.149958]},
  accountDefault:{normal:{trades:99,liquidations:83,netPct:-.999412,days:20},stress:{trades:82,liquidations:72,netPct:-.999386}},
  // Every first-run trade sized on the stop although Bybit's liquidation lay beyond it, by less than 1 % of the price (near)
  // or by more (far), counted from its stored trades: how many ended in a liquidation or at the stop.
  near:{trades:136,liquidations:64,stops:16},far:{liquidations:182,stops:19194}});
// The written conclusions describe this outcome; a rerun with another outcome needs new text, not stale text.
const stale=what=>{throw Error('The report text no longer matches the results ('+what+'): update it');};
if(r.selected!==null||r.validated||r.forecast.skillPositive||!r.lookAheadFree)stale('selection, validation or forecast skill');

const dec=(x,d)=>Math.abs(x).toFixed(d).replace('.',',');
const zero=(x,d)=>+Math.abs(x).toFixed(d)===0;
const minus=(x,d)=>x<0&&!zero(x,d)?'−':'';
const pct=(x,d=1)=>x==null?'–':minus(x*100,d)+dec(x*100,d)+' %';
const chg=(x,d=1)=>x==null?'–':(zero(x*100,d)?'':x<0?'−':'+')+dec(x*100,d)+' %';
const usd=(x,d=2)=>(zero(x,d)?'':x<0?'−':'+')+dec(x,d)+' $';
const money=(x,d=2)=>minus(x,d)+dec(x,d)+' $';
const num=(x,d=2)=>x==null?'–':minus(x,d)+dec(x,d);
const int=n=>n>=1000?String(n).replace(/\B(?=(\d{3})+(?!\d))/g,' '):String(n);
const DAY=86400000,day=t=>new Date(t).toISOString().slice(0,10);
const hour=t=>new Date(t).toISOString().slice(0,16).replace('T',' ');
const row=cells=>'| '+cells.join(' | ')+' |';
const lines=[],out=s=>lines.push(s);
const lo=xs=>xs.reduce((a,b)=>Math.min(a,b)),hi=xs=>xs.reduce((a,b)=>Math.max(a,b));
// "a, b och c" (Swedish decimals contain commas, so this joins items and never splits text).
const list=xs=>xs.length>1?xs.slice(0,-1).join(', ')+' och '+xs.at(-1):xs.join('');
// A percent range with its unit once: 75–78 %.
const span=(xs,d=0)=>dec(lo(xs)*100,d)+'–'+dec(hi(xs)*100,d)+' %';
const median=xs=>{const s=Float64Array.from(xs).sort(),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const words=['noll','en','två','tre','fyra','fem','sex','sju','åtta'];
const count=n=>words[n]??String(n);

const codes=r.candidates.map(c=>c.code),def=r.defaultCode,H=r.forecast.horizons,M=r.manifest,coins=Object.keys(M.files);
const dev=k=>r.development[k],val=r.validation[def],acc=r.accountDefault,slips=r.costs;
const fc=r.forecast,fo=fc.overall.errors,skills=H.map(h=>fo[h].skill),cover80=H.map(h=>fo[h].cover80),cover50=H.map(h=>fo[h].cover50);

// Descriptive, from the stored trades: a trade's result in units of its planned stop distance (R),
// before costs (open to exit level, no slippage) and after them (the booked result).
function rStats(key,slip){
  const t=runs[key].trades;let gross=0,net=0,stop=0;
  for(const x of t){
    const dir=x.side==='long'?1:-1,open=x.entry/(1+dir*slip),risk=Math.abs(open-x.sl);
    const level=x.reason==='likvidation'?x.exit:x.exit/(1-dir*slip);
    gross+=dir*(level-open)/risk;net+=x.pnl/(x.units*risk);stop+=risk/open;
  }
  return {gross:gross/t.length,net:net/t.length,stop:stop/t.length};
}
const accRaw=runs[`accountDefault/${def}/normal`],accTrades=accRaw.trades;
const liqGaps=accTrades.map(t=>Math.abs(t.entry-t.liq)/t.entry),liqGap=median(liqGaps),stopGap=median(accTrades.map(t=>Math.abs(t.entry-t.sl)/t.entry));
const below=v=>accRaw.equityDaily.find(p=>p[1]<v)?.[0]??null;
const tooSmall=Object.entries(acc.normal.skipped).filter(([k])=>k.startsWith('Positionen blir för liten')).reduce((s,[,n])=>s+n,0);
const daysToOne=below(1)===null?null:Math.round((below(1)-r.periods.validation.from)/DAY);
// The stored curve holds UTC-midnight values, each the end of the day before; the too-small signals came after the fall under 1 $.
const smallAt=accRaw.decisions.filter(d=>String(d[4]).startsWith('Positionen blir för liten')).map(d=>d[0]);
// A typical hour of the validation year: the median high–low range of Bybit's own candles, all coins.
const ranges=[];
for(const s of coins){
  const d=JSON.parse(await readFile(new URL(M.files[s].file,DATA_DIR),'utf8'));
  for(const b of d.bars)if(b.t>=r.periods.validation.from)ranges.push((b.h-b.l)/b.o);
}
const hourRange=median(ranges),overLiq=ranges.filter(x=>x>liqGap).length/ranges.length;
const am=acc.normal.metrics,accReasons=acc.normal.reasons;
const closer=accTrades.filter(t=>Math.abs(t.entry-t.liq)<Math.abs(t.entry-t.sl)).length;
// Sized on the liquidation: it lay before the stop or less than 1 % of the price beyond it (the stored level, which funding only moves closer).
const liqFirst=accTrades.filter(t=>Math.abs(t.entry-t.liq)-Math.abs(t.entry-t.sl)<.01*t.entry).length;
// The margin's share of capital at entry: capital ≈ 100 $ + results closed by then − opening fees of positions still open.
const capitalAt=x=>100+accTrades.filter(y=>y.closedAt<=x.openedAt).reduce((s,y)=>s+y.pnl,0)-
  accTrades.filter(y=>y!==x&&y.openedAt<=x.openedAt&&y.closedAt>x.openedAt).reduce((s,y)=>s+y.units*y.entry*r.fee,0);
const marginShare=accTrades.map(x=>x.margin/capitalAt(x));
if(accReasons.stopp||daysToOne===null||[50,10,1].some(v=>below(v)===null||below(v)%DAY)||smallAt.length!==tooSmall||smallAt.some(t=>t<below(1)))stale('account default');

// ---- Summary
out('# AI Forecast: resultat');
out('');
out(`Omkörd ${day(r.generatedAt)} efter en rättelse av storleksregeln: risken per affär kunde överskridas när likvidationen låg före stoppet eller mindre än 1 % bortom det. Första körningen gjordes ${FIRST.date===day(r.generatedAt)?'samma dag':FIRST.date}, och [Omkörning](#omkörning-efter-rättelsen-av-storleksregeln) nedan säger vad som ändrades. [Protokollet](ai-forecast-protocol.md) frystes före första resultaträkningen och har inte ändrats, och urvalslåset är oförändrat i sak: samma regel och samma urval, ingen behörig kandidat. Utvecklingens urval skrevs till \`selection-lock.json\` innan någon valideringssiffra räknades. Allt räknades med AI Forecast-modulerna själva (\`forecast-model.js\`, \`forecast-account.js\` och \`forecast-backtest.js\`): samma signalregler, storleksregel, avgifter, likvidationsnivåer och händelseordning inom candlen som demokontot använder.`);
out('');
const devNets=codes.flatMap(k=>[dev(k).normal.metrics.netPct,dev(k).stress.metrics.netPct]);
out(`**Ingen kandidat blev behörig.** Alla åtta förlorade pengar på utvecklingsperioden med referensstorleken, vid både normal och stressad slippage (netto ${chg(lo(devNets))} till ${chg(hi(devNets))}). Enligt protokollet väljs då ingen: standardinställningen \`${def}\` behålls och signalreglerna \`af-signal-v1\` redovisas som **ej validerade**. Inga parametrar ändras.`);
out('');
out(`**Prognosmodellen \`af-forecast-v1\` slog inte en oförändrad-prognos** på någon horisont (skill ${list(skills.map(x=>chg(x)))} på ${list(H.map(String))} candles) och redovisas därför som en ren osäkerhetsillustration. Banden låg däremot nära sina nominella nivåer: ${span(cover80)} av de verkliga stängningarna låg inom 80 %-bandet.`);
out('');
out(`**Kontots standard tömde kontot.** Med Bybits maxhävstång, 25 % marginal och 10 % risk per affär likviderades ${am.liquidations} av ${am.trades} affärer på valideringsåret, och kapitalet var under 1 $ efter ${daysToOne} dagar. Med referensstorleken förlorade samma regler ${pct(-val.normal.metrics.netPct)} på samma år.`);
out('');
out('Resultaten är historiska och retrospektiva; de visar inte framtida avkastning.');
out('');

// ---- The re-run after the sizing correction
// The correction's example: DOGE at Bybit's top leverage, 10 $ of risk on 100 $, a stop 0,56 % from the fill, inside
// which Bybit's isolated level lies. The first run's rule sized the margin on the stop's share of it alone.
const doge=limits.DOGE.tiers[0],dL=doge.max,dStop=.0056,dLiq=(1/dL-doge.maintenance-r.fee)/(1-doge.maintenance-r.fee);
const oldMargin=10/Math.min(1,dL*(dStop+2*(r.fee+slips.normal))),oldLoss=oldMargin*(1+dL*r.fee);
if(!(dLiq<dStop)||oldLoss<=10)stale('sizing example');
// The second part's example: BTC at its top leverage, a stop 0,28 % from the fill with Bybit's level just beyond it; one
// ordinary funding of 0,01 % (paid on the position, out of the margin) moves the level in front of the stop.
const btc=limits.BTC.tiers[0],bL=btc.max,bStop=.0028,bRate=.0001,bLiq=(1/bL-btc.maintenance-r.fee)/(1-btc.maintenance-r.fee);
const bMargin=10/(bL*(bStop+2*(r.fee+slips.normal))),bFee=bMargin*bL*r.fee,bMoved=bLiq-bRate/(1-btc.maintenance-r.fee);
if(!(bLiq>bStop&&bLiq<bStop+.01&&bMoved<bStop&&bMargin+bFee>10))stale('buffer example');
const FN=FIRST.near,FF=FIRST.far;
const moved=(now,first)=>hi(codes.flatMap(k=>[0,1].map(i=>Math.abs(now(k)[i]-first[k][i]))));
const devMoved=moved(k=>[dev(k).normal.metrics.netPct,dev(k).stress.metrics.netPct],FIRST.development);
const valMoved=moved(k=>[r.validation[k].normal.metrics.netPct,r.validation[k].stress.metrics.netPct],FIRST.validation);
const sameDefault=[val.normal.metrics.netPct,val.stress.metrics.netPct].every((x,i)=>Math.abs(x-FIRST.validation[def][i])<5e-7);
const F=FIRST.accountDefault.normal,FS=FIRST.accountDefault.stress,as=acc.stress.metrics;
out('## Omkörning efter rättelsen av storleksregeln');
out('');
out(`Rättelsen har två delar. Första körningen räknade förlusten vid stoppet som min(1, L × (stoppavståndet + ${pct(2*(r.fee+slips.normal),2)})) av marginalen. Med Bybits maxhävstång ligger likvidationsnivån ofta före stoppet, och då tar en rörelse till stoppet hela marginalen plus öppningsavgiften. Med DOGE på ${dL}× och ett stopp ${pct(dStop,2)} från ingången, där likvidationen låg ${pct(dLiq,2)} bort, gav regeln ${money(oldMargin)} i marginal och en förlust på ${money(oldLoss)} i stället för 10 $ av 100 $; även när andelen var 1 kom öppningsavgiften ovanpå (${pct(150*r.fee,2)} av marginalen vid 150×). Nu räknas förlusten i det fallet som marginalen plus öppningsavgiften, 1 + L × ${pct(r.fee,3)} av marginalen.`);
out('');
out(`Det andra fallet är en likvidation strax bortom stoppet. Funding som positionen betalar medan den är öppen dras från marginalen och flyttar likvidationen närmare, och en candle som når stoppet går ofta förbi det. Med BTC på ${bL}× och ett stopp ${pct(bStop,2)} från ingången låg likvidationen ${pct(bLiq,3)} bort, alltså bortom stoppet, och regeln gav ${money(bMargin)} i marginal. En vanlig funding på ${pct(bRate,2)} flyttade likvidationen till ${pct(bMoved,3)}, före stoppet, och en rörelse till stoppet tog då hela marginalen plus ${money(bFee)} i öppningsavgift: ${money(bMargin+bFee)} i stället för 10 $. I första körningens affärer hade ${FN.trades} storlek efter stoppet fast likvidationen låg mindre än 1 % av priset bortom det; av de ${FN.liquidations+FN.stops} som slutade i stopp eller likvidation likviderades ${FN.liquidations}. Med likvidationen mer än 1 % bortom stoppet likviderades ${int(FF.liquidations)} av ${int(FF.liquidations+FF.stops)}. Nu räknas stoppet som först bara när likvidationen ligger mer än 1 % av ingångspriset bortom det; annars räknas förlusten som marginalen plus öppningsavgiften. Den procenten täcker Bybits vanliga funding (0,01 % per 8 timmar) under den längsta hålltiden, 20 dygn på dygnscandles. Förlusten vid stoppet, eller vid en likvidation före det, är därmed högst risken per affär.`);
out('');
out(`Allt räknades om ${day(r.generatedAt)} med samma data och samma protokoll. \`forecast-account.js\` och \`forecast-market.js\` har fler ändringar sedan första körningen, men de gäller demokontots skydd av öppna positioner i webbläsaren, som backtesten inte använder; för forskningen är storleksregeln den enda ändringen. **Inga slutsatser ändrades:** ingen kandidat blev behörig, ingen valdes, valideringen godkändes inte och prognosmåtten är identiska, eftersom storleken inte påverkar dem. Med referensstorleken (10×) gäller rättelsen bara affärer vars stopp låg bortom, vid eller mindre än 1 % före likvidationsnivån, och genom kapitalet affärerna efter dem: kandidaternas netto flyttade sig högst ${dec(devMoved*100,2)} procentenheter på utvecklingsperioden och ${dec(valMoved*100,2)} på valideringsåret${sameDefault?', där standardinställningen `'+def+'` gav exakt samma resultat':''}. Kontots standard ändrades mer: ${am.liquidations} av ${am.trades} affärer likviderades i stället för ${F.liquidations} av ${F.trades}, nettot blev ${chg(am.netPct,2)} i stället för ${chg(F.netPct,2)} och kapitalet var under 1 $ efter ${daysToOne} dagar i stället för ${F.days}. Med stressad slippage likviderades ${as.liquidations} av ${as.trades} affärer i stället för ${FS.liquidations} av ${FS.trades}, och nettot blev ${chg(as.netPct,2)} i stället för ${chg(FS.netPct,2)}.`);
out('');

// ---- Data
out('## Data');
out('');
out(`Bybit USDT-perpetuals (\`category=linear\`), timcandles från ${hour(M.start)} UTC (PEPE från Bybits första timcandle för kontraktet, ${hour(M.files.PEPE.first)}) till ${hour(M.end)} UTC (slut exklusivt), hämtade ${day(M.files.BTC.fetchedAt)} med sidans egna tolkare i \`forecast-market.js\`. Priser per token (SHIB och PEPE delade med 1 000) och volym som omsättning i USDT. Fundinghistoriken går till och med ${hour(M.end)}, så att en position som är öppen vid periodslut betalar den sista fundingen likadant i båda perioderna. Bybits hävstångs- och risknivåer hämtades en gång (${hour(M.contracts.fetchedAt)} UTC) och används för hela historiken.`);
out('');
out(row(['Coin','Kontrakt','Första timme','Timcandles','Fyllda timmar','Candles med noll volym','Fundingposter','Maxhävstång idag']));
out(row(['---','---','---','---:','---:','---:','---:','---:']));
for(const s of coins){const f=M.files[s];out(row([s,'`'+f.contract+'`',hour(f.first),int(f.hours),f.filled,f.zeroVolume,int(f.funding.events),r.leverageToday[s]+'×']));}
out('');
const filled=coins.reduce((n,s)=>n+M.files[s].filled,0),zeroVol=coins.reduce((n,s)=>n+M.files[s].zeroVolume,0);
const offHour=coins.reduce((n,s)=>n+M.files[s].funding.offHour,0),maxStep=hi(coins.map(s=>M.files[s].funding.maxStepHours));
const fillText=filled?'Fyllda timmar (platt candle på föregående stängning, noll volym): '+coins.filter(s=>M.files[s].filled).map(s=>s+' '+M.files[s].gaps.map(g=>hour(g.from)+' ('+g.hours+' h)').join(', ')).join('; ')+'.':
  `Bybit saknade ingen timme för något coin, så protokollets platta utfyllnad behövde aldrig användas${zeroVol?'':', och ingen candle hade noll volym'}.`;
const fundingText=offHour?`${offHour} fundingtidpunkter låg mellan hela timmar och dras vid nästa öppning.`:
  `Alla fundingtidpunkter låg på hela timmar med högst ${maxStep} timmar emellan, så med timcandles dras funding exakt vid sin tidpunkt.`;
out(fillText+' '+fundingText);
out('');

// ---- Development
out(`## Utveckling: ${day(r.periods.development.from)} till ${day(r.periods.development.to)}`);
out('');
out(`Referensstorlek: 1 % av kapitalet i förlust vid stopp (avgifter och slippage inräknade), marginal högst 25 % av kapitalet, 10× hävstång (Bybits gräns var högre för alla coin) och högst 3 positioner, en per coin. Storleken räknas med demokontots egen regel, som lägger avgift och ${pct(slips.normal,2)} slippage för båda sidor ovanpå ingångens redan försämrade pris; förlusten vid ett stopp blir därför något under 1 % av kapitalet vid normal kostnad och omkring 1 % vid stressad slippage, där samma storleksregel möter sämre fyllningar. Ligger likvidationsnivån före stoppet, eller mindre än 1 % av priset bortom det, räknas förlusten som hela marginalen plus öppningsavgiften, och den blir då precis 1 %. Varje körning startar med 100 $, så netto i procent är också netto i dollar. Max nedgång räknas på kapitalet med öppna positioner värderade till stängningen, Sharpe på dagliga avkastningar × √365. Avgifter och funding i dollar; funding är kostnad (+) eller intäkt (−). Utvecklingskörningarna fick ingen candle från valideringsåret.`);
out('');
const devTable=cost=>{
  out(row(['Kandidat','Affärer','Vinstandel','Netto','Vinstfaktor','Max nedgång','Sharpe','Avgifter','Funding','Likvidationer']));
  out(row(['---','---:','---:','---:','---:','---:','---:','---:','---:','---:']));
  for(const k of codes){const m=dev(k)[cost].metrics;out(row(['`'+k+'`',int(m.trades),pct(m.winRate),chg(m.netPct),num(m.profitFactor),pct(m.maxDrawdownPct),num(m.sharpe),money(m.fees),usd(m.funding),m.liquidations]));}
  out('');
};
out('### Normal kostnad: avgift 0,055 % och slippage 0,05 % per sida');
out('');
devTable('normal');
out('### Stressad slippage: 0,10 % per sida');
out('');
devTable('stress');
out(`Behörighet kräver minst ${r.minTrades} affärer och positivt netto vid både normal och stressad slippage. Alla kandidater hade minst ${int(lo(codes.map(k=>dev(k).normal.metrics.trades)))} affärer, men ingen hade positivt netto vid någon av kostnaderna. **Ingen kandidat valdes**, så urvalsregeln (högst Sharpe) behövde aldrig användas.`);
out('');
// Why 10× still liquidates: where the stop sat relative to the liquidation level (from the stored trades).
const nrange=xs=>lo(xs)===hi(xs)?String(lo(xs)):lo(xs)+'–'+hi(xs);
const liqOf=k=>{const t=runs[`development/${k}/normal`].trades,L=t.filter(x=>x.reason==='likvidation');
  return {n:L.length,beyond:L.filter(x=>Math.abs(x.entry-x.sl)>=Math.abs(x.entry-x.liq)).length,gaps:t.map(x=>Math.abs(x.entry-x.liq)/x.entry)};};
const wide=codes.filter(k=>r.candidates.find(c=>c.code===k).slAtr===2.5).map(liqOf),tight=codes.filter(k=>r.candidates.find(c=>c.code===k).slAtr===1.5).map(liqOf);
out(`Likvidationer med 10×: likvidationsnivån ligger då i median ${pct(median([...wide,...tight].flatMap(x=>x.gaps)),1)} från ingången. På volatila coin låg ett stopp på 2,5 × ATR ibland ännu längre bort, och då kommer likvidationen alltid först: ${nrange(wide.map(x=>x.beyond))} av ${nrange(wide.map(x=>x.n))} likvidationer för de kandidaterna, mot ${nrange(tight.map(x=>x.beyond))} av ${nrange(tight.map(x=>x.n))} med 1,5 × ATR. I övriga fall passerade priset både stoppet och likvidationsnivån inom samma timme, och protokollet prövar likvidation först. En likvidation tar hela positionens marginal i stället för förlusten vid stoppet.`);
out('');

// ---- Validation
const vm=val.normal.metrics,vs=val.stress.metrics;
out(`## Validering: ${day(r.periods.validation.from)} till ${day(r.periods.validation.to)}`);
out('');
out(`Eftersom ingen kandidat valdes finns det inget att godkänna. Tabellerna beskriver standardinställningen \`${def}\`, som behålls, med referensstorlek: en sammanhängande körning från 100 $ utan positioner från utvecklingen, redovisad per kalenderkvartal. En affär räknas i kvartalet den öppnades; nedgång och Sharpe kommer från kapitalkurvan inom kvartalet och netto i procent är av kvartalets startkapital. Godkännandekravet hade inte heller uppfyllts: netto ${chg(vm.netPct)} och vinstfaktor ${num(vm.profitFactor)} vid normal kostnad, ${chg(vs.netPct)} och ${num(vs.profitFactor)} vid stressad.`);
out('');
const quarterTable=run=>{
  out(row(['Kvartal','Affärer','Vinstandel','Netto','Netto av startkapital','Vinstfaktor','Max nedgång','Sharpe','Kapital vid start','Kapital vid slut']));
  out(row(['---','---:','---:','---:','---:','---:','---:','---:','---:','---:']));
  for(const q of run.quarters)out(row([q.label,q.trades,pct(q.winRate),usd(q.net),chg(q.netPct),num(q.profitFactor),pct(q.maxDrawdownPct),num(q.sharpe),money(q.startEquity),money(q.endEquity)]));
  const m=run.metrics;
  out(row(['**Hela året**',m.trades,pct(m.winRate),usd(m.net),chg(m.netPct),num(m.profitFactor),pct(m.maxDrawdownPct),num(m.sharpe),money(100),money(100+m.net)]));
  out('');
};
out('### Normal kostnad');
out('');
quarterTable(val.normal);
out('### Stressad slippage');
out('');
quarterTable(val.stress);
const upQ=val.normal.quarters.filter(q=>q.net>0).map(q=>q.label);
if(val.normal.quarters.some(q=>q.liquidations)||vm.net>=0)stale('validation quarters');
out(`${count(upQ.length)[0].toUpperCase()+count(upQ.length).slice(1)} av fyra kvartal var lönsamma vid normal kostnad (${list(upQ)}), men förlusterna i de andra var större. Ingen av affärerna likviderades.`);
out('');
out('### Per coin (normal kostnad)');
out('');
out('Bidrag till samma konto på 100 $. Kursändringen är priset från första timmens öppning till sista stängningen, utan avgifter och funding.');
out('');
out(row(['Coin','Affärer','Vinstandel','Netto','Vinstfaktor','Avgifter','Funding','Kursändring']));
out(row(['---','---:','---:','---:','---:','---:','---:','---:']));
for(const s of coins){const m=val.normal.bySymbol[s];out(row([s,m.trades,pct(m.winRate),usd(m.net),num(m.profitFactor),money(m.fees),usd(m.funding),chg(r.priceChange.validation[s].change,0)]));}
out('');
const changes=coins.map(s=>r.priceChange.validation[s].change),best=coins.reduce((a,s)=>val.normal.bySymbol[s].net>val.normal.bySymbol[a].net?s:a);
if(hi(changes)>=0)stale('price changes');
out(`Alla sju coin föll under valideringsåret (${chg(lo(changes),0)} till ${chg(hi(changes),0)}). Reglerna handlar både långt och kort, men inget coin gav mer än ${usd(val.normal.bySymbol[best].net)} (${best}).`);
out('');
out('### Alla kandidater på valideringsåret');
out('');
out('Räknade efter låset, bara för öppenhet; de påverkar inget val.');
out('');
out(row(['Kandidat','Affärer','Netto','Vinstfaktor','Max nedgång','Sharpe','Netto, stress','Vinstfaktor, stress']));
out(row(['---','---:','---:','---:','---:','---:','---:','---:']));
for(const k of codes){const m=r.validation[k].normal.metrics,s=r.validation[k].stress.metrics;out(row([(k===def?'**`'+k+'`**':'`'+k+'`'),m.trades,chg(m.netPct),num(m.profitFactor),pct(m.maxDrawdownPct),num(m.sharpe),chg(s.netPct),num(s.profitFactor)]));}
out('');
const plus=codes.filter(k=>r.validation[k].normal.metrics.net>0);
if(codes.some(k=>r.validation[k].stress.metrics.net>0))stale('validation of all candidates');
out(`${plus.length?list(plus.map(k=>'`'+k+'`'))+' var svagt positiva vid normal kostnad ('+list(plus.map(k=>chg(r.validation[k].normal.metrics.netPct)))+') men förlorade vid stressad slippage. ':''}Ingen kandidat hade positivt netto vid stressad slippage på valideringsåret heller.`);
out('');

// ---- Account default
out('## Samma år med kontots standard');
out('');
out(`Beskrivande, påverkar inget val. Demokontot startar med Bybits maxhävstång för coinet och storleken, marginal högst 25 % av kapitalet, risk 10 % per affär och högst 3 positioner. Här samma regler (\`${def}\`), samma år och samma kostnader, en sammanhängande körning från 100 $.`);
out('');
out(row(['Kostnad','Affärer','Vinstandel','Netto','Vinstfaktor','Max nedgång','Likvidationer','Snitthävstång','Kapital vid slut']));
out(row(['---','---:','---:','---:','---:','---:','---:','---:','---:']));
for(const [label,run] of [['Normal',acc.normal],['Stressad slippage',acc.stress]]){const m=run.metrics;out(row([label,m.trades,pct(m.winRate),chg(m.netPct,2),num(m.profitFactor),pct(m.maxDrawdownPct,2),m.liquidations,num(run.avgLeverage,0)+'×',money(100+m.net)]));}
out('');
out(row(['Kvartal (normal)','Affärer','Likvidationer','Kapital vid start','Kapital vid slut']));
out(row(['---','---:','---:','---:','---:']));
for(const q of acc.normal.quarters)out(row([q.label,q.trades,q.liquidations,money(q.startEquity),money(q.endEquity)]));
out('');
const topCoins=coins.filter(s=>r.leverageToday[s]===acc.normal.maxLeverage);
out(`Med maxhävstång (i snitt ${num(acc.normal.avgLeverage,0)}×, upp till ${acc.normal.maxLeverage}× för ${list(topCoins)}) låg likvidationsnivån i median ${pct(liqGap,2)} från ingångspriset (${span(liqGaps,2)}), medan stoppet låg ${pct(stopGap,2)} bort. En timcandle spände i median ${pct(hourRange,2)} mellan högsta och lägsta på valideringsåret, och ${pct(overLiq,0)} av timmarna spände mer än ${pct(liqGap,2)}. Likvidationsnivån låg närmare än stoppet i ${closer} av ${am.trades} affärer, och ingen affär nådde stoppet: ${am.liquidations} likviderades, ${accReasons.mål??0} nådde målet och ${accReasons.tid??0} stängdes på tid. Marginalen var i median ${pct(median(marginShare),1)} av kapitalet vid ingången (${span(marginShare,1)}). ${liqFirst===closer?'Med likvidationen före stoppet':'Med likvidationen före stoppet eller mindre än 1 % bortom det, som i '+liqFirst+' av '+am.trades+' affärer,'} var marginalen högst 10 % / (1 + L × ${pct(r.fee,3)}) av kapitalet, så att en likvidation tog högst 10 % med öppningsavgiften. Vid dygnets slut (UTC) var kapitalet under 50 $ den ${day(below(50)-DAY)}, under 10 $ den ${day(below(10)-DAY)} och under 1 $ den ${day(below(1)-DAY)}; därefter var ${tooSmall} signaler för små för att handlas (marginal under 0,01 $). Med referensstorleken (10×, 1 % risk) förlorade samma regler ${pct(-vm.netPct)} på samma år, utan likvidationer.`);
out('');

// ---- Forecast
const fq=fc.quarters,fall=fc.overall;
out('## Prognosmodellen `af-forecast-v1`');
out('');
out(`Analogmodellen (k = ${fc.params.k} närmaste lägen, bibliotek ${int(fc.params.train)} timmar, horisont upp till ${fc.params.horizon}) fick i varje kvartal bara de ${int(fc.params.train)} timmar som slutade före kvartalet, och analogernas utfall låg också före kvartalet. Prognoser gjordes var ${fc.stride===4?'fjärde':fc.stride+':e'} timme per coin: ${int(fall.cutoffs)} prognospunkter, ${fall.failed?'varav '+fall.failed+' saknade tillräcklig historik':'och ingen saknade tillräcklig historik'}. De sista punkterna före ${day(r.periods.validation.to)} saknar utfall på längre horisonter och räknas inte.`);
out('');
out('Fel räknas i procent av priset vid prognosen. Skill = 1 − (medianbanans medelfel / medelfelet för ett oförändrat pris); positiv skill betyder att medianen slog ett oförändrat pris. Riktning räknas när medianen pekar upp eller ned, och en oförändrad verklig stängning räknas som fel. Scenariot är det ritade gråa förloppet (en enskild analog). Coinen vägs ihop med summor, så volatila coin väger mer.');
out('');
out(row(['Horisont','Kvartal','Prognoser','Medianens fel','Oförändrat pris, fel','Skill','Rätt riktning','Inom 50 %-bandet','Inom 80 %-bandet','Scenariots fel']));
out(row(['---:','---','---:','---:','---:','---:','---:','---:','---:','---:']));
for(const h of H){
  for(const q of fq){const e=q.errors[h];out(row([h,q.label,int(e.n),pct(e.mae,2),pct(e.naiveMae,2),chg(e.skill),pct(e.dirHit),pct(e.cover50),pct(e.cover80),pct(e.scenarioMae,2)]));}
  const e=fall.errors[h];out(row(['**'+h+'**','**Hela året**',int(e.n),pct(e.mae,2),pct(e.naiveMae,2),'**'+chg(e.skill)+'**',pct(e.dirHit),pct(e.cover50),pct(e.cover80),pct(e.scenarioMae,2)]));
}
out('');
const cells=[...fq,fall].flatMap(q=>H.map(h=>q.errors[h])),coinCells=coins.flatMap(s=>H.map(h=>fc.bySymbol[s].errors[h]));
if([...cells,...coinCells].some(e=>e.skill>=0||e.scenarioMae<=e.mae))stale('forecast quarters');
out(`Skill var negativ i alla fyra kvartal, på alla tre horisonterna och för vart och ett av de sju coinen (tabellen nedan): medianbanan missade mer än ett oförändrat pris. Andelen rätt riktning låg mellan ${pct(lo(cells.map(e=>e.dirHit)))} och ${pct(hi(cells.map(e=>e.dirHit)))} per kvartal och horisont och mellan ${pct(lo(coinCells.map(e=>e.dirHit)))} och ${pct(hi(coinCells.map(e=>e.dirHit)))} per coin och horisont, alltså på slumpens nivå. Scenariot hade större fel än medianen i varje kvartal, för varje coin och över året. Banden var ungefär kalibrerade: över året innehöll 50 %-bandet ${span(cover50)} och 80 %-bandet ${span(cover80)} av de verkliga stängningarna. **Modellen redovisas därför som en ren osäkerhetsillustration**, inte som en prognos med träffsäkerhet.`);
out('');
out(row(['Coin',...H.map(h=>'Skill '+h),'Rätt riktning (20)','Inom 80 % (20)']));
out(row(['---',...H.map(()=>'---:'),'---:','---:']));
for(const s of coins){const e=fc.bySymbol[s].errors;out(row([s,...H.map(h=>chg(e[h].skill)),pct(e[20].dirHit),pct(e[20].cover80)]));}
out('');
const eng=val.normal.engineForecast;
out(`Kontroll: motorns egen \`walkForward\` delar året i fyra lika långa fönster på 2 190 timmar i stället för kalenderkvartal. Den ger samma handel för året och skill ${list(H.map(h=>chg(eng[h].skill)))}.`);
out('');

// ---- Descriptive: before and after costs
out('## Beskrivande tillägg efter resultaten: före och efter kostnader');
out('');
out('Räknat efter resultaten för att förstå förlusterna; det används inte för något val. R är en affärs resultat i enheter av det planerade stoppavståndet (från ingångscandlens öppning till stoppet). Före kostnader är prisrörelsen från öppningen till utgångsnivån utan slippage; efter kostnader är affärens nettoresultat med avgifter, slippage och funding. Normal kostnad, referensstorlek.');
out('');
out(row(['Kandidat','Snittstopp utv.','Utv. före kostnader','Utv. efter kostnader','Snittstopp val.','Val. före kostnader','Val. efter kostnader']));
out(row(['---','---:','---:','---:','---:','---:','---:']));
const rs=codes.map(k=>({k,d:rStats(`development/${k}/normal`,slips.normal),v:rStats(`validation/${k}/normal`,slips.normal)}));
for(const {k,d,v} of rs)out(row(['`'+k+'`',pct(d.stop,2),num(d.gross,3)+' R',num(d.net,3)+' R',pct(v.stop,2),num(v.gross,3)+' R',num(v.net,3)+' R']));
out('');
const gross=rs.flatMap(x=>[x.d.gross,x.v.gross]),stops=rs.flatMap(x=>[x.d.stop,x.v.stop]),trip=2*(r.fee+slips.normal);
const devLoss=rs.filter(x=>x.d.net<0).length,valLoss=rs.filter(x=>x.v.net<0).length;
const perYear=Math.round(dev(def).normal.metrics.trades/((r.periods.development.to-r.periods.development.from)/(365.25*86400000)));
// "Wider" variants (longer breakout, wider stop, farther target) lost less on development in every pair.
const pairs=[['b20','b40'],['s1.5','s2.5'],['t2','t3']].flatMap(([a,b])=>codes.filter(k=>k.includes(a)).map(k=>[k,k.replace(a,b)]));
if(lo(gross)<=0||devLoss!==codes.length||pairs.some(([a,b])=>dev(b).normal.metrics.net<=dev(a).normal.metrics.net))stale('costs');
out(`Före kostnader var genomsnittsaffären svagt positiv för varje kandidat (${num(lo(gross),3)} till ${num(hi(gross),3)} R per affär). En rundtur kostar ${pct(trip,2)} av priset (avgift och slippage på båda sidor), vilket är ${num(trip/hi(stops),2)}–${num(trip/lo(stops),2)} R med stopp ${span(stops,1)} bort. Kostnaderna var större än det genomsnittet för alla åtta kandidater på utvecklingsperioden och för ${count(valLoss)} av åtta på valideringsåret, och med omkring ${perYear} affärer per år (\`${def}\`) blir det stora förluster. Längre utbrottsfönster, bredare stopp och mål längre bort minskade förlusten på utvecklingsperioden i varje jämförbart par, men vände den inte.`);
out('');

// ---- Conclusion
const D=r.candidates.find(c=>c.code===def);
out('## Slutsats');
out('');
out(`- **Signalreglerna har ingen visad fördel efter kostnader.** Ingen kandidat klarade utvecklingskravet, och på valideringsåret hade ingen positivt netto vid stressad slippage. Före kostnader var genomsnittsaffären svagt positiv, men timhandel med stopp ${span(stops,1)} bort betalar mer i avgifter och slippage än så. Signalerna kan fortfarande visas och förklaras i grafen, men de är inte en lönsam strategi enligt detta test.`);
out(`- **Inga parametrar ändras.** \`SIGNAL_PARAMS\` behåller standardinställningen \`${def}\` (utbrott ${D.breakout} candles, stopp ${num(D.slAtr,1)} × ATR, mål ${D.tpR} × stoppavståndet), och strategin är ej validerad.`);
out(`- **Kontots standardinställning tömde kontot på dessa regler.** Med Bybits maxhävstång låg likvidationen närmare än stoppet i ${closer} av ${am.trades} affärer; ${am.liquidations} likviderades och kapitalet gick från 100 $ till under 1 $ på ${daysToOne} dagar. Samma regler med 10× och 1 % risk förlorade ${pct(-vm.netPct)} på samma år. Det är skillnaden mellan en förlorande strategi och ett tömt konto.`);
out('- **Prognosen visar spridningen, inte riktningen.** Medianbanan var sämre än ett oförändrat pris på alla horisonter och riktningen träffade som slumpen. Bandet är ungefär rätt brett och är den användbara delen: det visar hur mycket priset brukar röra sig, inte vart det går.');
out('');

// ---- Limitations
out('## Begränsningar');
out('');
out('- **Retrospektivt.** Valideringsåret har delvis setts i projektets tidigare forskning om andra strategier, och de sju coinen är dagens noterade kontrakt, valda i efterhand.');
// Every reference trade got exactly 10×: today's limits never capped it, but their maintenance margin sets the liquidation level.
if(codes.some(k=>['normal','stress'].some(c=>[dev(k)[c],r.validation[k][c]].some(x=>x.avgLeverage!==10||x.maxLeverage!==10))))stale('reference leverage');
out('- **Bybits nuvarande hävstångs- och risknivåer** används för hela historiken; historiska nivåer är inte publicerade. Med referensstorleken begränsade de aldrig hävstången (alla affärer fick 10×), men dagens underhållsmarginal bestämmer var likvidationen ligger. Med kontots standard avgör nivåerna dessutom hävstången.');
out(`- **Likvidation** prövas mot candlens sämsta pris i senaste handel, vilket är strängare än Bybits markpris; historiska markpriser användes inte. Med maxhävstång låg likvidationsnivån i median ${pct(liqGap,2)} från ingången, medan en timcandle i median spände ${pct(hourRange,2)} mellan högsta och lägsta.`);
out('- **Timupplösning.** Beslut, fyllning, stopp och mål prövas på timcandles. En candle som når både stopp och mål räknas som stopp. Ingen orderbok, minsta orderstorlek eller orderavrundning.');
out('- **Väntetid.** De 5 candlerna räknas, som i motorn, från varje candle där alla villkor uppfylldes åt samma håll, även en candle som själv låg i väntetid. En utdragen trend ger därför något färre nya signaler än om bara utlösta signaler räknades.');
out(`- **Funding** dras exakt vid sina tidpunkter men var liten (under ${Math.ceil(hi(codes.map(k=>Math.abs(dev(k).normal.metrics.funding))))} $ per kandidat på utvecklingsperioden), eftersom affärerna var korta och både långa och korta. Kostnaderna kommer nästan helt från avgifter och slippage.`);
out('- **Kalenderkvartal.** Protokollets fyra kvartal räknades som kalenderkvartal ur den sammanhängande körningen med motorns `metricsOf` och `forecastErrors`; motorns `walkForward` använder fyra lika långa fönster. Handeln för året är densamma och prognosmåtten skiljer sig obetydligt (se kontrollen ovan).');
out('');

// ---- Reproduction
const h=r.hashes;
out('## Reproduktion');
out('');
out(`Kör \`node research/ai-forecast-data.mjs --download\`, \`node research/ai-forecast-run.mjs\` och \`node research/ai-forecast-report.mjs\`. Rådata, Bybits gränser, urvalslåset, sammanfattningen (\`results.json\`) och varje affär och signalbeslut (\`runs.json\`) sparas lokalt i \`.matning/ai-forecast/\`, som git ignorerar. Körskriptet kontrollerar att utvecklingsresultatet för \`${def}\` blir identiskt när valideringsårets data finns med (inget framtidsläckage) och att kvartalen summerar till året. En andra körning gav identiska resultat. Hasharna räknas på filernas text med LF-radslut, så en Windows-utcheckning med CRLF ger samma värden.`);
out('');
out(row(['Fil','SHA-256']));
out(row(['---','---']));
out(row(['Protokoll (`ai-forecast-protocol.md`)',h.protocol]));
out(row(['Körskript (`ai-forecast-run.mjs`)',h.run]));
for(const [f,x] of Object.entries(h.engine))out(row(['`'+f+'`',x]));
for(const [s,x] of Object.entries(h.data))out(row(['Bybit '+s+' (`'+M.files[s].file+'`)',x]));
out(row(['Bybits gränser (`contracts.json`)',h.contracts]));
out('');
out('Källor: [Bybit kline](https://bybit-exchange.github.io/docs/v5/market/kline), [Bybit funding](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate), [Bybit risknivåer](https://bybit-exchange.github.io/docs/v5/market/risk-limit), [Bybit instrument](https://bybit-exchange.github.io/docs/v5/market/instrument). ADX och ATR enligt J. Welles Wilder, *New Concepts in Technical Trading Systems* (1978).');
await writeFile(new URL('ai-forecast-results.md',import.meta.url),lines.join('\n')+'\n');
console.log('wrote research/ai-forecast-results.md');
