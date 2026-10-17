import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("publishing immutable images requires all same-commit quality jobs", () => {
  const workflow = readFileSync(new URL("../.github/workflows/oci-supply-chain.yml", import.meta.url), "utf8");
  const gate = readFileSync(new URL("../.github/workflows/pr-gate.yml", import.meta.url), "utf8");
  assert.match(workflow, /quality-gates:[\s\S]*?uses: \.\/\.github\/workflows\/pr-gate.yml/u);
  assert.match(workflow, /publish-images:[\s\S]*?needs: \[validate-images, quality-gates\]/u);
  assert.doesNotMatch(workflow.slice(workflow.indexOf("  publish-images:"), workflow.indexOf("    steps:", workflow.indexOf("  publish-images:"))), /always\(\)|continue-on-error/u);
  assert.match(gate, /workflow_call:/u);
  for (const name of ["quality", "postgres-concurrency", "browser-smoke"]) assert.match(gate, new RegExp(`  ${name}:`));
  assert.match(gate, /fetch-depth: 0/u);
  assert.equal((workflow.match(/severity-cutoff: high/gu) ?? []).length, 10);
  assert.equal((workflow.match(/only-fixed: false/gu) ?? []).length, 10);
  assert.match(workflow, /name: Enforce candidate vulnerability gate/u);
  assert.match(workflow, /name: Enforce vulnerability gate/u);
  assert.doesNotMatch(workflow, /severity-cutoff: critical|only-fixed: true/u);
});
