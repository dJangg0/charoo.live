import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QUICK_CHAT_ASL_WORDS,
  QUICK_CHAT_MESSAGE_CAP,
  QUICK_CHAT_WORD_CAP,
  defaultSettings,
} from "@charoo/contracts";
import { app } from "../celld/http/app";
import { iso, roomStub, type Actor } from "../celld/shared/data";
import { unwrap } from "../celld/shared/errors";
import {
  addApprovedPicture as addPicture,
  fixture,
  matchableGuest,
} from "./runtime";

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
    a = await matchableGuest(f),
    b = await matchableGuest(f),
    matcher = f.matcher.getByName("charoo");
  unwrap(await matcher.match(a.actor));
  const match = unwrap(await matcher.match(b.actor));
  if (!("roomId" in match)) throw new Error("Expected a quick chat");
  const roomId = match.roomId as string;
  return { f, a, b, roomId, room: roomStub(f.env, roomId) };
}
type Chat = Awaited<ReturnType<typeof quickChat>>;

let sequence = 0;
// One message per call, each with a distinct word so it is never a duplicate.
async function send(chat: Chat, owner: Guest, count: number) {
  for (let i = 0; i < count; i++) {
    unwrap(
      await chat.room.command(owner.actor, "message", {
        text: `word${++sequence}`,
        clientMessageId: crypto.randomUUID(),
      }),
    );
  }
}
// One message containing `words` distinct words.
async function longMessage(chat: Chat, owner: Guest, words: number) {
  const text = Array.from(
    { length: words },
    (_, i) => `term${++sequence}x${i}`,
  ).join(" ");
  unwrap(
    await chat.room.command(owner.actor, "message", {
      text,
      clientMessageId: crypto.randomUUID(),
    }),
  );
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
async function setThreshold(f: Fixture, key: string, value: number) {
  await f.db
    .prepare("UPDATE settings SET value=json_set(value,?,?) WHERE id=1")
    .bind(`$.${key}`, value)
    .run();
}
// Simulates counts saved before counts_version existed, forcing a recount from history.
function stripCounts(chat: Chat) {
  const state = chat.f.rooms.states.get(`charoo:${chat.roomId}`)!;
  state.database.exec(
    "UPDATE charoo_participants SET data=json_remove(data,'$.word_count','$.word_cap','$.message_count','$.counts_version'); DELETE FROM charoo_fingerprints",
  );
  chat.room = chat.f.rooms.restart(`charoo:${chat.roomId}`);
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
// The profile milestone: both participants have sent ten distinct messages.
async function makeProfileEligible(chat: Chat, count = 10) {
  await send(chat, chat.a, count);
  await send(chat, chat.b, count);
}

describe("FR-12 quick-chat disclosure", () => {
  it("defaults the ASL word threshold to ten and the profile reveal to ten messages, with caps", () => {
    expect(QUICK_CHAT_ASL_WORDS).toBe(10);
    expect(QUICK_CHAT_WORD_CAP).toBe(20);
    expect(QUICK_CHAT_MESSAGE_CAP).toBe(50);
    expect(defaultSettings.quickchat_asl_word_threshold).toBe(10);
    expect(defaultSettings.quickchat_picture_message_threshold).toBe(10);
  });

  it("shows ASL at ten words each while the profile reveal waits for ten messages each", async () => {
    const chat = await quickChat();
    await setProfile(chat.f, chat.a.actor, "public");
    await setProfile(chat.f, chat.b.actor, "public");
    await longMessage(chat, chat.a, 10);
    await longMessage(chat, chat.b, 10);
    const current = await snapshot(chat, chat.b);
    expect(current.asl_revealed).toBe(true);
    expect(
      current.participants.find((p: any) => p.id === chat.a.actor.userId).asl,
    ).not.toBeNull();
    expect(current.pictureReveal).toMatchObject({
      eligible: false,
      participants: [],
    });
    expect(current.aslProgress.map((p: any) => p.count)).toEqual([10, 10]);
    expect(current.pictureProgress.map((p: any) => p.count)).toEqual([1, 1]);
  });

  it("does not reveal ASL at nine words, and the profile reveal does not follow words alone", async () => {
    const chat = await quickChat();
    await addPicture(chat.f, chat.a);
    await addPicture(chat.f, chat.b, 8);
    await setProfile(chat.f, chat.a.actor, "public");
    await longMessage(chat, chat.a, 9);
    await longMessage(chat, chat.b, 20);
    const current = await snapshot(chat);
    expect(current.asl_revealed).toBe(false);
    expect(current.participants.every((p: any) => p.asl === null)).toBe(true);
    expect(current.pictureReveal.eligible).toBe(false);
    expect(current.pictureReveal.participants).toEqual([]);
  });

  it("reveals each owner's current approved picture at ten messages each without a consent step", async () => {
    const chat = await quickChat();
    const pictureA = await addPicture(chat.f, chat.a, 3);
    const pictureB = await addPicture(chat.f, chat.b, 4);
    await makeProfileEligible(chat, 9);
    expect((await snapshot(chat)).pictureReveal.eligible).toBe(false);
    await send(chat, chat.a, 1);
    expect((await snapshot(chat)).pictureReveal.eligible).toBe(false);
    await send(chat, chat.b, 1);
    for (const viewer of [chat.a, chat.b]) {
      const current = await snapshot(chat, viewer);
      expect(current.pictureReveal.eligible).toBe(true);
      const other = viewer === chat.a ? chat.b : chat.a;
      const otherPicture = other === chat.a ? pictureA : pictureB;
      const shown = current.pictureReveal.participants.find(
        (p: any) => p.id === other.actor.userId,
      );
      expect(shown.url).toContain(`pictureId=${otherPicture.id}`);
      expect(current.pictureReveal.participants).toHaveLength(1);
    }
    expect(
      (
        await chat.room.command(chat.b.actor, "picture.download", {
          userId: chat.a.actor.userId,
        })
      ).ok,
    ).toBe(true);
  });

  it("does not count duplicate, emoji-only, numeric-only or punctuation-only messages toward the profile reveal", async () => {
    const chat = await quickChat();
    const sendText = (owner: Guest, text: string) =>
      chat.room.command(owner.actor, "message", {
        text,
        clientMessageId: crypto.randomUUID(),
      });
    unwrap(await sendText(chat.a, "Hello there"));
    unwrap(await sendText(chat.a, "  hello   THERE "));
    unwrap(await sendText(chat.a, "🙂🙂🙂"));
    unwrap(await sendText(chat.a, "12345"));
    unwrap(await sendText(chat.a, "!!! ???"));
    const current = await snapshot(chat);
    expect(
      current.pictureProgress.find((p: any) => p.id === chat.a.actor.userId)
        .count,
    ).toBe(1);
    expect(
      current.aslProgress.find((p: any) => p.id === chat.a.actor.userId).count,
    ).toBe(2);
  });

  it("keeps the profile reveal at nine messages each rejected and at ten each accepted", async () => {
    const chat = await quickChat();
    await makeProfileEligible(chat, 9);
    await send(chat, chat.a, 1);
    expect((await snapshot(chat)).pictureReveal.eligible).toBe(false);
    await send(chat, chat.b, 1);
    expect((await snapshot(chat)).pictureReveal.eligible).toBe(true);
  });

  it("keeps counting messages after words reach the word cap, without exceeding the message cap", async () => {
    const chat = await quickChat();
    await longMessage(chat, chat.a, 25);
    await send(chat, chat.a, 10);
    await send(chat, chat.b, 1);
    const current = await snapshot(chat);
    expect(
      current.aslProgress.find((p: any) => p.id === chat.a.actor.userId).count,
    ).toBe(QUICK_CHAT_WORD_CAP);
    expect(
      current.pictureProgress.find((p: any) => p.id === chat.a.actor.userId)
        .count,
    ).toBe(11);
    expect(current.caps).toEqual({
      words: QUICK_CHAT_WORD_CAP,
      messages: QUICK_CHAT_MESSAGE_CAP,
    });
  });

  it("applies a reconfigured profile threshold to an existing quick chat", async () => {
    const chat = await quickChat();
    await makeProfileEligible(chat, 3);
    expect((await snapshot(chat)).pictureReveal.eligible).toBe(false);
    await setThreshold(chat.f, "quickchat_picture_message_threshold", 3);
    const current = await snapshot(chat);
    expect(current.thresholds.pictureMessages).toBe(3);
    expect(current.pictureReveal.eligible).toBe(true);
  });

  it("restores word and message counts from encrypted history after counts are lost", async () => {
    const chat = await quickChat();
    await addPicture(chat.f, chat.a);
    await addPicture(chat.f, chat.b, 5);
    await makeProfileEligible(chat, 10);
    stripCounts(chat);
    const restored = await snapshot(chat, chat.b);
    expect(restored.pictureProgress.map((p: any) => p.count)).toEqual([10, 10]);
    expect(restored.aslProgress.map((p: any) => p.count)).toEqual([10, 10]);
    expect(restored.pictureReveal.eligible).toBe(true);
    // Recounting must not double-count the same history on a second restart.
    stripCounts(chat);
    const again = await snapshot(chat);
    expect(again.pictureProgress.map((p: any) => p.count)).toEqual([10, 10]);
  });

  it("shows no consent prompt and no picture-sharing route remains", async () => {
    const chat = await quickChat();
    await expect(
      chat.room.command(chat.a.actor, "picture.share", {
        decision: "approved",
      }),
    ).rejects.toThrow("Unknown room command");
    expect(
      (
        await http(
          chat.f,
          `/rooms/${chat.roomId}/picture-sharing`,
          chat.a,
          "POST",
          {
            decision: "approved",
          },
        )
      ).status,
    ).toBe(404);
  });

  it("keeps a private ASL subject's picture visible without showing their ASL", async () => {
    const chat = await quickChat();
    await setProfile(chat.f, chat.a.actor, "private");
    await addPicture(chat.f, chat.a);
    await makeProfileEligible(chat);
    await longMessage(chat, chat.b, 10);
    const current = await snapshot(chat, chat.b);
    expect(
      current.participants.find((p: any) => p.id === chat.a.actor.userId).asl,
    ).toBeNull();
    expect(current.pictureReveal.participants).toHaveLength(1);
  });

  it("shows a replaced picture only once it is the owner's current approved picture", async () => {
    const chat = await quickChat();
    const first = await addPicture(chat.f, chat.a, 3);
    await makeProfileEligible(chat);
    const replacement = await addPicture(chat.f, chat.a, 9);
    const current = await snapshot(chat, chat.b);
    const shown = current.pictureReveal.participants.find(
      (p: any) => p.id === chat.a.actor.userId,
    );
    expect(shown.url).toContain(`pictureId=${replacement.id}`);
    expect(shown.url).not.toContain(`pictureId=${first.id}`);
  });

  it("stops picture retrieval for a closed quick chat after leave", async () => {
    const chat = await quickChat();
    await addPicture(chat.f, chat.a);
    await makeProfileEligible(chat);
    unwrap(await chat.room.command(chat.b.actor, "leave"));
    expect(
      (
        await chat.room.command(chat.b.actor, "picture.download", {
          userId: chat.a.actor.userId,
        })
      ).ok,
    ).toBe(false);
  });

  it("starts a new quick chat with fresh progress and no inherited reveal after Next", async () => {
    const chat = await quickChat();
    await addPicture(chat.f, chat.a);
    await makeProfileEligible(chat);
    unwrap(await chat.room.command(chat.b.actor, "leave", { next: true }));
    const third = await matchableGuest(chat.f);
    const matcher = chat.f.matcher.getByName("charoo");
    unwrap(await matcher.match(chat.a.actor));
    const match = unwrap(await matcher.match(third.actor));
    if (!("roomId" in match)) throw new Error("Expected a new quick chat");
    expect(match.roomId).not.toBe(chat.roomId);
    const fresh = unwrap(
      await roomStub(chat.f.env, match.roomId).command(
        chat.a.actor,
        "snapshot",
      ),
    );
    expect(fresh.pictureReveal.eligible).toBe(false);
    expect(fresh.pictureProgress.every((p: any) => p.count === 0)).toBe(true);
  });

  it("rejects outsider picture retrieval and enforces HTTP CSRF on quick-chat writes", async () => {
    const chat = await quickChat();
    const outsider = await chat.f.guest();
    await addPicture(chat.f, chat.a);
    await makeProfileEligible(chat);
    const path = `/rooms/${chat.roomId}/pictures/${chat.a.actor.userId}/content`;
    expect((await http(chat.f, path)).status).toBe(401);
    expect((await http(chat.f, path, outsider)).status).toBeGreaterThanOrEqual(
      400,
    );
    expect(
      (
        await http(
          chat.f,
          `/rooms/${chat.roomId}/messages`,
          chat.a,
          "POST",
          { text: "hello again", clientMessageId: crypto.randomUUID() },
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
