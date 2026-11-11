import {env} from 'cloudflare:workers';
import {run,json} from '@/lib/server';
import {workerContext,workerResult} from '@/lib/generation';
export const dynamic='force-dynamic';
export async function POST(request:Request){return run(async()=>{const {db,bucket}=workerContext(request,env);return json(await workerResult(request,db,bucket,env),201)},request)}
