import { afterEach, describe, expect, it, vi } from "vitest";
import { round } from "../src/curate";
import {
  GarminApiError,
  GarminAuthError,
  GarminClient,
  expiresSoon,
  parseTokenInput,
  readApiResponse,
  refreshTokens,
} from "../src/garmin";
import { callTool } from "./helpers";

const ENDPOINTS = { connectApi: "https://connectapi.test", diTokenUrl: "https://diauth.test/token" };

function jwt(payload: Record<string, unknown>): string {
  const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

afterEach(() => vi.unstubAllGlobals());

describe("round", () => {
  it("matches Python's round()", () => {
    expect(round(14.25, 1)).toBe(14.2); // exact tie, to even
    expect(round(26.25, 1)).toBe(26.2);
    expect(round(0.15, 1)).toBe(0.1); // 0.15 is really 0.1499...
    expect(round(2.675, 2)).toBe(2.67);
    expect(round(53.375, 1)).toBe(53.4);
    expect(round(0.5)).toBe(0);
    expect(round(1.5)).toBe(2);
    expect(round(-1.25, 1)).toBe(-1.2);
    expect(round(7.166666, 1)).toBe(7.2);
  });
});

describe("parseTokenInput", () => {
  const tokens = { di_token: "a.b.c", di_refresh_token: "r", di_client_id: "GARMIN_CONNECT_MOBILE_ANDROID_DI" };

  it("accepts garmin_tokens.json", () => {
    expect(parseTokenInput(`  ${JSON.stringify(tokens)}\n`)).toEqual(tokens);
  });

  it("accepts the base64 file", () => {
    expect(parseTokenInput(btoa(JSON.stringify(tokens)))).toEqual(tokens);
  });

  it("rejects junk and legacy files", () => {
    expect(() => parseTokenInput("")).toThrow(GarminAuthError);
    expect(() => parseTokenInput("not a token")).toThrow(/garmin_tokens.json/);
    expect(() => parseTokenInput('{"oauth_token": "legacy"}')).toThrow(/no di_token/);
  });
});

describe("expiresSoon", () => {
  it("uses the JWT exp with a 15 minute margin", () => {
    const now = 1_800_000_000;
    expect(expiresSoon(jwt({ exp: now + 3600 }), now)).toBe(false);
    expect(expiresSoon(jwt({ exp: now + 600 }), now)).toBe(true);
    expect(expiresSoon("opaque-token", now)).toBe(false);
  });
});

describe("refreshTokens", () => {
  it("posts the refresh grant like python-garminconnect", async () => {
    let seen: Request | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input, init);
      return Response.json({ access_token: jwt({ client_id: "NEW_CLIENT", exp: 1 }), refresh_token: "r2" });
    });
    const fresh = await refreshTokens({ di_token: "old", di_refresh_token: "r1", di_client_id: "CLIENT" }, ENDPOINTS);
    expect(seen!.url).toBe(ENDPOINTS.diTokenUrl);
    expect(seen!.method).toBe("POST");
    expect(seen!.headers.get("Authorization")).toBe(`Basic ${btoa("CLIENT:")}`);
    expect(seen!.headers.get("User-Agent")).toBe("GCM-Android-5.23");
    expect(Object.fromEntries(new URLSearchParams(await seen!.text()))).toEqual({
      grant_type: "refresh_token",
      client_id: "CLIENT",
      refresh_token: "r1",
    });
    expect(fresh).toEqual({ di_token: expect.any(String), di_refresh_token: "r2", di_client_id: "NEW_CLIENT" });
  });

  it("keeps the old refresh token when Garmin doesn't rotate it", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ access_token: "opaque" }));
    const fresh = await refreshTokens({ di_token: "old", di_refresh_token: "r1", di_client_id: "CLIENT" }, ENDPOINTS);
    expect(fresh).toEqual({ di_token: "opaque", di_refresh_token: "r1", di_client_id: "CLIENT" });
  });

  it("reports a rejected refresh as an auth error", async () => {
    vi.stubGlobal("fetch", async () => new Response("invalid_grant", { status: 400 }));
    await expect(
      refreshTokens({ di_token: "old", di_refresh_token: "r1", di_client_id: "CLIENT" }, ENDPOINTS),
    ).rejects.toThrow(/refresh failed: 400 invalid_grant/);
  });
});

describe("readApiResponse", () => {
  it("formats errors like python-garminconnect", async () => {
    await expect(readApiResponse(Response.json({ message: "boom" }, { status: 500 }))).rejects.toThrow(
      new GarminApiError("API Error 500 - boom", 500),
    );
    await expect(readApiResponse(new Response("nope", { status: 401 }))).rejects.toThrow(GarminAuthError);
    await expect(readApiResponse(new Response("", { status: 429 }))).rejects.toThrow(/rate limit/);
  });

  it("treats 204 and empty bodies as no data", async () => {
    expect(await readApiResponse(new Response(null, { status: 204 }))).toEqual({});
    expect(await readApiResponse(new Response("", { status: 200 }))).toEqual({});
  });
});

describe("GarminClient", () => {
  it("refreshes once on 401 and retries", async () => {
    const tokensUsed: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization")!;
      tokensUsed.push(auth);
      return auth === "Bearer old" ? new Response("expired", { status: 401 }) : Response.json({ ok: true });
    });
    const onUnauthorized = vi.fn(async () => ({ accessToken: "new", displayName: "tester" }));
    const client = new GarminClient(ENDPOINTS, async () => ({ accessToken: "old", displayName: "tester" }), onUnauthorized);
    expect(await client.getHrvData("2026-09-29")).toEqual({ ok: true });
    expect(onUnauthorized).toHaveBeenCalledWith("old");
    expect(tokensUsed).toEqual(["Bearer old", "Bearer new"]);
    // Later calls in the same request keep the fresh token.
    await client.getHrvData("2026-09-28");
    expect(tokensUsed.at(-1)).toBe("Bearer new");
  });
});

describe("tool guard rails", () => {
  const freePlan = { maxRangeDays: 31, maxSleepNights: 14 };

  it("caps sleep ranges at the free-plan limit", async () => {
    const { text, requests } = await callTool({}, "get_sleep_summary_range", {
      start_date: "2026-09-01",
      end_date: "2026-09-29",
    }, freePlan);
    expect(text).toBe("Date range too large (29 days). Maximum is 14 days. Split it into several calls of up to 14 days.");
    expect(requests).toEqual([]);
  });

  it("allows two weeks of sleep", async () => {
    const { requests } = await callTool({}, "get_sleep_summary_range", {
      start_date: "2026-09-16",
      end_date: "2026-09-29",
    }, freePlan);
    expect(requests).toHaveLength(14);
  });

  it("allows a 30-day HRV trend but not 31", async () => {
    const ok = await callTool({}, "get_respiration_trend", { start_date: "2026-08-31", end_date: "2026-09-29" }, freePlan);
    expect(ok.requests).toHaveLength(30);
    const { text } = await callTool({}, "get_hrv_trend", { start_date: "2026-08-01", end_date: "2026-08-31" }, freePlan);
    expect(text).toMatch(/^Date range too large \(31 days\)\. Maximum is 30 days\./);
  });

  it("rejects malformed dates without calling Garmin", async () => {
    const single = await callTool({}, "get_sleep_summary", { date: "2026-02-30" });
    expect(single.text).toBe("Error retrieving sleep summary: Invalid date '2026-02-30'. Use YYYY-MM-DD.");
    expect(single.requests).toEqual([]);
    const range = await callTool({}, "get_hrv_trend", { start_date: "yesterday", end_date: "2026-09-29" });
    expect(range.text).toMatch(/^Invalid date format/);
  });
});

describe("sign-in problems", () => {
  it("reach the user instead of looking like missing data", async () => {
    vi.stubGlobal("fetch", async () => new Response("expired", { status: 401 }));
    const expired = async () => {
      throw new GarminAuthError("The Garmin sign-in expired. Open https://x/setup");
    };
    const client = new GarminClient(ENDPOINTS, async () => ({ accessToken: "t", displayName: "tester" }), expired);
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { registerTools } = await import("../src/tools");
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, client, { timeZone: "UTC", maxRangeDays: 31, maxSleepNights: 14, setupHint: "HINT" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const mcp = new Client({ name: "t", version: "0" });
    await mcp.connect(a);
    for (const [name, args] of [
      ["get_sleep_summary_range", { start_date: "2026-09-27", end_date: "2026-09-29" }],
      ["get_recovery_time_remaining", { date: "2026-09-29" }],
      ["get_spo2_data", { date: "2026-09-29" }],
    ] as const) {
      const result = await mcp.callTool({ name, arguments: args });
      expect((result.content as { text: string }[])[0].text).toMatch(/sign-in expired\. Open https:\/\/x\/setup$/);
    }
  });
});
