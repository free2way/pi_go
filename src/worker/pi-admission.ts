import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PI_ADMISSION_RUNTIME } from "./pi-admission-runtime.js";
import { emptyUsage, type UsageTotals } from "./pi-events.js";

export class PiAdmissionProtocolError extends Error {
  constructor() { super("Pi request admission schema failed (PI_ADMISSION_INVALID)."); this.name = "PiAdmissionProtocolError"; }
}

async function readJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096) throw new PiAdmissionProtocolError();
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function usage(value: unknown): UsageTotals {
  if (!record(value)) throw new PiAdmissionProtocolError();
  const totals = emptyUsage();
  for (const key of Object.keys(totals) as Array<keyof UsageTotals>) {
    const n = value[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new PiAdmissionProtocolError();
    totals[key] = n;
  }
  return totals;
}

/** Shared Run budget decisions stay in the Worker; Pi only asks and waits. */
export async function createPiAdmission(input: {
  stateDirectory: string;
  /** Called for requests after the already-reserved first attempt. */
  reserveAdditional: (uncommittedUsage: UsageTotals) => void;
  validateFirst?: () => void;
  onFault: () => void;
}) {
  const parent = path.join(input.stateDirectory, "admission");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (!(await lstat(parent)).isDirectory() || (await lstat(parent)).isSymbolicLink()) throw new PiAdmissionProtocolError();
  const directory = await mkdtemp(path.join(parent, "call-"));
  const runtime = path.join(directory, "runtime.mjs");
  await writeFile(runtime, PI_ADMISSION_RUNTIME, { mode: 0o600, flag: "wx" });
  await writeFile(path.join(directory, "configuration.json"), '{"protocol":1}', { mode: 0o600, flag: "wx" });
  let admitted = 0, lastSequence = 0, closed = false;
  let denial: unknown;
  let ready = false;
  let active: Promise<void> | undefined;
  let termination: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    try {
      if (!ready) {
        const r = await readJson(path.join(directory, "ready.json"));
        if (!record(r) || r.protocol !== 1) throw new PiAdmissionProtocolError();
        ready = true;
      }
      const request = await readJson(path.join(directory, "request.json"));
      if (!record(request) || request.protocol !== 1 || !Number.isSafeInteger(request.sequence)) throw new PiAdmissionProtocolError();
      const sequence = request.sequence as number;
      if (sequence === lastSequence) return;
      if (sequence !== lastSequence + 1 || denial) throw new PiAdmissionProtocolError();
      const uncommittedUsage = usage(request.usage);
      let allow = false;
      try {
        if (admitted > 0) input.reserveAdditional(uncommittedUsage);
        else input.validateFirst?.();
        admitted += 1;
        allow = true;
      } catch (error) {
        denial = error;
        termination = setTimeout(input.onFault, 1000);
      }
      lastSequence = sequence;
      const file = path.join(directory, `reply-${sequence}.json`), temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify({ protocol: 1, sequence, allow }), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      denial ??= new PiAdmissionProtocolError();
      input.onFault();
    }
  }
  const timer = setInterval(() => {
    if (!closed && !active) active = poll().finally(() => { active = undefined; });
  }, 5);
  return {
    directory,
    runtime,
    get admitted() { return admitted; },
    get error() { return denial; },
    async finish() {
      closed = true;
      clearInterval(timer);
      await active;
      if (termination) clearTimeout(termination);
      if (!ready && !denial) denial = new PiAdmissionProtocolError();
      await rm(directory, { recursive: true, force: true });
      return { admitted, error: denial };
    },
  };
}
