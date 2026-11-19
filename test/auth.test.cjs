'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Credentials,OpenListAuth}=require('../src/auth.cjs');const {CloudError}=require('../src/reference.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(renew=async()=>({accessToken:'new-access',refreshToken:'new-refresh',expiresAt:null})){
  let serial=0;const map=new Map(),storage={read:async id=>map.get(id)?{...map.get(id)}:null,write:async(id,r)=>{map.set(id,{...r});},list:async()=>[...map.values()],remove:async id=>{map.delete(id);}};
  const credentials=new Credentials(storage,new Map([['openlist',{renew}]]),{makeId:()=>String(++serial)});return {credentials,map,storage};
}
const identity={accountId:'123',label:'账号'},pair={accessToken:'old-access',refreshToken:'old-refresh',expiresAt:null};
test('session mode does not persist secrets',async()=>{const {credentials:c,map}=fixture();await c.install(identity,pair,'openlist',false);assert.equal(map.size,0);assert.equal((await c.load('123')).accessToken,'old-access');c.close();await assert.rejects(c.load('123'));});
test('sync mode rereads newer on-disk credential before each request',async()=>{const {credentials:c,map}=fixture();await c.install(identity,pair,'openlist',true);map.set('123',{...map.get('123'),revision:'peer',accessToken:'peer-access'});assert.equal(await c.use('123',async t=>t),'peer-access');});
test('concurrent rejected tokens produce one refresh and paired commit',async()=>{let count=0;const {credentials:c,map}=fixture(async()=>{count++;await tick();return {accessToken:'new-access',refreshToken:'new-refresh',expiresAt:null};});await c.install(identity,pair,'openlist',true);const fn=async token=>{if(token==='old-access'){await tick();throw new CloudError('unauthorized','expired');}return token;};const values=await Promise.all(Array.from({length:10},()=>c.use('123',fn)));assert.equal(count,1);assert.ok(values.every(v=>v==='new-access'));assert.equal(map.get('123').refreshToken,'new-refresh');assert.equal(map.get('123').pending,undefined);});
test('ambiguous refresh failure leaves marker and does not replay old refresh token',async()=>{let n=0;const {credentials:c,map}=fixture(async()=>{n++;throw new CloudError('network','failed');});await c.install(identity,pair,'openlist',true);await assert.rejects(c.use('123',async()=>{throw new CloudError('unauthorized','expired');}));assert.ok(map.get('123').pending);await assert.rejects(c.use('123',async()=>1),e=>e.code==='repair');assert.equal(n,1);});
test('older refresh completion never overwrites newer synchronized record',async()=>{let release;const {credentials:c,map}=fixture(()=>new Promise(r=>release=r));await c.install(identity,pair,'openlist',true);const previous=await c.load('123'),p=c.refresh('123',previous);await tick();map.set('123',{...previous,revision:'peer',accessToken:'peer-access'});release({accessToken:'late',refreshToken:'late-refresh',expiresAt:null});assert.equal((await p).accessToken,'peer-access');assert.equal(map.get('123').accessToken,'peer-access');});
test('failure after successful refresh response retains pending marker on disk',async()=>{const {credentials:c,map,storage}=fixture();await c.install(identity,pair,'openlist',true);const normal=storage.write;storage.write=async(id,r)=>{if(!r.pending)throw Error('disk full');return normal(id,r);};await assert.rejects(c.refresh('123',await c.load('123')));assert.ok(map.get('123').pending);});
test('cancelled waiter does not interrupt credential rotation commit',async()=>{let release;const {credentials:c,map}=fixture(()=>new Promise(r=>release=r));await c.install(identity,pair,'openlist',true);const controller=new AbortController(),p=c.refresh('123',await c.load('123'),controller.signal);await tick();controller.abort();await assert.rejects(p);release({accessToken:'new',refreshToken:'new-refresh',expiresAt:null});await tick();assert.equal(map.get('123').accessToken,'new');assert.equal(map.get('123').pending,undefined);});
test('account listing exposes no tokens',async()=>{const {credentials:c}=fixture();await c.install(identity,pair,'openlist',true);assert.deepEqual(await c.accounts(),[identity]);});
test('account details show the effective storage and renewal deadline without exposing the record', async () => {
  const {credentials, map} = fixture();
  credentials.now = () => 100000;
  const due = {accountId: '456', label: '即将到期'};
  const connected = {accountId: '789', label: '仍有效'};
  const session = {...identity, label: '会话账号'};
  await credentials.install(identity, pair, 'openlist', true);
  await credentials.install(due, {...pair, expiresAt: 130000}, 'openlist', true);
  await credentials.install(connected, {...pair, expiresAt: 130001}, 'openlist', true);
  await credentials.install(session, pair, 'openlist', false);
  map.set('999', {accountId: '999'});

  assert.deepEqual(await credentials.accounts(), [session, due, connected]);
  assert.deepEqual(await credentials.accountDetails(), [
    {...session, persistent: false, status: 'connected'},
    {...due, persistent: true, status: 'renewal-due'},
    {...connected, persistent: true, status: 'connected'}
  ]);
});
test('account details distinguish ongoing renewal from a recovery marker without retrying', async () => {
  let rejectRenewal;
  const {credentials, map} = fixture(() => new Promise((_, reject) => { rejectRenewal = reject; }));
  await credentials.install(identity, pair, 'openlist', true);
  const renewal = credentials.refresh(identity.accountId, await credentials.load(identity.accountId));
  const rejection = assert.rejects(renewal, {code: 'network'});
  await tick();

  assert.ok(map.get(identity.accountId).pending);
  assert.deepEqual(await credentials.accountDetails(), [{...identity, persistent: true, status: 'renewing'}]);
  rejectRenewal(new CloudError('network', 'fixture failed after dispatch'));
  await rejection;
  assert.deepEqual(await credentials.accountDetails(), [{...identity, persistent: true, status: 'recovery'}]);
  assert.ok(map.get(identity.accountId).pending);
});
test('closing credentials during the local account scan prevents a late details result', async () => {
  const {credentials, storage, map} = fixture();
  await credentials.install(identity, pair, 'openlist', true);
  let finishScan;
  storage.list = () => new Promise(resolve => { finishScan = resolve; });
  const result = credentials.accountDetails();
  const rejection = assert.rejects(result, {code: 'cancelled'});
  credentials.close();
  finishScan([...map.values()]);
  await rejection;
});
test('permanent unauthorized response has a one-retry ceiling',async()=>{let n=0;const {credentials:c}=fixture();await c.install(identity,pair,'openlist',true);await assert.rejects(c.use('123',async()=>{n++;throw new CloudError('unauthorized','expired');}));assert.equal(n,2);});
test('OpenList renewal request has fixed endpoint and redacts failures',async()=>{let seen;const auth=new OpenListAuth({json:async u=>{seen=u;return {access_token:'new',refresh_token:'renew',expires_in:3600};}});const out=await auth.renew('secret');assert.equal(seen.origin,'https://api.oplist.org');assert.equal(seen.pathname,'/baiduyun/renewapi');assert.equal(seen.searchParams.get('driver_txt'),'baiduyun_go');assert.equal(out.refreshToken,'renew');assert.ok(out.expiresAt>Date.now());});

test('known not-sent refresh clears only its own recovery marker',async()=>{
  let n=0;const {credentials:c,map}=fixture(async()=>{n++;const e=new CloudError('network','offline');e.delivery='not-sent';throw e;});
  await c.install(identity,pair,'openlist',true);const before=await c.load('123');
  await assert.rejects(c.refresh('123',before));assert.equal(map.get('123').pending,undefined);assert.equal(map.get('123').refreshToken,'old-refresh');
  await assert.rejects(c.refresh('123',before));assert.equal(n,2);
});
test('dispatch-aware provider failing before TLS does not persist a pending marker',async()=>{
  const {credentials:c,map}=fixture();c.providers.set('openlist',{supportsDispatchHook:true,renew:async()=>{const e=new CloudError('network','offline');e.delivery='not-sent';throw e;}});
  await c.install(identity,pair,'openlist',true);await assert.rejects(c.refresh('123',await c.load('123')));assert.equal(map.get('123').pending,undefined);
});
test('dispatch hook persists marker before sending and commits rotated pair',async()=>{
  const {credentials:c,map}=fixture();c.providers.set('openlist',{supportsDispatchHook:true,renew:async(_token,_signal,prepare)=>{assert.equal(map.get('123').pending,undefined);await prepare();assert.ok(map.get('123').pending);return {accessToken:'a-new',refreshToken:'r-new',expiresAt:null};}});
  await c.install(identity,pair,'openlist',true);await c.refresh('123',await c.load('123'));assert.equal(map.get('123').refreshToken,'r-new');assert.equal(map.get('123').pending,undefined);
});
test('cancelled account install writes no credentials',async()=>{
  const {credentials:c,map}=fixture(),controller=new AbortController();controller.abort();await assert.rejects(c.install(identity,pair,'openlist',true,controller.signal));assert.equal(map.size,0);
});
test('provider cannot smuggle alternate account or auth profile in renewal response',async()=>{
  const {credentials:c,map}=fixture(async()=>({...pair,accountId:'999',profile:'evil',label:'evil',pending:'evil'}));
  await c.install(identity,pair,'openlist',true);await c.refresh('123',await c.load('123'));assert.equal(map.get('123').accountId,'123');assert.equal(map.get('123').profile,'openlist');assert.equal(map.get('123').pending,undefined);
});
