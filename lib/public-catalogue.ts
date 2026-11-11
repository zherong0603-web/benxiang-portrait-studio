import {styles} from './portrait';
import {getPhotographyRecipe} from './photography-recipes';
export type PublicStyle={id:string;name:string;en:string;category:string;color:string;image:string|null;description:string;audience?:'male'|'female';photography?:{wardrobeOptions:{id:string;label:string;isSample:boolean}[]}};
/** Server projection only. Client modules import this type, never these source values. */
export function publicPortraitCatalogue():PublicStyle[]{
 return styles.map(style=>{
  const recipe=getPhotographyRecipe(style.id);
  return {id:style.id,name:style.name,en:style.en,category:style.category,color:style.color,image:style.image,description:style.description,...('audience'in style?{audience:style.audience}:{}),...(recipe?{photography:{wardrobeOptions:recipe.wardrobeOptions.map(({id,label,isSample})=>({id,label,isSample}))}}:{})};
 });
}
