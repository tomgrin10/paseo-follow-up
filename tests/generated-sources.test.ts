import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

/**
 * scripts/build.mjs copies these sources into the TypeScript modules the plugin ships. A source edited without a
 * rebuild would ship stale code, and a generated file written as one long string conflicts on every pair of PRs that
 * touch its source. Keep this list in step with GENERATED in scripts/build.mjs.
 */
const GENERATED: Array<[source: string, generated: string, name: string]> = [
  ["server/mcp.mjs", "server/mcp-source.ts", "mcpSource"],
  ["server/agent-hook.mjs", "server/hook-source.ts", "hookSource"],
  ["server/overseer-prompt.md", "server/overseer-prompt-source.ts", "overseerPrompt"],
  ["server/wait-runner.sh", "server/wait-runner-source.ts", "runnerSource"],
  ["server/update-watchdog.mjs", "server/update-watchdog-source.ts", "watchdogSource"],
];

test("every server/*-source.ts is a known generated file", async () => {
  const found = (await readdir("server")).filter(f => f.endsWith("-source.ts")).map(f => `server/${f}`).sort();
  assert.deepEqual(found, GENERATED.map(([, generated]) => generated).sort());
});

for (const [source, generated, name] of GENERATED) {
  test(`${generated} equals ${source} (run node scripts/build.mjs)`, async () => {
    const mod = await import(`../${generated}`);
    assert.equal(mod[name], await readFile(source, "utf8"));
  });

  test(`${generated} has one line per source line, so it merges like ${source}`, async () => {
    const sourceLines = (await readFile(source, "utf8")).split("\n").length;
    const generatedLines = (await readFile(generated, "utf8")).split("\n").length;
    assert.ok(generatedLines >= sourceLines, `${generated} has ${generatedLines} lines for ${sourceLines} source lines`);
  });
}
