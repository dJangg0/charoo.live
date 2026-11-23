import { test, expect, type Page } from "@playwright/test";
import { base, identity, withPicture } from "./session";

// Two real browsers on the built app and real Celld: match, chat, one person hits Next,
// the other requests a reconnect from Past quick chats, and the first accepts in Chats.
test.setTimeout(180000);

async function openApp(page: Page) {
  await page.goto(`${base}/`);
  await expect(page.locator(".connection")).toHaveText("Online", {
    timeout: 20000,
  });
}

function mainNav(page: Page) {
  return page.getByRole("navigation", { name: "Main navigation", exact: true });
}

test("reconnect works through the UI after one person hits Next", async ({
  browser,
}) => {
  const a = await withPicture(await identity(browser));
  const b = await withPicture(await identity(browser));
  const pageA = await a.context.newPage();
  const pageB = await b.context.newPage();
  const errors: string[] = [];
  for (const [who, page] of [
    ["A", pageA],
    ["B", pageB],
  ] as const) {
    page.on("pageerror", (error) =>
      errors.push(`${who} pageerror: ${error.message}`),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        errors.push(`${who} console: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.url().includes("/api/") && response.status() >= 400)
        errors.push(
          `${who} ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`,
        );
    });
  }

  await openApp(pageA);
  await openApp(pageB);

  // Match through Quick chat.
  for (const page of [pageA, pageB]) {
    await mainNav(page)
      .getByRole("button", { name: "Quick chat", exact: true })
      .click();
    await page.getByRole("button", { name: "Find a conversation" }).click();
  }
  await expect(pageA.locator(".chat")).toBeVisible({ timeout: 40000 });
  await expect(pageB.locator(".chat")).toBeVisible({ timeout: 40000 });

  // Talk.
  await pageA.getByLabel("Message", { exact: true }).fill("hello from A");
  await pageA.getByRole("button", { name: "Send message" }).click();
  await expect(pageB.getByText("hello from A", { exact: true })).toBeVisible({
    timeout: 20000,
  });

  // A hits Next.
  // The header and the sidebar both show Next; the header control is unambiguous.
  await pageA.locator(".room-leave-button", { hasText: "Next" }).click();

  // B opens Past quick chats on Chats and requests a reconnect to A.
  await mainNav(pageB)
    .getByRole("button", { name: /^Chats\b/ })
    .click();
  const past = pageB.locator(".past-chat-details");
  await expect(past).toBeVisible({ timeout: 20000 });
  await past.locator("summary").click();
  const requestButton = past
    .locator(".past-chat-row")
    .first()
    .getByRole("button", { name: /Request reconnect/ });
  await expect(requestButton).toBeEnabled({ timeout: 20000 });
  await requestButton.click();
  await expect(
    pageB.getByText("Request sent. They decide whether to accept."),
  ).toBeVisible({
    timeout: 20000,
  });

  // A sees the reconnect request in Chats and accepts it.
  await mainNav(pageA)
    .getByRole("button", { name: /^Chats\b/ })
    .click();
  const notices = pageA.getByLabel("Reconnect requests", { exact: true });
  await expect(notices).toContainText("wants to reconnect", { timeout: 30000 });
  await notices.getByRole("button", { name: "Accept", exact: true }).click();

  // A lands in the private chat.
  await expect(pageA.locator(".chat")).toBeVisible({ timeout: 30000 });
  await expect(
    pageA.getByText("Reconnect accepted. Your private chat is ready."),
  ).toBeVisible({
    timeout: 20000,
  });

  // B finds the private chat under Chats and writes in it; A reads it.
  await mainNav(pageB)
    .getByRole("button", { name: /^Chats\b/ })
    .click();
  await pageB
    .locator(".conversation-row", { hasText: "Private conversation" })
    .first()
    .click();
  await expect(pageB.locator(".chat")).toBeVisible({ timeout: 20000 });
  await pageB
    .getByLabel("Message", { exact: true })
    .fill("so good to reconnect");
  await pageB.getByRole("button", { name: "Send message" }).click();
  await expect(
    pageA.getByText("so good to reconnect", { exact: true }),
  ).toBeVisible({
    timeout: 20000,
  });

  expect(errors, errors.join("\n")).toEqual([]);
  // A pressed Next, so A is queued again. Cancel it so later specs are not matched with a closed browser.
  await a.api("/match", "DELETE");
  await a.context.close();
  await b.context.close();
});
