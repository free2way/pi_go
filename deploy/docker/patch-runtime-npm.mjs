import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// node-gyp only uses these globs to discover Windows build files. Use npm's
// existing glob implementation and remove the affected tinyglobby dependency.
// Keep the upstream package versions intact; reject an unexpected package shape.
export async function patchRuntimeNpm(root) {
  const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative, "package.json"), "utf8"));
  assert.equal((await readJson(".")).version, "12.2.3");
  const nodeGyp = await readJson("node_modules/node-gyp");
  assert.equal(nodeGyp.version, "13.0.0");
  assert.equal((await readJson("node_modules/glob")).version, "13.0.6");
  assert.equal((await readJson("node_modules/tinyglobby")).version, "0.2.17");
  assert.equal((await readJson("node_modules/tinyglobby/node_modules/picomatch")).version, "4.0.5");
  assert.equal(nodeGyp.dependencies.tinyglobby, "^0.2.12");

  const buildFile = path.join(root, "node_modules/node-gyp/lib/build.js");
  const original = await readFile(buildFile, "utf8");
  assert.equal(original.split("require('tinyglobby')").length - 1, 1);
  assert.equal(original.split("{ expandDirectories: false }").length - 1, 2);
  const patched = original.replace("require('tinyglobby')", "require('glob')")
    .replaceAll("{ expandDirectories: false }", "{ nodir: true }");
  assert.ok(!patched.includes("tinyglobby"));

  delete nodeGyp.dependencies.tinyglobby;
  nodeGyp.dependencies.glob = "13.0.6";
  await writeFile(buildFile, patched);
  await writeFile(path.join(root, "node_modules/node-gyp/package.json"), `${JSON.stringify(nodeGyp, null, 2)}\n`);
  await rm(path.join(root, "node_modules/tinyglobby"), { recursive: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], "An installed npm directory is required");
  await patchRuntimeNpm(path.resolve(process.argv[2]));
}
