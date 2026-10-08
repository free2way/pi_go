# 29 · 独立应用全流程手工验收

> 目标：让 PiGO 从零开发一个可以单独运行、测试、构建镜像和部署的 Web 应用，并完整走过「工作区 → 敏捷项目 → Sprint → Story → 多 Agent → 检查 → Reviewer → 人工验收 → 合并 → staging 发布 → 运行验证 → production 晋级」。
>
> 本文是可直接照着点击和填写的操作脚本。测试使用独立 clone，不修改正在运行的 PiGO 生产工作区。

## 1. 要交付的实际应用

应用名称：**Order Status Board（订单履约状态台）**。

它是一个独立的、零第三方运行时依赖的 Node.js Web 应用：用户在网页输入订单号，选择“已支付”和“有库存”，点击按钮后通过 HTTP API 获取履约状态。

### 1.1 用户功能

| 场景 | 预期结果 |
| --- | --- |
| 已支付、有库存 | `READY_TO_SHIP`，页面显示“可以发货” |
| 未支付 | `WAITING_PAYMENT`，页面显示“等待付款” |
| 已支付、无库存 | `WAITING_STOCK`，页面显示“等待库存” |
| 订单号为空或字段类型错误 | HTTP 400，错误码 `INVALID_INPUT` |

### 1.2 HTTP 合同

```text
GET  /healthz
200  {"status":"ok","service":"order-status-app","version":"0.1.0"}

POST /api/orders/evaluate
Content-Type: application/json
{"orderId":"SO-1001","paid":true,"stock":true}

200
{"orderId":"SO-1001","status":"READY_TO_SHIP","message":"可以发货"}
```

错误示例：

```text
POST /api/orders/evaluate
{"orderId":"","paid":"yes","stock":true}

400
{"error":{"code":"INVALID_INPUT","message":"..."}}
```

### 1.3 预期交付结构

```text
apps/order-status-app/
├── package.json
├── README.md
├── Dockerfile
├── compose.yaml
├── ops/
│   ├── deploy.sh
│   └── smoke.sh
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── src/
│   ├── domain.mjs
│   └── server.mjs
└── test/
    ├── domain.test.mjs
    └── http.test.mjs
```

### 1.4 “可交付、可验证、可部署”的定义

- `node src/server.mjs` 可以独立启动应用；
- 浏览器可以打开页面并完成三个业务场景；
- `node --test test/*.test.mjs` 可以离线执行单元测试和 HTTP 集成测试；
- `docker build` 可以生成独立镜像；
- `docker compose up -d` 可以部署到 staging；
- 获得生产授权后，production 可以提升 staging 已验证的同一不可变镜像，而不是重新构建；
- `/healthz` 和 `ops/smoke.sh` 可以验证部署结果；
- 镜像以合并 commit SHA 标记，可定位、可回滚；
- README 包含开发、测试、构建、部署、验证和回滚命令。

## 2. 测试边界和风险

- 本案例会真实调用 Planner、多个开发 Agent、Integrator 和 Reviewer，会消耗 token 和额度。
- 本案例会创建 Git clone、worktree、分支、提交、Docker 镜像和 staging 容器；获得明确授权后还会创建隔离的 production 部署。
- PiGO 的“合并”只修改测试 clone 的本地 `main`，不会自动推送 GitHub。
- PiGO 的“发布”通过管理员「发布设置」中的 Webhook 调用外部部署执行器；环境变量是兼容性回退。发布成功不等于 GitHub 已 push。
- 不要选择生产 `pi_go` 工作区，也不要把测试 clone 推送到 `free2way/pi_go/main`。
- staging 默认只绑定 `127.0.0.1:18080`；若要从其他机器浏览，需由运维显式配置反向代理或安全端口映射。
- 不执行 `git reset --hard`。回滚使用上一镜像或 `git revert <merge-commit>`。

## 3. 开始前准备

使用管理员账户登录 PiGO，并逐项确认：

| # | 检查项 | 通过标准 | 结果 |
| --- | --- | --- | --- |
| 1 | Web、Worker、数据库 | 「系统状态」均为健康 | ☐ |
| 2 | 开发模型 | 至少一个可用且凭据已配置 | ☐ |
| 3 | 审核模型 | 至少一个可用且凭据已配置 | ☐ |
| 4 | 当前账户 | 管理员，有工作区写权限 | ☐ |
| 5 | Worker 沙箱 | 可用，无 fail-closed 错误 | ☐ |
| 6 | 部署主机 | Docker 与 Compose 可用 | ☐ |
| 7 | 发布设置 | 管理员页面显示「已就绪」，配置来源已记录 | ☐ |
| 8 | 发布 webhook | 能访问测试 clone，并能回调 PiGO | ☐ |
| 9 | staging 端口 | `127.0.0.1:18080` 未被占用 | ☐ |

记录环境：

```text
执行人：____________________
开始时间：__________________
PiGO 版本：_________________
开发模型：__________________
审核模型：__________________
部署执行器地址：____________
发布配置来源：网页 / 环境变量
PiGO 公网地址：______________
staging 地址：_______________
production 地址：____________
```

## 4. 创建独立代码工作区

### 4.1 从 GitHub 克隆基线仓库

进入「工作区」，点击「从 Git 克隆」：

| 输入框 | 固定值 |
| --- | --- |
| Git URL | `https://github.com/free2way/pi_go.git` |
| 工作区名称 | `order-status-delivery-20261007` |

点击「克隆并注册」。如果名称已存在，改为 `order-status-delivery-20261007-2`，后续均选择实际名称。

> 克隆 PiGO 只是为了获得一个已有初始 commit、可立即创建 worktree 的安全基线。最终应用位于 `apps/order-status-app`，拥有自己的 package、运行入口、测试和容器定义，可独立交付。

通过标准：

- 状态为「已就绪」；
- 分支为 `main`；
- 工作树为「干净」；
- HEAD 不为空；
- Repository URL 为 GitHub 地址。

记录：

```text
工作区 ID：________________________
工作区实际名称：__________________
测试前 HEAD：______________________
```

### 4.2 配置工作流默认检查

在测试工作区卡片点击「默认检查」，默认分支填写 `main`，默认检查填写以下 8 行（当前接口最多接受 8 条）：

```sh
test -f apps/order-status-app/package.json
test -f apps/order-status-app/src/domain.mjs && test -f apps/order-status-app/src/server.mjs
test -f apps/order-status-app/public/index.html && test -f apps/order-status-app/public/app.js && test -f apps/order-status-app/public/styles.css
test -f apps/order-status-app/test/domain.test.mjs && test -f apps/order-status-app/test/http.test.mjs
test -f apps/order-status-app/Dockerfile && test -f apps/order-status-app/compose.yaml
test -x apps/order-status-app/ops/deploy.sh && test -x apps/order-status-app/ops/smoke.sh
node --check apps/order-status-app/src/domain.mjs && node --check apps/order-status-app/src/server.mjs && node --check apps/order-status-app/public/app.js
node --test apps/order-status-app/test/*.test.mjs
```

点击「保存」，重新打开确认仍是 8 行。

> Story 的“验收标准”是业务合同；Worker 真正执行的是这里的默认检查。Docker 构建和在线 smoke test 放在发布阶段，不在禁网开发沙箱中执行。

## 5. 新建敏捷项目和 Sprint

进入「敏捷」。

### 5.1 新建项目

点击「新建项目」：

| 输入框 | 固定值 |
| --- | --- |
| 项目名称 | `订单履约应用交付` |
| 项目前缀 | `ORDER` |

如 `ORDER` 已存在，改为 `ORD2` 并记录实际前缀。

### 5.2 新建并启动 Sprint

点击「新建冲刺」：

| 输入框 | 固定值 |
| --- | --- |
| 冲刺名称 | `Sprint 1 · 独立应用 MVP` |
| 冲刺目标 | `交付可测试、可容器构建、可部署到 staging 的订单状态应用` |

创建后，在「冲刺与发布」中点击该 Sprint 的「开始」。

通过标准：Sprint 状态为「进行中」。

## 6. 新建 Story

点击「新建故事」。

### 6.1 基本字段

| 输入框 | 固定值 |
| --- | --- |
| 标题 | `开发并部署订单履约状态 Web 应用` |
| 优先级 | `必须` |
| 估算（点） | `8` |
| 工作区 | 第 4 步创建的 `order-status-delivery-20261007` |
| 冲刺 | `Sprint 1 · 独立应用 MVP` |
| 模板 | `不使用` |
| 最大并行 | `4` |
| 开发模型 | 选择标记为“可用”的开发模型 |
| 审核模型 | 选择标记为“可用”的审核模型，最好与开发模型不同 |
| 预算 Token | `120000` |
| 预算成本（$） | `15` |
| 模型调用 | `80` |
| 时长（秒） | `5400` |

### 6.2 “描述”输入框

完整粘贴：

```text
在 apps/order-status-app 中从零开发一个可独立交付的 Order Status Board Web 应用。

技术约束：Node.js 22；运行时零第三方依赖；ES modules；只允许修改 apps/order-status-app/**；不得修改仓库根 package.json/package-lock.json、src/**、deploy/**、scripts/** 或 tests/e2e/**。

请由 Planner 拆成 4 个边界清晰、尽可能并行的开发任务：

1. 领域与 API Agent（只负责 src/**）
   - domain.mjs 导出 evaluateOrder({orderId, paid, stock})。
   - orderId 必须是 trim 后 1–40 个字符；paid/stock 必须是 boolean。
   - 状态规则：未支付 WAITING_PAYMENT；已支付但无库存 WAITING_STOCK；已支付且有库存 READY_TO_SHIP。
   - server.mjs 使用 node:http；GET /healthz；POST /api/orders/evaluate；JSON body 上限 64 KiB；错误返回统一 JSON；支持 PORT/APP_VERSION，APP_VERSION 缺省为 0.1.0；导出可测试的 createAppServer()；直接执行文件时监听端口；处理 SIGTERM/SIGINT。
   - 只提供 public 目录中的静态文件，禁止路径穿越。

2. 前端 Agent（只负责 public/**）
   - 单页中文界面，标题“订单履约状态台”。
   - 输入订单号，两个 checkbox“已支付”“有库存”，按钮“评估订单”。
   - 调用 POST /api/orders/evaluate，并显示状态码和中文 message。
   - 包含 loading、错误、键盘操作和基本可访问标签；不使用 CDN 或外部字体。
   - 页面应在手机宽度下可用。

3. 测试 Agent（只负责 test/**）
   - 使用 node:test 和 assert，不安装依赖。
   - 覆盖三个领域状态、空订单号、字段非布尔值。
   - HTTP 集成测试使用随机本地端口，覆盖 /healthz、成功 POST、400、404、错误 Content-Type 和超过 body 上限。
   - 每个测试关闭 server，不遗留进程或端口。

4. 交付 Agent（负责 package.json、README.md、Dockerfile、compose.yaml、ops/**）
   - package.json 的 name 为 order-status-app、version 为 0.1.0、private 为 true，提供 start/test/check 脚本，不声明 dependencies。
   - Dockerfile 基于 node:22-alpine，非 root 用户、生产启动、EXPOSE 8080、HEALTHCHECK /healthz。
   - compose.yaml 服务名 order-status-app，镜像变量 ORDER_STATUS_IMAGE，默认端口只绑定 127.0.0.1:${ORDER_STATUS_PORT:-18080}:8080，read_only、tmpfs /tmp、cap_drop ALL、no-new-privileges、健康检查。
   - ops/deploy.sh 接收 environment 和 image tag：staging 按精确 commit 构建不可变镜像并幂等执行 compose up -d；production 只允许部署已由 staging 验证的同一 image tag/digest，不重新构建；两个环境使用不同 Compose project、端口和配置；失败返回非 0；不得执行 prune 或删除无关镜像/容器。
   - ops/smoke.sh 从 APP_BASE_URL 读取地址，验证 /healthz 以及三个 API 业务场景，任一不符即非 0。
   - README 写清开发、测试、启动、Docker 构建、部署、smoke、日志和使用上一镜像回滚。

Integrator 负责统一端口、模块导出、错误 JSON、静态资源路径、package scripts、镜像变量和文档命令；不得扩大修改范围。

Agent 不要自行 commit、push、merge 或修改 Git 配置；每轮提交由 PiGO 工作流负责。
```

### 6.3 “验收标准（每行一条）”输入框

```text
GET /healthz 返回 200，service=order-status-app，version=0.1.0
POST /api/orders/evaluate 对三个业务输入返回规定状态和中文 message
非法 orderId、paid 或 stock 返回 HTTP 400 和 error.code=INVALID_INPUT
网页可以输入订单号、选择支付/库存并展示 API 结果
node --test apps/order-status-app/test/*.test.mjs 全部通过且不遗留服务进程
Dockerfile 使用非 root 用户并配置 /healthz 健康检查
Compose 默认仅绑定 127.0.0.1:18080，并启用只读文件系统和降权配置
ops/smoke.sh 能验证健康检查和三个业务状态
production 晋级复用 staging 已验证的同一镜像 digest，且与 staging 相互隔离
README 包含本地运行、测试、构建、部署、验证和回滚步骤
至少 3 个开发 Agent 实际执行，目标为 4 个边界独立任务
最终 Diff 只包含 apps/order-status-app/**
```

### 6.4 “完成定义（每行一条）”输入框

```text
应用源码、网页、测试、容器文件、部署脚本和运维文档齐全
根目录依赖与 PiGO 生产代码零改动
工作区配置的 8 条默认检查全部 exit 0
独立 Reviewer 没有未解决的 critical/high finding
人工确认后才合并；合并后不自动发布
staging 镜像使用合并 commit SHA 标记
production 仅提升 staging 已验证的同一不可变镜像，不从分支重新构建
部署后 /healthz、API smoke 和浏览器手工验证全部通过
```

点击「创建故事」。

通过标准：Story 位于 Sprint 看板「待办」，工作区、Sprint、预算、最大并行、验收标准和 DoD 均完整。

## 7. 创建 Release 计划

进入「发布管理」：

| 输入框 | 固定值 |
| --- | --- |
| 版本号 | `v0.1.0` |
| 发布名称 | `Order Status Board MVP` |
| 状态 | `已计划` |
| 备注 | `首个可独立构建和部署的订单履约状态应用。` |
| 故事 | 勾选 `开发并部署订单履约状态 Web 应用` |

点击「创建」。

此时发布预检应因 Story 尚未完成而失败。这证明发布门禁生效，不是测试失败。

## 8. 启动真实 Run

回到 Story：

1. 点击「标为就绪」。
2. 确认页面提示“将以真实运行执行”；如果显示 demo，停止并修复凭据。
3. 点击「提交为运行」并确认。

记录：

```text
Story 编号：________________________
Run ID：____________________________
创建时间：__________________________
```

通过标准：Story 变为「开发中」，关联 Run 数为 1，Run 顶部显示「真实工作区」。

## 9. 观察多 Agent 开发

### 9.1 工作流主状态

预期依次经过：

```text
queued → preparing → developing → checking → reviewing
       → completed 或 needs_human
```

活动流应能定位以下里程碑：

```text
run.created
workspace.preparing / workspace.created
round.started
planner 规划/任务拆分
developer.started / developer.completed
integration
checks.started / check.passed
review.started
review.approved 或 review.changes_requested
```

关闭网页不会取消服务端 Run，但手工验收建议保持页面打开观察实时流。

### 9.2 多 Agent 验收

打开 `Agents` 标签：

- 至少 3 个开发 Agent，目标为 4 个；
- 能识别“领域与 API”“前端”“测试”“交付”任务；
- Agent 修改目录符合任务边界；
- 不同 Agent 没有同时争抢同一个文件；
- Integrator 负责最终合同对齐；
- Reviewer 不复用开发 Agent 身份。

`最大并行=4` 是上限，不保证 Planner 一定创建 4 个任务。如果只有 1–2 个开发 Agent，功能可以继续验证，但“多 Agent”验收记为失败，并保存 Planner 输出。

### 9.3 检查与返修

打开「检查」标签：8 条检查必须全部 `passed`、`exit 0`。

打开「审核」标签：

- 不接受未解决的 critical/high finding；
- Reviewer 退回时观察下一轮是否只修指定问题；
- 检查失败必须返修，不得人工跳过；
- 超出 `apps/order-status-app/**` 的改动必须退回。

打开 `Diff`：

- 只包含应用目录；
- 应同时包含功能代码、测试和交付文件；
- 下载 patch，记录 artifact ID、SHA-256 和字节数。

记录：

```text
开发 Agent 数：_____________________
任务数 / wave 数：__________________
总轮次：____________________________
检查通过：________ / 10
Reviewer findings：critical ___ / high ___ / medium ___ / low ___
Patch artifact ID：__________________
Patch SHA-256：______________________
```

## 10. 人工交付验收

### 10.1 代码级验收

运行完成后检查验收快照：

- 检查 8/8；
- critical/high finding 为 0；
- 用量与模型调用已记录；
- Diff artifact/SHA 已记录；
- Story 状态为「完成」；
- 此时“代码发布”仍显示「未合并」。

如果 Run 进入「需要人工处理」：可修复问题选择“继续开发”；只有已明确接受的 medium/low finding 才可记录理由后接受。

### 10.2 应用包验收

在 Diff 中核对：

- `package.json` 没有 dependencies；
- `server.mjs` 不在 import 时自动监听固定端口；
- HTTP 测试使用随机端口并关闭 server；
- Dockerfile 有非 root `USER` 和 `HEALTHCHECK`；
- Compose 没有暴露到 `0.0.0.0`；
- deploy 脚本没有 `docker system prune`、删除卷或操作其他项目；
- README 中的命令与实际文件一致。

## 11. 管理员合并

在 Run 的「代码发布」面板：

1. 记录测试工作区当前 HEAD，它应仍等于第 4 步基线。
2. 点击「合并审核代码」。
3. 确认提示包含“此操作不会自动发布”。
4. 确认合并。

通过标准：

- 合并结果显示 `<commit> → main`；
- 工作区刷新后 HEAD 等于该 commit；
- 工作树仍干净；
- 发布尚未触发。

记录：

```text
合并前 HEAD：_______________________
合并后 commit：_____________________
短 SHA：____________________________
合并策略：__________________________
```

> 这是测试 clone 的本地合并，PiGO 当前不会自动 `git push`。不要将它推到正式 GitHub main。

## 12. 准备实际部署执行器

### 12.1 推荐架构

PiGO Web 只负责审批、签名投递和记录结果；部署执行器负责访问源码和 Docker：

```text
PiGO Run 发布
  → 带 HMAC 的 HTTPS webhook
    → 部署执行器校验 deliveryId / commit / attempt
      → 从测试 workspace 的精确 commit 构建镜像
        → 部署 staging
          → health + smoke
            → 回调 PiGO succeeded / failed
```

部署执行器应与 Worker 共享受控工作区，或者能从可信 Git remote 拉取精确 commit。由于本案例不 push GitHub，建议在同一部署主机以只读方式访问测试工作区。

### 12.2 在网页配置发布链路

使用管理员账户打开左侧「发布设置」。三个输入框按下表填写：

| 输入框 | 填写内容 | 本案例示例 | 注意事项 |
| --- | --- | --- | --- |
| Webhook URL | 部署执行器接收 PiGO 发布请求的 HTTPS 地址 | `https://deploy.example.com/hooks/pigo-release` | 必须是执行器接口，不是 GitHub 仓库地址、PiGO 地址或应用首页 |
| Webhook Token | PiGO 与部署执行器共享的随机密钥 | 使用 `openssl rand -hex 32` 生成 | 首次配置必填，至少 12 个字符；执行器必须保存同一个值；后续编辑留空表示保留原 Token |
| PiGO 公网地址 | 部署执行器能够回调的 PiGO Origin | `https://pigo.ai2note.com` | 只填协议和域名，不带 `/api/...` 路径，不使用局域网或浏览器当前页面的深层 URL |

点击「保存」后必须满足：

- 页面状态显示「已就绪」；
- 配置来源显示「网页配置」；
- Token 输入框被清空且不回显原值；
- 刷新页面后 Webhook URL 与 PiGO 公网地址仍存在；
- 「系统状态」或发布面板不再提示发布链路未配置。

网页配置优先于环境变量，并同时供 Run「代码发布」和「敏捷 → 发布管理」使用。URL、Token、PiGO 公网地址整体加密落盘；删除网页配置后才回退到环境变量。不要把真实 Token 写进本文档、截图、Story、Release 备注或日志。

仅当网页无法使用时，才在 PiGO Web 运行环境中使用兼容性配置，并重启 Web：

```text
PI_POST_MERGE_DEPLOY_HOOK=https://<部署执行器>/hooks/pigo-release
PI_POST_MERGE_DEPLOY_TOKEN=<与执行器一致的随机密钥>
PI_PUBLIC_ORIGIN=https://pigo.ai2note.com
```

验收记录：

```text
配置时间：_________________________
配置来源：网页 / 环境变量
Webhook 主机（不含 Token）：_______
PiGO 公网地址：____________________
页面状态：已就绪 / 未就绪
```

### 12.3 Webhook 请求、签名与返回

PiGO 使用 `POST application/json`，每次请求包含：

| Header | 含义 |
| --- | --- |
| `Authorization: Bearer <Webhook Token>` | 共享 Token 鉴权 |
| `X-PiGO-Delivery-Id: <deliveryId>` | 幂等键；相同 delivery ID 的重复请求不能重复产生副作用 |
| `X-PiGO-Signature: sha256=<hex>` | 使用 Webhook Token 对**原始 JSON 请求体字节**计算 HMAC-SHA256 |

Run 发布的关键 payload：

```json
{
  "event": "run.release_requested",
  "runId": "...",
  "repository": "/absolute/path/to/workspace",
  "commit": "<merge-commit>",
  "environment": "staging",
  "deliveryId": "...",
  "attempt": 1,
  "callbackUrl": "https://pigo.ai2note.com/api/internal/runs/.../release-result"
}
```

Agile Release 发布的关键 payload：

```json
{
  "event": "release.published",
  "releaseId": "...",
  "version": "v0.1.0",
  "environment": "staging",
  "deliveryId": "release-publish:<release-id>:staging",
  "attempt": 1,
  "stories": [],
  "callbackUrl": "https://pigo.ai2note.com/api/internal/agile/releases/.../release-result"
}
```

执行器返回规则：

- 已在请求内完成部署和验证：返回任意成功 `2xx`，但不要返回 `202`；PiGO 立即记录成功。
- 只接收了异步任务：返回 `HTTP 202`；PiGO 保持「部署进行中」，执行器完成后必须回调。
- 鉴权、签名、参数或安全策略失败：返回对应 `4xx`；执行器内部失败返回 `5xx`。
- PiGO 调用 Webhook 的超时时间为 30 秒；异步工作不要占住原请求等待构建完成。

异步成功回调示例：

```http
POST <callbackUrl>
Authorization: Bearer <Webhook Token>
Content-Type: application/json
```

```json
{
  "deliveryId": "<原值>",
  "attempt": 1,
  "status": "succeeded",
  "detail": "image built and smoke checks passed",
  "deploymentId": "order-status-staging-<short-sha>",
  "url": "http://<staging-host>:18080"
}
```

失败时将 `status` 改为 `failed`，并在 `detail` 中提供不含凭据的可操作原因。Agile Release 回调必须原样返回 `attempt`；Run 回调至少必须返回 `deliveryId` 与 `status`。

### 12.4 部署执行器职责

部署执行器必须：

1. 同时校验 Bearer Token 与 HMAC 签名，比较签名时使用常量时间算法；
2. 按 `X-PiGO-Delivery-Id` 幂等，重试只更新同一发布记录；
3. 按 `event` 区分 `run.release_requested` 与 `release.published`；
4. 只接受 `staging`、`production`，并把两套环境映射到相互隔离的 Compose project、端口和配置；
5. 对 Run 发布使用 payload 的 `repository`、`commit`、`environment` 和 `attempt`，拒绝不属于测试根目录的 repository；
6. 校验目标 commit 存在，绝不以“当前目录最新代码”代替 payload commit；
7. staging 构建一次按 commit 标记的不可变镜像，执行 smoke；production 只能提升 staging 已验证的同一镜像，不重新构建漂移制品；
8. 对 `release.published` 关联既有 Run 制品和部署记录，不因缺少 repository/commit 而盲目构建；
9. 返回 202 后向 payload 的 `callbackUrl` 回传最终结果。

如果没有部署执行器，可在部署主机手工执行第 13.3 节命令验证应用确实可部署，但 PiGO 内只能记录“发布链路未配置”；不得把它算作端到端发布通过。

## 13. 发布到 staging

### 13.1 在 PiGO 发起 Run 发布

在 Run 的「代码发布」面板填写：

| 输入框 | 固定值 |
| --- | --- |
| 发布环境 | `staging` |

点击「确认发布」。

通过标准：

- 先记录 `publishing/triggered`，异步回调后为 `succeeded`；
- delivery ID 非空；
- attempt 为 1；
- environment 明确为 `staging`；
- 发布 commit 等于第 11 步 merge commit；
- deployment ID 含短 SHA；
- URL 指向 staging；
- 重复刷新页面不会重复部署。

staging 成功后，代码发布面板应出现「晋级发布到 production」。此时先不要点击，必须完成第 14 节全部 staging 验证后再晋级。

如果按钮禁用并提示发布钩子未配置：本节失败，但可以继续手工部署验证。

### 13.2 构建制品验收

在部署主机记录：

```text
镜像名：local/order-status-app:<merge-sha>
镜像 ID：________________________________
镜像创建时间：___________________________
容器 ID：________________________________
Compose project：order-status-staging
前一可回滚镜像：_________________________
```

必须满足：镜像 tag/label 对应 merge commit，而不是 `latest`；同一次发布重试不得生成语义不同但 tag 相同的镜像。

### 13.3 无 webhook 时的手工部署验证

仅在测试部署主机执行，`<workspace>` 替换为第 4 步 clone 的绝对路径，`<sha>` 替换为 merge commit：

```sh
cd <workspace>/apps/order-status-app
./ops/deploy.sh staging <sha>
APP_BASE_URL=http://127.0.0.1:18080 ./ops/smoke.sh
```

这两条命令必须来自交付物 README，并且与部署执行器调用方式一致。

## 14. 运行时验证

### 14.1 健康检查

```sh
curl -fsS http://127.0.0.1:18080/healthz
```

期望：

```json
{"status":"ok","service":"order-status-app","version":"0.1.0"}
```

### 14.2 API 验证

```sh
curl -fsS -X POST http://127.0.0.1:18080/api/orders/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"SO-1001","paid":true,"stock":true}'

curl -fsS -X POST http://127.0.0.1:18080/api/orders/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"SO-1002","paid":false,"stock":true}'

curl -fsS -X POST http://127.0.0.1:18080/api/orders/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"SO-1003","paid":true,"stock":false}'
```

依次期望 `READY_TO_SHIP`、`WAITING_PAYMENT`、`WAITING_STOCK`。

错误输入：

```sh
curl -sS -o /tmp/order-error.json -w '%{http_code}\n' \
  -X POST http://127.0.0.1:18080/api/orders/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"","paid":"yes","stock":true}'
```

期望 HTTP `400`，响应含 `INVALID_INPUT`。

### 14.3 浏览器验证

通过受控反向代理或安全端口映射打开 staging URL：

1. 页面标题为“订单履约状态台”。
2. 输入 `SO-1001`，勾选“已支付”“有库存”，点击“评估订单”，显示“可以发货”。
3. 取消“已支付”，显示“等待付款”。
4. 勾选“已支付”、取消“有库存”，显示“等待库存”。
5. 清空订单号，页面展示可理解的错误，不刷新、不白屏。
6. 浏览器开发者工具没有未处理异常，请求没有访问第三方 CDN。
7. 使用约 390px 宽度检查页面没有横向溢出。

## 15. 晋级 production 并发布 Agile Release

### 15.1 将 Run 的同一制品晋级 production

前置条件：第 13、14 节全部通过，staging 的 release 状态为 `succeeded`，且生产变更已获得人工批准。

回到 Run 的「代码发布」面板：

1. 确认按钮已从「确认发布」变为「晋级发布到 production」。
2. 核对提示中的 commit 与 staging 完全一致。
3. 点击「晋级发布到 production」并进行二次确认。
4. 若执行器返回 202，等待 production 回调完成，不要重复点击。
5. 使用 production URL 执行 `/healthz`、三个 API 场景和浏览器 smoke。

production 通过标准：

- production 使用独立 delivery ID，且包含或可关联 `production`；
- 首次 production attempt 为 1；
- commit、镜像 tag 和镜像 digest 与已验证的 staging 制品一致；
- 执行器没有重新从浮动分支构建镜像；
- production 健康检查和 smoke 全部通过；
- staging 仍可访问，或按既定策略明确下线，没有被 production Compose project 覆盖。

若本次验收没有真实 production 授权，到此停止，记录“staging 通过，production 未获授权”，不得为了勾选测试项擅自发布生产。

### 15.2 发布 Agile Release

回到「敏捷 → 发布管理」，找到 `v0.1.0`：

1. 点击「发布」，等待预检通过。
2. 首次选择 `staging`，发布备注填写：`staging 已部署并通过 health、API、浏览器和 smoke 验证；镜像与 merge commit 一致。`
3. 点击「确认发布」，等待版本级 webhook 成功。
4. 若第 15.1 节 production 已通过，点击「晋级 production」。
5. production 备注填写：`production 已提升 staging 验证过的同一不可变镜像，health 与 smoke 通过。`
6. 点击「确认发布 production」，等待最终回调成功。

注意：Agile Release 的 `release.published` webhook 是版本级事件，不含 Run 的 repository/commit。部署执行器应把它作为“确认既有制品并登记版本/环境”的动作，关联此前 `run.release_requested` 的成功部署；不得再次盲目构建另一份镜像。staging 与 production 使用不同 delivery ID，各自独立审计。

通过标准：

- Release 状态为「已发布」；
- 关联 Story 为 1 且已完成；
- staging 成功后才允许选择 production 晋级；
- production delivery ID 与 staging 不同，两个环境的首次 attempt 均为 1；
- “发布回顾”能看到 Run、轮次、findings、成本/Token、模型组合、merge 和 deploy；
- 版本级 webhook 没有重复构建应用；
- 导出发布回顾 JSON 保存为验收证据。

## 16. 回滚演练

如果部署前已有一个可用镜像，执行应用 README 里的回滚命令，将 Compose 的 `ORDER_STATUS_IMAGE` 指向前一 commit 镜像，然后重新 `up -d`。

回滚后必须重新执行：

```sh
APP_BASE_URL=http://127.0.0.1:18080 ./ops/smoke.sh
```

记录：

```text
回滚前镜像：________________________
回滚目标镜像：______________________
回滚开始/结束时间：_________________
健康恢复耗时：______________________
smoke 结果：PASS / FAIL
```

首次发布没有前一镜像时，只验证回滚命令为显式镜像参数、不会删除数据或无关容器，并记录“无历史制品，未执行实际回滚”。

## 17. 最终验收表

| # | 验收项 | 通过 | 失败 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 独立测试工作区干净且 HEAD 已记录 | ☐ | ☐ | workspace/HEAD |
| 2 | Project、Sprint、Story、Release 建立 | ☐ | ☐ | ORDER 编号 |
| 3 | Planner 给出领域/API、前端、测试、交付拆分 | ☐ | ☐ | 规划事件 |
| 4 | 至少 3 个开发 Agent 实际执行 | ☐ | ☐ | Agents 标签 |
| 5 | 8 条工作流检查全部 exit 0 | ☐ | ☐ | Checks 标签 |
| 6 | Reviewer 无未解决 critical/high | ☐ | ☐ | 审核记录 |
| 7 | Diff 仅包含独立应用目录 | ☐ | ☐ | patch SHA |
| 8 | 人工验收前没有自动合并 | ☐ | ☐ | 合并前 HEAD |
| 9 | 管理员合并后 main 精确前移 | ☐ | ☐ | merge commit |
| 10 | 合并没有自动发布 | ☐ | ☐ | 事件时间线 |
| 11 | 镜像按 merge commit 构建 | ☐ | ☐ | image ID/tag |
| 12 | Compose staging 健康 | ☐ | ☐ | container/health |
| 13 | health、三个 API 场景、错误输入通过 | ☐ | ☐ | smoke 日志 |
| 14 | 浏览器桌面与手机宽度验证通过 | ☐ | ☐ | 截图 |
| 15 | PiGO 发布回调成功且记录 deployment ID/URL | ☐ | ☐ | delivery ID |
| 16 | Agile Release 与发布回顾完整 | ☐ | ☐ | 回顾 JSON |
| 17 | 回滚成功或首次发布的回滚合同验证通过 | ☐ | ☐ | 回滚记录 |
| 18 | production 获授权后仅提升 staging 已验证的同一制品 | ☐ | ☐ | 两环境 delivery ID / image digest；未授权则记 N/A |

最终结论：

```text
结论：通过 / 有条件通过 / 不通过

阻断问题：
1. ________________________________________________
2. ________________________________________________

非阻断问题：
1. ________________________________________________

执行结束时间：____________________________________
执行人签字：______________________________________
```

## 18. 收尾

1. 保存发布回顾 JSON、patch、Run ID、Story 编号、merge commit、image ID、delivery ID、smoke 日志和页面截图。
2. 停止 staging 时，只操作该 Compose project；不要删除共享 Docker volume 或无关容器。
3. 如使用临时网页 Webhook/Token，测试结束后在「发布设置」删除网页配置；若使用环境变量，则撤销变量并重启 PiGO Web。
4. 刷新测试工作区，确认工作树干净。
5. 不再需要时在 PiGO 中“解除注册”；该动作不删除服务器 clone，目录清理由运维另行确认。
6. 不要注销生产 `pi_go` 工作区，不要把测试 clone 推送到正式 GitHub main。

## 19. 常见阻断

| 现象 | 判断 | 处理 |
| --- | --- | --- |
| 真实运行不可用 | 模型凭据/目录未就绪 | 修复凭据后重新提交 |
| `WORKSPACE_DIRTY` | 测试 clone 有未知修改 | 查看来源，不要强制清理 |
| 只有 1–2 个开发 Agent | Planner 未按边界拆分 | 保存规划证据，多 Agent 项判失败后重跑 |
| `node --test` 失败 | 接口合同或资源清理有问题 | 进入返修，不跳过检查 |
| Docker build 失败 | Dockerfile/构建上下文不完整 | 记录部署阻断并返修应用 |
| 容器 unhealthy | `/healthz`、端口或 USER 权限问题 | 查看该容器日志，不扩大权限绕过 |
| 页面可开但 API 失败 | 前端路径、反向代理或 Content-Type 错误 | 用 curl 区分 API 与页面问题 |
| 发布按钮禁用 | hook/token/public origin 未配置 | 配置 HTTPS webhook；手工部署不能冒充 PiGO 发布通过 |
| 保存发布设置提示 Invalid request | URL 不是 HTTPS、Token 首次少于 12 字符或字段格式错误 | 核对三个字段；PiGO 公网地址只填 Origin，不带回调路径 |
| 保存后仍显示未就绪 | Token、公网地址或 Webhook 任一缺失 | 重新进入「发布设置」核对状态与配置来源；不要期待 Token 回显 |
| 发布等待回调 | 执行器未回调或认证失败 | 查 delivery ID、attempt、callback URL 和签名日志 |
| staging 成功但不能晋级 production | 页面未刷新、环境记录缺失或 staging 尚未最终成功 | 刷新后确认状态为 succeeded/ok；pending 不是成功 |
| production 产生了新镜像 digest | 执行器重新构建而不是提升不可变制品 | 停止发布，回滚并修复执行器制品晋级逻辑 |
| Agile Release 再次部署 | 执行器未区分 run 与 release 事件 | release.published 只做版本确认，不重复 build |
| GitHub 没有新 commit | PiGO 只做本地合并 | 当前产品边界；另做 SCM/CI 集成验收 |
