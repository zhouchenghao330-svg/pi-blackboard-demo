import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSlotStore, formatSlotCatalog } from "./slot-store.mjs";

test("multiple resource slots remain isolated and recover from disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demo-slots-"));
  const first = randomUUID();
  const second = randomUUID();
  const pdfA = randomUUID();
  const pdfB = randomUUID();
  const meetingId = randomUUID();
  const runId = randomUUID();
  const pptId = randomUUID();
  const createdAt = "2026-09-24T00:00:00.000Z";
  const documents = {
    async list(sessionId) { return sessionId === first ? [pdfA, pdfB].map((id) => ({ id, name: `${id}.pdf`, status: "ready", createdAt })) : []; },
    async board(_, id) { return { overview: { description: `概览 ${id}` } }; },
    async requireDocument(_, id) { return { id }; },
  };
  const meetings = {
    async list(sessionId) { return sessionId === first ? [
      { id: meetingId, name: "周会.txt", status: "uploaded", lineCount: 8, uploadedAt: createdAt },
      { id: runId, sourceMeetingId: meetingId, name: "周会.txt", status: "completed", analysisCreatedAt: createdAt,
        analysis: { facts: { summary: "讨论交付" } } },
    ] : []; },
    async requireMeeting(_, id) { return { id }; },
  };
  const ppts = {
    async list(sessionId) { return sessionId === first ? [{ id: pptId, brief: "季度汇报", status: "ready", createdAt, updatedAt: createdAt }] : []; },
    async requireJob(_, id) { return { id }; },
  };
  try {
    const store = createSlotStore(directory, { documents, meetings, ppts });
    const slots = await store.sync(first);
    assert.equal(slots.length, 4);
    assert.equal((await store.requireSlot(first, "txt", meetingId)).jobIds[0], runId);
    assert.match(formatSlotCatalog(slots), /slot_id=/);
    assert.equal((await store.sync(second)).length, 0);
    await assert.rejects(store.requireSlot(second, "pdf", pdfA), /不属于当前会话/);
    const persisted = JSON.parse(await readFile(join(directory, "slots", `${first}.json`), "utf8"));
    assert.equal(persisted.slots.length, 4);
    assert.equal((await createSlotStore(directory, { documents, meetings, ppts }).sync(first)).length, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
