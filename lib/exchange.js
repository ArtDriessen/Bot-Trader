const ccxt = require('ccxt');
const { decrypt } = require('./crypto');

const cache = new Map(); // clientId -> { ex, marketsLoaded }

function create(client) {
  const futures = client.market === 'futures';
  let Cls;
  if (client.exchange === 'binance') Cls = futures ? ccxt.binanceusdm : ccxt.binance;
  else if (client.exchange === 'bybit') Cls = ccxt.bybit;
  else if (client.exchange === 'bingx') Cls = ccxt.bingx;
  else throw new Error(`Corretora não suportada: ${client.exchange}`);

  const config = {
    apiKey: decrypt(client.apiKey),
    secret: decrypt(client.apiSecret),
    enableRateLimit: true,
    timeout: 15000,
  };
  // binanceusdm já nasce como futuros; para as demais definimos o tipo
  if (client.exchange !== 'binance') {
    config.options = { defaultType: futures ? 'swap' : 'spot' };
  }

  const ex = new Cls(config);
  if (process.env.SANDBOX === 'true') ex.setSandboxMode(true);
  return ex;
}

async function getExchange(client) {
  let entry = cache.get(client.id);
  if (!entry) {
    entry = { ex: create(client), loaded: false };
    cache.set(client.id, entry);
  }
  if (!entry.loaded) {
    await entry.ex.loadMarkets();
    entry.loaded = true;
  }
  return entry.ex;
}

function invalidate(clientId) {
  cache.delete(clientId);
}

module.exports = { getExchange, invalidate, create };
