'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const {JsonTransport} = require('../src/transport.cjs');
const {OpenListAuth, Credentials} = require('../src/auth.cjs');
const {CredentialFiles} = require('../src/storage.cjs');
const {BaiduProvider} = require('../src/baidu.cjs');
const {CloudService} = require('../src/service.cjs');
const {markdownOf, parseLink, linkOf} = require('../src/reference.cjs');

// Full production stack with a loopback HTTP provider. The adapter below
// simulates TLS readiness; this is NOT a real TLS or cloud-account test.
test('loopback: authorize, persist, search, move, single-flight refresh, restart and dispose', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-integration-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  let expired = false, moved = false, renewals = 0; const observed = [];
  const accountId = '1234567890123456789';
  const item = (id, name, folder = false) => ({fs_id: id, server_filename: name, path: (moved ? '/moved/' : '/old/') + name, isdir: folder ? 1 : 0, size: 10, server_mtime: 10});
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost'); observed.push(url.pathname);
    const json = value => { response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify(value)); };
    if (url.pathname === '/baiduyun/callback') {
      assert.equal(request.headers.cookie, 'server_use=true; driver_txt=baiduyun_go');
      const data = {driver_txt: 'baiduyun_go', access_token: 'fixture-old', refresh_token: 'fixture-refresh'};
      response.writeHead(302, {location: '/#' + Buffer.from(JSON.stringify(data)).toString('base64')}); response.end(); return;
    }
    if (url.pathname === '/baiduyun/renewapi') {
      renewals++; assert.equal(url.searchParams.get('refresh_ui'), 'fixture-refresh');
      json({access_token: 'fixture-new', refresh_token: 'fixture-refresh-2', expires_in: 3600}); return;
    }
    if (expired && url.searchParams.get('access_token') === 'fixture-old') { json({errno: 111}); return; }
    if (url.pathname === '/rest/2.0/xpan/nas') { json({errno: 0, uk: accountId, netdisk_name: 'Fixture account'}); return; }
    if (url.pathname === '/rest/2.0/xpan/multimedia') {
      const id = JSON.parse(url.searchParams.get('fsids'))[0];
      json({errno: 0, list: [id === 100 ? {fs_id: '100', path: moved ? '/moved' : '/old', server_filename: moved ? 'moved' : 'old', isdir: 1} : item('200', moved ? 'renamed.pdf' : 'book.pdf')]}); return;
    }
    if (url.searchParams.get('method') === 'search') {
      assert.equal(url.searchParams.get('recursion'), '1'); assert.equal(url.searchParams.get('dir'), moved ? '/moved' : '/old');
      json({errno: 0, has_more: 0, list: [item('200', moved ? 'renamed.pdf' : 'book.pdf')]}); return;
    }
    if (url.searchParams.get('method') === 'list') { json({errno: 0, list: url.searchParams.get('dir') === '/' ? [] : [item('200', 'book.pdf')]}); return; }
    response.writeHead(500); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const transport = new JsonTransport({request: (url, options, callback) => {
    const request = http.request({hostname: '127.0.0.1', port: server.address().port, method: options.method, path: url.pathname + url.search, headers: options.headers}, callback);
    request.on('socket', socket => { if (socket.connecting) socket.once('connect', () => socket.emit('secureConnect')); });
    return request;
  }});
  t.after(() => transport.close());
  const storage = new CredentialFiles(path.join(root, 'accounts'));
  const auth = new OpenListAuth(transport), credentials = new Credentials(storage, new Map([['openlist', auth]]));
  const provider = new BaiduProvider(transport, credentials), service = new CloudService(provider);
  t.after(() => { service.close(); credentials.close(); });
  const pair = await auth.exchange('fixture-code');
  const identity = await provider.verify(pair.accessToken); assert.equal(identity.accountId, accountId);
  await credentials.install(identity, pair, 'openlist', true);
  const folder = {provider: 'baidu', accountId, fileId: '100', kind: 'folder', path: '/old', name: 'old'};
  const found = await service.search(folder, 'book'); assert.equal(found.items[0].fileId, '200');
  const ref = found.items[0], markdown = markdownOf(ref); const uri = linkOf(ref);
  moved = true;
  const current = await service.resolve(parseLink(uri), {fresh: true}); assert.equal(current.name, 'renamed.pdf');
  assert.equal(markdownOf(ref), markdown); assert.equal(current.path, '/moved/renamed.pdf');
  const searched = await service.search(folder, 'renamed'); assert.equal(searched.folder.path, '/moved');
  expired = true;
  const results = await Promise.all(Array.from({length: 8}, () => provider.stat(ref)));
  assert.equal(results.length, 8); assert.equal(renewals, 1);
  const saved = await storage.read(accountId); assert.equal(saved.refreshToken, 'fixture-refresh-2'); assert.equal(saved.pending, undefined);
  credentials.close();
  const restored = new Credentials(storage, new Map([['openlist', auth]]));
  try { assert.equal(await restored.use(accountId, async value => value), 'fixture-new'); } finally { restored.close(); }
  assert.equal(observed.some(p => p === '/xpan/unisearch'), false);
  assert.ok(transport.diagnostics().peakConcurrency <= 3);
  assert.equal(transport.requests.size, 0); assert.equal(service.cache.pending.size, 0);
});
