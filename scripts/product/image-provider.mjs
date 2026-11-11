/**
 * Verified wire contract (read 2026-10-28): OpenAI official openai-node source
 * src/resources/images.ts blob 3b47243b3eb92810a58bf581279791ee731af831;
 * src/internal/uploads.ts blob 9a36dbae5ed8b71b89c59f52f11efc316a9eaa26.
 * https://github.com/openai/openai-node/blob/main/src/resources/images.ts
 * https://github.com/openai/openai-node/blob/main/src/internal/uploads.ts
 * Live account availability, pricing and real generation are NOT proven by this
 * source review. Readiness below means locally configured, not live-tested.
 * Ark wire contract read in official IAB docs 2026-10-29:
 * https://docs.volcengine.com/docs/ark/image-generation-tutorial?lang=zh
 * Explicit model snapshots, data-URL inputs and b64_json output. No live call made.
 */
import {Buffer} from 'node:buffer';
import {readBoundedResponse} from './image-http.mjs';
const ENDPOINT='https://api.openai.com/v1/images/edits';
const ARK_ENDPOINT='https://ark.cn-beijing.volces.com/api/v3/images/generations';
const MODELS=new Set(['gpt-image-2.5-sunburst-2026-09-08','gpt-image-2.5-flare-2026-09-08']);
const ARK_MODELS=new Set(['doubao-seedream-5-0-pro-260628','doubao-seedream-5-0-flash-260915']);
const QUALITIES=new Set(['low','medium','high','xhigh','max']);
const MAX_IMAGE_BYTES=10*1024*1024;
const MAX_BASE64_LENGTH=4*Math.ceil(MAX_IMAGE_BYTES/3);
const MAX_RESPONSE_BYTES=MAX_BASE64_LENGTH+256*1024;
const positive=value=>typeof value==='string'&&/^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):0;
/** @typedef {'provider_disabled'|'provider_input'|'provider_aborted'|'provider_timeout'|'provider_redirect'|'provider_http'|'provider_transport'|'provider_response'} ProviderErrorCode */
export class ProviderError extends Error {
 /** @param {string} message @param {{code?:ProviderErrorCode,uncertain?:boolean,httpStatus?:number|null,providerRequestId?:string|null}} [details] */
 constructor(message,{code='provider_input',uncertain=false,httpStatus=null,providerRequestId=null}={}){
  super(message);this.name='ProviderError';this.uncertain=uncertain;this.code=code;this.httpStatus=httpStatus;this.providerRequestId=providerRequestId;
 }
}
function disabled(){
 return Object.freeze({ready:false,provider:null,model:null,reason:'authorization_or_configuration_required',message:'自动生图未启用：需配置已授权的账号、密钥、模型与预算；可继续导入真实作品。',async generate(){throw new ProviderError('Image provider disabled: authorization or configuration missing',{code:'provider_disabled'})}});
}

/** Never enables on an API key alone, and never supports arbitrary destinations. */
export function createImageProvider(environment={}, {fetchImpl=fetch,timeoutMs=300_000}={}){
 const provider=environment.PORTRAIT_PROVIDER,ark=provider==='ark';
 const model=environment.PORTRAIT_MODEL,quality=environment.PORTRAIT_IMAGE_QUALITY,key=ark?environment.ARK_API_KEY:environment.OPENAI_API_KEY;
 const budgetCurrency=environment.PORTRAIT_BUDGET_CURRENCY??'USD';
 const currencyValid=['USD','CNY'].includes(budgetCurrency);
 const budget=positive(environment[`PORTRAIT_BUDGET_MICRO_${budgetCurrency}`]),maxCost=positive(environment[`PORTRAIT_CALL_MAX_MICRO_${budgetCurrency}`]);
 const configuration=ark?ARK_MODELS.has(model)&&environment.PORTRAIT_AUTHORIZED_PROVIDER==='ark':provider==='openai'&&MODELS.has(model)&&QUALITIES.has(quality);
 const ready=environment.PORTRAIT_GENERATION_ENABLED==='true'&&configuration
  &&environment.PORTRAIT_EXTERNAL_CALLS_AUTHORIZED==='true'&&environment.PORTRAIT_PROVIDER_ACCOUNT_VERIFIED==='true'&&environment.PORTRAIT_CALL_COST_VERIFIED==='true'
  &&typeof key==='string'&&key.length>=16&&!/[\s\x00-\x1f]/.test(key)
  &&typeof environment.PORTRAIT_WORKER_SECRET==='string'&&environment.PORTRAIT_WORKER_SECRET.length>=32
  &&currencyValid&&maxCost>0&&budget>=maxCost;
 if(!ready)return disabled();
 const boundedTimeout=Number.isFinite(timeoutMs)&&timeoutMs>0?Math.min(timeoutMs,300_000):300_000;
 const supportedAspectRatios=Object.freeze([ark?'3:4':'2:3']),maxImages=ark?9:8;
 return Object.freeze({
  ready:true,provider,model,budgetCurrency,reason:null,supportedAspectRatios,maxImages,requiresExplicitAspectRatio:ark,
  message:'官方编辑协议适配器已配置；真实账号调用及成片质量仍需实际验证。',
  async generate({prompt,images,outputAspectRatio,signal,mode='edit',watermark}={}){
   if(watermark!==undefined&&(typeof watermark!=='boolean'||!ark))throw new ProviderError('Unsupported or invalid watermark option');
   if(signal?.aborted)throw new ProviderError('Image request aborted before dispatch',{code:'provider_aborted'});
   // Existing OpenAI tasks have no aspect field. New sample recipes must never
   // silently become a different crop or use an unverified model capability.
   if((ark||outputAspectRatio!==undefined)&&!supportedAspectRatios.includes(outputAspectRatio))throw new ProviderError('Unsupported image output aspect ratio');
   if(typeof prompt!=='string'||!prompt.trim()||prompt.length>32000)throw new ProviderError('Invalid image prompt');
   if(!['edit','text'].includes(mode)||(mode==='text'&&!ark))throw new ProviderError('Unsupported image mode');
   if(!Array.isArray(images)||(mode==='text'?images.length!==0:images.length<1||images.length>maxImages))throw new ProviderError('Invalid image input');
   const form=new FormData(),dataUrls=[];
   for(let index=0;index<images.length;index++){
    const image=images[index],extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[image?.mime];
    if(!extension||!(image.bytes instanceof Uint8Array)||!image.bytes.byteLength||image.bytes.byteLength>MAX_IMAGE_BYTES)throw new ProviderError('Invalid image input');
    if(ark)dataUrls.push(`data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`);
    else form.append('image[]',new Blob([image.bytes],{type:image.mime}),`reference-${index+1}.${extension}`);
   }
   form.set('model',model);form.set('prompt',prompt);form.set('n','1');form.set('output_format','png');form.set('size','1024x1536');form.set('quality',quality);
   const body=ark?JSON.stringify({model,prompt,...(mode==='edit'?{image:dataUrls}:{}),size:'1344x1792',response_format:'b64_json',output_format:'png',watermark:watermark===undefined?true:watermark}):form;
   const controller=new AbortController();
   const abort=()=>controller.abort(new ProviderError('Image request aborted',{code:'provider_aborted',uncertain:true}));
   if(signal?.aborted)throw new ProviderError('Image request aborted before dispatch',{code:'provider_aborted'});
   signal?.addEventListener('abort',abort,{once:true});
   let rejectAbort;
   const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',rejectAbort,{once:true})});
   const timer=setTimeout(()=>controller.abort(new ProviderError('Image request timeout',{code:'provider_timeout',uncertain:true})),boundedTimeout);
   try{
    const operation=(async()=>{
     // Workers accepts only follow/manual. Reject every non-OK response below
     // without following Location, so credentials and photos stay at the fixed endpoint.
     const response=await fetchImpl(ark?ARK_ENDPOINT:ENDPOINT,{method:'POST',body,headers:{Authorization:`Bearer ${key}`,...ark?{'Content-Type':'application/json'}:{}},redirect:'manual',signal:controller.signal});
     if(controller.signal.aborted)throw controller.signal.reason;
     const httpStatus=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:null;
     const requestId=response.headers.get('x-request-id');
     const providerRequestId=requestId&&/^[a-zA-Z0-9_-]{1,200}$/.test(requestId)&&!requestId.includes(key)?requestId:null;
     const responseDetails={httpStatus,providerRequestId,uncertain:true};
     if(!response.ok){
      try{await response.body?.cancel()}catch{}
      const code=httpStatus!==null&&httpStatus>=300&&httpStatus<400?'provider_redirect':'provider_http';
      throw new ProviderError(`Image provider HTTP ${httpStatus??'error'}`,{...responseDetails,code});
     }
     const invalidResponse=message=>new ProviderError(message,{...responseDetails,code:'provider_response'});
     let raw;
     try{raw=await readBoundedResponse(response,MAX_RESPONSE_BYTES)}catch{throw invalidResponse('Image response size exceeds limit or transport failed')}
     if(controller.signal.aborted)throw controller.signal.reason;
     let payload;try{payload=JSON.parse(raw.toString('utf8'))}catch{throw invalidResponse('Invalid image provider JSON')}
     if(!Array.isArray(payload?.data)||payload.data.length!==1)throw invalidResponse('Invalid image provider output count');
     const encoded=payload.data[0]?.b64_json;
     if(typeof encoded!=='string'||!encoded.length||encoded.length>MAX_BASE64_LENGTH||encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw invalidResponse('Invalid image output encoding or size');
     const bytes=Buffer.from(encoded,'base64');
     if(!bytes.length||bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==encoded)throw invalidResponse('Invalid image output size');
     // Complete decoding happens in executeClaim before private storage/import.
     const usage=payload.usage;
     if(usage!==undefined&&(!usage||typeof usage!=='object'||Array.isArray(usage)||JSON.stringify(usage).length>8192))throw invalidResponse('Invalid image usage evidence');
     return {bytes,model,...(providerRequestId?{providerRequestId}:{}),...(usage!==undefined?{usage}:{})};
    })();
    return await Promise.race([operation,aborted]);
   }catch(error){
    if(error instanceof ProviderError)throw error;
    // Fetch errors may contain URLs, proxy diagnostics or echoed secrets. No raw
    // upstream error body/message is persisted or returned to a user.
    throw new ProviderError('Image provider transport failed; outcome uncertain',{code:'provider_transport',uncertain:true});
   }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',rejectAbort)}
  }
 });
}
