import type { Finding } from "../shared/types.js";

export type ReviewResult = {
  verdict: "approved" | "changes_requested";
  summary: string;
  findings: Array<Omit<Finding, "resolved">>;
};

const severities = ["critical", "high", "medium", "low"] as const;

/** Severities that must never accompany an `approved` verdict (AUD-03). */
export const blockingSeverities: ReadonlyArray<Finding["severity"]> = ["critical", "high", "medium"];

function cleanJson(text: string) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * Review models occasionally wrap an otherwise valid object in one explanatory
 * sentence. Extract the first balanced JSON object locally so formatting noise
 * does not trigger another multi-minute model call. Quoted braces and escapes are
 * handled; schema validation still happens below.
 */
function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = cleanJson(text);
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
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
          const candidate = JSON.parse(cleaned.slice(start, index + 1));
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
            return candidate as Record<string, unknown>;
          }
        } catch {
          break;
        }
      }
    }
  }
  throw new SyntaxError("Reviewer response did not contain a valid JSON object");
}

function normalizeFinding(raw: unknown, round: number, index: number): Omit<Finding, "resolved"> {
  const item = (raw ?? {}) as Record<string, unknown>;
  const severity = severities.includes(item.severity as (typeof severities)[number])
    ? item.severity as Finding["severity"]
    : "medium";
  return {
    id: String(item.id || `review-${round}-${index + 1}`).slice(0, 120),
    severity,
    file: typeof item.file === "string" && item.file ? item.file.slice(0, 400) : null,
    line: typeof item.line === "number" && Number.isInteger(item.line) && item.line >= 0 ? item.line : null,
    title: String(item.title || "Untitled finding").slice(0, 300),
    evidence: String(item.evidence || "").slice(0, 4_000),
    requiredChange: String(item.requiredChange || "").slice(0, 4_000),
  };
}

export function parseReview(text: string, round = 1): ReviewResult {
  const parsed = parseJsonObject(text);
  if (parsed.verdict !== "approved" && parsed.verdict !== "changes_requested") {
    throw new Error("Reviewer returned an invalid verdict");
  }
  if (!Array.isArray(parsed.findings)) throw new Error("Reviewer returned invalid findings");
  const findings = parsed.findings.slice(0, 100).map((raw, index) => normalizeFinding(raw, round, index));
  if (parsed.verdict === "approved") {
    // AUD-03 / AT-REVIEW-005: an approval carrying blocking findings is a
    // protocol violation, not a pass.
    const blocking = findings.filter((finding) => blockingSeverities.includes(finding.severity));
    if (blocking.length > 0) {
      throw new Error(
        `Reviewer returned approved together with ${blocking.length} blocking finding(s): `
        + blocking.slice(0, 3).map((finding) => `${finding.severity}:${finding.title}`).join("; "),
      );
    }
  }
  return {
    verdict: parsed.verdict,
    summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 4_000) : "",
    findings,
  };
}
