import {ApiError} from './client';
import type {PublicCreationSession} from './public-portrait';

export type ModelCost={currency:'CNY';reservedMicro:number;estimatedMicro:number|null;actualMicro:null;status:'not-called'|'estimated'|'unknown'};
type Hooks={onSession:(session:PublicCreationSession)=>void;onCost?:(cost:ModelCost)=>void;recoverOnly?:boolean;signal?:AbortSignal;fetchImpl?:typeof fetch;timeoutMs?:number;idleMs?:number};
const message=(e:unknown)=>e instanceof Error?e.message:'生成连接已中断，请查看已保存的创作，不要重复提交。';
/** A missing file in one slot must not prevent finding other already-saved images. */
export async function checkSavedCreation(session:PublicCreationSession,hooks:Omit<Hooks,'recoverOnly'|'onCost'>){
 let found=0,unavailable=0;
 for(const slot of session.slots.filter(item=>['dispatched','needs_reconciliation'].includes(item.status))){
  if(hooks.signal?.aborted)throw new ApiError(0,'已停止检查已保存图片。');
  try{
   const current=await executeCreationSlot(session.id,slot.id,{...hooks,recoverOnly:true});
   if(current.results.some(result=>result.slotId===slot.id))found++;else unavailable++;
  }catch(error){if(error instanceof ApiError&&[401,403].includes(error.status))throw error;unavailable++;}
 }
 return {found,unavailable};
}
/** One explicit fee-confirmed request. A lost stream never retries an image call. */
export async function executeCreationSlot(sessionId:string,slotId:string,hooks:Hooks):Promise<PublicCreationSession>{
 const controller=new AbortController(),abort=()=>controller.abort(hooks.signal?.reason);
 if(hooks.signal?.aborted)abort();else hooks.signal?.addEventListener('abort',abort,{once:true});
 const total=setTimeout(()=>controller.abort(),hooks.timeoutMs??330000);let idle:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const resetIdle=()=>{clearTimeout(idle);idle=setTimeout(()=>controller.abort(),hooks.idleMs??45000)};
 let last:PublicCreationSession|null=null,done=false;
 try{
  resetIdle();
  const response=await(hooks.fetchImpl??fetch)(`/api/creations/${encodeURIComponent(sessionId)}/execute`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify(hooks.recoverOnly?{slotId,recoverOnly:true}:{slotId,chargeConsentVersion:'model-charge-v1',maxCostMicro:1000000}),signal:controller.signal});
  if(!response.ok){let error='生成请求未能完成，请查看原创作记录。';try{const data=await response.json() as {error?:unknown}|null;if(typeof data?.error==='string')error=data.error}catch{}throw new ApiError(response.status,response.status===401?'登录已失效，请重新登录。':error)}
  if(!response.headers.get('content-type')?.includes('text/event-stream')||!response.body)throw new ApiError(0,'生成响应无法核对，请查看已保存记录，不要重复提交。');
  reader=response.body.getReader();const decoder=new TextDecoder();let pending='',event='',totalBytes=0;
  const session=(value:unknown):PublicCreationSession=>{
   const s=value as PublicCreationSession;
   if(!s||s.id!==sessionId||!Array.isArray(s.jobs)||!Array.isArray(s.slots)||!Array.isArray(s.results)||typeof s.status!=='string')throw new ApiError(0,'生成状态与原创作不匹配，请核对原记录。');
   return s;
  };
  const emit=()=>{
   if(!event)return;let data:any;try{data=JSON.parse(event)}catch{throw new ApiError(0,'生成状态无法核对，请查看原创作记录。')}event='';
   if(!data||typeof data!=='object'||Array.isArray(data))throw new ApiError(0,'生成状态格式无效。');
   if(data.cost){const c=data.cost;if(c.currency!=='CNY'||!Number.isSafeInteger(c.reservedMicro)||c.reservedMicro<0||c.reservedMicro>1000000||c.actualMicro!==null||!(c.estimatedMicro===null||Number.isSafeInteger(c.estimatedMicro)&&c.estimatedMicro>=0&&c.estimatedMicro<=c.reservedMicro)||!['not-called','estimated','unknown'].includes(c.status))throw new ApiError(0,'费用回执无法核对，请保留原创作记录。');hooks.onCost?.(c)}
   if(data.type==='session'||data.type==='done'){last=session(data.session);hooks.onSession(last);if(data.type==='done')done=true}
   else if(data.type==='error')throw new ApiError(0,typeof data.error==='string'?data.error:'生成未能完成，请核对原记录。');
   else if(data.type!=='cost')throw new ApiError(0,'生成状态类型无法核对。');
  };
  const line=(value:string)=>{if(!value){emit();return}if(value.startsWith(':'))return;if(value.startsWith('data:')){event+=(event?'\n':'')+value.slice(5).replace(/^ /,'');if(event.length>256*1024)throw new ApiError(0,'生成状态过大，请核对原记录。')}};
  while(true){const part=await reader.read();if(part.done)break;resetIdle();totalBytes+=part.value.byteLength;if(totalBytes>2*1024*1024)throw new ApiError(0,'生成连接数据过多，请查看原记录。');pending+=decoder.decode(part.value,{stream:true});let end;while((end=pending.indexOf('\n'))>=0){line(pending.slice(0,end).replace(/\r$/,''));pending=pending.slice(end+1)}if(pending.length>256*1024)throw new ApiError(0,'生成状态过大，请核对原记录。')}
  pending+=decoder.decode();if(pending)line(pending.replace(/\r$/,''));emit();
  if(!done||!last)throw new ApiError(0,'生成连接已中断。创作已保存，请核对进度，不要重复提交。');
  return last;
 }catch(e){if(e instanceof ApiError)throw e;throw new ApiError(0,controller.signal.aborted?'生成连接等待超时。请查看原记录，不要重复调用。':message(e));}
 finally{clearTimeout(total);clearTimeout(idle);hooks.signal?.removeEventListener('abort',abort);try{await reader?.cancel()}catch{}}
}
