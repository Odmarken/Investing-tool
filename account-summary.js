import {mergeHistory} from './account-history.js';
const DAY=86400000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
export function summarizeAccount(account,now=Date.now(),target=10000){
  const trades=mergeHistory(account.affarer).map(t=>{
    const pnl=finite(t.pnl)?t.pnl:null;
    const before=finite(t.kapitalFore)?t.kapitalFore:finite(t.kapitalEfter)&&pnl!==null?t.kapitalEfter-pnl:finite(t.margin)?t.margin:null;
    const after=finite(t.kapitalEfter)?t.kapitalEfter:before!==null&&pnl!==null?before+pnl:null;
    return {...t,pnl,before,after,inferredBefore:!finite(t.kapitalFore)};
  });
  const valid=trades.filter(t=>t.pnl!==null),wins=valid.filter(t=>t.pnl>0.005),losses=valid.filter(t=>t.pnl<-.005),flat=valid.length-wins.length-losses.length;
  const net=valid.reduce((s,t)=>s+t.pnl,0),fees=valid.reduce((s,t)=>s+(finite(t.avgift)?t.avgift:0),0);
  const balance=finite(account.kapital)?account.kapital:null,start=finite(account.start)?account.start:null;
  const incomplete=balance===null||start===null||valid.length!==trades.length||Math.abs(balance-start-net)>.02||
    (trades.length>0&&trades[0].before!==null&&Math.abs(trades[0].before-start)>.02);
  const dates=trades.filter(t=>finite(t.stangd)&&t.stangd<=now),first=dates[0];
  const began=finite(account.startad)&&account.startad<=now?account.startad:first?.oppnad;
  const coverage=incomplete?Math.max(began||0,first?.oppnad||first?.stangd||now):began||now;
  const since=Math.max(now-30*DAY,coverage),days=Math.max(0,(now-since)/DAY);
  const recent=valid.filter(t=>finite(t.stangd)&&t.stangd>=since&&t.stangd<=now),recentNet=recent.reduce((s,t)=>s+t.pnl,0);
  const daily=days>0?recentNet/days:null,remaining=balance===null?null:Math.max(0,target-balance);
  let forecast={status:'insufficient',days:null,date:null};
  if(remaining===0)forecast={status:'reached',days:0,date:null};
  else if(balance!==null&&days>=7&&recent.length>=20){
    if(daily<=0)forecast={status:'nonpositive',days:null,date:null};
    else {const wait=Math.ceil(remaining/daily);forecast={status:wait>3650?'distant':'estimate',days:wait,date:wait>3650?null:now+wait*DAY};}
  }
  return {trades,wins:wins.length,losses:losses.length,flat,unknown:trades.length-valid.length,
    winRate:wins.length+losses.length?wins.length/(wins.length+losses.length):null,
    net,fees,balance,start,incomplete,target,remaining,progress:balance===null?0:Math.max(0,Math.min(1,balance/target)),
    forecast,recentNet,recentCount:recent.length,days,daily,since};
}
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=(x,d=2)=>finite(x)?x.toLocaleString('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d}):'–';
const money=x=>number(x)+' $';
const signed=x=>finite(x)?(x>0?'+':'')+money(x):'–';
const date=(t,time=true)=>finite(t)&&t>0?new Intl.DateTimeFormat('sv-SE',{dateStyle:'short',...(time?{timeStyle:'short'}:{}),timeZone:'Europe/Stockholm'}).format(t):'–';
function ring(s){
  const n=s.wins+s.losses+s.flat,parts=[{n:s.wins,color:'#00e58c'},{n:s.losses,color:'#ff4f70'},{n:s.flat,color:'#8195a6'}];let offset=0;
  const arcs=parts.map(p=>{const size=n?p.n/n*100:0;const html=`<circle cx="90" cy="90" r="68" fill="none" stroke="${p.color}" stroke-width="15" pathLength="100" stroke-dasharray="${size} ${100-size}" stroke-dashoffset="${-offset}" transform="rotate(-90 90 90)"/>`;offset+=size;return size?html:'';}).join('');
  return `<svg viewBox="0 0 180 180" role="img" aria-label="${s.wins} vinster, ${s.losses} förluster, ${s.flat} nollresultat"><circle cx="90" cy="90" r="68" fill="none" stroke="#1b303b" stroke-width="15"/>${arcs}<text x="90" y="89" text-anchor="middle" fill="currentColor" font-size="28" font-weight="700">${s.winRate===null?'–':number(s.winRate*100,1)+'%'}</text><text x="90" y="111" text-anchor="middle" fill="#91a9b4" font-size="11">VINSTANDEL</text></svg>`;
}
function balanceChart(s){
  const points=s.trades.filter(t=>finite(t.stangd)&&t.after!==null).map(t=>({t:t.stangd,v:t.after}));
  if(points.length&&s.trades[0].before!==null)points.unshift({t:s.trades[0].oppnad||points[0].t,v:s.trades[0].before});
  if(points.length<2)return '<div class="summary-empty">Saldokurvan visas när avslutade affärer finns.</div>';
  const minT=points[0].t,maxT=Math.max(minT+1,...points.map(p=>p.t));
  let lo=Math.min(...points.map(p=>p.v)),hi=Math.max(...points.map(p=>p.v));const pad=Math.max(1,(hi-lo)*.12);lo-=pad;hi+=pad;
  const x=t=>62+(t-minT)/(maxT-minT)*816,y=v=>180-(v-lo)/(hi-lo)*152;
  const path=points.map((p,i)=>(i?'L':'M')+x(p.t).toFixed(2)+' '+y(p.v).toFixed(2)).join(' ');
  const grid=[0,.5,1].map(f=>{const v=lo+(hi-lo)*f,yy=y(v);return `<line x1="62" y1="${yy}" x2="878" y2="${yy}" stroke="#1b303b"/><text x="54" y="${yy+4}" text-anchor="end" fill="#91a9b4" font-size="11">${number(v,0)}</text>`;}).join('');
  return `<svg class="summary-equity" viewBox="0 0 900 218" role="img" aria-label="Realiserat saldo över sparad affärshistorik">${grid}<path d="${path}" fill="none" stroke="#00e58c" stroke-width="2.5" vector-effect="non-scaling-stroke"/><text x="62" y="208" fill="#91a9b4" font-size="11">${date(minT,false)}</text><text x="878" y="208" text-anchor="end" fill="#91a9b4" font-size="11">${date(maxT,false)}</text></svg>`;
}
export function summaryShell(){return `
  <div class="summary-heading"><div><div class="summary-eyebrow">RIPTIDE / KRYPTO / DEMOKONTO</div><h1 tabindex="-1" id="summaryTitle">Account summary</h1><p>Alla sparade avslut, kontots utveckling och vägen mot ditt mål.</p></div><a class="btn" href="#">← Tillbaka till signaler</a></div>
  <div id="summaryNotice" class="summary-notice"></div>
  <div id="summaryStats" class="summary-stats"></div>
  <div class="summary-grid"><section class="summary-panel"><h2>Vinster & förluster</h2><div id="summaryRing" class="summary-ring"></div></section>
  <section class="summary-panel summary-goal"><h2>Vägen till 10 000 $</h2><div id="summaryGoal"></div></section></div>
  <section class="summary-panel"><div class="summary-section-head"><h2>Kontots tidslinje</h2><span>Realiserat saldo efter varje avslut · USD</span></div><div id="summaryChart"></div></section>
  <section class="summary-panel"><div class="summary-section-head"><div><h2>Affärshistorik</h2><p id="summaryCount"></p></div><div class="summary-actions"><label>Sida <select id="summarySide"><option value="all">Alla</option><option value="long">Long</option><option value="short">Short</option></select></label><label>Utfall <select id="summaryOutcome"><option value="all">Alla</option><option value="win">Vinst</option><option value="loss">Förlust</option><option value="flat">Nollresultat</option></select></label><button class="btn" id="summaryExport" type="button">↓ Exportera CSV</button></div></div>
  <div class="summary-table-wrap" tabindex="0" aria-label="Affärshistorik, rulla åt sidan för alla kolumner"><table class="summary-table"><thead><tr><th>Öppnad</th><th>Stängd</th><th>Coin / strategi</th><th>Sida</th><th>Entry → exit</th><th>Saldo före</th><th>Resultat netto</th><th>Avgift</th><th>Saldo efter</th><th>Avslut</th></tr></thead><tbody id="summaryRows"></tbody></table></div>
  <div class="summary-pagination"><button class="btn" id="summaryPrev" type="button">← Föregående</button><span id="summaryPage"></span><button class="btn" id="summaryNext" type="button">Nästa →</button></div>
  <p class="summary-footnote">Saldo före äldre affärer räknas från sparat saldo efter minus resultat när separat ingångssaldo saknas. Tider visas i Stockholm. Öppna positioner ingår inte i vinst/förlust eller målprognosen.</p></section>`;}
export function mountSummary(root,getAccount,getStatus=()=>({})){
  root.innerHTML=summaryShell();let page=0,lastSignature='';const $=id=>root.querySelector('#'+id);
  function render(){
    const account=getAccount(),s=summarizeAccount(account),status=getStatus();
    const signature=JSON.stringify([account.kapital,account.affarer.length,account.affarer.at(-1),account.oppen?.id,status,page,$('summarySide').value,$('summaryOutcome').value,Math.floor(Date.now()/60000)]);
    if(signature===lastSignature)return;lastSignature=signature;
    const notes=[];
    if(s.incomplete)notes.push('Historiken är ofullständig eller innehåller en saldoförändring utanför sparade affärer. Äldre borttagna affärer kan inte återskapas.');
    if(status.localError)notes.push('Historiken kunde inte sparas på enheten. Exportera CSV för en egen kopia.');
    if(!status.cloud)notes.push('Lokalt konto. Historiken sparas i denna webbläsare.');
    $('summaryNotice').textContent=notes.join(' ');$('summaryNotice').hidden=!notes.length;
    const stat=(name,value,detail='')=>`<div class="summary-stat"><span>${name}</span><b>${value}</b><small>${detail}</small></div>`;
    $('summaryStats').innerHTML=stat('Realiserat saldo',money(s.balance),'Öppen P/L ingår inte')+stat('Netto i sparad historik',signed(s.net),'Efter bokförda avgifter')+stat('Avslutade affärer',s.trades.length,`${s.wins} vinster · ${s.losses} förluster · ${s.flat} noll`)+stat('Kvar till 10 000 $',money(s.remaining),number(s.progress*100,1)+' % av målet');
    $('summaryRing').innerHTML=ring(s)+`<div class="summary-ring-legend"><span><i style="background:#00e58c"></i>Vinst <b>${s.wins}</b></span><span><i style="background:#ff4f70"></i>Förlust <b>${s.losses}</b></span><span><i style="background:#8195a6"></i>Nollresultat <b>${s.flat}</b></span><small>Vinstandel = vinster / (vinster + förluster).${s.unknown?' '+s.unknown+' avslut saknar resultat.':''}</small></div>`;
    let estimate='För lite historik för en tidsuppskattning. Minst 20 avslut och 7 kalenderdagar behövs.';
    if(s.forecast.status==='reached')estimate='Målet är uppnått med det realiserade saldot.';
    else if(s.forecast.status==='nonpositive')estimate='Ingen beräknad måldag: den senaste periodens genomsnittliga netto är noll eller negativt.';
    else if(s.forecast.status==='distant')estimate='Mer än 10 år i ett scenario med samma genomsnittliga nettovinst per dag.';
    else if(s.forecast.status==='estimate')estimate=`Cirka ${number(s.forecast.days,0)} dagar · ${date(s.forecast.date,false)}, om samma genomsnittliga nettovinst per dag fortsätter.`;
    $('summaryGoal').innerHTML=`<div class="summary-goal-amount">${money(s.balance)} <span>/ 10 000 $</span></div><div class="summary-progress" role="progressbar" aria-label="Saldo mot 10 000 dollar" aria-valuenow="${Math.round(s.progress*100)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${s.progress*100}%"></i></div><div class="summary-milestones"><span>0 $</span><span>2 500 $</span><span>5 000 $</span><span>7 500 $</span><span>10 000 $</span></div><p class="summary-estimate">${estimate}</p><p class="summary-footnote">Historisk takt: ${signed(s.daily)} per kalenderdag över ${number(s.days,1)} dagar, ${s.recentCount} avslut. Högst de senaste 30 dagarna används. Linjärt räkneexempel utan ränta-på-ränta; framtida resultat kan bli helt annorlunda.</p>`;
    $('summaryChart').innerHTML=balanceChart(s);
    const side=$('summarySide').value,outcome=$('summaryOutcome').value;
    const filtered=s.trades.filter(t=>(side==='all'||t.side===side)&&(outcome==='all'||t.pnl!==null&&(outcome==='win'?t.pnl>.005:outcome==='loss'?t.pnl<-.005:Math.abs(t.pnl)<=.005))).reverse();
    const pages=Math.max(1,Math.ceil(filtered.length/50));page=Math.min(page,pages-1);
    $('summaryCount').textContent=`${filtered.length} av ${s.trades.length} sparade avslut · senaste först · denna enhets historik; molnet delar de senaste 300`;
    $('summaryRows').innerHTML=filtered.slice(page*50,page*50+50).map(t=>`<tr><td>${date(t.oppnad)}</td><td>${date(t.stangd)}</td><td><b>${esc(t.inst)}</b><small>${esc(t.namn||t.fam||'')}</small></td><td><span class="summary-side ${t.side==='long'?'long':t.side==='short'?'short':''}">${esc(t.side==='long'?'LONG':t.side==='short'?'SHORT':'–')}</span></td><td>${number(t.entry,6)}<br>${number(t.exit,6)}</td><td>${money(t.before)}</td><td class="${t.pnl>0?'pos':t.pnl<0?'neg':''}">${signed(t.pnl)}</td><td>${money(t.avgift)}</td><td>${money(t.after)}</td><td>${esc(t.hur||'–')}</td></tr>`).join('')||'<tr><td colspan="10" class="summary-empty">Inga avslutade affärer matchar urvalet.</td></tr>';
    $('summaryPage').textContent=`Sida ${page+1} av ${pages}`;$('summaryPrev').disabled=page===0;$('summaryNext').disabled=page>=pages-1;
  }
  for(const id of ['summarySide','summaryOutcome'])$(id).onchange=()=>{page=0;render();};
  $('summaryPrev').onclick=()=>{page=Math.max(0,page-1);render();};$('summaryNext').onclick=()=>{page++;render();};
  $('summaryExport').onclick=()=>{
    const csv=summaryCSV(summarizeAccount(getAccount()).trades),url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download='riptide-krypto-historik.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return {render};
}
export function summaryCSV(trades){
  const cell=x=>'"'+(typeof x==='string'?x.replace(/^[\s]*[=+@-]/,"'$&"):String(x??'')).replace(/"/g,'""')+'"';
  const rows=[['Öppnad','Stängd','Coin','Strategi','Sida','Entry','Exit','Saldo före','Resultat netto','Avgift','Saldo efter','Avslut'],
    ...trades.map(t=>[date(t.oppnad),date(t.stangd),t.inst,t.namn,t.side,t.entry,t.exit,t.before,t.pnl,t.avgift,t.after,t.hur])];
  return rows.map(row=>row.map(cell).join(';')).join('\r\n');
}
