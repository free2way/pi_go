import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, expect, it } from "vitest";
import { BackupPanel, BackupsPage } from "./BackupsPage";
import type { BackupOverview } from "../shared/backups";
import { localeStore } from "./i18n";
afterEach(() => localeStore.setLocale("zh"));
beforeEach(() => localeStore.setLocale("zh"));
const overview: BackupOverview = {
  backups: [{ id: "backup_" + "a".repeat(32), createdAt: "2026-01-01T00:00:00Z", state: "ready", bytes: 100, files: 2, protected: true }, { id: "backup_" + "b".repeat(32), createdAt: "2025-12-31T00:00:00Z", state: "deleted", bytes: 100, files: 2, protected: false }],
  busy: false, encryption: "none", scope: "application-data", audit: [], retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 3, automaticDeletion: false },
};
it("does not render backup controls for ordinary users", () => {
  const html = renderToStaticMarkup(<BackupsPage isAdmin={false} />); expect(html).toContain("仅管理员"); expect(html).not.toContain("立即备份");
});
it("states plaintext, scope and reversible deletion boundaries", () => {
  const html = renderToStaticMarkup(<BackupsPage isAdmin />); expect(html).toContain("明文备份"); expect(html).toContain("不释放磁盘空间"); expect(html).toContain("不包含源码工作区");
});
it("protects the latest backup and offers undo rather than database restore", () => {
  const html = renderToStaticMarkup(<BackupPanel overview={overview} busy={false} onAction={() => undefined} />);
  expect(html).toContain("最新成功备份"); expect(html).toContain('disabled=""'); expect(html).toContain("撤销删除"); expect(html).toContain("未演练恢复");
});
it("renders English copy with the same safety boundaries", () => {
  localeStore.setLocale("en"); const html = renderToStaticMarkup(<BackupsPage isAdmin />); expect(html).toContain("unencrypted"); expect(html).toContain("does not reclaim disk space");
});
