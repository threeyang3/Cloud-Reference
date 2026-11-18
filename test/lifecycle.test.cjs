'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),path=require('node:path'),fs=require('node:fs/promises'),os=require('node:os');
const load=Module._load;
class Plugin{async loadData(){return {};}addSettingTab(){}addCommand(){}registerEditorSuggest(){}registerMarkdownPostProcessor(fn){this.processor=fn;}registerObsidianProtocolHandler(name,fn){this.protocol=fn;}}
class Child{constructor(el){this.containerEl=el;}unload(){this.onunload?.();}}
const obsidian={Plugin,MarkdownRenderChild:Child,Modal:class{},PluginSettingTab:class{},Notice:class{},EditorSuggest:class{},Menu:class{}};
let Main;try{Module._load=function(id,...args){return id==='obsidian'?obsidian:load.call(this,id,...args);};Main=require('../src/main.cjs');}finally{Module._load=load;}
test('plugin startup has zero cloud requests, no credential directory and no scans',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cr-life-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const plugin=new Main();plugin.app={vault:{adapter:{getBasePath:()=>dir},configDir:'.obsidian'},workspace:{trigger(){}}};plugin.manifest={id:'cloud-reference'};
  await plugin.onload();assert.equal(plugin.transport.count,0);assert.equal(plugin.operations.size,0);await assert.rejects(fs.stat(path.join(dir,'.obsidian')),e=>e.code==='ENOENT');
  const api=plugin.api;assert.equal(api.version,1);assert.equal(api.capabilities.mediaPreview,false);plugin.onunload();await assert.rejects(api.resolve({provider:'baidu',accountId:'1',fileId:'2',kind:'file',name:'x',path:'/x'}));
});
test('plugin unload explicitly releases Markdown children and modals',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cr-life-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const p=new Main();p.app={vault:{adapter:{getBasePath:()=>dir},configDir:'.obsidian'},workspace:{trigger(){}}};p.manifest={id:'cloud-reference'};await p.onload();let child,closed=0;
  p.processor({querySelector:()=>true}, {addChild(c){child=c;}});assert.equal(p.renderChildren.size,1);p.modals.add({close(){closed++;}});p.onunload();assert.equal(p.renderChildren.size,0);assert.equal(child.life.signal.aborted,true);assert.equal(closed,1);
});

test('unload cancels even an external opener ignoring AbortSignal',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cr-life-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const p=new Main();p.app={vault:{adapter:{getBasePath:()=>dir},configDir:'.obsidian'},workspace:{trigger(){}}};p.manifest={id:'cloud-reference',version:'0.2.0'};await p.onload();
  const operation=p.operation(undefined,()=>new Promise(()=>{}));const rejected=assert.rejects(operation,e=>e.code==='cancelled');
  await new Promise(r=>setImmediate(r));p.onunload();await rejected;assert.equal(p.operations.size,0);
});
test('diagnostics expose counts only and do not generate requests',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cr-life-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const p=new Main();
  p.app={vault:{adapter:{getBasePath:()=>dir},configDir:'.obsidian'},workspace:{trigger(){}}};p.manifest={id:'cloud-reference',version:'0.2.0'};await p.onload();
  const out=JSON.stringify(p.api.diagnostics());assert.equal(out.includes(dir),false);assert.equal(out.includes('accessToken'),false);assert.equal(p.transport.count,0);p.onunload();
});
