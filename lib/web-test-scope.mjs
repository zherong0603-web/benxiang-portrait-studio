/** Private test grants cannot be parsed or executed by this edition. */
/** @typedef {{sessionId:string,slotId:string,styleId:string,promptHash:string,reference:{id:string,sha256:string},normalizedInputHash:string}} WebSixSlot */
/** @typedef {{version:string,grantId:string,status:'open'|'closed',maxCalls:number,maxNewCnyMicro:number,perCallMicro:number,baselineCnyMicro:number,baselineFingerprint:string,ownerId:string,slots:WebSixSlot[]}} WebSixScope */
const unavailable=()=>new Error('Private test scope is unavailable in this edition');

/** @param {unknown} _raw @returns {WebSixScope} */
export function parseWebTestScope(_raw){throw unavailable()}
/** @param {WebSixScope} _scope @returns {Promise<string>} */
export async function scopeFingerprint(_scope){throw unavailable()}
/** @param {WebSixScope} _scope @param {unknown} _id @returns {WebSixSlot} */
export function scopeSlot(_scope,_id){throw unavailable()}
export async function assertScopeSlot(_scope,_row){throw unavailable()}
export function assertScopeAttempt(_scope,_attempt){throw unavailable()}
export function assertScopeOrder(_scope,_slot,_attempts,_options){throw unavailable()}

/** Shared canonical reservation fingerprint. Never reads or contains a private ledger. */
export async function reservationFingerprint(rows){
 const canonical=rows.map(r=>({attempt_id:r.attempt_id,reserved_micro:r.reserved_micro,currency:r.currency,created_at:r.created_at})).sort((a,b)=>a.attempt_id<b.attempt_id?-1:a.attempt_id>b.attempt_id?1:0);
 if(canonical.some(r=>typeof r.attempt_id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(r.attempt_id)||!Number.isSafeInteger(r.reserved_micro)||r.reserved_micro<=0||r.currency!=='CNY'||typeof r.created_at!=='string')||new Set(canonical.map(r=>r.attempt_id)).size!==canonical.length)throw unavailable();
 const data=new TextEncoder().encode(JSON.stringify(canonical));
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),x=>x.toString(16).padStart(2,'0')).join('');
}
