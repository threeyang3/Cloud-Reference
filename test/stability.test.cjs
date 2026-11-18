'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {CloudService} = require('../src/service.cjs');
const {MetadataCache} = require('../src/runtime.cjs');
const {JsonTransport} = require('../src/transport.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const folder = {provider: 'baidu', accountId: '123', fileId: '100', kind: 'folder', path: '/fixture', name: 'fixture'};

test('concurrent fresh resolutions share one request without cancelling existing consumers', async () => {
  const loads = [];
  const service = new CloudService({stat: () => new Promise(resolve => loads.push(resolve))});
  const first = service.resolve(folder, {fresh: true});
  const firstResult = first.then(value => ({value}), error => ({error}));
  await tick();
  const second = service.resolve(folder, {fresh: true});
  const secondResult = second.then(value => ({value}), error => ({error}));
  await tick();
  loads.forEach(resolve => resolve({...folder, name: 'renamed'}));
  const results = await Promise.all([firstResult, secondResult]);
  service.close();
  assert.equal(loads.length, 1, 'fresh reads must evict cached values, not cancel a shared flight');
  for (const result of results) assert.equal(result.value?.name, 'renamed');
});

test('fresh resolution bypasses a completed cached value but keeps concurrent consumers', async () => {
  let calls = 0;
  const service = new CloudService({stat: async () => ({...folder, name: `name-${++calls}`})});
  assert.equal((await service.resolve(folder)).name, 'name-1');
  assert.equal((await service.resolve(folder)).name, 'name-1');
  assert.equal((await service.resolve(folder, {fresh: true})).name, 'name-2');
  assert.equal(calls, 2);
  service.close();
});

for (const action of ['close', 'invalidate', 'clear']) {
  test(`cache ${action} releases consumers even when a loader ignores cancellation`, async () => {
    const cache = new MetadataCache();
    const value = cache.get('fixture', () => new Promise(() => {}));
    const outcome = value.then(() => 'fulfilled', error => error.code);
    await tick();
    if (action === 'invalidate') cache.invalidate('fixture'); else cache[action]();
    let timer;
    const result = await Promise.race([outcome, new Promise(resolve => { timer = setTimeout(() => resolve('still-pending'), 100); })]);
    clearTimeout(timer);
    cache.close();
    assert.equal(result, 'cancelled');
    assert.equal(cache.pending.size, 0);
  });
}

test('transport cancellation waits for an in-progress persistence hook before reporting not-sent', async () => {
  let release, req, endCalls = 0, prepared = false;
  const transport = new JsonTransport({request() {
    req = new EventEmitter();
    req.destroy = () => req.emit('close');
    req.end = () => { endCalls++; };
    queueMicrotask(() => req.emit('socket', {connecting: false, secureConnecting: false}));
    return req;
  }});
  const controller = new AbortController();
  let settled = false;
  const outcome = transport.json('https://api.oplist.org/baiduyun/renewapi', {
    signal: controller.signal,
    beforeDispatch: async () => { await new Promise(resolve => { release = resolve; }); prepared = true; },
  }).then(() => { settled = true; return null; }, error => { settled = true; return error; });
  await tick();
  controller.abort();
  await tick();
  const premature = settled;
  release();
  const error = await outcome;
  transport.close();
  assert.equal(premature, false, 'caller must see the completed marker write before deciding whether to roll back');
  assert.equal(prepared, true);
  assert.equal(error.delivery, 'not-sent');
  assert.equal(endCalls, 0);
  assert.equal(transport.gate.active, 0);
  assert.equal(transport.requests.size, 0);
});

const {Credentials} = require('../src/auth.cjs');
const {CredentialFiles} = require('../src/storage.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('an async pre-commit rejection preserves the previous credential file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-async-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const storage = new CredentialFiles(path.join(root, 'accounts'));
  await storage.write('123', {pair: 'old'});
  let checked = false;
  await assert.rejects(storage.write('123', {pair: 'new'}, {beforeCommit: async () => {
    await tick(); checked = true; throw new (require('../src/reference.cjs').CloudError)('conflict', 'Fixture conflict');
  }}), error => error.code === 'conflict');
  assert.equal(checked, true);
  assert.deepEqual(await storage.read('123'), {pair: 'old'});
  assert.equal((await fs.readdir(storage.directory)).length, 1);
});

for (const phase of ['prepare', 'commit']) {
  test(`peer credentials arriving during ${phase} disk preparation are not overwritten`, async () => {
    const records = new Map(); let injected = false, rotations = 0, serial = 0;
    const storage = {
      read: async id => records.has(id) ? {...records.get(id)} : null,
      list: async () => [...records.values()],
      remove: async id => records.delete(id),
      write: async (id, value, options = {}) => {
        const isTarget = phase === 'prepare' ? Boolean(value.pending) : value.accessToken === 'rotated-access';
        if (isTarget && !injected) {
          injected = true;
          records.set(id, {...records.get(id), revision: 'synchronized-peer', accessToken: 'peer-access', refreshToken: 'peer-refresh', pending: undefined});
        }
        await options.beforeCommit?.();
        records.set(id, {...value});
      },
    };
    const auth = {supportsDispatchHook: true, renew: async (_token, _signal, prepare) => {
      await prepare(); rotations++;
      return {accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresAt: null};
    }};
    const credentials = new Credentials(storage, new Map([['openlist', auth]]), {makeId: () => String(++serial)});
    await credentials.install({accountId: '123', label: 'Fixture'}, {accessToken: 'old', refreshToken: 'old-refresh', expiresAt: null}, 'openlist', true);
    const outcome = await credentials.refresh('123', await credentials.load('123')).then(() => 'ok', error => error.code);
    credentials.close();
    assert.equal(outcome, 'conflict');
    assert.equal(records.get('123').accessToken, 'peer-access');
    assert.equal(records.get('123').refreshToken, 'peer-refresh');
    assert.equal(rotations, phase === 'prepare' ? 0 : 1);
  });
}
