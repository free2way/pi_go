import type { CredentialVault } from "./credential-vault.js";
import { MAX_EXPORT_CREDENTIALS, parseExportCredentialContext } from "../shared/export-credential-context.js";

/** Only the acting user's current keys and migrated alias. No cache or writes;
 * identity/decryption errors must stop export rather than drop the context.
 */
export async function sourceExportCredentials(
  actorId: string,
  vault: Pick<CredentialVault, "configuredProviders" | "get">,
  legacyOwnerFor: (id: string) => Promise<string | undefined>,
): Promise<string[]> {
  const legacy = await legacyOwnerFor(actorId);
  const owners = [...new Set([actorId, ...(legacy ? [legacy] : [])])];
  const keys = new Set<string>();
  for (const owner of owners) {
    const providers = vault.configuredProviders(owner);
    if (providers.length > MAX_EXPORT_CREDENTIALS) throw new Error("Export credential context unavailable");
    for (const provider of providers) {
      const value = vault.get(owner, provider);
      if (value) keys.add(value);
    }
  }
  const context = parseExportCredentialContext([...keys]);
  if (!context) throw new Error("Export credential context unavailable");
  return context;
}
