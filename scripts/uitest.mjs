// uitest.mjs: drive a real chat through the dashboard UI (Playwright over CDP to the
// container's Chromium). Run inside a roost container against a dashboard instance:
//
//   ROOST_URL=http://127.0.0.1:7699/ node uitest.mjs <project-id> <claude|codex> "<prompt>" <out.png>
//
// It clicks "+ Claude"/"+ Codex" on the project, sends the prompt, approves the first
// permission request, waits for the turn to finish and prints what happened.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { chromium } = require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core');

const [projectId, tool, prompt, shot] = process.argv.slice(2);
const base = process.env.ROOST_URL || 'http://127.0.0.1:7680/';
const model = process.env.MODEL || '';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const log = (...a) => console.log(`[${tool}]`, ...a);

try {
  await page.goto(base + '#/projects', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((id) => typeof App !== 'undefined' && App.data.projects.some((p) => p.id === id), projectId, { timeout: 15000 });
  // Use the project's own "+ Claude" / "+ Codex" button.
  await page.evaluate((id) => { App.view.expanded.add(id); renderTree(); }, projectId);
  const sec = page.locator(`.proj[data-id="${projectId}"]`);
  await sec.locator('.proj-actions button', { hasText: tool === 'codex' ? 'Codex' : 'Claude' }).first().click();
  await page.waitForFunction(() => /#\/chat\/.+:new-/.test(decodeURIComponent(location.hash)), null, { timeout: 5000 });
  log('opened new chat', await page.evaluate(() => decodeURIComponent(location.hash)));
  if (model) await page.evaluate((m) => { App.chats.get(App.view.current).state.model = m; }, model);

  await page.locator('#chat-pane textarea.ta').fill(prompt);
  await page.locator('#chat-pane textarea.ta').press('Enter');
  const t0 = Date.now();

  // Approve every permission request until the turn finishes.
  const deadline = Date.now() + 240000;
  let approvals = 0;
  while (Date.now() < deadline) {
    if (await page.locator('#chat-pane .ev-result').count()) break;
    const allow = page.locator('#chat-pane .perm button', { hasText: /^Allow$/ }).first();
    if (await allow.count()) {
      const what = await page.locator('#chat-pane .perm').first().innerText();
      log('permission card:', what.replace(/\s+/g, ' ').slice(0, 140));
      await allow.click();
      approvals++;
      log('clicked Allow');
      await page.waitForTimeout(500);
      continue;
    }
    await page.waitForTimeout(500);
  }
  log(`approvals: ${approvals}`);
  await page.locator('#chat-pane .ev-result').first().waitFor({ timeout: 180000 });
  await page.waitForTimeout(800);

  const report = await page.evaluate(() => {
    const st = App.chats.get(App.view.current).state;
    return {
      key: App.view.current,
      hash: decodeURIComponent(location.hash),
      status: st.status,
      items: st.items.map((i) => i.kind + (i.kind === 'tool' ? `(${i.tool.name}${i.result ? (i.result.ok ? ':ok' : ':fail') : ':pending'})` : '')).join(' '),
      lastText: [...st.items].reverse().find((i) => i.kind === 'assistant')?.text?.slice(0, 200),
      result: document.querySelector('#chat-pane .ev-result')?.innerText,
      permDone: document.querySelector('#chat-pane .perm-done')?.innerText?.replace(/\s+/g, ' '),
    };
  });
  log(`turn finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(JSON.stringify(report, null, 1));
  if (shot) { await page.screenshot({ path: shot }); log('screenshot', shot); }
} catch (e) {
  log('FAILED:', e.message);
  if (shot) await page.screenshot({ path: shot }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (errors.length) log('page errors:', errors.join(' | '));
  await ctx.close();
  await browser.close();
}
