import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
page.on('console', (msg) => console.log('BROWSER', msg.type(), msg.text()));
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('/api/') || url.includes('/challenge') || url.includes('/session') || url.includes('/price')) {
    console.log('REQUEST', req.method(), url);
  }
});
page.on('response', (res) => {
  const url = res.url();
  if (url.includes('/api/') || url.includes('/challenge') || url.includes('/session') || url.includes('/price')) {
    console.log('RESPONSE', res.status(), url);
  }
});

const url = 'https://demo.inelabteamdev.com/product/184';
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
const reveal = page.locator('button:has-text("Reveal price")').first();
console.log('visible before click', await reveal.isVisible().catch(() => false));
await reveal.click();
console.log('clicked reveal');
for (let i = 1; i <= 15; i++) {
  await page.waitForTimeout(1000);
  console.log('tick', i);
  const text = await page.locator('body').innerText();
  console.log(text.slice(0, 500).replace(/\s+/g, ' '));
  const output = page.locator('[class*="price-block"] output').first();
  const outputCount = await output.count();
  console.log('outputCount', outputCount);
  if (outputCount) {
    console.log('outputText', await output.textContent().catch(() => 'ERR'));
  }
}
await browser.close();
