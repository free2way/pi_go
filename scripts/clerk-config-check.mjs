#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function keyTier(value, type) {
  const key = String(value ?? "");
  for (const tier of ["test", "live"]) {
    if (key.startsWith(`${type}_${tier}_`) && key.length >= 20) return tier;
  }
  return undefined;
}

function safePublicOrigin(value, production) {
  try {
    const url = new URL(String(value ?? ""));
    const localDevelopment = !production && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(localDevelopment && url.protocol === "http:")) return undefined;
    if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Static production-readiness checks. Returned messages never contain keys. */
export function checkClerkConfig(env) {
  const errors = [];
  const warnings = [];
  const production = env.NODE_ENV === "production";
  const publishableTier = keyTier(env.CLERK_PUBLISHABLE_KEY, "pk");
  const secretTier = keyTier(env.CLERK_SECRET_KEY, "sk");
  const publicOrigin = safePublicOrigin(env.PI_PUBLIC_ORIGIN, production);

  if (env.PI_AUTH_MODE !== "clerk") errors.push("PI_AUTH_MODE must be clerk");
  if (!publishableTier) errors.push("CLERK_PUBLISHABLE_KEY is missing or has an invalid prefix");
  if (!secretTier) errors.push("CLERK_SECRET_KEY is missing or has an invalid prefix");
  if (publishableTier && secretTier && publishableTier !== secretTier) errors.push("Clerk publishable and secret keys belong to different instances");
  if (production && (publishableTier === "test" || secretTier === "test")) errors.push("production requires Clerk live-instance keys");
  if (!publicOrigin) errors.push("PI_PUBLIC_ORIGIN must be an origin-only HTTPS URL in production");
  if (env.PI_CF_ACCESS_TEAM_DOMAIN || env.PI_CF_ACCESS_AUDIENCE) {
    warnings.push("Cloudflare Access variables are ignored in Clerk mode; remove the upstream Access gate from the public app hostname");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    facts: {
      production,
      publicOrigin,
      keyTier: publishableTier && publishableTier === secretTier ? publishableTier : undefined,
    },
  };
}

/** Verify that the public route reaches PiGO directly instead of an upstream login page. */
export async function probeClerkOrigin(origin, expectedPublishableKey, fetchImpl = fetch) {
  const response = await fetchImpl(`${origin}/api/auth/config`, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("public auth config redirects before reaching PiGO; disable the upstream access login for this hostname");
  }
  if (!response.ok) throw new Error(`public auth config returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.mode !== "clerk") throw new Error("public auth config is not in Clerk mode");
  if (body?.publishableKey !== expectedPublishableKey) throw new Error("public auth config exposes a different Clerk instance");
  return { status: response.status, mode: body.mode };
}

async function main() {
  const probe = process.argv.includes("--probe-origin");
  const result = checkClerkConfig(process.env);
  for (const warning of result.warnings) console.warn(`[clerk-check] WARN ${warning}`);
  for (const error of result.errors) console.error(`[clerk-check] FAIL ${error}`);
  if (!result.ok) process.exitCode = 1;
  if (!result.ok || !probe) {
    if (result.ok) console.log(`[clerk-check] PASS static configuration (${result.facts.keyTier} keys)`);
    return;
  }
  try {
    await probeClerkOrigin(result.facts.publicOrigin, process.env.CLERK_PUBLISHABLE_KEY);
    console.log("[clerk-check] PASS public /api/auth/config reaches PiGO directly");
  } catch (error) {
    console.error(`[clerk-check] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
