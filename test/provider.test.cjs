'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {BaiduProvider}=require('../src/baidu.cjs');const {CloudService}=require('../src/service.cjs');
const folder={provider:'baidu',accountId:'123',fileId:'100',kind:'folder',path:'/a',name:'a'};
const entry=(id,path,isdir=0)=>({fs_id:id,path,server_filename:path.split('/').pop(),isdir,size:100,server_mtime:10});
function provider(responses){const calls=[];const p=new BaiduProvider({json:async(u,o)=>{calls.push({u,o});return responses.shift();}},{use:async(id,fn)=>fn('secret')});return {p,calls};}
test('stat uses stable ID and returns new name/path after move',async()=>{const {p,calls}=provider([{errno:0,list:[entry('100','/new/a',1)]}]);const result=await p.stat(folder);assert.equal(result.path,'/new/a');assert.equal(calls[0].u.searchParams.get('fsids'),'[100]');assert.equal(calls[0].u.searchParams.get('dlink'),'0');});
test('file and folder identity mismatch is rejected',async()=>{for(const item of [entry('101','/a',1),entry('100','/a',0)]){const {p}=provider([{errno:0,list:[item]}]);await assert.rejects(p.stat(folder),e=>e.code==='identity');}});
test('missing folder is not resolved by reusing stale path',async()=>{const {p,calls}=provider([{errno:0,list:[]}]);await assert.rejects(p.stat(folder),e=>e.code==='not-found');assert.equal(calls.length,1);});
test('list is bounded and pagination advances by server limit',async()=>{const {p}=provider([{errno:0,list:Array.from({length:50},(_,i)=>entry(String(i+1),'/a/'+i))}]);const result=await p.list(folder);assert.equal(result.items.length,50);assert.equal(result.nextOffset,50);});
test('list rejects items outside requested folder',async()=>{const {p}=provider([{errno:0,list:[entry('1','/ab/x')]}]);await assert.rejects(p.list(folder),e=>e.code==='identity');});
test('search uses official paginated filename API; client enforces subtree',async()=>{
  const {p,calls}=provider([{errno:0,has_more:1,list:[entry('1','/a/sub/one'),entry('2','/ab/no'),entry('1','/a/sub/one')]}]);
  const result=await p.search(folder,'one',{offset:50});
  assert.equal(result.items.length,1);assert.equal(result.nextOffset,100);
  assert.equal(calls[0].u.pathname,'/rest/2.0/xpan/file');
  for(const [key,value] of Object.entries({method:'search',dir:'/a',recursion:'1',key:'one',page:'2',num:'50'}))assert.equal(calls[0].u.searchParams.get(key),value);
  assert.equal(calls[0].o.body,undefined);assert.equal(result.scopeFiltered,true);
});
test('search denial does not fall back to recursive crawling',async()=>{const {p,calls}=provider([{error_no:403}]);await assert.rejects(p.search(folder,'x'));assert.equal(calls.length,1);});
test('API errors cannot masquerade as empty directories',async()=>{for(const raw of [{error:'bad'},{errno:0},{errno:0,list:null}]){const {p}=provider([raw]);await assert.rejects(p.list(folder));}});
test('service opens only an explicitly registered compatible opener',async()=>{let payload;const s=new CloudService({stat:async r=>({...r,accessToken:'must-not-leak'})});const remove=s.registerOpener({id:'reader',canOpen:()=>true,open:async r=>{payload=r;}});await s.openWith('reader',folder);assert.equal(payload.accessToken,undefined);remove();await assert.rejects(s.openWith('reader',folder));s.close();});
test('constructor performs no network requests or scans',()=>{const {p,calls}=provider([]);const s=new CloudService(p);assert.equal(calls.length,0);assert.equal(s.cache.values.size,0);s.close();});

test('search validates keyword and pagination before any network request',async()=>{
  const {p,calls}=provider([]);for(const q of ['', 'a'.repeat(31)])await assert.rejects(p.search(folder,q));
  for(const offset of [-1,1,NaN,1000050])await assert.rejects(p.search(folder,'x',{offset}));assert.equal(calls.length,0);
});
test('search response size and continuation field are validated',async()=>{
  for(const raw of [{errno:0,list:Array.from({length:51},(_,i)=>entry(String(i+1),'/a/'+i))},{errno:0,list:[],has_more:'yes'}]){
    const {p}=provider([raw]);await assert.rejects(p.search(folder,'x'),e=>e.code==='protocol');
  }
});
test('disabled opener cannot run after a pending resource resolution',async()=>{
  let release,called=false;const s=new CloudService({stat:()=>new Promise(r=>release=r)});
  const remove=s.registerOpener({id:'reader',canOpen:()=>true,open:()=>{called=true;}}),p=s.openWith('reader',folder);
  await new Promise(r=>setImmediate(r));remove();release(folder);await assert.rejects(p);assert.equal(called,false);s.close();
});
test('the built-in opener names are reserved and disposal blocks registration',()=>{
  const s=new CloudService({});
  for (const id of ['web', 'baidu-client']) assert.throws(()=>s.registerOpener({id,canOpen:()=>true,open(){}}));
  s.close();assert.throws(()=>s.registerOpener({id:'reader',canOpen:()=>true,open(){}}));
});
test('per-item missing metadata is reported as not-found before shape validation',async()=>{
  const {p}=provider([{errno:0,list:[{fs_id:'100',errno:-9}]}]);await assert.rejects(p.stat(folder),e=>e.code==='not-found');
});
test('empty search page cannot promise unbounded continuation',async()=>{
  const {p}=provider([{errno:0,list:[],has_more:1}]);await assert.rejects(p.search(folder,'x'),e=>e.code==='protocol');
});
