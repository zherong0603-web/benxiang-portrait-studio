/** Local executor primitives. Optional private outbox retains generated output for delivery recovery. */
import sharp from 'sharp';
import {readBoundedResponse} from './image-http.mjs';
export {readBoundedResponse} from './image-http.mjs';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import samples from '../../lib/photography-samples.json' with {type:'json'};

const MAX_BYTES=10*1024*1024;
const MAX_PIXELS=24_000_000;
sharp.cache(false);
sharp.concurrency(1);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const stopped=signal=>{if(signal?.aborted)throw signal.reason??new Error('Operation aborted')};

/** Samples are checked public system assets, never user-supplied paths or remote URLs. */
export async function loadStyleReference(reference,{readFileImpl=readFile}={}){
 const allowed=Object.values(samples).find(sample=>sample.id===reference?.id);
 if(!allowed||['path','sha256','width','height'].some(key=>reference[key]!==allowed[key]))throw new Error('Invalid frozen sample');
 const bytes=await readFileImpl(new URL(`../../public${allowed.path}`,import.meta.url));
 if(bytes.byteLength>MAX_BYTES||digest(bytes)!==reference.sha256)throw new Error('Sample image changed');
 return bytes;
}

/** Complete pixel decode, auto-orientation and metadata-free JPEG; not a likeness check. */
export async function normalizeImage(input,{signal}={}){
 stopped(signal);
 if(!(input instanceof Uint8Array)||!input.byteLength||input.byteLength>MAX_BYTES)throw new Error('Invalid image size');
 const bytes=Buffer.from(input.buffer,input.byteOffset,input.byteLength);
 const allowed=(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)||(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP');
 if(!allowed)throw new Error('Unsupported image format');
 try{
  const decoder=sharp(bytes,{failOn:'warning',limitInputPixels:MAX_PIXELS,limitInputChannels:4,sequentialRead:true});
  const meta=await decoder.metadata();
  if(!['jpeg','png','webp'].includes(meta.format)||(meta.pages??1)>1)throw new Error('Unsupported image format');
  if(!meta.width||!meta.height||meta.width>8192||meta.height>8192||meta.width*meta.height>MAX_PIXELS)throw new Error('Invalid image dimensions');
  stopped(signal);
  // No keepMetadata/withMetadata: sharp strips EXIF, GPS, XMP and ICC by default.
  const {data,info}=await decoder.rotate().flatten({background:'#ffffff'}).toColourspace('srgb').jpeg({quality:95,chromaSubsampling:'4:4:4'}).timeout({seconds:20}).toBuffer({resolveWithObject:true});
  stopped(signal);
  if(!data.length||data.length>MAX_BYTES)throw new Error('Normalized image size exceeds limit');
  return {bytes:data,mime:'image/jpeg',width:info.width,height:info.height,sha256:digest(data)};
 }catch(error){
  if(signal?.aborted)throw signal.reason??new Error('Operation aborted');
  if(error instanceof Error&&/format|dimensions|size/.test(error.message))throw error;
  throw new Error('Image decode failed');
 }
}

export function validateLoopbackOrigin(value){
 let url;try{url=new URL(value)}catch{throw new Error('Worker requires a loopback origin')}
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Worker requires a bare HTTP loopback origin');
 return url.origin;
}

/** Separate credentials stay on the selected fixed authority, never a redirect. */
export function createServiceClient({origin,secret,remoteSiteEnabled=false,siteAccessToken,fetchImpl=fetch,timeoutMs=30_000}){
 if(remoteSiteEnabled||siteAccessToken!==undefined)throw new Error('Remote worker transport is unavailable in this edition');
 const base=validateLoopbackOrigin(origin);
 if(typeof secret!=='string'||secret.length<32||/[\r\n]/.test(secret))throw new Error('Worker service secret must contain at least 32 characters');
 async function request(path,{method='GET',body,signal,json=false,leaseToken}={}){
  const controller=new AbortController();
  const abort=()=>controller.abort(signal.reason??new Error('Operation aborted'));
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(new Error('Worker service timeout')),timeoutMs);
  try{
   let response;
   try{response=await fetchImpl(`${base}${path}`,{method,body,signal:controller.signal,redirect:'error',headers:{Authorization:`Bearer ${secret}`,...(leaseToken?{'X-Portrait-Lease':leaseToken}:{}),...(json?{'Content-Type':'application/json'}:{})}})}
   catch{throw new Error(controller.signal.aborted?'Worker service timeout or abort':'Worker service transport failed')}
   if(controller.signal.aborted)throw new Error('Worker service timeout or abort');
   if(!response.ok){try{await response.body?.cancel()}catch{}throw new Error(`Worker service HTTP ${response.status}`)}
   let bytes;
   try{bytes=await readBoundedResponse(response,json?128*1024:MAX_BYTES)}
   catch(error){throw new Error(controller.signal.aborted?'Worker service timeout or abort':error?.message==='Response size exceeds limit'?'Response size exceeds limit':'Worker service transport failed')}
   if(controller.signal.aborted)throw new Error('Worker service timeout or abort');
   if(!json)return bytes;
   let value;try{value=JSON.parse(bytes.toString('utf8'))}catch{throw new Error('Worker service returned invalid JSON')}
   if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Worker service returned invalid JSON');
   return value;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
 }
 return {
  action:(value,{signal}={})=>request('/api/generation/worker',{method:'POST',json:true,body:JSON.stringify(value),signal}),
  reference:(claim,reference,{signal}={})=>{
   // Ignore supplied URLs: authority and route are fixed by this executable.
   const query=new URLSearchParams({attemptId:claim.attemptId,assetId:reference.id});
   return request(`/api/generation/worker/reference?${query}`,{signal,leaseToken:claim.leaseToken});
  },
  result:(claim,bytes,metadata,{signal}={})=>{
   const form=new FormData();form.set('attemptId',claim.attemptId);form.set('leaseToken',claim.leaseToken);form.set('file',new Blob([bytes],{type:'image/jpeg'}),'portrait.jpg');form.set('metadata',JSON.stringify(metadata));
   // Multipart request; response still parsed as JSON without overriding its boundary.
   return request('/api/generation/worker/result',{method:'POST',body:form,signal}).then(bytes=>{
    let value;try{value=JSON.parse(bytes.toString('utf8'))}catch{throw new Error('Worker service returned invalid result receipt')}
    if(typeof value?.assetId!=='string')throw new Error('Worker service returned invalid result receipt');return value;
   });
  }
 };
}

/** One claim, one external dispatch at most. Uncertainty is durable on the server. */
export async function executeClaim(claim,{service,provider,heartbeatMs=20_000,providerTimeoutMs=300_000,signal,outbox}={}){
 const controller=new AbortController();
 const abort=()=>controller.abort(signal.reason??new Error('Worker stopped'));
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 let dispatchPossible=false,heartbeatBusy=false,spooled=false;
 const images=[];
 const interval=setInterval(async()=>{
  if(heartbeatBusy||controller.signal.aborted)return;
  heartbeatBusy=true;
  try{await service.action({action:'heartbeat',attemptId:claim.attemptId,leaseToken:claim.leaseToken},{signal:controller.signal})}
  catch{controller.abort(new Error('Worker lease lost'))}
  finally{heartbeatBusy=false}
 },heartbeatMs);
 try{
  stopped(controller.signal);
  const six=claim.promptVersion==='portrait-six-v1';
  if(six){
   if(claim.inputPolicy!=='person-only'||claim.watermark!==false||claim.outputAspectRatio!=='3:4'||claim.styleReference!==undefined||claim.model!=='doubao-seedream-5-0-pro-260628'||!Array.isArray(claim.references)||claim.references.length<1||claim.references.length>3||claim.references.filter(r=>r.role==='anchor').length!==1||claim.references.some(r=>!['anchor','angle','expression','proportion'].includes(r.role))||new Set(claim.references.map(r=>r.id)).size!==claim.references.length)throw new Error('Invalid six-template contract');
  }else if(claim.inputPolicy!==undefined||claim.watermark!==undefined)throw new Error('Unexpected generation input policy');
  if(!provider?.ready)throw new Error('Image provider disabled');
  if(claim.provider!==provider.provider||claim.model!==provider.model)throw new Error('Provider configuration changed');
  if(!Array.isArray(claim.references)||claim.references.length<1||claim.references.length>8||typeof claim.prompt!=='string'||!claim.prompt)throw new Error('Invalid generation claim');
  if(provider.requiresExplicitAspectRatio===true&&claim.outputAspectRatio===undefined)throw new Error('Provider requires explicit output aspect ratio');
  if(claim.outputAspectRatio!==undefined){
   const inputCount=claim.references.length+(claim.styleReference?1:0);
   if(claim.outputAspectRatio!=='3:4'||(!six&&!claim.styleReference)||!Array.isArray(provider.supportedAspectRatios)||!provider.supportedAspectRatios.includes(claim.outputAspectRatio)||!Number.isInteger(provider.maxImages)||provider.maxImages<inputCount)throw new Error('Unsupported photography provider capability');
  }else if(claim.styleReference)throw new Error('Missing sample aspect contract');
  for(const reference of claim.references){
   const bytes=await service.reference(claim,reference,{signal:controller.signal});
   if(!/^[a-f0-9]{64}$/.test(reference.sha256)||digest(bytes)!==reference.sha256)throw new Error('Reference image changed');
   const normalized=await normalizeImage(bytes,{signal:controller.signal});
   images.push({...normalized,id:reference.id,role:reference.role});
  }
  if(claim.styleReference){
   const sampleBytes=await loadStyleReference(claim.styleReference);
   const normalized=await normalizeImage(sampleBytes,{signal:controller.signal});
   if(normalized.width!==claim.styleReference.width||normalized.height!==claim.styleReference.height)throw new Error('Sample dimensions changed');
   images.push({...normalized,id:claim.styleReference.id,role:'system-style'});
  }
  stopped(controller.signal);
  // Set before awaiting dispatch acknowledgement: an interrupted acknowledgement
  // must not cause an automatic retry. No provider request occurs without ack.
  if(outbox)await outbox.assertWritable();
  dispatchPossible=true;
  await service.action({action:'dispatch',attemptId:claim.attemptId,leaseToken:claim.leaseToken},{signal:controller.signal});
  stopped(controller.signal);
  const output=await boundedProviderCall(provider,{prompt:claim.prompt,images:[...images],...(claim.outputAspectRatio?{outputAspectRatio:claim.outputAspectRatio}:{}),...(six?{watermark:false}:{}),signal:controller.signal},controller,providerTimeoutMs);
  stopped(controller.signal);
  if(output.model!==claim.model)throw new Error('Unexpected provider model');
  const normalized=await normalizeImage(output.bytes,{signal:controller.signal});
  if(claim.outputAspectRatio==='3:4'&&normalized.width*4!==normalized.height*3)throw new Error('Provider output aspect mismatch');
  stopped(controller.signal);
  const metadata={model:output.model,providerOutputHash:digest(output.bytes),normalizationVersion:'portrait-jpeg-normalize-v1',...(claim.styleReference?{styleReferenceHash:claim.styleReference.sha256,outputAspectRatio:claim.outputAspectRatio,outputDimensions:{width:normalized.width,height:normalized.height}}:six?{inputPolicy:'person-only',watermark:false,outputAspectRatio:claim.outputAspectRatio,outputDimensions:{width:normalized.width,height:normalized.height}}:{}),...(output.providerRequestId?{providerRequestId:output.providerRequestId}:{}),...(output.usage?{usage:output.usage}:{}),inputHashes:images.map(image=>image.sha256)};
  if(outbox){await outbox.put(claim,normalized.bytes,metadata);spooled=true}
  const receipt=await service.result(claim,normalized.bytes,metadata,{signal:controller.signal});
  if(outbox)await outbox.remove(claim.attemptId);
  return {status:'saved',assetId:receipt.assetId};
 }catch{
  // Error details may contain signed URLs, prompts or secrets; persist categories only.
  const error=controller.signal.aborted?'执行已中止或租约失效':dispatchPossible?'外部执行结果未能确认，请核对后处理':'输入检查或提供商配置未通过，未调用外部服务';
  try{await service.action({action:'fail',attemptId:claim.attemptId,leaseToken:claim.leaseToken,uncertain:dispatchPossible,error})}catch{/* Server lease expiry independently recovers; do not force a revoked write. */}
  return {status:spooled?'pending_delivery':dispatchPossible?'needs_reconciliation':'failed'};
 }finally{clearInterval(interval);signal?.removeEventListener('abort',abort);images.length=0}
}

/** Losing an abort acknowledgement cannot pin the executor forever. */
async function boundedProviderCall(provider,input,controller,timeoutMs){
 let onAbort;
 const timer=setTimeout(()=>controller.abort(new Error('Provider request timeout')),timeoutMs);
 const aborted=new Promise((_,reject)=>{
  onAbort=()=>reject(controller.signal.reason??new Error('Operation aborted'));
  if(controller.signal.aborted)onAbort();else controller.signal.addEventListener('abort',onAbort,{once:true});
 });
 try{return await Promise.race([provider.generate(input),aborted])}
 finally{clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort)}
}
