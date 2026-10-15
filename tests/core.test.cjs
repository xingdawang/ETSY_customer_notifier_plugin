const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const now = Date.parse('2026-10-15T12:00:00Z');
function setup() {
  const state = C.createState(now);
  state.mailboxes.push({ id: 'box-a', email: 'shop@outlook.com', shop: '测试店铺', provider: 'outlook', enabled: true, startedAt: now, seen: {}, baselined: false });
  return state;
}
const mail = (id, extra = {}) => ({ sourceId: id, identityKind: 'message', subject: 'Etsy Conversation with Alice', sender: 'conversations@mail.etsy.com', receivedAt: new Date(now + 1000).toISOString(), ...extra });
const snapshot = (messages, extra = {}) => ({ provider: 'outlook', email: 'shop@outlook.com', status: 'watching', rowCount: messages.length, messages, ...extra });
const tab = { id: 1, url: 'https://outlook.live.com/mail/0/inbox' };

test('provider and account parsing are restricted to supported HTTPS hosts', () => {
  assert.equal(C.provider('https://mail.google.com/mail/u/0/#inbox'), 'gmail');
  assert.equal(C.provider('https://outlook.live.com.evil.test/mail/'), '');
  assert.equal(C.provider('http://outlook.live.com/mail/'), '');
  assert.equal(C.email('Google Account: Alice (SHOP@GMAIL.COM)'), 'shop@gmail.com');
});
test('buyer classification requires a known subject and Etsy sender evidence', () => {
  assert.equal(C.classify(mail('1')).category, '买家会话');
  assert.equal(C.classify(mail('1', { subject: 'Alice needs help with an order they placed.' })).category, '订单求助');
  assert.equal(C.classify(mail('1', { subject: 'Your Etsy order is confirmed' })), null);
  assert.equal(C.classify(mail('1', { sender: 'fake@etsy.com.evil.test', senderName: 'Etsy' })), null);
  assert.equal(C.classify(mail('1', { sender: '', senderName: 'Etsy' })).confidence, 'display_name');
  assert.equal(C.classify(mail('1', { sender: '', senderName: 'Unknown' })), null);
});
test('first scan establishes baseline without notifying old messages', async () => {
  const state = setup();
  assert.equal((await C.applySnapshot(state, tab, snapshot([mail('old')]), now)).length, 0);
  assert.equal(state.events.length, 0); assert.equal(state.mailboxes[0].baselined, true);
});
test('same subject with distinct message IDs produces separate events, read changes do not', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  assert.equal((await C.applySnapshot(state, tab, snapshot([mail('one'), mail('two')]), now + 1000)).length, 2);
  assert.equal((await C.applySnapshot(state, tab, snapshot([mail('one', { threadCount: '9', timeHint: 'now' }), mail('two')]), now + 2000)).length, 0);
});
test('thread revision uses latest time and count; stable repeat is suppressed', async () => {
  const state = setup(); const a = mail('thread', { identityKind: 'thread', threadCount: '1' });
  await C.applySnapshot(state, tab, snapshot([a]), now);
  assert.equal((await C.applySnapshot(state, tab, snapshot([{ ...a, threadCount: '2' }]), now + 1000)).length, 1);
  assert.equal((await C.applySnapshot(state, tab, snapshot([{ ...a, threadCount: '2' }]), now + 2000)).length, 0);
});
test('known old rows loaded by scrolling are excluded', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  assert.equal((await C.applySnapshot(state, tab, snapshot([mail('ancient', { receivedAt: new Date(now - 3600000).toISOString() })]), now + 1000)).length, 0);
});
test('account switching blocks old-shop attribution', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  await C.applySnapshot(state, tab, snapshot([mail('wrong')], { email: 'other@outlook.com' }), now + 1000);
  assert.equal(state.tabs[1].status, 'account_mismatch'); assert.equal(state.events.length, 0);
  assert.equal(C.boxHealth(state, state.mailboxes[0], now + 2000).code, 'account_mismatch');
});
test('unknown identity, paused mailbox and wrong folder never enqueue events', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  await C.applySnapshot(state, tab, snapshot([mail('a')], { email: '' }), now + 1000);
  await C.applySnapshot(state, tab, snapshot([mail('b')], { status: 'wrong_folder' }), now + 2000);
  state.mailboxes[0].enabled = false;
  await C.applySnapshot(state, tab, snapshot([mail('c')]), now + 3000);
  assert.equal(state.events.length, 0);
});
test('one healthy instance keeps mailbox readable; stale status expires', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  state.tabs[2] = { tabId: 2, mailboxId: 'box-a', status: 'unavailable', at: now + 1000 };
  assert.equal(C.boxHealth(state, state.mailboxes[0], now + 2000).code, 'watching');
  assert.equal(C.boxHealth(state, state.mailboxes[0], now + 100000).code, 'stale');
  state.tabs = {}; assert.equal(C.boxHealth(state, state.mailboxes[0], now + 100000).code, 'closed');
});
test('paired mailboxes queue new messages through network errors and revoked authorization', async () => {
  for (const status of ['connected', 'error', 'auth_required']) {
    const state = setup(); state.connection = { status, serverId: 'server-a' };
    await C.applySnapshot(state, tab, snapshot([]), now);
    await C.applySnapshot(state, tab, snapshot([mail(status)]), now + 1000);
    assert.equal(state.events[0].delivery, 'pending'); assert.equal(state.events[0].destination, 'server-a');
  }
});
test('persistent state suppresses repeats after service-worker restart', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  await C.applySnapshot(state, tab, snapshot([mail('persistent')]), now + 1000);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal((await C.applySnapshot(restored, tab, snapshot([mail('persistent')]), now + 2000)).length, 0);
});
test('public state excludes scan ledger, verification code and heartbeat challenge', () => {
  const state = setup(); state.connection.challenge = { nonce: 'secret-nonce' };
  state.events.push({ id: 'v', code: 'secret-code', detectedAt: now }); state.mailboxes[0].seen = { private: true };
  const result = C.publicState(state, now);
  assert.equal(result.mailboxes[0].seen, undefined); assert.equal(result.events[0].code, undefined); assert.equal(result.connection.challenge, undefined);
});
test('server normalization rejects credentials, remote HTTP and query strings', () => {
  assert.equal(C.normalizeServer('https://example.test/base/'), 'https://example.test/base');
  assert.equal(C.permissionPattern('https://example.test:8765/base'), 'https://example.test/*');
  assert.equal(C.normalizeServer('http://localhost:8765/'), 'http://localhost:8765');
  for (const value of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/?token=abc']) assert.throws(() => C.normalizeServer(value));
});
test('canonical source revision is stable across devices while local event IDs differ', async () => {
  const a = setup(), b = setup(); b.mailboxes[0].id = 'another-device-box';
  await C.applySnapshot(a, tab, snapshot([]), now); await C.applySnapshot(b, tab, snapshot([]), now);
  await C.applySnapshot(a, tab, snapshot([mail('canonical')]), now + 1000);
  await C.applySnapshot(b, tab, snapshot([mail('canonical')]), now + 1000);
  assert.notEqual(a.events[0].id, b.events[0].id);
  assert.equal(a.events[0].sourceRevision, b.events[0].sourceRevision); assert.equal(a.events[0].sourceId, 'canonical');
});
test('an old successful central heartbeat is never presented as currently connected', () => {
  const state = setup(); state.connection = { status: 'connected', serverId: 'a', lastHeartbeatAt: now - 100000 };
  assert.equal(C.publicState(state, now).connection.status, 'stale');
});
