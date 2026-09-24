import assert from "node:assert/strict";
import test from "node:test";
import { buildBlackboard, parseJsonOutput, validateBatch, validateOverview } from "./ingest.mjs";

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
