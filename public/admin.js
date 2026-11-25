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
    clearInterval(timer);
    timer = setInterval(() => { loadLegs().catch(() => {}); loadUsers().catch(() => {}); }, 5000);
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
