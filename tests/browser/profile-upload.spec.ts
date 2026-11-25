import { expect, test, type Page } from "@playwright/test";
import { visualFixture } from "./visual-fixture";

const pictureId = "60000000-0000-4000-8000-000000000001";
const previousId = "60000000-0000-4000-8000-000000000002";
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const file = { name: "profile.png", mimeType: "image/png", buffer: image };
const savedNotice =
  "Profile picture saved. You choose whether to share it in each quick chat.";

async function openProfile(page: Page) {
  await page.goto("/");
  await expect(page.locator(".connection")).toHaveText("Online");
  const menu = page.getByRole("button", { name: "Toggle menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("button", { name: "Your profile", exact: true })
    .click();
  await expect(
    page.getByLabel("Your profile picture", { exact: true }),
  ).toBeVisible();
}

async function preview(page: Page) {
  await page.route("**/api/profile/picture/content*", (route) =>
    route.fulfill({ contentType: "image/png", body: image }),
  );
}

async function initialize(page: Page, operations: string[]) {
  await page.route("**/api/profile/picture/init", (route) => {
    operations.push("init");
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      mime: "image/png",
      size: image.length,
    });
    return route.fulfill({
      status: 201,
      json: { id: pictureId, url: `/api/profile/picture/${pictureId}/upload` },
    });
  });
  await page.route(`**/api/profile/picture/${pictureId}/upload`, (route) => {
    operations.push("upload");
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["content-type"]).toBe("image/png");
    expect(route.request().headers()["x-csrf-token"]).toBe("visual-csrf");
    expect(route.request().postDataBuffer()).toEqual(image);
    return route.fulfill({ status: 204 });
  });
}

test("profile photo saves in order and waits for the backend before showing success", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await visualFixture(context);
  await preview(page);
  let saved = false;
  const operations: string[] = [];
  await page.route("**/api/profile/picture", (route) => {
    operations.push("status");
    return route.fulfill({
      json: {
        picture: saved
          ? { id: pictureId, url: "/api/profile/picture/content" }
          : null,
        uploadAvailable: true,
      },
    });
  });
  await initialize(page, operations);
  let release!: () => void;
  const completion = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    `**/api/profile/picture/${pictureId}/complete`,
    async (route) => {
      operations.push("complete");
      await completion;
      saved = true;
      return route.fulfill({ json: { id: pictureId, state: "APPROVED" } });
    },
  );
  await openProfile(page);
  const picker = page.getByLabel("Add profile picture");
  await expect(picker).toHaveAttribute(
    "accept",
    "image/jpeg,image/png,image/webp",
  );
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Upload profile picture", exact: true })
    .click();
  await (await chooser).setFiles(file);
  await expect(
    page.getByText("Confirming your picture…", { exact: true }),
  ).toBeVisible();
  await expect(picker).toBeDisabled();
  await expect(page.getByText(savedNotice, { exact: true })).toHaveCount(0);
  expect(operations.filter((operation) => operation !== "status")).toEqual([
    "init",
    "upload",
    "complete",
  ]);
  release();
  await expect(page.getByText(savedNotice, { exact: true })).toBeVisible();
  await expect(
    page.getByAltText("Your private profile picture"),
  ).toHaveAttribute("src", `/api/profile/picture/content?v=${pictureId}`);
  await expect(
    page.getByRole("button", { name: "Change profile picture", exact: true }),
  ).toBeEnabled();
  await expect(
    page
      .locator(".profile-status")
      .getByAltText("Your private profile picture"),
  ).toBeVisible();
  await expect(page.locator(".profile-picture-settings")).toHaveCount(0);
  expect(operations.filter((operation) => operation !== "status")).toEqual([
    "init",
    "upload",
    "complete",
  ]);
  expect(operations.at(-1)).toBe("status");
});

test("a failed replacement keeps the previous photo and can be retried", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  await preview(page);
  let saved = false;
  let completions = 0;
  const operations: string[] = [];
  await page.route("**/api/profile/picture", (route) =>
    route.fulfill({
      json: {
        picture: {
          id: saved ? pictureId : previousId,
          url: "/api/profile/picture/content",
        },
        uploadAvailable: true,
      },
    }),
  );
  await initialize(page, operations);
  await page.route(`**/api/profile/picture/${pictureId}/complete`, (route) => {
    completions++;
    if (completions === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Your picture could not be saved. Please try again." },
      });
    saved = true;
    return route.fulfill({ json: { id: pictureId, state: "APPROVED" } });
  });
  await openProfile(page);
  const picker = page.getByLabel("Replace profile picture");
  await picker.setInputFiles(file);
  await expect(page.getByRole("alert")).toHaveText(
    "Your picture could not be saved. Please try again.",
  );
  await expect(
    page.getByAltText("Your private profile picture"),
  ).toHaveAttribute("src", `/api/profile/picture/content?v=${previousId}`);
  await expect(page.getByText(savedNotice, { exact: true })).toHaveCount(0);
  await expect(picker).toBeEnabled();
  await picker.setInputFiles(file);
  await expect(page.getByText(savedNotice, { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(completions).toBe(2);
});

test("invalid file types, empty images and oversized photos stop before upload", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  let initialized = 0;
  await page.route("**/api/profile/picture", (route) =>
    route.fulfill({ json: { picture: null, uploadAvailable: true } }),
  );
  await page.route("**/api/profile/picture/init", (route) => {
    initialized++;
    return route.fulfill({ status: 500 });
  });
  await openProfile(page);
  const picker = page.getByLabel("Add profile picture");
  for (const invalid of [
    {
      name: "not-a-photo.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg/>"),
    },
    { ...file, buffer: Buffer.alloc(0) },
    { ...file, buffer: Buffer.alloc(5 * 1048576 + 1) },
  ]) {
    await picker.setInputFiles(invalid);
    await expect(page.getByRole("alert")).toHaveText(
      invalid.mimeType === "image/svg+xml"
        ? "Choose a JPEG, PNG or WebP picture."
        : "Choose a picture up to 5 MB.",
    );
    await expect(picker).toBeEnabled();
  }
  expect(initialized).toBe(0);
});

for (const response of [
  { id: pictureId, state: "REJECTED" },
  { id: previousId, state: "APPROVED" },
]) {
  test(`an unexpected completion result does not report a saved photo (${response.id === pictureId ? "state" : "id"})`, async ({
    page,
    context,
  }) => {
    await visualFixture(context);
    const operations: string[] = [];
    await page.route("**/api/profile/picture", (route) =>
      route.fulfill({ json: { picture: null, uploadAvailable: true } }),
    );
    await initialize(page, operations);
    await page.route(`**/api/profile/picture/${pictureId}/complete`, (route) =>
      route.fulfill({ json: response }),
    );
    await openProfile(page);
    await page.getByLabel("Add profile picture").setInputFiles(file);
    await expect(page.getByRole("alert")).toHaveText(
      "Your picture could not be saved. Please try again.",
    );
    await expect(page.getByText(savedNotice, { exact: true })).toHaveCount(0);
    await expect(page.getByAltText("Your private profile picture")).toHaveCount(
      0,
    );
    await expect(page.getByLabel("Add profile picture")).toBeEnabled();
  });
}

test("an upload failure stops before completion and remains retryable", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  const operations: string[] = [];
  await page.route("**/api/profile/picture", (route) =>
    route.fulfill({ json: { picture: null, uploadAvailable: true } }),
  );
  await initialize(page, operations);
  let completed = false;
  await page.route(`**/api/profile/picture/${pictureId}/upload`, (route) =>
    route.fulfill({
      status: 400,
      json: { error: "Choose a valid PNG image." },
    }),
  );
  await page.route(`**/api/profile/picture/${pictureId}/complete`, (route) => {
    completed = true;
    return route.fulfill({ json: { id: pictureId, state: "APPROVED" } });
  });
  await openProfile(page);
  await page.getByLabel("Add profile picture").setInputFiles(file);
  await expect(page.getByRole("alert")).toHaveText("Choose a valid PNG image.");
  await expect(page.getByLabel("Add profile picture")).toBeEnabled();
  await expect(page.getByText(savedNotice, { exact: true })).toHaveCount(0);
  expect(completed).toBe(false);
});

test("profile photo status can be loaded again after a temporary failure", async ({
  page,
  context,
}) => {
  await visualFixture(context);
  let unavailable = true;
  await page.route("**/api/profile/picture", (route) => {
    return unavailable
      ? route.fulfill({
          status: 503,
          json: { error: "Your picture could not be loaded." },
        })
      : route.fulfill({ json: { picture: null, uploadAvailable: true } });
  });
  await openProfile(page);
  await expect(page.getByRole("alert")).toHaveText(
    "Your picture could not be loaded.",
  );
  unavailable = false;
  await page.getByRole("button", { name: "Retry loading picture" }).click();
  await expect(page.getByLabel("Add profile picture")).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the avatar supports keyboard selection and repeated successful photo replacement", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await visualFixture(context);
  await preview(page);
  let currentId: string | null = null;
  let initialized = 0;
  let completed = 0;
  await page.route("**/api/profile/picture", (route) =>
    route.fulfill({
      json: {
        picture: currentId
          ? { id: currentId, url: "/api/profile/picture/content" }
          : null,
        uploadAvailable: true,
      },
    }),
  );
  await page.route("**/api/profile/picture/init", (route) => {
    initialized++;
    const id = initialized === 1 ? pictureId : previousId;
    return route.fulfill({
      status: 201,
      json: { id, url: `/api/profile/picture/${id}/upload` },
    });
  });
  await page.route("**/api/profile/picture/*/upload", (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route("**/api/profile/picture/*/complete", (route) => {
    currentId = route.request().url().includes(pictureId)
      ? pictureId
      : previousId;
    completed++;
    return route.fulfill({ json: { id: currentId, state: "APPROVED" } });
  });
  await openProfile(page);
  const card = page.locator(".profile-status");
  for (const [index, name] of [
    "Upload profile picture",
    "Change profile picture",
  ].entries()) {
    const avatar = card.getByRole("button", { name, exact: true });
    await expect(avatar).toBeEnabled();
    await avatar.focus();
    const chooser = page.waitForEvent("filechooser");
    await avatar.press(index === 0 ? "Enter" : "Space");
    await (await chooser).setFiles(file);
    await expect(
      card.getByAltText("Your private profile picture"),
    ).toHaveAttribute(
      "src",
      `/api/profile/picture/content?v=${index === 0 ? pictureId : previousId}`,
    );
  }
  expect(initialized).toBe(2);
  expect(completed).toBe(2);
  await expect(
    card.getByRole("button", { name: "Change profile picture", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".profile-picture-settings")).toHaveCount(0);
});
