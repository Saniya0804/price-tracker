const BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  search: (q) => req(`/api/search?q=${encodeURIComponent(q)}`),
  track: (product) => req('/api/products/track', { method: 'POST', body: JSON.stringify(product) }),
  listTracked: () => req('/api/products'),
  getProduct: (id) => req(`/api/products/${id}`),
  untrack: (id) => req(`/api/products/${id}`, { method: 'DELETE' }),
  scrapeNow: (id) => req(`/api/products/${id}/scrape`, { method: 'POST' }),
  history: (id) => req(`/api/products/${id}/history`),
  logs: (id) => req(`/api/products/${id}/logs`),
};
