import { expect, test, type Page } from "@playwright/test";
import { defaultSettings } from "@charoo/contracts";
import { visualFixture, visualIds } from "./visual-fixture";

const profile = {
  displayName: "Cora Lane",
  age: 31,
  gender: "Woman",
  region: "Manila",
  bio: "",
  interests: [],
  aslVisibility: "public",
};

// Serve /api/me with credits enabled, optionally for a guest, and a credits summary.
async function creditsSession(
  page: Page,
  { verified = true, balance = 12, claimable = true } = {},
) {
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: {
        user: {
          id: visualIds.user,
          displayName: "Cora Lane",
          verified,
          role: "USER",
          profile,
          status: "Online",
        },
        csrf: "visual-csrf",
        settings: { ...defaultSettings, credits_enabled: true },
        credits: { enabled: true, balance, dailyClaimable: claimable },
      },
    }),
  );
  await page.route("**/api/credits", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        enabled: true,
        balance,
        lifetimeEarned: 12,
        lifetimeSpent: 0,
        contactSlots: {
          used: 3,
          limit: 10,
          base: 10,
          extra: 0,
          max: 50,
          pack: 5,
          price: 15,
        },
        daily: { claimable, streak: 2, amount: 7 },
        peekPrice: 10,
        reconnectPrice: 3,
        packs: [
          { id: "pack-100", credits: 100, amountMinor: 500, currency: "USD" },
        ],
      },
    });
  });
  await page.route("**/api/credits/ledger", (route) =>
    route.fulfill({ json: { entries: [], next: null } }),
  );
}

async function openCredits(page: Page) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("button", { name: "Credits", exact: true })
    .click();
}

test("credits page shows the authoritative balance, a daily claim and an empty activity state", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  await creditsSession(page);
  await openCredits(page);
  const card = page.getByLabel("Credits", { exact: true });
  await expect(card.getByLabel("Balance")).toContainText("12");
  await expect(
    page.getByRole("button", { name: "Claim 7 credits" }),
  ).toBeVisible();
  await expect(page.getByText("3 of 10 saved", { exact: false })).toBeVisible();
  await expect(page.getByText("No credit activity yet.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Buy 5 more slots for 15 credits" }),
  ).toBeVisible();
});

test("guests get a verify prompt on the credits page instead of a dead end", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  await creditsSession(page, { verified: false, balance: 0 });
  await openCredits(page);
  await expect(
    page.getByText("Verify your account to start earning credits."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Verify to start earning" }),
  ).toBeVisible();
});

test("the credits entry stays hidden while the feature flag is off", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  await page.goto("/");
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation", exact: true })
      .getByRole("button", { name: "Credits", exact: true }),
  ).toHaveCount(0);
});
