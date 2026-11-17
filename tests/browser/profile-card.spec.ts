import { expect, test, type Page } from "@playwright/test";
import { defaultSettings } from "@charoo/contracts";
import { visualFixture, visualIds } from "./visual-fixture";

async function openProfile(page: Page) {
  await page.goto("/");
  await expect(page.locator(".connection")).toHaveText("Online");
  const menu = page.getByRole("button", { name: "Toggle menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("button", { name: "Your profile", exact: true })
    .click();
}

function account(bio = "") {
  return {
    id: visualIds.user,
    displayName: "Cora Lane",
    verified: true,
    role: "USER",
    status: "Online",
    profile: {
      displayName: "Cora Lane",
      age: null,
      gender: "",
      region: "Manila",
      bio,
      interests: [],
      aslVisibility: "private",
    },
  };
}

test("the bio can be saved and is restored in the profile card after reload", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await visualFixture(context);
  let user = account();
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: { user, csrf: "visual-csrf", settings: defaultSettings },
    }),
  );
  await page.route("**/api/profile/picture", (route) =>
    route.fulfill({ json: { picture: null, uploadAvailable: true } }),
  );
  const bio = "Coffee, books, and long walks around the city.";
  let saves = 0;
  await page.route("**/api/me/profile", (route) => {
    expect(route.request().method()).toBe("PATCH");
    const profile = route.request().postDataJSON();
    expect(profile.bio).toBe(bio);
    expect(profile.aslVisibility).toBe("private");
    user = { ...user, displayName: profile.displayName, profile };
    saves++;
    return route.fulfill({ json: user });
  });
  await openProfile(page);
  const field = page.getByRole("textbox", { name: "Bio", exact: true });
  await expect(field).toHaveAttribute("maxlength", "300");
  await expect(field).toBeEditable();
  await expect(page.locator(".profile-status .profile-bio")).toHaveCount(0);
  await field.fill(bio);
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByText("Profile saved.", { exact: true })).toBeVisible();
  await expect(page.locator(".profile-status .profile-bio")).toHaveText(bio);
  expect(saves).toBe(1);
  await openProfile(page);
  await expect(
    page.getByRole("textbox", { name: "Bio", exact: true }),
  ).toHaveValue(bio);
  await expect(page.locator(".profile-status .profile-bio")).toHaveText(bio);
  await expect(page.locator(".profile-picture-settings")).toHaveCount(0);
});

test("a failed bio save keeps the saved card text and the editable draft", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  const saved = "An existing saved bio.";
  const user = account(saved);
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: { user, csrf: "visual-csrf", settings: defaultSettings },
    }),
  );
  await page.route("**/api/profile/picture", (route) =>
    route.fulfill({ json: { picture: null, uploadAvailable: true } }),
  );
  await page.route("**/api/me/profile", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Your profile could not be saved." },
    }),
  );
  await openProfile(page);
  const draft = "A changed bio awaiting retry.";
  const field = page.getByRole("textbox", { name: "Bio", exact: true });
  await field.fill(draft);
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    page.getByText("Your profile could not be saved.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".profile-status .profile-bio")).toHaveText(saved);
  await expect(field).toHaveValue(draft);
  await expect(
    page.getByRole("button", { name: "Save profile", exact: true }),
  ).toBeEnabled();
});
