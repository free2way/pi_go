import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("executor source remains readable by its non-root runtime user with restrictive host permissions", () => {
  const dockerfile = readFileSync(new URL("../deploy/executor/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^COPY --chown=node:node --chmod=0644 server\.mjs \.\/server\.mjs$/mu);
  assert.match(dockerfile, /^USER node$/mu);
});
