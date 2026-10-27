/** Internal guarded-push contract. Never reflect invalid values in errors. */
export const MAX_EXPORT_CREDENTIALS = 256;

export function parseExportCredentialContext(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_EXPORT_CREDENTIALS
    || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512)) return undefined;
  return [...new Set(value as string[])];
}
