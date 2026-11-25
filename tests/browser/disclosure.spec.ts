import { expect, test, type Page } from "@playwright/test";
import { QUICK_CHAT_ASL_WORDS, defaultSettings } from "@charoo/contracts";
import { visualFixture, visualIds } from "./visual-fixture";

const roomUrl = `/api/rooms/${visualIds.group}`;
const PICTURE_MESSAGES = 10;
const peerPictureId = "60000000-0000-4000-8000-000000000001";
// Quick-chat snapshot shape (FR-12 milestones, FR-13 peek). Counts are per participant.
function snapshot(
  options: {
    words?: number;
    messages?: number;
    pictures?: boolean;
    peekAvailable?: boolean;
    purchased?: boolean;
  } = {},
) {
  const words = options.words ?? 0;
  const messages = options.messages ?? 0;
  const aslOn = words >= QUICK_CHAT_ASL_WORDS;
  const profileOn = messages >= PICTURE_MESSAGES;
  const purchased = options.purchased ?? false;
  const peerPicture = {
    id: visualIds.peer,
    url: `${roomUrl}/pictures/${visualIds.peer}/content?pictureId=${peerPictureId}`,
  };
  const showPicture = profileOn || purchased;
  return {
    id: visualIds.group,
    type: "STRANGER",
    title: "Quick chat",
    state: "OPEN",
    online: 2,
    asl_revealed: aslOn,
    participants: [
      { id: visualIds.user, name: "Stranger", verified: true, asl: null },
      {
        id: visualIds.peer,
        name: "Stranger",
        verified: true,
        asl:
          aslOn || purchased
            ? { age: 31, gender: "Woman", region: "Manila" }
            : null,
      },
    ],
    aslProgress: [
      { id: visualIds.user, count: words },
      { id: visualIds.peer, count: words },
    ],
    pictureProgress: [
      { id: visualIds.user, count: messages },
      { id: visualIds.peer, count: messages },
    ],
    thresholds: {
      aslWords: QUICK_CHAT_ASL_WORDS,
      pictureMessages: PICTURE_MESSAGES,
    },
    caps: { words: 20, messages: 50 },
    pictureReveal: {
      eligible: profileOn,
      participants:
        options.pictures === false || !showPicture ? [] : [peerPicture],
    },
    peek: {
      price: defaultSettings.credits_peek_price,
      purchased,
      available: !!options.peekAvailable && !purchased,
      revealsAsl: !purchased && !aslOn,
      revealsPicture: !purchased && !profileOn,
    },
  };
}

async function servePictures(page: Page) {
  await page.route("**/api/profile/picture/content*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="16" fill="#e8dbca"/><circle cx="64" cy="46" r="20" fill="#8d765d"/><path d="M25 120c0-46 78-46 78 0" fill="#8d765d"/></svg>',
    }),
  );
  await page.route(`**${roomUrl}/pictures/**`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="16" fill="#d2eadc"/><circle cx="64" cy="46" r="20" fill="#4f6b5a"/></svg>',
    }),
  );
}

async function openQuickChat(page: Page) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("button", { name: "Quick chat", exact: true })
    .click();
  await page.getByRole("button", { name: "Find a conversation" }).click();
  await expect(page.locator(".chat")).toBeVisible();
}

// Credits enabled for this user, so the peek affordance and balance load.
async function enableCredits(page: Page, balance: number) {
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: {
        user: {
          id: visualIds.user,
          displayName: "Cora Lane",
          verified: true,
          role: "USER",
          profile: {
            displayName: "Cora Lane",
            age: 31,
            gender: "Woman",
            region: "Manila",
            bio: "",
            interests: [],
            aslVisibility: "public",
          },
          status: "Online",
        },
        csrf: "visual-csrf",
        settings: { ...defaultSettings, credits_enabled: true },
        credits: { enabled: true, balance, dailyClaimable: false },
      },
    }),
  );
  await page.route("**/api/credits", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        enabled: true,
        balance,
        lifetimeEarned: balance,
        lifetimeSpent: 0,
        contactSlots: {
          used: 0,
          limit: 10,
          base: 10,
          extra: 0,
          max: 50,
          pack: 5,
          price: 15,
        },
        daily: { claimable: false, streak: 0, amount: 0 },
        peekPrice: defaultSettings.credits_peek_price,
        reconnectPrice: 3,
        packs: [],
      },
    });
  });
}

test("word and message bars track their separate milestones", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  const room = snapshot({ words: 9, messages: 4 });
  await page.route("**/api/match", (route) =>
    route.fulfill({ json: { roomId: room.id } }),
  );
  await page.route(`**${roomUrl}`, (route) => route.fulfill({ json: room }));
  await openQuickChat(page);
  const progress = page.getByLabel("Quick chat progress", { exact: true });
  await expect(progress).toContainText("10 each unlocks age, sex and location");
  await expect(progress).toContainText("10 each shows profile pictures");
  await expect(
    page.getByRole("progressbar", { name: "Words: You" }),
  ).toHaveAttribute("aria-valuenow", "9");
  await expect(
    page.getByRole("progressbar", { name: "Messages: Stranger" }),
  ).toHaveAttribute("aria-valuenow", "4");
  await expect(page.locator(".quick-chat-disclosure")).toHaveCount(0);
});

test("profile pictures appear at ten messages each with no consent prompt", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  await servePictures(page);
  const room = snapshot({ words: 12, messages: PICTURE_MESSAGES });
  await page.route("**/api/match", (route) =>
    route.fulfill({ json: { roomId: room.id } }),
  );
  await page.route(`**${roomUrl}`, (route) => route.fulfill({ json: room }));
  await openQuickChat(page);
  await expect(
    page.getByAltText("Your partner’s profile picture", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Show my profile picture" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Not now", exact: true }),
  ).toHaveCount(0);
});

test("a paid peek keeps its spinner until the refetched chat confirms the reveal", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  await servePictures(page);
  await enableCredits(page, 40);
  const before = snapshot({ words: 3, messages: 2, peekAvailable: true });
  const after = snapshot({ words: 3, messages: 2, purchased: true });
  let purchased = false;
  await page.route("**/api/match", (route) =>
    route.fulfill({ json: { roomId: before.id } }),
  );
  await page.route(`**${roomUrl}`, (route) =>
    route.fulfill({ json: purchased ? after : before }),
  );
  let peekBodies: unknown[] = [];
  await page.route(`**${roomUrl}/peek`, async (route) => {
    peekBodies.push(route.request().postDataJSON());
    // The chat only changes once the reveal has been fetched again.
    purchased = true;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return route.fulfill({
      json: { purchased: true, charged: 10, balance: 30 },
    });
  });
  await openQuickChat(page);
  const panel = page.locator(".peek-panel");
  await expect(panel).toContainText("Peek now for 10 credits.");
  await expect(panel).toContainText(
    "age, sex and location and their profile picture",
  );
  await page.getByRole("button", { name: "Peek for 10 credits" }).click();
  await expect(panel.getByRole("status")).toContainText("Revealing");
  await expect(panel.locator(".peek-spinner")).toBeVisible();
  await expect(panel).toContainText("You peeked at");
  await expect(panel.locator(".peek-spinner")).toHaveCount(0);
  expect(peekBodies).toEqual([{ revealsAsl: true, revealsPicture: true }]);
  await expect(
    page.getByAltText("Your partner’s profile picture", { exact: true }),
  ).toBeVisible();
});

test("a low balance points to credits instead of charging", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  await enableCredits(page, 3);
  const room = snapshot({ words: 3, messages: 2, peekAvailable: true });
  await page.route("**/api/match", (route) =>
    route.fulfill({ json: { roomId: room.id } }),
  );
  await page.route(`**${roomUrl}`, (route) => route.fulfill({ json: room }));
  await openQuickChat(page);
  await expect(page.locator(".peek-panel")).toContainText(
    "You need 7 more credits to peek.",
  );
  await expect(
    page.getByRole("button", { name: "Peek for 10 credits" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Get credits", exact: true }),
  ).toBeVisible();
});

test("profile picture upload waits for approval and restores the private preview", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  const pictureId = "60000000-0000-4000-8000-000000000001";
  let saved = false;
  const operations: string[] = [];
  await page.route("**/api/profile/picture/content**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#ddd1eb"/></svg>',
    }),
  );
  await page.route("**/api/profile/picture", (route) =>
    route.fulfill({
      json: {
        picture: saved
          ? { id: pictureId, url: "/api/profile/picture/content" }
          : null,
        uploadAvailable: true,
      },
    }),
  );
  await page.route("**/api/profile/picture/init", (route) => {
    operations.push("init");
    expect(route.request().postDataJSON()).toEqual({
      mime: "image/png",
      size: 4,
    });
    return route.fulfill({
      json: { id: pictureId, url: `/api/profile/picture/${pictureId}/upload` },
    });
  });
  await page.route(`**/api/profile/picture/${pictureId}/upload`, (route) => {
    operations.push("upload");
    expect(route.request().headers()["x-csrf-token"]).toBe("visual-csrf");
    expect(route.request().headers()["content-type"]).toBe("image/png");
    return route.fulfill({ status: 204 });
  });
  await page.route(`**/api/profile/picture/${pictureId}/complete`, (route) => {
    operations.push("approve");
    saved = true;
    return route.fulfill({ json: { id: pictureId, state: "APPROVED" } });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("button", { name: "Your profile", exact: true })
    .click();
  await page.getByLabel("Add profile picture").setInputFiles({
    name: "picture.png",
    mimeType: "image/png",
    buffer: Buffer.from([1, 2, 3, 4]),
  });
  await expect(
    page.getByText(
      "Profile picture saved. You choose whether to share it in each quick chat.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByAltText("Your private profile picture"),
  ).toHaveAttribute("src", `/api/profile/picture/content?v=${pictureId}`);
  expect(operations).toEqual(["init", "upload", "approve"]);
});

test("private profile picture preview can be retried after it fails to load", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  const pictureId = "60000000-0000-4000-8000-000000000001";
  let attempts = 0;
  await page.route("**/api/profile/picture", (route) =>
    route.fulfill({
      json: {
        picture: { id: pictureId, url: "/api/profile/picture/content" },
        uploadAvailable: false,
      },
    }),
  );
  await page.route("**/api/profile/picture/content**", (route) => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503 });
    return route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#ddd1eb"/></svg>',
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("button", { name: "Your profile", exact: true })
    .click();

  const panel = page.getByLabel("Your profile picture", { exact: true });
  await expect(
    panel.getByText("Couldn’t load your picture preview.", { exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    panel.getByAltText("Your private profile picture"),
  ).toHaveJSProperty("naturalHeight", 80);
  expect(attempts).toBe(2);
});

test("a rejected picture upload keeps the existing picture and allows retry", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  const pictureId = "60000000-0000-4000-8000-000000000001";
  await page.route("**/api/profile/picture/content**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#ddd1eb"/></svg>',
    }),
  );
  await page.route("**/api/profile/picture", (route) =>
    route.fulfill({
      json: {
        picture: { id: pictureId, url: "/api/profile/picture/content" },
        uploadAvailable: true,
      },
    }),
  );
  await page.route("**/api/profile/picture/init", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Picture upload is temporarily unavailable" },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("button", { name: "Your profile", exact: true })
    .click();
  await page.getByLabel("Replace profile picture").setInputFiles({
    name: "picture.png",
    mimeType: "image/png",
    buffer: Buffer.from([1, 2, 3, 4]),
  });
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Picture upload is temporarily unavailable" }),
  ).toHaveText("Picture upload is temporarily unavailable");
  await expect(page.getByAltText("Your private profile picture")).toBeVisible();
  await expect(page.getByLabel("Replace profile picture")).toBeEnabled();
});

test("message history displays the quoted sender and reply text", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  await page.route(`**/api/rooms/${visualIds.group}/messages`, (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            id: "40000000-0000-4000-8000-000000000004",
            roomId: visualIds.group,
            senderId: visualIds.user,
            name: "Cora Lane",
            text: "That sounds good to me.",
            createdAt: "2026-11-17T00:00:00.000Z",
            clientMessageId: "50000000-0000-4000-8000-000000000004",
            replyTo: "40000000-0000-4000-8000-000000000003",
            replyPreview: {
              id: "40000000-0000-4000-8000-000000000003",
              senderId: visualIds.peer,
              name: "Milo Hart",
              text: "Would you like to meet at the coffee shop?",
            },
            attachmentId: null,
            reactions: {},
          },
        ],
        next: null,
      },
    }),
  );
  await page.goto("/");
  await page
    .locator(".sidebar-rooms")
    .getByRole("button", { name: "Coffee with friends", exact: true })
    .click();

  const message = page
    .locator(".messages .message")
    .filter({ hasText: "That sounds good to me." });
  await expect(message.locator(".message-quote strong")).toHaveText(
    "Milo Hart",
  );
  await expect(message.locator(".message-quote span")).toHaveText(
    "Would you like to meet at the coffee shop?",
  );
});
