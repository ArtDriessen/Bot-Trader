// Interpreta o texto de uma call de compra: par, entrada, stop e tipo de entrada.
// Conservador de propósito: na dúvida NÃO interpreta (a call vai para a caixa do admin, sem executar).

const ENTRY = '(?:ZONA\\s+DE\\s+ENTRADA|ENTRADA|ENTRY|ENTRAR|COMPRAR|COMPRA|BUY)';
const STOP = '(?:STOP\\s*LOSS|STOPLOSS|STOP|\\bSL)';
const NUM = '(\\d+(?:[.,]\\d+)*)(?![A-Z0-9])';
const AFTER = '(?:\\s+(?:A\\s+MERCADO|ACIMA\\s+DE|ABAIXO\\s+DE|NO\\s+PRECO|PRECO\\s+DE))?\\s*(?:[:=@]|-(?!\\d)|EM|AT|PRECO)?\\s*\\$?\\s*';

// "1.234,56" / "1,234.56" / "0,0012" / "95000" -> número
function parseNumber(raw) {
  let s = String(raw);
  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  if (dots && commas) {
    const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    s = dec === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (commas === 1) s = s.replace(',', '.');
  else if (commas > 1) s = s.replace(/,/g, '');
  else if (dots > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const isRangeAfter = (text, end) => /^\s*(?:-|–|—|~|A\s|ATE\s|ATÉ\s)\s*\d/.test(text.slice(end));

function findLabeled(text, label) {
  const re = new RegExp(`(?:^|[^A-Z0-9])${label}${AFTER}${NUM}`, 'g');
  const found = [];
  let m;
  while ((m = re.exec(text))) {
    found.push({ raw: m[1], value: parseNumber(m[1]), range: isRangeAfter(text, m.index + m[0].length) });
  }
  return found;
}

// "3.100" / "3,100" pode ser 3,1 ou 3100: devolve as duas leituras possíveis (decimal primeiro)
function candidates(raw) {
  if (/^\d{1,3}[.,]\d{3}$/.test(raw)) {
    const dec = Number(raw.replace(',', '.'));
    const mil = Number(raw.replace(/[.,]/, ''));
    return [dec, mil];
  }
  return [parseNumber(raw)];
}

const MAX_STOP_DISTANCE_PCT = 50;
const stopOk = (entry, stop) => stop > 0 && stop < entry && ((entry - stop) / entry) * 100 <= MAX_STOP_DISTANCE_PCT;

// Tira a formatação de Discord/Markdown que as calls replicadas costumam trazer
// (**negrito**, `código`, ||spoiler||, > citação, <@menção>, :emoji:, @everyone)
function clean(raw) {
  return String(raw || '')
    .replace(/<a?:\w+:\d+>/g, ' ')
    .replace(/<[@#][!&]?\d+>/g, ' ')
    .replace(/@(?:everyone|here)\b/gi, ' ')
    .replace(/:[a-z][a-z0-9_+-]*:/gi, ' ')
    .replace(/[*`~|>]|__/g, '');
}

const RESULT_WORDS = /ATINGID|BATID|\bGAIN\b|ENCERR|FINALIZ|RESULTADO|PROFIT|LUCRO|CANCELAD|STOPOU|STOPADO|\bLOSS\s+DE\b/;
const SELL_WORDS = /\b(SHORT|VENDA|VENDER|SELL)\b/;

function findPair(text) {
  const pairs = new Set();
  for (const m of text.matchAll(/(?:^|[^A-Z0-9])([A-Z0-9]{2,10})[\/\-_]?(USDT|USDC|BUSD)(?![A-Z0-9])/g)) {
    if (!['ENTRADA', 'STOP', 'COMPRA', 'ENTRY'].includes(m[1])) pairs.add(`${m[1]}/${m[2]}`);
  }
  if (!pairs.size) {
    for (const m of text.matchAll(/[#$]([A-Z][A-Z0-9]{1,9})(?![A-Z0-9])/g)) pairs.add(`${m[1]}/USDT`);
  }
  return [...pairs];
}

function detectType(text) {
  const t = [];
  if (/ROMPIMENTO|ROMPER|ROMPE\b|BREAKOUT/.test(text)) t.push('breakout');
  if (/\bFUNDO\b|SUPORTE|PULLBACK|\bDIP\b|RETESTE/.test(text)) t.push('dip');
  if (/\bLIMITE\b|\bLIMIT\b|ORDEM\s+LIMITADA/.test(text)) t.push('limit');
  if (/A\s+MERCADO|\bAGORA\b|\bMARKET\b/.test(text)) t.push('market');
  return t;
}

/**
 * @returns {{ ok: true, callish: true, call: {pair, entry, stop, type} } | { ok: false, reason: string, callish: boolean }}
 * callish = parece uma call (vale mostrar na caixa do admin mesmo sem entender)
 */
function parseCall(raw) {
  const text = clean(raw).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const pairs = findPair(text);
  const entries = findLabeled(text, ENTRY);
  const stops = findLabeled(text, STOP);
  const callish = pairs.length > 0 && (entries.length > 0 || stops.length > 0);

  if (!callish) return { ok: false, reason: 'não parece uma call', callish: false };
  if (RESULT_WORDS.test(text)) return { ok: false, reason: 'parece o resultado de uma call, não uma nova entrada', callish };
  if (SELL_WORDS.test(text)) return { ok: false, reason: 'só compras são suportadas', callish };
  if (pairs.length > 1) return { ok: false, reason: `mais de um par na mensagem (${pairs.join(', ')})`, callish };
  if (!entries.length) return { ok: false, reason: 'valor de entrada não encontrado', callish };
  if (!stops.length) return { ok: false, reason: 'valor de stop não encontrado', callish };
  if (entries.length > 1 || stops.length > 1) return { ok: false, reason: 'mais de um valor de entrada/stop', callish };
  if (entries[0].range) return { ok: false, reason: 'faixa de entrada (ex.: 100-102) não é suportada', callish };

  // escolhe a leitura de entrada/stop em que os dois valores fazem sentido juntos
  let pick = null;
  for (const e of candidates(entries[0].raw)) {
    for (const st of candidates(stops[0].raw)) {
      if (!pick && e > 0 && stopOk(e, st)) pick = { entry: e, stop: st };
    }
  }
  if (!pick) {
    const e = entries[0].value;
    const st = stops[0].value;
    if (!(e > 0) || !(st > 0)) return { ok: false, reason: 'valores inválidos', callish };
    if (st >= e) return { ok: false, reason: 'stop precisa ser menor que a entrada (só compras)', callish };
    return { ok: false, reason: `stop muito distante da entrada (mais de ${MAX_STOP_DISTANCE_PCT}%); confira os valores`, callish };
  }
  const { entry, stop } = pick;

  const types = detectType(text);
  if (types.length > 1) return { ok: false, reason: `tipo de entrada ambíguo (${types.join(' e ')})`, callish };

  return { ok: true, callish: true, call: { pair: pairs[0], entry, stop, type: types[0] || 'auto' } };
}

module.exports = { parseCall, parseNumber };
