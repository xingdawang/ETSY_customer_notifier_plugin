(() => {
  'use strict';
  if (globalThis.__etsySentinelMounted || window.top !== window) return;
  globalThis.__etsySentinelMounted = true;
  const C = MailWatchCore;
  const documentNonce = crypto.randomUUID();
  let state, latest, cachedIdentity, timer, destroyed = false;
  const host = document.createElement('div');
  host.id = 'etsy-sentinel';
  host.style.cssText = 'all:initial;position:fixed;right:18px;top:100px;z-index:2147483646;display:block';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#292824;color-scheme:light}
    #shell{font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#292824}*{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:wait}[hidden]{display:none!important}
    .panel{width:min(350px,calc(100vw - 36px));max-height:calc(100vh - 125px);overflow:auto;background:#fffefa;border:1px solid #dedbd3;border-radius:16px;box-shadow:0 12px 45px #25211c24}
    header{display:flex;align-items:center;gap:10px;padding:16px;border-bottom:1px solid #eeeae2}.logo{display:grid;place-items:center;width:35px;height:35px;background:#c75c34;color:white;border-radius:10px;font-weight:800;font-size:18px}
    h1{font-size:15px;margin:0;letter-spacing:.2px}.sub{font-size:11px;color:#8a857c}.collapse{margin-left:auto;border:1px solid #dedbd3;background:transparent;border-radius:50%;width:28px;height:28px;color:#6e695f}
    main{padding:15px 16px}.status{display:flex;align-items:center;gap:7px;font-weight:600}.dot{width:7px;height:7px;background:#be873d;border-radius:50%}.good .dot{background:#3e8466}.neutral .dot{background:#9b978e}
    .address{font-size:12px;color:#6d695f;overflow-wrap:anywhere;margin:4px 0 12px}.info{background:#f4f1e9;border-radius:9px;padding:10px 12px;font-size:12px;color:#777064;margin:10px 0}.info p{margin:0}
    label{display:block;font-size:12px;margin:12px 0 5px}input{border:1px solid #dcd6ca;background:white;border-radius:7px;padding:9px 10px;width:100%;color:#292824}input:focus{outline:2px solid #eac6ad;outline-offset:1px}
    button.primary{background:#302e29;border-color:#302e29;color:white;width:100%;margin-top:10px}.buttons{display:flex;gap:8px;margin-top:12px}button.action{padding:8px 10px;border-radius:8px;border:1px solid #d9d4ca;background:#fff;color:#403d36;flex:1}
    button.primary{padding:9px;border:0;border-radius:8px}.meta{display:flex;justify-content:space-between;color:#898278;font-size:11px;margin-top:13px}.error{font-size:12px;color:#a7452b;overflow-wrap:anywhere;margin-top:9px}
    footer{border-top:1px solid #eeeae2;padding:10px 16px;display:flex;align-items:center;gap:6px;font-size:11px;color:#8a8276}.bubble{display:none;border:0;width:50px;height:50px;border-radius:50%;background:#302e29;color:#fff;box-shadow:0 5px 20px #0003;font-weight:700;font-size:16px}
    .collapsed .panel{display:none}.collapsed .bubble{display:block}
  </style><div id="shell"><button class="bubble" id="expand" title="展开消息哨兵" aria-label="展开消息哨兵">哨</button><section class="panel" aria-label="Etsy 消息哨兵">
    <header><span class="logo">E</span><div><h1>Etsy 消息哨兵</h1><div class="sub">OUTLOOK & GMAIL</div></div><button class="collapse" id="collapse" title="收起面板" aria-label="收起面板">−</button></header>
    <main><div class="status" id="status"><span class="dot"></span><span id="status-label">正在检查页面…</span></div><div class="address" id="address">识别当前邮箱</div>
    <div class="info"><p id="detail">请保持收件箱页面打开。</p></div>
    <form id="bind-form" hidden><label for="shop">给这个店铺取个名字</label><input id="shop" maxlength="80" placeholder="例如：Moss Studio" required><button class="primary" type="submit">绑定当前邮箱并监听</button></form>
    <div class="buttons"><button class="action" id="scan">立即检查</button><button class="action" id="dashboard">管理邮箱 ↗</button></div>
    <div class="meta"><span id="rows">可见邮件 —</span><span id="checked">尚未检查</span></div><div class="error" id="error" role="status"></div></main>
    <footer><span id="central">○ 本地模式</span><span style="margin-left:auto">网页需保持打开</span></footer>
  </section></div>`;
  document.documentElement.appendChild(host);
  const $ = id => shadow.getElementById(id);
  async function call(message) {
    try { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error || '扩展暂未响应。'); return result; }
    catch (error) {
      if (/context invalidated|Extension context/i.test(error.message)) { destroyed = true; $('error').textContent = '插件已更新，请刷新邮箱页面。'; }
      throw error;
    }
  }
  function collect() {
    const report = MailWatchAdapters.read(document, location.href);
    if (report.email) cachedIdentity = { email: report.email, token: report.identityToken, route: report.accountRoute };
    else if (report.identityToken && cachedIdentity?.token === report.identityToken && cachedIdentity.route === report.accountRoute && report.status !== 'login_required') {
      report.email = cachedIdentity.email;
      if (report.status === 'identity_unknown') { report.status = report.listStatus || 'view_unavailable'; report.detail = '当前可见列表；账号沿用本次页面已识别身份，未完成端到端收信验证。'; }
    } else cachedIdentity = null;
    latest = report;
    report.documentNonce = documentNonce; report.pageUrl = location.href;
    return report;
  }
  function render() {
    if (!state || !latest) return;
    const box = state.mailboxes.find(b => b.provider === latest.provider && b.email === latest.email);
    const code = box ? !box.enabled ? 'paused' : latest.status : latest.email ? 'unbound' : latest.status;
    $('status-label').textContent = box ? `${box.shop} · ${C.LABELS[code] || code}` : C.LABELS[code] || code;
    $('status').className = `status ${['watching', 'limited'].includes(code) ? 'good' : code === 'unbound' ? 'neutral' : ''}`;
    $('address').textContent = latest.email || '暂未读取到当前邮箱地址';
    $('detail').textContent = !box && latest.email ? '绑定后先记住当前列表；之后出现的 Etsy 买家消息将保存在本地。' : latest.detail;
    $('bind-form').hidden = !!box || !latest.email || !['watching', 'limited', 'unbound'].includes(latest.status);
    $('rows').textContent = `当前可见 ${latest.rowCount} 封`;
    $('checked').textContent = `检查于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    $('central').textContent = state.connection.status === 'local' ? '○ 本地模式' : state.connection.status === 'connected' ? '● 中央网站已连接' : '◌ 中央连接需检查';
    $('shell').classList.toggle('collapsed', state.settings.panelCollapsed);
  }
  async function scan() {
    if (destroyed) return;
    try { const result = await call({ type: 'MW_REPORT', report: collect() }); state = result.state; $('error').textContent = ''; render(); }
    catch (error) { $('error').textContent = error.message; }
  }
  async function collapsed(value) { $('shell').classList.toggle('collapsed', value); try { await call({ type: 'MW_PANEL', collapsed: value }); } catch (_) {} }
  $('collapse').onclick = () => collapsed(true);
  $('expand').onclick = () => collapsed(false);
  $('scan').onclick = scan;
  $('dashboard').onclick = () => call({ type: 'MW_OPEN_DASHBOARD' }).catch(e => { $('error').textContent = e.message; });
  $('bind-form').onsubmit = async event => {
    event.preventDefault(); const button = $('bind-form').querySelector('button'); button.disabled = true;
    try { await scan(); const result = await call({ type: 'MW_BIND_TAB', shop: $('shop').value }); state = result.state; await scan(); }
    catch (error) { $('error').textContent = error.message; } finally { button.disabled = false; }
  };
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === 'MW_DOCUMENT_INFO') {
      try { const report = collect(); reply({ ok: true, documentNonce, pageUrl: location.href, email: report.email }); } catch (_) { reply({ ok: false }); }
      return false;
    }
    if (message.type !== 'MW_COLLECT') return;
    try { const report = collect(); render(); reply({ ok: true, report }); } catch (error) { reply({ ok: false, error: error.message }); }
    return false;
  });
  const observer = new MutationObserver(() => {
    if (timer || destroyed) return;
    timer = setTimeout(() => { timer = null; scan(); }, 1500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'email', 'data-legacy-message-id', 'data-legacy-last-message-id', 'data-legacy-thread-id', 'title', 'aria-selected'] });
  let interval = setInterval(scan, 30000);
  window.addEventListener('pagehide', () => { observer.disconnect(); clearInterval(interval); interval = null; clearTimeout(timer); timer = null; });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    cachedIdentity = null;
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'email', 'data-legacy-message-id', 'data-legacy-last-message-id', 'data-legacy-thread-id', 'title', 'aria-selected'] });
    if (!interval) interval = setInterval(scan, 30000);
    scan();
  });
  window.addEventListener('online', scan);
  window.addEventListener('hashchange', scan);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scan(); });
  scan();
})();
