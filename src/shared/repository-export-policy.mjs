// Shared by the workspace push boundary and the repository/CI scanner.
import { createHash } from "node:crypto";
export class ExportPolicyError extends Error {
  code = "SCM_EXPORT_POLICY_FAILED";
}

export function pathPolicy(name) {
  const value = name.replaceAll("\\", "/").toLowerCase();
  if (/(^|\/)(docs|documentation)(\/|$)/u.test(value)
    || /(?:acceptance|development|architecture|system-design|验收|开发|架构).*\.(?:md|mdx|pdf|docx|pptx)$/u.test(value)) return "documentation";
  if (/(^|[._/-])(prompts?|agent-instructions?|agents|claude|提示词)([._/-]|$)/u.test(value)) return "ai_prompt";
  if (/(^|\/)(\.env(?!\.example$)|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets?)(\.|\/|$)/u.test(value)
    || /\.(pem|key|p12|pfx|jks|keystore)$/u.test(value)) return "credential_file";
  if (/(^|\/)(accounts?|users?|credentials).*(export|backup|dump|\.csv|\.sql)/u.test(value)) return "account_export";
  return undefined;
}

const rules = [
  ["secret", /BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}/u],
  ["internal_network", /(?:^|[^\d])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?:[^\d]|$)|\b(?:fc|fd)[\da-f]{2}:[\da-f:]+|\bfe[89ab][\da-f]:[\da-f:]+/iu],
  ["embedded_credentials", /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/iu],
  ["ai_prompt", new RegExp(["You" + " are", "Act" + " as", "system" + " prompt", "developer" + " prompt", "reviewer" + " prompt", "prompt" + " template", "system" + "Prompt", "developer" + "Prompt", "reviewer" + "Prompt", "prompt" + "Template", "系统" + "提示词", "开发者" + "提示词", "审查" + "提示词", "你" + "是", "你将" + "作为"].join("|"), "iu")],
  ["account_data", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:ssh|deploy|git|db|database)[_-]?(?:user|username)[^\s]{0,80}(?::-|[:=])[^\s]*[A-Za-z0-9][A-Za-z0-9._@+-]{3,}/iu],
  ["secret", /(?:password|passwd|access[_-]?token|api[_-]?key|secret)["']?\s*[:=]\s*["'][A-Za-z0-9][A-Za-z0-9@._+:/!-]{7,}["']/iu],
];

function credentialVariants(credentials) {
  return [...new Set(credentials.filter((value) => typeof value === "string" && value.length > 0)
    .flatMap((value) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]))];
}

export function contentPolicy(text, credentials = []) {
  const categories = rules.filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
  // Saved SCM credentials may be opaque values with no recognizable prefix or
  // field name. Compare only explicit context, never return a matched value.
  if (credentialVariants(credentials).some((variant) => text.includes(variant))) {
    categories.push("secret");
  }
  if (/(?:username|user[_-]?name|account[_-]?id|email)["']?\s*[:=]\s*["'][A-Za-z0-9][A-Za-z0-9@._+-]{2,}["']/iu.test(text)) categories.push("account_data");
  if (/(?:^|\n)\s*[A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|API_KEY|SECRET)\s*[:=]\s*[A-Za-z0-9][A-Za-z0-9._+:/!-]{7,}/u.test(text)) categories.push("secret");
  return [...new Set(categories)];
}

const SHA = /^[a-f0-9]{40,64}$/u;
const MAX_COMMITS = 500;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** Scan every path/blob introduced by the outgoing commit range, including
 * deleted/reverted files and merged side branches. Unchanged baseline files are
 * deliberately excluded, while copied baseline blobs are rescanned under their
 * new paths. Never return source text. Incomplete history, binary/unreadable
 * content and limits fail closed.
 */
export async function inspectExportHistory({ git, head, base, credentials = [] }) {
  if (!SHA.test(head) || (base && !SHA.test(base))) throw new ExportPolicyError("Invalid export revision");
  const checked = async (args) => {
    const result = await git(["--no-replace-objects", ...args]);
    if (result.code !== 0) throw new ExportPolicyError("Repository export scan could not read Git objects");
    return result.stdout;
  };
  if ((await checked(["rev-parse", "--is-shallow-repository"])).trim() !== "false") {
    throw new ExportPolicyError("Complete repository history is required before export");
  }
  const range = [head, ...(base ? [`^${base}`] : [])];
  const count = Number((await checked(["rev-list", "--count", ...range])).trim());
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_COMMITS) throw new ExportPolicyError("Export commit scan limit exceeded");
  const commits = (await checked(["rev-list", `--max-count=${MAX_COMMITS + 1}`, ...range])).trim().split(/\s+/u).filter(Boolean);
  if (commits.length !== count || commits.some((sha) => !SHA.test(sha))) throw new ExportPolicyError("Incomplete export commit list");
  const findings = new Map();
  const blobs = new Map();
  let bytes = 0;
  const known = credentialVariants(credentials);
  const add = (category, name) => {
    // Filenames are also diagnostics; remove full values before limiting text.
    let safeName = name;
    for (const value of known.toSorted((a, b) => b.length - a.length)) safeName = safeName.replaceAll(value, "[redacted]");
    const path = safeName.replace(/[\u0000-\u001f\u007f]/gu, "?").slice(0, 180);
    findings.set(`${category}:${path}`, { category, path });
  };
  const treeEntry = async (commit, name) => {
    const tree = await checked(["ls-tree", "-z", "--long", commit, "--", name]);
    if (!tree) return undefined;
    if (!tree.endsWith("\0") || tree.split("\0").filter(Boolean).length !== 1) {
      throw new ExportPolicyError("Incomplete export tree entry");
    }
    const entry = tree.slice(0, -1);
    const match = /^(\d+) (blob|commit) ([a-f0-9]{40,64})\s+(\d+|-)\t([\s\S]+)$/u.exec(entry);
    if (!match) throw new ExportPolicyError("Invalid export tree entry");
    const [, mode, type, oid, sizeValue, treeName] = match;
    if (treeName !== name) throw new ExportPolicyError("Export tree path mismatch");
    return { mode, type, oid, sizeValue };
  };
  const blobText = async ({ oid, sizeValue }) => {
    if (blobs.has(oid)) return blobs.get(oid);
    const size = Number(sizeValue);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB_BYTES) {
      throw new ExportPolicyError("Export file scan limit exceeded");
    }
    bytes += size;
    if (bytes > MAX_TOTAL_BYTES) throw new ExportPolicyError("Export total scan limit exceeded");
    const text = await checked(["cat-file", "blob", oid]);
    if (Buffer.byteLength(text, "utf8") !== size) throw new ExportPolicyError("Incomplete or non-UTF8 export content");
    const actualOid = createHash(oid.length === 64 ? "sha256" : "sha1").update(`blob ${size}\0`).update(text, "utf8").digest("hex");
    if (actualOid !== oid) throw new ExportPolicyError("Export blob integrity check failed");
    const value = { text, binary: text.includes("\0") };
    blobs.set(oid, value);
    return value;
  };
  for (const commit of commits) {
    const ancestry = (await checked(["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/u);
    if (ancestry[0] !== commit || ancestry.slice(1).some((sha) => !SHA.test(sha))) {
      throw new ExportPolicyError("Invalid export commit ancestry");
    }
    const parents = ancestry.slice(1);
    const changed = await checked(["diff-tree", "--root", "-m", "--no-commit-id", "-r", "-z", "--diff-filter=ACMR", "--name-only", commit]);
    if (changed && !changed.endsWith("\0")) throw new ExportPolicyError("Incomplete export path list");
    for (const name of [...new Set(changed.split("\0").filter(Boolean))]) {
      const current = await treeEntry(commit, name);
      if (!current) throw new ExportPolicyError("Incomplete export tree entry");
      if (known.some((value) => name.includes(value))) add("secret", name);
      const category = pathPolicy(name);
      if (category) add(category, name);
      // Gitlinks and symlinks need explicit external review; never skip them silently.
      if (current.type !== "blob" || current.mode === "120000") { add("unscannable", name); continue; }
      const value = await blobText(current);
      if (value.binary) { add("unscannable", name); continue; }

      // Scan only content introduced at this path by the outgoing commit. This
      // prevents a legacy baseline value in an otherwise edited file from
      // permanently blocking all future exports, while new/copied paths and
      // intermediate commits are still inspected in full.
      const previousLines = new Set();
      for (const parent of parents) {
        const previous = await treeEntry(parent, name);
        if (!previous || previous.type !== "blob" || previous.mode === "120000") continue;
        const parentValue = await blobText(previous);
        if (parentValue.binary) continue;
        for (const line of parentValue.text.split(/\r?\n/u)) previousLines.add(line);
      }
      const introduced = value.text.split(/\r?\n/u).filter((line) => !previousLines.has(line)).join("\n");
      for (const rule of contentPolicy(introduced, credentials)) add(rule, name);
    }
  }
  return [...findings.values()];
}
