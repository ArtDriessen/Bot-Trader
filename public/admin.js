(function () {
  const { $, h, api, renderOperations, fmtDate } = window.BT;
  let token = '';
  try { token = sessionStorage.getItem('adm') || ''; } catch { /* sem storage */ }

  const adm = (path, opts = {}) => api(path, { ...opts, headers: { 'x-admin-token': token } });
  const setMsg = (el, text, cls = 'bad') => { el.textContent = text || ''; el.className = `msg ${cls}`; };
  let timer = null;

  async function loadUsers() {
    const list = await adm('/api/admin/users');
    const t = h('table', null, h('tr', null, ['Nome', 'E-mail', 'Contas', 'Cadastro', ''].map((x) => h('th', { text: x }))));
    list.forEach((u) => {
      const conns = u.connections.length
        ? u.connections.map((c) => `${c.label} (${c.active ? 'ativa' : 'pausada'}, ${c.allocationPct}%)`).join('; ')
        : 'nenhuma';
      const btn = h('button', {
        class: `${u.blocked ? 'ghost' : 'danger'} small`, text: u.blocked ? 'Desbloquear' : 'Bloquear',
        onclick: async () => {
          if (!u.blocked && !confirm(`Bloquear ${u.name}? Ele não receberá novas calls e será desconectado.`)) return;
          await adm(`/api/admin/users/${u.id}/block`, { method: 'POST', body: { blocked: !u.blocked } });
          loadUsers();
        },
      });
      t.append(h('tr', null,
        h('td', { text: u.name + (u.blocked ? ' (bloqueado)' : '') }), h('td', { text: u.email }),
        h('td', { text: conns }), h('td', { text: fmtDate(u.createdAt) }), h('td', null, btn)));
    });
    $('users').replaceChildren(list.length ? t : h('div', { class: 'mut', text: 'Nenhum usuário cadastrado ainda.' }));
  }

  const CALL_LABEL = { aguardando: 'aguardando aprovação', executando: 'executando...', executada: 'executada', descartada: 'descartada', ignorada: 'ignorada', erro: 'erro' };
  const CALL_CLS = { aguardando: 'warn', executando: 'warn', executada: 'ok', descartada: 'mut', ignorada: 'mut', erro: 'bad' };

  async function loadCalls() {
    const { telegram: tg, calls } = await adm('/api/admin/calls');
    const st = $('tgStatus');
    if (!tg.enabled) {
      st.className = 'small-text warn';
      st.textContent = 'Leitura do Telegram desativada. Defina TELEGRAM_BOT_TOKEN no servidor para ler as calls do seu canal.';
    } else if (!tg.chatConfigured) {
      st.className = 'small-text warn';
      st.textContent = 'Bot conectado, mas falta definir TELEGRAM_CHAT_ID. Poste uma mensagem no canal e copie o id que aparece abaixo como "ignorada".';
    } else {
      st.className = `small-text ${tg.connected ? 'ok' : 'bad'}`;
      st.textContent = `${tg.connected ? 'Conectado' : `Sem conexão${tg.lastError ? ` (${tg.lastError})` : ''}`}. Modo: ${tg.auto ? 'AUTOMÁTICO (executa sozinho)' : 'com aprovação (você clica em Executar)'}. Mensagens com mais de ${tg.maxAgeMin} min são ignoradas.`;
    }
    const t = h('table', null, h('tr', null, ['Recebida', 'Mensagem', 'Entendido', 'Status', ''].map((x) => h('th', { text: x }))));
    calls.slice(0, 30).forEach((c) => {
      const p = c.parsed;
      const understood = p ? `${p.pair} | ${({ auto: 'automático', market: 'mercado', limit: 'limite', breakout: 'rompimento', dip: 'fundo' })[p.type]} | entrada ${p.entry} | stop ${p.stop}` : (c.reason || '');
      const acts = h('div', { class: 'row' });
      if (c.status === 'aguardando') {
        acts.append(
          h('button', { class: 'small auto', text: 'Executar', onclick: async () => {
            if (!confirm(`Executar para todas as contas ativas?\n\n${understood}\n\nMensagem: ${c.text}`)) return;
            try { await adm(`/api/admin/calls/${c.id}/execute`, { method: 'POST' }); } catch (e) { alert(e.message); }
            loadCalls(); loadLegs().catch(() => {});
          } }),
          h('button', { class: 'ghost small auto', text: 'Descartar', onclick: async () => {
            try { await adm(`/api/admin/calls/${c.id}/discard`, { method: 'POST' }); } catch (e) { alert(e.message); }
            loadCalls();
          } }));
      }
      const statusText = (CALL_LABEL[c.status] || c.status) + (c.status === 'executada' && c.result ? ` (${c.result.contas} conta(s)${c.result.erros ? `, ${c.result.erros} com erro` : ''})` : '') + (c.status === 'ignorada' || c.status === 'erro' ? `: ${c.reason || ''}` : '');
      t.append(h('tr', null,
        h('td', { text: fmtDate(c.at || c.receivedAt) }),
        h('td', { text: c.text ? c.text : `Chat: ${c.chat?.title || ''} (id ${c.chat?.id})`, style: 'white-space:pre-wrap;max-width:320px' }),
        h('td', { text: c.status === 'ignorada' ? '' : understood }),
        h('td', { class: CALL_CLS[c.status] || '', text: statusText }),
        h('td', null, acts)));
    });
    $('calls').replaceChildren(calls.length ? t : h('div', { class: 'mut', text: 'Nenhuma call recebida ainda.' }));
  }

  async function loadLegs() {
    renderOperations($('ops'), await adm('/api/admin/legs'), {
      admin: true,
      onCancelSignal: async (id) => {
        if (!confirm('Cancelar o que ainda não foi executado deste sinal, para todos os usuários?')) return;
        await adm(`/api/admin/signals/${id}/cancel`, { method: 'POST' });
        loadLegs();
      },
    });
  }

  async function start() {
    try {
      await loadUsers();
    } catch (e) {
      $('login').hidden = false;
      $('app').hidden = true;
      if (token) setMsg($('lMsg'), e.status === 401 ? 'Token inválido' : e.message);
      return;
    }
    $('login').hidden = true;
    $('app').hidden = false;
    await loadLegs().catch(() => {});
    await loadCalls().catch(() => {});
    clearInterval(timer);
    timer = setInterval(() => { loadLegs().catch(() => {}); loadUsers().catch(() => {}); loadCalls().catch(() => {}); }, 5000);
  }

  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    token = $('token').value;
    try { sessionStorage.setItem('adm', token); } catch { /* ok */ }
    start();
  });

  $('stopType').onchange = () => { $('offsetBox').hidden = $('stopType').value !== 'limit'; };

  $('sigForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      pair: $('pair').value, type: $('type').value, entry: $('entry').value, stop: $('stop').value,
      stopType: $('stopType').value, stopLimitOffsetPct: $('offset').value, expireHours: $('expire').value,
    };
    const resumo = `${body.type.toUpperCase()} ${body.pair}\nEntrada ${body.entry} | Stop ${body.stop} (${body.stopType})`;
    if (!confirm(`Enviar para todas as contas ativas?\n\n${resumo}`)) return;
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    setMsg($('msg'), 'Enviando...', 'mut');
    try {
      const data = await adm('/api/admin/signal', { method: 'POST', body });
      const bad = ['erro', 'fechada_sem_stop', 'exposto_sem_stop', 'sem_stop'];
      const ok = data.legs.filter((l) => !bad.includes(l.status)).length;
      setMsg($('msg'), `${ok}/${data.legs.length} contas aceitaram. Veja o andamento em "Operações".`, ok === data.legs.length ? 'ok' : 'warn');
      loadLegs();
    } catch (err) { setMsg($('msg'), err.message); }
    btn.disabled = false;
  });

  if (token) start();
})();
