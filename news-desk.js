/* Nyheter i Multiview: Pablo scannings rubriker i detalj. Överst en översikt per mynt
   och makroord (antal rubriker, stiger- och faller-ord, senaste timmen); under
   den listan, där varje rubrik fälls ut till signalmotorns svenska förklaring,
   kategori, effekt på BTC, texten ur flödet och länken till källan.

   mountNewsDesk(root, {items, onAsk}) → {render, show, hide}
   items(): Pablo scannings fynd (news-crawler-core.js) — onAsk(item): fråga Claude om en rubrik */
import { analyseHeadline } from './motor.js';
import { overview, ago } from './news-crawler-core.js';

const KAT = { krypto: 'Krypto', nq: 'Nasdaq/teknik', macro: 'Makro och räntor', gold: 'Råvaror', '': 'Övrigt' };
const NAMN = { FED: 'Centralbanker', INFL: 'Inflation', NQ: 'Aktier' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Signalmotorns läsning av en rubrik, i den form panelen visar: effekten på BTC (−6…+6) i ord. */
export function readHeadline(it){
  const a = analyseHeadline(it.title, it.desc || '');
  const v = a.kr || 0;
  const strength = Math.abs(v) >= 3 ? 'stark' : Math.abs(v) === 2 ? 'tydlig' : Math.abs(v) === 1 ? 'svag' : 'ingen';
  return { ...a, btc: v, effect: v ? `${strength} ${v > 0 ? 'positiv' : 'negativ'} (${v > 0 ? '+' : ''}${v} av ±6)` : 'neutral',
    cats: (a.cats.length ? a.cats : ['']).map(k => KAT[k] || k) };
}

export function mountNewsDesk(root, { items = () => [], onAsk = null, now = () => Date.now() } = {}){
  root.innerHTML = `<section class="nd" aria-labelledby="ndTitle">
  <header class="mv-phead">
    <h2 id="ndTitle">Nyheter <small>i detalj</small></h2>
    <span class="cr-stat" data-nd-stat></span>
    <input class="nd-search" type="search" data-nd-search placeholder="Sök i rubrikerna…" aria-label="Sök i rubrikerna">
  </header>
  <div class="nd-over" data-nd-over role="group" aria-label="Filtrera på mynt eller ämne"></div>
  <ul class="nd-list" data-nd-list></ul>
</section>`;
  const q = s => root.querySelector(s);
  const el = { stat: q('[data-nd-stat]'), search: q('[data-nd-search]'), over: q('[data-nd-over]'), list: q('[data-nd-list]') };
  let pick = null, open = null, visible = false, lastKey = '';
  const cache = new Map();          // rubrik → motorns läsning, så att den inte görs om varje gång
  const read = it => { let r = cache.get(it.title); if(!r){ r = readHeadline(it); cache.set(it.title, r); } return r; };

  function render(force = false){
    if(!visible) return;
    const all = items(), t = now();
    const text = el.search.value.trim().toLowerCase();
    const key = JSON.stringify([all.length, all[0]?.title, pick, open, text, Math.floor(t / 60000)]);
    if(key === lastKey && !force) return;
    lastKey = key;

    const o = overview(all, { now: t });
    el.stat.textContent = `${o.total} rubriker · ${o.hour} senaste timmen`;
    el.over.innerHTML = `<button type="button" data-nd-pick="" aria-pressed="${!pick}"><b>Alla</b><span>${o.total}</span></button>` +
      o.rows.map(r => {
        const bal = r.up + r.down ? Math.round(r.up / (r.up + r.down) * 100) : 50;
        return `<button type="button" data-nd-pick="${esc(r.k)}" aria-pressed="${pick === r.k}" title="${r.n} rubriker: ${r.up} med stiger-ord, ${r.down} med faller-ord, ${r.hour} senaste timmen">
          <b>${esc(NAMN[r.k] || r.k)}</b><span>${r.n}${r.hour ? ` <i>+${r.hour}/h</i>` : ''}</span>
          <em class="nd-bal" style="--up:${bal}%"><s>▲${r.up}</s><s>▼${r.down}</s></em></button>`;
      }).join('');

    const shown = all.filter(it => (!pick || it.coins?.includes(pick) || it.macro?.includes(pick)) &&
      (!text || (it.title + ' ' + (it.desc || '') + ' ' + it.src).toLowerCase().includes(text)));
    el.list.innerHTML = shown.length ? shown.slice(0, 150).map(it => {
      const r = read(it), id = esc(it.title);
      const chip = r.btc ? `<i class="nd-eff ${r.btc > 0 ? 'up' : 'down'}">BTC ${r.btc > 0 ? '▲' : '▼'}${Math.abs(r.btc)}</i>` : '<i class="nd-eff">neutral</i>';
      const tags = [...(it.coins || []), ...(it.macro || [])].map(k => `<i class="cr-coin">${esc(k)}</i>`).join('');
      const isOpen = open === it.title;
      const when = new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }).format(new Date(it.ts));
      const href = /^https?:\/\//i.test(it.link) ? esc(it.link) : null;
      return `<li class="nd-item${r.hot ? ' hot' : ''}${isOpen ? ' open' : ''}" data-nd-id="${id}">
        <button type="button" class="nd-head" data-nd-toggle aria-expanded="${isOpen}">
          <span class="nd-meta"><span class="cr-src">${esc(it.src)}</span>${chip}${tags}<span class="cr-age">${ago(t - it.ts)}</span></span>
          <span class="nd-title">${esc(it.title)}</span>
          <span class="nd-sv">${esc(r.sv[0] || '')}</span>
        </button>
        ${isOpen ? `<div class="nd-more">
          <div class="nd-rad"><span>Källa <b>${esc(it.src)}</b></span><span>Publicerad <b>${esc(when)}</b> (${ago(t - it.ts)} sedan)</span>
            <span>Kategori <b>${esc(r.cats.join(', '))}</b></span><span>Effekt på BTC <b>${esc(r.effect)}</b></span>${r.hot ? '<span><b class="nd-hot">Högt läge</b></span>' : ''}</div>
          <h5>Vad det betyder</h5>${r.sv.length > 1 ? '<ul>' + r.sv.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '<p>' + esc(r.sv[0] || '') + '</p>'}
          ${it.desc ? `<h5>Ur flödet</h5><p>${esc(it.desc.slice(0, 420))}${it.desc.length > 420 ? '…' : ''}</p>` : ''}
          <div class="nd-actions">${href ? `<a class="mv-btn" href="${href}" target="_blank" rel="noopener noreferrer">Läs hos källan ↗</a>` : ''}
            ${onAsk ? '<button type="button" class="mv-btn mv-accent" data-nd-ask>Fråga Claude om den här</button>' : ''}</div>
        </div>` : ''}
      </li>`;
    }).join('') : `<li class="cr-empty">${all.length ? 'Inga rubriker matchar.' : 'Inga rubriker än — Pablo scanning hämtar dem i bakgrunden.'}</li>`;
  }

  el.over.onclick = e => {
    const b = e.target.closest('[data-nd-pick]');
    if(!b) return;
    pick = b.dataset.ndPick || null; render(true);
  };
  el.search.oninput = () => render(true);
  el.list.onclick = e => {
    const li = e.target.closest('[data-nd-id]');
    if(!li) return;
    const title = li.dataset.ndId ? li.querySelector('.nd-title').textContent : null;
    if(e.target.closest('[data-nd-ask]')){
      const it = items().find(x => x.title === title);
      if(it) onAsk?.(it, read(it));
      return;
    }
    if(e.target.closest('[data-nd-toggle]')){ open = open === title ? null : title; render(true); }
  };
  const timer = setInterval(() => render(), 5000);

  return {
    render: () => render(true),
    show(){ visible = true; render(true); },
    hide(){ visible = false; },
    destroy(){ clearInterval(timer); }
  };
}
