import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { localeStore } from "./i18n";

/**
 * Locale wiring of the real app shell. Rendering with `react-dom/server` keeps
 * this dependency-free (no jsdom): effects never run, so the shell renders
 * without any API call, and the assertion is about which catalog the components
 * actually read. The language *switch* mechanics (persistence + subscription)
 * are covered in `src/client/i18n.test.ts`.
 */
describe("App locale wiring", () => {
  beforeEach(() => {
    localeStore.setLocale("zh");
  });

  it("renders the header language selector with both locales", () => {
    const html = renderToString(<App />);
    expect(html).toContain('class="locale-select"');
    expect(html).toContain(">中文<");
    expect(html).toContain(">English<");
  });

  it("renders 中文 copy from the catalog by default", () => {
    const html = renderToString(<App />);
    expect(html).toContain("新建任务");
    expect(html).toContain("工作流");
    expect(html).toContain("最近任务");
    expect(html).toContain("退出登录");
    expect(html).toContain("创建开发工作流");
  });

  it("re-renders the same shell in English after switching", () => {
    localeStore.setLocale("en");
    const html = renderToString(<App />);
    expect(html).toContain("New run");
    expect(html).toContain("Workflows");
    expect(html).toContain("Recent runs");
    expect(html).toContain("Sign out");
    expect(html).toContain("Create a development workflow");
    expect(html).toContain("Verifying account");
    expect(html).not.toContain("新建任务");
  });

  it("switches back to 中文 without a reload", () => {
    localeStore.setLocale("en");
    expect(renderToString(<App />)).toContain("New run");
    localeStore.setLocale("zh");
    const html = renderToString(<App />);
    expect(html).toContain("新建任务");
    expect(html).not.toContain("New run");
  });
});
