# PiGO 验收用例代码证据矩阵

> 历史矩阵：本文件的逐项代码分类基线为 v0.15.2，不代表 v0.20.2 的执行结果。最新代码级准入结论与新增反例见 [v0.20.2 最新代码审核与验收准入报告](08-code-review-acceptance-report-v0.20.2.md)；原验收标准仍以 `05-acceptance-test-specification.md` 为准。

日期：2026-10-04（Asia/Shanghai）

审核提交：`ac36b37cfda6865294ee1828f4aafcdca9859c68`，应用版本 `0.15.2`。

关联：[审核报告](06-code-review-acceptance-report.md)、[原验收规格](05-acceptance-test-specification.md)。

## 口径

这是代码证据登记，不是已执行的完整验收报告。每条用例保留原要求，不因实现不足而降低标准。

- **代码支持**：对应路径存在，静态检查或相关单测支持；仍须在验收环境运行完整用例。
- **部分实现**：有实现，但所列行为、证据或边界不完整。
- **不满足**：存在明确反例、缺少必需功能或与标准直接冲突。
- **待运行确认**：需要 Cloudflare、浏览器、真实模型、性能或运维环境证据。
- **P1未交付**：不阻断 v1.0，但应列入发布限制。

共 141 个唯一 AT 用例：待运行确认 16；部分实现 48；代码支持 33；不满足 42；P1未交付 2。P0 138 条，P1 3 条。以上不是验收通过率。8 个 E2E 场景另见审核报告。

## AUTH

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-AUTH-001 | P0 | 待运行确认 | 公网 HTML/API 拦截取决于 Cloudflare 策略，本轮未访问生产边缘。 | src/server/auth.ts |
| AT-AUTH-002 | P0 | 待运行确认 | OTP 是外部 Access 配置，仓库不能证明当前身份源。 | docs/03-deployment-record-192.168.2.235.md |
| AT-AUTH-003 | P0 | 待运行确认 | 有身份解析和内部用户接口；需真实邮箱验证码 smoke。 | src/server/auth.ts;src/server/identity.ts |
| AT-AUTH-004 | P0 | 待运行确认 | 未授权邮箱拒绝必须在 Access 测试应用验证。 | 外部配置 |
| AT-AUTH-005 | P0 | 部分实现 | 有 RS256/issuer/audience 校验，缺少完整 JWT 路由反例测试。 | src/server/auth.ts |
| AT-AUTH-006 | P0 | 代码支持 | Run、事件和 SSE 入口按 ownerKeys 校验；基础存储隔离有测试。 | src/server/index.ts:525;src/server/run-store-pg.test.ts |
| AT-AUTH-007 | P0 | 待运行确认 | 有 Access logout 链接，旧令牌/旧 SSE 会话失效需实测。 | src/client/App.tsx:622 |
| AT-AUTH-008 | P0 | 部分实现 | 按邮箱映射稳定用户及 legacy owner 有单测；完整 OTP 切换迁移未复验。 | src/server/identity.test.ts |

## WS

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-WS-001 | P0 | 代码支持 | 独立工作区页不依赖模型 Key；API 只需身份认证。 | src/client/WorkspacesPage.tsx |
| AT-WS-002 | P0 | 部分实现 | 有 clone 路径；需真实 HTTPS/SSH 仓库与失败路径验收。 | src/worker/index.ts:442 |
| AT-WS-003 | P0 | 部分实现 | 已有目录注册不 checkout，但缺少对物理仓库归属的授权。 | AUD-02 |
| AT-WS-004 | P0 | 部分实现 | 不存在/非仓库有校验；同用户重名会更新已有记录，非严格拒绝。 | src/server/workspaces.ts:154 |
| AT-WS-005 | P0 | 代码支持 | 相对路径与 realpath/symlink 逃逸有实现和单测。 | src/worker/workspace-paths.test.ts |
| AT-WS-006 | P0 | 代码支持 | 创建 Run 前刷新 Git，dirty 时返回 409 与摘要。 | src/server/index.ts:573 |
| AT-WS-007 | P0 | 部分实现 | 默认检查可保存并由 UI 继承；默认预算字段不存在。 | GAP-01 |
| AT-WS-008 | P0 | 代码支持 | refresh 仅读取 Git 元数据，无 pull/reset/checkout。 | src/worker/index.ts:419 |
| AT-WS-009 | P0 | 代码支持 | unregister 只更新状态，不删除目录或历史 Run。 | src/server/workspaces.ts:144 |
| AT-WS-010 | P0 | 代码支持 | 没有普通用户删除源仓库的接口。 | src/server/index.ts:513 |
| AT-WS-011 | P0 | 不满足 | 用户 B 可重新注册用户 A 的同一物理仓库。 | AUD-02 |
| AT-WS-012 | P1 | P1未交付 | 尚无本地 Node/daemon。 | GAP-07 |

## MODEL

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-MODEL-001 | P0 | 部分实现 | 有四项静态目录与模型页；能力和可用性未从 Pi Runtime 验证。 | AUD-08 |
| AT-MODEL-002 | P0 | 不满足 | 配置 allowlist 后仍强制加入默认模型并扩展角色，不能严格限制目录。 | AUD-08 |
| AT-MODEL-003 | P0 | 部分实现 | Key 有掩码和更新时间；verifiedAt 不输出且从未实际验证。 | src/server/credential-vault.ts:89 |
| AT-MODEL-004 | P0 | 不满足 | 无效 Key 只要长度合格即可保存，并被视为可用。 | AUD-08 |
| AT-MODEL-005 | P0 | 代码支持 | 任务可保存不同 provider/model；Worker 从 Run 的两个角色读取。 | src/server/real-run.ts;src/worker/index.ts:680 |
| AT-MODEL-006 | P0 | 部分实现 | API 按角色路由；UI 仍被默认 provider 凭据组合锁住。 | AUD-09 |
| AT-MODEL-007 | P0 | 不满足 | 只配置一个支持双角色的 provider，仍可能因缺默认另一 provider 而无法新建真实任务。 | AUD-09 |
| AT-MODEL-008 | P0 | 不满足 | 入队前没有 provider/模型权限探测，审核不兼容可晚于开发才被发现。 | AUD-08 |
| AT-MODEL-009 | P0 | 代码支持 | 不存在模型明确返回 MODEL_NOT_FOUND，不取目录首项。 | src/server/model-catalog.test.ts |
| AT-MODEL-010 | P0 | 代码支持 | provider/model 固化在 Run，不随全局默认值变动。 | src/server/real-run.test.ts |
| AT-MODEL-011 | P0 | 不满足 | 凭据无版本快照；队列重领/人工恢复重新读取最新 Key。 | GAP-01 |
| AT-MODEL-012 | P0 | 代码支持 | 401/429/5xx/timeout/unsupported 分类与建议有单测。 | src/worker/provider-errors.test.ts |
| AT-MODEL-013 | P0 | 代码支持 | 按 provider 删除；其他 provider 与历史 Run 记录保留。 | src/server/credential-vault.test.ts |
| AT-MODEL-014 | P0 | 部分实现 | Vault 静态加密与部分错误脱敏存在；Diff/check 输出没有统一 secret redaction。 | GAP-06 |

## PI

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-PI-001 | P0 | 不满足 | 仍是每次启动 CLI JSON，非 SDK/RPC 常驻会话，也无完整运行时 session 元数据。 | AUD-07 |
| AT-PI-002 | P0 | 不满足 | 每次容器调用结束删除状态目录，不能延续 Developer 会话。 | AUD-07 |
| AT-PI-003 | P0 | 部分实现 | Reviewer 使用 --no-session 可隔离历史，但无 session ID 留痕。 | src/worker/index.ts:492 |
| AT-PI-004 | P0 | 部分实现 | 仅转发 tool_execution_start 的名称，没有工具结束/结果/独立 Agent ID 全链路。 | src/worker/pi-events.ts |
| AT-PI-005 | P0 | 不满足 | Skills/Extensions/模板全部禁用，无批准插件启用路径。 | GAP-02 |
| AT-PI-006 | P0 | 部分实现 | --no-extensions 阻止加载；缺少项目插件检测和审计提示。 | src/worker/index.ts:484 |
| AT-PI-007 | P0 | 不满足 | 无插件版本/hash 注册和篡改校验。 | GAP-02 |
| AT-PI-008 | P0 | 不满足 | Developer bash 可读自身 provider Key，且共享 .git 可越出沙箱执行。 | AUD-01 |
| AT-PI-009 | P0 | 部分实现 | 限制 Reviewer 工具集，但实际挂载仍可写，没有只读快照/前后 hash 证明。 | GAP-03 |
| AT-PI-010 | P0 | 部分实现 | usage 解析有单测；compaction 事件未接入，重复 message_end 没有事件 ID 去重。 | src/worker/pi-events.ts |

## RUN

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-RUN-001 | P0 | 不满足 | 只固化部分字段；缺验收条件、base SHA、预算/插件/提示版本快照。 | GAP-01 |
| AT-RUN-002 | P0 | 不满足 | checks/workspace 校验存在；模型可省略走默认，验收条件没有字段。 | src/server/index.ts:91 |
| AT-RUN-003 | P0 | 部分实现 | 核心顺序存在；无 planning 状态，完整路径受多个阻断项影响。 | AUD-03;AUD-04 |
| AT-RUN-004 | P0 | 代码支持 | 常规路径检查失败退回开发，未运行 Reviewer；假模型探针确认。 | AUD-04 |
| AT-RUN-005 | P0 | 部分实现 | 审核返修存在；重复 Finding ID 可使第二轮落库失败。 | AUD-11 |
| AT-RUN-006 | P0 | 部分实现 | 取消会 abort；无终态保护，迟到回调仍能改状态；容器十秒上限需复验。 | AUD-15 |
| AT-RUN-007 | P0 | 不满足 | 重试审核不验证 checks，通过后直接 completed。 | AUD-04 |
| AT-RUN-008 | P0 | 部分实现 | 可复用 worktree 并记录 HEAD/人工指令；排队重领会丢 follow-up 参数。 | AUD-05 |
| AT-RUN-009 | P0 | 不满足 | 无 Approve API、审批记录与对应按钮。 | GAP-04 |
| AT-RUN-010 | P0 | 不满足 | 创建接口无幂等键，每次生成新的 UUID。 | GAP-01 |
| AT-RUN-011 | P0 | 不满足 | 容量外排队任务重领时强制 recovery，因 worktree 不存在失败。 | AUD-05 |
| AT-RUN-012 | P0 | 部分实现 | Run 目录不同；无显式工作区写锁，多任务配置下缺少按工作区串行策略。 | GAP-05 |
| AT-RUN-013 | P0 | 代码支持 | 前端确认明确保留 worktree；后端仅删除记录。 | src/client/App.tsx:572;src/server/index.ts:665 |
| AT-RUN-014 | P0 | 不满足 | 存储无状态转移验证，cancelled→completed 被接受。 | AUD-15 |

## AGENT

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-AGENT-001 | P0 | 代码支持 | 解析 small/single 与 fallback 有单测。 | src/worker/orchestrator.test.ts |
| AT-AGENT-002 | P0 | 待运行确认 | 有自动规划实现，真实中型任务能否稳定拆分需模型验收。 | src/worker/index.ts:634 |
| AT-AGENT-003 | P0 | 部分实现 | 独立 branch/worktree 和 Promise.all 存在，真实 session 并行证据需补。 | src/worker/index.ts:710 |
| AT-AGENT-004 | P0 | 代码支持 | DAG 波次与依赖检查有实现和单测。 | src/worker/orchestrator.test.ts |
| AT-AGENT-005 | P0 | 代码支持 | 循环依赖抛错并 fallback 单 Agent。 | src/worker/orchestrator.test.ts |
| AT-AGENT-006 | P0 | 代码支持 | 声明路径重叠按 conflictFreeBatches 串行化，有单测。 | src/worker/orchestrator.test.ts |
| AT-AGENT-007 | P0 | 代码支持 | 无修改子任务无 commit 仍可 merged，集成继续。 | src/worker/index.ts:749 |
| AT-AGENT-008 | P0 | 不满足 | 失败子任务的 worktree 被强制移除、分支可能删除，未保存未提交成果。 | GAP-05 |
| AT-AGENT-009 | P0 | 部分实现 | 有 cherry-pick --abort 和保留冲突分支，缺统一 MERGE_CONFLICT 错误。 | src/worker/index.ts:857 |
| AT-AGENT-010 | P0 | 部分实现 | 有 Integrator 和全量 checks，但共享 Git hook 可突破运行边界。 | AUD-01 |
| AT-AGENT-011 | P0 | 部分实现 | 展示计划/状态/分支/耗时，缺每 Agent session 与独立 usage 归属。 | GAP-04 |
| AT-AGENT-012 | P0 | 代码支持 | 任务数被 maxSubagents 截断并附原因，有边界单测。 | src/worker/orchestrator.ts:56 |

## REVIEW

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-REVIEW-001 | P0 | 代码支持 | 真实 Run 无 checks 在创建 schema 被拒绝。 | src/server/index.ts:100 |
| AT-REVIEW-002 | P0 | 部分实现 | 失败即停；仅截断 output，无退出码字段和独立日志 artifact。 | GAP-04 |
| AT-REVIEW-003 | P0 | 代码支持 | 逐项保存状态/命令/耗时/输出，UI 可查看。 | src/worker/index.ts:890 |
| AT-REVIEW-004 | P0 | 不满足 | 正常分支有检查门槛，但 retry-review 可绕过，不能确认系统不变量。 | AUD-04 |
| AT-REVIEW-005 | P0 | 不满足 | approved+high 被 parseReview 接受。 | AUD-03 |
| AT-REVIEW-006 | P0 | 代码支持 | 首次非法 JSON 会记录 review.retry 并修复一次。 | src/worker/index.ts:975 |
| AT-REVIEW-007 | P0 | 部分实现 | 第二次失败转人工；未返回要求的 REVIEW_PROTOCOL_INVALID 标准错误码。 | src/worker/index.ts:1007 |
| AT-REVIEW-008 | P0 | 部分实现 | 字段解析与展示存在，但缺严格信任隔离/全量协议校验。 | src/worker/review-protocol.ts |
| AT-REVIEW-009 | P0 | 不满足 | 旧 Finding 一律标 resolved，新同 ID 直接追加导致数据库主键冲突。 | AUD-11 |
| AT-REVIEW-010 | P0 | 不满足 | 没有 fingerprint/连续严重问题阈值，只有最大轮次。 | GAP-03 |
| AT-REVIEW-011 | P0 | 代码支持 | for round<=maxRounds，退出后转 needs_human。 | src/worker/index.ts:1139 |
| AT-REVIEW-012 | P0 | 不满足 | 没有 Reviewer 独立快照和销毁流程，使用 Developer worktree。 | GAP-03 |

## UI

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-UI-001 | P0 | 部分实现 | 工作区/任务/模型页存在，缺完整独立运行状态入口。 | GAP-04 |
| AT-UI-002 | P0 | 部分实现 | 双选择器存在，默认 provider 门槛阻止部分合法组合。 | AUD-09 |
| AT-UI-003 | P0 | 部分实现 | 有缺默认凭据提示，但 realRunsAvailable 不检查 Worker 健康/所选组合。 | src/server/index.ts:409 |
| AT-UI-004 | P0 | 部分实现 | 主拓扑与计划存在，独立 Agent 运行/依赖实时数据不完整。 | GAP-04 |
| AT-UI-005 | P0 | 部分实现 | 活动/审核/Diff/check 存在，制品和预算详情不完整。 | GAP-04 |
| AT-UI-006 | P0 | 不满足 | 回放结束到 subscribe 存在丢事件窗口，客户端也有覆盖竞态。 | AUD-17 |
| AT-UI-007 | P0 | 不满足 | 并发快照和每事件请求未按 seq 过滤，慢旧响应可覆盖新状态。 | AUD-17 |
| AT-UI-008 | P0 | 部分实现 | provider 错误已有分类，协议和合并冲突缺统一错误码。 | src/worker/provider-errors.ts |
| AT-UI-009 | P1 | 待运行确认 | P1：需要手机尺寸浏览器操作验证，代码检查不能确认。 | src/client/styles.css |

## GIT

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-GIT-001 | P0 | 不满足 | 入队没有保存 base SHA；Worker 启动时使用源仓库当前 HEAD。 | GAP-01 |
| AT-GIT-002 | P0 | 代码支持 | 主 Run 与每个子任务使用不同 worktree/branch。 | src/worker/index.ts:710 |
| AT-GIT-003 | P0 | 部分实现 | prompt 禁止 push/deploy，但缺技术强制边界；远端未做本轮观察。 | AUD-01 |
| AT-GIT-004 | P0 | 不满足 | Git stdout 先截尾 48k，完整 Diff 丢失且无全量 artifact。 | AUD-16 |
| AT-GIT-005 | P0 | 部分实现 | 只读工具集存在，缺独立快照和前后 tree hash 检查。 | GAP-03 |
| AT-GIT-006 | P0 | 部分实现 | 正常取消保留 worktree；源 Git 元数据仍共享可写。 | AUD-01 |
| AT-GIT-007 | P0 | 不满足 | 只有子 Agent 内部清理，没有已批准主 Run worktree 清理入口。 | GAP-04 |
| AT-GIT-008 | P0 | 部分实现 | 删除提示代码保留，但删除后缺归档/保留结果定位 UI。 | src/client/App.tsx:577 |
| AT-GIT-009 | P1 | P1未交付 | 尚无授权后 PR 创建流程。 | GAP-07 |

## SEC

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-SEC-001 | P0 | 不满足 | 备份所谓 sanitized 文件会包含带口令的数据库 URL。 | AUD-14 |
| AT-SEC-002 | P0 | 代码支持 | AES-256-GCM 随机 IV/tag 与 user/provider AAD 有测试。 | src/server/credential-vault.test.ts |
| AT-SEC-003 | P0 | 代码支持 | 跨用户密文重放解密失败有单测。 | src/server/credential-vault.test.ts |
| AT-SEC-004 | P0 | 代码支持 | publicOrigin 配置时跨 Origin 写请求返回 403。 | src/server/index.ts:244 |
| AT-SEC-005 | P0 | 代码支持 | 凭据/创建/取消与人工动作有按用户限流和单测。 | src/server/rate-limit.test.ts |
| AT-SEC-006 | P0 | 部分实现 | 路径 realpath 有测试，但仓库子目录/共享 Git 元数据需加强。 | AUD-01 |
| AT-SEC-007 | P0 | 不满足 | 可写共享 .git hook 使后续 Worker Git 执行越出沙箱。 | AUD-01 |
| AT-SEC-008 | P0 | 代码支持 | 子进程按角色注入 Key，检查剥离 worker secret，有单测。 | src/worker/pi-env.test.ts |
| AT-SEC-009 | P0 | 部分实现 | Reviewer 只读工具，挂载不是只读且无快照。 | GAP-03 |
| AT-SEC-010 | P0 | 不满足 | 自身 provider Key 在 bash 环境可读，Agent 网络无目的地 allowlist。 | AUD-01 |
| AT-SEC-011 | P0 | 部分实现 | 容器限制规格有测试；默认 auto 会回退 process，Compose 挂载有误。 | AUD-12 |
| AT-SEC-012 | P0 | 代码支持 | 内部令牌长度检查+timingSafeEqual。 | src/server/index.ts:216;src/worker/index.ts:278 |
| AT-SEC-013 | P0 | 部分实现 | HTTP body/patch 有上限；容器 stdout/stderr 持续拼接无界。 | GAP-06 |
| AT-SEC-014 | P0 | 不满足 | 只是一律禁用插件，无批准/版本/hash 校验和审计。 | GAP-02 |

## REL

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-REL-001 | P0 | 待运行确认 | 有独立 Worker 和回调，已有历史演练描述；本提交重启 Web 需复验。 | docs/03-deployment-record-192.168.2.235.md |
| AT-REL-002 | P0 | 部分实现 | 完成阶段 checkpoint 有测试；恢复 usage 清零，排队/人工参数存在错误。 | AUD-05;AUD-10 |
| AT-REL-003 | P0 | 部分实现 | 已完成 verdict 可复用；中途调用没有 exactly-once，状态写入未原子化。 | AUD-06;AUD-15 |
| AT-REL-004 | P0 | 不满足 | deliveryId 只约束事件，patch 先执行；真实 Worker 不提供 deliveryId。 | AUD-15 |
| AT-REL-005 | P0 | 不满足 | 失败持久化先污染缓存，terminalRecorded 默认 true 可错误终结 job。 | AUD-06 |
| AT-REL-006 | P0 | 代码支持 | 429/5xx 有有界退避，测试通过；预算统计另有缺陷。 | src/worker/provider-retry.test.ts |
| AT-REL-007 | P0 | 不满足 | 数据库写失败时缓存仍可出现 completed；无真正制品持久化失败闭环。 | AUD-06 |
| AT-REL-008 | P0 | 部分实现 | 数据库分页存在；SSE 无背压，subscribe 接续有竞态。 | AUD-17 |
| AT-REL-009 | P0 | 待运行确认 | 有备份/恢复脚本和历史记录；本轮未还原真实 PostgreSQL。 | deploy/docker/restore-verify.sh |
| AT-REL-010 | P0 | 代码支持 | 有 statfs 水位守卫与新任务 507；磁盘真实故障仍需运维验证。 | src/worker/index.ts:51;src/server/index.ts:586 |

## PERF

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-PERF-001 | P0 | 待运行确认 | 部署记录有既往 API p95，当前提交/目标环境未复测。 | docs/03-deployment-record-192.168.2.235.md |
| AT-PERF-002 | P0 | 待运行确认 | 既往测的是写入到 API 可读，缺实际页面可见时延证据。 | GAP-08 |
| AT-PERF-003 | P0 | 待运行确认 | 首屏 API 响应不等同浏览器首次业务数据渲染。 | GAP-08 |
| AT-PERF-004 | P0 | 待运行确认 | 单容器规格有单测；尚需 3 个真实并行 Agent 总资源与健康压测。 | src/worker/sandbox.test.ts |
| AT-PERF-005 | P0 | 部分实现 | abort/kill 存在，Planner 无限循环会使取消和健康检查失效。 | AUD-13 |
| AT-PERF-006 | P0 | 不满足 | 超容量任务不能正确从首次排队开始执行。 | AUD-05 |
| AT-PERF-007 | P0 | 不满足 | 容器清理了历史 session，不能确认返修上下文延续及 token 优化。 | AUD-07 |
| AT-PERF-008 | P0 | 不满足 | 并行超次数限制，重试审核不受预算，恢复重新从零统计。 | AUD-10 |
| AT-PERF-009 | P0 | 不满足 | 重试审核把累计用量覆盖成单次；缺未知费用标识。 | AUD-10 |

## OPS

| 用例 | 优先级 | 代码审核结论 | 依据与缺口 | 证据 |
| --- | --- | --- | --- | --- |
| AT-OPS-001 | P0 | 不满足 | Compose 将两个卷配置放进 group_add，无法按仓库配置正确启动 Worker。 | AUD-12 |
| AT-OPS-002 | P0 | 待运行确认 | 有数据导入/legacy vault 迁移测试，需完整 v0.3 数据副本演练。 | src/server/run-store-pg.test.ts;src/server/credential-vault.test.ts |
| AT-OPS-003 | P0 | 部分实现 | health/detail 覆盖 DB/Worker/磁盘/队列；缺 Pi/provider 健康全量展示。 | src/server/index.ts:325 |
| AT-OPS-004 | P0 | 部分实现 | 有 AlertManager 和磁盘告警；真实告警链路/provider 失败告警待补验。 | src/server/alerts.test.ts |
| AT-OPS-005 | P0 | 待运行确认 | 本轮未执行 RPO/RTO 恢复演练；旧文档记录不能替代冻结版本证据。 | GAP-08 |
| AT-OPS-006 | P0 | 待运行确认 | 有回滚说明，无本提交镜像/兼容模式回滚证据。 | GAP-08 |
| AT-OPS-007 | P0 | 部分实现 | restart 策略有配置，但首次队列/恢复路径与 Compose 尚有阻断。 | AUD-05;AUD-12 |
| AT-OPS-008 | P0 | 不满足 | Vault 有 0600，sanitized 备份文件泄露数据库口令且权限未收紧。 | AUD-14 |

## 签署规则

本矩阵不得作为“P0 全部通过”的签字附件。先关闭报告中阻断问题，再对冻结提交、镜像与验收环境运行用例，并填入原规格第 16/17 节要求的 Run ID、截图、响应、日志、执行人和时间。
