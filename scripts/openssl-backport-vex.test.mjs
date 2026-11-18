import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { BACKPORT_POLICY as policy, createBackportVex, digest, fetchVendorFeed, inspectBackport, validateVendorFeed, verifyInstalledBackport, verifyLibraryHashes } from "./openssl-backport-vex.mjs";

const imageId = `sha256:${"1".repeat(64)}`;
const vendor = () => ({ distroversion: "edge", reponame: "main", urlprefix: "https://dl-cdn.alpinelinux.org/alpine",
  packages: [{ pkg: { name: "openssl", secfixes: { [policy.fixedVersion]: [...policy.cves] } } }] });
const installed = () => Object.entries(policy.packages).map(([name, p]) => `P:${name}\nV:${p.version}\nA:${p.architecture}\no:${p.origin}\nC:${p.apkChecksum}\n`).join("\n");
const snapshot = () => ({ architecture: "amd64", imageId, release: "3.24.4\n", installed: installed(), files: {} });
const verified = () => ({ imageId, products: Object.keys(policy.packages).map(name => ({ "@id": `pkg:apk/alpine/${name}@${policy.fixedVersion}?arch=x86_64&distro=alpine-3.24.4&upstream=openssl` })) });

test("VEX contains only the four vendor-fixed CVEs and exact package products", () => {
  const vex = createBackportVex(verified(), JSON.stringify(vendor()), new Date("2026-11-18T00:00:00Z"));
  assert.deepEqual(vex.statements.map(s => s.vulnerability.name).sort(), [...policy.cves].sort());
  for (const statement of vex.statements) {
    assert.equal(statement.status, "fixed");
    assert.deepEqual(statement.products, verified().products);
    assert.ok(!("justification" in statement));
  }
  assert.equal(vex.timestamp, "2026-11-18T00:00:00.000Z");
  assert.match(vex["@id"], /^urn:sha256:[a-f0-9]{64}$/u);
  assert.match(vex.statements[0].status_notes, new RegExp(imageId, "u"));
});

for (const [label, mutate] of [
  ["old package", s => { s.installed = s.installed.replaceAll("3.5.9-r1", "3.5.9-r0"); }],
  ["unsupported architecture", s => { s.architecture = "arm64"; }],
  ["different distribution", s => { s.release = "3.23.4"; }],
  ["forged package origin", s => { s.installed = s.installed.replaceAll("o:openssl", "o:other"); }],
  ["different official package checksum", s => { s.installed = s.installed.replaceAll("C:Q1", "C:Q2"); }],
  ["duplicate installed records", s => { s.installed += "\n" + installed(); }],
  ["missing binary", () => {}],
  ["forged version with altered library bytes", s => { for (const p of Object.values(policy.packages)) for (const file of Object.keys(p.files)) s.files[file] = Buffer.from("altered"); }],
]) test(`does not certify ${label}`, () => {
  const s = snapshot(); mutate(s);
  assert.throws(() => verifyInstalledBackport(s, vendor()));
});

test("library checking compares content rather than trusting installed version metadata", () => {
  const file = "/usr/lib/fixture.so", data = Buffer.from("verified-library");
  verifyLibraryHashes({ [file]: data }, { [file]: digest(data) });
  assert.throws(() => verifyLibraryHashes({ [file]: Buffer.from("other-library") }, { [file]: digest(data) }));
  assert.throws(() => verifyLibraryHashes({}, { [file]: digest(data) }));
});

for (const [label, mutate] of [
  ["missing fix", f => { f.packages[0].pkg.secfixes[policy.fixedVersion].pop(); }],
  ["wrong repository", f => { f.reponame = "community"; }],
  ["wrong release", f => { f.distroversion = "v3.24"; }],
  ["wrong source", f => { f.urlprefix = "https://example.invalid"; }],
  ["duplicate origin", f => { f.packages.push(f.packages[0]); }],
]) test(`vendor evidence rejects ${label}`, () => {
  const f = vendor(); mutate(f); assert.throws(() => validateVendorFeed(f));
});

test("vendor fetch uses only the fixed HTTPS source, refuses redirects and HTTP errors", async () => {
  const result = await fetchVendorFeed(async (url, options) => {
    assert.equal(url, "https://secdb.alpinelinux.org/edge/main.json");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return new Response(JSON.stringify(vendor()));
  });
  assert.deepEqual(result.feed, vendor());
  for (const status of [302, 404, 500]) await assert.rejects(fetchVendorFeed(async () => new Response("{}", { status })));
  await assert.rejects(fetchVendorFeed(async () => { throw new Error("offline"); }));
  await assert.rejects(fetchVendorFeed(async () => new Response("not-json")));
  await assert.rejects(fetchVendorFeed(async () => new Response("x".repeat(4 * 1024 * 1024 + 1))));
});

test("VEX refuses wildcard, missing, duplicate and old-version package products", () => {
  for (const change of [
    v => { v.products[0]["@id"] = "pkg:apk/alpine/libcrypto3"; },
    v => { v.products.pop(); },
    v => { v.products[1] = v.products[0]; },
    v => { v.products[0]["@id"] = v.products[0]["@id"].replace("3.5.9-r1", "3.5.9-r0"); },
  ]) { const v = verified(); change(v); assert.throws(() => createBackportVex(v, JSON.stringify(vendor()))); }
});

test("failed inspection removes its stopped container and private scratch directory", async () => {
  const calls = []; let scratch;
  await assert.rejects(inspectBackport("local/fixture:ci", vendor(), args => {
    calls.push(args);
    if (args[0] === "image") return JSON.stringify([{ Id: imageId, Architecture: "amd64" }]);
    if (args[0] === "create") {
      assert.ok(args.includes("--read-only") && args.includes("none") && args.includes("ALL"));
      assert.ok(!args.includes("start"));
      return "2".repeat(64);
    }
    if (args[0] === "cp") { scratch = args[2].slice(0, args[2].lastIndexOf("/")); throw new Error("copy failed"); }
    return "";
  }));
  assert.ok(calls.some(args => args[0] === "rm" && args[2] === "2".repeat(64)));
  assert.ok(!calls.some(args => args[0] === "start" || args[0] === "run"));
  await assert.rejects(access(scratch), { code: "ENOENT" });
});
