/**
 * Claude-chatten i desktop-appen. Kör Claude Code (claude.exe) i utskriftsläge
 * med din egen inloggning — samma som i VS Code — så ingen API-nyckel behövs.
 * Svaret strömmas som rader med JSON; texten skickas vidare bit för bit.
 *
 * Claude får bara webbsökning: inga filverktyg, inga kommandon. Varje chatt är
 * en egen Claude-session (--session-id första gången, sedan --resume), så den
 * minns vad som sagts tidigare i samma chatt.
 *
 * sketch() är grafens "Claude ritar" och summarize() Pablo scannings summering av
 * en sida: fristående frågor utan verktyg, utan minne och utan dina inställningar
 * och MCP-servrar.
 *
 * Alla kör alltid Opus 5.5, oavsett modellen i dina Claude Code-inställningar:
 * Pablo ska vara smart, inte snabb.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SYSTEM = [
  'Du är Claude, inbyggd i Riptide: användarens privata hobbyapp för krypto- och terminshandel.',
  'Allt i appen är demokonton med riktiga Bybit-priser men inga riktiga pengar.',
  'Svara på svenska, kort och konkret. Du kan söka på webben när frågan gäller nyheter eller priser just nu.',
  'Säg tydligt när något är osäkert, och presentera aldrig en prognos som säker.'
].join(' ');

export const SKETCH_SYSTEM = [
  'Du är Pablo, en erfaren daytrader i kryptoperpetuals, inbyggd i Riptide: användarens privata hobbyapp med demokonton.',
  'Du läser en graf som en diskretionär trader och ritar ditt bästa förlopp för de kommande candlarna.',
  'Ritningen bedöms på hur nära stängningarna hamnar det som verkligen händer, så rita det mest sannolika förloppet — inte det mest spännande.',
  'Håll candlarnas storlek realistisk för tidsramen och följ svarsformatet exakt — appen ritar raderna direkt.'
].join(' ');

const SUMMARY_SYSTEM = [
  'Du är Pablo, inbyggd i Riptide: användarens privata hobbyapp för krypto- och terminshandel med demokonton.',
  'Du summerar nya rubriker från en nyhetssida. Skriv på svenska, kort och sakligt, bara utifrån rubrikerna du får.',
  'Hitta inte på detaljer, ge inga köp- eller säljråd och presentera aldrig en gissning som säker.'
].join(' ');
const MODEL = 'claude-opus-5-5';

const TOOLS = 'WebSearch';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Var claude.exe kan ligga, i tur och ordning: RIPTIDE_CLAUDE, den fristående
   installationen, VS Code-tillägget (nyaste versionen) och sist PATH. */
export function findClaude(env = process.env, home = homedir()){
  const list = [];
  if(env.RIPTIDE_CLAUDE) list.push(env.RIPTIDE_CLAUDE);
  list.push(join(home, '.local', 'bin', 'claude.exe'));
  for(const dir of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']){
    const ext = join(home, dir, 'extensions');
    let names = [];
    try{ names = readdirSync(ext).filter(n => /^anthropic\.claude-code-/i.test(n)); }catch{ /* ingen sådan editor */ }
    names.sort(compareVersions).reverse();
    for(const n of names) list.push(join(ext, n, 'resources', 'native-binary', 'claude.exe'));
  }
  for(const dir of String(env.PATH || env.Path || '').split(';').filter(Boolean)) list.push(join(dir, 'claude.exe'));
  return list.find(p => { try{ return existsSync(p); }catch{ return false; } }) || null;
}

function compareVersions(a, b){
  const v = s => (s.match(/(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map(Number);
  const x = v(a), y = v(b);
  for(let i = 0; i < 3; i++) if(x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/* Tolkar en rad från --output-format stream-json till det chatten behöver:
   {delta} för ny text, {tool} när Claude söker, {done} med hela svaret eller {error}. */
export function readLine(line){
  let m;
  try{ m = JSON.parse(line); }catch{ return null; }
  if(!m || typeof m !== 'object') return null;
  if(m.type === 'stream_event'){
    const e = m.event || {};
    if(e.type === 'content_block_delta' && e.delta?.type === 'text_delta') return { delta: String(e.delta.text || '') };
    if(e.type === 'content_block_start' && /tool_use$/.test(e.content_block?.type || '')) return { tool: String(e.content_block.name || 'verktyg') };
    if(e.type === 'message_start') return { message: true };
    return null;
  }
  if(m.type === 'result'){
    if(m.is_error || m.subtype !== 'success') return { error: String(m.result || m.subtype || 'Claude svarade med ett fel') };
    return { done: String(m.result ?? '') };
  }
  return null;
}

export function createClaudeBridge({ workDir, find = findClaude, run = spawn } = {}){
  const started = new Set();          // sessioner Claude redan känner till: de fortsätts med --resume
  const running = new Map();          // id → barnprocess

  function status(){
    const bin = find();
    return bin ? { ok: true, bin } : { ok: false, reason: 'Hittar inte Claude Code (claude.exe). Installera Claude Code eller VS Code-tillägget och logga in där.' };
  }

  /* Ställer en fråga. send(event) får {delta}, {tool}, {message}; löftet ger {text} eller avvisas med felet. */
  function ask({ id, prompt, sessionId }, send){
    const bin = find();
    if(!bin) return Promise.reject(new Error(status().reason));
    if(!UUID.test(String(sessionId || ''))) return Promise.reject(new Error('ogiltigt sessions-id'));
    const question = String(prompt || '').trim();
    if(!question) return Promise.reject(new Error('tom fråga'));
    if(question.length > 60000) return Promise.reject(new Error('frågan är för lång'));
    try{ mkdirSync(workDir, { recursive: true }); }catch{ /* finns redan */ }
    // En avbruten första fråga kan ha hunnit skapa sessionen: då fortsätts den i stället.
    return once(id, question, sessionId, send).catch(e => {
      if(!/already in use/i.test(e.message) || started.has(sessionId)) throw e;
      started.add(sessionId);
      return once(id, question, sessionId, send);
    });
  }

  /* Grafens gissning och sidornas summeringar: samma strömning som ask(), men en fristående fråga. */
  const sketch = single(SKETCH_SYSTEM), summarize = single(SUMMARY_SYSTEM);
  function single(system){ return ({ id, prompt }, send) => {
    const bin = find();
    if(!bin) return Promise.reject(new Error(status().reason));
    const question = String(prompt || '').trim();
    if(!question) return Promise.reject(new Error('tom fråga'));
    if(question.length > 60000) return Promise.reject(new Error('frågan är för lång'));
    try{ mkdirSync(workDir, { recursive: true }); }catch{ /* finns redan */ }
    return spawnAsk(id, question, ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', MODEL, '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '',
      '--system-prompt', system], send);
  }; }

  function once(id, question, sessionId, send){
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', MODEL, '--tools', TOOLS, '--allowedTools', TOOLS, '--system-prompt', SYSTEM,
      ...(started.has(sessionId) ? ['--resume', sessionId] : ['--session-id', sessionId])];
    return spawnAsk(id, question, args, send, sessionId);
  }

  function spawnAsk(id, question, args, send, sessionId = null){
    const bin = find();
    const child = run(bin, args, { cwd: workDir, windowsHide: true, env: process.env });
    running.set(id, child);

    return new Promise((resolve, reject) => {
      let buf = '', text = '', fail = null, done = null, errOut = '';
      const handle = line => {
        const r = readLine(line);
        if(!r) return;
        if(r.delta){ text += r.delta; send({ delta: r.delta }); }
        else if(r.tool) send({ tool: r.tool });
        else if(r.message){ if(text && !/\n$/.test(text)){ text += '\n\n'; send({ delta: '\n\n' }); } }
        else if(r.error) fail = r.error;
        else if('done' in r) done = r.done;
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buf += chunk;
        let i;
        while((i = buf.indexOf('\n')) >= 0){ handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { errOut = (errOut + chunk).slice(-2000); });
      child.on('error', e => { running.delete(id); reject(e); });
      child.on('close', code => {
        running.delete(id);
        if(buf.trim()) handle(buf);
        if(done !== null || (code === 0 && !fail)){
          if(sessionId) started.add(sessionId);
          resolve({ text: text || done || '' });
        }else{
          if(text && sessionId) started.add(sessionId);   // svaret kom en bit: sessionen finns
          reject(new Error(fail || errOut.trim().split('\n').pop() || (child.killed ? 'avbruten' : 'Claude avslutade med kod ' + code)));
        }
      });
      child.stdin.end(question);
    });
  }

  function cancel(id){
    const child = running.get(id);
    if(child){ child.kill(); running.delete(id); }
  }

  function stopAll(){ for(const id of [...running.keys()]) cancel(id); }

  return { status, ask, sketch, summarize, cancel, stopAll };
}
