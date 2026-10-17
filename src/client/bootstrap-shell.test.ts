import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("bootstrap loading shell", () => {
  it("renders useful content before the JavaScript bundle finishes loading", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

    expect(html).toContain("data-bootstrap-shell");
    expect(html).toContain("aria-live=\"polite\"");
    expect(html).toContain("PiGO 正在加载… / Loading…");
    expect(html).not.toContain('<div id="root"></div>');
  });
});
