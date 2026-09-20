import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api.js';

function statusBadge(status) {
  const map = { success: 'badge-success', retried: 'badge-warn', failed: 'badge-fail' };
  return <span className={`badge ${map[status] || ''}`}>{status}</span>;
}

export default function ProductDetail() {
  const { id } = useParams();
  const [product, setProduct] = useState(null);
  const [history, setHistory] = useState([]);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [scraping, setScraping] = useState(false);

  const load = useCallback(async () => {
    const [p, h, l] = await Promise.all([
      api.getProduct(id),
      api.history(id),
      api.logs(id),
    ]);
    setProduct(p.product);
    setHistory(h.history);
    setLogs(l.logs);
  }, [id]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  async function handleScrapeNow() {
    setScraping(true);
    setError(null);
    try {
      const result = await api.scrapeNow(id);
      if (result.accepted) {
        setError('Scrape started. Refresh this page in a minute to see the result.');
      } else if (!result.ok) {
        setError(result.error || 'Scrape finished without a valid price. Check the log.');
      }
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setScraping(false);
    }
  }

  const chartData = history.map((h) => ({
    time: new Date(h.scraped_at).toLocaleString(),
    price: Number(h.price),
    stock: h.stock_count,
  }));
  const latest = history[history.length - 1];

  return (
    <div className="page">
      <h1>{product ? product.name : 'Product history'}</h1>
      {product && (
        <p className="muted">
          {product.brand} · {product.category} · SKU {product.sku}
          {' · '}
          <a href={product.product_url} target="_blank" rel="noreferrer">Open on INE store</a>
        </p>
      )}
      {latest && (
        <p>
          Latest: <strong>₹{Number(latest.price).toLocaleString()}</strong>
          {latest.in_stock === false ? ' · out of stock' : latest.stock_count != null ? ` · ${latest.stock_count} in stock` : ''}
          {' · '}
          {new Date(latest.scraped_at).toLocaleString()}
        </p>
      )}
      <button onClick={handleScrapeNow} disabled={scraping}>
        {scraping ? 'Scraping live store… this can take a minute' : 'Scrape now'}
      </button>
      {error && <p className="error">{error}</p>}

      <section>
        <h2>Price over time</h2>
        {chartData.length === 0 ? (
          <p className="muted">No successful scrapes yet — click Scrape now, or wait for the 2-hour cron run.</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" hide />
              <YAxis />
              <Tooltip />
              <Line type="monotone" dataKey="price" stroke="#111" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </section>

      <section>
        <h2>Price and stock history</h2>
        <table className="log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Price</th>
              <th>In stock</th>
              <th>Stock count</th>
            </tr>
          </thead>
          <tbody>
            {[...history].reverse().map((h) => (
              <tr key={h.id}>
                <td>{new Date(h.scraped_at).toLocaleString()}</td>
                <td>₹{Number(h.price).toLocaleString()}</td>
                <td>{h.in_stock === null ? '—' : h.in_stock ? 'yes' : 'no'}</td>
                <td>{h.stock_count ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Scrape log</h2>
        <p className="muted">Every attempt is recorded: success, retried (will try again), or failed.</p>
        <table className="log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Attempt</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td>{new Date(l.attempted_at).toLocaleString()}</td>
                <td>{l.attempt_number}</td>
                <td>{statusBadge(l.status)}</td>
                <td>{l.duration_ms} ms</td>
                <td className="muted">{l.error_message || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
