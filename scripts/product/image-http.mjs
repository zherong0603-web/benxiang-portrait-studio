import {Buffer} from 'node:buffer';

/** Stream bounds also apply when content-length is omitted or dishonest. */
export async function readBoundedResponse(response,maxBytes){
 const declared=response.headers.get('content-length');
 if(declared&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes)){await response.body?.cancel();throw new Error('Response size exceeds limit')}
 if(!response.body)return Buffer.alloc(0);
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new Error('Response size exceeds limit')}chunks.push(value)}
  return Buffer.concat(chunks,size);
 }finally{reader.releaseLock()}
}

