import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { SCOPE, authHandler } from "./auth";
import { mcpHandler } from "./mcp";
import { tokenStore } from "./token-store";

export { GarminTokenStore } from "./token-store";

const DAY = 24 * 60 * 60;

// The provider's metadata names the public origin, so build one per origin.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler: authHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        resource_name: "Garmin Connect",
      },
      // Claude stays connected as long as it uses the server at least every 90 days.
      refreshTokenTTL: 90 * DAY,
      refreshTokenIdleTTL: 90 * DAY,
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },

  // Daily: refresh the Garmin token if due and record whether Garmin still answers.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(tokenStore(env).healthCheck());
  },
} satisfies ExportedHandler<Env>;
