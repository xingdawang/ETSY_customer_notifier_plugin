/* Synthetic pages only: exercise old content contexts after an extension reload. */
const { chromium } = require('playwright');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.MW_BROWSER_PATH, headless: true });
  try {
    for (const collapsed of [false, true]) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://mail.fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Mailbox fixture</main>' }));
      await page.route('https://extension.fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Connection fixture</main>' }));
      await page.goto('https://mail.fixture.test/');
      await page.evaluate(collapsed => {
        window.fixture = { invalidated: false, transient: false, reports: 0 };
        window.chrome = { runtime: {
          get id() { return fixture.invalidated ? undefined : 'fixture-extension'; },
          getURL(file) {
            if (fixture.invalidated) throw new Error('Extension context invalidated.');
            return 'https://extension.fixture.test/' + file;
          },
          async sendMessage(message) {
            if (fixture.invalidated) throw new Error('Extension context invalidated.');
            if (fixture.transient) throw new Error('Service worker restarting');
            if (message.type === 'MW_REPORT') fixture.reports++;
            return { ok: true, connection: { authenticated: true, status: 'connected', panelCollapsed: collapsed, pollSeconds: 30 } };
          },
          onMessage: { addListener() {} }
        } };
        window.MailWatchAdapters = { read: () => ({ email: 'fixture@example.com', provider: 'outlook', status: 'limited', messages: [] }) };
      }, collapsed);
      await page.addScriptTag({ path: path.resolve(__dirname, '../content.js') });
      await page.waitForFunction(() => fixture.reports > 0);
      assert.equal(await page.locator('#etsy-sentinel #reload-notice').isVisible(), false);
      await page.evaluate(() => { fixture.transient = true; window.dispatchEvent(new Event('online')); });
      assert.equal(await page.locator('#etsy-sentinel #reload-notice').isVisible(), false, 'transient failure must remain retryable');
      await page.evaluate(() => { fixture.transient = false; window.dispatchEvent(new Event('online')); });
      await page.waitForFunction(() => fixture.reports > 1);
      await page.evaluate(() => {
        fixture.invalidated = true;
        const frame = document.querySelector('#etsy-sentinel').shadowRoot.getElementById('connection-frame');
        window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin: 'https://extension.fixture.test',
          data: { type: 'MW_PANEL_HEIGHT', height: 200 } }));
        window.dispatchEvent(new Event('online'));
      });
      await page.locator('#etsy-sentinel #reload-notice').waitFor({ state: 'visible' });
      assert.match(await page.locator('#etsy-sentinel #reload-notice').innerText(), /当前邮箱检测已停止/);
      assert.equal(await page.locator('#etsy-sentinel #connection-frame').isVisible(), false);
      assert.equal(await page.locator('#etsy-sentinel #expand').isVisible(), false);
      assert.equal(await page.locator('#etsy-sentinel button').filter({ hasText: '刷新邮箱页面' }).isVisible(), true);
      assert.deepEqual(errors, [], 'postMessage after invalidation must not call runtime.getURL or throw');
      await page.close();
    }
    console.log('Content lifecycle PASS: invalidated expanded/collapsed panels show refresh action, no stale connected iframe, transient failures recover, no context errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
