/** Public commerce data: never include provider credentials or customer identity. */
export type CommerceMode = 'disabled' | 'test' | 'live';
export type PaymentStatus = 'unpaid' | 'checkout_pending' | 'paid' | 'cancelled';
export type FulfillmentStatus = 'awaiting_payment' | 'queued' | 'in_progress' | 'delivered';
export type PortraitPackage = {
  id: string;
  name: string;
  count: number;
  amountMinor: number;
  currency: string;
  description: string;
};
export type CommerceSettings = {
  COMMERCE_MODE?: string;
  COMMERCE_LIVE_ENABLED?: string;
  COMMERCE_CATALOG_JSON?: string;
  COMMERCE_OPERATOR_IDS?: string;
  COMMERCE_ALLOWED_ORIGIN?: string;
  COMMERCE_PAYMENT_PROVIDER?: string;
  WECHAT_APP_ID?: string;
  WECHAT_MCH_ID?: string;
  WECHAT_MCH_SERIAL?: string;
  WECHAT_PRIVATE_KEY?: string;
  WECHAT_API_V3_KEY?: string;
  WECHAT_PLATFORM_KEY_ID?: string;
  WECHAT_PLATFORM_PUBLIC_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
};
export type OrderRecord = {
  id: string;
  owner_id: string;
  job_id: string | null;
  idempotency_key: string;
  package_id: string;
  package_snapshot: string;
  amount_minor: number;
  currency: string;
  mode: 'test' | 'live';
  payment_status: PaymentStatus;
  fulfillment_status: FulfillmentStatus;
  terms_version: string;
  checkout_attempt: number;
  provider: string | null;
  provider_checkout_id: string | null;
  checkout_url: string | null;
  checkout_expires_at: string | null;
  provider_payment_id: string | null;
  paid_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};
export type PublicOrder = {
  id: string;
  jobId: string | null;
  package: PortraitPackage;
  amountMinor: number;
  currency: string;
  mode: 'test' | 'live';
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  termsVersion: string;
  paidAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type VerifiedPaymentEvent = {
  id: string;
  provider: 'stripe' | 'wechat';
  type: 'paid' | 'expired' | 'failed';
  mode: 'test' | 'live';
  orderId: string;
  ownerId: string;
  checkoutAttempt: number;
  checkoutId: string;
  amountMinor: number;
  currency: string;
  paymentId?: string;
};
export const COMMERCE_TERMS_VERSION = '2026-10-23-v1';
export class CommerceError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
