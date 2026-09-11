import {assessAI,newShadow,settleShadow,shadowKey,shadowStats} from './crypto-ai.js';
import {CRYPTO_AI_RESEARCH} from './crypto-ai-research.js';
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=x=>Number.isFinite(x)?x.toFixed(2):'–';
const date=t=>new Date(t).toLocaleString('sv-SE',{timeZone:'Europe/Stockholm',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
export const AI_LOG_LIMIT=5000;

export function researchHTML(report){
  return '<details><summary>Senaste förbättringstest: '+(report.readyForDemo?'klarade forskningskraven':'ingen godkänd modell')+'</summary>'+
    '<p>'+escape(report.conclusion)+'</p><p>'+report.candidates+' insamlade kandidater. Sex modellvarianter prövades. '+
    'Validering '+new Date(report.validationFrom).toISOString().slice(0,10)+' till '+new Date(report.validationTo-1).toISOString().slice(0,10)+'.</p>'+
    '<p>Samma '+report.paired[0].n+' signaler med olika stopp och innehavstid, före AI-urval. Avgifter, slippage och funding ingår. R mäter resultat relativt beräknad nettoförlust vid stopp.</p>'+
    '<div class="ai-scroll"><table><thead><tr><th>Utförande</th><th>Snitt R</th><th>Dubbel slippage, R</th></tr></thead><tbody>'+
    report.paired.map(p=>'<tr><td>'+escape(p.name)+'</td><td>'+number(p.meanR)+'</td><td>'+number(p.stressR)+'</td></tr>').join('')+'</tbody></table></div>'+
    '<div class="ai-scroll"><table><thead><tr><th>Modell</th><th>Träningsexempel</th><th>AI skulle ta</th><th>Godkänd</th></tr></thead><tbody>'+
    report.trials.map(t=>'<tr><td>'+escape(t.name)+'</td><td>'+t.trainN+'</td><td>'+t.selectedN+'</td><td>'+(t.pass?'Ja':'Nej')+'</td></tr>').join('')+'</tbody></table></div>'+
    '<p>Historisk forskning, inte kontots avkastning. Noll trades räcker inte för godkännande. Automatisk demo kräver positiva resultat även på senare data och under högre kostnader.</p></details>';
}

export function readAILog(storage,key){
  const raw=storage.getItem(key);if(!raw)return [];
  const rows=JSON.parse(raw);
  if(!Array.isArray(rows)||rows.length>AI_LOG_LIMIT||rows.some(r=>!r||typeof r.key!=='string'||
    !['pending','closed','unknown'].includes(r.status)||!Number.isFinite(r.at)||
    !Number.isFinite(r.nextBar)||!Number.isFinite(r.deadline)||!Number.isFinite(r.entry)||
    !Number.isFinite(r.sl)||!Number.isFinite(r.tp)||!Number.isFinite(r.risk)||r.risk<=0||
    !Number.isFinite(r.fee)||!Number.isFinite(r.slippage)||!['long','short'].includes(r.side)||
    r.status==='closed'&&!Number.isFinite(r.netR)))throw Error('AI-loggen kunde inte läsas. Exportera eller kontrollera webbläsarlagringen.');
  return rows;
}

export function mountCryptoAI(root,model,getEnabled,setEnabled){
  root.innerHTML=`<div class="ai-top"><label><input type="checkbox" data-ai-toggle> AI-bedömning · experiment</label>
    <button type="button" class="btn" data-ai-export>Exportera AI-logg</button></div>
    <p>AI loggar sitt urval separat. Kontot följer fortfarande valt kryptofilter. Bedömningarna sparas lokalt för din inloggning.</p>
    <p data-ai-state role="status"></p><p data-ai-history></p>${researchHTML(CRYPTO_AI_RESEARCH)}
    <details><summary>Jämför bedömningar och utfall</summary><div class="ai-scroll" data-ai-stats></div>
      <p>R = resultat delat med beräknad förlust vid stopp, efter 0,055 % avgift och 0,05 % slippage per sida, före funding.
      Hypotetiska signaler kan överlappa och är inte kontots avkastning. Stopp/mål låses vid loggning; högst 24 h. Beslutsstapeln hoppas över.</p>
      <p>Senaste 20 bedömningarna. Exporten innehåller hela den lokala loggen (högst ${AI_LOG_LIMIT}). Nya bedömningar kräver att kryptosidan är öppen och inloggad.</p>
      <div class="ai-scroll" data-ai-rows></div></details>`;
  let rows=[],views=new Map(),error='',uid=null,dirty=false;
  const toggle=root.querySelector('[data-ai-toggle]');
  toggle.checked=getEnabled();
  toggle.onchange=()=>setEnabled(toggle.checked);
  root.querySelector('[data-ai-export]').onclick=()=>{
    if(!uid)return;
    const blob=new Blob([JSON.stringify({format:'riptide-ai-shadow-v1',exportedAt:new Date().toISOString(),model,rows},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='riptide-ai-logg.json';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return {
    update({userId,signals,contexts,now,snapshots}){
      if(!userId){rows=[];views.clear();uid=null;dirty=false;return;}
      if(uid!==userId){rows=[];views.clear();error='';uid=userId;dirty=false;}
      const key='riptide.crypto-ai.v1:'+encodeURIComponent(userId);
      let storage,readOK=false;
      try{storage=window.localStorage;const stored=readAILog(storage,key);
        // Preserve in-memory observations if storage temporarily fails.
        rows=[...new Map([...rows,...stored].map(r=>[r.key,r])).values()];readOK=true;error='';
      }catch(e){error='Lokal AI-logg kan inte sparas: '+e.message;}
      let changed=dirty;
      rows=rows.map(row=>{
        const ctx=contexts[row.inst];if(!ctx||ctx.simulated)return row;
        const next=settleShadow(row,ctx.bars,now);if(next!==row)changed=true;return next;
      });
      views=new Map();const byKey=new Map(rows.map(r=>[r.key,r]));
      if(getEnabled())for(const s of signals){
        const k=shadowKey(s,model.version),old=byKey.get(k);
        if(old){views.set(s.id,old);continue;}
        if(s.status!=='ACTIVE'||s.grade!=='A')continue;
        const assessment=assessAI(s,contexts[s.inst],now,model,snapshots.get(s.inst));
        if(!assessment)continue;
        if(rows.length>=AI_LOG_LIMIT)continue;
        const row=newShadow(s,contexts[s.inst],now,assessment,model.version);
        if(row){rows.push(row);byKey.set(k,row);views.set(s.id,row);changed=true;}
      }
      dirty=changed;
      if(changed&&readOK)try{storage.setItem(key,JSON.stringify(rows));dirty=false;}catch(e){error='AI-loggen finns bara i denna flik: lagringen misslyckades. Exportera för att spara.';}
      toggle.checked=getEnabled();
      const current=rows.filter(r=>r.version===model.version);
      const pending=current.filter(r=>r.status==='pending').length;
      root.querySelector('[data-ai-state]').textContent=error||
        (getEnabled()?'AI-loggning på':'Nya AI-bedömningar pausade')+' · '+current.length+' loggade · '+pending+' väntar på utfall.'+
        (rows.length>=AI_LOG_LIMIT?' Loggen är full; exportera den. Inga nya bedömningar sparas.':'')+
        (now>model.dataEnd+30*86400000?' Modellen är äldre än 30 dagar; nya bedömningar kräver omträning.':'');
      const historical=model.evaluation.stats,all=historical[0],ai=historical.find(s=>s.label==='AI skulle ta');
      root.querySelector('[data-ai-history]').textContent='Preliminärt historiskt test: '+model.training.n+' träningsexempel, '+all.n+
        ' senare testexempel. AI skulle ta '+ai.n+' av dem'+(ai.n?' (snitt '+number(ai.meanR)+' R)':'')+
        '. Alla testexempel: '+number(all.meanR)+' R i snitt. Ingen påvisad lönsamhet. Testperioden har granskats tidigare.';
      root.querySelector('[data-ai-stats]').innerHTML='<table><thead><tr><th>Urval</th><th>Loggade</th><th>Avslutade</th><th>Okända</th><th>Vinstandel</th><th>Snitt R</th></tr></thead><tbody>'+
        shadowStats(current).map(s=>'<tr><td>'+s.label+'</td><td>'+s.n+'</td><td>'+s.closed+'</td><td>'+s.unknown+'</td><td>'+
          (s.winRate===null?'–':(100*s.winRate).toFixed(1)+' %')+'</td><td>'+number(s.meanR)+'</td></tr>').join('')+'</tbody></table>';
      root.querySelector('[data-ai-rows]').innerHTML='<table><thead><tr><th>Tid</th><th>Signal</th><th>AI:s beslut</th><th>Modellens R</th><th>Selektiv</th><th>Utfall R</th></tr></thead><tbody>'+
        current.slice(-20).reverse().map(r=>'<tr><td>'+date(r.at)+'</td><td>'+escape(r.inst)+' '+escape(r.side.toUpperCase())+'</td><td>'+escape(r.reason)+
          '</td><td>'+number(r.expectedR)+'</td><td>'+(r.selective?'Godkänd':'Avstår')+'</td><td>'+
          (r.status==='closed'?number(r.netR)+' · '+escape(r.reasonOutcome):r.status==='unknown'?'Okänt':'Väntar')+'</td></tr>').join('')+'</tbody></table>';
    },
    card(signal){
      if(!getEnabled())return '';
      const row=views.get(signal.id);
      if(!row)return signal.status==='ACTIVE'?'<div class="crypto-quality dim">AI: ingen bedömning tillgänglig för denna signal.</div>':'';
      return '<div class="crypto-quality"><b>AI: '+escape(row.reason)+'</b> · uppskattat '+number(row.expectedR)+
        ' R<div class="dim">Låst '+date(row.at)+' · experiment, ingen uppmätt vinstchans</div></div>';
    }
  };
}
