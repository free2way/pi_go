import { describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY, resolveLocale, type Locale } from "../shared/i18n";
import {
  applyLocaleToDocument,
  createLocaleStore,
  pageDescription,
  pageTitle,
  persistLocale,
  readStoredLocale,
  type LocaleStorage,
} from "./i18n";

function fakeStorage(initial?: Record<string, string>) {
  const data = new Map(Object.entries(initial ?? {}));
  const storage: LocaleStorage & { data: Map<string, string> } = {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
  };
  return storage;
}

describe("locale persistence (pure store)", () => {
  it("reads a valid stored choice", () => {
    expect(readStoredLocale(fakeStorage({ [LOCALE_STORAGE_KEY]: "en" }))).toBe("en");
    expect(readStoredLocale(fakeStorage({ [LOCALE_STORAGE_KEY]: "klingon" }))).toBe("klingon");
  });

  it("survives unavailable or throwing storage", () => {
    expect(readStoredLocale(undefined)).toBeUndefined();
    const broken: LocaleStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readStoredLocale(broken)).toBeUndefined();
    expect(() => persistLocale(broken, "en")).not.toThrow();
  });

  it("persists the choice under the documented key", () => {
    const storage = fakeStorage();
    persistLocale(storage, "en");
    expect(storage.data.get(LOCALE_STORAGE_KEY)).toBe("en");
  });

  it("resolves the initial locale from storage, then the navigator, then the default", () => {
    const fromStorage = createLocaleStore({ storage: fakeStorage({ [LOCALE_STORAGE_KEY]: "en" }), navigatorLanguages: ["zh-CN"] });
    expect(fromStorage.getLocale()).toBe("en");
    const fromNavigator = createLocaleStore({ storage: fakeStorage(), navigatorLanguages: ["en-GB"] });
    expect(fromNavigator.getLocale()).toBe("en");
    const fallback = createLocaleStore({ storage: fakeStorage(), navigatorLanguages: ["fr-FR"] });
    expect(fallback.getLocale()).toBe("zh");
    expect(fromStorage.getLocale()).toBe(resolveLocale("en", ["zh-CN"]));
  });

  it("switches locale, persists it, applies it and notifies subscribers", () => {
    const storage = fakeStorage();
    const applied: Locale[] = [];
    const store = createLocaleStore({ storage, navigatorLanguages: ["zh-CN"], apply: (locale) => applied.push(locale) });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setLocale("en");
    expect(store.getLocale()).toBe("en");
    expect(storage.data.get(LOCALE_STORAGE_KEY)).toBe("en");
    expect(applied).toEqual(["zh", "en"]);
    expect(listener).toHaveBeenCalledTimes(1);

    // Re-selecting the active locale still persists/applies, but is idempotent.
    store.setLocale("en");
    expect(listener).toHaveBeenCalledTimes(2);

    store.setLocale("zh");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.getLocale()).toBe("zh");

    unsubscribe();
    store.setLocale("en");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("honours an explicit initial value over storage", () => {
    const store = createLocaleStore({ storage: fakeStorage({ [LOCALE_STORAGE_KEY]: "zh" }), initial: "en" });
    expect(store.getLocale()).toBe("en");
  });
});

describe("document integration", () => {
  function fakeDocument() {
    const attributes = new Map<string, string>();
    const meta = { setAttribute: (name: string, value: string) => attributes.set(name, value) };
    return {
      attributes,
      document: {
        title: "",
        documentElement: { lang: "" },
        querySelector: () => meta,
      } as unknown as Document,
    };
  }

  it("sets the html lang and localized title/description", () => {
    const { document, attributes } = fakeDocument();
    applyLocaleToDocument("en", document);
    expect(document.documentElement.lang).toBe("en-US");
    expect(document.title).toBe(pageTitle("en"));
    expect(attributes.get("content")).toBe(pageDescription("en"));

    applyLocaleToDocument("zh", document);
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.title).toContain("PiGO");
  });

  it("is a no-op without a document", () => {
    expect(() => applyLocaleToDocument("en", undefined)).not.toThrow();
  });
});
