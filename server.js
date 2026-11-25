// Carrega o .env se existir (na hospedagem as variáveis vêm do painel)
try {
  const fs = require('fs');
  for (const line of fs.readFileSync(require('path').join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* sem .env */ }

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const store = require('./lib/store');
const { encrypt } = require('./lib/crypto');
const { create, invalidate } = require('./lib/exchange');
const monitor = require('./lib/monitor');
const { symbolFor } = require('./lib/executor');
const auth = require('./lib/auth');

const TERMS_VERSION = '2026-11-24';
const EXCHANGES = { binance: 'Binance', bybit: 'Bybit', bingx: 'BingX' };
const MARKETS = { spot: 'Spot', futures: 'Futuros' };
const MAX_CONNECTIONS = 6;
const MAX_TARGETS = 5;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '50kb' }));
// Proteção CSRF: cookie SameSite=Strict + cabeçalho próprio exigido em toda escrita
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('x-requested-with') !== 'fetch') return next(bad('Requisição inválida', 403));
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- Dados ----------
const users = () => store.load('users.json', []);
const connections = () => store.load('connections.json', []);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });
const publicConn = ({ apiKey, apiSecret, userId, ...c }) => c;

// ---------- Validação ----------
function parsePct(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw bad(`${label} deve ficar entre 0 e 100`);
  return Math.round(n * 10) / 10;
}

function parseLeverage(v, market) {
  if (market !== 'futures') return 1;
  const n = Number(v ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 125) throw bad('A alavancagem deve ser um número inteiro de 1 a 125');
  return n;
}

// Alvos: [{ gainPct: 1..40 (ganho sobre o preço de entrada), sellPct: 1..100 (parte da posição vendida) }]
function parseTargets(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_TARGETS) throw bad(`Use no máximo ${MAX_TARGETS} alvos`);
  const out = raw.map((t) => ({ gainPct: Number(t?.gainPct), sellPct: Number(t?.sellPct) }));
  for (const t of out) {
    if (!Number.isFinite(t.gainPct) || t.gainPct < 1 || t.gainPct > 40) throw bad('Cada alvo deve ficar entre 1% e 40% de ganho');
    if (!Number.isFinite(t.sellPct) || t.sellPct < 1 || t.sellPct > 100) throw bad('Cada venda deve ficar entre 1% e 100% da posição');
    t.gainPct = Math.round(t.gainPct * 10) / 10;
    t.sellPct = Math.round(t.sellPct * 10) / 10;
  }
  if (out.reduce((s, t) => s + t.sellPct, 0) > 100.0001) throw bad('A soma das vendas dos alvos não pode passar de 100% da posição');
  out.sort((a, b) => a.gainPct - b.gainPct);
  if (out.some((t, i) => i && t.gainPct === out[i - 1].gainPct)) throw bad('Há dois alvos com o mesmo %');
  return out;
}

async function testCredentials(conn) {
  try {
    await create(conn).fetchBalance();
  } catch (e) {
    throw bad(`A corretora recusou as credenciais (${String(e.message).slice(0, 140)}). Confira key, secret, permissões e restrição de IP.`);
  }
}

const requireUser = (req, res, next) => {
  const u = auth.userFromRequest(req);
  if (!u) return next(bad('Faça login para continuar', 401));
  req.user = u;
  next();
};

const requireAdmin = (req, res, next) => {
  if (safeEqual(req.get('x-admin-token'), process.env.ADMIN_TOKEN)) return next();
  if (auth.limited(`adm:${req.ip}`, 60, 15 * 60 * 1000)) return next(bad('Muitas tentativas. Aguarde alguns minutos.', 429));
  next(bad('Não autorizado', 401));
};

// ---------- Cadastro e login ----------
app.get('/api/config', (req, res) => res.json({ inviteRequired: !!process.env.INVITE_CODE, termsVersion: TERMS_VERSION }));

app.post('/api/auth/register', wrap(async (req, res) => {
  if (auth.limited(`reg:${req.ip}`, 10, 3600 * 1000)) throw bad('Muitas tentativas. Tente mais tarde.', 429);
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (name.length < 2) throw bad('Informe seu nome');
  if (email.length > 120 || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad('E-mail inválido');
  if (password.length < 10 || password.length > 200) throw bad('A senha precisa ter pelo menos 10 caracteres');
  if (b.acceptTerms !== true) throw bad('É necessário aceitar os termos e o aviso de risco para criar a conta');
  if (process.env.INVITE_CODE && !safeEqual(b.inviteCode, process.env.INVITE_CODE)) throw bad('Código de convite inválido', 403);

  const passwordHash = await auth.hashPassword(password);
  const list = users();
  if (list.some((u) => u.email === email)) throw bad('Este e-mail já está cadastrado', 409);
  const user = {
    id: crypto.randomUUID(), name, email, passwordHash, blocked: false,
    termsVersion: TERMS_VERSION, termsAcceptedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  list.push(user);
  store.save('users.json', list);
  auth.startSession(req, res, user.id);
  res.status(201).json({ user: publicUser(user) });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (auth.limited(`login-ip:${req.ip}`, 30, 15 * 60 * 1000) || auth.limited(`login:${email}`, 10, 15 * 60 * 1000)) {
    throw bad('Muitas tentativas. Aguarde alguns minutos.', 429);
  }
  const user = users().find((u) => u.email === email);
  const ok = user ? await auth.verifyPassword(password, user.passwordHash) : (await auth.burnTime(password), false);
  if (!ok) throw bad('E-mail ou senha incorretos', 401);
  if (user.blocked) throw bad('Conta bloqueada. Fale com o suporte.', 403);
  auth.startSession(req, res, user.id);
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({ user: publicUser(req.user), connections: connections().filter((c) => c.userId === req.user.id).map(publicConn) });
});

// ---------- Contas de corretora do usuário ----------
app.post('/api/connections', requireUser, wrap(async (req, res) => {
  if (auth.limited(`conn:${req.user.id}`, 20, 3600 * 1000)) throw bad('Muitas tentativas. Tente mais tarde.', 429);
  const b = req.body || {};
  if (!EXCHANGES[b.exchange] || !MARKETS[b.market]) throw bad('Escolha a corretora e o mercado');
  const apiKey = String(b.apiKey || '').trim();
  const apiSecret = String(b.apiSecret || '').trim();
  if (apiKey.length < 8 || apiKey.length > 300 || apiSecret.length < 8 || apiSecret.length > 300) throw bad('Informe a API key e a API secret');
  if (connections().filter((c) => c.userId === req.user.id).length >= MAX_CONNECTIONS) {
    throw bad(`Limite de ${MAX_CONNECTIONS} contas por usuário`);
  }
  const conn = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    label: String(b.label || '').trim().slice(0, 40) || `${EXCHANGES[b.exchange]} · ${MARKETS[b.market]}`,
    exchange: b.exchange,
    market: b.market,
    active: true,
    allocationPct: parsePct(b.allocationPct ?? 10, 'A % da banca'),
    leverage: parseLeverage(b.leverage, b.market),
    marginMode: b.marginMode === 'cross' ? 'cross' : 'isolated',
    targets: parseTargets(b.targets),
    apiKey: encrypt(apiKey),
    apiSecret: encrypt(apiSecret),
    apiKeyHint: apiKey.slice(-4),
    createdAt: new Date().toISOString(),
  };
  await testCredentials(conn); // só salva se a corretora aceitar as chaves
  const list = connections();
  list.push(conn);
  store.save('connections.json', list);
  res.status(201).json(publicConn(conn));
}));

app.patch('/api/connections/:id', requireUser, wrap(async (req, res) => {
  const own = connections().find((c) => c.id === req.params.id && c.userId === req.user.id);
  if (!own) throw bad('Conta não encontrada', 404);
  const b = req.body || {};
  const patch = {};
  if (typeof b.active === 'boolean') patch.active = b.active;
  if (b.allocationPct !== undefined) patch.allocationPct = parsePct(b.allocationPct, 'A % da banca');
  if (b.leverage !== undefined && own.market === 'futures') patch.leverage = parseLeverage(b.leverage, own.market);
  if (b.marginMode !== undefined) patch.marginMode = b.marginMode === 'cross' ? 'cross' : 'isolated';
  if (b.targets !== undefined) patch.targets = parseTargets(b.targets);
  if (b.label !== undefined) patch.label = String(b.label).trim().slice(0, 40) || own.label;
  if (b.apiKey || b.apiSecret) {
    const k = String(b.apiKey || '').trim();
    const s = String(b.apiSecret || '').trim();
    if (k.length < 8 || k.length > 300 || s.length < 8 || s.length > 300) throw bad('Para trocar as chaves, informe a API key e a API secret');
    patch.apiKey = encrypt(k);
    patch.apiSecret = encrypt(s);
    patch.apiKeyHint = k.slice(-4);
    await testCredentials({ ...own, apiKey: patch.apiKey, apiSecret: patch.apiSecret });
  }
  const list = connections();
  const c = list.find((x) => x.id === own.id);
  if (!c) throw bad('Conta não encontrada', 404);
  Object.assign(c, patch);
  store.save('connections.json', list);
  invalidate(c.id);
  res.json(publicConn(c));
}));

app.delete('/api/connections/:id', requireUser, (req, res) => {
  const list = connections();
  const c = list.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!c) throw bad('Conta não encontrada', 404);
  if (monitor.hasActive(c.id)) throw bad('Há operações em andamento nesta conta. Aguarde terminarem ou cancele as pendentes.', 409);
  store.save('connections.json', list.filter((x) => x.id !== c.id));
  invalidate(c.id);
  res.json({ ok: true });
});

app.get('/api/me/legs', requireUser, (req, res) => res.json(monitor.listFor(req.user.id, 100)));

app.post('/api/me/legs/:id/cancel', requireUser, wrap(async (req, res) => {
  const leg = await monitor.cancelOne(req.params.id, req.user.id);
  if (!leg) throw bad('Operação não encontrada ou já não está pendente', 404);
  res.json({ ok: true, status: leg.status });
}));

// ---------- Admin: calls (entrada + stop) ----------
function parsePair(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s/g, '');
  let m = s.match(/^([A-Z0-9]{2,15})\/([A-Z]{3,5})$/);
  if (!m) m = s.match(/^([A-Z0-9]{2,15}?)(USDT|USDC|BUSD)$/);
  return m ? { base: m[1], quote: m[2] } : null;
}

let sending = false;

app.post('/api/admin/signal', requireAdmin, wrap(async (req, res) => {
  if (sending) throw bad('Já existe um sinal em execução, aguarde', 429);
  const b = req.body || {};
  const pair = parsePair(b.pair);
  const entry = Number(b.entry);
  const stop = Number(b.stop);
  if (!pair) throw bad('Par inválido (ex.: BTC/USDT)');
  if (!(entry > 0 && stop > 0)) throw bad('Entrada e stop devem ser números positivos');
  if (stop >= entry) throw bad('Para compra, o stop precisa ser menor que a entrada');

  const type = ['market', 'limit', 'breakout', 'dip'].includes(b.type) ? b.type : 'market';
  const stopType = b.stopType === 'limit' ? 'limit' : 'market';
  const stopLimitOffsetPct = stopType === 'limit' ? Number(b.stopLimitOffsetPct ?? 0.3) : 0;
  if (stopType === 'limit' && !(stopLimitOffsetPct >= 0.01 && stopLimitOffsetPct <= 5)) {
    throw bad('Distância do stop-limit deve ficar entre 0,01% e 5%');
  }
  const expireHours = Number(b.expireHours ?? 24);
  if (!(expireHours >= 0.1 && expireHours <= 720)) throw bad('Validade inválida (0,1 a 720 horas)');

  const owners = new Map(users().map((u) => [u.id, u]));
  const eligible = connections().filter((c) => c.active && c.allocationPct > 0 && owners.has(c.userId) && !owners.get(c.userId).blocked);
  if (!eligible.length) throw bad('Nenhuma conta ativa com % da banca maior que 0');

  sending = true;
  try {
    const now = new Date();
    // Só entrada e stop vêm da call; os alvos de venda são os que cada usuário configurou
    const signal = { id: crypto.randomUUID(), ...pair, entry, stop, type, stopType, stopLimitOffsetPct, at: now.toISOString() };
    const legs = eligible.map((c) => ({
      id: crypto.randomUUID(),
      signalId: signal.id,
      signal,
      clientId: c.id,
      userId: c.userId,
      userName: owners.get(c.userId).name,
      clientName: c.label,
      exchange: c.exchange,
      market: c.market,
      symbol: symbolFor(c, signal),
      targets: c.targets || [],
      status: 'pendente',
      steps: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expireHours * 3600 * 1000).toISOString(),
    }));
    await monitor.addSignal(legs);
    res.json({
      signal,
      legs: legs.map((l) => ({ id: l.id, userName: l.userName, clientName: l.clientName, status: l.status, error: l.error })),
    });
  } finally {
    sending = false;
  }
}));

app.get('/api/admin/legs', requireAdmin, (req, res) => res.json(monitor.list(300)));

app.post('/api/admin/signals/:id/cancel', requireAdmin, wrap(async (req, res) => {
  res.json({ cancelled: await monitor.cancelSignal(req.params.id) });
}));

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const conns = connections();
  res.json(users().map((u) => ({
    id: u.id, name: u.name, email: u.email, blocked: !!u.blocked, createdAt: u.createdAt, termsVersion: u.termsVersion,
    connections: conns.filter((c) => c.userId === u.id).map((c) => ({ label: c.label, active: c.active, allocationPct: c.allocationPct })),
  })));
});

app.post('/api/admin/users/:id/block', requireAdmin, (req, res) => {
  const list = users();
  const u = list.find((x) => x.id === req.params.id);
  if (!u) throw bad('Usuário não encontrado', 404);
  u.blocked = req.body?.blocked === true;
  store.save('users.json', list);
  if (u.blocked) auth.endUserSessions(u.id);
  res.json({ ok: true, blocked: u.blocked });
});

// ---------- Erros ----------
app.use('/api', (req, res, next) => next(bad('Rota não encontrada', 404)));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requisição grande demais' });
  if (!err.expose) console.error('erro:', err.message);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Erro interno' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Painel em http://localhost:${port}`);
  monitor.start();
});

module.exports = app;
