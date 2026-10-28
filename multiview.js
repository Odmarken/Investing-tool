/* Multiview (#multiview): AI Forecast, kontots summary, nyheterna i detalj
   och Pablo scanning i samma fönster. Panelerna slås av och på
   var för sig, och valet sparas per fönster. De stora panelerna (AI Forecast,
   Konto, Nyheter) står bredvid varandra till vänster, Pablo scanning i en kolumn till
   höger. Dubbelfönster öppnar ett fönster till med egen Multiview —
   i desktop-appen hamnar det på den andra skärmen om du har två. Då tar grafen,
   med köp och sälj, hela fönstret man klickade i, och Pablo scanning och all info (AI
   Forecasts kort och terminal, kontot, nyheterna) flyttar till det nya.
   Ett fönster stänger det nya fönstret och ger tillbaka den vanliga vyn; det gör
   också att det nya stängs.

   Fönstret öppnas med window.open från det här fönstret, så att det får en
   kopia av sessionStorage: där ligger inloggningen när "Kom ihåg mig" är av.

   AI Forecast-vyn ägs av index.html (forecastRoute): den flyttas in i
   [data-mv-slot="forecast"] när Multiview visar den. onLayout() anropas när
   panelvalet ändras så att sidan kan flytta eller dölja den. */
import { mountCrawler } from './news-crawler.js';
import { mountNewsDesk } from './news-desk.js';
import { mountAccountPanel } from './account-panel.js';

export const PANELS = Object.freeze(['forecast', 'konto', 'nyheter', 'crawler']);
const LABEL = { forecast: '◭ AI Forecast', konto: 'Konto', nyheter: 'Nyheter', crawler: 'Pablo scanning' };
/* Vad AI Forecast-rutan visar: allt, bara grafen eller allt utom grafen. */
export const PARTS = Object.freeze(['all', 'chart', 'info']);
/* Dubbelfönster: grafen ensam i fönstret man klickade i, Pablo scanning och all info i det nya.
   with: grafens fönster, som infofönstret följer — det stängs när grafens fönster går tillbaka. */
export const DOUBLE = Object.freeze({
  chart: Object.freeze({ forecast: true, konto: false, nyheter: false, crawler: false, part: 'chart' }),
  info: Object.freeze({ forecast: true, konto: true, nyheter: true, crawler: true, part: 'info' })
});

/* Vilket fönster det här är: 1 för huvudfönstret, annars ?w=n i adressen. */
export function windowNumber(search = globalThis.location?.search || ''){
  const n = Number(new URLSearchParams(search).get('w'));
  return Number.isInteger(n) && n >= 2 && n < 100 ? n : 1;
}

/* Panelerna i ett fönster. Huvudfönstret börjar med AI Forecast och Pablo scanning;
   ett extra fönster med kontot och nyheterna — det är den andra skärmen. */
export function readLayout(raw, n = 1){
  const out = n > 1 ? { forecast: false, konto: true, nyheter: true, crawler: false }
    : { forecast: true, konto: false, nyheter: false, crawler: true };
  if(raw && typeof raw === 'object') for(const k of PANELS) if(typeof raw[k] === 'boolean') out[k] = raw[k];
  out.part = PARTS.includes(raw?.part) ? raw.part : 'all';
  if(Number.isInteger(raw?.with) && raw.with >= 1 && raw.with < 100 && raw.with !== n) out.with = raw.with;
  if(!PANELS.some(k => out[k])) out[n > 1 ? 'konto' : 'forecast'] = true;
  return out;
}

export function mountMultiview(root, { getSources, fetchFeed, isVisible = () => true, onLayout = () => {},
  forecastAccount = () => null, kryptoAccount = () => null, desktop = globalThis.riptideDesktop } = {}){
  const n = windowNumber();
  const key = 'riptide.multiview.v1.w' + n;
  let layout;
  try{ layout = readLayout(JSON.parse(localStorage.getItem(key) || 'null'), n); }catch{ layout = readLayout(null, n); }

  root.innerHTML = `<div class="mv-bar">
    <h1 id="multiviewTitle" tabindex="-1">Multiview${n > 1 ? ` <small>fönster ${n}</small>` : ''}</h1>
    <div class="mv-toggles" role="group" aria-label="Paneler">
      ${PANELS.map(k => `<button type="button" data-mv-toggle="${k}">${LABEL[k]}</button>`).join('')}
    </div>
    <span class="mv-msg" data-mv-msg role="status"></span>
    <button type="button" class="mv-btn" data-mv-double title="Öppna ett fönster till — till exempel för den andra skärmen">⧉ Dubbelfönster</button>
    <a class="mv-btn" href="#hub">⌂ Hem</a>
  </div>
  <div class="mv-body" data-mv-body>
    <div class="mv-main" data-mv-main>
      <div class="mv-slot" data-mv-slot="forecast"></div>
      <div class="mv-panel mv-big" data-mv-panel="konto"></div>
      <div class="mv-panel mv-big" data-mv-panel="nyheter"></div>
    </div>
    <div class="mv-side" data-mv-side>
      <div class="mv-panel" data-mv-panel="crawler"></div>
    </div>
  </div>`;
  const q = s => root.querySelector(s);
  const body = q('[data-mv-body]'), msg = q('[data-mv-msg]'), dbl = q('[data-mv-double]');
  let visible = false, msgTimer = null, otherTimer = null;

  const crawler = mountCrawler(q('[data-mv-panel="crawler"]'), {
    getSources, fetchFeed,
    isVisible: () => visible && layout.crawler && isVisible(),
    background: () => visible && layout.nyheter && isVisible(),
    onUpdate: () => desk.render()
  });
  const desk = mountNewsDesk(q('[data-mv-panel="nyheter"]'), { items: () => crawler.headlines() });
  const konto = mountAccountPanel(q('[data-mv-panel="konto"]'), { forecast: forecastAccount, krypto: kryptoAccount });

  function say(text){
    msg.textContent = text;
    clearTimeout(msgTimer); msgTimer = setTimeout(() => { msg.textContent = ''; }, 6000);
  }

  function apply(){
    for(const b of root.querySelectorAll('[data-mv-toggle]')) b.setAttribute('aria-pressed', String(!!layout[b.dataset.mvToggle]));
    const big = ['forecast', 'konto', 'nyheter'].filter(k => layout[k]).length, side = ['crawler'].filter(k => layout[k]).length;
    body.dataset.big = String(big); body.dataset.side = String(side);
    q('[data-mv-slot="forecast"]').hidden = !layout.forecast;
    q('[data-mv-slot="forecast"]').dataset.part = layout.part;
    const split = layout.part === 'chart';
    dbl.textContent = split ? '▣ Ett fönster' : '⧉ Dubbelfönster';
    dbl.title = split ? 'Tillbaka till den vanliga vyn i det här fönstret' : 'Grafen här, Pablo scanning och all info i ett fönster till — till exempel på den andra skärmen';
    for(const k of ['konto', 'nyheter', 'crawler']) q(`[data-mv-panel="${k}"]`).hidden = !layout[k];
    const on = k => visible && layout[k];
    if(on('crawler')) crawler.show(); else crawler.hide();
    if(on('nyheter')) desk.show(); else desk.hide();
    if(on('konto')) konto.show(); else konto.hide();
  }

  function setLayout(next){
    layout = readLayout(next, n);
    try{ localStorage.setItem(key, JSON.stringify(layout)); }catch{ /* valfritt */ }
    apply();
    onLayout();
  }
  function toggle(k, on = !layout[k]){
    const next = { ...layout, [k]: on };
    if(!PANELS.some(p => next[p])){ say('Minst en panel måste vara på.'); return; }
    setLayout(next);
  }
  for(const b of root.querySelectorAll('[data-mv-toggle]')) b.onclick = () => toggle(b.dataset.mvToggle);

  // Tillbaka från Dubbelfönster: fönstrets vanliga paneler, med hela AI Forecast.
  function single(){
    clearInterval(otherTimer); otherTimer = null;
    setLayout(readLayout(null, n));
  }
  // När det andra fönstret stängs tar det här tillbaka infon.
  function watchOther(w){
    clearInterval(otherTimer);
    otherTimer = setInterval(() => {
      if(!w.closed) return;
      clearInterval(otherTimer); otherTimer = null;
      if(layout.part === 'chart'){ single(); say('Det andra fönstret stängdes — allt är tillbaka här.'); }
    }, 1500);
  }

  dbl.onclick = async () => {
    if(layout.part === 'chart'){ single(); return; }
    let next = n + 1, features = 'popup,width=1400,height=900';
    if(desktop?.nextWindow){
      // Appen väljer numret och placerar fönstret på den andra skärmen.
      try{ next = await desktop.nextWindow(); }catch(e){ say('Kunde inte öppna fönstret: ' + e.message); return; }
    }else{
      // I webbläsaren: på den andra skärmen om webbläsaren får veta var den är (Chrome frågar först).
      try{
        const d = await globalThis.getScreenDetails?.();
        const other = d?.screens?.find(s => s !== d.currentScreen);
        if(other) features = `popup,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
      }catch{ /* ingen behörighet: fönstret öppnas där webbläsaren vill */ }
    }
    // Det nya fönstret läser sina paneler härifrån när det startar.
    try{ localStorage.setItem('riptide.multiview.v1.w' + next, JSON.stringify({ ...DOUBLE.info, with: n })); }catch{ /* valfritt */ }
    const w = window.open(`${location.pathname}?w=${next}#multiview`, 'riptide-w' + next, features);
    if(!w){ say('Fönstret stoppades. Tillåt popup-fönster för sidan.'); return; }
    setLayout(DOUBLE.chart);
    watchOther(w);
    say(`Grafen här, Pablo scanning och infon i fönster ${next}${desktop ? '' : ' — dra det till den andra skärmen'}.`);
  };

  // Infofönstret stängs när grafens fönster går tillbaka till ett fönster (Ett fönster där).
  window.addEventListener('storage', e => {
    if(layout.part !== 'info' || !layout.with || e.key !== 'riptide.multiview.v1.w' + layout.with) return;
    let other = null;
    try{ other = JSON.parse(e.newValue || 'null'); }catch{ return; }
    if(other?.part !== 'chart') window.close();
  });

  apply();
  return {
    show(){ visible = true; apply(); },
    hide(){ visible = false; crawler.hide(); desk.hide(); konto.hide(); },
    shows: k => !!layout[k],
    window: n
  };
}
