import { CommerceError, COMMERCE_TERMS_VERSION, type CommerceSettings, type OrderRecord, type PortraitPackage, type PublicOrder, type VerifiedPaymentEvent } from './commerce-contract';

const currencies = new Set(['cny','usd','hkd','eur','gbp','sgd','aud','cad']);
const clean = (value: unknown, max: number) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
const now = () => new Date().toISOString();

export function commerceConfig(settings: CommerceSettings) {
  const requested = settings.COMMERCE_MODE;
  const mode = requested === 'test' ? 'test' : requested === 'live' && settings.COMMERCE_LIVE_ENABLED === 'true' ? 'live' : 'disabled';
  let catalog: PortraitPackage[] = [];
  let catalogError = false;
  if (settings.COMMERCE_CATALOG_JSON) {
    try {
      const parsed = JSON.parse(settings.COMMERCE_CATALOG_JSON);
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > 12) throw new Error();
      catalog = parsed.map((p: any) => {
        if (!p || typeof p !== 'object') throw new Error();
        const id = clean(p.id, 60), name = clean(p.name, 80), description = clean(p.description || '', 500);
        const currency = clean(p.currency, 3).toLowerCase();
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || !name || !currencies.has(currency) || !Number.isSafeInteger(p.count) || p.count < 1 || p.count > 12 || !Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0 || p.amountMinor > 100000000) throw new Error();
        return {id,name,description,currency,count:p.count,amountMinor:p.amountMinor};
      });
      if (new Set(catalog.map(p => p.id)).size !== catalog.length) throw new Error();
    } catch { catalog = []; catalogError = true; }
  }
  const message = mode === 'disabled' ? '收费尚未开放。现有创作任务可继续使用。' : catalogError ? '套餐配置无效，暂不能下单。' : !catalog.length ? '尚未配置服务套餐，暂不能下单。' : mode === 'test' ? '支付测试模式：不会形成真实收费。' : '真实交易模式';
  return {mode,catalog,message,termsVersion:COMMERCE_TERMS_VERSION} as const;
}

export function isCommerceOperator(actor: string, settings: CommerceSettings) {
  return !!actor && (settings.COMMERCE_OPERATOR_IDS || '').split(',').map(x => x.trim()).filter(Boolean).includes(actor);
}

export function publicOrder(order: OrderRecord): PublicOrder {
  return {id:order.id,jobId:order.job_id,package:JSON.parse(order.package_snapshot),amountMinor:order.amount_minor,currency:order.currency,mode:order.mode,paymentStatus:order.payment_status,fulfillmentStatus:order.fulfillment_status,termsVersion:order.terms_version,paidAt:order.paid_at,deliveredAt:order.delivered_at,createdAt:order.created_at,updatedAt:order.updated_at};
}

export async function hasOrderForJob(db: D1Database, owner: string, jobId: string) {
  return db.prepare('SELECT * FROM orders WHERE job_id=? AND owner_id=?').bind(jobId,owner).first<OrderRecord>();
}

/** Cross-customer access can only originate from a verified paid order. */
export async function paidJobAccess(db: D1Database, actor: string, jobId: string, settings: CommerceSettings) {
  if (!isCommerceOperator(actor,settings)) return null;
  const order = await db.prepare("SELECT * FROM orders WHERE job_id=? AND payment_status='paid'").bind(jobId).first<OrderRecord>();
  return order ? {owner:order.owner_id,order} : null;
}

export async function orderRecord(db: D1Database, actor: string, id: string, settings: CommerceSettings) {
  const row = await db.prepare('SELECT * FROM orders WHERE id=? AND (owner_id=? OR (?=1 AND payment_status=\'paid\'))').bind(id,actor,isCommerceOperator(actor,settings)?1:0).first<OrderRecord>();
  if (!row) throw new CommerceError(404,'找不到这笔订单');
  return row;
}

export async function listOrders(db: D1Database, actor: string, settings: CommerceSettings, operatorScope = false) {
  if (operatorScope && !isCommerceOperator(actor,settings)) throw new CommerceError(403,'需要履约人员权限');
  const result = operatorScope
    ? await db.prepare("SELECT * FROM orders WHERE payment_status='paid' ORDER BY CASE WHEN fulfillment_status='delivered' THEN 1 ELSE 0 END,created_at LIMIT 200").all<OrderRecord>()
    : await db.prepare('SELECT * FROM orders WHERE owner_id=? ORDER BY created_at DESC LIMIT 200').bind(actor).all<OrderRecord>();
  return result.results.map(publicOrder);
}

export async function createOrder(db: D1Database, owner: string, input: Record<string,unknown>, settings: CommerceSettings) {
  const key = clean(input.idempotencyKey,100), jobId = clean(input.jobId,100), packageId = clean(input.packageId,60);
  if (!key || !jobId || !packageId) throw new CommerceError(400,'缺少订单提交标识、任务或套餐');
  const existing = await db.prepare('SELECT * FROM orders WHERE owner_id=? AND idempotency_key=?').bind(owner,key).first<OrderRecord>();
  if (existing) {
    if (existing.job_id !== jobId || existing.package_id !== packageId || input.termsVersion !== existing.terms_version) throw new CommerceError(409,'此提交标识已用于另一笔订单');
    return existing;
  }
  const config = commerceConfig(settings);
  if (config.mode === 'disabled') throw new CommerceError(503,'收费尚未开放，可先保存创作任务');
  if (input.termsVersion !== COMMERCE_TERMS_VERSION) throw new CommerceError(400,'请阅读并同意当前服务与隐私条款');
  const chosen = config.catalog.find(p => p.id === packageId);
  if (!chosen) throw new CommerceError(400,'请选择有效套餐');
  const job = await db.prepare('SELECT id,count,status FROM jobs WHERE id=? AND owner_id=?').bind(jobId,owner).first<{id:string;count:number;status:string}>();
  if (!job) throw new CommerceError(404,'找不到这项任务');
  if (job.count !== chosen.count) throw new CommerceError(409,'任务出图数量与套餐不一致，请重新选择');
  if (job.status !== 'ready') throw new CommerceError(409,'请使用尚未制作的新任务下单');
  const previous = await hasOrderForJob(db,owner,jobId);
  if (previous) throw new CommerceError(409,'该任务已有订单，请打开已有订单');
  const id = crypto.randomUUID(), timestamp = now();
  try {
    const saved = await db.prepare(`INSERT INTO orders (id,owner_id,job_id,idempotency_key,package_id,package_snapshot,amount_minor,currency,mode,payment_status,fulfillment_status,terms_version,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM jobs WHERE id=? AND owner_id=? AND status='ready' AND deletion_token IS NULL AND count=?) AND NOT EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=?) AND NOT EXISTS (SELECT 1 FROM assets WHERE job_id=? AND owner_id=? AND kind='result')`).bind(id,owner,jobId,key,chosen.id,JSON.stringify(chosen),chosen.amountMinor,chosen.currency,config.mode,'unpaid','awaiting_payment',COMMERCE_TERMS_VERSION,timestamp,timestamp,jobId,owner,chosen.count,owner,jobId,owner).run();
    if (!saved.meta.changes) throw new CommerceError(409,'任务已开始制作或已删除，请刷新后重试');
  } catch (error) {
    const raced = await db.prepare('SELECT * FROM orders WHERE owner_id=? AND idempotency_key=?').bind(owner,key).first<OrderRecord>();
    if (raced && raced.job_id === jobId && raced.package_id === packageId && raced.terms_version === input.termsVersion) return raced;
    if (await hasOrderForJob(db,owner,jobId)) throw new CommerceError(409,'该任务已有订单，请打开已有订单');
    throw error;
  }
  return orderRecord(db,owner,id,settings);
}

/** Reserve before making a provider request: cancellation cannot race checkout creation. */
export async function reserveCheckout(db: D1Database, owner: string, id: string, settings: CommerceSettings) {
  let order = await orderRecord(db,owner,id,{});
  const config = commerceConfig(settings);
  if (config.mode === 'disabled' || order.mode !== config.mode) throw new CommerceError(409,'支付模式已变化，请联系工作室');
  if (order.payment_status === 'paid') throw new CommerceError(409,'该订单已经付款');
  if (order.payment_status === 'cancelled') throw new CommerceError(409,'该订单已经取消');
  if (order.payment_status === 'checkout_pending') return order;
  const provider = settings.COMMERCE_PAYMENT_PROVIDER || 'wechat';
  if (!['wechat','stripe'].includes(provider)) throw new CommerceError(503,'尚未配置支付渠道');
  const saved = await db.prepare(`UPDATE orders SET payment_status='checkout_pending',checkout_attempt=checkout_attempt+1,provider=?,provider_checkout_id=NULL,checkout_url=NULL,checkout_expires_at=NULL,updated_at=?
    WHERE id=? AND owner_id=? AND payment_status='unpaid' AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id=orders.job_id AND jobs.owner_id=orders.owner_id AND jobs.status='ready' AND deletion_token IS NULL) AND NOT EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=orders.owner_id) AND NOT EXISTS (SELECT 1 FROM assets WHERE assets.job_id=orders.job_id AND assets.owner_id=orders.owner_id AND assets.kind='result')`).bind(provider,now(),id,owner).run();
  order = await orderRecord(db,owner,id,{});
  if (!saved.meta.changes && order.payment_status !== 'checkout_pending') throw new CommerceError(409,'订单状态已经变化，请刷新');
  return order;
}

export async function saveCheckout(db: D1Database, owner: string, order: OrderRecord, session: {id:string;url:string;expiresAt:string;provider:'stripe'|'wechat'}) {
  let url: URL;
  try { url = new URL(session.url); } catch { throw new CommerceError(502,'支付服务返回无效链接'); }
  const trustedLink = session.provider === 'stripe' ? url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' : session.provider === 'wechat' && url.protocol === 'weixin:' && url.hostname === 'wxpay' && url.pathname === '/bizpayurl';
  if (!trustedLink || order.provider !== session.provider || !session.id || !Number.isFinite(Date.parse(session.expiresAt))) throw new CommerceError(502,'支付服务返回无效会话');
  await db.prepare(`UPDATE orders SET provider=?,provider_checkout_id=?,checkout_url=?,checkout_expires_at=?,updated_at=? WHERE id=? AND owner_id=? AND checkout_attempt=? AND payment_status IN ('checkout_pending','paid') AND (provider_checkout_id IS NULL OR provider_checkout_id=?) AND (checkout_expires_at IS NULL OR checkout_expires_at<=?)`).bind(session.provider,session.id,session.url,session.expiresAt,now(),order.id,owner,order.checkout_attempt,session.id,session.expiresAt).run();
  return db.prepare('SELECT * FROM orders WHERE id=? AND owner_id=?').bind(order.id,owner).first<OrderRecord>();
}

export async function cancelOrder(db: D1Database, owner: string, id: string, settings: CommerceSettings) {
  const order = await orderRecord(db,owner,id,{});
  if (order.payment_status === 'cancelled') return order;
  const timestamp = now();
  const saved = await db.prepare("UPDATE orders SET payment_status='cancelled',cancelled_at=?,updated_at=? WHERE id=? AND owner_id=? AND payment_status='unpaid'").bind(timestamp,timestamp,id,owner).run();
  if (!saved.meta.changes) throw new CommerceError(409,'付款处理中或已付款的订单不能取消；请等待支付结果或联系工作室');
  return orderRecord(db,owner,id,settings);
}

export async function fulfillOrder(db: D1Database, actor: string, id: string, action: 'start'|'deliver', settings: CommerceSettings) {
  if (!isCommerceOperator(actor,settings)) throw new CommerceError(403,'需要履约人员权限');
  const order = await orderRecord(db,actor,id,settings);
  if (order.payment_status !== 'paid' || !order.job_id) throw new CommerceError(409,'仅能处理已付款且任务可用的订单');
  const timestamp = now();
  if (action === 'start') {
    if (order.fulfillment_status === 'delivered') throw new CommerceError(409,'订单已经交付');
    const started = await db.prepare("UPDATE orders SET fulfillment_status='in_progress',updated_at=? WHERE id=? AND payment_status='paid' AND fulfillment_status='queued' AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id=orders.job_id AND jobs.owner_id=orders.owner_id AND jobs.deletion_token IS NULL)").bind(timestamp,id).run();
    if (!started.meta.changes && order.fulfillment_status !== 'in_progress') throw new CommerceError(409,'任务状态已经变化，请刷新后重试');
  } else {
    // Both writes execute in one D1 transaction. No browser claim can mark delivery.
    const results = await db.batch([
      db.prepare(`UPDATE jobs SET status='completed',updated_at=? WHERE id=? AND owner_id=? AND deletion_token IS NULL AND status IN ('review','completed') AND (SELECT COUNT(*) FROM assets WHERE assets.job_id=jobs.id AND assets.owner_id=jobs.owner_id AND kind='result')=count AND NOT EXISTS (SELECT 1 FROM assets WHERE assets.job_id=jobs.id AND assets.owner_id=jobs.owner_id AND kind='result' AND qa!='accepted') AND EXISTS (SELECT 1 FROM orders WHERE orders.job_id=jobs.id AND orders.owner_id=jobs.owner_id AND orders.id=? AND payment_status='paid' AND fulfillment_status IN ('queued','in_progress','delivered'))`).bind(timestamp,order.job_id,order.owner_id,id),
      db.prepare(`UPDATE orders SET fulfillment_status='delivered',delivered_at=COALESCE(delivered_at,?),updated_at=? WHERE id=? AND payment_status='paid' AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id=orders.job_id AND jobs.owner_id=orders.owner_id AND jobs.deletion_token IS NULL AND jobs.status='completed' AND (SELECT COUNT(*) FROM assets WHERE assets.job_id=jobs.id AND assets.owner_id=jobs.owner_id AND kind='result')=jobs.count AND NOT EXISTS (SELECT 1 FROM assets WHERE assets.job_id=jobs.id AND assets.owner_id=jobs.owner_id AND kind='result' AND qa!='accepted'))`).bind(timestamp,timestamp,id)
    ]);
    if (!results[1].meta.changes) throw new CommerceError(409,'请导入套餐约定的全部作品，并逐张完成相似度和画面检查');
  }
  return orderRecord(db,actor,id,settings);
}

/** Call only after a provider signature has been verified. No client or operator paid action exists. */
export async function applyPaymentEvent(db: D1Database, event: VerifiedPaymentEvent) {
  if (!['stripe','wechat'].includes(event.provider) || (event.provider === 'wechat' && event.mode !== 'live') || !clean(event.id,200) || !clean(event.checkoutId,200) || !clean(event.orderId,100) || !clean(event.ownerId,200) || !Number.isSafeInteger(event.checkoutAttempt) || event.checkoutAttempt < 1 || !Number.isSafeInteger(event.amountMinor) || event.amountMinor <= 0 || typeof event.currency !== 'string' || !['paid','expired','failed'].includes(event.type)) throw new CommerceError(400,'支付事件内容无效');
  if (event.type === 'paid' && !clean(event.paymentId,200)) throw new CommerceError(400,'支付交易编号缺失');
  if (event.type === 'paid' && await db.prepare('SELECT id FROM orders WHERE provider=? AND provider_payment_id=? AND id!=?').bind(event.provider,event.paymentId,event.orderId).first()) throw new CommerceError(409,'同一笔支付交易不能用于多个订单');
  const prior = await db.prepare('SELECT order_id FROM order_payment_events WHERE provider=? AND event_id=?').bind(event.provider,event.id).first<{order_id:string}>();
  if (prior) {
    if (prior.order_id !== event.orderId) throw new CommerceError(409,'支付事件归属不一致');
    return {received:true,duplicate:true};
  }
  const order = await db.prepare('SELECT * FROM orders WHERE id=?').bind(event.orderId).first<OrderRecord>();
  if (!order) throw new CommerceError(404,'支付对应的订单不存在');
  if (order.owner_id !== event.ownerId || order.mode !== event.mode || order.amount_minor !== event.amountMinor || order.currency !== event.currency.toLowerCase() || order.checkout_attempt !== event.checkoutAttempt || (order.provider && order.provider !== event.provider) || (order.provider_checkout_id && order.provider_checkout_id !== event.checkoutId) || (event.type === 'paid' && order.provider_payment_id && order.provider_payment_id !== event.paymentId)) throw new CommerceError(409,'支付金额、币种或订单归属校验未通过');
  if (order.payment_status === 'cancelled') throw new CommerceError(409,'订单已取消，支付事件需要人工核对');
  const timestamp = now();
  const update = event.type === 'paid'
    ? db.prepare(`UPDATE orders SET payment_status='paid',fulfillment_status=CASE WHEN payment_status='paid' THEN fulfillment_status ELSE 'queued' END,provider=?,provider_checkout_id=?,provider_payment_id=COALESCE(provider_payment_id,?),paid_at=COALESCE(paid_at,?),updated_at=? WHERE id=? AND owner_id=? AND mode=? AND amount_minor=? AND currency=? AND checkout_attempt=? AND payment_status IN ('checkout_pending','paid') AND (provider_checkout_id IS NULL OR provider_checkout_id=?) AND NOT EXISTS (SELECT 1 FROM order_payment_events WHERE provider=? AND event_id=?)`).bind(event.provider,event.checkoutId,event.paymentId||null,timestamp,timestamp,order.id,event.ownerId,event.mode,event.amountMinor,event.currency.toLowerCase(),event.checkoutAttempt,event.checkoutId,event.provider,event.id)
    : db.prepare(`UPDATE orders SET payment_status='unpaid',checkout_url=NULL,checkout_expires_at=NULL,updated_at=? WHERE id=? AND owner_id=? AND mode=? AND amount_minor=? AND currency=? AND checkout_attempt=? AND payment_status='checkout_pending' AND (provider_checkout_id IS NULL OR provider_checkout_id=?) AND NOT EXISTS (SELECT 1 FROM order_payment_events WHERE provider=? AND event_id=?)`).bind(timestamp,order.id,event.ownerId,event.mode,event.amountMinor,event.currency.toLowerCase(),event.checkoutAttempt,event.checkoutId,event.provider,event.id);
  let result: D1Result[];
  try { result = await db.batch([
    update,
    db.prepare(`INSERT INTO order_payment_events (provider,event_id,order_id,event_type,mode,checkout_id,received_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM orders WHERE id=? AND checkout_attempt=? AND (?!='paid' OR (payment_status='paid' AND provider_checkout_id=?))) ON CONFLICT(provider,event_id) DO NOTHING`).bind(event.provider,event.id,order.id,event.type,event.mode,event.checkoutId,timestamp,order.id,event.checkoutAttempt,event.type,event.checkoutId)
  ]); } catch(error) {
    if (event.type === 'paid' && await db.prepare('SELECT id FROM orders WHERE provider=? AND provider_payment_id=? AND id!=?').bind(event.provider,event.paymentId,event.orderId).first()) throw new CommerceError(409,'同一笔支付交易不能用于多个订单');
    throw error;
  }
  // A duplicate/late expiration is acknowledged; it must never reverse an accepted payment.
  if (!result[0].meta.changes && event.type === 'paid') {
    const current = await db.prepare('SELECT payment_status,provider_checkout_id,checkout_attempt FROM orders WHERE id=?').bind(order.id).first<OrderRecord>();
    if (current?.payment_status !== 'paid' || current.provider_checkout_id !== event.checkoutId || current.checkout_attempt !== event.checkoutAttempt) throw new CommerceError(409,'订单状态已变化，支付需要人工核对');
  }
  return {received:true,duplicate:!result[1].meta.changes};
}

/** Keep only de-identified accounting evidence. Active paid work and live checkouts must finish first. */
export async function anonymizeOrdersForOwner(db: D1Database, owner: string, privacyToken?: string) {
  const cutoff=new Date(Date.now()-10*60*1000).toISOString();
  if(privacyToken&&!await db.prepare('SELECT owner_id FROM privacy_locks WHERE owner_id=? AND token=? AND created_at>?').bind(owner,privacyToken,cutoff).first())throw new CommerceError(409,'清理操作已过期，请重新核对数据后重试');
  const blocked = await db.prepare("SELECT id FROM orders WHERE owner_id=? AND (payment_status='checkout_pending' OR (payment_status='paid' AND fulfillment_status!='delivered')) LIMIT 1").bind(owner).first();
  if (blocked) throw new CommerceError(409,'仍有支付中或待交付订单，请先处理订单再删除全部数据');
  const anonymized = `deleted:${crypto.randomUUID()}`;
  const saved = await db.prepare(`UPDATE orders SET owner_id=?,job_id=NULL,idempotency_key=id,checkout_url=NULL,updated_at=? WHERE owner_id=? AND (? IS NULL OR EXISTS (SELECT 1 FROM privacy_locks WHERE owner_id=? AND token=? AND created_at>?)) AND NOT EXISTS (SELECT 1 FROM orders active WHERE active.owner_id=? AND (active.payment_status='checkout_pending' OR (active.payment_status='paid' AND active.fulfillment_status!='delivered')))` ).bind(anonymized,now(),owner,privacyToken||null,owner,privacyToken||null,cutoff,owner).run();
  if (await db.prepare("SELECT id FROM orders WHERE owner_id=? AND (payment_status='checkout_pending' OR (payment_status='paid' AND fulfillment_status!='delivered')) LIMIT 1").bind(owner).first()) throw new CommerceError(409,'订单状态刚刚变化，请处理订单后再删除数据');
  // No personal photo or prompt data is copied into financial records.
  return saved.meta.changes;
}
