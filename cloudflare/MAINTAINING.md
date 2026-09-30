# Maintaining the Cloudflare port

Runbook for keeping `cloudflare/` in step with upstream and for fixing it when
it breaks. Written for Claude sessions (the owner asking to "update the Garmin
server" or saying "fix"), but it works by hand too.

The Worker is deployed by Cloudflare Workers Builds from `main` (root
directory `cloudflare/`, build command `npm test`). A push to `main` that
passes the tests is a deploy; a push that fails them deploys nothing.

## What can break it

1. **Upstream changes a ported tool** (`src/garmin_mcp/health_wellness.py`,
   `src/garmin_mcp/training.py`): new fields, fixes, new sleep/recovery tools.
2. **Garmin changes its API or sign-in**, which shows up first as a new
   `garminconnect` release (upstream bumps the pin in `pyproject.toml`).
3. **The Garmin token dies** (password change, revoked session). Only the
   owner can fix this: run `garmin-mcp-auth` locally and paste the token at
   `/setup` (see README.md). Claude cannot do it for them.

## Pulling in upstream changes

Run from the repository root, on an up-to-date `main`.

1. Merge upstream into `main`:
   ```bash
   git fetch https://github.com/Taxuspt/garmin_mcp main
   git merge --no-edit FETCH_HEAD
   ```
   Upstream has no `cloudflare/` directory. On a conflict anywhere else, take
   upstream's side (`git checkout --theirs <file>`), since this fork carries no
   other changes; if upstream ever adds its own root `CLAUDE.md`, keep both
   texts in it.
2. If `HEAD` still equals the commit in `UPSTREAM.json` → `garmin_mcp.commit`
   and the `garminconnect` pin is unchanged, stop: nothing to do. Don't commit.
3. See what changed since the recorded commit:
   ```bash
   git log --oneline <recorded>..HEAD -- src/garmin_mcp/health_wellness.py src/garmin_mcp/training.py pyproject.toml
   git diff <recorded>..HEAD -- src/garmin_mcp/health_wellness.py src/garmin_mcp/training.py pyproject.toml
   ```
4. Re-record upstream behaviour and test the port against it:
   ```bash
   uv sync
   uv run python cloudflare/parity/generate_golden.py
   cd cloudflare && npm ci && npm test
   ```
   `test/golden.json` now holds what the new upstream code returns. A failing
   parity case means upstream changed a ported tool's output or the endpoint it
   calls. Port that change into `src/curate.ts`, `src/tools.ts` or
   `src/garmin.ts`, keeping the same logic and wording.
5. Read the diff from step 3 even if the tests pass, because the scenarios only cover
   the paths they exercise:
   - A changed tool description or argument → update it in `src/tools.ts`.
   - A new branch or field in a ported tool → port it and add a case to
     `parity/scenarios.json` that exercises it, then re-run step 4.
   - A **new** tool that reads sleep or recovery data (sleep, HRV, Body
     Battery, readiness, recovery, resting HR, stress, respiration, SpO2, skin
     temperature) → port it, add it to `TOOL_NAMES`, the README table and
     parity scenarios. Skip tools for other areas (activities, workouts,
     nutrition, gear, …) and anything that writes to Garmin.
6. If the `garminconnect` pin changed, compare the two library versions:
   ```bash
   pip download --no-deps garminconnect==<old> garminconnect==<new> -d /tmp/gc
   # unzip both wheels and diff garminconnect/client.py and garminconnect/__init__.py
   ```
   Parity already checks endpoint paths and params (the golden uses the real
   library). Check by hand what it can't: `DI_TOKEN_URL`, `_refresh_di_token`,
   `_native_headers` (user agent and app version), `_run_request` (401 retry,
   204, error text), the token file format (`dumps`/`loads`), and the
   `get_*` methods behind the ported tools. Mirror changes in `src/garmin.ts`.
7. Run everything:
   ```bash
   cd cloudflare && npm run typecheck && npm test && npm run test:e2e
   ```
8. Update `UPSTREAM.json` (`garmin_mcp.commit` = new upstream commit,
   `garminconnect.version`, `last_checked`) and bump `VERSION` in
   `wrangler.jsonc` if the Worker code changed.
9. Commit (merge commit plus port) and get it onto `main`: push directly if
   allowed, otherwise open a pull request into `main` and merge it once its
   checks pass. Workers Builds then tests and deploys.
10. Verify the deploy: with the Cloudflare connector, `workers_get_worker_code`
    for `garmin-mcp` should contain the new `VERSION`. If a Garmin connector is
    available in the session, call `get_sleep_summary` for yesterday.

## Fixing "it's not working"

1. Reproduce: call a Garmin connector tool (e.g. `get_sleep_summary` for
   yesterday) and read the exact error text.
2. "Garmin is not connected yet" or "The Garmin sign-in expired…" → the token
   is dead. Tell the owner to run the `garmin-mcp-auth` command from README.md
   and paste the new token at `/setup`. Nothing to change in code.
3. "API Error 4xx/5xx", empty data that used to exist, or an error in every
   tool → Garmin probably changed something. Check for a newer
   `garminconnect` release and recent upstream commits, then follow "Pulling
   in upstream changes" above; the fix is usually already upstream.
4. The connector itself fails (Claude can't connect, 500s) → look at the
   Worker's logs in the Cloudflare dashboard (Workers → garmin-mcp → Logs), or
   ask the owner for them, and reproduce with `npm run test:e2e`.
5. After any fix: `npm test && npm run test:e2e`, push to `main`, verify as in
   step 10 above, and tell the owner what broke and what changed.

## Files

- `src/tools.ts`: tool registrations (names, descriptions, arguments)
- `src/curate.ts`: pure ports of upstream's shaping logic, one section per
  Python function
- `src/garmin.ts`: Garmin API client (endpoints, headers, token refresh)
- `src/token-store.ts`: Durable Object holding the Garmin token
- `src/auth.ts`: connector consent page, `/setup`, `/health`
- `parity/`: scenarios and the script that records upstream's output
- `test/`: unit, parity and end-to-end tests
