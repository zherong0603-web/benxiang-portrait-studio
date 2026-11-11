import {publicJob} from '@/lib/public-portrait';
import {env} from 'cloudflare:workers';
import {context,run,json,body,hydratedJob} from '@/lib/server';
import {CommerceError} from '@/lib/commerce-contract';
import {orderRecord,publicOrder,cancelOrder,fulfillOrder,applyPaymentEvent} from '@/lib/commerce';
import {reconcilePayment} from '@/lib/payment-provider';
export const dynamic='force-dynamic';

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){return run(async()=>{
  const {id}=await params,{db,owner}=await context(request),order=await orderRecord(db,owner,id,env);
  const job=order.job_id?await db.prepare('SELECT * FROM jobs WHERE id=? AND owner_id=?').bind(order.job_id,order.owner_id).first<any>():null;
  return json({order:publicOrder(order),job:job?publicJob(await hydratedJob(db,order.owner_id,job,owner)):null});
})}

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return run(async()=>{
  const {id}=await params,{db,owner}=await context(request,true),input=await body(request);
  if(input.action==='reconcile'){const order=await orderRecord(db,owner,id,{});const event=await reconcilePayment({order,env});if(event)await applyPaymentEvent(db,event);return json({order:publicOrder(await orderRecord(db,owner,id,{}))});}
  if(input.action==='cancel')return json({order:publicOrder(await cancelOrder(db,owner,id,env))});
  if(input.action==='start'||input.action==='deliver')return json({order:publicOrder(await fulfillOrder(db,owner,id,input.action,env))});
  throw new CommerceError(400,'不支持这项订单操作');
})}
