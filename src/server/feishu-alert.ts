import { createHmac } from "node:crypto";

/** Custom-bot v2 protocol; no user-controlled links, mentions or raw details. */
export function feishuAlertPayload(alert: {
  severity: string; key: string; message: string;
  service: string; environment: string; version: string; at: string;
}, signingSecret?: string) {
  const text = [
    `PiGO ${alert.severity.toUpperCase()} 告警`,
    `服务 / Service: ${alert.service}`,
    `环境 / Environment: ${alert.environment}`,
    `版本 / Version: ${alert.version}`,
    `类型 / Key: ${alert.key}`,
    `时间 / Time: ${alert.at}`,
    alert.message,
  ].join("\n").replaceAll("<", "＜").replaceAll(">", "＞");
  const payload = { msg_type: "text", content: { text: Array.from(text).slice(0, 3_000).join("") } };
  if (!signingSecret) return payload;
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const sign = createHmac("sha256", `${timestamp}\n${signingSecret}`).update("").digest("base64");
  return { ...payload, timestamp, sign };
}

/** Only the official HTTPS custom-bot endpoint is valid in Feishu mode. */
export function isFeishuWebhook(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "open.feishu.cn"
      && !url.port && !url.username && !url.password && !url.search && !url.hash
      && /^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9_-]+$/.test(url.pathname);
  } catch { return false; }
}

/** Bound receiver reads, never include its private body/message in an error. */
export async function verifyFeishuResponse(response: Response): Promise<void> {
  const invalid = () => new Error("Feishu webhook invalid response");
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  let text = "", bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4_096) throw invalid();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    let body: Record<string, unknown>;
    try { body = JSON.parse(text); } catch { throw invalid(); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
    const code = "code" in body ? body.code : body.StatusCode;
    if (!Number.isSafeInteger(code)) throw invalid();
    if (code !== 0 || ("StatusCode" in body && body.StatusCode !== 0)) {
      throw new Error(`Feishu webhook rejected (code ${code})`);
    }
  } catch (error) {
    // Do not forward parser, decoder or transport errors containing body data.
    if (error instanceof Error && /^Feishu webhook (invalid response|rejected \(code -?\d+\))$/.test(error.message)) throw error;
    throw invalid();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
