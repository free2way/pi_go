# PiGO 代码审核与验收准入报告

> 历史报告：本文件审核基线为 v0.15.2。v0.20.2 的最新复核结论见 [v0.20.2 最新代码审核与验收准入报告](08-code-review-acceptance-report-v0.20.2.md)。

日期：2026-10-04（Asia/Shanghai）

审核版本：`pigo-web 0.15.2`

审核提交：`ac36b37cfda6865294ee1828f4aafcdca9859c68`

审核结论：**不具备完整验收通过条件；可以继续缺陷修复及分项测试。**

## 1. 结论与适用范围

本轮依据 [开发规格](04-product-development-specification.md) 和 [验收规格](05-acceptance-test-specification.md)，检查当前 Web、Worker、前端、数据库、部署文件、测试与既有部署记录，并执行本地自动化检查和隔离反例探针。

当前版本已有工作区页面、多模型选择、provider 凭据库、PostgreSQL、持久队列、检查点、容器执行和预算逻辑，明显超出最初 v0.3.0 的实现范围。可是，部分关键路径与其注释、部署记录及验收要求不一致；常规单元测试通过不足以支持最终签字。

**按原规格要求的 P0 100% 通过，目前不能确认通过，也不建议签为“有条件通过”。** 安全边界、检查/审核门槛、队列恢复和费用统计均存在可复现反例。

[完整 141 条代码证据矩阵](07-acceptance-code-evidence.md) 的分布：

| 结论 | 数量 | 含义 |
| --- | ---: | --- |
| 代码支持 | 33 | 对应逻辑或单测支持，但不等于完整验收已执行 |
| 部分实现 | 48 | 部分行为或证据缺失 |
| 不满足 | 42 | 有反例、缺少必需能力或直接违反标准 |
| 待运行确认 | 16 | 依赖外部配置、浏览器、真实模型或运维验证 |
| P1 未交付 | 2 | 本地 Node 与 PR 创建 |
| 合计 | 141 | P0 138 条、P1 3 条 |

移动端用例是第 3 条 P1，列为待运行确认。8 个 E2E 场景独立列于第 6 节。以上数字是代码审核分类，不能计算为产品验收通过率。

本轮没有重新连接生产服务器或 Cloudflare 控制台，不能据此断言当前生产 OTP、镜像内容或部署状态。既有部署记录仅作为历史证据；本轮未执行真实模型计费请求、浏览器验收、真实 PostgreSQL 恢复和生产故障注入。

## 2. 已执行验证

| 验证 | 结果与边界 |
| --- | --- |
| `npm test` | 21 个测试文件、93 个测试通过 |
| `npm run typecheck` | 通过 |
| `npm run build` | 前端和 Web 服务端构建通过 |
| Compose 离线解析 | 解析成功，但显示两个挂载条目错误地属于 `worker.group_add` |
| 定向探针 | 13 项，见下表；仅使用临时目录、内存测试数据库、假 Pi 和假密钥 |
| 本地 Worker 路径 | 启动真实 Worker 代码，回调使用本机测试服务；显式使用 process 模式验证编排逻辑 |
| Git hook 边界 | 在临时仓库复现共享 Git 元数据导致的执行上下文跨越；未运行生产容器攻击 |

定向探针的“复现”指反例成立，不是对应验收用例通过：

| 探针 | 观察结果 | 关联问题 |
| --- | --- | --- |
| approved + high finding | 协议解析仍返回 approved | AUD-03 |
| 两用户注册同一路径 | 两条不同 owner 记录指向同一 physical repository | AUD-02 |
| 静态模型预检 | 仅提供 configured provider 集合即获准，无 provider 请求 | AUD-08 |
| 数据库写入失败 | API 缓存 completed，数据库仍 queued | AUD-06 |
| 非法终态跳转 | cancelled → completed 被接受 | AUD-15 |
| 同一 Finding ID 复现 | 数据库错误码 23505 | AUD-11 |
| 共享 .git hook | 后续 Git commit 的 hook 可读到假 Worker 环境标记 | AUD-01 |
| 重复 32 字符任务 ID | 子进程 1.5 秒超时，被 SIGTERM 结束；未返回 | AUD-13 |
| 重试审核 | checks=failed，但 Run=completed；费用 0.006 → 0.003，modelCalls 未增加 | AUD-04 / AUD-10 |
| 从未启动任务的 recovery | 因“任务 worktree 不存在”进入 needs_human | AUD-05 |
| 并行调用预算 | 上限 2，实际记录 planner 1 + sub-agent 2 = 3 次 | AUD-10 |
| Compose 配置 | group_add 包含两个卷字符串，volumes 缺少它们 | AUD-12 |
| 备份脱敏正则 | 带假口令的 PI_DATABASE_URL 原样保留 | AUD-14 |

探针文件和结果留在本机 `/private/tmp/pigo-code-audit.7evjeu/`；该目录是临时证据，不应作为长期验收档案。反例输入、结果和源代码位置已记入本文，后续修复应把相应场景纳入仓库回归测试。

## 3. 阻断性代码问题

以下 P0/P1/P2 是修复优先级，和原规格中的“用例 P0/P1”不是同一概念。安全漏洞的最终 S0/S1 定级应由安全负责人结合部署边界确认；本轮未发现或声称生产密钥已经泄露。

<a id="aud-01"></a>

### AUD-01 · P0 · 共享可写 Git 元数据使沙箱代码能在 Worker 中执行

位置：[sandbox.ts:51](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/sandbox.ts:51)、[worker/index.ts:349](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:349)、[worker/index.ts:753](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:753)。

沙箱把源仓库整个 `.git` 以 rw 挂入。Developer 有 bash/write，可以修改共享 hooks 或 Git 配置。子 Agent 返回后，Worker 在容器外执行 `git commit`；Git 命令默认继承 Worker 环境，没有禁止 hooks，也没有隔离仓库配置。

复现：只在临时仓库的共享 `.git/hooks/pre-commit` 写入读取假环境标记的 hook，随后执行与 Worker 相同形式的 commit，成功读取到 `DUMMY_AUDIT_SENTINEL`。这证明可写 Git 元数据可以跨越执行边界；生产 Worker 持有内部 token 和 Docker socket，影响可能扩大到其他任务或宿主机。

同一挂载还允许直接修改源仓库 refs/config，单靠提示词“不要修改其他内容”不能满足隔离要求。Agent 进程自身 provider Key 位于环境中且可用 bash 读取，Agent 网络也没有目的地 allowlist。

建议：使用独立克隆或受控 Git 服务，禁止把平台随后会执行的 hooks/config 作为不可信代码的可写共享状态；平台 Git 操作显式关闭 hooks、清洗环境和配置，并限制 Docker 控制权限。provider 凭据应由受控模型出口持有。修复后执行恶意仓库端到端隔离测试。

影响：AT-PI-008、AT-SEC-007/010、E2E-08。

<a id="aud-02"></a>

### AUD-02 · P1 · 工作区归属仅约束数据库记录，用户可重新注册别人的目录

位置：[workspaces.ts:98](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/workspaces.ts:98)、[workspaces.ts:157](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/workspaces.ts:157)、[server/index.ts:421](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/index.ts:421)。

注册只验证路径位于全局 projects root，随后按当前 owner 新建记录。唯一键是 owner/name，未检查 canonical path 已归属谁，也没有“该路径已授权给当前用户”的验证。`/api/projects` 还向任意已登录用户返回全局项目列表。

复现：A 和 B 分别注册 `private-project`，均成功，canonicalPath 相同。B 随后拥有自己的 workspace ID，可以以自己的凭据在 A 的源码上创建开发任务。

建议：服务器路径注册限管理员或基于明确路径授权；以 node + canonical repository identity 约束归属，并实现共享 ACL。删除或按用户过滤旧 projects API。

影响：WS-008、AT-WS-011、E2E-08。

<a id="aud-03"></a>

### AUD-03 · P1 · 审核协议允许 approved 携带阻断级 Finding

位置：[review-protocol.ts:31](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/review-protocol.ts:31)、[worker/index.ts:1245](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:1245)。

解析器只检查 verdict 枚举和 findings 数组，没有拒绝 approved + critical/high/medium。Worker 仅依据 verdict 进入 completed；prompt 中写出的限制没有对应代码保障。

复现输入为 `{verdict:"approved", findings:[{severity:"high", ...}]}`，解析成功。应在协议和最终状态守卫两层拒绝矛盾结果，并增加回归用例。

影响：AT-REVIEW-004/005、E2E-01/03。

<a id="aud-04"></a>

### AUD-04 · P1 · “重试审核”可绕过失败检查直接完成任务

位置：[server/index.ts:769](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/index.ts:769)、[worker/index.ts:1019](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:1019)。

任何 needs_human Run 都允许 retry-review。Worker 不要求最新检查通过，也不确认检查对应当前代码版本，就直接调用 Reviewer 并按 approved 完成。

复现：检查命令固定为 `false`，第一轮进入 needs_human；随后 retry-review 返回 approved，Run 变成 completed，而保存的 check 仍是 failed。人工编辑代码后，即便以前的检查通过，也没有内容 hash 绑定来证明结果仍有效。

建议：retry-review 只允许当前代码快照已通过全部必需检查的任务；否则先重新检查。completed 应有独立、不可绕过的检查与审核一致性守卫。

影响：AT-RUN-007、AT-REVIEW-004、CHECK-003。

<a id="aud-05"></a>

### AUD-05 · P1 · 首次排队任务被误判为恢复任务，人工恢复参数也会在重领中丢失

位置：[worker/index.ts:1366](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:1366)、[worker/index.ts:1098](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:1098)、[server/index.ts:879](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/index.ts:879)。

reclaim 对所有 pending job 一律传 recovery=true。容量不足而从未启动的 job 没有 worktree，因此不是正常开始，而是报不存在并转人工。dispatch 容量不足后 reservation 仍为 claimed，还需等待 stale 才能重领。

此外，持久 job payload 虽保存 resume/retryReview/instruction，pending API 只返回 checks，Worker 重领也不恢复这些字段。排队或崩溃会改变用户要求的执行动作。

本地真实 Worker + Fake Pi 复现：全新 queued Run 用当前重领参数执行，终态 needs_human，原因为 worktree 不存在。

建议：持久记录“尚未开始/已准备/需恢复”的执行阶段；首次队列执行创建 worktree，恢复执行才复用；完整保存并还原 job kind 和 payload，容量不足立即释放 reservation。

影响：AT-RUN-008/011、AT-PERF-006、AT-REL-002/005。

<a id="aud-06"></a>

### AUD-06 · P1 · 数据库提交失败仍污染可读缓存，失败收尾可能提前终结 job

位置：[run-store-pg.ts:103](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/run-store-pg.ts:103)、[worker/index.ts:1081](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:1081)、[worker/index.ts:1330](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:1330)。

updateRun 在事务成功前 Object.assign 修改缓存；create/delete 也先改缓存。事务失败不会回滚缓存，读取 API 又只读缓存。复现：注入事务错误后，getRun 显示 completed，数据库仍 queued。

Worker 的 terminalRecorded 初值为 true，失败重试循环没有先置 false。三次终态写入都失败后，finally 仍可能调用 finishJob；若存储恰在此时恢复，job 会结束而 Run 仍未持久到正确终态。

建议：事务成功后发布不可变缓存快照；Run patch、event、checkpoint/job 完成在明确事务边界内提交。只有确认终态落库后才允许终结 job，并添加故障注入测试。

影响：AT-REL-005/007，部署记录中“绝不会未完成却显示完成”的断言不能保留为已证实结论。

<a id="aud-07"></a>

### AUD-07 · P1 · 容器每次结束删除 session 状态，返修不能真正复用 Developer 会话

位置：[worker/index.ts:145](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:145)、[worker/index.ts:197](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:197)、[worker/index.ts:481](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:481)。

Pi 状态放在 `<worktree>.state`，runInSandbox 的 finally 每次调用都删除整个目录。下一次即便传同一 --session-id，已没有前一轮保存的上下文。检查容器同样使用并删除该目录。

当前实际仍为一次性 CLI JSON 调用，尚未实现目标要求的 SDK/长期 RPC。部署记录和 fake probe 只比较 session-id 参数，不能证明会话历史被加载或 token 得到节约。

建议：明确按 Run/角色维护持久 session 生命周期；只在任务明确清理时删状态；用第二轮能引用首轮未重复提供的信息来验证复用，而不只比较参数。

影响：AT-PI-001/002、AT-PERF-007、COST-004。

<a id="aud-08"></a>

### AUD-08 · P1 · 模型 preflight 实际仅检查静态目录和 Key 是否存在

位置：[model-catalog.ts:63](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/model-catalog.ts:63)、[model-catalog.ts:106](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/model-catalog.ts:106)、[server/index.ts:609](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/index.ts:609)。

凭据写入不验证；verifiedAt 永远初始化为 null。validateModelSelection 没有调用 Pi Runtime 或 provider，只确认静态 allowlist、角色和 configuredProviders。无效 Key、账号无权访问审核模型等错误会在开发已花费成本之后才出现。

loadModelCatalog 还会把管理员未允许的默认模型重新加入目录，并增加默认角色，破坏“allowlist 为上界”的策略。

建议：按凭据版本、provider/model 做精确 runtime 解析与有时效的能力/权限预检，失败阻止入队；配置错误应明确失败，不应扩大 allowlist。

影响：AT-MODEL-002/004/008、E2E-05。

<a id="aud-09"></a>

### AUD-09 · P1 · 合法模型组合仍被默认 DeepSeek/OpenAI 凭据门槛阻挡

位置：[server/index.ts:409](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/index.ts:409)、[App.tsx:255](/Volumes/STORAGE_Jackyhu/code/pi_go/src/client/App.tsx:255)、[App.tsx:320](/Volumes/STORAGE_Jackyhu/code/pi_go/src/client/App.tsx:320)。

realRunsAvailable 要求“默认开发 provider + 默认审核 provider”都有 Key。UI 据此禁用真实开发，并且不加载工作区/选模数据。

例如用户只配置支持双角色的 DeepSeek Chat，想用同模型开发和审核；API 角色规则允许，但 UI 仍要求默认 OpenAI provider Key。用户指定模型这一核心需求并未完整贯通。

建议：执行器可用性与模型组合可用性分离；允许进入真实任务表单，再根据实际所选组合计算阻断原因。

影响：AT-MODEL-006/007、AT-UI-002/003。

<a id="aud-10"></a>

### AUD-10 · P1 · 预算不覆盖并发、重试审核与累计恢复，usage 会倒退

位置：[worker/index.ts:553](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:553)、[worker/index.ts:1031](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:1031)、[worker/index.ts:1065](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:1065)。

主要反例：

- 并行 Agent 在调用前一起检查同一旧计数，没有原子预留；调用成功后才计数。上限 2 实测执行了 planner 1 + sub-agent 2。
- executeRetryReview 未传 budget，调用不受上限约束，也不累计 usageRoles/modelCalls。
- 每次 executeJob 都 emptyUsage、重设开始时间；恢复和人工继续不从持久 Run usage 累积。本地重试审核把累计费用 0.006 覆盖为 0.003。
- provider 自动重试包在计数内部，失败调用和部分已消费 token 没有可靠记账。
- 未提供费用时直接记 0，缺少“未知/估算”标识，不能把 0 解释为免费。
- 预算只在调用边界检查，没有完整 Run 时间上限；长调用/检查未由 Run 级 deadline 统一终止。

建议：用持久调用账本、调用前原子 reservation、实际 usage 对账和 Run 级 deadline；恢复不可重置累计值。预算配置应固化到 Run 并在页面可见。

影响：AT-PERF-008/009、COST-001～003。

<a id="aud-11"></a>

### AUD-11 · P1 · 同一 Finding ID 在第二轮重复时触发数据库主键冲突

位置：[review-findings.ts:4](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/review-findings.ts:4)、[run-store-pg.ts:457](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/run-store-pg.ts:457)、[db.ts:163](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/db.ts:163)。

mergeFindings 把所有旧问题标记 resolved 后追加新问题，不按 ID/fingerprint 合并。Reviewer 在第二轮继续报告相同 ID 属于正常情形；投影表主键是 run_id + finding_id，重复插入报 23505。

复现直接合并两轮 stable-finding 后 updateRun，确实报 23505。还会结合 AUD-06 留下无法持久的污染缓存。

建议：区分稳定 finding identity 与每轮 observation；按 fingerprint 更新状态，保留历史观察，不能自动宣称所有旧问题已解决。

影响：AT-REVIEW-009/010、E2E-03。

<a id="aud-12"></a>

### AUD-12 · P1 · 仓库 Compose 的两个挂载条目误放到 group_add

位置：[compose.yaml:152](/Volumes/STORAGE_Jackyhu/code/pi_go/deploy/docker/compose.yaml:152)。

`./pi-models.json:/home/node/.pi/agent/models.json:ro` 与 `pigo-worker-state:/home/node/.pi` 被缩进到 group_add，不属于 volumes。离线解析结果中 group_add 共三项，实际 volumes 只有 workspace 和 docker.sock。Docker 创建时会把挂载字符串当组名，且缺少预期挂载。

这是源码交付可复现的问题；不能由“之前服务器容器健康”推断当前仓库 Compose 可以全新部署。源码与服务器实际部署文件需要比对。

建议：修正层级并做全新容器 smoke；同步验证 sandbox 镜像构建入口、模型文件存在性及权限。生产应明确选择 container 模式，避免 auto 在 socket 不可用时静默回退为无文件系统隔离的 process。

影响：AT-OPS-001/007、AT-SEC-011。

<a id="aud-13"></a>

### AUD-13 · P1 · Planner 两个相同 32 字符任务 ID 会无限循环

位置：[orchestrator.ts:33](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/orchestrator.ts:33)。

去重追加后缀后再 slice(0,32)；原 ID 已长 32 时，后缀完全被截掉，while 条件永久为真。两个较长 ID 在 normalizeId 后同样可能碰撞。

输入两个 `"x".repeat(32)` 的任务，本地独立进程 1.5 秒仍不返回，超时终止。该函数同步运行在 Worker 主事件循环，会阻塞取消、健康检查与任务心跳。

建议：预留后缀长度、使用有限次去重或拒绝冲突 ID，添加边界回归测试。

影响：自动规划、AT-RUN-006、AT-PERF-005。

<a id="aud-14"></a>

### AUD-14 · P1 · 备份“脱敏环境”仍包含数据库口令

位置：[backup.sh:40](/Volumes/STORAGE_Jackyhu/code/pi_go/deploy/docker/backup.sh:40)、[compose.yaml:80](/Volumes/STORAGE_Jackyhu/code/pi_go/deploy/docker/compose.yaml:80)。

sed 只匹配 SECRET/TOKEN/PASSWORD/API_KEY 结尾变量；`PI_DATABASE_URL=postgresql://user:password@host/db` 不匹配，原样进入 web.env.sanitized。此文件没有 chmod 600，目录也没有显式私有 umask。

使用假口令执行同一正则后，URL 原样保留。未读取或披露生产备份内容，不能据此声称已有外部泄露。

建议：对白名单环境变量输出非敏感诊断，URL 解析后移除 userinfo；创建备份前设私有权限。检查既有备份的权限和脱敏副本。

影响：AT-SEC-001、AT-OPS-008。

<a id="aud-15"></a>

### AUD-15 · P1 · 状态更新没有转移守卫，deliveryId 不保护 patch

位置：[server/index.ts:840](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/index.ts:840)、[run-store-pg.ts:103](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/run-store-pg.ts:103)、[worker/index.ts:306](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:306)。

内部回调只验证字段类型。patch 先写入，event 后按 deliveryId 去重，二者没有原子事务。旧消息重投可回退状态/usage，而 event 因重复不再记录；真实 Worker postUpdate 根本没有提供 deliveryId。

复现 store 接受 cancelled → completed。取消请求和迟到模型回调发生竞争时，终态缺少保护。

建议：以 Run revision/job lease 和幂等键原子校验、提交 patch+event；所有入口使用同一状态机，终态不可被旧工作者覆盖。

影响：AT-RUN-014、AT-REL-004、AT-UI-007。

<a id="aud-16"></a>

### AUD-16 · P2 · Diff 在 Git 输出层被静默截尾，没有完整制品

位置：[worker/index.ts:360](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:360)、[worker/index.ts:543](/Volumes/STORAGE_Jackyhu/code/pi_go/src/worker/index.ts:543)。

通用 command 只保留 stdout 最后 48,000 字符，git diff 也走此函数。collectDiff 后续 slice(0,120000) 无法恢复前面已丢失的内容，甚至可能从半个 hunk 开始。数据库 artifact 仅保存此截断 diff 的长度/hash，没有全量文件。

建议：Git Diff 以流写完整 artifact，UI 明确预览截断并提供下载；审核按文件清单读取全量内容。

影响：AT-GIT-004、AT-UI-005。

<a id="aud-17"></a>

### AUD-17 · P2 · SSE 回放/订阅与前端快照存在竞态

位置：[server/index.ts:547](/Volumes/STORAGE_Jackyhu/code/pi_go/src/server/index.ts:547)、[App.tsx:544](/Volumes/STORAGE_Jackyhu/code/pi_go/src/client/App.tsx:544)。

服务端先分页回放再 subscribe，最后一页查询到订阅建立之间产生的事件可能丢失。客户端同时拉取初始快照与打开 SSE；较晚返回的初始 events 覆盖已经接收的事件，每条事件触发的 run 请求又不按 seq/revision 比较，慢旧响应能覆盖新状态。

服务端 replay 不处理 write 背压，客户端 events 数组也无限追加，不能由“分页查询”推出全链路内存有界。

建议：先订阅缓冲、再回放至确定 watermark 后去重接续；前端合并事件，按 revision 接受快照，取消过期请求并分页/虚拟化显示。

影响：AT-UI-006/007、AT-REL-008。

## 4. 仍缺少的目标能力

| 编号 | 缺口 | 主要证据 |
| --- | --- | --- |
| GAP-01 | 创建幂等键、独立验收条件、固定 base SHA、凭据版本、预算与 workflow/prompt/plugin 快照 | CreateRunInput/Run 无字段；baseRealRun 每次新 UUID；Worker 创建 worktree 用执行时 HEAD |
| GAP-02 | 受控 Pi Skills/Extensions/模板、版本/hash allowlist、角色启用与审计 | 所有调用 --no-extensions --no-skills --no-prompt-templates；没有受控启用服务 |
| GAP-03 | Reviewer 独立只读快照、tree hash 绑定、Finding fingerprint/连续问题阈值 | 当前 Reviewer 直接读取主 worktree；只有最大 round |
| GAP-04 | Approve、主 Run worktree 清理、完整 artifact、预算页、每 Agent session/usage | 无对应 API/数据模型；CheckResult 无 exitCode；删除后缺保留制品入口 |
| GAP-05 | 工作区级执行锁、失败 Sub Agent 成果保留 | 仅全局容量；失败子任务 finally 强制清理 worktree，默认删除分支 |
| GAP-06 | 全链路脱敏与有界输出 | Diff/check 输出直接入库；runInSandbox stdout/stderr 不限长 |
| GAP-07 | 本地 Node/daemon、PR 创建 | 属于 P1，未实现不独立阻断 v1.0 |
| GAP-08 | 冻结版本的完整证据和自动化交付 | 无 lint 命令；仓库无浏览器 E2E 测试套件；已有 fake Pi 工具不等于可重复执行的完整端到端测试 |

补充：入队前未保存 base SHA，因此任务排队期间源分支变化会改变本次开发基线；恢复时又用当前源 HEAD 求 merge-base，无法用稳定标识关联检查、审核和最终 Diff。

## 5. 对既有验收证据的校正

[部署记录](03-deployment-record-192.168.2.235.md) 包含有价值的历史 smoke 和演练信息，但下列描述需重新验证后才能作为签字证据：

- “同 session-id”只证明 argv 相同；不能证明被删除的 session 仍可复用（AUD-07）。
- “存储失败绝不会显示完成”与缓存先更新的反例冲突（AUD-06）。
- “Key 已配置”不等于 Key、model、账号权限预检通过（AUD-08）。
- “全部插件禁用”不能覆盖批准插件启用、版本固定和篡改检测（GAP-02）。
- “单个容器资源配置正确”不能覆盖三个真实 Agent 并行时的总资源和健康检查。
- “API 可读延迟/三接口响应时间”不能替代页面可见延迟和浏览器首次业务数据渲染。
- “正常路径预算通过”不能覆盖并行预留、恢复累积及 retry-review（AUD-10）。
- “磁盘/数据库备份成功”不能证明脱敏输出无密码，也不能替代当前版本恢复演练（AUD-14）。

原验收规格维持不变；本轮不把未执行用例填成通过。

## 6. 八个 E2E 场景的准入判断

| 场景 | 结论 | 原因 |
| --- | --- | --- |
| E2E-01 单 Agent 闭环 | 暂不能确认 | 需要实际 OTP/模型/浏览器证据，且缺 Approve，完成守卫有缺陷 |
| E2E-02 检查失败返修 | 部分路径成立 | 本地假模型证明检查失败不会走常规审核；session 复用不成立 |
| E2E-03 审核返修 | 阻断 | approved 协议和重复 Finding 落库问题 |
| E2E-04 并行 Sub Agent | 阻断 | Git 隔离、预算、Planner 边界缺陷；需真实模型并行集成证据 |
| E2E-05 Provider 故障预检 | 不满足 | 没有真实权限/能力 preflight |
| E2E-06 Worker 崩溃恢复 | 需修复后重验 | 已完成 checkpoint 路径存在，但首次排队、usage、终态持久化不可靠 |
| E2E-07 预算停止 | 不满足 | 并行和 retry-review 可绕过，恢复统计倒退 |
| E2E-08 恶意仓库隔离 | 不满足 | 共享 Git hook、物理目录授权和凭据/网络边界问题 |

## 7. 修复与重新验收顺序

1. **执行隔离与权限**：AUD-01/02/14；补同目录跨用户、恶意 hooks/config、凭据输出和网络隔离测试。
2. **禁止错误完成与数据不一致**：AUD-03/04/06/11/15；补失败检查重审、矛盾 verdict、重复 finding、事务失败与迟到回调测试。
3. **队列、并行与成本**：AUD-05/10/13；补首次等待、follow-up 恢复、并发预留、累计 usage、deadline 和恶意计划边界。
4. **Pi、多模型和交付配置**：AUD-07/08/09/12，加受控插件、Run 固定快照与审批制品能力。
5. **页面与大数据量**：AUD-16/17，补完整 Diff、断网恢复和慢响应乱序测试。
6. 冻结新提交与镜像，运行完整 141 条中 P0 用例；每个关键用例填写可追溯证据，再完成三次真实 provider 工作流、真实并行、备份恢复与回滚。
7. 按原验收报告模板由负责人签字。代码支持条目也必须执行其完整验收步骤，不能直接转换成通过。

## 8. 交付说明

本轮产出为代码审核报告和逐项证据矩阵，业务代码缺陷尚未修复。已完成原有测试、类型检查、构建和定向反例检查；测试中的假凭据不含任何实际账号秘密。

建议当前发布状态登记为：**研发联调 / 验收前整改**。当前结论依据上述可定位反例和缺口，不再用粗略完成百分比替代验收判断。
