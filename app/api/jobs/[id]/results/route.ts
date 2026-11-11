import {publicJob} from '@/lib/public-portrait';
import {env} from 'cloudflare:workers';
import {run,body,json,ApiError,jobRecord,hydratedJob,imageUpload,resolveJobContext,assertResultEditor} from '@/lib/server';
import {isCommerceOperator} from '@/lib/commerce';
import {flushDeletions,commitUpload,abandonUpload,PRIVACY_LEASE_MS} from '@/lib/privacy';
export const dynamic='force-dynamic';
const editableOrder=`NOT EXISTS(SELECT 1 FROM portrait_session_jobs sj JOIN portrait_sessions s ON s.id=sj.session_id WHERE sj.job_id=jobs.id AND s.status='cancelled') AND (NOT EXISTS (SELECT 1 FROM orders WHERE orders.job_id=jobs.id AND payment_status!='cancelled') OR EXISTS (SELECT 1 FROM orders WHERE orders.job_id=jobs.id AND payment_status='paid' AND ?=1))`;

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return run(async()=>{
 const {id}=await params,ctx=await resolveJobContext(request,id,true),{db,bucket,owner,actor,job}=ctx;
 assertResultEditor(ctx);if(job.status==='completed')throw new ApiError(409,'已交付作品不可直接修改，请发起返修');
 const a=await imageUpload(request,bucket,owner,actor,db,'result',id),operator=isCommerceOperator(actor,env)?1:0;
 try{
  const inserted=await db.batch([
   db.prepare(`INSERT INTO assets (id,owner_id,object_key,name,mime,size,kind,job_id,qa,source,created_at,consent_version,consented_at,consented_by,source_note)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM assets WHERE owner_id=? AND job_id=? AND kind='result')<?
    AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND owner_id=? AND status!='completed' AND deletion_token IS NULL AND ${editableOrder})
    AND EXISTS (SELECT 1 FROM pending_uploads WHERE object_key=? AND owner_id=? AND cancelled=0 AND created_at>?)
    AND NOT EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=?)`).bind(a.id,owner,a.key,a.name,a.mime,a.size,'result',id,'not-assessed','manual',a.consentedAt,a.consent,a.consentedAt,a.consentedBy,a.sourceNote,owner,id,job.count,id,owner,operator,a.key,owner,new Date(Date.now()-PRIVACY_LEASE_MS).toISOString(),owner),
   db.prepare('UPDATE jobs SET status=?,updated_at=? WHERE id=? AND owner_id=? AND deletion_token IS NULL AND EXISTS (SELECT 1 FROM assets WHERE id=? AND owner_id=?)').bind('review',new Date().toISOString(),id,owner,a.id,owner),
   commitUpload(db,a.key,owner)
  ]);
  if(!inserted[0].meta.changes)throw new ApiError(409,'作品数量、上传期限或订单状态已变化，请刷新重试');
 }catch(e){await abandonUpload(db,bucket,a.key,owner,a.size);throw e}
 return json({job:publicJob(await hydratedJob(db,owner,await jobRecord(db,owner,id),actor))},201);
},request)}

export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){return run(async()=>{
 const {id}=await params,ctx=await resolveJobContext(request,id,true),{db,owner,actor}=ctx;assertResultEditor(ctx);
 if(await db.prepare('SELECT session_id FROM portrait_session_jobs WHERE job_id=? AND owner_id=?').bind(id,owner).first())throw new ApiError(409,'请在肖像体验中检查作品，以同步候选和检查记录');
 const data=await body(request);if(!['accepted','rejected','not-assessed'].includes(data.qa))throw new ApiError(400,'无效的检查状态');
 const a=await db.prepare('SELECT id FROM assets WHERE id=? AND owner_id=? AND job_id=? AND kind=?').bind(data.resultId,owner,id,'result').first();
 if(!a)throw new ApiError(404,'作品不存在');
 const saved=await db.prepare(`UPDATE assets SET qa=? WHERE id=? AND owner_id=? AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id=assets.job_id AND jobs.owner_id=assets.owner_id AND status!='completed' AND deletion_token IS NULL AND ${editableOrder})`).bind(data.qa,data.resultId,owner,isCommerceOperator(actor,env)?1:0).run();
 if(!saved.meta.changes)throw new ApiError(409,'作品已交付、正在清理或订单状态变化，不能修改');
 return json({job:publicJob(await hydratedJob(db,owner,await jobRecord(db,owner,id),actor))});
})}

export async function DELETE(request:Request,{params}:{params:Promise<{id:string}>}){return run(async()=>{
 const {id}=await params,ctx=await resolveJobContext(request,id,true),{db,bucket,owner,actor}=ctx;assertResultEditor(ctx);
 const data=await body(request),a=await db.prepare('SELECT * FROM assets WHERE id=? AND owner_id=? AND job_id=? AND kind=?').bind(data.resultId,owner,id,'result').first<any>();
 if(!a)throw new ApiError(404,'作品不存在');
 const token=crypto.randomUUID(),timestamp=new Date().toISOString();
 const locked=await db.prepare(`UPDATE jobs SET deletion_token=?,deletion_started_at=? WHERE id=? AND owner_id=? AND status!='completed' AND deletion_token IS NULL AND ${editableOrder} AND NOT EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=?)`).bind(token,timestamp,id,owner,isCommerceOperator(actor,env)?1:0,owner).run();
 if(!locked.meta.changes)throw new ApiError(409,'作品已交付或正在处理，不能删除');
 try{
  const removed=await db.batch([
   db.prepare('INSERT OR IGNORE INTO storage_deletions (object_key,owner_id,created_at,size) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM jobs WHERE id=? AND owner_id=? AND deletion_token=?)').bind(a.object_key,owner,timestamp,a.size,id,owner,token),
   db.prepare('DELETE FROM assets WHERE id=? AND owner_id=? AND job_id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND owner_id=? AND deletion_token=?)').bind(a.id,owner,id,id,owner,token),
   db.prepare(`UPDATE jobs SET status=CASE WHEN EXISTS (SELECT 1 FROM assets WHERE owner_id=? AND job_id=? AND kind='result') THEN 'review' ELSE 'ready' END,updated_at=?,deletion_token=NULL,deletion_started_at=NULL WHERE id=? AND owner_id=? AND deletion_token=?`).bind(owner,id,timestamp,id,owner,token)
  ]);
  if(!removed[2].meta.changes)throw new ApiError(409,'清理操作已过期，请刷新重试');
 }catch(e){await db.prepare('UPDATE jobs SET deletion_token=NULL,deletion_started_at=NULL WHERE id=? AND owner_id=? AND deletion_token=?').bind(id,owner,token).run();throw e}
 return json({job:publicJob(await hydratedJob(db,owner,await jobRecord(db,owner,id),actor)),...await flushDeletions(db,bucket,owner)});
})}
