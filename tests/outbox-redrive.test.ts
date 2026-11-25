import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTBOX_REDRIVE_MINUTES } from "../celld/shared/data";
import { fixture } from "./runtime";

afterEach(() => vi.restoreAllMocks());

const start = Date.parse("2026-11-24T10:00:00.000Z");
const insert = (f: Awaited<ReturnType<typeof fixture>>, at: number) =>
  f.db
    .prepare(
      "INSERT INTO app_outbox(id,kind,payload,created_at) VALUES(?,?,?,?)",
    )
    .bind("stuck", "event", "{}", new Date(at).toISOString())
    .run();
const sends = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.jobs.filter((job) => job.operationId === "stuck");

describe("outbox redrive", () => {
  it("re-sends an old stuck row once per redrive window, not on every alarm", async () => {
    const f = await fixture();
    await insert(f, start - 3600000);
    // Three full redrive windows, one coordinator alarm per minute.
    for (let m = 0; m < 3 * OUTBOX_REDRIVE_MINUTES; m++) {
      vi.spyOn(Date, "now").mockReturnValue(start + m * 60000);
      await f.app.alarm();
    }
    expect(sends(f)).toHaveLength(3);
  });

  it("re-sends a fresh row on the first short retry alarm, whatever its rowid phase", async () => {
    for (let phase = 0; phase < OUTBOX_REDRIVE_MINUTES; phase++) {
      const f = await fixture();
      const at = start + phase * 60000;
      await insert(f, at);
      vi.spyOn(Date, "now").mockReturnValue(at + 1000);
      await f.app.alarm();
      expect(sends(f)).toHaveLength(1);
      vi.restoreAllMocks();
    }
  });
});
