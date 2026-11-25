const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
const PORT = 39000 + Math.floor(Math.random() * 500);
Object.assign(process.env, {
  DATA_DIR: DATA, PORT: String(PORT), ADMIN_TOKEN: 'admin-token-de-teste', INVITE_CODE: 'convite123',
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), POLL_SECONDS: '3600',
});

const { Fake, holder, install } = require('./fake-exchange');
install();
const fake = (holder.current = new Fake(100));
require('../server.js');

const BASE = `http://127.0.0.1:${PORT}`;
async function call(method, url, { body, cookie, admin, csrf = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (csrf) headers['x-requested-with'] = 'fetch';
  if (cookie) headers.cookie = cookie;
  if (admin) headers['x-admin-token'] = admin;
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const ADMIN = 'admin-token-de-teste';
const reg = (n, extra = {}) => call('POST', '/api/auth/register', {
  body: { name: n, email: `${n}@teste.com`, password: 'senha-bem-longa-123', acceptTerms: true, inviteCode: 'convite123', ...extra },
});

(async () => {
  await new Promise((r) => setTimeout(r, 300));

  // --- Cadastro ---
  assert.equal((await reg('ana', { acceptTerms: false })).status, 400, 'exige aceite do termo');
  assert.equal((await reg('ana', { inviteCode: 'errado' })).status, 403, 'exige convite');
  assert.equal((await reg('ana', { password: 'curta' })).status, 400, 'senha curta');
  const ana = await reg('ana');
  assert.equal(ana.status, 201); assert.ok(ana.cookie.startsWith('sid='));
  assert.equal((await reg('ana')).status, 409, 'e-mail duplicado');
  const users = JSON.parse(fs.readFileSync(path.join(DATA, 'users.json'), 'utf8'));
  assert.ok(users[0].termsAcceptedAt && users[0].termsVersion, 'aceite registrado com data e versão');
  assert.ok(users[0].passwordHash.startsWith('scrypt$') && !JSON.stringify(users).includes('senha-bem-longa'), 'senha só como hash');
  console.log('1) cadastro (aceite, convite, senha, duplicado): ok');

  // --- Sessão e proteção ---
  assert.equal((await call('GET', '/api/me')).status, 401);
  const me = await call('GET', '/api/me', { cookie: ana.cookie });
  assert.equal(me.status, 200); assert.equal(me.data.user.email, 'ana@teste.com');
  assert.equal((await call('POST', '/api/connections', { cookie: ana.cookie, csrf: false, body: {} })).status, 403, 'CSRF');
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'ana@teste.com', password: 'errada-errada' } })).status, 401);
  const login = await call('POST', '/api/auth/login', { body: { email: 'ana@teste.com', password: 'senha-bem-longa-123' } });
  assert.equal(login.status, 200);
  console.log('2) sessão, login e CSRF: ok');

  // --- Conexões: validações ---
  const base = { exchange: 'binance', market: 'spot', apiKey: 'CHAVE-SECRETA-ABC12345', apiSecret: 'SEGREDO-XYZ-98765432', allocationPct: 20 };
  const post = (over) => call('POST', '/api/connections', { cookie: ana.cookie, body: { ...base, ...over } });
  assert.equal((await post({ allocationPct: 101 })).status, 400, '% da banca acima de 100');
  assert.equal((await post({ allocationPct: -1 })).status, 400);
  assert.equal((await post({ targets: [{ gainPct: 0.5, sellPct: 50 }] })).status, 400, 'alvo abaixo de 1%');
  assert.equal((await post({ targets: [{ gainPct: 41, sellPct: 50 }] })).status, 400, 'alvo acima de 40%');
  assert.equal((await post({ targets: [{ gainPct: 5, sellPct: 60 }, { gainPct: 10, sellPct: 50 }] })).status, 400, 'soma > 100%');
  assert.equal((await post({ targets: [{ gainPct: 5, sellPct: 50 }, { gainPct: 5, sellPct: 50 }] })).status, 400, 'alvos repetidos');
  assert.equal((await post({ exchange: 'kraken' })).status, 400);
  assert.equal((await post({ apiKey: '' })).status, 400);

  // --- Conexões: criação e criptografia ---
  const a1 = await post({ targets: [{ gainPct: 10, sellPct: 50 }, { gainPct: 5, sellPct: 50 }] });
  assert.equal(a1.status, 201);
  assert.deepEqual(a1.data.targets, [{ gainPct: 5, sellPct: 50 }, { gainPct: 10, sellPct: 50 }], 'alvos ordenados');
  assert.ok(!('apiKey' in a1.data) && !('apiSecret' in a1.data), 'API não devolve chaves');
  assert.equal(a1.data.apiKeyHint, '2345');
  const raw = fs.readFileSync(path.join(DATA, 'connections.json'), 'utf8');
  assert.ok(!raw.includes('CHAVE-SECRETA') && !raw.includes('SEGREDO-XYZ'), 'chaves criptografadas em disco');
  const a2 = await post({ market: 'futures', leverage: 3, allocationPct: 0 }); // 0% = não opera
  const a3 = await post({ allocationPct: 10 });
  assert.equal((await call('PATCH', `/api/connections/${a3.data.id}`, { cookie: ana.cookie, body: { active: false } })).data.active, false);
  console.log('3) contas: validações (0-100%, alvos 1-40%), ordenação e chaves criptografadas: ok');

  // --- Isolamento entre usuários ---
  const bia = await reg('bia');
  const b1 = await call('POST', '/api/connections', { cookie: bia.cookie, body: { ...base, allocationPct: 10, targets: [{ gainPct: 2, sellPct: 100 }] } });
  assert.equal(b1.status, 201);
  assert.equal((await call('PATCH', `/api/connections/${a1.data.id}`, { cookie: bia.cookie, body: { allocationPct: 99 } })).status, 404);
  assert.equal((await call('DELETE', `/api/connections/${a1.data.id}`, { cookie: bia.cookie })).status, 404);
  assert.equal((await call('GET', '/api/me', { cookie: bia.cookie })).data.connections.length, 1);
  console.log('4) usuário não acessa a conta de outro: ok');

  // --- Admin e call ---
  assert.equal((await call('POST', '/api/admin/signal', { body: {} })).status, 401);
  assert.equal((await call('POST', '/api/admin/signal', { admin: ADMIN, body: { pair: 'BTC/USDT', entry: 100, stop: 105 } })).status, 400, 'stop acima da entrada');
  assert.equal((await call('GET', '/api/admin/users', { cookie: ana.cookie })).status, 401, 'sessão de usuário não é admin');
  const sig = await call('POST', '/api/admin/signal', { admin: ADMIN, body: { pair: 'BTC/USDT', type: 'market', entry: 100, stop: 95 } });
  assert.equal(sig.status, 200);
  assert.equal(sig.data.legs.length, 2, 'só contas ativas e com % > 0 (ana/a1 e bia/b1)');
  const anaLegs = (await call('GET', '/api/me/legs', { cookie: ana.cookie })).data;
  const biaLegs = (await call('GET', '/api/me/legs', { cookie: bia.cookie })).data;
  assert.equal(anaLegs.length, 1); assert.equal(biaLegs.length, 1);
  assert.deepEqual(anaLegs[0].targets, [{ gainPct: 5, sellPct: 50 }, { gainPct: 10, sellPct: 50 }]);
  assert.equal(anaLegs[0].status, 'ativa'); assert.equal(biaLegs[0].status, 'ativa');
  const buys = fake.orders.filter((o) => o.side === 'buy');
  assert.equal(buys.length, 2);
  assert.equal(buys[0].amount, '1.9900', 'ana: 20% de 1000 USDT a 100 (-0,5% taxas)');
  assert.equal(buys[1].amount, '0.9950', 'bia: 10%');
  assert.deepEqual(anaLegs[0].softTps.map((t) => t.price), [105, 110], 'alvos em +5% e +10% do preço de compra');
  assert.deepEqual(biaLegs[0].softTps.map((t) => t.price), [102]);
  assert.ok(fake.orders.filter((o) => o.params.stopLossPrice === 95).length === 2, 'stop da call nas duas contas');
  console.log('5) call -> ordens: entrada/stop da call, % e alvos de cada usuário: ok');

  // --- Remover conta com operação ativa e editar durante ---
  assert.equal((await call('DELETE', `/api/connections/${a1.data.id}`, { cookie: ana.cookie })).status, 409);
  assert.equal((await call('DELETE', `/api/connections/${a2.data.id}`, { cookie: ana.cookie })).status, 200);

  // --- Bloqueio ---
  const list = await call('GET', '/api/admin/users', { admin: ADMIN });
  assert.equal(list.data.length, 2); assert.ok(!JSON.stringify(list.data).includes('passwordHash'));
  await call('POST', `/api/admin/users/${list.data.find((u) => u.name === 'bia').id}/block`, { admin: ADMIN, body: { blocked: true } });
  assert.equal((await call('GET', '/api/me', { cookie: bia.cookie })).status, 401, 'sessão cai ao bloquear');
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'bia@teste.com', password: 'senha-bem-longa-123' } })).status, 403);
  console.log('6) remoção bloqueada com operação ativa e bloqueio de usuário: ok');

  console.log('API: tudo ok');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
