# Design Note

## What the store actually does

Inspecting the product page in devtools showed that price is not present in
the initial HTML. Clicking "Reveal Price" triggers three sequential requests:

1. `GET /api/challenge` → returns a salt, timestamp, a difficulty level, a
   signature, and a base64-encoded WebAssembly module. The WASM module is a
   proof-of-work hash function: the client must brute-force a nonce whose
   hashed output has a required number of leading zero bits before it's
   allowed to proceed.
2. `POST /api/session` → the solved nonce plus the original challenge fields
   are exchanged for a short-lived session token.
3. `GET /api/products/:id/price` → returns an encrypted payload (`e`), not a
   plain price — the real numbers are decrypted client-side by JavaScript
   shipped in the page bundle.

Inspecting the rendered DOM after the price loads revealed a second,
independent layer of anti-scraping on top of the above:

- **Decoy hidden values.** The page includes elements like
  `<span aria-hidden="true" style="display:none" data-price="true">₹35,740</span>`
  sitting right next to the real price — deliberately labeled to look like a
  convenient shortcut for a scraper, but holding a number close to, but
  different from, the actual displayed price. A scraper that trusts hidden
  "helpfully labeled" data gets a confidently wrong answer.
- **Scrambled visible digits.** The real, correct price is rendered inside an
  `<output>` element as a run of per-digit `<span>` elements using a custom
  font. In the DOM inspector these render as unrelated glyphs — a strong
  signal that the underlying text content of each span does not correspond
  to the digit a human sees rendered on screen, so reading `textContent`
  here would also silently produce wrong data.

## Reading the price via OCR instead of text

Given both tricks target *text-based* reading of the DOM, the scraper instead
screenshots just the price `<output>` element with Playwright and runs OCR
(tesseract.js) on that image. This reads the price the same way a human eye
does — from the rendered glyphs — which is unaffected by decoy hidden nodes
(never visible, so never screenshotted) or by scrambled text codepoints
(irrelevant to OCR, which only sees pixels). Stock text is read with a
similar "trust only what's actually visible" rule: the scraper walks visible
elements only (skipping anything `display:none` or `visibility:hidden`)
looking for stock-related text, rather than trusting any specific class name
or hidden attribute.

## Reliability approach

- **Headless browser over raw HTTP replication.** I could have reimplemented
  the challenge/session/price handshake directly in Node (WASM execution is
  supported there too), but reverse-engineering the client-side decryption of
  the `e` payload has no guaranteed payoff and would be brittle against any
  change to the encryption scheme. Playwright lets the page's own code do
  the handshake and decryption exactly as intended, which is far more robust
  against unannounced changes — directly in line with "reach for a headless
  browser only where the page genuinely requires it." This page does.
- **Poll for the real value, don't sleep-and-hope.** Instead of a fixed
  delay after clicking reveal, the scraper uses `waitForFunction` to poll
  until the price element actually contains a numeric value, up to a
  timeout. This handles both fast responses and the store's occasional slow
  responses without wasting time or failing prematurely.
- **Retries with exponential backoff, capped at 3 attempts.** Every attempt
  — success, retried, or failed — is logged with a timestamp, duration, and
  error message so the log is a true record of what happened, not just the
  final outcome.
- **Validation before writing history.** A price is only ever persisted if it
  parses to a positive number; stock is normalized into a boolean plus an
  optional count. If validation fails, nothing is written to `price_history`
  — only the failure is logged. This guarantees the price chart never shows
  a fabricated or zero value caused by a broken scrape.
- **Per-product isolation.** Each tracked product is scraped in its own
  try/catch inside the batch loop, so one product's failure (e.g. its page
  structure changed) cannot stop the rest of the batch from running.
- **External cron over an in-process timer.** Render's free tier sleeps the
  instance when idle, so scheduling lives outside the app (cron-job.org
  calling `/api/scrape/run` every 2 hours) rather than a `setInterval` that
  would silently stop once the instance sleeps.

## Trade-offs (OCR specifically)

- OCR adds real per-scrape cost (roughly 200-500ms plus the one-time language
  model load, shared once per batch run rather than per product) and a small
  chance of misread digits versus a perfect text extraction. In exchange it
  is immune to both anti-scraping tricks found on this page and does not
  depend on reverse-engineering a font mapping that the site could change at
  any time. Given the assignment's priority on the scraper "never storing
  wrong data," trading some speed for correctness here was the right call.
- The price is still validated after OCR (must parse to a positive number);
  if OCR produces garbage, that scrape attempt is treated as a failure and
  retried rather than stored.

## Trade-offs (general)

- Using a full browser per scrape is heavier (memory, ~2-5s per product) than
  a raw HTTP replication would be, but trades that cost for resilience
  against the site's obfuscation changing.
- Search first reads a Supabase `catalog` cache. If that cache is empty, the
  API pages `GET /api/catalog` on the live store, filters by name/SKU, and
  writes what it saw back to the cache so the next search is instant.
- Selectors for the final price / stock badge are based on visual
  inspection rather than guaranteed stable test IDs; if the store ships a
  `data-testid` attribute, that should be preferred (already included as a
  fallback in the selector list) for future-proofing against style changes.
- The proof-of-work difficulty (3) resolves in roughly a millisecond of CPU
  time when solved directly, so it adds negligible latency; a browser
  executing it via WASM is only marginally slower.

## What AI tooling got wrong on the first pass, and how it was corrected

- An initial plan assumed the price would be visible in the server-rendered
  HTML (a typical scraping assumption) and proposed cheerio/HTTP-only
  scraping for the whole app. Inspecting the actual Network requests
  disproved this — the price is gated behind a proof-of-work challenge and
  returned encrypted, which is not visible from a first glance at the
  rendered page. The plan was corrected to use a headless browser
  specifically for the price/stock read, while keeping lightweight
  HTTP+HTML parsing for the product listing/search, which genuinely doesn't
  need a browser.
- An initial retry design logged only the final outcome of a scrape. This
  was corrected to log every individual attempt (including intermediate
  retries), since the assignment explicitly requires the log to show retried
  attempts, not just pass/fail.
