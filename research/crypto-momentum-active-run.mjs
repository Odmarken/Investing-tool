import {writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {activeSignal,chooseActiveSignal,ACTIVE_PROFILES} from '../crypto-momentum-active-signal.js';
import {CONTRACTS} from '../bybit-contracts.js';
import {loadActiveData,DATA_DIR,DATA_START,sha} from './crypto-momentum-active-data.mjs';
import {openActivePosition} from '../crypto-momentum-active-execution.js';
import {liquidationPrice,leveragedValue,closeLeveraged} from '../crypto-leverage.js';

const HOUR=3600000,STEP=900000,SYMBOLS=Object.keys(CONTRACTS),FEE=.00055,RISK=.005,EXPOSURE=2;
const PERIODS={development:['2026-03-14','2026-07-01'],validation:['2026-07-01','2026-09-01'],recent:['2026-09-01','2026-09-10']};
export function hourly(bars){
  const result=[];
  for(let i=0;i<bars.length;i+=4){
    const group=bars.slice(i,i+4);assert.equal(group.length,4);assert.equal(group[0].t%HOUR,0);
    group.forEach((b,j)=>assert.equal(b.t,group[0].t+j*STEP));
    result.push({t:group[0].t,o:group[0].o,h:Math.max(...group.map(b=>b.h)),l:Math.min(...group.map(b=>b.l)),c:group[3].c,v:group.reduce((a,b)=>a+b.v,0)});
  }
  return result;
}
const quantile=(xs,q)=>{if(!xs.length)return null;const sorted=[...xs].sort((a,b)=>a-b),i=(sorted.length-1)*q,j=Math.floor(i);return sorted[j]+(sorted[Math.ceil(i)]-sorted[j])*(i-j);};
export function prepare(data){
  const hours=Object.fromEntries(SYMBOLS.map(s=>[s,hourly(data[s].price)]));
  const funding=Object.fromEntries(SYMBOLS.map(s=>[s,new Map(data[s].funding.map(r=>[r.t,r.rate]))]));
  const signals=new Map();
  return {data,hours,funding,signalAt(t,profile){
    const key=profile+':'+t;if(signals.has(key))return signals.get(key);
    const end=(t-DATA_START)/HOUR;
    const selected=chooseActiveSignal(SYMBOLS.map(s=>activeSignal(s,hours[s].slice(Math.max(0,end-80),end),t,profile)));
    signals.set(key,selected);return selected;
  }};
}
export function simulate(prepared,{profile,start,end,slip=.0005}){
  let cash=100,p=null,lastExit=-Infinity,peak=100,maxDrawdown=0,fees=0,funding=0;
  const trades=[],equity=[];
  const close=(raw,t,reason)=>{
    const price=raw*(1-slip),exitFee=p.units*price*FEE,pnl=p.units*(price-p.entry)-p.entryFee-exitFee-p.funding;
    cash+=p.units*(price-p.entry)-exitFee;fees+=exitFee;
    trades.push({...p,exit:price,exitAt:t,reason,pnl,r:pnl/p.risk,hours:(t-p.entryAt)/HOUR,exitFee});
    lastExit=t;p=null;
  };
  for(let t=start;t<end;t+=STEP){
    const i=(t-DATA_START)/STEP;
    if(p){
      const b=prepared.data[p.symbol].mark[i],mark=b,rate=prepared.funding[p.symbol].get(t);
      if(rate!==undefined&&p.entryAt<t){const cost=p.units*mark.o*rate;p.funding+=cost;cash-=cost;funding+=cost;}
      if(b.o<=p.sl)close(b.o,t,'sl-gap');
      else if(b.o>=p.tp)close(p.tp,t,'tp');
      else if(t>=p.entryAt+p.maxHoldMs)close(b.o,t,'time');
    }
    if(!p&&t%HOUR===0&&t>=lastExit+HOUR&&cash>0){
      const s=prepared.signalAt(t,profile);
      if(s){
        assert.ok(s.at<=t);const raw=prepared.data[s.symbol].price[i].o,mark=prepared.data[s.symbol].mark[i].o,entry=raw*(1+slip),sl=raw-s.slDistance,tp=raw+s.slDistance*s.rewardMultiple;
        const stopped=sl*(1-slip),target=tp*(1-slip),riskPerUnit=entry-stopped+FEE*(entry+stopped),netRR=(target-entry-FEE*(entry+target))/riskPerUnit;
        if(sl>0&&Math.abs(raw-s.reference)<=s.slDistance*.5&&mark>sl&&mark<tp&&netRR>=1.5){
          const units=Math.min(cash*RISK/riskPerUnit,cash*EXPOSURE/entry),entryFee=units*entry*FEE;
          p={symbol:s.symbol,entryAt:t,entry,sl,tp,maxHoldMs:s.maxHoldMs,units,entryFee,funding:0,risk:units*riskPerUnit,preEquity:cash,score:s.score};
          assert.ok(p.risk<=cash*RISK+1e-9);assert.ok(units*entry<=cash*EXPOSURE+1e-9);
          cash-=entryFee;fees+=entryFee;
        }
      }
    }
    if(p){const b=prepared.data[p.symbol].mark[i];if(b.l<=p.sl)close(Math.min(b.o,p.sl),t+STEP,'sl');else if(b.h>=p.tp)close(p.tp,t+STEP,'tp');}
    if(p&&t+STEP===end)close(prepared.data[p.symbol].mark[i].c,end,'period-end');
    const value=p?cash+p.units*(prepared.data[p.symbol].mark[i].c*(1-slip)*(1-FEE)-p.entry):cash;
    peak=Math.max(peak,value);maxDrawdown=Math.max(maxDrawdown,(peak-value)/peak);equity.push([t+STEP,value]);
  }
  assert.ok(Math.abs(cash-100-trades.reduce((sum,t)=>sum+t.pnl,0))<1e-7);
  trades.forEach((tr,i)=>{if(i)assert.ok(tr.entryAt>=trades[i-1].exitAt+HOUR);assert.ok(tr.exitAt>=tr.entryAt);});
  const profits=trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0),losses=-trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0);
  return {profile,start,end,slip,startCapital:100,endCapital:cash,netPct:cash-100,trades:trades.length,meanR:trades.length?trades.reduce((a,t)=>a+t.r,0)/trades.length:null,profitFactor:losses?profits/losses:null,maxDrawdownPct:100*maxDrawdown,medianHours:quantile(trades.map(t=>t.hours),.5),p90Hours:quantile(trades.map(t=>t.hours),.9),fees,funding,coinContributions:Object.fromEntries(SYMBOLS.map(s=>[s,{trades:trades.filter(t=>t.symbol===s).length,pnl:trades.filter(t=>t.symbol===s).reduce((a,t)=>a+t.pnl,0)}])),exits:Object.fromEntries(['sl','sl-gap','tp','time','period-end'].map(r=>[r,trades.filter(t=>t.reason===r).length])),tradeLog:trades,equity};
}
export function simulateUserRisk(prepared,contracts,{profile,start,end,slip=.0005}){
  let cash=100,p=null,lastExit=-Infinity,peak=100,maxDrawdown=0,fees=0,funding=0;
  const trades=[],equity=[];
  const close=(raw,t,reason)=>{
    const closed=closeLeveraged(p,raw,t,reason==='liquidation'?'likvidation':reason);cash+=closed.cash;fees+=closed.exitFee;
    trades.push({...p,exit:closed.trade.exit,exitAt:t,reason,pnl:closed.trade.pnl,r:closed.trade.pnl/p.initialRisk,hours:(t-p.at)/HOUR,exitFee:closed.exitFee});lastExit=t;p=null;
  };
  for(let t=start;t<end;t+=STEP){
    const i=(t-DATA_START)/STEP;
    if(p){const b=prepared.data[p.symbol].mark[i],rate=prepared.funding[p.symbol].get(t);
      if(rate!==undefined&&p.at<t){const cost=p.units*b.o*rate;p.funding+=cost;funding+=cost;}
      if(b.o<=liquidationPrice(p))close(b.o,t,'liquidation');
      else if(b.o<=p.sl)close(b.o,t,'sl-gap');
      else if(b.o>=p.tp)close(p.tp,t,'tp');
      else if(liquidationPrice(p)>=p.sl)close(b.o,t,'risk');
      else if(t>=p.deadline)close(b.o,t,'time');
    }
    if(!p&&t%HOUR===0&&t>=lastExit+HOUR&&cash>0){
      const s=prepared.signalAt(t,profile);
      if(s){
        // Only the timestamp is rebased: the public tiers remain today's snapshot.
        const contract={...contracts[s.symbol],at:t};
        p=openActivePosition(cash,{price:prepared.data[s.symbol].price[i].o,mark:prepared.data[s.symbol].mark[i].o,contract},s,t,{riskFraction:.5,marginFraction:.5,liquidationBuffer:.25,fee:FEE,slip,step:STEP});
        if(p){p.symbol=s.symbol;assert.ok(p.budget<=cash*.5+1e-8);assert.ok(p.initialRisk<=cash*.5+1e-8);cash-=p.budget;fees+=p.fee;}
      }
    }
    if(p){const b=prepared.data[p.symbol].mark[i];if(b.l<=p.sl)close(Math.min(b.o,p.sl),t+STEP,'sl');else if(b.h>=p.tp)close(p.tp,t+STEP,'tp');}
    if(p&&t+STEP===end)close(prepared.data[p.symbol].mark[i].c,end,'period-end');
    const value=cash+(p?leveragedValue(p,prepared.data[p.symbol].mark[i].c):0);peak=Math.max(peak,value);maxDrawdown=Math.max(maxDrawdown,(peak-value)/peak);equity.push([t+STEP,value]);
  }
  assert.ok(Math.abs(cash-100-trades.reduce((sum,t)=>sum+t.pnl,0))<1e-7);
  trades.forEach((tr,i)=>{if(i)assert.ok(tr.at>=trades[i-1].exitAt+HOUR);});
  const profits=trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0),losses=-trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0);
  return {profile,start,end,slip,startCapital:100,endCapital:cash,netPct:cash-100,trades:trades.length,meanR:trades.length?trades.reduce((a,t)=>a+t.r,0)/trades.length:null,profitFactor:losses?profits/losses:null,maxDrawdownPct:100*maxDrawdown,medianHours:quantile(trades.map(t=>t.hours),.5),p90Hours:quantile(trades.map(t=>t.hours),.9),fees,funding,liquidations:trades.filter(t=>t.reason==='liquidation').length,minLeverage:trades.length?Math.min(...trades.map(t=>t.rules.leverage)):null,maxLeverage:trades.length?Math.max(...trades.map(t=>t.rules.leverage)):null,medianRiskPct:quantile(trades.map(t=>100*t.initialRisk/t.accountAtEntry),.5),coinContributions:Object.fromEntries(SYMBOLS.map(s=>[s,{trades:trades.filter(t=>t.symbol===s).length,pnl:trades.filter(t=>t.symbol===s).reduce((a,t)=>a+t.pnl,0)}])),tradeLog:trades,equity};
}
const summary=r=>{const {tradeLog,equity,...rest}=r;return rest;};
const signed=n=>(n>=0?'+':'')+n.toFixed(2);
const fmt=n=>n===null?'—':n.toFixed(2);
async function run(){
  const {data,manifest}=await loadActiveData();const prepared=prepare(data),results={};
  const protocol=await readFile(new URL('./crypto-momentum-active-protocol.md',import.meta.url),'utf8');
  const signal=await readFile(new URL('../crypto-momentum-active-signal.js',import.meta.url),'utf8');
  const engine=await readFile(new URL(import.meta.url),'utf8');
  for(const profile of Object.keys(ACTIVE_PROFILES))for(const slip of [.0005,.001]){
    const [start,end]=PERIODS.development.map(d=>Date.parse(d+'T00:00:00Z'));
    const r=simulate(prepared,{profile,start,end,slip});results['development:'+profile+':'+slip]=r;
    process.stdout.write('Development '+profile+' slip '+slip+': '+r.trades+' trades, '+signed(r.netPct)+'%, PF '+fmt(r.profitFactor)+'\n');
  }
  const eligible=Object.keys(ACTIVE_PROFILES).filter(p=>{const r=results['development:'+p+':0.0005'],stress=results['development:'+p+':0.001'];return r.trades>=30&&r.netPct>0&&stress.netPct>0;});
  eligible.sort((a,b)=>results['development:'+b+':0.0005'].netPct-results['development:'+a+':0.0005'].netPct||results['development:'+a+':0.0005'].maxDrawdownPct-results['development:'+b+':0.0005'].maxDrawdownPct||Object.keys(ACTIVE_PROFILES).indexOf(a)-Object.keys(ACTIVE_PROFILES).indexOf(b));
  const selected=eligible[0]??null;
  const lock={selected,eligible,at:new Date().toISOString(),protocolSha256:sha(protocol),signalSha256:sha(signal),engineSha256:sha(engine),selection:'development only; before calculating validation and September',development:Object.fromEntries(Object.entries(results).map(([k,r])=>[k,summary(r)]))};
  try{await writeFile(new URL('selection-lock.json',DATA_DIR),JSON.stringify(lock,null,2)+'\n',{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;const original=JSON.parse(await readFile(new URL('selection-lock.json',DATA_DIR),'utf8'));assert.equal(original.selected,selected,'Reproduction changed original selection');}
  process.stdout.write('SELECTION FROZEN: '+selected+'\n');
  for(const period of ['validation','recent'])for(const profile of Object.keys(ACTIVE_PROFILES))for(const slip of [.0005,.001]){
    const [start,end]=PERIODS[period].map(d=>Date.parse(d+'T00:00:00Z'));const r=simulate(prepared,{profile,start,end,slip});results[period+':'+profile+':'+slip]=r;
    process.stdout.write(period+' '+profile+' slip '+slip+': '+r.trades+' trades, '+signed(r.netPct)+'%, PF '+fmt(r.profitFactor)+'\n');
  }
  const validation=selected?results['validation:'+selected+':0.0005']:null,stress=selected?results['validation:'+selected+':0.001']:null;
  const validated=Boolean(validation&&validation.trades>=20&&validation.netPct>0&&stress.netPct>0);
  const metadata={createdAt:new Date().toISOString(),protocolSha256:sha(protocol),signalSha256:sha(signal),engineSha256:sha(engine),manifest,selected,validated,retrospective:true,untouchedHoldout:false,settings:{fee:FEE,riskFraction:RISK,maxExposure:EXPOSURE,slippage:[.0005,.001]},periods:PERIODS};
  await writeFile(new URL('results.json',DATA_DIR),JSON.stringify({metadata,results},null,2)+'\n');
  const compact=Object.fromEntries(Object.entries(results).map(([k,r])=>[k,summary(r)]));
  const artifact={...metadata,manifest:undefined,testedProfiles:Object.keys(ACTIVE_PROFILES),results:compact,rows:Object.entries(compact).map(([key,r])=>({profile:r.profile,period:key.split(':')[0],slip:r.slip,n:r.trades,returnPct:r.netPct,maxDDPct:r.maxDrawdownPct,meanR:r.meanR,pf:r.profitFactor,medianHours:r.medianHours,p90Hours:r.p90Hours})),note:'Retrospektiv jämförelse med 0,5 % SL-risk och högst 2x exponering. Inte en orörd validering eller resultat vid 50 % användarrisk. Ingen garanti om bästa strategi.'};
  await writeFile(new URL('../crypto-momentum-active-research.js',import.meta.url),'// Generated by research/crypto-momentum-active-run.mjs; no credentials or trade execution.\nexport const ACTIVE_RESEARCH = Object.freeze('+JSON.stringify(artifact,null,2)+');\n');
  const lines=['# Aktivt momentum: retrospektiv SL/TP-jämförelse','',`Körd ${metadata.createdAt}. Protokollet låstes före resultatsökning. **${selected?'Utvecklingsurvalet valde '+selected+'. '+(validated?'Kandidaten klarade den förbestämda juli–augusti-gränsen.':'Kandidaten klarade inte den förbestämda juli–augusti-gränsen.'):'Ingen av de tre profilerna klarade utvecklingskraven; ingen lönsam kandidat valdes.'}**`,'','Resultaten använder 0,5 % risk vid vanlig SL inklusive antagna kostnader, högst 2× exponering och 100 dollar per separat period. De motsvarar inte användarens 50 % risk. Den kronologiska valideringen är retrospektiv: samma datum har tidigare studerats på spotdata. Ingen profil ändrades eller valdes om efter valideringen.','','## Resultat','', '| Period | Profil | Slippage/sida | Avslut | Netto | Netto-R/affär | PF | Max nedgång | Hålltid median / p90 |','|---|---|---:|---:|---:|---:|---:|---:|---:|'];
  for(const [key,r] of Object.entries(results))lines.push(`| ${key.split(':')[0]} | ${r.profile} | ${(r.slip*100).toFixed(2)} % | ${r.trades} | ${signed(r.netPct)} % | ${fmt(r.meanR)} | ${fmt(r.profitFactor)} | ${fmt(r.maxDrawdownPct)} % | ${fmt(r.medianHours)} / ${fmt(r.p90Hours)} h |`);
  lines.push('','Utveckling: 14 mars–30 juni. Validering: 1 juli–31 augusti. Recent: 1–9 september, endast beskrivande. Varje delperiod startar från 100 dollar. PF baseras på nettotraders vinster/förluster.','', '## Coinbidrag vid normal slippage','', '| Period | Profil | BTC | ETH | SOL | XRP | DOGE | SHIB | PEPE |','|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for(const [key,r] of Object.entries(results).filter(([,r])=>r.slip===.0005))lines.push(`| ${key.split(':')[0]} | ${r.profile} | ${SYMBOLS.map(s=>signed(r.coinContributions[s].pnl)+' $ ('+r.coinContributions[s].trades+')').join(' | ')} |`);
  lines.push('','## Avslut och kostnader vid normal slippage','','| Period | Profil | SL / gap-SL | TP | Tid | Periodslut | Avgifter | Fundingkostnad |','|---|---|---:|---:|---:|---:|---:|---:|');
  for(const [key,r] of Object.entries(results).filter(([,r])=>r.slip===.0005))lines.push(`| ${key.split(':')[0]} | ${r.profile} | ${r.exits.sl} / ${r.exits['sl-gap']} | ${r.exits.tp} | ${r.exits.time} | ${r.exits['period-end']} | ${fmt(r.fees)} $ | ${signed(r.funding)} $ |`);
  lines.push('','## Begränsningar och reproduktion','','- 15-minutersstaplar visar inte ordningen mellan alla intrastapelrörelser. SL prioriteras vid tvetydighet. Exekvering vid historiska öppningar kan vara bättre än verklig browserfördröjning.','- Markpris utlöser SL och TP, värderar innehav och används för funding. Historisk fyllning vid markpris ersätter inte verklig orderbok. Ingen historisk orderbok, marknadsdjup, orderkvantitetsavrundning eller exakta historiska risktrappor ingår i denna låga exponeringsjämförelse.','- Funding täcker varje coin med högst åtta timmar mellan observationerna. Offentlig historik anger inte alltid varför betalningsintervall ändrats.','- Fast SL begränsar planerad förlust, inte garanterad förlust vid gap, större slippage eller saknade prisuppdateringar. Maxnedgång mäts vid 15-minutersstängning och kan underskatta rörelser inom stapeln.','- Historisk ranking är inte en tränad AI-modell. Tre fasta hypoteser jämfördes och inga nya regler söktes efter resultat.','','Kör `node research/crypto-momentum-active-data.mjs --download` och därefter `node research/crypto-momentum-active-run.mjs`. Rådata, utvecklingslås och fullständiga affärsloggar sparas lokalt i `.matning/crypto-active/`; den kompakta exporten finns i `crypto-momentum-active-research.js`.','','### Datahashar','','| Coin | Pris/markstaplar vardera | Fundinghändelser | SHA-256 |','|---|---:|---:|---|');
  for(const [s,f] of Object.entries(manifest.files))lines.push(`| ${s} | ${f.bars} | ${f.funding} | ${f.sha256} |`);
  lines.push('',`Protokoll SHA-256: ${sha(protocol)}.`, `Signal SHA-256: ${sha(signal)}.`, `Simulator SHA-256: ${sha(engine)}.`, '','Officiella källor: [Bybit Kline](https://bybit-exchange.github.io/docs/v5/market/kline), [markpriser](https://bybit-exchange.github.io/docs/v5/market/mark-kline), [fundinghistorik](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate).','');
  await writeFile(new URL('./crypto-momentum-active-results.md',import.meta.url),lines.join('\n'));
  process.stdout.write('Report and ACTIVE_RESEARCH written; selected='+selected+', validated='+validated+'\n');
}
async function scenario(){
  const {data}=await loadActiveData(),prepared=prepare(data),tiers=JSON.parse(await readFile(new URL('current-contracts.json',DATA_DIR),'utf8')),rows=[],full={};
  for(const period of Object.keys(PERIODS))for(const profile of Object.keys(ACTIVE_PROFILES))for(const slip of [.0005,.001]){
    const [start,end]=PERIODS[period].map(d=>Date.parse(d+'T00:00:00Z'));const r=simulateUserRisk(prepared,tiers.contracts,{profile,start,end,slip});full[period+':'+profile+':'+slip]=r;rows.push({period,...summary(r)});
    process.stdout.write('50% scenario '+period+' '+profile+' slip '+slip+': '+r.trades+' trades, '+signed(r.netPct)+'%, DD '+fmt(r.maxDrawdownPct)+'%\n');
  }
  const execution=await readFile(new URL('../crypto-momentum-active-execution.js',import.meta.url),'utf8');
  const meta={createdAt:new Date().toISOString(),currentTiersAt:tiers.fetchedAt,executionSha256:sha(execution),engineSha256:sha(await readFile(new URL(import.meta.url),'utf8')),riskFraction:.5,marginFraction:.5,liquidationBuffer:.25,note:'Scenario: current public Bybit tiers on historical prices, not historical maximum-leverage reconstruction. Does not affect profile selection.'};
  await writeFile(new URL('user-risk-scenario.json',DATA_DIR),JSON.stringify({meta,results:full},null,2)+'\n');
  const {ACTIVE_RESEARCH}=await import('../crypto-momentum-active-research.js?scenario='+Date.now());
  await writeFile(new URL('../crypto-momentum-active-research.js',import.meta.url),'// Generated by research/crypto-momentum-active-run.mjs; no credentials or trade execution.\nexport const ACTIVE_RESEARCH = Object.freeze('+JSON.stringify({...ACTIVE_RESEARCH,userRiskScenario:{...meta,rows}},null,2)+');\n');
  const reportUrl=new URL('./crypto-momentum-active-results.md',import.meta.url),report=await readFile(reportUrl,'utf8'),lines=['','## Separat scenario: användarens 50 % riskgräns','','Detta använder dagens Bybit-risktrappor från '+tiers.fetchedAt+' på historiska priser och den gemensamma `openActivePosition`-funktionen. Högst 50 % av kontot får användas som isolerad marginal och högst 50 % planerad SL-risk inklusive kostnader; verklig planerad risk blir ofta lägre på grund av marginaltaket och likvidationsbufferten. Det är inte historiskt korrekta maxhävstänger och inte underlag för profilurvalet.','','| Period | Profil | Slip/sida | Avslut | Slutkapital | Netto | Max nedgång | Likvidationer | Hävstång min–max | Median planerad SL-risk |','|---|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for(const r of rows)lines.push(`| ${r.period} | ${r.profile} | ${(r.slip*100).toFixed(2)} % | ${r.trades} | ${fmt(r.endCapital)} $ | ${signed(r.netPct)} % | ${fmt(r.maxDrawdownPct)} % | ${r.liquidations} | ${fmt(r.minLeverage)}–${fmt(r.maxLeverage)}× | ${fmt(r.medianRiskPct)} % |`);
  lines.push('','Även med SL och skyddad ledig marginal kan många förluster i rad förbruka nästan hela kontot. Noll dollar med två decimaler kan betyda ett positivt belopp under ett halvt cent. Kontot har inte fyllts på mellan affärerna. Historiken innehåller inga likvidationer i denna scenariomodell om tabellen visar noll; det betyder inte att likvidation kan uteslutas i andra marknadsförlopp.','','Stresskörningen räknar om inträdeskravet netto-R:R ≥ 1,5 vid den högre slippagen. Den kan därför hoppa över affärer och ibland ge bättre netto; den är inte en identisk affärslista med bara större kostnader.','','Reproducera tillägget med `node research/crypto-momentum-active-data.mjs --contracts` och `node research/crypto-momentum-active-run.mjs --scenario`. Metadata och samtliga affärer finns i `.matning/crypto-active/user-risk-scenario.json`.','');
  await writeFile(reportUrl,report.split('\n## Separat scenario:')[0]+lines.join('\n'));
}
if(process.argv[1]===fileURLToPath(import.meta.url)){if(process.argv.includes('--scenario'))await scenario();else await run();}
