import {publicCreation} from '@/lib/public-portrait';
import {env} from 'cloudflare:workers';
import {context,run,json,body} from '@/lib/server';
import {createSession,getSession} from '@/lib/creations';
import {generationCapability,recoverAttempts} from '@/lib/generation';
export const dynamic='force-dynamic';
export async function GET(request:Request){return run(async()=>{const {db,owner}=await context(request);await recoverAttempts(db,env);const rows=await db.prepare('SELECT id FROM portrait_sessions WHERE owner_id=? ORDER BY created_at DESC LIMIT 100').bind(owner).all<{id:string}>();return json({sessions:(await Promise.all(rows.results.map(r=>getSession(db,owner,r.id)))).map(publicCreation),capability:await generationCapability(db,env,owner)})})}
export async function POST(request:Request){return run(async()=>{const {db,bucket,owner}=await context(request,true);return json({session:publicCreation(await createSession(db,bucket,owner,await body(request)))},201)})}
