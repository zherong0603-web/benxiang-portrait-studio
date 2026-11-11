import catalog from './six-templates.json';
import type {FrozenPhotography,PhotographyRecipe} from './photography-recipes';
import type {Photo} from './portrait';

export const SIX_TEMPLATE_PROMPT_VERSION='portrait-six-v1';
import type {SixTemplateId} from './six-template-ids';
export {SIX_TEMPLATE_IDS,isSixTemplateId} from './six-template-ids';
export type {SixTemplateId} from './six-template-ids';
export type SixTemplate=Omit<typeof catalog[number],'id'|'audience'|'category'>&{id:SixTemplateId;audience:'male'|'female';category:'portrait'};
export const sixTemplates=catalog as SixTemplate[];
export function getSixTemplate(id:string){return sixTemplates.find(template=>template.id===id)}
export function getSixPhotography(id:string,wardrobeId?:string):FrozenPhotography{
 const template=getSixTemplate(id);if(!template)throw new Error('摄影风格无效');
 const wardrobe=template.photography.wardrobeOptions.find(w=>w.id===(wardrobeId??'template'));if(!wardrobe)throw new Error('服装选择无效');
 const {wardrobeOptions,...photography}=template.photography;
 return structuredClone({...photography,version:SIX_TEMPLATE_PROMPT_VERSION,styleId:template.id,templateCode:template.id,model:'doubao-seedream-5-0-pro-260628',inputPolicy:'person-only',watermark:false,photographyPrompt:template.photographyPrompt,wardrobe,styleReference:template.sample,outputAspectRatio:'3:4'});
}
export function getSixPhotographyRecipe(id:string):PhotographyRecipe|undefined{
 const template=getSixTemplate(id);if(!template)return undefined;
 const {wardrobe,...frozen}=getSixPhotography(id);
 return {...frozen,wardrobeOptions:structuredClone(template.photography.wardrobeOptions)};
}
/** The public compiler emits synthetic fixture text. */
export function compileSixPortraitPrompt(styleId:string,refs:Photo[],notes:string,slot=0){
 if(slot!==0||new Set(refs.map(ref=>ref.id)).size!==refs.length||!refs.length||refs.length>3||refs.filter(r=>r.role==='anchor').length!==1||refs.some(r=>!['anchor','angle','expression','proportion'].includes(r.role)))throw new Error('Invalid six-template portrait request');
 const recipe=getSixPhotography(styleId);
 const roles=[...refs].sort((a,b)=>a.role==='anchor'?-1:b.role==='anchor'?1:0).map(ref=>ref.role);
 return JSON.stringify({kind:'synthetic geometric demo',styleId,slot,roles,notes:notes.trim(),direction:recipe.photographyPrompt});
}
