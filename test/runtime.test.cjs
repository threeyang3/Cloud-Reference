'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {RequestGate,MetadataCache}=require('../src/runtime.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
test('request concurrency bounded at three; queued work drains',async()=>{const g=new RequestGate(3),releases=[];let count=0;const tasks=Array.from({length:9},()=>g.run(()=>new Promise(r=>{count++;releases.push(r);})));await tick();assert.equal(count,3);while(releases.length){releases.splice(0).forEach(r=>r());await tick();}await Promise.all(tasks);assert.equal(count,9);assert.equal(g.peak,3);assert.equal(g.active,0);});
test('cancelled queue entries never execute',async()=>{const g=new RequestGate(1);let release,called=false;const first=g.run(()=>new Promise(r=>release=r));const c=new AbortController();const next=g.run(()=>{called=true;},c.signal);c.abort();await assert.rejects(next);release();await first;assert.equal(called,false);assert.equal(g.active,0);});
test('queue cap and shutdown reject pending operations',async()=>{const g=new RequestGate(1,1);let release;const first=g.run(()=>new Promise(r=>release=r));const second=g.run(()=>{});const caught=assert.rejects(second);await assert.rejects(g.run(()=>{}),e=>e.code==='busy');g.close();await caught;release();await first;await assert.rejects(g.run(()=>{}));});
test('500 consumers for same file cause one metadata request',async()=>{const cache=new MetadataCache();let calls=0;const loader=async()=>{calls++;await tick();return {name:'a'};};const rows=await Promise.all(Array.from({length:500},()=>cache.get('same',loader)));assert.equal(calls,1);assert.equal(rows.length,500);rows[0].name='changed';assert.equal(rows[1].name,'a');});
test('one waiter cancellation does not abort another waiter',async()=>{const cache=new MetadataCache();let release,aborted=false;const loader=s=>{s.addEventListener('abort',()=>aborted=true);return new Promise(r=>release=r);};const c=new AbortController();const p=cache.get('x',loader,c.signal),q=cache.get('x',loader);await tick();c.abort();await assert.rejects(p);assert.equal(aborted,false);release({x:1});assert.deepEqual(await q,{x:1});});
test('last waiter cancellation aborts shared request and late result is not cached',async()=>{const cache=new MetadataCache();let release,signal;const c=new AbortController(),p=cache.get('x',s=>{signal=s;return new Promise(r=>release=r);},c.signal);await tick();c.abort();await assert.rejects(p);assert.equal(signal.aborted,true);release({x:1});await tick();assert.equal(cache.values.size,0);assert.equal(cache.pending.size,0);});
test('cache is LRU bounded and expires lazily, without interval timers',async()=>{let now=0,calls=0;const cache=new MetadataCache({limit:2,ttl:10,now:()=>now}),load=async()=>({n:++calls});await cache.get('a',load);await cache.get('b',load);await cache.get('a',load);await cache.get('c',load);assert.deepEqual([...cache.values.keys()],['a','c']);now=11;await cache.get('a',load);assert.equal(calls,4);cache.close();await assert.rejects(cache.get('a',load));});
test('pending metadata cap protects a page with many unique links',async()=>{const cache=new MetadataCache(),controller=new AbortController(),tasks=[];for(let i=0;i<64;i++)tasks.push(cache.get(String(i),()=>new Promise(()=>{}),controller.signal).catch(()=>null));await assert.rejects(cache.get('overflow',async()=>({})),e=>e.code==='busy');controller.abort();await Promise.all(tasks);assert.equal(cache.pending.size,0);});

test('name scheduler bounds visible-label concurrency separately from foreground work',async()=>{
  const {NameScheduler}=require('../src/runtime.cjs'),s=new NameScheduler(),release=[];let calls=0;
  const tasks=Array.from({length:20},(_,i)=>s.get(String(i),()=>new Promise(r=>{calls++;release.push(()=>r({name:String(i)}));})));
  await tick();assert.equal(calls,2);while(release.length){release.splice(0).forEach(r=>r());await tick();}await Promise.all(tasks);assert.equal(s.gate.peak,2);s.close();
});
test('500 identical visible links share one lookup; unloading releases all waiters',async()=>{
  const {NameScheduler}=require('../src/runtime.cjs'),s=new NameScheduler();let calls=0;
  const results=await Promise.all(Array.from({length:500},()=>s.get('one',async()=>{calls++;await tick();return {name:'one'};})));
  assert.equal(calls,1);assert.equal(results.length,500);s.close();assert.equal(s.shared.pending.size,0);assert.equal(s.gate.queue.length,0);
});
test('invalidating an in-flight cache entry prevents a stale result being cached',async()=>{
  const c=new MetadataCache();let release;const old=c.get('x',()=>new Promise(r=>release=r));const rejected=assert.rejects(old,e=>e.code==='cancelled');await tick();c.invalidate('x');
  assert.deepEqual(await c.get('x',async()=>({name:'new'})),{name:'new'});release({name:'old'});await rejected;
  assert.deepEqual(await c.get('x',async()=>({name:'unexpected'})),{name:'new'});c.close();
});
