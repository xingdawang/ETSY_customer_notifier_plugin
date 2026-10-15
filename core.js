/* Shared policy and deterministic state transitions. No mailbox passwords or API tokens. */
(function (root) {
  'use strict';
  const VERSION = '0.1.0';
  const HOSTS = { 'outlook.live.com': 'outlook', 'outlook.office.com': 'outlook', 'outlook.office365.com': 'outlook', 'mail.google.com': 'gmail' };
  const LABELS = {
    watching: '监听中', limited: '有限覆盖', unbound: '尚未绑定', paused: '已暂停',
    closed: '页面已关闭', unavailable: '页面无响应', loading: '页面加载中',
    login_required: '需要登录', identity_unknown: '无法确认账号', account_mismatch: '账号不匹配',
    wrong_folder: '请切回收件箱', view_unavailable: '未找到邮件列表', stale: '状态已过期',
    sleeping: '页面已休眠', initializing: '等待首次扫描', storage_error: '本地保存失败'
  };
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
    return { schema: 1, deviceId: crypto.randomUUID(), settings: { deviceName: '我的 Windows 电脑', desktopNotifications: false, panelCollapsed: false },
      mailboxes: [], tabs: {}, events: [], log: [], connection: { status: 'local', server: '', serverId: '', lastHeartbeatAt: null, error: '' },
      sequence: 0, createdAt: now };
  }
  function log(state, level, text, now = Date.now(), mailboxId = '') {
    const previous = state.log[0];
    if (previous?.text === text && previous.mailboxId === mailboxId && now - previous.at < 60000) return;
    state.log.unshift({ id: crypto.randomUUID(), at: now, level, text: clean(text, 500), mailboxId });
    state.log = state.log.slice(0, 300);
  }
  function normalizeServer(value) {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('远程网站必须使用 HTTPS；本机测试可使用 localhost 或 127.0.0.1。');
    if (url.username || url.password || url.search || url.hash) throw new Error('网站地址不能包含账号、查询参数或锚点。');
    return url.origin + url.pathname.replace(/\/+$/, '');
  }
  function permissionPattern(server) { const u = new URL(server); return `${u.protocol}//${u.hostname}/*`; }
  function mailboxUrl(box) {
    return box.provider === 'gmail' ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(box.email)}#inbox` : 'https://outlook.live.com/mail/0/inbox';
  }
  function boxHealth(state, box, now = Date.now()) {
    if (!box.enabled) return { code: 'paused', label: LABELS.paused, tone: 'neutral', lastScanAt: null, tabs: [] };
    const tabs = Object.values(state.tabs).filter(t => t.mailboxId === box.id);
    const fresh = tabs.filter(t => now - t.at < 90000);
    const valid = fresh.filter(t => ['watching', 'limited'].includes(t.status)).sort((a, b) => b.lastScanAt - a.lastScanAt);
    let code = valid.length ? (valid.some(t => t.status === 'watching') ? 'watching' : 'limited') :
      fresh.sort((a, b) => b.at - a.at)[0]?.status || (tabs.length ? 'stale' : 'closed');
    if (!box.baselined && code === 'closed') code = 'initializing';
    return { code, label: LABELS[code] || '待检查', tone: code === 'watching' ? 'good' : ['paused', 'initializing'].includes(code) ? 'neutral' : 'warn',
      lastScanAt: valid[0]?.lastScanAt || box.lastScanAt || null, tabs };
  }
  function publicState(state, now = Date.now()) {
    const { challenge, ...connection } = state.connection;
    if (connection.status === 'connected' && (!connection.lastHeartbeatAt || now - connection.lastHeartbeatAt > 90000)) connection.status = 'stale';
    return { version: VERSION, deviceId: state.deviceId, settings: state.settings, connection,
      mailboxes: state.mailboxes.map(box => { const { seen, ...publicBox } = box; return { ...publicBox, health: boxHealth(state, box, now) }; }),
      tabs: Object.values(state.tabs), events: state.events.slice(-300).reverse().map(e => { const { code, ...entry } = e; return entry; }), log: state.log, now,
      counts: { total: state.mailboxes.length, readable: state.mailboxes.filter(b => ['watching', 'limited'].includes(boxHealth(state, b, now).code)).length,
        pending: state.events.filter(e => e.delivery === 'pending').length, today: state.events.filter(e => new Date(e.detectedAt).toDateString() === new Date(now).toDateString() && e.kind !== 'verification').length } };
  }
  async function applySnapshot(state, tab, report, now = Date.now()) {
    const p = provider(tab.url);
    if (!p || p !== report.provider) throw new Error('邮箱页面来源不匹配。');
    const address = email(report.email);
    const previous = state.tabs[tab.id];
    const boxes = state.mailboxes.filter(b => b.provider === p);
    const box = boxes.find(b => b.email === address);
    const previousBox = boxes.find(b => b.id === previous?.mailboxId);
    const record = { tabId: tab.id, documentId: tab.documentId || '', provider: p, email: address,
      mailboxId: box?.id || previousBox?.id || '', at: now, lastScanAt: null, status: report.status || 'view_unavailable',
      detail: clean(report.detail, 250), rowCount: Math.min(Number(report.rowCount) || 0, 1000), coverage: 'visible_rows', url: tab.url };
    if (!address && record.status !== 'login_required') record.status = 'identity_unknown';
    if (address && !box) record.status = previousBox ? 'account_mismatch' : 'unbound';
    if (box && !box.enabled) record.status = 'paused';
    state.tabs[tab.id] = record;
    if (previous?.status !== record.status) log(state, ['watching', 'limited', 'unbound'].includes(record.status) ? 'info' : 'warn',
      `${address || '邮箱页面'}：${LABELS[record.status] || record.status}`, now, record.mailboxId);
    if (!box || !box.enabled || !['watching', 'limited'].includes(record.status)) return [];
    record.lastScanAt = now; box.lastScanAt = now;
    const messages = Array.isArray(report.messages) ? report.messages.slice(0, 500) : [];
    const newEvents = [];
    const first = !box.baselined;
    box.seen ||= {};
    for (const raw of messages) {
      if (!raw || typeof raw !== 'object') continue;
      const message = { subject: clean(raw.subject), sender: email(raw.sender), senderName: clean(raw.senderName, 120),
        sourceId: clean(raw.sourceId, 250), identityKind: ['message', 'thread', 'fingerprint'].includes(raw.identityKind) ? raw.identityKind : 'fingerprint',
        receivedAt: Number.isFinite(Date.parse(raw.receivedAt)) ? new Date(raw.receivedAt).toISOString() : null,
        timeHint: clean(raw.timeHint, 120), threadCount: clean(raw.threadCount, 20) };
      const key = await digest(`${box.id}:${revision(message)}`);
      if (box.seen[key]) { box.seen[key] = now; continue; }
      box.seen[key] = now;
      const classified = classify(message);
      // Initial visible rows are a baseline, not a new-message notification.
      // Previously hidden rows with known old timestamps are not new arrivals either.
      if (first || !classified || (message.receivedAt && Date.parse(message.receivedAt) < box.startedAt - 60000)) continue;
      const event = { id: key, mailboxId: box.id, provider: p, email: box.email, shop: box.shop,
        kind: 'buyer_message', category: classified.category, subject: classified.subject, sender: message.sender || message.senderName,
        confidence: classified.confidence, identityKind: message.identityKind, sourceId: message.sourceId || null,
        sourceRevision: await digest(revision(message)), receivedAt: message.receivedAt, detectedAt: now,
        delivery: state.connection.serverId ? 'pending' : 'local', destination: state.connection.serverId || '', attempts: 0 };
      if (!state.events.some(e => e.id === key)) { state.events.push(event); newEvents.push(event); }
    }
    box.baselined = true;
    const entries = Object.entries(box.seen);
    if (entries.length > 5000) box.seen = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, 5000));
    // Never discard unsent events. Only truncate completed/local history.
    if (state.events.length > 2000) {
      let removable = state.events.length - 2000;
      state.events = state.events.filter(e => e.delivery === 'pending' || e.delivery === 'failed' || removable-- <= 0);
    }
    if (first) log(state, 'info', `${box.shop} 已建立当前可见列表基线；之后发现的匹配邮件将记录。`, now, box.id);
    if (newEvents.length) log(state, 'info', `${box.shop} 发现 ${newEvents.length} 条买家消息候选。`, now, box.id);
    return newEvents;
  }
  const api = { VERSION, HOSTS, LABELS, email, provider, mailboxKey, clean, subject, classify, revision, digest, createState, log,
    normalizeServer, permissionPattern, mailboxUrl, boxHealth, publicState, applySnapshot };
  root.MailWatchCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
