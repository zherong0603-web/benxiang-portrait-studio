import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import samples from '../../lib/photography-samples.json' with {type:'json'};
import catalogue from '../../lib/six-templates.json' with {type:'json'};
import {createServiceClient,loadStyleReference} from './generation-runtime.mjs';
import {parseWebTestScope} from '../../lib/web-test-scope.mjs';
import {parseGenerationPilot} from '../../lib/generation-pilot.mjs';
import {localProBindings} from './pro-local-bindings.mjs';

test('all nine synthetic fixtures decode and match their public catalogue pins',async()=>{
 const refs=[...Object.values(samples),...catalogue.map(entry=>entry.sample)];
 assert.equal(new Set(refs.map(ref=>ref.id)).size,9);
 assert.equal(new Set(refs.map(ref=>ref.sha256)).size,9);
 assert.deepEqual(catalogue.map(entry=>entry.id),['M01','M02','M03','F01','F02','F04']);
 for(const {path,width,height,sha256} of refs){
  const bytes=await readFile(new URL('../../public'+path,import.meta.url));
  const image=sharp(bytes,{failOn:'warning'});
  const meta=await image.metadata();
  const {info}=await image.raw().toBuffer({resolveWithObject:true});
  assert.equal(meta.format,path.endsWith('.jpg')?'jpeg':'webp');
  assert.deepEqual([info.width,info.height],[width,height]);
  assert.equal(width*4,height*3);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),sha256);
  for(const field of ['exif','icc','iptc','xmp'])assert.equal(meta[field],undefined);
 }
 for(const ref of Object.values(samples))assert.ok((await loadStyleReference(ref)).byteLength);
});

test('private trial entry points reject configuration; a loopback worker cannot forward a platform token',()=>{
 assert.throws(()=>parseWebTestScope({}),/unavailable/);
 assert.throws(()=>parseGenerationPilot('{}'),/unavailable/);
 assert.deepEqual(localProBindings({command:'serve',source:{PORTRAIT_GENERATION_ENABLED:'true'}}),{});
 const remote={origin:'https://worker.invalid',secret:'x'.repeat(32),remoteSiteEnabled:true};
 const fetchImpl=()=>assert.fail('Rejected configurations must not issue requests');
 assert.throws(()=>createServiceClient({...remote,fetchImpl}),/unavailable/);
 assert.throws(()=>createServiceClient({origin:'http://127.0.0.1',secret:remote.secret,siteAccessToken:'fixture',fetchImpl}),/unavailable/);
 assert.throws(()=>createServiceClient({...remote,remoteSiteEnabled:false,fetchImpl}),/loopback/);
});

test('local worker keeps fixed loopback authority and does not follow redirects',async()=>{
 const client=createServiceClient({origin:'http://127.0.0.1:9173',secret:'x'.repeat(32),fetchImpl:async(url,init)=>{
  assert.equal(url,'http://127.0.0.1:9173/api/generation/worker');
  assert.equal(init.redirect,'error');
  assert.equal(Object.hasOwn(init.headers,'OAI-Sites-Authorization'),false);
  return new Response('{}',{status:200});
 }});
 assert.deepEqual(await client.action({action:'fixture'}),{});
});
