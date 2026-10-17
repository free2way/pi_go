export class ExportPolicyError extends Error { code: string }
export type ExportFinding = { category: string; path: string };
export function pathPolicy(name: string): string | undefined;
export function contentPolicy(text: string): string[];
export function inspectExportHistory(input: {
  git: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  head: string;
  base?: string | null;
}): Promise<ExportFinding[]>;
