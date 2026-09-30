import { DurableObject } from "cloudflare:workers";
import {
  CONNECT_API,
  DI_TOKEN_URL,
  GarminAuthError,
  SOCIAL_PROFILE_PATH,
  connectApiGet,
  expiresSoon,
  isExpired,
  parseTokenInput,
  readApiResponse,
  refreshTokens,
  type Endpoints,
  type GarminSession,
  type GarminTokens,
} from "./garmin";

interface StoredState {
  tokens: GarminTokens;
  displayName: string;
  installedAt: number;
  refreshedAt: number | null;
}

export interface HealthRecord {
  at: number;
  ok: boolean;
  message: string;
}

export type SessionResult =
  | { ok: true; session: GarminSession }
  | { ok: false; code: "not_connected" | "expired"; message: string };

export interface StoreStatus {
  connected: boolean;
  installedAt: number | null;
  refreshedAt: number | null;
  health: HealthRecord | null;
}

const STATE_KEY = "state";
const HEALTH_KEY = "health";
const FAILURES_KEY = "passcode_failures";
const MAX_PASSCODE_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

export function endpointsFrom(env: Env): Endpoints {
  return {
    connectApi: env.GARMIN_CONNECT_API || CONNECT_API,
    diTokenUrl: env.GARMIN_DI_TOKEN_URL || DI_TOKEN_URL,
  };
}

/**
 * The single place Garmin tokens live. A Durable Object serializes refreshes,
 * so parallel tool calls never spend the same refresh token twice.
 */
export class GarminTokenStore extends DurableObject<Env> {
  private refreshing: Promise<StoredState> | null = null;

  private get endpoints(): Endpoints {
    return endpointsFrom(this.env);
  }

  private load(): Promise<StoredState | undefined> {
    return this.ctx.storage.get<StoredState>(STATE_KEY);
  }

  private async recordHealth(ok: boolean, message: string): Promise<void> {
    await this.ctx.storage.put<HealthRecord>(HEALTH_KEY, { at: Date.now(), ok, message });
  }

  private refresh(): Promise<StoredState> {
    this.refreshing ??= (async () => {
      const state = await this.load();
      if (!state) throw new GarminAuthError("No Garmin token stored.");
      state.tokens = await refreshTokens(state.tokens, this.endpoints);
      state.refreshedAt = Date.now();
      await this.ctx.storage.put(STATE_KEY, state);
      return state;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private sessionOf(state: StoredState): SessionResult {
    return { ok: true, session: { accessToken: state.tokens.di_token, displayName: state.displayName } };
  }

  private async expired(error: unknown): Promise<SessionResult> {
    const message = error instanceof Error ? error.message : String(error);
    await this.recordHealth(false, message);
    return { ok: false, code: "expired", message };
  }

  /** A usable access token, refreshed first if it is about to expire. */
  async session(): Promise<SessionResult> {
    const state = await this.load();
    if (!state) {
      return { ok: false, code: "not_connected", message: "No Garmin token has been added yet." };
    }
    if (!expiresSoon(state.tokens.di_token)) return this.sessionOf(state);
    try {
      return this.sessionOf(await this.refresh());
    } catch (error) {
      // A token inside its expiry margin still works; only give up once it is dead.
      if (!isExpired(state.tokens.di_token)) return this.sessionOf(state);
      return this.expired(error);
    }
  }

  /** Called after Garmin answered 401 to `failedToken`. */
  async afterUnauthorized(failedToken: string): Promise<SessionResult> {
    const state = await this.load();
    if (!state) {
      return { ok: false, code: "not_connected", message: "No Garmin token has been added yet." };
    }
    if (state.tokens.di_token !== failedToken) return this.sessionOf(state);
    try {
      return this.sessionOf(await this.refresh());
    } catch (error) {
      return this.expired(error);
    }
  }

  /** Validate and store a token pasted on the setup page. Returns the Garmin display name. */
  async install(raw: string): Promise<{ ok: true; displayName: string } | { ok: false; message: string }> {
    try {
      let tokens = parseTokenInput(raw);
      let refreshedAt: number | null = null;
      if (expiresSoon(tokens.di_token)) {
        tokens = await refreshTokens(tokens, this.endpoints);
        refreshedAt = Date.now();
      }
      const profile = await readApiResponse(
        await connectApiGet(this.endpoints, tokens.di_token, SOCIAL_PROFILE_PATH),
      );
      const displayName = profile?.displayName;
      if (typeof displayName !== "string" || !displayName) {
        throw new GarminAuthError("Garmin accepted the token but returned no profile.");
      }
      await this.ctx.storage.put<StoredState>(STATE_KEY, {
        tokens,
        displayName,
        installedAt: Date.now(),
        refreshedAt,
      });
      await this.recordHealth(true, "Garmin token added.");
      return { ok: true, displayName };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message };
    }
  }

  async status(): Promise<StoreStatus> {
    const [state, health] = await Promise.all([
      this.load(),
      this.ctx.storage.get<HealthRecord>(HEALTH_KEY),
    ]);
    return {
      connected: Boolean(state),
      installedAt: state?.installedAt ?? null,
      refreshedAt: state?.refreshedAt ?? null,
      health: health ?? null,
    };
  }

  /** Daily cron: keep the token fresh and confirm Garmin still answers. */
  async healthCheck(): Promise<HealthRecord> {
    let result = await this.session();
    if (result.ok) {
      try {
        let response = await connectApiGet(this.endpoints, result.session.accessToken, SOCIAL_PROFILE_PATH);
        if (response.status === 401) {
          await response.body?.cancel();
          result = await this.afterUnauthorized(result.session.accessToken);
          if (result.ok) {
            response = await connectApiGet(this.endpoints, result.session.accessToken, SOCIAL_PROFILE_PATH);
          }
        }
        if (result.ok) {
          await readApiResponse(response);
          await this.recordHealth(true, "Garmin answered.");
        }
      } catch (error) {
        await this.recordHealth(false, error instanceof Error ? error.message : String(error));
      }
    }
    if (!result.ok && result.code === "not_connected") {
      await this.recordHealth(false, result.message);
    }
    return (await this.ctx.storage.get<HealthRecord>(HEALTH_KEY))!;
  }

  // --- passcode brute-force lockout ---

  async passcodeLocked(): Promise<boolean> {
    const failures = await this.ctx.storage.get<{ count: number; since: number }>(FAILURES_KEY);
    if (!failures) return false;
    if (Date.now() - failures.since > LOCKOUT_MS) {
      await this.ctx.storage.delete(FAILURES_KEY);
      return false;
    }
    return failures.count >= MAX_PASSCODE_FAILURES;
  }

  async recordPasscodeFailure(): Promise<void> {
    const failures = await this.ctx.storage.get<{ count: number; since: number }>(FAILURES_KEY);
    const fresh = !failures || Date.now() - failures.since > LOCKOUT_MS;
    await this.ctx.storage.put(FAILURES_KEY, {
      count: fresh ? 1 : failures.count + 1,
      since: fresh ? Date.now() : failures.since,
    });
  }

  async clearPasscodeFailures(): Promise<void> {
    await this.ctx.storage.delete(FAILURES_KEY);
  }
}

export function tokenStore(env: Env): DurableObjectStub<GarminTokenStore> {
  return env.GARMIN_TOKENS.get(env.GARMIN_TOKENS.idFromName("owner"));
}
