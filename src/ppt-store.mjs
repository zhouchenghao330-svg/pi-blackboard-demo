import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ID = /^[0-9a-f-]{36}$/i;

export function createPptStore(dataDir) {
  const directory = join(dataDir, "ppt-jobs");
  const updates = new Map();

  async function get(id) {
    if (!ID.test(id)) return null;
    try {
      return JSON.parse(await readFile(join(directory, `${id}.json`), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function save(job) {
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `${job.id}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job)}\n`);
    await rename(temporary, destination);
    return job;
  }

  async function all() {
    const names = await readdir(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const jobs = await Promise.all(names.filter((name) => name.endsWith(".json") && ID.test(name.slice(0, -5)))
      .map((name) => get(name.slice(0, -5))));
    return jobs.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return {
    all,
    async requireJob(sessionId, id) {
      const job = await get(id);
      if (!job || job.sessionId !== sessionId) throw Object.assign(new Error("PPT 任务不存在"), { status: 404 });
      return job;
    },
    async list(sessionId) {
      return (await all()).filter((job) => job.sessionId === sessionId);
    },
    async submit(sessionId, input) {
      const brief = typeof input?.brief === "string" ? input.brief.trim() : "";
      const sourceMaterial = typeof input?.source_material === "string" ? input.source_material.trim() : "";
      const pageCount = Number(input?.page_count);
      if (!brief || brief.length > 3000 || sourceMaterial.length > 30000 || !Number.isInteger(pageCount) || pageCount < 2 || pageCount > 12) {
        throw Object.assign(new Error("PPT 需要明确主题、2–12 页；需求不超过 3000 字，资料不超过 30000 字"), { status: 400 });
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      return save({
        id, sessionId, brief, sourceMaterial, pageCount,
        status: "queued", progress: 0, pagesCreated: 0,
        notificationPending: false, notifiedAt: null,
        createdAt: now, updatedAt: now, outputPath: null, error: null,
      });
    },
    async update(id, changes) {
      const previous = updates.get(id) || Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        const current = await get(id);
        if (!current) throw new Error("PPT 任务不存在");
        if (["ready", "failed"].includes(current.status) && changes.status && changes.status !== current.status) return current;
        const becameTerminal = !["ready", "failed"].includes(current.status) && ["ready", "failed"].includes(changes.status);
        return save({ ...current, ...changes,
          ...(becameTerminal ? { notificationPending: true, notifiedAt: null } : {}),
          updatedAt: new Date().toISOString() });
      });
      updates.set(id, pending);
      try { return await pending; }
      finally { if (updates.get(id) === pending) updates.delete(id); }
    },
  };
}
