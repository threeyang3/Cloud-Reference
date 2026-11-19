'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
// Minimal DOM contract double. This is not an Obsidian/native GUI test.
class Element{
  constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.attrs={};this.handlers={};this.value='';this.classList={add(){}};this.isConnected=true;}
  appendChild(e){e.parent=this;this.children.push(e);if(this.tag==='select'&&this.children.length===1)this.value=e.attrs.value||'';}
  setAttribute(k,v){this.attrs[k]=String(v);if(k==='value')this.value=String(v);}
  replaceChildren(){this.children=[];}
  addEventListener(k,fn){(this.handlers[k]??=[]).push(fn);}
  focus(){}
  querySelectorAll(selector){return this.children.flatMap(e=>[...(selector==='[aria-pressed]'&&e.attrs['aria-pressed']!==undefined?[e]:[]),...e.querySelectorAll(selector)]);}
}
const doc={createElement:tag=>new Element(tag,doc)};
class Modal{constructor(){this.contentEl=new Element('div',doc);}close(){this.onClose();}open(){this.onOpen();}}
let Picker;const original=Module._load;
try{Module._load=function(id,...args){return id==='obsidian'?{Modal,PluginSettingTab:class{},Setting:class{},Notice:class{}}:original.call(this,id,...args);};({Picker}=require('../src/ui.cjs'));}finally{Module._load=original;}
const root={provider:'baidu',accountId:'123',fileId:'0',kind:'folder',name:'我的网盘',path:'/'};
const file={...root,fileId:'2',kind:'file',name:'x.pdf',path:'/x.pdf',size:20};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){const plugin={app:{},modals:new Set(),credentials:{accounts:async()=>[{accountId:'123',label:'Baidu'}]},service:{browse:async f=>({folder:f,items:[file],nextOffset:null}),search:async f=>({folder:f,items:[file],nextOffset:null})},menu(){}};let result;const p=new Picker(plugin,{},r=>result=r);return {plugin,p,result:()=>result};}
test('picker displays only requested page and closes with selected identity',async()=>{const {p,plugin,result}=fixture();await p.render();assert.equal(p.items.length,1);assert.equal(p.list.children.length,1);p.finish(file);assert.equal(result().fileId,'2');assert.equal(plugin.modals.size,0);assert.equal(p.life.signal.aborted,true);});
test('older search completion cannot replace newer results',async()=>{const {p,plugin}=fixture();await p.render();const pending=[];plugin.service.search=(folder,q)=>new Promise(resolve=>pending.push({q,resolve}));p.query.value='old';const old=p.reload();p.query.value='new';const current=p.reload();pending[1].resolve({folder:root,items:[{...file,name:'new.pdf'}],nextOffset:null});await current;pending[0].resolve({folder:root,items:[{...file,name:'old.pdf'}],nextOffset:null});await old;assert.equal(p.items[0].name,'new.pdf');p.close();});
test('failed navigation clears old selectable items and directory selection',async()=>{const {p,plugin}=fixture();await p.render();plugin.service.browse=async()=>{throw Error('fail');};await p.reload();p.renderRows();assert.equal(p.items.length,0);assert.equal(p.choose.disabled,true);assert.equal(p.selectFolder.disabled,true);p.close();});
test('closing picker cancels request and discards late result',async()=>{const {p,plugin,result}=fixture();await p.render();let release,signal;plugin.service.browse=(f,options)=>{signal=options.signal;return new Promise(r=>release=r);};const q=p.reload();await tick();p.close();assert.equal(signal.aborted,true);release({folder:root,items:[file],nextOffset:null});await q;assert.equal(result(),null);assert.equal(p.items.length,0);});

test('typing invalidates the previously verified folder before debounce fires',async()=>{
  const {p}=fixture();await p.render();assert.equal(p.selectFolder.disabled,false);
  p.query.value='new';for(const fn of p.query.handlers.input)fn();assert.equal(p.selectFolder.disabled,true);assert.equal(p.verifiedFolder,null);p.close();
});
test('search pagination forwards offset rather than requesting page one again',async()=>{
  const {p,plugin}=fixture();await p.render();let seen;
  plugin.service.search=async(folder,q,options)=>{seen=options.offset;return {folder,items:[file],nextOffset:100};};
  p.query.value='x';await p.reload(50);assert.equal(seen,50);assert.equal(p.pageOffset,50);assert.equal(p.previous.disabled,false);p.close();
});
test('duplicate server pages stop pagination instead of looping indefinitely',async()=>{
  const {p,plugin}=fixture();plugin.service.browse=async folder=>({folder,items:[file],nextOffset:50});await p.render();await p.reload(50);
  assert.equal(p.next.disabled,true);assert.equal(p.nextOffset,null);assert.match(p.status.textContent,/重复/);p.close();
});
test('cached callback from an old row cannot select a resource after navigation',async()=>{
  const {p}=fixture();await p.render();const old=p.rowButtons[0];await p.reload(0);
  for(const fn of old.handlers.click)fn();await tick();assert.equal(p.selected,null);p.close();
});
test('size filters operate only on current results without new requests',async()=>{
  const {p,plugin}=fixture();let calls=0;plugin.service.browse=async f=>{calls++;return {folder:f,items:[file],nextOffset:null};};await p.render();
  p.max.value='0';p.renderRows();assert.equal(p.rowButtons.length,0);assert.equal(calls,1);p.close();
});
test('closing repeated picker instances leaves no modal registrations',async()=>{
  const {plugin}=fixture();plugin.modals.clear();for(let i=0;i<100;i++){const p=new Picker(plugin,{},()=>{});await p.render();p.close();}assert.equal(plugin.modals.size,0);
});

let AuthModal;try{Module._load=function(id,...args){return id==='obsidian'?{Modal,PluginSettingTab:class{},Setting:class{},Notice:class{}}:original.call(this,id,...args);};({AuthModal}=require('../src/ui.cjs'));}finally{Module._load=original;}
test('obtained credentials survive a transient account verification error without refreshing twice',async()=>{
  let acquired=0,verified=0;const plugin={app:{},modals:new Set(),provider:{verify:async()=>{if(++verified===1)throw Error('network');return {accountId:'1',label:'Fixture'};}}};
  const modal=new AuthModal(plugin);modal.onOpen();await modal.obtain(async()=>{acquired++;return {accessToken:'a',refreshToken:'r',expiresAt:null};});
  assert.equal(modal.retry.disabled,false);assert.equal(modal.save.disabled,true);await modal.verifyCandidate();
  assert.equal(modal.save.disabled,false);assert.equal(acquired,1);assert.equal(verified,2);modal.close();assert.equal(modal.candidate,null);
});
test('closing authorization during verification never enables saving a late result',async()=>{
  let release;const plugin={app:{},modals:new Set(),provider:{verify:()=>new Promise(r=>release=r)}};
  const modal=new AuthModal(plugin);modal.onOpen();const pending=modal.obtain(async()=>({accessToken:'a',refreshToken:'r',expiresAt:null}));await tick();modal.close();
  release({accountId:'1',label:'Fixture'});await pending;assert.equal(modal.candidate,null);assert.equal(plugin.modals.size,0);
});
