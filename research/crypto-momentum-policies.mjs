import { momentum } from './crypto-slow-core.mjs';

export const TWEAKS = Object.freeze([
  { id: 'original', name: 'Original 28 dagar' },
  { id: 'daily', name: 'Dagliga beslut' },
  { id: 'buffer', name: 'Buffert ±2 %' },
  { id: 'trend84', name: 'Trendfilter 84 dagar' },
  { id: 'multi', name: 'Momentum 14/28/56' },
  { id: 'vol40', name: 'Volatilitetsbegränsat inträde' },
  { id: 'top2', name: 'Två starkaste' },
]);

export function volatility(bars, index) {
  if (index < 29) throw Error('Missing volatility history');
  const returns = Array.from({ length: 28 }, (_, j) => Math.log(bars[index - 28 + j].c / bars[index - 29 + j].c));
  const mean = returns.reduce((sum, x) => sum + x, 0) / returns.length;
  return Math.sqrt(returns.reduce((sum, x) => sum + (x - mean) ** 2, 0) / 27) * Math.sqrt(365);
}

export function policy(id) {
  if (!TWEAKS.some(t => t.id === id)) throw Error('Unknown momentum tweak');
  return {
    sleeveCount: id === 'top2' ? 2 : undefined,
    shouldDecide: time => id === 'daily' || new Date(time).getUTCDay() === 1,
    fraction: (bars, index) => id === 'vol40' ? Math.min(1, .4 / Math.max(volatility(bars, index), 1e-12)) : 1,
    wanted(data, index, held) {
      const symbols = Object.keys(data);
      if (id === 'top2') {
        const chosen = symbols.map(symbol => ({ symbol, score: momentum(data[symbol], index, 28) }))
          .filter(x => x.score !== null && x.score > 0)
          .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol)).slice(0, 2).map(x => x.symbol);
        const wanted = held.map(s => chosen.includes(s) ? s : null);
        const missing = chosen.filter(s => !wanted.includes(s));
        return wanted.map(s => s ?? missing.shift() ?? null);
      }
      return symbols.map((symbol, j) => {
        const bars = data[symbol], score = momentum(bars, index, 28);
        if (score === null) return null;
        if (id === 'buffer') return (held[j] === symbol ? score >= -.02 : score > .02) ? symbol : null;
        if (id === 'multi') {
          const scores = [14, 28, 56].map(n => momentum(bars, index, n));
          return scores.every(x => x !== null) && scores.reduce((sum, x) => sum + x, 0) / 3 > 0 ? symbol : null;
        }
        if (id === 'trend84') {
          if (index < 84) return null;
          const average = bars.slice(index - 84, index).reduce((sum, b) => sum + b.c, 0) / 84;
          return score > 0 && bars[index - 1].c > average ? symbol : null;
        }
        return score > 0 ? symbol : null;
      });
    },
  };
}
