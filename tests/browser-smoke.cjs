/* Runs against an isolated browser profile and synthetic mail pages. Never opens a real mailbox. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const extension = path.resolve(__dirname, '..');
const output = path.join(extension, 'artifacts', 'screenshots');
const bundled = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1117/chrome-mac/Chromium.app/Contents/MacOS/Chromium');
const browserPath = process.env.MW_BROWSER_PATH || (fs.existsSync(bundled) ? bundled : undefined);
const stamp = new Date().toISOString();
const gmailRow = (id, title = 'Etsy Conversation with Test Buyer') => `<tr class="zA" data-legacy-message-id="${id}" data-legacy-thread-id="thread-${id}"><td class="yW"><span class="zF" email="conversations@mail.etsy.com">Etsy</span></td><td><span class="bog">${title}</span></td><td class="xW"><span title="${stamp}">Now</span></td></tr>`;
const outlookRow = (id, time = stamp) => `<div role="option" aria-selected="false" data-convid="${id}"><span title="conversations@mail.etsy.com">Etsy</span><span>Etsy Conversation with Test Buyer</span><time datetime="${time}">Now</time></div>`;
const fixtureStyle = '<style>body{font:14px system-ui;background:#f7f8fa;color:#334;padding:35px}header{background:white;padding:20px;margin-bottom:20px}table{background:white;width:70%;border-collapse:collapse}td,[role=option]{padding:20px;border-bottom:1px solid #ddd}[role=listbox]{width:70%;background:white}[role=option] span{margin-right:30px}h1{font-size:22px}</style>';
const gmail = `<!doctype html><meta charset="utf-8">${fixtureStyle}<header><h1>Gmail · 隔离测试页面</h1><a href="https://accounts.google.com/SignOutOptions" aria-label="Google Account: Test (test-shop@gmail.com)">Test account</a></header><main role="main"><table><tbody>${gmailRow('baseline')}</tbody></table></main>`;
const outlook = `<!doctype html><meta charset="utf-8">${fixtureStyle}<header><h1>Outlook · 隔离测试页面</h1><button id="O365_MainLink_Me" aria-label="Account manager for test-shop@outlook.com">Test account</button></header><div role="listbox">${outlookRow('baseline')}</div>`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-sentinel-smoke-'));
  fs.mkdirSync(output, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: browserPath, headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--headless=new', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1440, height: 1080 } });
    context.setDefaultTimeout(15000);
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('https://mail.google.com/**', route => route.fulfill({ contentType: 'text/html', body: gmail }));
    await context.route('https://outlook.live.com/**', route => route.fulfill({ contentType: 'text/html', body: outlook }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const dashboard = await context.newPage(); await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
    await dashboard.locator('#stat-total').waitFor();
    await dashboard.waitForFunction(() => document.querySelector('#device-id').textContent.length > 0);
    await dashboard.screenshot({ path: path.join(output, 'dashboard-empty.png'), fullPage: true });
    const inbox = await context.newPage(); await inbox.goto('https://mail.google.com/mail/u/0/#inbox');
    await inbox.locator('#etsy-sentinel #shop').waitFor({ state: 'visible' });
    await inbox.locator('#etsy-sentinel #shop').fill('测试店铺 · Gmail');
    await inbox.locator('#etsy-sentinel button.primary').click();
    await inbox.waitForFunction(() => document.querySelector('#etsy-sentinel').shadowRoot.querySelector('#status-label').textContent.includes('测试店铺'));
    const command = message => dashboard.evaluate(message => chrome.runtime.sendMessage(message), message);
    let result = await command({ type: 'MW_SCAN' });
    assert.equal(result.state.mailboxes.length, 1); assert.equal(result.state.events.length, 0, 'baseline must not notify');
    await inbox.evaluate(row => document.querySelector('tbody').insertAdjacentHTML('beforeend', row), gmailRow('new-1'));
    result = await command({ type: 'MW_SCAN' });
    assert.equal(result.state.events.length, 1); assert.equal(result.state.events[0].delivery, 'local');
    result = await command({ type: 'MW_SCAN' }); assert.equal(result.state.events.length, 1, 'repeat must deduplicate');
    await inbox.evaluate(() => document.querySelector('tr.zA').classList.toggle('zE'));
    result = await command({ type: 'MW_SCAN' }); assert.equal(result.state.events.length, 1, 'unread change must not notify');
    await inbox.evaluate(row => document.querySelector('tbody').insertAdjacentHTML('beforeend', row), gmailRow('new-2'));
    result = await command({ type: 'MW_SCAN' }); assert.equal(result.state.events.length, 2, 'same subject, different mail must notify');
    await inbox.locator('#etsy-sentinel #collapse').click();
    await inbox.locator('#etsy-sentinel #expand').waitFor({ state: 'visible' }); await inbox.locator('#etsy-sentinel #expand').click();
    await inbox.screenshot({ path: path.join(output, 'gmail-floating-panel.png') });
    const outlookPage = await context.newPage(); await outlookPage.goto('https://outlook.live.com/mail/0/inbox');
    await outlookPage.locator('#etsy-sentinel #shop').waitFor({ state: 'visible' });
    await outlookPage.locator('#etsy-sentinel #shop').fill('测试店铺 · Outlook'); await outlookPage.locator('#etsy-sentinel button.primary').click();
    await outlookPage.waitForFunction(() => document.querySelector('#etsy-sentinel').shadowRoot.querySelector('#status-label').textContent.includes('测试店铺'));
    result = await command({ type: 'MW_SCAN' }); assert.equal(result.state.mailboxes.length, 2);
    assert.equal(result.state.mailboxes.find(b => b.provider === 'outlook').health.code, 'limited');
    await outlookPage.evaluate(row => document.querySelector('[role=listbox]').insertAdjacentHTML('beforeend', row), outlookRow('new-thread'));
    result = await command({ type: 'MW_SCAN' }); assert.equal(result.state.events.length, 3);
    await outlookPage.evaluate(() => document.querySelector('#O365_MainLink_Me').setAttribute('aria-label', 'Account manager for other@outlook.com'));
    result = await command({ type: 'MW_SCAN' });
    assert.equal(result.state.mailboxes.find(b => b.provider === 'outlook').health.code, 'account_mismatch');
    await outlookPage.evaluate(() => document.querySelector('#O365_MainLink_Me').setAttribute('aria-label', 'Account manager for test-shop@outlook.com'));
    await command({ type: 'MW_SCAN' });
    await dashboard.reload(); await dashboard.waitForFunction(() => document.querySelector('#stat-total').textContent === '2');
    await dashboard.screenshot({ path: path.join(output, 'dashboard-monitoring.png'), fullPage: true });
    await dashboard.getByRole('button', { name: '设备与连接' }).click();
    await dashboard.locator('#device-name').fill('工作室 · Chrome'); await dashboard.getByRole('button', { name: '保存设备名称' }).click();
    await dashboard.waitForFunction(() => document.querySelector('#sidebar-device').textContent === '工作室 · Chrome');
    await dashboard.screenshot({ path: path.join(output, 'device-settings.png'), fullPage: true });
    await dashboard.getByRole('button', { name: '邮箱总览' }).click();
    const popup = await context.newPage(); await popup.setViewportSize({ width: 390, height: 650 }); await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.waitForFunction(() => document.querySelector('#popup-total').textContent === '2');
    await popup.screenshot({ path: path.join(output, 'toolbar-popup.png'), fullPage: true });
    await inbox.close(); result = await command({ type: 'MW_SCAN' });
    assert.equal(result.state.mailboxes.find(b => b.provider === 'gmail').health.code, 'closed');
    await outlookPage.evaluate(() => { location.hash = '#other'; });
    // Outlook route classification depends on pathname, not hash. Change it to another folder.
    await outlookPage.evaluate(() => history.replaceState(null, '', '/mail/0/sentitems'));
    result = await command({ type: 'MW_SCAN' });
    assert.equal(result.state.mailboxes.find(b => b.provider === 'outlook').health.code, 'wrong_folder');
    // Leave no external pages open before testing persistence through a browser restart.
    await outlookPage.close();
    await context.close();
    context = await chromium.launchPersistentContext(profile, { executablePath: browserPath, headless: false,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--headless=new', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      viewport: { width: 1440, height: 1080 } });
    const reopened = await context.newPage(); await reopened.goto(`chrome-extension://${id}/dashboard.html`);
    await reopened.waitForFunction(() => document.querySelector('#stat-total').textContent === '2');
    const restored = await reopened.evaluate(() => chrome.runtime.sendMessage({ type: 'MW_STATE' }));
    assert.equal(restored.state.events.length, 3); assert.equal(restored.state.settings.deviceName, '工作室 · Chrome');
    assert.deepEqual(errors, [], 'browser pages must not throw');
    console.log('Browser smoke passed: extension load, both adapters, binding, baseline, deduplication, account switch, closure, folder scope, UI forms, popup and persistence through browser restart.');
    console.log('Screenshots:', output);
  } catch (error) {
    if (context) for (const page of context.pages()) {
      if (page.url().includes('dashboard.html')) console.error('Dashboard diagnostic:', await page.evaluate(async () => ({
        toast: document.querySelector('#toast')?.textContent, hidden: document.hidden,
        response: await chrome.runtime.sendMessage({ type: 'MW_STATE' })
      })).catch(e => e.message));
    }
    throw error;
  } finally {
    if (context) await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
