// Criação de sinais (calls): usado pelo painel admin e pela leitura do Telegram.
const crypto = require('crypto');
const store = require('./store');
const monitor = require('./monitor');
const { symbolFor } = require('./executor');

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });

const TYPES = ['auto', 'market', 'limit', 'breakout', 'dip'];

function parsePair(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s/g, '');
  let m = s.match(/^([A-Z0-9]{2,15})\/([A-Z]{3,5})$/);
  if (!m) m = s.match(/^([A-Z0-9]{2,15}?)(USDT|USDC|BUSD)$/);
  return m ? { base: m[1], quote: m[2] } : null;
}

// Um sinal por vez: os seguintes esperam na fila (em vez de serem recusados)
let chain = Promise.resolve();
function submit(input) {
  const p = chain.then(() => run(input));
  chain = p.catch(() => {});
  return p;
}

async function run(b = {}) {
  const pair = parsePair(b.pair);
  const entry = Number(b.entry);
  const stop = Number(b.stop);
  if (!pair) throw bad('Par inválido (ex.: BTC/USDT)');
  if (!(entry > 0 && stop > 0)) throw bad('Entrada e stop devem ser números positivos');
  if (stop >= entry) throw bad('Para compra, o stop precisa ser menor que a entrada');

  const type = TYPES.includes(b.type) ? b.type : 'market';
  const stopType = b.stopType === 'limit' ? 'limit' : 'market';
  const stopLimitOffsetPct = stopType === 'limit' ? Number(b.stopLimitOffsetPct ?? 0.3) : 0;
  if (stopType === 'limit' && !(stopLimitOffsetPct >= 0.01 && stopLimitOffsetPct <= 5)) {
    throw bad('Distância do stop-limit deve ficar entre 0,01% e 5%');
  }
  const expireHours = Number(b.expireHours ?? 24);
  if (!(expireHours >= 0.1 && expireHours <= 720)) throw bad('Validade inválida (0,1 a 720 horas)');

  const owners = new Map(store.load('users.json', []).map((u) => [u.id, u]));
  const eligible = store.load('connections.json', []).filter(
    (c) => c.active && c.allocationPct > 0 && owners.has(c.userId) && !owners.get(c.userId).blocked,
  );
  if (!eligible.length) throw bad('Nenhuma conta ativa com % da banca maior que 0');

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
  return { signal, legs };
}

module.exports = { submit, parsePair, bad, TYPES };
