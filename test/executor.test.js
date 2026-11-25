const assert = require('assert');
const { Fake, holder, install } = require('./fake-exchange');
install();
const { startLeg, processLeg, cancelLeg } = require('../lib/executor');

const client = (market) => ({ id: 'c1', exchange: 'binance', market, allocationPct: 10, leverage: market === 'futures' ? 5 : 1 });
const mkLeg = (over = {}, targets = []) => ({
  id: 'l', signalId: 's', clientId: 'c1', status: 'pendente', steps: [], targets,
  expiresAt: new Date(Date.now() + 3600e3).toISOString(),
  signal: { base: 'BTC', quote: 'USDT', entry: 98, stop: 95, type: 'market', stopType: 'market', stopLimitOffsetPct: 0, ...over },
});
const tick = (leg, c) => processLeg(leg, c, new Map());
const px = (v) => Number(v.toFixed(2));

(async () => {
  // A) Fundo em spot + alvos do usuário (+5% vende 50%, +10% vende 50%) sobre o preço real de compra
  let fake = (holder.current = new Fake(100));
  let c = client('spot');
  let leg = mkLeg({ type: 'dip' }, [{ gainPct: 5, sellPct: 50 }, { gainPct: 10, sellPct: 50 }]);
  await startLeg(leg, c);
  assert.equal(leg.status, 'monitorando'); assert.equal(leg.triggerDir, 'down');
  fake.price = 99; await tick(leg, c);
  assert.equal(fake.orders.length, 0, 'não pode comprar antes do fundo');
  fake.price = 97.9; await tick(leg, c);
  assert.equal(leg.status, 'ativa');
  assert.equal(fake.orders[0].side, 'buy'); assert.equal(fake.orders[1].params.stopLossPrice, 95);
  const tp1 = px(97.9 * 1.05), tp2 = px(97.9 * 1.10);
  assert.deepEqual(leg.softTps.map((t) => t.price), [tp1, tp2]);
  fake.price = tp1 + 0.01; await tick(leg, c);
  assert.equal(leg.softTps[0].done, true); assert.equal(leg.status, 'ativa');
  assert.equal(fake.orders.filter((o) => o.params.stopLossPrice).length, 2, 'stop reposicionado para o restante');
  fake.price = tp2 + 0.01; await tick(leg, c);
  assert.equal(leg.status, 'concluida');
  console.log('A) fundo spot + alvos 5%/10% parciais: ok');

  // B) Rompimento em futuros: stop-limit e alvos reduce-only (+3% vende 60%, +8% vende 40%)
  fake = holder.current = new Fake(100); c = client('futures');
  leg = mkLeg({ type: 'breakout', entry: 102, stop: 99, stopType: 'limit', stopLimitOffsetPct: 0.3 },
    [{ gainPct: 3, sellPct: 60 }, { gainPct: 8, sellPct: 40 }]);
  await startLeg(leg, c);
  assert.equal(leg.triggerDir, 'up');
  fake.price = 101.5; await tick(leg, c); assert.equal(fake.orders.length, 0);
  fake.price = 102.2; await tick(leg, c);
  assert.equal(leg.status, 'concluida');
  const stop = fake.orders.find((o) => o.params.stopLossPrice);
  assert.equal(stop.type, 'limit'); assert.equal(stop.price, 98.7); assert.equal(stop.params.reduceOnly, true);
  const tps = fake.orders.filter((o) => o.type === 'limit' && o.params.reduceOnly && !o.params.stopLossPrice);
  assert.deepEqual(tps.map((o) => o.price), [px(102.2 * 1.03), px(102.2 * 1.08)]);
  const total = fake.orders[0].amount;
  assert.ok(Math.abs(Number(tps[0].amount) + Number(tps[1].amount) - Number(total)) < 1e-6, 'alvos somam a posição inteira');
  console.log('C) rompimento futuros + stop-limit + alvos: ok');

  // C) Ordem limite: espera executar e então protege
  fake = holder.current = new Fake(100); c = client('spot');
  leg = mkLeg({ type: 'limit', entry: 99 }, []);
  await startLeg(leg, c);
  assert.equal(leg.status, 'ordem_aberta');
  await tick(leg, c); assert.equal(leg.status, 'ordem_aberta');
  const lo = fake.orders[0]; lo.status = 'closed'; lo.filled = lo.amount;
  await tick(leg, c); assert.equal(leg.status, 'concluida'); assert.ok(leg.stopOrderId);
  console.log('D) limite + proteção após execução: ok');

  // D) Validações do gatilho
  fake = holder.current = new Fake(100); c = client('spot');
  leg = mkLeg({ type: 'dip', entry: 102, stop: 95 }); await startLeg(leg, c); assert.equal(leg.status, 'erro');
  leg = mkLeg({ type: 'breakout', entry: 98 }); await startLeg(leg, c); assert.equal(leg.status, 'erro');
  leg = mkLeg({ type: 'dip', entry: 98, stop: 95 }); await startLeg(leg, c);
  fake.price = 94; await tick(leg, c); assert.equal(leg.status, 'cancelada'); assert.equal(fake.orders.length, 0);
  console.log('E) validações e invalidação pelo stop: ok');

  // E) Falha no stop fecha a posição
  fake = holder.current = new Fake(98); fake.failStop = true; c = client('spot');
  leg = mkLeg({ type: 'market' }); await startLeg(leg, c);
  assert.equal(leg.status, 'fechada_sem_stop'); assert.equal(fake.orders.at(-1).side, 'sell');
  console.log('F) falha no stop fecha posição: ok');

  // F) Cancelar limite aberto
  fake = holder.current = new Fake(100); c = client('spot');
  leg = mkLeg({ type: 'limit', entry: 99 }); await startLeg(leg, c);
  await cancelLeg(leg, c); assert.equal(leg.status, 'cancelada'); assert.equal(fake.orders[0].status, 'canceled');
  console.log('G) cancelamento de ordem limite: ok');

  // G) % da banca: 0% não opera; 100% reserva 0,5% para taxas; tamanho proporcional
  fake = holder.current = new Fake(100); c = { ...client('spot'), allocationPct: 0 };
  leg = mkLeg({ type: 'market', entry: 100 }); await startLeg(leg, c);
  assert.equal(leg.status, 'erro'); assert.equal(fake.orders.length, 0);
  c = { ...client('spot'), allocationPct: 100 };
  leg = mkLeg({ type: 'market', entry: 100 }); await startLeg(leg, c);
  assert.equal(fake.orders[0].amount, '9.9500', '100% de 1000 USDT a 100 = 10, menos 0,5% de reserva');
  console.log('H) % da banca (0% e 100%): ok');

  // H) Alvo pequeno demais para a corretora é somado ao seguinte
  fake = holder.current = new Fake(98); c = client('spot');
  fake.markets['BTC/USDT'].limits.amount.min = 0.1; // posição ~1.0153; 5% = 0.05 < mínimo
  leg = mkLeg({ type: 'market' }, [{ gainPct: 1, sellPct: 5 }, { gainPct: 5, sellPct: 95 }]);
  await startLeg(leg, c);
  assert.equal(leg.softTps.length, 1);
  assert.ok(Math.abs(leg.softTps[0].amount - leg.amount) < 1e-3, 'alvo único com a posição inteira');
  console.log('I) alvo pequeno somado ao seguinte: ok');

  // I) Posição inteira vendida em um único alvo de +1%
  fake = holder.current = new Fake(98); c = client('spot');
  leg = mkLeg({ type: 'market' }, [{ gainPct: 1, sellPct: 100 }]);
  await startLeg(leg, c);
  fake.price = px(98 * 1.01) + 0.01; await tick(leg, c);
  assert.equal(leg.status, 'concluida');
  assert.equal(fake.orders.filter((o) => o.side === 'sell' && o.type === 'market' && !o.params.stopLossPrice).length, 1);
  console.log('J) venda total em um alvo: ok');
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
