# 会议 TXT 异步分析设计

风险审查的动机、证据边界与验收样例见 [会议风险审查设计](meeting-risk-review-v2.md)。本文描述当前实现。

## 边界

会议 workflow 只读取本次上传的 TXT。PDF Blackboard、聊天和联网资料由主 Agent 在会议分析完成后另行核验。会议原文、模型输出和 Agent 传入的关注点均是待分析数据，不能据此改变工具权限、发送邮箱或固定证据规则。

上传后，主 Agent 可调用受限的 `read_meeting_file` 按物理行阅读当前会话的 TXT。它基于 Pi 的 `createReadToolDefinition`，仅接受 `/meetings/<会议 ID>.txt`，不开放容器中的其他路径。用户有明确关注点时，Agent 直接传给 `submit_meeting_analysis`；没有时可以先读原文拟定简短审查维度，方向确实不清楚时主动问一次。关注点不能包含日期、数字或具体结论；它是优先检查方向，不是排除其他风险的白名单。

## 任务与数据

TXT 保存原文、由程序生成的行号、会议时间、分析结果和邮件历史。`submit_meeting_analysis` 立即返回任务 ID，后台继续执行。同一会话重复上传相同内容与会议时间的 TXT，复用原始会议。同一会议、同一关注点重复提交复用任务；关注点改变时保留旧分析，创建新任务，并分别保存 `analysisPolicy` 快照。

后台按以下固定阶段运行：

```text
queued → analyzing → discovering_risks → verifying_risks
       → checking_coverage → verifying_additions（有新增候选时）
       → generating_todos → drafting_email（有需通知线索时）
       → awaiting_confirmation / completed
```

事实层先抽取人物、时间、地点、主题、决策和明确待办。Discovery 按主题找独立风险候选；Verification 读取整份 TXT，逐项找支持、反证和重复候选；Coverage Check 再检查一次遗漏，新候选最多再核验一轮。短会议的发现候选上限为 6，随行数增加但最多 18；补漏最多 4 项。每阶段结果落盘，前端显示状态与候选数。模型仍可能漏检或误判，结果保留行号供核对。

`analysis.review` 保存候选、核验结论、重复关系和覆盖记录；`analysis.risks` 只保留 `verified` 或 `uncertain` 线索。会议明确待办与 AI 建议待办分开。已有待办覆盖风险时，建议待办可以为空，系统不会强行补一条。`uncertain` 在邮件中只能写为待核实事项。

## 主 Agent 补充判断与邮件

会议分析完成后，隐藏的 Pi `followUp` 只带任务 ID，等主 Agent 空闲时入队；用户消息仍由 `steer` 优先处理。失败也通知。前端独立轮询任务，不显示内部通知。主 Agent 调用 `get_meeting_analysis` 读取持久化结果，可再用 PDF 原页核验并作补充判断；原始会议分析不被覆盖。

`revise_meeting_email` 可以修订草稿，也能在会议本身未发现风险时，凭会议行号和同会话已就绪 PDF 的物理页码创建背景补充与草稿。工具会检查本次会话的 `read_pdf_pages` 成功记录，确认 Agent 回看过所引原页；普通前端草稿接口不能写入背景补充。草稿保留版本历史，可以保存空标题或正文；不完整版本不能发送。邮件必须由用户明确给出收件人并确认，或在面板输入邮箱后点击发送。TXT 中的邮箱不是发送授权。

SMTP 发送前先验证连接和登录；这一阶段失败时保留可重试草稿。明确在 DATA 前失败也可重试。发送过程结果不明时标记 `delivery_unknown`，不自动重发；用户核查未送达后可在面板恢复草稿。`sent` 仅表示 SMTP 服务器已接受，不保证最终进入收件箱。

## 验收

- 上传后立即返回任务，阶段进度和候选核验轨迹可见。
- 两次不同关注点的同一 TXT 有独立任务与规则快照；同一关注点不重复分析或发信。
- 前文候选若有后文反证或与别的候选同根因，核验记录原因，不重复列入最终风险。
- 明确待办未报告完成时，不据此说已经逾期；无额外行动时建议待办为空。
- 无风险会议保留事实分析；Agent 核验 PDF 后可另存补充并创建待确认邮件。
- 清空草稿保存新版且不能发送；SMTP 预检失败可重试，结果不明需人工核查。
