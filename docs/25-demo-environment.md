# 25 · 演示 / 验收环境

`deploy/docker/compose.demo.yaml` 是一个**非生产**的可复现堆栈，用来替代过去手工
`docker run` 的 smoke 容器（`pigo-web-e2e`、`pigo-smoke-web`、`pigo-worker-fake`），
并用同一个 compose 工程驱动浏览器验收套件。

- 入口：`scripts/demo-env.sh {up|down|status|seed|doctor}`（逻辑在 `scripts/demo-env-lib.mjs`）。
- 配置：`deploy/docker/demo.env`（从 `deploy/docker/demo.env.example` 复制；**永不提交**）。
  推荐放在仓库**上一级** `../demo.env`，因为一次部署会把 `source/` 整目录替换掉。

## 与生产共享什么（有意为之）

1. **已有的 PostgreSQL 容器**（生产 compose 工程 `pi-agent`，网络 `pi-agent-network`）。
   演示栈不声明 `postgres` 服务，只加入该外部网络。
2. **宿主 Docker socket**，让 worker 像生产一样按调用创建 sandbox 容器。
3. **一个已存在的凭据保险库文件**（`credentials.v1.json`，v2），从不从仓库内容生成。

安全不变式（双重强制）：`PI_DATABASE_URL` 硬编码到 `pigo_demo`；`scripts/demo-env.sh up`
会先用 `docker compose config` 解析生效配置，只要任何 `*DATABASE_URL*` 不是以 `/pigo_demo`
结尾就**拒绝启动**（先打印解析结果，密码打码）。测试见 `scripts/demo-env.test.mjs`。

## 工作区目录与挂载（单一 `<root>:/workspace`）

工作区根目录由 `PIGO_DEMO_WORKSPACE_ROOT` 指定（宿主绝对路径）。**demo-web 与 demo-worker
都以完全相同的方式挂载它：把宿主根目录挂到容器 `/workspace`，且只挂这一次。**

| 宿主 | 容器 | 内容 |
| --- | --- | --- |
| `${PIGO_DEMO_WORKSPACE_ROOT}` | `/workspace` | 工作区根目录 |
| `${PIGO_DEMO_WORKSPACE_ROOT}/projects/<repo>` | `/workspace/projects/<repo>` | 每个已注册/克隆的仓库 |
| `${PIGO_DEMO_WORKSPACE_ROOT}/runs/<owner>/<run>` | `/workspace/runs/<owner>/<run>` | 每次运行的 worktree |

```
PIGO_DEMO_WORKSPACE_ROOT/
├── projects/          # 仓库（工作区）
│   └── <repo>/
└── runs/              # 每次运行一个隔离 worktree
    └── <owner>/<run>/
```

### 为什么不能有嵌套挂载

worker 固定使用 `PI_WORKSPACE_ROOT=/workspace`，并据此推导：

- 仓库路径 `/workspace/projects/<repo>` —— 这正是写入数据库 `workspaces.canonical_path`
  的值（`src/worker/index.ts` 的 `projectsRoot` / `verifyWorkspace`）；
- 运行目录 `/workspace/runs/...`；
- **sandbox 容器要绑定的宿主路径**：`hostPathFor(containerPath, "/workspace",
  PI_HOST_WORKSPACE_ROOT)`（`src/worker/sandbox.ts`）。

如果再加一条 `../..:/workspace/projects` 之类的嵌套 bind：

- 容器内的 `/workspace/projects` 会被**遮蔽**为宿主根目录本身，而不是
  `<root>/projects`；
- 于是 `canonical_path=/workspace/projects/<repo>` 会被解析到宿主 `<root>/<repo>`，
  与 worker 交给 sandbox 的宿主路径 `<root>/projects/<repo>` 不一致；
- 结果是：已有仓库“看起来”存在（web/worker 的容器视图能读到），但 sandbox 绑定到一个
  不存在的宿主目录，工作区被判为 invalid 或克隆/运行落到错误目录。

因此 compose 只允许每个服务拥有**恰好一个**工作区根挂载，target 必须正好是
`/workspace`，且不允许任何 target 位于 `/workspace/` 之下的挂载。该不变式由
`checkDemoCompose`（`scripts/demo-env-lib.mjs`）与
`scripts/demo-workspace-paths.test.mjs` 回归守护。

### 目录由谁创建

- **`scripts/demo-env.sh up`**：启动前在宿主上 `mkdir -p` `${PIGO_DEMO_WORKSPACE_ROOT}/projects`
  与 `${PIGO_DEMO_WORKSPACE_ROOT}/runs`（并打印路径）。
- **worker**：`prepareWorkspaceDirectory` 在“新建工作区”时会自行 `mkdir` projects 根目录；
  但 clone / register / verify 会以 projects 根目录作为 `git` 的 cwd，目录不存在即失败，
  所以 up 必须先建好。
- **权限**：worker 以镜像内的 `node` 用户（uid 1000）运行。工作区根目录及其
  `projects/`、`runs/` 必须对 uid 1000 可写；数据目录同理（`CredentialVault` 会把凭据文件
  chmod 到 0600）。

#### 目录所有者（双身份可写）与 `workspace-permissions` 检查

工作区目录有**两个**都必须可写的身份，缺一不可：

1. **worker（uid 1000 / gid 1000）**：镜像内的 `node` 用户，要创建仓库与运行 worktree；
2. **发起操作宿主的操作员**（`process.getuid()` / `process.getgid()`）：要能在宿主上管理、
   清理这棵目录树。

`doctor` 的 `workspace-permissions` 检查会对 `<root>`、`<root>/projects`、`<root>/runs`
逐一 `stat`，用两个身份分别判断可写性（POSIX：uid 匹配看 owner 位，否则 gid 匹配看 group
位，否则看 other 位；uid 0 视为可写；操作员恰好就是 uid/gid 1000 时只报一个身份，不重复报
错）。**目录缺失不算通过**——该检查会报 “cannot inspect …”，存在性由 `workspace-layout`
检查负责。

典型事故：容器以 uid 1000 创建了工作区目录（`uid 1000 gid 1000 mode 0755`），worker 能写，
但宿主操作员随后无法修改，只能手工修好。`workspace-permissions` 会 FAIL 并给出具体修复命令：

```sh
# 两个身份都可写的推荐状态（演示服务器最终采用）
chown -R <operator>:<operator> <PIGO_DEMO_WORKSPACE_ROOT>
chmod -R 777 <PIGO_DEMO_WORKSPACE_ROOT>
```

> 注意：只执行 `chown -R 1000:1000 <root>` **不够**——除非 mode 或 group 同时覆盖操作员，
> 否则操作员仍不可写。

## web 与 worker 的职责（web 不执行 Git）

所有工作区操作都由 **web 转发给 worker**：`src/server/workspaces.ts` 调用
`POST /workspaces/{verify,clone,create}`，具体实现在 `src/worker/index.ts`
（`verifyWorkspace` / `cloneWorkspace` / `createWorkspace`，内部 spawn `git`）。
web 进程没有任何工作区文件系统读取或 `git` 子进程——`src/server/**` 里唯一能起子进程的
是部署后的发布命令（`src/server/release-execution.ts`，`/bin/sh -c`），它不是工作区操作。

因此 **`deploy/docker/Dockerfile.web` 不安装 Git**（只有 `Dockerfile.worker` 需要）。
早期“工作区 invalid”的现象来自上面的挂载路径/权限问题，而不是 web 缺少 git。

> 若你使用 `kind=command` 的合并后发布钩子并让其中的命令调用 `git`，那属于该命令自身的
> 依赖：请在自定义镜像里自行安装，web 基础镜像不再提供。

## 决策平面（Jev）在演示环境的配置

决策平面（`src/server/decision-engine/**`，docs/26）默认 **`disabled`/`off`：零外发、
零行为变化**，生产不需要任何配置。演示环境把它打开成**确定性的 mock + shadow**，用于演示与
验收「决策只见证、不改判」的契约：

| 变量 | 演示值 | 含义 |
| --- | --- | --- |
| `PI_DECISION_ENGINE` | `mock` | 用确定性 mock 引擎（无网络）；`jev` 才调真实 TypeSafe API |
| `PI_JEV_MODE` | `shadow` | 只记录、不改变任务状态（`appliedOutcome=none`） |

要点：

- `PI_JEV_MODE` 必须**同时**给 web 与 worker：worker 用它做**显式 opt-in**（未设置/`off`
  时完全不调用网关，零 HTTP、零事件）；网关侧仍以自己的配置为准（worker 说 shadow、web 说
  off 时返回 business-safe `disabled`，不发起任何外呼）。
- 结果写入 `decision_evaluations`（迁移 15），`GET /api/runs/:id/decisions` 只回**脱敏投影**；
  `decision.requested` + 一条结果事件落在 run 事件流里，meta 里只有 id/模式/状态/模型/时延
  （批次扇出时另有自洽的 `batchIndex`/`batchCount`）。
- 真实引擎（`PI_DECISION_ENGINE=jev`）另需一把 TypeSafe Key。**录入位置**：控制台「模型与凭据」
  页的 `TypeSafe · Jev 决策平面` 卡片（该 provider 不在模型目录里，卡片只用于管理这把凭据，
  可保存/轮换/删除）。保存即调用既有 `PUT /api/credentials`，服务端用
  `GET ${PI_JEV_BASE_URL||https://api.typesafe.ai}/v1/models` 真实校验：200 → 标记「已验证」，
  401 → 「未校验」（密钥仍是密文保存，界面与 API 永不回显明文）。`TYPESAFE_API_KEY` 是**平台
  级回退**：取 key 的顺序为 该用户 vault（`typesafe` → `jev` 别名）→ 环境变量；部署未启用引擎时
  不读 vault、零外呼。
- **存 key ≠ 启用**：卡片会显示部署侧引擎/模式，未启用时明确提示还需部署侧
  `PI_DECISION_ENGINE=jev`（保存凭据不会打开决策平面）。缺凭据时状态仍如实报告
  `engine=jev / configured=false / reason=missing_credentials`，不会伪装成「引擎未启用」。
- **线上契约已实测校准**（docs/26 §6.3.1）：2026-10-06 在 prod（`jev`+`shadow`）完成首次真实调用，
  `status=completed`、`resolvedModel=jev-1.13.0`、24 条回答、886ms/4238+986 tok、`applied_outcome=none`、
  `estimated_cost_usd` 仍为 NULL。排查契约漂移用 `PI_JEV_DIAG=1`（引擎）与 `PI_PROBE_DIAG=1`（探测），
  只记录字段名/定位，默认关闭。
- **无可问内容不发调用**：本轮没有未解决 findings 时，构造器不产出批次，路由返回业务安全
  no-op（`payload_rejected` / `nothing to triage`），零外发、零审计行（provider 侧空 `questions` 是 422）。
  若运行**有过** findings 但都已解决，则按"未解决优先、全量兜底"策略评估完整 findings 集
  （内部 `resolved` 不外发），保证 shadow 阶段持续有校准样本。
- 上线真实调用前需完成供应商准入与合规评审（docs/26 §14.3）。生产当前为 `jev`+`shadow`（只记录、
  不改判，3s 预算 + 熔断兜底）；演示环境维持文档约定的 `mock`+`shadow`（无网络）。
- 验收：`tests/e2e/decision-engine.spec.ts`（部署未启用时精确跳过）；离线用例覆盖配置/脱敏/
  载荷上限/响应映射/重试熔断/策略不可变规则。

### 决策平面回滚演练（2026-10-06 已在 demo 执行）

两条演练都在 demo 上跑通并已恢复原状（`PI_DECISION_ENGINE=mock`、`PI_JEV_MODE=shadow`）：

| 用例 | 操作 | 实测结果 |
| --- | --- | --- |
| AT-JEV-090 配置回滚 | `demo.env` 设 `PI_JEV_MODE=off` → `--force-recreate demo-web demo-worker` | 两服务 env 均为 `off`；内部评估返回 `{status:"disabled", mode:"off", fallbackReason:"disabled"}`，**零外呼、审计行 17→17 未增**；历史仍可查（有决策行的运行返回 1 行 `review_triage/completed`）；任务路径不阻塞（决策始终 fire-and-forget） |
| AT-JEV-091 引擎回滚 | `demo.env` 设 `PI_DECISION_ENGINE=disabled` → 重建 | 实例健康（`demo-0.27.17`）；**历史数据照旧可查**（数据库向后兼容）；`/api/config/status` 如实报 `engine=disabled` |

复现步骤：

```sh
export PIGO_SSH_PW=...            # 只从环境读，不落盘
cd /app/pi-agent                  # 宿主机；先备份 demo.env
sed -i 's/^PI_JEV_MODE=.*/PI_JEV_MODE=off/' demo.env        # AT-JEV-090
cp demo.env source/deploy/docker/demo.env
cd source && docker compose -f deploy/docker/compose.demo.yaml \
  --env-file /app/pi-agent/demo.env -p pigo-demo up -d --force-recreate demo-web demo-worker
# 断言：内部评估返回 disabled、审计表行数不变、历史接口仍返回旧行；随后把值改回并重建
```

注意：`PI_JEV_MODE` 必须同时进 **web 与 worker**（worker 的 opt-in 在自己进程里读）；`PI_DECISION_ENGINE`
只被 web 读。宿主机 `/app/pi-agent/compose.yaml` 决定哪些变量能进容器——它曾落后仓库一整段 Jev 变量
（导致"改了 .env 却不生效"），新增 compose 变量时务必同步宿主机副本。

## 常用命令

```sh
cp deploy/docker/demo.env.example ../demo.env   # 然后编辑；chmod 600
scripts/demo-env.sh up       # 校验 → 建工作区目录 → 启动 → 等健康检查
scripts/demo-env.sh doctor   # PASS/FAIL 检查（DB 名、vault、socket、token、版本、工作区目录与权限）
scripts/demo-env.sh seed     # 幂等写入演示项目/冲刺/故事
scripts/demo-env.sh status
scripts/demo-env.sh down     # 停止但**不**删除卷与宿主工作区目录
```

端口：主入口 `PIGO_DEMO_WEB_PORT`（默认 3101，绑定 `PIGO_DEMO_WEB_BIND_ADDRESS`）；
仅供脚本与 Playwright 使用的回环入口 `127.0.0.1:3102`（`PIGO_DEMO_WEB_LOOPBACK_PORT`）。
