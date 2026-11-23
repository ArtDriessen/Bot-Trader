const store = require('./store');
const { startLeg, processLeg, cancelLeg, isActive } = require('./executor');

const INTERVAL_MS = Number(process.env.POLL_SECONDS || 5) * 1000;
const MAX_LEGS = 1000;

let legs = store.load('legs.json', []);
const save = () => store.save('legs.json', legs);

// Fila simples: tick, cancelamentos e novos sinais nunca mexem na mesma operação ao mesmo tempo
let chain = Promise.resolve();
function locked(fn) {
  const p = chain.then(() => fn());
  chain = p.catch(() => {});
  return p;
}

const clientsList = () => store.load('clients.json', []);

async function addSignal(legsToStart) {
  const clients = clientsList();
  return locked(async () => {
    await Promise.all(
      legsToStart.map((leg) => startLeg(leg, clients.find((c) => c.id === leg.clientId)))
    );
    legs.unshift(...legsToStart);
    // descarta o histórico mais antigo, mantendo tudo que ainda está ativo
    if (legs.length > MAX_LEGS) {
      const keep = legs.slice(0, MAX_LEGS);
      legs = keep.concat(legs.slice(MAX_LEGS).filter(isActive));
    }
    save();
    return legsToStart;
  });
}

let tickQueued = false;
function tick() {
  if (tickQueued) return;
  tickQueued = true;
  locked(async () => {
    tickQueued = false;
    const pending = legs.filter(isActive);
    if (!pending.length) return;
    const clients = clientsList();
    const cache = new Map();
    for (const leg of pending) {
      const client = clients.find((c) => c.id === leg.clientId);
      if (!client) {
        leg.status = 'erro';
        leg.error = 'cliente removido com operação em andamento (confira a corretora)';
        continue;
      }
      try {
        await processLeg(leg, client, cache);
        leg.errCount = 0;
      } catch (e) {
        leg.errCount = (leg.errCount || 0) + 1;
        leg.steps.push(`falha ao acompanhar (${leg.errCount}): ${String(e.message).slice(0, 120)}`);
        if (leg.errCount >= 10) {
          leg.status = 'erro';
          leg.error = 'Muitas falhas seguidas ao acompanhar; confira a corretora manualmente';
        }
      }
      leg.updatedAt = new Date().toISOString();
    }
    save();
  }).catch((e) => console.error('erro no monitor:', e.message));
}

function cancelSignal(signalId) {
  const clients = clientsList();
  return locked(async () => {
    let n = 0;
    for (const leg of legs.filter((l) => l.signalId === signalId && (l.status === 'monitorando' || l.status === 'ordem_aberta'))) {
      const client = clients.find((c) => c.id === leg.clientId);
      try {
        if (client) await cancelLeg(leg, client);
        n++;
      } catch (e) {
        leg.steps.push(`falha ao cancelar: ${String(e.message).slice(0, 120)}`);
      }
      leg.updatedAt = new Date().toISOString();
    }
    save();
    return n;
  });
}

const list = (limit = 200) => legs.slice(0, limit);

function start() {
  setInterval(tick, INTERVAL_MS);
  console.log(`Monitor de preços ativo (a cada ${INTERVAL_MS / 1000}s); ${legs.filter(isActive).length} operações em andamento`);
}

module.exports = { addSignal, cancelSignal, list, start, tick };
