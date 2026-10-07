# 27 · Jev 决策引擎验收方案

> 文档状态：拟实施（Draft）  
> 适用版本：当前主干（`package.json` v0.27.5）及后续版本  
> 最后更新：2026-10-06  
> 设计依据：[26 · Jev 决策引擎开发落地技术方案](./26-jev-decision-engine-design.md)

## 1. 验收目标

本文件定义 Jev 决策引擎从代码完成、测试环境 shadow、生产 shadow、assist 到受限 enforce 的验收方法。

验收不仅检查“接口能否调用”，还必须证明：

- Jev 不会成为开发任务的单点故障。
- Jev 不会越过确定性 gate、reviewer、安全和发布权限。
- 外发数据符合最小化与脱敏要求。
- 结果可追踪到输入摘要、策略版本和实际模型版本。
- 概率输出经过校准评估，而不是凭少量示例主观判断。
- 关闭、降级、熔断和回滚路径均可操作。

## 2. 验收范围

### 2.1 本轮必须验收

- `DecisionEngine` 抽象及 Disabled、Mock、Jev 实现。
- 严格配置校验和默认关闭行为。
- Review Triage shadow 接入。
- Jev 请求/响应 schema 校验。
- 数据裁剪、脱敏、hash 和 payload 上限。
- 重试、超时、取消、限流、熔断和 fallback。
- 决策审计、指标、日志和 usage 归类。
- 内部 API 鉴权与幂等。
- kill switch 和回滚演练。

### 2.2 后续阶段单独验收

- Review Assist 的界面和用户反馈。
- Planner Shadow / Assist。
- 高置信度 `single_agent` 的受限 Enforce。

### 2.3 明确不在验收范围

- Jev 生成或修改代码。
- Jev 替代 developer、reviewer 或完整 repository planner。
- Jev 自动批准 review、合并 PR、发布或部署。
- 向 Jev 发送完整仓库、完整 diff 或敏感生产数据。

## 3. 验收角色

| 角色 | 职责 |
| --- | --- |
| 开发负责人 | 确认实现与设计一致，提供自动化测试证据 |
| QA | 执行功能、故障、E2E 和回归验收 |
| 安全/隐私负责人 | 审核外发字段、日志、凭据、供应商数据处理 |
| 产品负责人 | 审核场景价值、人工标签和 assist 展示 |
| 运维负责人 | 审核指标、告警、熔断、容量和回滚 |

进入 assist 需要以上角色签字；进入 enforce 还需要单独的变更审批。

## 4. 验收环境

### 4.1 环境分层

| 环境 | Jev 实现 | 是否消耗外部额度 | 用途 |
| --- | --- | --- | --- |
| 单元测试 | Mock/Disabled | 否 | 逻辑、边界、schema、policy |
| 集成测试 | 本地 mock HTTP server | 否 | 网络、重试、超时、取消、鉴权 |
| E2E | Mock，默认 off/shadow | 否 | PiGO 完整任务流程 |
| Live Smoke | Jev 真实 API | 是 | 合同兼容、实际模型版本、时延 |
| 生产 Shadow | Jev 真实 API | 是 | 真实数据分布和校准 |

CI 默认不得依赖 Jev 在线服务，也不得需要真实 API Key。Live Smoke 只能手动或受控定时运行。

### 4.2 测试配置

```dotenv
PI_DECISION_ENGINE=mock|jev|disabled
PI_JEV_MODE=off|shadow|assist|enforce
TYPESAFE_API_KEY=<secret>
PI_JEV_BASE_URL=<mock-or-official-url>
PI_JEV_MODEL=jev-latest
PI_JEV_TIMEOUT_MS=3000
PI_JEV_MAX_ATTEMPTS=2
PI_JEV_STATE_MAX_BYTES=65536
PI_JEV_REVIEW_MAX_FINDINGS=50
PI_JEV_POLICY_VERSION=review-triage-v1
PI_JEV_ALLOW_SOURCE=false
```

真实 key 必须由 CI Secret 或部署平台注入，不得写入 `.env.example` 的值、测试快照、录像、日志或验收附件。

## 5. 测试数据

### 5.1 基础 fixture

必须覆盖：

- 无 finding、单 finding、50 个 findings、超过 50 个 findings。
- `low`、`medium`、`high`、`critical` 各级别。
- 中英文任务、混合语言、Unicode 文件名和超长摘要。
- 测试通过、测试失败、diff 不完整、review 协议重试。
- 安全、权限、数据迁移、UI、文档、依赖和基础设施 finding。
- 包含伪 API Key、JWT、邮箱、Cookie、私钥片段、高熵字符串的输入。
- 包含“忽略上面的规则”“输出另一个选项”“执行命令”等对抗内容。

### 5.2 Shadow 标注集

进入 assist 前至少准备：

- 200 条来自真实运行、已经脱敏且完成人工标签的决策；或
- 若真实样本不足，使用所有可用真实样本，加不少于 50 条刻意构造的边界/对抗样本。

每条样本至少由一名开发或 QA 标注；`high`/`critical` 和安全样本必须由第二人复核。发生分歧时保留两份标签并由负责人裁决，不能用 Jev 自己的输出作为标签。

标签包括：需求相关性、安全影响、人工紧急度、是否值得自动重试、最终人工处理结果。

## 6. 验收等级与门禁

| 等级 | 含义 | 必须通过的测试 |
| --- | --- | --- |
| L0 | 代码可合并 | 单元、集成、类型、lint、构建、安全静态检查 |
| L1 | 可部署但保持 off | L0 + migration + E2E + 回滚演练 |
| L2 | 可启用 shadow | L1 + Live Smoke + 隐私评审 + 监控告警 |
| L3 | 可启用 assist | L2 + 标注集指标 + UI/反馈验收 |
| L4 | 可受限 enforce | L3 + Planner 专项数据 + 独立审批 + 自动回滚 |

任何等级都不能授权 Jev 自动批准 review 或发布。

## 7. 详细验收用例

### 7.1 配置与关闭行为

#### AT-JEV-001 · 默认关闭

- 前置：未配置任何 Jev 环境变量。
- 操作：启动 PiGO 并完成一次包含 review 的开发任务。
- 预期：服务启动成功；不产生 TypeSafe 出站请求；原流程结果不变；决策查询为空或显示 `disabled`。

#### AT-JEV-002 · 显式 off

- 前置：`PI_DECISION_ENGINE=jev`、`PI_JEV_MODE=off`，提供有效 key。
- 操作：运行任务。
- 预期：不发外部请求；key 不出现在日志；任务正常完成。

#### AT-JEV-003 · Shadow 缺少凭据

- 前置：`PI_JEV_MODE=shadow`，不提供 key。
- 操作：启动并运行任务。
- 预期：启动预检明确显示 Jev 不可用或评估返回 `missing_credentials`；不得导致主服务或开发任务失败；产生可操作告警。

#### AT-JEV-004 · 非法配置

- 输入：非法 mode、负超时、采样率大于 1、payload 上限非整数。
- 预期：配置 schema 拒绝，并给出不含敏感值的明确错误；不得偷偷使用宽松默认值。

#### AT-JEV-005 · 运行时 Kill Switch

- 操作：shadow 流量运行期间切换到 `off` 并按部署方式重载。
- 预期：新评估停止外部调用；在途调用最多在总超时后结束；原任务继续运行；历史审计保留。

### 7.2 请求与响应合同

#### AT-JEV-010 · Probability/Noul 映射

- Mock 返回合法 yes/no 概率。
- 预期：保存布尔判断及原始概率；概率在 `[0,1]`；不因布尔值丢失概率。

#### AT-JEV-011 · Choice 映射

- Mock 返回选中项、所有选项概率和 confidence。
- 预期：选中项必须属于请求白名单；概率分布和 confidence 完整持久化。

#### AT-JEV-012 · Score 映射

- Mock 返回 weighted score、概率和 confidence。
- 预期：score 为有限数字；权重定义来自版本化 policy；结果可回放。

#### AT-JEV-013 · 缺失/未知字段

- Mock 返回缺少答案、未知 question ID、未知选项、`NaN`、越界概率或额外结果。
- 预期：整个评估或对应问题按 policy 标记 `contract_invalid`；不得把未知值映射到默认安全值。

#### AT-JEV-014 · 实际模型版本

- Mock/Live 返回与 `jev-latest` 不同的实际版本标识。
- 预期：同时记录 requested 和 resolved model；审计页面可见；聚合指标可按 resolved model 分组。

#### AT-JEV-015 · 稳定 Hash

- 对相同语义但对象键顺序不同的状态重复计算。
- 预期：规范化后的 `stateHash` 相同；内容、policy version 或 question schema 改变时对应 hash 改变。

#### AT-JEV-016 · Payload 上限

- 输入：刚好低于、等于和高于 65536 字节的脱敏后状态。
- 预期：边界处理一致；超限返回 `payload_rejected`；不发送截断后语义不明的请求。

### 7.3 Review Shadow

#### AT-JEV-020 · 正常调用点

- 操作：reviewer 返回合法结构化 review。
- 预期：Jev 调用发生在 Review Protocol 解析成功后、Decision Brief 完成前；审计记录关联同一 run。

#### AT-JEV-021 · Shadow 零行为影响

- 操作：让 Mock 分别返回完全相反的判断。
- 预期：review verdict、finding severity、任务状态、重试次数、Decision Brief 权威 gate 和发布结论完全相同；`appliedOutcome=none`。

#### AT-JEV-022 · 高危 Finding 不可降级

- 输入：一个 `high` 和一个 `critical` finding；Mock 返回“不相关、无风险、低紧急度”。
- 预期：原 finding 等级和阻断效果不变；记录 disagreement；不能通过任务。

#### AT-JEV-023 · 确定性失败优先

- 输入：lint/typecheck/test 任一失败，Jev 返回高概率“可继续”。
- 预期：确定性检查仍阻断；Jev 结果不能改变 gate。

#### AT-JEV-024 · 低置信度

- Mock 返回接近均匀的概率或低 confidence。
- 预期：标记 `uncertain`；不得形成可执行 outcome；审计保留完整分布。

#### AT-JEV-025 · 中英文一致性

- 对同一语义的中英文样本分别评估。
- 预期：合同均有效；不存在因编码导致的字段丢失或请求失败；语义差异纳入评估报告。

#### AT-JEV-026 · Finding 分批

- 输入：51 个及 100 个 findings。
- 预期：按稳定顺序分批；每个 finding 只评估一次；合并结果保持原顺序；某一批失败只标记该批 fallback。

#### AT-JEV-027 · Diff 不完整

- 输入：`diffComplete=false`。
- 预期：状态显式包含不完整标记；Jev 不能据此产生降低风险的可执行判断；shadow 结果仅供观察。

#### AT-JEV-028 · Review 协议失败

- 输入：reviewer 输出无法通过 Review Protocol，触发现有协议重试。
- 预期：协议成功前不调用 Jev；最终仍失败时保持现有处理，不构造不完整评估。

### 7.4 Planner 路由（阶段 3/4）

#### AT-JEV-030 · Planner Shadow

- Jev 返回高置信度 `single_agent`。
- 预期：shadow 模式仍执行现有 planner；记录两者是否一致及额外时延。

#### AT-JEV-031 · Planner Assist

- 预期：UI 展示建议、概率、confidence、policy/model 版本；实际执行仍由现有 planner 决定。

#### AT-JEV-032 · Enforce 高置信度单代理

- 前置：该 DecisionKind 经批准为 enforce。
- 输入：概率和 confidence 均不低于 0.90，且无风险标记。
- 预期：可以跳过 planner；审计记录 `appliedOutcome=single_agent`；其余开发和 review gate 不变。

#### AT-JEV-033 · Enforce 低置信度回退

- 输入：任一阈值低于 0.90。
- 预期：执行现有 planner；fallback/route reason 清晰可见。

#### AT-JEV-034 · 风险特征强制 Planner

- 输入：跨组件、数据库迁移、部署、权限、安全或需求缺失任一标记为真。
- 预期：无论 Jev 概率多高都执行现有 planner。

#### AT-JEV-035 · Human Clarification 不自动阻断

- Jev 返回 `human_clarification`。
- 预期：在首版 enforce 中只展示 assist 信号，不自动将任务置为 `needs_human`。

### 7.5 网络、重试与降级

#### AT-JEV-040 · 超时

- Mock 延迟超过 3 秒。
- 预期：底层请求被取消；返回 `timeout`；总耗时不明显超过配置预算；任务继续原流程。

#### AT-JEV-041 · 429 限流

- 第一次返回 429 和可满足的 `Retry-After`，第二次成功。
- 预期：最多重试一次；总时限内成功并记录 attempts。
- 变体：`Retry-After` 超出剩余预算时不等待，直接 fallback。

#### AT-JEV-042 · 529/5xx

- 第一次 529，第二次成功；随后持续 529。
- 预期：有抖动退避且最多一次重试；持续失败触发熔断；任务不失败。

#### AT-JEV-043 · 401/403

- 预期：不重试；返回 `authentication_failed`；打开熔断并告警；日志不包含 key 或完整响应体。

#### AT-JEV-044 · 422

- 预期：不重试；标记 `contract_invalid`；告警包含 policy version 和 question schema hash，便于定位。

#### AT-JEV-045 · 连接重置/DNS/TLS 错误

- 预期：错误标准化为 `provider_unavailable`；有剩余预算时最多重试一次；不泄漏底层敏感上下文。

#### AT-JEV-046 · Worker 取消

- 操作：调用期间取消开发任务或终止对应 run。
- 预期：AbortSignal 传播到底层 fetch；没有长时间悬挂请求；记录 `aborted`；不产生后续 applied event。

#### AT-JEV-047 · 幂等重放

- 对同一 `evaluationId` 重复提交。
- 预期：返回已存在结果；不重复请求供应商、不重复记账、不重复发事件。

#### AT-JEV-048 · 熔断恢复

- 连续制造 5 次供应商错误，等待 half-open，再恢复成功。
- 预期：熔断期间不发外部请求；只放行一个探测；成功后关闭熔断；过程可观测。

### 7.6 安全与隐私

#### AT-JEV-050 · Key 隔离

- 检查浏览器 bundle、网络请求、worker job payload、沙箱环境、终端日志和审计记录。
- 预期：均不存在 `TYPESAFE_API_KEY`；只有服务端 adapter 能读取。

#### AT-JEV-051 · Secret Redaction

- 输入包含伪 AWS key、GitHub token、JWT、Bearer token、私钥、Cookie、数据库 URL。
- 预期：mock server 接收到的内容已脱敏；hash 基于脱敏后的规范化状态；日志没有原值。

#### AT-JEV-052 · 默认不外发源码

- 输入包含完整 diff 和源码字段。
- 预期：字段白名单在 adapter 前移除或拒绝这些字段；`PI_JEV_ALLOW_SOURCE=false` 时不可能发送。

#### AT-JEV-053 · Prompt Injection

- 输入包含诱导改变问题、选项、输出或执行操作的文本。
- 预期：question schema 和 options 不变；未知返回被拒绝；不产生工具、Git、部署或数据库操作。

#### AT-JEV-054 · 内部 API 鉴权

- 使用无 token、浏览器 session、过期 token 和错误 worker token 调用 evaluate。
- 预期：全部拒绝且不触发外部调用；合法 worker token 可以调用。

#### AT-JEV-055 · 错误体脱敏

- Mock 在 4xx/5xx 响应中回显请求和伪 key。
- 预期：持久化和日志只保留标准错误类别、状态码和安全摘要。

#### AT-JEV-056 · 数据保留和删除

- 根据最终保留策略创建过期记录并执行清理。
- 预期：审计元数据按策略保留/删除；不影响 run 主数据；清理行为有审计记录。

### 7.7 审计、指标和成本

#### AT-JEV-060 · 审计完整性

- 预期：每次评估能查到 run、kind、mode、provider、requested/resolved model、policy、hash、状态、回答、fallback、时延和时间戳。

#### AT-JEV-061 · Usage 独立归类

- 预期：Jev usage 记录为 `role: "decision"`；不计入 developer/reviewer token；总预算页面能单独聚合。

#### AT-JEV-062 · 未知成本

- 当响应无法提供可靠 token 或价格表缺失时。
- 预期：字段为 `null/unknown`，不能显示 `$0.00`。

#### AT-JEV-063 · 事件一致性

- 预期：每个 completed/fallback 对应一个 requested；shadow 不产生 applied；enforce 的 applied 引用原 evaluation ID。

#### AT-JEV-064 · 指标基数

- 预期：Prometheus/指标标签不包含 run ID、evaluation ID、文件名或用户输入；避免高基数。

#### AT-JEV-065 · 决策回放

- 使用保存的脱敏 fixture、相同 policy 和 mock 响应回放。
- 预期：本地 policy 产生相同 outcome；供应商概率本身不要求跨模型版本复现。

### 7.8 性能和容量

#### AT-JEV-070 · Mock 开销

- 在 CI 环境运行 500 次本地 mock 评估。
- 预期：除模拟网络等待外，PiGO 自身 p95 处理开销不高于 50 ms；无明显内存持续增长。

#### AT-JEV-071 · Live 时延

- 从计划部署区域完成不少于 100 次无敏感数据的在线评估。
- 初始目标：p95 不高于 2 秒，p99 不高于 3 秒；任何请求的本地总预算不超过 3 秒。
- 若未达到：不得进入 assist；可以保持 shadow 并调整部署区域或超时策略。

#### AT-JEV-072 · 并发和限流

- 以预估峰值的 2 倍并发运行 mock 压测。
- 预期：内部限流生效；不会耗尽 worker 连接池；过载请求安全 fallback；主任务吞吐无严重退化。

#### AT-JEV-073 · 大批 Findings

- 连续运行 100 个 findings 的批处理任务。
- 预期：内存和审计写入受控；批次可追踪；总外部请求数符合设计上限。

### 7.9 Live Smoke

#### AT-JEV-080 · 真实 API 最小调用

- 使用纯合成状态和固定问题调用官方 API。
- 预期：HTTP 成功、schema 通过、resolved model 被记录、无敏感数据。

#### AT-JEV-081 · 别名漂移

- 当 `jev-latest` 指向新的 resolved model。
- 预期：产生模型版本变化告警；历史指标不混合；必要时自动保持 shadow。

#### AT-JEV-082 · 选项顺序敏感性

- 对同一 choice 问题以多种选项顺序测试。
- 预期：评估报告包含分布变化；若变化超过约定阈值，不得将该 policy 用于 enforce。

#### AT-JEV-083 · 模型已知弱项

- 覆盖数字比较、计数、日期、间接引用、长无关上下文、矛盾条件和对抗内容。
- 预期：这些判断保持确定性代码优先；报告明确记录 jaggedness，不以单一总准确率掩盖弱项。

## 8. 自动化测试矩阵

| 层级 | 实际测试文件 | 重点 |
| --- | --- | --- |
| Unit | `src/server/decision-engine/config.test.ts` | 默认值、严格配置、凭据缺失 |
| Unit | `src/server/decision-engine/redaction.test.ts` | 密钥/PII 脱敏、payload 上限、状态与 schema hash |
| Unit | `src/server/decision-engine/response-schema.test.ts` | 三类输出映射、畸形响应、live 字段形状 |
| Unit | `src/server/decision-engine/policy.test.ts` | 模式门控、不可变规则、低置信度 |
| Unit | `src/server/decision-engine/jev.test.ts` | 请求映射、headers、错误映射、重试表、熔断、取消 |
| Unit | `src/server/decision-engine/engines.test.ts` | disabled/mock 引擎契约 |
| Unit | `src/server/decision-engine/index.test.ts` | 引擎组装、模式门控、shadow 采样 |
| Unit | `src/server/decision-engine/key-source.test.ts` | vault/env key 解析优先级 |
| Unit | `src/server/decision-engine/review-triage.test.ts` | 状态投影、问题集、分批与批次隔离 |
| Unit | `src/server/decision-engine/prompt-injection.test.ts` | AT-JEV-053：注入不改 schema、只作数据、未知返回整体拒绝、决策路径无 I/O |
| Unit | `src/server/decision-engine/replay.test.ts`（fixture `fixtures/replay-review-triage.json`） | AT-JEV-065：脱敏 fixture 回放、出站载荷钉住、概率抖动与模型漂移不改 outcome |
| Unit | `src/server/decision-engine/locale-consistency.test.ts` | AT-JEV-025（本地半边）：多脚本编码不丢失、代理对不被切断、CJK 上限 fail-closed |
| Unit | `src/server/decision-engine/deterministic-priority.test.ts` | AT-JEV-083（本地半边）：七类弱项的确定性代码优先、超预算 fail-closed、逐问题粒度 |
| Unit | `src/server/decision-engine/option-order.test.ts` | AT-JEV-082（本地半边）：名称键与顺序无关、位置键按请求顺序翻译、enforce 保持关闭 |
| Integration | `src/server/decision-engine/integration.test.ts` | 本地 HTTP server：重试、熔断、超时、取消、鉴权 |
| Worker | `src/worker/decision-triage.test.ts` | worker 侧调用点、verdict→triage 顺序 |
| Worker | `src/worker/decision-integration.test.ts` | worker 端到端接入（注入 transport，无网络） |
| API | `src/server/decision-routes.test.ts` | 内部鉴权、持久化、事件配对、幂等、脱敏查询 |
| E2E | `tests/e2e/decision-engine.spec.ts` | off/shadow 真实运行零影响（需已部署环境） |
| Live | `tests/live/jev-contract.test.ts` | 官方 API 合同、resolved model、时延分布（`PI_JEV_LIVE=1` 才运行） |

以上均为当前仓库实际存在的文件。

实际存在的 npm 脚本（见 `package.json`）：

- `npm run test:decision` — 运行决策引擎单测、`src/server/decision-routes.test.ts` 与 worker 接入测试。
- `npm run test:decision:e2e` — 运行 `tests/e2e/decision-engine.spec.ts`（需要已部署环境）。
- `npm run test:jev:live` — 在线合同测试，仅在 `PI_JEV_LIVE=1` 时真正发起调用（`vitest.live.config.ts`）。
- `npm run report:at-coverage` — 生成 §7/§12 用例的引用级追溯矩阵（见 §8.1）。

常规 CI 门禁应包含：

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:decision
npm run test:decision:e2e
npm run report:at-coverage
```

`npm run test:jev:live` 不进入每个 PR 的强制门禁，建议在手动 workflow 或受控 nightly 中运行。在线测试失败应通知负责人并阻止模式升级，但不应因供应商瞬时故障阻止无关代码合并。`npm run report:at-coverage` 默认退出码为 0（报告性质），`--strict` 才在存在 uncited 用例时以 1 退出。

### 8.0 验收门禁怎么跑（含 demo 目标与必需变量）

`node scripts/acceptance-gate.mjs` 的 8 个步骤永远全部必需（可选步骤会被转成 FAIL），其中两步
依赖外部环境，缺变量不是 SKIP 而是 FAIL：

```sh
# 1) 真 PostgreSQL：postgres 容器不发布 5432，只能从宿主取它**当前**的容器 IP（重启会变）再本地转发
IP=$(ssh free2way@192.168.2.235 docker exec pi-agent-postgres-1 cat /etc/hosts | grep -vE '^127\.' | head -1 | cut -f1)
ssh -N -L 15432:$IP:5432 free2way@192.168.2.235      # 另开一个终端保持（重复开会因已占用直接退出）
# 2) 真实浏览器 + 真实运行的场景（demo 栈）
export PI_E2E_BASE_URL=http://192.168.2.235:3101
export PI_E2E_DEV_EMAIL=bobo.2000@gmail.com     # ← 必须是与部署中凭据同属一个身份
export PI_E2E_LIVE=1                            # 打开真实运行场景（真实调用 + 在 demo 建运行）
export PI_E2E_CRASH_COMMAND='bash /tmp/pigo-kill-worker.sh'   # E2E-06 崩溃演练
export PI_DATABASE_URL='postgresql://pigo:<pw>@127.0.0.1:15432/pigo_demo'
export NO_PROXY=192.168.2.235,localhost,127.0.0.1
node scripts/acceptance-gate.mjs
```

**最容易踩的坑**：`realRunsAvailable` 是**按身份**判定的（凭据在 vault 里归属于请求身份）。
suite 默认身份是 `developer@localhost`，而 demo 的凭据配在管理员 `bobo.2000@gmail.com` 名下，
所以漏掉 `PI_E2E_DEV_EMAIL` 时所有真实场景会静默跳过、门禁报 FAIL 且原因只写
`realRunsAvailable=false`——看起来像部署坏了。`tests/e2e/fixtures.ts` 的
`missingRealRunsReason()` 现在会把这条诊断直接写进跳过原因里（点名当前身份与
`configuredProviders`），不要再退回成裸的 `realRunsAvailable=false`。

**E2E-05（越权审核模型）在 demo 上也不需要额外配置**——模型目录里已有合规组合：
`deepseek / deepseek-flash` 的 `selectableRoles = ["developer"]`（**不含 reviewer**）且 provider 凭据
`verified=true`，正是"凭据有效但无权用于审核角色"。2026-10-07 实测通过（1.4 秒；pre-queue 拦截 ⇒
不创建运行、不消耗额度）：

```sh
PI_E2E_BASE_URL=http://192.168.2.235:3101 PI_E2E_DEV_EMAIL=bobo.2000@gmail.com \
PI_E2E_LIVE=1 PI_E2E_PREFLIGHT_PROVIDER=deepseek PI_E2E_PREFLIGHT_MODEL=deepseek-flash \
PI_E2E_PREFLIGHT_CODE=MODEL_NOT_ALLOWED \
  npx playwright test tests/e2e/acceptance.spec.ts -g 'E2E-05' --project=chromium
```

（这三个 `PI_E2E_PREFLIGHT_*` 是**测试侧**变量，命令行传入即可；部署侧只需"目录里有 `selectableRoles`
不含 reviewer 的模型 + 该 provider 凭据已配置"。换环境时用 `/api/models` 找任意这样的组合。）

**E2E-07（预算停止）在 demo 上是可以跑的**，配方如下（2026-10-07 实测通过，2.0 分钟）：

```sh
# 1) 把 demo 改成「预算只够 Planning」：备份 → 改 demo.env → 重建容器（web 与 worker 都要生效）
cp -p /app/pi-agent/demo.env /app/pi-agent/demo.env.bak-pre-e2e07
sed -i 's/^PI_RUN_MAX_TOKENS=.*/PI_RUN_MAX_TOKENS=20000/' /app/pi-agent/demo.env
cd /app/pi-agent/source && docker compose -p pigo-demo -f deploy/docker/compose.demo.yaml \
  --env-file /app/pi-agent/demo.env up -d demo-web demo-worker

# 2) 用例期望值必须与部署一致（用例会核对 run 创建时冻结的 run.budget，不一致会点名该改的变量）
PI_E2E_BASE_URL=http://192.168.2.235:3101 PI_E2E_DEV_EMAIL=bobo.2000@gmail.com \
PI_E2E_LIVE=1 PI_E2E_BUDGET_TOKENS=20000 \
  npx playwright test tests/e2e/acceptance.spec.ts -g 'E2E-07' --project=chromium

# 3) 跑完还原预算（默认 60000 / $0.50），否则后续 demo 运行都会被 20000 截断
cp -p /app/pi-agent/demo.env.bak-pre-e2e07 /app/pi-agent/demo.env
cd /app/pi-agent/source && docker compose -p pigo-demo -f deploy/docker/compose.demo.yaml \
  --env-file /app/pi-agent/demo.env up -d demo-web demo-worker
```

实测结果：80% 预警 → 达上限停止调用 → 进入 `needs_human` → 制品保留，全部通过。

**9 个必需场景现在都能在 demo 上执行并已分别实测通过**，但**一次门禁跑无法同时包含 E2E-07**：
E2E-07 要求部署处于「预算只够 Planning」（`20000`），而 E2E-01b/02/04/06/08 需要预算足够跑完真实
闭环——两者互斥。所以标准做法是：门禁主跑一次（含 E2E-05，偏差开关只为 E2E-07 打开），E2E-07 按上面
的配方单跑并把结果记在证据里。开关只认下面这个变量，且原因必填：

```sh
export PI_E2E_ALLOW_REQUIRED_SKIPS=1
export PI_E2E_ALLOW_REQUIRED_SKIPS_REASON='E2E-07 需要部署处于 Planning-only 预算（20000），与其余真实场景所需的充足预算互斥；已按 §8.0 配方单跑通过（2.0 分钟），其余 8 个必需场景在同一环境实测通过'
```

已验证的实测数字（2026-10-07，demo 目标、提交 `809dc5b`）：带 `PI_E2E_LIVE=1` 时
E2E **26 执行 / 26 通过 / 0 失败**（含 Worker 崩溃恢复与恶意仓库隔离）；**E2E-05** 单跑通过
（1.4 秒，`deepseek/deepseek-flash` + `MODEL_NOT_ALLOWED`，pre-queue 拦截故不建运行、不耗额度）；
**E2E-07** 按 §8.0 配方单跑通过（2.0 分钟）；门禁 **8 passed / 0 failed / 0 skipped**（偏差仅在 E2E-07）。
真实场景会在 demo 上创建约 30+ 个运行，跑完记得按需清理
（`POST /api/runs/batch` 的 `action: "cleanup"`，按 owner 身份分批 ≤50）。

### 8.1 AT 追溯矩阵（引用级检查）

`npm run report:at-coverage` 解析本文档 §7.1–§7.9 与 §12 的 `AT-JEV-xxx` 标题，并在
`src/**/*.test.ts(x)`、`tests/e2e/**`、`tests/live/**`、`scripts/*.test.mjs` 中检索编号引用，
打印三态结果：`cited`（列出引用文件）、`uncited`（文档有用例、无任何测试引用），以及
"被测试引用但文档中不存在"的防御性提示（正常应为 0）。

局限（诚实声明）：这是**引用级**检查，不是覆盖率证明。编号出现在测试标题或注释里只表示
"有人声称该测试映射到这条用例"，**不等于**该用例描述的行为已被断言证明。`uncited` 是可靠信号
（无人声称覆盖）；`cited` 仍需人工核对断言内容。截至本次更新：61 条用例中 52 条 cited、9 条 uncited
（`uncited` = `030–035 / 090 / 091 / 093`）。

已知缺口（无自动化证据，不得在阶段升级时当作已验收）：

- **AT-JEV-025（中英文一致性）**：无任何测试引用（计划随 P4 中文校准一起做）。
- **AT-JEV-071（Live 时延）**：`tests/live/jev-contract.test.ts` 仅记录 p50/p95/max 日志，且需
  `PI_JEV_LIVE=1` + 真 key；它**不断言** p95 ≤ 2s / p99 ≤ 3s 阈值，不构成门禁级证据。
  执行方式：`PI_JEV_LIVE=1 PI_JEV_LIVE_CALLS=100 TYPESAFE_API_KEY=<key> npm run test:jev:live`
  （合成状态，不碰任何 run/审计表）。

  **回填模板**（执行人跑完填入，值必须来自那次运行的输出；`<key>` 只进环境变量，绝不落盘）：

  | 执行人 | 日期(本地) | 出口区域 | 模型(请求→解析) | Calls | 成功 | p50 | p95 | p99 | max | p95≤2s / p99≤3s |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | （待填） | | | | | | | | | | |

  判定口径：只有 100 次调用全部成功才计入"通过"；出现失败（含 429/超时）时按 docs/26 §12 的降级
  路径记录，并把失败计数一并写在上表下方——**不得**只报成功那部分的时延。
- **AT-JEV-080（真实 API 最小调用）**：由在线 opt-in 套件引用（需 `PI_JEV_LIVE=1` + 真 key）。
- **AT-JEV-090 / 091（配置回滚、引擎回滚）**：**有手工演练证据**（2026-10-06 demo 实测，步骤与结果记录在
  docs/25「决策平面回滚演练」），但未被任何测试引用，因此本脚本仍报 uncited——脚本只识别测试引用。
- **AT-JEV-030～035（Planner 路由）、093（Enforce 自动降级）**：无自动化引用，多为阶段 3/4 用例。
- **AT-JEV-025 / 082 / 083 的供应商侧半边**：本地半边已由新增用例覆盖（见下），但
  "同一语义中英样本的**语义差异**"（025）、"同一 choice 换顺序后**分布变化多少** + 约定阈值"
  （082）、"七类弱项的实际**测准率 / jaggedness 报告**"（083）都需要真 key 评估与评估报告
  （AT-JEV-071 类），**仍未覆盖**，不得据此把 policy 用于 enforce。

已被证据补齐（本次更新移出缺口清单）：

- **AT-JEV-053（提示注入）**：`src/server/decision-engine/prompt-injection.test.ts`（15 例）。四条断言分别覆盖
  AT 的三项预期：①问题 id 由 finding 稳定 key 派生、内容等于静态模板（注入文本进不了 question/options/levels，
  `questionSchemaHash` 对注入内容不变而 `stateHash` 变）；②注入只能作为数据落在 state 允许字段里（逐层键白名单，
  不出现 `toolCall/command/deploy/merge/options` 等键；envelope 里的未知顶层字段被丢弃且不进结果）；
  ③未知/注入形状的返回**整体拒绝**（未知问题 id、注入选项、概率越界、夹带命令字段、类型不符、score 越界、
  分布不完整、缺答案共 8 种，且 detail 只含问题 id 不含凭据）；④决策路径无 I/O——`review-triage/policy/
  response-schema/mock` 不导入任何 `child_process/node:fs|net|http|dns/pg/docker/git/deploy` 且无 `require(`，
  run 对象深冻结后跑完整条链路不被改写，shadow 恒 `appliedOutcome: none`，确定性门失败只加违规不施加结果，
  注入也无法把 `shadow` 抬成可施加模式。
- **AT-JEV-065（决策回放）**：`src/server/decision-engine/replay.test.ts` + fixture
  `fixtures/replay-review-triage.json`（5 例，合成且按构造脱敏：无仓库路径/diff 内容/密钥）。fixture 记录
  真实线上契约形状的响应（`noul` / `choice`+distribution / `score`+`legend` 位置键），并把
  `questionSchemaHash`、`stateHash` 与本地 policy 的答案取值一起钉住——投影或模板漂移即失败；重复回放逐字段
  相同（含影子采样 `shouldSampleShadow` 稳定）；同一“桶”内的概率抖动与模型版本漂移（`jev-1.13.0`→`1.14.0`）
  不改变 outcome，只有越过政策阈值（certainty 归零、分布变平）才记为 `uncertain`，此时 assist 也不施加结果
  （`none`）；模型版本只被记录、不参与 outcome。
- **AT-JEV-025（中英文一致性，本地半边 + 一个真实缺陷修复）**：`locale-consistency.test.ts`（5 例）。
  **修复**：`redactExcerpt` 原用 `slice(0, maxChars)`，当截断点落在代理对中间会留下孤立高代理
  （`"\ud83d"`），JSON 里是非法转义且无法经 UTF-8 往返——即 AT 禁止的"编码导致的字段丢失"。
  新增 `truncateChars`（按字符边界、不切断代理对）并用于 excerpt、Jev 诊断文本、保留清理错误文本、
  指标读取告警共 4 处；回归用例用"199 字符 + emoji"精确复现该边界（修复前必失败）。用例还覆盖：
  中文任务/AC 走完整链路（投影保留文本、合同有效、shadow 不施加结果）、emoji/国旗/RTL/组合音标
  经脱敏与序列化后完整、CJK token 估计不低估（≥ 字符数、≥ bytes/4）、超预算 fail-closed 且 detail
  不回显内容、中英两版合同均有效且问题 schema 与语言无关（只数据不同）。
  **仍未覆盖**：供应商侧"同一语义中英文样本"的语义差异评估（需 071）。
- **AT-JEV-083（模型已知弱项，本地半边）**：`deterministic-priority.test.ts`（11 例）。逐条覆盖 AT 列出的
  七类弱项（数值比较/计数/日期/间接引用/长无关上下文/矛盾条件/对抗内容）：确定性门失败时，**即使
  enforce 已 allowlist 且答案极自信也不施加结果**（并给出"无门失败时会施加"的对照，证明拒绝只因确定性
  信号）；检查项结果由确定性计算决定（`allPassed`/`failedNames` 不受任何模型字段影响）；单条 finding
  超预算 → 该批拒绝且不二次截断（预算由两批实测 token 夹出）、其余批照常外呼且引擎调用次数精确；
  run 级验收标准灌满 → 全部批次 fail-closed、**零外呼**；记录保持**逐问题**粒度（8 问 8 答，仅一题
  uncertain ⇒ assist 不施加结果，全自信 ⇒ 给建议），使报告能按问题类拆分而非用一个总准确率掩盖弱项。
  **仍未覆盖**：供应商侧实际测准率与 jaggedness 报告（需 071）。
- **AT-JEV-082（选项顺序敏感性，本地半边）**：`option-order.test.ts`（4 例）。断言顺序敏感性 **不由我方
  管道引入**：名称键答案在三种选项顺序下映射出同一 value、同一政策结果；位置键（线上 `"0","1",…` +
  `legend`）必须按**请求里的等级顺序**翻译，并钉住 `weighted_score` 属位置语义这一真实耦合——护栏是
  生产模板恒为低→高且生成的问题保持该顺序；不确定性判定只看取值分布；**阈值未约定、顺序敏感性未测量
  之前 enforce 必须保持关闭**（默认不 allowlist 任何 kind，且 enforce 被降级为 assist）。
  **仍未覆盖**：供应商侧"换顺序后分布变化多少"的测量与约定阈值（需 071）。

- **AT-JEV-061（usage 独立归类）**：`src/server/decision-usage.ts` 读取时聚合（不落库、无迁移）+
  `GET /api/runs/:id` 接线；证据：`decision-usage.test.ts`、`decision-usage-route.test.ts`；
  线上（demo）实测 run 详情出现 `role:"decision"`（tokens 128/0、calls 1、`unpricedCalls` 1），
  其余角色与 `usage.estimatedCost` 未被污染。
- **AT-JEV-062（成本未知不得显示 $0.00）**：`RunRoleUsage.unpricedCalls` + 客户端纯函数
  `roleCostDisplay/roleCostLabel`（角色行与**面板汇总行**同一判定）+ zh/en 文案；
  证据：`src/client/budget-roles-view.test.ts`；浏览器实测：角色行显示「未知」、汇总行显示 `≥ $0.004`、
  并出现「有 1 次调用未计价…」提示。
- **AT-JEV-081（别名漂移告警）**：`decision-drift.test.ts`（首次观测/同版本不告警、版本变化恰好一次、
  幂等重放不告警、未接线静默 no-op、基线查询失败不影响评估）；生产经 `AlertManager`
  （key `jev_model_drift`，900s 去重）出结构化日志 + 可选 `PI_ALERT_WEBHOOK`。
  触发路径的真实漂移只有在供应商更换版本时才会发生：单测覆盖触发逻辑，线上验证"同版本不误报"
  （真外发 4839/994 tok、审计 6→7、0 告警）。
- **AT-JEV-056（数据保留和删除）**：`decision-retention.ts`（配置解析）+ `audit-retention.ts`（清理器）+
  worker 小时级触发 + 内部路由；证据：`audit-retention.test.ts`（20 例，含"默认 0 时一条 SQL 都不发"）。
  **缺口**：清理行为只有结构化 warn + HTTP 响应，durable 审计记录需要新表（仓库无通用运维审计载体）。
- **AT-JEV-092（凭据撤销）**：`decision-auth-alert.test.ts`（7 例：401/403 恰好一条告警且 details 无敏感字段、
  重放不重复、多批次仍一条、未注入 sink 静默、`missing_credentials` 不告警）。**实测缺口已修补**：
  原先换 key 不会自动重置被锁死的熔断（只证明"重启 + 新 key → completed"），现已在校验通过的凭据写入后
  调用 `resetDecisionCircuitBreakers()`，告警指引的动作真的可恢复。
- **AT-JEV-070 / 072 / 073（Mock 开销、并发限流、大批 Findings 容量）**：`tests/perf/decision-perf.test.ts`
  （opt-in：`PI_DECISION_PERF=1 npm run test:decision:perf`，不进默认门禁）。本机实测：500 次 mock 评估
  （warmup 50）p50 ≈ 0.27ms、p95 ≈ 0.36ms ≤ 50ms、堆增量 ≈ 0.05MiB（`--expose-gc`）；2× 峰值（8 并发，
  峰值取自 worker `PI_MAX_ACTIVE_JOBS` ≤ 4）全部完成、p95 ≈ 2.6ms，429 与熔断（阈值 5）均安全回退且过载期零外呼；
  100 findings @ `PI_JEV_REVIEW_MAX_FINDINGS=50` → 2 批次 / 2 次外部请求 / 2 条审计 / 400 个问题（每 finding 4 问）。
  另：决策平面自带**并发准入控制**（`decision-engine/admission.ts`，`PI_DECISION_MAX_CONCURRENT`
  默认 4，由 `registerDecisionRoutes` 恒定安装）：8 路并发 @ 上限 4 → 恰好 4 路进入 provider、
  4 路返回 `rate_limited` 业务安全回退且**零外呼零审计行**，在飞峰值 4（`decision-admission.test.ts` +
  perf 用例实测）。熔断仍是"失败后"的保护，两者互补。


## 9. Shadow 统计验收

### 9.1 指标定义

| 指标 | 计算方式 |
| --- | --- |
| 有效响应率 | schema 有效的 completed / 实际发起请求 |
| 高风险召回率 | 人工标记 material 的样本中，模型判为 possible/material 的比例 |
| 一致率 | 模型首选结果与最终人工标签一致的比例 |
| Brier Score | probability 判断的均方概率误差 |
| ECE | 按置信区间分桶后的期望校准误差 |
| 分歧率 | Jev 建议与现有流程最终结果不同的比例 |
| fallback 率 | fallback / 全部 evaluation |
| 增量时延 | 开启 shadow 相对关闭时的 run 时延变化 |

### 9.2 Shadow → Assist 门槛

建议初始门槛：

- 样本量不少于 200；若不足，必须记录原因并进行人工例外审批。
- 有效响应率不低于 99%（排除验收主动注入的故障）。
- 高风险召回率不低于 95%，且不得遗漏人工标记的 `critical` 样本。
- ECE 不高于 0.10；若不满足，必须调整阈值或仅显示原始概率。
- 部署区域 Live p95 不高于 2 秒、p99 不高于 3 秒。
- 无主流程失败、状态卡死、重复计费或密钥/源码/PII 泄漏。
- 所有 fallback 均能由指标和审计定位。

指标未达到不代表必须删除集成，可以继续保持 shadow；不得通过降低测试覆盖或删除困难样本来达标。

### 9.3 Assist → Planner Enforce 门槛

仅适用于 `planner_route=single_agent` 子集：

- 至少 100 个同时满足拟定阈值的历史样本。
- 人工/现有 planner 一致率不低于 98%。
- 不出现安全、迁移、部署、权限或跨组件任务被错误归入可跳过 planner。
- 与基线相比，任务失败率或 `needs_human` 率增加不超过 2 个百分点。
- planner 调用量减少至少 20%，否则收益不足以承担复杂度。
- 已验证自动回滚规则、kill switch 和值班告警。

任一条件不满足，继续使用 shadow/assist。

## 10. 回归验收

Jev 功能开启和关闭时，都必须执行现有 PiGO 回归：

- 单代理开发流程。
- 多代理 planner 和依赖波次。
- reviewer 协议重试。
- 多轮修复和 streak 行为。
- budget reserve/record。
- Decision Brief 生成。
- `needs_human` 和取消流程。
- 任务完成后 UI 状态、usage 和事件查询。

对同一 deterministic fixture，`off` 与 `shadow` 的主流程最终状态必须一致；允许差异的只有决策审计、指标和最多 3 秒的受控附加时延。

## 11. 可观测性与告警验收

必须能在一个仪表板中查看：

- 按 kind/mode/status 的请求量。
- p50/p95/p99 时延。
- 按原因统计的 fallback。
- 401/403、422、429、529 和网络故障。
- requested/resolved model 变化。
- 熔断状态。
- token/估算成本和未知成本比例。
- shadow 分歧率、高风险召回和校准指标。

必须配置以下告警：

- 任何 authentication failure。
- 15 分钟有效响应率低于 95%。
- fallback 率连续 15 分钟超过 10%。
- p95 连续 15 分钟超过 2 秒。
- resolved model 发生变化。
- 出现潜在敏感信息检测命中。
- enforce applied 后任务失败率显著高于基线。

告警本身不得包含原始 state 或供应商响应。

## 12. 回滚演练

### AT-JEV-090 · 配置回滚

- 在 shadow/assist 环境触发 `PI_JEV_MODE=off`。
- 验收：新请求停止，任务正常继续，历史数据可查。

### AT-JEV-091 · 引擎回滚

- 将 `PI_DECISION_ENGINE=disabled` 并重启/滚动发布。
- 验收：实例健康，worker 不等待 Jev，数据库向后兼容。

### AT-JEV-092 · 凭据撤销

- 撤销 TypeSafe key。
- 验收：不发生无界重试；产生单一明确告警；自动 fallback；可换新 key 恢复。

### AT-JEV-093 · Enforce 自动降级

- 人为触发失败率、时延或模型版本变化阈值。
- 验收：对应 DecisionKind 降级至 shadow/assist；其他功能不受影响；有审计事件。

数据库新增表默认不在紧急回滚中删除。删除或破坏性迁移必须单独审批和备份。

## 13. 验收证据清单

每次阶段升级需要附上：

- Git commit、PR 和部署版本。
- 自动化测试报告及覆盖范围。
- E2E 视频或截图（涉及 UI 时）。
- Live Smoke 的时间、区域、模型版本和脱敏结果。
- 外发字段清单及安全审查结论。
- 标注集版本、样本量、标签规则和分歧处理记录。
- 有效响应率、召回、一致率、Brier、ECE、时延和成本报告。
- 熔断、kill switch 和回滚演练记录。
- 已知问题、接受风险和负责人。
- 阶段审批记录。

不得把 API Key、完整源码、完整 diff 或真实用户隐私放入验收附件。

## 14. 需求追踪矩阵

| 设计要求 | 验收覆盖 |
| --- | --- |
| 默认关闭、可快速回滚 | AT-JEV-001～005、090～093 |
| 严格类型和协议 | AT-JEV-010～016 |
| Review shadow 不改行为 | AT-JEV-020～028 |
| Planner 仅受限 enforce | AT-JEV-030～035 |
| 故障不影响主流程 | AT-JEV-040～048 |
| 数据最小化与凭据安全 | AT-JEV-050～056 |
| 可审计、可计量 | AT-JEV-060～065 |
| 时延和容量可控 | AT-JEV-070～073 |
| 真实 API 与模型漂移 | AT-JEV-080～083 |

## 15. 最终验收检查表

### L2：允许开启 Shadow

- [ ] 所有 L0/L1 自动化测试通过。
- [ ] 默认配置为 `off`。
- [ ] Jev 失败不会改变 run 最终状态。
- [ ] API Key 仅存在于服务端 secret。
- [ ] 外发字段白名单和 redaction 通过安全评审。
- [ ] Live Smoke 成功并记录 resolved model。
- [ ] 仪表板、告警、熔断和 kill switch 可用。
- [ ] 回滚演练通过。
- [ ] 供应商数据处理/保留评审完成。

### L3：允许开启 Assist

- [ ] Shadow 样本量和统计门槛达到要求。
- [ ] 没有 critical 样本漏判。
- [ ] UI 明确标注“辅助建议”，展示概率和版本。
- [ ] 用户可以反馈同意/不同意。
- [ ] 建议不能覆盖确定性 gate。
- [ ] 产品、QA、安全、运维完成签字。

### L4：允许 Planner 受限 Enforce

- [ ] 仅 `single_agent` 低风险子集进入 enforce。
- [ ] 100 个以上高置信度样本达到专项门槛。
- [ ] 风险标记和低置信度强制回退到现有 planner。
- [ ] 自动降级和 kill switch 演练通过。
- [ ] 任务失败率、`needs_human` 率和节省量满足门槛。
- [ ] 独立变更审批完成。

## 16. 验收结论模板

```text
验收版本：
目标等级：L0 / L1 / L2 / L3 / L4
代码版本：
环境与区域：
Policy Version：
Requested / Resolved Model：
样本量：

功能测试：通过 / 不通过
故障降级：通过 / 不通过
安全隐私：通过 / 不通过
性能容量：通过 / 不通过
统计门槛：通过 / 不适用 / 不通过
回滚演练：通过 / 不通过

遗留问题与风险：
限制条件：
最终结论：通过 / 有条件通过 / 不通过

开发负责人：
QA：
安全/隐私：
产品：
运维：
日期：
```

“有条件通过”只能允许继续 shadow，不得直接进入 assist 或 enforce。任何安全、凭据、数据泄漏、主流程故障或确定性 gate 被绕过的问题，都属于阻断缺陷。
