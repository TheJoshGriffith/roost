// screenshots.mjs: capture the dashboard for docs. Run INSIDE a roost container
// (it drives the container's own Chromium over CDP with the bundled playwright-core):
//
//   docker cp scripts/screenshots.mjs <container>:/tmp/ && \
//   docker exec -u roost <container> node /tmp/screenshots.mjs /tmp/shots
//
// Use a throwaway container seeded with scripts/seed-demo.sh, never a real one.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { chromium } = require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core');

const out = process.argv[2] || '/tmp/shots';
const base = process.env.ROOST_URL || 'http://127.0.0.1:7680/';
const C1 = '#/chat/claude%3A11111111-1111-4111-8111-111111111111';
const shots = (process.env.SHOTS ? JSON.parse(process.env.SHOTS) : [
  { name: 'desktop-chat-dark', w: 1440, h: 900, scheme: 'dark', route: C1, open: ['Edit'] },
  { name: 'desktop-chat-light', w: 1440, h: 900, scheme: 'light', route: C1, open: ['Edit'] },
  { name: 'phone-chat-dark', w: 390, h: 844, scheme: 'dark', route: C1, mobile: true, open: ['Edit'] },
  { name: 'phone-projects-light', w: 390, h: 844, scheme: 'light', route: '#/projects', mobile: true },
  { name: 'phone-overview-dark', w: 390, h: 844, scheme: 'dark', route: '#/overview', mobile: true },
]);

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
for (const s of shots) {
  const ctx = await browser.newContext({
    viewport: { width: s.w, height: s.h }, deviceScaleFactor: s.mobile ? 2 : 1, colorScheme: s.scheme,
    isMobile: !!s.mobile, hasTouch: !!s.mobile,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + (s.route || ''), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(s.wait || 2500);
  if (s.expandAll) await page.evaluate(() => document.getElementById('expand-all')?.click()).then(() => page.waitForTimeout(400));
  for (const text of s.open || []) { // expand tool cards by their visible text, e.g. "Edit"
    await page.locator('#chat-pane .tc-head', { hasText: text }).first().click().catch(() => {});
    await page.waitForTimeout(300);
  }
  for (const sel of s.click || []) { // click through to a state, e.g. open a sheet
    await page.locator(sel).first().click().catch(() => {});
    await page.waitForTimeout(400);
  }
  if (s.scroll === 'top') await page.evaluate(() => { const el = document.querySelector('#chat-pane .stream'); if (el) el.scrollTop = 0; });
  await page.screenshot({ path: `${out}/${s.name}.png` });
  console.log(`${s.name}: ok${errors.length ? ` (page errors: ${errors.join('; ')})` : ''}`);
  await ctx.close();
}
await browser.close();
