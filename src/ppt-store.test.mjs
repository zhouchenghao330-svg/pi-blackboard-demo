import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPptStore } from "./ppt-store.mjs";

test("PPT tasks belong to their session and keep a finished state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demo-ppt-store-"));
  try {
    const store = createPptStore(directory);
    const job = await store.submit("session-a", { brief: "项目汇报", page_count: 6, source_material: "已核验资料" });
    assert.equal(job.status, "queued");
    assert.equal((await store.list("session-a")).length, 1);
    await assert.rejects(store.requireJob("session-b", job.id), /不存在/);
    await Promise.all([
      store.update(job.id, { status: "generating", progress: 30 }),
      store.update(job.id, { pagesCreated: 2 }),
    ]);
    assert.equal((await store.requireJob("session-a", job.id)).pagesCreated, 2);
    await store.update(job.id, { status: "ready", progress: 100 });
    await store.update(job.id, { status: "generating", progress: 60 });
    assert.equal((await store.requireJob("session-a", job.id)).status, "ready");
    await assert.rejects(store.submit("session-a", { brief: "", page_count: 6 }), /需要明确主题/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
