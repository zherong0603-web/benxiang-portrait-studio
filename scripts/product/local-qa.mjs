#!/usr/bin/env node
/**
 * Reproduce the built-Worker HTTP regression in an isolated local D1/R2 store.
 *
 *   node scripts/product/local-qa.mjs [--port 0|1024..65535]
 *
 * Requires installed project dependencies, npm, Python 3 and Node >=22.13.
 * This rebuilds dist, so stop other previews which are using dist first.
 * It runs npm build, applies all checked-in SQL migrations locally, starts
 * the real built Worker on 127.0.0.1, verifies test mode/payment-disabled config,
 * then runs original, commerce, creation and six-template HTTP checks in sequence. The 99 CNY catalog is
 * explicitly a local protocol fixture, never a commercial price or real offer.
 *
 * No deployed URL, remote database, payment key, deployment or provider request
 * is accepted. Temporary config, D1, R2, logs and process groups belong to this
 * invocation and are removed in finally. The existing Python checks keep their
 * assertions; a wrapper makes runtime-restart 503s fatal instead of retrying.
 * Expected 503s for deliberately unconfigured generation/payment remain tests.
 */
import {spawn} from 'node:child_process';
import {cp,mkdtemp,mkdir,readFile,writeFile,rm,access,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import http from 'node:http';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const operator='portrait-test-operator';
const migrations=(await readdir(join(root,'drizzle'))).filter(name=>/^\d{4}_[a-zA-Z0-9_-]+\.sql$/.test(name)).sort();
const active=new Map();
let requestedPort=0,interrupted=null,scratch=null;

function options(){
 const args=process.argv.slice(2);
 if(args.length===1&&['--help','-h'].includes(args[0])){
  process.stdout.write('Usage: node scripts/product/local-qa.mjs [--port 0|1024..65535]\nLocal only; rebuilds dist, runs all local migrations and all HTTP smoke scripts.\n');return false;
 }
 if(args.length){
  if(args.length!==2||args[0]!=='--port'||!/^\d+$/.test(args[1]))throw new Error('Only --port 0|1024..65535 is accepted; no URLs or external hosts.');
  requestedPort=Number(args[1]);
  if(!Number.isSafeInteger(requestedPort)||(requestedPort!==0&&(requestedPort<1024||requestedPort>65535)))throw new Error('Port must be 0 or an unprivileged TCP port from 1024 to 65535.');
 }
 if(process.platform==='win32')throw new Error('This runner currently requires Unix process groups (macOS or Linux).');
 return true;
}

function ensureRunning(){if(interrupted)throw interrupted}
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

function environment(){
 const env={...process.env};
 // Local commands never inherit account tokens, payment configuration, proxies
 // or CLI import hooks. Existing HOME and PATH retain their original meanings.
 for(const key of Object.keys(env))if(/^(?:CLOUDFLARE_|CF_|WRANGLER_|WECHAT_|STRIPE_|COMMERCE_|PORTRAIT_GENERATION_|PORTRAIT_WORKER_|OPENAI_|ARK_|GEMINI_|PORTRAIT_SMOKE_|SITES_RUNTIME_ROOT$|SITES_ENV_READY$|SITES_PROJECT_ROOT$|NODE_OPTIONS$|(?:ALL|HTTP|HTTPS|NO)_PROXY$|npm_config_(?:proxy|http_proxy|https_proxy)$)/i.test(key))delete env[key];
 return {...env,CI:'true',BROWSER:'none',NO_COLOR:'1',FORCE_COLOR:'0',PYTHONDONTWRITEBYTECODE:'1',npm_config_offline:'true',npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false',
  SITES_RUNTIME_ROOT:join(scratch,'runtime'),CLOUDFLARE_CF_FETCH_ENABLED:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false',
  WRANGLER_LOG_PATH:join(scratch,'logs'),WRANGLER_REGISTRY_PATH:join(scratch,'registry'),MINIFLARE_REGISTRY_PATH:join(scratch,'registry'),PORTRAIT_SMOKE_OPERATOR:operator};
}

function start(label,command,args,{cwd=root,timeout=0,env}={}){
 ensureRunning();
 if(args.includes('--remote')||args.includes('deploy')||args.includes('publish'))throw new Error('Remote or publication commands are forbidden by local-qa.');
 process.stdout.write(`\n[local-qa] ${label}\n`);
 const child=spawn(command,args,{cwd,env:env??environment(),stdio:['ignore','pipe','pipe'],detached:true});
 const entry={child,tail:'',timedOut:false,closed:false,exit:null,promise:null};
 active.set(child.pid??child,entry);
 for(const [stream,destination] of [[child.stdout,process.stdout],[child.stderr,process.stderr]])stream.on('data',chunk=>{
  const text=chunk.toString();entry.tail=(entry.tail+text).slice(-16000);destination.write(chunk);
 });
 entry.promise=new Promise((resolve,reject)=>{
  child.once('error',error=>{entry.closed=true;active.delete(child.pid??child);reject(error)});
  child.once('close',(code,signal)=>{entry.closed=true;entry.exit={code,signal};active.delete(child.pid??child);resolve(entry.exit)});
 });
 // Readiness checks may observe an early worker exit before awaiting this promise.
 entry.promise.catch(()=>{});
 if(timeout){let forceTimer;const timer=setTimeout(()=>{entry.timedOut=true;signalGroup(entry,'SIGTERM');forceTimer=setTimeout(()=>signalGroup(entry,'SIGKILL'),3000)},timeout);entry.promise.finally(()=>{clearTimeout(timer);clearTimeout(forceTimer)}).catch(()=>{})}
 return entry;
}

async function run(label,command,args,settings){
 const entry=start(label,command,args,settings),exit=await entry.promise;
 if(entry.timedOut)throw new Error(`${label} timed out.`);
 if(exit.code!==0)throw new Error(`${label} failed (${exit.signal??exit.code}).`);
 ensureRunning();return entry;
}

function signalGroup(entry,signal){
 if(entry.closed||!entry.child.pid)return;
 try{process.kill(-entry.child.pid,signal)}catch(error){if(error.code!=='ESRCH')throw error}
}

async function stop(entry){
 if(entry.closed)return;
 signalGroup(entry,'SIGTERM');
 const ended=await Promise.race([entry.promise.then(()=>true,()=>true),delay(3000).then(()=>false)]);
 if(!ended){signalGroup(entry,'SIGKILL');await Promise.race([entry.promise.catch(()=>{}),delay(3000)])}
 if(!entry.closed)throw new Error('An owned process did not stop after SIGKILL.');
}

async function freePort(port){
 const server=createServer();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port,exclusive:true},resolve)});
 const address=server.address();
 if(!address||typeof address==='string')throw new Error('Failed to allocate a loopback port.');
 await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 return address.port;
}

function localRequest(base){
 const url=new URL('/api/orders',base);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('Only loopback HTTP is allowed.');
 return new Promise((resolve,reject)=>{
  const request=http.get(url,{headers:{'oai-authenticated-user-id':operator,'oai-authenticated-user-email':`${operator}@sites.test`}},response=>{
   const chunks=[];let bytes=0;
   response.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024){request.destroy(new Error('Readiness response exceeded 1 MiB'));return}chunks.push(chunk)});
   response.once('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));response.once('error',reject);
  });
  request.setTimeout(3000,()=>request.destroy(new Error('Local readiness request timed out.')));request.once('error',reject);
 });
}

async function ready(base,worker){
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){
  ensureRunning();
  if(worker.closed)throw new Error(`Built Worker exited during startup (${worker.exit?.code??'spawn failure'}).`);
  let result;
  try{result=await localRequest(base)}catch(error){if(error.code!=='ECONNREFUSED')throw error;await delay(200);continue}
  // Startup connection refusal is allowed; an actual HTTP 503 is never retried.
  if(result.status!==200)throw new Error(`Built Worker readiness returned HTTP ${result.status}: ${result.body.slice(0,800)}`);
  let data;try{data=JSON.parse(result.body)}catch{throw new Error('Built Worker did not return JSON configuration.');}
  if(data.commerce?.mode!=='test'||data.commerce?.configured!==false||data.commerce?.operator!==true)throw new Error('Local runtime must be test mode, payment-disabled and expose the fixture operator.');
  const package_=data.catalog?.find(item=>item.id==='local-single');
  if(!package_||package_.amountMinor!==9900||package_.currency!=='cny'||package_.count!==1||!package_.description?.includes('非实际报价'))throw new Error('Unexpected local-only test catalog.');
  process.stdout.write(`[local-qa] Verified ${base}: test mode, no payment channel, fixture catalog only.\n`);return;
 }
 throw new Error('Built Worker did not accept loopback connections within 45 seconds.');
}

// Run the unchanged Python scripts while enforcing the origin on every request
// (including redirects) and rejecting the specific restart-503 retry path.
const pythonGuard=String.raw`
import io, runpy, sys, urllib.request, urllib.error, urllib.parse
script, base = sys.argv[1], sys.argv[2]
allowed = urllib.parse.urlsplit(base)
original_open = urllib.request.OpenerDirector.open
def local_only_open(self, target, *args, **kwargs):
    url = target.full_url if isinstance(target, urllib.request.Request) else target
    actual = urllib.parse.urlsplit(url)
    if actual.scheme != 'http' or actual.hostname != '127.0.0.1' or actual.port != allowed.port or actual.username or actual.password:
        raise RuntimeError('local-qa blocked a request outside its loopback origin')
    try:
        return original_open(self, target, *args, **kwargs)
    except urllib.error.HTTPError as error:
        if error.code != 503:
            raise
        raw = error.read()
        error.close()
        if b'worker restarted mid-request' in raw.lower():
            raise RuntimeError('local-qa treats a Worker restart HTTP 503 as a failure; retries are forbidden') from error
        raise urllib.error.HTTPError(error.url, error.code, error.msg, error.headers, io.BytesIO(raw)) from None
urllib.request.OpenerDirector.open = local_only_open
sys.argv = [script, base]
runpy.run_path(script, run_name='__main__')
`;

async function main(){
 if(!options())return;
 const wrangler=join(root,'node_modules/wrangler/bin/wrangler.js');
 await access(wrangler,constants.R_OK);
 for(const file of migrations)await access(join(root,'drizzle',file),constants.R_OK);
 scratch=await mkdtemp(join(tmpdir(),'benxiang-local-qa-'));
 const onSignal=signal=>{interrupted=new Error(`Interrupted by ${signal}`);for(const entry of active.values())signalGroup(entry,'SIGTERM')};
 const onInt=()=>onSignal('SIGINT'),onTerm=()=>onSignal('SIGTERM');
 process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
 let worker,passed=false;
 try{
  await Promise.all(['logs','registry','runtime'].map(name=>mkdir(join(scratch,name),{recursive:true})));
  await run('Build existing project','npm',['run','build'],{timeout:5*60000});
  const built=JSON.parse(await readFile(join(root,'dist/server/wrangler.json'),'utf8'));
  const builtMain=resolve(root,'dist/server',built.main||'index.js'),assets=resolve(root,'dist/server',built.assets?.directory||'../client');
  if(!builtMain.startsWith(join(root,'dist/server/') )||!assets.startsWith(join(root,'dist/')))throw new Error('Built artifact paths must stay inside this project dist.');
  await access(builtMain,constants.R_OK);await access(assets,constants.R_OK);
  // Dev watches the whole no_bundle module root and asset directory. Keep
  // those inputs private and stable; mutable D1/R2, registry and logs are siblings.
  const workerDirectory=join(scratch,'worker'),localAssets=join(scratch,'assets');
  await cp(join(root,'dist/server'),workerDirectory,{recursive:true,filter:path=>basename(path)!=='wrangler.json'});
  await cp(assets,localAssets,{recursive:true});
  const localMain=join(workerDirectory,relative(join(root,'dist/server'),builtMain));
  const port=await freePort(requestedPort),base=`http://127.0.0.1:${port}`,config=join(scratch,'wrangler.json'),state=join(scratch,'state');
  const vars={COMMERCE_MODE:'test',COMMERCE_LIVE_ENABLED:'false',COMMERCE_PAYMENT_PROVIDER:'wechat',COMMERCE_OPERATOR_IDS:operator,COMMERCE_ALLOWED_ORIGIN:base,
   COMMERCE_CATALOG_JSON:JSON.stringify([{id:'local-single',name:'本地测试套餐 · 99元非实际报价',count:1,amountMinor:9900,currency:'cny',description:'非实际报价：仅用于本地协议回归，99元为测试金额，不是服务报价；无支付通道，不会收费。'}]),
   WECHAT_APP_ID:'',WECHAT_MCH_ID:'',WECHAT_MCH_SERIAL:'',WECHAT_PRIVATE_KEY:'',WECHAT_API_V3_KEY:'',WECHAT_PLATFORM_KEY_ID:'',WECHAT_PLATFORM_PUBLIC_KEY:'',STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:''};
  const localConfig={name:`benxiang-local-qa-${process.pid}`,main:localMain,no_bundle:true,find_additional_modules:true,base_dir:workerDirectory,compatibility_date:built.compatibility_date||'2026-05-15',compatibility_flags:built.compatibility_flags||['nodejs_compat'],
   assets:{directory:localAssets},rules:built.rules||[{type:'ESModule',globs:['**/*.js','**/*.mjs']}],vars,
   d1_databases:[{binding:'DB',database_name:'benxiang-local-qa-db',database_id:'00000000-0000-4000-8000-000000000000',remote:false}],r2_buckets:[{binding:'BUCKET',bucket_name:'benxiang-local-qa-images',remote:false}],observability:{enabled:false}};
  await writeFile(config,JSON.stringify(localConfig,null,2));
  await writeFile(join(scratch,'.dev.vars'),'# Intentionally empty: all provider keys are disabled by local-qa.\n');
  for(const file of migrations)await run(`Apply local migration ${file}`,process.execPath,[wrangler,'d1','execute','DB','--local','--config',config,'--persist-to',state,'--file',join(root,'drizzle',file)],{cwd:scratch,timeout:60000});
  worker=start('Start real built Worker',process.execPath,[wrangler,'dev','--local','--config',config,'--persist-to',state,'--ip','127.0.0.1','--port',String(port),'--inspector-port','0'],{cwd:scratch});
  await ready(base,worker);
  for(const name of ['smoke.py','commerce-smoke.py','creation-smoke.py','six-template-smoke.py']){
   await run(`HTTP regression ${name}`,'python3',['-c',pythonGuard,join(root,'scripts/product',name),base],{cwd:scratch,timeout:3*60000});
   if(worker.closed)throw new Error('Built Worker exited during HTTP regression.');
   if(/worker restarted mid-request/i.test(worker.tail))throw new Error('Worker restart was observed; this run cannot pass.');
  }
  passed=true;
 }finally{
  const cleanupErrors=[];
  try{
   for(const entry of [...active.values()])try{await stop(entry)}catch(error){cleanupErrors.push(error)}
   try{await rm(scratch,{recursive:true,force:true})}catch(error){cleanupErrors.push(error)}
  }finally{process.removeListener('SIGINT',onInt);process.removeListener('SIGTERM',onTerm)}
  if(cleanupErrors.length)throw new Error(`Local runtime cleanup failed: ${cleanupErrors.map(error=>error.message).join('; ')}`);
  process.stdout.write('[local-qa] Stopped owned processes and removed temporary local runtime.\n');
 }
 if(passed)process.stdout.write('[local-qa] PASS: all four HTTP regressions completed against isolated local D1/R2; no real payment or generation occurred.\n');
}

main().catch(error=>{process.stderr.write(`[local-qa] FAIL: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=interrupted?130:1});
