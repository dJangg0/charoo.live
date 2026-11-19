import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import type { Message } from "@charoo/contracts";
import { visualFixture, visualIds } from "./visual-fixture";

const room = {
  id: visualIds.group,
  title: "Coffee with friends",
  type: "PRIVATE",
  online: 2,
  version: 1,
  participants: [
    { id: visualIds.user, name: "Cora Lane" },
    { id: visualIds.peer, name: "Milo Hart" },
  ],
};
const roomPath = `/api/rooms/${room.id}`;

function message(id: string, text: string, senderId = visualIds.peer): Message {
  return {
    id,
    roomId: room.id,
    senderId,
    name: senderId === visualIds.peer ? "Milo Hart" : "Cora Lane",
    text,
    createdAt: "2026-11-19T08:00:00.000Z",
    clientMessageId: `${id}-client`,
    replyTo: null,
    attachmentId: null,
    reactions: {},
    readBy: [],
  };
}

async function enterRoom(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: room.title, exact: true }).click();
  await expect(page.getByRole("heading", { name: room.title })).toBeVisible();
  await expect(page.getByRole("status", { name: "Online" })).toBeVisible();
}

test.beforeEach(async ({ page, context }) => {
  await visualFixture(context, true, { mockSockets: false });
  await page.routeWebSocket("**/api/events/socket", () => {});
  await page.clock.install();
});

test("presence failures leave a healthy room online without chat polling", async ({
  page,
}) => {
  let heartbeats = 0;
  let historyReads = 0;
  let receipts = 0;
  await page.routeWebSocket(`**${roomPath}/socket`, () => {});
  await page.route(`**${roomPath}`, (route) => route.fulfill({ json: room }));
  await page.route(`**${roomPath}/messages`, (route) => {
    historyReads++;
    return route.fulfill({
      json: { messages: [message("first", "Hello there")], next: null },
    });
  });
  await page.route(`**${roomPath}/read`, (route) => {
    receipts++;
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/presence", (route) => {
    const status = [200, 429, 503][heartbeats++] ?? 200;
    return route.fulfill({
      status,
      json:
        status === 200 ? { status: "Online" } : { error: "Try again shortly" },
    });
  });

  await enterRoom(page);
  await expect.poll(() => receipts).toBe(1);
  for (const status of [429, 503, 200]) {
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/presence") && r.status() === status,
    );
    await page.clock.runFor(25_000);
    await (await response).finished();
    await page.clock.runFor(100);
  }
  await page.clock.runFor(6_000);
  expect(heartbeats).toBe(4);
  await expect(page.getByRole("status", { name: "Online" })).toBeVisible();
  await expect(page.getByText("Hello there", { exact: true })).toBeVisible();
  expect(historyReads).toBe(1);
  expect(receipts).toBe(1);
});

test("duplicate message signals share a refresh and a newer message gets one follow-up", async ({
  page,
}) => {
  let socket!: WebSocketRoute;
  let historyReads = 0;
  let roomReads = 0;
  let receipts = 0;
  let otherRoomReads = 0;
  let messages = [message("first", "Hello there")];
  let releaseHistory!: () => void;
  const heldHistory = new Promise<void>(
    (resolve) => (releaseHistory = resolve),
  );
  const sendEvent = (type: string, payload?: unknown, roomId = room.id) =>
    socket.send(JSON.stringify({ type, roomId, payload }));
  await page.routeWebSocket(`**${roomPath}/socket`, (route) => {
    socket = route;
  });
  await page.route(`**${roomPath}`, (route) => {
    roomReads++;
    return route.fulfill({ json: room });
  });
  await page.route(`**/api/rooms/${visualIds.contact}/**`, (route) => {
    otherRoomReads++;
    return route.fallback();
  });
  await page.route(`**${roomPath}/read`, (route) => {
    receipts++;
    sendEvent("read", { userId: visualIds.user });
    return route.fulfill({ status: 204 });
  });
  await page.route(`**${roomPath}/messages`, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      const sent = {
        ...message("sent", body.text, visualIds.user),
        clientMessageId: body.clientMessageId,
      };
      messages = [...messages, sent];
      sendEvent("message", { id: sent.id });
      return route.fulfill({ status: 201, json: { id: sent.id } });
    }
    const snapshot = messages;
    if (++historyReads === 2) await heldHistory;
    return route.fulfill({ json: { messages: snapshot, next: null } });
  });

  await enterRoom(page);
  await expect.poll(() => receipts).toBe(1);
  try {
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("An outgoing message");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect.poll(() => historyReads).toBe(2);
    for (let n = 0; n < 5; n++) sendEvent("message", { id: "sent" });
    messages = [...messages, message("later", "Arrived during the refresh")];
    sendEvent("message", { id: "later" });
    sendEvent("message", { id: "later" });
    sendEvent("room.changed", undefined, visualIds.contact);
    await page.clock.runFor(100);
    expect(historyReads).toBe(2);
    expect(roomReads).toBe(2);
  } finally {
    releaseHistory();
  }

  await expect(
    page.getByText("Arrived during the refresh", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => receipts).toBe(2);
  await page.clock.runFor(100);
  expect(historyReads).toBe(3);
  expect(roomReads).toBe(3);
  expect(otherRoomReads).toBe(0);
  await expect(
    page.getByText("An outgoing message", { exact: true }),
  ).toHaveCount(1);

  messages = messages.map((m) =>
    m.id === "sent" ? { ...m, readBy: [visualIds.peer] } : m,
  );
  sendEvent("read", { userId: visualIds.peer });
  await expect(
    page.locator(".message.own").getByText("Seen", { exact: true }),
  ).toBeVisible();
  expect(historyReads).toBe(4);
  expect(roomReads).toBe(3);
  expect(receipts).toBe(2);
});

test("room fallback skips slow reads and honors rate-limit cooldown through socket recovery", async ({
  page,
}) => {
  let socket!: WebSocketRoute;
  let allowRoomSocket = true;
  let historyReads = 0;
  let roomReads = 0;
  let releaseRoom!: () => void;
  const heldRoom = new Promise<void>((resolve) => (releaseRoom = resolve));
  await page.routeWebSocket(`**${roomPath}/socket`, (route) => {
    if (allowRoomSocket) socket = route;
    else void route.close({ code: 1011 });
  });
  await page.route(`**${roomPath}`, async (route) => {
    if (++roomReads === 2) await heldRoom;
    return route.fulfill({ json: room });
  });
  await page.route(`**${roomPath}/messages`, (route) => {
    if (++historyReads === 2)
      return route.fulfill({
        status: 429,
        headers: { "Retry-After": "40" },
        json: { error: "Too many requests; try again shortly" },
      });
    return route.fulfill({
      json: {
        messages: [
          { ...message("first", "Hello there"), readBy: [visualIds.user] },
          ...(historyReads > 2
            ? [message("recovered", "Caught up after reconnecting")]
            : []),
        ],
        next: null,
      },
    });
  });

  await enterRoom(page);
  allowRoomSocket = false;
  await socket.close({ code: 1011 });
  await expect(
    page.getByRole("status", { name: "Reconnecting" }),
  ).toBeVisible();
  try {
    await page.clock.runFor(5_100);
    await expect.poll(() => historyReads).toBe(2);
    await expect.poll(() => roomReads).toBe(2);
    await page.clock.runFor(15_000);
    expect(historyReads).toBe(2);
    expect(roomReads).toBe(2);
    await expect(page.getByText("Hello there", { exact: true })).toBeVisible();
  } finally {
    releaseRoom();
  }
  await expect(page.getByRole("alert")).toContainText("Too many requests");
  allowRoomSocket = true;
  await page.clock.runFor(25_000);
  await expect(page.getByRole("status", { name: "Online" })).toBeVisible();
  expect(historyReads).toBe(2);
  expect(roomReads).toBe(2);

  await page.clock.runFor(18_000);
  await expect(
    page.getByText("Caught up after reconnecting", { exact: true }),
  ).toBeVisible();
  await page.clock.runFor(10_000);
  expect(historyReads).toBe(3);
  expect(roomReads).toBe(3);
});
