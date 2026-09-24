import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createMeetingStore } from "./meeting-store.mjs";
import { createMeetingWorkflow, validateRisks } from "./meeting-workflow.mjs";

const facts = {
  summary: "讨论供应商到货时间。",
  people: [{ content: "李明", evidence_lines: [2] }],
  times: [{ content: "10月15日", evidence_lines: [2] }],
  locations: [], topics: ["交付"], decisions: [],
  facts: [{ content: "供应商预计10月15日到货", evidence_lines: [2] }],
  explicit_action_items: [{ task: "李明联系供应商", owner: "李明", deadline: "", evidence_lines: [3] }],
  uncertainties: [],
};

async function fixture(analyzeJson, deliverMail) {
  const dataDir = await mkdtemp(join(tmpdir(), "meeting-workflow-"));
  const agentDir = join(dataDir, "agent");
  await mkdir(agentDir);
  const store = createMeetingStore(dataDir);
  const workflow = await createMeetingWorkflow({ store, agentDir, modelId: null, analyzeJson, deliverMail });
  const sessionId = "session-1";
  const text = "张三：讨论交付。\n李明：供应商预计10月15日到货。\n张三：李明联系供应商。";
  const meeting = await store.upload(sessionId, Readable.from([Buffer.from(text)]), "周会.txt", null);
  return { dataDir, store, workflow, sessionId, meeting };
}

async function finished(workflow, sessionId, id) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const item = await workflow.get(sessionId, id);
    if (["completed", "awaiting_confirmation", "failed"].includes(item.status)) return item;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("后台任务未完成");
}

test("无风险会议结束，不生成风险邮件", async () => {
  const scope = await fixture(async (kind) => kind === "facts" ? facts : { risks: [], suggested_todos: [] });
  try {
    assert.deepEqual(await scope.workflow.submit(scope.sessionId, scope.meeting.id), { job_id: scope.meeting.id, status: "queued" });
    const item = await finished(scope.workflow, scope.sessionId, scope.meeting.id);
    assert.equal(item.status, "completed");
    assert.equal(item.email, null);
    assert.equal(item.todos.explicit[0].task, "李明联系供应商");
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("重复上传同一会议复用任务，不生成第二份记录", async () => {
  const scope = await fixture(async (kind) => kind === "facts" ? facts : { risks: [], suggested_todos: [] });
  try {
    const duplicate = await scope.store.upload(scope.sessionId, Readable.from([Buffer.from(scope.meeting.rawText)]), "另一个文件名.txt", null);
    assert.equal(duplicate.id, scope.meeting.id);
    assert.equal((await scope.store.list(scope.sessionId)).length, 1);
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("有风险会议保留证据，确认后只发送一次", async () => {
  const sent = [];
  const scope = await fixture(async (kind) => {
    if (kind === "facts") return facts;
    if (kind === "risks") return {
      risks: [{ title: "交付依赖", description: "供应商预计10月15日到货", category: "dependency", reason: "到货时间需要关注", uncertainty: "项目期限未知", evidence_lines: [2] }],
      suggested_todos: [{ task: "确认交付计划", owner: "", deadline: "", reason: "到货时间存在不确定性", evidence_lines: [2] }],
    };
    return { subject: "交付风险", body: "请关注供应商预计10月15日到货。" };
  }, async (message) => { sent.push(message); return { accepted: [message.to], messageId: "test-id" }; });
  try {
    await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    const item = await finished(scope.workflow, scope.sessionId, scope.meeting.id);
    assert.equal(item.status, "awaiting_confirmation");
    assert.deepEqual(item.analysis.risks[0].evidence_lines, [2]);
    assert.equal(item.todos.suggested[0].owner, "");
    const revised = await scope.workflow.updateDraft(scope.sessionId, scope.meeting.id, "修改后的标题", "修改后的正文");
    assert.equal(revised.version, 2);
    assert.equal(revised.revisions[0].subject, "交付风险");
    const result = await scope.workflow.send(scope.sessionId, scope.meeting.id, "user@example.com");
    assert.equal(result.status, "sent");
    assert.equal(sent[0].subject, "修改后的标题");
    await scope.workflow.send(scope.sessionId, scope.meeting.id, "another@example.com");
    assert.equal(sent.length, 1);
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("风险行号不能超出会议原文", () => {
  assert.throws(() => validateRisks({
    risks: [{ title: "x", description: "x", category: "other", reason: "x", uncertainty: "", evidence_lines: [999] }],
    suggested_todos: [],
  }, 3), /行号超出原文/);
});

test("并发确认发送只允许一封邮件", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const scope = await fixture(async (kind) => kind === "facts" ? facts : kind === "risks" ? {
    risks: [{ title: "供货依赖", description: "预计到货时间不确定", category: "dependency", reason: "需核实", uncertainty: "实际日期", evidence_lines: [2] }],
    suggested_todos: [],
  } : { subject: "风险通知", body: "请核实到货时间。" }, async (message) => {
    sent.push(message);
    await gate;
    return { accepted: [message.to], messageId: "one" };
  });
  try {
    await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    await finished(scope.workflow, scope.sessionId, scope.meeting.id);
    const first = scope.workflow.send(scope.sessionId, scope.meeting.id, "one@example.com");
    await assert.rejects(scope.workflow.send(scope.sessionId, scope.meeting.id, "two@example.com"), /正在发送/);
    release();
    await first;
    assert.equal(sent.length, 1);
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("真实 SMTP 传输提交邮件并记录服务器接受结果", async () => {
  const received = [];
  const server = createServer((socket) => {
    socket.write("220 local-test ESMTP\r\n");
    let buffer = "";
    let dataMode = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (dataMode) {
          if (line === ".") { dataMode = false; socket.write("250 queued as local-id\r\n"); }
          else received.push(line);
        } else if (/^EHLO /i.test(line)) socket.write("250 local-test\r\n");
        else if (/^MAIL FROM:/i.test(line) || /^RCPT TO:/i.test(line)) socket.write("250 accepted\r\n");
        else if (line === "DATA") { dataMode = true; socket.write("354 send data\r\n"); }
        else if (line === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = {
    host: process.env.MEETING_SMTP_HOST, port: process.env.MEETING_SMTP_PORT,
    from: process.env.MEETING_SMTP_FROM, user: process.env.MEETING_SMTP_USER,
  };
  process.env.MEETING_SMTP_HOST = "127.0.0.1";
  process.env.MEETING_SMTP_PORT = String(server.address().port);
  process.env.MEETING_SMTP_FROM = "demo@example.test";
  delete process.env.MEETING_SMTP_USER;
  const scope = await fixture(async (kind) => kind === "facts" ? facts : kind === "risks" ? {
    risks: [{ title: "供货依赖", description: "预计到货时间待确认", category: "dependency", reason: "需核实", uncertainty: "实际日期", evidence_lines: [2] }],
    suggested_todos: [],
  } : { subject: "项目风险", body: "请核实到货时间。" });
  try {
    await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    await finished(scope.workflow, scope.sessionId, scope.meeting.id);
    const result = await scope.workflow.send(scope.sessionId, scope.meeting.id, "recipient@example.test");
    assert.equal(result.status, "sent");
    assert.match(received.join("\n"), /recipient@example.test/);
    assert.equal((await scope.workflow.get(scope.sessionId, scope.meeting.id)).email.status, "sent");
  } finally {
    await rm(scope.dataDir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      const name = `MEETING_SMTP_${key.toUpperCase()}`;
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("重启恢复排队任务，发送中断时不自动重发", async () => {
  const scope = await fixture(async (kind) => kind === "facts" ? facts : { risks: [], suggested_todos: [] });
  try {
    await scope.store.update(scope.sessionId, scope.meeting.id, { status: "queued" });
    await scope.workflow.recover();
    assert.equal((await finished(scope.workflow, scope.sessionId, scope.meeting.id)).status, "completed");
    await scope.store.update(scope.sessionId, scope.meeting.id, {
      status: "sending", email: { subject: "test", body: "test", status: "sending" },
    });
    await scope.workflow.recover();
    const recovered = await scope.workflow.get(scope.sessionId, scope.meeting.id);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.email.status, "delivery_unknown");
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});
