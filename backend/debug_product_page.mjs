import { chromium } from 'playwright';

const url = 'https://demo.inelabteamdev.com/product/184';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
page.on('console', (msg) => console.log('BROWSER_CONSOLE', msg.type(), msg.text()));
page.on('pageerror', (err) => console.log('PAGE_ERROR', err.message));
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('/api/') || u.includes('/challenge') || u.includes('/session') || u.includes('/price')) {
    console.log('REQUEST', req.method(), u);
  }
});
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('/api/') || u.includes('/challenge') || u.includes('/session') || u.includes('/price')) {
    console.log('RESPONSE', res.status(), u);
  }
});

try {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('NAV_STATUS', res && res.status());
  console.log('TITLE', await page.title());
  const reveal = page.locator('button:has-text("Reveal price")').first();
  console.log('REVEAL_COUNT', await reveal.count());
  if (await reveal.count()) {
    console.log('REVEAL_VISIBLE_BEFORE', await reveal.isVisible().catch(() => false));
    await reveal.click();
    console.log('CLICKED_REVEAL');
    await page.waitForTimeout(10000);
    const priceBlock = page.locator('[class*="price-block"]').first();
    console.log('PRICE_BLOCK_EXISTS', await priceBlock.count());
    if (await priceBlock.count()) {
      console.log('PRICE_BLOCK_TEXT', await priceBlock.innerText());
    }
    console.log('BUTTON_TEXT_AFTER', await page.locator('button').allTextContents());
    const output = page.locator('[class*="price-block"] output').first();
    console.log('OUTPUT_COUNT', await output.count());
    if (await output.count()) {
      console.log('OUTPUT_TEXT', await output.textContent().catch(() => 'ERR'));
    }
  }
  console.log('BODY_TEXT_START');
  console.log((await page.locator('body').innerText()).slice(0, 2500));
  console.log('BODY_TEXT_END');
} catch (err) {
  console.error('FINAL_ERROR', err.message);
} finally {
  await browser.close();
}
