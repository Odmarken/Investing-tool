/* Claude ritar: en gissning på de kommande candlarna i AI Forecast-grafen.
   Frågan går till Claude Code i desktop-appen (window.riptideDesktop.claude.sketch)
   — en snabb fråga utan verktyg och utan minne — med grafens underlag. Svaret är
   en mening och sedan en candle per rad; candlarna läses medan svaret strömmar in,
   så grafen kan rita dem en i taget.

   sketchPrompt({context, n, symbol, tf, price, question, from}) → frågan till Claude
   createSketchReader({base, start, tfMs, n}) → {feed(text), end(), candles, note}
   connectSketch(api) → run(prompt, onDelta) → {done: Promise<text>, cancel()} | null utan appen */

export function sketchPrompt({ context = '', n = 10, symbol = '', tf = '', price = null, question = '', from = '' } = {}){
  const ask = String(question || '').trim();
  return [
    context ? `Underlag från Riptide-appen:\n${context}` : '',
    `Rita din bästa gissning på de ${n} kommande candlarna för ${symbol}USDT på ${tf}` +
      (Number.isFinite(price) ? `, från senaste priset ${price}` : '') + '.' +
      (from ? ` Den första börjar ${from} UTC, direkt efter den pågående candlen.` : ''),
    ask ? `Användarens fråga: ${ask}` : '',
    'Svara exakt så här och inget annat:',
    'Rad 1: en kort mening på svenska om vad du ser och varför (högst 200 tecken).',
    `Rad 2–${n + 1}: en candle per rad i tidsordning: open high low close, med punkt som decimaltecken och utan tusentalsavgränsare.`
  ].filter(Boolean).join('\n\n');
}

const NUM = /[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;

/* Läser svaret rad för rad. En rad med minst fyra tal är en candle (de fyra sista: ett radnummer först gör inget);
   text före första candlen är meningen. Varje candle öppnar där den förra stängde (den första på base), high och
   low täcker open och close (även om de kom i fel ordning), och en candle mer än 50 % från base hoppas över. */
export function createSketchReader({ base, start, tfMs, n = 10 }){
  let buf = '', note = '';
  const candles = [];
  function line(raw){
    const text = raw.replace(/[`*]/g, '').trim();
    if(!text || candles.length >= n) return;
    const nums = (text.replace(/(\d),(?=\d{3}\b)/g, '$1').match(NUM) || []).map(Number);
    if(nums.length >= 4 && /^[\s\d.,:;)(+\-#|e]*$/i.test(text.replace(/^(?:candle|rad)\s*/i, ''))){
      const [, h, l, c] = nums.slice(-4);
      const o = candles.length ? candles.at(-1).c : base;
      if(![h, l, c].every(x => x > base * .5 && x < base * 1.5)) return;
      candles.push({ t: start + candles.length * tfMs, o, h: Math.max(h, l, o, c), l: Math.min(h, l, o, c), c });
    }else if(!candles.length) note = (note ? note + ' ' : '') + text.replace(/^rad\s*1\s*[:.]\s*/i, '');
  }
  return {
    feed(text){
      buf += text;
      let i;
      while((i = buf.indexOf('\n')) >= 0){ line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    end(){ if(buf){ line(buf); buf = ''; } },
    candles,
    get note(){ return note.slice(0, 300); }
  };
}

let seq = 0;
export function connectSketch(api = globalThis.riptideDesktop?.claude){
  if(typeof api?.sketch !== 'function') return null;
  return (prompt, onDelta) => {
    const id = 'sketch-' + Date.now().toString(36) + '-' + (++seq);
    const off = api.onEvent?.(ev => { if(ev?.id === id && ev.delta) onDelta(ev.delta); });
    const done = Promise.resolve(api.sketch({ id, prompt })).then(r => r?.text ?? '').finally(() => off?.());
    return { done, cancel: () => { void api.cancel?.(id); } };
  };
}
