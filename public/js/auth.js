(() => {
  'use strict';
  const { api, el, clearErrors, showErrors } = window.Prumo;

  const form = document.getElementById('login-form') || document.getElementById('register-form');
  if (!form) return;
  const isLogin = form.id === 'login-form';

  document.getElementById('show-password').addEventListener('change', (e) => {
    form.querySelectorAll('input[type="password"], input[data-pw]').forEach((i) => {
      i.type = e.target.checked ? 'text' : 'password';
      i.dataset.pw = '1';
    });
  });

  if (isLogin && new URLSearchParams(window.location.search).get('registered') === '1') {
    form.querySelector('h2').after(el('p', { class: 'form-ok', role: 'status', text: 'Conta criada! Entre com seu e-mail e senha.' }));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const btn = form.querySelector('button[type="submit"]');
    const data = Object.fromEntries(new FormData(form).entries());

    if (!isLogin && data.password !== data.passwordConfirm) {
      showErrors(form, { message: 'Corrija os campos destacados.', fields: { passwordConfirm: 'As senhas não coincidem.' } });
      return;
    }

    btn.disabled = true;
    try {
      if (isLogin) {
        await api('/api/auth/login', { method: 'POST', body: { email: data.email, password: data.password } });
        window.location.href = '/dashboard';
      } else {
        await api('/api/auth/register', { method: 'POST', body: data });
        window.location.href = '/login?registered=1';
      }
    } catch (err) {
      showErrors(form, err);
      const pw = form.querySelector('#password');
      if (isLogin && pw) { pw.value = ''; pw.focus(); }
    } finally {
      btn.disabled = false;
    }
  });
})();
