import { describe, expect, it } from "vitest";
import { addApprovedPicture, fixture, matchableGuest } from "./runtime";
import { unwrap } from "../celld/shared/errors";
import { roomStub } from "../celld/shared/data";
import { hash } from "../celld/shared/crypto";

// Group rooms: joining needs no profile picture; the member picks a picture or an avatar.
async function groupWithHost(f: Awaited<ReturnType<typeof fixture>>) {
  const host = await matchableGuest(f);
  const created = unwrap(
    await f.app.command(host.actor, "room.create", {
      type: "SHARED_GROUP",
      title: "Avatar group",
    }),
  );
  const room = roomStub(f.env, created.id);
  const tokenHash = await hash(new URL(created.shareUrl).hash.slice(6));
  return { host, room, tokenHash };
}

async function joinAndApprove(
  room: ReturnType<typeof roomStub>,
  host: { actor: any },
  member: { actor: any },
  tokenHash: string,
  avatar?: unknown,
) {
  const pending = unwrap(
    await room.command(member.actor, "join", { tokenHash, avatar }),
  );
  expect(pending.pending).toBe(true);
  const queue = unwrap(await room.command(host.actor, "join_requests", {}));
  const request = queue.find((j: any) => j.userId === member.actor.userId);
  unwrap(
    await room.command(host.actor, "join_respond", {
      requestId: request?.id ?? queue[0].id,
      accept: true,
    }),
  );
}

describe("group room avatar choice", () => {
  it("lets a member without a picture join a group by choosing an avatar", async () => {
    const f = await fixture();
    const { host, room, tokenHash } = await groupWithHost(f);
    const member = await f.guest();
    await joinAndApprove(room, host, member, tokenHash, {
      kind: "avatar",
      id: "rose",
    });
    const snapshot = unwrap(await room.command(host.actor, "snapshot"));
    const seen = snapshot.participants.find(
      (p: any) => p.id === member.actor.userId,
    );
    expect(seen.avatar).toEqual({ kind: "avatar", id: "rose" });
  });

  it("rejects a picture choice when the member has no approved picture", async () => {
    const f = await fixture();
    const { room, tokenHash } = await groupWithHost(f);
    const member = await f.guest();
    expect(
      await room.command(member.actor, "join", {
        tokenHash,
        avatar: { kind: "picture" },
      }),
    ).toMatchObject({
      ok: false,
      status: 409,
      message: "Add a profile picture or choose an avatar",
    });
  });

  it("shows a pinned picture to members only while it stays approved", async () => {
    const f = await fixture();
    const { host, room, tokenHash } = await groupWithHost(f);
    const member = await matchableGuest(f);
    const outsider = await matchableGuest(f);
    const picture = await addApprovedPicture(f, member, 21);
    await joinAndApprove(room, host, member, tokenHash, { kind: "picture" });

    const hostView = unwrap(await room.command(host.actor, "snapshot"));
    const pinned = hostView.participants.find(
      (p: any) => p.id === member.actor.userId,
    );
    expect(pinned.avatar).toMatchObject({ kind: "picture" });
    expect(pinned.avatar.url).toContain(`pictureId=${picture.id}`);

    // Members can read the pinned picture; outsiders cannot read it at all.
    expect(
      unwrap(
        await room.command(host.actor, "picture.download", {
          userId: member.actor.userId,
        }),
      ),
    ).toMatchObject({ id: picture.id });
    expect(
      await room.command(outsider.actor, "picture.download", {
        userId: member.actor.userId,
      }),
    ).toMatchObject({ ok: false });

    // Uploading a replacement retires the pinned picture; it is no longer shown.
    await addApprovedPicture(f, member, 22);
    const after = unwrap(await room.command(host.actor, "snapshot"));
    const replaced = after.participants.find(
      (p: any) => p.id === member.actor.userId,
    );
    expect(replaced.avatar).toBeNull();
    expect(
      await room.command(host.actor, "picture.download", {
        userId: member.actor.userId,
      }),
    ).toMatchObject({ ok: false });
  });

  it("public rooms join at once with the chosen avatar and default to a generated avatar", async () => {
    const f = await fixture();
    const host = await matchableGuest(f, true);
    const created = unwrap(
      await f.app.command(host.actor, "room.create", {
        type: "AVAILABLE_TONIGHT",
        title: "Public avatars",
      }),
    );
    const room = roomStub(f.env, created.id);
    const chooser = await matchableGuest(f, true);
    const defaulted = await matchableGuest(f, true);
    unwrap(
      await room.command(chooser.actor, "join", {
        avatar: { kind: "avatar", id: "violet" },
      }),
    );
    unwrap(await room.command(defaulted.actor, "join", {}));
    const view = unwrap(await room.command(host.actor, "snapshot"));
    const byId = (id: string) =>
      view.participants.find((p: any) => p.id === id);
    expect(byId(chooser.actor.userId).avatar).toEqual({
      kind: "avatar",
      id: "violet",
    });
    expect(byId(defaulted.actor.userId).avatar).toEqual({
      kind: "avatar",
      id: "sky",
    });
    // A member who is already joined keeps the avatar they chose.
    unwrap(
      await room.command(chooser.actor, "join", {
        avatar: { kind: "avatar", id: "moss" },
      }),
    );
    const again = unwrap(await room.command(host.actor, "snapshot"));
    expect(
      again.participants.find((p: any) => p.id === chooser.actor.userId).avatar,
    ).toEqual({ kind: "avatar", id: "violet" });
  });
  it("does not let an avatar choice expose any picture", async () => {
    const f = await fixture();
    const { host, room, tokenHash } = await groupWithHost(f);
    const member = await matchableGuest(f);
    await joinAndApprove(room, host, member, tokenHash, {
      kind: "avatar",
      id: "moss",
    });
    expect(
      await room.command(host.actor, "picture.download", {
        userId: member.actor.userId,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("public join for an existing member", () => {
  it("does not re-check a picture choice for a member who is already joined", async () => {
    const f = await fixture();
    const host = await matchableGuest(f, true);
    const created = unwrap(
      await f.app.command(host.actor, "room.create", {
        type: "AVAILABLE_TONIGHT",
        title: "Rejoin avatars",
      }),
    );
    const room = roomStub(f.env, created.id);
    // A verified guest without a profile picture joins with a generated avatar.
    const member = await f.guest(true);
    unwrap(
      await room.command(member.actor, "join", {
        avatar: { kind: "avatar", id: "sun" },
      }),
    );
    // Repeating the join with a picture choice must not fail: the member has no picture to choose.
    unwrap(
      await room.command(member.actor, "join", {
        avatar: { kind: "picture" },
      }),
    );
    const view = unwrap(await room.command(host.actor, "snapshot"));
    expect(
      view.participants.find((p: any) => p.id === member.actor.userId).avatar,
    ).toEqual({ kind: "avatar", id: "sun" });
  });
});
