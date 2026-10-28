/* Grafens chatt (Pablo) i AI Forecast. I desktop-appen går frågan till Claude Code på
   den här datorn (window.riptideDesktop.claude), med din egen inloggning — ingen
   API-nyckel. I webbläsaren finns ingen sådan väg, och panelen säger det.

   mountChat(root, {desktop, context, key, title, sub, ctxLabel, hint, onClose, onDraw}) → {ask(text, {withContext}), post(role, text), show()}
   key: var chatten sparas i sessionStorage — en per fönster och chatt, så två aldrig delar en Claude-session.
   context(): {text, label} | null — underlaget som kan skickas med frågan.
   title, sub, ctxLabel, hint: rubriken, raden under den, rutan för underlaget och texten i en tom chatt
   (grafens chatt i AI Forecast har egna).
   onClose(): ger rubriken en ✕ som döljer chatten. onDraw(text): ger en knapp ✦ Rita bredvid Skicka som lämnar det
   som står i rutan (kan vara tomt) till grafen; post() skriver frågan och svaret i chatten. */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => globalThis.crypto?.randomUUID?.() ||
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });

/* Lite markdown: kodblock, `kod`, **fet**, länkar, rubriker och punktlistor. Allt annat är text. */
export function renderMarkdown(src){
  const parts = String(src || '').split(/```(?:[\w-]*)\n?/);
  return parts.map((part, i) => {
    if(i % 2) return `<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`;
    return esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/^#{1,4} (.+)$/gm, '<b class="ch-h">$1</b>')
      .replace(/^\s*[-*] (.+)$/gm, '<span class="ch-li">$1</span>')
      .replace(/<\/span>\n+(?=<span class="ch-li">)/g, '</span>')   // punkterna är block: inga tomrader mellan dem
      .replace(/\n/g, '<br>');
  }).join('');
}

export function mountChat(root, { desktop = globalThis.riptideDesktop, context = () => null, storage = globalThis.sessionStorage, key = 'riptide.chat.v1',
  title = 'Claude', sub = 'chatt', ctxLabel = 'Skicka med Pablos rubriker',
  hint = 'Fråga om marknaden, nyheterna Pablo scanning hittat eller AI Forecast. Claude kan söka på webben men kommer inte åt dina filer eller ditt konto.',
  onClose = null, onDraw = null } = {}){
  const api = desktop?.claude;
  const titleId = 'chTitle-' + key.replace(/[^\w-]/g, '-');
  root.innerHTML = `<section class="ch" aria-labelledby="${titleId}">
  <header class="mv-phead">
    <h2 id="${titleId}">${esc(title)} <small>${esc(sub)}</small></h2>
    <span class="ch-pill" data-ch-pill data-state="idle"><i aria-hidden="true"></i><span data-ch-pill-text>Kollar…</span></span>
    <div class="mv-pbtns"><button type="button" class="mv-btn" data-ch-new title="Börja en ny chatt — ${esc(title)} glömmer den här">Ny chatt</button>${onClose ? '<button type="button" class="mv-btn" data-ch-close title="Dölj chatten" aria-label="Dölj chatten">✕</button>' : ''}</div>
  </header>
  <div class="ch-log" data-ch-log aria-live="polite"></div>
  <form class="ch-form" data-ch-form>
    <label class="ch-ctx"><input type="checkbox" data-ch-ctx checked> ${esc(ctxLabel)}</label>
    <div class="ch-row">
      <textarea data-ch-input rows="2" placeholder="Fråga ${esc(title)}… (Enter skickar, Shift+Enter ny rad)" aria-label="Fråga till ${esc(title)}"></textarea>
      <button type="submit" class="mv-btn mv-accent" data-ch-send>Skicka</button>${onDraw ? `<button type="button" class="mv-btn ch-draw" data-ch-draw title="${esc(title)} ritar vart marknaden kan gå i grafen — det du skrivit följer med">✦ Rita</button>` : ''}
    </div>
  </form>
</section>`;
  const q = s => root.querySelector(s);
  const el = { pill: q('[data-ch-pill]'), pillText: q('[data-ch-pill-text]'), log: q('[data-ch-log]'), form: q('[data-ch-form]'),
    input: q('[data-ch-input]'), send: q('[data-ch-send]'), ctx: q('[data-ch-ctx]'), fresh: q('[data-ch-new]'), draw: q('[data-ch-draw]') };

  let chat = { sessionId: uuid(), messages: [] };
  try{ const kept = JSON.parse(storage?.getItem(key) || 'null'); if(kept?.sessionId && Array.isArray(kept.messages)) chat = kept; }catch{ /* ny chatt */ }
  const save = () => { try{ storage?.setItem(key, JSON.stringify({ sessionId: chat.sessionId, messages: chat.messages.slice(-60) })); }catch{ /* valfritt */ } };
  let busy = null, ready = false;

  function pill(state, text){ el.pill.dataset.state = state; el.pillText.textContent = text; }

  async function check(){
    if(!api){ pill('off', 'Bara i desktop-appen'); render(); return; }
    try{
      const s = await api.status();
      ready = !!s?.ok;
      pill(ready ? 'on' : 'off', ready ? 'Ansluten' :'Hittar inte Claude Code');
      if(!ready) chat.notice = s?.reason || '';
    }catch(e){ ready = false; pill('off', 'Ej ansluten'); chat.notice = e.message; }
    render();
  }

  function render(){
    const intro = !api
      ? `<p class="ch-note">Chatten pratar med Claude Code på din dator, med din egen inloggning — utan API-nyckel. Det går bara i <b>desktop-appen</b> (Riptide.exe), inte i webbläsaren.</p>`
      : !ready && chat.notice ? `<p class="ch-note">${esc(chat.notice)}</p>`
      : !chat.messages.length ? `<p class="ch-note">${esc(hint)}</p>` : '';
    el.log.innerHTML = intro + chat.messages.map(m => `<div class="ch-msg ${m.role}${m.error ? ' err' : ''}">
      ${m.role === 'user' ? esc(m.text).replace(/\n/g, '<br>') : renderMarkdown(m.text) || (m.pending ? '<span class="ch-dots"><i></i><i></i><i></i></span>' : '')}
      ${m.note ? `<small>${esc(m.note)}</small>` : ''}</div>`).join('');
    el.log.scrollTop = el.log.scrollHeight;
    el.send.textContent = busy ? 'Stoppa' : 'Skicka';
    el.send.classList.toggle('mv-danger', !!busy);
    el.input.disabled = !api || !ready;
    el.send.disabled = !busy && (!api || !ready);
    if(el.draw) el.draw.disabled = !api || !ready;
  }

  async function ask(text, { withContext = el.ctx.checked } = {}){
    const question = String(text || '').trim();
    if(!question || busy || !api || !ready) return;
    const ctx = withContext ? context?.() : null;
    const prompt = ctx?.text ? `Underlag från Riptide-appen:\n${ctx.text}\n\nFråga: ${question}` : question;
    chat.messages.push({ role: 'user', text: question, note: ctx?.text ? '+ ' + ctx.label : '' });
    const reply = { role: 'claude', text: '', pending: true };
    chat.messages.push(reply);
    const id = uuid();
    busy = { id };
    const off = api.onEvent(ev => {
      if(ev?.id !== id) return;
      if(ev.delta){ reply.text += ev.delta; reply.note = ''; render(); }
      else if(ev.tool){ reply.note = ev.tool === 'WebSearch' ? 'Söker på webben…' : 'Använder ' + ev.tool + '…'; render(); }
    });
    render();
    try{
      const r = await api.ask({ id, prompt, sessionId: chat.sessionId });
      if(!reply.text) reply.text = r?.text || '(tomt svar)';
    }catch(e){
      reply.error = true;
      const msg = String(e?.message || e);
      reply.text = (reply.text ? reply.text + '\n\n' : '') + (/log ?in|logged|auth/i.test(msg) ? 'Claude Code är inte inloggat. Logga in i VS Code-tillägget eller med `claude` i en terminal och försök igen.\n\n' : '') + '⚠ ' + msg;
    }finally{
      off?.(); reply.pending = false; reply.note = ''; busy = null; save(); render();
      el.input.focus();
    }
  }

  el.form.onsubmit = e => {
    e.preventDefault();
    if(busy){ void api?.cancel(busy.id); return; }
    const text = el.input.value; el.input.value = '';
    void ask(text);
  };
  el.input.onkeydown = e => { if(e.key === 'Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); el.form.requestSubmit(); } };
  if(el.draw) el.draw.onclick = () => { const text = el.input.value.trim(); el.input.value = ''; onDraw(text); };
  const close = q('[data-ch-close]');
  if(close) close.onclick = () => onClose();
  el.fresh.onclick = () => {
    if(busy) void api?.cancel(busy.id);
    chat = { sessionId: uuid(), messages: [] }; save(); render();
  };

  void check();
  // En rad från någon annan än chatten själv (grafens ritning): sparas och visas som chattens egna.
  function post(role, text, note = ''){
    if(!text) return;
    chat.messages.push({ role: role === 'user' ? 'user' : 'claude', text: String(text), note }); save(); render();
  }

  return {
    ask,
    post,
    show(){ if(api && !ready) void check(); },
    get ready(){ return ready; }
  };
}
