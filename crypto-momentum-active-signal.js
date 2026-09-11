// Frozen experimental hypotheses, shared by the browser and historical research.
// They are trading rules, not a trained model or a profitability claim.
const HOUR = 60 * 60 * 1000;
const LOOKBACK = 80;
const ATR_PERIOD = 14;
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'SHIB', 'PEPE'];

export const ACTIVE_PROFILES = Object.freeze({
  pulse12: Object.freeze({ slAtrMultiple: 2, rewardMultiple: 2, maxHoldMs: 12 * HOUR, breakoutHours: 0 }),
  pulse24: Object.freeze({ slAtrMultiple: 2, rewardMultiple: 2, maxHoldMs: 24 * HOUR, breakoutHours: 0 }),
  trend24: Object.freeze({ slAtrMultiple: 2, rewardMultiple: 3, maxHoldMs: 24 * HOUR, breakoutHours: 6 })
});

/**
 * bars: {t,o,h,l,c} with t the UTC opening timestamp of a one-hour candle.
 * Use exactly the latest 80 completed candles so ATR warm-up is identical in
 * live use and research, independent of how much older history was supplied.
 * Bad, stale, discontinuous or insufficient observations produce no signal.
 */
export function activeSignal(symbol, bars, now, profile = 'pulse12') {
  const rule = Object.hasOwn(ACTIVE_PROFILES, profile) ? ACTIVE_PROFILES[profile] : null;
  if (!rule || !SYMBOLS.includes(symbol) || !Array.isArray(bars) || !Number.isFinite(now)) return null;
  if (bars.some(b => !b || !Number.isFinite(b.t))) return null;
  const closed = bars.filter(b => b.t + HOUR <= now).sort((a, b) => a.t - b.t).slice(-LOOKBACK);
  if (closed.length < LOOKBACK) return null;
  if (closed.some((b, i) => b.t % HOUR !== 0 ||
      ![b.o, b.h, b.l, b.c].every(n => Number.isFinite(n) && n > 0) ||
      b.h < Math.max(b.o, b.l, b.c) || b.l > Math.min(b.o, b.c) ||
      (i > 0 && b.t !== closed[i - 1].t + HOUR))) return null;
  const last = closed.at(-1);
  const at = last.t + HOUR;
  if (at !== Math.floor(now / HOUR) * HOUR) return null;

  const reference = last.c;
  const score = [14, 28, 56].reduce((sum, n) => sum + reference / closed.at(-1 - n).c - 1, 0) / 3;
  if (!Number.isFinite(score) || score <= 0) return null;
  if (rule.breakoutHours && reference <= Math.max(...closed.slice(-1 - rule.breakoutHours, -1).map(b => b.h))) return null;

  // Seed Wilder ATR with the first 14 true ranges. The first observed candle
  // has no preceding close in this fixed window, so its true range is high-low.
  let atr = 0;
  for (let i = 0; i < closed.length; i++) {
    const b = closed[i];
    const tr = i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - closed[i - 1].c), Math.abs(b.l - closed[i - 1].c));
    atr = i < ATR_PERIOD ? atr + tr / ATR_PERIOD : (atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
  }
  const slDistance = Math.max(rule.slAtrMultiple * atr, 0.005 * reference);
  if (!Number.isFinite(atr) || !Number.isFinite(slDistance)) return null;
  return { symbol, at, score, atr, reference, slDistance, rewardMultiple: rule.rewardMultiple, maxHoldMs: rule.maxHoldMs };
}

/** Pick the strongest eligible positive signal, with a fixed universe tie-break. */
export function chooseActiveSignal(signals) {
  if (!Array.isArray(signals)) return null;
  let best = null;
  for (const signal of signals) {
    if (!signal || !SYMBOLS.includes(signal.symbol) || !Number.isFinite(signal.score) || signal.score <= 0) continue;
    if (!best || signal.score > best.score ||
        (signal.score === best.score && SYMBOLS.indexOf(signal.symbol) < SYMBOLS.indexOf(best.symbol))) best = signal;
  }
  return best;
}
