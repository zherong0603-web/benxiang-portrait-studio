import {getChatGPTUser} from '@/app/chatgpt-auth';
export const dynamic='force-dynamic';
export async function GET(){if(!await getChatGPTUser())return Response.json({error:'请先登录'},{status:401});return Response.json({error:'方法包下载未对客户开放'},{status:403,headers:{'Cache-Control':'private, no-store'}})}
