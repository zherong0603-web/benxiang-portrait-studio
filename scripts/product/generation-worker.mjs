#!/usr/bin/env node
/**
 * node scripts/product/generation-worker.mjs [--once]
 * PORTRAIT_WORKER_ORIGIN defaults to http://127.0.0.1:5173. Loopback only.
 * OpenAI wire adapter is implemented; actual calls default disabled until account,
 * authorization, explicit model/quality and verified budget are configured.
 * Disabled exits 0, without claiming tasks, requiring secrets or opening sockets.
 */
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createServiceClient,executeClaim} from './generation-runtime.mjs';
import {createImageProvider} from './image-provider.mjs';
import {createGenerationOutbox} from './generation-outbox.mjs';

function pause(ms,signal){
 return new Promise(resolve=>{
  if(signal.aborted)return resolve();
  const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve()};
  const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});
 });
}
/** Dependency injection is used for the verified adapter boundary and unit tests. */
export async function runWorker({provider,service,once=false,pollMs=2_000,signal,outbox,onEvent=()=>{}}){
 if(!provider?.ready){onEvent({status:'disabled',reason:provider?.reason??'unconfigured'});return {status:'disabled'}}
 const lock=outbox?await outbox.acquire():null;
 const controller=new AbortController();
 const abort=()=>controller.abort(signal.reason??new Error('Worker stopping'));
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 let registering=false,registered=false;
 const register=async()=>{
  if(registering||controller.signal.aborted)return;
  registering=true;
  try{await service.action({action:'register',adapterReady:true,provider:provider.provider,model:provider.model,budgetCurrency:provider.budgetCurrency??'USD',supportedAspectRatios:provider.supportedAspectRatios??[],maxImages:provider.maxImages??0},{signal:controller.signal});registered=true}
  catch(error){registered=false;throw error}
  finally{registering=false}
 };
 let ticker;
 try{
  // Service reconnects are safe: no provider request is replayed. The claim's
  // own heartbeat independently fences an external request on lease loss.
  ticker=setInterval(()=>{void register().catch(()=>onEvent({status:'service_unavailable'}))},20_000);
  while(!controller.signal.aborted){
   if(!registered){try{await register()}catch{onEvent({status:'service_unavailable'});if(once)return{status:'service_unavailable'};await pause(Math.max(pollMs,1000),controller.signal);continue}}
   if(outbox){const recovery=await outbox.replay(service,{signal:controller.signal});if(recovery.pending){onEvent({status:'pending_delivery'});if(once)return {status:'pending_delivery'};await pause(Math.max(pollMs,5000),controller.signal);continue}}
   let claim;
   try{({claim}=await service.action({action:'claim'},{signal:controller.signal}))}
   catch{registered=false;onEvent({status:'service_unavailable'});if(once)return{status:'service_unavailable'};await pause(Math.max(pollMs,1000),controller.signal);continue}
   if(claim){
    const result=await executeClaim(claim,{service,provider,signal:controller.signal,outbox});
    onEvent({status:result.status});
    if(once)return result;
   }else if(once)return {status:'idle'};
   await pause(pollMs,controller.signal);
  }
  return {status:'stopped'};
 }finally{clearInterval(ticker);signal?.removeEventListener('abort',abort);await lock?.release()}
}

async function main(){
 const args=process.argv.slice(2);
 if(args.length>1||args.some(arg=>arg!=='--once'))throw new Error('Usage: generation-worker.mjs [--once]');
 const provider=createImageProvider(process.env);
 if(!provider.ready){process.stdout.write(`本相生成执行器：未启用自动生图（${provider.reason}）。原工作台真实导入仍可用。\n`);return}
 const service=createServiceClient({origin:process.env.PORTRAIT_WORKER_ORIGIN??'http://127.0.0.1:5173',secret:process.env.PORTRAIT_WORKER_SECRET,remoteSiteEnabled:process.env.PORTRAIT_REMOTE_SITE_ENABLED==='true',siteAccessToken:process.env.OAI_SITES_SERVICE_TOKEN});
 const controller=new AbortController();
 const stop=()=>controller.abort(new Error('Worker stopping'));
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 const outbox=await createGenerationOutbox();
 try{await runWorker({provider,service,outbox,once:args.includes('--once'),signal:controller.signal,onEvent:event=>process.stdout.write(`本相生成执行器：${event.status}\n`)})}
 finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop)}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 main().catch(()=>{process.stderr.write('本相生成执行器停止：配置或服务不可用；未自动重试外部请求。\n');process.exitCode=1});
}
