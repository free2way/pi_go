import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  ConfigStatus,
  CredentialStatus,
  ModelCatalogEntry,
  ModelCatalogResponse,
  ModelSelection,
  ProviderAvailability,
} from "../../shared/types.js";
import { availableModels } from "../model-catalog.js";
import type { DecisionEngineStatus } from "../decision-routes.js";

export interface ModelRouteDependencies {
  vaultKeyFor: (request: FastifyRequest) => string;
  providerAvailability: (vaultKey: string) => ProviderAvailability[];
  credentialStatus: (vaultKey: string) => CredentialStatus;
  modelCatalog: ModelCatalogEntry[];
  modelDefaults: { developer: ModelSelection; reviewer: ModelSelection };
  demoMode: boolean;
  piVersion: string;
  realRunsEnabled: boolean;
  internalTokenConfigured: boolean;
  mergeRequestConfigured: boolean;
  releaseConfigured: () => boolean;
  decisionEngineStatus: (vaultKey: string) => Promise<DecisionEngineStatus>;
}

/** Read-only model catalogue and execution-configuration projections. */
export function registerModelRoutes(app: FastifyInstance, deps: ModelRouteDependencies) {
  app.get("/api/models", async (request): Promise<ModelCatalogResponse> => {
    const availability = deps.providerAvailability(deps.vaultKeyFor(request));
    return {
      models: availableModels(deps.modelCatalog, availability),
      defaultDeveloper: deps.modelDefaults.developer,
      defaultReviewer: deps.modelDefaults.reviewer,
      // Runtime verification is projected without exposing credential values.
      verifiedProviders: availability.map((item) => ({
        provider: item.provider,
        verifiedAt: item.verifiedAt,
        verifiedModels: item.verifiedModels,
        verification: item.verification,
        asserted: item.asserted,
        verificationLabel: item.verification === "live" ? "已验证" : item.verification === "operator_asserted" ? "未校验（操作者断言）" : "未校验",
        capabilities: item.capabilities ?? null,
      })),
    };
  });

  app.get("/api/config/status", async (request): Promise<ConfigStatus & { decisionEngine: DecisionEngineStatus }> => {
    const vaultKey = deps.vaultKeyFor(request);
    const credentials = deps.credentialStatus(vaultKey);
    const configured = new Set(credentials.providers.map((item) => item.provider));
    return {
      demoMode: deps.demoMode,
      piVersion: deps.piVersion,
      developer: {
        provider: deps.modelDefaults.developer.provider,
        model: deps.modelDefaults.developer.model,
        credentialConfigured: configured.has(deps.modelDefaults.developer.provider),
      },
      reviewer: {
        provider: deps.modelDefaults.reviewer.provider,
        model: deps.modelDefaults.reviewer.model,
        credentialConfigured: configured.has(deps.modelDefaults.reviewer.provider),
      },
      // Actual per-role combinations are preflighted when a Run is created.
      realRunsAvailable: deps.realRunsEnabled && deps.internalTokenConfigured && configured.size > 0,
      configuredProviders: [...configured],
      verifiedProviders: credentials.providers.filter((item) => item.verification === "live").map((item) => item.provider),
      assertedProviders: credentials.providers.filter((item) => item.verification === "operator_asserted").map((item) => item.provider),
      mergeRequestConfigured: deps.mergeRequestConfigured,
      releaseConfigured: deps.releaseConfigured(),
      decisionEngine: await deps.decisionEngineStatus(vaultKey),
    };
  });
}
