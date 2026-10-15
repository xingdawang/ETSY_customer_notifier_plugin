(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = MailWatchCore;
  const isPopup = document.body.classList.contains('popup');
  let state, initialized = false, toastTimer, refreshBusy = false;
  const connectionLabels = { local: '本地模式', connected: '已配对', stale: '心跳已过期', error: '连接异常', auth_required: '需要重新配对' };
  const deliveryLabels = { local: '仅本地', pending: '待上报', uploaded: '已上报', failed: '上报失败' };
  const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '尚未检查';
  function element(tag, className, value) { const el = document.createElement(tag); if (className) el.className = className; if (value != null) el.textContent = value; return el; }
  function toast(text, error = false) {
    $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
  }
  async function call(message) { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error || '插件后台未响应，请重新打开界面。'); if (result.state) { state = result.state; render(); } return result; }
  async function action(button, work, success) {
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try { await work(); if (success) toast(success); } catch (error) { toast(error.message, true); }
    finally { if (button) button.disabled = false; }
  }
  function pill(label, tone = 'neutral') { return element('span', `status-pill ${tone}`, label); }
  function providerIcon(provider) { return element('span', `provider-icon ${provider}`, provider === 'gmail' ? 'M' : 'O'); }
  function showPage(page) {
    for (const el of document.querySelectorAll('.page')) el.hidden = el.id !== `page-${page}`;
    for (const el of document.querySelectorAll('.nav-item')) el.classList.toggle('active', el.dataset.page === page);
    $('breadcrumb-current').textContent = { overview: '邮箱总览', messages: '消息记录', activity: '运行日志', settings: '设备与连接' }[page];
    location.hash = page;
  }
  function mailboxRows() {
    const container = $('mailbox-rows'); container.replaceChildren();
    $('mailbox-empty').hidden = !!state.mailboxes.length;
    $('mailbox-table-wrap').hidden = !state.mailboxes.length;
    for (const box of state.mailboxes) {
      const tr = document.createElement('tr');
      const account = element('td'); const cell = element('div', 'account-cell'); const text = element('div');
      text.append(element('strong', '', box.shop), element('small', '', box.email)); cell.append(providerIcon(box.provider), text); account.append(cell);
      const status = element('td'); status.append(pill(box.health.label, box.health.tone));
      const detail = box.health.tabs.find(t => t.detail)?.detail || (box.baselined ? '请打开已登录的收件箱。' : '等待打开邮箱并建立基线。');
      const note = element('span', 'cell-note', detail); note.title = detail; status.append(note);
      const scan = element('td', '', formatTime(box.health.lastScanAt));
      if (box.health.lastScanAt) scan.append(element('span', 'cell-note', box.health.code === 'stale' ? '历史记录，当前状态已过期' : '仅当前可见列表'));
      const verification = element('td'); verification.append(pill(box.verifiedAt ? '已验证' : '未验证', box.verifiedAt ? 'good' : 'neutral'));
      verification.append(element('span', 'cell-note', box.verifiedAt ? formatTime(box.verifiedAt) : '等待中央收信验证'));
      const actions = element('td', 'align-right'), buttons = element('div', 'row-actions');
      const open = element('button', '', '打开'); open.onclick = () => action(open, () => call({ type: 'MW_OPEN_MAILBOX', id: box.id }));
      const toggle = element('button', '', box.enabled ? '暂停' : '继续'); toggle.onclick = () => action(toggle, () => call({ type: 'MW_UPDATE_MAILBOX', id: box.id, enabled: !box.enabled }));
      const rename = element('button', '', '改名'); rename.onclick = () => { const name = prompt('店铺名称', box.shop); if (name?.trim()) action(rename, () => call({ type: 'MW_UPDATE_MAILBOX', id: box.id, shop: name })); };
      const remove = element('button', '', '移除'); remove.onclick = () => { if (confirm(`移除 ${box.shop} 的邮箱绑定？历史记录会保留。`)) action(remove, () => call({ type: 'MW_REMOVE_MAILBOX', id: box.id })); };
      buttons.append(open, toggle, rename, remove); actions.append(buttons); tr.append(account, status, scan, verification, actions); container.append(tr);
    }
  }
  function messageList(target, entries) {
    target.replaceChildren();
    if (!entries.length) { target.append(element('div', 'inline-empty', '还没有匹配记录。发现新消息后会显示在这里。')); return; }
    for (const entry of entries) {
      const row = element('article', 'message-row'), info = element('div', 'message-info');
      info.append(element('div', 'message-subject', entry.subject));
      const meta = element('div', 'message-meta');
      meta.append(element('span', '', entry.shop), element('span', '', entry.email), element('span', '', formatTime(entry.detectedAt)));
      if (entry.kind === 'verification') meta.append(element('span', '', '系统收信验证'));
      else if (entry.confidence === 'display_name') meta.append(element('span', '', '显示名称识别 · 待核实'));
      if (entry.kind !== 'verification' && entry.identityKind !== 'message') meta.append(element('span', '', '会话 / 特征去重'));
      info.append(meta); row.append(element('span', 'message-symbol', '✉'), info, element('span', 'message-status', deliveryLabels[entry.delivery] || entry.delivery)); target.append(row);
    }
  }
  function renderMessages() {
    const search = $('message-search').value.trim().toLowerCase(), delivery = $('delivery-filter').value;
    const entries = state.events.filter(e => (!delivery || e.delivery === delivery) && `${e.subject} ${e.email} ${e.shop}`.toLowerCase().includes(search));
    messageList($('message-list'), entries);
  }
  function renderActivity() {
    const list = $('activity-list'); list.replaceChildren();
    if (!state.log.length) list.append(element('div', 'inline-empty', '暂无运行日志。'));
    for (const entry of state.log) {
      const row = element('div', 'activity-row'), text = element('div');
      text.append(element('div', 'activity-text', entry.text), element('div', 'activity-time', formatTime(entry.at)));
      row.append(element('span', `activity-dot ${entry.level}`), text); list.append(row);
    }
  }
  function renderPopup() {
    $('popup-total').textContent = state.counts.total; $('popup-readable').textContent = state.counts.readable; $('popup-today').textContent = state.counts.today;
    $('popup-connection').textContent = connectionLabels[state.connection.status] || '待检查';
    $('popup-subtitle').textContent = state.counts.total ? `本机 ${state.counts.total} 个邮箱，${state.counts.readable} 个页面可读。` : '还没有绑定邮箱。打开管理页，或使用邮箱右侧面板开始。';
    const list = $('popup-mailboxes'); list.replaceChildren();
    for (const box of state.mailboxes.slice(0, 4)) {
      const row = element('div', 'popup-account'), text = element('div');
      text.append(element('strong', '', box.shop), element('small', '', box.email));
      row.append(providerIcon(box.provider), text, pill(box.health.label, box.health.tone)); list.append(row);
    }
    if (state.mailboxes.length > 4) list.append(element('div', 'inline-empty', `另有 ${state.mailboxes.length - 4} 个邮箱，打开管理页查看。`));
  }
  function render() {
    if (!state) return;
    if (isPopup) { renderPopup(); return; }
    $('sidebar-device').textContent = state.settings.deviceName;
    $('nav-count').textContent = $('mailbox-count').textContent = state.counts.total;
    $('stat-total').textContent = state.counts.total;
    $('stat-readable').replaceChildren(document.createTextNode(String(state.counts.readable)), element('span', '', ` / ${state.counts.total}`));
    $('stat-today').textContent = state.counts.today; $('stat-pending').textContent = state.counts.pending;
    $('pending-description').textContent = state.connection.status === 'local' ? '连接中央网站后启用' : '确认入库后才移出队列';
    $('connection-pill').textContent = `○ ${connectionLabels[state.connection.status] || '待检查'}`;
    $('connection-pill').classList.toggle('connected', state.connection.status === 'connected');
    $('settings-connection').textContent = connectionLabels[state.connection.status] || '待检查';
    $('settings-connection').className = `status-pill ${state.connection.status === 'connected' ? 'good' : state.connection.status === 'local' ? 'neutral' : 'warn'}`;
    $('device-id').textContent = state.deviceId;
    $('notification-toggle').setAttribute('aria-checked', String(state.settings.desktopNotifications));
    const paired = !!state.connection.serverId;
    $('pair-form').hidden = paired && state.connection.status !== 'auth_required';
    $('connection-details').hidden = !paired;
    $('connected-server').textContent = state.connection.server;
    $('last-heartbeat').textContent = formatTime(state.connection.lastHeartbeatAt);
    $('connection-error').textContent = state.connection.error || state.connection.uploadError || '';
    if (!initialized) { $('device-name').value = state.settings.deviceName; $('server-url').value = state.connection.server; initialized = true; }
    mailboxRows(); messageList($('recent-messages'), state.events.filter(e => e.kind !== 'verification').slice(0, 3)); renderMessages(); renderActivity();
  }
  function download(name, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  if (isPopup) {
    $('open-dashboard').onclick = () => action($('open-dashboard'), () => call({ type: 'MW_OPEN_DASHBOARD' }));
    $('popup-scan').onclick = () => action($('popup-scan'), () => call({ type: 'MW_SCAN' }), '页面检查完成');
  } else {
    document.querySelectorAll('[data-page]').forEach(button => { button.onclick = () => showPage(button.dataset.page); });
    const openDialog = () => { $('mailbox-dialog').showModal(); $('mailbox-email').focus(); };
    $('add-button').onclick = $('empty-add').onclick = openDialog;
    $('close-dialog').onclick = $('cancel-dialog').onclick = () => $('mailbox-dialog').close();
    $('mailbox-form').onsubmit = event => {
      event.preventDefault(); const button = event.submitter;
      action(button, async () => {
        await call({ type: 'MW_ADD_MAILBOX', provider: $('mailbox-provider').value, email: $('mailbox-email').value, shop: $('mailbox-shop').value });
        $('mailbox-dialog').close(); $('mailbox-form').reset(); toast('已添加邮箱。请打开对应收件箱，确认实际登录账号一致。');
      });
    };
    $('scan-button').onclick = () => action($('scan-button'), () => call({ type: 'MW_SCAN' }), '页面检查完成');
    $('sync-button').onclick = () => action($('sync-button'), () => call({ type: 'MW_SYNC' }), '同步检查完成，请查看连接结果');
    $('device-form').onsubmit = event => { event.preventDefault(); action(event.submitter, () => call({ type: 'MW_SETTINGS', deviceName: $('device-name').value }), '设备名称已保存'); };
    $('notification-toggle').onclick = async () => {
      const enabled = !state.settings.desktopNotifications;
      // Request optional permission directly inside the user's click handler.
      const permission = enabled ? chrome.permissions.request({ permissions: ['notifications'] }) : Promise.resolve(true);
      action($('notification-toggle'), async () => { if (!(await permission)) throw new Error('未允许桌面通知，邮件仍会保存在本地。'); await call({ type: 'MW_SETTINGS', desktopNotifications: enabled }); });
    };
    $('pair-form').onsubmit = event => {
      event.preventDefault();
      try {
        const server = C.normalizeServer($('server-url').value);
        const permission = chrome.permissions.request({ origins: [C.permissionPattern(server)] });
        action(event.submitter, async () => { if (!(await permission)) throw new Error('未授予中央网站访问权限。');
          await call({ type: 'MW_PAIR', server, code: $('pairing-code').value }); $('pairing-code').value = '';
          toast(state.connection.status === 'connected' ? '设备配对成功' : '已配对，请检查心跳连接状态', state.connection.status !== 'connected');
        });
      } catch (error) { toast(error.message, true); }
    };
    $('disconnect-button').onclick = () => action($('disconnect-button'), () => call({ type: 'MW_DISCONNECT' }), '已切换为本地模式');
    $('message-search').oninput = renderMessages; $('delivery-filter').onchange = renderMessages;
    $('export-button').onclick = () => download(`etsy-messages-${new Date().toISOString().slice(0, 10)}.json`, { exportedAt: new Date().toISOString(), events: state.events });
    $('diagnostic-button').onclick = () => download('etsy-sentinel-diagnostics.json', { version: state.version, deviceId: state.deviceId, connection: state.connection,
      mailboxes: state.mailboxes, log: state.log, note: '包含邮箱地址、页面 URL 和运行日志；不包含设备凭证、验证码及邮件正文。' });
    const page = location.hash.slice(1); showPage(['overview', 'messages', 'activity', 'settings'].includes(page) ? page : 'overview');
  }
  async function refresh() {
    if (refreshBusy || (document.hidden && state)) return;
    refreshBusy = true;
    try { await call({ type: 'MW_STATE' }); } catch (error) { toast(error.message, true); }
    finally { refreshBusy = false; }
  }
  refresh(); setInterval(refresh, 5000);
})();
