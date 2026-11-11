import type {Photo} from './portrait-contract';
import type {CreateSessionInput} from './creation-contract';
import {isSixTemplateId} from './six-template-ids';
import type {PublicStyle} from './public-catalogue';
/** A delayed stream frame must not reopen an explicitly stopped/completed record. */
export function preferSession<T extends{id:string;status:string;updatedAt:string;results?:{id:string}[]}>(current:T|null|undefined,incoming:T):T{
 if(!current||current.id!==incoming.id)return incoming;
 if(['cancelled','completed'].includes(current.status)&&incoming.status!==current.status)return current;
 if(['cancelled','completed'].includes(incoming.status)&&!['cancelled','completed'].includes(current.status))return incoming;
 if(current.updatedAt===incoming.updatedAt&&current.results?.some(result=>!incoming.results?.some(next=>next.id===result.id)))return current;
 return current.updatedAt>incoming.updatedAt?current:incoming;
}
export function addReference(current:Photo[],photo:Photo,limit=8):Photo[]{
 if(current.some(p=>p.id===photo.id)||current.length>=limit)return current;
 return [...current,{...photo,role:current.length?'angle':'anchor'}];
}
export function removeReference(current:Photo[],id:string):Photo[]{
 const next=current.filter(p=>p.id!==id);
 if(next.length&&!next.some(p=>p.role==='anchor')){const anchor=next.findIndex(p=>p.role!=='style');return next.map((p,i)=>i===anchor?{...p,role:'anchor'}:p);}
 return next;
}
export function setAnchor(current:Photo[],id:string):Photo[]{
 if(!current.some(p=>p.id===id&&p.role!=='style'))return current;
 return current.map(p=>({...p,role:p.id===id?'anchor':p.role==='anchor'?'angle':p.role}));
}
export function uploadValidation(file:{type:string;size:number}):string{
 if(!['image/jpeg','image/png','image/webp'].includes(file.type))return '请使用 JPG、PNG 或 WEBP 格式；HEIC 请先导出为 JPG。';
 if(!file.size)return '文件为空，请重新选择照片。';
 if(file.size>10*1024*1024)return '单张照片不能超过 10 MB。';
 return '';
}
export type UploadRow={id:string;file:File;status:'pending'|'uploading'|'saved'|'failed'|'unknown';error?:string;photo?:Photo};
/** A lost response may have saved an asset. Never retry an uncertain upload implicitly. */
export async function runUploadBatch(rows:UploadRow[],send:(row:UploadRow)=>Promise<Photo>,update:(row:UploadRow)=>void):Promise<void>{
 for(const row of rows){
  if(!['pending','failed'].includes(row.status))continue;
  const invalid=uploadValidation(row.file);
  if(invalid){update({...row,status:'failed',error:invalid});continue;}
  update({...row,status:'uploading',error:undefined});
  try{update({...row,status:'saved',photo:await send(row),error:undefined});}
  catch(e){const uncertain=submissionUncertain(e);update({...row,status:uncertain?'unknown':'failed',error:e instanceof Error?e.message:'上传未完成，请重试。'});if(e&&typeof e==='object'&&'status' in e&&e.status===401)break;}
 }
}
export function creationReadiness({authenticated,consent,photos,styles,count=1}:{authenticated:boolean;consent:boolean;photos:Photo[];styles:string[];count?:number}):string{
 if(!authenticated)return '请先登录，照片和作品会保存在你的私密空间。';
 if(!styles.length)return '请先选择至少一种喜欢的风格。';
 const six=styles.some(isSixTemplateId);
 if(six){
  if(!styles.every(isSixTemplateId))return '新款与旧款需要分别建立创作。';
  if(styles.length>3)return '每组最多选择 3 款。';
  if(count!==1)return '新款每款固定生成 1 张。';
  if(photos.length>3)return '每组最多选择 3 张本人原照。';
  if(photos.some(p=>p.role==='style'))return '只接受本人原照，不接受风格参考照片。';
 }
 if(!photos.length)return '请上传或选择同一个人的参考照片。';
 if(!consent)return '请确认照片使用授权。';
 if(photos.filter(p=>p.role==='anchor').length!==1)return '请选择一张清晰的正面照片作为主参考。';
 return '';
}
export type ResultFilter='all'|'favorites'|'selected';
export function selectVisibleResults<T extends {qa:string;kind:string;favorite:boolean;selected:boolean}>(results:T[],filter:ResultFilter):T[]{
 return results.filter(r=>filter==='favorites'?r.favorite:filter==='selected'?r.selected&&r.qa==='accepted'&&r.kind==='result':true);
}

/** Only a known rejection permits editing; response loss or server faults may follow persistence. */
export function submissionUncertain(error:unknown):boolean{
 if(!error||typeof error!=='object'||!('status' in error)||typeof error.status!=='number')return true;
 return !(error.status>=400&&error.status<500&&error.status!==408);
}
export function newPersonDraft(defaultStyle='blue-business'){return {references:[] as Photo[],uploads:[] as UploadRow[],consent:false,notes:'',count:1,styleIds:[defaultStyle],pendingInput:null as CreateSessionInput|null};}
/** A historical job supplies originals only. New template selection and consent stay explicit. */
export function draftFromJob(job:{references:Photo[];notes:string}){
 return {...newPersonDraft(),styleIds:[] as string[],notes:job.notes,references:job.references.map(photo=>({...photo})).sort((a,b)=>a.role==='anchor'?-1:b.role==='anchor'?1:0)};
}
/** One failed/rejected hosted attempt stays immutable; a fresh draft requires new consent. */
export function draftFromSession(session:{references:Photo[];styleIds:string[];jobs:{style_id:string;notes:string}[]},styleId:string){
 if(!session.styleIds.includes(styleId))throw new Error('请选择这组已有的款式。');
 return {...newPersonDraft(styleId),notes:session.jobs.find(job=>job.style_id===styleId)?.notes??'',references:session.references.map(photo=>({...photo}))};
}
export function toggleTemplateSelection(current:string[],id:string):string[]{
 if(!isSixTemplateId(id))return current;
 if(current.includes(id))return current.filter(value=>value!==id);
 return current.length>=3?current:[...current,id];
}
export function resultProgress(results:{kind:string;qa:string}[]){return {current:results.filter(r=>r.kind==='result').length,pendingEvidence:results.filter(r=>r.kind==='generation_evidence'&&r.qa==='not-assessed').length,history:results.filter(r=>r.kind==='generation_evidence'&&r.qa!=='not-assessed').length};}
/** Saved files, review status and provenance overlap; none is a generation completion ratio. */
export function resultCounts(results:{kind:string;qa:string;source:string}[]){
 return {
  saved:results.length,
  pending:results.filter(r=>r.qa==='not-assessed').length,
  qualified:results.filter(r=>r.kind==='result'&&r.qa==='accepted').length,
  history:results.filter(r=>r.source==='manual'||r.kind==='generation_evidence'&&r.qa!=='not-assessed').length,
 };
}
export function sessionPermissions(status:string){const terminal=['completed','cancelled'].includes(status);return {queue:['ready','failed'].includes(status),cancel:!terminal,review:!terminal,import:!terminal,choice:true};}
/** Local recovery is untrusted input too; never silently invent a different request body. */
export function readPendingSubmission(raw:string|null,catalogue:readonly PublicStyle[]=[]):CreateSessionInput|null{
 if(!raw)return null;
 try{
  const p=JSON.parse(raw);
  if(!p||typeof p!=='object'||typeof p.idempotencyKey!=='string'||!p.idempotencyKey||p.idempotencyKey.length>100||!['A','B','C','D'].includes(p.variant)||p.consentVersion!=='portrait-consent-v1')return null;
  if(!Array.isArray(p.styleIds)||!p.styleIds.length||p.styleIds.length>8||p.styleIds.some((id:unknown)=>typeof id!=='string'||!id||id.length>60)||!Number.isInteger(p.countPerStyle)||p.countPerStyle<1||p.countPerStyle>3)return null;
  if(!Array.isArray(p.references)||!p.references.length||p.references.length>8||p.references.some((r:any)=>!r||typeof r.id!=='string'||!r.id||r.id.length>100||!['anchor','angle','expression','proportion','style'].includes(r.role))||p.references.filter((r:any)=>r.role==='anchor').length!==1)return null;
  if(p.styleIds.some(isSixTemplateId)&&(!p.styleIds.every(isSixTemplateId)||p.styleIds.length>3||p.countPerStyle!==1||p.references.length>3||p.references.some((r:any)=>r.role==='style')))return null;
  if(p.notes!==undefined&&(typeof p.notes!=='string'||p.notes.length>1500))return null;
  if(Object.hasOwn(p,'wardrobeByStyle')){
   const choices=p.wardrobeByStyle;
   if(!choices||typeof choices!=='object'||Array.isArray(choices)||Object.entries(choices).some(([id,choice])=>!p.styleIds.includes(id)||typeof choice!=='string'||!catalogue.find(style=>style.id===id)?.photography?.wardrobeOptions.some(option=>option.id===choice)))return null;
  }
  return {idempotencyKey:p.idempotencyKey,variant:p.variant,styleIds:p.styleIds,countPerStyle:p.countPerStyle,references:p.references.map((r:any)=>({id:r.id,role:r.role})),consentVersion:p.consentVersion,...p.notes!==undefined?{notes:p.notes}:{},...Object.hasOwn(p,'wardrobeByStyle')?{wardrobeByStyle:p.wardrobeByStyle}:{}};
 }catch{return null;}
}
/** A later rejection says nothing about whether an earlier uncertain request persisted. */
export function keepPendingSubmission(wasUncertain:boolean,error:unknown){return wasUncertain||submissionUncertain(error);}
type RetrySlot={id:string;jobId:string;status:string};
type RetrySession<T extends RetrySlot>={status:string;slots:T[];jobs:{id:string;count:number;status:string}[];results:{slotId:string|null;jobId:string;kind:string;qa:string}[]};
export function queueableSlots<T extends RetrySlot>(session:RetrySession<T>,hosted=false):T[]{
 if(['cancelled','completed'].includes(session.status))return [];
 return session.slots.filter(slot=>{
  const job=session.jobs.find(j=>j.id===slot.jobId);
  if(!job||job.status==='completed'||session.results.filter(r=>r.jobId===job.id&&r.kind==='result').length>=job.count)return false;
  const outputs=session.results.filter(r=>r.slotId===slot.id);
  if(outputs.some(r=>r.qa!=='rejected'))return false;
  return slot.status==='ready'||(hosted?slot.status==='queued':slot.status==='failed'||slot.status==='succeeded'&&outputs.length>0);
 });
}
/** Hosted slots are single-attempt. Queued resumes that attempt; failures need a new creation. */
export function hostedQueueableSlots<T extends RetrySlot>(session:RetrySession<T>):T[]{return queueableSlots(session,true);}
/** Manual imports have no provider attempt; project saved result order onto otherwise empty positions only. */
export function slotDisplayStatus(slot:{jobId:string;index:number;status:string;attemptId:string|null},results:{jobId:string;kind:string;source:string;qa:string}[]){
 if(slot.attemptId||slot.status!=='ready')return slot.status;
 const result=results.filter(r=>r.jobId===slot.jobId&&r.kind==='result')[slot.index];
 if(!result||result.source!=='manual')return slot.status;
 return result.qa==='accepted'?'accepted':result.qa==='rejected'?'rejected':'awaiting_review';
}
