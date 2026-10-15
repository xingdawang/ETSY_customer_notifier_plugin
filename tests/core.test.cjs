const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const now = Date.parse('2026-10-15T12:00:00Z');
function setup() {
  const state = C.createState(now);
  state.connection = { status: 'connected', server: 'https://example.test', account: 'plugin-01', token: 'private-token', owner: 'owner-01', deviceId: 'device-01', lastHeartbeatAt: now };
  return state;
}
const mail = (id, extra = {}) => ({ sourceId: id, identityKind: 'message', subject: 'Etsy Conversation with Alice', sender: 'conversations@mail.etsy.com', receivedAt: new Date(now + 1000).toISOString(), ...extra });
const snapshot = (messages, extra = {}) => ({ provider: 'outlook', email: 'shop@outlook.com', status: 'watching', rowCount: messages.length, messages, ...extra });
const tab = { id: 1, url: 'https://outlook.live.com/mail/0/inbox' };

test('only supported HTTPS mail hosts are accepted', () => {
  assert.equal(C.provider('https://mail.google.com/mail/u/0/#inbox'), 'gmail');
  assert.equal(C.provider('https://outlook.live.com.evil.test/'), '');
  assert.equal(C.provider('http://outlook.live.com/'), '');
  assert.equal(C.email('Google Account: Alice (SHOP@GMAIL.COM)'), 'shop@gmail.com');
});
test('classification requires a buyer subject and sender evidence', () => {
  assert.equal(C.classify(mail('1')).category, '买家会话');
  assert.equal(C.classify(mail('1', { subject: 'Alice needs help with an order they placed.' })).category, '订单求助');
  assert.equal(C.classify(mail('1', { subject: 'Your Etsy order is confirmed' })), null);
  assert.equal(C.classify(mail('1', { sender: 'fake@etsy.com.evil.test', senderName: 'Etsy' })), null);
  assert.equal(C.classify(mail('1', { sender: '', senderName: 'Etsy' })).confidence, 'display_name');
  assert.equal(C.classify(mail('1', { sender: '', senderName: '' })), null);
});
test('a disconnected installation does not collect mail or create bindings', async () => {
  const state = C.createState(now);
  assert.equal((await C.applySnapshot(state, tab, snapshot([mail('one')]), now)).length, 0);
  assert.equal(state.mailboxes.length, 0); assert.equal(state.events.length, 0);
});
test('mailboxes are discovered automatically with no shop name or binding action', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([mail('old')]), now);
  assert.equal(state.mailboxes.length, 1); assert.equal(state.mailboxes[0].email, 'shop@outlook.com');
  assert.equal(state.mailboxes[0].shop, undefined); assert.equal(state.mailboxes[0].baselined, true); assert.equal(state.events.length, 0);
});
test('same-subject separate mail is retained and unread or repeated scans are deduplicated', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  assert.equal((await C.applySnapshot(state, tab, snapshot([mail('one'), mail('two')]), now + 1000)).length, 2);
  assert.equal((await C.applySnapshot(state, tab, snapshot([mail('one', { unread: true, threadCount: '9' }), mail('two')]), now + 2000)).length, 0);
  assert.equal(state.events[0].shop, undefined); assert.equal(state.events[0].delivery, 'pending');
});
test('thread revisions detect a changing count without repeating the same revision', async () => {
  const state = setup(), a = mail('thread', { identityKind: 'thread', threadCount: '1' });
  await C.applySnapshot(state, tab, snapshot([a]), now);
  assert.equal((await C.applySnapshot(state, tab, snapshot([{ ...a, threadCount: '2' }]), now + 1000)).length, 1);
  assert.equal((await C.applySnapshot(state, tab, snapshot([{ ...a, threadCount: '2' }]), now + 2000)).length, 0);
});
test('scrolling old known-date mail does not create new notifications', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  assert.equal((await C.applySnapshot(state, tab, snapshot([mail('old', { receivedAt: new Date(now - 3600000).toISOString() })]), now + 1000)).length, 0);
});
test('switching the mailbox starts a separate baseline and never attributes mail to the old address', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  await C.applySnapshot(state, tab, snapshot([mail('existing-other')], { email: 'other@outlook.com' }), now + 1000);
  assert.equal(state.events.length, 0); assert.equal(state.mailboxes.length, 2);
  await C.applySnapshot(state, tab, snapshot([mail('existing-other'), mail('new-other')], { email: 'other@outlook.com' }), now + 2000);
  assert.equal(state.events[0].email, 'other@outlook.com');
  assert.equal(C.mailboxHealth(state, state.mailboxes[0], now + 2000).status, 'closed');
});
test('unknown identity and wrong folders do not produce mail events', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  await C.applySnapshot(state, tab, snapshot([mail('x')], { email: '' }), now + 1000);
  await C.applySnapshot(state, tab, snapshot([mail('y')], { status: 'wrong_folder' }), now + 2000);
  assert.equal(state.events.length, 0);
});
test('network errors retain collection; revoked credentials stop it', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  state.connection.status = 'error'; await C.applySnapshot(state, tab, snapshot([mail('offline')]), now + 1000);
  assert.equal(state.events.length, 1);
  state.connection.status = 'auth_required'; await C.applySnapshot(state, tab, snapshot([mail('revoked')]), now + 2000);
  assert.equal(state.events.length, 1);
});
test('different plugin credentials isolate mailboxes, baselines and queued events', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  await C.applySnapshot(state, tab, snapshot([mail('a')]), now + 1000);
  state.connection.owner = 'owner-02'; state.connection.account = 'plugin-02';
  await C.applySnapshot(state, tab, snapshot([mail('a')]), now + 2000);
  assert.equal(state.mailboxes.length, 2); assert.equal(state.events.length, 1); assert.equal(state.events[0].owner, 'owner-01');
});
test('durable state preserves deduplication across worker restarts', async () => {
  const state = setup(); await C.applySnapshot(state, tab, snapshot([]), now);
  await C.applySnapshot(state, tab, snapshot([mail('persistent')]), now + 1000);
  const restored = structuredClone(state);
  assert.equal((await C.applySnapshot(restored, tab, snapshot([mail('persistent')]), now + 2000)).length, 0);
});
test('UI sees only connection result and account, never token, mailbox status or queues', () => {
  const state = setup(); state.connection.challenge = { nonce: 'private-nonce' };
  const publicValue = C.publicConnection(state, now);
  assert.deepEqual(Object.keys(publicValue).sort(), ['account', 'authenticated', 'error', 'panelCollapsed', 'panelPosition', 'server', 'status']);
  assert.equal(JSON.stringify(publicValue).includes('private'), false);
  assert.equal(C.publicConnection(state, now + 100000).status, 'stale');
});
test('server URLs reject remote HTTP, credentials and query strings', () => {
  assert.equal(C.normalizeServer('https://example.test/base/'), 'https://example.test/base');
  assert.equal(C.normalizeServer('http://localhost:8765'), 'http://localhost:8765');
  assert.equal(C.permissionPattern('https://example.test:8765/path'), 'https://example.test/*');
  for (const value of ['', 'http://example.test', 'https://user:pass@example.test', 'https://example.test/?token=x']) assert.throws(() => C.normalizeServer(value));
});
test('pending events survive history pruning', async () => {
  const state = setup(); state.events = Array.from({ length: 120 }, (_, i) => ({ id: 'p' + i, owner: 'old', delivery: 'pending' }));
  state.events.push(...Array.from({ length: 110 }, (_, i) => ({ id: 'done' + i, delivery: 'uploaded' })));
  await C.applySnapshot(state, tab, snapshot([]), now);
  assert.equal(state.events.filter(e => e.delivery === 'pending').length, 120); assert.equal(state.events.filter(e => e.delivery === 'uploaded').length, 100);
});

test('identified mailboxes report wrong-folder health before their first readable scan', async () => {
  const state=setup();
  await C.applySnapshot(state,tab,snapshot([],{status:'wrong_folder'}),now);
  assert.equal(state.mailboxes.length,1);assert.equal(state.mailboxes[0].baselined,false);
  assert.equal(C.mailboxHealth(state,state.mailboxes[0],now).status,'wrong_folder');
  assert.equal(state.events.length,0);
  await C.applySnapshot(state,tab,snapshot([mail('existing')]),now+1000);
  assert.equal(state.mailboxes[0].baselined,true);assert.equal(state.events.length,0);
  await C.applySnapshot(state,tab,snapshot([mail('existing'),mail('new')]),now+2000);
  assert.equal(state.events.length,1);
});
