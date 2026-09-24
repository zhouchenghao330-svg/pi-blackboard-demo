import { SessionManager } from "@earendil-works/pi-coding-agent";

function terms(query) {
  const result = new Set();
  for (const word of query.match(/[\p{Script=Han}]+|[A-Za-z0-9]+/gu) || []) {
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      for (let size = 2; size <= Math.min(4, word.length); size++) {
        for (let index = 0; index <= word.length - size; index++) result.add(word.slice(index, index + size));
      }
    } else if (word.length > 1) result.add(word.toLowerCase());
  }
  return [...result].filter((term) => !["什么", "怎么", "上次", "之前", "这个", "那个", "会议", "对话"].includes(term)).slice(0, 80);
}

function rank(text, queryTerms) {
  const haystack = text.toLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? term.length : 0), 0);
}

function excerpt(text, queryTerms, max = 320) {
  const haystack = text.toLowerCase();
  const position = queryTerms.map((term) => haystack.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] || 0;
  const start = Math.max(0, position - 80);
  return `${start ? "…" : ""}${text.slice(start, start + max)}${start + max < text.length ? "…" : ""}`;
}

function messageText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
}

export function searchMemoryEntries({ meetingRecords, conversationEntries }, query, limit = 8) {
  const queryTerms = terms(query);
  if (!queryTerms.length) return [];
  const matches = [];
  const runs = new Map();
  for (const record of meetingRecords) {
    const key = record.sourceMeetingId || record.id;
    const prior = runs.get(key);
    if (!prior || !prior.analysis && record.analysis ||
        Boolean(prior.analysis) === Boolean(record.analysis) &&
        (record.analysisCreatedAt || record.uploadedAt) > (prior.analysisCreatedAt || prior.uploadedAt)) runs.set(key, record);
  }
  for (const record of runs.values()) {
    const facts = record.analysis?.facts;
    const searchable = [record.name, record.rawText, facts?.summary, JSON.stringify(facts || {}),
      JSON.stringify(record.analysis?.risks || []), JSON.stringify(record.todos || {})].join("\n");
    const score = rank(searchable, queryTerms);
    if (!score) continue;
    const lines = (record.rawText || "").split("\n").map((text, index) => ({
      line: index + 1, text, score: rank(text, queryTerms),
    })).filter((item) => item.score).sort((a, b) => b.score - a.score).slice(0, 5)
      .map(({ line, text }) => ({ line, text: text.slice(0, 300) }));
    matches.push({ source: "meeting", score, session_id: record.sessionId, meeting_id: record.id,
      name: record.name, meeting_time: record.meetingTime, recorded_at: record.analysisCreatedAt || record.uploadedAt,
      summary: facts?.summary || "", people: facts?.people || [], times: facts?.times || [],
      locations: facts?.locations || [], topics: facts?.topics || [], decisions: facts?.decisions || [],
      todos: record.todos || null, risks: record.analysis?.risks || [], matching_lines: lines });
  }
  for (const entry of conversationEntries) {
    if (!entry.text || !["user", "assistant"].includes(entry.role)) continue;
    const score = rank(entry.text, queryTerms);
    if (!score) continue;
    matches.push({ source: "conversation", score, session_id: entry.sessionId, role: entry.role,
      recorded_at: entry.timestamp, excerpt: excerpt(entry.text, queryTerms) });
  }
  return matches.sort((a, b) => b.score - a.score || (b.recorded_at || "").localeCompare(a.recorded_at || ""))
    .slice(0, limit).sort((a, b) => (a.recorded_at || "").localeCompare(b.recorded_at || ""));
}

export async function searchMemory({ meetings, cwd, sessionDir, query, limit = 8 }) {
  if (typeof query !== "string" || !query.trim() || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 15) {
    throw Object.assign(new Error("记忆检索词或数量无效"), { status: 400 });
  }
  const [meetingRecords, sessions] = await Promise.all([
    meetings.all(), SessionManager.list(cwd, sessionDir),
  ]);
  const activeSessionIds = new Set(sessions.map((session) => session.id));
  const conversationEntries = [];
  let unreadableSessions = 0;
  for (const info of sessions) {
    try {
      const manager = SessionManager.open(info.path, sessionDir, cwd);
      for (const entry of manager.getBranch()) {
        if (entry.type !== "message" || !["user", "assistant"].includes(entry.message.role)) continue;
        conversationEntries.push({ sessionId: info.id, timestamp: entry.timestamp,
          role: entry.message.role, text: messageText(entry.message.content) });
      }
    } catch (error) {
      unreadableSessions++;
      console.error(`Could not read memory session ${info.id}`, error);
    }
  }
  return { warning: "这些是历史会议分析和对话片段，可能包含旧安排、模型表述或后续更正；请按时间和原始行号核对，不能直接视为当前事实。",
    query, unreadable_sessions: unreadableSessions,
    matches: searchMemoryEntries({ meetingRecords: meetingRecords.filter((record) => activeSessionIds.has(record.sessionId)),
      conversationEntries }, query, limit) };
}
