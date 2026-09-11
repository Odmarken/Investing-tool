import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { variant, label, predict, metrics } from './crypto-ai-v2-core.mjs';

export function trainingCuts(scores) {
  if (scores.length < 5 || !scores.every(Number.isFinite)) throw Error('Insufficient finite training scores');
  const sorted = [...scores].sort((a, b) => a - b);
  return [.2, .4, .6, .8].map(p => sorted[Math.floor(sorted.length * p)]);
}

export function scoreDiagnostics(rows, baseline, cuts) {
  if (!Number.isFinite(baseline) || cuts.length !== 4 || !cuts.every(Number.isFinite) || cuts.some((x, i) => i > 0 && x < cuts[i - 1]))
    throw Error('Invalid training reference');
  if (rows.some(r => !Number.isFinite(r.score) || !Number.isFinite(r.netR))) throw Error('Non-finite validation result');
  const average = values => values.length ? values.reduce((s, x) => s + x, 0) / values.length : null;
  const groups = Array.from({ length: 5 }, () => []);
  // Ties remain together; constant forecasts cannot manufacture five ranks.
  for (const row of rows) groups[cuts.filter(cut => row.score > cut).length].push(row);
  return {
    n: rows.length, predictedMeanR: average(rows.map(r => r.score)), actual: metrics(rows),
    modelMSE: average(rows.map(r => (r.score - r.netR) ** 2)),
    baselineMSE: average(rows.map(r => (baseline - r.netR) ** 2)),
    bins: groups.map((group, i) => ({ rank: i + 1, predictedMeanR: average(group.map(r => r.score)), ...metrics(group) })),
    aboveExistingThreshold: metrics(rows.filter(r => r.score >= .1)),
  };
}

export function run() {
  const root = new URL('../.matning/crypto/', import.meta.url);
  const read = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
  const benchmark = read('ai-v2-benchmark.json'), development = read('ai-candidates-development.json');
  if (!development.complete) throw Error('Incomplete candidate collection');
  const { trainEnd, validationEnd } = benchmark.periods;
  const data = Object.fromEntries([...new Set(development.rows.map(r => r.inst))].map(s => [s, read(s + '.json')]));
  const prepared = new Map();
  const prepare = (profile, training) => {
    const end = training ? trainEnd : validationEnd;
    return development.rows.filter(r => training ? r.at < trainEnd : r.at >= trainEnd && r.at < validationEnd).flatMap(r => {
      const candidate = variant(r, profile);
      if (!candidate.eligible) return [];
      const d = data[r.inst], done = label(candidate, d.bars, d.funding, end);
      if (!done) return [];
      const stress = label(variant(r, profile, .001), d.bars, d.funding, end);
      if (!stress) throw Error('Missing stress outcome');
      if (done.closed >= end) throw Error('Outcome crosses period boundary');
      return [{ ...done, stressR: stress.netR }];
    });
  };
  const trials = benchmark.trials.map(trial => {
    if (!prepared.has(trial.profile)) prepared.set(trial.profile, { train: prepare(trial.profile, true), validation: prepare(trial.profile, false) });
    const { train, validation } = prepared.get(trial.profile);
    if (train.length !== trial.trainN || Math.max(...train.map(r => r.closed)) !== trial.trainLastOutcome)
      throw Error('Training provenance no longer matches saved model');
    const cuts = trainingCuts(train.map(r => predict(trial.model, r.x)));
    const baseline = train.reduce((sum, r) => sum + r.netR, 0) / train.length;
    return { id: trial.id, trainN: train.length, baseline, cuts,
      validation: scoreDiagnostics(validation.map(r => ({ ...r, score: predict(trial.model, r.x) })), baseline, cuts) };
  });
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const result = { createdAt: new Date().toISOString(), trainEnd, validationEnd, retrospective: true,
    validated: false, trials,
    hashes: { benchmark: sha(readFileSync(new URL('ai-v2-benchmark.json', root))),
      candidates: sha(readFileSync(new URL('ai-candidates-development.json', root))),
      prices: Object.fromEntries(Object.keys(data).map(s => [s, sha(readFileSync(new URL(s + '.json', root)))])) } };
  writeFileSync(new URL('ai-ranking.json', root), JSON.stringify(result, null, 2));
  const f = x => x === null ? '–' : x.toFixed(3);
  let report = `# Fortsättning: kan korta AI-modeller rangordna signaler?\n\nKörd ${result.createdAt}. De sex redan tränade modellerna granskas utan omträning eller ändrad handelströskel. Träning slutar före 12 juni 2026; valideringen är 12 juni–före 12 juli. Den senare juli–september-perioden öppnas inte av denna körning.\n\n` +
    `## Metod\n\nFem prognosgrupper avgränsas med 20:e, 40:e, 60:e och 80:e percentilen av respektive modells träningsprognoser. Samma fasta gränser används på valideringsdata. Därför behöver grupperna där inte vara lika stora. Lika prognoser hålls tillsammans. Endast kandidater som klarar respektive utförandes tidigare grundkrav tas med. Utfall som korsar tidsgränsen utesluts.\n\n` +
    `En konstant prognos, träningsdelens medelutfall, används som referens. MSE är genomsnittligt kvadrerat prognosfel; lägre är bättre. Bra MSE är inte samma sak som lönsam handel. Avgifter, slippage och funding följer tidigare test; stress dubblar slippage.\n\n` +
    `## Validering jämfört med konstant prognos\n\n| Modell | Kandidater | Prognos snitt R | Utfall snitt R | Modell MSE | Konstant MSE | Prognos ≥ +0,10 R |\n|---|---:|---:|---:|---:|---:|---:|\n` +
    trials.map(t => { const v = t.validation; return `| ${t.id} | ${v.n} | ${f(v.predictedMeanR)} | ${f(v.actual.meanR)} | ${f(v.modelMSE)} | ${f(v.baselineMSE)} | ${v.aboveExistingThreshold.n} |`; }).join('\n');
  for (const t of trials) {
    report += `\n\n## ${t.id}\n\nTräningsbaslinje ${f(t.baseline)} R. Fasta gruppgränser: ${t.cuts.map(f).join(', ')} R. Grupp 5 kräver prognos strikt över den högsta gränsen.\n\n| Grupp, lägst till högst prognos | Kandidater | Prognos R | Utfall R | Stress R |\n|---|---:|---:|---:|---:|\n` +
      t.validation.bins.map(b => `| ${b.rank} | ${b.n} | ${f(b.predictedMeanR)} | ${f(b.meanR)} | ${f(b.stressR)} |`).join('\n');
  }
  report += `\n\n## Hur resultatet får användas\n\nGrupperna är diagnostik, inga nya handelsregler. En eventuell positiv grupp är ett uppslag för fortsatt utveckling, inte en efterhandsvald godkänd strategi. Jämförelser mellan utföranden har olika kandidatpopulationer; använd den tidigare parade analysen för att bedöma stoppändringen på samma signaler. Korrelerade och överlappande signaler är inte oberoende trades.\n\nModellerna och perioderna är redan granskade. Rapporten ändrar därför varken modellens valideringsstatus, tröskeln +0,10 R eller kontots handelsregler. Detta är ett mätt nästa steg för att skilja prognosförmåga från problem i signalunderlaget.\n\n## Reproduktion\n\nKör \`node research/crypto-ai-ranking.mjs\` med befintlig kandidat-, pris- och modellcache. Resultat och SHA-256 sparas i \`.matning/crypto/ai-ranking.json\`. Träningsantal och sista träningsutfall kontrolleras mot den sparade modellen.\n`;
  writeFileSync(new URL('crypto-ai-ranking-results.md', import.meta.url), report);
  console.log(JSON.stringify(trials.map(t => ({ id: t.id, ...t.validation })), null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
