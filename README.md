# PiGO

<p align="center">
  <strong>一个任务，一支 AI 工程团队。</strong><br />
  <em>One task. An AI engineering team.</em>
</p>

<p align="center">
  <img alt="PiGO version 0.26.4" src="https://img.shields.io/badge/version-0.26.4-8b5cf6" />
  <img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-22c55e" />
  <img alt="905 automated tests" src="https://img.shields.io/badge/tests-905_passed-14b8a6" />
  <img alt="Pi powered" src="https://img.shields.io/badge/runtime-Pi-f97316" />
</p>

<p align="center">
  <a href="#中文">中文</a> · <a href="#english">English</a>
</p>

<p align="center">
  <img src="docs/assets/screenshots/pigo-multi-agent.png" alt="PiGO multi-agent workflow dashboard" width="100%" />
</p>

> 上图来自 PiGO 本地演示数据：Planner 将任务拆给三个并行 Agent，界面同步展示分工、状态、检查和审核闭环。<br />
> The screenshot uses PiGO's local demo data and shows one plan fanning out to three parallel agents.

---

<a id="中文"></a>

## 中文

PiGO 是一个以 [Pi](https://github.com/earendil-works/pi) 为核心的多模型、多 Agent 软件交付工作台。它把一次开发需求变成一条可观察、可审核、可恢复的工程流水线：Planner 判断工作量，多个开发 Agent 在隔离分支中并行实现，Integrator 汇总代码，确定性检查先把关，再由独立 Reviewer 审核；审核退回后，问题会被结构化地送回下一轮开发。

你可以分别指定“谁来开发”和“谁来审核”。例如让 DeepSeek 承担高吞吐编码，让 OpenAI 负责独立审查；也可以按项目模板选择其他 Pi 兼容模型。模型不可用时任务会明确失败，不会悄悄切换模型。

### 为什么是 PiGO

| 特点 | PiGO 的做法 |
| --- | --- |
| **真正的多 Agent** | Planner 按复杂度拆分任务，最多并行调度 `PI_MAX_SUBAGENTS` 个开发 Agent（默认 3 个），每个 Agent 都有独立职责、分支和事件流。 |
| **开发与审核解耦** | 每次任务分别固化 Developer 与 Reviewer 的 provider/model；审核使用一次性只读快照，避免“自己写、自己批”。 |
| **快而节制** | 复用 Pi 的轻量运行方式；对 Reviewer 输入做 diff 预算、指纹去重和收敛控制，降低重复上下文与无效返工。 |
| **工程门禁优先** | lint、类型检查、测试等确定性检查在模型审核前运行；失败结果直接回流给开发 Agent。 |
| **全程可解释** | SSE 实时呈现拓扑、对话、Diff、检查、预算、失败尝试和每轮审核结论。终止时生成 Decision Brief，帮助人类快速决定继续还是接受。 |
| **可以接入敏捷交付** | Project → Sprint → Story → Run → Release 串成闭环，支持模板、批量动作、重新打开、合并审批和显式发布 Hook。 |

### 多 Agent 交付闭环

```mermaid
flowchart LR
    U([需求 / Story]) --> P{Planner<br/>评估复杂度与边界}
    P --> A1[Agent · ATLAS<br/>业务实现]
    P --> A2[Agent · NOVA<br/>测试与边界]
    P --> A3[Agent · SENTINEL<br/>安全与回归]
    A1 --> I[Integrator<br/>汇总独立分支]
    A2 --> I
    A3 --> I
    I --> C{确定性门禁<br/>typecheck · lint · test}
    C -->|失败| F[结构化失败上下文]
    F --> P
    C -->|通过| R{独立 Reviewer<br/>用户指定模型}
    R -->|changes requested| X[问题指纹 · 范围 · 证据]
    X --> P
    R -->|approved| H{Human Gate}
    R -->|超限 / 不收敛| B[Decision Brief<br/>人工介入]
    B -->|继续开发| P
    B -->|接受交付| H
    H --> M[Merge]
    M --> D[Publish Hook / Release]

    classDef human fill:#312e81,stroke:#a5b4fc,color:#fff;
    classDef orchestrator fill:#4c1d95,stroke:#c4b5fd,color:#fff;
    classDef agent fill:#0f766e,stroke:#99f6e4,color:#fff;
    classDef gate fill:#9a3412,stroke:#fed7aa,color:#fff;
    classDef delivery fill:#14532d,stroke:#86efac,color:#fff;
    class U,H,B human;
    class P,I orchestrator;
    class A1,A2,A3 agent;
    class C,R,F,X gate;
    class M,D delivery;
```

这条流水线不是一串“聊天消息”。每个节点都有状态、超时、预算、产物和审计事件；每个并行 Agent 的失败都会被保留为可见产物，而不是从界面消失。

### 选择最合适的模型组合

- 在任务或 Story 模板中分别选择 Developer 与 Reviewer 的 provider/model。
- 目录只展示管理员允许、Pi 可解析、且当前用户已配置凭据的模型。
- 服务端在入队前校验模型与凭据，并把选择固化到任务记录。
- 支持 DeepSeek、OpenAI 以及通过模型目录接入的 Pi 兼容 provider。
- 凭据按用户保存在加密 Vault；Web 服务不把明文密钥写入任务记录。

### 实际界面

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/pigo-multi-agent.png" alt="三个并行开发 Agent" /></td>
    <td width="50%"><img src="docs/assets/screenshots/pigo-review-loop.png" alt="独立 Reviewer 退回开发 Agent" /></td>
  </tr>
  <tr>
    <td align="center"><strong>并行开发</strong><br/>Planner 分工，多个 Agent 同时推进</td>
    <td align="center"><strong>独立审核</strong><br/>Reviewer 退回问题，开发带证据返修</td>
  </tr>
</table>

> 两张截图均由当前代码在本地启动后，以内置演示数据实拍；不包含生产凭据或生产数据。

### 快速开始

前置条件：Node.js 22.19+、npm、Docker Compose。

```bash
npm install
cp .env.example .env
docker compose -f deploy/docker/compose.yaml --env-file .env up -d --build
```

打开 <http://127.0.0.1:3100>。样例配置默认启用本地开发认证与 Demo 模式；在对外开放前，必须替换 `.env` 中的演示密码和 Vault 密钥，并配置生产认证。

本地开发：

```bash
npm run dev
```

### 验证与验收

```bash
# 日常开发门禁：无真库时会明确 SKIP 真库并发检查
npm run gate:release

# 严格验收：需要真实 PostgreSQL 和已经运行的 Web 地址
PI_DATABASE_URL='postgresql://user:pass@host:5432/pigo' \
PI_E2E_BASE_URL='http://127.0.0.1:3100' \
npm run gate:acceptance
```

当前仓库基线为 **v0.26.4 / 905 个自动化测试**。严格门禁覆盖类型检查、单元测试、脚本测试、lint、构建、Compose 配置、敏感信息扫描、PostgreSQL 并发检查和 Playwright 浏览器测试。生产专用场景仍需在真实身份系统与模型凭据环境中执行。

### 代码结构

```text
src/client/          React 控制台：运行拓扑、敏捷、工作区、模型、账户与系统状态
src/server/          API、认证、队列、PostgreSQL 存储、模型目录、发布与审计
src/worker/          Pi Agent 编排、并行开发、集成、检查与 Reviewer 闭环
src/shared/          前后端共享的领域模型和纯决策逻辑
deploy/docker/       Compose、隔离 Worker 镜像、沙箱和部署校验
scripts/             发布门禁、真库并发、演练、回滚与敏感信息扫描
tests/e2e/           Playwright 端到端验收
docs/                产品规格、验收矩阵、架构决策和诊断报告
```

### 工作区、认证与发布边界

- 工作区是**服务器受控的 Git 目录**：可以创建或克隆项目，并为每次 Run 生成隔离 worktree；浏览器不能直接读取用户电脑上的任意目录。
- 生产环境可接入 Cloudflare Access 邮件验证码身份；本地开发使用明确标记的 development 模式。
- 真实 Run 不会默认自动推送或发布。Reviewer 通过后仍需 Human Gate；合并与 Publish Hook 都是显式动作，并留下审计记录。
- `docs/18-pigo-node-design.md` 描述了未来让本机目录安全接入服务端的 PiGO Node 方案，当前不是已交付能力。

### 当前审核结论

仓库已通过 v0.26.4 的自动化发布门禁和本地真库验收。验收进程退出后的清理阶段又复现了一个门禁未捕获的取消竞态；当前有三个事项应在生产验收前处理：

1. 取消仍在执行的 Demo Run 时存在状态竞态，异常分支可能再次写入 `failed`，导致 Web 进程因 `cancelled → failed` 非法迁移而退出。
2. Decision Brief 的“改动范围”门禁尚未持久化业务允许路径；目前只能可靠拦截生成物和脏文件。
3. Decision Brief 在所有终态都会展开并显示动作按钮，前端应按状态限制“继续开发 / 接受交付”，避免对已完成或已取消任务发出无效请求。

完整证据与文件定位见 [v0.26.4 代码审核与验收报告](docs/23-code-review-v0.26.4.md)。

### 进一步阅读

- [部署与环境配置](docs/01-deployment-and-configuration.md)
- [开发设计](docs/02-development-design.md)
- [产品开发规格](docs/04-product-development-specification.md)
- [验收规格与交付清单](docs/05-acceptance-test-specification.md)
- [敏捷领域模型](docs/14-agile-domain-model.md)
- [发布、阻塞管理与恢复](docs/19-release-publish-and-blocked-management.md)
- [审核收敛与输入预算](docs/20-review-convergence-and-input-budget.md)
- [审核性能诊断](docs/21-review-performance-diagnosis.md)
- [Decision Brief 设计](docs/22-decision-brief.md)

---

<a id="english"></a>

## English

PiGO is a multi-model, multi-agent software delivery workspace powered by [Pi](https://github.com/earendil-works/pi). It turns one engineering request into an observable and recoverable workflow: a Planner sizes and partitions the work, developer agents implement in isolated branches, an Integrator assembles their changes, deterministic checks run first, and an independent Reviewer either approves the result or sends structured findings into the next repair round.

You choose both sides of the loop: one provider/model for development and another for review. A common setup uses DeepSeek for high-throughput implementation and OpenAI for independent review, but the catalog supports other Pi-compatible providers. If the selected model is unavailable, the run fails explicitly—there is no silent fallback.

### What makes PiGO different

| Capability | How PiGO handles it |
| --- | --- |
| **Real multi-agent execution** | The Planner can fan work out to `PI_MAX_SUBAGENTS` developer agents (3 by default), each with its own responsibility, branch and event stream. |
| **Independent model roles** | Developer and Reviewer provider/model choices are frozen per run. Review happens against a disposable read-only snapshot. |
| **Fast, bounded review** | Pi keeps agent execution lightweight, while diff budgets, finding fingerprints and convergence rules reduce repeated context and unproductive loops. |
| **Engineering gates first** | Type checks, lint and tests run before model review. Failures return directly to development with structured context. |
| **Visible by design** | Live SSE views expose topology, conversations, diffs, checks, usage, retries and review decisions. A Decision Brief explains why a run stopped. |
| **Agile delivery, not isolated chat** | Project → Sprint → Story → Run → Release connects agent work to templates, acceptance criteria, human approval, merge and explicit publish hooks. |

### The delivery loop

The diagram above is the core contract: planning fans out, integration fans in, deterministic checks precede independent review, and every rejection carries evidence back into development. Repeated findings are fingerprinted, review input is bounded, and non-converging runs stop for a human decision instead of looping forever.

### Model routing

- Pick a Developer and Reviewer provider/model independently for a Run or Story template.
- The catalog only exposes administrator-allowed models that Pi can resolve and for which the current user has credentials.
- The server validates the selection before enqueueing and records it with the run.
- User credentials are kept in an encrypted vault and are not stored as plaintext in run records.

### Quick start

Requirements: Node.js 22.19+, npm and Docker Compose.

```bash
npm install
cp .env.example .env
docker compose -f deploy/docker/compose.yaml --env-file .env up -d --build
```

Open <http://127.0.0.1:3100>. The example configuration uses development authentication and Demo mode. Replace every demo password and vault secret, then configure production authentication before exposing the service.

For local development:

```bash
npm run dev
```

### Verification

```bash
npm run gate:release

PI_DATABASE_URL='postgresql://user:pass@host:5432/pigo' \
PI_E2E_BASE_URL='http://127.0.0.1:3100' \
npm run gate:acceptance
```

The current baseline is **v0.26.4 with 905 automated tests**. The strict gate covers type checking, unit and script tests, lint, build, Compose validation, secret scanning, PostgreSQL concurrency and Playwright browser tests. Production-only cases must still be exercised with the real identity provider and model credentials.

### Repository map

```text
src/client/          React console and operational views
src/server/          API, auth, queue, PostgreSQL, model catalog, release and audit
src/worker/          Pi orchestration, parallel development, integration and review loop
src/shared/          Shared domain types and deterministic decision logic
deploy/docker/       Compose deployment and isolated worker sandbox
scripts/             Release gates, drills, rollback and secret scanning
tests/e2e/           Playwright acceptance tests
docs/                Product, architecture, acceptance and diagnostic documents
```

### Operational boundaries

- A workspace is a **server-controlled Git directory**. PiGO can create or clone repositories and makes an isolated worktree for every run; a web page cannot directly mount an arbitrary directory from an end user's computer.
- Production can use Cloudflare Access email verification; local development uses an explicitly marked development mode.
- A successful review does not silently push or publish code. Human approval, merge and publish hooks are explicit, audited actions.
- `docs/18-pigo-node-design.md` is the future design for safely connecting local desktop folders; it is not an implemented feature yet.

### Review status

The v0.26.4 release gate and local PostgreSQL-backed acceptance suite pass. During post-suite cleanup, a cancellation race not covered by the gate was reproduced. Three items remain before production sign-off:

1. Cancelling an active Demo Run can race its background transition; the error path may then attempt `cancelled → failed` and terminate the Web process with an unhandled state-transition error.
2. Decision Brief does not yet persist business-specific allowed paths, so its scope gate can currently guarantee generated/dirty-file exclusion but not full requirement-level scope.
3. Decision Brief action buttons should be state-gated so completed, failed or cancelled runs cannot issue invalid continue/accept requests.

See the [v0.26.4 code review and acceptance report](docs/23-code-review-v0.26.4.md) for evidence and exact file locations.

### Documentation

- [Deployment and configuration](docs/01-deployment-and-configuration.md)
- [Development design](docs/02-development-design.md)
- [Product specification](docs/04-product-development-specification.md)
- [Acceptance specification](docs/05-acceptance-test-specification.md)
- [Agile domain model](docs/14-agile-domain-model.md)
- [Release, blocked-run management and recovery](docs/19-release-publish-and-blocked-management.md)
- [Review convergence and input budget](docs/20-review-convergence-and-input-budget.md)
- [Review performance diagnosis](docs/21-review-performance-diagnosis.md)
- [Decision Brief design](docs/22-decision-brief.md)

---

PiGO is designed for teams that want the speed of coding agents without giving up engineering gates, independent review or human control.
