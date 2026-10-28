// Runs one Rita strategy, or the free yardsticks, on a set of cut points (pablo-rita-sim.mjs).
//   node research/pablo-rita-run.mjs --strategy research/pablo-rita-strategies/baseline.mjs --set dev [--n 30] [--concurrency 3]
//   node research/pablo-rita-run.mjs --baselines --set dev [--n 30]
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {runStrategy,runBaselines,table} from './pablo-rita-sim.mjs';

const arg=k=>{const i=process.argv.indexOf('--'+k);return i>0?process.argv[i+1]:undefined;};
const set=arg('set')??'dev',n=+(arg('n')??30),concurrency=+(arg('concurrency')??3);
if(process.argv.includes('--baselines')){
  console.log(table(Object.entries(await runBaselines({set,n}))));
}else{
  const path=arg('strategy');
  if(!path)throw Error('Ange --strategy <fil> eller --baselines');
  const strategy=(await import(pathToFileURL(resolve(path)).href)).default;
  const r=await runStrategy(strategy,{set,n,concurrency,log:x=>console.log(x)});
  console.log('\n'+table([[strategy.name,r.summary]]));
}
