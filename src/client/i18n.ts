/**
 * Client-side i18n store (docs/23-i18n.md).
 *
 * The catalogs and the pure helpers live in `src/shared/i18n.ts`; this module
 * owns the browser bits: reading/writing `localStorage`, resolving the initial
 * locale from the browser, keeping `<html lang>` / document title in sync, and a
 * tiny `useSyncExternalStore` hook so a language switch re-renders every
 * subscribed component without a reload.
 *
 * `createLocaleStore` is dependency-injected (storage / navigator / apply are
 * options) so persistence and switching can be unit-tested without a DOM.
 */

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  LOCALE_STORAGE_KEY,
  LOCALES,
  resolveLocale,
  t as translate,
  type I18nParams,
  type Locale,
  type MessageKey,
} from "../shared/i18n";

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LocaleStoreOptions {
  storage?: LocaleStorage | null;
  navigatorLanguages?: readonly string[];
  /** Applied on creation and after every switch (DOM side effects). */
  apply?: (locale: Locale) => void;
  /** Overrides what would otherwise be read from `storage` (tests). */
  initial?: unknown;
}

export interface LocaleStore {
  getLocale(): Locale;
  setLocale(locale: Locale): void;
  subscribe(listener: () => void): () => void;
}

/** Reads the stored choice; unavailable/blocked storage reads as `undefined`. */
export function readStoredLocale(storage?: LocaleStorage | null): unknown {
  try {
    return storage?.getItem(LOCALE_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Persists the choice; a blocked storage write is ignored, never fatal. */
export function persistLocale(storage: LocaleStorage | null | undefined, locale: Locale): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private mode / disabled storage: the in-memory choice still applies.
  }
}

export function createLocaleStore(options: LocaleStoreOptions = {}): LocaleStore {
  const storage = options.storage ?? null;
  const stored = options.initial !== undefined ? options.initial : readStoredLocale(storage);
  let current = resolveLocale(stored, options.navigatorLanguages ?? []);
  const listeners = new Set<() => void>();
  options.apply?.(current);
  return {
    getLocale: () => current,
    setLocale(next: Locale) {
      if (next !== current) current = next;
      persistLocale(storage, next);
      options.apply?.(next);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** Localized document title. */
export function pageTitle(locale: Locale): string {
  return translate(locale, "app.title");
}

/** Localized meta description. */
export function pageDescription(locale: Locale): string {
  return translate(locale, "app.description");
}

/**
 * Applies the locale to the document: `<html lang>` and the title/description.
 * A missing document (unit tests, SSR) is a no-op.
 */
export function applyLocaleToDocument(locale: Locale, documentRef: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!documentRef) return;
  documentRef.documentElement.lang = locale === "en" ? "en-US" : "zh-CN";
  documentRef.title = pageTitle(locale);
  const meta = documentRef.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute("content", pageDescription(locale));
}

function browserStorage(): LocaleStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function browserLanguages(): readonly string[] {
  try {
    if (typeof navigator === "undefined") return [];
    return navigator.languages?.length ? navigator.languages : [navigator.language];
  } catch {
    return [];
  }
}

/** The single app-wide store. */
export const localeStore: LocaleStore = createLocaleStore({
  storage: browserStorage(),
  navigatorLanguages: browserLanguages(),
  apply: (locale) => applyLocaleToDocument(locale),
});

export type TFunction = (key: MessageKey | string, params?: I18nParams) => string;

export interface UseTResult {
  locale: Locale;
  t: TFunction;
  setLocale: (locale: Locale) => void;
  locales: readonly Locale[];
  localeLabels: Record<Locale, string>;
}

/** Subscribes a component to the locale and returns a bound `t`. */
export function useT(): UseTResult {
  const locale = useSyncExternalStore(localeStore.subscribe, localeStore.getLocale, localeStore.getLocale);
  const t = useCallback<TFunction>((key, params) => translate(locale, key, params), [locale]);
  const setLocale = useCallback((next: Locale) => localeStore.setLocale(next), []);
  return { locale, t, setLocale, locales: LOCALES, localeLabels: LOCALE_LABELS };
}

export { DEFAULT_LOCALE, LOCALES, LOCALE_LABELS, LOCALE_STORAGE_KEY };
