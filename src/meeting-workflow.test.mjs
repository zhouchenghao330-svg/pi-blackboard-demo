import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createMeetingStore } from "./meeting-store.mjs";
import { createMeetingWorkflow, normalizePolicy, validateFacts } from "./meeting-workflow.mjs";

const facts = {
  summary: "讨论供应商到货时间。",
  people: [{ content: "李明", evidence_lines: [2] }],
  times: [{ content: "10月15日", evidence_lines: [2] }],
  locations: [], topics: ["交付"], decisions: [],
  facts: [{ content: "供应商预计10月15日到货", evidence_lines: [2] }],
  explicit_action_items: [{ task: "李明联系供应商", owner: "李明", deadline: "", evidence_lines: [3] }],
  uncertainties: [],
};

function candidate(overrides = {}) {
  return {
    title: "到货依赖", hypothesis: "到货时间可能影响后续工作", category: "dependency",
    evidence_lines: [2], question: "联调基准日期是什么", ...overrides,
  };
}

function analyzer({ discovery = [], additions = [], todos = [], failKind, calls = [] } = {}) {
  return async (kind, payload) => {
    calls.push({ kind, policy: payload.analysisPolicy, candidates: payload.candidates });
    if (kind === failKind) throw new Error("模拟分析失败");
    if (kind === "facts") return facts;
    if (kind === "discovery") return { candidates: discovery };
    if (kind === "verification") return { results: payload.candidates.map((item) => ({
      candidate_id: item.id, verdict: item.testVerdict || "verified", duplicate_of: "", reason: "对照原文核验",
      final_title: item.title, final_claim: item.hypothesis,
      missing_information: item.testVerdict === "uncertain" ? "缺少项目基准日期" : "",
      supporting_lines: item.testVerdict === "rejected" ? [] : item.evidence_lines,
      counter_evidence_lines: item.testVerdict === "rejected" ? [3] : [],
    })) };
    if (kind === "coverage") return { coverage_notes: [{ dimension: "交付", result: "已检查" }], candidates: additions };
    if (kind === "todos") return { suggested_todos: todos };
    if (kind === "email") return { subject: "项目风险", body: "请核实到货时间。" };
    throw new Error(`未识别阶段 ${kind}`);
  };
}

async function fixture(analyzeJson, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "meeting-workflow-"));
  const agentDir = join(dataDir, "agent");
  await mkdir(agentDir);
  const store = createMeetingStore(dataDir);
  const workflow = await createMeetingWorkflow({ store, agentDir, modelId: null, analyzeJson, ...options });
  const sessionId = "session-1";
  const text = "张三：讨论交付。\n李明：供应商预计10月15日到货。\n张三：李明联系供应商。";
  const meeting = await store.upload(sessionId, Readable.from([Buffer.from(text)]), "周会.txt", null);
  return { dataDir, store, workflow, sessionId, meeting };
}

async function finished(workflow, sessionId, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const item = await workflow.get(sessionId, id);
    if (["completed", "awaiting_confirmation", "failed"].includes(item.status)) return item;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("后台任务未完成");
}

test("无风险仍做补漏，保留明确待办并发送隐藏通知", async () => {
  const calls = [];
  const notices = [];
  const scope = await fixture(analyzer({ calls }));
  scope.workflow.setNotifier(async (...args) => notices.push(args));
  try {
    const submitted = await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    const item = await finished(scope.workflow, scope.sessionId, submitted.job_id);
    assert.equal(item.status, "completed");
    assert.equal(item.email, null);
    assert.equal(item.todos.explicit[0].task, "李明联系供应商");
    assert.deepEqual(calls.map((call) => call.kind), ["facts", "discovery", "coverage"]);
    assert.deepEqual(notices, [[scope.sessionId, submitted.job_id]]);
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("会议待办可完成、重新打开并保留变更记录", async () => {
  const scope = await fixture(analyzer());
  try {
    await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    await finished(scope.workflow, scope.sessionId, scope.meeting.id);
    const done = await scope.workflow.updateTodo(scope.sessionId, scope.meeting.id, "explicit-1", { status: "done" });
    assert.equal(done.status, "done");
    const reopened = await scope.workflow.updateTodo(scope.sessionId, scope.meeting.id, "explicit-1", {
      status: "open", owner: "王敏",
    });
    assert.equal(reopened.owner, "王敏");
    assert.deepEqual(reopened.updates.map((item) => item.status), ["done", "open"]);
    await assert.rejects(scope.workflow.updateTodo(scope.sessionId, scope.meeting.id, "explicit-9", { status: "done" }), /不存在/);
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("同一 TXT 不同关注点独立保存，同一关注点复用", async () => {
  const calls = [];
  const scope = await fixture(analyzer({ calls }));
  try {
    const duplicate = await scope.store.upload(scope.sessionId, Readable.from([Buffer.from(scope.meeting.rawText)]), "重复.txt", null);
    assert.equal(duplicate.id, scope.meeting.id);
    const budget = await scope.workflow.submit(scope.sessionId, scope.meeting.id, {
      risk_focus: ["预算异常"], risk_focus_source: "user", risk_focus_reason: "用户要求重点检查预算",
    });
    await finished(scope.workflow, scope.sessionId, budget.job_id);
    const same = await scope.workflow.submit(scope.sessionId, scope.meeting.id, { risk_focus: ["预算异常"] });
    assert.equal(same.job_id, budget.job_id);
    const schedule = await scope.workflow.submit(scope.sessionId, scope.meeting.id, { risk_focus: ["交付节点"] });
    assert.notEqual(schedule.job_id, budget.job_id);
    const second = await finished(scope.workflow, scope.sessionId, schedule.job_id);
    assert.equal(second.sourceMeetingId, scope.meeting.id);
    assert.deepEqual(second.analysisPolicy.riskFocus, ["交付节点"]);
    assert.deepEqual((await scope.workflow.get(scope.sessionId, budget.job_id)).analysisPolicy.riskFocus, ["预算异常"]);
    assert.equal((await scope.store.list(scope.sessionId)).length, 2);
    assert.ok(calls.filter((call) => call.kind === "discovery").every((call) => call.policy?.riskFocus.length === 1));
    const only = await scope.workflow.submit(scope.sessionId, scope.meeting.id, {
      risk_focus: ["预算异常"], focus_mode: "only", risk_focus_source: "user",
    });
    assert.notEqual(only.job_id, budget.job_id);
    await finished(scope.workflow, scope.sessionId, only.job_id);
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("候选经独立核验和补漏，排除反证，待办允许为空", async () => {
  const calls = [];
  const scope = await fixture(analyzer({
    calls,
    discovery: [candidate({ testVerdict: "rejected" })],
    additions: [candidate({ title: "责任待确认", category: "ownership", evidence_lines: [3], testVerdict: "uncertain" })],
  }));
  try {
    const submitted = await scope.workflow.submit(scope.sessionId, scope.meeting.id, { risk_focus: ["责任归属"] });
    const item = await finished(scope.workflow, scope.sessionId, submitted.job_id);
    assert.equal(item.status, "awaiting_confirmation");
    assert.equal(item.analysis.review.verified.length, 2);
    assert.equal(item.analysis.review.verified[0].verdict, "rejected");
    assert.deepEqual(item.analysis.review.verified[0].counter_evidence_lines, [3]);
    assert.equal(item.analysis.risks.length, 1);
    assert.equal(item.analysis.risks[0].verdict, "uncertain");
    assert.deepEqual(item.todos.suggested, []);
    assert.equal(calls.filter((call) => call.kind === "verification").length, 2);
    for (const call of calls.filter((item) => ["discovery", "verification", "coverage"].includes(item.kind))) {
      assert.deepEqual(call.policy.riskFocus, ["责任归属"]);
    }
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("最终风险使用核验后的表述，互相重复的候选不能全部删除", async () => {
  const base = analyzer({ discovery: [candidate({ title: "整体交付延期" })] });
  const scope = await fixture(async (kind, payload) => {
    if (kind === "verification") return { results: payload.candidates.map((item) => ({
      candidate_id: item.id, verdict: "uncertain", final_title: "可选演示排期待确认",
      final_claim: "会议没有确认可选演示的安排，不应称整体交付延期", duplicate_of: "",
      reason: "后文缩小了影响范围", missing_information: "可选演示日期",
      supporting_lines: [2], counter_evidence_lines: [3],
    })) };
    return base(kind, payload);
  });
  try {
    const submitted = await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    const item = await finished(scope.workflow, scope.sessionId, submitted.job_id);
    assert.equal(item.analysis.risks[0].title, "可选演示排期待确认");
    assert.match(item.analysis.risks[0].description, /不应称整体交付延期/);
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }

  const cycle = await fixture(async (kind, payload) => {
    if (kind === "discovery") return { candidates: [candidate(), candidate({ title: "另一个候选" })] };
    if (kind === "verification") return { results: payload.candidates.map((item, index) => ({
      candidate_id: item.id, verdict: "rejected", final_title: "", final_claim: "",
      duplicate_of: payload.candidates[1 - index].id, reason: "重复", missing_information: "",
      supporting_lines: [], counter_evidence_lines: [],
    })) };
    return analyzer()(kind, payload);
  });
  try {
    const submitted = await cycle.workflow.submit(cycle.sessionId, cycle.meeting.id);
    const item = await finished(cycle.workflow, cycle.sessionId, submitted.job_id);
    assert.equal(item.status, "failed");
    assert.match(item.error, /重复候选必须指向最终保留/);
  } finally { await rm(cycle.dataDir, { recursive: true, force: true }); }
});

test("草稿可清空且不可发送，补全后只发送一次", async () => {
  const sent = [];
  const scope = await fixture(analyzer({ discovery: [candidate()] }), {
    deliverMail: async (message) => { sent.push(message); return { accepted: [message.to], messageId: "test-id" }; },
  });
  try {
    const submitted = await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    await finished(scope.workflow, scope.sessionId, submitted.job_id);
    const empty = await scope.workflow.updateDraft(scope.sessionId, submitted.job_id, "", "", undefined, 1);
    assert.equal(empty.version, 2);
    assert.equal(empty.status, "incomplete");
    assert.equal(empty.revisions[0].subject, "项目风险");
    await assert.rejects(scope.workflow.send(scope.sessionId, submitted.job_id, "user@example.com", 2), /未完成/);
    await scope.workflow.updateDraft(scope.sessionId, submitted.job_id, "新版标题", "新版正文", undefined, 2);
    await assert.rejects(scope.workflow.send(scope.sessionId, submitted.job_id, "user@example.com", 2), /版本已变化/);
    await assert.rejects(scope.workflow.updateDraft(scope.sessionId, submitted.job_id, "过期标题", "过期正文", undefined, 2), /版本已变化/);
    const result = await scope.workflow.send(scope.sessionId, submitted.job_id, "user@example.com", 3);
    assert.equal(result.status, "sent");
    assert.equal(sent[0].subject, "新版标题");
    await assert.rejects(scope.workflow.send(scope.sessionId, submitted.job_id, "other@example.com", 3), /其他收件人/);
    assert.equal(sent.length, 1);
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("会议本身无风险时，带会议行和 PDF 原页的补充可创建草稿", async () => {
  const documents = { async requireDocument(_sessionId, id) {
    assert.equal(id, "pdf-1");
    return { status: "ready", pageCount: 5 };
  } };
  const scope = await fixture(analyzer(), { documents });
  try {
    const submitted = await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    await finished(scope.workflow, scope.sessionId, submitted.job_id);
    await assert.rejects(scope.workflow.updateDraft(scope.sessionId, submitted.job_id, "标题", "正文"), /背景补充/);
    await scope.workflow.updateDraft(scope.sessionId, submitted.job_id, "交付冲突", "请核实排期。", {
      content: "会议预计 15 日到货，PDF 第 2 页写明 10 日验收。",
      meeting_lines: [2], pdf_sources: [{ document_id: "pdf-1", page: 2 }],
    });
    const item = await scope.workflow.get(scope.sessionId, submitted.job_id);
    assert.equal(item.analysis.risks.length, 0);
    assert.equal(item.agentEnrichments.length, 1);
    assert.equal(item.email.source, "agent_enrichment");
    assert.equal(item.status, "awaiting_confirmation");
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("分析失败也通知；非法核验行号使任务失败", async () => {
  const notices = [];
  const scope = await fixture(async (kind, payload) => {
    if (kind === "verification") return { results: [{
      candidate_id: payload.candidates[0].id, verdict: "verified", duplicate_of: "", reason: "错误行号",
      final_title: "到货依赖", final_claim: "到货时间可能影响后续工作",
      missing_information: "", supporting_lines: [999], counter_evidence_lines: [],
    }] };
    return analyzer({ discovery: [candidate()] })(kind, payload);
  });
  scope.workflow.setNotifier(async (...args) => notices.push(args));
  try {
    const submitted = await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    const item = await finished(scope.workflow, scope.sessionId, submitted.job_id);
    assert.equal(item.status, "failed");
    assert.match(item.error, /行号超出原文/);
    assert.deepEqual(notices, [[scope.sessionId, submitted.job_id]]);
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("SMTP 预检失败保留草稿，修复后可重试", async () => {
  let available = false;
  const sent = [];
  const scope = await fixture(analyzer({ discovery: [candidate()] }), {
    verifyMail: async () => { if (!available) throw new Error("认证失败"); },
    deliverMail: async (message) => { sent.push(message); return { accepted: [message.to], messageId: "retry" }; },
  });
  try {
    const submitted = await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    await finished(scope.workflow, scope.sessionId, submitted.job_id);
    await assert.rejects(scope.workflow.send(scope.sessionId, submitted.job_id, "user@example.com", 1), /认证失败/);
    assert.equal((await scope.workflow.get(scope.sessionId, submitted.job_id)).email.status, "draft");
    available = true;
    assert.equal((await scope.workflow.send(scope.sessionId, submitted.job_id, "user@example.com", 1)).status, "sent");
    assert.equal(sent.length, 1);
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("发送结果不明时不自动重发，人工确认后才恢复", async () => {
  let fail = true;
  const scope = await fixture(analyzer({ discovery: [candidate()] }), {
    deliverMail: async (message) => {
      if (fail) throw new Error("DATA 后断线");
      return { accepted: [message.to], messageId: "recovered" };
    },
  });
  try {
    const submitted = await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    await finished(scope.workflow, scope.sessionId, submitted.job_id);
    await assert.rejects(scope.workflow.send(scope.sessionId, submitted.job_id, "user@example.com", 1), /DATA 后断线/);
    assert.equal((await scope.workflow.get(scope.sessionId, submitted.job_id)).email.status, "delivery_unknown");
    await assert.rejects(scope.workflow.send(scope.sessionId, submitted.job_id, "user@example.com", 1), /人工核查/);
    fail = false;
    await scope.workflow.acknowledgeUndelivered(scope.sessionId, submitted.job_id);
    assert.equal((await scope.workflow.send(scope.sessionId, submitted.job_id, "user@example.com", 1)).status, "sent");
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("本地 SMTP 接受邮件并记录结果", async () => {
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
  const previous = Object.fromEntries(["HOST", "PORT", "FROM", "USER"].map((key) => [key, process.env[`MEETING_SMTP_${key}`]]));
  process.env.MEETING_SMTP_HOST = "127.0.0.1";
  process.env.MEETING_SMTP_PORT = String(server.address().port);
  process.env.MEETING_SMTP_FROM = "demo@example.test";
  delete process.env.MEETING_SMTP_USER;
  const scope = await fixture(analyzer({ discovery: [candidate()] }));
  try {
    const submitted = await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    await finished(scope.workflow, scope.sessionId, submitted.job_id);
    assert.equal((await scope.workflow.send(scope.sessionId, submitted.job_id, "recipient@example.test", 1)).status, "sent");
    assert.match(received.join("\n"), /recipient@example.test/);
  } finally {
    await rm(scope.dataDir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[`MEETING_SMTP_${key}`];
      else process.env[`MEETING_SMTP_${key}`] = value;
    }
  }
});

test("规则输入和恢复状态有明确边界", async () => {
  assert.throws(() => normalizePolicy({ risk_focus: ["x".repeat(101)] }), /审查重点/);
  assert.equal(normalizePolicy({ risk_focus: ["3D 设备安全"], risk_focus_source: "agent" }).riskFocus[0], "3D 设备安全");
  assert.throws(() => normalizePolicy({ risk_focus: ["预算"], focus_mode: "only", risk_focus_source: "agent" }), /审查重点/);
  assert.equal(normalizePolicy({ risk_focus: ["预算"], focus_mode: "only", risk_focus_source: "user" }).focusMode, "only");
  const scope = await fixture(analyzer());
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

test("重启后从已保存的风险核验结果继续，不重做前面阶段", async () => {
  const scope = await fixture(analyzer({ discovery: [candidate()], failKind: "coverage" }));
  try {
    const submitted = await scope.workflow.submit(scope.sessionId, scope.meeting.id);
    const failed = await finished(scope.workflow, scope.sessionId, submitted.job_id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.analysis.review.verified.length, 1);
    await scope.store.update(scope.sessionId, submitted.job_id, { status: "checking_coverage", error: null });
    const calls = [];
    const restarted = await createMeetingWorkflow({
      store: scope.store, agentDir: join(scope.dataDir, "agent"), modelId: null,
      analyzeJson: analyzer({ calls }),
    });
    await restarted.recover();
    const resumed = await finished(restarted, scope.sessionId, submitted.job_id);
    assert.equal(resumed.status, "awaiting_confirmation");
    assert.deepEqual(calls.map((call) => call.kind), ["coverage", "todos", "email"]);
  } finally { await rm(scope.dataDir, { recursive: true, force: true }); }
});

test("事实记录必须带原文行号", () => {
  assert.throws(() => validateFacts({ ...facts, facts: [{ content: "未提供依据", evidence_lines: [] }] }, 3), /缺少原文依据/);
});
