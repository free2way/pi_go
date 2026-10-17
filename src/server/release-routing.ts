import type { ReleaseWebhookSettings } from "./release-settings.js";

export type ReleaseEnvironment = "staging" | "production";

export interface ReleaseRoute {
  webhookUrl: string | undefined;
  webhookToken: string;
  source: "web" | "environment" | "none";
  environmentSpecific: boolean;
}

function present(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

/**
 * Resolve one environment as an atomic URL/token pair. An environment-specific
 * URL never borrows the legacy token: a half-configured route must fail closed
 * instead of accidentally authenticating to the wrong Executor.
 */
export function resolveReleaseRoute(input: {
  environment: ReleaseEnvironment;
  saved?: ReleaseWebhookSettings;
  variables: NodeJS.ProcessEnv;
}): ReleaseRoute {
  if (input.saved) {
    return {
      webhookUrl: present(input.saved.webhookUrl),
      webhookToken: present(input.saved.webhookToken) ?? "",
      source: "web",
      environmentSpecific: false,
    };
  }

  const prefix = input.environment === "staging" ? "PI_STAGING_DEPLOY" : "PI_PRODUCTION_DEPLOY";
  const specificUrl = present(input.variables[`${prefix}_HOOK`]);
  if (specificUrl) {
    return {
      webhookUrl: specificUrl,
      webhookToken: present(input.variables[`${prefix}_TOKEN`]) ?? "",
      source: "environment",
      environmentSpecific: true,
    };
  }

  const webhookUrl = present(input.variables.PI_POST_MERGE_DEPLOY_HOOK);
  return {
    webhookUrl,
    webhookToken: webhookUrl ? present(input.variables.PI_POST_MERGE_DEPLOY_TOKEN) ?? "" : "",
    source: webhookUrl ? "environment" : "none",
    environmentSpecific: false,
  };
}

/** Callback endpoints accept the active saved token plus configured route tokens. */
export function releaseCallbackTokens(saved: ReleaseWebhookSettings | undefined, variables: NodeJS.ProcessEnv) {
  return [...new Set([
    present(saved?.webhookToken),
    present(variables.PI_STAGING_DEPLOY_TOKEN),
    present(variables.PI_PRODUCTION_DEPLOY_TOKEN),
    present(variables.PI_POST_MERGE_DEPLOY_TOKEN),
  ].filter((value): value is string => Boolean(value)))];
}
