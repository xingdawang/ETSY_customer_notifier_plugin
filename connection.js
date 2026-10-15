(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let connection, initialized = false, busy = false;
  async function call(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '插件暂不可用，请刷新后重试。');
    return result;
  }
  function notice(text = '') { $('message').textContent = text; $('message').hidden = !text; }
  function hidePassword() { $('password').type = 'password'; $('password-eye').setAttribute('aria-pressed', 'false'); $('password-eye').setAttribute('aria-label', '显示密码'); $('password-eye').title = '显示密码'; }
  function render(value) {
    const previousError = connection?.error || '';
    connection = value;
    $('login-form').hidden = value.authenticated;
    $('connected').hidden = !value.authenticated;
    $('connected-account').textContent = value.account || '';
    $('connection-label').textContent = value.status === 'connected' ? '已连接' : '连接暂不可用';
    $('connection-label').parentElement.classList.toggle('warn', value.status !== 'connected');
    if (!initialized) { $('account').value = value.account || ''; $('server').value = value.server || MailWatchConfig.serverUrl; initialized = true; }
    $('login-button').disabled = $('logout-button').disabled = busy;
    if (value.error) notice(value.error);
    else if (previousError && $('message').textContent === previousError) notice('');
  }
  async function refresh() {
    if (busy) return;
    try { const result = await call({ type: 'MW_CONNECTION' }); render(result.connection); }
    catch (_) { notice('插件已更新或暂不可用，请刷新邮箱页面。'); }
  }
  $('password-eye').onclick = () => {
    const visible = $('password').type === 'password';
    $('password').type = visible ? 'text' : 'password';
    $('password-eye').setAttribute('aria-pressed', String(visible));
    $('password-eye').setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
    $('password-eye').title = visible ? '隐藏密码' : '显示密码';
  };
  $('server-settings').addEventListener('toggle', hidePassword);
  $('login-form').onsubmit = event => {
    event.preventDefault(); if (busy) return;
    let server;
    try {
      const url = new URL($('server').value.trim());
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('protocol');
      if (url.username || url.password || url.search || url.hash) throw new Error('invalid URL');
      server = url.origin + url.pathname.replace(/\/+$/, '');
    } catch (_) { $('server-settings').open = true; notice('请填写有效的 HTTPS 中央服务器地址。'); return; }
    const account = $('account').value.trim(), password = $('password').value;
    $('password').value = ''; hidePassword();
    busy = true; $('login-button').disabled = true; notice('正在验证插件凭证…');
    // Start optional host access while the click still supplies a user gesture.
    const permission = chrome.permissions.request({ origins: [`${new URL(server).protocol}//${new URL(server).hostname}/*`] });
    (async () => {
      try {
        if (!(await permission)) throw new Error('未允许连接中央服务器。');
        const result = await call({ type: 'MW_LOGIN', server, account, password });
        render(result.connection); notice(result.connection.error || '');
      } catch (error) { notice(error.message); }
      finally { busy = false; $('login-button').disabled = $('logout-button').disabled = false; }
    })();
  };
  $('logout-button').onclick = async () => {
    if (busy) return;
    busy = true; $('logout-button').disabled = true;
    try { const result = await call({ type: 'MW_LOGOUT' }); render(result.connection); notice(''); $('password').value = ''; hidePassword(); }
    catch (error) { notice(error.message); }
    finally { busy = false; $('logout-button').disabled = false; }
  };
  if (window.parent !== window) {
    const resize = () => parent.postMessage({ type: 'MW_PANEL_HEIGHT', height: Math.ceil(document.body.getBoundingClientRect().height) }, '*');
    new ResizeObserver(resize).observe(document.body); resize();
  }
  refresh(); setInterval(refresh, 5000);
})();
