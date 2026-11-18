import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OCI_COMPONENTS, parseArgs } from "./oci-manifest.mjs";

export const BACKPORT_POLICY = JSON.parse(await readFile(new URL("./openssl-backport-policy.json", import.meta.url), "utf8"));
export const digest = data => createHash("sha256").update(data).digest("hex");

export function verifyLibraryHashes(files, expected) {
  for (const [file, hash] of Object.entries(expected)) {
    assert.ok(Buffer.isBuffer(files[file]), "A verified library is missing");
    assert.equal(digest(files[file]), hash, "Installed library differs from the vendor backport");
  }
}

export function validateVendorFeed(feed) {
  assert.equal(feed.distroversion, "edge");
  assert.equal(feed.reponame, "main");
  assert.equal(feed.urlprefix, "https://dl-cdn.alpinelinux.org/alpine");
  const origins = feed.packages.filter(p => p.pkg?.name === "openssl");
  assert.equal(origins.length, 1);
  const fixed = origins[0].pkg.secfixes[BACKPORT_POLICY.fixedVersion];
  assert.ok(Array.isArray(fixed));
  for (const cve of BACKPORT_POLICY.cves) assert.ok(fixed.includes(cve), "Vendor fix evidence is incomplete");
}

export async function fetchVendorFeed(fetchImpl = fetch) {
  const response = await fetchImpl(BACKPORT_POLICY.vendorFeed, {
    redirect: "error", signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" },
  });
  assert.equal(response.status, 200, "Vendor fix evidence is unavailable");
  assert.ok(response.body, "Vendor fix evidence is empty");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= 4 * 1024 * 1024, "Vendor fix evidence is oversized");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const feed = JSON.parse(text);
  validateVendorFeed(feed);
  return { text, feed };
}

export function verifyInstalledBackport({ architecture, imageId, release, installed, files }, feed) {
  validateVendorFeed(feed);
  assert.equal(architecture, "amd64");
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
  const version = release.trim();
  assert.match(version, /^3\.24\.\d+$/u);
  const records = installed.split(/\n\s*\n/u).map(block => Object.fromEntries(
    block.split("\n").filter(line => /^[A-Za-z]:/u.test(line)).map(line => [line[0], line.slice(2)]),
  ));
  const products = [];
  for (const [name, policy] of Object.entries(BACKPORT_POLICY.packages)) {
    const packages = records.filter(r => r.P === name);
    assert.equal(packages.length, 1, "An exact installed package is required");
    const pkg = packages[0];
    assert.equal(pkg.V, policy.version);
    assert.equal(pkg.A, policy.architecture);
    assert.equal(pkg.o, policy.origin);
    assert.equal(pkg.C, policy.apkChecksum);
    verifyLibraryHashes(files, policy.files);
    products.push({ "@id": `pkg:apk/alpine/${name}@${pkg.V}?arch=${pkg.A}&distro=alpine-${version}&upstream=openssl` });
  }
  return { imageId, products };
}

export function createBackportVex(verified, feedText, now = new Date()) {
  validateVendorFeed(JSON.parse(feedText));
  assert.match(verified.imageId, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(verified.products.length, 2);
  for (const name of Object.keys(BACKPORT_POLICY.packages)) {
    const prefix = `pkg:apk/alpine/${name}@${BACKPORT_POLICY.fixedVersion}?arch=x86_64&distro=alpine-`;
    const product = verified.products.find(p => p["@id"].startsWith(prefix));
    assert.ok(product, "An exact package product is required");
    assert.match(product["@id"].slice(prefix.length), /^3\.24\.\d+&upstream=openssl$/u);
  }
  const timestamp = now.toISOString();
  return {
    "@context": "https://openvex.dev/ns/v0.2.0",
    "@id": `urn:sha256:${digest(JSON.stringify({ verified, vendorFeedSha256: digest(feedText) }))}`,
    author: "PiGO release tooling", role: "Document Creator", timestamp, version: 1,
    statements: BACKPORT_POLICY.cves.map(cve => ({
      vulnerability: { "@id": `https://nvd.nist.gov/vuln/detail/${cve}`, name: cve },
      products: verified.products,
      status: "fixed",
      status_notes: `Alpine ${BACKPORT_POLICY.fixedVersion} security backport. Installed package records and all pinned library bytes verified against official APKs. Vendor evidence: ${BACKPORT_POLICY.vendorFeed}; image configuration: ${verified.imageId}.`,
      timestamp,
    })),
  };
}

export async function inspectBackport(image, feed, execute = (args) => execFileSync("docker", args, {
  encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
})) {
  assert.match(image, /^[a-z0-9][a-z0-9./:_@-]*$/u);
  const [metadata] = JSON.parse(execute(["image", "inspect", image]));
  assert.match(metadata.Id, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(metadata.Architecture, "amd64");
  const directory = await mkdtemp(path.join(os.tmpdir(), "pigo-backport-"));
  let container;
  try {
    container = execute(["create", "--name", `pigo-backport-${randomUUID()}`, "--label", "io.pigo.backport-check=true",
      "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", metadata.Id]).trim();
    assert.match(container, /^[a-f0-9]{64}$/u);
    const copy = async (source, target) => {
      execute(["cp", `${container}:${source}`, path.join(directory, target)]);
      return readFile(path.join(directory, target));
    };
    const release = (await copy("/etc/alpine-release", "release")).toString("utf8");
    const installed = (await copy("/lib/apk/db/installed", "installed")).toString("utf8");
    const files = {};
    for (const policy of Object.values(BACKPORT_POLICY.packages)) {
      for (const file of Object.keys(policy.files)) files[file] = await copy(file, digest(file));
    }
    return verifyInstalledBackport({ architecture: metadata.Architecture, imageId: metadata.Id, release, installed, files }, feed);
  } finally {
    try { if (container) execute(["rm", "-f", container]); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assert.ok(Boolean(options.images) !== Boolean(options.manifest), "Provide images or an immutable manifest");
  const images = options.images ? JSON.parse(options.images) : JSON.parse(await readFile(options.manifest, "utf8")).images;
  assert.deepEqual(Object.keys(images).sort(), [...OCI_COMPONENTS].sort());
  const output = path.resolve(options["output-dir"]);
  await mkdir(output, { recursive: true });
  const { text, feed } = await fetchVendorFeed();
  await writeFile(path.join(output, "vendor-secdb.json"), text, { flag: "wx" });
  const evidence = {};
  for (const component of OCI_COMPONENTS) {
    const reference = typeof images[component] === "string" ? images[component] : images[component].reference;
    assert.match(reference, /^[a-z0-9][a-z0-9./:_@-]*$/u);
    if (options.manifest) {
      assert.match(reference, /@sha256:[a-f0-9]{64}$/u);
      execFileSync("docker", ["pull", reference], { timeout: 120_000, stdio: "inherit" });
    }
    const verified = await inspectBackport(reference, feed);
    const vex = JSON.stringify(createBackportVex(verified, text), null, 2) + "\n";
    await writeFile(path.join(output, `${component}.vex.json`), vex, { flag: "wx" });
    evidence[component] = { reference, ...verified, vexSha256: digest(vex), vendorFeedSha256: digest(text), packages: BACKPORT_POLICY.packages };
  }
  await writeFile(path.join(output, "verification.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  console.log("[openssl-backport] Verified vendor fixes, exact package records and library bytes for five images");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
