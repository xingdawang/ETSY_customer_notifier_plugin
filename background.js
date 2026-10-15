/* A device credential authenticates this installation, not a mailbox or website user. */
importScripts('core.js', 'storage.js', 'config.js');
const C = MailWatchCore, S = MailWatchStorage;
const STATE = 'mailwatchState', ALARM = 'mailwatch-tick', sessionId = crypto.randomUUID();
let operation = Promise.resolve();
const ready = (async () => {
  await S.ready;
  const stored = (await S.get(STATE))[STATE];
  if (!stored || stored.schema !== 2) {
    const fresh = C.createState();
    fresh.connection.server = stored?.connection?.server || MailWatchConfig.serverUrl;
    fresh.panelCollapsed = !!stored?.settings?.panelCollapsed;
    await S.set({ ...(stored ? { mailwatchV1Archive: stored, mailwatchCredentials: null } : {}), [STATE]: fresh });
  }
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
})();
function serial(work) {
  const result = operation.then(() => ready).then(work);
  operation = result.catch(() => {});
  return result;
}
async function readState() { return (await S.get(STATE))[STATE]; }
async function save(state) { await S.set({ [STATE]: state }); }
function uiSender(sender) { return sender.id === chrome.runtime.id && String(sender.url || '').split('?')[0] === chrome.runtime.getURL('connection.html'); }
function mailSender(sender) { return sender.id === chrome.runtime.id && sender.frameId === 0 && sender.tab?.id != null && !!C.provider(sender.url); }
function delay(failures, retryAfter = 0) { return Math.max(retryAfter, Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 5))); }
async function request(server, endpoint, token, body) {
  if (!(await chrome.permissions.contains({ origins: [C.permissionPattern(server)] }))) throw new Error('请重新登录并允许连接中央服务器。');
  let response;
  try {
    response = await fetch(server + '/api/extension/v2/' + endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(7000) });
  } catch (_) { throw new Error('暂时无法连接中央服务器，请稍后重试。'); }
  if (response.status === 401 || response.status === 403) { const error = new Error('插件凭证无效或已停用，请核对账户和密码。'); error.auth = true; throw error; }
  if (!response.ok) {
    const error = new Error(response.status === 404 ? '中央服务器尚未接入插件凭证接口。' : `中央服务器暂不可用（${response.status}）。`);
    const after = response.headers.get('Retry-After');
    error.retryAfter = after ? Math.max(0, /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()) : 0;
    throw error;
  }
  let data;
  try { data = await response.json(); } catch (_) { throw new Error('中央服务器未返回有效验证结果。'); }
  if (data.ok !== true || data.protocol_version !== 2) throw new Error('中央服务器未提供匹配的插件凭证接口。');
  return data;
}
function verifyIdentity(data, connection) {
  if (data.account !== connection.account || data.device_id !== connection.deviceId) throw new Error('中央服务器返回的插件身份不一致，已停止本次上报。');
}
async function scanTabs(state) {
  if (!C.active(state)) return;
  const tabs = await chrome.tabs.query({}), supported = tabs.filter(t => C.provider(t.url));
  const present = new Set(tabs.map(t => t.id));
  for (const id of Object.keys(state.tabs)) if (!present.has(Number(id))) delete state.tabs[id];
  const replies = await Promise.allSettled(supported.map(async tab => {
    if (tab.discarded || tab.frozen) return { sleeping: true };
    const response = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'MW_COLLECT' }, { frameId: 0 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('no response')), 2500))
    ]);
    if (!response?.ok || !response.report) throw new Error('no response');
    return response;
  }));
  for (let i = 0; i < supported.length; i++) {
    const tab = supported[i], result = replies[i];
    if (result.status === 'fulfilled' && result.value.report) await C.applySnapshot(state, tab, result.value.report);
    else state.tabs[tab.id] = { ...state.tabs[tab.id], tabId: tab.id, owner: state.connection.owner, provider: C.provider(tab.url),
      at: Date.now(), status: result.status === 'fulfilled' ? 'sleeping' : 'unavailable' };
  }
  for (const [id, record] of Object.entries(state.tabs)) if (!supported.some(t => t.id === Number(id))) {
    record.status = 'unavailable'; record.at = Date.now();
  }
  await save(state);
}
async function sync(state, force = false) {
  const c = state.connection;
  if (!C.active(state) || (!force && c.retryAt > Date.now())) return;
  try {
    state.sequence++;
    const ownerBoxes = state.mailboxes.filter(b => b.owner === c.owner);
    const data = await request(c.server, 'heartbeat', c.token, {
      protocol_version: 2, account: c.account, device_id: c.deviceId, installation_id: state.installationId,
      session_id: sessionId, sequence: state.sequence, extension_version: C.VERSION, sent_at: new Date().toISOString(),
      previous_challenge: c.challenge || null,
      pending_event_count: state.events.filter(e => e.owner === c.owner && e.delivery === 'pending').length,
      last_upload_error: c.uploadError || '',
      mailboxes: ownerBoxes.map(b => ({ mailbox_id: b.id, provider: b.provider, email: b.email,
        ...C.mailboxHealth(state, b), coverage: 'visible_rows' })),
      unidentified_pages: Object.values(state.tabs).filter(t => t.owner === c.owner && !t.email).length
    });
    verifyIdentity(data, c);
    c.status = 'connected'; c.error = ''; c.lastHeartbeatAt = Date.now(); c.failures = 0; c.retryAt = 0;
    c.challenge = data.challenge && typeof data.challenge.nonce === 'string' && Date.parse(data.challenge.expires_at) > Date.now()
      ? { id: C.clean(data.challenge.id, 64), nonce: C.clean(data.challenge.nonce, 256), expires_at: data.challenge.expires_at } : null;
    const pending = state.events.filter(e => e.owner === c.owner && e.delivery === 'pending').slice(0, 50);
    if (pending.length && (force || !(c.uploadRetryAt > Date.now()))) {
      for (const event of pending) event.attempts++;
      await save(state);
      try {
        const result = await request(c.server, 'events', c.token, { protocol_version: 2, account: c.account, device_id: c.deviceId,
          installation_id: state.installationId, events: pending.map(({ owner, delivery, ...event }) => ({ ...event, event_id: event.id })) });
        verifyIdentity(result, c);
        const acknowledged = new Set(Array.isArray(result.acknowledged_event_ids) ? result.acknowledged_event_ids : []);
        for (const event of pending) if (acknowledged.has(event.id)) { event.delivery = 'uploaded'; event.uploadedAt = Date.now(); }
        if (!pending.every(e => e.delivery === 'uploaded')) throw new Error('部分消息尚未确认，后台将自动重试。');
        c.uploadFailures = 0; c.uploadRetryAt = 0; c.uploadError = '';
      } catch (error) {
        if (error.auth) throw error;
        c.uploadError = error.message; c.uploadFailures = (c.uploadFailures || 0) + 1;
        c.uploadRetryAt = Date.now() + delay(c.uploadFailures, error.retryAfter);
      }
    }
  } catch (error) {
    c.status = error.auth ? 'auth_required' : 'error'; c.error = error.message;
    if (error.auth) c.token = '';
    c.failures = (c.failures || 0) + 1; c.retryAt = Date.now() + delay(c.failures, error.retryAfter);
  }
  await save(state);
}
async function tick() { const state = await readState(); if (!C.active(state)) return; await scanTabs(state); await sync(state); }
async function handle(message, sender) {
  if (!message || (!uiSender(sender) && !mailSender(sender))) throw new Error('请求来源无效。');
  const state = await readState();
  switch (message.type) {
    case 'MW_CONNECTION': return { connection: C.publicConnection(state) };
    case 'MW_PANEL': {
      if (typeof message.collapsed === 'boolean') state.panelCollapsed = message.collapsed;
      if (message.position && ['x', 'y'].every(key => Number.isFinite(message.position[key]) && message.position[key] >= 0 && message.position[key] <= 100000)) {
        state.panelPosition = { x: message.position.x, y: message.position.y };
      }
      await save(state); return {};
    }
    case 'MW_REPORT': {
      if (!mailSender(sender)) throw new Error('仅接受邮箱页面报告。');
      if (!C.active(state)) return {};
      const tab = await chrome.tabs.get(sender.tab.id);
      if (C.provider(tab.url) !== C.provider(sender.url)) return {};
      const live = await chrome.tabs.sendMessage(tab.id, { type: 'MW_DOCUMENT_INFO' }, { frameId: 0 });
      if (!live?.ok || live.documentNonce !== message.report?.documentNonce || live.pageUrl !== message.report?.pageUrl || live.email !== message.report?.email) return {};
      await C.applySnapshot(state, tab, message.report || {}); await save(state); return {};
    }
    case 'MW_LOGIN': {
      if (!uiSender(sender)) throw new Error('请在插件凭证面板登录。');
      const server = C.normalizeServer(message.server);
      const account = C.clean(message.account, 80);
      if (!account || typeof message.password !== 'string' || !message.password || message.password.length > 1024) throw new Error('请输入分配给此插件的账户和密码。');
      const result = await request(server, 'login', '', { protocol_version: 2, account, password: message.password,
        installation_id: state.installationId, extension_version: C.VERSION });
      if (result.account !== account || typeof result.access_token !== 'string' || !result.access_token || typeof result.device_id !== 'string' || !result.device_id || result.device_id.length > 128) throw new Error('中央服务器未确认正确的插件身份。');
      const owner = await C.digest(`${server}:${result.device_id}:${account}`);
      state.connection = { server, account, deviceId: result.device_id, owner, token: result.access_token,
        status: 'connected', error: '', lastHeartbeatAt: null };
      await save(state);
      await scanTabs(state); await sync(state, true);
      return { connection: C.publicConnection(state) };
    }
    case 'MW_LOGOUT': {
      if (!uiSender(sender)) throw new Error('请在插件凭证面板退出。');
      const old = { ...state.connection };
      // Local logout always stops collection, including when the server is unavailable.
      state.connection = { status: 'disconnected', server: old.server, account: old.account, token: '', owner: '', deviceId: '', lastHeartbeatAt: null, error: '' };
      await save(state);
      if (old.token) { try { await request(old.server, 'logout', old.token, { protocol_version: 2, account: old.account, device_id: old.deviceId, installation_id: state.installationId }); } catch (_) {} }
      return { connection: C.publicConnection(state) };
    }
    default: throw new Error('未知插件操作。');
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  serial(() => handle(message, sender)).then(result => reply({ ok: true, ...result }), error => reply({ ok: false, error: C.clean(error.message, 200) }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) serial(tick); });
chrome.tabs.onRemoved.addListener(tabId => serial(async () => { const state = await readState(); delete state.tabs[tabId]; await save(state); }));
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (!changes.url && changes.status !== 'loading') return;
  serial(async () => { const state = await readState(); if (state.tabs[tabId]) { state.tabs[tabId].status = 'loading'; state.tabs[tabId].at = Date.now(); await save(state); } });
});
chrome.runtime.onStartup.addListener(() => serial(tick));
chrome.runtime.onInstalled.addListener(() => serial(tick));
