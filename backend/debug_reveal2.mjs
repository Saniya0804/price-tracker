import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
const url = 'https://demo.inelabteamdev.com/product/184';

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log('AFTER_GOTO');
const body1 = await page.locator('body').innerText();
console.log(body1.slice(0, 600));

const reveal = page.locator('button:has-text("Reveal price")').first();
console.log('REVEAL_COUNT', await reveal.count());
if (await reveal.count()) {
  console.log('REVEAL_VISIBLE', await reveal.isVisible().catch(() => false));
  await reveal.click();
  console.log('CLICKED');
  await page.waitForTimeout(8000);
  const body2 = await page.locator('body').innerText();
  console.log(body2.slice(0, 800));
  const priceOutput = page.locator('[class*="price-block"] output').first();
  console.log('OUTPUT_COUNT', await priceOutput.count());
  if (await priceOutput.count()) {
    console.log('OUTPUT_TEXT', await priceOutput.textContent().catch(() => 'ERR'));
  }
}

await browser.close();
