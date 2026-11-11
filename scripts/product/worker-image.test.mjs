import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {deflateSync,gzipSync} from 'node:zlib';
let normalizeWorkerImage;
try { ({normalizeWorkerImage}=await import('../../lib/worker-image.mjs')); } catch(error) { if(error.code!=='ERR_MODULE_NOT_FOUND')throw error; }
const normalize=(...args)=>{assert.equal(typeof normalizeWorkerImage,'function','portable complete image decoder is required');return normalizeWorkerImage(...args)};
const png=()=>sharp({create:{width:48,height:32,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
function crc(bytes){let c=0xffffffff;for(const byte of bytes){c^=byte;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return (c^0xffffffff)>>>0}
function chunk(type,data){const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);b.set(data,8);b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4);return b}
function rawPng({width=2,height=1,depth=8,color=6,rows=Buffer.from([0,255,0,0,255,0,0,255,255]),extra=[],interlace=0}={}){const h=Buffer.alloc(13);h.writeUInt32BE(width);h.writeUInt32BE(height,4);h[8]=depth;h[9]=color;h[12]=interlace;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),...extra,chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))])}
async function colors(bytes){const {data,info}=await sharp(bytes).raw().removeAlpha().toBuffer({resolveWithObject:true});return [[8,8],[info.width-9,8],[8,info.height-9],[info.width-9,info.height-9]].map(([x,y])=>{const i=(y*info.width+x)*3;const [r,g,b]=data.subarray(i,i+3);return r>180&&g>180?4:r>180?1:g>100?2:3})}
test('portable decode returns actual JPEG pixels, dimensions and WebCrypto hash with white alpha flattening',async()=>{
 const output=await normalize(await png());assert.equal(output.mime,'image/jpeg');assert.ok(output.bytes instanceof Uint8Array);assert.deepEqual([output.width,output.height],[48,32]);assert.equal(output.sha256,createHash('sha256').update(output.bytes).digest('hex'));
 const meta=await sharp(output.bytes).metadata();assert.equal(meta.format,'jpeg');assert.equal(meta.exif,undefined);const pixels=await sharp(output.bytes).raw().toBuffer();assert.ok(pixels.every(x=>x>=250));
});
test('all eight EXIF orientations move real corner pixels including mirrored variants and remove metadata',async()=>{
 const width=48,height=32,data=Buffer.alloc(width*height*3),quadrants=[[255,0,0],[0,180,0],[0,0,255],[255,255,0]];
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set(quadrants[(y>=16?2:0)+(x>=24?1:0)],(y*width+x)*3);
 const expected=[[1,2,3,4],[2,1,4,3],[4,3,2,1],[3,4,1,2],[1,3,2,4],[3,1,4,2],[4,2,3,1],[2,4,1,3]];
 for(let orientation=1;orientation<=8;orientation++){
  const source=await sharp(data,{raw:{width,height,channels:3}}).withMetadata({orientation}).withExifMerge({IFD0:{Artist:'synthetic-location-fixture'}}).jpeg({quality:100,chromaSubsampling:'4:4:4'}).toBuffer();
  const out=await normalize(source);assert.deepEqual([out.width,out.height],orientation>=5?[32,48]:[48,32]);assert.deepEqual(await colors(out.bytes),expected[orientation-1],`orientation ${orientation}`);const meta=await sharp(out.bytes).metadata();assert.equal(meta.exif,undefined);assert.equal(meta.orientation,undefined);assert.equal(meta.icc,undefined);assert.equal(Buffer.from(out.bytes).includes(Buffer.from('synthetic-location-fixture')),false);
 }
});
test('corrupt, truncated and plausible header-only containers never produce normalized images',async()=>{
 const validPng=await png(),validJpeg=await sharp(validPng).jpeg().toBuffer();
 for(const bytes of [Buffer.from('not an image'),validPng.subarray(0,33),validPng.subarray(0,-8),validJpeg.subarray(0,-20),Buffer.concat([validJpeg.subarray(0,Math.floor(validJpeg.length/2)),Buffer.from([255,217])]),Buffer.from([255,216,255,192,0,17,8,0,32,0,48,3,1,17,0,2,17,0,3,17,0,255,217]),rawPng({rows:Buffer.from([0])}),rawPng({rows:Buffer.alloc(1_000_000)})])await assert.rejects(normalize(bytes),/image|decode|PNG|JPEG|size|pixel/i);
 const corrupt=Buffer.from(validPng);corrupt[corrupt.length-15]^=255;await assert.rejects(normalize(corrupt),/image|decode|CRC|PNG/i);
});
test('input bytes, dimensions and PNG expansion are bounded before decoding pixels',async()=>{
 await assert.rejects(normalize(new Uint8Array(10*1024*1024+1)),/size/i);
 for(const [width,height] of [[0,1],[8193,1],[3001,1000],[0xffffffff,0xffffffff]])await assert.rejects(normalize(rawPng({width,height})),/dimension|pixel/i);
 const oversized=await sharp({create:{width:2000,height:1501,channels:3,background:'red'}}).jpeg().toBuffer();await assert.rejects(normalize(oversized),/dimension|pixel/i);
 const allowed=await normalize(rawPng({width:2000,height:1500,color:0,rows:Buffer.alloc(2001*1500)}));assert.deepEqual([allowed.width,allowed.height],[2000,1500]);
});
test('noninterlaced packed grayscale, palette transparency, grayscale alpha and16bit are decoded accurately',async()=>{
 const cases=[
  [rawPng({width:1,depth:1,color:0,rows:Buffer.from([0,0])}),[0,0,0]],
  [rawPng({width:1,depth:4,color:3,rows:Buffer.from([0,0]),extra:[chunk('PLTE',Buffer.from([255,0,0])),chunk('tRNS',Buffer.from([0]))]}),[255,255,255]],
  [rawPng({width:1,color:4,rows:Buffer.from([0,0,128])}),[127,127,127]],
  [rawPng({width:1,depth:16,color:2,rows:Buffer.from([0,255,255,0,0,0,0])}),[255,0,0]],
  [rawPng({width:1,color:2,rows:Buffer.from([0,255,0,0]),extra:[chunk('tRNS',Buffer.from([0,255,0,0,0,0]))]}),[255,255,255]],
 ];
 for(const [source,want] of cases){let out;try{out=await normalize(source)}catch(error){error.message+=` PNG case ${cases.findIndex(x=>x[0]===source)}`;throw error}const got=await sharp(out.bytes).raw().removeAlpha().toBuffer();for(let i=0;i<3;i++)assert.ok(Math.abs(got[i]-want[i])<8,`${got} expected ${want}`)}
});
test('unsupported stored WebP, animated and interlaced PNG have actionable re-upload errors',async()=>{
 const webp=await sharp(await png()).webp().toBuffer();await assert.rejects(normalize(webp),/WebP.*(重新上传|re-upload)/i);
 await assert.rejects(normalize(rawPng({interlace:1})),/(交错|interlac).*(重新上传|re-upload)/i);
 await assert.rejects(normalize(rawPng({extra:[chunk('acTL',Buffer.alloc(8))]})),/(动画|animated).*(重新上传|re-upload)/i);
});
test('aborted input does no normalization',async()=>{const controller=new AbortController();controller.abort(new Error('fixture stop'));await assert.rejects(normalize(await png(),{signal:controller.signal}),/fixture stop/)});

test('PNG metadata and compressed profiles are stripped before decode while PNG EXIF orientation is honored',async()=>{
 const tiff=Buffer.alloc(26);tiff.write('II');tiff.writeUInt16LE(42,2);tiff.writeUInt32LE(8,4);tiff.writeUInt16LE(1,8);tiff.writeUInt16LE(0x112,10);tiff.writeUInt16LE(3,12);tiff.writeUInt32LE(1,14);tiff.writeUInt16LE(6,18);
 // Invalid compressed profile is safely discarded rather than passed to a metadata inflater.
 const source=rawPng({extra:[chunk('eXIf',tiff),chunk('iCCP',Buffer.from('synthetic-GPS\0\0not-deflate')),chunk('tEXt',Buffer.from('GPS\0synthetic location'))]});
 const out=await normalize(source);assert.deepEqual([out.width,out.height],[1,2]);const metadata=await sharp(out.bytes).metadata();assert.equal(metadata.exif,undefined);assert.equal(metadata.icc,undefined);assert.equal(Buffer.from(out.bytes).includes(Buffer.from('synthetic-GPS')),false);
});
test('full baseline and progressive JPEG are decoded under the memory guard',async()=>{
 for(const progressive of [false,true]){const bytes=await sharp({create:{width:1200,height:1600,channels:3,background:'#8494a4'}}).jpeg({progressive,chromaSubsampling:'4:4:4'}).toBuffer();const out=await normalize(bytes);assert.deepEqual([out.width,out.height],[1200,1600]);assert.equal((await sharp(out.bytes).metadata()).isProgressive,false)}
});

test('PNG rejects non-zlib compressed pixel streams even when pixels would inflate',async()=>{
 const valid=rawPng();const invalid=Buffer.concat([valid.subarray(0,33),chunk('IDAT',gzipSync(Buffer.from([0,255,0,0,255,0,0,255,255]))),chunk('IEND',Buffer.alloc(0))]);
 await assert.rejects(normalize(invalid),/PNG|decode/i);
});
