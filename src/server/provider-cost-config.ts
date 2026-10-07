/**
 * Operator cost configuration on disk: the price table and the人工录入 credit book.
 *
 * 为什么是"文件 + 完整性状态"而不是"读失败就抛"：这两份配置决定界面上显示多少钱，
 * 但它们不是运行链路的一部分——文件缺失/损坏时应用必须照常起（只不过显示「未录入」
 * /「未知」），同时把 `integrity` 如实报给界面，让运维看得见问题而不是被静默的
 * "没有价格"糊弄。写路径（人工录入）走严格校验 + 原子替换。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EMPTY_MODEL_PRICE_TABLE, parseModelPriceTable, type ModelPriceTable } from "../shared/model-prices.js";
import { EMPTY_PROVIDER_CREDIT_BOOK, parseProviderCreditBook, type ProviderCreditBook } from "../shared/provider-credits.js";

export type ConfigIntegrity = "ok" | "missing" | "invalid";

export interface ConfigFileState<T> {
  value: T;
  integrity: ConfigIntegrity;
  /** 出问题时的可读原因（不包含文件内容）。 */
  detail?: string;
  file: string;
}

type Warn = (message: string, details?: Record<string, unknown>) => void;

/** `<dir(PI_DATA_FILE)>/name`，保证与 runs/vault 同目录（demo 已挂载且可写）。 */
function dataDirFile(env: NodeJS.ProcessEnv, explicitKey: string, name: string): string {
  const explicit = String(env[explicitKey] ?? "").trim();
  if (explicit) return explicit;
  const dataFile = String(env.PI_DATA_FILE ?? "").trim();
  if (dataFile) return join(dirname(dataFile), name);
  return join(process.cwd(), "data", name);
}

export function modelPriceFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return dataDirFile(env, "PI_MODEL_PRICES_FILE", "model-prices.json");
}

export function providerCreditsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return dataDirFile(env, "PI_PROVIDER_CREDITS_FILE", "provider-credits.json");
}

function readConfigFile<T>(input: {
  file: string;
  parse: (raw: unknown) => T;
  empty: T;
  label: string;
  warn?: Warn;
}): ConfigFileState<T> {
  let text: string;
  try {
    text = readFileSync(input.file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { value: input.empty, integrity: "missing", file: input.file };
    const detail = `读取失败：${(error as Error).message}`;
    input.warn?.(`${input.label} 读取失败，按空配置继续`, { file: input.file, error: (error as Error).message });
    return { value: input.empty, integrity: "invalid", detail, file: input.file };
  }
  try {
    const parsed = input.parse(JSON.parse(text));
    return { value: parsed, integrity: "ok", file: input.file };
  } catch (error) {
    const detail = (error as Error).message;
    input.warn?.(`${input.label} 内容非法，按空配置继续（界面会显示未录入/未知）`, { file: input.file, detail });
    return { value: input.empty, integrity: "invalid", detail, file: input.file };
  }
}

/** 原子写：临时文件 + rename，避免读到半截 JSON。 */
function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* 清理失败不影响主错误 */
    }
    throw error;
  }
}

export function readModelPriceTable(options: { env?: NodeJS.ProcessEnv; warn?: Warn } = {}): ConfigFileState<ModelPriceTable> {
  return readConfigFile({
    file: modelPriceFilePath(options.env ?? process.env),
    parse: parseModelPriceTable,
    empty: EMPTY_MODEL_PRICE_TABLE,
    label: "价目表",
    warn: options.warn,
  });
}

export function readProviderCreditBook(options: { env?: NodeJS.ProcessEnv; warn?: Warn } = {}): ConfigFileState<ProviderCreditBook> {
  return readConfigFile({
    file: providerCreditsFilePath(options.env ?? process.env),
    parse: parseProviderCreditBook,
    empty: EMPTY_PROVIDER_CREDIT_BOOK,
    label: "额度簿",
    warn: options.warn,
  });
}

export function writeProviderCreditBook(book: ProviderCreditBook, options: { env?: NodeJS.ProcessEnv } = {}): string {
  const file = providerCreditsFilePath(options.env ?? process.env);
  writeJsonFile(file, book);
  return file;
}

/** 供测试与运维复用：写价目表（人工维护的配置文件）。 */
export function writeModelPriceTable(table: ModelPriceTable, options: { env?: NodeJS.ProcessEnv } = {}): string {
  const file = modelPriceFilePath(options.env ?? process.env);
  writeJsonFile(file, table);
  return file;
}
