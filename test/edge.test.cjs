'use strict';
// Additional hardening fixtures; no real network, credentials or native GUI.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {CredentialFiles}=require('../src/storage.cjs');
const {JsonTransport}=require('../src/transport.cjs');
const R=require('../src/reference.cjs');
const {authorize,CALLBACK}=require('../src/oauth.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const login='https://openapi.baidu.com/oauth/2.0/authorize?'+new URLSearchParams({client_id:'fixture',scope:'basic,netdisk',response_type:'code',redirect_uri:CALLBACK});
const url='https://pan.baidu.com/rest/2.0/xpan/file?method=list&access_token=fixture';
const ref={provider:'baidu',accountId:'1234567890123456789',fileId:'9876543210123456789',kind:'file',path:'/fixture/book.pdf',name:'book.pdf'};
async function fixture(t){const raw=await fs.mkdtemp(path.join(os.tmpdir(),'cloudref-test-')),dir=await fs.realpath(raw);t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,storage:new CredentialFiles(path.join(dir,'accounts'))};}
function requestFixture({status=200,body='{"errno":0,"list":[]}',headers={},hang=false,chunks}={}){
  const requests=[];let aborted=false;
  const request=(u,options,cb)=>{
    const req=new EventEmitter();req.destroy=()=>{aborted=true;req.emit('close');};req.end=()=>{if(hang)return;queueMicrotask(()=>{
      const response=new EventEmitter();response.statusCode=status;response.headers=headers;response.destroy=()=>response.emit('aborted');cb(response);
      if(status!==200||headers['content-length']>2*1024*1024)return;
      for(const bytes of chunks||[Buffer.from(body)])response.emit('data',bytes);response.emit('end');req.emit('close');
    });};requests.push({u,options,req});return req;
  };return {request,requests,isAborted:()=>aborted};
}
function bridgeFixture() {
  const state = {windows: [], exchanges: 0, cleared: 0};
  const session = new EventEmitter();
  session.webRequest = {onBeforeRequest(filter, callback) { state.interceptor = callback || null; }};
  session.setPermissionRequestHandler = handler => { state.permission = handler; };
  session.setPermissionCheckHandler = handler => { state.permissionCheck = handler; };
  session.clearStorageData = async () => { state.cleared++; };
  class BrowserWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.dead = false; this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { state.newWindow = handler; }; state.windows.push(this); }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
  }
  const bridge = {BrowserWindow, session: {fromPartition(partition, options) { state.partition = partition; state.sessionOptions = options; return session; }}};
  const auth = {begin: async () => login, exchange: async code => { state.exchanges++; assert.equal(code, 'test-code'); return {accessToken: 'a', refreshToken: 'b', expiresAt: null}; }};
  return {state, bridge, auth, session};
}

test('temporary Windows rename contention has a bounded retry without deleting the destination', async t => {
  const {dir}=await fixture(t);let attempts=0,checks=0;
  const storage=new CredentialFiles(path.join(dir,'accounts'),{rename:async(...args)=>{
    attempts++;if(attempts<=2)throw Object.assign(Error('Fixture file in use'),{code:'EBUSY'});return fs.rename(...args);
  }});
  await storage.write('123',{pair:'new'},{beforeCommit:async()=>{checks++;}});
  assert.equal(attempts,3);assert.equal(checks,3);assert.deepEqual(await storage.read('123'),{pair:'new'});
});
test('permanent rename contention preserves old credentials and removes the temporary file', async t => {
  const {storage}=await fixture(t);await storage.write('123',{pair:'old'});let attempts=0;
  storage.rename=async()=>{attempts++;throw Object.assign(Error('locked'),{code:'EPERM'});};
  await assert.rejects(storage.write('123',{pair:'new'}),e=>e.code==='storage');
  assert.equal(attempts,3);assert.deepEqual(await storage.read('123'),{pair:'old'});assert.equal((await fs.readdir(storage.directory)).length,1);
});
test('identity check is repeated before retrying a locally blocked rename', async t => {
  const {storage}=await fixture(t);await storage.write('123',{pair:'old'});let attempts=0,checks=0;
  storage.rename=async()=>{attempts++;throw Object.assign(Error('locked'),{code:'EACCES'});};
  await assert.rejects(storage.write('123',{pair:'new'},{beforeCommit:()=>{
    if(++checks===2)throw new (require('../src/reference.cjs').CloudError)('conflict','Fixture peer change');
  }}),e=>e.code==='conflict');
  assert.equal(attempts,1);assert.deepEqual(await storage.read('123'),{pair:'old'});
});

test('unpaired surrogates cannot silently change link paths or display names',()=>{
  for(const bad of ['\uD800','\uDC00','ok\uD800end','\uDC00\uDC00']){
    assert.throws(()=>R.reference({...ref,name:bad}));assert.throws(()=>R.pathOf('/'+bad));
  }
  assert.equal(R.parseLink(R.linkOf({...ref,name:'📚书',path:'/📚书.pdf'})).name,'📚书');
});
test('strict UTF-8 decoding rejects damaged bytes rather than replacing a filename',()=>{
  assert.throws(()=>R.parseJsonBytes(Buffer.from([123,34,120,34,58,34,0xc3,0x28,34,125])),e=>e.code==='protocol');
  assert.deepEqual(R.parseJsonBytes(Buffer.from('{"name":"书📚"}')),{name:'书📚'});
});
test('large JSON parsing preserves quoted escapes and every unsafe integer identity',()=>{
  const item='{"fs_id":9876543210123456789,"s":"quote\\\" and \\\\ slash","n":-9007199254740993}';
  const parsed=R.parseJson('['+Array(5000).fill(item).join(',')+']');
  assert.equal(parsed.length,5000);assert.ok(parsed.every(v=>v.fs_id==='9876543210123456789'&&v.n==='-9007199254740993'));
  assert.equal(parsed[4999].s,'quote" and \\ slash');
});

test('repeated OAuth cancellation detaches ephemeral session and window handlers',async()=>{
  for(let index=0;index<20;index++){
    const {state,bridge,auth,session}=bridgeFixture(),controller=new AbortController();
    const p=authorize(auth,{bridgeFactory:()=>bridge,signal:controller.signal});const rejected=assert.rejects(p,e=>e.code==='cancelled');await tick();
    controller.abort();await rejected;
    assert.equal(session.listenerCount('will-download'),0);assert.equal(state.interceptor,null);
    assert.equal(state.permission,null);assert.equal(state.permissionCheck,null);
    assert.equal(state.windows[0].listenerCount('closed'),0);
    assert.equal(state.windows[0].webContents.listenerCount('will-attach-webview'),0);
  }
});

test('malformed UTF-8 is rejected before constructing metadata',async()=>{
  const f=requestFixture({chunks:[Buffer.from([123,34,110,34,58,34,0xc3,0x28,34,125])]}),t=new JsonTransport(f);
  await assert.rejects(t.json(url),e=>e.code==='protocol');t.close();
});
test('late stream errors on redirect and HTTP failure responses are always observed',async()=>{
  for(const status of [302,403,500]){
    const errors=[];
    const t=new JsonTransport({request(u,options,cb){
      const req=new EventEmitter();req.destroy=()=>req.emit('close');req.end=()=>queueMicrotask(()=>{
        const response=new EventEmitter();response.statusCode=status;response.headers={location:'/#fixture'};response.destroy=()=>{};
        cb(response);try{response.emit('error',Error('Fixture late error'));}catch(error){errors.push(error);}req.emit('close');
      });return req;
    }});
    if(status===302)await t.json('https://api.oplist.org/baiduyun/callback?code=fixture',{mode:'oauth-redirect'});
    else await assert.rejects(t.json(url));
    assert.equal(errors.length,0);t.close();
  }
});
test('late response after cancellation is destroyed without reading its contents',async()=>{
  let callback,destroyed=false;
  const t=new JsonTransport({request(u,options,cb){callback=cb;const req=new EventEmitter();req.end=()=>{};req.destroy=()=>req.emit('close');return req;}});
  const c=new AbortController(),p=t.json(url,{signal:c.signal});const rejected=assert.rejects(p);c.abort();await rejected;
  const response=new EventEmitter();response.statusCode=200;response.headers={};response.destroy=()=>{destroyed=true;};callback(response);
  response.emit('data',Buffer.alloc(1024));response.emit('error',Error('Fixture late failure'));
  assert.equal(destroyed,true);assert.equal(t.bytes,0);assert.equal(t.requests.size,0);t.close();
});
