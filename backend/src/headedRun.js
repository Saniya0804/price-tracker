/**
 * Run with: npm run scrape:headed
 * Opens a REAL, visible browser window and scrapes every tracked product,
 * printing each step. Use this to record the required demo video.
 *
 * To visibly demonstrate failure/retry handling for the recording, you can
 * temporarily lower SCRAPE_NAV_TIMEOUT_MS in your .env to something small
 * (e.g. 500ms) right before running this — it will force a timeout on the
 * first attempt and show the retry logic firing on camera. Set it back
 * afterwards.
 */
import { chromium } from 'playwright';
import { supabase } from './db.js';
import { createOcrWorker, scrapeProductWithRetry } from './scraper.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const { data: products, error } = await supabase.from('products').select('*');
  if (error) throw error;

  if (!products || products.length === 0) {
    console.log('No tracked products found. Track one via the app first.');
    return;
  }

  const browser = await chromium.launch({ headless: false, slowMo: 250 });
  const ocrWorker = await createOcrWorker();

  for (const product of products) {
    console.log(`\n=== Scraping: ${product.name} (${product.product_url}) ===`);
    const result = await scrapeProductWithRetry(browser, ocrWorker, product);
    console.log('Result:', result);
  }

  await ocrWorker.terminate();
  await browser.close();
}

main().catch((err) => {
  console.error('Headed run failed:', err);
  process.exit(1);
});
