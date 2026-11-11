import {SIX_TEMPLATE_PROMPT_VERSION,isSixTemplateId,getSixPhotography,getSixPhotographyRecipe,getSixTemplate} from './six-templates';
import samples from './photography-samples.json';
export const SAMPLE_PROMPT_VERSION='portrait-sample-v3';
export const PRO_PORTRAIT_PROMPT_VERSION='portrait-pro-v4';
export const APPROVED_PRO_MODEL='doubao-seedream-5-0-pro-260628';
export type StyleReference={id:string;path:string;sha256:string;width:number;height:number};
export type WardrobeOption={id:string;label:string;prompt:string;isSample:boolean};
export type PhotographyRecipe={version:string;styleId:string;framing:string;poses:string[];expression:string;lighting:string;background:string;wardrobeOptions:WardrobeOption[];styleReference:StyleReference;outputAspectRatio:'3:4'};
export type FrozenPhotography=Omit<PhotographyRecipe,'wardrobeOptions'>&{wardrobe:WardrobeOption;model?:string;inputPolicy?:'person-only';watermark?:false;templateCode?:string;photographyPrompt?:string};
const demoWardrobe=(id:string,isSample=true):WardrobeOption=>({
 id,isSample,label:isSample?'演示选项 A':'演示选项 B',prompt:'Synthetic fixture; no clothing direction.',
});
const demoRecipe=(styleId:keyof typeof samples,wardrobeOptions:WardrobeOption[]):PhotographyRecipe=>({
 version:SAMPLE_PROMPT_VERSION,styleId,framing:'vertical 3:4 canvas',poses:['geometric arrangement'],expression:'not applicable',
 lighting:'flat color',background:'solid color',wardrobeOptions,styleReference:samples[styleId],outputAspectRatio:'3:4',
});
const recipes=[
 demoRecipe('blue-business',[demoWardrobe('charcoal-suit')]),
 demoRecipe('blue-elegant',[demoWardrobe('black-dress'),demoWardrobe('black-tailored',false)]),
 demoRecipe('warm-editorial',[demoWardrobe('ivory-shirt'),demoWardrobe('neutral-knit',false)]),
];
export function getPhotographyRecipe(styleId:string):PhotographyRecipe|undefined{return getSixPhotographyRecipe(styleId)??recipes.find(r=>r.styleId===styleId)}
/** Do not add a missing field: legacy idempotent requests must retain their exact fingerprint. */
export function normalizeWardrobeByStyle(styleIds:string[],value:unknown):Record<string,string>|undefined{
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('服装选择无效');
 const entries=Object.entries(value);
 if(entries.some(([id,choice])=>!styleIds.includes(id)||typeof choice!=='string'||!getPhotographyRecipe(id)?.wardrobeOptions.some(w=>w.id===choice)))throw new Error('请选择对应风格提供的服装');
 return Object.fromEntries([...entries].sort(([a],[b])=>a.localeCompare(b))) as Record<string,string>;
}
export function getFrozenPhotography(styleId:string,wardrobeId?:string):FrozenPhotography{
 if(isSixTemplateId(styleId))throw new Error('Six-template creation requires its versioned compiler');
 const recipe=getPhotographyRecipe(styleId);if(!recipe)throw new Error('摄影风格无效');
 const wardrobe=recipe.wardrobeOptions.find(w=>w.id===(wardrobeId??recipe.wardrobeOptions[0].id));if(!wardrobe)throw new Error('服装选择无效');
 const {wardrobeOptions,...frozen}=recipe;
 return structuredClone({...frozen,wardrobe});
}
export function getProPhotography(styleId:string,wardrobeId?:string):FrozenPhotography{return {...getFrozenPhotography(styleId,wardrobeId),version:PRO_PORTRAIT_PROMPT_VERSION,model:APPROVED_PRO_MODEL}}
export function getCreationPhotography(styleId:string,wardrobeId?:string):FrozenPhotography{return isSixTemplateId(styleId)?getSixPhotography(styleId,wardrobeId):getProPhotography(styleId,wardrobeId)}
/** Only explicit versioned snapshots carry the new attachment contract. Old rows never get a guessed recipe. */
export function frozenPhotography(templateJson:string,promptVersion:string):FrozenPhotography|undefined{
 const knownVersion=[SAMPLE_PROMPT_VERSION,PRO_PORTRAIT_PROMPT_VERSION,SIX_TEMPLATE_PROMPT_VERSION].includes(promptVersion);
 let snapshot;try{snapshot=JSON.parse(templateJson)}catch(error){if(knownVersion)throw error;return undefined}
 const value=snapshot?.photography;
 if((isSixTemplateId(snapshot?.id)||isSixTemplateId(value?.styleId))&&promptVersion!==SIX_TEMPLATE_PROMPT_VERSION)throw new Error('Six-template version mismatch');
 if(![SAMPLE_PROMPT_VERSION,PRO_PORTRAIT_PROMPT_VERSION,SIX_TEMPLATE_PROMPT_VERSION].includes(promptVersion))return undefined;
 if(!value||value.version!==promptVersion||value.outputAspectRatio!=='3:4'||!value.styleReference||!value.wardrobe)throw new Error('Frozen photography contract is missing');
 if(promptVersion!==SIX_TEMPLATE_PROMPT_VERSION&&(value.inputPolicy!==undefined||value.watermark!==undefined))throw new Error('Legacy photography cannot carry six-template input policy');
 if(promptVersion===PRO_PORTRAIT_PROMPT_VERSION&&value.model!==APPROVED_PRO_MODEL)throw new Error('Frozen Pro model is missing');
 if(promptVersion===SIX_TEMPLATE_PROMPT_VERSION){
  const template=getSixTemplate(value.styleId),sample=template?.sample;
  if(!template||(isSixTemplateId(snapshot?.id)&&snapshot.id!==template.id)||value.templateCode!==template.id||value.model!==APPROVED_PRO_MODEL||value.inputPolicy!=='person-only'||value.watermark!==false||value.photographyPrompt!==template.photographyPrompt||Object.keys(sample!).some(key=>value.styleReference[key]!==sample![key as keyof typeof sample]))throw new Error('Frozen six-template contract is invalid');
 }
 return value as FrozenPhotography;
}
