(function () {
  const { $, h, api, range, renderOperations } = window.BT;
  const state = { user: null, conns: [], timer: null };

  const setMsg = (el, text, cls = 'bad') => {
    el.textContent = text || '';
    el.className = `msg ${cls}`;
  };

  function show(view) {
    $('authView').hidden = view !== 'auth';
    $('appView').hidden = view !== 'app';
    $('who').hidden = view !== 'app';
  }

  // ---------- Entrar / criar conta ----------
  function tab(which) {
    $('loginForm').hidden = which !== 'login';
    $('regForm').hidden = which !== 'reg';
    $('tabLogin').classList.toggle('on', which === 'login');
    $('tabReg').classList.toggle('on', which === 'reg');
  }
  $('tabLogin').onclick = () => tab('login');
  $('tabReg').onclick = () => tab('reg');

  async function submit(form, msgEl, fn) {
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    setMsg(msgEl, '');
    try {
      await fn();
      await enter();
    } catch (e) {
      setMsg(msgEl, e.message);
    }
    btn.disabled = false;
  }

  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submit($('loginForm'), $('lMsg'), () =>
      api('/api/auth/login', { method: 'POST', body: { email: $('lEmail').value, password: $('lPass').value } }));
  });

  $('regForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submit($('regForm'), $('rMsg'), () =>
      api('/api/auth/register', {
        method: 'POST',
        body: {
          name: $('rName').value, email: $('rEmail').value, password: $('rPass').value,
          inviteCode: $('rInvite').value, acceptTerms: $('rTerms').checked,
        },
      }));
  });

  $('logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  };

  // ---------- Editor de alvos ----------
  function targetsEditor(draft, onChange) {
    const box = h('div', { class: 'sect' });
    const summary = h('div', { class: 'tp-sum mut' });
    const addBtn = h('button', { type: 'button', class: 'ghost small', text: '+ Adicionar alvo' });
    const sum = () => draft.targets.reduce((s, t) => s + t.sellPct, 0);

    function updateSummary() {
      const s = Math.round(sum() * 10) / 10;
      if (!draft.targets.length) {
        summary.textContent = 'Sem alvos: o robô só coloca o stop e a saída fica toda por sua conta.';
      } else if (s < 100) {
        summary.textContent = `Você vende ${s}% da posição nos alvos. Os outros ${Math.round((100 - s) * 10) / 10}% ficam abertos, protegidos pelo stop, para você gerenciar.`;
      } else {
        summary.textContent = 'A posição inteira (100%) será vendida nos alvos.';
      }
      addBtn.disabled = !canAdd();
    }

    // Se a posição já está toda distribuída, o novo alvo leva metade da maior venda existente
    const canAdd = () => {
      if (draft.targets.length >= 5) return false;
      if (100 - sum() >= 1) return true;
      return draft.targets.some((t) => t.sellPct >= 2);
    };

    addBtn.onclick = () => {
      if (!canAdd()) return;
      const used = new Set(draft.targets.map((t) => t.gainPct));
      let g = Math.min(40, draft.targets.length ? Math.max(...used) + 5 : 5);
      while (used.has(g) && g > 1) g--;
      if (used.has(g)) return;
      let sell = Math.round((100 - sum()) * 10) / 10;
      if (sell < 1) {
        const big = draft.targets.reduce((a, b) => (b.sellPct > a.sellPct ? b : a));
        sell = Math.floor(big.sellPct / 2);
        big.sellPct -= sell;
      }
      draft.targets.push({ gainPct: g, sellPct: sell });
      render();
      onChange();
    };

    function render() {
      box.replaceChildren();
      draft.targets.forEach((t, i) => {
        const gainOut = h('output', { class: 'sm', text: `+${t.gainPct}%` });
        const sellOut = h('output', { class: 'sm', text: `${t.sellPct}%` });
        const gain = range({
          min: 1, max: 40, step: 1, value: t.gainPct, cls: 'tp',
          onInput: (v) => { t.gainPct = v; gainOut.textContent = `+${v}%`; onChange(); },
        });
        const sell = range({
          min: 1, max: 100, step: 1, value: t.sellPct, cls: 'tp',
          onInput: (v) => {
            const max = Math.max(1, 100 - (sum() - t.sellPct));
            if (v > max) { v = max; sell.value = v; sell.repaint(); }
            t.sellPct = v;
            sellOut.textContent = `${v}%`;
            updateSummary();
            onChange();
          },
        });
        box.append(h('div', { class: 'tp-row' },
          h('div', { class: 'n', text: `Alvo ${i + 1}` }),
          h('div', { class: 'slider' }, h('div', { class: 'slider-head' }, h('span', { text: 'Quando subir' }), gainOut), gain),
          h('div', { class: 'slider' }, h('div', { class: 'slider-head' }, h('span', { text: 'Vender da posição' }), sellOut), sell),
          h('button', {
            type: 'button', class: 'ghost small', text: 'Remover', 'aria-label': `Remover alvo ${i + 1}`,
            onclick: () => { draft.targets.splice(i, 1); render(); onChange(); },
          })));
      });
      box.append(summary, h('div', null, addBtn));
      updateSummary();
    }
    render();
    return { el: box, render };
  }

  // ---------- Cartão de uma conta ----------
  function connCard(c) {
    const draft = { allocationPct: c.allocationPct, leverage: c.leverage, targets: c.targets.map((t) => ({ ...t })) };
    const msg = h('div', { class: 'msg', role: 'status' });
    const futures = c.market === 'futures';

    const badge = h('span', { class: 'badge' });
    const toggle = h('button', { type: 'button', class: 'ghost small' });
    const paintActive = () => {
      badge.textContent = c.active ? 'ativa' : 'pausada';
      badge.className = `badge ${c.active ? 'on' : 'off'}`;
      toggle.textContent = c.active ? 'Pausar' : 'Ativar';
    };
    paintActive();
    toggle.onclick = async () => {
      toggle.disabled = true;
      try {
        Object.assign(c, await api(`/api/connections/${c.id}`, { method: 'PATCH', body: { active: !c.active } }));
        paintActive();
        setMsg(msg, c.active ? 'Conta ativa: vai receber as próximas calls.' : 'Conta pausada: não receberá novas calls.', 'mut');
      } catch (e) { setMsg(msg, e.message); }
      toggle.disabled = false;
    };

    const remove = h('button', {
      type: 'button', class: 'danger small', text: 'Remover',
      onclick: async () => {
        if (!confirm(`Remover a conta ${c.label}? As chaves salvas serão apagadas.`)) return;
        try {
          await api(`/api/connections/${c.id}`, { method: 'DELETE' });
          state.conns = state.conns.filter((x) => x.id !== c.id);
          renderConns();
        } catch (e) { setMsg(msg, e.message); }
      },
    });

    // % da banca
    const allocOut = h('output', { text: `${draft.allocationPct}%` });
    const hint = h('div', { class: 'small-text mut' });
    const paintHint = () => {
      const a = draft.allocationPct;
      if (a === 0) { hint.className = 'small-text warn'; hint.textContent = 'Com 0% o robô não abre operações nesta conta.'; return; }
      if (futures) {
        const exp = Math.round(a * draft.leverage);
        hint.className = `small-text ${exp > 100 ? 'warn' : 'mut'}`;
        hint.textContent = `Cada trade usa ${a}% do seu saldo como margem × ${draft.leverage}x = exposição de ~${exp}% do saldo.` +
          (exp > 100 ? ' Atenção: exposição maior que o saldo aumenta o risco de liquidação.' : '');
      } else {
        hint.className = 'small-text mut';
        hint.textContent = `Cada trade compra com ${a}% do seu saldo livre em USDT.`;
      }
    };
    const alloc = range({
      min: 0, max: 100, step: 1, value: draft.allocationPct,
      onInput: (v) => { draft.allocationPct = v; allocOut.textContent = `${v}%`; paintHint(); },
    });

    let levBox = null;
    if (futures) {
      levBox = h('label', null, 'Alavancagem (1 a 125)',
        h('input', {
          type: 'number', min: 1, max: 125, step: 1, value: draft.leverage,
          oninput: (e) => { draft.leverage = Number(e.target.value) || 1; paintHint(); },
        }));
    }
    paintHint();

    const tp = targetsEditor(draft, () => setMsg(msg, 'Alterações não salvas.', 'warn'));

    const saveBtn = h('button', { type: 'button', text: 'Salvar alterações' });
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      setMsg(msg, 'Salvando...', 'mut');
      try {
        const body = { allocationPct: draft.allocationPct, targets: draft.targets };
        if (futures) body.leverage = draft.leverage;
        Object.assign(c, await api(`/api/connections/${c.id}`, { method: 'PATCH', body }));
        draft.targets = c.targets.map((t) => ({ ...t }));
        tp.render();
        setMsg(msg, 'Salvo. Vale para as próximas operações; as que já estão abertas mantêm os alvos de quando entraram.', 'ok');
      } catch (e) { setMsg(msg, e.message); }
      saveBtn.disabled = false;
    };

    // Trocar chaves
    const keyBox = h('div', { class: 'sect', hidden: true });
    const nk = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
    const ns = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false' });
    const keyBtn = h('button', { type: 'button', class: 'small', text: 'Salvar novas chaves' });
    keyBtn.onclick = async () => {
      keyBtn.disabled = true;
      setMsg(msg, 'Testando as novas chaves...', 'mut');
      try {
        Object.assign(c, await api(`/api/connections/${c.id}`, { method: 'PATCH', body: { apiKey: nk.value, apiSecret: ns.value } }));
        nk.value = ''; ns.value = ''; keyBox.hidden = true;
        keyHint.textContent = `API key terminada em …${c.apiKeyHint}`;
        setMsg(msg, 'Chaves atualizadas.', 'ok');
      } catch (e) { setMsg(msg, e.message); }
      keyBtn.disabled = false;
    };
    keyBox.append(
      h('div', { class: 'row' }, h('label', null, 'Nova API key', nk), h('label', null, 'Nova API secret', ns)), keyBtn);
    const keyHint = h('span', { class: 'mut small-text', text: `API key terminada em …${c.apiKeyHint}` });

    return h('div', { class: 'conn' },
      h('div', { class: 'conn-head' },
        h('div', null, h('span', { class: 'name', text: c.label }), badge),
        h('div', { class: 'row' }, h('span', { class: 'auto' }, toggle), h('span', { class: 'auto' }, remove))),
      h('div', { class: 'sect' },
        h('h3', { text: 'Quanto da sua banca entra em cada trade' }),
        h('div', { class: 'slider' }, h('div', { class: 'slider-head' }, h('span', { text: 'Arraste de 0% a 100%' }), allocOut), alloc),
        hint, levBox),
      h('div', { class: 'sect' },
        h('h3', { text: 'Seus alvos de venda (de +1% a +40%)' }),
        h('div', { class: 'mut small-text', text: 'O % é contado sobre o preço em que a compra foi executada. Você pode vender a posição inteira em um alvo ou dividir em parciais.' }),
        tp.el),
      h('div', { class: 'row' }, h('span', { class: 'auto' }, saveBtn),
        h('span', { class: 'auto' }, h('button', { type: 'button', class: 'ghost small', text: 'Trocar chaves da API', onclick: () => { keyBox.hidden = !keyBox.hidden; } })),
        keyHint),
      keyBox,
      msg);
  }

  function renderConns() {
    const box = $('conns');
    box.replaceChildren();
    if (!state.conns.length) {
      box.append(h('div', { class: 'mut', text: 'Você ainda não adicionou nenhuma conta. Adicione abaixo para começar a receber as calls.' }));
      return;
    }
    state.conns.forEach((c) => box.append(connCard(c)));
  }

  // ---------- Adicionar conta ----------
  const addAlloc = { value: 10 };
  (function mountAddSlider() {
    const out = h('output', { text: '10%' });
    const r = range({ min: 0, max: 100, step: 1, value: 10, onInput: (v) => { addAlloc.value = v; out.textContent = `${v}%`; } });
    $('aAllocBox').append(h('div', { class: 'slider-head' }, h('span', { text: 'Quanto da sua banca entra em cada trade' }), out), r);
  })();
  $('aMarket').onchange = () => { $('aLevBox').hidden = $('aMarket').value !== 'futures'; };

  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    setMsg($('aMsg'), 'Testando a chave na corretora...', 'mut');
    try {
      const c = await api('/api/connections', {
        method: 'POST',
        body: {
          exchange: $('aEx').value, market: $('aMarket').value, leverage: Number($('aLev').value) || 1,
          apiKey: $('aKey').value, apiSecret: $('aSecret').value, allocationPct: addAlloc.value, targets: [],
        },
      });
      state.conns.push(c);
      $('aKey').value = ''; $('aSecret').value = '';
      renderConns();
      setMsg($('aMsg'), 'Conta adicionada. Agora configure seus alvos de venda no cartão da conta.', 'ok');
    } catch (err) { setMsg($('aMsg'), err.message); }
    btn.disabled = false;
  });

  // ---------- Operações ----------
  async function loadLegs() {
    const legs = await api('/api/me/legs');
    renderOperations($('ops'), legs, {
      onCancelLeg: async (l) => {
        if (!confirm('Cancelar esta operação pendente? Nenhuma compra foi feita ainda.')) return;
        try { await api(`/api/me/legs/${l.id}/cancel`, { method: 'POST' }); } catch (e) { alert(e.message); }
        loadLegs().catch(() => {});
      },
    });
  }

  async function enter() {
    const me = await api('/api/me');
    state.user = me.user;
    state.conns = me.connections;
    $('whoName').textContent = me.user.name;
    show('app');
    renderConns();
    await loadLegs().catch(() => {});
    clearInterval(state.timer);
    state.timer = setInterval(() => loadLegs().catch((e) => { if (e.status === 401) location.reload(); }), 5000);
  }

  (async function boot() {
    api('/api/config').then((c) => { $('inviteBox').hidden = !c.inviteRequired; $('rInvite').required = !!c.inviteRequired; }).catch(() => {});
    try { await enter(); } catch { show('auth'); }
  })();
})();
