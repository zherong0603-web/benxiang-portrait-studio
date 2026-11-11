import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const scratch=await mkdtemp(join(tmpdir(),'portrait-budget-view-'));after(()=>rm(scratch,{recursive:true,force:true}));
await build({entryPoints:[resolve('lib/generation-presentation.ts')],outfile:join(scratch,'view.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
const {generationPresentation}=await import(pathToFileURL(join(scratch,'view.mjs')).href);
test('budget view labels reservations honestly and limits a full group to available calls',()=>{
 const c={configured:true,mode:'api-ready',message:'ready',model:'pro',budget:{currency:'CNY',limitMicro:2000000,reservedMicro:1000000,remainingMicro:1000000,perCallMicro:1000000}};
 const v=generationPresentation(c);assert.match(v.budgetText,/¥2.00/);assert.match(v.budgetText,/¥1.00/);assert.match(v.budgetText,/预算占用/);assert.equal(v.canStart(1),true);assert.equal(v.canStart(2),false);assert.match(v.groupReason(2),/逐张/);
 assert.equal(generationPresentation({...c,budget:{...c.budget,remainingMicro:0}}).canStart(1),false);
});
test('degraded configured service is not presented as missing integration or human import requirement',()=>{
 const v=generationPresentation({configured:false,mode:'degraded',message:'执行器暂时离线',model:'pro'});
 assert.equal(v.title,'自动生成暂不可用');assert.equal(v.canStart(1),false);
 assert.match(generationPresentation({configured:false,mode:'manual-assisted',message:'',model:null}).title,/暂未启用/);
});
test('initial begin action explains an insufficient whole-group budget before saving anything',()=>{
 const view=generationPresentation({configured:true,mode:'api-ready',message:'ready',model:'pro',budget:{currency:'CNY',limitMicro:9000000,reservedMicro:8000000,remainingMicro:1000000,perCallMicro:1000000}});
 assert.equal(typeof view.draftReason,'function');assert.match(view.draftReason(2),/额度不足/);assert.match(view.draftReason(2),/减少|逐张/);
 assert.match(generationPresentation({configured:false,mode:'degraded',message:'模型预算已用完',model:'pro'}).draftReason(1),/预算已用完/);
});
test('owner pilot buttons require the exact eligible styles and explain rejected selection',()=>{
 const cap={configured:true,mode:'api-ready',message:'ready',model:'pro',eligibleStyleIds:['M02','M03'],budget:{currency:'CNY',limitMicro:2000000,reservedMicro:0,remainingMicro:2000000,perCallMicro:1000000}};
 const view=generationPresentation(cap);
 assert.equal(view.canStart(1),false);
 assert.equal(view.canStart(1,['M02']),true);
 assert.equal(view.canStart(2,['M02','M03']),true);
 assert.equal(view.canStart(1,['F02']),false);
 assert.equal(view.canStart(2,['M02','M02']),false);
 assert.equal(view.canStart(2,['M02']),false);
 assert.match(view.draftReason(1,['F02']),/M02/);
 assert.match(view.groupReason(1,['F02']),/M03/);
 assert.equal(generationPresentation({...cap,eligibleStyleIds:[]}).canStart(1,['M02']),false);
});
