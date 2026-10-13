import Stripe from "stripe";
import { choosePath } from "../engine/route.js";
import { HttpError } from "../http/errors.js";
import { planForPath } from "./plans.js";

const PRICE_ENV = {
  starter: "STRIPE_PRICE_STARTER",
  growth: "STRIPE_PRICE_GROWTH",
  scale: "STRIPE_PRICE_SCALE",
};

const ENDED_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"]);

export function priceIdForPlan(planCode) {
  const envName = PRICE_ENV[String(planCode || "").toLowerCase()];
  if (!envName) return null;
  const value = String(process.env[envName] || "").trim();
  return value || null;
}

function appBaseUrl() {
  return String(process.env.APP_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
}

function stripeSecret() {
  return String(process.env.STRIPE_SECRET_KEY || "").trim();
}

function stripeClient() {
  const key = stripeSecret();
  if (!key) throw new HttpError(503, "Billing is not configured.");
  return new Stripe(key);
}

function fittingPlan(schemaTextChars) {
  const chars = Number(schemaTextChars);
  if (!Number.isFinite(chars) || chars <= 0) {
    throw new HttpError(400, "Connect and index a database before subscribing.");
  }
  const plan = planForPath(choosePath(chars));
  return {
    code: plan.code,
    monthlyUsd: plan.monthlyUsd,
    questionLimit: plan.questionLimit,
    priceId: priceIdForPlan(plan.code),
  };
}

function rejectOtherPrice(body, plan) {
  if (!body || typeof body !== "object") return;
  const requestedPlan = String(body.planCode || "").trim().toLowerCase();
  const requestedPrice = String(body.price || body.priceId || "").trim();
  if (requestedPlan && requestedPlan !== plan.code) {
    throw new HttpError(400, "That plan does not match this workspace's schema.");
  }
  if (requestedPrice && requestedPrice !== plan.priceId) {
    throw new HttpError(400, "That price does not match this workspace's schema.");
  }
}

async function workspaceRow(catalog, workspaceId) {
  const [rows] = await catalog.execute(
    `SELECT id, schema_text_chars, stripe_customer_id, stripe_subscription_id, plan_code
     FROM workspaces
     WHERE id = ?`,
    [workspaceId]
  );
  if (!rows[0]) throw new HttpError(404, "Workspace not found.");
  return rows[0];
}

export async function createCheckoutSession(catalog, account, body) {
  const row = await workspaceRow(catalog, account.workspaceId);
  const plan = fittingPlan(row.schema_text_chars);
  rejectOtherPrice(body, plan);
  if (!plan.priceId) throw new HttpError(503, "Billing is not configured for this plan.");
  const stripe = stripeClient();
  const base = appBaseUrl();
  const metadata = {
    workspace_id: String(account.workspaceId),
    plan_code: plan.code,
    price_id: plan.priceId,
  };
  const params = {
    mode: "subscription",
    line_items: [{ price: plan.priceId, quantity: 1 }],
    success_url: `${base}/connect?billing=success`,
    cancel_url: `${base}/connect?billing=cancel`,
    client_reference_id: String(account.workspaceId),
    metadata,
    subscription_data: { metadata },
  };
  if (row.stripe_customer_id) params.customer = row.stripe_customer_id;
  else if (account.email) params.customer_email = account.email;
  const session = await stripe.checkout.sessions.create(params);
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL.");
  return { url: session.url };
}

export async function createPortalSession(catalog, workspaceId) {
  const row = await workspaceRow(catalog, workspaceId);
  if (!row.stripe_customer_id) throw new HttpError(400, "Subscribe first.");
  const stripe = stripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: row.stripe_customer_id,
    return_url: `${appBaseUrl()}/connect`,
  });
  if (!session.url) throw new HttpError(502, "Stripe did not return a billing URL.");
  return { url: session.url };
}

function idOf(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

function priceFromObject(obj) {
  const line = obj?.line_items?.data?.[0];
  const linePrice = idOf(line?.price);
  if (linePrice) return linePrice;
  const item = obj?.items?.data?.[0];
  const itemPrice = idOf(item?.price);
  if (itemPrice) return itemPrice;
  const invoiceLine = obj?.lines?.data?.[0];
  return idOf(invoiceLine?.price);
}

function subscriptionIdFrom(obj) {
  if (obj?.object === "subscription") return obj.id || null;
  return idOf(obj?.subscription) || idOf(obj?.parent?.subscription_details?.subscription);
}

async function paidPriceId(obj) {
  const direct = priceFromObject(obj);
  if (direct) return direct;
  const key = stripeSecret();
  if (!key || !obj?.id) return obj?.metadata?.price_id || null;
  try {
    const stripe = new Stripe(key);
    if (obj.object === "checkout.session") {
      const full = await stripe.checkout.sessions.retrieve(obj.id, { expand: ["line_items"] });
      return priceFromObject(full) || obj.metadata?.price_id || null;
    }
    if (obj.object === "subscription") {
      const full = await stripe.subscriptions.retrieve(obj.id);
      return priceFromObject(full) || obj.metadata?.price_id || null;
    }
  } catch {
    return obj.metadata?.price_id || null;
  }
  return obj.metadata?.price_id || null;
}

async function resolveWorkspaceId(catalog, obj) {
  const raw = obj?.metadata?.workspace_id || obj?.client_reference_id || "";
  const meta = Number(raw);
  if (Number.isInteger(meta) && meta > 0) {
    const [rows] = await catalog.execute(`SELECT id FROM workspaces WHERE id = ?`, [meta]);
    return rows[0] ? Number(rows[0].id) : null;
  }
  const customerId = idOf(obj?.customer);
  if (customerId) {
    const [rows] = await catalog.execute(
      `SELECT id FROM workspaces WHERE stripe_customer_id = ?`,
      [customerId]
    );
    if (rows[0]) return Number(rows[0].id);
  }
  const subscriptionId = subscriptionIdFrom(obj);
  if (subscriptionId) {
    const [rows] = await catalog.execute(
      `SELECT id FROM workspaces WHERE stripe_subscription_id = ?`,
      [subscriptionId]
    );
    if (rows[0]) return Number(rows[0].id);
  }
  return null;
}

async function writePlan(catalog, workspaceId, planCode, customerId, subscriptionId) {
  await catalog.execute(
    `UPDATE workspaces
       SET plan_code = ?,
           stripe_customer_id = COALESCE(?, stripe_customer_id),
           stripe_subscription_id = COALESCE(?, stripe_subscription_id)
     WHERE id = ?`,
    [planCode, customerId, subscriptionId, workspaceId]
  );
  console.log(`billing workspace=${workspaceId} plan=${planCode}`);
}

async function applyPaidPlan(catalog, workspaceId, customerId, subscriptionId, priceId) {
  const row = await workspaceRow(catalog, workspaceId);
  let planCode = "trial";
  try {
    const plan = fittingPlan(row.schema_text_chars);
    if (priceId && plan.priceId && priceId === plan.priceId) planCode = plan.code;
  } catch {
    planCode = "trial";
  }
  await writePlan(catalog, workspaceId, planCode, customerId, subscriptionId);
}

async function applyTrial(catalog, workspaceId, customerId, subscriptionId) {
  await writePlan(catalog, workspaceId, "trial", customerId, subscriptionId);
}

export async function handleStripeWebhook(catalog, rawBody, signature) {
  const secret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!secret) throw new HttpError(503, "Billing is not configured.");
  const stripe = new Stripe(stripeSecret() || "sk_test_unconfigured");
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new HttpError(400, "Invalid Stripe signature.");
  }

  const obj = event.data?.object || {};
  const workspaceId = await resolveWorkspaceId(catalog, obj);
  if (!workspaceId) return { received: true };

  const customerId = idOf(obj.customer);
  const subscriptionId = subscriptionIdFrom(obj);

  if (event.type === "checkout.session.completed") {
    const paid = !obj.payment_status || obj.payment_status === "paid" || obj.payment_status === "no_payment_required";
    if (!paid) {
      await applyTrial(catalog, workspaceId, customerId, subscriptionId);
      return { received: true };
    }
    await applyPaidPlan(catalog, workspaceId, customerId, subscriptionId, await paidPriceId(obj));
    return { received: true };
  }

  if (event.type === "customer.subscription.updated") {
    if (obj.status === "active") {
      await applyPaidPlan(catalog, workspaceId, customerId, subscriptionId, await paidPriceId(obj));
    } else if (ENDED_STATUSES.has(obj.status)) {
      await applyTrial(catalog, workspaceId, customerId, subscriptionId);
    }
    return { received: true };
  }

  if (event.type === "customer.subscription.deleted" || event.type === "invoice.payment_failed") {
    await applyTrial(catalog, workspaceId, customerId, subscriptionId);
  }

  return { received: true };
}
