const express = require('express');
const crypto = require('crypto');
const path = require('path');
const store = require('./lib/store');
const { encrypt } = require('./lib/crypto');
const { create, invalidate } = require('./lib/exchange');
const monitor = require('./lib/monitor');
const { symbolFor } = require('./lib/executor');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const EXCHANGES = ['binance', 'bybit', 'bingx'];
const MARKETS = ['spot', 'futures'];

function auth(req, res, next) {
  const given = Buffer.from(String(req.get('x-admin-token') || ''));
  const expected = Buffer.from(process.env.ADMIN_TOKEN || '');
  if (!expected.length || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

const clients = () => store.load('clients.json', []);
const publicClient = ({ apiKey, apiSecret, ...rest }) => rest;

// ---------- Clientes ----------
app.get('/api/clients', auth, (req, res) => res.json(clients().map(publicClient)));

app.post('/api/clients', auth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !EXCHANGES.includes(b.exchange) || !MARKETS.includes(b.market)) {
      return res.status(400).json({ error: 'Dados inválidos (nome, corretora, mercado)' });
    }
    const allocationPct = Number(b.allocationPct);
    const leverage = b.market === 'futures' ? Number(b.leverage || 1) : 1;
    if (!(allocationPct > 0 && allocationPct <= 100)) return res.status(400).json({ error: 'allocationPct deve ser entre 0 e 100' });
    if (!(leverage >= 1 && leverage <= 125)) return res.status(400).json({ error: 'Alavancagem inválida' });
    if (!b.apiKey || !b.apiSecret) return res.status(400).json({ error: 'Informe API key e secret' });

    const client = {
      id: crypto.randomUUID(),
      name: String(b.name).slice(0, 80),
      exchange: b.exchange,
      market: b.market,
      allocationPct,
      leverage,
      marginMode: b.marginMode === 'cross' ? 'cross' : 'isolated',
      active: true,
      apiKey: encrypt(b.apiKey),
      apiSecret: encrypt(b.apiSecret),
      createdAt: new Date().toISOString(),
    };

    // Testa as credenciais antes de salvar
    try {
      await create(client).fetchBalance();
    } catch (e) {
      return res.status(400).json({ error: `Credenciais recusadas pela corretora: ${String(e.message).slice(0, 160)}` });
    }

    const list = clients();
    list.push(client);
    store.save('clients.json', list);
    res.json(publicClient(client));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/clients/:id', auth, (req, res) => {
  const list = clients();
  const c = list.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Cliente não encontrado' });
  const b = req.body || {};
  if (typeof b.active === 'boolean') c.active = b.active;
  if (b.allocationPct !== undefined) {
    const v = Number(b.allocationPct);
    if (!(v > 0 && v <= 100)) return res.status(400).json({ error: 'allocationPct inválido' });
    c.allocationPct = v;
  }
  if (b.leverage !== undefined && c.market === 'futures') {
    const v = Number(b.leverage);
    if (!(v >= 1 && v <= 125)) return res.status(400).json({ error: 'Alavancagem inválida' });
    c.leverage = v;
  }
  store.save('clients.json', list);
  invalidate(c.id);
  res.json(publicClient(c));
});

app.delete('/api/clients/:id', auth, (req, res) => {
  const list = clients().filter((x) => x.id !== req.params.id);
  store.save('clients.json', list);
  invalidate(req.params.id);
  res.json({ ok: true });
});

// ---------- Sinal ----------
function parsePair(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s/g, '');
  let m = s.match(/^([A-Z0-9]{2,15})\/([A-Z]{3,5})$/);
  if (!m) m = s.match(/^([A-Z0-9]{2,15}?)(USDT|USDC|BUSD)$/);
  return m ? { base: m[1], quote: m[2] } : null;
}

// Take profits: [{ price, pct }]. Sem % em nenhum, divide igualmente.
function parseTakeProfits(raw, entry) {
  if (!raw || !raw.length) return [];
  if (!Array.isArray(raw) || raw.length > 5) throw new Error('Informe até 5 take profits');
  const tps = raw.map((t) => ({
    price: Number(t.price),
    pct: t.pct === undefined || t.pct === null || t.pct === '' ? null : Number(t.pct),
  }));
  if (tps.some((t) => !(t.price > entry))) throw new Error('Cada take profit precisa ser maior que a entrada');
  const unset = tps.filter((t) => t.pct === null).length;
  if (unset === tps.length) tps.forEach((t) => (t.pct = 100 / tps.length));
  else if (unset) throw new Error('Informe o % de todos os take profits ou de nenhum');
  if (tps.some((t) => !(t.pct > 0)) || tps.reduce((s, t) => s + t.pct, 0) > 100.0001) {
    throw new Error('Os % dos take profits precisam ser positivos e somar no máximo 100');
  }
  return tps.sort((a, b) => a.price - b.price);
}

let sending = false;

app.post('/api/signal', auth, async (req, res) => {
  if (sending) return res.status(429).json({ error: 'Já existe um sinal em execução, aguarde' });
  try {
    const b = req.body || {};
    const pair = parsePair(b.pair);
    const entry = Number(b.entry);
    const stop = Number(b.stop);
    if (!pair) return res.status(400).json({ error: 'Par inválido (ex.: BTC/USDT)' });
    if (!(entry > 0 && stop > 0)) return res.status(400).json({ error: 'Entrada e stop devem ser números positivos' });
    if (stop >= entry) return res.status(400).json({ error: 'Para compra, o stop precisa ser menor que a entrada' });

    const type = ['market', 'limit', 'breakout', 'dip'].includes(b.type) ? b.type : 'market';
    const stopType = b.stopType === 'limit' ? 'limit' : 'market';
    const stopLimitOffsetPct = stopType === 'limit' ? Number(b.stopLimitOffsetPct ?? 0.3) : 0;
    if (stopType === 'limit' && !(stopLimitOffsetPct >= 0.01 && stopLimitOffsetPct <= 5)) {
      return res.status(400).json({ error: 'Distância do stop-limit deve ficar entre 0,01% e 5%' });
    }
    const expireHours = Number(b.expireHours ?? 24);
    if (!(expireHours >= 0.1 && expireHours <= 720)) return res.status(400).json({ error: 'Validade inválida (0,1 a 720 horas)' });
    let takeProfits;
    try {
      takeProfits = parseTakeProfits(b.takeProfits, entry);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const active = clients().filter((c) => c.active);
    if (!active.length) return res.status(400).json({ error: 'Nenhum cliente ativo' });

    sending = true;
    const now = new Date();
    const signal = {
      id: crypto.randomUUID(), ...pair, entry, stop, type, stopType, stopLimitOffsetPct, takeProfits,
      at: now.toISOString(),
    };
    const legs = active.map((c) => ({
      id: crypto.randomUUID(),
      signalId: signal.id,
      signal,
      clientId: c.id,
      clientName: c.name,
      exchange: c.exchange,
      market: c.market,
      symbol: symbolFor(c, signal),
      status: 'pendente',
      steps: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expireHours * 3600 * 1000).toISOString(),
    }));
    await monitor.addSignal(legs);
    res.json({ signal, legs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    sending = false;
  }
});

app.get('/api/legs', auth, (req, res) => res.json(monitor.list(200)));

app.post('/api/signals/:id/cancel', auth, async (req, res) => {
  try {
    res.json({ cancelled: await monitor.cancelSignal(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Painel em http://localhost:${port}`);
  monitor.start();
});
