const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-tg-'));
const PORT = 39500 + Math.floor(Math.random() * 400);
const TG_PORT = 39900 + Math.floor(Math.random() * 90);
const CHAT = '-100123456';
Object.assign(process.env, {
  DATA_DIR: DATA, PORT: String(PORT), ADMIN_TOKEN: 'adm-tg', ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  POLL_SECONDS: '3600', TELEGRAM_BOT_TOKEN: '123:ABC', TELEGRAM_CHAT_ID: CHAT, TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
});
delete process.env.TELEGRAM_AUTO_EXECUTE;

// ---- API do Telegram simulada ----
const updates = [];
let nextId = 1000;
const tgServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    assert.equal(req.url, '/bot123:ABC/getUpdates');
    const { offset } = JSON.parse(raw || '{}');
    const send = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: updates.filter((u) => u.update_id >= offset) })); };
    if (updates.some((u) => u.update_id >= offset)) send(); else setTimeout(send, 120);
  });
}).listen(TG_PORT);

let msgId = 1;
const now = () => Math.floor(Date.now() / 1000);
const post = (text, extra = {}, chatId = CHAT) => { updates.push({ update_id: nextId++, channel_post: { message_id: msgId++, date: now(), chat: { id: Number(chatId), title: 'Canal de Calls', type: 'channel' }, text, ...extra } }); };
const group = (text, fromId) => { updates.push({ update_id: nextId++, message: { message_id: msgId++, date: now(), chat: { id: Number(CHAT), title: 'Sala', type: 'supergroup' }, from: { id: fromId }, text } }); };

const { Fake, holder, install } = require('./fake-exchange');
install();
const fake = (holder.current = new Fake(100));
require('../server.js');

const BASE = `http://127.0.0.1:${PORT}`;
async function call(method, url, { body, cookie, admin } = {}) {
  const headers = { 'content-type': 'application/json', 'x-requested-with': 'fetch' };
  if (cookie) headers.cookie = cookie;
  if (admin) headers['x-admin-token'] = admin;
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const calls = async () => (await call('GET', '/api/admin/calls', { admin: 'adm-tg' })).data;
const waitFor = async (fn, what, ms = 6000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`tempo esgotado esperando: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const byText = async (frag) => (await calls()).calls.find((c) => c.text && c.text.includes(frag));

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  // usuário com uma conta ativa
  const u = await call('POST', '/api/auth/register', { body: { name: 'Teste', email: 't@t.com', password: 'senha-bem-longa-1', acceptTerms: true } });
  const conn = await call('POST', '/api/connections', { cookie: u.cookie, body: { exchange: 'binance', market: 'spot', apiKey: 'KEY-12345678', apiSecret: 'SECRET-12345678', allocationPct: 20 } });
  assert.equal(conn.status, 201);

  assert.equal((await call('GET', '/api/admin/calls')).status, 401, 'caixa de calls é só do admin');

  // 1) chat desconhecido: guarda só id/nome, nunca o conteúdo
  post('SEGREDO: BTC/USDT entrada 100 stop 95', {}, '-999');
  const foreign = await waitFor(async () => (await calls()).calls.find((c) => c.chat?.id === '-999'), 'chat desconhecido');
  assert.equal(foreign.status, 'ignorada'); assert.ok(!foreign.text && !JSON.stringify(foreign).includes('SEGREDO'));
  console.log('1) chat não autorizado: ignorado, conteúdo não guardado: ok');

  // 2) call do canal autorizado: fica aguardando aprovação (modo padrão)
  post('Compra BTC/USDT\nEntrada: 100\nStop: 95\nAlvo 1: 105');
  const c1 = await waitFor(() => byText('Alvo 1'), 'call interpretada');
  assert.equal(c1.status, 'aguardando'); assert.deepEqual(c1.parsed, { pair: 'BTC/USDT', entry: 100, stop: 95, type: 'auto' });
  assert.equal(fake.orders.length, 0, 'sem aprovação não executa');
  assert.equal((await call('GET', '/api/admin/legs', { admin: 'adm-tg' })).data.length, 0);
  console.log('2) call lida e aguardando aprovação (nada executado): ok');

  // 3) aprovar: executa uma única vez
  const ex = await call('POST', `/api/admin/calls/${c1.id}/execute`, { admin: 'adm-tg' });
  assert.equal(ex.status, 200); assert.equal(ex.data.status, 'executada'); assert.equal(ex.data.result.contas, 1);
  assert.equal(fake.orders.filter((o) => o.side === 'buy').length, 1);
  assert.equal((await call('POST', `/api/admin/calls/${c1.id}/execute`, { admin: 'adm-tg' })).status, 409, 'não executa duas vezes');
  console.log('3) aprovação executa uma vez só: ok');

  // 4) coisas que NUNCA viram ordem
  post('BTC/USDT entrada 100 stop 95 ✅ alvo 1 batido, gain 5%');            // resultado
  post('BTC/USDT entrada 100 stop 95', { reply_to_message: { message_id: 1 } }); // resposta
  post('BTC/USDT entrada 100 stop 95', { forward_origin: { type: 'channel' } }); // encaminhada
  post('Bom dia pessoal!');                                                  // conversa
  updates.push({ update_id: nextId++, channel_post: { message_id: msgId++, date: now() - 3600, chat: { id: Number(CHAT), type: 'channel' }, text: 'BTC/USDT entrada 100 stop 95' } }); // antiga
  post('BTC/USDT entrada 100-102 stop 95'); // faixa
  const res = await waitFor(async () => { const l = (await calls()).calls; return l.find((c) => c.reason && /faixa/.test(c.reason)) && l; }, 'ignoradas');
  const reasons = res.map((c) => c.reason || '').join(' | ');
  assert.match(reasons, /resultado/); assert.match(reasons, /antiga/); assert.match(reasons, /faixa/);
  assert.ok(!res.some((c) => c.status === 'aguardando' && c.id !== c1.id), 'nada virou ordem');
  assert.ok(!res.some((c) => c.text === 'Bom dia pessoal!'), 'conversa não vai para a caixa');
  assert.equal(res.filter((c) => c.text === 'BTC/USDT entrada 100 stop 95').length, 1, 'só a antiga foi registrada (resposta/encaminhada ignoradas)');
  console.log('4) resultado, resposta, encaminhada, antiga, faixa e conversa: não viram ordem: ok');

  // 5) mensagem repetida (mesmo message_id) não duplica
  const dup = { update_id: nextId++, channel_post: { message_id: 5555, date: now(), chat: { id: Number(CHAT), type: 'channel' }, text: 'ETH/USDT entrada 100 stop 90' } };
  updates.push(dup, { ...dup, update_id: nextId++ });
  await waitFor(() => byText('ETH/USDT'), 'call repetida');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await calls()).calls.filter((c) => c.text === 'ETH/USDT entrada 100 stop 90').length, 1);
  const d = (await calls()).calls.find((c) => c.text === 'ETH/USDT entrada 100 stop 90');
  assert.equal((await call('POST', `/api/admin/calls/${d.id}/discard`, { admin: 'adm-tg' })).data.status, 'descartada');
  console.log('5) mensagem repetida registrada uma vez; descartar funciona: ok');

  // 6) grupo: só remetentes autorizados
  group('BTC/USDT entrada 100 stop 95 fundo', 7);
  await waitFor(async () => (await calls()).calls.find((c) => /remetente não autorizado/.test(c.reason || '')), 'remetente');
  process.env.TELEGRAM_ALLOWED_USER_IDS = '42';
  group('SOL/USDT entrada 100 stop 95', 42);
  const g = await waitFor(() => byText('SOL/USDT'), 'grupo autorizado');
  assert.equal(g.status, 'aguardando');
  console.log('6) grupo: só remetente autorizado: ok');

  // 7) modo automático: executa sozinho
  process.env.TELEGRAM_AUTO_EXECUTE = 'true';
  const before = fake.orders.length;
  post('Compra BTC/USDT\nEntrada: 100\nStop: 96\nAuto');
  const auto = await waitFor(async () => { const c = await byText('Auto'); return c && c.status === 'executada' && c; }, 'execução automática');
  assert.equal(auto.result.contas, 1); assert.ok(fake.orders.length > before);
  console.log('7) modo automático executa sozinho: ok');

  // 8) offset persistido (não repete mensagens após reinício)
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'telegram.json'), 'utf8'));
  assert.equal(st.offset, nextId, 'offset aponta para depois da última atualização');
  console.log('8) offset salvo em disco: ok');

  console.log('Telegram: tudo ok');
  tgServer.close();
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
