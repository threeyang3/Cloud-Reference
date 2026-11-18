'use strict';
const {Plugin,MarkdownRenderChild,Menu,Notice,EditorSuggest}=require('obsidian');
const path=require('node:path');
const {captureInsertion}=require('./insertion.cjs');
const {JsonTransport}=require('./transport.cjs');
const {CredentialFiles}=require('./storage.cjs');
const {OpenListAuth,Credentials}=require('./auth.cjs');
const {BaiduProvider}=require('./baidu.cjs');
const {CloudService}=require('./service.cjs');
const {reference,keyOf,parseLink,linkOf,markdownOf,displayName,webLocation,handoff,publicError,fail}=require('./reference.cjs');
const {check,waitFor,NameScheduler}=require('./runtime.cjs');
const {AuthModal,Picker,SettingsTab}=require('./ui.cjs');
class LinkChild extends MarkdownRenderChild{
  constructor(element,plugin){super(element);this.plugin=plugin;this.life=new AbortController();this.listeners=[];this.plugin.renderChildren.add(this);}
  onload(){
    const links=[...this.containerEl.querySelectorAll('a[href^="obsidian://cloud-reference?"]')];if(!links.length)return;
    const refresh=(a,priority=false)=>{const ref=a._cloudRef;if(!ref)return;const load=signal=>this.plugin.resolve(ref,{signal});
      (priority?load(this.life.signal):this.plugin.names.get(keyOf(ref),load,this.life.signal)).then(current=>{
      if(this.life.signal.aborted||!a.isConnected)return;
      if(!a.childElementCount)a.textContent=displayName(a._cloudLabel,ref,current.name);
      a.title=current.path;
    }).catch(e=>{if(e?.code==='busy')return;if(!this.life.signal.aborted)a.title=`${ref.path} · ${publicError(e)}`;});};
    const View=this.containerEl.ownerDocument.defaultView;
    if(this.plugin.settings.dynamicNames&&View?.IntersectionObserver)this.observer=new View.IntersectionObserver(entries=>{
      for(const entry of entries)if(entry.isIntersecting){this.observer.unobserve(entry.target);refresh(entry.target);}
    },{rootMargin:'0px',threshold:0});
    for(const a of links){
      try{a._cloudRef=parseLink(a.getAttribute('href'));}catch{continue;}
      a._cloudLabel=a.textContent;a.classList.add('cr-link');
      const click=e=>{e.preventDefault();e.stopPropagation();this.plugin.open(a._cloudRef).catch(err=>new Notice(publicError(err)));};
      const menu=e=>{e.preventDefault();e.stopPropagation();this.plugin.menu(a._cloudRef,e);};
      const hover=()=>{if(this.plugin.settings.dynamicNames)refresh(a,true);};
      for(const [type,fn]of [['click',click],['contextmenu',menu],['mouseenter',hover]]){a.addEventListener(type,fn);this.listeners.push(()=>a.removeEventListener(type,fn));}
      this.observer?.observe(a);
    }
  }
  onunload(){this.plugin.renderChildren.delete(this);this.life.abort();this.observer?.disconnect();for(const f of this.listeners)f();this.listeners=[];}
}
class SlashSuggest extends EditorSuggest{
  constructor(plugin){super(plugin.app);this.plugin=plugin;}
  onTrigger(cursor,editor){const line=editor.getLine(cursor.line).slice(0,cursor.ch),m=line.match(/(?:^|\s)(\/(?:网盘|cloud))$/);if(!m)return null;return {start:{line:cursor.line,ch:cursor.ch-m[1].length},end:cursor,query:m[1]};}
  getSuggestions(){return ['选择网盘资源'];}
  renderSuggestion(value,el){el.textContent=value;}
  selectSuggestion(){const ctx=this.context;if(!ctx)return;const {editor,start,end,file}=ctx,insert=captureInsertion(this.plugin,editor,file,start,end);this.close();this.plugin.pick().then(async ref=>{
    if(!ref||this.plugin.closed)return;const md=markdownOf(ref);if(!insert(md)){await this.plugin.copy(md);new Notice('目标笔记已变化或关闭，引用已复制，未改写正文。');}
  }).catch(e=>new Notice(publicError(e)));}
}
module.exports=class CloudReference extends Plugin{
  async onload(){
    this.closed=false;this.modals=new Set();this.operations=new Set();this.renderChildren=new Set();
    const saved=await this.loadData();this.settings={dynamicNames:saved?.dynamicNames!==false,openers:{}};
    if(saved?.openers&&typeof saved.openers==='object'&&!Array.isArray(saved.openers))for(const [k,v]of Object.entries(saved.openers).slice(0,64))if(/^[a-z0-9]{1,12}$/.test(k)&&typeof v==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(v))this.settings.openers[k]=v;
    const base=this.app.vault.adapter.getBasePath?.();if(!base)fail('platform','当前版本仅支持桌面本地 Vault。');
    const pluginDir=this.manifest.dir||`${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const directory=path.resolve(base,pluginDir,'accounts');if(!directory.startsWith(path.resolve(base)+path.sep))fail('storage','插件目录不在当前 Vault 内。');
    this.transport=new JsonTransport();this.names=new NameScheduler();this.storage=new CredentialFiles(directory,{trustedRoot:base});this.auth=new OpenListAuth(this.transport);
    this.credentials=new Credentials(this.storage,new Map([['openlist',this.auth]]));this.provider=new BaiduProvider(this.transport,this.credentials);this.service=new CloudService(this.provider);
    this.api=Object.freeze({version:1,
      capabilities:Object.freeze({providers:Object.freeze(['baidu']),browse:true,serverSearch:true,mediaPreview:false,write:false}),
      listAccounts:()=>this.credentials.accounts(),browse:(ref,options={})=>this.operation(options.signal,signal=>this.service.browse(ref,{...options,signal})),
      search:(ref,query,options={})=>this.operation(options.signal,signal=>this.service.search(ref,query,{...options,signal})),
      pickResource:options=>this.pick(options),resolve:(ref,options)=>this.resolve(ref,options),
      open:(ref,options)=>this.open(ref,options),toMarkdown:markdownOf,parseReference:parseLink,
      diagnostics:()=>this.diagnostics(),toMediaCoreHandoff:handoff,registerOpener:opener=>{if(this.closed)fail('unloaded','插件已停用。');return this.service.registerOpener(opener);}});
    this.addSettingTab(new SettingsTab(this));
    this.addCommand({id:'insert-resource',name:'插入网盘资源',editorCallback:(editor,context)=>{
      const insert=captureInsertion(this,editor,context?.file,editor.getCursor('from'),editor.getCursor('to'));
      this.pick().then(async ref=>{if(!ref||this.closed)return;const md=markdownOf(ref);if(!insert(md)){await this.copy(md);new Notice('目标笔记已变化或关闭，引用已复制，未改写正文。');}}).catch(e=>new Notice(publicError(e)));
    }});
    this.addCommand({id:'browse-cloud',name:'浏览并复制网盘引用',callback:()=>this.pick().then(r=>r&&this.copy(markdownOf(r))).catch(e=>new Notice(publicError(e)))});
    this.addCommand({id:'copy-diagnostics',name:'复制性能诊断（不含敏感信息）',callback:()=>this.copy(JSON.stringify(this.diagnostics(),null,2)).catch(e=>new Notice(publicError(e)))});
    this.addCommand({id:'connect-baidu',name:'连接百度网盘',callback:()=>new AuthModal(this).open()});
    this.registerEditorSuggest(new SlashSuggest(this));
    this.registerMarkdownPostProcessor((element,ctx)=>{if(element.querySelector('a[href^="obsidian://cloud-reference?"]'))ctx.addChild(new LinkChild(element,this));});
    this.registerObsidianProtocolHandler('cloud-reference',params=>{
      try{const p=new URLSearchParams();for(const k of ['v','provider','account','id','kind','path','name'])if(typeof params[k]==='string')p.set(k,params[k]);const r=parseLink('obsidian://cloud-reference?'+p);this.open(r).catch(e=>new Notice(publicError(e)));}catch(e){new Notice(publicError(e));}
    });
    this.app.workspace.trigger('cloud-reference:ready',this.api);
  }
  async operation(signal,fn){
    if(this.closed)fail('unloaded','插件已停用。');check(signal);const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});this.operations.add(controller);
    try{return await waitFor(Promise.resolve().then(()=>{check(controller.signal);return fn(controller.signal);}),controller.signal);}finally{signal?.removeEventListener('abort',abort);this.operations.delete(controller);}
  }
  resolve(ref,options={}){return this.operation(options.signal,signal=>this.service.resolve(ref,{...options,signal}));}
  pick(options={}){
    if(this.closed)return Promise.reject(new Error('Plugin unloaded'));
    if(options.signal?.aborted)return Promise.resolve(null);
    return new Promise(resolve=>{const modal=new Picker(this,options,resolve);modal.open();if(options.signal?.aborted)modal.close();});
  }
  async open(input,options={}){
    const ref=typeof input==='string'?parseLink(input):reference(input);
    if(ref.kind==='folder'&&!options.opener){const picked=await this.pick({folder:ref,signal:options.signal,intent:'browse'});if(picked)await this.open(picked,options);return;}
    return this.operation(options.signal,async signal=>{
      const ext=ref.name.split('.').pop().toLowerCase(),opener=options.opener||this.settings.openers[ext]||'web';
      if(opener!=='web')return this.service.openWith(opener,ref,{signal});
      const current=await this.service.resolve(ref,{signal,fresh:true});check(signal);new Notice('请确认浏览器登录的是此资源所属的百度账号。');return this.external(webLocation(current));
    });
  }
  async authorize(options={}){
    if(this.authorizing)fail('busy','已有授权窗口打开。');this.authorizing=true;
    try{return await this.operation(options.signal,signal=>require('./oauth.cjs').authorize(this.auth,{signal}));}
    finally{this.authorizing=false;}
  }
  diagnostics(){return {version:this.manifest.version,network:this.transport.diagnostics(),metadata:this.service.cache.diagnostics(),visibleNames:{active:this.names.gate.active,queued:this.names.gate.queue.length},modals:this.modals.size,renderChildren:this.renderChildren.size,operations:this.operations.size,persistentSearchIndex:false};}
  external(url){const u=new URL(url);if(u.protocol!=='https:'||!['pan.baidu.com','api.oplist.org'].includes(u.hostname)||u.username||u.password||u.port)fail('policy','不允许打开此地址。');return require('electron').shell.openExternal(u.href);}
  async copy(value){if(this.closed)fail('unloaded','插件已停用。');await navigator.clipboard.writeText(value);new Notice('已复制。');}
  menu(input,event){
    const ref=reference(input),menu=new Menu();const action=(label,fn)=>menu.addItem(i=>i.setTitle(label).onClick(()=>Promise.resolve().then(fn).catch(e=>new Notice(publicError(e)))));
    action(ref.kind==='folder'?'浏览目录':'按默认方式打开',()=>this.open(ref));
    action('在网盘定位（查询最新路径）',()=>this.open(ref,{opener:'web'}));
    action('复制 Markdown 引用',()=>this.copy(markdownOf(ref)));
    action('复制保存的路径',()=>this.copy(ref.path));
    action('打开保存路径（未核验，可能已失效）',()=>this.external(webLocation(ref)));
    action('重新选择并复制替代引用',async()=>{const next=await this.pick();if(next){if(next.accountId!==ref.accountId||next.kind!==ref.kind)fail('identity','替代资源必须属于同一账号且类型一致。');await this.copy(markdownOf(next));new Notice('替代引用已复制。原 Markdown 未修改，请人工替换。');}});
    for(const opener of this.service.openers.values()){try{if(opener.canOpen(ref))action(`使用 ${opener.label||opener.id}`,()=>this.open(ref,{opener:opener.id}));}catch{/* A broken external opener must not break basic actions. */}}
    menu.showAtMouseEvent(event);
  }
  onunload(){this.closed=true;for(const child of [...(this.renderChildren||[])])child.unload();for(const modal of [...(this.modals||[])])modal.close();for(const controller of this.operations||[])controller.abort();this.credentials?.close();this.names?.close();this.service?.close();this.transport?.close();this.api=undefined;this.app.workspace.trigger('cloud-reference:unloaded');}
};
