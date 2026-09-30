// End-to-end check of the Worker in the real Workers runtime (wrangler dev):
// the claude.ai connector flow (register, consent with passcode and Garmin
// token, code exchange), MCP tool calls, 401 refresh, /setup, /health, cron.
// Garmin is replaced by a local fake. Run: npm run test:e2e
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import assert from "node:assert/strict";

const WORKER_PORT = 8787;
const GARMIN_PORT = 8790;
const BASE = `http://localhost:${WORKER_PORT}`;
const PASSCODE = "e2e-passcode-123";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

// --- fake Garmin -----------------------------------------------------------

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload) => `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
const now = () => Math.floor(Date.now() / 1000);

const garmin = {
  validAccess: new Set(),
  refreshTokens: new Set(["refresh-1"]),
  refreshCalls: 0,
  issue() {
    const access = jwt({ client_id: "GARMIN_CONNECT_MOBILE_ANDROID_DI", exp: now() + 3600, n: randomBytes(4).toString("hex") });
    const refresh = `refresh-${randomBytes(4).toString("hex")}`;
    this.validAccess.add(access);
    this.refreshTokens.add(refresh);
    return { access, refresh };
  },
};

const SLEEP = {
  dailySleepDTO: {
    sleepTimeSeconds: 27000,
    deepSleepSeconds: 5400,
    lightSleepSeconds: 14400,
    remSleepSeconds: 7200,
    sleepScores: { overall: { value: 84, qualifierKey: "GOOD" } },
  },
  avgOvernightHrv: 51,
};

const garminServer = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  if (url.pathname === "/di/token" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      garmin.refreshCalls++;
      const auth = req.headers.authorization ?? "";
      if (auth !== `Basic ${Buffer.from("GARMIN_CONNECT_MOBILE_ANDROID_DI:").toString("base64")}`) return send(401, { error: "bad client" });
      if (!garmin.refreshTokens.delete(form.get("refresh_token"))) return send(400, { error: "invalid_grant" });
      const { access, refresh } = garmin.issue();
      send(200, { access_token: access, refresh_token: refresh, expires_in: 3600 });
    });
    return;
  }
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!garmin.validAccess.has(bearer)) return send(401, { message: "Unauthorized" });
  if (req.headers["user-agent"] !== "GCM-Android-5.23") return send(403, { message: "bad agent" });
  if (url.pathname === "/userprofile-service/socialProfile") return send(200, { displayName: "tester", fullName: "Test User" });
  if (url.pathname === "/wellness-service/wellness/dailySleepData/tester") {
    return url.searchParams.get("date") === "2026-09-29" ? send(200, SLEEP) : send(204);
  }
  send(204);
});

// --- helpers -----------------------------------------------------------------

const cookies = new Map();
function remember(response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [name, value] = pair.split("=");
    if (value) cookies.set(name, value);
    else cookies.delete(name);
  }
}
async function browser(path, init = {}) {
  const headers = new Headers(init.headers);
  if (cookies.size) headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
  const response = await fetch(new URL(path, BASE), { ...init, headers, redirect: "manual" });
  remember(response);
  return response;
}
const form = (fields) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields),
});

let rpcId = 0;
async function mcp(accessToken, method, params) {
  const response = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.equal(response.status, 200, `MCP ${method} answered ${response.status}: ${await response.clone().text()}`);
  return (await response.json()).result;
}
const toolText = async (token, name, args) =>
  (await mcp(token, "tools/call", { name, arguments: args })).content.map((c) => c.text).join("");

async function waitFor(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// --- run ---------------------------------------------------------------------

await new Promise((resolve) => garminServer.listen(GARMIN_PORT, "127.0.0.1", resolve));
const wrangler = spawn(
  "node_modules/.bin/wrangler",
  [
    "dev", "--port", String(WORKER_PORT), "--test-scheduled", "--persist-to", `.wrangler/e2e-${Date.now()}`,
    "--var", `GARMIN_CONNECT_API:http://127.0.0.1:${GARMIN_PORT}`,
    "--var", `GARMIN_DI_TOKEN_URL:http://127.0.0.1:${GARMIN_PORT}/di/token`,
    "--var", `SETUP_PASSCODE:${PASSCODE}`,
  ],
  // Own process group, so cleanup also stops workerd.
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, detached: true },
);
let log = "";
wrangler.stdout.on("data", (d) => (log += d));
wrangler.stderr.on("data", (d) => (log += d));

const steps = [];
const step = async (name, fn) => {
  await fn();
  steps.push(name);
  console.log(`  ok  ${name}`);
};

try {
  await waitFor(async () => (await fetch(`${BASE}/`)).ok, "wrangler dev");

  await step("health reports no Garmin token yet", async () => {
    const response = await fetch(`${BASE}/health`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).garmin_connected, false);
  });

  await step("MCP requires an OAuth token", async () => {
    const response = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("WWW-Authenticate") ?? "", /resource_metadata=/);
  });

  // claude.ai: dynamic client registration + PKCE
  const registration = await (await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  })).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizePath = `/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    scope: "garmin:read",
    resource: `${BASE}/mcp`,
  })}`;

  let handle;
  await step("consent page asks for passcode and Garmin token", async () => {
    const response = await browser(authorizePath);
    const html = await response.text();
    assert.equal(response.status, 200, html);
    assert.match(html, /name="passcode"/);
    assert.match(html, /<textarea name="token"[^>]*required/);
    handle = html.match(/name="handle" value="([^"]+)"/)[1];
  });

  await step("Deny sends Claude back with access_denied", async () => {
    const page = await browser(authorizePath);
    const denyHandle = (await page.text()).match(/name="handle" value="([^"]+)"/)[1];
    const response = await browser(authorizePath, form({ handle: denyHandle, decision: "deny" }));
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("Location"));
    assert.equal(location.searchParams.get("error"), "access_denied");
    assert.equal(location.searchParams.get("state"), "state-123");
  });

  await step("rejects other redirect targets", async () => {
    const evil = await (await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Evil", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }),
    })).json();
    const response = await fetch(`${BASE}/authorize?${new URLSearchParams({
      response_type: "code", client_id: evil.client_id, redirect_uri: "https://evil.example/cb",
      code_challenge: challenge, code_challenge_method: "S256", state: "s",
    })}`);
    assert.equal(response.status, 403);
  });

  // The token garmin-mcp-auth would write; its access token is about to expire.
  const pasted = JSON.stringify({
    di_token: jwt({ client_id: "GARMIN_CONNECT_MOBILE_ANDROID_DI", exp: now() + 60 }),
    di_refresh_token: "refresh-1",
    di_client_id: "GARMIN_CONNECT_MOBILE_ANDROID_DI",
  });

  await step("wrong passcode is refused and the form can be retried", async () => {
    const response = await browser(authorizePath, form({ handle, decision: "approve", passcode: "wrong-passcode", token: pasted }));
    assert.equal(response.status, 400);
    assert.match(await response.text(), /passcode is wrong/);
  });

  let code;
  await step("right passcode + token completes the connection", async () => {
    const response = await browser(authorizePath, form({ handle, decision: "approve", passcode: PASSCODE, token: pasted }));
    assert.equal(response.status, 302, await response.text());
    const location = new URL(response.headers.get("Location"));
    assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
    assert.equal(location.searchParams.get("state"), "state-123");
    code = location.searchParams.get("code");
    assert.ok(code);
    assert.equal(garmin.refreshCalls, 1, "expiring pasted token was refreshed on install");
  });

  let accessToken;
  await step("code exchanges for a Claude access token", async () => {
    const response = await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: REDIRECT,
        client_id: registration.client_id, code_verifier: verifier, resource: `${BASE}/mcp`,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    accessToken = body.access_token;
  });

  await step("MCP initialize + tools/list", async () => {
    const init = await mcp(accessToken, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" },
    });
    assert.match(init.instructions, /Asia\/Singapore/);
    const { tools } = await mcp(accessToken, "tools/list", {});
    assert.equal(tools.length, 16);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  });

  await step("get_sleep_summary returns curated data", async () => {
    const summary = JSON.parse(await toolText(accessToken, "get_sleep_summary", { date: "2026-09-29" }));
    assert.deepEqual(summary, {
      sleep_seconds: 27000, deep_sleep_seconds: 5400, light_sleep_seconds: 14400, rem_sleep_seconds: 7200,
      sleep_score: 84, sleep_score_qualifier: "GOOD", avg_overnight_hrv: 51,
      deep_sleep_percent: 20, light_sleep_percent: 53.3, rem_sleep_percent: 26.7, sleep_hours: 7.5,
    });
    assert.equal(await toolText(accessToken, "get_sleep_summary", { date: "2026-09-28" }), "No sleep summary found for 2026-09-28");
  });

  await step("a revoked Garmin access token is refreshed and retried", async () => {
    garmin.validAccess.clear();
    const before = garmin.refreshCalls;
    const summary = JSON.parse(await toolText(accessToken, "get_sleep_summary", { date: "2026-09-29" }));
    assert.equal(summary.sleep_score, 84);
    assert.equal(garmin.refreshCalls, before + 1);
  });

  await step("parallel 401s share one refresh", async () => {
    garmin.validAccess.clear();
    const before = garmin.refreshCalls;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => toolText(accessToken, "get_sleep_summary", { date: "2026-09-29" })),
    );
    assert.ok(results.every((r) => JSON.parse(r).sleep_score === 84), results.join("\n"));
    assert.equal(garmin.refreshCalls, before + 1);
  });

  await step("a dead Garmin sign-in tells the user how to fix it", async () => {
    garmin.validAccess.clear();
    garmin.refreshTokens.clear();
    const text = await toolText(accessToken, "get_sleep_summary", { date: "2026-09-29" });
    assert.match(text, /^Error retrieving sleep summary: The Garmin sign-in expired or was revoked .* open http:\/\/localhost:8787\/setup/);
  });

  await step("/setup replaces the Garmin token", async () => {
    const wrong = await browser("/setup", form({ passcode: "nope-nope", token: "{}" }));
    assert.equal(wrong.status, 400);
    const { access, refresh } = garmin.issue();
    const fresh = JSON.stringify({ di_token: access, di_refresh_token: refresh, di_client_id: "GARMIN_CONNECT_MOBILE_ANDROID_DI" });
    const response = await browser("/setup", form({ passcode: PASSCODE, token: Buffer.from(fresh).toString("base64") }));
    assert.match(await response.text(), /Connected to Garmin as tester/);
    const summary = JSON.parse(await toolText(accessToken, "get_sleep_summary", { date: "2026-09-29" }));
    assert.equal(summary.sleep_score, 84);
  });

  await step("daily cron records health", async () => {
    await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent("7 23 * * *")}`);
    await waitFor(async () => {
      const body = await (await fetch(`${BASE}/health`)).json();
      return body.ok && body.last_check_message === "Garmin answered.";
    }, "cron health record", 10_000);
  });

  await step("passcode lockout after 10 wrong tries", async () => {
    for (let i = 0; i < 10; i++) await browser("/setup", form({ passcode: `wrong-${i}-xx`, token: "x" }));
    const response = await browser("/setup", form({ passcode: PASSCODE, token: "x" }));
    assert.match(await response.text(), /Too many wrong passcodes/);
  });

  console.log(`\nE2E passed: ${steps.length} steps.`);
} catch (error) {
  console.error(`\nE2E FAILED after: ${steps.join(", ") || "(start)"}\n`, error);
  console.error("\n--- wrangler dev output ---\n" + log.slice(-6000));
  process.exitCode = 1;
} finally {
  try {
    process.kill(-wrangler.pid, "SIGTERM");
  } catch {}
  garminServer.closeAllConnections();
  garminServer.close();
  process.exit();
}
