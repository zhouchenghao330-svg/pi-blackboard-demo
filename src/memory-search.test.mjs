import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { searchMemory, searchMemoryEntries } from "./memory-search.mjs";

test("跨会话检索返回会议原文行号和按时间排列的对话片段", () => {
  const matches = searchMemoryEntries({
    meetingRecords: [{ id: "meeting-1", sessionId: "old-session", name: "南京项目周会",
      uploadedAt: "2026-09-01T10:00:00Z", meetingTime: "2026-09-01",
      rawText: "李明负责联系供应商。\n会议地点南京。",
      analysis: { facts: { summary: "南京项目交付安排", people: [{ content: "李明", evidence_lines: [1] }],
        times: [], locations: [{ content: "南京", evidence_lines: [2] }], topics: ["交付"], decisions: [] } },
      todos: { explicit: [{ id: "explicit-1", task: "联系供应商", owner: "李明", status: "done" }], suggested: [] } }],
    conversationEntries: [{ sessionId: "new-session", timestamp: "2026-09-02T10:00:00Z", role: "user",
      text: "南京项目的供应商后来由王敏联系。" }],
  }, "南京项目供应商谁负责");
  assert.equal(matches.length, 2);
  assert.equal(matches[0].source, "meeting");
  assert.deepEqual(matches[0].matching_lines[0], { line: 1, text: "李明负责联系供应商。" });
  assert.equal(matches[1].role, "user");
  assert.match(matches[1].excerpt, /王敏/);
});

test("新会话能读取已有会话的持久化用户消息", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demo-memory-"));
  const sessionDir = join(directory, "sessions");
  try {
    const old = SessionManager.create(directory, sessionDir);
    old.appendMessage({ role: "user", content: "在南京讨论项目时，李明负责联系供应商。", timestamp: Date.now() });
    old.appendMessage({ role: "assistant", content: [{ type: "text", text: "已记录。" }], timestamp: Date.now() });
    const newer = SessionManager.create(directory, sessionDir);
    newer.appendMessage({ role: "user", content: "后来改由王敏联系供应商。", timestamp: Date.now() });
    newer.appendMessage({ role: "assistant", content: [{ type: "text", text: "已更新。" }], timestamp: Date.now() });
    const result = await searchMemory({ meetings: { all: async () => [] }, cwd: directory, sessionDir, query: "供应商由谁联系" });
    assert.equal(result.matches.length, 2);
    assert.ok(result.matches.some((item) => item.session_id === old.getSessionId()));
    assert.ok(result.matches.some((item) => item.session_id === newer.getSessionId()));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
