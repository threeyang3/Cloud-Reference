'use strict';
const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'..'),src=path.join(root,'src');
const modules=fs.readdirSync(src).filter(n=>n.endsWith('.cjs')).sort();
const wrappers=modules.map(n=>`${JSON.stringify('./'+n)}:function(module,exports,require){\n${fs.readFileSync(path.join(src,n),'utf8')}\n}`);
const out=`'use strict';\nconst __native=require;\nconst __modules={${wrappers.join(',\n')}};\nconst __cache=Object.create(null);\nfunction __load(id){if(!Object.hasOwn(__modules,id))return __native(id);if(__cache[id])return __cache[id].exports;const m={exports:{}};__cache[id]=m;__modules[id](m,m.exports,__load);return m.exports;}\nmodule.exports=__load('./main.cjs');\n`;
const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});fs.writeFileSync(path.join(dist,'main.js'),out);for(const f of ['manifest.json','styles.css'])fs.copyFileSync(path.join(root,f),path.join(dist,f));
console.log(`Built ${modules.length} modules; main.js ${Buffer.byteLength(out)} bytes.`);

const crypto=require('node:crypto');
const sums=['main.js','manifest.json','styles.css'].map(name=>crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,name))).digest('hex')+'  '+name);
fs.writeFileSync(path.join(dist,'SHA256SUMS'),sums.join('\n')+'\n');
