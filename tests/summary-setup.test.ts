import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setupEntry, ONBOARDING_STEPS } from "../shared/onboarding";
import { ROLE_INFO } from "../shared/agent-settings";

// Tom (2026-11-10): "What's this about?" read like part of the sentence around it. The feature is called Summary.
const OLD = /what['’]?s this about/i;
const sources = async (dir: string): Promise<string[]> => (await readdir(resolve(dir), { recursive: true }))
  .filter(n => /\.(tsx?|mjs)$/.test(n)).map(n => join(dir, n));

test("no user-facing or agent-facing string still says What's this about", async () => {
  const files = [...await sources("client"), ...await sources("shared"), ...await sources("server"), "index.client.tsx", "index.server.ts", "README.md", "OVERVIEW.md", "DESIGN.md", "PRODUCT.md"];
  const hits: string[] = [];
  for (const f of files) {
    const body = await readFile(resolve(f), "utf8").catch(() => "");
    body.split("\n").forEach((line, i) => { if (OLD.test(line)) hits.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(hits, []);
});

test("the Summary keeps its internal ids: role about, its RPC and tool names", async () => {
  assert.equal(ROLE_INFO.about.title, "Summaries");
  const mcp = await readFile(resolve("server/mcp.mjs"), "utf8");
  assert.match(mcp, /\["workspace_about", "Read a workspace's Summary/);
  const about = await readFile(resolve("client/about.tsx"), "utf8");
  assert.match(about, />Summary<\/Text>/);
});

test("Set up Follow-up again says where setup stands and resumes one in progress", () => {
  assert.deepEqual(setupEntry({ status: "done", step: "helpers" }), { label: "Set up Follow-up again", hint: "Finished. Run it again to recheck GitHub and the helper agents, or to change what Follow-up does on its own.", line: "Finished. Run it again any time", action: "Open setup", resume: false });
  assert.equal(setupEntry({ status: "skipped", step: "intro" }).line, "Skipped. About two minutes");
  assert.equal(setupEntry({ status: "idle", step: "intro" }).resume, false);
  assert.equal(setupEntry(undefined).label, "Set up Follow-up again", "loading still shows the entry");
  const active = setupEntry({ status: "active", step: "defaults" });
  assert.deepEqual([active.label, active.action, active.resume, active.line], ["Continue setup", "Continue", true, `In progress, step 3 of ${ONBOARDING_STEPS.length}`]);
});

test("Set up Follow-up again leads General, the first Settings category and the default; ⌘K too", async () => {
  const { SETTINGS_CATEGORIES, DEFAULT_CATEGORY } = await import("../shared/settings-nav");
  assert.equal(SETTINGS_CATEGORIES[0].id, "general"); assert.equal(DEFAULT_CATEGORY, "general");
  const settings = await readFile(resolve("client/settings.tsx"), "utf8");
  const general = settings.slice(settings.indexOf("function GeneralCategory"), settings.indexOf("function useSummaries"));
  // First thing in General, not inside a fold; then the version and release notes.
  assert.ok(general.indexOf("setup.entry.label") > 0 && general.indexOf("setup.entry.label") < general.indexOf('title="Version"'));
  assert.doesNotMatch(general, /<Disclosure/);
  assert.match(general, /actionLabel="What's new"/); assert.match(general, /label="All release notes"/);
  assert.match(settings, /category === "general" \? <GeneralCategory theme=\{theme\} compact=\{compact\} setup=\{setup\} \/>/);
  const client = await readFile(resolve("index.client.tsx"), "utf8");
  assert.match(client, /id: "follow-through-setup"/);
  assert.match(client, /resume \? Promise\.resolve\(\) : client\.rpc\(setOnboardingRpc, \{ action: "restart" \}\)/);
});

test("General's line in the phone list names the version and where setup stands", async () => {
  const { generalSummary } = await import("../shared/onboarding");
  assert.equal(generalSummary("1.4.0", "done"), "Follow-up 1.4.0 · setup finished");
  assert.equal(generalSummary("1.4.0", "skipped"), "Follow-up 1.4.0 · setup skipped");
  assert.equal(generalSummary(null, "active"), "setup in progress");
  assert.equal(generalSummary(undefined, undefined), null);
});

test("the agent tool for setup names Set up Follow-up again, so agents can do what the button does", async () => {
  const mcp = await readFile(resolve("server/mcp.mjs"), "utf8");
  const line = mcp.split("\n").find(l => l.includes('["set_onboarding"'))!;
  assert.match(line, /Set up Follow-up again/);
  assert.match(line, /finished or skipped/);
});
