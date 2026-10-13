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
  const fetchImpl = async () => Response.json({ mode: "clerk", publishableKey });
  assert.deepEqual(await probeClerkOrigin("https://pigo.example.com", publishableKey, fetchImpl), { status: 200, mode: "clerk" });
});
