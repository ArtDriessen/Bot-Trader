const express = require('express');
const crypto = require('crypto');
const path = require('path');
const store = require('./lib/store');
const { encrypt } = require('./lib/crypto');
const { create, invalidate } = require('./lib/exchange');
const { executeSignal } = require('./lib/executor');

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

let sending = false;

app.post('/api/signal', auth, async (req, res) => {
  if (sending) return res.status(429).json({ error: 'Já existe um sinal em execução, aguarde' });
  const pair = parsePair(req.body?.pair);
  const entry = Number(req.body?.entry);
  const stop = Number(req.body?.stop);
  if (!pair) return res.status(400).json({ error: 'Par inválido (ex.: BTC/USDT)' });
  if (!(entry > 0 && stop > 0)) return res.status(400).json({ error: 'Entrada e stop devem ser números positivos' });
  if (stop >= entry) return res.status(400).json({ error: 'Para compra, o stop precisa ser menor que a entrada' });

  const active = clients().filter((c) => c.active);
  if (!active.length) return res.status(400).json({ error: 'Nenhum cliente ativo' });

  sending = true;
  try {
    const signal = { id: crypto.randomUUID(), ...pair, entry, stop, at: new Date().toISOString() };
    const results = await executeSignal(active, signal);
    const trades = store.load('trades.json', []);
    trades.unshift({ signal, results });
    store.save('trades.json', trades.slice(0, 500));
    res.json({ signal, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    sending = false;
  }
});

app.get('/api/trades', auth, (req, res) => res.json(store.load('trades.json', []).slice(0, 50)));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Painel em http://localhost:${port}`));
