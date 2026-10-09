import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeRelease } from "./release-execution.js";

describe("executeRelease webhook", () => {
  it("sends authentication, HMAC and a stable delivery id", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestInit = init;
      return new Response(null, { status: 200 });
    };
    const payload = { runId: "run_1", commit: "abc" };
    const result = await executeRelease(
      { configured: true, kind: "webhook", url: "https://deploy.example/hook" },
      payload,
      { deliveryId: "release_1", webhookToken: "secret", fetchImpl },
    );
    expect(result).toMatchObject({ status: "succeeded", httpStatus: 200 });
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("x-pigo-delivery-id")).toBe("release_1");
    expect(headers.get("x-pigo-signature")).toBe(`sha256=${createHmac("sha256", "secret").update(JSON.stringify(payload)).digest("hex")}`);
  });

  it("treats HTTP 202 as triggered rather than successfully deployed", async () => {
    const result = await executeRelease(
      { configured: true, kind: "webhook", url: "https://deploy.example/hook" },
      { runId: "run_1" },
      { deliveryId: "release_1", webhookToken: "secret", fetchImpl: async () => new Response(null, { status: 202 }) },
    );
    expect(result).toMatchObject({ status: "triggered", httpStatus: 202 });
  });

  it("records non-2xx and transport failures as failures", async () => {
    await expect(executeRelease(
      { configured: true, kind: "webhook", url: "https://deploy.example/hook" },
      {},
      { deliveryId: "release_1", fetchImpl: async () => new Response(null, { status: 503 }) },
    )).resolves.toMatchObject({ status: "failed", httpStatus: 503 });
    await expect(executeRelease(
      { configured: true, kind: "webhook", url: "https://deploy.example/hook" },
      {},
      { deliveryId: "release_1", fetchImpl: async () => { throw new Error("offline"); } },
    )).resolves.toMatchObject({ status: "failed", detail: "webhook request failed (Error)" });
  });

  it("keeps a bounded JSON rejection reason so operators can diagnose 4xx responses", async () => {
    const result = await executeRelease(
      { configured: true, kind: "webhook", url: "https://deploy.example/hook" },
      {},
      {
        deliveryId: "release_1",
        fetchImpl: async () => new Response(JSON.stringify({ error: "repository must be a safe workspace path\n" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      httpStatus: 400,
      detail: "HTTP 400: repository must be a safe workspace path",
    });
  });
});
