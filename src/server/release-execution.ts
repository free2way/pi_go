import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import type { PostMergeDeployPlan } from "./run-merge.js";

export interface ReleaseExecutionOutcome {
  configured: boolean;
  kind: "webhook" | "command" | "none";
  status: "succeeded" | "triggered" | "failed" | "not_configured" | "unsupported";
  detail: string;
  httpStatus?: number;
}

/**
 * Invokes the operator-controlled publisher. HTTP delivery is authenticated and
 * idempotency-addressable; HTTP 202 is only "triggered", never final success.
 */
export async function executeRelease(
  plan: PostMergeDeployPlan,
  payload: Record<string, unknown>,
  options: { deliveryId: string; webhookToken?: string; fetchImpl?: typeof fetch },
): Promise<ReleaseExecutionOutcome> {
  if (!plan.configured) return { configured: false, kind: "none", status: "not_configured", detail: plan.reason };
  if (plan.kind === "unsupported") return { configured: true, kind: "none", status: "unsupported", detail: plan.reason };
  if (plan.kind === "webhook") {
    try {
      const body = JSON.stringify(payload);
      const signature = options.webhookToken
        ? `sha256=${createHmac("sha256", options.webhookToken).update(body).digest("hex")}`
        : undefined;
      const response = await (options.fetchImpl ?? fetch)(plan.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PiGO-Delivery-Id": options.deliveryId,
          ...(options.webhookToken
            ? { Authorization: `Bearer ${options.webhookToken}`, "X-PiGO-Signature": signature! }
            : {}),
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 202) {
        return { configured: true, kind: "webhook", status: "triggered", detail: "HTTP 202；等待部署系统回调", httpStatus: response.status };
      }
      return response.ok
        ? { configured: true, kind: "webhook", status: "succeeded", detail: `HTTP ${response.status}`, httpStatus: response.status }
        : { configured: true, kind: "webhook", status: "failed", detail: `HTTP ${response.status}`, httpStatus: response.status };
    } catch (error) {
      return { configured: true, kind: "webhook", status: "failed", detail: `webhook request failed (${(error as Error).name || "Error"})` };
    }
  }

  // Operator-configured command. Bounded and run with a scrubbed environment;
  // run metadata is passed on stdin, never interpolated into the command.
  return new Promise((resolve) => {
    const child = execFile("/bin/sh", ["-c", plan.command], { timeout: 60_000, maxBuffer: 1_000_000, env: { PATH: process.env.PATH ?? "" } }, (error, stdout, stderr) => {
      void stdout;
      void stderr;
      if (error) {
        const code = (error as NodeJS.ErrnoException & { signal?: string }).code ?? "unknown";
        return resolve({ configured: true, kind: "command", status: "failed", detail: `command failed (code ${code})` });
      }
      resolve({ configured: true, kind: "command", status: "succeeded", detail: "exit 0" });
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}
