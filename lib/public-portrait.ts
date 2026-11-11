import type {Job, Photo, ResultPhoto} from './portrait';
import type {CreationSession} from './creation-contract';

const publicPhoto=({id,name,url,role}:Photo)=>({id,name,url,role});
const publicResult=({id,url,source,qa,source_note}:ResultPhoto&{source_note?:string})=>({id,url,source,qa,...(source_note===undefined?{}:{source_note})});

/** Customer DTOs are explicit allowlists; internal snapshots remain server-side. */
export function publicJob(job:Job&{consentVersion?:string|null;consented_at?:string|null}){
 const {id,title,style_id,count,status,created_at,notes,parent_id,error,creationSessionId,consentVersion,consented_at,commerce}=job;
 return {id,title,style_id,count,status,created_at,notes,parent_id,error,creationSessionId,consentVersion,consentedAt:consented_at,
  references:job.references.map(publicPhoto),results:job.results.map(publicResult),
  commerce:commerce?{orderId:commerce.orderId,paymentStatus:commerce.paymentStatus,fulfillmentStatus:commerce.fulfillmentStatus,mode:commerce.mode,canFulfill:commerce.canFulfill}:undefined};
}
export type PublicJob=ReturnType<typeof publicJob>;

export function publicCreation(session:CreationSession){
 const {id,variant,status,createdAt,updatedAt,expectedCount}=session;
 return {id,variant,status,createdAt,updatedAt,expectedCount,styleIds:[...session.styleIds],references:session.references.map(publicPhoto),jobs:session.jobs.map(publicJob),
  slots:session.slots.map(({id,jobId,index,styleId,status,attemptId,error})=>({id,jobId,index,styleId,status,attemptId,error})),
  ...(session.costs?{costs:session.costs.map(({slotId,attemptId,currency,reservedMicro,estimatedMicro,actualMicro,status})=>({slotId,attemptId,currency,reservedMicro,estimatedMicro,actualMicro,status}))}:{}),
  results:session.results.map(({id,jobId,slotId,url,qa,source,revealed,favorite,selected,kind})=>({id,jobId,slotId,url,qa,source,revealed,favorite,selected,kind}))};
}
export type PublicCreationSession=ReturnType<typeof publicCreation>;
