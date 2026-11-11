'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Check,ClipboardList,CreditCard,LoaderCircle,RefreshCw,ShieldCheck,ShoppingBag} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Checkbox} from '@/components/ui/checkbox';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {toast} from 'sonner';
import {api,ApiError} from '@/lib/client';
import type {PublicJob as Job} from '@/lib/public-portrait';
import {COMMERCE_TERMS_VERSION,type CommerceMode,type PortraitPackage,type PublicOrder} from '@/lib/commerce-contract';
import {PORTRAIT_CONSENT_VERSION} from '@/lib/privacy';

type OrderList={orders:PublicOrder[];catalog:PortraitPackage[];commerce:{mode:CommerceMode;configured:boolean;message:string;operator:boolean;provider?:string;providerLabel?:string;checkoutKind?:string}};
type Props={authenticated:boolean;signInHref:string;jobs:Job[];selectedJobId:string|null;onOpenJob:(job:Job)=>void;onOrdersChanged:()=>Promise<unknown>;onAuthExpired:()=>void};
const jsonBody=(body:unknown)=>({headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const paymentNames:Record<string,string>={unpaid:'未付款',checkout_pending:'等待付款确认',paid:'付款已确认',cancelled:'已取消'};
const fulfillmentNames:Record<string,string>={awaiting_payment:'付款后进入履约',queued:'等待经营者接单',in_progress:'创作中',delivered:'已交付'};

function price(amount:number,currency:string){
 try{
  const formatter=new Intl.NumberFormat('zh-CN',{style:'currency',currency});
  return formatter.format(amount/10**(formatter.resolvedOptions().maximumFractionDigits??2));
 }catch{return `${amount} 最小货币单位 ${currency}`}
}

function date(value:string){return new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}

export default function Orders({authenticated,signInHref,jobs,selectedJobId,onOpenJob,onOrdersChanged,onAuthExpired}:Props){
 const [data,setData]=useState<OrderList|null>(null),[queue,setQueue]=useState<PublicOrder[]>([]);
 const [loading,setLoading]=useState(authenticated),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState('');
 const [jobId,setJobId]=useState(selectedJobId??''),[packageId,setPackageId]=useState(''),[terms,setTerms]=useState(false);
 const [checkout,setCheckout]=useState<{orderId:string;url:string;qrImage?:string;native:boolean}|null>(null),[returnNotice,setReturnNotice]=useState(false);
 const lock=useRef(false),requestKey=useRef<{signature:string;value:string}|null>(null),mounted=useRef(true);
 const eligibleJobs=jobs.filter(job=>job.status==='ready'&&job.results.length===0&&!job.commerce&&!data?.orders.some(order=>order.jobId===job.id));
 const selectedJob=eligibleJobs.find(job=>job.id===jobId);
 const selectedPackage=data?.catalog.find(item=>item.id===packageId&&item.count===selectedJob?.count);
 const mode=data?.commerce.mode??'disabled';
 const packages=data?.catalog.filter(item=>item.count===selectedJob?.count)??[];

 const report=useCallback((error:unknown)=>{
  if(error instanceof ApiError&&error.status===401)onAuthExpired();
  const message=error instanceof Error?error.message:'订单操作未完成，请重试。';
  if(mounted.current)setError(message);
  return message;
 },[onAuthExpired]);

 const load=useCallback(async()=>{
  const next=await api<OrderList>('/api/orders');
  const operatorOrders=next.commerce.operator?await api<OrderList>('/api/orders?scope=operator'):null;
  if(mounted.current){setData(next);setQueue(operatorOrders?.orders.filter(order=>order.paymentStatus==='paid'&&order.fulfillmentStatus!=='delivered')??[]);}
  return next;
 },[]);

 useEffect(()=>{
  mounted.current=true;
  if(!authenticated)return()=>{mounted.current=false};
  let active=true;
  load().then(()=>{if(active){const query=new URLSearchParams(window.location.search);setReturnNotice(query.has('checkout')||query.has('order')||query.has('payment'))}}).catch(error=>{if(active)report(error)}).finally(()=>{if(active)setLoading(false)});
  return()=>{active=false;mounted.current=false};
 },[authenticated,load,report]);

 async function task(id:string,fn:()=>Promise<void>){
  if(lock.current)return;lock.current=true;setBusy(id);setError('');
  try{await fn()}catch(error){toast.error(report(error))}finally{lock.current=false;if(mounted.current)setBusy(null)}
 }

 function updateOrder(order:PublicOrder){
  setData(previous=>previous?{...previous,orders:[order,...previous.orders.filter(item=>item.id!==order.id)]}:previous);
  setQueue(previous=>previous.map(item=>item.id===order.id?order:item).filter(item=>item.fulfillmentStatus!=='delivered'));
 }

 async function createOrder(){await task('create',async()=>{
  if(!selectedJob||!selectedPackage||!terms||mode==='disabled')throw new Error('请先选择可用任务、服务并确认订单条款。');
  const signature=`${selectedJob.id}:${selectedPackage.id}:${COMMERCE_TERMS_VERSION}`;
  if(requestKey.current?.signature!==signature)requestKey.current={signature,value:crypto.randomUUID()};
  const result=await api<{order:PublicOrder}>('/api/orders',{method:'POST',...jsonBody({jobId:selectedJob.id,packageId:selectedPackage.id,idempotencyKey:requestKey.current.value,termsVersion:COMMERCE_TERMS_VERSION})});
  updateOrder(result.order);requestKey.current=null;setTerms(false);
  try{await onOrdersChanged()}catch(error){throw new Error(`订单已保存，作品状态刷新失败：${error instanceof Error?error.message:'请稍后刷新。'}`)}
  toast.success(result.order.mode==='test'?'测试订单已建立；尚未付款。':'订单已建立；尚未付款。');
 })}

 async function beginCheckout(order:PublicOrder){await task(order.id,async()=>{
  const result=await api<{order?:PublicOrder;checkoutUrl:string|null;checkoutQrSvg?:string}>(`/api/orders/${order.id}/checkout`,{method:'POST'});
  if(result.order)updateOrder(result.order);
  if(result.order?.paymentStatus==='paid'){
   setCheckout(null);await load();await onOrdersChanged();toast.success('服务器已确认付款状态');return;
  }
  if(!result.checkoutUrl)throw new Error('付款方式尚未准备完成，请刷新订单状态后重试。');
  const url=new URL(result.checkoutUrl);
  const native=url.protocol==='weixin:'&&url.hostname==='wxpay'&&url.pathname==='/bizpayurl';
  if(url.protocol!=='https:'&&!native)throw new Error('付款页面地址无效，请联系经营者。');
  if(native&&!result.checkoutQrSvg)throw new Error('付款码尚未准备完成，请稍后重试。');
  const qrImage=result.checkoutQrSvg?`data:image/svg+xml;base64,${btoa(Array.from(new TextEncoder().encode(result.checkoutQrSvg),byte=>String.fromCharCode(byte)).join(''))}`:undefined;
  setCheckout({orderId:order.id,url:url.href,qrImage,native});
  await load();
 })}

 async function action(order:PublicOrder,value:'cancel'|'start'|'deliver'){await task(order.id,async()=>{
  const result=await api<{order:PublicOrder}>(`/api/orders/${order.id}`,{method:'POST',...jsonBody({action:value})});
  updateOrder(result.order);
  if(value==='cancel')setCheckout(previous=>previous?.orderId===order.id?null:previous);
  try{await onOrdersChanged()}catch(error){throw new Error(`订单状态已保存，作品状态刷新失败：${error instanceof Error?error.message:'请稍后刷新。'}`)}
  toast.success(value==='cancel'?'订单已取消':value==='start'?'已开始履约':'服务器已核验交付条件并完成交付');
 })}

 async function openJob(order:PublicOrder){await task(order.id,async()=>{
  const result=await api<{order:PublicOrder;job:Job|null}>(`/api/orders/${order.id}`);
  if(!result.job)throw new Error('此订单未关联可查看的创作任务。');
  onOpenJob(result.job);
 })}

 async function reconcile(order:PublicOrder){await task(order.id,async()=>{
  const result=await api<{order:PublicOrder}>(`/api/orders/${order.id}`,{method:'POST',...jsonBody({action:'reconcile'})});
  updateOrder(result.order);
  if(result.order.paymentStatus!=='checkout_pending')setCheckout(previous=>previous?.orderId===order.id?null:previous);
  await onOrdersChanged();
  toast.info('已向服务器核对付款，请查看订单状态。');
 })}

 function orderCard(order:PublicOrder,operator=false){
  const paid=order.paymentStatus==='paid',cancelled=order.paymentStatus==='cancelled';
  return <article className="order-card" key={`${operator?'queue':'own'}-${order.id}`}>
   <div className="order-card-heading"><div><span className={`mode-badge ${order.mode}`}>{order.mode==='test'?'测试订单':'正式订单'}</span><h2>{order.package.name}</h2><p className="micro">{order.id} · {date(order.createdAt)}</p></div><strong className="order-price">{price(order.amountMinor,order.currency)}</strong></div>
   <dl className="order-statuses"><div><dt>付款状态</dt><dd><span className={`status-badge ${paid?'completed':cancelled?'cancelled':'review'}`}>{paymentNames[order.paymentStatus]??order.paymentStatus}</span></dd></div><div><dt>履约状态</dt><dd>{cancelled?'订单已取消，无需履约':fulfillmentNames[order.fulfillmentStatus]??order.fulfillmentStatus}</dd></div><div><dt>交付数量</dt><dd>{order.package.count} 张</dd></div></dl>
   {order.mode==='test'&&<p className="order-test-note">测试环境记录，不代表实收款项。请勿在测试付款页面输入真实银行卡资料。</p>}
   {order.paymentStatus==='checkout_pending'&&<p className="muted-text">付款页面已建立。付款结果以服务器验签后的状态为准；关闭或返回付款页不会确认付款。</p>}
   <div className="action-row">
    {order.jobId&&<Button variant="outline" disabled={!!busy} onClick={()=>void openJob(order)}><ClipboardList/>{operator?'查看素材与作品':'查看关联作品'}</Button>}
    {!operator&&!paid&&!cancelled&&<><Button disabled={!!busy||!data?.commerce.configured||mode==='disabled'||order.mode!==mode} onClick={()=>void beginCheckout(order)}><CreditCard/>{busy===order.id?'正在处理':order.paymentStatus==='checkout_pending'?'重新取得付款方式':'取得付款方式'}</Button><Button variant="ghost" disabled={!!busy} onClick={()=>void action(order,'cancel')}>取消订单</Button></>}
    {!operator&&order.paymentStatus==='checkout_pending'&&<Button variant="outline" disabled={!!busy} onClick={()=>void reconcile(order)}><RefreshCw/>主动核对付款</Button>}
    {operator&&paid&&order.fulfillmentStatus==='queued'&&<Button disabled={!!busy} onClick={()=>void action(order,'start')}>开始履约</Button>}
    {operator&&paid&&order.fulfillmentStatus==='in_progress'&&<Button disabled={!!busy} onClick={()=>void action(order,'deliver')}><Check/>核验并交付</Button>}
   </div>
   {!operator&&checkout?.orderId===order.id&&!paid&&!cancelled&&<div className="checkout-link">{checkout.qrImage&&<div className="checkout-qr"><img src={checkout.qrImage} alt={order.mode==='test'?'测试订单付款码':'微信支付订单付款码'}/><p>{checkout.native?'请使用另一台设备的微信扫码；当前为 Native 扫码支付，手机内支付尚未接入。':'请按付款页面提示扫码。'}</p></div>}{!checkout.native&&<a href={checkout.url} target="_blank" rel="noopener noreferrer">{order.mode==='test'?'打开测试付款页面':'打开安全付款页面'}<ArrowUpRight size={16}/></a>}<span>完成后返回此处，点击“刷新服务器状态”。扫码或返回页面不会确认付款。</span></div>}
  </article>;
 }

 return <div className="orders-page"><div className="page-heading"><div><div className="eyebrow">YOUR ORDERS / 03</div><h1>从创作设定，到确认交付。</h1><p>订单分别记录付款和履约状态，生成结果经逐张检查后交付。</p></div>{authenticated&&<Button variant="outline" disabled={loading||!!busy} onClick={()=>void task('refresh',async()=>{await load();toast.success('已刷新服务器状态')})}><RefreshCw/>刷新服务器状态</Button>}</div>
  {!authenticated?<div className="panel order-empty"><ShoppingBag size={28}/><h2>登录后查看你的订单</h2><p className="muted-text">订单仅对本人及经授权的履约经营者开放。</p><Button asChild><a href={signInHref} target="_top">登录工作室</a></Button></div>:<>
   {error&&<div role="alert" className="notice error-notice"><p>{error}</p><Button variant="outline" disabled={!!busy} onClick={()=>void task('retry',async()=>{await load()})}>重新读取</Button></div>}
   {loading&&!data?<p className="working-state"><LoaderCircle className="spin" size={16}/>正在读取订单</p>:data&&<>
    <div className={`commerce-notice ${mode==='test'?'test-notice':''}`} role="status"><ShieldCheck size={20}/><div><strong>{mode==='disabled'?'尚未开放下单':mode==='test'?'当前为支付测试环境':'正式订单环境'}</strong><p>{data.commerce.message||(!data.commerce.configured?'付款服务尚未配置，目前无法结账。':'付款状态由服务器核验后更新。')}{mode==='test'?' 本页测试订单与付款记录均不代表实际收入。':''}{data.commerce.providerLabel?` 付款通道：${data.commerce.providerLabel}。`:''}</p></div><span className={`mode-badge ${mode}`}>{mode.toUpperCase()}</span></div>
    {returnNotice&&<div className="notice"><p>已从付款流程返回。页面已重新读取服务器状态；若仍显示等待确认，请稍后点击刷新。浏览器返回参数不会确认付款。</p></div>}
    <section className="panel order-create" aria-labelledby="new-order-title"><div className="section-title"><span className="step"><ShoppingBag size={14}/></span><h2 id="new-order-title">选择任务与服务</h2></div><p className="muted-text">请先在创作工作台保存照片、风格与数量。商业下单仅适用于尚未导入作品的待创作任务。</p>
     {!data.catalog.length?<p className="order-unavailable">尚未开放下单：服务内容与价格尚未配置。请前往创作页面查看可用的生成服务和已有作品。</p>:<><div className="settings-row order-fields"><label>肖像任务<Select value={jobId} onValueChange={value=>{setJobId(value);setPackageId('');setTerms(false)}} disabled={!!busy||!eligibleJobs.length}><SelectTrigger aria-label="选择订单关联任务"><SelectValue placeholder="选择待创作任务"/></SelectTrigger><SelectContent>{eligibleJobs.map(job=><SelectItem key={job.id} value={job.id}>{job.title} · {job.count} 张</SelectItem>)}</SelectContent></Select></label><label>服务套餐<Select value={packageId} onValueChange={value=>{setPackageId(value);setTerms(false)}} disabled={!!busy||!selectedJob||!packages.length}><SelectTrigger aria-label="选择肖像服务"><SelectValue placeholder="选择匹配数量的服务"/></SelectTrigger><SelectContent>{packages.map(item=><SelectItem key={item.id} value={item.id}>{item.name} · {price(item.amountMinor,item.currency)}</SelectItem>)}</SelectContent></Select></label></div>
      {!eligibleJobs.length&&<p className="micro">暂无可下单任务。已导入作品、已完成或已关联订单的任务无法重复下单。</p>}{selectedJob&&!packages.length&&<p className="micro">当前任务为 {selectedJob.count} 张，尚无匹配数量的服务。请保留此任务，另建数量匹配的新任务。</p>}
      {selectedPackage&&<div className="order-summary"><strong>{selectedPackage.name} · {selectedPackage.count} 张 · {price(selectedPackage.amountMinor,selectedPackage.currency)}</strong><p>{selectedPackage.description}</p><p>生成服务可能存在相似度、肢体与服装偏差，交付前需检查。返修、退款与使用范围须在正式收费前由经营者明确；本页不作未经确认的承诺。</p></div>}
      <div className="consent-line"><Checkbox id="order-terms" checked={terms} disabled={!!busy||!selectedPackage} onCheckedChange={value=>setTerms(value===true)}/><label htmlFor="order-terms">我已确认任务、服务内容、张数与金额，并阅读<a href="/terms" target="_blank" rel="noreferrer">订单与交付说明</a>（订单条款版本 {COMMERCE_TERMS_VERSION}）和<a href="/privacy" target="_blank" rel="noreferrer">照片使用与隐私说明</a>（照片授权版本 {PORTRAIT_CONSENT_VERSION}）。{mode==='test'?'我理解这是测试订单，不代表真实交易。':''}</label></div><div className="action-row"><Button disabled={!!busy||!selectedPackage||!selectedJob||!terms||mode==='disabled'} onClick={()=>void createOrder()}>{busy==='create'?<LoaderCircle className="spin"/>:<ShoppingBag/>}{mode==='test'?'建立测试订单':'建立订单'}</Button><span className="micro">建立订单不会确认付款或自动生成图片。</span></div></>}
    </section>
    <section className="order-collection" aria-labelledby="my-orders-heading"><div className="section-title"><h2 id="my-orders-heading">我的订单</h2><span className="subtle">{data.orders.length} 笔</span></div>{data.orders.length?<div className="order-list">{data.orders.map(order=>orderCard(order))}</div>:<div className="order-empty panel"><ShoppingBag size={26}/><p className="muted-text">目前没有订单。你的原有创作任务保留在“我的作品”。</p></div>}</section>
    {data.commerce.operator&&<section className="operator-queue" aria-labelledby="fulfillment-heading"><div className="section-title"><h2 id="fulfillment-heading">经营者履约队列</h2><span className="subtle">{queue.length} 笔</span></div><p className="muted-text">仅列出服务器授权查看的已付款订单。先查看素材，导入并逐张检查作品，再执行交付核验。</p>{queue.length?<div className="order-list">{queue.map(order=>orderCard(order,true))}</div>:<div className="panel order-empty"><p className="muted-text">暂无待履约的已付款订单。</p></div>}</section>}
   </>}
  </>}
 </div>;
}
