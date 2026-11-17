import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../celld/http/app";
import { fixture } from "./runtime";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Guest = Awaited<ReturnType<Fixture["guest"]>>;

// Tiny real 4x4 rasters, generated with browser canvas. No provider/decoder
// dependency is needed to exercise the application's accepted file formats.
const images = {
  "image/jpeg":
    "/9j/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCWACFP/9k=",
  "image/png":
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAI0lEQVR4AYTIMQ0AAAwCwQYrNVYpdQ4rYeGTXw77Rx8TdRAAAAD//ztpTTIAAAAGSURBVAMA2psIEaykz3gAAAAASUVORK5CYII=",
  "image/webp":
    "UklGRjAAAABXRUJQVlA4ICQAAAAwAQCdASoEAAQAAUAmJaAAA3AA/u7/V//82B/9m//HvawAAAA=",
} as const;

function bytes(mime: keyof typeof images) {
  return new Uint8Array(Buffer.from(images[mime], "base64"));
}

function headers(
  f: Fixture,
  owner?: Guest,
  extra: Record<string, string> = {},
) {
  return {
    Origin: f.env.WEB_ORIGIN,
    "Content-Type": "application/json",
    ...(owner
      ? {
          Cookie: `charoo_session=${owner.token}`,
          "X-CSRF-Token": owner.csrf,
        }
      : {}),
    ...extra,
  };
}

function http(
  f: Fixture,
  owner: Guest | undefined,
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return app.request(
    `/api${path}`,
    {
      method,
      headers: headers(f, owner, extra),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    f.env,
  );
}

async function begin(
  f: Fixture,
  owner: Guest,
  mime: keyof typeof images = "image/png",
) {
  const image = bytes(mime);
  const response = await http(f, owner, "/profile/picture/init", "POST", {
    mime,
    size: image.length,
  });
  expect(response.status).toBe(201);
  const picture: { id: string; url: string } = await response.json();
  const put = (
    guest = owner,
    content = image,
    contentType: string = mime,
    extra: Record<string, string> = {},
  ) =>
    app.request(
      picture.url,
      {
        method: "PUT",
        headers: headers(f, guest, { "Content-Type": contentType, ...extra }),
        body: content,
      },
      f.env,
    );
  const complete = (guest = owner) =>
    http(f, guest, `/profile/picture/${picture.id}/complete`, "POST", {});
  return { ...picture, image, put, complete };
}

afterEach(() => vi.restoreAllMocks());

describe("direct private profile image upload", () => {
  it.each(Object.keys(images) as (keyof typeof images)[])(
    "saves and displays %s without scanner settings or external requests",
    async (mime) => {
      const f = await fixture(),
        owner = await f.guest();
      expect(f.env.MEDIA_SCANNER_URL).toBeUndefined();
      expect(f.env.MEDIA_SCANNER_TOKEN).toBeUndefined();
      const external = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected external request"));
      expect(
        await (await http(f, owner, "/profile/picture")).json(),
      ).toMatchObject({ picture: null, uploadAvailable: true });
      const picture = await begin(f, owner, mime);
      expect((await picture.put()).status).toBe(204);
      expect((await http(f, owner, "/profile/picture/content")).status).toBe(
        404,
      );
      expect((await picture.complete()).status).toBe(200);
      expect(
        await (await http(f, owner, "/profile/picture")).json(),
      ).toMatchObject({
        picture: { id: picture.id, url: "/api/profile/picture/content" },
        uploadAvailable: true,
      });
      const content = await http(f, owner, "/profile/picture/content");
      expect(content.status).toBe(200);
      expect(content.headers.get("Content-Type")).toBe(mime);
      expect(content.headers.get("Cache-Control")).toBe("no-store");
      expect(new Uint8Array(await content.arrayBuffer())).toEqual(
        picture.image,
      );
      expect((await picture.complete()).status).toBe(200);
      expect(external).not.toHaveBeenCalled();
    },
  );

  it("keeps the current image until a valid replacement finishes, then retires the old image", async () => {
    const f = await fixture(),
      owner = await f.guest();
    const original = await begin(f, owner);
    expect((await original.put()).status).toBe(204);
    expect((await original.complete()).status).toBe(200);
    const invalid = await begin(f, owner);
    expect(
      (await invalid.put(owner, new Uint8Array(invalid.image.length))).status,
    ).toBe(400);
    expect((await invalid.complete()).status).toBeGreaterThanOrEqual(400);
    expect(
      await (await http(f, owner, "/profile/picture")).json(),
    ).toMatchObject({ picture: { id: original.id } });
    const replacement = await begin(f, owner, "image/webp");
    expect((await replacement.put()).status).toBe(204);
    expect(
      await (await http(f, owner, "/profile/picture")).json(),
    ).toMatchObject({ picture: { id: original.id } });
    expect((await replacement.complete()).status).toBe(200);
    expect(
      await (await http(f, owner, "/profile/picture")).json(),
    ).toMatchObject({ picture: { id: replacement.id } });
    expect((await original.complete()).status).toBeGreaterThanOrEqual(400);
    expect(
      (
        await http(
          f,
          owner,
          `/profile/picture/content?pictureId=${original.id}`,
        )
      ).status,
    ).toBe(409);
    await f.drain();
    expect(f.media.size).toBe(1);
    expect(
      new Uint8Array(
        await (await http(f, owner, "/profile/picture/content")).arrayBuffer(),
      ),
    ).toEqual(replacement.image);
  });

  it("rejects unsupported types, empty/oversized declarations and incomplete uploads", async () => {
    const f = await fixture(),
      owner = await f.guest();
    for (const input of [
      { mime: "image/svg+xml", size: 100 },
      { mime: "application/pdf", size: 100 },
      { mime: "image/png", size: 0 },
      { mime: "image/png", size: 5 * 1048576 + 1 },
    ])
      expect(
        (await http(f, owner, "/profile/picture/init", "POST", input)).status,
      ).toBe(400);
    const picture = await begin(f, owner);
    expect((await picture.complete()).status).toBeGreaterThanOrEqual(400);
    expect(
      (await picture.put(owner, picture.image.subarray(0, 12))).status,
    ).toBe(400);
    expect(
      (await picture.put(owner, new Uint8Array(picture.image.length + 1)))
        .status,
    ).toBe(413);
    expect((await picture.put(owner, picture.image, "image/jpeg")).status).toBe(
      400,
    );
    expect(
      (await picture.put(owner, new Uint8Array(picture.image.length))).status,
    ).toBe(400);
    expect((await http(f, owner, "/profile/picture/content")).status).toBe(404);
    expect((await picture.put()).status).toBe(204);
    expect((await picture.complete()).status).toBe(200);
  });

  it("requires the owning session and CSRF token for upload and completion", async () => {
    const f = await fixture(),
      owner = await f.guest(),
      outsider = await f.guest();
    expect(
      (
        await http(f, undefined, "/profile/picture/init", "POST", {
          mime: "image/png",
          size: 12,
        })
      ).status,
    ).toBe(401);
    const picture = await begin(f, owner);
    expect((await picture.put(outsider)).status).toBe(404);
    expect((await picture.complete(outsider)).status).toBe(404);
    expect(
      (
        await picture.put(owner, picture.image, "image/png", {
          "X-CSRF-Token": "wrong",
        })
      ).status,
    ).toBe(403);
    expect((await picture.put()).status).toBe(204);
    expect(
      (
        await http(
          f,
          owner,
          `/profile/picture/${picture.id}/complete`,
          "POST",
          {},
          { "X-CSRF-Token": "wrong" },
        )
      ).status,
    ).toBe(403);
    expect((await picture.complete()).status).toBe(200);
    expect((await http(f, outsider, "/profile/picture/content")).status).toBe(
      404,
    );
    expect((await http(f, undefined, "/profile/picture/content")).status).toBe(
      401,
    );
  });

  it("rejects a real image mislabeled as another accepted format", async () => {
    const f = await fixture(),
      owner = await f.guest();
    const image = bytes("image/png");
    const init = await http(f, owner, "/profile/picture/init", "POST", {
      mime: "image/jpeg",
      size: image.length,
    });
    expect(init.status).toBe(201);
    const picture: { id: string; url: string } = await init.json();
    const upload = await app.request(
      picture.url,
      {
        method: "PUT",
        headers: headers(f, owner, { "Content-Type": "image/jpeg" }),
        body: image,
      },
      f.env,
    );
    expect(upload.status).toBe(400);
    expect(
      (
        await http(
          f,
          owner,
          `/profile/picture/${picture.id}/complete`,
          "POST",
          {},
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await http(f, owner, "/profile/picture/content")).status).toBe(404);
  });

  it("rejects a late superseded PUT without deleting the successful retry", async () => {
    const f = await fixture(),
      owner = await f.guest();
    const picture = await begin(f, owner);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = f.env.MEDIA.put.bind(f.env.MEDIA);
    let first = true;
    vi.spyOn(f.env.MEDIA, "put").mockImplementation(
      async (key, content, options) => {
        if (first) {
          first = false;
          entered();
          await blocked;
        }
        return put(key, content, options);
      },
    );
    const delayed = picture.put();
    await started;
    expect((await picture.put()).status).toBe(204);
    release();
    expect((await delayed).status).toBe(409);
    expect((await picture.complete()).status).toBe(200);
    expect(
      new Uint8Array(
        await (await http(f, owner, "/profile/picture/content")).arrayBuffer(),
      ),
    ).toEqual(picture.image);
  });

  it("rejects completion of bytes that were superseded while storage was being read", async () => {
    const f = await fixture(),
      owner = await f.guest();
    const picture = await begin(f, owner);
    expect((await picture.put()).status).toBe(204);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = f.env.MEDIA.get.bind(f.env.MEDIA);
    let first = true;
    vi.spyOn(f.env.MEDIA, "get").mockImplementation(async (key) => {
      const object = await get(key);
      if (first) {
        first = false;
        entered();
        await blocked;
      }
      return object;
    });
    const delayed = picture.complete();
    await started;
    expect((await picture.put()).status).toBe(204);
    release();
    expect((await delayed).status).toBe(409);
    expect(
      await (await http(f, owner, "/profile/picture")).json(),
    ).toMatchObject({ picture: null });
    expect((await picture.complete()).status).toBe(200);
    await f.drain();
    expect(f.media.size).toBe(1);
    expect(
      new Uint8Array(
        await (await http(f, owner, "/profile/picture/content")).arrayBuffer(),
      ),
    ).toEqual(picture.image);
  });
});
