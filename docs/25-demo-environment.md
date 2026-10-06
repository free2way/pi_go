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

## 常用命令

```sh
cp deploy/docker/demo.env.example ../demo.env   # 然后编辑；chmod 600
scripts/demo-env.sh up       # 校验 → 建工作区目录 → 启动 → 等健康检查
scripts/demo-env.sh doctor   # PASS/FAIL 检查（DB 名、vault、socket、token、版本、工作区目录）
scripts/demo-env.sh seed     # 幂等写入演示项目/冲刺/故事
scripts/demo-env.sh status
scripts/demo-env.sh down     # 停止但**不**删除卷与宿主工作区目录
```

端口：主入口 `PIGO_DEMO_WEB_PORT`（默认 3101，绑定 `PIGO_DEMO_WEB_BIND_ADDRESS`）；
仅供脚本与 Playwright 使用的回环入口 `127.0.0.1:3102`（`PIGO_DEMO_WEB_LOOPBACK_PORT`）。
