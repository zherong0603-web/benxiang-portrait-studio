import {publicJob} from '@/lib/public-portrait';
import {context,run,body,string,json,ApiError,jobRecord,hydratedJob,newJob,resolveJobContext} from '@/lib/server';
import {flushDeletions} from '@/lib/privacy';
export const dynamic='force-dynamic';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return run(async()=>{const {id}=await params,ctx=await resolveJobContext(request,id,true),{db,owner,actor,job,order}=ctx,input=await body(request);if(input.action==='revise'){if(actor!==owner)throw new ApiError(403,'返修需求由客户本人提交');return json({job:publicJob(await newJob(db,owner,{idempotencyKey:input.idempotencyKey,title:`${job.title} · 返修`,styleId:job.style_id,count:job.count,references:JSON.parse(job.references_json),consentVersion:input.consentVersion??job.consent_version,notes:`${job.notes}\n返修：${string(input.notes,1000)}`.slice(-1500)},id))},201)}
 if(input.action==='complete'){if(order&&order.payment_status!=='cancelled')throw new ApiError(409,'请由履约人员从订单中核验交付');if(job.status!=='review')throw new ApiError(409,'请先导入并检查作品');const saved=await db.prepare(`UPDATE jobs SET status='completed',updated_at=? WHERE id=? AND owner_id=? AND status='review' AND deletion_token IS NULL AND (SELECT COUNT(*) FROM assets WHERE job_id=jobs.id AND owner_id=jobs.owner_id AND kind='result')=count AND NOT EXISTS (SELECT 1 FROM assets WHERE job_id=jobs.id AND owner_id=jobs.owner_id AND kind='result' AND qa!='accepted') AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.job_id=jobs.id AND orders.payment_status!='cancelled') AND NOT EXISTS(SELECT 1 FROM portrait_session_jobs sj JOIN portrait_sessions s ON s.id=sj.session_id WHERE sj.job_id=jobs.id AND s.status='cancelled')`).bind(new Date().toISOString(),id,owner).run();if(!saved.meta.changes)throw new ApiError(409,'作品检查或订单状态已变化，请重新确认');return json({job:publicJob(await hydratedJob(db,owner,await jobRecord(db,owner,id),actor))})}
 if(input.action==='generate')throw new ApiError(503,'自动出图服务尚未接入，请稍后重试');throw new ApiError(400,'不支持这项操作')})}
export async function DELETE(request:Request,{params}:{params:Promise<{id:string}>}){return run(async()=>{
 const {id}=await params,{db,bucket,owner}=await context(request,true);await jobRecord(db,owner,id);
 if(await db.prepare('SELECT session_id FROM portrait_session_jobs WHERE job_id=? AND owner_id=?').bind(id,owner).first())throw new ApiError(409,'请从肖像体验中删除整组创作，以保留关联记录的一致性');
 const token=crypto.randomUUID(),timestamp=new Date().toISOString();
 const lock=await db.prepare(`UPDATE jobs SET deletion_token=?,deletion_started_at=? WHERE id=? AND owner_id=? AND deletion_token IS NULL AND NOT EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=?) AND NOT EXISTS (SELECT 1 FROM orders WHERE job_id=jobs.id AND (payment_status IN ('unpaid','checkout_pending') OR (payment_status='paid' AND fulfillment_status!='delivered')))` ).bind(token,timestamp,id,owner,owner).run();
 if(!lock.meta.changes)throw new ApiError(409,'任务正在处理或仍有关联订单，请先取消未付订单或完成履约');
 try{
  const removed=await db.batch([
   db.prepare('INSERT OR IGNORE INTO storage_deletions (object_key,owner_id,created_at,size) SELECT object_key,owner_id,?,size FROM assets WHERE owner_id=? AND job_id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND owner_id=? AND deletion_token=?)').bind(timestamp,owner,id,id,owner,token),
   db.prepare('DELETE FROM assets WHERE owner_id=? AND job_id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND owner_id=? AND deletion_token=?)').bind(owner,id,id,owner,token),
   db.prepare('UPDATE pending_uploads SET cancelled=1 WHERE owner_id=? AND job_id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND owner_id=? AND deletion_token=?)').bind(owner,id,id,owner,token),
   db.prepare('UPDATE orders SET job_id=NULL WHERE owner_id=? AND job_id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND owner_id=? AND deletion_token=?)').bind(owner,id,id,owner,token),
   db.prepare('DELETE FROM jobs WHERE owner_id=? AND id=? AND deletion_token=?').bind(owner,id,token)
  ]);
  if(!removed[4].meta.changes)throw new ApiError(409,'清理操作已过期，请刷新重试');
 }catch(e){await db.prepare('UPDATE jobs SET deletion_token=NULL,deletion_started_at=NULL WHERE id=? AND owner_id=? AND deletion_token=?').bind(id,owner,token).run();throw e}
 return json({deleted:true,...await flushDeletions(db,bucket,owner)});
})}
