import { ingestPdf } from "../labs/blackboard/ingest.mjs";

export function createPdfService(documents, ingestImpl = ingestPdf) {
  const running = new Map();

  async function ingest(sessionId, documentId, { signal, onProgress = () => {} } = {}) {
    const current = running.get(documentId);
    if (current) {
      current.listeners.add(onProgress);
      try { return await current.promise; }
      finally { current.listeners.delete(onProgress); }
    }

    const listeners = new Set([onProgress]);
    const promise = (async () => {
      const document = await documents.requireDocument(sessionId, documentId);
      if (document.status === "ready") return documents.board(sessionId, documentId);
      let progressWrites = Promise.resolve();
      const updateProgress = (progress) => {
        for (const listener of listeners) listener(progress);
        progressWrites = progressWrites.then(() => documents.update(sessionId, documentId, {
          status: progress.phase === "ready" ? "ready" : "processing",
          ...(progress.phase === "ready" ? { notificationPending: true } : {}), ...progress,
        }));
      };
      try {
        await documents.update(sessionId, documentId, {
          status: "processing", phase: "prepare", percent: 1, message: "正在检查 PDF",
        });
        updateProgress({ phase: "prepare", percent: 1, message: "正在检查 PDF" });
        const result = await ingestImpl({
          input: documents.sourcePath(documentId), output: documents.outputPath(documentId),
          name: document.name, concurrency: 2, dpi: 120, jpegQuality: 80, onProgress: updateProgress, signal,
        });
        await progressWrites;
        return result.board;
      } catch (error) {
        await progressWrites.catch(() => {});
        await documents.update(sessionId, documentId, {
          status: "failed", phase: "failed", message: error.message, notificationPending: true,
        });
        for (const listener of listeners) listener({ phase: "failed", message: error.message });
        throw error;
      }
    })();
    const job = { promise, listeners };
    running.set(documentId, job);
    try { return await promise; }
    finally { if (running.get(documentId) === job) running.delete(documentId); }
  }

  async function submit(sessionId, documentId) {
    const document = await documents.requireDocument(sessionId, documentId);
    if (document.status === "ready") return { status: "ready", documentId };
    if (document.status !== "processing") {
      await documents.update(sessionId, documentId, {
        status: "processing", phase: "queued", percent: 0,
        message: "PDF 解析任务已提交", notificationPending: false,
      });
    }
    if (!running.has(documentId)) void ingest(sessionId, documentId)
      .catch((error) => console.error(`PDF ingestion failed for ${documentId}:`, error));
    return { status: "processing", documentId };
  }

  async function recover() {
    for (const document of await documents.all()) {
      if (document.status !== "processing") continue;
      try { await ingest(document.sessionId, document.id); }
      catch (error) { console.error(`PDF recovery failed for ${document.id}:`, error); }
    }
  }

  return { ingest, submit, recover };
}
