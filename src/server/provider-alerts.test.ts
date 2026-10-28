import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertManager } from "./alerts.js";
import { createProviderAlertSweeper, PROVIDER_ALERT_KEY, readProviderAlertObservation } from "./provider-alerts.js";
import { createTestDb } from "./test-db.js";

afterEach(() => vi.useRealTimers());
const failure = "provider.attempt_failed";
const success = "session.metrics";
function row(seq: number, type = failure, provider = "deepseek", extra = {}) {
  return { run_id: "run", seq, at: new Date(seq * 1_000).toISOString(), type, meta_json: JSON.stringify({ provider, modelCalls: 1, ...extra }) };
}
const scope = ["deepseek", "other", "DUMMY_PRIVATE"];
const read = (rows: Record<string, unknown>[]) => readProviderAlertObservation({ query: async (_text, params) => ({ rows: rows.filter((r) => {
  try { const value = JSON.parse(String(r.meta_json)); return typeof value.provider === "string" && scope.includes(value.provider) ? value.provider === params?.[0] : params?.[0] === "deepseek"; }
  catch { return params?.[0] === "deepseek"; }
}).slice(0, 4) }) }, scope);

describe("durable provider failure observation", () => {
  it("does not call empty history recovery", async () => {
    expect(await read([])).toEqual({ failingProviders: 0, observedConsecutiveFailures: 0, recovered: false });
  });
  it.each([1, 2, 3, 4])("requires three consecutive failures: %s", async (count) => {
    const value = await read(Array.from({ length: count }, (_, i) => row(count - i)));
    expect(value.failingProviders).toBe(count >= 3 ? 1 : 0);
    expect(value.observedConsecutiveFailures).toBe(count); expect(value.recovered).toBe(false);
  });
  it("a successful invocation breaks the failure streak", async () => {
    expect(await read([row(5), row(4), row(3, success), row(2), row(1)])).toEqual({ failingProviders: 0, observedConsecutiveFailures: 2, recovered: false });
  });
  it("only a newer explicit successful invocation establishes recovery", async () => {
    expect(await read([row(4, success), row(3), row(2), row(1)])).toEqual({ failingProviders: 0, observedConsecutiveFailures: 0, recovered: true });
  });
  it("does not mix independent providers or let another provider mask a fault", async () => {
    expect(await read([row(5, success, "other"), row(4), row(3), row(2)])).toEqual({ failingProviders: 1, observedConsecutiveFailures: 3, recovered: false });
  });
  it("reports only numeric aggregate data even for private metadata", async () => {
    const value = await read([row(3, failure, "DUMMY_PRIVATE", { error: "DUMMY_ERROR", model: "DUMMY_MODEL" }), row(2, failure, "DUMMY_PRIVATE"), row(1, failure, "DUMMY_PRIVATE")]);
    expect(value.failingProviders).toBe(1); expect(JSON.stringify(value)).not.toContain("DUMMY");
  });
  it.each([{}, { provider: "" }, { provider: 3 }, { provider: "x".repeat(81) }])("unknown provider metadata cannot prove recovery: %j", async (meta) => {
    expect((await read([{ ...row(3, success), meta_json: JSON.stringify(meta) }, row(2, success)])).recovered).toBe(false);
  });
  it.each([0, -1, "1", null, 1.5])("invalid success model-call evidence cannot clear faults: %s", async (modelCalls) => {
    const value = await read([row(4, success, "deepseek", { modelCalls }), row(3), row(2), row(1)]);
    expect(value.failingProviders).toBe(1); expect(value.recovered).toBe(false);
  });
  it.each([{ meta_json: "{" }, { meta_json: "x".repeat(4097) }, { at: "bad" }, { seq: -1 }, { run_id: null }, { type: "chat.message" }])("invalid rows fail observation safely: %j", async (extra) => {
    await expect(read([{ ...row(1), ...extra }])).rejects.toThrow();
  });
  it("does not infer ordering between concurrent runs with identical timestamps", async () => {
    const a = row(5, success), b = { ...row(4), at: a.at, run_id: "other-run" };
    expect((await read([a, b])).recovered).toBe(false);
  });
  it("keeps in-run sequence ordering for events with identical timestamps", async () => {
    const a = row(5, success), b = { ...row(4), at: a.at };
    expect((await read([a, b])).recovered).toBe(true);
  });
  it("a hot provider cannot mask an older unresolved fault in another provider", async () => {
    const rows = [...Array.from({ length: 1_100 }, (_, i) => row(1_200 - i, success, "other")), row(3), row(2), row(1)];
    const value = await read(rows); expect(value.failingProviders).toBe(1); expect(value.recovered).toBe(false);
    expect((await read([row(1_300, success), ...rows])).recovered).toBe(true);
  });
  it("refuses an unbounded provider scope", async () => {
    const query = vi.fn(); await expect(readProviderAlertObservation({ query }, Array.from({ length: 65 }, (_, i) => String(i)))).rejects.toThrow(); expect(query).not.toHaveBeenCalled();
  });
  it("queries a fixed indexed projection and applies durable delivery uniqueness", async () => {
    const db = await createTestDb();
    for (const n of [1, 2, 3]) {
      const r = row(n);
      await db.query("INSERT INTO run_events(run_id,seq,at,round,source,type,message,meta_json,delivery_id) VALUES ($1,$2,$3,1,'system',$4,'fixture',$5,$6)", [r.run_id, r.seq, r.at, r.type, r.meta_json, String(n)]);
    }
    expect((await readProviderAlertObservation(db, ["deepseek"])).failingProviders).toBe(1);
    await db.query("INSERT INTO run_events(run_id,seq,at,round,source,type,message,meta_json) VALUES ('run',4,$1,1,'system',$2,'fixture',$3)", [row(4).at, success, row(4, success).meta_json]);
    expect((await readProviderAlertObservation(db, ["deepseek"])).recovered).toBe(true);
    expect((await db.query("SELECT name FROM schema_migrations WHERE id=17")).rows[0]?.name).toBe("provider-alert-outcome-observation");
  });
});

function setup() {
  const sink = vi.fn(), warn = vi.fn();
  const alerts = new AlertManager(sink, 900_000);
  const observe = vi.fn(async () => ({ failingProviders: 1, observedConsecutiveFailures: 3, recovered: false }));
  return { sink, warn, alerts, observe, sweeper: createProviderAlertSweeper({ alerts, read: observe, warn }) };
}

describe("provider alert lifecycle", () => {
  it("automatically observes immediately and every minute without duplicate timers", async () => {
    vi.useFakeTimers(); const s = setup(); s.sweeper.start(); s.sweeper.start(); await vi.advanceTimersByTimeAsync(120_000);
    expect(s.observe).toHaveBeenCalledTimes(3); expect(s.sink).toHaveBeenCalledOnce();
    expect(s.sink).toHaveBeenCalledWith(expect.objectContaining({ key: PROVIDER_ALERT_KEY, details: { providers: 1, threshold: 3, observedConsecutiveFailures: 3 } }));
    s.sweeper.stop();
  });
  it("deduplicates repeated faults, explicitly recovers and rearms inside cooldown", async () => {
    const s = setup(); await s.sweeper.sweep(); await s.sweeper.sweep(); expect(s.sink).toHaveBeenCalledOnce();
    s.observe.mockResolvedValueOnce({ failingProviders: 0, observedConsecutiveFailures: 0, recovered: true }); await s.sweeper.sweep();
    expect(s.alerts.activeKeys).not.toContain(PROVIDER_ALERT_KEY); await s.sweeper.sweep(); expect(s.sink).toHaveBeenCalledTimes(2);
  });
  it("unknown/empty observations and query errors retain the active condition", async () => {
    const s = setup(); await s.sweeper.sweep(); s.observe.mockResolvedValueOnce({ failingProviders: 0, observedConsecutiveFailures: 0, recovered: false }); await s.sweeper.sweep();
    s.observe.mockRejectedValueOnce(new Error("DUMMY_PRIVATE_QUERY")); await s.sweeper.sweep(); expect(s.alerts.activeKeys).toContain(PROVIDER_ALERT_KEY);
    expect(s.warn).toHaveBeenCalledWith(); expect(JSON.stringify(s.warn.mock.calls)).not.toContain("DUMMY");
  });
  it("times out a frozen observer and does not overlap in-flight sweeps", async () => {
    vi.useFakeTimers(); const s = setup(); s.observe.mockImplementationOnce(() => new Promise(() => {}));
    const pending = s.sweeper.sweep(); await s.sweeper.sweep(); expect(s.observe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_001); await pending; expect(s.warn).toHaveBeenCalledOnce();
    await s.sweeper.sweep(); expect(s.sink).toHaveBeenCalledOnce(); s.sweeper.stop();
  });
  it("stop ignores in-flight completion and prevents future sweeps", async () => {
    vi.useFakeTimers(); const s = setup(); let done!: () => void;
    s.observe.mockImplementation(() => new Promise(resolve => { done = () => resolve({ failingProviders: 1, observedConsecutiveFailures: 3, recovered: false }); }));
    s.sweeper.start(); await vi.advanceTimersByTimeAsync(0); s.sweeper.stop(); done(); await vi.advanceTimersByTimeAsync(120_000);
    expect(s.observe).toHaveBeenCalledOnce(); expect(s.sink).not.toHaveBeenCalled();
  });
});
