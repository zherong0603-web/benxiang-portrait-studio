import {SIX_TEMPLATE_PROMPT_VERSION,isSixTemplateId,compileSixPortraitPrompt} from './six-templates';
import {normalizeWardrobeByStyle,getCreationPhotography,frozenPhotography,SAMPLE_PROMPT_VERSION} from './photography-recipes';
import {styles,roles,compileProPortraitPrompt,PRO_PORTRAIT_PROMPT_VERSION,type Photo} from './portrait';
import {ApiError,assetUrl,hydratedJob,string} from './server';
import {generationBudgetConfig} from './generation-budget';
import {requirePortraitConsent,flushDeletions} from './privacy';
import type {CreationSession,CreationAction,GenerationCapability} from './creation-contract';
export const now=()=>new Date().toISOString();
export async function sha256(bytes:Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer))).map(x=>x.toString(16).padStart(2,'0')).join('')}
export function capability(e:Cloudflare.Env):GenerationCapability{
 const configured=e.PORTRAIT_GENERATION_ENABLED==='true'&&!!e.PORTRAIT_PROVIDER&&!!e.PORTRAIT_MODEL&&!!e.PORTRAIT_WORKER_SECRET&&e.PORTRAIT_WORKER_SECRET.length>=32&&!!generationBudgetConfig(e);
 return {configured,mode:configured?'api-ready':'manual-assisted',model:configured?e.PORTRAIT_MODEL!:null,message:configured?'已配置执行器；真实生成状态以任务记录为准。':'生成服务当前关闭。已保存的创作要求会保留，尚未开始调用模型。'};
}
export function positive(s:unknown){return typeof s==='string'&&/^\d+$/.test(s)&&Number.isSafeInteger(Number(s))?Number(s):0}
export async function sessionRecord(db:D1Database,owner:string,id:string){const s=await db.prepare('SELECT * FROM portrait_sessions WHERE id=? AND owner_id=?').bind(id,owner).first<any>();if(!s)throw new ApiError(404,'创作不存在');return s}
export async function getSession(db:D1Database,owner:string,id:string):Promise<CreationSession>{
 const s=await sessionRecord(db,owner,id);
 const rawJobs=(await db.prepare('SELECT j.* FROM jobs j JOIN portrait_session_jobs sj ON sj.job_id=j.id AND sj.owner_id=j.owner_id WHERE sj.session_id=? AND sj.owner_id=? ORDER BY sj.position').bind(id,owner).all<any>()).results;
 const jobs=await Promise.all(rawJobs.map(j=>hydratedJob(db,owner,j)));
 // Poll snapshots include state owned by jobs and attempts, whose writes do not
 // mutate the historical portrait_sessions timestamp.
 const attemptUpdate=await db.prepare('SELECT MAX(a.updated_at) updated_at FROM generation_attempts a JOIN generation_slots g ON g.id=a.slot_id AND g.owner_id=a.owner_id WHERE g.session_id=? AND a.owner_id=?').bind(id,owner).first<{updated_at:string|null}>();
 const updatedAt=[...rawJobs.map(j=>j.updated_at),attemptUpdate?.updated_at].reduce((latest,value)=>typeof value==='string'&&value>latest?value:latest,s.updated_at as string);
 const rawSlots=(await db.prepare(`SELECT g.*,a.id attempt_id,a.status attempt_status,a.error FROM generation_slots g JOIN portrait_session_jobs sj ON sj.session_id=g.session_id AND sj.job_id=g.job_id AND sj.owner_id=g.owner_id LEFT JOIN generation_attempts a ON a.id=(SELECT z.id FROM generation_attempts z WHERE z.slot_id=g.id ORDER BY z.ordinal DESC LIMIT 1) WHERE g.session_id=? AND g.owner_id=? ORDER BY sj.position,g.slot_index,g.id`).bind(id,owner).all<any>()).results;
 const rawResults=(await db.prepare(`SELECT a.id,a.job_id,a.qa,a.source,a.kind,e.slot_id,c.revealed,c.favorite,c.selected FROM assets a JOIN portrait_session_jobs sj ON sj.job_id=a.job_id AND sj.owner_id=a.owner_id LEFT JOIN generation_evidence e ON e.asset_id=a.id LEFT JOIN portrait_result_choices c ON c.asset_id=a.id AND c.session_id=sj.session_id AND c.owner_id=a.owner_id WHERE sj.session_id=? AND a.owner_id=? AND a.kind IN ('result','generation_evidence') ORDER BY a.created_at`).bind(id,owner).all<any>()).results;
 const results=rawResults.map(r=>({id:r.id,jobId:r.job_id,slotId:r.slot_id??null,url:assetUrl(r.id),qa:r.qa,source:r.source,kind:r.kind,revealed:!!r.revealed,favorite:!!r.favorite,selected:!!r.selected}));
 const expectedCount=jobs.reduce((n,j)=>n+j.count,0),accepted=results.filter(r=>r.kind==='result'&&r.qa==='accepted').length;
 const costs=(await db.prepare("SELECT a.id attemptId,a.slot_id slotId,COALESCE(r.reserved_micro,0) reservedMicro FROM generation_attempts a JOIN generation_slots g ON g.id=a.slot_id AND g.owner_id=a.owner_id LEFT JOIN generation_cost_reservations r ON r.attempt_id=a.id AND r.currency='CNY' WHERE a.owner_id=? AND g.session_id=? AND json_extract(a.metadata_json,'$.chargeConsent.chargeConsentVersion')='model-charge-v1' ORDER BY a.created_at,a.id").bind(owner,id).all<{attemptId:string;slotId:string;reservedMicro:number}>()).results.map(c=>({...c,currency:'CNY' as const,estimatedMicro:null,actualMicro:null,status:c.reservedMicro?'unknown' as const:'not-called' as const}));
 const statuses=rawSlots.map(g=>g.attempt_status);
 const status=jobs.length>0&&jobs.every(j=>j.status==='completed')&&accepted===expectedCount?'completed':s.status==='cancelled'?'cancelled':accepted===expectedCount&&expectedCount>0?'ready_to_select':statuses.includes('dispatched')||statuses.includes('leased')?'running':statuses.includes('queued')?'queued':statuses.includes('needs_reconciliation')?'needs_reconciliation':results.length?'awaiting_review':statuses.includes('failed')?'failed':'ready';
 return {id:s.id,variant:s.variant,status,createdAt:s.created_at,updatedAt,styleIds:JSON.parse(s.style_ids_json),references:JSON.parse(s.references_json).map(({sha256:hash,...p}:any)=>p),jobs,slots:rawSlots.map(g=>({id:g.id,jobId:g.job_id,index:g.slot_index,styleId:g.style_id,prompt:g.prompt,promptVersion:g.prompt_version,status:g.attempt_status??'ready',attemptId:g.attempt_id??null,error:g.error??null,...([SAMPLE_PROMPT_VERSION,PRO_PORTRAIT_PROMPT_VERSION,SIX_TEMPLATE_PROMPT_VERSION].includes(g.prompt_version)?{photography:frozenPhotography(g.template_json,g.prompt_version)}:{})})),results,expectedCount,...(costs.length?{costs}:{})};
}
export async function createSession(db:D1Database,bucket:R2Bucket,owner:string,input:any){
 const key=string(input.idempotencyKey,100);if(!key)throw new ApiError(400,'缺少提交标识');
 if(!['A','B','C','D'].includes(input.variant))throw new ApiError(400,'体验版本无效');
 if(!Array.isArray(input.styleIds)||input.styleIds.length<1||input.styleIds.length>3||new Set(input.styleIds).size!==input.styleIds.length||input.styleIds.some((id:unknown)=>!styles.some(s=>s.id===id&&s.image)))throw new ApiError(400,'请选择 1–3 个已有样图的风格');
 if(!Number.isInteger(input.countPerStyle)||input.countPerStyle<1||input.countPerStyle>3)throw new ApiError(400,'每种风格请选择 1–3 张');
 const six=input.styleIds.some(isSixTemplateId);
 if(six&&(!input.styleIds.every(isSixTemplateId)||input.countPerStyle!==1))throw new ApiError(400,'新六款每款固定一张，不能与旧款混合');
 const consent=requirePortraitConsent(input.consentVersion),notes=string(input.notes??'',1500);
 if(!Array.isArray(input.references)||input.references.length<1||input.references.length>8||input.references.some((r:any)=>!r||typeof r.id!=='string'||!Object.hasOwn(roles,r.role))||new Set(input.references.map((r:any)=>r.id)).size!==input.references.length||input.references.filter((r:any)=>r.role==='anchor').length!==1)throw new ApiError(400,'请选择本人参考照及唯一主参考');
 if(six&&(input.references.length>3||input.references.some((r:any)=>r.role==='style')))throw new ApiError(400,'新六款请选择 1至3 张本人原照，不接受风格附件');
 let wardrobeByStyle:Record<string,string>|undefined;try{wardrobeByStyle=normalizeWardrobeByStyle(input.styleIds,input.wardrobeByStyle)}catch(e){throw new ApiError(400,e instanceof Error?e.message:'服装选择无效')}
 const ordered=[...input.references].sort((a,b)=>a.role==='anchor'?-1:b.role==='anchor'?1:0);
 const fingerprint=await sha256(new TextEncoder().encode(JSON.stringify({variant:input.variant,styles:input.styleIds,count:input.countPerStyle,references:ordered,consent,notes,...(wardrobeByStyle===undefined?{}:{wardrobeByStyle})})));
 const existing=await db.prepare('SELECT id,fingerprint FROM portrait_sessions WHERE owner_id=? AND idempotency_key=?').bind(owner,key).first<any>();
 if(existing){if(existing.fingerprint!==fingerprint)throw new ApiError(409,'提交标识已用于其他内容，请刷新后重新创建');return getSession(db,owner,existing.id)}
 const refs:(Photo&{sha256:string})[]=[];
 for(const r of ordered){const asset=await db.prepare("SELECT * FROM assets WHERE id=? AND owner_id=? AND kind='reference'").bind(r.id,owner).first<any>();if(!asset)throw new ApiError(400,'参考照不存在');const object=await bucket.get(asset.object_key);if(!object)throw new ApiError(409,'参考照文件缺失');const bytes=new Uint8Array(await object.arrayBuffer());refs.push({id:asset.id,name:asset.name,url:assetUrl(asset.id),role:r.role,sha256:await sha256(bytes)})}
 const id=crypto.randomUUID(),stamp=now(),refIds=refs.map(r=>r.id),refParams=refIds.map(()=>'?').join(',');
 const statements=[db.prepare(`INSERT OR IGNORE INTO portrait_sessions(id,owner_id,idempotency_key,fingerprint,variant,style_ids_json,references_json,status,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'ready',?,? WHERE NOT EXISTS(SELECT 1 FROM privacy_locks WHERE owner_id=?) AND (SELECT COUNT(*) FROM jobs WHERE owner_id=?)+?<=200 AND (SELECT COUNT(*) FROM assets WHERE owner_id=? AND kind='reference' AND id IN (${refParams}))=?`).bind(id,owner,key,fingerprint,input.variant,JSON.stringify(input.styleIds),JSON.stringify(refs),stamp,stamp,owner,owner,input.styleIds.length,owner,...refIds,refs.length)];
 for(const [position,styleId] of input.styleIds.entries()){
  const jobId=crypto.randomUUID(),style=styles.find(s=>s.id===styleId)!,photography=getCreationPhotography(styleId,wardrobeByStyle?.[styleId]);
  const prompts=Array.from({length:input.countPerStyle},(_,index)=>six?compileSixPortraitPrompt(styleId,refs,notes,index):compileProPortraitPrompt(styleId,refs,notes,index,photography.wardrobe.id));
  statements.push(db.prepare(`INSERT INTO jobs(id,owner_id,idempotency_key,title,style_id,count,status,prompt,references_json,notes,created_at,updated_at,consent_version,consented_at) SELECT ?,?,?,?,?,?,'ready',?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM portrait_sessions WHERE id=? AND owner_id=?)`).bind(jobId,owner,`creation:${id}:${position}`,`${style.name} · 肖像创作`,styleId,input.countPerStyle,prompts.map((prompt,index)=>`Output ${index+1}:\n${prompt}`).join('\n\n'),JSON.stringify(refs),notes,stamp,stamp,consent,stamp,id,owner));
  statements.push(db.prepare('INSERT INTO portrait_session_jobs(session_id,job_id,owner_id,position) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND owner_id=?)').bind(id,jobId,owner,position,jobId,owner));
  for(let index=0;index<input.countPerStyle;index++)statements.push(db.prepare(`INSERT INTO generation_slots(id,session_id,job_id,owner_id,slot_index,style_id,prompt,prompt_version,template_json,references_json,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND owner_id=?)`).bind(crypto.randomUUID(),id,jobId,owner,index,styleId,prompts[index],photography.version,JSON.stringify({...style,photography}),JSON.stringify(refs),stamp,jobId,owner));
 }
 await db.batch(statements);
 const saved=await db.prepare('SELECT id,fingerprint FROM portrait_sessions WHERE owner_id=? AND idempotency_key=?').bind(owner,key).first<any>();if(!saved)throw new ApiError(409,'存储限额或照片状态已变化，请刷新后重试');if(saved.fingerprint!==fingerprint)throw new ApiError(409,'提交内容冲突');return getSession(db,owner,saved.id);
}
export async function changeChoice(db:D1Database,owner:string,id:string,data:any){
 const fields=['revealed','favorite','selected'] as const;if(fields.some(k=>data[k]!==undefined&&typeof data[k]!=='boolean')||!fields.some(k=>data[k]!==undefined))throw new ApiError(400,'选片状态无效');
 const r=await db.prepare(`INSERT INTO portrait_result_choices(session_id,asset_id,owner_id,revealed,favorite,selected) SELECT ?,?,?,COALESCE(?,0),COALESCE(?,0),COALESCE(?,0) WHERE EXISTS(SELECT 1 FROM assets a JOIN portrait_session_jobs sj ON sj.job_id=a.job_id AND sj.owner_id=a.owner_id JOIN portrait_sessions s ON s.id=sj.session_id WHERE sj.session_id=? AND s.owner_id=? AND a.id=? AND a.kind IN ('result','generation_evidence') ) ON CONFLICT(session_id,asset_id) DO UPDATE SET revealed=COALESCE(?,revealed),favorite=COALESCE(?,favorite),selected=COALESCE(?,selected)`).bind(id,string(data.assetId,100),owner,...fields.map(k=>data[k]===undefined?null:Number(data[k])),id,owner,data.assetId,...fields.map(k=>data[k]===undefined?null:Number(data[k]))).run();if(!r.meta.changes)throw new ApiError(409,'作品或创作状态已变化');
}
export async function cancelSession(db:D1Database,owner:string,id:string){
 await sessionRecord(db,owner,id);const stamp=now();const changed=await db.batch([
 db.prepare("UPDATE portrait_sessions SET status='cancelled',updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE id=? AND owner_id=? AND (NOT EXISTS(SELECT 1 FROM portrait_session_jobs sj WHERE sj.session_id=portrait_sessions.id) OR EXISTS(SELECT 1 FROM jobs j JOIN portrait_session_jobs sj ON sj.job_id=j.id AND sj.owner_id=j.owner_id WHERE sj.session_id=portrait_sessions.id AND j.status!='completed'))").bind(stamp,id,owner),
 db.prepare("UPDATE generation_attempts SET status=CASE WHEN status='dispatched' THEN 'needs_reconciliation' ELSE 'cancelled' END,lease_token=NULL,lease_expires_at=NULL,updated_at=MAX(?,COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds'),'')) WHERE owner_id=? AND slot_id IN (SELECT g.id FROM generation_slots g JOIN portrait_sessions s ON s.id=g.session_id WHERE g.session_id=? AND s.status='cancelled') AND status IN ('queued','leased','dispatched')").bind(stamp,owner,id)]);
 if(!changed[0].meta.changes)throw new ApiError(409,'创作已完成，不需要停止生成');
}
export async function deleteSession(db:D1Database,bucket:R2Bucket,owner:string,id:string){
 const session=await getSession(db,owner,id);if(session.status!=='completed')await cancelSession(db,owner,id);const ids=(await db.prepare('SELECT job_id FROM portrait_session_jobs WHERE session_id=? AND owner_id=?').bind(id,owner).all<any>()).results.map(r=>r.job_id);
 const q=ids.map(()=>'?').join(',');if(ids.length){const stamp=now();await db.batch([
 db.prepare(`INSERT OR IGNORE INTO storage_deletions(object_key,owner_id,created_at,size) SELECT object_key,owner_id,?,size FROM assets WHERE owner_id=? AND job_id IN (${q})`).bind(stamp,owner,...ids),
 db.prepare(`UPDATE pending_uploads SET cancelled=1 WHERE owner_id=? AND job_id IN (${q})`).bind(owner,...ids),
 db.prepare(`DELETE FROM assets WHERE owner_id=? AND job_id IN (${q})`).bind(owner,...ids),
 db.prepare(`DELETE FROM jobs WHERE owner_id=? AND id IN (${q})`).bind(owner,...ids),
 db.prepare('DELETE FROM portrait_sessions WHERE id=? AND owner_id=?').bind(id,owner)]);}
 return {deleted:true,...await flushDeletions(db,bucket,owner)};
}
