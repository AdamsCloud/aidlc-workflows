# ZCode Harness 移植研究笔记（Phase 0 产出）

来源：zcode.cjs 0.16.9 静态分析（payload 构造代码 + zod schema）+ aidlc runtime v2.11.0 源码交叉验证。
方法：无头 `-p` 会话因"Select a model before continuing"不可用（模型选择由桌面版按请求注入，
不落盘；local_setting 注入 user/model/modelSelection 无效），改为 bundle 静态分析，结论更完整。

## 1. ZCode hook stdin 载荷（camelCase，Claude 同源）

| 事件 | 载荷字段 |
|---|---|
| SessionStart | agentName, cwd, hookEventName, mode, model?("providerId/modelId"), sessionId, source(startup\|resume\|clear\|compact), timestamp, traceId, turnId |
| UserPromptSubmit | agentName?, attachmentsSummary?, cwd, hookEventName, mode, prompt, sessionId, timestamp, traceId, turnId |
| PreToolUse | cwd, hookEventName, mode, riskLevel, sessionId, sideEffectScope, timestamp, toolCallId, toolInput, toolName, traceId, turnId |
| PostToolUse | artifactRefs?, cwd, hookEventName, mode, sessionId, timestamp, toolCallId, toolInput, toolName, toolResponse, toolResultPreview, traceId, turnId |
| PostToolUseFailure | cwd, error{message,type}, hookEventName, isInterrupt, mode, sessionId, timestamp, toolCallId, toolInput, toolName, traceId, turnId |
| PermissionRequest | cwd, hookEventName, mode, reason("Tool <name> ..."), sessionId, timestamp, toolCallId?, toolName, traceId, turnId |
| Stop | agentName, cwd, hookEventName, mode, responsePreview, responseText, sessionId, stopHookActive, timestamp, toolCallCount, traceId, turnId |

matcher 匹配目标：工具事件→toolName（别名 Task↔Agent、Write/Edit←ApplyPatch）；SessionStart→source；
UserPromptSubmit→prompt 文本；Stop→responsePreview。非法正则静默不匹配。

## 2. ZCode hook 输出 schema（严格，多余键报错；或用 exit code）

- exit code：0=通过，2=阻断（PreToolUse/PermissionRequest 为 deny），其他非零=报错
- JSON 输出（按 hookEventName 判别联合）：
  - PreToolUse: {additionalContext?, permissionDecision?: allow|ask|deny}
  - UserPromptSubmit/SessionStart/PostToolUse/PostToolUseFailure: {additionalContext?}
  - PermissionRequest: {decision: {behavior: allow|deny|ask, permissionUpdates?: [...]}}
  - Stop: {additionalContext?, additional_context?, continue?: boolean, decision?: approve|block, hookSpecificOutput?, reason?, stopReason?}
    —— 与 Claude 的 {"decision":"block","reason":...} 语义对齐，可近直通
- Stop 延续上限 3 次（stopHookActive 防环，同 Claude）
- 配置形态：hooks.events.<Event> + hooks.enabled:true；hook 条目 type=process(command+args 数组，最可移植) 或 command(shell 字符串)；
  timeoutMs 优先于 timeout(秒)

## 3. 归一化映射（adapter：ZCode → Claude 形，喂给 core hook）

| ZCode (camel) | Claude (snake) | 备注 |
|---|---|---|
| sessionId | session_id | |
| hookEventName | hook_event_name | 值同名（PreToolUse 等） |
| toolName | tool_name | |
| toolInput | tool_input | |
| toolResponse | tool_response | |
| stopHookActive | stop_hook_active | |
| source | source | SessionStart，值同 Claude |
| prompt | prompt | UserPromptSubmit |
| cwd | cwd | 同 |
| — | transcript_path | 不映射。核心已支持无转录（Kiro/opencode 同样不提供，continue-workflow.ts L1666 注释明示） |

控制通道直通：core hook 的 exit 2 + stderr → ZCode deny；Stop 的 {"decision":"block"} → ZCode 接受。
additionalContext：core 若输出 Claude 形 hookSpecificOutput.additionalContext，adapter 提升为顶层 additionalContext。

## 4. 事件映射（→ aidlc core hooks）

- SessionStart → session-start
- UserPromptSubmit → record-human-turn
- PreToolUse → fold-usage / deliver-stage-rules / state-transition-guard / reviewer-scope / review-freeze / plan-approval-guard
- PostToolUse → write-audit-log / run-sensors / sync-workflow-state(TodoWrite|TaskOutput) / rebuild-stage-graph(Bash) / deliver-stage-rules / fold-usage
- Stop → continue-workflow
- 放弃：SessionEnd / PreCompact / SubagentStop（ZCode 无对应事件；上游允许，见 09-porting 文档）

## 5. 其他实测结论

- hooks 配置只在会话启动时加载（本会话中途写入 .zcode/config.json 不生效）
- `~/.zcode/v2/credentials.json` 为共享凭据；CLI 读它但模型选择不落盘
- ZCode app-server 协议为自定义信封（非 JSON-RPC 2.0：拒绝 jsonrpc 键），未完成逆向
- 无头 `zcode -p` 当前不可用（模型问题）；Phase 3 实测需桌面版真实会话
- 本机探针残留：ai-project/aidlc-probe/（含 .zcode/config.json 探针）与 workspace/default/.zcode/config.json（探针）——Phase 3 后清理

## 6. 移植过程中实测确认的关键契约（补充）

- **适配器执行契约**：分发器进程内 `import()` 适配器模块并调 `run(target, input, extraArgs)`，
  stdin 已由分发器读好传入；适配器导出 `run` 即可，绝不能在模块顶层 process.exit
  （会把分发器一起杀掉）。`AIDLC_COMPILED_EXECUTABLE` 指向自身时走 `[exe, engine, hook, name]`，
  否则 `[bun, tools/aidlc.ts, engine, hook, name]`。`guard-tool-call` 是分发器级复合目标，
  经 `engine hook` 自动展开四个 guard。
- **matcher 空串致命**：`"matcher": ""` 使整个 .zcode/config.json 加载失败
  （日志 `config.file.invalid: Too small: expected string to have >=1 char`）；
  匹配一切必须**省略** matcher 键。此坑在真实会话中踩到并已修复。
- **工作区信任门**：项目级 config hooks 首次加载需用户在桌面版确认信任
  （`config.project_hooks.pending_trust` → 信任存储 `workspace-hook-trust-v1.json`，
  状态机含 stale_digest：信任锚定配置内容摘要，配置变更会重新要求信任）。
- **doctor 三处 harness 名单**：`aidlc-config-diagnostics.ts` 的 distribution 白名单、
  `aidlc-utility.ts` 的 settings 检查分支（zcode 改查 config.json/commands）、
  `aidlc-model-policy.ts` 的 HARNESS_HONESTY/HARNESS_PRODUCT_NAMES。
- **tierFlavor=claude 的打包器前提**：`expandClaudeToolAllows`/`rewriteClaudeNativePermissions`
  假定存在 settings.json，zcode 无此文件需存在性守卫（已加）。
- **真实验证（2026-10-14）**：桌面会话中 /aidlc --doctor 通过 36 项检查 0 问题，
  hooks 心跳落盘（record-human-turn 生效），信任门经用户确认后放行。

## 7. 性能：同镜像 spawn 病态与 Codex #2066 模式（必读）

**现象**：本机（Win10，Defender 开）上 Bun 运行时进程**同步拉起同一个自身镜像**
（bun.exe→bun.exe 或 aidlc.exe→aidlc.exe）稳定耗时 10 秒；拉起不同镜像 0.3 秒；
node.exe 做同样的事 0.3 秒。Bun.spawnSync / Bun.spawn(异步) / node:child_process
三种 API 全部中招——是镜像层病态，与 API 无关，也与 aidlc 无关。

**后果**：初版 zcode 适配器照抄 kiro 的"每 hook 一个子进程"模式，ZCode 又是
内联执行 hooks（每个工具调用都等 hook 跑完）→ 每次工具调用 +10~22 秒，
用户实测"非常慢"。

**官方先例**：Codex 适配器踩过同一个坑——issue **#2066 "一条 ls 九次引擎加载"**
（Codex 对每个匹配 handler 各起一个子进程，每个子进程重新加载整个引擎）。
官方修复 = `runCoreHere`：热路径 hook（每次工具调用都跑的 guard 组、
rebuild-stage-graph 等）**进程内 import** hook 模块（拦截 stdout/stderr 收集，
环境 pin 项目目录），仅 `record-human-turn`（权威边界：实现不得进入可 import
进程，防止伪造人轮记录）与 import 失败时回退子进程。kiro 的 guard 组同样
进程内递归自调（它的守卫逻辑本来就在适配器里），仅审计/传感器/会话启动走子进程。

**zcode 最终采用 Codex 模式**（2026-10-14 实测）：

| 目标 | 子进程模式 | Codex 模式（进程内） |
|---|---|---|
| guard-tool-call（每次工具调用） | 10.8s | **1.3s** |
| fold-usage | 11.5s | **1.2s** |
| write-audit-log（每次写入） | 11.5s | **1.4s** |
| continue-workflow（Stop） | 11.6s | **1.3s** |
| record-human-turn（每次提示词） | 22s（双 spawn） | **8s**（单 spawn，权威边界底价） |

剩余 ~1.2s = shim + 分发器固定启动开销，与 Claude 每次 hook 成本一致。
record-human-turn 的 8s 是本机病态底价（干净机器约 0.5s），每次提示词一次，可接受。
**教训：新 harness 的适配器凡是跑在 aidlc 进程内的，一律进程内 import 核心 hook，
子进程只留给权威边界与兜底。**

**guard-tool-call 复合组**：适配器内复刻分发器 HOOK_GROUPS 语义
（state-transition-guard / reviewer-scope / review-freeze 用 READ_WRITE_OR_SHELL
matcher，plan-approval-guard 用 WRITE_SHELL_OR_DISPATCH；exit 2 收集 refusal，
其他非零取第一个为失败码，原因写 stderr）。


