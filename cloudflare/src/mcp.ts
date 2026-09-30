import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { GarminAuthError, GarminClient } from "./garmin";
import { endpointsFrom, tokenStore, type SessionResult } from "./token-store";
import { registerTools } from "./tools";

const DEFAULT_MAX_RANGE_DAYS = 31;
const DEFAULT_MAX_SLEEP_NIGHTS = 14;

export const mcpHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }
    const origin = new URL(request.url).origin;
    const setupHint =
      `To fix it, run garmin-mcp-auth on your computer, then open ${origin}/setup, ` +
      "enter your passcode and paste the new token.";
    const store = tokenStore(env);
    const unwrap = (result: SessionResult) => {
      if (result.ok) return result.session;
      throw new GarminAuthError(
        result.code === "not_connected"
          ? `Garmin is not connected yet. ${setupHint}`
          : `The Garmin sign-in expired or was revoked (${result.message}). ${setupHint}`,
      );
    };
    const client = new GarminClient(
      endpointsFrom(env),
      async () => unwrap(await store.session()),
      async (failedToken) => unwrap(await store.afterUnauthorized(failedToken)),
    );

    const timeZone = env.TIMEZONE || "UTC";
    const maxRangeDays = Number(env.MAX_RANGE_DAYS) || DEFAULT_MAX_RANGE_DAYS;
    const maxSleepNights = Number(env.MAX_SLEEP_NIGHTS) || DEFAULT_MAX_SLEEP_NIGHTS;
    const server = new McpServer(
      { name: "garmin-mcp", version: env.VERSION || "0.0.0" },
      {
        instructions:
          `Garmin Connect sleep and recovery data. Dates are YYYY-MM-DD in the user's time zone ` +
          `(${timeZone}); "today" means today's date there. Garmin files each night's sleep, HRV ` +
          `and overnight readings under the date the user woke up.`,
      },
    );
    registerTools(server, client, { timeZone, maxRangeDays, maxSleepNights, setupHint });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
