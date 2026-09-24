import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentService } from "./agent-service.mjs";
import { configurePi } from "./configure-pi.mjs";
import { createDocumentStore } from "./document-store.mjs";
import { createMeetingStore } from "./meeting-store.mjs";
import { createMeetingWorkflow } from "./meeting-workflow.mjs";
import { createPdfService } from "./pdf-service.mjs";
import { createPptStore } from "./ppt-store.mjs";
import { createSlotStore } from "./slot-store.mjs";
import { createLongMemoryStore } from "./long-memory-store.mjs";
import { createLongMemoryMaintainer } from "./long-memory-maintainer.mjs";

const dataDir = process.env.DEMO_DATA_DIR || "/data";
const agentDir = process.env.PI_CODING_AGENT_DIR || join(dataDir, "pi-agent");
await Promise.all([
  mkdir(join(dataDir, "uploads"), { recursive: true }),
  mkdir(join(dataDir, "outputs"), { recursive: true }),
]);
const configuredModel = await configurePi();
const documents = createDocumentStore(dataDir);
const pdfService = createPdfService(documents);
const meetings = createMeetingStore(dataDir);
const ppts = createPptStore(dataDir);
const slots = createSlotStore(dataDir, { documents, meetings, ppts });
const memory = await createLongMemoryStore(dataDir);
const memoryMaintainer = await createLongMemoryMaintainer({ dataDir, agentDir, modelId: configuredModel.modelId, memory });
const meetingWorkflow = await createMeetingWorkflow({ store: meetings, documents, agentDir, modelId: configuredModel.modelId });
const agent = await createAgentService({ dataDir, agentDir, modelId: configuredModel.modelId, documents, meetings, meetingWorkflow, pdfService, ppts, slots, memory, memoryMaintainer });
meetingWorkflow.setNotifier(async (sessionId, jobId) => {
  const meeting = await meetings.requireMeeting(sessionId, jobId);
  const results = await Promise.allSettled([
    agent.notifyMeeting(sessionId, jobId),
    memoryMaintainer.recordMeeting(meeting),
  ]);
  for (const result of results) if (result.status === "rejected") console.error("Meeting completion handler failed:", result.reason);
});
await meetingWorkflow.recover();
void pdfService.recover().catch((error) => console.error("PDF recovery failed:", error));
let memoryProposalPollRunning = false;
setInterval(async () => {
  if (memoryProposalPollRunning) return;
  memoryProposalPollRunning = true;
  try {
    const bySession = new Map();
    for (const proposal of memoryMaintainer.pendingProposals()) {
      if (!bySession.has(proposal.sessionId)) bySession.set(proposal.sessionId, []);
      bySession.get(proposal.sessionId).push(proposal);
    }
    for (const [sessionId, proposals] of bySession) {
      const batch = proposals.slice(0, 12);
      try {
        await agent.notifyMemory(sessionId, batch);
        await memoryMaintainer.markDelivered(batch.map((item) => item.proposalId));
      } catch (error) {
        if (error.code === "SESSION_NOT_FOUND") await memoryMaintainer.forgetSession(sessionId);
        else console.error("Memory proposal delivery failed", error);
      }
    }
  } catch (error) { console.error("Memory proposal poll failed", error); }
  finally { memoryProposalPollRunning = false; }
}, 2000);
let pdfNotificationPollRunning = false;
setInterval(async () => {
  if (pdfNotificationPollRunning) return;
  pdfNotificationPollRunning = true;
  try {
    const bySession = new Map();
    for (const document of await documents.all()) {
      if (!["ready", "failed"].includes(document.status) || !document.notificationPending) continue;
      if (!bySession.has(document.sessionId)) bySession.set(document.sessionId, []);
      bySession.get(document.sessionId).push(document.id);
    }
    for (const [sessionId, documentIds] of bySession) {
      await agent.notifyPdf(sessionId, documentIds);
      await Promise.all(documentIds.map((documentId) => documents.update(sessionId, documentId, {
        notificationPending: false, notifiedAt: new Date().toISOString(),
      })));
    }
  } catch (error) { console.error("PDF completion poll failed", error); }
  finally { pdfNotificationPollRunning = false; }
}, 2000);
let pptNotificationPollRunning = false;
setInterval(async () => {
  if (pptNotificationPollRunning) return;
  pptNotificationPollRunning = true;
  try {
    for (const job of await ppts.all()) {
      if (!["ready", "failed"].includes(job.status) || !job.notificationPending) continue;
      await agent.notifyPpt(job.sessionId, job.id);
      await ppts.update(job.id, { notificationPending: false, notifiedAt: new Date().toISOString() });
    }
  } catch (error) { console.error("PPT completion poll failed", error); }
  finally { pptNotificationPollRunning = false; }
}, 2000);
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT || 3000);

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/markdown-it.mjs", ["../node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function presentPpt(job) {
  return {
    id: job.id, brief: job.brief, pageCount: job.pageCount, pagesCreated: job.pagesCreated,
    status: job.status, progress: job.progress, createdAt: job.createdAt,
    updatedAt: job.updatedAt, filename: job.filename || null, error: job.error,
  };
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) {
      throw Object.assign(new Error("请求内容过大"), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求 JSON 无效"), { status: 400 });
  }
}

function parsePrompt(body) {
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const inputImages = body?.images ?? [];
  const files = body?.files ?? [];
  const meetingIds = body?.meetings ?? [];
  if (!Array.isArray(files) || files.length > 3 || files.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
    throw Object.assign(new Error("每次最多附加 3 份已上传的 PDF"), { status: 400 });
  }
  if (!Array.isArray(inputImages) || inputImages.length > 3) {
    throw Object.assign(new Error("每次最多附加 3 张图片"), { status: 400 });
  }
  if (!Array.isArray(meetingIds) || meetingIds.length > 3 || meetingIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
    throw Object.assign(new Error("每次最多附加 3 份会议 TXT"), { status: 400 });
  }
  const images = inputImages.map((image) => {
    if (
      !image ||
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType) ||
      typeof image.data !== "string" ||
      image.data.length > 5 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    ) {
      throw Object.assign(new Error("图片格式或大小不受支持"), { status: 400 });
    }
    return { type: "image", mimeType: image.mimeType, data: image.data };
  });
  if ((!text && images.length === 0 && files.length === 0 && meetingIds.length === 0) || text.length > 12_000) {
    throw Object.assign(new Error("请输入不超过 12000 字的消息"), { status: 400 });
  }
  return { text: text || (meetingIds.length ? "请提交会议 TXT 分析任务。" : files.length ? "请解析上传的 PDF 并建立 Blackboard。" : "请描述这些图片。"), images, files, meetingIds };
}

async function route(request, response) {
  const url = new URL(request.url || "/", "http://localhost");
  const pathname = url.pathname;
  const method = request.method || "GET";

  if (method === "GET" && pathname === "/health") {
    json(response, 200, { status: "ok", piSdk: true, modelConfigured: Boolean(agent.model) });
    return;
  }
  if (method === "GET" && pathname === "/api/status") {
    json(response, 200, { model: agent.model, thinkingLevels: agent.thinkingLevels });
    return;
  }
  if (method === "GET" && pathname === "/api/memory") {
    const sessionId = url.searchParams.get("session_id");
    json(response, 200, { memory: memory.snapshot(), history: memory.history(100, sessionId) });
    return;
  }
  if (method === "GET" && pathname === "/api/sessions") {
    json(response, 200, { sessions: await agent.listSessions() });
    return;
  }
  if (method === "POST" && pathname === "/api/sessions") {
    json(response, 201, { session: await agent.createSession() });
    return;
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "sessions" && /^[0-9a-f-]{36}$/i.test(parts[2] || "")) {
    const id = parts[2];
    if (method === "GET" && parts.length === 3) {
      const session = await agent.getSession(id);
      json(response, session ? 200 : 404, session ? { session } : { error: "会话不存在" });
      return;
    }
    if (method === "DELETE" && parts.length === 3) {
      json(response, 200, await agent.deleteSession(id));
      return;
    }
    if (method === "GET" && parts[3] === "events" && parts.length === 4) {
      if (!await agent.getSession(id)) { json(response, 404, { error: "会话不存在" }); return; }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "connection": "keep-alive",
        "x-content-type-options": "nosniff",
      });
      response.write("data: {\"type\":\"ready\"}\n\n");
      const unsubscribe = await agent.subscribeEvents(id, (event) => {
        if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => {
        if (!response.destroyed) response.write(": keep-alive\n\n");
      }, 15000);
      response.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
      return;
    }
    if (method === "POST" && parts[3] === "abort" && parts.length === 4) {
      json(response, 200, { aborted: await agent.abort(id) });
      return;
    }
    if (method === "GET" && parts[3] === "documents" && parts.length === 4) {
      if (!await agent.getSession(id)) { json(response, 404, { error: "会话不存在" }); return; }
      json(response, 200, { documents: await documents.list(id) });
      return;
    }
    if (method === "GET" && parts[3] === "slots" && parts.length === 4) {
      if (!await agent.getSession(id)) { json(response, 404, { error: "会话不存在" }); return; }
      json(response, 200, { slots: await slots.sync(id) });
      return;
    }
    if (method === "GET" && parts[3] === "meetings" && parts.length === 4) {
      if (!await agent.getSession(id)) { json(response, 404, { error: "会话不存在" }); return; }
      const items = await meetings.list(id);
      json(response, 200, { meetings: items.map(({ rawText, ...item }) => item) });
      return;
    }
    if (method === "GET" && parts[3] === "ppts" && parts.length === 4) {
      if (!await agent.getSession(id)) { json(response, 404, { error: "会话不存在" }); return; }
      json(response, 200, { jobs: (await ppts.list(id)).map(presentPpt) });
      return;
    }
    if (method === "POST" && parts[3] === "ppts" && parts.length === 4) {
      if (!await agent.getSession(id)) { json(response, 404, { error: "会话不存在" }); return; }
      const job = await ppts.submit(id, await readJson(request));
      await slots.sync(id);
      json(response, 202, { job: presentPpt(job) });
      return;
    }
    if (method === "GET" && parts[3] === "ppts" && /^[0-9a-f-]{36}$/i.test(parts[4] || "") && parts.length === 5) {
      json(response, 200, { job: presentPpt(await ppts.requireJob(id, parts[4])) });
      return;
    }
    if (method === "GET" && parts[3] === "ppts" && /^[0-9a-f-]{36}$/i.test(parts[4] || "") && parts[5] === "download" && parts.length === 6) {
      const job = await ppts.requireJob(id, parts[4]);
      const root = resolve(join(dataDir, "ppt-projects"));
      const output = job.outputPath && resolve(job.outputPath);
      if (job.status !== "ready" || !output || !output.startsWith(`${root}${sep}`) || !output.endsWith(".pptx")) {
        throw Object.assign(new Error("PPT 文件尚未就绪"), { status: 404 });
      }
      const info = await stat(output);
      response.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "content-length": info.size,
        "content-disposition": `attachment; filename="presentation-${job.id}.pptx"`,
        "x-content-type-options": "nosniff",
      });
      createReadStream(output).pipe(response);
      return;
    }
    if (method === "POST" && parts[3] === "meetings" && parts.length === 4) {
      if (!await agent.getSession(id)) { json(response, 404, { error: "会话不存在" }); return; }
      const name = decodeURIComponent(request.headers["x-file-name"] || "会议原文.txt");
      const meetingTime = request.headers["x-meeting-time"] || null;
      const meeting = await meetings.upload(id, request, name, meetingTime);
      await slots.sync(id);
      json(response, 201, { meeting: { ...meeting, rawText: undefined } });
      return;
    }
    if (parts[3] === "meetings" && /^[0-9a-f-]{36}$/i.test(parts[4] || "") && parts.length === 5 && method === "GET") {
      const meeting = await meetings.requireMeeting(id, parts[4]);
      json(response, 200, { meeting });
      return;
    }
    if (parts[3] === "meetings" && /^[0-9a-f-]{36}$/i.test(parts[4] || "") && parts[5] === "submit" && parts.length === 6 && method === "POST") {
      const job = await meetingWorkflow.submit(id, parts[4], await readJson(request));
      await slots.sync(id);
      json(response, 202, job);
      return;
    }
    if (parts[3] === "meetings" && /^[0-9a-f-]{36}$/i.test(parts[4] || "") && parts[5] === "todos" &&
        /^(explicit|suggested)-\d+$/.test(parts[6] || "") && parts.length === 7 && method === "PATCH") {
      const todo = await meetingWorkflow.updateTodo(id, parts[4], parts[6], await readJson(request));
      json(response, 200, { todo });
      return;
    }
    if (parts[3] === "meetings" && /^[0-9a-f-]{36}$/i.test(parts[4] || "") && parts[5] === "email" && parts[6] === "undelivered" && parts.length === 7 && method === "POST") {
      const { confirmedNotDelivered } = await readJson(request);
      if (confirmedNotDelivered !== true) throw Object.assign(new Error("请先确认已经核查收件箱，邮件未送达"), { status: 400 });
      json(response, 200, { email: await meetingWorkflow.acknowledgeUndelivered(id, parts[4]) });
      return;
    }
    if (parts[3] === "meetings" && /^[0-9a-f-]{36}$/i.test(parts[4] || "") && parts[5] === "email" && parts[6] === "send" && parts.length === 7 && method === "POST") {
      const { recipient, expected_draft_version } = await readJson(request);
      json(response, 200, await meetingWorkflow.send(id, parts[4], recipient, expected_draft_version));
      return;
    }
    if (parts[3] === "meetings" && /^[0-9a-f-]{36}$/i.test(parts[4] || "") && parts[5] === "email" && parts[6] === "draft" && parts.length === 7 && method === "PUT") {
      const { subject, body, expected_draft_version } = await readJson(request);
      json(response, 200, { email: await meetingWorkflow.updateDraft(id, parts[4], subject, body, undefined, expected_draft_version) });
      return;
    }
    if (method === "POST" && parts[3] === "documents" && parts.length === 4) {
      if (!await agent.getSession(id)) { json(response, 404, { error: "会话不存在" }); return; }
      const name = decodeURIComponent(request.headers["x-file-name"] || "未命名 PDF");
      const document = await documents.upload(id, request, name);
      await slots.sync(id);
      json(response, 201, { document });
      return;
    }
    if (parts[3] === "documents" && /^[0-9a-f-]{36}$/i.test(parts[4] || "") && method === "GET") {
      const documentId = parts[4];
      if (parts[5] === "blackboard" && parts.length === 6) {
        const [blackboard, annotations] = await Promise.all([
          documents.board(id, documentId), documents.annotations(id, documentId),
        ]);
        json(response, 200, { blackboard, annotations });
        return;
      }
      if (parts[5] === "search" && parts.length === 6) {
        json(response, 200, await documents.searchText(id, documentId, url.searchParams.get("q")));
        return;
      }
      if (parts[5] === "pages" && /^\d+$/.test(parts[6] || "") && parts[7] === "text" && parts.length === 8) {
        json(response, 200, { page: Number(parts[6]), source: "pdf_text_layer", text: await documents.pageText(id, documentId, Number(parts[6])) });
        return;
      }
      if (parts[5] === "pages" && /^\d+$/.test(parts[6] || "") && parts.length === 7) {
        const image = await documents.pageImage(id, documentId, Number(parts[6]), url.searchParams.get("detail") === "high");
        response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
        response.end(image);
        return;
      }
    }
    if (parts[3] === "documents" && /^[0-9a-f-]{36}$/i.test(parts[4] || "") &&
        parts[5] === "annotations" && parts.length === 6 && method === "POST") {
      const { page, text } = await readJson(request);
      json(response, 201, { annotation: await documents.addAnnotation(id, parts[4], page, text) });
      return;
    }
    if (method === "PUT" && parts[3] === "thinking" && parts.length === 4) {
      const { level } = await readJson(request);
      json(response, 200, { level: await agent.setThinkingLevel(id, level) });
      return;
    }
    if (method === "POST" && parts[3] === "messages" && parts.length === 4) {
      if (!agent.model) {
        json(response, 503, { error: "请先配置模型" });
        return;
      }
      const body = await readJson(request);
      const { text, images, files, meetingIds } = parsePrompt(body);
      const session = await agent.getSession(id);
      if (!session) {
        json(response, 404, { error: "会话不存在" });
        return;
      }
      if (session.running) {
        json(response, 202, await agent.queueUserInput(id, text, images, files, meetingIds));
        return;
      }
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      const send = (event) => {
        if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
      };
      try {
        await agent.prompt(id, text, images, files, meetingIds, body.thinkingLevel, send);
        send({ type: "done" });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        response.end();
      }
      return;
    }
  }

  if (method === "GET" && staticFiles.has(pathname)) {
    const [filename, contentType] = staticFiles.get(pathname);
    const body = await readFile(join(publicDir, filename));
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
    return;
  }
  json(response, 404, { error: "Not found" });
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) {
      json(response, error?.status || 500, { error: error instanceof Error ? error.message : "服务器错误" });
    } else if (!response.destroyed) {
      response.end();
    }
  });
});

server.listen(port, "0.0.0.0", () => console.log(`Demo service listening on port ${port}`));
process.on("SIGTERM", () => {
  agent.dispose();
  server.close();
});
