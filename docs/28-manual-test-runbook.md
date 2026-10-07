# 28 · 全功能测试操作手册（生产人工执行）

面向**人**的手动测试手册：在生产（Docker 生产栈）上，用**一条真实需求**贯穿主链路，
逐步核对每个界面控件与后台行为。

- 目标入口：**<https://pigo.ai2note.com>**（Cloudflare 隧道 + Cloudflare Access 身份，
  部署侧 `PI_AUTH_MODE=cloudflare`、`PI_PUBLIC_ORIGIN=https://pigo.ai2note.com`）。
- 生产项目 `pi-agent`：容器 `pi-agent-web-1` / `pi-agent-worker-1` / `pi-agent-postgres-1`
  （库 `pigo`）；宿主机目录 `/app/pi-agent`，工作区根目录 `/app/pi-agent/workspace`。
- 生产已注册工作区：`ws_b59361c80d8c478d8df7`，名称/根路径 **`pi_go`**，状态 `active`，
  默认分支 **`main`** —— **生产工作区就是 `pi_go` 这个仓库本身**。
- 另有 **36 个真实运行**（他人数据）与共享凭据（provider：`deepseek`、`openai-proxy`、`typesafe`）。
- 决策平面：`PI_DECISION_ENGINE=jev` + `PI_JEV_MODE=shadow`（**真实外发 TypeSafe，只记录不改判**）。
- **发布钩子未配置**（生产 `.env` 没有 `PI_POST_MERGE_DEPLOY_HOOK`）⇒ 发布走「未配置」分支。

> **本手册的铁律：不要创建任何 Docker 对象。** 全部操作要么在浏览器里点，
> 要么只在服务器侧读文件 / 改 `.env`（仅附录 A 一处），不要 `docker run/build`，
> 不要碰 `/app/pi-agent/**` 的代码，不要跑 `npm run gate:acceptance`、`npm run drill:rollback`。

---

## 0 怎么用这份文档

**阅读顺序**：§1 先确认你进得来 → §2 开测前体检（不通过就别往下走）→ §3 只读巡检（零风险）
→ §4 真实需求全链路（主干，会花 token 并可能改动生产检出）→ §5 边界与故障演练（**可选**，逐条
标了风险）→ §6 双语与移动端 → §7 收尾清理 → §8 结论表。

**每步的七个字段**（不要跳过任何一个）：

| 字段 | 含义 |
| --- | --- |
| 目的 | 这一步在验证什么 |
| 前置 | 必须具备的状态 |
| 操作 | **在 web 里怎么点**（控件文案 + 源码位置） |
| 期望结果 | 应该看到什么 |
| 怎么判定通过 | 可判定的判据（数字/文案/文件） |
| 失败先看哪里 | 第一现场 |
| 风险 | 见下表标签 |

**风险标签**（每步都会标）：

- `[只读]` 不产生任何写入，零 token。
- `[真实消耗 token]` 会真的调 provider（DeepSeek / OpenAI proxy / TypeSafe），**花的是真额度**。
- `[会改数据/不可逆]` 会写库、改工作区检出、删记录；部分不可逆。
- `[需管理员]` 只有 `admin` 角色能点（非管理员看到的是禁用/提示文案）。
- `[需服务器侧运维]` 只能在宿主机/SSH 上做，**UI 无入口**。

**问题记录模板**（发现任何不一致就照抄这段，一条一条填）：

```
- 步骤号：<例如 4.6>
- 期望：<文档里写的期望结果>
- 实际：<你看到的原文/数值，尽量贴原文>
- 截图：<文件名或链接>
- 时间（含时区）：<YYYY-MM-DD HH:mm CST>
- run id：<12 位以上，或 —>
- 复现步骤：<按最小步骤重写一遍，能稳定复现才写这里>
- 判断：<阻塞交付 / 疑似缺陷 / 文档问题 / 待核实>
```

---

## 1 环境与身份（生产）

### 1.1 入口与登录（人工怎么进）

- 目的：确认你进的是**生产**，并且拿到了一个真实身份。
- 前置：一台能上外网的浏览器；有 Cloudflare Access 准入（邮箱 OTP 或公司身份）。
- 操作：浏览器打开 **`https://pigo.ai2note.com`**。Cloudflare Access 会先拦一层身份页
  （输入邮箱 → 收 OTP → 通过），通过后才加载 PiGO。
  ⚠️ **`http://192.168.2.235:3100` 不是入口**：该端口只绑在服务器 `127.0.0.1`，仅供服务器本机。
- 期望结果：左侧栏顶部是「**新建任务**」（`nav.newRun`，`src/shared/i18n.ts:124`；按钮
  `src/client/App.tsx:1811`），底部账户区显示你的邮箱，页面标题
  「PiGO · 多模型开发与审核控制台」（`app.title`，`src/shared/i18n.ts:121`）。
- 怎么判定通过：① 地址栏是 `https://pigo.ai2note.com`；② 能看到「新建任务」；
  ③ 左下角「**退出登录**」（`account.logout`，`src/shared/i18n.ts:137`）指向
  `/cdn-cgi/access/logout`（`src/client/App.tsx:1867`）—— 这说明身份确实由 Cloudflare Access 提供。
- 失败先看哪里：身份页循环/401 是 Cloudflare Access 侧策略问题，不是 PiGO 的；页面白屏先看
  浏览器控制台与「系统状态」页能否打开。
- 风险：`[只读]`

### 1.2 生产 vs 演示，别搞混

| | 生产（本手册） | 演示 |
| --- | --- | --- |
| 入口 | `https://pigo.ai2note.com` | `http://192.168.2.235:3101` |
| 身份 | Cloudflare Access（真实 OTP） | development 身份头（`x-pigo-dev-email`） |
| 决策平面 | `PI_DECISION_ENGINE=jev` + `PI_JEV_MODE=shadow`（**真实外发**） | `PI_DECISION_ENGINE=mock`（无网络） |
| 数据 | 生产库 `pigo`，36 个真实运行 | 隔离库 `pigo_demo` |
| 工作区 | `pi_go`（本仓库检出） | demo 工作区根目录 |

演示环境细节见 `docs/25-demo-environment.md`；**不要**在 demo 里下生产验收结论。

### 1.3 生产风险须知（动手前读一遍）

1. **真实额度**：§4 的每次运行都会真的调 `deepseek` / `openai-proxy`，审核阶段还会真的调
   TypeSafe 决策平面。一次完整闭环（开发+检查+审核）通常 **3–15 分钟**，有真实 token 成本
   （耗时量级依据 `tests/e2e/README.md` 的 story-delivery 步骤表）。
2. **真实数据**：库里已有 **36 个真实运行**。**不要**删除、取消、重开、批量接受别人的运行
   （侧栏「最近任务」里的内容不都是你的）。
3. **合并会改生产检出**：合并（§4.6）会把运行分支 fast-forward 到工作区默认分支 `main`，也就是改
   **生产那台机器上的 `pi_go` 检出**（工作区根目录 `/app/pi-agent/workspace` 下的 `projects/pi_go`；
   布局与属主见 `docs/25-demo-environment.md`「工作区目录与挂载」；该绝对路径由根目录 + `projects/<repo>`
   约定推导，**以「工作区」页与服务器为准**）。所以**只挑低风险需求**（文档/文案/只读校验一类），
   并准备好回滚：代码回滚 `git revert <merge commit>`（`git reset --hard` 慎用，会丢未提交改动）；
   发布回滚 `npm run drill:rollback --dry-run`（脚本 `scripts/rollback-drill.sh`，**只跑 dry-run**）。
   本次生产**未配置发布钩子**，所以「合并」本身不会触发任何部署动作。
4. **决策平面在 shadow**：审核结论会触发**真实**决策评估并落审计行，但**不会改变运行结果**
   （`appliedOutcome=none`）。看到决策审计页有数据是**预期**，不是异常。
5. **不要创建 Docker 对象**：本手册没有一步需要 `docker`。

---

## 2 开测前准备（体检清单）

### 2.1 工作区：确认就是 `pi_go`

- 目的：确认真实运行的靶子是生产上的 `pi_go` 检出，且它是干净、可用的。
- 前置：§1 已登录。
- 操作：左栏点「**工作区**」（`nav.workspaces`，`src/shared/i18n.ts:128`；按钮 `src/client/App.tsx:1816`）。
- 期望结果：列表里有一条 **`pi_go`**，卡片显示 状态「**已就绪**」（`workspace.status.active`，
  `src/shared/i18n.ts:1121`）、「**分支**」= `main`（`workspace.branch`，`:1100`）、
  「**工作树**」=「**干净**」（`workspace.clean`，`:1103`）、「**关联任务**」有值（`:1104`）。
- 怎么判定通过：分支是 `main` 且工作树是「干净」。若显示「**有未提交修改**」
  （`workspace.dirty`，`:1102`）或「存在未提交修改；创建真实任务前建议先提交或清理，避免混入待审核的 Diff。」
  （`workspace.dirtyNote`，`:1107`），**先停手**：真实任务会以 `409 WORKSPACE_DIRTY` 被拒绝
  （文案 `error.WORKSPACE_DIRTY`，`:1926`）。
- 失败先看哪里：若为「**校验失败**」（`workspace.status.invalid`，`:1122`）+
  「路径校验失败：…可尝试「刷新 Git 状态」，或解除注册后重新注册。」（`workspace.invalidNote`，`:1108`），
  点卡片上的「**刷新 Git 状态**」（`workspace.refresh`，`:1112`；按钮 `src/client/WorkspacesPage.tsx:364`）。
  仍失败就是服务器侧目录/属主问题 → `docs/25`「目录所有者（双身份可写）与 `workspace-permissions` 检查」。
- 风险：`[只读]`

### 2.2 凭据：developer / reviewer 各一把，外加 TypeSafe

- 目的：确认真实执行的前置（`realRunsAvailable`）成立、双角色都有可用模型、决策平面凭据在。
- 前置：§2.1 通过。
- 操作：左栏点「**模型与凭据**」（`nav.models`，`:129`；按钮 `src/client/App.tsx:1817`）。
- 期望结果：顶部横幅是「**真实执行已启用**」（`config.realReady`，`:140`；`src/client/ModelsPage.tsx:174`）
  与「已配置至少一个 provider 凭据；创建任务时会按所选开发/审核模型组合做可用性预检。」
  （`models.readyHint`，`:847`）。卡片区至少有 `DEEPSEEK`、`OPENAI-PROXY` 两张（模型目录 provider）
  ＋「**TypeSafe · Jev 决策平面**」一张（`models.decisionProviderLabel`，`:872`）。
- 怎么判定通过：
  ① 每张卡片右上角凭据位不是「**未配置 Key**」（`models.keyMissing`，`:850`），而是掩码；
  ② 校验徽章是「**已验证**」（`models.verified`，`:857`）或「**未校验（操作者断言）**」
     （`models.asserted`，`:858`）/「**未校验**」（`models.unchecked`，`:859`）
     —— **只要不是「未配置 Key」就可以继续**（`已验证` 表示过了实时 `/models` 探测，更严格）；
  ③ TypeSafe 卡片上有「**决策平面：引擎 jev · 模式 shadow**」chip（`models.decisionEngineState`，`:875`；
     渲染 `src/client/ModelsPage.tsx:196`）。若 chip 是 warn 色，下面会写
     「已录入密钥后，还需部署侧启用 `PI_DECISION_ENGINE=jev`；此处仅保存凭据，不会启用决策平面。」
     （`models.decisionEngineDisabledHint`，`:876`）。
- 失败先看哪里：缺 `deepseek`/`openai-proxy` 任一 → 「新建任务」弹窗里对应角色会显示
  「（缺凭据）」（`createRun.missingCredentialSuffix`，`:261`）；缺 TypeSafe → §4.9 不会有新审计行。
  可在卡片输入框重录（「**安全保存**」，`models.saveKey`，`:854`）或「**删除 Key**」
  （`models.deleteKey`，`:855`）后重录 —— **不要**删别人可能依赖的 Key。
- 风险：`[只读]`（录入/删除 Key 属 `[会改数据/不可逆]`，主干不需要）

### 2.3 决策平面状态

- 目的：确认 shadow 契约的前置成立（否则 §4.9 会空转）。
- 前置：§2.2。
- 操作：留在「模型与凭据」页，看 TypeSafe 卡片。
- 期望结果：chip = 「决策平面：引擎 **jev** · 模式 **shadow**」，徽章为 ok
  （`src/client/ModelsPage.tsx:196`）。详情文案应读作「部署侧已启用 Jev 决策引擎
  （`PI_DECISION_ENGINE=jev`）；保存的密钥将由决策平面读取。」（`models.decisionEngineEnabledHint`，`:877`）。
- 怎么判定通过：engine=jev 且 mode=shadow。mode 不是 shadow 就是生产配置被改过，**先停手问运维**。
- 失败先看哪里：卡片显示 vs `/api/config/status` 的 `decisionEngine` 字段 —— 在**已登录 Access 的浏览器**里
  直接打开 `https://pigo.ai2note.com/api/config/status` 就能看到 JSON。
- 风险：`[只读]`

### 2.4 环境体检清单（一次过）

| # | 检查 | 在哪看 | 通过判据 |
| --- | --- | --- | --- |
| 1 | 服务健康 + 版本 | 「**系统状态**」（`nav.system`，`:130`）→「**版本与部署**」（`system.release.title`，`:889`） | 「Web 版本」「Worker 版本」都是版本号，**不是**「未知」（`system.unknown`，`:879`） |
| 2 | 数据库 / Worker / 磁盘 | 「系统状态」→「**基础设施**」（`system.infra.title`，`:896`） | 数据库=「**正常**」（`system.db.ok`，`:921`）、Worker=「**在线**」（`system.worker.ok`，`:922`）、磁盘=「**充足**」（`system.storage.ok`，`:924`） |
| 3 | 队列与任务可读 | 「系统状态」→「**队列与任务**」（`system.queue.title`，`:900`） | 「任务总数」（`:903`）有数字；「运行结果：已通过 {completed} · 需要人工 {needsHuman} · 失败 {failed} · 取消 {cancelled}」（`:905`）成句显示 |
| 4 | `realRunsAvailable` | 「模型与凭据」顶部横幅 / 左栏 AGENT ROUTING 卡片 | 文案是「**真实执行已启用**」（`:140`），不是「真实执行尚未启用」（`:141`） |
| 5 | 工作区 active 且非 dirty | 「工作区」→ `pi_go` | 状态「已就绪」+ 工作树「干净」 |
| 6 | 双角色可选模型 | 「新建任务」弹窗的两个下拉（`src/client/App.tsx:613`、`:619`） | 每个下拉都能选到至少一个**不带**括号后缀的模型；后缀含义见 `createRun.modelUnavailable.*`（`:262-266`） |
| 7 | 决策平面 | 「模型与凭据」TypeSafe 卡片 | chip = `引擎 jev · 模式 shadow` |
| 8 | 发布钩子 | 运行详情→「代码发布」面板（仅 `mode=real` 且 `completed` 时出现） | 发布按钮**禁用** + 提示「发布钩子或 webhook 凭据尚未配置。」（`release.notConfigured`，`:330`）—— 这是**预期**，见 §4.7 |

- 风险：`[只读]`
- 失败先看哪里：1–3 失败是部署层问题，找运维；4 失败是凭据/`PI_REAL_RUNS_ENABLED` 不满足；
  6 失败是模型允许目录或凭据可用性问题（`error.MODEL_NOT_AVAILABLE`，`:1911`）。

### 2.5 （可选）新增一个项目目录 —— 服务器侧，UI 无入口

- 目的：如果你不想用 `pi_go` 做靶子（**不推荐**：§4 的范例就是给 `pi_go` 写的）。
- 操作：「工作区」页有三个入口，都是**在 Worker 主机上**建目录/落盘，不是你本机：
  「**新建工作区目录**」（`workspace.newDir`，`:1076`）、「**注册已有目录**」（`workspace.registerExisting`，`:1077`）、
  「**从 Git 克隆**」（`workspace.clone`，`:1078`）。前提是受控项目根目录存在且对 uid 1000 可写 ——
  见 `docs/25-demo-environment.md`「工作区目录与挂载」「目录所有者（双身份可写）」两节。
- 风险：`[需服务器侧运维]` + `[会改数据/不可逆]`

---

## 3 只读巡检（先做，零风险）

逐页走一遍，只核对「看什么 / 期望」，不点任何会写数据的按钮。

### 3.1 工作流（默认控制台）

- 目的：熟悉入口与最近任务。
- 操作：左栏点「**工作流**」（`nav.workflow`，`:125`；按钮 `src/client/App.tsx:1813`）。
- 看什么/期望：
  - 顶部「**新建任务**」（`nav.newRun`，`:124`）按钮；
  - 左栏 AGENT ROUTING 卡片：「**配置或轮换个人 Key**」（`nav.configureKeys`，`:132`；按钮 `:1827`）、
    「**开发**」「**审核**」（`role.developer`/`role.reviewer`，`:138-139`；`:1825-1826`）两行 provider+模型、
    底部「真实执行已启用」（`:1828`）；
  - 左栏「**最近任务**」（`nav.recentRuns`，`:133`）列表 + 搜索图标 + 右上「清理」按钮
    （title=「清理 7 天前已结束的任务」，`nav.cleanupTitle`，`:134`；按钮 `src/client/App.tsx:1834`）
    —— **本次不要点它**；
  - 右上角「**界面语言**」下拉（`locale.label`，`:122`；`src/client/App.tsx:1891-1899`），选项「中文」「English」。
- 怎么判定通过：以上控件都在；点任一运行条目能进运行详情。
- 失败先看哪里：列表空显示「还没有任务」（`nav.empty`，`:135`）；工具条缺失 → 前端版本/构建问题。
- 风险：`[只读]`

### 3.2 需求历史

- 操作：左栏「**需求历史**」（`nav.history`，`:126`；按钮 `src/client/App.tsx:1814`）。
- 看什么/期望：副标题「搜索过去任务里写下的详细需求，展开查看全文、人工备注，并可一键复制复用。」
  （`history.subtitle`，`:817`）；右上有「{count} 条记录」（`history.count`，`:818`）。
- 操作（只读）：搜索框输入片段（占位符「搜索标题、需求正文或人工备注…」，`history.searchPlaceholder`，
  `:819`；`src/client/HistoryPage.tsx:92`）；「按状态筛选」下拉（`history.filterAria`，`:822`；`HistoryPage.tsx:97`）
  选「已通过」（`run.state.completed`，`:834`）。
- 期望结果：列表按更新时间倒序；点开一行展开「FULL REQUIREMENT」全文与「HUMAN NOTES · n」
  （`HistoryPage.tsx:141`），带「**复制**」（`common.copy`，`:113`）与「**打开任务**」（`history.openRun`，`:827`）。
- 怎么判定通过：搜索/筛选真的改变条数；展开能看到需求全文；「打开任务」跳到运行详情。
  空结果显示「没有匹配的需求，换个关键词或状态试试。」（`history.emptyFiltered`，`:825`）。
- 失败先看哪里：红条「加载需求历史失败。」（`history.loadFailed`，`:815`）；「复制」失败且红条是
  「复制失败，请展开后手动选择文本复制。」（`history.copyFailed`，`:816`）→ 浏览器剪贴板权限。
- 风险：`[只读]`

### 3.3 敏捷

- 操作：左栏「**敏捷**」（`nav.agile`，`:127`；按钮 `src/client/App.tsx:1815`）。
- 看什么/期望：顶部七个按钮「**新建项目**」「**新建冲刺**」「**新建故事**」「**模板管理**」「**度量**」
  「**发布回顾**」「**发布管理**」（`agile.newProject`/`newSprint`/`newStory`/`templates`/`metrics`/`releaseReview`/`releaseManage`，
  `:1298-1304`；按钮 `src/client/AgilePage.tsx:639-645`）；下方「**Sprint 看板**」（`agile.board.title`，`:1323`）
  +「**故事列表**」（`agile.storyList.title`，`:1330`）+「**冲刺与发布**」（`agile.sprintsReleases.title`，`:1331`）。
- 怎么判定通过：「项目」选择器（`agile.project`，`:1308`；`AgilePage.tsx:769`）能选到生产上已有的项目；
  看板列名是「待办 / 开发中 / 审核中 / 待验收 / 完成 / 阻塞」（`:1324-1329`）。
- 失败先看哪里：空态「还没有项目」+「先新建一个项目，再在其中创建用户故事与冲刺。」
  （`agile.noProjects`/`noProjectsHint`，`:1306-1307`）→ 生产还没有敏捷数据，§4.2 会创建。
- 风险：`[只读]`

### 3.4 工作区 / 模型与凭据 / 系统状态

- 操作：分别点左栏「工作区」「模型与凭据」「系统状态」。
- 看什么/期望：
  - 工作区：见 §2.1；卡片底部有「**刷新 Git 状态**」「**默认检查**」「**解除注册**」
    （`workspace.refresh`/`workspace.editChecks`/`workspace.unregister`，`:1112`/`:1114`/`:1116`；
    `WorkspacesPage.tsx:364-368`）；非所有者/非管理员会看到「**只读**」徽章（`workspace.readOnly`，`:1099`）
    且按钮禁用（title 提示见 `workspace.roRefresh`/`roEditChecks`/`roUnregister`，`:1111`/`:1113`/`:1115`）。
  - 模型与凭据：见 §2.2/§2.3；底部有「默认选择：开发 {developer} · 审核 {reviewer}（…任务创建后模型即固化…）。」
    （`models.defaults`，`:856`）。
  - 系统状态：见 §2.4；脚注「系统状态每 15 秒自动刷新；暂停后仍可手动刷新。所有数值均为只读聚合，
    不包含密钥、环境变量或服务器路径。」（`system.footnote`，`:920`），右上「**暂停自动刷新**」/「**继续自动刷新**」/
    「**手动刷新**」（`system.pauseAuto`/`resumeAuto`/`refresh`，`:885`/`:884`/`:886`；`SystemStatusPage.tsx:88-93`）。
- 怎么判定通过：系统状态五张卡（版本与部署 / 基础设施 / 队列与任务 / 用量与成本 / 最近 24 小时异常）都渲染；
  点「手动刷新」后「更新于 {time}」（`system.updatedAt`，`:883`）时间会变。
- 失败先看哪里：红条「系统状态不可用：{message}」（`system.errorPrefix`，`:887`）；单项显示「未知」
  （`system.unknown`，`:879`）/「不可用」（`system.unavailable`，`:880`）是**如实报告**，不是崩溃。
- 风险：`[只读]`

### 3.5 账户管理（管理员可见）

- 操作：左栏「**账户管理**」（`nav.accounts`，`:131`；**只有 `isAdmin` 才渲染入口**，
  `src/client/App.tsx:1821`）。
- 看什么/期望：副标题「管理本实例的用户角色与状态，并为用户分配工作区 read/write 授权。…所有变更都会写入审计记录。」
  （`accounts.subtitle`，`:1135`）；表头「邮箱 / 角色 / 状态 / 创建时间 / 最近登录 / 拥有任务 / 拥有工作区」
  （`:1142-1148`）；每行有「**工作区授权**」（`accounts.grants`，`:1166`）展开按钮；底部
  「审计：角色/状态变更会记录 actor 与目标账户的 before/after（user_audit 表）。…」（`accounts.footnote`，`:1175`）。
- 怎么判定通过：能看到你自己的邮箱；「角色」下拉有「管理员/普通用户」（`:1149-1150`）、
  「状态」下拉有「已启用/已禁用」（`:1151-1152`）。**本次不要改任何账户**。
- 失败先看哪里：非管理员看到「**仅管理员可见**」（`accounts.adminOnly`，`:1136`）+
  「账户管理（角色、状态与工作区授权）仅对管理员开放。…」（`accounts.adminOnlyHint`，`:1137`）。
- 风险：`[只读]`（改动才是 `[需管理员]` + `[会改数据/不可逆]`）

---

## 4 真实需求全链路（主干）

**这一节会真的花 token、真的改生产检出。** 一次只跑一条需求，跑完走 §7 清理。

### 4.1 填写位：一条真实需求（先把这张表填完再动手）

```
需求名称：______________________________________________
目标仓库（默认 pi_go）：________________________________
工作区（生产工作区名/ID）：pi_go  /  ws_b59361c80d8c478d8df7
验收标准（可执行检查命令，逐行一条）：
  ______________________________________________________
  ______________________________________________________
交付物（具体文件清单）：
  ______________________________________________________
不做（边界）：
  ______________________________________________________
风险确认：这条需求合并到 main 后影响可接受？  是 / 否（否 → 换一条）
回滚方式：git revert <merge commit> / git reset --hard <merge 前 HEAD>
```

**范例 A —— 针对 `pi_go` 本身（可直接照用）**

> 现状（已核对源码）：运行详情页的标签页里，`活动`/`审核`/`检查`/`预算与用量`/`决策审计` 都走 i18n
> （`topology.tabs.*`，`src/shared/i18n.ts:220-223`、`:347`），但 **`Agents` 与 `Diff` 两个标签是硬编码英文字面量**
> （`src/client/App.tsx:2020` 的 `Agents ${…}`、`src/client/App.tsx:2022` 的 `"Diff"`）。
> 切到中文时这两个标签不跟着变 —— 这是一个**真实的小缺陷**，改动面极小、合并风险极低。

```
需求名称：补齐运行详情页 Agents / Diff 两个标签页的中英文文案
目标仓库：pi_go
背景/问题：运行详情页的标签页文案除 Agents 与 Diff 外都走 i18n；这两个是硬编码英文，
          与「界面语言=中文」时期望的中文不一致（src/client/App.tsx:2020、:2022）。
要做（范围）：
  1) 在 src/shared/i18n.ts 新增 topology.tabs.agents / topology.tabs.diff 两个 key（zh + en 两份）；
  2) 在 src/client/App.tsx 的 detail-tabs 改用 t("topology.tabs.agents") / t("topology.tabs.diff")，
     保留「Agents {n}」里的计数含义与「Diff」的语序含义；
  3) 不改任何其他文案、不改 CSS、不改 src/shared/i18n.ts 里已有 key 的值。
不做（边界）：
  - 不重构 detail-tabs 结构、不引入新依赖、不动 tests/e2e/**；
  - 不要让 agent 自己 commit / push（产品按轮提交，见 src/worker/round-commit.ts:106）。
验收标准（提交为运行的「检查命令」，每行一条，离线自足）：
  grep -q 't("topology.tabs.agents")' src/client/App.tsx
  grep -q 't("topology.tabs.diff")' src/client/App.tsx
  test "$(grep -c '"topology.tabs.agents"' src/shared/i18n.ts)" -ge 2
  test "$(grep -c '"topology.tabs.diff"' src/shared/i18n.ts)" -ge 2
交付物：src/shared/i18n.ts、src/client/App.tsx
```

> **为什么验收命令写成 `grep`/`test` 而不是 `npm run typecheck`**：运行提交的检查命令在**沙箱里的该轮
> worktree** 内以 `/bin/sh -lc` 执行，且 `network: "none"`（`src/worker/index.ts:1666-1681`，`network` 在 `:1678`）；沙箱只挂载
> **本次运行的 worktree + 仓库 `.git`**（`src/worker/sandbox.ts:52-56`），而 git worktree 是独立目录 ——
> 所以里面**没有 `node_modules`、也没有网络装依赖**。**checks 必须离线自足。**
> （此结论由上述源码得出，**未在生产实测**；`typecheck`/`vitest`/`eslint` 放到 §4.8 的人工验收里跑。）

**范例 B —— 把你手上任意一条真实需求改写成这个格式**

```
需求名称：<一句话，动词开头，能被 grep 到（例：为 XX 接口补 400 校验）>
目标仓库：<工作区名；默认 pi_go>
背景/问题：<现状怎么错 + 为什么是缺陷（贴一行源码/文案/接口作为证据）>
要做（范围，逐条编号）：
  1) <具体文件 + 具体改法>
  2) …
不做（边界，必填）：
  - 不重构 / 不动公共 API / 不升级依赖 / 不动 CI 与部署配置 / 不动 tests/e2e/**
  - 不要让 agent 自己 commit / push（产品按轮提交：src/worker/round-commit.ts:106）
验收标准（提交为运行的「检查命令」，逐行一条，必须离线自足）：
  grep -q '<可判定的标记>' <文件>
  test "$(grep -c '<标记>' <文件>)" -ge <数量>
交付物：<文件清单>
风险确认：<合并到 main 的后果 + 回滚方式>
```

**硬性纪律**：需求必须 ① 有**可执行的**验收检查（checks）；② 写清**不做什么**（边界）；
③ 明确**禁止 agent 自己 commit/push** —— 提交本轮改动是**产品**的职责：
`commitRoundChanges` 在每轮的 diff/检查/审核**之前**把工作树改动提交到运行分支
（`src/worker/round-commit.ts:106`，事件 `round.committed`/`round.commit_failed` 见 `:36-37`）；
若 agent 也提交，会和产品提交打架（实测结论见 `tests/e2e/README.md`「为什么任务要求 Agent 提交」）。

### 4.2 建项目 / 冲刺 / 故事（story）

- 目的：用敏捷结构承载真实需求，与产品主链路对齐。
- 前置：§2.4 体检通过；范例 A 已填好。
- 操作：
  1) 「敏捷」页点「**新建项目**」（`agile.newProject`，`:1298`）→ 表单标题「**新建项目**」
     （`agile.projectForm.title`，`:1553`）：填「**项目名称**」（`:1555`，占位符「认证服务」，`:1556`）与
     「**项目前缀**」（`:1557`，占位符 `AUTH`；2–10 位、字母开头、同用户下唯一，规则见 `:1554`）→
     点「**创建**」（`agile.projectForm.create`，`:1558`；`src/client/AgilePage.tsx:658-659`）。
  2) 点「**新建冲刺**」（`agile.newSprint`，`:1299`）→「**新建冲刺**」表单（`:1559`）：「**冲刺名称**」
     （`:1561`，占位符 `Sprint 1`）+「**冲刺目标**」（`:1562`）→「**创建**」（`AgilePage.tsx:672-673`）。
  3) 点「**新建故事**」（`agile.newStory`，`:1300`）→「**新建用户故事**」表单（`:1564`）：
     「**标题**」（`:1565`）、「**描述**」（`:1567`）、「**验收标准（每行一条）**」（`:1569`）、
     「**完成定义（每行一条）**」（`:1571`）、「**优先级**」（`:1573`，选项 必须/应该/可以/本次不做，`:1349-1352`）、
     「**估算（点）**」（`:1574`）、「**工作区**」（`:1575`，**必须选 `pi_go`**）、
     「**冲刺**」（`:1576`，可留「未分配（待办）」，`:1312`）、「**模板**」（`:1577`，默认「不使用」`:1578`）、
     「**最大并行**」（`:1579`）、「**开发模型**」「**审核模型**」（`:1581-1582`，可留「默认」`:1583`）、
     四个预算字段「**预算 Token**/**预算成本（$）**/**模型调用**/**时长（秒）**」（`:1584-1587`，
     占位符「不限」`:1588`）→ 点「**创建故事**」（`agile.storyForm.createStory`，`:1589`）。
- 期望结果：故事出现在看板「**待办**」列（`agile.board.todo`，`:1324`）与故事列表，状态「**待办**」
  （`agile.storyStatus.backlog`，`:1353`）。
- 怎么判定通过：点故事卡片打开右侧详情面板，「**验收标准**」（`agile.detail.criteria`，`:1404`）能看到你填的每条；
  「**工作区**」（`agile.detail.workspace`，`:1403`）显示 `pi_go`。
- 失败先看哪里：红条「创建故事失败」（`agile.error.createStory`，`:1851`）/「请先创建或选择项目」
  （`agile.error.selectProjectFirst`，`:1848`）；表单级错误见 `agile.error.form*`（`:1867-1883`）。
- 风险：`[会改数据/不可逆]`（删除故事见 §7）

### 4.3 标为「就绪」并提交为运行

- 目的：进入主链路，看清「提交为运行」到底做了什么。
- 前置：§4.2 的故事存在且工作区已选。
- 操作：
  1) 点「**标为就绪**」（`agile.markReady`，`:1320`；按钮 `AgilePage.tsx:828`、`:1262`）。
  2) 详情面板右下点「**提交为运行**」（`agile.detail.submit`，`:1413`；按钮 `AgilePage.tsx:1271`）。
     `status !== "ready"` 时按钮**禁用**，旁边提示「只有「就绪」状态的故事可以提交为运行。」
     （`agile.detail.hintNotReady`，`:1415`）。
  3) 弹浏览器确认框：「将故事「{title}」提交为真实运行？\n\n任务文本会包含描述、验收标准与完成定义，
     检查命令来自所选工作区。」（`agile.detail.submitConfirm`，`:1414`；`AgilePage.tsx:391`）→ 确认。
- 会发生什么（`mode` 的含义）：`mode` 由 `config.realRunsAvailable` 决定 —— 为真即 **"real"**
  （真实运行：会改 worktree、花 token、检查命令来自所选工作区），否则回落 **"demo"**
  （`AgilePage.tsx:390`；两模式文案见 `createRun.modeReal`/`createRun.modeDemo`，`:247-248`）。
  生产体检通过时是 **real**，面板底部会写「将以真实运行执行，检查命令来自所选工作区。」
  （`agile.detail.hintReal`，`:1417`）。
- 期望结果：故事状态转「**开发中**」（`agile.storyStatus.in_progress`，`:1355`）；详情里
  「**关联运行（{count}）**」（`agile.detail.linkedRuns`，`:1407`）出现一条运行，条目含
  「第 {round} 轮」「意见 x/y」「检查 x/y」「成本 $…」（`:1409-1412`）；点运行 id（`AgilePage.tsx:1250`）
  跳到「工作流」的运行详情。
- 怎么判定通过：侧栏「最近任务」出现同名新任务；运行详情顶部有「**真实工作区**」chip
  （`run.realChip`，`:143`；`src/client/App.tsx:1889`）。
- 失败先看哪里：红条「提交为运行失败」（`agile.error.submitStory`，`:1853`）；真实原因看 `code`
  （如 `error.WORKSPACE_DIRTY` `:1926`、`error.PERSONAL_CREDENTIALS_REQUIRED` `:1910`、
  `error.MODEL_NOT_AVAILABLE` `:1911`）。
- 风险：`[真实消耗 token]` + `[会改数据/不可逆]`

> 等价路径（不用敏捷）：左栏「**新建任务**」→「**创建开发任务**」弹窗（`createRun.title`，`:244`）→
> 点「**真实开发**」（`createRun.modeReal`，`:248`；按钮 `src/client/App.tsx:567`）→ 填「**任务名称**」（`:251`）、
> 选「**开发工作区**」（`:255`）、填「**需求与验收条件**」（`:271`，可点「**最近需求 · 点击填入**」
> `createRun.recent`，`:272`）、填「**检查命令（每行一个）**」（`:273`）→ 点「**开始真实开发**」
> （`createRun.submitReal`，`:274`；按钮 `App.tsx:663`）。注意该弹窗**默认是「流程演示」模式**
> （`App.tsx:479`），不切过去就跑了演示任务；「真实开发」在 `realRunsAvailable` 为假时禁用（`:567`），
> 此时会提示「演示事件不会调用模型或修改仓库。」（`createRun.demoNotice`，`:249`）。
> 选中 dirty 工作区时按钮直接禁用并显示「**工作区存在未提交修改**」+「真实任务默认拒绝在 dirty 仓库上启动。
> 请先提交或清理，然后刷新 Git 状态。」（`createRun.dirtyTitle`/`dirtyHint`，`:268-269`；`App.tsx:629-630`）。

### 4.4 在「工作流」观察流水线 / 轮次 / 拓扑

- 目的：确认运行真的在跑，且拓扑与里程碑事件对得上。
- 前置：§4.3 已创建运行。
- 操作：左栏「工作流」→ 点该运行条目。
- 看什么/期望：
  - 顶部「REVIEW ROUND」+「第 n / 最多 m 轮」（`src/client/App.tsx:1939-1940`）；未到终态时右上「**停止**」
    （`run.stop`，`:144`；`App.tsx:1890`）；完成且未合并未发布时会出现「**重新打开**」（`run.reopen`，`:146`；`App.tsx:1942-1943`）；
  - 指标四格：「**状态**」「**耗时**」`Tokens`「**估算成本**」（`metrics.state`/`duration`/`cost`，`:151`/`:153`/`:156`），
    成本副标题是「**当前统计值**」（`metrics.costCurrent`，`:158`；演示任务才是「演示估算值」`:157`）；
  - 「**工作流拓扑**」（`topology.title`，`:217`；`App.tsx:1998`）：任务准备 → 质量检查 → OpenAI 审核 →
    DeepSeek 开发 → 交付完成（`flow.task.label`/`flow.checks.label`/`flow.reviewer.label`/`flow.developer.label`/`flow.complete.done`，
    `:232-238`）；多任务时开发节点显示「DeepSeek ×{count}」（`:236`）；返修轮出现「round {round} · 返修」
    （`flow.rework.label`，`:243`）；节点/连线带状态色（`roundStatus.*`，`:224-231`）；右上角有 `LIVE` 指示。
- 怎么判定通过：见 §4.3 的期望里程碑事件顺序（E2E-01b 的实测契约，`tests/e2e/README.md`「E2E-01b」一节）：
  `run.created → workspace.preparing → agent.started/round.started → developer.started → developer.completed
   → checks.started → check.started → check.passed → review.started → review.approved`
  —— 在「活动」标签页的事件流里按 seq 递增出现。
- 失败先看哪里：节点长时间停在「开发中」→ 去「活动」看最后一条事件时间戳；卡在 `workspace.preparing`
  → 回到 §2.1（dirty/权限）。
- 风险：`[只读]`

### 4.5 运行详情：逐个标签页核对

运行详情是**实时流**更新（`EventSource('/api/runs/:id/stream')`，`src/client/App.tsx:1603`），
**没有独立的「刷新」按钮**；要强制重取就切走视图再切回，或重新加载页面。标签页定义在
`src/client/App.tsx:2017-2028`。

#### 4.5.1 活动（`topology.tabs.activity`，`:220`）
- 看什么：`ActivityPanel`（`App.tsx:2031`）编排时间线。空态「等待事件」（`activity.empty`，`:278`）。
- 判定：事件按 seq 递增；能从 `developer.*`、`check.*`、`review.*` 看出轮次推进。
- 失败先看：「系统状态」→「最近 24 小时异常」是否有对应类别（`system.failure.*`，`:927-931`）。
- 风险：`[只读]`

#### 4.5.2 Agents（标签字面量 `Agents {n}`，硬编码；`App.tsx:2020`）
- 看什么：`SubAgentsPanel`（`App.tsx:721-732`）主 Agent 的任务计划与子任务。空态「主 Agent 尚未生成任务计划」
  （`agents.empty`，`:281`）。
- 判定：单 Agent 任务只有主计划；并行任务会显示多个子任务（契约见 `tests/e2e/README.md` E2E-04）。
  ⚠️ 该标签**没有 i18n**（其余标签都有 key，它没有）—— 这正是范例 A 要修的点。
- 风险：`[只读]`

#### 4.5.3 审核（`topology.tabs.review`，`:221`）
- 看什么：`ReviewPanel`（`App.tsx:2033`）结构化审核意见；已解决的带「**已解决**」（`review.resolved`，`:280`）。
  空态「尚无审核问题」（`review.empty`，`:279`）。
- 判定：每条意见有严重度与位置；若本轮按「只修阻断项」受理，顶部有「第 {round} 轮按「只修阻断项」范围受理：…」
  （`review.deferred`，`:289`；`App.tsx:848`）。
- 风险：`[只读]`

#### 4.5.4 Diff（标签字面量 `Diff`，硬编码；`App.tsx:2022`）
- 看什么：`DiffPanel`（`App.tsx:2034`）补丁预览 + 三个按钮：「**下载完整 Diff (.patch)**」（`diff.download`，`:284`；
  `App.tsx:769`）、「**导出补丁 (.patch)**」（`diff.exportPatch`，`:285`；`:775`）、「**创建合并请求**」
  （`diff.createMr`，`:286`；`:780`，仅在 `mergeRequestConfigured` 时出现）。空态「尚无代码变更」
  （`diff.empty`，`:288`）。提示「页面预览可能被截断；完整内容以制品下载为准。」（`diff.previewHint`，`:287`；`:784`）。
- 判定（本步最关键）：**Diff 里只应包含你需要求的文件**（范例 A = `src/shared/i18n.ts` + `src/client/App.tsx`）。
  多出任何文件都是缺陷。
- 失败先看：文件名清单；同时回 §2.1 确认工作区真的干净。
- 风险：`[只读]`

#### 4.5.5 检查（`topology.tabs.checks`，`:222`）
- 看什么：`ChecksPanel`（`App.tsx:2035`）每条检查命令的通过/失败与 `exit N`（title=「进程退出码」
  `checks.exitCodeTitle`，`:290`；`App.tsx:964`）。
- 判定：你提交的 `grep`/`test` 检查**全部通过**；若失败过一次，应能看到退回开发的痕迹
  （事件 `checks.returned`，「检查失败，已退回 Developer 修复」，`src/worker/index.ts:2349`）。
- 失败先看：哪条命令失败 + 它的 stderr；注意 checks 在沙箱内**无网络**（§4.1 说明）。
- 风险：`[只读]`

#### 4.5.6 预算与用量（`topology.tabs.budget`，`:223`）
- 看什么：`BudgetPanel`（`App.tsx:2036`）四行配额（`Tokens` / 「**成本 (USD)**」/「**模型调用次数**」/「**时长 (秒)**」，
  `budget.tokens`/`cost`/`modelCalls`/`duration`，`:332-335`），未设上限显示「**未设置上限**」（`budget.noLimit`，`:336`），
  否则「剩余 {value}」（`:337`）；下面按角色列用量。
- 判定：空态「尚无按 Agent 统计的用量（演示任务不产生真实用量）。」（`budget.empty`，`:338`；`App.tsx:1034`）
  —— 生产**真实**运行不该出现这句；角色名里的「**决策平面**」（`budget.roleDecision`，`:342`；
  `src/client/budget-roles-view.ts:72`）是决策评估的用量，属预期。
- **成本未知不得显示 `$0.00`**：无法计价时显示「**未知**」（`budget.costUnknown`，`:340`；
  `src/client/budget-roles-view.ts:55-57`），并给出「有 {count} 次调用未计价（暂无该 provider 的价格表），未计入费用。」
  （`budget.unpricedCalls`，`:341`）或「有 {count} 次调用的 provider 用量无法确认，未计入费用。」（`budget.unknownCalls`，`:339`）。
- 失败先看：出现 `$0.000` 且语义是「未知」→ 按 §0 模板记录（AT-JEV-062 类真实缺陷）。
- 风险：`[只读]`

#### 4.5.7 决策审计（`topology.tabs.decisions`，`:347`）
- 看什么：`DecisionsPanel`（`App.tsx:2037`；`src/client/DecisionsPanel.tsx`）—— 详细核对见 §4.9。
- 风险：`[只读]`

### 4.6 人工闸门：为什么不会自动合并，怎么合并

- 目的：证明**产品绝不自动合并**，合并是一次显式的人类动作。
- 前置：运行已到「**已通过**」（`run.state.completed`，`:834`）。
- 操作（先取证再合并）：
  1) 在运行详情滚到「**代码发布**」（`release.title`，`:309`；`ReleasePanel`，`src/client/App.tsx:918`）
     —— **只有 `state === "completed"` 且 `mode === "real"` 才渲染**（`App.tsx:873`）。
  2) 确认此时**没有**任何合并痕迹：「**合并结果**」显示「**未合并**」（`release.notMerged`，`:321`；`App.tsx:925`），
     状态 chip 是「**等待合并审批**」（`release.statusAwaitingMerge`，`:314`；`App.tsx:907-908`）；
     「验收快照」（`acceptance.title`，`:291`）里**不应**出现「已合并 {commit} → {branch}」（`acceptance.merged`，`:307`）。
- 怎么判定通过（为什么不会自动合并）：合并只由管理员显式动作写入 —— `POST /api/runs/:id/merge` 是唯一入口
  （`src/server/index.ts:2420`），且它从不触发发布（`tests/e2e/README.md`「合并后发布」有实测结论）。
  E2E-01b 在合并**之前**断言 `run.merge` 为空、无 `run.merged`/`run.release_*` 事件、刷新后工作区 HEAD 未移动
  （`tests/e2e/README.md`「E2E-01b」）。
- 操作（合并）：
  - **管理员**在「代码发布」面板点「**合并审核代码**」（`release.mergeAction`，`:326`；按钮 `App.tsx:935-936`，
    仅 `!run.merge` 时出现）→ 确认框「确认把任务「{title}」审核通过的 commit 合并到工作区默认分支？\n\n
    此操作不会自动发布。」（`release.mergeConfirm`，`:310`）→ 确认。
  - 若运行停在「**需要人工处理**」（`run.state.needs_human`，`:835`），人工面板（`human.title`，`:628`；
    `HumanInterventionPanel`）里勾上「**审批通过后合并到工作区默认分支（仅管理员；冲突会被拒绝且不修改工作区）**」
    （`human.mergeOption`，`:632`；`App.tsx:1461`）再点「**接受交付**」（`decision.accept`，`:622`；`App.tsx:1477-1478`），
    会「先合并再完成」（确认框会附「已勾选「合并到工作区默认分支」：将先合并再完成（冲突会被拒绝，工作区保持不变）。」
    `human.approveMergeSuffix`，`:640`）。
- 期望结果（合并后应显示什么）：
  - 状态 chip →「**已合并，等待发布审批**」（`release.statusMergedAwaiting`，`:313`；`App.tsx:908`）；
  - 「**合并结果**」显示 `<commit 前 12 位> → main`（`release.mergeResult`，`:320`；`App.tsx:925`）；
  - 「验收快照」备注行出现「已合并 {commit} → {branch}」（`acceptance.merged`，`:307`；`App.tsx:828`）；
  - 「工作区」页 `pi_go` 点「刷新 Git 状态」后 HEAD 前移到该 merge commit。
- 怎么判定通过：合并结果的 commit 与刷新后工作区 HEAD **一致**，且工作树仍「干净」。
- 失败先看哪里：
  - 按钮点不动 → 非管理员：面板处显示「**只有管理员可以执行合并和发布。**」（`release.adminOnly`，`:331`；`App.tsx:949`）
    或「仅管理员可以合并到工作区默认分支（正在确认账户角色…）。」（`merge.optionLoading`，`:676`）/
    「…请让管理员在「账户管理」中调整你的角色。」（`merge.optionDenied`，`:677`）；
  - API 403 `ADMIN_REQUIRED`（`src/server/index.ts:2428`）；409 `RUN_NOT_MERGE_READY`（`:2429`，只有
    `state==="completed"` 能合并）；冲突 `error.MERGE_CONFLICT`（`:1916`）/`error.MERGE_FAILED`（`:1917`）；
  - **最阴的坑**：接口 200 但 HEAD 没动 —— 说明本轮工作树改动没提交到运行分支（E2E-01b 记录的
    「fast-forward 到基线的静默 no-op」）。产品侧修复在 `src/worker/round-commit.ts:106`；仍复现就按 §0 记录。
  - 工作区恢复相关提示：`merge.restored`（`:678`）/`merge.restoreFailed`（`:679`）。
- 风险：`[需管理员]` + `[会改数据/不可逆]`（改生产 `pi_go` 检出）+ `[需服务器侧运维]`（回滚）

### 4.7 发布：UI 入口、`environment` 含义、未配置钩子的真实分支

- 目的：如实核对「未配置钩子」这条分支；「成功发布」分支见附录 A（可选）。
- 前置：§4.6 已合并。
- `environment` 是什么：「**发布环境**」（`release.environment`，`:322`）是**你要发布到的环境名字符串**
  （面板里的输入框，最多 64 字符；`App.tsx:941`），会随记录落库、成为幂等标识
  （`release.deliveryId`，`:323`）语义的一部分。它**不是** PiGO 去挑环境，而是告诉你的部署系统「这次发到哪」。
  生产默认框里是 `production`（`App.tsx:862`）。未发布时幂等标识显示「发布时生成」（`release.deliveryIdGenerated`，`:324`）。
- **未配置钩子的期望（生产实况，两处都要核）**：
  1) **UI**：因 `/api/config/status` 返回 `releaseConfigured=false`（`src/server/index.ts:848`），
     「**确认发布**」（`release.confirm`，`:329`）按钮**被禁用**（`disabled={… || configured === false}`，
     `App.tsx:942`），旁边显示「**发布钩子或 webhook 凭据尚未配置。**」（`release.notConfigured`，`:330`；`App.tsx:947`）。
     ⇒ **UI 上够不到 409**，只能从 API 观测。
  2) **API**：`POST /api/runs/:id/publish` 直接 **409**，`code: "RELEASE_NOT_CONFIGURED"`，
     `error` 是 `planPostMergeDeploy` 的原因串（`hook not configured（未设置 PI_POST_MERGE_DEPLOY_HOOK）`，
     `src/server/run-merge.ts:55`；路由 `src/server/index.ts:2465-2466`），**不写 `run.release`、无 `run.release_*` 事件**
     （E2E-01b 的显式断言，`tests/e2e/README.md`）。
  - 怎么判定通过：① 按钮禁用 + 那句提示；②（可选，需管理员 + Access 会话）在**已登录 Access 的浏览器**里对
    `https://pigo.ai2note.com/api/runs/<runId>/publish` 发一个 POST，能看到 409 + `RELEASE_NOT_CONFIGURED`。
    **不要把 409 当缺陷** —— 这是「未配置」的**如实拒绝**。
  - **不许假装发布成功**：没配钩子就不存在「发布成功」，验收记录里写「未配置，未发布」。
- 别搞混：「敏捷」页「发布管理/发布回顾」里的「**发布**」用的是**同一个**钩子（`src/server/index.ts:1518`），
  但**行为不同**：那条链路**不**因未配置而拒绝 —— 它会把版本标记为已发布，并把部署结果如实记成
  「**未配置部署钩子**」（`agile.deployStatus.not_configured`，`:1344`；状态枚举 `src/shared/agile.ts:98`），
  同样要求管理员（`agile.publish.help`，`:1391`）。本次主干不涉及它。
- 失败先看哪里：409 的 `code` 有四种：`RELEASE_NOT_CONFIGURED` / `RELEASE_CONFIG_INVALID`
  （钩子既不是 `http(s)://` 也不是 `cmd:`）/ `RELEASE_AUTH_NOT_CONFIGURED`（webhook 缺 token）/
  `RELEASE_CALLBACK_NOT_CONFIGURED`（webhook 缺 `PI_PUBLIC_ORIGIN`）（`src/server/index.ts:2466-2473`）；
  另有 `RELEASE_STATE_CHANGED`/`RELEASE_IN_PROGRESS`（`:2489-2499`）。
- 风险：`[需管理员]` + `[需服务器侧运维]`（配钩子）

### 4.7-A 附录 A（可选，运维）：临时挂一个无害钩子，验「成功发布」分支

> **只在你想验「配置了钩子」时做，做完必须还原。** 需要服务器侧写权限；
> **不要创建任何 Docker 对象**（下面只有一次容器重建）。

- 目的：让「成功发布」分支可观测（命令钩子：payload 从 stdin 落盘，不碰生产业务）。
- 事实基础：命令钩子以 `/bin/sh -c <command>` 执行，60s 超时，环境被裁剪成只剩 `PATH`，
  run 元数据从 **stdin** 传入（`src/server/release-execution.ts:53-66`）。demo compose 用的就是
  `cmd:sh -c 'cat > /app/data/last-release.json'`（`deploy/docker/compose.demo.yaml:118-122`）。
- 操作（服务器侧）：
  1) 备份：`cp /app/pi-agent/.env /app/pi-agent/.env.bak.$(date +%s)`
  2) 在 `/app/pi-agent/.env` 追加：`PI_POST_MERGE_DEPLOY_HOOK=cmd:sh -c 'cat > /app/data/last-release.json'`
  3) ⚠️ **确认宿主机 compose 真把这个变量传进 web 容器**：`/app/pi-agent/compose.yaml` 的 web 服务
     environment 里必须有 `PI_POST_MERGE_DEPLOY_HOOK`（`docs/25` 明确警告过：宿主机 compose 副本曾落后
     仓库一整段 Jev 变量，导致「改了 `.env` 却不生效」）。
  4) 重建 web（**不要 build**）：
     `docker compose -f /app/pi-agent/compose.yaml --env-file /app/pi-agent/.env -p pi-agent up -d --force-recreate web`
     —— 这是本手册**唯一**允许的 docker 动作；**不想动 docker 就跳过整个附录 A**，
     §4.7 的「未配置」分支已足以作为本次验收结论。
  5) 回页面刷新运行详情：「代码发布」面板的「**确认发布**」应变为可点；填「发布环境」（如 `production`）
     → 点「确认发布」→ 确认框「确认发布任务「{title}」？\n\ncommit：…\n环境：…」（`release.publishConfirm`，`:312`）。
- 期望结果（成功分支）：状态 chip 可能是「**发布中**」（`release.statusPublishing`，`:318`）→
  「**发布成功**」（`release.statusSucceeded`，`:315`）；「**幂等标识**」显示一个 delivery id（`release.deliveryId`，`:323`）；
  事件的 `run.release_started` 与终态（`run.release_succeeded` / `run.release_failed` / `run.release_triggered`）
  成对出现（`src/server/index.ts:2505`、`:2544`、`:2573`、`:2600`）；服务器上出现
  `/app/data/last-release.json`（内容 = 本次 payload，字段见 `buildDeployHookPayload`，`src/server/run-merge.ts:70-97`）。
  注意 `HTTP 202` 只算「**已触发，等待部署回调**」（`release.statusTriggered`，`:317`），**不是**成功。
- 怎么判定通过：`run.release.status === "succeeded"`，且落盘文件的 `commit` 等于 merge commit。
- 失败先看哪里：`RELEASE_CONFIG_INVALID`（`cmd:` 后命令为空或钩子格式不对，`src/server/run-merge.ts:57-66`）；
  命令非 0 退出 → `status:"failed"`，detail 是 `command failed (code N)`（`src/server/release-execution.ts:59-63`）；
  `/app/data` 不可写（属主/权限，见 `docs/25`）。
- **验完必须删掉（为什么）**：
  1) 删 `.env` 里那行 `PI_POST_MERGE_DEPLOY_HOOK=…`（或恢复 `.env.bak`）；
  2) 再跑一次 §4.7-A 步骤 4 的同一条 `up -d --force-recreate web`，让容器回到「未配置」；
  3) 删掉临时文件 `/app/data/last-release.json`。
  **理由**：留着钩子等于生产上任何一次管理员发布都会真的执行一条 shell 命令（`sh -c`），
  并让「发布」从「如实拒绝」变成「静默可触发」；本手册的验收结论也不该依赖一个临时改过的生产配置。
- 风险：`[需服务器侧运维]` + `[会改数据/不可逆]`（真实发布记录 + 容器重建）

### 4.8 验收核对（交付真的落地了吗）

- 目的：把「运行通过」与「交付落地」分开验证。
- 前置：§4.6 合并完成（§4.7/附录 A 视情况）。
- 操作与判据（逐条勾）：
  1) **检查全绿**：「检查」标签页每条都是 pass、`exit 0`（§4.5.5）。
  2) **diff 只含预期文件**：「Diff」标签页 + 「下载完整 Diff (.patch)」（`diff.download`，`:284`）。
     本机核对：`grep '^+++ ' <file>.patch`（或 `git apply --stat`）只应出现你要求的文件。
  3) **制品可下载且 sha256 与记录一致**：
     - 「验收快照」→「**Diff 制品**」（`acceptance.diff`，`:300`）显示 sha256 前 **12** 位与字节数
       （`src/client/App.tsx:826`；字节未知时「字节数未知」`acceptance.bytesUnknown`，`:301`）。
       **UI 只给前 12 位**；完整值走 `GET /api/runs/<id>/artifacts`（`src/client/api.ts:185`），
       下载走 `/api/runs/<id>/artifacts/<artifactId>/download`（`api.ts:186`）。
     - 本机：`shasum -a 256 <下载的文件>` 与记录比对，**必须一致**。
  4) **工作区默认分支 HEAD 前移到合并提交**：「工作区」页点「**刷新 Git 状态**」后看 `pi_go`；
     或在服务器检出上 `git -C /app/pi-agent/workspace/projects/pi_go log --oneline -3`。
     HEAD 必须 === 合并结果的 commit，且工作树「干净」。
  5) **运行终态**：状态是「**已通过**」（`run.state.completed`，`:834`），不是「需要人工处理」/「失败」（`:835`/`:836`）。
  6) **事件**：事件流里恰好一条 `run.merged`（meta 带同一 commit 与操作者），seq 晚于 `review.approved`；
     配了钩子时另有 `release_*` 序列（附录 A）。
  7) **人工侧可执行验收**（在**你本机**有 `node_modules` 的 `pi_go` 克隆里跑；**不要在服务器检出上 `npm ci`**）：
     ```sh
     export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
     git fetch && git diff --stat main~1 main        # 只应包含交付物
     npm run typecheck
     npx vitest run src/shared/i18n.test.ts src/client/i18n.test.ts   # i18n 目录对称/无重复 key
     npm run lint
     ```
     依据：`src/shared/i18n.test.ts:27`（`catalogKeys("en")` 必须等于 `catalogKeys("zh")`）、`:36-37`
     （`duplicateCatalogKeys` 必须为空）—— 范例 A 只要漏了 en 侧，这两条就会红。
- 失败先看哪里：diff 多文件 → 工作区 dirty 或任务描述太宽；sha256 不一致 → 「系统状态」→「最近 24 小时异常」
  里的「**制品采集失败**」（`system.failure.failure_artifact`，`:930`）；HEAD 没前移 → 见 §4.6 的「静默 no-op」。
- 风险：`[只读]`

### 4.9 决策审计：用真实 `jev` 数据核对

- 目的：证明决策平面「只见证、不改判」，且审计投影**脱敏**。
- 前置：§2.3 通过（engine=jev / mode=shadow），本轮**有过未解决 findings**（否则不发外呼）。
- 操作：运行详情 → 标签页「**决策审计**」（`topology.tabs.decisions`，`:347`）。
- 怎么判定通过（逐条）：
  1) 头部有「**只读 · 脱敏投影**」（`decisions.readonly`，`:349`）与「决策引擎的只读审计：只展示脱敏投影，
     不含外发 payload、密钥或完整 state，也不改变任何运行结果。」（`decisions.subtitle`，`:348`）；
     引擎 chip 显示 `引擎 jev · 模式 shadow`（`src/client/DecisionsPanel.tsx:63-67`）。
  2) 「**共 {count} 条评估**」（`decisions.count`，`:353`）；至少一条 kind 是「**审核分流**」
     （`decisions.kind.review_triage`，`:362`），状态「**已完成**」（`decisions.status.completed`，`:354`）
     或「**回退**」（`decisions.status.fallback`，`:355`）+「**回退原因**」（`decisions.fallbackReason`，`:378`）。
  3) 「**模型**」（`decisions.model`，`:371`）显示**解析后的真实模型**（生产实测 `jev-1.13.0`）。
     **别名漂移可见**：解析结果与请求别名不同时该值带漂移样式，悬停提示
     「请求的别名解析到了新的模型版本」（`decisions.modelDrift`，`:372`；`DecisionsPanel.tsx:98-101`；
     判定 `drifted = resolved !== requested`，`src/client/decisions-view.ts:101-107`）。
  4) **成本显示「未知」而不是 `$0.00`**：「**成本**」（`decisions.cost`，`:382`）在 provider 未计价时
     必须显示「**未知**」（`budget.costUnknown`，`:340`；`src/client/decisions-view.ts:131-138`）。
     shadow 阶段 `estimated_cost_usd` 为 NULL，所以这里**应当**是「未知」；看到 `$0.0000` 才是缺陷。
  5) **只读脱敏**：卡上只出现脱敏字段（提供方/模型/策略版本/状态哈希/问题结构哈希/时延/Tokens/成本/
     应用结果/回答），**不应**出现任何 key、`authorization`、外发 payload 或完整 state。
     「**应用结果**」（`decisions.appliedOutcome`，`:377`）应为 `none`（shadow 不改结果）。
  6) 「**回答（{count}）**」（`decisions.answers`，`:385`）：有 findings 时约 4×findings 条
     （四种固定后缀），每条四列「问题/类型/值/指标」（`:387-390`）；空集显示
     「本次评估没有回答（回退、停用或未提问）。」（`decisions.noAnswers`，`:386`）—— 也是合法结果。
  7) 交叉核对：事件流里每个 `decision.requested` 恰好对应一个 `decision.completed`/`decision.fallback`，
     同 `evaluationId`、requested 在前、晚于 `review.started`（契约见 `tests/e2e/README.md`「JEV 决策平面
     shadow 契约」；`stateHash` 应为 64 位十六进制）。
- 失败先看哪里：「该运行还没有决策评估。」（`decisions.empty`，`:352`）→ 三种可能：① 本轮 0 finding
  （正常，属「无可问内容不发调用」）；② 运行仍在飞（终态后决策可能还在飞行中，等一会儿）；
  ③ worker 侧未设 `PI_JEV_MODE`（真实缺陷，见 `tests/e2e/README.md` 的「构建前提」）。
  加载失败显示「加载决策评估失败。」（`decisions.loadFailed`，`:351`）+「**重试**」（`common.retry`，`:119`；
  `DecisionsPanel.tsx:72-77`）。
- 风险：`[只读]`

---

## 5 边界与故障演练（可选，逐条标风险）

> 每条都**可选**。要么做完立即恢复，要么明确记录「未做」。不要在一次会话里全做。

### 5.1 取消运行
- 操作：运行详情右上「**停止**」（`run.stop`，`:144`；`src/client/App.tsx:1890`，仅未到终态时出现）。
- 期望：状态转「**已取消**」（`run.state.cancelled`，`:837`）；事件 `run.cancelled`（`src/server/index.ts:2090`）；
  代码与 worktree **保留**，不会自动合并。
- 判定：侧栏该任务状态点变色；「停止」按钮消失。
- 失败先看：`error.RUN_ACTIVE`（`:1922`）/`error.RUN_CONFLICT`（`:1921`）。
- 风险：`[会改数据/不可逆]`

### 5.2 驳回 / 退回 / 恢复 / 重开
- 操作（均在「需要人工处理」的人工面板，`human.title`，`:628`）：
  - 「**继续开发**」（`decision.continue`，`:621`；`App.tsx:1474-1475`）—— 带未解决意见回到开发再跑一轮；
    面板里可先选「「继续开发」的审核范围」（`human.reviewScope`，`:633`）：「**修复全部问题**」（`human.scopeAll`，`:634`）
    或「**只修阻断项(critical/high)**」（`human.scopeBlocking`，`:635`）；
  - 「**接受交付**」（`decision.accept`，`:622`；`App.tsx:1477-1478`）；
  - 「**恢复下一轮**」（`human.resume`，`:642`）—— 先手工编辑 worktree 再恢复，会记录恢复点 HEAD 与人工指令；
  - 「**重试审核**」（`human.retryReview`，`:643`）—— 让 Reviewer 复查当前代码；
  - 「**拒绝交付**」（`human.reject`，`:644`）—— 确认框「拒绝任务「{title}」的交付？…」（`human.rejectConfirm`，`:637`）；
  - 「**终止**」（`human.terminate`，`:645`）—— 确认框（`human.terminateConfirm`，`:636`）；
  - 可填「**人工指令 / 审批备注（可选，随恢复或审批记录）**」（`human.instruction`，`:630`，
    占位符 `human.instructionPlaceholder`，`:631`），之后出现在「需求历史」的 HUMAN NOTES（`HistoryPage.tsx:141`）。
- 判定：状态按动作变化；备注写入历史（`note.kind.*`，`:838-842`）。
- 失败先看：`error.RUN_NOT_APPROVABLE`（`:1923`）/`error.RUN_NOT_REJECTABLE`（`:1924`）/
  `error.RUN_NOT_RESUMABLE`（`:1925`）/`error.OPEN_FINDINGS`（`:1920`，未解决意见需显式确认）/
  `error.INVALID_STATE_TRANSITION`（`:1930`）。
- 风险：`[会改数据/不可逆]` + `[需管理员]`（勾选合并选项时）

### 5.3 预算超限
- 操作：用 §4.2 故事表单的预算字段（`:1584-1587`）把预算设得**很小**再提交。
- 期望：预算耗尽时停到「**需要人工处理**」，事件 `run.budget_exhausted`
  （`src/worker/index.ts:2562`；`src/worker/run-recovery.ts:163-164`）；「预算与用量」对应配额显示「剩余 0」。
- 失败先看：显示「未设置上限」（`budget.noLimit`，`:336`）说明你根本没设上限。
- 风险：`[真实消耗 token]` + `[会改数据/不可逆]`

### 5.4 检查失败自动返修
- 操作：让需求带一条**必然失败**的检查（例如 `grep -q '这段字符串一定不存在' README.md`），
  第二轮再让它通过；或直接观察已有运行（若它失败过）。
- 期望：`check.failed` → 事件 `checks.returned`（「检查失败，已退回 Developer 修复」，`src/worker/index.ts:2349`）
  → 第 2 轮 `round.started` 且 Developer 会话 `resumed` → `check.passed` 之后才 `review.started`
  （契约见 `tests/e2e/README.md` E2E-02）。
- 判定：「活动」里能看到「检查 → 退回 → 再跑」的弧线；「预算与用量」里 developer 会话显示「**复用**」
  （`budget.sessionReused`，`:344`；无独立会话时是「无独立会话（--no-session）」`:343`）。
- 风险：`[真实消耗 token]`

### 5.5 Worker 崩溃恢复 —— 服务器侧，UI 无入口
- 目的：验证崩溃后能从检查点续跑（事件 `run.recovery_detected`、`checkpoint.development_restored`、
  `workspace.lock_reclaimed`；`src/worker/index.ts:2184`）。
- 操作：**UI 无入口**。机制与配方见 `tests/e2e/README.md`「E2E-06 崩溃命令（部署侧）」：一条由运维
  提供的本地命令「SIGKILL 部署的 Pi Worker 并随即把它启动回来」，由测试在确定性时点执行（退出码须为 0）；
  恢复延迟主要由 `PI_WORKSPACE_LOCK_STALE_SECONDS`（默认 300s）主导，整轮约 6–8 分钟。
  ⚠️ **该命令会真实中断生产 Worker 上所有在飞任务**（包括别人的）：做之前先在「系统状态」→
  「队列与任务」→「活跃任务」（`system.queue.active`，`:904`）/「活跃 {total}（排队 … 开发 … 审核 …）」
  （`system.activeRuns`，`:937`）确认没有别人的运行在跑。
- 风险：`[需服务器侧运维]` + `[会改数据/不可逆]` + 影响他人

### 5.6 凭据撤销（换坏 key → 看告警与 fallback）
- 操作：「模型与凭据」页把某个 provider 的 Key 换成**无效**值（输入框占位符「**输入新 Key 可轮换**」
  `models.rotateKey`，`:852`；按钮「**安全保存**」`models.saveKey`，`:854`），最稳妥是先拿 `typesafe`
  （它只影响决策平面）；然后跑一次会触发决策评估的运行。
- 期望：`/api/config/status` 的决策平面 `configured` 如实变化（`src/server/index.ts:566`、`:851`），
  `GET /api/runs/:id/decisions` 里出现「**回退**」（`decisions.status.fallback`，`:355`）+
  「回退原因」（`:378`）—— 任务路径**不被阻塞**（决策是 fire-and-forget）。
- ⚠️ **生产会真锁熔断**：连续失败会打开熔断，**必须按即把 Key 换回**（换回后凭据校验通过会重置熔断；
  该修复见 `docs/27` §8.1「AT-JEV-092 … 现已在校验通过的凭据写入后调用 `resetDecisionCircuitBreakers()`」）。
  告警通道：`PI_ALERT_WEBHOOK`（可选）+ 结构化日志；**未配置 webhook 时只能在日志里看**（属 `docs/27` §8.1 的诚实缺口）。
- 风险：`[会改数据/不可逆]` + `[需服务器侧运维]`（看日志）+ 真实影响决策外呼

### 5.7 决策平面 kill switch —— 服务器侧，UI 无入口
- 操作：`PI_JEV_MODE=off`（关闭 worker 侧 opt-in，零外呼、零审计行）或 `PI_DECISION_ENGINE=disabled`
  （引擎级关闭）。UI 上只能看结果：TypeSafe 卡片的 chip 会变成 `引擎 … · 模式 关闭`
  （`decisions.mode.off`，`:358`；card 文案 `models.decisionEngineState`，`:875`），
  决策审计页新运行不再有行。步骤与实测见 `docs/25-demo-environment.md`「决策平面回滚演练」
  （AT-JEV-090 配置回滚 / AT-JEV-091 引擎回滚，**先在 demo 上做过**）。
  ⚠️ 生产上这一步**必须先有明确授权**，且 `PI_JEV_MODE` 要**同时**进 web 与 worker
  （worker 在自己进程里读），并确认宿主机 `compose.yaml` 传了这些变量。
- 风险：`[需服务器侧运维]` + `[会改数据/不可逆]`

### 5.8 删除凭据
- 操作：「模型与凭据」页点某卡片的「**删除 Key**」（`models.deleteKey`，`:855`；`src/client/ModelsPage.tsx:247`）
  → 确认框「删除 {provider} 的 Key？该 provider 下的模型将不可用于新任务（历史任务不受影响）。」
  （`models.deleteKeyConfirm`，`:844`）。
- 期望：该 provider 的新任务预检失败（`error.MODEL_UNAVAILABLE` `:1912` /
  `error.PERSONAL_CREDENTIALS_REQUIRED` `:1910`）；历史任务不受影响。
- ⚠️ **生产是共享凭据**：删掉可能影响别人。**默认不做**，要做也只删自己刚建的测试 Key。
- 风险：`[会改数据/不可逆]`

### 5.9 注销工作区
- 操作：「工作区」页点卡片底部「**解除注册**」（`workspace.unregister`，`:1116`；`WorkspacesPage.tsx:368`）
  → 确认框「解除注册「{name}」？\n\n只解除注册：源代码目录、历史任务与制品都会保留，稍后可以重新注册。」
  （`workspace.unregisterConfirm`，`:1117`）。
- ⚠️ **绝对不要注销 `pi_go`**（那是生产工作区本身）。
- 风险：`[会改数据/不可逆]` + `[需管理员]`（或工作区所有者）

---

## 6 双语与移动端

### 6.1 语言切换
- 操作：右上角「**界面语言**」下拉（`locale.label`，`:122`；`src/client/App.tsx:1891-1899`）切到「English」。
- 期望：**会话内即时生效**（不整页刷新）。判据（对应 `tests/e2e/i18n.spec.ts`：切换不得触发整页导航、
  且刷新后保持）：① 左栏变成 `Workflows` / `Requirement history` / `Agile` / `Workspaces` /
  `Models & credentials` / `System status`（`en` 段 `src/shared/i18n.ts:180-186`）；
  ② 顶部标题变英文（`app.title` 的 **en** 值，`src/shared/i18n.ts:176`）；③ `F5` 刷新后仍是 English（`localStorage` key `pigo.locale`，
  `src/shared/i18n.ts:25`）。
- 判定：切回「中文」后所有页面文案复原；**例外**：运行详情的 `Agents` / `Diff` 标签始终是英文
  （§4.5.2/§4.5.4）—— 这是范例 A 要修的真实缺陷，不是你的操作错误。
- 失败先看：某个页面切语言后仍是中文 → 该处漏了 i18n key（按 §0 记录，注明文件:行）。
- 风险：`[只读]`

### 6.2 窄视口（移动端）
- 操作：把浏览器窗口收窄到约 **390×844**（iPhone 13；`tests/e2e/mobile.spec.ts` 的 `mobile` project 用这个尺寸）；
  或用开发者工具的设备模拟。
- 期望：① 侧栏折叠、能打开/关闭导航；② 只读页（工作区 / 模型与凭据 / 系统状态 / 需求历史）
  **没有横向溢出**（不出现左右滚动条）。
- 怎么判定（怎么看）：在页面上执行 `document.documentElement.scrollWidth <= window.innerWidth`
  （浏览器控制台或 `tests/e2e/mobile.spec.ts` 的判据「read-only pages do not overflow horizontally」）；
  目视确认表格/卡片没有被裁掉的列。
- 失败先看：哪个元素撑宽了（控制台里选中该元素看宽度）；记录元素选择器 + 步骤号。
- 风险：`[只读]`

---

## 7 收尾与清理

按顺序做，**只清理你自己造的东西**。

1. **删除测试运行**：侧栏最近任务里你创建的那条 → 删按钮（title=「删除任务」，`batch.deleteRunTitle`，`:664`；
   `src/client/App.tsx:1859`）→ 确认框「删除任务「{title}」？任务记录与事件会一并删除（代码仍保留在服务器
   worktree）。」（`alert.deleteConfirm`，`:651`）。运行中会先被拒：「任务仍在运行，请先点击右上角「停止」，
   结束后再删除。」（`alert.runningDelete`，`:650`）。风险：`[会改数据/不可逆]`
2. **（可选）按 7 天清理**：侧栏「最近任务」右上垃圾桶（title=`nav.cleanupTitle`，`:134`）→
   确认框「清理 {days} 天前已结束（通过/失败/取消/需人工）的任务？」（`cleanup.finishedHeading`，`:667`）+
   「将删除：运行记录、事件与制品；同时删除服务器上的运行目录/worktree。」（`cleanup.removeRecordsEvents`，`:669`）
   → 「已清理 {count} 个已结束任务。」（`alert.cleaned`，`:648`）。⚠️ **会删到别人的**，
   且**不可逆**；本次建议**不做**。风险：`[会改数据/不可逆]`
3. **删测试工作区**：只有在 §2.5 新建过测试目录时才做：`pi_go` **不要动**（§5.9）。
4. **轮换 key**：若在 §5.6 换坏过 Key，**确认已换回**；不需要为了测试再轮换生产 Key。
5. **移除临时发布钩子**：若做过附录 A，按附录 A 的三步还原（删 `.env` 行 → 重建 web → 删
   `/app/data/last-release.json`），并确认「代码发布」面板又变回按钮禁用 + 「发布钩子或 webhook 凭据尚未配置。」
   风险：`[需服务器侧运维]`
6. **收尾自检**：「工作区」页 `pi_go` 工作树「干净」、状态「已就绪」；「系统状态」无新增异常类别。

---

## 8 验收结论表

**功能 × 通过/失败/备注**（复制这张表逐行填）：

| # | 项目 | 通过 | 失败 | 备注（含 run id / 步骤号） |
| --- | --- | --- | --- | --- |
| 1 | 入口与身份（Cloudflare Access） | ☐ | ☐ | |
| 2 | 体检清单 1–8（§2.4） | ☐ | ☐ | |
| 3 | 只读巡检：工作流 / 需求历史 / 敏捷 / 工作区 / 模型与凭据 / 系统状态 / 账户管理（§3） | ☐ | ☐ | |
| 4 | 敏捷：建项目 / 冲刺 / 故事（§4.2） | ☐ | ☐ | |
| 5 | 提交为运行（mode=real、确认框、关联运行）（§4.3） | ☐ | ☐ | |
| 6 | 工作流：流水线 / 轮次 / 拓扑 / 里程碑事件（§4.4） | ☐ | ☐ | |
| 7 | 运行详情七个标签页（活动 / Agents / 审核 / Diff / 检查 / 预算与用量 / 决策审计）（§4.5） | ☐ | ☐ | |
| 8 | 人工闸门：未自动合并 + 管理员合并后 HEAD 前移（§4.6） | ☐ | ☐ | |
| 9 | 发布：未配置钩子的禁用 + 提示（+ 可选 409）（§4.7） | ☐ | ☐ | |
| 10 | （可选）附录 A：配置钩子后发布成功 + 已还原（§4.7-A） | ☐ | ☐ | |
| 11 | 验收核对：检查全绿 / diff 只含预期 / 制品 sha256 / HEAD / 终态 / 事件（§4.8） | ☐ | ☐ | |
| 12 | 决策审计：真实 `jev` 数据、漂移可见、成本「未知」、脱敏只读（§4.9） | ☐ | ☐ | |
| 13 | 双语切换 + 刷新保持（§6.1） | ☐ | ☐ | |
| 14 | 移动端窄视口无横向溢出（§6.2） | ☐ | ☐ | |
| 15 | 收尾清理（§7） | ☐ | ☐ | |

**问题记录**：按 §0 的模板逐条附上（步骤号 / 期望 / 实际 / 截图 / 时间 / run id / 复现步骤）。

**结论口径**：

- **功能面全通过即视为通过**（上表 1–15 全 ☐ 通过）。
- 决策平面相关的**等级门禁**（能否开 shadow / assist / enforce）**仍以 `docs/27` 为准**：
  L2 尚缺告警通道、Live Smoke 脚本化、AT 追溯等硬缺口，`docs/27` §8.1 有**诚实的缺口清单**
  （14 条 uncited 用例、AT-JEV-071 的 p95 阈值无断言、AT-JEV-090/091 仅有手工演练证据等）。
  本手册的通过**不等于**等级升级的门禁通过。
- 本手册里标为「**未在生产实测**」的推断（尤其是 §4.1 的「checks 必须离线自足」）请在结论里如实转述，
  不要升级成「已验收」。






