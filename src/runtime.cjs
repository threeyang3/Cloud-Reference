'use strict';
const {CloudError} = require('./reference.cjs');
const aborted = () => new CloudError('cancelled','操作已取消。');
function check(signal) { if (signal?.aborted) throw aborted(); }
function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    // Observe an already-started operation even when its consumer is cancelled.
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(aborted());
  }
  return new Promise((resolve,reject) => {
    const cleanup = () => signal.removeEventListener('abort',abort);
    const abort = () => { cleanup(); reject(aborted()); };
    signal.addEventListener('abort',abort,{once:true});
    promise.then(v => { cleanup(); resolve(v); },e => { cleanup(); reject(e); });
  });
}
class RequestGate {
  constructor(limit = 3, queueLimit = 64) { this.limit=limit;this.queueLimit=queueLimit;this.active=0;this.peak=0;this.queue=[];this.closed=false; }
  async run(task,signal) {
    check(signal); if (this.closed) throw aborted();
    if (this.active >= this.limit) {
      if (this.queue.length >= this.queueLimit) throw new CloudError('busy','请求过多，请稍后重试。');
      await new Promise((resolve,reject) => {
        const item={resolve,reject,signal};
        item.abort=()=>{const i=this.queue.indexOf(item);if(i>=0)this.queue.splice(i,1);reject(aborted());};
        signal?.addEventListener('abort',item.abort,{once:true});this.queue.push(item);
      });
    } else { this.active++;this.peak=Math.max(this.peak,this.active); }
    try {check(signal);if(this.closed)throw aborted();return await task();}
    finally {const next=this.queue.shift();if(next){next.signal?.removeEventListener('abort',next.abort);next.resolve();}else this.active--;}
  }
  close(){this.closed=true;for(const q of this.queue.splice(0)){q.signal?.removeEventListener('abort',q.abort);q.reject(aborted());}}
}
class MetadataCache {
  constructor({limit=256,ttl=120000,now=Date.now}={}){this.limit=limit;this.ttl=ttl;this.now=now;this.values=new Map();this.pending=new Map();this.closed=false;this.hits=0;this.loads=0;this.merged=0;}
  get(key,loader,signal){
    try{check(signal);if(this.closed)throw aborted();}catch(e){return Promise.reject(e);}
    const cached=this.values.get(key);
    if(cached&&cached.until>this.now()){this.hits++;this.values.delete(key);this.values.set(key,cached);return Promise.resolve({...cached.value});}
    this.values.delete(key);
    let entry=this.pending.get(key);
    if(!entry){
      if(this.pending.size>=64)return Promise.reject(new CloudError('busy','元数据请求过多，请稍后重试。'));
      this.loads++;entry={controller:new AbortController(),waiters:0};const current=entry;
      const work=Promise.resolve().then(()=>{check(current.controller.signal);return loader(current.controller.signal);}).then(value=>{
        check(current.controller.signal);if(this.closed)throw aborted();
        if(!this.closed&&this.pending.get(key)===current&&!current.controller.signal.aborted){
          this.values.set(key,{value:{...value},until:this.now()+this.ttl});
          while(this.values.size>this.limit)this.values.delete(this.values.keys().next().value);
        }return value;
      });
      // Release subscribers on invalidation/unload even if a custom loader does
      // not honour AbortSignal. Its late completion still cannot fill the cache.
      entry.promise=waitFor(work,current.controller.signal).finally(()=>{if(this.pending.get(key)===current)this.pending.delete(key);});
      this.pending.set(key,entry);
    }
    if(entry.waiters>0)this.merged++;
    entry.waiters++;
    return waitFor(entry.promise,signal).then(v=>({...v})).finally(()=>{
      entry.waiters--;if(entry.waiters===0&&this.pending.get(key)===entry){this.pending.delete(key);entry.controller.abort();}
    });
  }
  // A fresh foreground read bypasses a saved value but joins a live request.
  // Reserve invalidate() for identity/account changes that really cancel work.
  evict(key){this.values.delete(key);}
  invalidate(key){this.values.delete(key);const e=this.pending.get(key);if(e){this.pending.delete(key);e.controller.abort();}}
  diagnostics(){return {entries:this.values.size,pending:this.pending.size,hits:this.hits,loads:this.loads,merged:this.merged};}
  clear(){this.values.clear();for(const e of this.pending.values())e.controller.abort();this.pending.clear();}
  close(){this.closed=true;this.clear();}
}
/** Low-priority visible-label lookups, separate from user initiated requests. */
class NameScheduler {
  constructor() { this.gate = new RequestGate(2, 32); this.shared = new MetadataCache({limit: 0, ttl: 0}); }
  get(key, load, signal) { return this.shared.get(key, s => this.gate.run(() => load(s), s), signal); }
  close() { this.shared.close(); this.gate.close(); }
}
module.exports={aborted,check,waitFor,RequestGate,MetadataCache,NameScheduler};
