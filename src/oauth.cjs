'use strict';
const {randomBytes, timingSafeEqual} = require('node:crypto');
const {CloudError, fail, text, parseJson} = require('./reference.cjs');
const {check, aborted} = require('./runtime.cjs');
const ORIGIN = 'https://api.oplist.org';
const CALLBACK = ORIGIN + '/baiduyun/callback';
const HOSTS = new Set(['openapi.baidu.com', 'passport.baidu.com', 'pan.baidu.com', 'wappass.baidu.com']);
function httpsUrl(raw) {
  if (!text(raw, 32768)) fail('oauth', '授权地址无效。');
  let u; try { u = new URL(raw); } catch { fail('oauth', '授权地址无效。'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) fail('oauth', '授权地址不可信。');
  return u;
}
function one(u, key) {
  const values = u.searchParams.getAll(key);
  if (values.length !== 1 || !text(values[0], 8192)) fail('oauth', '授权参数缺失或重复。');
  return values[0];
}
/** One app-initiated flow; no credentials or callback state are persisted. */
class BaiduOAuthFlow {
  constructor({state = randomBytes(32).toString('hex')} = {}) { this.state = state; this.phase = 'new'; }
  prepare(raw) {
    if (this.phase !== 'new') fail('oauth', '授权会话已使用。');
    const u = httpsUrl(raw);
    if (u.hostname !== 'openapi.baidu.com' || u.pathname !== '/oauth/2.0/authorize' || u.hash ||
      one(u, 'response_type') !== 'code' || one(u, 'scope') !== 'basic,netdisk' || one(u, 'redirect_uri') !== CALLBACK) fail('oauth', '授权入口不匹配。');
    one(u, 'client_id'); u.searchParams.set('state', this.state); this.phase = 'login'; return u.href;
  }
  callback(raw) {
    if (this.phase !== 'login') fail('oauth', '授权回调不属于当前会话。');
    const u = httpsUrl(raw);
    if (u.origin + u.pathname !== CALLBACK || u.hash) fail('oauth', '授权回调来源不匹配。');
    const received = one(u, 'state'), a = Buffer.from(received), b = Buffer.from(this.state);
    if (a.length !== b.length || !timingSafeEqual(a, b)) fail('oauth', '授权会话校验失败，请重新开始。');
    this.phase = 'consumed';
    if (u.searchParams.get('error') === 'access_denied') throw new CloudError('cancelled', '你已取消百度网盘授权。');
    return one(u, 'code');
  }
  allowsNavigation(raw) { try { const u = httpsUrl(raw); return this.phase === 'login' && HOSTS.has(u.hostname); } catch { return false; } }
}
function callbackPair(location, now = Date.now()) {
  const u = httpsUrl(new URL(location, ORIGIN).href);
  if (u.origin !== ORIGIN || u.pathname !== '/' || u.search || !u.hash || u.hash.length > 32769) fail('oauth', '授权结果来源不匹配。');
  const encoded = u.hash.slice(1);
  if (!/^[A-Za-z0-9+/_=-]+$/.test(encoded)) fail('oauth', '授权结果编码无效。');
  const payload = parseJson(Buffer.from(encoded, 'base64').toString('utf8'));
  if (!payload || payload.driver_txt !== 'baiduyun_go' || payload.client_key || payload.secret_key || payload.message_err) fail('oauth', '授权服务未返回可用的内置应用凭据。');
  // APIPages callback currently omits expiry. Do not invent an expiry time.
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[^\x21-\x7e]/.test(value);
  if (!valid(payload.access_token) || !valid(payload.refresh_token)) fail('oauth', '授权结果缺少凭据。');
  return {accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: null};
}
function nativeBridge() {
  // Desktop capability detection only. Never download or enable remote modules.
  const electron = require('electron');
  if (electron.BrowserWindow && electron.session) return electron;
  if (electron.remote?.BrowserWindow && electron.remote?.session) return electron.remote;
  try { const bridge = require('@electron/remote'); if (bridge.BrowserWindow && bridge.session) return bridge; } catch { /* Not provided by this host. */ }
  fail('unsupported', '此 Obsidian 未提供隔离授权窗口，请使用手动授权入口。');
}
/** Native window is isolated from the Vault. Code is captured before broker navigation. */
async function authorize(auth, {signal, bridgeFactory = nativeBridge, timeout = 300000} = {}) {
  check(signal);
  const bridge = bridgeFactory();
  const flow = new BaiduOAuthFlow();
  const entry = flow.prepare(await auth.begin(signal));
  check(signal);
  const code = await new Promise((resolve, reject) => {
    let win, session, timer, done = false;
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* Already closed. */ }
      if (session) {
        try { session.webRequest.onBeforeRequest(null); } catch { /* Host teardown. */ }
        try { Promise.resolve(session.clearStorageData()).catch(() => {}); } catch { /* Ephemeral session. */ }
      }
    };
    const finish = (error, value) => { if (done) return; done = true; cleanup(); error ? reject(error) : resolve(value); };
    const cancel = () => finish(aborted());
    try {
      session = bridge.session.fromPartition('cloud-reference-auth-' + randomBytes(16).toString('hex'), {cache: false});
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.setPermissionCheckHandler(() => false);
      session.on('will-download', event => event.preventDefault());
      session.webRequest.onBeforeRequest({urls: ['<all_urls>']}, (details, acknowledge) => {
        let acknowledged = false;
        const callback = value => { if (!acknowledged) { acknowledged = true; acknowledge(value); } };
        if (done) { callback({cancel: true}); return; }
        if (details.resourceType !== 'mainFrame') {
          let safe = false;
          try { const u = new URL(details.url); safe = u.protocol === 'https:' && !u.username && !u.password; } catch { /* Block. */ }
          callback({cancel: !safe}); return;
        }
        try {
          const u = httpsUrl(details.url);
          if (u.origin === ORIGIN) {
            callback({cancel: true});
            const captured = flow.callback(u.href);
            finish(null, captured); return;
          }
          const allowed = flow.allowsNavigation(u.href);
          callback({cancel: !allowed});
          if (!allowed) finish(new CloudError('oauth', '授权页面跳转到未允许的站点，已停止。'));
        } catch (error) { callback({cancel: true}); finish(error instanceof CloudError ? error : new CloudError('oauth', '授权失败。')); }
      });
      win = new bridge.BrowserWindow({width: 920, height: 720, title: '百度网盘官方授权 · Cloud Reference', autoHideMenuBar: true,
        webPreferences: {session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false}});
      win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
      win.webContents.on('will-attach-webview', event => event.preventDefault());
      win.on('closed', cancel);
      signal?.addEventListener('abort', cancel, {once: true});
      timer = setTimeout(() => finish(new CloudError('timeout', '授权窗口已超时，请重新开始。')), timeout);
      Promise.resolve(win.loadURL(entry)).catch(() => { if (!done) finish(new CloudError('oauth', '无法加载官方授权页。')); });
      if (signal?.aborted) cancel();
    } catch { finish(new CloudError('unsupported', '无法创建隔离授权窗口，请使用手动入口。')); }
  });
  check(signal);
  return auth.exchange(code, signal);
}
module.exports = {BaiduOAuthFlow, callbackPair, authorize, ORIGIN, CALLBACK};
