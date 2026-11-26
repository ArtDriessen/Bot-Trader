// Leitura das calls do Telegram (bot por long polling, sem dependências extras).
// Segurança: só lê o chat autorizado, ignora mensagens antigas/respostas/encaminhadas e nunca repete uma mensagem.
// Por padrão a call fica "aguardando" a sua aprovação no painel; TELEGRAM_AUTO_EXECUTE=true executa sozinho.
const crypto = require('crypto');
const store = require('./store');
const { parseCall } = require('./parser');
const signals = require('./signals');

const cfg = () => ({
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: String(process.env.TELEGRAM_CHAT_ID || '').trim(),
  allowedUsers: String(process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  auto: process.env.TELEGRAM_AUTO_EXECUTE === 'true',
  maxAgeMin: Number(process.env.TELEGRAM_MAX_AGE_MIN || 10),
  expireHours: Number(process.env.TELEGRAM_EXPIRE_HOURS || 24),
  base: (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, ''),
});

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const status = { enabled: false, connected: false, lastPollAt: null, lastError: null };
const MAX_CALLS = 200;

// ---------- Caixa de calls ----------
const calls = () => store.load('calls.json', []);
const saveCalls = (list) => store.save('calls.json', list.slice(0, MAX_CALLS));

function record(entry) {
  const list = calls();
  const e = { id: crypto.randomUUID(), receivedAt: new Date().toISOString(), ...entry };
  list.unshift(e);
  saveCalls(list);
  return e;
}

function patch(id, fields) {
  const list = calls();
  const e = list.find((x) => x.id === id);
  if (e) Object.assign(e, fields);
  saveCalls(list);
  return e;
}

// ---------- Tratamento de cada mensagem ----------
async function handleUpdate(u) {
  const c = cfg();
  const post = u.channel_post || u.message;
  if (!post || typeof post.text !== 'string' || !post.chat) return;
  const chat = { id: String(post.chat.id), title: post.chat.title || post.chat.username || post.chat.first_name || '' };

  if (!c.chatId || chat.id !== c.chatId) {
    // Chat desconhecido: guarda só o id e o nome (não o conteúdo) para você descobrir o TELEGRAM_CHAT_ID
    const key = `chat:${chat.id}`;
    if (!calls().some((x) => x.key === key)) {
      record({ key, chat, status: 'ignorada', reason: c.chatId ? 'chat não autorizado' : 'TELEGRAM_CHAT_ID ainda não definido; use o id deste chat', at: new Date().toISOString() });
    }
    return;
  }
  if (post.reply_to_message || post.forward_origin || post.forward_date) return; // respostas e encaminhadas nunca viram ordem

  const parsed = parseCall(post.text);
  const base = { key: `${chat.id}:${post.message_id}`, chat, text: post.text.slice(0, 600), at: new Date((post.date || 0) * 1000).toISOString() };
  if (calls().some((x) => x.key === base.key)) return; // já visto

  // Em grupos (não canais) só aceita quem estiver na lista de autorizados
  if (u.message && !(post.from && c.allowedUsers.includes(String(post.from.id)))) {
    if (parsed.callish) record({ ...base, status: 'ignorada', reason: 'remetente não autorizado (defina TELEGRAM_ALLOWED_USER_IDS)' });
    return;
  }
  const ageMin = (Date.now() / 1000 - (post.date || 0)) / 60;
  if (ageMin > c.maxAgeMin) {
    if (parsed.callish) record({ ...base, status: 'ignorada', reason: `mensagem antiga (${Math.round(ageMin)} min); não executada` });
    return;
  }
  if (!parsed.ok) {
    if (parsed.callish) record({ ...base, status: 'ignorada', reason: parsed.reason });
    return;
  }
  const e = record({ ...base, status: 'aguardando', parsed: parsed.call });
  if (c.auto) await executeCall(e.id).catch((err) => console.error('telegram: erro ao executar call:', err.message));
}

// ---------- Ações do admin ----------
async function executeCall(id) {
  const list = calls();
  const e = list.find((x) => x.id === id);
  if (!e) throw bad('Call não encontrada', 404);
  if (e.status !== 'aguardando') throw bad(`Esta call já está "${e.status}"`, 409);
  e.status = 'executando'; // reserva antes de qualquer espera: impede executar duas vezes
  saveCalls(list);
  try {
    const { signal, legs } = await signals.submit({ ...e.parsed, expireHours: cfg().expireHours });
    const erros = legs.filter((l) => l.status === 'erro').length;
    return patch(id, { status: 'executada', signalId: signal.id, result: { contas: legs.length, erros } });
  } catch (err) {
    if (!err.expose) console.error('telegram: falha ao enviar o sinal:', err.message);
    return patch(id, { status: 'erro', reason: err.expose ? err.message : 'falha ao enviar o sinal' });
  }
}

function discardCall(id) {
  const e = calls().find((x) => x.id === id);
  if (!e) throw bad('Call não encontrada', 404);
  if (e.status !== 'aguardando') throw bad(`Esta call já está "${e.status}"`, 409);
  return patch(id, { status: 'descartada' });
}

// ---------- Leitura do canal (long polling) ----------
async function api(method, params) {
  const c = cfg();
  const r = await fetch(`${c.base}/bot${c.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(40000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || `HTTP ${r.status}`);
  return j.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;

async function loop() {
  let backoff = 1000;
  while (running) {
    try {
      const st = store.load('telegram.json', { offset: 0 });
      const updates = await api('getUpdates', { offset: st.offset, timeout: 25, allowed_updates: ['channel_post', 'message'] });
      status.connected = true; status.lastError = null; status.lastPollAt = new Date().toISOString();
      backoff = 1000;
      for (const u of updates) {
        try {
          await handleUpdate(u);
        } catch (e) {
          console.error('telegram: erro ao tratar mensagem:', e.message);
        }
        st.offset = u.update_id + 1; // confirma só depois de tratar; o offset sobrevive a reinícios
        store.save('telegram.json', st);
      }
      if (!updates.length) await sleep(300);
    } catch (e) {
      status.connected = false; status.lastError = String(e.message).slice(0, 200);
      console.error('telegram:', status.lastError); // nunca inclui o token
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

function start() {
  const c = cfg();
  if (!c.token) {
    console.log('Telegram: desativado (defina TELEGRAM_BOT_TOKEN para ler as calls do canal)');
    return;
  }
  status.enabled = true;
  running = true;
  console.log(`Telegram: ${c.chatId ? `lendo o chat ${c.chatId}` : 'TELEGRAM_CHAT_ID não definido (nenhuma call será lida)'}; modo ${c.auto ? 'automático' : 'com aprovação'}`);
  loop();
}

const stopPolling = () => { running = false; };
const listCalls = () => calls();
const getStatus = () => {
  const c = cfg();
  return { ...status, chatConfigured: !!c.chatId, auto: c.auto, maxAgeMin: c.maxAgeMin };
};

module.exports = { start, stopPolling, listCalls, getStatus, executeCall, discardCall, handleUpdate };
