/**
 * Stripe billing — Checkout + Customer Portal + webhook.
 *
 * Plans (mapped to Stripe Price IDs via env vars):
 *   - free        : no subscription row needed, default state
 *   - starter     : STRIPE_PRICE_STARTER  (e.g. $29/mo)
 *   - pro         : STRIPE_PRICE_PRO      (e.g. $99/mo)
 *   - business    : STRIPE_PRICE_BUSINESS (e.g. $299/mo)
 *
 * Env vars:
 *   STRIPE_SECRET_KEY            — server-side API key (sk_live_... / sk_test_...)
 *   STRIPE_WEBHOOK_SECRET        — whsec_... used to verify webhook signatures
 *   STRIPE_PRICE_STARTER|PRO|BUSINESS — price_... ids created in Stripe dashboard
 *   STRIPE_CHECKOUT_RETURN_URL   — optional override (default: https://influencexes.com/billing)
 */

const { queryOne, exec } = require('./database');
const { v4: uuidv4 } = require('uuid');

let _stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (_stripe) return _stripe;
  const Stripe = require('stripe');
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  return _stripe;
}

function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

const PLANS = [
  { id: 'free',     label: 'Free',     price_cents: 0,    priceEnv: null,                     features: ['3 agents', '100 runs/mo', '1 workspace'] },
  { id: 'starter',  label: 'Starter',  price_cents: 2900, priceEnv: 'STRIPE_PRICE_STARTER',   features: ['All agents', '2,000 runs/mo', '3 workspaces', 'Email support'] },
  { id: 'pro',      label: 'Pro',      price_cents: 9900, priceEnv: 'STRIPE_PRICE_PRO',       features: ['Everything in Starter', '10,000 runs/mo', '10 workspaces', 'Gemini + Claude Sonnet', 'Priority support'] },
  { id: 'business', label: 'Business', price_cents: 29900, priceEnv: 'STRIPE_PRICE_BUSINESS', features: ['Everything in Pro', 'Unlimited runs', 'Unlimited workspaces', 'SerpAPI included', 'SLA + dedicated CSM'] },
];

function priceIdFor(planId) {
  const plan = PLANS.find(p => p.id === planId);
  if (!plan || !plan.priceEnv) return null;
  return process.env[plan.priceEnv] || null;
}

function listPlans() {
  return PLANS.map(p => ({
    id: p.id,
    label: p.label,
    price_cents: p.price_cents,
    features: p.features,
    available: p.id === 'free' ? true : !!priceIdFor(p.id),
  }));
}

async function getSubscription(workspaceId) {
  const row = await queryOne(
    `SELECT * FROM subscriptions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1`,
    [workspaceId]
  );
  if (!row) return { workspace_id: workspaceId, plan: 'free', status: 'active' };
  return row;
}

async function ensureCustomer(workspaceId, userEmail) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  const existing = await queryOne('SELECT stripe_customer_id FROM subscriptions WHERE workspace_id = ? AND stripe_customer_id IS NOT NULL ORDER BY created_at DESC LIMIT 1', [workspaceId]);
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: userEmail,
    metadata: { workspace_id: workspaceId },
  });
  return customer.id;
}

async function createCheckoutSession({ workspaceId, userEmail, planId }) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  const price = priceIdFor(planId);
  if (!price) throw new Error(`Plan ${planId} not available (missing price env var)`);
  const customerId = await ensureCustomer(workspaceId, userEmail);
  const base = process.env.STRIPE_CHECKOUT_RETURN_URL || 'https://influencexes.com/billing';
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}?stripe=cancel`,
    subscription_data: {
      metadata: { workspace_id: workspaceId, plan: planId },
    },
    metadata: { workspace_id: workspaceId, plan: planId },
  });
  return { url: session.url, sessionId: session.id };
}

async function createPortalSession({ workspaceId }) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  const row = await queryOne('SELECT stripe_customer_id FROM subscriptions WHERE workspace_id = ? AND stripe_customer_id IS NOT NULL ORDER BY created_at DESC LIMIT 1', [workspaceId]);
  if (!row?.stripe_customer_id) throw new Error('No Stripe customer for this workspace — subscribe first');
  const base = process.env.STRIPE_CHECKOUT_RETURN_URL || 'https://influencexes.com/billing';
  const session = await stripe.billingPortal.sessions.create({
    customer: row.stripe_customer_id,
    return_url: base,
  });
  return { url: session.url };
}

function verifyWebhookSignature(rawBody, signature) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Upsert a subscription row from a Stripe subscription object.
 */
async function syncSubscription(stripeSub) {
  const workspaceId = stripeSub.metadata?.workspace_id;
  if (!workspaceId) return; // Can't map — ignore
  const planId = stripeSub.metadata?.plan || 'starter';
  const priceId = stripeSub.items?.data?.[0]?.price?.id || null;
  const customerId = typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer?.id;
  const periodEnd = stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000).toISOString() : null;

  const existing = await queryOne(
    'SELECT id FROM subscriptions WHERE stripe_subscription_id = ? LIMIT 1',
    [stripeSub.id]
  );
  if (existing) {
    await exec(
      `UPDATE subscriptions SET status=?, plan=?, stripe_price_id=?, stripe_customer_id=?, current_period_end=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [stripeSub.status, planId, priceId, customerId, periodEnd, existing.id]
    );
  } else {
    await exec(
      `INSERT INTO subscriptions (id, workspace_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan, status, current_period_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), workspaceId, customerId, stripeSub.id, priceId, planId, stripeSub.status, periodEnd]
    );
  }
}

async function handleWebhookEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      // Fetch the subscription object and sync
      const stripe = getStripe();
      const session = event.data.object;
      if (session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        // If metadata wasn't copied over, copy from session
        if (!sub.metadata?.workspace_id && session.metadata?.workspace_id) {
          await stripe.subscriptions.update(sub.id, {
            metadata: { workspace_id: session.metadata.workspace_id, plan: session.metadata.plan || 'starter' },
          });
          sub.metadata = { ...sub.metadata, ...session.metadata };
        }
        await syncSubscription(sub);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await syncSubscription(event.data.object);
      break;
    default:
      // Ignore other events
      break;
  }
}

module.exports = {
  isConfigured,
  listPlans,
  getSubscription,
  createCheckoutSession,
  createPortalSession,
  verifyWebhookSignature,
  handleWebhookEvent,
};
