import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, copyFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeClerkAssets } from "./clerk-config-check.mjs";

const sdk = createRequire(import.meta.resolve("@clerk/react"))("@clerk/shared/loadClerkJsScript");
const origin = "https://pigo.example.com", publishableKey = ["pk", "live", "DUMMY_fixture"].join("_");
const js = (text = "/* fixture */ void 0;", mime = "application/javascript; charset=utf-8") => new Response(text, { headers: { "content-type": mime } });

test("asset probes use the installed React SDK's exact JS and UI selection, never latest", async () => {
  const calls = [];
  const result = await probeClerkAssets(origin, publishableKey, "/__clerk", async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.deepEqual(options.headers, { accept: "application/javascript" });
    assert(options.signal instanceof AbortSignal);
    return js();
  });
  const options = { publishableKey, proxyUrl: "/__clerk" };
  assert.deepEqual(calls, [sdk.clerkJSScriptUrl(options), sdk.clerkUIScriptUrl(options)].map(route => origin + route));
  assert(calls.every(url => !url.includes("@latest") && !url.includes(publishableKey)));
  assert.equal(result.status, "assets_reachable");
  assert.equal(result.browserExecution, "not_verified");
  assert.equal(result.scripts.length, 2);
  assert(result.scripts.every(row => row.status === 200 && row.bytes > 0));
  assert(!JSON.stringify(result).includes(publishableKey));
});

test("same-origin version and relative redirects share one bounded signal per asset", async () => {
  const calls = [], signals = [];
  const result = await probeClerkAssets(origin, publishableKey, "/__clerk/", async (url, options) => {
    calls.push(url); signals.push(options.signal);
    if (calls.length === 1) return new Response(null, { status: 307, headers: { location: "/__clerk/npm/@clerk/clerk-js@6.0.0/dist/clerk.browser.js" } });
    if (calls.length === 2) return new Response(null, { status: 302, headers: { location: "./stable.js" } });
    return js();
  });
  assert.equal(calls[2], origin + "/__clerk/npm/@clerk/clerk-js@6.0.0/dist/stable.js");
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[1], signals[2]);
  assert.notEqual(signals[2], signals[3]);
  assert.equal(result.scripts[0].redirects, 2);
});

const credentialed = new URL("/__clerk/npm/@clerk/x", origin);
credentialed.username = "x";
credentialed.password = ["DUMMY", "password"].join("_");
for (const [index, location] of [null, "https://other.example.com/asset.js", "http://pigo.example.com/asset.js",
  "//pigo.example.com/__clerk/npm/@clerk/asset.js", "/api/health", "/__clerk/npm/@clerk/x?token=DUMMY_query", credentialed.href].entries()) {
  test(`unsafe redirect case ${index} never causes a second request`, async () => {
    let calls = 0;
    await assert.rejects(() => probeClerkAssets(origin, publishableKey, "/__clerk", async () => {
      calls++;
      return new Response(null, { status: 307, headers: location === null ? {} : { location } });
    }), /unsafe/);
    assert.equal(calls, 1);
  });
}

test("redirect loops are bounded at four redirects", async () => {
  let calls = 0;
  await assert.rejects(() => probeClerkAssets(origin, publishableKey, "/__clerk", async (url) => {
    calls++;
    return new Response(null, { status: 307, headers: { location: url } });
  }), /redirect limit/);
  assert.equal(calls, 5);
});

for (const status of [401, 403, 404, 500, 503]) {
  test(`asset HTTP ${status} fails without reading error text`, async () => {
    let reads = 0;
    const response = new Response("DUMMY_diagnostic", { status });
    response.text = async () => { reads++; return "DUMMY_diagnostic"; };
    await assert.rejects(() => probeClerkAssets(origin, publishableKey, "/__clerk", async () => response), new RegExp(`HTTP ${status}`));
    assert.equal(reads, 0);
  });
}

for (const mime of ["text/html", "application/json", "text/plain", ""]) {
  test(`asset MIME ${mime} cannot masquerade as executable JS`, async () => {
    await assert.rejects(() => probeClerkAssets(origin, publishableKey, "/__clerk", async () => js("fixture", mime)), /non-JavaScript/);
  });
}

for (const body of ["", "<!doctype html><html>Login</html>", "\uFEFF <html>Login</html>"]) {
  test("empty or HTML bodies fail even under a JavaScript MIME", async () => {
    await assert.rejects(() => probeClerkAssets(origin, publishableKey, "/__clerk", async () => js(body)), /empty or HTML/);
  });
}

test("body byte limit cancels the response rather than retaining an unbounded artifact", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/javascript" } });
  await assert.rejects(() => probeClerkAssets(origin, publishableKey, "/__clerk", async () => response), /size limit/);
  assert.equal(cancelled, true);
});

test("stream and network exceptions never echo untrusted diagnostic text", async () => {
  const canary = "DUMMY_private-network-detail";
  for (const fetchImpl of [async () => { throw new Error(canary); }, async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(canary)); },
  }), { headers: { "content-type": "application/javascript" } })]) {
    await assert.rejects(() => probeClerkAssets(origin, publishableKey, "/__clerk", fetchImpl), error => !error.message.includes(canary));
  }
});

test("unsafe configuration is refused before I/O and HTTPS is mandatory outside loopback", async () => {
  let calls = 0;
  for (const [base, proxy] of [[origin, "https://other.example.com/__clerk"], [origin, "/"], ["http://pigo.example.com", "/__clerk"]]) {
    await assert.rejects(() => probeClerkAssets(base, publishableKey, proxy, async () => { calls++; return js(); }));
  }
  assert.equal(calls, 0);
});

for (const invalidAsset of [false, true]) {
  test(`real CLI reports asset reachability without claiming browser/session success (invalid=${invalidAsset})`, async () => {
    const publicKey = ["pk", "test", "DUMMY_".repeat(5)].join("_");
    const secretKey = ["sk", "test", "DUMMY_".repeat(5)].join("_");
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({ route: request.url, method: request.method, authorization: request.headers.authorization });
      if (request.url === "/api/auth/config") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ mode: "clerk", clerk: { publishableKey: publicKey, proxyUrl: "/__clerk" } }));
      } else {
        response.setHeader("content-type", invalidAsset ? "text/html" : "application/javascript");
        response.end(invalidAsset ? "<!doctype html><html>Fixture login</html>" : "/* fixture only */ void 0;");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert(address && typeof address !== "string");
      const child = spawn(process.execPath, [new URL("./clerk-config-check.mjs", import.meta.url).pathname, "--probe-assets"], {
        env: { PATH: process.env.PATH, NODE_ENV: "test", PI_AUTH_MODE: "clerk", PI_PUBLIC_ORIGIN: `http://127.0.0.1:${address.port}`,
          CLERK_PUBLISHABLE_KEY: publicKey, CLERK_SECRET_KEY: secretKey },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      const [code] = await once(child, "close");
      assert.equal(code, invalidAsset ? 1 : 0);
      assert(![publicKey, secretKey].some(value => (stdout + stderr).includes(value)));
      assert(requests.every(request => request.method === "GET" && request.authorization === undefined));
      if (invalidAsset) assert.match(stderr, /non-JavaScript/);
      else {
        assert.equal(requests.length, 3);
        assert.match(stdout, /Clerk JS asset reachable/);
        assert.match(stdout, /Clerk UI asset reachable/);
        assert.match(stdout, /NOT VERIFIED: browser script execution, rendered forms and sign-in session/);
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}

test("standalone static checks do not require an installed React SDK", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pigo-clerk-static-"));
  try {
    const target = path.join(directory, "check.mjs");
    await copyFile(new URL("./clerk-config-check.mjs", import.meta.url), target);
    // Node resolves the module URL through macOS temp-directory aliases; use
    // its canonical entry path so this fixture actually runs the CLI guard.
    const child = spawn(process.execPath, [await realpath(target)], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", PI_AUTH_MODE: "clerk", PI_PUBLIC_ORIGIN: "https://pigo.example.com",
        CLERK_PUBLISHABLE_KEY: ["pk", "test", "DUMMY_".repeat(5)].join("_"), CLERK_SECRET_KEY: ["sk", "test", "DUMMY_".repeat(5)].join("_") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.resume();
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    assert.match(stdout, /PASS static configuration/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
