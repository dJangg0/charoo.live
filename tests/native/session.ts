import { expect, type APIResponse, type Browser } from "@playwright/test";
import { nativeRuntimePort } from "../../celld/scripts/ports";

// Shared helpers for native specs: verified fixture sessions on the real Celld runtime.
export const base =
  process.env.BROWSER_BASE_URL || `http://127.0.0.1:${nativeRuntimePort()}`;
const testHeaders = { "X-Test-Key": "charoo-native-fixture" };

export type Identity = Awaited<ReturnType<typeof identity>>;

export async function identity(browser: Browser) {
  const context = await browser.newContext({
    extraHTTPHeaders: { "X-Fixture-Client": crypto.randomUUID() },
  });
  const response = await context.request.post(`${base}/__test/session`, {
    headers: testHeaders,
    data: { verified: true, role: "USER" },
  });
  const session = await response.json();
  const api = (path: string, method = "GET", data?: unknown) =>
    context.request.fetch(`${base}/api${path}`, {
      method,
      data,
      headers: { Origin: base, "X-CSRF-Token": session.csrf },
    });
  await api("/presence", "POST", { status: "Online" });
  return { context, session, api, id: session.user.id as string };
}

export async function json<T = any>(
  response: APIResponse,
  label: string,
): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

// The quick-chat matcher needs an approved profile picture.
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAI0lEQVR4AYTIMQ0AAAwCwQYrNVYpdQ4rYeGTXw77Rx8TdRAAAAD//ztpTTIAAAAGSURBVAMA2psIEaykz3gAAAAASUVORK5CYII=";

export async function withPicture(who: Identity) {
  const png = Buffer.from(pngBase64, "base64");
  const picture = await json(
    await who.api("/profile/picture/init", "POST", {
      mime: "image/png",
      size: png.length,
    }),
    "picture init",
  );
  const put = await who.context.request.put(`${base}${picture.url}`, {
    headers: {
      "Content-Type": "image/png",
      Origin: base,
      "X-CSRF-Token": who.session.csrf,
    },
    data: png,
  });
  expect(put.ok(), `picture upload ${put.status()}`).toBe(true);
  await json(
    await who.api(`/profile/picture/${picture.id}/complete`, "POST", {}),
    "picture complete",
  );
  return who;
}
