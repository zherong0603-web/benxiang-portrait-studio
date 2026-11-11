import {run,resolveJobContext,ApiError} from '@/lib/server';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){return run(async()=>{
 const {id}=await params;await resolveJobContext(request,id);
 throw new ApiError(403,'任务导出已关闭');
})}
