import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { patchRuntimeNpm } from "../deploy/docker/patch-runtime-npm.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pigo-runtime-npm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packages = {
    ".": { name: "npm", version: "12.2.3" },
    "node_modules/node-gyp": { name: "node-gyp", version: "13.0.0", dependencies: { tinyglobby: "^0.2.12", tar: "^7.5.4" } },
    "node_modules/glob": { name: "glob", version: "13.0.6" },
    "node_modules/tinyglobby": { name: "tinyglobby", version: "0.2.17" },
    "node_modules/tinyglobby/node_modules/picomatch": { name: "picomatch", version: "4.0.5" },
  };
  for (const [relative, pkg] of Object.entries(packages)) {
    await mkdir(path.join(root, relative), { recursive: true });
    await writeFile(path.join(root, relative, "package.json"), JSON.stringify(pkg));
  }
  const build = path.join(root, "node_modules/node-gyp/lib/build.js");
  await mkdir(path.dirname(build));
  const source = "const { glob } = require('tinyglobby');\nasync function solutions() { return glob('build/*.sln', { expandDirectories: false }); }\nasync function makefiles() { return glob('build/*.mk', { expandDirectories: false }); }\n";
  await writeFile(build, source);
  return { root, build, source };
}

test("replaces the glob caller and removes the full affected dependency tree without falsifying versions", async (t) => {
  const f = await fixture(t);
  await patchRuntimeNpm(f.root);
  const source = await readFile(f.build, "utf8");
  assert.match(source, /require\('glob'\)/u);
  assert.equal((source.match(/nodir: true/gu) ?? []).length, 2);
  assert.doesNotMatch(source, /tinyglobby|expandDirectories/u);
  const nodeGyp = JSON.parse(await readFile(path.join(f.root, "node_modules/node-gyp/package.json"), "utf8"));
  assert.equal(nodeGyp.version, "13.0.0");
  assert.deepEqual(nodeGyp.dependencies, { tar: "^7.5.4", glob: "13.0.6" });
  assert.equal(JSON.parse(await readFile(path.join(f.root, "package.json"), "utf8")).version, "12.2.3");
  await assert.rejects(readFile(path.join(f.root, "node_modules/tinyglobby/package.json")), { code: "ENOENT" });
});

test("unexpected package versions fail before changing source or deleting dependencies", async (t) => {
  const f = await fixture(t);
  const manifest = path.join(f.root, "node_modules/glob/package.json");
  await writeFile(manifest, '{"version":"99.0.0"}');
  await assert.rejects(patchRuntimeNpm(f.root));
  assert.equal(await readFile(f.build, "utf8"), f.source);
  assert.equal(JSON.parse(await readFile(path.join(f.root, "node_modules/tinyglobby/package.json"), "utf8")).version, "0.2.17");
});

test("unexpected node-gyp callers fail before changing source or deleting dependencies", async (t) => {
  const f = await fixture(t);
  const changed = f.source + "\nconst another = require('tinyglobby');\n";
  await writeFile(f.build, changed);
  await assert.rejects(patchRuntimeNpm(f.root));
  assert.equal(await readFile(f.build, "utf8"), changed);
  assert.ok(await readFile(path.join(f.root, "node_modules/tinyglobby/node_modules/picomatch/package.json")));
});
