'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
const started = performance.now();
const {MetadataCache, NameScheduler} = require('../src/runtime.cjs');
const {JsonTransport} = require('../src/transport.cjs');
const {parseJson} = require('../src/reference.cjs');
function parserBenchmark() {
  const record = '{"fs_id":9876543210123456789,"path":"/fixture/' + 'x'.repeat(150) + '"}';
  const raw = '[' + Array(5000).fill(record).join(',') + ']';
  const started = performance.now(), parsed = parseJson(raw);
  assert.equal(parsed.length, 5000);
  assert.ok(parsed.every(item => item.fs_id === '9876543210123456789'));
  return {bytes: Buffer.byteLength(raw), entries: parsed.length, elapsedMs: Number((performance.now() - started).toFixed(3))};
}
const loadMs = performance.now() - started;
async function main() {
  global.gc?.(); const before = process.memoryUsage().heapUsed;
  const names = new NameScheduler(); let sharedLoads = 0;
  await Promise.all(Array.from({length: 500}, () => names.get('same', async () => { sharedLoads++; return {name: 'fixture'}; })));
  assert.equal(sharedLoads, 1); names.close();
  const cache = new MetadataCache();
  for (let offset = 0; offset < 512; offset += 32) {
    await Promise.all(Array.from({length: 32}, (_, i) => cache.get(String(offset + i), async () => ({name: 'fixture'}))));
  }
  assert.equal(cache.values.size, 256); const retained = cache.values.size; cache.close();
  const transport = new JsonTransport(); assert.equal(transport.count, 0); transport.close();
  assert.equal(names.gate.active, 0); assert.equal(names.gate.queue.length, 0); assert.equal(names.shared.pending.size, 0);
  const parser = parserBenchmark();
  global.gc?.(); const delta = process.memoryUsage().heapUsed - before;
  const root = path.resolve(__dirname, '..'), bundleBytes = fs.statSync(path.join(root, 'dist/main.js')).size;
  assert.ok(bundleBytes <= 160 * 1024, 'Bundle exceeded 160 KiB core budget');
  const result = {kind: 'node-core-synthetic-not-obsidian', node: process.version, platform: process.platform,
    coreModuleLoadMs: Number(loadMs.toFixed(3)), heapDeltaBytes: delta, bundleBytes, sharedLoadsFor500Links: sharedLoads,
    metadataEntriesAtCap: retained, jsonParser: parser, idleCloudRequests: transport.count, nameConcurrencyLimit: names.gate.limit,
    nameQueueLimit: names.gate.queueLimit, note: 'No live provider, Electron GUI, media decoding or real Obsidian memory measurement.'};
  fs.writeFileSync(path.join(root, 'dist/performance.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
