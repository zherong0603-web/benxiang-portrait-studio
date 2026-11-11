import {env} from 'cloudflare:workers';
import {run,json} from '@/lib/server';
import {CommerceError} from '@/lib/commerce-contract';
import {applyPaymentEvent} from '@/lib/commerce';
import {verifyWebhook} from '@/lib/payment-provider';
export const dynamic='force-dynamic';

export async function POST(request:Request){return run(async()=>{
  if(!env.DB)throw new CommerceError(503,'订单数据库暂不可用');
  const event=await verifyWebhook(request,env);
  if(!event)return json({received:true,ignored:true});
  const result=await applyPaymentEvent(env.DB,event);
  return request.headers.has('wechatpay-serial')?new Response(null,{status:204}):json(result);
})}
