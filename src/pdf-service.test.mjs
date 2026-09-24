import assert from "node:assert/strict";
import test from "node:test";
import { createPdfService } from "./pdf-service.mjs";

test("PDF recovery resumes processing and concurrent callers share one ingest", async () => {
  const document = { id: "pdf-1", sessionId: "session-1", name: "资料.pdf", status: "processing" };
  const board = { document: { pageCount: 2 } };
  const documents = {
    async requireDocument(sessionId, id) {
      assert.equal(sessionId, document.sessionId);
      assert.equal(id, document.id);
      return { ...document };
    },
    async update(_sessionId, _id, changes) { Object.assign(document, changes); return { ...document }; },
    async board() { return board; },
    sourcePath() { return "/tmp/source.pdf"; },
    outputPath() { return "/tmp/output"; },
    async all() { return [{ ...document }]; },
  };
  let calls = 0;
  const service = createPdfService(documents, async ({ onProgress }) => {
    calls += 1;
    onProgress({ phase: "render", percent: 50 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    onProgress({ phase: "ready", percent: 100 });
    return { board };
  });
  const [first, second] = await Promise.all([
    service.ingest(document.sessionId, document.id),
    service.ingest(document.sessionId, document.id),
  ]);
  assert.equal(first, board);
  assert.equal(second, board);
  assert.equal(calls, 1);
  document.status = "processing";
  await service.recover();
  assert.equal(calls, 2);
  assert.equal(document.status, "ready");
  assert.equal(document.notificationPending, true);
});

test("PDF submission returns before visual reading finishes and persists completion notification", { timeout: 1000 }, async () => {
  const document = { id: "pdf-2", sessionId: "session-2", name: "背景.pdf", status: "uploaded" };
  const board = { document: { pageCount: 4 } };
  let finishReading;
  const reading = new Promise((resolve) => { finishReading = resolve; });
  const documents = {
    async requireDocument() { return { ...document }; },
    async update(_sessionId, _id, changes) { Object.assign(document, changes); return { ...document }; },
    async board() { return board; },
    sourcePath() { return "/tmp/source.pdf"; },
    outputPath() { return "/tmp/output"; },
  };
  const service = createPdfService(documents, async ({ onProgress }) => {
    await reading;
    onProgress({ phase: "ready", percent: 100 });
    return { board };
  });

  const submitted = await service.submit(document.sessionId, document.id);
  assert.deepEqual(submitted, { status: "processing", documentId: document.id });
  assert.equal(document.status, "processing");
  assert.equal(document.notificationPending, false);

  finishReading();
  assert.equal(await service.ingest(document.sessionId, document.id), board);
  assert.equal(document.status, "ready");
  assert.equal(document.notificationPending, true);
});
