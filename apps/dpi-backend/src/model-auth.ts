// Bind a resolved model credential to a provider's API-key auth, so the value never has to live in `process.env`.
//
// The provider's own auth reads `OPENROUTER_API_KEY` from the environment; when OpenBao supplies the key we
// override `resolve` to return it directly. An operator who has not moved to OpenBao keeps the ambient path.
import type { Provider } from "@earendil-works/pi-ai/models";

/**
 * Prefer `key` over the provider's ambient resolution. Returns the provider unchanged when no key is configured,
 * so the environment path still works, and never reads `process.env` itself.
 */
export function bindApiKey(provider: Provider, key: string | undefined): Provider {
  const apiKey = provider.auth.apiKey;
  if (!key || !apiKey) return provider;
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        resolve: async ({ signal }) => {
          signal.throwIfAborted();
          return { auth: { apiKey: key }, source: "OpenBao" };
        },
      },
    },
  };
}
