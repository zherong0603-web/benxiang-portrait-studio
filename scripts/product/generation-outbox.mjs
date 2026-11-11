/** Private crash-recovery spool. Only generated output, never API keys/originals. */
import {constants} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {open,mkdir,lstat,realpath,readdir,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const DEFAULT_ROOT=fileURLToPath(new URL('../../',import.meta.url));
const MAX_IMAGE=10*1024*1024,MAX_RECORD=15*1024*1024,TTL=24*60*60*1000;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const privateMode=info=>!(info.mode&0o077)&&info.uid===process.getuid?.();
async function privateDirectory(path){
 try{await mkdir(path,{mode:0o700})}catch(error){if(error.code!=='EEXIST')throw error}
 const info=await lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink()||!privateMode(info))throw new Error('Unsafe private outbox directory');
}
async function readPrivate(path){
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const info=await handle.stat();
  if(!info.isFile()||info.nlink!==1||!privateMode(info)||info.size>MAX_RECORD)throw new Error('Unsafe private outbox file');
  return await handle.readFile('utf8');
 }finally{await handle.close()}
}
function validate(record,id){
 if(!record||record.version!==1||!identifier(record.attemptId)||record.attemptId!==id||typeof record.leaseToken!=='string'||!record.leaseToken||record.leaseToken.length>100||typeof record.model!=='string'||!record.model||record.model.length>200||!Number.isSafeInteger(record.createdAt)||record.createdAt>Date.now()+60000||typeof record.outputHash!=='string'||!/^[a-f0-9]{64}$/.test(record.outputHash)||typeof record.imageBase64!=='string'||record.imageBase64.length>4*Math.ceil(MAX_IMAGE/3)||!record.metadata||record.metadata.model!==record.model||JSON.stringify(record.metadata).length>10000)throw new Error('Invalid outbox record');
 const bytes=Buffer.from(record.imageBase64,'base64');
 if(!bytes.length||bytes.length>MAX_IMAGE||bytes.toString('base64')!==record.imageBase64||hash(bytes)!==record.outputHash)throw new Error('Corrupt outbox image hash');
 return {...record,bytes};
}
export async function createGenerationOutbox({root=DEFAULT_ROOT}={}){
 const actualRoot=await realpath(root),runtime=join(actualRoot,'.sites-runtime'),directory=join(runtime,'generation-outbox');
 await privateDirectory(runtime);await privateDirectory(directory);
 async function check(){await privateDirectory(runtime);await privateDirectory(directory)}
 async function syncDirectory(){const handle=await open(directory,constants.O_RDONLY);try{await handle.sync()}finally{await handle.close()}}
 const pathFor=id=>{if(!identifier(id))throw new Error('Invalid outbox attempt identifier');return join(directory,id+'.json')};
 async function remove(id){await check();try{await unlink(pathFor(id));await syncDirectory()}catch(error){if(error.code!=='ENOENT')throw error}}
 async function list({attemptIds,cleanup=true}={}){
  if(attemptIds&&(!Array.isArray(attemptIds)||attemptIds.some(id=>!identifier(id))))throw new Error('Invalid scoped outbox selection');
  await check();const names=await readdir(directory),records=[];
  // A crash before atomic rename may leave a partial generated portrait. Only
  // private stale temporary files are removed; current writers are untouched.
  for(const name of names)if(cleanup&&/^\.pending-[a-f0-9-]{36}$/.test(name)){
   const path=join(directory,name),info=await lstat(path);
   if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||!privateMode(info))throw new Error('Unsafe private outbox temporary file');
   if(Date.now()-info.mtimeMs>TTL)await unlink(path);
  }
  if(names.filter(name=>name.endsWith('.json')).length>100)throw new Error('Outbox record limit reached');
  for(const name of names.sort())if(name.endsWith('.json')&&(!attemptIds||attemptIds.includes(name.slice(0,-5)))){const id=name.slice(0,-5);pathFor(id);records.push(validate(JSON.parse(await readPrivate(join(directory,name))),id))}
  return records;
 }
 return {
  directory,
  async assertWritable(){await check();const p=join(directory,'.probe-'+randomUUID()),file=await open(p,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await file.sync()}finally{await file.close();await unlink(p)}},
  async acquire(){
   await check();const path=join(directory,'.worker-lock.sqlite');
   // SQLite's OS locks are released atomically on process death. PID-file stale
   // deletion races could otherwise admit two restarted workers simultaneously.
   const file=await open(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
   try{const info=await file.stat();if(!info.isFile()||info.nlink!==1||!privateMode(info))throw new Error('Unsafe private outbox lock')}finally{await file.close()}
   let db;
   try{db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');}
   catch{try{db?.close()}catch{}throw new Error('Worker outbox already locked or lock unavailable')}
   let released=false;
   return {async release(){if(released)return;try{db.exec('ROLLBACK')}finally{db.close();released=true}}};
  },
  async put(claim,bytes,metadata){
   await check();const destination=pathFor(claim.attemptId),record={version:1,attemptId:claim.attemptId,leaseToken:claim.leaseToken,model:claim.model,metadata,createdAt:Date.now(),outputHash:hash(bytes),imageBase64:Buffer.from(bytes).toString('base64')};
   validate(record,claim.attemptId);
   // An existing artifact is immutable: never silently replace a generated image.
   try{const old=validate(JSON.parse(await readPrivate(destination)),claim.attemptId);if(old.outputHash!==record.outputHash||old.leaseToken!==record.leaseToken)throw new Error('Outbox attempt already exists');return}catch(error){if(error.code!=='ENOENT')throw error}
   const temporary=join(directory,'.pending-'+randomUUID()),file=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(JSON.stringify(record));await file.sync();await file.close();await rename(temporary,destination);await syncDirectory()}
   finally{try{await file.close()}catch{}try{await unlink(temporary)}catch(error){if(error.code!=='ENOENT')throw error}}
  },
  list,remove,
  async replay(service,{signal}={}){
   const result={saved:0,revoked:0,pending:0,expired:0};
   for(const record of await list()){
    if(Date.now()-record.createdAt>TTL){await remove(record.attemptId);result.expired++;continue}
    if(signal?.aborted){result.pending++;continue}
    try{
     const receipt=await service.action({action:'recover',attemptId:record.attemptId,leaseToken:record.leaseToken,outputHash:record.outputHash,model:record.model},{signal});
     if(receipt.state==='revoked'){await remove(record.attemptId);result.revoked++;continue}
     if(receipt.state==='stored'&&typeof receipt.assetId==='string'){await remove(record.attemptId);result.saved++;continue}
     if(receipt.state!=='resume'||typeof receipt.leaseToken!=='string'||!receipt.leaseToken)throw new Error('Invalid recovery receipt');
     const saved=await service.result({attemptId:record.attemptId,leaseToken:receipt.leaseToken},record.bytes,record.metadata,{signal});
     if(typeof saved?.assetId!=='string')throw new Error('Invalid result receipt');
     await remove(record.attemptId);result.saved++;
    }catch{result.pending++}
   }
   return result;
  }
 };
}
