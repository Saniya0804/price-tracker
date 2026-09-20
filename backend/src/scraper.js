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
  revealButton: /reveal price/i,
  refreshButton: /refresh price/i,
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

  try {
    await output.waitFor({ state: 'visible', timeout: PRICE_WAIT_MS });
  } catch (err) {
    // Diagnostic capture: rather than guess again at why the price never
    // appeared, grab what's actually in the price block right now so the
    // scrape_logs entry tells us definitively (button text present, error
    // banner, still showing "Price hidden", etc.) instead of a bare timeout.
    const diagnostic = await page
      .locator(SELECTORS.priceBlock)
      .first()
      .innerHTML()
      .catch(() => '(could not read price block HTML)');
    const trimmed = diagnostic.replace(/\s+/g, ' ').slice(0, 400);
    throw new Error(`Price never appeared. Price block contents at failure: ${trimmed}`);
  }

  // Small pause + screenshot; OCR needs the element fully painted.
  const buffer = await output.screenshot();
  const { data } = await ocrWorker.recognize(buffer);
  return data.text;
}

/**
 * Does a single scrape attempt against one product page.
 * Throws a descriptive Error on any failure — never returns partial/fake data.
 */
async function scrapeOnce(browser, ocrWorker, product) {
  // A smaller viewport means less to render/screenshot, trimming memory
  // further on a constrained free-tier instance.
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
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

    const failureBanner = page.getByText(/couldn.?t load (?:this product|the price)/i).first();
    if (await failureBanner.isVisible({ timeout: 2000 }).catch(() => false)) {
      const failureText = (await failureBanner.innerText().catch(() => '')).trim();
      throw new Error(`Store reported a product/price failure: ${failureText || 'unknown error'}`);
    }

    // Click "Reveal Price" if present (first visit); if it's a "Refresh
    // Price" button instead (already revealed), click that to force a fresh read.
    //
    // Both buttons start disabled — the page's own text says "Hover over
    // the price area to load the current price," meaning a genuine hover
    // (with some dwell time) is what enables the button, not just a single
    // instantaneous hover call followed immediately by a click attempt.
    const priceBlock = page.locator(SELECTORS.priceBlock).first();
    const actionButton = page.locator('button', { hasText: /reveal price|refresh price/i }).first();

    if (await actionButton.isVisible({ timeout: 8000 }).catch(() => false)) {
      // Hover with a longer, more realistic dwell — small back-and-forth
      // movement over a few seconds, rather than one static hover — in case
      // the site expects genuine ongoing pointer presence, not just a single
      // instantaneous hover event.
      const box = await actionButton.boundingBox().catch(() => null);
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        for (let i = 0; i < 6; i++) {
          await page.mouse.move(cx + (i % 2 === 0 ? -2 : 2), cy, { steps: 5 });
          await sleep(400);
        }
      } else {
        await priceBlock.hover({ force: true }).catch(() => {});
      }

      // Actively wait for the disabled attribute to actually clear, rather
      // than assuming hovering instantly enabled it. Kept short (5s) so a
      // genuinely stuck button doesn't consume most of the attempt budget.
      const enabledHandle = await actionButton.elementHandle().catch(() => null);
      if (enabledHandle) {
        await page
          .waitForFunction((btn) => btn && !btn.disabled, enabledHandle, { timeout: 5000 })
          .catch(() => {
            // Still disabled after a genuine hover attempt — proceed anyway;
            // the click below will fail fast (short timeout) and the
            // diagnostic in readPriceViaOcr will capture the true state.
          });
      }

      await actionButton.click({ timeout: 3000 }).catch(() => {
        // Some product variants may load purely from the hover itself,
        // without ever allowing a real click. Don't hard-fail here — let
        // execution continue to wait for the price; if it never appears,
        // the diagnostic below still captures the real reason honestly.
      });
    }

    // The store can show an explicit product or price failure instead of the
    // price output. Detect it before waiting for the output so logs preserve
    // the real store error rather than a misleading selector timeout.
    if (await failureBanner.isVisible({ timeout: 2000 }).catch(() => false)) {
      const failureText = (await failureBanner.innerText().catch(() => '')).trim();
      throw new Error(`Store reported a product/price failure: ${failureText || 'unknown error'}`);
    }

    const pageText = await page.locator('body').innerText();
    if (/jwt issued at future|challenge failed|rate limit|too many requests/i.test(pageText)) {
      throw new Error(`Store challenge failed: ${pageText.match(/.{0,80}(?:JWT issued at future|challenge failed|rate limit|too many requests).{0,120}/i)?.[0] || 'unknown challenge error'}`);
    }

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
        status: attempt === 1 ? 'success' : 'retried',
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

  // Render's free tier has ~512MB RAM. Default Chromium's multi-process
  // architecture plus its GPU/extension overhead can exceed that when
  // combined with OCR, causing the OS to hard-kill the process — which
  // bypasses our own try/catch entirely (the scrape just silently vanishes,
  // no "failed" log gets written). These flags trade a little stability for
  // a much smaller memory footprint, appropriate for this constraint.
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--mute-audio',
      '--no-first-run',
    ],
  });
  // One OCR worker reused for the whole batch — creating a new one per
  // product would reload the language model every time and be far slower.
  const ocrWorker = await createWorker('eng');
  const results = [];

  try {
    for (const product of products) {
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

/**
 * ============================================================================
 * WHY SEARCH CRAWLS AND CACHES THE CATALOG, RATHER THAN QUERYING LIVE
 * ============================================================================
 * The store has no search or filter of its own — its ~1000 products are
 * only reachable by paging through a listing. The store does, however,
 * expose a plain JSON catalog API (`/api/catalog?page=N&pageSize=60`),
 * found by inspecting network requests — no browser needed for this part.
 *
 * Re-fetching all pages on every keystroke would be slow, so we crawl the
 * whole catalog periodically and cache it in Supabase's `catalog` table;
 * searchProducts() always reads that cache.
 *
 * Reliability notes — this API is deliberately flaky like the rest of the
 * store (intermittent 429/503, and some individual items missing fields):
 *  - A page that fails after its own retries is skipped and logged, not
 *    treated as a fatal error for the whole run. Throwing away 999 good
 *    products because 1 was momentarily unavailable would be a worse bug
 *    than the flakiness itself.
 *  - Only pages that had problems get one retry pass; the whole catalog is
 *    not re-fetched repeatedly, since that's what was triggering 429s.
 *  - A short pause between requests paces us under the store's rate limit.
 * ============================================================================
 */

const PRODUCT_URL_PREFIX = `${STORE_BASE_URL}/product`;

async function fetchCatalogPage(pageNum) {
  const maxApiAttempts = MAX_ATTEMPTS * 2;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxApiAttempts; attempt++) {
    try {
      const response = await fetch(`${STORE_BASE_URL}/api/catalog?page=${pageNum}&pageSize=60`);
      if (response.ok) return await response.json();
      lastErr = new Error(`HTTP ${response.status}`);
      const retryAfterSeconds = Number(response.headers.get('retry-after')) || 0;
      const throttledDelayMs = response.status === 429 ? 4000 : 0;
      await sleep(Math.max(RETRY_BASE_MS * Math.pow(2, attempt - 1), throttledDelayMs, retryAfterSeconds * 1000));
    } catch (err) {
      lastErr = err;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

/**
 * Crawls the store's catalog API and upserts every valid product found into
 * the `catalog` table. Always saves what it successfully collected, even if
 * some pages ultimately failed — see reliability notes above.
 */
export async function refreshCatalog() {
  const productsById = new Map();
  const problemPages = [];
  let totalPages = 1;

  function ingest(payload) {
    totalPages = Number(payload.pages) || totalPages;
    const items = payload.items || [];
    let validCount = 0;
    for (const product of items) {
      if (!product.id || !product.name) continue;
      validCount++;
      productsById.set(String(product.id), {
        name: product.name,
        sku: product.sku || null,
        brand: product.brand || null,
        category: product.category || null,
        product_url: `${PRODUCT_URL_PREFIX}/${product.id}`,
      });
    }
    return validCount < items.length; // true if this page had some bad items
  }

  // Pass 1: every page once.
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      const hadIssues = ingest(await fetchCatalogPage(pageNum));
      if (hadIssues) problemPages.push(pageNum);
    } catch (err) {
      console.warn(`[catalog] page ${pageNum} failed: ${err.message}`);
      problemPages.push(pageNum);
    }
    await sleep(300); // pace requests, don't trip the rate limiter ourselves
  }

  // Pass 2: retry only the pages that had trouble, once.
  for (const pageNum of [...new Set(problemPages)]) {
    try {
      ingest(await fetchCatalogPage(pageNum));
    } catch (err) {
      console.warn(`[catalog] page ${pageNum} failed again, skipping: ${err.message}`);
    }
    await sleep(300);
  }

  const uniqueProducts = Array.from(
    new Map(Array.from(productsById.values()).map((p) => [p.product_url, p])).values()
  );

  if (uniqueProducts.length === 0) {
    throw new Error('Catalog refresh got zero valid products — store may be down or its API changed');
  }

  const { error } = await supabase.from('catalog').upsert(uniqueProducts, { onConflict: 'product_url' });
  if (error) throw error;

  return { saved: uniqueProducts.length, pagesWithIssues: [...new Set(problemPages)].length };
}

/**
 * Searches the cached catalog by partial/full product name. Does NOT hit
 * the live store — see refreshCatalog() for how the cache is populated.
 */
export async function searchProducts(query) {
  let q = supabase.from('catalog').select('*').limit(50);
  if (query) {
    q = q.ilike('name', `%${query}%`);
  }
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
/**
 * Scrapes a single tracked product by its id (used by routes that trigger a
 * scrape for one product on demand, e.g. a "scrape now" button).
 */
export async function scrapeTrackedProductById(productId) {
  const { data: product, error } = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .single();
  if (error) throw error;
  if (!product) throw new Error(`Product ${productId} not found`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--mute-audio',
      '--no-first-run',
    ],
  });
  const ocrWorker = await createWorker('eng');

  try {
    return await scrapeProductWithRetry(browser, ocrWorker, product);
  } finally {
    await ocrWorker.terminate();
    await browser.close();
  }
}