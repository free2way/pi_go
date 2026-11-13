import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ROUTE_CONTRACT_SNAPSHOT, scanWorkspace } from "./server-route-contract.mjs";

test("server route contract matches the pre-P1 main snapshot", () => {
  const snapshot = JSON.parse(readFileSync(ROUTE_CONTRACT_SNAPSHOT, "utf8"));
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(scanWorkspace(), snapshot.routes);
});

test("route contract records method, URL, body limit and auth class", () => {
  const routes = scanWorkspace();
  assert.ok(routes.length >= 90, `expected at least 90 route declarations, found ${routes.length}`);
  for (const route of routes) {
    assert.match(route.method, /^(GET|POST|PUT|PATCH|DELETE)$/);
    assert.ok(route.url.startsWith("/api/") || route.url.endsWith("_PATH"));
    assert.ok(route.bodyLimit === null || route.bodyLimit.length > 0);
    assert.match(route.auth, /^(public|session|internal|release-callback|metrics-or-internal)$/);
  }
});
