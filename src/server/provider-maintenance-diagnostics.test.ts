import { describe, expect, it, vi } from "vitest";
import { createProviderProbe } from "./provider-probe.js";
import { createDecisionAuditRetentionSweeper } from "./decision-engine/audit-retention.js";
import { createAuditRetentionTrigger } from "../worker/audit-retention.js";
import { createReviewTriageTrigger } from "../worker/decision-triage.js";

const secret = ["DUMMY", 'opaque/+"', "x".repeat(2_100)].join("_");
const privatePath = "/fixture/DUMMY-private-vault.json";
const base = "https://fixture.invalid/DUMMY-provider/v1";
const environment = {
  PI_INTERNAL_TOKEN: secret,
  PI_VAULT_FILE: privatePath,
  PI_WEB_CALLBACK_URL: base,
  PI_ALERT_WEBHOOK: base,
  PI_PROVIDER_PROBE_BASE_URL: base,
  PI_DECISION_AUDIT_RETENTION_DAYS: "30",
};
const formats = {
  plain: (value: string) => value,
  uri: encodeURIComponent,
  json: (value: string) => JSON.stringify(value).slice(1, -1),
  "double-json": (value: string) => JSON.stringify(JSON.stringify(value).slice(1, -1)).slice(1, -1),
};
const cases = Object.entries(formats);

function failureText(encode: (value: string) => string) {
  return `ECONNRESET ${encode(secret)} ${encode(privatePath)} ${encode(base)}`;
}

function expectSafe(value: string, limit: number) {
  expect(value).toContain("ECONNRESET");
  expect(value).not.toContain("DUMMY");
  expect(value.length).toBeLessThanOrEqual(limit);
}

describe("provider and maintenance diagnostic boundaries", () => {
  it.each(cases)("redacts %s provider-authored field names while retaining model discovery", async (_name, encode) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = { [encode(secret)]: "not logged", data: [{ id: "fixture-model", [encode(privatePath)]: secret }] };
    const original = JSON.stringify(body);
    try {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(`${base}/models`);
        expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${secret}`);
        return new Response(JSON.stringify(body), { status: 200 });
      });
      const probe = createProviderProbe({ env: { ...environment, PI_PROBE_DIAG: "1" }, fetchImpl: fetchImpl as typeof fetch });
      expect(await probe({ provider: "custom", apiKey: secret })).toEqual({ ok: true, models: ["fixture-model"] });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain("[probe-diag]");
      expect(line).toContain("data:array(1)");
      expect(line).not.toContain("DUMMY");
      expect(line.length).toBeLessThanOrEqual(2_000);
      expect(JSON.stringify(body)).toBe(original);
    } finally { warn.mockRestore(); }
  });

  it.each(cases)("projects a %s probe transport failure without changing classification or Error", async (_name, encode) => {
    const text = failureText(encode);
    const failure = new Error(text);
    const stack = failure.stack;
    const probe = createProviderProbe({ env: environment, fetchImpl: (async () => { throw failure; }) as typeof fetch });
    const result = await probe({ provider: "custom", apiKey: secret });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unreachable probe");
    expect(result.code).toBe("PROBE_UNREACHABLE");
    expectSafe(result.message, 2_050);
    expect(failure.message).toBe(text);
    expect(failure.stack).toBe(stack);
  });

  it.each(cases)("redacts a %s server retention failure before the 300-character bound and stays throttled", async (_name, encode) => {
    const text = failureText(encode);
    const failure = new Error(text);
    const pruneOlderThan = vi.fn(async () => { throw failure; });
    const warn = vi.fn();
    const sweep = createDecisionAuditRetentionSweeper({ env: environment, store: { pruneOlderThan }, warn });
    await expect(sweep()).resolves.toBeUndefined();
    await expect(sweep()).resolves.toBeUndefined();
    expect(pruneOlderThan).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expectSafe(String(warn.mock.calls[0][1].error), 300);
    expect(failure.message).toBe(text);
  });

  describe.each(["triage", "retention"] as const)("worker %s trigger", (kind) => {
    it.each(cases)("redacts %s failure through the default console sink and retries successfully", async (_name, encode) => {
      const text = failureText(encode);
      const failure = new Error(text);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const send = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ ok: true });
      try {
        if (kind === "triage") {
          const trigger = createReviewTriageTrigger({ enabled: true, env: environment, send });
          await expect(trigger("fixture")).resolves.toBeUndefined();
          await expect(trigger("fixture")).resolves.toBeUndefined();
        } else {
          let at = Date.now();
          const trigger = createAuditRetentionTrigger({ env: environment, send, intervalMs: 100, now: () => at });
          await expect(trigger()).resolves.toBe(false);
          await expect(trigger()).resolves.toBe(false);
          expect(send).toHaveBeenCalledTimes(1);
          at += 100;
          await expect(trigger()).resolves.toBe(true);
        }
        expect(send).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(1);
        expectSafe(String(warn.mock.calls[0][0]), 450);
        expect(failure.message).toBe(text);
      } finally { warn.mockRestore(); }
    });
  });

  it("leaves provider diagnostic logging disabled by default", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const probe = createProviderProbe({ env: environment, fetchImpl: (async () => new Response('{"data":[{"id":"fixture"}]}')) as typeof fetch });
      expect(await probe({ provider: "custom", apiKey: secret })).toEqual({ ok: true, models: ["fixture"] });
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});
