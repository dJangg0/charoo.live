import { test, expect } from "@playwright/test";
import { identity, json, withPicture } from "./session";

// End-to-end reconnect over the API on the real Celld runtime: one person leaves a quick chat
// with Next, the other requests a reconnect from their archive, and the first accepts.
test("reconnect after the other person hits Next completes end to end", async ({
  browser,
}) => {
  const a = await withPicture(await identity(browser));
  const b = await withPicture(await identity(browser));
  try {
    // Match: A queues, B is matched into the quick chat.
    await json(await a.api("/match", "POST", {}), "A queues");
    const matched = await json(await b.api("/match", "POST", {}), "B matches");
    expect(matched.roomId, JSON.stringify(matched)).toBeTruthy();
    const quickRoom = matched.roomId as string;

    // Both talk a little.
    for (const [who, text] of [
      [a, "hello from A"],
      [b, "hello from B"],
    ] as const)
      await json(
        await who.api(`/rooms/${quickRoom}/messages`, "POST", {
          text,
          clientMessageId: crypto.randomUUID(),
        }),
        "quick chat message",
      );

    // A hits Next. This archives the quick chat for B, the one who stays.
    const left = await a.api(`/rooms/${quickRoom}/leave`, "POST", {
      next: true,
    });
    expect(left.ok(), `A Next: ${left.status()} ${await left.text()}`).toBe(
      true,
    );

    // B's history lists A with a reconnect-eligible archive.
    const history = await json<any[]>(
      await b.api("/quick-chat-history"),
      "B history",
    );
    const entry = history.find((row) => row.id === a.id);
    expect(
      entry,
      `archive for A in B's history: ${JSON.stringify(history)}`,
    ).toBeTruthy();
    expect(entry.archive_id).toBe(quickRoom);
    expect(entry.reconnectable).toBeTruthy();

    // B asks to reconnect from that exact archive.
    const requested = await b.api("/requests", "POST", {
      targetId: a.id,
      kind: "RECONNECT",
      roomId: entry.archive_id,
    });
    expect(
      requested.status(),
      `B reconnect request: ${requested.status()} ${await requested.text()}`,
    ).toBe(201);

    // A sees the request and accepts.
    const incoming = await json<any[]>(await a.api("/requests"), "A requests");
    const request = incoming.find(
      (row) => row.kind === "RECONNECT" && row.requester_id === b.id,
    );
    expect(
      request,
      `A sees B's reconnect: ${JSON.stringify(incoming)}`,
    ).toBeTruthy();
    const accepted = await json<any>(
      await a.api(`/requests/${request.id}/respond`, "POST", { accept: true }),
      "A accepts",
    );
    expect(accepted.accepted).toBe(true);
    const privateRoom = accepted.roomId as string;
    expect(privateRoom).toBeTruthy();

    // Both can open the private room and exchange messages in it.
    for (const who of [a, b]) {
      const room = await json<any>(
        await who.api(`/rooms/${privateRoom}`),
        "open private room",
      );
      expect(room.type).toBe("PRIVATE");
    }
    await json(
      await b.api(`/rooms/${privateRoom}/messages`, "POST", {
        text: "so good to reconnect",
        clientMessageId: crypto.randomUUID(),
      }),
      "B writes in private room",
    );
    const messages = await json<any>(
      await a.api(`/rooms/${privateRoom}/messages`),
      "A reads private room",
    );
    expect(messages.messages.map((m: { text: string }) => m.text)).toContain(
      "so good to reconnect",
    );

    // The request is consumed: a second accept gets the same room, not a new one.
    const again = await json<any>(
      await a.api(`/requests/${request.id}/respond`, "POST", { accept: true }),
      "A accepts again",
    );
    expect(again.roomId).toBe(privateRoom);
  } finally {
    // Leave no queued entry behind for later specs sharing this runtime.
    await a.api("/match", "DELETE");
    await a.context.close();
    await b.context.close();
  }
});
