import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { supabase } from './db.js';
import { scrapeAllTrackedProducts, searchProducts, refreshCatalog, scrapeTrackedProductById } from './scraper.js';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 4000);
const CRON_SECRET = process.env.CRON_SECRET;
let scrapeRunInProgress = false;

// Keeps Render's free instance responsive; cron-job.org can also ping this
// on a shorter interval to reduce cold starts.
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Search the mock store by partial/full product name.
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const results = await searchProducts(q);
    res.json({ results });
  } catch (err) {
    console.error('[search]', err);
    res.status(502).json({ error: 'Failed to search store', detail: String(err.message || err) });
  }
});

// One-off (or occasionally scheduled) crawl of the store's full product
// listing into the `catalog` cache table that /api/search reads from.
// The store has no search of its own, so this has to be crawled up front.
app.post('/api/catalog/refresh', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await refreshCatalog();
    res.json(result);
  } catch (err) {
    console.error('[catalog/refresh]', err);
    res.status(500).json({ error: 'Catalog refresh failed', detail: String(err.message || err) });
  }
});

// Track a new product.
app.post('/api/products/track', async (req, res) => {
  try {
    const { name, sku, brand, category, product_url, scrape_interval_minutes } = req.body;
    if (!product_url) return res.status(400).json({ error: 'product_url is required' });

    const fromUrl = /\/product\/\d+/.test(String(product_url)) ? product_url : null;
    const skuMatch = String(sku || '').match(/(\d{4,})$/);
    const skuProductId = skuMatch ? Number(skuMatch[1]) - 10000 : 0;
    const canonicalUrl = fromUrl
      || (skuProductId > 0
        ? `${process.env.STORE_BASE_URL || 'https://demo.inelabteamdev.com'}/product/${skuProductId}`
        : product_url);

    const { data, error } = await supabase
      .from('products')
      .upsert(
        { name, sku, brand, category, product_url: canonicalUrl, scrape_interval_minutes: scrape_interval_minutes || 120 },
        { onConflict: 'product_url' }
      )
      .select()
      .single();

    if (error) throw error;
    res.json({ product: data });
  } catch (err) {
    console.error('[track]', err);
    res.status(500).json({ error: 'Failed to track product', detail: String(err.message || err) });
  }
});

// List tracked products.
app.get('/api/products', async (req, res) => {
  const { data, error } = await supabase.from('products').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ products: data });
});

app.get('/api/products/:id', async (req, res) => {
  const { data, error } = await supabase.from('products').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json({ product: data });
});

app.delete('/api/products/:id', async (req, res) => {
  const { error } = await supabase.from('products').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/products/:id/scrape', async (req, res) => {
  try {
    const result = await scrapeTrackedProductById(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('[scrape/one]', err);
    res.status(500).json({ error: 'Scrape failed', detail: String(err.message || err) });
  }
});

// Price/stock history for a product.
app.get('/api/products/:id/history', async (req, res) => {
  const { data, error } = await supabase
    .from('price_history')
    .select('*')
    .eq('product_id', req.params.id)
    .order('scraped_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ history: data });
});

// Scrape attempt log for a product.
app.get('/api/products/:id/logs', async (req, res) => {
  const { data, error } = await supabase
    .from('scrape_logs')
    .select('*')
    .eq('product_id', req.params.id)
    .order('attempted_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ logs: data });
});

// Triggered by the external cron service every 2 hours (see README).
// Protected by a shared secret so random requests can't spam scrapes.
app.post('/api/scrape/run', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (scrapeRunInProgress) {
    return res.status(409).json({ error: 'A scrape run is already in progress' });
  }

  scrapeRunInProgress = true;
  res.status(202).json({ accepted: true, message: 'Scrape run started' });

  scrapeAllTrackedProducts()
    .then((result) => console.log('[scrape/run] completed', result))
    .catch((err) => console.error('[scrape/run]', err))
    .finally(() => {
      scrapeRunInProgress = false;
    });
});

function startServer(port) {
  const server = app.listen(port, () => console.log(`[server] listening on port ${port}`));

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      const fallbackPort = port + 1;
      console.warn(`[server] Port ${port} is busy. Retrying on ${fallbackPort}.`);
      startServer(fallbackPort);
      return;
    }
    console.error('[server] failed to start', err);
  });
}

startServer(PORT);
