import {sixTemplates} from './six-templates';
import type {Photo} from './portrait-contract';
import {getFrozenPhotography,getProPhotography,type FrozenPhotography} from './photography-recipes';

export {compileSixPortraitPrompt} from './six-templates';
export {roles} from './portrait-contract';
export type {Role,Photo,ResultPhoto,Job} from './portrait-contract';
export {SAMPLE_PROMPT_VERSION,PRO_PORTRAIT_PROMPT_VERSION} from './photography-recipes';
export const PORTRAIT_PROMPT_VERSION='portrait-single-v2';

const demoStyle=<Id extends string,Category extends 'portrait'|'id-style'>(id:Id,name:string,en:string,category:Category,color:string,image:string|null)=>({
 id,name,en,category,color,image,background:'solid color',wardrobe:'not applicable to this fixture',description:'合成几何占位图，用于演示',
});

export const styles=[
 demoStyle('blue-elegant','蓝幕优雅','BLUE ELEGANCE','portrait','#627e9b','/samples/elegant.webp'),
 demoStyle('blue-business','蓝幕商务','MODERN BUSINESS','portrait','#465c79','/samples/business.webp'),
 demoStyle('gray-executive','灰幕管理者','EXECUTIVE','portrait','#666872',null),
 demoStyle('warm-editorial','暖调杂志','EDITORIAL','portrait','#b6987d','/samples/editorial.webp'),
 demoStyle('bright-personal-brand','明亮个人品牌','PERSONAL BRAND','portrait','#dadde1',null),
 demoStyle('white-id-style','白底证件风','WHITE BACKDROP','id-style','#f4f5f6',null),
 demoStyle('blue-id-style','蓝底证件风','BLUE BACKDROP','id-style','#3578c6',null),
 demoStyle('red-id-style','红底证件风','RED BACKDROP','id-style','#bf3e4a',null),
 ...sixTemplates,
] as const;

function demoText(styleId:string,count:number,refs:Photo[],notes:string,slot?:number,recipe?:FrozenPhotography){
 return JSON.stringify({kind:'synthetic geometric demo',styleId,count,roles:refs.map(ref=>ref.role),notes:notes.trim(),slot,wardrobeId:recipe?.wardrobe.id});
}

export function compilePrompt(styleId:string,count:number,refs:Photo[],notes:string){
 if(!styles.some(style=>style.id===styleId))throw new Error('Invalid portrait request');
 return demoText(styleId,count,refs,notes);
}

function validateSlot(refs:Photo[],slot:number){
 if(!Number.isInteger(slot)||slot<0||!refs.length||refs.filter(ref=>ref.role==='anchor').length!==1)throw new Error('Invalid portrait request');
}

export function compileSinglePortraitPrompt(styleId:string,refs:Photo[],notes:string,slot=0){
 validateSlot(refs,slot);
 if(!styles.some(style=>style.id===styleId))throw new Error('Invalid portrait request');
 return demoText(styleId,1,refs,notes,slot);
}

export function compileSamplePortraitPrompt(styleId:string,refs:Photo[],notes:string,slot=0,wardrobeId?:string){
 validateSlot(refs,slot);
 return demoText(styleId,1,refs,notes,slot,getFrozenPhotography(styleId,wardrobeId));
}

export function compileProPortraitPrompt(styleId:string,refs:Photo[],notes:string,slot=0,wardrobeId?:string){
 validateSlot(refs,slot);
 return demoText(styleId,1,refs,notes,slot,getProPhotography(styleId,wardrobeId));
}
