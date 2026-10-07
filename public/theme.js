// Applies the saved (or system) colour theme before first paint, and puts a light/dark switch in the top bar.
(function () {
  const root = document.documentElement;
  const saved = () => { try { return localStorage.getItem('theme'); } catch (e) { return null; } };
  const systemDark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = saved() || (systemDark() ? 'dark' : 'light');

  window.addEventListener('DOMContentLoaded', () => {
    const slot = document.getElementById('slot-theme');
    if (!slot) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn theme-toggle';
    const paint = () => {
      const dark = root.dataset.theme === 'dark';
      btn.innerHTML = window.icon ? window.icon(dark ? 'sun' : 'moon') : (dark ? '&#9728;' : '&#9790;');
      btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
      btn.setAttribute('aria-label', btn.title);
    };
    btn.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) { /* storage unavailable */ }
      paint();
    });
    paint();
    slot.appendChild(btn);
  });
})();
