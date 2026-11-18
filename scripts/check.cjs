'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),root=path.resolve(__dirname,'..');
for(const folder of ['src','test','scripts'])for(const f of fs.readdirSync(path.join(root,folder)))if(f.endsWith('.cjs')){const r=cp.spawnSync(process.execPath,['--check',path.join(root,folder,f)],{stdio:'inherit'});if(r.status!==0)process.exit(1);}
if(JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))).version!==JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version)throw Error('Version mismatch');
console.log('Syntax and manifest checks passed.');
