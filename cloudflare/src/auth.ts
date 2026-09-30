import { AuthorizationError, CimdFetchError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { tokenStore } from "./token-store";

export const SCOPE = "garmin:read";
const ALLOWED_REDIRECT_HOSTS = new Set(["claude.ai", "claude.com"]);
const AUTH_COMMAND =
  "uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth --token-path ~/.garmin_cloud";
const TOKEN_FILE = "~/.garmin_cloud/garmin_tokens.json";

type Env_ = Env & { OAUTH_PROVIDER: OAuthHelpers };

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const withOAuth = env as Env_; // the provider injects OAUTH_PROVIDER
    try {
      if (url.pathname === "/authorize" && request.method === "GET") return await showConsent(request, withOAuth);
      if (url.pathname === "/authorize" && request.method === "POST") return await submitConsent(request, withOAuth);
      if (url.pathname === "/setup" && request.method === "GET") return setupPage();
      if (url.pathname === "/setup" && request.method === "POST") return await submitSetup(request, env);
      if (url.pathname === "/health" && request.method === "GET") return await health(env);
    } catch (error) {
      return authErrorResponse(error);
    }
    if (url.pathname === "/") {
      return page(
        200,
        "Garmin MCP server is running",
        `<p>Add <strong>${escape(url.origin)}/mcp</strong> as a custom connector in Claude.</p>
<p class="muted">To replace an expired Garmin token, open <a href="/setup">${escape(url.origin)}/setup</a>.</p>`,
      );
    }
    return new Response("Not found", { status: 404 });
  },
};

// --- passcode -----------------------------------------------------------------

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Constant-time passcode check. Fails closed when no passcode is configured. */
async function passcodeMatches(env: Env, given: string): Promise<boolean> {
  const expected = env.SETUP_PASSCODE;
  if (!expected || expected.length < 8) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

type PasscodeCheck = { ok: true } | { ok: false; message: string };

async function checkPasscode(env: Env, given: string): Promise<PasscodeCheck> {
  if (!env.SETUP_PASSCODE || env.SETUP_PASSCODE.length < 8) {
    return { ok: false, message: "This server has no passcode set yet. Set the SETUP_PASSCODE secret (8+ characters) in Cloudflare first." };
  }
  const store = tokenStore(env);
  if (await store.passcodeLocked()) {
    return { ok: false, message: "Too many wrong passcodes. Wait 15 minutes and try again." };
  }
  if (!(await passcodeMatches(env, given))) {
    await store.recordPasscodeFailure();
    return { ok: false, message: "That passcode is wrong." };
  }
  await store.clearPasscodeFailures();
  return { ok: true };
}

// --- consent (the claude.ai connector flow) -----------------------------------

async function showConsent(request: Request, env: Env_): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  if (!ALLOWED_REDIRECT_HOSTS.has(new URL(authRequest.redirectUri).hostname)) {
    return page(403, "Not allowed", "<p>This server only accepts connections from Claude.</p>");
  }
  const consent = await oauth.beginConsent(authRequest);
  const { connected } = await tokenStore(env).status();
  const body = consentBody(await oauth.describeConsent(authRequest), consent.handle, connected);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(layout("Connect Claude to Garmin", body), { headers: consent.headers });
}

async function submitConsent(request: Request, env: Env_): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    denied.headers.set("Location", denied.redirectTo);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const store = tokenStore(env);
  const rerender = async (error: string) => {
    // The handle is only consumed on approve/deny, so the same form can be retried.
    const authRequest = await oauth.parseAuthRequest(request);
    const { connected } = await store.status();
    const body = consentBody(await oauth.describeConsent(authRequest), handle, connected, error);
    return html(400, layout("Connect Claude to Garmin", body));
  };

  const passcode = await checkPasscode(env, String(form.get("passcode") ?? ""));
  if (!passcode.ok) return rerender(passcode.message);

  const token = String(form.get("token") ?? "").trim();
  if (token) {
    const installed = await store.install(token);
    if (!installed.ok) return rerender(`Garmin didn't accept that token: ${installed.message}`);
  } else if (!(await store.status()).connected) {
    return rerender("Paste your Garmin token to finish connecting.");
  }

  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: "owner",
    metadata: {},
    scope: [SCOPE],
    props: {},
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

// --- /setup: replace the Garmin token without reconnecting Claude ------------

function setupPage(message?: { error?: string; success?: string }): Response {
  const banner = message?.error
    ? `<p class="error">${escape(message.error)}</p>`
    : message?.success
      ? `<p class="success">${escape(message.success)}</p>`
      : "";
  return html(
    message?.error ? 400 : 200,
    layout(
      "Update Garmin token",
      `${banner}
<p>Use this when Claude says the Garmin sign-in expired. Claude stays connected; only the Garmin token changes.</p>
<form method="post">
  ${passcodeField()}
  ${tokenField(true)}
  <button>Save token</button>
</form>`,
    ),
  );
}

async function submitSetup(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const passcode = await checkPasscode(env, String(form.get("passcode") ?? ""));
  if (!passcode.ok) return setupPage({ error: passcode.message });
  const token = String(form.get("token") ?? "").trim();
  if (!token) return setupPage({ error: "Paste your Garmin token." });
  const installed = await tokenStore(env).install(token);
  if (!installed.ok) return setupPage({ error: `Garmin didn't accept that token: ${installed.message}` });
  return setupPage({ success: `Saved. Connected to Garmin as ${installed.displayName}. You can close this page.` });
}

// --- /health: status for monitoring, no personal data ----------------------

async function health(env: Env): Promise<Response> {
  const status = await tokenStore(env).status();
  const ok = status.connected && (status.health?.ok ?? true);
  return Response.json(
    {
      ok,
      garmin_connected: status.connected,
      last_check: status.health ? new Date(status.health.at).toISOString() : null,
      last_check_ok: status.health?.ok ?? null,
      last_check_message: status.health?.message ?? null,
      token_added: status.installedAt ? new Date(status.installedAt).toISOString() : null,
      token_refreshed: status.refreshedAt ? new Date(status.refreshedAt).toISOString() : null,
      version: env.VERSION ?? null,
    },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

// --- errors -------------------------------------------------------------------

function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) {
    return Response.redirect(error.redirectTo, 302);
  }
  if (error instanceof AuthorizationError) {
    return page(400, "Sign-in failed", `<p>${escape(error.description)} Start connecting again from Claude.</p>`);
  }
  if (error instanceof CimdFetchError) {
    return page(400, "Sign-in failed", "<p>This app could not be verified.</p>");
  }
  throw error;
}

// --- HTML ---------------------------------------------------------------------

export const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function passcodeField(): string {
  return `<label>Passcode
  <input type="password" name="passcode" autocomplete="current-password" required>
</label>`;
}

function tokenField(required: boolean): string {
  return `<label>Garmin token
  <textarea name="token" rows="4" spellcheck="false" autocomplete="off" ${required ? "required" : ""}
    placeholder='{"di_token": "...", "di_refresh_token": "...", "di_client_id": "..."}'></textarea>
</label>
<p class="muted">To create one, run this on your computer (it asks for your Garmin email, password and MFA code):</p>
<pre>${escape(AUTH_COMMAND)}</pre>
<p class="muted">Then paste the contents of <code>${escape(TOKEN_FILE)}</code>.</p>`;
}

function consentBody(
  consent: { clientName: string; clientDomain?: string; redirectHost: string },
  handle: string,
  connected: boolean,
  error?: string,
): string {
  const name = escape(consent.clientName);
  const publisher = consent.clientDomain
    ? `Published by <strong>${escape(consent.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const token = connected
    ? `<details><summary>Replace the Garmin token (optional)</summary>${tokenField(false)}</details>`
    : tokenField(true);
  return `${error ? `<p class="error">${escape(error)}</p>` : ""}
<p><strong>${name}</strong> wants to read your Garmin sleep and recovery data: sleep, HRV, body battery, readiness, stress, respiration and SpO2.</p>
<p class="muted">${publisher} Access will be sent to <strong>${escape(consent.redirectHost)}</strong>.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  ${passcodeField()}
  ${token}
  <button name="decision" value="approve">Allow</button>
  <button name="decision" value="deny" class="secondary" formnovalidate>Deny</button>
</form>`;
}

function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'",
    },
  });
}

function page(status: number, title: string, bodyHtml: string): Response {
  return html(status, layout(escape(title), bodyHtml));
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f5f2; --card: #fff; --text: #1d1d1b; --muted: #6b6a66; --accent: #1d1d1b; --on-accent: #fff; --line: #dedcd6; --error: #b3261e; --success: #1e7b34; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #22221f; --text: #efeee9; --muted: #a3a29c; --accent: #efeee9; --on-accent: #161615; --line: #3a3935; --error: #f2b8b5; --success: #8fd19e; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { box-sizing: border-box; width: min(520px, calc(100% - 32px)); margin: 16px 0; padding: 28px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; }
  h1 { margin: 0 0 12px; font-size: 22px; line-height: 1.3; }
  p { margin: 0 0 12px; }
  .muted { color: var(--muted); font-size: 14px; }
  .error { color: var(--error); font-weight: 600; }
  .success { color: var(--success); font-weight: 600; }
  form { display: grid; gap: 12px; margin-top: 20px; }
  label { display: grid; gap: 6px; font-weight: 600; font-size: 14px; }
  input, textarea { font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); width: 100%; box-sizing: border-box; }
  pre { margin: 0 0 12px; padding: 10px; border-radius: 10px; background: var(--bg); border: 1px solid var(--line); font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  details { font-size: 14px; }
  summary { cursor: pointer; margin-bottom: 8px; }
  button { font: inherit; padding: 12px; border-radius: 10px; border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent); cursor: pointer; }
  button.secondary { background: transparent; color: var(--text); border-color: var(--line); }
</style>
<main>
<h1>${title}</h1>
${body}
</main>
</html>`;
}
