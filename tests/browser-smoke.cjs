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
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const stamp = new Date().toISOString();
const gmailRow = (id, title = 'Etsy Conversation with Test Buyer') => `<tr class="zA" data-legacy-message-id="${id}" data-legacy-thread-id="thread-${id}"><td class="yW"><span class="zF" email="conversations@mail.etsy.com">Etsy</span></td><td><span class="bog">${title}</span></td><td class="xW"><span title="${stamp}">Now</span></td></tr>`;
const outlookRow = (id, time = stamp) => `<div role="option" aria-selected="false" data-convid="${id}"><span title="conversations@mail.etsy.com">Etsy</span><span>Etsy Conversation with Test Buyer</span><time datetime="${time}">Now</time></div>`;
const fixtureStyle = '<style>body{font:14px system-ui;background:#f7f8fa;color:#334;padding:35px}header{background:white;padding:20px;margin-bottom:20px}table{background:white;width:70%;border-collapse:collapse}td,[role=option]{padding:20px;border-bottom:1px solid #ddd}[role=listbox]{width:70%;background:white}[role=option] span{margin-right:30px}h1{font-size:22px}</style>';
const gmail = `<!doctype html><meta charset="utf-8">${fixtureStyle}<header><h1>Gmail · 隔离测试页面</h1><a href="https://accounts.google.com/SignOutOptions" aria-label="Google Account: Test (test-shop@gmail.com)">Test account</a></header><main role="main"><table><tbody>${gmailRow('baseline')}</tbody></table></main>`;
const outlook = `<!doctype html><meta charset="utf-8">${fixtureStyle}<header><h1>Outlook · 隔离测试页面</h1><button id="O365_MainLink_Me" aria-label="Account manager for test-shop@outlook.com">Test account</button></header><div role="listbox">${outlookRow('baseline')}</div>`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-credential-smoke-'));
  fs.mkdirSync(output, { recursive: true });
  // Ephemeral TLS key for an isolated local fixture. This is never packaged or committed.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(profile, 'key.pem'),
    '-out', path.join(profile, 'cert.pem'), '-subj', '/CN=outlook.live.com', '-days', '1'], { stdio: 'ignore' });
  const central = { heartbeats: [], events: [], token: '', failLogout: false };
  const server = https.createServer({ key: fs.readFileSync(path.join(profile, 'key.pem')), cert: fs.readFileSync(path.join(profile, 'cert.pem')) }, (req, res) => {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
      const body = JSON.parse(text || '{}');
      const reply = (code, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, protocol_version: 2, account: 'plugin-01', device_id: 'provisioned-device-01', ...extra })); };
      if (req.url.endsWith('/login')) {
        if (body.account !== 'plugin-01' || body.password !== 'assigned-test-secret') return reply(401);
        central.token = 'fixture-session-' + Date.now(); return reply(200, { access_token: central.token });
      }
      if (req.headers.authorization !== `Bearer ${central.token}` || body.device_id !== 'provisioned-device-01') return reply(401);
      if (req.url.endsWith('/heartbeat')) { central.heartbeats.push(body); return reply(200); }
      if (req.url.endsWith('/events')) { central.events.push(...body.events); return reply(200, { acknowledged_event_ids: body.events.map(e => e.event_id) }); }
      if (req.url.endsWith('/logout')) return reply(central.failLogout ? 503 : 200);
      reply(404);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `https://outlook.live.com:${server.address().port}`;
  const errors = [];
  const launch = async () => {
    const ctx = await chromium.launchPersistentContext(profile, { executablePath: browserPath, headless: false,
      ignoreDefaultArgs: ['--disable-extensions'], ignoreHTTPSErrors: true,
      args: ['--headless=new', '--no-proxy-server', '--ignore-certificate-errors', '--host-resolver-rules=MAP outlook.live.com 127.0.0.1,MAP mail.google.com 127.0.0.1',
        `--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1150, height: 760 } });
    ctx.setDefaultTimeout(15000);
    ctx.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await ctx.route('https://mail.google.com/**', route => route.fulfill({ contentType: 'text/html', body: gmail }));
    await ctx.route('https://outlook.live.com/mail/**', route => route.fulfill({ contentType: 'text/html', body: outlook }));
    return ctx;
  };
  let context;
  try {
    context = await launch();
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const inbox = await context.newPage(); await inbox.goto('https://mail.google.com/mail/u/0/#inbox');
    const outlookPage = await context.newPage(); await outlookPage.goto('https://outlook.live.com/mail/0/inbox');
    const popup = await context.newPage(); await popup.setViewportSize({ width: 304, height: 480 });
    await popup.goto(`chrome-extension://${id}/connection.html`);
    await popup.locator('#account').waitFor();
    assert.equal(await popup.evaluate(() => !!(document.querySelector('#server').compareDocumentPosition(document.querySelector('#account')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'server address must be above the account');
    await popup.locator('body').screenshot({ path: path.join(output, 'lightweight-login.png') });
    await popup.locator('#account').fill('plugin-01');
    await popup.locator('#server').fill(base);
    await popup.locator('#password').fill('incorrect-fixture-password'); await popup.locator('#login-button').click();
    await popup.locator('#message').filter({ hasText: '凭证无效' }).waitFor();
    assert.equal(await popup.locator('#password').inputValue(), '');
    assert.equal(await popup.locator('#connected').isVisible(), false);
    await popup.locator('#password').fill('assigned-test-secret');
    await popup.locator('#password-eye').click(); assert.equal(await popup.locator('#password').getAttribute('type'), 'text');
    await popup.locator('#login-button').click();
    await popup.locator('#connected').waitFor({ state: 'visible' });
    assert.equal(await popup.locator('#connected-account').textContent(), 'plugin-01');
    assert.equal(await popup.locator('#password').inputValue(), '');
    const read = () => worker.evaluate(async () => (await MailWatchStorage.get('mailwatchState')).mailwatchState);
    const tick = () => worker.evaluate(async () => { await serial(tick); });
    let state = await read(); assert.equal(state.mailboxes.length, 2); assert.equal(state.events.length, 0);
    assert.equal(JSON.stringify(state).includes('assigned-test-secret'), false);
    await inbox.evaluate(row => document.querySelector('tbody').insertAdjacentHTML('beforeend', row), gmailRow('new-1'));
    await tick(); state = await read();
    assert.equal(state.events.length, 1); assert.equal(state.events[0].delivery, 'uploaded'); assert.equal(central.events.length, 1);
    await tick(); assert.equal(central.events.length, 1, 'repeat scan must not upload duplicates');
    await outlookPage.evaluate(row => document.querySelector('[role=listbox]').insertAdjacentHTML('beforeend', row), outlookRow('new-thread'));
    await tick(); assert.equal(central.events.length, 2); assert.equal(central.events[1].shop, undefined);
    const panel = inbox.frameLocator('#etsy-sentinel iframe');
    await panel.locator('#connected').waitFor({ state: 'visible' });
    assert.doesNotMatch(await panel.locator('body').innerText(), /店铺|立即检查|管理邮箱|网页状态|监听中/);
    assert.equal(await inbox.evaluate(() => { try { return document.querySelector('#etsy-sentinel').shadowRoot.querySelector('iframe').contentDocument?.querySelector('#password')?.value; } catch (_) { return undefined; } }), undefined, 'mail page cannot read the cross-origin password field');
    await inbox.screenshot({ path: path.join(output, 'lightweight-connected-panel.png') });
    await inbox.bringToFront();
    await inbox.locator('#etsy-sentinel #collapse').click();
    const bubble = inbox.locator('#etsy-sentinel #expand');
    await bubble.waitFor({ state: 'visible' }); assert.equal(await bubble.textContent(), '哨');
    async function dragBubble(x, y) {
      const start = await bubble.boundingBox();
      await inbox.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await inbox.mouse.down(); await inbox.mouse.move(x, y, { steps: 12 }); await inbox.mouse.up();
      assert.equal(await bubble.isVisible(), true, 'drag must not expand the panel');
      return bubble.boundingBox();
    }
    let dragged = await dragBubble(150, 230);
    assert.ok(Math.abs(dragged.x - 127) < 2 && Math.abs(dragged.y - 207) < 2);
    await bubble.click(); await inbox.locator('#etsy-sentinel iframe').waitFor({ state: 'visible' });
    await inbox.locator('#etsy-sentinel #collapse').click();
    let restoredBubble = await bubble.boundingBox(); assert.ok(Math.abs(restoredBubble.x - dragged.x) < 2);
    dragged = await dragBubble(1148, 758);
    assert.ok(dragged.x >= 0 && dragged.y >= 0 && dragged.x + dragged.width <= 1150 && dragged.y + dragged.height <= 760);
    await inbox.setViewportSize({ width: 360, height: 300 });
    await inbox.waitForFunction(() => {
      const rect = document.querySelector('#etsy-sentinel').shadowRoot.querySelector('#expand').getBoundingClientRect();
      return rect.right <= innerWidth && rect.bottom <= innerHeight;
    });
    restoredBubble = await bubble.boundingBox();
    assert.ok(restoredBubble.x + restoredBubble.width <= 360 && restoredBubble.y + restoredBubble.height <= 300, 'resize keeps bubble reachable');
    await bubble.click();
    const expanded = await inbox.locator('#etsy-sentinel iframe').boundingBox();
    assert.ok(expanded.x >= 0 && expanded.y >= 0 && expanded.x + expanded.width <= 360 && expanded.y + expanded.height <= 300, 'expanded panel remains within the viewport');
    await inbox.locator('#etsy-sentinel #collapse').click();
    await inbox.setViewportSize({ width: 1150, height: 760 });
    await inbox.reload(); await bubble.waitFor({ state: 'visible' });
    restoredBubble = await bubble.boundingBox();
    assert.ok(Math.abs(restoredBubble.x - dragged.x) < 2 && Math.abs(restoredBubble.y - dragged.y) < 2, 'reload restores saved bubble position');
    await inbox.screenshot({ path: path.join(output, 'draggable-bubble.png') });
    await bubble.click();
    await popup.locator('body').screenshot({ path: path.join(output, 'lightweight-connected.png') });
    await inbox.close(); await tick();
    const health = central.heartbeats.at(-1).mailboxes.find(b => b.provider === 'gmail'); assert.equal(health.status, 'closed');
    central.failLogout = true;
    await popup.locator('#logout-button').click(); await popup.locator('#login-form').waitFor({ state: 'visible' });
    state = await read(); assert.equal(state.connection.token, '');
    central.failLogout = false;
    await popup.locator('#password').fill('assigned-test-secret'); await popup.locator('#login-button').click();
    await popup.locator('#connected').waitFor({ state: 'visible' });
    await outlookPage.close();
    await context.close(); context = await launch();
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const reopened = await context.newPage(); await reopened.goto(`chrome-extension://${id}/connection.html`);
    await reopened.locator('#connected').waitFor({ state: 'visible' });
    const restored = await worker.evaluate(async () => (await MailWatchStorage.get('mailwatchState')).mailwatchState);
    assert.equal(restored.connection.account, 'plugin-01'); assert.equal(restored.events.length, 2);
    assert.deepEqual(errors, []);
    console.log('Browser smoke passed: minimal credential UI, real local TLS login/heartbeat/events, invalid credentials, password isolation, auto-discovery, both adapters, deduplication, closure, offline logout, draggable 哨 bubble, bounds, saved position and restart persistence.');
    console.log('Screenshots:', output);
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
