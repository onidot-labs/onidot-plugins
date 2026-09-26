import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {config,getHeaders,writeState} from '../source/runtime/oauth-helper.mjs';
const run=promisify(execFile), moduleUrl=new URL('../source/runtime/oauth-helper.mjs',import.meta.url).href;
const original={schema:1,issuer:config.issuer,resource:config.resource,clientId:'test-client',accessToken:'fake-old-access-123456789',refreshToken:'fake-refresh-123456789',expiresAt:0,pendingRefresh:false};
const response={access_token:'fake-new-access-123456789',refresh_token:'fake-new-refresh-123456789',expires_in:900,token_type:'Bearer',scope:config.scope};
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'doraft-oauth-test-'));try{await writeState(dir,original);await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('8개 프로세스가 동시에 만료 토큰을 갱신해도 HTTP 요청은 한 번이다',async()=>fixture(async dir=>{
 let calls=0;const server=createServer(async(req,res)=>{calls++;await new Promise(r=>setTimeout(r,100));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
 const url=`http://127.0.0.1:${server.address().port}`;
 const code=`import {getHeaders} from ${JSON.stringify(moduleUrl)}; const value=await getHeaders({dir:${JSON.stringify(dir)},requestTokens:async()=>await (await fetch(${JSON.stringify(url)})).json()}); console.log(JSON.stringify(value));`;
 const results=await Promise.all(Array.from({length:8},()=>run(process.execPath,['--input-type=module','-e',code])));
 assert.equal(calls,1);
 for(const result of results){assert.deepEqual(JSON.parse(result.stdout),{Authorization:'Bearer '+response.access_token});assert.ok(!result.stdout.includes('refresh'));assert.equal(result.stderr,'');}
 const state=JSON.parse(await readFile(join(dir,'tokens.json'),'utf8'));assert.equal(state.refreshToken,response.refresh_token);assert.equal(state.pendingRefresh,false);
 }finally{server.close();}
}));
test('유효한 액세스 토큰은 재갱신하지 않는다',async()=>fixture(async dir=>{
 await writeState(dir,{...original,expiresAt:Date.now()+600000});let calls=0;
 const headers=await getHeaders({dir,requestTokens:async()=>{calls++;return response;}});
 assert.equal(calls,0);assert.equal(headers.Authorization,'Bearer '+original.accessToken);
}));
test('응답 유실 후 같은 refresh token을 다시 전송하지 않는다',async()=>fixture(async dir=>{
 let calls=0;const requestTokens=async()=>{calls++;throw Error('lost response');};
 await assert.rejects(getHeaders({dir,requestTokens}),/lost response/);
 await assert.rejects(getHeaders({dir,requestTokens}),/UNCERTAIN_RELOGIN/);
 assert.equal(calls,1);
}));
test('갱신 중 프로세스가 종료되어도 잠금이 풀리고 재로그인이 가능하다',async()=>fixture(async dir=>{
 const code=`import {getHeaders} from ${JSON.stringify(moduleUrl)};await getHeaders({dir:${JSON.stringify(dir)},requestTokens:async()=>process.exit(37)});`;
 await assert.rejects(run(process.execPath,['--input-type=module','-e',code]),e=>e.code===37);
 await assert.rejects(getHeaders({dir,waitMs:80,requestTokens:async()=>{throw Error('must not call');}}),/UNCERTAIN_RELOGIN/);
 await assert.rejects(getHeaders({dir,requestTokens:async()=>{throw Error('must not call');}}),/UNCERTAIN_RELOGIN/);
 await writeState(dir,{...original,expiresAt:Date.now()+600000});
 assert.equal((await getHeaders({dir,waitMs:80})).Authorization,'Bearer '+original.accessToken);
}));
test('위험한 파일 권한과 심볼릭 링크를 거부한다',async()=>fixture(async dir=>{
 await chmod(join(dir,'tokens.json'),0o644);await assert.rejects(getHeaders({dir}),/UNSAFE/);
 await chmod(join(dir,'tokens.json'),0o600);
 await symlink(join(dir,'tokens.json'),join(dir,'linked.json'));
 await rm(join(dir,'tokens.json'));await symlink(join(dir,'linked.json'),join(dir,'tokens.json'));
 await assert.rejects(getHeaders({dir}),/UNSAFE/);
}));
test('틀린 제품 상태와 손상된 토큰 응답을 거부하고 pending을 유지한다',async()=>fixture(async dir=>{
 await writeState(dir,{...original,resource:'https://evil.example'});await assert.rejects(getHeaders({dir}),/INVALID_OAUTH_STATE/);
 await writeState(dir,original);await assert.rejects(getHeaders({dir,requestTokens:async()=>({...response,access_token:'x\r\nInjected: y'})}),/INVALID_OAUTH_TOKEN_RESPONSE/);
 assert.equal(JSON.parse(await readFile(join(dir,'tokens.json'))).pendingRefresh,true);
}));

test('손상된 상태 진단은 원문 비밀값을 출력하지 않는다',async()=>fixture(async dir=>{
 const {writeFile}=await import('node:fs/promises');
 const home=join(dir,'codex-home'), stateDir=join(home,'doraft-oauth/wiki');
 await writeState(stateDir,original);
 await writeFile(join(stateDir,'tokens.json'),'LEAK_ME_PRIVATE_TOKEN_NOT_JSON',{mode:0o600});
 const result=await run(process.execPath,[new URL('../source/runtime/oauth-helper.mjs',import.meta.url).pathname,'status'],{env:{...process.env,CODEX_HOME:home}}).catch(e=>e);
 assert.equal(result.code,1);
 assert.ok(!result.stdout.includes('LEAK_ME'));
 assert.equal(JSON.parse(result.stdout).error,'INVALID_OAUTH_STATE');
}));
