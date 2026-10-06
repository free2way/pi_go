import { describe, expect, it } from "vitest";
import {
  CATALOGS,
  DEFAULT_LOCALE,
  ERROR_CODE_KEYS,
  LOCALE_STORAGE_KEY,
  LOCALES,
  catalogKeys,
  duplicateCatalogKeys,
  interpolate,
  isLocale,
  localeFromAcceptLanguage,
  localizeError,
  resolveLocale,
  resolveRequestLocale,
  t,
  type Locale,
  type MessageKey,
} from "./i18n";

/** Indexes a catalog by an arbitrary key (the parity checks are intentionally key-agnostic). */
const value = (locale: Locale, key: string): string =>
  (CATALOGS[locale] as Record<string, string | undefined>)[key] ?? "";

describe("i18n catalog parity", () => {
  it("ships the same key set in both locales", () => {
    expect(catalogKeys("en")).toEqual(catalogKeys("zh"));
    expect(catalogKeys("zh").length).toBeGreaterThan(400);
  });

  it("lists every locale exactly once", () => {
    expect([...LOCALES]).toEqual(["zh", "en"]);
  });

  it("defines no key twice across the catalog sections", () => {
    expect(duplicateCatalogKeys("zh")).toEqual([]);
    expect(duplicateCatalogKeys("en")).toEqual([]);
  });

  it("has no empty or whitespace-only values", () => {
    for (const locale of LOCALES) {
      const empty = catalogKeys(locale).filter((key) => value(locale, key).trim() === "");
      expect(empty, `${locale} has empty values`).toEqual([]);
    }
  });

  it("keeps {placeholder} names consistent between locales", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    const mismatched = catalogKeys("zh").filter((key) => {
      const zh = placeholders(value("zh", key));
      const en = placeholders(value("en", key));
      return zh.join(",") !== en.join(",");
    });
    expect(mismatched).toEqual([]);
  });
});

describe("interpolate", () => {
  it("replaces named placeholders", () => {
    expect(interpolate("{a} + {b}", { a: 1, b: "2" })).toBe("1 + 2");
  });

  it("keeps unknown placeholders verbatim and tolerates missing params", () => {
    expect(interpolate("{a} {b}", { a: "x" })).toBe("x {b}");
    expect(interpolate("{a}")).toBe("{a}");
  });
});

describe("t", () => {
  it("renders the selected locale with interpolation", () => {
    expect(t("zh", "alert.cleaned", { count: 3 })).toBe("已清理 3 个已结束任务。");
    expect(t("en", "alert.cleaned", { count: 3 })).toBe("Cleaned up 3 finished run(s).");
  });

  it("falls back to the key (never throws) for an unknown key", () => {
    expect(t("en", "does.not.exist" as MessageKey)).toBe("does.not.exist");
    expect(t("zh", "does.not.exist" as MessageKey, { x: 1 })).toBe("does.not.exist");
  });

  it("falls back to the default catalog when the selected locale is unknown", () => {
    expect(t("fr" as Locale, "common.cancel")).toBe("取消");
  });
});

describe("resolveLocale", () => {
  it("prefers a stored choice over the browser languages", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("zh", ["en-US"])).toBe("zh");
  });

  it("ignores an invalid stored value and uses the browser languages", () => {
    expect(resolveLocale("fr", ["en-GB", "zh-CN"])).toBe("en");
    expect(resolveLocale(undefined, ["zh-Hans"])).toBe("zh");
    expect(resolveLocale(null, ["EN"])).toBe("en");
  });

  it("falls back to the default locale without a usable preference", () => {
    expect(resolveLocale(undefined, [])).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("nope", ["fr-FR"])).toBe(DEFAULT_LOCALE);
    expect(DEFAULT_LOCALE).toBe("zh");
  });

  it("validates locale codes", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("zh")).toBe(true);
    expect(isLocale("en-US")).toBe(false);
  });

  it("exposes a stable storage key", () => {
    expect(LOCALE_STORAGE_KEY).toBe("pigo.locale");
  });
});

describe("request locale resolution", () => {
  it("reads the Accept-Language header first", () => {
    expect(resolveRequestLocale("en-US,en;q=0.9,zh;q=0.8", "zh")).toBe("en");
    expect(resolveRequestLocale("zh-CN,zh;q=0.9", "en")).toBe("zh");
    expect(localeFromAcceptLanguage("en-GB")).toBe("en");
    expect(localeFromAcceptLanguage("de-DE,zh;q=0.5")).toBe("zh");
  });

  it("falls back to ?locale, then to the default locale", () => {
    expect(resolveRequestLocale(undefined, "en")).toBe("en");
    expect(resolveRequestLocale("de-DE", "en")).toBe("en");
    expect(resolveRequestLocale(undefined, undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveRequestLocale(undefined, "fr")).toBe(DEFAULT_LOCALE);
  });

  it("ignores unusable headers instead of guessing", () => {
    expect(localeFromAcceptLanguage(undefined)).toBeUndefined();
    expect(localeFromAcceptLanguage(42)).toBeUndefined();
    expect(localeFromAcceptLanguage("*")).toBeUndefined();
    expect(localeFromAcceptLanguage("")).toBeUndefined();
    expect(localeFromAcceptLanguage("de-DE, fr;q=0.8")).toBeUndefined();
  });
});

describe("server error code mapping", () => {
  it("maps the documented agile/run codes", () => {
    for (const code of [
      "ADMIN_REQUIRED",
      "BLOCKED_BY_RUN",
      "BLOCKED_BY_MANUAL",
      "STORY_NOT_READY",
      "STORY_NOT_REOPENABLE",
      "RELEASE_IN_PROGRESS",
      "SANDBOX_UNAVAILABLE",
      "WORKER_SHUTTING_DOWN",
    ]) {
      expect(ERROR_CODE_KEYS[code], code).toBeTruthy();
    }
  });

  it("localizes a known code and ignores the server's Chinese message", () => {
    const error = { code: "STORY_NOT_READY", message: "只有「就绪」状态的故事可以提交为运行" };
    expect(localizeError("en", error)).toBe("Only a story in the ready state can be submitted as a run.");
    expect(localizeError("zh", error)).toBe("只有「就绪」状态的故事可以提交为运行。");
  });

  it("falls back to the server message for an unknown code", () => {
    expect(localizeError("en", { code: "SOMETHING_NEW", message: "服务端消息" })).toBe("服务端消息");
  });

  it("falls back to the caller's message, then the generic copy", () => {
    expect(localizeError("en", new Error("network down"), "fallback")).toBe("network down");
    expect(localizeError("en", undefined, "fallback")).toBe("fallback");
    expect(localizeError("en", undefined)).toBe(CATALOGS.en["error.generic"]);
  });

  it("renders every mapped code in both locales", () => {
    for (const [code, key] of Object.entries(ERROR_CODE_KEYS)) {
      const en = t("en", key);
      expect(en, code).not.toBe(key);
      expect(t("zh", key), code).not.toBe(key);
    }
  });
});
