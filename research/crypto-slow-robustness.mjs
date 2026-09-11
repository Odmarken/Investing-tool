import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { simulate } from './crypto-slow-core.mjs';
import { readData, SYMBOLS, ROOT, END } from './crypto-slow-data.mjs';

// Diagnostics only: keep the previously investigated rule and all costs fixed.
export function monthlyWindows(from, to, months) {
  if (!Number.isInteger(months) || months < 1) throw Error('Invalid window length');
  const date = new Date(from);
  if (date.getUTCDate() !== 1 || from !== Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
    throw Error('Start must be a UTC month boundary');
  const windows = [];
  for (let offset = 0; ; offset++) {
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1);
    const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset + months, 1);
    if (end > to) break;
    windows.push({ from: start, to: end });
  }
  return windows;
}

export function summarizeWindows(rows) {
  if (!rows.length) return { n: 0, positive: 0, stressPositive: 0, beatBuyhold: 0, medianReturnPct: null, worstReturnPct: null, bestReturnPct: null };
  const sorted = rows.map(r => r.base.returnPct).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    n: rows.length,
    positive: rows.filter(r => r.base.returnPct > 0).length,
    stressPositive: rows.filter(r => r.stress.returnPct > 0).length,
    beatBuyhold: rows.filter(r => r.base.returnPct > r.buyhold.returnPct).length,
    medianReturnPct: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    worstReturnPct: sorted[0], bestReturnPct: sorted.at(-1),
  };
}

export function concentration(book) {
  const wins = book.trades.filter(t => t.pnl > 0).map(t => t.pnl).sort((a, b) => b - a);
  const netPnl = book.trades.reduce((sum, t) => sum + t.pnl, 0);
  const grossProfit = wins.reduce((sum, x) => sum + x, 0);
  const top = count => wins.slice(0, count).reduce((sum, x) => sum + x, 0);
  // Attribution subtraction, NOT a new simulation with those trades removed.
  return { netPnl, grossProfit, largestWinner: wins[0] ?? 0,
    top5ShareOfGrossProfit: grossProfit ? top(5) / grossProfit : null,
    netPnlLessLargestWinner: netPnl - top(1), netPnlLessTop5Winners: netPnl - top(5) };
}

export function continuousYears(book) {
  const groups = new Map();
  let previous = 100;
  for (const day of book.daily) {
    // A daily record is timestamped at the END of the day.
    const year = new Date(day.t - 1).getUTCFullYear();
    if (!groups.has(year)) groups.set(year, { year, openingEquity: previous, closingEquity: day.equity });
    groups.get(year).closingEquity = day.equity;
    previous = day.equity;
  }
  return [...groups.values()].map(y => ({ ...y, returnPct: 100 * (y.closingEquity / y.openingEquity - 1) }));
}

const compact = book => ({ returnPct: book.returnPct, maxDDPct: book.maxDDPct, n: book.n });
const date = t => new Date(t).toISOString().slice(0, 10);
const f = (x, digits = 1) => x === null ? '–' : x.toFixed(digits);

export function run() {
  const sources = Object.fromEntries(SYMBOLS.map(s => [s, readData(s)]));
  const data = Object.fromEntries(SYMBOLS.map(s => [s, sources[s].bars]));
  const from = Date.parse('2025-01-01T00:00:00Z');
  const windows = [6, 12].map(months => {
    const rows = monthlyWindows(from, END, months).map(w => ({ ...w,
      base: compact(simulate('momentum28', data, w.from, w.to)),
      stress: compact(simulate('momentum28', data, w.from, w.to, .001)),
      buyhold: compact(simulate('buyhold', data, w.from, w.to)),
    }));
    return { months, summary: summarizeWindows(rows), rows };
  });
  const book = simulate('momentum28', data, from, END);
  const result = { createdAt: new Date().toISOString(), variant: 'momentum28', from, to: END,
    retrospective: true, validated: false, windows,
    fullPeriod: compact(book), concentration: concentration(book), continuousYears: continuousYears(book),
    byCoin: book.byCoin,
    hashes: Object.fromEntries(SYMBOLS.map(s => [s, sources[s].checksum])),
    protocolHash: createHash('sha256').update(readFileSync(new URL('crypto-slow-robustness-protocol.md', import.meta.url))).digest('hex'),
  };
  writeFileSync(new URL('robustness.json', ROOT), JSON.stringify(result, null, 2));
  const c = result.concentration;
  const report = `# Fortsättning: stabilitet i 28-dagars momentum\n\nKörd ${result.createdAt}. Samma veckoregel och kostnader som tidigare, utan parameterändringar. Detta är en fortsatt granskning av den kandidat som diskuterades med användaren, inte ett nytt AI-modelltest.\n\n` +
    `## Olika startdatum\n\nVarje körning startar med 100 dollar i kontanter och samma fördelning BTC/ETH/SOL. Köp och behåll startar samtidigt. Bara fullständiga 6- och 12-månadersfönster från januari 2025 används.\n\n` +
    `| Längd | Fönster | Positiva | Positiva med dubbel slippage | Bättre än köp och behåll | Median | Sämst | Bäst |\n|---|---:|---:|---:|---:|---:|---:|---:|\n` +
    windows.map(({ months, summary: s }) => `| ${months} månader | ${s.n} | ${s.positive}/${s.n} | ${s.stressPositive}/${s.n} | ${s.beatBuyhold}/${s.n} | ${f(s.medianReturnPct)} % | ${f(s.worstReturnPct)} % | ${f(s.bestReturnPct)} % |`).join('\n') +
    `\n\nFönstren överlappar kraftigt. Andelen positiva fönster är beskrivande statistik, inte sannolikheten för framtida vinst eller oberoende testresultat.\n\n## Beroende av stora vinnare\n\nFör den sammanhängande perioden ${date(from)} till före ${date(END)}, med startkapital 100 dollar:\n\n` +
    `- Nettoresultat: ${f(c.netPnl, 2)} dollar.\n- Största vinnaren: ${f(c.largestWinner, 2)} dollar.\n- Fem största vinnarnas andel av samtliga vinstaffärers P/L: ${f(c.top5ShareOfGrossProfit === null ? null : 100 * c.top5ShareOfGrossProfit)} %.\n- Netto-P/L minus största vinnarens bokförda bidrag: ${f(c.netPnlLessLargestWinner, 2)} dollar.\n- Netto-P/L minus fem största vinnarnas bokförda bidrag: ${f(c.netPnlLessTop5Winners, 2)} dollar.\n\n` +
    `Subtraktionerna är en bidragsanalys. De simulerar inte hur kapital, senare positioner eller avkastning hade ändrats om affärerna saknats. Trendföljning kan vara beroende av få stora vinnare; siffrorna beskriver detta beroende.\n\n` +
    `| Coin | Bidrag, dollar | Innehav |\n|---|---:|---:|\n` + book.byCoin.map(x => `| ${x.symbol} | ${f(x.pnl, 2)} | ${x.n} |`).join('\n') +
    `\n\n## Årsutfall i samma konto\n\nPositioner och kapital följer med över årsskiftet. Dessa årsavkastningar kan kedjas till den sammanhängande totalen. De tidigare årsvisa omstarterna besvarar en annan fråga. 2026 slutar 9 september.\n\n| År | Ingående kapital | Utgående kapital | Avkastning |\n|---|---:|---:|---:|\n` +
    result.continuousYears.map(y => `| ${y.year} | ${f(y.openingEquity, 2)} | ${f(y.closingEquity, 2)} | ${f(y.returnPct)} % |`).join('\n') +
    `\n\n## Alla startfönster\n\n| Månader | Start | Slut, exklusive | Netto | Stress | Köp och behåll | Max daglig nedgång |\n|---|---|---|---:|---:|---:|---:|\n` +
    windows.flatMap(w => w.rows.map(r => `| ${w.months} | ${date(r.from)} | ${date(r.to)} | ${f(r.base.returnPct)} % | ${f(r.stress.returnPct)} % | ${f(r.buyhold.returnPct)} % | ${f(r.base.maxDDPct)} % |`)).join('\n') +
    `\n\n## Tolkning och nästa steg\n\nDet positiva totalresultatet gäller ett visst startdatum och innehåller både positiva och negativa delperioder. Detta test visar hur känsligt resultatet är för startdatum och vinnarnas bidrag. Det ändrar inte det tidigare urvalsbeslutet eller gör historiken orörd. Användarens acceptans för större nedgång motiverar fortsatt experiment, men är ingen uppmätt framtida riskgräns.\n\nNästa genomförandesteg är att låsa denna exakta regel och samla framåtriktade demobeslut med tidsstämpel, kostnader och egen resultathistorik. Ingen parameter valdes om i denna granskning och ingen automatisk handelsbehörighet ges av rapporten.\n\n## Reproduktion\n\nKör \`node research/crypto-slow-robustness.mjs\`. Kräver befintlig verifierad dygnscache i \`.matning/crypto-slow\`. Fullständiga siffror och data-/protokollhashar sparas i \`.matning/crypto-slow/robustness.json\`. [Protokoll](crypto-slow-robustness-protocol.md).\n`;
  writeFileSync(new URL('crypto-slow-robustness-results.md', import.meta.url), report);
  console.log(JSON.stringify({ windows: windows.map(w => ({ months: w.months, ...w.summary })), concentration: c, continuousYears: result.continuousYears }, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
