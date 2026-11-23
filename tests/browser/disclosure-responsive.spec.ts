import { expect, test, type Page } from "@playwright/test";
import { visualFixture, visualIds } from "./visual-fixture";

const sizes = [
  { width: 320, height: 568 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 667, height: 375 },
  { width: 768, height: 1024 },
  { width: 1440, height: 1000 },
];
const pictureId = "60000000-0000-4000-8000-000000000001";
const roomUrl = `/api/rooms/${visualIds.group}`;

async function navigate(page: Page, name: string) {
  await expect(page.locator(".connection")).toHaveText("Online");
  const menu = page.getByRole("button", { name: "Toggle menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  const button = page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("button", { name, exact: true });
  await expect(button).toBeAttached();
  await button.click();
}
async function noOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
}
async function pictures(page: Page) {
  await page.route("**/api/profile/picture/content*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="360"><rect width="120" height="360" fill="#ddd1eb"/><circle cx="60" cy="60" r="30" fill="#765d8d"/></svg>',
    }),
  );
  await page.route("**/api/rooms/*/pictures/*/content*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="160"><rect width="640" height="160" fill="#d2eadc"/><circle cx="320" cy="80" r="60" fill="#567b66"/></svg>',
    }),
  );
}

for (const viewport of sizes) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`quick-chat milestones, pictures and peek stay usable at ${size}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize(viewport);
    await visualFixture(context);
    await pictures(page);
    const pictureId = "60000000-0000-4000-8000-000000000001";
    const room = {
      id: visualIds.group,
      type: "STRANGER",
      state: "OPEN",
      online: 2,
      title: "Quick chat",
      asl_revealed: true,
      participants: [
        { id: visualIds.user, name: "Stranger", asl: null },
        {
          id: visualIds.peer,
          name: "Stranger",
          asl: { age: 31, gender: "Woman", region: "Metro Manila" },
        },
      ],
      aslProgress: [
        { id: visualIds.user, count: 12 },
        { id: visualIds.peer, count: 12 },
      ],
      pictureProgress: [
        { id: visualIds.user, count: 10 },
        { id: visualIds.peer, count: 10 },
      ],
      thresholds: { aslWords: 10, pictureMessages: 10 },
      caps: { words: 20, messages: 50 },
      pictureReveal: {
        eligible: true,
        participants: [
          {
            id: visualIds.peer,
            url: `${roomUrl}/pictures/${visualIds.peer}/content?pictureId=${pictureId}`,
          },
        ],
      },
      peek: {
        price: 10,
        purchased: false,
        available: false,
        revealsAsl: false,
        revealsPicture: false,
      },
    };
    await page.route("**/api/match", (route) =>
      route.fulfill({ json: { roomId: room.id } }),
    );
    await page.route(`**${roomUrl}`, (route) => route.fulfill({ json: room }));
    await page.goto("/");
    await navigate(page, "Quick chat");
    await page.getByRole("button", { name: "Find a conversation" }).click();
    const card = page.getByLabel("Quick chat disclosure", { exact: true });
    await expect(card).toContainText(
      "Profile pictures are shown in this chat.",
    );
    await expect(
      page.getByLabel("Quick chat progress", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByAltText("Your partner’s profile picture", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Show my profile picture" }),
    ).toHaveCount(0);
    await noOverflow(page);
  });

  test(`profile picture upload and long errors fit at ${size}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize(viewport);
    await visualFixture(context);
    await pictures(page);
    await page.route("**/api/profile/picture", (route) =>
      route.fulfill({
        json: {
          picture: { id: pictureId, url: "/api/profile/picture/content" },
          uploadAvailable: true,
        },
      }),
    );
    const error = `Picture unavailable. ${"A".repeat(180)}`;
    await page.route("**/api/profile/picture/init", (route) =>
      route.fulfill({ status: 503, json: { error } }),
    );
    await page.goto("/");
    await navigate(page, "Your profile");
    const panel = page.locator(".profile-status");
    await expect(panel).toBeVisible();
    await noOverflow(page);
    const preview = page.getByAltText("Your private profile picture");
    await expect(preview).toHaveJSProperty("naturalHeight", 360);
    const bounds = await preview.boundingBox();
    // The identity avatar intentionally crops the full image into its square.
    expect(bounds!.height / bounds!.width).toBeCloseTo(1, 0);
    const avatar = page.getByRole("button", {
      name: "Change profile picture",
      exact: true,
    });
    const avatarBounds = (await avatar.boundingBox())!;
    expect(avatarBounds.height).toBeGreaterThanOrEqual(44);
    expect(avatarBounds.width).toBeGreaterThanOrEqual(44);
    await expect(
      page
        .locator(".profile-status")
        .getByRole("group", { name: "Profile picture avatar", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".profile-picture-settings")).toHaveCount(0);
    const picker = page.getByLabel("Replace profile picture");
    await picker.setInputFiles({
      name: `${"long-picture-name".repeat(8)}.png`,
      mimeType: "image/png",
      buffer: Buffer.from([1, 2, 3, 4]),
    });
    await expect(panel.getByRole("alert")).toHaveText(error);
    expect(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
      true,
    );
    await panel.getByRole("alert").scrollIntoViewIfNeeded();
    await expect(picker).toBeEnabled();
    await noOverflow(page);
  });
}
