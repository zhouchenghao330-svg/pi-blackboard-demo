import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLongMemoryStore } from "./long-memory-store.mjs";

test("single-entry edits, merge, history and restart preserve current memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demo-memory-"));
  try {
    const source = { kind: "conversation", sessionId: "session-a", excerpt: "李明负责协调" };
    const store = await createLongMemoryStore(directory);
    const first = await store.apply({ op: "add", section: "people", text: "李明：负责本次供应商协调" }, { actor: "agent", source });
    const second = await store.apply({ op: "add", section: "people", text: "李明：负责到货确认" }, { actor: "background", source });
    assert.equal(first.id, "p1");
    assert.equal(second.id, "p2");
    assert.equal((await store.apply({ op: "add", section: "people", text: "李明：负责到货确认" }, { actor: "agent", source })).status, "unchanged");
    await store.apply({ op: "merge", section: "people", id: "p1", other_id: "p2",
      text: "李明：本次负责供应商协调与到货确认" }, { actor: "agent", source });
    assert.equal(store.snapshot().entries.length, 1);
    assert.equal(store.snapshot().entries[0].id, "p1");
    assert.equal(store.changesAfter(1, "background").length, 1);
    const restored = await createLongMemoryStore(directory);
    assert.deepEqual(restored.snapshot(), store.snapshot());
    assert.equal(restored.history().length, 3);
    assert.equal(await readFile(join(directory, "memory", "memory.md"), "utf8"), restored.snapshot().text);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("capacity rejection leaves history and current memory intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demo-memory-"));
  try {
    const store = await createLongMemoryStore(directory);
    const source = { kind: "conversation", sessionId: "session-a" };
    for (let index = 0; index < 8; index++) {
      await store.apply({ op: "add", section: "topics", text: `${index}${"字".repeat(230)}` }, { actor: "agent", source });
    }
    const before = store.snapshot();
    await assert.rejects(store.apply({ op: "add", section: "topics", text: "新".repeat(230) }, { actor: "agent", source }), /记忆已占/);
    assert.deepEqual(store.snapshot(), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("background cannot replace a user-pinned entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demo-memory-"));
  try {
    const store = await createLongMemoryStore(directory);
    const source = { kind: "conversation", sessionId: "session-a" };
    await store.apply({ op: "add", section: "people", text: "李明：本次负责协调", pinned: true }, { actor: "agent", source });
    await assert.rejects(store.apply({ op: "delete", section: "people", id: "p1" },
      { actor: "background", source }), /后台不能修改/);
    assert.match(store.snapshot().text, /\[p1\] ! 李明/);
    assert.equal(store.snapshot().version, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stale writers cannot overwrite a newer version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demo-memory-"));
  try {
    const store = await createLongMemoryStore(directory);
    const source = { kind: "conversation", sessionId: "session-a" };
    await store.apply({ op: "add", section: "events", text: "周五讨论交付" }, { actor: "agent", source });
    await store.apply({ op: "update", section: "events", id: "e1", text: "周五讨论验收" },
      { actor: "background", source, expectedVersion: 1 });
    await assert.rejects(store.apply({ op: "update", section: "events", id: "e1", text: "周五讨论交付" },
      { actor: "agent", source, expectedVersion: 1 }), /版本已变化/);
    assert.equal(store.snapshot().entries[0].text, "周五讨论验收");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
