/** Payment transport. Credentials stay server-side; never trust a browser's payment result. */
import {CommerceError,type CommerceSettings,type OrderRecord,type VerifiedPaymentEvent} from './commerce-contract';
import {readBoundedBody} from './privacy';
import qrcode from 'qrcode-generator';

type Settings=CommerceSettings&{DB?:D1Database};
type Session={id:string;url:string;expiresAt:string;provider:'stripe'|'wechat'};
type Dependencies={fetch?:typeof globalThis.fetch};
export class WechatProviderError extends CommerceError {
 constructor(public providerStatus:number,public providerCode:string,public providerRequestId:string|null){super(502,'微信支付未接受操作，请主动查单或凭请求编号联系工作室核对')}
}
function paymentDescription(value:unknown){let result='';for(const char of String(value)){if(new TextEncoder().encode(result+char).length>120)break;result+=char}return result||'肖像服务'}
const encoder=new TextEncoder();
const modeOf=(s:Settings)=>s.COMMERCE_MODE==='test'?'test':s.COMMERCE_MODE==='live'&&s.COMMERCE_LIVE_ENABLED==='true'?'live':'disabled';
function originOf(s:Settings,requestOrigin?:string){
 let url:URL;try{url=new URL(s.COMMERCE_ALLOWED_ORIGIN||'')}catch{throw new CommerceError(503,'尚未配置工作室的支付回调域名')}
 const local=modeOf(s)==='test'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if((url.protocol!=='https:'&&!(local&&url.protocol==='http:'))||url.username||url.password||url.pathname!=='/'||url.search||url.hash||requestOrigin&&requestOrigin!==url.origin)throw new CommerceError(503,'支付回调域名配置不匹配');
 return url.origin;
}
export function paymentConfigured(s:Settings){
 const provider=s.COMMERCE_PAYMENT_PROVIDER||'wechat';
 const providerLabel=provider==='wechat'?'微信支付 Native':provider==='stripe'?'Stripe Checkout':'未配置';
 const result=(configured:boolean,message:string)=>({configured,message,provider:['wechat','stripe'].includes(provider)?provider as 'wechat'|'stripe':null,providerLabel,checkoutKind:provider==='wechat'?'qr':'redirect'});
 if(modeOf(s)==='disabled')return result(false,'收费尚未开放。');
 try{originOf(s)}catch{return result(false,'尚未配置允许的支付回调域名。')}
 if(provider==='wechat'){
  if(modeOf(s)!=='live')return result(false,'微信支付需要正式商户。本地订单测试可继续，本站不会伪造微信付款成功。');
  if(!s.WECHAT_APP_ID||!s.WECHAT_MCH_ID||!s.WECHAT_MCH_SERIAL||!s.WECHAT_PRIVATE_KEY||encoder.encode(s.WECHAT_API_V3_KEY||'').length!==32||!s.WECHAT_PLATFORM_KEY_ID||!s.WECHAT_PLATFORM_PUBLIC_KEY)return result(false,'微信商户及通知验签密钥尚未配置，暂不能收款。');
  return result(true,'微信支付商户已配置；付款以服务器验签通知或主动查单为准。');
 }
 if(provider==='stripe'){
  const prefix=modeOf(s)==='test'?'sk_test_':'sk_live_';
  if(!s.STRIPE_SECRET_KEY?.startsWith(prefix)||!s.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_'))return result(false,'Stripe 对应模式的密钥及回调签名密钥尚未配置。');
  return result(true,modeOf(s)==='test'?'Stripe 沙箱测试，不会形成真实收入。':'付款以服务器验证为准。');
 }
 return result(false,'尚未配置受支持的支付渠道。');
}
function decode64(value:string){try{if(!/^[A-Za-z0-9+/]*={0,2}$/.test(value)||value.length%4)throw new Error();return Uint8Array.from(atob(value),c=>c.charCodeAt(0))}catch{throw new CommerceError(400,'支付签名数据无效')}}
async function pemKey(value:string|undefined,type:'private'|'public'){
 if(!value)throw new CommerceError(503,'支付签名密钥未配置');
 try{const pem=value.replace(/\\n/g,'\n').replace(/-----[^-]+-----/g,'').replace(/\s/g,'');return await crypto.subtle.importKey(type==='private'?'pkcs8':'spki',decode64(pem),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,type==='private'?['sign']:['verify'])}catch{throw new CommerceError(503,'支付签名密钥格式无效，请配置 PKCS8 私钥或 SPKI 公钥')}
}
const b64=(bytes:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
async function wechatAuthorization(s:Settings,method:string,path:string,body:string){
 const timestamp=Math.floor(Date.now()/1000).toString(),nonce=crypto.randomUUID().replace(/-/g,'');
 const signature=b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',await pemKey(s.WECHAT_PRIVATE_KEY,'private'),encoder.encode(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`)));
 return `WECHATPAY2-SHA256-RSA2048 mchid="${s.WECHAT_MCH_ID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${s.WECHAT_MCH_SERIAL}",signature="${signature}"`;
}
async function verifyWechatSignature(headers:Headers,raw:string,s:Settings){
 const time=headers.get('wechatpay-timestamp')||'',nonce=headers.get('wechatpay-nonce')||'',signature=headers.get('wechatpay-signature')||'',serial=headers.get('wechatpay-serial')||'';
 if(!/^\d{10}$/.test(time)||Math.abs(Date.now()/1000-Number(time))>300||!nonce||nonce.length>128||/[\r\n]/.test(nonce)||serial!==s.WECHAT_PLATFORM_KEY_ID)throw new CommerceError(400,'微信支付通知或响应签名信息无效');
 const ok=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',await pemKey(s.WECHAT_PLATFORM_PUBLIC_KEY,'public'),decode64(signature),encoder.encode(`${time}\n${nonce}\n${raw}\n`));
 if(!ok)throw new CommerceError(400,'微信支付签名验证失败');
}
async function providerRequest(url:string,init:RequestInit,dependencies:Dependencies){
 try{return await (dependencies.fetch??globalThis.fetch)(url,{...init,redirect:'error',signal:AbortSignal.timeout(20000)})}catch{throw new CommerceError(503,'支付服务未返回确定结果。请刷新或主动查单；不要重复创建订单。')}
}
async function readResponse(response:Response){
 const raw=new TextDecoder().decode(await readBoundedBody(new Request('https://response.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),256*1024));
 return raw;
}
function parseObject(raw:string){try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value as Record<string,any>}catch{throw new CommerceError(502,'支付服务响应格式无效，订单仍需核对')}
}
async function wechatRequest(s:Settings,method:string,path:string,payload:unknown,dependencies:Dependencies){
 const body=payload===undefined?'':JSON.stringify(payload);
 const response=await providerRequest(`https://api.mch.weixin.qq.com${path}`,{method,headers:{Authorization:await wechatAuthorization(s,method,path,body),Accept:'application/json','Content-Type':'application/json','Wechatpay-Serial':s.WECHAT_PLATFORM_KEY_ID||''},...(body?{body}:{})},dependencies);
 const raw=await readResponse(response);
 if(!response.ok){
  // A generic/unsigned 404 is never proof that no payment exists.
  await verifyWechatSignature(response.headers,raw,s);
  const error=parseObject(raw),code=typeof error.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:'UNKNOWN';
  const requestId=response.headers.get('request-id');
  throw new WechatProviderError(response.status,code,requestId&&/^[A-Za-z0-9_:-]{1,128}$/.test(requestId)?requestId:null);
 }
 await verifyWechatSignature(response.headers,raw,s);
 return raw?parseObject(raw):{};
}
export async function wechatOrderId(order:Pick<OrderRecord,'id'|'checkout_attempt'>){
 const hash=await crypto.subtle.digest('SHA-256',encoder.encode(`${order.id}:${order.checkout_attempt}`));
 return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
}
function checkedStripeSession(data:Record<string,any>,order:OrderRecord){
 if(data.object!=='checkout.session'||data.livemode!==(order.mode==='live')||data.mode!=='payment'||data.client_reference_id!==order.id||data.metadata?.orderId!==order.id||Number(data.metadata?.checkoutAttempt)!==order.checkout_attempt||data.metadata?.mode!==order.mode||data.amount_total!==order.amount_minor||data.currency!==order.currency)throw new CommerceError(502,'支付会话与订单不匹配');
}
export async function createCheckout({order,origin,env:s}:{order:OrderRecord;origin:string;env:Settings},dependencies:Dependencies={}):Promise<Session>{
 const config=paymentConfigured(s);if(!config.configured)throw new CommerceError(503,config.message);
 const canonical=originOf(s,origin);if(order.mode!==modeOf(s))throw new CommerceError(409,'订单与支付模式不匹配');
 const pack=JSON.parse(order.package_snapshot);let expiresAt=order.checkout_expires_at||new Date(new Date(order.updated_at).getTime()+30*60*1000).toISOString();
 if(config.provider==='wechat'){
  if(order.currency!=='cny')throw new CommerceError(400,'微信支付套餐必须使用人民币');
  const id=await wechatOrderId(order);
  if(Date.parse(expiresAt)<=Date.now()){
   // Reissue only the SAME merchant order number after authenticated absence.
   // Never release an uncertain payment into a new attempt or infer cancellation.
   try{await wechatRequest(s,'GET',`/v3/pay/transactions/out-trade-no/${id}?mchid=${encodeURIComponent(s.WECHAT_MCH_ID!)}`,undefined,dependencies);throw new CommerceError(409,'原支付单存在，请先主动核对付款状态')}
   catch(error){if(!(error instanceof WechatProviderError)||error.providerStatus!==404||error.providerCode!=='ORDER_NOT_EXIST')throw error;}
   if(!s.DB)throw new CommerceError(503,'支付恢复数据库未就绪');
   const renewedAt=new Date().toISOString(),renewedExpiry=new Date(Date.parse(renewedAt)+30*60*1000).toISOString();
   await s.DB.prepare("UPDATE orders SET checkout_expires_at=?,updated_at=? WHERE id=? AND owner_id=? AND checkout_attempt=? AND provider='wechat' AND payment_status='checkout_pending' AND (checkout_expires_at IS NULL OR checkout_expires_at<=?)").bind(renewedExpiry,renewedAt,order.id,order.owner_id,order.checkout_attempt,renewedAt).run();
   const current=await s.DB.prepare('SELECT checkout_attempt,payment_status,checkout_expires_at FROM orders WHERE id=? AND owner_id=?').bind(order.id,order.owner_id).first<OrderRecord>();
   if(!current||current.checkout_attempt!==order.checkout_attempt||current.payment_status!=='checkout_pending'||!current.checkout_expires_at||Date.parse(current.checkout_expires_at)<=Date.now())throw new CommerceError(409,'支付恢复状态已变化，请刷新');
   expiresAt=current.checkout_expires_at;
  }
  const data=await wechatRequest(s,'POST','/v3/pay/transactions/native',{appid:s.WECHAT_APP_ID,mchid:s.WECHAT_MCH_ID,description:paymentDescription(pack.name),out_trade_no:id,time_expire:expiresAt,attach:JSON.stringify({orderId:order.id,attempt:order.checkout_attempt}),notify_url:`${canonical}/api/payments/webhook`,amount:{total:order.amount_minor,currency:'CNY'}},dependencies);
  if(typeof data.code_url!=='string'||!data.code_url.startsWith('weixin://wxpay/bizpayurl?'))throw new CommerceError(502,'微信支付未返回有效付款码，请主动查单');
  return {id,url:data.code_url,expiresAt,provider:'wechat'};
 }
 const form=new URLSearchParams({mode:'payment',success_url:`${canonical}/?order=${encodeURIComponent(order.id)}&checkout=returned`,cancel_url:`${canonical}/?order=${encodeURIComponent(order.id)}&checkout=cancelled`,client_reference_id:order.id,'payment_method_types[0]':'card','line_items[0][quantity]':'1','line_items[0][price_data][currency]':order.currency,'line_items[0][price_data][unit_amount]':String(order.amount_minor),'line_items[0][price_data][product_data][name]':String(pack.name),'metadata[orderId]':order.id,'metadata[checkoutAttempt]':String(order.checkout_attempt),'metadata[mode]':order.mode,expires_at:String(Math.floor(Date.parse(expiresAt)/1000))});
 const response=await providerRequest('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:`Bearer ${s.STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':`portrait:${order.id}:${order.mode}:${order.checkout_attempt}`},body:form},dependencies);
 if(!response.ok){await response.body?.cancel();throw new CommerceError(502,'支付服务拒绝创建会话，请核对商户配置')}
 const data=parseObject(await readResponse(response));checkedStripeSession(data,order);
 if(typeof data.id!=='string'||typeof data.url!=='string'||!data.url.startsWith('https://checkout.stripe.com/'))throw new CommerceError(502,'支付服务未返回有效会话');
 return {id:data.id,url:data.url,expiresAt:new Date(data.expires_at*1000).toISOString(),provider:'stripe'};
}
export function checkoutQrSvg(url:string|null){
 if(!url?.startsWith('weixin://wxpay/bizpayurl?')||url.length>1024)return undefined;
 const qr=qrcode(0,'M');qr.addData(url);qr.make();return qr.createSvgTag({cellSize:6,margin:4,scalable:true});
}
async function stripeEvent(request:Request,s:Settings):Promise<VerifiedPaymentEvent|null>{
 if(!s.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_'))throw new CommerceError(503,'回调签名密钥未配置');
 const raw=new TextDecoder().decode(await readBoundedBody(request,256*1024));
 const entries=(request.headers.get('stripe-signature')||'').split(',').map(part=>part.split('='));
 const timestamp=entries.find(([k])=>k==='t')?.[1]||'',signatures=entries.filter(([k])=>k==='v1').map(([,v])=>v);
 if(!/^\d{10}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300||!signatures.length)throw new CommerceError(400,'支付回调签名或时间无效');
 const key=await crypto.subtle.importKey('raw',encoder.encode(s.STRIPE_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 let valid=false;for(const signature of signatures){if(/^[0-9a-f]{64}$/.test(signature)){const bytes=Uint8Array.from(signature.match(/../g)!,x=>parseInt(x,16));valid=(await crypto.subtle.verify('HMAC',key,bytes,encoder.encode(`${timestamp}.${raw}`)))||valid}}
 if(!valid)throw new CommerceError(400,'支付回调签名验证失败');
 const data=parseObject(raw),session=data.data?.object;
 if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired','checkout.session.async_payment_failed'].includes(data.type))return null;
 if(!session||session.object!=='checkout.session'||session.mode!=='payment'||typeof data.id!=='string'||typeof data.livemode!=='boolean'||session.livemode!==data.livemode)throw new CommerceError(400,'支付回调会话无效');
 const paid=['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(data.type);
 if(paid&&session.payment_status!=='paid')return null;
 const metadata=session.metadata;
 if(!metadata?.orderId||session.client_reference_id!==metadata.orderId||metadata.mode!==(data.livemode?'live':'test')||!s.DB)throw new CommerceError(400,'支付回调订单标识无效');
 const order=await s.DB.prepare('SELECT owner_id FROM orders WHERE id=?').bind(metadata.orderId).first<{owner_id:string}>();
 if(!order)throw new CommerceError(404,'支付对应订单不存在');
 return {id:data.id,provider:'stripe',type:paid?'paid':data.type.endsWith('expired')?'expired':'failed',mode:data.livemode?'live':'test',orderId:metadata.orderId,ownerId:order.owner_id,checkoutAttempt:Number(metadata.checkoutAttempt),checkoutId:session.id,amountMinor:session.amount_total,currency:session.currency,paymentId:typeof session.payment_intent==='string'?session.payment_intent:undefined};
}
async function wechatTransaction(transaction:Record<string,any>,id:string,s:Settings,knownOrder?:OrderRecord):Promise<VerifiedPaymentEvent|null>{
 if(transaction.appid!==s.WECHAT_APP_ID||transaction.mchid!==s.WECHAT_MCH_ID||(transaction.trade_type!==undefined&&transaction.trade_type!=='NATIVE')||(!knownOrder&&transaction.trade_type!=='NATIVE'))throw new CommerceError(400,'微信支付商户或交易类型不匹配');
 if(transaction.trade_state!=='SUCCESS'&&!['CLOSED','REVOKED','PAYERROR'].includes(transaction.trade_state))return null;
 let attach:Record<string,any>|undefined;
 if(transaction.attach){try{attach=JSON.parse(transaction.attach)}catch{throw new CommerceError(400,'微信支付订单附加信息无效')}}
 if(!s.DB||(!knownOrder&&(!attach?.orderId||!Number.isSafeInteger(attach?.attempt))))throw new CommerceError(400,'微信支付订单标识无效');
 const order=knownOrder??await s.DB.prepare('SELECT * FROM orders WHERE id=?').bind(attach!.orderId).first<OrderRecord>();
 const attempt=knownOrder?knownOrder.checkout_attempt:attach!.attempt;
 if(!order||order.mode!=='live'||transaction.out_trade_no!==await wechatOrderId({...order,checkout_attempt:attempt})||(attach&&(attach.orderId!==order.id||attach.attempt!==attempt)))throw new CommerceError(409,'微信支付订单对应关系不匹配');
 // Closed queries may omit attach/trade_type. The signed merchant + exact stored out_trade_no
 // binds this response; never require success-only metadata to release an expired checkout.
 const amount=transaction.amount?.total??(transaction.trade_state==='SUCCESS'?undefined:order.amount_minor);
 const currency=String(transaction.amount?.currency||(transaction.trade_state==='SUCCESS'?'':'CNY')).toLowerCase();
 return {id,provider:'wechat',type:transaction.trade_state==='SUCCESS'?'paid':'expired',mode:'live',orderId:order.id,ownerId:order.owner_id,checkoutAttempt:attempt,checkoutId:transaction.out_trade_no,amountMinor:amount,currency,paymentId:transaction.transaction_id};
}
export async function verifyWebhook(request:Request,s:Settings):Promise<VerifiedPaymentEvent|null>{
 if((s.COMMERCE_PAYMENT_PROVIDER||'wechat')==='stripe')return stripeEvent(request,s);
 const raw=new TextDecoder().decode(await readBoundedBody(request,256*1024));await verifyWechatSignature(request.headers,raw,s);
 const event=parseObject(raw);if(event.event_type!=='TRANSACTION.SUCCESS')return null;
 const resource=event.resource;
 if(typeof event.id!=='string'||event.resource_type!=='encrypt-resource'||resource?.original_type!=='transaction'||resource?.algorithm!=='AEAD_AES_256_GCM'||typeof resource.nonce!=='string'||typeof resource.ciphertext!=='string'||encoder.encode(s.WECHAT_API_V3_KEY||'').length!==32)throw new CommerceError(400,'微信支付通知资源无效');
 let transaction:Record<string,any>;
 try{const key=await crypto.subtle.importKey('raw',encoder.encode(s.WECHAT_API_V3_KEY),{name:'AES-GCM'},false,['decrypt']);const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:encoder.encode(resource.nonce),additionalData:encoder.encode(resource.associated_data||''),tagLength:128},key,decode64(resource.ciphertext));transaction=parseObject(new TextDecoder().decode(decoded))}catch{throw new CommerceError(400,'微信支付通知解密失败')}
 if(transaction.trade_state!=='SUCCESS')throw new CommerceError(400,'微信支付通知未确认付款');
 return wechatTransaction(transaction,event.id,s);
}
/** Authenticated provider lookup repairs a lost webhook; it never trusts a browser return URL. */
export async function reconcilePayment({order,env:s}:{order:OrderRecord;env:Settings},dependencies:Dependencies={}):Promise<VerifiedPaymentEvent|null>{
 if(order.payment_status!=='checkout_pending')return null;
 const configured=paymentConfigured(s);
 if(!configured.configured||order.mode!==modeOf(s)||order.provider!==configured.provider)throw new CommerceError(503,'支付查单模式、渠道或密钥尚未就绪');
 if(order.provider==='stripe'){
  if(!order.provider_checkout_id)throw new CommerceError(409,'支付会话尚未确定，请重试取得原付款方式');
  const response=await providerRequest(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(order.provider_checkout_id)}`,{headers:{Authorization:`Bearer ${s.STRIPE_SECRET_KEY}`}},dependencies);
  if(!response.ok)throw new CommerceError(502,'支付查单失败，请稍后重试');
  const data=parseObject(await readResponse(response));checkedStripeSession(data,order);
  if(data.payment_status!=='paid'&&data.status!=='expired')return null;
  return {id:`query:${data.id}:${data.payment_status==='paid'?'paid':'expired'}`,provider:'stripe',type:data.payment_status==='paid'?'paid':'expired',mode:order.mode,orderId:order.id,ownerId:order.owner_id,checkoutAttempt:order.checkout_attempt,checkoutId:data.id,amountMinor:data.amount_total,currency:data.currency,paymentId:typeof data.payment_intent==='string'?data.payment_intent:undefined};
 }
 if(order.provider!=='wechat'||!paymentConfigured(s).configured)throw new CommerceError(503,'支付查单配置尚未就绪');
 const id=await wechatOrderId(order),path=`/v3/pay/transactions/out-trade-no/${id}?mchid=${encodeURIComponent(s.WECHAT_MCH_ID!)}`;
 let transaction=await wechatRequest(s,'GET',path,undefined,dependencies);
 if(transaction.trade_state==='NOTPAY'&&Date.parse(order.checkout_expires_at||new Date(Date.parse(order.updated_at)+30*60*1000).toISOString())<=Date.now()){
  await wechatRequest(s,'POST',`/v3/pay/transactions/out-trade-no/${id}/close`,{mchid:s.WECHAT_MCH_ID},dependencies);
  transaction=await wechatRequest(s,'GET',path,undefined,dependencies);
 }
 return wechatTransaction(transaction,`query:${id}:${transaction.trade_state}`,s,order);
}
