// Bindings that `wrangler types` can't see from wrangler.jsonc.
interface Env {
  /** Secret: passcode for the connect and /setup pages. */
  SETUP_PASSCODE?: string;
  /** Test-only overrides for the Garmin endpoints. */
  GARMIN_CONNECT_API?: string;
  GARMIN_DI_TOKEN_URL?: string;
}
