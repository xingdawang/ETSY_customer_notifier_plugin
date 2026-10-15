(() => {
  'use strict';
  if (globalThis.__etsySentinelMounted || window.top !== window) return;
  globalThis.__etsySentinelMounted = true;
  const documentNonce = crypto.randomUUID();
  let cachedIdentity, timer, stopped = false;
  const host = document.createElement('div');
  host.id = 'etsy-sentinel';
  host.style.cssText = 'all:initial;position:fixed;right:18px;top:95px;z-index:2147483646;display:block';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>*{box-sizing:border-box}[hidden]{display:none!important}.frame{display:block;width:min(304px,calc(100vw - 36px));height:320px;background:white;border:1px solid #e4dfd6;border-radius:13px;box-shadow:0 9px 32px #25211c20}.collapse{position:absolute;right:13px;top:14px;border:1px solid #e4dfd6;border-radius:50%;width:25px;height:25px;background:white;color:#827c70;cursor:pointer}.bubble{width:46px;height:46px;border:0;border-radius:50%;background:#302e29;color:white;font:700 17px system-ui;box-shadow:0 5px 20px #0002;cursor:pointer}</style><iframe class="frame" id="connection-frame" title="插件凭证连接"></iframe><button class="collapse" id="collapse" aria-label="收起" title="收起">−</button><button class="bubble" id="expand" aria-label="展开插件" title="展开插件" hidden>E</button>`;
  const frame = shadow.getElementById('connection-frame');
  frame.src = chrome.runtime.getURL('connection.html');
  document.documentElement.appendChild(host);
  async function call(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error('Extension unavailable');
    return result;
  }
  function collapse(value) {
    frame.hidden = shadow.getElementById('collapse').hidden = value;
    shadow.getElementById('expand').hidden = !value;
  }
  shadow.getElementById('collapse').onclick = () => { collapse(true); call({ type: 'MW_PANEL', collapsed: true }).catch(() => {}); };
  shadow.getElementById('expand').onclick = () => { collapse(false); call({ type: 'MW_PANEL', collapsed: false }).catch(() => {}); };
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== chrome.runtime.getURL('').replace(/\/$/, '') || event.data?.type !== 'MW_PANEL_HEIGHT') return;
    const height = Number(event.data.height);
    if (Number.isFinite(height)) frame.style.height = `${Math.max(155, Math.min(480, height + 2))}px`;
  });
  function collect() {
    const report = MailWatchAdapters.read(document, location.href);
    if (report.email) cachedIdentity = { email: report.email, token: report.identityToken, route: report.accountRoute };
    else if (report.identityToken && cachedIdentity?.token === report.identityToken && cachedIdentity.route === report.accountRoute && report.status !== 'login_required') {
      report.email = cachedIdentity.email;
      if (report.status === 'identity_unknown') report.status = report.listStatus || 'view_unavailable';
    } else cachedIdentity = null;
    return { ...report, documentNonce, pageUrl: location.href };
  }
  async function scan() {
    if (stopped) return;
    try { const result = await call({ type: 'MW_CONNECTION' }); if (result.connection.authenticated) await call({ type: 'MW_REPORT', report: collect() }); }
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
  let interval = setInterval(scan, 30000);
  window.addEventListener('pagehide', () => { observer.disconnect(); clearInterval(interval); interval = null; clearTimeout(timer); timer = null; });
  window.addEventListener('pageshow', event => { if (event.persisted) { cachedIdentity = null; observer.observe(document.documentElement, options); if (!interval) interval = setInterval(scan, 30000); scan(); } });
  window.addEventListener('online', scan);
  window.addEventListener('hashchange', scan);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scan(); });
  call({ type: 'MW_CONNECTION' }).then(result => { collapse(result.connection.panelCollapsed); scan(); }).catch(() => {});
})();
