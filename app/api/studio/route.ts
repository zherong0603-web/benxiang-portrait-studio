import {publicJob} from '@/lib/public-portrait';
import {context,json,run,newJob,hydratedJob,imageUpload,assetUrl,ApiError,body} from '@/lib/server';
import {anonymizeOrdersForOwner} from '@/lib/commerce';
import {flushDeletions,pendingDeletions,commitUpload,abandonUpload,PRIVACY_LEASE_MS} from '@/lib/privacy';
export const dynamic='force-dynamic';

export async function GET(request:Request){return run(async()=>{
 const {db,owner}=await context(request);
 const [photos,jobs,pending]=await Promise.all([
  db.prepare('SELECT id,name FROM assets WHERE owner_id=? AND kind=? ORDER BY created_at').bind(owner,'reference').all<any>(),
  db.prepare('SELECT * FROM jobs WHERE owner_id=? ORDER BY created_at DESC').bind(owner).all<any>(),pendingDeletions(db,owner)
 ]);
 return json({photos:photos.results.map(p=>({...p,url:assetUrl(p.id),role:'angle'})),jobs:(await Promise.all(jobs.results.map(j=>hydratedJob(db,owner,j)))).map(publicJob),privacy:{pendingDeletions:pending},provider:{configured:false,mode:'manual',message:'自动出图服务尚未接入，当前可保存原照与创作要求。'}});
})}

export async function POST(request:Request){return run(async()=>{
 const {db,bucket,owner}=await context(request,true);
 if(!request.headers.get('content-type')?.startsWith('multipart/form-data'))return json({job:publicJob(await newJob(db,owner,await body(request)))},201);
 const a=await imageUpload(request,bucket,owner,owner,db);
 try{
  const saved=await db.batch([
   db.prepare(`INSERT INTO assets (id,owner_id,object_key,name,mime,size,kind,qa,source,created_at,consent_version,consented_at,consented_by,source_note)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM pending_uploads WHERE object_key=? AND owner_id=? AND cancelled=0 AND created_at>?)
    AND NOT EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=?)`).bind(a.id,owner,a.key,a.name,a.mime,a.size,'reference','not-assessed','user',a.consentedAt,a.consent,a.consentedAt,a.consentedBy,a.sourceNote,a.key,owner,new Date(Date.now()-PRIVACY_LEASE_MS).toISOString(),owner),
   commitUpload(db,a.key,owner)
  ]);
  if(!saved[0].meta.changes)throw new ApiError(409,'数据正在清理或上传已过期，请重新上传');
 }catch(e){await abandonUpload(db,bucket,a.key,owner,a.size);throw e}
 return json({photo:{id:a.id,name:a.name,url:assetUrl(a.id),role:'angle'}},201);
})}

export async function DELETE(request:Request){return run(async()=>{
 const {db,bucket,owner}=await context(request,true),input=await body(request);
 if(input.confirm!=='DELETE_ALL')throw new ApiError(400,'请确认删除全部数据');
 const token=crypto.randomUUID(),timestamp=new Date().toISOString();
 const locked=await db.prepare('INSERT OR IGNORE INTO privacy_locks (owner_id,token,created_at) VALUES (?,?,?)').bind(owner,token,timestamp).run();
 if(!locked.meta.changes)throw new ApiError(409,'数据正在清理，请稍后重试');
 try{
  await db.prepare('UPDATE jobs SET deletion_token=?,deletion_started_at=? WHERE owner_id=? AND deletion_token IS NULL').bind(token,timestamp,owner).run();
  if(await db.prepare('SELECT id FROM jobs WHERE owner_id=? AND deletion_token!=? LIMIT 1').bind(owner,token).first())throw new ApiError(409,'任务正在处理，请稍后重试删除');
  await anonymizeOrdersForOwner(db,owner,token);
  const removed=await db.batch([
   db.prepare('UPDATE pending_uploads SET cancelled=1 WHERE owner_id=? AND EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=? AND token=?)').bind(owner,owner,token),
   db.prepare('INSERT OR IGNORE INTO storage_deletions (object_key,owner_id,created_at,size) SELECT object_key,owner_id,?,size FROM assets WHERE owner_id=? AND EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=? AND token=?)').bind(timestamp,owner,owner,token),
   db.prepare('DELETE FROM assets WHERE owner_id=? AND EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=? AND token=?)').bind(owner,owner,token),
   db.prepare('DELETE FROM jobs WHERE owner_id=? AND deletion_token=? AND EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=? AND token=?)').bind(owner,token,owner,token),
   db.prepare('DELETE FROM privacy_locks WHERE owner_id=? AND token=?').bind(owner,token)
  ]);
  if(!removed[4].meta.changes)throw new ApiError(409,'清理操作已过期，请重新核对数据后重试');
 }catch(e){
  await db.batch([db.prepare('UPDATE jobs SET deletion_token=NULL,deletion_started_at=NULL WHERE owner_id=? AND deletion_token=?').bind(owner,token),db.prepare('DELETE FROM privacy_locks WHERE owner_id=? AND token=?').bind(owner,token)]);
  throw e;
 }
 return json({deleted:true,...await flushDeletions(db,bucket,owner)});
})}
