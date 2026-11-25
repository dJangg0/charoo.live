import { describe, expect, it, vi } from "vitest";
import { joinIdentitySchema } from "@charoo/contracts";
import { addApprovedPicture, fixture, matchableGuest } from "./runtime";
import { unwrap } from "../celld/shared/errors";
import { roomStub } from "../celld/shared/data";
import { hash } from "../celld/shared/crypto";

// Group rooms: each join chooses to enter with the profile or as a guest with an optional nickname.
async function groupWithHost(
  f: Awaited<ReturnType<typeof fixture>>,
  verified = false,
) {
  const host = await matchableGuest(f, verified);
  const created = unwrap(
    await f.app.command(host.actor, "room.create", {
      type: "SHARED_GROUP",
      title: "Identity group",
    }),
  );
  const room = roomStub(f.env, created.id);
  const tokenHash = await hash(new URL(created.shareUrl).hash.slice(6));
  return { host, room, tokenHash, roomId: created.id as string };
}

async function knockAndApprove(
  room: ReturnType<typeof roomStub>,
  host: { actor: any },
  member: { actor: any },
  tokenHash: string,
  join: Record<string, unknown>,
) {
  const pending = unwrap(
    await room.command(member.actor, "join", { tokenHash, ...join }),
  );
  expect(pending.pending).toBe(true);
  const queue = unwrap(await room.command(host.actor, "join_requests", {}));
  const request = queue.find((j: any) => j.userId === member.actor.userId);
  unwrap(
    await room.command(host.actor, "join_respond", {
      requestId: request.id,
      accept: true,
    }),
  );
}

async function seenName(
  room: ReturnType<typeof roomStub>,
  viewer: { actor: any },
  userId: string,
) {
  const snapshot = unwrap(await room.command(viewer.actor, "snapshot"));
  return snapshot.participants.find((p: any) => p.id === userId);
}

describe("group room join identity", () => {
  it("lets a guest join with a nickname that members see instead of the account name", async () => {
    const f = await fixture();
    const { host, room, tokenHash } = await groupWithHost(f);
    const member = await f.guest();
    // A public ASL on the account must still stay hidden behind a guest entry.
    await f.env.DB.prepare("UPDATE users SET profile=? WHERE id=?")
      .bind(
        JSON.stringify({
          age: 30,
          gender: "female",
          region: "US",
          aslVisibility: "public",
        }),
        member.actor.userId,
      )
      .run();
    await knockAndApprove(room, host, member, tokenHash, {
      identity: { mode: "guest", nickname: "Night owl" },
      avatar: { kind: "avatar", id: "rose" },
    });
    const seen = await seenName(room, host, member.actor.userId);
    expect(seen.name).toBe("Night owl");
    expect(seen.asl).toBeNull();
    expect(seen.verified).toBe(false);
    expect(seen.avatar).toEqual({ kind: "avatar", id: "rose" });

    unwrap(
      await room.command(member.actor, "message", {
        text: "hello from the guest",
        clientMessageId: crypto.randomUUID(),
      }),
    );
    const history = unwrap(await room.command(host.actor, "messages", {}));
    expect(
      history.messages.find((m: any) => m.text === "hello from the guest").name,
    ).toBe("Night owl");
  });

  it("gives a guest without a nickname a random guest name", async () => {
    const f = await fixture();
    const { host, room, tokenHash } = await groupWithHost(f);
    const member = await f.guest();
    await knockAndApprove(room, host, member, tokenHash, {
      identity: { mode: "guest" },
    });
    const seen = await seenName(room, host, member.actor.userId);
    expect(seen.name).toMatch(/^Guest [0-9A-F]{4}$/);
    expect(seen.name).not.toBe("");
  });

  it("keeps a profile join showing the account name", async () => {
    const f = await fixture();
    const { host, room, tokenHash } = await groupWithHost(f);
    const member = await f.guest();
    await knockAndApprove(room, host, member, tokenHash, {
      identity: { mode: "profile" },
      avatar: { kind: "avatar", id: "sky" },
    });
    const account = await f.db
      .prepare("SELECT display_name FROM users WHERE id=?")
      .bind(member.actor.userId)
      .first();
    expect((await seenName(room, host, member.actor.userId)).name).toBe(
      account.display_name,
    );
  });

  it("refuses contact requests to or from a guest entry so the account name stays hidden", async () => {
    const f = await fixture();
    const { host, room, tokenHash, roomId } = await groupWithHost(f, true);
    const member = await matchableGuest(f, true);
    await knockAndApprove(room, host, member, tokenHash, {
      identity: { mode: "guest", nickname: "Quiet fox" },
      avatar: { kind: "avatar", id: "mint" },
    });
    for (const [from, to] of [
      [member, host],
      [host, member],
    ])
      expect(
        await f.app.command(from.actor, "social.create", {
          targetId: to.actor.userId,
          kind: "CONTACT",
          roomId,
        }),
      ).toMatchObject({
        ok: false,
        status: 403,
        message: expect.stringMatching(/Guests/),
      });
  });

  it("refuses a profile picture for a guest entry, even when the account has one", async () => {
    const f = await fixture();
    const { room, tokenHash } = await groupWithHost(f);
    const member = await f.guest();
    await addApprovedPicture(f, member);
    const outcome = await room.command(member.actor, "join", {
      tokenHash,
      identity: { mode: "guest", nickname: "Quiet fox" },
      avatar: { kind: "picture" },
    });
    expect(outcome).toMatchObject({ ok: false, status: 400 });
  });

  it("shows the host only the nickname for a guest join request", async () => {
    const f = await fixture();
    const { host, room, tokenHash } = await groupWithHost(f);
    const member = await f.guest();
    unwrap(
      await room.command(member.actor, "join", {
        tokenHash,
        identity: { mode: "guest", nickname: "Quiet fox" },
        avatar: { kind: "avatar", id: "mint" },
      }),
    );
    const queue = unwrap(await room.command(host.actor, "join_requests", {}));
    const request = queue.find((j: any) => j.userId === member.actor.userId);
    expect(request).toMatchObject({
      displayName: "Quiet fox",
      verified: false,
    });
  });

  it("keeps a guest's earlier messages under the nickname after a rejoin with the profile", async () => {
    const f = await fixture();
    const { host, room, tokenHash } = await groupWithHost(f);
    const member = await f.guest();
    await knockAndApprove(room, host, member, tokenHash, {
      identity: { mode: "guest", nickname: "Night owl" },
      avatar: { kind: "avatar", id: "rose" },
    });
    unwrap(
      await room.command(member.actor, "message", {
        text: "written as a guest",
        clientMessageId: crypto.randomUUID(),
      }),
    );
    unwrap(await room.command(member.actor, "leave"));
    unwrap(
      await room.command(member.actor, "join", {
        tokenHash,
        identity: { mode: "profile" },
        avatar: { kind: "avatar", id: "sky" },
      }),
    );
    // Group rooms have a slow mode; step past it before the second message.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10_000);
    try {
      unwrap(
        await room.command(member.actor, "message", {
          text: "written with the profile",
          clientMessageId: crypto.randomUUID(),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
    const account = await f.db
      .prepare("SELECT display_name FROM users WHERE id=?")
      .bind(member.actor.userId)
      .first();
    const history = unwrap(await room.command(host.actor, "messages", {}));
    const names = Object.fromEntries(
      history.messages.map((m: any) => [m.text, m.name]),
    );
    expect(names["written as a guest"]).toBe("Night owl");
    expect(names["written with the profile"]).toBe(account.display_name);
    expect((await seenName(room, host, member.actor.userId)).name).toBe(
      account.display_name,
    );
  });

  it("validates the nickname: one character is refused, empty means no nickname", () => {
    expect(
      joinIdentitySchema.safeParse({ mode: "guest", nickname: "a" }).success,
    ).toBe(false);
    expect(
      joinIdentitySchema.safeParse({ mode: "guest", nickname: "x".repeat(25) })
        .success,
    ).toBe(false);
    const empty = joinIdentitySchema.parse({ mode: "guest", nickname: "  " });
    expect(empty).toEqual({ mode: "guest", nickname: undefined });
    expect(joinIdentitySchema.parse({ mode: "profile" })).toEqual({
      mode: "profile",
    });
  });
});
