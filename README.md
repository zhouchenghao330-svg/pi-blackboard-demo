# AI 外脑 Demo

当前可运行的部分是单页对话工作台：Pi SDK 驱动的会话、流式回答、Markdown 展示、图片与 PDF 输入、思考强度与思考内容展示、停止生成和历史会话恢复。上传 PDF 后，主 Agent 调用 `ingest_pdf` 按页建立 Blackboard；右侧展示解析进度、文档概览、主题导航、关键线索、逐页索引和跨页连接。页面可搜索模型笔记及 PDF 原生文本层，按需打开高清页图，追加人工修正。`get_blackboard` 让 Agent 获取最新索引与修正，`search_pdf_text` 定位文本，`read_pdf_pages` 按物理页码核验原图。页面由原生 HTML、CSS 和 JavaScript 实现，服务与 PDF 页渲染工具运行在同一个容器内。会议分析、邮件和 PPT 仍是后续业务功能。

## 启动

```bash
cp .env.example .env
docker compose up --build -d
docker compose ps
curl http://127.0.0.1:3000/health
```

浏览器打开 `http://127.0.0.1:3000`。对话及 PDF 原文件、压缩页图、Blackboard、文本层缓存和修正历史保存在 Docker 卷中，容器重建后仍可查看。单份 PDF 最多 25 MB；解析使用 120 DPI、JPEG 质量 80、最多 2 批并发，4 页一批并重叠 1 页。高清页图在打开时按 220 DPI 渲染并缓存。人工修正只追加，不覆盖原始模型笔记。Blackboard 的概述、事实、定位线索和跨页解释均来自模型，可能有误；PDF 文本层可能缺失或打乱表格顺序，扫描件可能完全没有文本层。精确事实应回看对应页图。

默认不配置模型也能启动服务，但不能发送对话。接入模型时，编辑 `.env` 的 `DEMO_MODEL_BASE_URL` 和 `DEMO_MODEL_ID`，按实际接口设置 `DEMO_MODEL_API` 与密钥，然后运行 `docker compose up -d --force-recreate`。Pi 的模型配置会写入容器的 `/data/pi-agent/models.json`。模型接口必须真正支持图像输入，才能使用图片附件及后续 PDF 视觉阅读。

思考强度按会话保存，页面提供关闭、极低、低、中、高；回答中的思考内容可展开。默认适配 Qwen + vLLM：`DEMO_MODEL_THINKING_FORMAT=qwen-chat-template` 控制思考开关，`DEMO_MODEL_THINKING_BUDGET_FIELD=thinking_token_budget` 让不同档位使用 Pi 的不同思考 token 预算。换其他模型或服务时，需按其接口调整这两个配置；不支持思考的模型设置 `DEMO_MODEL_REASONING=false`。

容器内的 `/data/uploads`、`/data/outputs` 和 `/data/pi-agent` 由 Compose 的 `demo_data` 卷持久化，Pi 会话位于 `/data/sessions`。PDF 页渲染工具 `pdftoppm` 和 `pdfinfo` 已安装在容器内。
