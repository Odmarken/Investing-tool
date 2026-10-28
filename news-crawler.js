/* Pablo scanning i Multiview. Pablos orb åker mellan nyhetssidorna i dina
   inställningar (kryptoflödena, de internationella och de svenska), hämtar
   sidans RSS på riktigt och fångar rubrikerna med sina strålar. Sidorna syns
   som standard (crawler-advanced.js); Nätet visar i stället alla sidor runt en
   mitt dit orben bär hem det den hittat. Under listas allt den hittat, nyast
   först, med mynt och ton, och Pablos summeringar: en per sida med nya rubriker,
   skriven av Claude (Opus 5.5) i desktop-appen och lokalt i webbläsaren.

   mountCrawler(root, {getSources, fetchFeed, isVisible, onAsk, background, onUpdate, summarize}) →
     {show, hide, crawlNow, headlines, summaries}
   getSources(): [{id,url,name,group}] — fetchFeed(url, source): [{title,link,ts,desc}]
   background(): true när någon annan panel (Nyheter) vill ha rubrikerna fast panelen inte syns —
   då hämtar den utan animation och utan summeringar. onUpdate(): efter varje sida den hämtat.
   summarize(prompt, onDelta) → {done, cancel} (connectSummary); null ger den lokala summeringen. */
import { mergeItems, headlineBrief, ago, summaryPrompt, localSummary, connectSummary } from './news-crawler-core.js';
import { paintOrb } from './orb-paint.js';
import { createPageReader } from './crawler-advanced.js';

const CACHE = 'riptide.crawler.v1';
const VIEW = 'riptide.pablo.view';           // 'page' (sidorna, standard) eller 'net'
const SUMS = 'riptide.pablo.summaries.v1';
const SUM_ON = 'riptide.pablo.summarize';
const EVERY = 5 * 60000;           // ett nytt varv fem minuter efter det förra
const MIN_FETCH = 900;             // orben stannar minst så här länge vid en sida
const QUEUE = 8;                   // fler sidor än så som väntar på en summering: de äldsta hoppas över
const C = { line: '#223040', web: 'rgba(120,200,170,', accent: '#3DDC84', warn: '#f0a020', down: '#e2483c', text: '#a9b6c4', muted: '#6f8094' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ease = t => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

export function mountCrawler(root, { getSources, fetchFeed, isVisible = () => true, onAsk = null, now = () => Date.now(),
  background = () => false, onUpdate = () => {}, summarize = connectSummary(),
  reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches } = {}){
  root.innerHTML = `<section class="cr" aria-labelledby="crTitle">
  <header class="mv-phead">
    <h2 id="crTitle">Pablo <small>scanning</small></h2>
    <span class="cr-stat" data-cr-stat></span>
    <div class="mv-pbtns">
      <button type="button" class="mv-btn" data-cr-adv aria-pressed="true" title="Se sidorna Pablo läser och hur orben fångar rubrikerna — av: nätet med alla sidor">Sidorna</button>
      <button type="button" class="mv-btn" data-cr-speed title="Hur fort Pablo läser sidorna" hidden>1×</button>
      <button type="button" class="mv-btn" data-cr-sum aria-pressed="true" title="Pablo summerar varje sida med nya rubriker">✦ Summera</button>
      <button type="button" class="mv-btn" data-cr-pause aria-pressed="false">Pausa</button>
      <button type="button" class="mv-btn" data-cr-now>↻ Scanna nu</button>
      <button type="button" class="mv-btn mv-accent" data-cr-ask title="Skicka rubrikerna till Claude-chatten">Fråga Claude</button>
    </div>
  </header>
  <div class="cr-stage" data-cr-stage><canvas data-cr-canvas role="img" aria-label="Pablos orb åker mellan nyhetssidorna"></canvas></div>
  <ol class="cr-log" data-cr-log aria-live="polite"></ol>
  <div class="cr-filter" role="group" aria-label="Visa">
    <button type="button" data-cr-filter="all" aria-pressed="true">Alla</button>
    <button type="button" data-cr-filter="coins" aria-pressed="false">Med mynt</button>
    <button type="button" data-cr-filter="new" aria-pressed="false">Nya i varvet</button>
    <button type="button" data-cr-filter="sum" aria-pressed="false">✦ Summeringar</button>
    <span class="cr-count" data-cr-count></span>
  </div>
  <ul class="cr-list" data-cr-list></ul>
</section>`;
  const q = s => root.querySelector(s);
  const el = { stage: q('[data-cr-stage]'), canvas: q('[data-cr-canvas]'), log: q('[data-cr-log]'), stat: q('[data-cr-stat]'),
    pause: q('[data-cr-pause]'), now: q('[data-cr-now]'), adv: q('[data-cr-adv]'), speed: q('[data-cr-speed]'), sum: q('[data-cr-sum]'),
    ask: q('[data-cr-ask]'), list: q('[data-cr-list]'), count: q('[data-cr-count]') };
  const ctx = el.canvas.getContext('2d');
  const reader = createPageReader({ ctx, reducedMotion });
  let advanced = true, sumOn = true;
  try{ advanced = localStorage.getItem(VIEW) !== 'net'; sumOn = localStorage.getItem(SUM_ON) !== '0'; }catch{ /* sidorna och summeringar som standard */ }

  let items = [], summaries = [], mounted = true;
  try{ const kept = JSON.parse(localStorage.getItem(CACHE) || '[]'); if(Array.isArray(kept)) items = kept.filter(x => x && x.title); }catch{ /* tom cache */ }
  try{ const kept = JSON.parse(localStorage.getItem(SUMS) || '[]'); if(Array.isArray(kept)) summaries = kept.filter(x => x && x.text); }catch{ /* inga än */ }
  let sources = [], visible = false, paused = false, running = false, nextAt = 0, cycleStart = 0, filter = 'all';
  let frame = null, size = { w: 0, h: 0, dpr: 1 }, pulse = 0, lastT = 0;
  const log = [];
  // Orben i nätet: på väg från a till b (0–1), vad den gör och vad den bär.
  const orb = { x: 0, y: 0, phase: 'rest', target: null, t: 0, dur: 1, carry: 0, done: null, trail: [] };
  let packets = [];

  /* ---------- nätet ---------- */
  function layout(){
    const { w, h } = size, cx = w / 2, cy = h / 2 + 4;
    // Plats för det längsta namnet på sidorna, så inget klipps vid kanten.
    ctx.font = '10px system-ui';
    const label = sources.reduce((m, s) => Math.max(m, ctx.measureText(s.name).width), 0);
    const rx = Math.max(40, w / 2 - Math.min(label + 18, w * .3)), ry = Math.max(30, h / 2 - 26);
    sources.forEach((s, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / sources.length;
      s.a = a; s.x = cx + Math.cos(a) * rx; s.y = cy + Math.sin(a) * ry;
    });
    return { cx, cy };
  }
  function center(){ return { x: size.w / 2, y: size.h / 2 + 4 }; }
  // Orben stannar en bit innanför sidan och lyser på den med en stråle.
  function stop(s){
    const c = center(), d = Math.hypot(s.x - c.x, s.y - c.y) || 1, k = Math.min(1, 28 / d);
    return { x: s.x + (c.x - s.x) * k, y: s.y + (c.y - s.y) * k };
  }

  function resize(){
    const r = el.stage.getBoundingClientRect(), dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    size = { w: Math.max(1, r.width), h: Math.max(1, r.height), dpr };
    el.canvas.width = Math.round(size.w * dpr); el.canvas.height = Math.round(size.h * dpr);
    el.canvas.style.width = size.w + 'px'; el.canvas.style.height = size.h + 'px';
    layout();
    reader.resize(size.w, size.h);
    if(orb.phase === 'rest'){ const c = center(); orb.x = c.x; orb.y = c.y; }
    draw();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  ro?.observe(el.stage);

  function draw(){
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if(advanced){ reader.draw(); return; }
    const { cx, cy } = layout();
    const n = sources.length;
    if(!n){ ctx.fillStyle = C.muted; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Inga nyhetsflöden i inställningarna', cx, cy); return; }

    // Ringarna: hänger lite inåt mellan trådarna, som ett nät.
    ctx.lineWidth = 1;
    for(const f of [.2, .36, .52, .68, .84, 1]){
      ctx.strokeStyle = C.web + (0.08 + f * 0.1) + ')';
      ctx.beginPath();
      for(let i = 0; i <= n; i++){
        const s = sources[i % n], p = sources[(i + n - 1) % n];
        const x = cx + (s.x - cx) * f, y = cy + (s.y - cy) * f;
        if(i === 0){ ctx.moveTo(x, y); continue; }
        const px = cx + (p.x - cx) * f, py = cy + (p.y - cy) * f;
        const mx = (px + x) / 2, my = (py + y) / 2;
        ctx.quadraticCurveTo(cx + (mx - cx) * .9, cy + (my - cy) * .9, x, y);
      }
      ctx.stroke();
    }
    // Trådarna ut till varje sida; den orben är på lyser.
    for(const s of sources){
      const on = orb.target === s && orb.phase !== 'rest';
      ctx.strokeStyle = on ? 'rgba(61,220,132,.75)' : C.web + '.22)';
      ctx.lineWidth = on ? 1.6 : 1;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(s.x, s.y); ctx.stroke();
    }
    // Mitten: dit allt bärs hem. Antalet står under, så orben kan vila på den.
    const glow = 10 + Math.sin(pulse * 2) * 2 + (orb.phase === 'unload' ? 6 : 0);
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, glow * 2.6);
    g.addColorStop(0, 'rgba(61,220,132,.45)'); g.addColorStop(1, 'rgba(61,220,132,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, glow * 2.6, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(61,220,132,.6)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(cx, cy, 17, 0, 7); ctx.stroke();
    ctx.font = '700 9px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const count = items.length + ' rubriker', cw = ctx.measureText(count).width + 10;
    ctx.fillStyle = 'rgba(11,15,20,.85)'; ctx.fillRect(cx - cw / 2, cy + 24, cw, 13);
    ctx.fillStyle = '#d7fbe6'; ctx.fillText(count, cx, cy + 31);

    // Sidorna.
    ctx.font = '10px system-ui'; ctx.textBaseline = 'middle';
    for(const s of sources){
      const color = s.status === 'ok' ? C.accent : s.status === 'fail' ? C.down : s.status === 'busy' ? C.warn : '#3a4a5a';
      if(s.status === 'busy'){
        const r = 8 + (pulse * 14 % 14);
        ctx.strokeStyle = `rgba(240,160,32,${1 - r / 22})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, 7); ctx.stroke();
      }
      ctx.fillStyle = '#0b0f14'; ctx.strokeStyle = color; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(s.x, s.y, 5.5, 0, 7); ctx.fill(); ctx.stroke();
      if(s.status === 'ok'){ ctx.fillStyle = color; ctx.beginPath(); ctx.arc(s.x, s.y, 2.4, 0, 7); ctx.fill(); }
      const right = Math.cos(s.a) >= -0.05, below = Math.sin(s.a) > .6, above = Math.sin(s.a) < -.6;
      const lx = s.x + (above || below ? 0 : right ? 10 : -10), ly = s.y + (below ? 14 : above ? -14 : 0);
      ctx.textAlign = above || below ? 'center' : right ? 'left' : 'right';
      ctx.fillStyle = s.status === 'fail' ? '#f47d72' : C.text;
      ctx.fillText(s.name, lx, ly);
      if(s.status === 'ok' && s.added > 0 && s.cycle === cycleStart){
        ctx.fillStyle = C.accent; ctx.font = '700 9px system-ui';
        ctx.fillText('+' + s.added, lx, ly + (above ? -11 : 11)); ctx.font = '10px system-ui';
      }
    }
    // Paketen: rubriker på väg in i mitten.
    for(const p of packets){
      const t = ease(Math.min(1, p.t)), x = p.x + (cx - p.x) * t, y = p.y + (cy - p.y) * t;
      ctx.fillStyle = `rgba(61,220,132,${1 - t * .6})`; ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 7); ctx.fill();
    }
    drawOrb();
  }

  function drawOrb(){
    const s = orb, fetching = s.phase === 'fetch' && s.target;
    const beams = fetching ? [{ x: s.target.x, y: s.target.y, a: .7 + .3 * Math.sin(pulse * 9) }] : [];
    paintOrb(ctx, { x: s.x, y: s.y, t: pulse, k: Math.max(.8, Math.min(1.5, size.w / 480)), power: fetching ? 1 : s.phase === 'unload' ? .7 : .2,
      carry: s.carry, beams, trail: s.trail });
  }

  /* ---------- rörelse ---------- */
  function loop(t){
    frame = null;
    if(!visible) return;
    const dt = Math.min(64, lastT ? t - lastT : 16); lastT = t;
    pulse += dt / 1000;
    if(advanced){ reader.update(dt); draw(); frame = requestAnimationFrame(loop); return; }
    const s = orb;
    if(s.phase === 'out' || s.phase === 'back'){
      s.t = Math.min(1, s.t + dt / s.dur);
      const e = ease(s.t);
      // Ändpunkterna räknas om varje bild: ändras panelens storlek mitt i en tur följer orben med.
      const [a, b] = ends();
      s.x = a.x + (b.x - a.x) * e; s.y = a.y + (b.y - a.y) * e;
      s.trail.push({ x: s.x, y: s.y }); if(s.trail.length > 12) s.trail.shift();
      if(s.t >= 1) finish();
    }else{
      if(s.phase === 'fetch' && s.target){ const p = stop(s.target); s.x = p.x; s.y = p.y; }
      s.trail.shift();
    }
    packets = packets.filter(p => (p.t += dt / 650) < 1);
    if(s.phase === 'unload' && !packets.length) finish();
    draw();
    frame = requestAnimationFrame(loop);
  }
  function start(){ if(visible && !frame && !reducedMotion()){ lastT = 0; frame = requestAnimationFrame(loop); } }
  function finish(){ const d = orb.done; orb.done = null; d?.(); }

  // Ut: från mitten till sidan orben är på väg till; hem: tillbaka.
  function ends(){
    const c = center(), n = orb.target ? stop(orb.target) : c;
    return orb.phase === 'back' ? [n, c] : [c, n];
  }
  // Åker ut eller hem; utan rörelse (dold panel eller reducerad rörelse) är den bara framme.
  function travel(phase){
    const s = orb;
    s.t = 0; s.phase = phase;
    const [a, to] = ends();
    const dist = Math.hypot(to.x - a.x, to.y - a.y);
    s.dur = Math.max(450, Math.min(1300, dist * 3.6));
    if(!visible || advanced || reducedMotion() || document.hidden){ s.x = to.x; s.y = to.y; s.trail.length = 0; draw(); return Promise.resolve(); }
    return new Promise(r => { s.done = r; start(); });
  }
  function unload(){
    const n = orb.carry;
    orb.carry = 0; orb.phase = 'unload';
    if(!n || !visible || advanced || reducedMotion() || document.hidden){ orb.phase = 'rest'; return Promise.resolve(); }
    // Rubrikerna sugs in i mitten från en ring runt den.
    const c = center();
    for(let i = 0; i < Math.min(n, 14); i++){ const a = Math.random() * 7, r = 22 + Math.random() * 16; packets.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r, t: -i * .12 }); }
    return new Promise(r => { orb.done = () => { orb.phase = 'rest'; r(); }; start(); });
  }

  /* ---------- scannandet ---------- */
  function say(text, kind = ''){
    log.push({ text, kind }); while(log.length > 3) log.shift();
    el.log.innerHTML = log.map(l => `<li class="${l.kind}">${esc(l.text)}</li>`).join('');
  }

  function refreshSources(){
    const old = new Map(sources.map(s => [s.url, s]));
    sources = (getSources?.() || []).map(s => Object.assign({ status: 'idle', added: 0, count: 0, cycle: 0 }, old.get(s.url) || {}, s));
    layout();
  }

  async function waitUntilFree(){
    while(paused || !(visible || background())){ await sleep(400); if(!mounted) return false; }
    return mounted;
  }

  async function crawl(){
    if(running) return;
    running = true; cycleStart = now();
    refreshSources();
    renderList();
    say(`Nytt varv: ${sources.length} sidor`);
    for(const s of sources){
      if(!(await waitUntilFree())) break;
      const page = advanced && visible;      // läget när besöket börjar gäller hela besöket; i bakgrunden ritas inga sidor
      if(page){ say(`→ åker till ${s.name}…`); await reader.loading(s); }
      else{
        say(`→ åker till ${s.name}…`);
        orb.target = s;   // tråden dit lyser medan den åker
        await travel('out');
        orb.phase = 'fetch';
      }
      s.status = 'busy';
      const [res] = await Promise.allSettled([Promise.resolve().then(() => fetchFeed(s.url, s)), sleep(reducedMotion() ? 0 : MIN_FETCH)]);
      s.cycle = cycleStart; s.at = now();
      const stamp = now();
      let found = null, fresh = [];
      if(res.status === 'fulfilled' && Array.isArray(res.value) && res.value.length){
        const merged = mergeItems(items, res.value, { now: stamp, source: s });
        items = merged.items; s.status = 'ok'; s.count = res.value.length; s.added = merged.added;
        orb.carry = page ? 0 : merged.added;
        found = res.value;
        fresh = items.filter(x => x.found === stamp);
        say(`✓ ${s.name}: ${s.count} rubriker, ${s.added} nya`, 'ok');
      }else{
        s.status = 'fail'; s.added = 0;
        say(`✕ ${s.name} svarade inte${res.reason?.message ? ' (' + res.reason.message.slice(0, 40) + ')' : ''}`, 'fail');
      }
      if(fresh.length && sumOn && visible) queueSummary(s, fresh);
      if(page){
        // Sidan i klartext: orbens egna fynd (med mynt) där de finns, annars posten som den kom.
        const mine = new Map(items.map(x => [x.title, x]));
        if(found) await reader.read(s, found.map(x => mine.get(x.title) || x), x => mine.get(x.title)?.found === stamp);
        else await reader.fail(s, res.reason?.message ? 'Sidan svarade inte: ' + res.reason.message.slice(0, 60) : 'Sidan svarade inte');
      }else{
        await travel('back');
        await unload();
      }
      renderList(); stat(); onUpdate();
    }
    orb.phase = 'rest'; orb.target = null;
    try{ localStorage.setItem(CACHE, JSON.stringify(items.slice(0, 160))); }catch{ /* full lagring */ }
    const fresh = items.filter(it => it.found >= cycleStart).length;
    say(`Varvet klart: ${fresh} nya rubriker. Vilar…`);
    running = false; nextAt = now() + EVERY;
    renderList(); stat(); draw();
  }

  /* ---------- summeringarna: en åt gången, medan orben åker vidare ---------- */
  const queue = [];
  let summing = false, job = null, listTimer = null;
  function queueSummary(source, fresh){
    queue.push({ source, fresh });
    while(queue.length > QUEUE) queue.shift();
    void drain();
  }
  async function drain(){
    if(summing) return;
    summing = true;
    while(queue.length && mounted && sumOn){
      const { source, fresh } = queue.shift();
      const entry = { src: source.name, link: source.url, n: fresh.length, at: now(), text: '', by: summarize ? 'Pablo' : 'lokal', busy: true };
      summaries.unshift(entry); if(summaries.length > 40) summaries.length = 40;
      reader.summary(entry); renderList();
      if(summarize){
        say(`✦ Pablo summerar ${source.name}…`);
        try{
          job = summarize(summaryPrompt(source.name, fresh), d => { entry.text += d; renderSoon(); });
          entry.text = String(await job.done || entry.text).trim();
          if(!entry.text) throw new Error('tomt svar');
        }catch(e){
          entry.text = localSummary(fresh); entry.by = 'lokal';
          say(`✕ Pablo kunde inte summera ${source.name}${e?.message ? ': ' + e.message.slice(0, 50) : ''}`, 'fail');
        }
        job = null;
      }else entry.text = localSummary(fresh);
      entry.busy = false;
      try{ localStorage.setItem(SUMS, JSON.stringify(summaries.filter(x => !x.busy))); }catch{ /* full lagring */ }
      renderList();
    }
    summing = false;
  }
  function renderSoon(){
    if(listTimer || filter !== 'sum') return;
    listTimer = setTimeout(() => { listTimer = null; renderList(); }, 150);
  }

  function stat(){
    const ok = sources.filter(s => s.cycle === cycleStart && s.status === 'ok').length;
    const fail = sources.filter(s => s.cycle === cycleStart && s.status === 'fail').length;
    const wait = running ? 'scannar' : paused ? 'pausad' : nextAt ? 'nästa varv om ' + clock(nextAt - now()) : 'startar…';
    el.stat.textContent = `${ok + fail}/${sources.length} sidor · ${fail ? fail + ' fel · ' : ''}${wait}`;
  }
  const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  function renderList(){
    const t = now();
    if(filter === 'sum'){
      el.count.textContent = `${summaries.length} summeringar`;
      el.list.innerHTML = summaries.length ? summaries.map(s => {
        const href = /^https?:\/\//i.test(s.link) ? esc(s.link) : null;
        const src = href ? `<a class="cr-src" href="${href}" target="_blank" rel="noopener noreferrer">${esc(s.src)}</a>` : `<span class="cr-src">${esc(s.src)}</span>`;
        const text = s.text || (s.busy ? 'Pablo summerar…' : '');
        return `<li class="cr-sum${s.busy ? ' busy' : ''}"><b class="cr-tone">✦</b><div class="cr-body"><p>${esc(text)}</p><div class="cr-meta">${src}<i>${s.n} ${s.n === 1 ? 'ny' : 'nya'}</i>${s.by === 'lokal' ? '<i>lokal</i>' : ''}<span class="cr-age">${ago(t - s.at)}</span></div></div></li>`;
      }).join('') : `<li class="cr-empty">${sumOn ? 'Inga summeringar än — Pablo skriver en när han hittar nya rubriker på en sida.' : 'Summeringarna är av. Slå på ✦ Summera.'}</li>`;
      return;
    }
    const shown = items.filter(it => filter === 'coins' ? it.coins?.length : filter === 'new' ? it.found >= cycleStart && cycleStart : true);
    el.count.textContent = `${shown.length} av ${items.length}`;
    el.list.innerHTML = shown.length ? shown.slice(0, 120).map(it => {
      const tone = it.tone > 0 ? '<b class="cr-tone up" title="Stiger-ord i rubriken">▲</b>' : it.tone < 0 ? '<b class="cr-tone down" title="Faller-ord i rubriken">▼</b>' : '<b class="cr-tone">•</b>';
      const tags = [...(it.coins || []).map(c => `<i class="cr-coin">${esc(c)}</i>`), ...(it.macro || []).map(m => `<i class="cr-macro">${esc(m)}</i>`)].join('');
      const fresh = cycleStart && it.found >= cycleStart ? '<i class="cr-new">NY</i>' : '';
      const href = /^https?:\/\//i.test(it.link) ? esc(it.link) : null;
      const title = href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>` : `<span>${esc(it.title)}</span>`;
      return `<li>${tone}<div class="cr-body">${title}<div class="cr-meta"><span class="cr-src">${esc(it.src)}</span>${tags}${fresh}<span class="cr-age">${ago(t - it.ts)}</span></div></div></li>`;
    }).join('') : `<li class="cr-empty">${items.length ? 'Inget i det här urvalet ännu.' : 'Pablo har inte hittat något ännu — han scannar så fort panelen syns.'}</li>`;
  }

  el.pause.onclick = () => {
    paused = !paused;
    el.pause.setAttribute('aria-pressed', String(paused)); el.pause.textContent = paused ? 'Fortsätt' : 'Pausa';
    say(paused ? 'Pausad.' : 'Fortsätter.'); stat();
  };
  el.now.onclick = () => { if(running) return; nextAt = 0; void crawl(); };
  function paintMode(){
    el.adv.setAttribute('aria-pressed', String(advanced));
    el.speed.hidden = !advanced;
    el.sum.setAttribute('aria-pressed', String(sumOn));
    el.canvas.setAttribute('aria-label', advanced ? 'Pablo scanning läser sidan och fångar de nya rubrikerna med orbens strålar' : 'Pablos orb åker mellan nyhetssidorna');
  }
  el.adv.onclick = () => {
    advanced = !advanced;
    try{ localStorage.setItem(VIEW, advanced ? 'page' : 'net'); }catch{ /* valfritt */ }
    // Det som pågår i det andra läget görs klart direkt; nästa sida visas i det nya.
    reader.setVisible(visible && advanced);
    finish();
    paintMode(); draw(); start();
  };
  el.speed.onclick = () => {
    const next = { 1: 2, 2: 4, 4: 1 }[reader.speed()] || 1;
    reader.speed(next); el.speed.textContent = next + '×';
  };
  el.sum.onclick = () => {
    sumOn = !sumOn;
    try{ localStorage.setItem(SUM_ON, sumOn ? '1' : '0'); }catch{ /* valfritt */ }
    if(!sumOn){ queue.length = 0; job?.cancel(); }
    say(sumOn ? '✦ Pablo summerar sidor med nya rubriker.' : 'Summeringarna är av.');
    paintMode(); renderList();
  };
  paintMode();
  el.ask.onclick = () => onAsk?.(headlineBrief(items, { now: now() }), items.length);
  el.ask.hidden = !onAsk;
  for(const b of root.querySelectorAll('[data-cr-filter]')) b.onclick = () => {
    filter = b.dataset.crFilter;
    for(const x of root.querySelectorAll('[data-cr-filter]')) x.setAttribute('aria-pressed', String(x === b));
    renderList();
  };

  // Ett dolt eller minimerat fönster ritar inga bilder: det som animeras görs klart direkt, så scannandet inte stannar.
  const onHidden = () => { if(document.hidden){ reader.flush(); finish(); } };
  document.addEventListener('visibilitychange', onHidden);
  const timer = setInterval(() => {
    if(!visible && !background()) return;
    stat();
    if(!running && !paused && now() >= nextAt) void crawl();
  }, 1000);

  refreshSources(); renderList();
  if(summaries[0]) reader.summary(summaries[0]);
  return {
    show(){
      visible = isVisible() !== false;
      reader.setVisible(visible && advanced);
      if(!visible) return;
      resize(); stat(); start();
      if(!running && !paused && now() >= nextAt) void crawl();
    },
    hide(){ visible = false; reader.setVisible(false); if(frame){ cancelAnimationFrame(frame); frame = null; } },
    crawlNow(){ el.now.click(); },
    headlines: () => items.slice(),
    summaries: () => summaries.filter(x => !x.busy).map(x => ({ ...x })),
    destroy(){ mounted = false; queue.length = 0; job?.cancel(); clearInterval(timer); clearTimeout(listTimer); ro?.disconnect(); document.removeEventListener('visibilitychange', onHidden); this.hide(); }
  };
}
