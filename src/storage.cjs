'use strict';
const fs = require('node:fs/promises'), constants = require('node:fs').constants;
const path = require('node:path'), {randomUUID} = require('node:crypto');
const {decimalId, CloudError, parseJson} = require('./reference.cjs');
/** Plaintext sync mode requires explicit UI consent. Never commit these files. */
class CredentialFiles {
  constructor(directory, {trustedRoot = path.dirname(directory)} = {}) {
    this.directory = path.resolve(directory); this.trustedRoot = path.resolve(trustedRoot); this.invalidCount = 0;
    this.relative = path.relative(this.trustedRoot, this.directory);
    if (!this.relative || this.relative.startsWith('..') || path.isAbsolute(this.relative)) throw new CloudError('storage', '凭据目录必须位于指定库目录内。');
  }
  file(id) { return path.join(this.resolvedDirectory || this.directory, decimalId(id) + '.credentials.json'); }
  async guard(create = false) {
    let current;
    try { current = await fs.realpath(this.trustedRoot); }
    catch (error) { if (error.code === 'ENOENT' && !create) return false; throw new CloudError('storage', '无法访问 Vault 根目录。'); }
    // Canonicalize the trusted root (macOS /var is commonly a system symlink),
    // but refuse symlinks in every plugin/account path segment below it.
    for (const segment of this.relative.split(path.sep)) {
      current = path.join(current, segment);
      if (create) { try { await fs.mkdir(current, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw new CloudError('storage', '无法创建凭据目录。'); } }
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) { if (error.code === 'ENOENT' && !create) return false; throw new CloudError('storage', '无法检查凭据目录。'); }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CloudError('storage', '凭据目录不能通过符号链接。');
    }
    this.resolvedDirectory = current; return true;
  }
  async read(id) {
    if (!await this.guard()) return null;
    let handle;
    try {
      const file = this.file(id), initial = await fs.lstat(file);
      if (!initial.isFile() || initial.isSymbolicLink() || initial.size > 32768) throw new CloudError('storage', '凭据文件无效。');
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32768 || stat.ino !== initial.ino || stat.dev !== initial.dev) throw new CloudError('storage', '凭据文件在读取时发生变化。');
      const buffer = Buffer.alloc(32769); let offset = 0;
      for (;;) { const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; if (offset > 32768) throw new CloudError('storage', '凭据文件过大。'); }
      return parseJson(buffer.subarray(0, offset).toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof CloudError) throw error;
      throw new CloudError('storage', '无法读取凭据文件。');
    } finally { await handle?.close(); }
  }
  async write(id, record, {beforeCommit} = {}) {
    await this.guard(true);
    const dest = this.file(id), temp = dest + '.' + randomUUID() + '.tmp'; let handle;
    try {
      try { const stat = await fs.lstat(dest); if (!stat.isFile() || stat.isSymbolicLink()) throw new CloudError('storage', '凭据目标文件无效。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const content = JSON.stringify(record);
      if (Buffer.byteLength(content) > 32768) throw new CloudError('storage', '凭据文件过大。');
      handle = await fs.open(temp, 'wx', 0o600); await handle.writeFile(content); await handle.sync(); await handle.close(); handle = null;
      await this.guard(); beforeCommit?.();
      await fs.rename(temp, dest);
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw new CloudError('storage', '凭据写入失败；未确认更新成功。');
    } finally { await handle?.close(); await fs.unlink(temp).catch(() => {}); }
  }
  async list() {
    this.invalidCount = 0;
    if (!await this.guard()) return [];
    const ids = [], iterator = await fs.opendir(this.resolvedDirectory); let count = 0;
    for await (const entry of iterator) {
      if (++count > 256) throw new CloudError('storage', '账号目录文件过多，请检查同步冲突。');
      if (/^[1-9][0-9]{0,19}\.credentials\.json$/.test(entry.name)) ids.push(entry.name.split('.')[0]);
    }
    if (ids.length > 32) throw new CloudError('storage', '账号文件超过 32 个，请检查同步冲突。');
    const result = [];
    for (const id of ids.sort()) { try { const record = await this.read(id); if (record) result.push(record); } catch (error) { if (!(error instanceof CloudError)) throw error; this.invalidCount++; } }
    return result;
  }
  async remove(id) {
    if (!await this.guard()) return;
    await fs.unlink(this.file(id)).catch(error => { if (error.code !== 'ENOENT') throw new CloudError('storage', '无法移除凭据。'); });
  }
}
module.exports = {CredentialFiles};
