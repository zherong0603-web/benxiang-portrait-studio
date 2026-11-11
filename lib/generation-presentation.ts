import type {GenerationCapability} from './creation-contract';
export function generationPresentation(capability:GenerationCapability){
 const b=capability.budget;
 const money=(micro:number)=>`${b?.currency==='CNY'?'¥':'US$'}${(micro/1000000).toFixed(2)}`;
 const eligible=(count:number,styleIds?:readonly string[])=>!capability.eligibleStyleIds||!!styleIds&&styleIds.length===count&&new Set(styleIds).size===count&&styleIds.every(id=>capability.eligibleStyleIds!.includes(id));
 const scopeReason=()=>capability.eligibleStyleIds?.length?`当前测试仅开放 ${capability.eligibleStyleIds.join('、')}，请调整所选风格。`:'本轮测试已没有可用款式，请保留创作记录等待后续安排。';
 const canStart=(count:number,styleIds?:readonly string[])=>capability.configured&&Number.isInteger(count)&&count>0&&eligible(count,styleIds)&&(!b||count<=Math.floor(b.remainingMicro/b.perCallMicro));
 return {
  title:capability.configured?(capability.executionMode==='server-stream-v1'?'Seedream Pro · 生成入口已开启':'Pro 创作服务已就绪'):capability.mode==='degraded'?'自动生成暂不可用':'生成服务暂未启用',
  budgetText:b?`模型测试预算 ${money(b.limitMicro)} · 预算占用 ${money(b.reservedMicro)} · 剩余 ${money(b.remainingMicro)} · 每次预留 ${money(b.perCallMicro)}`:null,
  canStart,
  draftReason:(count:number,styleIds?:readonly string[])=>!capability.configured?capability.message||'生成服务暂未启用。':count<1?'请先选择至少一种风格。':!eligible(count,styleIds)?scopeReason():!canStart(count,styleIds)?'剩余额度不足以生成整组，请减少所选风格；也可仅保存要求后逐张生成。':'点击开始生成后会将原照发送给 Seedream Pro，按已确认额度真实调用。',
  groupReason:(count:number,styleIds?:readonly string[])=>canStart(count,styleIds)?'点击后会真实调用模型；支付收款仍关闭。':capability.configured&&!eligible(count,styleIds)?scopeReason():b&&capability.configured?'剩余预算不足以生成整组，请在下方逐张生成。':'请先核对服务状态。'
 };
}
