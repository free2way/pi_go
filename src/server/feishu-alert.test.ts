import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAlertSink } from "./alerts.js";
import { feishuAlertPayload, isFeishuWebhook, verifyFeishuResponse } from "./feishu-alert.js";

const endpoint = "https://open.feishu.cn/open-apis/bot/v2/hook/DUMMY_bot";
const signingValue = ["DUMMY", "signing"].join("_");
const credentialEndpoint = new URL(endpoint);
credentialEndpoint.username = ["DUMMY", "user"].join("_");
credentialEndpoint.password = ["DUMMY", "password"].join("_");
const misleadingEndpoint = ["https://open.feishu.cn", "attacker.invalid/open-apis/bot/v2/hook/DUMMY"].join("@");
const alert = { key: "worker_unreachable", severity: "critical" as const, message: "Worker unavailable" };

describe("Feishu custom-bot adapter", () => {
  it("sends bilingual labels and a redacted summary without raw details or mentions", async () => {
    const log = vi.fn(), fetchImpl = vi.fn().mockResolvedValue(Response.json({ code: 0 }));
    createAlertSink({ log, fetchImpl: fetchImpl as unknown as typeof fetch, webhookUrl: endpoint,
      environment: { PI_ALERT_WEBHOOK_PROVIDER: "feishu", PI_ALERT_FEISHU_SIGNING_SECRET: signingValue, PI_DEPLOYMENT_ENVIRONMENT: "production", PI_WEB_VERSION: "abc1234" },
    })({ ...alert, message: 'Bearer DUMMY_bearer DUMMY_signing <at user_id="all">everyone</at>', details: { privateField: "DUMMY_raw" } });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const [url, init] = fetchImpl.mock.calls[0], body = JSON.parse(init.body);
    expect(url).toBe(endpoint);
    expect(body).toMatchObject({ msg_type: "text", timestamp: expect.any(String), sign: expect.any(String), content: { text: expect.stringContaining("PiGO CRITICAL 告警") } });
    expect(body.content.text).toContain("production");
    expect(body.content.text).toContain("abc1234");
    expect(body.content.text).toContain("[redacted]");
    expect(body.content.text).not.toContain("DUMMY");
    expect(body.content.text).not.toContain("<at");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(log.mock.calls)).not.toContain("DUMMY_signing");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("computes the official seconds-based HMAC over the empty message", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_799_999_999_123);
    try {
      const body = feishuAlertPayload({ ...alert, service: "pigo-web", environment: "staging", version: "abc1234", at: "test" }, "DUMMY_signing");
      expect(body).toMatchObject({ timestamp: "1799999999", sign: createHmac("sha256", "1799999999\nDUMMY_signing").update("").digest("base64") });
    } finally { now.mockRestore(); }
  });

  it("omits optional signing fields and bounds UTF-8 message size", () => {
    const body = feishuAlertPayload({ ...alert, message: "😀".repeat(30_000), service: "pigo-web", environment: "staging", version: "abc", at: "test" });
    expect(body).not.toHaveProperty("timestamp");
    expect(body).not.toHaveProperty("sign");
    expect(Array.from(body.content.text)).toHaveLength(3_000);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(20_000);
  });

  it.each([19021, 19022, 19024, 9499])("reports HTTP 200 business rejection %i without receiver text", async (code) => {
    const log = vi.fn(), fetchImpl = vi.fn().mockResolvedValue(Response.json({ code, msg: `DUMMY_receiver ${endpoint}` }));
    createAlertSink({ log, fetchImpl: fetchImpl as unknown as typeof fetch, webhookUrl: endpoint, environment: { PI_ALERT_WEBHOOK_PROVIDER: "feishu" } })(alert);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    expect(log.mock.calls[1][1]).toMatchObject({ error: `Feishu webhook rejected (code ${code})` });
    expect(JSON.stringify(log.mock.calls)).not.toContain("DUMMY");
  });

  it.each([{ code: 0, msg: "success" }, { StatusCode: 0 }, { code: 0, StatusCode: 0 }])("accepts explicit numeric success %j", async (body) => {
    await expect(verifyFeishuResponse(Response.json(body))).resolves.toBeUndefined();
  });

  it.each([{}, [], null, { code: "0" }, { code: null, StatusCode: 0 }, { code: 1, StatusCode: 0 }, { code: 0, StatusCode: 1 }])("rejects missing, malformed or conflicting business status %j", async (body) => {
    await expect(verifyFeishuResponse(Response.json(body))).rejects.toThrow(/^Feishu webhook /);
  });

  it.each(["DUMMY_private malformed response", "DUMMY_private".repeat(1_000), ""]) ("contains invalid/oversized/empty response bodies", async (text) => {
    await expect(verifyFeishuResponse(new Response(text))).rejects.toThrow("Feishu webhook invalid response");
  });

  it("cancels oversized streaming responses before reading further", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4_097)); }, cancel });
    await expect(verifyFeishuResponse(new Response(stream))).rejects.toThrow("invalid response");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["https://attacker.invalid/open-apis/bot/v2/hook/DUMMY", "http://open.feishu.cn/open-apis/bot/v2/hook/DUMMY", misleadingEndpoint, endpoint + "?secret=DUMMY", endpoint + "#DUMMY", credentialEndpoint.href, "https://open.feishu.cn:444/open-apis/bot/v2/hook/DUMMY", "not a URL"]) ("rejects a nonofficial or credential-bearing endpoint", (url) => {
    expect(isFeishuWebhook(url)).toBe(false);
    const log = vi.fn(), fetchImpl = vi.fn();
    createAlertSink({ log, fetchImpl, webhookUrl: url, environment: { PI_ALERT_WEBHOOK_PROVIDER: "feishu" } })(alert);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.mock.calls[1][1]).toMatchObject({ error: "Invalid Feishu webhook endpoint" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("DUMMY");
  });

  it("accepts the official custom-bot endpoint", () => { expect(isFeishuWebhook(endpoint)).toBe(true); });

  it("rejects an unknown provider instead of silently sending generic JSON", () => {
    const log = vi.fn(), fetchImpl = vi.fn();
    createAlertSink({ log, fetchImpl, webhookUrl: endpoint, environment: { PI_ALERT_WEBHOOK_PROVIDER: "typo" } })(alert);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.mock.calls[1][1]).toMatchObject({ error: "Unsupported alert webhook provider" });
  });

  it("contains transport failures even when the endpoint was passed outside the environment", async () => {
    const log = vi.fn(), fetchImpl = vi.fn().mockRejectedValue(new Error(`failed: ${endpoint}`));
    createAlertSink({ log, fetchImpl: fetchImpl as unknown as typeof fetch, webhookUrl: endpoint, environment: { PI_ALERT_WEBHOOK_PROVIDER: "feishu" } })(alert);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(log.mock.calls)).not.toContain("DUMMY_bot");
    expect(log.mock.calls[1][1].error).toBe("failed: [redacted]");
  });
});
