import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEPLOY_LOG_PATH,
  buildDeploymentStatus,
  parseDeployLog,
  parseDeployLogLine,
  parseRollbackTags,
  resolveDeployLogPath,
} from "./deployments.js";

describe("resolveDeployLogPath (A3)", () => {
  it("defaults when unset and honors an override", () => {
    expect(resolveDeployLogPath({})).toBe(DEFAULT_DEPLOY_LOG_PATH);
    expect(resolveDeployLogPath({ PI_DEPLOY_LOG: " /tmp/deploy.log " })).toBe("/tmp/deploy.log");
  });
});

describe("parseDeployLogLine (A3)", () => {
  it("parses a JSON line", () => {
    expect(parseDeployLogLine('{"at":"2026-01-02T03:04:05Z","version":"0.22.0","role":"web","commit":"abc","status":"ok"}')).toMatchObject({
      at: "2026-01-02T03:04:05Z",
      version: "0.22.0",
      role: "web",
      commit: "abc",
      status: "ok",
    });
  });

  it("falls back to key=value text when JSON is malformed", () => {
    const record = parseDeployLogLine('{"broken":  version=0.21.9 role=worker status=ok');
    expect(record).toMatchObject({ version: "0.21.9", role: "worker", status: "ok" });
  });

  it("ignores blank lines", () => {
    expect(parseDeployLogLine("   ")).toBeUndefined();
  });
});

describe("parseDeployLog (A3)", () => {
  it("returns an empty list for missing content", () => {
    expect(parseDeployLog(undefined)).toEqual([]);
    expect(parseDeployLog("")).toEqual([]);
  });

  it("skips malformed lines without dropping valid ones", () => {
    const content = [
      "not a record",
      '{"version":"1.0.0","role":"web"}',
      "2026-01-02T03:04:05Z version=1.0.1 role=worker status=ok",
    ].join("\n");
    const records = parseDeployLog(content);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ version: "1.0.1", role: "worker" });
    expect(records[1]).toMatchObject({ version: "1.0.0", role: "web" });
  });

  it("bounds the record count, newest first", () => {
    const content = Array.from({ length: 30 }, (_, index) => JSON.stringify({ version: `v${index}` })).join("\n");
    const records = parseDeployLog(content, 5);
    expect(records).toHaveLength(5);
    expect(records[0].version).toBe("v29");
    expect(records[4].version).toBe("v25");
  });
});

describe("parseRollbackTags (A3)", () => {
  it("splits, trims and bounds", () => {
    expect(parseRollbackTags(" v1 , v2 ,, v3 ")).toEqual(["v1", "v2", "v3"]);
    expect(parseRollbackTags(undefined)).toEqual([]);
  });
});

describe("buildDeploymentStatus (A3)", () => {
  it("reports unknown versions as null and surfaces the log state", () => {
    const status = buildDeploymentStatus({ env: {}, records: [], logPath: "/tmp/deploy.log", logAvailable: false, logError: "ENOENT", at: "now" });
    expect(status.web.version).toBeNull();
    expect(status.worker.version).toBeNull();
    expect(status.records).toEqual([]);
    expect(status.log).toEqual({ available: false, path: "/tmp/deploy.log", error: "ENOENT" });
    expect(status.at).toBe("now");
  });

  it("prefers the web version and reads the worker version and rollback tags", () => {
    const status = buildDeploymentStatus({
      env: { PI_VERSION: "1.0.0", PI_WEB_VERSION: "1.1.0", PI_WORKER_VERSION: "1.0.5", PI_ROLLBACK_TAGS: "v1,v2" },
      records: [],
      logPath: "/tmp/x",
      logAvailable: true,
    });
    expect(status.web.version).toBe("1.1.0");
    expect(status.worker.version).toBe("1.0.5");
    expect(status.rollbackTags).toEqual(["v1", "v2"]);
  });
});
