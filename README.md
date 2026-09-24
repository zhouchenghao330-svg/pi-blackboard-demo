# AI 外脑 Demo

当前可运行的部分是单页对话工作台：Pi SDK 驱动的会话、流式回答、Markdown 展示、图片、PDF 与会议 TXT 输入、联网搜索、思考强度与思考内容展示、停止生成和历史会话恢复。上传 PDF 后，主 Agent 调用 `ingest_pdf` 按页建立 Blackboard；右侧展示解析进度、文档概览、主题导航、关键线索、逐页索引和跨页连接。页面可搜索模型笔记及 PDF 原生文本层，按需打开高清页图，追加人工修正。`get_blackboard` 让 Agent 获取最新索引与修正，`search_pdf_text` 定位文本，`read_pdf_pages` 按物理页码核验原图。上传会议 TXT 后，主 Agent 可用受限的 `read_meeting_file` 阅读原文，再通过 `submit_meeting_analysis` 提交本次审查重点。后台分阶段发现、核验和补漏；会议面板展示进度、行号证据、审查轨迹、风险、两类待办和邮件草稿。完成通知是隐藏的内部 follow-up，主 Agent 再调用 `get_meeting_analysis`；用户消息以 steer 优先进入当前任务。主 Agent 可基于已核验 PDF 原页补充判断并创建或修改邮件草稿。草稿可以清空；邮件须用户确认收件人后才会发送。用户明确要求 PPT 时，主 Agent 可提交后台快速制作任务；独立 Pi 工作会话依照 PPT Master 生成 SVG、检查并导出可编辑 PPTX，前端 PPT 面板显示进度和下载入口。

## 启动

```bash
cp .env.example .env
docker compose up --build -d
docker compose ps
curl http://127.0.0.1:3000/health
```

浏览器打开 `http://127.0.0.1:3000`。对话及 PDF 原文件、压缩页图、Blackboard、文本层缓存和修正历史保存在 Docker 卷中，容器重建后仍可查看。单份 PDF 最多 25 MB、默认最多 100 页（可用 `MAX_PDF_PAGES` 调整）；超页数会在渲染和模型阅读前拒绝。解析使用 120 DPI、JPEG 质量 80、最多 2 批并发，4 页一批并重叠 1 页。高清页图在打开时按 220 DPI 渲染并缓存。人工修正只追加，不覆盖原始模型笔记。Blackboard 的概述、事实、定位线索和跨页解释均来自模型，可能有误；PDF 文本层可能缺失或打乱表格顺序，扫描件可能完全没有文本层。精确事实应回看对应页图。

默认不配置模型也能启动服务，但不能发送对话。接入模型时，编辑 `.env` 的 `DEMO_MODEL_BASE_URL` 和 `DEMO_MODEL_ID`，按实际接口设置 `DEMO_MODEL_API` 与密钥，然后运行 `docker compose up -d --force-recreate`。Pi 的模型配置会写入容器的 `/data/pi-agent/models.json`。模型接口必须真正支持图像输入，才能使用图片附件及后续 PDF 视觉阅读。

思考强度按会话保存，页面提供关闭、极低、低、中、高；回答中的思考内容可展开。默认适配 Qwen + vLLM：`DEMO_MODEL_THINKING_FORMAT=qwen-chat-template` 控制思考开关，`DEMO_MODEL_THINKING_BUDGET_FIELD=thinking_token_budget` 让不同档位使用 Pi 的不同思考 token 预算。换其他模型或服务时，需按其接口调整这两个配置；不支持思考的模型设置 `DEMO_MODEL_REASONING=false`。

容器内的 `/data/uploads`、`/data/outputs`、`/data/meetings` 和 `/data/pi-agent` 由 Compose 的 `demo_data` 卷持久化，Pi 会话位于 `/data/sessions`。PDF 页渲染工具 `pdftoppm` 和 `pdfinfo` 已安装在容器内。

PPT 制作使用独立的 `ppt-worker` 容器，不接收 SMTP 密钥。PPT Master Skill 的完整运行资源固定在 `vendor/ppt-master/skills/ppt-master`，构建时复制进 worker 镜像；来源版本和许可见 `vendor/ppt-master/UPSTREAM.md`。工作目录、任务状态和 PPTX 保存在 Docker 卷的 `/data/ppt-projects` 与 `/data/ppt-jobs`。第一版使用 Quick 路线、2–12 页、无 AI 生图；主 Agent 将已核验的资料交给制作会话，PDF Blackboard 不能直接充当事实依据。下载文件需要制作容器真正完成质量检查和导出。

`examples/ppt/` 提供一份使用演示项目介绍生成的两页 PPTX、对应 SVG 页面和最终质量检查报告，供代码审查时核对产物格式。运行时生成的文件仍保存在 Docker 卷中；示例不包含上传的 PDF、会议原文或会话数据。

联网搜索由主 Agent 的 `web_search` 工具调用 Tavily。将密钥写入 `.env` 的 `TAVILY_API_KEY`，重建容器后即可使用。搜索会返回网页链接、摘要与可用的发布日期；时效性回答应引用来源，未检索成功时不能冒充已联网。

会议分析只读取 TXT，不自动读取 PDF；主 Agent 可在取得会议结果后另行核验背景。TXT 默认最多 512 KB、40000 字。行号是原文物理行号；模型风险判断仍需人工核对。同一 TXT 使用不同审查重点会保留独立分析记录；无明显风险时不自动生成邮件，但主 Agent 核验背景后可创建待确认草稿。邮件真实发送需要在 `.env` 配置 `MEETING_SMTP_HOST`、`MEETING_SMTP_PORT`、`MEETING_SMTP_FROM`，需要认证时还要配置 `MEETING_SMTP_USER` 和 `MEETING_SMTP_PASS`。未配置 SMTP 时仍可查看和编辑草稿，发送会明确报错。`sent` 表示 SMTP 服务器已接受，不能保证对方收件箱已收到。流程与恢复规则见 [会议设计](docs/meeting-workflow.md)。
