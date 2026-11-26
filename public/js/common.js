(() => {
  'use strict';

  // O token CSRF vive só na memória desta aba (não é gravado em nenhum armazenamento do navegador).
  let csrfToken = null;
  const setCsrf = (t) => { csrfToken = t; };

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    }
    let res;
    try {
      res = await fetch(path, {
        method, headers, credentials: 'same-origin',
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
    } catch {
      throw Object.assign(new Error('Sem conexão com o servidor. Tente novamente.'), { status: 0 });
    }
    let data = null;
    if (res.status !== 204) { try { data = await res.json(); } catch { data = null; } }
    const isAuthForm = path === '/api/auth/login' || path === '/api/auth/register';
    if (res.status === 401 && !isAuthForm) { window.location.href = '/login'; throw Object.assign(new Error('Sessão expirada.'), { status: 401 }); }
    if (!res.ok) {
      throw Object.assign(new Error((data && data.error) || 'Algo deu errado. Tente novamente.'), {
        status: res.status, fields: data && data.fields,
      });
    }
    return data;
  }

  // Cria elementos usando apenas textContent: dados do usuário nunca são interpretados como HTML (anti-XSS).
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c != null) node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const brl = (cents) => brlFmt.format(cents / 100);

  function clearErrors(form) {
    form.querySelectorAll('.field-error').forEach((p) => { p.hidden = true; p.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
    const fe = form.querySelector('.form-error');
    if (fe) { fe.hidden = true; fe.textContent = ''; }
  }

  function showErrors(form, err) {
    clearErrors(form);
    let first = null;
    for (const [name, msg] of Object.entries(err.fields || {})) {
      const p = form.querySelector(`.field-error[data-for="${CSS.escape(name)}"]`);
      const input = form.elements[name];
      if (p) { p.textContent = msg; p.hidden = false; }
      if (input && input.setAttribute) { input.setAttribute('aria-invalid', 'true'); if (!first) first = input; }
    }
    const fe = form.querySelector('.form-error');
    if (fe) { fe.textContent = err.message; fe.hidden = false; }
    if (first) first.focus();
  }

  let toastTimer;
  function toast(message, isError = false) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message;
    t.className = `toast show${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 4000);
  }

  document.addEventListener('click', (e) => {
    const closer = e.target.closest && e.target.closest('[data-close]');
    if (closer) { const d = closer.closest('dialog'); if (d) d.close(); }
  });

  window.Prumo = { api, setCsrf, el, brl, clearErrors, showErrors, toast };
})();
