'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {JsonTransport,allowed}=require('../src/transport.cjs');
const url='https://pan.baidu.com/rest/2.0/xpan/file?method=list&access_token=private-token';
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
test('transport permits only fixed read API methods and broker',()=>{
  for(const raw of ['http://pan.baidu.com/rest/2.0/xpan/file?method=list','https://pan.baidu.com/rest/2.0/xpan/file?method=delete','https://pan.baidu.com.evil.invalid/rest/2.0/xpan/file?method=list','https://u:p@pan.baidu.com/rest/2.0/xpan/file?method=list','https://127.0.0.1/'])assert.equal(allowed(new URL(raw),'GET'),false);
  assert.equal(allowed(new URL(url),'GET'),true);assert.equal(allowed(new URL(url),'POST'),false);
});
test('JSON transport parses bounded response with fixed UA',async()=>{const f=requestFixture(),t=new JsonTransport(f);assert.deepEqual(await t.json(url),{errno:0,list:[]});assert.equal(f.requests[0].options.headers['User-Agent'],'pan.baidu.com');assert.equal(t.requests.size,0);t.close();});
test('HTTP redirect rejected without following token-bearing location',async()=>{const f=requestFixture({status:302,headers:{location:'https://evil.invalid'}}),t=new JsonTransport(f);await assert.rejects(t.json(url),e=>e.code==='http'&&!e.message.includes('private-token'));assert.equal(f.requests.length,1);});
test('stream response size limit aborts before JSON parse',async()=>{const f=requestFixture({chunks:[Buffer.alloc(33)]}),t=new JsonTransport({...f,maxBytes:32});await assert.rejects(t.json(url),e=>e.code==='limit');assert.equal(t.requests.size,0);});
test('absolute timeout and cancellation release gate',async()=>{const f=requestFixture({hang:true}),t=new JsonTransport({...f,timeout:5});await assert.rejects(t.json(url),e=>e.code==='timeout');assert.equal(t.gate.active,0);assert.equal(f.isAborted(),true);});
test('AbortSignal destroys active request',async()=>{const f=requestFixture({hang:true}),t=new JsonTransport(f),c=new AbortController(),p=t.json(url,{signal:c.signal});c.abort();await assert.rejects(p,e=>e.code==='cancelled');assert.equal(t.requests.size,0);assert.equal(t.gate.active,0);});
test('429 establishes bounded cooldown; retry does not hit network',async()=>{const f=requestFixture({status:429,headers:{'retry-after':'1'}}),t=new JsonTransport(f);await assert.rejects(t.json(url));await assert.rejects(t.json(url),e=>e.code==='rate-limit');assert.equal(f.requests.length,1);});
test('transport shutdown aborts in-flight request and prohibits new work',async()=>{const f=requestFixture({hang:true}),t=new JsonTransport(f),p=t.json(url);t.close();await assert.rejects(p);await assert.rejects(t.json(url));assert.equal(t.requests.size,0);});

test('OAuth callback consumes redirect envelope without navigating and uses only fixed cookies',async()=>{
  const location='/#'+Buffer.from(JSON.stringify({driver_txt:'baiduyun_go',access_token:'fake',refresh_token:'fake2'})).toString('base64');
  const f=requestFixture({status:302,headers:{location}}),t=new JsonTransport(f);
  assert.deepEqual(await t.json('https://api.oplist.org/baiduyun/callback?code=fixture',{mode:'oauth-redirect'}),{location});
  assert.equal(f.requests[0].options.headers.Cookie,'server_use=true; driver_txt=baiduyun_go');assert.equal(f.requests.length,1);t.close();
});
test('duplicate methods and redirect mode on arbitrary endpoints are denied',()=>{
  assert.equal(allowed(new URL(url+'&method=delete'),'GET'),false);
  assert.equal(allowed(new URL(url),'GET','oauth-redirect'),false);
  assert.equal(allowed(new URL('https://api.oplist.org/baiduyun/callback'),'GET'),false);
});
test('connection failure before dispatch hook is marked not-sent',async()=>{
  let prepared=false;const t=new JsonTransport({request(){const req=new EventEmitter();req.destroy=()=>req.emit('close');req.end=()=>assert.fail('must not send');queueMicrotask(()=>req.emit('error',Error('dns')));return req;}});
  await assert.rejects(t.json('https://api.oplist.org/baiduyun/renewapi',{beforeDispatch:async()=>{prepared=true;}}),e=>e.delivery==='not-sent');
  assert.equal(prepared,false);assert.equal(t.requests.size,0);assert.equal(t.gate.active,0);t.close();
});
test('transport waits for TLS and persistence before ending a refresh request',async()=>{
  let resolveWrite,req,socket,ended=false;const t=new JsonTransport({request(){
    req=new EventEmitter();req.destroy=()=>req.emit('close');req.end=()=>{ended=true;req.emit('error',Error('response lost'));};
    socket=new EventEmitter();socket.connecting=true;queueMicrotask(()=>req.emit('socket',socket));return req;
  }});
  const p=t.json('https://api.oplist.org/baiduyun/renewapi',{beforeDispatch:()=>new Promise(r=>resolveWrite=r)});const rejected=assert.rejects(p,e=>e.delivery==='unknown');
  await new Promise(r=>setImmediate(r));assert.equal(ended,false);socket.emit('secureConnect');await new Promise(r=>setImmediate(r));assert.equal(ended,false);
  resolveWrite();await rejected;assert.equal(ended,true);t.close();
});
test('rate limiting one service does not block another service',async()=>{
  const f=requestFixture({status:429}),t=new JsonTransport(f);await assert.rejects(t.json(url));
  await assert.rejects(t.json('https://api.oplist.org/baiduyun/requests'));assert.equal(f.requests.length,2);t.close();
});
