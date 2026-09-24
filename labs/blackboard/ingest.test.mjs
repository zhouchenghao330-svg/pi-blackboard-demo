import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBlackboard, parseJsonOutput, readEntries, validateBatch, validateOverview } from "./ingest.mjs";

test("repairs an invalid JSON escape in a formula without changing its text", () => {
  assert.deepEqual(parseJsonOutput('{"formula":"t\\epsilon",}'), { formula: "t\\epsilon" });
});

test("overlap correction supersedes an earlier fact without deleting it", () => {
  const previous = {
    kind: "batch",
    batch: 1,
    newPages: [4],
    note: {
      page_notes: [{
        page: 4, content_type: ["text"], summary: "旧安排", topics: [], anchors: [],
        key_facts: [{ id: "p4-f1", claim: "张三是负责人", evidence: "张三负责" }],
      }],
      cross_page_links: [], overlap_additions: [], uncertainties: [],
    },
  };
  const batch = { number: 2, seenPages: [4, 5], overlapPages: [4], newPages: [5] };
  const note = validateBatch({
    batch_summary: "负责人说明继续",
    page_notes: [{ page: 5, content_type: ["text"], summary: "新说明", topics: [], anchors: [], key_facts: [] }],
    cross_page_links: [],
    overlap_additions: [{ page: 4, related_new_pages: [5], type: "correction", note: "负责人是张三所在部门", supersedes: "p4-f1" }],
    uncertainties: [{ pages: [5], issue: "截止日期未出现", needs_revisit: false }],
  }, batch, previous);
  const board = buildBlackboard({ pageCount: 5, name: "example.pdf" }, [
    previous,
    { kind: "batch", batch: 2, newPages: [5], note },
  ]);

  assert.equal(board.pageMap[0].key_facts[0].status, "superseded");
  assert.equal(board.pageMap[0].key_facts[0].supersededBy, "b2-o1");
  assert.equal(board.currentFacts.length, 1);
  assert.equal(board.currentFacts[0].claim, "负责人是张三所在部门");
  assert.equal(board.currentFacts[0].supersedes, "p4-f1");
  assert.deepEqual(board.uncertainties[0].pages, [5]);
});

test("cross-page links only point to distinct pages in the current batch", () => {
  const batch = { number: 2, seenPages: [4, 5], overlapPages: [4], newPages: [5] };
  const note = (pages) => ({
    batch_summary: "跨页说明",
    page_notes: [{ page: 5, content_type: ["text"], summary: "第五页", topics: [], anchors: [], key_facts: [] }],
    cross_page_links: [{ pages, note: "第五页承接第四页" }],
    overlap_additions: [], uncertainties: [],
  });
  assert.deepEqual(validateBatch(note([4, 5]), batch, null).cross_page_links[0].pages, [4, 5]);
  for (const pages of [[4, 999], [4, 6], [4, 4], [4, 5.5]]) {
    assert.throws(() => validateBatch(note(pages), batch, null), /cross_page_links/);
  }
});

test("overview sections and highlights only reference physical document pages", () => {
  const note = (sectionPages, highlightPages) => ({
    description: "文档概述",
    sections: [{ title: "主题", pages: sectionPages, description: "主题说明" }],
    highlights: [{ claim: "关键事实", pages: highlightPages }],
    caveats: [],
  });
  assert.deepEqual(validateOverview(note([1, 7], [3]), 7).sections[0].pages, [1, 7]);
  for (const [sections, highlights] of [[[8], [3]], [[1], [0]], [[1.5], [3]], [[1], [999]]]) {
    assert.throws(() => validateOverview(note(sections, highlights), 7), /全文概述/);
  }
});

test("resume drops only a torn final JSONL record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blackboard-entries-"));
  const path = join(directory, "entries.jsonl");
  try {
    await writeFile(path, '{"kind":"batch","batch":1}\n{"kind":"batch","batch":2');
    assert.deepEqual(await readEntries(path), [{ kind: "batch", batch: 1 }]);
    assert.equal(await readFile(path, "utf8"), '{"kind":"batch","batch":1}\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("page numbers must be numeric and out-of-order checkpoints build in page order", () => {
  const batch = { number: 1, seenPages: [1], overlapPages: [], newPages: [1] };
  const note = (page) => ({ batch_summary: "", page_notes: [{ page, content_type: ["text"],
    summary: "页", topics: [], anchors: [], key_facts: [] }], cross_page_links: [], overlap_additions: [], uncertainties: [] });
  assert.throws(() => validateBatch(note("1"), batch, null), /页码不符/);
  const first = { kind: "batch", batch: 1, newPages: [1], note: validateBatch(note(1), batch, null) };
  const second = { kind: "batch", batch: 2, newPages: [2], note: validateBatch(note(2),
    { number: 2, seenPages: [1, 2], overlapPages: [1], newPages: [2] }, null) };
  assert.deepEqual(buildBlackboard({ pageCount: 2, name: "test.pdf" }, [second, first]).pageMap.map((page) => page.page), [1, 2]);
});
