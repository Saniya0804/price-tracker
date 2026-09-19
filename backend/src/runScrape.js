import { scrapeAllTrackedProducts } from './scraper.js';

const result = await scrapeAllTrackedProducts();
console.log('SCRAPE_RESULT');
console.log(JSON.stringify(result, null, 2));
