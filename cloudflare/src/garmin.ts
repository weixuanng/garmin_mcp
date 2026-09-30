// Garmin Connect API access, ported from python-garminconnect (client.py).
// Login itself (email/password/MFA) stays on the user's computer via
// `garmin-mcp-auth`; this Worker only uses and refreshes the saved DI tokens.

export const CONNECT_API = "https://connectapi.garmin.com";
export const DI_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";

const NATIVE_API_USER_AGENT = "GCM-Android-5.23";
const NATIVE_X_GARMIN_USER_AGENT =
  "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0";

const REQUEST_TIMEOUT_MS = 20_000;
// Refresh this long before the access token's `exp`, as client.py does.
const EXPIRY_MARGIN_S = 900;

export interface GarminTokens {
  di_token: string;
  di_refresh_token: string | null;
  di_client_id: string | null;
}

export interface Endpoints {
  connectApi: string;
  diTokenUrl: string;
}

export class GarminAuthError extends Error {
  override name = "GarminAuthError";
}

export class GarminApiError extends Error {
  override name = "GarminApiError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function nativeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "User-Agent": NATIVE_API_USER_AGENT,
    "X-Garmin-User-Agent": NATIVE_X_GARMIN_USER_AGENT,
    "X-Garmin-Paired-App-Version": "10861",
    "X-Garmin-Client-Platform": "Android",
    "X-App-Ver": "10861",
    "X-Lang": "en",
    "X-GCExperience": "GC5",
    "Accept-Language": "en-US,en;q=0.9",
    ...extra,
  };
}

function base64UrlDecode(segment: string): string {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export function jwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
}

/** Seconds since epoch when the access token expires, if it says. */
export function tokenExpiry(token: string): number | null {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp : null;
}

export function expiresSoon(token: string, nowS = Date.now() / 1000): boolean {
  const exp = tokenExpiry(token);
  return exp !== null && nowS > exp - EXPIRY_MARGIN_S;
}

export function isExpired(token: string, nowS = Date.now() / 1000): boolean {
  const exp = tokenExpiry(token);
  return exp !== null && nowS >= exp;
}

/**
 * Accept what `garmin-mcp-auth` writes: the JSON in garmin_tokens.json, or the
 * base64 of that JSON in ~/.garminconnect_base64.
 */
export function parseTokenInput(raw: string): GarminTokens {
  const text = raw.trim();
  if (!text) throw new GarminAuthError("The Garmin token is empty.");
  let json: string = text;
  if (!text.startsWith("{")) {
    try {
      json = atob(text.replace(/\s+/g, ""));
    } catch {
      throw new GarminAuthError("That doesn't look like a Garmin token. Paste the contents of garmin_tokens.json.");
    }
  }
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new GarminAuthError("That doesn't look like a Garmin token. Paste the contents of garmin_tokens.json.");
  }
  if (!data || typeof data.di_token !== "string" || !data.di_token) {
    throw new GarminAuthError(
      "This token file has no di_token. Re-run garmin-mcp-auth with the latest version and paste the new garmin_tokens.json.",
    );
  }
  return {
    di_token: data.di_token,
    di_refresh_token: typeof data.di_refresh_token === "string" ? data.di_refresh_token : null,
    di_client_id: typeof data.di_client_id === "string" ? data.di_client_id : null,
  };
}

/** client.py `_refresh_di_token`. Returns the new token set. */
export async function refreshTokens(tokens: GarminTokens, endpoints: Endpoints): Promise<GarminTokens> {
  if (!tokens.di_refresh_token || !tokens.di_client_id) {
    throw new GarminAuthError("No Garmin refresh token available.");
  }
  const response = await fetch(endpoints.diTokenUrl, {
    method: "POST",
    headers: nativeHeaders({
      Authorization: "Basic " + btoa(`${tokens.di_client_id}:`),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    }),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: tokens.di_client_id,
      refresh_token: tokens.di_refresh_token,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new GarminAuthError(`Garmin token refresh failed: ${response.status} ${body}`);
  }
  const data: any = await response.json();
  if (typeof data?.access_token !== "string") {
    throw new GarminAuthError("Garmin token refresh returned no access token.");
  }
  const clientId = jwtPayload(data.access_token)?.client_id;
  return {
    di_token: data.access_token,
    di_refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : tokens.di_refresh_token,
    di_client_id: typeof clientId === "string" && clientId ? clientId : tokens.di_client_id,
  };
}

export type QueryParams = Record<string, string | number>;

/** One authenticated GET against connectapi, as client.py `_run_request`. */
export async function connectApiGet(
  endpoints: Endpoints,
  accessToken: string,
  path: string,
  params?: QueryParams,
): Promise<Response> {
  const url = new URL(endpoints.connectApi + path);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
  return fetch(url, {
    headers: nativeHeaders({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Turn a connectapi response into parsed JSON or a Garmin-style error. */
export async function readApiResponse(response: Response): Promise<any> {
  if (response.status === 204) return {};
  if (response.status >= 400) {
    const text = await response.text();
    let message = `API Error ${response.status}`;
    try {
      const data = JSON.parse(text);
      const detail = data && typeof data === "object" ? data.message || data.content : null;
      message += detail ? ` - ${detail}` : ` - ${JSON.stringify(data)}`;
    } catch {
      if (text.length < 500) message += ` - ${text}`;
    }
    if (response.status === 401) {
      throw new GarminAuthError(`Garmin authentication failed: ${message}`);
    }
    if (response.status === 429) {
      throw new GarminApiError(`Garmin rate limit hit: ${message}. Wait a few minutes before retrying.`, 429);
    }
    throw new GarminApiError(message, response.status);
  }
  const text = await response.text();
  if (!text.trim()) return {};
  return JSON.parse(text);
}

export interface GarminSession {
  accessToken: string;
  displayName: string;
}

/**
 * The per-request Garmin client used by the tools. `getSession` and
 * `onUnauthorized` come from the token store, which serializes refreshes.
 */
export class GarminClient {
  private session: Promise<GarminSession> | null = null;

  constructor(
    private readonly endpoints: Endpoints,
    private readonly getSession: () => Promise<GarminSession>,
    private readonly onUnauthorized: (failedToken: string) => Promise<GarminSession>,
  ) {}

  private current(): Promise<GarminSession> {
    this.session ??= this.getSession().catch((error) => {
      this.session = null;
      throw error;
    });
    return this.session;
  }

  async displayName(): Promise<string> {
    return (await this.current()).displayName;
  }

  async get(path: string, params?: QueryParams): Promise<any> {
    const session = await this.current();
    let response = await connectApiGet(this.endpoints, session.accessToken, path, params);
    if (response.status === 401) {
      // Retry once with a refreshed token, as client.py does.
      await response.body?.cancel();
      const fresh = this.onUnauthorized(session.accessToken);
      this.session = fresh;
      response = await connectApiGet(this.endpoints, (await fresh).accessToken, path, params);
    }
    return readApiResponse(response);
  }

  // --- garminconnect Garmin.* methods used by the sleep/recovery tools ---

  async getSleepData(date: string) {
    return this.get(`/wellness-service/wellness/dailySleepData/${await this.displayName()}`, {
      date,
      nonSleepBufferMinutes: 60,
    });
  }

  getTrainingReadiness(date: string) {
    return this.get(`/metrics-service/metrics/trainingreadiness/${date}`);
  }

  getBodyBattery(startDate: string, endDate: string) {
    return this.get("/wellness-service/wellness/bodyBattery/reports/daily", { startDate, endDate });
  }

  getBodyBatteryEvents(date: string) {
    return this.get(`/wellness-service/wellness/bodyBattery/events/${date}`);
  }

  async getRhrDay(date: string) {
    return this.get(`/userstats-service/wellness/daily/${await this.displayName()}`, {
      fromDate: date,
      untilDate: date,
      metricId: 60,
    });
  }

  async getHeartRates(date: string) {
    return this.get(`/wellness-service/wellness/dailyHeartRate/${await this.displayName()}`, { date });
  }

  getStressData(date: string) {
    return this.get(`/wellness-service/wellness/dailyStress/${date}`);
  }

  getRespirationData(date: string) {
    return this.get(`/wellness-service/wellness/daily/respiration/${date}`);
  }

  getSpo2Data(date: string) {
    return this.get(`/wellness-service/wellness/daily/spo2/${date}`);
  }

  getHrvData(date: string) {
    return this.get(`/hrv-service/hrv/${date}`);
  }

  getActivities(start = 0, limit = 20) {
    return this.get("/activitylist-service/activities/search/activities", { start, limit });
  }
}

export const SOCIAL_PROFILE_PATH = "/userprofile-service/socialProfile";
