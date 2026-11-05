import test from "node:test";
import assert from "node:assert/strict";
import { publishedArtifacts, mergeArtifacts, agentSetSpec, developerSetSpec } from "../server/spec";
import { applyDiscovery } from "../server/discovery";
import { stateSchema } from "../shared/model";
import { specLabel } from "../shared/spec";
import { clock, workspace } from "./fixtures";

const SPEC = "https://claude.ai/code/artifact/0f6c1b52-8d3e-4c55-9a51-2a8f0c7e1d10";
const PAGE = "https://claude.ai/artifact/R3Wb8gP9ptoGoDDqDyAp6a";
// Reads through a function so earlier assertions don't narrow the type.
const workspaceSpec = (w: { spec: unknown }) => w.spec as { url: string | null; source: string } | null;
const call = (input: Record<string, unknown>, output: unknown, patch: Record<string, unknown> = {}, timestamp = "2026-11-04T08:00:00Z") =>
  ({ timestamp, item: { type: "tool_call", name: "Artifact", status: "completed", error: null, callId: "c", detail: { type: "unknown", input, output }, ...patch } });

test("only completed Artifact publishes count; reads, lists, quickstarts, assets and chat links never do", () => {
  const found = publishedArtifacts([
    call({ file_path: "/scratch/invoice-retry-spec.html", icon: "doc" }, `Published /scratch/invoice-retry-spec.html at ${SPEC} (Version 1, version id 1-a).`, {}, "2026-11-04T08:00:00Z"),
    call({ file_path: "/scratch/invoice-retry-spec.html" }, [{ type: "text", text: `Published /scratch/invoice-retry-spec.html at ${SPEC} (Version 2, version id 2-b).` }], {}, "2026-11-04T09:00:00Z"),
    call({ type_url: "https://claude.ai/artifact/TYPE", title: "Rollout deck" }, `Created a new Artifact at ${PAGE} (version 1-c)`, {}, "2026-11-04T10:00:00Z"),
    call({ action: "read", url: PAGE }, `Published something at ${PAGE}`),
    call({ action: "quickstart", intent: "other" }, "Quickstart. Start from https://claude.ai/artifact/GZLZthZ2sQjn7T16skfdeF"),
    call({ url: PAGE, asset: true, file_path: "/scratch/shot.png" }, `Published /scratch/shot.png at ${PAGE}`),
    call({ file_path: "/scratch/x.html" }, `Published /scratch/x.html at ${PAGE}`, { status: "failed", error: "boom" }),
    call({ file_path: "/scratch/x.html" }, "Nothing was published: the source file was missing"),
    call({ file_path: "/scratch/x.html" }, `Published /scratch/x.html at https://evil.example/artifact/1`),
    { timestamp: "2026-11-04T11:00:00Z", item: { type: "assistant_message", text: `Spec: ${SPEC}` } },
    { timestamp: "2026-11-04T11:00:00Z", item: { type: "tool_call", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "echo", output: `Published x at ${SPEC}` } } },
  ], "main-agent");
  assert.deepEqual(found, [
    { url: SPEC, title: "Invoice retry spec", by: "main-agent", firstAt: "2026-11-04T08:00:00Z", lastAt: "2026-11-04T09:00:00Z", publishes: 2 },
    { url: PAGE, title: "Rollout deck", by: "main-agent", firstAt: "2026-11-04T10:00:00Z", lastAt: "2026-11-04T10:00:00Z", publishes: 1 },
  ]);
});

test("detection picks the main agent's most republished artifact and keeps the rest as other artifacts", () => {
  const w = workspace();
  const changed = mergeArtifacts(w, [
    { url: PAGE, title: "Rollout deck", by: "main-agent", firstAt: "2026-11-04T10:00:00Z", lastAt: "2026-11-04T10:00:00Z", publishes: 1 },
    { url: SPEC, title: "Invoice retry spec", by: "main-agent", firstAt: "2026-11-04T08:00:00Z", lastAt: "2026-11-04T09:00:00Z", publishes: 3 },
    { url: "https://claude.ai/artifact/helper", title: "Helper notes", by: "helper", firstAt: null, lastAt: "2026-11-04T12:00:00Z", publishes: 9 },
  ], clock);
  assert.equal(changed, true);
  assert.deepEqual({ url: w.spec?.url, source: w.spec?.source, title: w.spec?.title }, { url: SPEC, source: "detected", title: "Invoice retry spec" });
  assert.deepEqual(w.artifacts.map(a => a.url), ["https://claude.ai/artifact/helper", PAGE, SPEC], "newest first");
  assert.equal(mergeArtifacts(w, [{ url: SPEC, title: "Invoice retry spec", by: "main-agent", firstAt: "2026-11-04T08:00:00Z", lastAt: "2026-11-04T09:00:00Z", publishes: 3 }], clock), false, "a repeated scan changes nothing");
});

test("precedence: the developer's link beats the agent's, which beats detection; reset hands it back", () => {
  const w = workspace({ contributorAgentIds: ["helper"] });
  mergeArtifacts(w, [{ url: PAGE, title: "Rollout deck", by: "main-agent", firstAt: null, lastAt: "2026-11-04T10:00:00Z", publishes: 1 }], clock);
  assert.equal(w.spec?.source, "detected");
  assert.throws(() => agentSetSpec(w, "helper", SPEC, undefined, clock), /main agent/);
  assert.throws(() => agentSetSpec(w, "main-agent", "http://claude.ai/artifact/x", undefined, clock), /https/);
  assert.equal(agentSetSpec(w, "main-agent", SPEC, "Retry spec", clock).applied, true);
  assert.deepEqual({ url: w.spec?.url, source: w.spec?.source, title: w.spec?.title }, { url: SPEC, source: "agent", title: "Retry spec" });
  mergeArtifacts(w, [{ url: PAGE, title: "Rollout deck", by: "main-agent", firstAt: null, lastAt: "2026-11-05T10:00:00Z", publishes: 5 }], clock);
  assert.equal(w.spec?.url, SPEC, "detection never replaces an explicit link");
  developerSetSpec(w, { action: "set", url: "https://www.notion.so/team/Retry-spec-1a2b", title: "" }, clock);
  assert.deepEqual({ url: w.spec?.url, source: w.spec?.source, title: w.spec?.title }, { url: "https://www.notion.so/team/Retry-spec-1a2b", source: "developer", title: null });
  assert.equal(specLabel(w.spec!), "notion.so");
  const kept = agentSetSpec(w, "main-agent", SPEC, undefined, clock);
  assert.equal(kept.applied, false); assert.match(kept.message, /developer chose/); assert.equal(w.spec?.source, "developer");
  developerSetSpec(w, { action: "remove" }, clock);
  assert.deepEqual({ url: w.spec?.url, source: w.spec?.source }, { url: null, source: "developer" });
  mergeArtifacts(w, [{ url: SPEC, title: null, by: "main-agent", firstAt: null, lastAt: "2026-11-06T10:00:00Z", publishes: 7 }], clock);
  assert.equal(w.spec?.url, null, "a removed link stays removed");
  assert.match(agentSetSpec(w, "main-agent", SPEC, undefined, clock).message, /removed/);
  developerSetSpec(w, { action: "reset" }, clock);
  const reset = workspaceSpec(w);
  assert.deepEqual({ url: reset?.url, source: reset?.source }, { url: SPEC, source: "detected" });
  assert.throws(() => developerSetSpec(w, { action: "set", url: "javascript:alert(1)" }, clock), /https/);
  assert.equal(specLabel({ url: SPEC, title: null }), "Claude artifact");
});

test("spec links persist through discovery and older states parse without them", () => {
  const legacy = JSON.parse(JSON.stringify({ version: 1, workspaces: [workspace()] }));
  delete legacy.workspaces[0].spec; delete legacy.workspaces[0].artifacts;
  const state = stateSchema.parse(legacy);
  assert.equal(state.workspaces[0].spec, null); assert.deepEqual(state.workspaces[0].artifacts, []);
  const artifacts = [{ url: SPEC, title: "Invoice retry spec", by: "main-agent", firstAt: null, lastAt: "2026-11-04T09:00:00Z", publishes: 2 }];
  applyDiscovery(state, [{ id: "workspace", title: "Migration rollout", mainAgentId: "main-agent", messageAt: null, artifacts }], clock);
  assert.equal(workspaceSpec(state.workspaces[0])?.url, SPEC);
  const reparsed = stateSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(reparsed.workspaces[0].spec, state.workspaces[0].spec);
  const untracked = stateSchema.parse(legacy); untracked.workspaces[0].enable_tracking = false;
  applyDiscovery(untracked, [{ id: "workspace", title: "Migration rollout", mainAgentId: "main-agent", messageAt: null, artifacts }], clock);
  assert.equal(untracked.workspaces[0].spec, null, "untracked workspaces aren't changed");
});
