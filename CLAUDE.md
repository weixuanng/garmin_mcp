# CLAUDE.md

This fork adds `cloudflare/`, a Cloudflare Worker that serves the sleep and
recovery tools as a remote MCP server (the "online" Garmin connector). The rest
of the repository is upstream's Python server, unchanged.

For anything about the online server (deploying, pulling in upstream updates,
or "fix" when the Garmin connector stops working), follow
`cloudflare/MAINTAINING.md`.
