import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("worker durable lease contract", () => {
  it("claims before acquiring a workspace lock or starting execution", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("async function dispatchJob("), source.indexOf("/** Retries locally deferred jobs"));
    expect(body.indexOf("await jobApi.claim(input.jobId)")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("await jobApi.claim(input.jobId)")).toBeLessThan(body.indexOf("workspaceLocks.acquire"));
    expect(body.indexOf("workspaceLocks.acquire")).toBeLessThan(body.indexOf("await executeJob(input, controller)"));
    expect(body).toContain("JOB_LEASE_LOST");
  });

  it("sends lease identity with every active run callback", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("async function postUpdate("), source.indexOf("async function update("));
    expect(body).toContain("activeJobLeases.get(runId)");
    expect(body).toContain("{ jobId, workerId }");
  });

  it("injects every transitional provider alias without inheriting other role keys", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("async function runPi("), source.indexOf("function emptyPlan"));
    expect(body).toContain("apiKeyEnvNames(input.provider)");
    expect(body).toContain("scrubEnvironment(process.env, credentialEnvironmentNames)");
    expect(body).toContain("for (const name of credentialEnvironmentNames) childEnvironment[name] = input.apiKey");
  });

  it("classifies queueable Worker refusals by code, never by message text", async () => {
    const source = await readFile(new URL("../server/index.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("async function dispatchJob(\n  run:"), source.indexOf("/** Re-queues jobs whose worker"));
    expect(body).toContain("workerRefusalDisposition(error)");
    expect(body).not.toMatch(/capacity\/i\.test/);
    expect(body).toContain("finishJobAsSystem");
  });
});
