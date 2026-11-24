import path from "node:path";
import { AccountService } from "./accounts.js";
import { BackupManager, dumpBackup } from "./backups.js";
import { registerBackupRoutes } from "./backup-routes.js";
import { releaseSettingsStatus } from "./release-settings.js";
import { providerProbeDisabled } from "./provider-probe.js";
import { loadDecisionEngineConfig } from "./decision-engine/index.js";
import { resetDecisionCircuitBreakers } from "./decision-engine/jev.js";
import { decisionEngineStatus } from "./decision-routes.js";
import { registerAccountAdminRoutes } from "./routes/account-admin.js";
import { registerAssistantRoutes } from "./routes/assistant.js";
import { registerCredentialRoutes } from "./routes/model-key-routes.js";
import { registerModelRoutes } from "./routes/models.js";
import type { WebServices } from "./web-services.js";

export function registerWebSettingsRoutes(services: WebServices) {
  const {
    app, auth, credentialWrites, dataFile, db, demoMode, effectiveReleaseConfig, hasVaultDecisionKey,
    identities, internalToken, mergeRequestConfig, modelCatalog, modelDefaults, piAssistantQuestions,
    providerProbe, publicOrigin, realRunsEnabled, releaseCallbackOrigin, releaseSettings,
    releaseSettingsFile, requestLocale, requirementRefinements, scmSettingsFile, vault, vaultFile,
    vaultKeyFor, workerRequest,
  } = services;

  // ---------------------------------------------------------------------------
  // 账户管理 (account management) — admin only.
  //
  // The instance owner discovered their account was still `role: "user"` while
  // merge refused with 403, so roles/statuses must be inspectable and manageable.
  // Guardrails (no self role change, never lose the last active admin) live in
  // `accounts.ts` and are unit-tested; every change appends a `user_audit` row.
  // ---------------------------------------------------------------------------
  const backups = new BackupManager({
    root: path.join(path.dirname(dataFile), "backups"),
    dump: (destination) => dumpBackup(process.env.PI_DATABASE_URL || "", destination),
    sources: { "credentials.vault.json": vaultFile, "release-settings.json": releaseSettingsFile, "scm-settings.json": scmSettingsFile },
  });
  registerBackupRoutes(app, {
    manager: backups,
    admin: async (request) => {
      const actor = auth.user(request);
      return await identities.isAdmin(actor.id) ? actor.id : undefined;
    },
  });


  function releaseSettingsProjection() {
    const saved = releaseSettings.get();
    const effective = effectiveReleaseConfig("staging");
    const environmentWebhook = effective.deployPlan.configured && effective.deployPlan.kind === "webhook"
      ? effective.deployPlan
      : undefined;
    if (saved || environmentWebhook) {
      return releaseSettingsStatus({
        ...(saved ? { saved } : {}),
        environment: {
          webhookUrl: environmentWebhook?.url,
          webhookToken: effective.webhookToken,
          publicOrigin: releaseCallbackOrigin || publicOrigin,
        },
      });
    }
    return {
      source: effective.source,
      configured: effective.deployPlan.configured && effective.deployPlan.kind !== "unsupported",
      webhookUrl: null,
      tokenConfigured: false,
      publicOrigin: null,
      updatedAt: null,
    };
  }

  registerAccountAdminRoutes(app, {
    currentUser: (request) => auth.user(request),
    isAdmin: (userId) => identities.isAdmin(userId),
    accounts: new AccountService(db),
    releaseSettings,
    releaseSettingsProjection,
    credentialWrites,
  });

  registerCredentialRoutes(app, {
    currentUser: (request) => auth.user(request),
    vaultKeyFor,
    vault,
    credentialWrites,
    modelDefaults,
    providerProbe,
    providerProbeDisabled,
    resetDecisionCircuitBreakers,
  });

  registerAssistantRoutes(app, {
    currentUser: (request) => auth.user(request),
    requestLocale,
    vaultKeyFor,
    providerAvailability: (vaultKey) => vault.providerAvailability(vaultKey),
    getCredential: (vaultKey, provider) => vault.get(vaultKey, provider),
    modelCatalog,
    defaultDeveloper: modelDefaults.developer,
    requirementRefinements,
    piAssistantQuestions,
    workerRequest,
  });

  registerModelRoutes(app, {
    vaultKeyFor,
    providerAvailability: (vaultKey) => vault.providerAvailability(vaultKey),
    credentialStatus: (vaultKey) => vault.status(vaultKey),
    modelCatalog,
    modelDefaults,
    demoMode,
    piVersion: process.env.PI_VERSION || "1.6.0",
    realRunsEnabled,
    internalTokenConfigured: Boolean(internalToken),
    mergeRequestConfigured: mergeRequestConfig.configured,
    releaseConfigured: () => {
      const releaseRuntime = effectiveReleaseConfig("staging");
      const releasePlan = releaseRuntime.deployPlan;
      return releasePlan.configured
        && releasePlan.kind !== "unsupported"
        && (releasePlan.kind !== "webhook" || Boolean(releaseRuntime.webhookToken && releaseRuntime.callbackOrigin));
    },
    decisionEngineStatus: async (vaultKey) => {
      const loaded = loadDecisionEngineConfig(process.env, { allowMissingApiKey: true });
      const decisionVaultKey = loaded.ok && loaded.config.engine === "jev" ? await hasVaultDecisionKey(vaultKey) : false;
      return decisionEngineStatus(loaded, { vaultKey: decisionVaultKey });
    },
  });

}
