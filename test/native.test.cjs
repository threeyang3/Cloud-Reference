'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {baiduClientTarget, launchBaiduClient} = require('../src/native.cjs');

const file = {
  provider: 'baidu',
  accountId: '1234',
  fileId: '9007199254740995',
  kind: 'file',
  name: '资料 & 测试.PDF',
  path: '/文档/资料 & 测试.PDF',
};

function payload(target) {
  assert.match(target.url, /^baiduyunguanjia:\/\/evoked-saveopen\/\?param=[A-Za-z0-9_-]+$/);
  return JSON.parse(Buffer.from(target.url.split('?param=')[1], 'base64').toString('utf8'));
}

test('Baidu native file action preserves Unicode, precise IDs and known preview metadata', () => {
  const revision = '1234567890abcdef1234567890abcdef';
  const target = baiduClientTarget({...file, size: 1200, revision, accessToken: 'fictional-token'});
  assert.equal(target.previewsFile, true);
  assert.deepEqual(payload(target), {
    path: file.path, server_path: file.path, server_filename: file.name, fs_id: file.fileId,
    is_dir: 0, category: 4, vtime: 0, size: 1200, md5: revision,
  });
});

test('Baidu native directory action opens the target or the parent of unsupported files', () => {
  const folder = baiduClientTarget({...file, kind: 'folder', path: '/文档/示例.pdf'});
  const torrent = baiduClientTarget({...file, name: 'seed.torrent', path: '/文档/seed.torrent'});
  const archive = baiduClientTarget({...file, name: 'archive.cbz', path: '/archive.cbz'});
  for (const target of [folder, torrent, archive]) assert.equal(target.previewsFile, false);
  assert.deepEqual(payload(folder), {path: '/文档/示例.pdf', is_dir: 1});
  assert.deepEqual(payload(torrent), {path: '/文档', is_dir: 1});
  assert.deepEqual(payload(archive), {path: '/', is_dir: 1});
});

test('Baidu native launch respects cancellation before dispatch', async () => {
  const {url} = baiduClientTarget(file);
  await assert.rejects(launchBaiduClient(url, {signal: AbortSignal.abort()}), {code: 'cancelled'});
});
