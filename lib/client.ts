import type {Photo} from './portrait-contract';
import type {PublicJob as Job} from './public-portrait';

export class ApiError extends Error {
 constructor(public status:number,message:string){super(message);this.name='ApiError';}
}

type StudioResponse={error?:string;photo:Photo;job:Job;photos:Photo[];jobs:Job[];deleted?:boolean;cleanupPending?:boolean;privacy?:{pendingDeletions:number}};

export async function api<T=StudioResponse>(path:string,options:RequestInit={}):Promise<T> {
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),30000);
 let response:Response,raw:string;
 try{
  response=await fetch(path,{...options,signal:options.signal??controller.signal});
  raw=await response.text();
 }catch(error){
  if(error instanceof Error&&error.name==='AbortError')throw new ApiError(0,'请求等待超时。操作可能已保存，请刷新状态后再重试。');
  throw new ApiError(0,'网络连接失败，请检查连接后重试。');
 }finally{clearTimeout(timeout)}
 let data:T&{error?:string};
 try{data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid response')}catch{
  throw new ApiError(response.ok?0:response.status,response.status===401?'登录已失效，请重新登录。':'响应内容无法核对，操作可能已保存。请刷新核对状态，不要直接重复上传。');
 }
 if(!response.ok)throw new ApiError(response.status,response.status===401?'登录已失效，请重新登录。':data.error||'操作未完成，请重试。');
 return data;
}
