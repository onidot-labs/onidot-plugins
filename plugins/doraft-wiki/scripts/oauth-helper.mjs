import {mkdir,open,readFile,rename,lstat,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';

export const config=Object.freeze({issuer:'https://api.doraft.com',resource:'https://mcp.doraft.com/wiki',scope:'doraft:wiki:read doraft:wiki:write offline_access'});
const failure=code=>new Error(code);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const stateRoot=()=>resolve(process.env.CODEX_HOME || resolve(homedir(),'.codex'),'doraft-oauth','wiki');
async function privatePath(path,directory=false){
 const s=await lstat(path);
 if(s.isSymbolicLink() || (directory?!s.isDirectory():!s.isFile()) || (typeof process.getuid==='function' && (s.uid!==process.getuid() || (s.mode&0o077)!==0))) throw failure('UNSAFE_OAUTH_STATE_PERMISSIONS');
}
export async function prepare(dir){await mkdir(dir,{recursive:true,mode:0o700});await privatePath(dir,true);}
export async function writeState(dir,value){
 await prepare(dir);
 const target=resolve(dir,'tokens.json');
 try{await privatePath(target);}catch(e){if(e.code!=='ENOENT')throw e;}
 const temp=resolve(dir,`tokens-${randomBytes(12).toString('hex')}.tmp`);
 const f=await open(temp,'wx',0o600);
 try{await f.writeFile(JSON.stringify(value));await f.sync();}finally{await f.close();}
 try{await rename(temp,target);const directory=await open(dir,'r');try{await directory.sync();}finally{await directory.close();}}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function readState(dir){
 const path=resolve(dir,'tokens.json');
 try{await privatePath(path);const raw=await readFile(path,'utf8');try{return JSON.parse(raw);}catch{throw failure('INVALID_OAUTH_STATE');}}
 catch(e){if(e.code==='ENOENT')throw failure('DORAFT_LOGIN_REQUIRED');throw e;}
}
// SQLite owns the OS lock; process death releases it without deleting another owner's lock.
// The database contains no credentials. Token intent and results are durable atomic files.
export async function withLock(dir,fn,{waitMs=30000}={}){
 await prepare(dir);
 const path=resolve(dir,'refresh-lock.sqlite');
 try{const file=await open(path,'wx',0o600);await file.close();}catch(e){if(e.code!=='EEXIST')throw e;}
 await privatePath(path);
 const db=new DatabaseSync(path);const until=Date.now()+waitMs;
 try{
  while(true){
   try{db.exec('BEGIN EXCLUSIVE');break;}
   catch(e){if(e.errcode!==5 && e.errcode!==6)throw e;if(Date.now()>=until)throw failure('OAUTH_REFRESH_LOCKED');await pause(40);}
  }
  try{return await fn();}finally{db.exec('ROLLBACK');}
 }finally{db.close();}
}
function validToken(value){return typeof value==='string' && value.length>=16 && value.length<=4096 && !/\s/.test(value);}
function validateState(s){
 if(s.schema!==1 || s.issuer!==config.issuer || s.resource!==config.resource || typeof s.clientId!=='string' || !s.clientId || !validToken(s.accessToken) || !validToken(s.refreshToken) || !Number.isFinite(s.expiresAt))throw failure('INVALID_OAUTH_STATE');
 if(s.pendingRefresh)throw failure('OAUTH_REFRESH_UNCERTAIN_RELOGIN_REQUIRED');
}
function nextState(s,result,started){
 const scopes=String(result.scope??'').split(' ').filter(Boolean);
 if(result.token_type?.toLowerCase()!=='bearer' || !validToken(result.access_token) || !validToken(result.refresh_token) || !Number.isFinite(result.expires_in) || result.expires_in<=0 || result.expires_in>86400 || !scopes.includes('doraft:wiki:read') || scopes.some(scope=>!config.scope.split(' ').includes(scope)))throw failure('INVALID_OAUTH_TOKEN_RESPONSE');
 return {...s,schema:1,issuer:config.issuer,resource:config.resource,accessToken:result.access_token,refreshToken:result.refresh_token,expiresAt:started+result.expires_in*1000,pendingRefresh:false};
}
async function post(path,body,json=false){
 let response;
 try{response=await fetch(config.issuer+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':json?'application/json':'application/x-www-form-urlencoded'},body:json?JSON.stringify(body):new URLSearchParams(body)});}
 catch{throw failure('OAUTH_REQUEST_UNCERTAIN');}
 if(!response.ok)throw failure(`OAUTH_HTTP_${response.status}`);
 try{return await response.json();}catch{throw failure('INVALID_OAUTH_RESPONSE');}
}
const refresh=s=>post('/oauth2/token',{grant_type:'refresh_token',client_id:s.clientId,refresh_token:s.refreshToken,resource:config.resource});
export async function getHeaders({dir=stateRoot(),requestTokens=refresh,waitMs}={}){
 return withLock(dir,async()=>{
  const state=await readState(dir);validateState(state);
  if(state.expiresAt>Date.now()+30000)return {Authorization:`Bearer ${state.accessToken}`};
  // Persist intent before sending a one-time refresh. A timeout/crash must not replay it.
  await writeState(dir,{...state,pendingRefresh:true});
  const started=Date.now();const next=nextState(state,await requestTokens(state),started);
  await writeState(dir,next);
  return {Authorization:`Bearer ${next.accessToken}`};
 },{waitMs});
}
export async function login({dir=stateRoot()}={}){
 return withLock(dir,async()=>{
  const verifier=randomBytes(32).toString('base64url');
  const state=randomBytes(32).toString('base64url');
  let finish,rejectLogin;
  const callback=new Promise((res,rej)=>{finish=res;rejectLogin=rej;});
  let consumed=false;
  const server=createServer((req,res)=>{
   const url=new URL(req.url,'http://127.0.0.1');const received=url.searchParams.get('state')??'';
   const receivedBytes=Buffer.from(received), stateBytes=Buffer.from(state);
   const stateMatches=receivedBytes.length===stateBytes.length && timingSafeEqual(receivedBytes,stateBytes);
   if(req.method!=='GET' || url.pathname!=='/callback' || !stateMatches || url.searchParams.get('iss')!==config.issuer || consumed){res.writeHead(400);res.end('Invalid OAuth callback');return;}
   consumed=true;
   if(url.searchParams.has('error') || !url.searchParams.get('code')){res.writeHead(400);res.end('OAuth denied');rejectLogin(failure('OAUTH_LOGIN_DENIED'));return;}
   res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end('Doraft Wiki login received. Return to Codex.');finish(url.searchParams.get('code'));
  });
  await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
  const timer=setTimeout(()=>rejectLogin(failure('OAUTH_LOGIN_TIMEOUT')),300000);
  try{
   const redirect=`http://127.0.0.1:${server.address().port}/callback`;
   const client=await post('/oauth2/register',{client_name:'Doraft Wiki',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']},true);
   if(typeof client.client_id!=='string' || !client.client_id)throw failure('INVALID_OAUTH_CLIENT');
   const url=new URL(config.issuer+'/oauth2/authorize');
   url.search=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:redirect,scope:config.scope,resource:config.resource,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
   process.stderr.write(`Open this Doraft login URL in your browser:\n${url}\n`);
   const code=await callback;const started=Date.now();
   const result=await post('/oauth2/token',{grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:redirect,code_verifier:verifier,resource:config.resource});
   await writeState(dir,nextState({clientId:client.client_id},result,started));
   process.stderr.write('Doraft Wiki shared OAuth login complete.\n');
  }finally{clearTimeout(timer);server.close();}
 });
}
async function main(){
 const mode=process.argv[2]??'headers';
 if(mode==='headers')process.stdout.write(JSON.stringify(await getHeaders())+'\n');
 else if(mode==='login')await login();
 else if(mode==='status'){
  try{const s=await readState(stateRoot());validateState(s);process.stdout.write(JSON.stringify({authenticated:true,resource:s.resource,expiresAt:s.expiresAt,refreshPending:false})+'\n');}
  catch(e){process.stdout.write(JSON.stringify({authenticated:false,error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'OAUTH_LOCAL_ERROR'})+'\n');process.exitCode=1;}
 }else throw failure('Usage: oauth-helper.mjs headers|login|status');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(`Doraft OAuth: ${error.code==='ENOENT'?'DORAFT_LOGIN_REQUIRED':/^[A-Z0-9_]+$/.test(error.message)?error.message:'OAUTH_LOCAL_ERROR'}\n`);process.exitCode=1;});
