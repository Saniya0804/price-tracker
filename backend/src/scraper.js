import { chromium } from 'playwright';
import { createWorker } from 'tesseract.js';
import { supabase } from './db.js';
import dotenv from 'dotenv';
dotenv.config();

const STORE_BASE_URL = process.env.STORE_BASE_URL || 'https://demo.inelabteamdev.com';
const MAX_ATTEMPTS = parseInt(process.env.SCRAPE_MAX_ATTEMPTS || '3', 10);
const RETRY_BASE_MS = parseInt(process.env.SCRAPE_RETRY_BASE_MS || '1500', 10);
const NAV_TIMEOUT_MS = parseInt(process.env.SCRAPE_NAV_TIMEOUT_MS || '20000', 10);
const PRICE_WAIT_MS = parseInt(process.env.SCRAPE_PRICE_WAIT_MS || '12000', 10);
const HEADLESS = process.env.HEADLESS !== 'false';

/**
 * ============================================================================
 * WHY OCR, NOT TEXT SCRAPING, FOR THE PRICE
 * ============================================================================
 * Inspecting the store's DOM revealed two anti-scraping tricks stacked on
 * the price:
 *   1. Decoy hidden spans (e.g. aria-hidden spans with data-price="true")
 *      that hold numbers close to, but different from, the real price. A
 *      scraper that trusts "hidden but conveniently labeled" data gets
 *      confidently wrong numbers.
 *   2. The real visible price is rendered inside an <output> element as a
 *      run of per-digit <span> elements using a custom font, where the
 *      underlying text content does not reliably correspond to the digit
 *      a human sees on screen.
 *
 * Rather than reverse-engineering that font mapping (fragile, and would
 * break silently if the site changes it), we read the price the way a
 * human does: screenshot just that element and OCR it. This is immune to
 * both tricks above, at the cost of a slightly heavier per-scrape step.
 * ============================================================================
 */
const SELECTORS = {
  revealButton: 'button:has-text("REVEAL PRICE"), button:has-text("Reveal Price")',
  refreshButton: 'button:has-text("REFRESH PRICE"), button:has-text("Refresh Price")',
  // The container that wraps the whole price display — verified against the
  // live site: a div whose class includes "price-block".
  priceBlock: '[class*="price-block"]',
  // The real, currently-displayed price — verified: the single <output>
  // element inside the price block (the per-digit scrambled one).
  finalPriceOutput: '[class*="price-block"] output',
  // Product listing card selectors — verified against the live /?page=N grid.
  tile: 'article.tile',
  tileName: '.tile-name',
  tileBrand: '.tile-brand',
  tileCategory: '.tile-category',
  tileSku: '.tile-sku',
};

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function createOcrWorker() {
  const ocrWorker = await createWorker('eng');
  await ocrWorker.setParameters({
    tessedit_char_whitelist: '0123456789.,₹RsINR ',
  });
  return ocrWorker;
}

/**
 * Parses a raw price string like "₹3,614" or "3,614.00" into a clean number.
 * Returns null if it doesn't look like a valid price (this is the guard
 * against ever storing garbage).
 */
function parsePrice(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const num = parseFloat(cleaned);
  if (Number.isNaN(num) || num <= 0) return null;
  return num;
}

/**
 * Parses stock text like "52 IN STOCK", "Out of stock", "Only 3 left" into
 * { inStock: boolean, stockCount: number|null }.
 */
function parseStock(raw) {
  if (!raw) return { inStock: null, stockCount: null };
  const text = raw.toLowerCase();
  if (text.includes('out of stock') || text.includes('unavailable')) {
    return { inStock: false, stockCount: 0 };
  }
  const match = text.match(/(\d+)/);
  const stockCount = match ? parseInt(match[1], 10) : null;
  const inStock = stockCount === null ? text.includes('in stock') : stockCount > 0;
  return { inStock, stockCount };
}

/**
 * Scans visible (non-hidden) elements inside the price block for stock text,
 * ignoring any element the page has deliberately hidden — the same
 * decoy-avoidance principle we apply to the price itself.
 */
async function readStockText(page) {
  return page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector);
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const text = (node.textContent || '').trim();
      // Prefer smaller, leaf-like elements so we get "12 IN STOCK" rather
      // than the entire price block's combined text.
      if (/(\d+\s*in stock)|(\bout of stock\b)/i.test(text) && node.children.length <= 1) {
        return text;
      }
    }
    return null;
  }, SELECTORS.priceBlock);
}

/**
 * Reads the real displayed price via OCR instead of text scraping. See the
 * big comment above SELECTORS for why: the DOM text for the price is
 * deliberately unreliable (decoy hidden spans, scrambled per-digit font).
 * A screenshot shows exactly what a human sees, sidestepping both tricks.
 */
async function readPriceViaOcr(page, ocrWorker) {
  const output = page.locator(SELECTORS.finalPriceOutput).first();
  const priceBlock = page.locator(SELECTORS.priceBlock).first();

  await Promise.race([
    output.waitFor({ state: 'visible', timeout: PRICE_WAIT_MS }).catch(() => null),
    priceBlock.waitFor({ state: 'visible', timeout: PRICE_WAIT_MS }).catch(() => null),
  ]);

  let buffer;
  if (await output.count()) {
    buffer = await output.screenshot().catch(() => null);
  }
  if (!buffer) {
    buffer = await priceBlock.screenshot().catch(() => null);
  }
  if (!buffer) {
    throw new Error('Could not capture the visible price area for OCR');
  }

  // Small pause + screenshot; OCR needs the element fully painted.
  const { data } = await ocrWorker.recognize(buffer);
  return data.text;
}

async function triggerPriceReveal(page) {
  const priceBlock = page.locator(SELECTORS.priceBlock).first();
  const reveal = page.locator(SELECTORS.revealButton).first();
  const refresh = page.locator(SELECTORS.refreshButton).first();

  const priceBlockExists = await priceBlock.count().catch(() => 0);
  if (priceBlockExists) {
    await page.evaluate(() => {
      const block = document.querySelector('[class*="price-block"]');
      const button = Array.from(document.querySelectorAll('button')).find((item) =>
        /reveal price/i.test(item.textContent || ''),
      );
      if (block) {
        const rect = block.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          block.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: x, clientY: y }));
          block.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
          block.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
        }
      }
      if (button) {
        button.removeAttribute('disabled');
        button.disabled = false;
      }
    });
  }

  if (await reveal.isVisible({ timeout: 2000 }).catch(() => false)) {
    await reveal.click({ force: true, timeout: PRICE_WAIT_MS }).catch(() => null);
    return;
  }

  if (await refresh.isVisible({ timeout: 2000 }).catch(() => false)) {
    await refresh.click({ force: true, timeout: PRICE_WAIT_MS }).catch(() => null);
  }
}

/**
 * Does a single scrape attempt against one product page.
 * Throws a descriptive Error on any failure — never returns partial/fake data.
 */
async function scrapeOnce(browser, ocrWorker, product) {
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  try {
    const response = await page.goto(product.product_url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    if (!response || !response.ok()) {
      throw new Error(`Bad HTTP status: ${response ? response.status() : 'no response'}`);
    }

    const acceptCookies = page.locator('button[aria-label="Accept cookies"]').first();
    if (await acceptCookies.isVisible({ timeout: 2000 }).catch(() => false)) {
      await acceptCookies.evaluate((button) => button.click());
    }

    const priceBlock = page.locator(SELECTORS.priceBlock).first();
    await priceBlock.waitFor({ state: 'visible', timeout: PRICE_WAIT_MS });
    const priceBox = await priceBlock.boundingBox();
    if (!priceBox) throw new Error('Price block did not become visible');
    for (let move = 0; move < 10; move++) {
      const x = priceBox.x + priceBox.width * (0.2 + (move % 5) * 0.15);
      const y = priceBox.y + priceBox.height * (0.35 + (move % 2) * 0.3);
      await page.mouse.move(x, y);
      await sleep(50);
    }
    await sleep(700);

    await triggerPriceReveal(page);

    const failureBanner = page.getByText(/couldn.?t load the price/i).first();
    const priceOutput = page.locator(SELECTORS.finalPriceOutput).first();

    await Promise.race([
      priceOutput.waitFor({ state: 'visible', timeout: PRICE_WAIT_MS }).catch(() => null),
      failureBanner.waitFor({ state: 'visible', timeout: PRICE_WAIT_MS }).then(() => {
        throw new Error('Store reported its own price-load failure (challenge_failed or similar)');
      }),
    ]);

    if (await failureBanner.isVisible().catch(() => false)) {
      throw new Error('Store reported its own price-load failure (challenge_failed or similar)');
    }

    await page.waitForFunction(
      () => {
        const output = document.querySelector('[class*="price-block"] output');
        return Boolean(output && output.textContent && output.textContent.trim().length > 0);
      },
      { timeout: PRICE_WAIT_MS },
    ).catch(() => null);

    const priceText = await readPriceViaOcr(page, ocrWorker);
    const stockText = await readStockText(page);

    const price = parsePrice(priceText);
    const { inStock, stockCount } = parseStock(stockText);

    if (price === null) {
      throw new Error(`OCR could not extract a valid price from: "${priceText}"`);
    }

    return { price, inStock, stockCount };
  } finally {
    await context.close();
  }
}

/**
 * Scrapes one product with retries + honest logging. Never writes to
 * price_history unless a full, validated read succeeded.
 */
export async function scrapeProductWithRetry(browser, ocrWorker, product) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const start = Date.now();
    try {
      const result = await scrapeOnce(browser, ocrWorker, product);
      const duration = Date.now() - start;

      await supabase.from('scrape_logs').insert({
        product_id: product.id,
        attempt_number: attempt,
        status: 'success',
        duration_ms: duration,
      });

      await supabase.from('price_history').insert({
        product_id: product.id,
        price: result.price,
        in_stock: result.inStock,
        stock_count: result.stockCount,
      });

      return { ok: true, attempts: attempt };
    } catch (err) {
      lastError = err;
      const duration = Date.now() - start;

      await supabase.from('scrape_logs').insert({
        product_id: product.id,
        attempt_number: attempt,
        status: attempt < MAX_ATTEMPTS ? 'retried' : 'failed',
        duration_ms: duration,
        error_message: String(err.message || err).slice(0, 500),
      });

      if (attempt < MAX_ATTEMPTS) {
        // exponential backoff between attempts
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
      }
    }
  }

  console.error(`[scraper] Product ${product.id} failed after ${MAX_ATTEMPTS} attempts:`, lastError?.message);
  return { ok: false, error: lastError?.message };
}

/**
 * Scrapes every tracked product. Failures in one product never abort the
 * batch — each is isolated in its own try/catch.
 */
export async function scrapeAllTrackedProducts() {
  const { data: products, error } = await supabase.from('products').select('*');
  if (error) throw error;
  if (!products || products.length === 0) {
    return { scraped: 0, results: [] };
  }

  const normalizedProducts = await normalizeTrackedProductUrls(products);

  const browser = await chromium.launch({ headless: HEADLESS });
  const ocrWorker = await createOcrWorker();
  const results = [];

  try {
    for (const product of normalizedProducts) {
      try {
        const result = await scrapeProductWithRetry(browser, ocrWorker, product);
        results.push({ productId: product.id, ...result });
      } catch (err) {
        // Should not normally happen (scrapeProductWithRetry catches internally),
        // but guarantees one product's crash never kills the whole batch.
        console.error(`[scraper] Unexpected error for product ${product.id}:`, err);
        results.push({ productId: product.id, ok: false, error: String(err.message || err) });
      }
    }
  } finally {
    await ocrWorker.terminate();
    await browser.close();
  }

  return { scraped: results.length, results };
}

export async function scrapeTrackedProductById(id) {
  const { data: product, error } = await supabase.from('products').select('*').eq('id', id).single();
  if (error) throw error;
  const [normalized] = await normalizeTrackedProductUrls([product]);
  const browser = await chromium.launch({ headless: HEADLESS });
  const ocrWorker = await createOcrWorker();
  try {
    const result = await scrapeProductWithRetry(browser, ocrWorker, normalized);
    return { product: normalized, ...result };
  } finally {
    await ocrWorker.terminate();
    await browser.close();
  }
}

/**
 * ============================================================================
 * WHY SEARCH CRAWLS AND CACHES THE CATALOG, RATHER THAN QUERYING LIVE
 * ============================================================================
 * The store has no search or filter of its own — every one of its ~1000
 * products is only reachable by paging through `/?page=N` (confirmed: 20
 * products per page, ~50 pages, product URLs are `/product/{id}`). The
 * listing is also JS-rendered, so a plain HTTP fetch returns an empty shell
 * (no product cards exist until the page's JavaScript runs) — this requires
 * Playwright, not cheerio, for this step.
 *
 * Re-crawling all 50 pages on every keystroke would be slow and hammers the
 * store unnecessarily. Instead we crawl the whole catalog once and cache it
 * in Supabase (`catalog` table), and searches just filter that cached list
 * instantly. Call refreshCatalog() once manually (or on a slow schedule,
 * e.g. daily) to keep it up to date; searchProducts() always reads the cache.
 * ============================================================================
 */

const CATALOG_BASE_URL = `${STORE_BASE_URL}/`;
const PRODUCT_URL_PREFIX = `${STORE_BASE_URL}/product`;

function canonicalProductUrl(sku, fallbackUrl = null) {
  const match = String(sku || '').match(/(\d{4,})$/);
  if (!match) return fallbackUrl;

  const productId = Number(match[1]) - 10000;
  return productId > 0 ? `${PRODUCT_URL_PREFIX}/${productId}` : fallbackUrl;
}

async function normalizeTrackedProductUrls(products) {
  return Promise.all(products.map(async (product) => {
    const productUrl = canonicalProductUrl(product.sku, product.product_url);
    if (productUrl === product.product_url) return product;

    const { error } = await supabase
      .from('products')
      .update({ product_url: productUrl })
      .eq('id', product.id);
    if (error) throw error;

    return { ...product, product_url: productUrl };
  }));
}

async function fetchCatalogPage(pageNum, pageSize = 60) {
  let response = null;
  const maxApiAttempts = MAX_ATTEMPTS * 4;
  for (let attempt = 1; attempt <= maxApiAttempts; attempt++) {
    try {
      response = await fetch(`${STORE_BASE_URL}/api/catalog?page=${pageNum}&pageSize=${pageSize}`);
      if (response.ok) break;
      if (attempt === maxApiAttempts) {
        throw new Error(`Catalog API returned HTTP ${response.status}`);
      }
    } catch (error) {
      if (attempt === maxApiAttempts) throw error;
    }
    const retryAfterSeconds = Number(response?.headers.get('retry-after')) || 0;
    const backoffMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
    const throttledDelayMs = response?.status === 429 ? 5000 : 0;
    await sleep(Math.max(backoffMs, throttledDelayMs, retryAfterSeconds * 1000));
  }
  return response.json();
}

function catalogRowFromApi(product) {
  return {
    name: product.name,
    sku: product.sku || null,
    brand: product.brand || null,
    category: product.category || null,
    product_url: `${PRODUCT_URL_PREFIX}/${product.id}`,
  };
}

/**
 * Crawls every page of the store's product listing and upserts each product
 * into the `catalog` table in Supabase. Safe to re-run — later runs just
 * refresh existing rows via upsert on product_url.
 */
export async function refreshCatalog() {
  const productsById = new Map();
  let totalProducts = 0;
  let totalPages = 1;
  let round = 0;

  while (round < 20 && (round === 0 || productsById.size < totalProducts)) {
    round++;
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const payload = await fetchCatalogPage(pageNum);
      totalProducts = Number(payload.total) || totalProducts;
      totalPages = Number(payload.pages) || totalPages;

      for (const product of payload.items || []) {
        if (!product.id || !product.name) continue;
        const row = catalogRowFromApi(product);
        productsById.set(row.product_url, row);
      }
    }
  }

  if (productsById.size === 0) {
    throw new Error('Catalog API returned no products');
  }

  const validProducts = Array.from(productsById.values()).filter((p) => p.product_url);
  const uniqueProducts = Array.from(
    new Map(validProducts.map((product) => [product.product_url, product])).values(),
  );

  if (uniqueProducts.length > 0) {
    const { error } = await supabase
      .from('catalog')
      .upsert(uniqueProducts, { onConflict: 'product_url' });
    if (error) throw error;
  }

  return {
    crawled: productsById.size,
    saved: uniqueProducts.length,
    expected: totalProducts || null,
    complete: totalProducts > 0 ? uniqueProducts.length >= totalProducts : true,
  };
}

async function searchAndCacheLive(query) {
  const needle = (query || '').trim().toLowerCase();
  const matches = [];
  const pending = [];

  if (!needle) {
    const payload = await fetchCatalogPage(1);
    const rows = (payload.items || [])
      .filter((product) => product.id && product.name)
      .map(catalogRowFromApi);
    if (rows.length) {
      await supabase.from('catalog').upsert(rows, { onConflict: 'product_url' });
    }
    return rows.slice(0, 50);
  }

  let pageNum = 1;
  let totalPages = 1;
  while (pageNum <= totalPages && matches.length < 50) {
    const payload = await fetchCatalogPage(pageNum);
    totalPages = Number(payload.pages) || totalPages;
    for (const product of payload.items || []) {
      if (!product.id || !product.name) continue;
      const row = catalogRowFromApi(product);
      pending.push(row);
      const hay = `${row.name} ${row.sku || ''}`.toLowerCase();
      if (hay.includes(needle)) matches.push(row);
    }
    if (pending.length >= 120) {
      await supabase.from('catalog').upsert(pending.splice(0), { onConflict: 'product_url' });
    }
    pageNum++;
  }

  if (pending.length) {
    await supabase.from('catalog').upsert(pending, { onConflict: 'product_url' });
  }

  return matches.slice(0, 50);
}

/**
 * Searches the cached catalog by partial/full product name. If the cache is
 * empty (first run), pages the store's /api/catalog endpoint live so search
 * works without a manual crawl.
 */
export async function searchProducts(query) {
  const needle = (query || '').trim();
  const { count, error: countError } = await supabase
    .from('catalog')
    .select('id', { count: 'exact', head: true });
  if (countError) throw countError;

  if (!count) {
    return searchAndCacheLive(needle);
  }

  let q = supabase.from('catalog').select('*').limit(50);
  if (needle) {
    q = q.ilike('name', `%${needle}%`);
  }
  const { data, error } = await q;
  if (error) throw error;

  if (needle && (!data || data.length === 0)) {
    return searchAndCacheLive(needle);
  }

  return data || [];
}
