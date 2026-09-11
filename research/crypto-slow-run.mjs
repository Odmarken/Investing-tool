import {writeFileSync} from 'node:fs';
import {readData,SYMBOLS,ROOT,END} from './crypto-slow-data.mjs';
import {simulate,VARIANTS} from './crypto-slow-core.mjs';
const sources=Object.fromEntries(SYMBOLS.map(s=>[s,readData(s)]));
const data=Object.fromEntries(SYMBOLS.map(s=>[s,sources[s].bars]));
const START=Date.parse('2023-01-01T00:00:00Z'),SPLIT=Date.parse('2025-01-01T00:00:00Z');
const development=VARIANTS.map(v=>({base:simulate(v,data,START,SPLIT),stress:simulate(v,data,START,SPLIT,.001)}));
const eligible=development.filter(r=>r.base.returnPct>0&&r.stress.returnPct>0&&r.base.maxDDPct<=35&&r.stress.maxDDPct<=35&&r.base.n>=10);
eligible.sort((a,b)=>b.base.returnPct/Math.max(b.base.maxDDPct,.01)-a.base.returnPct/Math.max(a.base.maxDDPct,.01));
const selected=eligible[0]?.base.variant??null;
// Selection is now locked; later results cannot replace it.
const later=[...VARIANTS,'buyhold'].map(v=>({base:simulate(v,data,SPLIT,END),stress:simulate(v,data,SPLIT,END,.001)}));
const years=[2023,2024,2025,2026].map(year=>{const from=Date.parse(year+'-01-01T00:00:00Z'),to=Math.min(END,Date.parse((year+1)+'-01-01T00:00:00Z'));
  return {year,results:[...VARIANTS,'buyhold'].map(v=>simulate(v,data,from,to))};});
const result={createdAt:new Date().toISOString(),selected,development,later,years,
  developmentBenchmark:simulate('buyhold',data,START,SPLIT),hashes:Object.fromEntries(SYMBOLS.map(s=>[s,sources[s].checksum]))};
writeFileSync(new URL('results.json',ROOT),JSON.stringify(result));
const compact=r=>({variant:r.variant,returnPct:r.returnPct,maxDDPct:r.maxDDPct,n:r.n,sharpe:r.sharpe,exposurePct:r.exposurePct,holdingDays:r.meanHoldingDays});
console.log(JSON.stringify({selected,development:development.map(r=>compact(r.base)),later:later.map(r=>({...compact(r.base),stressReturnPct:r.stress.returnPct})),
  years:years.map(y=>({year:y.year,results:y.results.map(compact)}))},null,2));
