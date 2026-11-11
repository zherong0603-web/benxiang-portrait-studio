import {compileSinglePortraitPrompt,PORTRAIT_PROMPT_VERSION,type Job} from './portrait';
/** A creation's original workbench and its worker must consume the same snapshot. */
export function resolveJobPrompt(job:Job,slot:number):{prompt:string;version:string}{
 if(!Number.isInteger(slot)||slot<0||slot>=job.count)throw new Error('提示词张数无效');
 if(job.creationSessionId){
  const frozen=job.frozenPrompts?.find(p=>p.slot===slot+1);
  if(!frozen?.prompt||!frozen.version)throw new Error('创作提示词快照缺失，请返回创作记录核对');
  return {prompt:frozen.prompt,version:frozen.version};
 }
 return {prompt:compileSinglePortraitPrompt(job.style_id,job.references,job.notes,slot),version:PORTRAIT_PROMPT_VERSION};
}
