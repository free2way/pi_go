/**
 * SEC-003 / SEC-010: agent processes and check commands must never inherit the
 * worker's own secrets (internal callback token, vault secret, database
 * password, other providers' keys). Only the credential required by the current
 * role is injected back into the child environment.
 */
const secretSuffix = /(_TOKEN|_SECRET|_PASSWORD|_KEY|_CREDENTIAL|_CREDENTIALS)$/i;
/** Secret-bearing names that do not follow the suffix convention. */
const secretNames = new Set(["PI_DATABASE_URL", "DATABASE_URL", "PGPASSWORD", "PI_VAULT_FILE"]);

export function scrubEnvironment(env: NodeJS.ProcessEnv, keep: string[] = []): NodeJS.ProcessEnv {
  const allowed = new Set(keep);
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((secretSuffix.test(name) || secretNames.has(name)) && !allowed.has(name)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

/** Names that must never be visible to an agent or a check command. */
export const workerOnlySecrets = [
  "PI_INTERNAL_TOKEN",
  "PI_VAULT_SECRET",
  "PI_DATABASE_URL",
  "PIGO_POSTGRES_PASSWORD",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
] as const;
