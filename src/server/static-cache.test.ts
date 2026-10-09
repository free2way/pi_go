import { describe, expect, it } from "vitest";
import { cacheControlFor, isBuildAssetRequest, isImmutableBuildAsset } from "./static-cache.js";

/**
 * 缓存策略的单元测试。这些断言直接对应"为什么访问慢"的两条根因：
 * 带 hash 的构建产物曾被全局 `no-store` 覆盖，每次刷新都重新下载整个 bundle。
 */
describe("cacheControlFor", () => {
  it("API 一律 no-store（数据与鉴权相关，绝不缓存）", () => {
    expect(cacheControlFor("/api/agile/projects")).toBe("no-store");
    expect(cacheControlFor("/api/runs/run_1/events")).toBe("no-store");
    expect(cacheControlFor("/api/health?x=1")).toBe("no-store");
  });

  it("内容带 hash 的构建产物长期缓存且 immutable", () => {
    expect(cacheControlFor("/assets/index-C4pICr6h.js")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("/assets/index-CrFcwsXl.css")).toBe("public, max-age=31536000, immutable");
    // 查询串不影响判定（同一个文件）
    expect(cacheControlFor("/assets/index-C4pICr6h.js?v=2")).toBe("public, max-age=31536000, immutable");
  });

  it("index.html 与 SPA 回退走 no-cache（每次校验，避免指向已删除的产物）", () => {
    expect(cacheControlFor("/")).toBe("no-cache");
    expect(cacheControlFor("/index.html")).toBe("no-cache");
    expect(cacheControlFor("/runs/run_123")).toBe("no-cache");
    expect(cacheControlFor("/agile")).toBe("no-cache");
  });

  it("不带内容 hash 的 /assets 路径不享受长缓存（否则会把 HTML 当 JS 缓存）", () => {
    expect(cacheControlFor("/assets/index.js")).toBe("no-cache");
    expect(cacheControlFor("/assets/logo.png")).toBe("no-cache");
  });
});

describe("isImmutableBuildAsset", () => {
  it("只认带 8 位以上 hash 的产物", () => {
    expect(isImmutableBuildAsset("/assets/index-C4pICr6h.js")).toBe(true);
    expect(isImmutableBuildAsset("/assets/index-abc12345.css")).toBe(true);
    expect(isImmutableBuildAsset("/assets/index-abc.js")).toBe(false);
    expect(isImmutableBuildAsset("/assets/index.js")).toBe(false);
    expect(isImmutableBuildAsset("/index-C4pICr6h.js")).toBe(false);
  });
});

describe("isBuildAssetRequest", () => {
  it("覆盖 /assets/ 下的一切请求（含已删除的旧 hash，交给 404 而不是回退 index.html）", () => {
    expect(isBuildAssetRequest("/assets/index-C4pICr6h.js")).toBe(true);
    expect(isBuildAssetRequest("/assets/index-carefullyDeleted.js")).toBe(true);
    expect(isBuildAssetRequest("/assets/index-carefullyDeleted.js?v=1")).toBe(true);
    expect(isBuildAssetRequest("/runs/run_1")).toBe(false);
    expect(isBuildAssetRequest("/api/health")).toBe(false);
  });
});
