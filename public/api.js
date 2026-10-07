window.api = {
  async request(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !path.startsWith('/api/auth')) {
      location.href = '/login.html?next=' + encodeURIComponent(location.pathname);
      return new Promise(() => {}); // stop this page's own load logic; the redirect is already underway
    }
    if (!res.ok) {
      let message = res.statusText;
      try { message = (await res.json()).error || message; } catch { /* ignore */ }
      throw new Error(message);
    }
    const contentType = res.headers.get('content-type') || '';
    return contentType.includes('application/json') ? res.json() : res.text();
  },
  get(path) { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body); },
  put(path, body) { return this.request('PUT', path, body); },
  del(path) { return this.request('DELETE', path); },
};
