# Pi 多模型开发审核平台

本仓库包含可运行的 Pi 开发审核平台，以及面向多模型路由的部署和二次开发文档。当前实现基于开源 [Pi](https://github.com/earendil-works/pi)：

- 安装和部署 Pi；
- 接入 DeepSeek、OpenAI 以及其他 Pi 兼容模型；
- 用户可从管理员允许且已配置凭据的模型目录中，分别指定开发 Agent 和审核 Agent 使用的 provider/model；
- 审核不通过时自动把结构化问题返给开发 Agent，修复后再次审核；
- 用流程图、日志、Diff、测试结果和审核结果展示完整闭环；
- 从服务器受控项目目录选择 Git 仓库，每个任务创建独立 worktree 保存代码。

## 推荐实现

```mermaid
flowchart LR
    U[用户任务] --> P[准备独立 Git 工作区]
    P --> D[开发 Agent\n用户指定 provider/model]
    D --> T[确定性测试/静态检查]
    T --> R[审核 Agent\n用户指定 provider/model]
    R -->|approved| S[完成/等待人工合并]
    R -->|changes_requested| D
    T -->|失败| D
    R -->|达到轮次上限| H[人工介入]
```

当前可运行版本采用 Pi CLI JSON 事件模式，以独立 Worker 调用开发与审核会话；架构文档同时保留后续迁移到 SDK/RPC 常驻会话的生产路线。

## 当前能力

- React 图形化控制台与 SSE 实时事件；
- 演示模式，可在不调用模型时验证完整 UI；
- 真实模式：DeepSeek 修改代码，检查命令通过后由 `gpt-5.6-sol` 只读审核；
- 审核或检查失败会自动退回开发 Agent，默认最多三轮；
- 源项目放在宿主机 `/app/pi-agent/workspace/projects/<项目名>`；
- 结果保存在 `/app/pi-agent/workspace/runs/<run-id>` 对应的 Git worktree；
- Web 服务不持有模型密钥，密钥仅注入隔离 Worker。

## 新增产品需求：按角色选择模型

目标版本不再把 DeepSeek/OpenAI 固定写死为开发与审核角色。新建真实任务时，用户必须能够独立选择：

- 开发 Agent 的 provider 和 model；
- 审核 Agent 的 provider 和 model；
- 两个角色可选择不同模型，也允许在策略许可时选择同一模型；
- 页面只展示管理员允许、Pi 运行时可解析、且当前用户已配置凭据的模型；
- 服务端在任务入队前执行模型与凭据预检，并把本次选择固化到任务记录；
- 指定模型不可用时明确失败，不允许静默切换到其他模型。

当前 `v0.3.0` 仍由环境变量固定开发与审核模型，上述能力属于下一阶段待实现范围。

真实模式不会自动提交、推送、合并或部署代码。人工确认结果后，再从任务 worktree 进行后续 Git 操作。

## 文档

- [安装部署与环境配置](docs/01-deployment-and-configuration.md)
- [应用开发设计](docs/02-development-design.md)
- [192.168.2.235 部署记录](docs/03-deployment-record-192.168.2.235.md)
- [完整开发规格说明书](docs/04-product-development-specification.md)
- [验收测试规格与交付清单](docs/05-acceptance-test-specification.md)
- [2026-10-04 代码审核与验收准入报告](docs/06-code-review-acceptance-report.md)
- [141 条验收用例代码证据矩阵](docs/07-acceptance-code-evidence.md)
- [v0.20.2 最新代码审核与验收准入报告](docs/08-code-review-acceptance-report-v0.20.2.md)
- [发布门禁与可靠性演练工具](docs/09-release-gate-and-drills.md)
- [闭环与审批自动化](docs/10-closure-approval-automation.md)
- [系统状态仪表盘](docs/11-system-status-dashboard.md)
- [工作流配置样例](config/workflow.example.yaml)
- [环境变量样例](.env.example)

## 本地验证

```bash
npm install
npm run typecheck
npm test
npm run lint          # 0 errors / 0 warnings
npm run build
npm run validate:compose   # 结构校验 + v0.22 标准 Compose 配置覆盖
npm run test:config        # 仅配置覆盖（也可 npm run validate:compose）
```

发布/验收门禁（详见 [docs/09](docs/09-release-gate-and-drills.md)）：

| 命令 | 用途 | 缺失前置条件 / lint warning |
| --- | --- | --- |
| `npm run gate:release` | 日常开发自检（宽松） | 真库检查记 SKIP；warning 不阻断 |
| `npm run gate:acceptance` | 验收（严格） | 一律 **FAIL**；要求 lint 0 warning、真库与 Playwright 实跑 |

```bash
# 验收：必须提供真库连接串与已运行的部署地址
PI_DATABASE_URL='postgresql://user:pass@host:5432/pigo' \
PI_E2E_BASE_URL='http://127.0.0.1:3100' \
npm run gate:acceptance
```

`gate:acceptance` 在本地无真库 / 无部署地址时会**如期失败**，属预期；本地开发自检请用 `gate:release`。

## 边界说明

“ChatGPT 审核”在服务端落地时应理解为“通过 OpenAI API 调用 OpenAI 模型”。ChatGPT Plus/Pro 订阅与 OpenAI API 计费、密钥不是同一项产品。Pi 的交互式 `/login` 可连接支持的订阅，但无人值守服务应使用项目级 `OPENAI_API_KEY`。

本方案以 2026-10-03 的 Pi 官方仓库为基线。早期教程中的包名 `@mariozechner/pi-coding-agent` 已不是当前官方仓库 README 推荐的名称；新项目使用 `@earendil-works/pi-coding-agent`。
