/** Complete, bounded, metadata-free image normalization for nodejs_compat Workers. */
import jpeg from 'jpeg-js';
import {decode as decodePng} from 'fast-png';
import pako from 'pako';
import {Buffer} from 'node:buffer';
// jpeg-js 0.4.4's encoder expects the Node Buffer global even in a bundle.
// Install only the official nodejs_compat implementation when it is absent.
if(typeof globalThis.Buffer==='undefined')globalThis.Buffer=Buffer;
const {Inflate}=pako;
const MAX_BYTES=10*1024*1024,MAX_PIXELS=3_000_000;
const stop=signal=>{if(signal?.aborted)throw signal.reason??new Error('Operation aborted')};
const u16=(b,o)=>b[o]*256+b[o+1];
const u32=(b,o)=>(b[o]*0x1000000+b[o+1]*65536+b[o+2]*256+b[o+3]);
const text=(b,a,z)=>String.fromCharCode(...b.subarray(a,z));
function dimensions(width,height){if(!width||!height||width>8192||height>8192||width*height>MAX_PIXELS)throw new Error('Invalid image dimensions: maximum 3,000,000 pixels and 8192 per side')}
function orientation(tiff){
 if(tiff.length<8)throw new Error('Invalid image EXIF');
 const little=text(tiff,0,2)==='II';if(!little&&text(tiff,0,2)!=='MM')throw new Error('Invalid image EXIF');
 const view=new DataView(tiff.buffer,tiff.byteOffset,tiff.byteLength),get16=o=>view.getUint16(o,little),get32=o=>view.getUint32(o,little);
 if(get16(2)!==42)throw new Error('Invalid image EXIF');
 const offset=get32(4);if(offset<8||offset+2>tiff.length)throw new Error('Invalid image EXIF');
 const count=get16(offset);if(offset+2+count*12+4>tiff.length)throw new Error('Invalid image EXIF');
 for(let i=0;i<count;i++){const p=offset+2+i*12;if(get16(p)!==0x112)continue;if(get16(p+2)!==3||get32(p+4)!==1)throw new Error('Invalid image EXIF orientation');const v=get16(p+8);if(v<1||v>8)throw new Error('Invalid image EXIF orientation');return v}
 return 1;
}
function jpegHeader(b){
 if(b.length<4||b[b.length-2]!==255||b[b.length-1]!==217)throw new Error('Truncated JPEG image');
 let p=2,width,height,rotate=1,frames=0,scan=false;
 while(p<b.length-2){
  if(b[p++]!==255)throw new Error('Invalid JPEG image marker');while(b[p]===255)p++;
  const marker=b[p++];if(marker===217)break;
  if(marker===0||marker===216||(marker>=208&&marker<=215))throw new Error('Invalid JPEG image marker');
  if(p+2>b.length)throw new Error('Truncated JPEG image');const length=u16(b,p);if(length<2||p+length>b.length)throw new Error('Truncated JPEG image');
  if([192,193,194].includes(marker)){
   if(length<8||++frames!==1)throw new Error('Invalid JPEG image frame');height=u16(b,p+3);width=u16(b,p+5);dimensions(width,height);
  }else if(marker>=192&&marker<=207&&![196,200,204].includes(marker))throw new Error('Unsupported JPEG image encoding; re-upload a standard JPEG');
  if(marker===225&&text(b,p+2,p+8)==='Exif\x00\x00')rotate=orientation(b.subarray(p+8,p+length));
  if(marker===218){scan=true;break}p+=length;
 }
 if(!scan||!width||!height)throw new Error('JPEG image has no complete pixel scan');
 return {width,height,rotate};
}
function crc(b){let c=0xffffffff;for(const byte of b){c^=byte;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return (c^0xffffffff)>>>0}
function pngHeader(b){
 let p=8,width,height,depth,color,channels,rotate=1,seenData=false,ended=false,closedData=false,seenPalette=false,seenTransparency=false;
 const parts=[b.subarray(0,8)],compressed=[];let paletteLength=0,transparency;
 while(p<b.length){
  if(p+12>b.length)throw new Error('Truncated PNG image');const length=u32(b,p),end=p+12+length;if(end>b.length)throw new Error('Truncated PNG image');
  const type=text(b,p+4,p+8),data=b.subarray(p+8,end-4);
  if(!/^[A-Za-z]{4}$/.test(type)||crc(b.subarray(p+4,end-4))!==u32(b,end-4))throw new Error('PNG image CRC or chunk invalid');
  if(p===8&&type!=='IHDR')throw new Error('PNG image missing header');
  if(type==='IHDR'){
   if(p!==8||length!==13)throw new Error('Invalid PNG image header');width=u32(data,0);height=u32(data,4);dimensions(width,height);depth=data[8];color=data[9];channels=({0:1,2:3,3:1,4:2,6:4})[color];
   if(!channels||!({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]})[color].includes(depth)||data[10]!==0||data[11]!==0)throw new Error('Unsupported PNG image format; re-upload a standard PNG or JPEG');
   if(data[12]!==0)throw new Error('Interlaced PNG unsupported; re-upload a non-interlaced PNG or JPEG');
  }else if(['acTL','fcTL','fdAT'].includes(type))throw new Error('Animated PNG unsupported; re-upload a still PNG or JPEG');
  else if(type==='PLTE'){
   if(seenPalette||seenData||seenTransparency||color===0||color===4||!length||length%3||length>768||(color===3&&length/3>2**depth))throw new Error('Invalid PNG image palette');seenPalette=true;paletteLength=length/3;
  }else if(type==='tRNS'){
   if(seenTransparency||seenData||!((color===0&&length===2)||(color===2&&length===6)||(color===3&&seenPalette&&length>0&&length<=paletteLength)))throw new Error('Invalid PNG image transparency');seenTransparency=true;if(color!==3)transparency=Array.from({length:length/2},(_,i)=>u16(data,i*2));
  }else if(type==='IDAT'){
   if(closedData||(color===3&&!seenPalette))throw new Error('Invalid PNG image data sequence');seenData=true;compressed.push(data);
  }else if(type==='IEND'){
   if(length!==0||!seenData||end!==b.length)throw new Error('Invalid PNG image end');ended=true;
  }else{
   if(type==='eXIf')rotate=orientation(data);
   if(type[0]===type[0].toUpperCase())throw new Error('Unsupported critical PNG image chunk');
  }
  if(seenData&&type!=='IDAT')closedData=true;
  if(['IHDR','PLTE','IDAT','IEND'].includes(type)||(type==='tRNS'&&color===3))parts.push(b.subarray(p,end));
  p=end;if(ended)break;
 }
 if(!ended)throw new Error('Truncated PNG image');
 // Validate bounded decompressed scanline length before pixel allocation.
 const expected=(Math.ceil(width*channels*depth/8)+1)*height,inflater=new Inflate({chunkSize:16384,windowBits:15});let expanded=0;
 inflater.onData=chunk=>{expanded+=chunk.length;if(expanded>expected)throw new Error('PNG image decompressed size exceeds pixel bounds')};
 for(const data of compressed){if(inflater.ended&&data.length)throw new Error('PNG image extra compressed data');inflater.push(data);if(inflater.err)throw new Error('PNG image decode failed')}
 if(!inflater.ended||expanded!==expected)throw new Error('PNG image pixel data incomplete');
 const sanitized=new Uint8Array(parts.reduce((n,part)=>n+part.length,0));let offset=0;for(const part of parts){sanitized.set(part,offset);offset+=part.length}
 return {width,height,depth,color,channels,rotate,sanitized,transparency,expected};
}
function pngPixels(image,meta){
 const {width,height,depth,color,channels}=meta,data=image.data,rgba=new Uint8Array(width*height*4),max=2**depth-1;
 const sample=(i,c)=>depth<8?(data[Math.floor(i/width)*Math.ceil(width*depth/8)+Math.floor((i%width)*depth/8)]>>(8-depth-((i%width)*depth%8)))&max:data[i*channels+c];
 for(let i=0;i<width*height;i++){
  let r,g,b,a=max;
  if(color===3){const entry=image.palette?.[sample(i,0)];if(!entry)throw new Error('PNG image palette index invalid');[r,g,b]=entry;a=entry[3]??255;rgba.set([Math.round((r*a+255*(255-a))/255),Math.round((g*a+255*(255-a))/255),Math.round((b*a+255*(255-a))/255),255],i*4);continue}
  if(color===0||color===4){r=g=b=sample(i,0);if(color===4)a=sample(i,1);else if(meta.transparency?.[0]===r)a=0}
  else {r=sample(i,0);g=sample(i,1);b=sample(i,2);if(color===6)a=sample(i,3);else if(meta.transparency?.length===3&&meta.transparency[0]===r&&meta.transparency[1]===g&&meta.transparency[2]===b)a=0}
  rgba.set([r,g,b].map(v=>Math.round((v*a+max*(max-a))*255/(max*max))).concat(255),i*4);
 }
 return rgba;
}
function orient(data,width,height,value){
 if(value===1)return {data,width,height};
 const swapped=value>=5,w=swapped?height:width,h=swapped?width:height,out=new Uint8Array(data.length);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  let dx,dy;
  switch(value){case 2:dx=width-1-x;dy=y;break;case 3:dx=width-1-x;dy=height-1-y;break;case 4:dx=x;dy=height-1-y;break;case 5:dx=y;dy=x;break;case 6:dx=height-1-y;dy=x;break;case 7:dx=height-1-y;dy=width-1-x;break;case 8:dx=y;dy=width-1-x;break}
  const a=(y*width+x)*4,z=(dy*w+dx)*4;out[z]=data[a];out[z+1]=data[a+1];out[z+2]=data[a+2];out[z+3]=255;
 }
 return {data:out,width:w,height:h};
}
export async function normalizeWorkerImage(input,{signal}={}){
 stop(signal);
 if(!(input instanceof Uint8Array)||!input.length||input.length>MAX_BYTES)throw new Error('Invalid image size: maximum 10MB');
 const bytes=new Uint8Array(input.buffer,input.byteOffset,input.byteLength);let meta,pixels;
 try{
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255){meta=jpegHeader(bytes);const decoded=jpeg.decode(bytes,{useTArray:true,formatAsRGBA:true,tolerantDecoding:false,maxResolutionInMP:3,maxMemoryUsageInMB:64});if(decoded.width!==meta.width||decoded.height!==meta.height)throw new Error('JPEG image dimensions changed');pixels=decoded.data}
  else if(bytes.length>=8&&bytes.subarray(0,8).every((v,i)=>v===[137,80,78,71,13,10,26,10][i])){meta=pngHeader(bytes);pixels=pngPixels(decodePng(meta.sanitized,{checkCrc:true}),meta)}
  else if(text(bytes,0,4)==='RIFF'&&text(bytes,8,12)==='WEBP')throw new Error('Stored WebP unsupported: 请重新上传该照片 (re-upload as JPEG or PNG)');
  else throw new Error('Unsupported image format: re-upload JPEG or PNG');
  stop(signal);const transformed=orient(pixels,meta.width,meta.height,meta.rotate);const output=jpeg.encode(transformed,95).data;
  stop(signal);if(!output.length||output.length>MAX_BYTES)throw new Error('Normalized image size exceeds limit');
  const hash=await crypto.subtle.digest('SHA-256',output);stop(signal);
  return {bytes:new Uint8Array(output),mime:'image/jpeg',width:transformed.width,height:transformed.height,sha256:Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('')};
 }catch(error){stop(signal);if(error instanceof Error&&/image|PNG|JPEG|WebP|re-upload/i.test(error.message))throw error;throw new Error('Image decode failed')}
}
