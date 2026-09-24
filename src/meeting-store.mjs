import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ID = /^[0-9a-f-]{36}$/i;
const MAX_BYTES = 512 * 1024;
const MAX_CHARS = 40_000;

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function numberedLines(text) {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line, index) =>
    `[L${String(index + 1).padStart(4, "0")}] ${line}`).join("\n");
}

export function createMeetingStore(dataDir) {
  const directory = join(dataDir, "meetings");
  const writes = new Map();

  async function save(record) {
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `${record.id}.json`);
    const previous = writes.get(record.id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record)}\n`);
      await rename(temporary, destination);
      return record;
    });
    writes.set(record.id, pending);
    try { return await pending; } finally { if (writes.get(record.id) === pending) writes.delete(record.id); }
  }

  async function get(sessionId, id) {
    if (!ID.test(id)) return null;
    try {
      const record = JSON.parse(await readFile(join(directory, `${id}.json`), "utf8"));
      return record.sessionId === sessionId ? record : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function requireMeeting(sessionId, id) {
    const meeting = await get(sessionId, id);
    if (!meeting) throw bad("会议不存在或不属于当前会话", 404);
    return meeting;
  }

  async function listRecords(sessionId) {
    const names = await readdir(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const records = await Promise.all(names.filter((name) => ID.test(name.slice(0, -5)) && name.endsWith(".json"))
      .map((name) => get(sessionId, name.slice(0, -5))));
    return records.filter(Boolean).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  return {
    get,
    requireMeeting,
    async upload(sessionId, request, name, meetingTime) {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BYTES) throw bad("会议 TXT 不能超过 512 KB", 413);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      if (!text.trim() || text.length > MAX_CHARS || text.includes("\0")) throw bad("会议 TXT 应为 1–40000 个有效字符");
      if (meetingTime && (typeof meetingTime !== "string" || Number.isNaN(Date.parse(meetingTime)))) throw bad("会议时间无效");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const existing = (await listRecords(sessionId)).find((item) => item.sha256 === sha256 && item.meetingTime === (meetingTime || null));
      if (existing) return existing;
      const id = randomUUID();
      const record = {
        id, sessionId, name: String(name || "会议原文.txt").slice(0, 150),
        uploadedAt: new Date().toISOString(), meetingTime: meetingTime || null,
        bytes: size, sha256,
        lineCount: text.split("\n").length, status: "uploaded", progress: 0,
        rawText: text, analysis: null, todos: null, email: null, error: null,
        history: [{ status: "uploaded", at: new Date().toISOString() }],
      };
      await save(record);
      return record;
    },
    list: listRecords,
    async all() {
      const names = await readdir(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
      return Promise.all(names.filter((name) => ID.test(name.slice(0, -5)) && name.endsWith(".json"))
        .map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))));
    },
    async update(sessionId, id, changes) {
      const current = await requireMeeting(sessionId, id);
      const now = new Date().toISOString();
      const record = { ...current, ...changes, updatedAt: now };
      if (changes.status && changes.status !== current.status) {
        record.history = [...current.history, { status: changes.status, at: now }];
      }
      return save(record);
    },
  };
}
