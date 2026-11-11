import {CommerceError} from './commerce-contract';

export const PORTRAIT_CONSENT_VERSION = 'portrait-consent-v1';
export const PRIVACY_LEASE_MS = 10 * 60 * 1000;
export function requirePortraitConsent(value: unknown) {
  if (value !== PORTRAIT_CONSENT_VERSION) throw new CommerceError(400, '请阅读并确认当前照片使用授权');
  return PORTRAIT_CONSENT_VERSION;
}

/** D1 removes access before R2 is cleaned. Failed R2 deletions stay retryable. */
export function enqueueDeletion(db: D1Database, owner: string, objectKey: string, size = 0) {
  return db.prepare('INSERT OR IGNORE INTO storage_deletions (object_key,owner_id,created_at,size) VALUES (?,?,?,?)')
    .bind(objectKey, owner, new Date().toISOString(),size);
}
export async function pendingDeletions(db: D1Database, owner: string) {
  await reconcileUploads(db,owner);
  const row = await db.prepare('SELECT COUNT(*) AS total FROM (SELECT object_key FROM storage_deletions WHERE owner_id=? UNION SELECT object_key FROM pending_uploads WHERE owner_id=? AND cancelled=1)').bind(owner,owner).first<{total:number}>();
  return row?.total ?? 0;
}

/** Database-only recovery; a new token fences every destructive transaction. */
export async function recoverPrivacyLeases(db: D1Database, owner: string) {
  const cutoff = new Date(Date.now()-PRIVACY_LEASE_MS).toISOString();
  await db.batch([
    db.prepare('DELETE FROM privacy_locks WHERE owner_id=? AND created_at<=?').bind(owner,cutoff),
    db.prepare('UPDATE jobs SET deletion_token=NULL,deletion_started_at=NULL WHERE owner_id=? AND deletion_token IS NOT NULL AND (deletion_started_at IS NULL OR deletion_started_at<=?) AND NOT EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=?)').bind(owner,cutoff,owner)
  ]);
}

export async function reserveUpload(db: D1Database, input: {key:string;owner:string;size:number;kind:'reference'|'result'|'generation_evidence';jobId:string|null}) {
  const saved = await db.prepare(`INSERT INTO pending_uploads (object_key,owner_id,size,kind,job_id,created_at)
    SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=?)
    AND COALESCE((SELECT SUM(size) FROM assets WHERE owner_id=?),0)+COALESCE((SELECT SUM(size) FROM pending_uploads WHERE owner_id=?),0)+COALESCE((SELECT SUM(size) FROM storage_deletions WHERE owner_id=? AND NOT EXISTS (SELECT 1 FROM pending_uploads WHERE pending_uploads.object_key=storage_deletions.object_key)),0)+?<=536870912
    AND (?!='reference' OR (SELECT COUNT(*) FROM assets WHERE owner_id=? AND kind='reference')+(SELECT COUNT(*) FROM pending_uploads WHERE owner_id=? AND kind='reference' AND cancelled=0)<64)
    AND (?!='generation_evidence' OR EXISTS (SELECT 1 FROM jobs j JOIN portrait_session_jobs sj ON sj.job_id=j.id JOIN portrait_sessions s ON s.id=sj.session_id WHERE j.id=? AND j.owner_id=? AND j.status!='completed' AND j.deletion_token IS NULL AND s.status!='cancelled'))
    AND (?!='result' OR EXISTS (SELECT 1 FROM jobs WHERE id=? AND owner_id=? AND NOT EXISTS(SELECT 1 FROM portrait_session_jobs sj JOIN portrait_sessions s ON s.id=sj.session_id WHERE sj.job_id=jobs.id AND s.status='cancelled') AND status!='completed' AND deletion_token IS NULL AND (SELECT COUNT(*) FROM assets WHERE owner_id=? AND job_id=? AND kind='result')+(SELECT COUNT(*) FROM pending_uploads WHERE owner_id=? AND job_id=? AND kind='result' AND cancelled=0)<jobs.count))`)
    .bind(input.key,input.owner,input.size,input.kind,input.jobId,new Date().toISOString(),input.owner,input.owner,input.owner,input.owner,input.size,input.kind,input.owner,input.owner,input.kind,input.jobId,input.owner,input.kind,input.jobId,input.owner,input.owner,input.jobId,input.owner,input.jobId).run();
  if(!saved.meta.changes)throw new CommerceError(409,'照片数量、存储限额或任务状态已变化，请刷新后重试');
}

/** Use as the final statement of the metadata transaction. */
export function commitUpload(db:D1Database,key:string,owner:string) {
  return db.prepare('DELETE FROM pending_uploads WHERE object_key=? AND owner_id=? AND EXISTS (SELECT 1 FROM assets WHERE assets.object_key=pending_uploads.object_key AND assets.owner_id=pending_uploads.owner_id)').bind(key,owner);
}

/** The put has returned or failed, so deleting this attempt is safe; errors leave its durable reservation. */
export async function abandonUpload(db:D1Database,bucket:R2Bucket,key:string,owner:string,size=0) {
  await db.batch([
    db.prepare('UPDATE pending_uploads SET cancelled=1 WHERE object_key=? AND owner_id=?').bind(key,owner),
    db.prepare('INSERT OR IGNORE INTO storage_deletions (object_key,owner_id,created_at,size) SELECT ?,?,?,COALESCE((SELECT size FROM pending_uploads WHERE object_key=? AND owner_id=?),?) WHERE NOT EXISTS (SELECT 1 FROM assets WHERE object_key=?)').bind(key,owner,new Date().toISOString(),key,owner,size,key)
  ]);
  return flushDeletions(db,bucket,owner);
}

async function reconcileUploads(db:D1Database,owner:string) {
  const cutoff=new Date(Date.now()-PRIVACY_LEASE_MS).toISOString(),timestamp=new Date().toISOString();
  await db.batch([
    db.prepare('UPDATE pending_uploads SET cancelled=1 WHERE owner_id=? AND created_at<=? AND NOT EXISTS (SELECT 1 FROM assets WHERE assets.object_key=pending_uploads.object_key)').bind(owner,cutoff),
    db.prepare('INSERT OR IGNORE INTO storage_deletions (object_key,owner_id,created_at,size) SELECT object_key,owner_id,?,size FROM pending_uploads WHERE owner_id=? AND created_at<=? AND NOT EXISTS (SELECT 1 FROM assets WHERE assets.object_key=pending_uploads.object_key)').bind(timestamp,owner,cutoff),
    db.prepare('DELETE FROM pending_uploads WHERE owner_id=? AND EXISTS (SELECT 1 FROM assets WHERE assets.object_key=pending_uploads.object_key AND assets.owner_id=pending_uploads.owner_id)').bind(owner)
  ]);
}

export async function flushDeletions(db: D1Database, bucket: R2Bucket, owner: string) {
  await recoverPrivacyLeases(db,owner);
  await reconcileUploads(db,owner);
  const rows = await db.prepare('SELECT object_key FROM storage_deletions WHERE owner_id=? ORDER BY created_at LIMIT 100').bind(owner).all<{object_key:string}>();
  for (const row of rows.results) {
    try {
      await bucket.delete(row.object_key);
      await db.batch([
        db.prepare('DELETE FROM pending_uploads WHERE object_key=? AND owner_id=? AND cancelled=1').bind(row.object_key,owner),
        db.prepare('DELETE FROM storage_deletions WHERE object_key=? AND owner_id=?').bind(row.object_key, owner)
      ]);
    } catch {
      // No filenames/keys/identity in logs. The pending row remains for retry.
      console.error('Portrait storage cleanup pending');
      break;
    }
  }
  return {cleanupPending: (await pendingDeletions(db, owner)) > 0};
}

export async function readBoundedBody(request: Request, limit: number) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new CommerceError(413, '上传或请求内容超过大小限制');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new CommerceError(413, '上传或请求内容超过大小限制'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
