/** Worker-owned launcher/extension, emitted into each private invocation directory. */
export const PI_ADMISSION_RUNTIME = String.raw`
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const file = fileURLToPath(import.meta.url);
const directory = path.dirname(file);
const protocol = 1;
function write(name, value) {
  const target = path.join(directory, name), temporary = target + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value), { flag: "w", mode: 0o600 });
  fs.renameSync(temporary, target);
}
function amount(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
export default function registerAdmission(pi) {
  try {
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
    let sequence = 0;
    pi.on("message_end", (event) => {
      if (event.message?.role !== "assistant") return;
      const raw = event.message.usage;
      if (!raw) return;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) totals[key] += amount(raw[key]);
      totals.cost += amount(raw.cost?.total);
    });
    pi.on("before_provider_request", async (_event, context) => {
      const current = ++sequence;
      try {
        write("request.json", { protocol, sequence: current, usage: totals });
        const responseFile = path.join(directory, "reply-" + current + ".json");
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (fs.existsSync(responseFile)) {
            const response = JSON.parse(fs.readFileSync(responseFile, "utf8"));
            fs.unlinkSync(responseFile);
            if (response.protocol !== protocol || response.sequence !== current || response.allow !== true) throw new Error("denied");
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error("timeout");
      } catch {
        // Pi reports handler exceptions and can continue. Abort the operation
        // explicitly before returning control to its provider transport.
        context.abort();
        throw new Error("PI_ADMISSION_SCHEMA_DENIED");
      }
    });
    write("ready.json", { protocol });
  } catch {
    // Registration failures must never fall through to an unguarded CLI call.
    process.exit(78);
  }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(file)) {
  try {
    const configuration = JSON.parse(fs.readFileSync(path.join(directory, "configuration.json"), "utf8"));
    if (configuration.protocol !== protocol || !fs.lstatSync(file).isFile()) throw new Error("invalid");
    // The same mandatory file is both launcher and explicit system extension.
    // Missing/corrupt source prevents Node from starting Pi at all.
    const child = spawn("pi", ["--extension", file, ...process.argv.slice(2)], { stdio: ["ignore", "inherit", "inherit"] });
    let timer;
    const stop = () => {
      child.kill("SIGTERM");
      timer = setTimeout(() => child.kill("SIGKILL"), 750);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    child.once("error", () => process.exit(78));
    child.once("exit", (code) => { clearTimeout(timer); process.exit(code ?? 130); });
  } catch { process.exit(78); }
}
`;
