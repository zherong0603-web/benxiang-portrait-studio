import type {CreateSessionInput} from './creation-contract';
import type {PublicCreationSession as CreationSession} from './public-portrait';
import {queueableSlots} from './experience-state';
import {ApiError} from './client';

type Hooks={create:(input:CreateSessionInput)=>Promise<CreationSession>;saved:(session:CreationSession)=>void;queue:(sessionId:string,slotId:string)=>Promise<CreationSession>;queueable?:(session:CreationSession)=>CreationSession['slots']};
export function creationNotStarted(session:CreationSession){return session.status==='ready'&&session.results.length===0&&session.slots.every(slot=>slot.status==='ready'&&!slot.attemptId);}
/** Persist the recoverable session before dispatch. Never retry a lost response here. */
export async function submitPortraitCreation(input:CreateSessionInput,hooks:Hooks,start=false):Promise<CreationSession>{
 let session=await hooks.create(input);
 if(!session?.id||!Array.isArray(session.slots)||!Array.isArray(session.results))throw new ApiError(0,'返回内容不完整，创作可能已保存，请核对原提交。');
 hooks.saved(session);
 if(start)for(const slot of (hooks.queueable??queueableSlots)(session)){
  const next=await hooks.queue(session.id,slot.id);
  if(next?.id!==session.id)throw new ApiError(0,'生成状态尚未确认，请打开已保存的创作核对，不要重复提交。');
  session=next;hooks.saved(session);
 }
 return session;
}
