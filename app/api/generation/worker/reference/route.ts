import {env} from 'cloudflare:workers';
import {run} from '@/lib/server';
import {workerContext,workerReference} from '@/lib/generation';
export const dynamic='force-dynamic';
export async function GET(request:Request){return run(async()=>{const {db,bucket}=workerContext(request,env);return workerReference(db,bucket,new URL(request.url),request.headers.get('x-portrait-lease'),env)})}
