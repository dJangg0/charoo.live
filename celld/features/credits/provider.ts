// Gateway-agnostic payment seam (FR-13, AD-06). No live gateway exists yet.
// The sandbox adapter is the only implementation. It is unavailable in
// production and requires an explicit CREDITS_SANDBOX=true, because it is a
// free-money endpoint if it ever leaks.
import { z, type CreditPack } from "@charoo/contracts";
import type { Env } from "../../env";
import { HttpError } from "../../shared/errors";

export const WEBHOOK_SIGNATURE_HEADER = "X-Charoo-Credits-Signature";
const MAX_WEBHOOK_BYTES = 8192;

export type CheckoutOrder = { userId: string; pack: CreditPack };
export type SettledEvent = { reference: string; state: "PAID" | "FAILED" };

export interface CreditPaymentProvider {
  id: string;
  createCheckout(
    order: CheckoutOrder,
    env: Env,
  ): Promise<{ url: string; reference: string }>;
  verifyWebhook(req: Request, env: Env): Promise<SettledEvent>;
}

const eventSchema = z.object({
  reference: z.string().min(8).max(120),
  state: z.enum(["PAID", "FAILED"]),
});

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signBody(secret: string, body: string) {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(body),
  );
  return `sha256=${Array.from(new Uint8Array(mac), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")}`;
}

// Verify the provider signature over the raw body before trusting any field.
async function verifySignedEvent(req: Request, env: Env) {
  requireSecret(env);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES)
    throw new HttpError(413, "Webhook payload too large");
  const body = await req.text();
  if (body.length > MAX_WEBHOOK_BYTES)
    throw new HttpError(413, "Webhook payload too large");
  const expected = await signBody(env.CREDITS_WEBHOOK_SECRET!, body);
  const given = req.headers.get(WEBHOOK_SIGNATURE_HEADER) ?? "";
  if (!timingSafeEqual(expected, given))
    throw new HttpError(401, "Invalid webhook signature");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, "Invalid webhook payload");
  }
  const event = eventSchema.safeParse(parsed);
  if (!event.success) throw new HttpError(400, "Invalid webhook payload");
  return event.data;
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireSecret(env: Env) {
  if (!env.CREDITS_WEBHOOK_SECRET)
    throw new HttpError(503, "Payments are not configured");
}

export const sandboxProvider: CreditPaymentProvider = {
  id: "sandbox",
  async createCheckout(_order, env) {
    const reference = crypto.randomUUID();
    return {
      url: `${env.WEB_ORIGIN}/#credits-checkout=${reference}`,
      reference,
    };
  },
  verifyWebhook: verifySignedEvent,
};

export function sandboxAvailable(env: Env) {
  return (
    env.NODE_ENV !== "production" &&
    env.CREDITS_SANDBOX === "true" &&
    !!env.CREDITS_WEBHOOK_SECRET
  );
}

// Checkout uses the first available provider. With none configured, purchases are explicitly unavailable.
export function activeProvider(env: Env): CreditPaymentProvider {
  if (sandboxAvailable(env)) return sandboxProvider;
  throw new HttpError(503, "Payments are not available yet");
}

// Resolve a provider by id. Unknown or unavailable providers are not exposed.
export function creditProvider(env: Env, id: string): CreditPaymentProvider {
  if (id === "sandbox" && sandboxAvailable(env)) return sandboxProvider;
  throw new HttpError(404, "Endpoint unavailable");
}
