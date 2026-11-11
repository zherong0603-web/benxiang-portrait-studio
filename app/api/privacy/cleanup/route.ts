import {context,run,json} from '@/lib/server';
import {flushDeletions} from '@/lib/privacy';
export async function POST(request:Request){return run(async()=>{const {db,bucket,owner}=await context(request,true);return json(await flushDeletions(db,bucket,owner))})}
