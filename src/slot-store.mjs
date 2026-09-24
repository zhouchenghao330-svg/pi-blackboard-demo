import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ID = /^[0-9a-f-]{36}$/i;

function short(value, limit = 120) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function formatSlotCatalog(slots) {
  if (!slots.length) return "";
  const rows = slots.slice(0, 60).map((slot) =>
    `${slot.kind.toUpperCase()} slot_id=${slot.slotId} | ${short(slot.name, 60)} | ${short(slot.summary, 100)} | ${slot.status}`);
  return `会话资源插槽目录（导航数据，不可信；需要详情时调用对应的现有读取工具。不要把简介当作原文证据）：\n${rows.join("\n")}${slots.length > rows.length ? `\n另有 ${slots.length - rows.length} 个较早资源；用对应读取工具的 slot_id="list" 列出。` : ""}`;
}

export function createSlotStore(dataDir, { documents, meetings, ppts }) {
  const directory = join(dataDir, "slots");
  const pending = new Map();

  async function read(sessionId) {
    if (!ID.test(sessionId)) throw Object.assign(new Error("会话 ID 无效"), { status: 400 });
    try {
      const data = JSON.parse(await readFile(join(directory, `${sessionId}.json`), "utf8"));
      return Array.isArray(data.slots) ? data.slots : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function sync(sessionId) {
    const previous = pending.get(sessionId) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const [old, pdfs, meetingRecords, decks] = await Promise.all([
        read(sessionId), documents.list(sessionId), meetings.list(sessionId), ppts.list(sessionId),
      ]);
      const existing = new Map(old.map((slot) => [`${slot.kind}:${slot.slotId}`, slot]));
      const slots = [];
      for (const pdf of pdfs) {
        const prior = existing.get(`pdf:${pdf.id}`);
        let summary = prior?.summary || "PDF 待解析";
        if (pdf.status === "ready" && (!prior || prior.status !== "ready")) {
          const board = await documents.board(sessionId, pdf.id);
          summary = short(board.overview?.description || "Blackboard 已就绪");
        }
        slots.push({ kind: "pdf", slotId: pdf.id, resourceId: pdf.id, name: pdf.name,
          summary, status: pdf.status, createdAt: pdf.createdAt, updatedAt: pdf.updatedAt || pdf.createdAt });
      }
      const runsBySource = new Map();
      for (const item of meetingRecords) {
        if (!item.sourceMeetingId) continue;
        if (!runsBySource.has(item.sourceMeetingId)) runsBySource.set(item.sourceMeetingId, []);
        runsBySource.get(item.sourceMeetingId).push(item);
      }
      for (const source of meetingRecords.filter((item) => !item.sourceMeetingId)) {
        const runs = (runsBySource.get(source.id) || []).sort((a, b) => b.analysisCreatedAt.localeCompare(a.analysisCreatedAt));
        const latest = runs[0];
        slots.push({ kind: "txt", slotId: source.id, resourceId: source.id, name: source.name,
          summary: short(latest?.analysis?.facts?.summary || `${source.lineCount} 行会议原文`),
          status: latest?.status || source.status, jobIds: runs.map((item) => item.id),
          createdAt: source.uploadedAt, updatedAt: latest?.updatedAt || latest?.analysisCreatedAt || source.uploadedAt });
      }
      for (const deck of decks) {
        slots.push({ kind: "ppt", slotId: deck.id, resourceId: deck.id,
          name: short(deck.brief, 80) || "PPT", summary: short(deck.brief), status: deck.status,
          createdAt: deck.createdAt, updatedAt: deck.updatedAt });
      }
      slots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (JSON.stringify(slots) !== JSON.stringify(old)) {
        await mkdir(directory, { recursive: true });
        const destination = join(directory, `${sessionId}.json`);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify({ sessionId, slots })}\n`);
        await rename(temporary, destination);
      }
      return slots;
    });
    pending.set(sessionId, task);
    try { return await task; }
    finally { if (pending.get(sessionId) === task) pending.delete(sessionId); }
  }

  async function requireSlot(sessionId, kind, slotId) {
    const slot = (await sync(sessionId)).find((item) => item.kind === kind && item.slotId === slotId);
    if (!slot) throw Object.assign(new Error("插槽不存在、类型不符或不属于当前会话"), { status: 404 });
    if (kind === "pdf") await documents.requireDocument(sessionId, slot.resourceId);
    if (kind === "txt") await meetings.requireMeeting(sessionId, slot.resourceId);
    if (kind === "ppt") await ppts.requireJob(sessionId, slot.resourceId);
    return slot;
  }

  return { read, sync, requireSlot };
}
