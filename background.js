/* MV3 coordinator. Persistent state is serialized before notifications or uploads. */
importScripts('core.js', 'storage.js');
const C = MailWatchCore;
const S = MailWatchStorage;
const STATE = 'mailwatchState', CREDENTIALS = 'mailwatchCredentials', ALARM = 'mailwatch-tick';
const sessionId = crypto.randomUUID();
let operation = Promise.resolve();
const ready = (async () => {
  await S.ready;
  const stored = await S.get(STATE);
  if (!stored[STATE]) await S.set({ [STATE]: C.createState() });
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
})();
function serial(work) {
  const result = operation.then(() => ready).then(work);
  operation = result.catch(error => console.error('MailWatch:', error.message));
  return result;
}
async function readState() { return (await S.get(STATE))[STATE]; }
async function save(state) { await S.set({ [STATE]: state }); await badge(state); }
async function badge(state) {
  const bad = state.mailboxes.filter(b => b.enabled && !['watching', 'limited'].includes(C.boxHealth(state, b).code)).length;
  const pending = state.events.filter(e => e.delivery === 'pending').length;
  await chrome.action.setBadgeText({ text: bad ? '!' : pending ? String(pending) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: bad ? '#b45309' : '#c65a2e' });
}
function trusted(sender) { return sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL('')); }
function mailSender(sender) { return sender.id === chrome.runtime.id && sender.tab?.id != null && sender.frameId === 0 && !!C.provider(sender.url); }
function requireTrusted(sender) { if (!trusted(sender)) throw new Error('此操作只能在插件管理页进行。'); }
async function notify(events, state) {
  if (!state.settings.desktopNotifications || !(await chrome.permissions.contains({ permissions: ['notifications'] }))) return;
  for (const event of events.filter(e => e.kind === 'buyer_message')) {
    try {
      await chrome.notifications.create(event.id, { type: 'basic', iconUrl: 'assets/icon128.png',
        title: `${event.shop} · ${event.confidence === 'address' ? '买家消息' : '消息候选，待核实'}`,
        message: event.subject, contextMessage: event.email });
    } catch (error) { C.log(state, 'warn', '本地通知未显示，请检查浏览器通知权限。'); }
  }
}
async function processSnapshot(state, tab, report) {
  const events = await C.applySnapshot(state, tab, report);
  const record = state.tabs[tab.id];
  const box = state.mailboxes.find(b => b.id === record.mailboxId);
  if (box?.enabled && box.email === record.email && ['watching', 'limited'].includes(record.status)) {
    for (const message of (report.messages || []).slice(0, 500)) {
      const match = String(message.subject || '').match(/^\[Etsy Sentinel Verify:([A-Za-z0-9_-]{1,64})\]\s+([A-Za-z0-9_-]{16,128})$/);
      const request = (state.verificationRequests || []).find(r => r.id === match?.[1] && r.mailbox_id === box.id && Date.parse(r.expires_at) > Date.now());
      if (!request || C.email(message.sender) !== request.sender) continue;
      const id = await C.digest(`verify:${box.id}:${request.id}`);
      if (!state.events.some(e => e.id === id)) state.events.push({ id, kind: 'verification', requestId: request.id, code: match[2],
        mailboxId: box.id, email: box.email, shop: box.shop, provider: box.provider, subject: '收信验证结果',
        detectedAt: Date.now(), delivery: 'pending', destination: state.connection.serverId, attempts: 0 });
    }
  }
  return events;
}
async function scanTabs(state) {
  const tabs = await chrome.tabs.query({});
  const allIds = new Set(tabs.map(t => t.id));
  const detected = [];
  for (const id of Object.keys(state.tabs)) if (!allIds.has(Number(id))) delete state.tabs[id];
  const supported = tabs.filter(t => C.provider(t.url));
  const replies = await Promise.allSettled(supported.map(async tab => {
    if (tab.discarded || tab.frozen) return { tab, sleeping: true };
    const response = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'MW_COLLECT' }, { frameId: 0 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面未响应')), 2500))
    ]);
    if (!response?.ok || !response.report) throw new Error('请刷新邮箱页面，让插件加载。');
    return { tab, report: response.report };
  }));
  for (let i = 0; i < replies.length; i++) {
    const result = replies[i], tab = supported[i], old = state.tabs[tab.id];
    if (result.status === 'fulfilled' && result.value.report) {
      try { detected.push(...await processSnapshot(state, tab, result.value.report)); }
      catch (error) { C.log(state, 'warn', C.clean(error.message)); }
    } else {
      state.tabs[tab.id] = { ...old, tabId: tab.id, provider: C.provider(tab.url), email: old?.email || '', mailboxId: old?.mailboxId || '',
        at: Date.now(), status: result.status === 'fulfilled' ? 'sleeping' : 'unavailable',
        detail: result.status === 'fulfilled' ? '请激活邮箱页面，恢复后再检查。' : '页面无响应；若刚安装或更新插件，请刷新邮箱。', url: tab.url };
    }
  }
  // An existing tab may have navigated to login or another site, outside host access.
  for (const [id, record] of Object.entries(state.tabs)) {
    if (!supported.some(t => t.id === Number(id))) {
      record.status = 'unavailable'; record.at = Date.now(); record.detail = '页面已离开支持的邮箱，可能需要重新登录。';
    }
  }
  await save(state);
  await notify(detected, state);
  return state;
}
async function request(server, path, token, body) {
  if (!(await chrome.permissions.contains({ origins: [C.permissionPattern(server)] }))) throw new Error('尚未授予此中央网站的访问权限，请重新配对。');
  let response;
  try {
    response = await fetch(server + '/api/extension/v1/' + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(7000) });
  } catch (_) { throw new Error('无法连接中央网站，请检查网络、网站地址和 HTTPS 证书。'); }
  if (response.status === 401 || response.status === 403) { const e = new Error('设备凭证已失效，请重新配对。'); e.auth = true; throw e; }
  if (!response.ok) {
    const error = new Error(response.status === 404 ? '中央网站尚未提供 v1 插件接口。' : `中央网站请求失败（${response.status}）。`);
    const after = response.headers.get('Retry-After');
    error.retryAfter = after ? Math.max(0, /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()) : 0;
    throw error;
  }
  let data;
  try { data = await response.json(); } catch (_) { throw new Error('中央网站未返回有效的插件接口数据。'); }
  if (data.ok !== true || data.protocol_version !== 1) throw new Error('中央网站协议不匹配，需要 extension v1 接口。');
  return data;
}
async function sync(state, force = false) {
  const credentials = (await S.get(CREDENTIALS))[CREDENTIALS];
  if (!credentials?.token || state.connection.status === 'auth_required' || (!force && state.connection.nextRetryAt > Date.now())) return;
  try {
    state.sequence++;
    // A fresh heartbeat is created now. Old heartbeat payloads are never retried/replayed.
    const data = await request(state.connection.server, 'heartbeat', credentials.token, {
      protocol_version: 1, device_id: state.deviceId, session_id: sessionId, sequence: state.sequence,
      extension_version: C.VERSION, device_name: state.settings.deviceName, sent_at: new Date().toISOString(),
      pending_event_count: state.events.filter(e => e.delivery === 'pending').length,
      last_upload_error: state.connection.uploadError || '',
      previous_challenge: state.connection.challenge || null,
      mailboxes: C.publicState(state).mailboxes.map(b => ({ mailbox_id: b.id, provider: b.provider, email: b.email, shop: b.shop,
        enabled: b.enabled, status: b.health.code, last_scan_at: b.lastScanAt, coverage: 'visible_rows',
        last_verified_at: b.verifiedAt || null, last_verification_id: b.verificationId || null, open_tab_count: b.health.tabs.length }))
    });
    state.connection.status = 'connected'; state.connection.error = ''; state.connection.lastHeartbeatAt = Date.now();
    state.connection.failureCount = 0; state.connection.nextRetryAt = 0;
    state.connection.challenge = data.challenge && typeof data.challenge.nonce === 'string' && Date.parse(data.challenge.expires_at) > Date.now() ?
      { id: C.clean(data.challenge.id, 64), nonce: C.clean(data.challenge.nonce, 256), expires_at: data.challenge.expires_at } : null;
    state.verificationRequests = (Array.isArray(data.verification_requests) ? data.verification_requests : []).slice(0, 30).filter(r =>
      /^[A-Za-z0-9_-]{1,64}$/.test(r.id) && state.mailboxes.some(b => b.id === r.mailbox_id) && C.email(r.sender) && Date.parse(r.expires_at) > Date.now()
    ).map(r => ({ id: r.id, mailbox_id: r.mailbox_id, sender: C.email(r.sender), expires_at: r.expires_at }));
    for (const result of (Array.isArray(data.verification_results) ? data.verification_results : []).slice(0, 30)) {
      const sent = state.events.find(e => e.kind === 'verification' && e.requestId === result.request_id && e.mailboxId === result.mailbox_id && e.delivery === 'uploaded');
      const box = state.mailboxes.find(b => b.id === result.mailbox_id);
      if (sent && box && result.verified === true && box.verificationId !== result.request_id) {
        box.verifiedAt = Date.now(); box.verificationId = result.request_id;
        C.log(state, 'info', `${box.shop} 收信验证已由中央网站确认。`, Date.now(), box.id);
      }
    }
    const pending = state.events.filter(e => e.delivery === 'pending' && e.destination === state.connection.serverId).slice(0, 50);
    if (pending.length && (force || !(state.connection.uploadRetryAt > Date.now()))) {
      // Persist the pending IDs before the request. Only explicit acknowledgements complete them.
      for (const event of pending) event.attempts++;
      await save(state);
      try {
        const result = await request(state.connection.server, 'events', credentials.token, { protocol_version: 1, device_id: state.deviceId,
          events: pending.map(e => ({ ...e, event_id: e.id })) });
        const acknowledged = new Set(Array.isArray(result.acknowledged_event_ids) ? result.acknowledged_event_ids : []);
        for (const event of pending) if (acknowledged.has(event.id)) { event.delivery = 'uploaded'; event.uploadedAt = Date.now(); }
        if (!pending.every(e => e.delivery === 'uploaded')) throw new Error('中央网站未确认全部事件，未确认记录已保留等待重试。');
        state.connection.uploadError = ''; state.connection.uploadFailures = 0; state.connection.uploadRetryAt = 0;
      } catch (error) {
        if (error.auth) throw error;
        state.connection.uploadError = error.message;
        state.connection.uploadFailures = (state.connection.uploadFailures || 0) + 1;
        state.connection.uploadRetryAt = Date.now() + Math.max(error.retryAfter || 0, Math.min(900000, 30000 * 2 ** Math.min(state.connection.uploadFailures - 1, 5)));
        C.log(state, 'warn', `事件上报：${error.message}`);
      }
    }
  } catch (error) {
    state.connection.status = error.auth ? 'auth_required' : 'error'; state.connection.error = error.message;
    state.connection.failureCount = (state.connection.failureCount || 0) + 1;
    state.connection.nextRetryAt = Date.now() + Math.max(error.retryAfter || 0, Math.min(900000, 30000 * 2 ** Math.min(state.connection.failureCount - 1, 5)));
    C.log(state, 'warn', error.message);
  }
  await save(state);
}
async function addMailbox(state, values) {
  const address = C.email(values.email), p = values.provider;
  if (!address || !['gmail', 'outlook'].includes(p)) throw new Error('请选择邮箱平台并填写完整邮箱地址。');
  if (state.mailboxes.some(b => b.provider === p && b.email === address)) throw new Error('这个邮箱已经绑定。');
  if (state.mailboxes.length >= 30) throw new Error('当前浏览器最多绑定 30 个邮箱；建议每个配置文件使用一个账号。');
  const box = { id: crypto.randomUUID(), provider: p, email: address, shop: C.clean(values.shop, 80) || address,
    enabled: true, startedAt: Date.now(), baselined: false, seen: {}, lastScanAt: null, verifiedAt: null };
  state.mailboxes.push(box); C.log(state, 'info', `已绑定 ${box.shop}（${address}）。`, Date.now(), box.id);
  return box;
}
async function handle(message, sender) {
  if (!message || (!trusted(sender) && !mailSender(sender))) throw new Error('请求来源无效。');
  const state = await readState();
  switch (message.type) {
    case 'MW_STATE': return { state: C.publicState(state) };
    case 'MW_REPORT': {
      if (!mailSender(sender)) throw new Error('仅接受邮箱页面的扫描结果。');
      const current = await chrome.tabs.get(sender.tab.id);
      if (C.provider(current.url) !== C.provider(sender.url)) throw new Error('页面已切换，已忽略旧扫描。');
      const live = await chrome.tabs.sendMessage(current.id, { type: 'MW_DOCUMENT_INFO' }, { frameId: 0 });
      if (!live?.ok || live.documentNonce !== message.report?.documentNonce || live.pageUrl !== message.report?.pageUrl || live.email !== message.report?.email) throw new Error('账号或页面已经切换，已忽略旧扫描。');
      const events = await processSnapshot(state, { ...current, documentId: sender.documentId }, message.report || {});
      await save(state); await notify(events, state); return { state: C.publicState(state) };
    }
    case 'MW_BIND_TAB': {
      if (!mailSender(sender)) throw new Error('请在邮箱页面绑定。');
      const current = await chrome.tabs.get(sender.tab.id);
      const fresh = await chrome.tabs.sendMessage(current.id, { type: 'MW_COLLECT' }, { frameId: 0 });
      if (!fresh?.ok || !fresh.report || C.provider(current.url) !== C.provider(sender.url)) throw new Error('邮箱页面已经改变，请重新检查。');
      await processSnapshot(state, current, fresh.report);
      const tab = state.tabs[sender.tab.id];
      if (!tab?.email || Date.now() - tab.at > 30000) throw new Error('请先检查当前页面并确认邮箱身份。');
      await addMailbox(state, { provider: tab.provider, email: tab.email, shop: message.shop });
      await save(state); return { state: C.publicState(state) };
    }
    case 'MW_ADD_MAILBOX': requireTrusted(sender); await addMailbox(state, message); await save(state); await scanTabs(state); return { state: C.publicState(state) };
    case 'MW_UPDATE_MAILBOX': {
      requireTrusted(sender); const box = state.mailboxes.find(b => b.id === message.id);
      if (!box) throw new Error('邮箱不存在。');
      if (typeof message.shop === 'string' && message.shop.trim()) box.shop = C.clean(message.shop, 80);
      if (typeof message.enabled === 'boolean') box.enabled = message.enabled;
      C.log(state, 'info', `${box.shop} ${box.enabled ? '已启用监听' : '已暂停监听'}。`, Date.now(), box.id);
      await save(state); if (box.enabled) await scanTabs(state); return { state: C.publicState(state) };
    }
    case 'MW_REMOVE_MAILBOX': {
      requireTrusted(sender); const box = state.mailboxes.find(b => b.id === message.id);
      if (state.events.some(e => e.mailboxId === message.id && ['pending', 'failed'].includes(e.delivery))) throw new Error('此邮箱仍有待上传记录，请先处理队列或暂停监听。');
      state.mailboxes = state.mailboxes.filter(b => b.id !== message.id);
      for (const tab of Object.values(state.tabs)) if (tab.mailboxId === message.id) { tab.mailboxId = ''; tab.status = 'unbound'; }
      C.log(state, 'info', `已移除 ${box?.shop || '邮箱'}，历史记录保留。`); await save(state); return { state: C.publicState(state) };
    }
    case 'MW_SCAN': requireTrusted(sender); await scanTabs(state); return { state: C.publicState(state) };
    case 'MW_SYNC': requireTrusted(sender); await scanTabs(state); await sync(state, true); return { state: C.publicState(state) };
    case 'MW_SETTINGS': {
      requireTrusted(sender);
      if (message.deviceName != null) state.settings.deviceName = C.clean(message.deviceName, 80) || '我的 Windows 电脑';
      if (message.desktopNotifications != null) {
        if (message.desktopNotifications && !(await chrome.permissions.contains({ permissions: ['notifications'] }))) throw new Error('请先允许浏览器通知权限。');
        state.settings.desktopNotifications = !!message.desktopNotifications;
      }
      await save(state); return { state: C.publicState(state) };
    }
    case 'MW_PANEL': state.settings.panelCollapsed = !!message.collapsed; await save(state); return {};
    case 'MW_OPEN_DASHBOARD': await chrome.runtime.openOptionsPage(); return {};
    case 'MW_OPEN_MAILBOX': {
      requireTrusted(sender); const box = state.mailboxes.find(b => b.id === message.id);
      if (!box) throw new Error('邮箱不存在。');
      const live = C.boxHealth(state, box).tabs.find(t => t.email === box.email);
      if (live) { try { await chrome.tabs.update(live.tabId, { active: true }); return {}; } catch (_) {} }
      await chrome.tabs.create({ url: C.mailboxUrl(box) }); return {};
    }
    case 'MW_PAIR': {
      requireTrusted(sender);
      const server = C.normalizeServer(message.server);
      const pending = state.events.filter(e => e.delivery === 'pending');
      if (pending.length && server !== state.connection.server) throw new Error('请先上传当前待发送记录，再更换中央网站。');
      if (!String(message.code || '').trim()) throw new Error('请输入中央网站生成的一次性配对码。');
      const result = await request(server, 'enroll', '', { protocol_version: 1, pairing_code: C.clean(message.code, 200),
        device_id: state.deviceId, device_name: state.settings.deviceName, extension_version: C.VERSION });
      if (typeof result.access_token !== 'string' || !result.access_token || typeof result.server_id !== 'string' || !result.server_id) throw new Error('中央网站没有返回有效设备凭证。');
      if (pending.some(e => e.destination !== result.server_id)) throw new Error('新网站身份与待上传队列不一致，已保留原连接和队列。');
      state.connection = { status: 'connected', server, serverId: C.clean(result.server_id, 128), lastHeartbeatAt: null, error: '' };
      C.log(state, 'info', '设备已配对；本地历史记录不会自动上传。');
      await S.set({ [CREDENTIALS]: { token: result.access_token }, [STATE]: state });
      await badge(state); await sync(state); return { state: C.publicState(state) };
    }
    case 'MW_DISCONNECT': {
      requireTrusted(sender);
      if (state.events.some(e => e.delivery === 'pending')) throw new Error('还有待上传记录。为避免丢失，请恢复连接后上传，或继续保留本地队列。');
      state.connection = { status: 'local', server: state.connection.server, serverId: '', lastHeartbeatAt: null, error: '' };
      state.verificationRequests = []; C.log(state, 'info', '已断开中央连接，后续消息只保存在本地。');
      await S.set({ [CREDENTIALS]: null, [STATE]: state }); await badge(state); return { state: C.publicState(state) };
    }
    default: throw new Error('未知插件操作。');
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  serial(() => handle(message, sender)).then(data => reply({ ok: true, ...data }), error => reply({ ok: false, error: C.clean(error.message, 300) }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) serial(async () => { const state = await readState(); await scanTabs(state); await sync(state); }); });
chrome.tabs.onRemoved.addListener(tabId => serial(async () => {
  const state = await readState(); const record = state.tabs[tabId];
  if (record) { C.log(state, 'warn', `${record.email || '邮箱'} 页面已关闭。`, Date.now(), record.mailboxId); delete state.tabs[tabId]; await save(state); }
}));
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (!changes.url && changes.status !== 'loading') return;
  serial(async () => { const state = await readState(); const record = state.tabs[tabId];
    if (record) { record.status = 'loading'; record.at = Date.now(); record.detail = '页面正在切换，等待重新识别账号。'; await save(state); }
  });
});
chrome.runtime.onStartup.addListener(() => serial(async () => { const state = await readState(); await scanTabs(state); await sync(state); }));
chrome.runtime.onInstalled.addListener(() => serial(async () => { const state = await readState(); C.log(state, 'info', '插件已就绪。已打开的邮箱页面需要刷新一次。'); await scanTabs(state); }));
