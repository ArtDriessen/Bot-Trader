const { getExchange } = require('./exchange');

const MAX_SLIPPAGE_PCT = () => parseFloat(process.env.MAX_SLIPPAGE_PCT || '0.5');
const CLOSE_ON_STOP_FAILURE = () => process.env.CLOSE_ON_STOP_FAILURE !== 'false';

function symbolFor(client, signal) {
  return client.market === 'futures'
    ? `${signal.base}/${signal.quote}:${signal.quote}`
    : `${signal.base}/${signal.quote}`;
}

async function executeForClient(client, signal) {
  const steps = [];
  const ex = await getExchange(client);
  const futures = client.market === 'futures';
  const symbol = symbolFor(client, signal);
  const market = ex.markets[symbol];
  if (!market) throw new Error(`Par ${symbol} não disponível em ${client.exchange} (${client.market})`);

  // 1) Validações de preço
  const ticker = await ex.fetchTicker(symbol);
  const last = ticker.last;
  const slippage = (Math.abs(last - signal.entry) / signal.entry) * 100;
  if (slippage > MAX_SLIPPAGE_PCT()) {
    throw new Error(
      `Preço atual (${last}) está ${slippage.toFixed(2)}% longe da entrada (${signal.entry}); limite ${MAX_SLIPPAGE_PCT()}%`
    );
  }
  if (last <= signal.stop) throw new Error(`Preço atual (${last}) já está no/abaixo do stop (${signal.stop})`);

  // 2) Tamanho da posição: % do saldo livre (em futuros, multiplicado pela alavancagem)
  const bal = await ex.fetchBalance();
  const free = Number(bal[signal.quote]?.free ?? 0);
  if (free <= 0) throw new Error(`Sem saldo livre em ${signal.quote}`);
  const leverage = futures ? client.leverage || 1 : 1;
  const notional = free * (client.allocationPct / 100) * leverage;
  let amount = Number(ex.amountToPrecision(symbol, notional / last));

  const minAmount = market.limits?.amount?.min;
  const minCost = market.limits?.cost?.min;
  if (minAmount && amount < minAmount) throw new Error(`Quantidade ${amount} abaixo do mínimo ${minAmount}`);
  if (minCost && amount * last < minCost) throw new Error(`Valor ${(amount * last).toFixed(2)} abaixo do mínimo ${minCost}`);

  // 3) Futuros: margem e alavancagem
  if (futures) {
    try {
      await ex.setMarginMode(client.marginMode || 'isolated', symbol);
    } catch (e) {
      steps.push(`aviso margem: ${String(e.message).slice(0, 120)}`);
    }
    try {
      await ex.setLeverage(leverage, symbol);
    } catch (e) {
      steps.push(`aviso alavancagem: ${String(e.message).slice(0, 120)}`);
    }
  }

  // 4) Ordem de compra a mercado
  // BingX spot exige o preço para calcular o custo da compra a mercado
  const priceArg = client.exchange === 'bingx' && !futures ? last : undefined;
  const buy = await ex.createOrder(symbol, 'market', 'buy', amount, priceArg);
  steps.push(`compra enviada (${buy.id})`);

  let filled = Number(buy.filled || 0);
  let avg = buy.average || buy.price || last;
  if (!filled) {
    try {
      const o = await ex.fetchOrder(buy.id, symbol);
      filled = Number(o.filled || amount);
      avg = o.average || o.price || avg;
    } catch {
      filled = amount;
    }
  }

  // Em spot a taxa pode ser descontada da moeda comprada
  let sellAmount = filled;
  if (!futures) {
    const baseFee = (buy.fees || (buy.fee ? [buy.fee] : []))
      .filter((f) => f && f.currency === signal.base)
      .reduce((s, f) => s + Number(f.cost || 0), 0);
    sellAmount = filled - baseFee;
  }
  sellAmount = Number(ex.amountToPrecision(symbol, sellAmount));

  // 5) Stop loss imediatamente após a compra
  try {
    const params = { stopLossPrice: signal.stop };
    if (futures) params.reduceOnly = true;
    const stop = await ex.createOrder(symbol, 'market', 'sell', sellAmount, undefined, params);
    steps.push(`stop loss colocado (${stop.id}) em ${signal.stop}`);
    return { status: 'ok', symbol, amount: filled, avgPrice: avg, stopOrderId: stop.id, steps };
  } catch (stopErr) {
    steps.push(`FALHA no stop: ${String(stopErr.message).slice(0, 200)}`);
    if (!CLOSE_ON_STOP_FAILURE()) {
      return { status: 'sem_stop', symbol, amount: filled, avgPrice: avg, steps };
    }
    // Segurança: não deixa o cliente exposto sem stop
    try {
      await ex.createOrder(symbol, 'market', 'sell', sellAmount, undefined, futures ? { reduceOnly: true } : {});
      steps.push('posição fechada a mercado por falta de stop');
      return { status: 'fechada_sem_stop', symbol, amount: filled, avgPrice: avg, steps };
    } catch (closeErr) {
      steps.push(`FALHA ao fechar posição: ${String(closeErr.message).slice(0, 200)}`);
      return { status: 'exposto_sem_stop', symbol, amount: filled, avgPrice: avg, steps };
    }
  }
}

async function executeSignal(clients, signal) {
  const settled = await Promise.allSettled(clients.map((c) => executeForClient(c, signal)));
  return settled.map((r, i) => {
    const base = { clientId: clients[i].id, clientName: clients[i].name, exchange: clients[i].exchange };
    if (r.status === 'fulfilled') return { ...base, ok: r.value.status === 'ok', ...r.value };
    return { ...base, ok: false, status: 'erro', error: String(r.reason?.message || r.reason).slice(0, 300) };
  });
}

module.exports = { executeSignal };
