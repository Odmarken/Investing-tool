// AI Forecast account terminal: the panel under the chart, like Bybit's bottom panel. Its header always shows the
// money: Kapital (live equity), Tillgängligt (free cash), Marginal i bruk, Orealiserat resultat and Resultat sedan start
// (the trading result: deposits and withdrawals left out). A "−" button folds it to a thin bar that keeps Kapital; "+"
// opens it again, and the choice is kept in the UI prefs. Four tabs: Positioner (open positions with their SL and TP as
// inputs, and Stäng), Historik (closed trades, deposits and withdrawals as rows of their own, newest first, 50 at a
// time), Händelser (the account's log) and Saldo (deposits and withdrawals, booked in the ledger). Every change goes
// through the runner, which writes it under the account's lock before it answers. The Saldo previews run the account's
// own deposit, withdraw and setFree on a copy, so a preview says what the runner books. An action's answer stays until
// the account changes another way (levels moved on the chart, an order, money moved in another tab), so it never
// contradicts the rows under it. A position that closes without the terminal asking (its SL or TP, a liquidation, Stäng
// in another tab) is told on every tab, with the time it closed, until the account changes again or TERMINAL_NOTICE_MS
// has passed; Händelser and Historik keep it. A level typed and not saved is marked so, and it goes when that level is
// changed another way (dragged on the chart, set in another tab). The header's figures are built from what the rows show
// (terminalFigures), so its sums hold to the cent. Demo only: no orders.
import {ACCOUNT,tradeReasons,accountStats,deposit,withdraw,setFree,stepDecimals,levelDecimals} from './forecast-account.js';

export const TERMINAL_PREFS='riptide.forecast.terminal.v1';
export const TERMINAL_TABS=Object.freeze(['positions','history','events','balance']);
// History and log rows shown at first, and added by each "Visa fler".
export const TERMINAL_PAGE=50;
// How long the news of a close the terminal did not ask for stays in the message line when nothing else changes (ms).
export const TERMINAL_NOTICE_MS=20000;
const LABELS=Object.freeze({positions:'Positioner',history:'Historik',events:'Händelser',balance:'Saldo'});
const FIGURES=Object.freeze([['equity','Kapital'],['cash','Tillgängligt'],['margin','Marginal i bruk'],['open','Orealiserat resultat'],['result','Resultat sedan start']]);
// No prototype: a stored value such as 'constructor' must not find a text.
const table=o=>Object.freeze(Object.assign(Object.create(null),o));
const SIDE=table({long:'lång',short:'kort'}),SIDE_CELL=table({long:'Lång',short:'Kort'}),LEVEL=table({sl:'SL',tp:'TP'}),REASONS=table(tradeReasons);
// Positioner's column heads: the figures' right-aligned, and the result's and the levels' named for the stylesheet.
const HEAD_CLASS=table({Hävstång:'num',Antal:'num',Entry:'num',Pris:'num','Likv.':'num',Marginal:'num',Resultat:'num fct-pnl','SL / TP':'fct-levels'});
const MINUS='−',DATE_MAX=8.64e15,MONTHS=['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];
// The message line's tab for news about the account rather than about an action taken on one tab.
const EVERY='*';

const finite=x=>typeof x==='number'&&Number.isFinite(x);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// A number keeps its unit on its line (100 $, 2,5 %) as the view writes it; the runner's and the log's texts use plain spaces.
const bind=s=>String(s??'').replace(/(\d) ([%$])/g,'$1\xa0$2');
const fixed=(x,d)=>x.toLocaleString('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d});
// The sign is written out, so a value that rounds to zero never reads −0,00.
const signed=(x,d,unit)=>{const v=Math.round(x*10**d)/10**d;return (v>0?'+':v<0?MINUS:'')+fixed(Math.abs(v),d)+unit;};
// Whole cents: every amount is rounded once, this way, to the cent it shows (signed() rounds the same way), so the sums
// terminalFigures builds from shown amounts are the sums of what the rows show.
const cents=x=>Math.round(x*100);
const money=x=>finite(x)?fixed(cents(x)/100,2)+'\xa0$':'–';
const signedMoney=x=>finite(x)?signed(x,2,'\xa0$'):'–';
const pct=(x,d=1)=>finite(x)?fixed(x*100,d)+'\xa0%':'–';
const signedPct=(x,d=1)=>finite(x)?signed(x*100,d,'\xa0%'):'–';
const tone=x=>!finite(x)||Math.abs(x)<.005?'':x>0?'pos':'neg';
const leverageText=x=>finite(x)?x.toLocaleString('sv-SE',{maximumFractionDigits:2})+'×':'–';
// The chart's decimals for a price of that size: the terminal's prices until it knows the coin's tick (see priceDecimals).
const magnitude=p=>finite(p)&&p>0?Math.min(10,Math.max(0,4-Math.floor(Math.log10(p)))):2;
const price=(x,d)=>finite(x)?fixed(x,d):'–';
// A stop or a target as the chart's tag and the runner write it (levelDecimals): as many decimals as the chart gives a
// price of its size, more where the level has them, never more than Bybit's tick once that is known (`tick`).
const levelText=(x,tick=null)=>finite(x)?fixed(x,levelDecimals(x,tick)):'–';
// A level as it is typed: no grouping, a decimal comma. On Bybit's tick (`tick`: its decimals) it reads as its tag and
// levelText write it; off the tick (a signal's level) or before the tick is known, exactly as it is set.
const onTick=(x,tick)=>{const y=x*10**tick;return Math.abs(y-Math.round(y))<=1e-9*Math.max(1,Math.abs(y));};
function levelInput(x,tick=null){
  if(!finite(x))return '';
  const d=tick!==null&&onTick(x,tick)?levelDecimals(x,tick):null;
  return x.toLocaleString('sv-SE',{useGrouping:false,minimumFractionDigits:d??0,maximumFractionDigits:d??levelDecimals(x)});
}
// A quantity on Bybit's quantity step (a manual order's: per token at most three decimals, 0,001 BTC) reads exactly, as
// the runner writes it, however large (123 456,7 XRP). One sized off the step (a signal position's) gets six significant
// digits, never fewer than its whole tokens. The test is tight, so an off-step quantity is not taken for a stepped one.
function qtyText(x){
  if(!finite(x)||!(x>0))return '–';
  for(let d=0;d<=4;d++){const y=x*10**d;if(Math.abs(y-Math.round(y))<=1e-12*Math.max(1,y))return fixed(x,d);}
  return fixed(x,Math.min(8,Math.max(0,5-Math.floor(Math.log10(x)))));
}
// What the user typed as a number: spaces (\s covers the no-break ones) and a trailing $ are ignored; a decimal comma or
// point. null: nothing typed; NaN: not a number.
function parseNumber(text){
  const s=String(text??'').replace(/\s/g,'').replace(/\$$/,'').replace(/^[−–]/,'-');
  if(!s)return null;
  if(!/^-?(\d+([.,]\d*)?|[.,]\d+)$/.test(s))return NaN;
  return Number(s.replace(',','.'));
}
const same=(x,y)=>Math.abs(x-y)<=1e-12*Math.max(Math.abs(x),Math.abs(y));

// Stockholm wall-clock time; the date is added when it is not today's, the year when it is not this year's. kl: words
// before the time ('kl. ' in running text: 'stängdes 6 okt kl. 10:10').
let zone=null;
function wall(t){
  zone??=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Stockholm',hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric'});
  const p={};for(const x of zone.formatToParts(t))p[x.type]=+x.value;return p;
}
const two=n=>String(n).padStart(2,'0');
const dated=t=>finite(t)&&Math.abs(t)<=DATE_MAX;
function when(t,now,kl=''){
  if(!dated(t))return '–';
  const w=wall(t),n=dated(now)?wall(now):w,other=w.year!==n.year||w.month!==n.month||w.day!==n.day;
  return (other?w.day+' '+MONTHS[w.month-1]+(w.year!==n.year?' '+w.year:'')+' ':'')+kl+two(w.hour)+':'+two(w.minute);
}
const dateText=t=>{if(!dated(t))return '–';const w=wall(t);return w.day+' '+MONTHS[w.month-1]+' '+w.year;};
// Browser and runner errors in Swedish where they arrive in English.
function reasonOf(e){
  const name=e?.name,text=String(e?.message??e??'');
  if(name==='AbortError'||name==='TimeoutError')return 'Bybit svarade inte i tid via proxyn';
  if(name==='TypeError'&&/^(failed to fetch|fetch failed|networkerror|load failed)/i.test(text))return 'Bybit kunde inte nås via proxyn';
  if(name==='SecurityError')return 'Webbläsarens lagring är blockerad';
  if(name==='QuotaExceededError')return 'Webbläsarens lagring är full';
  return text||'okänt fel';
}
// A refusal's text is only its reason; the coin comes from the entry, as in the view's log.
const logText=e=>e.kind==='avvisad'?'Avvisad'+(e.symbol?' '+e.symbol:'')+': '+e.text:String(e.text??'');
// A position's Marginal in Positioner: its margin and the fee to close that Bybit reserves with a manual order's position.
const held=p=>p.margin+(finite(p.reserve)?p.reserve:0);
// What a message about the account can speak of: the open positions and their levels, the free cash, the closed trades
// and the transfers. New prices and log lines leave it as it is.
const stateOf=a=>JSON.stringify([a.cash,(Array.isArray(a.positions)?a.positions:[]).map(p=>[p.id,p.sl,p.tp]),
  Array.isArray(a.trades)?a.trades.length:0,Array.isArray(a.transfers)?a.transfers.length:0]);

/**
 * terminalFigures(account,live) → {equity,cash,margin,open,result}: the money the terminal's header shows, in USDT and in
 * whole cents, or null where it cannot be told (no account; Kapital and both results also while a position waits for a
 * fresh price or its funding and liquidation check). Each figure is built from figures the terminal shows, so every sum
 * it states holds to the cent as shown:
 *   margin (Marginal i bruk): the open positions' Marginal, each in whole cents as its row in Positioner shows it;
 *   open (Orealiserat resultat): their Resultat, likewise;
 *   result (Resultat sedan start): the closed trades' net as Historik shows it ('netto') + Orealiserat resultat;
 *   equity (Kapital): the start + deposits − withdrawals as Saldo shows them + Resultat sedan start.
 * Each part is rounded on its own, so Kapital can differ from the unrounded equity (live.equity) by a cent or two.
 * cash (Tillgängligt): the free cash. The Kryptokonton summary shows the same figures.
 */
export function terminalFigures(account,live){
  const a=account,l=live??null;
  if(!a||!Array.isArray(a.positions))return {equity:null,cash:null,margin:null,open:null,result:null};
  // The rows Positioner shows: the live ones (with their results) when there are any.
  const rows=Array.isArray(l?.positions)?l.positions:a.positions,dollars=x=>x===null?null:x/100;
  let s=null;try{s=accountStats(a);}catch{s=null;}
  const margin=rows.every(p=>finite(held(p)))?rows.reduce((t,p)=>t+cents(held(p)),0):null;
  const open=l&&finite(l.openPnl)&&rows.every(p=>finite(p.pnl))?rows.reduce((t,p)=>t+cents(p.pnl),0):null;
  const result=open!==null&&finite(s?.net)?cents(s.net)+open:null;
  const equity=result!==null&&finite(a.start)&&finite(s.deposits)&&finite(s.withdrawals)?cents(a.start)+cents(s.deposits)-cents(s.withdrawals)+result:null;
  return {equity:dollars(equity),cash:finite(a.cash)?dollars(cents(a.cash)):null,margin:dollars(margin),open:dollars(open),result:dollars(result)};
}
// Trades and transfers in ledger order, newest first. A transfer's tradeCount is how many trades had closed before it.
function ledger(a){
  const trades=Array.isArray(a.trades)?a.trades:[],transfers=Array.isArray(a.transfers)?a.transfers:[],out=[];
  let k=0;
  for(let i=0;i<=trades.length;i++){
    while(k<transfers.length&&transfers[k].tradeCount<=i)out.push({transfer:transfers[k++]});
    if(i<trades.length)out.push({trade:trades[i]});
  }
  while(k<transfers.length)out.push({transfer:transfers[k++]});
  return out.reverse();
}

let mounts=0;
/**
 * mountTerminal(root,{runner,now,confirm,announce,prefs}) → {update(),destroy()}
 * root: the element under the chart that holds the terminal (the view's <section data-fc-terminal>). Its content is the
 *   terminal's; it also gets data-collapsed="true"|"false", for a layout that wants to know.
 * runner: the AI Forecast runner. Read: account(), live(), status(), for the SL/TP previews quoteLevels(id,levels), and
 *   when present limits(symbol) for the coin's price tick. Called: closePosition(id), setLevels(id,{sl}|{tp}),
 *   transfer({kind,amount}) and setFree(amount).
 * now(): the clock in ms. confirm(message): whether to go ahead (true, or a promise of it); the default asks the browser.
 * announce(text): tells screen readers an action's result, and how a position closed when the terminal did not ask (the
 *   view's polite live region); without it the terminal's own message line is a live region.
 * prefs: where the folded state and the open tab are kept: a localStorage-like store (getItem/setItem, under the key
 *   TERMINAL_PREFS), a {get(key),set(key,value)} store, or a function returning either; default localStorage. Optional,
 *   so every access is guarded.
 * update(): paints from the runner; call it on every refresh and onChange. Typing, drafts and keyboard focus survive it
 *   (a draft until its level is changed another way, such as a drag on the chart). The news of a close goes at the first
 *   update after TERMINAL_NOTICE_MS.
 * destroy(): removes the terminal's content and listeners.
 */
export function mountTerminal(root,deps={}){
  const {runner=null,now=()=>Date.now(),confirm=message=>globalThis.confirm?globalThis.confirm(message):true,announce=null,prefs=null}=deps??{};
  if(!root||typeof root.querySelector!=='function')throw Error('Kontoterminalen saknar sin plats i sidan');
  const uid='fct'+(++mounts),speak=typeof announce==='function'?announce:null;
  const clock=()=>{try{const t=now();return finite(t)?t:Date.now();}catch{return Date.now();}};
  const read=f=>{try{return f();}catch{return null;}};
  // Executed and risk prices (entry, price, liquidation, exit) with the decimals of the coin's tick on Bybit, as the
  // runner writes them ('Köpte 0,001 BTC till 85 674,4'). The tick comes from the limits the runner holds and is kept
  // once seen (null until then, and the chart's decimals meanwhile).
  const ticks=new Map();
  function tickOf(symbol){
    const f=typeof runner?.limits==='function'?read(()=>runner.limits(symbol))?.filters:null;
    if(finite(f?.tickSize)&&f.tickSize>0)ticks.set(symbol,stepDecimals(f.tickSize));
    return ticks.get(symbol)??null;
  }
  const priceDecimals=(symbol,x)=>tickOf(symbol)??magnitude(x);

  // The folded state and the open tab, per browser.
  const prefStore=()=>{try{const p=typeof prefs==='function'?prefs():prefs;return p??globalThis.localStorage??null;}catch{return null;}};
  function loadPrefs(){
    try{
      const s=prefStore();let v=null;
      if(typeof s?.getItem==='function')v=JSON.parse(s.getItem(TERMINAL_PREFS)??'null');
      else if(typeof s?.get==='function')v=s.get(TERMINAL_PREFS);
      return v&&typeof v==='object'?v:{};
    }catch{return {};}
  }
  function savePrefs(){
    const v={collapsed,tab};
    try{const s=prefStore();if(typeof s?.setItem==='function')s.setItem(TERMINAL_PREFS,JSON.stringify(v));else if(typeof s?.set==='function')s.set(TERMINAL_PREFS,v);}
    catch{/* the choice is optional */}
  }
  const kept=loadPrefs();
  let collapsed=kept.collapsed===true,tab=TERMINAL_TABS.includes(kept.tab)?kept.tab:'positions';

  const money$=`<span class="fct-unit" aria-hidden="true">$</span>`;
  const input=(name,label)=>`<span class="fct-money"><input id="${uid}-${name}" class="fct-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" `+
    `data-fct-${name} data-fct-key="${name}" aria-describedby="${uid}-${name}-preview" aria-label="${esc(label)}">${money$}</span>`;
  root.innerHTML=`<div class="fct" data-fct>`+
    `<div class="fct-head"><h2 class="fct-title" id="${uid}-title">Kontoterminal</h2>`+
      `<dl class="fct-figs">${FIGURES.map(([k,label])=>`<div class="fct-fig" data-fct-fig="${k}"><dt>${label}</dt><dd data-fct-val="${k}">–</dd></div>`).join('')}</dl>`+
      `<button type="button" class="fct-toggle" data-fct-toggle data-fct-key="toggle" aria-controls="${uid}-body" aria-expanded="true" aria-label="Kontoterminal" title="Dölj terminalen"><span aria-hidden="true" data-fct-glyph>${MINUS}</span></button></div>`+
    `<p class="fct-wait" data-fct-wait hidden></p>`+
    `<div class="fct-body" id="${uid}-body" data-fct-body>`+
      `<div class="fct-tabs" role="tablist" aria-labelledby="${uid}-title">${TERMINAL_TABS.map(name=>`<button type="button" class="fct-tab" role="tab" id="${uid}-tab-${name}" `+
        `aria-controls="${uid}-panel-${name}" aria-selected="false" tabindex="-1" data-fct-tab="${name}" data-fct-key="tab:${name}">${LABELS[name]}`+
        `${name==='positions'?' <span class="fct-count" data-fct-count></span>':''}</button>`).join('')}</div>`+
      // The message line shares one box with the panels: over 900 px the box keeps one height, so a message never
      // resizes the chart (forecast-terminal.css).
      `<div class="fct-view" data-fct-view><p class="fct-msg" data-fct-msg${speak?'':' role="status" aria-live="polite"'}></p>`+
      TERMINAL_TABS.map(name=>`<div class="fct-panel" role="tabpanel" id="${uid}-panel-${name}" aria-labelledby="${uid}-tab-${name}" tabindex="0" data-fct-panel="${name}" hidden>`+
        (name==='balance'?`<div class="fct-balance"><p class="fct-muted" data-fct-bal-line></p>`+
          `<div class="fct-form" role="group" aria-labelledby="${uid}-amount-label"><span class="fct-label" id="${uid}-amount-label">Sätt in eller ta ut</span>`+
            `<div class="fct-row">${input('amount','Belopp i $')}`+
            `<button type="button" class="fct-btn fct-primary" data-fct-transfer="in" data-fct-key="transfer:in" aria-describedby="${uid}-amount-preview">Sätt in</button>`+
            `<button type="button" class="fct-btn" data-fct-transfer="out" data-fct-key="transfer:out" aria-describedby="${uid}-amount-preview">Ta ut</button></div>`+
            `<ul class="fct-preview" id="${uid}-amount-preview" data-fct-amount-preview></ul></div>`+
          `<div class="fct-form" role="group" aria-labelledby="${uid}-free-label"><span class="fct-label" id="${uid}-free-label">Sätt tillgängligt till …</span>`+
            `<div class="fct-row">${input('free','Nytt tillgängligt saldo i $')}`+
            `<button type="button" class="fct-btn" data-fct-set-free data-fct-key="free:set" aria-describedby="${uid}-free-preview">Sätt tillgängligt</button></div>`+
            `<ul class="fct-preview" id="${uid}-free-preview" data-fct-free-preview></ul></div>`+
          `<p class="fct-note">Insättningar och uttag bokförs som egna rader i Historik och räknas inte som resultat: Resultat sedan start och max nedgång räknas utan dem. `+
            `Uttag tas bara från tillgängligt saldo, aldrig från marginalen i öppna positioner. Högst ${esc(money(ACCOUNT.transferMax).replace(',00',''))} per gång, i hela cent.</p></div>`:'')+
        `</div>`).join('')+
    `</div></div></div>`;
  const q=s=>root.querySelector(s),all=s=>[...root.querySelectorAll(s)];
  const by=(s,attr)=>Object.fromEntries(all(s).map(x=>[x.getAttribute(attr),x]));
  const el={box:q('[data-fct]'),toggle:q('[data-fct-toggle]'),glyph:q('[data-fct-glyph]'),body:q('[data-fct-body]'),wait:q('[data-fct-wait]'),view:q('[data-fct-view]'),msg:q('[data-fct-msg]'),
    count:q('[data-fct-count]'),vals:by('[data-fct-val]','data-fct-val'),tabs:by('[data-fct-tab]','data-fct-tab'),panels:by('[data-fct-panel]','data-fct-panel'),
    balLine:q('[data-fct-bal-line]'),amount:q('[data-fct-amount]'),amountPreview:q('[data-fct-amount-preview]'),free:q('[data-fct-free]'),
    freePreview:q('[data-fct-free-preview]'),deposit:q('[data-fct-transfer="in"]'),withdraw:q('[data-fct-transfer="out"]'),setFree:q('[data-fct-set-free]')};

  // identity: whose account is shown ('a:'+createdAt, 'out' signed out); drafts: typed SL/TP values per position and
  // level that are not saved yet ({text, base}: base is the level saved when the typing began); busy: the action under
  // way, one at a time.
  let destroyed=false,identity,account=null,live=null,st=null,busy=null,positionsKey=null,shown={history:TERMINAL_PAGE,events:TERMINAL_PAGE};
  // checked: the Saldo previews for what is typed now; msgTab: the tab whose action the message line speaks of (EVERY:
  // all of them); basis: the account as the message found it (stateOf); noticeAt: when the news of a close was shown.
  // seen: the positions open at the last read of this account, by id; noticed: those that read found closed. explain:
  // whether Så räknas siffrorna under the positions is open.
  let checked={amount:null,free:null},msgTab=null,basis=null,noticeAt=null,seen=new Map(),noticed=new Set(),explain=false;
  const drafts=new Map();
  const stateText=()=>st?.text?String(st.text):'AI Forecast-kontot kan inte läsas';
  // typing: the level field whose keystroke this read is for, if any.
  function snapshot(typing=null){
    st=runner?read(()=>runner.status()):null;
    account=runner?read(()=>runner.account()):null;
    live=account?read(()=>runner.live()):null;
    const who=account?'a:'+account.createdAt:st?.state==='signed-out'?'out':'none',before=seen;
    seen=new Map((Array.isArray(account?.positions)?account.positions:[]).map(p=>[p.id,p]));noticed=new Set();
    if(who===identity){
      if(!account)return;
      // News of a close the terminal did not ask for comes first. Otherwise the message goes once the account has changed
      // another way since it was shown (levels moved on the chart, an order, a signal entry, money moved in another tab),
      // so it never contradicts the rows, and the news of a close after its while; never while an action runs.
      const told=tellCloses(before);
      if(!told&&!busy&&el.msg.textContent&&(stateOf(account)!==basis||msgTab===EVERY&&finite(noticeAt)&&clock()-noticeAt>=TERMINAL_NOTICE_MS))message('',false);
      dropStale(typing);
      return;
    }
    // Another user, a reset or a sign-out: nothing typed or said for the last account carries over.
    const first=identity===undefined;identity=who;
    if(first)return;
    drafts.clear();positionsKey=null;shown={history:TERMINAL_PAGE,events:TERMINAL_PAGE};checked={amount:null,free:null};
    // Typed values live in the fields, not in the HTML: the panels are painted afresh even where their HTML is the same.
    for(const x of Object.values(el.panels))x.__fctHtml=null;
    el.amount.value='';el.free.value='';message('',false);
  }
  // A position open at the last read and gone now closed without this terminal asking: its SL or TP, a liquidation, a
  // time stop, an opposite signal, or Stäng in another tab. Its row goes, so the message line says how it closed, on
  // every tab, and screen readers hear it, once. A position the action under way closed is that action's answer to tell.
  // Whether it told one.
  function tellCloses(before){
    const texts=[],trades=Array.isArray(account.trades)?account.trades:[];
    for(const id of before.keys()){
      if(seen.has(id)||id===busy?.id)continue;
      const t=trades.findLast(x=>x.id===id);
      if(t){noticed.add(id);texts.push(closeText(t));}
    }
    if(!texts.length)return false;
    const text=texts.join('; ');
    message(text,'note',EVERY);say(text);
    return true;
  }
  // 'Stopp: lång SOL (manuell) stängdes kl. 08:11 till 120,08 · −0,24 $': when it closed (after the date when that is
  // not today), so the news never reads as fresher than it is; a close by Stäng as the runner says its own.
  function closeText(t){
    const what=(SIDE[t.side]??String(t.side))+' '+t.symbol+(t.origin==='manual'?' (manuell)':'');
    const at=' '+when(t.closedAt,clock(),'kl.\xa0')+' till '+price(t.exit,priceDecimals(t.symbol,t.entry))+' · '+signedMoney(t.pnl);
    return t.reason==='manuell'?'Stängde '+what+at:(REASONS[t.reason]??String(t.reason))+': '+what+' stängdes'+at;
  }
  // A draft typed against a level that has changed since (dragged on the chart, set or removed in another tab) goes, and
  // its field shows the level as saved: what was done last stands, and Spara or Enter cannot put the old typing over it.
  // A keystroke in that very field is newer than the change: its typing stays, now against the level as it is.
  function dropStale(typing){
    for(const [k,d] of drafts){
      const i=k.lastIndexOf('|'),id=k.slice(0,i),level=k.slice(i+1),p=seen.get(id);
      if(!p){drafts.delete(k);continue;}
      const saved=p[level]??null;
      if(saved===d.base||saved!==null&&d.base!==null&&same(saved,d.base))continue;
      const x=levelField(id,level);
      if(x&&x===typing){d.base=saved;continue;}
      drafts.delete(k);
      if(x)x.value=levelInput(saved,tickOf(p.symbol));
    }
  }
  // An action's message shows on the tab where it was taken (screen readers hear it through announce wherever they are);
  // a close the terminal did not ask for shows on every tab. tone: true for a refusal or an error, 'note' for news (such
  // a close, a level changed another way while it was typed). It speaks of the account as the last read found it.
  const shownHere=()=>msgTab===EVERY||msgTab===tab;
  function message(text,tone,where=tab){
    el.msg.textContent=bind(text);el.msg.classList.toggle('bad',tone===true);el.msg.classList.toggle('note',tone==='note');
    msgTab=where;el.msg.hidden=!text||!shownHere();
    basis=text&&account?stateOf(account):null;noticeAt=text&&where===EVERY?clock():null;
  }
  function say(text){if(speak)try{speak(bind(text));}catch{/* the view's problem */}}
  // A refusal on the spot (nothing went to the runner): shown, and told to screen readers like a runner's answer.
  function refuse(text,bad=true){message(text,bad);say(text);}

  // Re-renders a region only when its HTML changed, and keeps keyboard focus (and an input's caret) on the same
  // control. A control that is gone or disabled hands focus to the next sensible one, never to the page.
  const byKey=(node,key)=>[...node.querySelectorAll('[data-fct-key]')].find(x=>x.getAttribute('data-fct-key')===key)??null;
  function rebuild(node,html){
    if(node.__fctHtml===html)return;
    const doc=node.ownerDocument??globalThis.document,active=doc?.activeElement,inside=!!active&&active!==node&&!!node.contains?.(active);
    const key=inside?active.getAttribute?.('data-fct-key'):null;
    let caret=null;
    if(inside&&active.localName==='input')try{caret=finite(active.selectionStart)?[active.selectionStart,active.selectionEnd]:null;}catch{caret=null;}
    node.innerHTML=html;node.__fctHtml=html;
    if(!inside)return;
    let x=key?byKey(node,key):null;
    if(!x||x.disabled)x=key&&/^(save|remove):/.test(key)?byKey(node,'level:'+key.slice(key.indexOf(':')+1)):null;
    x=x&&!x.disabled?x:node;
    x.focus?.({preventScroll:true});
    if(caret&&x.localName==='input'&&typeof x.setSelectionRange==='function')try{x.setSelectionRange(caret[0],caret[1]);}catch{/* not a text field */}
  }
  // While an action runs its control is only marked busy, so keyboard focus stays on it. When it ends, focus that the
  // browser dropped to the page (its control was removed or disabled) goes to `fallback`, unless the user moved on.
  // Chrome still names a control just disabled as focused until its next frame, and only then drops focus to the page.
  function holdFocus(fallback){
    const doc=root.ownerDocument??globalThis.document,from=doc?.activeElement;
    if(!from||!root.contains?.(from))return ()=>{};
    return ()=>{
      const at=doc.activeElement,lost=!at||at===doc.body||!!root.contains?.(at)&&!!at.disabled;
      if(destroyed||!lost)return;
      const x=typeof fallback==='function'?fallback():fallback;
      (x&&!x.disabled?x:el.panels[tab])?.focus?.({preventScroll:true});
    };
  }
  // A control disabled while it has keyboard focus first hands focus to `to` (its field), else to the open panel, so the
  // browser does not drop it to the page.
  function disable(x,off,to){
    if(!x||x.disabled===off)return;
    if(off&&(root.ownerDocument??globalThis.document)?.activeElement===x)(to&&!to.disabled?to:el.panels[tab])?.focus?.({preventScroll:true});
    x.disabled=off;
  }
  const markBusy=(x,on)=>{if(on)x.setAttribute('aria-disabled','true');else x.removeAttribute('aria-disabled');};
  const isBusy=x=>!!busy||x?.getAttribute?.('aria-disabled')==='true';

  // ---- Painting ------------------------------------------------------------------------------------------------
  function update(){
    if(destroyed)return;
    snapshot();
    paintHead();
    if(!collapsed)paintPanel();
  }
  const setClass=(x,cls)=>{if((x.getAttribute('class')??'')!==cls)x.setAttribute('class',cls);};
  function setText(x,text,cls){
    if(x.textContent!==text)x.textContent=text;
    if(cls!==undefined)setClass(x,cls);
  }
  function paintHead(){
    const a=account,l=live;
    // Built from the rows and the totals as they are shown, so they add up to the cent (terminalFigures).
    const f=terminalFigures(a,l);
    setText(el.vals.equity,money(f.equity),'');
    setText(el.vals.cash,money(f.cash),'');
    setText(el.vals.margin,money(f.margin),'');
    setText(el.vals.open,signedMoney(f.open),tone(f.open));
    setText(el.vals.result,signedMoney(f.result),tone(f.result));
    // Why figures are missing: a price or a settlement awaited, or no account (signed out, loading).
    const why=!a?stateText():l&&!finite(l.equity)?l.reason||'Väntar på färskt pris':'';
    setText(el.wait,bind(why));el.wait.hidden=!why;
    const n=a?.positions?.length??0;setText(el.count,n?String(n):'');
    el.box.classList.toggle('is-collapsed',collapsed);
    root.setAttribute('data-collapsed',String(collapsed));
    el.toggle.setAttribute('aria-expanded',String(!collapsed));
    el.toggle.setAttribute('title',collapsed?'Visa terminalen':'Dölj terminalen');
    setText(el.glyph,collapsed?'+':MINUS);
    el.body.hidden=collapsed;
  }
  function paintPanel(){
    for(const name of TERMINAL_TABS){
      const on=name===tab;
      el.tabs[name].setAttribute('aria-selected',String(on));el.tabs[name].setAttribute('tabindex',on?'0':'-1');
      el.panels[name].hidden=!on;
    }
    el.msg.hidden=!el.msg.textContent||!shownHere();
    // Positioner without a position is one line: over 900 px its box then takes just that (is-fit), and the chart the rest.
    el.view.classList.toggle('is-fit',tab==='positions'&&!positionRows().length);
    if(tab==='positions')paintPositions();
    else if(tab==='history')rebuild(el.panels.history,historyHtml());
    else if(tab==='events')rebuild(el.panels.events,eventsHtml());
    else paintBalance();
  }
  const empty=text=>`<p class="fct-empty">${esc(bind(text))}</p>`;

  // Positioner: the table is rebuilt when positions, their levels or the action under way change; prices, results,
  // margins and the previews of typed levels are written into it in place, so typing is never interrupted.
  function positionRows(){
    if(!account)return [];
    const rows=Array.isArray(live?.positions)?live.positions:null;
    return rows??account.positions.map(p=>({...p,price:null,mark:null,value:null,pnl:null,pnlPct:null}));
  }
  function paintPositions(){
    const panel=el.panels.positions,rows=positionRows(),ids=new Set(rows.map(p=>p.id));
    for(const k of drafts.keys())if(!ids.has(k.slice(0,k.lastIndexOf('|'))))drafts.delete(k);
    const dec=new Map(rows.map(p=>[p.id,priceDecimals(p.symbol,p.entry)]));
    const key=JSON.stringify([identity,account?'':stateText(),rows.map(p=>[p.id,p.symbol,p.side,p.origin,p.sl,p.tp,p.leverage,p.units,p.entry,dec.get(p.id)]),
      busy?[busy.kind,busy.id??null,busy.level??null]:null]);
    let closed=false;
    if(key!==positionsKey){
      // Så räknas siffrorna keeps the state the user left it in.
      const d=panel.querySelector('[data-fct-explain]');if(d)explain=d.hasAttribute('open');
      closed=[...panel.querySelectorAll('[data-fct-row]')].some(tr=>!ids.has(tr.getAttribute('data-fct-row')));
      positionsKey=key;rebuild(panel,positionsHtml(rows,dec));
    }
    for(const tr of panel.querySelectorAll('[data-fct-row]')){
      const p=rows.find(x=>x.id===tr.getAttribute('data-fct-row'));
      if(p)fillRow(tr,p,dec.get(p.id));
    }
    if(closed)afterClose(panel);
    pin(panel);
  }
  // Over a phone's width the result, the levels and Stäng keep to the panel's right edge, and where the table is wider
  // than the panel the columns before them scroll under them (forecast-terminal.css). Each is held off the edge by the
  // columns after it, at the widths the browser draws them (--fct-act: Stäng's, --fct-lv: the levels'). Those change
  // without a paint too (a font arrives, a phone turns, a finger's controls give way to a mouse's), so where the browser
  // can, the two head cells are watched. Hidden (another tab, folded) they measure nothing, and the last widths stay.
  const sizes=typeof globalThis.ResizeObserver==='function'?new globalThis.ResizeObserver(()=>{if(!destroyed)pin(el.panels.positions);}):null;
  let sized=null;
  function pin(panel){
    const t=panel.querySelector('table'),cell=k=>t.querySelector('thead th.'+k),width=k=>read(()=>cell(k).getBoundingClientRect().width);
    if(!t)return;
    if(sizes&&sized!==t){sized=t;sizes.disconnect();for(const k of ['fct-levels','fct-act']){const c=cell(k);if(c)sizes.observe(c);}}
    const act=width('fct-act'),lv=width('fct-levels');
    if(!(act>0&&lv>0))return;
    const style='--fct-act:'+Math.round(act*100)/100+'px;--fct-lv:'+Math.round(lv*100)/100+'px';
    if(t.getAttribute('style')!==style)t.setAttribute('style',style);
  }
  // A closed row leaves the panel at its scroll offset, which can put the row now on top half under the table's sticky
  // head. The table goes back to its first row, or, where what has keyboard focus (its row, or Så räknas siffrorna)
  // would then lie below the panel's edge, that goes just under the head.
  function afterClose(panel){
    if(!(panel.scrollTop>0))return;
    const doc=panel.ownerDocument??globalThis.document,a=doc?.activeElement,at=a&&a!==panel&&panel.contains?.(a)?a.closest?.('[data-fct-row]')??a:null;
    let to=0;
    if(at&&[panel,at].every(n=>typeof n.getBoundingClientRect==='function')){
      const box=panel.getBoundingClientRect(),b=at.getBoundingClientRect(),h=panel.clientHeight;
      const head=read(()=>panel.querySelector('thead')?.getBoundingClientRect().height)??0,y=b.top-box.top-(panel.clientTop||0)+panel.scrollTop;
      if(finite(h)&&h>0&&finite(y)&&y+b.height>h)to=Math.max(0,y-(finite(head)?head:0));
    }
    panel.scrollTop=to;
  }
  // The table keeps its semantics in the phones' card layout too (explicit roles: some browsers drop a table's own when
  // its display changes). data-label names a figure in a card. The result comes before the levels, and Stäng last: the
  // three stay at the panel's right edge (pin), so where the table is wider than the panel nothing lies over the SL and
  // TP editors and Stäng is always in view.
  const td=(attrs,html)=>`<td role="cell"${attrs?' '+attrs:''}>${html}</td>`;
  function positionsHtml(rows,dec){
    if(!account)return empty(stateText());
    // Where the order ticket is: up to the right on a wide screen, under the header on a tablet or a phone (the stylesheet
    // shows the one that holds). The buttons' names keep together on their line.
    if(!rows.length)return `<p class="fct-empty">Inga öppna positioner. Lägg en order med Köp\xa0/\xa0Lång eller Sälj\xa0/\xa0Kort `+
      `<span class="fct-wide">uppe till höger</span><span class="fct-narrow">längst upp</span>.</p>`;
    const head=['Coin','Sida','Typ','Hävstång','Antal','Entry','Pris','Likv.','Marginal','Resultat','SL / TP'];
    return `<table class="fct-table fct-positions" role="table"><caption class="fct-sr">Öppna positioner</caption><thead role="rowgroup"><tr role="row">`+
      head.map(h=>`<th scope="col" role="columnheader"${HEAD_CLASS[h]?` class="${HEAD_CLASS[h]}"`:''}>${h}</th>`).join('')+
      `<th scope="col" role="columnheader" class="fct-act"><span class="fct-sr">Stäng</span></th></tr></thead><tbody role="rowgroup">`+
      rows.map((p,i)=>positionRow(p,i,dec.get(p.id))).join('')+`</tbody></table>`+
      // One short line, and how the figures add up behind a disclosure, so on a phone the cards come right after the rows.
      `<p class="fct-hint">Skriv en ny nivå och tryck Spara eller Enter; Esc ångrar.</p>`+
      `<details class="fct-explain" data-fct-explain${explain?' open':''}><summary data-fct-key="explain">Så räknas siffrorna</summary>`+
      `<p>Nivån gäller från ändringen, och en signalposition vars nivå ändras blir manuell utan tidsstopp.</p>`+
      `<p>Marginal är positionens marginal plus avgiften för stängning som Bybit reserverar med den; raderna summeras till Marginal i bruk.</p>`+
      `<p>Resultat är vad positionen ger om den stängs nu, efter alla avgifter och funding; raderna summeras till Orealiserat resultat.</p>`+
      `<p>Resultat sedan start = nettot av stängda affärer i Historik + Orealiserat resultat, och Kapital = startkapitalet + insatt − uttaget i Saldo + Resultat sedan start, `+
      `alltså Tillgängligt plus det positionerna lämnar tillbaka om de stängs nu.</p>`+
      `<p>Varje belopp avrundas till hela cent, så summorna stämmer som de visas.</p></details>`;
  }
  function positionRow(p,i,dec){
    const id=esc(p.id),name=SIDE[p.side]+' '+p.symbol,closing=busy?.kind==='close'&&busy.id===p.id;
    return `<tr role="row" data-fct-row="${id}"><th scope="row" role="rowheader">${esc(p.symbol)}</th>`+
      td('',`<span class="fct-side ${p.side==='long'?'long':'short'}">${SIDE_CELL[p.side]??esc(p.side)}</span>`)+
      td('',`${p.origin==='manual'?'Manuell':'Signal'}<small data-fct-cell="stop"></small>`)+
      td('class="num" data-label="Hävstång"',esc(leverageText(p.leverage)))+td('class="num" data-label="Antal"',esc(qtyText(p.units)))+
      td('class="num" data-label="Entry"',esc(price(p.entry,dec)))+
      td('class="num" data-label="Pris" data-fct-cell="price"','–')+td('class="num" data-label="Likv." data-fct-cell="liq"','–')+
      td('class="num" data-label="Marginal" data-fct-cell="margin"','–')+
      td('class="num fct-pnl" data-label="Resultat" data-fct-cell="pnl"','<span data-fct-pnl>–</span><small data-fct-pct></small>')+
      td('class="fct-levels"',levelEditor(p,'sl',name,i)+levelEditor(p,'tp',name,i))+
      td('class="fct-act"',`<button type="button" class="fct-btn fct-close" data-fct-close="${id}" data-fct-key="close:${id}" aria-label="${esc('Stäng '+name)}"`+
        `${busy?' aria-disabled="true"':''}>${closing?'Stänger…':'Stäng'}</button>`)+`</tr>`;
  }
  function levelEditor(p,level,name,i){
    const k=p.id+'|'+level,key=esc(k),what=esc(LEVEL[level]+' för '+name),saved=p[level],draft=drafts.get(k);
    const doing=busy?.id===p.id&&busy.level===level?busy.kind:null,note=`${uid}-note-${i}-${level}`;
    return `<div class="fct-level"><span class="fct-level-name" aria-hidden="true">${LEVEL[level]}</span>`+
      `<input type="text" class="fct-input" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="ingen" data-fct-level="${level}" data-fct-id="${esc(p.id)}" `+
      `data-fct-key="level:${key}" value="${esc(draft?.text??levelInput(saved,tickOf(p.symbol)))}" aria-label="${what}" aria-describedby="${note}">`+
      `<button type="button" class="fct-btn" data-fct-save="${level}" data-fct-id="${esc(p.id)}" data-fct-key="save:${key}" aria-label="Spara ${what}"${busy?' aria-disabled="true"':''}>${doing==='save'?'Sparar…':'Spara'}</button>`+
      `<button type="button" class="fct-btn" data-fct-remove="${level}" data-fct-id="${esc(p.id)}" data-fct-key="remove:${key}" aria-label="Ta bort ${what}"`+
      `${saved===null?' disabled':busy?' aria-disabled="true"':''}>${doing==='remove'?'Tar bort…':'Ta bort'}</button>`+
      `<small class="fct-level-note" id="${note}" data-fct-note="${level}"></small></div>`;
  }
  const cell=(tr,name)=>tr.querySelector(`[data-fct-cell="${name}"]`);
  function fillRow(tr,p,dec){
    const t=clock(),reserve=finite(p.reserve)?p.reserve:0,pnl=cell(tr,'pnl');
    setText(cell(tr,'price'),p.price==null?'–':price(p.price,dec));
    setText(cell(tr,'liq'),p.liq>0?price(p.liq,dec):'–');
    // Bybit's position margin: the margin and the fee to close it reserves with a manual order's position, as Marginal i
    // bruk adds it up; the title gives the two parts.
    const m=cell(tr,'margin');
    setText(m,money(held(p)));
    const parts=reserve>0?'Marginal '+money(p.margin)+' + reserverad avgift för stängning '+money(reserve):null;
    if(m.getAttribute('title')!==parts){if(parts)m.setAttribute('title',parts);else m.removeAttribute('title');}
    setText(pnl.querySelector('[data-fct-pnl]'),p.pnl==null?'–':signedMoney(p.pnl));
    // The space keeps the two apart as text (a phone's card shows them on one line); a block line drops it.
    setText(pnl.querySelector('[data-fct-pct]'),p.pnl==null?'':' '+signedPct(p.pnlPct,1));
    setClass(pnl,('num fct-pnl '+tone(p.pnl)).trim());
    // A signal position ends at its time stop; a manual one has none.
    setText(cell(tr,'stop'),p.origin!=='manual'&&dated(p.deadline)?'tidsstopp '+when(p.deadline,t):'');
    for(const level of ['sl','tp']){
      const k=p.id+'|'+level,pick=attr=>[...tr.querySelectorAll(`[${attr}]`)].find(x=>x.getAttribute(attr)===level);
      const field=pick('data-fct-level'),save=pick('data-fct-save'),note=pick('data-fct-note'),s=editState(p,level,drafts.get(k)?.text);
      if(field)setClass(field,'fct-input'+(s.draft?' fct-draft':''));
      // Spara, focused when it has nothing left to save (just saved, or its level changed on the chart): focus to the field.
      disable(save,!s.savable,field);
      if(note)setText(note,bind(s.note),'fct-level-note'+(s.bad?' bad':''));
    }
  }
  // What Spara would do with the typed value: the level as Bybit's tick rounds it and the result if the position closed
  // there now ('Inte sparad: SL 84 900 · −8,40 $', the chart's drag tag after the words that tell it from the level the
  // position has), or why it would be refused. The runner's own check on a fresh price decides. draft: the field holds
  // something other than the level as saved (its frame is dashed).
  function editState(p,level,draft){
    if(draft===undefined)return {savable:false,note:'',bad:false,draft:false};
    const v=parseNumber(draft),name=LEVEL[level];
    if(v===null)return {savable:false,note:p[level]===null?'':'Ta bort tar bort '+name,bad:false,draft:p[level]!==null};
    if(!(v>0))return {savable:false,note:'Ange '+name+' som ett pris över 0',bad:true,draft:true};
    if(p[level]!==null&&same(v,p[level]))return {savable:false,note:'',bad:false,draft:false};
    const preview=typeof runner?.quoteLevels==='function'?read(()=>runner.quoteLevels(p.id,{[level]:v})):null;
    if(!preview)return {savable:true,note:'Inte sparad',bad:false,draft:true};
    if(!preview.ok)return {savable:true,note:String(preview.reasons?.[0]??''),bad:true,draft:true};
    const at=preview[level],result=level==='sl'?preview.slPnl:preview.tpPnl;
    return {savable:true,note:'Inte sparad: '+name+' '+levelText(at,tickOf(p.symbol))+(finite(result)?' · '+signedMoney(result):''),bad:false,draft:true};
  }

  // Historik: closed trades and the deposits and withdrawals among them, newest first, with the account's own measures.
  function historyHtml(){
    if(!account)return empty(stateText());
    const items=ledger(account),t=clock(),s=read(()=>accountStats(account));
    let html='';
    if(s){
      const parts=[s.trades+' avslut','vinstandel '+pct(s.winRate,1),'netto '+signedMoney(s.net),'max nedgång '+pct(s.maxDrawdown,1),
        'vinstfaktor '+(finite(s.profitFactor)?fixed(s.profitFactor,2):'–'),'avgifter '+money(s.fees),'funding '+signedMoney(-s.funding),'likvidationer '+s.liquidations];
      if(s.deposits||s.withdrawals)parts.push('insatt '+money(s.deposits),'uttaget '+money(s.withdrawals));
      html+=`<p class="fct-summary"><b>Kontots egen historik</b> ${esc(parts.join(' · '))}</p>`+
        `<p class="fct-hint">Uppmätt på kontots egna affärer sedan ${esc(dateText(account.createdAt))}. Netto och max nedgång räknas utan insättningar och uttag.</p>`;
    }
    if(!items.length)return html+empty('Inga avslut, insättningar eller uttag ännu.');
    const list=items.slice(0,shown.history);
    const head=['Entry','Exit','Antal','Hävstång','Resultat','Avgifter','Funding'],col=(h,cls)=>`<th scope="col" role="columnheader"${cls?` class="${cls}"`:''}>${h}</th>`;
    html+=`<table class="fct-table fct-history" role="table"><caption class="fct-sr">Historik, nyast först</caption><thead role="rowgroup"><tr role="row">`+
      `${col('Stängd')}${col('Coin')}${col('Sida')}${col('Typ')}${head.map(h=>col(h,'num')).join('')}${col('Orsak')}</tr></thead><tbody role="rowgroup">`;
    for(const x of list){
      if(x.transfer){
        const r=x.transfer,inn=r.kind==='in';
        html+=`<tr role="row" class="fct-transfer ${inn?'in':'out'}"><th scope="row" role="rowheader"><time>${esc(when(r.t,t))}</time></th>`+
          td('colspan="11"',`<b>${inn?'Insättning':'Uttag'}</b> ${esc(money(r.amount))} · tillgängligt efter ${esc(money(r.cashAfter))}`)+`</tr>`;
        continue;
      }
      const r=x.trade,dec=priceDecimals(r.symbol,r.entry);
      html+=`<tr role="row"><th scope="row" role="rowheader"><time>${esc(when(r.closedAt,t))}</time></th>`+td('',esc(r.symbol))+
        td('',`<span class="fct-side ${r.side==='long'?'long':'short'}">${SIDE_CELL[r.side]??esc(r.side)}</span>`)+td('',r.origin==='manual'?'Manuell':'Signal')+
        td('class="num" data-label="Entry"',esc(price(r.entry,dec)))+td('class="num" data-label="Exit"',esc(price(r.exit,dec)))+
        td('class="num" data-label="Antal"',esc(qtyText(r.units)))+td('class="num" data-label="Hävstång"',esc(leverageText(r.leverage)))+
        td(`class="${('num '+tone(r.pnl)).trim()}" data-label="Resultat"`,esc(signedMoney(r.pnl)))+td('class="num" data-label="Avgifter"',esc(money(r.fees)))+
        td('class="num" data-label="Funding"',esc(signedMoney(-r.funding)))+td('data-label="Orsak"',esc(REASONS[r.reason]??r.reason))+`</tr>`;
    }
    // Under the rows, as Positioner's hints: why an exit differs from the SL or TP it closed at.
    return html+'</tbody></table>'+more('history',list.length,items.length)+
      `<p class="fct-hint">Exit är fyllnadspriset: SL och TP utlöses på senaste pris och stängs som marknadsorder med ${esc(pct(ACCOUNT.slip,2))} slippage, så exit blir något sämre än nivån.</p>`;
  }
  const more=(kind,n,total)=>total>n?`<p class="fct-more"><button type="button" class="fct-btn" data-fct-more="${kind}" data-fct-key="more:${kind}">Visa fler</button>`+
    `<span>Visar ${n} av ${total}</span></p>`:'';
  // Händelser: the account's own log, newest first: openings, closes, refusals, level changes and transfers.
  function eventsHtml(){
    if(!account)return empty(stateText());
    const log=(Array.isArray(account.log)?account.log:[]).slice().reverse(),t=clock();
    if(!log.length)return empty('Inga händelser ännu.');
    const list=log.slice(0,shown.events);
    return `<ol class="fct-log">${list.map(e=>`<li${e.kind==='avvisad'?' class="no"':''}><time>${esc(when(e.t,t))}</time><span>${esc(bind(logText(e)))}</span></li>`).join('')}</ol>`+
      more('events',list.length,log.length);
  }

  // Saldo: the account's own deposit, withdraw and setFree run on a copy for the preview, as the runner runs them to book.
  function attempt(f){
    try{const next=f(),x=next.transfers.at(-1);return {ok:true,cash:next.cash,kind:x.kind,amount:x.amount};}
    catch(e){return {ok:false,reason:reasonOf(e)};}
  }
  function amountCheck(){
    const text=el.amount.value;
    if(checked.amount?.text===text&&checked.amount.account===account)return checked.amount;
    const v=parseNumber(text),t=clock();
    const r=v===null?{value:null,in:null,out:null}:{value:v,in:attempt(()=>deposit(account,v,t)),out:attempt(()=>withdraw(account,v,t))};
    return checked.amount={text,account,...r};
  }
  function freeCheck(){
    const text=el.free.value;
    if(checked.free?.text===text&&checked.free.account===account)return checked.free;
    const v=parseNumber(text);
    return checked.free={text,account,value:v,set:v===null?null:attempt(()=>setFree(account,v,clock()))};
  }
  const lines=(node,items)=>{
    const html=items.map(([text,cls])=>`<li${cls?` class="${cls}"`:''}>${esc(bind(text))}</li>`).join('');
    if(node.__fctHtml!==html){node.innerHTML=html;node.__fctHtml=html;}
  };
  function paintBalance(){
    const a=account;
    if(!a){
      const why=st?.state==='signed-out'?'Logga in för att ändra saldot':st?.state==='loading'||!st?'AI Forecast-kontot laddas':stateText();
      setText(el.balLine,'');
      for(const x of [el.amount,el.free,el.deposit,el.withdraw,el.setFree])disable(x,true,null);
      lines(el.amountPreview,[[why,'bad']]);lines(el.freePreview,[]);
      return;
    }
    const s=read(()=>accountStats(a));
    setText(el.balLine,'Startkapital '+money(a.start)+' · insatt '+money(s?.deposits)+' · uttaget '+money(s?.withdrawals)+' · tillgängligt '+money(a.cash));
    el.amount.disabled=el.free.disabled=false;
    const m=amountCheck(),f=freeCheck();
    if(m.value===null)lines(el.amountPreview,[['Ange ett belopp i $ att sätta in eller ta ut.','']]);
    else if(!m.in.ok&&!m.out.ok&&m.in.reason===m.out.reason)lines(el.amountPreview,[[m.in.reason,'bad']]);
    else lines(el.amountPreview,[m.in.ok?['Nytt tillgängligt saldo efter insättning: '+money(m.in.cash),'']:['Sätt in: '+m.in.reason,'bad'],
      m.out.ok?['Nytt tillgängligt saldo efter uttag: '+money(m.out.cash),'']:['Ta ut: '+m.out.reason,'bad']]);
    if(f.value===null)lines(el.freePreview,[['Ange hur mycket som ska vara tillgängligt; skillnaden sätts in eller tas ut.','']]);
    else if(!f.set.ok)lines(el.freePreview,[[f.set.reason,'bad']]);
    else lines(el.freePreview,[[(f.set.kind==='in'?'Insättning ':'Uttag ')+money(f.set.amount)+' · nytt tillgängligt saldo '+money(f.set.cash),'']]);
    // A button focused when it can no longer book (just booked, or the money changed elsewhere): focus to its field.
    disable(el.deposit,!m.in?.ok,el.amount);disable(el.withdraw,!m.out?.ok,el.amount);disable(el.setFree,!f.set?.ok,el.free);
    for(const x of [el.deposit,el.withdraw,el.setFree])markBusy(x,!!busy);
    setText(el.deposit,busy?.kind==='transfer'&&busy.dir==='in'?'Sätter in…':'Sätt in');
    setText(el.withdraw,busy?.kind==='transfer'&&busy.dir==='out'?'Tar ut…':'Ta ut');
    setText(el.setFree,busy?.kind==='free'?'Ändrar…':'Sätt tillgängligt');
  }

  // ---- Actions: all through the runner, one at a time --------------------------------------------------------------
  // Its result is shown only for the account that started it.
  async function act(start,task,done,fallback){
    if(busy||destroyed)return;
    const who=identity,regain=holdFocus(fallback),where=tab;
    busy=start;message(start.text,false,where);update();
    let r;
    try{r=await task();if(!r||typeof r.text!=='string')throw Error('inget svar');}
    catch(e){r={ok:false,text:start.fail+': '+reasonOf(e)};}
    // Read while the action still counts as under way: a position it closed is told by its answer, not as news.
    if(!destroyed)snapshot();
    busy=null;
    if(destroyed)return;
    if(identity===who){done?.(r);message(r.text,!r.ok,where);say(r.text);}
    update();regain();
  }
  const positionOf=id=>account?.positions?.find(x=>x.id===id)??null;
  // A position the runner no longer holds: said so, unless the read that found it gone has just told how it closed.
  function closedMeanwhile(id){if(!noticed.has(id))refuse('Positionen är redan stängd',false);update();}
  // Each action checks against the account as the runner holds it when it is asked for.
  async function closeOne(id){
    if(busy||destroyed)return;
    snapshot();
    const p=positionOf(id);
    if(!p){closedMeanwhile(id);return;}
    const row=positionRows().find(x=>x.id===id),name=SIDE[p.side]+' '+p.symbol;
    let ok;
    try{ok=await confirm('Stäng '+name+' till marknadspris nu?'+(finite(row?.pnl)?' Resultat just nu: '+signedMoney(row.pnl)+'.':'')+' Hela positionen stängs i demokontot.');}catch{ok=false;}
    if(!ok||destroyed)return;
    await act({kind:'close',id,text:'Stänger '+name+'…',fail:'Kunde inte stänga '+p.symbol},()=>runner.closePosition(id),null,()=>el.panels.positions);
  }
  const levelField=(id,level)=>[...el.panels.positions.querySelectorAll('[data-fct-level]')].find(x=>x.getAttribute('data-fct-id')===id&&x.getAttribute('data-fct-level')===level)??null;
  // A signal position whose level changes by hand becomes manual and loses its time stop: asked first, as the chart asks.
  // value: the new level (as Bybit's tick rounds it, when the preview has it), or null to remove the level.
  async function manualOk(p,level,value){
    if(p.origin==='manual')return true;
    const r=value!==null&&typeof runner?.quoteLevels==='function'?read(()=>runner.quoteLevels(p.id,{[level]:value})):null;
    // Within half of Bybit's tick of the level it has: nothing changes, so there is nothing to ask.
    if(r?.ok&&!r.changed)return true;
    const name=LEVEL[level],at=r?.changed&&finite(r[level])?r[level]:value;
    let ok;
    try{ok=await confirm((value===null?'Ta bort '+name:'Flytta '+name+' till '+levelText(at,tickOf(p.symbol)))+' för signalpositionen '+SIDE[p.side]+' '+p.symbol+'?\n'+
      'Positionen hanteras då manuellt: inget tidsstopp och ingen stängning på en motsatt signal.');}catch{ok=false;}
    return !!ok&&!destroyed;
  }
  async function saveLevel(id,level){
    if(busy||destroyed)return;
    const k=id+'|'+level,had=drafts.has(k);
    snapshot();
    const p=positionOf(id);
    if(!(level in LEVEL))return;
    if(!p){closedMeanwhile(id);return;}
    // The level changed another way since the typing began, and this read is the first to see it: the field now shows
    // the level as it is, and saying so keeps Spara from looking as if it did nothing.
    if(had&&!drafts.has(k)){
      const x=p[level]??null,name=LEVEL[level];
      const text=x===null?name+' togs bort medan du skrev. Skriv in nivån igen om du vill sätta den.':name+' ändrades till '+levelText(x,tickOf(p.symbol))+' medan du skrev. Skriv in nivån igen om du vill flytta den.';
      message(text,'note');say(text);update();return;
    }
    const v=parseNumber(drafts.get(k)?.text??levelField(id,level)?.value);
    if(v===null||!(v>0)){refuse('Ange '+LEVEL[level]+' som ett pris över 0');return;}
    if(p[level]!==null&&same(v,p[level]))return;
    if(!(await manualOk(p,level,v)))return;
    const what=LEVEL[level]+' för '+SIDE[p.side]+' '+p.symbol;
    await act({kind:'save',id,level,text:'Sparar '+what+'…',fail:'Kunde inte ändra SL och TP för '+p.symbol},()=>runner.setLevels(id,{[level]:v}),
      r=>{if(r.ok)drafts.delete(k);},()=>levelField(id,level));
  }
  async function removeLevel(id,level){
    if(busy||destroyed)return;
    snapshot();
    const p=positionOf(id);
    if(!(level in LEVEL))return;
    if(!p){closedMeanwhile(id);return;}
    if(p[level]===null)return;
    if(!(await manualOk(p,level,null)))return;
    const k=id+'|'+level,what=LEVEL[level]+' för '+SIDE[p.side]+' '+p.symbol;
    await act({kind:'remove',id,level,text:'Tar bort '+what+'…',fail:'Kunde inte ändra SL och TP för '+p.symbol},()=>runner.setLevels(id,{[level]:null}),
      r=>{if(r.ok)drafts.delete(k);},()=>levelField(id,level));
  }
  // Esc: the typed value goes, the saved level comes back.
  function revert(x){
    const id=x.getAttribute('data-fct-id'),level=x.getAttribute('data-fct-level'),p=positionOf(id),k=id+'|'+level;
    if(!drafts.has(k))return false;
    drafts.delete(k);x.value=levelInput(p?.[level]??null,p?tickOf(p.symbol):null);
    update();
    return true;
  }
  async function transferOne(kind){
    if(busy||destroyed)return;
    snapshot();
    if(!account||kind!=='in'&&kind!=='out')return;
    const m=amountCheck(),check=kind==='in'?m.in:m.out;
    if(!check?.ok){refuse(check?.reason||'Ange ett belopp i $');return;}
    await act({kind:'transfer',dir:kind,text:(kind==='in'?'Sätter in ':'Tar ut ')+money(m.value)+'…',fail:'Kunde inte ändra saldot'},
      ()=>runner.transfer({kind,amount:m.value}),r=>{if(r.ok){el.amount.value='';checked.amount=null;}},()=>el.amount);
  }
  async function freeOne(){
    if(busy||destroyed)return;
    snapshot();
    if(!account)return;
    const f=freeCheck();
    if(!f.set?.ok){refuse(f.set?.reason||'Ange ett belopp i $');return;}
    await act({kind:'free',text:'Ändrar tillgängligt saldo till '+money(f.value)+'…',fail:'Kunde inte ändra saldot'},
      ()=>runner.setFree(f.value),r=>{if(r.ok){el.free.value='';checked.free=null;}},()=>el.free);
  }
  function select(name,focus){
    if(!TERMINAL_TABS.includes(name))return;
    tab=name;savePrefs();update();
    if(focus)el.tabs[name].focus?.();
  }
  function toggle(){
    collapsed=!collapsed;savePrefs();update();
  }

  // ---- Events ---------------------------------------------------------------------------------------------------
  const onClick=e=>{
    const hit=s=>e.target?.closest?.(s),attr=(x,name)=>x.getAttribute(name);
    let b;
    if(hit('[data-fct-toggle]'))toggle();
    else if((b=hit('[data-fct-tab]')))select(attr(b,'data-fct-tab'),false);
    else if((b=hit('[data-fct-close]'))){if(!isBusy(b))void closeOne(attr(b,'data-fct-close'));}
    else if((b=hit('[data-fct-save]'))){if(!isBusy(b)&&!b.disabled)void saveLevel(attr(b,'data-fct-id'),attr(b,'data-fct-save'));}
    else if((b=hit('[data-fct-remove]'))){if(!isBusy(b)&&!b.disabled)void removeLevel(attr(b,'data-fct-id'),attr(b,'data-fct-remove'));}
    else if((b=hit('[data-fct-transfer]'))){if(!isBusy(b)&&!b.disabled)void transferOne(attr(b,'data-fct-transfer'));}
    else if((b=hit('[data-fct-set-free]'))){if(!isBusy(b)&&!b.disabled)void freeOne();}
    else if((b=hit('[data-fct-more]'))){const kind=attr(b,'data-fct-more');if(kind in shown){shown[kind]+=TERMINAL_PAGE;update();}}
  };
  const onKey=e=>{
    const t=e.target,key=e.key;
    if(!t?.getAttribute||!root.contains?.(t))return;
    if(t.getAttribute('role')==='tab'){
      // Arrow keys, Home and End move between the tabs and open the one they reach.
      const i=TERMINAL_TABS.indexOf(t.getAttribute('data-fct-tab')),n=TERMINAL_TABS.length;
      const j=i<0?-1:key==='ArrowRight'?(i+1)%n:key==='ArrowLeft'?(i+n-1)%n:key==='Home'?0:key==='End'?n-1:-1;
      if(j<0)return;
      e.preventDefault?.();select(TERMINAL_TABS[j],true);
    }else if(t.hasAttribute('data-fct-level')){
      if(key==='Enter'){e.preventDefault?.();void saveLevel(t.getAttribute('data-fct-id'),t.getAttribute('data-fct-level'));}
      else if(key==='Escape'&&revert(t)){e.preventDefault?.();e.stopPropagation?.();}
    }else if(key==='Enter'&&t.hasAttribute('data-fct-free')){e.preventDefault?.();if(!busy&&!el.setFree.disabled)void freeOne();}
  };
  // The line under a field says what its value would do: a Saldo preview, or a level's note in Positioner. Over 900 px
  // the panel keeps one height and scrolls inside, so that line can lie below its edge (a message above the panel takes
  // a line of it). Moving into the field or typing in it scrolls the panel, never the page, just enough to show the line,
  // but never so far that the field itself goes under the panel's top (or the table's sticky head).
  const typed=x=>!!x?.hasAttribute&&(x.hasAttribute('data-fct-level')||x.hasAttribute('data-fct-amount')||x.hasAttribute('data-fct-free'));
  function reveal(x){
    show(x.closest?.('[data-fct-panel]'),x,x.hasAttribute('data-fct-level')?x.closest?.('.fct-level')?.querySelector?.('[data-fct-note]'):x.closest?.('.fct-form')?.querySelector?.('.fct-preview'));
  }
  // Scrolls `panel` down just enough to show `under` (what x says or holds), never so far that x goes under the panel's
  // top or the table's sticky head.
  function show(panel,x,under){
    if(!panel||!under||![panel,under,x].every(n=>typeof n?.getBoundingClientRect==='function'))return;
    const box=panel.getBoundingClientRect(),h=panel.clientHeight,bottom=finite(h)&&h>0?box.top+(panel.clientTop||0)+h:box.bottom;
    const head=read(()=>panel.querySelector('thead')?.getBoundingClientRect().height)??0;
    const down=Math.min(under.getBoundingClientRect().bottom-bottom,x.getBoundingClientRect().top-box.top-(finite(head)?head:0));
    if(down>0)panel.scrollTop+=down;
  }
  // A preview reads the account as the runner holds it now, not as the last paint saw it. A level's draft remembers the
  // level saved when its typing began.
  const onInput=e=>{
    const t=e.target;
    if(!typed(t)||destroyed)return;
    if(t.hasAttribute('data-fct-level')){
      snapshot(t);
      const id=t.getAttribute('data-fct-id'),level=t.getAttribute('data-fct-level'),k=id+'|'+level,p=positionOf(id),d=drafts.get(k),text=String(t.value??'');
      if(d)d.text=text;else if(p&&level in LEVEL)drafts.set(k,{text,base:p[level]??null});
      if(!collapsed&&tab==='positions'){paintPositions();reveal(t);}
    }else{snapshot();if(!collapsed&&tab==='balance'){paintBalance();reveal(t);}}
  };
  const onFocus=e=>{if(typed(e.target)&&!destroyed&&!collapsed)reveal(e.target);};
  // Så räknas siffrorna opened: what it holds comes into the panel's view, its summary kept in view. Its toggle event
  // does not bubble, so it is caught on the way down.
  const onToggle=e=>{const d=e.target;if(!destroyed&&d?.hasAttribute?.('data-fct-explain')&&d.hasAttribute('open'))show(d.closest?.('[data-fct-panel]'),d.querySelector?.('summary'),d);};
  root.addEventListener?.('click',onClick);root.addEventListener?.('keydown',onKey);root.addEventListener?.('input',onInput);root.addEventListener?.('focusin',onFocus);
  root.addEventListener?.('toggle',onToggle,true);

  function destroy(){
    if(destroyed)return;
    destroyed=true;
    root.removeEventListener?.('click',onClick);root.removeEventListener?.('keydown',onKey);root.removeEventListener?.('input',onInput);root.removeEventListener?.('focusin',onFocus);
    root.removeEventListener?.('toggle',onToggle,true);
    sizes?.disconnect();sized=null;
    root.innerHTML='';root.removeAttribute?.('data-collapsed');
  }
  update();
  return {update,destroy};
}
