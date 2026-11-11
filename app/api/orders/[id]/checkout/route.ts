import {env} from 'cloudflare:workers';
import {context,run,json} from '@/lib/server';
import {CommerceError} from '@/lib/commerce-contract';
import {reserveCheckout,saveCheckout,publicOrder} from '@/lib/commerce';
import {paymentConfigured,createCheckout,checkoutQrSvg} from '@/lib/payment-provider';
export const dynamic='force-dynamic';

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return run(async()=>{
  const {id}=await params,{db,owner}=await context(request,true),provider=paymentConfigured(env);
  if(!provider.configured)throw new CommerceError(503,provider.message);
  const order=await reserveCheckout(db,owner,id,env);
  if(order.provider!==provider.provider)throw new CommerceError(409,'此订单的支付渠道已调整，请联系工作室核对');
  if(order.checkout_url)return json({order:publicOrder(order),checkoutUrl:order.checkout_url,checkoutQrSvg:checkoutQrSvg(order.checkout_url)});
  // Provider idempotency uses the reserved attempt. A timeout stays pending; a retry recovers the same session.
  const session=await createCheckout({order,origin:new URL(request.url).origin,env});
  const saved=await saveCheckout(db,owner,order,session);
  if(!saved)throw new CommerceError(409,'订单状态已经变化，请刷新');
  if(saved.payment_status==='paid')return json({order:publicOrder(saved),checkoutUrl:null});
  return json({order:publicOrder(saved),checkoutUrl:saved.checkout_url,checkoutQrSvg:checkoutQrSvg(saved.checkout_url)});
})}
