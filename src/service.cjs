'use strict';
const {reference,keyOf,parseLink,fail}=require('./reference.cjs');
const {MetadataCache,check}=require('./runtime.cjs');
class CloudService{
  constructor(provider){this.provider=provider;this.cache=new MetadataCache();this.openers=new Map();this.closed=false;}
  resolve(input,{signal,fresh=false}={}){if(this.closed)return Promise.reject(new Error('Service closed'));const r=typeof input==='string'?parseLink(input):reference(input),key=keyOf(r);if(fresh)this.cache.invalidate(key);return this.cache.get(key,s=>this.provider.stat(r,s),signal);}
  async browse(input,options={}){const folder=await this.resolve(input,{...options,fresh:true});check(options.signal);if(folder.kind!=='folder')fail('invalid','资源不是目录。');return {...await this.provider.list(folder,options),folder};}
  async search(input,query,options={}){const folder=await this.resolve(input,{...options,fresh:true});check(options.signal);return {...await this.provider.search(folder,query,options),folder};}
  registerOpener(o){if(this.closed)fail('unloaded','插件已停用。');if(!o||o.id==='web'||!/^[a-z][a-z0-9-]{0,63}$/.test(o.id||'')||typeof o.canOpen!=='function'||typeof o.open!=='function'||this.openers.has(o.id))fail('invalid','打开器无效或重复。');const item=Object.freeze({...o});this.openers.set(item.id,item);return ()=>{if(this.openers.get(item.id)===item)this.openers.delete(item.id);};}
  async openWith(id,input,{signal}={}){const opener=this.openers.get(id);if(!opener)fail('opener','打开器未安装或已停用。');const current=await this.resolve(input,{signal,fresh:true});check(signal);if(this.closed||this.openers.get(id)!==opener)fail('opener','打开器已经停用。');if(!opener.canOpen(current))fail('opener','打开器不支持此资源。');return opener.open(reference(current),{signal});}
  close(){this.closed=true;this.cache.close();this.openers.clear();}
}
module.exports={CloudService};
