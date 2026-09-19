import { useState } from 'react';
import { api } from '../api.js';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [trackedIds, setTrackedIds] = useState({});
  const [error, setError] = useState(null);

  async function handleSearch(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { results } = await api.search(query);
      setResults(results);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleTrack(product) {
    try {
      const { product: saved } = await api.track(product);
      setTrackedIds((prev) => ({ ...prev, [product.product_url]: saved.id }));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <h1>Search the INE store</h1>
      <p className="muted">
        Search by partial or full product name, then track it. The app scrapes price and stock
        from the live store every 2 hours (and whenever you click Scrape now).
      </p>
      <form onSubmit={handleSearch} className="search-form">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. Vista Tote, Helix Earbuds, SUM-10266"
        />
        <button type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
      </form>

      {error && <p className="error">{error}</p>}
      {!loading && results.length === 0 && (
        <p className="muted">No results yet. Try a name like “Vista” or “Ultrawide”.</p>
      )}

      <ul className="result-list">
        {results.map((p) => (
          <li key={p.product_url} className="result-item">
            <div>
              <strong>{p.name}</strong>
              <div className="muted">{p.brand} · {p.category} · SKU {p.sku}</div>
            </div>
            <button onClick={() => handleTrack(p)} disabled={!!trackedIds[p.product_url]}>
              {trackedIds[p.product_url] ? 'Tracked ✓' : 'Track'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
