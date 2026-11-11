import {isSixTemplateId} from './six-templates';
import {frozenPhotography} from './photography-recipes';
import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {styles,roles,compilePrompt,type Photo} from './portrait';
import {CommerceError} from './commerce-contract';
import {hasOrderForJob,isCommerceOperator,paidJobAccess} from './commerce';
import {requirePortraitConsent,readBoundedBody,recoverPrivacyLeases,reserveUpload,abandonUpload} from './privacy';
import {inspectImage} from './image-validation';

export class ApiError extends Error {constructor(public status:number,message:string){super(message)}}
export async function context(request:Request,write=false){
 if(write){const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)throw new ApiError(403,'请求来源不匹配');if(request.headers.get('sec-fetch-site')==='cross-site')throw new ApiError(403,'请从工作室页面发起操作');}
 const user=await getChatGPTUser();if(!user)throw new ApiError(401,'请先登录再使用工作室');
 if(!env.DB||!env.BUCKET)throw new ApiError(503,'工作室存储暂不可用，请稍后重试');
 await recoverPrivacyLeases(env.DB,user.userId);
 return {owner:user.userId,actor:user.userId,db:env.DB,bucket:env.BUCKET};
}
export function json(data:unknown,status=200){return Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}})}
/** Discard an unused upload after authorization has already failed. Never buffer or parse it. */
export async function discardUnusedBody(request:Request,limit=11*1024*1024){
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const cancel=()=>{try{void reader?.cancel().catch(()=>{})}catch{}};
 try{
  const stream=request.body;if(!stream||request.bodyUsed||stream.locked)return;
  reader=stream.getReader();
  const drain=(async()=>{try{let length=0;while(length<limit){const {done,value}=await reader!.read();if(done)return;length+=value.byteLength;}cancel()}catch{cancel()}})();
  // Neither a denied slow upload nor a broken cancellation promise can retain the response.
  await Promise.race([drain,new Promise<void>(resolve=>{timer=setTimeout(()=>{cancel();resolve()},2000)})]);
 }catch{
  // Cleanup/transport failures must preserve the original authorization response.
  cancel();
 }finally{
  if(timer!==undefined)clearTimeout(timer);
  try{reader?.releaseLock()}catch{}
 }
}
export async function run(fn:()=>Promise<Response>,request?:Request){try{return await fn()}catch(e){if(e instanceof ApiError||e instanceof CommerceError)return json({error:e.message},e.status);const requestId=crypto.randomUUID();console.error('Portrait operation failed',requestId,e instanceof Error?e.name:'unknown');return json({error:`操作未完成，请刷新核对状态后重试。问题编号：${requestId}`,requestId},500)}finally{if(request)await discardUnusedBody(request)}}
export async function body(request:Request):Promise<Record<string,any>>{try{const raw=new TextDecoder().decode(await readBoundedBody(request,20000));const parsed=JSON.parse(raw);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed}catch(e){if(e instanceof CommerceError)throw e;throw new ApiError(400,'请求内容无效')}}
export function string(value:unknown,max=200){if(typeof value!=='string'||value.length>max)throw new ApiError(400,'文本内容过长或格式无效');return value.trim()}
export const assetUrl=(id:string)=>`/api/assets/${encodeURIComponent(id)}`;
export async function jobRecord(db:D1Database,owner:string,id:string){const job=await db.prepare('SELECT * FROM jobs WHERE id=? AND owner_id=?').bind(id,owner).first<any>();if(!job)throw new ApiError(404,'找不到这项任务');return job}
export async function resolveJobContext(request:Request,id:string,write=false){
 const ctx=await context(request,write);let owner=ctx.owner;
 let job=await ctx.db.prepare('SELECT * FROM jobs WHERE id=? AND owner_id=?').bind(id,owner).first<any>();
 if(!job){const access=await paidJobAccess(ctx.db,ctx.actor,id,env);if(!access)throw new ApiError(404,'找不到这项任务');owner=access.owner;await recoverPrivacyLeases(ctx.db,owner);job=await jobRecord(ctx.db,owner,id);}
 if(job.deletion_token)throw new ApiError(409,'任务正在清理，请稍后刷新');
 const order=await hasOrderForJob(ctx.db,owner,id);
 return {...ctx,owner,job,order};
}
export function assertResultEditor(ctx:Awaited<ReturnType<typeof resolveJobContext>>){
 if(ctx.order&&ctx.order.payment_status!=='cancelled'&&(!isCommerceOperator(ctx.actor,env)||ctx.order.payment_status!=='paid'))throw new ApiError(403,'商业订单作品由已授权的履约人员处理，付款或交付状态不能由客户自行确认');
}
export async function hydratedJob(db:D1Database,owner:string,job:any,actor=owner){
 const order=await hasOrderForJob(db,owner,job.id);
 const canFulfill=!!order&&order.payment_status==='paid'&&isCommerceOperator(actor,env);
 const visible=!order||order.payment_status==='cancelled'||canFulfill||(order.payment_status==='paid'&&order.fulfillment_status==='delivered');
 const r=visible?await db.prepare('SELECT id,source,qa,source_note FROM assets WHERE owner_id=? AND job_id=? AND kind=? ORDER BY created_at').bind(owner,job.id,'result').all<any>():{results:[]};
 const creation=await db.prepare('SELECT session_id FROM portrait_session_jobs WHERE job_id=? AND owner_id=?').bind(job.id,owner).first<{session_id:string}>();
 const frozen=creation?(await db.prepare('SELECT slot_index,prompt,prompt_version,template_json FROM generation_slots WHERE job_id=? AND owner_id=? ORDER BY slot_index').bind(job.id,owner).all<{slot_index:number;prompt:string;prompt_version:string;template_json:string}>()).results:undefined;
 return {...job,creationSessionId:creation?.session_id,frozenPrompts:frozen?.map(g=>({slot:g.slot_index+1,prompt:g.prompt,version:g.prompt_version,...(frozenPhotography(g.template_json,g.prompt_version)?{photography:frozenPhotography(g.template_json,g.prompt_version)}:{})})),owner_id:undefined,idempotency_key:undefined,references_json:undefined,deletion_token:undefined,deletion_started_at:undefined,references:JSON.parse(job.references_json),consentVersion:job.consent_version??null,results:r.results.map(x=>({...x,url:assetUrl(x.id)})),commerce:order?{orderId:order.id,paymentStatus:order.payment_status,fulfillmentStatus:order.fulfillment_status,mode:order.mode,canFulfill}:undefined};
}
export async function newJob(db:D1Database,owner:string,input:any,parentId:string|null=null){
 const key=string(input.idempotencyKey,100);if(!key)throw new ApiError(400,'缺少任务提交标识');
 const existing=await db.prepare('SELECT * FROM jobs WHERE owner_id=? AND idempotency_key=?').bind(owner,key).first<any>();if(existing)return hydratedJob(db,owner,existing);
 const consent=requirePortraitConsent(input.consentVersion);
 const styleId=string(input.styleId,60);if(isSixTemplateId(styleId)||!styles.some(s=>s.id===styleId))throw new ApiError(400,'请选择有效风格');
 const count=input.count;if(!Number.isInteger(count)||count<1||count>12)throw new ApiError(400,'出图数量须为 1–12 张');
 if(!Array.isArray(input.references)||input.references.length<1||input.references.length>8)throw new ApiError(400,'请上传 1–8 张参考照');
 if(input.references.some((r:any)=>!r||typeof r!=='object'))throw new ApiError(400,'参考照片格式无效');
 if(new Set(input.references.map((r:any)=>r.id)).size!==input.references.length)throw new ApiError(400,'参考照片不能重复');
 if(input.references.filter((r:any)=>r.role==='anchor').length!==1)throw new ApiError(400,'必须指定一张主身份参考');
 const refs:Photo[]=[];
 for(const ref of input.references){if(!Object.hasOwn(roles,ref.role))throw new ApiError(400,'参考用途无效');const asset=await db.prepare('SELECT id,name FROM assets WHERE id=? AND owner_id=? AND kind=?').bind(string(ref.id,100),owner,'reference').first<any>();if(!asset)throw new ApiError(400,'参考照不可用，请重新选择');refs.push({...asset,url:assetUrl(asset.id),role:ref.role});}
 refs.sort((a,b)=>a.role==='anchor'?-1:b.role==='anchor'?1:0);
 const title=string(input.title||'我的职业形象照',80),notes=string(input.notes||'',1500),id=crypto.randomUUID(),now=new Date().toISOString(),prompt=compilePrompt(styleId,count,refs,notes);
 try{const saved=await db.prepare(`INSERT INTO jobs (id,owner_id,idempotency_key,title,style_id,count,status,prompt,references_json,notes,parent_id,created_at,updated_at,consent_version,consented_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM jobs WHERE owner_id=?)<200 AND NOT EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=?) AND (SELECT COUNT(*) FROM assets WHERE owner_id=? AND kind='reference' AND id IN (${refs.map(()=>'?').join(',')}))=?`).bind(id,owner,key,title,styleId,count,'ready',prompt,JSON.stringify(refs),notes,parentId,now,now,consent,now,owner,owner,owner,...refs.map(r=>r.id),refs.length).run();if(!saved.meta.changes)throw new ApiError(409,'任务已达 200 项或正在删除数据，请先刷新核对')}catch(e){const raced=await db.prepare('SELECT * FROM jobs WHERE owner_id=? AND idempotency_key=?').bind(owner,key).first<any>();if(raced)return hydratedJob(db,owner,raced);throw e;}
 return hydratedJob(db,owner,await jobRecord(db,owner,id));
}
export async function imageUpload(request:Request,bucket:R2Bucket,owner:string,actor:string,db:D1Database,kind:'reference'|'result'='reference',jobId:string|null=null){
 const bytesBody=await readBoundedBody(request,11*1024*1024);let form:FormData;
 try{form=await new Response(bytesBody,{headers:{'Content-Type':request.headers.get('content-type')||''}}).formData()}catch{throw new ApiError(400,'上传表单无效')}
 const consent=requirePortraitConsent(form.get('consentVersion'));
 const sourceNote=string(form.get('sourceNote')||'',500);
 const file=form.get('file');if(!(file instanceof File)||!file.size||file.size>10*1024*1024)throw new ApiError(400,'请选择 10 MB 以内的照片');
 const bytes=new Uint8Array(await file.arrayBuffer());let image:ReturnType<typeof inspectImage>;
 try{image=inspectImage(bytes)}catch(e){throw new ApiError(400,e instanceof Error?e.message:'图片格式无效')}
 if(file.type!==image.mime)throw new ApiError(400,'文件类型与图片内容不一致');
 const id=crypto.randomUUID(),key=`private/${owner}/${id}`,name=file.name.replace(/[\x00-\x1f]/g,'').slice(0,160)||'portrait';
 await reserveUpload(db,{key,owner,size:file.size,kind,jobId});
 try{await bucket.put(key,bytes,{httpMetadata:{contentType:image.mime}})}catch(e){try{await abandonUpload(db,bucket,key,owner,file.size)}catch{console.error('Portrait upload cleanup pending')}throw e}
 return {id,key,name,mime:image.mime,size:file.size,consent,consentedAt:new Date().toISOString(),consentedBy:actor,sourceNote};
}
