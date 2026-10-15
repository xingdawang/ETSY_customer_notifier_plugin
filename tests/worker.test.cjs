const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

async function worker() {
  const store = {}, listeners = {}, requests = [], reports = new Map(), tabs = [];
  const noop = () => {};
  const event = name => ({ addListener: fn => { listeners[name] = fn; } });
  const api = { storage: { local: {
    setAccessLevel: async () => {}, get: async key => ({ [key]: structuredClone(store[key]) }),
    set: async data => Object.assign(store, structuredClone(data)), remove: async key => { delete store[key]; }
  } }, alarms: { get: async () => ({}), create: async () => {}, onAlarm: event('alarm') },
    runtime: { id: 'test-extension', getURL: value => `chrome-extension://test-extension/${value}`, onMessage: event('message'), onStartup: event('startup'), onInstalled: event('install'), openOptionsPage: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    permissions: { contains: async () => true }, notifications: { create: async () => {} },
    tabs: { query: async () => tabs, get: async id => tabs.find(t => t.id === id),
      sendMessage: async (id, message) => message.type === 'MW_DOCUMENT_INFO' ? { ok: true, ...reports.get(id) } : { ok: true, report: reports.get(id) },
      update: async () => {}, create: async () => {}, onRemoved: event('removed'), onUpdated: event('updated') }
  };
  let fetcher = async () => new Response(JSON.stringify({ ok: true, protocol_version: 1 }), { status: 200 });
  const context = vm.createContext({ chrome: api, crypto: webcrypto, TextEncoder, URL, AbortSignal, setTimeout, console: { error: noop },
    fetch: async (url, options) => { requests.push({ url, options, body: JSON.parse(options.body) }); return fetcher(url, options); } });
  context.importScripts = (...files) => files.forEach(file => {
    if (file === 'storage.js') context.MailWatchStorage = api.storage.local;
    else vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
  vm.runInContext('globalThis.testing = {ready, handle, sync, scanTabs, processSnapshot, flush: () => operation}', context);
  await context.testing.ready;
  return { ...context.testing, store, tabs, reports, requests, listeners, api,
    trusted: { id: 'test-extension', url: 'chrome-extension://test-extension/dashboard.html' },
    mailbox: { id: 'test-extension', frameId: 0, url: 'https://mail.google.com/mail/u/0/#inbox', tab: { id: 1 } },
    setFetch: fn => { fetcher = fn; }, state: () => store.mailwatchState };
}
const ok = data => new Response(JSON.stringify({ ok: true, protocol_version: 1, ...data }));

test('mailbox pages cannot pair devices or change central configuration', async () => {
  const w = await worker();
  await assert.rejects(w.handle({ type: 'MW_PAIR', server: 'https://example.test', code: '123' }, w.mailbox), /管理页/);
  assert.equal(w.requests.length, 0);
});
test('central credentials never appear in public state', async () => {
  const w = await worker(); w.store.mailwatchCredentials = { token: 'token-must-stay-private' };
  const result = await w.handle({ type: 'MW_STATE' }, w.mailbox);
  assert.equal(JSON.stringify(result).includes('token-must-stay-private'), false);
});
test('upload acknowledgement is required and unrelated IDs do not acknowledge events', async () => {
  const w = await worker(); const state = w.state();
  state.connection = { server: 'https://example.test', serverId: 'server-a', status: 'connected' };
  state.events = [{ id: 'event-a', kind: 'buyer_message', delivery: 'pending', destination: 'server-a', attempts: 0 }];
  w.store.mailwatchCredentials = { token: 'private' };
  w.setFetch(async url => ok(url.endsWith('/events') ? { acknowledged_event_ids: ['unrelated'] } : {}));
  await w.sync(state); assert.equal(w.state().events[0].delivery, 'pending');
  w.setFetch(async url => ok(url.endsWith('/events') ? { acknowledged_event_ids: ['event-a'] } : {}));
  await w.sync(w.state(), true); assert.equal(w.state().events[0].delivery, 'uploaded');
  assert.equal(w.requests.find(r => r.url.endsWith('/events')).body.events[0].event_id, 'event-a');
});
test('unauthorized response preserves pending events and requires pairing', async () => {
  const w = await worker(); const state = w.state(); state.connection = { server: 'https://example.test', serverId: 'a', status: 'connected' };
  state.events = [{ id: 'a', delivery: 'pending', destination: 'a' }]; w.store.mailwatchCredentials = { token: 'old' };
  w.setFetch(async () => new Response('', { status: 401 })); await w.sync(state);
  assert.equal(w.state().connection.status, 'auth_required'); assert.equal(w.state().events[0].delivery, 'pending');
});
test('same-server re-pairing can recover a revoked credential with pending events', async () => {
  const w = await worker(); w.state().connection = { status: 'auth_required', server: 'https://example.test', serverId: 'a' };
  w.state().events = [{ id: 'a', delivery: 'pending', destination: 'a', attempts: 0 }];
  w.setFetch(async url => ok(url.endsWith('/enroll') ? { access_token: 'new-token', server_id: 'a' } : { acknowledged_event_ids: ['a'] }));
  await w.handle({ type: 'MW_PAIR', server: 'https://example.test', code: 'new-code' }, w.trusted);
  assert.equal(w.store.mailwatchCredentials.token, 'new-token'); assert.equal(w.state().events[0].delivery, 'uploaded');
});
test('rate limits honor retry time and do not replay old heartbeats', async () => {
  const w = await worker(); w.state().connection = { server: 'https://example.test', serverId: 'a', status: 'connected' }; w.store.mailwatchCredentials = { token: 'a' };
  w.setFetch(async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
  const before = Date.now(); await w.sync(w.state()); assert.ok(w.state().connection.nextRetryAt >= before + 120000);
  await w.sync(w.state()); assert.equal(w.requests.length, 1);
  w.setFetch(async () => ok({})); await w.sync(w.state(), true);
  assert.equal(w.requests[1].body.sequence, w.requests[0].body.sequence + 1);
});
test('unsupported server protocol is an error, not an online status', async () => {
  const w = await worker(); w.setFetch(async () => new Response(JSON.stringify({ ok: true, token: 'legacy' })));
  await assert.rejects(w.handle({ type: 'MW_PAIR', server: 'https://example.test', code: 'a' }, w.trusted), /协议/);
  assert.equal(w.state().connection.status, 'local');
});
test('closed tabs are removed and mailbox health reflects closure', async () => {
  const w = await worker(); const s = w.state();
  s.mailboxes.push({ id: 'a', provider: 'gmail', email: 'shop@gmail.com', enabled: true, baselined: true, seen: {} });
  s.tabs[9] = { tabId: 9, mailboxId: 'a', status: 'watching', at: Date.now(), lastScanAt: Date.now() };
  await w.scanTabs(s); assert.equal(Object.keys(w.state().tabs).length, 0);
  const result = await w.handle({ type: 'MW_STATE' }, w.trusted); assert.equal(result.state.mailboxes[0].health.code, 'closed');
});
test('a stale document cannot submit a scan for a newly switched mailbox', async () => {
  const w = await worker(); w.tabs.push({ id: 1, url: w.mailbox.url });
  w.reports.set(1, { documentNonce: 'new', pageUrl: w.mailbox.url, email: 'new@gmail.com' });
  await assert.rejects(w.handle({ type: 'MW_REPORT', report: { documentNonce: 'old', pageUrl: w.mailbox.url, email: 'old@gmail.com' } }, w.mailbox), /切换/);
});
test('verification needs a pending request and the exact sender; detection alone is not verification', async () => {
  const w = await worker(); const state = w.state();
  state.connection = { server: 'https://example.test', serverId: 'central', status: 'connected' };
  state.mailboxes.push({ id: 'box', email: 'test@gmail.com', provider: 'gmail', enabled: true, shop: 'Test', startedAt: Date.now(), seen: {} });
  state.verificationRequests = [{ id: 'check1', mailbox_id: 'box', sender: 'verify@example.test', expires_at: new Date(Date.now() + 60000).toISOString() }];
  const tab = { id: 1, url: 'https://mail.google.com/mail/u/0/#inbox' };
  const report = { provider: 'gmail', email: 'test@gmail.com', status: 'watching', rowCount: 1, messages: [{
    subject: '[Etsy Sentinel Verify:check1] random_secret_123456789', sender: 'wrong@example.test', sourceId: 'test', identityKind: 'message'
  }] };
  await w.processSnapshot(state, tab, report); assert.equal(state.events.length, 0);
  report.messages[0].sender = 'verify@example.test'; await w.processSnapshot(state, tab, report);
  assert.equal(state.events.length, 1); assert.equal(state.events[0].kind, 'verification'); assert.equal(state.mailboxes[0].verifiedAt, undefined);
  await w.processSnapshot(state, tab, report); assert.equal(state.events.length, 1);
  const publicResult = await w.handle({ type: 'MW_STATE' }, w.mailbox);
  assert.equal(JSON.stringify(publicResult).includes('random_secret_123456789'), false);
});
test('server confirmation verifies only an already acknowledged verification event', async () => {
  const w = await worker(); const state = w.state();
  state.connection = { server: 'https://example.test', serverId: 'central', status: 'connected' };
  state.mailboxes.push({ id: 'box', email: 'test@gmail.com', provider: 'gmail', enabled: true, baselined: true, seen: {} });
  state.events.push({ id: 'check-event', kind: 'verification', requestId: 'check1', mailboxId: 'box', destination: 'central', delivery: 'pending', attempts: 0 });
  w.store.mailwatchCredentials = { token: 'private' };
  w.setFetch(async url => ok(url.endsWith('/events') ? { acknowledged_event_ids: ['check-event'] } : { verification_results: [{ request_id: 'check1', mailbox_id: 'box', verified: true }] }));
  await w.sync(state); assert.equal(w.state().mailboxes[0].verifiedAt, undefined);
  await w.sync(w.state(), true); assert.ok(w.state().mailboxes[0].verifiedAt);
});
test('event delivery failures back off independently while heartbeat remains healthy', async () => {
  const w = await worker(); w.state().connection = { server: 'https://example.test', serverId: 'a', status: 'connected' };
  w.state().events = [{ id: 'e', delivery: 'pending', destination: 'a', attempts: 0 }]; w.store.mailwatchCredentials = { token: 'a' };
  w.setFetch(async url => url.endsWith('/events') ? new Response('', { status: 503 }) : ok({}));
  await w.sync(w.state()); const first = w.state().connection.uploadRetryAt;
  assert.equal(w.state().connection.status, 'connected'); assert.equal(w.state().connection.uploadFailures, 1);
  await w.sync(w.state()); assert.equal(w.requests.filter(r => r.url.endsWith('/heartbeat')).length, 2);
  assert.equal(w.requests.filter(r => r.url.endsWith('/events')).length, 1);
  await w.sync(w.state(), true); assert.equal(w.state().connection.uploadFailures, 2); assert.ok(w.state().connection.uploadRetryAt > first);
});
