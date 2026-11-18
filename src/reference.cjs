'use strict';
class CloudError extends Error {
  constructor(code, message) { super(message); this.name = 'CloudError'; this.code = code; }
}
const fail = (code, message) => { throw new CloudError(code, message); };
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
function decimalId(value, root = false) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('protocol', '网盘身份精度不可靠。');
    value = String(value);
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || (!root && value === '0')) fail('invalid', '文件或账号身份无效。');
  return value;
}
function pathOf(value) {
  if (!text(value) || !value.startsWith('/') || value.includes('//') || value.split('/').some(p => p === '.' || p === '..')) fail('invalid', '网盘路径无效。');
  return value.length > 1 ? value.replace(/\/$/, '') : value;
}
function parentPath(path) { path = pathOf(path); return path.slice(0, path.lastIndexOf('/')) || '/'; }
function within(path, directory, recursive = true) {
  path = pathOf(path); directory = pathOf(directory);
  return recursive ? path !== directory && (directory === '/' || path.startsWith(directory + '/')) : parentPath(path) === directory && path !== directory;
}
function reference(input) {
  if (!input || input.provider !== 'baidu' || !['file', 'folder'].includes(input.kind) || !text(input.name, 512)) fail('invalid', '不支持的资源引用。');
  const accountId = decimalId(input.accountId), fileId = decimalId(input.fileId, true), path = pathOf(input.path);
  if (fileId === '0' && (input.kind !== 'folder' || path !== '/')) fail('invalid', '根目录身份无效。');
  return Object.freeze({v: 1, provider: 'baidu', accountId, fileId, kind: input.kind, path, name: input.name});
}
function keyOf(input) { const r = reference(input); return `${r.provider}:${r.accountId}:${r.kind}:${r.fileId}`; }
function linkOf(input) {
  const r = reference(input);
  return 'obsidian://cloud-reference?' + new URLSearchParams({v:'1',provider:r.provider,account:r.accountId,id:r.fileId,kind:r.kind,path:r.path,name:r.name});
}
function parseLink(raw) {
  if (!text(raw, 32768)) fail('invalid', '资源链接无效。');
  let u; try { u = new URL(raw); } catch { fail('invalid', '资源链接无效。'); }
  if (u.protocol !== 'obsidian:' || u.hostname !== 'cloud-reference' || u.username || u.password || u.port || (u.pathname && u.pathname !== '/') || u.hash) fail('invalid', '不是 Cloud Reference 链接。');
  const fields = ['v','provider','account','id','kind','path','name'], p = u.searchParams;
  if ([...p.keys()].some(k => !fields.includes(k)) || fields.some(k => p.getAll(k).length !== 1) || p.get('v') !== '1') fail('invalid', '链接包含未知、重复或缺失字段。');
  return reference({provider:p.get('provider'),accountId:p.get('account'),fileId:p.get('id'),kind:p.get('kind'),path:p.get('path'),name:p.get('name')});
}
function markdownOf(input, label) {
  const r = reference(input), title = label === undefined ? r.name : label;
  if (!text(title, 512)) fail('invalid', '显示名称无效。');
  const escape = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_{}\[\]()!#|]/g,'\\$&');
  const pathTitle = r.path.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/\\/g,'\\\\');
  return `[${escape(title)}](${linkOf(r)} "${pathTitle}")`;
}
function displayName(source, ref, current) { return source === ref.name && text(current, 512) ? current : source; }
function webLocation(input) { const r = reference(input); return 'https://pan.baidu.com/disk/main#/index?category=all&path=' + encodeURIComponent(r.kind === 'folder' ? r.path : parentPath(r.path)); }
function handoff(target, resources) {
  if (!target || !['work','series'].includes(target.type) || !/^[A-Za-z0-9_-]+$/.test(target.uid || '') || !Array.isArray(resources) || resources.length < 1 || resources.length > 100) fail('invalid', 'MediaCore 目标或候选数量无效。');
  return {protocol:'media-resource-handoff/v1',target:{type:target.type,uid:target.uid},resources:resources.map(input => {
    const r = reference(input);
    if (r.fileId === '0') fail('invalid', '根目录不能作为 MediaCore 候选身份。');
    // MediaCore v1 rejects unknown obsidian:// actions. Export a supported web
    // fallback until MediaCore explicitly registers Cloud Reference handling.
    return {kind:r.kind,provider:r.provider,title:r.name,identity:{scope:r.accountId,id:r.fileId},link:webLocation(r),location:r.path};
  })};
}
/** Preserve unsafe integer literals without allocating an array per character. */
function parseJson(raw) {
  if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) fail('protocol', '响应过大。');
  const parts = [], number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let i = 0, start = 0;
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (c === 34) {
      i++;
      while (i < raw.length) {
        if (raw.charCodeAt(i) === 92) { i += 2; continue; }
        if (raw.charCodeAt(i++) === 34) break;
      }
    } else if (c === 45 || (c >= 48 && c <= 57)) {
      number.lastIndex = i;
      const match = number.exec(raw);
      if (!match) fail('protocol', '响应 JSON 无效。');
      const literal = match[0];
      if (/^-?\d+$/.test(literal) && !Number.isSafeInteger(Number(literal))) {
        parts.push(raw.slice(start, i), '"', literal, '"');
        start = i + literal.length;
      }
      i += literal.length;
    } else i++;
  }
  try { return JSON.parse(parts.length ? parts.join('') + raw.slice(start) : raw); }
  catch { fail('protocol', '响应 JSON 无效。'); }
}
function parseJsonBytes(bytes) {
  let raw;
  try { raw = new (require('node:util').TextDecoder)('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { fail('protocol', '响应不是有效 UTF-8，未替换损坏的文件名或路径。'); }
  return parseJson(raw);
}
function publicError(e) { return e instanceof CloudError ? e.message : e?.name === 'AbortError' ? '操作已取消。' : '操作失败，请重试。'; }
module.exports = {CloudError,fail,text,decimalId,pathOf,parentPath,within,reference,keyOf,linkOf,parseLink,markdownOf,displayName,webLocation,handoff,parseJson,parseJsonBytes,publicError};
