/* Pablos orb, ritad på en canvas. Delas av nätet (news-crawler.js) och sidorna
   (crawler-advanced.js).

   paintOrb(ctx, {x, y, t, k, power, carry, beams, trail})
   t: tiden i sekunder (ringen snurrar, kärnan pulserar); k: skala; power (0–1):
   hur starkt den lyser när den läser eller fångar; carry: hur många fynd som
   kretsar runt den; trail: punkter den nyss varit på, äldst först (en svans när
   den åker); beams: strålarna ut till texten, [{x, y, w, a}] — en stråle mot
   linjen x…x+w på höjden y (w=0: mot en punkt), a (0–1) är hur stark den är. */
export function paintOrb(ctx, { x, y, t = 0, k = 1, power = 0, carry = 0, beams = [], trail = [] }){
  const r = 9 * k, p = Math.max(0, Math.min(1, power));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // Svansen: bleknar bakåt.
  trail.forEach((q, i) => {
    const f = (i + 1) / (trail.length + 1);
    ctx.fillStyle = `rgba(61,220,132,${.12 * f})`;
    ctx.beginPath(); ctx.arc(q.x, q.y, r * (.15 + .45 * f), 0, 7); ctx.fill();
  });

  // Strålarna: en kon från orbens kant ut till linjen, en ljus kärna i mitten och en träff på texten.
  for(const b of beams){
    const a = Math.max(0, Math.min(1, b.a ?? 1)), w = b.w || 0;
    if(a <= 0) continue;
    const tx = b.x + w / 2, ang = Math.atan2(b.y - y, tx - x);
    const px = Math.cos(ang + Math.PI / 2) * r * .45, py = Math.sin(ang + Math.PI / 2) * r * .45;
    const flick = .82 + .18 * Math.sin(t * 37 + b.x * .13 + b.y * .07);
    const g = ctx.createLinearGradient(x, y, tx, b.y);
    g.addColorStop(0, `rgba(170,255,220,${.5 * a * flick})`);
    g.addColorStop(1, `rgba(61,220,132,${.14 * a * flick})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x + px, y + py); ctx.lineTo(b.x + w + (w ? 0 : 1.5), b.y); ctx.lineTo(b.x - (w ? 0 : 1.5), b.y); ctx.lineTo(x - px, y - py);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = `rgba(225,255,240,${.55 * a * flick})`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, b.y); ctx.stroke();
    ctx.shadowColor = 'rgba(61,220,132,.9)'; ctx.shadowBlur = 8;
    ctx.fillStyle = `rgba(200,255,228,${.75 * a})`;
    if(w) ctx.fillRect(b.x, b.y - 1, w, 2);
    else{ ctx.beginPath(); ctx.arc(b.x, b.y, 2.2, 0, 7); ctx.fill(); }
    ctx.shadowBlur = 0;
  }

  // Glöden runt orben, starkare när den arbetar.
  const pulse = .5 + .5 * Math.sin(t * 3.1);
  const halo = r * (2.8 + p * 1.6 + pulse * .3);
  const gl = ctx.createRadialGradient(x, y, r * .6, x, y, halo);
  gl.addColorStop(0, `rgba(61,220,132,${.32 + .28 * p})`); gl.addColorStop(1, 'rgba(61,220,132,0)');
  ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, y, halo, 0, 7); ctx.fill();

  // Ringen: bakre halvan bakom kroppen, främre framför.
  const tilt = Math.sin(t * .7) * .45, spin = t * 1.4;
  const ring = (from, to, alpha) => {
    ctx.strokeStyle = `rgba(127,240,190,${alpha})`; ctx.lineWidth = 1.1 * k;
    ctx.beginPath(); ctx.ellipse(x, y, r * 1.75, r * .5, tilt, from, to); ctx.stroke();
  };
  ring(Math.PI, Math.PI * 2, .28 + .2 * p);
  ctx.globalCompositeOperation = 'source-over';

  // Kroppen: en klot med ljus uppe till vänster.
  const body = ctx.createRadialGradient(x - r * .35, y - r * .4, r * .1, x, y, r);
  body.addColorStop(0, '#effff7'); body.addColorStop(.32, '#86f3c4'); body.addColorStop(.78, '#1c8a5c'); body.addColorStop(1, '#0a2a1c');
  ctx.fillStyle = body; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  // Kärnan virvlar.
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = 1.2 * k; ctx.lineCap = 'round';
  for(let i = 0; i < 2; i++){
    ctx.strokeStyle = `rgba(230,255,245,${.3 + .25 * p})`;
    ctx.beginPath(); ctx.arc(x, y, r * (.45 + i * .2), spin * (i ? -1.6 : 2) + i * 2, spin * (i ? -1.6 : 2) + i * 2 + 1.7); ctx.stroke();
  }
  ring(0, Math.PI, .55 + .3 * p);

  // Fynden den bär kretsar runt den.
  const n = Math.min(10, carry);
  for(let i = 0; i < n; i++){
    const a = t * 2.2 + i * Math.PI * 2 / n;
    const cx = Math.cos(a) * r * 2.1, cy = Math.sin(a) * r * .75;
    const rx = cx * Math.cos(tilt) - cy * Math.sin(tilt), ry = cx * Math.sin(tilt) + cy * Math.cos(tilt);
    ctx.fillStyle = 'rgba(120,255,180,.9)';
    ctx.beginPath(); ctx.arc(x + rx, y + ry, 1.9 * k, 0, 7); ctx.fill();
  }
  ctx.restore();
}
