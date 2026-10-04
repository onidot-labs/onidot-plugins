import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
execFileSync(process.execPath,['scripts/generate.mjs','--check'],{cwd:root,stdio:'inherit'});
const catalog=JSON.parse(readFileSync(resolve(root,'catalog.json'),'utf8'));
mkdirSync(resolve(root,'dist'),{recursive:true});
// 이름 전환 후 옛 생성 ZIP을 배포 대상으로 남기지 않는다. 다른 제품은 보존한다.
for(const name of readdirSync(resolve(root,'dist'))){
 if(/^doraft-wiki-\d+\.\d+\.\d+\.zip$/.test(name)) rmSync(resolve(root,'dist',name),{force:true});
}
const hashes=[];
for(const product of catalog.products){
 const name=`${product.name}-${product.version}.zip`, destination=resolve(root,'dist',name);
 rmSync(destination,{force:true});
 execFileSync('zip',['-q','-X','-r',destination,'.codex-plugin','.claude-plugin','skills','scripts'],{cwd:resolve(root,'plugins',product.name)});
 hashes.push(`${createHash('sha256').update(readFileSync(destination)).digest('hex')}  ${name}`);
}
writeFileSync(resolve(root,'dist/SHA256SUMS'),hashes.join('\n')+'\n');
console.log(hashes.join('\n'));
