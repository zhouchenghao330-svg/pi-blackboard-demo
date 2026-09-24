import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SECTIONS = { people: "人物", events: "时间与事件", places: "地点", topics: "主题" };
const PREFIXES = { people: "p", events: "e", places: "l", topics: "t" };
const MAX_CHARS = 2000;

function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }
function size(text) { return [...text].length; }

function markdown(entries) {
  return Object.entries(SECTIONS).map(([section, heading]) => {
    const lines = entries.filter((entry) => entry.section === section)
      .map((entry) => `- [${entry.id}]${entry.pinned ? " !" : ""} ${entry.text}`);
    return `## ${heading}\n${lines.join("\n")}`;
  }).join("\n\n") + "\n";
}

async function atomicWrite(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

export async function createLongMemoryStore(dataDir) {
  const directory = join(dataDir, "memory");
  const logPath = join(directory, "history.jsonl");
  const mdPath = join(directory, "memory.md");
  await mkdir(directory, { recursive: true });
  const raw = await readFile(logPath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  let entries = [];
  let history = [];
  const counters = { people: 0, events: 0, places: 0, topics: 0 };
  for (const line of raw.split("\n").filter(Boolean)) {
    const item = JSON.parse(line);
    if (item.version !== history.length + 1) throw new Error("长期记忆日志版本不连续");
    entries = entries.filter((entry) => !item.removed_ids?.includes(entry.id) && entry.id !== item.entry?.id);
    if (item.entry) entries.push(item.entry);
    if (item.entry) counters[item.entry.section] = Math.max(counters[item.entry.section], Number(item.entry.id.slice(1)) || 0);
    history.push(item);
  }
  await atomicWrite(mdPath, markdown(entries));
  let pending = Promise.resolve();

  function snapshot() {
    const content = markdown(entries);
    return { version: history.length, text: content, chars: size(content), limit: MAX_CHARS,
      entries: entries.map((entry) => ({ ...entry })) };
  }

  async function apply(operation, { actor, source, expectedVersion }) {
    const task = pending.catch(() => {}).then(async () => {
      if (expectedVersion !== undefined && history.length !== expectedVersion) {
        throw Object.assign(bad("长期记忆版本已变化，请根据当前条目重试", 409), { code: "MEMORY_CONFLICT" });
      }
      const op = operation?.op;
      const section = operation?.section;
      const id = operation?.id;
      const otherId = operation?.other_id;
      const text = typeof operation?.text === "string" ? operation.text.trim() : "";
      const pinned = operation?.pinned;
      if (!Object.hasOwn(SECTIONS, section) || !["add", "update", "delete", "merge"].includes(op)) {
        throw bad("记忆操作或分类无效");
      }
      if (!["agent", "background"].includes(actor) || !source || !["conversation", "meeting"].includes(source.kind)) {
        throw bad("记忆来源无效");
      }
      if (pinned !== undefined && typeof pinned !== "boolean") throw bad("记忆保留标记无效");
      if (["add", "update", "merge"].includes(op) && (!text || size(text) > 240 || /[\r\n]/u.test(text))) {
        throw bad("单条记忆须为不超过 240 字的单行内容");
      }
      const current = entries.find((entry) => entry.id === id);
      if (op !== "add" && (!current || current.section !== section)) throw bad("记忆条目不存在或分类不符", 404);
      const other = op === "merge" ? entries.find((entry) => entry.id === otherId) : null;
      if (op === "merge" && (!other || other.section !== section || other.id === id)) throw bad("待合并条目无效");
      if (actor === "background" && (current?.pinned || other?.pinned)) throw bad("后台不能修改用户明确要求保留的记忆");
      if (op === "add" && entries.some((entry) => entry.section === section && entry.text === text)) {
        return { status: "unchanged", version: history.length, chars: size(markdown(entries)), limit: MAX_CHARS };
      }
      const nextId = op === "add" ? `${PREFIXES[section]}${counters[section] + 1}` : id;
      const entry = op === "delete" ? null : { id: nextId, section, text,
        pinned: actor === "agent" ? pinned ?? current?.pinned ?? other?.pinned ?? false : false };
      const removedIds = op === "merge" ? [id, otherId] : op === "delete" ? [id] : op === "update" ? [id] : [];
      const nextEntries = entries.filter((item) => !removedIds.includes(item.id));
      if (entry) nextEntries.push(entry);
      const chars = size(markdown(nextEntries));
      if (chars > MAX_CHARS) throw Object.assign(
        bad(`记忆已占 ${size(markdown(entries))}/${MAX_CHARS} 字；请先合并、精简或删除旧条目`, 409),
        { code: "MEMORY_CAPACITY" });
      const event = {
        version: history.length + 1, at: new Date().toISOString(), actor, op, section,
        entry, before: current || null, merged: other || null, removed_ids: removedIds,
        source: { ...source },
      };
      await appendFile(logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      entries = nextEntries;
      if (op === "add") counters[section]++;
      history.push(event);
      await atomicWrite(mdPath, markdown(entries));
      return { status: "applied", version: event.version, id: nextId, chars, limit: MAX_CHARS, event };
    });
    pending = task;
    return task;
  }

  return {
    snapshot,
    changesAfter(version, actor = null) { return history.filter((item) => item.version > version && (!actor || item.actor === actor)); },
    history(limit = 30, sessionId = null) {
      const selected = sessionId ? history.filter((item) => item.source.sessionId === sessionId) : history;
      return selected.slice(-limit).reverse();
    },
    apply,
  };
}
