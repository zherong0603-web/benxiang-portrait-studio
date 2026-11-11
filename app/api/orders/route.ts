import {env} from 'cloudflare:workers';
import {context,run,json,body} from '@/lib/server';
import {commerceConfig,isCommerceOperator,listOrders,createOrder,publicOrder} from '@/lib/commerce';
import {paymentConfigured} from '@/lib/payment-provider';
export const dynamic='force-dynamic';

export async function GET(request:Request){return run(async()=>{
  const {db,owner}=await context(request),config=commerceConfig(env),provider=paymentConfigured(env);
  const operatorScope=new URL(request.url).searchParams.get('scope')==='operator';
  return json({orders:await listOrders(db,owner,env,operatorScope),catalog:config.catalog,commerce:{...provider,mode:config.mode,configured:config.mode!=='disabled'&&config.catalog.length>0&&provider.configured,message:config.mode==='disabled'||!config.catalog.length?config.message:provider.configured?config.message:provider.message,operator:isCommerceOperator(owner,env),termsVersion:config.termsVersion}});
})}

export async function POST(request:Request){return run(async()=>{
  const {db,owner}=await context(request,true);
  const order=await createOrder(db,owner,await body(request),env);
  return json({order:publicOrder(order)},201);
})}
