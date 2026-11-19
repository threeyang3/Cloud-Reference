'use strict';
const {fail,decimalId,pathOf,parentPath,within,reference,text}=require('./reference.cjs');
function responseOk(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('protocol','网盘响应结构无效。');
  const code=raw.errno??raw.error_no??raw.error_code;
  if([-6,110,111,'-6','110','111'].includes(code))fail('unauthorized','百度网盘授权已失效。');
  if([-7,-9,'-7','-9'].includes(code))fail('not-found','网盘文件不存在或当前账号无法访问。');
  if(code!==0&&code!=='0')fail('provider','网盘拒绝操作或返回了未知响应，请检查权限。');
  return raw;
}
function itemOf(raw,accountId){
  if(raw&&raw.errno!==undefined&&raw.errno!==0)responseOk(raw);
  if(!raw||typeof raw!=='object'||![0,1,false,true].includes(raw.isdir))fail('protocol','网盘条目结构无效。');
  if(raw.errno!==undefined&&raw.errno!==0)responseOk(raw);
  const path=pathOf(raw.path),r=reference({provider:'baidu',accountId,fileId:decimalId(raw.fs_id??raw.fsid),kind:raw.isdir===1||raw.isdir===true?'folder':'file',path,name:raw.server_filename||raw.filename||path.split('/').pop()});
  return {...r,size:Number.isSafeInteger(raw.size)&&raw.size>=0?raw.size:null,
    modifiedAt:Number.isSafeInteger(raw.server_mtime)&&raw.server_mtime>=0&&raw.server_mtime<8640000000000?new Date(raw.server_mtime*1000).toISOString():null,
    revision:text(raw.md5,128)?raw.md5:null};
}
class BaiduProvider{
  constructor(transport,credentials){this.transport=transport;this.credentials=credentials;}
  async raw(path,params,accessToken,signal,body){const u=new URL(path,'https://pan.baidu.com');u.search=new URLSearchParams({...params,access_token:accessToken}).toString();return responseOk(await this.transport.json(u,{signal,method:body===undefined?'GET':'POST',body}));}
  request(accountId,path,params,signal,body){return this.credentials.use(accountId,t=>this.raw(path,params,t,signal,body),signal);}
  async verify(accessToken,signal){
    const user=await this.raw('/rest/2.0/xpan/nas',{method:'uinfo'},accessToken,signal),accountId=decimalId(user.uk);
    const root=await this.raw('/rest/2.0/xpan/file',{method:'list',dir:'/',start:'0',limit:'1'},accessToken,signal);
    if(!Array.isArray(root.list))fail('protocol','无法验证网盘根目录。');
    return {accountId,label:text(user.netdisk_name,512)?user.netdisk_name:text(user.baidu_name,512)?user.baidu_name:`百度网盘 ${accountId}`};
  }
  async stat(input,signal){
    const r=reference(input);if(r.fileId==='0')return {...r};
    const raw=await this.request(r.accountId,'/rest/2.0/xpan/multimedia',{method:'filemetas',fsids:`[${r.fileId}]`,dlink:'0',extra:'1'},signal);
    if(!Array.isArray(raw.list)||raw.list.length===0)fail('not-found','找不到原资源，请手动重新选择。');
    if(raw.list.length!==1)fail('protocol','网盘返回了不匹配的元数据。');
    const current=itemOf(raw.list[0],r.accountId);
    if(current.fileId!==r.fileId||current.kind!==r.kind)fail('identity','资源身份不匹配，已停止打开。');
    return current;
  }
  async list(folder,{offset=0,signal}={}){
    folder=reference(folder);if(folder.kind!=='folder'||!Number.isSafeInteger(offset)||offset<0||offset>1000000)fail('invalid','目录或分页参数无效。');
    const limit=50,raw=await this.request(folder.accountId,'/rest/2.0/xpan/file',{method:'list',dir:folder.path,start:String(offset),limit:String(limit),order:'name',desc:'0'},signal);
    if(!Array.isArray(raw.list)||raw.list.length>limit)fail('protocol','目录分页响应无效。');
    const seen=new Set(),items=raw.list.map(v=>itemOf(v,folder.accountId)).filter(item=>{
      if(parentPath(item.path)!==folder.path||item.path===folder.path)fail('identity','目录响应包含其他目录的条目。');
      if(seen.has(item.fileId))return false;seen.add(item.fileId);return true;
    });
    return {items,nextOffset:raw.list.length===limit?offset+limit:null,truncated:false};
  }
  async search(folder, query, {offset = 0, signal} = {}) {
    folder = reference(folder);
    query = typeof query === 'string' ? query.trim() : '';
    if (folder.kind !== 'folder' || !text(query, 200) || [...query].length > 30 ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || offset % 50) {
      fail('invalid', '请输入不超过 30 个字符的关键词，并检查分页参数。');
    }
    // Official FileService.Search: server-side filename search, not AI search.
    // Failure never falls back to recursively listing folders.
    const raw = await this.request(folder.accountId, '/rest/2.0/xpan/file', {
      method: 'search', key: query, dir: folder.path, recursion: '1',
      num: '50', page: String(offset / 50 + 1), web: '0',
    }, signal);
    if (!Array.isArray(raw.list) || raw.list.length > 50) fail('protocol', '网盘搜索分页响应无效。');
    if (raw.has_more !== undefined && ![0, 1, false, true].includes(raw.has_more)) fail('protocol', '搜索分页状态无效。');
    const items = [], seen = new Set();
    for (const value of raw.list) {
      const item = itemOf(value, folder.accountId);
      if (!within(item.path, folder.path) || seen.has(item.fileId)) continue;
      seen.add(item.fileId); items.push(item);
    }
    if (raw.list.length === 0 && raw.has_more) fail('protocol', '网盘搜索返回无进展的分页。');
    const more = raw.has_more === undefined ? raw.list.length === 50 : Boolean(raw.has_more);
    return {items, nextOffset: more ? offset + 50 : null, truncated: more,
      scopeFiltered: items.length !== raw.list.length};
  }
}
module.exports={BaiduProvider,responseOk,itemOf};
