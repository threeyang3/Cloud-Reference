'use strict';
const https = require('node:https');
const {CloudError, parseJson} = require('./reference.cjs');
const {RequestGate, check, aborted} = require('./runtime.cjs');
const BROKERS = Object.freeze({openlist: 'https://api.oplist.org'});

function allowed(u, method, mode = 'json') {
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || u.href.length > 16384) return false;
  if (u.origin === BROKERS.openlist) {
    if (mode === 'oauth-redirect') return method === 'GET' && u.pathname === '/baiduyun/callback';
    return method === 'GET' && ['/baiduyun/renewapi', '/baiduyun/requests'].includes(u.pathname);
  }
  if (mode !== 'json' || u.hostname !== 'pan.baidu.com') return false;
  if (u.pathname === '/xpan/unisearch') return method === 'POST';
  const methods = {
    '/rest/2.0/xpan/file': ['list', 'search'],
    '/rest/2.0/xpan/multimedia': ['filemetas'],
    '/rest/2.0/xpan/nas': ['uinfo'],
  };
  return method === 'GET' && Object.hasOwn(methods, u.pathname) &&
    u.searchParams.getAll('method').length === 1 && methods[u.pathname].includes(u.searchParams.get('method'));
}

/** Bounded HTTPS transport. OAuth redirect envelopes are parsed, never followed. */
class JsonTransport {
  constructor({request = https.request, timeout = 20000, maxBytes = 2 * 1024 * 1024, now = Date.now} = {}) {
    this.request = request; this.timeout = timeout; this.maxBytes = maxBytes; this.now = now;
    this.gate = new RequestGate(3, 64); this.requests = new Set(); this.controllers = new Set();
    this.count = 0; this.bytes = 0; this.cooldowns = new Map(); this.closed = false;
  }
  json(raw, {signal, method = 'GET', body, beforeDispatch, mode = 'json'} = {}) {
    let url;
    try { url = new URL(raw); } catch { return Promise.reject(new CloudError('policy', '请求地址无效。')); }
    if (!allowed(url, method, mode) || (body !== undefined && (typeof body !== 'string' || Buffer.byteLength(body) > 8192))) {
      return Promise.reject(new CloudError('policy', '请求地址或操作不被允许。'));
    }
    if (this.closed) return Promise.reject(aborted());
    return this.gate.run(() => this.send(url, {signal, method, body, beforeDispatch, mode}), signal);
  }
  async send(url, {signal, method, body, beforeDispatch, mode}) {
    check(signal);
    if (this.now() < (this.cooldowns.get(url.origin) || 0)) {
      const error = new CloudError('rate-limit', '服务请求限流，请稍后重试。'); error.delivery = 'not-sent'; throw error;
    }
    return new Promise((resolve, reject) => {
      let req, timer, done = false, dispatched = false, preparing = false;
      const finish = (error, value) => {
        if (done) return;
        done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.controllers.delete(abort); if (req) this.requests.delete(req);
        if (error) { error.delivery ||= dispatched ? 'unknown' : 'not-sent'; reject(error); } else resolve(value);
      };
      const abort = () => { finish(aborted()); req?.destroy(); };
      const dispatch = async () => {
        if (done || preparing) return;
        preparing = true;
        try {
          // For token rotation this hook persists the recovery marker after TLS
          // connection succeeds, before any HTTP credentials leave the process.
          await beforeDispatch?.();
          check(signal);
          if (done || this.closed) { abort(); return; }
          dispatched = true; req.end(body);
        } catch (error) {
          finish(error instanceof CloudError ? error : new CloudError('storage', '请求准备失败。'));
          req?.destroy();
        }
      };
      this.controllers.add(abort);
      try {
        const headers = {'User-Agent': 'pan.baidu.com', Accept: 'application/json', 'Accept-Encoding': 'identity'};
        if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
        // APIPages callback reads these fixed, non-secret selection cookies.
        if (mode === 'oauth-redirect') headers.Cookie = 'server_use=true; driver_txt=baiduyun_go';
        req = this.request(url, {method, headers}, response => {
          const status = response.statusCode || 0;
          if (mode === 'oauth-redirect' && [302, 303].includes(status)) {
            const location = response.headers.location;
            if (typeof location !== 'string' || location.length > 32768) finish(new CloudError('protocol', '授权回调格式无效。'));
            else finish(null, {location});
            response.destroy(); return;
          }
          if (status !== 200 || mode !== 'json') {
            if (status === 429) {
              const value = response.headers['retry-after'];
              let seconds = Number(value);
              if (!Number.isFinite(seconds)) seconds = (Date.parse(value) - this.now()) / 1000;
              this.cooldowns.set(url.origin, this.now() + Math.min(120, Math.max(5, Number.isFinite(seconds) ? seconds : 30)) * 1000);
            }
            finish(new CloudError(status === 429 ? 'rate-limit' : status === 401 ? 'unauthorized' : 'http', `服务返回 HTTP ${status}，未自动重试。`));
            response.destroy(); return;
          }
          const length = Number(response.headers['content-length']);
          if (Number.isFinite(length) && length > this.maxBytes) { finish(new CloudError('limit', '响应超过大小上限。')); response.destroy(); return; }
          let size = 0; const chunks = [];
          response.on('data', bytes => {
            if (done) return;
            size += bytes.length; this.bytes += bytes.length;
            if (size > this.maxBytes) { finish(new CloudError('limit', '响应超过大小上限。')); response.destroy(); }
            else chunks.push(bytes);
          });
          response.on('end', () => { if (!done) { try { finish(null, parseJson(Buffer.concat(chunks).toString('utf8'))); } catch (e) { finish(e); } } });
          response.on('error', () => finish(new CloudError('network', '网盘响应中断。')));
          response.on('aborted', () => finish(new CloudError('network', '网盘响应中断。')));
          response.on('close', () => { if (!done) finish(new CloudError('network', '网盘响应未完整结束。')); });
        });
        this.requests.add(req); this.count++;
        req.on('error', () => finish(new CloudError('network', '无法连接网盘服务。')));
        req.on('close', () => { if (!done) finish(new CloudError('network', '请求已经关闭。')); });
        signal?.addEventListener('abort', abort, {once: true});
        timer = setTimeout(() => { finish(new CloudError('timeout', '请求超时。')); req.destroy(); }, this.timeout);
        if (signal?.aborted) { abort(); return; }
        if (beforeDispatch) {
          req.on('socket', socket => {
            if (socket.connecting || socket.secureConnecting) socket.once('secureConnect', dispatch);
            else void dispatch();
          });
        } else { dispatched = true; req.end(body); }
      } catch { finish(new CloudError('network', '无法发起网盘请求。')); req?.destroy(); }
    });
  }
  diagnostics() { return {requests: this.count, responseBytes: this.bytes, active: this.gate.active, queued: this.gate.queue.length, peakConcurrency: this.gate.peak}; }
  close() { this.closed = true; this.gate.close(); for (const abort of [...this.controllers]) abort(); this.controllers.clear(); }
}
module.exports = {JsonTransport, BROKERS, allowed};
