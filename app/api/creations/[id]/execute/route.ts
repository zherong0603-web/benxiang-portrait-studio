import {env,waitUntil} from 'cloudflare:workers';
import {ApiError,body,context,run} from '@/lib/server';
import {authorizeHostedExecution,authorizeHostedRecovery,executeHosted} from '@/lib/hosted-generation';
export const dynamic='force-dynamic';
type Params={params:Promise<{id:string}>};
export async function POST(request:Request,{params}:Params){return run(async()=>{
 const {db,bucket,owner}=await context(request,true);
 if(request.headers.get('origin')!==new URL(request.url).origin)throw new ApiError(403,'请从网站页面确认生成费用');
 const {id}=await params,input=await body(request),recoverOnly=input.recoverOnly===true,proof=await (recoverOnly?authorizeHostedRecovery:authorizeHostedExecution)(db,env,owner,id,input);
 const encoder=new TextEncoder(),stop=new AbortController();let closed=false,grace:ReturnType<typeof setTimeout>|undefined;
 // Disconnect is a bounded 30-second save grace, never a background completion guarantee.
 const disconnect=()=>{closed=true;if(!grace)grace=setTimeout(()=>stop.abort(),30000)};
 request.signal.addEventListener('abort',disconnect,{once:true});
 if(request.signal.aborted){request.signal.removeEventListener('abort',disconnect);throw new ApiError(409,'生成连接已停止')}
 const stream=new ReadableStream<Uint8Array>({start(controller){
  const write=(text:string)=>{if(!closed){try{controller.enqueue(encoder.encode(text))}catch{disconnect()}}};
  const pulse=setInterval(()=>write(': keepalive\n\n'),10000);
  const work=executeHosted(db,bucket,env,proof,event=>write(`data: ${JSON.stringify(event)}\n\n`),{signal:stop.signal,recoverOnly}).finally(()=>{clearInterval(pulse);if(grace)clearTimeout(grace);request.signal.removeEventListener('abort',disconnect);if(!closed){closed=true;controller.close()}});
  waitUntil(work);
 },cancel(){disconnect()}});
 return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'private, no-store, no-transform','X-Content-Type-Options':'nosniff'}});
})}
