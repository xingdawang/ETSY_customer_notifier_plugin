const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const C = require('../core.js');
async function worker(seed = {}) {
  const store = structuredClone(seed), listeners = {}, requests = [], reports = new Map(), tabs = [];
  const event = name => ({ addListener: fn => { listeners[name] = fn; } });
  const api = { alarms: { get: async () => ({}), create: async () => {}, onAlarm: event('alarm') },
    runtime: { id: 'test-extension', getURL: value => `chrome-extension://test-extension/${value}`, onMessage: event('message'), onStartup: event('startup'), onInstalled: event('install') },
    permissions: { contains: async () => true },
    tabs: { query: async () => tabs, get: async id => tabs.find(t => t.id === id),
      sendMessage: async (id, message) => message.type === 'MW_DOCUMENT_INFO' ? { ok: true, ...reports.get(id) } : { ok: true, report: reports.get(id) },
      onRemoved: event('removed'), onUpdated: event('updated') } };
  const ok = (account = 'plugin-01', device = 'device-01', extra = {}) => new Response(JSON.stringify({ ok: true, protocol_version: 2, account, device_id: device, ...extra }));
  let fetcher = async (url, options) => {
    const body = JSON.parse(options.body);
    return ok(body.account, body.account === 'plugin-02' ? 'device-02' : 'device-01', url.endsWith('/login') ? { access_token: 'session-token' } : url.endsWith('/events') ? { acknowledged_event_ids: body.events.map(e => e.id) } : {});
  };
  const context = vm.createContext({ chrome: api, crypto: webcrypto, TextEncoder, URL, AbortSignal, setTimeout,
    fetch: async (url, options) => { requests.push({ url, options, body: JSON.parse(options.body) }); return fetcher(url, options); } });
  context.importScripts = (...files) => files.forEach(file => {
    if (file === 'storage.js') context.MailWatchStorage = { get: async key => ({ [key]: structuredClone(store[key]) }), set: async data => Object.assign(store, structuredClone(data)) };
    else vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
  vm.runInContext('globalThis.testing = {ready,handle,sync,scanTabs,tick,flush:()=>operation}', context);
  await context.testing.ready;
  return { ...context.testing, store, tabs, reports, requests, listeners, api, ok,
    ui: { id: 'test-extension', url: 'chrome-extension://test-extension/connection.html' },
    mail: { id: 'test-extension', frameId: 0, url: 'https://mail.google.com/mail/u/0/#inbox', tab: { id: 1 } },
    setFetch: fn => { fetcher = fn; }, state: () => store.mailwatchState };
}
const login = (w, account = 'plugin-01') => w.handle({ type: 'MW_LOGIN', server: 'https://example.test', account, password: 'provisioned-secret' }, w.ui);

test('plugin credential is verified by the central server and password is not persisted', async () => {
  const w = await worker(); const result = await login(w);
  assert.equal(result.connection.status, 'connected'); assert.equal(result.connection.account, 'plugin-01');
  assert.equal(w.requests[0].body.password, 'provisioned-secret'); assert.ok(w.requests[0].body.installation_id);
  assert.equal(JSON.stringify(w.store).includes('provisioned-secret'), false);
  assert.equal(JSON.stringify(result).includes('session-token'), false);
});
test('mailbox-origin scripts cannot submit device passwords', async () => {
  const w = await worker(); await assert.rejects(w.handle({ type: 'MW_LOGIN', server: 'https://example.test', account: 'plugin-01', password: 'x' }, w.mail), /凭证面板/);
  assert.equal(w.requests.length, 0);
});
test('wrong credentials cannot create a connected state', async () => {
  const w = await worker(); w.setFetch(async () => new Response('', { status: 401 }));
  await assert.rejects(login(w), /凭证无效/); assert.equal(C.active(w.state()), false);
});
test('legacy website login responses are rejected, even if ok is true', async () => {
  const w = await worker(); w.setFetch(async () => new Response(JSON.stringify({ ok: true, username: 'plugin-01', token: 'old' })));
  await assert.rejects(login(w), /凭证接口/); assert.equal(C.active(w.state()), false);
});
test('the server must confirm the submitted device account', async () => {
  const w = await worker(); w.setFetch(async () => w.ok('wrong-account', 'device-01', { access_token: 'token' }));
  await assert.rejects(login(w), /正确的插件身份/); assert.equal(C.active(w.state()), false);
});
test('public connection omits mailbox states, tokens, challenges and event queues', async () => {
  const w = await worker(); await login(w);
  w.state().connection.challenge = { nonce: 'secret-challenge' };
  const result = await w.handle({ type: 'MW_CONNECTION' }, w.mail);
  assert.equal(JSON.stringify(result).includes('session-token'), false); assert.equal(JSON.stringify(result).includes('secret-challenge'), false);
  assert.equal(result.mailboxes, undefined); assert.equal(result.events, undefined);
});
test('logout stops local detection even when central logout is unreachable', async () => {
  const w = await worker(); await login(w);
  w.state().events = [{ id: 'queued', owner: w.state().connection.owner, delivery: 'pending' }];
  w.setFetch(async () => { throw new Error('network offline'); });
  const result = await w.handle({ type: 'MW_LOGOUT' }, w.ui);
  assert.equal(result.connection.authenticated, false); assert.equal(w.state().events.length, 1); assert.equal(w.state().connection.token, '');
});
test('switching device credentials never uploads another identity’s pending events', async () => {
  const w = await worker(); await login(w); const owner = w.state().connection.owner;
  w.state().events = [{ id: 'old-event', owner, delivery: 'pending', attempts: 0 }];
  await w.handle({ type: 'MW_LOGOUT' }, w.ui); await login(w, 'plugin-02');
  assert.equal(w.state().events[0].delivery, 'pending'); assert.notEqual(w.state().connection.owner, owner);
  assert.equal(w.requests.filter(r => r.url.endsWith('/events')).length, 0);
  await w.handle({ type: 'MW_LOGOUT' }, w.ui); await login(w);
  assert.equal(w.state().events[0].delivery, 'uploaded');
});
test('explicit acknowledgements are required before an event leaves pending', async () => {
  const w = await worker(); await login(w); const owner = w.state().connection.owner;
  w.state().events = [{ id: 'event', owner, delivery: 'pending', attempts: 0 }];
  w.setFetch(async url => w.ok('plugin-01', 'device-01', url.endsWith('/events') ? { acknowledged_event_ids: ['unrelated'] } : {}));
  await w.sync(w.state(), true); assert.equal(w.state().events[0].delivery, 'pending');
  w.setFetch(async url => w.ok('plugin-01', 'device-01', url.endsWith('/events') ? { acknowledged_event_ids: ['event'] } : {}));
  await w.sync(w.state(), true); assert.equal(w.state().events[0].delivery, 'uploaded');
});
test('a central identity mismatch never acknowledges an upload', async () => {
  const w = await worker(); await login(w);
  w.state().events = [{ id: 'event', owner: w.state().connection.owner, delivery: 'pending', attempts: 0 }];
  w.setFetch(async url => url.endsWith('/events') ? w.ok('plugin-01', 'other-device', { acknowledged_event_ids: ['event'] }) : w.ok());
  await w.sync(w.state(), true); assert.equal(w.state().events[0].delivery, 'pending');
});
test('rate limits back off and the next heartbeat is newly generated', async () => {
  const w = await worker(); await login(w); w.requests.length = 0;
  w.setFetch(async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
  const before = Date.now(); await w.sync(w.state(), true);
  assert.ok(w.state().connection.retryAt >= before + 120000);
  await w.sync(w.state()); assert.equal(w.requests.length, 1);
  w.setFetch(async () => w.ok()); await w.sync(w.state(), true);
  assert.equal(w.requests[1].body.sequence, w.requests[0].body.sequence + 1);
});
test('central revocation requires credentials again and leaves pending events intact', async () => {
  const w = await worker(); await login(w); w.state().events = [{ id: 'queued', owner: w.state().connection.owner, delivery: 'pending' }];
  w.setFetch(async () => new Response('', { status: 403 })); await w.sync(w.state(), true);
  assert.equal(w.state().connection.status, 'auth_required'); assert.equal(C.active(w.state()), false); assert.equal(w.state().events[0].delivery, 'pending');
});
test('closing a mailbox is reported internally without exposing webpage status in the UI', async () => {
  const w = await worker(); await login(w);
  const s = w.state(), owner = s.connection.owner;
  s.mailboxes.push({ id: 'box', owner, provider: 'gmail', email: 'test@gmail.com', seen: {} });
  s.tabs[9] = { mailboxId: 'box', owner, status: 'watching', at: Date.now() };
  await w.scanTabs(s); assert.equal(C.mailboxHealth(w.state(), w.state().mailboxes[0]).status, 'closed');
  const ui = await w.handle({ type: 'MW_CONNECTION' }, w.ui); assert.equal(ui.connection.mailboxes, undefined);
});
test('old store-management messages are no longer supported', async () => {
  const w = await worker();
  for (const type of ['MW_SCAN', 'MW_OPEN_DASHBOARD', 'MW_BIND_TAB', 'MW_ADD_MAILBOX', 'MW_PAIR']) await assert.rejects(w.handle({ type }, w.ui), /未知插件操作/);
});
test('v0.1 upgrade archives old state and requires provisioned plugin credentials', async () => {
  const old = { schema: 1, events: [{ id: 'old-pending' }], connection: { server: 'https://example.test' }, settings: { panelCollapsed: true } };
  const w = await worker({ mailwatchState: old, mailwatchCredentials: { token: 'old-token' } });
  assert.equal(w.state().schema, 2); assert.equal(C.active(w.state()), false); assert.equal(w.store.mailwatchV1Archive.events[0].id, 'old-pending');
  assert.equal(w.store.mailwatchCredentials, null); assert.equal(w.state().panelCollapsed, true);
});

test('new installations prefill the central server without replacing a saved custom server', async () => {
  const fresh = await worker();
  assert.equal(C.normalizeServer(fresh.state().connection.server), 'https://feishu-push.etsyweb.com');
  assert.equal(fresh.requests.length, 0);
  const saved = C.createState(); saved.connection.server = 'https://custom.example.test';
  const existing = await worker({ mailwatchState: saved });
  assert.equal(existing.state().connection.server, 'https://custom.example.test');
});

test('authenticated heartbeat applies bounded config and executes each rescan once', async () => {
  const w = await worker(); await login(w);
  let scans = 0;
  w.api.tabs.query = async () => { scans++; return []; };
  const command = { type: 'rescan', id: '12345678-1234-1234-1234-123456789abc', expires_at: Date.now() / 1000 + 100 };
  const config = { schema: 1, poll_seconds: 60, collection_mode: 'etsy_metadata', revision: 'c'.repeat(16) };
  w.setFetch(async () => w.ok('plugin-01', 'device-01', { collection_config: config, command }));
  await w.sync(w.state(), true);
  assert.equal(w.state().connection.config.poll_seconds, 60);
  assert.equal(scans, 1);
  await w.sync(w.state(), true);
  assert.equal(scans, 1);
  assert.equal(w.requests.at(-1).body.completed_command, command.id);
  assert.equal(w.requests.at(-1).body.diagnostics.config_revision, config.revision);
  w.setFetch(async () => w.ok('plugin-01', 'device-01', { collection_config: { ...config, poll_seconds: 0 }, command: { ...command, id: 'aaaaaaaa-1234-1234-1234-123456789abc', expires_at: 1 } }));
  await w.sync(w.state(), true);
  assert.equal(w.state().connection.config.poll_seconds, 60);
  assert.equal(scans, 1);
});
test('wrong server identity cannot change configuration or execute commands', async () => {
  const w = await worker(); await login(w);
  w.setFetch(async () => w.ok('wrong-account', 'device-01', { collection_config: { schema: 1, poll_seconds: 60, collection_mode: 'etsy_metadata', revision: 'c'.repeat(16) } }));
  await w.sync(w.state(), true);
  assert.equal(w.state().connection.config, undefined);
});

test('central mailbox identity is applied on login and refreshed by heartbeat', async () => {
  const w=await worker();
  w.setFetch(async (url,options) => {
    const body=JSON.parse(options.body);
    return w.ok('plugin-01','device-01',{access_token:'session-token',recorded_email:'configured@gmail.com'});
  });
  await login(w);assert.equal(w.state().connection.recordedEmail,'configured@gmail.com');
  w.setFetch(async()=>w.ok('plugin-01','device-01',{recorded_email:'changed@gmail.com'}));
  await w.sync(w.state(),true);assert.equal(w.state().connection.recordedEmail,'changed@gmail.com');
});
