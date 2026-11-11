import {createImageProvider} from '../scripts/product/image-provider.mjs';
import {parseGenerationPilot} from './generation-pilot.mjs';
import {parseWebTestScope,reservationFingerprint,scopeFingerprint,scopeSlot,assertScopeSlot,assertScopeAttempt,assertScopeOrder} from './web-test-scope.mjs';
import type {WebSixScope} from './web-test-scope.mjs';
import {SIX_TEMPLATE_PROMPT_VERSION} from './six-templates';
import {frozenPhotography} from './photography-recipes';
import {ApiError,string,body} from './server';
import {capability,now,sessionRecord,sha256} from './creations';
import {generationBudgetConfig,generationBudgetSummary} from './generation-budget';
import {reserveUpload,commitUpload,abandonUpload,readBoundedBody,PRIVACY_LEASE_MS} from './privacy';
import {inspectImage} from './image-validation';
import type {GenerationCapability,WorkerClaim} from './creation-contract';
const LEASE_MS=60000;
// State writes advance freshness inside SQL, even when a delayed writer captured
// an older wall clock or several transitions share the same millisecond. Lease
// deadlines retain their original wall-clock checks and are independent of this order.
const pilotError=()=>new ApiError(409,'本轮生成授权无效、已关闭或次数已用完');
// Allocations live independently of deletable sessions/attempts. An assigned style never refunds.
type PilotState={policy:ReturnType<typeof parseGenerationPilot>;id:string;fingerprint:string;status:string;allocations:Record<string,{slotId:string;attemptId:string}>};
async function pilotState(db:D1Database,e:Cloudflare.Env,{initialize=false,open=false}={}):Promise<PilotState|null>{
 const retained=(await db.prepare("SELECT id FROM generation_workers WHERE id GLOB 'owner-pilot:*' LIMIT 2").all<{id:string}>()).results;
 if(e.PORTRAIT_GENERATION_PILOT_JSON===undefined){if(retained.length)throw pilotError();return null}
 try{
  if(e.PORTRAIT_WEB_TEST_SCOPE!==undefined)throw Error();
  const policy=parseGenerationPilot(e.PORTRAIT_GENERATION_PILOT_JSON),config=generationBudgetConfig(e);
  if(!config||config.currency!=='CNY'||config.limitMicro!==policy.baselineCnyMicro+2000000||config.perCallMicro!==1000000||e.PORTRAIT_PROVIDER!=='ark'||e.PORTRAIT_MODEL!=='doubao-seedream-5-0-pro-260628')throw Error();
  const id='owner-pilot:'+policy.grantId,fingerprint=await sha256(new TextEncoder().encode(JSON.stringify(policy)));
  // This authorization version permits one durable batch, never replacement by a renamed grant.
  if(retained.length>1||retained.some(row=>row.id!==id))throw Error();
  if(initialize){
   const old=(await db.prepare("SELECT attempt_id,reserved_micro,currency,created_at FROM generation_cost_reservations WHERE currency='CNY' ORDER BY attempt_id").all<any>()).results;
   const baselineFingerprint=await reservationFingerprint(old);
   await db.prepare("INSERT OR IGNORE INTO generation_workers(id,ready_until,metadata_json) SELECT ?,'',? WHERE COALESCE((SELECT SUM(reserved_micro) FROM generation_cost_reservations WHERE currency='CNY'),0)=? AND NOT EXISTS(SELECT 1 FROM generation_workers WHERE id GLOB 'owner-pilot:*')").bind(id,JSON.stringify({fingerprint,baselineFingerprint,status:'open',allocations:{}}),policy.baselineCnyMicro).run();
  }
  const row=await db.prepare('SELECT metadata_json FROM generation_workers WHERE id=?').bind(id).first<{metadata_json:string}>();
  if(!row){if(open||initialize)throw Error();return {policy,id,fingerprint,status:'uninitialized',allocations:{}}}
  const fence=JSON.parse(row.metadata_json);
  if(fence.fingerprint!==fingerprint||!['open','closed'].includes(fence.status)||!fence.allocations||typeof fence.allocations!=='object'||Array.isArray(fence.allocations)||Object.keys(fence.allocations).some(k=>!policy.styleIds.includes(k))||Object.values(fence.allocations).some((x:any)=>!x||typeof x.slotId!=='string'||typeof x.attemptId!=='string')||(open&&fence.status!=='open'))throw Error();
  const old=(await db.prepare("SELECT attempt_id,reserved_micro,currency,created_at FROM generation_cost_reservations WHERE currency='CNY' AND attempt_id NOT IN (SELECT json_extract(value,'$.attemptId') FROM generation_workers,json_each(generation_workers.metadata_json,'$.allocations') WHERE generation_workers.id=?) ORDER BY attempt_id").bind(id).all<any>()).results;
  if(old.reduce((n,r)=>n+r.reserved_micro,0)!==policy.baselineCnyMicro||await reservationFingerprint(old)!==fence.baselineFingerprint)throw Error();
  return {policy,id,fingerprint,status:fence.status,allocations:fence.allocations};
 }catch{throw pilotError()}
}
// Recheck the durable fence inside each admission/claim/dispatch write, including close races.
function pilotFence(p:PilotState|null,attemptExpr?:string,{open=true}={}){
 return p?` AND EXISTS(SELECT 1 FROM generation_workers pf WHERE pf.id=? AND json_extract(pf.metadata_json,'$.fingerprint')=?${open?" AND json_extract(pf.metadata_json,'$.status')='open'":''}${attemptExpr?` AND EXISTS(SELECT 1 FROM json_each(pf.metadata_json,'$.allocations') pa WHERE json_extract(pa.value,'$.attemptId')=${attemptExpr})`:''})`:" AND NOT EXISTS(SELECT 1 FROM generation_workers WHERE id GLOB 'owner-pilot:*')";
}
const pilotArgs=(p:PilotState|null)=>p?[p.id,p.fingerprint]:[];
function assertPilotAttempt(p:PilotState|null,a:any){if(p&&(!a||a.owner_id!==p.policy.ownerId||a.provider!=='ark'||a.model!=='doubao-seedream-5-0-pro-260628'||a.budget_currency!=='CNY'||a.ordinal!==1||!Object.values(p.allocations).some(v=>v.attemptId===a.id&&v.slotId===a.slot_id)))throw pilotError()}

function webScope(e:Cloudflare.Env){try{return e.PORTRAIT_WEB_TEST_SCOPE===undefined?null:parseWebTestScope(e.PORTRAIT_WEB_TEST_SCOPE)}catch{throw new ApiError(409,'本轮授权范围无效')}}
const scopeError=()=>new ApiError(409,'本轮授权已关闭、位置顺序或冻结证据已变化');
const scopeWorkerId=(s:WebSixScope)=>'web-six:'+s.grantId;
async function scopedState(db:D1Database,e:Cloudflare.Env,{open=false,initialize=false}={}){
 const scope=webScope(e);if(!scope)return null;
 try{
  const config=generationBudgetConfig(e);if(!config||config.currency!=='CNY'||config.limitMicro!==scope.baselineCnyMicro+6000000||config.perCallMicro!==1000000||e.PORTRAIT_MODEL!=='doubao-seedream-5-0-pro-260628'||e.PORTRAIT_PROVIDER!=='ark')throw Error();
  const ids=scope.slots.map(p=>p.slotId),marks=ids.map(()=>'?').join(',');
  const slots=(await db.prepare(`SELECT * FROM generation_slots WHERE id IN (${marks})`).bind(...ids).all<any>()).results;
  if(slots.length!==6)throw Error();for(const g of slots){await assertScopeSlot(scope,g);const photo=frozenPhotography(g.template_json,g.prompt_version);if(photo?.inputPolicy!=='person-only'||photo.watermark!==false)throw Error()}
  const attempts=(await db.prepare(`SELECT * FROM generation_attempts WHERE slot_id IN (${marks})`).bind(...ids).all<any>()).results;
  if(attempts.length>6||new Set(attempts.map(a=>a.slot_id)).size!==attempts.length)throw Error();for(const a of attempts)assertScopeAttempt(scope,a);
  const old=(await db.prepare(`SELECT r.attempt_id,r.reserved_micro,r.currency,r.created_at FROM generation_cost_reservations r WHERE r.currency='CNY' AND NOT EXISTS(SELECT 1 FROM generation_attempts a WHERE a.id=r.attempt_id AND a.slot_id IN (${marks})) ORDER BY r.attempt_id`).bind(...ids).all<any>()).results;
  if(old.reduce((n,r)=>n+r.reserved_micro,0)!==scope.baselineCnyMicro||await reservationFingerprint(old)!==scope.baselineFingerprint)throw Error();
  const reservations=(await db.prepare(`SELECT r.* FROM generation_cost_reservations r JOIN generation_attempts a ON a.id=r.attempt_id WHERE a.slot_id IN (${marks})`).bind(...ids).all<any>()).results;
  if(reservations.some(r=>r.currency!=='CNY'||r.reserved_micro!==1000000)||reservations.length>6)throw Error();
  const fingerprint=await scopeFingerprint(scope);
  if(initialize)await db.prepare('INSERT OR IGNORE INTO generation_workers(id,ready_until,metadata_json) VALUES(?,?,?)').bind(scopeWorkerId(scope),'',JSON.stringify({fingerprint,status:scope.status})).run();
  const row=await db.prepare('SELECT metadata_json FROM generation_workers WHERE id=?').bind(scopeWorkerId(scope)).first<{metadata_json:string}>();
  const fence=row?JSON.parse(row.metadata_json):null;if(fence?.fingerprint!==fingerprint||!['open','closed'].includes(fence?.status))throw Error();
  const status=scope.status==='closed'||fence.status==='closed'?'closed':'open';if(open&&status!=='open')throw Error();
  return {scope,attempts,status,reservations,fingerprint};
 }catch{throw scopeError()}
}
function previousSlots(state:any,slotId?:string){return state&&slotId?state.scope.slots.slice(0,state.scope.slots.findIndex((p:any)=>p.slotId===slotId)).map((p:any)=>p.slotId):[]}
function fenceSql(state:any,slotId?:string){
 if(!state)return '';const previous=previousSlots(state,slotId);
 return " AND EXISTS(SELECT 1 FROM generation_workers fence WHERE fence.id=? AND json_extract(fence.metadata_json,'$.fingerprint')=? AND json_extract(fence.metadata_json,'$.status')='open')"+(previous.length?` AND (SELECT COUNT(*) FROM generation_attempts predecessor WHERE predecessor.owner_id=? AND predecessor.ordinal=1 AND predecessor.status IN ('succeeded','failed','needs_reconciliation') AND predecessor.slot_id IN (${previous.map(()=>'?').join(',')}))=${previous.length}`:'');
}
const fenceArgs=(state:any,slotId?:string)=>state?[scopeWorkerId(state.scope),state.fingerprint,...(previousSlots(state,slotId).length?[state.scope.ownerId,...previousSlots(state,slotId)]:[])]:[];
async function scopedAttempt(db:D1Database,e:Cloudflare.Env,a:any,{open=false}={}){
 const pilot=await pilotState(db,e,{open});assertPilotAttempt(pilot,a);
 const state=await scopedState(db,e,{open});if(state){try{assertScopeAttempt(state.scope,a);const p=scopeSlot(state.scope,a.slot_id);if(a.session_id!==p.sessionId)throw Error()}catch{throw scopeError()}}return state;
}
function workerMatches(metadata:any,e:Cloudflare.Env){
 const config=generationBudgetConfig(e);
 return !!config&&metadata?.provider===e.PORTRAIT_PROVIDER&&metadata?.model===e.PORTRAIT_MODEL&&metadata?.budgetCurrency===config.currency&&Array.isArray(metadata?.supportedAspectRatios)&&Number.isInteger(metadata?.maxImages)&&metadata.maxImages>0&&(e.PORTRAIT_PROVIDER!=='ark'||(metadata.supportedAspectRatios.includes('3:4')&&metadata.maxImages>=9));
}
export async function generationCapability(db:D1Database,e:Cloudflare.Env,actor?:string|null):Promise<GenerationCapability>{
 if(e.PORTRAIT_EXECUTION_MODE!==undefined){
  const budget=await generationBudgetSummary(db,e),ready=hostedConfigured(e,actor);
  // Existing durable pilot fences are still authoritative; a mode switch cannot erase them.
  await pilotState(db,e);
  const configured=ready&&!!budget&&budget.remainingMicro>=budget.perCallMicro;
  return {configured,mode:configured?'api-ready':'disabled',model:ready?e.PORTRAIT_MODEL!:null,budget,executionMode:'server-stream-v1',requiresChargeConsent:true,eligibleStyleIds:ready?['M01','M02','M03','F01','F02','F04']:[],message:e.PORTRAIT_GENERATION_ENABLED!=='true'?'当前已暂停新增生成。原任务和作品仍可查看，检查已保存图片免费。':configured?'生成入口已开启。每张需确认最多预留 1 元；成片与实际账单分别核对。':ready&&budget?'剩余模型预算不足。原任务、费用记录和已保存作品仍可查看。':'当前账号无生成授权或模型配置未完成，已有作品仍可查看。'};
 }
 const pilot=await pilotState(db,e);const c=capability(e),budget=await generationBudgetSummary(db,e);
 if(pilot){const eligibleStyleIds=actor===undefined||actor===pilot.policy.ownerId?pilot.policy.styleIds.filter((id:string)=>!pilot.allocations[id]):[];Object.assign(c,{eligibleStyleIds});if(pilot.status!=='open'||actor!==undefined&&(actor!==pilot.policy.ownerId||!eligibleStyleIds.length))return {...c,budget,configured:false,mode:'disabled',message:'本轮仅限获准账号的蓝幕商务、暖调杂志各一张；已有结果可继续恢复和下载。'}}
 if(!c.configured)return {...c,...(budget?{budget}:{})};
 const scope=webScope(e);if(scope){const fence=await db.prepare('SELECT metadata_json FROM generation_workers WHERE id=?').bind(scopeWorkerId(scope)).first<{metadata_json:string}>();let status;try{status=JSON.parse(fence?.metadata_json??'null')?.status}catch{}if(scope.status==='closed'||status==='closed')return {...c,budget,configured:false,mode:'disabled',message:'本轮已关闭；已有结果恢复和下载仍可使用。'}}
 const worker=await db.prepare("SELECT metadata_json FROM generation_workers WHERE id='local' AND ready_until>?").bind(now()).first<{metadata_json:string}>();
 let metadata;try{metadata=JSON.parse(worker?.metadata_json??'null')}catch{}
 if(!workerMatches(metadata,e))return {...c,budget,configured:false,mode:'degraded',message:'执行器未就绪或模型配置不一致，暂不可自动生成。已有作品可继续查看。'};
 if(!budget||budget.remainingMicro<budget.perCallMicro)return {...c,budget,configured:false,mode:'degraded',message:'本地测试预算已用完，已停止新增模型调用；已有结果保存恢复和下载不受影响。'};
 return {...c,budget};
}
export function workerContext(request:Request,e:Cloudflare.Env){
 const secret=e.PORTRAIT_WORKER_SECRET;if(!secret||secret.length<32||!e.DB||!e.BUCKET)throw new ApiError(503,'生成执行器尚未配置');
 const auth=request.headers.get('authorization')??'',want=`Bearer ${secret}`;let diff=auth.length^want.length;for(let i=0;i<want.length;i++)diff|=(auth.charCodeAt(i)||0)^want.charCodeAt(i);if(diff)throw new ApiError(401,'执行器认证失败');
 // Browser-originated requests may not use the service authority, even on the same origin.
 if(request.headers.has('origin')||request.headers.get('sec-fetch-site'))throw new ApiError(403,'服务接口不接受浏览器请求');
 return {db:e.DB,bucket:e.BUCKET};
}
const activeSql=`SELECT a.*,g.session_id,g.job_id,g.references_json,g.template_json,g.prompt,g.prompt_version,s.status session_status FROM generation_attempts a JOIN generation_slots g ON g.id=a.slot_id AND g.owner_id=a.owner_id JOIN portrait_sessions s ON s.id=g.session_id AND s.owner_id=a.owner_id JOIN jobs j ON j.id=g.job_id AND j.owner_id=a.owner_id WHERE a.id=? AND a.lease_token=? AND a.lease_expires_at>? AND a.status IN ('leased','dispatched') AND s.status!='cancelled' AND j.deletion_token IS NULL AND j.status!='completed' AND NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=a.owner_id) AND NOT EXISTS(SELECT 1 FROM orders WHERE job_id=g.job_id AND payment_status!='cancelled')`;
export async function activeAttempt(db:D1Database,id:unknown,token:unknown){const a=await db.prepare(activeSql).bind(string(id,100),string(token,100),now()).first<any>();if(!a)throw new ApiError(409,'生成租约已失效或任务已取消');return a}
export async function recoverAttempts(db:D1Database,e:Cloudflare.Env={}){
 const pilot=await pilotState(db,e);if(pilot){const stamp=now();await db.batch([db.prepare(`UPDATE generation_attempts SET status='failed',lease_expires_at=NULL,error='本轮位置已使用，不补抽',finished_at=?,updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE status='leased' AND lease_expires_at<=?${pilotFence(pilot,'generation_attempts.id',{open:false})}`).bind(stamp,stamp,stamp,...pilotArgs(pilot)),db.prepare(`UPDATE generation_attempts SET status='needs_reconciliation',lease_expires_at=NULL,error='调用结果待核对，不重复生成',updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE status='dispatched' AND lease_expires_at<=?${pilotFence(pilot,'generation_attempts.id',{open:false})}`).bind(stamp,stamp,...pilotArgs(pilot))]);return}
 const scope=webScope(e);if(scope){const ids=scope.slots.map(p=>p.slotId),marks=ids.map(()=>'?').join(','),stamp=now();await db.batch([db.prepare(`UPDATE generation_attempts SET status='failed',lease_expires_at=NULL,error='执行进程已停止，本位置不补抽',finished_at=?,updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE status='leased' AND lease_expires_at<=? AND owner_id=? AND ordinal=1 AND slot_id IN (${marks})`).bind(stamp,stamp,stamp,scope.ownerId,...ids),db.prepare(`UPDATE generation_attempts SET status='needs_reconciliation',lease_expires_at=NULL,error='调用结果待核对，不重复生成',updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE status='dispatched' AND lease_expires_at<=? AND owner_id=? AND ordinal=1 AND slot_id IN (${marks})`).bind(stamp,stamp,scope.ownerId,...ids)]);return}

 const stamp=now();
 await db.batch([
 db.prepare("UPDATE generation_attempts SET status='queued',lease_token=NULL,lease_expires_at=NULL,updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE status='leased' AND lease_expires_at<=?").bind(stamp,stamp),
 // Keep the immutable dispatch proof. Unknown outcomes never become paid retries by time alone.
 db.prepare("UPDATE generation_attempts SET status='needs_reconciliation',lease_expires_at=NULL,error='调用结果待核对；已有本地结果会恢复保存，请勿重复生成',updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE status='dispatched' AND lease_expires_at<=?").bind(stamp,stamp)]);
}
const recoverSql=`SELECT a.*,g.session_id,g.job_id,g.template_json,g.prompt_version,g.references_json,s.status session_status,j.status job_status,j.deletion_token,
 EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=a.owner_id) privacy_locked,
 EXISTS(SELECT 1 FROM orders WHERE job_id=g.job_id AND payment_status!='cancelled') has_order
 FROM generation_attempts a JOIN generation_slots g ON g.id=a.slot_id AND g.owner_id=a.owner_id
 JOIN portrait_sessions s ON s.id=g.session_id AND s.owner_id=a.owner_id
 JOIN jobs j ON j.id=g.job_id AND j.owner_id=a.owner_id WHERE a.id=?`;
function revoked(a:any){return !a||a.session_status==='cancelled'||a.deletion_token||a.privacy_locked||a.has_order}
function proofMatches(a:any,token:string){return token.length>0&&(a.recovery_token===token||a.lease_token===token)}
async function storedReceipt(db:D1Database,a:any,hash:string){
 if(a.output_hash!==hash)throw new ApiError(409,'恢复结果与已存证据不一致');
 const asset=await db.prepare('SELECT e.asset_id FROM generation_evidence e JOIN assets x ON x.id=e.asset_id AND x.owner_id=e.owner_id WHERE e.attempt_id=? AND e.owner_id=?').bind(a.id,a.owner_id).first<{asset_id:string}>();
 return asset?{state:'stored' as const,assetId:asset.asset_id}:{state:'revoked' as const};
}
export async function recoverWorkerOutput(db:D1Database,input:any,e:Cloudflare.Env={},selection?:HostedSelection){
 const id=string(input.attemptId,100),token=string(input.leaseToken,100),hash=string(input.outputHash,100),model=string(input.model,200);
 if(!/^[a-f0-9]{64}$/.test(hash)||!token||!model)throw new ApiError(400,'恢复凭据无效');
 const a=await db.prepare(recoverSql).bind(id).first<any>();const pilot=await pilotState(db,e);if(webScope(e)||pilot){if(!a)throw scopeError();await scopedAttempt(db,e,a)}if(selection&&a&&(a.owner_id!==selection.ownerId||a.session_id!==selection.sessionId||a.slot_id!==selection.slotId))throw new ApiError(403,'恢复位置不一致');if(revoked(a))return {state:'revoked'};
 if(!proofMatches(a,token)||a.model!==model)throw new ApiError(409,'恢复凭据与原调用不一致');
 if(a.status==='succeeded')return storedReceipt(db,a,hash);
 if(a.job_status==='completed'||!['dispatched','needs_reconciliation'].includes(a.status))return {state:'revoked'};
 const cost=await db.prepare('SELECT attempt_id FROM generation_cost_reservations WHERE attempt_id=? AND currency=?').bind(id,a.budget_currency).first();
 if(!cost||!a.recovery_token)throw new ApiError(409,'原调用预算凭据缺失');
 const stamp=now(),leaseToken=crypto.randomUUID(),leaseExpiresAt=new Date(Date.now()+LEASE_MS).toISOString();
 const r=await db.prepare(`UPDATE generation_attempts SET status='dispatched',lease_token=?,lease_expires_at=?,updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')),error=NULL WHERE id=? AND recovery_token=? AND status IN ('dispatched','needs_reconciliation')${selection?" AND (status='needs_reconciliation' OR lease_expires_at IS NULL OR lease_expires_at<=?)":''} AND EXISTS(SELECT 1 FROM generation_slots g JOIN portrait_sessions s ON s.id=g.session_id AND s.owner_id=g.owner_id JOIN jobs j ON j.id=g.job_id AND j.owner_id=g.owner_id WHERE g.id=generation_attempts.slot_id AND g.owner_id=generation_attempts.owner_id AND s.status!='cancelled' AND j.status!='completed' AND j.deletion_token IS NULL AND NOT EXISTS(SELECT 1 FROM orders WHERE job_id=j.id AND payment_status!='cancelled')) AND NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=generation_attempts.owner_id)`).bind(leaseToken,leaseExpiresAt,stamp,id,a.recovery_token,...(selection?[stamp]:[])).run();
 if(!r.meta.changes)return {state:selection?'busy':'revoked'};return {state:'resume',leaseToken,leaseExpiresAt};
}
export type HostedSelection={ownerId:string;sessionId:string;slotId:string};
export type HostedConsent=HostedSelection&{chargeConsentVersion:'model-charge-v1';maxCostMicro:1000000;consentedAt:string};
const hostedConsents=new WeakSet<object>();
export function hostedConfigured(e:Cloudflare.Env,owner?:string|null){
 const b=generationBudgetConfig(e),owners=e.PORTRAIT_GENERATION_OWNER_IDS?.split(',').map(s=>s.trim()).filter(Boolean)??[];
 return e.PORTRAIT_EXECUTION_MODE==='server-stream-v1'&&!!owner&&owners.includes(owner)&&e.PORTRAIT_PROVIDER==='ark'&&e.PORTRAIT_MODEL==='doubao-seedream-5-0-pro-260628'&&b?.currency==='CNY'&&b.perCallMicro===1000000&&e.PORTRAIT_WEB_TEST_SCOPE===undefined&&e.PORTRAIT_GENERATION_PILOT_JSON===undefined&&createImageProvider(e).ready;
}
export async function authorizeHostedRecovery(db:D1Database,e:Cloudflare.Env,owner:string,sessionId:string,input:any):Promise<HostedSelection>{
 if(e.PORTRAIT_EXECUTION_MODE!=='server-stream-v1'||!e.PORTRAIT_GENERATION_OWNER_IDS?.split(',').map(s=>s.trim()).includes(owner))throw new ApiError(403,'当前账号未获恢复授权');
 const slotId=string(input.slotId,100);await sessionRecord(db,owner,sessionId);
 if(!await db.prepare('SELECT id FROM generation_slots WHERE id=? AND session_id=? AND owner_id=?').bind(slotId,sessionId,owner).first())throw new ApiError(404,'生成位置不存在');
 return {ownerId:owner,sessionId,slotId};
}
export async function authorizeHostedExecution(db:D1Database,e:Cloudflare.Env,owner:string,sessionId:string,input:any):Promise<HostedConsent>{
 if(!hostedConfigured(e,owner))throw new ApiError(403,'当前账号或网站生成配置未获授权');
 if(input.chargeConsentVersion!=='model-charge-v1'||input.maxCostMicro!==1000000)throw new ApiError(400,'请确认本次每张最高 1 元模型费用');
 const slotId=string(input.slotId,100);if(!slotId)throw new ApiError(400,'请选择生成位置');
 await sessionRecord(db,owner,sessionId);
 const g=await db.prepare('SELECT * FROM generation_slots WHERE id=? AND session_id=? AND owner_id=?').bind(slotId,sessionId,owner).first<any>();if(!g)throw new ApiError(404,'生成位置不存在');
 const p=frozenPhotography(g.template_json,g.prompt_version),refs=JSON.parse(g.references_json);
 if(g.prompt_version!==SIX_TEMPLATE_PROMPT_VERSION||p?.inputPolicy!=='person-only'||p.watermark!==false||p.outputAspectRatio!=='3:4'||p.model!==e.PORTRAIT_MODEL||!Array.isArray(refs)||refs.length<1||refs.length>3||refs.filter((r:any)=>r.role==='anchor').length!==1||new Set(refs.map((r:any)=>r.id)).size!==refs.length||refs.some((r:any)=>!['anchor','angle','expression','proportion'].includes(r.role)))throw new ApiError(409,'请重新创建使用本人原照的六款创作');
 const proof:HostedConsent={ownerId:owner,sessionId,slotId,chargeConsentVersion:'model-charge-v1',maxCostMicro:1000000,consentedAt:now()};hostedConsents.add(proof);return proof;
}
function validHostedConsent(c:HostedConsent|undefined,owner:string,session:string,slot:unknown){return !!c&&hostedConsents.has(c)&&c.ownerId===owner&&c.sessionId===session&&c.slotId===slot}
function hostedAttemptConsent(a:any,selection:HostedSelection){let c;try{c=JSON.parse(a.metadata_json)?.chargeConsent}catch{};return c?.ownerId===selection.ownerId&&c?.sessionId===selection.sessionId&&c?.slotId===selection.slotId&&c?.chargeConsentVersion==='model-charge-v1'&&c?.maxCostMicro===1000000&&typeof c?.consentedAt==='string'}
export async function queueSession(db:D1Database,owner:string,id:string,e:Cloudflare.Env,slotId?:unknown,consent?:HostedConsent){
 if(e.PORTRAIT_EXECUTION_MODE!==undefined&&!validHostedConsent(consent,owner,id,slotId))throw new ApiError(403,'请通过网站费用确认后开始生成');
 const pilot=await pilotState(db,e,{open:true});if(pilot&&owner!==pilot.policy.ownerId)throw new ApiError(403,'本轮仅限获准账号生成');
 const state=await scopedState(db,e,{open:true});if(state){try{if(owner!==state.scope.ownerId)throw Error();const selected=slotId?[scopeSlot(state.scope,slotId)]:state.scope.slots.filter(p=>p.sessionId===id);if(!selected.length||selected.some(p=>p.sessionId!==id))throw Error();for(const p of selected){if(state.attempts.some(a=>a.slot_id===p.slotId))throw Error()}}catch{throw scopeError()}}
 const s=await sessionRecord(db,owner,id);if(pilot&&s.created_at<pilot.policy.startsAt)throw new ApiError(403,'本轮仅限授权后新建任务');if(s.status==='cancelled')throw new ApiError(409,'创作已取消');
 if(!await db.prepare("SELECT j.id FROM jobs j JOIN portrait_session_jobs sj ON sj.job_id=j.id WHERE sj.session_id=? AND sj.owner_id=? AND j.status!='completed' LIMIT 1").bind(id,owner).first())throw new ApiError(409,'创作已完成，无需再次生成');
 if(!(await generationCapability(db,e,e.PORTRAIT_EXECUTION_MODE!==undefined?owner:undefined)).configured)throw new ApiError(503,'自动生成尚未就绪，请使用真实工具创作后导入');
 await recoverAttempts(db,e);
 const slots=(await db.prepare('SELECT * FROM generation_slots WHERE session_id=? AND owner_id=?'+(slotId?' AND id=?':'')).bind(id,owner,...(slotId?[string(slotId,100)]:[])).all<any>()).results;
 if(!slots.length)throw new ApiError(404,'生成位置不存在');
 if(state){try{for(const g of slots)await assertScopeSlot(state.scope,g)}catch{throw scopeError()}}
 if(pilot&&slots.some(g=>!pilot.policy.styleIds.includes(g.style_id)||g.prompt_version!==SIX_TEMPLATE_PROMPT_VERSION||g.created_at<pilot.policy.startsAt))throw new ApiError(403,'本轮仅限蓝幕商务、暖调杂志各一张');
 const budget=generationBudgetConfig(e)!;
 for(const g of slots){const photography=frozenPhotography(g.template_json,g.prompt_version);if(photography?.model&&photography.model!==e.PORTRAIT_MODEL)throw new ApiError(409,'本组已冻结 Pro 模型，当前执行器不匹配');const attemptId=pilot&&pilot.allocations[g.style_id]?.slotId===g.id?pilot.allocations[g.style_id].attemptId:crypto.randomUUID();const statements=[];
 if(pilot)statements.push(db.prepare(`UPDATE generation_workers SET metadata_json=json_set(metadata_json,?,json(?)) WHERE id=? AND json_extract(metadata_json,'$.fingerprint')=? AND json_extract(metadata_json,'$.status')='open' AND json_extract(metadata_json,?) IS NULL AND (SELECT COUNT(*) FROM json_each(metadata_json,'$.allocations'))<2 AND EXISTS(SELECT 1 FROM generation_slots g JOIN portrait_sessions s ON s.id=g.session_id WHERE g.id=? AND g.owner_id=? AND s.owner_id=? AND g.created_at>=? AND s.created_at>=? AND g.style_id=? AND g.prompt_version='portrait-six-v1' AND s.status!='cancelled') AND NOT EXISTS(SELECT 1 FROM generation_attempts WHERE slot_id=?)`).bind('$.allocations.'+g.style_id,JSON.stringify({slotId:g.id,attemptId}),pilot.id,pilot.fingerprint,'$.allocations.'+g.style_id,g.id,owner,owner,pilot.policy.startsAt,pilot.policy.startsAt,g.style_id,g.id));
 statements.push(db.prepare(`INSERT INTO generation_attempts(id,slot_id,owner_id,ordinal,status,provider,model,budget_currency,created_at,updated_at,metadata_json) SELECT ?,?,?,COALESCE((SELECT MAX(ordinal) FROM generation_attempts WHERE slot_id=?),0)+1,'queued',?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM portrait_sessions WHERE id=? AND owner_id=? AND status!='cancelled') AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND owner_id=? AND status!='completed' AND deletion_token IS NULL) AND NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=?) AND NOT EXISTS(SELECT 1 FROM orders WHERE job_id=? AND payment_status!='cancelled') AND NOT EXISTS(SELECT 1 FROM generation_attempts WHERE slot_id=?${state||pilot||consent?'':" AND status IN ('queued','leased','dispatched','needs_reconciliation')"}) AND NOT EXISTS(SELECT 1 FROM assets WHERE id=? AND qa='accepted') AND NOT EXISTS(SELECT 1 FROM generation_evidence e JOIN assets a ON a.id=e.asset_id WHERE e.slot_id=? AND a.qa='not-assessed') AND (SELECT COUNT(*) FROM assets WHERE job_id=? AND kind='result')<(SELECT count FROM jobs WHERE id=?)${fenceSql(state)}${pilotFence(pilot,'?')}`).bind(attemptId,g.id,owner,g.id,e.PORTRAIT_PROVIDER!,e.PORTRAIT_MODEL!,budget.currency,now(),now(),consent?JSON.stringify({chargeConsent:consent}):null,id,owner,g.job_id,owner,owner,g.job_id,g.id,g.candidate_asset_id,g.id,g.job_id,g.job_id,...fenceArgs(state),...pilotArgs(pilot),...(pilot?[attemptId]:[])));await db.batch(statements);if(pilot){const current=await pilotState(db,e);if(current?.allocations[g.style_id]?.slotId!==g.id)throw pilotError()}}
}
export async function handleWorker(db:D1Database,e:Cloudflare.Env,input:any,selection?:HostedSelection){
 if(e.PORTRAIT_EXECUTION_MODE!==undefined&&['register','claim','dispatch'].includes(input.action)&&(!selection||!hostedConfigured(e,selection.ownerId)))throw new ApiError(403,'网站生成仅接受已确认的本人请求');
 const pilot=await pilotState(db,e,{initialize:input.action==='register',open:['claim','dispatch'].includes(input.action)});
 if(pilot&&input.action==='close-grant'){if(input.grantId!==pilot.policy.grantId)throw pilotError();await db.prepare("UPDATE generation_workers SET metadata_json=json_set(metadata_json,'$.status','closed') WHERE id=? AND json_extract(metadata_json,'$.fingerprint')=?").bind(pilot.id,pilot.fingerprint).run();return {ok:true}}
 const state=await scopedState(db,e,{initialize:input.action==='register',open:['register','claim','dispatch'].includes(input.action)});
 if(input.action==='batch-status'){
  if(!state||input.grantId!==state.scope.grantId)throw scopeError();
  const assets=(await db.prepare(`SELECT e.attempt_id,e.asset_id FROM generation_evidence e JOIN assets x ON x.id=e.asset_id AND x.owner_id=e.owner_id JOIN generation_slots g ON g.id=e.slot_id AND g.owner_id=e.owner_id JOIN portrait_sessions s ON s.id=g.session_id AND s.owner_id=e.owner_id JOIN jobs j ON j.id=g.job_id AND j.owner_id=e.owner_id WHERE e.owner_id=? AND e.slot_id IN (${state.scope.slots.map(()=>'?').join(',')}) AND s.status!='cancelled' AND j.deletion_token IS NULL AND NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=e.owner_id) AND NOT EXISTS(SELECT 1 FROM orders WHERE job_id=g.job_id AND payment_status!='cancelled')`).bind(state.scope.ownerId,...state.scope.slots.map(p=>p.slotId)).all<{attempt_id:string;asset_id:string}>()).results;
  return {grantId:state.scope.grantId,status:state.status,attempts:state.attempts.map(a=>({attemptId:a.id,slotId:a.slot_id,ordinal:a.ordinal,status:a.status,reservedMicro:a.reserved_micro,outputHash:a.output_hash,metadata:a.metadata_json?JSON.parse(a.metadata_json):null,...(a.status==='succeeded'?{assetId:assets.find(x=>x.attempt_id===a.id)?.asset_id}:{})})),budget:await generationBudgetSummary(db,e)};
 }
 if(input.action==='close-grant'){if(!state||input.grantId!==state.scope.grantId)throw scopeError();await db.batch([db.prepare("UPDATE generation_workers SET ready_until='',metadata_json=json_set(metadata_json,'$.status','closed') WHERE id=?").bind(scopeWorkerId(state.scope)),db.prepare("UPDATE generation_workers SET ready_until='' WHERE id='local' AND json_extract(metadata_json,'$.grantId')=?").bind(state.scope.grantId)]);return {ok:true}}
 if(input.action==='register'){
  if(!capability(e).configured||input.adapterReady!==true||!workerMatches(input,e))throw new ApiError(503,'服务适配器型号、输入能力或预算币种不匹配');
  const metadata={provider:input.provider,model:input.model,budgetCurrency:input.budgetCurrency,supportedAspectRatios:input.supportedAspectRatios,maxImages:input.maxImages,...(state?{grantId:state.scope.grantId}:{})};
  await db.prepare("INSERT INTO generation_workers(id,ready_until,metadata_json) VALUES('local',?,?) ON CONFLICT(id) DO UPDATE SET ready_until=excluded.ready_until,metadata_json=excluded.metadata_json").bind(new Date(Date.now()+LEASE_MS).toISOString(),JSON.stringify(metadata)).run();return {ok:true};
 }
 if(input.action==='recover')return recoverWorkerOutput(db,input,e,selection);
 if(input.action==='claim'){
  let expected:any=null;if(state){try{if(input.grantId!==state.scope.grantId)throw Error();expected=assertScopeOrder(state.scope,input.slotId,state.attempts,{existing:true});const a=state.attempts.find(a=>a.slot_id===expected.slotId);if(a.status!=='queued')throw Error()}catch{throw scopeError()}}
  await recoverAttempts(db,e);
  const available=await generationCapability(db,e,selection?.ownerId);if(!available.configured){
   if(!selection&&!pilot&&available.budget&&available.budget.remainingMicro<available.budget.perCallMicro)await db.prepare(`UPDATE generation_attempts SET status='failed',error='本地测试预算不足，未调用模型；请保留已有作品',finished_at=?,updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE status='queued'${state?' AND owner_id=? AND slot_id IN ('+state.scope.slots.map(()=>'?').join(',')+')':''}`).bind(now(),now(),...(state?[state.scope.ownerId,...state.scope.slots.map(p=>p.slotId)]:[])).run();
   return {claim:null};
  }
  const stamp=now(),token=crypto.randomUUID(),expires=new Date(Date.now()+LEASE_MS).toISOString();
  const a=await db.prepare(`UPDATE generation_attempts SET status='leased',lease_token=?,lease_expires_at=?,updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE id=(SELECT a.id FROM generation_attempts a JOIN generation_slots g ON g.id=a.slot_id JOIN portrait_sessions s ON s.id=g.session_id JOIN jobs j ON j.id=g.job_id WHERE a.status='queued' ${selection?" AND a.owner_id=? AND g.owner_id=? AND s.owner_id=? AND j.owner_id=? AND g.session_id=? AND a.slot_id=? AND json_extract(a.metadata_json,'$.chargeConsent.ownerId')=a.owner_id AND json_extract(a.metadata_json,'$.chargeConsent.sessionId')=g.session_id AND json_extract(a.metadata_json,'$.chargeConsent.slotId')=a.slot_id AND json_extract(a.metadata_json,'$.chargeConsent.chargeConsentVersion')='model-charge-v1' AND json_extract(a.metadata_json,'$.chargeConsent.maxCostMicro')=1000000":''} ${pilotFence(pilot,'a.id')} ${state?' AND a.slot_id=? AND a.owner_id=? AND a.ordinal=1':''} AND s.status!='cancelled' AND j.deletion_token IS NULL AND j.status!='completed' AND NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=a.owner_id) AND NOT EXISTS(SELECT 1 FROM orders WHERE job_id=g.job_id AND payment_status!='cancelled') AND (SELECT COUNT(*) FROM assets WHERE job_id=g.job_id AND kind='result')<j.count ORDER BY a.created_at,a.id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM generation_attempts WHERE status IN ('leased','dispatched') AND lease_expires_at>? ${state?' AND owner_id=? AND slot_id IN ('+state.scope.slots.map(()=>'?').join(',')+')':''})${fenceSql(state,expected?.slotId)} RETURNING *`).bind(token,expires,stamp,...(selection?[selection.ownerId,selection.ownerId,selection.ownerId,selection.ownerId,selection.sessionId,selection.slotId]:[]),...pilotArgs(pilot),...(state?[expected.slotId,state.scope.ownerId]:[]),stamp,...(state?[state.scope.ownerId,...state.scope.slots.map(p=>p.slotId)]:[]),...fenceArgs(state,expected?.slotId)).first<any>();
  if(!a)return {claim:null};const active=await activeAttempt(db,a.id,token);
  const photography=frozenPhotography(active.template_json,active.prompt_version);
  const claim:WorkerClaim={attemptId:a.id,leaseToken:token,leaseExpiresAt:expires,slotId:a.slot_id,prompt:active.prompt,promptVersion:active.prompt_version,...(photography?{outputAspectRatio:photography.outputAspectRatio,...(active.prompt_version===SIX_TEMPLATE_PROMPT_VERSION?{inputPolicy:photography.inputPolicy,watermark:photography.watermark}:{styleReference:photography.styleReference})}:{}),provider:a.provider,model:a.model,references:JSON.parse(active.references_json).map((r:any)=>({id:r.id,role:r.role,sha256:r.sha256,url:`/api/generation/worker/reference?attemptId=${encodeURIComponent(a.id)}&assetId=${encodeURIComponent(r.id)}`}))};return {claim};
 }
 const a=await activeAttempt(db,input.attemptId,input.leaseToken),stamp=now();if(selection&&(a.owner_id!==selection.ownerId||a.session_id!==selection.sessionId||a.slot_id!==selection.slotId||!hostedAttemptConsent(a,selection)))throw new ApiError(403,'生成位置与费用确认不一致');await scopedAttempt(db,e,a,{open:input.action==='dispatch'});if(state&&input.action==='dispatch'){try{assertScopeOrder(state.scope,a.slot_id,state.attempts,{existing:true})}catch{throw scopeError()}}
 if(input.action==='heartbeat'){
  const result=await db.prepare("UPDATE generation_attempts SET lease_expires_at=?,updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE id=? AND lease_token=? AND lease_expires_at>? AND status IN ('leased','dispatched')").bind(new Date(Date.now()+LEASE_MS).toISOString(),stamp,a.id,input.leaseToken,stamp).run();if(!result.meta.changes)throw new ApiError(409,'租约已失效');return {ok:true};
 }
 if(input.action==='dispatch'){
  const config=generationBudgetConfig(e);if(!capability(e).configured||!config||a.budget_currency!==config.currency||a.model!==e.PORTRAIT_MODEL||a.provider!==e.PORTRAIT_PROVIDER)throw new ApiError(503,'模型或授权预算已变化');
  frozenPhotography(a.template_json,a.prompt_version);
  const max=config.perCallMicro,budget=config.limitMicro,currency=config.currency;
  const r=await db.batch([
   db.prepare(`INSERT OR IGNORE INTO generation_cost_reservations(attempt_id,reserved_micro,currency,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM generation_attempts a JOIN generation_slots g ON g.id=a.slot_id JOIN portrait_sessions s ON s.id=g.session_id JOIN jobs j ON j.id=g.job_id WHERE a.id=? AND a.lease_token=? AND a.status='leased' AND a.lease_expires_at>? AND s.status!='cancelled' AND j.deletion_token IS NULL AND j.status!='completed' AND NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=a.owner_id)) AND COALESCE((SELECT SUM(reserved_micro) FROM generation_cost_reservations WHERE currency=?),0)+?<=?${fenceSql(state,a.slot_id)}${pilotFence(pilot,'?')}`).bind(a.id,max,currency,stamp,a.id,input.leaseToken,stamp,currency,max,budget,...fenceArgs(state,a.slot_id),...pilotArgs(pilot),...(pilot?[a.id]:[])),
   db.prepare(`UPDATE generation_attempts SET status='dispatched',recovery_token=COALESCE(recovery_token,lease_token),reserved_micro=?,dispatched_at=?,updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE id=? AND lease_token=? AND status='leased' AND lease_expires_at>? AND EXISTS(SELECT 1 FROM generation_cost_reservations WHERE attempt_id=generation_attempts.id AND currency=generation_attempts.budget_currency) AND EXISTS(SELECT 1 FROM generation_slots g JOIN portrait_sessions s ON s.id=g.session_id JOIN jobs j ON j.id=g.job_id WHERE g.id=generation_attempts.slot_id AND g.owner_id=generation_attempts.owner_id AND s.status!='cancelled' AND j.status!='completed' AND j.deletion_token IS NULL AND NOT EXISTS(SELECT 1 FROM orders WHERE job_id=j.id AND payment_status!='cancelled')) AND NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=generation_attempts.owner_id)${fenceSql(state,a.slot_id)}${pilotFence(pilot,'?')}`).bind(max,stamp,stamp,a.id,input.leaseToken,stamp,...fenceArgs(state,a.slot_id),...pilotArgs(pilot),...(pilot?[a.id]:[]))
  ]);if(!r[1].meta.changes)throw new ApiError(409,'预算不足、任务状态或租约已变化');return {ok:true};
 }
 if(input.action==='fail'){
  const uncertain=a.status==='dispatched';
  await db.prepare("UPDATE generation_attempts SET status=?,lease_token=CASE WHEN ?=1 THEN lease_token ELSE NULL END,lease_expires_at=NULL,error=?,finished_at=?,updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE id=? AND lease_token=? AND status IN ('leased','dispatched')").bind(uncertain?'needs_reconciliation':'failed',Number(uncertain),string(input.error||'生成未完成',500),uncertain?null:stamp,stamp,a.id,input.leaseToken).run();return {ok:true};
 }
 throw new ApiError(400,'未知执行操作');
}
export async function workerReference(db:D1Database,bucket:R2Bucket,url:URL,leaseToken:string|null,e:Cloudflare.Env={}){
 const a=await activeAttempt(db,url.searchParams.get('attemptId'),leaseToken),id=url.searchParams.get('assetId');await scopedAttempt(db,e,a);
 const ref=JSON.parse(a.references_json).find((r:any)=>r.id===id);if(!ref)throw new ApiError(404,'参考照不存在');
 const asset=await db.prepare("SELECT * FROM assets WHERE id=? AND owner_id=? AND kind='reference'").bind(id,a.owner_id).first<any>();if(!asset)throw new ApiError(404,'参考照不存在');const object=await bucket.get(asset.object_key);if(!object)throw new ApiError(404,'参考照文件不存在');
 return new Response(object.body,{headers:{'Content-Type':asset.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
export async function workerResult(request:Request,db:D1Database,bucket:R2Bucket,e:Cloudflare.Env={},hostedPendingKey?:string){
 const bytes=await readBoundedBody(request,11*1024*1024);let form:FormData;try{form=await new Response(bytes,{headers:{'Content-Type':request.headers.get('content-type')||''}}).formData()}catch{throw new ApiError(400,'结果上传格式无效')}
 const file=form.get('file');if(!(file instanceof File)||!file.size||file.size>10*1024*1024)throw new ApiError(400,'结果文件须小于 10MB');
 const output=new Uint8Array(await file.arrayBuffer());let image;try{image=inspectImage(output)}catch{throw new ApiError(400,'结果图片不可用')}
 if(image.mime!==file.type)throw new ApiError(400,'结果类型不匹配');let metadata:any;try{const raw=form.get('metadata');if(typeof raw!=='string'||raw.length>10000)throw Error();metadata=JSON.parse(raw);if(!metadata||typeof metadata.model!=='string'||Array.isArray(metadata))throw Error()}catch{throw new ApiError(400,'生成证据无效')}
 const hash=await sha256(output),proof=string(form.get('leaseToken'),100),prior=await db.prepare(recoverSql).bind(string(form.get('attemptId'),100)).first<any>();
 if(webScope(e)){if(!prior)throw scopeError();await scopedAttempt(db,e,prior);const p=scopeSlot(webScope(e)!,prior.slot_id);if(metadata.inputHashes?.length!==1||metadata.inputHashes[0]!==p.normalizedInputHash)throw scopeError()}
 {const pilot=await pilotState(db,e);assertPilotAttempt(pilot,prior)}
 if(prior)frozenPhotography(prior.template_json,prior.prompt_version);
 if(prior?.metadata_json){const proof=JSON.parse(prior.metadata_json)?.chargeConsent;if(proof)metadata.chargeConsent=proof}
 if(prior?.prompt_version===SIX_TEMPLATE_PROMPT_VERSION)validateSixResult(prior,metadata,image);
 if(prior?.status==='succeeded'&&!revoked(prior)&&proofMatches(prior,proof)&&metadata.model===prior.model){const receipt=await storedReceipt(db,prior,hash);if(receipt.state==='stored')return {assetId:receipt.assetId}}
 const a=await activeAttempt(db,form.get('attemptId'),form.get('leaseToken'));if(a.status!=='dispatched')throw new ApiError(409,'尚未派发生图请求');if(metadata.model!==a.model)throw new ApiError(400,'生成证据无效');
 if(a.prompt_version===SIX_TEMPLATE_PROMPT_VERSION)validateSixResult(a,metadata,image);
 const id=crypto.randomUUID(),key=`private/${a.owner_id}/${id}`;
 await reserveUpload(db,{key,owner:a.owner_id,size:file.size,kind:'generation_evidence',jobId:a.job_id});
 try{
  await bucket.put(key,output,{httpMetadata:{contentType:image.mime}});
  const commitStamp=now();
  const inserted=await db.batch([
   db.prepare(`INSERT INTO assets(id,owner_id,object_key,name,mime,size,kind,job_id,qa,source,created_at,consent_version,consented_at,consented_by,source_note) SELECT ?,?,?,?,?,?,'generation_evidence',?,'not-assessed','provider',?,j.consent_version,j.consented_at,?,'实际模型产物，待身份与画面检查' FROM jobs j JOIN generation_slots g ON g.job_id=j.id JOIN generation_attempts a ON a.slot_id=g.id JOIN portrait_sessions s ON s.id=g.session_id WHERE a.id=? AND a.owner_id=? AND a.lease_token=? AND a.lease_expires_at>? AND a.status='dispatched' AND s.status!='cancelled' AND j.deletion_token IS NULL AND j.status!='completed' AND NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=a.owner_id) AND NOT EXISTS(SELECT 1 FROM orders WHERE job_id=j.id AND payment_status!='cancelled') AND EXISTS(SELECT 1 FROM pending_uploads WHERE object_key=? AND cancelled=0 AND created_at>?)${hostedPendingKey?" AND EXISTS(SELECT 1 FROM pending_uploads hp WHERE hp.object_key=? AND hp.owner_id=a.owner_id AND hp.job_id=g.job_id AND hp.cancelled=0 AND hp.created_at>? AND NOT EXISTS(SELECT 1 FROM storage_deletions sd WHERE sd.object_key=hp.object_key))":''}`).bind(id,a.owner_id,key,'portrait.'+(image.mime==='image/png'?'png':image.mime==='image/jpeg'?'jpg':'webp'),image.mime,file.size,a.job_id,commitStamp,a.owner_id,a.id,a.owner_id,form.get('leaseToken'),commitStamp,key,new Date(Date.now()-PRIVACY_LEASE_MS).toISOString(),...(hostedPendingKey?[hostedPendingKey,new Date(Date.now()-PRIVACY_LEASE_MS).toISOString()]:[])),
   db.prepare('INSERT INTO generation_evidence(asset_id,attempt_id,slot_id,owner_id) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM assets WHERE id=? AND owner_id=?)').bind(id,a.id,a.slot_id,a.owner_id,id,a.owner_id),
   db.prepare("UPDATE generation_attempts SET status='succeeded',metadata_json=?,output_hash=?,finished_at=?,updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')),lease_expires_at=NULL WHERE id=? AND EXISTS(SELECT 1 FROM generation_evidence WHERE asset_id=? AND attempt_id=generation_attempts.id)").bind(JSON.stringify(metadata),hash,commitStamp,commitStamp,a.id,id),commitUpload(db,key,a.owner_id)]);
  if(!inserted[0].meta.changes)throw new ApiError(409,'任务已取消或生成租约失效');return {assetId:id};
 }catch(e){await abandonUpload(db,bucket,key,a.owner_id,file.size);throw e}
}
export async function reviewResult(db:D1Database,owner:string,sessionId:string,input:any){
 const note=string(input.note,500);if(!note||!['accepted','rejected'].includes(input.qa))throw new ApiError(400,'请填写真实检查结论');
 const a=await db.prepare(`SELECT a.*,e.slot_id FROM assets a JOIN portrait_session_jobs sj ON sj.job_id=a.job_id AND sj.owner_id=a.owner_id JOIN portrait_sessions s ON s.id=sj.session_id LEFT JOIN generation_evidence e ON e.asset_id=a.id WHERE a.id=? AND a.owner_id=? AND sj.session_id=? AND s.status!='cancelled'`).bind(string(input.assetId,100),owner,sessionId).first<any>();if(!a)throw new ApiError(404,'作品不存在');
 const editable=`EXISTS(SELECT 1 FROM portrait_session_jobs sj JOIN portrait_sessions s ON s.id=sj.session_id AND s.owner_id=sj.owner_id WHERE sj.job_id=assets.job_id AND sj.owner_id=assets.owner_id AND s.status!='cancelled') AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=assets.job_id AND j.owner_id=assets.owner_id AND j.status!='completed' AND j.deletion_token IS NULL) AND NOT EXISTS(SELECT 1 FROM orders WHERE job_id=assets.job_id AND payment_status!='cancelled') AND NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=assets.owner_id)`;
 if(!a.slot_id){const r=await db.batch([
  db.prepare(`INSERT INTO portrait_quality_reviews(id,asset_id,owner_id,decision,note,created_at) SELECT ?,id,owner_id,?,?,? FROM assets WHERE id=? AND owner_id=? AND kind='result' AND ${editable}`).bind(crypto.randomUUID(),input.qa,note,now(),a.id,owner),
  db.prepare(`UPDATE assets SET qa=? WHERE id=? AND owner_id=? AND kind='result' AND ${editable}`).bind(input.qa,a.id,owner)
 ]);if(!r[1].meta.changes)throw new ApiError(409,'已交付或正在清理，不能修改');return}
 const job=await db.prepare('SELECT * FROM jobs WHERE id=? AND owner_id=?').bind(a.job_id,owner).first<any>();if(!job||job.status==='completed'||job.deletion_token)throw new ApiError(409,'任务不可修改');
 // A per-slot compare-and-set, demotion and promotion run in one D1 transaction.
 const accepted=input.qa==='accepted';const batch=[
 db.prepare(`UPDATE assets SET kind='generation_evidence' WHERE id=(SELECT candidate_asset_id FROM generation_slots WHERE id=? AND owner_id=?) AND id!=? AND ${editable} AND ?=1 AND EXISTS(SELECT 1 FROM assets target WHERE target.id=? AND target.owner_id=?)`).bind(a.slot_id,owner,a.id,Number(accepted),a.id,owner),
 db.prepare(`UPDATE assets SET qa=?,kind=CASE WHEN ?=1 THEN 'result' ELSE 'generation_evidence' END WHERE id=? AND owner_id=? AND ${editable} AND (?=0 OR (SELECT COUNT(*) FROM assets other WHERE other.job_id=assets.job_id AND other.kind='result' AND other.id!=assets.id)<(SELECT count FROM jobs WHERE id=assets.job_id))`).bind(input.qa,Number(accepted),a.id,owner,Number(accepted)),
 db.prepare(`UPDATE generation_slots SET candidate_asset_id=CASE WHEN ?=1 THEN ? WHEN candidate_asset_id=? THEN NULL ELSE candidate_asset_id END WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM assets WHERE id=? AND qa=? AND kind=? AND ${editable})`).bind(Number(accepted),a.id,a.id,a.slot_id,owner,a.id,input.qa,accepted?'result':'generation_evidence'),
 db.prepare(`UPDATE generation_evidence SET review_note=?,reviewed_at=? WHERE asset_id=? AND owner_id=? AND EXISTS(SELECT 1 FROM assets WHERE id=generation_evidence.asset_id AND ${editable})`).bind(note,now(),a.id,owner),
 db.prepare(`INSERT INTO portrait_quality_reviews(id,asset_id,owner_id,decision,note,created_at) SELECT ?,id,owner_id,?,?,? FROM assets WHERE id=? AND owner_id=? AND qa=? AND ${editable}`).bind(crypto.randomUUID(),input.qa,note,now(),a.id,owner,input.qa),
 db.prepare(`UPDATE jobs SET status='review',updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE id=? AND owner_id=? AND status!='completed' AND deletion_token IS NULL AND EXISTS(SELECT 1 FROM assets WHERE id=? AND qa=? AND ${editable})`).bind(now(),a.job_id,owner,a.id,input.qa)];
 const r=await db.batch(batch);if(!r[1].meta.changes)throw new ApiError(409,'结果数量或任务状态已变化');
}

function validateSixResult(attempt:any,metadata:any,image:ReturnType<typeof inspectImage>){
 const photography=frozenPhotography(attempt.template_json,attempt.prompt_version),refs=JSON.parse(attempt.references_json);
 if(!photography||metadata.model!==photography.model||metadata.inputPolicy!==photography.inputPolicy||metadata.watermark!==false||metadata.outputAspectRatio!=='3:4'||metadata.styleReferenceHash!==undefined||!metadata.outputDimensions||metadata.outputDimensions.width!==image.width||metadata.outputDimensions.height!==image.height||image.width*4!==image.height*3||!Array.isArray(metadata.inputHashes)||metadata.inputHashes.length!==refs.length||metadata.inputHashes.some((hash:unknown)=>typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))throw new ApiError(400,'六款生成证据与冻结协议不一致');
}
