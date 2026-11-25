const { getExchange } = require('./exchange');

const MAX_SLIPPAGE_PCT = () => parseFloat(process.env.MAX_SLIPPAGE_PCT || '0.5');
const CLOSE_ON_STOP_FAILURE = () => process.env.CLOSE_ON_STOP_FAILURE !== 'false';

// Estados em que o robô ainda precisa acompanhar a operação
const ACTIVE = ['monitorando', 'ordem_aberta', 'ativa'];
const isActive = (leg) => ACTIVE.includes(leg.status);

// Remove ruído de ponto flutuante (4.8679 - 2.9207 = 1.94719999...) antes de ajustar à precisão da corretora
const clean = (n) => Number(n.toFixed(10));

const short = (e) => String(e?.message || e).slice(0, 200);

function log(leg, msg) {
  leg.steps.push(msg);
  if (leg.steps.length > 40) leg.steps.splice(0, leg.steps.length - 40);
}

const symbolFor = (client, signal) =>
  client.market === 'futures' ? `${signal.base}/${signal.quote}:${signal.quote}` : `${signal.base}/${signal.quote}`;

// Preço do ativo, uma consulta por corretora/par a cada ciclo
function priceOf(ex, client, symbol, cache) {
  const key = `${client.exchange}:${client.market}:${symbol}`;
  if (!cache.has(key)) cache.set(key, ex.fetchTicker(symbol).then((t) => t.last));
  return cache.get(key);
}

// Tamanho da posição: % do saldo livre (em futuros, vezes a alavancagem)
async function sizeFor(ex, client, signal, symbol, price) {
  const market = ex.markets[symbol];
  const bal = await ex.fetchBalance();
  const free = Number(bal[signal.quote]?.free ?? 0);
  if (free <= 0) throw new Error(`Sem saldo livre em ${signal.quote}`);
  const pct = Math.min(Number(client.allocationPct) || 0, 100);
  if (!(pct > 0)) throw new Error('% da banca está em 0: nenhuma operação é aberta nesta conta');
  const leverage = client.market === 'futures' ? client.leverage || 1 : 1;
  // reserva 0,5% do valor para taxas, senão 100% da banca é recusado por saldo insuficiente
  const amount = Number(ex.amountToPrecision(symbol, (free * (pct / 100) * 0.995 * leverage) / price));
  const minAmount = market.limits?.amount?.min;
  const minCost = market.limits?.cost?.min;
  if (minAmount && amount < minAmount) throw new Error(`Quantidade ${amount} abaixo do mínimo ${minAmount}`);
  if (minCost && amount * price < minCost) throw new Error(`Valor ${(amount * price).toFixed(2)} abaixo do mínimo ${minCost}`);
  return amount;
}

async function setupFutures(ex, client, symbol, leg) {
  try {
    await ex.setMarginMode(client.marginMode || 'isolated', symbol);
  } catch (e) {
    log(leg, `aviso margem: ${short(e).slice(0, 100)}`);
  }
  try {
    await ex.setLeverage(client.leverage || 1, symbol);
  } catch (e) {
    log(leg, `aviso alavancagem: ${short(e).slice(0, 100)}`);
  }
}

// Quantidade realmente comprada (em spot a taxa pode ser descontada da moeda comprada)
function netAmount(order, futures, base, fallback) {
  let filled = Number(order?.filled || 0) || Number(fallback);
  if (!futures) {
    const fees = order?.fees?.length ? order.fees : order?.fee ? [order.fee] : [];
    filled -= fees.filter((f) => f && f.currency === base).reduce((s, f) => s + Number(f.cost || 0), 0);
  }
  return filled;
}

// Stop loss a mercado ou stop-limit (limite um pouco abaixo do gatilho)
async function placeStop(ex, leg, futures, amount) {
  const s = leg.signal;
  const params = { stopLossPrice: Number(ex.priceToPrecision(leg.symbol, s.stop)) };
  if (futures) params.reduceOnly = true;
  if (s.stopType === 'limit') {
    const limitPrice = Number(ex.priceToPrecision(leg.symbol, s.stop * (1 - s.stopLimitOffsetPct / 100)));
    return ex.createOrder(leg.symbol, 'limit', 'sell', amount, limitPrice, params);
  }
  return ex.createOrder(leg.symbol, 'market', 'sell', amount, undefined, params);
}

function splitAmounts(ex, symbol, total, tps) {
  const sumPct = tps.reduce((s, t) => s + t.pct, 0);
  const out = tps.map((t) => Number(ex.amountToPrecision(symbol, (total * t.pct) / 100)));
  if (sumPct >= 99.999) {
    const others = out.slice(0, -1).reduce((a, b) => a + b, 0);
    out[out.length - 1] = Number(ex.amountToPrecision(symbol, clean(total - others)));
  }
  return out;
}

// Alvos do usuário -> preços reais (ganho % sobre o preço médio da compra) e quantidades.
// Pedaços menores que o mínimo da corretora são somados ao alvo seguinte.
function planTargets(ex, leg, total) {
  const symbol = leg.symbol;
  const minAmt = ex.markets[symbol].limits?.amount?.min || 0;
  const minCost = ex.markets[symbol].limits?.cost?.min || 0;
  const tps = (leg.targets || []).map((t) => ({
    gainPct: t.gainPct,
    pct: t.sellPct,
    price: Number(ex.priceToPrecision(symbol, leg.entryPrice * (1 + t.gainPct / 100))),
  }));
  if (!tps.length) return [];
  const amounts = splitAmounts(ex, symbol, total, tps);
  const plan = [];
  let carry = 0;
  tps.forEach((tp, i) => {
    const amount = Number(ex.amountToPrecision(symbol, clean(amounts[i] + carry)));
    if (amount < minAmt || amount * tp.price < minCost) {
      carry = amount;
      return;
    }
    plan.push({ price: tp.price, amount, gainPct: tp.gainPct });
    carry = 0;
  });
  if (carry > 0 && plan.length) {
    const last = plan[plan.length - 1];
    last.amount = Number(ex.amountToPrecision(symbol, clean(last.amount + carry)));
  }
  if (plan.length < tps.length) {
    log(leg, plan.length
      ? 'alguns alvos eram pequenos demais para a corretora e foram somados ao alvo seguinte'
      : 'quantidade pequena demais para dividir em alvos; nenhum alvo foi colocado');
  }
  return plan;
}

// Depois que a compra foi executada: stop loss + alvos do usuário
async function protect(leg, client, ex, order, fallbackAmount, fallbackPrice) {
  const s = leg.signal;
  const futures = client.market === 'futures';
  const sellAmount = Number(ex.amountToPrecision(leg.symbol, netAmount(order, futures, s.base, fallbackAmount)));
  leg.entryPrice = order?.average || order?.price || fallbackPrice;
  leg.amount = sellAmount;
  leg.remaining = sellAmount;

  try {
    const stop = await placeStop(ex, leg, futures, sellAmount);
    leg.stopOrderId = stop.id;
    log(leg, `stop ${s.stopType === 'limit' ? 'limit' : 'loss'} colocado (${stop.id}) em ${s.stop}`);
  } catch (stopErr) {
    log(leg, `FALHA no stop: ${short(stopErr)}`);
    leg.error = `Falha no stop: ${short(stopErr)}`;
    if (!CLOSE_ON_STOP_FAILURE()) {
      leg.status = 'sem_stop';
      return;
    }
    try {
      await ex.createOrder(leg.symbol, 'market', 'sell', sellAmount, undefined, futures ? { reduceOnly: true } : {});
      leg.status = 'fechada_sem_stop';
      log(leg, 'posição fechada a mercado por falta de stop');
    } catch (closeErr) {
      leg.status = 'exposto_sem_stop';
      log(leg, `FALHA ao fechar posição: ${short(closeErr)}`);
    }
    return;
  }

  let plan = [];
  try {
    plan = planTargets(ex, leg, sellAmount);
  } catch (e) {
    log(leg, `FALHA ao calcular alvos: ${short(e)}`);
  }
  if (!plan.length) {
    leg.status = 'concluida';
    return;
  }
  if (futures) {
    // Futuros: cada alvo vira uma ordem limite reduce-only na corretora
    for (let i = 0; i < plan.length; i++) {
      try {
        const o = await ex.createOrder(leg.symbol, 'limit', 'sell', plan[i].amount, plan[i].price, { reduceOnly: true });
        log(leg, `alvo ${i + 1} (+${plan[i].gainPct}%) colocado (${o.id}) em ${plan[i].price}`);
      } catch (e) {
        log(leg, `FALHA no alvo ${i + 1}: ${short(e)}`);
      }
    }
    leg.status = 'concluida';
  } else {
    // Spot: stop e alvo reservariam o mesmo saldo, então o robô monitora os alvos
    leg.softTps = plan.map((p) => ({ price: p.price, amount: p.amount, gainPct: p.gainPct, done: false }));
    leg.status = 'ativa';
    log(leg, `alvos monitorados pelo robô: ${plan.map((p) => `+${p.gainPct}% (${p.price})`).join(', ')}`);
  }
}

async function protectSafe(leg, client, ex, order, fallbackAmount, fallbackPrice) {
  try {
    await protect(leg, client, ex, order, fallbackAmount, fallbackPrice);
  } catch (e) {
    leg.status = 'exposto_sem_stop';
    leg.error = `Falha ao proteger posição: ${short(e)}`;
    log(leg, leg.error);
  }
}

// Compra a mercado agora
async function enterMarket(leg, client, ex, cache) {
  const s = leg.signal;
  const futures = client.market === 'futures';
  const last = await priceOf(ex, client, leg.symbol, cache);
  const slippage = (Math.abs(last - s.entry) / s.entry) * 100;
  if (slippage > MAX_SLIPPAGE_PCT()) {
    throw new Error(`Preço atual (${last}) está ${slippage.toFixed(2)}% longe da entrada (${s.entry}); limite ${MAX_SLIPPAGE_PCT()}%`);
  }
  if (last <= s.stop) throw new Error(`Preço atual (${last}) já está no/abaixo do stop (${s.stop})`);

  const amount = await sizeFor(ex, client, s, leg.symbol, last);
  if (futures) await setupFutures(ex, client, leg.symbol, leg);

  // BingX spot exige o preço para calcular o custo da compra a mercado
  const priceArg = client.exchange === 'bingx' && !futures ? last : undefined;
  const buy = await ex.createOrder(leg.symbol, 'market', 'buy', amount, priceArg);
  log(leg, `compra a mercado enviada (${buy.id})`);

  let order = buy;
  try {
    order = await ex.fetchOrder(buy.id, leg.symbol);
  } catch {
    /* usa a resposta da criação */
  }
  await protectSafe(leg, client, ex, order, amount, last);
}

// Ordem limite de compra no preço de entrada; a proteção é colocada quando executar
async function placeLimit(leg, client, ex) {
  const s = leg.signal;
  const futures = client.market === 'futures';
  const price = Number(ex.priceToPrecision(leg.symbol, s.entry));
  const amount = await sizeFor(ex, client, s, leg.symbol, price);
  if (futures) await setupFutures(ex, client, leg.symbol, leg);
  const order = await ex.createOrder(leg.symbol, 'limit', 'buy', amount, price);
  leg.entryOrderId = order.id;
  leg.status = 'ordem_aberta';
  log(leg, `ordem limite de compra colocada (${order.id}) em ${price}`);
}

async function cancelEntry(leg, client, ex, reason) {
  try {
    await ex.cancelOrder(leg.entryOrderId, leg.symbol);
  } catch (e) {
    log(leg, `aviso ao cancelar: ${short(e).slice(0, 100)}`);
  }
  let o;
  try {
    o = await ex.fetchOrder(leg.entryOrderId, leg.symbol);
  } catch {
    /* sem detalhes */
  }
  if (o && Number(o.filled) > 0) {
    log(leg, `ordem executada parcialmente (${o.filled}); protegendo o que foi comprado`);
    await protectSafe(leg, client, ex, o, o.filled, o.average);
  } else {
    leg.status = 'cancelada';
    log(leg, `ordem limite cancelada: ${reason}`);
  }
}

// Gatilho de entrada monitorado pelo robô:
//  - rompimento (direção 'up'):  compra quando o preço SOBE até a entrada
//  - fundo (direção 'down'):     compra quando o preço CAI até a entrada
async function watchTrigger(leg, client, ex, cache) {
  const s = leg.signal;
  const last = await priceOf(ex, client, leg.symbol, cache);
  const label = leg.triggerDir === 'up' ? 'rompimento' : 'fundo';
  if (Date.now() > Date.parse(leg.expiresAt)) {
    leg.status = 'cancelada';
    log(leg, `validade expirou sem o ${label}`);
    return;
  }
  if (last <= s.stop) {
    leg.status = 'cancelada';
    log(leg, `preço (${last}) chegou no stop antes do ${label}; sinal invalidado`);
    return;
  }
  const hit = leg.triggerDir === 'up' ? last >= s.entry : last <= s.entry;
  if (hit) {
    log(leg, `${label}: preço ${last} atingiu ${s.entry}; enviando compra`);
    try {
      await enterMarket(leg, client, ex, cache);
    } catch (e) {
      // Sem retry automático: uma falha ambígua poderia duplicar a compra
      leg.status = 'erro';
      leg.error = short(e);
      log(leg, `ERRO ao entrar no ${label}: ${leg.error} (confira a corretora)`);
    }
  }
}

async function watchLimit(leg, client, ex, cache) {
  const s = leg.signal;
  const o = await ex.fetchOrder(leg.entryOrderId, leg.symbol);
  if (o.status === 'closed') {
    log(leg, `ordem limite executada em ${o.average || s.entry}`);
    await protectSafe(leg, client, ex, o, o.filled || o.amount, o.average || s.entry);
    return;
  }
  if (['canceled', 'expired', 'rejected'].includes(o.status)) {
    if (Number(o.filled) > 0) await protectSafe(leg, client, ex, o, o.filled, o.average);
    else {
      leg.status = 'cancelada';
      log(leg, 'ordem limite cancelada na corretora');
    }
    return;
  }
  const last = await priceOf(ex, client, leg.symbol, cache);
  if (last <= s.stop) await cancelEntry(leg, client, ex, `preço (${last}) chegou no stop antes de executar`);
  else if (Date.now() > Date.parse(leg.expiresAt)) await cancelEntry(leg, client, ex, 'validade expirou');
}

// Spot: acompanha o stop e dispara os take profits
async function watchActive(leg, client, ex, cache) {
  if (leg.stopOrderId) {
    const so = await ex.fetchOrder(leg.stopOrderId, leg.symbol);
    if (so.status === 'closed') {
      leg.status = 'concluida';
      log(leg, 'stop executado; posição encerrada');
      return;
    }
  }
  const last = await priceOf(ex, client, leg.symbol, cache);
  const minAmt = ex.markets[leg.symbol].limits?.amount?.min;

  for (const tp of leg.softTps.filter((t) => !t.done).sort((a, b) => a.price - b.price)) {
    if (last < tp.price) break;
    let stopCancelled = false;
    try {
      if (leg.stopOrderId) {
        await ex.cancelOrder(leg.stopOrderId, leg.symbol);
        stopCancelled = true;
        leg.stopOrderId = null;
      }
      await ex.createOrder(leg.symbol, 'market', 'sell', tp.amount);
      tp.done = true;
      leg.remaining = Number(ex.amountToPrecision(leg.symbol, leg.remaining - tp.amount));
      log(leg, `take profit ${tp.price} executado (${tp.amount})`);
    } catch (e) {
      log(leg, `FALHA no take profit ${tp.price}: ${short(e)}`);
    }
    if (stopCancelled && leg.remaining > 0 && (!minAmt || leg.remaining >= minAmt)) {
      try {
        const st = await placeStop(ex, leg, false, leg.remaining);
        leg.stopOrderId = st.id;
        log(leg, `stop reposicionado para o restante (${leg.remaining})`);
      } catch (e) {
        leg.status = 'exposto_sem_stop';
        leg.error = `Falha ao reposicionar stop: ${short(e)}`;
        log(leg, leg.error);
        return;
      }
    }
    if (!tp.done) break;
  }
  if (leg.softTps.every((t) => t.done)) {
    leg.status = 'concluida';
    log(leg, 'todos os take profits executados');
  }
}

async function startLeg(leg, client) {
  try {
    const ex = await getExchange(client);
    leg.symbol = symbolFor(client, leg.signal);
    if (!ex.markets[leg.symbol]) throw new Error(`Par ${leg.symbol} não disponível em ${client.exchange} (${client.market})`);
    const type = leg.signal.type;
    if (type === 'market') await enterMarket(leg, client, ex, new Map());
    else if (type === 'limit') await placeLimit(leg, client, ex);
    else {
      // rompimento (entrada acima do preço atual) ou fundo (entrada abaixo do preço atual)
      const last = await priceOf(ex, client, leg.symbol, new Map());
      leg.triggerDir = last < leg.signal.entry ? 'up' : 'down';
      if (leg.signal.type === 'breakout' && leg.triggerDir === 'down') {
        throw new Error(`Preço atual (${last}) já está no/acima do rompimento (${leg.signal.entry}); use entrada a mercado`);
      }
      if (leg.signal.type === 'dip' && leg.triggerDir === 'up') {
        throw new Error(`Preço atual (${last}) já está no/abaixo do fundo (${leg.signal.entry}); use entrada a mercado`);
      }
      if (last <= leg.signal.stop) throw new Error(`Preço atual (${last}) já está no/abaixo do stop (${leg.signal.stop})`);
      leg.status = 'monitorando';
      const verbo = leg.triggerDir === 'up' ? 'subir' : 'cair';
      log(leg, `monitorando ${leg.symbol} (atual ${last}): compra quando o preço ${verbo} até ${leg.signal.entry}`);
    }
  } catch (e) {
    leg.status = 'erro';
    leg.error = short(e);
    log(leg, `ERRO: ${leg.error}`);
  }
  leg.updatedAt = new Date().toISOString();
}

async function processLeg(leg, client, cache) {
  const ex = await getExchange(client);
  if (leg.status === 'monitorando') await watchTrigger(leg, client, ex, cache);
  else if (leg.status === 'ordem_aberta') await watchLimit(leg, client, ex, cache);
  else if (leg.status === 'ativa') await watchActive(leg, client, ex, cache);
}

async function cancelLeg(leg, client) {
  if (leg.status === 'monitorando') {
    leg.status = 'cancelada';
    log(leg, 'cancelado pelo usuário');
  } else if (leg.status === 'ordem_aberta') {
    await cancelEntry(leg, client, await getExchange(client), 'cancelado pelo usuário');
  }
}

module.exports = { startLeg, processLeg, cancelLeg, isActive, symbolFor };
