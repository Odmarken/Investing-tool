export function tradeKey(t){
  return encodeURIComponent([t.id||'',t.oppnad||0,t.stangd||0].join('|'));
}
export function mergeHistory(...lists){
  const map=new Map();
  for(const list of lists)for(const trade of Array.isArray(list)?list:[]){
    if(!trade||typeof trade!=='object')continue;
    const key=tradeKey(trade);map.set(key,{...map.get(key),...trade});
  }
  return [...map.values()].sort((a,b)=>(a.stangd||0)-(b.stangd||0)||(a.oppnad||0)-(b.oppnad||0)||tradeKey(a).localeCompare(tradeKey(b)));
}
