const assert = require('assert');
const { parseCall, parseNumber } = require('../lib/parser');

const ok = (text, exp) => {
  const r = parseCall(text);
  assert.ok(r.ok, `deveria interpretar: ${JSON.stringify(text)} -> ${r.reason}`);
  assert.deepEqual(r.call, exp, text);
};
const no = (text, re) => {
  const r = parseCall(text);
  assert.ok(!r.ok, `NÃO deveria interpretar: ${JSON.stringify(text)}`);
  if (re) assert.match(r.reason, re, text);
  return r;
};

// números
assert.equal(parseNumber('1.234,56'), 1234.56);
assert.equal(parseNumber('1,234.56'), 1234.56);
assert.equal(parseNumber('0,0012'), 0.0012);
assert.equal(parseNumber('0.0012'), 0.0012);
assert.equal(parseNumber('95000'), 95000);
assert.equal(parseNumber('1.234.567'), 1234567);

// formatos comuns
ok('Compra BTC/USDT\nEntrada: 100\nStop: 95', { pair: 'BTC/USDT', entry: 100, stop: 95, type: 'auto' });
ok('#BTCUSDT entrada 100 stop 95', { pair: 'BTC/USDT', entry: 100, stop: 95, type: 'auto' });
ok('🚀 COMPRA ETH-USDT\n📍 Entrada: 3.250,50\n🛑 Stop Loss: 3.100\n🎯 Alvo 1: 3.400', { pair: 'ETH/USDT', entry: 3250.5, stop: 3100, type: 'auto' });
ok('Par: SOLUSDT\nEntry @ 150.5\nSL 145', { pair: 'SOL/USDT', entry: 150.5, stop: 145, type: 'auto' });
ok('#DOGE\nentrada 0,1520\nstop 0,1450', { pair: 'DOGE/USDT', entry: 0.152, stop: 0.145, type: 'auto' });
ok('1INCH/USDT entrada: 0.50 stop: 0.45', { pair: '1INCH/USDT', entry: 0.5, stop: 0.45, type: 'auto' });
ok('Ação Compra BTC/USDT - rompimento\nEntrada acima de: 100\nStop: 95'.replace('acima de: ', ''), { pair: 'BTC/USDT', entry: 100, stop: 95, type: 'breakout' });
ok('BTC/USDT compra no fundo\nentrada: 100\nstop: 95', { pair: 'BTC/USDT', entry: 100, stop: 95, type: 'dip' });
ok('BTC/USDT entrada a mercado: 100 stop: 95', { pair: 'BTC/USDT', entry: 100, stop: 95, type: 'market' });
ok('BTC/USDT ordem limite\nEntrada 100\nStop 95', { pair: 'BTC/USDT', entry: 100, stop: 95, type: 'limit' });
ok('BTC/USDT\nEntrada: $100\nStop: $95\nAlvos: 105 / 110 / 120', { pair: 'BTC/USDT', entry: 100, stop: 95, type: 'auto' });

// NUNCA devem virar ordem
no('BTC/USDT entrada 100 stop 20', /muito distante/);
no('BTC/USDT entrada 100 stop 95 ✅ alvo 1 batido, gain de 5%', /resultado/);
no('BTC/USDT stop atingido', /não parece|stop não encontrado|resultado/);
no('Bom dia pessoal, mercado calmo hoje', /não parece/);
no('BTC/USDT entrada: 100-102 stop: 95', /faixa/);
no('BTC/USDT entrada 100 stop 95 short', /compras/);
no('Venda BTC/USDT entrada 100 stop 105', /compras/);
no('BTC/USDT e ETH/USDT entrada 100 stop 95', /mais de um par/);
no('BTC/USDT entrada 100 stop 105', /menor que a entrada/);
no('BTC/USDT entrada 100', /stop não encontrado/);
no('BTC/USDT stop 95', /entrada não encontrado/);
no('BTC/USDT entrada 100 stop 95 rompimento no fundo', /ambíguo/);
no('BTC/USDT entrada 100 entrada 101 stop 95', /mais de um valor/);
const r = no('BTC/USDT entrada 100'); assert.equal(r.callish, true, 'call incompleta aparece na caixa do admin');
assert.equal(no('Bom dia').callish, false);
console.log('parser: ok');
