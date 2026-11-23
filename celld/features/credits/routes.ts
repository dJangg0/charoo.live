import type { Hono } from "hono";
import {
  z,
  CREDIT_PACKS,
  creditOrderSchema,
  peekSchema,
  slotPurchaseSchema,
  type Settings,
} from "@charoo/contracts";
import {
  cursor,
  first,
  parseCursor,
  roomStub,
  coordinator,
  settings,
} from "../../shared/data";
import { requireThat, unwrap } from "../../shared/errors";
import {
  actor,
  body,
  uuid,
  userRate,
  type HttpContext,
  type HttpEnv,
} from "../../http/context";
import {
  walletOf,
  contactUsage,
  contactLimit,
  dailyClaim,
  utcDay,
  requireCredits,
  ledgerPage,
} from "./wallet";
import {
  activeProvider,
  creditProvider,
  signBody,
  WEBHOOK_SIGNATURE_HEADER,
} from "./provider";

// Every credit route requires a verified account and the credits flag.
async function creditsActor(c: HttpContext) {
  const cfg = await settings(c.env);
  requireCredits(cfg);
  requireThat(c.get("user")?.verified, 403, "Verify your email to use credits");
  return { cfg, a: actor(c) };
}

async function summary(c: HttpContext, cfg: Settings) {
  const userId = actor(c).userId,
    wallet = await walletOf(c.env, userId),
    claim = dailyClaim(wallet, cfg, utcDay());
  return {
    enabled: true,
    balance: wallet.balance,
    lifetimeEarned: wallet.lifetimeEarned,
    lifetimeSpent: wallet.lifetimeSpent,
    contactSlots: {
      used: await contactUsage(c.env, userId),
      limit: contactLimit(cfg, wallet),
      base: cfg.credits_contact_slot_base,
      extra: wallet.extraContactSlots,
      max: cfg.credits_contact_slot_max,
      pack: cfg.credits_contact_slot_pack,
      price: cfg.credits_contact_slot_price,
    },
    daily: {
      claimable: claim.claimable,
      streak: claim.streak,
      amount: claim.amount,
    },
    peekPrice: cfg.credits_peek_price,
    reconnectPrice: cfg.credits_enabled ? cfg.reconnect_price : 0,
    packs: CREDIT_PACKS,
  };
}

// Compact view for /api/me so the navigation needs no extra round trip.
export async function compactCredits(
  env: HttpEnv["Bindings"],
  user: { id: string; verified: boolean } | undefined,
  cfg: Settings,
) {
  if (!cfg.credits_enabled || !user?.verified)
    return { enabled: cfg.credits_enabled, balance: 0, dailyClaimable: false };
  const wallet = await walletOf(env, user.id);
  return {
    enabled: true,
    balance: wallet.balance,
    dailyClaimable: dailyClaim(wallet, cfg, utcDay()).claimable,
  };
}

export function creditRoutes(app: Hono<HttpEnv>) {
  app.get("/api/credits", async (c) => {
    const { cfg } = await creditsActor(c);
    return c.json(await summary(c, cfg));
  });

  app.get("/api/credits/ledger", async (c) => {
    await creditsActor(c);
    const after = parseCursor(c.req.query("cursor"));
    const page = await ledgerPage(c.env, actor(c).userId, after);
    return c.json({
      entries: page.entries,
      next: page.hasMore && page.lastRow ? cursor(page.lastRow as any) : null,
    });
  });

  app.post("/api/credits/daily", async (c) => {
    await creditsActor(c);
    await userRate(c, "daily", 10, 3600, "Too many claims; try again later");
    return c.json(
      unwrap(
        await coordinator(c.env).command(actor(c), "credits.claim_daily", {}),
      ),
    );
  });

  // Pre-flight for a quick-chat peek: what would be revealed and whether it is affordable. No charge.
  app.get("/api/rooms/:roomId/peek", async (c) => {
    const { cfg, a } = await creditsActor(c);
    const view = unwrap(
      await roomStub(c.env, uuid(c.req.param("roomId"))).peekTarget(a),
    );
    const wallet = await walletOf(c.env, a.userId);
    return c.json({
      price: cfg.credits_peek_price,
      purchased: view.purchased,
      revealsAsl: view.revealsAsl,
      revealsPicture: view.revealsPicture,
      balance: wallet.balance,
      affordable: wallet.balance >= cfg.credits_peek_price,
    });
  });

  app.post("/api/rooms/:roomId/peek", body(peekSchema), async (c) => {
    await creditsActor(c);
    await userRate(c, "peek", 30, 3600, "Too many peeks; try again later");
    return c.json(
      unwrap(
        await coordinator(c.env).command(actor(c), "credits.peek", {
          ...c.get("input"),
          roomId: uuid(c.req.param("roomId")),
        }),
      ),
    );
  });

  app.post(
    "/api/credits/contact-slots",
    body(slotPurchaseSchema),
    async (c) => {
      await creditsActor(c);
      await userRate(
        c,
        "slots",
        20,
        3600,
        "Too many purchases; try again later",
      );
      return c.json(
        unwrap(
          await coordinator(c.env).command(
            actor(c),
            "credits.buy_slots",
            c.get("input"),
          ),
        ),
      );
    },
  );

  app.post("/api/credits/orders", body(creditOrderSchema), async (c) => {
    const { a } = await creditsActor(c);
    await userRate(c, "orders", 10, 3600, "Too many orders; try again later");
    const provider = activeProvider(c.env);
    const pack = CREDIT_PACKS.find((p) => p.id === c.get("input").packId)!;
    // External checkout first, then the local order row; the reference ties the webhook back.
    const checkout = await provider.createCheckout(
      { userId: a.userId, pack },
      c.env,
    );
    const order = unwrap(
      await coordinator(c.env).command(a, "credits.order.create", {
        packId: pack.id,
        provider: provider.id,
        reference: checkout.reference,
      }),
    );
    return c.json({ orderId: order.id, url: checkout.url }, 201);
  });

  // Sandbox-only confirmation. It signs a webhook payload and runs the same
  // verification and settlement path as a real provider webhook.
  app.post(
    "/api/credits/sandbox/confirm",
    body(z.object({ reference: z.string().min(8).max(120) })),
    async (c) => {
      const { a, cfg } = await creditsActor(c);
      const provider = creditProvider(c.env, "sandbox");
      const reference = c.get("input").reference;
      const owner = await first(
        c.env,
        "SELECT user_id FROM credit_orders WHERE provider='sandbox' AND provider_reference=?",
        [reference],
      );
      requireThat(owner?.user_id === a.userId, 404, "Order unavailable");
      const payload = JSON.stringify({ reference, state: "PAID" });
      const signed = new Request(c.req.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [WEBHOOK_SIGNATURE_HEADER]: await signBody(
            c.env.CREDITS_WEBHOOK_SECRET!,
            payload,
          ),
        },
        body: payload,
      });
      const event = await provider.verifyWebhook(signed, c.env);
      unwrap(
        await coordinator(c.env).command(null, "credits.order.settle", {
          provider: provider.id,
          ...event,
        }),
      );
      return c.json(await summary(c, cfg));
    },
  );

  // Server-to-server settlement. Authentication is the provider signature only.
  app.post("/api/credits/webhook/:provider", async (c) => {
    const provider = creditProvider(c.env, c.req.param("provider"));
    const event = await provider.verifyWebhook(c.req.raw, c.env);
    unwrap(
      await coordinator(c.env).command(null, "credits.order.settle", {
        provider: provider.id,
        ...event,
      }),
    );
    return c.body(null, 204);
  });
}
