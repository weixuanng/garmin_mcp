# Garmin MCP on Cloudflare (sleep and recovery)

A Cloudflare Worker that serves the sleep and recovery tools from this
repository's Python server as a remote MCP server, so Claude can read your
Garmin data from any device without anything running on your computer. It
runs on the free Workers plan and connects to claude.ai as a custom connector.

The tools are ported from the upstream Python code (see `UPSTREAM.json`) and
keep the same names, descriptions and output. A parity test runs the real
upstream Python tools and this port over the same Garmin payloads and checks
they agree.

## Tools

All tools are read-only.

| Tool | What it returns |
| --- | --- |
| `get_sleep_summary` | One night: score, stages, SpO2, overnight HRV, resting HR |
| `get_sleep_summary_range` | The same for each night in a range (up to 14 nights) |
| `get_sleep_data` | One night's full raw sleep payload (~50 KB) |
| `get_hrv_data` | Overnight HRV, weekly average, baseline, status |
| `get_hrv_trend` | Nightly HRV over a range (up to 30 days) |
| `get_body_battery` | Daily charge/drain and events (sleep, naps) |
| `get_body_battery_events` | Raw Body Battery events for a day |
| `get_training_readiness` | Readiness score and contributing factors |
| `get_morning_training_readiness` | The morning readiness snapshot |
| `get_recovery_time_remaining` | Hours of recovery left |
| `get_rhr_day` | Resting heart rate |
| `get_heart_rates_summary` | Daily min/max/resting/average heart rate |
| `get_stress_summary` | Average/max stress and time in each stress band |
| `get_respiration_summary` | Waking and sleeping breathing rate |
| `get_respiration_trend` | Overnight breathing rate over a range (up to 30 days) |
| `get_spo2_data` | Blood oxygen averages and hourly values |

Dates are `YYYY-MM-DD` in the time zone set by `TIMEZONE` in `wrangler.jsonc`
(Asia/Singapore). Garmin files each night under the date you woke up.

## One-time setup

### 1. Deploy with Cloudflare's GitHub integration

1. In the Cloudflare dashboard open **Workers & Pages** → **Create application**
   → **Import a repository**, connect GitHub and pick this repository.
2. Configure the project:
   - **Project name:** `garmin-mcp` (must match `name` in `wrangler.jsonc`)
   - **Production branch:** `main`
   - **Root directory:** `cloudflare`
   - **Build command:** `npm test`
   - **Deploy command:** `npx wrangler deploy`
   - Optional, under **Build watch paths**: include `cloudflare/*`, so syncing
     unrelated upstream changes doesn't trigger a build.
3. **Save and Deploy.** Every later push to `main` that touches `cloudflare/`
   runs the tests and deploys only if they pass.

### 2. Set a passcode

In the Worker's **Settings → Variables and Secrets**, add a **Secret** named
`SETUP_PASSCODE` (at least 8 characters; a long random one is best). Only
someone with this passcode can connect Claude or change the Garmin token. Ten
wrong tries lock the form for 15 minutes.

### 3. Create a Garmin token on your computer

Garmin has no "Sign in with Garmin" for apps like this, so you sign in once on
your own computer and paste the resulting token into the Worker. Your password
never leaves your machine. The login helper runs through
[uv](https://docs.astral.sh/uv/), which downloads the developer's code for you.

**Windows (PowerShell)**

```powershell
# 1. Install uv and Git, then close and reopen PowerShell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
winget install --id Git.Git -e --source winget

# 2. Sign in (asks for email, password and the MFA code); wait for SUCCESS
uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth --token-path $HOME\.garmin_cloud

# 3. Copy the token to the clipboard
Get-Content $HOME\.garmin_cloud\garmin_tokens.json | Set-Clipboard
```

**Mac (Terminal)**

```bash
# 1. Install uv, then quit and reopen Terminal
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Sign in (asks for email, password and the MFA code); wait for SUCCESS
uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth --token-path ~/.garmin_cloud

# 3. Copy the token to the clipboard
cat ~/.garmin_cloud/garmin_tokens.json | pbcopy
```

If every login method reports `429`, Garmin is rate-limiting your internet
connection. Don't retry right away; run step 2 once from a phone hotspot, or
try again a few hours later.

Keep this token separate from the one a local Garmin MCP server uses
(`~/.garminconnect`), because two servers refreshing the same token can sign
each other out.

### 4. Connect Claude

In Claude, open **Settings → Connectors → Add custom connector** and enter
`https://garmin-mcp.<your-subdomain>.workers.dev/mcp`. When you click Connect,
the Worker's page asks for your passcode and the contents of
`garmin_tokens.json`. After that the connector works in every Claude app
signed in to your account.

## When Garmin's sign-in expires

The Worker refreshes Garmin's token when it is due and checks it once a day.
If Garmin revokes it (for example after a password change), tools answer with
"The Garmin sign-in expired…". Run step 3 again, then open
`https://garmin-mcp.<your-subdomain>.workers.dev/setup`, enter the passcode and
paste the new token. Claude stays connected.

`/health` reports whether a token is stored and whether the last daily check
reached Garmin (no personal data).

## Limits on the free plan

- A Worker call gets 10 ms of CPU and 50 outbound requests. Each night of sleep
  data is a large payload, so `get_sleep_summary_range` takes up to 14 nights
  per call (`MAX_SLEEP_NIGHTS`); the HRV and respiration trends keep upstream's
  30 days. Claude splits longer periods into several calls on its own.
- If Cloudflare's logs show "exceeded CPU" for sleep ranges, lower
  `MAX_SLEEP_NIGHTS` in `wrangler.jsonc`.

## Development

```bash
npm ci
npm test            # unit tests + parity with the upstream Python tools
npm run test:e2e    # full connector flow in wrangler dev against a fake Garmin
npm run typecheck
```

`MAINTAINING.md` covers bringing in upstream changes and fixing breakage.
