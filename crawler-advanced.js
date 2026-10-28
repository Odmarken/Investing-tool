/* Pablo scannings sidor: i stället för nätet syns sidan orben är på, som en
   webbläsare med adressfält och sidans text i klartext (rubrikerna och
   ingresserna ur flödet). Mellan sidorna åker orben upp till adressfältet och
   läser in nästa adress med en stråle, medan den gamla sidan glider ut och den
   nya in. På sidan svävar orben över texten och läser rubrikerna rad för rad med
   en stråle. En ny rubrik ramas in i grönt; orben låser strålar på den och drar
   upp den till Fångat till höger. En rubrik den redan har ramas in i grått och
   lämnas. Sidan rullar med nedåt, och vid botten åker orben vidare. Överst i
   Fångat står Pablos senaste summering.

   createPageReader({ctx, reducedMotion}) →
     {resize(w,h), loading(source), read(source, items, isNew), fail(source, reason), summary(entry),
      update(dt), draw(), setVisible(on), flush(), speed(n)}
   loading() är ett löfte: det håller när orben är framme vid adressfältet.
   summary(entry): {src, text, busy, by} — kortet ritas om varje bild, så samma entry kan växa medan svaret strömmar. */
import { paintOrb } from './orb-paint.js';
import { ago } from './news-crawler-core.js';

const READ = 14;                    // så många poster läser orben per sida; resten skummas
const C = { bar: '#151c25', page: '#0d1319', line: '#1e2833', text: '#e6edf3', desc: '#8796a7', meta: '#5d6e80', accent: '#3DDC84', warn: '#f0a020', down: '#e2483c' };
const F = { title: '600 12.5px system-ui, sans-serif', desc: '11px ui-monospace, Consolas, monospace', meta: '10px ui-monospace, Consolas, monospace', site: '700 15px system-ui, sans-serif', card: '11px system-ui, sans-serif' };
const LH = { title: 17, desc: 15, meta: 14, card: 14 };
const SLIDE = 650;                  // så länge sidbytet glider
const ease = t => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

/* Radbryter text till högst maxLines rader inom width; den sista får … om texten inte fick plats. */
export function wrapText(measure, text, width, maxLines = Infinity){
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for(let i = 0; i < words.length; i++){
    const next = line ? line + ' ' + words[i] : words[i];
    if(measure(next) <= width || !line){ line = next; continue; }
    lines.push(line); line = words[i];
    if(lines.length === maxLines) break;
  }
  if(line && lines.length < maxLines) lines.push(line);
  else if(lines.length === maxLines && lines.join(' ').length < words.join(' ').length){
    let last = lines[maxLines - 1];
    while(last && measure(last + '…') > width) last = last.slice(0, -1);
    lines[maxLines - 1] = last.replace(/\s+$/, '') + '…';
  }
  return lines;
}

export function createPageReader({ ctx, reducedMotion = () => false }){
  let size = { w: 1, h: 1 }, geo = null, page = null, scroll = 0, rate = 1, visible = false;
  let anim = null, flying = [], tray = [], caught = 0, loadT = 0, clock = 0;
  let leaving = null, slide = 1, card = null;
  // Orben i sidans koordinater; aim() ger strålarna i skärmens, power hur starkt den lyser.
  const orb = { x: 40, y: 20, power: 0, want: 0, aim: null, trail: [] };

  function resize(w, h){
    size = { w, h };
    const trayW = Math.max(150, Math.min(320, w * .3));
    const pg = { x: 8, y: 8, w: Math.max(120, w - trayW - 24), h: h - 16 };
    geo = { page: pg, body: { x: pg.x + 1, y: pg.y + 30, w: pg.w - 2, h: pg.h - 31 }, tray: { x: pg.x + pg.w + 8, y: pg.y, w: trayW, h: pg.h } };
    if(page && !page.loading && !page.failed && page.width !== geo.body.w) page = layout(page.source, page.items, page.isNew, page.at);
  }

  function urlOf(source){
    try{ const u = new URL(source.url); return u.hostname.replace(/^www\./, '') + u.pathname + (u.search ? u.search.slice(0, 40) + (u.search.length > 40 ? '…' : '') : ''); }
    catch{ return String(source?.url || ''); }
  }

  // Sidans text i dokumentets koordinater (0,0 = textytans hörn).
  function layout(source, items, isNew, at){
    const b = geo.body, x = 14, w = b.w - 28;
    let y = 56;
    const blocks = items.map((it, i) => {
      ctx.font = F.title; const title = wrapText(s => ctx.measureText(s).width, it.title, w, 3);
      const lineW = title.map(l => Math.min(w, ctx.measureText(l).width));
      const titleW = Math.max(0, ...lineW);
      ctx.font = F.desc; const desc = it.desc ? wrapText(s => ctx.measureText(s).width, it.desc, w, 3) : [];
      const h = 8 + title.length * LH.title + desc.length * LH.desc + LH.meta + 6;
      const block = { item: it, isNew: isNew(it), x, y, w, h, title, lineW, titleW, desc, scan: 0, state: i < READ ? 'idle' : 'skim' };
      y += h + 10;
      return block;
    });
    return { source, items, isNew, at, blocks, height: y + 40, width: b.w, loading: false, failed: '' };
  }

  /* ---------- animationer: varje steg är ett löfte som update() driver fram ---------- */
  function step(dur, fn){
    if(!visible || reducedMotion() || globalThis.document?.hidden){ fn(1); return Promise.resolve(); }
    return new Promise(done => { anim = { t: 0, dur, fn, done }; });
  }
  function move(tx, ty, per = 2.2){
    const fx = orb.x, fy = orb.y, dist = Math.hypot(tx - fx, ty - fy);
    if(dist < 1) return Promise.resolve();
    return step(Math.max(220, Math.min(1400, dist * per)), e => { const k = ease(e); orb.x = fx + (tx - fx) * k; orb.y = fy + (ty - fy) * k; });
  }
  const screen = (x, y) => ({ x: geo.body.x + x, y: geo.body.y + y - scroll });
  const lineY = (bl, i) => bl.y + 8 + 12 + i * LH.title + 3;   // strax under rubrikradens text

  // Läser rubriken rad för rad: orben svävar ovanför och strålen följer med längs raden.
  function sweep(block){
    const total = block.lineW.reduce((s, w) => s + w, 0) || 1, fy = orb.y;
    const at = e => {
      let left = e * total, i = 0;
      while(i < block.lineW.length - 1 && left > block.lineW[i]){ left -= block.lineW[i]; i++; }
      return { i, x: block.x + Math.min(block.lineW[i], left) };
    };
    orb.want = .55;
    orb.aim = () => {
      const { i, x } = at(block.scan), from = Math.max(block.x, x - 48), s = screen(from, lineY(block, i));
      return [{ x: s.x, y: s.y, w: Math.max(2, x - from), a: .9 }];
    };
    return step(Math.max(450, total * 3), e => {
      block.scan = e;
      const p = at(e);
      orb.x = p.x; orb.y = fy + (block.y - 6 - fy) * Math.min(1, e * 4);
    }).then(() => { orb.aim = null; orb.want = 0; });
  }
  // Låser strålar på varje rad i rubriken och drar upp den till Fångat.
  function grab(block){
    let sent = false, lock = 0;
    orb.aim = () => block.title.map((_, i) => {
      const s = screen(block.x, lineY(block, i));
      return { x: s.x, y: s.y, w: block.lineW[i], a: lock };
    });
    return step(800, e => {
      lock = e < .55 ? ease(e / .55) : 1 - ease((e - .55) / .45);
      orb.want = .4 + .6 * lock;
      if(e >= .5 && !sent){
        sent = true; block.state = 'grabbed';
        const s = screen(block.x, block.y + 6);
        flying.push({ it: block.item, x: s.x, y: s.y, t: 0 });
      }
    }).then(() => { orb.aim = null; orb.want = 0; });
  }
  function glance(block){
    orb.aim = () => { const s = screen(block.x, lineY(block, 0)); return [{ x: s.x, y: s.y, w: block.lineW[0] || 0, a: .35 }]; };
    return step(160, () => {}).then(() => { orb.aim = null; });
  }
  const wait = ms => step(ms, () => {});

  async function loading(source){
    leaving = page && !page.loading ? { page, scroll } : null;
    slide = leaving ? 0 : 1;
    // Sidan byts under orben: den behåller sin plats på skärmen.
    orb.y -= scroll; for(const q of orb.trail) q.y -= scroll;
    page = { source, items: [], blocks: [], height: 0, width: geo.body.w, loading: true, failed: '' };
    scroll = 0; loadT = 0; orb.aim = null;
    // Upp under adressfältet; strålen läser in adressen tills sidan svarat.
    const { page: pg, body: b } = geo;
    await move(Math.min(pg.w * .4, 150), pg.y + 52 - b.y, 1.6);
    orb.want = .7;
    orb.aim = () => {
      ctx.font = F.meta;
      const w = Math.min(pg.w - 84, ctx.measureText('https://' + urlOf(source)).width);
      return [{ x: pg.x + 64, y: pg.y + 21, w, a: .55 + .3 * Math.sin(loadT / 160) }];
    };
  }

  async function read(source, items, isNew){
    page = layout(source, items, isNew, Date.now());
    scroll = 0; orb.aim = null; orb.want = 0;
    for(const block of page.blocks){
      if(block.state === 'skim') continue;
      await move(block.x, block.y - 6);
      block.state = 'reading';
      await sweep(block);
      if(block.isNew){ block.state = 'box'; await wait(140); await grab(block); }
      else{ block.state = 'seen'; await glance(block); }
    }
    // Ner till botten, förbi det som bara skummas.
    await move(orb.x, Math.max(orb.y, page.height - 24), 1.1);
    await wait(300);
  }

  async function fail(source, reason){
    page = { source, items: [], blocks: [], height: 0, width: geo.body.w, loading: false, failed: reason || 'Sidan svarade inte' };
    orb.aim = null; orb.want = 0;
    await wait(900);
  }

  function update(dt){
    const d = dt * rate;
    loadT += dt; clock += d / 1000;
    if(anim){
      anim.t += d;
      const e = Math.min(1, anim.t / anim.dur);
      anim.fn(e);
      if(e >= 1){ const done = anim.done; anim = null; done(); }
    }
    if(slide < 1){ slide = Math.min(1, slide + d / SLIDE); if(slide >= 1) leaving = null; }
    orb.power += (orb.want - orb.power) * Math.min(1, d / 160);
    // Svansen: en punkt när orben flyttat sig, annars krymper den bort.
    const last = orb.trail.at(-1);
    if(!last || Math.hypot(orb.x - last.x, orb.y - last.y) > 3){ orb.trail.push({ x: orb.x, y: orb.y }); if(orb.trail.length > 10) orb.trail.shift(); }
    else orb.trail.shift();
    for(const f of flying) f.t += d / 650;
    for(const f of flying.filter(f => f.t >= 1)){ tray.unshift({ it: f.it, born: performance.now() }); caught++; }
    flying = flying.filter(f => f.t < 1);
    if(tray.length > 40) tray.length = 40;
    // Sidan rullar med så att orben håller sig i övre delen av fönstret.
    if(page && geo){
      const max = Math.max(0, page.height - geo.body.h), target = Math.max(0, Math.min(max, orb.y - geo.body.h * .38));
      scroll += (target - scroll) * Math.min(1, d / 240);
    }
  }

  function flush(){
    if(anim){ anim.fn(1); const done = anim.done; anim = null; done(); }
    slide = 1; leaving = null;
  }

  /* ---------- ritning ---------- */
  function draw(){
    if(!geo) return;
    const { page: pg, body: b, tray: tr } = geo;
    // Webbläsaren: ram, adressfält och sidan.
    round(pg.x, pg.y, pg.w, pg.h, 8, C.page, C.line);
    ctx.save(); ctx.beginPath(); ctx.roundRect(pg.x, pg.y, pg.w, 30, [8, 8, 0, 0]); ctx.fillStyle = C.bar; ctx.fill(); ctx.restore();
    ['#e2483c', '#f0a020', '#3DDC84'].forEach((c, i) => { ctx.fillStyle = c; ctx.globalAlpha = .7; ctx.beginPath(); ctx.arc(pg.x + 14 + i * 12, pg.y + 15, 3.5, 0, 7); ctx.fill(); });
    ctx.globalAlpha = 1;
    round(pg.x + 54, pg.y + 6, pg.w - 64, 18, 9, '#0b0f14', C.line);
    ctx.font = F.meta; ctx.fillStyle = C.desc; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    clipText((page ? 'https://' + urlOf(page.source) : 'väntar på nästa sida…'), pg.x + 64, pg.y + 15, pg.w - 84);
    if(page?.loading){
      const p = (loadT / 1200) % 1;
      ctx.fillStyle = C.accent; ctx.fillRect(pg.x + 54 + (pg.w - 64) * Math.max(0, p - .25), pg.y + 27, (pg.w - 64) * .25, 2);
    }

    ctx.save(); ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
    // Sidbytet: den gamla sidan glider ut åt vänster, den nya in från höger.
    const e = ease(slide);
    if(leaving){ ctx.globalAlpha = 1 - e; drawPage(leaving.page, leaving.scroll, -e * b.w); ctx.globalAlpha = 1; }
    if(page) drawPage(page, scroll, (1 - e) * b.w);
    ctx.restore();

    const cardH = drawTray(tr);
    // Rubriker på väg till Fångat, med strålen kvar på dem en bit.
    const beams = orb.aim?.() || [];
    for(const f of flying){
      const k = ease(Math.min(1, f.t)), tx = tr.x + 10, ty = tr.y + 34 + cardH;
      const x = f.x + (tx - f.x) * k, y = f.y + (ty - f.y) * k - Math.sin(k * Math.PI) * 30;
      pill(f.it.title, x, y, Math.min(220, tr.w - 20), 1 - k * .3);
      if(f.t < .7) beams.push({ x: x + 8, y: y + 11, w: Math.min(120, tr.w - 36), a: 1 - f.t / .7 });
    }
    // Orben över allt, så den kan åka upp till adressfältet.
    const s = screen(orb.x, orb.y);
    paintOrb(ctx, { x: s.x, y: s.y, t: clock, k: 1.1, power: orb.power, beams,
      trail: orb.trail.map(q => screen(q.x, q.y)) });
  }

  function drawPage(p, sc, dx){
    const b = geo.body, top = b.y - sc, left = b.x + dx;
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.font = F.site; ctx.fillStyle = C.text; ctx.fillText(p.source.name, left + 14, top + 24);
    ctx.font = F.meta; ctx.fillStyle = C.meta;
    ctx.fillText(p.loading ? 'Pablo läser in sidan…' : p.failed ? '' : `RSS · ${p.items.length} poster · läser de ${Math.min(READ, p.items.length)} första`, left + 14, top + 41);
    if(p.loading) skeleton(b, top, left);
    if(p.failed){ ctx.font = F.title; ctx.fillStyle = '#f47d72'; ctx.fillText('✕ ' + p.failed, left + 14, top + 72); }
    for(const bl of p.blocks){
      const y = top + bl.y, x = left + bl.x;
      if(y > b.y + b.h || y + bl.h < b.y) continue;
      drawBlock(bl, x, y);
    }
  }

  function drawBlock(bl, x, y){
    const dim = bl.state === 'skim' ? .45 : bl.state === 'grabbed' ? .55 : 1;
    if(bl.scan > 0){
      ctx.fillStyle = bl.isNew ? 'rgba(61,220,132,.10)' : 'rgba(150,160,175,.07)';
      ctx.fillRect(x - 6, y, (bl.w + 12) * bl.scan, bl.h);
    }
    if(bl.state === 'box' || bl.state === 'grabbed' || bl.state === 'seen'){
      ctx.save();
      ctx.strokeStyle = bl.state === 'seen' ? 'rgba(150,160,175,.55)' : C.accent;
      ctx.lineWidth = bl.state === 'seen' ? 1 : 1.5;
      if(bl.state === 'seen') ctx.setLineDash([4, 4]);
      ctx.strokeRect(x - 6, y, bl.w + 12, bl.h);
      ctx.restore();
      const tag = bl.state === 'seen' ? 'REDAN SETT' : bl.state === 'grabbed' ? 'FÅNGAD ✓' : 'NY';
      ctx.font = '700 9px system-ui'; const tw = ctx.measureText(tag).width + 10;
      ctx.fillStyle = bl.state === 'seen' ? '#2a3644' : C.accent;
      ctx.fillRect(x + bl.w + 6 - tw, y - 7, tw, 13);
      ctx.fillStyle = bl.state === 'seen' ? C.desc : '#0b0f14'; ctx.textAlign = 'center';
      ctx.fillText(tag, x + bl.w + 6 - tw / 2, y + 3); ctx.textAlign = 'left';
    }
    ctx.globalAlpha *= dim;
    let yy = y + 8 + 12;
    ctx.font = F.title; ctx.fillStyle = C.text;
    for(const l of bl.title){ ctx.fillText(l, x, yy); yy += LH.title; }
    ctx.font = F.desc; ctx.fillStyle = C.desc;
    for(const l of bl.desc){ ctx.fillText(l, x, yy - 2); yy += LH.desc; }
    ctx.font = F.meta; ctx.fillStyle = C.meta;
    const tags = [...(bl.item.coins || []), ...(bl.item.macro || [])].join(' · ');
    ctx.fillText(`${ago(Date.now() - (bl.item.ts || Date.now()))} sedan${tags ? '  ·  ' + tags : ''}`, x, yy);
    ctx.globalAlpha /= dim;
  }

  function skeleton(b, top, left){
    const shimmer = .25 + .15 * Math.sin(loadT / 200);
    ctx.fillStyle = `rgba(120,140,160,${shimmer})`;
    for(let i = 0; i < 6; i++){
      const y = top + 60 + i * 52;
      ctx.fillRect(left + 14, y, (b.w - 28) * (.55 + (i * 37 % 40) / 100), 10);
      ctx.fillRect(left + 14, y + 18, (b.w - 28) * .9, 7);
      ctx.fillRect(left + 14, y + 30, (b.w - 28) * .7, 7);
    }
  }

  // Fångat: Pablos senaste summering överst och rubrikerna under. Ger summeringskortets höjd.
  function drawTray(tr){
    round(tr.x, tr.y, tr.w, tr.h, 8, '#0b1110', C.line);
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.font = '700 10px system-ui'; ctx.fillStyle = C.accent; ctx.fillText('FÅNGAT', tr.x + 10, tr.y + 20);
    ctx.font = F.meta; ctx.fillStyle = C.meta; ctx.textAlign = 'right'; ctx.fillText(String(caught), tr.x + tr.w - 10, tr.y + 20); ctx.textAlign = 'left';
    ctx.save(); ctx.beginPath(); ctx.rect(tr.x, tr.y + 28, tr.w, tr.h - 30); ctx.clip();
    const cardH = drawCard(tr);
    const nowT = performance.now();
    let y = tr.y + 34 + cardH;
    for(const r of tray){
      if(y > tr.y + tr.h) break;
      const age = Math.min(1, (nowT - r.born) / 350), off = (1 - ease(age)) * -16;
      ctx.globalAlpha = .35 + .65 * age;
      pill(r.it.title, tr.x + 10, y + off, tr.w - 20, 1, r.it.src);
      y += 42;
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    return cardH;
  }

  function drawCard(tr){
    if(!card) return 0;
    const x = tr.x + 8, y = tr.y + 32, w = tr.w - 16;
    ctx.font = F.card;
    const text = card.text || (card.busy ? 'summerar' + '.'.repeat(1 + Math.floor(loadT / 400) % 3) : '');
    const lines = wrapText(s => ctx.measureText(s).width, text, w - 16, 7);
    const h = 26 + Math.max(1, lines.length) * LH.card + 6;
    round(x, y, w, h, 7, 'rgba(14,40,30,.95)', card.busy ? C.accent : '#2a8f5c');
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.font = '700 9px system-ui'; ctx.fillStyle = C.accent;
    clipText('PABLO · ' + String(card.src || '').toUpperCase(), x + 8, y + 15, w - 60);
    ctx.textAlign = 'right'; ctx.fillStyle = C.meta;
    ctx.fillText(card.busy ? '✦ skriver' : card.by === 'lokal' ? 'LOKAL' : '✦', x + w - 8, y + 15);
    ctx.textAlign = 'left'; ctx.font = F.card; ctx.fillStyle = card.text ? '#dff7ea' : C.desc;
    lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 31 + i * LH.card));
    return h + 8;
  }

  function pill(text, x, y, w, alpha = 1, src = ''){
    ctx.save(); ctx.globalAlpha *= alpha;
    round(x, y, w, src ? 36 : 22, 6, 'rgba(18,58,39,.92)', '#2a8f5c');
    ctx.font = '600 11px system-ui'; ctx.fillStyle = '#e9fff3'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    clipText(text, x + 8, y + 11, w - 16);
    if(src){ ctx.font = F.meta; ctx.fillStyle = '#87c5b2'; clipText(src, x + 8, y + 26, w - 16); }
    ctx.restore();
  }

  function clipText(text, x, y, w){
    let t = String(text || '');
    if(ctx.measureText(t).width > w){ while(t && ctx.measureText(t + '…').width > w) t = t.slice(0, -1); t += '…'; }
    ctx.fillText(t, x, y);
  }

  function round(x, y, w, h, r, fill, stroke){
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
    if(fill){ ctx.fillStyle = fill; ctx.fill(); }
    if(stroke){ ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }

  return {
    resize, loading, read, fail, update, draw, flush,
    summary(entry){ card = entry || null; },
    setVisible(on){ visible = on; if(!on) flush(); },
    speed(n){ if(n) rate = n; return rate; },
    busy: () => !!anim
  };
}
