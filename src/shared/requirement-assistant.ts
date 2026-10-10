import type { Locale } from "./i18n.js";
import type { ModelSelection } from "./types.js";

export const REQUIREMENT_SPEC_SCHEMA_VERSION = 1 as const;
export const REQUIREMENT_PROMPT_VERSION = "requirement-assistant-1";

export type RequirementVerification = "automated" | "manual" | "review";
export type RequirementReadiness = "ready" | "needs_clarification";

export interface RequirementAcceptanceCriterion {
  id: string;
  statement: string;
  verification: RequirementVerification;
}

/** Structured, versioned contract shared by Pi, the API and both authoring UIs. */
export interface RequirementSpec {
  schemaVersion: typeof REQUIREMENT_SPEC_SCHEMA_VERSION;
  title: string;
  objective: string;
  background: string;
  inScope: string[];
  outOfScope: string[];
  constraints: string[];
  acceptanceCriteria: RequirementAcceptanceCriterion[];
  definitionOfDone: string[];
  assumptions: string[];
  risks: string[];
  openQuestions: string[];
  suggestedChecks: string[];
  readiness: RequirementReadiness;
}

export interface RequirementRefinement {
  spec: RequirementSpec;
  /** Canonical text used by the existing run engine. */
  task: string;
  /** Flat compatibility field already supported by Run. */
  acceptanceCriteria: string;
  model: ModelSelection;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  promptVersion: string;
}

export interface RequirementRefineInput {
  draft: string;
  title?: string;
  context?: {
    source?: "run" | "story";
    projectName?: string;
    workspaceName?: string;
  };
  model?: ModelSelection;
}

function cleanJson(text: string) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/** Extracts the first balanced JSON object without accepting trailing prose as data. */
function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = cleanJson(text);
  try {
    const direct = JSON.parse(cleaned) as unknown;
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  } catch {
    // Fall through to balanced-object extraction.
  }
  for (let start = cleaned.indexOf("{"); start >= 0; start = cleaned.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const character = cleaned[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const candidate = JSON.parse(cleaned.slice(start, index + 1)) as unknown;
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate as Record<string, unknown>;
        } catch {
          break;
        }
      }
    }
  }
  throw new SyntaxError("Requirement assistant response did not contain a valid JSON object");
}

function text(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function textList(value: unknown, maxItems: number, maxLength = 500): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const normalized = text(item, maxLength);
    if (normalized && !result.includes(normalized)) result.push(normalized);
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeCriteria(value: unknown): RequirementAcceptanceCriterion[] {
  if (!Array.isArray(value)) return [];
  const result: RequirementAcceptanceCriterion[] = [];
  for (const [index, raw] of value.entries()) {
    const item = typeof raw === "string" ? { statement: raw } : (raw ?? {}) as Record<string, unknown>;
    const statement = text(item.statement, 800);
    if (!statement) continue;
    const verification = item.verification === "automated" || item.verification === "manual" || item.verification === "review"
      ? item.verification
      : "review";
    result.push({
      id: text(item.id, 40) || `AC-${index + 1}`,
      statement,
      verification,
    });
    if (result.length >= 30) break;
  }
  return result;
}

/** Strictly normalizes Pi output and rejects a superficially valid but unusable spec. */
export function parseRequirementSpec(output: string): RequirementSpec {
  const raw = parseJsonObject(output);
  if (raw.schemaVersion !== REQUIREMENT_SPEC_SCHEMA_VERSION) {
    throw new Error("Requirement assistant returned an unsupported schema version");
  }
  const openQuestions = textList(raw.openQuestions, 3);
  const acceptanceCriteria = normalizeCriteria(raw.acceptanceCriteria);
  const readiness: RequirementReadiness = raw.readiness === "needs_clarification" || openQuestions.length > 0
    ? "needs_clarification"
    : "ready";
  const spec: RequirementSpec = {
    schemaVersion: REQUIREMENT_SPEC_SCHEMA_VERSION,
    title: text(raw.title, 200),
    objective: text(raw.objective, 2_000),
    background: text(raw.background, 2_000),
    inScope: textList(raw.inScope, 30),
    outOfScope: textList(raw.outOfScope, 30),
    constraints: textList(raw.constraints, 30),
    acceptanceCriteria,
    definitionOfDone: textList(raw.definitionOfDone, 30),
    assumptions: textList(raw.assumptions, 20),
    risks: textList(raw.risks, 20),
    openQuestions,
    suggestedChecks: textList(raw.suggestedChecks, 8),
    readiness,
  };
  if (spec.title.length < 2) throw new Error("Requirement assistant returned an invalid title");
  if (spec.objective.length < 10) throw new Error("Requirement assistant returned an invalid objective");
  if (spec.readiness === "ready" && spec.acceptanceCriteria.length === 0) {
    throw new Error("Requirement assistant marked the requirement ready without acceptance criteria");
  }
  return spec;
}

const bulletSection = (heading: string, values: string[]) => values.length
  ? `\n## ${heading}\n${values.map((value) => `- ${value}`).join("\n")}\n`
  : "";

/** Renders the structured contract into the existing task prompt without losing sections. */
export function renderRequirementTask(spec: RequirementSpec, locale: Locale): string {
  const zh = locale !== "en";
  const labels = zh
    ? { objective: "目标", background: "背景", inScope: "范围内", outOfScope: "范围外", constraints: "技术与业务约束", acceptance: "验收条件", dod: "完成定义", assumptions: "假设", risks: "风险", questions: "待确认问题" }
    : { objective: "Objective", background: "Background", inScope: "In scope", outOfScope: "Out of scope", constraints: "Technical and business constraints", acceptance: "Acceptance criteria", dod: "Definition of done", assumptions: "Assumptions", risks: "Risks", questions: "Open questions" };
  let result = `# ${spec.title}\n\n## ${labels.objective}\n${spec.objective}\n`;
  if (spec.background) result += `\n## ${labels.background}\n${spec.background}\n`;
  result += bulletSection(labels.inScope, spec.inScope);
  result += bulletSection(labels.outOfScope, spec.outOfScope);
  result += bulletSection(labels.constraints, spec.constraints);
  if (spec.acceptanceCriteria.length) {
    result += `\n## ${labels.acceptance}\n${spec.acceptanceCriteria.map((item) => `- [${item.id}] ${item.statement} (${item.verification})`).join("\n")}\n`;
  }
  result += bulletSection(labels.dod, spec.definitionOfDone);
  result += bulletSection(labels.assumptions, spec.assumptions);
  result += bulletSection(labels.risks, spec.risks);
  result += bulletSection(labels.questions, spec.openQuestions);
  return result.trim();
}

export function renderAcceptanceCriteria(spec: RequirementSpec): string {
  return spec.acceptanceCriteria.map((item) => `[${item.id}] ${item.statement} (${item.verification})`).join("\n");
}

/** Compact body for the Agile Story description; criteria and DoD stay in their own fields. */
export function renderRequirementStoryDescription(spec: RequirementSpec, locale: Locale): string {
  const zh = locale !== "en";
  const sections = [spec.objective];
  if (spec.background) sections.push(`${zh ? "背景" : "Background"}:\n${spec.background}`);
  if (spec.inScope.length) sections.push(`${zh ? "范围内" : "In scope"}:\n${spec.inScope.map((item) => `- ${item}`).join("\n")}`);
  if (spec.outOfScope.length) sections.push(`${zh ? "范围外" : "Out of scope"}:\n${spec.outOfScope.map((item) => `- ${item}`).join("\n")}`);
  if (spec.constraints.length) sections.push(`${zh ? "约束" : "Constraints"}:\n${spec.constraints.map((item) => `- ${item}`).join("\n")}`);
  return sections.join("\n\n");
}
