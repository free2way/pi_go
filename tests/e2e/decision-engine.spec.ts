import { request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Jev 决策平面 shadow 契约（docs/26 §5/§9、docs/27 §7.3 §7.7 的端到端验证）。
 *
 * 这是一个**真实、env 驱动**的场景：它对着一个已经在运行的部署提交一次真实的
 * 低成本运行，然后断言决策平面以 `shadow` 模式介入时**不改变任何流程结果**，
 * 并且审计边界面只暴露脱敏后的内容。
 *
 * 为什么必须是真实运行而不是 mock HTTP：`POST /api/internal/decisions/evaluate`
 * 只接受内部 worker token（浏览器 Session 永远无法调用，见 `decision-routes.ts`），
 * 所以唯一能证明「跑一次真实开发任务，决策平面自己出现在事件的正确时点、且零行为
 * 影响」的方式，就是让 worker 真的把这次运行提交给决策平面。本用例自身**不**伪造
 * 任何内部调用：它只读取 `/api/config/status`、`GET /api/runs/:id/decisions`、
 * `GET /api/runs/:id/events` 与运行文档。
 *
 * ---------------------------------------------------------------------------
 * 环境契约（部署侧，见 tests/e2e/README.md）
 * ---------------------------------------------------------------------------
 * 必填（demo 部署用 mock 引擎即可，无需外网）：
 *   PI_DECISION_ENGINE=mock     启用决策平面（`disabled`/`off` 会让本用例跳过）。
 *   PI_JEV_MODE=shadow          第一阶段唯一允许的行为模式（`off` 也会跳过）。
 * 可选（真实 TypeSafe 引擎）：
 *   PI_DECISION_ENGINE=jev + TYPESAFE_API_KEY=<key> + PI_JEV_MODE=shadow
 *                               走真实 System One API；缺 key 时 `/api/config/status`
 *                               会报告 `configured=false`，本用例以精确原因跳过。
 * 可选（本用例侧）：
 *   PI_E2E_DECISION_TIMEOUT_MS  等待运行到达终态的时长（默认 420000，7 分钟）。
 *   PI_E2E_DECISION_SETTLE_MS   终态后等待决策证据（审计行 + 成对事件）落盘的时长
 *                               （默认 60000）。worker 先落 verdict、再调用网关，所以
 *                               运行进入终态时决策可能还在飞行中。
 *   PI_E2E_WORKSPACE_ID         指定运行目标工作区；否则取第一个 active 且未 dirty
 *                               的已注册工作区（与 E2E-02/05/06/07 相同）。
 *   PI_E2E_DECISION_OTHER_EMAIL 反向对照用的第二个身份（默认
 *                               `pigo-decision-other@localhost`，仅 development
 *                               认证模式可伪造；非 development 模式该子断言跳过）。
 *   PI_E2E_DECISION_REVIEWER_PROVIDER 可选，优先为审核角色钉住的 provider。
 *
 * 断言（全部非空泛；任何一条不成立即 FAIL，绝不静默通过）：
 *   1. 运行结果与「没有决策平面」时一致：终态 `completed`、审核确实发生过
 *      （`review.started` → 终局 verdict 事件，且 `GET /runs/:id/rounds` 有 verdict），
 *      并且没有任何 decision 事件把状态改写成别的结果。
 *   2. `GET /api/runs/:id/decisions` 至少一行 `kind:"review_triage"`，且：
 *      `appliedOutcome === "none"`、`mode === "shadow"`、`status` 为 `completed`
 *      或带标准 `fallbackReason`、`resolvedModel` 非空、`stateHash` 为 64 位十六进制、
 *      `latencyMs >= 0`；答案严格等于「4 × 本轮未解决 finding 数」（与
 *      `stateManifest.questionCount` / `counts.findings` 交叉校验），并逐条断言类型语义：
 *      probability 答案**没有** `confidence`、带 `certainty = |p-0.5|*2`；choice/score
 *      答案带 `probabilities` 分布 + `confidence`、**没有** `probability`/`certainty`；
 *      score 的 `weightedScore` 落在 `[0, levelCount-1]` 内。审核轮干净通过（0 finding）
 *      时答案集合必须为空（这在实测中就是单文件小改动的常见结果），语义断言不会被触发，
 *      但会以 `decision-answers` annotation 显式写明，绝不静默。
 *   2b. 该断言需要「worker 真的按 docs/26 §9.1 调用了网关」：`src/worker/decision-triage.ts`
 *      在 worker 进程读它自己的 `PI_JEV_MODE`（`shadow|assist|enforce` 才发请求），
 *      网关再追加审计行与 `decision.requested` 事件。web 与 worker 的 env 不一致
 *      （或构建缺少该调用点）时，用例会以点名 `PI_JEV_MODE`/调用点的信息 FAIL，
 *      而不是静默通过。
 *   3. 运行事件流里每个 `decision.requested` 恰好对应一个 `decision.completed` 或
 *      `decision.fallback`（同 evaluationId、且 requested 在前），事件的 meta 只含
 *      id/模式/状态/原因/模型/时延类字段——扫描确认没有密钥、没有外发 `state`
 *      payload 字段；决策事件出现在审核开始之后（docs/26 §9.1 的调用点）。
 *   4. 运行文档/diff/事件里没有任何「决策内容改变了状态」的痕迹：没有
 *      `appliedOutcome` 之外的 apply 记录、没有 decision evaluation id 写入运行文档、
 *      finding 等级未被决策内容改写。
 *   5. 反向对照：用第二个身份读同一个 run 的 decisions 返回 404（owner 作用域）。
 *
 * 成本：一次极小的确定性真实运行（第一个可选 developer 模型 + 第一个可选 reviewer
 * 模型 + 一条 `grep` 检查），`finally` 中取消仍在飞行的运行。
 */

const FALLBACK_REASONS = [
  "disabled",
  "missing_credentials",
  "invalid_configuration",
  "payload_rejected",
  "timeout",
  "rate_limited",
  "provider_unavailable",
  "authentication_failed",
  "contract_invalid",
  "circuit_open",
  "aborted",
  "unknown",
] as const;

/** docs/26 §9.3 的四个固定问题后缀（版本化 policy；此处按契约字面量重复）。 */
const QUESTION_SUFFIXES = ["requirement_relevant", "security_impact", "human_urgency", "retry_value"] as const;
type QuestionSuffix = (typeof QUESTION_SUFFIXES)[number];
const ANSWER_TYPE_BY_SUFFIX: Record<QuestionSuffix, "probability" | "choice" | "score"> = {
  requirement_relevant: "probability",
  security_impact: "choice",
  human_urgency: "choice",
  retry_value: "score",
};
const OPTIONS_BY_SUFFIX: Record<string, readonly string[]> = {
  security_impact: ["none", "possible", "material"],
  human_urgency: ["normal", "soon", "immediate"],
};
/** `retry_value` 的 level 数量（docs/26 §9.3：4 个有序 level）。 */
const RETRY_VALUE_LEVEL_COUNT = 4;

const BASE_URL = process.env.PI_E2E_BASE_URL ?? "http://127.0.0.1:3100";
const OTHER_EMAIL = (process.env.PI_E2E_DECISION_OTHER_EMAIL ?? "pigo-decision-other@localhost").toLowerCase();

/** 部署侧必须打开的开关；跳过原因必须逐字点名。 */
const ENABLE_HINT =
  "demo 部署：PI_DECISION_ENGINE=mock 且 PI_JEV_MODE=shadow；真实 TypeSafe 引擎：PI_DECISION_ENGINE=jev + TYPESAFE_API_KEY=<key> + PI_JEV_MODE=shadow。注意 web 与 worker 两个进程都要设置 PI_JEV_MODE（worker 侧决定它是否调用网关，见 src/worker/decision-triage.ts）。";

/** 活跃态（worker 仍可能开始新的模型调用）。 */
const ACTIVE_RUN_STATES = ["queued", "preparing", "developing", "checking", "reviewing"];

type DecisionEngineStatus = {
  engine?: "disabled" | "mock" | "jev";
  mode?: "off" | "shadow" | "assist" | "enforce";
  configured?: boolean;
  policyVersion?: string | null;
  reason?: string;
};

type ConfigStatusBody = {
  demoMode?: boolean;
  realRunsAvailable?: boolean;
  decisionEngine?: DecisionEngineStatus;
};

type DecisionStatus = "completed" | "fallback" | "rejected" | "disabled";

type DecisionAnswer = {
  questionId: string;
  type: "probability" | "choice" | "score";
  value: boolean | string;
  probability?: number;
  probabilities?: Record<string, number>;
  weightedScore?: number;
  confidence?: number;
  certainty?: number;
};

type DecisionProjection = {
  evaluationId: string;
  runId: string;
  kind: string;
  mode: string;
  provider: string;
  requestedModel: string;
  resolvedModel?: string;
  policyVersion: string;
  stateHash: string;
  questionSchemaHash: string;
  status: DecisionStatus;
  answers: DecisionAnswer[];
  appliedOutcome?: string;
  fallbackReason?: string;
  detail?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  createdAt: string;
  stateManifest: Record<string, unknown>;
};

type RunEvent = {
  seq: number;
  runId: string;
  round: number;
  source: string;
  type: string;
  message: string;
  at: string;
  meta?: Record<string, unknown>;
};

type RunFinding = { id: string; severity: string; title?: string; resolved?: boolean };

type RunDoc = {
  id: string;
  title: string;
  state: string;
  round?: number;
  maxRounds?: number;
  summary?: string;
  diff?: string;
  baseSha?: string;
  developer?: { provider: string; model: string };
  reviewer?: { provider: string; model: string };
  findings?: RunFinding[];
  modelCalls?: number;
};

type RoundSummaryBody = {
  rounds: Array<{
    round: number;
    verdict: "approved" | "changes_requested" | "none";
    checks: { passed: number; failed: number };
    findings: { total: number; resolved: number };
  }>;
};

function envValue(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

async function readConfigStatus(request: APIRequestContext): Promise<ConfigStatusBody> {
  const response = await request.get("/api/config/status");
  expect(response.ok(), `GET /api/config/status failed with HTTP ${response.status()}`).toBeTruthy();
  return (await response.json()) as ConfigStatusBody;
}

async function getRun(request: APIRequestContext, runId: string): Promise<RunDoc> {
  const response = await request.get(`/api/runs/${runId}`);
  expect(response.ok(), `GET /api/runs/${runId} failed with HTTP ${response.status()}`).toBeTruthy();
  return (await response.json()) as RunDoc;
}

/** 不分页读取整条事件流（`limit` 上限 1000，用 `after` 续读）。 */
async function getRunEvents(request: APIRequestContext, runId: string): Promise<RunEvent[]> {
  const all: RunEvent[] = [];
  let after = 0;
  for (let page = 0; page < 10; page += 1) {
    const response = await request.get(`/api/runs/${runId}/events?after=${after}&limit=1000`);
    expect(response.ok(), `GET /api/runs/${runId}/events failed with HTTP ${response.status()}`).toBeTruthy();
    const pageEvents = (await response.json()) as RunEvent[];
    all.push(...pageEvents);
    if (pageEvents.length < 1000) return all;
    after = pageEvents[pageEvents.length - 1].seq;
  }
  return all;
}

async function getRunRounds(request: APIRequestContext, runId: string): Promise<RoundSummaryBody> {
  const response = await request.get(`/api/runs/${runId}/rounds`);
  expect(response.ok(), `GET /api/runs/${runId}/rounds failed with HTTP ${response.status()}`).toBeTruthy();
  return (await response.json()) as RoundSummaryBody;
}

/** `GET /api/runs/:runId/decisions`（owner 作用域）。返回状态码与解析后的 body。 */
async function getDecisions(
  request: APIRequestContext,
  runId: string,
): Promise<{ status: number; decisions?: DecisionProjection[] }> {
  const response = await request.get(`/api/runs/${runId}/decisions`);
  if (!response.ok()) return { status: response.status() };
  const body = (await response.json()) as { decisions?: DecisionProjection[] };
  return { status: response.status(), decisions: body.decisions ?? [] };
}

/**
 * 运行目标工作区：显式 `PI_E2E_WORKSPACE_ID`，否则第一个 active 且未 dirty 的已注册
 * 工作区（与 acceptance.spec.ts 的 E2E-02/05/07 同一规则；dirty 会被 preflight 直接
 * 409 WORKSPACE_DIRTY 拒绝）。
 */
async function resolveWorkspace(request: APIRequestContext): Promise<string | undefined> {
  const explicit = envValue("PI_E2E_WORKSPACE_ID");
  if (explicit) return explicit;
  const response = await request.get("/api/workspaces");
  if (!response.ok()) return undefined;
  const body = (await response.json()) as {
    workspaces?: Array<{ id: string; status: string; git?: { dirty?: boolean } }>;
  };
  return (body.workspaces ?? []).find((workspace) => workspace.status === "active" && !workspace.git?.dirty)?.id;
}

/**
 * 与 acceptance.spec.ts 的 `resolveRoleSelection` 同契约：取 `/api/models` 中
 * preflight 会接受的第一个可选模型（additive `selectableRoles`，否则
 * `roles` + `available`），从而不继承部署默认模型。
 */
async function resolveRoleSelection(
  request: APIRequestContext,
  role: "developer" | "reviewer",
  preferredProvider?: string,
): Promise<{ provider: string; model: string } | undefined> {
  const response = await request.get("/api/models");
  if (!response.ok()) return undefined;
  const body = (await response.json()) as {
    models?: Array<{ provider: string; model: string; roles?: string[]; available?: boolean; selectableRoles?: string[] }>;
  };
  const selectable = (body.models ?? []).filter((item) =>
    Array.isArray(item.selectableRoles)
      ? item.selectableRoles.includes(role)
      : Boolean(item.roles?.includes(role)) && item.available === true,
  );
  const entry =
    (preferredProvider ? selectable.find((item) => item.provider === preferredProvider) : undefined) ?? selectable[0];
  return entry ? { provider: entry.provider, model: entry.model } : undefined;
}

/** 仅取消仍在飞行的运行（best-effort，绝不覆盖已有终态）。 */
async function cancelIfActive(request: APIRequestContext, runId: string): Promise<void> {
  try {
    const run = await getRun(request, runId);
    if (ACTIVE_RUN_STATES.includes(run.state)) await request.post(`/api/runs/${runId}/cancel`);
  } catch {
    // 服务不可达或运行已终态；没有需要清理的东西。
  }
}

/** decision.* 事件 meta 的允许集合（docs/26 §13 / AT-JEV-063）。 */
const DECISION_EVENT_META_KEYS = new Set([
  "evaluationId",
  "kind",
  "mode",
  "requestedModel",
  "status",
  "fallbackReason",
  "resolvedModel",
  "latencyMs",
  "inputTokens",
  "outputTokens",
  "estimatedCostUsd",
]);

/** 看着像凭据 / 外发 payload 的键或值（任何命中即 FAIL）。 */
const FORBIDDEN_TOKEN = /(api[_-]?key|authorization|bearer\s|sk-[a-z0-9]|password|secret|typesafe_api_key)/i;
const FORBIDDEN_META_KEY = /^(state|questions|answers|payload|payloads|request|raw|source)$/i;

function describeEvent(event: RunEvent): string {
  return `#${event.seq} ${event.type} ${JSON.stringify(event.meta ?? {})}`;
}

test.describe("JEV 决策平面 shadow 契约", () => {
  test("真实运行的 shadow 零影响：决策只见证、不改写状态，审计/事件只暴露脱敏内容", async ({ request }) => {
    // 目标：证明 shadow 模式下，决策平面观察到真实的 review finding，但结果
    // 只被记录（appliedOutcome=none），主流程与没有决策平面时完全一致。
    const waitMs = Number(envValue("PI_E2E_DECISION_TIMEOUT_MS") ?? 420_000);
    test.setTimeout(waitMs + 180_000);

    const status = await readConfigStatus(request);
    const engine = status.decisionEngine;
    const skipPrefix = `JEV 决策平面 shadow 契约需要部署启用决策平面（PI_E2E_BASE_URL=${BASE_URL}）。`;

    test.skip(
      !engine,
      `${skipPrefix}/api/config/status 未返回 decisionEngine 字段：该部署的构建早于 src/server/decision-routes.ts。重新部署后设置 ${ENABLE_HINT}`,
    );
    test.skip(
      engine!.engine === "disabled" || engine!.mode === "off",
      `${skipPrefix}当前 decisionEngine=${JSON.stringify(engine)}。设置 ${ENABLE_HINT}`,
    );
    if (engine!.engine === "jev" && engine!.configured !== true) {
      test.skip(
        true,
        `${skipPrefix}已选择真实 TypeSafe 引擎但缺少凭据（configured=false${engine!.reason ? `, reason=${engine!.reason}` : ""}）。设置 TYPESAFE_API_KEY=<key>（并保持 PI_JEV_MODE=shadow）。`,
      );
    }
    test.skip(
      engine!.mode !== "shadow",
      `${skipPrefix}本次验证只覆盖 shadow 模式（当前 mode=${engine!.mode}，policyVersion=${engine!.policyVersion ?? "null"}）。设置 PI_JEV_MODE=shadow。`,
    );
    test.skip(
      !status.realRunsAvailable,
      `${skipPrefix}需要真实运行环境：/api/config/status 报告 realRunsAvailable=false（需 PI_REAL_RUNS_ENABLED=true、PI_INTERNAL_TOKEN 以及至少一个已配置的 provider 凭据）。`,
    );

    const workspaceId = await resolveWorkspace(request);
    test.skip(
      !workspaceId,
      `${skipPrefix}需要工作区：没有 active 且未 dirty 的已注册工作区（或设置 PI_E2E_WORKSPACE_ID 指定）。`,
    );

    const developer = await resolveRoleSelection(request, "developer");
    const reviewer = await resolveRoleSelection(request, "reviewer", envValue("PI_E2E_DECISION_REVIEWER_PROVIDER"));
    test.skip(
      !developer || !reviewer,
      `${skipPrefix}需要 /api/models 中同时存在 developer 与 reviewer 可选模型（当前 developer=${JSON.stringify(developer)}、reviewer=${JSON.stringify(reviewer)}）。`,
    );

    // 极小的确定性交付物：一个带本次运行唯一标记的文件 + 一条 grep 检查。
    // 任务明确禁止其它改动，因此首轮就能收敛到 completed，成本最低。
    const marker = `PIGO-DECISION-E2E-${Date.now()}`;
    const deliverable = "pigo-decision-e2e.txt";
    const title = `决策平面 shadow 契约 ${marker}`;
    const task = [
      `在仓库根目录创建文件 ${deliverable}，内容为一行：${marker}`,
      "除此之外不要修改任何其它文件，不要新增依赖，不要提交或 push（产品会自行提交本轮工作树改动）。",
    ].join("\n");
    const checks = [`test -f ${deliverable} && grep -q '${marker}' ${deliverable}`];

    let runId: string | undefined;
    try {
      const created = await request.post("/api/runs", {
        data: { title, task, mode: "real", workspaceId, checks, developerModel: developer, reviewerModel: reviewer },
      });
      expect(created.status(), `POST /api/runs 失败（${created.status()}）：${await created.text()}`).toBe(201);
      runId = ((await created.json()) as RunDoc).id;
      test.info().annotations.push({
        type: "run",
        description: `${runId}（developer=${developer!.provider}/${developer!.model}，reviewer=${reviewer!.provider}/${reviewer!.model}）`,
      });

      // ---------------------------------------------------------------------
      // (1) 让真实运行跑到终态，并证明「审核确实发生过」。
      // ---------------------------------------------------------------------
      await expect
        .poll(
          async () => {
            const current = await getRun(request, runId!);
            return !ACTIVE_RUN_STATES.includes(current.state);
          },
          {
            message: `Run ${runId} 未在 ${waitMs}ms 内离开运行态（queued/preparing/developing/checking/reviewing）。`,
            timeout: waitMs,
            intervals: [2_000, 5_000],
          },
        )
        .toBe(true);

      const run = await getRun(request, runId);
      const rounds = await getRunRounds(request, runId);

      expect(
        run.state,
        `决策平面处于 shadow，不得改变运行结果：期望终态 completed，实际 ${run.state}（summary=${run.summary ?? ""}）。`,
      ).toBe("completed");
      expect(
        rounds.rounds.some((round) => round.verdict !== "none"),
        `GET /api/runs/:id/rounds 必须记录审核 verdict（实际 ${JSON.stringify(rounds.rounds)}）`,
      ).toBe(true);

      // ---------------------------------------------------------------------
      // (2) 决策审计至少一行 review_triage，且满足 shadow 不变式。
      //
      // 时序（src/worker/decision-triage.ts + decision-routes.ts）：worker 先把权威
      // verdict 落盘（运行可能已经进入终态），**之后**才调用网关；网关再追加
      // `decision.requested` + 一个结果事件。所以「终态」不等于「决策已落盘」——必须
      // 等决策证据出现再断言，否则会读到半程状态。
      // ---------------------------------------------------------------------
      const decisionWaitMs = Number(envValue("PI_E2E_DECISION_SETTLE_MS") ?? 60_000);
      let events: RunEvent[] = [];
      let decisions: DecisionProjection[] = [];
      await expect
        .poll(
          async () => {
            events = await getRunEvents(request, runId!);
            const requestedCount = events.filter((event) => event.type === "decision.requested").length;
            const outcomeCount = events.filter(
              (event) => event.type === "decision.completed" || event.type === "decision.fallback",
            ).length;
            decisions = (await getDecisions(request, runId!)).decisions ?? [];
            return requestedCount > 0 && requestedCount === outcomeCount && decisions.some((d) => d.kind === "review_triage");
          },
          {
            message: `Run ${runId} 到达终态后 ${decisionWaitMs}ms 内仍未出现完整的决策证据（至少一行 review_triage 审计 + 成对的 decision.requested/completed|fallback）。reason=构建里 worker 的审核调用点（docs/26 §9.1）没有调用 POST /api/internal/decisions/evaluate，或 worker 自身未设置 PI_JEV_MODE（src/worker/decision-triage.ts 在 worker 进程读 PI_JEV_MODE）。已见事件类型：${[...new Set(events.map((e) => e.type))].join(", ")}`,
            timeout: decisionWaitMs,
            intervals: [1_000, 2_000, 5_000],
          },
        )
        .toBe(true);

      const reviewStarted = events.find((event) => event.type === "review.started");
      expect(
        reviewStarted,
        `shadow 运行必须真的走过审核（review.started）。事件流：\n${events.map(describeEvent).join("\n")}`,
      ).toBeTruthy();
      const verdictEvents = events.filter(
        (event) => event.type === "review.approved" || event.type === "review.changes_requested",
      );
      expect(
        verdictEvents.length,
        `shadow 运行必须有审核终局 verdict 事件。事件流：\n${events.map(describeEvent).join("\n")}`,
      ).toBeGreaterThan(0);

      const triage = decisions.filter((decision) => decision.kind === "review_triage");
      expect(
        triage.length,
        `决策审计必须包含 kind=review_triage（实际：${decisions.map((d) => d.kind).join(", ")}）`,
      ).toBeGreaterThan(0);

      const decisionMetaWhitelistError = (meta: Record<string, unknown>): string | undefined => {
        for (const [key, value] of Object.entries(meta)) {
          if (!DECISION_EVENT_META_KEYS.has(key)) return `meta 出现未允许的键 ${key}`;
          const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
          if (FORBIDDEN_TOKEN.test(text)) return `meta.${key} 的值看起来像凭据：${text.slice(0, 120)}`;
        }
        return undefined;
      };

      for (const decision of triage) {
        const where = `evaluation ${decision.evaluationId}`;
        // shadow 永远什么都不应用（docs/26 §9.4 rule 5）。
        expect(decision.mode, `${where}: shadow 模式必须被记录为 mode=shadow`).toBe("shadow");
        expect(decision.appliedOutcome, `${where}: shadow 的 appliedOutcome 必须是 none`).toBe("none");
        // 允许 completed，或带标准 fallbackReason 的 fallback；其余状态不接受。
        if (decision.status === "completed") {
          expect(typeof decision.fallbackReason, `${where}: completed 不得带 fallbackReason`).toBe("undefined");
        } else {
          expect(decision.status, `${where}: shadow 审计只允许 completed 或 fallback（实际 ${decision.status}）`).toBe("fallback");
          expect(
            FALLBACK_REASONS as readonly string[],
            `${where}: fallbackReason 必须是 docs/26 §15.3 的标准值（实际 ${String(decision.fallbackReason)}）`,
          ).toContain(decision.fallbackReason);
        }
        // mock 引擎会报告自己的解析模型（mock:<model>）；真实引擎报告版本化 id。
        expect(
          typeof decision.resolvedModel === "string" && decision.resolvedModel.trim().length > 0,
          `${where}: resolvedModel 必须是非空字符串（实际 ${JSON.stringify(decision.resolvedModel)}）`,
        ).toBe(true);
        expect(decision.stateHash, `${where}: stateHash 必须是 64 位十六进制（实际 ${decision.stateHash}）`).toMatch(/^[0-9a-f]{64}$/);
        expect(decision.latencyMs, `${where}: latencyMs 必须 >= 0`).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(decision.latencyMs), `${where}: latencyMs 必须是有限数字`).toBe(true);
        // 脱敏投影：不得回传外发 payload/凭据。
        for (const forbidden of ["state", "questions", "payload", "apiKey", "authorization"]) {
          expect(
            Object.prototype.hasOwnProperty.call(decision as unknown as Record<string, unknown>, forbidden),
            `${where}: 审计投影不得包含 ${forbidden} 字段`,
          ).toBe(false);
        }
        expect(decision.stateManifest, `${where}: 审计必须带脱敏 stateManifest`).toBeTruthy();
        const manifestKeys = [
          "fields",
          "counts",
          "fieldsTruncated",
          "stateBytes",
          "stateChars",
          "stateTokens",
          "questionCount",
          "questionIds",
          "questions",
        ];
        expect(
          Object.keys(decision.stateManifest).every((key) => manifestKeys.includes(key)),
          `${where}: stateManifest 只允许字段名/计数/尺寸，实际键 ${Object.keys(decision.stateManifest).join(", ")}`,
        ).toBe(true);

        // ---- 答案语义（docs/26 §6.3 的两处修正） ----
        //
        // 非空泛的锚点是「答案必须与这次评估真正携带的 finding 集合一致」：
        //   answers.length === questionCount === 4 × 本轮未解决 finding 数。
        // 审核轮确实带 finding 时（findings >= 1），下面每条答案的四后缀语义断言
        // 必然被触发；审核轮是干净通过（仓库里实测：一次单文件改动、reviewer 直接
        // approve、0 finding）时，唯一正确的答案集合就是空集，断言它会与
        // stateManifest 的零计数一致，而不是被静默跳过。
        const answers = decision.answers ?? [];
        const manifestQuestionCount = decision.stateManifest.questionCount;
        const counts = decision.stateManifest.counts as Record<string, number> | undefined;
        const findingsInState = counts?.findings;

        expect(
          answers.length % QUESTION_SUFFIXES.length,
          `${where}: 答案数量必须是每个 finding 四个固定问题后缀的整数倍（实际 ${answers.length}）`,
        ).toBe(0);
        if (typeof manifestQuestionCount === "number") {
          expect(manifestQuestionCount, `${where}: stateManifest.questionCount 必须等于答案数量`).toBe(answers.length);
        }
        if (typeof findingsInState === "number") {
          expect(
            answers.length,
            `${where}: 答案数量必须等于 4 × 本轮未解决 finding 数（stateManifest.counts.findings=${findingsInState}）；答案与送审状态不一致`,
          ).toBe(findingsInState * QUESTION_SUFFIXES.length);
        }
        if (answers.length === 0) {
          // 空答案只允许来自「本轮审核没有未解决 finding」——绝不允许引擎凭空丢答案。
          expect(findingsInState ?? 0, `${where}: 空答案集合只能对应 0 个未解决 finding`).toBe(0);
        }

        // 问题 id 形如 f_<12hex>_<suffix>；同一 finding 的四条答案共享前缀。
        // 后缀本身含下划线（requirement_relevant 等），所以后缀一律按稳定顺序从索引
        // 推导，绝不用 lastIndexOf("_") 猜。
        const prefixes = new Set<string>();
        const tagged = answers.map((answer, index) => {
          const suffix = QUESTION_SUFFIXES[index % QUESTION_SUFFIXES.length];
          const expectedId = new RegExp("^f_[0-9a-f]{12}_" + suffix + "$");
          expect(
            answer.questionId,
            `${where}: 第 ${index} 条答案的问题 id 必须匹配 ${expectedId}（实际 ${answer.questionId}）`,
          ).toMatch(expectedId);
          prefixes.add(answer.questionId.slice(0, answer.questionId.length - suffix.length - 1));
          return { answer, suffix, where: `${where} / ${answer.questionId}` };
        });
        expect(
          prefixes.size,
          `${where}: 四条答案必须按 finding 前缀分组（实际前缀 ${[...prefixes].join(", ")}）`,
        ).toBe(answers.length / QUESTION_SUFFIXES.length);

        for (const { answer, suffix, where: where2 } of tagged) {
          expect(
            answer.type,
            `${where2}: ${suffix} 的类型必须是 ${ANSWER_TYPE_BY_SUFFIX[suffix]}（实际 ${answer.type}）`,
          ).toBe(ANSWER_TYPE_BY_SUFFIX[suffix]);
          if (answer.type === "probability") {
            expect(suffix, `${where2}: probability 只能出现在 requirement_relevant 上`).toBe("requirement_relevant");
            expect(typeof answer.value, `${where2}: probability 的 value 必须是布尔`).toBe("boolean");
            expect(typeof answer.probability, `${where2}: probability 答案必须带 probability`).toBe("number");
            expect(Number.isFinite(answer.probability!), `${where2}: probability 必须是有限数字`).toBe(true);
            expect(answer.probability!, `${where2}: probability 必须落在 [0,1]`).toBeGreaterThanOrEqual(0);
            expect(answer.probability!, `${where2}: probability 必须落在 [0,1]`).toBeLessThanOrEqual(1);
            // 修正后的语义：概率答案没有 provider confidence，只有本地推导的 certainty。
            expect(
              Object.prototype.hasOwnProperty.call(answer, "confidence"),
              `${where2}: probability 答案不得携带 confidence（Noul 不返回置信度）`,
            ).toBe(false);
            expect(typeof answer.certainty, `${where2}: probability 答案必须带 certainty`).toBe("number");
            expect(Number.isFinite(answer.certainty!), `${where2}: certainty 必须是有限数字`).toBe(true);
            expect(answer.certainty!, `${where2}: certainty = |p-0.5|*2 必须落在 [0,1]`).toBeGreaterThanOrEqual(0);
            expect(answer.certainty!, `${where2}: certainty = |p-0.5|*2 必须落在 [0,1]`).toBeLessThanOrEqual(1);
            expect(
              answer.certainty!,
              `${where2}: certainty 必须等于 |probability-0.5|*2（本地推导，不信任 provider）`,
            ).toBeCloseTo(Math.abs(answer.probability! - 0.5) * 2, 4);
            expect(
              Object.prototype.hasOwnProperty.call(answer, "probabilities"),
              `${where2}: probability 答案不得带 probabilities 分布`,
            ).toBe(false);
            expect(
              Object.prototype.hasOwnProperty.call(answer, "weightedScore"),
              `${where2}: probability 答案不得带 weightedScore`,
            ).toBe(false);
          } else if (answer.type === "choice") {
            expect(["security_impact", "human_urgency"], `${where2}: choice 只能出现在 security_impact/human_urgency 上`).toContain(suffix);
            const options = OPTIONS_BY_SUFFIX[suffix];
            expect(options, `${where2}: 选中项必须属于 policy 白名单（实际 ${String(answer.value)}）`).toContain(answer.value);
            expect(answer.probabilities, `${where2}: choice 答案必须带完整概率分布`).toBeTruthy();
            expect(Object.keys(answer.probabilities!).sort(), `${where2}: 分布必须覆盖全部选项`).toEqual([...options].sort());
            const total = Object.values(answer.probabilities!).reduce((sum, value) => sum + value, 0);
            expect(total, `${where2}: 概率分布必须归一（实际 ${total}）`).toBeCloseTo(1, 3);
            expect(typeof answer.confidence, `${where2}: choice 答案必须带 confidence`).toBe("number");
            expect(answer.confidence!, `${where2}: confidence 必须落在 [0,1]`).toBeGreaterThanOrEqual(0);
            expect(answer.confidence!, `${where2}: confidence 必须落在 [0,1]`).toBeLessThanOrEqual(1);
            expect(Object.prototype.hasOwnProperty.call(answer, "probability"), `${where2}: choice 答案不得带 probability`).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(answer, "certainty"), `${where2}: choice 答案不得带 certainty`).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(answer, "weightedScore"), `${where2}: choice 答案不得带 weightedScore`).toBe(false);
          } else {
            expect(suffix, `${where2}: score 只能出现在 retry_value 上`).toBe("retry_value");
            expect(answer.probabilities, `${where2}: score 答案必须带 level 分布`).toBeTruthy();
            expect(
              Object.keys(answer.probabilities!).length,
              `${where2}: retry_value 必须有 ${RETRY_VALUE_LEVEL_COUNT} 个有序 level`,
            ).toBe(RETRY_VALUE_LEVEL_COUNT);
            const total = Object.values(answer.probabilities!).reduce((sum, value) => sum + value, 0);
            expect(total, `${where2}: level 分布必须归一（实际 ${total}）`).toBeCloseTo(1, 3);
            expect(typeof answer.confidence, `${where2}: score 答案必须带 confidence`).toBe("number");
            expect(typeof answer.weightedScore, `${where2}: score 答案必须带 weightedScore`).toBe("number");
            expect(Number.isFinite(answer.weightedScore!), `${where2}: weightedScore 必须是有限数字`).toBe(true);
            // level 索引区间：low→high 的加权值必须落在 [0, levelCount-1]。
            expect(answer.weightedScore!, `${where2}: weightedScore 必须 >= 0`).toBeGreaterThanOrEqual(0);
            expect(
              answer.weightedScore!,
              `${where2}: weightedScore 必须 <= levelCount-1=${RETRY_VALUE_LEVEL_COUNT - 1}（实际 ${answer.weightedScore}）`,
            ).toBeLessThanOrEqual(RETRY_VALUE_LEVEL_COUNT - 1);
            expect(Object.prototype.hasOwnProperty.call(answer, "probability"), `${where2}: score 答案不得带 probability`).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(answer, "certainty"), `${where2}: score 答案不得带 certainty`).toBe(false);
          }
        }
      }

      // 记录本次运行是否真的触发了「四个后缀 / confidence-vs-certainty」语义断言：
      // 审核全部干净通过（0 finding）时它们不会被触发——这一点必须出现在报告里，
      // 绝不静默。
      const answerRows = triage.filter((decision) => (decision.answers ?? []).length > 0);
      const findingsAcrossRows = triage.reduce((sum, decision) => {
        const rowCounts = decision.stateManifest.counts as Record<string, number> | undefined;
        return sum + (typeof rowCounts?.findings === "number" ? rowCounts.findings : 0);
      }, 0);
      test.info().annotations.push({
        type: "decision-answers",
        description: `review_triage 审计 ${triage.length} 条；带 finding 的评估 ${answerRows.length} 条（累计未解决 finding ${findingsAcrossRows}）；四后缀 + confidence-vs-certainty 语义断言${answerRows.length > 0 ? "已触发" : "未触发（本次审核全部干净通过，0 个未解决 finding；答案集合为空是正确结果）"}`,
      });

      // ---------------------------------------------------------------------
      // (3) 事件流：requested → 恰好一个 outcome；meta 只含 ids/模式/状态/原因/
      //     模型/时延；调用点在审核开始之后；没有密钥或外发 state。
      // ---------------------------------------------------------------------
      const decisionEvents = events.filter((event) => event.type.startsWith("decision."));
      const requested = decisionEvents.filter((event) => event.type === "decision.requested");
      const outcomes = decisionEvents.filter(
        (event) => event.type === "decision.completed" || event.type === "decision.fallback",
      );
      expect(
        requested.length,
        `运行事件流必须带 decision.requested（docs/26 §13 AT-JEV-063）。事件类型：${[...new Set(events.map((e) => e.type))].join(", ")}`,
      ).toBeGreaterThan(0);
      expect(
        outcomes.length,
        `每个 decision.requested 必须恰好对应一个 decision.completed|decision.fallback（实际 ${requested.length} requested / ${outcomes.length} outcome）`,
      ).toBe(requested.length);

      const requestedIds = requested.map((event) => String(event.meta?.evaluationId ?? ""));
      const outcomeIds = outcomes.map((event) => String(event.meta?.evaluationId ?? ""));
      expect(requestedIds.filter(Boolean).length, `decision.requested 必须带 evaluationId`).toBe(requested.length);
      expect(outcomeIds.filter(Boolean).length, `decision 结果事件必须带 evaluationId`).toBe(outcomes.length);
      expect([...outcomeIds].sort(), `每个 requested 只能有一个 outcome，且 evaluationId 必须完全对应`).toEqual([...requestedIds].sort());
      expect(new Set(requestedIds).size, `同一 evaluationId 不得出现两条 decision.requested`).toBe(requestedIds.length);

      const requestSeqById = new Map<string, number>();
      for (const event of requested) requestSeqById.set(String(event.meta?.evaluationId), event.seq);
      for (const event of outcomes) {
        const id = String(event.meta?.evaluationId);
        expect(
          event.seq,
          `${id}: 结果事件必须晚于对应的 decision.requested（requested seq=${requestSeqById.get(id)}，outcome seq=${event.seq}）`,
        ).toBeGreaterThan(requestSeqById.get(id)!);
      }

      // 调用点顺序：决策事件必须出现在 review.started 之后（docs/26 §9.1）。
      const firstReviewSeq = reviewStarted!.seq;
      for (const event of decisionEvents) {
        expect(
          event.seq,
          `决策评估必须发生在 reviewer 解析成功之后（docs/26 §9.1）：${describeEvent(event)} 出现在 review.started(#${firstReviewSeq}) 之前`,
        ).toBeGreaterThan(firstReviewSeq);
      }

      // meta 白名单 + 无 secret / 无外发 state。
      for (const event of decisionEvents) {
        const meta = event.meta ?? {};
        const error = decisionMetaWhitelistError(meta);
        expect(error, `decision 事件 meta 越界：${describeEvent(event)} → ${error}`).toBeUndefined();
        for (const key of Object.keys(meta)) {
          expect(
            FORBIDDEN_META_KEY.test(key),
            `decision 事件 meta 不得包含外发 payload 字段 ${key}：${describeEvent(event)}`,
          ).toBe(false);
        }
        expect(FORBIDDEN_TOKEN.test(event.message), `decision 事件文案不得包含凭据：${event.message}`).toBe(false);
      }
      // requested 只带 id（+ kind/mode/model），不得带 status/answer 内容。
      for (const event of requested) {
        expect(
          Object.keys(event.meta ?? {}).sort(),
          `decision.requested 的 meta 只允许 evaluationId/kind/mode/requestedModel：${describeEvent(event)}`,
        ).toEqual([...DECISION_EVENT_META_KEYS].filter((key) => ["evaluationId", "kind", "mode", "requestedModel"].includes(key)).sort());
      }
      for (const event of outcomes) {
        if (event.type === "decision.fallback") {
          expect(
            FALLBACK_REASONS as readonly string[],
            `decision.fallback 必须带标准 fallbackReason（实际 ${String(event.meta?.fallbackReason)}）`,
          ).toContain(event.meta?.fallbackReason);
        } else {
          expect(event.meta?.status, `decision.completed 的 meta.status 必须是 completed`).toBe("completed");
        }
      }

      // ---------------------------------------------------------------------
      // (4) 没有任何「决策内容改变了状态」的痕迹。
      // ---------------------------------------------------------------------
      const serializedRun = JSON.stringify(run);
      for (const decision of decisions) {
        expect(
          serializedRun.includes(decision.evaluationId),
          `运行文档不得写入决策 evaluationId（${decision.evaluationId}）：决策内容不得回流到运行状态`,
        ).toBe(false);
      }
      expect(
        serializedRun.includes("appliedOutcome"),
        `运行文档不得包含 appliedOutcome：shadow 的决策结果不得写入运行状态`,
      ).toBe(false);
      for (const finding of run.findings ?? []) {
        expect(
          ["critical", "high", "medium", "low"],
          `finding 等级被改写：${JSON.stringify(finding)}`,
        ).toContain(finding.severity);
        for (const key of Object.keys(finding as unknown as Record<string, unknown>)) {
          expect(
            /^decision/i.test(key) || key === "appliedOutcome",
            `finding 不得携带决策内容字段 ${key}：${JSON.stringify(finding)}`,
          ).toBe(false);
        }
      }
      if (run.diff && run.diff.trim().length > 0) {
        expect(run.diff.includes("appliedOutcome"), `run.diff 不得包含 appliedOutcome：决策内容不得进入交付物`).toBe(false);
        expect(
          decisions.some((decision) => run.diff!.includes(decision.evaluationId)),
          `run.diff 不得包含决策 evaluationId`,
        ).toBe(false);
      }

      // ---------------------------------------------------------------------
      // (5) 反向对照：非 owner 读同一 run 的 decisions 必须是 404。
      // ---------------------------------------------------------------------
      const other = await playwrightRequest.newContext({
        baseURL: BASE_URL,
        extraHTTPHeaders: { "x-pigo-dev-email": OTHER_EMAIL },
      });
      try {
        const meResponse = await other.get("/api/me");
        if (!meResponse.ok()) {
          test.info().annotations.push({
            type: "skipped-assertion",
            description: `第二个身份对照跳过：GET /api/me 以 x-pigo-dev-email=${OTHER_EMAIL} 返回 HTTP ${meResponse.status()}（非 development 认证模式无法伪造第二个身份）。`,
          });
        } else {
          const me = (await meResponse.json()) as { id?: string; email?: string };
          const primaryResponse = await request.get("/api/me");
          const primary = primaryResponse.ok() ? ((await primaryResponse.json()) as { id?: string }) : {};
          if (!me.id || me.id === primary.id) {
            test.info().annotations.push({
              type: "skipped-assertion",
              description: `第二个身份对照跳过：x-pigo-dev-email=${OTHER_EMAIL} 解析到与主身份相同的 user id（${String(me.id)}），无法构造「非 owner」读取。`,
            });
          } else {
            const denied = await other.get(`/api/runs/${runId}/decisions`);
            expect(
              denied.status(),
              `非 owner（${OTHER_EMAIL}）读取 run ${runId} 的决策审计必须 404（owner 作用域），实际 HTTP ${denied.status()}：${(await denied.text()).slice(0, 200)}`,
            ).toBe(404);
            // 正向对照：同一请求在 owner 身份下是 200，证明 404 来自 owner 作用域而非路由缺失。
            const allowed = await request.get(`/api/runs/${runId}/decisions`);
            expect(allowed.status(), `owner 读取同一 run 的决策审计必须 200`).toBe(200);
          }
        }
      } finally {
        await other.dispose();
      }
    } finally {
      if (runId) await cancelIfActive(request, runId);
    }
  });
});
