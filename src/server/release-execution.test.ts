import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { executeRelease } from "./release-execution.js";

describe("executeRelease webhook", () => {
  const fake = (label: string) => ["DUMMY", label].join("_");

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

  it("redacts rejection credentials and the configured token before truncating diagnostics", async () => {
    const token = `${fake("opaque")}/+ long secret`;
    const echoed = ["upstream refused", token, encodeURIComponent(token), `Bearer ${fake("authorization")}`,
      "https://" + ["user", fake("url")].join(":") + "@deploy.example.invalid/", `https://deploy.example.invalid/?token=${fake("query")}`].join(" ");
    const result = await executeRelease(
      { configured: true, kind: "webhook", url: "https://deploy.example.invalid/hook" }, {},
      { deliveryId: "release_1", webhookToken: token, fetchImpl: async () => new Response(JSON.stringify({ error: echoed }), { status: 400 }) },
    );
    expect(result.status).toBe("failed");
    expect(result.httpStatus).toBe(400);
    expect(result.detail).toContain("upstream refused");
    expect(result.detail).toContain("[redacted");
    expect(result.detail).not.toContain("DUMMY");

    const boundary = await executeRelease(
      { configured: true, kind: "webhook", url: "https://deploy.example.invalid/hook" }, {},
      { deliveryId: "release_1", webhookToken: token, fetchImpl: async () => new Response(JSON.stringify({ error: "x".repeat(285) + token }), { status: 400 }) },
    );
    expect(boundary.detail).not.toContain("DUMMY");
  });

  it.each([307, 308])("refuses HTTP %i without forwarding the signed request or reporting target success", async (status) => {
    const servers: Server[] = [];
    const listen = async (server: Server) => {
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    let targetHits = 0;
    let hookHits = 0;
    try {
      const target = await listen(createServer((_request, response) => { targetHits += 1; response.writeHead(200).end(); }));
      const hook = await listen(createServer((_request, response) => { hookHits += 1; response.writeHead(status, { location: target }).end(); }));
      const result = await executeRelease({ configured: true, kind: "webhook", url: hook },
        { runId: "run_1", commit: "a".repeat(40) }, { deliveryId: "release_1", webhookToken: fake("hook") });
      expect(result).toMatchObject({ status: "failed", httpStatus: status, detail: `HTTP ${status}` });
      expect(hookHits).toBe(1);
      expect(targetHits).toBe(0);
    } finally {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
    }
  });
});
