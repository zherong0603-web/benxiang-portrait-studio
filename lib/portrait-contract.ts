import type {FrozenPhotography} from './photography-recipes';
export type Role='anchor'|'angle'|'expression'|'proportion'|'style';
export const roles:Record<Role,string>={anchor:'主身份参考',angle:'角度参考',expression:'表情参考',proportion:'比例参考',style:'穿搭 / 风格参考'};
export type Photo={id:string;name:string;url:string;role:Role};
export type ResultPhoto={id:string;url:string;source:'manual'|'provider';qa:string};
export type Job={creationSessionId?:string;frozenPrompts?:{slot:number;prompt:string;version:string;photography?:FrozenPhotography}[];id:string;title:string;style_id:string;count:number;status:string;created_at:string;notes:string;parent_id:string|null;prompt:string;references:Photo[];results:ResultPhoto[];error:string|null;commerce?:{orderId:string;paymentStatus:string;fulfillmentStatus:string;mode:string;canFulfill:boolean}};
