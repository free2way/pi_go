#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Resolve from React's dependency context so nested/deduped SDK versions pick
// the same script paths as ClerkProvider, not an unrelated backend dependency.
const clerkRequire = createRequire(import.meta.resolve("@clerk/react"));
const { clerkJSScriptUrl, clerkUIScriptUrl } = clerkRequire("@clerk/shared/loadClerkJsScript");
const { isValidProxyUrl } = clerkRequire("@clerk/shared/proxy");

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
  origin = safePublicOrigin(origin, false);
  if (!origin) throw new Error("public probe requires a safe origin-only URL");
  let response;
  try { response = await fetchImpl(`${origin}/api/auth/config`, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  }); } catch { throw new Error("public auth config request failed"); }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("public auth config redirects before reaching PiGO; disable the upstream access login for this hostname");
  }
  if (!response.ok) throw new Error(`public auth config returned HTTP ${response.status}`);
  let body;
  try { body = await response.json(); } catch { throw new Error("public auth config is not valid JSON"); }
  if (body?.mode !== "clerk") throw new Error("public auth config is not in Clerk mode");
  if (!expectedPublishableKey || body?.clerk?.publishableKey !== expectedPublishableKey) throw new Error("public auth config exposes a different Clerk instance");
  const proxyValue = body.clerk?.proxyUrl;
  const proxy = typeof proxyValue === "string" && isValidProxyUrl(proxyValue) ? sameOriginUrl(proxyValue, origin) : undefined;
  if (!proxy || proxy.pathname === "/") throw new Error("public auth config has an unsafe or missing Clerk proxy");
  return { status: response.status, mode: body.mode, proxyUrl: proxy.pathname.replace(/\/+$/, "") };
}

function sameOriginUrl(value, origin, base = origin) {
  if (typeof value !== "string" || !value.trim() || value.startsWith("//")) return undefined;
  try {
    const url = new URL(value, base);
    if (url.origin !== new URL(origin).origin || url.username || url.password || url.search || url.hash) return undefined;
    return url;
  } catch { return undefined; }
}

/** GET-only reachability check. Script bytes are never executed or returned. */
export async function probeClerkAssets(origin, publishableKey, proxyUrl, fetchImpl = fetch) {
  origin = safePublicOrigin(origin, false);
  if (!origin) throw new Error("asset probe requires a safe origin-only URL");
  const proxy = typeof proxyUrl === "string" && isValidProxyUrl(proxyUrl) ? sameOriginUrl(proxyUrl, origin) : undefined;
  if (!proxy || proxy.pathname === "/") throw new Error("asset probe requires a same-origin Clerk proxy");
  const options = { publishableKey, proxyUrl: proxy.pathname.replace(/\/+$/, "") };
  const routes = [["Clerk JS", clerkJSScriptUrl(options)], ["Clerk UI", clerkUIScriptUrl(options)]];
  const scripts = [];
  for (const [name, route] of routes) {
    let url = sameOriginUrl(route, origin), redirects = 0, response;
    const signal = AbortSignal.timeout(15_000);
    while (true) {
      if (!url || !url.pathname.startsWith(`${options.proxyUrl}/npm/@clerk/`)) throw new Error(`${name} asset route is unsafe`);
      try { response = await fetchImpl(url.href, { method: "GET", redirect: "manual", signal, headers: { accept: "application/javascript" } }); }
      catch { throw new Error(`${name} asset request failed`); }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (++redirects > 4) throw new Error(`${name} asset redirect limit exceeded`);
      url = sameOriginUrl(location, origin, url);
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${name} asset returned HTTP ${response.status}`);
    }
    const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!["application/javascript", "text/javascript", "application/x-javascript", "text/ecmascript", "application/ecmascript"].includes(mime)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${name} asset has a non-JavaScript content type`);
    }
    const reader = response.body?.getReader();
    let bytes = 0, prefix = "";
    try {
      if (reader) while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error("asset too large");
        if (prefix.length < 512) prefix += new TextDecoder().decode(chunk.value).slice(0, 512 - prefix.length);
      }
    } catch { throw new Error(`${name} asset body failed or exceeded the size limit`); }
    finally { await reader?.cancel().catch(() => undefined); }
    if (!bytes || /^\s*<(?:!doctype\s+html|html|body|head)\b/i.test(prefix)) throw new Error(`${name} asset is empty or HTML`);
    scripts.push({ name, requestedVersion: route.match(/@([^/]+)\/dist\//)?.[1], servedVersion: url.pathname.match(/@([^/]+)\/dist\//)?.[1], status: 200, bytes, redirects });
  }
  return { status: "assets_reachable", browserExecution: "not_verified", scripts };
}

async function main() {
  const assets = process.argv.includes("--probe-assets");
  const probe = assets || process.argv.includes("--probe-origin");
  const result = checkClerkConfig(process.env);
  for (const warning of result.warnings) console.warn(`[clerk-check] WARN ${warning}`);
  for (const error of result.errors) console.error(`[clerk-check] FAIL ${error}`);
  if (!result.ok) process.exitCode = 1;
  if (!result.ok || !probe) {
    if (result.ok) console.log(`[clerk-check] PASS static configuration (${result.facts.keyTier} keys)`);
    return;
  }
  try {
    const publicConfig = await probeClerkOrigin(result.facts.publicOrigin, process.env.CLERK_PUBLISHABLE_KEY);
    console.log("[clerk-check] PASS public /api/auth/config reaches PiGO directly");
    if (assets) {
      const runtime = await probeClerkAssets(result.facts.publicOrigin, process.env.CLERK_PUBLISHABLE_KEY, publicConfig.proxyUrl);
      for (const script of runtime.scripts) console.log(`[clerk-check] PASS ${script.name} asset reachable (${script.bytes} bytes, ${script.redirects} redirects)`);
      console.log("[clerk-check] NOT VERIFIED: browser script execution, rendered forms and sign-in session; require a real browser check");
    }
  } catch (error) {
    console.error(`[clerk-check] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
