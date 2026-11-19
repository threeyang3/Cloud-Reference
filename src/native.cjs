'use strict';
const {execFile} = require('node:child_process');
const {posix} = require('node:path');
const {promisify} = require('node:util');
const {reference, parentPath, fail} = require('./reference.cjs');
const {check} = require('./runtime.cjs');

const BAIDU_CLIENT = 'baidu-client';
const ACTION = 'baiduyunguanjia://evoked-saveopen/?param=';
const previewCategories = new Map([
  ['pdf', 4], ['txt', 4], ['jpg', 3], ['jpeg', 3], ['png', 3],
  ['mp4', 1], ['mkv', 1], ['mov', 1], ['mp3', 2],
]);
const exec = promisify(execFile);
const supportsBaiduClient = () => process.platform === 'darwin';

function baiduClientTarget(metadata) {
  const ref = reference(metadata);
  const extension = posix.extname(ref.path).slice(1).toLowerCase();
  const category = ref.kind === 'file' ? previewCategories.get(extension) : undefined;
  const previewsFile = category !== undefined;
  let payload;
  if (previewsFile) {
    payload = {
      path: ref.path,
      server_path: ref.path,
      server_filename: ref.name,
      fs_id: ref.fileId,
      is_dir: 0,
      category,
      vtime: 0,
    };
    if (Number.isSafeInteger(metadata.size) && metadata.size >= 0) payload.size = metadata.size;
    if (typeof metadata.revision === 'string' && /^[a-f0-9]{32}$/i.test(metadata.revision)) {
      payload.md5 = metadata.revision;
    }
  } else {
    // A directory action with a filename would ask the client to preview it.
    payload = {path: ref.kind === 'folder' ? ref.path : parentPath(ref.path), is_dir: 1};
  }
  // The client decodes this raw value as base64 without URL-unescaping it.
  return {url: ACTION + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'), previewsFile};
}

async function launchBaiduClient(url, {signal} = {}) {
  check(signal);
  if (!supportsBaiduClient()) fail('platform', '当前平台尚未支持百度网盘客户端打开。');
  if (typeof url !== 'string' || !url.startsWith(ACTION) || !/^[A-Za-z0-9_-]+$/.test(url.slice(ACTION.length))) {
    fail('policy', '不允许打开此客户端地址。');
  }
  try {
    await exec('/usr/bin/open', ['-g', '-b', 'com.baidu.netdisk', url], {signal, timeout: 10000});
  } catch {
    check(signal);
    fail('opener', '无法打开百度网盘客户端，请确认客户端已安装且可以启动。');
  }
}

module.exports = {BAIDU_CLIENT, supportsBaiduClient, baiduClientTarget, launchBaiduClient};
