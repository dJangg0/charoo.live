import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../celld/http/app";
import { iso, roomStub, type Actor } from "../celld/shared/data";
import { unwrap } from "../celld/shared/errors";
import { fixture } from "./runtime";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Guest = Awaited<ReturnType<Fixture["guest"]>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function quickChat() {
  const f = await fixture(),
    a = await f.guest(),
    b = await f.guest(),
    matcher = f.matcher.getByName("charoo");
  unwrap(await matcher.match(a.actor));
  const match = unwrap(await matcher.match(b.actor));
  if (!("roomId" in match)) throw new Error("Expected a quick chat");
  const roomId = match.roomId as string;
  return { f, a, b, roomId, room: roomStub(f.env, roomId) };
}
type Chat = Awaited<ReturnType<typeof quickChat>>;

async function send(chat: Chat, owner: Guest, count: number) {
  for (let i = 0; i < count; i++) {
    vi.setSystemTime(Date.now() + 3001);
    unwrap(
      await chat.room.command(owner.actor, "message", {
        text: `A different thought about our conversation ${crypto.randomUUID()}`,
        clientMessageId: crypto.randomUUID(),
      }),
    );
  }
}
async function snapshot(chat: Chat, owner = chat.a) {
  return unwrap(await chat.room.command(owner.actor, "snapshot"));
}
async function setProfile(f: Fixture, actor: Actor, visibility: string) {
  const row = await f.db
    .prepare("SELECT profile FROM users WHERE id=?")
    .bind(actor.userId)
    .first();
  const profile = {
    ...JSON.parse(row.profile),
    age: 25,
    gender: "Woman",
    region: "Manila",
    aslVisibility: visibility,
  };
  await f.db
    .prepare("UPDATE users SET profile=? WHERE id=?")
    .bind(JSON.stringify(profile), actor.userId)
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

async function addPicture(f: Fixture, owner: Guest, value = 7) {
  const picture = unwrap(
    await f.app.command(owner.actor, "picture.init", {
      mime: "image/png",
      size: 12,
    }),
  );
  const upload = unwrap(
    await f.app.command(owner.actor, "picture.upload.begin", {
      id: picture.id,
    }),
  );
  await f.env.MEDIA.put(upload.object_key, new Uint8Array(12).fill(value), {
    httpMetadata: { contentType: "image/png" },
  });
  unwrap(
    await f.app.command(owner.actor, "picture.upload.finish", {
      id: picture.id,
      attempt: upload.attempt,
    }),
  );
  // Domain fixture: HTTP validation is covered by profile-upload.test.ts.
  unwrap(
    await f.app.command(owner.actor, "picture.complete", {
      id: picture.id,
      attempt: upload.attempt,
      key: upload.object_key,
    }),
  );
  return { ...picture, bytes: new Uint8Array(12).fill(value) };
}
async function share(
  chat: Chat,
  owner: Guest,
  decision: "approved" | "declined",
) {
  const state = await snapshot(chat, owner);
  return chat.room.command(owner.actor, "picture.share", {
    decision,
    ...(decision === "approved"
      ? {
          pictureId: state.pictureSharing.self.pictureId || crypto.randomUUID(),
        }
      : {}),
  });
}
async function makeEligible(chat: Chat) {
  await send(chat, chat.a, 10);
  await send(chat, chat.b, 10);
}

describe("FR-12 quick-chat disclosure", () => {
  it.each(["expired", "banned", "suspended"] as const)(
    "hides an unavailable owner's public ASL before cleanup (%s)",
    async (state) => {
      const chat = await quickChat();
      await setProfile(chat.f, chat.a.actor, "public");
      await setProfile(chat.f, chat.b.actor, "public");
      await send(chat, chat.a, 5);
      await send(chat, chat.b, 5);
      expect(
        (await snapshot(chat, chat.b)).participants.find(
          (p: any) => p.id === chat.a.actor.userId,
        ).asl.age,
      ).toBe(25);
      if (state === "expired")
        await chat.f.db
          .prepare("UPDATE users SET guest_expires_at=? WHERE id=?")
          .bind(iso(Date.now() - 1), chat.a.actor.userId)
          .run();
      else if (state === "banned")
        await chat.f.db
          .prepare("UPDATE users SET banned=1 WHERE id=?")
          .bind(chat.a.actor.userId)
          .run();
      else
        await chat.f.db
          .prepare("UPDATE users SET suspended_until=? WHERE id=?")
          .bind(iso(Date.now() + 60000), chat.a.actor.userId)
          .run();
      const result = await snapshot(chat, chat.b);
      expect(result.asl_revealed).toBe(true);
      expect(
        result.participants.find((p: any) => p.id === chat.a.actor.userId).asl,
      ).toBeNull();
      expect(
        result.participants.find((p: any) => p.id === chat.b.actor.userId).asl
          .age,
      ).toBe(25);
    },
  );

  it.each([
    [10, 0],
    [10, 4],
    [4, 5],
  ])(
    "keeps ASL and picture invitations hidden with %i/%i messages",
    async (a, b) => {
      const chat = await quickChat();
      await setProfile(chat.f, chat.a.actor, "public");
      await setProfile(chat.f, chat.b.actor, "public");
      await send(chat, chat.a, a);
      await send(chat, chat.b, b);
      for (const viewer of [chat.a, chat.b]) {
        const state = await snapshot(chat, viewer);
        expect(state.asl_revealed).toBe(false);
        expect(state.participants.every((p: any) => p.asl === null)).toBe(true);
        expect(state.pictureSharing.eligible).toBe(false);
        expect(state.pictureSharing.participants).toEqual([]);
      }
    },
  );

  it("reveals permitted ASL at five each without room-age or legacy setting gates", async () => {
    const chat = await quickChat();
    await setProfile(chat.f, chat.a.actor, "public");
    await setProfile(chat.f, chat.b.actor, "private");
    const settings = JSON.parse(
      (await chat.f.db.prepare("SELECT value FROM settings").first()).value,
    );
    Object.assign(settings, {
      minimum_messages_per_user: 100,
      asl_reveal_threshold: 200,
      asl_minimum_duration_seconds: 3600,
    });
    await chat.f.db
      .prepare("UPDATE settings SET value=?")
      .bind(JSON.stringify(settings))
      .run();
    await send(chat, chat.a, 5);
    await send(chat, chat.b, 4);
    expect((await snapshot(chat)).asl_revealed).toBe(false);
    await send(chat, chat.b, 1);
    const a = await snapshot(chat),
      b = await snapshot(chat, chat.b);
    expect(a.asl_revealed).toBe(true);
    expect(
      a.participants.find((p: any) => p.id === chat.b.actor.userId).asl,
    ).toBeNull();
    expect(
      b.participants.find((p: any) => p.id === chat.a.actor.userId).asl,
    ).toEqual({
      age: 25,
      gender: "Woman",
      region: "Manila",
    });
    expect(a.pictureSharing.eligible).toBe(false);
    expect(a.pictureSharing.participants).toEqual([]);
  });

  it("normalizes an old early ASL reveal against the five-each requirement", async () => {
    const chat = await quickChat();
    await setProfile(chat.f, chat.a.actor, "public");
    await setProfile(chat.f, chat.b.actor, "public");
    await send(chat, chat.a, 1);
    await send(chat, chat.b, 1);
    const state = chat.f.rooms.states.get(`charoo:${chat.roomId}`)!;
    const meta = JSON.parse(
      state.database.prepare("SELECT data FROM charoo_meta").get()!
        .data as string,
    );
    // Older deployments could reveal after one each under lowered admin settings.
    meta.asl_revealed = true;
    state.database
      .prepare("UPDATE charoo_meta SET data=?")
      .run(JSON.stringify(meta));
    for (const viewer of [chat.a, chat.b]) {
      const current = await snapshot(chat, viewer);
      expect(current.asl_revealed).toBe(false);
      expect(current.participants.every((p: any) => p.asl === null)).toBe(true);
    }
    await send(chat, chat.a, 4);
    await send(chat, chat.b, 4);
    const current = await snapshot(chat);
    expect(current.asl_revealed).toBe(true);
    expect(current.participants.every((p: any) => p.asl !== null)).toBe(true);
  });

  it("requires ten each for pictures even when one participant has sent twenty", async () => {
    const chat = await quickChat();
    await send(chat, chat.a, 20);
    await send(chat, chat.b, 9);
    const state = await snapshot(chat);
    expect(state.asl_revealed).toBe(true);
    expect(state.pictureSharing.eligible).toBe(false);
    expect(
      await chat.room.command(chat.a.actor, "picture.share", {
        decision: "approved",
        pictureId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: false });
  });

  it("does not count stable-ID retries, repeated content, short messages, rapid sends or failed writes", async () => {
    const chat = await quickChat();
    const text = "How has your day been so far?",
      clientMessageId = crypto.randomUUID();
    unwrap(
      await chat.room.command(chat.a.actor, "message", {
        text,
        clientMessageId,
      }),
    );
    const first = await snapshot(chat);
    const progress = (state: any) =>
      state.aslProgress.find((p: any) => p.id === chat.a.actor.userId).count;
    expect(progress(first)).toBe(1);
    vi.setSystemTime(Date.now() + 3001);
    unwrap(
      await chat.room.command(chat.a.actor, "message", {
        text,
        clientMessageId,
      }),
    );
    unwrap(
      await chat.room.command(chat.a.actor, "message", {
        text: " HOW has your DAY been so far? ",
        clientMessageId: crypto.randomUUID(),
      }),
    );
    unwrap(
      await chat.room.command(chat.a.actor, "message", {
        text: "hi",
        clientMessageId: crypto.randomUUID(),
      }),
    );
    unwrap(
      await chat.room.command(chat.a.actor, "message", {
        text: "Here is a second distinct and meaningful sentence",
        clientMessageId: crypto.randomUUID(),
      }),
    );
    unwrap(
      await chat.room.command(chat.a.actor, "message", {
        text: "This immediate next sentence should not qualify",
        clientMessageId: crypto.randomUUID(),
      }),
    );
    expect(
      await chat.room.command(chat.a.actor, "message", {
        text: "This rejected reply cannot count toward a milestone",
        clientMessageId: crypto.randomUUID(),
        replyTo: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: false });
    expect(progress(await snapshot(chat))).toBe(2);
    expect((await snapshot(chat)).asl_revealed).toBe(false);
  });

  it("keeps both pictures private until independent owner approval and persists later sharing", async () => {
    const chat = await quickChat();
    const aPicture = await addPicture(chat.f, chat.a);
    await addPicture(chat.f, chat.b, 9);
    expect(await share(chat, chat.a, "approved")).toMatchObject({ ok: false });
    await makeEligible(chat);
    for (const viewer of [chat.a, chat.b]) {
      const state = await snapshot(chat, viewer);
      expect(state.pictureSharing).toMatchObject({
        eligible: true,
        self: { hasPicture: true, decision: "pending" },
        participants: [],
      });
      expect(JSON.stringify(state.pictureSharing.participants)).not.toContain(
        "/content",
      );
      const denied = await http(
        chat.f,
        `/rooms/${chat.roomId}/pictures/${viewer.actor.userId}/content`,
        viewer === chat.a ? chat.b : chat.a,
      );
      expect(denied.status).toBe(404);
    }
    unwrap(await share(chat, chat.a, "approved"));
    unwrap(await share(chat, chat.b, "declined"));
    unwrap(await share(chat, chat.b, "declined"));
    const a = await snapshot(chat),
      b = await snapshot(chat, chat.b);
    expect(
      b.pictureSharing.participants.find(
        (p: any) => p.id === chat.a.actor.userId,
      ).url,
    ).toBe(
      `/api/rooms/${chat.roomId}/pictures/${chat.a.actor.userId}/content?pictureId=${aPicture.id}`,
    );
    expect(
      a.pictureSharing.participants.some(
        (p: any) => p.id === chat.b.actor.userId,
      ),
    ).toBe(false);
    expect(b.pictureSharing.self.decision).toBe("declined");
    chat.room = chat.f.rooms.restart(`charoo:${chat.roomId}`);
    await send(chat, chat.a, 1);
    expect((await snapshot(chat, chat.b)).pictureSharing.self.decision).toBe(
      "declined",
    );
    const before = (await snapshot(chat)).aslProgress;
    unwrap(await share(chat, chat.b, "approved"));
    expect((await snapshot(chat)).aslProgress).toEqual(before);
    expect(
      (await snapshot(chat)).pictureSharing.participants.find(
        (p: any) => p.id === chat.b.actor.userId,
      ),
    ).toHaveProperty("url");
    chat.room = chat.f.rooms.restart(`charoo:${chat.roomId}`);
    expect((await snapshot(chat, chat.b)).pictureSharing.self.decision).toBe(
      "approved",
    );
  });

  it("notifies both at ten each when only one has a picture, without inventing a missing picture", async () => {
    const chat = await quickChat();
    await addPicture(chat.f, chat.a);
    await makeEligible(chat);
    expect((await snapshot(chat)).pictureSharing).toMatchObject({
      eligible: true,
      self: { hasPicture: true },
    });
    const b = await snapshot(chat, chat.b);
    expect(b.pictureSharing).toMatchObject({
      eligible: true,
      self: { hasPicture: false },
      participants: [],
    });
    expect(await share(chat, chat.b, "approved")).toMatchObject({ ok: false });
    expect((await snapshot(chat)).pictureSharing.participants).toEqual([]);
  });

  it("does not let a stale picture prompt approve a replacement picture", async () => {
    const chat = await quickChat();
    const original = await addPicture(chat.f, chat.a);
    await makeEligible(chat);
    const prompt = (await snapshot(chat)).pictureSharing.self;
    expect(prompt.pictureId).toBe(original.id);
    await addPicture(chat.f, chat.a, 11);
    expect(
      await chat.room.command(chat.a.actor, "picture.share", {
        decision: "approved",
        pictureId: prompt.pictureId,
      }),
    ).toMatchObject({ ok: false });
    expect((await snapshot(chat, chat.b)).pictureSharing.participants).toEqual(
      [],
    );
    unwrap(await share(chat, chat.a, "approved"));
    const previousUrl = (
      await snapshot(chat, chat.b)
    ).pictureSharing.participants.find(
      (p: any) => p.id === chat.a.actor.userId,
    ).url;
    await addPicture(chat.f, chat.a, 13);
    const response = await http(
      chat.f,
      `/rooms/${chat.roomId}/pictures/${chat.a.actor.userId}/content`,
      chat.b,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    unwrap(await share(chat, chat.a, "approved"));
    const latestUrl = (
      await snapshot(chat, chat.b)
    ).pictureSharing.participants.find(
      (p: any) => p.id === chat.a.actor.userId,
    ).url;
    expect(latestUrl).not.toBe(previousUrl);
    expect((await http(chat.f, previousUrl, chat.b)).status).toBe(409);
    expect((await http(chat.f, latestUrl, chat.b)).status).toBe(200);
  });

  it.each(["leave", "block", "expiry"] as const)(
    "revokes stale approvals and picture retrieval after %s",
    async (revocation) => {
      const chat = await quickChat();
      const picture = await addPicture(chat.f, chat.a);
      await makeEligible(chat);
      unwrap(await share(chat, chat.a, "approved"));
      const path = `/rooms/${chat.roomId}/pictures/${chat.a.actor.userId}/content`;
      expect((await http(chat.f, path, chat.b)).status).toBe(200);
      if (revocation === "leave")
        unwrap(await chat.room.command(chat.a.actor, "leave"));
      if (revocation === "block")
        unwrap(
          await chat.f.app.command(chat.a.actor, "block", {
            targetId: chat.b.actor.userId,
          }),
        );
      if (revocation === "expiry") {
        const state = chat.f.rooms.states.get(`charoo:${chat.roomId}`)!;
        const meta = JSON.parse(
          state.database.prepare("SELECT data FROM charoo_meta").get()!
            .data as string,
        );
        meta.expires_at = iso(Date.now() - 1);
        state.database
          .prepare("UPDATE charoo_meta SET data=?")
          .run(JSON.stringify(meta));
      }
      expect(
        await chat.room.command(chat.a.actor, "picture.share", {
          decision: "approved",
          pictureId: picture.id,
        }),
      ).toMatchObject({ ok: false });
      expect((await http(chat.f, path, chat.b)).status).toBeGreaterThanOrEqual(
        400,
      );
      if (revocation === "leave") {
        const c = await chat.f.guest();
        const matcher = chat.f.matcher.getByName("charoo");
        unwrap(await matcher.match(chat.a.actor));
        const matched = unwrap(await matcher.match(c.actor));
        if (!("roomId" in matched))
          throw new Error("Expected a new quick chat");
        const fresh = unwrap(
          await roomStub(chat.f.env, matched.roomId).command(
            chat.a.actor,
            "snapshot",
          ),
        );
        expect(fresh.aslProgress.every((p: any) => p.count === 0)).toBe(true);
        expect(fresh.pictureSharing).toMatchObject({
          eligible: false,
          self: { decision: "pending" },
          participants: [],
        });
      }
    },
  );

  it("rechecks room access after asynchronous picture storage retrieval", async () => {
    const chat = await quickChat();
    await addPicture(chat.f, chat.a);
    await makeEligible(chat);
    unwrap(await share(chat, chat.a, "approved"));
    const get = chat.f.env.MEDIA.get.bind(chat.f.env.MEDIA);
    vi.spyOn(chat.f.env.MEDIA, "get").mockImplementation(async (key) => {
      const object = await get(key);
      unwrap(
        await chat.f.app.command(chat.a.actor, "block", {
          targetId: chat.b.actor.userId,
        }),
      );
      return object;
    });
    const response = await http(
      chat.f,
      `/rooms/${chat.roomId}/pictures/${chat.a.actor.userId}/content`,
      chat.b,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).not.toBe("image/png");
  });

  it("rechecks owner picture identity after asynchronous storage retrieval", async () => {
    const f = await fixture(),
      owner = await f.guest();
    await addPicture(f, owner);
    const get = f.env.MEDIA.get.bind(f.env.MEDIA);
    vi.spyOn(f.env.MEDIA, "get").mockImplementation(async (key) => {
      const object = await get(key);
      await addPicture(f, owner, 13);
      return object;
    });
    expect((await http(f, "/profile/picture/content", owner)).status).toBe(409);
  });

  it("hides an expired owner's picture before background cleanup", async () => {
    const chat = await quickChat();
    await addPicture(chat.f, chat.a);
    await makeEligible(chat);
    unwrap(await share(chat, chat.a, "approved"));
    await chat.f.db
      .prepare("UPDATE users SET guest_expires_at=? WHERE id=?")
      .bind(iso(Date.now() - 1), chat.a.actor.userId)
      .run();
    expect(
      (
        await http(
          chat.f,
          `/rooms/${chat.roomId}/pictures/${chat.a.actor.userId}/content`,
          chat.b,
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await snapshot(chat, chat.b)).pictureSharing.participants).toEqual(
      [],
    );
  });

  it("rejects outsider picture retrieval and share attempts, and enforces HTTP CSRF", async () => {
    const chat = await quickChat();
    const outsider = await chat.f.guest();
    const picture = await addPicture(chat.f, chat.a);
    await makeEligible(chat);
    unwrap(await share(chat, chat.a, "approved"));
    const path = `/rooms/${chat.roomId}/pictures/${chat.a.actor.userId}/content`;
    expect((await http(chat.f, path)).status).toBe(401);
    expect((await http(chat.f, path, outsider)).status).toBeGreaterThanOrEqual(
      400,
    );
    const sharePath = `/rooms/${chat.roomId}/picture-sharing`;
    expect(
      (
        await http(chat.f, sharePath, outsider, "POST", {
          decision: "approved",
          pictureId: picture.id,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await http(
          chat.f,
          sharePath,
          chat.a,
          "POST",
          { decision: "approved", pictureId: picture.id },
          { "X-CSRF-Token": "" },
        )
      ).status,
    ).toBe(403);
  });
});

describe("FR-12 private profile picture cleanup", () => {
  it("durably deletes every pending image before deleting an expired guest with more than one cleanup batch", async () => {
    const f = await fixture(),
      owner = await f.guest();
    await f.db.exec("PRAGMA foreign_keys=ON");
    for (let i = 0; i < 101; i++) {
      const picture = unwrap(
        await f.app.command(owner.actor, "picture.init", {
          mime: "image/png",
          size: 12,
        }),
      );
      const upload = unwrap(
        await f.app.command(owner.actor, "picture.upload.begin", {
          id: picture.id,
        }),
      );
      await f.env.MEDIA.put(upload.object_key, new Uint8Array(12), {
        httpMetadata: { contentType: "image/png" },
      });
    }
    await f.db
      .prepare("UPDATE users SET guest_expires_at=? WHERE id=?")
      .bind(iso(Date.now() - 1), owner.actor.userId)
      .run();
    for (let pass = 0; pass < 3; pass++) {
      await f.app.cleanup();
      await f.drain();
      const pictures = (
        await f.db.prepare("SELECT data FROM profile_pictures").all()
      ).results;
      const retainedKeys = pictures.flatMap(
        (p: any) => JSON.parse(p.data).keys,
      );
      for (const key of f.media.keys()) expect(retainedKeys).toContain(key);
    }
    expect(f.media.size).toBe(0);
    expect(
      (await f.db.prepare("SELECT * FROM profile_pictures").all()).results,
    ).toHaveLength(0);
    expect(
      await f.db
        .prepare("SELECT * FROM users WHERE id=?")
        .bind(owner.actor.userId)
        .first(),
    ).toBeNull();
  });
});
