/* Konto i Multiview: en summary över demokontona att ha uppe på en egen skärm.
   Fliken AI Forecast visar kontot AI Forecast-vyn handlar (kapital live,
   resultat, marginal, öppna positioner med resultat och avstånd till
   likvidation, saldokurvan och de senaste avsluten). Fliken Kryptokonto visar
   standardkontots summary i kort form; hela finns på #summary.

   mountAccountPanel(root, {forecast, krypto}) → {render, show, hide}
   forecast(): {status, account, live} från AI Forecast-vyn — krypto(): kryptokontot (KRYPTO) */
import { accountStats, tradeReasons } from './forecast-account.js';
import { summarizeAccount } from './account-summary.js';

const finite = x => typeof x === 'number' && Number.isFinite(x);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (x, d = 2) => finite(x) ? x.toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–';
const money = x => finite(x) ? num(x) + ' $' : '–';
const signed = x => finite(x) ? (x > 0 ? '+' : '') + money(x) : '–';
const pct = (x, d = 1) => finite(x) ? num(x * 100, d) + ' %' : '–';
const tone = x => finite(x) ? (x > 0.005 ? 'pos' : x < -0.005 ? 'neg' : '') : '';
const price = x => finite(x) ? x.toLocaleString('sv-SE', { maximumSignificantDigits: 6 }) : '–';
const when = t => finite(t) && t > 0 ? new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' }).format(t) : '–';
const SIDE = { long: 'LONG', short: 'SHORT' };

/* Saldokurvan: startsaldot, kapitalet efter varje avslut och, när det finns, kapitalet live nu. */
export function equityPoints(account, live = null, now = Date.now()){
  if(!account) return [];
  const trades = (account.trades || []).filter(t => finite(t.closedAt) && finite(t.equityAfter));
  const first = trades[0]?.openedAt ?? trades[0]?.closedAt;
  const pts = trades.length ? [{ t: finite(first) ? first : trades[0].closedAt, v: account.start }] : [];
  for(const t of trades) pts.push({ t: t.closedAt, v: t.equityAfter });
  if(finite(live?.equity) && pts.length) pts.push({ t: Math.max(now, pts.at(-1).t), v: live.equity });
  return pts;
}

function curve(points, start){
  if(points.length < 2) return '<p class="ac-empty">Saldokurvan visas när kontot har avslutade affärer.</p>';
  const W = 600, H = 150, minT = points[0].t, maxT = Math.max(minT + 1, points.at(-1).t);
  let lo = Math.min(start, ...points.map(p => p.v)), hi = Math.max(start, ...points.map(p => p.v));
  const pad = Math.max(0.5, (hi - lo) * .1); lo -= pad; hi += pad;
  const x = t => 46 + (t - minT) / (maxT - minT) * (W - 56), y = v => 10 + (hi - v) / (hi - lo) * (H - 34);
  const path = points.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
  const up = points.at(-1).v >= start;
  const area = path + ` L${x(points.at(-1).t).toFixed(1)} ${y(lo).toFixed(1)} L${x(minT).toFixed(1)} ${y(lo).toFixed(1)} Z`;
  // Startlinjen får sin etikett bara när den inte krockar med topp- eller bottenetiketten.
  const marks = [hi - pad, lo + pad], startClear = marks.every(v => Math.abs(y(v) - y(start)) > 14);
  const line = (v, cls, label) => `<line x1="46" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" class="${cls}"/>${label ? `<text x="40" y="${y(v) + 4}" text-anchor="end">${num(v, 0)}</text>` : ''}`;
  const grid = marks.map(v => line(v, 'ac-grid', true)).join('') + line(start, 'ac-grid ac-base', startClear);
  return `<svg class="ac-curve ${up ? 'up' : 'down'}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Kapitalet efter varje avslut">${grid}
    <path class="ac-area" d="${area}"/><path class="ac-line" d="${path}"/>
    <text x="46" y="${H - 6}">${esc(when(minT))}</text><text x="${W - 10}" y="${H - 6}" text-anchor="end">${esc(when(maxT))}</text></svg>`;
}

export function mountAccountPanel(root, { forecast = () => null, krypto = () => null, now = () => Date.now() } = {}){
  let tab = 'forecast', visible = false, lastKey = '';
  try{ if(localStorage.getItem('riptide.multiview.konto') === 'krypto') tab = 'krypto'; }catch{ /* valfritt */ }
  root.innerHTML = `<section class="ac" aria-labelledby="acTitle">
  <header class="mv-phead">
    <h2 id="acTitle">Konto <small>summary</small></h2>
    <div class="ac-tabs" role="group" aria-label="Vilket konto">
      <button type="button" data-ac-tab="forecast">AI Forecast</button><button type="button" data-ac-tab="krypto">Kryptokonto</button>
    </div>
    <span class="cr-stat" data-ac-state></span>
  </header>
  <div class="ac-body" data-ac-body></div>
</section>`;
  const body = root.querySelector('[data-ac-body]'), state = root.querySelector('[data-ac-state]');
  const tile = (k, v, cls = '', sub = '') => `<div class="ac-tile"><span>${k}</span><b class="${cls}">${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;

  function forecastHtml(){
    const snap = forecast() || {}, a = snap.account, live = snap.live, st = snap.status;
    state.textContent = st?.text || '';
    state.dataset.state = st?.state || '';
    if(!a) return '<p class="ac-empty">AI Forecast-kontot laddas…</p>';
    const s = accountStats(a) || {}, eq = live?.equity, base = a.start + (finite(s.netTransfers) ? s.netTransfers : 0);
    const result = finite(live?.result) ? live.result : null;
    const t = now();
    const positions = (live?.positions || a.positions || []).map(p => {
      const toLiq = finite(p.toLiq) ? `<span class="${p.toLiq < .02 ? 'neg' : ''}">${pct(p.toLiq)}</span>` : '–';
      return `<tr><td><b>${esc(p.symbol)}</b><small>${p.origin === 'manual' ? 'manuell' : 'signal'} · ${esc(when(p.openedAt))}</small></td>
        <td><span class="ac-side ${esc(p.side)}">${SIDE[p.side] || '–'}</span><small>${num(p.leverage, 0)}×</small></td>
        <td>${price(p.entry)}<small>nu ${price(p.price)}</small></td>
        <td class="${tone(p.pnl)}">${signed(p.pnl)}<small>${finite(p.pnlPct) ? (p.pnlPct > 0 ? '+' : '') + pct(p.pnlPct) : ''}</small></td>
        <td>${p.sl === null || p.sl === undefined ? '–' : price(p.sl)}<small>TP ${p.tp === null || p.tp === undefined ? '–' : price(p.tp)}</small></td>
        <td>${price(p.liq)}<small>${toLiq}</small></td></tr>`;
    }).join('');
    const trades = (a.trades || []).slice(-12).reverse().map(x => `<tr><td>${esc(when(x.closedAt))}</td><td><b>${esc(x.symbol)}</b></td>
      <td><span class="ac-side ${esc(x.side)}">${SIDE[x.side] || '–'}</span></td><td class="${tone(x.pnl)}">${signed(x.pnl)}</td>
      <td>${esc(tradeReasons[x.reason] || x.reason || '–')}</td></tr>`).join('');
    return `<div class="ac-tiles">
      ${tile('Kapital · live', money(eq), '', live?.reason && !finite(eq) ? esc(live.reason) : `start ${money(a.start)}`)}
      ${tile('Sedan start', signed(result), tone(result), base > 0 && finite(result) ? (result > 0 ? '+' : '') + pct(result / base) : '')}
      ${tile('Tillgängligt', money(a.cash), '', `marginal i bruk ${money(live?.marginUsed)}`)}
      ${tile('Orealiserat', signed(live?.openPnl), tone(live?.openPnl), `${a.positions.length} öppna`)}
      ${tile('Vinstandel', pct(s.winRate, 0), '', `${s.wins ?? 0} vinster · ${s.losses ?? 0} förluster`)}
      ${tile('Vinstfaktor', finite(s.profitFactor) ? num(s.profitFactor) : '–', '', `max nedgång ${pct(s.maxDrawdown)}`)}
      ${tile('Avslutat netto', signed(s.net), tone(s.net), `${s.trades ?? 0} affärer · ${s.liquidations ?? 0} likv.`)}
      ${tile('Kostnader', money(s.fees), '', `funding ${signed(-(s.funding || 0))}`)}
    </div>
    <p class="ac-note">${a.settings?.auto ? 'Auto-handeln är på: kontot handlar AI Forecast-signalerna.' : 'Auto-handeln är av: bara dina egna order.'} Demokonto med Bybits priser, inga riktiga pengar.</p>
    <h3>Kapitalet över tid</h3>${curve(equityPoints(a, live, t), a.start)}
    <h3>Öppna positioner</h3>
    ${positions ? `<div class="ac-wrap"><table class="ac-table"><thead><tr><th>Coin</th><th>Sida</th><th>Entry</th><th>Resultat</th><th>SL</th><th>Likv.</th></tr></thead><tbody>${positions}</tbody></table></div>` : '<p class="ac-empty">Inga öppna positioner.</p>'}
    <h3>Senaste avslut</h3>
    ${trades ? `<div class="ac-wrap"><table class="ac-table"><thead><tr><th>Stängd</th><th>Coin</th><th>Sida</th><th>Resultat</th><th>Orsak</th></tr></thead><tbody>${trades}</tbody></table></div>` : '<p class="ac-empty">Inga avslut ännu.</p>'}`;
  }

  function kryptoHtml(){
    const k = krypto();
    state.textContent = ''; state.dataset.state = '';
    if(!k || !Array.isArray(k.affarer)) return '<p class="ac-empty">Kryptokontot laddas…</p>';
    const s = summarizeAccount(k, now());
    const open = k.oppen ? `<p class="ac-note">Öppen position: <b>${esc(k.oppen.inst || '')}</b> ${esc(SIDE[k.oppen.side] || '')}${finite(k.oppen.entry) ? ' från ' + price(k.oppen.entry) : ''}.</p>` : '';
    const rows = s.trades.slice(-12).reverse().map(t => `<tr><td>${esc(when(t.stangd))}</td><td><b>${esc(t.inst)}</b><small>${esc(t.namn || t.fam || '')}</small></td>
      <td><span class="ac-side ${esc(t.side)}">${SIDE[t.side] || '–'}</span></td><td class="${tone(t.pnl)}">${signed(t.pnl)}</td><td>${esc(t.hur || '–')}</td></tr>`).join('');
    const pts = s.trades.filter(t => finite(t.stangd) && t.after !== null).map(t => ({ t: t.stangd, v: t.after }));
    if(pts.length && s.trades[0].before !== null) pts.unshift({ t: s.trades[0].oppnad || pts[0].t, v: s.trades[0].before });
    return `<div class="ac-tiles">
      ${tile('Realiserat saldo', money(s.balance), '', `start ${money(s.start)}`)}
      ${tile('Netto', signed(s.net), tone(s.net), `avgifter ${money(s.fees)}`)}
      ${tile('Vinstandel', pct(s.winRate, 0), '', `${s.wins} vinster · ${s.losses} förluster`)}
      ${tile('Senaste 30 dagarna', signed(s.recentNet), tone(s.recentNet), `${s.recentCount} avslut`)}
    </div>
    <div class="ac-goal"><span>Mot 10 000 $</span><div class="ac-bar"><i style="width:${(s.progress * 100).toFixed(1)}%"></i></div><b>${pct(s.progress)}</b></div>
    ${open}
    <h3>Kapitalet över tid</h3>${curve(pts, s.start ?? 0)}
    <h3>Senaste avslut</h3>
    ${rows ? `<div class="ac-wrap"><table class="ac-table"><thead><tr><th>Stängd</th><th>Coin</th><th>Sida</th><th>Resultat</th><th>Avslut</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="ac-empty">Inga avslut ännu.</p>'}
    <p class="ac-note"><a href="#summary">Hela summaryn med all historik →</a></p>`;
  }

  function render(force = false){
    if(!visible) return;
    for(const b of root.querySelectorAll('[data-ac-tab]')) b.setAttribute('aria-pressed', String(b.dataset.acTab === tab));
    const html = tab === 'forecast' ? forecastHtml() : kryptoHtml();
    if(html === lastKey && !force) return;
    lastKey = html;
    const top = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = top;
  }
  for(const b of root.querySelectorAll('[data-ac-tab]')) b.onclick = () => {
    tab = b.dataset.acTab;
    try{ localStorage.setItem('riptide.multiview.konto', tab); }catch{ /* valfritt */ }
    render(true);
  };
  const timer = setInterval(() => render(), 2000);

  return {
    render: () => render(true),
    show(){ visible = true; render(true); },
    hide(){ visible = false; },
    destroy(){ clearInterval(timer); }
  };
}
