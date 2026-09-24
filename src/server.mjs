import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentService } from "./agent-service.mjs";
import { configurePi } from "./configure-pi.mjs";
import { createDocumentStore } from "./document-store.mjs";

const dataDir = process.env.DEMO_DATA_DIR || "/data";
const agentDir = process.env.PI_CODING_AGENT_DIR || join(dataDir, "pi-agent");
await Promise.all([
  mkdir(join(dataDir, "uploads"), { recursive: true }),
  mkdir(join(dataDir, "outputs"), { recursive: true }),
]);
const configuredModel = await configurePi();
const documents = createDocumentStore(dataDir);
const agent = await createAgentService({ dataDir, agentDir, modelId: configuredModel.modelId, documents });
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
  if (!Array.isArray(files) || files.length > 3 || files.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
    throw Object.assign(new Error("每次最多附加 3 份已上传的 PDF"), { status: 400 });
  }
  if (!Array.isArray(inputImages) || inputImages.length > 3) {
    throw Object.assign(new Error("每次最多附加 3 张图片"), { status: 400 });
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
  if ((!text && images.length === 0 && files.length === 0) || text.length > 12_000) {
    throw Object.assign(new Error("请输入不超过 12000 字的消息"), { status: 400 });
  }
  return { text: text || (files.length ? "请解析上传的 PDF 并建立 Blackboard。" : "请描述这些图片。"), images, files };
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
    if (method === "POST" && parts[3] === "abort" && parts.length === 4) {
      json(response, 200, { aborted: await agent.abort(id) });
      return;
    }
    if (method === "GET" && parts[3] === "documents" && parts.length === 4) {
      if (!await agent.getSession(id)) { json(response, 404, { error: "会话不存在" }); return; }
      json(response, 200, { documents: await documents.list(id) });
      return;
    }
    if (method === "POST" && parts[3] === "documents" && parts.length === 4) {
      if (!await agent.getSession(id)) { json(response, 404, { error: "会话不存在" }); return; }
      const name = decodeURIComponent(request.headers["x-file-name"] || "未命名 PDF");
      json(response, 201, { document: await documents.upload(id, request, name) });
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
      const { text, images, files } = parsePrompt(body);
      const session = await agent.getSession(id);
      if (!session) {
        json(response, 404, { error: "会话不存在" });
        return;
      }
      if (session.running) {
        json(response, 409, { error: "当前会话正在生成回答" });
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
        await agent.prompt(id, text, images, files, body.thinkingLevel, send);
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
