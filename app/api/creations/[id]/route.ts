import {publicCreation} from '@/lib/public-portrait';
import {env} from 'cloudflare:workers';
import {context,run,json,body,ApiError} from '@/lib/server';
import {getSession,sessionRecord,cancelSession,changeChoice,deleteSession} from '@/lib/creations';
import {generationCapability,queueSession,reviewResult,recoverAttempts} from '@/lib/generation';
export const dynamic='force-dynamic';
type Params={params:Promise<{id:string}>};
export async function GET(request:Request,{params}:Params){return run(async()=>{const {id}=await params,{db,owner}=await context(request);await recoverAttempts(db,env);return json({session:publicCreation(await getSession(db,owner,id)),capability:await generationCapability(db,env,owner)})})}
export async function POST(request:Request,{params}:Params){return run(async()=>{const {id}=await params,{db,owner}=await context(request,true),data=await body(request);await sessionRecord(db,owner,id);switch(data.action){case 'queue':await queueSession(db,owner,id,env,data.slotId);break;case 'cancel':await cancelSession(db,owner,id);break;case 'choice':await changeChoice(db,owner,id,data);break;case 'review':await reviewResult(db,owner,id,data);break;default:throw new ApiError(400,'不支持这项操作')}return json({session:publicCreation(await getSession(db,owner,id))})})}
export async function DELETE(request:Request,{params}:Params){return run(async()=>{const {id}=await params,{db,bucket,owner}=await context(request,true);return json(await deleteSession(db,bucket,owner,id))})}
