function nextUrl() {
  const params = new URLSearchParams(location.search);
  const next = params.get('next');
  // Only this site's own pages: a path starting with // or /\ would send the browser to another site.
  return next && /^\/(?![/\\])/.test(next) ? next : '/home.html';
}

const errorEl = document.getElementById('login-error');
function showError(message) {
  errorEl.innerHTML = (window.icon ? window.icon('alert') : '') + '<span></span>';
  errorEl.querySelector('span').textContent = message;
  errorEl.hidden = false;
}

// Show which restaurant this sign-in is for.
fetch('/api/auth/config').then(r => (r.ok ? r.json() : null)).then(cfg => {
  if (!cfg || !cfg.storeName) return;
  const chip = document.getElementById('login-store');
  chip.querySelector('span').textContent = `${cfg.storeName}`;
  chip.hidden = false;
}).catch(() => {});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email || !password) { showError('Enter your email address and password.'); return; }
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showError(res.status === 401 ? 'That email and password don\'t match. Check them and try again.' : (body.error || 'Sign in failed.'));
      return;
    }
    location.href = nextUrl();
  } catch (err) {
    showError('Could not reach the server: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
