#!/usr/bin/env node
/** Start the existing local studio and its executor. This safe demo command never enables paid providers. */
import {spawn} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {createServer} from 'node:net';
import {prepareStudioDatabase} from './local-studio-db.mjs';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {readExecutionProfile} from '../execution-profile.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url));
export function launchConfiguration(source=process.env,profile=readExecutionProfile()){
 const env={...source};
 for(const key of Object.keys(env))if(/^(OPENAI_|ARK_|GEMINI_|PORTRAIT_|WECHAT_|STRIPE_|COMMERCE_|CLOUDFLARE_|CF_|WRANGLER_|DOTENV_CONFIG_|VITE_|MINIFLARE_|NODE_OPTIONS$)/i.test(key))delete env[key];
 Object.assign(env,{PORTRAIT_GENERATION_ENABLED:'false',PORTRAIT_WORKER_ORIGIN:'http://127.0.0.1:5173',COMMERCE_MODE:'test',COMMERCE_LIVE_ENABLED:'false',BROWSER:'none',CLOUDFLARE_CF_FETCH_ENABLED:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false'});
 return {origin:'http://127.0.0.1:5173',env,webArgs:['scripts/run-framework.mjs','dev',profile==='managed-linux'?'--host':'--hostname','127.0.0.1','--port','5173',...(profile==='managed-linux'?['--strictPort']:[])]};
}
export async function assertSafeLocalConfiguration(directory=root){
 const names=await readdir(directory);
 const alternative=names.find(name=>(name.startsWith('.env')&&name!=='.env.example')||(name.startsWith('.dev.vars')&&name!=='.dev.vars'));
 if(alternative)throw new Error(`Safe demo startup stopped: ${alternative} is an alternate environment source. Leave existing configuration untouched; use a clean local checkout containing only the reviewed .dev.vars or move the alternate file out of this checkout before starting.`);
 let raw='';try{raw=await readFile(resolve(directory,'.dev.vars'),'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
 // Accept only a simple assignment subset shared by Node and dotenv. Colon and multiline
 // spellings are rejected rather than silently parsed differently by the Vite/Wrangler loader.
 for(const line of raw.split(/\r?\n/))if(line.trim()&&!line.trimStart().startsWith('#')&&!/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line))throw new Error('Safe demo startup stopped: .dev.vars uses unsupported dotenv syntax. Use one KEY=value assignment per line; existing configuration was not changed.');
 const values=parseEnv(raw);
 const benign=new Set(['COMMERCE_CATALOG_JSON','COMMERCE_OPERATOR_IDS','COMMERCE_ALLOWED_ORIGIN','COMMERCE_PAYMENT_PROVIDER']);
 for(const [name,value] of Object.entries(values)){
  const lower=value.trim().toLowerCase();
  const safe=!value||benign.has(name)||(name==='COMMERCE_MODE'&&lower==='test')||(['COMMERCE_LIVE_ENABLED','PORTRAIT_GENERATION_ENABLED','PORTRAIT_EXTERNAL_CALLS_AUTHORIZED'].includes(name)&&['false','0',''].includes(lower));
  if(!safe)throw new Error(`Safe demo startup stopped: .dev.vars contains an enabled or unsupported binding (${name}). Existing configuration was not changed. Use a reviewed local test configuration with all payment/provider credentials empty.`);
 }
}
export async function assertStudioPortAvailable(){
 await new Promise((resolvePromise,reject)=>{const server=createServer();server.once('error',()=>reject(new Error('Local port 5173 is already in use. No database migration or new server was started. Use the existing studio or stop only its owned process before retrying.')));server.listen(5173,'127.0.0.1',()=>server.close(resolvePromise))});
}
export async function startStudio(){
 await assertSafeLocalConfiguration();
 await assertStudioPortAvailable();
 const config=launchConfiguration();
 const prepared=await prepareStudioDatabase(root,config.env);
 if(prepared.applied.length)console.log(`本地数据库已追加迁移：${prepared.applied.join(', ')}；备份：${prepared.backupPath}`);
 const children=[];let closing=false;
 const stop=(exitCode=0)=>{if(closing)return;closing=true;for(const child of children){if(child.exitCode!==null)continue;try{process.kill(-child.pid,'SIGTERM')}catch{}}
  const kill=setTimeout(()=>{for(const child of children){if(child.exitCode!==null)continue;try{process.kill(-child.pid,'SIGKILL')}catch{}}process.exit(exitCode)},2500);kill.unref();process.exitCode=exitCode;
 };
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>stop(0));
 const web=spawn(process.execPath,config.webArgs,{cwd:root,env:config.env,stdio:'inherit',detached:true});children.push(web);
 web.on('error',()=>{console.error('Local website process could not start.');stop(1)});
 web.on('exit',code=>stop(code??1));
 const worker=spawn(process.execPath,['scripts/product/generation-worker.mjs'],{cwd:root,env:config.env,stdio:'inherit',detached:true});children.push(worker);
 worker.on('error',()=>{console.error('Local executor could not start.');stop(1)});
 worker.on('exit',code=>{if(code)stop(code)});
 console.log(`本相本地体验：${config.origin}/experience — 支付关闭；外部自动生图关闭，真实手工导入可用。`);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)startStudio().catch(error=>{console.error(error.message);process.exitCode=1});
