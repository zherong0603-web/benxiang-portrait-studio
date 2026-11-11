/** Local-only schema bootstrap for the existing Vite D1 store. Never accepts a remote DB. */
import {DatabaseSync,backup} from 'node:sqlite';
import {readFile,readdir,mkdir,writeFile,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
const quote=name=>'"'+name.replaceAll('"','""')+'"';
function definitions(snapshot){return Object.entries(snapshot.tables).flatMap(([table,t])=>[
 ...Object.keys(t.columns).map(column=>({type:'column',table,name:column})),
 ...Object.keys(t.indexes??{}).map(name=>({type:'index',table,name}))
])}
function present(db,item){return item.type==='column'?db.prepare(`PRAGMA table_info(${quote(item.table)})`).all().some(c=>c.name===item.name):!!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name=?").get(item.table,item.name)}
const identity=item=>`${item.type}:${item.table}:${item.name}`;
async function migrationPlan(db,directory){
 const journal=JSON.parse(await readFile(join(directory,'meta/_journal.json'),'utf8'));let previous=new Set(),pending=[];
 for(const entry of journal.entries){
  if(!/^\d{4}_[a-zA-Z0-9_-]+$/.test(entry.tag)||entry.idx>3)throw new Error('Unreviewed local migration. Inspect the new SQL and extend the local bootstrap before starting.');
  const snapshot=JSON.parse(await readFile(join(directory,'meta',String(entry.idx).padStart(4,'0')+'_snapshot.json'),'utf8'));
  const all=definitions(snapshot),delta=all.filter(item=>!previous.has(identity(item))),found=delta.filter(item=>present(db,item)).length;
  if(found!==0&&found!==delta.length)throw new Error(`Local schema is partially applied or inconsistent at ${entry.tag}. No changes made. Back up the local store; inspect PRAGMA table_info and sqlite_master against drizzle/meta/${String(entry.idx).padStart(4,'0')}_snapshot.json before repairing the partial migration. Never run the full SQL blindly on this database.`);
  if(found===0&&delta.length)pending.push(entry.tag+'.sql');
  previous=new Set(all.map(identity));
 }
 if(!pending.includes('0002_portrait_creations.sql')){
  for(const name of ['portrait_job_delete','portrait_no_commercial_order'])if(!db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(name))throw new Error(`Local schema is inconsistent: required trigger ${name} is missing. No changes made. Restore this trigger from drizzle/0002_portrait_creations.sql after backing up the local database; do not rerun CREATE TABLE statements.`);
 }
 return pending;
}
export async function migrateLocalDatabase({databasePath,migrationsDirectory,backupDirectory}){
 const db=new DatabaseSync(databasePath);db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');let backupPath=null;
 try{
  const pending=await migrationPlan(db,migrationsDirectory);if(!pending.length)return {applied:[],backupPath};
  await mkdir(backupDirectory,{recursive:true,mode:0o700});backupPath=join(backupDirectory,`before-migration-${Date.now()}-${process.pid}.sqlite`);
  await backup(db,backupPath);await chmod(backupPath,0o600);
  db.exec('BEGIN IMMEDIATE');try{
   const current=await migrationPlan(db,migrationsDirectory);
   for(const file of current)db.exec(await readFile(join(migrationsDirectory,file),'utf8'));
   if((await migrationPlan(db,migrationsDirectory)).length)throw new Error('Local migration verification failed');
   db.exec('COMMIT');return {applied:current,backupPath};
  }catch(error){db.exec('ROLLBACK');throw new Error(`Local migration stopped and rolled back. Backup: ${backupPath}. ${error.message}`)}
 }finally{db.close()}
}
async function files(directory){try{return (await readdir(directory)).filter(n=>/^[a-f0-9]{64}\.sqlite$/.test(n))}catch(e){if(e.code==='ENOENT')return [];throw e}}
async function initializeStore(root,env){
 const directory=join(root,'.sites-runtime/studio-bootstrap');await mkdir(directory,{recursive:true,mode:0o700});
 const configPath=join(directory,'wrangler.json');
 await writeFile(configPath,JSON.stringify({name:'benxiang-local-bootstrap',compatibility_date:'2026-05-15',d1_databases:[{binding:'DB',database_name:'site-creator-d1',database_id:'00000000-0000-4000-8000-000000000000',remote:false}]}),{mode:0o600});
 await writeFile(join(directory,'.dev.vars'),'# Empty bootstrap environment; no remote credentials.\n',{mode:0o600});
 const args=[join(root,'node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--local','--config',configPath,'--persist-to',join(root,'.wrangler/state'),'--command','SELECT 1','--json'];
 await new Promise((resolvePromise,reject)=>{
  const child=spawn(process.execPath,args,{cwd:directory,env,stdio:['ignore','ignore','ignore']});
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Local D1 initialization timed out; no website started. Retry npm run dev:studio after resolving the local Wrangler startup failure.'))},30000);
  child.on('error',e=>{clearTimeout(timer);reject(e)});child.on('exit',code=>{clearTimeout(timer);if(code===0)resolvePromise();else reject(new Error('Local D1 initialization failed; no website started. Check installed Wrangler and rerun npm run dev:studio.'))});
 });
}
export async function prepareStudioDatabase(root,env){
 const hosting=JSON.parse(await readFile(join(root,'.openai/hosting.json'),'utf8'));if(hosting.d1!=='DB')throw new Error('Unexpected local D1 binding. Inspect vite.config.ts before running the local bootstrap.');
 const directory=join(root,'.wrangler/state/v3/d1/miniflare-D1DatabaseObject');let names=await files(directory);
 if(!names.length){await initializeStore(root,env);names=await files(directory)}
 if(names.length!==1)throw new Error('Cannot identify exactly one existing local D1 database. No migration attempted. Inspect .wrangler/state/v3/d1/miniflare-D1DatabaseObject and its DB binding before starting; do not delete databases.');
 return migrateLocalDatabase({databasePath:resolve(directory,names[0]),migrationsDirectory:join(root,'drizzle'),backupDirectory:join(root,'.sites-runtime/studio-bootstrap/backups')});
}
