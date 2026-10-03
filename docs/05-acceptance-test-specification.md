# PiGO 验收测试规格与交付清单

> 文档版本：1.0  
> 编制日期：2026-10-03（Asia/Shanghai）  
> 对应开发规格：`docs/04-product-development-specification.md`  
> 当前实现基线：v0.3.0  
> 目标验收版本：v1.0  
> 文档状态：待目标版本实现后执行

## 1. 验收目的

本文档用于验证 PiGO 是否达到以下业务结果，而不只是验证页面能够打开：

- 用户可通过受限邮箱验证码安全登录；
- 用户可在页面管理服务器工作区；
- 用户可配置多个模型供应商，并分别选择开发和审核模型；
- 系统能够基于开发量自动选择单 Agent 或并行 Sub Agent；
- Pi 会话、Skills、Extensions、事件和 usage 被真实使用；
- 代码在隔离 worktree 中产生，并经过确定性检查和独立模型审核；
- 运行可取消、恢复、重试、审计和限额；
- 凭据、其他用户数据和宿主机目录不会泄露；
- 部署、升级、备份和回滚可重复执行。

当前 v0.3.0 仅作为测试基线，不预期通过本验收文档全部用例。

## 2. 验收范围

### 2.1 P0 必验范围

- Cloudflare Access One-time PIN；
- 用户与资源权限；
- 工作区管理；
- 多模型目录、凭据和角色选择；
- Pi SDK/RPC 会话与受控扩展；
- 单 Agent 与并行 Sub Agent；
- 检查、审核、返修和人工处理；
- Git/worktree 隔离；
- 持久化、恢复、SSE 和制品；
- 安全、性能、预算、部署和回滚。

### 2.2 P1 条件验收

- 用户电脑本地 PiGO Node/daemon；
- GitHub/GitLab PR；
- 移动端完整操作；
- 多工作流模板和团队预算。

P1 未实现不阻断 v1.0，但必须在发布说明中明确。

## 3. 验收角色与职责

| 角色 | 职责 |
| --- | --- |
| 产品负责人 | 确认业务范围、P0/P1、人工操作和最终签字 |
| 研发负责人 | 提供构建、迁移、测试结果、已知限制和修复说明 |
| 测试负责人 | 维护用例、执行独立测试、记录证据和缺陷 |
| 安全复核人 | 检查认证、权限、路径、凭据、插件和执行隔离 |
| 运维负责人 | 验证部署、监控、备份、恢复与回滚 |

同一人可以兼任多个角色，但验收报告中必须记录实际执行人和时间。

## 4. 验收环境

### 4.1 环境要求

验收环境应尽量复制目标服务器拓扑，但不能直接使用生产数据或生产模型密钥。

最低要求：

- Ubuntu 24.04 或目标生产同版本；
- Docker Engine 与 Compose；
- Node.js 22 构建环境；
- Pi 目标锁定版本；
- Web、Worker、数据库、持久队列、运行沙箱；
- 独立 Cloudflare Access 测试应用；
- 两个测试用户：授权用户 A、授权用户 B；
- 一个未授权邮箱；
- 至少两个 provider、三个可用模型；
- 独立的低权限模型测试 Key；
- Chrome/Edge/Safari 当前受支持版本；
- 局域网和公网入口均可验证。

### 4.2 禁止事项

- 不在测试截图、视频或缺陷单中保存 OTP、JWT、API Key 或密码；
- 不使用真实业务仓库做破坏性测试；
- 不对生产主分支执行自动 merge/push；
- 不通过关闭 TLS、跳过 Access 或放宽目录权限来让用例通过；
- 不把模型偶然输出当作确定性功能通过证据。

### 4.3 构建标识

开始验收前记录：

```text
Git commit:
Web image digest:
Worker image digest:
Runner image digest:
Pi version:
Database migration version:
Workflow version:
Prompt version:
Plugin/skill snapshot:
Cloudflare Access application ID:
Test start time:
```

## 5. 测试数据与夹具

### 5.1 仓库夹具

| 夹具 | 用途 |
| --- | --- |
| `fixture-small-auth` | 单文件并发刷新 bug；验证单 Agent、检查失败返修和审核 |
| `fixture-parallel-app` | 独立 API、UI、测试目录；验证 2–3 个 Sub Agent 并行 |
| `fixture-dependent-migration` | schema → API → UI 依赖链；验证多 wave DAG |
| `fixture-merge-conflict` | 两项任务故意修改同一区域；验证重叠检测和冲突处理 |
| `fixture-dirty-repo` | 带未提交修改；验证拒绝启动 |
| `fixture-malicious-paths` | 符号链接、路径逃逸、嵌套仓库；验证隔离 |
| `fixture-large-output` | 产生大 Diff 和大日志；验证 artifact 截断与回调体积 |
| `fixture-untrusted-pi` | 包含项目 extension/skill 和诱导读取凭据的内容；验证信任边界 |

所有夹具必须有固定 base SHA、预期检查结果和清理脚本。

### 5.2 模型夹具

验收同时使用：

1. 确定性 Fake Pi Runtime：控制规划、工具事件、usage、审核结果和错误；
2. 真实 Provider A：主要开发模型；
3. 真实 Provider B：主要审核模型；
4. 无效 Key；
5. 有效但不支持目标模型的 Key；
6. 可返回 429/5xx/超时/无效 JSON 的代理或 mock。

确定性测试用于判定平台正确性；真实模型 smoke test 用于确认集成可用性。

## 6. 进入与退出条件

### 6.1 进入条件

- 目标提交和镜像已冻结；
- 数据库 migration 已在空库和基线数据副本上成功执行；
- 所有 P0 功能已标记开发完成；
- 单元测试、类型检查、lint 和构建通过；
- 测试环境健康检查通过；
- Cloudflare 测试策略已限制到测试邮箱；
- 测试仓库、测试用户和模型凭据可用；
- 已完成备份并确认回滚入口。

### 6.2 通过标准

必须同时满足：

- P0 用例 100% 通过；
- P1 已实现部分通过率不低于 95%；
- 无未关闭 S0/S1 缺陷；
- S2 缺陷有书面规避方式、负责人和修复日期，并得到产品负责人批准；
- 所有自动化测试连续两次通过；
- 三次真实 provider 工作流没有平台自身导致的失败；
- 至少一次真实中型任务触发两个以上 Sub Agent 并行并成功集成；
- 安全扫描和凭据泄露扫描无高危结果；
- 备份恢复和回滚演练完成；
- 验收报告证据完整并签字。

### 6.3 缺陷等级

| 等级 | 定义 | 发布规则 |
| --- | --- | --- |
| S0 | 凭据泄露、越权、源仓库损坏、不可恢复数据丢失 | 必须阻断发布 |
| S1 | 核心流程不可用、模型路由错误、检查未通过却完成、无法恢复 | 必须阻断发布 |
| S2 | 重要功能受损但有明确规避方式 | 需书面批准 |
| S3 | 文案、样式、非关键兼容问题 | 可带已知问题发布 |

## 7. 需求追踪矩阵

| 需求组 | 开发规格 ID | 验收用例 |
| --- | --- | --- |
| 认证 | AUTH-001～006 | AT-AUTH-001～008 |
| 工作区 | WS-001～010 | AT-WS-001～012 |
| 模型与凭据 | MODEL-001～011 | AT-MODEL-001～014 |
| Pi 运行时与扩展 | PI-001～009 | AT-PI-001～010 |
| Run 与状态机 | RUN-001～010 | AT-RUN-001～014 |
| 自动 Sub Agent | AGENT-001～009 | AT-AGENT-001～012 |
| 检查与审核 | CHECK-001～003、REVIEW-001～007 | AT-REVIEW-001～012 |
| UI | UI-001～009 | AT-UI-001～009 |
| Git | GIT-001～007 | AT-GIT-001～009 |
| 安全 | SEC-001～010 | AT-SEC-001～014 |
| 可靠性 | REL-001～007 | AT-REL-001～010 |
| 成本与性能 | COST-001～006 | AT-PERF-001～009 |

## 8. 功能验收用例

### 8.1 认证与账户

| ID | 级别 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| AT-AUTH-001 | P0 | 无 Cookie 访问公网根路径和 `/api/runs` | 均被 Cloudflare Access 拦截；不会返回应用数据 |
| AT-AUTH-002 | P0 | 在 Access 页面观察登录方式 | 显示邮件 One-time PIN；不只显示 Cloudflare Dashboard Account 登录 |
| AT-AUTH-003 | P0 | 使用允许邮箱请求并输入正确验证码 | 登录成功并返回原页面；`/api/me` 返回规范化邮箱和内部用户 ID |
| AT-AUTH-004 | P0 | 使用未授权邮箱完成验证码流程 | Access 拒绝访问；应用不创建用户和会话 |
| AT-AUTH-005 | P0 | 使用过期、错误 audience、错误 issuer 和篡改 JWT 请求 API | 全部返回 401；日志不打印完整 JWT |
| AT-AUTH-006 | P0 | 用户 A 创建任务，用户 B 查询其 Run ID | 返回 404 或 403；不得泄露标题、路径、事件和制品 |
| AT-AUTH-007 | P0 | 点击退出后重新调用 API | 会话失效并重新进入 Access 登录 |
| AT-AUTH-008 | P0 | 将同一邮箱从旧身份映射迁移到 OTP 身份 | 原有 Run 和 provider 凭据仍归属于同一内部用户 |

### 8.2 工作区

| ID | 级别 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| AT-WS-001 | P0 | 不配置任何模型 Key，进入工作区页面 | 可以看到授权工作区；页面明确提示仅真实执行缺少凭据 |
| AT-WS-002 | P0 | 从允许的 Git URL clone 测试仓库 | 创建工作区；显示 URL、分支、HEAD、clean 状态 |
| AT-WS-003 | P0 | 注册允许根目录下已有 Git 仓库 | 注册成功且不复制、不 checkout、不修改源仓库 |
| AT-WS-004 | P0 | 注册非 Git 目录、重名目录和不存在目录 | 明确拒绝并给出不同错误原因 |
| AT-WS-005 | P0 | 提交 `../`、绝对越界路径和指向允许根外的 symlink | API 拒绝；不得读取允许根外文件 |
| AT-WS-006 | P0 | 打开 dirty 仓库并尝试真实任务 | 显示 dirty 文件摘要；默认拒绝创建真实 Run |
| AT-WS-007 | P0 | 配置默认检查和预算，刷新页面 | 配置持久化；新任务默认继承但允许按权限覆盖 |
| AT-WS-008 | P0 | 执行“刷新 Git 状态” | 更新分支/HEAD/dirty；不得隐式 pull、reset 或 checkout |
| AT-WS-009 | P0 | 解除注册有历史 Run 的工作区 | 只解除注册；历史 Run、artifact 和源目录保留 |
| AT-WS-010 | P0 | 普通用户尝试删除源代码 | 操作不可见或被拒绝；不得删除目录 |
| AT-WS-011 | P0 | 用户 B 浏览用户 A 私有工作区 | 列表和直接 ID 查询均不可见 |
| AT-WS-012 | P1 | 连接本地 PiGO Node 并注册本机路径 | 服务器只保存受控引用；任务在对应 Node 执行 |

### 8.3 模型目录与凭据

| ID | 级别 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| AT-MODEL-001 | P0 | 打开模型页面 | 展示至少两个 provider、三个模型及能力/状态/适用角色 |
| AT-MODEL-002 | P0 | 在 Pi Runtime 中存在但不在 allowlist 的模型 | UI 不可选；伪造 API 请求返回 `MODEL_NOT_ALLOWED` |
| AT-MODEL-003 | P0 | 保存 Provider A Key 后读取凭据状态 | 只返回已配置、掩码和验证时间；不返回明文 |
| AT-MODEL-004 | P0 | 保存无效 Key | 验证失败；Key 不可用于创建真实 Run；错误不包含明文 Key |
| AT-MODEL-005 | P0 | 分别配置 Provider A/B，选择 A 开发、B 审核 | 预检成功；Run 快照和 UI 准确记录两个模型 |
| AT-MODEL-006 | P0 | 交换允许的角色组合 | 实际 Pi 调用与选择一致，不使用部署默认值 |
| AT-MODEL-007 | P0 | 策略允许时为开发和审核选择同一模型 | 预检和执行成功；仍创建独立角色会话 |
| AT-MODEL-008 | P0 | 选择有效 Key 无权访问的模型 | 入队前返回 `MODEL_UNAVAILABLE`；不创建计费开发调用 |
| AT-MODEL-009 | P0 | 绕过 UI 提交不存在 model ID | 返回 `MODEL_NOT_FOUND`；不得选第一个可用模型 |
| AT-MODEL-010 | P0 | 创建 Run 后修改全局默认模型 | 已创建 Run 继续使用固化模型；新 Run 使用新默认值 |
| AT-MODEL-011 | P0 | 运行期间轮换 provider Key | 活动 Run 使用固化凭据版本或按明确策略安全失败，不突然换身份 |
| AT-MODEL-012 | P0 | 触发 401、429、5xx、超时、模型不支持 | 分别显示 credential、rate limit、provider、timeout、unsupported 分类 |
| AT-MODEL-013 | P0 | 删除 Provider A Key | Provider A 模型变为不可用；Provider B 和历史 Run 不受影响 |
| AT-MODEL-014 | P0 | 检查数据库、日志、浏览器响应和静态资源 | 不出现 provider Key 明文 |

### 8.4 Pi 运行时、Skills 与 Extensions

| ID | 级别 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| AT-PI-001 | P0 | 启动真实 Run 并检查运行元数据 | 记录 Pi SDK/RPC 版本和 session ID；不是每阶段无会话的一次性调用 |
| AT-PI-002 | P0 | 第一轮审核退回，再执行第二轮开发 | Developer Session 延续；能引用前一轮上下文而无需重建完整历史 |
| AT-PI-003 | P0 | 连续执行两轮审核 | 每轮 Reviewer Session ID 不同；Reviewer 不继承上一轮结论 |
| AT-PI-004 | P0 | 执行包含 read/edit/bash 的任务 | UI 以正确 Agent 身份实时显示工具开始/结束和结果状态 |
| AT-PI-005 | P0 | 启用 allowlist 中的测试 Skill/Extension | 功能生效；Run 记录版本、hash 和启用角色 |
| AT-PI-006 | P0 | 在仓库放置未批准 `.pi/extensions` | 默认不加载；产生安全提示或审计事件 |
| AT-PI-007 | P0 | 修改已批准插件内容但不更新 hash | 启动或预检失败；不得执行被篡改代码 |
| AT-PI-008 | P0 | `AGENTS.md` 要求读取凭据或扩大工具权限 | 平台策略优先；Agent 无法读取凭据或平台外目录 |
| AT-PI-009 | P0 | Reviewer 尝试调用写工具 | 工具不存在或被拒绝；Developer worktree hash 不变 |
| AT-PI-010 | P0 | 触发 compaction 和 usage 事件 | 事件可观测，usage 只累计一次且数值不倒退 |

### 8.5 Run 与状态机

| ID | 级别 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| AT-RUN-001 | P0 | 创建包含完整字段的真实 Run | 固化 workspace、base SHA、两个模型、检查、预算、workflow/prompt/plugin 版本 |
| AT-RUN-002 | P0 | 缺少检查、验收条件或模型提交真实 Run | 返回 schema 错误；不入队 |
| AT-RUN-003 | P0 | 正常执行单 Agent 任务 | 状态按 queued→preparing→planning→developing→checking→reviewing→completed |
| AT-RUN-004 | P0 | 检查失败后修复成功 | 必须回到 developing；重新检查通过后才能 reviewing |
| AT-RUN-005 | P0 | Reviewer 返回 changes_requested 后修复 | 出现审核回边；第二轮重新检查和复审 |
| AT-RUN-006 | P0 | 运行中点击取消 | 10 秒内终止所有子进程；状态为 cancelled；保留审计和已有 worktree |
| AT-RUN-007 | P0 | `needs_human` 点击“重试审核” | 只重试允许阶段；不重复开发和已通过检查 |
| AT-RUN-008 | P0 | 人工修改 worktree 后点击 Resume | 记录人工操作和新 HEAD；从配置阶段恢复 |
| AT-RUN-009 | P0 | completed 后点击 Approve | 只记录批准；除非另行选择，不自动 merge/push/deploy |
| AT-RUN-010 | P0 | 两个请求使用相同幂等键创建 Run | 只创建一个 Run，不重复排队 |
| AT-RUN-011 | P0 | 超过 Worker 并发创建多个 Run | 多余 Run 保持 queued 并显示队列位置，不返回永久失败 |
| AT-RUN-012 | P0 | 同一工作区并发两个写任务 | 按策略排队或拒绝第二个，不让两个主 Run 修改同一工作树 |
| AT-RUN-013 | P0 | 删除终态 Run | 删除记录前提示 worktree 处理；源仓库不受影响 |
| AT-RUN-014 | P0 | 尝试非法状态跳转 | API/Worker 拒绝并记录内部错误，不污染 Run 快照 |

### 8.6 自动规划与并行 Sub Agent

| ID | 级别 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| AT-AGENT-001 | P0 | 对 `fixture-small-auth` 创建任务 | Planner 判定 small 或确定性策略选择单 Agent |
| AT-AGENT-002 | P0 | 对 `fixture-parallel-app` 提交 API+UI+测试任务 | 计划产生至少 2 个可并行任务，UI 显示理由和文件范围 |
| AT-AGENT-003 | P0 | 观察同一 wave 的两个 Sub Agent | 不同 session、branch、worktree；执行时间有重叠 |
| AT-AGENT-004 | P0 | 执行依赖链夹具 | 依赖任务未完成前 integration 任务不启动 |
| AT-AGENT-005 | P0 | Planner 返回循环依赖 | 计划被拒绝并安全回退单 Agent；记录 fallback 原因 |
| AT-AGENT-006 | P0 | Planner 为同一 wave 声明重叠文件 | 自动串行化、重新规划或回退；不得盲目并行 |
| AT-AGENT-007 | P0 | 一个 Sub Agent 无变更、另一个有变更 | 两者状态和摘要准确，集成继续完成 |
| AT-AGENT-008 | P0 | 一个 Sub Agent 失败 | 其他成果保留；集成 Agent 接管或 Run 进入人工处理 |
| AT-AGENT-009 | P0 | cherry-pick 产生冲突 | 中止 cherry-pick，主 worktree 不留冲突状态；显示 `MERGE_CONFLICT` |
| AT-AGENT-010 | P0 | 全部 Sub Agent 完成 | 集成 Agent 检查组合结果，并执行完整而非局部检查 |
| AT-AGENT-011 | P0 | 查看 Agents 面板 | 每个 Agent 显示模型、状态、依赖、分支、耗时、usage 和结果 |
| AT-AGENT-012 | P0 | 设置 `maxSubagents=2` 后提交 large 任务 | 实际活动 Sub Agent 不超过 2，且计划说明被截断/合并策略 |

### 8.7 检查、审核和返修

| ID | 级别 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| AT-REVIEW-001 | P0 | 创建没有检查命令的真实任务 | 被拒绝；演示模式需明确标识为演示 |
| AT-REVIEW-002 | P0 | 第一条检查失败 | 后续审核不启动；保存退出码和日志 artifact |
| AT-REVIEW-003 | P0 | 多条检查全部通过 | 每条状态、耗时、命令和输出可查看 |
| AT-REVIEW-004 | P0 | Reviewer 返回 approved 且 findings 为空 | Run 可 completed，前提是最新检查全部通过 |
| AT-REVIEW-005 | P0 | Reviewer 返回 approved 但含 high finding | 协议校验拒绝，不得 completed |
| AT-REVIEW-006 | P0 | Reviewer 返回非 JSON | 同一轮允许一次格式修复；事件记录 retry |
| AT-REVIEW-007 | P0 | 第二次仍为非 JSON | Run 进入 needs_human，错误为 `REVIEW_PROTOCOL_INVALID` |
| AT-REVIEW-008 | P0 | Reviewer 返回带文件/行号/evidence 的 finding | UI 完整显示，返修 prompt 只包含可信结构化字段 |
| AT-REVIEW-009 | P0 | 下一轮解决上一 finding | 原 finding 标记 resolved；新 finding 独立记录 |
| AT-REVIEW-010 | P0 | 同 fingerprint 严重问题连续出现 | 达到策略阈值后停止循环并进入 needs_human |
| AT-REVIEW-011 | P0 | 达到最大轮次 | 不启动下一次模型调用；进入 needs_human |
| AT-REVIEW-012 | P0 | Reviewer 快照内生成临时文件 | 文件在快照销毁；Developer worktree 不包含这些文件 |

### 8.8 UI 与 SSE

| ID | 级别 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| AT-UI-001 | P0 | 访问一级导航 | 工作区、任务、模型与凭据、运行状态均可达 |
| AT-UI-002 | P0 | 打开新建任务 | 开发/审核模型分开选择，选项按 provider 分组并显示可用性 |
| AT-UI-003 | P0 | 缺少凭据或 Worker 离线 | 页面列出具体阻断条件，不仅显示灰色按钮 |
| AT-UI-004 | P0 | 运行多 Agent 任务 | 拓扑显示实际模型、Agent 数、状态、回边和依赖进度 |
| AT-UI-005 | P0 | 切换详情标签 | 活动、Agents、审核、Diff、检查、制品和预算数据一致 |
| AT-UI-006 | P0 | SSE 中途断网后恢复 | 从最后 seq 补拉；无事件丢失和重复 |
| AT-UI-007 | P0 | 刷新运行详情页 | 先恢复快照再继续实时事件，终态不倒退 |
| AT-UI-008 | P0 | 触发 provider/检查/协议/冲突错误 | 错误类型、原因和下一步不同且可操作 |
| AT-UI-009 | P1 | 手机宽度查看运行并操作取消/恢复 | 关键内容可读，关键操作可完成，无横向遮挡 |

### 8.9 Git 与工作树

| ID | 级别 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| AT-GIT-001 | P0 | 创建 Run 后移动源分支 | Run 仍基于固化 base SHA，不随分支漂移 |
| AT-GIT-002 | P0 | 检查主 Run 和 Sub Agent 目录 | 每个可写 Agent 使用不同 worktree 和 branch |
| AT-GIT-003 | P0 | Agent 尝试 push/merge/deploy | 默认工具策略拒绝或 prompt 明确禁止；远端无变化 |
| AT-GIT-004 | P0 | 完成 Run 后生成 Diff | Diff 精确覆盖 base SHA 到最终 worktree，包含未跟踪新文件 |
| AT-GIT-005 | P0 | Reviewer 运行前后比较 Developer worktree | tree hash 不因 Reviewer 改变 |
| AT-GIT-006 | P0 | 取消 Run | 源仓库不变；工作树按保留策略可检查 |
| AT-GIT-007 | P0 | 清理已批准 Run worktree | Git worktree 注册项同步移除；源仓库和其他 Run 不受影响 |
| AT-GIT-008 | P0 | 删除 Run 记录但选择保留代码 | worktree/归档仍可定位，UI 显示保留结果 |
| AT-GIT-009 | P1 | 明确批准创建 PR | 仅在批准后 push 指定分支并创建一次 PR |

## 9. 安全验收

| ID | 级别 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| AT-SEC-001 | P0 | 搜索镜像、源码、数据库导出、日志和前端 bundle | 不包含测试 Key、OTP、JWT 或密码明文 |
| AT-SEC-002 | P0 | 检查 provider credential 密文 | 使用随机 IV、认证 tag 和用户/provider 绑定 AAD |
| AT-SEC-003 | P0 | 将用户 A 密文复制给用户 B | 解密失败；不会返回错误中的密文或 Key |
| AT-SEC-004 | P0 | 构造跨 Origin 写请求 | 返回 403；无状态改变 |
| AT-SEC-005 | P0 | 高频写凭据、创建任务和取消 | 触发合理限流；正常用户不受长期影响 |
| AT-SEC-006 | P0 | 利用路径穿越、symlink、嵌套 worktree | 不能访问允许根之外 |
| AT-SEC-007 | P0 | 恶意检查命令尝试读取其他工作区 | 沙箱或挂载边界阻止访问 |
| AT-SEC-008 | P0 | Developer shell 查看环境 | 只含当前角色需要的 provider 凭据；不含另一角色 Key |
| AT-SEC-009 | P0 | Reviewer shell/工具尝试写 Developer 文件 | 工具边界或快照隔离阻止影响 |
| AT-SEC-010 | P0 | 恶意项目指令要求上传凭据到外网 | 凭据不可读；默认网络策略阻止非允许目的地 |
| AT-SEC-011 | P0 | 检查运行容器用户、capabilities、rootfs 和资源限制 | 与安全配置一致，不能获得宿主机特权 |
| AT-SEC-012 | P0 | 篡改 internal callback token | 返回 401；使用常量时间比较；不泄露有效 token 特征 |
| AT-SEC-013 | P0 | 提交超大 body、Diff、日志和事件 | 受限、截断或转 artifact；服务保持健康 |
| AT-SEC-014 | P0 | 安装未批准插件或修改插件版本 | 被管理员策略拒绝并记录审计事件 |

## 10. 可靠性与恢复验收

| ID | 级别 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| AT-REL-001 | P0 | Run 执行中重启 Web | Worker 继续；页面恢复后能读取最新状态和事件 |
| AT-REL-002 | P0 | Developer 完成后、检查前重启 Worker | 从 checkpoint 恢复；不重复已完成开发模型调用 |
| AT-REL-003 | P0 | Reviewer 调用中重启 Worker | 按幂等策略恢复或转人工；不生成两个相互冲突 verdict |
| AT-REL-004 | P0 | 对同一内部更新重复投递 | 状态、usage 和 event 不重复累计 |
| AT-REL-005 | P0 | 暂停数据库或队列后恢复 | 服务明确降级；恢复后继续处理，不静默丢任务 |
| AT-REL-006 | P0 | Provider 连续返回 429/5xx | 按上限退避；达到阈值后 needs_human，不无限循环 |
| AT-REL-007 | P0 | artifact 写入失败 | Run 不伪装 completed；显示存储错误并可重试 |
| AT-REL-008 | P0 | SSE 客户端落后大量事件 | 可分页补拉至最新 seq，不导致 Web 内存无限增长 |
| AT-REL-009 | P0 | 执行每日备份并还原到空环境 | 用户、Run、Event、凭据密文和必要配置数量/hash 一致 |
| AT-REL-010 | P0 | 模拟磁盘空间不足 | 停止新任务并告警；已有源仓库不损坏 |

## 11. 性能、容量与成本验收

| ID | 级别 | 测试 | 通过标准 |
| --- | --- | --- | --- |
| AT-PERF-001 | P0 | 10 并发客户端读取 workspaces/runs/models | 非模型 API p95 < 500 ms，错误率 < 1% |
| AT-PERF-002 | P0 | Worker 连续产生 100 个事件 | 页面可见延迟 p95 < 2 s，seq 连续 |
| AT-PERF-003 | P0 | 局域网加载已有数据的首页 | 首次业务数据 < 3 s，不含 Access 登录 |
| AT-PERF-004 | P0 | 运行 3 个并行 Sub Agent | 不超过 CPU/内存/PID 限制；系统健康检查持续通过 |
| AT-PERF-005 | P0 | 活动任务取消 | 10 s 内所有 Pi/check 子进程结束 |
| AT-PERF-006 | P0 | 创建 20 个超出容量的任务 | 全部持久排队；无任务丢失，队列顺序可解释 |
| AT-PERF-007 | P0 | 比较两轮返修的上下文 | 第二轮只发送新增反馈和必要上下文，不重复完整仓库/历史 |
| AT-PERF-008 | P0 | 达到 80% 和 100% token/cost 预算 | 80% 告警；100% 停止新调用并 needs_human |
| AT-PERF-009 | P0 | 对账 provider usage 与 Run/Agent usage | 在 provider 可提供精确 usage 时误差为 0；估算字段明确标记 |

## 12. 部署与运维验收

| ID | 级别 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| AT-OPS-001 | P0 | 全新环境按文档部署 | 无手工修改容器即可启动；所有 health check 通过 |
| AT-OPS-002 | P0 | 从 v0.3.0 数据副本升级 | Run 可读、owner 映射正确、凭据可验证、worktree 不丢失 |
| AT-OPS-003 | P0 | 查看系统页和监控 | Web、Worker、DB、Queue、Pi、Provider、磁盘和队列状态可见 |
| AT-OPS-004 | P0 | 触发 Worker 离线、Provider 失败和磁盘阈值 | 产生告警，且告警不包含敏感信息 |
| AT-OPS-005 | P0 | 执行备份恢复演练 | 达到既定 RPO/RTO；恢复记录完整 |
| AT-OPS-006 | P0 | 按回滚步骤恢复旧镜像 | 不删除卷，不破坏 v1 数据；旧版被限制为安全只读或兼容模式 |
| AT-OPS-007 | P0 | 重启宿主机 | 服务自动拉起；排队和活动 Run 按恢复策略处理 |
| AT-OPS-008 | P0 | 检查部署文件权限 | `.env`、secret、数据库备份和凭据文件符合最小权限 |

## 13. 核心端到端验收场景

### E2E-01：单 Agent 完整闭环

前置：`fixture-small-auth`、Provider A 开发、Provider B 审核。

步骤：

1. OTP 登录；
2. 选择已有工作区；
3. 选择两个不同模型；
4. 提交修复任务与三条验收条件；
5. Planner 判定 small；
6. Developer 修改代码；
7. 检查全部通过；
8. Reviewer approved；
9. 用户检查 Diff 并 Approve。

通过标准：

- 只有一个 Developer；
- 实际模型与选择一致；
- 状态顺序正确；
- tests 和 review 均通过；
- completed 后未自动 push/merge；
- Run 可展示完整 usage、日志、Diff 和制品。

### E2E-02：检查失败自动返修

设置第一版实现必然使一条检查失败。

通过标准：

- Reviewer 在失败检查之后不启动；
- Developer 复用会话修复；
- 第二轮重新执行所有必需检查；
- 检查通过后才进入审核。

### E2E-03：审核退回自动返修

Fake Reviewer 第一轮返回一个 high finding，第二轮批准。

通过标准：

- 第一轮 finding 有文件、行号、证据和 requiredChange；
- 返修后原 finding 标记 resolved；
- UI 显示一次 reviewing→developing 回边；
- 第二轮 checks 通过后才 approved。

### E2E-04：并行 Sub Agent

对 `fixture-parallel-app` 提交跨 API、UI、测试的任务。

通过标准：

- Planner 创建至少两个同 wave 任务；
- 两个 Pi Session 并行运行且 worktree 不同；
- 每个任务只修改声明范围或产生可解释偏差；
- 合并无冲突；
- Integrator 执行全局检查；
- 独立 Reviewer 批准；
- Agents 面板完整显示并行证据。

### E2E-05：Provider 故障不浪费开发成本

选择一个凭据有效但无权使用的审核模型。

通过标准：

- Preflight 在 Run 入队前发现问题；
- 不启动 Developer；
- 页面建议重新选择模型或更新凭据；
- 不静默切换到默认 Reviewer。

### E2E-06：Worker 崩溃恢复

在开发完成并写入 checkpoint 后强制重启 Worker。

通过标准：

- Run 不永久卡住；
- 已完成 Developer 调用不重复；
- 事件序号连续；
- 从正确阶段继续并最终完成或明确转人工。

### E2E-07：预算停止

将预算设为足够完成 Planning 但不足以启动第二轮。

通过标准：

- 80% 时显示预警；
- 达到上限后不再调用模型；
- Run 进入 needs_human；
- 现有代码和制品保留。

### E2E-08：恶意仓库隔离

使用包含路径 symlink、项目 extension 和提示注入的夹具。

通过标准：

- 不能读取其他工作区或凭据；
- 未批准 extension 不执行；
- Reviewer 不修改 Developer 成果；
- 安全事件可审计；
- 宿主机其他容器与目录不受影响。

## 14. 自动化要求

| 测试层 | 必须自动化的范围 |
| --- | --- |
| 单元 | schema、状态机、权限、路径、模型目录、凭据、DAG、review、usage、预算 |
| API 集成 | workspaces、models、credentials、runs、SSE、错误码、幂等和 owner 隔离 |
| Worker 集成 | fake Pi、并行 wave、检查、审核、取消、恢复、artifact |
| 浏览器 E2E | OTP 后应用流程可使用预认证测试会话；覆盖工作区、选模、Run、错误和刷新 |
| 安全 | secret scan、依赖扫描、路径逃逸、越权、Origin、限流和容器配置 |
| 性能 | API、SSE、队列、取消和并行资源 |

真实 Cloudflare OTP 至少保留一条人工或受控自动化 smoke test，避免通过伪造 JWT 替代全部边缘验证。

## 15. 证据要求

每个失败或关键 P0 用例至少保存：

- 用例 ID、执行人、时间和构建标识；
- 输入条件和使用的非敏感模型标识；
- UI 截图或视频；
- API 状态码与脱敏响应；
- Run ID、事件 seq 区间；
- 相关日志查询；
- Git base/final SHA 和 Diff artifact；
- 检查结果；
- usage 和预算快照；
- 缺陷 ID 或通过结论。

证据中发现敏感值时，立即停止分发并按 S0 处理。

## 16. 验收执行记录模板

| 用例 ID | 级别 | 结果 | 缺陷 ID | 证据位置 | 执行人 | 时间 |
| --- | --- | --- | --- | --- | --- | --- |
| AT-AUTH-001 | P0 | 待执行 |  |  |  |  |
| AT-WS-001 | P0 | 待执行 |  |  |  |  |
| AT-MODEL-005 | P0 | 待执行 |  |  |  |  |
| AT-AGENT-003 | P0 | 待执行 |  |  |  |  |
| E2E-04 | P0 | 待执行 |  |  |  |  |

实际执行时应从测试管理系统或本文全部用例生成完整记录，不能只填写示例五行。

## 17. 最终验收报告模板

```text
项目：PiGO
目标版本：
Git commit：
镜像 digest：
验收环境：
验收开始/结束时间：

P0 总数：
P0 通过：
P0 失败：
P1 已实现总数：
P1 通过：

真实 Provider Run：
单 Agent Run ID：
并行 Sub Agent Run ID：
恢复演练 Run ID：

S0 缺陷：
S1 缺陷：
S2 缺陷：
S3 缺陷：

安全复核结论：
性能复核结论：
备份恢复结论：
回滚演练结论：
已知限制：

最终结论：通过 / 有条件通过 / 不通过

产品负责人：                日期：
研发负责人：                日期：
测试负责人：                日期：
安全/运维负责人：           日期：
```

## 18. 发布门禁清单

- [ ] 目标提交和镜像 digest 已冻结；
- [ ] P0 用例 100% 通过；
- [ ] 真实单 Agent 闭环通过；
- [ ] 真实并行 Sub Agent 闭环通过；
- [ ] 两个角色的模型选择与实际调用一致；
- [ ] 模型 preflight 捕获不兼容账号/模型；
- [ ] OTP 登录和未授权邮箱拒绝均通过；
- [ ] 工作区路径与多用户隔离通过；
- [ ] Worker 重启恢复通过；
- [ ] token/cost/time 预算通过；
- [ ] secret scan 无明文凭据；
- [ ] 插件 allowlist 与篡改检测通过；
- [ ] 数据迁移校验通过；
- [ ] 备份恢复和回滚演练通过；
- [ ] 监控和告警已启用；
- [ ] 发布说明列出 P1 和已知限制；
- [ ] 所有负责人完成签字。

