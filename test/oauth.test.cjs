'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {BaiduOAuthFlow, callbackPair, authorize, CALLBACK} = require('../src/oauth.cjs');
const {OpenListAuth} = require('../src/auth.cjs');
const login = 'https://openapi.baidu.com/oauth/2.0/authorize?' + new URLSearchParams({client_id: 'fixture', scope: 'basic,netdisk', response_type: 'code', redirect_uri: CALLBACK});
const callback = state => CALLBACK + '?' + new URLSearchParams({code: 'test-code', state});
function encoded(payload) { return '/#' + Buffer.from(JSON.stringify(payload)).toString('base64'); }
const tokens = {driver_txt: 'baiduyun_go', access_token: 'fixture-access', refresh_token: 'fixture-refresh', client_key: '', secret_key: ''};
test('OAuth uses fresh state without changing provider scope or registered redirect', () => {
  const flow = new BaiduOAuthFlow(), url = new URL(flow.prepare(login));
  assert.match(url.searchParams.get('state'), /^[a-f0-9]{64}$/);
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(flow.callback(callback(flow.state)), 'test-code');
  assert.throws(() => flow.callback(callback(flow.state)), e => e.code === 'oauth');
});
test('authorization entry rejects untrusted hosts, expanded scopes and duplicate parameters', () => {
  for (const raw of [login.replace('openapi.baidu.com', 'openapi.baidu.com.evil.invalid'), login.replace('scope=basic%2Cnetdisk', 'scope=basic%2Cnetdisk%2Cother'), login + '&client_id=another', login + '#fragment', login.replace('https:', 'http:')]) {
    assert.throws(() => new BaiduOAuthFlow().prepare(raw));
  }
});
test('callback rejects wrong state, duplicate state, credentials and unexpected origins', () => {
  for (const transform of [s => callback('wrong'), s => callback(s) + '&state=' + s, s => callback(s).replace('api.oplist.org', 'other.invalid'), s => callback(s).replace('https://', 'https://user:secret@')]) {
    const flow = new BaiduOAuthFlow(); flow.prepare(login); assert.throws(() => flow.callback(transform(flow.state)));
  }
});
test('denied authorization is terminal and no code is accepted afterwards', () => {
  const flow = new BaiduOAuthFlow(); flow.prepare(login);
  assert.throws(() => flow.callback(CALLBACK + '?' + new URLSearchParams({error: 'access_denied', state: flow.state})), e => e.code === 'cancelled');
  assert.throws(() => flow.callback(callback(flow.state)));
});
test('callback envelope decodes UTF-8 and preserves unknown expiry without following URL', () => {
  assert.deepEqual(callbackPair(encoded(tokens)), {accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: null});
  for (const raw of ['https://other.invalid/' + encoded(tokens), '/?unexpected=1' + encoded(tokens).slice(1), encoded({...tokens, driver_txt: '115cloud_go'}), encoded({...tokens, client_key: 'private'}), encoded({...tokens, refresh_token: ''}), '/#not-a-json']) assert.throws(() => callbackPair(raw));
});
test('OpenList begin and callback use fixed endpoints, not caller-supplied hosts', async () => {
  const calls = [], auth = new OpenListAuth({json: async (url, options) => {
    calls.push({url, options}); return url.pathname.endsWith('requests') ? {text: login} : {location: encoded(tokens)};
  }});
  assert.equal(await auth.begin(), login);
  assert.equal((await auth.exchange('test-code')).refreshToken, 'fixture-refresh');
  assert.equal(calls[1].options.mode, 'oauth-redirect');
  assert.equal(calls[1].url.origin + calls[1].url.pathname, CALLBACK);
});
function bridgeFixture() {
  const state = {windows: [], exchanges: 0, cleared: 0};
  const session = new EventEmitter();
  session.webRequest = {onBeforeRequest(filter, callback) { state.interceptor = callback || null; }};
  session.setPermissionRequestHandler = handler => { state.permission = handler; };
  session.setPermissionCheckHandler = handler => { state.permissionCheck = handler; };
  session.clearStorageData = async () => { state.cleared++; };
  class BrowserWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.dead = false; this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { state.newWindow = handler; }; state.windows.push(this); }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
  }
  const bridge = {BrowserWindow, session: {fromPartition(partition, options) { state.partition = partition; state.sessionOptions = options; return session; }}};
  const auth = {begin: async () => login, exchange: async code => { state.exchanges++; assert.equal(code, 'test-code'); return {accessToken: 'a', refreshToken: 'b', expiresAt: null}; }};
  return {state, bridge, auth, session};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('native auth is ephemeral, sandboxed and captures code before broker navigation', async () => {
  const {state, bridge, auth} = bridgeFixture();
  const promise = authorize(auth, {bridgeFactory: () => bridge}); await tick();
  const win = state.windows[0], preferences = win.options.webPreferences;
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true); assert.equal(preferences.webSecurity, true); assert.equal(preferences.webviewTag, false);
  assert.equal(state.partition.startsWith('persist:'), false); assert.equal(state.sessionOptions.cache, false);
  let permission; state.permission(null, 'camera', value => permission = value); assert.equal(permission, false);
  assert.equal(state.permissionCheck(), false); assert.deepEqual(state.newWindow(), {action: 'deny'});
  const stateToken = new URL(win.url).searchParams.get('state'); let replies = 0;
  state.interceptor({resourceType: 'mainFrame', url: callback(stateToken)}, reply => { replies++; assert.equal(reply.cancel, true); });
  assert.equal((await promise).accessToken, 'a'); assert.equal(replies, 1); assert.equal(state.exchanges, 1);
  assert.equal(win.dead, true); assert.equal(state.cleared, 1); assert.equal(state.interceptor, null);
});
test('native auth wrong state acknowledges once and does not exchange any code', async () => {
  const {state, bridge, auth} = bridgeFixture(); const promise = authorize(auth, {bridgeFactory: () => bridge});
  const rejected = assert.rejects(promise, e => e.code === 'oauth'); await tick(); let replies = 0;
  state.interceptor({resourceType: 'mainFrame', url: callback('wrong')}, () => replies++);
  await rejected; assert.equal(replies, 1); assert.equal(state.exchanges, 0);
});
test('closing or cancelling auth clears session and cannot install late credentials', async () => {
  for (const action of ['abort', 'close']) {
    const {state, bridge, auth} = bridgeFixture(), controller = new AbortController();
    const promise = authorize(auth, {bridgeFactory: () => bridge, signal: controller.signal});
    const rejected = assert.rejects(promise, e => e.code === 'cancelled'); await tick();
    if (action === 'abort') controller.abort(); else state.windows[0].destroy();
    await rejected; assert.equal(state.exchanges, 0); assert.equal(state.cleared, 1);
  }
});
test('unsupported native bridge does not even begin network authorization', async () => {
  let began = false;
  await assert.rejects(authorize({begin() { began = true; }}, {bridgeFactory() { throw Error('not available'); }}));
  assert.equal(began, false);
});
test('unexpected top-level navigation fails closed', async () => {
  const {state, bridge, auth} = bridgeFixture(); const promise = authorize(auth, {bridgeFactory: () => bridge});
  const rejected = assert.rejects(promise); await tick();
  state.interceptor({resourceType: 'mainFrame', url: 'https://other.invalid/'}, reply => assert.equal(reply.cancel, true));
  await rejected; assert.equal(state.exchanges, 0);
});
test('native authorization timeout destroys the window', async () => {
  const {state, bridge, auth} = bridgeFixture(); await assert.rejects(authorize(auth, {bridgeFactory: () => bridge, timeout: 5}), e => e.code === 'timeout');
  assert.equal(state.windows[0].dead, true); assert.equal(state.cleared, 1);
});
