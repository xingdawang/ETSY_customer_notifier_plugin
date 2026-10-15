/* DOM adapters intentionally read list metadata only: no body, attachments, or private web APIs. */
(function (root) {
  'use strict';
  const C = root.MailWatchCore;
  const texts = node => C.clean(node?.textContent || '', 350);
  function nodes(doc, selector) { return Array.from(doc.querySelectorAll(selector)); }
  function visible(node) { return !node.closest('[hidden],[aria-hidden="true"]') && node.getClientRects().length > 0; }
  function activeIdentity(doc, p) {
    const selector = p === 'gmail'
      ? '[data-mailwatch-account], a[href*="accounts.google.com/SignOutOptions"], button[aria-label*="Google Account"], a[aria-label*="Google Account"], [aria-label*="Google 账号"], [aria-label*="Google 帳戶"]'
      : '[data-mailwatch-account], #mectrl_currentAccount_secondary, #O365_MainLink_Me, #mectrl_headerPicture, [data-testid="current-account"]';
    const candidates = nodes(doc, selector).filter(visible);
    const anchor = candidates.find(n => n.matches(p === 'gmail' ? 'a[href*="SignOutOptions"],button[aria-label],a[aria-label]' : '#O365_MainLink_Me,#mectrl_headerPicture'));
    const identityToken = anchor ? [anchor.getAttribute('aria-label'), anchor.getAttribute('title'), texts(anchor)].join('|') : '';
    for (const n of candidates) {
      const address = C.email(n.getAttribute('data-mailwatch-account')) || C.email(n.getAttribute('aria-label')) || C.email(n.getAttribute('title')) || C.email(texts(n));
      if (address) return { email: address, identityToken };
    }
    return { email: '', identityToken };
  }
  function dateMetadata(row, p) {
    const node = row.querySelector(p === 'gmail' ? '[data-received-at], .xW [title], .xW time, time[datetime]' : '[data-received-at], time[datetime], [data-testid="received-time"], [data-time]');
    if (!node) return { receivedAt: null, timeHint: '' };
    const raw = node.getAttribute('data-received-at') || node.getAttribute('datetime') || node.getAttribute('data-time') || node.getAttribute('title') || '';
    const numeric = /^\d{10,13}$/.test(raw) ? Number(raw) * (raw.length === 10 ? 1000 : 1) : NaN;
    const stamp = Number.isFinite(numeric) ? numeric : Date.parse(raw);
    // Relative labels such as "刚刚" are not stable revision identifiers.
    return { receivedAt: Number.isFinite(stamp) ? new Date(stamp).toISOString() : null, timeHint: raw.length > 8 ? C.clean(raw, 120) : '' };
  }
  function senderMetadata(row, p) {
    const selector = p === 'gmail' ? '[email], [data-hovercard-id], [data-sender], .yW .yP, .yW .zF' : '[data-sender], [data-testid="message-sender"], [data-testid="sender"], [title*="@"], [aria-label*="@"]';
    for (const n of nodes(row, selector)) {
      const address = C.email(n.getAttribute('email')) || C.email(n.getAttribute('data-hovercard-id')) || C.email(n.getAttribute('data-sender')) || C.email(n.getAttribute('title')) || C.email(n.getAttribute('aria-label'));
      if (address) return { sender: address, senderName: texts(n) };
    }
    const named = row.querySelector(p === 'gmail' ? '.yW .yP,.yW .zF,[data-sender-name]' : '[data-sender-name],[data-testid="message-sender"],[data-testid="sender"]');
    if (named) return { sender: '', senderName: named.getAttribute('data-sender-name') || texts(named) };
    // Outlook sometimes renders only a sender display name as a separate leaf.
    const etsy = nodes(row, 'span').find(n => !n.children.length && /^(Etsy|Etsy Conversations|Etsy Messages)$/i.test(texts(n)));
    return { sender: '', senderName: etsy ? texts(etsy) : '' };
  }
  function messageMetadata(row, p) {
    let title = row.querySelector(p === 'gmail' ? '.bog, [data-subject], [data-testid="message-subject"]' : '[data-subject], [data-testid="message-subject"], [data-testid="subject"]');
    if (!title && p === 'outlook') {
      title = nodes(row, 'span').find(n => !n.children.length && (/^(?:(?:Re|Fw|Fwd):\s*)*Etsy Conversation with .+/i.test(texts(n)) || /needs help with an order they placed[.!]?$/i.test(texts(n))));
    }
    const subject = C.clean(title?.getAttribute('data-subject') || texts(title));
    if (!subject) return null;
    const idNode = row.matches('[data-legacy-message-id],[data-legacy-last-message-id],[data-message-id]') ? row : row.querySelector('[data-legacy-message-id],[data-legacy-last-message-id],[data-message-id]');
    const threadNode = row.matches('[data-legacy-thread-id],[data-thread-id],[data-convid],[data-itemid]') ? row : row.querySelector('[data-legacy-thread-id],[data-thread-id],[data-convid],[data-itemid]');
    const messageId = idNode?.getAttribute('data-legacy-message-id') || idNode?.getAttribute('data-legacy-last-message-id') || idNode?.getAttribute('data-message-id');
    const threadId = threadNode?.getAttribute('data-legacy-thread-id') || threadNode?.getAttribute('data-thread-id') || threadNode?.getAttribute('data-convid') || threadNode?.getAttribute('data-itemid');
    const count = row.querySelector('[data-thread-count],.yW .bq3');
    return { subject, ...senderMetadata(row, p), ...dateMetadata(row, p),
      sourceId: messageId || threadId || '', identityKind: messageId ? 'message' : threadId ? 'thread' : 'fingerprint',
      threadCount: C.clean(count?.getAttribute('data-thread-count') || texts(count), 20) };
  }
  function read(doc, url) {
    const p = C.provider(url);
    if (!p) throw new Error('不支持此邮箱页面。');
    const u = new URL(url);
    const report = { provider: p, ...activeIdentity(doc, p), accountRoute: p === 'gmail' ? u.pathname : u.pathname.match(/^\/mail(?:\/\d+)?/)?.[0] || u.pathname,
      status: 'view_unavailable', detail: '', rowCount: 0, messages: [] };
    if (doc.querySelector('input[type="password"],input[name="loginfmt"]')) { report.status = 'login_required'; report.detail = '请先在邮箱页面完成登录。'; return report; }
    const inbox = p === 'gmail' ? /^#inbox(?:$|\/)/.test(u.hash) : /\/mail(?:\/\d+)?\/(?:inbox)(?:$|\/)/i.test(u.pathname);
    if (!inbox) { report.status = 'wrong_folder'; report.detail = '只监听当前收件箱列表；请切回收件箱。'; return report; }
    const rowSelector = p === 'gmail' ? 'tr.zA, [data-mailwatch-row]' : '[role="option"][data-convid], [role="option"][data-itemid], [role="option"][aria-selected], [data-mailwatch-row]';
    const rows = nodes(doc, rowSelector).filter(visible).slice(0, 500);
    report.rowCount = rows.length;
    const list = doc.querySelector(p === 'gmail' ? '[role="main"] table, [data-mailwatch-list]' : '[role="listbox"], [data-mailwatch-list]');
    if (!rows.length && !list) { report.detail = '邮件列表未加载，或正在阅读邮件。'; return report; }
    report.messages = rows.map(row => messageMetadata(row, p)).filter(Boolean);
    const incomplete = rows.length !== report.messages.length || report.messages.some(m => !m.sender || m.identityKind !== 'message' || !m.receivedAt);
    report.status = incomplete ? 'limited' : 'watching';
    report.listStatus = report.status;
    report.detail = incomplete ? '当前可见列表；部分邮件缺少完整地址、时间或逐邮件标识，提醒可能需要核实。' : '当前可见列表可读；未渲染、其他分类和文件夹不在扫描范围内。';
    if (!report.email) { report.status = 'identity_unknown'; report.detail = '请打开邮箱右上角头像菜单，让插件确认当前邮箱地址。'; }
    return report;
  }
  root.MailWatchAdapters = { read, activeIdentity, messageMetadata };
})(globalThis);
