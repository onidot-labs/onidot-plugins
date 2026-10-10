import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync,rmSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
execFileSync(process.execPath,['scripts/generate.mjs','--check'],{cwd:root,stdio:'inherit'});
const catalog=JSON.parse(readFileSync(resolve(root,'catalog.json'),'utf8'));
mkdirSync(resolve(root,'dist'),{recursive:true});
// Remove only obsolete generated archives of this plugin. Preserve other products.
for(const name of readdirSync(resolve(root,'dist'))){
 const obsolete=catalog.products.some(p=>new RegExp(`^${p.name}-\\d+\\.\\d+\\.\\d+\\.zip$`).test(name) && name!==`${p.name}-${p.version}.zip`);
 if(/^doraft-wiki-\d+\.\d+\.\d+\.zip$/.test(name) || obsolete) rmSync(resolve(root,'dist',name),{force:true});
}
const hashes=[];
for(const product of catalog.products){
 const name=`${product.name}-${product.version}.zip`, destination=resolve(root,'dist',name);
 rmSync(destination,{force:true});
 const cwd=resolve(root,'plugins',product.name);
 // Each product ships only the generated directories it has (crew has agents but no scripts).
 const entries=['.codex-plugin','.claude-plugin','skills','scripts','claude','codex','agents'].filter(path=>existsSync(resolve(cwd,path)));
 execFileSync('zip',['-q','-X','-r',destination,...entries],{cwd});
 hashes.push(`${createHash('sha256').update(readFileSync(destination)).digest('hex')}  ${name}`);
}
writeFileSync(resolve(root,'dist/SHA256SUMS'),hashes.join('\n')+'\n');
console.log(hashes.join('\n'));
