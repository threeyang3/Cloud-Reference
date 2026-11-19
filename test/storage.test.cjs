'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {CredentialFiles}=require('../src/storage.cjs');
async function fixture(t){const raw=await fs.mkdtemp(path.join(os.tmpdir(),'cloudref-test-')),dir=await fs.realpath(raw);t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,storage:new CredentialFiles(path.join(dir,'accounts'))};}
test('atomic pair writes round-trip and do not leave temporary files',async t=>{const {storage}=await fixture(t);await storage.write('123',{accessToken:'a',refreshToken:'b'});await storage.write('123',{accessToken:'c',refreshToken:'d'});assert.deepEqual(await storage.read('123'),{accessToken:'c',refreshToken:'d'});assert.equal((await fs.readdir(storage.directory)).length,1);});
test('credentials pathname cannot escape its directory',async t=>{const {storage}=await fixture(t);assert.throws(()=>storage.file('../x'));assert.throws(()=>storage.file('0'));});
test('missing store performs no creation on startup read',async t=>{const {storage}=await fixture(t);assert.deepEqual(await storage.list(),[]);await assert.rejects(fs.stat(storage.directory),e=>e.code==='ENOENT');});
test('sync conflict filenames are not automatically treated as valid accounts',async t=>{const {storage}=await fixture(t);await storage.write('123',{accountId:'123'});await fs.writeFile(path.join(storage.directory,'123.credentials (conflict).json'),'{}');assert.equal((await storage.list()).length,1);});
test('oversized credential file rejected',async t=>{const {storage}=await fixture(t);await storage.guard(true);await fs.writeFile(storage.file('123'),' '.repeat(32769));await assert.rejects(storage.read('123'));});
test('remove is idempotent and does not delete unrelated files',async t=>{const {storage}=await fixture(t);await storage.write('123',{x:1});await storage.write('456',{x:2});await storage.remove('123');await storage.remove('123');assert.equal(await storage.read('123'),null);assert.deepEqual(await storage.read('456'),{x:2});});
test('symlink credentials are refused',async t=>{if(process.platform==='win32'){t.skip('Windows symlink privileges vary; covered on Unix.');return;}const {dir,storage}=await fixture(t);await storage.guard(true);const target=path.join(dir,'secret');await fs.writeFile(target,'{}');await fs.symlink(target,storage.file('123'));await assert.rejects(storage.read('123'));await assert.rejects(storage.write('123',{}));assert.equal(await fs.readFile(target,'utf8'),'{}');});

test('one corrupt synchronized credential file does not hide healthy accounts',async t=>{
  const {storage}=await fixture(t);await storage.write('123',{accountId:'123'});await fs.writeFile(storage.file('456'),'{');
  assert.deepEqual(await storage.list(),[{accountId:'123'}]);assert.equal(storage.invalidCount,1);
});
test('cancel before commit leaves previous credential pair and no temporary file',async t=>{
  const {storage}=await fixture(t);await storage.write('123',{pair:'old'});
  await assert.rejects(storage.write('123',{pair:'new'},{beforeCommit(){throw Error('cancel');}}));
  assert.deepEqual(await storage.read('123'),{pair:'old'});assert.equal((await fs.readdir(storage.directory)).length,1);
});
test('symlink below trusted vault root is refused before creating any children',async t=>{
  if(process.platform==='win32'){t.skip('Windows symlink privileges vary');return;}
  const {dir}=await fixture(t),outside=await fs.mkdtemp(path.join(os.tmpdir(),'cr-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  await fs.symlink(outside,path.join(dir,'plugins'));const storage=new CredentialFiles(path.join(dir,'plugins','cloud-reference','accounts'),{trustedRoot:dir});
  await assert.rejects(storage.write('123',{}));assert.deepEqual(await fs.readdir(outside),[]);
});
test('many unrelated files are capped without materializing an unbounded directory',async t=>{
  const {storage}=await fixture(t);await storage.guard(true);await Promise.all(Array.from({length:257},(_,i)=>fs.writeFile(path.join(storage.directory,'conflict-'+i),'')));
  await assert.rejects(storage.list(),e=>e.code==='storage');
});
