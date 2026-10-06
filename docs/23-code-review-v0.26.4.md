# PiGO v0.26.4 代码审核与验收报告

审核日期：2026-10-06<br />
审核范围：当前仓库 `main` 分支、v0.26.4 代码、README 与本地 Docker/PostgreSQL 运行链路。

## 结论

**有条件通过。** 多模型路由、多 Agent 编排、独立 Reviewer、确定性检查、敏捷实体、人工审批与发布 Hook 的主链路已经形成；发布门禁和本地真库验收通过。以下两个产品级缺口不阻断本次仓库交付，但应在生产验收签字前关闭。

## 主要发现

### P1：Decision Brief 的业务范围门禁可能产生假绿

- 位置：`src/server/decision-brief.ts:184-193`
- 证据：服务端构造 Decision Brief 输入时固定传入 `allowedPaths: null`。
- 影响：`src/shared/decision-brief.ts` 的 scope gate 在缺少允许路径时，只检查生成物/脏文件。普通源文件即使超出 Story 约定范围，也可能显示为绿色。
- 建议：在 Run 或 Story 上持久化允许路径；创建任务时固化快照，并将其传入 Decision Brief。缺失业务范围时应显示 `unknown`，不能等价于完整范围通过。

### P2：终态 Decision Brief 的动作缺少前端状态约束

- 位置：`src/client/App.tsx:1163-1258`、`src/client/App.tsx:1829-1840`
- 证据：Decision Brief 在 `completed / needs_human / failed / cancelled` 终态都会展开，卡片始终渲染“继续开发”和“接受交付”。
- 影响：已完成、失败或取消的任务可能触发无效动作请求，并以弹窗错误反馈，造成状态语义混乱。
- 建议：仅在服务端允许的状态渲染动作；其他终态显示只读摘要。服务端继续保留状态校验作为最终保护。

## 本次随审核修正

1. 更新 `tests/e2e/errors.spec.ts`：详情子资源全部失败时，当前产品设计会回退到完整的 Run 列表快照；测试改为验证可恢复的任务壳层，而不是过时的欢迎页。
2. 补齐 `.env.example` 中 Compose 启动所需的 PostgreSQL 密码、Vault 密钥、认证模式、公开地址、绑定地址和多 Agent 并发参数，并使用明显的本地演示值。
3. 重写中英双语 README，加入多 Agent 逻辑图、真实运行截图、能力边界和验收入口。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| TypeScript typecheck | PASS |
| Vitest | PASS，93 个测试文件 / 905 个测试 |
| Script tests | PASS，36 / 36 |
| ESLint | PASS，0 error / 0 warning |
| Production build | PASS |
| Docker Compose validation | PASS |
| Secret scan | PASS |
| PostgreSQL concurrency check | PASS，19 / 19 |
| Playwright 浏览器验收 | PASS，17 passed / 9 个生产环境场景 skipped |

严格验收中的生产专用身份、真实 Provider 凭据与外部发布目标，需要在生产环境另行验证；本地通过不替代生产签字。

## 验收建议

- 仓库交付：**通过**。
- 多 Agent 主链路：**通过**。
- 生产上线：**有条件通过**，须完成 P1，并建议同步完成 P2。
- GitHub 同步：以本报告对应提交为基线；推送后应在远端 CI 再运行 `npm run gate:release`，生产候选环境运行 `npm run gate:acceptance`。
