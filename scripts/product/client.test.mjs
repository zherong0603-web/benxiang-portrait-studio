import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const scratch=await mkdtemp(join(tmpdir(),'portrait-client-'));
await build({entryPoints:[resolve('lib/client.ts')],outfile:join(scratch,'client.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
const {api}=await import(pathToFileURL(join(scratch,'client.mjs')).href);
after(()=>rm(scratch,{recursive:true,force:true}));
test('invalid success body leaves mutation outcome unknown instead of authorizing upload retry',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response('<html>broken proxy</html>',{status:200});
 try{await assert.rejects(api('/api/studio',{method:'POST'}),e=>e.status===0&&/核对/.test(e.message));}finally{globalThis.fetch=original;}
});
test('explicit unauthorized response retains login classification even without JSON',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response('expired',{status:401});
 try{await assert.rejects(api('/api/studio',{method:'POST'}),e=>e.status===401);}finally{globalThis.fetch=original;}
});
