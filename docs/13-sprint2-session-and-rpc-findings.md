# 13 · Sprint 2：Pi 会话复用与 RPC 探测结论

> 目标：诚实回答 Sprint 2 的「长生命周期 RPC/SDK」能否用当前 pinned Pi CLI 实现；若不能，把
> **会话（session）** 这条能力用到极致、可度量、可 A/B，并保留未来接入 SDK 的传输层接缝。

## 1. 结论摘要

1. **当前 pinned 的 Pi CLI 没有 server / RPC / daemon / socket 模式。** 生产主机上 `pi --help`
   只暴露一次性调用的会话参数，没有「常驻进程 + 双向 RPC」入口。因此 Sprint 2 原定的
   「长生命周期 RPC/SDK」**无法**用这个 CLI 直接实现。
2. 诚实的路线是：**(a) 把 session 用到极致 → (b) 度量复用收益 → (c) 保留 transport 接缝**，
   等厂商提供 SDK/RPC 后再换传输层，其余代码不变。
3. 已经落地：`PiSessionTransport` / `createRpcTransport()` 接缝（`src/worker/pi-session.ts`）、
   每次调用的 `session.metrics` 事件与 `run.sessions` 汇总、只读复用报告
   `npm run report:sessions`、以及 A/B 开关 `PI_SESSION_REUSE`。

## 2. Spike 证据（`pi --help`，生产主机实测）

观测到的能力（会话相关）：

- `--session-id <id>`：给本次调用绑定一个具名会话 id；同一 id 再次调用即为**续用**该会话。
- 具名会话（named sessions）：会话以 id 命名，落在会话目录中。
- `PI_CODING_AGENT_SESSION_DIR`：会话持久化目录（容器里由 worker 挂载的 Pi 状态卷承载）。
- `--export`：导出会话记录。

**没有**观测到：`serve` / `server` / `daemon` / `rpc` / `--listen` / socket / 控制端口之类
的常驻模式；也没有「一个进程内多次往返」的入口。也就是说 CLI 是**一次调用一个进程**的模型。

> 说明：本节只记录 spike 在生产主机上实际看到的 CLI 表面。本文档不臆造未验证的 flag；
> 若厂商后续新增常驻/RPC 入口，应重新 spike 并更新本节。

worker 侧实际拼装的参数（`src/worker/index.ts` 的 `runPi`）是一次性调用的典型形态：

```
pi --mode json --no-approve --no-extensions --no-skills --no-prompt-templates \
   --provider <p> --model <m> --thinking <low|medium|high> \
   --tools <read,grep,find,ls | read,bash,edit,write,grep,find,ls> \
   [--session-id <id> | --no-session] -- <prompt>
```

即：**复用只体现为「下轮再传同一个 `--session-id`」**，进程本身仍然是每次新起的。

## 3. 传输层接缝（为未来 SDK 预留）

`src/worker/pi-session.ts` 定义了：

- `PiSessionTransport`：`invoke(plan, call)` 的最小接口，`kind: "cli" | "rpc"`。
- `createCliTransport()`：当前唯一接线，直接执行回调（spawn 一次 Pi CLI）。
- `createRpcTransport()`：**故意抛错**，错误信息指向 `createCliTransport()`。它存在的意义是
  让「未来换成长驻 RPC/SDK」有一个明确的落点，且不改变 `PiSessionManager`、指标发射与
  调用方的任何代码。

`CliSessionManager.execute()` 只做插桩：解析会话计划（`planPiSession`）→ 交给 transport →
把 `usage`/耗时/调用次数汇总成 `SessionMetrics`，发 `session.metrics` 事件并合并进
`run.sessions`。**换 transport 不需要动这一层。**

## 4. 会话当前语义（现状表）

| role | Pi 会话 | 是否续用 | 说明 |
| --- | --- | --- | --- |
| planner | 无（`--no-session`） | 从不 | 一次规划，天然无状态 |
| developer | `<run>-developer` | 第 2 轮起续用 | **跨修复轮复用实现上下文**（收益来源） |
| integrator | `<run>-integrator` | 第 2 轮起续用 | 同上 |
| sub-agent | `<run>-sub-<taskId>` | 第 2 轮起续用 | 每个子任务独立会话 |
| reviewer | 无（`--no-session`） | 从不 | **每轮独立**（独立审核的基本要求） |

- 「续用」由 `planPiSession({ role, run, round, retry, key })` 纯函数决定；
  协议重试（reviewer 的 `retry`）永远是新会话。
- 指标口径：`run.sessions` 是 `Run["usage"]` 同一批 token 的**细分视图**，不重复计入总量；
  `session.metrics` 事件额外携带该次调用的 provider 成本（`estimatedCost`），供报告按轮/角色归因。

## 5. 如何运行复用报告

```bash
# 方式 A：直连部署数据库（只读 SELECT，绝不打印连接串）
PI_DATABASE_URL=postgres://<user>:<pass>@<host>:5432/<db> npm run report:sessions

# 方式 B：查询运行中的 web 实例（开发身份走 x-pigo-dev-email 头）
PI_REPORT_BASE_URL=http://127.0.0.1:3100 PI_REPORT_EMAIL=developer@localhost npm run report:sessions
```

- **拒绝运行**：两种数据源都没有时脚本以退出码 1 退出，并说明需要设置哪个变量。
- 连接串只用于连接；banner 只打印 `数据库 @ 主机`（不含用户名/口令）。
- 纯聚合/格式化逻辑在 `scripts/session-reuse-lib.mjs`，单测 `scripts/session-reuse-lib.test.mjs`
  由 `npm run test:scripts`（`node --test`）运行（vitest 只收集 `src/**`）。
- 无数据时**退出码 0** 并打印明确说明，便于接入定时报表。

报告内容（每个「≥2 轮且存在会话指标」的 run）：

1. `round × role → sessionId / resumed? / durationMs / input·output·cacheRead·cacheWrite / cost` 明细表；
2. run 聚合：总 token、**cacheRead 占比**、总成本、**cost/round**；
3. **round-1 vs later** 对比：cacheRead 占比与 cost/round 的变化（含只统计 `resumed` 会话的口径）——
   即「复用到底省了多少」。

数据来源与降级：

- 优先使用 `session.metrics` 事件（可按轮拆分）；没有事件时退回 `run.sessions` 汇总
  （此时逐轮对比显示 `n/a`，而不是猜）。
- 成本优先用每次调用的 provider 上报值；若旧数据没有，则按 token 占比**分摊** run 的
  `usage.estimatedCost`，并在输出里显式标注 `allocate … by token share`（是估算，不冒充实测）。

## 6. A/B 开关 `PI_SESSION_REUSE`

- 默认 **on**（历史行为不变）。
- 仅 `off | 0 | false | no`（忽略大小写、去空白）会关闭；其它值（含未设置）保持开启。
- 关闭后：developer / integrator / sub-agent 的会话 id 变为**逐轮唯一**
  （`<run>-<key>-r<round>`），即每轮全新会话；planner / reviewer 语义不变。
- 该布尔值在 `src/worker/index.ts` 顶层读取一次并透传给 `planPiSession`（`reuse` 输入），
  不在深层调用点读环境变量；`sessionReuseEnabled()` 负责严格解析。
- Compose 已转发该变量（默认 `on`），见 `deploy/docker/compose.yaml` 与
  `scripts/compose-config-coverage.mjs` 的 worker 清单。

A/B 建议做法：在两次可比的 run 之间只改 `PI_SESSION_REUSE`，随后对不同批次跑
`npm run report:sessions`，比较 **cacheRead 占比** 与 **cost/round**（复用开启时后续轮次应明显
出现更高的 cacheRead 占比、更低的 cost/round）。

## 7. 开放问题

1. **厂商会提供哪种 Pi SDK / RPC？** 是「常驻进程 + 请求/响应通道」，还是「可嵌入的 SDK 库」？
   这决定 `createRpcTransport()` 是实现为进程内 SDK 适配器，还是连一个 socket/HTTP 端点。
2. **接入后哪些东西会变？** 预期只剩 `PiSessionTransport` 的实现：
   `planPiSession`（会话 id/续用决策）、`SessionMetrics`、`run.sessions` 与
   `session.metrics` 事件、报告与 `PI_SESSION_REUSE` 开关都可原样保留。
3. **多轮会话的上下文膨胀与截断策略**：长会话在修复轮不断累积上下文，需要在成本与「记得住」
   之间找平衡；报告正是为此提供 cacheRead 占比与 cost/round 的客观依据。
4. **会话目录的生命周期**：`PI_CODING_AGENT_SESSION_DIR` 随 run 状态卷清理 vs 保留用于审计，
   需要与 `run-cleanup` 策略一起定。
