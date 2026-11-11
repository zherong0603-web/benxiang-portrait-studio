/** Bounded container/dimension checks, not a full pixel decoder or likeness check. */
export function inspectImage(bytes: Uint8Array) {
  let mime = '', width = 0, height = 0;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start:number,end:number) => String.fromCharCode(...bytes.slice(start,end));
  if (bytes.length >= 45 && [137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)) {
    mime='image/png';
    if (v.getUint32(8)!==13 || text(12,16)!=='IHDR' || text(bytes.length-8,bytes.length-4)!=='IEND') throw new Error('无效的 PNG 容器');
    width=v.getUint32(16); height=v.getUint32(20);
  } else if (bytes.length >= 30 && text(0,4)==='RIFF' && text(8,12)==='WEBP') {
    mime='image/webp';
    if (v.getUint32(4,true)+8 !== bytes.length) throw new Error('无效的 WEBP 容器');
    const kind=text(12,16);
    if(kind==='VP8X') { width=1+(bytes[24]|bytes[25]<<8|bytes[26]<<16); height=1+(bytes[27]|bytes[28]<<8|bytes[29]<<16); }
    else if(kind==='VP8 ' && bytes[23]===157 && bytes[24]===1 && bytes[25]===42) { width=v.getUint16(26,true)&16383; height=v.getUint16(28,true)&16383; }
    else if(kind==='VP8L' && bytes[20]===47) { const bits=v.getUint32(21,true); width=(bits&16383)+1; height=((bits>>>14)&16383)+1; }
  } else if(bytes.length>=12 && bytes[0]===255 && bytes[1]===216 && bytes[bytes.length-2]===255 && bytes[bytes.length-1]===217) {
    mime='image/jpeg'; let offset=2;
    while(offset+4<=bytes.length) {
      if(bytes[offset++]!==255)break;
      while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];
      if(marker===217 || marker===218)break;
      if(marker===1 || (marker>=208 && marker<=215))continue;
      if(offset+2>bytes.length)break;
      const length=v.getUint16(offset);
      if(length<2 || offset+length>bytes.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length>=8) { height=v.getUint16(offset+3); width=v.getUint16(offset+5); break; }
      offset+=length;
    }
  }
  if(!mime || !width || !height || width>8192 || height>8192 || width*height>24_000_000) throw new Error('请选择有效且不超过 2400 万像素、单边 8192 像素的 JPG、PNG 或 WEBP 图片');
  return {mime,width,height};
}
