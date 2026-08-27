import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

/**
 * Build the provider/model catalog from the Pi SDK bundled with this agent.
 *
 * The catalog is advertised during registration so the control plane does not
 * need its own (and inevitably stale) copy of Pi's supported model list. Local
 * models.json additions are included as well.
 */
export async function loadModelCatalog(local) {
  const runtime = await ModelRuntime.create({
    authPath: resolve(local.auth, "pi-auth.json"),
    modelsPath: resolve(local.config, "models.json"),
    refreshOnCreate: false,
  });

  const catalog = await Promise.all(
    runtime.getProviders().map(async (provider) => {
      const configured = await runtime.checkAuth(provider.id).catch(() => undefined);
      const auth = [];
      if (provider.auth?.apiKey) auth.push({ type: "api_key", name: provider.auth.apiKey.name, subscription: false });
      if (provider.auth?.oauth) auth.push({ type: "oauth", name: provider.auth.oauth.name, subscription: Boolean(provider.auth.oauth.isSubscription) });
      return {
        id: provider.id,
        name: provider.name,
        auth,
        configured: Boolean(configured),
        configured_auth_type: configured?.type ?? null,
        auth_source: configured?.source ?? null,
        models: runtime.getModels(provider.id).map((model) => ({
          id: model.id,
          name: model.name,
        })),
      };
    }),
  );
  return catalog.filter((provider) => provider.models.length > 0);
}
