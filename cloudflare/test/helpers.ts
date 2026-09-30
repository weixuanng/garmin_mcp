import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { vi } from "vitest";
import { GarminClient } from "../src/garmin";
import { registerTools } from "../src/tools";

const ENDPOINTS = { connectApi: "https://connectapi.test", diTokenUrl: "https://diauth.test/token" };

function routeKey(url: URL): string {
  const params = [...url.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return params.length ? `${url.pathname}?${new URLSearchParams(params)}` : url.pathname;
}

/** Call one tool with Garmin answering from `routes` (path?sorted-query -> payload). */
export async function callTool(
  routes: Record<string, unknown>,
  tool: string,
  args: Record<string, unknown>,
  options: { maxRangeDays: number; maxSleepNights: number } = { maxRangeDays: 90, maxSleepNights: 90 },
): Promise<{ text: string; requests: string[] }> {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const key = routeKey(new URL(String(input instanceof Request ? input.url : input)));
    requests.push(key);
    const payload = routes[key];
    return payload === undefined ? new Response(null, { status: 204 }) : Response.json(payload);
  });
  const session = { accessToken: "token", displayName: "tester" };
  const client = new GarminClient(ENDPOINTS, async () => session, async () => session);
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, client, { timeZone: "Asia/Singapore", setupHint: "SETUP", ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientSide);
  const result = await mcp.callTool({ name: tool, arguments: args });
  await mcp.close();
  const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join("");
  return { text, requests: [...new Set(requests)].sort() };
}
