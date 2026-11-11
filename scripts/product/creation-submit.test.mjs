import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
await mkdir(resolve('node_modules/.cache'),{recursive:true});
const dir=await mkdtemp(resolve('node_modules/.cache/creation-submit-'));
after(()=>rm(dir,{recursive:true,force:true}));
let submit,notStarted;
try{await build({entryPoints:[resolve('lib/creation-submit.ts')],outfile:join(dir,'submit.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});const module=await import(pathToFileURL(join(dir,'submit.mjs')).href);submit=module.submitPortraitCreation;notStarted=module.creationNotStarted;}catch{}
const input={idempotencyKey:'same-key',styleIds:['M02'],references:[{id:'original',role:'anchor'}]};
const session=(status='ready')=>({id:'saved-session',status,jobs:[{id:'job-1',count:4,status:'ready'}],slots:[{id:'slot-1',jobId:'job-1',status:'ready',index:0}],results:[]});
test('recovering running, completed or uncertain work never describes it as not started',()=>{
 assert.equal(typeof notStarted,'function');assert.equal(notStarted(session()),true);
 for(const status of ['queued','running','completed','needs_reconciliation'])assert.equal(notStarted(session(status)),false);
 assert.equal(notStarted({...session(),slots:[{id:'slot',status:'ready',attemptId:'already-attempted'}]}),false);
 assert.equal(notStarted({...session(),results:[{id:'saved-output'}]}),false);
});
test('session is remembered before queue and queue failure never loses its recoverable id',async()=>{
 assert.equal(typeof submit,'function');const actions=[];
 await assert.rejects(()=>submit(input,{create:async body=>{assert.equal(body,input);actions.push('create');return session();},saved:s=>actions.push('saved:'+s.id),queue:async id=>{actions.push('queue:'+id);throw Error('queue response lost');}},true),/queue response lost/);
 assert.deepEqual(actions,['create','saved:saved-session','queue:saved-session']);
});
test('saving alone never queues and an uncertain create never invents a second submission',async()=>{
 assert.equal(typeof submit,'function');let calls=0,queued=0;
 const hooks={create:async body=>{calls++;assert.equal(body.idempotencyKey,'same-key');return session();},saved(){},queue:async()=>{queued++;return session();}};
 await submit(input,hooks,false);assert.equal(calls,1);assert.equal(queued,0);
 await assert.rejects(()=>submit(input,{...hooks,create:async()=>{calls++;throw Error('create response lost');}},true),/create response lost/);
 assert.equal(calls,2);assert.equal(queued,0);
});
test('starting queues only eligible slots and remembers the actual response',async()=>{
 assert.equal(typeof submit,'function');const calls=[],saved=[];
 const original={...session(),slots:[{id:'ready',jobId:'job-1',status:'ready'},{id:'unknown',jobId:'job-1',status:'needs_reconciliation'},{id:'running',jobId:'job-1',status:'dispatched'},{id:'done',jobId:'job-1',status:'succeeded'}]};
 const result=await submit(input,{create:async()=>original,saved:s=>saved.push(s),queue:async(id,slot)=>{calls.push([id,slot]);return {...original,status:'queued'};}},true);
 assert.deepEqual(calls,[['saved-session','ready']]);assert.equal(saved.length,2);assert.equal(result.status,'queued');
});

test('resuming an idempotent submission uses hosted eligibility without dispatching a failed old attempt',async()=>{
 const original={...session('queued'),slots:[{id:'queued-original',jobId:'job-1',status:'queued'},{id:'failed-old',jobId:'job-1',status:'failed'}]};
 const sent=[],saved=[];let policies=0;
 await submit(input,{create:async()=>original,saved:s=>saved.push(s.id),queueable:s=>{assert.equal(s,original);policies++;return s.slots.filter(slot=>slot.status==='queued')},queue:async(id,slot)=>{sent.push([id,slot]);return {...original,status:'awaiting_review'}}},true);
 assert.equal(policies,1);assert.deepEqual(sent,[['saved-session','queued-original']]);assert.deepEqual(saved,['saved-session','saved-session']);
});
