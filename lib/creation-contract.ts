import type {FrozenPhotography,StyleReference} from './photography-recipes';
import type {Photo,Job} from './portrait';
export type ExperienceVariant='A'|'B'|'C'|'D';
export type GenerationBudget={currency:'USD'|'CNY';limitMicro:number;reservedMicro:number;remainingMicro:number;perCallMicro:number};
export type GenerationCapability={configured:boolean;mode:'disabled'|'manual-assisted'|'api-ready'|'degraded';message:string;model:string|null;budget?:GenerationBudget;eligibleStyleIds?:string[];executionMode?:'server-stream-v1';requiresChargeConsent?:boolean};
export type CreationSlot={photography?:FrozenPhotography;id:string;jobId:string;index:number;styleId:string;prompt:string;promptVersion:string;status:string;attemptId:string|null;error:string|null};
export type CreationResult={id:string;jobId:string;slotId:string|null;url:string;qa:string;source:string;revealed:boolean;favorite:boolean;selected:boolean;kind:'result'|'generation_evidence'};
export type GenerationCost={slotId:string;attemptId:string;currency:'CNY';reservedMicro:number;estimatedMicro:null;actualMicro:null;status:'not-called'|'estimated'|'unknown'};
export type CreationSession={costs?:GenerationCost[];id:string;variant:ExperienceVariant;status:string;createdAt:string;updatedAt:string;styleIds:string[];references:Photo[];jobs:Job[];slots:CreationSlot[];results:CreationResult[];expectedCount:number};
export type CreateSessionInput={idempotencyKey:string;variant:ExperienceVariant;styleIds:string[];countPerStyle:number;references:{id:string;role:Photo['role']}[];consentVersion:string;notes?:string;wardrobeByStyle?:Record<string,string>};
export type CreationAction={action:'queue';slotId?:string}|{action:'cancel'}|{action:'choice';assetId:string;revealed?:boolean;favorite?:boolean;selected?:boolean}|{action:'review';assetId:string;qa:'accepted'|'rejected';note:string};
/** Dedicated service auth: Authorization: Bearer PORTRAIT_WORKER_SECRET. Never browser user headers. */
export type WorkerClaim={inputPolicy?:'person-only';watermark?:false;styleReference?:StyleReference;outputAspectRatio?:'3:4';attemptId:string;leaseToken:string;leaseExpiresAt:string;slotId:string;prompt:string;promptVersion:string;model:string;provider:string;references:{id:string;role:string;sha256:string;url:string}[]};
/** POST /api/generation/worker JSON. Claim response {claim:WorkerClaim|null}; others {ok:true}. */
export type WorkerAction={action:'claim';grantId?:string;slotId?:string}|{action:'batch-status'|'close-grant';grantId:string}|{action:'register';adapterReady:true;provider:string;model:string;budgetCurrency:'USD'|'CNY';supportedAspectRatios:string[];maxImages:number}|{action:'recover';attemptId:string;leaseToken:string;outputHash:string;model:string}|{action:'heartbeat'|'dispatch';attemptId:string;leaseToken:string}|{action:'fail';attemptId:string;leaseToken:string;uncertain:boolean;error:string};
/** GET /api/generation/worker/reference?attemptId=...&assetId=... uses service bearer and X-Portrait-Lease header.
 * POST /api/generation/worker/result multipart: attemptId, leaseToken, file, metadata JSON
 * metadata={providerRequestId?:string,model:string,usage?:unknown,inputHashes?:string[]}.
 * Return {assetId:string}; evidence requires real review before result promotion.
 */
