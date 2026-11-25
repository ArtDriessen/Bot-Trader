// Corretora simulada para testes (sem rede). Substitui lib/exchange.js no cache de módulos.
const path = require('path');

class Fake {
  constructor(price = 100) {
    this.price = price;
    this.orders = [];
    this.n = 0;
    this.failStop = false;
    const m = { limits: { amount: { min: 0.0001 }, cost: { min: 5 } } };
    this.markets = { 'BTC/USDT': m, 'BTC/USDT:USDT': m };
  }
  async fetchTicker() { return { last: this.price }; }
  async fetchBalance() { return { USDT: { free: 1000 } }; }
  amountToPrecision(s, a) { return (Math.floor(a * 1e4) / 1e4).toFixed(4); }
  priceToPrecision(s, p) { return Number(p).toFixed(2); }
  async createOrder(symbol, type, side, amount, price, params = {}) {
    if (this.failStop && params.stopLossPrice) throw new Error('stop rejeitado');
    const trigger = !!params.stopLossPrice;
    const instant = type === 'market' && !trigger;
    const o = {
      id: String(++this.n), symbol, type, side, amount, price, params,
      status: instant ? 'closed' : 'open', filled: instant ? amount : 0, average: this.price,
    };
    this.orders.push(o);
    return o;
  }
  async fetchOrder(id) { return this.orders.find((o) => o.id === id); }
  async cancelOrder(id) { this.orders.find((o) => o.id === id).status = 'canceled'; }
  async setMarginMode() {}
  async setLeverage() {}
}

// Faz require('.../lib/exchange') devolver a corretora simulada atual (fake.current)
const holder = { current: new Fake() };
function install() {
  const p = require.resolve(path.join(__dirname, '..', 'lib', 'exchange.js'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      getExchange: async () => holder.current,
      create: () => ({ fetchBalance: async () => ({}) }),
      invalidate: () => {},
    },
  };
}

module.exports = { Fake, holder, install };
