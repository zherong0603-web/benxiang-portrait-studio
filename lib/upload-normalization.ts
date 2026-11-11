import {ApiError} from './client';
/** Browser pixel decode and JPEG re-encode strips metadata before a new hosted upload. */
export async function normalizePortraitUpload(file:File):Promise<File>{
 let image:ImageBitmap|undefined,canvas:HTMLCanvasElement|undefined;
 try{
  image=await createImageBitmap(file,{imageOrientation:'from-image'});
  if(!image.width||!image.height||image.width>8192||image.height>8192||image.width*image.height>24000000)throw Error('dimensions');
  const scale=Math.min(1,1800/Math.max(image.width,image.height),Math.sqrt(2500000/(image.width*image.height)));
  canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.floor(image.width*scale));canvas.height=Math.max(1,Math.floor(image.height*scale));
  const context=canvas.getContext('2d');if(!context)throw Error('canvas');context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
  const blob=await new Promise<Blob>((resolve,reject)=>canvas!.toBlob(value=>value?resolve(value):reject(Error('encode')),'image/jpeg',.95));
  if(!blob.size||blob.size>10*1024*1024)throw Error('size');
  return new File([blob],file.name.replace(/\.[^.]*$/,'')+'.jpg',{type:'image/jpeg',lastModified:file.lastModified});
 }catch{throw new ApiError(400,'照片无法处理，尚未上传。请换一张清晰的 JPG、PNG 或 WEBP 原照。')}
 finally{image?.close();if(canvas){canvas.width=0;canvas.height=0}}
}
