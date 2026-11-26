(() => {
  'use strict';
  const { api, setCsrf, el, brl, clearErrors, showErrors, toast } = window.Prumo;
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  // Mês atual no fuso do navegador (e não em UTC, que virava o mês às 21h no Brasil).
  const currentMonthLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

  const state = { month: currentMonthLocal(), filter: '', page: 1, categories: { income: [], expense: [] }, budgets: [], editing: null, editingBudget: null, deleting: null };

  const shiftMonth = (ym, delta) => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
  };
  const monthName = (ym, opts) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC', ...opts });
  const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

  /* ---------- Resumo ---------- */
  function renderSummary(d) {
    $('month-label').textContent = monthName(d.month, { month: 'long', year: 'numeric' });
    const bal = $('month-balance');
    bal.textContent = brl(d.monthBalanceCents);
    bal.className = `hero-value ${d.monthBalanceCents > 0 ? 'pos' : d.monthBalanceCents < 0 ? 'neg' : ''}`;
    $('income').textContent = brl(d.incomeCents);
    $('expense').textContent = brl(d.expenseCents);
    $('accumulated').textContent = brl(d.accumulatedBalanceCents);
    const total = d.incomeCents + d.expenseCents;
    $('split-in').style.width = total ? `${(d.incomeCents / total) * 100}%` : '0%';
    $('split-out').style.width = total ? `${(d.expenseCents / total) * 100}%` : '0%';
  }

  /* ---------- Gráfico (SVG feito à mão; nada de CDN) ---------- */
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}, text) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

  function renderChart(history) {
    const host = $('chart');
    host.replaceChildren();
    const W = 600, H = 220, base = 190, top = 24, slot = W / history.length;
    const max = Math.max(1, ...history.flatMap((h) => [h.incomeCents, h.expenseCents]));
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
    root.append(svg('line', { x1: 0, x2: W, y1: base, y2: base, class: 'axis' }));
    const summary = [];
    history.forEach((h, i) => {
      const cx = slot * i + slot / 2;
      const g = svg('g');
      g.append(svg('title', {}, `${monthName(h.month, { month: 'long', year: 'numeric' })}: entradas ${brl(h.incomeCents)}, saídas ${brl(h.expenseCents)}`));
      [['bar-in', h.incomeCents, cx - 32], ['bar-out', h.expenseCents, cx + 4]].forEach(([cls, v, x]) => {
        const bh = v ? Math.max(3, (v / max) * (base - top)) : 0;
        if (bh) g.append(svg('rect', { class: cls, x, y: base - bh, width: 28, height: bh, rx: 3 }));
        if (v) g.append(svg('text', { class: 'value', x: x + 14, y: base - bh - 5, 'text-anchor': 'middle' }, compact.format(v / 100)));
      });
      g.append(svg('text', { x: cx, y: base + 20, 'text-anchor': 'middle' }, monthName(h.month, { month: 'short' }).replace('.', '')));
      root.append(g);
      summary.push(`${monthName(h.month, { month: 'long' })}: entradas ${brl(h.incomeCents)}, saídas ${brl(h.expenseCents)}`);
    });
    host.append(root);
    host.setAttribute('aria-label', `Entradas e saídas dos últimos seis meses. ${summary.join('; ')}.`);
  }

  function renderCategories(list) {
    const ul = $('cats');
    ul.replaceChildren();
    $('cats-empty').hidden = list.length > 0;
    const total = list.reduce((s, c) => s + c.totalCents, 0);
    for (const c of list) {
      const pct = total ? (c.totalCents / total) * 100 : 0;
      const bar = el('span');
      bar.style.width = `${pct}%`;
      ul.append(el('li', {},
        el('div', { class: 'cat-row' }, el('span', { text: c.category }), el('span', { text: `${brl(c.totalCents)} · ${Math.round(pct)}%` })),
        el('div', { class: 'cat-bar', role: 'presentation' }, bar)));
    }
  }

  async function loadDashboard() {
    const d = await api(`/api/dashboard?month=${encodeURIComponent(state.month)}`);
    renderSummary(d); renderChart(d.history); renderCategories(d.expensesByCategory); renderBudgets(d.budgets);
  }

  /* ---------- Orçamento por categoria ---------- */
  function renderBudgets(list) {
    state.budgets = list;
    const ul = $('budgets');
    ul.replaceChildren();
    $('budgets-empty').hidden = list.length > 0;
    for (const b of list) {
      const bar = el('span');
      bar.style.width = `${Math.min(100, b.percent)}%`;
      const over = b.status === 'over';
      const note = over ? `Passou ${brl(b.spentCents - b.limitCents)} do limite.` : `Restam ${brl(b.limitCents - b.spentCents)}.`;
      ul.append(el('li', {},
        el('div', { class: 'cat-row' }, el('span', { text: b.category }), el('span', { text: `${brl(b.spentCents)} de ${brl(b.limitCents)} · ${b.percent}%` })),
        el('div', {
          class: `cat-bar budget-${b.status}`, role: 'progressbar', 'aria-label': `Orçamento de ${b.category}`,
          'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.min(100, b.percent)), 'aria-valuetext': `${b.percent}% do limite. ${note}`,
        }, bar),
        el('div', { class: 'budget-foot' },
          el('span', { class: `budget-note budget-note-${b.status}`, text: note }),
          el('button', { type: 'button', class: 'link-btn', 'aria-label': `Editar orçamento de ${b.category}`, text: 'Editar', onclick: () => openBudget(b) }))));
    }
  }

  /* ---------- Lista ---------- */
  function txItem(t) {
    const sign = t.type === 'income' ? '+' : '−';
    return el('li', {},
      el('span', { class: 'tx-date', text: `${t.date.slice(8, 10)}/${t.date.slice(5, 7)}` }),
      el('div', { class: 'tx-desc' }, el('strong', { text: t.description }), el('span', { text: t.category })),
      el('span', { class: `tx-amount ${t.type === 'income' ? 'pos' : 'neg'}`, text: `${sign} ${brl(t.amountCents)}` }),
      el('div', { class: 'tx-actions' },
        el('button', { type: 'button', 'aria-label': `Editar ${t.description}`, text: 'Editar', onclick: () => openTx(t) }),
        el('button', { type: 'button', class: 'del', 'aria-label': `Excluir ${t.description}`, text: 'Excluir', onclick: () => openDelete(t) })));
  }

  async function loadTransactions(reset = true) {
    if (reset) { state.page = 1; $('tx-list').replaceChildren(); }
    const qs = new URLSearchParams({ month: state.month, page: String(state.page) });
    if (state.filter) qs.set('type', state.filter);
    const { items, hasMore } = await api(`/api/transactions?${qs}`);
    $('tx-list').append(...items.map(txItem));
    $('tx-empty').hidden = $('tx-list').children.length > 0;
    $('btn-more').hidden = !hasMore;
  }

  const refresh = () => Promise.all([loadDashboard(), loadTransactions(true)]).catch((e) => toast(e.message, true));

  /* ---------- Formulário de movimentação ---------- */
  const txForm = $('tx-form');
  function fillCategories(type, selected) {
    const sel = $('tx-category');
    sel.replaceChildren(...state.categories[type].map((c) => el('option', { value: c, text: c })));
    if (selected && state.categories[type].includes(selected)) sel.value = selected;
  }
  function openTx(t) {
    state.editing = t || null;
    clearErrors(txForm);
    $('dlg-tx-title').textContent = t ? 'Editar movimentação' : 'Nova movimentação';
    const type = t ? t.type : 'expense';
    txForm.elements.type.value = type;
    fillCategories(type, t && t.category);
    $('tx-amount').value = t ? (t.amountCents / 100).toFixed(2).replace('.', ',') : '';
    $('tx-description').value = t ? t.description : '';
    $('tx-date').value = t ? t.date : (state.month === currentMonthLocal() ? todayLocal() : `${state.month}-01`);
    $('dlg-tx').showModal();
    $('tx-amount').focus();
  }
  txForm.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', () => fillCategories(txForm.elements.type.value)));
  $('btn-new').addEventListener('click', () => openTx(null));

  txForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(txForm);
    const btn = $('tx-save');
    btn.disabled = true;
    const body = {
      type: txForm.elements.type.value,
      category: $('tx-category').value,
      description: $('tx-description').value,
      amount: $('tx-amount').value,
      date: $('tx-date').value,
    };
    try {
      if (state.editing) await api(`/api/transactions/${encodeURIComponent(state.editing.id)}`, { method: 'PUT', body });
      else await api('/api/transactions', { method: 'POST', body });
      $('dlg-tx').close();
      toast('Movimentação salva.');
      // Se a data caiu em outro mês, mostra esse mês para o usuário ver o lançamento.
      if (body.date.slice(0, 7) !== state.month) state.month = body.date.slice(0, 7);
      await refresh();
    } catch (err) { showErrors(txForm, err); } finally { btn.disabled = false; }
  });

  /* ---------- Formulário de orçamento ---------- */
  const budgetForm = $('budget-form');
  function openBudget(b) {
    const used = new Set(state.budgets.map((x) => x.category));
    const available = state.categories.expense.filter((c) => (b ? c === b.category : !used.has(c)));
    if (!available.length) { toast('Todas as categorias de saída já têm orçamento.'); return; }
    state.editingBudget = b || null;
    clearErrors(budgetForm);
    $('dlg-budget-title').textContent = b ? 'Editar orçamento' : 'Novo orçamento';
    const sel = $('budget-category');
    sel.replaceChildren(...available.map((c) => el('option', { value: c, text: c })));
    sel.disabled = Boolean(b); // ao editar, a categoria fica travada
    $('budget-limit').value = b ? (b.limitCents / 100).toFixed(2).replace('.', ',') : '';
    $('budget-remove').hidden = !b;
    $('dlg-budget').showModal();
    $('budget-limit').focus();
  }
  $('btn-budget').addEventListener('click', () => openBudget(null));

  budgetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(budgetForm);
    const btn = $('budget-save');
    btn.disabled = true;
    let saved = false;
    try {
      await api('/api/budgets', { method: 'PUT', body: { category: $('budget-category').value, limit: $('budget-limit').value } });
      saved = true;
    } catch (err) { showErrors(budgetForm, err); } finally { btn.disabled = false; }
    if (saved) {
      $('dlg-budget').close();
      toast('Orçamento salvo.');
      loadDashboard().catch((err) => toast(err.message, true));
    }
  });

  $('budget-remove').addEventListener('click', async () => {
    try {
      await api(`/api/budgets/${encodeURIComponent(state.editingBudget.category)}`, { method: 'DELETE' });
      $('dlg-budget').close();
      toast('Orçamento removido.');
      await loadDashboard();
    } catch (err) { toast(err.message, true); }
  });

  /* ---------- Exclusão ---------- */
  function openDelete(t) {
    state.deleting = t;
    $('delete-text').textContent = `“${t.description}” (${brl(t.amountCents)}) será removida. Essa ação não pode ser desfeita.`;
    $('dlg-delete').showModal();
  }
  $('delete-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/transactions/${encodeURIComponent(state.deleting.id)}`, { method: 'DELETE' });
      $('dlg-delete').close();
      toast('Movimentação excluída.');
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  /* ---------- Conta ---------- */
  const pwForm = $('password-form');
  $('btn-password').addEventListener('click', () => { pwForm.reset(); clearErrors(pwForm); $('dlg-password').showModal(); });
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(pwForm);
    const body = Object.fromEntries(new FormData(pwForm).entries());
    try {
      await api('/api/auth/change-password', { method: 'POST', body });
      pwForm.reset();
      $('dlg-password').close();
      toast('Senha alterada. Outros dispositivos foram desconectados.');
    } catch (err) { showErrors(pwForm, err); }
  });

  const accForm = $('account-form');
  $('btn-delete-account').addEventListener('click', () => { $('dlg-password').close(); accForm.reset(); clearErrors(accForm); $('dlg-account').showModal(); });
  accForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/delete-account', { method: 'POST', body: { password: $('acc-password').value } });
      window.location.href = '/login';
    } catch (err) { showErrors(accForm, err); }
  });

  $('btn-logout').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } finally { window.location.href = '/login'; }
  });

  /* ---------- Navegação ---------- */
  $('month-prev').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); refresh(); });
  $('month-next').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); refresh(); });
  document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    state.filter = chip.dataset.filter;
    loadTransactions(true).catch((e) => toast(e.message, true));
  }));
  $('btn-more').addEventListener('click', () => { state.page += 1; loadTransactions(false).catch((e) => toast(e.message, true)); });

  /* ---------- Início ---------- */
  (async () => {
    try {
      const me = await api('/api/auth/me');
      setCsrf(me.csrfToken);
      $('user-name').textContent = me.user.name;
      state.categories = await api('/api/categories');
      await refresh();
    } catch (err) { toast(err.message, true); }
  })();
})();
