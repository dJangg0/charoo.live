import type { Hono } from "hono";
import { coordinator, roomStub } from "../../shared/data";
import { requireThat, unwrap } from "../../shared/errors";
import {
  actor,
  body,
  uuid,
  userRate,
  type HttpEnv,
  type HttpContext,
} from "../../http/context";
import { boundedBody } from "../media/routes";
import { pictureInitSchema } from "./state";
import { validatePicture } from "./image";

const command = (c: HttpContext, kind: string, input: any = {}) =>
  coordinator(c.env).command(actor(c), kind, input).then(unwrap);
// Legacy profile scan URLs no longer grant access to uploaded picture bytes.
export async function pictureScanRequest(_c: HttpContext) {
  return new Response("Profile scan links are no longer available", {
    status: 410,
  });
}
export function pictureRoutes(app: Hono<HttpEnv>) {
  app.get("/api/profile/picture", async (c) =>
    c.json(await command(c, "picture.current")),
  );
  app.post("/api/profile/picture/init", body(pictureInitSchema), async (c) => {
    await userRate(
      c,
      "picture-upload",
      10,
      3600,
      "Picture upload limit reached",
    );
    return c.json(await command(c, "picture.init", c.get("input")), 201);
  });
  app.put("/api/profile/picture/:id/upload", async (c) => {
    const id = uuid(c.req.param("id")),
      p = await command(c, "picture.upload.begin", { id });
    requireThat(
      c.req.header("Content-Type")?.split(";")[0] === p.mime,
      400,
      "Invalid media type",
    );
    const bytes = await boundedBody(c.req.raw, p.size);
    requireThat(bytes.length === p.size, 400, "Upload size changed");
    validatePicture(bytes, p.mime);
    await c.env.MEDIA.put(p.object_key, bytes, {
      httpMetadata: { contentType: p.mime },
    });
    const completion = await coordinator(c.env).command(
      actor(c),
      "picture.upload.finish",
      { id, attempt: p.attempt },
    );
    if (!completion.ok) {
      await c.env.MEDIA.delete(p.object_key);
      unwrap(completion);
    }
    return c.body(null, 204);
  });
  app.post("/api/profile/picture/:id/complete", async (c) => {
    const id = uuid(c.req.param("id")),
      p = await command(c, "picture.complete.prepare", { id });
    if (p.state === "APPROVED") return c.json({ id: p.id, state: p.state });
    const object = await c.env.MEDIA.get(p.object_key);
    requireThat(
      object,
      404,
      "Uploaded picture unavailable. Please upload it again.",
    );
    const bytes = await boundedBody(object, p.size);
    requireThat(bytes.length === p.size, 400, "Upload size changed");
    validatePicture(bytes, p.mime);
    return c.json(
      await command(c, "picture.complete", {
        id,
        attempt: p.uploadAttempt,
        key: p.object_key,
      }),
    );
  });
  app.get("/api/profile/picture/content", async (c) => {
    const p = await command(c, "picture.download"),
      object = await c.env.MEDIA.get(p.object_key);
    requireThat(object, 404, "Picture unavailable");
    requireThat(
      !c.req.query("pictureId") || c.req.query("pictureId") === p.id,
      409,
      "Picture changed",
    );
    const latest = await command(c, "picture.download");
    requireThat(latest.id === p.id, 409, "Picture changed");
    return new Response(object.body, {
      headers: {
        "Content-Type": p.mime,
        "Content-Length": String(object.size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  app.get("/api/rooms/:roomId/pictures/:userId/content", async (c) => {
    const room = roomStub(c.env, uuid(c.req.param("roomId"))),
      input = {
        userId: uuid(c.req.param("userId")),
        pictureId: c.req.query("pictureId"),
      };
    const p = unwrap(await room.command(actor(c), "picture.download", input)),
      object = await c.env.MEDIA.get(p.object_key);
    requireThat(object, 404, "Picture unavailable");
    const latest = unwrap(
      await room.command(actor(c), "picture.download", input),
    );
    requireThat(latest.id === p.id, 409, "Picture changed");
    return new Response(object.body, {
      headers: {
        "Content-Type": p.mime,
        "Content-Length": String(object.size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
