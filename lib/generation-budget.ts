import type {GenerationBudget} from './creation-contract';
/** Monetary micros always have an explicit currency; legacy rows remain USD. */
const positive=(s:unknown)=>typeof s==='string'&&/^\d+$/.test(s)&&Number.isSafeInteger(Number(s))&&Number(s)>0?Number(s):0;
export function generationBudgetConfig(e:Cloudflare.Env):{currency:'USD'|'CNY';limitMicro:number;perCallMicro:number}|null{
 const currency=e.PORTRAIT_BUDGET_CURRENCY??'USD';if(currency!=='USD'&&currency!=='CNY')return null;
 const limitMicro=positive(currency==='CNY'?e.PORTRAIT_BUDGET_MICRO_CNY:e.PORTRAIT_BUDGET_MICRO_USD),perCallMicro=positive(currency==='CNY'?e.PORTRAIT_CALL_MAX_MICRO_CNY:e.PORTRAIT_CALL_MAX_MICRO_USD);
 return limitMicro&&perCallMicro&&perCallMicro<=limitMicro?{currency,limitMicro,perCallMicro}:null;
}
export async function generationBudgetSummary(db:D1Database,e:Cloudflare.Env):Promise<GenerationBudget|undefined>{
 const config=generationBudgetConfig(e);if(!config)return undefined;
 const row=await db.prepare('SELECT COALESCE(SUM(reserved_micro),0) reserved FROM generation_cost_reservations WHERE currency=?').bind(config.currency).first<{reserved:number}>();
 const reservedMicro=Number(row?.reserved??0);return {...config,reservedMicro,remainingMicro:Math.max(0,config.limitMicro-reservedMicro)};
}
