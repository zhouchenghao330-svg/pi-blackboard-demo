# Blackboard 视觉阅读实验

本目录保留命令行实验入口；同一解析器也通过主 Agent 的 `ingest_pdf` 工具调用。实验 PDF 通过只读挂载进入容器，页图和笔记写入 `labs/results/`（已忽略，不提交原始文件及实验数据）。

按 PDF 物理页 4 页一批，前后重叠 1 页。默认串行，后一批接收当前页图和上一批完整笔记。`--concurrency 2` 把相邻两批同时送给模型；同一轮中的后一批尚看不到前一批笔记，只靠重叠页理解跨页内容，不能补充或纠正旧笔记。两批都完成后按页序追加。先前笔记仅供理解上下文，新页事实和文字锚点必须来自当前页图。批次 `page_notes` 只覆盖新页。补充或纠错通过 `overlap_additions` 追加；纠错用事实 ID 指向旧结论，黑板投影标记旧结论已被替代。阅读不清的内容绑定页码和回看标记。所有模型笔记通过 `entries.jsonl` 追加；完成后从这些记录生成 `blackboard.json` 和 `blackboard.md`。批次或总览结构无效时最多重试一次，仍失败可用相同命令续跑已完成批次。

从项目根目录运行（模型配置沿用 `.env`）：

```bash
docker compose run --rm --no-deps \
  -v "$PWD/labs:/app/labs" \
  -v "/absolute/path/document.pdf:/inputs/document.pdf:ro" \
  app node labs/blackboard/ingest.mjs \
  --input /inputs/document.pdf \
  --name document.pdf \
  --concurrency 2 \
  --dpi 120 \
  --jpeg-quality 80 \
  --output /app/labs/results/document
```

两个测试文件的批次安排：

- 7 页：1–4、4–7。
- 14 页：1–4、4–7、7–10、10–13、13–14。

默认参数是 1 并发、144 DPI、JPEG 质量 85。不同参数使用不同输出目录。每个实验目录包含 `source.pdf`、`manifest.json`、`entries.jsonl`、`pages/`、`pages.json`、`blackboard.json`、`blackboard.md` 与 `timing.json`，整个 `labs/results/` 已被 Git 忽略。`pages.json` 在页图渲染后、模型阅读前写出，可按 PDF 物理页码定位 JPEG；`source.pdf` 用于日后重新渲染高清页。计时从容器内脚本启动、PDF 已可读开始，不含 HTTP 上传或 Docker 启动。`imagesReadyMs` 表示全部页图和 `pages.json` 已就绪，`blackboardReadyMs` 表示黑板文件写完。模型笔记用于导航，关键结论仍应回看对应页图。

`pageMap` 中的事实和文字锚点是模型生成的未核实笔记，不等于从 PDF 精确抽取的引文。主 Agent 后续使用日期、数字、条件或公式下结论时，应按 `image` 字段回读原页。实验记录见 [RESULTS.md](RESULTS.md)。

当前 Pi `AgentSession.prompt()` 没有直接设置响应 `json_schema` 的参数；实验用提示词约束 JSON，并在写入前由程序校验结构和页码。无效输出保存在实验目录，不追加为有效笔记。
