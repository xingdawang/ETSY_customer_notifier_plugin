(() => {
  'use strict';
  if (globalThis.__etsySentinelMounted || window.top !== window) return;
  globalThis.__etsySentinelMounted = true;
  const documentNonce = crypto.randomUUID();
  let pollSeconds = 30, lastScan = 0;
  let cachedIdentity, timer, stopped = false, preferredPosition = null, drag = null, suppressClick = false;
  const host = document.createElement('div');
  host.id = 'etsy-sentinel';
  host.style.cssText = 'all:initial;position:fixed;right:18px;top:95px;z-index:2147483646;display:block';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>*{box-sizing:border-box}[hidden]{display:none!important}.frame{display:block;width:min(304px,calc(100vw - 36px));height:320px;max-height:calc(100vh - 8px);background:white;border:1px solid #e4dfd6;border-radius:13px;box-shadow:0 9px 32px #25211c20}.collapse{position:absolute;right:13px;top:14px;border:1px solid #e4dfd6;border-radius:50%;width:25px;height:25px;background:white;color:#827c70;cursor:pointer}.bubble{width:46px;height:46px;border:0;border-radius:50%;background:#302e29;color:white;font:700 17px system-ui;box-shadow:0 5px 20px #0002;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}</style><iframe class="frame" id="connection-frame" title="插件凭证连接"></iframe><button class="collapse" id="collapse" aria-label="收起" title="收起">−</button><button class="bubble" id="expand" aria-label="展开插件" title="点击展开，拖动调整位置" hidden>哨</button>`;
  const frame = shadow.getElementById('connection-frame');
  frame.src = chrome.runtime.getURL('connection.html');
  document.documentElement.appendChild(host);
  async function call(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error('Extension unavailable');
    return result;
  }
  const bubble = shadow.getElementById('expand');
  function place(x, y) {
    const rect = host.getBoundingClientRect();
    const position = { x: Math.max(0, Math.min(x, innerWidth - rect.width)), y: Math.max(0, Math.min(y, innerHeight - rect.height)) };
    host.style.right = 'auto'; host.style.left = `${position.x}px`; host.style.top = `${position.y}px`;
    return position;
  }
  function fit() {
    const rect = host.getBoundingClientRect();
    place(preferredPosition?.x ?? innerWidth - rect.width - 18, preferredPosition?.y ?? 95);
  }
  function collapse(value) {
    frame.hidden = shadow.getElementById('collapse').hidden = value;
    bubble.hidden = !value;
    fit();
  }
  shadow.getElementById('collapse').onclick = () => { collapse(true); call({ type: 'MW_PANEL', collapsed: true }).catch(() => {}); };
  bubble.onclick = event => {
    if (suppressClick) { suppressClick = false; event.preventDefault(); return; }
    collapse(false); call({ type: 'MW_PANEL', collapsed: false }).catch(() => {});
  };
  bubble.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = host.getBoundingClientRect();
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    bubble.setPointerCapture(event.pointerId);
  });
  bubble.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true; bubble.style.cursor = 'grabbing';
    preferredPosition = place(drag.left + dx, drag.top + dy);
  });
  function finishDrag(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressClick = drag.moved && event.type === 'pointerup';
    if (drag.moved) call({ type: 'MW_PANEL', position: preferredPosition }).catch(() => {});
    drag = null; bubble.style.cursor = '';
    if (bubble.hasPointerCapture(event.pointerId)) bubble.releasePointerCapture(event.pointerId);
  }
  bubble.addEventListener('pointerup', finishDrag);
  bubble.addEventListener('pointercancel', finishDrag);
  window.addEventListener('resize', fit);
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== chrome.runtime.getURL('').replace(/\/$/, '') || event.data?.type !== 'MW_PANEL_HEIGHT') return;
    const height = Number(event.data.height);
    if (Number.isFinite(height)) { frame.style.height = `${Math.max(155, Math.min(480, height + 2))}px`; fit(); }
  });
  function collect() {
    const report = MailWatchAdapters.read(document, location.href);
    if (report.email) cachedIdentity = { email: report.email, token: report.identityToken, route: report.accountRoute };
    else if (report.identityToken && cachedIdentity?.token === report.identityToken && cachedIdentity.route === report.accountRoute && report.status !== 'login_required') {
      report.email = cachedIdentity.email;
      if (report.status === 'identity_unknown') report.status = report.listStatus || 'view_unavailable';
    } else cachedIdentity = null;
    return { ...report, documentNonce, pageUrl: location.href, pageHidden: document.hidden };
  }
  async function scan(periodic = false) {
    if (stopped) return;
    try { const result = await call({ type: 'MW_CONNECTION' });
      pollSeconds = [30, 60].includes(result.connection.pollSeconds) ? result.connection.pollSeconds : 30;
      if (periodic === true && Date.now() - lastScan < pollSeconds * 1000) return;
      lastScan = Date.now();
      if (result.connection.authenticated) await call({ type: 'MW_REPORT', report: collect() }); }
    catch (_) { if (!chrome.runtime?.id) stopped = true; }
  }
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    try {
      if (message.type === 'MW_DOCUMENT_INFO') { const report = collect(); reply({ ok: true, documentNonce, pageUrl: location.href, email: report.email }); }
      else if (message.type === 'MW_COLLECT') reply({ ok: true, report: collect() });
    } catch (_) { reply({ ok: false }); }
    return false;
  });
  const options = { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'email', 'data-legacy-message-id', 'data-legacy-last-message-id', 'data-legacy-thread-id', 'title', 'aria-selected'] };
  const observer = new MutationObserver(() => { if (!timer && !stopped) timer = setTimeout(() => { timer = null; scan(); }, 1500); });
  observer.observe(document.documentElement, options);
  let interval = setInterval(() => scan(true), 30000);
  window.addEventListener('pagehide', () => { observer.disconnect(); clearInterval(interval); interval = null; clearTimeout(timer); timer = null; });
  window.addEventListener('pageshow', event => { if (event.persisted) { cachedIdentity = null; observer.observe(document.documentElement, options); if (!interval) interval = setInterval(() => scan(true), 30000); scan(); } });
  window.addEventListener('online', scan);
  window.addEventListener('hashchange', scan);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scan(); });
  call({ type: 'MW_CONNECTION' }).then(result => { preferredPosition = result.connection.panelPosition; collapse(result.connection.panelCollapsed); scan(); }).catch(() => {});
})();
