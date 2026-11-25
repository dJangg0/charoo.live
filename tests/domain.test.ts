import { describe, expect, it, vi } from "vitest";
import { fixture, matchableGuest, reachProfileMilestone } from "./runtime";
import { unwrap } from "../celld/shared/errors";
import { roomStub, iso } from "../celld/shared/data";
import { hash } from "../celld/shared/crypto";
import { QUICK_CHAT_SEARCH_TIMEOUT_MS } from "@charoo/contracts";

async function setGender(
  f: { db: any },
  actor: { userId: string },
  gender: string,
) {
  const row = await f.db
    .prepare("SELECT profile FROM users WHERE id=?")
    .bind(actor.userId)
    .first();
  await f.db
    .prepare("UPDATE users SET profile=? WHERE id=?")
    .bind(JSON.stringify({ ...JSON.parse(row.profile), gender }), actor.userId)
    .run();
}

describe("Durable authorities and coordination", () => {
  it("keeps invitation navigation on email credentials and allows a valid credential to upgrade an expired guest", async () => {
    const f = await fixture(),
      a = await matchableGuest(f);
    const invitation = "a".repeat(43);
    const email = unwrap(
      await f.app.command(a.actor, "email", {
        email: "invite@example.com",
        communityConsent: true,
        roomToken: invitation,
      }),
    );
    expect(email.roomToken).toBe(invitation);
    expect(
      (await f.db.prepare("SELECT room_token FROM email_tokens").first())
        .room_token,
    ).toBe(invitation);
    await f.db
      .prepare("UPDATE users SET guest_expires_at=? WHERE id=?")
      .bind(iso(Date.now() - 1), a.actor.userId)
      .run();
    expect(
      await roomStub(f.env, crypto.randomUUID()).authorize(a.actor),
    ).toMatchObject({ ok: false });
    const verified = unwrap(
      await f.app.command(a.actor, "verify", { token: email.token }),
    );
    expect(verified.user).toMatchObject({ id: a.actor.userId, verified: true });
    expect(
      await f.app.command(null, "verify", { token: email.token }),
    ).toMatchObject({ ok: false });
  });
  it("upgrades guests through one-use email links and rotates sessions", async () => {
    const f = await fixture(),
      a = await matchableGuest(f);
    const email = unwrap(
      await f.app.command(a.actor, "email", {
        communityConsent: true,
        email: "a@example.com",
      }),
    );
    const result = unwrap(
      await f.app.command(a.actor, "verify", { token: email.token }),
    );
    expect(result.user.id).toBe(a.actor.userId);
    expect(result.user.verified).toBe(true);
    expect(
      (
        await f.db
          .prepare("SELECT * FROM sessions WHERE token_hash=?")
          .bind(a.actor.sessionHash)
          .all()
      ).results,
    ).toHaveLength(0);
    expect(
      (await f.app.command(null, "verify", { token: email.token })).ok,
    ).toBe(false);
  });
  it("serializes concurrent Google account linking to one identity", async () => {
    const f = await fixture(),
      identity = {
        subject: "google-subject",
        email: "a@gmail.com",
        name: "Friend",
        emailAuthoritative: true,
      };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        f.app.command(null, "oauth.finish", { identity, sessionHash: null }),
      ),
    );
    expect(new Set(results.map((r) => unwrap(r).user.id)).size).toBe(1);
    expect(
      (await f.db.prepare("SELECT * FROM oauth_identities").all()).results,
    ).toHaveLength(1);
  });
  it("requires mailbox verification for external Google addresses and rejects identity conflicts", async () => {
    const f = await fixture(),
      a = await matchableGuest(f, true),
      identity = {
        subject: "external",
        email: "person@external.test",
        name: "Friend",
        emailAuthoritative: false,
      };
    const denied = await f.app.command(null, "oauth.finish", {
      identity,
      sessionHash: null,
    });
    expect(denied).toMatchObject({ ok: false, message: "email_required" });
    expect(
      await f.app.command(a.actor, "oauth.finish", {
        identity,
        sessionHash: a.actor.sessionHash,
      }),
    ).toMatchObject({ ok: false, message: "account_conflict" });
  });
  it("consumes browser-bound OAuth flows atomically and preserves invitation navigation", async () => {
    const f = await fixture(),
      input = {
        stateHash: "state",
        browserHash: "browser",
        nonce: "nonce",
        codeVerifier: "verifier",
        roomToken: "a".repeat(43),
        createRoom: true,
      };
    unwrap(await f.app.command(null, "oauth.start", input));
    expect(
      await f.app.command(null, "oauth.consume", {
        stateHash: "state",
        browserHash: "wrong",
      }),
    ).toMatchObject({ ok: false });
    const consumed = await Promise.all([
      f.app.command(null, "oauth.consume", input),
      f.app.command(null, "oauth.consume", input),
    ]);
    expect(consumed.filter((r) => r.ok)).toHaveLength(1);
    expect(unwrap(consumed.find((r) => r.ok)!)).toMatchObject({
      room_token: input.roomToken,
      create_room: 1,
    });
  });
  it("persists invitations, membership and encrypted history across restarts", async () => {
    const f = await fixture(),
      a = await matchableGuest(f),
      b = await matchableGuest(f),
      created = unwrap(
        await f.app.command(a.actor, "room.create", {
          type: "SHARED_GROUP",
          title: "Test group",
        }),
      );
    const room = roomStub(f.env, created.id),
      token = new URL(created.shareUrl).hash.slice(6);
    const pending = unwrap(
      await room.command(b.actor, "join", { tokenHash: await hash(token) }),
    );
    expect(pending.pending).toBe(true);
    const requests = unwrap(await room.command(a.actor, "join_requests", {}));
    unwrap(
      await room.command(a.actor, "join_respond", {
        requestId: requests[0].id,
        accept: true,
      }),
    );
    unwrap(
      await room.command(a.actor, "message", {
        text: "Private hello",
        clientMessageId: crypto.randomUUID(),
      }),
    );
    const state = f.rooms.states.get(`charoo:${created.id}`)!;
    expect(
      state.database.prepare("SELECT ciphertext FROM charoo_messages").get()!
        .ciphertext,
    ).not.toContain("Private hello");
    const restarted = f.rooms.restart(`charoo:${created.id}`);
    expect(
      unwrap(await restarted.command(b.actor, "messages")).messages[0].text,
    ).toBe("Private hello");
    expect(unwrap(await restarted.command(a.actor, "invite")).shareUrl).toBe(
      created.shareUrl,
    );
  });
  it("deduplicates concurrent message submissions before slow mode", async () => {
    const f = await fixture(),
      a = await matchableGuest(f),
      created = unwrap(
        await f.app.command(a.actor, "room.create", {
          type: "SHARED_GROUP",
          title: "Test group",
        }),
      ),
      room = roomStub(f.env, created.id);
    const payload = {
        text: "One message only",
        clientMessageId: crypto.randomUUID(),
      },
      results = await Promise.all(
        Array.from({ length: 8 }, () =>
          room.command(a.actor, "message", payload),
        ),
      );
    expect(new Set(results.map((r) => unwrap(r).id)).size).toBe(1);
    expect(
      unwrap(await room.command(a.actor, "messages")).messages,
    ).toHaveLength(1);
  });
  it("enforces host moderation for history, writes, rejoining and invites", async () => {
    const f = await fixture(),
      a = await matchableGuest(f),
      b = await matchableGuest(f),
      created = unwrap(
        await f.app.command(a.actor, "room.create", {
          type: "SHARED_GROUP",
          title: "Test group",
        }),
      ),
      room = roomStub(f.env, created.id),
      tokenHash = await hash(new URL(created.shareUrl).hash.slice(6));
    const joinResult = unwrap(
      await room.command(b.actor, "join", { tokenHash }),
    );
    expect(joinResult.pending).toBe(true);
    // Requester sees pending, host sees the queue.
    expect(
      unwrap(await room.command(b.actor, "join_status", {})),
    ).toMatchObject({
      status: "PENDING",
    });
    const queue = unwrap(await room.command(a.actor, "join_requests", {}));
    expect(queue).toHaveLength(1);
    unwrap(
      await room.command(a.actor, "join_respond", {
        requestId: queue[0].id,
        accept: true,
      }),
    );
    expect(
      unwrap(await room.command(b.actor, "join_status", {})),
    ).toMatchObject({ status: "APPROVED" });
    expect(await room.command(b.actor, "invite")).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      await room.command(b.actor, "moderate", { action: "CLOSE" }),
    ).toMatchObject({ ok: false, status: 403 });
    unwrap(
      await room.command(a.actor, "moderate", {
        action: "MUTE",
        targetId: b.actor.userId,
      }),
    );
    expect(
      await room.command(b.actor, "message", {
        text: "Muted",
        clientMessageId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: false, status: 403 });
    const muted = unwrap(await room.command(b.actor, "snapshot"));
    expect(Date.parse(muted.mutedUntil)).toBeGreaterThan(Date.now());
    expect(
      muted.participants.find((p: any) => p.id === b.actor.userId).mutedUntil,
    ).toBe(muted.mutedUntil);
    expect(
      await room.command(b.actor, "moderate", {
        action: "UNMUTE",
        targetId: b.actor.userId,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    unwrap(
      await room.command(a.actor, "moderate", {
        action: "UNMUTE",
        targetId: b.actor.userId,
      }),
    );
    expect(
      unwrap(await room.command(b.actor, "snapshot")).mutedUntil,
    ).toBeNull();
    expect(
      await room.command(b.actor, "message", {
        text: "Unmuted",
        clientMessageId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await room.command(a.actor, "moderate", {
        action: "REMOVE",
        targetId: b.actor.userId,
      }),
    ).toMatchObject({ ok: false, status: 400 });
    unwrap(
      await room.command(a.actor, "moderate", {
        action: "REMOVE",
        targetId: b.actor.userId,
        reason: "Spamming the room",
      }),
    );
    expect(
      unwrap(await room.command(b.actor, "join_status", {})),
    ).toMatchObject({
      status: "REMOVED",
    });
    expect(await room.command(b.actor, "messages")).toMatchObject({
      ok: false,
    });
    expect(await room.command(b.actor, "join", { tokenHash })).toMatchObject({
      ok: false,
      status: 403,
    });
  });
  it("queues link joins for host approval, reject and cancel", async () => {
    const f = await fixture(),
      a = await matchableGuest(f),
      b = await matchableGuest(f),
      c = await matchableGuest(f),
      created = unwrap(
        await f.app.command(a.actor, "room.create", {
          type: "SHARED_GROUP",
          title: "Approval room",
        }),
      ),
      room = roomStub(f.env, created.id),
      tokenHash = await hash(new URL(created.shareUrl).hash.slice(6));
    const first = unwrap(await room.command(b.actor, "join", { tokenHash }));
    expect(first.pending).toBe(true);
    // Duplicate knocks return the same pending request.
    const again = unwrap(await room.command(b.actor, "join", { tokenHash }));
    expect(again.requestId).toBe(first.requestId);
    const queue = unwrap(await room.command(a.actor, "join_requests", {}));
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ status: "PENDING" });
    // Non-members cannot review the queue.
    expect(await room.command(b.actor, "join_requests", {})).toMatchObject({
      ok: false,
    });
    // Reject with a reason the requester can see.
    unwrap(
      await room.command(a.actor, "join_respond", {
        requestId: queue[0].id,
        accept: false,
        reason: "Room is full right now",
      }),
    );
    expect(
      unwrap(await room.command(b.actor, "join_status", {})),
    ).toMatchObject({ status: "REJECTED", reason: "Room is full right now" });
    // Rejected visitors can knock again.
    const retry = unwrap(await room.command(b.actor, "join", { tokenHash }));
    expect(retry.pending).toBe(true);
    // Requesters can cancel a pending knock.
    unwrap(await room.command(b.actor, "join_cancel", {}));
    expect(
      unwrap(await room.command(b.actor, "join_status", {})),
    ).toMatchObject({ status: "NONE" });
    expect(
      unwrap(await room.command(a.actor, "join_requests", {})),
    ).toHaveLength(0);
    // Approving lets the visitor in.
    unwrap(await room.command(c.actor, "join", { tokenHash }));
    const pending = unwrap(await room.command(a.actor, "join_requests", {}));
    unwrap(
      await room.command(a.actor, "join_respond", {
        requestId: pending[0].id,
        accept: true,
      }),
    );
    expect(
      unwrap(
        await room.command(c.actor, "snapshot", {} as any),
      ).participants.map((p: any) => p.id),
    ).toContain(c.actor.userId);
  });
  it("serializes available-room limits", async () => {
    const f = await fixture(),
      a = await matchableGuest(f, true),
      results = await Promise.all(
        Array.from({ length: 7 }, () =>
          f.app.command(a.actor, "room.create", {
            type: "AVAILABLE_TONIGHT",
            title: "Public group",
          }),
        ),
      );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(
      results.filter((r) => !r.ok).every((r) => !r.ok && r.status === 429),
    ).toBe(true);
  });
  it("matches each user once and serializes cancellation", async () => {
    const f = await fixture(),
      users = await Promise.all(
        Array.from({ length: 8 }, () => matchableGuest(f)),
      ),
      matcher = f.matcher.getByName("charoo");
    await Promise.all(users.map((u) => matcher.match(u.actor)));
    const rows = (await f.db.prepare("SELECT * FROM active_matches").all())
      .results;
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r: any) => r.room_id)).size).toBe(4);
    const waiting = await matchableGuest(f);
    await matcher.match(waiting.actor);
    await Promise.all([
      matcher.cancel(waiting.actor),
      matcher.cancel(waiting.actor),
    ]);
    expect((await matcher.status()).queue).toBe(0);
  });
  it("excludes blocks and recent pairs from matching", async () => {
    const f = await fixture(),
      a = await matchableGuest(f),
      b = await matchableGuest(f),
      matcher = f.matcher.getByName("charoo");
    unwrap(await f.app.command(a.actor, "block", { targetId: b.actor.userId }));
    await matcher.match(a.actor);
    expect(unwrap(await matcher.match(b.actor))).toEqual({ queued: true });
    unwrap(
      await f.app.command(a.actor, "unblock", { targetId: b.actor.userId }),
    );
    const matched = unwrap(await matcher.match(b.actor));
    expect(matched).toHaveProperty("roomId");
    if ("roomId" in matched)
      unwrap(await roomStub(f.env, matched.roomId).command(a.actor, "leave"));
    await matcher.match(a.actor);
    expect(unwrap(await matcher.match(b.actor))).toEqual({ queued: true });
  });
  it("requires an approved profile picture before a guest or member can start a quick-chat search", async () => {
    const f = await fixture(),
      matcher = f.matcher.getByName("charoo");
    const bare = await f.guest(),
      pictured = await matchableGuest(f);
    expect(await matcher.match(bare.actor)).toMatchObject({
      ok: false,
      status: 403,
      message: "Add a profile picture before starting a quick chat",
    });
    expect((await matcher.status()).queue).toBe(0);
    expect(unwrap(await matcher.match(pictured.actor))).toEqual({
      queued: true,
    });
    expect((await matcher.status()).queue).toBe(1);
  });
  it("matches mixed, other–other and unset-gender pairs immediately", async () => {
    const f = await fixture(),
      matcher = f.matcher.getByName("charoo");
    const male = await matchableGuest(f),
      female = await matchableGuest(f),
      other1 = await matchableGuest(f),
      other2 = await matchableGuest(f),
      unset = await matchableGuest(f);
    await setGender(f, male.actor, "Male");
    await setGender(f, female.actor, " female ");
    await setGender(f, other1.actor, "Other");
    await setGender(f, other2.actor, "other");
    await matcher.match(male.actor);
    expect(unwrap(await matcher.match(female.actor))).toHaveProperty("roomId");
    await matcher.match(other1.actor);
    expect(unwrap(await matcher.match(other2.actor))).toHaveProperty("roomId");
    const waitingFemale = await matchableGuest(f);
    await setGender(f, waitingFemale.actor, "Female");
    expect(unwrap(await matcher.match(waitingFemale.actor))).toEqual({
      queued: true,
    });
    expect(unwrap(await matcher.match(unset.actor))).toHaveProperty("roomId");
  });
  it("holds male–male and female–female pairs until the earlier participant has waited a minute", async () => {
    const f = await fixture(),
      a = await matchableGuest(f),
      b = await matchableGuest(f),
      matcher = f.matcher.getByName("charoo");
    await setGender(f, a.actor, "Female");
    await setGender(f, b.actor, "Female");
    const start = Date.now();
    let now = start;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      expect(unwrap(await matcher.match(a.actor))).toEqual({ queued: true });
      now = start + 59_000;
      expect(unwrap(await matcher.match(b.actor))).toEqual({ queued: true });
      expect(unwrap(await matcher.match(a.actor))).toEqual({ queued: true });
      now = start + 60_000;
      expect(unwrap(await matcher.match(b.actor))).toHaveProperty("roomId");
    } finally {
      clock.mockRestore();
    }
  });
  it("expires a quick-chat search and lets the user start a fresh one", async () => {
    const f = await fixture(),
      a = await matchableGuest(f),
      matcher = f.matcher.getByName("charoo");
    const start = Date.now();
    let now = start;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const hub = f.env.USER_HUB.getByName(a.actor.userId) as any;
    hub.presence = async () => ({ status: "Online", availableExpires: false });
    try {
      expect(unwrap(await matcher.match(a.actor))).toEqual({ queued: true });
      now = start + QUICK_CHAT_SEARCH_TIMEOUT_MS;
      expect(unwrap(await matcher.match(a.actor))).toEqual({ timedOut: true });
      expect((await matcher.status()).queue).toBe(0);
      expect(unwrap(await matcher.match(a.actor))).toEqual({ queued: true });
    } finally {
      clock.mockRestore();
    }
  });
  it("does not reserve a match after a queued candidate's deadline", async () => {
    const f = await fixture(),
      a = await matchableGuest(f),
      b = await matchableGuest(f),
      matcher = f.matcher.getByName("charoo");
    const start = Date.now();
    let now = start;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const aHub = f.env.USER_HUB.getByName(a.actor.userId) as any;
    const bHub = f.env.USER_HUB.getByName(b.actor.userId) as any;
    bHub.presence = async () => ({ status: "Online", availableExpires: false });
    aHub.presence = async () => ({ status: "Online", availableExpires: false });
    const app = f.apps.getByName("charoo") as any;
    const reserveMatch = app.reserveMatch.bind(app);
    let receivedDeadline = 0;
    app.reserveMatch = async (
      userA: string,
      userB: string,
      deadline: number,
    ) => {
      receivedDeadline = deadline;
      now = deadline + 1;
      return reserveMatch(userA, userB, deadline);
    };
    try {
      expect(unwrap(await matcher.match(a.actor))).toEqual({ queued: true });
      now = start + QUICK_CHAT_SEARCH_TIMEOUT_MS - 100;
      await matcher.heartbeat(a.actor.userId);
      expect(unwrap(await matcher.match(b.actor))).toEqual({ queued: true });
      expect(receivedDeadline).toBe(start + QUICK_CHAT_SEARCH_TIMEOUT_MS);
      expect(
        (await f.db.prepare("SELECT * FROM active_matches").all()).results,
      ).toHaveLength(0);
      expect(
        f.matcher.states
          .get("charoo")!
          .database.prepare(
            "SELECT user_id FROM charoo_waiting ORDER BY user_id",
          )
          .all(),
      ).toEqual([{ user_id: b.actor.userId }]);
    } finally {
      clock.mockRestore();
    }
  });
  it("requeues quick chat instead of failing on a blocked match", async () => {
    const f = await fixture(),
      a = await matchableGuest(f),
      b = await matchableGuest(f),
      matcher = f.matcher.getByName("charoo");
    await matcher.match(a.actor);
    const match = unwrap(await matcher.match(b.actor));
    if (!("roomId" in match)) throw new Error("Expected match");
    unwrap(await f.app.command(a.actor, "block", { targetId: b.actor.userId }));
    // Stale active_matches row points at a room the blocker can no longer
    // enter. Retrying quick chat must queue fresh, not throw
    // "Conversation unavailable".
    expect(unwrap(await matcher.match(a.actor))).toEqual({ queued: true });
    unwrap(
      await f.app.command(a.actor, "unblock", { targetId: b.actor.userId }),
    );
  });
  it("accepts duplicate contact requests into one persistent room", async () => {
    const f = await fixture(),
      a = await matchableGuest(f, true),
      b = await matchableGuest(f, true),
      matcher = f.matcher.getByName("charoo");
    await matcher.match(a.actor);
    const match = unwrap(await matcher.match(b.actor));
    if (!("roomId" in match)) throw new Error("Expected match");
    await reachProfileMilestone(roomStub(f.env, match.roomId), a, b);
    const req = unwrap(
      await f.app.command(a.actor, "social.create", {
        kind: "CONTACT",
        targetId: b.actor.userId,
        roomId: match.roomId,
      }),
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        f.app.command(b.actor, "social.respond", { id: req.id, accept: true }),
      ),
    );
    expect(new Set(results.map((r) => unwrap(r).roomId)).size).toBe(1);
    expect(
      (await f.db.prepare("SELECT * FROM contacts").all()).results,
    ).toHaveLength(1);
    const roomId = unwrap(results[0]!).roomId;
    unwrap(await roomStub(f.env, roomId).command(a.actor, "leave"));
    expect((await roomStub(f.env, roomId).authorize(a.actor)).ok).toBe(true);
    unwrap(
      await f.app.command(a.actor, "contact.remove", {
        targetId: b.actor.userId,
      }),
    );
    expect((await roomStub(f.env, roomId).authorize(b.actor)).ok).toBe(false);
  });
  it("rejects expired access before sweeping and purges encrypted content afterwards", async () => {
    const f = await fixture(),
      a = await matchableGuest(f),
      created = unwrap(
        await f.app.command(a.actor, "room.create", {
          type: "SHARED_GROUP",
          title: "Test group",
        }),
      ),
      room = roomStub(f.env, created.id);
    unwrap(
      await room.command(a.actor, "message", {
        text: "To be deleted",
        clientMessageId: crypto.randomUUID(),
      }),
    );
    const state = f.rooms.states.get(`charoo:${created.id}`)!;
    const r: any = JSON.parse(
      state.database.prepare("SELECT data FROM charoo_meta").get()!
        .data as string,
    );
    r.expires_at = iso(Date.now() - 1);
    state.database
      .prepare("UPDATE charoo_meta SET data=?")
      .run(JSON.stringify(r));
    expect(await room.authorize(a.actor)).toMatchObject({
      ok: false,
      status: 410,
    });
    await room.sweep();
    const closed = JSON.parse(
      state.database.prepare("SELECT data FROM charoo_meta").get()!
        .data as string,
    );
    closed.purge_at = iso(Date.now() - 1);
    state.database
      .prepare("UPDATE charoo_meta SET data=?")
      .run(JSON.stringify(closed));
    await room.sweep();
    await room.flush();
    expect(
      state.database.prepare("SELECT count(*) AS n FROM charoo_messages").get()!
        .n,
    ).toBe(0);
    expect(
      (
        await f.db
          .prepare("SELECT * FROM membership_index WHERE room_id=?")
          .bind(created.id)
          .all()
      ).results,
    ).toHaveLength(0);
  });
  it("recovers initialization interrupted between the room and its D1 projection", async () => {
    const f = await fixture(),
      a = await matchableGuest(f);
    f.db.fail = (sql) => sql.includes("INSERT INTO room_index");
    await expect(
      f.app.command(a.actor, "room.create", {
        type: "SHARED_GROUP",
        title: "Recover me",
      }),
    ).rejects.toThrow("Injected");
    const pending = (await f.db.prepare("SELECT * FROM operations").all())
      .results[0];
    expect(pending.state).toBe("PENDING");
    const restarted = f.apps.restart("charoo");
    await restarted.deliver(pending.id);
    await restarted.deliver(pending.id);
    expect(
      (await f.db.prepare("SELECT * FROM room_index").all()).results,
    ).toHaveLength(1);
    expect(
      (await f.db.prepare("SELECT * FROM membership_index").all()).results,
    ).toHaveLength(1);
    expect(
      (await f.db.prepare("SELECT state FROM operations").first()).state,
    ).toBe("DONE");
  });
  it("keeps presence deadlines fixed across heartbeats and preserves sessions while offline", async () => {
    const f = await fixture(),
      a = await matchableGuest(f, true),
      hub = f.users.getByName(a.actor.userId);
    unwrap(
      await hub.setPresence(a.actor, {
        status: "Available Tonight",
        heartbeat: false,
      }),
    );
    const state = f.users.states.get(a.actor.userId)!;
    const deadline = state.database
      .prepare("SELECT until FROM charoo_values WHERE key='available'")
      .get()!.until;
    unwrap(
      await hub.setPresence(a.actor, {
        status: "Available Tonight",
        heartbeat: true,
      }),
    );
    expect(
      state.database
        .prepare("SELECT until FROM charoo_values WHERE key='available'")
        .get()!.until,
    ).toBe(deadline);
    unwrap(
      await hub.setPresence(a.actor, { status: "Offline", heartbeat: false }),
    );
    expect((await hub.presence()).status).toBe("Offline");
    expect(
      (await f.db.prepare("SELECT * FROM sessions").all()).results,
    ).toHaveLength(1);
  });
  it("creates a reconnect request from one exact unexpired archive and accepts it", async () => {
    const f = await fixture(),
      requester = await matchableGuest(f, true),
      recipient = await matchableGuest(f, true),
      sourceRoomId = crypto.randomUUID();
    await f.db
      .prepare(
        "INSERT INTO quick_chat_archives(user_id,peer_id,room_id,last_chatted_at,archived_at,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        requester.actor.userId,
        recipient.actor.userId,
        sourceRoomId,
        iso(),
        iso(),
        iso(Date.now() + 86400000),
      )
      .run();

    const unavailable = await f.app.command(requester.actor, "social.create", {
      kind: "RECONNECT",
      targetId: recipient.actor.userId,
      roomId: crypto.randomUUID(),
    });
    expect(unavailable).toMatchObject({ ok: false, status: 404 });

    const request = unwrap(
      await f.app.command(requester.actor, "social.create", {
        kind: "RECONNECT",
        targetId: recipient.actor.userId,
        roomId: sourceRoomId,
      }),
    );
    const duplicate = unwrap(
      await f.app.command(requester.actor, "social.create", {
        kind: "RECONNECT",
        targetId: recipient.actor.userId,
        roomId: sourceRoomId,
      }),
    );
    expect(duplicate.id).toBe(request.id);
    expect(
      await f.db
        .prepare("SELECT state,source_room_id FROM social_requests WHERE id=?")
        .bind(request.id)
        .first(),
    ).toEqual({ state: "PENDING", source_room_id: sourceRoomId });

    const accepted = unwrap(
      await f.app.command(recipient.actor, "social.respond", {
        id: request.id,
        accept: true,
      }),
    );
    expect(accepted).toMatchObject({
      accepted: true,
      requesterId: requester.actor.userId,
      roomId: expect.any(String),
    });
    expect(
      await f.db
        .prepare("SELECT type,creator_id FROM room_index WHERE id=?")
        .bind(accepted.roomId)
        .first(),
    ).toMatchObject({ type: "PRIVATE", creator_id: requester.actor.userId });
    expect(
      await f.db
        .prepare("SELECT state,result_room_id FROM social_requests WHERE id=?")
        .bind(request.id)
        .first(),
    ).toEqual({ state: "ACCEPTED", result_room_id: accepted.roomId });
  });

  it("rejects acceptance after the source archive expires", async () => {
    const f = await fixture(),
      requester = await matchableGuest(f, true),
      recipient = await matchableGuest(f, true),
      sourceRoomId = crypto.randomUUID();
    await f.db
      .prepare(
        "INSERT INTO quick_chat_archives(user_id,peer_id,room_id,last_chatted_at,archived_at,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        requester.actor.userId,
        recipient.actor.userId,
        sourceRoomId,
        iso(),
        iso(),
        iso(Date.now() + 86400000),
      )
      .run();
    const request = unwrap(
      await f.app.command(requester.actor, "social.create", {
        kind: "RECONNECT",
        targetId: recipient.actor.userId,
        roomId: sourceRoomId,
      }),
    );
    await f.db
      .prepare("UPDATE quick_chat_archives SET expires_at=? WHERE room_id=?")
      .bind(iso(Date.now() - 1), sourceRoomId)
      .run();

    expect(
      await f.app.command(recipient.actor, "social.respond", {
        id: request.id,
        accept: true,
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await f.db
        .prepare("SELECT state FROM social_requests WHERE id=?")
        .bind(request.id)
        .first(),
    ).toEqual({ state: "PENDING" });
  });

  it("expires reconnect requests with their source archive", async () => {
    const f = await fixture(),
      requester = await matchableGuest(f, true),
      recipient = await matchableGuest(f, true),
      sourceRoomId = crypto.randomUUID(),
      sourceExpiresAt = iso(Date.now() + 3600000);
    await f.db
      .prepare(
        "INSERT INTO quick_chat_archives(user_id,peer_id,room_id,last_chatted_at,archived_at,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        requester.actor.userId,
        recipient.actor.userId,
        sourceRoomId,
        iso(),
        iso(),
        sourceExpiresAt,
      )
      .run();

    const request = unwrap(
      await f.app.command(requester.actor, "social.create", {
        kind: "RECONNECT",
        targetId: recipient.actor.userId,
        roomId: sourceRoomId,
      }),
    );
    expect(
      await f.db
        .prepare("SELECT expires_at FROM social_requests WHERE id=?")
        .bind(request.id)
        .first(),
    ).toEqual({ expires_at: sourceExpiresAt });
  });

  it("rejecting a reconnect removes only its source archive from the requester", async () => {
    const f = await fixture(),
      requester = await matchableGuest(f, true),
      recipient = await matchableGuest(f, true),
      sourceRoomId = crypto.randomUUID(),
      otherRoomId = crypto.randomUUID();
    for (const roomId of [sourceRoomId, otherRoomId])
      await f.db
        .prepare(
          "INSERT INTO quick_chat_archives(user_id,peer_id,room_id,last_chatted_at,archived_at,expires_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          requester.actor.userId,
          recipient.actor.userId,
          roomId,
          iso(),
          iso(),
          iso(Date.now() + 86400000),
        )
        .run();
    const request = unwrap(
      await f.app.command(requester.actor, "social.create", {
        kind: "RECONNECT",
        targetId: recipient.actor.userId,
        roomId: sourceRoomId,
      }),
    );

    expect(
      unwrap(
        await f.app.command(recipient.actor, "social.respond", {
          id: request.id,
          accept: false,
        }),
      ),
    ).toMatchObject({ roomId: null, accepted: false });
    expect(
      await f.db
        .prepare("SELECT state FROM social_requests WHERE id=?")
        .bind(request.id)
        .first(),
    ).toEqual({ state: "REJECTED" });
    expect(
      await f.db
        .prepare(
          "SELECT room_id FROM quick_chat_archives WHERE user_id=? ORDER BY room_id",
        )
        .bind(requester.actor.userId)
        .all(),
    ).toMatchObject({ results: [{ room_id: otherRoomId }] });
  });

  it("does not allow reconnect after a current block", async () => {
    const f = await fixture(),
      requester = await matchableGuest(f, true),
      recipient = await matchableGuest(f, true),
      sourceRoomId = crypto.randomUUID();
    await f.db
      .prepare(
        "INSERT INTO quick_chat_archives(user_id,peer_id,room_id,last_chatted_at,archived_at,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        requester.actor.userId,
        recipient.actor.userId,
        sourceRoomId,
        iso(),
        iso(),
        iso(Date.now() + 86400000),
      )
      .run();
    const request = unwrap(
      await f.app.command(requester.actor, "social.create", {
        kind: "RECONNECT",
        targetId: recipient.actor.userId,
        roomId: sourceRoomId,
      }),
    );
    unwrap(
      await f.app.command(recipient.actor, "block", {
        targetId: requester.actor.userId,
      }),
    );

    expect(
      await f.app.command(recipient.actor, "social.respond", {
        id: request.id,
        accept: true,
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(await f.db.prepare("SELECT * FROM room_index").all()).toMatchObject({
      results: [],
    });
  });

  it("recovers contact acceptance without another client submission", async () => {
    const f = await fixture(),
      a = await matchableGuest(f, true),
      b = await matchableGuest(f, true),
      matcher = f.matcher.getByName("charoo");
    await matcher.match(a.actor);
    const match = unwrap(await matcher.match(b.actor));
    if (!("roomId" in match)) throw new Error("Expected match");
    await reachProfileMilestone(roomStub(f.env, match.roomId), a, b);
    const req = unwrap(
      await f.app.command(a.actor, "social.create", {
        kind: "CONTACT",
        targetId: b.actor.userId,
        roomId: match.roomId,
      }),
    );
    f.db.fail = (sql) => sql.includes("INSERT INTO room_index");
    await expect(
      f.app.command(b.actor, "social.respond", { id: req.id, accept: true }),
    ).rejects.toThrow();
    const op = (
      await f.db
        .prepare("SELECT id FROM operations WHERE state='PENDING'")
        .first()
    ).id;
    await f.app.deliver(op);
    await f.app.deliver(op);
    expect(
      (
        await f.db
          .prepare("SELECT state FROM social_requests WHERE id=?")
          .bind(req.id)
          .first()
      ).state,
    ).toBe("ACCEPTED");
    expect(
      (await f.db.prepare("SELECT * FROM contacts").all()).results,
    ).toHaveLength(1);
  });
  it("deduplicates room creation with a stable browser operation ID", async () => {
    const f = await fixture(),
      a = await matchableGuest(f),
      input = {
        type: "SHARED_GROUP",
        title: "One group only",
        clientOperationId: crypto.randomUUID(),
      };
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.app.command(a.actor, "room.create", input),
      ),
    );
    expect(new Set(results.map((r) => unwrap(r).id)).size).toBe(1);
    expect(new Set(results.map((r) => unwrap(r).shareUrl)).size).toBe(1);
    expect(
      (await f.db.prepare("SELECT * FROM room_index").all()).results,
    ).toHaveLength(1);
  });
  it("deletes expired unreferenced guests and anonymizes audit metadata", async () => {
    const f = await fixture(),
      a = await matchableGuest(f);
    await f.db
      .prepare("UPDATE users SET guest_expires_at=? WHERE id=?")
      .bind(iso(Date.now() - 1), a.actor.userId)
      .run();
    expect(await f.app.command(a.actor, "profile", {})).toMatchObject({
      ok: false,
      status: 401,
    });
    await f.app.cleanup();
    expect(
      (await f.db.prepare("SELECT * FROM users").all()).results,
    ).toHaveLength(0);
  });
  it("keeps a block in force for a request made before it", async () => {
    const f = await fixture(),
      host = await matchableGuest(f),
      visitor = await matchableGuest(f),
      created = unwrap(
        await f.app.command(host.actor, "room.create", {
          type: "SHARED_GROUP",
          title: "Block scope",
        }),
      ),
      room = roomStub(f.env, created.id),
      tokenHash = await hash(new URL(created.shareUrl).hash.slice(6));
    unwrap(await room.command(visitor.actor, "join", { tokenHash }));
    const [pending] = unwrap(
      await room.command(host.actor, "join_requests", {}),
    );
    unwrap(
      await f.app.command(host.actor, "block", {
        targetId: visitor.actor.userId,
      }),
    );
    expect(
      await room.command(host.actor, "join_respond", {
        requestId: pending.id,
        accept: true,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      unwrap(await room.command(visitor.actor, "join_status", {})),
    ).toMatchObject({ status: "PENDING" });
    // A pending requester is not a joined member, so reads stay denied as
    // unavailable (404) and never reach the block check.
    expect(await room.command(visitor.actor, "messages")).toMatchObject({
      ok: false,
      status: 404,
    });
  });
  it("ends an approved member's shared-room access when the host blocks them", async () => {
    const f = await fixture(),
      host = await matchableGuest(f),
      member = await matchableGuest(f),
      created = unwrap(
        await f.app.command(host.actor, "room.create", {
          type: "SHARED_GROUP",
          title: "Block after approval",
        }),
      ),
      room = roomStub(f.env, created.id),
      tokenHash = await hash(new URL(created.shareUrl).hash.slice(6));
    unwrap(await room.command(member.actor, "join", { tokenHash }));
    const [request] = unwrap(
      await room.command(host.actor, "join_requests", {}),
    );
    unwrap(
      await room.command(host.actor, "join_respond", {
        requestId: request.id,
        accept: true,
      }),
    );
    expect(
      unwrap(await room.command(member.actor, "messages")).messages,
    ).toEqual([]);
    unwrap(
      await f.app.command(host.actor, "block", {
        targetId: member.actor.userId,
      }),
    );
    expect(await room.command(member.actor, "messages")).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      await room.command(member.actor, "message", {
        text: "Still here?",
        clientMessageId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: false, status: 403 });
    const hostPage = unwrap(await room.command(host.actor, "messages"));
    expect(hostPage.messages).toEqual([]);
  });
  it("withholds the room title from join status for unrelated users", async () => {
    const f = await fixture(),
      host = await matchableGuest(f),
      applicant = await matchableGuest(f),
      stranger = await matchableGuest(f),
      created = unwrap(
        await f.app.command(host.actor, "room.create", {
          type: "SHARED_GROUP",
          title: "Private title",
        }),
      ),
      room = roomStub(f.env, created.id),
      tokenHash = await hash(new URL(created.shareUrl).hash.slice(6));
    expect(
      unwrap(await room.command(stranger.actor, "join_status", {})),
    ).toStrictEqual({ status: "NONE", roomId: created.id });
    unwrap(await room.command(applicant.actor, "join", { tokenHash }));
    expect(
      unwrap(await room.command(applicant.actor, "join_status", {})),
    ).toMatchObject({ status: "PENDING", title: "Private title" });
  });
});
