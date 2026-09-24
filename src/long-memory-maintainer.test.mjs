import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLongMemoryStore } from "./long-memory-store.mjs";
import { createLongMemoryMaintainer } from "./long-memory-maintainer.mjs";

async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("background memory maintenance did not finish");
}

test("five completed user turns trigger one asynchronous maintenance batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demo-memory-maintainer-"));
  try {
    const memory = await createLongMemoryStore(directory);
    let calls = 0;
    const maintainer = await createLongMemoryMaintainer({ dataDir: directory, memory, analyzeJson: async (batch) => {
      calls++;
      assert.equal(batch.length, 5);
      return [{ op: "add", section: "topics", text: "持续讨论项目交付" }];
    } });
    for (let index = 0; index < 5; index++) {
      await maintainer.recordTurn("session-a", `第 ${index + 1} 轮讨论交付`, "好的");
    }
    await until(async () => maintainer.pendingProposals().length === 1 &&
      (await readFile(join(directory, "memory", "pending.json"), "utf8")).trim() === "[]");
    assert.equal(calls, 1);
    assert.equal(memory.snapshot().version, 0);
    const [proposal] = maintainer.pendingProposals();
    assert.deepEqual(proposal.operation, { op: "add", section: "topics", text: "持续讨论项目交付" });
    assert.equal(proposal.source.kind, "conversation");
    assert.equal(proposal.source.turns.length, 5);
    await maintainer.markDelivered([proposal.proposalId]);
    assert.equal(maintainer.pendingProposals().length, 0);
    assert.equal(maintainer.getProposal("session-a", proposal.proposalId).status, "delivered");
    await maintainer.markApplied(proposal.proposalId);
    assert.equal(maintainer.getProposal("session-a", proposal.proposalId).status, "applied");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("finished meeting is maintained once and keeps its cited line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demo-memory-maintainer-"));
  try {
    const memory = await createLongMemoryStore(directory);
    let calls = 0;
    const maintainer = await createLongMemoryMaintainer({ dataDir: directory, memory, analyzeJson: async () => {
      calls++;
      return [{ op: "add", section: "people", text: "李明：本次负责供应商协调", evidence_lines: [2] }];
    } });
    const meeting = { id: "meeting-a", sessionId: "session-a", status: "completed", meetingTime: null,
      analysis: { facts: { people: [{ content: "李明负责协调", evidence_lines: [2] }], topics: [] } } };
    await maintainer.recordMeeting(meeting);
    await until(async () => maintainer.pendingProposals().length === 1 &&
      (await readFile(join(directory, "memory", "processed-meetings.json"), "utf8")).includes("meeting-a"));
    await maintainer.recordMeeting(meeting);
    assert.equal(calls, 1);
    assert.equal(memory.snapshot().version, 0);
    assert.deepEqual(maintainer.pendingProposals()[0].source.lines, [2]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
