import assert from "node:assert/strict";
import test from "node:test";
import { checkClerkConfig, probeClerkOrigin } from "./clerk-config-check.mjs";

const key = (type, tier) => `${type}_${tier}_${"x".repeat(24)}`;

test("accepts matching live keys and an HTTPS production origin", () => {
  const result = checkClerkConfig({
    NODE_ENV: "production",
    PI_AUTH_MODE: "clerk",
    PI_PUBLIC_ORIGIN: "https://pigo.example.com",
    CLERK_PUBLISHABLE_KEY: key("pk", "live"),
    CLERK_SECRET_KEY: key("sk", "live"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.facts.keyTier, "live");
});

test("rejects test keys, a path-bearing origin, and mixed Clerk instances in production", () => {
  const result = checkClerkConfig({
    NODE_ENV: "production",
    PI_AUTH_MODE: "clerk",
    PI_PUBLIC_ORIGIN: "https://pigo.example.com/app",
    CLERK_PUBLISHABLE_KEY: key("pk", "test"),
    CLERK_SECRET_KEY: key("sk", "live"),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /different instances/);
  assert.match(result.errors.join("\n"), /live-instance/);
  assert.match(result.errors.join("\n"), /origin-only HTTPS/);
});

test("warns when a legacy Cloudflare Access gate is still configured", () => {
  const result = checkClerkConfig({
    PI_AUTH_MODE: "clerk",
    PI_PUBLIC_ORIGIN: "http://localhost:3100",
    CLERK_PUBLISHABLE_KEY: key("pk", "test"),
    CLERK_SECRET_KEY: key("sk", "test"),
    PI_CF_ACCESS_TEAM_DOMAIN: "legacy.example.com",
  });
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /upstream Access gate/);
});

test("public probe rejects an upstream redirect before parsing a response body", async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://access.example.com/login" } });
  await assert.rejects(() => probeClerkOrigin("https://pigo.example.com", key("pk", "live"), fetchImpl), /redirects before reaching PiGO/);
});

test("public probe verifies mode and the expected public Clerk instance", async () => {
  const publishableKey = key("pk", "live");
  const fetchImpl = async () => Response.json({ mode: "clerk", clerk: { publishableKey, proxyUrl: "/__clerk" } });
  assert.deepEqual(await probeClerkOrigin("https://pigo.example.com", publishableKey, fetchImpl), { status: 200, mode: "clerk", proxyUrl: "/__clerk" });
});

test("public probe rejects the obsolete top-level fixture instead of accepting an invalid API shape", async () => {
  const publishableKey = key("pk", "live");
  const fetchImpl = async () => Response.json({ mode: "clerk", publishableKey });
  await assert.rejects(() => probeClerkOrigin("https://pigo.example.com", publishableKey, fetchImpl));
});

test("public probe rejects a different nested instance without printing either key", async () => {
  const publishableKey = key("pk", "live"), other = key("pk", "test");
  await assert.rejects(() => probeClerkOrigin("https://pigo.example.com", publishableKey,
    async () => Response.json({ mode: "clerk", clerk: { publishableKey: other, proxyUrl: "/__clerk" } })),
  (error) => !error.message.includes(publishableKey) && !error.message.includes(other));
});

for (const proxyUrl of [undefined, "", "/", "__clerk", 42, "//other.example.com", "https://other.example.com/__clerk", "/__clerk?token=DUMMY_query", "/__clerk#DUMMY_fragment"]) {
  test(`public probe rejects unsafe or missing proxy ${String(proxyUrl)}`, async () => {
    const publishableKey = key("pk", "live");
    await assert.rejects(() => probeClerkOrigin("https://pigo.example.com", publishableKey,
      async () => Response.json({ mode: "clerk", clerk: { publishableKey, proxyUrl } })), /unsafe or missing/);
  });
}

test("public probe accepts an absolute same-origin proxy and normalizes trailing slashes", async () => {
  const publishableKey = key("pk", "live");
  const result = await probeClerkOrigin("https://pigo.example.com", publishableKey,
    async () => Response.json({ mode: "clerk", clerk: { publishableKey, proxyUrl: "https://pigo.example.com/__clerk/" } }));
  assert.equal(result.proxyUrl, "/__clerk");
});

test("public probe hides untrusted network and JSON failures", async () => {
  const canary = "DUMMY_private-diagnostic";
  for (const fetchImpl of [async () => { throw new Error(canary); }, async () => new Response(canary)]) {
    await assert.rejects(() => probeClerkOrigin("https://pigo.example.com", key("pk", "live"), fetchImpl),
      error => !error.message.includes(canary));
  }
});

test("public probe rejects an unsafe origin before network I/O", async () => {
  let calls = 0;
  const origin = new URL("https://pigo.example.com");
  origin.username = "x";
  origin.password = ["DUMMY", "password"].join("_");
  await assert.rejects(() => probeClerkOrigin(origin.href, key("pk", "live"),
    async () => { calls++; throw new Error("must not fetch"); }), /safe origin-only/);
  assert.equal(calls, 0);
});
