import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../celld/http/app";
import { iso, roomStub } from "../celld/shared/data";
import { unwrap } from "../celld/shared/errors";
import { creditProvider, signBody } from "../celld/features/credits/provider";
import {
  ACTIVITY_REWARDS_PER_DAY,
  dailyClaim,
} from "../celld/features/credits/wallet";
import { hash } from "../celld/shared/crypto";
import { defaultSettings } from "@charoo/contracts";
import {
  addApprovedPicture,
  fixture,
  matchableGuest,
  reachProfileMilestone,
  runJobs,
} from "./runtime";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Guest = Awaited<ReturnType<Fixture["guest"]>>;

const WEBHOOK_SECRET = "test-webhook-secret-not-a-real-credential";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function setSettings(f: Fixture, values: Record<string, unknown>) {
  await f.db
    .prepare("UPDATE settings SET value=json_patch(value,?) WHERE id=1")
    .bind(JSON.stringify(values))
    .run();
}
const enableCredits = (f: Fixture, extra: Record<string, unknown> = {}) =>
  setSettings(f, { credits_enabled: true, ...extra });

// Test seed for a balance. It writes a ledger row so reconciliation still holds.
async function seed(f: Fixture, userId: string, amount: number) {
  const at = iso();
  await f.db
    .prepare(
      "INSERT INTO credit_wallets(user_id,balance,lifetime_earned,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance=balance+excluded.balance,lifetime_earned=lifetime_earned+excluded.lifetime_earned,updated_at=excluded.updated_at",
    )
    .bind(userId, amount, amount, at)
    .run();
  await f.db
    .prepare(
      "INSERT INTO credit_entries(id,user_id,entry_key,kind,delta,balance_after,reference,created_at) VALUES(?,?,?,?,?,(SELECT balance FROM credit_wallets WHERE user_id=?),?,?)",
    )
    .bind(
      crypto.randomUUID(),
      userId,
      `seed:${crypto.randomUUID()}`,
      "ADMIN_ADJUST",
      amount,
      userId,
      "test-seed",
      at,
    )
    .run();
}
async function balance(f: Fixture, userId: string) {
  return Number(
    (
      await f.db
        .prepare("SELECT balance FROM credit_wallets WHERE user_id=?")
        .bind(userId)
        .first()
    )?.balance ?? 0,
  );
}
async function count(f: Fixture, sql: string, ...params: unknown[]) {
  return Number(
    (
      await f.db
        .prepare(sql)
        .bind(...params)
        .first()
    )?.n ?? 0,
  );
}
async function setProfile(
  f: Fixture,
  actor: Guest["actor"],
  visibility: string,
) {
  const row = await f.db
    .prepare("SELECT profile FROM users WHERE id=?")
    .bind(actor.userId)
    .first();
  await f.db
    .prepare("UPDATE users SET profile=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...JSON.parse(row.profile),
        age: 30,
        gender: "Woman",
        region: "Manila",
        aslVisibility: visibility,
      }),
      actor.userId,
    )
    .run();
}
async function http(
  f: Fixture,
  path: string,
  owner?: Guest,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(
    path.startsWith("/api/") ? path : `/api${path}`,
    {
      method,
      headers: {
        Origin: f.env.WEB_ORIGIN,
        "Content-Type": "application/json",
        ...(owner
          ? {
              Cookie: `charoo_session=${owner.token}`,
              "X-CSRF-Token": owner.csrf,
            }
          : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    f.env,
  );
}
async function quickChat(f: Fixture, a: Guest, b: Guest) {
  const matcher = f.matcher.getByName("charoo");
  unwrap(await matcher.match(a.actor));
  const match = unwrap(await matcher.match(b.actor));
  if (!("roomId" in match)) throw new Error("Expected a quick chat");
  return {
    roomId: match.roomId as string,
    room: roomStub(f.env, match.roomId),
  };
}

describe("pure credit rules", () => {
  const cfg = {
    credits_daily_base: 5,
    credits_daily_streak_bonus: 2,
    credits_daily_streak_max_days: 3,
  };
  it("claims once per UTC day and continues the streak only on the next day", () => {
    expect(
      dailyClaim({ lastDailyGrantOn: null, dailyStreak: 0 }, cfg, "2026-11-12"),
    ).toEqual({ claimable: true, streak: 1, amount: 5 });
    expect(
      dailyClaim(
        { lastDailyGrantOn: "2026-11-12", dailyStreak: 1 },
        cfg,
        "2026-11-12",
      ),
    ).toMatchObject({ claimable: false, amount: 0 });
    expect(
      dailyClaim(
        { lastDailyGrantOn: "2026-11-11", dailyStreak: 1 },
        cfg,
        "2026-11-12",
      ),
    ).toEqual({ claimable: true, streak: 2, amount: 7 });
    expect(
      dailyClaim(
        { lastDailyGrantOn: "2026-11-09", dailyStreak: 5 },
        cfg,
        "2026-11-12",
      ),
    ).toEqual({ claimable: true, streak: 1, amount: 5 });
  });
  it("stops the streak bonus at the configured maximum days", () => {
    expect(
      dailyClaim(
        { lastDailyGrantOn: "2026-11-13", dailyStreak: 3 },
        cfg,
        "2026-11-14",
      ).amount,
    ).toBe(9);
    expect(
      dailyClaim(
        { lastDailyGrantOn: "2026-11-15", dailyStreak: 9 },
        cfg,
        "2026-11-16",
      ).amount,
    ).toBe(9);
  });
  it("keeps the sandbox provider unavailable in production", () => {
    const env = {
      WEB_ORIGIN: "https://charoo.example",
      MESSAGE_KEY: "x",
      NODE_ENV: "production",
      CREDITS_SANDBOX: "true",
      CREDITS_WEBHOOK_SECRET: WEBHOOK_SECRET,
    } as any;
    expect(() => creditProvider(env, "sandbox")).toThrow();
    expect(() =>
      creditProvider({ ...env, NODE_ENV: "development" }, "sandbox"),
    ).not.toThrow();
    expect(() =>
      creditProvider(
        { ...env, NODE_ENV: "development", CREDITS_SANDBOX: undefined },
        "sandbox",
      ),
    ).toThrow();
  });
});

describe("credit grants and daily claims", () => {
  it("grants the verify bonus exactly once across repeated verification and sign-in", async () => {
    const f = await fixture();
    await enableCredits(f);
    const g = await f.guest();
    const email = unwrap(
      await f.app.command(g.actor, "email", {
        email: "bonus@example.com",
        communityConsent: true,
      }),
    );
    // Verification rotates the session, so continue with the new one.
    const session = unwrap(
      await f.app.command(g.actor, "verify", { token: email.token }),
    );
    const signedIn = {
      userId: g.actor.userId,
      sessionHash: await hash(session.token),
    };
    expect(await balance(f, g.actor.userId)).toBe(
      defaultSettings.credits_verify_bonus,
    );
    // Re-verifying the same account with a fresh credential must not grant again.
    const again = unwrap(
      await f.app.command(signedIn, "email", {
        email: "bonus@example.com",
        communityConsent: true,
      }),
    );
    unwrap(await f.app.command(signedIn, "verify", { token: again.token }));
    expect(await balance(f, g.actor.userId)).toBe(
      defaultSettings.credits_verify_bonus,
    );
    expect(
      await count(
        f,
        "SELECT count(*) AS n FROM credit_entries WHERE user_id=? AND kind='GRANT_VERIFY'",
        g.actor.userId,
      ),
    ).toBe(1);
  });

  it("grants no verify bonus while credits are disabled", async () => {
    const f = await fixture();
    const g = await f.guest();
    const email = unwrap(
      await f.app.command(g.actor, "email", {
        email: "dark@example.com",
        communityConsent: true,
      }),
    );
    unwrap(await f.app.command(g.actor, "verify", { token: email.token }));
    expect(await count(f, "SELECT count(*) AS n FROM credit_wallets")).toBe(0);
  });

  it("claims the daily grant once per UTC day and tracks the streak", async () => {
    const f = await fixture();
    await enableCredits(f, { credits_daily_streak_max_days: 3 });
    const a = await matchableGuest(f, true);
    const claim = () => f.app.command(a.actor, "credits.claim_daily", {});
    expect(unwrap(await claim())).toMatchObject({
      claimed: true,
      amount: 5,
      streak: 1,
      balance: 5,
    });
    expect(unwrap(await claim())).toMatchObject({ claimed: false, balance: 5 });
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
    expect(unwrap(await claim())).toMatchObject({
      claimed: true,
      amount: 7,
      streak: 2,
      balance: 12,
    });
    vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
    expect(unwrap(await claim())).toMatchObject({
      claimed: true,
      amount: 9,
      streak: 3,
      balance: 21,
    });
    vi.setSystemTime(new Date("2026-11-15T10:00:00Z"));
    expect(unwrap(await claim())).toMatchObject({
      claimed: true,
      amount: 9,
      streak: 4,
      balance: 30,
    });
    vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
    expect(unwrap(await claim())).toMatchObject({
      claimed: true,
      amount: 5,
      streak: 1,
      balance: 35,
    });
  });

  it("refuses credit actions to guests and every credit route when the flag is off", async () => {
    const f = await fixture();
    const guest = await f.guest();
    const verified = await matchableGuest(f, true);
    await enableCredits(f);
    expect((await http(f, "/credits", guest)).status).toBe(403);
    expect(
      (await http(f, "/credits/daily", guest, "POST", {}, {})).status,
    ).toBe(403);
    await setSettings(f, { credits_enabled: false });
    for (const [path, method, body] of [
      ["/credits", "GET", undefined],
      ["/credits/ledger", "GET", undefined],
      ["/credits/daily", "POST", {}],
      [
        "/credits/contact-slots",
        "POST",
        { clientOperationId: crypto.randomUUID() },
      ],
      ["/credits/orders", "POST", { packId: "pack-100" }],
      ["/rooms/" + crypto.randomUUID() + "/peek", "GET", undefined],
      [
        "/rooms/" + crypto.randomUUID() + "/peek",
        "POST",
        { revealsAsl: true, revealsPicture: false },
      ],
    ] as const) {
      const response = await http(f, path, verified, method, body);
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it("settles the activity reward once per participant when the profile milestone is reached", async () => {
    const f = await fixture();
    await enableCredits(f);
    const a = await matchableGuest(f, true),
      b = await matchableGuest(f, true);
    const chat = await quickChat(f, a, b);
    await reachProfileMilestone(chat.room, a, b);
    await runJobs(f);
    expect(
      await count(
        f,
        "SELECT count(*) AS n FROM credit_entries WHERE kind='GRANT_ACTIVITY'",
      ),
    ).toBe(2);
    expect(await balance(f, a.actor.userId)).toBe(
      defaultSettings.credits_activity_milestone_reward,
    );
    // More messages do not repay the milestone, and a redelivered grant is a no-op.
    await reachProfileMilestone(chat.room, a, b, 2);
    await runJobs(f);
    await chat.room.command(a.actor, "message", {
      text: "one more message",
      clientMessageId: crypto.randomUUID(),
    });
    await runJobs(f);
    for (const actor of [a, b])
      expect(
        await f.app.command(null, "credits.grant", {
          reward: "activity",
          userId: actor.actor.userId,
          entryKey: `activity:milestone:${chat.roomId}:${actor.actor.userId}`,
          reference: chat.roomId,
        }),
      ).toMatchObject({ ok: true });
    expect(
      await count(
        f,
        "SELECT count(*) AS n FROM credit_entries WHERE kind='GRANT_ACTIVITY'",
      ),
    ).toBe(2);
    expect(await balance(f, a.actor.userId)).toBe(
      defaultSettings.credits_activity_milestone_reward,
    );
  });

  it("caps activity rewards per user per UTC day", async () => {
    const f = await fixture();
    await enableCredits(f);
    const a = await matchableGuest(f, true);
    const reward = defaultSettings.credits_activity_milestone_reward;
    const grant = (n: number) =>
      f.app.command(null, "credits.grant", {
        reward: "activity",
        userId: a.actor.userId,
        entryKey: `activity:milestone:room-${n}:${a.actor.userId}`,
        reference: `room-${n}`,
      });
    for (let n = 0; n < ACTIVITY_REWARDS_PER_DAY + 3; n++)
      expect(await grant(n)).toMatchObject({ ok: true });
    expect(await balance(f, a.actor.userId)).toBe(
      reward * ACTIVITY_REWARDS_PER_DAY,
    );
    // The next UTC day starts a fresh allowance.
    vi.setSystemTime(new Date("2026-11-13T00:00:01Z"));
    expect(await grant(99)).toMatchObject({ ok: true });
    expect(await balance(f, a.actor.userId)).toBe(
      reward * (ACTIVITY_REWARDS_PER_DAY + 1),
    );
  });

  it("pays no activity reward to guests, who have no wallet", async () => {
    const f = await fixture();
    await enableCredits(f);
    const a = await matchableGuest(f),
      b = await matchableGuest(f);
    const chat = await quickChat(f, a, b);
    await reachProfileMilestone(chat.room, a, b);
    await runJobs(f);
    expect(await count(f, "SELECT count(*) AS n FROM credit_wallets")).toBe(0);
  });
});

describe("credit route boundaries", () => {
  it("requires the CSRF token on credit writes and validates pack and slot input", async () => {
    const f = await fixture();
    await enableCredits(f);
    const verified = await matchableGuest(f, true);
    expect(
      (
        await http(
          f,
          "/credits/daily",
          verified,
          "POST",
          {},
          { "X-CSRF-Token": "" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await http(f, "/credits/orders", verified, "POST", {
          packId: "pack-999",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await http(f, "/credits/contact-slots", verified, "POST", {
          clientOperationId: "not-a-uuid",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await http(f, `/rooms/not-a-uuid/peek`, verified, "POST", {
          revealsAsl: true,
          revealsPicture: false,
        })
      ).status,
    ).toBe(400);
    // Reads need no CSRF token but still require a session.
    expect((await http(f, "/credits")).status).toBe(401);
  });
});

describe("quick-chat peek", () => {
  it("debits once, reveals ASL and picture only to the buyer, and never widens the subject's view", async () => {
    const f = await fixture();
    await enableCredits(f);
    const a = await matchableGuest(f, true),
      b = await matchableGuest(f, true);
    await setProfile(f, b.actor, "public");
    await addApprovedPicture(f, a, 2);
    await addApprovedPicture(f, b, 5);
    const chat = await quickChat(f, a, b);
    await seed(f, a.actor.userId, 30);

    const preflight = await http(f, `/rooms/${chat.roomId}/peek`, a);
    expect(await preflight.json()).toMatchObject({
      price: defaultSettings.credits_peek_price,
      purchased: false,
      revealsAsl: true,
      revealsPicture: true,
      affordable: true,
    });
    const buy = { revealsAsl: true, revealsPicture: true };
    expect(
      unwrap(
        await f.app.command(a.actor, "credits.peek", {
          roomId: chat.roomId,
          ...buy,
        }),
      ),
    ).toMatchObject({ purchased: true, charged: 10, balance: 20 });
    expect(
      unwrap(
        await f.app.command(a.actor, "credits.peek", {
          roomId: chat.roomId,
          ...buy,
        }),
      ),
    ).toMatchObject({ purchased: true, charged: 0 });
    expect(await balance(f, a.actor.userId)).toBe(20);
    expect(await count(f, "SELECT count(*) AS n FROM profile_peeks")).toBe(1);

    const buyerView = unwrap(await chat.room.command(a.actor, "snapshot"));
    expect(
      buyerView.participants.find((p: any) => p.id === b.actor.userId).asl,
    ).not.toBeNull();
    expect(buyerView.pictureReveal.participants.map((p: any) => p.id)).toEqual([
      b.actor.userId,
    ]);
    expect(buyerView.peek).toMatchObject({ purchased: true, available: false });

    // The subject sees nothing new: no ASL on the buyer, no buyer picture.
    const subjectView = unwrap(await chat.room.command(b.actor, "snapshot"));
    expect(
      subjectView.participants.find((p: any) => p.id === a.actor.userId).asl,
    ).toBeNull();
    expect(subjectView.pictureReveal.participants).toEqual([]);
    expect(subjectView.asl_revealed).toBe(false);
    expect(
      (
        await chat.room.command(b.actor, "picture.download", {
          userId: a.actor.userId,
        })
      ).ok,
    ).toBe(false);
    // The buyer can read the subject's picture; the reverse is refused.
    expect(
      (
        await chat.room.command(a.actor, "picture.download", {
          userId: b.actor.userId,
        })
      ).ok,
    ).toBe(true);
    const ledger = await f.db
      .prepare(
        "SELECT kind,delta,entry_key FROM credit_entries WHERE kind='SPEND_PEEK'",
      )
      .all();
    expect(ledger.results).toEqual([
      {
        kind: "SPEND_PEEK",
        delta: -10,
        entry_key: `peek:${chat.roomId}:${a.actor.userId}`,
      },
    ]);
  });

  it("tells the client exactly what will be revealed and refuses a charge when that changed", async () => {
    const f = await fixture();
    await enableCredits(f);
    const a = await matchableGuest(f, true),
      b = await matchableGuest(f, true);
    await setProfile(f, b.actor, "private");
    await addApprovedPicture(f, b, 5);
    const chat = await quickChat(f, a, b);
    await seed(f, a.actor.userId, 30);
    expect(
      await (await http(f, `/rooms/${chat.roomId}/peek`, a)).json(),
    ).toMatchObject({
      revealsAsl: false,
      revealsPicture: true,
    });
    expect(
      await f.app.command(a.actor, "credits.peek", {
        roomId: chat.roomId,
        revealsAsl: true,
        revealsPicture: true,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(await balance(f, a.actor.userId)).toBe(30);
    unwrap(
      await f.app.command(a.actor, "credits.peek", {
        roomId: chat.roomId,
        revealsAsl: false,
        revealsPicture: true,
      }),
    );
    expect(await balance(f, a.actor.userId)).toBe(20);
  });

  it("refuses a peek when nothing new would be revealed", async () => {
    const f = await fixture();
    await enableCredits(f);
    const a = await matchableGuest(f, true),
      b = await matchableGuest(f, true);
    await setProfile(f, b.actor, "public");
    const chat = await quickChat(f, a, b);
    await seed(f, a.actor.userId, 30);
    await reachProfileMilestone(chat.room, a, b);
    await addApprovedPicture(f, b, 5);
    // Both milestones are reached: ASL shown only at ten words, profile at ten messages.
    expect(
      await f.app.command(a.actor, "credits.peek", {
        roomId: chat.roomId,
        revealsAsl: false,
        revealsPicture: false,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(await balance(f, a.actor.userId)).toBe(30);
  });

  it("leaves balance and peek records untouched when funds are insufficient", async () => {
    const f = await fixture();
    await enableCredits(f);
    const a = await matchableGuest(f, true),
      b = await matchableGuest(f, true);
    await setProfile(f, b.actor, "public");
    const chat = await quickChat(f, a, b);
    await seed(f, a.actor.userId, 4);
    // matchableGuest attaches an approved picture, so both halves are revealed.
    expect(
      await f.app.command(a.actor, "credits.peek", {
        roomId: chat.roomId,
        revealsAsl: true,
        revealsPicture: true,
      }),
    ).toMatchObject({ ok: false, status: 402 });
    expect(await balance(f, a.actor.userId)).toBe(4);
    expect(await count(f, "SELECT count(*) AS n FROM profile_peeks")).toBe(0);
  });
});

describe("contact storage", () => {
  it("enforces the free slots on request and accept, and buys idempotent capped slots", async () => {
    const f = await fixture();
    await enableCredits(f, {
      credits_contact_slot_base: 1,
      credits_contact_slot_pack: 2,
      credits_contact_slot_price: 4,
      credits_contact_slot_max: 3,
    });
    const a = await matchableGuest(f, true),
      b = await matchableGuest(f, true),
      stranger = await matchableGuest(f, true);
    // A already has one saved contact, the whole free allowance.
    await f.db
      .prepare("INSERT INTO contacts(user_a,user_b,room_id) VALUES(?,?,?)")
      .bind(
        [a.actor.userId, stranger.actor.userId].sort()[0],
        [a.actor.userId, stranger.actor.userId].sort()[1],
        crypto.randomUUID(),
      )
      .run();
    const chat = await quickChat(f, a, b);
    await reachProfileMilestone(chat.room, a, b);

    expect(
      await f.app.command(a.actor, "social.create", {
        kind: "CONTACT",
        targetId: b.actor.userId,
        roomId: chat.roomId,
      }),
    ).toMatchObject({
      ok: false,
      status: 409,
      message: "Contact storage full. Free a slot or buy more.",
    });

    // B asks A instead; A has no room for it, so accepting is refused.
    const request = unwrap(
      await f.app.command(b.actor, "social.create", {
        kind: "CONTACT",
        targetId: a.actor.userId,
        roomId: chat.roomId,
      }),
    );
    expect(
      await f.app.command(a.actor, "social.respond", {
        id: request.id,
        accept: true,
      }),
    ).toMatchObject({ ok: false, status: 409 });

    await seed(f, a.actor.userId, 10);
    const opId = crypto.randomUUID();
    expect(
      unwrap(
        await f.app.command(a.actor, "credits.buy_slots", {
          clientOperationId: opId,
        }),
      ),
    ).toMatchObject({ purchased: true, extraContactSlots: 2, balance: 6 });
    // Replaying the same operation charges nothing more.
    expect(
      unwrap(
        await f.app.command(a.actor, "credits.buy_slots", {
          clientOperationId: opId,
        }),
      ),
    ).toMatchObject({ purchased: false, balance: 6 });
    expect(await balance(f, a.actor.userId)).toBe(6);
    // A second pack would exceed the maximum of three and is refused without a charge.
    expect(
      await f.app.command(a.actor, "credits.buy_slots", {
        clientOperationId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(await balance(f, a.actor.userId)).toBe(6);

    // With the purchased slots, the same accept now succeeds.
    expect(
      unwrap(
        await f.app.command(a.actor, "social.respond", {
          id: request.id,
          accept: true,
        }),
      ),
    ).toMatchObject({ accepted: true });
  });
});

describe("reconnect charge", () => {
  async function archive(f: Fixture, requester: Guest, peer: Guest) {
    const roomId = crypto.randomUUID();
    await f.db
      .prepare(
        "INSERT INTO quick_chat_archives(user_id,peer_id,room_id,last_chatted_at,archived_at,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        requester.actor.userId,
        peer.actor.userId,
        roomId,
        iso(),
        iso(),
        iso(Date.now() + 86400000),
      )
      .run();
    return roomId;
  }

  it("refuses a broke requester up front and debits the requester on acceptance", async () => {
    const f = await fixture();
    await enableCredits(f, { reconnect_price: 3 });
    const requester = await matchableGuest(f, true),
      peer = await matchableGuest(f, true);
    const roomId = await archive(f, requester, peer);
    expect(
      await f.app.command(requester.actor, "social.create", {
        kind: "RECONNECT",
        targetId: peer.actor.userId,
        roomId,
      }),
    ).toMatchObject({
      ok: false,
      status: 403,
      message: "Not enough credits to reconnect",
    });

    await seed(f, requester.actor.userId, 5);
    const request = unwrap(
      await f.app.command(requester.actor, "social.create", {
        kind: "RECONNECT",
        targetId: peer.actor.userId,
        roomId,
      }),
    );
    // Requesting is free; only acceptance charges.
    expect(await balance(f, requester.actor.userId)).toBe(5);
    const accepted = unwrap(
      await f.app.command(peer.actor, "social.respond", {
        id: request.id,
        accept: true,
      }),
    );
    expect(accepted.roomId).toBeTruthy();
    expect(await balance(f, requester.actor.userId)).toBe(2);
    expect(
      await f.db
        .prepare("SELECT kind,delta FROM credit_entries WHERE entry_key=?")
        .bind(`reconnect:${request.id}`)
        .first(),
    ).toEqual({ kind: "SPEND_RECONNECT", delta: -3 });
  });

  it("reports whether each reconnect requester can afford the price", async () => {
    const f = await fixture();
    await enableCredits(f, { reconnect_price: 3 });
    const rich = await matchableGuest(f, true),
      broke = await matchableGuest(f, true),
      peer = await matchableGuest(f, true);
    for (const requester of [rich, broke]) {
      const roomId = await archive(f, requester, peer);
      await seed(f, requester.actor.userId, 3);
      unwrap(
        await f.app.command(requester.actor, "social.create", {
          kind: "RECONNECT",
          targetId: peer.actor.userId,
          roomId,
        }),
      );
    }
    // The second requester spends their credits before the peer looks.
    await f.db
      .prepare("UPDATE credit_wallets SET balance=0 WHERE user_id=?")
      .bind(broke.actor.userId)
      .run();
    const list = (await (await http(f, "/requests", peer)).json()) as any[];
    const flag = (id: string) =>
      list.find((r) => r.requester_id === id)?.requester_can_afford;
    expect(flag(rich.actor.userId)).toBe(true);
    expect(flag(broke.actor.userId)).toBe(false);
    expect(list.every((r) => r.reconnect_price === 3)).toBe(true);
  });

  it("creates no room and leaves no partial state when acceptance finds insufficient funds", async () => {
    const f = await fixture();
    await enableCredits(f, { reconnect_price: 3 });
    const requester = await matchableGuest(f, true),
      peer = await matchableGuest(f, true);
    const roomId = await archive(f, requester, peer);
    await seed(f, requester.actor.userId, 3);
    const request = unwrap(
      await f.app.command(requester.actor, "social.create", {
        kind: "RECONNECT",
        targetId: peer.actor.userId,
        roomId,
      }),
    );
    // The requester spends their credits elsewhere before the peer answers.
    await f.db
      .prepare("UPDATE credit_wallets SET balance=0 WHERE user_id=?")
      .bind(requester.actor.userId)
      .run();
    const outcome = await f.app.command(peer.actor, "social.respond", {
      id: request.id,
      accept: true,
    });
    expect(outcome).toMatchObject({ ok: false, status: 409 });
    expect(outcome.ok ? "" : outcome.message).toContain(
      "no longer has enough credits",
    );
    expect(
      await f.db
        .prepare("SELECT state,result_room_id FROM social_requests WHERE id=?")
        .bind(request.id)
        .first(),
    ).toEqual({ state: "EXPIRED", result_room_id: null });
    expect(
      await count(
        f,
        "SELECT count(*) AS n FROM operations WHERE id=?",
        `request:${request.id}`,
      ),
    ).toBe(0);
    expect(
      await count(
        f,
        "SELECT count(*) AS n FROM credit_entries WHERE entry_key=?",
        `reconnect:${request.id}`,
      ),
    ).toBe(0);
  });
});

describe("payments seam", () => {
  it("settles a sandbox order once across duplicate webhooks, rejects bad signatures, and refuses production", async () => {
    const f = await fixture();
    await enableCredits(f);
    Object.assign(f.env, {
      CREDITS_SANDBOX: "true",
      CREDITS_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    const buyer = await matchableGuest(f, true);
    const order = await http(f, "/credits/orders", buyer, "POST", {
      packId: "pack-100",
    });
    expect(order.status).toBe(201);
    const { orderId, url } = (await order.json()) as {
      orderId: string;
      url: string;
    };
    const reference = url.split("credits-checkout=")[1];
    expect(
      await f.db
        .prepare(
          "SELECT provider_reference,state FROM credit_orders WHERE id=?",
        )
        .bind(orderId)
        .first(),
    ).toEqual({ provider_reference: reference, state: "PENDING" });

    const payload = JSON.stringify({ reference, state: "PAID" });
    // Server-to-server: no session or origin; the provider signature is the only credential.
    const webhook = (body: string, signature: string) =>
      app.request(
        "/api/credits/webhook/sandbox",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Charoo-Credits-Signature": signature,
          },
          body,
        },
        f.env,
      );
    expect((await webhook(payload, "sha256=" + "0".repeat(64))).status).toBe(
      401,
    );
    expect(await balance(f, buyer.actor.userId)).toBe(0);
    const good = await signBody(WEBHOOK_SECRET, payload);
    expect((await webhook(payload, good)).status).toBe(204);
    expect((await webhook(payload, good)).status).toBe(204);
    expect(await balance(f, buyer.actor.userId)).toBe(100);
    expect(
      await count(
        f,
        "SELECT count(*) AS n FROM credit_entries WHERE kind='TOPUP'",
      ),
    ).toBe(1);
    // A late failure notice cannot undo a payment that already settled.
    const failed = JSON.stringify({ reference, state: "FAILED" });
    expect(
      (await webhook(failed, await signBody(WEBHOOK_SECRET, failed))).status,
    ).toBe(204);
    expect(
      (
        await f.db
          .prepare("SELECT state FROM credit_orders WHERE id=?")
          .bind(orderId)
          .first()
      ).state,
    ).toBe("PAID");

    // The sandbox adapter refuses to exist in production, even with the flag set.
    f.env.NODE_ENV = "production";
    const production = await http(f, "/credits/orders", buyer, "POST", {
      packId: "pack-100",
    });
    expect(production.status).toBe(503);
    f.env.NODE_ENV = "development";
  });

  it("credits a PAID webhook that arrives after the order expired or failed, exactly once", async () => {
    const f = await fixture();
    await enableCredits(f);
    Object.assign(f.env, {
      CREDITS_SANDBOX: "true",
      CREDITS_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    const buyer = await matchableGuest(f, true);
    const reference = async () => {
      const res = await http(f, "/credits/orders", buyer, "POST", {
        packId: "pack-100",
      });
      return ((await res.json()) as { url: string }).url.split(
        "credits-checkout=",
      )[1];
    };
    const settle = (ref: string, state: "PAID" | "FAILED") =>
      f.app.command(null, "credits.order.settle", {
        provider: "sandbox",
        reference: ref,
        state,
      });
    const expired = await reference();
    await f.db
      .prepare(
        "UPDATE credit_orders SET state='EXPIRED' WHERE provider_reference=?",
      )
      .bind(expired)
      .run();
    // A late failure notice leaves an expired order alone.
    await settle(expired, "FAILED");
    expect(await balance(f, buyer.actor.userId)).toBe(0);
    await settle(expired, "PAID");
    await settle(expired, "PAID");
    expect(await balance(f, buyer.actor.userId)).toBe(100);

    const failed = await reference();
    await settle(failed, "FAILED");
    await settle(failed, "PAID");
    expect(await balance(f, buyer.actor.userId)).toBe(200);
    expect(
      await count(
        f,
        "SELECT count(*) AS n FROM credit_orders WHERE state='PAID'",
      ),
    ).toBe(2);
    expect(
      await count(
        f,
        "SELECT count(*) AS n FROM credit_entries WHERE kind='TOPUP'",
      ),
    ).toBe(2);
  });

  it("keeps the ledger reconciled with the wallet after a mixed grant and spend sequence", async () => {
    const f = await fixture();
    await enableCredits(f, {
      credits_contact_slot_price: 4,
      credits_contact_slot_pack: 1,
    });
    const a = await matchableGuest(f, true);
    await seed(f, a.actor.userId, 25);
    unwrap(await f.app.command(a.actor, "credits.claim_daily", {}));
    unwrap(
      await f.app.command(a.actor, "credits.buy_slots", {
        clientOperationId: crypto.randomUUID(),
      }),
    );
    unwrap(
      await f.app.command(a.actor, "credits.buy_slots", {
        clientOperationId: crypto.randomUUID(),
      }),
    );
    const rows = (
      await f.db
        .prepare(
          "SELECT delta,balance_after FROM credit_entries WHERE user_id=? ORDER BY rowid",
        )
        .bind(a.actor.userId)
        .all()
    ).results as { delta: number; balance_after: number }[];
    let running = 0;
    for (const row of rows) {
      running += row.delta;
      expect(row.balance_after).toBe(running);
    }
    expect(running).toBe(await balance(f, a.actor.userId));
    expect(running).toBe(25 + 5 - 8);
  });

  it("makes the credit ledger append-only", async () => {
    const f = await fixture();
    const a = await matchableGuest(f, true);
    await seed(f, a.actor.userId, 5);
    await expect(
      f.db.prepare("UPDATE credit_entries SET delta=0").run(),
    ).rejects.toThrow();
    await expect(
      f.db.prepare("DELETE FROM credit_entries").run(),
    ).rejects.toThrow();
  });
});
