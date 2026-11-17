import { expect, test, type Page } from "@playwright/test";
import { defaultSettings } from "@charoo/contracts";
import { visualFixture, visualIds } from "./visual-fixture";

const viewports = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 1000 },
];

async function openProfile(page: Page) {
  await page.goto("/");
  await expect(page.locator(".connection")).toHaveText("Online");
  const menu = page.getByRole("button", { name: "Toggle menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("button", { name: "Your profile", exact: true })
    .click();
  // Measure the finished layout; separate bounding-box reads during entry
  // animation can otherwise report different ancestor transforms.
  await page.locator(".profile-page").evaluate(async (profile) => {
    const animations = profile
      .getAnimations({ subtree: true })
      .filter((animation) =>
        Number.isFinite(animation.effect?.getComputedTiming().endTime),
      );
    await Promise.allSettled(animations.map((animation) => animation.finished));
  });
}

for (const viewport of viewports) {
  test(`guest profile stays aligned and editable with photo uploads at ${viewport.width}x${viewport.height}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize(viewport);
    await visualFixture(context);
    const profile = {
      displayName: "A".repeat(40),
      age: null,
      gender: "",
      region: "",
      bio: "",
      interests: [],
      aslVisibility: "private",
    };
    const user = {
      id: visualIds.user,
      displayName: profile.displayName,
      verified: false,
      role: "USER",
      profile,
      status: "Online",
    };
    await page.route("**/api/me", (route) =>
      route.fulfill({
        json: { user, csrf: "visual-csrf", settings: defaultSettings },
      }),
    );
    await page.route("**/api/profile/picture", (route) =>
      route.fulfill({ json: { picture: null, uploadAvailable: true } }),
    );
    let saved = false;
    await page.route("**/api/me/profile", (route) => {
      expect(route.request().method()).toBe("PATCH");
      const input = route.request().postDataJSON();
      expect(input.displayName).toBe("Updated nickname");
      expect(input.aslVisibility).toBe("private");
      saved = true;
      return route.fulfill({
        json: { ...user, displayName: input.displayName, profile: input },
      });
    });
    await openProfile(page);

    const identity = page.locator(".profile-status");
    const picture = identity.getByLabel("Your profile picture", {
      exact: true,
    });
    const form = page.locator(".profile-form");
    await expect(
      identity.getByRole("button", {
        name: "Upload profile picture",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(page.locator(".profile-picture-settings")).toHaveCount(0);
    await expect(picture.getByRole("alert")).toHaveCount(0);

    const card = (await identity.boundingBox())!;
    const avatar = (await identity
      .locator(".profile-avatar-button")
      .boundingBox())!;
    const name = (await identity.getByRole("heading").boundingBox())!;
    expect(avatar.x - card.x).toBeGreaterThanOrEqual(12);
    expect(avatar.y - card.y).toBeGreaterThanOrEqual(12);
    expect(name.x).toBeGreaterThanOrEqual(card.x + 12);
    expect(name.x + name.width).toBeLessThanOrEqual(card.x + card.width - 12);

    const verify = identity.getByRole("button", {
      name: "Verify & keep this identity",
      exact: true,
    });
    const google = identity.getByRole("button", {
      name: "Connect Google",
      exact: true,
    });
    const verifyBounds = (await verify.boundingBox())!;
    const googleBounds = (await google.boundingBox())!;
    for (const bounds of [verifyBounds, googleBounds]) {
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.y).toBeGreaterThanOrEqual(name.y + name.height);
      expect(bounds.x).toBeGreaterThanOrEqual(card.x + 12);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(
        card.x + card.width - 12,
      );
    }
    const horizontalGap = googleBounds.x - verifyBounds.x - verifyBounds.width;
    const verticalGap = googleBounds.y - verifyBounds.y - verifyBounds.height;
    expect(Math.max(horizontalGap, verticalGap)).toBeGreaterThanOrEqual(8);

    for (const panel of [form]) {
      const bounds = (await panel.boundingBox())!;
      expect(bounds.x).toBeCloseTo(card.x, 0);
      expect(bounds.width).toBeCloseTo(card.width, 0);
      expect(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
        true,
      );
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    await page
      .getByRole("textbox", { name: "Nickname", exact: true })
      .fill("Updated nickname");
    const save = page.getByRole("button", {
      name: "Save profile",
      exact: true,
    });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    const saveBounds = (await save.boundingBox())!;
    const mobileNav = page.locator(".mobile-nav");
    const availableBottom = (await mobileNav.isVisible())
      ? (await mobileNav.boundingBox())!.y
      : viewport.height;
    expect(saveBounds.y + saveBounds.height).toBeLessThanOrEqual(
      availableBottom,
    );
    await save.click();
    await expect(
      page.getByText("Profile saved.", { exact: true }),
    ).toBeVisible();
    expect(saved).toBe(true);
    await expect(identity.getByRole("heading")).toHaveText("Updated nickname");
  });
}

test("verified profile allows photo uploads and profile editing", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await visualFixture(context);
  await page.route("**/api/profile/picture", (route) =>
    route.fulfill({ json: { picture: null, uploadAvailable: true } }),
  );
  await openProfile(page);
  const identity = page.locator(".profile-status");
  await expect(identity).toContainText("✓ Email verified");
  await expect(
    identity.getByRole("button", { name: "Verify & keep this identity" }),
  ).toHaveCount(0);
  await expect(
    identity.getByRole("button", { name: "Connect Google" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Nickname", exact: true }),
  ).toBeEditable();
  await expect(
    page.getByRole("button", { name: "Save profile", exact: true }),
  ).toBeEnabled();
});
