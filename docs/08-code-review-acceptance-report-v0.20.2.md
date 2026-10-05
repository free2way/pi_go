# PiGO v0.20.2 最新代码审核与验收准入报告

日期：2026-10-04（Asia/Shanghai）

审核版本：`pigo-web 0.20.2`

审核提交：`f71af158d50970c0276434241cfff112bd3d8a90`

对照基线：`docs/04-product-development-specification.md`、`docs/05-acceptance-test-specification.md`

最终结论：**不通过，不能签署验收文档。**

## 1. 执行摘要

v0.20.2 已经补齐工作区、多模型选择、严格模型目录、凭据探测、持久任务、预算、审批、制品、清理接口、只读 Reviewer 快照、插件 allowlist、浏览器 E2E 框架等大量能力。上一轮 v0.15.2 的多数直接缺陷已经修复或明显收敛，常规质量检查也通过。

但是，验收规格要求 P0 100% 通过、无 S0/S1、三次真实 provider 闭环、真实并行 Sub Agent、Worker 恢复、插件篡改检测、安全扫描、备份恢复、回滚演练和完整签字。当前代码仍有可复现的安全及一致性阻断项，且仓库部署记录只确认生产当前为 v0.20.1，未证明本次审核的 v0.20.2 已部署并完成全套验收。

因此，本报告只能批准继续整改和分项测试，不能把“196 项单测通过”转换为产品验收通过。

## 2. 本轮验证范围与结果

| 项目 | 结果 | 边界 |

| --- | --- | --- |
| `npm test` | 通过：32 个测试文件、196 项测试 | 只执行一次；规格要求连续两次 |
| `npm run typecheck` | 通过 | 静态类型检查 |
| `npm run lint` | 通过但有 2 个 warning | 0 error；两个未使用符号 |
| `npm run build` | 通过 | Vite 前端和服务端 bundle 成功 |
| `npm run validate:compose` | 通过 | 仅验证 Compose 结构，不等于启动/恢复/回滚演练 |
| `npx playwright test --list` | 成功列出 7 项 | 只证明套件可发现，没有启动浏览器执行 |
| 定向反例探针 | 8 类问题得到复现 | 仅使用临时仓库、假标记、假凭据和内存 PostgreSQL 兼容测试库 |
| 生产/Cloudflare/真实模型 | 本轮未执行 | 没有读取或使用用户提供的生产密码，没有产生真实模型费用 |

定向探针保存在本机临时目录 `/private/tmp/pigo-latest-audit.Bz3vRm/`。临时目录不是长期验收制品；关键输入与观察结果已固化在本报告中。

## 3. 阻断验收的代码问题

以下“P0/P1”是整改优先级。对应验收缺陷等级由负责人最终确认；按验收规格定义，凭据泄露风险应按候选 S0 处理，错误完成、无法恢复及核心流程不一致应按候选 S1 处理。

### NEW-01 · P0 · 仓库 Git filter 可在 Worker 宿主上下文执行

位置：`src/worker/index.ts:572`、`src/worker/review-snapshot.ts:58`。

Git 命令虽然禁用了 hooks、credential helper、fsmonitor 和 file protocol，但没有禁用仓库本地 `filter.*`。Reviewer 快照执行 `git add -A`，会触发 `.gitattributes` 指定的 clean/process filter；该实现还在 `defaultGitExec` 中完整继承 `process.env`。

临时仓库反例把 `filter.audit.clean` 配成无害脚本，随后调用生产 `createGitReviewSnapshotMaterializer()`。脚本在沙箱外成功读取假 Worker 环境标记 `DUMMY_WORKER_SECRET_NOT_A_REAL_KEY`。这证明“不可信仓库内容不能在 Worker 上下文执行”的安全边界不成立。没有使用或证明任何生产凭据已经泄露。

影响：AT-PI-008、AT-SEC-007/010、AT-GIT-003、E2E-08。发布阻断。

整改要求：平台 Git 操作必须在无敏感环境、无 Docker socket 权限的隔离进程中完成；禁用或严格清空 filter、diff、merge、fsmonitor 等可执行配置，不能只补一个已知键；加入恶意 `.git/config` + `.gitattributes` 回归测试。

### NEW-02 · P0 · Reviewer 快照可能遗漏交付文件，但 tree 校验仍报告一致

位置：`src/worker/review-snapshot.ts:109`、`src/worker/review-snapshot.ts:122`、`src/worker/review-snapshot.ts:125`。

实现先把开发目录写成 Git tree，再通过 `git archive` 解压为 Reviewer 目录；但 `git archive` 会遵从 `export-ignore`/`export-subst`。`snapshotTreeHash` 却不是对解压后的目录重新计算，而是再次读取原 commit 的 tree。

临时仓库反例把 `hidden.ts` 标为 `export-ignore`。结果源目录存在该文件，Reviewer 快照中不存在，`evaluateSnapshotDivergence()` 仍返回 `divergent: false`。Reviewer 因而可能批准一个不包含完整交付内容的视图。

影响：AT-REVIEW-012、AT-GIT-005、AT-SEC-009、E2E-03/08。发布阻断。

整改要求：不要用会应用 export 属性的 archive 作为安全快照，或对实际物化目录建立独立规范化 manifest/hash 并逐文件核对；测试 `export-ignore`、`export-subst`、symlink、submodule 和大小写冲突。

### NEW-03 · P0 · 检查/审核内容哈希既会漏报，也会无修改漂移

位置：`src/worker/index.ts:210`、`src/worker/index.ts:1703`、`src/worker/index.ts:1718`、`src/worker/index.ts:1751`。

`snapshotHash()` 使用 `HEAD + git stash create + status --porcelain`。它不是稳定的内容哈希：

- 对 intent-to-add 的未跟踪文件，`stash create` 可以失败并被吞掉，status 只记录文件名；修改文件内容后得到相同 hash。本轮反例已复现。
- 对完全相同的已跟踪脏内容，两次 `stash create` 会生成不同的 commit 标识；等待 1.2 秒后 hash 不同。本轮反例已复现。

因此，完成守卫既可能接受检查后已经改变的内容，也可能错误阻断没有变化的内容。检查点的 `StoredChecks`/`StoredReview` 也没有保存其输入 tree hash；恢复时只按 `checks:<round>`、`review:<round>` 复用结果。

影响：AT-REVIEW-004/012、AT-GIT-005、AT-REL-002/003、E2E-03。发布阻断。

整改要求：使用 scratch index 得到稳定 tree OID，并把该 OID 写入每个 checks/review checkpoint；恢复时必须重新计算并严格匹配，否则重跑检查和审核。

### NEW-04 · P0 · Worker 重启无法恢复处于执行状态的任务

位置：`src/worker/index.ts:1527`、`src/worker/index.ts:1572`、`src/server/run-store-pg.ts:16`。

Worker 抢回 started job 后一律调用 `update(..., "preparing", ...)`。状态机却不允许 `developing/checking/reviewing -> preparing`。使用真实 Worker 代码、本机假回调和临时仓库，模拟 `reviewing` 任务被重领，观察到：

```text
Illegal run state transition: reviewing -> preparing
最终状态：needs_human
事件：run.recovered -> run.storage_error
```

恢复在读取并复用检查点前就失败。部署记录中的 `[jobs] reclaimed ...` 只证明任务被领回，不能证明继续执行成功。

影响：AT-RUN-008/011、AT-REL-002/003/005、AT-OPS-007、E2E-06。属于“无法恢复”类发布阻断。

整改要求：为恢复定义显式状态转移或保持当前阶段；增加在 planning/developing/checking/reviewing 各阶段强杀 Worker 后的端到端恢复测试，必须验证模型调用不重复、检查点与 tree 绑定、最终状态正确。

### NEW-05 · P1 · 多 Web 实例可用过期缓存覆盖已取消的数据库状态

位置：`src/server/run-store-pg.ts:176`、`src/server/run-store-pg.ts:199`。

`updateRun()` 和 `applyDelivery()` 从实例缓存构造完整 document，再无条件 `UPDATE runs`；事务内没有 `SELECT ... FOR UPDATE`、版本列或按旧状态条件更新。即使路由 preHandler 会 hydrate，并发请求仍可能同时读取旧状态。

内存 PostgreSQL 兼容测试库的两实例反例：A、B 都缓存 `reviewing`；A 先写 `cancelled`；B 随后的 callback patch 仅包含 `modelCalls`，却把数据库状态写回 `reviewing`。终态保护只检查 B 的旧缓存，没有保护数据库中的最新终态。

影响：AT-RUN-006/014、AT-REL-004/005/007、AT-UI-007。发布阻断。

整改要求：在单事务内锁定并读取数据库当前行，验证状态/版本后再合并 patch；推荐使用单调 revision + compare-and-swap，并加入真实 PostgreSQL 双连接并发测试。

### NEW-06 · P1 · 同一 Run 的活锁可被第二个 Worker 立即接管

位置：`src/worker/workspace-lock.ts:114`、`src/worker/workspace-lock.ts:142`。

只要磁盘锁的 `runId` 相同，第二个 Worker 就假设前一个进程已死，不检查 heartbeat、workerId 或所有权 token，立即覆盖锁。两个仍存活的 manager 因而都返回 `acquired: true`。旧 handle 的 `release()` 只比 runId，随后还能删除新 Worker 的锁；本轮反例两项均复现。

影响：AT-RUN-012、AT-REL-002/004、AT-PERF-004/006。发布阻断。

整改要求：锁必须含不可复用的 lease/owner token；相同 runId 也只能在 heartbeat 过期后以原子 CAS 接管；touch/release 必须比较 token；增加双进程竞争与旧持有者迟到释放测试。

### NEW-07 · P1 · 3 MiB 以上 Diff 在回调层静默缩成 400,000 字符

位置：`src/worker/index.ts:470`、`src/worker/index.ts:480`。

Git diff 上限已提高到 3.4M，服务端 schema 也提高到 3.5M，但 callback body 上限仍是 3 MiB。超过时直接把 `patch.diff` 改为前 400,000 字符，没有截断标记，也没有先写完整制品。

反例输入 3,200,000 字符，编码后仅 400,000 字符且不含 `truncated`。终态 artifact 保存的是已截断的 Run diff，不能满足“完整可下载 Diff”。

影响：AT-GIT-004、AT-UI-005、AT-REL-007。发布阻断。

整改要求：制品应独立持久化/流式写入并以 artifact ID 回调；若只能截断展示文本，必须保留全量制品、hash、原始字节数和显式截断标记。

### NEW-08 · P1 · 模型调用次数预算不计算 provider 重试尝试

位置：`src/worker/index.ts:831`、`src/worker/provider-retry.ts:28`。

预算在进入 `withProviderRetry()` 前只 reserve 一次，内部最多实际调用 provider 六次，成功后仍只记录一次。反例设置 `maxModelCalls=1`，provider 前两次 503、第三次成功，实际尝试 3 次但 `modelCalls=1`、`usageUnknownCalls=0`。

这不一定能从失败响应获得 token 数，但“调用次数硬上限”已经被绕过，且失败尝试未标记为未知费用。

影响：AT-PERF-008/009、COST-002/003、E2E-07。发布阻断。

整改要求：每次 provider attempt 前独立预留和记账；失败 attempt 至少增加 modelCalls 与 unknown usage/cost 标志；达到硬上限后禁止下一次 retry。

## 4. 规格层面的未完成项

除上述反例外，以下验收要求仍不能确认：

- 插件 allowlist 只有类型、绝对路径和角色，没有版本、内容 hash、签名或运行前篡改检测，AT-PI-007、AT-SEC-014 不满足。
- `GET /models` 只能证明 Key 可以列模型，不能证明 Pi 实际工具调用、reasoning、context window 和角色兼容性；`PI_MODEL_PROBE_MODE=off` 还会把旧凭据标为“所有模型已验证”。完整 AT-MODEL-001/004/008 仍需真实探测用例。
- 同一个 `--session-id` 与保留 `.state` 目录已具备，但本轮没有 Pi Runtime 真实上下文延续/token 节省证据；AT-PI-001/002、AT-PERF-007 不能仅凭 argv 判通过。
- 失败 Sub Agent 只保留 8 KB 输出尾部，未保留其未提交代码成果，不满足 AT-AGENT-008 的“成果保留”。
- 连续重复严重 Finding 阈值尚未实现，只依赖最大审核轮次；AT-REVIEW-010 不满足。
- 当前浏览器套件只有 7 项，且本轮只执行了 `--list`；不能覆盖验收文档要求的 OTP、真实工作区、全错误路径、刷新/断网、移动端和 8 个完整 E2E 场景。
- 本轮没有当前提交的 secret scan、依赖漏洞扫描、真实 PostgreSQL 并发/恢复、三次真实 provider workflow、真实中型并行 Sub Agent、Cloudflare OTP、未授权邮箱拒绝、备份恢复或回滚演练。

## 5. 上一轮问题的复核状态

| 上一轮编号 | v0.20.2 状态 | 说明 |
| --- | --- | --- |
| AUD-01 | 部分修复，仍阻断 | 独立 clone、hooks 与环境清理已加；Git filter 仍可越过 Worker 边界，见 NEW-01 |
| AUD-02 | 代码层已修复 | 增加物理工作区归属/授权；仍需多用户 E2E |
| AUD-03 | 已修复 | approved 与阻断 finding 的协议/完成守卫已收敛 |
| AUD-04 | 部分修复，仍阻断 | retry-review 会重跑 checks；内容 hash 与检查点绑定仍错误，见 NEW-03 |
| AUD-05 | 首次排队问题已修复 | fresh job 不再误标 recovery；真正重启恢复出现 NEW-04 |
| AUD-06 | 代码层已修复 | DB 成功后才更新缓存，terminal write 有重试；多实例仍有 NEW-05 |
| AUD-07 | 部分修复 | `.state` 不再每次删除；真实 Pi 会话延续未验收 |
| AUD-08 | 部分修复 | 已有 live `/models` probe；能力级验证与 off 模式仍不足 |
| AUD-09 | 已修复 | 只校验所选角色 provider，可用同一 provider 服务两角色 |
| AUD-10 | 部分修复，仍阻断 | 并行预留和累计 usage 已加；provider retries 绕过调用次数，见 NEW-08 |
| AUD-11 | 代码层已修复 | Finding 使用 fingerprint/轮次合并；连续严重问题阈值仍缺 |
| AUD-12 | 已修复 | Compose 校验通过 |
| AUD-13 | 已修复 | 重复任务 ID 有界处理并有测试 |
| AUD-14 | 已修复 | 备份环境净化和测试已加；当前版本恢复演练仍未执行 |
| AUD-15 | 部分修复，仍阻断 | 状态机和原子 delivery 已加；多实例 stale cache 可覆盖终态，见 NEW-05 |
| AUD-16 | 未完全修复 | 大 Diff 在 callback 仍静默截断，见 NEW-07 |
| AUD-17 | 代码层已修复 | SSE 回放/订阅及客户端 seq 已改；仍需浏览器断网/慢响应实跑 |

## 6. 按验收域的准入判断

| 验收域 | 代码审核判断 | 是否可签字 |
| --- | --- | --- |
| AUTH | JWT/owner 隔离代码存在；当前 Cloudflare OTP 未实测 | 否，待运行确认 |
| WS | 工作区 UI、注册/clone、路径校验和归属已具备 | 否，需目标环境 E2E |
| MODEL | 多 provider、开发/审核独立选模已具备 | 否，能力探测和真实组合未闭环 |
| PI | Pi CLI、session 目录、插件 allowlist 已具备 | 否，NEW-01、插件完整性、会话证据阻断 |
| RUN | 流程、预算、审批、清理已具备 | 否，NEW-03/04/06/08 阻断 |
| AGENT | 自动拆分、并行 wave、合并已有实现 | 否，失败成果保留和真实并行验收缺失 |
| REVIEW | 检查、结构化审核、独立快照已有实现 | 否，NEW-02/03 阻断 |
| UI | 页面覆盖主要模块，已有 7 项 Playwright 用例 | 否，本轮未执行浏览器验收且覆盖不完整 |
| GIT | base SHA、独立 clone、diff artifact 已有实现 | 否，NEW-01/02/03/07 阻断 |
| SEC | vault、owner、Origin、限流、容器策略已具备 | 否，NEW-01 和插件篡改检测阻断 |
| REL | PostgreSQL、队列、checkpoint、delivery 已具备 | 否，NEW-04/05/06 阻断 |
| PERF | 预算/并发/超时有实现 | 否，NEW-08 且未做目标环境压测 |
| OPS | Compose、备份、告警、cleanup 已具备 | 否，v0.20.2 部署/恢复/回滚证据缺失 |

## 7. 进入验收前的最小整改顺序

1. 修复 NEW-01～03，重新定义可信 tree/snapshot 和 Worker Git 执行边界。
2. 修复 NEW-04～06，用真实 PostgreSQL + 两个 Web/Worker 进程执行 crash、cancel、lease 竞争测试。
3. 修复 NEW-07/08，补完整 artifact 与每次 provider attempt 预算记账。
4. 为插件增加内容 hash/版本锁定/运行前复验；为 checks/review checkpoint 增加 tree OID。
5. 把本轮所有反例加入仓库自动化，并连续执行两次完整套件。
6. 冻结 commit 与镜像 digest，在隔离验收环境执行 141 条用例、8 个 E2E 场景和安全/性能/运维测试。
7. 完成 Cloudflare OTP、三个真实 provider 工作流、真实中型并行 Sub Agent、Worker 强杀恢复、备份恢复和回滚演练。
8. 由产品、研发、测试、安全/运维四方依据 `docs/05` 模板签字。

## 8. 最终判定

当前推荐发布状态：**研发联调 / 验收前整改**。

不能勾选以下关键门禁：P0 100% 通过、无 S0/S1、真实并行闭环、Worker 重启恢复、预算硬上限、插件篡改检测、安全扫描、当前版本备份恢复/回滚、完整验收证据和签字。

在 NEW-01～08 和规格未完成项关闭前，v0.20.2 不能确认为满足验收文档要求，也不建议签为“有条件通过”。
