import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const ID = /^[0-9a-f-]{36}$/i;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(Buffer.concat(chunks).toString("utf8"))
      : reject(new Error(`${command} 退出 ${code}: ${stderr.trim()}`)));
  });
}

export function createDocumentStore(dataDir) {
  const uploadsDir = join(dataDir, "uploads");
  const outputsDir = join(dataDir, "outputs");
  const detailRenders = new Map();
  const textIndexes = new Map();

  async function textIndex(sessionId, id) {
    const document = await requireDocument(sessionId, id);
    if (document.status !== "ready") throw Object.assign(new Error("PDF 尚未完成解析"), { status: 409 });
    const cache = join(outputsDir, id, "page-text.json");
    try {
      return JSON.parse(await readFile(cache, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!textIndexes.has(id)) {
      const pending = (async () => {
        const raw = await run("pdftotext", ["-layout", "-enc", "UTF-8", join(uploadsDir, `${id}.pdf`), "-"]);
        let pages = raw.split("\f");
        if (pages.at(-1) === "") pages.pop();
        if (pages.length !== document.pageCount) {
          pages = await Promise.all(Array.from({ length: document.pageCount }, (_, index) =>
            run("pdftotext", ["-f", String(index + 1), "-l", String(index + 1), "-layout", "-enc", "UTF-8", join(uploadsDir, `${id}.pdf`), "-"])));
        }
        const index = { source: "pdf_text_layer", pages: pages.map((text, offset) => ({ page: offset + 1, text: text.trim() })) };
        await writeFile(cache, `${JSON.stringify(index)}\n`);
        return index;
      })().finally(() => textIndexes.delete(id));
      textIndexes.set(id, pending);
    }
    return textIndexes.get(id);
  }

  async function annotations(sessionId, id) {
    await requireDocument(sessionId, id);
    try {
      const raw = await readFile(join(outputsDir, id, "annotations.jsonl"), "utf8");
      return raw.trim() ? raw.trim().split("\n").map((line) => JSON.parse(line)) : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function save(document) {
    const path = join(uploadsDir, `${document.id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document)}\n`);
    await rename(temporary, path);
    return document;
  }

  async function get(sessionId, id) {
    if (!ID.test(id)) return null;
    try {
      const document = JSON.parse(await readFile(join(uploadsDir, `${id}.json`), "utf8"));
      return document.sessionId === sessionId ? document : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function requireDocument(sessionId, id) {
    const document = await get(sessionId, id);
    if (!document) throw Object.assign(new Error("PDF 文件不存在或不属于当前会话"), { status: 404 });
    return document;
  }

  return {
    async upload(sessionId, request, name) {
      const id = randomUUID();
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_PDF_BYTES) throw Object.assign(new Error("PDF 不能超过 25 MB"), { status: 413 });
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length < 8 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw Object.assign(new Error("文件不是有效的 PDF"), { status: 400 });
      }
      const document = {
        id, sessionId, name: String(name || "未命名 PDF").slice(0, 150), bytes: size,
        status: "uploaded", percent: 0, message: "等待 Agent 解析", createdAt: new Date().toISOString(),
      };
      await mkdir(uploadsDir, { recursive: true });
      await writeFile(join(uploadsDir, `${id}.pdf`), bytes, { flag: "wx" });
      try {
        await save(document);
      } catch (error) {
        await unlink(join(uploadsDir, `${id}.pdf`)).catch(() => {});
        throw error;
      }
      return document;
    },

    get,
    requireDocument,
    sourcePath(id) { return join(uploadsDir, `${id}.pdf`); },
    outputPath(id) { return join(outputsDir, id); },

    async list(sessionId) {
      const names = await readdir(uploadsDir).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const documents = await Promise.all(names.filter((name) => ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))
        .map(async (name) => get(sessionId, name.slice(0, -5))));
      return documents.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async update(sessionId, id, changes) {
      const document = await requireDocument(sessionId, id);
      return save({ ...document, ...changes, updatedAt: new Date().toISOString() });
    },

    async board(sessionId, id) {
      const document = await requireDocument(sessionId, id);
      if (document.status !== "ready") throw Object.assign(new Error("Blackboard 尚未生成"), { status: 409 });
      return JSON.parse(await readFile(join(outputsDir, id, "blackboard.json"), "utf8"));
    },

    annotations,

    async addAnnotation(sessionId, id, page, text) {
      const document = await requireDocument(sessionId, id);
      if (document.status !== "ready" || !Number.isInteger(page) || page < 1 || page > document.pageCount ||
          typeof text !== "string" || !text.trim() || text.trim().length > 1000) {
        throw Object.assign(new Error("页码或修正内容无效（最多 1000 字）"), { status: 400 });
      }
      const annotation = { id: randomUUID(), page, text: text.trim(), source: "user", createdAt: new Date().toISOString() };
      await appendFile(join(outputsDir, id, "annotations.jsonl"), `${JSON.stringify(annotation)}\n`);
      return annotation;
    },

    async pageText(sessionId, id, page) {
      const index = await textIndex(sessionId, id);
      const item = index.pages.find((entry) => entry.page === page);
      if (!item) throw Object.assign(new Error("页码无效"), { status: 400 });
      return item.text;
    },

    async searchText(sessionId, id, query) {
      const term = String(query || "").trim().replace(/\s+/g, " ");
      if (term.length < 2 || term.length > 100) throw Object.assign(new Error("搜索词长度应为 2–100 字"), { status: 400 });
      const index = await textIndex(sessionId, id);
      const needle = term.toLocaleLowerCase();
      const matches = [];
      for (const item of index.pages) {
        const flattened = item.text.replace(/\s+/g, " ");
        const haystack = flattened.toLocaleLowerCase();
        let start = 0;
        for (let count = 0; count < 2 && matches.length < 30; count++) {
          const position = haystack.indexOf(needle, start);
          if (position < 0) break;
          matches.push({ page: item.page, snippet: flattened.slice(Math.max(0, position - 70), Math.min(flattened.length, position + term.length + 110)) });
          start = position + needle.length;
        }
        if (matches.length >= 30) break;
      }
      return { source: "pdf_text_layer", available: index.pages.some((item) => item.text.length > 0), matches };
    },

    async pageImage(sessionId, id, page, highResolution = false) {
      const document = await requireDocument(sessionId, id);
      if (!Number.isInteger(page) || page < 1 || page > (document.pageCount || 0)) {
        throw Object.assign(new Error("页码无效或页图尚未生成"), { status: 400 });
      }
      const filename = `page-${String(page).padStart(3, "0")}.jpg`;
      if (!highResolution) return readFile(join(outputsDir, id, "pages", filename));
      const detailDir = join(outputsDir, id, "detail");
      const detailPath = join(detailDir, filename);
      try {
        if ((await stat(detailPath)).size > 0) return readFile(detailPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const key = `${id}:${page}`;
      if (!detailRenders.has(key)) {
        const pending = (async () => {
          await mkdir(detailDir, { recursive: true });
          const prefix = join(detailDir, filename.slice(0, -4));
          await run("pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-r", "220",
            "-jpeg", "-jpegopt", "quality=88", join(uploadsDir, `${id}.pdf`), prefix]);
        })().finally(() => detailRenders.delete(key));
        detailRenders.set(key, pending);
      }
      await detailRenders.get(key);
      return readFile(detailPath);
    },
  };
}
