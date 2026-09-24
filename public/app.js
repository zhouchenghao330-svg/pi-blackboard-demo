import MarkdownIt from "/markdown-it.mjs";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultLinkOpen = markdown.renderer.rules.link_open || ((tokens, index, options, environment, renderer) =>
  renderer.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, environment, renderer);
};

const elements = {
  sidebar: document.querySelector("#sidebar"),
  sidebarBackdrop: document.querySelector("#sidebarBackdrop"),
  menuButton: document.querySelector("#menuButton"),
  newChatButton: document.querySelector("#newChatButton"),
  sessionList: document.querySelector("#sessionList"),
  sessionCount: document.querySelector("#sessionCount"),
  sessionTitle: document.querySelector("#sessionTitle"),
  connectionPill: document.querySelector("#connectionPill"),
  connectionText: document.querySelector("#connectionText"),
  modelPill: document.querySelector("#modelPill"),
  conversation: document.querySelector("#conversation"),
  emptyState: document.querySelector("#emptyState"),
  messages: document.querySelector("#messages"),
  composerForm: document.querySelector("#composerForm"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  stopButton: document.querySelector("#stopButton"),
  attachButton: document.querySelector("#attachButton"),
  imageInput: document.querySelector("#imageInput"),
  attachmentList: document.querySelector("#attachmentList"),
  thinkingSelect: document.querySelector("#thinkingSelect"),
  boardToggle: document.querySelector("#boardToggle"),
  boardPanel: document.querySelector("#blackboardPanel"),
  boardDocuments: document.querySelector("#boardDocuments"),
  boardSearch: document.querySelector("#boardSearch"),
  boardSearchMeta: document.querySelector("#boardSearchMeta"),
  boardProgress: document.querySelector("#boardProgress"),
  boardProgressText: document.querySelector("#boardProgressText"),
  boardProgressPercent: document.querySelector("#boardProgressPercent"),
  boardProgressBar: document.querySelector("#boardProgressBar"),
  boardProgressFill: document.querySelector("#boardProgressFill"),
  boardContent: document.querySelector("#boardContent"),
  pageViewer: document.querySelector("#pageViewer"),
  pageViewerTitle: document.querySelector("#pageViewerTitle"),
  pageViewerImage: document.querySelector("#pageViewerImage"),
  pageViewerZoom: document.querySelector("#pageViewerZoom"),
  pageViewerClose: document.querySelector("#pageViewerClose"),
  toast: document.querySelector("#toast"),
};

const state = {
  activeId: null,
  runningId: null,
  model: null,
  thinkingLevel: localStorage.getItem("demoThinkingLevel") || "off",
  thinkingLevels: ["off"],
  sessions: [],
  attachments: [],
  documents: [],
  selectedDocumentId: null,
  board: null,
  boardAnnotations: [],
  boardSearchResults: null,
  searchTimer: null,
  searchRequest: 0,
  followConversation: true,
  renderingHistory: false,
  toastTimer: null,
  pollTimer: null,
};

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4000);
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
}

function isNearBottom(node, threshold = 48) {
  return node.scrollHeight - node.clientHeight - node.scrollTop <= threshold;
}

function scrollToBottom(force = false) {
  if (!force && !state.followConversation) return;
  if (force) state.followConversation = true;
  elements.conversation.scrollTop = elements.conversation.scrollHeight;
}

function updateEmptyState() {
  elements.emptyState.hidden = elements.messages.childElementCount > 0;
}

function updateControls() {
  const running = Boolean(state.runningId);
  const hasInput = Boolean(elements.messageInput.value.trim() || state.attachments.length);
  elements.sendButton.hidden = running;
  elements.stopButton.hidden = !running || state.runningId !== state.activeId;
  elements.sendButton.disabled = !state.model || !hasInput;
  elements.messageInput.disabled = running || !state.model;
  elements.attachButton.disabled = running || !state.model;
  elements.thinkingSelect.disabled = running || !state.model;
  elements.messageInput.placeholder = state.model ? "输入消息，开始对话…" : "请先配置模型…";
}

function boardNode(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function pageUrl(documentId, page, highResolution = false) {
  return `/api/sessions/${state.activeId}/documents/${documentId}/pages/${page}${highResolution ? "?detail=high" : ""}`;
}

function openPageViewer(doc, page) {
  elements.pageViewerTitle.textContent = `${doc.name} · 物理第 ${page} 页`;
  elements.pageViewerImage.src = pageUrl(doc.id, page, true);
  elements.pageViewerImage.alt = `${doc.name} 物理第 ${page} 页高清图`;
  elements.pageViewer.classList.remove("actual-size");
  elements.pageViewerZoom.textContent = "实际尺寸";
  elements.pageViewer.showModal();
}

function pageLink(doc, page, label = `P ${page}`) {
  const button = boardNode("button", "board-page-link", label);
  button.type = "button";
  button.addEventListener("click", () => {
    const card = elements.boardContent.querySelector(`[data-page="${page}"]`);
    if (card) {
      card.open = true;
      card.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      openPageViewer(doc, page);
    }
  });
  return button;
}

function searchKey(value) {
  return String(value || "").toLocaleLowerCase().replace(/figure/g, "fig").replace(/[\s.：:]/g, "");
}

function renderDocumentTabs() {
  elements.boardDocuments.replaceChildren();
  for (const doc of state.documents) {
    const button = boardNode("button", `board-document${doc.id === state.selectedDocumentId ? " active" : ""}`);
    button.type = "button";
    button.append(boardNode("span", "board-doc-icon", "PDF"), boardNode("span", "board-doc-name", doc.name));
    button.append(boardNode("span", `board-doc-status ${doc.status}`, doc.status === "ready" ? "已就绪" : doc.status === "failed" ? "失败" : doc.status === "processing" ? "解析中" : "待解析"));
    button.addEventListener("click", () => { void selectDocument(doc.id); });
    elements.boardDocuments.append(button);
  }
}

function renderBoardPlaceholder(text, detail) {
  const empty = boardNode("div", "board-empty");
  empty.append(boardNode("div", "board-empty-icon", "▤"), boardNode("strong", "", text), boardNode("p", "", detail));
  elements.boardContent.replaceChildren(empty);
}

function updateBoardProgress(doc) {
  const visible = doc && doc.status !== "ready";
  elements.boardProgress.hidden = !visible;
  if (!visible) return;
  const percent = Math.max(0, Math.min(100, doc.percent || 0));
  elements.boardProgressText.textContent = doc.message || (doc.status === "failed" ? "解析失败" : "等待解析");
  elements.boardProgressPercent.textContent = `${percent}%`;
  elements.boardProgressBar.setAttribute("aria-valuenow", String(percent));
  elements.boardProgressFill.style.width = `${percent}%`;
  elements.boardProgress.classList.toggle("failed", doc.status === "failed");
}

function renderBlackboard(board, doc) {
  const query = elements.boardSearch.value.trim();
  const key = searchKey(query);
  const textMatches = state.boardSearchResults?.query === query ? state.boardSearchResults.matches : [];
  const matchedPages = new Set(textMatches.map((item) => item.page));
  const annotationsByPage = new Map();
  for (const annotation of state.boardAnnotations) {
    if (!annotationsByPage.has(annotation.page)) annotationsByPage.set(annotation.page, []);
    annotationsByPage.get(annotation.page).push(annotation);
  }
  const root = boardNode("div", "board-report");
  root.append(boardNode("span", "board-section-label", "文档概览"));
  root.append(boardNode("h3", "board-report-title", doc.name));
  root.append(boardNode("p", "board-report-meta", `${board.document.pageCount} 页 · ${board.coverage.batches} 批阅读 · 每批重叠 ${board.document.overlap} 页`));
  root.append(boardNode("p", "board-overview", board.overview?.description || "尚无概述"));
  root.append(boardNode("p", "board-source-note", "以上为模型生成的文档概念，可能遗漏或有误。"));
  if (board.overview?.sections?.length) {
    root.append(boardNode("div", "board-section-label", "主题导航"));
    const sections = boardNode("div", "board-sections");
    for (const section of board.overview.sections) {
      const item = boardNode("div", "board-section");
      item.append(boardNode("strong", "", section.title));
      if (section.description) item.append(boardNode("p", "", section.description));
      const links = boardNode("div", "board-page-links");
      for (const page of section.pages || []) links.append(pageLink(doc, page));
      item.append(links);
      sections.append(item);
    }
    root.append(sections);
  }
  if (board.overview?.highlights?.length) {
    root.append(boardNode("div", "board-section-label", "关键线索 · 模型整理"));
    const highlights = boardNode("div", "board-highlights");
    for (const highlight of board.overview.highlights) {
      const item = boardNode("div", "board-highlight");
      item.append(boardNode("p", "", highlight.claim));
      for (const page of highlight.pages || []) item.append(pageLink(doc, page));
      highlights.append(item);
    }
    root.append(highlights);
  }
  if (query) {
    const searchSection = boardNode("div", "board-search-results");
    searchSection.append(boardNode("div", "board-section-label", "PDF 文本层命中"));
    if (state.boardSearchResults?.query === query) {
      if (!state.boardSearchResults.available) searchSection.append(boardNode("p", "board-source-note", "此 PDF 没有可用的原生文本层；可继续搜索模型笔记。"));
      else if (!textMatches.length) searchSection.append(boardNode("p", "board-source-note", "文本层没有命中。扫描内容、图和公式可能无法搜到。"));
      for (const match of textMatches) {
        const item = boardNode("div", "board-search-hit");
        item.append(pageLink(doc, match.page), boardNode("span", "", match.snippet));
        searchSection.append(item);
      }
    } else searchSection.append(boardNode("p", "board-source-note", query.length < 2 ? "输入至少 2 个字符可搜索 PDF 文本层。" : "正在搜索 PDF 文本层…"));
    root.append(searchSection);
  }
  root.append(boardNode("div", "board-section-label", "逐页索引"));
  const pages = boardNode("div", "board-pages");
  const visiblePages = board.pageMap.filter((page) => !key || matchedPages.has(page.page) ||
    searchKey([page.summary, ...(page.anchors || []), ...(page.topics || []), ...(page.key_facts || []).flatMap((fact) => [fact.claim, fact.evidence]),
      ...(annotationsByPage.get(page.page) || []).map((item) => item.text)].join(" ")).includes(key));
  if (!visiblePages.length) pages.append(boardNode("p", "board-source-note", "当前搜索没有匹配的页面。"));
  for (const page of visiblePages) {
    const card = boardNode("details", "board-page");
    card.dataset.page = String(page.page);
    const summary = boardNode("summary", "board-page-heading");
    summary.append(boardNode("span", "board-page-number", String(page.page).padStart(2, "0")));
    const title = boardNode("span", "board-page-title", page.anchors?.[0] || page.topics?.[0] || `第 ${page.page} 页`);
    title.append(boardNode("small", "", page.summary));
    summary.append(title, boardNode("span", "board-page-chevron", "⌄"));
    card.append(summary);
    const body = boardNode("div", "board-page-body");
    if (page.content_type?.length) body.append(boardNode("p", "board-page-type", page.content_type.join(" · ")));
    if (page.topics?.length) body.append(boardNode("p", "board-page-topics", page.topics.join(" · ")));
    for (const fact of page.key_facts || []) {
      const item = boardNode("div", `board-fact${fact.status === "superseded" ? " superseded" : ""}`);
      item.append(boardNode("p", "", fact.claim));
      if (fact.evidence) item.append(boardNode("small", "", `模型定位线索：${fact.evidence}`));
      body.append(item);
    }
    const issues = (board.uncertainties || []).filter((item) => item.pages?.includes(page.page));
    for (const issue of issues) body.append(boardNode("p", "board-uncertainty", `待核实：${issue.issue}`));
    const corrections = annotationsByPage.get(page.page) || [];
    if (corrections.length) {
      const latest = corrections.at(-1);
      body.append(boardNode("p", "board-correction", `用户最新修正：${latest.text}`));
      if (corrections.length > 1) {
        const history = boardNode("details", "board-correction-history");
        history.append(boardNode("summary", "", `查看修正历史 · ${corrections.length} 条`));
        for (const item of corrections) history.append(boardNode("p", "", `${new Date(item.createdAt).toLocaleString("zh-CN")} · ${item.text}`));
        body.append(history);
      }
    }
    const actions = boardNode("div", "board-page-actions");
    const view = boardNode("button", "board-view-page", "高清页图 ↗");
    view.type = "button";
    view.addEventListener("click", () => openPageViewer(doc, page.page));
    const textButton = boardNode("button", "board-view-page", "PDF 文本层");
    textButton.type = "button";
    const pageText = boardNode("pre", "board-page-text");
    pageText.hidden = true;
    textButton.addEventListener("click", async () => {
      if (!pageText.hidden) { pageText.hidden = true; return; }
      try {
        const result = await api(`/api/sessions/${state.activeId}/documents/${doc.id}/pages/${page.page}/text`);
        pageText.textContent = result.text || "此页没有原生文本层。请查看页图。";
        pageText.hidden = false;
      } catch (error) { showToast(error.message); }
    });
    const correctButton = boardNode("button", "board-view-page", "修正本页");
    correctButton.type = "button";
    const form = boardNode("form", "board-correction-form");
    form.hidden = true;
    const input = boardNode("textarea", "");
    input.maxLength = 1000;
    input.rows = 3;
    input.placeholder = "写下对这一页笔记的修正。历史记录会保留。";
    input.setAttribute("aria-label", `修正第 ${page.page} 页`);
    const save = boardNode("button", "board-save-correction", "保存修正");
    save.type = "submit";
    form.append(input, save);
    correctButton.addEventListener("click", () => { form.hidden = !form.hidden; if (!form.hidden) input.focus(); });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      save.disabled = true;
      try {
        await api(`/api/sessions/${state.activeId}/documents/${doc.id}/annotations`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ page: page.page, text: input.value.trim() }),
        });
        const { blackboard, annotations } = await api(`/api/sessions/${state.activeId}/documents/${doc.id}/blackboard`);
        if (state.selectedDocumentId === doc.id) {
          state.board = blackboard;
          state.boardAnnotations = annotations;
          renderBlackboard(blackboard, doc);
          const reopened = elements.boardContent.querySelector(`[data-page="${page.page}"]`);
          if (reopened) { reopened.open = true; reopened.scrollIntoView({ block: "center" }); }
        }
      } catch (error) { showToast(error.message); save.disabled = false; }
    });
    actions.append(view, textButton, correctButton);
    body.append(actions, boardNode("p", "board-source-note", "PDF 文本层可能漏字或顺序错乱；以高清页图为准。"), pageText, form);
    card.append(body);
    pages.append(card);
  }
  root.append(pages);
  if (board.crossPageLinks?.length) {
    const links = boardNode("details", "board-cross-links");
    links.append(boardNode("summary", "board-section-label", `跨页连接 · ${board.crossPageLinks.length}`));
    for (const item of board.crossPageLinks) {
      const row = boardNode("div", "board-cross-link");
      for (const page of item.pages || []) row.append(pageLink(doc, page));
      row.append(boardNode("p", "", item.note));
      links.append(row);
    }
    links.append(boardNode("p", "board-source-note", "跨页关系由模型归纳，需回页核查。"));
    root.append(links);
  }
  elements.boardContent.replaceChildren(root);
  elements.boardSearchMeta.hidden = !query;
  if (query) elements.boardSearchMeta.textContent = `笔记命中 ${visiblePages.length} 页 · PDF 文本层 ${state.boardSearchResults?.query === query ? `${textMatches.length} 处` : "搜索中"}`;
}

async function selectDocument(id) {
  if (state.selectedDocumentId !== id) {
    elements.boardSearch.value = "";
    state.boardSearchResults = null;
    state.searchRequest += 1;
    clearTimeout(state.searchTimer);
  }
  state.selectedDocumentId = id;
  renderDocumentTabs();
  const doc = state.documents.find((item) => item.id === id);
  elements.boardSearch.disabled = !doc || doc.status !== "ready";
  elements.boardSearchMeta.hidden = true;
  updateBoardProgress(doc);
  if (!doc) { renderBoardPlaceholder("还没有文档", "在对话框上传 PDF，Agent 会生成带页码的 Blackboard。"); return; }
  if (doc.status !== "ready") {
    renderBoardPlaceholder(doc.status === "failed" ? "解析未完成" : "正在建立 Blackboard", doc.message || "Agent 将按页阅读 PDF。");
    return;
  }
  try {
    const { blackboard, annotations } = await api(`/api/sessions/${state.activeId}/documents/${id}/blackboard`);
    if (state.selectedDocumentId === id) {
      state.board = blackboard;
      state.boardAnnotations = annotations;
      renderBlackboard(blackboard, doc);
    }
  } catch (error) { showToast(error.message); }
}

async function refreshDocuments(id) {
  if (!id) {
    state.documents = [];
    state.selectedDocumentId = null;
    renderDocumentTabs();
    await selectDocument(null);
    return;
  }
  const { documents } = await api(`/api/sessions/${id}/documents`);
  if (state.activeId !== id) return;
  state.documents = documents;
  await selectDocument(documents.some((doc) => doc.id === state.selectedDocumentId) ? state.selectedDocumentId : documents[0]?.id || null);
}

function renderThinkingLevels(levels, selected) {
  const labels = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
  state.thinkingLevels = levels;
  elements.thinkingSelect.replaceChildren();
  for (const level of levels) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = labels[level] || level;
    elements.thinkingSelect.append(option);
  }
  state.thinkingLevel = levels.includes(selected) ? selected : levels[0];
  elements.thinkingSelect.value = state.thinkingLevel;
}

function updateTextareaHeight() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 180)}px`;
}

function renderText(container, text) {
  container.innerHTML = markdown.render(text || "");
}

function addMessage(message, pending = false) {
  const row = document.createElement("div");
  row.className = `message ${message.role}${message.error ? " error" : ""}`;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = message.role === "user" ? "我" : "W";
  const main = document.createElement("div");
  main.className = "message-main";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = message.role === "user" ? "我" : "外脑";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  let thinking;
  let thinkingBody;
  let thinkingFollow = true;
  let thinkingOpenedOnce = false;
  let pendingRender = 0;
  let pendingMarkdown = "";
  if (message.role === "assistant") {
    thinking = document.createElement("details");
    thinking.className = "message-thinking";
    thinking.hidden = true;
    const summary = document.createElement("summary");
    summary.textContent = "思考过程";
    thinkingBody = document.createElement("div");
    thinkingBody.className = "message-thinking-body";
    thinkingBody.addEventListener("scroll", () => {
      thinkingFollow = isNearBottom(thinkingBody, 24);
      if (!thinkingFollow) state.followConversation = false;
    });
    thinking.addEventListener("toggle", () => {
      if (thinking.open) thinkingFollow = isNearBottom(thinkingBody, 24);
    });
    thinking.append(summary, thinkingBody);
    main.append(label, thinking, bubble);
  } else {
    main.append(label, bubble);
  }
  if (message.images) {
    const count = document.createElement("div");
    count.className = "message-image-count";
    count.textContent = `附带 ${message.images} 张图片`;
    main.append(count);
  }
  row.append(avatar, main);
  elements.messages.append(row);
  updateEmptyState();

  function update(text, isPending = false, isError = false) {
    row.classList.toggle("error", isError);
    if (isPending && !text) {
      if (pendingRender) cancelAnimationFrame(pendingRender);
      pendingRender = 0;
      bubble.replaceChildren();
      const typing = document.createElement("span");
      typing.className = "typing-indicator";
      for (let i = 0; i < 3; i++) typing.append(document.createElement("span"));
      bubble.append(typing);
    } else if (isPending) {
      pendingMarkdown = text;
      if (!pendingRender) pendingRender = requestAnimationFrame(() => {
        pendingRender = 0;
        renderText(bubble, pendingMarkdown);
        scrollToBottom();
      });
    } else {
      if (pendingRender) cancelAnimationFrame(pendingRender);
      pendingRender = 0;
      renderText(bubble, text);
    }
    if (!isPending || !text) scrollToBottom();
  }

  update(message.text, pending, Boolean(message.error));
  function updateThinking(text, open = false) {
    if (!thinking || !text) return;
    thinking.hidden = false;
    if (open && !thinkingOpenedOnce) {
      thinking.open = true;
      thinkingOpenedOnce = true;
    }
    const previousTop = thinkingBody.scrollTop;
    thinkingBody.textContent = text;
    if (thinking.open && thinkingFollow) thinkingBody.scrollTop = thinkingBody.scrollHeight;
    else thinkingBody.scrollTop = previousTop;
    scrollToBottom();
  }
  updateThinking(message.thinking);
  return { row, update, updateThinking };
}

function addTool(name, stateText) {
  const card = document.createElement("div");
  card.className = "tool-card";
  const label = document.createElement("strong");
  label.textContent = name;
  const status = document.createElement("span");
  status.textContent = ` · ${stateText}`;
  card.append(label, status);
  elements.messages.append(card);
  updateEmptyState();
  scrollToBottom();
  return status;
}

function renderHistory(messages, preserveScroll = false) {
  const previousTop = elements.conversation.scrollTop;
  const wasFollowing = state.followConversation;
  state.renderingHistory = true;
  if (!preserveScroll) state.followConversation = true;
  elements.messages.replaceChildren();
  for (let message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      if (message.role === "assistant" && !message.text && !message.thinking && !message.error) continue;
      if (message.role === "user") message = { ...message, text: message.text.split("\n\n[上传的 PDF：")[0] };
      addMessage(message);
    } else if (message.role === "tool") {
      addTool(message.name, message.error ? "执行失败" : "已完成");
    }
  }
  updateEmptyState();
  if (preserveScroll && !wasFollowing) {
    elements.conversation.scrollTop = previousTop;
    state.followConversation = false;
  } else {
    scrollToBottom(true);
  }
  state.renderingHistory = false;
}

function formatSessionDate(value) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function renderSessions() {
  elements.sessionList.replaceChildren();
  elements.sessionCount.textContent = String(state.sessions.length);
  if (!state.sessions.length) {
    const empty = document.createElement("p");
    empty.className = "session-empty";
    empty.textContent = "对话会自动保存在这里。";
    elements.sessionList.append(empty);
    return;
  }
  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-item${session.id === state.activeId ? " active" : ""}`;
    button.setAttribute("aria-label", `打开对话：${session.title}`);
    button.innerHTML = '<svg class="session-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 3V5Z"/></svg>';
    const copy = document.createElement("span");
    copy.className = "session-copy";
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = session.title;
    const meta = document.createElement("span");
    meta.className = "session-meta";
    meta.textContent = `${session.running ? "生成中 · " : ""}${formatSessionDate(session.modified)}`;
    copy.append(title, meta);
    button.append(copy);
    button.addEventListener("click", () => { void loadSession(session.id); });
    elements.sessionList.append(button);
  }
}

async function refreshSessions() {
  const body = await api("/api/sessions");
  state.sessions = body.sessions;
  renderSessions();
}

function startPolling(id) {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try {
      const { session } = await api(`/api/sessions/${id}`);
      if (!session.running) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        state.runningId = null;
        updateControls();
        await refreshSessions();
        if (state.activeId === id) {
          renderHistory(session.messages, true);
          await refreshDocuments(id);
        }
      }
    } catch {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }, 1800);
}

async function loadSession(id) {
  try {
    const { session } = await api(`/api/sessions/${id}`);
    state.activeId = id;
    elements.sessionTitle.textContent = session.title;
    renderThinkingLevels(session.thinkingLevels, session.thinkingLevel);
    renderHistory(session.messages);
    await refreshDocuments(id);
    renderSessions();
    closeSidebar();
    if (session.running && !state.runningId) {
      state.runningId = id;
      startPolling(id);
    }
    updateControls();
  } catch (error) {
    showToast(error.message);
  }
}

function newChat() {
  state.activeId = null;
  state.followConversation = true;
  elements.sessionTitle.textContent = "新的对话";
  elements.messages.replaceChildren();
  renderThinkingLevels(state.thinkingLevels, localStorage.getItem("demoThinkingLevel") || "off");
  updateEmptyState();
  renderSessions();
  void refreshDocuments(null);
  closeSidebar();
  elements.messageInput.focus();
}

function renderAttachments() {
  elements.attachmentList.replaceChildren();
  elements.attachmentList.hidden = state.attachments.length === 0;
  for (const [index, attachment] of state.attachments.entries()) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const preview = document.createElement("img");
    if (attachment.kind !== "pdf") {
      preview.src = attachment.preview;
      preview.alt = "";
    }
    const name = document.createElement("span");
    name.textContent = attachment.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `移除 ${attachment.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.attachments.splice(index, 1);
      renderAttachments();
      updateControls();
    });
    chip.append(attachment.kind === "pdf" ? boardNode("span", "attachment-pdf", "PDF") : preview, name, remove);
    elements.attachmentList.append(chip);
  }
}

async function addFiles(files) {
  const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  for (const file of files) {
    if (state.attachments.length >= 3) { showToast("每次最多附加 3 个文件"); break; }
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      if (file.size > 25 * 1024 * 1024) { showToast("PDF 不能超过 25 MB"); continue; }
      state.attachments.push({ kind: "pdf", name: file.name, file });
      continue;
    }
    if (!allowed.has(file.type) || file.size > 3 * 1024 * 1024) {
      showToast("请选择不超过 3 MB 的 PNG、JPEG、WebP 或 GIF 图片");
      continue;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(file);
    });
    state.attachments.push({ kind: "image", name: file.name, mimeType: file.type, data: dataUrl.split(",")[1], preview: dataUrl });
  }
  renderAttachments();
  updateControls();
}

async function sendMessage() {
  if (state.runningId) { showToast("请等待当前回答完成"); return; }
  const text = elements.messageInput.value.trim();
  const images = state.attachments.filter((item) => item.kind === "image").map(({ mimeType, data }) => ({ mimeType, data }));
  const pdfs = state.attachments.filter((item) => item.kind === "pdf");
  if (!text && !images.length && !pdfs.length) return;
  if (!state.model) { showToast("请先配置模型"); return; }

  let id = state.activeId;
  try {
    if (!id) {
      const body = await api("/api/sessions", { method: "POST" });
      id = body.session.id;
      state.activeId = id;
      elements.sessionTitle.textContent = text.slice(0, 36) || (pdfs.length ? "PDF 阅读" : "图片对话");
    }
    const displayText = text || (pdfs.length ? "请解析上传的 PDF 并建立 Blackboard。" : "请描述这些图片。");
    state.followConversation = true;
    addMessage({ role: "user", text: `${displayText}${pdfs.length ? `\n\nPDF：${pdfs.map((item) => item.name).join("、")}` : ""}`, images: images.length });
    let draft = addMessage({ role: "assistant", text: "" }, true);
    let draftText = "";
    let draftThinking = "";
    const activeToolStatuses = new Map();
    state.runningId = id;
    elements.messageInput.value = "";
    state.attachments = [];
    renderAttachments();
    updateTextareaHeight();
    updateControls();
    await refreshSessions();

    const files = [];
    for (const attachment of pdfs) {
      const response = await api(`/api/sessions/${id}/documents`, {
        method: "POST", headers: { "content-type": "application/pdf", "x-file-name": encodeURIComponent(attachment.name) },
        body: attachment.file,
      });
      files.push(response.document.id);
    }
    if (pdfs.length) {
      await refreshDocuments(id);
      document.body.classList.add("board-open");
    }

    const response = await fetch(`/api/sessions/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, images, files, thinkingLevel: elements.thinkingSelect.value }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `请求失败 (${response.status})`);
    }
    if (!response.body) throw new Error("浏览器未提供响应流");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamError = null;
    function handleEvent(event) {
      if (state.activeId !== id) return;
      if (event.type === "text_delta") {
        if (!draft) draft = addMessage({ role: "assistant", text: "" }, true);
        draftText += event.text;
        draft.update(draftText, true);
      } else if (event.type === "thinking_delta") {
        if (!draft) draft = addMessage({ role: "assistant", text: "" }, true);
        draftThinking += event.text;
        draft.updateThinking(draftThinking, true);
      } else if (event.type === "message_end") {
        if (!draft) draft = addMessage(event.message);
        else if (!event.message.text && !event.message.thinking && !event.message.error) draft.row.remove();
        else {
          draft.update(event.message.text || event.message.error, false, Boolean(event.message.error));
          draft.updateThinking(event.message.thinking || draftThinking);
        }
        draft = null;
        draftText = "";
        draftThinking = "";
      } else if (event.type === "tool_start") {
        activeToolStatuses.set(event.callId, addTool(event.name, "正在运行"));
      } else if (event.type === "tool_end") {
        const status = activeToolStatuses.get(event.callId);
        if (status) {
          status.textContent = ` · ${event.error ? "执行失败" : "已完成"}`;
          activeToolStatuses.delete(event.callId);
        } else {
          addTool(event.name, event.error ? "执行失败" : "已完成");
        }
      } else if (event.type === "status") {
        addTool("状态", event.text);
      } else if (event.type === "pdf_progress") {
        const doc = state.documents.find((item) => item.id === event.documentId);
        if (doc) {
          Object.assign(doc, { status: event.phase === "failed" ? "failed" : event.phase === "ready" ? "ready" : "processing", percent: event.percent ?? doc.percent, message: event.message });
          renderDocumentTabs();
          if (state.selectedDocumentId === doc.id) {
            updateBoardProgress(doc);
            if (doc.status !== "ready") renderBoardPlaceholder(doc.status === "failed" ? "解析未完成" : "正在建立 Blackboard", doc.message);
          }
        }
      } else if (event.type === "blackboard_ready") {
        void refreshDocuments(id).catch((error) => showToast(error.message));
      } else if (event.type === "error") {
        streamError = event.message;
        if (!draft) draft = addMessage({ role: "assistant", text: "", error: true });
        draft.update(event.message, false, true);
      }
    }
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) if (line.trim()) handleEvent(JSON.parse(line));
      if (done) break;
    }
    if (buffer.trim()) handleEvent(JSON.parse(buffer));
    if (streamError) showToast(streamError);
  } catch (error) {
    showToast(error.message);
  } finally {
    state.runningId = null;
    updateControls();
    try {
      await refreshSessions();
      if (state.activeId === id && id) await refreshDocuments(id);
    } catch (error) {
      showToast(error.message);
    }
  }
}

async function stopGeneration() {
  if (!state.runningId) return;
  elements.stopButton.disabled = true;
  try {
    await api(`/api/sessions/${state.runningId}/abort`, { method: "POST" });
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.stopButton.disabled = false;
  }
}

async function initialize() {
  try {
    const [status] = await Promise.all([api("/api/status"), refreshSessions()]);
    state.model = status.model;
    renderThinkingLevels(status.thinkingLevels, state.thinkingLevel);
    elements.connectionText.textContent = "服务已连接";
    elements.modelPill.textContent = status.model ? status.model.id : "模型未配置";
    if (state.sessions.length) await loadSession(state.sessions[0].id);
    updateControls();
  } catch (error) {
    elements.connectionText.textContent = "连接失败";
    elements.connectionPill.classList.add("offline");
    elements.modelPill.textContent = "服务不可用";
    updateControls();
    showToast(error.message);
  }
}

elements.newChatButton.addEventListener("click", newChat);
elements.menuButton.addEventListener("click", () => document.body.classList.add("sidebar-open"));
elements.sidebarBackdrop.addEventListener("click", closeSidebar);
elements.composerForm.addEventListener("submit", (event) => { event.preventDefault(); void sendMessage(); });
elements.conversation.addEventListener("scroll", () => {
  if (!state.renderingHistory) state.followConversation = isNearBottom(elements.conversation);
});
elements.conversation.addEventListener("wheel", (event) => {
  if (event.deltaY < 0) state.followConversation = false;
}, { passive: true });
elements.messageInput.addEventListener("input", () => { updateTextareaHeight(); updateControls(); });
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composerForm.requestSubmit();
  }
});
elements.attachButton.addEventListener("click", () => elements.imageInput.click());
elements.imageInput.addEventListener("change", () => {
  void addFiles([...elements.imageInput.files]).catch((error) => showToast(error.message));
  elements.imageInput.value = "";
});
elements.boardToggle.addEventListener("click", () => document.body.classList.toggle("board-open"));
elements.boardSearch.addEventListener("input", () => {
  const query = elements.boardSearch.value.trim();
  const request = ++state.searchRequest;
  clearTimeout(state.searchTimer);
  state.boardSearchResults = null;
  const doc = state.documents.find((item) => item.id === state.selectedDocumentId);
  if (state.board && doc) renderBlackboard(state.board, doc);
  if (query.length < 2 || !doc) return;
  const sessionId = state.activeId;
  state.searchTimer = setTimeout(async () => {
    try {
      const result = await api(`/api/sessions/${sessionId}/documents/${doc.id}/search?q=${encodeURIComponent(query)}`);
      if (request !== state.searchRequest || sessionId !== state.activeId || doc.id !== state.selectedDocumentId) return;
      state.boardSearchResults = { query, ...result };
      if (state.board) renderBlackboard(state.board, doc);
    } catch (error) { if (request === state.searchRequest) showToast(error.message); }
  }, 240);
});
elements.pageViewerClose.addEventListener("click", () => elements.pageViewer.close());
elements.pageViewerZoom.addEventListener("click", () => {
  const actual = elements.pageViewer.classList.toggle("actual-size");
  elements.pageViewerZoom.textContent = actual ? "适合窗口" : "实际尺寸";
});
elements.pageViewer.addEventListener("close", () => { elements.pageViewerImage.removeAttribute("src"); });
elements.stopButton.addEventListener("click", () => { void stopGeneration(); });
elements.thinkingSelect.addEventListener("change", () => {
  const level = elements.thinkingSelect.value;
  const previous = state.thinkingLevel;
  const id = state.activeId;
  if (!id) {
    state.thinkingLevel = level;
    localStorage.setItem("demoThinkingLevel", level);
    return;
  }
  void api(`/api/sessions/${id}/thinking`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level }),
  }).then(({ level: effective }) => {
    if (state.activeId === id) {
      state.thinkingLevel = effective;
      elements.thinkingSelect.value = effective;
    }
    localStorage.setItem("demoThinkingLevel", effective);
  }).catch((error) => {
    if (state.activeId === id) elements.thinkingSelect.value = previous;
    showToast(error.message);
  });
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    newChat();
  }
});
for (const card of document.querySelectorAll(".starter-card")) {
  card.addEventListener("click", () => {
    elements.messageInput.value = card.dataset.prompt;
    elements.messageInput.focus();
    updateTextareaHeight();
    updateControls();
  });
}

void initialize();
