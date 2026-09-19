import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function Dashboard() {
  const [products, setProducts] = useState([]);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  async function load() {
    const r = await api.listTracked();
    setProducts(r.products);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function handleUntrack(id) {
    setBusyId(id);
    setError(null);
    try {
      await api.untrack(id);
      setProducts((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <h1>Tracked products</h1>
      <p className="muted">Scheduled scrape: every 2 hours via cron hitting the backend. You can also scrape immediately from a product page.</p>
      {error && <p className="error">{error}</p>}
      {products.length === 0 && <p className="muted">No products tracked yet. Go search for one.</p>}
      <ul className="result-list">
        {products.map((p) => (
          <li key={p.id} className="result-item">
            <div>
              <strong>{p.name}</strong>
              <div className="muted">{p.brand} · {p.category} · SKU {p.sku}</div>
            </div>
            <div className="row-actions">
              <Link to={`/products/${p.id}`}>History →</Link>
              <button onClick={() => handleUntrack(p.id)} disabled={busyId === p.id}>
                {busyId === p.id ? 'Removing…' : 'Untrack'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
