import {env} from 'cloudflare:workers';
import {run,json,body} from '@/lib/server';
import {workerContext,handleWorker} from '@/lib/generation';
export const dynamic='force-dynamic';
export async function POST(request:Request){return run(async()=>{const {db}=workerContext(request,env);return json(await handleWorker(db,env,await body(request)))})}
