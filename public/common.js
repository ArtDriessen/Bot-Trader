// Funções compartilhadas pelas telas (usuário e admin). Sem innerHTML: tudo via textContent.
(function () {
  const $ = (id) => document.getElementById(id);

  // h('div', { class: 'x', onclick: fn }, 'texto', outroElemento)
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    let value;
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'value') value = v; // aplicado por último (depois de min/max/step)
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    const add = (c) => {
      if (Array.isArray(c)) c.forEach(add);
      else if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    if (value !== undefined) e.value = value;
    return e;
  }

  async function api(path, { method = 'GET', body, headers } = {}) {
    const r = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(headers || {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || 'Erro inesperado');
      err.status = r.status;
      throw err;
    }
    return data;
  }

  // Barra deslizante com preenchimento colorido. Retorna o <input type=range>.
  function range({ min, max, step = 1, value, cls = '', onInput }) {
    const input = h('input', { type: 'range', min, max, step, value, class: cls });
    const paint = () => input.style.setProperty('--p', `${((input.value - min) / (max - min)) * 100}%`);
    input.addEventListener('input', () => {
      paint();
      if (onInput) onInput(Number(input.value));
    });
    paint();
    input.repaint = paint;
    return input;
  }

  const LABEL = {
    pendente: 'pendente', monitorando: 'monitorando preço', ordem_aberta: 'ordem limite aberta',
    ativa: 'ativa (alvos monitorados)', concluida: 'protegida', cancelada: 'cancelada', erro: 'erro',
    fechada_sem_stop: 'fechada (stop falhou)', exposto_sem_stop: 'SEM STOP - confira!', sem_stop: 'SEM STOP - confira!',
  };
  const statusClass = (st) =>
    ['concluida', 'ativa'].includes(st) ? 'ok' : ['monitorando', 'ordem_aberta', 'cancelada', 'pendente'].includes(st) ? 'warn' : 'bad';
  const TYPE = { market: 'mercado', limit: 'limite', breakout: 'rompimento', dip: 'fundo' };
  const PENDING = ['monitorando', 'ordem_aberta'];

  const fmtDate = (iso) => new Date(iso).toLocaleString('pt-BR');
  const fmtTargets = (t) => (t && t.length ? t.map((x) => `+${x.gainPct}% (vende ${x.sellPct}%)`).join(', ') : 'sem alvos');

  function legsTable(legs, { admin = false, onCancelLeg } = {}) {
    const cols = [...(admin ? ['Usuário'] : []), 'Conta', 'Status', 'Detalhes', ''];
    const t = h('table', null, h('tr', null, cols.map((c) => h('th', { text: c }))));
    legs.forEach((l) => {
      const detail = l.error ? l.error : (l.steps || []).slice(-3).join(' → ');
      const action = !admin && onCancelLeg && PENDING.includes(l.status)
        ? h('button', { class: 'ghost small', text: 'Cancelar', onclick: () => onCancelLeg(l) })
        : '';
      t.append(h('tr', null,
        admin ? h('td', { text: l.userName || '-' }) : null,
        h('td', { text: admin ? `${l.clientName}` : l.clientName }),
        h('td', { class: statusClass(l.status), text: LABEL[l.status] || l.status }),
        h('td', { text: detail }),
        h('td', null, action)));
    });
    return h('div', { class: 'scroll' }, t);
  }

  // Agrupa por sinal e desenha cabeçalho + tabela
  function renderOperations(box, legs, { admin = false, onCancelSignal, onCancelLeg } = {}) {
    box.replaceChildren();
    const groups = new Map();
    legs.forEach((l) => {
      if (!groups.has(l.signalId)) groups.set(l.signalId, []);
      groups.get(l.signalId).push(l);
    });
    if (!groups.size) {
      box.append(h('div', { class: 'mut', text: 'Nenhuma operação ainda.' }));
      return;
    }
    [...groups.values()].slice(0, 15).forEach((g) => {
      const s = g[0].signal;
      const head = h('div', { class: 'grp' },
        h('b', { text: `${s.base}/${s.quote}` }),
        h('span', { class: 'mut', text: `${TYPE[s.type]} ${s.entry} | stop ${s.stopType === 'limit' ? 'limit ' : ''}${s.stop}` }),
        h('span', { class: 'mut', text: fmtDate(s.at) }));
      if (admin && onCancelSignal && g.some((l) => PENDING.includes(l.status))) {
        head.append(h('button', { class: 'danger small', text: 'Cancelar pendentes', onclick: () => onCancelSignal(s.id) }));
      }
      box.append(head);
      if (!admin) box.append(h('div', { class: 'mut small-text', text: `Seus alvos nesta operação: ${fmtTargets(g[0].targets)}` }));
      box.append(legsTable(g, { admin, onCancelLeg }));
    });
  }

  window.BT = { $, h, api, range, LABEL, statusClass, fmtDate, fmtTargets, renderOperations };
})();
