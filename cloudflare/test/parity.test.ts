// Checks the TypeScript tools against the upstream Python tools, using the
// outputs recorded by parity/generate_golden.py (see that file).
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_NAMES } from "../src/tools";
import { callTool } from "./helpers";
import goldenJson from "./golden.json";

interface Case {
  tool: string;
  args: Record<string, unknown>;
  routes: Record<string, string>;
  expected: string;
  requests: string[];
}

const golden = goldenJson as unknown as { payloads: Record<string, unknown>; cases: Case[] };

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("parity with upstream Python tools", () => {
  it("covers every ported tool", () => {
    expect(new Set(golden.cases.map((c) => c.tool))).toEqual(new Set(TOOL_NAMES));
  });

  for (const testCase of golden.cases) {
    it(`${testCase.tool}(${JSON.stringify(testCase.args)})`, async () => {
      const routes = Object.fromEntries(
        Object.entries(testCase.routes).map(([key, name]) => [key, golden.payloads[name]]),
      );
      const { text, requests } = await callTool(routes, testCase.tool, testCase.args);
      // Compare parsed JSON: Python prints 13.0 where JavaScript prints 13.
      expect(parsed(text)).toEqual(parsed(testCase.expected));
      expect(requests).toEqual(testCase.requests);
    });
  }
});
