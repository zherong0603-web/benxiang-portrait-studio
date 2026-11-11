import {createImageProvider,ProviderError} from '../scripts/product/image-provider.mjs';
import {normalizeWorkerImage} from './worker-image.mjs';
import {activeAttempt,authorizeHostedExecution,handleWorker,queueSession,workerReference,workerResult,type HostedConsent,type HostedSelection} from './generation';
import {getSession,now,sha256} from './creations';
import {publicCreation,type PublicCreationSession} from './public-portrait';
import {ApiError} from './server';
import {reserveUpload,abandonUpload,PRIVACY_LEASE_MS,readBoundedBody} from './privacy';

type HostedProvider={ready:boolean;generate(input:{prompt:string;images:{bytes:Uint8Array;mime:string;sha256:string}[];outputAspectRatio:'3:4';watermark:false;signal:AbortSignal}):Promise<{bytes:Uint8Array;model:string;providerRequestId?:string;usage?:unknown}>};
export type HostedCost={currency:'CNY';reservedMicro:number;estimatedMicro:null;actualMicro:null;status:'not-called'|'unknown'};
export type HostedEvent={type:'session'|'done';session:PublicCreationSession}|{type:'cost';cost:HostedCost}|{type:'error';error:string;cost:HostedCost};
export {authorizeHostedExecution};
export {authorizeHostedRecovery} from './generation';
const failure='本次生成未完成。请核对已保存状态；已发出的模型请求不会自动重试，预留费用需核对服务商账单。';
const providerCodes=new Set(['provider_disabled','provider_input','provider_aborted','provider_timeout','provider_redirect','provider_http','provider_transport','provider_response']);
const pendingSql=`SELECT a.*,g.job_id FROM generation_attempts a JOIN generation_slots g ON g.id=a.slot_id AND g.owner_id=a.owner_id WHERE a.owner_id=? AND g.session_id=? AND a.slot_id=? ORDER BY a.ordinal DESC LIMIT 1`;
async function outputRequest(attemptId:string,leaseToken:string,bytes:Uint8Array,metadata:any){
 const form=new FormData();form.set('attemptId',attemptId);form.set('leaseToken',leaseToken);form.set('file',new File([new Uint8Array(bytes)],'portrait.jpg',{type:'image/jpeg'}));form.set('metadata',JSON.stringify(metadata));
 return new Request('https://internal.invalid/worker-result',{method:'POST',body:form});
}
// A pending-upload row owns every byte, including crashes before final evidence commit.
async function savePending(db:D1Database,bucket:R2Bucket,a:any,output:any,metadata:any){
 const key=`private/${a.owner_id}/${crypto.randomUUID()}`,size=output.bytes.byteLength;
 await reserveUpload(db,{key,owner:a.owner_id,size,kind:'generation_evidence',jobId:a.job_id});
 const pointer={key,size,sha256:output.sha256,metadata,recoveryToken:a.recovery_token};
 // Establish ownership and recovery proof before starting a possibly ambiguous R2 put.
 try{
  const saved=await db.prepare(`UPDATE generation_attempts SET metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.hostedOutput',json(?)),updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE id=? AND owner_id=? AND lease_token=? AND lease_expires_at>? AND status='dispatched' AND EXISTS(SELECT 1 FROM pending_uploads WHERE object_key=? AND owner_id=? AND cancelled=0 AND created_at>?) AND EXISTS(SELECT 1 FROM generation_slots g JOIN portrait_sessions s ON s.id=g.session_id JOIN jobs j ON j.id=g.job_id WHERE g.id=generation_attempts.slot_id AND s.status!='cancelled' AND j.deletion_token IS NULL AND j.status!='completed') AND NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=generation_attempts.owner_id)`).bind(JSON.stringify(pointer),now(),a.id,a.owner_id,a.lease_token,now(),key,a.owner_id,new Date(Date.now()-PRIVACY_LEASE_MS).toISOString()).run();
  if(!saved.meta.changes)throw new ApiError(409,'生成结果保存已取消');
 }catch(error){await abandonUpload(db,bucket,key,a.owner_id,size);throw error}
 // A rejected put may have stored the bytes. Keep the pointer and reservation until
 // recovery checks the object/hash, or the original cancellation/expiry cleanup wins.
 let putFailed=false,putError:unknown;
 try{await bucket.put(key,output.bytes,{httpMetadata:{contentType:'image/jpeg'}})}catch(error){putFailed=true;putError=error}
 // The put has settled. Only a confirmed revocation permits immediate abandonment;
 // a D1 outage here leaves the tracked key available for free output recovery.
 const live=await db.prepare("SELECT p.object_key FROM pending_uploads p JOIN generation_attempts a ON a.id=? AND a.owner_id=p.owner_id JOIN generation_slots g ON g.id=a.slot_id AND g.job_id=p.job_id JOIN portrait_sessions s ON s.id=g.session_id JOIN jobs j ON j.id=g.job_id WHERE p.object_key=? AND p.owner_id=? AND p.cancelled=0 AND p.created_at>? AND s.status!='cancelled' AND j.deletion_token IS NULL AND j.status!='completed' AND NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=p.owner_id)").bind(a.id,key,a.owner_id,new Date(Date.now()-PRIVACY_LEASE_MS).toISOString()).first();
 if(!live){await abandonUpload(db,bucket,key,a.owner_id,size);throw new ApiError(409,'生成结果保存已取消或过期')}
 if(putFailed)throw putError;
 return pointer;
}
async function restorePending(db:D1Database,bucket:R2Bucket,e:Cloudflare.Env,a:any,proof:HostedSelection){
 let pending;try{pending=JSON.parse(a.metadata_json)?.hostedOutput}catch{}
 if(!pending)throw new ApiError(409,'调用结果待核对，请勿重复生成');
 const upload=await db.prepare('SELECT * FROM pending_uploads WHERE object_key=? AND owner_id=? AND job_id=? AND cancelled=0 AND created_at>?').bind(pending.key,proof.ownerId,a.job_id,new Date(Date.now()-PRIVACY_LEASE_MS).toISOString()).first<any>();
 if(!upload){await abandonUpload(db,bucket,pending.key,proof.ownerId,pending.size);throw new ApiError(409,'暂存结果已过期或已取消')}
 const object=await bucket.get(pending.key);if(!object)throw new ApiError(409,'暂存结果不可用');
 const bytes=await readBoundedBody(new Request('https://internal.invalid/output',{method:'POST',body:object.body,duplex:'half'} as RequestInit),10*1024*1024);
 if(bytes.byteLength!==pending.size||await sha256(bytes)!==pending.sha256)throw new ApiError(409,'暂存结果校验失败');
 const recovery:any=await handleWorker(db,e,{action:'recover',attemptId:a.id,leaseToken:pending.recoveryToken,outputHash:pending.sha256,model:a.model},proof);
 if(recovery.state==='busy')throw new ApiError(409,'已有请求正在恢复，请稍后核对状态');
 if(recovery.state==='revoked'){await abandonUpload(db,bucket,pending.key,proof.ownerId,pending.size);throw new ApiError(409,'创作已取消，暂存照片已进入清理')}
 if(recovery.state==='resume')await workerResult(await outputRequest(a.id,recovery.leaseToken,bytes,pending.metadata),db,bucket,e,pending.key);
 await abandonUpload(db,bucket,pending.key,proof.ownerId,pending.size);
}
/** Internal runner. Only the execute route can obtain the in-memory consent authority. */
export async function executeHosted(db:D1Database,bucket:R2Bucket,e:Cloudflare.Env,proof:HostedConsent|HostedSelection,emit:(event:HostedEvent)=>void,{signal,provider=createImageProvider(e) as HostedProvider,heartbeatMs=15000,recoverOnly=false}:{recoverOnly?:boolean;signal?:AbortSignal;provider?:HostedProvider;heartbeatMs?:number}={}){
 let claim:any,heartbeat:ReturnType<typeof setInterval>|undefined,beating=false,dispatched=false;
 let stage:'after-reservation'|'provider'|'validate-output'|'save-output'|'finish'= 'after-reservation';
 const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 let cost:HostedCost={currency:'CNY',reservedMicro:0,estimatedMicro:null,actualMicro:null,status:'not-called'};
 const session=async()=>publicCreation(await getSession(db,proof.ownerId,proof.sessionId));
 try{
  if(controller.signal.aborted)throw new ApiError(409,'生成连接已停止');
  const prior=await db.prepare(pendingSql).bind(proof.ownerId,proof.sessionId,proof.slotId).first<any>();
  if(recoverOnly&&(!prior||!['succeeded','dispatched','needs_reconciliation'].includes(prior.status)))throw new ApiError(409,'该位置没有可恢复的已保存结果');
  if(prior&&prior.status!=='queued'){
   cost={...cost,reservedMicro:prior.reserved_micro,status:prior.reserved_micro?'unknown':'not-called'};emit({type:'cost',cost});
   if(prior.status==='dispatched'&&prior.lease_expires_at>now())throw new ApiError(409,'生成仍在执行，请等待当前请求完成');
   if(['dispatched','needs_reconciliation'].includes(prior.status))await restorePending(db,bucket,e,prior,proof);
   else if(prior.status!=='succeeded')throw new ApiError(409,'该位置已有执行记录，请核对状态');
   emit({type:'done',session:await session()});return;
  }
  if(prior){let c;try{c=JSON.parse(prior.metadata_json)?.chargeConsent}catch{};if(c?.ownerId!==proof.ownerId||c?.sessionId!==proof.sessionId||c?.slotId!==proof.slotId||c?.chargeConsentVersion!=='model-charge-v1'||c?.maxCostMicro!==1000000)throw new ApiError(409,'旧任务没有本次费用确认，请新建创作')}
  if(!provider.ready)throw new ApiError(503,'模型配置未就绪');
  if(!prior)await queueSession(db,proof.ownerId,proof.sessionId,e,proof.slotId,proof as HostedConsent);
  emit({type:'session',session:await session()});
  const picked:any=await handleWorker(db,e,{action:'claim'},proof);claim=picked.claim;
  if(!claim)throw new ApiError(409,'已有任务正在生成，请稍后核对状态');
  heartbeat=setInterval(()=>{if(beating)return;beating=true;void handleWorker(db,e,{action:'heartbeat',attemptId:claim.attemptId,leaseToken:claim.leaseToken},proof).catch(()=>controller.abort()).finally(()=>{beating=false})},heartbeatMs);
  const images=[];
  for(const ref of claim.references){
   const response=await workerReference(db,bucket,new URL(ref.url,'https://internal.invalid'),claim.leaseToken,e);
   const original=await readBoundedBody(new Request('https://internal.invalid/reference',{method:'POST',body:response.body,duplex:'half'} as RequestInit),10*1024*1024);
   if(await sha256(original)!==ref.sha256)throw new ApiError(409,'原照已变化，请重新上传');
   try{images.push(await normalizeWorkerImage(original,{signal:controller.signal}))}catch{throw new ApiError(400,controller.signal.aborted?'生成已停止':'原照无法完整读取，请重新上传 10MB、300 万像素以内的 JPG 或 PNG；旧 WebP 原照需重新上传。')}
  }
  if(controller.signal.aborted)throw new ApiError(409,'生成已停止');
  await handleWorker(db,e,{action:'dispatch',attemptId:claim.attemptId,leaseToken:claim.leaseToken},proof);dispatched=true;
  cost={...cost,reservedMicro:1000000,status:'unknown'};emit({type:'cost',cost});emit({type:'session',session:await session()});
  stage='provider';
  const output=await provider.generate({prompt:claim.prompt,images,outputAspectRatio:claim.outputAspectRatio,watermark:false,signal:controller.signal});
  stage='validate-output';
  const normalized=await normalizeWorkerImage(output.bytes,{signal:controller.signal});
  if(normalized.width*4!==normalized.height*3||output.model!==claim.model)throw new ApiError(409,'生成结果规格不匹配');
  stage='save-output';
  const a=await activeAttempt(db,claim.attemptId,claim.leaseToken);
  const metadata={model:output.model,providerOutputHash:await sha256(output.bytes),normalizationVersion:'portrait-jpeg-normalize-v1',inputPolicy:'person-only',watermark:false,outputAspectRatio:'3:4',outputDimensions:{width:normalized.width,height:normalized.height},inputHashes:images.map(image=>image.sha256),...(output.providerRequestId?{providerRequestId:output.providerRequestId}:{}),...(output.usage?{usage:output.usage}:{}),chargeConsent:JSON.parse(a.metadata_json).chargeConsent};
  const pending=await savePending(db,bucket,a,normalized,metadata);
  await workerResult(await outputRequest(claim.attemptId,claim.leaseToken,normalized.bytes,metadata),db,bucket,e,pending.key);
  await abandonUpload(db,bucket,pending.key,proof.ownerId,pending.size);
  stage='finish';
  emit({type:'done',session:await session()});
 }catch(error){
  if(dispatched){
   const providerError=error instanceof ProviderError?error:null,status=providerError?.httpStatus;
   console.error('portrait_hosted_execution_failed',{stage,code:providerError&&providerCodes.has(providerError.code)?providerError.code:'processing_failed',httpStatus:typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?status:null});
  }
  if(claim){try{const row=await db.prepare(pendingSql).bind(proof.ownerId,proof.sessionId,proof.slotId).first<any>();const pending=row?.metadata_json?JSON.parse(row.metadata_json)?.hostedOutput:null;if(pending){const live=await db.prepare("SELECT p.object_key FROM pending_uploads p JOIN jobs j ON j.id=p.job_id AND j.owner_id=p.owner_id JOIN portrait_session_jobs sj ON sj.job_id=j.id JOIN portrait_sessions s ON s.id=sj.session_id WHERE p.object_key=? AND p.owner_id=? AND p.cancelled=0 AND p.created_at>? AND s.status!='cancelled' AND j.deletion_token IS NULL AND NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=p.owner_id)").bind(pending.key,proof.ownerId,new Date(Date.now()-PRIVACY_LEASE_MS).toISOString()).first();if(!live)await abandonUpload(db,bucket,pending.key,proof.ownerId,pending.size)}}catch{};try{await handleWorker(db,e,{action:'fail',attemptId:claim.attemptId,leaseToken:claim.leaseToken,error:dispatched?failure:error instanceof ApiError?error.message:'原照或生成配置校验未通过，未调用模型'},proof)}catch{}}
  try{const row=await db.prepare('SELECT COALESCE(r.reserved_micro,0) reserved FROM generation_attempts a JOIN generation_slots g ON g.id=a.slot_id LEFT JOIN generation_cost_reservations r ON r.attempt_id=a.id WHERE a.owner_id=? AND g.session_id=? AND a.slot_id=? ORDER BY a.ordinal DESC LIMIT 1').bind(proof.ownerId,proof.sessionId,proof.slotId).first<{reserved:number}>();if(row?.reserved)cost={...cost,reservedMicro:row.reserved,status:'unknown'};emit({type:'session',session:await session()})}catch{}
  // Provider/codec/storage exception text is private. Only our fixed preflight error is public.
  emit({type:'error',error:!dispatched&&error instanceof ApiError?error.message:failure,cost});
 }finally{if(heartbeat)clearInterval(heartbeat);signal?.removeEventListener('abort',abort)}
}
