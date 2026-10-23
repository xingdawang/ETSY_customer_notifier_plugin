/* Shared policy and deterministic state transitions. No mailbox passwords or API tokens. */
(function (root) {
  'use strict';
  const VERSION = '0.3.2';
  const HOSTS = { 'outlook.live.com': 'outlook', 'outlook.office.com': 'outlook', 'outlook.office365.com': 'outlook', 'mail.google.com': 'gmail' };
  function email(value) {
    const match = String(value || '').trim().match(/(?:^|[\s<（(])([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})(?=$|[\s>）),;])/i);
    return match ? match[1].toLowerCase() : '';
  }
  function provider(url) { try { const u = new URL(url); return u.protocol === 'https:' ? HOSTS[u.hostname] || '' : ''; } catch (_) { return ''; } }
  function mailboxKey(p, address) { return `${p}:${email(address)}`; }
  function clean(value, limit = 300) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit); }
  function subject(value) { return clean(value).replace(/^(?:(?:re|fw|fwd|回复|转发|回覆|轉寄)\s*[:：]\s*)+/i, '').trim(); }
  function classify(message) {
    const title = subject(message.subject);
    const conversation = /^Etsy Conversation with .+?(?: about Order #\d+)?$/i.test(title);
    const help = /^.+? needs help with an order they placed[.!]?$/i.test(title);
    if (!conversation && !help) return null;
    const from = email(message.sender);
    if (from && !/@(?:[a-z0-9-]+\.)*etsy\.com$/i.test(from)) return null;
    const named = /^(?:etsy|etsy conversations|etsy messages)$/i.test(clean(message.senderName));
    if (!from && !named) return null;
    return { category: help ? '订单求助' : '买家会话', confidence: from ? 'address' : 'display_name', subject: title };
  }
  function etsyCandidate(message) {
    const from = email(message.sender);
    return from ? /@(?:[a-z0-9-]+\.)*etsy\.com$/i.test(from) : /^(?:etsy|etsy conversations|etsy messages)$/i.test(clean(message.senderName));
  }
  function acceptConfig(value) {
    if (!value || value.schema !== 1 || ![30, 60].includes(value.poll_seconds) || value.collection_mode !== 'etsy_metadata' || !/^[a-f0-9]{16}$/.test(value.revision)) return null;
    return { schema: 1, poll_seconds: value.poll_seconds, collection_mode: 'etsy_metadata', revision: value.revision };
  }
  function pollSeconds(state) { return acceptConfig(state.connection.config)?.poll_seconds || 30; }
  function revision(message) {
    if (message.identityKind === 'message' && message.sourceId) return `message:${message.sourceId}`;
    const time = message.receivedAt || message.timeHint || '';
    // Do not use unread state, row position, browser-generated element IDs, or snippets.
    return JSON.stringify([message.sourceId || '', subject(message.subject), email(message.sender) || clean(message.senderName), time, message.threadCount || '']);
  }
  async function digest(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
  }
  function createState(now = Date.now()) {
    return { schema: 2, installationId: crypto.randomUUID(), sequence: 0, panelCollapsed: false, panelPosition: null,
      connection: { status: 'disconnected', server: '', account: '', token: '', owner: '', deviceId: '', lastHeartbeatAt: null, error: '' },
      mailboxes: [], tabs: {}, events: [], createdAt: now };
  }
  function normalizeServer(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch (_) { throw new Error('请在连接设置中填写中央服务器地址。'); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('中央服务器必须使用 HTTPS；本机测试可使用 HTTP。');
    if (url.username || url.password || url.search || url.hash) throw new Error('服务器地址不能包含账户、查询参数或锚点。');
    return url.origin + url.pathname.replace(/\/+$/, '');
  }
  function permissionPattern(server) { const u = new URL(server); return `${u.protocol}//${u.hostname}/*`; }
  function active(state) { return !!state.connection.token && state.connection.status !== 'auth_required'; }
  function publicConnection(state, now = Date.now()) {
    const c = state.connection;
    const status = c.status === 'connected' && (!c.lastHeartbeatAt || now - c.lastHeartbeatAt > 90000) ? 'stale' : c.status;
    return { server: c.server, account: c.account, authenticated: active(state), status, error: c.error || '', pollSeconds: pollSeconds(state), panelCollapsed: state.panelCollapsed, panelPosition: state.panelPosition || null };
  }
  function mailboxHealth(state, box, now = Date.now()) {
    const tabs = Object.values(state.tabs).filter(t => t.mailboxId === box.id && t.owner === box.owner);
    const fresh = tabs.filter(t => now - t.at < 90000);
    const readable = fresh.find(t => ['watching', 'limited'].includes(t.status));
    return { status: readable?.status || fresh.sort((a, b) => b.at - a.at)[0]?.status || (tabs.length ? 'stale' : 'closed'),
      last_scan_at: box.lastScanAt || null, open_tab_count: tabs.length };
  }
  async function applySnapshot(state, tab, report, now = Date.now()) {
    if (!active(state)) return [];
    const p = provider(tab.url);
    if (!p || report.provider !== p) throw new Error('邮箱页面来源不匹配。');
    const address = email(state.connection.recordedEmail) || email(report.email), owner = state.connection.owner;
    const reportStatus = report.status === 'identity_unknown' && address ? report.listStatus || report.status : report.status;
    const previous = state.tabs[tab.id];
    let box = state.mailboxes.find(b => b.owner === owner && b.provider === p && b.email === address);
    const readable = ['watching', 'limited'].includes(reportStatus);
    if (!box && address) {
      box = { id: await digest(`${owner}:${mailboxKey(p, address)}`), owner, provider: p, email: address,
        startedAt: now, baselined: false, seen: {}, lastScanAt: null };
      state.mailboxes.push(box);
    }
    state.tabs[tab.id] = { tabId: tab.id, owner, provider: p, email: address,
      mailboxId: box?.id || (previous?.owner === owner ? previous.mailboxId : ''), at: now,
      status: !address ? reportStatus === 'login_required' ? 'login_required' : 'identity_unknown' : reportStatus || 'view_unavailable',
      rowCount: Math.min(Number(report.rowCount) || 0, 500), pageHidden: report.pageHidden === true };
    if (!box || !readable || !address) return [];
    box.reportedEmail = email(report.email);
    // Rebaseline once when upgrading Gmail identity semantics; never replay old visible rows.
    if (p === 'gmail' && box.collectorRevision !== 'gmail-latest-v1') {
      box.baselined = false;
      box.collectorRevision = 'gmail-latest-v1';
    }
    box.lastScanAt = now;
    const first = !box.baselined, added = [];
    for (const raw of (Array.isArray(report.messages) ? report.messages : []).slice(0, 500)) {
      if (!raw || typeof raw !== 'object') continue;
      const message = { subject: clean(raw.subject), sender: email(raw.sender), senderName: clean(raw.senderName, 100),
        sourceId: clean(raw.sourceId, 250), identityKind: ['message', 'thread', 'fingerprint'].includes(raw.identityKind) ? raw.identityKind : 'fingerprint',
        receivedAt: Number.isFinite(Date.parse(raw.receivedAt)) ? new Date(raw.receivedAt).toISOString() : null,
        timeHint: clean(raw.timeHint, 120), threadCount: clean(raw.threadCount, 20) };
      const sourceRevision = await digest(revision(message));
      if (box.seen[sourceRevision]) { box.seen[sourceRevision] = now; continue; }
      box.seen[sourceRevision] = now;
      const classified = classify(message), central = !!acceptConfig(state.connection.config);
      if (first || !(central ? etsyCandidate(message) : classified) || (message.receivedAt && Date.parse(message.receivedAt) < box.startedAt - 60000)) continue;
      const id = await digest(`${state.installationId}:${owner}:${mailboxKey(p, address)}:${sourceRevision}`);
      if (state.events.some(e => e.id === id)) continue;
      const event = { id, owner, mailboxId: box.id, provider: p, email: address,
        kind: central ? 'etsy_candidate' : 'buyer_message', subject: central ? message.subject : classified.subject, category: classified?.category || '', confidence: classified?.confidence || '',
        sender: message.sender || message.senderName, sourceId: message.sourceId || null, sourceRevision,
        identityKind: message.identityKind, receivedAt: message.receivedAt, detectedAt: now, reportedEmail: email(report.email) || address, delivery: 'pending', attempts: 0 };
      state.events.push(event); added.push(event);
    }
    box.baselined = true;
    const ledger = Object.entries(box.seen);
    if (ledger.length > 5000) box.seen = Object.fromEntries(ledger.sort((a, b) => b[1] - a[1]).slice(0, 5000));
    const completed = state.events.filter(e => e.delivery === 'uploaded').slice(-100);
    state.events = [...state.events.filter(e => e.delivery !== 'uploaded'), ...completed];
    return added;
  }
  const api = { VERSION, HOSTS, email, provider, mailboxKey, clean, subject, classify, etsyCandidate, acceptConfig, pollSeconds, revision, digest,
    createState, normalizeServer, permissionPattern, active, publicConnection, mailboxHealth, applySnapshot };
  root.MailWatchCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
