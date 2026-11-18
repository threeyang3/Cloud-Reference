'use strict';
const {randomUUID} = require('node:crypto');
const {CloudError, decimalId, fail, text} = require('./reference.cjs');
const {check, waitFor} = require('./runtime.cjs');
function token(value) {
  if (!text(value, 4096) || /[^\x21-\x7e]/.test(value)) fail('credential', '授权凭据格式无效。');
  return value;
}
function pairOf(pair) {
  const expiresAt = pair?.expiresAt ?? null;
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)) fail('credential', '授权有效期无效。');
  return {accessToken: token(pair?.accessToken), refreshToken: token(pair?.refreshToken), expiresAt};
}
class OpenListAuth {
  constructor(transport) { this.transport = transport; this.supportsDispatchHook = true; }
  async begin(signal) {
    const url = new URL('https://api.oplist.org/baiduyun/requests');
    url.search = new URLSearchParams({server_use: 'true', driver_txt: 'baiduyun_go'}).toString();
    return (await this.transport.json(url, {signal})).text;
  }
  async exchange(code, signal) {
    const url = new URL('https://api.oplist.org/baiduyun/callback');
    url.searchParams.set('code', token(code));
    const result = await this.transport.json(url, {signal, mode: 'oauth-redirect'});
    return require('./oauth.cjs').callbackPair(result.location);
  }
  async renew(refreshToken, signal, beforeDispatch) {
    const url = new URL('https://api.oplist.org/baiduyun/renewapi');
    url.search = new URLSearchParams({refresh_ui: token(refreshToken), server_use: 'true', driver_txt: 'baiduyun_go'}).toString();
    const result = await this.transport.json(url, {signal, beforeDispatch});
    const ttl = result?.expires_in;
    if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 315360000)) fail('credential', '授权有效期无效。');
    return pairOf({accessToken: result?.access_token, refreshToken: result?.refresh_token, expiresAt: ttl === undefined ? null : Date.now() + ttl * 1000});
  }
}
function validateRecord(record, id) {
  if (!record || record.v !== 1 || record.accountId !== decimalId(id) || !text(record.revision, 128) ||
      !text(record.profile, 128) || !text(record.label, 512)) fail('credential', '凭据文件损坏或账号不匹配。');
  const pair = pairOf(record);
  if (record.pending !== undefined && !text(record.pending, 128)) fail('credential', '续期状态无效。');
  return {v: 1, accountId: record.accountId, label: record.label, profile: record.profile,
    revision: record.revision, ...pair, ...(record.pending ? {pending: record.pending} : {})};
}
/** Files are best-effort credential handoff, not a distributed lock. */
class Credentials {
  constructor(storage, providers, {makeId = randomUUID, now = Date.now} = {}) {
    this.storage = storage; this.providers = providers; this.makeId = makeId; this.now = now;
    this.sessions = new Map(); this.flights = new Map(); this.mutations = new Set(); this.lifetime = new AbortController();
  }
  async load(id) {
    check(this.lifetime.signal); id = decimalId(id);
    const record = this.sessions.get(id) || await this.storage.read(id);
    check(this.lifetime.signal);
    if (!record) fail('unauthorized', '此账号尚未授权，或凭据还未同步。');
    return validateRecord(record, id);
  }
  async write(record, persistent, signal) {
    const beforeCommit = () => { check(this.lifetime.signal); check(signal); };
    beforeCommit();
    if (persistent) await this.storage.write(record.accountId, record, {beforeCommit});
    else this.sessions.set(record.accountId, {...record});
  }
  async install(identity, pair, profile, persistent, signal) {
    check(signal); check(this.lifetime.signal);
    if (!this.providers.has(profile)) fail('credential', '不支持此授权提供者。');
    const record = validateRecord({v: 1, accountId: identity.accountId, label: identity.label, profile,
      revision: this.makeId(), ...pairOf(pair)}, identity.accountId);
    if (this.flights.has(record.accountId) || this.mutations.has(record.accountId)) fail('busy', '此账号正在更新，请完成后重试。');
    this.mutations.add(record.accountId);
    try { await this.write(record, persistent, signal); if (persistent) this.sessions.delete(record.accountId); return record; }
    finally { this.mutations.delete(record.accountId); }
  }
  async accounts() {
    check(this.lifetime.signal);
    const result = new Map();
    for (const record of await this.storage.list()) {
      try { const r = validateRecord(record, record.accountId); result.set(r.accountId, {accountId: r.accountId, label: r.label}); } catch { /* A corrupt account does not hide other accounts. */ }
    }
    check(this.lifetime.signal);
    for (const r of this.sessions.values()) result.set(r.accountId, {accountId: r.accountId, label: r.label});
    return [...result.values()];
  }
  async use(id, operation, signal) {
    check(signal); id = decimalId(id);
    if (this.mutations.has(id)) fail('busy', '账号配置正在更新。');
    let record = await this.load(id);
    if (record.pending) {
      if (this.flights.has(id)) record = await waitFor(this.flights.get(id), signal);
      else fail('repair', '凭据正在其他设备续期或上次续期中断；同步完成后重试，必要时重新授权。');
    }
    if (record.expiresAt !== null && record.expiresAt <= this.now() + 30000) record = await this.refresh(id, record, signal);
    check(signal);
    try { return await operation(record.accessToken); }
    catch (error) {
      if (!(error instanceof CloudError) || error.code !== 'unauthorized') throw error;
      check(signal);
      const latest = await this.load(id);
      const next = latest.revision !== record.revision && !latest.pending ? latest : await this.refresh(id, record, signal);
      check(signal); return operation(next.accessToken); // At most one authenticated retry.
    }
  }
  refresh(id, previous, signal) {
    check(signal); id = decimalId(id);
    if (this.mutations.has(id)) return Promise.reject(new CloudError('busy', '账号配置正在更新。'));
    let promise = this.flights.get(id);
    if (!promise) {
      promise = this.rotate(id, previous).finally(() => { if (this.flights.get(id) === promise) this.flights.delete(id); });
      this.flights.set(id, promise);
    }
    // Cancelling one UI consumer does not abandon a rotating token transaction.
    return waitFor(promise, signal);
  }
  async rotate(id, previous) {
    const current = await this.load(id);
    if (current.revision !== previous.revision && !current.pending) return current;
    if (current.pending) fail('repair', '发现未完成续期，请同步后重试或重新授权。');
    const provider = this.providers.get(current.profile);
    if (!provider) fail('credential', '授权提供者不可用。');
    const persistent = !this.sessions.has(id), attempt = this.makeId();
    let marked = false;
    const prepare = async () => {
      const before = await this.load(id);
      if (before.revision !== current.revision || before.pending) fail('conflict', '凭据已变化，未发送旧令牌。');
      await this.write({...current, pending: attempt}, persistent); marked = true;
      const saved = await this.load(id);
      if (saved.revision !== current.revision || saved.pending !== attempt) fail('conflict', '凭据同步冲突，未执行续期。');
    };
    let pair;
    try {
      if (!provider.supportsDispatchHook) await prepare();
      pair = await provider.renew(current.refreshToken, this.lifetime.signal, prepare);
    } catch (error) {
      // Only a positively known not-sent request may clear our own marker.
      // Unknown responses, shutdown, revocation and write failures stay fail-closed.
      if (marked && error?.delivery === 'not-sent' && !this.lifetime.signal.aborted) {
        const latest = await this.load(id);
        if (latest.revision === current.revision && latest.pending === attempt) await this.write(current, persistent);
      }
      throw error;
    }
    const latest = await this.load(id);
    if (latest.revision !== current.revision && !latest.pending) return latest;
    if (!marked || latest.revision !== current.revision || latest.pending !== attempt) fail('conflict', '凭据同步冲突，未覆盖其他设备的结果。');
    const next = validateRecord({v: 1, accountId: id, label: current.label, profile: current.profile,
      revision: this.makeId(), ...pairOf(pair)}, id);
    await this.write(next, persistent); return next;
  }
  async remove(id) {
    id = decimalId(id); check(this.lifetime.signal);
    if (this.flights.has(id) || this.mutations.has(id)) fail('busy', '账号正在更新，请完成后移除。');
    this.mutations.add(id);
    try { await this.storage.remove(id); this.sessions.delete(id); }
    finally { this.mutations.delete(id); }
  }
  close() { this.lifetime.abort(); this.sessions.clear(); }
}
module.exports = {OpenListAuth, Credentials, validateRecord, token, pairOf};
