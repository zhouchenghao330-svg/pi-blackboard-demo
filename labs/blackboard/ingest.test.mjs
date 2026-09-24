import assert from "node:assert/strict";
import test from "node:test";
import { buildBlackboard, parseJsonOutput, validateBatch } from "./ingest.mjs";

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
