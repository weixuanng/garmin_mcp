"""Record what the upstream Python tools return for parity/scenarios.json.

Runs the real upstream tools (src/garmin_mcp) on the real garminconnect
library, with only its network call replaced by the scenario payloads, and
writes test/golden.json. test/parity.test.ts then checks that the TypeScript
port returns the same output and calls the same Garmin endpoints.

Run from the repository root after pulling upstream changes:
    uv run python cloudflare/parity/generate_golden.py
"""

import asyncio
import json
import sys
from pathlib import Path
from urllib.parse import urlencode

from garminconnect import Garmin
from mcp.server.fastmcp import FastMCP

from garmin_mcp import health_wellness, training

HERE = Path(__file__).resolve().parent
SCENARIOS = HERE / "scenarios.json"
GOLDEN = HERE.parent / "test" / "golden.json"


def route_key(path, params):
    if not params:
        return path
    return f"{path}?{urlencode(sorted((k, str(v)) for k, v in params.items()))}"


def make_client(routes, payloads, requests):
    garmin = Garmin()
    garmin.display_name = "tester"

    def connectapi(path, **kwargs):
        key = route_key(path, kwargs.get("params"))
        requests.append(key)
        name = routes.get(key)
        # Unrouted endpoints answer like Garmin's 204 No Content, which the
        # library turns into {}.
        return json.loads(json.dumps(payloads[name])) if name else {}

    garmin.connectapi = connectapi
    return garmin


def tool_text(result):
    content = result[0] if isinstance(result, tuple) else result
    return "".join(block.text for block in content if getattr(block, "type", None) == "text")


async def run_case(case, payloads):
    requests = []
    client = make_client(case["routes"], payloads, requests)
    health_wellness.configure(client)
    training.configure(client)
    app = FastMCP("parity")
    health_wellness.register_tools(app)
    training.register_tools(app)
    result = await app.call_tool(case["tool"], case["args"])
    return {
        **case,
        "expected": tool_text(result),
        "requests": sorted(set(requests)),
    }


async def main():
    scenarios = json.loads(SCENARIOS.read_text())
    golden = [await run_case(case, scenarios["payloads"]) for case in scenarios["cases"]]
    GOLDEN.write_text(json.dumps({"payloads": scenarios["payloads"], "cases": golden}, indent=2) + "\n")
    print(f"Wrote {len(golden)} cases to {GOLDEN}", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
