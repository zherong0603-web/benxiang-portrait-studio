export const SIX_TEMPLATE_IDS=['M01','M02','M03','F01','F02','F04'] as const;
export type SixTemplateId=typeof SIX_TEMPLATE_IDS[number];
export function isSixTemplateId(id:unknown):id is SixTemplateId{return typeof id==='string'&&SIX_TEMPLATE_IDS.some(code=>code===id)}
